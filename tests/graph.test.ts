import { describe, expect, it } from 'vitest'
import { layoutGraph, type GraphInput } from '../src/shared/graph'
import { assertContinuous } from './helpers'

const c = (sha: string, ...parents: string[]): GraphInput => ({ sha, parents })

describe('layoutGraph', () => {
  it('keeps linear history in one lane', () => {
    const layout = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
    expect(layout.width).toBe(1)
    expect(layout.rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(layout.rows[0]).toEqual({ col: 0, pass: [], ins: [], outs: [0] })
    expect(layout.rows[2]).toEqual({ col: 0, pass: [], ins: [0], outs: [] })
    assertContinuous(layout)
  })

  it('keeps a branch in its own lane until its fork point', () => {
    // main: a - b - d ; feature: b - f1 - f2
    const layout = layoutGraph([c('d', 'b'), c('f2', 'f1'), c('f1', 'b'), c('b', 'a'), c('a')])
    expect(layout.rows.map((r) => r.col)).toEqual([0, 1, 1, 0, 0])
    // Both lanes converge on b's row, not earlier.
    expect(layout.rows[2].outs).toEqual([1])
    expect(layout.rows[3].ins).toEqual([0, 1])
    expect(layout.width).toBe(2)
    assertContinuous(layout)
  })

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    // m merges f into main: m(c, f), c(b), f(b), b(a)
    const layout = layoutGraph([c('m', 'c', 'f'), c('c', 'b'), c('f', 'b'), c('b', 'a'), c('a')])
    expect(layout.rows[0]).toEqual({ col: 0, pass: [], ins: [], outs: [0, 1] })
    expect(layout.rows[1]).toEqual({ col: 0, pass: [1], ins: [0], outs: [0] })
    expect(layout.rows[2]).toEqual({ col: 1, pass: [0], ins: [1], outs: [1] })
    expect(layout.rows[3]).toEqual({ col: 0, pass: [], ins: [0, 1], outs: [0] })
    assertContinuous(layout)
  })

  it('reuses a freed lane for a later branch', () => {
    const layout = layoutGraph([c('x', 'a'), c('y', 'a'), c('a', 'r'), c('z', 'r'), c('r')])
    expect(layout.rows.map((r) => r.col)).toEqual([0, 1, 0, 1, 0])
    expect(layout.width).toBe(2)
    assertContinuous(layout)
  })

  it('pins the reserved commit to lane 0 without drawing a line down to it', () => {
    // A branch ahead of HEAD appears first; HEAD (b) must still land in lane 0.
    const layout = layoutGraph([c('f', 'b'), c('b', 'a'), c('a')], 'b')
    expect(layout.rows.map((r) => r.col)).toEqual([1, 0, 0])
    expect(layout.rows[0].pass).toEqual([])
    expect(layout.rows[1].ins).toEqual([1])
    assertContinuous(layout)
  })

  it('gives the same lanes whether or not a WIP row sits above HEAD', () => {
    const history = [c('f', 'b'), c('b', 'a'), c('a')]
    const clean = layoutGraph(history, 'b')
    const dirty = layoutGraph([c('WIP', 'b'), ...history])
    expect(dirty.rows.slice(1).map((r) => r.col)).toEqual(clean.rows.map((r) => r.col))
    assertContinuous(dirty)
  })

  it('carries a lane off the bottom when a parent is not loaded', () => {
    const layout = layoutGraph([c('b', 'a'), c('x', 'missing'), c('a')])
    expect(layout.rows[2]).toEqual({ col: 0, pass: [1], ins: [0], outs: [] })
    assertContinuous(layout)
  })

  it('handles an octopus merge', () => {
    const layout = layoutGraph([c('m', 'a', 'b', 'd'), c('a', 'r'), c('b', 'r'), c('d', 'r'), c('r')])
    expect(layout.rows[0].outs).toEqual([0, 1, 2])
    expect(layout.rows[4].ins).toEqual([0, 1, 2])
    expect(layout.width).toBe(3)
    assertContinuous(layout)
  })
})
