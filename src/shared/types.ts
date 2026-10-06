export type AuthMethod = 'password' | 'key' | 'agent'
export type HostKind = 'ssh' | 'serial'

export interface SerialSettings {
  /** Callout device, e.g. /dev/cu.usbserial-A10K. */
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'even' | 'odd'
  stopBits: 1 | 2
  flowControl: 'none' | 'rtscts' | 'xon'
  /** USB identity, used to find the cable again if macOS renames the path. */
  serialNumber?: string
  vendorId?: string
  productId?: string
}

export const DEFAULT_SERIAL: Omit<SerialSettings, 'path'> = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none'
}

/** A serial port found on this Mac. */
export interface SerialPortInfo {
  path: string
  /** Short display name, e.g. "cu.usbserial-A10K". */
  name: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
}

export interface Host {
  id: string
  /** Missing on hosts saved before serial support: treat as 'ssh'. */
  kind?: HostKind
  /** Set when kind === 'serial'. SSH fields are then unused. */
  serial?: SerialSettings
  name: string
  host: string
  port: number
  username: string
  group: string
  auth: AuthMethod
  keyPath?: string
  /** Detected on connect: the device only agreed on old KEX/cipher/MAC/host-key algorithms. */
  legacy: boolean
  /** Write a plain-text session log to the logs directory. */
  logSession: boolean
  /** ISO time of the last successful login. */
  lastConnectedAt?: string
}

/** Host as seen by the renderer: never contains secrets, only whether one is saved. */
export interface HostView extends Host {
  hasSecret: boolean
}

export interface HostInput extends Omit<Host, 'id'> {
  id?: string
  /** undefined = keep existing secret, '' = delete, otherwise replace. */
  secret?: string
}

export interface ConnectRequest {
  sessionId: string
  /** Saved host id, or "port:<path>" for a quick serial session. */
  hostId: string
  /** Quick serial session without a saved host. */
  serial?: SerialSettings
  /** One-off password / passphrase entered at connect time. */
  secret?: string
  saveSecret?: boolean
  rows: number
  cols: number
}

/** Log in to a saved SSH host before its tab opens. */
export type LoginRequest = Pick<ConnectRequest, 'sessionId' | 'hostId' | 'secret' | 'saveSecret'>

/** Login error when the device rejected the password. */
export const AUTH_FAILED = 'Wrong username or password'
/** Login error when the user dismissed a host-key or device prompt. */
export const LOGIN_CANCELLED = 'Login cancelled'

export type PromptRequest =
  | {
      kind: 'hostkey'
      requestId: string
      sessionId: string
      host: string
      keyType: string
      fingerprint: string
      changed: boolean
      previous?: string
    }
  | {
      kind: 'keyboard'
      requestId: string
      sessionId: string
      title: string
      instructions: string
      prompts: { prompt: string; echo: boolean }[]
    }

export type PromptAnswer = { accept: boolean } | { answers: string[] | null }

export type SessionStatus =
  | { state: 'connecting' }
  | { state: 'ready'; logFile?: string }
  | { state: 'closed'; error?: string }

export interface ShellApi {
  listHosts(): Promise<HostView[]>
  saveHost(input: HostInput): Promise<HostView>
  deleteHost(id: string): Promise<void>
  listGroups(): Promise<string[]>
  /** Group paths, e.g. "Site A/Building 1". */
  createGroup(name: string, parent?: string): Promise<void>
  /** Renames the last path segment; subgroups and hosts move along. */
  renameGroup(path: string, newName: string): Promise<void>
  /** Hosts and subgroups move up one level. */
  deleteGroup(path: string): Promise<void>
  openDataDir(): Promise<void>
  /** Open the session logs folder in Finder. */
  openLogsDir(): Promise<void>
  /** Show one log file selected in Finder. */
  revealLog(file: string): Promise<void>
  dataDir(): Promise<string>
  /** App version from package.json, e.g. "1.0.0". */
  version(): Promise<string>
  pickKeyFile(): Promise<string | null>

  listSerialPorts(): Promise<SerialPortInfo[]>
  /** Fires when ports appear or disappear; `added` excludes ports present at startup. */
  onSerialPorts(cb: (ports: SerialPortInfo[], added: SerialPortInfo[]) => void): () => void
  sendBreak(sessionId: string): void

  /** Authenticate without opening a shell; a tab then calls connect() with the same sessionId. */
  login(req: LoginRequest): Promise<void>
  connect(req: ConnectRequest): Promise<void>
  write(sessionId: string, data: string): void
  resize(sessionId: string, rows: number, cols: number): void
  close(sessionId: string): void

  onData(cb: (sessionId: string, data: Uint8Array) => void): () => void
  onStatus(cb: (sessionId: string, status: SessionStatus) => void): () => void
  onPrompt(cb: (req: PromptRequest) => void): () => void
  answerPrompt(requestId: string, answer: PromptAnswer): void
  onMenu(cb: (action: 'closeTab' | 'selectTab' | 'newHost' | 'home' | 'back' | 'search' | 'sendBreak' | 'toggleSidebar', arg?: number) => void): () => void
}
