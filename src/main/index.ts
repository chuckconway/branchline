import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Action, AppState, DiffSpec, OpenResult } from '../shared/types'
import { stepZoom } from '../shared/zoom'
import {
  blame,
  commitDetail,
  diff,
  fileHistory,
  forgetRepo,
  formatPatch,
  isKnownWorktree,
  isPublished,
  loadSnapshot,
  resolveRepo,
  runAction,
  uniqueCommits,
  worktreeChanges,
  type RepoInfo
} from './git/repo'
import { Store } from './store'
import { RepoWatcher } from './watch'

// Tests point this at a scratch directory so they never touch real settings.
if (process.env.BRANCHLINE_USER_DATA) app.setPath('userData', process.env.BRANCHLINE_USER_DATA)

const store = new Store(join(app.getPath('userData'), 'state.json'))
const repos = new Map<string, RepoInfo>()
const watchers = new Map<string, RepoWatcher>()
let win: BrowserWindow | null = null
let pendingOpen: string[] = []

function appState(): AppState {
  const { tabs, active, recents } = store.data
  return { tabs, active, recents }
}

function pushState(): void {
  win?.webContents.send('state:changed', appState())
}

/** Zoom is ours to keep: saved with the other settings, and applied to every page load. */
function changeZoom(direction: 1 | -1 | 0): number {
  const factor = stepZoom(store.data.zoom, direction)
  store.data.zoom = factor
  store.save()
  win?.webContents.setZoomFactor(factor)
  win?.webContents.send('zoom:changed', factor)
  return factor
}

function requireRepo(path: unknown): RepoInfo {
  const repo = typeof path === 'string' ? repos.get(path) : undefined
  if (!repo) throw new Error('That repository is not open.')
  return repo
}

function register(info: RepoInfo): void {
  repos.set(info.path, info)
  if (!watchers.has(info.path)) {
    watchers.set(
      info.path,
      new RepoWatcher(info.commonDir, () => win?.webContents.send('repo:changed', info.path))
    )
  }
}

async function openRepo(dir: string): Promise<OpenResult> {
  let info: RepoInfo
  try {
    info = await resolveRepo(dir)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  register(info)
  if (!store.data.tabs.includes(info.path)) store.data.tabs.push(info.path)
  store.data.active = info.path
  store.touchRecent(info.path)
  store.save()
  return { ok: true, path: info.path, state: appState() }
}

function closeRepo(path: string): AppState {
  const i = store.data.tabs.indexOf(path)
  if (i !== -1) {
    store.data.tabs.splice(i, 1)
    if (store.data.active === path) store.data.active = store.data.tabs[Math.min(i, store.data.tabs.length - 1)] ?? null
  }
  watchers.get(path)?.close()
  watchers.delete(path)
  repos.delete(path)
  forgetRepo(path)
  store.save()
  return appState()
}

async function pickRepo(): Promise<OpenResult | null> {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Repository',
    buttonLabel: 'Open',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return null
  return openRepo(result.filePaths[0])
}

/** Reopen last session's tabs, dropping any whose folder is gone or no longer a repository. */
async function restoreTabs(): Promise<void> {
  const kept: string[] = []
  for (const path of store.data.tabs) {
    try {
      const info = await resolveRepo(path)
      register(info)
      kept.push(info.path)
    } catch {
      // Leave it in recents; it may come back.
    }
  }
  store.data.tabs = kept
  if (!store.data.active || !kept.includes(store.data.active)) store.data.active = kept[0] ?? null
  store.save()
}

function isDirectory(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Directories named on the command line: `Branchline /path/to/repo`. */
function directoriesFromArgv(argv: string[]): string[] {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  return args.filter((a) => !a.startsWith('-') && isDirectory(a))
}

async function openPending(): Promise<void> {
  const dirs = pendingOpen
  pendingOpen = []
  let opened = false
  for (const dir of dirs) {
    const result = await openRepo(dir)
    if (result.ok) opened = true
    else if (win) dialog.showMessageBox(win, { type: 'warning', message: 'Could not open repository', detail: result.error })
  }
  if (opened) pushState()
}

type Handler = (...args: never[]) => unknown

/** IPC replies are wrapped so the renderer sees git's own error text, not Electron's prefix. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await (fn as (...a: unknown[]) => unknown)(...args) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

function registerIpc(): void {
  handle('app:getState', () => appState())
  handle('app:pickRepo', () => pickRepo())
  handle('app:openRepo', (path: string) => openRepo(String(path)))
  handle('app:closeRepo', (path: string) => closeRepo(String(path)))
  handle('app:setActive', (path: string | null) => {
    if (path === null || store.data.tabs.includes(path)) {
      store.data.active = path
      store.save()
    }
  })
  handle('app:forgetRecent', (path: string) => {
    store.data.recents = store.data.recents.filter((p) => p !== path)
    store.save()
    return appState()
  })
  handle('app:showInFinder', (path: string) => {
    // Only reveal folders that belong to a repository the user opened, or one of its worktrees.
    const known = [...repos.values()].some((r) => path === r.path || path.startsWith(r.path + '/'))
    if (known || store.data.recents.includes(path) || isKnownWorktree(path)) shell.showItemInFolder(path)
  })
  handle('app:getZoom', () => store.data.zoom)
  handle('app:stepZoom', (direction: number) => changeZoom(direction > 0 ? 1 : direction < 0 ? -1 : 0))
  handle('app:copyText', (text: string) => clipboard.writeText(String(text)))
  handle('repo:snapshot', (repo: string, limit: number, known: string | null) => {
    const n = Math.max(1, Math.min(Number(limit) || 1, 500_000))
    return loadSnapshot(requireRepo(repo), n, typeof known === 'string' ? known : null)
  })
  handle('repo:commitDetail', (repo: string, sha: string, isStash: boolean) => commitDetail(requireRepo(repo), String(sha), Boolean(isStash)))
  handle('repo:diff', (repo: string, spec: DiffSpec) => diff(requireRepo(repo), spec))
  handle('repo:action', (repo: string, action: Action) => runAction(requireRepo(repo), action))
  handle('repo:isPublished', (repo: string, sha: string) => isPublished(requireRepo(repo), String(sha)))
  handle('repo:uniqueCommits', (repo: string, refNames: string[]) => uniqueCommits(requireRepo(repo), Array.isArray(refNames) ? refNames.map(String) : []))
  handle('repo:worktreeChanges', (repo: string) => worktreeChanges(requireRepo(repo)))
  handle('repo:blame', (repo: string, rev: string | null, path: string) => blame(requireRepo(repo), rev ? String(rev) : null, String(path)))
  handle('repo:fileHistory', (repo: string, rev: string | null, path: string) => fileHistory(requireRepo(repo), rev ? String(rev) : null, String(path)))
  handle('repo:savePatch', async (repo: string, sha: string) => {
    const info = requireRepo(repo)
    const patch = await formatPatch(info, String(sha))
    const subject = /^Subject: (?:\[PATCH[^\]]*\] )?(.*)$/m.exec(patch)?.[1] ?? 'commit'
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'commit'
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Patch',
      defaultPath: join(dirname(info.path), `${String(sha).slice(0, 7)}-${slug}.patch`),
      filters: [{ name: 'Patch', extensions: ['patch'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, patch)
    return result.filePath
  })
  handle('app:pickNewFolder', async (defaultPath: string) => {
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: 'Worktree Location',
      defaultPath: String(defaultPath),
      buttonLabel: 'Use This Location',
      nameFieldLabel: 'Folder name:',
      properties: ['createDirectory']
    })
    return result.canceled || !result.filePath ? null : result.filePath
  })
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Repository…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await pickRepo()
            if (result?.ok) pushState()
            else if (result && win) dialog.showMessageBox(win, { type: 'warning', message: 'Could not open repository', detail: result.error })
          }
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Not the built-in zoom roles: those bypass the saved setting and the on-screen control.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => void changeZoom(0) },
        { label: 'Make Everything Larger', accelerator: 'CmdOrCtrl+Plus', click: () => void changeZoom(1) },
        { label: 'Make Everything Smaller', accelerator: 'CmdOrCtrl+-', click: () => void changeZoom(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const bounds = store.data.bounds ?? { width: 1440, height: 900 }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Branchline',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Chromium forgets or half-remembers zoom across loads, so set it every time one finishes.
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomFactor(store.data.zoom))
  win.once('ready-to-show', () => win?.show())
  win.on('close', () => {
    if (win && !win.isFullScreen()) store.data.bounds = win.getNormalBounds()
    store.save()
  })
  win.on('closed', () => {
    win = null
  })

  // The UI is a single local page: never navigate away from it or open new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    pendingOpen.push(...directoriesFromArgv(argv))
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      void openPending()
    }
  })

  // Folders dropped on the Dock icon or opened with `open -a`.
  app.on('open-file', (e, path) => {
    e.preventDefault()
    pendingOpen.push(path)
    if (app.isReady() && win) void openPending()
  })

  app.whenReady().then(async () => {
    pendingOpen.push(...directoriesFromArgv(process.argv))
    if (process.env.BRANCHLINE_OPEN) pendingOpen.push(process.env.BRANCHLINE_OPEN)
    registerIpc()
    buildMenu()
    await restoreTabs()
    await openPending()
    createWindow()

    app.on('activate', () => {
      if (!win) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    for (const w of watchers.values()) w.close()
    app.quit()
  })
}
