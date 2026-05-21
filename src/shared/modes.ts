/**
 * Workflow modes / profiles. Each mode bundles a curated permission set, a
 * system-prompt fragment that steers the assistant, and a set of one-click
 * quick actions surfaced in the command panel.
 */
import type { AccentColor, ModeId, QuickAction } from './types'
import type { PermissionId } from './permissions'

export type { QuickAction }

export interface ModeDef {
  id: ModeId
  name: string
  tagline: string
  accent: AccentColor
  /** Permissions this mode is designed to use. */
  permissions: PermissionId[]
  /** Appended to the base system prompt when this mode is active. */
  prompt: string
  quickActions: QuickAction[]
}

export const MODES: ModeDef[] = [
  {
    id: 'indie-dev',
    name: 'Indie Dev',
    tagline: 'Code, build, ship.',
    accent: 'violet',
    permissions: ['terminal', 'filesystem', 'browser', 'appControl', 'screenCapture'],
    prompt:
      'You are assisting an indie game developer. Favour concise, technical answers. ' +
      'When suggesting actions, prefer editor, terminal, git and build workflows.',
    quickActions: [
      {
        id: 'open-vscode',
        label: 'Open VS Code',
        icon: 'Code',
        description: 'Launch Visual Studio Code.',
        requires: 'appControl',
        action: { type: 'open-app', params: { app: 'vscode' } }
      },
      {
        id: 'open-terminal',
        label: 'Open Terminal',
        icon: 'Terminal',
        description: 'Open a new terminal window.',
        requires: 'appControl',
        action: { type: 'open-app', params: { app: 'terminal' } }
      },
      {
        id: 'open-github',
        label: 'GitHub',
        icon: 'Github',
        description: 'Open GitHub in your browser.',
        requires: 'browser',
        action: { type: 'open-url', params: { url: 'https://github.com' } }
      },
      {
        id: 'dev-screenshot',
        label: 'Screenshot',
        icon: 'Camera',
        description: 'Capture the screen for analysis.',
        requires: 'screenCapture',
        action: { type: 'screenshot', params: {} }
      }
    ]
  },
  {
    id: 'creator',
    name: 'Creator',
    tagline: 'Make, edit, publish.',
    accent: 'magenta',
    permissions: ['filesystem', 'browser', 'appControl', 'screenCapture'],
    prompt:
      'You are assisting a content creator. Help with asset organisation, thumbnails, ' +
      'editing workflows and publishing. Keep guidance practical and visual.',
    quickActions: [
      {
        id: 'open-obs',
        label: 'Open OBS',
        icon: 'Video',
        description: 'Launch OBS Studio.',
        requires: 'appControl',
        action: { type: 'open-app', params: { app: 'obs' } }
      },
      {
        id: 'open-browser',
        label: 'Open Browser',
        icon: 'Globe',
        description: 'Open a new browser tab.',
        requires: 'browser',
        action: { type: 'open-url', params: { url: 'https://www.google.com' } }
      },
      {
        id: 'organize-downloads',
        label: 'Organise Downloads',
        icon: 'FolderCog',
        description: 'Sort the Downloads folder into typed sub-folders.',
        requires: 'filesystem',
        action: { type: 'organize-folder', params: { dir: '~downloads' } }
      },
      {
        id: 'creator-screenshot',
        label: 'Screenshot',
        icon: 'Camera',
        description: 'Capture the screen for analysis.',
        requires: 'screenCapture',
        action: { type: 'screenshot', params: {} }
      }
    ]
  },
  {
    id: 'streamer',
    name: 'Streamer',
    tagline: 'Go live, clip, engage.',
    accent: 'cyan',
    permissions: ['filesystem', 'appControl', 'screenCapture'],
    prompt:
      'You are assisting a live streamer. Help with scenes, overlays, clip management ' +
      'and community tools. Be fast and action-oriented.',
    quickActions: [
      {
        id: 'stream-obs',
        label: 'Open OBS',
        icon: 'Video',
        description: 'Launch OBS Studio.',
        requires: 'appControl',
        action: { type: 'open-app', params: { app: 'obs' } }
      },
      {
        id: 'open-discord',
        label: 'Open Discord',
        icon: 'MessageCircle',
        description: 'Launch Discord.',
        requires: 'appControl',
        action: { type: 'open-app', params: { app: 'discord' } }
      },
      {
        id: 'open-clips',
        label: 'Clips Folder',
        icon: 'Clapperboard',
        description: 'Open your captures / clips folder.',
        requires: 'filesystem',
        action: { type: 'open-folder', params: { dir: '~videos' } }
      },
      {
        id: 'stream-screenshot',
        label: 'Screenshot',
        icon: 'Camera',
        description: 'Capture the screen for analysis.',
        requires: 'screenCapture',
        action: { type: 'screenshot', params: {} }
      }
    ]
  },
  {
    id: 'researcher',
    name: 'Researcher',
    tagline: 'Search, read, capture.',
    accent: 'green',
    permissions: ['browser', 'filesystem', 'screenCapture'],
    prompt:
      'You are assisting research. Find sources, summarise clearly, compare findings and ' +
      'cite where things came from. Be rigorous and concise.',
    quickActions: [
      {
        id: 'web-search',
        label: 'Web Search',
        icon: 'Globe',
        description: 'Open a web search.',
        requires: 'browser',
        action: { type: 'open-url', params: { url: 'https://www.google.com' } }
      },
      {
        id: 'read-screen',
        label: 'Read Screen',
        icon: 'FileText',
        description: 'Extract on-screen text via OCR.',
        requires: 'screenCapture',
        action: { type: 'read-screen', params: {} }
      },
      {
        id: 'research-screenshot',
        label: 'Screenshot',
        icon: 'Camera',
        description: 'Capture the screen for analysis.',
        requires: 'screenCapture',
        action: { type: 'screenshot', params: {} }
      },
      {
        id: 'notes',
        label: 'Notes',
        icon: 'Folder',
        description: 'Open the Documents folder.',
        requires: 'filesystem',
        action: { type: 'open-folder', params: { dir: '~documents' } }
      }
    ]
  },
  {
    id: 'writer',
    name: 'Writer',
    tagline: 'Draft, edit, refine.',
    accent: 'cyan',
    permissions: ['filesystem', 'browser', 'appControl'],
    prompt:
      'You are assisting a writer. Help with drafting, structure, tone and editing. ' +
      'Offer crisp suggestions; respect the writer’s voice.',
    quickActions: [
      {
        id: 'documents',
        label: 'Documents',
        icon: 'FileText',
        description: 'Open the Documents folder.',
        requires: 'filesystem',
        action: { type: 'open-folder', params: { dir: '~documents' } }
      },
      {
        id: 'notepad',
        label: 'Notepad',
        icon: 'Box',
        description: 'Open Notepad.',
        requires: 'appControl',
        action: { type: 'open-app', params: { app: 'notepad' } }
      },
      {
        id: 'writer-research',
        label: 'Research',
        icon: 'Globe',
        description: 'Open a web search.',
        requires: 'browser',
        action: { type: 'open-url', params: { url: 'https://www.google.com' } }
      },
      {
        id: 'writer-organize',
        label: 'Organise Files',
        icon: 'FolderCog',
        description: 'Sort the Downloads folder.',
        requires: 'filesystem',
        action: { type: 'organize-folder', params: { dir: '~downloads' } }
      }
    ]
  },
  {
    id: 'productivity',
    name: 'Productivity',
    tagline: 'Plan, focus, ship.',
    accent: 'violet',
    permissions: ['browser', 'filesystem', 'appControl'],
    prompt:
      'You are assisting focused work. Help plan tasks, draft messages and keep momentum. ' +
      'Be direct and action-oriented.',
    quickActions: [
      {
        id: 'email',
        label: 'Email',
        icon: 'MessageCircle',
        description: 'Open your inbox.',
        requires: 'browser',
        action: { type: 'open-url', params: { url: 'https://mail.google.com' } }
      },
      {
        id: 'calendar',
        label: 'Calendar',
        icon: 'Star',
        description: 'Open your calendar.',
        requires: 'browser',
        action: { type: 'open-url', params: { url: 'https://calendar.google.com' } }
      },
      {
        id: 'prod-documents',
        label: 'Documents',
        icon: 'Folder',
        description: 'Open the Documents folder.',
        requires: 'filesystem',
        action: { type: 'open-folder', params: { dir: '~documents' } }
      },
      {
        id: 'prod-organize',
        label: 'Organise Files',
        icon: 'FolderCog',
        description: 'Sort the Downloads folder.',
        requires: 'filesystem',
        action: { type: 'organize-folder', params: { dir: '~downloads' } }
      }
    ]
  }
]

export const DEFAULT_MODE: ModeId = 'indie-dev'

export function getMode(id: ModeId): ModeDef {
  return MODES.find((m) => m.id === id) ?? MODES[0]
}
