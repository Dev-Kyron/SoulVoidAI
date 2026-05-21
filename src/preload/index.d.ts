import type { VoidSoulBridge } from '@shared/bridge'

declare global {
  interface Window {
    voidsoul: VoidSoulBridge
  }
}

export {}
