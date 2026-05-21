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

  return { ok: true }
}
