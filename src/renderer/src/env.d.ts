import type { ShellApi } from '../../shared/types'

declare global {
  interface Window {
    shell: ShellApi
  }
}
