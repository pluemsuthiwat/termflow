import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isSerial, lineSettings, portName } from '../../shared/hosts'
import {
  AUTH_FAILED,
  DEFAULT_SERIAL,
  LOGIN_CANCELLED,
  type HostInput,
  type HostView,
  type PromptRequest,
  type SerialPortInfo,
  type SerialSettings,
  type UpdateCheck
} from '../../shared/types'
import { isWithin, joinPath, nameOf, parentOf, rebase } from '../../shared/groups'
import { AboutDialog } from './About'
import Dashboard from './Dashboard'
import { ConsoleDialog, FontDialog, GroupDialog, HostForm, PasswordDialog, PromptDialog } from './dialogs'
import { IconGrid, IconPlug, IconSidebar, IconSplit } from './icons'
import {
  dividers,
  evenOut,
  hasPane,
  insertAt,
  longerSide,
  neighbor,
  pane,
  paneIds,
  paneRects,
  removePane,
  setRatio,
  nearestSide,
  type FocusDir,
  type Layout,
  type Rect,
  type Side,
  type SplitDir
} from './layout'
import ScrollRow from './ScrollRow'
import Sidebar from './Sidebar'
import SplitPicker, { type PickTarget, type SideChoice } from './SplitPicker'
import { clampFontSize, DEFAULT_FONT, type TermFont } from './font'
import TerminalView, { type PaneHandle, type Tab } from './TerminalView'

/** One entry in the tab bar: one or more sessions (panes) in a split layout. */
interface View {
  id: string
  layout: Layout
  /** Session that gets keyboard input and menu commands. */
  focused: string
  /** Pane shown alone over the whole tab; the others stay connected underneath. */
  zoomed?: string
}

/** Something being dragged onto a pane. */
type DragSource = { kind: 'pane'; sessionId: string } | { kind: 'view'; viewId: string } | { kind: 'host'; host: HostView }
/** Beside a pane (on `side`), or out of the split into a new tab (dropped on the tab bar). */
type Drop = { kind: 'pane'; viewId: string; sessionId: string; side: Side; rect: DOMRect } | { kind: 'newTab' }

/** Where a new session goes: its own tab, or beside a pane of an open tab. */
type Placement = { viewId: string; target: string; side: Side } | undefined

const emptyHost: HostInput = {
  name: '',
  host: '',
  port: 22,
  username: '',
  group: '',
  auth: 'password',
  legacy: false,
  logSession: false
}

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 240
const clampSidebar = (w: number): number => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))

function loadFont(): TermFont {
  try {
    const f = JSON.parse(localStorage.getItem('terminal.font') ?? '{}') as Partial<TermFont>
    return {
      family: typeof f.family === 'string' && f.family.trim() ? f.family : DEFAULT_FONT.family,
      size: typeof f.size === 'number' ? clampFontSize(f.size) : DEFAULT_FONT.size
    }
  } catch {
    return DEFAULT_FONT
  }
}

function loadSidebarWidth(): number {
  try {
    const w = Number(localStorage.getItem('sidebarWidth'))
    return w ? clampSidebar(w) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

// "user@host:port" -> host fields
function parseQuick(s: string): HostInput | null {
  const m = s.trim().match(/^(?:([^@\s]+)@)?([^\s:@]+|\[[^\]]+\])(?::(\d+))?$/)
  if (!m) return null
  const host = m[2].replace(/^\[|\]$/g, '')
  return { ...emptyHost, name: host, host, username: m[1] ?? '', port: m[3] ? Number(m[3]) : 22, group: '' }
}

export default function App() {
  const [hosts, setHosts] = useState<HostView[]>([])
  const [groupNames, setGroupNames] = useState<string[]>([])
  // rename: path of the group being renamed; parent: where a new group is created.
  const [dashPath, setDashPath] = useState('')
  const [groupDialog, setGroupDialog] = useState<{ rename?: string; parent?: string } | null>(null)
  // Sessions; each one is a pane in exactly one view.
  const [tabs, setTabs] = useState<Tab[]>([])
  const [views, setViews] = useState<View[]>([])
  const viewsRef = useRef(views)
  viewsRef.current = views
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const paneHandles = useRef(new Map<string, PaneHandle>())
  const registerPane = useCallback((id: string, h: PaneHandle | null) => {
    if (h) paneHandles.current.set(id, h)
    else paneHandles.current.delete(id)
  }, [])
  const [font, setFontState] = useState(loadFont)
  const [fontOpen, setFontOpen] = useState(false)
  // Takes an updater so quick repeated ⌘+ presses each count.
  const setFont = (change: (f: TermFont) => TermFont): void =>
    setFontState((cur) => {
      const f = change(cur)
      const next = { family: f.family.trim() || DEFAULT_FONT.family, size: clampFontSize(f.size) }
      try {
        localStorage.setItem('terminal.font', JSON.stringify(next))
      } catch {
        // remembering is optional
      }
      return next
    })
  const terminalsRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<{ viewId: string; path: string; dir: SplitDir; area: Rect } | null>(null)
  const [editing, setEditing] = useState<HostInput | null>(null)
  // Password login checked before its tab opens. sessionId is set while an attempt is running.
  const [login, setLogin] = useState<{
    host: HostView
    sessionId?: string
    askPassword: boolean
    error?: string
    save: boolean
    placement?: Placement
  } | null>(null)
  const loginId = useRef<string | undefined>(undefined)
  const [prompts, setPrompts] = useState<PromptRequest[]>([])
  const [dataDir, setDataDir] = useState('')
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  // Cable plugged in after startup: offer to connect.
  const [newPort, setNewPort] = useState<SerialPortInfo | null>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)
  // Log quick console sessions (no saved host); set in the Open console dialog.
  const [consoleLog, setConsoleLog] = useState(() => {
    try {
      return localStorage.getItem('console.log') === 'true'
    } catch {
      return false
    }
  })
  const [version, setVersion] = useState('')
  const [aboutOpen, setAboutOpen] = useState(false)
  // Latest release check (from the About dialog or the quiet check after launch).
  const [update, setUpdate] = useState<UpdateCheck | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [resizing, setResizing] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem('sidebarOpen') !== 'false'
    } catch {
      return true
    }
  })
  const toggleSidebar = () =>
    setSidebarOpen((open) => {
      try {
        localStorage.setItem('sidebarOpen', String(!open))
      } catch {
        // remembering is optional
      }
      return !open
    })

  const setAndSaveSidebarWidth = (w: number): void => {
    setSidebarWidth(w)
    try {
      localStorage.setItem('sidebarWidth', String(w))
    } catch {
      // storage unavailable: width just won't persist
    }
  }

  const reload = useCallback(
    () => Promise.all([window.shell.listHosts().then(setHosts), window.shell.listGroups().then(setGroupNames)]),
    []
  )

  useEffect(() => {
    reload()
    window.shell.dataDir().then(setDataDir)
    window.shell.version().then(setVersion)
    const offUpdate = window.shell.onUpdateAvailable(setUpdate)
    window.shell.listSerialPorts().then(setSerialPorts)
    const offPorts = window.shell.onSerialPorts((ports, added) => {
      setSerialPorts(ports)
      if (added.length) setNewPort(added[added.length - 1])
      // Dismiss the notice if that cable was pulled again.
      setNewPort((cur) => (cur && !ports.some((p) => p.path === cur.path) ? null : cur))
    })
    const offStatus = window.shell.onStatus((sessionId, status) => {
      // A password the user asked to save is stored once login succeeds.
      if (status.state === 'ready') reload()
      // Drop dialogs for a session that has ended.
      if (status.state === 'closed') setPrompts((p) => p.filter((r) => r.sessionId !== sessionId))
      setTabs((ts) =>
        ts.map((t) => {
          if (t.sessionId !== sessionId) return t
          // Keep the first error when "error" is followed by a plain "close".
          if (status.state === 'closed' && t.status.state === 'closed' && !status.error) return t
          return { ...t, status }
        })
      )
    })
    const offPrompt = window.shell.onPrompt((req) => setPrompts((p) => [...p, req]))
    return () => {
      offStatus()
      offPrompt()
      offPorts()
      offUpdate()
    }
  }, [reload])

  const addTab = (
    tab: Omit<Tab, 'sessionId' | 'status' | 'title'> & { title: string },
    sessionId: string = crypto.randomUUID(),
    placement?: Placement
  ): void => {
    const same = tabs.filter((t) => t.hostId === tab.hostId).length
    const title = tab.title + (same ? ` (${same + 1})` : '')
    setTabs((ts) => [...ts, { ...tab, sessionId, title, status: { state: 'connecting' } }])
    // The pane it was meant to sit next to may have closed while logging in: open a tab instead.
    const into = placement && viewsRef.current.find((v) => v.id === placement.viewId && hasPane(v.layout, placement.target))
    if (into && placement) {
      setViews((vs) =>
        vs.map((v) =>
          v.id === into.id
            ? { ...v, layout: insertAt(v.layout, placement.target, pane(sessionId), placement.side), focused: sessionId, zoomed: undefined }
            : v
        )
      )
      setActiveId(into.id)
    } else {
      setViews((vs) => [...vs, { id: sessionId, layout: pane(sessionId), focused: sessionId }])
      setActiveId(sessionId)
    }
  }

  const openTab = (host: HostView, secret?: string, sessionId?: string, placement?: Placement): void => {
    const serial = isSerial(host) && host.serial
    addTab(
      {
        hostId: host.id,
        title: host.name || host.host || (serial ? portName(serial.path) : ''),
        secret,
        kind: serial ? 'serial' : 'ssh',
        detail: serial ? `${portName(serial.path)} · ${lineSettings(serial)}` : undefined
      },
      sessionId,
      placement
    )
  }

  /** Log in first; the tab only opens once the password was accepted. secret undefined = saved one. */
  const startLogin = (host: HostView, secret?: string, save = false, placement?: Placement): void => {
    const sessionId = crypto.randomUUID()
    loginId.current = sessionId
    setLogin({ host, sessionId, askPassword: secret !== undefined, save, placement })
    window.shell.login({ sessionId, hostId: host.id, secret, saveSecret: save }).then(
      () => {
        if (loginId.current !== sessionId) return window.shell.close(sessionId)
        loginId.current = undefined
        setLogin(null)
        if (save) reload()
        openTab(host, secret, sessionId, placement)
      },
      (err: Error) => {
        if (loginId.current !== sessionId) return
        loginId.current = undefined
        const error = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        if (error === LOGIN_CANCELLED) return setLogin(null)
        // A rejected saved password gets replaced by the one typed next.
        const rejected = error === AUTH_FAILED
        setLogin({ host, askPassword: secret !== undefined || rejected, error, save: save || (rejected && host.hasSecret), placement })
      }
    )
  }

  const cancelLogin = (): void => {
    if (loginId.current) window.shell.close(loginId.current)
    loginId.current = undefined
    setLogin(null)
  }

  const connectHost = (host: HostView, placement?: Placement): void => {
    // Console cables have no login step before the session opens.
    if (isSerial(host) || host.auth !== 'password') openTab(host, undefined, undefined, placement)
    else if (host.hasSecret) startLogin(host, undefined, false, placement)
    else setLogin({ host, askPassword: true, save: false, placement })
  }

  const activeView = views.find((v) => v.id === activeId)

  /** Beside a pane (default: the focused one of the shown tab); 'auto' splits along its longer side. */
  const splitPlacement = (side: SideChoice = 'auto', target?: { viewId: string; sessionId: string }): Placement => {
    const t = target ?? (activeView && { viewId: activeView.id, sessionId: activeView.focused })
    if (!t) return undefined
    const box = document.querySelector(`.pane[data-session="${t.sessionId}"]`)?.getBoundingClientRect()
    const auto: Side = !box || longerSide(box.width, box.height) === 'row' ? 'right' : 'down'
    return { viewId: t.viewId, target: t.sessionId, side: side === 'auto' ? auto : side }
  }

  /** Host of a pane, when another session to it can be opened (a console port only opens once). */
  const sameHostOf = (sessionId?: string): HostView | undefined => {
    const t = tabs.find((x) => x.sessionId === sessionId)
    return t && t.kind !== 'serial' ? hosts.find((h) => h.id === t.hostId) : undefined
  }

  /** ⌘D / ⌘⇧D: another session to the focused pane's host. */
  const splitFocused = (dir: SplitDir): void => {
    const h = sameHostOf(activeView?.focused)
    if (h) connectHost(h, splitPlacement(dir === 'row' ? 'right' : 'down'))
  }

  // Console ports open in a pane; they can't be opened a second time.
  const busyPorts = useMemo(() => {
    const set = new Set<string>()
    for (const t of tabs) {
      if (t.kind !== 'serial' || t.status.state === 'closed') continue
      const path = t.serial?.path ?? hosts.find((h) => h.id === t.hostId)?.serial?.path
      if (path) set.add(path)
    }
    return set
  }, [tabs, hosts])

  // Split picker: hangs from the tab bar button (focused pane) or a pane header (that pane).
  const [picker, setPicker] = useState<{ anchor: DOMRect; target?: { viewId: string; sessionId: string } } | null>(null)
  const openPicker = (el: HTMLElement, target?: { viewId: string; sessionId: string }): void =>
    setPicker({ anchor: el.getBoundingClientRect(), target: target ?? (activeView && { viewId: activeView.id, sessionId: activeView.focused }) })
  const closePicker = useCallback(() => setPicker(null), [])

  const pickTarget = (what: PickTarget, side: SideChoice): void => {
    const target = picker?.target
    setPicker(null)
    const placement = target ? splitPlacement(side, target) : undefined
    if (what.kind === 'same') {
      const h = sameHostOf(target?.sessionId)
      if (h) connectHost(h, placement)
    } else if (what.kind === 'host') connectHost(what.host, placement)
    else if (what.kind === 'port') openPort(what.port, DEFAULT_SERIAL.baudRate, consoleLog, placement)
    else void quickConnect(what.text, placement)
  }

  const updateView = (viewId: string, change: (v: View) => View): void =>
    setViews((vs) => vs.map((v) => (v.id === viewId ? change(v) : v)))
  const evenOutView = (viewId: string): void => updateView(viewId, (v) => ({ ...v, layout: evenOut(v.layout), zoomed: undefined }))
  /** Show the pane alone (or all panes again). */
  const toggleZoom = (viewId: string, sessionId?: string): void =>
    updateView(viewId, (v) => {
      const id = sessionId ?? v.focused
      if (v.layout.kind === 'pane') return v
      return v.zoomed ? { ...v, zoomed: undefined } : { ...v, zoomed: id, focused: id }
    })

  const focusPane = (viewId: string, sessionId: string): void =>
    setViews((vs) => vs.map((v) => (v.id === viewId && v.focused !== sessionId ? { ...v, focused: sessionId } : v)))

  /** Quick console session on a detected port, without saving a host. */
  const openPort = (port: SerialPortInfo, baudRate = DEFAULT_SERIAL.baudRate, log = consoleLog, placement?: Placement): void => {
    const serial: SerialSettings = { ...DEFAULT_SERIAL, baudRate, path: port.path, serialNumber: port.serialNumber, vendorId: port.vendorId, productId: port.productId }
    addTab({ hostId: `port:${port.path}`, title: port.name, kind: 'serial', serial, log, detail: `${port.name} · ${lineSettings(serial)}` }, undefined, placement)
  }

  const savePortAsHost = (port: SerialPortInfo): void =>
    setEditing({
      ...emptyHost,
      kind: 'serial',
      name: port.name,
      serial: { ...DEFAULT_SERIAL, path: port.path, serialNumber: port.serialNumber, vendorId: port.vendorId, productId: port.productId }
    })

  /** Close sessions; a tab left without panes goes away. */
  const closeSessions = (ids: string[]): void => {
    if (!ids.length) return
    const gone = new Set(ids)
    setPrompts((p) => p.filter((r) => !gone.has(r.sessionId)))
    setTabs((ts) => ts.filter((t) => !gone.has(t.sessionId)))
    const vs = viewsRef.current
    const next: View[] = []
    for (const v of vs) {
      let layout: Layout | null = v.layout
      for (const id of ids) layout = layout && removePane(layout, id)
      if (!layout) continue
      // Focus moves to a neighbour of the closed pane, else any pane left.
      const focused = gone.has(v.focused)
        ? ((['left', 'up', 'right', 'down'] as FocusDir[]).map((d) => neighbor(v.layout, v.focused, d)).find((id) => id && !gone.has(id)) ??
          paneIds(layout)[0])
        : v.focused
      next.push(layout === v.layout ? v : { ...v, layout, focused, zoomed: undefined })
    }
    setViews(next)
    if (activeId && !next.some((v) => v.id === activeId)) {
      const idx = vs.findIndex((v) => v.id === activeId)
      const remaining = vs.slice(0, idx).filter((v) => next.some((n) => n.id === v.id))
      setActiveId(remaining[remaining.length - 1]?.id ?? next[0]?.id ?? null)
    }
  }
  const closeTab = (sessionId: string): void => closeSessions([sessionId])
  const closeView = (viewId: string): void => {
    const v = views.find((x) => x.id === viewId)
    if (v) closeSessions(paneIds(v.layout))
  }

  /** Take a pane out of its split into a tab of its own, right after the current one. */
  const moveToTab = (sessionId: string): void => {
    const from = viewsRef.current.find((v) => hasPane(v.layout, sessionId))
    if (!from || from.layout.kind === 'pane') return
    const layout = removePane(from.layout, sessionId)!
    const focused = from.focused === sessionId ? paneIds(layout)[0] : from.focused
    // Tab ids only need to be unique; the one moving out may share the old tab's id.
    const moved: View = { id: crypto.randomUUID(), layout: pane(sessionId), focused: sessionId }
    setViews((vs) => {
      const i = vs.findIndex((v) => v.id === from.id)
      return [...vs.slice(0, i), { ...vs[i], layout, focused, zoomed: undefined }, moved, ...vs.slice(i + 1)]
    })
    setActiveId(moved.id)
  }

  // ---- drag and drop: a pane header, a tab or a sidebar host onto an edge of a pane ----

  const [drag, setDrag] = useState<{ label: string; x: number; y: number; drop?: Drop } | null>(null)

  /** What is under the pointer, or undefined when dropping there does nothing. */
  const findDrop = (x: number, y: number, source: DragSource): Drop | undefined => {
    const els = document.elementsFromPoint(x, y)
    // Hovering another tab while carrying a pane or host shows that tab, so it can be dropped there.
    const tabEl = els.find((el) => el instanceof HTMLElement && el.dataset.view) as HTMLElement | undefined
    if (tabEl) {
      if (source.kind !== 'view' && tabEl.dataset.view !== activeIdRef.current) setActiveId(tabEl.dataset.view!)
      return undefined
    }
    const vs = viewsRef.current
    if (source.kind === 'pane' && els.some((el) => el.classList.contains('tabbar'))) {
      const from = vs.find((v) => hasPane(v.layout, source.sessionId))
      return from && from.layout.kind === 'split' ? { kind: 'newTab' } : undefined
    }
    const paneEl = els.map((el) => el.closest<HTMLElement>('.pane[data-session]')).find((el) => el && !el.hidden)
    const sessionId = paneEl?.dataset.session
    const view = sessionId && vs.find((v) => hasPane(v.layout, sessionId))
    if (!paneEl || !sessionId || !view) return undefined
    if (source.kind === 'pane' && source.sessionId === sessionId) return undefined
    if (source.kind === 'view' && source.viewId === view.id) return undefined
    const r = paneEl.getBoundingClientRect()
    return { kind: 'pane', viewId: view.id, sessionId, side: nearestSide(x - r.left, y - r.top, r.width, r.height), rect: r }
  }

  const applyDrop = (source: DragSource, drop: Drop): void => {
    if (drop.kind === 'newTab') return source.kind === 'pane' ? moveToTab(source.sessionId) : undefined
    const placement = { viewId: drop.viewId, target: drop.sessionId, side: drop.side }
    if (source.kind === 'host') return connectHost(source.host, placement)
    const vs = viewsRef.current
    const dst = vs.find((v) => v.id === drop.viewId)
    if (!dst) return
    let next: View[]
    if (source.kind === 'pane') {
      const s = source.sessionId
      const src = vs.find((v) => hasPane(v.layout, s))
      if (!src) return
      next = vs.flatMap((v): View[] => {
        if (v.id === dst.id) {
          const base = v.id === src.id ? removePane(v.layout, s)! : v.layout
          return [{ ...v, layout: insertAt(base, drop.sessionId, pane(s), drop.side), focused: s, zoomed: undefined }]
        }
        if (v.id !== src.id) return [v]
        const left = removePane(v.layout, s)
        return left ? [{ ...v, layout: left, focused: v.focused === s ? paneIds(left)[0] : v.focused, zoomed: undefined }] : []
      })
    } else {
      // A whole tab joins another one; its panes keep their arrangement.
      const src = vs.find((v) => v.id === source.viewId)
      if (!src) return
      next = vs.flatMap((v): View[] =>
        v.id === src.id ? [] : v.id === dst.id ? [{ ...v, layout: insertAt(v.layout, drop.sessionId, src.layout, drop.side), focused: src.focused, zoomed: undefined }] : [v]
      )
    }
    setViews(next)
    setActiveId(dst.id)
  }

  /** Begins a drag once the pointer has moved a few pixels; a plain click stays a click. */
  const startDrag = (e: React.PointerEvent, source: DragSource, label: string): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const sx = e.clientX
    const sy = e.clientY
    let active = false
    let drop: Drop | undefined
    const move = (ev: PointerEvent): void => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return
      active = true
      drop = findDrop(ev.clientX, ev.clientY, source)
      setDrag({ label, x: ev.clientX, y: ev.clientY, drop })
    }
    const end = (ev: Event): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('keydown', onKey, true)
      if (!active) return
      setDrag(null)
      // The click that ends a drag must not also select a tab or connect a host.
      const swallow = (c: Event): void => (c.stopPropagation(), c.preventDefault())
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      if (ev.type === 'pointerup' && drop) applyDrop(source, drop)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      drop = undefined
      end(ev)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('keydown', onKey, true)
  }

  // Bring the active tab into view when the tab strip is scrolled (⌘1–9, new session).
  useEffect(() => {
    document.querySelector('.tabbar-tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const checkForUpdate = async () => {
    setCheckingUpdate(true)
    try {
      setUpdate(await window.shell.checkForUpdate())
    } finally {
      setCheckingUpdate(false)
    }
  }

  // Menu shortcuts from the main process: ⌘W close pane, ⌘1–9 switch tab, ⌘N new host, ⌘D split.
  useEffect(() =>
    window.shell.onMenu((action, arg) => {
      const focused = activeView?.focused
      if (action === 'closeTab' && focused) closeTab(focused)
      else if (action === 'selectTab' && typeof arg === 'number' && views[arg]) setActiveId(views[arg].id)
      else if (action === 'splitWith') {
        const btn = document.querySelector<HTMLElement>('.split-btn')
        if (btn) openPicker(btn)
      } else if (action === 'zoomPane' && activeView) toggleZoom(activeView.id)
      else if (action === 'evenOut' && activeView) evenOutView(activeView.id)
      else if (action === 'splitRight') splitFocused('row')
      else if (action === 'splitDown') splitFocused('col')
      else if (action === 'focusPane' && activeView && focused) {
        const to = neighbor(activeView.layout, focused, arg as FocusDir)
        if (to) focusPane(activeView.id, to)
      } else if ((action === 'find' || action === 'findNext' || action === 'findPrevious') && focused)
        paneHandles.current.get(focused)?.[action]()
      else if (action === 'fontBigger') setFont((f) => ({ ...f, size: f.size + 1 }))
      else if (action === 'fontSmaller') setFont((f) => ({ ...f, size: f.size - 1 }))
      else if (action === 'fontReset') setFont((f) => ({ ...f, size: DEFAULT_FONT.size }))
      else if (action === 'fontDialog') setFontOpen(true)
      else if (action === 'newHost') setEditing({ ...emptyHost })
      else if (action === 'home') showGroup('')
      // Up one level while browsing groups on the dashboard.
      else if (action === 'back' && activeId === null && dashPath) setDashPath(parentOf(dashPath))
      else if (action === 'toggleSidebar') toggleSidebar()
      else if (action === 'about') setAboutOpen(true)
      else if (action === 'checkUpdate') {
        setAboutOpen(true)
        if (!checkingUpdate) void checkForUpdate()
      }
      else if (action === 'sendBreak' && focused && tabs.find((t) => t.sessionId === focused)?.kind === 'serial')
        window.shell.sendBreak(focused)
    })
  )

  /** Returns false if the target can't be parsed. */
  const quickConnect = async (target: string, placement?: Placement): Promise<boolean> => {
    const parsed = parseQuick(target)
    if (!parsed) return false
    const existing = hosts.find(
      (h) => h.host === parsed.host && h.port === parsed.port && h.username === parsed.username
    )
    if (existing) {
      connectHost(existing, placement)
      return true
    }
    if (!parsed.username) {
      setEditing(parsed)
      return true
    }
    const saved = await window.shell.saveHost(parsed)
    await reload()
    connectHost(saved, placement)
    return true
  }

  // Actions shared by the sidebar and the dashboard.
  const editHost = (h: HostView) => setEditing({ ...h })
  const duplicateHost = ({ id: _id, hasSecret: _s, lastConnectedAt: _l, ...rest }: HostView) =>
    setEditing({ ...rest, name: `${rest.name || rest.host} copy` })
  const deleteHost = async (h: HostView) => {
    await window.shell.deleteHost(h.id)
    await reload()
  }
  const newHost = (group?: string) => setEditing({ ...emptyHost, group: group ?? '' })
  const newGroup = (parent?: string) => setGroupDialog({ parent })
  const renameGroup = (path: string) => setGroupDialog({ rename: path })
  const deleteGroup = async (path: string) => {
    await window.shell.deleteGroup(path)
    // Browsing inside the deleted group: step out to its parent.
    if (isWithin(dashPath, path)) setDashPath(parentOf(path))
    await reload()
  }
  const showGroup = (path: string) => {
    setDashPath(path)
    setActiveId(null)
  }

  const liveHostIds = useMemo(
    () => new Set(tabs.filter((t) => t.status.state === 'ready').map((t) => t.hostId)),
    [tabs]
  )

  // Where each session's pane sits.
  const placed = useMemo(() => {
    const m = new Map<string, { view: View; rect: Rect; split: boolean; hidden: boolean }>()
    const full: Rect = { x: 0, y: 0, w: 1, h: 1 }
    for (const view of views) {
      const split = view.layout.kind === 'split'
      for (const [id, rect] of paneRects(view.layout)) {
        // Zoomed: one pane fills the tab; the rest stay mounted (connected) but hidden.
        if (view.zoomed) m.set(id, { view, rect: full, split, hidden: id !== view.zoomed })
        else m.set(id, { view, rect, split, hidden: false })
      }
    }
    return m
  }, [views])

  const prompt = prompts[0]

  return (
    <div className={`app ${resizing || dragging || drag ? 'resizing' : ''} ${drag ? 'dragging' : ''} ${sidebarOpen ? '' : 'sidebar-closed'}`}>
      {/* Kept mounted while hidden so search text and folder state survive. */}
      <aside className="sidebar" style={{ width: sidebarWidth }} hidden={!sidebarOpen}>
        <Sidebar
          hosts={hosts}
          groups={groupNames}
          liveHostIds={liveHostIds}
          activeHostId={tabs.find((t) => t.sessionId === activeView?.focused)?.hostId}
          editingHostId={editing?.id}
          dataDir={dataDir}
          onShowGroup={showGroup}
          onConnect={connectHost}
          onOpenInSplit={activeView ? (h) => connectHost(h, splitPlacement()) : undefined}
          onHostPointerDown={activeView ? (e, h) => startDrag(e, { kind: 'host', host: h }, h.name || h.host) : undefined}
          onEdit={editHost}
          onDuplicate={duplicateHost}
          onDeleteHost={deleteHost}
          onNewHost={newHost}
          onNewGroup={newGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
          onQuickConnect={quickConnect}
          serialPorts={serialPorts}
          onOpenPort={openPort}
          onSavePort={savePortAsHost}
          onOpenDataDir={() => window.shell.openDataDir()}
        />
      </aside>
      <div
        hidden={!sidebarOpen}
        className={`sidebar-resizer ${resizing ? 'active' : ''}`}
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setResizing(true)
        }}
        onPointerMove={(e) => {
          if (resizing) setSidebarWidth(clampSidebar(e.clientX))
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId)
          setResizing(false)
          setAndSaveSidebarWidth(clampSidebar(e.clientX))
        }}
        onDoubleClick={() => setAndSaveSidebarWidth(SIDEBAR_DEFAULT)}
      />

      <main className="main">
        <div className="tabbar">
          <button
            className="tabbar-btn sidebar-toggle"
            onClick={toggleSidebar}
            title={`${sidebarOpen ? 'Hide' : 'Show'} sidebar (⌘\\)`}
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-pressed={!sidebarOpen}
          >
            <IconSidebar size={15} />
          </button>
          <button
            className={`tab home ${activeId === null ? 'active' : ''}`}
            onClick={() => setActiveId(null)}
            title="Dashboard (⌘0)"
          >
            <IconGrid size={14} />
            <span>Dashboard</span>
          </button>
          <ScrollRow className="tabbar-tabs">
            {views.map((v, i) => {
              const t = tabs.find((x) => x.sessionId === v.focused)
              if (!t) return null
              const panes = paneIds(v.layout).length
              return (
                <div
                  key={v.id}
                  data-view={v.id}
                  className={`tab ${v.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(v.id)}
                  onPointerDown={(e) => startDrag(e, { kind: 'view', viewId: v.id }, panes > 1 ? `${t.title} +${panes - 1}` : t.title)}
                  title={`⌘${i + 1}`}
                >
                  <span className={`dot ${t.status.state}`} />
                  <span className="tab-title">{t.title}</span>
                  {panes > 1 && (
                    <span className={`tab-count ${v.zoomed ? 'zoomed' : ''}`} title={v.zoomed ? `Zoomed: 1 of ${panes} panes shown` : `${panes} panes`}>
                      {panes}
                    </span>
                  )}
                  {t.status.state === 'ready' && t.status.logFile && (
                    <button
                      className="rec"
                      title={`Logging to ${t.status.logFile} — click to show in Finder`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (t.status.state === 'ready' && t.status.logFile) window.shell.revealLog(t.status.logFile)
                      }}
                    >
                      REC
                    </button>
                  )}
                  <button
                    className="tab-close"
                    title={panes > 1 ? `Close ${panes} panes` : 'Close'}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeView(v.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </ScrollRow>
          <button
            className="tabbar-btn split-btn"
            onClick={(e) => (picker ? setPicker(null) : openPicker(e.currentTarget))}
            title={activeView ? 'Split: open a host beside this one (⌘T)' : 'Open a host in a new tab (⌘T)'}
            aria-label={activeView ? 'Split' : 'Open host'}
            aria-expanded={!!picker}
          >
            <IconSplit size={15} />
          </button>
        </div>
        <div className="terminals" ref={terminalsRef}>
          {activeId === null && (
            <Dashboard
              hosts={hosts}
              groups={groupNames}
              tabs={tabs}
              path={dashPath}
              onNavigate={setDashPath}
              onConnect={connectHost}
              onEdit={editHost}
              onDuplicate={duplicateHost}
              onDelete={deleteHost}
              onNewHost={newHost}
              onNewGroup={newGroup}
              onRenameGroup={renameGroup}
              onDeleteGroup={deleteGroup}
              onQuickConnect={quickConnect}
              serialPorts={serialPorts}
              onOpenPort={openPort}
              onOpenConsole={() => setConsoleOpen(true)}
              version={version}
              updateVersion={update?.state === 'available' ? update.latest : undefined}
              onAbout={() => setAboutOpen(true)}
            />
          )}
          {/* Flat and keyed by session, so splitting or closing a neighbour never remounts (disconnects) a pane. */}
          {tabs.map((t) => {
            const at = placed.get(t.sessionId)
            if (!at) return null
            const { view, rect, split, hidden } = at
            return (
              <TerminalView
                key={t.sessionId}
                tab={t}
                visible={view.id === activeId && !hidden}
                zoomed={view.zoomed === t.sessionId}
                onSplit={(el) => openPicker(el, { viewId: view.id, sessionId: t.sessionId })}
                onDragStart={(e) => startDrag(e, { kind: 'pane', sessionId: t.sessionId }, t.title)}
                onZoom={() => toggleZoom(view.id, t.sessionId)}
                focused={view.focused === t.sessionId}
                split={split}
                rect={rect}
                font={font}
                onFocus={() => focusPane(view.id, t.sessionId)}
                onClose={() => closeTab(t.sessionId)}
                onMoveToTab={() => moveToTab(t.sessionId)}
                register={registerPane}
              />
            )
          })}
          {activeView &&
            !activeView.zoomed &&
            dividers(activeView.layout).map((d) => (
              <div
                key={d.path}
                className={`pane-divider ${d.dir} ${dragging?.path === d.path ? 'active' : ''}`}
                style={
                  d.dir === 'row'
                    ? { left: `${(d.area.x + d.area.w * d.ratio) * 100}%`, top: `${d.area.y * 100}%`, height: `${d.area.h * 100}%` }
                    : { top: `${(d.area.y + d.area.h * d.ratio) * 100}%`, left: `${d.area.x * 100}%`, width: `${d.area.w * 100}%` }
                }
                title="Drag to resize · double-click to make equal"
                onPointerDown={(e) => {
                  e.preventDefault()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDragging({ viewId: activeView.id, path: d.path, dir: d.dir, area: d.area })
                }}
                onPointerMove={(e) => {
                  const box = terminalsRef.current?.getBoundingClientRect()
                  if (!dragging || !box) return
                  const { area } = dragging
                  const ratio =
                    dragging.dir === 'row'
                      ? ((e.clientX - box.left) / box.width - area.x) / area.w
                      : ((e.clientY - box.top) / box.height - area.y) / area.h
                  setViews((vs) => vs.map((v) => (v.id === dragging.viewId ? { ...v, layout: setRatio(v.layout, dragging.path, ratio) } : v)))
                }}
                onPointerUp={(e) => {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                  setDragging(null)
                }}
                onDoubleClick={() =>
                  setViews((vs) => vs.map((v) => (v.id === activeView.id ? { ...v, layout: setRatio(v.layout, d.path, 0.5) } : v)))
                }
              />
            ))}
        </div>
      </main>

      {editing && (
        <HostForm
          initial={editing}
          hasSecret={!!hosts.find((h) => h.id === editing.id)?.hasSecret}
          groups={groupNames}
          serialPorts={serialPorts}
          onCancel={() => setEditing(null)}
          onSave={async (input, connect) => {
            const saved = await window.shell.saveHost(input)
            setEditing(null)
            await reload()
            if (connect) connectHost(saved)
          }}
        />
      )}
      {newPort && (
        <div className="toast" role="status">
          <span className="toast-icon">
            <IconPlug size={16} />
          </span>
          <div className="toast-text">
            <b>Console cable connected</b>
            <span>
              {newPort.manufacturer ? `${newPort.manufacturer} · ` : ''}
              {newPort.name}
            </span>
          </div>
          <button
            className="btn small primary"
            onClick={() => {
              openPort(newPort)
              setNewPort(null)
            }}
          >
            Connect
          </button>
          <button
            className="btn small"
            onClick={() => {
              savePortAsHost(newPort)
              setNewPort(null)
            }}
          >
            Save as host
          </button>
          <button className="icon" aria-label="Dismiss" onClick={() => setNewPort(null)}>
            ✕
          </button>
        </div>
      )}
      {drag && (
        <>
          {drag.drop?.kind === 'pane' && (
            <div
              className="drop-zone"
              style={{
                left: drag.drop.rect.left + (drag.drop.side === 'right' ? drag.drop.rect.width / 2 : 0),
                top: drag.drop.rect.top + (drag.drop.side === 'down' ? drag.drop.rect.height / 2 : 0),
                width: drag.drop.side === 'left' || drag.drop.side === 'right' ? drag.drop.rect.width / 2 : drag.drop.rect.width,
                height: drag.drop.side === 'up' || drag.drop.side === 'down' ? drag.drop.rect.height / 2 : drag.drop.rect.height
              }}
            />
          )}
          <div className="drag-chip" style={{ left: drag.x + 12, top: drag.y + 12 }}>
            {drag.label}
            {drag.drop?.kind === 'newTab' && <span className="muted"> → new tab</span>}
          </div>
        </>
      )}
      {picker && (
        <SplitPicker
          anchor={picker.anchor}
          mode={picker.target ? 'split' : 'tab'}
          targetTitle={tabs.find((t) => t.sessionId === picker.target?.sessionId)?.title}
          same={
            picker.target
              ? {
                  label: `Same device (${tabs.find((t) => t.sessionId === picker.target?.sessionId)?.title ?? ''})`,
                  disabled: sameHostOf(picker.target.sessionId) ? undefined : 'A console port can only be open once'
                }
              : undefined
          }
          hosts={hosts}
          liveHostIds={liveHostIds}
          ports={serialPorts}
          busyPorts={busyPorts}
          layout={(() => {
            const v = picker.target && views.find((x) => x.id === picker.target!.viewId)
            if (!v || v.layout.kind === 'pane') return undefined
            return {
              zoomed: !!v.zoomed,
              onEvenOut: () => (evenOutView(v.id), setPicker(null)),
              onZoom: () => (toggleZoom(v.id, picker.target!.sessionId), setPicker(null))
            }
          })()}
          onPick={pickTarget}
          onClose={closePicker}
        />
      )}
      {fontOpen && <FontDialog initial={font} onCancel={() => setFontOpen(false)} onSave={(f) => (setFont(() => f), setFontOpen(false))} />}
      {aboutOpen && (
        <AboutDialog
          update={update}
          checking={checkingUpdate}
          onCheck={checkForUpdate}
          onClose={() => setAboutOpen(false)}
        />
      )}
      {consoleOpen && (
        <ConsoleDialog
          ports={serialPorts}
          log={consoleLog}
          onCancel={() => setConsoleOpen(false)}
          onConnect={(port, baudRate, log) => {
            setConsoleOpen(false)
            setConsoleLog(log)
            try {
              localStorage.setItem('console.log', String(log))
            } catch {
              // remembering is optional
            }
            openPort(port, baudRate, log)
          }}
        />
      )}
      {groupDialog && (
        <GroupDialog
          initial={groupDialog.rename && nameOf(groupDialog.rename)}
          parent={groupDialog.parent}
          onCancel={() => setGroupDialog(null)}
          onSubmit={async (name) => {
            const { rename, parent } = groupDialog
            if (rename) {
              await window.shell.renameGroup(rename, name)
              // Keep browsing the same group under its new name.
              if (isWithin(dashPath, rename)) setDashPath(rebase(dashPath, rename, joinPath(parentOf(rename), name.trim())))
            } else await window.shell.createGroup(name, parent)
            setGroupDialog(null)
            await reload()
          }}
        />
      )}
      {/* Host-key and OTP prompts for this login take its place while open. */}
      {login && !prompts.some((p) => p.sessionId === login.sessionId) && (
        <PasswordDialog
          key={String(login.askPassword)}
          host={login.host}
          askPassword={login.askPassword}
          busy={!!login.sessionId}
          error={login.error}
          defaultSave={login.save}
          onCancel={cancelLogin}
          onSubmit={(pw, save) => startLogin(login.host, pw, save, login.placement)}
        />
      )}
      {prompt && (
        <PromptDialog
          key={prompt.requestId}
          req={prompt}
          onAnswer={(answer) => {
            window.shell.answerPrompt(prompt.requestId, answer)
            setPrompts((p) => p.slice(1))
            // The typed password was rejected; don't resend it on reconnect (AAA lockout).
            if (prompt.kind === 'keyboard')
              setTabs((ts) => ts.map((t) => (t.sessionId === prompt.sessionId ? { ...t, secret: undefined } : t)))
          }}
        />
      )}
    </div>
  )
}
