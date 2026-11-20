import { watch, type FSWatcher } from 'node:fs'

const DEBOUNCE_MS = 300

/**
 * Watches a repository's git directory and reports, debounced, when refs, HEAD, the index or
 * the stash move. Object writes and lock files are noise and are ignored. Edits to working
 * files that git has not been told about are picked up by the renderer's status poll instead.
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(gitDir: string, onChange: () => void) {
    try {
      this.watcher = watch(gitDir, { recursive: true }, (_event, filename) => {
        const name = filename ?? ''
        if (name.startsWith('objects') || name.endsWith('.lock')) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(onChange, DEBOUNCE_MS)
      })
      this.watcher.on('error', () => this.close())
    } catch (e) {
      console.error(`Could not watch ${gitDir}:`, e)
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = null
  }
}
