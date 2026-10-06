import crypto from 'node:crypto'

// Electron's BoringSSL has no "modp1"/"modp2" groups, but ssh2 needs modp2 for
// diffie-hellman-group1-sha1, the only key exchange on many old IOS 12.2 switches
// (Catalyst 2960, ...). Supply the well-known prime ourselves (RFC 2409 Oakley group 2).
const MODP2_PRIME =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22' +
  '514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6' +
  'F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381' +
  'FFFFFFFFFFFFFFFF'

/** Must run before ssh2 is loaded: it keeps its own reference to createDiffieHellmanGroup. */
export function addMissingDhGroups(): void {
  const builtin = crypto.createDiffieHellmanGroup
  try {
    builtin('modp2')
    return // this runtime has it
  } catch {
    // fall through and provide it
  }
  crypto.createDiffieHellmanGroup = ((name: string) =>
    name === 'modp2'
      ? crypto.createDiffieHellman(MODP2_PRIME, 'hex', 2)
      : builtin(name)) as typeof crypto.createDiffieHellmanGroup
}
