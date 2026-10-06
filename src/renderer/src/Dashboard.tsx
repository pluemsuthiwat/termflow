import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { nameOf, parentOf } from '../../shared/groups'
import { hostAddress, isSerial } from '../../shared/hosts'
import type { HostView, SerialPortInfo } from '../../shared/types'
import ContextMenu, { type MenuItem, type MenuState } from './ContextMenu'
import { ConfirmDialog } from './dialogs'
import { buildTree, hostMatches, type GroupNode } from './groupTree'
import {
  IconBack,
  IconChevron,
  IconClock,
  IconFolder,
  IconGrid,
  IconList,
  IconLogs,
  IconMore,
  IconPlug,
  IconPlus,
  IconPulse,
  IconSearch,
  IconServer,
  IconTerminal,
  IconWarn
} from './icons'
import ScrollRow from './ScrollRow'
import { fadeClass, useScrollEdges } from './scrollEdges'
import type { Tab } from './TerminalView'
// Same artwork as the app icon (both drawn by build/make-icon.py).
import logo from './assets/logo.png'

/** Built-in group for hosts not filed anywhere else (stored as group ''). */
export const UNGROUPED = 'Default'

interface Props {
  hosts: HostView[]
  groups: string[]
  tabs: Tab[]
  version: string
  /** A newer release found by the update check. */
  updateVersion?: string
  onAbout: () => void
  /** Group being browsed ('' = overview). */
  path: string
  onNavigate: (path: string) => void
  onConnect: (h: HostView) => void
  onEdit: (h: HostView) => void
  onDuplicate: (h: HostView) => void
  onDelete: (h: HostView) => Promise<void>
  onNewHost: (group?: string) => void
  /** parent = path of the group to create the new one in ('' = top level). */
  onNewGroup: (parent?: string) => void
  onRenameGroup: (path: string) => void
  onDeleteGroup: (path: string) => Promise<void>
  onQuickConnect: (target: string) => Promise<boolean>
  serialPorts: SerialPortInfo[]
  onOpenPort: (port: SerialPortInfo) => void
  onOpenConsole: () => void
}

type HostLayout = 'grid' | 'list'
type Confirm = { kind: 'host'; host: HostView } | { kind: 'group'; node: GroupNode }

// ---------- helpers ----------

export function timeAgo(iso?: string): string {
  if (!iso) return 'Never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

const address = hostAddress
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const crumbText = (path: string): string => path.split('/').join(' › ')

/** Stable colour per site: hash of the top-level group name. */
function hueOf(path: string): number {
  let h = 0
  for (const c of path.split('/')[0]) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 8
}

/** What happens to the direct contents when a group is dissolved. */
export function deleteEffect(node: GroupNode): string {
  const hosts = node.hosts.length
  const subs = node.children.length
  const parent = parentOf(node.path)
  if (parent) {
    const what = [hosts && plural(hosts, 'host'), subs && plural(subs, 'subgroup')].filter(Boolean).join(' and ')
    return what ? `${what} move to “${nameOf(parent)}”.` : ''
  }
  return [hosts && `${plural(hosts, 'host')} move to Default.`, subs && `${plural(subs, 'subgroup')} become top-level.`]
    .filter(Boolean)
    .join(' ')
}

function findNode(nodes: GroupNode[], path: string): GroupNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n
    if (path.startsWith(n.path + '/')) return findNode(n.children, path)
  }
}

const allHosts = (n: GroupNode): HostView[] => [...n.hosts, ...n.children.flatMap(allHosts)]

function loadLayout(): HostLayout {
  try {
    return localStorage.getItem('dashboard.hostLayout') === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

// ---------- component ----------

export default function Dashboard(p: Props) {
  const [quick, setQuick] = useState('')
  const [quickError, setQuickError] = useState('')
  const [filter, setFilter] = useState('')
  const [layout, setLayoutState] = useState<HostLayout>(loadLayout)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(scrollRef, 'y')

  const setLayout = (l: HostLayout) => {
    setLayoutState(l)
    try {
      localStorage.setItem('dashboard.hostLayout', l)
    } catch {
      // per-viewer convenience only
    }
  }

  const live = useMemo(() => new Set(p.tabs.filter((t) => t.status.state === 'ready').map((t) => t.hostId)), [p.tabs])
  const tree = useMemo(() => buildTree(p.groups, p.hosts), [p.groups, p.hosts])
  const node = p.path ? findNode(tree.roots, p.path) : undefined
  const { path, onNavigate } = p

  // The browsed group was deleted or renamed elsewhere: back to the overview.
  useEffect(() => {
    if (path && !node) onNavigate('')
  }, [path, node, onNavigate])

  // Each group starts unfiltered.
  useEffect(() => setFilter(''), [path])

  const subgroups = node ? node.children : tree.roots
  const directHosts = node ? node.hosts : tree.ungrouped
  const scopeHosts = node ? allHosts(node) : p.hosts
  const results = filter.trim() ? scopeHosts.filter((h) => hostMatches(h, filter)) : null

  const recent = useMemo(
    () =>
      p.hosts
        .filter((h) => h.lastConnectedAt)
        .sort((a, b) => b.lastConnectedAt!.localeCompare(a.lastConnectedAt!))
        .slice(0, 6),
    [p.hosts]
  )

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu(e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY, items } : { x: r.right - 180, y: r.bottom + 4, items })
  }

  const hostItems = (h: HostView): MenuItem[] => [
    { label: 'Connect', hint: '↵', onSelect: () => p.onConnect(h) },
    'separator',
    { label: 'Edit…', onSelect: () => p.onEdit(h) },
    { label: 'Duplicate', onSelect: () => p.onDuplicate(h) },
    'separator',
    { label: 'Delete…', danger: true, onSelect: () => setConfirm({ kind: 'host', host: h }) }
  ]

  const groupItems = (n: GroupNode): MenuItem[] => [
    { label: 'Open', onSelect: () => onNavigate(n.path) },
    'separator',
    { label: 'Add host here…', onSelect: () => p.onNewHost(n.path) },
    { label: 'New subgroup…', onSelect: () => p.onNewGroup(n.path) },
    'separator',
    { label: 'Rename…', onSelect: () => p.onRenameGroup(n.path) },
    { label: 'Delete group…', danger: true, onSelect: () => setConfirm({ kind: 'group', node: n }) }
  ]

  const submitQuick = async () => {
    if (!quick.trim()) return
    if (await p.onQuickConnect(quick)) {
      setQuick('')
      setQuickError('')
    } else setQuickError('Use the form user@host or user@host:port')
  }

  const isEmpty = p.hosts.length === 0 && p.groups.length === 0
  const legacyCount = p.hosts.filter((h) => h.legacy).length
  const crumbs = path ? path.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })) : []

  // ---------- pieces ----------

  const hostIcon = (h: HostView) => (
    <span className={`dh-icon ${h.legacy ? 'legacy' : ''} ${isSerial(h) ? 'serial' : ''} ${live.has(h.id) ? 'live' : ''}`}>
      {isSerial(h) ? <IconPlug size={16} /> : <IconServer size={16} />}
    </span>
  )

  const when = (h: HostView) =>
    live.has(h.id) ? <span className="live-text">● Connected</span> : <span>{timeAgo(h.lastConnectedAt)}</span>

  const moreBtn = (label: string, items: MenuItem[]) => (
    <button className="dh-more" aria-label={label} onClick={(e) => openMenu(e, items)}>
      <IconMore size={14} />
    </button>
  )

  const hostCard = (h: HostView, showPath: boolean) => (
    <div
      key={h.id}
      className="dh-card"
      role="button"
      tabIndex={0}
      aria-label={`Connect to ${h.name || h.host}`}
      onClick={() => p.onConnect(h)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && p.onConnect(h)}
      onContextMenu={(e) => openMenu(e, hostItems(h))}
    >
      <div className="dh-card-top">
        {hostIcon(h)}
        <div className="dh-card-title">
          <span className="card-name">{h.name || h.host}</span>
          <span className="card-target">{address(h)}</span>
        </div>
        {moreBtn(`Actions for ${h.name || h.host}`, hostItems(h))}
      </div>
      {showPath && h.group && <div className="dh-path">{crumbText(h.group)}</div>}
      <div className="card-meta">
        <span className="chip">{isSerial(h) ? 'console' : h.auth}</span>
        {h.legacy && <span className="chip warn">legacy</span>}
        {h.logSession && <span className="chip">log</span>}
        <span className="card-when">{when(h)}</span>
      </div>
    </div>
  )

  const hostTable = (list: HostView[], showPath: boolean) => (
    <div className="dh-table-wrap">
      <ScrollRow>
        <table className="dh-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>Login</th>
              <th>Last connected</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.map((h) => (
              <tr
                key={h.id}
                className="dh-row"
                tabIndex={0}
                aria-label={`Connect to ${h.name || h.host}`}
                onClick={() => p.onConnect(h)}
                onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && p.onConnect(h)}
                onContextMenu={(e) => openMenu(e, hostItems(h))}
              >
                <td>
                  <div className="dh-name-cell">
                    {hostIcon(h)}
                    <div className="dh-name-text">
                      <div className="card-name">{h.name || h.host}</div>
                      {showPath && h.group && <div className="dh-path">{crumbText(h.group)}</div>}
                    </div>
                  </div>
                </td>
                <td className="mono">{address(h)}</td>
                <td>
                  <span className="chip">{isSerial(h) ? 'console' : h.auth}</span>
                  {h.legacy && <span className="chip warn">legacy</span>}
                </td>
                <td className="muted">{when(h)}</td>
                <td className="dh-actions-cell">{moreBtn(`Actions for ${h.name || h.host}`, hostItems(h))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRow>
    </div>
  )

  const hostView = (list: HostView[], showPath: boolean) =>
    layout === 'grid' ? <div className="dh-grid">{list.map((h) => hostCard(h, showPath))}</div> : hostTable(list, showPath)

  const groupTile = (n: GroupNode) => {
    const liveHere = allHosts(n).filter((h) => live.has(h.id)).length
    return (
      <div
        key={n.path}
        className={`dg-tile hue-${hueOf(n.path)}`}
        data-group={n.path}
        role="button"
        tabIndex={0}
        aria-label={`Open group ${n.name}`}
        onClick={() => onNavigate(n.path)}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onNavigate(n.path)}
        onContextMenu={(e) => openMenu(e, groupItems(n))}
      >
        <div className="dg-top">
          <span className="dg-icon">
            <IconFolder size={18} />
          </span>
          {moreBtn(`Actions for group ${n.name}`, groupItems(n))}
        </div>
        <div className="dg-name">{n.name}</div>
        <div className="dg-meta">
          <span className="dg-count">{plural(n.total, 'host')}</span>
          {n.children.length > 0 && <span>· {plural(n.children.length, 'subgroup')}</span>}
          {liveHere > 0 && <span className="live-text">● {liveHere} live</span>}
        </div>
      </div>
    )
  }

  // ---------- render ----------

  return (
    <div className={`dashboard scroll-fade scroll-fade-y${fadeClass(edges)}`} ref={scrollRef}>
      <header className="dash-top">
        <div className="brand-row">
          <img className="brand-mark" src={logo} alt="" width={36} height={36} draggable={false} />
          <h1 className="brand">Termflow</h1>
          {p.version && (
            <button
              className={`ver-chip${p.updateVersion ? ' has-update' : ''}`}
              onClick={p.onAbout}
              title={p.updateVersion ? `Termflow ${p.updateVersion} is available` : 'About Termflow and updates'}
            >
              v{p.version}
              {p.updateVersion && <span className="ver-update">Update</span>}
            </button>
          )}
        </div>
        <div className="dash-actions">
          <button className="btn with-icon" onClick={() => window.shell.openLogsDir()} title="Open the session logs folder in Finder">
            <IconLogs size={14} /> Logs
          </button>
          <button className="btn with-icon console-btn" onClick={p.onOpenConsole} title="Open a console session">
            <IconPlug size={14} /> Console
          </button>
          <div className="split-btn">
            <button className="btn primary with-icon" onClick={() => p.onNewHost(path)}>
              <IconPlus size={14} /> New host
            </button>
            <button
              className="btn primary split-arrow"
              aria-label="More new options"
              onClick={(e) =>
                openMenu(e, [
                  { label: 'New host…', hint: '⌘N', icon: <IconServer size={14} />, onSelect: () => p.onNewHost(path) },
                  {
                    label: node ? `New group in ${node.name}…` : 'New group…',
                    icon: <IconFolder size={14} />,
                    onSelect: () => p.onNewGroup(path)
                  }
                ])
              }
            >
              <IconChevron open size={12} />
            </button>
          </div>
        </div>
      </header>

      <form
        className="command-bar"
        onSubmit={(e) => {
          e.preventDefault()
          submitQuick()
        }}
      >
        <IconTerminal size={16} />
        <span className="cmd-prefix">ssh</span>
        <input
          value={quick}
          onChange={(e) => {
            setQuick(e.target.value)
            setQuickError('')
          }}
          placeholder="admin@10.0.0.1:22"
          aria-label="Quick connect target"
          spellCheck={false}
        />
        <button type="submit" className="btn primary">
          Connect
        </button>
      </form>
      {quickError && <p className="error dash-quick-error">{quickError}</p>}

      {!path && p.serialPorts.length > 0 && (
        <section className="dash-section">
          <h2 className="dash-title">
            <IconPlug size={13} /> Console ports <span className="count">{p.serialPorts.length}</span>
          </h2>
          <ScrollRow className="recent-row">
            {p.serialPorts.map((port) => (
              <button
                key={port.path}
                className="recent port"
                onClick={() => p.onOpenPort(port)}
                title={`Open console on ${port.path} at 9600 8N1`}
              >
                <span className="dh-icon serial">
                  <IconPlug size={16} />
                </span>
                <span className="recent-text">
                  <span className="recent-name">{port.manufacturer || 'USB console'}</span>
                  <span className="recent-when">{port.name}</span>
                </span>
              </button>
            ))}
          </ScrollRow>
        </section>
      )}

      {isEmpty ? (
        <section className="dash-empty">
          <h2>Welcome to Termflow</h2>
          <p>Save the devices you use often so you can open them with one click.</p>
          <ol>
            <li>
              <b>Create a group</b> for each site, then subgroups for buildings or floors.
            </li>
            <li>
              <b>Add hosts</b> with their IP, username and login method.
            </li>
            <li>
              <b>Click a host</b> to open an SSH session in a new tab.
            </li>
          </ol>
          <div className="dash-actions">
            <button className="btn" onClick={() => p.onNewGroup()}>
              + New group
            </button>
            <button className="btn primary" onClick={() => p.onNewHost()}>
              + Add first host
            </button>
          </div>
        </section>
      ) : (
        <>
          {!path && (
            <section className="stat-row" aria-label="Summary">
              <div className="stat">
                <span className="stat-icon">
                  <IconServer size={16} />
                </span>
                <b>{p.hosts.length}</b>
                <span>Hosts</span>
              </div>
              <div className="stat">
                <span className="stat-icon">
                  <IconFolder size={16} />
                </span>
                <b>{p.groups.length}</b>
                <span>Groups</span>
              </div>
              <div className={`stat ${live.size ? 'ok' : ''}`}>
                <span className="stat-icon">
                  <IconPulse size={16} />
                </span>
                <b>{live.size}</b>
                <span>Live sessions</span>
              </div>
              <div className={`stat ${legacyCount ? 'warn' : ''}`}>
                <span className="stat-icon">
                  <IconWarn size={16} />
                </span>
                <b>{legacyCount}</b>
                <span>Legacy devices</span>
              </div>
            </section>
          )}

          {!path && recent.length > 0 && (
            <section className="dash-section">
              <h2 className="dash-title">
                <IconClock size={13} /> Recent
              </h2>
              <ScrollRow className="recent-row">
                {recent.map((h) => (
                  <button key={h.id} className="recent" onClick={() => p.onConnect(h)} title={`Connect to ${address(h)}`}>
                    {hostIcon(h)}
                    <span className="recent-text">
                      <span className="recent-name">{h.name || h.host}</span>
                      <span className="recent-when">{live.has(h.id) ? 'Connected' : timeAgo(h.lastConnectedAt)}</span>
                    </span>
                  </button>
                ))}
              </ScrollRow>
            </section>
          )}

          {node && (
            <section className={`group-hero hue-${hueOf(node.path)}`}>
              <div className="hero-nav">
                <button
                  className="back-btn"
                  onClick={() => onNavigate(parentOf(node.path))}
                  title={`Back to ${parentOf(node.path) ? nameOf(parentOf(node.path)) : 'Overview'} (⌘[)`}
                >
                  <IconBack size={14} />
                  <span>Back</span>
                </button>
                <nav className="crumbs" aria-label="Breadcrumb">
                  <button onClick={() => onNavigate('')}>Overview</button>
                  {crumbs.map((c, i) => (
                    <span key={c.path} className="crumb">
                      <IconChevron size={11} />
                      {i < crumbs.length - 1 ? <button onClick={() => onNavigate(c.path)}>{c.name}</button> : <span aria-current="page">{c.name}</span>}
                    </span>
                  ))}
                </nav>
              </div>
              <div className="hero-row">
                <span className="dg-icon big">
                  <IconFolder size={22} open />
                </span>
                <div className="hero-text">
                  <h2>{node.name}</h2>
                  <p className="muted">
                    {plural(node.total, 'host')}
                    {node.children.length > 0 && ` · ${plural(node.children.length, 'subgroup')}`}
                  </p>
                </div>
                <div className="dash-actions">
                  <button className="btn small primary" onClick={() => p.onNewHost(node.path)}>
                    + Add host
                  </button>
                  <button className="btn small" onClick={() => p.onNewGroup(node.path)}>
                    + Subgroup
                  </button>
                  <button
                    className="btn small icon-only"
                    aria-label={`More actions for ${node.name}`}
                    onClick={(e) =>
                      openMenu(e, [
                        { label: 'Rename…', onSelect: () => p.onRenameGroup(node.path) },
                        { label: 'Delete group…', danger: true, onSelect: () => setConfirm({ kind: 'group', node }) }
                      ])
                    }
                  >
                    <IconMore size={14} />
                  </button>
                </div>
              </div>
            </section>
          )}

          <div className="browse-bar">
            <label className="search-box dash-filter">
              <IconSearch size={14} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
                placeholder={node ? `Filter hosts in ${node.name}` : 'Filter all hosts by name, IP, user or group'}
                aria-label="Filter hosts"
                spellCheck={false}
              />
            </label>
            <div className="seg" role="group" aria-label="Host layout">
              <button className={layout === 'grid' ? 'on' : ''} aria-pressed={layout === 'grid'} title="Grid" onClick={() => setLayout('grid')}>
                <IconGrid size={14} />
              </button>
              <button className={layout === 'list' ? 'on' : ''} aria-pressed={layout === 'list'} title="List" onClick={() => setLayout('list')}>
                <IconList size={14} />
              </button>
            </div>
          </div>

          {results ? (
            <section className="dash-section">
              <h2 className="dash-title">
                {plural(results.length, 'result')}
                {node && <span className="dash-title-sub"> in {node.name}</span>}
              </h2>
              {results.length ? hostView(results, true) : <p className="muted dash-none">No hosts match “{filter}”.</p>}
            </section>
          ) : (
            <>
              {(!node || subgroups.length > 0) && (
              <section className="dash-section">
                <h2 className="dash-title">
                  {node ? 'Subgroups' : 'Groups'} <span className="count">{subgroups.length}</span>
                </h2>
                <div className="dg-grid">
                  {subgroups.map(groupTile)}
                  <button className="dg-tile new" onClick={() => p.onNewGroup(path)}>
                    <IconPlus size={18} />
                    <span>{node ? 'New subgroup' : 'New group'}</span>
                  </button>
                </div>
              </section>
              )}

              {(directHosts.length > 0 || node) && (
                <section className="dash-section">
                  <h2 className="dash-title">
                    {node ? `Hosts in ${node.name}` : UNGROUPED} <span className="count">{directHosts.length}</span>
                  </h2>
                  {directHosts.length > 0 ? (
                    hostView(directHosts, false)
                  ) : (
                    <button className="group-empty" onClick={() => p.onNewHost(path)}>
                      No hosts directly in this group yet — click to add one
                    </button>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}

      <p className="dash-foot muted">
        ⌘0 dashboard · ⌘K search · ⌘1–9 switch tabs · ⌘W close tab · ⌘N new host
        {p.version && <span className="dash-version">Termflow v{p.version}</span>}
      </p>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm?.kind === 'host' && (
        <ConfirmDialog
          title="Delete host?"
          message={
            <>
              <b>{confirm.host.name || confirm.host.host}</b> ({address(confirm.host)}) and its saved password will be removed.
            </>
          }
          confirmLabel="Delete host"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await p.onDelete(confirm.host)
            setConfirm(null)
          }}
        />
      )}
      {confirm?.kind === 'group' && (
        <ConfirmDialog
          title={`Delete group “${confirm.node.name}”?`}
          message={deleteEffect(confirm.node) || 'The group is empty.'}
          confirmLabel="Delete group"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await p.onDeleteGroup(confirm.node.path)
            setConfirm(null)
          }}
        />
      )}
    </div>
  )
}
