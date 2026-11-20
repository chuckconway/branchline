import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { Action, Blame, Commit, CommitDetail, DiffSpec, FileChange, FileHistoryEntry, Operation, Snapshot } from '../../shared/types'
import {
  FILE_LOG_FORMAT,
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  applyNumstat,
  foldStashes,
  parseBlame,
  parseFileLog,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseWorktrees
} from '../../shared/parse'
import { GitError, git } from './exec'

export interface RepoInfo {
  /** Root of the working tree. */
  path: string
  /** This worktree's git directory. */
  gitDir: string
  /** The shared git directory (same as gitDir unless this is a linked worktree). */
  commonDir: string
}

const SHA_RE = /^[0-9a-f]{7,64}$/
const NETWORK_TIMEOUT = 120_000

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new GitError(`Not a commit id: ${sha}`, null, '')
}

function hash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex')
}

export async function resolveRepo(dir: string): Promise<RepoInfo> {
  let out: string
  try {
    out = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  } catch (e) {
    const msg = e instanceof GitError ? e.stderr : String(e)
    if (/not a git repository/i.test(msg)) throw new GitError(`${dir} is not inside a git repository.`, null, msg)
    if (/must be run in a work tree/i.test(msg)) throw new GitError(`${dir} is a bare repository, which has nothing to browse.`, null, msg)
    throw e
  }
  const [path, gitDir, commonDir] = out.trim().split('\n')
  return { path, gitDir, commonDir }
}

const emptyTrees = new Map<string, string>()

async function emptyTree(repo: RepoInfo): Promise<string> {
  let sha = emptyTrees.get(repo.commonDir)
  if (!sha) {
    sha = (await git(repo.path, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    emptyTrees.set(repo.commonDir, sha)
  }
  return sha
}

function detectOperation(gitDir: string): Operation | undefined {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect'
  return undefined
}

interface LogCache {
  key: string
  commits: Commit[]
  hasMore: boolean
}
const logCache = new Map<string, LogCache>()

/** Worktree folders last seen for each open repository. */
const worktreePaths = new Map<string, string[]>()

export function isKnownWorktree(path: string): boolean {
  for (const paths of worktreePaths.values()) if (paths.includes(path)) return true
  return false
}

export function forgetRepo(repoPath: string): void {
  logCache.delete(repoPath)
  worktreePaths.delete(repoPath)
}

export async function loadSnapshot(repo: RepoInfo, limit: number, knownCommitsKey: string | null): Promise<Snapshot> {
  const cwd = repo.path
  const [statusOut, refsOut, stashOut, worktreeOut, remotesOut, unstagedNum, stagedNum] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(cwd, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    git(cwd, ['stash', 'list', `--format=${STASH_FORMAT}`]),
    git(cwd, ['worktree', 'list', '--porcelain']),
    git(cwd, ['remote', '-v']),
    git(cwd, ['diff', '--numstat', '-z']),
    git(cwd, ['diff', '--cached', '--numstat', '-z'])
  ])

  const status = parseStatus(statusOut)
  applyNumstat(status.unstaged, parseNumstat(unstagedNum))
  applyNumstat(status.staged, parseNumstat(stagedNum))
  status.operation = detectOperation(repo.gitDir)

  const refs = parseRefs(refsOut)
  const stashes = parseStashes(stashOut)
  const worktrees = parseWorktrees(worktreeOut, repo.path)
  worktreePaths.set(
    repo.path,
    worktrees.map((t) => t.path)
  )
  // Link to wherever the current branch is pushed, falling back to origin.
  const upstreamRemote = status.upstream?.slice(0, status.upstream.indexOf('/'))
  const { names: remotes, web: remoteWeb } = parseRemotes(remotesOut, upstreamRemote)

  // Everything the log is walked from. If none of it moved, the commit list did not change.
  const tips = new Set<string>()
  if (status.headSha) tips.add(status.headSha)
  for (const s of stashes) tips.add(s.sha)
  for (const w of worktrees) if (w.sha && !/^0+$/.test(w.sha)) tips.add(w.sha)
  const commitsKey = hash([limit, [...tips].sort(), refs.map((r) => `${r.name} ${r.sha}`)])

  let cached = logCache.get(repo.path)
  if (!cached || cached.key !== commitsKey) {
    const hasAnything = tips.size > 0 || refs.length > 0
    let raw: Commit[] = []
    if (hasAnything) {
      const out = await git(cwd, [
        'log',
        '--date-order',
        `-n${limit + 1}`,
        `--format=${LOG_FORMAT}`,
        '--branches',
        '--tags',
        '--remotes',
        ...tips,
        '--'
      ])
      raw = parseLog(out)
    }
    const hasMore = raw.length > limit
    const commits = foldStashes(raw.slice(0, limit), new Set(stashes.map((s) => s.sha)))
    cached = { key: commitsKey, commits, hasMore }
    logCache.set(repo.path, cached)
  }

  return {
    repoPath: repo.path,
    name: basename(repo.path),
    commits: knownCommitsKey === commitsKey ? null : cached.commits,
    commitsKey,
    stateKey: hash([refs, stashes, worktrees, remotes, remoteWeb, status]),
    hasMore: cached.hasMore,
    refs,
    stashes,
    worktrees,
    remotes,
    remoteWeb,
    status
  }
}

const DETAIL_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B'

async function changedFiles(repo: RepoInfo, from: string, to: string): Promise<FileChange[]> {
  const [names, nums] = await Promise.all([
    git(repo.path, ['diff', '-M', '--name-status', '-z', from, to, '--']),
    git(repo.path, ['diff', '-M', '--numstat', '-z', from, to, '--'])
  ])
  const files = applyNumstat(parseNameStatus(names), parseNumstat(nums))
  for (const f of files) f.range = [from, to]
  return files
}

export async function commitDetail(repo: RepoInfo, sha: string, isStash: boolean): Promise<CommitDetail> {
  assertSha(sha)
  const out = await git(repo.path, ['show', '-s', `--format=${DETAIL_FORMAT}`, sha, '--'])
  const f = out.split('\0')
  const parents = f[1] ? f[1].split(' ') : []
  const empty = await emptyTree(repo)

  // Merges are shown against their first parent: "what did merging bring into this branch".
  const files = await changedFiles(repo, parents[0] ?? empty, sha)
  if (isStash && parents[2]) {
    // The third parent of a stash holds the untracked files it swept up.
    const untracked = await changedFiles(repo, empty, parents[2])
    for (const u of untracked) u.status = '?'
    files.push(...untracked)
  }

  return {
    sha: f[0],
    parents: isStash ? parents.slice(0, 1) : parents,
    author: f[2],
    email: f[3],
    authorDate: f[4],
    committer: f[5],
    committerEmail: f[6],
    commitDate: f[7],
    message: (f[8] ?? '').trimEnd(),
    files
  }
}

export async function diff(repo: RepoInfo, spec: DiffSpec): Promise<string> {
  const base = ['diff', '--no-ext-diff', '-M']
  const paths = spec.oldPath ? [spec.oldPath, spec.path] : [spec.path]
  switch (spec.kind) {
    case 'range':
      assertSha(spec.from)
      assertSha(spec.to)
      return git(repo.path, [...base, spec.from, spec.to, '--', ...paths])
    case 'staged':
      return git(repo.path, [...base, '--cached', '--', ...paths])
    case 'unstaged':
      if (spec.untracked) {
        return git(repo.path, [...base, '--no-index', '--', '/dev/null', spec.path], { okCodes: [0, 1] })
      }
      return git(repo.path, [...base, '--', ...paths])
  }
}

async function refExists(repo: RepoInfo, fullName: string): Promise<boolean> {
  try {
    await git(repo.path, ['show-ref', '--verify', '--quiet', fullName])
    return true
  } catch {
    return false
  }
}

async function assertBranchName(repo: RepoInfo, name: string): Promise<void> {
  try {
    await git(repo.path, ['check-ref-format', '--branch', name])
  } catch {
    throw new GitError(`"${name}" is not a valid branch name.`, null, '')
  }
}

async function pushTarget(repo: RepoInfo, branch: string): Promise<string> {
  const remotes = (await git(repo.path, ['remote'])).split('\n').filter(Boolean)
  if (remotes.length === 0) throw new GitError('This repository has no remote to push to.', null, '')
  for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`]) {
    const value = (await git(repo.path, ['config', '--get', key], { okCodes: [0, 1] })).trim()
    if (value && remotes.includes(value)) return value
  }
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The lines of git's output that say why something did not apply. */
function failureDetail(e: unknown): string {
  if (!(e instanceof GitError)) return String(e)
  const lines = `${e.stdout}\n${e.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(CONFLICT|error:|fatal:)/.test(l))
  return lines.length ? [...new Set(lines)].join('\n') : e.message
}

/**
 * There is no conflict-resolution UI, so an operation that stops halfway is rolled back:
 * it either applies cleanly or leaves the repository exactly as it was.
 */
async function allOrNothing(repo: RepoInfo, what: string, abort: string[], run: () => Promise<unknown>): Promise<void> {
  const already = detectOperation(repo.gitDir)
  if (already) throw new GitError(`A ${already} is already in progress in this repository. Finish or abort it first.`, null, '')
  try {
    await run()
  } catch (e) {
    if (!detectOperation(repo.gitDir)) throw e
    await git(repo.path, abort, { write: true }).catch(() => undefined)
    throw new GitError(`${what} could not be applied cleanly, so it was undone. Nothing changed.\n\n${failureDetail(e)}`, null, '')
  }
}

async function parentsOf(repo: RepoInfo, sha: string): Promise<string[]> {
  const out = await git(repo.path, ['rev-list', '--parents', '-n1', sha, '--'])
  return out.trim().split(' ').slice(1)
}

/**
 * The commits after `base` up to HEAD, oldest first, provided `sha` is among them and the
 * stretch has no merges. Editing history in place only makes sense on a straight line.
 */
async function linearRange(repo: RepoInfo, sha: string, base: string | null): Promise<string[]> {
  const cwd = repo.path
  try {
    await git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD'])
  } catch {
    throw new GitError('That commit is not part of the branch that is checked out.', null, '')
  }
  const range = base ? `${base}..HEAD` : 'HEAD'
  const merges = Number((await git(cwd, ['rev-list', '--merges', '--count', range, '--'])).trim())
  if (merges > 0) {
    throw new GitError('There is a merge between that commit and the tip of the branch, so it cannot be edited in place.', null, '')
  }
  return (await git(cwd, ['rev-list', '--reverse', range, '--'])).split('\n').filter(Boolean)
}

/**
 * Replay the commits after `base` according to a prepared rebase to-do list. Git asks an
 * "editor" to edit its own list; ours just copies the prepared one over it.
 */
async function rewrite(repo: RepoInfo, what: string, base: string | null, todo: string[], message?: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-'))
  try {
    const todoFile = join(dir, 'todo')
    await writeFile(todoFile, todo.join('\n') + '\n')
    const env: Record<string, string> = { GIT_SEQUENCE_EDITOR: `cp ${shq(todoFile)}` }
    if (message !== undefined) {
      const messageFile = join(dir, 'message')
      await writeFile(messageFile, message + '\n')
      env.GIT_EDITOR = `cp ${shq(messageFile)}`
    }
    await allOrNothing(repo, what, ['rebase', '--abort'], () =>
      git(repo.path, ['rebase', '-i', '--autostash', '--no-autosquash', ...(base ? [base] : ['--root'])], { write: true, env, timeoutMs: NETWORK_TIMEOUT })
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function listWorktrees(repo: RepoInfo): Promise<ReturnType<typeof parseWorktrees>> {
  return parseWorktrees(await git(repo.path, ['worktree', 'list', '--porcelain']), repo.path)
}

/** Entries in `git status`: modified, staged and untracked, an untracked folder counting once. */
async function changeCount(dir: string): Promise<number> {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  let count = 0
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    count++
    if (parts[i][0] === 'R' || parts[i][0] === 'C') i++ // the original path follows as its own field
  }
  return count
}

/**
 * Uncommitted changes in every other worktree of this repository. Each costs a `git status`,
 * so this is kept out of the snapshot and asked for separately, less often.
 */
export async function worktreeChanges(repo: RepoInfo): Promise<Record<string, number>> {
  const trees = (await listWorktrees(repo)).filter((w) => !w.isCurrent && !w.bare && !w.prunable)
  const counts = await Promise.all(trees.map((w) => changeCount(w.path).catch(() => -1)))
  const out: Record<string, number> = {}
  trees.forEach((w, i) => {
    if (counts[i] >= 0) out[w.path] = counts[i]
  })
  return out
}

/**
 * How many commits are reachable from the given refs and from nothing else: not another
 * branch, remote branch or tag, and not HEAD. Deleting those refs orphans exactly these.
 */
export async function uniqueCommits(repo: RepoInfo, refNames: string[]): Promise<number> {
  const doomed = new Set(refNames)
  for (const name of doomed) {
    if (!/^refs\/(heads|remotes)\/.+/.test(name)) throw new GitError(`Not a branch: ${name}`, null, '')
  }
  const all = await git(repo.path, ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'])
  const others: string[] = []
  const present: string[] = []
  for (const line of all.split('\n')) {
    const [name, symref] = line.split('\0')
    if (!name || symref) continue
    if (doomed.has(name)) present.push(name)
    else others.push(name)
  }
  if (present.length === 0) return 0
  const head = (await git(repo.path, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] })).trim()
  const out = await git(repo.path, ['rev-list', '--count', ...present, '--not', ...others, ...(head ? [head] : []), '--'])
  return Number(out.trim())
}

/** Split "origin/feature/x" into its remote and branch, using the remotes that exist. */
async function splitRemoteBranch(repo: RepoInfo, remoteBranch: string): Promise<{ remote: string; branch: string }> {
  const remotes = (await git(repo.path, ['remote'])).split('\n').filter(Boolean)
  // Longest first, so a remote named "a/b" wins over one named "a".
  const remote = remotes.sort((a, b) => b.length - a.length).find((r) => remoteBranch.startsWith(r + '/'))
  if (!remote) throw new GitError(`${remoteBranch} does not belong to a known remote.`, null, '')
  return { remote, branch: remoteBranch.slice(remote.length + 1) }
}

async function deleteOnRemote(repo: RepoInfo, remoteBranch: string): Promise<string> {
  if (!(await refExists(repo, `refs/remotes/${remoteBranch}`))) {
    throw new GitError(`No remote branch named ${remoteBranch}.`, null, '')
  }
  const { remote, branch } = await splitRemoteBranch(repo, remoteBranch)
  const head = await git(repo.path, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { okCodes: [0, 1] })
  if (head.trim() === `refs/remotes/${remoteBranch}`) {
    throw new GitError(`${remoteBranch} is the default branch of ${remote} and cannot be deleted from here.`, null, '')
  }
  try {
    await git(repo.path, ['push', remote, '--delete', `refs/heads/${branch}`], { write: true, timeoutMs: NETWORK_TIMEOUT })
    return `Deleted ${branch} from ${remote}`
  } catch (e) {
    // Someone already deleted it there; all that is left is our stale record of it.
    if (e instanceof GitError && /remote ref does not exist/i.test(`${e.stderr}${e.stdout}`)) {
      await git(repo.path, ['update-ref', '-d', `refs/remotes/${remoteBranch}`], { write: true })
      return `${branch} was already gone from ${remote}; removed the stale reference`
    }
    throw e
  }
}

/** Is this commit already on the current branch's upstream? */
export async function isPublished(repo: RepoInfo, sha: string): Promise<boolean> {
  assertSha(sha)
  try {
    await git(repo.path, ['merge-base', '--is-ancestor', sha, '@{upstream}'])
    return true
  } catch {
    return false // not an ancestor, or no upstream at all
  }
}

export async function blame(repo: RepoInfo, rev: string | null, path: string): Promise<Blame> {
  if (rev) assertSha(rev)
  return parseBlame(await git(repo.path, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', path]))
}

const HISTORY_LIMIT = 1000

/** Commits that changed a file, newest first, following it across renames. */
export async function fileHistory(repo: RepoInfo, rev: string | null, path: string): Promise<FileHistoryEntry[]> {
  if (rev) assertSha(rev)
  const out = await git(repo.path, [
    'log',
    '--follow',
    '-M',
    '--name-status',
    '-z',
    `--format=${FILE_LOG_FORMAT}`,
    `-n${HISTORY_LIMIT}`,
    ...(rev ? [rev] : []),
    '--',
    path
  ])
  const empty = await emptyTree(repo)
  return parseFileLog(out, path).map((e) => ({
    commit: e.commit,
    change: { path: e.path, oldPath: e.oldPath, status: e.status, range: [e.commit.parents[0] ?? empty, e.commit.sha] }
  }))
}

/** The commit as an email-style patch that `git am` can apply. */
export async function formatPatch(repo: RepoInfo, sha: string): Promise<string> {
  assertSha(sha)
  return git(repo.path, ['format-patch', '-1', '--stdout', sha, '--'])
}

/** Run a user-initiated action. Returns a one-line description of what happened. */
export async function runAction(repo: RepoInfo, action: Action): Promise<string> {
  const cwd = repo.path
  const w = { write: true }
  const net = { write: true, timeoutMs: NETWORK_TIMEOUT }

  switch (action.type) {
    case 'fetch':
      await git(cwd, ['fetch', '--all', '--prune'], net)
      return 'Fetched all remotes'

    case 'pull':
      await git(cwd, ['pull', '--ff-only'], net)
      return 'Pulled (fast-forward)'

    case 'push': {
      const status = parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']))
      if (!status.branch) throw new GitError('HEAD is detached; check out a branch before pushing.', null, '')
      if (status.upstream) {
        await git(cwd, ['push'], net)
        return `Pushed ${status.branch} to ${status.upstream}`
      }
      const remote = await pushTarget(repo, status.branch)
      await git(cwd, ['push', '--set-upstream', remote, status.branch], net)
      return `Published ${status.branch} to ${remote}`
    }

    case 'checkout':
      if (!(await refExists(repo, `refs/heads/${action.branch}`))) {
        throw new GitError(`No local branch named ${action.branch}.`, null, '')
      }
      await git(cwd, ['checkout', action.branch, '--'], w)
      return `Checked out ${action.branch}`

    case 'checkoutRemote': {
      if (!(await refExists(repo, `refs/remotes/${action.remoteBranch}`))) {
        throw new GitError(`No remote branch named ${action.remoteBranch}.`, null, '')
      }
      const local = action.remoteBranch.slice(action.remoteBranch.indexOf('/') + 1)
      if (await refExists(repo, `refs/heads/${local}`)) {
        await git(cwd, ['checkout', local, '--'], w)
        return `Checked out ${local}`
      }
      await git(cwd, ['checkout', '--track', action.remoteBranch, '--'], w)
      return `Checked out ${local}, tracking ${action.remoteBranch}`
    }

    case 'checkoutDetached':
      assertSha(action.sha)
      await git(cwd, ['checkout', '--detach', action.sha, '--'], w)
      return `Checked out ${action.sha.slice(0, 7)} (detached)`

    case 'createBranch': {
      const name = action.name.trim()
      await assertBranchName(repo, name)
      if (action.at) assertSha(action.at)
      const at = action.at ? [action.at] : []
      if (action.checkout) await git(cwd, ['checkout', '-b', name, ...at, '--'], w)
      else await git(cwd, ['branch', name, ...at, '--'], w)
      return `Created branch ${name}`
    }

    case 'stash': {
      const msg = action.message?.trim()
      await git(cwd, ['stash', 'push', '--include-untracked', ...(msg ? ['-m', msg] : [])], w)
      return 'Stashed changes'
    }

    case 'stashPop':
      if (!Number.isInteger(action.index) || action.index < 0) throw new GitError('Bad stash index.', null, '')
      await git(cwd, ['stash', 'pop', `stash@{${action.index}}`], w)
      return 'Popped stash'

    case 'stage':
      if (action.paths.length) await git(cwd, ['add', '-A', '--', ...action.paths], w)
      return ''

    case 'stageAll':
      await git(cwd, ['add', '-A'], w)
      return ''

    case 'unstage':
    case 'unstageAll': {
      const paths = action.type === 'unstage' ? action.paths : ['.']
      if (!paths.length) return ''
      const hasHead = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] })
      // Before the first commit there is no HEAD to restore the index from.
      if (hasHead.trim()) await git(cwd, ['restore', '--staged', '--', ...paths], w)
      else await git(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths], w)
      return ''
    }

    case 'commit': {
      const message = action.message.trim()
      if (!message) throw new GitError('A commit needs a message.', null, '')
      await git(cwd, ['commit', '-F', '-'], { write: true, input: message, timeoutMs: NETWORK_TIMEOUT })
      return 'Committed'
    }

    case 'cherryPick': {
      assertSha(action.sha)
      const mainline = (await parentsOf(repo, action.sha)).length > 1 ? ['-m', '1'] : []
      await allOrNothing(repo, 'The cherry-pick', ['cherry-pick', '--abort'], () => git(cwd, ['cherry-pick', ...mainline, action.sha], w))
      return `Cherry-picked ${action.sha.slice(0, 7)}`
    }

    case 'revert': {
      assertSha(action.sha)
      const mainline = (await parentsOf(repo, action.sha)).length > 1 ? ['-m', '1'] : []
      await allOrNothing(repo, 'The revert', ['revert', '--abort'], () => git(cwd, ['revert', '--no-edit', ...mainline, action.sha], w))
      return `Reverted ${action.sha.slice(0, 7)}`
    }

    case 'rebaseOnto':
      assertSha(action.sha)
      await allOrNothing(repo, 'The rebase', ['rebase', '--abort'], () => git(cwd, ['rebase', '--autostash', action.sha], w))
      return `Rebased onto ${action.sha.slice(0, 7)}`

    case 'reset':
      assertSha(action.sha)
      if (!['soft', 'mixed', 'hard'].includes(action.mode)) throw new GitError('Unknown reset mode.', null, '')
      await git(cwd, ['reset', `--${action.mode}`, action.sha, '--'], w)
      return `Reset to ${action.sha.slice(0, 7)} (${action.mode})`

    case 'reword': {
      assertSha(action.sha)
      const message = action.message.trim()
      if (!message) throw new GitError('A commit needs a message.', null, '')
      const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
      if (action.sha === head) {
        const busy = detectOperation(repo.gitDir)
        if (busy) throw new GitError(`A ${busy} is already in progress in this repository. Finish or abort it first.`, null, '')
        // --only keeps anything already staged out of the amended commit.
        await git(cwd, ['commit', '--amend', '--only', '-F', '-'], { write: true, input: message, timeoutMs: NETWORK_TIMEOUT })
      } else {
        const base = (await parentsOf(repo, action.sha))[0] ?? null
        const range = await linearRange(repo, action.sha, base)
        const todo = range.map((sha) => `${sha === action.sha ? 'reword' : 'pick'} ${sha}`)
        await rewrite(repo, 'The edit', base, todo, message)
      }
      return 'Commit message updated'
    }

    case 'drop': {
      assertSha(action.sha)
      const base = (await parentsOf(repo, action.sha))[0]
      if (!base) throw new GitError('The first commit of a repository cannot be dropped.', null, '')
      const range = await linearRange(repo, action.sha, base)
      await rewrite(repo, 'Dropping the commit', base, range.map((sha) => `${sha === action.sha ? 'drop' : 'pick'} ${sha}`))
      return `Dropped ${action.sha.slice(0, 7)}`
    }

    case 'move': {
      assertSha(action.sha)
      // "Up" is toward the tip: trade places with the child. "Down" trades with the parent.
      let older = action.sha
      if (action.direction === 'down') {
        const parent = (await parentsOf(repo, action.sha))[0]
        if (!parent) throw new GitError('That is already the first commit.', null, '')
        older = parent
      }
      const base = (await parentsOf(repo, older))[0] ?? null
      const range = await linearRange(repo, action.sha, base)
      const i = range.indexOf(older)
      if (i === -1 || i + 1 >= range.length) throw new GitError('That is already the newest commit on the branch.', null, '')
      ;[range[i], range[i + 1]] = [range[i + 1], range[i]]
      await rewrite(repo, 'Moving the commit', base, range.map((sha) => `pick ${sha}`))
      return `Moved ${action.sha.slice(0, 7)} ${action.direction}`
    }

    case 'deleteBranch': {
      const full = `refs/heads/${action.branch}`
      if (!(await refExists(repo, full))) throw new GitError(`No local branch named ${action.branch}.`, null, '')
      const info = (await git(cwd, ['for-each-ref', '--format=%(HEAD)%00%(worktreepath)', full])).trim().split('\0')
      if (info[0] === '*') throw new GitError(`${action.branch} is checked out. Check out another branch first.`, null, '')
      if (info[1]) throw new GitError(`${action.branch} is checked out in ${info[1]}.`, null, '')
      const notes: string[] = []
      if (action.remoteBranch) {
        // Only ever the same-named branch. A branch's upstream is often something shared
        // (origin/dev), and that must never be what "delete the remote copy" means.
        if (!action.remoteBranch.endsWith(`/${action.branch}`)) {
          throw new GitError(`${action.remoteBranch} is not the remote copy of ${action.branch}.`, null, '')
        }
        // Remote first: if the network fails, nothing has been deleted yet.
        notes.push(await deleteOnRemote(repo, action.remoteBranch))
      }
      // The dialog has already said what is unique to this branch, so do not let git's own
      // narrower "not fully merged" check block the delete.
      await git(cwd, ['branch', '-D', action.branch, '--'], w)
      return [`Deleted branch ${action.branch}`, ...notes].join('. ')
    }

    case 'deleteRemoteBranch':
      return deleteOnRemote(repo, action.remoteBranch)

    case 'createTag': {
      assertSha(action.sha)
      const name = action.name.trim()
      try {
        if (name.startsWith('-')) throw new Error('leading dash')
        await git(cwd, ['check-ref-format', `refs/tags/${name}`])
      } catch {
        throw new GitError(`"${name}" is not a valid tag name.`, null, '')
      }
      if (await refExists(repo, `refs/tags/${name}`)) throw new GitError(`A tag named ${name} already exists.`, null, '')
      const message = action.message?.trim()
      if (message) await git(cwd, ['tag', '-a', name, '-F', '-', action.sha], { write: true, input: message })
      else await git(cwd, ['tag', name, action.sha], w)
      if (!action.push) return `Created tag ${name}`
      const status = parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']))
      const remote = await pushTarget(repo, status.branch ?? '')
      await git(cwd, ['push', remote, `refs/tags/${name}`], net)
      return `Created tag ${name} and pushed it to ${remote}`
    }

    case 'removeWorktree': {
      const tree = (await listWorktrees(repo)).find((t) => t.path === action.path)
      if (!tree) throw new GitError(`${action.path} is not a worktree of this repository.`, null, '')
      const name = basename(tree.path)
      if (tree.isMain) throw new GitError('The main working tree cannot be removed.', null, '')
      if (tree.isCurrent) throw new GitError('This is the worktree you are looking at. Remove it from another one.', null, '')
      if (tree.locked) throw new GitError(`${name} is locked. Unlock it with git worktree unlock first.`, null, '')
      if (tree.prunable) throw new GitError(`The folder for ${name} is already gone. Prune missing worktrees instead.`, null, '')
      // Never forced: a worktree with work in it is left for its owner to deal with.
      const changes = await changeCount(tree.path)
      if (changes > 0) {
        throw new GitError(`${name} has ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}. Commit, stash or discard them first.`, null, '')
      }
      await git(cwd, ['worktree', 'remove', tree.path], w)
      if (action.deleteBranch && tree.branch && (await refExists(repo, `refs/heads/${tree.branch}`))) {
        await git(cwd, ['branch', '-D', tree.branch, '--'], w)
        return `Removed worktree ${name} and branch ${tree.branch}`
      }
      return `Removed worktree ${name}`
    }

    case 'pruneWorktrees': {
      const missing = (await listWorktrees(repo)).filter((t) => t.prunable).length
      await git(cwd, ['worktree', 'prune'], w)
      const left = (await listWorktrees(repo)).filter((t) => t.prunable).length
      const pruned = missing - left
      return pruned === 0 ? 'No missing worktrees to prune' : `Pruned ${pruned} missing ${pruned === 1 ? 'worktree' : 'worktrees'}`
    }

    case 'createWorktree': {
      assertSha(action.sha)
      if (!isAbsolute(action.path)) throw new GitError('Choose a full path for the new worktree folder.', null, '')
      const branch = action.branch?.trim()
      if (branch) await assertBranchName(repo, branch)
      await git(cwd, ['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), action.path, action.sha], w)
      return `Created worktree at ${action.path}`
    }
  }
}
