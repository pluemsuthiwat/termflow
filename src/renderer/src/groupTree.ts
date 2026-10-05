import { useState } from 'react'
import { nameOf, parentOf } from '../../shared/groups'
import type { HostView } from '../../shared/types'

export interface GroupNode {
  path: string
  name: string
  depth: number
  hosts: HostView[]
  children: GroupNode[]
  /** Hosts in this group and all subgroups. */
  total: number
}

const byName = (a: HostView, b: HostView): number => (a.name || a.host).localeCompare(b.name || b.host)

export function hostMatches(h: HostView, query: string): boolean {
  const q = query.trim().toLowerCase()
  const target = h.serial ? h.serial.path : `${h.username}@${h.host}:${h.port}`
  return !q || [h.name, h.host, h.username, h.group, target].some((v) => v.toLowerCase().includes(q))
}

/**
 * Build the group tree. With a query, only matching hosts are kept and groups
 * without any match in their subtree are dropped.
 */
export function buildTree(groups: string[], hosts: HostView[], query = ''): { roots: GroupNode[]; ungrouped: HostView[] } {
  const nodes = new Map<string, GroupNode>()
  for (const path of [...groups].sort((a, b) => a.localeCompare(b))) {
    nodes.set(path, { path, name: nameOf(path), depth: path.split('/').length - 1, hosts: [], children: [], total: 0 })
  }
  const ungrouped: HostView[] = []
  for (const h of hosts) {
    if (!hostMatches(h, query)) continue
    const node = h.group ? nodes.get(h.group) : undefined
    if (node) node.hosts.push(h)
    else ungrouped.push(h)
  }
  const roots: GroupNode[] = []
  for (const node of nodes.values()) {
    node.hosts.sort(byName)
    const parent = nodes.get(parentOf(node.path))
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const count = (n: GroupNode): number => (n.total = n.hosts.length + n.children.reduce((s, c) => s + count(c), 0))
  roots.forEach(count)

  if (!query.trim()) return { roots, ungrouped: ungrouped.sort(byName) }
  const prune = (list: GroupNode[]): GroupNode[] =>
    list.filter((n) => n.total > 0).map((n) => ({ ...n, children: prune(n.children) }))
  return { roots: prune(roots), ungrouped: ungrouped.sort(byName) }
}

/** Collapsed group paths, remembered per view in localStorage. */
export function useCollapsed(key: string): [Set<string>, (path: string) => void, (paths: string[]) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const save = (next: Set<string>): Set<string> => {
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // storage unavailable: state just won't persist
    }
    return next
  }
  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return save(next)
    })
  const setAll = (paths: string[]): void => setCollapsed(save(new Set(paths)))
  return [collapsed, toggle, setAll]
}
