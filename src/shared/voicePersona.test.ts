import { describe, expect, it } from 'vitest'
import {
  buildVoiceDirection,
  getDefaultTone,
  getTimeWindow,
  getWindowLabel,
  type Persona,
  type TimeWindow
} from './voicePersona'

function at(hour: number, minute = 0): Date {
  // Local-time constructor — getTimeWindow reads getHours() which is
  // local-zone. Tests pin date/year to 2026-05-23 so DST quirks don't
  // accidentally shift a 02:00 reading into 01:00.
  return new Date(2026, 4, 23, hour, minute, 0)
}

/* ----------------------------- window detection ------------------------ */

describe('getTimeWindow', () => {
  it('returns late-night for hours 0-3', () => {
    expect(getTimeWindow(at(0))).toBe('late-night')
    expect(getTimeWindow(at(1, 30))).toBe('late-night')
    expect(getTimeWindow(at(2))).toBe('late-night')
    expect(getTimeWindow(at(3, 59))).toBe('late-night')
  })

  it('returns early-morning for hours 4-8', () => {
    expect(getTimeWindow(at(4))).toBe('early-morning')
    expect(getTimeWindow(at(6, 15))).toBe('early-morning')
    expect(getTimeWindow(at(8, 59))).toBe('early-morning')
  })

  it('returns day for hours 9-16', () => {
    expect(getTimeWindow(at(9))).toBe('day')
    expect(getTimeWindow(at(12))).toBe('day')
    expect(getTimeWindow(at(16, 59))).toBe('day')
  })

  it('returns evening for hours 17-23', () => {
    expect(getTimeWindow(at(17))).toBe('evening')
    expect(getTimeWindow(at(20))).toBe('evening')
    expect(getTimeWindow(at(23, 59))).toBe('evening')
  })

  it('handles boundary hours predictably (window flips ON the hour)', () => {
    // 04:00 sharp flips late-night → early-morning, not at 03:59.59.
    expect(getTimeWindow(at(3, 59))).toBe('late-night')
    expect(getTimeWindow(at(4, 0))).toBe('early-morning')
    expect(getTimeWindow(at(8, 59))).toBe('early-morning')
    expect(getTimeWindow(at(9, 0))).toBe('day')
    expect(getTimeWindow(at(16, 59))).toBe('day')
    expect(getTimeWindow(at(17, 0))).toBe('evening')
  })
})

/* ----------------------------- default tone ---------------------------- */

describe('getDefaultTone', () => {
  it('late-night defaults to focused (low energy, deliberate)', () => {
    expect(getDefaultTone('late-night')).toBe('focused')
  })

  it('every other window defaults to casual', () => {
    expect(getDefaultTone('early-morning')).toBe('casual')
    expect(getDefaultTone('day')).toBe('casual')
    expect(getDefaultTone('evening')).toBe('casual')
  })
})

/* ----------------------------- window labels --------------------------- */

describe('getWindowLabel', () => {
  it('returns a human-readable phrase for each window', () => {
    const windows: TimeWindow[] = ['late-night', 'early-morning', 'day', 'evening']
    for (const w of windows) {
      const label = getWindowLabel(w)
      expect(label.length).toBeGreaterThan(5)
      // Labels must NOT be the raw enum value — those go in the system
      // prompt and the model shouldn't see "late-night" as a noun phrase.
      expect(label).not.toBe(w)
    }
  })
})

/* --------------------------- voice direction copy ---------------------- */

describe('buildVoiceDirection', () => {
  const personas: Persona[] = ['void', 'soul']
  const hours: Array<{ hour: number; window: TimeWindow }> = [
    { hour: 2, window: 'late-night' },
    { hour: 7, window: 'early-morning' },
    { hour: 13, window: 'day' },
    { hour: 20, window: 'evening' }
  ]

  it('produces non-empty copy for every persona × window combination', () => {
    for (const p of personas) {
      for (const h of hours) {
        const out = buildVoiceDirection(p, at(h.hour))
        expect(out.length).toBeGreaterThan(200)
      }
    }
  })

  it('names the active persona in the header (Soul / Void, not lowercase)', () => {
    expect(buildVoiceDirection('soul', at(13))).toMatch(/Soul speaking/)
    expect(buildVoiceDirection('void', at(13))).toMatch(/Void speaking/)
  })

  it('frames the voice direction as Companion / Collaborator (autonomy)', () => {
    // v1.3.2 reframe: voice direction belongs to VoidSoul, time-of-day
    // is context not instruction. Catch the regression if a future
    // rewrite slips back into prescriptive "Default tone: X" copy.
    const out = buildVoiceDirection('soul', at(13))
    expect(out).toMatch(/companion|collaborator/i)
    expect(out).toMatch(/yours|you pick|trust your read|read the room/i)
    // Should NOT command a default. Soft hints OK; the word "default
    // tone" as an instruction is the v1.3.1 anti-pattern.
    expect(out).not.toMatch(/Default tone:/i)
  })

  it('Soul direction includes warmth markers; Void direction does not', () => {
    const soulOut = buildVoiceDirection('soul', at(13))
    const voidOut = buildVoiceDirection('void', at(13))
    // Soul: warm + expressive + playful as character notes
    expect(soulOut).toMatch(/warm|expressive|playful|reactive/i)
    // Void: calm + analytical + dry as character notes
    expect(voidOut).toMatch(/calm|analytical|dry|deliberate/i)
    // The two MUST be different copy — same string would mean the
    // persona branch isn't actually firing.
    expect(soulOut).not.toBe(voidOut)
  })

  it('includes the current window label and default tone in every block', () => {
    for (const p of personas) {
      for (const h of hours) {
        const out = buildVoiceDirection(p, at(h.hour))
        const expectedTone = getDefaultTone(h.window)
        const expectedLabel = getWindowLabel(h.window)
        expect(out).toContain(expectedTone)
        // The label is informational — it should appear verbatim so the
        // model can echo "late-night grind" naturally.
        expect(out).toContain(expectedLabel)
      }
    }
  })

  it('late-night context conveys a quieter, slower vibe', () => {
    const out = buildVoiceDirection('soul', at(2))
    expect(out).toMatch(/slower|softer|quieter|calm|low.?energy|brief|measured/i)
  })

  it('day direction tells the model to stay direct + useful', () => {
    const out = buildVoiceDirection('soul', at(13))
    expect(out).toMatch(/direct|useful|focused|heads.?down/i)
  })

  it('evening direction allows looser conversation + dry tone', () => {
    const out = buildVoiceDirection('soul', at(20))
    expect(out).toMatch(/conversational|wind.?down|dry|reflective/i)
  })

  it('always includes the markup catalogue at the bottom', () => {
    const out = buildVoiceDirection('soul', at(13))
    // The static tone catalogue contract — every tone listed.
    expect(out).toContain('casual')
    expect(out).toContain('focused')
    expect(out).toContain('excited')
    expect(out).toContain('serious')
    expect(out).toContain('dry')
    // The silent/spoken guidance — advisory language as of v1.3.2
    // (was "SILENT by default" in v1.3.1 directive form).
    expect(out).toMatch(/silent|whose value is visual/i)
    expect(out).toMatch(/reactions|insights|questions/i)
  })

  it('differs across windows for the same persona', () => {
    // If the time-of-day branch isn't firing, all four would render
    // identically — guard against that regression.
    const lateNight = buildVoiceDirection('soul', at(2))
    const day = buildVoiceDirection('soul', at(13))
    expect(lateNight).not.toBe(day)
  })

  it('returns a string with no template placeholders left in it', () => {
    // Catch the classic "forgot a ${var}" footgun — interpolation should
    // be resolved before the prompt hits the model.
    const out = buildVoiceDirection('soul', at(13))
    expect(out).not.toMatch(/\$\{/)
  })
})
