/**
 * v1.12.6 — Agent readiness banner shown at the top of MCP / Permissions /
 * Plugins panels.
 *
 * Why: the user can spend an hour configuring permissions, installing MCP
 * servers, and enabling plugins — and then the AI responds with "I can't
 * execute actions" because Agent mode is toggled off (or the active model
 * doesn't support function calling). Nothing in the UI surfaces that
 * everything they just configured is INERT until those gates are crossed.
 *
 * This banner closes that gap. It only renders when at least one gate is
 * blocking tool use; on a healthy "agent on + capable model" setup it
 * renders nothing at all (no permanent visual noise).
 *
 * Two failure modes detected:
 *  1. `config.chat.agent === false` — easiest to fix, single-click button
 *     flips it back on.
 *  2. Active model lacks function calling — surfaced as a softer warning
 *     since the fix is "switch model in Settings → Providers", not a
 *     one-click flip from here. Gives the model name so the user knows
 *     exactly which one to swap.
 */
import { AlertTriangle, Bot, Sparkles } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { capabilitiesOf } from '@shared/modelCapabilities'

export function AgentReadinessNotice(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setAgentMode = useConfigStore((s) => s.setAgentMode)
  if (!config) return null

  const agentOn = config.chat.agent
  const activeProviderId = config.activeProvider
  const activeProvider = config.providers.find((p) => p.id === activeProviderId)
  const activeModel = activeProvider?.model ?? ''
  // v1.12.7 hotfix — earlier v1.12.6 ship used hyphenated ids
  // ('lm-studio' / 'llama-cpp') that don't exist in the ProviderId
  // union; real ids are 'lmstudio' and 'llamacpp'. Result: every LM
  // Studio + llama.cpp user saw a bogus "model can't call tools"
  // warning regardless of model capability.
  const isLocal = ['ollama', 'lmstudio', 'llamacpp', 'custom'].includes(activeProviderId)
  const caps = capabilitiesOf(activeModel, isLocal)
  // Tool-use detection is regex-based on the model id (see modelCapabilities.ts).
  // For models we can't pattern-match (a fresh Ollama model, custom endpoint),
  // we default to assuming they support tools rather than warning aggressively —
  // false positives here would mean a banner shouting "your model doesn't work"
  // when it actually does. Only warn when we KNOW it lacks tools.
  const modelLacksTools = activeModel && !caps.toolUse && !isLocal

  if (agentOn && !modelLacksTools) return null

  return (
    <div className="mb-3 space-y-2">
      {!agentOn && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2">
          <Bot size={14} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-amber-100">
              Agent mode is off — the AI can&apos;t use any of this
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-amber-200/80">
              Permissions, MCP servers, and plugins shown below are only available to the AI when
              Agent mode is on. Without it, the model answers as a plain chat — no tool calls, no
              actions on your computer.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void setAgentMode(true)}
            className="shrink-0 self-center rounded-md bg-amber-400/20 px-2.5 py-1 text-[10px] font-semibold text-amber-100 transition hover:bg-amber-400/30"
          >
            Enable
          </button>
        </div>
      )}
      {agentOn && modelLacksTools && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-300" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-rose-100">
              <span className="font-mono">{activeModel}</span> doesn&apos;t support tool calling
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-rose-200/80">
              Even with Agent mode on, this model can&apos;t invoke tools. Switch to a
              function-calling-capable model in Settings → Providers (Claude 3+, GPT-4o /
              GPT-4-turbo, Gemini 1.5+, or a recent Llama 3 / Qwen 2.5+ locally).
            </p>
          </div>
        </div>
      )}
      {agentOn && !modelLacksTools && (
        // Defensive — this branch is unreachable due to the early return
        // above, but kept so future refactors don't accidentally mount the
        // banner in a healthy state. If you see this in production, the
        // early return broke.
        <div className="flex items-center gap-1.5 text-[10px] text-emerald-300">
          <Sparkles size={11} />
          Agent ready
        </div>
      )}
    </div>
  )
}
