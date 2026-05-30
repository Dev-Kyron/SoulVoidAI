/**
 * Permission catalogue. Shared between the main process (enforcement) and the
 * renderer (settings UI). Every automation capability maps onto one of these
 * ids; nothing runs unless the matching permission has been granted by the
 * user from the Settings panel.
 */

export type PermissionId =
  | 'terminal'
  | 'filesystem'
  | 'browser'
  | 'appControl'
  | 'inputAccess'
  | 'microphone'
  | 'screenCapture'
  | 'homeAssistant'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface PermissionDef {
  id: PermissionId
  label: string
  description: string
  risk: RiskLevel
}

export interface PermissionState {
  granted: boolean
  grantedAt: string | null
}

export const PERMISSIONS: PermissionDef[] = [
  {
    id: 'terminal',
    label: 'Terminal Access',
    description: 'Run shell commands on your machine.',
    risk: 'high'
  },
  {
    id: 'filesystem',
    label: 'File System',
    description: 'Read, write, list and organise files and folders.',
    risk: 'high'
  },
  {
    id: 'browser',
    label: 'Browser Control',
    description: 'Open URLs and links in your default browser.',
    risk: 'low'
  },
  {
    id: 'appControl',
    label: 'App Control',
    description: 'Launch applications and bring windows to the foreground.',
    risk: 'medium'
  },
  {
    id: 'inputAccess',
    label: 'Input Access',
    description:
      'Drive your keyboard and mouse — type text, send hotkeys, move the cursor and click. Required for true hands-free operation inside other programs.',
    risk: 'high'
  },
  {
    id: 'microphone',
    label: 'Microphone',
    description: 'Capture audio for voice commands (reserved for voice mode).',
    risk: 'medium'
  },
  {
    id: 'screenCapture',
    label: 'Screen Capture',
    description: 'Take screenshots and read on-screen text via OCR.',
    risk: 'medium'
  },
  {
    id: 'homeAssistant',
    label: 'Home Assistant',
    description:
      'Read entity states and call services on your Home Assistant instance — lights, locks, thermostat, scenes, scripts and anything else HA exposes.',
    risk: 'medium'
  }
]

export const PERMISSION_IDS: PermissionId[] = PERMISSIONS.map((p) => p.id)

export function defaultPermissionState(): Record<PermissionId, PermissionState> {
  return PERMISSION_IDS.reduce(
    (acc, id) => {
      acc[id] = { granted: false, grantedAt: null }
      return acc
    },
    {} as Record<PermissionId, PermissionState>
  )
}
