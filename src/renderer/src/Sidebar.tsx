import { Archive, Check, ChevronDown, ChevronRight, Cloud, Ellipsis, Folder, FolderGit2, GitBranch, Search, Tag, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Action, Ref, Stash, Worktree } from '../../shared/types'
import { shortSha } from './format'
import type { LoadedSnapshot } from './useRepo'

interface TreeNode {
  name: string
  path: string
  ref?: Ref
  children: TreeNode[]
  leaves: number
}

/** Group refs into folders on "/", so feature/a and feature/b share a "feature" folder. */
function buildTree(refs: Ref[], label: (r: Ref) => string): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], leaves: 0 }
  for (const ref of refs) {
    const parts = label(ref).split('/')
    let node = root
    node.leaves++
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.name === part && Boolean(c.ref) === last)
      if (!child) {
        child = { name: part, path, children: [], leaves: 0 }
        node.children.push(child)
      }
      if (last) child.ref = ref
      else child.leaves++
      node = child
    })
  }
  const sort = (n: TreeNode): void => {
    n.children.sort((a, b) => Number(Boolean(a.ref)) - Number(Boolean(b.ref)) || a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

interface SidebarProps {
  snap: LoadedSnapshot
  selected: string | null
  busy: boolean
  onReveal: (sha: string) => void
  onAction: (action: Action) => void
  onOpenWorktree: (path: string) => void
  /** Right-click on a branch, or its "more" button. */
  onRefMenu: (ref: Ref, x: number, y: number) => void
  /** Right-click on a worktree, or its "more" button. `changes` is undefined until checked. */
  onWorktreeMenu: (tree: Worktree, changes: number | undefined, x: number, y: number) => void
  /** Whether this repository's tab is the one showing. */
  visible: boolean
}

const WORKTREE_POLL_MS = 10_000

export function Sidebar({ snap, selected, busy, onReveal, onAction, onOpenWorktree, onRefMenu, onWorktreeMenu, visible }: SidebarProps): ReactNode {
  const [changes, setChanges] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | null>(null)

  const q = filter.trim().toLowerCase()
  const match = (s: string): boolean => !q || s.toLowerCase().includes(q)

  const locals = useMemo(() => snap.refs.filter((r) => r.kind === 'head' && match(r.short)), [snap.refs, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const remotes = useMemo(() => snap.refs.filter((r) => r.kind === 'remote' && match(r.short)), [snap.refs, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(
    () => snap.refs.filter((r) => r.kind === 'tag' && match(r.short)).sort((a, b) => b.short.localeCompare(a.short, undefined, { numeric: true })),
    [snap.refs, q] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const stashes = snap.stashes.filter((s) => match(s.message))
  const worktrees = snap.worktrees.filter((w) => match(w.path) || match(w.branch ?? ''))

  const localTree = useMemo(() => buildTree(locals, (r) => r.short), [locals])
  const remoteTree = useMemo(() => buildTree(remotes, (r) => r.short), [remotes])

  // Big folders start collapsed so a repository with hundreds of branches stays scannable.
  const isOpen = (key: string, leaves: number): boolean => {
    if (q) return true
    const defaultOpen = leaves <= 25
    return closed.has(key) ? !defaultOpen : defaultOpen
  }
  const toggle = (key: string): void => {
    const next = new Set(closed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setClosed(next)
  }

  // Counting changes costs a `git status` per worktree, so it runs only while the section is
  // open and showing, on a slower beat than the main view, and again whenever a branch moves.
  const worktreesOpen = isOpen('section:worktrees', 0)
  const linkedKey = snap.worktrees
    .filter((w) => !w.isCurrent && !w.bare && !w.prunable)
    .map((w) => w.path)
    .join('\n')
  useEffect(() => {
    if (!visible || !worktreesOpen || !linkedKey) return
    let cancelled = false
    const load = (): void => {
      if (document.visibilityState !== 'visible') return
      window.api
        .worktreeChanges(snap.repoPath)
        .then((c) => !cancelled && setChanges(c))
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, WORKTREE_POLL_MS)
    window.addEventListener('focus', load)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [snap.repoPath, snap.commitsKey, visible, worktreesOpen, linkedKey])

  const missing = snap.worktrees.filter((w) => w.prunable).length
  const ownChanges = new Set([...snap.status.staged, ...snap.status.unstaged, ...snap.status.conflicted].map((f) => f.path)).size

  const pick = (key: string, sha: string): void => {
    setActive(key)
    onReveal(sha)
  }

  const renderRef = (ref: Ref, name: string, depth: number): ReactNode => {
    const isActive = active === ref.name
    const elsewhere = !ref.isHead && ref.worktreePath
    return (
      <div
        key={ref.name}
        className={`side-row ${isActive ? 'active' : ''} ${ref.isHead ? 'head' : ''} ${ref.sha === selected ? 'at-selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => pick(ref.name, ref.sha)}
        onContextMenu={
          ref.kind === 'tag'
            ? undefined
            : (e) => {
                e.preventDefault()
                setActive(ref.name)
                onRefMenu(ref, e.clientX, e.clientY)
              }
        }
        onDoubleClick={() => {
          if (ref.kind === 'head' && !ref.isHead && !elsewhere) onAction({ type: 'checkout', branch: ref.short })
          else if (ref.kind === 'remote') onAction({ type: 'checkoutRemote', remoteBranch: ref.short })
        }}
        title={ref.short + (elsewhere ? `\nChecked out in ${ref.worktreePath}` : '')}
      >
        <span className="side-icon">
          {ref.isHead ? (
            <Check size={13} strokeWidth={3} />
          ) : ref.kind === 'tag' ? (
            <Tag size={13} />
          ) : ref.kind === 'remote' ? (
            <Cloud size={13} />
          ) : elsewhere ? (
            <FolderGit2 size={13} />
          ) : (
            <GitBranch size={13} />
          )}
        </span>
        <span className="side-name">{name}</span>
        {ref.gone && <span className="badge gone" title="Its upstream branch was deleted">gone</span>}
        {ref.ahead ? <span className="badge" title={`${ref.ahead} ahead of ${ref.upstream}`}>↑{ref.ahead}</span> : null}
        {ref.behind ? <span className="badge" title={`${ref.behind} behind ${ref.upstream}`}>↓{ref.behind}</span> : null}
        {isActive && ref.kind === 'head' && !ref.isHead && !elsewhere && (
          <button className="row-btn" disabled={busy} onClick={(e) => (e.stopPropagation(), onAction({ type: 'checkout', branch: ref.short }))}>
            Checkout
          </button>
        )}
        {isActive && ref.kind === 'remote' && (
          <button className="row-btn" disabled={busy} onClick={(e) => (e.stopPropagation(), onAction({ type: 'checkoutRemote', remoteBranch: ref.short }))}>
            Checkout
          </button>
        )}
        {isActive && ref.kind !== 'tag' && (
          <button
            className="icon-btn"
            title={`More for ${ref.short}: copy name, delete…`}
            aria-label={`More actions for ${ref.short}`}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              onRefMenu(ref, r.left, r.bottom + 4)
            }}
          >
            <Ellipsis size={14} />
          </button>
        )}
      </div>
    )
  }

  const renderTree = (node: TreeNode, prefix: string, depth: number): ReactNode[] =>
    node.children.flatMap((child) => {
      if (child.ref) return [renderRef(child.ref, child.name, depth)]
      const key = `${prefix}/${child.path}`
      const open = isOpen(key, child.leaves)
      return [
        <div key={key} className="side-row folder" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(key)}>
          <span className="side-icon">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
          <span className="side-icon">
            <Folder size={13} />
          </span>
          <span className="side-name">{child.name}</span>
          <span className="count">{child.leaves}</span>
        </div>,
        ...(open ? renderTree(child, prefix, depth + 1) : [])
      ]
    })

  const section = (key: string, title: string, count: number, body: () => ReactNode): ReactNode => {
    const open = isOpen(`section:${key}`, 0)
    return (
      <section className="side-section" data-section={key}>
        <button className="side-title" onClick={() => toggle(`section:${key}`)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{title}</span>
          <span className="count">{count}</span>
        </button>
        {open && (count > 0 ? body() : <div className="side-empty">{q ? 'No matches' : 'None'}</div>)}
      </section>
    )
  }

  const renderStash = (s: Stash): ReactNode => {
    const isActive = active === s.ref
    return (
      <div key={s.ref} className={`side-row ${isActive ? 'active' : ''}`} style={{ paddingLeft: 10 }} onClick={() => pick(s.ref, s.sha)} title={s.message}>
        <span className="side-icon">
          <Archive size={13} />
        </span>
        <span className="side-name">{s.message.replace(/^(WIP on|On) /, '')}</span>
        {isActive && (
          <button className="row-btn" disabled={busy} onClick={(e) => (e.stopPropagation(), onAction({ type: 'stashPop', index: s.index }))}>
            Pop
          </button>
        )}
      </div>
    )
  }

  const renderWorktree = (w: Worktree): ReactNode => {
    const isActive = active === w.path
    const name = w.path.slice(w.path.lastIndexOf('/') + 1)
    const count = w.isCurrent ? ownChanges : changes[w.path]
    return (
      <div
        key={w.path}
        className={`side-row two-line ${isActive ? 'active' : ''} ${w.isCurrent ? 'head' : ''}`}
        style={{ paddingLeft: 10 }}
        onClick={() => (w.sha ? pick(w.path, w.sha) : setActive(w.path))}
        onContextMenu={(e) => {
          e.preventDefault()
          setActive(w.path)
          onWorktreeMenu(w, count, e.clientX, e.clientY)
        }}
        title={w.path}
      >
        <span className="side-icon">{w.isCurrent ? <Check size={13} strokeWidth={3} /> : <FolderGit2 size={13} />}</span>
        <span className="side-name">
          {name}
          <span className="side-sub">
            {w.bare ? 'bare' : (w.branch ?? `detached at ${shortSha(w.sha)}`)}
            {w.prunable && <span className="warn"> · missing</span>}
            {w.locked && ' · locked'}
            {count ? (
              <span className="warn" title={`${count} uncommitted ${count === 1 ? 'change' : 'changes'} in this worktree`}>
                {' '}
                · {count} uncommitted
              </span>
            ) : null}
          </span>
        </span>
        {isActive && !w.isCurrent && !w.bare && !w.prunable && (
          <button className="row-btn" onClick={(e) => (e.stopPropagation(), onOpenWorktree(w.path))}>
            Open
          </button>
        )}
        {isActive && (
          <button
            className="icon-btn"
            title={`More for ${name}: reveal, copy path, remove…`}
            aria-label={`More actions for worktree ${name}`}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              onWorktreeMenu(w, count, r.left, r.bottom + 4)
            }}
          >
            <Ellipsis size={14} />
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="side-filter">
        <Search size={13} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter branches and tags" aria-label="Filter branches and tags" spellCheck={false} />
        {filter && (
          <button className="icon-btn" onClick={() => setFilter('')} title="Clear filter" aria-label="Clear filter">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="side-scroll">
        {section('local', 'Local', locals.length, () => renderTree(localTree, 'local', 0))}
        {section('remote', 'Remote', remotes.length, () => renderTree(remoteTree, 'remote', 0))}
        {section('worktrees', 'Worktrees', worktrees.length, () => (
          <>
            {missing > 0 && (
              <div className="side-note">
                <span>
                  {missing} missing {missing === 1 ? 'folder' : 'folders'}
                </span>
                <button
                  className="row-btn"
                  disabled={busy}
                  title="Forget worktrees whose folder no longer exists. Their branches become deletable."
                  onClick={() => onAction({ type: 'pruneWorktrees' })}
                >
                  Prune
                </button>
              </div>
            )}
            {worktrees.map(renderWorktree)}
          </>
        ))}
        {section('stashes', 'Stashes', stashes.length, () => stashes.map(renderStash))}
        {section('tags', 'Tags', tags.length, () => tags.map((t) => renderRef(t, t.short, 0)))}
      </div>
    </aside>
  )
}
