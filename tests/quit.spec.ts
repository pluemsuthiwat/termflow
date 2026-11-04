import { expect, test, type ElectronApplication } from '@playwright/test'
import {
  activeTerm,
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
  typeLine,
  type FakeServer,
  type Launched
} from './helpers'

const PORT = '/dev/cu.usbserial-A10K'
let server: FakeServer | undefined
let ui: Launched | undefined

test.afterEach(async () => {
  // Let the app close without asking, whatever a test left open.
  await ui?.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  }).catch(() => {})
  await ui?.app.close().catch(() => {})
  await server?.stop()
  ui = server = undefined
})

async function start(ports = '') {
  server = await startServer()
  const h = host(server.port, { name: 'core-sw-01', group: '' })
  const dataDir = newDataDir()
  seed(dataDir, [h], knownHostFor(server.port, fingerprint(hostKeys.a)))
  ui = await launchApp(dataDir, { TERMFLOW_NO_QUIT_CONFIRM: '', TERMFLOW_LOCAL_SHELL: '/bin/sh', TERMFLOW_SERIAL_MOCK_PORTS: ports })
  return { ...ui, h }
}

/** Answer the next confirmation with `response` (0 = Quit, 1 = Cancel) and record what it said. */
const answer = (app: ElectronApplication, response: number) =>
  app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { asked: { message: string; detail: string; buttons: string[] }[] }
    g.asked = []
    dialog.showMessageBox = (async (_w: unknown, o: { message: string; detail: string; buttons: string[] }) => {
      g.asked.push({ message: o.message, detail: o.detail, buttons: o.buttons })
      return { response: r, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox
  }, response)
const asked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { asked: { message: string; detail: string; buttons: string[] }[] }).asked)
const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const closeWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())

test.describe('quitting with sessions open', () => {
  test('no sessions: quits without asking', async () => {
    const { app } = await start()
    await answer(app, 1)
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await closed
    ui = undefined
  })

  test('asks once, listing every open SSH, console and terminal session; Cancel keeps them', async () => {
    const { app, win, h } = await start(`${PORT}=FTDI`)
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await win.locator('.serial-ports .port-row').click()
    await expectReady(win)
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await typeLine(win, 'sleep 600')

    await answer(app, 1)
    await app.evaluate(({ app }) => app.quit())
    await expect.poll(async () => (await asked(app)).length).toBe(1)
    const [q] = await asked(app)
    expect(q.message).toBe('Quit Termflow? 3 sessions are still open.')
    expect(q.detail).toContain('SSH: core-sw-01')
    expect(q.detail).toContain('Console: cu.usbserial-A10K')
    expect(q.detail).toContain('Terminal (sleep)')
    expect(q.buttons).toEqual(['Quit', 'Cancel'])
    // Still running, sessions intact.
    expect(await windows(app)).toBe(1)
    await expect(win.locator('.tab:not(.home) .dot.ready')).toHaveCount(3)

    // The close button asks too.
    await closeWindow(app)
    await expect.poll(async () => (await asked(app)).length).toBe(2)
    expect(await windows(app)).toBe(1)
  })

  test('a terminal sitting at its prompt does not ask; one running a program does', async () => {
    const { app, win } = await start()
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await answer(app, 1)
    await typeLine(win, 'sleep 600')
    await app.evaluate(({ app }) => app.quit())
    await expect.poll(async () => (await asked(app)).length).toBe(1)
    expect((await asked(app))[0].message).toBe('Quit Termflow? 1 session is still open.')

    // Back at the prompt: quits straight away (Cancel is still the answer, so a question would keep it open).
    await win.keyboard.press('Control+C')
    await typeLine(win, 'echo idle-$((1+1))')
    await expect(activeTerm(win)).toContainText('idle-2')
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await closed
    ui = undefined
  })

  test('Quit closes the app; a session that already ended is not counted', async () => {
    const { app, win } = await start()
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await win.keyboard.type('exit\n')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()

    await answer(app, 0)
    const closed = app.waitForEvent('close')
    await closeWindow(app)
    await closed
    ui = undefined
  })
})
