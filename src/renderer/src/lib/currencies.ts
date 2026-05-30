/**
 * v1.12.0 — currency catalogue for the Usage budget panel.
 *
 * Provider API pricing is always USD (that's how OpenAI, Anthropic, etc.
 * publish), so `UsageEntry.cost` is canonical USD. The budget panel
 * displays in the user's chosen currency via a manual conversion rate
 * they set — honest, deterministic, works offline, no FX API dep.
 *
 * Conversion direction: `usdRate` answers "how many units of the local
 * currency is 1 USD worth?". So €0.92 if you're in EUR, ¥152 in JPY.
 *   localAmount = usdAmount * usdRate
 *   usdAmount   = localAmount / usdRate
 *
 * Default rates below are late-2025 snapshots — close enough to spare the
 * user from typing "1 USD = 0.92" by hand. They can override per
 * currency. We don't auto-refresh; if a user wants precise FX they'll
 * type it.
 */

export type CurrencyCode =
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'JPY'
  | 'CAD'
  | 'AUD'
  | 'CHF'
  | 'CNY'
  | 'INR'
  | 'BRL'

export interface CurrencyMeta {
  code: CurrencyCode
  name: string
  /** Late-2025 reference rate — 1 USD = N units of this currency. Used as
   *  the initial value when the user first picks the currency; they can
   *  override to whatever rate their bank actually applies. */
  defaultUsdRate: number
}

export const CURRENCIES: readonly CurrencyMeta[] = [
  { code: 'USD', name: 'US Dollar', defaultUsdRate: 1.0 },
  { code: 'EUR', name: 'Euro', defaultUsdRate: 0.92 },
  { code: 'GBP', name: 'British Pound', defaultUsdRate: 0.79 },
  { code: 'JPY', name: 'Japanese Yen', defaultUsdRate: 152.0 },
  { code: 'CAD', name: 'Canadian Dollar', defaultUsdRate: 1.37 },
  { code: 'AUD', name: 'Australian Dollar', defaultUsdRate: 1.52 },
  { code: 'CHF', name: 'Swiss Franc', defaultUsdRate: 0.91 },
  { code: 'CNY', name: 'Chinese Yuan', defaultUsdRate: 7.24 },
  { code: 'INR', name: 'Indian Rupee', defaultUsdRate: 83.5 },
  { code: 'BRL', name: 'Brazilian Real', defaultUsdRate: 5.12 }
]

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c] as const))

export function getCurrencyMeta(code: CurrencyCode): CurrencyMeta {
  return BY_CODE.get(code) ?? CURRENCIES[0]
}

/** Convert canonical USD into the user's local currency at their stored
 *  rate. Pure arithmetic; tests can pin edge cases without a UI. */
export function usdToLocal(usd: number, usdRate: number): number {
  return usd * usdRate
}

/** Inverse — take a value the user typed in local currency and return
 *  the USD amount we store internally. Returns 0 if rate is 0 to avoid
 *  Infinity sneaking into the store. */
export function localToUsd(local: number, usdRate: number): number {
  if (usdRate <= 0) return 0
  return local / usdRate
}

/** Format a local-currency amount via Intl.NumberFormat — gives natural
 *  symbol placement (€1.23, ¥123, R$1,23). The `digits` param caps the
 *  fraction; some currencies (JPY) have zero by default but we honour
 *  the caller for sub-unit precision (e.g. tiny per-call costs). */
export function formatLocal(amount: number, currency: CurrencyCode, digits: number = 2): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: digits,
      minimumFractionDigits: digits === 0 ? 0 : Math.min(2, digits)
    }).format(amount)
  } catch {
    // Defensive — locale shouldn't fail, but if it does fall back to a
    // basic code-prefixed string so the UI doesn't blank out.
    return `${currency} ${amount.toFixed(digits)}`
  }
}

/** Display USD as local currency, picking digits based on magnitude so
 *  tiny costs don't read as "$0.00". Mirrors the dollar helper that
 *  already exists in UsageSettings; centralised so other panels can
 *  reuse the same rules. */
export function formatUsdAsLocal(usd: number, currency: CurrencyCode, usdRate: number): string {
  const local = usdToLocal(usd, usdRate)
  if (local === 0) return formatLocal(0, currency, 2)
  // Sub-one-cent values: show with more precision so per-call rows
  // ("$0.003") don't all read as zero in non-USD currencies.
  const digits = Math.abs(local) < 0.01 ? 4 : Math.abs(local) < 1 ? 3 : 2
  return formatLocal(local, currency, digits)
}
