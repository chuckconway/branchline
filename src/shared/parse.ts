import type { Blame, Commit, FileChange, FileStatus, Ref, RemoteWeb, Stash, Status, Worktree } from './types'

/** `git log --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s` */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%s'

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const f = line.split('\0')
    if (f.length < 6) continue
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      email: f[3],
      time: Number(f[4]),
      subject: f[5]
    })
  }
  return commits
}

/**
 * A stash is a merge commit whose extra parents are bookkeeping commits (the index state and,
 * optionally, untracked files). Show the stash as a single node hanging off its base commit.
 */
export function foldStashes(commits: Commit[], stashShas: ReadonlySet<string>): Commit[] {
  if (stashShas.size === 0) return commits
  const hidden = new Set<string>()
  for (const c of commits) {
    if (!stashShas.has(c.sha)) continue
    for (const p of c.parents.slice(1)) hidden.add(p)
  }
  const out: Commit[] = []
  for (const c of commits) {
    if (hidden.has(c.sha)) continue
    out.push(stashShas.has(c.sha) ? { ...c, parents: c.parents.slice(0, 1), isStash: true } : c)
  }
  return out
}

export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(HEAD)',
  '%(worktreepath)',
  '%(symref)'
].join('%00')

export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = []
  const defaults = new Set<string>()
  for (const line of out.split('\n')) {
    if (!line) continue
    const [name, obj, peeled, upstream, track, head, worktreePath, symref] = line.split('\0')
    if (symref) {
      // refs/remotes/origin/HEAD is not a branch; it names the remote's default one.
      defaults.add(symref)
      continue
    }
    const sha = peeled || obj
    if (name.startsWith('refs/heads/')) {
      const ref: Ref = { name, short: name.slice('refs/heads/'.length), kind: 'head', sha }
      if (upstream) ref.upstream = upstream
      if (track) {
        if (track.includes('gone')) ref.gone = true
        const a = /ahead (\d+)/.exec(track)
        const b = /behind (\d+)/.exec(track)
        if (a) ref.ahead = Number(a[1])
        if (b) ref.behind = Number(b[1])
      }
      if (head === '*') ref.isHead = true
      if (worktreePath) ref.worktreePath = worktreePath
      refs.push(ref)
    } else if (name.startsWith('refs/remotes/')) {
      const short = name.slice('refs/remotes/'.length)
      const slash = short.indexOf('/')
      refs.push({ name, short, kind: 'remote', sha, remote: slash === -1 ? short : short.slice(0, slash) })
    } else if (name.startsWith('refs/tags/')) {
      refs.push({ name, short: name.slice('refs/tags/'.length), kind: 'tag', sha })
    }
  }
  for (const ref of refs) if (defaults.has(ref.name)) ref.isDefault = true
  return refs
}

/** `git stash list --format=%H%x00%gd%x00%at%x00%gs` */
export const STASH_FORMAT = '%H%x00%gd%x00%at%x00%gs'

export function parseStashes(out: string): Stash[] {
  const stashes: Stash[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [sha, ref, time, message] = line.split('\0')
    const m = /\{(\d+)\}/.exec(ref ?? '')
    stashes.push({ sha, ref, index: m ? Number(m[1]) : stashes.length, time: Number(time), message: message ?? '' })
  }
  return stashes
}

/** `git worktree list --porcelain` */
export function parseWorktrees(out: string, currentPath: string): Worktree[] {
  const list: Worktree[] = []
  let cur: Worktree | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      const path = line.slice('worktree '.length)
      // git lists the main working tree first.
      cur = { path, sha: '', detached: false, bare: false, locked: false, prunable: false, isCurrent: path === currentPath, isMain: list.length === 0 }
      list.push(cur)
    } else if (!cur) {
      continue
    } else if (line.startsWith('HEAD ')) {
      cur.sha = line.slice(5)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached') {
      cur.detached = true
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line.startsWith('locked')) {
      cur.locked = true
    } else if (line.startsWith('prunable')) {
      cur.prunable = true
    }
  }
  return list
}

function statusCode(c: string): FileStatus {
  switch (c) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return c
    default:
      return 'M'
  }
}

/** Text after the nth space; porcelain v2 puts the path last and paths may contain spaces. */
function afterNthSpace(s: string, n: number): string {
  let idx = -1
  for (let i = 0; i < n; i++) {
    idx = s.indexOf(' ', idx + 1)
    if (idx === -1) return ''
  }
  return s.slice(idx + 1)
}

/** `git status --porcelain=v2 --branch -z` */
export function parseStatus(out: string): Status {
  const status: Status = { branch: null, headSha: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') status.headSha = value === '(initial)' ? null : value
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m) {
          status.ahead = Number(m[1])
          status.behind = Number(m[2])
        }
      }
      continue
    }
    const type = rec[0]
    if (type === '?') {
      status.unstaged.push({ path: rec.slice(2), status: '?' })
    } else if (type === '1' || type === '2') {
      const x = rec[2]
      const y = rec[3]
      const path = afterNthSpace(rec, type === '1' ? 8 : 9)
      // Renamed/copied entries carry the original path as the next NUL-separated field.
      const oldPath = type === '2' ? parts[++i] : undefined
      if (x !== '.') {
        const change: FileChange = { path, status: statusCode(x) }
        if (oldPath && (x === 'R' || x === 'C')) change.oldPath = oldPath
        status.staged.push(change)
      }
      if (y !== '.') {
        const change: FileChange = { path, status: statusCode(y) }
        if (oldPath && (y === 'R' || y === 'C')) change.oldPath = oldPath
        status.unstaged.push(change)
      }
    } else if (type === 'u') {
      status.conflicted.push({ path: afterNthSpace(rec, 10), status: 'U' })
    }
  }
  return status
}

/** `git diff --name-status -z` */
export function parseNameStatus(out: string): FileChange[] {
  const files: FileChange[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    const status = statusCode(code[0])
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[++i]
      const path = parts[++i]
      files.push({ path, oldPath, status })
    } else {
      files.push({ path: parts[++i], status })
    }
  }
  return files
}

export interface NumStat {
  added: number
  deleted: number
  binary: boolean
}

/** `git diff --numstat -z`, keyed by (new) path. */
export function parseNumstat(out: string): Map<string, NumStat> {
  const stats = new Map<string, NumStat>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (!m) continue
    let path = m[3]
    if (path === '') {
      // Rename: "added\tdeleted\t" NUL old NUL new
      i += 2
      path = parts[i]
    }
    const binary = m[1] === '-'
    stats.set(path, { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary })
  }
  return stats
}

export function applyNumstat(files: FileChange[], stats: Map<string, NumStat>): FileChange[] {
  for (const f of files) {
    const s = stats.get(f.path)
    if (!s) continue
    f.added = s.added
    f.deleted = s.deleted
    if (s.binary) f.binary = true
  }
  return files
}

/** Turn a remote's fetch URL into the address of its web page, when it has one. */
export function remoteWebBase(url: string): { base: string; commitPath: string } | null {
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url) // git@host:owner/repo.git
  if (/^[a-z+]+:\/\//i.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (!/^(https?|ssh|git|git\+ssh):$/.test(parsed.protocol)) return null
    host = parsed.protocol.startsWith('http') ? parsed.host : parsed.hostname
    path = parsed.pathname
  } else if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    return null // a local path
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  if (!host || !path) return null
  const commitPath = /gitlab/i.test(host) ? '/-/commit/' : /bitbucket/i.test(host) ? '/commits/' : '/commit/'
  return { base: `https://${host}/${path}`, commitPath }
}

/** `git remote -v`. Prefers `preferred`, then origin, then any remote with a web address. */
export function parseRemotes(out: string, preferred?: string): { names: string[]; web: RemoteWeb | null } {
  const urls = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line)
    if (m && (m[3] === 'fetch' || !urls.has(m[1]))) urls.set(m[1], m[2])
  }
  const names = [...urls.keys()]
  const order = [...new Set([preferred, 'origin', ...names].filter((n): n is string => Boolean(n) && urls.has(n!)))]
  for (const remote of order) {
    const web = remoteWebBase(urls.get(remote)!)
    if (web) return { names, web: { remote, ...web } }
  }
  return { names, web: null }
}

/** `git blame --porcelain` */
export function parseBlame(out: string): Blame {
  const blame: Blame = { commits: {}, lines: [] }
  let sha = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      blame.lines.push({ sha, text: line.slice(1).replace(/\r$/, '') })
      continue
    }
    const header = /^([0-9a-f]{40,64}) \d+ \d+/.exec(line)
    if (header) {
      sha = header[1]
      blame.commits[sha] ??= { author: '', time: 0, summary: '' }
      continue
    }
    const meta = blame.commits[sha]
    if (!meta) continue
    if (line.startsWith('author ')) meta.author = line.slice(7)
    else if (line.startsWith('author-time ')) meta.time = Number(line.slice(12))
    else if (line.startsWith('summary ')) meta.summary = line.slice(8)
  }
  return blame
}

/** Prefix for each commit in `git log --follow --name-status -z --format=...`. */
export const FILE_LOG_FORMAT = `%x01${LOG_FORMAT}`

export interface FileLogEntry {
  commit: Commit
  status: FileStatus
  path: string
  oldPath?: string
}

export function parseFileLog(out: string, startPath: string): FileLogEntry[] {
  const entries: FileLogEntry[] = []
  let path = startPath
  for (const chunk of out.split('\x01')) {
    if (!chunk) continue
    const f = chunk.split('\0')
    if (f.length < 6) continue
    // The subject is followed by the name-status record: "\n" then code, NUL, path(s).
    const subjectEnd = f[5].indexOf('\n')
    const subject = subjectEnd === -1 ? f[5] : f[5].slice(0, subjectEnd)
    const rest = [subjectEnd === -1 ? '' : f[5].slice(subjectEnd + 1), ...f.slice(6)].map((t) => t.replace(/^\n+/, '')).filter(Boolean)
    const commit: Commit = { sha: f[0], parents: f[1] ? f[1].split(' ') : [], author: f[2], email: f[3], time: Number(f[4]), subject }
    const code = rest[0] ?? ''
    if (/^[RC]\d*$/.test(code) && rest.length >= 3) {
      entries.push({ commit, status: statusCode(code[0]), oldPath: rest[1], path: rest[2] })
      path = rest[1] // older commits know the file by its previous name
    } else if (/^[AMDT]$/.test(code) && rest.length >= 2) {
      entries.push({ commit, status: statusCode(code), path: rest[1] })
      path = rest[1]
    } else {
      entries.push({ commit, status: 'M', path })
    }
  }
  return entries
}
