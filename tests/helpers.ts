import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server, utils, type AuthContext, type ServerChannel } from 'ssh2'
import type { Host } from '../src/shared/types'

export const APP_DIR = path.resolve(__dirname, '..')

// ---------- keys (generated once per worker) ----------

export const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termflow-keys-'))
export const KEY_PASSPHRASE = 'pass123'

function sshKeygen(name: string, args: string[]): string {
  const file = path.join(keysDir, name)
  execFileSync('ssh-keygen', ['-q', '-f', file, '-C', name, ...args])
  return file
}

export const keys = {
  ed25519: sshKeygen('id_ed25519', ['-t', 'ed25519', '-N', '']),
  ed25519Enc: sshKeygen('id_ed25519_enc', ['-t', 'ed25519', '-N', KEY_PASSPHRASE]),
  rsaPem: sshKeygen('id_rsa_pem', ['-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', ''])
}

const pem = (): string =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey

/** Two stable host keys so fingerprint tests are deterministic. */
export const hostKeys = { a: pem(), b: pem() }

// ---------- fake network device ----------

type Method = 'password' | 'keyboard-interactive' | 'publickey'

export interface FakeServerOptions {
  legacyOnly?: boolean
  hostKey?: string
  methods?: Method[]
  password?: string
  /** Public key files allowed for publickey auth. */
  authorizedKeys?: string[]
  /** keyboard-interactive prompts; answers checked by kbdCheck (default: [password]). */
  kbdPrompts?: { prompt: string; echo: boolean }[]
  kbdCheck?: (answers: string[]) => boolean
  prompt?: string
}

export type ServerEvent =
  | { type: 'auth'; method: string; answers?: string[]; ok?: boolean }
  | { type: 'pty'; cols: number; rows: number; term: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'shell' }
  | { type: 'input'; line: string }
  | { type: 'close' }

export interface FakeServer {
  port: number
  events: ServerEvent[]
  authAttempts(method?: string): ServerEvent[]
  openSessions(): number
  /** Drop every client connection from the server side. */
  kickAll(): void
  stop(): Promise<void>
}

const LEGACY: import('ssh2').Algorithms = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'],
  cipher: ['aes128-cbc', '3des-cbc'],
  hmac: ['hmac-sha1'],
  serverHostKey: ['ssh-rsa']
}

export const THAI = 'สวัสดีครับ ทดสอบภาษาไทย'

function deviceShell(stream: ServerChannel, opts: FakeServerOptions, events: ServerEvent[]): void {
  const prompt = opts.prompt ?? 'SW01#'
  stream.write(`\r\nWelcome to SW01\r\n${prompt}`)
  let line = ''
  const run = (cmd: string): boolean => {
    switch (cmd) {
      case 'show version':
        stream.write(`Cisco IOS Software, Version 12.2(55)SE ${THAI}\r\n`)
        break
      case 'show split': {
        // UTF-8 Thai text split in the middle of a multibyte character.
        const buf = Buffer.from(`${THAI}\r\n`)
        stream.write(buf.subarray(0, 5))
        setTimeout(() => stream.write(buf.subarray(5)), 30)
        return true
      }
      case 'show color':
        stream.write('\x1b[1;32mGREEN-UP\x1b[0m \x1b[31mRED-DOWN\x1b[0m\r\n')
        break
      case 'show more':
        stream.write('line-one\r\n --More-- \x08\x08\x08\x08\x08\x08\x08\x08\x08\x08          \x08\x08\x08\x08\x08\x08\x08\x08\x08\x08line-two\r\n')
        break
      case 'show tech': {
        // ~6 MB, ends with a marker line.
        const row = 'x'.repeat(98) + '\r\n'
        const chunk = row.repeat(1000)
        for (let i = 0; i < 60; i++) stream.write(chunk)
        stream.write('END-OF-SHOW-TECH\r\n')
        break
      }
      case 'exit':
        stream.close()
        return false
    }
    return true
  }
  stream.on('data', (d: Buffer) => {
    for (const ch of d.toString()) {
      if (ch === '\r') {
        stream.write('\r\n')
        events.push({ type: 'input', line })
        const cmd = line
        line = ''
        if (!run(cmd)) return
        setTimeout(() => stream.write(prompt), cmd === 'show split' ? 60 : 0)
      } else if (ch === '\x7f') {
        line = line.slice(0, -1)
        stream.write('\b \b')
      } else {
        line += ch
        stream.write(ch)
      }
    }
  })
}

export function startServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const methods = opts.methods ?? ['keyboard-interactive']
  const password = opts.password ?? 'cisco123'
  const authorized = (opts.authorizedKeys ?? []).map((f) => {
    const k = utils.parseKey(fs.readFileSync(`${f}.pub`))
    if (k instanceof Error) throw k
    return Array.isArray(k) ? k[0] : k
  })
  const events: ServerEvent[] = []
  const clients = new Set<import('ssh2').Connection>()
  let open = 0

  const server = new Server(
    { hostKeys: [opts.hostKey ?? hostKeys.a], ...(opts.legacyOnly ? { algorithms: LEGACY } : {}) },
    (client) => {
      clients.add(client)
      client.on('authentication', (ctx: AuthContext) => {
        const reject = (): void => ctx.reject(methods)
        if (ctx.method === 'none' || !methods.includes(ctx.method as Method)) {
          events.push({ type: 'auth', method: ctx.method })
          return reject()
        }
        if (ctx.method === 'password') {
          const ok = ctx.password === password
          events.push({ type: 'auth', method: 'password', answers: [ctx.password], ok })
          return ok ? ctx.accept() : reject()
        }
        if (ctx.method === 'keyboard-interactive') {
          const prompts = opts.kbdPrompts ?? [{ prompt: 'Password: ', echo: false }]
          const check = opts.kbdCheck ?? ((a: string[]) => a[0] === password)
          ctx.prompt(prompts, 'Device login', '', (answers) => {
            const ok = check(answers)
            events.push({ type: 'auth', method: 'keyboard-interactive', answers, ok })
            ok ? ctx.accept() : reject()
          })
          return
        }
        if (ctx.method === 'publickey') {
          const match = authorized.find(
            (k) => ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH() as Buffer)
          )
          if (!match) {
            events.push({ type: 'auth', method: 'publickey', ok: false })
            return reject()
          }
          if (!ctx.signature) return ctx.accept() // key is acceptable; client will sign next
          const ok = match.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true
          events.push({ type: 'auth', method: 'publickey', ok })
          return ok ? ctx.accept() : reject()
        }
      })
      client.on('ready', () => {
        open++
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acc, _rej, info) => {
            events.push({ type: 'pty', cols: info.cols, rows: info.rows, term: info.term })
            acc?.()
          })
          session.on('window-change', (acc, _rej, info) => {
            events.push({ type: 'resize', cols: info.cols, rows: info.rows })
            acc?.()
          })
          session.on('shell', (acc) => {
            events.push({ type: 'shell' })
            deviceShell(acc(), opts, events)
          })
        })
      })
      client.on('close', () => {
        clients.delete(client)
        if (open > 0) open--
        events.push({ type: 'close' })
      })
      client.on('error', () => {})
    }
  )

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        events,
        authAttempts: (method) =>
          events.filter((e) => e.type === 'auth' && e.method !== 'none' && (!method || e.method === method)),
        openSessions: () => open,
        kickAll: () => clients.forEach((c) => c.end()),
        stop: () =>
          new Promise((r) => {
            clients.forEach((c) => c.end())
            server.close(() => r())
          })
      })
    })
  })
}

// ---------- app ----------

export function newDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termflow-data-'))
}

let hostSeq = 0
export function host(port: number, over: Partial<Host> = {}): Host {
  hostSeq++
  return {
    id: `host-${hostSeq}`,
    name: `sw-${hostSeq}`,
    host: '127.0.0.1',
    port,
    username: 'admin',
    group: 'Lab',
    auth: 'password',
    legacy: false,
    logSession: false,
    ...over
  }
}

export function seed(dataDir: string, hosts: Host[], knownHosts?: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dataDir, 'hosts.json'), JSON.stringify(hosts, null, 2))
  if (knownHosts) fs.writeFileSync(path.join(dataDir, 'known_hosts.json'), JSON.stringify(knownHosts))
}

export const readJson = <T = unknown>(dataDir: string, name: string): T | undefined => {
  const f = path.join(dataDir, name)
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : undefined
}

export interface Launched {
  app: ElectronApplication
  win: Page
  dataDir: string
}

export async function launchApp(dataDir: string, env: Record<string, string | undefined> = {}): Promise<Launched> {
  const app = await _electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    executablePath: process.env.TERMFLOW_EXECUTABLE || undefined,
    // Serial tests use simulated ports; no test touches real hardware.
    env: { ...(process.env as Record<string, string>), TERMFLOW_DATA_DIR: dataDir, TERMFLOW_SERIAL_MOCK: '1', ...env } as Record<
      string,
      string
    >
  })
  const win = await app.firstWindow()
  // The tab bar is always shown; the sidebar may be hidden.
  await win.waitForSelector('.tabbar')
  return { app, win, dataDir }
}

// ---------- UI helpers ----------

export const activeTerm = (win: Page) => win.locator('.term-pane:not([hidden]) .xterm-rows')

export async function connectTo(win: Page, name: string, password?: string, save = false): Promise<void> {
  await win.locator('.host-name', { hasText: name }).first().click()
  if (password !== undefined) {
    await win.locator('.modal input[type=password]').fill(password)
    if (save) await win.locator('.modal input[type=checkbox]').check()
    await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
  }
}

export async function trustHostKey(win: Page): Promise<void> {
  await expect(win.locator('.modal h2')).toHaveText('Unknown host key')
  await win.locator('.modal').getByRole('button', { name: 'Trust & connect' }).click()
}

export async function expectReady(win: Page): Promise<void> {
  await expect(win.locator('.tab.active .dot.ready')).toBeVisible({ timeout: 15000 })
}

export async function typeLine(win: Page, text: string): Promise<void> {
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}

export function knownHostFor(port: number, fingerprint: string): Record<string, unknown> {
  return { [`127.0.0.1:${port}`]: { keyType: 'ssh-rsa', fingerprint, addedAt: new Date().toISOString() } }
}

/** Open a sidebar row's menu (right-click; same items as ⋯) and pick an item. */
export async function rowAction(win: Page, rowText: string, item: string): Promise<void> {
  const row = win.locator('.host-list .side-row', { hasText: rowText }).first()
  await row.click({ button: 'right' })
  await win.getByRole('menuitem', { name: item }).click()
}

export async function menu(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, l) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === l) return i
        const sub = i.submenu && find(i.submenu.items)
        if (sub) return sub
      }
    }
    const item = find(Menu.getApplicationMenu()!.items)
    if (!item) throw new Error(`menu item ${l} not found`)
    item.click()
  }, label)
}

export function fingerprint(privatePem: string): string {
  const k = utils.parseKey(privatePem)
  if (k instanceof Error) throw k
  const pub = (Array.isArray(k) ? k[0] : k).getPublicSSH() as Buffer
  return 'SHA256:' + createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')
}
