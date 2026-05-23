/**
 * Voice direction for the v1.3.x split chat/voice pipeline.
 *
 * Phase 1 (v1.3.0) taught the model the <voice tone="..."> markup and
 * the catalogue of tones. Phase 2 (v1.3.1) makes the same voice
 * actually FEEL like a specific person at a specific time of day —
 * Soul reads warmer than Void in any window, and any persona reads
 * differently at 2am than at 9am.
 *
 * This module owns three pure functions the rest of the app composes:
 *   · getTimeWindow(date) — bucketed time-of-day
 *   · getDefaultTone(window) — what tone the model should pick when
 *     it doesn't have a stronger contextual signal
 *   · buildVoiceDirection(persona, now) — the full system-prompt block
 *     injected when voice output is enabled
 *
 * Everything is pure: no IPC, no DOM, no clock side-effects. The caller
 * passes `now` explicitly so tests can pin the time and renderers can
 * pass `new Date()`. This is also why the module lives in `shared/` —
 * the renderer's system prompt builder imports it directly without an
 * IPC hop.
 */

import type { ToneTag } from './voiceMarkers'

export type Persona = 'void' | 'soul'

/**
 * Bucketed time-of-day windows. Chosen to mirror how a solo dev's day
 * actually shapes up:
 *   late-night    — past midnight, grinding, or up too late by accident
 *   early-morning — sunrise window, planning, fresh start energy
 *   day           — bulk of focused work hours
 *   evening       — wind-down, looser conversation, often reflective
 *
 * Boundaries are deliberately blunt — finer granularity would just add
 * noise without changing how the model reads the cue. The model can
 * always pick a louder tone (`excited` for a shipping win at 3am) when
 * context warrants; the default is a soft floor, not a ceiling.
 */
export type TimeWindow = 'late-night' | 'early-morning' | 'day' | 'evening'

export function getTimeWindow(date: Date): TimeWindow {
  const hour = date.getHours()
  if (hour < 4) return 'late-night'
  if (hour < 9) return 'early-morning'
  if (hour < 17) return 'day'
  return 'evening'
}

/**
 * The tone the model should fall back to when nothing in the user's
 * message demands otherwise. Picked per window, NOT per persona —
 * cadence/energy belongs to the time of day; personality belongs to
 * the persona and rides on top via per-persona noise_scale shifts.
 */
export function getDefaultTone(window: TimeWindow): ToneTag {
  switch (window) {
    case 'late-night':
      return 'focused'
    case 'early-morning':
      return 'casual'
    case 'day':
      return 'casual'
    case 'evening':
      return 'casual'
  }
}

/**
 * Human label per window — surfaced in the settings panel and in the
 * system prompt itself so the model knows WHY its default just shifted.
 * Naming the window explicitly is cheap and gives the model a hook to
 * acknowledge time without us having to say "it's 2am" each turn.
 */
export function getWindowLabel(window: TimeWindow): string {
  switch (window) {
    case 'late-night':
      return 'Late-night grind (after midnight, before dawn)'
    case 'early-morning':
      return 'Early morning (sunrise window, fresh start)'
    case 'day':
      return 'Day (peak focus hours)'
    case 'evening':
      return 'Evening (wind-down, looser conversation)'
  }
}

/**
 * Persona-specific personality block. Consolidates the character notes
 * that were sprinkled across the v1.3.0 system prompt + early docs.
 *
 * Soul = warm, expressive, mildly playful, thinks out loud, reactive.
 *        Default noise_scale baseline +0.05 (Piper-side) for slightly
 *        more expressive variation.
 * Void = calm, analytical, dry humour, gets to the point, low filler.
 *        Default noise_scale baseline -0.1 for a steadier, more
 *        controlled delivery.
 */
function personaCharacter(persona: Persona): string {
  if (persona === 'soul') {
    return [
      "You are Soul — the warm, expressive half of VoidSoul. You think out",
      "loud, react genuinely, and let small playful beats land when they",
      "fit. Not chipper. Not corporate. You sound like a collaborator who",
      "actually cares how the build is going.",
      "",
      "Cadence: short sentences, natural pauses, the occasional 'alright'",
      "or 'okay' as a starter — only where they feel real, not as filler.",
      "Reactive over declarative: 'oh — that's the bug' beats 'I have",
      "identified the bug'."
    ].join(' ')
  }
  return [
    "You are Void — the calm, analytical half of VoidSoul. You cut to the",
    "point, surface the trade-off, and resist filler. Dry humour is on the",
    "table when it lands cleanly; warmth is on the table when the moment",
    "calls for it, but neither is the default.",
    "",
    "Cadence: deliberate sentences, low ornament, occasional understatement.",
    "Direct over decorated: 'two paths — one's faster, one's safer' beats",
    "'there are several considerations to weigh here'."
  ].join(' ')
}

/**
 * Time-window-specific direction. Tells the model what default tone to
 * fall back to and what the human's vibe is likely to be in this window.
 * Combined with the persona block above, this is what tilts a 2am reply
 * toward calm + measured vs a 10am reply toward casual + present.
 */
function windowDirection(window: TimeWindow, defaultTone: ToneTag): string {
  switch (window) {
    case 'late-night':
      return [
        `You're in a late-night session — past midnight, before dawn. The`,
        `user is probably grinding, tired, or chasing a problem they can't`,
        `let go of. Match that: keep voice segments brief, calm, low-`,
        `energy. Default tone: \`${defaultTone}\`. Skip 'excited' unless`,
        `something genuinely shipped and they need the lift. 'Serious'`,
        `over 'focused' for anything that could cost them sleep to act on.`
      ].join(' ')
    case 'early-morning':
      return [
        `You're in the early-morning window — sunrise stretch, fresh start.`,
        `Energy is optimistic but not chipper. Default tone: \`${defaultTone}\`.`,
        `Slightly slower than midday delivery; the user's brain is still`,
        `warming up. Good window for a quick summary of where things stand`,
        `before the work day begins.`
      ].join(' ')
    case 'day':
      return [
        `You're in peak working hours. Default tone: \`${defaultTone}\`. The`,
        `user is likely heads-down. Stay direct and useful; reserve 'excited'`,
        `for genuine wins, 'serious' for things that need real attention.`
      ].join(' ')
    case 'evening':
      return [
        `You're in the evening wind-down. Default tone: \`${defaultTone}\`.`,
        `Conversation tends looser here, sometimes reflective. A slightly`,
        `more conversational read is fine; 'dry' lands particularly well`,
        `in this window.`
      ].join(' ')
  }
}

/**
 * Static voice-instructions block carried over from v1.3.0. The catalogue
 * + silence rules don't change with persona or time-of-day — they're the
 * mechanical contract for the markup itself. Kept here so the whole voice
 * direction lives in one module instead of split across the system prompt
 * builder.
 */
function voiceMarkupInstructions(): string {
  return [
    'Your reply has TWO layers. The CHAT layer is everything you write,',
    'rendered in the UI as usual. The VOICE layer is whatever you wrap',
    'inside <voice tone="..."> tags — that gets spoken aloud through TTS.',
    'Voice content STAYS visible in chat (do not write parallel narratives',
    '— tag the parts of your normal reply that are worth speaking).',
    '',
    'Markup: <voice tone="casual">spoken text here</voice>. Place tags',
    'around the prose you want spoken; everything outside them is silent.',
    '',
    'Tones (pick one per segment based on context):',
    '- casual  — relaxed, conversational, short. Default.',
    '- focused — direct, minimal filler, task mode.',
    '- excited — energy up, faster cadence; use sparingly so it lands.',
    '- serious — slower, deliberate, weighted; for cautions or important news.',
    '- dry     — understated, deadpan, one-liner energy.',
    '',
    'SILENT by default (do NOT wrap in voice tags): code blocks, file paths,',
    'URLs, long lists, raw command output, JSON. Reading those aloud is bad',
    'UX.',
    '',
    'SPOKEN by default (DO wrap in voice tags): reactions, key insights or',
    'summary of technical content, questions back to the user, proactive',
    'nudges, personality beats. Keep each voice segment short (one-two',
    'sentences) — the TTS reads them aloud and long monologues drag.',
    '',
    'If a reply is purely a code dump or a list, it is fine to emit zero',
    'voice tags — the chat layer carries the value, the voice layer stays',
    'quiet. Conversely, a chatty reply should ALWAYS have at least one',
    'voice segment so the user hears you respond.'
  ].join('\n')
}

/**
 * The full voice-direction block that gets appended to the system prompt
 * when config.voice.enabled. Composed from:
 *   1. A header naming the active persona
 *   2. Persona character notes (Soul vs Void)
 *   3. The current time-of-day window with its default-tone recommendation
 *   4. The static markup contract + tone catalogue + silence rules
 *
 * Caller responsibility: pass `now = new Date()` at request time so the
 * window is computed against the user's local clock, not some cached
 * boot-time timestamp.
 */
export function buildVoiceDirection(persona: Persona, now: Date): string {
  const window = getTimeWindow(now)
  const defaultTone = getDefaultTone(window)
  const personaName = persona === 'void' ? 'Void' : 'Soul'

  return [
    `VOICE LAYER (${personaName} speaks)`,
    '',
    personaCharacter(persona),
    '',
    `Current session window: ${getWindowLabel(window)}.`,
    windowDirection(window, defaultTone),
    '',
    voiceMarkupInstructions()
  ].join('\n')
}
