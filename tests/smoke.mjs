// End-to-end check of the built app: launches Electron on a scripted repository, drives the
// real UI, and saves screenshots to tests/.artifacts/shots. Run `npm run build` first.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { buildFixture } from './fixture.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'tests/.artifacts')
const shots = join(artifacts, 'shots')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const { repo, worktree } = buildFixture(join(artifacts, 'fixture'))
const extra = process.env.SMOKE_REPO // optionally also open a real repository, read-only

let step = 0
const shot = async (page, name) => page.screenshot({ path: join(shots, `${String(++step).padStart(2, '0')}-${name}.png`) })
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`)
  console.log(`ok  ${what}`)
}
// The changed span of the first added line; syntax colouring may split it across tokens.
const marked = async (page) => (await page.locator('.dl.add').first().locator('.changed').allTextContents()).join('')
const gitIn = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })

const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in file manager'

// Launched from Finder the app never has DEVELOPER_DIR, so it must find a working git itself
// even when this harness needed the variable to build the fixture.
const appEnv = { ...process.env }
delete appEnv.DEVELOPER_DIR

// SMOKE_APP points at a packaged binary; otherwise the build in out/ runs under Electron.
// SMOKE_NO_SANDBOX is for containers. SMOKE_NO_GPU is for virtual displays with no GPU device,
// such as GitHub's Linux runners: there the GPU process fails to start, Chromium restarts it,
// and a screenshot taken meanwhile fails with "Unable to capture screenshot".
const flags = [...(process.env.SMOKE_NO_SANDBOX ? ['--no-sandbox'] : []), ...(process.env.SMOKE_NO_GPU ? ['--disable-gpu'] : [])]
const launch = (extra = {}) =>
  electron.launch({
    ...(process.env.SMOKE_APP ? { executablePath: process.env.SMOKE_APP, args: flags } : { args: [root, ...flags] }),
    env: { ...appEnv, BRANCHLINE_USER_DATA: join(artifacts, 'userdata'), BRANCHLINE_OPEN: repo, ...extra }
  })
let app = await launch()
const errors = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})

  const row = (subject) => page.locator('.row[data-sha]', { hasText: subject })
  const where = page.locator('.where strong')

  // --- Graph loads with the WIP row selected
  await page.waitForSelector('.row[data-sha]')
  check((await page.locator('.row[data-sha]').count()) === 12, 'graph shows 11 commits plus the uncommitted-changes row')
  check(await page.locator('.row.wip.selected').isVisible(), 'uncommitted-changes row is selected by default')
  check((await where.textContent()) === 'main', 'toolbar shows the current branch')
  check((await page.locator('[data-tool=push] .tool-badge').textContent()) === '1', 'push shows 1 commit ahead')
  check(await page.locator('.pill.head', { hasText: 'main' }).isVisible(), 'HEAD branch pill is highlighted')
  check((await page.locator('.pill.stash').count()) === 1, 'stash appears in the graph')
  await shot(page, 'graph-wip')

  // --- Working tree panel and a working-tree diff
  check((await page.locator('[data-list=unstaged]').textContent()).includes('Unstaged · 3'), 'three unstaged files listed')
  check((await page.locator('[data-list=staged]').textContent()).includes('Staged · 1'), 'one staged file listed')
  await page.locator('.file-row', { hasText: 'README.md' }).click()
  await page.waitForSelector('.dl.add')
  check((await page.locator('.dl.add .code').first().textContent()) === 'A repository for viewer tests.', 'unstaged diff shows the edited line')
  check((await marked(page)) === 'viewer ', 'changed words are marked inside the line')
  await shot(page, 'diff-unified')
  await page.locator('.seg button', { hasText: 'Split' }).click()
  await page.waitForSelector('.half.del')
  await shot(page, 'diff-split')
  await page.locator('.seg button', { hasText: 'Unified' }).click()

  // --- Stage, then commit
  await page.locator('.file-row', { hasText: 'README.md' }).locator('button[title^=Stage]').click()
  await page.waitForFunction(() => document.querySelector('[data-list=staged]')?.textContent?.includes('Staged · 2'))
  await page.locator('.diff-pane').waitFor({ state: 'hidden', timeout: 3000 })
  console.log('ok  diff closes when its file leaves the unstaged list')
  await page.locator('.commit-box textarea').fill('Smoke test commit')
  await page.locator('.commit-box button').click()
  await row('Smoke test commit').waitFor()
  check((await page.locator('[data-tool=push] .tool-badge').textContent()) === '2', 'commit lands and push shows 2 ahead')
  check((await page.locator('.commit-box textarea').inputValue()) === '', 'message box clears after committing')

  // --- Commit detail and a committed diff with syntax colouring
  await row('Require a password').click()
  await page.waitForSelector('.detail .file-row')
  check((await page.locator('.detail .subject').textContent()) === 'Require a password', 'detail panel shows the selected commit')
  check((await page.locator('.meta').textContent()).includes('Grace Hopper'), 'detail panel shows the author')
  await page.locator('.detail .file-row', { hasText: 'login.ts' }).click()
  await page.waitForSelector('.dl.add .hljs-keyword')
  check((await marked(page)) === ', pass: string', 'committed diff marks the inserted parameter')
  await shot(page, 'commit-diff')
  await page.locator('.diff-bar .btn', { hasText: 'Graph' }).click()
  check(!(await page.locator('.diff-pane').isVisible()), 'Graph button returns from the diff')

  // --- A message wrapped at 72 columns is re-flowed to the panel's width
  await row('Add util module').click()
  const msgBody = page.locator('[data-message-body]')
  await msgBody.waitFor()
  check((await msgBody.locator('p').first().textContent()) === 'Helpers shared by the login form and the search code, kept in one place so they can be tested on their own.', 'a wrapped paragraph in a commit message reads as one paragraph')
  check(
    JSON.stringify(await msgBody.locator('li').allTextContents()) === JSON.stringify(['add(a, b) for now, with room for more arithmetic later', 'No dependencies']),
    'a wrapped list item reads as one item'
  )
  check((await msgBody.locator('.trailers span').allTextContents()).join('|') === 'Reviewed-by: Grace Hopper <grace@example.com>', 'trailers stay on their own lines')
  await shot(page, 'commit-message')

  // --- Merge commit and parent navigation
  await row("Merge branch 'feature/login'").click()
  await page.waitForFunction(() => document.querySelector('.kicker')?.textContent?.includes('Merge commit'))
  check((await page.locator('.meta .link').count()) === 2, 'merge commit lists two parents')
  await page.locator('.meta .link').nth(1).click()
  await page.waitForFunction(() => document.querySelector('.detail .subject')?.textContent === 'Require a password')
  console.log('ok  clicking a parent navigates to it')

  // --- Stash detail
  await page.locator('.side-row', { hasText: 'main: experiment' }).click()
  await page.waitForSelector('.detail .file-row >> text=scratch.txt')
  check((await page.locator('.kicker').first().textContent()).includes('Stash'), 'stash shows as a stash, with its untracked file')

  // --- Sidebar checkout
  await page.locator('.side-row', { hasText: 'search' }).click()
  await page.locator('.side-row .row-btn', { hasText: 'Checkout' }).click()
  await page.waitForFunction(() => document.querySelector('.where strong')?.textContent === 'feature/search')
  console.log('ok  checkout from the sidebar switches branch')
  await shot(page, 'checked-out-feature')
  await page.locator('[data-section=local] .side-row', { hasText: 'main' }).dblclick()
  await page.waitForFunction(() => document.querySelector('.where strong')?.textContent === 'main')
  console.log('ok  double-click checks out too')

  // --- A failing action surfaces git's own message
  check((await page.locator('.side-row', { hasText: 'task-1' }).locator('.row-btn').count()) === 0, 'a branch held by another worktree offers no checkout')
  await page.locator('[data-tool=pull]').click()
  await page.waitForSelector('.notice')
  await shot(page, 'pull-result')

  // --- Create a branch from the toolbar
  await page.locator('[data-tool=createBranch]').click()
  await page.locator('.modal input[aria-label="Branch name"]').fill('bad..name')
  await page.locator('.modal button[type=submit]').click()
  await page.waitForSelector('.notice.error')
  check((await page.locator('.notice.error').textContent()).includes('not a valid branch name'), 'invalid branch name is rejected with a reason')
  await page.locator('.modal input[aria-label="Branch name"]').fill('smoke/new-branch')
  await page.locator('.modal button[type=submit]').click()
  await page.waitForFunction(() => document.querySelector('.where strong')?.textContent === 'smoke/new-branch')
  check((await page.locator('[data-tool=push] span').first().textContent()) === 'Publish', 'a branch with no upstream offers Publish')
  await page.locator('[data-section=local] .side-row', { hasText: /^main/ }).dblclick()
  await page.waitForFunction(() => document.querySelector('.where strong')?.textContent === 'main')

  // --- File history and blame
  await row('Require a password').click()
  await page.locator('.detail .file-row', { hasText: 'login.ts' }).click()
  await page.locator('[data-view=history]').click()
  await page.waitForSelector('.history-row')
  check((await page.locator('.history-row').count()) === 2, 'file history lists the two commits that touched the file')
  await shot(page, 'file-history')
  await page.locator('.history-row', { hasText: 'Add login form' }).click()
  await page.waitForFunction(() => document.querySelector('.detail .subject')?.textContent === 'Add login form')
  check(await page.locator('.diff-pane').isVisible(), 'picking a history entry shows that commit while the history stays open')
  check((await page.locator('.history .dl.add .code').first().textContent()) === 'export function login(user: string): boolean {', 'and shows the file as that commit changed it')
  await page.locator('[data-view=blame]').click()
  await page.waitForSelector('.bl')
  check((await page.locator('.bl').count()) === 3, 'blame shows every line of the file')
  check(
    (await page.locator('.bl.first .blame-summary').allTextContents()).join(' | ') === 'Require a password | Add login form',
    'blame attributes lines to the commits that last changed them'
  )
  await shot(page, 'blame')
  await page.locator('.diff-bar .btn', { hasText: 'Graph' }).click()

  // --- The same views from a file's right-click menu
  await row('Use login in main').click()
  await page.locator('.detail .file-row', { hasText: 'app.ts' }).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Blame' }).click()
  await page.waitForSelector('.bl')
  check((await page.locator('[data-view=blame].on').count()) === 1, 'right-clicking a file opens blame directly')
  await page.locator('.diff-bar .btn', { hasText: 'Graph' }).click()

  // --- Commit right-click menu
  const order = async () => (await page.locator('.row[data-sha]:not(.wip) .cell.msg').allTextContents()).slice(0, 2)
  const item = (label) => page.locator('.menu-item', { hasText: label })
  const menuFor = async (subject) => {
    await row(subject).first().click({ button: 'right' })
    await page.waitForSelector('.menu')
  }
  await menuFor('Tweak greeting')
  check((await page.locator('.menu-item').count()) === 17, 'commit menu offers its seventeen actions')
  check(await item('Cherry pick commit').isDisabled(), 'cherry-pick is off for a commit already on the branch')
  check(await item('Copy link to this commit on remote').isDisabled(), 'copy link is off when the remote is a local folder')
  await shot(page, 'commit-menu')
  const tweakSha = await row('Tweak greeting').getAttribute('data-sha')
  await item('Copy commit SHA').click()
  check((await app.evaluate(({ clipboard }) => clipboard.readText())) === tweakSha, 'Copy commit SHA puts the full SHA on the clipboard')

  // Edit message
  await menuFor('Tweak greeting')
  await item('Edit commit message').click()
  await page.waitForFunction(() => document.querySelector('.message-edit')?.value === 'Tweak greeting')
  check((await page.locator('.modal .callout').count()) === 0, 'no pushed-history warning for an unpushed commit')
  await page.locator('.message-edit').fill('Tweak the greeting\n\nReworded from the menu.')
  await page.locator('.modal .btn.primary').click()
  await row('Tweak the greeting').waitFor()
  // (An older copy of each rewritten commit lives on under smoke/new-branch, so look at the tip.)
  check((await order()).join(' > ') === 'Smoke test commit > Tweak the greeting', 'rewording an older commit keeps the commits after it')

  await menuFor('Use login in main')
  await item('Edit commit message').click()
  await page.waitForSelector('.modal .callout')
  console.log('ok  editing a pushed commit warns that it rewrites pushed history')
  await page.locator('.modal .btn', { hasText: 'Cancel' }).click()

  // Move
  await menuFor('Smoke test commit')
  await item('Move commit down').click()
  await page.waitForFunction(() => document.querySelectorAll('.row[data-sha]:not(.wip) .cell.msg')[0]?.textContent === 'Tweak the greeting')
  check((await order()).join(' > ') === 'Tweak the greeting > Smoke test commit', 'Move commit down swaps it with its parent')

  // Reset (hard) spells out what would be lost, and can be cancelled
  await menuFor('Use login in main')
  await item('(hard)').click()
  check((await page.locator('.modal .callout.danger').textContent()).includes('2 files will be discarded'), 'hard reset says how many uncommitted files it would discard')
  await page.locator('.modal .btn', { hasText: 'Cancel' }).click()
  check((await order())[0] === 'Tweak the greeting', 'cancelling a reset changes nothing')

  // Drop
  await menuFor('Smoke test commit')
  await item('Drop commit').click()
  await page.locator('.modal .btn.danger', { hasText: 'Drop commit' }).click()
  await page.waitForFunction(() => document.querySelector('[data-tool=push] .tool-badge')?.textContent === '1')
  check((await order())[0] === 'Tweak the greeting', 'Drop commit removes it from the branch after confirming')

  // Cherry-pick, then revert
  await menuFor('Rename util to math and add search')
  await item('Cherry pick commit').click()
  await page.waitForFunction(() => document.querySelectorAll('.row[data-sha]:not(.wip) .cell.msg')[0]?.textContent === 'Rename util to math and add search')
  console.log('ok  Cherry pick commit copies it onto the current branch')
  await menuFor('Rename util to math and add search')
  await item('Revert commit').click()
  await row('Revert "Rename util to math and add search"').waitFor()
  console.log('ok  Revert commit adds a reverting commit')

  // Patch (the native save dialog is answered for the test)
  const patchPath = join(artifacts, 'out.patch')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, patchPath)
  await menuFor('Tweak the greeting')
  await item('Create patch from commit').click()
  await page.waitForFunction(() => document.querySelector('.notice')?.textContent?.includes('Saved patch'))
  check(readFileSync(patchPath, 'utf8').includes('Subject: [PATCH] Tweak the greeting'), 'Create patch writes a patch file')

  // Worktree
  await menuFor('Document usage')
  await item('Create worktree from this commit').click()
  await page.locator('.modal input[aria-label="Worktree branch name"]').fill('smoke/wt')
  check((await page.locator('.modal input[aria-label="Worktree folder"]').inputValue()).endsWith('/repo-smoke-wt'), 'worktree folder follows the branch name')
  await page.locator('.modal .check input').uncheck()
  await page.locator('.modal button[type=submit]').click()
  await page.locator('.side-row', { hasText: 'repo-smoke-wt' }).waitFor()
  console.log('ok  Create worktree adds a worktree on a new branch')

  // The same menu from a visible button
  await row('Tweak the greeting').click()
  await page.locator('[data-more=commit]').click()
  await page.waitForSelector('.menu')
  await page.keyboard.press('Escape')
  await page.locator('.menu').waitFor({ state: 'detached' })
  console.log('ok  the More button opens the same menu, and it closes')

  // --- Create tag
  await menuFor('Document usage')
  await item('Create tag here').click()
  await page.locator('.modal input[aria-label="Tag name"]').fill('smoke-tag')
  await page.locator('.modal button[type=submit]').click()
  await page.locator('[data-section=tags] .side-row', { hasText: 'smoke-tag' }).waitFor()
  check(gitIn(repo, 'tag', '-l', 'smoke-tag').trim() === 'smoke-tag', 'Create tag here creates the tag')

  // --- Branch menus and deleting branches
  const local = (name) => page.locator('[data-section=local] .side-row', { hasText: name })
  const remote = (name) => page.locator('[data-section=remote] .side-row', { hasText: name })
  await local(/^main/).click({ button: 'right' })
  check(await item('Delete main').isDisabled(), 'the checked-out branch cannot be deleted')
  await page.keyboard.press('Escape')
  await local('task-1').click({ button: 'right' })
  check(await item('Delete agent/task-1').isDisabled(), 'a branch held by another worktree cannot be deleted')
  await page.keyboard.press('Escape')

  await page.locator('.pill.branch', { hasText: 'feature/search' }).click({ button: 'right' })
  check(await item('Delete feature/search').isEnabled(), 'right-clicking a branch label in the graph opens the branch menu')
  await page.keyboard.press('Escape')

  // smoke/new-branch still holds the pre-rewrite "Smoke test commit". Its parent, the old
  // "Tweak greeting", is also under agent/task-1, so exactly one commit is unique to it.
  await local('new-branch').click({ button: 'right' })
  await item('Delete smoke/new-branch').click()
  await page.waitForSelector('.modal [data-lost]')
  check((await page.locator('.modal [data-lost]').textContent()).includes('1 commit is on no other branch'), 'delete says how many commits only that branch holds')
  check((await page.locator('.modal .check').count()) === 0, 'no remote checkbox for a branch with no remote copy')
  await shot(page, 'delete-branch')
  await page.locator('.modal .btn.danger').click()
  await local('new-branch').waitFor({ state: 'detached' })
  check(!gitIn(repo, 'branch', '--list').includes('smoke/new-branch'), 'Delete removes the local branch')

  // A branch that exists only on the remote: delete it there.
  const originDir = join(artifacts, 'fixture', 'origin.git')
  gitIn(repo, 'push', '-q', 'origin', 'main:refs/heads/remote-only')
  await remote('remote-only').waitFor()
  await remote('remote-only').click({ button: 'right' })
  await item('Delete origin/remote-only from remote').click()
  await page.waitForSelector('.modal [data-lost="0"]')
  await page.locator('.modal .btn.danger', { hasText: 'Delete from remote' }).click()
  await remote('remote-only').waitFor({ state: 'detached' })
  check(!gitIn(originDir, 'for-each-ref').includes('refs/heads/remote-only'), 'Delete from remote removes the branch from the remote repository')

  // feature/login has a same-named copy on origin, so it offers to delete both at once.
  await local('login').click({ button: 'right' })
  await item('Delete feature/login').click()
  await page.waitForSelector('.modal [data-lost="0"]')
  check((await page.locator('.modal .check').textContent()).includes('origin/feature/login'), 'a branch with a remote copy offers to delete that too')
  check((await page.locator('.modal .btn.danger').textContent()) === 'Delete branch', 'the remote copy is left alone unless asked')
  await page.locator('.modal .check input').check()
  await page.locator('.modal .btn.danger', { hasText: 'Delete local and remote' }).click()
  await local('login').waitFor({ state: 'detached' })
  await remote('login').waitFor({ state: 'detached' })
  check(!gitIn(repo, 'branch', '--list').includes('feature/login'), 'Delete local and remote removes the local branch')
  check(!gitIn(originDir, 'for-each-ref').includes('refs/heads/feature/login'), 'and its copy on the remote')
  check(gitIn(originDir, 'for-each-ref').includes('refs/heads/main'), 'and nothing else there')

  await local('search').click()
  await local('search').locator('button[aria-label^="More actions"]').click()
  await page.waitForSelector('.menu')
  await page.keyboard.press('Escape')
  console.log('ok  the row button opens the branch menu too')

  // --- Search
  await page.locator('.search input').fill('login')
  await page.waitForSelector('.row.dim')
  // Three subjects mention login. (A fourth commit matched by its feature/login label until
  // that branch was deleted above.)
  check((await page.locator('.search-count').textContent()).endsWith('/ 3'), 'search finds the three commits mentioning login')
  await page.locator('.search button[title="Next match"]').click()
  await shot(page, 'search')
  await page.locator('.search button[title="Clear search"]').click()

  // --- Live refresh: changes made outside the app appear on their own
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'Commit made outside the app')
  await row('Commit made outside the app').waitFor({ timeout: 5000 })
  console.log('ok  a commit made by another process appears without a refresh')
  check((await page.locator('.wip-count').textContent()) === '2 files', 'two uncommitted files before the outside edit')
  writeFileSync(join(repo, 'agent-scratch.txt'), 'written by another process\n')
  await page.waitForFunction(() => document.querySelector('.wip-count')?.textContent === '3 files', null, { timeout: 8000 })
  console.log('ok  a file edited outside the app updates the uncommitted count')

  // --- Open a linked worktree as its own tab
  await page.locator('.side-row', { hasText: 'repo-agent' }).click()
  await page.locator('.side-row .row-btn', { hasText: 'Open' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2)
  await page.waitForFunction(() => [...document.querySelectorAll('.where strong')].some((e) => e.textContent === 'agent/task-1' && e.offsetParent))
  console.log('ok  a worktree opens in a second tab on its own branch')
  await shot(page, 'worktree-tab')

  // --- Theme toggle and welcome screen
  const before = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.locator('.tabbar .theme').click()
  check((await page.evaluate(() => document.documentElement.dataset.theme)) !== before, 'theme toggle switches theme')
  await page.locator('.tab', { hasText: 'repo' }).first().click()
  await page.locator('.row[data-sha]').first().waitFor()
  await shot(page, 'other-theme')
  await page.locator('.tabbar .theme').click()
  await page.locator('.tab-add').click()
  await page.waitForSelector('.welcome .recent')
  check((await page.locator('.welcome .recent').count()) === 2, 'welcome screen lists both recent repositories')
  await shot(page, 'welcome')
  await page.locator('.welcome .btn', { hasText: 'Cancel' }).click()

  // --- Worktree actions (the repo-agent worktree is also open as the second tab)
  await page.locator('.tab', { hasText: 'repo' }).first().click()
  await page.locator('.tab-body:not([hidden]) .row[data-sha]').first().waitFor()
  const tree = (name) => page.locator('.tab-body:not([hidden]) [data-section=worktrees] .side-row', { hasText: name })
  const smokeTree = join(artifacts, 'fixture', 'repo-smoke-wt')

  writeFileSync(join(smokeTree, 'scratch.txt'), 'left behind\n')
  await tree('repo-smoke-wt').getByText('1 uncommitted').waitFor({ timeout: 20000 })
  console.log('ok  a worktree row shows how many uncommitted changes it holds')
  await tree('repo-smoke-wt').click({ button: 'right' })
  check(await item('Remove worktree').isDisabled(), 'a worktree with uncommitted changes cannot be removed')
  check((await item('Remove worktree').getAttribute('title')).includes('1 uncommitted change'), 'and the menu says why')
  check(await item(reveal).isEnabled(), `the worktree menu offers ${reveal}`)
  await shot(page, 'worktree-menu')
  await item('Copy path').click()
  check((await app.evaluate(({ clipboard }) => clipboard.readText())) === smokeTree, 'Copy path puts the worktree folder on the clipboard')

  rmSync(join(smokeTree, 'scratch.txt'))
  await tree('repo-smoke-wt').getByText('uncommitted').waitFor({ state: 'detached', timeout: 20000 })
  await tree('repo-smoke-wt').click()
  await tree('repo-smoke-wt').locator('button[aria-label^="More actions"]').click()
  await item('Remove worktree').click()
  check((await page.locator('.modal .btn.danger').textContent()) === 'Remove worktree', 'the branch is kept unless asked')
  await page.locator('.modal .check input').check()
  await page.waitForSelector('.modal [data-lost="0"]')
  await page.locator('.modal .btn.danger', { hasText: 'Remove worktree and branch' }).click()
  await tree('repo-smoke-wt').waitFor({ state: 'detached' })
  check(!existsSync(smokeTree), 'Remove worktree deletes the folder')
  check(!gitIn(repo, 'branch', '--list').includes('smoke/wt'), 'and its branch when asked')

  // A worktree whose folder vanished: it shows as missing, and pruning frees its branch.
  rmSync(worktree, { recursive: true })
  await tree('repo-agent').getByText('missing').waitFor({ timeout: 15000 })
  await page.locator('.tab-body:not([hidden]) [data-section=local] .side-row', { hasText: 'task-1' }).click({ button: 'right' })
  check(await item('Delete agent/task-1').isDisabled(), 'a missing worktree still holds its branch')
  await page.keyboard.press('Escape')
  await shot(page, 'worktree-missing')
  await page.locator('.tab-body:not([hidden]) .side-note .row-btn', { hasText: 'Prune' }).click()
  await tree('repo-agent').waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1)
  console.log('ok  Prune forgets the missing worktree and closes its tab')
  await page.locator('.tab-body:not([hidden]) [data-section=local] .side-row', { hasText: 'task-1' }).click({ button: 'right' })
  check(await item('Delete agent/task-1').isEnabled(), 'after pruning, its branch can be deleted')
  await page.keyboard.press('Escape')

  if (extra) {
    const t0 = Date.now()
    await page.evaluate((p) => window.api.openRepo(p), extra)
    await page.reload()
    await page.waitForFunction(() => [...document.querySelectorAll('.tab-body')].some((b) => !b.hidden && b.querySelectorAll('.row[data-sha]').length > 20), null, { timeout: 30000 })
    console.log(`ok  real repository rendered in ${Date.now() - t0} ms (including reload)`)
    await shot(page, 'real-repo')

    // Older history pages in when the list is scrolled to its end.
    const body = page.locator('.tab-body:not([hidden])')
    const height = () => body.locator('.graph-rows').evaluate((e) => e.offsetHeight)
    const before = await height()
    if ((await body.locator('.loading-more').count()) > 0 || before >= 5000 * 26) {
      await body.locator('.graph-scroll').evaluate((e) => (e.scrollTop = e.scrollHeight))
      await page.waitForFunction((h) => document.querySelector('.tab-body:not([hidden]) .graph-rows').offsetHeight > h, before, { timeout: 15000 })
      console.log(`ok  scrolling to the end loaded more history (${before / 26} -> ${(await height()) / 26} rows)`)
      await body.locator('.graph-scroll').evaluate((e) => (e.scrollTop = e.scrollHeight * 0.6))
      await page.waitForTimeout(300)
      await shot(page, 'real-repo-deep')
    }
  }

  // --- Zoom, including whether it survives a restart
  const zoomFactor = (a) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
  const level = (p) => p.locator('.zoom-level')
  const fits = (p) =>
    p.evaluate(() => {
      const bar = document.querySelector('.tab-body:not([hidden]) .toolbar')
      const tools = [...bar.querySelectorAll('.tool, .search')].map((e) => e.getBoundingClientRect())
      const overlap = tools.some((a, i) => tools.some((b, j) => j > i && a.right > b.left + 1 && a.left < b.right - 1))
      // The graph must stay inside its own pane, and a commit message must stay readable.
      const pane = document.querySelector('.tab-body:not([hidden]) .graph-pane').getBoundingClientRect()
      const head = [...document.querySelectorAll('.tab-body:not([hidden]) .graph-head .cell')].filter((c) => c.offsetParent)
      const headFits = head.every((c) => c.getBoundingClientRect().right <= pane.right + 1)
      const message = document.querySelector('.tab-body:not([hidden]) .row[data-sha]:not(.wip) .cell.msg').getBoundingClientRect()
      return (
        bar.scrollWidth <= bar.clientWidth + 1 &&
        document.documentElement.scrollWidth <= window.innerWidth + 1 &&
        !overlap &&
        headFits &&
        message.right <= pane.right + 1 &&
        message.width >= 90
      )
    })
  await page.locator('.tab', { hasText: 'repo' }).first().click()
  const widthBefore = await page.evaluate(() => window.innerWidth)
  check((await level(page).textContent()) === '100%' && (await level(page).isDisabled()), 'zoom starts at 100% with nothing to reset')
  for (const expected of ['110%', '125%', '150%']) {
    await page.locator('.zoom button[aria-label="Make everything larger"]').click()
    await page.waitForFunction((t) => document.querySelector('.zoom-level')?.textContent === t, expected)
  }
  check(Math.abs((await zoomFactor(app)) - 1.5) < 0.001, 'the larger button zooms the window to 150%')
  check(Math.abs((await page.evaluate(() => window.innerWidth)) - widthBefore / 1.5) < 3, 'and the page really is laid out larger')
  check(await fits(page), 'at 150% the toolbar and graph still fit, with no overlap or sideways scrolling')
  check((await page.locator('.tab-body:not([hidden]) .row[data-sha]').count()) > 5, 'and the graph still renders')
  await shot(page, 'zoom-150')
  for (const expected of ['175%', '200%']) {
    await page.locator('.zoom button[aria-label="Make everything larger"]').click()
    await page.waitForFunction((t) => document.querySelector('.zoom-level')?.textContent === t, expected)
  }
  check(await page.locator('.zoom button[aria-label="Make everything larger"]').isDisabled(), 'zoom stops at 200%')
  check(await fits(page), 'at 200% they still fit')
  await shot(page, 'zoom-200')
  for (const expected of ['175%', '150%', '125%']) {
    await page.locator('.zoom button[aria-label="Make everything smaller"]').click()
    await page.waitForFunction((t) => document.querySelector('.zoom-level')?.textContent === t, expected)
  }
  check(JSON.parse(readFileSync(join(artifacts, 'userdata', 'state.json'), 'utf8')).zoom === 1.25, 'the zoom level is saved')

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await app.close()
  app = await launch()
  const reopened = await app.firstWindow()
  await reopened.waitForFunction(() => document.querySelector('.zoom-level')?.textContent === '125%')
  await reopened.locator('.row[data-sha]').first().waitFor()
  check(Math.abs((await zoomFactor(app)) - 1.25) < 0.001, 'after a restart the window opens at the saved zoom')
  await reopened.locator('.zoom-level').click()
  await reopened.waitForFunction(() => document.querySelector('.zoom-level')?.textContent === '100%')
  check(Math.abs((await zoomFactor(app)) - 1) < 0.001, 'clicking the percentage returns to normal size')

  // --- git missing or too old: say so, and keep the tabs for when it is fixed
  await app.close()
  app = await launch({ BRANCHLINE_GIT: join(artifacts, 'no-such-git') })
  const noGit = await app.firstWindow()
  await noGit.waitForSelector('[data-git-problem]')
  check((await noGit.locator('[data-git-problem]').textContent()).includes('git was not found'), 'a missing git is reported in plain words')
  check((await noGit.locator('.tab').count()) === 1, 'and the open tab is kept')
  await shot(noGit, 'git-missing')

  // The stand-in for an old git is a shell script, which Windows cannot run directly.
  if (process.platform !== 'win32') {
    const oldGit = join(artifacts, 'old-git')
    writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.20.1"\n')
    chmodSync(oldGit, 0o755)
    await app.close()
    app = await launch({ BRANCHLINE_GIT: oldGit })
    const tooOld = await app.firstWindow()
    await tooOld.waitForSelector('[data-git-problem]')
    check((await tooOld.locator('[data-git-problem]').textContent()).includes('needs git 2.31 or newer'), 'a git that is too old is reported with the version needed')
    await shot(tooOld, 'git-too-old')

    // Fix git while the app is open: the warning clears on return, and the kept tab loads.
    writeFileSync(oldGit, '#!/bin/sh\nexec git "$@"\n')
    await tooOld.evaluate(() => window.dispatchEvent(new Event('focus')))
    await tooOld.locator('[data-git-problem]').waitFor({ state: 'detached' })
    console.log('ok  once git works the warning clears when the window is focused again')
    // The same focus event reloads the repository view, so nothing needs clicking.
    await tooOld.locator('.row[data-sha]').first().waitFor()
    console.log('ok  and the tab that was kept loads without reopening it')
  }

  await app.close()
  app = await launch()
  const healthy = await app.firstWindow()
  await healthy.locator('.row[data-sha]').first().waitFor()
  check((await healthy.locator('[data-git-problem]').count()) === 0, 'with a working git there is no warning and the tab loads')
  console.log(`\nAll checks passed. Screenshots: ${shots}`)
} catch (e) {
  const page = app.windows()[0]
  if (page) await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  console.error(String(e?.message ?? e))
  if (errors.length) console.error('console errors:', errors.join(' | '))
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
