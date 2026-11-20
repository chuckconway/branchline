import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commitDetail, diff, loadSnapshot, resolveRepo, runAction, type RepoInfo } from '../src/main/git/repo'
import { parseDiff, toSplitRows } from '../src/shared/diff'
import { layoutGraph } from '../src/shared/graph'
import type { Commit, Snapshot } from '../src/shared/types'
import { buildFixture } from './fixture'
import { assertContinuous } from './helpers'

let root: string
let repo: RepoInfo
let worktreePath: string

const snap = (known: string | null = null): Promise<Snapshot> => loadSnapshot(repo, 1000, known)
const bySubject = (commits: Commit[], subject: string): Commit => {
  const c = commits.find((x) => x.subject === subject)
  if (!c) throw new Error(`no commit "${subject}"`)
  return c
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'branchline-')))
  const built = buildFixture(root)
  worktreePath = built.worktree
  repo = await resolveRepo(built.repo)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('resolveRepo', () => {
  it('finds the top level from a subdirectory', async () => {
    const info = await resolveRepo(join(repo.path, 'src'))
    expect(info.path).toBe(repo.path)
    expect(info.gitDir).toBe(join(repo.path, '.git'))
  })

  it('points a linked worktree at the shared git directory', async () => {
    const info = await resolveRepo(worktreePath)
    expect(info.path).toBe(worktreePath)
    expect(info.commonDir).toBe(join(repo.path, '.git'))
    expect(info.gitDir).not.toBe(info.commonDir)
  })

  it('rejects a directory that is not a repository', async () => {
    await expect(resolveRepo(tmpdir())).rejects.toThrow(/not inside a git repository/)
  })
})

describe('loadSnapshot', () => {
  it('reads branches, remotes and tags', async () => {
    const s = await snap()
    const names = (kind: string): string[] => s.refs.filter((r) => r.kind === kind).map((r) => r.short).sort()
    expect(names('head')).toEqual(['agent/task-1', 'feature/login', 'feature/search', 'main'])
    expect(names('remote')).toEqual(['origin/feature/login', 'origin/main'])
    expect(names('tag')).toEqual(['rc', 'v1.0'])
    expect(s.remotes).toEqual(['origin'])
  })

  it('reports HEAD, upstream and ahead/behind', async () => {
    const s = await snap()
    const main = s.refs.find((r) => r.short === 'main')!
    expect(main).toMatchObject({ isHead: true, upstream: 'origin/main', ahead: 1 })
    expect(main.behind).toBeUndefined()
    expect(s.status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0 })
    expect(s.status.headSha).toBe(main.sha)
  })

  it('peels annotated tags to the commit they mark', async () => {
    const s = await snap()
    const merge = bySubject(s.commits!, "Merge branch 'feature/login'")
    expect(s.refs.find((r) => r.short === 'v1.0')!.sha).toBe(merge.sha)
  })

  it('reads the dirty working tree', async () => {
    const { status } = await snap()
    expect(status.staged).toEqual([{ path: 'src/staged.ts', status: 'A', added: 1, deleted: 0 }])
    expect(status.unstaged).toEqual([
      { path: 'README.md', status: 'M', added: 1, deleted: 1 },
      { path: 'docs/file with spaces.md', status: '?' },
      { path: 'untracked.txt', status: '?' }
    ])
    expect(status.conflicted).toEqual([])
    expect(status.operation).toBeUndefined()
  })

  it('lists worktrees and which branch each holds', async () => {
    const s = await snap()
    expect(s.worktrees).toHaveLength(2)
    expect(s.worktrees[0]).toMatchObject({ path: repo.path, branch: 'main', isCurrent: true })
    expect(s.worktrees[1]).toMatchObject({ path: worktreePath, branch: 'agent/task-1', isCurrent: false })
    expect(s.refs.find((r) => r.short === 'agent/task-1')!.worktreePath).toBe(worktreePath)
  })

  it('shows a stash as one node on its base commit', async () => {
    const s = await snap()
    expect(s.stashes).toHaveLength(1)
    expect(s.stashes[0]).toMatchObject({ index: 0, ref: 'stash@{0}', message: 'On main: experiment' })
    const node = s.commits!.find((c) => c.sha === s.stashes[0].sha)!
    expect(node.isStash).toBe(true)
    expect(node.parents).toEqual([bySubject(s.commits!, 'Tweak greeting').sha])
    // The index and untracked bookkeeping commits are not shown.
    expect(s.commits!.filter((c) => /^(index on|untracked files on)/.test(c.subject))).toEqual([])
  })

  it('loads every real commit exactly once, parents after children', async () => {
    const { commits } = await snap()
    expect(commits!.map((c) => c.subject).sort()).toEqual(
      [
        'Add login form',
        'Add util module',
        'Agent: add notes',
        'Document usage',
        'Initial commit',
        "Merge branch 'feature/login'",
        'On main: experiment',
        'Rename util to math and add search',
        'Require a password',
        'Tweak greeting',
        'Use login in main'
      ].sort()
    )
    const row = new Map(commits!.map((c, i) => [c.sha, i]))
    for (const c of commits!) for (const p of c.parents) expect(row.get(p)!).toBeGreaterThan(row.get(c.sha)!)
  })

  it('produces a continuous graph', async () => {
    const s = await snap()
    const layout = layoutGraph(s.commits!, s.status.headSha)
    assertContinuous(layout)
    expect(layout.rows[s.commits!.findIndex((c) => c.sha === s.status.headSha)].col).toBe(0)
  })

  it('omits the commit list when the caller already has it', async () => {
    const first = await snap()
    const second = await snap(first.commitsKey)
    expect(second.commits).toBeNull()
    expect(second.commitsKey).toBe(first.commitsKey)
    expect(second.stateKey).toBe(first.stateKey)
  })

  it('pages with hasMore', async () => {
    const s = await loadSnapshot(repo, 3, null)
    expect(s.hasMore).toBe(true)
    expect(s.commits!.length).toBeLessThanOrEqual(3)
    expect((await snap()).hasMore).toBe(false)
  })
})

describe('commitDetail', () => {
  it('describes a commit and its files', async () => {
    const s = await snap()
    const d = await commitDetail(repo, bySubject(s.commits!, 'Require a password').sha, false)
    expect(d).toMatchObject({ author: 'Grace Hopper', email: 'grace@example.com', message: 'Require a password' })
    expect(d.files).toHaveLength(1)
    expect(d.files[0]).toMatchObject({ path: 'src/login.ts', status: 'M', added: 2, deleted: 2 })
    expect(d.files[0].range).toEqual([d.parents[0], d.sha])
  })

  it('detects renames', async () => {
    const s = await snap()
    const d = await commitDetail(repo, bySubject(s.commits!, 'Rename util to math and add search').sha, false)
    expect(d.files).toContainEqual(expect.objectContaining({ path: 'src/math.ts', oldPath: 'src/util.ts', status: 'R' }))
    expect(d.files).toContainEqual(expect.objectContaining({ path: 'src/search.ts', status: 'A', added: 1 }))
  })

  it('shows a root commit against the empty tree', async () => {
    const s = await snap()
    const d = await commitDetail(repo, bySubject(s.commits!, 'Initial commit').sha, false)
    expect(d.parents).toEqual([])
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ['README.md', 'A'],
      ['src/app.ts', 'A']
    ])
  })

  it('shows a merge against its first parent', async () => {
    const s = await snap()
    const d = await commitDetail(repo, bySubject(s.commits!, "Merge branch 'feature/login'").sha, false)
    expect(d.parents).toHaveLength(2)
    expect(d.files.map((f) => f.path)).toEqual(['src/login.ts'])
  })

  it('includes the untracked files a stash swept up', async () => {
    const s = await snap()
    const d = await commitDetail(repo, s.stashes[0].sha, true)
    expect(d.parents).toHaveLength(1)
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ['src/app.ts', 'M'],
      ['scratch.txt', '?']
    ])
  })

  it('refuses anything that is not a commit id', async () => {
    await expect(commitDetail(repo, '--output=/tmp/x', false)).rejects.toThrow(/Not a commit id/)
  })
})

describe('diff', () => {
  it('returns a parseable patch for a committed file', async () => {
    const s = await snap()
    const d = await commitDetail(repo, bySubject(s.commits!, 'Require a password').sha, false)
    const [from, to] = d.files[0].range!
    const parsed = parseDiff(await diff(repo, { kind: 'range', from, to, path: 'src/login.ts' }))
    expect(parsed.hunks).toHaveLength(1)
    const types = parsed.hunks[0].lines.map((l) => l.type)
    expect(types).toEqual(['del', 'del', 'add', 'add', 'ctx'])
    const [del, , add] = parsed.hunks[0].lines
    // A pure insertion leaves nothing to highlight on the deleted side.
    expect(del.mark).toBeUndefined()
    expect(add.text.slice(...add.mark!)).toBe(', pass: string')
    expect(toSplitRows(parsed.hunks[0].lines)).toHaveLength(3)
  })

  it('diffs unstaged, staged and untracked files', async () => {
    const unstaged = parseDiff(await diff(repo, { kind: 'unstaged', path: 'README.md' }))
    expect(unstaged.hunks[0].lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['A repository for viewer tests.'])

    const staged = parseDiff(await diff(repo, { kind: 'staged', path: 'src/staged.ts' }))
    expect(staged.hunks[0].lines).toEqual([{ type: 'add', text: 'export const staged = true', newNo: 1 }])

    const untracked = parseDiff(await diff(repo, { kind: 'unstaged', path: 'docs/file with spaces.md', untracked: true }))
    expect(untracked.hunks[0].lines).toEqual([{ type: 'add', text: '# Spaces', newNo: 1 }])
  })

  it('follows a rename', async () => {
    const s = await snap()
    const d = await commitDetail(repo, bySubject(s.commits!, 'Rename util to math and add search').sha, false)
    const f = d.files.find((x) => x.status === 'R')!
    const parsed = parseDiff(await diff(repo, { kind: 'range', from: f.range![0], to: f.range![1], path: f.path, oldPath: f.oldPath }))
    expect(parsed.notes).toContain('rename from src/util.ts')
    expect(parsed.hunks).toEqual([])
  })
})

describe('a repository with no commits', () => {
  it('loads, stages and unstages before the first commit', async () => {
    const dir = join(root, 'empty')
    mkdirSync(dir)
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    writeFileSync(join(dir, 'first.txt'), 'hello\n')
    const empty = await resolveRepo(dir)

    let s = await loadSnapshot(empty, 100, null)
    expect(s.commits).toEqual([])
    expect(s.status).toMatchObject({ branch: 'main', headSha: null })
    expect(s.status.unstaged).toEqual([{ path: 'first.txt', status: '?' }])
    expect(layoutGraph([{ sha: 'WIP', parents: [] }]).rows).toEqual([{ col: 0, pass: [], ins: [], outs: [] }])

    await runAction(empty, { type: 'stage', paths: ['first.txt'] })
    s = await loadSnapshot(empty, 100, null)
    expect(s.status.staged).toEqual([{ path: 'first.txt', status: 'A', added: 1, deleted: 0 }])
    expect(parseDiff(await diff(empty, { kind: 'staged', path: 'first.txt' })).hunks[0].lines[0].text).toBe('hello')

    await runAction(empty, { type: 'unstage', paths: ['first.txt'] })
    s = await loadSnapshot(empty, 100, null)
    expect(s.status.staged).toEqual([])

    await runAction(empty, { type: 'stageAll' })
    await runAction(empty, { type: 'commit', message: 'First' })
    s = await loadSnapshot(empty, 100, null)
    expect(s.commits!.map((c) => c.subject)).toEqual(['First'])
  })
})

// These mutate the fixture, so they run last and in order.
describe('actions', () => {
  it('stages and unstages', async () => {
    await runAction(repo, { type: 'stage', paths: ['README.md', 'docs/file with spaces.md'] })
    let { status } = await snap()
    expect(status.staged.map((f) => f.path)).toEqual(['README.md', 'docs/file with spaces.md', 'src/staged.ts'])
    expect(status.unstaged.map((f) => f.path)).toEqual(['untracked.txt'])

    await runAction(repo, { type: 'unstage', paths: ['docs/file with spaces.md'] })
    status = (await snap()).status
    expect(status.staged.map((f) => f.path)).toEqual(['README.md', 'src/staged.ts'])
    expect(status.unstaged.map((f) => f.path)).toEqual(['docs/file with spaces.md', 'untracked.txt'])
  })

  it('commits what is staged and moves the branch', async () => {
    const before = await snap()
    await runAction(repo, { type: 'commit', message: 'Reword README\n\nWith a body.' })
    const after = await snap(before.commitsKey)
    expect(after.commits).not.toBeNull()
    expect(after.commits![0].subject === 'Reword README' || after.commits!.some((c) => c.subject === 'Reword README')).toBe(true)
    expect(after.status.staged).toEqual([])
    expect(after.status.ahead).toBe(2)
    const d = await commitDetail(repo, after.status.headSha!, false)
    expect(d.message).toBe('Reword README\n\nWith a body.')
  })

  it('refuses an empty commit message', async () => {
    await expect(runAction(repo, { type: 'commit', message: '   ' })).rejects.toThrow(/needs a message/)
  })

  it('creates a branch and checks branches out', async () => {
    await runAction(repo, { type: 'createBranch', name: 'topic/new', checkout: true })
    expect((await snap()).status.branch).toBe('topic/new')
    await runAction(repo, { type: 'checkout', branch: 'main' })
    expect((await snap()).status.branch).toBe('main')
    await expect(runAction(repo, { type: 'createBranch', name: 'bad..name', checkout: false })).rejects.toThrow(/not a valid branch name/)
    await expect(runAction(repo, { type: 'checkout', branch: '--orphan' })).rejects.toThrow(/No local branch/)
  })

  it('checks out a commit detached, and a remote branch as a tracking branch', async () => {
    const s = await snap()
    await runAction(repo, { type: 'checkoutDetached', sha: bySubject(s.commits!, 'Document usage').sha })
    expect((await snap()).status.branch).toBeNull()
    await runAction(repo, { type: 'checkoutRemote', remoteBranch: 'origin/main' })
    expect((await snap()).status.branch).toBe('main')
  })

  it('stashes and pops, keeping untracked files', async () => {
    writeFileSync(join(repo.path, 'src/app.ts'), '// edited\n')
    await runAction(repo, { type: 'stash', message: 'second' })
    let s = await snap()
    expect(s.stashes.map((x) => x.message)).toEqual(['On main: second', 'On main: experiment'])
    expect(s.status.unstaged).toEqual([])
    await runAction(repo, { type: 'stashPop', index: 0 })
    s = await snap()
    expect(s.stashes).toHaveLength(1)
    expect(s.status.unstaged.map((f) => f.path).sort()).toEqual(['docs/file with spaces.md', 'src/app.ts', 'untracked.txt'])
  })

  it('pushes to the upstream', async () => {
    expect(await runAction(repo, { type: 'push' })).toBe('Pushed main to origin/main')
    const s = await snap()
    expect(s.status.ahead).toBe(0)
    expect(s.refs.find((r) => r.short === 'origin/main')!.sha).toBe(s.status.headSha)
  })

  it('publishes a branch that has no upstream', async () => {
    await runAction(repo, { type: 'checkout', branch: 'topic/new' })
    expect(await runAction(repo, { type: 'push' })).toBe('Published topic/new to origin')
    const s = await snap()
    expect(s.refs.find((r) => r.short === 'topic/new')).toMatchObject({ upstream: 'origin/topic/new' })
  })
})
