import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, normalizeZoom, stepZoom } from '../src/shared/zoom'

describe('zoom', () => {
  it('steps up and down through the offered levels', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(1.5, 0)).toBe(1)
  })

  it('stops at the smallest and largest level', () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })

  it('recovers from a saved value that is not a level', () => {
    expect(normalizeZoom(1.27)).toBe(1.25)
    expect(normalizeZoom(40)).toBe(2)
    expect(normalizeZoom(0)).toBe(0.8)
    expect(normalizeZoom('big')).toBe(1)
    expect(normalizeZoom(NaN)).toBe(1)
    expect(normalizeZoom(undefined)).toBe(1)
    expect(stepZoom(1.27, 1)).toBe(1.5)
  })
})
