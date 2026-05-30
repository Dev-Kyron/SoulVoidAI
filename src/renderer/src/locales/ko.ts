/**
 * Korean (ko). Any key missing here falls back to English. New keys
 * land in `en.ts` first; translators add them here when ready.
 */
const ko: Record<string, string> = {
  'appearance.theme': '테마',
  'appearance.theme.hint': '어두운 테마, 밝은 테마 또는 시스템 설정 따르기.',
  'appearance.theme.dark': '어두움',
  'appearance.theme.light': '밝음',
  'appearance.theme.system': '시스템',
  'appearance.language': '언어',
  'appearance.language.hint': 'UI 언어. 재시작이 필요하지 않습니다.',

  'composer.placeholder': 'VoidSoul에게 무엇이든 물어보세요…',
  'composer.send': '메시지 보내기',
  'composer.stop': '생성 중지',
  'composer.attach': '이미지 또는 파일 첨부',
  'composer.screenshot': '스크린샷 캡처',
  'composer.read_screen': '화면 텍스트 읽기 (OCR)',
  'composer.remember': '이 대화 기억하기',
  'composer.clear': '대화 지우기',
  'composer.drop_to_attach': '첨부하려면 드롭',

  'chat.no_response': '응답을 받지 못했습니다.',
  'chat.stopped': '중지됨.',
  'chat.wait_for_stream': '현재 응답이 끝날 때까지 기다려 주세요.',
  'chat.search_placeholder': '이 대화에서 검색…',
  'chat.search_all_placeholder': '모든 대화에서 검색…',
  'chat.search_no_results': '일치하는 항목이 없습니다.',
  'chat.search_all': '모든 스레드에서 검색',
  'chat.search_hint': '저장된 모든 대화를 검색하려면 입력하세요.',
  'chat.search_untitled': '제목 없는 스레드',
  'chat.search_matches_one': '{count}개 일치',
  'chat.search_matches_many': '{count}개 일치',

  'common.cancel': '취소',
  'common.save': '저장',
  'common.close': '닫기',
  'common.delete': '삭제',
  'common.confirm': '확인'
}

export default ko
