// Split layout of one tab: a binary tree of panes. Only data — every TerminalView is
// rendered flat and placed by `paneRects`, so changing the tree never remounts (and so
// never disconnects) a session.

/** 'row' = side by side (split right), 'col' = stacked (split down). */
export type SplitDir = 'row' | 'col'

export type Layout =
  | { kind: 'pane'; id: string }
  | { kind: 'split'; dir: SplitDir; /** share of the first child, 0–1 */ ratio: number; a: Layout; b: Layout }

/** Fractions of the tab's area, 0–1. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Divider {
  /** Child path to the split, e.g. "ab" = root.a.b. */
  path: string
  dir: SplitDir
  /** Area of the whole split, for turning a pointer position into a ratio. */
  area: Rect
  ratio: number
}

export type FocusDir = 'left' | 'right' | 'up' | 'down'

export const MIN_RATIO = 0.15
export const clampRatio = (r: number): number => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r))

export const pane = (id: string): Layout => ({ kind: 'pane', id })

export function paneIds(l: Layout): string[] {
  return l.kind === 'pane' ? [l.id] : [...paneIds(l.a), ...paneIds(l.b)]
}

export const hasPane = (l: Layout, id: string): boolean => paneIds(l).includes(id)

/** Which side of a pane something goes to. */
export type Side = 'left' | 'right' | 'up' | 'down'

export const sideDir = (side: Side): SplitDir => (side === 'left' || side === 'right' ? 'row' : 'col')
/** Left and up put the new part first. */
export const sideBefore = (side: Side): boolean => side === 'left' || side === 'up'

/** Put a layout (one pane or a whole tab's tree) beside `targetId`, sharing its space equally. */
export function insertAt(l: Layout, targetId: string, sub: Layout, side: Side): Layout {
  if (l.kind === 'pane') {
    if (l.id !== targetId) return l
    const dir = sideDir(side)
    return sideBefore(side) ? { kind: 'split', dir, ratio: 0.5, a: sub, b: l } : { kind: 'split', dir, ratio: 0.5, a: l, b: sub }
  }
  return { ...l, a: insertAt(l.a, targetId, sub, side), b: insertAt(l.b, targetId, sub, side) }
}

/** Put `newId` next to `targetId`: right of it ('row') or below it ('col'). */
export const splitPane = (l: Layout, targetId: string, newId: string, dir: SplitDir): Layout =>
  insertAt(l, targetId, pane(newId), dir === 'row' ? 'right' : 'down')

/** Panes in a line along `dir` (nested splits in another direction count as one). */
function span(l: Layout, dir: SplitDir): number {
  return l.kind === 'split' && l.dir === dir ? span(l.a, dir) + span(l.b, dir) : 1
}

/** Equal sizes: every pane in a row (or column) gets the same share. */
export function evenOut(l: Layout): Layout {
  if (l.kind === 'pane') return l
  const a = span(l.a, l.dir)
  return { ...l, ratio: a / (a + span(l.b, l.dir)), a: evenOut(l.a), b: evenOut(l.b) }
}

/** Tree without `id`; its sibling takes the freed space. null when it was the last pane. */
export function removePane(l: Layout, id: string): Layout | null {
  if (l.kind === 'pane') return l.id === id ? null : l
  const a = removePane(l.a, id)
  const b = removePane(l.b, id)
  if (!a) return b
  if (!b) return a
  return a === l.a && b === l.b ? l : { ...l, a, b }
}

export function setRatio(l: Layout, path: string, ratio: number): Layout {
  if (l.kind === 'pane') return l
  if (path === '') return { ...l, ratio: clampRatio(ratio) }
  return path[0] === 'a' ? { ...l, a: setRatio(l.a, path.slice(1), ratio) } : { ...l, b: setRatio(l.b, path.slice(1), ratio) }
}

function halves(r: Rect, dir: SplitDir, ratio: number): [Rect, Rect] {
  return dir === 'row'
    ? [{ ...r, w: r.w * ratio }, { ...r, x: r.x + r.w * ratio, w: r.w * (1 - ratio) }]
    : [{ ...r, h: r.h * ratio }, { ...r, y: r.y + r.h * ratio, h: r.h * (1 - ratio) }]
}

export function paneRects(l: Layout, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (l.kind === 'pane') return out.set(l.id, r)
  const [ra, rb] = halves(r, l.dir, l.ratio)
  paneRects(l.a, ra, out)
  return paneRects(l.b, rb, out)
}

export function dividers(l: Layout, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, path = ''): Divider[] {
  if (l.kind === 'pane') return []
  const [ra, rb] = halves(r, l.dir, l.ratio)
  return [{ path, dir: l.dir, area: r, ratio: l.ratio }, ...dividers(l.a, ra, path + 'a'), ...dividers(l.b, rb, path + 'b')]
}

/** Split direction that keeps the new panes closest to square, for a pane of w×h pixels. */
export const longerSide = (w: number, h: number): SplitDir => (w >= h ? 'row' : 'col')

/** Side of a w×h box nearest to the point (x, y) inside it: its edge zones, split along the diagonals. */
export function nearestSide(x: number, y: number, w: number, h: number): Side {
  const nx = x / w - 0.5
  const ny = y / h - 0.5
  return Math.abs(nx) > Math.abs(ny) ? (nx < 0 ? 'left' : 'right') : ny < 0 ? 'up' : 'down'
}

/** The pane next to `fromId` in a direction (the one overlapping it most), if any. */
export function neighbor(l: Layout, fromId: string, dir: FocusDir): string | undefined {
  const rects = paneRects(l)
  const from = rects.get(fromId)
  if (!from) return undefined
  const eps = 1e-6
  let best: { id: string; overlap: number } | undefined
  for (const [id, r] of rects) {
    if (id === fromId) continue
    const touches =
      dir === 'right' ? Math.abs(r.x - (from.x + from.w)) < eps
      : dir === 'left' ? Math.abs(r.x + r.w - from.x) < eps
      : dir === 'down' ? Math.abs(r.y - (from.y + from.h)) < eps
      : Math.abs(r.y + r.h - from.y) < eps
    if (!touches) continue
    const overlap =
      dir === 'left' || dir === 'right'
        ? Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y)
        : Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x)
    if (overlap > eps && (!best || overlap > best.overlap)) best = { id, overlap }
  }
  return best?.id
}
