import { describe, expect, it } from 'vitest'
import { MIN_GIT, gitInfo, isSupportedGit, parseGitVersion } from '../src/main/git/exec'

describe('git version handling', () => {
  it('reads the version from every vendor format', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39])
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual([2, 45])
    expect(parseGitVersion('git version 2.34.1')).toEqual([2, 34])
    expect(parseGitVersion('not git at all')).toBeNull()
  })

  it('accepts the minimum and newer, rejects older', () => {
    expect(isSupportedGit(MIN_GIT)).toBe(true)
    expect(isSupportedGit([2, 54])).toBe(true)
    expect(isSupportedGit([3, 0])).toBe(true)
    expect(isSupportedGit([2, 30])).toBe(false)
    expect(isSupportedGit([1, 9])).toBe(false)
  })

  it('finds a usable git on this machine', async () => {
    const info = await gitInfo()
    expect(info.ok).toBe(true)
    if (info.ok) expect(info.version).toMatch(/^\d+\.\d+$/)
  })
})
