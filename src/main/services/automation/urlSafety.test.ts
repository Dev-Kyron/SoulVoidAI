import { describe, expect, it } from 'vitest'
import { checkUrlSafe } from './urlSafety'

describe('checkUrlSafe — SSRF guard for agent-driven fetches', () => {
  it('allows ordinary public http(s) URLs', () => {
    expect(checkUrlSafe('https://example.com/page').ok).toBe(true)
    expect(checkUrlSafe('http://docs.example.org').ok).toBe(true)
    expect(checkUrlSafe('https://github.com/owner/repo/blob/main/file').ok).toBe(true)
  })

  it('rejects non-http(s) schemes', () => {
    expect(checkUrlSafe('javascript:alert(1)').ok).toBe(false)
    expect(checkUrlSafe('data:text/html,<script>x</script>').ok).toBe(false)
    expect(checkUrlSafe('file:///etc/passwd').ok).toBe(false)
    expect(checkUrlSafe('vbscript:msgbox(1)').ok).toBe(false)
    expect(checkUrlSafe('ftp://internal').ok).toBe(false)
  })

  it('rejects localhost in every common spelling', () => {
    expect(checkUrlSafe('http://localhost').ok).toBe(false)
    expect(checkUrlSafe('http://localhost:11434/api/show').ok).toBe(false)
    expect(checkUrlSafe('http://LOCALHOST/').ok).toBe(false)
    expect(checkUrlSafe('http://127.0.0.1:8080/admin').ok).toBe(false)
    expect(checkUrlSafe('http://127.255.255.1/').ok).toBe(false)
    expect(checkUrlSafe('http://[::1]/').ok).toBe(false)
  })

  it('rejects RFC 1918 private ranges', () => {
    expect(checkUrlSafe('http://10.0.0.1/').ok).toBe(false)
    expect(checkUrlSafe('http://10.255.255.255/secret').ok).toBe(false)
    expect(checkUrlSafe('http://192.168.1.1/admin').ok).toBe(false)
    expect(checkUrlSafe('http://192.168.255.254/').ok).toBe(false)
    expect(checkUrlSafe('http://172.16.0.1/').ok).toBe(false)
    expect(checkUrlSafe('http://172.31.255.255/').ok).toBe(false)
  })

  it('allows public IPs that look adjacent to private ranges', () => {
    // 172.15.x.x and 172.32.x.x are PUBLIC — the private range is only 172.16-31.
    expect(checkUrlSafe('http://172.15.0.1/').ok).toBe(true)
    expect(checkUrlSafe('http://172.32.0.1/').ok).toBe(true)
    // 11.x.x.x is public (not 10.x.x.x).
    expect(checkUrlSafe('http://11.0.0.1/').ok).toBe(true)
    // 192.169.x.x is public (not 192.168.x.x).
    expect(checkUrlSafe('http://192.169.0.1/').ok).toBe(true)
  })

  it('rejects the cloud metadata endpoint (169.254.169.254)', () => {
    expect(checkUrlSafe('http://169.254.169.254/latest/meta-data/').ok).toBe(false)
    // Whole 169.254/16 link-local range
    expect(checkUrlSafe('http://169.254.0.1/').ok).toBe(false)
  })

  it('rejects 0.0.0.0', () => {
    expect(checkUrlSafe('http://0.0.0.0:8080/').ok).toBe(false)
  })

  it('rejects IPv6 unique-local and link-local', () => {
    expect(checkUrlSafe('http://[fc00::1]/').ok).toBe(false)
    expect(checkUrlSafe('http://[fd12:3456::]/').ok).toBe(false)
    expect(checkUrlSafe('http://[fe80::1]/').ok).toBe(false)
  })

  it('returns a clear reason on failure', () => {
    const r = checkUrlSafe('http://192.168.1.1/admin')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('192.168.1.1')
    expect(r.reason).toMatch(/private|local/i)
  })

  it('handles a parsed URL object as well as a string', () => {
    const url = new URL('http://10.0.0.1/x')
    expect(checkUrlSafe(url).ok).toBe(false)
  })

  it('handles malformed URLs gracefully', () => {
    expect(checkUrlSafe('not a url').ok).toBe(false)
    expect(checkUrlSafe('').ok).toBe(false)
  })
})
