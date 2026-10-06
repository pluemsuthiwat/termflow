import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppInfo, UpdateCheck } from '../../shared/types'
import { Modal } from './dialogs'
import { IconCheck, IconDownload, IconExternal, IconRefresh, IconWarn } from './icons'
import { fadeClass, useScrollEdges } from './scrollEdges'
import logo from './assets/logo.png'

const dateText = (iso?: string): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''

const timeText = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** **bold** and `code` inside a line of release notes; everything else is plain text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith('`') && part.endsWith('`') ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      part.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    )
  )
}

/** Release notes are Markdown on GitHub: show headings, bullets and code as React text (never as HTML). */
function ReleaseNotes({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(ref, 'y')
  const out: ReactNode[] = []
  let code: string[] | null = null
  let bullets: string[] = []
  const flushBullets = () => {
    if (bullets.length) out.push(<ul key={out.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>)
    bullets = []
  }
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (code) {
        out.push(<pre key={out.length}>{code.join('\n')}</pre>)
        code = null
      } else {
        flushBullets()
        code = []
      }
      continue
    }
    if (code) {
      code.push(raw)
      continue
    }
    const line = raw.trim()
    const bullet = /^[-*]\s+(.*)/.exec(line)
    if (bullet) {
      bullets.push(bullet[1])
      continue
    }
    flushBullets()
    const heading = /^#{1,6}\s+(.*)/.exec(line)
    if (heading) out.push(<h4 key={out.length}>{inline(heading[1])}</h4>)
    else if (line) out.push(<p key={out.length}>{inline(line.replace(/^>\s?/, ''))}</p>)
  }
  flushBullets()
  if (code) out.push(<pre key={out.length}>{code.join('\n')}</pre>)
  return (
    <div className={`release-notes scroll-fade scroll-fade-y${fadeClass(edges)}`} ref={ref}>
      {out}
    </div>
  )
}

export function AboutDialog({
  update,
  checking,
  onCheck,
  onClose
}: {
  update: UpdateCheck | null
  checking: boolean
  onCheck: () => void
  onClose: () => void
}) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    window.shell.appInfo().then(setInfo)
  }, [])

  // Keep focus in the dialog (Escape closes it, keys don't reach a terminal) while the
  // focused button is swapped out, e.g. during a check started from the menu.
  const root = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) closeBtn.current?.focus()
  }, [checking, update])

  return (
    <Modal title="About Termflow" onClose={onClose}>
      <div className="about" ref={root}>
        <div className="about-head">
          <img src={logo} alt="" width={56} height={56} draggable={false} />
          <div>
            <div className="about-name">Termflow</div>
            <div className="about-version">Version {info?.version ?? ''}</div>
            <div className="about-tagline">SSH and serial console client</div>
          </div>
        </div>

        <section className={`update-box ${checking ? 'checking' : (update?.state ?? 'idle')}`} aria-live="polite">
          {checking ? (
            <div className="update-line">
              <span className="spinner" aria-hidden="true" />
              <span>Checking for updates…</span>
            </div>
          ) : update?.state === 'available' ? (
            <>
              <div className="update-line">
                <span className="update-icon">
                  <IconDownload size={14} />
                </span>
                <div>
                  <strong>Termflow {update.latest} is available</strong>
                  <div className="update-sub">
                    You have {update.current}
                    {update.publishedAt && ` · released ${dateText(update.publishedAt)}`}
                  </div>
                </div>
              </div>
              {update.notes.trim() && <ReleaseNotes text={update.notes} />}
              <div className="update-actions">
                <button className="btn" onClick={onCheck}>
                  Check again
                </button>
                <button className="btn primary with-icon" onClick={() => window.shell.openReleasePage()} autoFocus>
                  <IconDownload size={14} /> Download {update.latest}
                </button>
              </div>
            </>
          ) : update?.state === 'latest' ? (
            <div className="update-line">
              <span className="update-icon">
                <IconCheck size={14} />
              </span>
              <div>
                <strong>You're up to date</strong>
                <div className="update-sub">
                  {update.current} is the latest version · checked {timeText(update.checkedAt)}
                </div>
              </div>
              <button className="btn with-icon" onClick={onCheck} autoFocus>
                <IconRefresh size={13} /> Check again
              </button>
            </div>
          ) : update?.state === 'error' ? (
            <div className="update-line">
              <span className="update-icon">
                <IconWarn size={14} />
              </span>
              <div>
                <strong>Couldn't check for updates</strong>
                <div className="update-sub">{update.message}</div>
              </div>
              <button className="btn with-icon" onClick={onCheck} autoFocus>
                <IconRefresh size={13} /> Try again
              </button>
            </div>
          ) : (
            <div className="update-line">
              <div>
                <strong>Updates</strong>
                <div className="update-sub">See if a newer version has been released on GitHub.</div>
              </div>
              <button className="btn primary with-icon" onClick={onCheck} autoFocus>
                <IconRefresh size={13} /> Check for updates
              </button>
            </div>
          )}
        </section>

        {info && (
          <dl className="about-details">
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>Chromium</dt>
            <dd>{info.chrome}</dd>
            <dt>Node.js</dt>
            <dd>{info.node}</dd>
            <dt>Architecture</dt>
            <dd>{info.arch}</dd>
          </dl>
        )}

        <div className="about-foot">
          <button className="link-btn" onClick={() => window.shell.openRepoPage()}>
            GitHub <IconExternal size={12} />
          </button>
          <span>MIT License · © 2026 Suthiwat Srisen</span>
          <button className="btn" onClick={onClose} ref={closeBtn}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
