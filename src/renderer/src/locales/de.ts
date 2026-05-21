/**
 * German catalog. Any key missing here falls back to English. New keys
 * land in `en.ts` first; translators add them here when ready.
 */
const de: Record<string, string> = {
  'appearance.theme': 'Erscheinungsbild',
  'appearance.theme.hint': 'Dunkel, hell oder dem System folgen.',
  'appearance.theme.dark': 'Dunkel',
  'appearance.theme.light': 'Hell',
  'appearance.theme.system': 'System',
  'appearance.language': 'Sprache',
  'appearance.language.hint': 'Sprache der Oberfläche. Kein Neustart nötig.',

  'composer.placeholder': 'Frag VoidSoul alles…',
  'composer.send': 'Nachricht senden',
  'composer.stop': 'Stoppen',
  'composer.attach': 'Bild oder Datei anhängen',
  'composer.screenshot': 'Bildschirmfoto aufnehmen',
  'composer.read_screen': 'Bildschirmtext lesen (OCR)',
  'composer.remember': 'Diese Unterhaltung merken',
  'composer.clear': 'Unterhaltung löschen',
  'composer.drop_to_attach': 'Loslassen zum Anhängen',

  'chat.no_response': 'Keine Antwort erhalten.',
  'chat.stopped': 'Gestoppt.',
  'chat.wait_for_stream': 'Warte, bis die aktuelle Antwort fertig ist.',
  'chat.search_placeholder': 'In dieser Unterhaltung suchen…',
  'chat.search_all_placeholder': 'In allen Unterhaltungen suchen…',
  'chat.search_no_results': 'Keine Treffer.',
  'chat.search_all': 'In allen Threads suchen',
  'chat.search_hint': 'Tippen, um in allen gespeicherten Unterhaltungen zu suchen.',
  'chat.search_untitled': 'Unbenannter Thread',
  'chat.search_matches_one': '{count} Treffer',
  'chat.search_matches_many': '{count} Treffer',

  'common.cancel': 'Abbrechen',
  'common.save': 'Speichern',
  'common.close': 'Schließen',
  'common.delete': 'Löschen',
  'common.confirm': 'Bestätigen'
}

export default de
