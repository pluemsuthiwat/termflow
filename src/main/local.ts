import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
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

/** resources/netshim: network tools that report real MAC addresses (see libexec/launchd-run). */
function netshimDir(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'netshim')
    : path.join(app.getAppPath(), 'resources', 'netshim')
  return fs.existsSync(path.join(dir, 'zsh', '.zshrc')) ? dir : undefined
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
  // zsh reads the app's startup files, which run the user's own and then put the
  // network tools first in PATH. Other shells start as usual.
  const netshim = netshimDir()
  if (netshim && path.basename(env.SHELL) === 'zsh') {
    env.TERMFLOW_USER_ZDOTDIR = env.ZDOTDIR || os.homedir()
    if (env.ZDOTDIR) env.TERMFLOW_ZDOTDIR_SET = '1'
    env.TERMFLOW_NETSHIM_BIN = path.join(netshim, 'bin')
    env.ZDOTDIR = path.join(netshim, 'zsh')
  }
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

/** Open shells, e.g. "Terminal (vim)": what runs in the foreground right now. */
export function active(): string[] {
  return [...sessions.values()].map((p) => `Terminal (${path.basename(p.process || shellPath())})`)
}

export function closeAll(): void {
  for (const p of sessions.values()) p.kill()
}
