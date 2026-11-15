import { useEffect, useRef, useState } from 'react'
import type { TftpAddress, TftpState, TftpTransfer } from '../../shared/types'
import { Modal } from './dialogs'
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconEdit,
  IconEthernet,
  IconExternal,
  IconFolder,
  IconShield,
  IconUpload,
  IconWarn,
  IconWifi
} from './icons'
import { fadeClass, useScrollEdges } from './scrollEdges'

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** "~/Termflow TFTP" rather than the full home path. */
const tildePath = (p: string, home: string): string => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p)

const folderName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** One address of this Mac; clicking copies the IP. */
function AddressCard({ a, copied, onCopy }: { a: TftpAddress; copied: boolean; onCopy: () => void }) {
  const Icon = a.kind === 'wifi' ? IconWifi : a.kind === 'vpn' ? IconShield : IconEthernet
  return (
    <button
      className={`tftp-addr ${a.kind} ${copied ? 'copied' : ''}`}
      onClick={onCopy}
      title={`Copy ${a.address}`}
      aria-label={`Copy ${a.address} (${a.label})`}
    >
      <span className="tftp-addr-icon">
        <Icon size={15} />
      </span>
      <span className="tftp-addr-text">
        <span className="tftp-addr-ip">
          {a.address}
          {a.prefix !== undefined && <small>/{a.prefix}</small>}
        </span>
        <span className="tftp-addr-label" aria-live="polite">
          {copied ? 'Copied to clipboard' : a.label !== a.name ? `${a.label} · ${a.name}` : a.label}
        </span>
      </span>
      <span className="tftp-addr-copy">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</span>
    </button>
  )
}

function TransferRow({ t }: { t: TftpTransfer }) {
  const pct = t.size ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : undefined
  const verb = t.direction === 'get' ? 'to' : 'from'
  return (
    <li className={`tftp-transfer ${t.state}`}>
      <span className={`tftp-dir ${t.direction}`} title={t.direction === 'get' ? 'Device downloaded' : 'Device uploaded'}>
        {t.direction === 'get' ? <IconUpload size={14} /> : <IconDownload size={14} />}
      </span>
      <div className="tftp-transfer-main">
        <div className="tftp-transfer-line">
          <span className="tftp-file">{t.file}</span>
          <span className="tftp-bytes">
            {t.state === 'active' && t.size ? `${sizeText(t.bytes)} / ${sizeText(t.size)}` : sizeText(t.bytes)}
          </span>
        </div>
        <div className="tftp-transfer-sub">
          {verb} {t.peer}
          {t.state === 'done' && ' · done'}
          {t.state === 'failed' && <span className="tftp-error"> · {t.error || 'failed'}</span>}
        </div>
        {t.state === 'active' && (
          <div className={`tftp-progress ${pct === undefined ? 'unknown' : ''}`}>
            <span style={{ width: pct === undefined ? undefined : `${pct}%` }} />
          </div>
        )}
      </div>
    </li>
  )
}

export function TftpDialog({ state, onChange, onClose }: { state: TftpState; onChange: (s: TftpState) => void; onClose: () => void }) {
  const listRef = useRef<HTMLUListElement>(null)
  const edges = useScrollEdges(listRef, 'y')
  // The address last copied: marked "Copied" for a moment, and used in the example from then on.
  const [copied, setCopied] = useState<string>()
  const [picked, setPicked] = useState<string>()
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copy = (address: string) => {
    void window.shell.copyText(address)
    setCopied(address)
    setPicked(address)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(undefined), 1500)
  }
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  // Addresses change as adapters are plugged in and configured: keep them current while open.
  useEffect(() => {
    const refresh = () => void window.shell.tftpState().then(onChange)
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [onChange])
  return (
    <Modal title="TFTP server" onClose={onClose} wide>
      <div className="tftp">
        <section className={`tftp-status ${state.running ? 'on' : ''}`} aria-live="polite">
          <span className={`status-dot ${state.running ? 'live' : ''}`} />
          <div className="tftp-status-text">
            <b>{state.running ? `Running on port ${state.port}` : 'Stopped'}</b>
            <span>
              {state.running
                ? 'Devices on your network can read files from the folder and upload new ones to it.'
                : 'Start it to let switches and routers copy files to and from this Mac.'}
            </span>
          </div>
          {state.running ? (
            <button className="btn" onClick={() => window.shell.tftpStop().then(onChange)}>
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={() => window.shell.tftpStart().then(onChange)} autoFocus>
              Start
            </button>
          )}
        </section>

        {state.error && (
          <div className="tftp-alert" role="alert">
            <IconWarn size={15} />
            <div>
              <div>{state.error}</div>
              {state.builtinBlocking && (
                <div className="tftp-alert-actions">
                  <button className="btn" onClick={() => window.shell.tftpDisableBuiltin().then(onChange)}>
                    Turn off macOS TFTP…
                  </button>
                  <span className="muted">Asks for your administrator password.</span>
                </div>
              )}
            </div>
          </div>
        )}

        <section className="tftp-folder" aria-label="TFTP folder">
          <span className="tftp-folder-icon">
            <IconFolder size={18} />
          </span>
          <div className="tftp-folder-text">
            <b>{folderName(state.root)}</b>
            <span className="tftp-path" title={state.root}>
              {tildePath(state.root, state.home)}
            </span>
          </div>
          <div className="tftp-folder-actions">
            <button className="btn with-icon" onClick={() => window.shell.tftpChooseRoot().then(onChange)} title="Use another folder">
              <IconEdit size={13} /> Change…
            </button>
            <button className="btn with-icon" onClick={() => window.shell.tftpOpenRoot()} title="Open the folder in Finder">
              <IconExternal size={13} /> Show in Finder
            </button>
          </div>
        </section>

        <section aria-label="This Mac">
          <div className="tftp-section-head">This Mac</div>
          {state.addresses.length ? (
            <div className="tftp-addresses">
              {state.addresses.map((a) => (
                <AddressCard key={a.name + a.address} a={a} copied={copied === a.address} onCopy={() => copy(a.address)} />
              ))}
            </div>
          ) : (
            <div className="tftp-empty">No network connection</div>
          )}
          <div className="tftp-example">
            <span className="muted">On the device:</span>
            <code>
              copy tftp://{(picked && state.addresses.some((a) => a.address === picked) ? picked : state.addresses[0]?.address) ?? '<this Mac>'}/&lt;file&gt; flash:
            </code>
          </div>
        </section>

        <div className="tftp-section-head">Transfers</div>
        {state.transfers.length ? (
          <ul className={`tftp-transfers scroll-fade scroll-fade-y${fadeClass(edges)}`} ref={listRef}>
            {state.transfers.map((t) => (
              <TransferRow key={t.id} t={t} />
            ))}
          </ul>
        ) : (
          <div className="tftp-empty">No transfers yet</div>
        )}

        <div className="actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
