/**
 * Commit message bodies are conventionally wrapped at 72 columns. Shown as-is in a narrow
 * panel, every line wraps a second time partway through. This undoes the hard wrapping so
 * the panel can wrap the text itself, keeping the structure people write: paragraphs,
 * bulleted or numbered lists, indented code, and trailers such as Co-Authored-By.
 */
export type MessageBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'trailers'; lines: string[] }

const BULLET = /^\s*([-*+•]|\d+[.)])\s+(.*)$/
const CODE = /^(\t| {4})/
const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: \S/

export function messageBlocks(body: string): MessageBlock[] {
  const paragraphs = body
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.split('\n').filter((l) => l.trim() !== ''))
    .filter((p) => p.length > 0)

  const blocks: MessageBlock[] = []
  paragraphs.forEach((lines, i) => {
    // As in git itself, trailers are the final paragraph and every line is "Key: value".
    if (i === paragraphs.length - 1 && lines.every((l) => TRAILER.test(l))) {
      blocks.push({ kind: 'trailers', lines })
      return
    }
    let current: MessageBlock | null = null
    for (const line of lines) {
      const bullet = BULLET.exec(line)
      if (bullet) {
        if (current?.kind !== 'list') {
          current = { kind: 'list', ordered: /\d/.test(bullet[1]), items: [] }
          blocks.push(current)
        }
        current.items.push(bullet[2].trim())
      } else if (current?.kind === 'list' && /^\s/.test(line)) {
        current.items[current.items.length - 1] += ' ' + line.trim()
      } else if (CODE.test(line)) {
        if (current?.kind === 'code') current.text += '\n' + line.trimEnd()
        else blocks.push((current = { kind: 'code', text: line.trimEnd() }))
      } else if (current?.kind === 'paragraph') {
        current.text += ' ' + line.trim()
      } else {
        blocks.push((current = { kind: 'paragraph', text: line.trim() }))
      }
    }
  })
  return blocks
}
