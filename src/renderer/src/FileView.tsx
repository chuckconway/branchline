import { ArrowLeft, ChevronLeft, ChevronRight, Columns2, Rows3 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseDiff, toSplitRows, type DiffLine, type FileDiff } from '../../shared/diff'
import type { Blame, DiffSpec, FileChange, FileHistoryEntry } from '../../shared/types'
import { fullDate, shortDate, shortSha, splitPath } from './format'
import { highlightBlock, highlightHunk, languageFor, splitAtMark, type Token } from './highlight'
import { Spinner, useStored } from './ui'
import type { FileViewMode, OpenFile } from './useRepo'

const MAX_LINES = 4000
const MAX_HIGHLIGHT_LINES = 6000

type DiffMode = 'unified' | 'split'

function specFor(file: OpenFile): DiffSpec | null {
  const { change: c, source } = file
  if (source === 'commit') {
    if (!c.range) return null
    return { kind: 'range', from: c.range[0], to: c.range[1], path: c.path, oldPath: c.oldPath }
  }
  if (source === 'staged') return { kind: 'staged', path: c.path, oldPath: c.oldPath }
  return { kind: 'unstaged', path: c.path, oldPath: c.oldPath, untracked: c.status === '?' }
}

function Tokens({ tokens }: { tokens: Token[] }): ReactNode {
  return <>{tokens.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : t.text))}</>
}

function Code({ line, tokens }: { line: DiffLine; tokens: Token[] | undefined }): ReactNode {
  const base = tokens ?? [{ text: line.text, cls: '' }]
  if (!line.mark) return <Tokens tokens={base} />
  return (
    <>
      {splitAtMark(base, line.mark).map(({ token, marked }, i) => (
        <span key={i} className={`${token.cls} ${marked ? 'changed' : ''}`}>
          {token.text}
        </span>
      ))}
    </>
  )
}

/** Run an async load keyed by `key`, ignoring results that arrive after the key changed. */
function useLoad<T>(key: string, load: (() => Promise<T>) | null): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key: '', data: null, error: null })
  useEffect(() => {
    if (!load) return
    let cancelled = false
    load()
      .then((data) => !cancelled && setState({ key, data, error: null }))
      .catch((e) => !cancelled && setState({ key, data: null, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
    // `key` identifies what `load` fetches.
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = state.key === key
  return { data: current ? state.data : null, error: current ? state.error : null, loading: Boolean(load) && !current }
}

interface DiffBodyProps {
  repo: string
  spec: DiffSpec | null
  /** Path used to pick the syntax highlighter. */
  path: string
  mode: DiffMode
  /** Changes whenever the diff should be fetched again. */
  version?: string
}

/** The hunks of one file's diff. */
function DiffBody({ repo, spec, path, mode, version = '' }: DiffBodyProps): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const specKey = JSON.stringify(spec)
  const { data: diff, error, loading } = useLoad<FileDiff>(
    `${specKey}|${version}`,
    spec ? () => window.api.diff(repo, spec).then(parseDiff) : null
  )
  useEffect(() => setShowAll(false), [specKey])

  const tokens = useMemo(() => {
    const map = new Map<DiffLine, Token[]>()
    if (!diff || diff.lineCount > MAX_HIGHLIGHT_LINES) return map
    const lang = languageFor(path)
    for (const h of diff.hunks) for (const [line, t] of highlightHunk(h, lang)) map.set(line, t)
    return map
  }, [diff, path])

  const truncated = diff !== null && !showAll && diff.lineCount > MAX_LINES
  let budget = showAll ? Infinity : MAX_LINES

  return (
    <div className={`diff-scroll ${mode}`}>
      {error && <div className="diff-note error">{error}</div>}
      {loading && (
        <div className="pending">
          <Spinner />
        </div>
      )}
      {diff?.notes.map((n) => (
        <div key={n} className="diff-note">
          {n}
        </div>
      ))}
      {diff?.binary && <div className="diff-note">Binary file. No text diff to show.</div>}
      {diff && !diff.binary && diff.hunks.length === 0 && diff.notes.length === 0 && <div className="diff-note">No content changes.</div>}

      {diff?.hunks.map((hunk, hi) => {
        if (budget <= 0) return null
        const lines = hunk.lines.slice(0, budget)
        budget -= lines.length
        return (
          <div className="hunk" key={hi}>
            <div className="hunk-head">{hunk.header}</div>
            {mode === 'unified'
              ? lines.map((line, i) => (
                  <div className={`dl ${line.type}`} key={i}>
                    <span className="ln">{line.oldNo ?? ''}</span>
                    <span className="ln">{line.newNo ?? ''}</span>
                    <span className="sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}</span>
                    <span className="code">
                      <Code line={line} tokens={tokens.get(line)} />
                    </span>
                  </div>
                ))
              : toSplitRows(lines).map((row, i) => (
                  <div className="sr" key={i}>
                    <div className={`half ${row.left ? row.left.type : 'empty'}`}>
                      <span className="ln">{row.left?.oldNo ?? ''}</span>
                      <span className="code">{row.left && <Code line={row.left} tokens={tokens.get(row.left)} />}</span>
                    </div>
                    <div className={`half ${row.right ? row.right.type : 'empty'}`}>
                      <span className="ln">{row.right?.newNo ?? ''}</span>
                      <span className="code">{row.right && <Code line={row.right} tokens={tokens.get(row.right)} />}</span>
                    </div>
                  </div>
                ))}
          </div>
        )
      })}

      {truncated && diff && (
        <div className="diff-note">
          Showing the first {MAX_LINES.toLocaleString()} of {diff.lineCount.toLocaleString()} lines.{' '}
          <button className="btn small" onClick={() => setShowAll(true)}>
            Show everything
          </button>
        </div>
      )}
    </div>
  )
}

/** Which revision and path to ask git about for a file opened from a commit or the working tree. */
function revisionOf(file: OpenFile, headSha: string | null): { rev: string | null; path: string } | null {
  const { change: c, source } = file
  if (c.path.endsWith('/')) return null
  if (source === 'commit') {
    if (!c.range) return null
    // A deleted file only exists on the parent's side.
    return c.status === 'D' ? { rev: c.range[0], path: c.path } : { rev: c.range[1], path: c.path }
  }
  if (c.status === '?' || (c.status === 'A' && source === 'staged')) return null
  if (c.status === 'D') return headSha ? { rev: headSha, path: c.path } : null
  return { rev: null, path: c.oldPath ?? c.path }
}

const NOT_COMMITTED = 'This file has not been committed yet, so it has no history.'

interface HistoryProps {
  repo: string
  file: OpenFile
  headSha: string | null
  mode: DiffMode
  selected: string | null
  onPeek: (sha: string) => void
}

function HistoryView({ repo, file, headSha, mode, selected, onPeek }: HistoryProps): ReactNode {
  const target = revisionOf(file, headSha)
  // History of an uncommitted file starts at HEAD.
  const rev = target ? (target.rev ?? headSha) : null
  const key = target ? `history|${rev}|${target.path}` : ''
  const { data, error, loading } = useLoad<FileHistoryEntry[]>(key, target ? () => window.api.fileHistory(repo, rev, target.path) : null)
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => setPicked(null), [key])

  if (!target) return <div className="diff-note">{NOT_COMMITTED}</div>
  const entries = data ?? []
  const current = entries.find((e) => e.commit.sha === picked) ?? entries.find((e) => e.commit.sha === selected) ?? entries[0]
  const spec: DiffSpec | null = current?.change.range
    ? { kind: 'range', from: current.change.range[0], to: current.change.range[1], path: current.change.path, oldPath: current.change.oldPath }
    : null

  return (
    <div className="history">
      <div className="history-list" role="list" aria-label="Commits that changed this file">
        {error && <div className="diff-note error">{error}</div>}
        {loading && (
          <div className="pending">
            <Spinner />
          </div>
        )}
        {data && entries.length === 0 && <div className="diff-note">No commits found for this file.</div>}
        {entries.map((e) => (
          <div
            key={e.commit.sha}
            role="listitem"
            className={`history-row ${e === current ? 'active' : ''}`}
            onClick={() => {
              setPicked(e.commit.sha)
              onPeek(e.commit.sha)
            }}
            title={e.change.oldPath ? `${e.change.oldPath} → ${e.change.path}` : e.change.path}
          >
            <div className="history-subject">
              <span className={`status status-${e.change.status}`}>{e.change.status}</span>
              <span>{e.commit.subject}</span>
            </div>
            <div className="history-meta">
              {e.commit.author} · <span title={fullDate(e.commit.time)}>{shortDate(e.commit.time)}</span> · <code>{shortSha(e.commit.sha)}</code>
            </div>
            {e.change.oldPath && <div className="history-meta">renamed from {e.change.oldPath}</div>}
          </div>
        ))}
      </div>
      {current && <DiffBody repo={repo} spec={spec} path={current.change.path} mode={mode} />}
    </div>
  )
}

interface BlameProps {
  repo: string
  file: OpenFile
  headSha: string | null
  version: string
  selected: string | null
  onPeek: (sha: string) => void
}

function BlameView({ repo, file, headSha, version, selected, onPeek }: BlameProps): ReactNode {
  const target = revisionOf(file, headSha)
  const [showAll, setShowAll] = useState(false)
  const live = target && target.rev === null ? version : ''
  const key = target ? `blame|${target.rev}|${target.path}|${live}` : ''
  const { data, error, loading } = useLoad<Blame>(key, target ? () => window.api.blame(repo, target.rev, target.path) : null)

  const tokens = useMemo(() => {
    if (!data || data.lines.length > MAX_HIGHLIGHT_LINES) return null
    const lang = languageFor(file.change.path)
    return lang ? highlightBlock(data.lines.map((l) => l.text), lang) : null
  }, [data, file.change.path])

  if (!target) return <div className="diff-note">{NOT_COMMITTED}</div>
  if (file.change.binary) return <div className="diff-note">Binary file. There are no lines to blame.</div>

  const lines = data ? (showAll ? data.lines : data.lines.slice(0, MAX_LINES)) : []
  let stripe = false

  return (
    <div className="diff-scroll blame">
      {error && <div className="diff-note error">{error}</div>}
      {loading && (
        <div className="pending">
          <Spinner />
        </div>
      )}
      {lines.map((line, i) => {
        const first = i === 0 || lines[i - 1].sha !== line.sha
        if (first) stripe = !stripe
        const meta = data!.commits[line.sha]
        const uncommitted = /^0+$/.test(line.sha)
        return (
          <div key={i} className={`bl ${stripe ? 'stripe' : ''} ${first ? 'first' : ''} ${line.sha === selected ? 'active' : ''}`} data-sha={line.sha}>
            <button
              className="blame-who"
              disabled={uncommitted}
              onClick={() => onPeek(line.sha)}
              title={uncommitted ? 'Not committed yet' : `${meta?.summary}\n${meta?.author} · ${fullDate(meta?.time ?? 0)}\nClick to show this commit`}
            >
              {first &&
                (uncommitted ? (
                  <span className="blame-summary">Not committed yet</span>
                ) : (
                  <>
                    <code>{shortSha(line.sha)}</code>
                    <span className="blame-summary">{meta?.summary}</span>
                    <span className="blame-date">{shortDate(meta?.time ?? 0)}</span>
                  </>
                ))}
            </button>
            <span className="ln">{i + 1}</span>
            <span className="code">{tokens ? <Tokens tokens={tokens[i]} /> : line.text}</span>
          </div>
        )
      })}
      {data && !showAll && data.lines.length > MAX_LINES && (
        <div className="diff-note">
          Showing the first {MAX_LINES.toLocaleString()} of {data.lines.length.toLocaleString()} lines.{' '}
          <button className="btn small" onClick={() => setShowAll(true)}>
            Show everything
          </button>
        </div>
      )}
    </div>
  )
}

interface FileViewProps {
  repo: string
  file: OpenFile
  /** The list the file came from, for previous/next. */
  siblings: FileChange[]
  /** Changes when the working tree does, so an open working-tree view stays current. */
  version: string
  headSha: string | null
  selected: string | null
  onOpen: (f: OpenFile) => void
  onClose: () => void
  /** Show a commit in the graph and details panel while leaving this view open. */
  onPeek: (sha: string) => void
}

const VIEWS: { id: FileViewMode; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'history', label: 'History' },
  { id: 'blame', label: 'Blame' }
]

/** One file, seen as its diff, its history, or its blame. Covers the graph while open. */
export function FileView({ repo, file, siblings, version, headSha, selected, onOpen, onClose, onPeek }: FileViewProps): ReactNode {
  const [mode, setMode] = useStored<DiffMode>('diff.mode', 'unified')
  const view = file.view ?? 'diff'
  // git reports an untracked folder it will not descend into (a nested repository) as "dir/".
  const isFolder = file.change.path.endsWith('/')
  const spec = useMemo(() => (isFolder ? null : specFor(file)), [file, isFolder])

  const index = siblings.findIndex((f) => f.path === file.change.path)
  const go = (delta: number): void => {
    const next = siblings[index + delta]
    if (next) onOpen({ change: next, source: file.source, view })
  }
  const [dir, base] = splitPath(file.change.path)

  return (
    <div className="diff-pane">
      <div className="diff-bar">
        <button className="btn" onClick={onClose}>
          <ArrowLeft size={14} /> Graph
        </button>
        <div className="diff-title" title={file.change.path}>
          <span className={`status status-${file.change.status === '?' ? 'untracked' : file.change.status}`}>{file.change.status}</span>
          <span className="file-dir">{dir}</span>
          <strong>{base}</strong>
          {file.change.oldPath && <span className="faint"> ← {file.change.oldPath}</span>}
          {file.source !== 'commit' && <span className="chip">{file.source}</span>}
        </div>
        <div className="seg" role="group" aria-label="File view">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => onOpen({ ...file, view: v.id })} data-view={v.id}>
              {v.label}
            </button>
          ))}
        </div>
        {view !== 'blame' && (
          <div className="seg" role="group" aria-label="Diff layout">
            <button className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')} title="Unified view">
              <Rows3 size={14} /> Unified
            </button>
            <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')} title="Side-by-side view">
              <Columns2 size={14} /> Split
            </button>
          </div>
        )}
        <div className="seg" role="group" aria-label="File navigation">
          <button disabled={index <= 0} onClick={() => go(-1)} title="Previous file">
            <ChevronLeft size={14} />
          </button>
          <span className="seg-label">
            {index + 1} / {siblings.length}
          </span>
          <button disabled={index === -1 || index >= siblings.length - 1} onClick={() => go(1)} title="Next file">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {isFolder ? (
        <div className="diff-note">An untracked folder with its own git repository inside. Open it as a repository to see its contents.</div>
      ) : view === 'diff' ? (
        <DiffBody repo={repo} spec={spec} path={file.change.path} mode={mode} version={file.source === 'commit' ? '' : version} />
      ) : view === 'history' ? (
        <HistoryView repo={repo} file={file} headSha={headSha} mode={mode} selected={selected} onPeek={onPeek} />
      ) : (
        <BlameView repo={repo} file={file} headSha={headSha} version={version} selected={selected} onPeek={onPeek} />
      )}
    </div>
  )
}
