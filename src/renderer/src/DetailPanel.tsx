import { Archive, ChevronDown, Copy, Ellipsis, GitBranch, GitCommitHorizontal, Minus, Plus, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Action, Commit, CommitDetail, FileChange } from '../../shared/types'
import { fullDate, plural, shortSha, splitPath } from './format'
import { Spinner, menuBelow } from './ui'
import type { FileSource, LoadedSnapshot, OpenFile, Pill } from './useRepo'

const STATUS_TITLE: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked'
}

interface FileListProps {
  files: FileChange[]
  source: FileSource
  openFile: OpenFile | null
  onOpen: (f: OpenFile) => void
  /** Right-click, or the row's "more" button. */
  onMenu: (f: OpenFile, x: number, y: number) => void
  /** A per-row button, e.g. stage or unstage. */
  rowAction?: { label: string; icon: ReactNode; run: (f: FileChange) => void; disabled?: boolean }
}

/** Beyond this the list is a symptom (an unignored build folder), not something to read. */
const MAX_FILES = 1000

function FileList({ files, source, openFile, onOpen, onMenu, rowAction }: FileListProps): ReactNode {
  return (
    <div className="file-list" role="list">
      {files.length > MAX_FILES && (
        <div className="side-empty">
          Showing the first {MAX_FILES.toLocaleString()} of {files.length.toLocaleString()} files.
        </div>
      )}
      {files.slice(0, MAX_FILES).map((f) => {
        const [dir, base] = splitPath(f.path)
        const open = openFile?.source === source && openFile.change.path === f.path
        return (
          <div
            key={f.path}
            role="listitem"
            className={`file-row ${open ? 'open' : ''}`}
            onClick={() => onOpen({ change: f, source })}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu({ change: f, source }, e.clientX, e.clientY)
            }}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          >
            <span className={`status status-${f.status === '?' ? 'untracked' : f.status}`} title={STATUS_TITLE[f.status]}>
              {f.status}
            </span>
            <span className="file-name">
              <span className="file-dir">{dir}</span>
              <span className="file-base">{base}</span>
            </span>
            {f.binary ? (
              <span className="stat">bin</span>
            ) : (
              <span className="stat">
                {f.added ? <span className="plus">+{f.added}</span> : null}
                {f.deleted ? <span className="minus">−{f.deleted}</span> : null}
              </span>
            )}
            <button
              className="icon-btn file-more"
              title={`More for ${base}: history, blame…`}
              aria-label={`More actions for ${f.path}`}
              onClick={(e) => {
                e.stopPropagation()
                const at = menuBelow(e.currentTarget)
                onMenu({ change: f, source }, at.x, at.y)
              }}
            >
              <Ellipsis size={14} />
            </button>
            {rowAction && (
              <button
                className="icon-btn"
                title={`${rowAction.label} ${base}`}
                aria-label={`${rowAction.label} ${f.path}`}
                disabled={rowAction.disabled}
                onClick={(e) => {
                  e.stopPropagation()
                  rowAction.run(f)
                }}
              >
                {rowAction.icon}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function totals(files: FileChange[]): ReactNode {
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0)
  return (
    <span className="stat">
      {added > 0 && <span className="plus">+{added}</span>}
      {deleted > 0 && <span className="minus">−{deleted}</span>}
    </span>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [done, setDone] = useState(false)
  return (
    <button
      className="icon-btn"
      title={done ? 'Copied' : label}
      aria-label={label}
      onClick={() => {
        void window.api.copyText(text)
        setDone(true)
        window.setTimeout(() => setDone(false), 1200)
      }}
    >
      <Copy size={13} />
      {done && <span className="copied">Copied</span>}
    </button>
  )
}

interface CommitPanelProps {
  commit: Commit
  detail: CommitDetail | null
  pills: Pill[] | undefined
  isHead: boolean
  busy: boolean
  openFile: OpenFile | null
  onOpen: (f: OpenFile) => void
  onReveal: (sha: string) => void
  onAction: (action: Action) => void
  onBranchHere: (sha: string) => void
  onFileMenu: (f: OpenFile, x: number, y: number) => void
  /** Open the same menu a right-click on the commit gives. */
  onMore: (x: number, y: number) => void
}

export function CommitPanel(p: CommitPanelProps): ReactNode {
  const { commit: c, detail: d } = p
  const body = d ? d.message.slice(d.message.indexOf('\n') + 1).trim() : ''
  const hasBody = d ? d.message.includes('\n') && body.length > 0 : false
  const committerDiffers = d && (d.committer !== d.author || d.committerEmail !== d.email)
  const stashIndex = p.pills?.find((x) => x.kind === 'stash')

  return (
    <div className="detail">
      <div className="detail-scroll">
        <header className="detail-head">
          <div className="kicker">
            {c.isStash ? <Archive size={13} /> : <GitCommitHorizontal size={13} />}
            {c.isStash ? 'Stash' : c.parents.length > 1 ? 'Merge commit' : 'Commit'}
            <code>{shortSha(c.sha)}</code>
            <CopyButton text={c.sha} label="Copy full SHA" />
          </div>
          <h2 className="subject">{c.subject}</h2>
          {hasBody && <pre className="body">{body}</pre>}
          {p.pills && (
            <div className="detail-pills">
              {p.pills.map((pill) => (
                <span key={pill.key} className={`chip ${pill.isHead ? 'head' : ''}`}>
                  {pill.label}
                </span>
              ))}
            </div>
          )}
        </header>

        <dl className="meta">
          <dt>Author</dt>
          <dd>
            {c.author} <span className="faint">{c.email}</span>
          </dd>
          <dt>Date</dt>
          <dd>{fullDate(d ? d.authorDate : c.time)}</dd>
          {committerDiffers && (
            <>
              <dt>Committer</dt>
              <dd>
                {d.committer} <span className="faint">{fullDate(d.commitDate)}</span>
              </dd>
            </>
          )}
          <dt>{c.parents.length === 1 ? 'Parent' : 'Parents'}</dt>
          <dd>
            {c.parents.length === 0 && <span className="faint">none (root commit)</span>}
            {c.parents.map((sha) => (
              <button key={sha} className="link mono" onClick={() => p.onReveal(sha)} title="Go to parent">
                {shortSha(sha)}
              </button>
            ))}
          </dd>
        </dl>

        {!c.isStash && (
          <div className="detail-actions">
            <button className="btn" disabled={p.busy} onClick={() => p.onBranchHere(c.sha)}>
              <GitBranch size={13} /> Branch here
            </button>
            {!p.isHead && (
              <button className="btn" disabled={p.busy} onClick={() => p.onAction({ type: 'checkoutDetached', sha: c.sha })} title="Check out this commit with a detached HEAD">
                Check out commit
              </button>
            )}
            <button
              className="btn"
              data-more="commit"
              title="Cherry-pick, revert, reset, edit message, copy link…"
              onClick={(e) => {
                const at = menuBelow(e.currentTarget)
                p.onMore(at.x, at.y)
              }}
            >
              More <ChevronDown size={13} />
            </button>
          </div>
        )}
        {c.isStash && stashIndex && (
          <div className="detail-actions">
            <button
              className="btn"
              disabled={p.busy}
              onClick={() => p.onAction({ type: 'stashPop', index: Number(/\d+/.exec(stashIndex.label)?.[0] ?? 0) })}
            >
              Pop this stash
            </button>
          </div>
        )}

        <div className="files-head">
          <span>{d ? plural(d.files.length, 'file') + ' changed' : 'Files'}</span>
          {d && d.files.length > 0 && totals(d.files)}
        </div>
        {!d && (
          <div className="pending">
            <Spinner />
          </div>
        )}
        {d && d.files.length === 0 && <div className="side-empty">No file changes{c.parents.length > 1 ? ' against the first parent' : ''}.</div>}
        {d && <FileList files={d.files} source="commit" openFile={p.openFile} onOpen={p.onOpen} onMenu={p.onFileMenu} />}
      </div>
    </div>
  )
}

interface WipPanelProps {
  snap: LoadedSnapshot
  busy: boolean
  openFile: OpenFile | null
  onOpen: (f: OpenFile) => void
  onAction: (action: Action) => Promise<boolean>
  onFileMenu: (f: OpenFile, x: number, y: number) => void
}

export function WipPanel({ snap, busy, openFile, onOpen, onAction, onFileMenu }: WipPanelProps): ReactNode {
  const { status } = snap
  const [message, setMessage] = useState('')
  const canCommit = status.staged.length > 0 && message.trim().length > 0 && !busy && status.conflicted.length === 0

  const commit = async (): Promise<void> => {
    if (await onAction({ type: 'commit', message })) setMessage('')
  }

  return (
    <div className="detail">
      <div className="detail-scroll">
        <header className="detail-head">
          <div className="kicker">Working tree</div>
          <h2 className="subject">Uncommitted changes</h2>
          <div className="faint">
            on {status.branch ?? (status.headSha ? `detached HEAD at ${shortSha(status.headSha)}` : 'a branch with no commits yet')}
          </div>
        </header>

        {status.operation && (
          <div className="callout">
            <TriangleAlert size={14} />
            <span>
              A {status.operation} is in progress. Finish or abort it from the command line before committing here.
            </span>
          </div>
        )}

        {status.conflicted.length > 0 && (
          <>
            <div className="files-head">
              <span>{plural(status.conflicted.length, 'conflicted file')}</span>
            </div>
            <FileList files={status.conflicted} source="unstaged" openFile={openFile} onOpen={onOpen} onMenu={onFileMenu} />
          </>
        )}

        <div className="files-head" data-list="unstaged">
          <span>Unstaged · {status.unstaged.length}</span>
          <button className="btn small" disabled={busy || status.unstaged.length === 0} onClick={() => void onAction({ type: 'stageAll' })}>
            Stage all
          </button>
        </div>
        {status.unstaged.length === 0 && <div className="side-empty">Nothing unstaged.</div>}
        <FileList
          files={status.unstaged}
          source="unstaged"
          openFile={openFile}
          onOpen={onOpen}
          onMenu={onFileMenu}
          rowAction={{ label: 'Stage', icon: <Plus size={14} />, disabled: busy, run: (f) => void onAction({ type: 'stage', paths: [f.path] }) }}
        />

        <div className="files-head" data-list="staged">
          <span>Staged · {status.staged.length}</span>
          <button className="btn small" disabled={busy || status.staged.length === 0} onClick={() => void onAction({ type: 'unstageAll' })}>
            Unstage all
          </button>
        </div>
        {status.staged.length === 0 && <div className="side-empty">Stage files to include them in a commit.</div>}
        <FileList
          files={status.staged}
          source="staged"
          openFile={openFile}
          onOpen={onOpen}
          onMenu={onFileMenu}
          rowAction={{
            label: 'Unstage',
            icon: <Minus size={14} />,
            disabled: busy,
            run: (f) => void onAction({ type: 'unstage', paths: f.oldPath ? [f.path, f.oldPath] : [f.path] })
          }}
        />
      </div>

      <div className="commit-box">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          aria-label="Commit message"
          rows={3}
          spellCheck
        />
        <button className="btn primary wide" disabled={!canCommit} onClick={() => void commit()}>
          {busy ? <Spinner /> : null}
          {status.staged.length > 0 ? `Commit ${plural(status.staged.length, 'file')}` : 'Commit'}
        </button>
      </div>
    </div>
  )
}
