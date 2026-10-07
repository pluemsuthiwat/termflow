import { useEffect, useMemo, useRef, useState } from 'react'
import { hostAddress, isSerial } from '../../shared/hosts'
import type { HostView, SerialPortInfo } from '../../shared/types'
import { IconPlug, IconServer, IconSplit } from './icons'
import type { Side } from './layout'
import { fadeClass, useScrollEdges } from './scrollEdges'

/** Where the chosen session goes; 'auto' splits the target pane along its longer side. */
export type SideChoice = 'auto' | Side

export type PickTarget =
  | { kind: 'same' }
  | { kind: 'host'; host: HostView }
  | { kind: 'port'; port: SerialPortInfo }
  /** Typed "user@host[:port]". */
  | { kind: 'quick'; text: string }

interface Item {
  key: string
  target: PickTarget
  label: string
  sub?: string
  icon: 'server' | 'plug' | 'same'
  live?: boolean
  /** Why it can't be picked. */
  disabled?: string
}

interface Props {
  /** Button the picker hangs from. */
  anchor: DOMRect
  /** 'tab' when no terminal is shown: the pick opens a new tab. */
  mode: 'split' | 'tab'
  /** Pane the split goes next to. */
  targetTitle?: string
  /** "Same device" row; `disabled` explains why it can't be used. */
  same?: { label: string; disabled?: string }
  hosts: HostView[]
  liveHostIds: Set<string>
  ports: SerialPortInfo[]
  /** Console ports already open in some pane (one session per port). */
  busyPorts: Set<string>
  /** Only for a tab that is already split. */
  layout?: { zoomed: boolean; onEvenOut: () => void; onZoom: () => void }
  onPick: (target: PickTarget, side: SideChoice) => void
  onClose: () => void
}

const SIDES: { side: SideChoice; label: string; glyph: string }[] = [
  { side: 'auto', label: 'Auto', glyph: 'Auto' },
  { side: 'left', label: 'Left', glyph: '←' },
  { side: 'right', label: 'Right', glyph: '→' },
  { side: 'up', label: 'Up', glyph: '↑' },
  { side: 'down', label: 'Down', glyph: '↓' }
]
const ARROW_SIDE: Record<string, Side> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

function loadSide(): SideChoice {
  try {
    const s = localStorage.getItem('split.side')
    return SIDES.some((x) => x.side === s) ? (s as SideChoice) : 'auto'
  } catch {
    return 'auto'
  }
}

const QUICK = /^[^@\s]+@[^\s@]+$/

/** Pick a saved host, a console port or a typed user@host for a new pane (or tab). */
export default function SplitPicker(p: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const edges = useScrollEdges(listRef, 'y')
  const [query, setQuery] = useState('')
  const [side, setSideState] = useState(loadSide)
  const [active, setActive] = useState(0)
  const setSide = (s: SideChoice): void => {
    setSideState(s)
    try {
      localStorage.setItem('split.side', s)
    } catch {
      // remembering is optional
    }
  }

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (...fields: (string | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q))
    const out: Item[] = []
    if (p.same && !q) out.push({ key: 'same', target: { kind: 'same' }, label: p.same.label, icon: 'same', disabled: p.same.disabled })
    if (QUICK.test(query.trim()) && !p.hosts.some((h) => hostAddress(h) === query.trim()))
      out.push({ key: 'quick', target: { kind: 'quick', text: query.trim() }, label: `Connect to ${query.trim()}`, icon: 'server' })
    const portBusy = (path?: string) => (path && p.busyPorts.has(path) ? 'Already open in a pane' : undefined)
    const hosts = p.hosts
      .filter((h) => match(h.name, h.host, h.username, h.group, h.serial?.path))
      // Most recently used first, then by name.
      .sort((a, b) => (b.lastConnectedAt ?? '').localeCompare(a.lastConnectedAt ?? '') || (a.name || a.host).localeCompare(b.name || b.host))
    for (const h of hosts)
      out.push({
        key: `host:${h.id}`,
        target: { kind: 'host', host: h },
        label: h.name || h.host,
        sub: [hostAddress(h), h.group].filter(Boolean).join(' · '),
        icon: isSerial(h) ? 'plug' : 'server',
        live: p.liveHostIds.has(h.id),
        disabled: isSerial(h) ? portBusy(h.serial?.path) : undefined
      })
    for (const port of p.ports.filter((x) => match(x.name, x.manufacturer, x.path)))
      out.push({
        key: `port:${port.path}`,
        target: { kind: 'port', port },
        label: port.name,
        sub: ['Console port', port.manufacturer].filter(Boolean).join(' · '),
        icon: 'plug',
        disabled: portBusy(port.path)
      })
    return out
  }, [query, p.hosts, p.ports, p.busyPorts, p.liveHostIds, p.same])

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0)
  // Keep the highlight on a usable row as the list changes.
  useEffect(() => {
    if (!enabled.includes(active)) setActive(enabled[0] ?? -1)
  }, [items])
  useEffect(() => {
    listRef.current?.querySelector('.picker-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return
      p.onClose()
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [p.onClose])

  const pick = (i: number) => {
    const it = items[i]
    if (it && !it.disabled) p.onPick(it.target, side)
  }

  const step = (dir: 1 | -1) => {
    if (!enabled.length) return
    const at = enabled.indexOf(active)
    setActive(enabled[(at + dir + enabled.length) % enabled.length])
  }

  const isSplit = p.mode === 'split'
  return (
    <div
      ref={ref}
      className="picker"
      role="dialog"
      aria-label={isSplit ? 'Split with' : 'Open in new tab'}
      style={{ top: p.anchor.bottom + 6, right: Math.max(8, window.innerWidth - p.anchor.right) }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          p.onClose()
        } else if (isSplit && e.altKey && ARROW_SIDE[e.key]) {
          // ⌥ + arrow picks the side without leaving the search box.
          e.preventDefault()
          setSide(ARROW_SIDE[e.key])
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          step(e.key === 'ArrowDown' ? 1 : -1)
        } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          e.preventDefault()
          pick(active)
        }
      }}
    >
      <div className="picker-head">
        <b>{isSplit ? 'Split' : 'Open in new tab'}</b>
        {isSplit && p.targetTitle && <span className="muted">next to {p.targetTitle}</span>}
      </div>
      {isSplit && (
        <div className="picker-sides" role="group" aria-label="Where the new pane goes">
          {SIDES.map((s) => (
            <button
              key={s.side}
              type="button"
              className={`chip-btn ${side === s.side ? 'on' : ''}`}
              aria-pressed={side === s.side}
              aria-label={s.label}
              title={s.side === 'auto' ? 'Along the longer side' : `${s.label} (⌥${s.glyph})`}
              onClick={() => {
                setSide(s.side)
                // Back to the search box, so typing and Enter keep working.
                searchRef.current?.focus()
              }}
            >
              {s.glyph}
            </button>
          ))}
        </div>
      )}
      <input
        ref={searchRef}
        autoFocus
        className="picker-search"
        value={query}
        placeholder="Search hosts or type user@host"
        aria-label="Search hosts"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div ref={listRef} className={`picker-list scroll-fade scroll-fade-y${fadeClass(edges)}`} role="listbox" aria-label="Hosts">
        {items.map((it, i) => (
          <button
            key={it.key}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`picker-item ${i === active ? 'active' : ''}`}
            disabled={!!it.disabled}
            title={it.disabled}
            onMouseMove={() => !it.disabled && setActive(i)}
            onClick={() => pick(i)}
          >
            <span className={`picker-icon ${it.live ? 'live' : ''}`}>
              {it.icon === 'plug' ? <IconPlug size={14} /> : it.icon === 'same' ? <IconSplit size={14} /> : <IconServer size={14} />}
            </span>
            <span className="picker-text">
              <span className="picker-label">{it.label}</span>
              {(it.disabled || it.sub) && <span className="picker-sub">{it.disabled ?? it.sub}</span>}
            </span>
          </button>
        ))}
        {!items.length && <p className="picker-empty muted">No matching hosts. Type user@host to connect to a new one.</p>}
      </div>
      {p.layout && (
        <div className="picker-foot">
          <button type="button" className="btn small" onClick={p.layout.onEvenOut}>
            Even out sizes
          </button>
          <button type="button" className="btn small" aria-pressed={p.layout.zoomed} onClick={p.layout.onZoom}>
            {p.layout.zoomed ? 'Show all panes' : 'Zoom current pane'}
          </button>
        </div>
      )}
    </div>
  )
}
