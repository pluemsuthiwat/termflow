import { app, net, shell } from 'electron'
import type { UpdateCheck } from '../shared/types'

// Releases are published on GitHub (gh release create vX.Y.Z ...). The app only checks
// and points the user at the release page: installing over itself needs a Developer ID
// signature, which this ad-hoc signed build doesn't have.
export const REPO_URL = 'https://github.com/pluemsuthiwat/termflow'
const RELEASES_URL = `${REPO_URL}/releases/`
const LATEST_API = 'https://api.github.com/repos/pluemsuthiwat/termflow/releases/latest'

/** Release page from the last check that found a newer version; only ever a page of this repo's releases. */
let releasePage: string | undefined

/** "v1.10.0" > "1.9.2"; missing parts count as 0, anything after "-" or "+" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion()
  const checkedAt = new Date().toISOString()
  let res: Response
  try {
    res = await net.fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Termflow/${current}` },
      signal: AbortSignal.timeout(8000)
    })
  } catch {
    return { state: 'error', current, checkedAt, message: "Couldn't reach GitHub. Check your internet connection." }
  }
  if (res.status === 403 || res.status === 429)
    return { state: 'error', current, checkedAt, message: 'GitHub is limiting requests right now. Try again later.' }
  if (res.status === 404) return { state: 'error', current, checkedAt, message: 'No releases have been published yet.' }
  if (!res.ok) return { state: 'error', current, checkedAt, message: `GitHub answered ${res.status}. Try again later.` }

  let rel: { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown }
  try {
    rel = await res.json()
  } catch {
    return { state: 'error', current, checkedAt, message: 'GitHub sent an unexpected answer.' }
  }
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : ''
  if (!/^v?\d+(\.\d+)*/.test(tag)) return { state: 'error', current, checkedAt, message: 'GitHub sent an unexpected answer.' }

  const latest = tag.replace(/^v/i, '')
  if (compareVersions(latest, current) <= 0) {
    releasePage = undefined
    return { state: 'latest', current, latest, checkedAt }
  }
  const page = typeof rel.html_url === 'string' ? rel.html_url : ''
  releasePage = page.startsWith(RELEASES_URL) ? page : `${RELEASES_URL}tag/${encodeURIComponent(tag)}`
  return {
    state: 'available',
    current,
    latest,
    checkedAt,
    // Plain text; the page shows it without interpreting HTML.
    notes: typeof rel.body === 'string' ? rel.body.slice(0, 20000) : '',
    publishedAt: typeof rel.published_at === 'string' ? rel.published_at : undefined
  }
}

/** Open the release page found by the last check (the page can't pass its own URL). */
export function openReleasePage(): void {
  void shell.openExternal(releasePage ?? `${RELEASES_URL}latest`)
}

export function openRepoPage(): void {
  void shell.openExternal(REPO_URL)
}
