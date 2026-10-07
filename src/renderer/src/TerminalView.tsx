import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { SerialSettings, SessionStatus } from '../../shared/types'
import { Modal } from './dialogs'
import { fadeClass, useScrollEdges } from './scrollEdges'
import { IconMaximize, IconSplit } from './icons'
import { IpHighlighter } from './ipHighlight'
import { fontStack, type TermFont } from './font'
import type { Rect } from './layout'

/** Terminal palette: one soft green for text, magenta for IPv4 addresses, on deep navy. */
const BACKGROUND = '#141728'
const TEXT_COLOR = '#3ccf6e'
const IP_COLOR = '#e2479f'

/** Pause between lines for "Paste line by line", so slow consoles and device buffers keep up. */
const LINE_DELAY_MS = 150
/** Matches highlighted at once; the count shows "1000+" beyond that. */
const HIGHLIGHT_LIMIT = 1000

export interface Tab {
  sessionId: string
  hostId: string
  title: string
  secret?: string
  status: SessionStatus
  /** Serial console tab; `serial` is only set for quick port sessions. */
  kind?: 'ssh' | 'serial'
  serial?: SerialSettings
  /** Quick serial session that writes a session log. */
  log?: boolean
  /** e.g. "cu.usbserial-A10K · 9600 8N1", shown when connected. */
  detail?: string
}

/** Commands from the menu, sent to the focused pane. */
export interface PaneHandle {
  find(): void
  findNext(): void
  findPrevious(): void
}

interface Props {
  tab: Tab
  /** Its tab is the one shown. */
  visible: boolean
  /** Receives keyboard input and menu commands. */
  focused: boolean
  /** Shares its tab with other panes: show a header. */
  split: boolean
  /** Shown alone over its tab. */
  zoomed: boolean
  rect: Rect
  font: TermFont
  onFocus: () => void
  onClose: () => void
  onMoveToTab: () => void
  /** Open the split picker for this pane, hanging from `anchor`. */
  onSplit: (anchor: HTMLElement) => void
  onZoom: () => void
  /** Pointer down on the header: the pane may be dragged to another place. */
  onDragStart: (e: React.PointerEvent) => void
  register: (sessionId: string, handle: PaneHandle | null) => void
}

const searchDecorations: ISearchOptions['decorations'] = {
  matchBackground: '#3b4261',
  matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#e0af68',
  activeMatchColorOverviewRuler: '#e0af68'
}

/** Text split into the lines it would send; one entry = a single line. */
function pasteLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
}

export default function TerminalView({ tab, visible, focused, split, zoomed, rect, font, onFocus, onClose, onMoveToTab, onSplit, onZoom, onDragStart, register }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const statusRef = useRef<SessionStatus>(tab.status)
  statusRef.current = tab.status
  const secretRef = useRef(tab.secret)
  secretRef.current = tab.secret
  const prevState = useRef(tab.status.state)
  const alive = useRef(true)

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<string | null>(null)
  // "Paste line by line" in progress; its Stop button sets stopFeed.
  const [feeding, setFeeding] = useState<{ sent: number; total: number } | null>(null)
  const stopFeed = useRef(false)

  const searchOpts = (incremental = false): ISearchOptions => ({ caseSensitive, incremental, decorations: searchDecorations })
  const findNext = (incremental = false): void => {
    if (query) searchRef.current?.findNext(query, searchOpts(incremental))
  }
  const findPrevious = (): void => {
    if (query) searchRef.current?.findPrevious(query, searchOpts())
  }
  const openFind = (): void => {
    setFindOpen(true)
    // Already open: just select the text to type over it.
    requestAnimationFrame(() => findInput.current?.select())
  }
  const closeFind = (): void => {
    setFindOpen(false)
    setResults(null)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  // Menu commands read the latest query through this ref.
  const handle = useRef<PaneHandle>(null!)
  handle.current = {
    find: openFind,
    findNext: () => (findOpen ? findNext() : openFind()),
    findPrevious: () => (findOpen ? findPrevious() : openFind())
  }

  useEffect(() => {
    const term = new Terminal({
      fontFamily: fontStack(font.family),
      fontSize: font.size,
      cursorBlink: true,
      scrollback: 20000,
      macOptionIsMeta: true,
      // Search highlights use the decoration API.
      allowProposedApi: true,
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
    const search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT })
    term.loadAddon(fit)
    term.loadAddon(search)
    // ⌘-click opens a link, so selecting text never launches the browser.
    // window.open is limited to http(s) links by the main process.
    term.loadAddon(new WebLinksAddon((e, uri) => (e.metaKey || e.ctrlKey) && window.open(uri)))
    term.open(el.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    const resultsSub = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount })
    )

    const { sessionId } = tab
    register(sessionId, {
      find: () => handle.current.find(),
      findNext: () => handle.current.findNext(),
      findPrevious: () => handle.current.findPrevious()
    })
    const ips = new IpHighlighter(IP_COLOR, (data) => term.write(data))
    const offData = window.shell.onData((id, data) => {
      if (id === sessionId) ips.push(data)
    })

    const connect = (secret?: string): void => {
      ips.reset()
      term.write(`\x1b[90mConnecting to ${tab.title}…\x1b[0m\r\n`)
      window.shell
        .connect({ sessionId, hostId: tab.hostId, secret, serial: tab.serial, log: tab.log, rows: term.rows, cols: term.cols })
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

    // Several lines pasted at once run as commands on the device: confirm first.
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (statusRef.current.state !== 'ready' || pasteLines(text).length < 2) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setPending(text)
    }
    el.current!.addEventListener('paste', onPaste, true)

    const ro = new ResizeObserver(() => {
      if (el.current && el.current.offsetParent !== null) fit.fit()
    })
    ro.observe(el.current!)

    connect(tab.secret)

    const node = el.current!
    return () => {
      alive.current = false
      register(sessionId, null)
      ro.disconnect()
      node.removeEventListener('paste', onPaste, true)
      offData()
      ips.dispose()
      inputSub.dispose()
      resizeSub.dispose()
      resultsSub.dispose()
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
      setPending(null)
    }
    if (s.state === 'ready' && tab.kind === 'serial') {
      // Consoles stay silent until they get a keypress.
      term.write(`\x1b[90mConnected to ${tab.detail ?? 'console port'} — press Enter if nothing appears. ⌘B sends Break.\x1b[0m\r\n`)
    }
    if (s.state === 'ready' && visible && focused && !findOpen) term.focus()
    prevState.current = s.state
  }, [tab.status])

  useEffect(() => {
    if (visible) fitRef.current?.fit()
    if (visible && focused && !findOpen) termRef.current?.focus()
  }, [visible, focused])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontStack(font.family)
    term.options.fontSize = font.size
    if (visible) fitRef.current?.fit()
  }, [font.family, font.size])

  // Re-run the search as the text or options change.
  useEffect(() => {
    if (!findOpen) return
    // Start over: the addon keeps its last matches when only the options change.
    searchRef.current?.clearDecorations()
    if (query) findNext(true)
    else setResults(null)
  }, [query, caseSensitive, findOpen])

  const cancelPaste = (): void => {
    setPending(null)
    termRef.current?.focus()
  }

  const paste = (lineByLine: boolean): void => {
    const text = pending
    setPending(null)
    termRef.current?.focus()
    if (text === null) return
    if (!lineByLine) return termRef.current?.paste(text)
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const total = lines[lines.length - 1] ? lines.length : lines.length - 1
    stopFeed.current = false
    setFeeding({ sent: 0, total })
    void (async () => {
      for (let i = 0; i < total; i++) {
        if (!alive.current || stopFeed.current || statusRef.current.state !== 'ready') break
        const last = i === lines.length - 1
        window.shell.write(tab.sessionId, last ? lines[i] : lines[i] + '\r')
        setFeeding({ sent: i + 1, total })
        if (i < total - 1) await new Promise((r) => setTimeout(r, LINE_DELAY_MS))
      }
      if (alive.current) setFeeding(null)
    })()
  }

  const total = results && (results.count >= HIGHLIGHT_LIMIT ? `${HIGHLIGHT_LIMIT}+` : String(results.count))
  const count = !results ? '' : results.count === 0 ? 'No results' : results.index < 0 ? `${total} found` : `${results.index + 1}/${total}`
  const pendingLines = pending === null ? [] : pasteLines(pending)
  const s = tab.status

  return (
    <div
      className={`pane ${focused ? 'focused' : ''} ${split ? 'split' : ''} ${zoomed ? 'zoomed' : ''}`}
      data-session={tab.sessionId}
      hidden={!visible}
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
      onMouseDownCapture={() => !focused && onFocus()}
      onFocusCapture={() => !focused && onFocus()}
    >
      {split && (
        <div className="pane-header" title="Drag to move this pane" onPointerDown={onDragStart}>
          <span className={`dot ${s.state}`} />
          <span className="pane-title">{tab.title}</span>
          {s.state === 'ready' && s.logFile && (
            <button className="rec" title={`Logging to ${s.logFile} — click to show in Finder`} onClick={() => s.logFile && window.shell.revealLog(s.logFile)}>
              REC
            </button>
          )}
          <button className="pane-btn" title="Split this pane…" aria-label="Split pane" onClick={(e) => onSplit(e.currentTarget)}>
            <IconSplit size={13} />
          </button>
          <button
            className={`pane-btn ${zoomed ? 'on' : ''}`}
            title={zoomed ? 'Show all panes (⇧⌘↵)' : 'Zoom this pane (⇧⌘↵)'}
            aria-label={zoomed ? 'Show all panes' : 'Zoom pane'}
            aria-pressed={zoomed}
            onClick={onZoom}
          >
            <IconMaximize size={12} />
          </button>
          <button className="pane-btn" title="Move to its own tab" aria-label="Move to new tab" onClick={onMoveToTab}>
            ⇱
          </button>
          <button className="pane-btn" title="Close pane (⌘W)" aria-label="Close pane" onClick={onClose}>
            ✕
          </button>
        </div>
      )}
      <div className="pane-body">
        {/* The pane's padding shares the terminal background so the edges don't show a band. */}
        <div className="term-pane" ref={el} style={{ background: BACKGROUND }} />
        {findOpen && (
          <div className="find-bar" role="search">
            <input
              ref={findInput}
              autoFocus
              value={query}
              placeholder="Find"
              aria-label="Find in terminal"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) findPrevious()
                  else findNext()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeFind()
                }
              }}
            />
            <span className="find-count">{count}</span>
            <button
              className={`find-btn ${caseSensitive ? 'on' : ''}`}
              title="Match case"
              aria-label="Match case"
              aria-pressed={caseSensitive}
              onClick={() => setCaseSensitive((c) => !c)}
            >
              Aa
            </button>
            <button className="find-btn" title="Previous (⇧↵)" aria-label="Previous match" onClick={findPrevious}>
              ↑
            </button>
            <button className="find-btn" title="Next (↵)" aria-label="Next match" onClick={() => findNext()}>
              ↓
            </button>
            <button className="find-btn" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>
              ✕
            </button>
          </div>
        )}
      </div>
      {feeding && (
        <div className="paste-progress" role="status">
          Pasting line {feeding.sent} of {feeding.total}
          <button className="btn small" onClick={() => (stopFeed.current = true)}>
            Stop
          </button>
        </div>
      )}
      {pending !== null && (
        <Modal title={`Paste ${pendingLines.length} lines into ${tab.title}?`} onClose={cancelPaste} wide>
          <PasteConfirm lines={pendingLines} onCancel={cancelPaste} onPaste={paste} />
        </Modal>
      )}
    </div>
  )
}

/** Preview rows rendered at most; a paste beyond that is still sent in full. */
const PREVIEW_MAX = 5000

function PasteConfirm({ lines, onCancel, onPaste }: { lines: string[]; onCancel: () => void; onPaste: (lineByLine: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(ref, 'y')
  const shown = lines.slice(0, PREVIEW_MAX)
  return (
    <div className="form">
      <p className="muted">Each line runs as a command on the device. Scroll to check every line before pasting.</p>
      <div
        ref={ref}
        className={`paste-preview scroll-fade scroll-fade-y${fadeClass(edges)}`}
        style={{ ['--gutter' as string]: `${String(lines.length).length}ch` }}
        tabIndex={0}
        aria-label={`${lines.length} lines to paste`}
      >
        {shown.map((l, i) => (
          <div key={i} className="paste-line" data-n={i + 1}>
            {l || ' '}
          </div>
        ))}
        {lines.length > shown.length && <div className="paste-more">… {lines.length - shown.length} more lines not shown</div>}
      </div>
      <div className="actions">
        <button className="btn" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button className="btn" onClick={() => onPaste(true)} title={`Send one line every ${LINE_DELAY_MS} ms, for slow consoles`}>
          Paste line by line
        </button>
        <button className="btn primary" onClick={() => onPaste(false)}>
          Paste
        </button>
      </div>
    </div>
  )
}
