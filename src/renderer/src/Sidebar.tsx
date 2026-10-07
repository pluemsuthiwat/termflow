import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { hostAddress } from '../../shared/hosts'
import type { HostView, SerialPortInfo } from '../../shared/types'
import ContextMenu, { type MenuItem, type MenuState } from './ContextMenu'
import { deleteEffect, UNGROUPED } from './Dashboard'
import { ConfirmDialog } from './dialogs'
import { buildTree, useCollapsed, type GroupNode } from './groupTree'
import { fadeClass, useScrollEdges } from './scrollEdges'
import {
  IconBolt,
  IconChevron,
  IconFolder,
  IconMore,
  IconPlug,
  IconPlus,
  IconSearch,
  IconServer
} from './icons'

interface Props {
  hosts: HostView[]
  groups: string[]
  liveHostIds: Set<string>
  activeHostId?: string
  /** Host open in the edit dialog. */
  editingHostId?: string
  dataDir: string
  onShowGroup: (path: string) => void
  onConnect: (h: HostView) => void
  /** Set while a terminal is shown: open the host next to its focused pane. */
  onOpenInSplit?: (h: HostView) => void
  /** Set while a terminal is shown: a host can be dragged onto a pane. */
  onHostPointerDown?: (e: React.PointerEvent, h: HostView) => void
  onEdit: (h: HostView) => void
  onDuplicate: (h: HostView) => void
  onDeleteHost: (h: HostView) => Promise<void>
  onNewHost: (group?: string) => void
  onNewGroup: (parent?: string) => void
  onRenameGroup: (path: string) => void
  onDeleteGroup: (path: string) => Promise<void>
  onQuickConnect: (target: string) => Promise<boolean>
  onOpenDataDir: () => void
  serialPorts: SerialPortInfo[]
  onOpenPort: (port: SerialPortInfo, baudRate?: number) => void
  onSavePort: (port: SerialPortInfo) => void
}

const PORT_BAUDS = [9600, 19200, 38400, 57600, 115200]

type Confirm = { kind: 'host'; host: HostView } | { kind: 'group'; node: GroupNode }

const INDENT = 18
const indent = (depth: number) => 8 + depth * INDENT

/** Text that looks like an SSH target rather than a search term. */
const looksLikeTarget = (q: string) => /^\S+$/.test(q) && /[@.:[]/.test(q)

export default function Sidebar(p: Props) {
  const [query, setQuery] = useState('')
  // owner: the row the menu belongs to, kept highlighted while the menu is open.
  const [menu, setMenu] = useState<(MenuState & { owner?: string }) | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [collapsed, toggle] = useCollapsed('collapsedGroups.sidebar')
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const treeEdges = useScrollEdges(treeRef, 'y')

  const q = query.trim()
  const searching = !!q
  const tree = useMemo(() => buildTree(p.groups, p.hosts, q), [p.groups, p.hosts, q])
  const quickTarget = looksLikeTarget(q) ? q : null
  const defaultNode: GroupNode = {
    path: '',
    name: UNGROUPED,
    depth: 0,
    hosts: tree.ungrouped,
    children: [],
    total: tree.ungrouped.length
  }
  const matchCount = useMemo(() => {
    const count = (n: GroupNode): number => n.hosts.length + n.children.reduce((s, c) => s + count(c), 0)
    return tree.ungrouped.length + tree.roots.reduce((s, n) => s + count(n), 0)
  }, [tree])

  // ⌘K focuses search from anywhere.
  useEffect(
    () =>
      window.shell.onMenu((action) => {
        if (action === 'search') {
          searchRef.current?.focus()
          searchRef.current?.select()
        }
      }),
    []
  )

  const openMenu = (e: MouseEvent, items: MenuItem[], owner?: string) => {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // Right-click opens at the pointer, the ⋯ button below itself.
    const at = e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 }
    setMenu({ ...at, items, owner })
  }
  /** Row being worked on (menu, edit or delete dialog open): keep it marked after the pointer leaves. */
  const working = (owner: string): string =>
    menu?.owner === owner ||
    owner === `host:${p.editingHostId}` ||
    (confirm?.kind === 'host' && owner === `host:${confirm.host.id}`) ||
    (confirm?.kind === 'group' && owner === `group:${confirm.node.path}`)
      ? 'working'
      : ''

  const hostItems = (h: HostView): MenuItem[] => [
    { label: 'Connect', onSelect: () => p.onConnect(h), hint: '↵' },
    ...(p.onOpenInSplit ? [{ label: 'Open in Split', onSelect: () => p.onOpenInSplit!(h), hint: '⌥↵' }] : []),
    'separator',
    { label: 'Edit…', onSelect: () => p.onEdit(h) },
    { label: 'Duplicate', onSelect: () => p.onDuplicate(h) },
    'separator',
    { label: 'Delete…', danger: true, onSelect: () => setConfirm({ kind: 'host', host: h }) }
  ]

  const groupItems = (n: GroupNode): MenuItem[] =>
    n.path === '' ? [{ label: 'Add host here…', onSelect: () => p.onNewHost('') }] : [
    { label: 'Show in dashboard', onSelect: () => p.onShowGroup(n.path) },
    'separator',
    { label: 'Add host here…', onSelect: () => p.onNewHost(n.path) },
    { label: 'New subgroup…', onSelect: () => p.onNewGroup(n.path) },
    'separator',
    { label: 'Rename…', onSelect: () => p.onRenameGroup(n.path) },
    { label: 'Delete group…', danger: true, onSelect: () => setConfirm({ kind: 'group', node: n }) }
  ]

  const newItems: MenuItem[] = [
    { label: 'New host…', hint: '⌘N', icon: <IconServer size={14} />, onSelect: () => p.onNewHost() },
    { label: 'New group…', icon: <IconFolder size={14} />, onSelect: () => p.onNewGroup() }
  ]

  const submitSearch = async () => {
    if (quickTarget && (await p.onQuickConnect(quickTarget))) return setQuery('')
    const first = treeRef.current?.querySelector<HTMLElement>('.host.side-row')
    if (matchCount === 1 && first) first.click()
  }

  // Arrow-key navigation across visible rows.
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...treeRef.current!.querySelectorAll<HTMLElement>('.side-row')]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    const row = rows[i]
    const path = row.dataset.path // '' is the Default group
    if (e.key === 'ArrowDown') rows[i + 1]?.focus()
    else if (e.key === 'ArrowUp') (rows[i - 1] ?? searchRef.current)?.focus()
    else if (e.key === 'ArrowRight' && path !== undefined && collapsed.has(path)) toggle(path)
    else if (e.key === 'ArrowLeft' && path !== undefined && !collapsed.has(path) && !searching) toggle(path)
    // ⌥↵ like ⌥-click: open the host in a split.
    else if (e.key === 'Enter' && e.altKey) row.dispatchEvent(new window.MouseEvent('click', { bubbles: true, altKey: true }))
    else if (e.key === 'Enter' || e.key === ' ') row.click()
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 24, clientY: r.bottom }))
    } else return
    e.preventDefault()
  }

  const hostRow = (h: HostView, depth: number) => {
    const live = p.liveHostIds.has(h.id)
    const name = h.name || h.host
    return (
      <div
        key={h.id}
        className={`host side-row ${h.id === p.activeHostId ? 'current' : ''} ${working(`host:${h.id}`)}`}
        // Indent with margin so the row's frame starts right of the tree guide line.
        style={{ marginLeft: indent(depth) - 8 }}
        tabIndex={-1}
        title={hostAddress(h)}
        onClick={(e) => (e.altKey && p.onOpenInSplit ? p.onOpenInSplit(h) : p.onConnect(h))}
        onContextMenu={(e) => openMenu(e, hostItems(h), `host:${h.id}`)}
        onPointerDown={(e) => p.onHostPointerDown?.(e, h)}
      >
        <span className={`status-dot ${live ? 'live' : ''}`} title={live ? 'Connected' : 'Not connected'} />
        <div className="host-main">
          <div className="host-name">
            <span className="host-label">{name}</span>
            {h.legacy && <span className="badge">legacy</span>}
          </div>
          <div className="host-sub">{hostAddress(h)}</div>
        </div>
        <button
          className="row-more"
          title="More actions"
          aria-label={`More actions for ${name}`}
          onClick={(e) => openMenu(e, hostItems(h), `host:${h.id}`)}
        >
          <IconMore size={14} />
        </button>
      </div>
    )
  }

  const groupRow = (n: GroupNode) => {
    const open = searching || !collapsed.has(n.path)
    return (
      <section key={n.path || UNGROUPED} data-group={n.path || UNGROUPED}>
        <div
          className={`side-row side-group ${working(`group:${n.path}`)}`}
          data-path={n.path}
          style={{ paddingLeft: indent(n.depth) - 4 }}
          tabIndex={-1}
          aria-expanded={open}
          onClick={() => !searching && toggle(n.path)}
          onContextMenu={(e) => openMenu(e, groupItems(n), `group:${n.path}`)}
        >
          <span className="chev">
            <IconChevron open={open} size={12} />
          </span>
          <span className="row-icon folder">
            <IconFolder size={14} open={open} />
          </span>
          <h3>{n.name}</h3>
          <button
            className="row-more"
            title="Group actions"
            aria-label={`Actions for group ${n.name}`}
            onClick={(e) => openMenu(e, groupItems(n), `group:${n.path}`)}
          >
            <IconMore size={14} />
          </button>
        </div>
        {open && (
          <div className="tree-children" style={{ ['--guide' as string]: `${indent(n.depth) + 2}px` }}>
            {n.hosts.map((h) => hostRow(h, n.depth + 1))}
            {n.children.map(groupRow)}
            {n.total === 0 && n.children.length === 0 && (
              <button className="tree-empty" style={{ paddingLeft: indent(n.depth + 1) }} onClick={() => p.onNewHost(n.path)}>
                <IconPlus size={14} /> Add host
              </button>
            )}
          </div>
        )}
      </section>
    )
  }


  return (
    <>
      <div className="drag-region" />

      <div className="side-search">
        <label className="search-box">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitSearch()
              } else if (e.key === 'Escape') {
                setQuery('')
                e.currentTarget.blur()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                treeRef.current?.querySelector<HTMLElement>('.side-row')?.focus()
              }
            }}
            placeholder="Search or user@host"
            aria-label="Search hosts or connect"
            spellCheck={false}
          />
          {!query && <kbd>⌘K</kbd>}
        </label>
      </div>


      {p.serialPorts.length > 0 && (
        <div className="serial-ports">
          <div className="side-section-head">
            <span>Console ports · {p.serialPorts.length}</span>
          </div>
          {p.serialPorts.map((port) => {
            const items: MenuItem[] = [
              ...PORT_BAUDS.map((b) => ({ label: `Connect at ${b}${b === 9600 ? ' (default)' : ''}`, onSelect: () => p.onOpenPort(port, b) })),
              'separator' as const,
              { label: 'Save as host…', onSelect: () => p.onSavePort(port) }
            ]
            return (
              <div
                key={port.path}
                className="side-row port-row"
                tabIndex={-1}
                title={`Connect to ${port.path} at 9600 8N1`}
                onClick={() => p.onOpenPort(port)}
                onContextMenu={(e) => openMenu(e, items)}
              >
                <span className={`row-icon ${p.liveHostIds.has(`port:${port.path}`) ? 'live' : ''}`}>
                  <IconPlug size={14} />
                </span>
                <div className="host-main">
                  <div className="host-name">
                    <span className="host-label">{port.manufacturer || 'USB console'}</span>
                  </div>
                  <div className="host-sub">{port.name}</div>
                </div>
                <button className="row-more" title="Port options" aria-label={`Options for ${port.name}`} onClick={(e) => openMenu(e, items)}>
                  <IconMore size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="side-section-head">
        <span>Hosts{searching && ` · ${matchCount} found`}</span>
        <button className="icon-btn small" title="New host or group" aria-label="New" onClick={(e) => openMenu(e, newItems)}>
          <IconPlus size={15} />
        </button>
      </div>

      <div className={`host-list scroll-fade scroll-fade-y${fadeClass(treeEdges)}`} ref={treeRef} onKeyDown={onTreeKey}>
        {quickTarget && (
          <div className="side-row quick-row" tabIndex={-1} onClick={submitSearch}>
            <span className="row-icon">
              <IconBolt size={14} />
            </span>
            <span className="quick-text">
              Connect to <b>{quickTarget}</b>
            </span>
            <kbd>↵</kbd>
          </div>
        )}

        {/* Default is always first; while searching, only if it has matches. */}
        {(!searching || tree.ungrouped.length > 0) && groupRow(defaultNode)}
        {tree.roots.map(groupRow)}

        {matchCount === 0 && searching && !quickTarget && (
          <div className="side-empty">
            <p>No matching hosts.</p>
          </div>
        )}
      </div>

      <footer className="side-foot">
        <button className="foot-btn" onClick={p.onOpenDataDir} title={p.dataDir}>
          <IconFolder size={14} />
          <span>Data folder</span>
        </button>
      </footer>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm?.kind === 'host' && (
        <ConfirmDialog
          title="Delete host?"
          message={
            <>
              <b>{confirm.host.name || confirm.host.host}</b> ({hostAddress(confirm.host)}) and its saved password will be
              removed.
            </>
          }
          confirmLabel="Delete host"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await p.onDeleteHost(confirm.host)
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
    </>
  )
}
