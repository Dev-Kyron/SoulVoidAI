/**
 * v2.0 — Browser Extension settings panel.
 *
 * Local-only bridge between the Chrome / Edge / Brave / Arc extension and
 * the running desktop app. The user flips the master switch here; main
 * spins up a per-OS local IPC server (Unix socket on Mac/Linux, Windows
 * named pipe) that the extension's native-messaging host script talks to.
 *
 * What the panel surfaces:
 *   - Enable toggle (writes config, starts/stops the server).
 *   - Live status: listening flag + connected-client count, kept fresh by
 *     subscribing to `events.onExtensionStatus`.
 *   - The OS-specific install command — copy-to-clipboard convenience so
 *     the user can paste it into a terminal without hunting for the
 *     `node tools/...` path themselves.
 *   - Native-host manifest + bridge script paths, surfaced for
 *     troubleshooting when something goes wrong.
 *
 * Stays opinionated: this panel only knows about the local-only path.
 * If we ever ship a hosted-bridge variant (we explicitly chose not to
 * for v2.0), it'd live in a separate sub-panel.
 */
import { useCallback, useEffect, useState } from 'react'
import { Copy, Check, ExternalLink, RefreshCw } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { copyToClipboard } from '../../lib/clipboard'
import { useUiStore } from '../../store/useUiStore'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import type { BrowserExtensionStatus } from '@shared/types'

const REPO_HOST_DIR = 'tools/browser-extension/native-host'
const REPO_EXT_DIR = 'tools/browser-extension/extension'
// v2.0 polish — the install command is a constant string (the user's
// extension id is a placeholder they substitute themselves), so build
// it once at module load rather than re-allocating per render.
const INSTALL_COMMAND = `node ${REPO_HOST_DIR}/install.mjs --extension-id YOUR_ID`

export function BrowserExtensionSettings(): JSX.Element {
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const pushToast = useUiStore((s) => s.pushToast)

  const refresh = useCallback(async () => {
    try {
      const next = await vs.browserExtension.status()
      setStatus(next)
    } catch (err) {
      pushToast(
        'error',
        `Couldn't read extension status: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }, [pushToast])

  // Subscribe to live status pushes so a native-host disconnect surfaces
  // instantly instead of waiting for the next manual refresh. The first
  // mount also fetches once so the chip lands populated even if no event
  // fires (server already running, no clients connected).
  useEffect(() => {
    void refresh()
    return vs.events.onExtensionStatus((next) => setStatus(next))
  }, [refresh])

  const onToggle = async (next: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await vs.browserExtension.setEnabled(next)
      setStatus(result)
      pushToast(
        'success',
        next
          ? 'Browser extension bridge enabled — listening locally.'
          : 'Browser extension bridge disabled.'
      )
    } catch (err) {
      pushToast(
        'error',
        `Couldn't ${next ? 'enable' : 'disable'} the bridge: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (label: string, text: string): Promise<void> => {
    // v2.0 polish — route through the shared `copyToClipboard` helper.
    // Raw `navigator.clipboard.writeText` silently rejects in Electron
    // when the Settings window has just lost OS focus (common during a
    // copy-button click that opens an OS-level confirmation), which
    // would otherwise flash "Copied" while nothing landed in the
    // clipboard. The helper bridges to Electron's native clipboard
    // module first and falls back to navigator only if the bridge is
    // unreachable.
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopied(label)
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500)
    } else {
      pushToast('error', "Couldn't copy to clipboard — copy it by hand from the field below.")
    }
  }

  return (
    <CollapsibleSection
      title="Browser Extension"
      hint="Local-only bridge to the VoidSoul Chrome / Edge / Brave / Arc extension. Highlight text on any page, hit a hotkey, get a reply inline."
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-slate-100">Enable bridge</p>
            <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
              Starts a per-user local IPC server. The extension can only talk to this socket — no
              remote server, no network traffic.
            </p>
          </div>
          {/* Toggle is a role=switch button — when busy or status hasn't loaded,
              we render an aria-disabled-looking variant by intercepting onChange. */}
          <Toggle
            checked={status?.enabled ?? false}
            onChange={(next) => {
              if (busy || !status) return
              void onToggle(next)
            }}
            label="Enable browser extension bridge"
          />
        </div>

        {status && (
          <div className="flex items-center gap-2 rounded-md border border-white/5 bg-black/20 px-2.5 py-1.5 text-[11px]">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                status.listening ? 'bg-emerald-400' : 'bg-slate-500'
              }`}
            />
            <span className="text-slate-200">{status.listening ? 'Listening' : 'Idle'}</span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400">
              {status.connectedClients} client{status.connectedClients === 1 ? '' : 's'} connected
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              title="Refresh status"
              aria-label="Refresh extension bridge status"
              className="ml-auto rounded p-1 text-slate-400 transition hover:bg-white/5 hover:text-white"
            >
              <RefreshCw size={11} />
            </button>
          </div>
        )}

        {/* Install instructions — surfaced even when the toggle is off so
            users can see what they'll be doing before flipping the switch. */}
        <div className="rounded-lg border border-white/5 bg-black/20 p-3 text-[11px] leading-snug text-slate-300">
          <p className="font-semibold text-slate-100">One-time install</p>
          <ol className="mt-2 ml-4 list-decimal space-y-1.5 text-slate-300">
            <li>
              Load <code className="rounded bg-white/5 px-1">{REPO_EXT_DIR}</code> as an unpacked
              extension in <code className="rounded bg-white/5 px-1">chrome://extensions</code>{' '}
              (developer mode on).
            </li>
            <li>
              Copy the extension id Chrome shows (32 lowercase letters under the extension name).
            </li>
            <li>
              Run the install command below in a terminal, replacing
              <code className="ml-1 rounded bg-white/5 px-1">YOUR_ID</code> with the extension id
              from step 2.
            </li>
            <li>Restart your browser.</li>
          </ol>
          <div className="mt-2 flex items-center gap-2 rounded-md bg-black/40 px-2 py-1 font-mono text-[10px] text-amber-200">
            <span className="grow break-all">{INSTALL_COMMAND}</span>
            <button
              type="button"
              onClick={() => void copyText('install', INSTALL_COMMAND)}
              title="Copy install command"
              aria-label="Copy install command"
              className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-white/5 hover:text-white"
            >
              {copied === 'install' ? (
                <Check size={11} className="text-emerald-400" />
              ) : (
                <Copy size={11} />
              )}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            Add <code className="rounded bg-white/5 px-1">--browser edge|brave|arc</code> if you use
            a non-Chrome Chromium browser. Use{' '}
            <code className="rounded bg-white/5 px-1">--uninstall</code> to remove the host manifest
            later.
          </p>
        </div>

        {status && (
          <div className="space-y-2 text-[10px] text-slate-500">
            <DetailRow
              label="Local socket"
              value={status.socketPath}
              onCopy={copyText}
              copyKey="socket"
              copied={copied}
            />
            {/* v2.0 round-9 — per-browser host manifest paths. The install
             *  script writes to all four when present; this lets the user
             *  copy the path matching whichever browser they actually use.
             *  Falls back to the legacy single-Chrome row only when the
             *  status payload lacks the new field (back-compat with an
             *  older main process during a hot-reload cycle). */}
            {status.browserHostManifestPaths ? (
              <>
                <DetailRow
                  label="Chrome manifest"
                  value={status.browserHostManifestPaths.chrome}
                  onCopy={copyText}
                  copyKey="manifest-chrome"
                  copied={copied}
                />
                <DetailRow
                  label="Edge manifest"
                  value={status.browserHostManifestPaths.edge}
                  onCopy={copyText}
                  copyKey="manifest-edge"
                  copied={copied}
                />
                <DetailRow
                  label="Brave manifest"
                  value={status.browserHostManifestPaths.brave}
                  onCopy={copyText}
                  copyKey="manifest-brave"
                  copied={copied}
                />
                <DetailRow
                  label="Arc manifest"
                  value={status.browserHostManifestPaths.arc}
                  onCopy={copyText}
                  copyKey="manifest-arc"
                  copied={copied}
                />
              </>
            ) : (
              <DetailRow
                label="Host manifest"
                value={status.hostManifestPath}
                onCopy={copyText}
                copyKey="manifest"
                copied={copied}
              />
            )}
            <DetailRow
              label="Bridge script"
              value={status.bridgeScriptPath}
              onCopy={copyText}
              copyKey="bridge"
              copied={copied}
            />
          </div>
        )}

        <p className="text-[10px] leading-relaxed text-slate-500">
          The native-messaging manifest only whitelists your extension id, so other Chrome
          extensions can't talk to the bridge.{' '}
          <a
            href="https://developer.chrome.com/docs/apps/nativeMessaging"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[var(--accent)] hover:underline"
          >
            Chrome docs
            <ExternalLink size={9} />
          </a>
        </p>
      </div>
    </CollapsibleSection>
  )
}

function DetailRow({
  label,
  value,
  onCopy,
  copyKey,
  copied
}: {
  label: string
  value: string
  onCopy: (label: string, text: string) => Promise<void>
  copyKey: string
  copied: string | null
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 uppercase tracking-wide">{label}</span>
      <span className="grow truncate font-mono text-slate-400" title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={() => void onCopy(copyKey, value)}
        title={`Copy ${label.toLowerCase()}`}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="shrink-0 rounded p-1 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
      >
        {copied === copyKey ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
      </button>
    </div>
  )
}
