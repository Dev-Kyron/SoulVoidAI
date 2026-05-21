# VoidSoul Assistant — Terms of Service

_Last updated: 21 May 2026_

These terms govern your use of the **VoidSoul Assistant** desktop application ("the Software"). By installing or using the Software you agree to them. If you do not agree, do not install or use the Software.

If anything here is unclear, contact us before relying on the Software for anything you can't afford to lose.

## 1. Plain-English summary

- The Software is licensed to you, not sold. You can use it on your own computer for personal or commercial work, subject to the rest of these terms.
- The Software connects to third-party AI providers using credentials you supply. You — not us — are responsible for those provider accounts, the bills they generate, and what you do with the responses.
- The Software can run automation tools (open apps, run shell commands, read files, control the mouse) when you grant the corresponding permission. You are responsible for what you ask it to do.
- The Software is provided **as-is**, without warranty. Use it at your own risk.

## 2. Who we are

The Software is developed by Kyron ("we", "us", "our"). Source code is available at <https://github.com/Dev-Kyron/SoulVoidAI>.

## 3. License grant

We grant you a worldwide, non-exclusive, non-transferable, revocable licence to install and use the Software on devices you own or control, subject to these terms. The source code in the public repository is published under a **source-visible proprietary licence** (see `LICENSE`) — it is not open-source. The terms here apply to the **compiled, distributed application binaries** and any premium features that may be added in future.

You may not:

- Resell, sub-license, rent or lease the Software as a hosted service without our written permission.
- Remove or alter copyright, attribution or licence notices.
- Use the Software to violate any law or any third party's rights.
- Use the Software to build a directly competing commercial product by lifting substantial portions of its code without complying with the underlying source licence.

You may:

- Use the Software for any personal or commercial purpose, including in a workplace.
- Inspect and build the source for your own personal, non-commercial use, subject to `LICENSE`.
- Run the Software on multiple devices that you personally control under a single licence (we don't track devices).

## 4. Third-party AI providers and services

The Software is a client. When you connect it to an AI provider (OpenAI, Anthropic, Google Gemini, Groq, xAI, OpenRouter, DeepSeek, Mistral, Ollama, LM Studio, llama.cpp, or any custom endpoint) **you have entered a separate agreement with that provider**, and:

- You are responsible for keeping your API keys and accounts in good standing.
- You are responsible for all charges those providers bill you. The cost-tracking dashboard in the Software is an **estimate**; actual provider bills take precedence.
- You are responsible for using each provider in line with its own terms of service, acceptable-use policy, and privacy policy.
- We have no visibility into, control over, or responsibility for the outputs returned by these providers, including factual accuracy, safety, bias, or copyright status.
- If a provider terminates your account, throttles your access, changes pricing, or changes its API surface in a way that breaks an integration, that is a matter between you and them.

Optional third-party services touched by the Software (GitHub for updates and gist sharing, DuckDuckGo or Tavily for web search, Pollinations for image generation, Picovoice for Porcupine wake-word, Whisper via Hugging Face for local transcription model download) are likewise governed by their own terms.

## 5. Agent tools and permissions

The Software ships with automation tools that, when enabled and permission-granted, can perform actions on your computer including (but not limited to):

- Opening applications and URLs
- Running shell commands
- Reading, writing, and reorganising files
- Capturing the screen and reading on-screen text
- Moving the mouse, clicking, and typing
- Connecting to and invoking MCP server tools you configure

Each capability is gated behind a permission you explicitly grant on first use. You can revoke permissions in Settings at any time.

**You are solely responsible for the consequences of any action you ask the Software to perform, including any action it takes through an AI model.** AI models can misinterpret instructions, hallucinate, follow injected prompts in external content, or otherwise behave unexpectedly. Before using agent tools to modify files, send messages, run shell commands, or interact with paid services, ensure you have backups and budgets in place that you are comfortable with.

We strongly recommend treating the agent like a junior colleague you do not entirely trust: assume it might do the wrong thing, design around that assumption, keep backups, and review its work.

## 6. Local data

The Software stores chat history, memory, embeddings, indexed-file embeddings, settings, and logs in a folder on your computer. **You are responsible for backing up that folder** if the data matters to you. The Software offers an export/import flow and a sync-folder option but does not run any cloud backup on your behalf.

## 7. Updates

The Software may check for and download updates from GitHub Releases. We may publish updates that change, remove, or add functionality at our discretion. We try not to break things, but we do not guarantee that a feature available in one version will be available in a later one.

You can opt out of automatic updates by disabling the check in Settings (where available) or by blocking network access; in either case, you accept the risk of running an out-of-date version.

## 8. Beta / experimental features

Features marked as beta, experimental, preview, or similar are provided for testing. They may behave unpredictably, lose data, or be removed without notice. Do not rely on them for production work.

## 9. Acceptable use

You agree not to use the Software to:

- Harass, defame, harm, defraud, surveil, or stalk anyone.
- Generate child sexual abuse material, non-consensual sexual content, or content depicting real people in deceptive ways.
- Infringe copyright, trademark, trade-secret, or other intellectual-property rights.
- Build weapons, malware, or systems primarily intended to cause harm.
- Violate the terms of any AI provider, MCP server, or service the Software connects to.
- Violate any law that applies to you.

This list is illustrative, not exhaustive. If you are not sure whether a use is acceptable, the safer answer is no.

## 10. No warranty

THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ANY WARRANTY ARISING FROM COURSE OF DEALING OR USAGE OF TRADE. WE DO NOT WARRANT THAT THE SOFTWARE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF HARMFUL COMPONENTS, NOR THAT ANY DEFECTS WILL BE CORRECTED.

## 11. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL WE OR ANY CONTRIBUTOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, EXEMPLARY OR PUNITIVE DAMAGES (INCLUDING LOST PROFITS, LOST DATA, BUSINESS INTERRUPTION, OR COSTS OF SUBSTITUTE GOODS OR SERVICES) ARISING OUT OF OR IN CONNECTION WITH THESE TERMS OR THE SOFTWARE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

OUR TOTAL CUMULATIVE LIABILITY UNDER THESE TERMS IS LIMITED TO THE GREATER OF (A) THE AMOUNT YOU PAID US FOR THE SOFTWARE IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR (B) US $25.

Some jurisdictions do not allow the exclusion of certain warranties or the limitation of certain damages, in which case the above exclusions and limits apply to the maximum extent permitted by law in your jurisdiction.

## 12. Indemnity

You agree to indemnify and hold us harmless from any claim, demand, loss, or damage (including reasonable legal fees) made by any third party arising out of (a) your use of the Software, (b) your breach of these terms, or (c) your violation of any rights of another. We will tell you promptly about any such claim and let you control the defence (provided you do not settle in a way that admits liability on our behalf without our consent).

## 13. Termination

You may stop using the Software and uninstall it at any time. We may suspend or terminate your licence if you materially breach these terms (for example, by violating Section 9). On termination, you must stop using the Software and may delete your local data. Sections 4, 6, 10, 11, 12, 14, and 15 survive termination.

## 14. Changes to these terms

We may update these terms when the Software changes materially or to keep them current. Material changes will be noted in the release notes of the version that introduces them and the "Last updated" date above will be revised. Continued use of the Software after a material change constitutes acceptance of the revised terms.

## 15. Governing law

These terms are governed by the laws of the jurisdiction in which we are established, without regard to its conflict-of-laws principles. _(If you are in the EU/UK, mandatory consumer-protection rules of your country of residence still apply where they would otherwise be displaced by this clause.)_

_Replace this section with your actual governing law and jurisdiction (e.g. "the laws of England and Wales") before you ship paid licences._

## 16. Contact

Email: `hello@voidsoul.app` _(replace with your actual contact)_
Repository: <https://github.com/Dev-Kyron/SoulVoidAI>

---

These terms apply to the binary distribution of VoidSoul Assistant. The source code in the public repository is licensed under a separate proprietary licence — see the `LICENSE` file.
