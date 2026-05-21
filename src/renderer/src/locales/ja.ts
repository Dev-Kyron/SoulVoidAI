/**
 * Japanese catalog. Any key missing here falls back to English. New keys
 * land in `en.ts` first; translators add them here when ready.
 */
const ja: Record<string, string> = {
  'appearance.theme': 'テーマ',
  'appearance.theme.hint': 'ダーク、ライト、またはシステム設定に従います。',
  'appearance.theme.dark': 'ダーク',
  'appearance.theme.light': 'ライト',
  'appearance.theme.system': 'システム',
  'appearance.language': '言語',
  'appearance.language.hint': '画面表示の言語。再起動は不要です。',

  'composer.placeholder': 'VoidSoulに何でも聞いてください…',
  'composer.send': 'メッセージを送信',
  'composer.stop': '停止',
  'composer.attach': '画像またはファイルを添付',
  'composer.screenshot': 'スクリーンショットを撮影',
  'composer.read_screen': '画面のテキストを読み取る (OCR)',
  'composer.remember': 'この会話を記憶する',
  'composer.clear': '会話をクリア',
  'composer.drop_to_attach': 'ドロップして添付',

  'chat.no_response': '応答がありません。',
  'chat.stopped': '停止しました。',
  'chat.wait_for_stream': '現在の応答が終わるのを待ってください。',
  'chat.search_placeholder': 'この会話を検索…',
  'chat.search_all_placeholder': 'すべての会話を検索…',
  'chat.search_no_results': '一致なし。',
  'chat.search_all': 'すべてのスレッドを検索',
  'chat.search_hint': '保存されたすべての会話を検索します。',
  'chat.search_untitled': '無題のスレッド',
  'chat.search_matches_one': '{count} 件',
  'chat.search_matches_many': '{count} 件',

  'common.cancel': 'キャンセル',
  'common.save': '保存',
  'common.close': '閉じる',
  'common.delete': '削除',
  'common.confirm': '確認'
}

export default ja
