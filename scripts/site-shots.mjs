// Product screenshots for the website and README, in light and dark: docs/images/<name>.png and
// docs/images/<name>-dark.png. Uses the same scripted repository as the smoke test, so names and
// history are made up. Run `npm run build` first, then `node scripts/site-shots.mjs`.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { buildFixture } from '../tests/fixture.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, 'tests/.artifacts/site-shots')
const out = join(root, 'docs/images')
rmSync(work, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const { repo } = buildFixture(join(work, 'fixture'))

const env = { ...process.env, BRANCHLINE_USER_DATA: join(work, 'userdata'), BRANCHLINE_OPEN: repo }
delete env.DEVELOPER_DIR
const app = await electron.launch({ args: [root, ...(process.env.SMOKE_NO_SANDBOX ? ['--no-sandbox'] : [])], env })
try {
  const page = await app.firstWindow()
  // Size the window itself rather than emulating a viewport, which would force 1x pixels; on a
  // Retina display this gives 2x images that stay sharp on the website.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 760))
  await page.waitForFunction(() => window.innerWidth === 1280 && window.innerHeight === 760)
  await page.waitForSelector('.row[data-sha]')
  const row = (subject) => page.locator('.row[data-sha]', { hasText: subject }).first()
  const graph = async () => {
    if (await page.locator('.diff-bar .btn', { hasText: 'Graph' }).isVisible()) await page.locator('.diff-bar .btn', { hasText: 'Graph' }).click()
  }
  const settle = () => page.waitForTimeout(300)

  for (const theme of ['light', 'dark']) {
    while ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.locator('.tabbar .theme').click()
    const save = (name, clip) => page.screenshot({ path: join(out, `${name}${theme === 'dark' ? '-dark' : ''}.png`), clip })
    // The website shows some views at half width, so it also gets a crop of just the part that matters.
    const right = async () => (await page.locator('.sidebar').boundingBox()).width

    // The graph with a commit whose message has a paragraph, a list and a trailer.
    await graph()
    await row('Add util module').click()
    await page.locator('[data-message-body]').waitFor()
    await settle()
    await save('graph')

    // A committed diff, side by side, with syntax colouring.
    await row('Require a password').click()
    await page.locator('.detail .file-row', { hasText: 'login.ts' }).click()
    await page.waitForSelector('.dl.add .hljs-keyword')
    await page.locator('.seg button', { hasText: 'Split' }).click()
    await page.waitForSelector('.half.del')
    await settle()
    await save('diff')
    const pane = await page.locator('.diff-pane').boundingBox()
    await save('diff-crop', { x: pane.x, y: pane.y, width: pane.width, height: 200 })
    await page.locator('.seg button', { hasText: 'Unified' }).click()

    // Blame for the same file.
    await page.locator('[data-view=blame]').click()
    await page.waitForSelector('.bl')
    await settle()
    await save('blame')
    await graph()

    // The commit menu.
    await row('Tweak greeting').click({ button: 'right' })
    await page.waitForSelector('.menu')
    await settle()
    await save('menu')
    const menu = await page.locator('.menu').boundingBox()
    const mx = await right()
    await save('menu-crop', { x: mx, y: 0, width: Math.min(1280, menu.x + menu.width + 24) - mx, height: Math.min(760, menu.y + menu.height + 24) })
    await page.keyboard.press('Escape')
    await page.locator('.menu').waitFor({ state: 'detached' }).catch(() => page.mouse.click(5, 450))
  }
  console.log(`Saved to ${out}`)
} finally {
  await app.close()
}
