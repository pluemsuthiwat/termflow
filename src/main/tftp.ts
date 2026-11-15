import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TftpAddress, TftpState, TftpTransfer } from '../shared/types'
import { send } from './session-io'
import * as store from './store'

// TFTP server (RFC 1350 with the blksize, tsize and timeout options of RFC 2347-2349), so
// switches and routers can pull firmware/configs from this Mac and push backups to it.
// Devices read and write inside one folder; uploads never replace a file that is already there.
// It only runs while the user has it on: never started at launch, stopped when the app quits.

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 } as const
const ERR = { UNDEFINED: 0, NOT_FOUND: 1, ACCESS: 2, DISK_FULL: 3, ILLEGAL: 4, UNKNOWN_TID: 5, EXISTS: 6 } as const

const DEFAULT_BLKSIZE = 512
// Bigger blocks than one Ethernet frame get fragmented, and fragments often don't cross VLANs.
const MAX_BLKSIZE = 1468
const DEFAULT_TIMEOUT_S = 3
const RETRIES = 5
const KEEP_TRANSFERS = 50

/** Tests pin a high port; devices always use 69. */
const port = (): number => Number(process.env.TERMFLOW_TFTP_PORT) || 69

let server: dgram.Socket | undefined
let error: string | undefined
let builtinBlocking = false
/** Error code of the last failed bind, e.g. EADDRINUSE. */
let bindError: string | undefined
const transfers: TftpTransfer[] = []
const aborts = new Map<string, () => void>()

// ---------- state for the window ----------

/** "Wi-Fi", "USB 10/100/1000 LAN", ... by device (en0, en5), from networksetup. */
const portNames = new Map<string, string>()
let portNamesAt = 0

function loadPortNames(): void {
  // At most every 10 s: called whenever an address shows up on a device not named yet.
  if (Date.now() - portNamesAt < 10_000) return
  portNamesAt = Date.now()
  execFile('/usr/sbin/networksetup', ['-listallhardwareports'], (err, out) => {
    if (err) return
    for (const m of out.matchAll(/Hardware Port: (.+)\nDevice: (\S+)/g)) portNames.set(m[2], m[1])
    publish()
  })
}

function portLabel(device: string): { label: string; kind: TftpAddress['kind'] } {
  if (/^utun|^ipsec|^ppp/.test(device)) return { label: 'VPN', kind: 'vpn' }
  const name = portNames.get(device)
  if (!name) {
    loadPortNames()
    return { label: device, kind: 'wired' }
  }
  return { label: name, kind: /wi-?fi|airport/i.test(name) ? 'wifi' : 'wired' }
}

function addresses(): TftpAddress[] {
  const out: TftpAddress[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, prefix: Number(a.cidr?.split('/')[1]) || undefined, ...portLabel(name) })
  // Wired first (usually the cable to the device), VPNs last.
  const rank = { wired: 0, wifi: 1, vpn: 2 }
  return out.sort((x, y) => rank[x.kind] - rank[y.kind])
}

export function state(): TftpState {
  return { running: !!server, port: port(), root: store.tftpRoot(), home: os.homedir(), error, builtinBlocking, addresses: addresses(), transfers }
}

let pending: NodeJS.Timeout | undefined
/** Progress is sent at most a few times a second; starts, ends and errors go out at once. */
function publish(now = true): void {
  if (!now) {
    pending ??= setTimeout(() => publish(), 250)
    return
  }
  if (pending) clearTimeout(pending)
  pending = undefined
  send('tftp:state', state())
}

function track(t: TftpTransfer): void {
  transfers.unshift(t)
  // Forget the oldest finished ones; running transfers always stay listed.
  for (let i = transfers.length - 1; i >= 0 && transfers.length > KEEP_TRANSFERS; i--)
    if (transfers[i].state !== 'active') transfers.splice(i, 1)
  publish()
}

/** Labels of transfers still running, for the quit confirmation. */
export function active(): string[] {
  return transfers
    .filter((t) => t.state === 'active')
    .map((t) => `TFTP ${t.direction === 'get' ? 'sending' : 'receiving'} ${t.file} (${t.peer})`)
}

// ---------- packets ----------

const cstr = (s: string): Buffer => Buffer.from(s + '\0', 'latin1')

function errorPacket(code: number, message: string): Buffer {
  return Buffer.concat([Buffer.from([0, OP.ERROR, 0, code]), cstr(message)])
}

function ackPacket(block: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt16BE(OP.ACK, 0)
  b.writeUInt16BE(block & 0xffff, 2)
  return b
}

function oackPacket(opts: Record<string, string>): Buffer {
  return Buffer.concat([Buffer.from([0, OP.OACK]), ...Object.entries(opts).flatMap(([k, v]) => [cstr(k), cstr(v)])])
}

interface Request {
  op: number
  file: string
  mode: string
  options: Record<string, string>
}

/** RRQ/WRQ: opcode, filename\0, mode\0, then option\0value\0 pairs. */
function parseRequest(msg: Buffer): Request | undefined {
  if (msg.length < 4) return undefined
  const op = msg.readUInt16BE(0)
  const parts = msg.subarray(2).toString('latin1').split('\0')
  if (parts.length < 3 || !parts[0] || !parts[1]) return undefined
  const options: Record<string, string> = {}
  for (let i = 2; i + 1 < parts.length; i += 2) if (parts[i]) options[parts[i].toLowerCase()] = parts[i + 1]
  return { op, file: parts[0], mode: parts[1].toLowerCase(), options }
}

/** Options we accept, as they go back in the OACK; anything else is left out (RFC 2347). */
function negotiate(req: Request, size?: number): { blksize: number; timeoutS: number; oack: Record<string, string> } {
  const oack: Record<string, string> = {}
  let blksize = DEFAULT_BLKSIZE
  let timeoutS = DEFAULT_TIMEOUT_S
  const b = Number(req.options.blksize)
  if (Number.isInteger(b) && b >= 8) {
    blksize = Math.min(b, MAX_BLKSIZE)
    oack.blksize = String(blksize)
  }
  const t = Number(req.options.timeout)
  if (Number.isInteger(t) && t >= 1 && t <= 255) {
    timeoutS = t
    oack.timeout = String(t)
  }
  if ('tsize' in req.options) {
    // A read is answered with the real size; a write echoes the size the device announced.
    const announced = Number(req.options.tsize)
    if (req.op === OP.RRQ && size !== undefined) oack.tsize = String(size)
    else if (req.op === OP.WRQ && Number.isInteger(announced) && announced >= 0) oack.tsize = String(announced)
  }
  return { blksize, timeoutS, oack }
}

// ---------- paths ----------

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * The file a device asked for, inside the TFTP folder. Devices often send "/name" or
 * "dir\name": both are taken as relative to the folder. ".." and links out of it are refused.
 */
function resolve(root: string, name: string): string | undefined {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = clean.split('/').filter((s) => s && s !== '.')
  if (!segments.length || segments.includes('..') || clean.includes('\0')) return undefined
  const full = path.join(root, ...segments)
  return inside(root, full) ? full : undefined
}

function realInside(root: string, p: string): boolean {
  try {
    return inside(fs.realpathSync(root), fs.realpathSync(p))
  } catch {
    return false
  }
}

// ---------- transfers ----------

/** One transfer talks to one device from a socket of its own (the transfer ID of RFC 1350). */
function transferSocket(peer: dgram.RemoteInfo, onPacket: (msg: Buffer) => void): dgram.Socket {
  const sock = dgram.createSocket('udp4')
  sock.on('message', (msg, from) => {
    if (from.address !== peer.address || from.port !== peer.port) {
      // Errors are never answered (RFC 1350): two servers would bounce them back and forth forever.
      if (msg.length >= 2 && msg.readUInt16BE(0) !== OP.ERROR) sock.send(errorPacket(ERR.UNKNOWN_TID, 'Unknown transfer ID'), from.port, from.address)
      return
    }
    onPacket(msg)
  })
  sock.on('error', () => {})
  sock.bind(0)
  return sock
}

/** Turn a request down: the device gets the error, and the list shows it so the user sees why. */
function refuse(req: Request, peer: dgram.RemoteInfo, code: number, message: string): void {
  server?.send(errorPacket(code, message), peer.port, peer.address)
  track({ ...newTransfer(req, peer, req.op === OP.RRQ ? 'get' : 'put'), state: 'failed', error: message, ended: Date.now() })
}

function startTransfer(req: Request, peer: dgram.RemoteInfo): void {
  if (req.mode !== 'octet' && req.mode !== 'netascii') return refuse(req, peer, ERR.ILLEGAL, `Mode ${req.mode} is not supported`)
  const root = store.tftpRoot()
  const target = resolve(root, req.file)
  if (!target) return refuse(req, peer, ERR.ACCESS, 'Access violation')
  if (req.op === OP.RRQ) void sendFile(req, peer, root, target)
  else receiveFile(req, peer, root, target)
}

function newTransfer(req: Request, peer: dgram.RemoteInfo, direction: 'get' | 'put', size?: number): TftpTransfer {
  return {
    id: randomBytes(6).toString('hex'),
    peer: peer.address,
    file: req.file.replace(/\\/g, '/').replace(/^\/+/, ''),
    direction,
    bytes: 0,
    size,
    state: 'active',
    started: Date.now()
  }
}

/** A device reads a file (RRQ): DATA blocks out, one at a time, each waiting for its ACK. */
async function sendFile(req: Request, peer: dgram.RemoteInfo, root: string, file: string): Promise<void> {
  let fh: fs.promises.FileHandle
  let size: number
  try {
    if (!realInside(root, file)) return refuse(req, peer, ERR.NOT_FOUND, 'File not found')
    fh = await fs.promises.open(file, 'r')
    const st = await fh.stat()
    if (!st.isFile()) {
      await fh.close()
      return refuse(req, peer, ERR.NOT_FOUND, 'File not found')
    }
    size = st.size
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return refuse(req, peer, code === 'EACCES' ? ERR.ACCESS : ERR.NOT_FOUND, code === 'EACCES' ? 'Access violation' : 'File not found')
  }

  const { blksize, timeoutS, oack } = negotiate(req, size)
  const t = newTransfer(req, peer, 'get', size)
  // block = blocks sent so far (keeps counting past 65535; the wire number wraps to 0).
  let block = 0
  let last: Buffer
  let lastBlock = false
  let tries = 0
  let timer: NodeJS.Timeout | undefined
  let finished = false
  // While the next block is being read, a repeated ACK must not start another read.
  let reading = false

  const finish = (outcome: 'done' | 'failed', message?: string) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    aborts.delete(t.id)
    void fh.close().catch(() => {})
    try {
      sock.close()
    } catch {}
    t.state = outcome
    t.error = message
    t.ended = Date.now()
    publish()
  }

  const transmit = (packet: Buffer) => {
    last = packet
    tries = 0
    sock.send(packet, peer.port, peer.address)
    arm()
  }

  // Resend the last packet only when its ACK is late, never because of a duplicate ACK
  // (that would double every packet from then on: the "Sorcerer's Apprentice" bug).
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (++tries > RETRIES) return finish('failed', 'Device stopped answering')
      sock.send(last, peer.port, peer.address)
      arm()
    }, timeoutS * 1000)
  }

  // Read ahead in big chunks: one disk read per 64 KB rather than one per block.
  let chunk = Buffer.alloc(0)
  let chunkAt = 0
  const readAt = async (offset: number): Promise<Buffer> => {
    if (offset < chunkAt || offset + blksize > chunkAt + chunk.length) {
      if (chunk.length && chunkAt + chunk.length >= size && offset >= chunkAt) return chunk.subarray(offset - chunkAt, offset - chunkAt + blksize)
      const buf = Buffer.alloc(Math.max(blksize, 65536 - (65536 % blksize)))
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      chunk = buf.subarray(0, bytesRead)
      chunkAt = offset
    }
    return chunk.subarray(offset - chunkAt, offset - chunkAt + blksize)
  }

  const sendBlock = async () => {
    reading = true
    const data = await readAt(block * blksize).finally(() => (reading = false))
    if (finished) return
    block++
    // A short block ends the transfer, so a file that fills its last block exactly gets an empty one after it.
    lastBlock = data.length < blksize
    const head = Buffer.alloc(4)
    head.writeUInt16BE(OP.DATA, 0)
    head.writeUInt16BE(block & 0xffff, 2)
    transmit(Buffer.concat([head, data]))
  }

  const sock = transferSocket(peer, (msg) => {
    if (msg.length < 4) return
    const op = msg.readUInt16BE(0)
    if (op === OP.ERROR) return finish('failed', `Device cancelled: ${msg.subarray(4).toString('latin1').replace(/\0.*$/, '') || 'error'}`)
    if (op !== OP.ACK || reading || msg.readUInt16BE(2) !== (block & 0xffff)) return
    clearTimeout(timer)
    t.bytes = Math.min(block * blksize, size)
    if (block > 0 && lastBlock) return finish('done')
    publish(false)
    sendBlock().catch((err) => {
      sock.send(errorPacket(ERR.UNDEFINED, 'Read error'), peer.port, peer.address)
      finish('failed', (err as Error).message)
    })
  })

  aborts.set(t.id, () => {
    sock.send(errorPacket(ERR.UNDEFINED, 'Server stopped'), peer.port, peer.address)
    finish('failed', 'Server stopped')
  })
  track(t)
  // With options the OACK goes first and the device answers it with ACK 0.
  if (Object.keys(oack).length) transmit(oackPacket(oack))
  else
    sendBlock().catch((err) => {
      sock.send(errorPacket(ERR.UNDEFINED, 'Read error'), peer.port, peer.address)
      finish('failed', (err as Error).message)
    })
}

/** Uploads being written, by target path: two devices can't write the same name at once. */
const writing = new Set<string>()

/** A device writes a file (WRQ): into a hidden temp file, renamed only once complete. */
function receiveFile(req: Request, peer: dgram.RemoteInfo, root: string, file: string): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir) || !realInside(root, dir)) return refuse(req, peer, ERR.ACCESS, 'Access violation')
  // lstat: a link with that name counts as taken too.
  if (writing.has(file) || fs.lstatSync(file, { throwIfNoEntry: false })) return refuse(req, peer, ERR.EXISTS, 'File already exists')
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(4).toString('hex')}.part`)
  let fd: number
  try {
    fd = fs.openSync(tmp, 'wx', 0o644)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return refuse(req, peer, code === 'ENOSPC' ? ERR.DISK_FULL : ERR.ACCESS, code === 'ENOSPC' ? 'Disk full' : 'Access violation')
  }
  writing.add(file)

  const { blksize, timeoutS, oack } = negotiate(req)
  const announced = Number(oack.tsize)
  const t = newTransfer(req, peer, 'put', Number.isFinite(announced) && announced > 0 ? announced : undefined)
  // expected = number of the next DATA block (keeps counting past 65535; the wire number wraps).
  let expected = 1
  let last: Buffer
  let tries = 0
  let timer: NodeJS.Timeout | undefined
  let finished = false

  const cleanup = () => {
    writing.delete(file)
    aborts.delete(t.id)
    try {
      fs.closeSync(fd)
    } catch {}
  }

  const fail = (message: string, toDevice?: Buffer) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (toDevice) sock.send(toDevice, peer.port, peer.address)
    cleanup()
    fs.rmSync(tmp, { force: true })
    setTimeout(() => sock.close(), 100)
    t.state = 'failed'
    t.error = message
    t.ended = Date.now()
    publish()
  }

  const transmit = (packet: Buffer) => {
    last = packet
    tries = 0
    sock.send(packet, peer.port, peer.address)
    arm()
  }

  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (++tries > RETRIES) return fail('Device stopped sending')
      sock.send(last, peer.port, peer.address)
      arm()
    }, timeoutS * 1000)
  }

  const sock = transferSocket(peer, (msg) => {
    if (msg.length < 4) return
    const op = msg.readUInt16BE(0)
    if (finished) {
      // The device resends its last block when our final ACK got lost: ACK it again.
      if (t.state === 'done' && op === OP.DATA && msg.readUInt16BE(2) === ((expected - 1) & 0xffff)) sock.send(last, peer.port, peer.address)
      return
    }
    if (op === OP.ERROR) return fail(`Device cancelled: ${msg.subarray(4).toString('latin1').replace(/\0.*$/, '') || 'error'}`)
    if (op !== OP.DATA) return
    const n = msg.readUInt16BE(2)
    if (n === ((expected - 1) & 0xffff)) return void sock.send(last, peer.port, peer.address)
    if (n !== (expected & 0xffff)) return
    const data = msg.subarray(4)
    try {
      fs.writeSync(fd, data)
    } catch (err) {
      const full = (err as NodeJS.ErrnoException).code === 'ENOSPC'
      return fail(full ? 'Disk full' : (err as Error).message, errorPacket(full ? ERR.DISK_FULL : ERR.UNDEFINED, full ? 'Disk full' : 'Write error'))
    }
    t.bytes += data.length
    expected++
    if (data.length === blksize) {
      transmit(ackPacket(expected - 1))
      return publish(false)
    }
    // Last block: put the file in place (link refuses a name that appeared meanwhile), then ACK.
    clearTimeout(timer)
    try {
      fs.closeSync(fd)
      fs.linkSync(tmp, file)
      fs.rmSync(tmp, { force: true })
    } catch (err) {
      const exists = (err as NodeJS.ErrnoException).code === 'EEXIST'
      return fail(exists ? 'File already exists' : (err as Error).message, errorPacket(exists ? ERR.EXISTS : ERR.UNDEFINED, exists ? 'File already exists' : 'Write error'))
    }
    finished = true
    last = ackPacket(expected - 1)
    sock.send(last, peer.port, peer.address)
    writing.delete(file)
    aborts.delete(t.id)
    t.state = 'done'
    t.ended = Date.now()
    t.size = t.bytes
    publish()
    // Stay around one timeout to re-ACK a resent last block.
    setTimeout(() => sock.close(), timeoutS * 1000)
  })

  aborts.set(t.id, () => fail('Server stopped', errorPacket(ERR.UNDEFINED, 'Server stopped')))
  track(t)
  // With options the OACK takes the place of ACK 0.
  transmit(Object.keys(oack).length ? oackPacket(oack) : ackPacket(0))
}

// ---------- server ----------

/** macOS ships its own tftpd; when it is turned on, launchd holds port 69. */
function builtinTftpdEnabled(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('/bin/launchctl', ['print-disabled', 'system'], (err, out) =>
      resolve(!err && /"com\.apple\.tftpd"\s*=>\s*(enabled|false)/.test(out))
    )
  )
}

function readableError(err: NodeJS.ErrnoException): string {
  if (err.code === 'EADDRINUSE') return `Port ${port()} is in use by another TFTP server on this Mac`
  if (err.code === 'EACCES') return `No permission to use port ${port()}`
  return err.message
}

export async function start(): Promise<TftpState> {
  if (server) return state()
  error = undefined
  builtinBlocking = false
  bindError = undefined
  const root = store.tftpRoot()
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    error = `Can't create ${root}: ${(err as Error).message}`
    publish()
    return state()
  }
  const sock = dgram.createSocket('udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject)
      sock.bind(port(), () => {
        sock.off('error', reject)
        resolve()
      })
    })
  } catch (err) {
    sock.close()
    bindError = (err as NodeJS.ErrnoException).code
    error = readableError(err as NodeJS.ErrnoException)
    builtinBlocking = port() === 69 && (err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await builtinTftpdEnabled())
    if (builtinBlocking) error = 'Port 69 is held by the TFTP server built into macOS, which is turned on on this Mac'
    publish()
    return state()
  }
  sock.on('error', () => {})
  sock.on('message', (msg, peer) => {
    const req = parseRequest(msg)
    // Port 69 only takes requests. Anything else is dropped unanswered, ERROR packets above all
    // (answering those lets two servers bounce errors at each other forever).
    if (req && (req.op === OP.RRQ || req.op === OP.WRQ)) startTransfer(req, peer)
  })
  server = sock
  publish()
  return state()
}

export function stop(): TftpState {
  for (const abort of [...aborts.values()]) abort()
  try {
    server?.close()
  } catch {}
  server = undefined
  error = undefined
  builtinBlocking = false
  publish()
  return state()
}

/** Turn off macOS's own tftpd (asks for an administrator password), then start ours. */
export async function disableBuiltin(): Promise<TftpState> {
  const script =
    'do shell script "launchctl disable system/com.apple.tftpd; launchctl bootout system/com.apple.tftpd 2>/dev/null; true" with administrator privileges'
  const ok = await new Promise<boolean>((resolve) => execFile('/usr/bin/osascript', ['-e', script], (err) => resolve(!err)))
  if (!ok) return state()
  // launchd lets go of the port shortly after the job is removed.
  for (let i = 0; i < 10; i++) {
    const s = await start()
    if (s.running || bindError !== 'EADDRINUSE') return s
    await new Promise((r) => setTimeout(r, 300))
  }
  return state()
}

export function setRoot(dir: string): TftpState {
  store.setTftpRoot(dir)
  publish()
  return state()
}
