/**
 * URL-safety guard for outbound HTTP calls the agent makes (web_fetch, the
 * DuckDuckGo redirect unwrapper, future tool URLs). The agent is driven by
 * model output, which can be adversarially influenced — a prompt-injected
 * page or rogue tool result could nudge the agent to fetch sensitive local
 * endpoints if the host wasn't vetted.
 *
 * Concretely we reject:
 *   - Non-http(s) schemes (javascript:, data:, file:, etc.)
 *   - Hostnames that resolve to private / loopback / link-local ranges
 *     (RFC 1918 + 127.0.0.0/8 + 169.254.0.0/16 + ::1 + fc00::/7 + fe80::/10)
 *   - Cloud-metadata endpoints (169.254.169.254, fd00:ec2::254)
 *   - localhost/127.* by hostname *before* DNS, so a string like
 *     `http://localhost:11434/api/show` is blocked even without resolving
 *
 * The check is purely string/IP-based — we don't do a separate DNS lookup
 * because (a) it adds latency to every fetch and (b) opens its own TOCTOU
 * (DNS could resolve differently between the check and the actual fetch).
 * A hostname like `internal.corp.example` would bypass this guard; we accept
 * that since the user explicitly granted the network tool and it's their
 * own corp DNS. This guard is about *agent-driven* injection, not full
 * network egress lockdown.
 */

const PRIVATE_HOSTNAME_PATTERNS = [
  // localhost (any variant)
  /^localhost$/i,
  /^localhost\./i,
  // 127.0.0.0/8 (loopback)
  /^127(?:\.\d{1,3}){3}$/,
  // 10.0.0.0/8 (private)
  /^10(?:\.\d{1,3}){3}$/,
  // 172.16.0.0/12 (private)
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  // 192.168.0.0/16 (private)
  /^192\.168(?:\.\d{1,3}){2}$/,
  // 169.254.0.0/16 (link-local, includes 169.254.169.254 cloud metadata)
  /^169\.254(?:\.\d{1,3}){2}$/,
  // 0.0.0.0
  /^0\.0\.0\.0$/,
  // IPv6 loopback
  /^\[?::1\]?$/,
  // IPv6 unique local fc00::/7
  /^\[?fc/i,
  /^\[?fd/i,
  // IPv6 link-local fe80::/10
  /^\[?fe8/i,
  /^\[?fe9/i,
  /^\[?fea/i,
  /^\[?feb/i
]

export interface UrlSafetyResult {
  ok: boolean
  /** Human-readable reason on failure — surfaced as the tool error. */
  reason?: string
}

/**
 * Checks whether the URL is safe for an agent-driven outbound fetch. Pass
 * the parsed URL OR a string (parsing failure counts as unsafe).
 */
export function checkUrlSafe(input: string | URL): UrlSafetyResult {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : input
  } catch {
    return { ok: false, reason: `Not a valid URL: ${String(input)}` }
  }

  // Scheme allowlist — covers both web_fetch and the DDG unwrap. javascript:,
  // data:, file:, vbscript: are all blocked here.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Only http(s) URLs are supported (got ${url.protocol}).` }
  }

  // Strip brackets from IPv6 hostnames before pattern matching; URL keeps
  // them in `hostname` for IPv6 addresses.
  const host = url.hostname.toLowerCase()
  for (const pat of PRIVATE_HOSTNAME_PATTERNS) {
    if (pat.test(host)) {
      return {
        ok: false,
        reason: `Refusing to fetch a private/local address (${host}). Agent tools shouldn't reach internal services.`
      }
    }
  }

  // v2.0 round-3 security polish — non-dotted-quad IPv4 representations
  // bypass PRIVATE_HOSTNAME_PATTERNS. `http://2130706433/` (decimal
  // 127.0.0.1), `http://0177.0.0.1/` (octal), `http://0/` (zero-page)
  // all parse fine and slip through. Normalise via the inet4 parser and
  // re-check against the loopback / private ranges as integers.
  const ipv4 = parseIpv4(host)
  if (ipv4 !== null) {
    if (isPrivateOrLoopbackIpv4(ipv4)) {
      return {
        ok: false,
        reason: `Refusing to fetch a private/local address (decoded from ${host}). Agent tools shouldn't reach internal services.`
      }
    }
  }
  // Strip brackets for IPv6-mapped-IPv4 like `[::ffff:127.0.0.1]`. Node's
  // URL parser normalises this to `[::ffff:7f00:1]` (two hex shorts), so
  // we have to accept BOTH forms: dotted-quad-tail OR two-hex-shorts-tail.
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1)
    const mapped = inner.match(/^::ffff:(.+)$/i)
    if (mapped) {
      const mappedIp = parseMappedIpv4Tail(mapped[1])
      if (mappedIp !== null && isPrivateOrLoopbackIpv4(mappedIp)) {
        return {
          ok: false,
          reason: `Refusing to fetch IPv4-mapped private/local address (${host}).`
        }
      }
    }
  }

  return { ok: true }
}

/**
 * Parse an IPv4 hostname including the non-canonical forms `node:net.isIP`
 * doesn't accept (decimal `2130706433`, octal `0177.0.0.1`, single-zero `0`).
 * Returns a 32-bit unsigned integer or null when the input clearly isn't an
 * IPv4 encoding. Implementation mirrors the historical inet_aton accepting
 * 1-4 dotted parts.
 */
function parseIpv4(host: string): number | null {
  if (!host) return null
  // Plain integer ("http://0" or "http://2130706433")
  if (/^[0-9a-fx]+$/i.test(host)) {
    const n = parseLooseInt(host)
    if (n === null) return null
    if (n < 0 || n > 0xffffffff) return null
    return n
  }
  const parts = host.split('.')
  if (parts.length === 0 || parts.length > 4) return null
  for (const part of parts) {
    if (part.length === 0) return null
    if (!/^[0-9a-fx]+$/i.test(part)) return null
  }
  // inet_aton-style: 1/2/3/4 part forms each have a different shape.
  // For 4-part dotted-quad, each byte is 0-255.
  if (parts.length === 4) {
    const bytes = parts.map(parseLooseInt)
    if (bytes.some((b) => b === null)) return null
    if (bytes.some((b) => (b as number) < 0 || (b as number) > 255)) return null
    return (
      (((bytes[0] as number) << 24) |
        ((bytes[1] as number) << 16) |
        ((bytes[2] as number) << 8) |
        (bytes[3] as number)) >>>
      0
    )
  }
  // Reject 2/3-part forms — they're legal under inet_aton but extremely
  // suspicious as URLs. Treating them as not-ipv4 means downstream regex
  // can still match if they happen to be dotted-quad-shaped.
  return null
}

/**
 * Parse a string in decimal, hex (`0x`), or octal (leading-zero) form into
 * a non-negative integer. Returns null on parse error.
 */
function parseLooseInt(s: string): number | null {
  if (!s) return null
  let base = 10
  let body = s
  if (/^0x/i.test(s)) {
    base = 16
    body = s.slice(2)
  } else if (s.length > 1 && s.startsWith('0')) {
    base = 8
    body = s.slice(1)
  }
  if (body.length === 0) return base === 8 ? 0 : null
  const n = parseInt(body, base)
  if (Number.isNaN(n)) return null
  // parseInt accepts trailing garbage; reject anything that isn't the full
  // input under the chosen base.
  if (n.toString(base) !== body.toLowerCase().replace(/^0+/, '') && body !== '0') {
    // Permit leading zeros, reject e.g. "08" under base 8.
    if (!new RegExp(`^0*${n.toString(base)}$`).test(body.toLowerCase())) return null
  }
  return n
}

/**
 * Parse the tail portion of an IPv4-mapped IPv6 address (the bit after
 * `::ffff:`). Accepts both dotted-quad (`127.0.0.1`) and Node's compressed
 * two-hex-shorts form (`7f00:1`). Returns the 32-bit unsigned IPv4.
 */
function parseMappedIpv4Tail(tail: string): number | null {
  // Direct dotted-quad form.
  if (tail.includes('.')) return parseIpv4(tail)
  // Two-hex-shorts form, e.g. `7f00:1` (each part is 0-FFFF; second part
  // can be a single shortened group when the lower bytes are zero).
  const parts = tail.split(':')
  if (parts.length !== 2) return null
  const hi = parseInt(parts[0], 16)
  const lo = parseInt(parts[1], 16)
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null
  if (hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) return null
  return ((hi << 16) | lo) >>> 0
}

/** True for any 32-bit IPv4 sitting in loopback / RFC1918 / link-local. */
function isPrivateOrLoopbackIpv4(ip: number): boolean {
  // 0.0.0.0/8 (includes the bare `0` zero-page form)
  if ((ip & 0xff000000) === 0x00000000) return true
  // 127.0.0.0/8
  if ((ip & 0xff000000) === 0x7f000000) return true
  // 10.0.0.0/8
  if ((ip & 0xff000000) === 0x0a000000) return true
  // 172.16.0.0/12
  if ((ip & 0xfff00000) === 0xac100000) return true
  // 192.168.0.0/16
  if ((ip & 0xffff0000) === 0xc0a80000) return true
  // 169.254.0.0/16 (link-local + AWS metadata)
  if ((ip & 0xffff0000) === 0xa9fe0000) return true
  return false
}
