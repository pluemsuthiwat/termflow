import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ShellApi } from '../shared/types'

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: ShellApi = {
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (input) => ipcRenderer.invoke('hosts:save', input),
  deleteHost: (id) => ipcRenderer.invoke('hosts:delete', id),
  listGroups: () => ipcRenderer.invoke('groups:list'),
  createGroup: (name, parent) => ipcRenderer.invoke('groups:create', name, parent),
  renameGroup: (path, newName) => ipcRenderer.invoke('groups:rename', path, newName),
  deleteGroup: (name) => ipcRenderer.invoke('groups:delete', name),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  openLogsDir: () => ipcRenderer.invoke('app:openLogsDir'),
  revealLog: (file) => ipcRenderer.invoke('app:revealLog', file),
  dataDir: () => ipcRenderer.invoke('app:dataDir'),
  version: () => ipcRenderer.invoke('app:version'),
  pickKeyFile: () => ipcRenderer.invoke('app:pickKeyFile'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  openReleasePage: () => ipcRenderer.invoke('update:openRelease'),
  openRepoPage: () => ipcRenderer.invoke('app:openRepo'),
  onUpdateAvailable: (cb) => listen('update:available', cb),
  listSerialPorts: () => ipcRenderer.invoke('serial:list'),
  onSerialPorts: (cb) => listen('serial:ports', cb),
  sendBreak: (id) => ipcRenderer.send('serial:break', id),

  login: (req) => ipcRenderer.invoke('ssh:login', req),
  connect: (req) => ipcRenderer.invoke('ssh:connect', req),
  write: (id, data) => ipcRenderer.send('ssh:write', id, data),
  resize: (id, rows, cols) => ipcRenderer.send('ssh:resize', id, rows, cols),
  close: (id) => ipcRenderer.send('ssh:close', id),

  onData: (cb) => listen('ssh:data', cb),
  onStatus: (cb) => listen('ssh:status', cb),
  onPrompt: (cb) => listen('ssh:prompt', cb),
  answerPrompt: (requestId, answer) => ipcRenderer.send('ssh:answer', requestId, answer),
  onMenu: (cb) => listen('menu', cb)
}

contextBridge.exposeInMainWorld('shell', api)
