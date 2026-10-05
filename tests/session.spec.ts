import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import type { Host } from '../src/shared/types'
import {
  activeTerm,
  connectTo,
  expectReady,
  fingerprint,
  host,
  hostKeys,
  knownHostFor,
  launchApp,
  menu,
  newDataDir,
  readJson,
  seed,
  startServer,
  THAI,
  trustHostKey,
  typeLine,
  type FakeServer,
  type FakeServerOptions,
  type Launched
} from './helpers'

let server: FakeServer | undefined
let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  await server?.stop()
  ui = server = undefined
})

async function setup(opts: FakeServerOptions = {}, over: Partial<Host> = {}, known: 'trusted' | 'none' | 'other' = 'trusted') {
  server = await startServer(opts)
  const h = host(server.port, over)
  const dataDir = newDataDir()
  const fp = known === 'trusted' ? fingerprint(opts.hostKey ?? hostKeys.a) : fingerprint(hostKeys.b)
  seed(dataDir, [h], known === 'none' ? undefined : knownHostFor(server.port, fp))
  ui = await launchApp(dataDir)
  return { h, win: ui.win, app: ui.app, server, dataDir }
}

const shellCount = () => server!.events.filter((e) => e.type === 'shell').length
const closeCount = () => server!.events.filter((e) => e.type === 'close').length

test.describe('host keys', () => {
  test('unknown key: trust once, then no prompt next time', async () => {
    const { h, win, dataDir, server } = await setup({}, {}, 'none')
    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.fp')).toContainText(fingerprint(hostKeys.a))
    await trustHostKey(win)
    await expectReady(win)
    const known = readJson<Record<string, { fingerprint: string }>>(dataDir, 'known_hosts.json')!
    expect(known[`127.0.0.1:${server.port}`].fingerprint).toBe(fingerprint(hostKeys.a))

    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)
    await expectReady(win)
  })

  test('rejecting an unknown key does not connect or save it', async () => {
    const { h, win, dataDir } = await setup({}, {}, 'none')
    await connectTo(win, h.name, 'cisco123')
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()
    expect(readJson(dataDir, 'known_hosts.json')).toBeUndefined()
    expect(shellCount()).toBe(0)
  })

  test('changed key shows a warning with both fingerprints; replacing updates the file', async () => {
    const { h, win, dataDir, server } = await setup({}, {}, 'other')
    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.modal h2')).toContainText('Host key has CHANGED')
    await expect(win.locator('.fp')).toContainText(fingerprint(hostKeys.a))
    await expect(win.locator('.fp')).toContainText(fingerprint(hostKeys.b))
    await win.locator('.modal').getByRole('button', { name: 'Replace key & connect' }).click()
    await expectReady(win)
    const known = readJson<Record<string, { fingerprint: string }>>(dataDir, 'known_hosts.json')!
    expect(known[`127.0.0.1:${server.port}`].fingerprint).toBe(fingerprint(hostKeys.a))
  })

  test('closing the tab while the host-key dialog is open dismisses it', async () => {
    const { h, win } = await setup({}, {}, 'none')
    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.modal h2')).toHaveText('Unknown host key')
    await menu(ui!.app, 'Close Tab')
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
    await expect(win.locator('.modal')).toHaveCount(0)
    await expect.poll(closeCount).toBe(1)
  })

  test('closing the tab while a password prompt is open dismisses it', async () => {
    const { h, win } = await setup({ methods: ['keyboard-interactive'] })
    await connectTo(win, h.name, 'wrong')
    await expect(win.locator('.modal h2')).toHaveText('Device login')
    await menu(ui!.app, 'Close Tab')
    await expect(win.locator('.modal')).toHaveCount(0)
    await expect.poll(closeCount).toBe(1)
    // App still usable afterwards.
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
  })
})

test.describe('terminal session', () => {
  test('PTY is xterm-256color and resizes with the window', async () => {
    const { h, win, app, server } = await setup()
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    const pty = server.events.find((e) => e.type === 'pty')!
    expect(pty).toMatchObject({ term: 'xterm-256color' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
    await expect
      .poll(() => server.events.filter((e) => e.type === 'resize').at(-1))
      .toMatchObject({ cols: expect.any(Number) })
    const last = server.events.filter((e) => e.type === 'resize').at(-1) as { cols: number }
    expect(last.cols).toBeLessThan((pty as { cols: number }).cols)
  })

  test('typed commands reach the device; Thai text split mid-character renders correctly', async () => {
    const { h, win } = await setup({}, { logSession: true })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await typeLine(win, 'show split')
    await expect(activeTerm(win)).toContainText(THAI)
    expect(server!.events).toContainEqual({ type: 'input', line: 'show split' })
  })

  test('session log is plain text: UTF-8 intact, no colour codes, --More-- erased', async () => {
    const { h, win, dataDir } = await setup({}, { logSession: true })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await expect(win.locator('.tab.active .rec')).toBeVisible()
    // Wait for each command's output before typing the next one.
    for (const [cmd, done] of [['show split', THAI], ['show color', 'RED-DOWN'], ['show more', 'line-two']]) {
      await typeLine(win, cmd)
      await expect(activeTerm(win)).toContainText(done)
    }
    await typeLine(win, 'exit')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()

    const logs = fs.readdirSync(path.join(dataDir, 'logs'))
    expect(logs).toHaveLength(1)
    const log = fs.readFileSync(path.join(dataDir, 'logs', logs[0]), 'utf8')
    expect(log).toContain(THAI)
    expect(log).toContain('GREEN-UP RED-DOWN')
    expect(log).not.toContain('\x1b')
    expect(log).not.toContain('\r')
    expect(log).not.toContain('--More--')
    expect(log).toMatch(/line-one\nline-two/)
  })

  test('large output (~6 MB show tech) arrives completely and the UI stays responsive', async () => {
    const { h, win, dataDir } = await setup({}, { logSession: true })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    const t0 = Date.now()
    await typeLine(win, 'show tech')
    await expect(activeTerm(win)).toContainText('END-OF-SHOW-TECH', { timeout: 30000 })
    const elapsed = Date.now() - t0
    await typeLine(win, 'show version')
    await expect(activeTerm(win)).toContainText('Cisco IOS Software')
    await typeLine(win, 'exit')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()
    const logFile = fs.readdirSync(path.join(dataDir, 'logs'))[0]
    const log = fs.readFileSync(path.join(dataDir, 'logs', logFile), 'utf8')
    expect(log).toContain('END-OF-SHOW-TECH')
    expect(log.split('\n').filter((l) => l === 'x'.repeat(98))).toHaveLength(60000)
    test.info().annotations.push({ type: 'show tech', description: `${elapsed} ms` })
  })

  test('server-side disconnect is shown and Enter reconnects', async () => {
    const { h, win, server } = await setup()
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    server.kickAll()
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()
    await expect(activeTerm(win)).toContainText('Press Enter to reconnect')
    await win.keyboard.press('Enter')
    await expectReady(win)
    expect(shellCount()).toBe(2)
  })
})

test.describe('tabs', () => {
  test('two tabs to the same host get distinct titles; closing one ends only that session', async () => {
    const { h, win, server } = await setup()
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.tab-title')).toHaveText([h.name, `${h.name} (2)`])
    await expectReady(win)
    expect(server.openSessions()).toBe(2)

    await menu(ui!.app, 'Tab 1')
    await expect(win.locator('.tab.active .tab-title')).toHaveText(h.name)
    await menu(ui!.app, 'Close Tab')
    await expect(win.locator('.tab-title')).toHaveText([`${h.name} (2)`])
    await expect.poll(() => server.openSessions()).toBe(1)
  })

  test('quitting the app closes all sessions', async () => {
    const { h, win, server } = await setup()
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await ui!.app.close()
    await expect.poll(() => server.openSessions()).toBe(0)
  })
})
