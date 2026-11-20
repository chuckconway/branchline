const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Compact date for a dense list: relative when recent, a calendar date otherwise. */
export function shortDate(unixSeconds: number, now = Date.now()): string {
  const ms = unixSeconds * 1000
  const diff = now - ms
  if (diff >= 0 && diff < 60_000) return 'just now'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff >= 0 && diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const d = new Date(ms)
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${d.getFullYear()}`
}

export function fullDate(value: number | string): string {
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export const shortSha = (sha: string): string => sha.slice(0, 7)

export function splitPath(path: string): [dir: string, base: string] {
  const i = path.lastIndexOf('/')
  return i === -1 ? ['', path] : [path.slice(0, i + 1), path.slice(i + 1)]
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
