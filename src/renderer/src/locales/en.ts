/**
 * English string catalog — the source of truth for translation keys. New
 * UI strings should land here first; other locales fall back to English
 * for any key they don't define.
 *
 * Keys are namespaced with `.` (e.g. `appearance.theme`); the namespaces
 * are organisational only — the lookup uses the full key directly.
 */
const en: Record<string, string> = {
  // Appearance settings
  'appearance.theme': 'Theme',
  'appearance.theme.hint': 'Dark, light, or follow your operating system.',
  'appearance.theme.dark': 'Dark',
  'appearance.theme.light': 'Light',
  'appearance.theme.system': 'System',
  'appearance.language': 'Language',
  'appearance.language.hint': 'UI language. Restart not required.',

  // Composer
  'composer.placeholder': 'Ask VoidSoul anything…',
  'composer.send': 'Send message',
  'composer.stop': 'Stop generating',
  'composer.attach': 'Attach image or file',
  'composer.screenshot': 'Capture a screenshot',
  'composer.read_screen': 'Read on-screen text (OCR)',
  'composer.remember': 'Remember this conversation',
  'composer.clear': 'Clear conversation',
  'composer.drop_to_attach': 'Drop to attach',

  // Chat
  'chat.no_response': 'No response received.',
  'chat.stopped': 'Stopped.',
  'chat.wait_for_stream': 'Wait for the current reply to finish.',
  'chat.search_placeholder': 'Search this conversation…',
  'chat.search_all_placeholder': 'Search all conversations…',
  'chat.search_no_results': 'No matches.',
  'chat.search_all': 'Search across all threads',
  'chat.search_hint': 'Type to search across every saved conversation.',
  'chat.search_untitled': 'Untitled thread',
  'chat.search_matches_one': '{count} match',
  'chat.search_matches_many': '{count} matches',

  // Common
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.confirm': 'Confirm'
}

export default en
