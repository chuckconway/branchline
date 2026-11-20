import { spawn } from 'node:child_process'

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
    /** What git printed before failing; conflict details land here, not on stderr. */
    readonly stdout = ''
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  /** Feed this to stdin. */
  input?: string
  /** Exit codes that are not failures (e.g. 1 for `git diff --no-index`). */
  okCodes?: number[]
  /** Kill the process after this long. */
  timeoutMs?: number
  /** A command that changes the repository. Read commands never take optional locks. */
  write?: boolean
  /** Extra environment, applied last. */
  env?: Record<string, string>
}

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

// Apps launched from Finder or a Linux desktop get a minimal PATH; make the usual install
// locations reachable. Windows is left alone: its PATH variable is spelled "Path", and adding
// a second spelling would give child processes two conflicting copies.
const EXTRA_PATH = isMac ? ['/opt/homebrew/bin', '/usr/local/bin'] : isWindows ? [] : ['/usr/local/bin']
const PATH_ENV: Record<string, string> = EXTRA_PATH.length ? { PATH: [...EXTRA_PATH, process.env.PATH ?? '/usr/bin:/bin'].join(':') } : {}

const MAX_OUTPUT = 256 * 1024 * 1024

/** Oldest git whose commands and output formats this app relies on (March 2021). */
export const MIN_GIT: [number, number] = [2, 31]

// macOS's /usr/bin/git is a shim that refuses to run whenever Xcode wants its license
// accepted again, which happens after Xcode installs and updates. The Command Line Tools'
// own copy keeps working, so fall back to it rather than go blind.
const CLT_DIR = '/Library/Developer/CommandLineTools'
const CLT_GIT = `${CLT_DIR}/usr/bin/git`
const CANDIDATES = isMac ? ['git', CLT_GIT] : ['git']

const INSTALL_HINT = isMac
  ? 'Install it by running "xcode-select --install" in Terminal, or with Homebrew.'
  : isWindows
    ? 'Install Git for Windows from https://git-scm.com/download/win.'
    : "Install it with your distribution's package manager."

/** git cannot be run at all (missing, blocked, or too old). No repository is at fault. */
export class GitUnavailableError extends GitError {
  constructor(message: string) {
    super(message, null, '')
    this.name = 'GitUnavailableError'
  }
}

interface Probe {
  version?: string
  missing?: boolean
  error?: string
}

function probe(bin: string): Promise<Probe> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { env: { ...process.env, ...PATH_ENV } })
    const out: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => out.push(d))
    child.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ENOENT' ? { missing: true } : { error: e.message }))
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim()
      resolve(code === 0 ? { version: text } : { error: text || `exit code ${code}` })
    })
  })
}

/** "git version 2.45.1.windows.1" -> [2, 45] */
export function parseGitVersion(text: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2])] : null
}

export const isSupportedGit = ([major, minor]: [number, number]): boolean =>
  major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])

let found: Promise<{ bin: string; version: string }> | null = null

/** The first git that runs and is new enough. A failure is not cached, so fixing git fixes the app. */
function findGit(): Promise<{ bin: string; version: string }> {
  if (!found) {
    const search = (async () => {
      let problem = ''
      let tooOld = ''
      for (const bin of CANDIDATES) {
        const result = await probe(bin)
        if (result.version) {
          const version = parseGitVersion(result.version)
          if (version && isSupportedGit(version)) return { bin, version: version.join('.') }
          tooOld ||= result.version
        } else if (!result.missing) {
          problem ||= result.error ?? ''
        }
      }
      if (tooOld) throw new GitUnavailableError(`Branchline needs git ${MIN_GIT.join('.')} or newer, and this machine has "${tooOld}". Update git and try again.`)
      if (problem) throw new GitUnavailableError(`git is installed but will not run: ${problem}`)
      throw new GitUnavailableError(`git was not found. ${INSTALL_HINT}`)
    })()
    search.catch(() => {
      if (found === search) found = null
    })
    found = search
  }
  return found
}

export const gitBinary = (): Promise<string> => findGit().then((g) => g.bin)

/** Whether git can be used, for telling the user before they open anything. */
export async function gitInfo(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    return { ok: true, version: (await findGit()).version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const bin = await gitBinary()
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...PATH_ENV,
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat'
    }
    // Without this, `git status` rewrites the index and can hold index.lock while an agent
    // in the same repository is trying to commit.
    if (!opts.write) env.GIT_OPTIONAL_LOCKS = '0'
    // On the fallback, point hooks and anything else that runs plain `git` at the same tools.
    if (bin === CLT_GIT) env.DEVELOPER_DIR = CLT_DIR
    Object.assign(env, opts.env)

    const child = spawn(bin, ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], { cwd, env })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let timedOut = false

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
        }, opts.timeoutMs)
      : null

    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_OUTPUT) child.kill('SIGTERM')
      else out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(new GitError(`Could not run git: ${e.message}`, null, ''))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8').trim()
      if (timedOut) return reject(new GitError(`git ${args[0]} timed out`, code, stderr))
      const stdout = Buffer.concat(out).toString('utf8')
      if (code === 0 || opts.okCodes?.includes(code ?? -1)) return resolve(stdout)
      reject(new GitError(stderr || stdout.trim() || `git ${args[0]} exited with code ${code}`, code, stderr, stdout))
    })

    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}
