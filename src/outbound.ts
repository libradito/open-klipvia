/**
 * URLs this server will fetch on a page's behalf.
 *
 * Two routes fetch for the browser: `/api/asset`, the rasterizer's proxy, and
 * the from-url imports an agent uses. Both are a way to make this machine
 * request an address of someone else's choosing, and an agent's choice can
 * have come from a transcript it was fed. So every address is checked before
 * it is fetched, and checked again at every redirect, since a public host
 * that answers with `Location: http://169.254.169.254/` is the oldest trick
 * there is.
 *
 * What is refused depends on who is asking. The proxy refuses anything on
 * this machine or its network: it exists to reach fonts on the internet, and
 * a page that can read the LAN through it has been handed a scanner. The
 * imports allow loopback and private addresses — a NAS on the shelf is the
 * most ordinary place footage lives, and this server is meant for one
 * person's own machine — but never link-local, never the cloud metadata
 * addresses, and never a scheme other than http(s).
 *
 * Two details that are easy to get wrong, and were:
 *
 *  - An IPv6 literal has many spellings. The URL parser writes every
 *    IPv4-mapped address in hex (`[::ffff:7f00:1]` is 127.0.0.1), and there
 *    are IPv4-compatible and NAT64 forms besides. So the address is parsed to
 *    its sixteen bytes and classified from those, not matched as text.
 *  - The name is resolved twice: once here to check it, and once more by
 *    `fetch()` to connect. A name whose answer changes between the two is a
 *    classic way past a check. For plain http the connection is made to the
 *    address that was checked, with the name carried in the Host header; for
 *    https the certificate has to match the name, which a rebound address
 *    cannot present, so the name is left for TLS to verify.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

type Scope = 'loopback' | 'private' | 'linklocal' | 'unspecified' | 'public'

/** The addresses every cloud's metadata service answers on. Blocked for everyone. */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata',
  '100.100.100.200',
  '192.0.0.192',
])

function scopeOfV4Bytes(a: number, b: number): Scope {
  if (a === 127) return 'loopback'
  if (a === 0) return 'unspecified'
  if (a === 169 && b === 254) return 'linklocal'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
    return 'private'
  }
  return 'public'
}

function scopeOfV4(ip: string): Scope | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  return scopeOfV4Bytes(Number(m[1]), Number(m[2]))
}

/** The sixteen bytes of an IPv6 literal, or null when it is not one. */
function parseV6(raw: string): Uint8Array | null {
  let ip = raw.replace(/^\[|\]$/g, '').toLowerCase()
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  if (!ip.includes(':')) return null
  // A trailing dotted quad becomes two hextets.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (dotted) {
    const q = dotted.slice(1).map(Number)
    if (q.some((n) => n > 255)) return null
    ip = `${ip.slice(0, dotted.index)}${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`
  }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  if (head.length + tail.length > (halves.length === 2 ? 7 : 8)) return null
  const words = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const w = words[i]!
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null
    const n = parseInt(w, 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

function scopeOfV6(b: Uint8Array): Scope {
  const zeroThrough = (n: number) => b.slice(0, n).every((x) => x === 0)
  if (zeroThrough(16)) return 'unspecified'
  if (zeroThrough(15) && b[15] === 1) return 'loopback'
  // ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-compatible, deprecated) and
  // 64:ff9b::a.b.c.d (NAT64) all carry a v4 address in the last four bytes.
  const mapped = zeroThrough(10) && b[10] === 0xff && b[11] === 0xff
  const compatible = zeroThrough(12)
  const nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)
  if (mapped || compatible || nat64) return scopeOfV4Bytes(b[12]!, b[13]!)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'linklocal'
  if ((b[0]! & 0xfe) === 0xfc) return 'private'
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'private' // site-local, deprecated but routed
  return 'public'
}

function scopeOfIp(raw: string): Scope | null {
  const ip = raw.replace(/^\[|\]$/g, '')
  const v4 = scopeOfV4(ip)
  if (v4) return v4
  const v6 = parseV6(ip)
  return v6 ? scopeOfV6(v6) : null
}

export type Checked = {
  /** Where the request would land; null when the URL is refused. */
  addresses: string[]
  refused: string | null
}

/** Why the URL is refused — or the addresses it resolves to, all of them checked. */
export async function checkOutbound(url: URL, { allowLocal }: { allowLocal: boolean }): Promise<string | null> {
  return (await resolveOutbound(url, { allowLocal })).refused
}

export async function resolveOutbound(url: URL, { allowLocal }: { allowLocal: boolean }): Promise<Checked> {
  const no = (why: string): Checked => ({ addresses: [], refused: why })
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return no('only http(s) urls are allowed')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return no('invalid url')
  if (METADATA_HOSTS.has(host)) return no('blocked host: cloud metadata addresses are never fetched')

  let addresses: string[]
  let scopes: Scope[]
  const literal = scopeOfIp(host)
  if (literal) {
    addresses = [host]
    scopes = [literal]
  } else if (host === 'localhost' || host.endsWith('.localhost')) {
    addresses = ['127.0.0.1']
    scopes = ['loopback']
  } else {
    try {
      const found = await lookup(host, { all: true })
      addresses = found.map((a) => a.address)
      scopes = addresses.map((a) => scopeOfIp(a) ?? 'public')
      if (!scopes.length) return no(`could not resolve ${host}`)
    } catch {
      return no(`could not resolve ${host}`)
    }
    // A name for something that is supposed to be nearby says so itself.
    if (host.endsWith('.local') || host.endsWith('.internal')) scopes.push('private')
  }
  if (addresses.some((a) => METADATA_HOSTS.has(a))) return no('blocked host: cloud metadata addresses are never fetched')

  if (scopes.includes('linklocal') || scopes.includes('unspecified')) {
    return no(`blocked host: ${host} is a link-local address`)
  }
  if (!allowLocal && (scopes.includes('loopback') || scopes.includes('private'))) {
    return no(`blocked host: ${host} is on this machine or its network`)
  }
  return { addresses, refused: null }
}

export type Guarded =
  | { ok: true; res: Response; url: URL }
  | { ok: false; status: 400 | 403 | 502; error: string }

/**
 * Fetch with every hop checked. Redirects are followed by hand so the host
 * each one lands on goes through the same gate as the first, and a plain-http
 * hop connects to the very address that passed the check.
 */
export async function fetchGuarded(
  input: string | URL,
  { allowLocal, timeoutMs, headers, maxHops = 5 }: { allowLocal: boolean; timeoutMs: number; headers?: Record<string, string>; maxHops?: number },
): Promise<Guarded> {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : input
  } catch {
    return { ok: false, status: 400, error: 'invalid url' }
  }
  const signal = AbortSignal.timeout(timeoutMs)

  for (let hop = 0; ; hop++) {
    const checked = await resolveOutbound(url, { allowLocal })
    if (checked.refused) {
      return { ok: false, status: checked.refused.startsWith('blocked') ? 403 : 400, error: checked.refused }
    }

    // Pin the connection to the checked address. Only for http: an https
    // connection to a bare address could not verify the name's certificate,
    // and that certificate is what protects https from a rebound name.
    let target = url
    const sendHeaders: Record<string, string> = { ...(headers ?? {}) }
    const named = !isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname !== 'localhost'
    if (url.protocol === 'http:' && named && checked.addresses[0]) {
      const ip = checked.addresses.find((a) => isIP(a) === 4) ?? checked.addresses[0]
      target = new URL(url.toString())
      target.hostname = isIP(ip) === 6 ? `[${ip}]` : ip
      sendHeaders.host = url.host
    }

    let res: Response
    try {
      res = await fetch(target, { headers: sendHeaders, signal, redirect: 'manual' })
    } catch (err) {
      return { ok: false, status: 502, error: String((err as Error).message ?? err) }
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= maxHops) return { ok: false, status: 502, error: 'too many redirects' }
      try {
        url = new URL(location, url)
      } catch {
        return { ok: false, status: 502, error: `bad redirect to ${location}` }
      }
      continue
    }
    return { ok: true, res, url }
  }
}
