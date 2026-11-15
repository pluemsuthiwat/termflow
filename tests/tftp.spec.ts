import { expect, test } from '@playwright/test'
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp, newDataDir, type Launched } from './helpers'

let ui: Launched | undefined

test.afterEach(async () => {
  await ui?.app.close().catch(() => {})
  ui = undefined
})

let nextPort = 16900 + Math.floor(Math.random() * 500)

/** App with the TFTP folder in a temp dir and the server on a free high port. */
async function start() {
  const dataDir = newDataDir()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-tftp-'))
  fs.writeFileSync(path.join(dataDir, 'tftp.json'), JSON.stringify({ root }))
  const port = nextPort++
  ui = await launchApp(dataDir, { TERMFLOW_TFTP_PORT: String(port) })
  return { win: ui.win, app: ui.app, root, port }
}

async function startServer() {
  const s = await start()
  await s.win.getByRole('button', { name: 'TFTP', exact: true }).click()
  await s.win.locator('.modal').getByRole('button', { name: 'Start' }).click()
  await expect(s.win.locator('.tftp-status')).toContainText(`Running on port ${s.port}`)
  return s
}

// ---------- a small TFTP client ----------

type Reply = { op: number; block: number; data: Buffer; from: dgram.RemoteInfo }

function client() {
  const sock = dgram.createSocket('udp4')
  const queue: Reply[] = []
  let waiter: ((r: Reply) => void) | undefined
  sock.on('message', (msg, from) => {
    const r = { op: msg.readUInt16BE(0), block: msg.length >= 4 ? msg.readUInt16BE(2) : 0, data: msg.subarray(4), from }
    if (waiter) {
      const w = waiter
      waiter = undefined
      w(r)
    } else queue.push(r)
  })
  const next = (ms = 3000): Promise<Reply> =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('no reply')), ms)
          waiter = (r) => (clearTimeout(t), resolve(r))
        })
  const request = (op: number, file: string, port: number, opts: Record<string, string> = {}) =>
    sock.send(
      Buffer.concat([
        Buffer.from([0, op]),
        Buffer.from(`${file}\0octet\0` + Object.entries(opts).map(([k, v]) => `${k}\0${v}\0`).join(''), 'latin1')
      ]),
      port,
      '127.0.0.1'
    )
  const ack = (block: number, to: dgram.RemoteInfo) => {
    const b = Buffer.alloc(4)
    b.writeUInt16BE(4, 0)
    b.writeUInt16BE(block & 0xffff, 2)
    sock.send(b, to.port, to.address)
  }
  const data = (block: number, payload: Buffer, to: dgram.RemoteInfo) => {
    const b = Buffer.alloc(4)
    b.writeUInt16BE(3, 0)
    b.writeUInt16BE(block & 0xffff, 2)
    sock.send(Buffer.concat([b, payload]), to.port, to.address)
  }
  // Let the last ACK/DATA leave before closing: a send still queued would be dropped.
  return { sock, next, request, ack, data, close: () => void setTimeout(() => sock.close(), 50) }
}

const errorText = (r: Reply) => r.data.toString('latin1').replace(/\0.*$/, '')

/** Read a file the lockstep way; returns the bytes and every DATA block number seen. */
async function get(port: number, file: string, opts: Record<string, string> = {}) {
  const c = client()
  try {
    c.request(1, file, port, opts)
    const chunks: Buffer[] = []
    const blocks: number[] = []
    let blksize = 512
    let r = await c.next()
    if (r.op === 5) return { error: r.block, message: errorText(r) }
    let oack: Record<string, string> | undefined
    if (r.op === 6) {
      oack = parseOack(r)
      if (oack.blksize) blksize = Number(oack.blksize)
      c.ack(0, r.from)
      r = await c.next()
    }
    for (;;) {
      expect(r.op).toBe(3)
      blocks.push(r.block)
      chunks.push(r.data)
      c.ack(r.block, r.from)
      if (r.data.length < blksize) break
      r = await c.next()
    }
    return { bytes: Buffer.concat(chunks), blocks, oack }
  } finally {
    c.close()
  }
}

/** OACK is opcode 6 then option\0value\0 pairs; the client parsed bytes 2.. as block+data. */
function parseOack(r: Reply): Record<string, string> {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(r.block, 0)
  const parts = Buffer.concat([b, r.data]).toString('latin1').split('\0')
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) out[parts[i]] = parts[i + 1]
  return out
}

/** Upload bytes; returns the error code if the server refuses. */
async function put(port: number, file: string, bytes: Buffer, opts: Record<string, string> = {}) {
  const c = client()
  try {
    c.request(2, file, port, opts)
    let blksize = 512
    let r = await c.next()
    if (r.op === 5) return { error: r.block, message: errorText(r) }
    if (r.op === 6) blksize = Number(parseOack(r).blksize ?? 512)
    else expect([r.op, r.block]).toEqual([4, 0])
    const to = r.from
    for (let n = 1; ; n++) {
      const chunk = bytes.subarray((n - 1) * blksize, n * blksize)
      c.data(n, chunk, to)
      r = await c.next()
      if (r.op === 5) return { error: r.block, message: errorText(r) }
      expect([r.op, r.block]).toEqual([4, n & 0xffff])
      if (chunk.length < blksize) break
    }
    return {}
  } finally {
    c.close()
  }
}

const curl = (args: string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) => execFile('curl', ['-sS', ...args], (err, _out, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr })))

// ---------- tests ----------

test('stopped until started; Start, the tab-bar chip and Stop', async () => {
  const { win, port } = await start()
  await expect(win.locator('.tftp-chip')).toHaveCount(0)
  await win.getByRole('button', { name: 'TFTP', exact: true }).click()
  await expect(win.locator('.tftp-status')).toContainText('Stopped')
  // Nothing answers while stopped.
  expect(await get(port, 'x').catch((e: Error) => e.message)).toBe('no reply')
  await win.locator('.modal').getByRole('button', { name: 'Start' }).click()
  await expect(win.locator('.tftp-status')).toContainText(`Running on port ${port}`)
  await expect(win.locator('.tftp-chip')).toBeVisible()
  await win.locator('.modal').getByRole('button', { name: 'Stop' }).click()
  await expect(win.locator('.tftp-status')).toContainText('Stopped')
  await expect(win.locator('.tftp-chip')).toHaveCount(0)
})

test('devices read files: plain, with blksize+tsize, exact multiple of the block size, slashes', async () => {
  const { win, root, port } = await startServer()
  const small = randomBytes(1300)
  fs.writeFileSync(path.join(root, 'small.bin'), small)
  const exact = randomBytes(1024)
  fs.writeFileSync(path.join(root, 'exact.bin'), exact)
  const nested = randomBytes(3000)
  fs.mkdirSync(path.join(root, 'ios'))
  fs.writeFileSync(path.join(root, 'ios', 'img.bin'), nested)

  const a = await get(port, 'small.bin')
  expect(a.bytes).toEqual(small)
  expect(a.blocks).toEqual([1, 2, 3])

  const b = await get(port, 'small.bin', { blksize: '1024', tsize: '0' })
  expect(b.oack).toEqual({ blksize: '1024', tsize: '1300' })
  expect(b.bytes).toEqual(small)

  // 1024 bytes in 512-byte blocks: two full blocks, then an empty one ends it.
  const c = await get(port, 'exact.bin')
  expect(c.bytes).toEqual(exact)
  expect(c.blocks).toEqual([1, 2, 3])

  // Leading slash and backslashes, as devices send them.
  expect((await get(port, '\\ios\\img.bin')).bytes).toEqual(nested)
  expect((await get(port, '/ios/img.bin')).bytes).toEqual(nested)

  // blksize is capped to fit one Ethernet frame.
  expect((await get(port, '/small.bin', { blksize: '65464' })).oack).toEqual({ blksize: '1468' })

  await expect(win.locator('.tftp-transfer.done', { hasText: 'small.bin' })).toHaveCount(3)
  await expect(win.locator('.tftp-transfer.done', { hasText: 'small.bin' }).first()).toContainText('to 127.0.0.1')
  await expect(win.locator('.tftp-transfer:not(.done)')).toHaveCount(0)
})

// Firmware over 32 MB in 512-byte blocks passes block 65535; blksize 8 gets there with 512 KB.
test('block numbers wrap past 65535 to 0', async () => {
  test.slow()
  const { root, port } = await startServer()
  const big = randomBytes(65540 * 8 + 3)
  fs.writeFileSync(path.join(root, 'big.bin'), big)
  const d = await get(port, 'big.bin', { blksize: '8' })
  expect(d.bytes!.equals(big)).toBe(true)
  expect(d.blocks!.slice(65534, 65538)).toEqual([65535, 0, 1, 2])
})

test('missing files, ".." and links out of the folder are refused', async () => {
  const { root, port } = await startServer()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-outside-'))
  fs.writeFileSync(path.join(outside, 'secret'), 'no')
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'))
  fs.symlinkSync(outside, path.join(root, 'dirlink'))
  expect(await get(port, 'nope.bin')).toMatchObject({ error: 1 })
  expect(await get(port, '../' + path.basename(outside) + '/secret')).toMatchObject({ error: 2 })
  expect(await get(port, 'a/../../secret')).toMatchObject({ error: 2 })
  expect(await get(port, 'link')).toMatchObject({ error: 1 })
  expect(await put(port, 'dirlink/new.txt', Buffer.from('x'))).toMatchObject({ error: 2 })
  expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
})

test('ERROR packets and other non-requests get no answer (no error ping-pong between servers)', async () => {
  const { root, port } = await startServer()
  fs.writeFileSync(path.join(root, 'f.bin'), randomBytes(2000))
  const silent = async (c: ReturnType<typeof client>) => expect(await c.next(500).catch((e: Error) => e.message)).toBe('no reply')
  const stranger = client()
  const err = Buffer.from('\0\x05\0\x00oops\0', 'latin1')
  // To port 69: an ERROR, an ACK and garbage.
  stranger.sock.send(err, port, '127.0.0.1')
  await silent(stranger)
  stranger.ack(1, { address: '127.0.0.1', port } as dgram.RemoteInfo)
  await silent(stranger)
  stranger.sock.send(Buffer.from([0xff]), port, '127.0.0.1')
  await silent(stranger)
  // To a running transfer from another port: an ACK gets "unknown transfer ID", an ERROR nothing.
  const c = client()
  c.request(1, 'f.bin', port)
  const first = await c.next()
  stranger.ack(1, first.from)
  expect((await stranger.next()).block).toBe(5)
  stranger.sock.send(err, first.from.port, first.from.address)
  await silent(stranger)
  c.close()
  stranger.close()
})

test('devices upload new files; an existing name is never replaced', async () => {
  const { win, root, port } = await startServer()
  const cfg = randomBytes(5000)
  expect(await put(port, 'sw1-confg', cfg)).toEqual({})
  expect(fs.readFileSync(path.join(root, 'sw1-confg'))).toEqual(cfg)

  const exact = randomBytes(2048)
  expect(await put(port, '/exact.bin', exact, { blksize: '1024', tsize: '2048' })).toEqual({})
  expect(fs.readFileSync(path.join(root, 'exact.bin'))).toEqual(exact)

  fs.writeFileSync(path.join(root, 'keep.txt'), 'original')
  expect(await put(port, 'keep.txt', Buffer.from('new'))).toMatchObject({ error: 6 })
  expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).toBe('original')
  // Refused requests are listed with the reason.
  await expect(win.locator('.tftp-transfer.failed', { hasText: 'keep.txt' })).toContainText('File already exists')

  // A folder that doesn't exist isn't created.
  expect(await put(port, 'nodir/x.txt', Buffer.from('x'))).toMatchObject({ error: 2 })
  // No temp files left behind.
  expect(fs.readdirSync(root).filter((f) => f.endsWith('.part'))).toEqual([])
  await expect(win.locator('.tftp-transfer.done', { hasText: 'sw1-confg' })).toContainText('from 127.0.0.1')
})

test('stopping the server cancels an upload and removes its partial file', async () => {
  const { win, root, port } = await startServer()
  const c = client()
  c.request(2, 'half.bin', port)
  const r = await c.next()
  c.data(1, randomBytes(512), r.from)
  await c.next()
  await expect(win.locator('.tftp-transfer.active', { hasText: 'half.bin' })).toBeVisible()
  await win.locator('.modal').getByRole('button', { name: 'Stop' }).click()
  const e = await c.next()
  expect(e.op).toBe(5)
  c.close()
  await expect(win.locator('.tftp-transfer.failed', { hasText: 'half.bin' })).toContainText('Server stopped')
  expect(fs.readdirSync(root)).toEqual([])
})

test('works with curl as the client (get, put, big blocks)', async () => {
  test.skip(!/tftp/i.test(execFileSync('curl', ['-V']).toString()), 'curl without TFTP')
  const { root, port } = await startServer()
  const src = randomBytes(300 * 1024)
  fs.writeFileSync(path.join(root, 'fw.bin'), src)
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-curl-')), 'fw.bin')
  expect((await curl(['-o', out, `tftp://127.0.0.1:${port}/fw.bin`])).code).toBe(0)
  expect(fs.readFileSync(out).equals(src)).toBe(true)
  expect((await curl(['--tftp-blksize', '1468', '-o', out, `tftp://127.0.0.1:${port}/fw.bin`])).code).toBe(0)
  expect(fs.readFileSync(out).equals(src)).toBe(true)

  const up = path.join(path.dirname(out), 'backup.cfg')
  fs.writeFileSync(up, randomBytes(70 * 1024))
  expect((await curl(['-T', up, `tftp://127.0.0.1:${port}/`])).code).toBe(0)
  expect(fs.readFileSync(path.join(root, 'backup.cfg'))).toEqual(fs.readFileSync(up))
})

test('the folder is chosen in a main-process dialog and remembered', async () => {
  const { win, app } = await start()
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-other-'))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
  }, other)
  await win.getByRole('button', { name: 'TFTP', exact: true }).click()
  await win.locator('.modal').getByRole('button', { name: 'Change…' }).click()
  await expect(win.locator('.tftp-path')).toHaveAttribute('title', other)
  expect(JSON.parse(fs.readFileSync(path.join(ui!.dataDir, 'tftp.json'), 'utf8'))).toEqual({ root: other })
})

test('this Mac\'s addresses are listed by adapter; clicking one copies its IP', async () => {
  const { win, app } = await start()
  await win.getByRole('button', { name: 'TFTP', exact: true }).click()
  const card = win.locator('.tftp-addr').first()
  await expect(card).toBeVisible()
  const ip = (await card.locator('.tftp-addr-ip').innerText()).replace(/\/\d+$/, '')
  expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  await card.click()
  await expect(card).toContainText('Copied')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(ip)
  await expect(win.locator('.tftp-example code')).toHaveText(`copy tftp://${ip}/<file> flash:`)
  await expect(card).not.toContainText('Copied', { timeout: 3000 })
})

test('Shell menu opens the TFTP panel', async () => {
  const { win, app } = await start()
  await app.evaluate(({ Menu }) => {
    const shellMenu = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Shell')!
    shellMenu.submenu!.items.find((i) => i.label === 'TFTP Server…')!.click()
  })
  await expect(win.locator('.modal h2')).toHaveText('TFTP server')
})
