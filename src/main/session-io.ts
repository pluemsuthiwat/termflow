import type { WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SessionStatus } from '../shared/types'
import * as store from './store'

// Plumbing shared by SSH and serial sessions: events to the window and session logs.

let target: WebContents | null = null
export function attach(wc: WebContents): void {
  target = wc
}

export function send(channel: string, ...args: unknown[]): void {
  if (target && !target.isDestroyed()) target.send(channel, ...args)
}

export function status(sessionId: string, s: SessionStatus): void {
  send('ssh:status', sessionId, s)
}

export function data(sessionId: string, chunk: Buffer): void {
  send('ssh:data', sessionId, chunk)
}

// Strip terminal control sequences so logs read as plain text.
export function toPlainText(s: string): string {
  let out = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g, '')
    .replace(/\r/g, '')
  // Apply backspaces (used e.g. to erase " --More-- " prompts).
  while (/[^\n\x08]\x08/.test(out)) out = out.replace(/[^\n\x08]\x08/g, '')
  return out.replace(/\x08/g, '')
}

export interface SessionLog {
  file: string
  write(chunk: Buffer): void
  end(): void
}

/** Plain-text session log in logs/ssh or logs/console. */
export function openLog(kind: store.LogKind, name: string): SessionLog {
  // Logs hold device output (configs, hashes, SNMP communities): owner-only.
  store.ensurePrivateDir(store.logsDir())
  store.ensurePrivateDir(store.logsDirFor(kind))
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const safe = name.replace(/[^\w.-]+/g, '_')
  const file = path.join(store.logsDirFor(kind), `${safe}_${stamp}.log`)
  const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
  const decoder = new StringDecoder('utf8')
  return {
    file,
    write: (chunk) => stream.write(toPlainText(decoder.write(chunk))),
    end: () => stream.end()
  }
}
