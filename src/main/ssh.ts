import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Client,
  utils,
  type AnyAuthMethod,
  type ClientChannel,
  type ConnectConfig,
  type KeyboardInteractiveAuthMethod
} from 'ssh2'
import type { ConnectRequest, PromptAnswer, PromptRequest } from '../shared/types'
import { data, openLog, send, status, type SessionLog } from './session-io'
import * as store from './store'

// Extra algorithms for old IOS / ASA / switch firmware. Regexes only match
// algorithms ssh2 actually supports, so an unavailable one never throws.
const LEGACY_ALGORITHMS: ConnectConfig['algorithms'] = {
  kex: { append: [/^diffie-hellman-group-exchange-sha1$/, /^diffie-hellman-group14-sha1$/, /^diffie-hellman-group1-sha1$/] },
  serverHostKey: { append: [/^ssh-dss$/] },
  cipher: { append: [/^aes(128|192|256)-cbc$/, /^3des-cbc$/] },
  hmac: { append: [/^hmac-sha1-96$/, /^hmac-md5$/, /^hmac-md5-96$/] }
} as unknown as ConnectConfig['algorithms']

interface Session {
  client: Client
  stream?: ClientChannel
  log?: SessionLog
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

export async function connect(req: ConnectRequest): Promise<void> {
  const host = store.getHost(req.hostId)
  if (!host) throw new Error('Host not found')

  const secret = req.secret ?? store.getSecret(host.id)

  const hostPort = `${host.host}:${host.port}`
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
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
        verify(ok)
      })
    }) as ConnectConfig['hostVerifier']
  }
  if (host.legacy) config.algorithms = LEGACY_ALGORITHMS

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
  const session: Session = { client }
  sessions.set(req.sessionId, session)
  status(req.sessionId, { state: 'connecting' })

  // Many network devices only offer keyboard-interactive. Answer it with the
  // saved password if that hasn't been tried yet; otherwise (wrong password,
  // OTP, token, ...) ask the user. Up to 3 tries, like OpenSSH.
  let secretTried = false
  let cancelled = false
  // True once the user typed answers by hand, i.e. the stored/typed secret alone wasn't enough.
  let manualAnswers = false
  const keyboard: KeyboardInteractiveAuthMethod = {
    type: 'keyboard-interactive',
    username,
    prompt: (name, instructions, _lang, prompts, finish) => {
      if (prompts.length === 0) return finish([])
      if (host.auth === 'password' && secret && !secretTried && prompts.every((p) => !p.echo)) {
        secretTried = true
        return finish(prompts.map(() => secret))
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

  client.on('ready', () => {
    store.touchHost(host.id)
    if (req.secret && req.saveSecret && !manualAnswers) store.setSecret(host.id, req.secret)
    client.shell({ term: 'xterm-256color', rows: req.rows, cols: req.cols }, (err, stream) => {
      if (err) {
        status(req.sessionId, { state: 'closed', error: err.message })
        client.end()
        return
      }
      session.stream = stream
      if (host.logSession) session.log = openLog(host.name || host.host)
      const onData = (chunk: Buffer): void => {
        data(req.sessionId, chunk)
        session.log?.write(chunk)
      }
      stream.on('data', onData)
      stream.stderr.on('data', onData)
      stream.on('close', () => client.end())
      status(req.sessionId, { state: 'ready', logFile: session.log?.file })
    })
  })

  client.on('error', (err) => {
    status(req.sessionId, { state: 'closed', error: err.message })
  })

  client.on('close', () => {
    cancelPrompts(req.sessionId)
    const s = sessions.get(req.sessionId)
    s?.log?.end()
    sessions.delete(req.sessionId)
    status(req.sessionId, { state: 'closed' })
  })

  client.connect(config)
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
