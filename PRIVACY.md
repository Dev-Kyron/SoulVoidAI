# VoidSoul AI Companion — Privacy Policy

_Last updated: 24 May 2026_

VoidSoul AI Companion is a desktop application that runs locally on your computer. It is designed so that as little of your data as possible ever leaves your machine. This policy explains what that means in concrete terms.

If you have any questions, contact us at the address at the bottom of this page.

## 1. Plain-English summary

- VoidSoul AI Companion **does not have a server**. We do not run cloud infrastructure that your data passes through.
- We do not collect telemetry, usage analytics, crash reports, or any other "phone home" data by default.
- API keys for AI providers (OpenAI, Anthropic, Google, etc.) are encrypted using your operating system's keychain and never leave your computer.
- Your chat history, indexed files, embeddings, memory, and settings live in a local folder on your machine.
- When you send a message to an AI provider, your text and any attached images go **directly from your computer to that provider**. We never see it. The provider's own privacy policy applies to that exchange.
- Some optional features (sharing a chat as a GitHub gist, using a folder as a sync target, downloading a software update) connect to external services. Each is described below and only happens when you explicitly trigger it.

## 2. Who we are

VoidSoul AI Companion is developed by Void Soul Studio ("we", "us", "our"). The application is distributed as a desktop installer for Windows, macOS, and Linux. Source code is available at <https://github.com/Dev-Kyron/SoulVoidAI>.

## 3. What we collect — nothing, by default

We do not operate any server or analytics pipeline. We do not have a database of users. We do not see your conversations, your API keys, your files, your usage patterns, your machine identifier, or your location.

The application does not contain telemetry, crash reporting, or feature-usage tracking SDKs in its default configuration.

If we add such features in a future version, they will be **off by default and require explicit opt-in**, and this policy will be updated to describe them.

## 4. What stays on your computer

The following data is created and stored locally on your machine, in the operating-system-specific app-data folder (open it via Settings → About → Open data folder):

- **Chat history** — every conversation you have with the assistant, stored in a local SQLite database.
- **Memory** — long-term facts the app has extracted about you (when auto-memory is enabled in Settings).
- **Emotional context** (v1.4.0+, optional, default on) — when enabled, the app periodically reads your recent exchanges through a small fast model to track session sentiment (stressed / productive / stuck / excited / neutral) and stores the labels locally in the same SQLite database. The classifier call itself goes through your active AI provider (Anthropic / OpenAI / Gemini / a local model — your choice); the labels never leave your machine. You can disable this in Settings → Memory → Emotional context, and the same panel has a "Forget last 7 days" button that wipes the local sentiment rollups.
- **Embeddings** — numerical representations of your chat history and any folders you index, used for retrieval-augmented generation (RAG). Stored locally.
- **Indexed files** — when you enable file-RAG and point the app at a folder, its contents are chunked and embedded locally. The original files are not copied or moved.
- **Settings and preferences** — your provider configuration, modes, system prompts, custom actions, notebooks, projects, scheduled tasks, MCP server configs.
- **Logs** — diagnostic logs the app writes to a local file for troubleshooting.

None of this data is transmitted anywhere unless you explicitly trigger an action that sends it (see Section 6).

## 5. API keys and credentials

API keys for third-party AI providers are stored using your operating system's native credential vault:

- **Windows** — Credential Manager (DPAPI)
- **macOS** — Keychain
- **Linux** — Secret Service (gnome-keyring, KWallet, or libsecret)

The keys are encrypted at rest by the operating system and accessible only to your user account. They are never written to disk in plain text and never transmitted by the application except as part of the authenticated API request to the provider you configured them for.

## 6. Third-party AI providers

The whole point of VoidSoul is that it speaks to AI providers on your behalf. When you send a message:

1. The application packages your message, any attached images or files, the active system prompt, and conversation context.
2. It sends that package directly from your computer to the provider you have selected — OpenAI, Anthropic, Google Gemini, Groq, xAI, OpenRouter, DeepSeek, Mistral, a local Ollama/LM Studio/llama.cpp server, or a custom endpoint you configured.
3. The provider processes your request and returns a response.

We do not proxy, intercept, log, or otherwise touch this traffic. **The provider's privacy policy applies to whatever you send them.** We strongly recommend reading the privacy policy of any provider whose key you add. Notable points:

- OpenAI, Anthropic, and Google by default do not train on API traffic, but each has their own retention and review terms — verify on their site.
- Local providers (Ollama, LM Studio, llama.cpp) do not transmit your data outside your computer. If you want zero-network AI, use these.
- The "Pollinations" default image generator and "DuckDuckGo HTML" default web search route through their respective services. Each is opt-out by switching to a different provider in Settings.

## 7. Optional features that touch the network

The following features are off by default or only activate on a deliberate user action. Each is the only path by which the app sends data anywhere other than the chosen AI provider.

- **Update check.** On startup (and when you click "Check for updates" in Settings → About), the application asks <https://github.com> for the latest release metadata of the VoidSoul AI Companion repository. No user data is sent — only your IP address as part of the HTTP request, which GitHub processes under its own privacy policy.
- **Share to GitHub gist.** When you use the Share dialog to upload a conversation as a gist, the conversation contents are uploaded to GitHub using a personal access token you supply. We do not see this content.
- **Sync folder.** When you enable a sync folder, the application writes a backup file (`voidsoul-sync.json`) to a folder you choose. If that folder happens to be a Dropbox/iCloud/OneDrive folder, those services will sync the file according to their own terms. The app itself does not connect to any cloud sync service.
- **MCP servers.** When you connect to an MCP server, the application launches the server's process locally and exchanges messages with it. What that server does with the data is governed by the server's own behaviour and any third-party services it integrates with.
- **Wake-word / voice input / TTS.** Voice input is captured by your microphone and processed locally (using a Whisper model that runs on your CPU/GPU) by default. If you have selected a cloud STT provider in Settings, audio is sent to that provider. Text-to-speech uses your operating system's built-in voices and does not transmit text to any external service.
- **Web search and web fetch tools.** When the AI agent uses these tools, the application sends the query/URL to DuckDuckGo (or Tavily if you've configured a key) and fetches public web content. Neither service is told who you are beyond your IP address.

## 8. Children's privacy

VoidSoul AI Companion is not designed for use by children under 13. If you believe a child has provided personal information through the app to a third-party AI provider you have connected, please review that provider's data-deletion procedures.

## 9. Your rights

Because we hold no data about you, there is nothing for you to request, correct, or delete from us. To exercise your rights over data you have sent to a third-party AI provider, follow that provider's data-subject request process.

You can delete all of your local VoidSoul data at any time by:

- Deleting the app-data folder (visible in Settings → About → Open data folder), or
- Using the "Clear all threads" / "Clear usage history" / "Reset" controls in Settings.

## 10. Security

We use the operating system's native credential store for API keys and rely on the integrity of your machine's encryption-at-rest. We do not control the security of third-party AI providers — review theirs separately. If you discover a security issue in VoidSoul AI Companion, please report it to the address below privately rather than via a public issue tracker.

## 11. Changes to this policy

If we change this policy materially, we will note it in the release notes of the version that introduces the change and update the "Last updated" date above. Continued use of the application after such a change constitutes acceptance of the revised policy.

## 12. Contact

- **General:** `hello@voidsoulstudio.com` or open a GitHub issue at <https://github.com/Dev-Kyron/SoulVoidAI/issues/new>
- **Security reports:** Please use GitHub's private security advisory flow at <https://github.com/Dev-Kyron/SoulVoidAI/security/advisories/new> so the disclosure stays confidential until a fix is shipped.
- **Community Discord:** <https://discord.gg/Tn78RHqT4> — fastest non-security reply, ask questions, share feedback.
- **Repository:** <https://github.com/Dev-Kyron/SoulVoidAI>
