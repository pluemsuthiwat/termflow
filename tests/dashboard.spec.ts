import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import type { Host } from '../src/shared/types'
import {
  expectReady,
  fingerprint,
  host,
  hostKeys,
  knownHostFor,
  launchApp,
  menu,
  newDataDir,
  readJson,
  rowAction,
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

async function start(hosts: Host[] = [], groups?: string[], known?: Record<string, unknown>) {
  const dataDir = newDataDir()
  seed(dataDir, hosts, known)
  if (groups) fs.writeFileSync(`${dataDir}/groups.json`, JSON.stringify(groups))
  ui = await launchApp(dataDir)
  return { win: ui.win, app: ui.app, dataDir }
}

const tile = (win: Page, path: string) => win.locator(`.dg-tile[data-group="${path}"]`)
const hero = (win: Page) => win.locator('.group-hero')
const modal = (win: Page) => win.locator('.modal')
const hostsFile = (d: string) => readJson<Host[]>(d, 'hosts.json') ?? []
const groupField = (win: Page) => modal(win).locator('label', { hasText: 'Group' }).locator('input').first()

async function tileAction(win: Page, path: string, item: string) {
  const t = tile(win, path)
  await t.hover()
  await t.locator('.dh-more').click()
  await win.getByRole('menuitem', { name: item }).click()
}

async function createGroup(win: Page, name: string) {
  await win.locator('.dash-top').getByRole('button', { name: 'More new options' }).click()
  await win.getByRole('menuitem', { name: 'New group…' }).click()
  await win.getByLabel('Group name').fill(name)
  await modal(win).getByRole('button', { name: 'Create group' }).click()
}

test.describe('overview', () => {
  test('first launch shows the welcome guide', async () => {
    const { win } = await start()
    await expect(win.locator('.brand')).toHaveText('Termflow')
    await expect(win.getByRole('heading', { name: 'Welcome to Termflow' })).toBeVisible()
    await expect(win.locator('.stat-row')).toHaveCount(0)
  })

  test('summary tiles count hosts, groups and legacy devices', async () => {
    const { win } = await start([host(22, { group: 'A/B', legacy: true }), host(22, { group: 'C' }), host(22, { group: '' })])
    const stats = win.locator('.stat-row')
    await expect(stats.locator('.stat').nth(0)).toContainText('3Hosts')
    await expect(stats.locator('.stat').nth(1)).toContainText('3Groups')
    await expect(stats.locator('.stat').nth(2)).toContainText('0Live sessions')
    await expect(stats.locator('.stat.warn')).toContainText('1Legacy devices')
  })

  test('create a group: validated, persisted, shown as a tile and in the sidebar', async () => {
    const { win, dataDir } = await start()
    await createGroup(win, '   ')
    await expect(modal(win).locator('.error')).toHaveText('Group name is required')
    await win.getByLabel('Group name').fill('Core')
    await modal(win).getByRole('button', { name: 'Create group' }).click()
    await expect(tile(win, 'Core')).toContainText('0 hosts')
    await expect(win.locator('.host-list .side-group h3')).toHaveText(['Default', 'Core'])
    expect(readJson(dataDir, 'groups.json')).toEqual(['Core'])

    await createGroup(win, 'Core')
    await expect(modal(win).locator('.error')).toHaveText('Group "Core" already exists here')
  })

  test('group tiles show name and counts only (no subgroup names) and open on click', async () => {
    const { win } = await start([
      host(22, { group: 'HQ' }),
      host(22, { group: 'HQ/B1' }),
      host(22, { group: 'HQ/B2' }),
      host(22, { group: 'HQ/B3' }),
      host(22, { group: 'HQ/B4' })
    ])
    const hq = tile(win, 'HQ')
    await expect(hq.locator('.dg-meta')).toContainText('5 hosts')
    await expect(hq.locator('.dg-meta')).toContainText('4 subgroups')
    await expect(hq.locator('.dg-name')).toHaveText('HQ')
    await expect(hq).not.toContainText('B1')
    await hq.click()
    await expect(hero(win).locator('h2')).toHaveText('HQ')
    await expect(win.locator('.dg-tile[data-group]')).toHaveCount(4)
  })

  test('filter searches every host and shows the group path', async () => {
    const { win } = await start([
      host(22, { name: 'core-1', host: '10.0.0.1', group: 'Site/Core' }),
      host(22, { name: 'edge-1', host: '203.0.113.1', group: 'WAN' })
    ])
    await win.getByLabel('Filter hosts').fill('203.0')
    await expect(win.locator('.dash-section .dash-title').first()).toHaveText('1 result')
    await expect(win.locator('.dh-card .card-name')).toHaveText(['edge-1'])
    await win.getByLabel('Filter hosts').fill('core')
    await expect(win.locator('.dh-card .dh-path')).toHaveText(['Site › Core'])
    await win.getByLabel('Filter hosts').fill('zzz')
    await expect(win.getByText('No hosts match')).toBeVisible()
  })

  test('grid / list layout switch is remembered', async () => {
    const { win, dataDir } = await start([host(22, { name: 'u1', group: '' }), host(22, { name: 'u2', group: '' })])
    await expect(win.locator('.dh-card')).toHaveCount(2)
    await win.getByTitle('List').click()
    await expect(win.locator('.dh-table tbody tr')).toHaveCount(2)
    await expect(win.locator('.dh-table tbody tr').first()).toContainText('admin@127.0.0.1')
    await ui!.app.close()
    ui = await launchApp(dataDir)
    await expect(ui.win.locator('.dh-table tbody tr')).toHaveCount(2)
  })

  test('dashboard quick connect rejects malformed input', async () => {
    const { win } = await start()
    await win.getByLabel('Quick connect target').fill('admin@@bad host')
    await win.locator('.command-bar').getByRole('button', { name: 'Connect' }).click()
    await expect(win.locator('.dash-quick-error')).toBeVisible()
  })
})

test.describe('inside a group', () => {
  test('Back button and ⌘[ go up one level at a time', async () => {
    const { win, app } = await start([], ['Site A/Building 1/Floor 2'])
    await expect(hero(win)).toHaveCount(0) // Overview: nothing to go back to
    await tile(win, 'Site A').click()
    await tile(win, 'Site A/Building 1').click()
    await tile(win, 'Site A/Building 1/Floor 2').click()
    const back = hero(win).getByRole('button', { name: 'Back', exact: true })
    await expect(back).toHaveAttribute('title', 'Back to Building 1 (⌘[)')

    await back.click()
    await expect(hero(win).locator('h2')).toHaveText('Building 1')
    await menu(app, 'Back')
    await expect(hero(win).locator('h2')).toHaveText('Site A')
    await expect(back).toHaveAttribute('title', 'Back to Overview (⌘[)')
    await back.click()
    await expect(win.locator('.stat-row')).toBeVisible()
    await expect(hero(win)).toHaveCount(0)
    await menu(app, 'Back') // already at the top: stays put
    await expect(win.locator('.stat-row')).toBeVisible()
  })

  test('breadcrumb navigation and "Add host" prefill the current group', async () => {
    const { win, dataDir } = await start([], ['Bangkok HQ/Building 1'])
    await tile(win, 'Bangkok HQ').click()
    await tile(win, 'Bangkok HQ/Building 1').click()
    await expect(win.locator('.crumbs')).toHaveText(/Overview.*Bangkok HQ.*Building 1/)
    await expect(win.getByText('No hosts directly in this group yet')).toBeVisible()

    await hero(win).getByRole('button', { name: '+ Add host' }).click()
    await expect(groupField(win)).toHaveValue('Bangkok HQ/Building 1')
    await modal(win).locator('label', { hasText: 'Host / IP' }).locator('input').fill('10.10.1.1')
    await modal(win).locator('label', { hasText: 'Username' }).locator('input').fill('admin')
    await modal(win).getByRole('button', { name: 'Save', exact: true }).click()
    await expect(win.locator('.dh-card .card-name')).toHaveText(['10.10.1.1'])
    expect(hostsFile(dataDir)[0].group).toBe('Bangkok HQ/Building 1')

    await win.locator('.crumbs').getByRole('button', { name: 'Bangkok HQ' }).click()
    await expect(hero(win).locator('h2')).toHaveText('Bangkok HQ')
    await expect(tile(win, 'Bangkok HQ/Building 1')).toContainText('1 host')
    await win.locator('.crumbs').getByRole('button', { name: 'Overview' }).click()
    await expect(win.locator('.stat-row')).toBeVisible()
  })

  test('create nested subgroups from the hero; "/" is rejected; same name allowed elsewhere', async () => {
    const { win } = await start([], ['Site A', 'Site B/Floor 1'])
    await tile(win, 'Site A').click()
    await hero(win).getByRole('button', { name: '+ Subgroup' }).click()
    await expect(modal(win)).toContainText('Inside Site A')
    await win.getByLabel('Group name').fill('Floor/1')
    await modal(win).getByRole('button', { name: 'Create group' }).click()
    await expect(modal(win).locator('.error')).toHaveText(`Group name can't contain "/"`)
    await win.getByLabel('Group name').fill('Floor 1')
    await modal(win).getByRole('button', { name: 'Create group' }).click()
    await expect(tile(win, 'Site A/Floor 1')).toBeVisible()

    await hero(win).getByRole('button', { name: '+ Subgroup' }).click()
    await win.getByLabel('Group name').fill('Floor 1')
    await modal(win).getByRole('button', { name: 'Create group' }).click()
    await expect(modal(win).locator('.error')).toHaveText('Group "Floor 1" already exists here')
  })

  test('typing a path in the host form creates the whole chain', async () => {
    const { win, dataDir } = await start()
    await win.locator('.dash-top').getByRole('button', { name: 'New host' }).click()
    await modal(win).locator('label', { hasText: 'Host / IP' }).locator('input').fill('10.0.0.5')
    await modal(win).locator('label', { hasText: 'Username' }).locator('input').fill('admin')
    await groupField(win).fill(' Site B /  Bldg 3 / ')
    await modal(win).getByRole('button', { name: 'Save', exact: true }).click()
    await tile(win, 'Site B').click()
    await expect(tile(win, 'Site B/Bldg 3')).toContainText('1 host')
    expect(hostsFile(dataDir)[0].group).toBe('Site B/Bldg 3')
  })

  test('rename the current group from the hero keeps you inside it; children move along', async () => {
    const { win, dataDir } = await start(
      [host(22, { name: 'f2-acc', group: 'HQ/B1/F2' }), host(22, { name: 'hq-core', group: 'HQ' }), host(22, { name: 'other', group: 'HQX' })],
      ['HQ/B1/F3']
    )
    await tile(win, 'HQ').click()
    await hero(win).getByRole('button', { name: 'More actions for HQ' }).click()
    await win.getByRole('menuitem', { name: 'Rename…' }).click()
    await expect(win.getByLabel('Group name')).toHaveValue('HQ')
    await win.getByLabel('Group name').fill('Bangkok')
    await modal(win).getByRole('button', { name: 'Rename' }).click()
    await expect(hero(win).locator('h2')).toHaveText('Bangkok')
    await expect(tile(win, 'Bangkok/B1')).toContainText('1 host')
    expect(hostsFile(dataDir).map((h) => h.group)).toEqual(['Bangkok/B1/F2', 'Bangkok', 'HQX'])
    expect(readJson(dataDir, 'groups.json')).toEqual(['Bangkok/B1/F3'])
  })

  test('deleting the current group moves contents up and returns to the parent', async () => {
    const { win, dataDir } = await start([host(22, { name: 'b1-dist', group: 'HQ/B1' }), host(22, { name: 'f2-acc', group: 'HQ/B1/F2' })])
    await tile(win, 'HQ').click()
    await tile(win, 'HQ/B1').click()
    await hero(win).getByRole('button', { name: 'More actions for B1' }).click()
    await win.getByRole('menuitem', { name: 'Delete group…' }).click()
    await expect(modal(win)).toContainText('1 host and 1 subgroup move to “HQ”.')
    await modal(win).getByRole('button', { name: 'Delete group' }).click()
    await expect(hero(win).locator('h2')).toHaveText('HQ')
    await expect(tile(win, 'HQ/F2')).toBeVisible()
    await expect(win.locator('.dh-card .card-name')).toHaveText(['b1-dist'])
    expect(hostsFile(dataDir).map((h) => h.group)).toEqual(['HQ', 'HQ/F2'])
  })

  test('delete a top-level group from its tile menu; hosts move to Default', async () => {
    const { win, dataDir } = await start([host(22, { name: 'a', group: 'Lab' })], ['Lab'])
    await tileAction(win, 'Lab', 'Delete group…')
    await expect(modal(win)).toContainText('1 host move to Default.')
    await modal(win).getByRole('button', { name: 'Cancel' }).click()
    await expect(tile(win, 'Lab')).toBeVisible()
    await tileAction(win, 'Lab', 'Delete group…')
    await modal(win).getByRole('button', { name: 'Delete group' }).click()
    await expect(tile(win, 'Lab')).toHaveCount(0)
    await expect(win.locator('.dash-title', { hasText: 'Default' })).toBeVisible()
    expect(hostsFile(dataDir)[0].group).toBe('')
    expect(readJson(dataDir, 'groups.json')).toEqual([])
  })

  test('sidebar "Show in dashboard" opens that group', async () => {
    const { win } = await start([host(22, { name: 'deep', group: 'HQ/B1' })])
    await rowAction(win, 'B1', 'Show in dashboard')
    await expect(hero(win).locator('h2')).toHaveText('B1')
    await expect(win.locator('.dh-card .card-name')).toHaveText(['deep'])
  })
})

test.describe('host cards', () => {
  test('edit, duplicate and delete from the card menu', async () => {
    const { win, dataDir } = await start([host(22, { name: 'sw-x', group: '' }), host(22, { name: 'sw-y', group: '' })])
    const action = async (name: string, item: string) => {
      const card = win.locator('.dh-card', { hasText: name })
      await card.hover()
      await card.getByRole('button', { name: `Actions for ${name}` }).click()
      await win.getByRole('menuitem', { name: item }).click()
    }
    await action('sw-x', 'Edit…')
    await modal(win).locator('label', { hasText: 'Label' }).locator('input').fill('sw-renamed')
    await modal(win).getByRole('button', { name: 'Save', exact: true }).click()
    await expect(win.locator('.dh-card .card-name')).toHaveText(['sw-renamed', 'sw-y'])

    await action('sw-y', 'Delete…')
    await modal(win).getByRole('button', { name: 'Cancel' }).click()
    await expect(win.locator('.dh-card')).toHaveCount(2)
    await action('sw-y', 'Delete…')
    await modal(win).getByRole('button', { name: 'Delete host' }).click()
    await expect(win.locator('.dh-card .card-name')).toHaveText(['sw-renamed'])
    expect(hostsFile(dataDir).map((h) => h.name)).toEqual(['sw-renamed'])
  })

  test('connect from a card; Home shows live status, Recent and Live sessions', async () => {
    server = await startServer()
    const h = host(server.port, { name: 'core-sw-01', group: 'Core' })
    const { win, app, dataDir } = await start([h], undefined, knownHostFor(server.port, fingerprint(hostKeys.a)))
    await expect(win.locator('.recent')).toHaveCount(0)

    await tile(win, 'Core').click()
    await win.getByRole('button', { name: 'Connect to core-sw-01' }).click()
    await modal(win).locator('input[type=password]').fill('cisco123')
    await modal(win).getByRole('button', { name: 'Connect', exact: true }).click()
    await expectReady(win)
    await expect(win.locator('.dashboard')).toHaveCount(0)

    // Home returns to the dashboard where we left it (inside Core).
    await win.locator('.tab.home').click()
    await expect(hero(win).locator('h2')).toHaveText('Core')
    await win.locator('.crumbs').getByRole('button', { name: 'Overview' }).click()
    await expect(win.locator('.stat.ok')).toContainText('1Live sessions')
    await expect(win.locator('.recent')).toContainText('core-sw-01')
    await expect(tile(win, 'Core')).toContainText('1 live')
    await tile(win, 'Core').click()
    await expect(win.locator('.dh-card .dh-icon.live')).toHaveCount(1)
    await expect(win.locator('.dh-card .card-when')).toHaveText('● Connected')
    expect(hostsFile(dataDir)[0].lastConnectedAt).toBeTruthy()

    await menu(app, 'Tab 1')
    await expect(win.locator('.dashboard')).toHaveCount(0)
    await menu(app, 'Home')
    await expect(win.locator('.stat-row')).toBeVisible()
  })
})

test('Logs button on the dashboard opens the logs folder', async () => {
  const { win, app, dataDir } = await start()
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openPath = async (p: string) => (g.opened.push(p), '')
  })
  await win.locator('.dash-top').getByRole('button', { name: 'Logs' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
    .toEqual([`${dataDir}/logs`])
})
