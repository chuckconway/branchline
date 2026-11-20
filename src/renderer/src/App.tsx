import { AArrowDown, AArrowUp, FolderGit2, FolderOpen, Moon, Plus, Sun, X } from 'lucide-react'
import { MAX_ZOOM, MIN_ZOOM } from '../../shared/zoom'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppState, OpenResult } from '../../shared/types'
import { RepoView } from './RepoView'
import { useStored } from './ui'

type ThemePref = 'system' | 'light' | 'dark'

function useTheme(): [theme: 'light' | 'dark', toggle: () => void] {
  const [pref, setPref] = useStored<ThemePref>('theme', 'system')
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const theme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return [theme, () => setPref(theme === 'dark' ? 'light' : 'dark')]
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path

export function App(): ReactNode {
  const [state, setState] = useState<AppState | null>(null)
  const [picking, setPicking] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [theme, toggleTheme] = useTheme()
  const [zoom, setZoom] = useState(1)
  const [gitProblem, setGitProblem] = useState<string | null>(null)
  const checkGit = useCallback(() => void window.api.gitInfo().then((info) => setGitProblem(info.ok ? null : info.error)), [])
  useEffect(() => {
    checkGit()
    // Fixing git happens in another app, so look again whenever this window gets the focus back.
    window.addEventListener('focus', checkGit)
    return () => window.removeEventListener('focus', checkGit)
  }, [checkGit])

  useEffect(() => {
    void window.api.getZoom().then(setZoom)
    return window.api.onZoomChanged(setZoom)
  }, [])
  const stepZoom = (direction: 1 | -1 | 0): void => void window.api.stepZoom(direction).then(setZoom)

  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onStateChanged((s) => {
      setState(s)
      setPicking(false)
    })
  }, [])

  const applyOpen = useCallback((result: OpenResult | null) => {
    if (!result) return
    if (result.ok) {
      setState(result.state)
      setPicking(false)
      setOpenError(null)
    } else {
      setOpenError(result.error)
      setPicking(true)
    }
  }, [])

  const stateRef = useRef(state)
  stateRef.current = state
  const closeIfOpen = useCallback((path: string) => {
    if (stateRef.current?.tabs.includes(path)) void window.api.closeRepo(path).then(setState)
  }, [])

  const openPath = useCallback((path: string) => void window.api.openRepo(path).then(applyOpen), [applyOpen])
  const pick = useCallback(() => void window.api.pickRepo().then(applyOpen), [applyOpen])

  const activate = (path: string): void => {
    setPicking(false)
    setOpenError(null)
    setState((s) => (s ? { ...s, active: path } : s))
    void window.api.setActive(path)
  }

  // Dropping a folder anywhere on the window opens it.
  useEffect(() => {
    const over = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setDropping(true)
    }
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) setDropping(false)
    }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      setDropping(false)
      const file = e.dataTransfer?.files[0]
      const path = file ? window.api.pathForFile(file) : ''
      if (path) openPath(path)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [openPath])

  if (!state) return <div className="app" />

  const showWelcome = picking || state.tabs.length === 0

  return (
    <div className={`app ${dropping ? 'dropping' : ''}`}>
      <div className="tabbar">
        <div className="tabs" role="tablist">
          {state.tabs.map((path) => (
            <div
              key={path}
              role="tab"
              aria-selected={!showWelcome && state.active === path}
              className={`tab ${!showWelcome && state.active === path ? 'active' : ''}`}
              onClick={() => activate(path)}
              title={path}
            >
              <FolderGit2 size={13} />
              <span className="tab-name">{baseName(path)}</span>
              <button
                className="icon-btn"
                title={`Close ${baseName(path)}`}
                aria-label={`Close ${baseName(path)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void window.api.closeRepo(path).then(setState)
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button className={`tab-add ${showWelcome ? 'active' : ''}`} onClick={() => setPicking(true)} title="Open another repository" aria-label="Open another repository">
            <Plus size={15} />
          </button>
        </div>
        <div className="zoom" role="group" aria-label="Text size">
          <button className="icon-btn" disabled={zoom <= MIN_ZOOM} onClick={() => stepZoom(-1)} title="Make everything smaller" aria-label="Make everything smaller">
            <AArrowDown size={16} />
          </button>
          <button className="zoom-level" disabled={zoom === 1} onClick={() => stepZoom(0)} title="Back to normal size" aria-label="Back to normal size">
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" disabled={zoom >= MAX_ZOOM} onClick={() => stepZoom(1)} title="Make everything larger" aria-label="Make everything larger">
            <AArrowUp size={16} />
          </button>
        </div>
        <button className="icon-btn theme" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-label="Toggle theme">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
      {gitProblem && (
        <div className="notice error" role="alert" data-git-problem>
          <pre>{gitProblem}</pre>
          <button className="btn small" onClick={checkGit}>
            Check again
          </button>
        </div>
      )}

      {state.tabs.map((path) => {
        const active = !showWelcome && state.active === path
        return (
          <div key={path} className="tab-body" hidden={!active}>
            <RepoView path={path} active={active} onOpenRepo={openPath} onWorktreeGone={closeIfOpen} />
          </div>
        )
      })}

      {showWelcome && (
        <div className="welcome">
          <div className="welcome-inner">
            <h1>Branchline</h1>
            <p className="faint">Open a repository to browse its history.</p>
            <button className="btn primary large" onClick={pick}>
              <FolderOpen size={16} /> Open repository…
            </button>
            <p className="faint small">or drop a folder anywhere on this window</p>
            {openError && <div className="notice error inline">{openError}</div>}

            {state.recents.length > 0 && (
              <>
                <h3>Recent</h3>
                <div className="recents">
                  {state.recents.map((path) => (
                    <div key={path} className="recent" onClick={() => openPath(path)} title={path}>
                      <FolderGit2 size={15} />
                      <div className="recent-text">
                        <strong>{baseName(path)}</strong>
                        <span className="faint">{path}</span>
                      </div>
                      <button
                        className="icon-btn"
                        title="Remove from recent"
                        aria-label={`Remove ${baseName(path)} from recent`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.api.forgetRecent(path).then(setState)
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {picking && state.tabs.length > 0 && (
              <button className="btn" onClick={() => setPicking(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
