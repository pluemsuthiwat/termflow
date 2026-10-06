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
  type SerialSettings
} from '../../shared/types'
import { isWithin, joinPath, nameOf, parentOf, rebase } from '../../shared/groups'
import Dashboard from './Dashboard'
import { ConsoleDialog, GroupDialog, HostForm, PasswordDialog, PromptDialog } from './dialogs'
import { IconGrid, IconPlug, IconSidebar } from './icons'
import Sidebar from './Sidebar'
import TerminalView, { type Tab } from './TerminalView'

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
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<HostInput | null>(null)
  // Password login checked before its tab opens. sessionId is set while an attempt is running.
  const [login, setLogin] = useState<{
    host: HostView
    sessionId?: string
    askPassword: boolean
    error?: string
    save: boolean
  } | null>(null)
  const loginId = useRef<string | undefined>(undefined)
  const [prompts, setPrompts] = useState<PromptRequest[]>([])
  const [dataDir, setDataDir] = useState('')
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  // Cable plugged in after startup: offer to connect.
  const [newPort, setNewPort] = useState<SerialPortInfo | null>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [version, setVersion] = useState('')
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
    }
  }, [reload])

  const addTab = (tab: Omit<Tab, 'sessionId' | 'status' | 'title'> & { title: string }, sessionId: string = crypto.randomUUID()): void => {
    const same = tabs.filter((t) => t.hostId === tab.hostId).length
    const title = tab.title + (same ? ` (${same + 1})` : '')
    setTabs((ts) => [...ts, { ...tab, sessionId, title, status: { state: 'connecting' } }])
    setActiveId(sessionId)
  }

  const openTab = (host: HostView, secret?: string, sessionId?: string): void => {
    const serial = isSerial(host) && host.serial
    addTab(
      {
        hostId: host.id,
        title: host.name || host.host || (serial ? portName(serial.path) : ''),
        secret,
        kind: serial ? 'serial' : 'ssh',
        detail: serial ? `${portName(serial.path)} · ${lineSettings(serial)}` : undefined
      },
      sessionId
    )
  }

  /** Log in first; the tab only opens once the password was accepted. secret undefined = saved one. */
  const startLogin = (host: HostView, secret?: string, save = false): void => {
    const sessionId = crypto.randomUUID()
    loginId.current = sessionId
    setLogin({ host, sessionId, askPassword: secret !== undefined, save })
    window.shell.login({ sessionId, hostId: host.id, secret, saveSecret: save }).then(
      () => {
        if (loginId.current !== sessionId) return window.shell.close(sessionId)
        loginId.current = undefined
        setLogin(null)
        if (save) reload()
        openTab(host, secret, sessionId)
      },
      (err: Error) => {
        if (loginId.current !== sessionId) return
        loginId.current = undefined
        const error = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        if (error === LOGIN_CANCELLED) return setLogin(null)
        // A rejected saved password gets replaced by the one typed next.
        const rejected = error === AUTH_FAILED
        setLogin({ host, askPassword: secret !== undefined || rejected, error, save: save || (rejected && host.hasSecret) })
      }
    )
  }

  const cancelLogin = (): void => {
    if (loginId.current) window.shell.close(loginId.current)
    loginId.current = undefined
    setLogin(null)
  }

  const connectHost = (host: HostView): void => {
    // Console cables have no login step before the session opens.
    if (isSerial(host) || host.auth !== 'password') openTab(host)
    else if (host.hasSecret) startLogin(host)
    else setLogin({ host, askPassword: true, save: false })
  }

  /** Quick console session on a detected port, without saving a host. */
  const openPort = (port: SerialPortInfo, baudRate = DEFAULT_SERIAL.baudRate): void => {
    const serial: SerialSettings = { ...DEFAULT_SERIAL, baudRate, path: port.path, serialNumber: port.serialNumber, vendorId: port.vendorId, productId: port.productId }
    addTab({ hostId: `port:${port.path}`, title: port.name, kind: 'serial', serial, detail: `${port.name} · ${lineSettings(serial)}` })
  }

  const savePortAsHost = (port: SerialPortInfo): void =>
    setEditing({
      ...emptyHost,
      kind: 'serial',
      name: port.name,
      serial: { ...DEFAULT_SERIAL, path: port.path, serialNumber: port.serialNumber, vendorId: port.vendorId, productId: port.productId }
    })

  const closeTab = (sessionId: string): void => {
    setPrompts((p) => p.filter((r) => r.sessionId !== sessionId))
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.sessionId === sessionId)
      const next = ts.filter((t) => t.sessionId !== sessionId)
      if (activeId === sessionId) setActiveId(next[Math.max(0, idx - 1)]?.sessionId ?? null)
      return next
    })
  }

  // Menu shortcuts from the main process: ⌘W close tab, ⌘1–9 switch tab, ⌘N new host.
  useEffect(() =>
    window.shell.onMenu((action, arg) => {
      if (action === 'closeTab' && activeId) closeTab(activeId)
      else if (action === 'selectTab' && typeof arg === 'number' && tabs[arg]) setActiveId(tabs[arg].sessionId)
      else if (action === 'newHost') setEditing({ ...emptyHost })
      else if (action === 'home') showGroup('')
      else if (action === 'toggleSidebar') toggleSidebar()
      else if (action === 'sendBreak' && activeId && tabs.find((t) => t.sessionId === activeId)?.kind === 'serial')
        window.shell.sendBreak(activeId)
    })
  )

  /** Returns false if the target can't be parsed. */
  const quickConnect = async (target: string): Promise<boolean> => {
    const parsed = parseQuick(target)
    if (!parsed) return false
    const existing = hosts.find(
      (h) => h.host === parsed.host && h.port === parsed.port && h.username === parsed.username
    )
    if (existing) {
      connectHost(existing)
      return true
    }
    if (!parsed.username) {
      setEditing(parsed)
      return true
    }
    const saved = await window.shell.saveHost(parsed)
    await reload()
    connectHost(saved)
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

  const prompt = prompts[0]

  return (
    <div className={`app ${resizing ? 'resizing' : ''} ${sidebarOpen ? '' : 'sidebar-closed'}`}>
      {/* Kept mounted while hidden so search text and folder state survive. */}
      <aside className="sidebar" style={{ width: sidebarWidth }} hidden={!sidebarOpen}>
        <Sidebar
          hosts={hosts}
          groups={groupNames}
          liveHostIds={liveHostIds}
          activeHostId={tabs.find((t) => t.sessionId === activeId)?.hostId}
          dataDir={dataDir}
          version={version}
          onShowGroup={showGroup}
          onConnect={connectHost}
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
          {tabs.map((t, i) => (
            <div
              key={t.sessionId}
              className={`tab ${t.sessionId === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(t.sessionId)}
              title={`⌘${i + 1}`}
            >
              <span className={`dot ${t.status.state}`} />
              <span className="tab-title">{t.title}</span>
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
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.sessionId)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="terminals">
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
            />
          )}
          {tabs.map((t) => (
            <TerminalView key={t.sessionId} tab={t} active={t.sessionId === activeId} />
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
      {consoleOpen && (
        <ConsoleDialog
          ports={serialPorts}
          onCancel={() => setConsoleOpen(false)}
          onConnect={(port, baudRate) => {
            setConsoleOpen(false)
            openPort(port, baudRate)
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
          onSubmit={(pw, save) => startLogin(login.host, pw, save)}
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
