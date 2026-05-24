/**
 * v1.10.0 — fuzzy window matching.
 *
 * Pure scoring function: given a window hint like "Messenger" or "Discord" or
 * "VS Code" and the list of currently visible windows, return the single
 * best match if one is unambiguously best, or null when nothing matches /
 * the top candidates are too close to call (caller falls through to global
 * behaviour or surfaces a "which window?" failure).
 *
 * Match signals (additive, additive bias deliberately so tied scores can
 * be explained):
 *   · exact process name match (description token == process)
 *   · process name substring match
 *   · title substring match (each token in hint that appears in title)
 *   · focused-window bonus (small — if hint is ambiguous, prefer foreground)
 *   · longer title gets a small penalty (browser windows often have very
 *     long titles that match many things; prefer tighter matches)
 *
 * Scoring is intentionally NOT a fuzzy-distance algorithm — substring
 * matching with token splitting handles "messenger" → "Messenger | Facebook"
 * and "vscode" → "Code.exe" reliably enough without needing Levenshtein
 * machinery the user would have to debug.
 */
import type { WindowInfo } from './windowManager'

export interface WindowMatch {
  window: WindowInfo
  /** 0-1 score the orchestrator can show in the failure trail. */
  confidence: number
  /** Why it matched — surfaced in the log line. */
  reason: string
}

const MIN_ABSOLUTE_SCORE = 3
const RELATIVE_GAP_MIN = 0.25

/** Common process-name aliases the AI is likely to use that don't match
 *  the literal process binary name. Add entries when beta users report
 *  "I said 'Chrome' but it didn't find chrome.exe" style misses. */
const PROCESS_ALIASES: Record<string, string[]> = {
  vscode: ['code'],
  'visual studio code': ['code'],
  chrome: ['chrome'],
  firefox: ['firefox'],
  edge: ['msedge'],
  opera: ['opera', 'opera_gx'],
  brave: ['brave'],
  discord: ['discord'],
  slack: ['slack'],
  messenger: ['messenger'],
  whatsapp: ['whatsapp'],
  telegram: ['telegram'],
  outlook: ['outlook'],
  word: ['winword'],
  excel: ['excel'],
  powerpoint: ['powerpnt'],
  notepad: ['notepad'],
  terminal: ['windowsterminal', 'wt'],
  cmd: ['cmd'],
  powershell: ['powershell', 'pwsh'],
  explorer: ['explorer']
}

const HINT_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'in', 'on', 'window', 'app', 'application', 'browser'
])

function tokenise(hint: string): string[] {
  return hint
    .toLowerCase()
    .replace(/[^a-z0-9\s|.-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !HINT_STOPWORDS.has(t))
}

function scoreWindow(window: WindowInfo, hintLower: string, tokens: string[]): number {
  let score = 0
  const titleL = window.title.toLowerCase()
  const procL = window.processName

  // Exact process name match against the FULL hint string — "messenger"
  // hint matching "messenger" process is the strongest signal possible.
  if (procL === hintLower.trim()) score += 10

  // Alias-aware process match: "vscode" hint maps to ["code"] aliases →
  // "code" process matches. Walks both directions so a single entry in
  // the alias table covers both spellings.
  for (const [alias, processes] of Object.entries(PROCESS_ALIASES)) {
    if (hintLower.includes(alias) && processes.includes(procL)) {
      score += 8
      break
    }
  }

  // Token-level matching: each tokenised hint word that appears in the
  // title OR process name adds to the score. A "Facebook Messenger" hint
  // against "Messenger | Facebook - Opera" title hits both tokens.
  for (const token of tokens) {
    if (titleL.includes(token)) score += 4
    if (procL.includes(token)) score += 3
  }

  // Tiebreak: foreground window gets a small lift. Useful when the hint
  // is ambiguous ("the browser" with three browsers open) — the one the
  // user was just looking at is the most likely intent.
  if (window.focused) score += 1

  // Penalty for excessively long titles — browser tabs often have very
  // long titles ("Welcome - mycnx.concentrix.com/sites/core/b/Pages/...")
  // that incidentally share tokens with everything. Prefer tighter matches.
  if (titleL.length > 60) score -= 1
  if (titleL.length > 100) score -= 2

  return score
}

export function matchWindow(
  windows: WindowInfo[],
  hint: string
): WindowMatch | null {
  if (windows.length === 0) return null
  const hintLower = hint.toLowerCase().trim()
  if (!hintLower) return null
  const tokens = tokenise(hint)
  if (tokens.length === 0) return null

  const scored = windows
    .map((window) => ({ window, score: scoreWindow(window, hintLower, tokens) }))
    .filter((s) => s.score >= MIN_ABSOLUTE_SCORE)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return null

  const top = scored[0]
  const second = scored[1]
  if (second && (top.score - second.score) / top.score < RELATIVE_GAP_MIN) {
    // EXCEPTION (same pattern as uiaMatch): when two windows score
    // within the ambiguity gap, the foreground one wins. Useful when
    // the user has multiple windows of the same app open ("Chrome"
    // with three tabs in three windows) — whichever they were just
    // looking at is the most likely intent.
    if (!(top.window.focused && !second.window.focused)) {
      return null
    }
  }

  // Confidence into [0.55, 0.95] — windows are rarely 100% certain matches
  // (titles change, multiple windows per process) but a strong match is
  // usually right.
  const normalised = Math.min(0.95, 0.55 + (top.score - MIN_ABSOLUTE_SCORE) * 0.04)

  const titlePreview = top.window.title.length > 40
    ? `${top.window.title.slice(0, 37)}…`
    : top.window.title
  const reason = `window match: "${titlePreview}" (${top.window.processName})`

  return { window: top.window, confidence: normalised, reason }
}
