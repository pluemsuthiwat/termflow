import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  isWithin,
  joinPath,
  nameOf,
  normalizePath,
  parentOf,
  rebase,
  validateSegment,
  withAncestors
} from '../shared/groups'
import type { Host, HostInput, HostView } from '../shared/types'

// Everything lives in ~/Library/Application Support/Termflow/
//   hosts.json        host list (no secrets)
//   groups.json       group names, so empty groups survive
//   secrets.json      passwords / key passphrases, encrypted with a Keychain-held key
//   known_hosts.json  trusted host-key fingerprints, keyed by "host:port"
//   logs/             session logs
export const dataDir = (): string => app.getPath('userData')
export const logsDir = (): string => path.join(dataDir(), 'logs')

const file = (name: string): string => path.join(dataDir(), name)

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

function writeJsonAtomic(name: string, value: unknown): void {
  fs.mkdirSync(dataDir(), { recursive: true })
  const target = file(name)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
}

// ---- hosts ----

export function getHosts(): Host[] {
  return readJson<Host[]>('hosts.json', [])
}

export function getHost(id: string): Host | undefined {
  return getHosts().find((h) => h.id === id)
}

export function listHostViews(): HostView[] {
  const secrets = readSecrets()
  return getHosts().map((h) => ({ ...h, hasSecret: h.id in secrets }))
}

export function saveHost(input: HostInput): HostView {
  // hasSecret may ride along from a HostView being edited; it is derived, never stored.
  const { secret, hasSecret: _derived, ...rest } = input as HostInput & { hasSecret?: boolean }
  const host: Host = {
    ...rest,
    id: input.id ?? randomUUID(),
    port: Number(rest.port) || 22,
    kind: rest.kind ?? 'ssh',
    // Typing "Default" means the built-in group, stored as ''.
    group: /^default$/i.test(normalizePath(rest.group ?? '')) ? '' : normalizePath(rest.group ?? '')
  }
  const hosts = getHosts()
  const idx = hosts.findIndex((h) => h.id === host.id)
  if (idx >= 0) hosts[idx] = host
  else hosts.push(host)
  writeJsonAtomic('hosts.json', hosts)
  if (secret !== undefined) setSecret(host.id, secret || null)
  return { ...host, hasSecret: host.id in readSecrets() }
}

export function touchHost(id: string): void {
  const hosts = getHosts()
  const h = hosts.find((x) => x.id === id)
  if (!h) return
  h.lastConnectedAt = new Date().toISOString()
  writeJsonAtomic('hosts.json', hosts)
}

// ---- groups ----
// A group is a path ("Site A/Building 1"). It exists if it is listed in
// groups.json, any host uses it, or it is an ancestor of either.

const storedGroups = (): string[] => readJson<string[]>('groups.json', [])

export function listGroups(): string[] {
  const names = new Set<string>()
  for (const g of [...storedGroups(), ...getHosts().map((h) => h.group)]) {
    if (g) withAncestors(g).forEach((a) => names.add(a))
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** "Default" is the built-in home of ungrouped hosts; no top-level group may take its name. */
function checkReserved(path: string): void {
  if (path.toLowerCase() === 'default') throw new Error('"Default" is a built-in group; choose another name')
}

export function createGroup(name: string, parent = ''): void {
  const path = joinPath(normalizePath(parent), validateSegment(name))
  checkReserved(path)
  if (listGroups().includes(path)) throw new Error(`Group "${nameOf(path)}" already exists here`)
  writeJsonAtomic('groups.json', [...storedGroups(), path])
}

/** Move everything within `from` to `to`, in hosts.json and groups.json. */
function moveGroupTree(from: string, to: string): void {
  const move = (g: string): string => (g && isWithin(g, from) ? rebase(g, from, to) : g)
  writeJsonAtomic(
    'hosts.json',
    getHosts().map((h) => ({ ...h, group: move(h.group) }))
  )
  const groups = [...new Set(storedGroups().map(move).filter(Boolean))]
  writeJsonAtomic('groups.json', groups)
}

/** Rename the last segment; subgroups and hosts move along. */
export function renameGroup(path: string, newName: string): void {
  const to = joinPath(parentOf(path), validateSegment(newName))
  if (to === path) return
  checkReserved(to)
  if (listGroups().includes(to)) throw new Error(`Group "${nameOf(to)}" already exists here`)
  moveGroupTree(path, to)
}

/** Dissolve a group: its hosts and subgroups move up one level. */
export function deleteGroup(path: string): void {
  moveGroupTree(path, parentOf(path))
}

export function deleteHost(id: string): void {
  writeJsonAtomic(
    'hosts.json',
    getHosts().filter((h) => h.id !== id)
  )
  setSecret(id, null)
}

// ---- secrets (encrypted with Electron safeStorage => macOS Keychain) ----

function readSecrets(): Record<string, string> {
  return readJson<Record<string, string>>('secrets.json', {})
}

export function getSecret(hostId: string): string | undefined {
  const enc = readSecrets()[hostId]
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch (err) {
    // Keychain item missing/denied: behave as if nothing is saved so the user is prompted.
    console.warn(`Cannot decrypt secret for ${hostId}:`, (err as Error).message)
    return undefined
  }
}

export function setSecret(hostId: string, value: string | null): void {
  const secrets = readSecrets()
  if (value === null) {
    if (!(hostId in secrets)) return
    delete secrets[hostId]
  } else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available')
    secrets[hostId] = safeStorage.encryptString(value).toString('base64')
  }
  writeJsonAtomic('secrets.json', secrets)
}

// ---- known hosts ----

export interface KnownHost {
  keyType: string
  fingerprint: string
  addedAt: string
}

export function getKnownHost(hostPort: string): KnownHost | undefined {
  return readJson<Record<string, KnownHost>>('known_hosts.json', {})[hostPort]
}

export function setKnownHost(hostPort: string, entry: KnownHost): void {
  const all = readJson<Record<string, KnownHost>>('known_hosts.json', {})
  all[hostPort] = entry
  writeJsonAtomic('known_hosts.json', all)
}
