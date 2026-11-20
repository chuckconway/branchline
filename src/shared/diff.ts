export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
  oldNo?: number
  newNo?: number
  /** Character range that differs from the paired line on the other side. */
  mark?: [start: number, end: number]
}

export interface Hunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  binary: boolean
  hunks: Hunk[]
  /** Mode changes, rename notices and the like. */
  notes: string[]
  lineCount: number
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Parse the unified diff of a single file. */
export function parseDiff(patch: string): FileDiff {
  const diff: FileDiff = { binary: false, hunks: [], notes: [], lineCount: 0 }
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0

  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  for (const raw of lines) {
    // Diffs of CRLF files carry the \r on every line; it is not a change worth showing.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = HUNK_RE.exec(line)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      hunk = { header: line, lines: [] }
      diff.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) diff.binary = true
      else if (/^(old mode|new mode|new file mode|deleted file mode|rename from|rename to|similarity index)/.test(line)) {
        diff.notes.push(line)
      }
      continue
    }
    const tag = line[0]
    if (tag === '+') hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
    else if (tag === '-') hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
    else if (tag === ' ' || line === '') hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    else if (tag === '\\') continue // "\ No newline at end of file"
    else continue
    diff.lineCount++
  }

  for (const h of diff.hunks) markIntraline(h.lines)
  return diff
}

/**
 * Within each run of deletions followed by the same number of additions, mark the span of
 * each line pair that actually changed (everything between the common prefix and suffix).
 */
function markIntraline(lines: DiffLine[]): void {
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'del') {
      i++
      continue
    }
    const delStart = i
    while (i < lines.length && lines[i].type === 'del') i++
    const addStart = i
    while (i < lines.length && lines[i].type === 'add') i++
    const dels = addStart - delStart
    const adds = i - addStart
    if (dels !== adds) continue
    for (let k = 0; k < dels; k++) markPair(lines[delStart + k], lines[addStart + k])
  }
}

function markPair(a: DiffLine, b: DiffLine): void {
  const s = a.text
  const t = b.text
  if (s.length > 2000 || t.length > 2000) return
  let pre = 0
  const max = Math.min(s.length, t.length)
  while (pre < max && s[pre] === t[pre]) pre++
  let suf = 0
  while (suf < max - pre && s[s.length - 1 - suf] === t[t.length - 1 - suf]) suf++
  // If nearly nothing is shared, a highlight over the whole line is just noise.
  if (pre + suf < Math.min(s.length, t.length) * 0.3) return
  if (s.length - suf > pre) a.mark = [pre, s.length - suf]
  if (t.length - suf > pre) b.mark = [pre, t.length - suf]
}

export interface SplitRow {
  left?: DiffLine
  right?: DiffLine
}

/** Arrange a hunk's lines as side-by-side rows. */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++])
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++])
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}
