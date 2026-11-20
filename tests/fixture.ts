import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build a small repository that exercises everything the viewer shows: diverged branches, a
 * merge, annotated and lightweight tags, a remote with an ahead/behind branch, a rename, a
 * stash with untracked files, a linked worktree, and a dirty working tree.
 *
 * Layout under `root`: repo/ (the working repository), origin.git/ (bare remote),
 * repo-agent/ (linked worktree).
 */
export function buildFixture(root: string): { repo: string; worktree: string } {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  const worktree = join(root, 'repo-agent')
  mkdirSync(repo)

  let clock = Date.UTC(2026, 9, 1, 9, 0, 0) / 1000
  const run = (cwd: string, args: string[], author = 'Ada Lovelace <ada@example.com>'): string => {
    clock += 3600
    const [name, email] = author.replace('>', '').split(' <')
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_AUTHOR_DATE: `${clock} +0000`,
        GIT_COMMITTER_DATE: `${clock} +0000`,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null'
      }
    })
  }
  const g = (...args: string[]): string => run(repo, args)
  const write = (rel: string, text: string, cwd = repo): void => {
    mkdirSync(join(cwd, rel, '..'), { recursive: true })
    writeFileSync(join(cwd, rel), text)
  }
  const commit = (msg: string, author?: string): void => {
    run(repo, ['add', '-A'], author)
    run(repo, ['commit', '-q', '-m', msg], author)
  }
  const grace = 'Grace Hopper <grace@example.com>'

  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Ada Lovelace')
  g('config', 'user.email', 'ada@example.com')
  g('config', 'commit.gpgsign', 'false')

  write('README.md', '# Fixture\n\nA repository for tests.\n')
  write('src/app.ts', "export function main(): void {\n  console.log('hello')\n}\n")
  commit('Initial commit')

  write('src/util.ts', 'export const add = (a: number, b: number): number => a + b\n')
  commit('Add util module')

  g('checkout', '-q', '-b', 'feature/login')
  write('src/login.ts', "export function login(user: string): boolean {\n  return user.length > 0\n}\n")
  commit('Add login form', grace)
  write('src/login.ts', "export function login(user: string, pass: string): boolean {\n  return user.length > 0 && pass.length > 0\n}\n")
  commit('Require a password', grace)

  g('checkout', '-q', 'main')
  write('README.md', '# Fixture\n\nA repository for tests.\n\n## Usage\n\nRun it.\n')
  commit('Document usage')
  g('tag', 'rc')

  run(repo, ['merge', '-q', '--no-ff', 'feature/login', '-m', "Merge branch 'feature/login'"])
  g('tag', '-a', 'v1.0', '-m', 'Version 1.0')

  g('checkout', '-q', '-b', 'feature/search')
  renameSync(join(repo, 'src/util.ts'), join(repo, 'src/math.ts'))
  write('src/search.ts', "export const search = (q: string): string[] => [q]\n")
  commit('Rename util to math and add search')

  g('checkout', '-q', 'main')
  write('src/app.ts', "import { login } from './login'\n\nexport function main(): void {\n  console.log('hello', login('ada', 'pw'))\n}\n")
  commit('Use login in main')

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  g('remote', 'add', 'origin', origin)
  g('push', '-q', '-u', 'origin', 'main')
  g('push', '-q', 'origin', 'feature/login')

  write('src/app.ts', "import { login } from './login'\n\nexport function main(): void {\n  console.log('hello,', login('ada', 'pw'))\n}\n")
  commit('Tweak greeting')

  g('worktree', 'add', '-q', '-b', 'agent/task-1', worktree, 'main')
  write('notes.md', 'agent notes\n', worktree)
  run(worktree, ['add', '-A'])
  run(worktree, ['commit', '-q', '-m', 'Agent: add notes'], grace)

  write('src/app.ts', "import { login } from './login'\n\nexport function main(): void {\n  console.log('stashed', login('ada', 'pw'))\n}\n")
  write('scratch.txt', 'stashed untracked file\n')
  g('stash', 'push', '-q', '--include-untracked', '-m', 'experiment')

  // Dirty tree: one unstaged edit, one staged new file, two untracked files.
  write('README.md', '# Fixture\n\nA repository for viewer tests.\n\n## Usage\n\nRun it.\n')
  write('src/staged.ts', 'export const staged = true\n')
  g('add', 'src/staged.ts')
  write('untracked.txt', 'new file\n')
  write('docs/file with spaces.md', '# Spaces\n')

  return { repo, worktree }
}
