import type { Host } from './types'

export const isSerial = (h: Pick<Host, 'kind'>): boolean => h.kind === 'serial'

/** "cu.usbserial-A10K" from "/dev/cu.usbserial-A10K". */
export const portName = (path: string): string => path.replace(/^\/dev\//, '')

/** One-line address: "admin@10.0.0.1:2222" or "cu.usbserial-A10K · 9600". */
export function hostAddress(h: Host): string {
  if (isSerial(h) && h.serial) return `${portName(h.serial.path)} · ${h.serial.baudRate}`
  return `${h.username}@${h.host}${h.port !== 22 ? `:${h.port}` : ''}`
}

/** "9600 8N1" style line settings. */
export function lineSettings(s: { baudRate: number; dataBits: number; parity: string; stopBits: number }): string {
  return `${s.baudRate} ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}`
}
