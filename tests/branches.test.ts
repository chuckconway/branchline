import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSnapshot, resolveRepo, runAction, uniqueCommits, type RepoInfo } from '../src/main/git/repo'
import { buildFixture } from './fixture'

let root: string
let repo: RepoInfo
let origin: string

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const sh = (...args: string[]): string => execFileSync('git', args, { cwd: repo.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
const onOrigin = (...args: string[]): string => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
const refs = (dir: 'local' | 'origin'): string[] =>
  (dir === 'local' ? sh('for-each-ref', '--format=%(refname)') : onOrigin('for-each-ref', '--format=%(refname)')).split('\n').filter(Boolean)
const shaOf = (subject: string): string => {
  const line = sh('log', '--all', '--format=%H %s').split('\n').find((l) => l.slice(41) === subject)
  if (!line) throw new Error(`no commit "${subject}"`)
  return line.slice(0, 40)
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'branchline-br-')))
  repo = await resolveRepo(buildFixture(root).repo)
  origin = join(root, 'origin.git')
  sh('reset', '-q', '--hard')
  sh('clean', '-fdq')

  // A branch whose commits live on the remote too, and nowhere else.
  sh('checkout', '-q', '-b', 'solo')
  for (const n of [1, 2]) {
    writeFileSync(join(repo.path, `solo${n}.txt`), `${n}\n`)
    sh('add', '-A')
    sh('commit', '-q', '-m', `Solo ${n}`)
  }
  sh('push', '-q', '-u', 'origin', 'solo')
  sh('checkout', '-q', 'main')
  sh('remote', 'set-head', 'origin', 'main')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('uniqueCommits', () => {
  it('counts commits that would be left on no branch', async () => {
    expect(await uniqueCommits(repo, ['refs/heads/feature/search'])).toBe(1)
    expect(await uniqueCommits(repo, ['refs/heads/agent/task-1'])).toBe(1)
    // Merged into main, so nothing is unique to it, with or without its remote copy.
    expect(await uniqueCommits(repo, ['refs/heads/feature/login'])).toBe(0)
    expect(await uniqueCommits(repo, ['refs/heads/feature/login', 'refs/remotes/origin/feature/login'])).toBe(0)
  })

  it('sees that a pushed branch is safe to delete locally but not on both sides', async () => {
    expect(await uniqueCommits(repo, ['refs/heads/solo'])).toBe(0)
    expect(await uniqueCommits(repo, ['refs/remotes/origin/solo'])).toBe(0)
    expect(await uniqueCommits(repo, ['refs/heads/solo', 'refs/remotes/origin/solo'])).toBe(2)
  })

  it('treats a missing ref as nothing to lose and rejects non-branches', async () => {
    expect(await uniqueCommits(repo, ['refs/heads/does-not-exist'])).toBe(0)
    await expect(uniqueCommits(repo, ['--all'])).rejects.toThrow(/Not a branch/)
    await expect(uniqueCommits(repo, ['refs/tags/v1.0'])).rejects.toThrow(/Not a branch/)
  })
})

describe('the remote default branch', () => {
  it('is marked in the snapshot and cannot be deleted', async () => {
    const snap = await loadSnapshot(repo, 100, null)
    expect(snap.refs.find((r) => r.short === 'origin/main')).toMatchObject({ isDefault: true })
    expect(snap.refs.find((r) => r.short === 'origin/solo')!.isDefault).toBeUndefined()
    expect(snap.refs.some((r) => r.short === 'origin/HEAD')).toBe(false)
    await expect(runAction(repo, { type: 'deleteRemoteBranch', remoteBranch: 'origin/main' })).rejects.toThrow(/default branch of origin/)
    expect(refs('origin')).toContain('refs/heads/main')
  })
})

describe('deleteBranch', () => {
  it('refuses the checked-out branch and one held by another worktree', async () => {
    await expect(runAction(repo, { type: 'deleteBranch', branch: 'main' })).rejects.toThrow(/is checked out\. Check out another/)
    await expect(runAction(repo, { type: 'deleteBranch', branch: 'agent/task-1' })).rejects.toThrow(/checked out in .*repo-agent/)
    await expect(runAction(repo, { type: 'deleteBranch', branch: '--all' })).rejects.toThrow(/No local branch/)
    expect(refs('local')).toEqual(expect.arrayContaining(['refs/heads/main', 'refs/heads/agent/task-1']))
  })

  it('deletes a local branch even when git would call it unmerged, leaving the remote alone', async () => {
    expect(await runAction(repo, { type: 'deleteBranch', branch: 'feature/search' })).toBe('Deleted branch feature/search')
    expect(refs('local')).not.toContain('refs/heads/feature/search')

    await runAction(repo, { type: 'deleteBranch', branch: 'feature/login' })
    expect(refs('local')).not.toContain('refs/heads/feature/login')
    expect(refs('local')).toContain('refs/remotes/origin/feature/login')
    expect(refs('origin')).toContain('refs/heads/feature/login')
  })

  it('deletes the remote copy too when asked', async () => {
    // A branch that merely tracks a shared branch must not take that branch with it.
    sh('branch', '--track', 'tracks-main', 'origin/main')
    await expect(runAction(repo, { type: 'deleteBranch', branch: 'tracks-main', remoteBranch: 'origin/main' })).rejects.toThrow(/not the remote copy/)
    expect(refs('local')).toContain('refs/heads/tracks-main')
    expect(refs('origin')).toContain('refs/heads/main')

    expect(await runAction(repo, { type: 'deleteBranch', branch: 'solo', remoteBranch: 'origin/solo' })).toBe('Deleted branch solo. Deleted solo from origin')
    expect(refs('local')).not.toContain('refs/heads/solo')
    expect(refs('local')).not.toContain('refs/remotes/origin/solo')
    expect(refs('origin')).not.toContain('refs/heads/solo')
  })
})

describe('deleteRemoteBranch', () => {
  it('deletes the branch on the remote and its local record', async () => {
    expect(await runAction(repo, { type: 'deleteRemoteBranch', remoteBranch: 'origin/feature/login' })).toBe('Deleted feature/login from origin')
    expect(refs('origin')).not.toContain('refs/heads/feature/login')
    expect(refs('local')).not.toContain('refs/remotes/origin/feature/login')
  })

  it('clears a stale record when the branch is already gone from the remote', async () => {
    sh('push', '-q', 'origin', 'main:refs/heads/short-lived')
    expect(refs('local')).toContain('refs/remotes/origin/short-lived')
    onOrigin('update-ref', '-d', 'refs/heads/short-lived')

    // Depending on the git version the remote either accepts the no-op delete or reports the
    // ref missing; either way our record of it has to go and nothing may be left half-done.
    expect(await runAction(repo, { type: 'deleteRemoteBranch', remoteBranch: 'origin/short-lived' })).toMatch(
      /Deleted short-lived from origin|already gone from origin/
    )
    expect(refs('local')).not.toContain('refs/remotes/origin/short-lived')
    expect(refs('origin')).not.toContain('refs/heads/short-lived')
  })

  it('rejects a branch it does not know', async () => {
    await expect(runAction(repo, { type: 'deleteRemoteBranch', remoteBranch: 'origin/nope' })).rejects.toThrow(/No remote branch/)
  })
})

describe('createTag', () => {
  it('creates a lightweight tag on a commit', async () => {
    const at = shaOf('Document usage')
    expect(await runAction(repo, { type: 'createTag', name: 'light', sha: at })).toBe('Created tag light')
    expect(sh('rev-parse', 'refs/tags/light')).toBe(at)
    expect(sh('cat-file', '-t', 'refs/tags/light')).toBe('commit')
    expect(refs('origin')).not.toContain('refs/tags/light')
  })

  it('creates an annotated tag when given a message, and can push it', async () => {
    const at = shaOf('Use login in main')
    expect(await runAction(repo, { type: 'createTag', name: 'v2.0', sha: at, message: 'Version 2\n\nNotes.', push: true })).toBe(
      'Created tag v2.0 and pushed it to origin'
    )
    expect(sh('cat-file', '-t', 'refs/tags/v2.0')).toBe('tag')
    expect(sh('rev-parse', 'refs/tags/v2.0^{commit}')).toBe(at)
    expect(sh('tag', '-l', '--format=%(contents)', 'v2.0')).toBe('Version 2\n\nNotes.')
    expect(refs('origin')).toContain('refs/tags/v2.0')
    const snap = await loadSnapshot(repo, 100, null)
    expect(snap.refs.find((r) => r.short === 'v2.0')).toMatchObject({ kind: 'tag', sha: at })
  })

  it('rejects a duplicate or malformed name', async () => {
    const at = shaOf('Document usage')
    await expect(runAction(repo, { type: 'createTag', name: 'light', sha: at })).rejects.toThrow(/already exists/)
    await expect(runAction(repo, { type: 'createTag', name: 'bad..name', sha: at })).rejects.toThrow(/not a valid tag name/)
    await expect(runAction(repo, { type: 'createTag', name: '-d', sha: at })).rejects.toThrow(/not a valid tag name/)
    await expect(runAction(repo, { type: 'createTag', name: 'ok', sha: 'HEAD; rm' })).rejects.toThrow(/Not a commit id/)
  })
})
