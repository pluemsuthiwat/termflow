import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Host } from '../src/shared/types'
import {
  activeTerm,
  connectTo,
  expectReady,
  fingerprint,
  host,
  hostKeys,
  KEY_PASSPHRASE,
  keys,
  knownHostFor,
  launchApp,
  newDataDir,
  rowAction,
  seed,
  startServer,
  type FakeServer,
  type FakeServerOptions,
  type Launched
} from './helpers'

let server: FakeServer | undefined
let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  await server?.stop()
  ui = server = undefined
})

/** Start a fake device + the app with one trusted host pointing at it. */
async function setup(opts: FakeServerOptions, over: Partial<Host> = {}, env: Record<string, string> = {}) {
  server = await startServer(opts)
  const h = host(server.port, over)
  const dataDir = newDataDir()
  seed(dataDir, [h], knownHostFor(server.port, fingerprint(opts.hostKey ?? hostKeys.a)))
  ui = await launchApp(dataDir, env)
  return { h, win: ui.win, server }
}

test.describe('password auth', () => {
  test('plain "password" method (no keyboard-interactive) logs in', async () => {
    const { h, win, server } = await setup({ methods: ['password'] })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    expect(server.authAttempts()).toEqual([{ type: 'auth', method: 'password', answers: ['cisco123'], ok: true }])
  })

  test('keyboard-interactive is answered with the typed password, no extra prompt', async () => {
    const { h, win, server } = await setup({ methods: ['keyboard-interactive'] })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    await expect(win.locator('.modal')).toHaveCount(0)
    expect(server.authAttempts()).toHaveLength(1)
  })

  test('saved password is reused on the next connect without asking', async () => {
    const { h, win, server } = await setup({ methods: ['keyboard-interactive'] })
    await connectTo(win, h.name, 'cisco123', true)
    await expectReady(win)
    await expect.poll(() => fs.existsSync(path.join(ui!.dataDir, 'secrets.json'))).toBe(true)
    await win.waitForTimeout(200) // host list refresh after save
    await connectTo(win, h.name) // second tab, no dialog expected
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)
    await expectReady(win)
    await expect(win.locator('.modal')).toHaveCount(0)
    expect(server.authAttempts().map((a) => a.type === 'auth' && a.ok)).toEqual([true, true])
    const secrets = fs.readFileSync(path.join(ui!.dataDir, 'secrets.json'), 'utf8')
    expect(secrets).not.toContain('cisco123')
    expect(fs.readFileSync(path.join(ui!.dataDir, 'hosts.json'), 'utf8')).not.toContain('cisco123')
  })

  test('wrong password is reported in the dialog before any tab opens; retry succeeds', async () => {
    const { h, win, server } = await setup({ methods: ['keyboard-interactive'] })
    await connectTo(win, h.name, 'wrong1')
    await expect(win.locator('.modal [role=alert]')).toHaveText('Wrong username or password')
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
    await expect(win.locator('.modal input[type=password]')).toHaveValue('')
    await expect(win.locator('.modal input[type=password]')).toBeFocused()
    const input = win.locator('.modal input[type=password]')
    await input.fill('wrong2')
    await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(input).toBeDisabled()
    await expect(input).toHaveValue('') // cleared once the second attempt failed
    await expect(win.locator('.modal [role=alert]')).toHaveText('Wrong username or password')
    await input.fill('cisco123')
    await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
    await expectReady(win)
    await expect(win.locator('.modal')).toHaveCount(0)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(1)
    // One attempt per Connect click, never an automatic re-prompt (AAA lockout).
    expect(server.authAttempts().map((a) => a.type === 'auth' && a.ok)).toEqual([false, false, true])
  })

  test('wrong password over the plain "password" method is caught too', async () => {
    const { h, win, server } = await setup({ methods: ['password'] })
    await connectTo(win, h.name, 'wrong')
    await expect(win.locator('.modal [role=alert]')).toHaveText('Wrong username or password')
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
    expect(server.authAttempts()).toHaveLength(1)
  })

  test('a rejected password is not saved even with "save" ticked', async () => {
    const { h, win } = await setup({ methods: ['keyboard-interactive'] })
    await connectTo(win, h.name, 'wrong', true)
    await expect(win.locator('.modal [role=alert]')).toHaveText('Wrong username or password')
    expect(fs.existsSync(path.join(ui!.dataDir, 'secrets.json'))).toBe(false)
    await win.locator('.modal input[type=password]').fill('cisco123')
    await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
    await expectReady(win)
    // "Save" stayed ticked, so the accepted password is stored.
    await expect.poll(() => fs.existsSync(path.join(ui!.dataDir, 'secrets.json'))).toBe(true)
  })

  test('wrong saved password: asks for a new one and replaces the saved one', async () => {
    const { h, win, server } = await setup({ methods: ['keyboard-interactive'] })
    await rowAction(win, h.name, 'Edit…')
    await win.locator('.modal input[type=password]').fill('old-password')
    await win.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(win.locator('.modal')).toHaveCount(0)

    await connectTo(win, h.name)
    await expect(win.locator('.modal [role=alert]')).toHaveText('Wrong username or password')
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
    await expect(win.locator('.modal input[type=checkbox]')).toBeChecked()
    await win.locator('.modal input[type=password]').fill('cisco123')
    await win.locator('.modal').getByRole('button', { name: 'Connect', exact: true }).click()
    await expectReady(win)

    // Next time the new saved password just works.
    await win.waitForTimeout(200) // host list refresh after save
    await connectTo(win, h.name)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(2)
    await expectReady(win)
    expect(server.authAttempts().map((a) => a.type === 'auth' && a.ok)).toEqual([false, true, true])
  })

  test('cancelling the device prompt closes the login without sending anything', async () => {
    const { h, win, server } = await setup({
      methods: ['keyboard-interactive'],
      kbdPrompts: [
        { prompt: 'Password: ', echo: false },
        { prompt: 'OTP code: ', echo: true }
      ]
    })
    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.modal h2')).toHaveText('Device login')
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click()
    await expect(win.locator('.modal')).toHaveCount(0)
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
    expect(server.authAttempts()).toHaveLength(0)
  })

  test('password + OTP prompts are shown to the user, not auto-filled', async () => {
    const { h, win, server } = await setup({
      methods: ['keyboard-interactive'],
      kbdPrompts: [
        { prompt: 'Password: ', echo: false },
        { prompt: 'OTP code: ', echo: true }
      ],
      kbdCheck: (a) => a[0] === 'cisco123' && a[1] === '424242'
    })
    await connectTo(win, h.name, 'cisco123')
    await expect(win.getByText('OTP code:')).toBeVisible()
    await win.locator('.modal input[type=password]').fill('cisco123')
    await win.locator('.modal input[type=text]').fill('424242')
    await win.locator('.modal').getByRole('button', { name: 'Continue' }).click()
    await expectReady(win)
    expect(server.authAttempts()).toHaveLength(1)
  })
})

test.describe('public key auth', () => {
  test('unencrypted ed25519 key', async () => {
    const { h, win, server } = await setup(
      { methods: ['publickey'], authorizedKeys: [keys.ed25519] },
      { auth: 'key', keyPath: keys.ed25519 }
    )
    await connectTo(win, h.name)
    await expectReady(win)
    expect(server.authAttempts('publickey')).toEqual([{ type: 'auth', method: 'publickey', ok: true }])
  })

  test('RSA key in PEM format', async () => {
    const { h, win } = await setup(
      { methods: ['publickey'], authorizedKeys: [keys.rsaPem] },
      { auth: 'key', keyPath: keys.rsaPem }
    )
    await connectTo(win, h.name)
    await expectReady(win)
  })

  test('encrypted key: clear error without passphrase, works once saved in host settings', async () => {
    const { h, win } = await setup(
      { methods: ['publickey'], authorizedKeys: [keys.ed25519Enc] },
      { auth: 'key', keyPath: keys.ed25519Enc }
    )
    await connectTo(win, h.name)
    await expect(activeTerm(win)).toContainText('is encrypted: save its passphrase')

    await rowAction(win, h.name, 'Edit…')
    await win.locator('.modal input[type=password]').fill(KEY_PASSPHRASE)
    await win.locator('.modal').getByRole('button', { name: 'Save & connect' }).click()
    await expectReady(win)
  })

  test('missing key file gives a readable error', async () => {
    const { h, win } = await setup({ methods: ['publickey'] }, { auth: 'key', keyPath: '~/.ssh/does_not_exist' })
    await connectTo(win, h.name)
    await expect(activeTerm(win)).toContainText('Private key file not found: ~/.ssh/does_not_exist')
  })

  test('wrong key is rejected without hanging', async () => {
    const { h, win } = await setup(
      { methods: ['publickey'], authorizedKeys: [keys.rsaPem] },
      { auth: 'key', keyPath: keys.ed25519 }
    )
    await connectTo(win, h.name)
    await expect(activeTerm(win)).toContainText('All configured authentication methods failed')
  })
})

test.describe('ssh-agent auth', () => {
  let agentPid: string | undefined
  let sock: string

  test.beforeAll(() => {
    sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-agent-')), 'agent.sock')
    const out = execFileSync('ssh-agent', ['-a', sock, '-s']).toString()
    agentPid = out.match(/SSH_AGENT_PID=(\d+)/)?.[1]
    execFileSync('ssh-add', ['-q', keys.ed25519], { env: { ...process.env, SSH_AUTH_SOCK: sock } })
  })

  test.afterAll(() => {
    if (agentPid) process.kill(Number(agentPid))
  })

  test('logs in with a key held by the agent', async () => {
    const { h, win, server } = await setup(
      { methods: ['publickey'], authorizedKeys: [keys.ed25519] },
      { auth: 'agent' },
      { SSH_AUTH_SOCK: sock }
    )
    await connectTo(win, h.name)
    await expectReady(win)
    expect(server.authAttempts('publickey').some((a) => a.type === 'auth' && a.ok)).toBe(true)
  })
})

test.describe('algorithms & connectivity', () => {
  const savedHost = (): Host => JSON.parse(fs.readFileSync(path.join(ui!.dataDir, 'hosts.json'), 'utf8'))[0]

  test('legacy-only device connects with no setting and is marked legacy', async () => {
    const { h, win } = await setup({ legacyOnly: true }, { legacy: false })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    expect(savedHost().legacy).toBe(true)
    await expect(win.locator('.host .badge')).toHaveText(['legacy'])
  })

  test('IOS 12.2-style device (diffie-hellman-group1-sha1 only) connects', async () => {
    // Electron's BoringSSL lacks this DH group; src/main/dh-groups.ts provides it.
    const { h, win } = await setup(
      {
        algorithms: {
          kex: ['diffie-hellman-group1-sha1'],
          cipher: ['aes128-cbc', '3des-cbc'],
          hmac: ['hmac-sha1', 'hmac-md5'],
          serverHostKey: ['ssh-rsa']
        }
      },
      { legacy: false }
    )
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    expect(savedHost().legacy).toBe(true)
  })

  test('IOS-XE 17-style device offering AES-GCM under RFC 5647 names connects, not marked legacy', async () => {
    const { h, win } = await setup({
      algorithms: {
        kex: ['ecdh-sha2-nistp521', 'ecdh-sha2-nistp384'],
        cipher: ['aes256-gcm', 'aes128-gcm'],
        hmac: ['hmac-sha2-512'],
        serverHostKey: ['rsa-sha2-512']
      }
    })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    expect(savedHost().legacy).toBe(false)
  })

  test('modern device keeps modern algorithms; a stale legacy mark is cleared', async () => {
    const { h, win } = await setup({}, { legacy: true })
    await connectTo(win, h.name, 'cisco123')
    await expectReady(win)
    expect(savedHost().legacy).toBe(false)
    await expect(win.locator('.host .badge')).toHaveCount(0)
  })

  test('connection refused shows a readable error', async () => {
    const { h, win } = await setup({})
    await server!.stop()
    await connectTo(win, h.name, 'cisco123')
    await expect(win.locator('.modal [role=alert]')).toContainText('ECONNREFUSED')
    await expect(win.locator('.tab:not(.home)')).toHaveCount(0)
  })
})
