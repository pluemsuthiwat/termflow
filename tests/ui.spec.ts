import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SERIAL, type Host } from '../src/shared/types'
import {
  expectReady,
  host,
  launchApp,
  menu,
  newDataDir,
  readJson,
  rowAction,
  seed,
  startServer,
  trustHostKey,
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

async function start(hosts: Host[] = []) {
  const dataDir = newDataDir()
  seed(dataDir, hosts)
  ui = await launchApp(dataDir)
  return { win: ui.win, app: ui.app, dataDir }
}

const field = (win: Page, label: string) => win.locator('.modal label', { hasText: label }).locator('input, select').first()
const hostsFile = (dataDir: string) => readJson<Host[]>(dataDir, 'hosts.json') ?? []
const secretsFile = (dataDir: string) => readJson<Record<string, string>>(dataDir, 'secrets.json') ?? {}

test.describe('host management', () => {
  test('add a host through the form; secrets are encrypted and kept out of hosts.json', async () => {
    const { win, dataDir } = await start()
    await win.locator('.dash-top').getByRole('button', { name: 'New host' }).click()
    await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(win.locator('.modal .error')).toHaveText('Host / IP is required')

    await field(win, 'Label').fill('core-sw-01')
    await field(win, 'Host / IP').fill('10.10.0.1')
    await field(win, 'Port').fill('2201')
    await field(win, 'Username').fill('netadmin')
    await field(win, 'Group').fill('Site A')
    await win.locator('.modal input[type=password]').fill('S3cret!pw')
    await expect(win.locator('.modal label.check', { hasText: 'Log session' })).toBeVisible()
    await expect(win.locator('.modal label.check', { hasText: 'Legacy' })).toHaveCount(0) // detected, not a setting
    await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()

    await expect(win.locator('.modal')).toHaveCount(0)
    await expect(win.locator('.host-list h3')).toHaveText(['Default', 'Site A'])
    await expect(win.locator('.host')).toContainText('core-sw-01')

    const [saved] = hostsFile(dataDir)
    expect(saved).toMatchObject({ name: 'core-sw-01', host: '10.10.0.1', port: 2201, username: 'netadmin', group: 'Site A', legacy: false })
    expect(Object.keys(saved)).not.toContain('secret')
    expect(Object.keys(saved)).not.toContain('hasSecret')
    const raw = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')
    expect(raw).not.toContain('S3cret')
    expect(secretsFile(dataDir)[saved.id]).toBeTruthy()
  })

  test('edit keeps the saved password unless "Forget" is used', async () => {
    const { win, dataDir } = await start()
    await menu(ui!.app, 'New Host…')
    await field(win, 'Host / IP').fill('10.0.0.9')
    await field(win, 'Username').fill('admin')
    await win.locator('.modal input[type=password]').fill('pw1')
    await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()
    const id = hostsFile(dataDir)[0].id

    await rowAction(win, '10.0.0.9', 'Edit…')
    await expect(win.locator('.modal input[type=password]')).toHaveAttribute('placeholder', /Saved/)
    await field(win, 'Label').fill('renamed')
    await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(win.locator('.host-name')).toHaveText('renamed')
    expect(secretsFile(dataDir)[id]).toBeTruthy()

    await rowAction(win, 'renamed', 'Edit…')
    await win.locator('.modal').getByRole('button', { name: 'Forget' }).click()
    await expect(win.getByText('Saved secret will be removed.')).toBeVisible()
    await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(win.locator('.modal')).toHaveCount(0)
    expect(secretsFile(dataDir)[id]).toBeUndefined()
  })

  test('delete asks for confirmation', async () => {
    const a = host(22, { name: 'keep-me' })
    const b = host(22, { name: 'delete-me' })
    const { win, dataDir } = await start([a, b])
    await rowAction(win, 'delete-me', 'Delete…')
    await expect(win.locator('.modal')).toContainText('delete-me')
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    await expect(win.locator('.host')).toHaveCount(2)

    await rowAction(win, 'delete-me', 'Delete…')
    await win.locator('.modal').getByRole('button', { name: 'Delete host' }).click()
    await expect(win.locator('.host-name')).toHaveText(['keep-me'])
    expect(hostsFile(dataDir).map((h) => h.name)).toEqual(['keep-me'])
  })

  test('search filters by name, IP, user and group; groups are sorted', async () => {
    const { win } = await start([
      host(22, { name: 'edge-rtr', host: '192.168.1.1', group: 'WAN' }),
      host(22, { name: 'core-sw', host: '10.0.0.1', group: 'Core' }),
      host(22, { name: 'access-sw', host: '10.0.5.1', group: 'Access', username: 'tacacs-user' })
    ])
    await expect(win.locator('.host-list h3')).toHaveText(['Default', 'Access', 'Core', 'WAN'])
    const search = win.getByLabel('Search hosts or connect')
    await search.fill('192.168')
    await expect(win.locator('.host-name')).toHaveText(['edge-rtr'])
    await search.fill('tacacs')
    await expect(win.locator('.host-name')).toHaveText(['access-sw'])
    await search.fill('core')
    await expect(win.locator('.host-name')).toHaveText(['core-sw'])
    await search.fill('nothing-matches')
    await expect(win.getByText('No matching hosts.')).toBeVisible()
  })
})

test.describe('quick connect', () => {
  test('user@host:port creates a host and connects; same target reuses it', async () => {
    server = await startServer()
    const { win, dataDir } = await start()
    const quick = win.getByLabel('Search hosts or connect')
    await quick.fill(`admin@127.0.0.1:${server.port}`)
    await quick.press('Enter')
    await win.locator('.modal input[type=password]').fill('cisco123')
    await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
    await trustHostKey(win)
    await expectReady(win)
    expect(hostsFile(dataDir)).toEqual([
      expect.objectContaining({ host: '127.0.0.1', port: server.port, username: 'admin', group: '' })
    ])

    await quick.fill(`admin@127.0.0.1:${server.port}`)
    await quick.press('Enter')
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    expect(hostsFile(dataDir)).toHaveLength(1)
  })

  test('bracketed IPv6 address is parsed', async () => {
    const { win, dataDir } = await start()
    const quick = win.getByLabel('Search hosts or connect')
    await quick.fill('admin@[2001:db8::1]:2222')
    await quick.press('Enter')
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    expect(hostsFile(dataDir)[0]).toMatchObject({ host: '2001:db8::1', port: 2222, username: 'admin' })
  })

  test('missing username opens the form prefilled', async () => {
    const { win, dataDir } = await start()
    const quick = win.getByLabel('Search hosts or connect')
    await quick.fill('10.1.1.1')
    await quick.press('Enter')
    await expect(win.locator('.modal h2')).toHaveText('New host')
    await expect(field(win, 'Host / IP')).toHaveValue('10.1.1.1')
    await expect(field(win, 'Port')).toHaveValue('22')
    expect(hostsFile(dataDir)).toHaveLength(0)
  })
})

test.describe('sidebar', () => {
  const width = (win: Page) => win.locator('.sidebar').evaluate((e) => e.getBoundingClientRect().width)
  async function drag(win: Page, toX: number) {
    const b = (await win.locator('.sidebar-resizer').boundingBox())!
    await win.mouse.move(b.x + b.width / 2, 300)
    await win.mouse.down()
    await win.mouse.move(toX, 300, { steps: 6 })
    await win.mouse.up()
  }

  test('resizes between 200 and 480 px, persists, double-click resets', async () => {
    const { win, dataDir } = await start([host(22)])
    expect(await width(win)).toBe(240)
    await drag(win, 40)
    expect(await width(win)).toBe(200)
    await drag(win, 2000)
    expect(await width(win)).toBe(480)
    await drag(win, 320)
    expect(await width(win)).toBe(320)

    await ui!.app.close()
    ui = await launchApp(dataDir)
    expect(await width(ui.win)).toBe(320)
    await ui.win.locator('.sidebar-resizer').dblclick()
    expect(await width(ui.win)).toBe(240)
  })

  test('sidebar can be hidden for more room; remembered; ⌘\\ toggles it', async () => {
    const { win, dataDir } = await start([host(22, { name: 'core' })])
    const termWidth = () => win.locator('.main').evaluate((e) => e.getBoundingClientRect().width)
    const before = await termWidth()
    await win.getByRole('button', { name: 'Hide sidebar' }).click()
    await expect(win.locator('.sidebar')).toBeHidden()
    expect(await termWidth()).toBeGreaterThan(before + 200)

    await ui!.app.close()
    ui = await launchApp(dataDir)
    await expect(ui.win.locator('.sidebar')).toBeHidden()
    await menu(ui.app, 'Toggle Sidebar')
    await expect(ui.win.locator('.sidebar')).toBeVisible()
    await expect(ui.win.getByRole('button', { name: 'Hide sidebar' })).toBeVisible()
  })

  test('row ⋯ button appears on hover only and does not truncate the name', async () => {
    const { win } = await start([host(22, { name: 'core-switch-01' })])
    const row = win.locator('.host').first()
    await win.mouse.move(800, 600)
    await expect(row.locator('.row-more')).toBeHidden()
    const labelWidth = () => row.locator('.host-label').evaluate((e) => e.clientWidth)
    const before = await labelWidth()
    expect(await row.locator('.host-label').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    await row.hover()
    // The ⋯ button floats over the row; the name keeps its width.
    expect(await labelWidth()).toBe(before)
    await expect(row.getByTitle('More actions')).toBeVisible()
  })

})

test('New host form asks for a password only (no authentication choice)', async () => {
  const dataDir = newDataDir()
  seed(dataDir, [])
  ui = await launchApp(dataDir)
  await ui.win.locator('.dash-top').getByRole('button', { name: 'New host' }).click()
  const modal = ui.win.locator('.modal')
  await expect(modal.getByText('Authentication')).toHaveCount(0)
  await expect(modal.locator('select')).toHaveCount(0)
  await expect(modal.locator('label', { hasText: 'Password' }).locator('input[type=password]')).toBeVisible()
})

test('pressing Enter in the host form saves and connects', async () => {
  const dataDir = newDataDir()
  seed(dataDir, [])
  ui = await launchApp(dataDir)
  const win = ui.win
  await win.locator('.dash-top').getByRole('button', { name: 'New host' }).click()
  const modal = win.locator('.modal')
  await modal.locator('label', { hasText: 'Host / IP' }).locator('input').fill('127.0.0.1')
  await modal.locator('label', { hasText: 'Port' }).locator('input').first().fill('1')
  await modal.locator('label', { hasText: 'Username' }).locator('input').fill('admin')
  await modal.locator('input[type=password]').fill('pw')
  await modal.locator('input[type=password]').press('Enter')
  // Nothing listens on port 1: the login fails in the dialog, before a tab opens.
  await expect(win.locator('.modal [role=alert]')).toContainText('ECONNREFUSED')
  await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
  expect(readJson<Host[]>(dataDir, 'hosts.json')).toEqual([expect.objectContaining({ host: '127.0.0.1', port: 1, username: 'admin' })])
})

test('logs: "Open logs folder" shows up when logging is ticked; REC reveals the file', async () => {
  const dataDir = newDataDir()
  seed(dataDir, [
    host(0, { name: 'console-logged', group: '', kind: 'serial', host: '', username: '', logSession: true, serial: { ...DEFAULT_SERIAL, path: '/dev/cu.usbserial-A10K' } })
  ])
  ui = await launchApp(dataDir, { TERMFLOW_SERIAL_MOCK_PORTS: '/dev/cu.usbserial-A10K=FTDI' })
  const { win, app } = ui
  // Record what would open in Finder instead of opening it.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { finder: string[] }
    g.finder = []
    shell.openPath = async (p: string) => (g.finder.push(`open:${p}`), '')
    shell.showItemInFolder = (p: string) => void g.finder.push(`reveal:${p}`)
  })
  const finder = () => app.evaluate(() => (globalThis as unknown as { finder: string[] }).finder)

  await win.locator('.dash-top').getByRole('button', { name: 'New host' }).click()
  const modal = win.locator('.modal')
  await expect(modal.getByRole('button', { name: 'Open logs folder' })).toHaveCount(0)
  await modal.locator('label.check', { hasText: 'Log session to file' }).locator('input').check()
  await modal.getByRole('button', { name: 'Open logs folder' }).click()
  await expect.poll(finder).toEqual([`open:${path.join(dataDir, 'logs')}`])
  await modal.getByRole('button', { name: 'Cancel' }).click()

  await win.locator('.host-list .host', { hasText: 'console-logged' }).click()
  await win.locator('.tab.active .rec').click()
  const logs = fs.readdirSync(path.join(dataDir, 'logs'))
  expect(logs).toHaveLength(1)
  await expect.poll(finder).toEqual([`open:${path.join(dataDir, 'logs')}`, `reveal:${path.join(dataDir, 'logs', logs[0])}`])
})
