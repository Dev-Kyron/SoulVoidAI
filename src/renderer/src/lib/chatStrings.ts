/**
 * Short, user-facing strings used by the chat pipeline. Centralised so
 * future copy edits — and eventually i18n — happen in one place.
 */
export const CHAT_STRINGS = {
  // `_..._` is Markdown italic — rendered as a thin grey caption in the
  // assistant bubble. Italicised copy reads as a meta-comment ("the
  // assistant produced nothing this time") rather than a content failure.
  noResponse: '_No response from the model._',
  stopped: '_Generation stopped._',
  /** Prefix an error message with this when the assistant bubble surfaces it. */
  errorPrefix: '⚠️ ',
  privateOn: 'Private mode on — this conversation isn’t saved or remembered.',
  privateOff: 'Private mode off — new messages will save and be remembered.',
  busyExtractingRunning: 'Looking for what to remember…',
  rememberedNothing: 'Nothing new to remember — it’s already in long-term memory.',
  rememberedDisabledByPrivate:
    'Private mode is on — turn it off in the chat header to remember things.',
  waitForStream: 'Wait for the current reply to finish first.'
} as const

/** Formats an error message for an assistant bubble. */
export function formatErrorContent(message: string): string {
  return `${CHAT_STRINGS.errorPrefix}${message}`
}
