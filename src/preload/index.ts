import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, AppState } from '../shared/types'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as Reply<T>
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  getState: () => call('app:getState'),
  pickRepo: () => call('app:pickRepo'),
  openRepo: (path) => call('app:openRepo', path),
  closeRepo: (path) => call('app:closeRepo', path),
  setActive: (path) => call('app:setActive', path),
  forgetRecent: (path) => call('app:forgetRecent', path),
  snapshot: (repo, limit, known) => call('repo:snapshot', repo, limit, known),
  commitDetail: (repo, sha, isStash) => call('repo:commitDetail', repo, sha, isStash),
  diff: (repo, spec) => call('repo:diff', repo, spec),
  action: (repo, action) => call('repo:action', repo, action),
  isPublished: (repo, sha) => call('repo:isPublished', repo, sha),
  uniqueCommits: (repo, refNames) => call('repo:uniqueCommits', repo, refNames),
  worktreeChanges: (repo) => call('repo:worktreeChanges', repo),
  blame: (repo, rev, path) => call('repo:blame', repo, rev, path),
  fileHistory: (repo, rev, path) => call('repo:fileHistory', repo, rev, path),
  savePatch: (repo, sha) => call('repo:savePatch', repo, sha),
  pickNewFolder: (defaultPath) => call('app:pickNewFolder', defaultPath),
  getZoom: () => call('app:getZoom'),
  stepZoom: (direction) => call('app:stepZoom', direction),
  onZoomChanged: (cb) => subscribe<number>('zoom:changed', cb),
  showInFinder: (path) => call('app:showInFinder', path),
  copyText: (text) => call('app:copyText', text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onRepoChanged: (cb) => subscribe<string>('repo:changed', cb),
  onStateChanged: (cb) => subscribe<AppState>('state:changed', cb)
}

contextBridge.exposeInMainWorld('api', api)
