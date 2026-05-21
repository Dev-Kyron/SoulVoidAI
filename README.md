<div align="center">

# 🟣 VoidSoul Assistant

### *The Jarvis loop, finally local.*

A floating, always-on AI desktop assistant that talks, listens, sees your screen, drives your mouse, opens your apps, edits your files, and remembers every conversation.
Bring whichever AI you already love — **12 providers, one interface** — and give it a body.

[**Download**](https://github.com/Dev-Kyron/SoulVoidAI/releases) · [Privacy](PRIVACY.md) · [Terms](TERMS.md) · [Report an issue](https://github.com/Dev-Kyron/SoulVoidAI/issues/new)

</div>

---

```
   ◍   collapsed orb   ──summon (Ctrl+Shift+Space)──►   ▢   command panel
                                                          │
                            ┌─────────────────────────────┼─────────────────────────────┐
                            ▼                             ▼                             ▼
                          Nexus                          Chat                         Quick AI
                       radial HUD                threaded conversations          one-shot answer
                  modes · projects · tools        agent · vision · voice          Ctrl+Shift+J
```

---

## 🆕 What's new in v1.1.0

Two big systems landed in this release.

**Auto-routing across providers.** Configure Anthropic + OpenAI + Gemini + Ollama and the assistant picks the right one per task. Attach a screenshot → routed to a vision model. Agent loop with 20+ tool calls → routed to a fast tool-use model (Sonnet, not Opus). Near your monthly budget cap → routed to local. You never touch the picker; your per-thread sticky overrides still win when you want manual control.

**Long-running task resilience.** Agent runs now survive crash / restart / sleep / panel-close. Every step persists a checkpoint to SQLite; a recovery banner on the next launch offers to resume from where you stopped. The 30-step ceiling is up from 6. Rolling-summary compaction lets sustained runs fit in the model's context window. Close the panel and walk away — the tray shows live `⚙ step 23` progress, the loop keeps running, and when you come back the doc is in your thread.

**Other improvements**

- Step-cap pause UX — clear "type continue to resume" instead of silent half-done bubble
- Provider `stop_reason` / `finish_reason` surfaced as real errors (was silent truncation)
- 120s invoke timeout — hung providers no longer block the agent loop forever, friendly error message instead of `AbortError`
- Cost dashboard signal feeds into routing — near-cap users auto-fall-back to free/local
- Graceful pause-on-quit — closing the app while runs are live marks them as paused, not crashed

---

## Why VoidSoul

Today's AI apps split awkwardly:

- **Cloud chatbots** can't touch your machine.
- **Editor copilots** are trapped in one IDE.
- **Closed ecosystems** lock you to one vendor and one model.

VoidSoul is the third path — a single persistent assistant that's always there, can do real work on your computer, speaks every major model, never sends your data anywhere you didn't tell it to, and grows with you through plugins, MCP servers, and per-mode memory.

> **It's not a better chatbot. It's an operating layer that turns whatever AI you pay for into Jarvis.**

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🧠 Four-layer memory
- Persistent **threaded chats** — name, pin, search
- **Cmd/Ctrl+F** cross-thread full-text search
- Auto **"story-so-far"** summaries for long chats
- Durable **facts** (auto-extracted, mode-taggable)
- **RAG** over chat history *and* indexed files

### 🤖 Agent mode
- 18 built-in tools: open apps, run shell, read/write files
- Drive mouse + keyboard · OCR · vision screen-read
- Run Python in a sandboxed tmp dir
- Web search (DuckDuckGo) · web fetch with readability
- Image generation (Pollinations, DALL·E, Stable, Imagen)
- Multi-step chains, **live progress** (`Searching the web…`)
- Permission-gated · undoable file writes · per-request abort

### 👁️ Vision
- `see_screen` captures your screen **as an image**
- Vision-capable models look at it directly
- Vision-flag badge in the model picker
- Image attachments via paste, drag-and-drop, or file picker
- Inline PDF preview alongside chat

### 🎙️ Voice
- Hands-free Jarvis loop — wake word, listen, reply
- **Local Whisper** STT (no key needed) + OpenAI/Gemini fallback
- **Barge-in**: speak mid-reply, TTS stops, mic resumes
- Two TTS personas — **Void** (male), **Soul** (female)
- Wake word: keyless Whisper-based or Porcupine (upgrade)

### 🪟 Quick AI
- Raycast-style global overlay — **Ctrl+Shift+J**
- One-shot answer, no thread, no config — works anywhere
- Stream + copy + clipboard-as-context

</td>
<td width="50%" valign="top">

### 🔌 MCP — pluggable tools
- First-class **Model Context Protocol** client
- Add any community MCP server from a GUI form
- Tested with Filesystem, GitHub, custom UE5 bridge
- One-click reconnect, per-server tool routing

### 🌐 Multi-provider
**12** providers, one interface:
OpenAI · Anthropic · Gemini · **Ollama** · **LM Studio** · **llama.cpp** · Groq · xAI · OpenRouter · DeepSeek · Mistral · Custom OpenAI-compatible

- **Auto-detects** local Ollama / LM Studio / llama.cpp on boot
- **Multi-model per thread** — pick a different model for each conversation
- Vision-capable models flagged in the picker
- **Cost dashboard** — daily-spend chart, per-model breakdown, budget alerts at 75/90/100%

### 📁 Projects & Notebooks
- **Projects** with pinned mode + custom instructions, à la Claude
- **Notebooks** — `prompt`, `python`, `search`, `markdown` cells
- **Artifacts canvas** — long code blocks pop out into a live, expandable panel as they stream
- **Scheduled tasks** — fire prompts on a cron

### 🎨 Polish
- **Light + dark + system** theme
- **4 locales**: English · Español · Deutsch · 日本語
- **Interactive onboarding** — tasks tick themselves as you do them
- **Markdown** with KaTeX math, Mermaid diagrams, highlight.js syntax colours
- **Six workflow modes** — Indie Dev · Creator · Streamer · Researcher · Writer · Productivity

### 🔒 Local-first
- **No telemetry. No cloud. No subscription floor.**
- API keys → OS keychain (DPAPI/Keychain/libsecret)
- Chat, embeddings, files → local SQLite + filesystem
- **Private mode** — per-chat: no save, no facts, no screen
- One-click export · sync-folder backup · GitHub gist share

</td>
</tr>
</table>

---

## 🚀 Get started

### Download

Grab the latest installer from the [**Releases page**](https://github.com/Dev-Kyron/SoulVoidAI/releases):

- **Windows** — `VoidSoul Assistant Setup *.exe` (NSIS installer)
- **macOS** — `VoidSoul Assistant-*.dmg`
- **Linux** — `VoidSoul Assistant-*.AppImage`

Updates arrive **automatically** — VoidSoul checks GitHub Releases on boot and notifies you when a new version is ready. Settings → About → *Check for updates* triggers a manual check.

> First-launch heads-up: Windows SmartScreen may flag the installer because it's not yet code-signed. Click **More info → Run anyway** to install. macOS users: right-click the `.dmg` → **Open** the first time. Code-signed builds land once the initial-release budget covers the certificate.

### First boot

1. Pick a workflow **mode** (Indie Dev · Creator · Streamer · Researcher · Writer · Productivity) and a Nexus layout
2. The **interactive checklist** walks you through: send a message → press Cmd+F → open mic → open Settings
3. Either install **Ollama** ([ollama.com/download](https://ollama.com/download)) and VoidSoul auto-detects it for free local chat, or paste a provider key in **Settings → AI Providers**

That's it. The orb is alive.

---

## 🧠 The memory stack

| Layer | What it remembers | When it triggers |
|---|---|---|
| **Threads** | Every message, every conversation. Named, pinned, full-text searchable across the whole history. | Always on (unless **Private mode** is toggled per chat). |
| **Projects** | Pinned mode + instructions that auto-prepend to every thread in the project. | Per project; per-thread overrides win. |
| **Story-so-far** | Prose recap of older messages in a long conversation, injected into the system prompt. | When estimated tokens exceed ~10k and the chat has ≥8 messages. Cached, regenerated only when stale. |
| **Facts** | Short, durable bullets ("user is solo dev of Spiritless in UE5"). Mode-taggable, capped at 50. | Auto-extracted after every reply (toggleable). Manual entry from Settings → Memory. |
| **RAG** | Embeddings of every persisted message + any indexed files (PDFs, DOCX, code, text). | On every send: retrieves top-K relevant snippets, injects into the system prompt. |

The five layers compose without stepping on each other. Short chats use only Threads; medium ones add Story-so-far; long-history users get RAG; Facts thread through all of them; Projects override the baseline.

---

## 🤖 Agent mode — 18 built-in tools + MCP

Toggle **Agent** in the chat header. The model can call any of these, plus every MCP tool from every connected server:

| Tool | Permission | What it does |
|---|---|---|
| `open_app` · `open_url` · `open_folder` | `appControl` · `browser` · `filesystem` | Launch apps, open links and folders |
| `run_shell` | `terminal` | Run shell commands, capped output |
| `list_files` · `read_file` · `write_file` · `organize_folder` | `filesystem` | File I/O (writes are reversible via undo) |
| `type_text` · `send_hotkey` | `inputAccess` | Drive keyboard into any focused window |
| `move_mouse` · `click_mouse` | `inputAccess` | Precise cursor control |
| `read_screen` | `screenCapture` | OCR the screen to text via Tesseract |
| `see_screen` | `screenCapture` | Capture the screen and **look at it** as an image |
| `web_search` | — | DuckDuckGo (keyless) or Tavily (upgrade) |
| `web_fetch` | — | Pull a URL, extract the main content (readability + SSRF guard) |
| `run_python` | `terminal` | Run Python in a sandboxed tmp dir, capped output |
| `generate_image` | — | Pollinations (keyless), DALL·E 3, Stable Diffusion 3, Gemini Imagen 3 |

Plus your **MCP servers**, your **plugin actions**, and any tool you wire in. The agent loop is capped at six steps per turn, runs non-streaming for accuracy, surfaces **live progress** (`Searching the web: "metal vs vulkan"…`), preserves partial content on user-stop, and logs every step to the **Logs** tab — filterable by level + category, searchable.

---

## 👁️ Vision + 🖱️ Input Access

With a vision-capable model (Claude 3+ · GPT-4o · Gemini 1.5+ · LLaVA · MiniCPM-V · Grok-2 vision), `see_screen` captures your screen and attaches the image to the model's next reasoning step — it *looks*, not just OCRs.

Combine with mouse control for true GUI work:

> *"Take a screenshot, find the Build button in the toolbar, click it."*

The agent does: `see_screen` → identifies pixel coordinates → `move_mouse(x, y)` → `click_mouse()`. **The full hands-free loop.**

The model picker flags vision-capable models with an emerald **eye** icon so you never accidentally attach an image to a text-only model — and the composer warns if you do.

---

## 🎙️ Voice — fully local by default

- **Wake word:** keyless local Whisper engine that matches arbitrary phrases ("Hey Void", "Soul"), or upgrade to Porcupine for lower CPU.
- **STT:** local Whisper-tiny via `@xenova/transformers` (no API key needed) — falls back to OpenAI Whisper / Gemini if you've configured them and want quality.
- **TTS:** OS speech-synthesis with named personas — **Void** (male) and **Soul** (female).
- **Barge-in:** speak mid-reply — TTS stops, the mic auto-opens. Same UX shape as ChatGPT voice mode.
- **DND / quiet hours:** auto-suppress voice between configured times.

The default voice loop runs **without sending a byte of audio off your machine.**

---

## 🔌 MCP — the pluggable tool ecosystem

VoidSoul speaks the **Model Context Protocol** as a client. Add any MCP server — community or custom — from **Settings → MCP Servers**:

```
Name:    Filesystem
Command: npx
Args:    -y @modelcontextprotocol/server-filesystem C:\Path\To\Project
```

Click *Add & start*. Its tools instantly become callable by the agent. No code changes, no rebuilds.

Tested out of the box with:

- 🗂️ **Filesystem** — search, read, write, list (14 tools)
- 🐙 **GitHub** — issues, PRs, commits, gists, search (26 tools)
- 🎮 **Unreal Engine 5** — custom bridge bundled with the install

---

## 🌐 Multi-provider — bring your own AI

| Provider | Notes |
|---|---|
| **Anthropic Claude** | Opus 4.7, Sonnet 4.6/4.5, Haiku 4.5, Claude 3 — vision |
| **OpenAI** | GPT-4o, GPT-4.1, o1, o3-mini — vision |
| **Google Gemini** | 2.0 Flash/Pro, 1.5 Pro/Flash — vision |
| **Ollama** *(local)* | Auto-detected on port 11434. Llama, Qwen, Phi, Mistral, LLaVA, Moondream |
| **LM Studio** *(local)* | Auto-detected on port 1234. Any model you've loaded |
| **llama.cpp** *(local)* | Auto-detected `llama-server` on port 8080. Any GGUF |
| **Groq** | Blisteringly fast — Llama, Mixtral |
| **xAI Grok** | Grok-2, Grok-2 Vision |
| **OpenRouter** | Aggregator — try almost anything |
| **DeepSeek** | Strong coder models |
| **Mistral** | Mistral Large, Codestral |
| **Custom** | Any OpenAI-compatible endpoint |

Switch providers mid-conversation; threads, memory, and tools follow. Pick a **different model per thread** for "this one's for vision, this one's for cheap code Q&A".

---

## 💰 Cost tracking

Every API call is metered, priced against the current model table, and surfaced in **Settings → Usage & Cost**:

- Month-to-date total + per-model breakdown
- Daily-spend bar chart for the current month
- Provider-share stacked bar with legend
- Monthly budget with progress bar + toast alerts at 75/90/100%
- Recent-calls list with tokens in/out per call

Token counts are estimates from text length unless the provider reports actuals; the actual bill takes precedence. Local providers (Ollama / LM Studio / llama.cpp / custom) are zero-priced.

---

## 🔒 Privacy & permissions

VoidSoul never acts silently. Each capability maps to a permission you grant explicitly and can revoke at any time:

| Permission | Unlocks | Risk |
|---|---|---|
| `terminal` | Running shell commands · Python | High |
| `filesystem` | Reading / writing / organising files | High |
| `browser` | Opening URLs | Low |
| `appControl` | Launching apps, foregrounding windows | Medium |
| `inputAccess` | Keyboard + mouse control | High |
| `microphone` | Voice input | Medium |
| `screenCapture` | Screenshots, OCR, vision | Medium |

### Private mode

Toggle the **shield** icon in the chat header. The current conversation:

- Isn't persisted to disk
- Doesn't trigger fact extraction
- Suppresses the screen-awareness line in the system prompt

For sensitive material — IP, personal data, anything you don't want lingering on disk.

### Where your data lives

Everything lives in a local data folder (Settings → About → *Open data folder*) backed by SQLite for chat history + plain JSON for config / memory / plugins / MCP servers. API keys are encrypted via Electron `safeStorage` (Windows DPAPI / macOS Keychain / Linux libsecret) and never leave the main process.

See **[PRIVACY.md](PRIVACY.md)** for the full policy — short version: nothing leaves your computer unless you trigger an action that explicitly sends it.

### Backup & sync

**Settings → Backup & Sync** exports the whole setup (config · memory · plugins · chat history · usage · scheduled tasks · MCP servers) as one portable JSON — or writes it to a chosen folder. Point that folder at Dropbox / OneDrive / Google Drive and you have **de-facto cloud sync, using your own cloud**. API keys are deliberately excluded; re-enter them on each machine.

---

## 🧩 Plugins

A plugin is a **declarative JSON workflow pack** — drop a `.json` file into the plugins folder (Settings → Plugins → *Open folder*). It contributes permission-gated quick actions built from the existing action types; it cannot execute arbitrary code, so a plugin is never more dangerous than the actions it bundles.

```jsonc
{
  "id": "spiritless-pack",
  "name": "Spiritless",
  "version": "1.0.0",
  "author": "your-name",
  "description": "Shortcuts for my UE5 game.",
  "quickActions": [
    {
      "id": "open-engine",
      "label": "Open UE5",
      "icon": "Gamepad2",
      "description": "Launch the editor on Spiritless.",
      "requires": "appControl",
      "action": {
        "type": "open-app",
        "params": { "app": "C:/Epic/UE_5.4/Engine/Binaries/Win64/UnrealEditor.exe" }
      }
    }
  ]
}
```

Invalid manifests surface their validation error rather than being silently dropped.

---

## ⌨️ Keyboard shortcuts

| Shortcut | What |
|---|---|
| `Ctrl/Cmd + Shift + Space` | Summon / hide the widget |
| `Ctrl/Cmd + Shift + J` | Open the **Quick AI** overlay from anywhere |
| `Ctrl/Cmd + F` | Cross-thread search |
| `Ctrl/Cmd + K` | Command palette |
| `Enter` | Send a message |
| `Shift + Enter` | Newline in the composer |
| `Esc` | Close any open dialog |

---

## 🆚 vs. the vendor apps

VoidSoul **uses** ChatGPT, Claude, Gemini, and the rest under the hood — it doesn't replace them. It gives them a **body** they don't have:

|  | VoidSoul | ChatGPT Desktop | Claude Desktop | Raycast | LM Studio |
|---|:---:|:---:|:---:|:---:|:---:|
| Multi-provider in one app | ✅ 12 | ❌ | ❌ | ✅ | ❌ |
| Open / drive YOUR apps & files | ✅ | sandbox | beta | ❌ | ❌ |
| See your real screen | ✅ | ❌ | beta | ❌ | ❌ |
| Drive mouse + keyboard | ✅ | ❌ | beta | ❌ | ❌ |
| MCP support | ✅ GUI | ❌ | ✅ JSON | ❌ | ✅ |
| Local-first defaults | ✅ | ❌ | ❌ | ❌ | ✅ |
| Memory across vendors | ✅ | ❌ | ❌ | ❌ | ❌ |
| Floating orb / global hotkey | ✅ | ❌ | ❌ | Mac only | ❌ |
| Workflow modes | ✅ 6 | ❌ | ❌ | ❌ | ❌ |
| Custom plugins | ✅ | limited | ⚠️ | ✅ | ❌ |
| Voice loop (wake → STT → reply → TTS) | ✅ local | partial | ❌ | ❌ | ❌ |
| Cost tracking dashboard | ✅ | ❌ | ❌ | ❌ | ❌ |
| Per-token cost only | ✅ | $20/mo | $20/mo | $8/mo | free |

Use the official apps for their sandboxed exploration. Use VoidSoul when you want the AI to **actually do things** in your environment.

---

## 🧪 Tested against

- **Windows 11** (primary target — automation paths are Windows-tuned)
- **macOS 14+** (Apple Silicon + Intel)
- **Ubuntu 22.04** (AppImage)
- **Models used in agent mode:** Claude Sonnet 4.5, GPT-4o, Gemini 2.0 Flash, Qwen 2.5 7B (Ollama)
- **MCP servers:** `@modelcontextprotocol/server-filesystem`, `@modelcontextprotocol/server-github`, the bundled UE5 bridge

---

## 🛣️ Roadmap

**Shipped:** local Whisper STT, wake word, voice barge-in, vision flag, agent live progress, PDF inline preview, GGUF / llama.cpp detection, multi-model per thread, settings backup, light theme, i18n (4 locales), interactive onboarding, math/mermaid/syntax-highlight markdown, Cmd+F cross-thread search, cost dashboard with charts, share-to-gist, auto-updater, privacy + terms.

**Queued:**

- **Persistent Python sandbox** with file workspace (Jupyter-style across runs)
- **Computer-use mode** — autonomous goal-driven loop, not one tool at a time
- **Deep-research mode** — multi-step plan → search → fetch → cite
- **Vector-store browser** — visual RAG corpus management
- **Mobile companion** — iOS first, sync threads
- **Browser extension** — chat overlay on any page
- **Code signing** + notarisation (Windows EV cert + Apple Developer Program)
- **Hosted share URLs** at `share.voidsoulstudio.com` (replace gists)
- **Team workspace** — shared projects, SSO, audit log
- **Plugin / theme marketplace**
- **Localization expansion** — Chinese, Korean, French, Portuguese

---

## 📜 Legal

- **Binary distribution & use:** governed by [**Terms of Service**](TERMS.md).
- **Privacy:** see [**Privacy Policy**](PRIVACY.md). Short version: nothing leaves your computer unless you trigger an action that explicitly sends it.
- **Bug reports & feedback:** [open an issue](https://github.com/Dev-Kyron/SoulVoidAI/issues/new).

VoidSoul Assistant is © Void Soul Studio. Distribution of the compiled application is governed by the Terms of Service linked above. Re-selling, re-distributing, or hosting the application as a service requires written permission.

---

<div align="center">

**Built solo. Local-first. The AI you already love, with a body.**

*Talk to the orb.*

</div>
