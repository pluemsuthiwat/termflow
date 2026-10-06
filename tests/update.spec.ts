import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchApp, newDataDir, type Launched } from './helpers'

let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close()
  ui = undefined
})

const RELEASE_PAGE = 'https://github.com/pluemsuthiwat/termflow/releases/tag/v9.1.0'

/** Answer GitHub's "latest release" request with `reply` and record what the app opens in the browser. */
async function fakeGitHub(app: ElectronApplication, reply: { status: number; body?: unknown } | 'offline') {
  await app.evaluate(({ net, shell }, reply) => {
    const g = globalThis as unknown as { requests: string[]; opened: string[] }
    g.requests = []
    g.opened = []
    net.fetch = (async (url: string) => {
      g.requests.push(String(url))
      if (reply === 'offline') throw new Error('net::ERR_INTERNET_DISCONNECTED')
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
    }) as typeof net.fetch
    shell.openExternal = async (url: string) => void g.opened.push(url)
  }, reply)
  return {
    requests: () => app.evaluate(() => (globalThis as unknown as { requests: string[] }).requests),
    opened: () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
  }
}

const release = (tag: string, html_url = RELEASE_PAGE) => ({
  status: 200,
  body: {
    tag_name: tag,
    html_url,
    published_at: '2026-10-01T09:00:00Z',
    body: '## Highlights\n\n- **Faster** login\n- Fix `show run` paging\n\n<img src=x onerror=alert(1)>'
  }
})

test('version chip opens About; a newer release shows its notes and Download opens the release page', async () => {
  ui = await launchApp(newDataDir())
  const { win, app } = ui
  const { version } = require('../package.json')
  const gh = await fakeGitHub(app, release('v9.1.0'))

  await win.locator('.ver-chip').click()
  const modal = win.locator('.modal')
  await expect(modal.locator('h2')).toHaveText('About Termflow')
  await expect(modal.locator('.about-version')).toHaveText(`Version ${version}`)
  // Nothing is fetched until asked.
  expect(await gh.requests()).toEqual([])

  await modal.getByRole('button', { name: 'Check for updates' }).click()
  await expect(modal.locator('.update-box')).toContainText('Termflow 9.1.0 is available')
  await expect(modal.locator('.update-box')).toContainText(`You have ${version}`)
  await expect(modal.locator('.release-notes h4')).toHaveText('Highlights')
  await expect(modal.locator('.release-notes li strong')).toHaveText('Faster')
  // Notes are text: HTML in them is shown, never rendered.
  await expect(modal.locator('.release-notes img')).toHaveCount(0)
  await expect(modal.locator('.release-notes')).toContainText('<img src=x onerror=alert(1)>')
  expect(await gh.requests()).toEqual(['https://api.github.com/repos/pluemsuthiwat/termflow/releases/latest'])

  await modal.getByRole('button', { name: 'Download 9.1.0' }).click()
  await expect.poll(gh.opened).toEqual([RELEASE_PAGE])

  // The chip now points at the update.
  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(win.locator('.ver-chip .ver-update')).toHaveText('Update')
})

test('same version reports up to date; a release page outside the repo is never opened', async () => {
  ui = await launchApp(newDataDir())
  const { win, app } = ui
  const { version } = require('../package.json')
  let gh = await fakeGitHub(app, release(`v${version}`))

  await win.locator('.ver-chip').click()
  const modal = win.locator('.modal')
  await modal.getByRole('button', { name: 'Check for updates' }).click()
  await expect(modal.locator('.update-box')).toContainText("You're up to date")
  await expect(win.locator('.ver-chip .ver-update')).toHaveCount(0)

  gh = await fakeGitHub(app, release('v10.0.0', 'https://evil.example/termflow.dmg'))
  await modal.getByRole('button', { name: 'Check again' }).click()
  await modal.getByRole('button', { name: 'Download 10.0.0' }).click()
  await expect.poll(gh.opened).toEqual(['https://github.com/pluemsuthiwat/termflow/releases/tag/v10.0.0'])
})

test('offline and rate-limited checks explain themselves and can be retried', async () => {
  ui = await launchApp(newDataDir())
  const { win, app } = ui
  await fakeGitHub(app, 'offline')

  await win.locator('.ver-chip').click()
  const modal = win.locator('.modal')
  await modal.getByRole('button', { name: 'Check for updates' }).click()
  await expect(modal.locator('.update-box')).toContainText("Couldn't reach GitHub")

  await fakeGitHub(app, { status: 403 })
  await modal.getByRole('button', { name: 'Try again' }).click()
  await expect(modal.locator('.update-box')).toContainText('limiting requests')
  await modal.press('Escape')
  await expect(modal).toHaveCount(0)
})

test('"Check for Updates…" in the app menu opens About, checks at once, and keeps focus in the dialog', async () => {
  ui = await launchApp(newDataDir())
  const { win, app } = ui
  // A slow answer, to look at the dialog while the check runs.
  await app.evaluate(({ net }) => {
    net.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 800))
      return new Response(JSON.stringify({ tag_name: 'v9.1.0' }), { status: 200 })
    }) as typeof net.fetch
  })
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === 'Check for Updates…')!
    item.click()
  })
  const modal = win.locator('.modal')
  await expect(modal.locator('.update-box')).toContainText('Checking for updates')
  await expect(modal.getByRole('button', { name: 'Close' })).toBeFocused()
  await expect(modal.locator('.update-box')).toContainText('Termflow 9.1.0 is available')
  await win.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
})
