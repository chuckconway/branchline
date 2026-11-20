import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** State that survives restarts. Only for per-machine conveniences like panel widths. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage can be unavailable; the setting just will not persist.
      }
    },
    [key]
  )
  return [value, set]
}

interface SplitterProps {
  /** Current size of the panel this handle resizes. */
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  /** Dragging right grows the panel (handle on its right edge) or shrinks it. */
  direction?: 1 | -1
  className?: string
  label: string
}

/** A draggable divider. */
export function Splitter({ value, onChange, min, max, direction = 1, className = '', label }: SplitterProps): ReactNode {
  const start = useRef<{ x: number; value: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent): void => {
      if (!start.current) return
      const next = start.current.value + (e.clientX - start.current.x) * direction
      onChange(Math.round(Math.max(min, Math.min(max, next))))
    }
    const up = (): void => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('resizing')
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
  }, [dragging, direction, min, max, onChange])

  return (
    <div
      className={`splitter ${dragging ? 'dragging' : ''} ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault()
        start.current = { x: e.clientX, value }
        setDragging(true)
      }}
    />
  )
}

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ title, onClose, children }: ModalProps): ReactNode {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Spinner(): ReactNode {
  return <span className="spinner" aria-label="Working" />
}

export type MenuItem =
  | 'separator'
  | {
      label: string
      icon?: ReactNode
      onSelect: () => void
      disabled?: boolean
      /** Shown as a tooltip when the item is disabled, to say why. */
      reason?: string
      danger?: boolean
    }

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** Where to open a menu so it hangs below the element that was clicked. */
export function menuBelow(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Measure once rendered, then keep the whole menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - width - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - height - 6))
    })
  }, [menu])

  useEffect(() => {
    const outside = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', outside, true)
    window.addEventListener('wheel', outside, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('wheel', outside, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: menu.x, top: menu.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            title={item.disabled ? item.reason : undefined}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {/* The slot is kept even when empty so every label starts on the same line. */}
            <span className="menu-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="menu-label">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}

export interface ConfirmState {
  title: string
  body: ReactNode
  /** Label for the button that goes ahead. */
  label: string
  danger?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({ confirm, onClose }: { confirm: ConfirmState; onClose: () => void }): ReactNode {
  return (
    <Modal title={confirm.title} onClose={onClose}>
      <div className="confirm-body">{confirm.body}</div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className={`btn primary ${confirm.danger ? 'danger' : ''}`}
          onClick={() => {
            onClose()
            confirm.onConfirm()
          }}
        >
          {confirm.label}
        </button>
      </div>
    </Modal>
  )
}
