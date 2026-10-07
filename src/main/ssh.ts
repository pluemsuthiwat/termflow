import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AnyAuthMethod,
  ClientChannel,
  ConnectConfig,
  KeyboardInteractiveAuthMethod,
  NegotiatedAlgorithms
} from 'ssh2'
import { AUTH_FAILED, LOGIN_CANCELLED, type ConnectRequest, type Host, type LoginRequest, type PromptAnswer, type PromptRequest } from '../shared/types'
import { data, openLog, send, status, type SessionLog } from './session-io'
import { addMissingDhGroups } from './dh-groups'
import * as store from './store'

// ssh2 is required (not imported) so it loads after the patch; imports are hoisted.
addMissingDhGroups()
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client, utils } = require('ssh2') as typeof import('ssh2')
type Client = import('ssh2').Client

// Old algorithms for old IOS / ASA / switch firmware. Always offered, but after
// the modern defaults: SSH picks the first algorithm in our list the device also
// has, so modern devices still get modern crypto and only old ones fall back.
// The negotiation is covered by the key exchange hash, so it can't be downgraded.
// Regexes only match algorithms ssh2 actually supports, so none of them throws.
const LEGACY = {
  // group14 first: group exchange gets a prime from the device that takes seconds
  // to validate when it is large (up to 8192 bits).
  kex: [/^diffie-hellman-group14-sha1$/, /^diffie-hellman-group-exchange-sha1$/, /^diffie-hellman-group1-sha1$/],
  serverHostKey: [/^ssh-dss$/],
  cipher: [/^aes(128|192|256)-cbc$/, /^3des-cbc$/, /^blowfish-cbc$/, /^arcfour(256|128)?$/],
  hmac: [/^hmac-sha1-96$/, /^hmac-md5$/, /^hmac-md5-96$/]
}
// Modern but not in ssh2's defaults: AES-GCM under its RFC 5647 names, which some
// IOS-XE releases offer instead of the @openssh.com ones.
const EXTRA_CIPHERS = [/^aes(128|256)-gcm$/]
const ALGORITHMS = {
  kex: { append: LEGACY.kex },
  serverHostKey: { append: LEGACY.serverHostKey },
  cipher: { append: [...EXTRA_CIPHERS, ...LEGACY.cipher] },
  hmac: { append: LEGACY.hmac }
} as unknown as ConnectConfig['algorithms']

/** True if the device could only agree on one of the old algorithms. */
function usesLegacy(n: NegotiatedAlgorithms): boolean {
  const used: [RegExp[], string][] = [
    [LEGACY.kex, n.kex],
    [LEGACY.serverHostKey, n.serverHostKey],
    [LEGACY.cipher, n.cs.cipher],
    [LEGACY.cipher, n.sc.cipher],
    [LEGACY.hmac, n.cs.mac],
    [LEGACY.hmac, n.sc.mac]
  ]
  return used.some(([res, name]) => res.some((re) => re.test(name)))
}

interface Session {
  client: Client
  host: Host
  stream?: ClientChannel
  log?: SessionLog
  /** Logged in via login(), waiting for its tab to open the shell. */
  unclaimed?: NodeJS.Timeout
}

const sessions = new Map<string, Session>()
const pendingPrompts = new Map<string, { sessionId: string; resolve: (answer: PromptAnswer) => void }>()

type NewPrompt = PromptRequest extends infer P ? (P extends PromptRequest ? Omit<P, 'requestId'> : never) : never

function ask(req: NewPrompt): Promise<PromptAnswer> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pendingPrompts.set(requestId, { sessionId: req.sessionId, resolve })
    send('ssh:prompt', { ...req, requestId })
  })
}

export function answerPrompt(requestId: string, answer: PromptAnswer): void {
  const pending = pendingPrompts.get(requestId)
  pendingPrompts.delete(requestId)
  pending?.resolve(answer)
}

/** Cancel prompts belonging to a session that went away. */
function cancelPrompts(sessionId: string): void {
  for (const [id, p] of pendingPrompts) {
    if (p.sessionId !== sessionId) continue
    pendingPrompts.delete(id)
    p.resolve({ accept: false })
  }
}

function keyTypeOf(key: Buffer): string {
  const len = key.readUInt32BE(0)
  return key.subarray(4, 4 + len).toString('ascii')
}

function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/**
 * Connect and authenticate, resolving once logged in. Setup problems (missing key, ...)
 * throw right away. With `strict`, a rejected saved/typed password fails the login
 * instead of asking the user to type another one.
 */
function authenticate(req: LoginRequest, strict: boolean): Promise<void> {
  const host = store.getHost(req.hostId)
  if (!host) throw new Error('Host not found')

  const secret = req.secret ?? store.getSecret(host.id)

  const hostPort = `${host.host}:${host.port}`
  // Set when the user dismisses a host-key or device prompt.
  let cancelled = false
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    algorithms: ALGORITHMS,
    hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
      const keyType = keyTypeOf(key)
      const fingerprint = fingerprintOf(key)
      const known = store.getKnownHost(hostPort)
      if (known?.fingerprint === fingerprint) return verify(true)
      ask({
        kind: 'hostkey',
        sessionId: req.sessionId,
        host: hostPort,
        keyType,
        fingerprint,
        changed: !!known,
        previous: known?.fingerprint
      }).then((a) => {
        const ok = 'accept' in a && a.accept
        if (ok) store.setKnownHost(hostPort, { keyType, fingerprint, addedAt: new Date().toISOString() })
        else cancelled = true
        verify(ok)
      })
    }) as ConnectConfig['hostVerifier']
  }

  // Build the list of auth attempts up front so key problems surface as clear errors.
  const username = host.username
  // Start with "none" (like OpenSSH) so the server tells us which methods it
  // allows before we spend the saved password on one it doesn't support.
  const attempts: AnyAuthMethod[] = [{ type: 'none', username }]
  if (host.auth === 'password') {
    if (secret) attempts.push({ type: 'password', username, password: secret })
  } else if (host.auth === 'key') {
    if (!host.keyPath) throw new Error('No private key file set for this host')
    const keyFile = expandHome(host.keyPath)
    let keyData: Buffer
    try {
      keyData = fs.readFileSync(keyFile)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      throw new Error(
        code === 'ENOENT' ? `Private key file not found: ${host.keyPath}` : `Cannot read ${host.keyPath}: ${code}`
      )
    }
    const parsed = utils.parseKey(keyData, secret)
    if (parsed instanceof Error) {
      throw new Error(
        /passphrase/i.test(parsed.message)
          ? `${host.keyPath} is encrypted: save its passphrase in the host settings`
          : `Cannot read ${host.keyPath}: ${parsed.message}`
      )
    }
    attempts.push({ type: 'publickey', username, key: Array.isArray(parsed) ? parsed[0] : parsed })
  } else {
    const agent = process.env.SSH_AUTH_SOCK
    if (!agent) throw new Error('SSH agent not available (SSH_AUTH_SOCK is not set)')
    attempts.push({ type: 'agent', username, agent })
  }

  const client = new Client()
  const session: Session = { client, host }
  sessions.set(req.sessionId, session)
  status(req.sessionId, { state: 'connecting' })

  // Many network devices only offer keyboard-interactive. Answer it with the
  // saved password if that hasn't been tried yet; otherwise (wrong password,
  // OTP, token, ...) ask the user. Up to 3 tries, like OpenSSH.
  let secretTried = false
  let passwordRejected = false
  // True once the user typed answers by hand, i.e. the stored/typed secret alone wasn't enough.
  let manualAnswers = false
  const keyboard: KeyboardInteractiveAuthMethod = {
    type: 'keyboard-interactive',
    username,
    prompt: (name, instructions, _lang, prompts, finish) => {
      if (prompts.length === 0) return finish([])
      if (host.auth === 'password' && secret && prompts.every((p) => !p.echo)) {
        if (!secretTried) {
          secretTried = true
          return finish(prompts.map(() => secret))
        }
        if (strict) {
          // Asked for the password again: it was wrong. One try only, then let the user fix it.
          passwordRejected = true
          client.end()
          return
        }
      }
      ask({
        kind: 'keyboard',
        sessionId: req.sessionId,
        title: name || `${host.username}@${host.host}`,
        instructions,
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo }))
      }).then((a) => {
        const answers = 'answers' in a ? a.answers : null
        if (!answers) {
          // Close instead of sending an empty reply: devices count that as a failed login.
          cancelled = true
          client.end()
          return
        }
        manualAnswers = true
        finish(answers)
      })
    }
  }
  attempts.push(keyboard, keyboard, keyboard)

  config.authHandler = (methodsLeft, _partial, next) => {
    while (attempts.length && !cancelled) {
      const m = attempts.shift()!
      // Agent keys are offered as "publickey" on the wire.
      const wire = m.type === 'agent' ? 'publickey' : m.type
      if (methodsLeft && !methodsLeft.includes(wire)) continue
      if (m.type === 'password') secretTried = true
      return next(m)
    }
    return next(false as unknown as AnyAuthMethod)
  }

  // Remember whether this is old gear, for the "legacy" badge.
  // Send each keystroke at once, like OpenSSH does for interactive sessions. With Nagle on,
  // a key typed while the previous one is unacknowledged waits for the device's (often
  // delayed) ACK, so fast typing stutters.
  client.on('connect', () => client.setNoDelay(true))
  client.on('handshake', (negotiated) => store.setLegacy(host.id, usesLegacy(negotiated)))

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }

    client.on('ready', () => {
      settled = true
      store.touchHost(host.id)
      if (req.secret && req.saveSecret && !manualAnswers) {
        try {
          store.setSecret(host.id, req.secret)
        } catch (err) {
          // Keychain unavailable: log in anyway, just don't keep the password (never in plain text).
          console.warn('Password not saved:', (err as Error).message)
        }
      }
      resolve()
    })

    client.on('error', (err) => {
      const level = (err as Error & { level?: string }).level
      const message = describeError(err)
      fail(
        cancelled
          ? LOGIN_CANCELLED
          : strict && level === 'client-authentication' && host.auth === 'password'
            ? AUTH_FAILED
            : message
      )
      status(req.sessionId, { state: 'closed', error: message })
    })

    client.on('close', () => {
      fail(passwordRejected ? AUTH_FAILED : cancelled ? LOGIN_CANCELLED : 'Connection closed')
      cancelPrompts(req.sessionId)
      const s = sessions.get(req.sessionId)
      clearTimeout(s?.unclaimed)
      s?.log?.end()
      sessions.delete(req.sessionId)
      status(req.sessionId, { state: 'closed' })
    })

    client.connect(config)
  })
}

// macOS blocks LAN connections from apps without Local Network permission and reports
// it as "no route to host", even when the host answers ping from Terminal.
function describeError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EHOSTUNREACH' && process.platform === 'darwin') {
    return `${err.message}. If this host is on your local network, allow Termflow in System Settings › Privacy & Security › Local Network, then try again.`
  }
  return err.message
}

function openShell(sessionId: string, session: Session, rows: number, cols: number): void {
  const { client, host } = session
  client.shell({ term: 'xterm-256color', rows, cols }, (err, stream) => {
    if (err) {
      status(sessionId, { state: 'closed', error: err.message })
      client.end()
      return
    }
    session.stream = stream
    if (host.logSession) session.log = openLog('ssh', host.name || host.host)
    const onData = (chunk: Buffer): void => {
      data(sessionId, chunk)
      session.log?.write(chunk)
    }
    stream.on('data', onData)
    stream.stderr.on('data', onData)
    stream.on('close', () => client.end())
    status(sessionId, { state: 'ready', logFile: session.log?.file })
  })
}

/** Log in without opening a shell, so a wrong password is caught before a tab opens. */
export async function login(req: LoginRequest): Promise<void> {
  await authenticate(req, true)
  const session = sessions.get(req.sessionId)
  // Hang up if no tab claims the session (e.g. the window went away).
  if (session) session.unclaimed = setTimeout(() => session.client.end(), 30000)
}

export async function connect(req: ConnectRequest): Promise<void> {
  const pre = sessions.get(req.sessionId)
  if (pre?.unclaimed) {
    clearTimeout(pre.unclaimed)
    pre.unclaimed = undefined
    openShell(req.sessionId, pre, req.rows, req.cols)
    return
  }
  // Errors after this point arrive as session status.
  authenticate(req, false).then(
    () => {
      const session = sessions.get(req.sessionId)
      if (session) openShell(req.sessionId, session, req.rows, req.cols)
    },
    () => {}
  )
}

export function write(sessionId: string, data: string): void {
  sessions.get(sessionId)?.stream?.write(data)
}

export function resize(sessionId: string, rows: number, cols: number): void {
  sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
}

export function close(sessionId: string): void {
  cancelPrompts(sessionId)
  sessions.get(sessionId)?.client.end()
}

export function closeAll(): void {
  for (const s of sessions.values()) s.client.end()
  for (const p of pendingPrompts.values()) p.resolve({ accept: false })
  pendingPrompts.clear()
}
