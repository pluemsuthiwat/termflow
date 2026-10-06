/**
 * Colours IPv4 addresses (optionally with a /prefix) in terminal output by inserting
 * SGR codes around them. Works on raw bytes as they stream in: escape sequences pass
 * through untouched, and nothing is coloured while the remote side has set its own
 * foreground colour or a full-screen app (alternate screen) is up.
 *
 * A digit run at the end of a chunk may be the start of an address split across
 * chunks, so while output is streaming in it is held back briefly and released when
 * the next chunk arrives or after HOLD_MS, whichever comes first. The echo of a typed
 * key (a byte or two, on its own) is never held, so typing stays immediate.
 */

const ESC = 0x1b
const HOLD_MS = 15
/** A chunk this small, after a pause this long, is keystroke echo rather than streamed output. */
const ECHO_BYTES = 2
const BURST_GAP_MS = 10
/** Longest candidate: "255.255.255.255/32" plus a trailing separator. */
const MAX_CANDIDATE = 19

// Parser states.
const TEXT = 0
const ESCAPE = 1 // after ESC
const ESC_INTER = 2 // ESC + intermediate bytes, e.g. ESC ( B
const CSI = 3 // ESC [ … final
const STRING = 4 // OSC / DCS / APC / PM / SOS: until BEL or ESC \
const STRING_ESC = 5 // ESC inside a string (maybe ST)

const DOT = 0x2e
const SLASH = 0x2f
const isDigit = (b: number) => b >= 0x30 && b <= 0x39
const isLetter = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f
/** Bytes that may not touch an address on the left: "v1.2.3.4", "11.2.3.4.5". */
const joinsLeft = (b: number) => isLetter(b) || isDigit(b) || b === DOT

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/

const ALT_SCREEN = new Set(['47', '1047', '1049'])

const bytes = (s: string): number[] => [...new TextEncoder().encode(s)]

export class IpHighlighter {
  private state = TEXT
  private csi = ''
  /** The remote has set a foreground colour or inverse video; leave its text alone. */
  private fg = false
  private inverse = false
  private altScreen = false
  /** Last text byte emitted, for the left boundary check. */
  private prev = 0x20
  /** Digits, dots and slashes that may turn out to be an address. */
  private candidate: number[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastPush = 0
  private readonly on: number[]
  private readonly off = bytes('\x1b[39m')

  constructor(
    color: string,
    private readonly write: (data: Uint8Array) => void
  ) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    this.on = bytes(`\x1b[38;2;${r};${g};${b}m`)
  }

  /** Forget remote colour/screen state, e.g. for a fresh connection. */
  reset(): void {
    this.flushHeld()
    this.state = TEXT
    this.csi = ''
    this.fg = false
    this.inverse = false
    this.altScreen = false
    this.prev = 0x20
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  push(data: Uint8Array): void {
    clearTimeout(this.timer)
    const now = performance.now()
    const streaming = data.length > ECHO_BYTES || now - this.lastPush < BURST_GAP_MS
    this.lastPush = now
    const out: number[] = []
    for (let i = 0; i < data.length; i++) this.step(data[i], out)
    if (this.candidate.length && !streaming) this.endCandidate(0x20, out)
    if (out.length) this.write(Uint8Array.from(out))
    if (this.candidate.length) this.timer = setTimeout(() => this.flushHeld(), HOLD_MS)
  }

  private flushHeld(): void {
    clearTimeout(this.timer)
    if (!this.candidate.length) return
    const out: number[] = []
    this.endCandidate(0x20, out)
    this.write(Uint8Array.from(out))
  }

  private step(b: number, out: number[]): void {
    switch (this.state) {
      case TEXT:
        if (this.candidate.length) {
          if ((isDigit(b) || b === DOT || b === SLASH) && this.candidate.length < MAX_CANDIDATE) {
            this.candidate.push(b)
            return
          }
          this.endCandidate(b, out)
        } else if (isDigit(b) && !joinsLeft(this.prev)) {
          this.candidate.push(b)
          return
        }
        if (b === ESC) this.state = ESCAPE
        out.push(b)
        this.prev = b
        return
      case ESCAPE:
        out.push(b)
        if (b === 0x5b) {
          this.state = CSI
          this.csi = ''
        } else if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) this.state = STRING
        else if (b >= 0x20 && b <= 0x2f) this.state = ESC_INTER
        else this.state = TEXT
        return
      case ESC_INTER:
        out.push(b)
        if (b < 0x20 || b > 0x2f) this.state = TEXT
        return
      case CSI:
        out.push(b)
        if (b >= 0x40 && b <= 0x7e) {
          this.onCsi(this.csi, b)
          this.state = TEXT
        } else this.csi += String.fromCharCode(b)
        return
      case STRING:
        out.push(b)
        if (b === 0x07) this.state = TEXT
        else if (b === ESC) this.state = STRING_ESC
        return
      case STRING_ESC:
        out.push(b)
        this.state = b === 0x5c ? TEXT : STRING
        return
    }
  }

  /** Emit the held candidate, coloured if it is an address; `next` is the byte that ended it. */
  private endCandidate(next: number, out: number[]): void {
    const c = this.candidate
    this.candidate = []
    // A trailing "." or "/" belongs to the text, not the address ("… 8.8.8.8.", "52/file").
    let end = c.length
    while (end > 0 && !isDigit(c[end - 1])) end--
    const text = String.fromCharCode(...c.slice(0, end))
    const m = IPV4.exec(text)
    const touchesWord = end === c.length && (isLetter(next) || next === DOT)
    const isIp = m !== null && m.slice(1, 5).every((o) => Number(o) <= 255) && (!m[5] || Number(m[5].slice(1)) <= 32)
    if (isIp && !touchesWord && !this.fg && !this.inverse && !this.altScreen) {
      out.push(...this.on, ...c.slice(0, end), ...this.off, ...c.slice(end))
    } else out.push(...c)
    this.prev = c[c.length - 1]
  }

  private onCsi(params: string, final: number): void {
    if (final === 0x6d /* m */) this.onSgr(params)
    else if ((final === 0x68 || final === 0x6c) /* h / l */ && params.startsWith('?')) {
      if (params.slice(1).split(';').some((p) => ALT_SCREEN.has(p))) this.altScreen = final === 0x68
    }
  }

  private onSgr(params: string): void {
    const ps = params === '' ? ['0'] : params.split(/[;:]/)
    for (let i = 0; i < ps.length; i++) {
      const n = ps[i] === '' ? 0 : Number(ps[i])
      if (n === 0) this.fg = this.inverse = false
      else if (n === 39) this.fg = false
      else if (n === 7) this.inverse = true
      else if (n === 27) this.inverse = false
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) this.fg = true
      else if (n === 38 || n === 48) {
        if (n === 38) this.fg = true
        // Skip the colour's arguments: 5;idx or 2;r;g;b.
        i += ps[i + 1] === '5' ? 2 : ps[i + 1] === '2' ? 4 : 0
      }
    }
  }
}
