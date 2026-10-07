import { expect, test, type Page } from '@playwright/test'
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
  rowAction,
  seed,
  startServer,
  typeLine,
  type FakeServer,
  type Launched
} from './helpers'

const PW = 'cisco123'
let servers: FakeServer[] = []
let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  await Promise.all(servers.map((s) => s.stop()))
  ui = undefined
  servers = []
})

/** Two devices (prompts R1# and R2#), both with trusted host keys. */
async function setup(dataDir = newDataDir()) {
  servers = [await startServer({ prompt: 'R1#' }), await startServer({ prompt: 'R2#' })]
  const [a, b] = servers.map((s, i) => host(s.port, { name: `router-${i + 1}` }))
  seed(dataDir, [a, b], { ...knownHostFor(servers[0].port, fingerprint(hostKeys.a)), ...knownHostFor(servers[1].port, fingerprint(hostKeys.a)) })
  ui = await launchApp(dataDir)
  return { a, b, srvA: servers[0], srvB: servers[1], win: ui.win, app: ui.app, dataDir }
}

const inputs = (s: FakeServer) => s.events.flatMap((e) => (e.type === 'input' ? [e.line] : []))
const shells = (s: FakeServer) => s.events.filter((e) => e.type === 'shell').length
const panes = (win: Page) => win.locator('.pane:not([hidden])')
const boxes = async (win: Page) => Promise.all((await panes(win).all()).map((p) => p.boundingBox()))

async function enterPassword(win: Page): Promise<void> {
  await win.locator('.modal input[type=password]').fill(PW)
  await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
}

async function paste(win: Page, text: string): Promise<void> {
  await win.evaluate((t) => {
    const ta = document.querySelector('.pane.focused:not([hidden]) textarea.xterm-helper-textarea')!
    const data = new DataTransfer()
    data.setData('text/plain', t)
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

test.describe('split panes', () => {
  test('a second device opens beside the first; input goes to the focused pane; closing one keeps the other', async () => {
    const { a, b, srvA, srvB, win, app } = await setup()
    await connectTo(win, a.name, PW)
    await expectReady(win)
    await expect(win.locator('.pane-header')).toHaveCount(0)

    await rowAction(win, b.name, 'Open in Split')
    await enterPassword(win)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)
    await expect(win.locator('.tab.active .tab-count')).toHaveText('2')
    await expect(panes(win)).toHaveCount(2)
    await expect(win.locator('.pane.focused .pane-title')).toHaveText(b.name)
    await expect(win.locator('.pane.focused .pane-header .dot.ready')).toBeVisible()
    // Side by side, each about half the width.
    const [boxA, boxB] = await boxes(win)
    expect(boxA!.y).toBe(boxB!.y)
    expect(Math.abs(boxA!.width - boxB!.width)).toBeLessThan(4)

    await expect(activeTerm(win)).toContainText('R2#')
    await typeLine(win, 'show version')
    await expect.poll(() => inputs(srvB)).toEqual(['show version'])
    expect(inputs(srvA)).toEqual([])

    // Clicking the other pane moves typing there.
    await win.locator('.pane:not(.focused) .term-pane').click()
    await expect(win.locator('.pane.focused .pane-title')).toHaveText(a.name)
    await typeLine(win, 'show color')
    await expect.poll(() => inputs(srvA)).toEqual(['show color'])

    // Dragging the divider resizes both panes.
    const divider = win.locator('.pane-divider')
    const d = (await divider.boundingBox())!
    const area = (await win.locator('.terminals').boundingBox())!
    await win.mouse.move(d.x + d.width / 2, d.y + d.height / 2)
    await win.mouse.down()
    await win.mouse.move(area.x + area.width * 0.3, d.y + d.height / 2, { steps: 5 })
    await win.mouse.up()
    const left = (await win.locator('.pane', { hasText: a.name }).boundingBox())!
    expect(left.width / area.width).toBeCloseTo(0.3, 1)

    // ⌘W closes only the focused pane; the other session stays up and is not reopened.
    await menu(app, 'Close Tab')
    await expect(panes(win)).toHaveCount(1)
    await expect(win.locator('.pane-header')).toHaveCount(0)
    await expect(win.locator('.tab.active .tab-title')).toHaveText(b.name)
    await expect.poll(() => srvA.openSessions()).toBe(0)
    expect(srvB.openSessions()).toBe(1)
    expect(shells(srvB)).toBe(1)
    await typeLine(win, 'show more')
    await expect.poll(() => inputs(srvB)).toEqual(['show version', 'show more'])
  })

  test('⌘D splits with the same device; panes move between tabs without reconnecting', async () => {
    const { a, srvA, win, app } = await setup()
    await connectTo(win, a.name, PW)
    await expectReady(win)

    await menu(app, 'Split Down')
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(2)
    await expect.poll(() => shells(srvA)).toBe(2)
    const [top, bottom] = await boxes(win)
    expect(top!.x).toBe(bottom!.x)
    expect(bottom!.y).toBeGreaterThan(top!.y)

    // Focus moves with ⌥⌘ arrows.
    await expect(win.locator('.pane.focused .pane-title')).toHaveText(`${a.name} (2)`)
    await menu(app, 'Select Pane Above')
    await expect(win.locator('.pane.focused .pane-title')).toHaveText(a.name)
    await menu(app, 'Select Pane Below')
    await expect(win.locator('.pane.focused .pane-title')).toHaveText(`${a.name} (2)`)

    await win.locator('.pane.focused').getByRole('button', { name: 'Move to new tab' }).click()
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)
    await expect(panes(win)).toHaveCount(1)
    await expect(win.locator('.tab.active .tab-title')).toHaveText(`${a.name} (2)`)
    await win.locator('.tab:not(.home)').first().click()
    await expect(win.locator('.tab.active .tab-title')).toHaveText(a.name)
    await expect(win.locator('.tab-count')).toHaveCount(0)
    // Same two sessions throughout.
    expect(shells(srvA)).toBe(2)
    expect(srvA.openSessions()).toBe(2)

    // The tab's ✕ closes every pane in it.
    await menu(app, 'Split Right')
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(2)
    await win.locator('.tab.active .tab-close').click()
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)
    await expect.poll(() => srvA.openSessions()).toBe(1)
  })
})

test.describe('split button and picker', () => {
  const picker = (win: Page) => win.getByRole('dialog', { name: /Split with|Open in new tab/ })

  test('the tab bar button picks a host by search, on the chosen side; Enter connects', async () => {
    const { a, b, srvB, win } = await setup()
    await connectTo(win, a.name, PW)
    await expectReady(win)

    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(picker(win)).toBeVisible()
    await expect(picker(win)).toContainText(`next to ${a.name}`)
    await expect(picker(win).getByRole('textbox', { name: 'Search hosts' })).toBeFocused()
    // Same device first, then hosts.
    await expect(picker(win).getByRole('option').first()).toContainText('Same device')
    await picker(win).getByRole('button', { name: 'Left' }).click()
    await win.keyboard.type('router-2')
    await expect(picker(win).getByRole('option')).toHaveCount(1)
    await win.keyboard.press('Enter')
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(2)
    await expect.poll(() => shells(srvB)).toBe(1)
    // b went to the left of a.
    const boxOf = (name: string) => win.locator('.pane', { has: win.locator('.pane-title', { hasText: new RegExp(`^${name}$`) }) }).boundingBox()
    expect((await boxOf(b.name))!.x).toBeLessThan((await boxOf(a.name))!.x)

    // Up, via ⌥↑ in the picker; the side choice is remembered between openings.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(picker(win).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true')
    await win.keyboard.press('Alt+ArrowUp')
    await expect(picker(win).getByRole('button', { name: 'Up' })).toHaveAttribute('aria-pressed', 'true')
    await picker(win).getByRole('option', { name: /Same device/ }).click()
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(3)
    const top = (await win.locator('.pane.focused').boundingBox())!
    const leftNow = (await win.locator('.pane', { hasText: b.name }).first().boundingBox())!
    expect(top.y).toBeLessThan(leftNow.y)
    expect(top.x).toBe(leftNow.x)
  })

  test('Esc closes the picker; on the Dashboard it opens a new tab instead', async () => {
    const { a, win, app } = await setup()
    await win.getByRole('button', { name: 'Open host' }).click()
    await expect(picker(win)).toHaveAttribute('aria-label', 'Open in new tab')
    await expect(picker(win).getByRole('button', { name: 'Left' })).toHaveCount(0)
    await win.keyboard.press('Escape')
    await expect(picker(win)).toHaveCount(0)

    await menu(app, 'Split With…')
    await picker(win).getByRole('option', { name: new RegExp(a.name) }).click()
    await enterPassword(win)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)
    await expect(panes(win)).toHaveCount(1)
  })

  test('a console port opens in a split; a port already open is disabled', async () => {
    servers = [await startServer({ prompt: 'R1#' })]
    const a = host(servers[0].port, { name: 'router-1' })
    const dataDir = newDataDir()
    seed(dataDir, [a], knownHostFor(servers[0].port, fingerprint(hostKeys.a)))
    ui = await launchApp(dataDir, { TERMFLOW_SERIAL_MOCK_PORTS: '/dev/cu.usbserial-A10K=FTDI' })
    const win = ui.win
    await connectTo(win, a.name, PW)
    await expectReady(win)

    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.keyboard.type('usbserial')
    await picker(win).getByRole('option', { name: /^cu\.usbserial-A10K/ }).click()
    await expect(panes(win)).toHaveCount(2)
    await expect(win.locator('.pane.focused .pane-header .dot.ready')).toBeVisible()

    // Same device is unavailable for a console pane, and the port is in use.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(picker(win).getByRole('option', { name: /Same device/ })).toBeDisabled()
    await expect(picker(win).getByRole('option', { name: /^cu\.usbserial-A10K/ })).toBeDisabled()
    await expect(picker(win).getByRole('option', { name: /^cu\.usbserial-A10K/ })).toContainText('Already open in a pane')
  })

  test('pane header: split this pane, zoom keeps the others connected, even out sizes', async () => {
    const { a, b, srvA, srvB, win } = await setup()
    await connectTo(win, a.name, PW)
    await expectReady(win)
    await rowAction(win, b.name, 'Open in Split')
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(2)

    // The header's split button targets its own pane (a), not the focused one (b).
    const paneA = win.locator('.pane', { has: win.locator('.pane-title', { hasText: new RegExp(`^${a.name}$`) }) })
    await paneA.getByRole('button', { name: 'Split pane' }).click()
    await expect(picker(win)).toContainText(`next to ${a.name}`)
    await picker(win).getByRole('button', { name: 'Down' }).click()
    await picker(win).getByRole('option', { name: /Same device/ }).click()
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(3)
    await expect.poll(() => shells(srvA)).toBe(2)
    // a and its copy share the left half; b keeps the right half.
    const bBox = (await win.locator('.pane', { has: win.locator('.pane-title', { hasText: new RegExp(`^${b.name}$`) }) }).boundingBox())!
    const area = (await win.locator('.terminals').boundingBox())!
    expect(bBox.height).toBeCloseTo(area.height, -1)

    // Zoom: one pane fills the tab, others stay connected; zoom off brings them back.
    await win.locator('.pane.focused').getByRole('button', { name: 'Zoom pane' }).click()
    await expect(panes(win)).toHaveCount(1)
    await expect(win.locator('.tab.active .tab-count.zoomed')).toHaveText('3')
    const z = (await win.locator('.pane.focused').boundingBox())!
    expect(z.width).toBeCloseTo(area.width, -1)
    expect(srvA.openSessions() + srvB.openSessions()).toBe(3)
    await win.locator('.pane.focused').getByRole('button', { name: 'Show all panes' }).click()
    await expect(panes(win)).toHaveCount(3)
    expect(shells(srvA) + shells(srvB)).toBe(3)

    // Even out: with b split right too, the tab has three columns of a third each.
    await win.locator('.pane', { has: win.locator('.pane-title', { hasText: new RegExp(`^${b.name}$`) }) }).locator('.term-pane').click()
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await picker(win).getByRole('button', { name: 'Right' }).click()
    await picker(win).getByRole('option', { name: /Same device/ }).click()
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(4)
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await picker(win).getByRole('button', { name: 'Even out sizes' }).click()
    await expect(picker(win)).toHaveCount(0)
    const widths = (await boxes(win)).map((x) => Math.round(x!.width))
    // Left column (a over its copy) is one third; the two on the right are a third each.
    const third = area.width / 3
    for (const w of widths) expect(Math.abs(w - third)).toBeLessThan(6)
  })
})

test.describe('drag and drop', () => {
  const paneOf = (win: Page, name: string) => win.locator('.pane', { has: win.locator('.pane-title', { hasText: new RegExp(`^${name}$`) }) })

  /** Drag from the middle of `from` to a point given as fractions of `onto`'s box. */
  async function drag(win: Page, from: import('@playwright/test').Locator, onto: import('@playwright/test').Locator, fx: number, fy: number, release = true) {
    const a = (await from.boundingBox())!
    const b = (await onto.boundingBox())!
    await win.mouse.move(a.x + Math.min(40, a.width / 2), a.y + a.height / 2)
    await win.mouse.down()
    await win.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 8 })
    if (release) await win.mouse.up()
  }

  test('a pane dragged by its header moves to another edge without reconnecting; Esc cancels', async () => {
    const { a, b, srvA, srvB, win } = await setup()
    await connectTo(win, a.name, PW)
    await expectReady(win)
    await rowAction(win, b.name, 'Open in Split')
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(2)
    // Side by side to start with: a left, b right.
    expect((await paneOf(win, a.name).boundingBox())!.x).toBeLessThan((await paneOf(win, b.name).boundingBox())!.x)

    // Esc mid-drag leaves everything where it was.
    await drag(win, paneOf(win, a.name).locator('.pane-header'), paneOf(win, b.name), 0.5, 0.9, false)
    await expect(win.locator('.drop-zone')).toBeVisible()
    await win.keyboard.press('Escape')
    await win.mouse.up()
    await expect(win.locator('.drop-zone')).toHaveCount(0)
    expect((await paneOf(win, a.name).boundingBox())!.x).toBeLessThan((await paneOf(win, b.name).boundingBox())!.x)

    // Drop a on b's lower edge: b on top, a below, full width each.
    await drag(win, paneOf(win, a.name).locator('.pane-header'), paneOf(win, b.name), 0.5, 0.9)
    const boxA = (await paneOf(win, a.name).boundingBox())!
    const boxB = (await paneOf(win, b.name).boundingBox())!
    expect(boxA.y).toBeGreaterThan(boxB.y)
    expect(boxA.x).toBe(boxB.x)
    await expect(win.locator('.pane.focused .pane-title')).toHaveText(a.name)
    expect(shells(srvA) + shells(srvB)).toBe(2)
    expect(srvA.openSessions() + srvB.openSessions()).toBe(2)

    // Onto the tab bar: the pane becomes a tab of its own.
    await drag(win, paneOf(win, a.name).locator('.pane-header'), win.locator('.tabbar'), 0.7, 0.5)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)
    await expect(panes(win)).toHaveCount(1)
    expect(srvA.openSessions() + srvB.openSessions()).toBe(2)
  })

  test('a tab dragged onto a pane joins it; a sidebar host dragged onto an edge opens there', async () => {
    const { a, b, srvA, srvB, win } = await setup()
    await connectTo(win, a.name, PW)
    await expectReady(win)
    await connectTo(win, b.name, PW)
    await expectReady(win)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)

    // Drag b's tab onto a's pane, left edge. The drag shows a's tab first, then drops there.
    await win.locator('.tab:not(.home)').first().click()
    await drag(win, win.locator('.tab:not(.home)').nth(1), win.locator('.terminals'), 0.1, 0.5)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)
    await expect(panes(win)).toHaveCount(2)
    expect((await paneOf(win, b.name).boundingBox())!.x).toBeLessThan((await paneOf(win, a.name).boundingBox())!.x)
    expect(shells(srvA) + shells(srvB)).toBe(2)
    expect(srvA.openSessions() + srvB.openSessions()).toBe(2)

    // A host from the sidebar onto a's top edge: a new session above a.
    await drag(win, win.locator('.host-list .host', { hasText: a.name }), paneOf(win, a.name), 0.5, 0.1)
    await enterPassword(win)
    await expect(panes(win)).toHaveCount(3)
    await expect.poll(() => shells(srvA)).toBe(2)
    const top = (await win.locator('.pane.focused').boundingBox())!
    const below = (await paneOf(win, a.name).boundingBox())!
    expect(top.y).toBeLessThan(below.y)
    expect(top.x).toBe(below.x)
  })
})

test('find: ⌘F highlights matches, Enter steps through them, Esc returns to the terminal', async () => {
  const { a, srvA, win, app } = await setup()
  await connectTo(win, a.name, PW)
  await expectReady(win)
  await typeLine(win, 'show version')
  await typeLine(win, 'show version')
  await expect(activeTerm(win)).toContainText('Cisco IOS')

  await menu(app, 'Find…')
  const input = win.getByRole('textbox', { name: 'Find in terminal' })
  await expect(input).toBeFocused()
  await input.fill('cisco ios')
  await expect(win.locator('.find-count')).toHaveText(/^\d\/2$/)
  const first = await win.locator('.find-count').textContent()
  await input.press('Enter')
  await expect(win.locator('.find-count')).not.toHaveText(first!)

  await win.getByRole('button', { name: 'Match case' }).click()
  await expect(win.locator('.find-count')).toHaveText('No results')
  await input.fill('Cisco IOS')
  await expect(win.locator('.find-count')).toHaveText(/^\d\/2$/)

  await input.press('Escape')
  await expect(win.locator('.find-bar')).toHaveCount(0)
  await typeLine(win, 'show color')
  await expect.poll(() => inputs(srvA)).toEqual(['show version', 'show version', 'show color'])
})

test('multi-line paste asks first; one line pastes as usual', async () => {
  const { a, srvA, win } = await setup()
  await connectTo(win, a.name, PW)
  await expectReady(win)

  await paste(win, 'show version\nshow color\nshow more\n')
  await expect(win.locator('.modal h2')).toHaveText(`Paste 3 lines into ${a.name}?`)
  await expect(win.locator('.paste-line')).toHaveText(['show version', 'show color', 'show more'])
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
  await expect(win.locator('.modal')).toHaveCount(0)
  await win.waitForTimeout(200)
  expect(inputs(srvA)).toEqual([])

  await paste(win, 'show version\r\nshow color\r\n')
  await win.locator('.modal').getByRole('button', { name: 'Paste', exact: true }).click()
  await expect.poll(() => inputs(srvA)).toEqual(['show version', 'show color'])

  await paste(win, 'show more\nshow version')
  await win.locator('.modal').getByRole('button', { name: 'Paste line by line' }).click()
  // The last line has no newline: it waits at the prompt like a normal paste.
  await expect.poll(() => inputs(srvA)).toEqual(['show version', 'show color', 'show more'])
  // Let the delayed last line arrive before pressing Enter.
  await win.waitForTimeout(400)
  await win.keyboard.press('Enter')
  await expect.poll(() => inputs(srvA)).toEqual(['show version', 'show color', 'show more', 'show version'])

  await paste(win, 'show color')
  await expect(win.locator('.modal')).toHaveCount(0)
  await win.keyboard.press('Enter')
  await expect.poll(() => inputs(srvA).at(-1)).toBe('show color')
})

test('a long paste can be scrolled through in the preview before sending', async () => {
  const { a, srvA, win } = await setup()
  await connectTo(win, a.name, PW)
  await expectReady(win)
  await paste(win, Array.from({ length: 200 }, (_, i) => `interface Gi0/${i + 1}`).join('\n'))
  await expect(win.locator('.modal h2')).toHaveText(`Paste 200 lines into ${a.name}?`)
  const preview = win.locator('.paste-preview')
  await expect(win.locator('.paste-line')).toHaveCount(200)
  // Taller content than the box: it scrolls, and the last line can be reached.
  expect(await preview.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true)
  const last = win.locator('.paste-line').last()
  await expect(last).not.toBeInViewport()
  await preview.hover()
  await win.mouse.wheel(0, 20000)
  await expect(last).toBeInViewport()
  await expect(last).toHaveText('interface Gi0/200')
  await expect(last).toHaveAttribute('data-n', '200')
  // The dialog's buttons stay reachable without scrolling the dialog.
  await expect(win.locator('.modal').getByRole('button', { name: 'Paste', exact: true })).toBeInViewport()
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
  expect(inputs(srvA)).toEqual([])
})

test('line-by-line paste shows progress and can be stopped', async () => {
  const { a, srvA, win } = await setup()
  await connectTo(win, a.name, PW)
  await expectReady(win)
  const many = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  await paste(win, many)
  await win.locator('.modal').getByRole('button', { name: 'Paste line by line' }).click()
  await expect(win.locator('.paste-progress')).toContainText('of 40')
  await expect.poll(() => inputs(srvA).length).toBeGreaterThan(1)
  await win.locator('.paste-progress').getByRole('button', { name: 'Stop' }).click()
  await expect(win.locator('.paste-progress')).toHaveCount(0)
  const sent = inputs(srvA).length
  await win.waitForTimeout(500)
  expect(inputs(srvA).length).toBe(sent)
  expect(sent).toBeLessThan(40)
})

test('real ⌘V (the Edit menu paste) goes through the multi-line check', async () => {
  const { a, srvA, win, app } = await setup()
  await connectTo(win, a.name, PW)
  await expectReady(win)
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('show version\nshow color'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())
    await expect(win.locator('.modal h2')).toHaveText(`Paste 2 lines into ${a.name}?`)
    expect(inputs(srvA)).toEqual([])
    await win.locator('.modal').getByRole('button', { name: 'Paste', exact: true }).click()
    await expect.poll(() => inputs(srvA)).toEqual(['show version'])
  } finally {
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), saved)
  }
})

test('text size follows ⌘+ / ⌘− and the font dialog, and is remembered', async () => {
  const { a, win, app, dataDir } = await setup()
  await connectTo(win, a.name, PW)
  await expectReady(win)
  const fontOf = () => activeTerm(win).evaluate((el) => getComputedStyle(el).fontSize + ' ' + getComputedStyle(el).fontFamily)

  await expect.poll(fontOf).toMatch(/^13px Menlo/)
  await menu(app, 'Bigger Text')
  await menu(app, 'Bigger Text')
  await expect.poll(fontOf).toMatch(/^15px/)
  await menu(app, 'Smaller Text')
  await expect.poll(fontOf).toMatch(/^14px/)
  await menu(app, 'Default Text Size')
  await expect.poll(fontOf).toMatch(/^13px/)

  await menu(app, 'Terminal Font…')
  await win.getByLabel('Font', { exact: true }).fill('Monaco')
  await win.getByLabel('Size', { exact: true }).fill('16')
  await win.locator('.modal').getByRole('button', { name: 'Save' }).click()
  await expect.poll(fontOf).toMatch(/^16px Monaco/)

  await ui!.app.close()
  ui = await launchApp(dataDir)
  await connectTo(ui.win, a.name, PW)
  await expectReady(ui.win)
  await expect.poll(() => activeTerm(ui!.win).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
})

test('links open in the browser on ⌘-click only', async () => {
  const { a, win, app } = await setup()
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => void g.opened.push(url)
  })
  const opened = () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
  await connectTo(win, a.name, PW)
  await expectReady(win)
  // The device echoes what is typed, so the URL shows up on screen.
  await win.keyboard.type('https://example.com/docs')
  await expect(activeTerm(win)).toContainText('https://example.com/docs')

  const point = await activeTerm(win).evaluate((rows) => {
    const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf('example')
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + 1)
      const b = r.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    throw new Error('link text not found')
  })
  await win.mouse.move(point.x, point.y)
  await win.mouse.click(point.x, point.y)
  await win.waitForTimeout(300)
  expect(await opened()).toEqual([])

  await win.mouse.move(point.x + 2, point.y)
  await win.keyboard.down('Meta')
  await win.mouse.click(point.x + 2, point.y)
  await win.keyboard.up('Meta')
  await expect.poll(opened).toEqual(['https://example.com/docs'])
})
