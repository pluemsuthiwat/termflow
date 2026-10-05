import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectRequest, HostInput, PromptAnswer } from '../shared/types'
import * as serial from './serial'
import { attach } from './session-io'
import * as ssh from './ssh'
import * as store from './store'

// Lets tests (or a second profile) use a separate data directory.
if (process.env.TERMFLOW_DATA_DIR) app.setPath('userData', process.env.TERMFLOW_DATA_DIR)

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
      sandbox: true
    }
  })
  attach(win.webContents)
  // Start watching for console cables once the page can receive the first scan.
  win.webContents.on('did-finish-load', () => serial.startWatching())

  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('hosts:list', () => store.listHostViews())
ipcMain.handle('hosts:save', (_e, input: HostInput) => store.saveHost(input))
ipcMain.handle('hosts:delete', (_e, id: string) => store.deleteHost(id))
ipcMain.handle('groups:list', () => store.listGroups())
ipcMain.handle('groups:create', (_e, name: string, parent?: string) => store.createGroup(name, parent))
ipcMain.handle('groups:rename', (_e, path: string, newName: string) => store.renameGroup(path, newName))
ipcMain.handle('groups:delete', (_e, name: string) => store.deleteGroup(name))
ipcMain.handle('app:dataDir', () => store.dataDir())
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('app:openDataDir', () => shell.openPath(store.dataDir()))
ipcMain.handle('app:openLogsDir', () => {
  // The folder only exists after the first logged session.
  fs.mkdirSync(store.logsDir(), { recursive: true })
  return shell.openPath(store.logsDir())
})
ipcMain.handle('app:revealLog', (_e, file: string) => {
  // Only reveal files inside our logs folder.
  if (path.dirname(path.resolve(file)) === path.resolve(store.logsDir())) shell.showItemInFolder(file)
})
ipcMain.handle('app:pickKeyFile', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose private key',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles']
  })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0].replace(os.homedir(), '~')
})

// Sessions are SSH or serial; serial ones are quick port sessions or saved serial hosts.
const isSerialRequest = (req: ConnectRequest): boolean =>
  !!req.serial || store.getHost(req.hostId)?.kind === 'serial'

ipcMain.handle('ssh:connect', (_e, req: ConnectRequest) => (isSerialRequest(req) ? serial.connect(req) : ssh.connect(req)))
ipcMain.on('ssh:write', (_e, id: string, data: string) => (serial.has(id) ? serial.write(id, data) : ssh.write(id, data)))
ipcMain.on('ssh:resize', (_e, id: string, rows: number, cols: number) => ssh.resize(id, rows, cols))
ipcMain.on('ssh:close', (_e, id: string) => {
  ssh.close(id)
  serial.close(id)
})
ipcMain.handle('serial:list', () => serial.listPorts())
ipcMain.on('serial:break', (_e, id: string) => void serial.sendBreak(id))
ipcMain.on('ssh:answer', (_e, requestId: string, answer: PromptAnswer) => ssh.answerPrompt(requestId, answer))

function buildMenu(): void {
  const toRenderer = (action: string, arg?: number) => () =>
    (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send('menu', action, arg)
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Shell',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+0', click: toRenderer('home') },
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
