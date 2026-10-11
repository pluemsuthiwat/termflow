// electron-builder afterPack hook (runs before signing).
// macOS Local Network privacy tracks apps by the Mach-O UUID of their main executable.
// Every Electron app ships Electron's stock binary, so Termflow shares that UUID with
// Electron.app and any other app on the same Electron version, and the Local Network grant
// may not stick to Termflow. Give the executable a UUID of its own.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MH_MAGIC_64 = 0xfeedfacf
const LC_UUID = 0x1b

module.exports = async function uniqueUuid(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { productFilename, id } = context.packager.appInfo
  const exe = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
  const bin = fs.readFileSync(exe)
  if (bin.readUInt32LE(0) !== MH_MAGIC_64) throw new Error(`${exe}: not a thin 64-bit Mach-O`)

  // Stable for a given app id and Electron version, so a Termflow-only update keeps its permission.
  const uuid = crypto.createHash('sha256').update(`${id}\0${context.packager.info.framework.version}`).digest().subarray(0, 16)
  uuid[6] = (uuid[6] & 0x0f) | 0x50 // version 5 (name-based)
  uuid[8] = (uuid[8] & 0x3f) | 0x80 // RFC 4122 variant

  const ncmds = bin.readUInt32LE(16)
  let off = 32 // sizeof(mach_header_64)
  for (let i = 0; i < ncmds; i++) {
    const cmd = bin.readUInt32LE(off)
    if (cmd === LC_UUID) {
      uuid.copy(bin, off + 8)
      fs.writeFileSync(exe, bin)
      return
    }
    off += bin.readUInt32LE(off + 4)
  }
  throw new Error(`${exe}: no LC_UUID load command`)
}
