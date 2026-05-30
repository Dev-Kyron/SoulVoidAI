/**
 * Portuguese (pt — neutral / Brazil-leaning). Any key missing here falls
 * back to English. New keys land in `en.ts` first; translators add them
 * here when ready.
 */
const pt: Record<string, string> = {
  'appearance.theme': 'Tema',
  'appearance.theme.hint': 'Escuro, claro ou seguir o sistema operacional.',
  'appearance.theme.dark': 'Escuro',
  'appearance.theme.light': 'Claro',
  'appearance.theme.system': 'Sistema',
  'appearance.language': 'Idioma',
  'appearance.language.hint': 'Idioma da interface. Não requer reinicialização.',

  'composer.placeholder': 'Pergunte qualquer coisa ao VoidSoul…',
  'composer.send': 'Enviar mensagem',
  'composer.stop': 'Parar geração',
  'composer.attach': 'Anexar imagem ou arquivo',
  'composer.screenshot': 'Capturar uma captura de tela',
  'composer.read_screen': 'Ler texto na tela (OCR)',
  'composer.remember': 'Lembrar esta conversa',
  'composer.clear': 'Limpar conversa',
  'composer.drop_to_attach': 'Solte para anexar',

  'chat.no_response': 'Nenhuma resposta recebida.',
  'chat.stopped': 'Parado.',
  'chat.wait_for_stream': 'Aguarde a resposta atual terminar.',
  'chat.search_placeholder': 'Pesquisar nesta conversa…',
  'chat.search_all_placeholder': 'Pesquisar em todas as conversas…',
  'chat.search_no_results': 'Nenhuma correspondência.',
  'chat.search_all': 'Pesquisar em todos os tópicos',
  'chat.search_hint': 'Digite para pesquisar em todas as conversas salvas.',
  'chat.search_untitled': 'Conversa sem título',
  'chat.search_matches_one': '{count} correspondência',
  'chat.search_matches_many': '{count} correspondências',

  'common.cancel': 'Cancelar',
  'common.save': 'Salvar',
  'common.close': 'Fechar',
  'common.delete': 'Excluir',
  'common.confirm': 'Confirmar'
}

export default pt
