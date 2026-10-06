import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { SerialSettings, SessionStatus } from '../../shared/types'
import { IpHighlighter } from './ipHighlight'

/** Terminal palette: one soft green for text, magenta for IPv4 addresses, on deep navy. */
const BACKGROUND = '#141728'
const TEXT_COLOR = '#3ccf6e'
const IP_COLOR = '#e2479f'

export interface Tab {
  sessionId: string
  hostId: string
  title: string
  secret?: string
  status: SessionStatus
  /** Serial console tab; `serial` is only set for quick port sessions. */
  kind?: 'ssh' | 'serial'
  serial?: SerialSettings
  /** e.g. "cu.usbserial-A10K · 9600 8N1", shown when connected. */
  detail?: string
}

interface Props {
  tab: Tab
  active: boolean
}

export default function TerminalView({ tab, active }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const statusRef = useRef<SessionStatus>(tab.status)
  statusRef.current = tab.status
  const secretRef = useRef(tab.secret)
  secretRef.current = tab.secret
  const prevState = useRef(tab.status.state)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 20000,
      macOptionIsMeta: true,
      allowProposedApi: false,
      theme: {
        background: BACKGROUND,
        foreground: TEXT_COLOR,
        cursor: TEXT_COLOR,
        cursorAccent: BACKGROUND,
        // Text green, see-through; shaped into a thin pill in styles.css.
        scrollbarSliderBackground: 'rgba(60, 207, 110, 0.25)',
        scrollbarSliderHoverBackground: 'rgba(60, 207, 110, 0.45)',
        scrollbarSliderActiveBackground: 'rgba(60, 207, 110, 0.6)',
        selectionBackground: '#3b4261'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const { sessionId } = tab
    const ips = new IpHighlighter(IP_COLOR, (data) => term.write(data))
    const offData = window.shell.onData((id, data) => {
      if (id === sessionId) ips.push(data)
    })

    const connect = (secret?: string): void => {
      ips.reset()
      term.write(`\x1b[90mConnecting to ${tab.title}…\x1b[0m\r\n`)
      window.shell
        .connect({ sessionId, hostId: tab.hostId, secret, serial: tab.serial, rows: term.rows, cols: term.cols })
        .catch((err: Error) => {
          const msg = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          statusRef.current = { state: 'closed', error: msg }
          prevState.current = 'closed'
          term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n\x1b[90mPress Enter to retry.\x1b[0m\r\n`)
        })
    }

    const inputSub = term.onData((data) => {
      if (statusRef.current.state === 'closed') {
        // Reuse a password typed for this tab (not saved) on reconnect.
        if (data === '\r') connect(secretRef.current)
        return
      }
      window.shell.write(sessionId, data)
    })
    const resizeSub = term.onResize(({ rows, cols }) => window.shell.resize(sessionId, rows, cols))

    const ro = new ResizeObserver(() => {
      if (el.current && el.current.offsetParent !== null) fit.fit()
    })
    ro.observe(el.current!)

    connect(tab.secret)

    return () => {
      ro.disconnect()
      offData()
      ips.dispose()
      inputSub.dispose()
      resizeSub.dispose()
      window.shell.close(sessionId)
      term.dispose()
    }
    // A tab connects exactly once on mount; reconnects are driven by Enter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Print disconnect reason inside the terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const s = tab.status
    if (s.state === 'closed' && prevState.current !== 'closed') {
      const reason = s.error ? `: ${s.error}` : ''
      term.write(`\r\n\x1b[33mDisconnected${reason}\x1b[0m\r\n\x1b[90mPress Enter to reconnect.\x1b[0m\r\n`)
    }
    if (s.state === 'ready' && tab.kind === 'serial') {
      // Consoles stay silent until they get a keypress.
      term.write(`\x1b[90mConnected to ${tab.detail ?? 'console port'} — press Enter if nothing appears. ⌘B sends Break.\x1b[0m\r\n`)
    }
    if (s.state === 'ready' && active) term.focus()
    prevState.current = s.state
  }, [tab.status])

  useEffect(() => {
    if (active) {
      fitRef.current?.fit()
      termRef.current?.focus()
    }
  }, [active])

  // The pane's padding shares the terminal background so the edges don't show a band.
  return <div className="term-pane" ref={el} hidden={!active} style={{ background: BACKGROUND }} />
}
