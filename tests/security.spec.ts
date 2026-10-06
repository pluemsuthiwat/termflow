import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SERIAL } from '../src/shared/types'
import {
  connectTo,
  expectReady,
  fingerprint,
  host,
  hostKeys,
  knownHostFor,
  launchApp,
  newDataDir,
  seed,
  startServer,
  type FakeServer,
  type Launched
} from './helpers'

let server: FakeServer | undefined
let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  await server?.stop()
  ui = server = undefined
})

async function start() {
  const dataDir = newDataDir()
  seed(dataDir, [host(22, { name: 'core-sw' })])
  ui = await launchApp(dataDir)
  return { win: ui.win, app: ui.app, dataDir }
}

/** A local page that reports whether it got the app's privileged API. */
function evilPage(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-evil-')), 'evil.html')
  fs.writeFileSync(file, `<title>evil</title><script>document.title = 'evil:' + typeof window.shell</script>`)
  return 'file://' + file
}

test('the window cannot be navigated away (e.g. a dropped or linked HTML file)', async () => {
  const { win, app } = await start()
  const appUrl = win.url()
  await win.evaluate((u) => {
    location.href = u
  }, evilPage())
  await win.waitForTimeout(500)
  // Ask the main process: Playwright keeps waiting for the cancelled navigation.
  const state = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    return Promise.all([wc.getURL(), wc.executeJavaScript('document.title + "|" + !!document.querySelector(".tabbar")')])
  })
  expect(state).toEqual([appUrl, 'Termflow|true'])
})

test('window.open never opens an app window; only http(s) links go to the browser', async () => {
  const { win, app } = await start()
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => void g.opened.push(url)
  })
  await win.evaluate((evil) => {
    window.open(evil)
    window.open('smb://attacker/share')
    window.open('https://example.com/docs')
  }, evilPage())
  await win.waitForTimeout(300)
  expect(app.windows()).toHaveLength(1)
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    'https://example.com/docs'
  ])
})

test('IPC only answers the app page, not another page that has the preload', async () => {
  const { win, app } = await start()
  expect(await win.evaluate(() => window.shell.listHosts().then((h) => h.length))).toBe(1)
  const preload = path.resolve('out/preload/index.js')
  const result = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } })
    await w.loadURL('data:text/html,<p>other</p>')
    const r = await w.webContents.executeJavaScript(
      `window.shell.listHosts().then((h) => 'leaked ' + h.length, (e) => 'refused: ' + e.message)`
    )
    w.destroy()
    return r as string
  }, preload)
  expect(result).toMatch(/^refused/)
})

test('web permissions (notifications, camera, ...) are denied', async () => {
  const { win } = await start()
  expect(await win.evaluate(() => Notification.requestPermission())).toBe('denied')
})

test('a "serial" session cannot open arbitrary files', async () => {
  const { win } = await start()
  const err = await win.evaluate(
    (serial) =>
      window.shell
        .connect({ sessionId: crypto.randomUUID(), hostId: 'port:/etc/passwd', serial, rows: 24, cols: 80 })
        .then(
          () => 'opened',
          (e: Error) => e.message
        ),
    { ...DEFAULT_SERIAL, path: '/etc/passwd' }
  )
  expect(err).toContain('Not a serial device')
})

test('existing data and logs folders are made private at startup', async () => {
  const dataDir = newDataDir()
  fs.mkdirSync(path.join(dataDir, 'logs'))
  fs.chmodSync(dataDir, 0o755)
  fs.chmodSync(path.join(dataDir, 'logs'), 0o755)
  seed(dataDir, [])
  ui = await launchApp(dataDir)
  const mode = (p: string) => fs.statSync(p).mode & 0o777
  expect(mode(dataDir)).toBe(0o700)
  expect(mode(path.join(dataDir, 'logs'))).toBe(0o700)
})

test('pasting into the terminal still reaches the device (permissions are locked down)', async () => {
  server = await startServer()
  const h = host(server.port)
  const dataDir = newDataDir()
  seed(dataDir, [h], knownHostFor(server.port, fingerprint(hostKeys.a)))
  ui = await launchApp(dataDir)
  await connectTo(ui.win, h.name, 'cisco123')
  await expectReady(ui.win)
  await ui.app.evaluate(({ clipboard, BrowserWindow }) => {
    clipboard.writeText('show ver\r')
    BrowserWindow.getAllWindows()[0].webContents.paste()
  })
  await expect.poll(() => server!.events).toContainEqual({ type: 'input', line: 'show ver' })
})

test('data folder, session logs and log files are private to the user', async () => {
  server = await startServer()
  const h = host(server.port, { logSession: true })
  const dataDir = newDataDir()
  fs.chmodSync(dataDir, 0o755) // e.g. a TERMFLOW_DATA_DIR created by hand
  seed(dataDir, [h], knownHostFor(server.port, fingerprint(hostKeys.a)))
  ui = await launchApp(dataDir)
  await connectTo(ui.win, h.name, 'cisco123')
  await expectReady(ui.win)
  const logs = path.join(dataDir, 'logs')
  await expect.poll(() => fs.existsSync(logs) && fs.readdirSync(logs).length).toBe(1)
  const mode = (p: string) => fs.statSync(p).mode & 0o777
  expect(mode(dataDir)).toBe(0o700)
  expect(mode(logs)).toBe(0o700)
  expect(mode(path.join(logs, fs.readdirSync(logs)[0]))).toBe(0o600)
  expect(mode(path.join(dataDir, 'hosts.json'))).toBe(0o600)
})
