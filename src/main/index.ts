import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConnectRequest, HostInput, LoginRequest, PromptAnswer } from '../shared/types'
import * as serial from './serial'
import { attach } from './session-io'
import * as ssh from './ssh'
import * as store from './store'

// Lets tests (or a second profile) use a separate data directory.
if (process.env.TERMFLOW_DATA_DIR) app.setPath('userData', process.env.TERMFLOW_DATA_DIR)

// A packaged app refuses remote debugging: it would let any local program drive the
// page and its API (saved logins). Only test packages (npm run dist:test) allow it.
function isTestPackage(): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).termflowTestBuild === true
  } catch {
    return false
  }
}
if (
  app.isPackaged &&
  (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe')) &&
  !isTestPackage()
) {
  console.error('Remote debugging is disabled in Termflow.')
  app.exit(1)
}

// ---- web content lockdown ----
// The preload gives the page access to saved hosts and sessions, so only our own
// page may ever load in a window, and only it may talk to the main process.

// The dev server URL is honoured only in development: a packaged app always loads its own files.
const DEV_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const APP_URL = DEV_URL || pathToFileURL(path.join(__dirname, '../renderer/index.html')).href

/** Same document as the app page (query and #hash ignored). */
function isAppUrl(url: string): boolean {
  try {
    const a = new URL(url)
    const b = new URL(APP_URL)
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
  } catch {
    return false
  }
}

/** Open http(s) links in the browser; nothing else (file:, smb:, custom app schemes...). */
function openExternalSafely(url: string): void {
  try {
    if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // not a URL
  }
}

app.on('web-contents-created', (_e, contents) => {
  // Links, dropped files, redirects: never replace the app page.
  const stay = (e: Electron.Event, url: string): void => {
    if (!isAppUrl(url)) e.preventDefault()
  }
  contents.on('will-navigate', stay)
  contents.on('will-redirect', stay)
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
})

/** Only the app page's top frame may call into the main process. */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  return !!frame && frame.parent === null && isAppUrl(frame.url)
}

function handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Request refused')
    return fn(...(args as A))
  })
}

function on<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (trusted(e)) fn(...(args as A))
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Termflow',
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Inspecting the page would expose the same API; development builds only.
      devTools: !app.isPackaged
    }
  })
  attach(win.webContents)
  // Start watching for console cables once the page can receive the first scan.
  win.webContents.on('did-finish-load', () => serial.startWatching())

  win.loadURL(APP_URL)
}

handle('hosts:list', () => store.listHostViews())
handle('hosts:save', (input: HostInput) => store.saveHost(input))
handle('hosts:delete', (id: string) => store.deleteHost(id))
handle('groups:list', () => store.listGroups())
handle('groups:create', (name: string, parent?: string) => store.createGroup(name, parent))
handle('groups:rename', (path: string, newName: string) => store.renameGroup(path, newName))
handle('groups:delete', (name: string) => store.deleteGroup(name))
handle('app:dataDir', () => store.dataDir())
handle('app:version', () => app.getVersion())
handle('app:openDataDir', () => shell.openPath(store.dataDir()))
handle('app:openLogsDir', () => {
  // The folder only exists after the first logged session.
  store.ensurePrivateDir(store.logsDir())
  return shell.openPath(store.logsDir())
})
handle('app:revealLog', (file: string) => {
  // Only reveal files inside our logs folder.
  if (path.dirname(path.resolve(file)) === path.resolve(store.logsDir())) shell.showItemInFolder(file)
})
handle('app:pickKeyFile', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose private key',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles']
  })
  if (res.canceled || !res.filePaths[0]) return null
  const picked = res.filePaths[0]
  return picked.startsWith(os.homedir() + path.sep) ? '~' + picked.slice(os.homedir().length) : picked
})

// Sessions are SSH or serial; serial ones are quick port sessions or saved serial hosts.
const isSerialRequest = (req: ConnectRequest): boolean =>
  !!req.serial || store.getHost(req.hostId)?.kind === 'serial'

handle('ssh:login', (req: LoginRequest) => ssh.login(req))
handle('ssh:connect', (req: ConnectRequest) => (isSerialRequest(req) ? serial.connect(req) : ssh.connect(req)))
on('ssh:write', (id: string, data: string) => (serial.has(id) ? serial.write(id, data) : ssh.write(id, data)))
on('ssh:resize', (id: string, rows: number, cols: number) => ssh.resize(id, rows, cols))
on('ssh:close', (id: string) => {
  ssh.close(id)
  serial.close(id)
})
handle('serial:list', () => serial.listPorts())
on('serial:break', (id: string) => void serial.sendBreak(id))
on('ssh:answer', (requestId: string, answer: PromptAnswer) => ssh.answerPrompt(requestId, answer))

function buildMenu(): void {
  const toRenderer = (action: string, arg?: number) => () =>
    (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send('menu', action, arg)
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Shell',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+0', click: toRenderer('home') },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: toRenderer('back') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: toRenderer('toggleSidebar') },
        { label: 'New Host…', accelerator: 'CmdOrCtrl+N', click: toRenderer('newHost') },
        { label: 'Search Hosts', accelerator: 'CmdOrCtrl+K', click: toRenderer('search') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: toRenderer('closeTab') },
        { label: 'Send Break', accelerator: 'CmdOrCtrl+B', click: toRenderer('sendBreak') },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: toRenderer('selectTab', i)
        }))
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  // Folders made by older versions (or by hand) were world-readable: tighten on every start.
  store.ensurePrivateDir(store.dataDir())
  if (fs.existsSync(store.logsDir())) store.ensurePrivateDir(store.logsDir())
  // The app needs no web permissions (camera, notifications, geolocation, ...).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.setAboutPanelOptions({
    applicationName: 'Termflow',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'SSH client for network engineers'
  })
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ssh.closeAll()
  serial.closeAll()
  app.quit()
})
