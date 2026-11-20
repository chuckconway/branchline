// Renders build/icon.svg to build/icon.icns. Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const build = join(__dirname, '../build')
const iconset = join(build, 'icon.iconset')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const svg = readFileSync(join(build, 'icon.svg'), 'utf8')
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 400))
  const png = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()

  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset)
  const master = join(iconset, 'icon_512x512@2x.png')
  writeFileSync(master, png)
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
    if (size < 512) {
      execFileSync('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')])
  writeFileSync(join(build, 'icon.png'), png)
  rmSync(iconset, { recursive: true, force: true })
  app.quit()
})
