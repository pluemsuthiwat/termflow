import { portName } from './hosts'
import type { SerialPortInfo } from './types'

/** macOS lists /dev/tty.* but opening those can block waiting for carrier; use the callout device. */
export const toCalloutPath = (p: string): string => p.replace(/^\/dev\/tty\./, '/dev/cu.')

// Built-in Mac ports that are never a console cable.
const BUILT_IN = /bluetooth|debug-console|wlan-debug|airpods/i

export interface RawPort {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
}

/** Callout paths only, one entry per device, built-in ports hidden. */
export function normalizePorts(raw: RawPort[]): SerialPortInfo[] {
  const seen = new Map<string, SerialPortInfo>()
  for (const p of raw) {
    const path = toCalloutPath(p.path)
    if (seen.has(path)) continue
    if (!p.vendorId && BUILT_IN.test(path)) continue
    seen.set(path, {
      path,
      name: portName(path),
      manufacturer: p.manufacturer || undefined,
      serialNumber: p.serialNumber || undefined,
      vendorId: p.vendorId || undefined,
      productId: p.productId || undefined
    })
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
}
