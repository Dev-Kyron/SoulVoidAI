/**
 * The tools the AI agent can call. Each maps onto a built-in automation
 * action, so an agent tool call is permission-gated and logged exactly like a
 * manual action. Tool names use underscores to satisfy every provider's
 * function-name rules.
 *
 * Most tools return text. `see_screen` returns an image — the renderer's
 * agent loop attaches that image to the next user turn so the model can
 * actually *look* at the screen, not just OCR the text on it.
 */
import type { ActionType } from '@shared/types'

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
  required: string[]
}

export interface ToolSpec {
  name: string
  actionType: ActionType
  description: string
  parameters: ToolParameterSchema
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'open_app',
    actionType: 'open-app',
    description:
      'Launch an application by name (e.g. "vscode", "obs", "discord", "terminal") or full executable path.',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Application name or executable path.' } },
      required: ['app']
    }
  },
  {
    name: 'open_url',
    actionType: 'open-url',
    description: 'Open an http(s) URL in the default browser.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to open.' } },
      required: ['url']
    }
  },
  {
    name: 'open_folder',
    actionType: 'open-folder',
    description:
      'Open a folder in the file explorer. Path tokens are supported: ~home ~downloads ~desktop ~documents ~videos ~pictures ~music.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Folder path or token.' } },
      required: ['dir']
    }
  },
  {
    name: 'run_shell',
    actionType: 'shell',
    description: 'Run a shell command and return its output. Use carefully.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        cwd: { type: 'string', description: 'Optional working directory.' }
      },
      required: ['command']
    }
  },
  {
    name: 'list_files',
    actionType: 'file-list',
    description: 'List the files and folders inside a directory.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Directory path or token.' } },
      required: ['dir']
    }
  },
  {
    name: 'read_file',
    actionType: 'file-read',
    description: 'Read a UTF-8 text file and return its contents.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path.' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    actionType: 'file-write',
    description: 'Write text to a file. The previous contents are preserved for undo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', description: 'Text content to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'organize_folder',
    actionType: 'organize-folder',
    description:
      'Sort the loose files in a folder into typed sub-folders (Images, Videos, Documents, …). Reversible.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Folder path or token, e.g. ~downloads.' } },
      required: ['dir']
    }
  },
  {
    name: 'type_text',
    actionType: 'type-text',
    description: 'Type text into the currently focused window.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to type.' } },
      required: ['text']
    }
  },
  {
    name: 'send_hotkey',
    actionType: 'hotkey',
    description: 'Send a keyboard shortcut to the focused window, e.g. "ctrl+s" or "alt+tab".',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'The hotkey combination.' } },
      required: ['keys']
    }
  },
  {
    name: 'read_screen',
    actionType: 'read-screen',
    description: 'Capture the screen and return any visible text, extracted via OCR.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'see_screen',
    actionType: 'screenshot',
    description:
      'Capture the screen as an image and look at it. Use this when you need to actually SEE what is on screen — UI layout, icons, charts, viewports, anything visual that OCR alone cannot describe. The image is attached to your next reasoning step.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'move_mouse',
    actionType: 'move-mouse',
    description:
      'Move the mouse cursor to absolute screen coordinates (pixels from the top-left of the primary display). Pair with `see_screen` first to locate where you want to point.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixel x-coordinate.' },
        y: { type: 'number', description: 'Pixel y-coordinate.' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'click_mouse',
    actionType: 'mouse-click',
    description:
      'Click the mouse at its current position. Defaults to a left click; pass `button: "right"` for a context click.',
    parameters: {
      type: 'object',
      properties: {
        button: { type: 'string', description: '"left" (default) or "right".' }
      },
      required: []
    }
  },
  {
    name: 'web_search',
    actionType: 'web-search',
    description:
      'Search the live web for up-to-date information. Returns up to 5 source results (title, URL, snippet) plus — when a Tavily key is configured — a quick AI-summarised answer. Use for any question about current events, recent docs, or facts the model may not know. Works out of the box via DuckDuckGo; Tavily upgrade in Settings → Integrations adds ranked results and the quick-answer summary.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        max_results: { type: 'number', description: 'Number of results to return (1-10, default 5).' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    actionType: 'web-fetch',
    description:
      'Download a specific URL and extract its readable main content (strips nav/script/style, decodes entities, preserves paragraphs). Use when you already know the page to read — after a web_search, or when the user pastes a link. Returns plain text capped at ~32k chars. No API key required.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to fetch.' }
      },
      required: ['url']
    }
  },
  {
    name: 'generate_image',
    actionType: 'generate-image',
    description:
      'Generate an image from a text prompt. Default `provider` is "auto" — picks the best backend the user has configured (Stability AI > DALL·E > Imagen > Pollinations), so it works with zero setup. Explicit options: "stability" (Stable Diffusion 3 Core, needs key), "openai" (DALL·E 3, needs key), "gemini" (Imagen 3, needs key), "pollinations" (Flux, no key, no signup — used as the free fallback). Saves the PNG to the data folder and returns the file path + a data URL the chat will render inline.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
        provider: {
          type: 'string',
          description:
            '"auto" (default, picks best available), "stability", "openai", "gemini", or "pollinations" (no-key fallback).'
        },
        size: {
          type: 'string',
          description: '"1024x1024" (default, square), "1792x1024" (wide), or "1024x1792" (tall). Stability + Gemini map this to closest aspect ratio.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'run_python',
    actionType: 'run-python',
    description:
      'Execute Python in an isolated temporary directory using the system interpreter. Captures stdout + stderr. Use for data crunching, quick math, generating files, anything Code-Interpreter-shaped. The temp dir is wiped after the run. Timeout 30s default, 2min max.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute.' },
        timeout_ms: { type: 'number', description: 'Override the 30s default (max 120000).' }
      },
      required: ['code']
    }
  }
]

const BY_NAME = new Map(TOOL_SPECS.map((t) => [t.name, t]))

export function toolSpecByName(name: string): ToolSpec | undefined {
  return BY_NAME.get(name)
}
