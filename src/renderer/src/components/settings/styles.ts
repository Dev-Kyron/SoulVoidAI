/**
 * v2.0 polish — shared tailwind class strings used by the various settings
 * dialogs. The same FIELD/BTN strings were redeclared verbatim across
 * HomeAssistantWizardDialog, TaughtClicksDialog, ClickBenchDialog,
 * SyncSettings, McpSettings, IntegrationSettings, MemorySettings,
 * ScheduledTasks, ReviewDialog, and AddActionDialog — eleven places where
 * a single design tweak (border colour, font size, padding) would have
 * required eleven coordinated edits.
 *
 * Add new shared variants here rather than re-declaring at the dialog
 * top. Per-dialog overrides should compose via `cn(FIELD, '…')` so the
 * shared baseline stays the source of truth.
 */

/** Standard text input / textarea baseline — rounded glass card on dark
 *  background with the accent focus ring. Use for plain `<input>` and
 *  `<textarea>` inside settings dialogs. */
export const FIELD =
  'rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600'

/** Secondary / ghost button baseline — flex row with leading icon slot,
 *  subtle border, hover-tint. Use for cancel / dismiss / step-back. */
export const BTN =
  'flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[11px] text-slate-200 transition hover:bg-white/5 disabled:opacity-40'
