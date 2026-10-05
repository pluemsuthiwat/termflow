import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; hint?: string; disabled?: boolean; icon?: ReactNode }
  | 'separator'

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** Floating menu at a point; closes on outside click, Escape, blur or resize. */
export default function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))
    })
    ref.current!.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div ref={ref} className="ctx-menu" role="menu" style={pos}>
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? 'danger' : ''}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            <span className="ctx-label">
              {item.icon && <span className="ctx-icon">{item.icon}</span>}
              {item.label}
            </span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}
