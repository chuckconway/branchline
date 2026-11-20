import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Cherry,
  CircleCheck,
  Copy,
  Eraser,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitBranchPlus,
  GitCompareArrows,
  History,
  Link,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRoundSearch
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { WIP, type Action, type Commit, type Ref, type ResetMode, type Worktree } from '../../shared/types'
import { plural, shortSha } from './format'
import { Modal, type ConfirmState, type MenuItem } from './ui'
import type { OpenFile, RepoModel } from './useRepo'

const ICON = 15
const icons = {
  checkout: <CircleCheck size={ICON} />,
  worktree: <FolderGit2 size={ICON} />,
  branch: <GitBranchPlus size={ICON} />,
  cherryPick: <Cherry size={ICON} />,
  rebase: <GitCompareArrows size={ICON} />,
  reset: <RotateCcw size={ICON} />,
  revert: <Undo2 size={ICON} />,
  edit: <Pencil size={ICON} />,
  remove: <Trash2 size={ICON} />,
  up: <ArrowUp size={ICON} />,
  down: <ArrowDown size={ICON} />,
  copy: <Copy size={ICON} />,
  link: <Link size={ICON} />,
  diff: <FileDiff size={ICON} />,
  tag: <Tag size={ICON} />,
  stage: <Plus size={ICON} />,
  unstage: <Minus size={ICON} />,
  stash: <Archive size={ICON} />,
  pop: <ArchiveRestore size={ICON} />,
  history: <History size={ICON} />,
  blame: <UserRoundSearch size={ICON} />,
  reveal: <FolderOpen size={ICON} />,
  openTab: <AppWindow size={ICON} />,
  prune: <Eraser size={ICON} />
}

/** The dialogs a menu item can open. */
export interface MenuUi {
  confirm: (c: ConfirmState) => void
  reword: (sha: string) => void
  worktree: (sha: string) => void
  branch: (sha: string) => void
  tag: (sha: string) => void
  deleteBranch: (ref: Ref) => void
  removeWorktree: (tree: Worktree) => void
}

function PublishedWarning({ upstream }: { upstream?: string }): ReactNode {
  return (
    <div className="callout">
      <TriangleAlert size={14} />
      <span>
        This commit is already on {upstream ?? 'the remote'}. Changing it rewrites history that has been pushed, so the branch will need a
        force-push afterwards, which this app does not do.
      </span>
    </div>
  )
}

const RESET_EFFECT: Record<ResetMode, string> = {
  soft: 'Changes from the commits that leave the branch stay staged.',
  mixed: 'Changes from the commits that leave the branch stay in your files, unstaged.',
  hard: 'Your files are made to match it exactly.'
}

/** What right-clicking a row of the graph offers. */
export function commitMenu(c: Commit, m: RepoModel, repo: string, ui: MenuUi): MenuItem[] {
  const snap = m.snap
  if (!snap) return []
  const { status } = snap
  const run = (action: Action): void => void m.run(action)
  const copy = (text: string, what: string): void => {
    void window.api.copyText(text)
    m.setNotice({ kind: 'info', text: `Copied ${what}` })
  }

  if (c.sha === WIP) {
    return [
      { label: 'Stage all changes', icon: icons.stage, onSelect: () => run({ type: 'stageAll' }), disabled: status.unstaged.length === 0 },
      { label: 'Unstage all changes', icon: icons.unstage, onSelect: () => run({ type: 'unstageAll' }), disabled: status.staged.length === 0 },
      'separator',
      { label: 'Stash all changes', icon: icons.stash, onSelect: () => run({ type: 'stash' }) }
    ]
  }

  if (c.isStash) {
    const stash = snap.stashes.find((s) => s.sha === c.sha)
    return [
      { label: 'Pop this stash', icon: icons.pop, onSelect: () => stash && run({ type: 'stashPop', index: stash.index }), disabled: !stash },
      'separator',
      { label: 'Copy stash SHA', icon: icons.copy, onSelect: () => copy(c.sha, 'SHA') }
    ]
  }

  const short = shortSha(c.sha)
  const target = status.branch ?? 'HEAD'
  const isHead = c.sha === status.headSha
  const isMerge = c.parents.length > 1
  const onLine = m.linear.has(c.sha)
  const offLine = 'Only for commits on the checked-out branch, back to its most recent merge'
  const dirty = new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path)).size

  /** History edits ask first when the commit is already pushed, or always if `always`. */
  const rewrite = (action: Action, title: string, label: string, body: ReactNode, always: boolean, danger = false): void => {
    void window.api
      .isPublished(repo, c.sha)
      .catch(() => false)
      .then((published) => {
        if (!published && !always) return run(action)
        ui.confirm({
          title,
          label,
          danger,
          onConfirm: () => run(action),
          body: (
            <>
              {body}
              {published && <PublishedWarning upstream={status.upstream} />}
            </>
          )
        })
      })
  }

  const reset = (mode: ResetMode): MenuItem => ({
    label: `Reset ${target} to this commit (${mode})`,
    icon: icons.reset,
    disabled: isHead && mode !== 'hard',
    reason: `${target} is already here`,
    danger: mode === 'hard',
    onSelect: () =>
      ui.confirm({
        title: `Reset ${target} to ${short}?`,
        label: `Reset (${mode})`,
        danger: mode === 'hard',
        onConfirm: () => run({ type: 'reset', sha: c.sha, mode }),
        body: (
          <>
            <p>
              {target} will point at <code>{short}</code> “{c.subject}”. {RESET_EFFECT[mode]}
            </p>
            <p className="faint">Commits that end up on no branch can still be recovered through git reflog for a while.</p>
            {mode === 'hard' && dirty > 0 && (
              <div className="callout danger">
                <TriangleAlert size={14} />
                <span>Uncommitted changes in {plural(dirty, 'file')} will be discarded. That cannot be undone.</span>
              </div>
            )}
          </>
        )
      })
  })

  return [
    { label: 'Checkout this commit', icon: icons.checkout, onSelect: () => run({ type: 'checkoutDetached', sha: c.sha }), disabled: isHead, reason: 'Already checked out' },
    'separator',
    { label: 'Create worktree from this commit…', icon: icons.worktree, onSelect: () => ui.worktree(c.sha) },
    'separator',
    { label: 'Create branch here…', icon: icons.branch, onSelect: () => ui.branch(c.sha) },
    { label: 'Cherry pick commit', icon: icons.cherryPick, onSelect: () => run({ type: 'cherryPick', sha: c.sha }), disabled: onLine || isHead, reason: `Already part of ${target}` },
    {
      label: `Rebase ${target} onto this commit`,
      icon: icons.rebase,
      disabled: isHead,
      reason: `${target} is already here`,
      onSelect: () =>
        ui.confirm({
          title: `Rebase ${target} onto ${short}?`,
          label: 'Rebase',
          onConfirm: () => run({ type: 'rebaseOnto', sha: c.sha }),
          body: (
            <>
              <p>
                The commits on {target} that are not part of <code>{short}</code> will be re-created on top of it.
              </p>
              <p className="faint">If any of them have been pushed, the branch will need a force-push afterwards. A rebase that hits a conflict is undone.</p>
            </>
          )
        })
    },
    reset('soft'),
    reset('mixed'),
    reset('hard'),
    { label: 'Revert commit', icon: icons.revert, onSelect: () => run({ type: 'revert', sha: c.sha }) },
    'separator',
    { label: 'Edit commit message…', icon: icons.edit, onSelect: () => ui.reword(c.sha), disabled: !onLine && !isHead, reason: offLine },
    {
      label: 'Drop commit',
      icon: icons.remove,
      danger: true,
      disabled: !onLine || isMerge || c.parents.length === 0,
      reason: c.parents.length === 0 ? 'The first commit cannot be dropped' : offLine,
      onSelect: () =>
        rewrite(
          { type: 'drop', sha: c.sha },
          `Drop ${short}?`,
          'Drop commit',
          <p>
            “{c.subject}” will be removed from {target}, along with its changes. Later commits are kept. If they depend on it, the drop is undone.
          </p>,
          true,
          true
        )
    },
    {
      label: 'Move commit up',
      icon: icons.up,
      disabled: !onLine || isHead,
      reason: isHead ? 'Already the newest commit' : offLine,
      onSelect: () => rewrite({ type: 'move', sha: c.sha, direction: 'up' }, `Move ${short} up?`, 'Move commit', <p>“{c.subject}” will trade places with the commit after it.</p>, false)
    },
    {
      label: 'Move commit down',
      icon: icons.down,
      disabled: !onLine || isMerge || !m.linear.has(c.parents[0]),
      reason: offLine,
      onSelect: () =>
        rewrite({ type: 'move', sha: c.sha, direction: 'down' }, `Move ${short} down?`, 'Move commit', <p>“{c.subject}” will trade places with the commit before it.</p>, false)
    },
    'separator',
    { label: 'Copy commit SHA', icon: icons.copy, onSelect: () => copy(c.sha, 'SHA') },
    {
      label: snap.remoteWeb ? `Copy link to this commit on remote: ${snap.remoteWeb.remote}` : 'Copy link to this commit on remote',
      icon: icons.link,
      disabled: !snap.remoteWeb,
      reason: 'No remote with a web address',
      onSelect: () => snap.remoteWeb && copy(`${snap.remoteWeb.base}${snap.remoteWeb.commitPath}${c.sha}`, 'link')
    },
    {
      label: 'Create patch from commit…',
      icon: icons.diff,
      onSelect: () =>
        void window.api
          .savePatch(repo, c.sha)
          .then((saved) => saved && m.setNotice({ kind: 'info', text: `Saved patch to ${saved}` }))
          .catch((e) => m.setNotice({ kind: 'error', text: e instanceof Error ? e.message : String(e) }))
    },
    'separator',
    { label: 'Create tag here…', icon: icons.tag, onSelect: () => ui.tag(c.sha) }
  ]
}

/** What right-clicking a branch offers, in the sidebar or on its label in the graph. */
export function refMenu(ref: Ref, m: RepoModel, ui: MenuUi): MenuItem[] {
  const copyName: MenuItem = {
    label: 'Copy branch name',
    icon: icons.copy,
    onSelect: () => {
      void window.api.copyText(ref.short)
      m.setNotice({ kind: 'info', text: 'Copied branch name' })
    }
  }
  if (ref.kind === 'head') {
    const elsewhere = !ref.isHead && ref.worktreePath
    const held = ref.isHead ? 'It is checked out. Check out another branch first.' : `It is checked out in ${ref.worktreePath}`
    return [
      { label: `Checkout ${ref.short}`, icon: icons.checkout, onSelect: () => void m.run({ type: 'checkout', branch: ref.short }), disabled: Boolean(ref.isHead || elsewhere), reason: held },
      copyName,
      'separator',
      { label: `Delete ${ref.short}…`, icon: icons.remove, danger: true, onSelect: () => ui.deleteBranch(ref), disabled: Boolean(ref.isHead || elsewhere), reason: held }
    ]
  }
  if (ref.kind === 'remote') {
    return [
      { label: `Checkout ${ref.short}`, icon: icons.checkout, onSelect: () => void m.run({ type: 'checkoutRemote', remoteBranch: ref.short }) },
      copyName,
      'separator',
      {
        label: `Delete ${ref.short} from remote…`,
        icon: icons.remove,
        danger: true,
        onSelect: () => ui.deleteBranch(ref),
        disabled: Boolean(ref.isDefault),
        reason: `It is the default branch of ${ref.remote}`
      }
    ]
  }
  return []
}

const folderName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * What right-clicking a worktree offers.
 * @param changes its uncommitted-change count, when that has been checked
 * @param missing how many worktrees have lost their folder
 */
export function worktreeMenu(tree: Worktree, changes: number | undefined, missing: number, m: RepoModel, ui: MenuUi, onOpen: (path: string) => void): MenuItem[] {
  const blocked = tree.isMain
    ? 'The main working tree cannot be removed'
    : tree.isCurrent
      ? 'This is the worktree you are looking at. Remove it from another one.'
      : tree.prunable
        ? 'Its folder is already gone. Prune missing worktrees instead.'
        : tree.locked
          ? 'It is locked'
          : changes
            ? `It has ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}. Commit, stash or discard them first.`
            : undefined
  const items: MenuItem[] = [
    {
      label: 'Open in a new tab',
      icon: icons.openTab,
      onSelect: () => onOpen(tree.path),
      disabled: tree.isCurrent || tree.bare || tree.prunable,
      reason: tree.isCurrent ? 'Already open in this tab' : 'There is no folder to open'
    },
    { label: 'Reveal in Finder', icon: icons.reveal, onSelect: () => void window.api.showInFinder(tree.path), disabled: tree.prunable, reason: 'Its folder is gone' },
    {
      label: 'Copy path',
      icon: icons.copy,
      onSelect: () => {
        void window.api.copyText(tree.path)
        m.setNotice({ kind: 'info', text: 'Copied path' })
      }
    },
    'separator',
    { label: 'Remove worktree…', icon: icons.remove, danger: true, onSelect: () => ui.removeWorktree(tree), disabled: Boolean(blocked), reason: blocked }
  ]
  if (missing > 0) {
    items.push({
      label: `Prune ${missing} missing ${missing === 1 ? 'worktree' : 'worktrees'}`,
      icon: icons.prune,
      onSelect: () => void m.run({ type: 'pruneWorktrees' })
    })
  }
  return items
}

interface RemoveWorktreeDialogProps {
  repo: string
  tree: Worktree
  onClose: () => void
  onRemove: (action: Action) => Promise<boolean>
}

export function RemoveWorktreeDialog({ repo, tree, onClose, onRemove }: RemoveWorktreeDialogProps): ReactNode {
  const [alsoBranch, setAlsoBranch] = useState(false)
  const [unique, setUnique] = useState<number | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (!tree.branch) return
    let cancelled = false
    window.api
      .uniqueCommits(repo, [`refs/heads/${tree.branch}`])
      .then((n) => !cancelled && setUnique(n))
      .catch(() => !cancelled && setUnique(0))
    return () => {
      cancelled = true
    }
  }, [repo, tree.branch])

  const submit = async (): Promise<void> => {
    if (working) return
    setWorking(true)
    if (await onRemove({ type: 'removeWorktree', path: tree.path, deleteBranch: alsoBranch })) onClose()
    else setWorking(false)
  }

  return (
    <Modal title={`Remove worktree ${folderName(tree.path)}?`} onClose={onClose}>
      <div className="confirm-body">
        <p>
          The folder <code>{tree.path}</code> is deleted. It is only removed if it has no uncommitted changes.
        </p>
        {tree.branch ? (
          <label className="check">
            <input type="checkbox" checked={alsoBranch} onChange={(e) => setAlsoBranch(e.target.checked)} />
            Also delete its branch <code>{tree.branch}</code>
          </label>
        ) : (
          <p className="faint">It is a detached checkout, so there is no branch to keep or delete.</p>
        )}
        {alsoBranch &&
          unique !== null &&
          (unique > 0 ? (
            <div className="callout danger" data-lost={unique}>
              <TriangleAlert size={14} />
              <span>
                {plural(unique, 'commit')} {unique === 1 ? 'is' : 'are'} on no other branch or tag. Deleting the branch leaves {unique === 1 ? 'it' : 'them'} unreachable.
              </span>
            </div>
          ) : (
            <p className="faint" data-lost="0">
              Every commit on the branch is also on another branch or tag, so no work is lost.
            </p>
          ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary danger" disabled={working || (alsoBranch && unique === null)} onClick={() => void submit()}>
          {alsoBranch ? 'Remove worktree and branch' : 'Remove worktree'}
        </button>
      </div>
    </Modal>
  )
}

interface DeleteBranchDialogProps {
  repo: string
  target: Ref
  /** Every ref, to find the branch's same-named copy on a remote. */
  refs: Ref[]
  onClose: () => void
  onDelete: (action: Action) => Promise<boolean>
}

export function DeleteBranchDialog({ repo, target, refs, onClose, onDelete }: DeleteBranchDialogProps): ReactNode {
  const isRemote = target.kind === 'remote'
  // The copy of a local branch on a remote is the remote branch with the same name. What the
  // branch tracks is no guide: branches cut from dev track origin/dev.
  const copies = isRemote ? [] : refs.filter((r) => r.kind === 'remote' && r.remote && r.short === `${r.remote}/${target.short}` && !r.isDefault)
  const upstreamRemote = target.upstream?.slice(0, target.upstream.indexOf('/'))
  const remoteCopy = copies.find((r) => r.remote === upstreamRemote) ?? copies.find((r) => r.remote === 'origin') ?? copies[0]

  const [alsoRemote, setAlsoRemote] = useState(false)
  const [counts, setCounts] = useState<{ alone: number; both: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.uniqueCommits(repo, [target.name]),
      remoteCopy ? window.api.uniqueCommits(repo, [target.name, remoteCopy.name]) : Promise.resolve(0)
    ])
      .then(([alone, both]) => !cancelled && setCounts({ alone, both }))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [repo, target.name, remoteCopy?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const lost = counts ? (alsoRemote ? counts.both : counts.alone) : 0
  const submit = async (): Promise<void> => {
    if (working || !counts) return
    setWorking(true)
    const action: Action = isRemote
      ? { type: 'deleteRemoteBranch', remoteBranch: target.short }
      : { type: 'deleteBranch', branch: target.short, remoteBranch: alsoRemote ? remoteCopy?.short : undefined }
    if (await onDelete(action)) onClose()
    else setWorking(false)
  }

  return (
    <Modal title={isRemote ? `Delete ${target.short} from the remote?` : `Delete branch ${target.short}?`} onClose={onClose}>
      <div className="confirm-body">
        {isRemote ? (
          <p>
            This removes <code>{target.short.slice((target.remote?.length ?? 0) + 1)}</code> from <strong>{target.remote}</strong> for everyone who uses it. Local
            branches are not touched.
          </p>
        ) : (
          <p>
            This removes the local branch <code>{target.short}</code>.{!remoteCopy && ' It has no copy on a remote.'}
          </p>
        )}
        {remoteCopy && (
          <label className="check">
            <input type="checkbox" checked={alsoRemote} onChange={(e) => setAlsoRemote(e.target.checked)} />
            Also delete <code>{remoteCopy.short}</code> on the remote
          </label>
        )}
        {error && <div className="notice error inline">{error}</div>}
        {!counts && !error && <p className="faint">Checking what is only on this branch…</p>}
        {counts &&
          (lost > 0 ? (
            <div className="callout danger" data-lost={lost}>
              <TriangleAlert size={14} />
              <span>
                {plural(lost, 'commit')} {lost === 1 ? 'is' : 'are'} on no other branch or tag. Deleting leaves {lost === 1 ? 'it' : 'them'} unreachable.
              </span>
            </div>
          ) : (
            <p className="faint" data-lost="0">
              Every commit on it is also on another branch or tag, so no work is lost.
            </p>
          ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary danger" disabled={!counts || working} onClick={() => void submit()}>
          {isRemote ? 'Delete from remote' : alsoRemote ? 'Delete local and remote' : 'Delete branch'}
        </button>
      </div>
    </Modal>
  )
}

interface TagDialogProps {
  sha: string
  canPush: boolean
  onClose: () => void
  onCreate: (name: string, message: string, push: boolean) => Promise<boolean>
}

export function TagDialog({ sha, canPush, onClose, onCreate }: TagDialogProps): ReactNode {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [push, setPush] = useState(false)
  const [working, setWorking] = useState(false)

  const create = async (): Promise<void> => {
    if (!name.trim() || working) return
    setWorking(true)
    if (await onCreate(name.trim(), message, push)) onClose()
    else setWorking(false)
  }

  return (
    <Modal title={`Create tag at ${shortSha(sha)}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.2.0" spellCheck={false} aria-label="Tag name" />
        </label>
        <label className="field">
          <span>Message (optional; adding one makes it an annotated tag)</span>
          <textarea className="message-edit" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Tag message" />
        </label>
        {canPush && (
          <label className="check">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
            Push the tag to the remote (a normal push does not send tags)
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || working}>
            Create tag
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** What right-clicking a changed file offers. */
export function fileMenu(f: OpenFile, m: RepoModel, repo: string): MenuItem[] {
  const open = (view: OpenFile['view']): void => m.setOpenFile({ change: f.change, source: f.source, view })
  const deleted = f.change.status === 'D'
  const items: MenuItem[] = [
    { label: 'Open diff', icon: icons.diff, onSelect: () => open('diff') },
    { label: 'File history', icon: icons.history, onSelect: () => open('history') },
    { label: 'Blame', icon: icons.blame, onSelect: () => open('blame') }
  ]
  if (f.source === 'unstaged') {
    items.push('separator', { label: 'Stage file', icon: icons.stage, onSelect: () => void m.run({ type: 'stage', paths: [f.change.path] }) })
  } else if (f.source === 'staged') {
    const paths = f.change.oldPath ? [f.change.path, f.change.oldPath] : [f.change.path]
    items.push('separator', { label: 'Unstage file', icon: icons.unstage, onSelect: () => void m.run({ type: 'unstage', paths }) })
  }
  items.push(
    'separator',
    {
      label: 'Copy path',
      icon: icons.copy,
      onSelect: () => {
        void window.api.copyText(f.change.path)
        m.setNotice({ kind: 'info', text: 'Copied path' })
      }
    },
    {
      label: 'Reveal in Finder',
      icon: icons.reveal,
      disabled: deleted,
      reason: 'The file no longer exists',
      onSelect: () => void window.api.showInFinder(`${repo}/${f.change.path.replace(/\/$/, '')}`)
    }
  )
  return items
}

interface RewordDialogProps {
  repo: string
  sha: string
  upstream?: string
  onClose: () => void
  onSave: (message: string) => Promise<boolean>
}

export function RewordDialog({ repo, sha, upstream, onClose, onSave }: RewordDialogProps): ReactNode {
  const [message, setMessage] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [published, setPublished] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .commitDetail(repo, sha, false)
      .then((d) => {
        if (cancelled) return
        setMessage(d.message)
        setOriginal(d.message)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    window.api
      .isPublished(repo, sha)
      .then((p) => !cancelled && setPublished(p))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repo, sha])

  const changed = message !== null && message.trim() !== '' && message.trim() !== original.trim()
  const save = async (): Promise<void> => {
    if (!changed || working || message === null) return
    setWorking(true)
    if (await onSave(message)) onClose()
    else setWorking(false)
  }

  return (
    <Modal title={`Edit message of ${shortSha(sha)}`} onClose={onClose}>
      {error && <div className="notice error inline">{error}</div>}
      <textarea
        className="message-edit"
        autoFocus
        rows={8}
        value={message ?? ''}
        disabled={message === null}
        onChange={(e) => setMessage(e.target.value)}
        aria-label="Commit message"
        spellCheck
      />
      {published && <PublishedWarning upstream={upstream} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!changed || working} onClick={() => void save()}>
          Save message
        </button>
      </div>
    </Modal>
  )
}

interface WorktreeDialogProps {
  repoPath: string
  sha: string
  onClose: () => void
  onCreate: (path: string, branch: string, open: boolean) => Promise<boolean>
}

export function WorktreeDialog({ repoPath, sha, onClose, onCreate }: WorktreeDialogProps): ReactNode {
  const slash = repoPath.lastIndexOf('/')
  const parent = repoPath.slice(0, slash)
  const name = repoPath.slice(slash + 1)
  const suggest = (branch: string): string => `${parent}/${name}-${branch.trim().replace(/[^\w.-]+/g, '-') || shortSha(sha)}`

  const [branch, setBranch] = useState('')
  const [path, setPath] = useState(() => suggest(''))
  // The folder follows the branch name until the folder is edited by hand.
  const [pathEdited, setPathEdited] = useState(false)
  const [open, setOpen] = useState(true)
  const [working, setWorking] = useState(false)

  const create = async (): Promise<void> => {
    if (!path.trim() || working) return
    setWorking(true)
    if (await onCreate(path.trim(), branch.trim(), open)) onClose()
    else setWorking(false)
  }

  return (
    <Modal title={`Create worktree from ${shortSha(sha)}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="field">
          <span>New branch (leave empty for a detached checkout)</span>
          <input
            autoFocus
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value)
              if (!pathEdited) setPath(suggest(e.target.value))
            }}
            placeholder="feature/my-branch"
            spellCheck={false}
            aria-label="Worktree branch name"
          />
        </label>
        <label className="field">
          <span>Folder</span>
          <div className="field-row">
            <input
              value={path}
              onChange={(e) => {
                setPath(e.target.value)
                setPathEdited(true)
              }}
              spellCheck={false}
              aria-label="Worktree folder"
            />
            <button
              type="button"
              className="btn"
              onClick={() =>
                void window.api.pickNewFolder(path).then((picked) => {
                  if (!picked) return
                  setPath(picked)
                  setPathEdited(true)
                })
              }
            >
              Choose…
            </button>
          </div>
        </label>
        <label className="check">
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
          Open it in a new tab
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!path.trim() || working}>
            Create worktree
          </button>
        </div>
      </form>
    </Modal>
  )
}
