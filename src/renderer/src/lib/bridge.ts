/**
 * The single entry point to the main process. Everything privileged goes
 * through `window.voidsoul`, exposed by the preload script.
 */
import type { VoidSoulBridge } from '@shared/bridge'

export const vs: VoidSoulBridge = window.voidsoul
