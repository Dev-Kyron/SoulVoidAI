/**
 * v1.12.0 — currency conversion math + formatter tests. The math is
 * load-bearing for the Usage budget (a wrong conversion makes the % bar
 * lie), so each rule is pinned. Formatter tests are looser — Intl
 * output varies across locales so we only assert that the key tokens
 * (symbol or code, the digits) show up.
 */
import { describe, it, expect } from 'vitest'
import {
  CURRENCIES,
  getCurrencyMeta,
  usdToLocal,
  localToUsd,
  formatLocal,
  formatUsdAsLocal
} from './currencies'

describe('CURRENCIES catalogue', () => {
  it('has unique codes', () => {
    const codes = CURRENCIES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('USD always has rate 1', () => {
    expect(getCurrencyMeta('USD').defaultUsdRate).toBe(1)
  })

  it('includes the top-10 set the dashboard ships with', () => {
    const codes = CURRENCIES.map((c) => c.code)
    for (const required of ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL']) {
      expect(codes).toContain(required)
    }
  })
})

describe('usdToLocal / localToUsd', () => {
  it('round-trips at rate 1 (USD identity)', () => {
    expect(usdToLocal(50, 1)).toBe(50)
    expect(localToUsd(50, 1)).toBe(50)
  })

  it('converts USD into EUR at a sample rate', () => {
    expect(usdToLocal(100, 0.92)).toBeCloseTo(92, 6)
  })

  it('round-trips USD → local → USD with no loss', () => {
    const usd = 54.35
    const rate = 0.92
    const local = usdToLocal(usd, rate)
    expect(localToUsd(local, rate)).toBeCloseTo(usd, 6)
  })

  it('handles JPY-style large rates without overflow', () => {
    expect(usdToLocal(10, 152)).toBe(1520)
    expect(localToUsd(1520, 152)).toBeCloseTo(10, 6)
  })

  it('returns 0 USD when rate is 0 (no Infinity)', () => {
    expect(localToUsd(50, 0)).toBe(0)
  })

  it('returns 0 USD when rate is negative (no nonsense)', () => {
    expect(localToUsd(50, -1)).toBe(0)
  })
})

describe('formatLocal', () => {
  // Note: Intl.NumberFormat in Node ships with reduced ICU data, so
  // currency formatting may fall back to "USD 12.34" instead of "$12.34"
  // in tests. The renderer runs in Chromium with full data and gets the
  // symbols right. Tests assert on the currency code OR the symbol — at
  // least one must surface — and on the digit formatting.
  it('formats USD with a currency marker and 2 digits by default', () => {
    const out = formatLocal(12.34, 'USD')
    expect(out).toMatch(/12\.34/)
    expect(out).toMatch(/\$|USD/)
  })

  it('formats EUR with a currency marker', () => {
    const out = formatLocal(12.34, 'EUR')
    expect(out).toMatch(/12[.,]34/)
    expect(out).toMatch(/€|EUR/)
  })

  it('honours the digits override for sub-cent precision', () => {
    const out = formatLocal(0.0042, 'USD', 4)
    expect(out).toMatch(/0\.0042/)
  })
})

describe('formatUsdAsLocal', () => {
  it('shows USD unchanged at rate 1', () => {
    expect(formatUsdAsLocal(12.34, 'USD', 1)).toMatch(/12\.34/)
  })

  it('multiplies USD by rate when converting to local currency', () => {
    const out = formatUsdAsLocal(100, 'EUR', 0.92)
    // 100 USD × 0.92 = 92 EUR
    expect(out).toMatch(/92/)
  })

  it("expands digits for sub-cent costs so they don't read as zero", () => {
    // 0.003 USD × 1 = 0.003 — must render with 3+ digits, not "$0.00"
    const out = formatUsdAsLocal(0.003, 'USD', 1)
    expect(out).toMatch(/0\.003/)
  })

  it('uses 4 digits for very small amounts', () => {
    const out = formatUsdAsLocal(0.00042, 'USD', 1)
    expect(out).toMatch(/0\.0004/)
  })
})
