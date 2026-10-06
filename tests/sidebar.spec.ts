import { expect, test } from '@playwright/test'
import { DEFAULT_SERIAL, type Host } from '../src/shared/types'
import { host, launchApp, menu, newDataDir, readJson, rowAction, seed, type Launched } from './helpers'

let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  ui = undefined
})

async function start(hosts: Host[] = [], groups?: string[]) {
  const dataDir = newDataDir()
  seed(dataDir, hosts)
  if (groups) require('node:fs').writeFileSync(`${dataDir}/groups.json`, JSON.stringify(groups))
  ui = await launchApp(dataDir)
  return { win: ui.win, app: ui.app, dataDir }
}

const hostsFile = (d: string) => readJson<Host[]>(d, 'hosts.json') ?? []
const search = (win: import('@playwright/test').Page) => win.getByLabel('Search hosts or connect')

test('group context menu: new subgroup, rename, delete with confirmation', async () => {
  const { win, dataDir } = await start([host(22, { name: 'core-1', group: 'HQ' })])
  const groupRow = win.locator('.side-group', { hasText: 'HQ' }).first()

  await groupRow.click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'New subgroup…' }).click()
  await win.getByLabel('Group name').fill('Building 1')
  await win.locator('.modal').getByRole('button', { name: 'Create group' }).click()
  await expect(win.locator('.host-list section[data-group="HQ/Building 1"]')).toBeVisible()

  await rowAction(win, 'Building 1', 'Rename…')
  await win.getByLabel('Group name').fill('B1')
  await win.locator('.modal').getByRole('button', { name: 'Rename' }).click()
  await expect(win.locator('.host-list section[data-group="HQ/B1"] h3')).toHaveText('B1')

  await groupRow.click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Delete group…' }).click()
  await expect(win.locator('.modal')).toContainText('1 host move to Default. 1 subgroup become top-level.')
  await win.locator('.modal').getByRole('button', { name: 'Delete group' }).click()
  await expect(win.locator('.host-list section[data-group="B1"]')).toBeVisible()
  expect(hostsFile(dataDir)[0].group).toBe('')
})

test('"Add host here" and empty-group shortcut prefill the group', async () => {
  const { win } = await start([], ['Site A/Floor 1'])
  await win.locator('section[data-group="Site A/Floor 1"] .tree-empty').click()
  await expect(win.locator('.modal label', { hasText: 'Group' }).locator('input').first()).toHaveValue('Site A/Floor 1')
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
  await rowAction(win, 'Site A', 'Add host here…')
  await expect(win.locator('.modal label', { hasText: 'Group' }).locator('input').first()).toHaveValue('Site A')
})

test('duplicate opens a prefilled form without copying the saved password', async () => {
  const { win, dataDir } = await start([host(2222, { name: 'acc-01', host: '10.0.0.11', group: 'Floor 2', legacy: true })])
  await rowAction(win, 'acc-01', 'Duplicate')
  await expect(win.locator('.modal h2')).toHaveText('New host')
  await expect(win.locator('.modal label', { hasText: 'Label' }).locator('input')).toHaveValue('acc-01 copy')
  await expect(win.locator('.modal input[type=password]')).toHaveAttribute('placeholder', /ask on connect/)
  await win.locator('.modal label', { hasText: 'Host / IP' }).locator('input').fill('10.0.0.12')
  await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()
  const hosts = hostsFile(dataDir)
  expect(hosts).toHaveLength(2)
  expect(hosts[1]).toMatchObject({ name: 'acc-01 copy', host: '10.0.0.12', port: 2222, group: 'Floor 2', legacy: true })
  expect(hosts[1].id).not.toBe(hosts[0].id)
})

test('search matches user@ip and offers quick connect; Escape clears', async () => {
  const { win } = await start([host(22, { name: 'core', host: '10.10.0.1', username: 'netops' }), host(22, { name: 'edge', host: '10.20.0.1' })])
  await search(win).fill('netops@10.10')
  await expect(win.locator('.host-name')).toHaveText(['core'])
  await expect(win.locator('.quick-row')).toContainText('Connect to netops@10.10')
  await expect(win.locator('.side-section-head')).toContainText('1 found')
  await search(win).press('Escape')
  await expect(search(win)).toHaveValue('')
  await expect(win.locator('.host-name')).toHaveCount(2)
})

test('keyboard: ⌘K focuses search, arrows move, ←/→ collapse/expand, Enter connects', async () => {
  const { win, app } = await start([host(22, { name: 'deep', group: 'HQ' })])
  await menu(app, 'Search Hosts')
  await expect(search(win)).toBeFocused()
  await search(win).press('ArrowDown')
  await expect(win.locator('.side-group', { hasText: 'Default' })).toBeFocused()
  await win.keyboard.press('ArrowDown')
  const groupRow = win.locator('.side-group', { hasText: 'HQ' })
  await expect(groupRow).toBeFocused()
  await win.keyboard.press('ArrowLeft')
  await expect(groupRow).toHaveAttribute('aria-expanded', 'false')
  await expect(win.locator('.host-name')).toHaveCount(0)
  await win.keyboard.press('ArrowRight')
  await win.keyboard.press('ArrowDown')
  await expect(win.locator('.host.side-row')).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(win.locator('.modal h2')).toHaveText('Password for admin@127.0.0.1')
})

test('header shows the host count; status dot turns green while connected', async () => {
  const dataDir = newDataDir()
  seed(dataDir, [
    host(0, { name: 'sw-console', group: 'Site-A', kind: 'serial', host: '', username: '', serial: { ...DEFAULT_SERIAL, path: '/dev/cu.usbserial-A10K' } }),
    host(22, { name: 'idle', group: 'Site-A' })
  ])
  ui = await launchApp(dataDir, { TERMFLOW_SERIAL_MOCK_PORTS: '/dev/cu.usbserial-A10K=FTDI' })
  const win = ui.win
  // No host counts in the sidebar: just the heading, and no number next to folders.
  await expect(win.locator('.side-section-head', { hasText: 'Hosts' }).locator('span').first()).toHaveText('Hosts')
  await expect(win.locator('.side-group', { hasText: 'Site-A' }).first()).not.toContainText('2')
  await expect(win.locator('.host-list .status-dot.live')).toHaveCount(0)
  await win.locator('.host-list .host', { hasText: 'sw-console' }).click()
  await expect(win.locator('.tab.active .dot.ready')).toBeVisible()
  // Every host has a faint frame; the open one gets the accent colour.
  const border = (name: string) =>
    win.locator('.host-list .host', { hasText: name }).evaluate((el) => getComputedStyle(el).borderTopColor)
  await expect.poll(() => border('sw-console')).toBe('rgb(122, 162, 247)')
  expect(await border('idle')).not.toBe('rgb(122, 162, 247)')
  expect(await border('idle')).not.toMatch(/^rgba\(0, 0, 0, 0\)$/)
  await expect(win.locator('.host-list .host', { hasText: 'sw-console' }).locator('.status-dot')).toHaveClass(/live/)
  await expect(win.locator('.host-list .host', { hasText: 'idle' }).locator('.status-dot')).not.toHaveClass(/live/)
  await expect(win.locator('.host-list .host.current')).toContainText('sw-console')
})

test('+ button menu creates a host or a group; no Dashboard entry in the sidebar', async () => {
  const { win } = await start()
  await expect(win.locator('.sidebar').getByText('Dashboard')).toHaveCount(0)
  await win.getByRole('button', { name: 'New', exact: true }).click()
  await win.getByRole('menuitem', { name: 'New group…' }).click()
  await win.getByLabel('Group name').fill('Lab')
  await win.locator('.modal').getByRole('button', { name: 'Create group' }).click()
  await expect(win.locator('.side-group h3')).toHaveText(['Default', 'Lab'])
  await win.getByRole('button', { name: 'New', exact: true }).click()
  await win.getByRole('menuitem', { name: 'New host…' }).click()
  await expect(win.locator('.modal h2')).toHaveText('New host')
})

test('version from package.json is shown on the dashboard and About panel, not in the sidebar', async () => {
  const { version } = require('../package.json')
  const { win, app } = await start()
  await expect(win.locator('.side-foot')).toHaveText('Data folder')
  await expect(win.locator('.dash-version')).toHaveText(`Termflow v${version}`)
  // Dashboard logo is the app icon artwork and actually loads (CSP allows it).
  await expect.poll(() => win.locator('img.brand-mark').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256)
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version)
})

test.describe('Default group', () => {
  test('always first, shown even when empty, with a quick "Add host"', async () => {
    const { win } = await start([host(22, { name: 'core', group: 'Alpha' })])
    await expect(win.locator('.host-list .side-group h3')).toHaveText(['Default', 'Alpha'])
    const def = win.locator('.host-list section[data-group="Default"]')
    await def.locator('.tree-empty').click()
    await expect(win.locator('.modal label', { hasText: 'Group' }).locator('input').first()).toHaveValue('')
  })

  test('ungrouped and quick-connect hosts land in Default; menu offers only "Add host here"', async () => {
    const { win, dataDir } = await start([host(22, { name: 'loose', group: '' })])
    await expect(win.locator('.host-list section[data-group="Default"] .host-name')).toHaveText(['loose'])
    await win.getByLabel('Search hosts or connect').fill('ops@10.9.9.9')
    await win.getByLabel('Search hosts or connect').press('Enter')
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    await expect(win.locator('.host-list section[data-group="Default"] .host-name')).toHaveText(['10.9.9.9', 'loose'])
    expect(hostsFile(dataDir).map((h) => h.group)).toEqual(['', ''])

    await win.locator('.host-list .side-group', { hasText: 'Default' }).click({ button: 'right' })
    await expect(win.getByRole('menuitem')).toHaveText(['Add host here…'])
  })

  test('"Default" cannot be used as a group name', async () => {
    const { win } = await start()
    await win.getByRole('button', { name: 'New', exact: true }).click()
    await win.getByRole('menuitem', { name: 'New group…' }).click()
    await win.getByLabel('Group name').fill('default')
    await win.locator('.modal').getByRole('button', { name: 'Create group' }).click()
    await expect(win.locator('.modal .error')).toHaveText('"Default" is a built-in group; choose another name')
  })
})

test('the host being worked on stays marked while its menu, edit or delete dialog is open', async () => {
  const { win } = await start([host(22, { name: 'core-1', group: 'HQ' }), host(22, { name: 'core-2', group: 'HQ' })])
  const row = win.locator('.host-list .host', { hasText: 'core-1' })
  const other = win.locator('.host-list .host', { hasText: 'core-2' })

  await row.hover()
  await row.getByRole('button', { name: 'More actions for core-1' }).click()
  await win.mouse.move(900, 700) // pointer leaves the row
  await expect(row).toHaveClass(/\bworking\b/)
  await expect(row.locator('.row-more')).toBeVisible()
  await expect(other).not.toHaveClass(/\bworking\b/)

  await win.getByRole('menuitem', { name: 'Edit…' }).click()
  await expect(win.locator('.modal')).toBeVisible()
  await expect(row).toHaveClass(/\bworking\b/) // still marked while editing
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
  await expect(row).not.toHaveClass(/\bworking\b/)

  await row.click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Delete…' }).click()
  await expect(row).toHaveClass(/\bworking\b/)
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
  await expect(row).not.toHaveClass(/\bworking\b/)

  await row.click({ button: 'right' })
  await win.keyboard.press('Escape')
  await expect(row).not.toHaveClass(/\bworking\b/)
})
