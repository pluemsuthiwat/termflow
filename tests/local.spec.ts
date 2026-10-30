import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeTerm, confirmClose, expectReady, launchApp, menu, newDataDir, typeLine, type Launched } from './helpers'

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

/** A folder with zsh startup files that each print their name, plus an alias in .zshrc. */
function zshFiles(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termflow-zdot-'))
  for (const f of ['zshenv', 'zprofile', 'zshrc', 'zlogin']) fs.writeFileSync(path.join(dir, `.${f}`), `print -n "${f} "\n`)
  fs.appendFileSync(path.join(dir, '.zshrc'), "alias hi='echo hello-from-alias'\n")
  return dir
}

// macOS 27 hides MAC addresses from Termflow's shells; zsh tabs get network tools that don't.
test.describe('local zsh network tools', () => {
  test.skip(process.platform !== 'darwin', 'macOS only')

  test('your startup files run in order and ZDOTDIR/HISTFILE are yours afterwards', async () => {
    const zdot = zshFiles()
    ui = await launchApp(newDataDir(), { TERMFLOW_LOCAL_SHELL: '/bin/zsh', ZDOTDIR: zdot })
    const { win } = ui
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await expect(activeTerm(win)).toContainText('zshenv zprofile zshrc zlogin')

    await typeLine(win, 'hi; echo "z=[$ZDOTDIR] h=[$HISTFILE] w=[$(whence -p ifconfig)] t=[${(k)parameters[(I)TERMFLOW_(USER_|)ZDOTDIR*|TERMFLOW_NETSHIM*]}]"')
    await expect(activeTerm(win)).toContainText('hello-from-alias')
    await expect(activeTerm(win)).toContainText(`z=[${zdot}] h=[${zdot}/.zsh_history]`)
    await expect(activeTerm(win)).toContainText(/w=\[\S*\/netshim\/bin\/ifconfig\] t=\[\]/)
  })

  test('without ZDOTDIR it stays unset; ifconfig shows real MACs and Ctrl+C works', async () => {
    const home = zshFiles()
    ui = await launchApp(newDataDir(), { TERMFLOW_LOCAL_SHELL: '/bin/zsh', HOME: home, ZDOTDIR: undefined })
    const { win } = ui
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await expect(activeTerm(win)).toContainText('zshenv zprofile zshrc zlogin')

    await typeLine(win, 'echo "z=[${ZDOTDIR-unset}] h=[$HISTFILE]"; ifconfig | grep -m1 ether | sed "s/^/mac=/"')
    await expect(activeTerm(win)).toContainText(`z=[unset] h=[${home}/.zsh_history]`)
    await expect(activeTerm(win)).toContainText(/mac=\s*ether [0-9a-f:]{17}/)
    await expect(activeTerm(win)).not.toContainText('02:00:00:00:00:00')

    // Runs on a pty of its own (line by line), and Ctrl+C stops it like a normal program.
    await typeLine(win, 'netstat -w 1')
    await expect(activeTerm(win)).toContainText('packets')
    await win.keyboard.press('Control+C')
    await win.waitForTimeout(500)
    await typeLine(win, 'echo "code=$? $(stty -a | grep -o -- "-*icanon")"')
    await expect(activeTerm(win)).toContainText('code=130 icanon')
  })

  test('closing a running shell asks first: tab ✕, pane ✕ and ⌘W; Cancel keeps it', async () => {
    ui = await launchApp(newDataDir(), SHELL)
    const { win, app } = ui
    const modal = win.locator('.modal')
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)

    await win.locator('.tab.active .tab-close').click()
    await expect(modal.locator('h2')).toHaveText('Close Terminal?')
    await expect(modal).toContainText('still connected. Closing ends it.')
    await modal.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).toHaveCount(0)
    await expect(win.locator('.tab.active .dot.ready')).toBeVisible()
    // Esc cancels too.
    await menu(app, 'Close Tab')
    await expect(modal).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)

    // Two panes in one tab: the tab's ✕ lists both.
    await menu(app, 'Split Right')
    await expect(win.locator('.pane.focused .pane-header .dot.ready')).toBeVisible()
    await win.locator('.tab.active .tab-close').click()
    await expect(modal.locator('h2')).toHaveText('Close 2 sessions?')
    await expect(modal.locator('.close-list li')).toHaveCount(2)
    await modal.getByRole('button', { name: 'Cancel' }).click()

    // A pane's own ✕ asks about that pane only.
    await win.locator('.pane.focused').getByRole('button', { name: 'Close pane' }).click()
    await expect(modal.locator('h2')).toHaveText('Close Terminal (2)?')
    await confirmClose(win)
    await expect(win.locator('.pane-header')).toHaveCount(0)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)
  })

  test('a shell that has ended closes without asking', async () => {
    ui = await launchApp(newDataDir(), SHELL)
    const { win } = ui
    await win.getByRole('button', { name: 'New terminal' }).click()
    await expectReady(win)
    await typeLine(win, 'exit')
    await expect(win.locator('.tab.active .dot.closed')).toBeVisible()
    await win.locator('.tab.active .tab-close').click()
    await expect(win.locator('.modal')).toHaveCount(0)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
  })
})
