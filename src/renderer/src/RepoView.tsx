import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  GitBranch,
  GitBranchPlus,
  RefreshCw,
  Search,
  TriangleAlert,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { WIP, type Action, type FileChange, type Ref, type Worktree } from '../../shared/types'
import { CommitPanel, WipPanel } from './DetailPanel'
import { FileView } from './FileView'
import { plural, shortSha } from './format'
import { Graph } from './Graph'
import { Sidebar } from './Sidebar'
import {
  commitMenu,
  DeleteBranchDialog,
  fileMenu,
  refMenu,
  RemoveWorktreeDialog,
  RewordDialog,
  TagDialog,
  WorktreeDialog,
  worktreeMenu,
  type MenuUi
} from './menus'
import { ConfirmDialog, ContextMenu, Modal, Spinner, Splitter, useStored, type ConfirmState, type MenuState } from './ui'
import { useRepo, type OpenFile } from './useRepo'

interface RepoViewProps {
  path: string
  active: boolean
  onOpenRepo: (path: string) => void
  /** A worktree of this repository was removed; close its tab if it has one. */
  onWorktreeGone: (path: string) => void
}

export function RepoView({ path, active, onOpenRepo, onWorktreeGone }: RepoViewProps): ReactNode {
  const m = useRepo(path, active)
  const { snap } = m
  const snapRef = useRef(snap)
  snapRef.current = snap
  const [reveal, setReveal] = useState<{ sha: string; nonce: number } | null>(null)
  const [query, setQuery] = useState('')
  const [branchAt, setBranchAt] = useState<string | null | undefined>(undefined)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [rewordSha, setRewordSha] = useState<string | null>(null)
  const [worktreeSha, setWorktreeSha] = useState<string | null>(null)
  const [tagSha, setTagSha] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Ref | null>(null)
  const [removing, setRemoving] = useState<Worktree | null>(null)

  // A tab left pointing at a removed worktree could only show an error.
  const seenWorktrees = useRef<string[]>([])
  useEffect(() => {
    if (!snap) return
    const now = snap.worktrees.map((w) => w.path)
    for (const gone of seenWorktrees.current.filter((p) => !now.includes(p))) onWorktreeGone(gone)
    seenWorktrees.current = now
  }, [snap, onWorktreeGone])
  const [sideW, setSideW] = useStored('layout.sideW', 230)
  const [detailW, setDetailW] = useStored('layout.detailW', 340)

  const { rowIndex, select, setNotice } = m
  const goTo = useCallback(
    (sha: string) => {
      if (!rowIndex.has(sha)) {
        setNotice({ kind: 'info', text: `${shortSha(sha)} is older than the history loaded so far. Scroll down to load more.` })
        return
      }
      select(sha)
      setReveal({ sha, nonce: Date.now() })
    },
    [rowIndex, select, setNotice]
  )

  // Like goTo, but leaves an open file view (history, blame) where it is.
  const { peek } = m
  const peekAt = useCallback(
    (sha: string) => {
      if (!rowIndex.has(sha)) {
        setNotice({ kind: 'info', text: `${shortSha(sha)} is older than the history loaded so far.` })
        return
      }
      peek(sha)
      setReveal({ sha, nonce: Date.now() })
    },
    [rowIndex, peek, setNotice]
  )

  const ui: MenuUi = {
    confirm: setConfirm,
    reword: setRewordSha,
    worktree: setWorktreeSha,
    branch: setBranchAt,
    tag: setTagSha,
    deleteBranch: setDeleting,
    removeWorktree: setRemoving
  }

  // Graph rows are memoised, so they get one stable callback that reads the latest state.
  const openCommitMenu = (sha: string, x: number, y: number, selectIt: boolean): void => {
    const i = m.rowIndex.get(sha)
    if (i === undefined) return
    if (selectIt && m.selected !== sha) m.select(sha)
    const items = commitMenu(m.rows[i], m, path, ui)
    if (items.length) setMenu({ x, y, items })
  }
  const menuRef = useRef(openCommitMenu)
  menuRef.current = openCommitMenu
  const onRowMenu = useCallback((sha: string, x: number, y: number) => menuRef.current(sha, x, y, true), [])
  const onFileMenu = (f: OpenFile, x: number, y: number): void => setMenu({ x, y, items: fileMenu(f, m, path) })
  const openRefMenu = (ref: Ref, x: number, y: number): void => {
    const items = refMenu(ref, m, ui)
    if (items.length) setMenu({ x, y, items })
  }
  const openWorktreeMenu = (tree: Worktree, changes: number | undefined, x: number, y: number): void => {
    const missing = snap ? snap.worktrees.filter((w) => w.prunable).length : 0
    setMenu({ x, y, items: worktreeMenu(tree, changes, missing, m, ui, onOpenRepo) })
  }
  // Branch labels in the graph only know their ref's name.
  const refMenuRef = useRef(openRefMenu)
  refMenuRef.current = openRefMenu
  const onPillMenu = useCallback((refName: string, x: number, y: number) => {
    const ref = snapRef.current?.refs.find((r) => r.name === refName)
    if (ref) refMenuRef.current(ref, x, y)
  }, [])

  const matchList = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const out: number[] = []
    m.rows.forEach((c, i) => {
      if (c.sha === WIP) return
      const hit =
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.sha.startsWith(q) ||
        Boolean(m.pills.get(c.sha)?.some((p) => p.label.toLowerCase().includes(q)))
      if (hit) out.push(i)
    })
    return out
  }, [query, m.rows, m.pills])
  const matches = useMemo(() => (matchList ? new Set(matchList) : null), [matchList])

  const selectedIndex = m.selected ? (m.rowIndex.get(m.selected) ?? -1) : -1
  const matchPos = matchList ? matchList.indexOf(selectedIndex) : -1
  const stepMatch = (delta: 1 | -1): void => {
    if (!matchList?.length) return
    let next: number
    if (matchPos !== -1) next = (matchPos + delta + matchList.length) % matchList.length
    else {
      // Not on a match: jump to the nearest one in the direction asked for.
      const after = matchList.findIndex((i) => i > selectedIndex)
      next = delta === 1 ? (after === -1 ? 0 : after) : (after === -1 ? matchList.length : after) - 1
      if (next < 0) next = matchList.length - 1
    }
    goTo(m.rows[matchList[next]].sha)
  }

  if (!snap) {
    return (
      <div className="repo">
        <div className="empty-state">
          {m.error ? (
            <>
              <TriangleAlert size={28} />
              <h2>Could not read this repository</h2>
              <pre>{m.error}</pre>
              <button className="btn primary" onClick={() => void m.refresh()}>
                Try again
              </button>
            </>
          ) : (
            <Spinner />
          )}
        </div>
      </div>
    )
  }

  const { status } = snap
  const busy = m.busy !== null
  const commit = selectedIndex >= 0 ? m.rows[selectedIndex] : null
  const changed = new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path)).size
  const canPush = Boolean(status.branch) && snap.remotes.length > 0 && Boolean(status.headSha)
  const run = (action: Action): void => void m.run(action)

  const siblings: FileChange[] = !m.openFile
    ? []
    : m.openFile.source === 'commit'
      ? (m.detail?.files ?? [m.openFile.change])
      : m.openFile.source === 'staged'
        ? status.staged
        : [...status.conflicted, ...status.unstaged]

  const tool = (type: Action['type'], label: string, icon: ReactNode, onClick: () => void, disabled: boolean, title: string, badge?: number): ReactNode => (
    <button className="tool" disabled={busy || disabled} onClick={onClick} title={title} data-tool={type}>
      {m.busy === type ? <Spinner /> : icon}
      <span>{label}</span>
      {badge ? <span className="tool-badge">{badge}</span> : null}
    </button>
  )

  return (
    <div className="repo">
      <div className="toolbar">
        <div className="where" title={path}>
          <GitBranch size={14} />
          <strong>{status.branch ?? (status.headSha ? `detached · ${shortSha(status.headSha)}` : 'no commits yet')}</strong>
          {status.operation && <span className="chip warn">{status.operation} in progress</span>}
        </div>

        <div className="tools">
          {tool('fetch', 'Fetch', <CloudDownload size={15} />, () => run({ type: 'fetch' }), snap.remotes.length === 0, 'Fetch all remotes and drop remote branches that were deleted there')}
          {tool(
            'pull',
            'Pull',
            <ArrowDownToLine size={15} />,
            () => run({ type: 'pull' }),
            !status.upstream,
            status.upstream ? `Fast-forward ${status.branch} from ${status.upstream}` : 'This branch has no upstream to pull from',
            status.behind
          )}
          {tool(
            'push',
            status.upstream || !status.branch ? 'Push' : 'Publish',
            <ArrowUpFromLine size={15} />,
            () => run({ type: 'push' }),
            !canPush,
            status.upstream ? `Push ${status.branch} to ${status.upstream}` : canPush ? `Publish ${status.branch} to a remote and track it` : 'Nothing to push to',
            status.ahead
          )}
          <span className="tool-sep" />
          {tool('createBranch', 'Branch', <GitBranchPlus size={15} />, () => setBranchAt(null), !status.headSha, 'Create a branch at HEAD')}
          {tool('stash', 'Stash', <Archive size={15} />, () => run({ type: 'stash' }), !m.dirty, 'Stash all changes, including untracked files')}
          {tool('stashPop', 'Pop', <ArchiveRestore size={15} />, () => run({ type: 'stashPop', index: 0 }), snap.stashes.length === 0, 'Apply the newest stash and remove it')}
        </div>

        <div className="search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search commits" aria-label="Search commits" spellCheck={false} />
          {matchList && (
            <>
              <span className="search-count">{matchList.length === 0 ? 'No results' : `${matchPos === -1 ? '–' : matchPos + 1} / ${matchList.length}`}</span>
              <button className="icon-btn" disabled={!matchList.length} onClick={() => stepMatch(-1)} title="Previous match" aria-label="Previous match">
                <ChevronUp size={14} />
              </button>
              <button className="icon-btn" disabled={!matchList.length} onClick={() => stepMatch(1)} title="Next match" aria-label="Next match">
                <ChevronDown size={14} />
              </button>
              <button className="icon-btn" onClick={() => setQuery('')} title="Clear search" aria-label="Clear search">
                <X size={14} />
              </button>
            </>
          )}
        </div>
        <button className="icon-btn" onClick={() => void m.refresh()} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {(m.notice || m.error) && (
        <div className={`notice ${m.error || m.notice?.kind === 'error' ? 'error' : 'info'}`} role="status">
          <pre>{m.error ? `Could not refresh: ${m.error}` : m.notice?.text}</pre>
          {m.notice && !m.error && (
            <button className="icon-btn" onClick={() => m.setNotice(null)} title="Dismiss" aria-label="Dismiss">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      <div className="workspace">
        <div style={{ width: sideW }} className="pane-fixed">
          <Sidebar snap={snap} selected={m.selected} busy={busy} onReveal={goTo} onAction={run} onOpenWorktree={onOpenRepo} onRefMenu={openRefMenu} onWorktreeMenu={openWorktreeMenu} visible={active} />
        </div>
        <Splitter value={sideW} onChange={setSideW} min={160} max={480} label="Resize sidebar" />

        <div className="center">
          <Graph
            rows={m.rows}
            layout={m.layout}
            pills={m.pills}
            headSha={status.headSha}
            selected={m.selected}
            onSelect={m.select}
            onMenu={onRowMenu}
            onRefMenu={onPillMenu}
            matches={matches}
            reveal={reveal}
            rowIndex={m.rowIndex}
            hasMore={snap.hasMore}
            onLoadMore={m.loadMore}
            wipSummary={plural(changed, 'file')}
          />
          {m.rows.length === 0 && (
            <div className="empty-state over">
              <h2>No commits yet</h2>
              <p>This repository is empty. Commits will appear here as soon as there are any.</p>
            </div>
          )}
          {m.openFile && (
            <FileView
              repo={path}
              file={m.openFile}
              siblings={siblings}
              version={snap.stateKey}
              headSha={status.headSha}
              selected={m.selected}
              onOpen={m.setOpenFile}
              onClose={() => m.setOpenFile(null)}
              onPeek={peekAt}
            />
          )}
        </div>

        <Splitter value={detailW} onChange={setDetailW} min={260} max={720} direction={-1} label="Resize details" />
        <div style={{ width: detailW }} className="pane-fixed wide">
          {m.selected === WIP ? (
            <WipPanel snap={snap} busy={busy} openFile={m.openFile} onOpen={m.setOpenFile} onAction={m.run} onFileMenu={onFileMenu} />
          ) : commit ? (
            <CommitPanel
              commit={commit}
              detail={m.detail}
              pills={m.pills.get(commit.sha)}
              isHead={commit.sha === status.headSha}
              busy={busy}
              openFile={m.openFile}
              onOpen={m.setOpenFile}
              onReveal={goTo}
              onAction={run}
              onBranchHere={setBranchAt}
              onFileMenu={onFileMenu}
              onMore={(x, y) => openCommitMenu(commit.sha, x, y, false)}
            />
          ) : (
            <div className="detail">
              <div className="side-empty">Select a commit to see its details.</div>
            </div>
          )}
        </div>
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
      {rewordSha && (
        <RewordDialog
          repo={path}
          sha={rewordSha}
          upstream={status.upstream}
          onClose={() => setRewordSha(null)}
          onSave={(message) => m.run({ type: 'reword', sha: rewordSha, message })}
        />
      )}
      {worktreeSha && (
        <WorktreeDialog
          repoPath={path}
          sha={worktreeSha}
          onClose={() => setWorktreeSha(null)}
          onCreate={async (folder, branch, open) => {
            const ok = await m.run({ type: 'createWorktree', sha: worktreeSha, path: folder, branch: branch || undefined })
            if (ok && open) onOpenRepo(folder)
            return ok
          }}
        />
      )}
      {tagSha && (
        <TagDialog
          sha={tagSha}
          canPush={snap.remotes.length > 0}
          onClose={() => setTagSha(null)}
          onCreate={(name, message, push) => m.run({ type: 'createTag', name, sha: tagSha, message: message.trim() || undefined, push })}
        />
      )}
      {removing && <RemoveWorktreeDialog repo={path} tree={removing} onClose={() => setRemoving(null)} onRemove={m.run} />}
      {deleting && <DeleteBranchDialog repo={path} target={deleting} refs={snap.refs} onClose={() => setDeleting(null)} onDelete={m.run} />}
      {branchAt !== undefined && (
        <BranchModal
          at={branchAt}
          atLabel={branchAt ? shortSha(branchAt) : `HEAD (${status.branch ?? shortSha(status.headSha ?? '')})`}
          onClose={() => setBranchAt(undefined)}
          onCreate={async (name, checkout) => {
            if (await m.run({ type: 'createBranch', name, at: branchAt ?? undefined, checkout })) setBranchAt(undefined)
          }}
        />
      )}
    </div>
  )
}

interface BranchModalProps {
  at: string | null
  atLabel: string
  onClose: () => void
  onCreate: (name: string, checkout: boolean) => Promise<void>
}

function BranchModal({ atLabel, onClose, onCreate }: BranchModalProps): ReactNode {
  const [name, setName] = useState('')
  const [checkout, setCheckout] = useState(true)
  const [working, setWorking] = useState(false)
  const submit = async (): Promise<void> => {
    if (!name.trim() || working) return
    setWorking(true)
    await onCreate(name, checkout)
    setWorking(false)
  }
  return (
    <Modal title="Create branch" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/my-branch" spellCheck={false} aria-label="Branch name" />
        </label>
        <p className="faint">Starts at {atLabel}.</p>
        <label className="check">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
          Check it out after creating
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || working}>
            Create branch
          </button>
        </div>
      </form>
    </Modal>
  )
}
