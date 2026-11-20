import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeZoom } from '../shared/zoom'

export interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface Persisted {
  tabs: string[]
  active: string | null
  recents: string[]
  bounds: Bounds | null
  /** Zoom factor for the whole window; 1 is normal size. */
  zoom: number
}

const EMPTY: Persisted = { tabs: [], active: null, recents: [], bounds: null, zoom: 1 }
const MAX_RECENTS = 20

/** Tabs, recents, window bounds and zoom, kept in one small JSON file. */
export class Store {
  data: Persisted

  constructor(private readonly file: string) {
    this.data = this.read()
  }

  private read(): Persisted {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      return {
        tabs: strings(raw.tabs),
        active: typeof raw.active === 'string' ? raw.active : null,
        recents: strings(raw.recents),
        bounds: raw.bounds && typeof raw.bounds.width === 'number' ? raw.bounds : null,
        zoom: normalizeZoom(raw.zoom)
      }
    } catch {
      return { ...EMPTY }
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      console.error('Could not save state:', e)
    }
  }

  touchRecent(path: string): void {
    this.data.recents = [path, ...this.data.recents.filter((p) => p !== path)].slice(0, MAX_RECENTS)
  }
}
