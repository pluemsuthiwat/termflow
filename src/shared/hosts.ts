import type { Host } from './types'

export const isSerial = (h: Pick<Host, 'kind'>): boolean => h.kind === 'serial'

/** Shown in place of a label the user left empty. */
export const UNTITLED = 'Untitled'

/**
 * Whether the user gave this host a label. Older versions saved the IP as the label when none
 * was typed, so a label equal to the IP counts as none.
 */
export function hasLabel(h: Pick<Host, 'name' | 'host' | 'kind'>): boolean {
  const name = h.name.trim()
  return !!name && (isSerial(h) || name !== h.host)
}

/** The label, or "Untitled": for places that show the address next to it. */
export const displayName = (h: Pick<Host, 'name' | 'host' | 'kind'>): string => (hasLabel(h) ? h.name : UNTITLED)

/** The label, or the IP: for places with nothing else to tell hosts apart (tabs, Recent). */
export const shortName = (h: Pick<Host, 'name' | 'host' | 'kind'>): string => (hasLabel(h) ? h.name : h.host)

/** "cu.usbserial-A10K" from "/dev/cu.usbserial-A10K". */
export const portName = (path: string): string => path.replace(/^\/dev\//, '')

/** One-line address: "admin@10.0.0.1:2222" or "cu.usbserial-A10K · 9600". */
export function hostAddress(h: Host): string {
  if (isSerial(h) && h.serial) return `${portName(h.serial.path)} · ${h.serial.baudRate}`
  return `${h.username}@${hostEndpoint(h)}`
}

/** Like hostAddress without the user: "10.0.0.1", or "10.0.0.1:2222" off port 22. */
export function hostEndpoint(h: Host): string {
  if (isSerial(h) && h.serial) return hostAddress(h)
  return `${h.host}${h.port !== 22 ? `:${h.port}` : ''}`
}

/** "9600 8N1" style line settings. */
export function lineSettings(s: { baudRate: number; dataBits: number; parity: string; stopBits: number }): string {
  return `${s.baudRate} ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}`
}
