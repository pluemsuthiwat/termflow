import { SerialPort, SerialPortMock } from 'serialport'
import { portName } from '../shared/hosts'
import { normalizePorts } from '../shared/serial-ports'
import type { ConnectRequest, Host, SerialPortInfo, SerialSettings } from '../shared/types'
import { data, openLog, send, status, type SessionLog } from './session-io'
import * as store from './store'

// Tests run against @serialport/binding-mock instead of real hardware.
const MOCK = process.env.TERMFLOW_SERIAL_MOCK === '1'
const Port = (MOCK ? SerialPortMock : SerialPort) as typeof SerialPort

interface Session {
  port: SerialPort
  path: string
  log?: SessionLog
  closing?: boolean
}

const sessions = new Map<string, Session>()

// ---------- port discovery ----------

let known: SerialPortInfo[] = []
let scanned = false
let timer: NodeJS.Timeout | undefined

export async function listPorts(): Promise<SerialPortInfo[]> {
  known = normalizePorts(await Port.list())
  return known
}

async function scan(): Promise<void> {
  const before = new Set(known.map((p) => p.path))
  const ports = await listPorts().catch(() => known)
  const changed = ports.length !== before.size || ports.some((p) => !before.has(p.path))
  // Ports present at startup are not "new"; only later hot-plugs are.
  const added = scanned ? ports.filter((p) => !before.has(p.path)) : []
  if (!scanned || changed) send('serial:ports', ports, added)
  scanned = true
}

/** Poll for USB serial adapters being plugged in or removed. */
export function startWatching(intervalMs = 2000): void {
  if (timer) return
  void scan()
  timer = setInterval(() => void scan(), intervalMs)
}

export function stopWatching(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

// ---------- sessions ----------

function readableError(err: Error, path: string): string {
  const m = err.message
  if (/lock|busy|EBUSY/i.test(m)) return `${portName(path)} is in use by another app or tab`
  if (/ENOENT|No such file|does not exist|cannot open/i.test(m)) return `Console cable not found: ${portName(path)} — is it plugged in?`
  if (/EACCES|permission/i.test(m)) return `No permission to open ${portName(path)}`
  return m
}

/**
 * The saved path may be gone (macOS renames some adapters per USB socket).
 * Find the same cable again by its USB serial number.
 */
async function resolvePath(s: SerialSettings, host?: Host): Promise<string> {
  const ports = await listPorts().catch(() => known)
  if (ports.some((p) => p.path === s.path) || !s.serialNumber) return s.path
  const match = ports.find((p) => p.serialNumber === s.serialNumber && (!s.vendorId || p.vendorId === s.vendorId))
  if (!match) return s.path
  if (host?.serial) store.saveHost({ ...host, serial: { ...host.serial, path: match.path } })
  return match.path
}

export async function connect(req: ConnectRequest): Promise<void> {
  const host = req.hostId.startsWith('port:') ? undefined : store.getHost(req.hostId)
  const settings = host?.serial ?? req.serial
  if (!settings) throw new Error('No console port set for this host')
  // Only device nodes: never let a "port" be an arbitrary file.
  if (!/^\/dev\/[\w.-]+$/.test(settings.path)) throw new Error(`Not a serial device: ${settings.path}`)

  status(req.sessionId, { state: 'connecting' })
  const path = await resolvePath(settings, host)
  const port = new Port({
    path,
    baudRate: settings.baudRate,
    dataBits: settings.dataBits,
    parity: settings.parity,
    stopBits: settings.stopBits,
    rtscts: settings.flowControl === 'rtscts',
    xon: settings.flowControl === 'xon',
    xoff: settings.flowControl === 'xon',
    autoOpen: false
  })
  const session: Session = { port, path }

  await new Promise<void>((resolve, reject) =>
    port.open((err) => (err ? reject(new Error(readableError(err, path))) : resolve()))
  ).catch((err: Error) => {
    status(req.sessionId, { state: 'closed', error: err.message })
    throw err
  })

  sessions.set(req.sessionId, session)
  mockHooks?.opened.push({ path, baudRate: settings.baudRate, dataBits: settings.dataBits, parity: settings.parity, stopBits: settings.stopBits })
  if (host) store.touchHost(host.id)
  if (host ? host.logSession : req.log) session.log = openLog('console', host?.name || portName(path))

  port.on('data', (chunk: Buffer) => {
    data(req.sessionId, chunk)
    session.log?.write(chunk)
  })
  port.on('error', (err) => status(req.sessionId, { state: 'closed', error: readableError(err, path) }))
  port.on('close', (err?: Error & { disconnected?: boolean }) => {
    session.log?.end()
    sessions.delete(req.sessionId)
    const error = err?.disconnected ? `Device disconnected (${portName(path)})` : undefined
    status(req.sessionId, { state: 'closed', error })
  })

  status(req.sessionId, { state: 'ready', logFile: session.log?.file })
}

export const has = (sessionId: string): boolean => sessions.has(sessionId)

export function write(sessionId: string, text: string): void {
  sessions.get(sessionId)?.port.write(text)
}

export function close(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.port.isOpen) s.port.close()
}

/** Line break signal, e.g. to enter ROMMON on Cisco during password recovery. */
export async function sendBreak(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId)
  if (!s?.port.isOpen) return
  await s.port.set({ brk: true })
  mockHooks?.breaks.push(s.path)
  await new Promise((r) => setTimeout(r, 300))
  if (s.port.isOpen) await s.port.set({ brk: false })
}

export function closeAll(): void {
  stopWatching()
  for (const s of sessions.values()) if (s.port.isOpen) s.port.close()
}

// ---------- test hooks (mock mode only) ----------

interface MockHooks {
  opened: { path: string; baudRate: number; dataBits: number; parity: string; stopBits: number }[]
  breaks: string[]
  add(path: string, info?: { manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }): void
  remove(path: string): void
  /** Simulate unplugging the cable while a session is open. */
  unplug(path: string): void
  rescan(): Promise<void>
}

const mockHooks: MockHooks | undefined = MOCK
  ? (() => {
      const Binding = SerialPortMock.binding
      const created = new Map<string, object>()
      const recreate = () => {
        Binding.reset()
        for (const [p, info] of created) Binding.createPort(p, { echo: true, record: true, ...info })
      }
      // TERMFLOW_SERIAL_MOCK_PORTS="/dev/cu.a=FTDI,/dev/cu.b=Prolific": cables present at startup.
      for (const entry of (process.env.TERMFLOW_SERIAL_MOCK_PORTS ?? '').split(',').filter(Boolean)) {
        const [p, manufacturer] = entry.split('=')
        created.set(p, { manufacturer: manufacturer || 'FTDI', vendorId: '0403', productId: '6001' })
      }
      recreate()
      return {
        opened: [],
        breaks: [],
        add(path, info = {}) {
          created.set(path, { manufacturer: 'FTDI', vendorId: '0403', productId: '6001', ...info })
          recreate()
        },
        remove(path) {
          created.delete(path)
          recreate()
        },
        unplug(path) {
          for (const s of sessions.values()) {
            if (s.path !== path) continue
            // Same path a real unplug takes: the stream's read fails with a "disconnected" error.
            const err = Object.assign(new Error('Device not configured'), { disconnected: true })
            ;(s.port as unknown as { _disconnected(e: Error): void })._disconnected(err)
          }
          this.remove(path)
        },
        rescan: scan
      }
    })()
  : undefined

if (mockHooks) (globalThis as Record<string, unknown>).__termflowSerialMock = mockHooks
