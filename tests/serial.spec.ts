import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { normalizePorts, toCalloutPath } from '../src/shared/serial-ports'
import { DEFAULT_SERIAL, type Host } from '../src/shared/types'
import { activeTerm, expectReady, host, launchApp, menu, newDataDir, readJson, seed, type Launched } from './helpers'

let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  ui = undefined
})

const PORT = '/dev/cu.usbserial-A10K'

async function start(hosts: Host[] = [], startupPorts = '') {
  const dataDir = newDataDir()
  seed(dataDir, hosts)
  ui = await launchApp(dataDir, { TERMFLOW_SERIAL_MOCK_PORTS: startupPorts })
  return { win: ui.win, app: ui.app, dataDir }
}

type Mock = {
  opened: { path: string; baudRate: number; dataBits: number; parity: string; stopBits: number }[]
  breaks: string[]
}
const mock = <T>(app: ElectronApplication, fn: string, ...args: unknown[]): Promise<T> =>
  app.evaluate(
    async (_e, [f, a]) => {
      const m = (globalThis as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>).__termflowSerialMock
      const r = await m[f as string](...(a as unknown[]))
      await m.rescan()
      return r
    },
    [fn, args] as const
  ) as Promise<T>
const mockState = (app: ElectronApplication) =>
  app.evaluate(() => {
    const m = (globalThis as unknown as { __termflowSerialMock: Mock }).__termflowSerialMock
    return { opened: m.opened, breaks: m.breaks }
  })

const portRow = (win: Page) => win.locator('.serial-ports .port-row')
const serialHost = (over: Partial<Host> = {}): Host =>
  host(0, { name: 'core-console', group: '', kind: 'serial', host: '', username: '', serial: { ...DEFAULT_SERIAL, path: PORT }, ...over })

test.describe('port detection', () => {
  test('tty paths become callout paths; built-in Mac ports are hidden', () => {
    expect(toCalloutPath('/dev/tty.usbserial-1')).toBe('/dev/cu.usbserial-1')
    const ports = normalizePorts([
      { path: '/dev/tty.Bluetooth-Incoming-Port' },
      { path: '/dev/tty.debug-console' },
      { path: '/dev/tty.usbserial-A10K', vendorId: '0403', manufacturer: 'FTDI', serialNumber: 'A10K' },
      { path: '/dev/cu.usbserial-A10K', vendorId: '0403', manufacturer: 'FTDI', serialNumber: 'A10K' },
      { path: '/dev/tty.usbmodem1101' }
    ])
    expect(ports.map((p) => p.path)).toEqual(['/dev/cu.usbmodem1101', '/dev/cu.usbserial-A10K'])
    expect(ports[1]).toMatchObject({ name: 'cu.usbserial-A10K', manufacturer: 'FTDI', serialNumber: 'A10K' })
  })

  test('ports present at startup are listed without a "new cable" notice', async () => {
    const { win } = await start([], `${PORT}=FTDI`)
    await expect(portRow(win)).toHaveCount(1)
    await expect(portRow(win)).toContainText('FTDI')
    await expect(portRow(win)).toContainText('cu.usbserial-A10K')
    await expect(win.locator('.dash-section', { hasText: 'Console ports' }).locator('.recent')).toHaveCount(1)
    await win.waitForTimeout(2500) // one more poll
    await expect(win.locator('.toast')).toHaveCount(0)
  })

  test('plugging a cable in shows a notice; Connect opens a console that echoes typed text', async () => {
    const { win, app } = await start()
    await expect(win.locator('.serial-ports')).toHaveCount(0)
    await mock(app, 'add', PORT, { manufacturer: 'Prolific' })
    await expect(win.locator('.toast')).toContainText('Console cable connected')
    await expect(win.locator('.toast')).toContainText('Prolific · cu.usbserial-A10K')
    await expect(portRow(win)).toHaveCount(1)

    await win.locator('.toast').getByRole('button', { name: 'Connect' }).click()
    await expect(win.locator('.toast')).toHaveCount(0)
    await expectReady(win)
    await expect(win.locator('.tab.active .tab-title')).toHaveText('cu.usbserial-A10K')
    await expect(activeTerm(win)).toContainText('Connected to cu.usbserial-A10K · 9600 8N1')
    await win.keyboard.type('show version')
    await expect(activeTerm(win)).toContainText('show version')
    expect((await mockState(app)).opened).toEqual([{ path: PORT, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 }])
  })

  test('unplugging removes the port and its notice', async () => {
    const { win, app } = await start()
    await mock(app, 'add', PORT)
    await expect(win.locator('.toast')).toBeVisible()
    await mock(app, 'remove', PORT)
    await expect(portRow(win)).toHaveCount(0)
    await expect(win.locator('.toast')).toHaveCount(0)
  })
})

test.describe('Console button', () => {
  const consoleBtn = (win: Page) => win.locator('.dash-top').getByRole('button', { name: 'Console' })

  const dialog = (win: Page) => win.locator('.modal')

  test('no cable: dialog says so and Connect is disabled', async () => {
    const { win } = await start()
    await consoleBtn(win).click()
    await expect(dialog(win).locator('h2')).toHaveText('Open console')
    await expect(dialog(win)).toContainText('No console cable detected')
    await expect(dialog(win).getByRole('button', { name: 'Connect' })).toBeDisabled()
  })

  test('one cable still asks for port and baud; preset 115200 is used', async () => {
    const { win, app } = await start([], `${PORT}=FTDI`)
    await consoleBtn(win).click()
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
    await expect(dialog(win).locator('select')).toHaveValue(PORT)
    await expect(dialog(win).getByRole('button', { name: '9600' })).toHaveAttribute('aria-pressed', 'true')
    await dialog(win).getByRole('button', { name: '115200' }).click()
    await expect(dialog(win).getByLabel('Baud rate', { exact: true })).toHaveValue('115200')
    await dialog(win).getByRole('button', { name: 'Connect' }).click()
    await expectReady(win)
    expect((await mockState(app)).opened).toEqual([{ path: PORT, baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 }])
  })

  test('several cables: pick the port, type a custom baud; choice is remembered', async () => {
    const { win, app } = await start([], `${PORT}=FTDI,/dev/cu.usbmodem1101=Cisco`)
    await consoleBtn(win).click()
    await expect(dialog(win).locator('option')).toHaveText(['cu.usbmodem1101 — Cisco', 'cu.usbserial-A10K — FTDI'])
    await dialog(win).locator('select').selectOption(PORT)
    await dialog(win).getByLabel('Baud rate', { exact: true }).fill('abc')
    await dialog(win).getByRole('button', { name: 'Connect' }).click()
    await expect(dialog(win).locator('.error')).toHaveText('Enter a baud rate, e.g. 9600 or 115200')
    await dialog(win).getByLabel('Baud rate', { exact: true }).fill('4800')
    await expect(dialog(win).locator('.chip-btn.on')).toHaveCount(0)
    await dialog(win).getByRole('button', { name: 'Connect' }).click()
    await expectReady(win)
    expect((await mockState(app)).opened[0]).toMatchObject({ path: PORT, baudRate: 4800 })

    await win.locator('.tab.home').click()
    await consoleBtn(win).click()
    await expect(dialog(win).locator('select')).toHaveValue(PORT)
    await expect(dialog(win).getByLabel('Baud rate', { exact: true })).toHaveValue('4800')
  })

  test('New host dropdown offers New host and New group', async () => {
    const { win } = await start()
    await win.locator('.dash-top').getByRole('button', { name: 'More new options' }).click()
    await expect(win.getByRole('menuitem')).toHaveText(['New host…⌘N', 'New group…'])
    await win.getByRole('menuitem', { name: 'New group…' }).click()
    await expect(win.locator('.modal h2')).toHaveText('New group')
  })
})

test.describe('console sessions', () => {
  test('port menu connects at another baud rate', async () => {
    const { win, app } = await start([], `${PORT}=FTDI`)
    await portRow(win).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Connect at 115200' }).click()
    await expectReady(win)
    expect((await mockState(app)).opened[0].baudRate).toBe(115200)
  })

  test('save a port as a host; connecting needs no password and records the cable identity', async () => {
    const { win, app, dataDir } = await start([], `${PORT}=FTDI`)
    await portRow(win).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Save as host…' }).click()
    const modal = win.locator('.modal')
    await expect(modal.locator('h2')).toHaveText('Save console as host')
    await expect(modal.locator('label', { hasText: 'Console port' }).locator('select').first()).toHaveValue(PORT)
    await modal.locator('label', { hasText: 'Label' }).locator('input').fill('core-sw-01 console')
    await modal.locator('label', { hasText: 'Baud rate' }).locator('input').fill('19200')
    await modal.getByRole('button', { name: 'Save & connect' }).click()

    await expectReady(win)
    await expect(win.locator('.modal')).toHaveCount(0)
    const [saved] = readJson<Host[]>(dataDir, 'hosts.json')!
    expect(saved).toMatchObject({ kind: 'serial', name: 'core-sw-01 console', serial: { path: PORT, baudRate: 19200, serialNumber: '1', vendorId: '0403' } })
    expect(saved.lastConnectedAt).toBeTruthy()
    expect((await mockState(app)).opened[0].baudRate).toBe(19200)
    await expect(win.locator('.host-list .host', { hasText: 'core-sw-01 console' }).locator('.host-sub')).toHaveText('cu.usbserial-A10K · 19200')
  })

  test('New host form is SSH only', async () => {
    const { win } = await start([], `${PORT}=FTDI`)
    await win.locator('.dash-top').getByRole('button', { name: 'New host' }).click()
    await expect(win.locator('.modal h2')).toHaveText('New host')
    await expect(win.locator('.modal')).not.toContainText('Serial')
    await expect(win.locator('.modal label', { hasText: 'Host / IP' })).toBeVisible()
  })

  test('a port already open in another tab gives a clear error', async () => {
    const { win } = await start([], `${PORT}=FTDI`)
    await portRow(win).click()
    await expectReady(win)
    await portRow(win).click()
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)
    await expect(activeTerm(win)).toContainText('cu.usbserial-A10K is in use by another app or tab')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()
  })

  test('saved host with the cable unplugged says so', async () => {
    const { win } = await start([serialHost()])
    await win.locator('.host-list .host', { hasText: 'core-console' }).click()
    await expect(activeTerm(win)).toContainText('Console cable not found: cu.usbserial-A10K — is it plugged in?')
  })

  test('cable on a new path is found again by its USB serial number', async () => {
    const { win, dataDir } = await start(
      [serialHost({ serial: { ...DEFAULT_SERIAL, path: '/dev/cu.usbserial-OLD', serialNumber: '1', vendorId: '0403' } })],
      `${PORT}=FTDI`
    )
    await win.locator('.host-list .host', { hasText: 'core-console' }).click()
    await expectReady(win)
    expect(readJson<Host[]>(dataDir, 'hosts.json')![0].serial!.path).toBe(PORT)
  })

  test('unplugging during a session shows "Device disconnected"; Enter reconnects after re-plugging', async () => {
    const { win, app } = await start([], `${PORT}=FTDI`)
    await portRow(win).click()
    await expectReady(win)
    await mock(app, 'unplug', PORT)
    await expect(activeTerm(win)).toContainText('Device disconnected (cu.usbserial-A10K)')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()

    await mock(app, 'add', PORT)
    await win.locator('.terminals .xterm').click()
    await win.keyboard.press('Enter')
    await expectReady(win)
  })

  test('⌘B sends Break on serial tabs only', async () => {
    const { win, app } = await start([host(1, { name: 'ssh-host', group: '', auth: 'key', keyPath: '~/.ssh/none' })], `${PORT}=FTDI`)
    await portRow(win).click()
    await expectReady(win)
    await menu(app, 'Send Break')
    await expect.poll(async () => (await mockState(app)).breaks).toEqual([PORT])

    // With an SSH tab active, ⌘B does nothing.
    await win.locator('.host-list .host', { hasText: 'ssh-host' }).click()
    await expect(win.locator('.tab.active .tab-title')).toHaveText('ssh-host')
    await menu(app, 'Send Break')
    await win.waitForTimeout(500)
    expect((await mockState(app)).breaks).toEqual([PORT])
  })

  test('console output is logged as plain text', async () => {
    const { win, dataDir } = await start([serialHost({ logSession: true })], `${PORT}=FTDI`)
    await win.locator('.host-list .host', { hasText: 'core-console' }).click()
    await expectReady(win)
    await expect(win.locator('.tab.active .rec')).toBeVisible()
    await win.keyboard.type('Switch>enable')
    await expect(activeTerm(win)).toContainText('Switch>enable')
    await win.locator('.tab.active .tab-close').click()
    await expect.poll(() => fs.existsSync(path.join(dataDir, 'logs')) && fs.readdirSync(path.join(dataDir, 'logs')).length).toBe(1)
    const file = path.join(dataDir, 'logs', fs.readdirSync(path.join(dataDir, 'logs'))[0])
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('Switch>enable')
  })
})
