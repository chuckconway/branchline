/** The zoom levels offered, as factors of normal size. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/** A saved value, made safe to use: a known step, or normal size if it is nonsense. */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return ZOOM_STEPS.reduce<number>((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), 1)
}

/** The next step larger (1) or smaller (-1), stopping at the ends; 0 returns to normal size. */
export function stepZoom(current: number, direction: 1 | -1 | 0): number {
  if (direction === 0) return 1
  const i = ZOOM_STEPS.indexOf(normalizeZoom(current) as (typeof ZOOM_STEPS)[number])
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + direction))]
}
