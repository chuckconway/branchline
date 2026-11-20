import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blame, fileHistory, formatPatch, isPublished, loadSnapshot, resolveRepo, runAction, type RepoInfo } from '../src/main/git/repo'
import { parseRemotes, remoteWebBase } from '../src/shared/parse'
import { buildFixture } from './fixture'

let root: string
let repo: RepoInfo

const sh = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: repo.path,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  }).trim()

const subjects = (range = 'HEAD', n = 20): string[] => sh('log', `-n${n}`, '--format=%s', range).split('\n')
const shaOf = (subject: string, range = '--all'): string => {
  const line = sh('log', range, '--format=%H %s').split('\n').find((l) => l.slice(41) === subject)
  if (!line) throw new Error(`no commit "${subject}"`)
  return line.slice(0, 40)
}
const head = (): string => sh('rev-parse', 'HEAD')
const tree = (rev = 'HEAD'): string => sh('rev-parse', `${rev}^{tree}`)
const write = (rel: string, text: string): void => writeFileSync(join(repo.path, rel), text)
const commitFile = (rel: string, text: string, message: string): string => {
  write(rel, text)
  sh('add', '-A')
  sh('commit', '-q', '-m', message)
  return head()
}
/** Nothing half-done is left behind. */
const expectNoOperation = (): void => {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    expect(existsSync(join(repo.gitDir, marker)), marker).toBe(false)
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'branchline-ops-')))
  repo = await resolveRepo(buildFixture(root).repo)
  // These tests want a clean tree; the fixture's dirty files are covered elsewhere.
  sh('reset', '-q', '--hard')
  sh('clean', '-fdq')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('remote links', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo', '/commit/'],
    ['https://github.com/owner/repo', 'https://github.com/owner/repo', '/commit/'],
    ['https://user@gitlab.example.com/group/sub/repo.git', 'https://gitlab.example.com/group/sub/repo', '/-/commit/'],
    ['ssh://git@gitea.local:2222/owner/repo.git', 'https://gitea.local/owner/repo', '/commit/'],
    ['git@bitbucket.org:team/repo.git', 'https://bitbucket.org/team/repo', '/commits/'],
    ['http://localhost:3000/owner/repo.git/', 'https://localhost:3000/owner/repo', '/commit/']
  ])('%s', (url, base, commitPath) => {
    expect(remoteWebBase(url)).toEqual({ base, commitPath })
  })

  it('has no link for a remote that is a local path', () => {
    expect(remoteWebBase('/srv/git/repo.git')).toBeNull()
    expect(remoteWebBase('../origin.git')).toBeNull()
    expect(remoteWebBase('file:///srv/git/repo.git')).toBeNull()
  })

  it('prefers the upstream remote, then origin', () => {
    const out = 'fork\tgit@github.com:me/repo.git (fetch)\nfork\tgit@github.com:me/repo.git (push)\norigin\t/local/path (fetch)\nupstream\tgit@github.com:org/repo.git (fetch)\n'
    expect(parseRemotes(out).names).toEqual(['fork', 'origin', 'upstream'])
    expect(parseRemotes(out).web?.remote).toBe('fork') // origin has no web address
    expect(parseRemotes(out, 'upstream').web).toEqual({ remote: 'upstream', base: 'https://github.com/org/repo', commitPath: '/commit/' })
  })

  it('is absent from a snapshot whose only remote is a folder', async () => {
    expect((await loadSnapshot(repo, 100, null)).remoteWeb).toBeNull()
  })
})

describe('blame', () => {
  it('attributes each line to the commit that last changed it', async () => {
    const b = await blame(repo, head(), 'src/login.ts')
    expect(b.lines.map((l) => l.text)).toEqual([
      'export function login(user: string, pass: string): boolean {',
      '  return user.length > 0 && pass.length > 0',
      '}'
    ])
    const password = shaOf('Require a password')
    const form = shaOf('Add login form')
    expect(b.lines.map((l) => l.sha)).toEqual([password, password, form])
    expect(b.commits[password]).toMatchObject({ author: 'Grace Hopper', summary: 'Require a password' })
    expect(b.commits[form].time).toBeGreaterThan(0)
  })

  it('marks uncommitted lines when blaming the working tree', async () => {
    write('src/login.ts', readFileSync(join(repo.path, 'src/login.ts'), 'utf8') + '// new\n')
    const b = await blame(repo, null, 'src/login.ts')
    expect(b.lines).toHaveLength(4)
    expect(b.lines[3].sha).toMatch(/^0+$/)
    sh('checkout', '--', 'src/login.ts')
  })
})

describe('file history', () => {
  it('follows a file across a rename', async () => {
    const entries = await fileHistory(repo, shaOf('Rename util to math and add search'), 'src/math.ts')
    expect(entries.map((e) => [e.commit.subject, e.change.status, e.change.path, e.change.oldPath])).toEqual([
      ['Rename util to math and add search', 'R', 'src/math.ts', 'src/util.ts'],
      ['Add util module', 'A', 'src/util.ts', undefined]
    ])
    expect(entries[0].change.range).toEqual([entries[0].commit.parents[0], entries[0].commit.sha])
  })

  it('lists the commits that touched a file, newest first, from HEAD by default', async () => {
    const entries = await fileHistory(repo, null, 'README.md')
    expect(entries.map((e) => [e.commit.subject, e.change.status])).toEqual([
      ['Document usage', 'M'],
      ['Initial commit', 'A']
    ])
    // The root commit is diffed against the empty tree.
    expect(entries[1].change.range![0]).toBe(sh('hash-object', '-t', 'tree', '/dev/null'))
  })
})

describe('isPublished', () => {
  it('knows which commits are already on the upstream', async () => {
    expect(await isPublished(repo, shaOf('Use login in main'))).toBe(true)
    expect(await isPublished(repo, shaOf('Tweak greeting'))).toBe(false)
  })
})

describe('formatPatch', () => {
  it('produces a patch git am can read', async () => {
    const patch = await formatPatch(repo, shaOf('Tweak greeting'))
    expect(patch).toMatch(/^From [0-9a-f]{40} /)
    expect(patch).toContain('Subject: [PATCH] Tweak greeting')
    expect(patch).toContain("+  console.log('hello,', login('ada', 'pw'))")
  })
})

// From here on the tests rewrite the fixture's history, in order.
describe('cherry-pick, revert, reset', () => {
  it('cherry-picks a commit from another branch', async () => {
    const before = head()
    expect(await runAction(repo, { type: 'cherryPick', sha: shaOf('Rename util to math and add search') })).toMatch(/^Cherry-picked/)
    expect(subjects('HEAD', 2)).toEqual(['Rename util to math and add search', 'Tweak greeting'])
    expect(sh('rev-parse', 'HEAD^')).toBe(before)
    expect(existsSync(join(repo.path, 'src/search.ts'))).toBe(true)
  })

  it('undoes a cherry-pick that conflicts, leaving everything as it was', async () => {
    sh('checkout', '-q', '-b', 'clash', shaOf('Add util module'))
    const clash = commitFile('README.md', '# Something else entirely\n', 'Clashing README')
    sh('checkout', '-q', 'main')
    const before = head()

    await expect(runAction(repo, { type: 'cherryPick', sha: clash })).rejects.toThrow(/could not be applied cleanly, so it was undone[\s\S]*CONFLICT/)
    expect(head()).toBe(before)
    expect(sh('status', '--porcelain')).toBe('')
    expectNoOperation()
  })

  it('reverts a commit with a new commit', async () => {
    await runAction(repo, { type: 'revert', sha: shaOf('Rename util to math and add search', 'main') })
    expect(subjects('HEAD', 1)).toEqual(['Revert "Rename util to math and add search"'])
    expect(existsSync(join(repo.path, 'src/search.ts'))).toBe(false)
    expect(existsSync(join(repo.path, 'src/util.ts'))).toBe(true)
  })

  it('resets soft, mixed and hard', async () => {
    const top = head()
    const target = sh('rev-parse', 'HEAD~2')

    await runAction(repo, { type: 'reset', sha: target, mode: 'soft' })
    expect(head()).toBe(target)
    expect((await loadSnapshot(repo, 100, null)).status.staged).toEqual([]) // the two commits cancel out
    sh('reset', '-q', '--hard', top)

    const one = sh('rev-parse', 'HEAD~1')
    await runAction(repo, { type: 'reset', sha: one, mode: 'soft' })
    let status = (await loadSnapshot(repo, 100, null)).status
    // Undoing the revert commit leaves its changes staged: search.ts gone, math.ts back to util.ts.
    expect(status.staged.map((f) => [f.status, f.path, f.oldPath])).toEqual([
      ['D', 'src/search.ts', undefined],
      ['R', 'src/util.ts', 'src/math.ts']
    ])
    expect(status.unstaged).toEqual([])
    sh('reset', '-q', '--hard', top)

    await runAction(repo, { type: 'reset', sha: one, mode: 'mixed' })
    status = (await loadSnapshot(repo, 100, null)).status
    expect(status.staged).toEqual([])
    expect(status.unstaged.length).toBeGreaterThan(0)
    sh('reset', '-q', '--hard', top)

    write('README.md', 'scribble\n')
    await runAction(repo, { type: 'reset', sha: target, mode: 'hard' })
    expect(head()).toBe(target)
    expect(sh('status', '--porcelain')).toBe('')
    expect(subjects('HEAD', 1)).toEqual(['Tweak greeting'])
  })
})

describe('editing history in place', () => {
  let a: string
  let c: string

  beforeAll(() => {
    a = commitFile('a.txt', 'a\n', 'Add a')
    commitFile('b.txt', 'b\n', 'Add b')
    c = commitFile('c.txt', 'c\n', 'Add c')
  })

  it('rewords the newest commit without sweeping in staged changes', async () => {
    write('staged.txt', 'staged\n')
    sh('add', 'staged.txt')
    const before = tree()
    await runAction(repo, { type: 'reword', sha: c, message: 'Add c, reworded\n\nWith a body.' })
    expect(sh('log', '-1', '--format=%B').trim()).toBe('Add c, reworded\n\nWith a body.')
    expect(tree()).toBe(before)
    expect(sh('status', '--porcelain')).toBe('A  staged.txt')
    sh('reset', '-q', '--hard')
    c = head()
  })

  it('rewords an older commit and keeps everything after it', async () => {
    const before = tree()
    write('b.txt', 'b, edited but not committed\n')
    await runAction(repo, { type: 'reword', sha: a, message: 'Add a, reworded' })
    expect(subjects('HEAD', 4)).toEqual(['Add c, reworded', 'Add b', 'Add a, reworded', 'Tweak greeting'])
    expect(tree()).toBe(before)
    expect(sh('log', '-1', '--format=%an', 'HEAD~2')).toBe('Ada Lovelace')
    // Uncommitted work survives the rewrite.
    expect(sh('status', '--porcelain')).toBe('M b.txt')
    expectNoOperation()
    sh('checkout', '--', 'b.txt')
    ;[c, , a] = sh('log', '-n3', '--format=%H').split('\n')
  })

  it('keeps a reworded message exactly as written, including lines that start with #', async () => {
    const message = 'Add a, again\n\n#42 is the issue\n# A heading\n\n  indented line'
    await runAction(repo, { type: 'reword', sha: a, message })
    expect(sh('log', '-1', '--format=%B', 'HEAD~2').trimEnd()).toBe(message)
    ;[c, , a] = sh('log', '-n3', '--format=%H').split('\n')
    await runAction(repo, { type: 'reword', sha: a, message: 'Add a, reworded' })
    ;[c, , a] = sh('log', '-n3', '--format=%H').split('\n')
  })

  it('moves a commit up and down', async () => {
    const before = tree()
    await runAction(repo, { type: 'move', sha: a, direction: 'up' })
    expect(subjects('HEAD', 4)).toEqual(['Add c, reworded', 'Add a, reworded', 'Add b', 'Tweak greeting'])
    expect(tree()).toBe(before)

    await runAction(repo, { type: 'move', sha: head(), direction: 'down' })
    expect(subjects('HEAD', 4)).toEqual(['Add a, reworded', 'Add c, reworded', 'Add b', 'Tweak greeting'])
    expect(tree()).toBe(before)

    await expect(runAction(repo, { type: 'move', sha: head(), direction: 'up' })).rejects.toThrow(/already the newest/)
  })

  it('drops a commit from the middle and from the tip', async () => {
    await runAction(repo, { type: 'drop', sha: shaOf('Add c, reworded', 'HEAD') })
    expect(subjects('HEAD', 3)).toEqual(['Add a, reworded', 'Add b', 'Tweak greeting'])
    expect(existsSync(join(repo.path, 'c.txt'))).toBe(false)

    await runAction(repo, { type: 'drop', sha: head() })
    expect(subjects('HEAD', 2)).toEqual(['Add b', 'Tweak greeting'])
    expect(existsSync(join(repo.path, 'a.txt'))).toBe(false)
    expectNoOperation()
  })

  it('undoes a drop that later commits depend on', async () => {
    const first = commitFile('chain.txt', 'one\n', 'Chain 1')
    commitFile('chain.txt', 'one\ntwo\n', 'Chain 2')
    const before = head()
    await expect(runAction(repo, { type: 'drop', sha: first })).rejects.toThrow(/so it was undone. Nothing changed/)
    expect(head()).toBe(before)
    expect(sh('status', '--porcelain')).toBe('')
    expectNoOperation()
  })

  it('refuses to edit across a merge or off the current branch', async () => {
    await expect(runAction(repo, { type: 'reword', sha: shaOf('Document usage'), message: 'x' })).rejects.toThrow(/merge between/)
    await expect(runAction(repo, { type: 'drop', sha: shaOf('Clashing README') })).rejects.toThrow(/not part of the branch/)
    await expect(runAction(repo, { type: 'drop', sha: shaOf('Initial commit') })).rejects.toThrow(/merge between|first commit/)
  })
})

describe('rebase and worktrees', () => {
  it('rebases the current branch onto a commit', async () => {
    sh('checkout', '-q', 'feature/search')
    const target = sh('rev-parse', 'main')
    await runAction(repo, { type: 'rebaseOnto', sha: target })
    expect(sh('rev-parse', 'HEAD^')).toBe(target)
    expect(subjects('HEAD', 1)).toEqual(['Rename util to math and add search'])
  })

  it('undoes a rebase that conflicts', async () => {
    sh('checkout', '-q', 'clash')
    const before = head()
    await expect(runAction(repo, { type: 'rebaseOnto', sha: sh('rev-parse', 'main') })).rejects.toThrow(/so it was undone/)
    expect(head()).toBe(before)
    expect(sh('symbolic-ref', '--short', 'HEAD')).toBe('clash')
    expectNoOperation()
    sh('checkout', '-q', 'main')
  })

  it('creates a worktree on a new branch, or detached', async () => {
    const at = shaOf('Document usage')
    const path = join(root, 'wt-branch')
    await runAction(repo, { type: 'createWorktree', sha: at, path, branch: 'from-menu' })
    const detached = join(root, 'wt-detached')
    await runAction(repo, { type: 'createWorktree', sha: at, path: detached })

    const trees = (await loadSnapshot(repo, 100, null)).worktrees
    expect(trees.find((w) => w.path === path)).toMatchObject({ branch: 'from-menu', sha: at })
    expect(trees.find((w) => w.path === detached)).toMatchObject({ detached: true, sha: at })
    await expect(runAction(repo, { type: 'createWorktree', sha: at, path: 'relative/path' })).rejects.toThrow(/full path/)
  })
})

describe('an operation someone else started', () => {
  it('is never aborted on their behalf', async () => {
    try {
      sh('merge', 'clash')
    } catch {
      // Expected: the merge stops on the README conflict.
    }
    expect(existsSync(join(repo.gitDir, 'MERGE_HEAD'))).toBe(true)

    await expect(runAction(repo, { type: 'cherryPick', sha: shaOf('Add login form') })).rejects.toThrow(/merge is already in progress/)
    await expect(runAction(repo, { type: 'drop', sha: head() })).rejects.toThrow(/already in progress/)
    expect(existsSync(join(repo.gitDir, 'MERGE_HEAD'))).toBe(true)
    sh('merge', '--abort')
  })
})
