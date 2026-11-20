import { expect } from 'vitest'
import type { GraphLayout } from '../src/shared/graph'

/**
 * Every line leaving the bottom of one row must be picked up at the top of the next: the
 * lanes drawn from a row's top edge (pass + ins) are exactly the lanes left open above it.
 */
export function assertContinuous(layout: GraphLayout): void {
  let open = new Set<number>()
  layout.rows.forEach((row, r) => {
    const fromTop = new Set([...row.pass, ...row.ins])
    expect([...fromTop].sort(), `row ${r} top edge`).toEqual([...open].sort())
    expect(row.pass.includes(row.col), `row ${r} node sits on a pass-through lane`).toBe(false)
    const next = new Set(row.pass)
    for (const o of row.outs) next.add(o)
    open = next
  })
}
