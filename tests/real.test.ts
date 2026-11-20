import { describe, expect, it } from 'vitest'
import { blame, commitDetail, fileHistory, loadSnapshot, resolveRepo, uniqueCommits, worktreeChanges } from '../src/main/git/repo'
import { layoutGraph } from '../src/shared/graph'
import { assertContinuous } from './helpers'

/**
 * Read-only checks against real repositories, which have shapes no fixture anticipates.
 *   BRANCHLINE_REAL_REPOS=/path/a:/path/b npx vitest run tests/real.test.ts
 */
const repos = (process.env.BRANCHLINE_REAL_REPOS ?? '').split(':').filter(Boolean)

describe.skipIf(repos.length === 0)('real repositories', () => {
  it.each(repos)('%s loads and lays out cleanly', async (path) => {
    const repo = await resolveRepo(path)
    const t0 = performance.now()
    const snap = await loadSnapshot(repo, 100_000, null)
    const t1 = performance.now()
    const commits = snap.commits!
    const layout = layoutGraph(commits, snap.status.headSha)
    const t2 = performance.now()

    assertContinuous(layout)
    expect(new Set(commits.map((c) => c.sha)).size).toBe(commits.length)
    const row = new Map(commits.map((c, i) => [c.sha, i]))
    for (const c of commits) for (const p of c.parents) if (row.has(p)) expect(row.get(p)!).toBeGreaterThan(row.get(c.sha)!)
    // Every ref and worktree should land on a commit that is in the graph.
    const missing = snap.refs.filter((r) => !row.has(r.sha))
    expect(missing.map((r) => r.short)).toEqual([])
    if (snap.status.headSha) expect(layout.rows[row.get(snap.status.headSha)!].col).toBe(0)

    const merge = commits.find((c) => c.parents.length > 1 && !c.isStash)
    if (merge) expect((await commitDetail(repo, merge.sha, false)).parents.length).toBeGreaterThan(1)

    // File history and blame on whatever file the newest ordinary commit touched.
    const recent = commits.find((c) => c.parents.length === 1 && !c.isStash)
    let fileNote = 'no file checked'
    if (recent) {
      const file = (await commitDetail(repo, recent.sha, false)).files.find((f) => f.status !== 'D' && !f.binary)
      if (file) {
        const history = await fileHistory(repo, recent.sha, file.path)
        expect(history[0].commit.sha).toBe(recent.sha)
        for (const h of history) expect(h.change.range![1]).toBe(h.commit.sha)
        const lines = (await blame(repo, recent.sha, file.path)).lines
        expect(lines.length).toBeGreaterThan(0)
        fileNote = `${file.path}: ${history.length} history entries, ${lines.length} blamed lines`
      }
    }

    // Counting what a delete would orphan has to stay quick with hundreds of refs.
    const branch = snap.refs.find((r) => r.kind === 'head' && !r.isHead)
    const t3 = performance.now()
    const unique = branch ? await uniqueCommits(repo, [branch.name]) : 0
    const uniqueMs = performance.now() - t3
    expect(unique).toBeGreaterThanOrEqual(0)
    fileNote += ` | unique-commit count for ${branch?.short ?? 'no branch'}: ${unique} in ${uniqueMs.toFixed(0)} ms`

    // One `git status` per linked worktree: this is the cost of the per-row change counts.
    const t4 = performance.now()
    const changes = await worktreeChanges(repo)
    const linked = snap.worktrees.filter((w) => !w.isCurrent && !w.bare && !w.prunable)
    expect(Object.keys(changes).sort()).toEqual(linked.map((w) => w.path).sort())
    expect(snap.worktrees.filter((w) => w.isMain)).toHaveLength(1)
    fileNote +=
      ` | worktrees: ${linked.length} checked in ${(performance.now() - t4).toFixed(0)} ms, ` +
      `${Object.values(changes).filter((n) => n > 0).length} with changes, ${snap.worktrees.filter((w) => w.prunable).length} missing`

    const widths = layout.rows.map((r) => Math.max(r.col, ...r.pass, ...r.ins, ...r.outs) + 1).sort((a, b) => a - b)
    console.log(
      `${path}: ${commits.length} commits, ${snap.refs.length} refs, ${snap.worktrees.length} worktrees, ${snap.stashes.length} stashes | ` +
        `snapshot ${(t1 - t0).toFixed(0)} ms, layout ${(t2 - t1).toFixed(1)} ms | lanes max ${layout.width}, ` +
        `median ${widths[widths.length >> 1]}, p98 ${widths[Math.floor(widths.length * 0.98)]} | ` +
        `web ${snap.remoteWeb ? `${snap.remoteWeb.remote} ${snap.remoteWeb.commitPath}` : 'none'} | ${fileNote}`
    )
  })
})
