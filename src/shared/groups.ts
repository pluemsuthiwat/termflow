// Groups are paths like "Site A/Building 1/Floor 2". A host's `group` is the
// full path of the group it sits in; "" means ungrouped.

export const SEP = '/'

/** Trim each segment and drop empty ones: " A / /B " -> "A/B". */
export function normalizePath(path: string): string {
  return path
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(SEP)
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf(SEP)
  return i < 0 ? '' : path.slice(0, i)
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf(SEP) + 1)
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}${SEP}${name}` : name
}

/** True for the group itself and anything nested below it. */
export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + SEP)
}

/** "A/B/C" -> ["A", "A/B", "A/B/C"] */
export function withAncestors(path: string): string[] {
  const parts = path.split(SEP)
  return parts.map((_, i) => parts.slice(0, i + 1).join(SEP))
}

/** Replace the `from` prefix of `path` with `to` (path must be within `from`). */
export function rebase(path: string, from: string, to: string): string {
  const rest = path === from ? '' : path.slice(from.length + 1)
  return rest ? joinPath(to, rest) : to
}

export function validateSegment(name: string): string {
  const n = name.trim()
  if (!n) throw new Error('Group name is required')
  if (n.includes(SEP)) throw new Error(`Group name can't contain "${SEP}"`)
  return n
}
