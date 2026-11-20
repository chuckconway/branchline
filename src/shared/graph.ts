/**
 * Lane layout for the commit graph.
 *
 * One pass over commits in display order (children before parents). `lanes[i]` holds the SHA
 * that lane is waiting to reach. Lanes never shift sideways, so a row can be drawn knowing
 * only its own `GraphRow`: pass-through lanes are straight verticals, `ins` arrive at the
 * node from the top edge, `outs` leave the node toward the bottom edge.
 */

export interface GraphInput {
  sha: string
  parents: string[]
}

export interface GraphRow {
  /** Lane the commit's node sits in. */
  col: number
  /** Lanes that run straight through this row without touching the node. */
  pass: number[]
  /** Lanes that end at this node (drawn from the top edge of the row). */
  ins: number[]
  /** Lanes that start at this node (drawn to the bottom edge of the row). */
  outs: number[]
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Number of lanes needed to draw every row. */
  width: number
}

interface Lane {
  sha: string
  /** Reserved but not drawn: keeps HEAD's lineage in lane 0 without a line from nowhere. */
  hidden: boolean
}

function firstFree(lanes: (Lane | null)[]): number {
  const i = lanes.indexOf(null)
  return i === -1 ? lanes.length : i
}

/**
 * @param reserve SHA to pin to lane 0 (normally HEAD) so the graph does not re-lane when
 *   the working tree flips between clean and dirty.
 */
export function layoutGraph(commits: readonly GraphInput[], reserve?: string | null): GraphLayout {
  const lanes: (Lane | null)[] = []
  if (reserve) lanes[0] = { sha: reserve, hidden: true }

  const rows: GraphRow[] = new Array(commits.length)
  let width = 0

  for (let r = 0; r < commits.length; r++) {
    const c = commits[r]
    const ins: number[] = []
    const pass: number[] = []
    let col = -1

    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]
      if (!lane) continue
      if (lane.sha === c.sha) {
        if (col === -1) col = i
        if (!lane.hidden) ins.push(i)
        lanes[i] = null
      } else if (!lane.hidden) {
        pass.push(i)
      }
    }
    if (col === -1) col = firstFree(lanes)

    const outs: number[] = []
    for (let k = 0; k < c.parents.length; k++) {
      const p = c.parents[k]
      if (k === 0) {
        // The first parent always inherits this lane, so a branch stays in its own lane
        // until it reaches the commit it forked from.
        lanes[col] = { sha: p, hidden: false }
        outs.push(col)
        continue
      }
      let j = lanes.findIndex((l) => l !== null && l.sha === p && !l.hidden)
      if (j === -1) {
        j = firstFree(lanes)
        lanes[j] = { sha: p, hidden: false }
      }
      if (!outs.includes(j)) outs.push(j)
    }

    let rowMax = col
    for (const i of pass) if (i > rowMax) rowMax = i
    for (const i of ins) if (i > rowMax) rowMax = i
    for (const i of outs) if (i > rowMax) rowMax = i
    if (rowMax + 1 > width) width = rowMax + 1

    rows[r] = { col, pass, ins, outs }
  }

  return { rows, width }
}
