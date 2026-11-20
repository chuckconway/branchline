import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSnapshot, resolveRepo, runAction, worktreeChanges, type RepoInfo } from '../src/main/git/repo'
import { buildFixture } from './fixture'

let root: string
let repo: RepoInfo
let agent: string

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const sh = (...args: string[]): string => execFileSync('git', args, { cwd: repo.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
const branches = (): string[] => sh('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')
const trees = async (): Promise<string[]> => (await loadSnapshot(repo, 100, null)).worktrees.map((w) => w.path)

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'branchline-wt-')))
  const built = buildFixture(root)
  repo = await resolveRepo(built.repo)
  agent = built.worktree
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('worktree list', () => {
  it('marks the main working tree', async () => {
    const list = (await loadSnapshot(repo, 100, null)).worktrees
    expect(list.map((w) => [w.path, w.isMain, w.isCurrent])).toEqual([
      [repo.path, true, true],
      [agent, false, false]
    ])
    // Seen from the linked worktree, the main one is still the main one.
    const fromAgent = (await loadSnapshot(await resolveRepo(agent), 100, null)).worktrees
    expect(fromAgent.map((w) => [w.isMain, w.isCurrent])).toEqual([
      [true, false],
      [false, true]
    ])
  })
})

describe('worktreeChanges', () => {
  it('counts uncommitted changes in the other worktrees only', async () => {
    expect(await worktreeChanges(repo)).toEqual({ [agent]: 0 })

    writeFileSync(join(agent, 'notes.md'), 'edited\n')
    writeFileSync(join(agent, 'new.txt'), 'untracked\n')
    expect(await worktreeChanges(repo)).toEqual({ [agent]: 2 })
  })
})

describe('removeWorktree', () => {
  it('refuses a worktree with uncommitted changes, and never forces', async () => {
    await expect(runAction(repo, { type: 'removeWorktree', path: agent })).rejects.toThrow(/repo-agent has 2 uncommitted changes/)
    expect(existsSync(join(agent, 'new.txt'))).toBe(true)
    expect(await trees()).toContain(agent)
  })

  it('refuses the main working tree, the current one, and strangers', async () => {
    await expect(runAction(repo, { type: 'removeWorktree', path: repo.path })).rejects.toThrow(/main working tree cannot be removed/)
    await expect(runAction(await resolveRepo(agent), { type: 'removeWorktree', path: agent })).rejects.toThrow(/worktree you are looking at/)
    await expect(runAction(repo, { type: 'removeWorktree', path: tmpdir() })).rejects.toThrow(/not a worktree of this repository/)
  })

  it('refuses a locked worktree', async () => {
    const locked = join(root, 'locked')
    sh('worktree', 'add', '-q', '-b', 'locked-branch', locked, 'main')
    sh('worktree', 'lock', locked)
    await expect(runAction(repo, { type: 'removeWorktree', path: locked })).rejects.toThrow(/is locked/)
    expect(existsSync(locked)).toBe(true)
    sh('worktree', 'unlock', locked)
  })

  it('removes a clean worktree and keeps its branch', async () => {
    const locked = join(root, 'locked')
    expect(await runAction(repo, { type: 'removeWorktree', path: locked })).toBe('Removed worktree locked')
    expect(existsSync(locked)).toBe(false)
    expect(await trees()).not.toContain(locked)
    expect(branches()).toContain('locked-branch')
  })

  it('removes the branch too when asked', async () => {
    sh('-C', agent, 'checkout', '--', 'notes.md')
    rmSync(join(agent, 'new.txt'))
    expect(await runAction(repo, { type: 'removeWorktree', path: agent, deleteBranch: true })).toBe('Removed worktree repo-agent and branch agent/task-1')
    expect(existsSync(agent)).toBe(false)
    expect(branches()).not.toContain('agent/task-1')
    expect(await trees()).toEqual([repo.path])
  })
})

describe('pruneWorktrees', () => {
  it('clears entries whose folder is gone, which frees their branches', async () => {
    const a = join(root, 'gone-a')
    const b = join(root, 'gone-b')
    const kept = join(root, 'kept')
    sh('worktree', 'add', '-q', '-b', 'gone-a', a, 'main')
    sh('worktree', 'add', '-q', '-b', 'gone-b', b, 'main')
    sh('worktree', 'add', '-q', '-b', 'kept', kept, 'main')
    rmSync(a, { recursive: true })
    rmSync(b, { recursive: true })

    const before = (await loadSnapshot(repo, 100, null)).worktrees
    expect(before.filter((w) => w.prunable).map((w) => w.path)).toEqual([a, b])
    // A missing worktree still holds its branch, so the branch cannot be deleted yet...
    await expect(runAction(repo, { type: 'deleteBranch', branch: 'gone-a' })).rejects.toThrow(/checked out in/)
    // ...is skipped when counting changes, and is not "removed" but pruned.
    expect(Object.keys(await worktreeChanges(repo))).toEqual([kept])
    await expect(runAction(repo, { type: 'removeWorktree', path: a })).rejects.toThrow(/already gone. Prune/)

    expect(await runAction(repo, { type: 'pruneWorktrees' })).toBe('Pruned 2 missing worktrees')
    expect(await trees()).toEqual([repo.path, kept])
    expect(await runAction(repo, { type: 'deleteBranch', branch: 'gone-a' })).toBe('Deleted branch gone-a')
    expect(await runAction(repo, { type: 'pruneWorktrees' })).toBe('No missing worktrees to prune')
    expect(existsSync(kept)).toBe(true)
  })
})
