import type { ElectronApi } from './user.ts'

declare global {
  interface Window {
    api: ElectronApi
  }
}
