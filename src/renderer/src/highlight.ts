import hljs from 'highlight.js/lib/common'
import type { DiffLine, Hunk } from '../../shared/diff'

export interface Token {
  text: string
  cls: string
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', m: 'objectivec',
  rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  md: 'markdown', mdx: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff'
}

const BY_NAME: Record<string, string> = { makefile: 'makefile', dockerfile: 'bash', gemfile: 'ruby', rakefile: 'ruby' }

export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  const lang = BY_NAME[base] ?? (dot === -1 ? undefined : BY_EXTENSION[base.slice(dot + 1)])
  return lang && hljs.getLanguage(lang) ? lang : null
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" }
const decode = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#x27);/g, (m) => ENTITIES[m])

/** Flatten highlight.js's nested-span HTML into per-line tokens. */
function htmlToLines(html: string): Token[][] {
  const lines: Token[][] = [[]]
  const stack: string[] = []
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1])
    else if (m[2] === undefined) stack.pop()
    else {
      const cls = stack.join(' ')
      decode(m[2])
        .split('\n')
        .forEach((part, i) => {
          if (i > 0) lines.push([])
          if (part) lines[lines.length - 1].push({ text: part, cls })
        })
    }
  }
  return lines
}

export function highlightBlock(texts: string[], lang: string): Token[][] | null {
  try {
    const lines = htmlToLines(hljs.highlight(texts.join('\n'), { language: lang, ignoreIllegals: true }).value)
    return lines.length === texts.length ? lines : null
  } catch {
    return null
  }
}

/**
 * Tokens for every line of a hunk. The old and new sides are highlighted separately so that
 * a multi-line construct (a block comment, a template string) is coloured correctly on each.
 */
export function highlightHunk(hunk: Hunk, lang: string | null): Map<DiffLine, Token[]> {
  const out = new Map<DiffLine, Token[]>()
  if (!lang) return out
  const oldSide = hunk.lines.filter((l) => l.type !== 'add')
  const newSide = hunk.lines.filter((l) => l.type !== 'del')
  const oldTokens = highlightBlock(oldSide.map((l) => l.text), lang)
  const newTokens = highlightBlock(newSide.map((l) => l.text), lang)
  if (oldTokens) oldSide.forEach((l, i) => l.type === 'del' && out.set(l, oldTokens[i]))
  if (newTokens) newSide.forEach((l, i) => out.set(l, newTokens[i]))
  return out
}

/** Split tokens so the [start, end) character range can be wrapped as changed. */
export function splitAtMark(tokens: Token[], mark: [number, number]): { token: Token; marked: boolean }[] {
  const [start, end] = mark
  const out: { token: Token; marked: boolean }[] = []
  let pos = 0
  for (const t of tokens) {
    const tEnd = pos + t.text.length
    const cuts = [pos, Math.min(Math.max(start, pos), tEnd), Math.min(Math.max(end, pos), tEnd), tEnd]
    for (let i = 0; i < 3; i++) {
      if (cuts[i + 1] > cuts[i]) {
        out.push({ token: { text: t.text.slice(cuts[i] - pos, cuts[i + 1] - pos), cls: t.cls }, marked: i === 1 })
      }
    }
    pos = tEnd
  }
  return out
}
