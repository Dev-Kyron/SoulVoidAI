/**
 * Spanish catalog. Any key missing here falls back to English. New keys
 * land in `en.ts` first; translators add them here when ready.
 */
const es: Record<string, string> = {
  'appearance.theme': 'Tema',
  'appearance.theme.hint': 'Oscuro, claro o seguir tu sistema operativo.',
  'appearance.theme.dark': 'Oscuro',
  'appearance.theme.light': 'Claro',
  'appearance.theme.system': 'Sistema',
  'appearance.language': 'Idioma',
  'appearance.language.hint': 'Idioma de la interfaz. No requiere reinicio.',

  'composer.placeholder': 'Pregúntale lo que sea a VoidSoul…',
  'composer.send': 'Enviar mensaje',
  'composer.stop': 'Detener',
  'composer.attach': 'Adjuntar imagen o archivo',
  'composer.screenshot': 'Capturar pantalla',
  'composer.read_screen': 'Leer texto en pantalla (OCR)',
  'composer.remember': 'Recordar esta conversación',
  'composer.clear': 'Limpiar conversación',
  'composer.drop_to_attach': 'Suelta para adjuntar',

  'chat.no_response': 'No se recibió respuesta.',
  'chat.stopped': 'Detenido.',
  'chat.wait_for_stream': 'Espera a que termine la respuesta actual.',
  'chat.search_placeholder': 'Buscar en esta conversación…',
  'chat.search_all_placeholder': 'Buscar en todas las conversaciones…',
  'chat.search_no_results': 'Sin coincidencias.',
  'chat.search_all': 'Buscar en todos los hilos',
  'chat.search_hint': 'Escribe para buscar en todas las conversaciones guardadas.',
  'chat.search_untitled': 'Conversación sin título',
  'chat.search_matches_one': '{count} coincidencia',
  'chat.search_matches_many': '{count} coincidencias',

  'common.cancel': 'Cancelar',
  'common.save': 'Guardar',
  'common.close': 'Cerrar',
  'common.delete': 'Eliminar',
  'common.confirm': 'Confirmar'
}

export default es
