import { useEffect, useRef, useState, type ReactNode } from 'react'
import { portName } from '../../shared/hosts'
import { IconFolder } from './icons'
import { fadeClass, useScrollEdges } from './scrollEdges'
import {
  DEFAULT_SERIAL,
  type HostInput,
  type HostView,
  type PromptAnswer,
  type PromptRequest,
  type SerialPortInfo,
  type SerialSettings
} from '../../shared/types'

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(ref, 'y')
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
      onKeyDown={(e) => e.key === 'Escape' && onClose?.()}
    >
      <div className={`modal scroll-fade scroll-fade-y${fadeClass(edges)}`} role="dialog" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400]

export function HostForm({
  initial,
  hasSecret,
  groups,
  serialPorts,
  onSave,
  onCancel
}: {
  initial: HostInput
  hasSecret: boolean
  groups: string[]
  serialPorts: SerialPortInfo[]
  onSave: (h: HostInput, connect: boolean) => void
  onCancel: () => void
}) {
  const [h, setH] = useState<HostInput>({ ...initial, kind: initial.kind ?? 'ssh', secret: undefined })
  const [serial, setSerial] = useState<SerialSettings>(
    initial.serial ?? { ...DEFAULT_SERIAL, path: serialPorts[0]?.path ?? '' }
  )
  const [error, setError] = useState('')
  const [forget, setForget] = useState(false)
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setH((p) => ({ ...p, [k]: v }))
  const setS = <K extends keyof SerialSettings>(k: K, v: SerialSettings[K]): void => setSerial((p) => ({ ...p, [k]: v }))
  const isSerialHost = h.kind === 'serial'

  // Saved path that is not plugged in right now still shows in the list.
  const portOptions = serialPorts.some((p) => p.path === serial.path) || !serial.path
    ? serialPorts
    : [...serialPorts, { path: serial.path, name: `${portName(serial.path)} (not connected)` }]

  const pickPort = (path: string) => {
    const p = serialPorts.find((x) => x.path === path)
    // Remember the cable's USB identity so it can be found again if macOS renames it.
    setSerial((s) => ({ ...s, path, serialNumber: p?.serialNumber, vendorId: p?.vendorId, productId: p?.productId }))
  }

  const submit = (connect: boolean): void => {
    const group = h.group.trim()
    if (isSerialHost) {
      const path = serial.path.trim()
      if (!path) return setError('Choose a console port')
      if (!(serial.baudRate > 0)) return setError('Baud rate must be a positive number')
      return onSave(
        {
          ...h,
          secret: undefined,
          group,
          name: h.name.trim() || portName(path),
          host: '',
          username: '',
          auth: 'password',
          legacy: false,
          serial: { ...serial, path, baudRate: Number(serial.baudRate) }
        },
        connect
      )
    }
    if (!h.host.trim()) return setError('Host / IP is required')
    if (!h.username.trim()) return setError('Username is required')
    if (h.auth === 'key' && !h.keyPath?.trim()) return setError('Choose a private key file')
    const secret = forget ? '' : h.secret || undefined
    onSave(
      { ...h, serial: undefined, secret, group, host: h.host.trim(), username: h.username.trim(), name: h.name.trim() || h.host.trim() },
      connect
    )
  }

  const secretLabel = h.auth === 'key' ? 'Key passphrase' : 'Password'

  return (
    <Modal
      title={isSerialHost ? (initial.id ? 'Edit console host' : 'Save console as host') : initial.id ? 'Edit host' : 'New host'}
      onClose={onCancel}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          // Enter = Save & connect.
          submit(true)
        }}
      >
        <div className="row">
          <label className="grow">
            Label
            <input
              value={h.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={isSerialHost ? 'core-sw-01 console' : 'core-sw-01'}
              autoFocus
            />
          </label>
          <label className="grow">
            Group
            <input
              value={h.group}
              onChange={(e) => set('group', e.target.value)}
              placeholder="Default — use / for subgroups"
              list="group-options"
            />
            <datalist id="group-options">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        </div>

        {isSerialHost ? (
          <>
            <label>
              Console port
              <select value={serial.path} onChange={(e) => pickPort(e.target.value)}>
                {portOptions.length === 0 && <option value="">No console cable detected</option>}
                {portOptions.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                    {p.manufacturer ? ` — ${p.manufacturer}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <label className="grow">
                Baud rate
                <input
                  type="number"
                  min={50}
                  list="baud-options"
                  value={serial.baudRate}
                  onChange={(e) => setS('baudRate', Number(e.target.value))}
                />
                <datalist id="baud-options">
                  {BAUD_RATES.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>
              <label>
                Data bits
                <select value={serial.dataBits} onChange={(e) => setS('dataBits', Number(e.target.value) as SerialSettings['dataBits'])}>
                  {[8, 7, 6, 5].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                Parity
                <select value={serial.parity} onChange={(e) => setS('parity', e.target.value as SerialSettings['parity'])}>
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </label>
              <label>
                Stop bits
                <select value={serial.stopBits} onChange={(e) => setS('stopBits', Number(e.target.value) as SerialSettings['stopBits'])}>
                  <option>1</option>
                  <option>2</option>
                </select>
              </label>
            </div>
            <label>
              Flow control
              <select value={serial.flowControl} onChange={(e) => setS('flowControl', e.target.value as SerialSettings['flowControl'])}>
                <option value="none">None (most console ports)</option>
                <option value="rtscts">Hardware (RTS/CTS)</option>
                <option value="xon">Software (XON/XOFF)</option>
              </select>
            </label>
            <p className="muted hint">Cisco, Juniper, Aruba and most switches use 9600 8N1, no flow control.</p>
          </>
        ) : (
          <>
            <div className="row">
              <label className="grow">
                Host / IP
                <input value={h.host} onChange={(e) => set('host', e.target.value)} placeholder="10.0.0.1" spellCheck={false} />
              </label>
              <label className="port">
                Port
                <input type="number" min={1} max={65535} value={h.port} onChange={(e) => set('port', Number(e.target.value))} />
              </label>
            </div>
            <label>
              Username
              <input value={h.username} onChange={(e) => set('username', e.target.value)} spellCheck={false} />
            </label>
            {/* Password login only. Hosts saved earlier with a key or agent keep those settings. */}
            {initial.auth && initial.auth !== 'password' && initial.id && (
              <label>
                Authentication
                <select value={h.auth} onChange={(e) => set('auth', e.target.value as HostInput['auth'])}>
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                  <option value="agent">SSH agent</option>
                </select>
              </label>
            )}
            {h.auth === 'key' && (
              <label>
                Private key file
                <div className="row">
                  <input
                    className="grow"
                    value={h.keyPath ?? ''}
                    onChange={(e) => set('keyPath', e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const p = await window.shell.pickKeyFile()
                      if (p) set('keyPath', p)
                    }}
                  >
                    Browse…
                  </button>
                </div>
              </label>
            )}
            {h.auth !== 'agent' && (
              <label>
                {secretLabel} <span className="muted">(stored encrypted via macOS Keychain)</span>
                <div className="row">
                  <input
                    className="grow"
                    type="password"
                    value={h.secret ?? ''}
                    onChange={(e) => {
                      set('secret', e.target.value)
                      setForget(false)
                    }}
                    placeholder={
                      hasSecret
                        ? 'Saved — leave empty to keep'
                        : h.auth === 'key'
                          ? 'Leave empty if key has none'
                          : 'Leave empty to ask on connect'
                    }
                  />
                  {hasSecret && !forget && !h.secret && (
                    <button type="button" className="btn" onClick={() => setForget(true)} title="Forget saved secret">
                      Forget
                    </button>
                  )}
                </div>
                {forget && <span className="muted">Saved secret will be removed.</span>}
              </label>
            )}
          </>
        )}
        <div className="log-row">
          <label className="check">
            <input type="checkbox" checked={h.logSession} onChange={(e) => set('logSession', e.target.checked)} />
            Log session to file
          </label>
          {h.logSession && (
            <button type="button" className="btn small with-icon" onClick={() => window.shell.openLogsDir()}>
              <IconFolder size={13} /> Open logs folder
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => submit(false)}>
            Save
          </button>
          <button type="submit" className="btn primary">
            Save & connect
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Strip Electron's "Error invoking remote method ..." wrapper. */
export const errorText = (err: unknown): string =>
  String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function GroupDialog({
  initial,
  parent,
  onSubmit,
  onCancel
}: {
  initial?: string
  /** Path of the group a new subgroup is created in. */
  parent?: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial ?? '')
  const [error, setError] = useState('')
  return (
    <Modal
      title={initial ? `Rename group “${initial}”` : parent ? 'New subgroup' : 'New group'}
      onClose={onCancel}
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await onSubmit(name)
          } catch (err) {
            setError(errorText(err))
          }
        }}
      >
        {parent && (
          <p className="muted">
            Inside <b className="path">{parent.split('/').join(' › ')}</b>
          </p>
        )}
        <label>
          Group name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            placeholder={parent ? 'e.g. Building 1, Floor 2' : 'e.g. Site A, Core, Firewalls'}
            autoFocus
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            {initial ? 'Rename' : 'Create group'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  onConfirm: () => Promise<void> | void
  onCancel: () => void
}) {
  const [error, setError] = useState('')
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="form">
        <p>{message}</p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              try {
                await onConfirm()
              } catch (err) {
                setError(errorText(err))
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}

const CONSOLE_BAUDS = [9600, 19200, 38400, 57600, 115200]

function loadLastConsole(): { path?: string; baudRate?: number } {
  try {
    return JSON.parse(localStorage.getItem('console.last') ?? '{}')
  } catch {
    return {}
  }
}

/** Pick a port and baud rate before opening a console session. */
export function ConsoleDialog({
  ports,
  onConnect,
  onCancel
}: {
  ports: SerialPortInfo[]
  onConnect: (port: SerialPortInfo, baudRate: number) => void
  onCancel: () => void
}) {
  const last = loadLastConsole()
  const [path, setPath] = useState(last.path && ports.some((p) => p.path === last.path) ? last.path : ports[0]?.path ?? '')
  const [baud, setBaud] = useState(String(last.baudRate ?? 9600))
  const [error, setError] = useState('')

  // Follow cables being plugged in or pulled while the dialog is open.
  const selected = ports.find((p) => p.path === path) ?? ports[0]

  const submit = () => {
    const baudRate = Number(baud)
    if (!selected) return setError('Plug in a USB console cable first')
    if (!Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4_000_000) return setError('Enter a baud rate, e.g. 9600 or 115200')
    try {
      localStorage.setItem('console.last', JSON.stringify({ path: selected.path, baudRate }))
    } catch {
      // remembering the choice is optional
    }
    onConnect(selected, baudRate)
  }

  return (
    <Modal title="Open console" onClose={onCancel}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label>
          Console port
          {ports.length ? (
            <select value={selected?.path} onChange={(e) => setPath(e.target.value)} autoFocus>
              {ports.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                  {p.manufacturer ? ` — ${p.manufacturer}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <p className="no-ports">No console cable detected</p>
          )}
        </label>
        <div className="baud-field">
          <span className="field-label">Baud rate</span>
          <div className="baud-presets" role="group" aria-label="Common baud rates">
            {CONSOLE_BAUDS.map((b) => (
              <button
                key={b}
                type="button"
                className={`chip-btn ${Number(baud) === b ? 'on' : ''}`}
                aria-pressed={Number(baud) === b}
                onClick={() => {
                  setBaud(String(b))
                  setError('')
                }}
              >
                {b}
              </button>
            ))}
          </div>
          <input
            inputMode="numeric"
            aria-label="Baud rate"
            value={baud}
            onChange={(e) => {
              setBaud(e.target.value.replace(/[^\d]/g, ''))
              setError('')
            }}
            placeholder="Or type any rate"
          />
          <span className="muted hint">8 data bits, no parity, 1 stop bit, no flow control (8N1). Most switches use 9600; many newer devices use 115200.</span>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!ports.length}>
            Connect
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PasswordDialog({
  host,
  askPassword,
  busy,
  error,
  defaultSave,
  onSubmit,
  onCancel
}: {
  host: HostView
  /** false while trying the saved password. */
  askPassword: boolean
  busy: boolean
  error?: string
  defaultSave: boolean
  /** pw is undefined when the saved password should be used. */
  onSubmit: (pw: string | undefined, save: boolean) => void
  onCancel: () => void
}) {
  const [pw, setPw] = useState('')
  const [save, setSave] = useState(defaultSave)
  const input = useRef<HTMLInputElement>(null)
  // After a failed attempt, clear the field and put the cursor back for a retry.
  useEffect(() => {
    if (busy || !error) return
    setPw('')
    input.current?.focus()
  }, [busy, error])
  const target = `${host.username}@${host.host}`
  return (
    <Modal title={askPassword ? `Password for ${target}` : `Connecting to ${target}`} onClose={onCancel}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) onSubmit(askPassword ? pw : undefined, save)
        }}
      >
        {askPassword && (
          <>
            <input
              ref={input}
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
              autoFocus
              aria-invalid={!!error}
            />
            <label className="check">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} disabled={busy} />
              Save password (encrypted via macOS Keychain)
            </label>
          </>
        )}
        {busy && <p className="muted">{askPassword ? 'Checking password…' : 'Logging in with the saved password…'}</p>}
        {error && !busy && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PromptDialog({ req, onAnswer }: { req: PromptRequest; onAnswer: (a: PromptAnswer) => void }) {
  const [answers, setAnswers] = useState<string[]>(req.kind === 'keyboard' ? req.prompts.map(() => '') : [])

  if (req.kind === 'hostkey') {
    return (
      <Modal title={req.changed ? '⚠ Host key has CHANGED' : 'Unknown host key'}>
        <div className="form">
          {req.changed ? (
            <p className="error">
              The key for <b>{req.host}</b> is different from the one saved before. This can mean the device was
              replaced or re-keyed — or that someone is intercepting the connection.
            </p>
          ) : (
            <p>
              First connection to <b>{req.host}</b>. Verify the fingerprint before trusting it.
            </p>
          )}
          <dl className="fp">
            <dt>Type</dt>
            <dd>{req.keyType}</dd>
            <dt>Fingerprint</dt>
            <dd>{req.fingerprint}</dd>
            {req.previous && (
              <>
                <dt>Previous</dt>
                <dd>{req.previous}</dd>
              </>
            )}
          </dl>
          <div className="actions">
            <button className="btn" onClick={() => onAnswer({ accept: false })} autoFocus>
              Cancel
            </button>
            <button className={`btn ${req.changed ? 'danger' : 'primary'}`} onClick={() => onAnswer({ accept: true })}>
              {req.changed ? 'Replace key & connect' : 'Trust & connect'}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={req.title}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer({ answers })
        }}
      >
        {req.instructions && <p>{req.instructions}</p>}
        {req.prompts.map((p, i) => (
          <label key={i}>
            {p.prompt}
            <input
              type={p.echo ? 'text' : 'password'}
              value={answers[i]}
              autoFocus={i === 0}
              onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </label>
        ))}
        <div className="actions">
          <button type="button" className="btn" onClick={() => onAnswer({ answers: null })}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Continue
          </button>
        </div>
      </form>
    </Modal>
  )
}
