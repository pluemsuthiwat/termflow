import os from 'node:os'
import * as pty from 'node-pty'
import type { ConnectRequest } from '../shared/types'
import { data, status } from './session-io'

// Local shell sessions: the user's login shell on this Mac, in a pty.
// The page only asks for "a local shell"; which program runs, where and with what
// environment is decided here, never taken from the page.

const sessions = new Map<string, pty.IPty>()

/** The user's login shell; tests pin it with TERMFLOW_LOCAL_SHELL. */
function shellPath(): string {
  return process.env.TERMFLOW_LOCAL_SHELL || os.userInfo().shell || process.env.SHELL || '/bin/zsh'
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Opened from Finder the app gets no locale: without one, UTF-8 text (e.g. Thai) breaks.
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Termflow'
  env.SHELL = shellPath()
  // Electron's own variables are not for the shell.
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_')) delete env[k]
  return env
}

export function connect(req: ConnectRequest): void {
  status(req.sessionId, { state: 'connecting' })
  let p: pty.IPty
  try {
    p = pty.spawn(shellPath(), ['-l'], {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: os.homedir(),
      env: shellEnv(),
      // UTF-8 mode also sets the pty's iutf8 flag: backspace then erases a whole Thai character, not one byte.
      encoding: 'utf8'
    })
  } catch (err) {
    const error = `Could not start ${shellPath()}: ${(err as Error).message}`
    status(req.sessionId, { state: 'closed', error })
    throw new Error(error)
  }
  sessions.set(req.sessionId, p)
  p.onData((text) => data(req.sessionId, Buffer.from(text, 'utf8')))
  p.onExit(({ exitCode, signal }) => {
    sessions.delete(req.sessionId)
    const error = exitCode ? `Shell exited with code ${exitCode}` : signal ? `Shell ended by signal ${signal}` : undefined
    status(req.sessionId, { state: 'closed', error })
  })
  status(req.sessionId, { state: 'ready' })
}

export const has = (sessionId: string): boolean => sessions.has(sessionId)

export function write(sessionId: string, text: string): void {
  sessions.get(sessionId)?.write(text)
}

export function resize(sessionId: string, rows: number, cols: number): void {
  if (rows > 0 && cols > 0) sessions.get(sessionId)?.resize(cols, rows)
}

export function close(sessionId: string): void {
  sessions.get(sessionId)?.kill()
}

export function closeAll(): void {
  for (const p of sessions.values()) p.kill()
}
