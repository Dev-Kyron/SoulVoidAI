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
    description:
      'List files and folders inside ANY directory on the user\'s machine. USE THIS for any local folder path the user mentions — Windows (`C:\\Users\\…`, `D:\\Projects\\…`), POSIX (`/home/me/…`, `/Users/me/…`), or shorthand (`~/Downloads`, `~documents`). NEVER refuse with "I can\'t access that folder" — the user has filesystem permission granted, this tool has no folder allowlist, and this is the tool that does the listing. Prefer this over the MCP filesystem server (sandboxed to one folder) when the path is outside that sandbox.',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description:
            'Absolute folder path, e.g. `C:\\Users\\me\\Projects` or `/home/me/code`. Tokens: ~home ~downloads ~desktop ~documents ~videos ~pictures ~music.'
        }
      },
      required: ['dir']
    }
  },
  {
    name: 'read_file',
    actionType: 'file-read',
    description:
      'Read the text contents of ANY file on the user\'s machine and return them. USE THIS for any local file path the user mentions — Windows, POSIX or home-shorthand paths all work. NEVER refuse with "I can\'t access that file" or "I don\'t have permission" — the user has filesystem permission granted, this tool has no folder allowlist, and it is the canonical way to read a local file. If a sibling MCP filesystem tool refused the same path because it was outside its sandbox, retry here.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute file path, e.g. `C:\\Users\\me\\notes.md` or `/Users/me/src/index.ts`.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    actionType: 'file-write',
    description:
      'Write text to ANY file on the user\'s machine. Existing contents are preserved for undo, and the user gets a diff preview before the change applies. USE THIS whenever the user asks you to create, save, edit, or update a file at a real path — Windows, POSIX or home-shorthand all work. NEVER refuse with "I can\'t write to that location" — the user has filesystem permission granted and the diff-preview UI is their approval surface, not yours.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute file path. Parent directory must exist; the file is created if it doesn\'t.'
        },
        content: { type: 'string', description: 'Full text content to write (replaces the file).' }
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
      'Capture the screen as an image and look at it. Use this ONLY when you need to DESCRIBE on-screen content back to the user — explain what they\'re looking at, summarise a chart, read an error dialog, comment on a UI layout. Do NOT use this as a step before clicking — `click_on_screen` already screenshots internally and is dramatically more reliable than asking you to compute coordinates yourself. The image is attached to your next reasoning step.',
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
    name: 'click_on_screen',
    actionType: 'visual-click',
    description:
      'YOUR TOOL for clicking anything visible in any app the user has open — sending messages, replying, posting, submitting, opening menus, closing dialogs. NEVER refuse with "I can\'t send messages on [app]" or "I can only help you prepare the message" — that was true before this tool existed; now your job is to click the Send button for them.\n\n' +
      'When the user says X, you call Y:\n' +
      '  · "Send the message to Kyron on Facebook" → click_on_screen({ what: "the Send button in the composer", in_window: "Messenger" })\n' +
      '  · "Send this on Discord" → click_on_screen({ what: "the Send button at the bottom of the channel", in_window: "Discord" })\n' +
      '  · "Reply on Slack" → click_on_screen({ what: "the Send button in the message composer", in_window: "Slack" })\n' +
      '  · "Send the email" → click_on_screen({ what: "the Send button", in_window: "Gmail" })\n' +
      '  · "Post this tweet" → click_on_screen({ what: "the Post button", in_window: "Twitter" })\n' +
      '  · "Submit the form" → click_on_screen({ what: "the Submit button", in_window: "Chrome" })\n' +
      '  · "Close this dialog" → click_on_screen({ what: "the X button to close the current dialog" })\n\n' +
      'Mechanics: tries Windows accessibility tree first (exact for native apps), falls back to vision on a screenshot. User sees a 3-second cancellable cyan-ring preview before the click fires — wrong locates fail safe (Esc to cancel). Don\'t call see_screen first; this tool screenshots internally. Don\'t pre-narrate; just call the tool.',
    parameters: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          description:
            'Specific description of the target element. Translate the user\'s natural phrasing into something a screen-reader would identify the element by. Include the surrounding context if multiple similar elements may be visible: "the blue Send button in the compose window at the bottom-right" beats "Send" when there could be more than one send-shaped thing on screen. Good descriptions are what locate accuracy depends on — name the visual distinguishing features (colour, position, surrounding text, icon shape).'
        },
        in_window: {
          type: 'string',
          description:
            'Optional window hint (app name OR window title fragment). When set, the tool enumerates visible windows, fuzzy-matches this string, brings that window to the foreground, and scopes the search to ONLY that window\'s content. ALWAYS specify this when the user named an app — "Messenger", "Discord", "Chrome", "VS Code", "Outlook", etc. Eliminates cross-window false positives. Omit when the user said "this window" / didn\'t name an app, OR when you want to search across all visible windows.'
        },
        button: {
          type: 'string',
          description: '"left" (default) or "right" for a context-menu click.'
        }
      },
      required: ['what']
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
  },
  {
    name: 'save_as_document',
    actionType: 'save-document',
    description:
      'Save the given content to a downloadable document file. Use this when the user asks to "save that as a Word doc / PDF / Excel sheet / markdown file" — turn whatever you just wrote (a script, a summary, a transcript fragment, a list) into a real file on their machine. Shows the system save dialog so the user picks the destination; you only supply the content + format + suggested filename.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'The full text/markdown content to save. For DOCX/PDF/HTML/MD/TXT this is the body; for XLSX, pass CSV-like rows (one row per line, columns separated by tabs or commas) and it will be tabulated.'
        },
        format: {
          type: 'string',
          description:
            'One of: "docx" (Word), "pdf", "xlsx" (Excel), "markdown", "txt", "html". Default "markdown" if the user is vague.'
        },
        filename: {
          type: 'string',
          description:
            'Suggested filename WITHOUT extension. The format-correct extension is appended automatically. Keep it short and human-friendly (e.g. "weekly-plan", not "weekly-plan-2026-05-23.docx").'
        },
        title: {
          type: 'string',
          description:
            'Optional document title shown as the heading at the top of DOCX/PDF/HTML. Defaults to the filename.'
        }
      },
      required: ['content', 'format', 'filename']
    }
  }
]

const BY_NAME = new Map(TOOL_SPECS.map((t) => [t.name, t]))

export function toolSpecByName(name: string): ToolSpec | undefined {
  return BY_NAME.get(name)
}
