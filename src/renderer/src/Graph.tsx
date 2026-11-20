import { Archive, Check, Cloud, FolderGit2, GitBranch, Laptop, Tag } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GraphLayout, GraphRow } from '../../shared/graph'
import { WIP, type Commit } from '../../shared/types'
import { fullDate, shortDate, shortSha } from './format'
import { Splitter, useStored } from './ui'
import type { Pill } from './useRepo'

export const ROW_H = 26
const LANE_W = 14
const PAD = 10
const LANES = 8
const OVERSCAN = 12
const TURN = 7

const laneX = (lane: number): number => PAD + lane * LANE_W
const laneColor = (lane: number): string => `var(--lane-${lane % LANES})`

interface Segment {
  d: string
  lane: number
}

/** SVG paths for one row. Coordinates are local to the row. */
function rowSegments(row: GraphRow): Segment[] {
  const mid = ROW_H / 2
  const xc = laneX(row.col)
  const segs: Segment[] = []
  for (const i of row.pass) segs.push({ lane: i, d: `M${laneX(i)} 0V${ROW_H}` })
  for (const i of row.ins) {
    const x = laneX(i)
    if (i === row.col) segs.push({ lane: i, d: `M${x} 0V${mid}` })
    else {
      // Down the lane, then a rounded turn into the node.
      const s = Math.sign(xc - x)
      segs.push({ lane: i, d: `M${x} 0V${mid - TURN}Q${x} ${mid} ${x + s * TURN} ${mid}H${xc}` })
    }
  }
  for (const j of row.outs) {
    const x = laneX(j)
    if (j === row.col) segs.push({ lane: j, d: `M${x} ${mid}V${ROW_H}` })
    else {
      const s = Math.sign(x - xc)
      segs.push({ lane: j, d: `M${xc} ${mid}H${x - s * TURN}Q${x} ${mid} ${x} ${mid + TURN}V${ROW_H}` })
    }
  }
  return segs
}

type NodeKind = 'commit' | 'merge' | 'head' | 'wip' | 'stash'

function GraphCell({ row, kind, width, connect }: { row: GraphRow; kind: NodeKind; width: number; connect: boolean }): ReactNode {
  const mid = ROW_H / 2
  const x = laneX(row.col)
  const color = laneColor(row.col)
  return (
    <svg className="graph-svg" width={width} height={ROW_H} aria-hidden="true">
      {connect && <path d={`M0 ${mid}H${x}`} stroke={color} className="connector" />}
      {rowSegments(row).map((s, i) => (
        <path key={i} d={s.d} stroke={laneColor(s.lane)} className={kind === 'wip' ? 'edge dashed' : 'edge'} />
      ))}
      {kind === 'commit' && <circle cx={x} cy={mid} r={4.5} fill={color} className="node" />}
      {kind === 'merge' && <circle cx={x} cy={mid} r={3} fill={color} className="node" />}
      {kind === 'head' && (
        <>
          <circle cx={x} cy={mid} r={6} className="node-ring" stroke={color} />
          <circle cx={x} cy={mid} r={2.5} fill={color} />
        </>
      )}
      {kind === 'wip' && <circle cx={x} cy={mid} r={5} className="node-wip" />}
      {kind === 'stash' && <rect x={x - 4.5} y={mid - 4.5} width={9} height={9} rx={2} className="node-ring" stroke={color} />}
    </svg>
  )
}

function PillIcon({ pill }: { pill: Pill }): ReactNode {
  if (pill.kind === 'tag') return <Tag size={11} />
  if (pill.kind === 'stash') return <Archive size={11} />
  if (pill.kind === 'detached') return <Check size={11} />
  return (
    <>
      {pill.isHead && <Check size={11} strokeWidth={3} />}
      {pill.hasLocal && !pill.isHead && (pill.worktreePath ? <FolderGit2 size={11} /> : <Laptop size={11} />)}
      {pill.hasRemote && <Cloud size={11} />}
    </>
  )
}

function pillTitle(p: Pill): string {
  if (p.kind === 'tag') return `Tag ${p.label}`
  if (p.kind === 'stash') return `Stash ${p.label}`
  if (p.kind === 'detached') return 'HEAD is detached here'
  if (p.kind === 'remote') return `Remote branch ${p.label}`
  const where = p.hasRemote ? 'local and remote' : 'local only'
  const extra = p.isHead ? ', checked out' : p.worktreePath ? `, checked out in ${p.worktreePath}` : ''
  return `Branch ${p.label} (${where}${extra})`
}

function Pills({ pills, lane, onMenu }: { pills: Pill[]; lane: number; onMenu: (refName: string, x: number, y: number) => void }): ReactNode {
  const [first, ...rest] = pills
  const style = { '--pill': laneColor(lane) } as React.CSSProperties
  const isBranch = first.kind === 'branch' || first.kind === 'remote'
  return (
    <>
      <span
        className={`pill ${first.isHead ? 'head' : ''} ${first.kind}`}
        style={style}
        title={pillTitle(first)}
        onContextMenu={
          isBranch
            ? (e) => {
                // A branch label gets the branch's menu; anywhere else on the row, the commit's.
                e.preventDefault()
                e.stopPropagation()
                onMenu(first.key, e.clientX, e.clientY)
              }
            : undefined
        }
      >
        <PillIcon pill={first} />
        <span className="pill-label">{first.label}</span>
      </span>
      {rest.length > 0 && (
        <span className="pill more" style={style} title={rest.map((p) => p.label).join('\n')}>
          +{rest.length}
        </span>
      )}
      <span className="pill-line" style={style} />
    </>
  )
}

interface RowProps {
  commit: Commit
  row: GraphRow
  index: number
  kind: NodeKind
  pills: Pill[] | undefined
  selected: boolean
  dim: boolean
  refsW: number
  graphW: number
  wipSummary: string
  onSelect: (sha: string) => void
  onMenu: (sha: string, x: number, y: number) => void
  onRefMenu: (refName: string, x: number, y: number) => void
}

const Row = memo(function Row(p: RowProps): ReactNode {
  const { commit: c } = p
  const wip = c.sha === WIP
  return (
    <div
      className={`row ${p.selected ? 'selected' : ''} ${p.dim ? 'dim' : ''} ${wip ? 'wip' : ''}`}
      style={{ top: p.index * ROW_H }}
      data-sha={c.sha}
      onClick={() => p.onSelect(c.sha)}
      onContextMenu={(e) => {
        e.preventDefault()
        p.onMenu(c.sha, e.clientX, e.clientY)
      }}
    >
      <div className="cell refs" style={{ width: p.refsW }}>
        {p.pills && <Pills pills={p.pills} lane={p.row.col} onMenu={p.onRefMenu} />}
      </div>
      <div className="cell graph" style={{ width: p.graphW }}>
        <GraphCell row={p.row} kind={p.kind} width={p.graphW} connect={Boolean(p.pills)} />
      </div>
      <div className="cell msg" title={wip ? undefined : c.subject}>
        {wip ? (
          <>
            <span className="wip-label">Uncommitted changes</span>
            <span className="wip-count">{p.wipSummary}</span>
          </>
        ) : (
          c.subject
        )}
      </div>
      <div className="cell author" title={c.email}>
        {c.author}
      </div>
      <div className="cell date" title={wip ? undefined : fullDate(c.time)}>
        {wip ? '' : shortDate(c.time)}
      </div>
      <div className="cell sha">{wip ? '' : shortSha(c.sha)}</div>
    </div>
  )
})

interface GraphProps {
  rows: Commit[]
  layout: GraphLayout
  pills: Map<string, Pill[]>
  headSha: string | null
  selected: string | null
  onSelect: (sha: string) => void
  /** Right-click on a row. */
  onMenu: (sha: string, x: number, y: number) => void
  /** Right-click on a branch label. */
  onRefMenu: (refName: string, x: number, y: number) => void
  /** Row indices matching the search, or null when not searching. */
  matches: Set<number> | null
  /** Bring this commit into view. The nonce lets the same commit be requested twice. */
  reveal: { sha: string; nonce: number } | null
  rowIndex: Map<string, number>
  hasMore: boolean
  onLoadMore: () => void
  wipSummary: string
}

export function Graph(p: GraphProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const [refsW, setRefsW] = useStored('graph.refsW', 180)
  const [graphWStored, setGraphW] = useStored<number | null>('graph.graphW', null)

  // Wide enough for nine rows in ten. A few tangled stretches of history should not cost
  // every other row its commit message; the column can be dragged wider when they matter.
  const typicalLanes = useMemo(() => {
    const widths = p.layout.rows.map((r) => {
      let max = r.col
      for (const i of r.pass) if (i > max) max = i
      for (const i of r.outs) if (i > max) max = i
      return max + 1
    })
    widths.sort((a, b) => a - b)
    return widths.length ? widths[Math.floor((widths.length - 1) * 0.9)] : 1
  }, [p.layout])
  const autoGraphW = PAD * 2 + Math.max(3, Math.min(typicalLanes, 10)) * LANE_W
  const graphW = graphWStored ?? autoGraphW
  const fullGraphW = PAD * 2 + Math.max(1, p.layout.width) * LANE_W

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!p.reveal) return
    const i = p.rowIndex.get(p.reveal.sha)
    const el = scroller.current
    if (i === undefined || !el) return
    const top = i * ROW_H
    if (top < el.scrollTop + ROW_H || top > el.scrollTop + el.clientHeight - ROW_H * 2) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3)
    }
    // Only a new reveal request should scroll, not every rebuild of the index.
  }, [p.reveal]) // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(p.rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN)

  const { hasMore, onLoadMore } = p
  useEffect(() => {
    if (hasMore && last >= p.rows.length - 40) onLoadMore()
  }, [hasMore, last, p.rows.length, onLoadMore])

  const visible = useMemo(() => {
    const out: ReactNode[] = []
    for (let i = first; i < last; i++) {
      const c = p.rows[i]
      const kind: NodeKind =
        c.sha === WIP ? 'wip' : c.isStash ? 'stash' : c.sha === p.headSha ? 'head' : c.parents.length > 1 ? 'merge' : 'commit'
      out.push(
        <Row
          key={c.sha}
          commit={c}
          row={p.layout.rows[i]}
          index={i}
          kind={kind}
          pills={p.pills.get(c.sha)}
          selected={c.sha === p.selected}
          dim={p.matches !== null && !p.matches.has(i)}
          refsW={refsW}
          graphW={graphW}
          wipSummary={p.wipSummary}
          onSelect={p.onSelect}
          onMenu={p.onMenu}
          onRefMenu={p.onRefMenu}
        />
      )
    }
    return out
  }, [first, last, p.rows, p.layout, p.pills, p.headSha, p.selected, p.matches, refsW, graphW, p.wipSummary, p.onSelect, p.onMenu, p.onRefMenu])

  return (
    <div className="graph-pane">
      <div className="graph-head">
        <div className="cell refs" style={{ width: refsW }}>
          Branch / Tag
          <Splitter value={refsW} onChange={setRefsW} min={70} max={420} className="in-head" label="Resize branch column" />
        </div>
        <div className="cell graph" style={{ width: graphW }}>
          Graph
          <Splitter
            value={graphW}
            onChange={setGraphW}
            min={PAD * 2 + LANE_W}
            max={Math.max(fullGraphW, 120)}
            className="in-head"
            label="Resize graph column"
          />
        </div>
        <div className="cell msg">Commit message</div>
        <div className="cell author">Author</div>
        <div className="cell date">Date</div>
        <div className="cell sha">SHA</div>
      </div>
      <div
        className="graph-scroll"
        ref={scroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        role="list"
        aria-label="Commits"
      >
        <div className="graph-rows" style={{ height: p.rows.length * ROW_H + (hasMore ? ROW_H : 0) }}>
          {visible}
          {hasMore && (
            <div className="row loading-more" style={{ top: p.rows.length * ROW_H }}>
              <GitBranch size={12} /> Loading older commits…
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
