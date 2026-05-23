/**
 * Interactive decision card. Renders in place of a fenced ```askuser code
 * block — the AI emits JSON inside the fence describing a question + a
 * short list of options; we turn it into a clickable card the user can
 * pick (or edit-and-pick) to feed their answer back into the thread.
 *
 * Mirrors the shape of Claude Code's AskUserQuestion tool — a multiSelect
 * flag, an "Other" free-text fallback, and per-option `preview` chips
 * shown on hover — with one VoidSoul addition: the AI's suggested labels
 * are inline-editable. The reviewer can refine wording before submitting
 * so the answer reads in their voice, not the model's.
 *
 * Authoring contract for the AI (set in the system prompt):
 *   ```askuser
 *   {
 *     "question": "Which database for the new feature?",
 *     "header": "DB pick",
 *     "multiSelect": false,
 *     "options": [
 *       { "label": "PostgreSQL", "description": "Mature, strong consistency." },
 *       { "label": "SQLite",     "description": "Zero ops, embedded." }
 *     ]
 *   }
 *   ```
 *
 * Parsing failures fall back to "render as code block" so a malformed or
 * mid-stream JSON payload doesn't crash the message — see safeParse below.
 */
import { useMemo, useState } from 'react'
import { Check, Edit3, HelpCircle, Send } from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { cn } from '../../lib/utils'

interface AskUserOption {
  label: string
  description?: string
  preview?: string
}

interface AskUserPayload {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskUserOption[]
}

/**
 * Strict-but-tolerant parser. Returns null if the payload isn't a recognisable
 * askuser block — the caller falls back to rendering the source as a code
 * block in that case. We deliberately do NOT throw on partial JSON during
 * streaming; null + fallback is the gentle path.
 */
function safeParse(text: string): AskUserPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.question !== 'string' || !obj.question.trim()) return null
  if (!Array.isArray(obj.options) || obj.options.length === 0) return null
  const options: AskUserOption[] = []
  for (const entry of obj.options) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.label !== 'string' || !e.label.trim()) continue
    options.push({
      label: e.label,
      description: typeof e.description === 'string' ? e.description : undefined,
      preview: typeof e.preview === 'string' ? e.preview : undefined
    })
  }
  if (options.length === 0) return null
  return {
    question: obj.question,
    header: typeof obj.header === 'string' ? obj.header : undefined,
    multiSelect: obj.multiSelect === true,
    options
  }
}

interface AskUserCardProps {
  /** Raw JSON text from inside the ```askuser fence. */
  source: string
  /**
   * Caller-supplied "this message is mid-stream" hint. When omitted (the
   * common case — the Markdown renderer doesn't currently thread it), we
   * fall back to subscribing to `useChatStore.streaming` so a partially-
   * arrived ``askuser block doesn't flash the "payload is invalid" error
   * card before the JSON has finished arriving.
   */
  streaming?: boolean
}

export function AskUserCard({ source, streaming: streamingProp }: AskUserCardProps): JSX.Element {
  const payload = useMemo(() => safeParse(source), [source])
  const storeStreaming = useChatStore((s) => s.streaming)
  const isStreaming = streamingProp ?? storeStreaming

  // During streaming, JSON may be incomplete. Show a placeholder rather
  // than the raw code fence so the user doesn't see flicker.
  if (!payload) {
    if (isStreaming) {
      return (
        <div className="my-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <p className="animate-pulse text-[11px] text-slate-400">Composing options…</p>
        </div>
      )
    }
    // Not streaming + still unparseable — let the caller fall back to a
    // regular code block by signalling with a styled error rather than
    // throwing. (Markdown.tsx renders the fence directly in this path.)
    return (
      <div className="my-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-200">
        Decision card payload is invalid. Showing as plain code.
      </div>
    )
  }

  return <DecisionCard payload={payload} />
}

function DecisionCard({ payload }: { payload: AskUserPayload }): JSX.Element {
  const send = useChatStore((s) => s.send)
  const streaming = useChatStore((s) => s.streaming)

  // Each option's label starts as the AI's suggestion. The user can pencil
  // any of them to edit in place — handy when the AI's wording is close
  // but not quite right, e.g., "PostgreSQL" → "Postgres on Supabase".
  const [labels, setLabels] = useState<string[]>(() => payload.options.map((o) => o.label))
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [otherText, setOtherText] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const isMulti = payload.multiSelect === true
  const otherIndex = payload.options.length // virtual index for the "Other" row

  const submit = (selectedIndices: number[], includeOther: boolean, otherValue: string): void => {
    if (submitted || streaming) return
    const parts: string[] = []
    for (const i of selectedIndices) {
      const label = labels[i].trim()
      if (label) parts.push(label)
    }
    if (includeOther) {
      const txt = otherValue.trim()
      if (txt) parts.push(txt)
    }
    if (parts.length === 0) return
    const prefix = parts.length === 1 ? "I'll go with" : "Let's do"
    const message = `${prefix}: ${parts.join(' + ')}`
    setSubmitted(true)
    void send(message)
  }

  const toggleSelected = (index: number): void => {
    if (submitted) return
    if (isMulti) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
    } else {
      // Single-select fires immediately — the snappy path. Multi-select
      // waits for an explicit Submit since the user is still picking.
      submit([index], false, '')
    }
  }

  const handleOtherSubmit = (): void => {
    if (!otherText.trim()) return
    if (isMulti) {
      // Multi-select with Other: combine ticked options + the free text.
      submit([...selected], true, otherText)
    } else {
      submit([], true, otherText)
    }
  }

  const handleMultiSubmit = (): void => {
    // Honour the Other field if the user typed into it too — the Submit
    // button's `canSubmitMulti` enables on EITHER ticks or Other text, so
    // submitting without `includeOther` would silently drop a filled
    // Other input as a no-op.
    submit([...selected], otherText.trim().length > 0, otherText)
  }

  const canSubmitMulti = isMulti && (selected.size > 0 || otherText.trim().length > 0)

  return (
    <div className="my-2 rounded-xl border border-[var(--accent-ring)] bg-[var(--accent-soft)] p-3 shadow-glow">
      <div className="mb-2 flex items-start gap-2">
        <HelpCircle size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          {payload.header && (
            <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--accent)]">
              {payload.header}
            </p>
          )}
          <p className="text-[12px] font-semibold leading-snug text-white">{payload.question}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        {payload.options.map((option, i) => {
          const isSelected = selected.has(i)
          const isEditing = editingIndex === i
          return (
            <div
              key={i}
              className={cn(
                'group relative rounded-lg border bg-black/30 transition',
                isSelected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-white/10 hover:border-white/20'
              )}
              title={option.preview}
            >
              <button
                type="button"
                onClick={() => toggleSelected(i)}
                disabled={submitted || streaming || isEditing}
                className="flex w-full items-start gap-2 px-2.5 py-2 text-left disabled:cursor-not-allowed"
              >
                {/* Multi-select shows a checkbox; single-select skips the
                    indicator since the click submits immediately. */}
                {isMulti && (
                  <span
                    className={cn(
                      'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition',
                      isSelected
                        ? 'border-[var(--accent)] bg-[var(--accent)]'
                        : 'border-white/30'
                    )}
                  >
                    {isSelected && <Check size={9} className="text-white" />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={labels[i]}
                      onChange={(e) => {
                        const next = [...labels]
                        next[i] = e.target.value
                        setLabels(next)
                      }}
                      onBlur={() => setEditingIndex(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault()
                          setEditingIndex(null)
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full rounded border border-white/20 bg-black/40 px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-[var(--accent-ring)]"
                    />
                  ) : (
                    <p className="text-[11px] font-semibold text-white">{labels[i]}</p>
                  )}
                  {option.description && (
                    <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
                      {option.description}
                    </p>
                  )}
                </div>
              </button>
              {!submitted && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingIndex(isEditing ? null : i)
                  }}
                  title={isEditing ? 'Done' : 'Edit this option before picking'}
                  aria-label={isEditing ? 'Stop editing' : 'Edit option'}
                  className={cn(
                    'absolute right-1.5 top-1.5 rounded p-1 text-slate-500 transition opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-white',
                    isEditing && 'opacity-100 text-[var(--accent)]'
                  )}
                >
                  <Edit3 size={10} />
                </button>
              )}
            </div>
          )
        })}

        {/* "Other" free-text row — always present as the escape hatch. In
            multi-select mode it combines with ticked options; in single
            mode it submits on its own when the user hits Enter or Send. */}
        <div
          className={cn(
            'rounded-lg border border-dashed border-white/15 bg-black/20 px-2.5 py-2',
            submitted && 'opacity-50'
          )}
        >
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">
              Other
            </p>
            <span className="text-[9px] text-slate-600">Tab #{otherIndex + 1}</span>
          </div>
          <div className="flex gap-1.5">
            <input
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isMulti && otherText.trim()) {
                  e.preventDefault()
                  handleOtherSubmit()
                }
              }}
              placeholder="Type your own answer…"
              disabled={submitted || streaming}
              className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white outline-none placeholder:text-slate-600 focus:border-[var(--accent-ring)] disabled:cursor-not-allowed"
            />
            {!isMulti && (
              <button
                type="button"
                onClick={handleOtherSubmit}
                disabled={submitted || streaming || !otherText.trim()}
                title="Submit custom answer"
                aria-label="Submit custom answer"
                className="flex items-center justify-center rounded bg-[var(--accent)] px-2 text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send size={11} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Multi-select Submit row — single-select uses the per-option click. */}
      {isMulti && (
        <div className="mt-2.5 flex items-center justify-between">
          <p className="text-[10px] text-slate-400">
            {selected.size === 0 && !otherText.trim()
              ? 'Pick one or more'
              : `${selected.size + (otherText.trim() ? 1 : 0)} selected`}
          </p>
          <button
            type="button"
            onClick={handleMultiSubmit}
            disabled={submitted || streaming || !canSubmitMulti}
            className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={11} />
            Submit
          </button>
        </div>
      )}

      {submitted && (
        <p className="mt-2 text-[10px] italic text-slate-500">Answer sent.</p>
      )}
    </div>
  )
}
