import { expect, test } from '@playwright/test'
import os from 'node:os'
import { activeTerm, expectReady, launchApp, menu, newDataDir, typeLine, type Launched } from './helpers'

// A plain shell so the test doesn't depend on the user's zsh setup.
const SHELL = { TERMFLOW_LOCAL_SHELL: '/bin/sh' }
let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  ui = undefined
})

test.describe('local terminal', () => {
  test('+ opens a shell in the home folder with a sized, colour terminal', async () => {
    ui = await launchApp(newDataDir(), SHELL)
    const { win } = ui
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await expect(win.locator('.tab.active .tab-title')).toHaveText('Terminal')

    await typeLine(win, 'echo "sum=$((40+2)) term=$TERM"; pwd; echo "size=$(stty size)."')
    await expect(activeTerm(win)).toContainText('sum=42 term=xterm-256color')
    await expect(activeTerm(win)).toContainText(os.homedir())
    // The pty got the pane's real size, not 0x0.
    await expect(activeTerm(win)).toContainText(/size=[1-9]\d* [1-9]\d*\./)
    // UTF-8 line editing: backspace removes a whole character (e.g. Thai), not one byte.
    await typeLine(win, 'echo "flag=$(stty -a | grep -o -- "-*iutf8")."')
    await expect(activeTerm(win)).toContainText('flag=iutf8.')

    // A second one is numbered like a second session to a host.
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.tab.active .tab-title')).toHaveText('Terminal (2)')
  })

  test('exit ends the shell; Enter starts a new one', async () => {
    ui = await launchApp(newDataDir(), SHELL)
    const { win } = ui
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await typeLine(win, 'exit 3')
    await expect(activeTerm(win)).toContainText('Shell ended: Shell exited with code 3')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()

    await win.keyboard.press('Enter')
    await expectReady(win)
    await typeLine(win, 'echo again-$((1+1))')
    await expect(activeTerm(win)).toContainText('again-2')
  })

  test('Split Right on a local pane opens another local shell beside it', async () => {
    ui = await launchApp(newDataDir(), SHELL)
    const { win, app } = ui
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await menu(app, 'Split Right')
    await expect(win.locator('.pane:not([hidden])')).toHaveCount(2)
    await expect(win.locator('.tab-count')).toHaveText('2')
    await typeLine(win, 'echo right-$((2*3))')
    await expect(activeTerm(win)).toContainText('right-6')
  })
})
