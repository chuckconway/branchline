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

// Apps launched from Finder get a minimal PATH; make Homebrew's git reachable too.
const PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin'].join(':')

const MAX_OUTPUT = 256 * 1024 * 1024

// macOS's /usr/bin/git is a shim that refuses to run whenever Xcode wants its license
// accepted again, which happens after Xcode installs and updates. The Command Line Tools'
// own copy keeps working, so fall back to it rather than go blind.
const CLT_DIR = '/Library/Developer/CommandLineTools'
const CLT_GIT = `${CLT_DIR}/usr/bin/git`
const CANDIDATES = ['git', CLT_GIT]

function probe(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { env: { ...process.env, PATH } })
    const out: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => out.push(d))
    child.on('error', (e) => resolve(e.message))
    child.on('close', (code) => resolve(code === 0 ? null : Buffer.concat(out).toString('utf8').trim() || `exit code ${code}`))
  })
}

let binary: Promise<string> | null = null

/** The first git that actually runs. A failure is not cached, so fixing git fixes the app. */
export function gitBinary(): Promise<string> {
  if (!binary) {
    const found = (async () => {
      let firstError = ''
      for (const bin of CANDIDATES) {
        const error = await probe(bin)
        if (error === null) return bin
        firstError ||= error
      }
      throw new GitError(`git is not usable on this machine: ${firstError}`, null, firstError)
    })()
    found.catch(() => {
      if (binary === found) binary = null
    })
    binary = found
  }
  return binary
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const bin = await gitBinary()
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH,
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
