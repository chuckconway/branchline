import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { layoutGraph, type GraphLayout } from '../../shared/graph'
import { WIP, type Action, type Commit, type CommitDetail, type FileChange, type Ref, type Snapshot, type Status } from '../../shared/types'

const INITIAL_LIMIT = 5000
const POLL_MS = 3000

export type LoadedSnapshot = Omit<Snapshot, 'commits'> & { commits: Commit[] }

export interface Notice {
  kind: 'info' | 'error'
  text: string
}

export type FileSource = 'commit' | 'unstaged' | 'staged'

export type FileViewMode = 'diff' | 'history' | 'blame'

export interface OpenFile {
  change: FileChange
  source: FileSource
  /** Which view of the file is showing; diff when omitted. */
  view?: FileViewMode
}

/** Branches and tags pointing at one commit, merged into as few labels as possible. */
export interface Pill {
  key: string
  label: string
  kind: 'branch' | 'remote' | 'tag' | 'detached' | 'stash'
  /** A local branch and its same-named remote at the same commit share one pill. */
  hasLocal: boolean
  hasRemote: boolean
  isHead: boolean
  worktreePath?: string
}

export const isDirty = (s: Status): boolean => s.staged.length + s.unstaged.length + s.conflicted.length > 0

function buildPills(snap: LoadedSnapshot): Map<string, Pill[]> {
  const bySha = new Map<string, Ref[]>()
  for (const r of snap.refs) {
    const list = bySha.get(r.sha)
    if (list) list.push(r)
    else bySha.set(r.sha, [r])
  }

  const out = new Map<string, Pill[]>()
  for (const [sha, refs] of bySha) {
    const pills: Pill[] = []
    const locals = new Map<string, Pill>()
    for (const r of refs) {
      if (r.kind !== 'head') continue
      const pill: Pill = {
        key: r.name,
        label: r.short,
        kind: 'branch',
        hasLocal: true,
        hasRemote: false,
        isHead: Boolean(r.isHead),
        worktreePath: r.isHead ? undefined : r.worktreePath
      }
      locals.set(r.short, pill)
      pills.push(pill)
    }
    for (const r of refs) {
      if (r.kind !== 'remote') continue
      const local = locals.get(r.short.slice(r.short.indexOf('/') + 1))
      if (local) local.hasRemote = true
      else pills.push({ key: r.name, label: r.short, kind: 'remote', hasLocal: false, hasRemote: true, isHead: false })
    }
    for (const r of refs) {
      if (r.kind === 'tag') pills.push({ key: r.name, label: r.short, kind: 'tag', hasLocal: false, hasRemote: false, isHead: false })
    }
    pills.sort((a, b) => Number(b.isHead) - Number(a.isHead))
    out.set(sha, pills)
  }

  if (!snap.status.branch && snap.status.headSha) {
    const pill: Pill = { key: 'HEAD', label: 'HEAD', kind: 'detached', hasLocal: false, hasRemote: false, isHead: true }
    out.set(snap.status.headSha, [pill, ...(out.get(snap.status.headSha) ?? [])])
  }
  for (const s of snap.stashes) {
    out.set(s.sha, [{ key: s.ref, label: s.ref, kind: 'stash', hasLocal: false, hasRemote: false, isHead: false }])
  }
  return out
}

export interface RepoModel {
  snap: LoadedSnapshot | null
  error: string | null
  /** Commits as displayed: the uncommitted-changes row first when the tree is dirty. */
  rows: Commit[]
  layout: GraphLayout
  rowIndex: Map<string, number>
  pills: Map<string, Pill[]>
  dirty: boolean
  /**
   * How far each commit is from HEAD along the branch's straight-line history (HEAD = 0),
   * stopping at the first merge. Only these commits can be reworded, dropped or moved.
   */
  linear: Map<string, number>
  selected: string | null
  select: (sha: string | null) => void
  /** Select a commit without closing the file that is open. */
  peek: (sha: string) => void
  detail: CommitDetail | null
  openFile: OpenFile | null
  setOpenFile: (f: OpenFile | null) => void
  busy: Action['type'] | null
  run: (action: Action) => Promise<boolean>
  notice: Notice | null
  setNotice: (n: Notice | null) => void
  refresh: () => Promise<void>
  loadMore: () => void
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useRepo(repoPath: string, active: boolean): RepoModel {
  const [snap, setSnap] = useState<LoadedSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(INITIAL_LIMIT)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [openFile, setOpenFile] = useState<OpenFile | null>(null)
  const [busy, setBusy] = useState<Action['type'] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const snapRef = useRef<LoadedSnapshot | null>(null)
  const limitRef = useRef(limit)
  const activeRef = useRef(active)
  const inFlight = useRef<Promise<void> | null>(null)
  const queued = useRef(false)
  const stale = useRef(true)
  const loadingMore = useRef(false)
  const details = useRef(new Map<string, CommitDetail>())
  limitRef.current = limit
  activeRef.current = active

  const loadOnce = useCallback(async () => {
    stale.current = false
    try {
      const prev = snapRef.current
      const next = await window.api.snapshot(repoPath, limitRef.current, prev?.commitsKey ?? null)
      setError(null)
      if (prev && next.commits === null && next.stateKey === prev.stateKey) return
      const loaded: LoadedSnapshot = { ...next, commits: next.commits ?? prev?.commits ?? [] }
      snapRef.current = loaded
      if (next.commits) loadingMore.current = false
      setSnap(loaded)
    } catch (e) {
      loadingMore.current = false
      setError(errorText(e))
    }
  }, [repoPath])

  // One load at a time. A request that arrives mid-load asks for one more pass when it
  // finishes, so a slow repository is never starved by its own poll, and whoever awaits
  // refresh() sees state from after they asked.
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) {
      queued.current = true
      return inFlight.current
    }
    const loop = async (): Promise<void> => {
      do {
        queued.current = false
        await loadOnce()
      } while (queued.current)
    }
    const running = loop().finally(() => {
      inFlight.current = null
    })
    inFlight.current = running
    return running
  }, [loadOnce])

  // Agents change the repository underneath us. Reload when git's own files move, when the
  // window regains focus, and on a slow poll (edits git has not been told about yet).
  useEffect(() => {
    if (active && stale.current) void refresh()
  }, [active, refresh])

  useEffect(() => {
    const off = window.api.onRepoChanged((changed) => {
      if (changed !== repoPath) return
      if (activeRef.current) void refresh()
      else stale.current = true
    })
    const onFocus = (): void => {
      if (activeRef.current) void refresh()
    }
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => {
      // Visible, not focused: the usual setup is this window sitting beside a terminal.
      if (activeRef.current && document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [repoPath, refresh])

  const dirty = snap ? isDirty(snap.status) : false
  const headSha = snap?.status.headSha ?? null

  const rows = useMemo<Commit[]>(() => {
    if (!snap) return []
    if (!dirty) return snap.commits
    const wip: Commit = { sha: WIP, parents: headSha ? [headSha] : [], author: '', email: '', time: 0, subject: 'Uncommitted changes' }
    return [wip, ...snap.commits]
    // snap.commits keeps its identity across refreshes that did not move any ref.
  }, [snap?.commits, dirty, headSha]) // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(() => layoutGraph(rows, dirty ? null : headSha), [rows, dirty, headSha])
  const rowIndex = useMemo(() => new Map(rows.map((c, i) => [c.sha, i])), [rows])
  const pills = useMemo(() => (snap ? buildPills(snap) : new Map<string, Pill[]>()), [snap])

  const linear = useMemo(() => {
    const map = new Map<string, number>()
    let sha = headSha
    while (sha) {
      const i = rowIndex.get(sha)
      if (i === undefined) break
      const c = rows[i]
      if (c.parents.length > 1) break
      map.set(sha, map.size)
      sha = c.parents[0] ?? null
    }
    return map
  }, [rows, rowIndex, headSha])

  // Keep the selection valid: follow WIP while dirty, fall back to HEAD when it vanishes.
  useEffect(() => {
    if (!snap) return
    setSelected((sel) => {
      if (sel && rowIndex.has(sel)) return sel
      return dirty ? WIP : headSha
    })
  }, [snap, rowIndex, dirty, headSha])

  useEffect(() => {
    if (!selected || selected === WIP) return
    const hit = details.current.get(selected)
    if (hit) {
      setDetail(hit)
      return
    }
    let cancelled = false
    const isStash = Boolean(snapRef.current?.stashes.some((s) => s.sha === selected))
    window.api
      .commitDetail(repoPath, selected, isStash)
      .then((d) => {
        details.current.set(selected, d)
        if (!cancelled) setDetail(d)
      })
      .catch((e) => {
        if (!cancelled) setNotice({ kind: 'error', text: errorText(e) })
      })
    return () => {
      cancelled = true
    }
  }, [repoPath, selected])

  // An open working-tree diff closes once its file leaves that list (staged, committed...).
  useEffect(() => {
    if (!openFile || !snap || openFile.source === 'commit') return
    const list = openFile.source === 'staged' ? snap.status.staged : [...snap.status.unstaged, ...snap.status.conflicted]
    if (!list.some((f) => f.path === openFile.change.path)) setOpenFile(null)
  }, [snap, openFile])

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const t = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(t)
  }, [notice])

  const select = useCallback((sha: string | null) => {
    setSelected(sha)
    setOpenFile(null)
  }, [])

  const peek = useCallback((sha: string) => setSelected(sha), [])

  const run = useCallback(
    async (action: Action): Promise<boolean> => {
      setBusy(action.type)
      let ok = true
      try {
        const message = await window.api.action(repoPath, action)
        if (message) setNotice({ kind: 'info', text: message })
        else setNotice((n) => (n?.kind === 'error' ? null : n))
      } catch (e) {
        ok = false
        setNotice({ kind: 'error', text: errorText(e) })
      }
      await refresh()
      setBusy(null)
      return ok
    },
    [repoPath, refresh]
  )

  const loadMore = useCallback(() => {
    if (!snapRef.current?.hasMore || loadingMore.current) return
    loadingMore.current = true
    setLimit((n) => n * 2)
  }, [])

  useEffect(() => {
    if (limit !== INITIAL_LIMIT) void refresh()
  }, [limit, refresh])

  return {
    snap,
    error,
    rows,
    layout,
    rowIndex,
    pills,
    dirty,
    linear,
    selected,
    select,
    peek,
    detail: detail && detail.sha === selected ? detail : null,
    openFile,
    setOpenFile,
    busy,
    run,
    notice,
    setNotice,
    refresh,
    loadMore
  }
}
