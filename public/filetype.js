/**
 * What a file is, read from its bytes — and how an agent hands one over.
 *
 * A WebMCP tool call is JSON on both sides: a Blob in an argument arrives as
 * `{}`. So when an agent holds the bytes of a file itself — a logo it drew, a
 * voice-over it was given — the only way to pass them is as text: a `data:`
 * URL, or the text of an SVG. Text that claims to be a PNG is not one, and the
 * libraries store by extension, so something has to look at the bytes before
 * a filename is chosen. That is this file.
 *
 * Plain JavaScript, like `subtitles.js`, because both back ends need it: the
 * server's from-url routes and the browser's in-page `localstore.js` decide
 * the same way, and a data: URL that is refused on one is refused on both.
 */

/** Decoded size an inline (data: URL or text) file may have, per library. */
export const INLINE_CAPS = {
  asset: 8 * 1024 * 1024,
  media: 24 * 1024 * 1024,
  text: 2 * 1024 * 1024,
}

/** extension -> mime, per library. The same lists the upload routes accept. */
export const ASSET_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
}
export const MEDIA_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
}

/** Extensions that name the same container, so a caller's choice among them is kept. */
const FAMILY = {
  jpg: 'jpeg', jpeg: 'jpeg',
  mp4: 'isobmff', m4v: 'isobmff', m4a: 'isobmff', mov: 'isobmff',
  mkv: 'matroska', webm: 'matroska',
  ogg: 'ogg', opus: 'ogg',
}
const family = (ext) => FAMILY[ext] ?? ext

const ascii = (b, at, n) => {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i] ?? 0)
  return s
}

/** `<svg` near the top, after any prolog, comments or doctype; nothing binary before it. */
function looksLikeSvg(bytes) {
  let head
  try {
    // Only the head is read, so a multibyte character cut in half at the
    // edge is not a fault: `stream` tells the decoder more may follow.
    const n = Math.min(bytes.length, 4096)
    head = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n), { stream: n < bytes.length })
  } catch {
    return false
  }
  const i = head.search(/<svg[\s>]/i)
  if (i < 0) return false
  // Everything before the tag must be XML furniture, not content.
  const before = head.slice(0, i).replace(/^﻿/, '')
  return /^(\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*$/i.test(before)
}

/** The asset extension the bytes are, or null. */
export function sniffAsset(bytes) {
  const b = bytes
  if (b.length < 4) return null
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (ascii(b, 0, 4) === 'GIF8') return 'gif'
  if (ascii(b, 4, 4) === 'ftyp' && /^avi[fs]/.test(ascii(b, 8, 4))) return 'avif'
  if (ascii(b, 0, 4) === 'wOF2') return 'woff2'
  if (ascii(b, 0, 4) === 'wOFF') return 'woff'
  if (ascii(b, 0, 4) === 'OTTO') return 'otf'
  if ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || ascii(b, 0, 4) === 'true') return 'ttf'
  if (looksLikeSvg(b)) return 'svg'
  return null
}

/** The media extension the bytes are, or null. */
export function sniffMedia(bytes) {
  const b = bytes
  if (b.length < 12) return null
  const four = ascii(b, 0, 4)
  if (four === 'RIFF') {
    const kind = ascii(b, 8, 4)
    return kind === 'WAVE' ? 'wav' : kind === 'AVI ' ? 'avi' : null
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (brand.startsWith('qt')) return 'mov'
    if (brand === 'M4A ') return 'm4a'
    if (brand === 'M4V ') return 'm4v'
    return 'mp4'
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML; the DocType string sits inside the first few dozen bytes.
    return ascii(b, 0, Math.min(b.length, 64)).includes('webm') ? 'webm' : 'mkv'
  }
  if (four === 'fLaC') return 'flac'
  if (four === 'OggS') return ascii(b, 0, Math.min(b.length, 64)).includes('OpusHead') ? 'opus' : 'ogg'
  if (ascii(b, 0, 3) === 'ID3') return 'mp3'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    // Frame sync. Layer bits 00 is reserved for MPEG audio and is what ADTS uses.
    return (b[1] & 0xf6) === 0xf0 ? 'aac' : 'mp3'
  }
  return null
}

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''))
  return m ? m[1].toLowerCase() : null
}
const stem = (name) => String(name).replace(/\.[A-Za-z0-9]+$/, '')

function extForMime(mime, table) {
  const m = String(mime ?? '').split(';')[0].trim().toLowerCase()
  if (!m) return null
  return Object.keys(table).find((ext) => table[ext] === m) ?? null
}

/**
 * The filename a file that arrived as bytes should be stored under.
 *
 * The bytes decide. A name is welcome — it is what the library shows — but its
 * extension is kept only when it agrees with what the bytes are, and is made
 * up from the bytes (or, failing those, the declared media type) when it is
 * missing or wrong. `strict` is for bytes that came out of a data: URL, where
 * nothing else vouches for them: if the sniff finds nothing, they are refused.
 * A file fetched from a URL whose name already carries an allowed extension is
 * trusted when the sniff is silent, as an upload would be.
 *
 * Returns `{ ok: true, name, ext, mime, sniffed }` or `{ ok: false, error }`.
 */
export function nameIncoming(kind, bytes, { name = '', mime = '', strict = false } = {}) {
  const table = kind === 'media' ? MEDIA_TYPES : ASSET_TYPES
  const sniffed = kind === 'media' ? sniffMedia(bytes) : sniffAsset(bytes)
  const nameExt = extOf(name)
  const mimeExt = extForMime(mime, table)

  let ext
  if (sniffed) {
    ext = nameExt && table[nameExt] && family(nameExt) === family(sniffed) ? nameExt
      : mimeExt && family(mimeExt) === family(sniffed) ? mimeExt
        : sniffed
  } else if (!strict && nameExt && table[nameExt]) {
    ext = nameExt
  } else {
    const list = Object.keys(table).join(', ')
    return {
      ok: false,
      error:
        `the bytes are not a file type the ${kind} library stores (${list})` +
        (strict ? ' — check the data: URL is complete and base64-encoded' : ''),
    }
  }

  const base = (name ? stem(name) : '').trim() || (kind === 'media' ? 'media' : 'asset')
  return { ok: true, name: `${base}.${ext}`, ext, mime: table[ext], sniffed }
}

/* ------------------------------------------------------------ data: URLs */

export const isDataUrl = (s) => /^data:/i.test(String(s ?? '').trimStart())

/** Roughly how many bytes a data: URL decodes to, without decoding it. */
export function dataUrlSize(s) {
  const m = /^\s*data:([^,]*?)(;base64)?,/i.exec(String(s ?? ''))
  if (!m) return 0
  const len = s.length - m[0].length
  return m[2] ? Math.floor((len * 3) / 4) : len
}

function base64ToBytes(payload) {
  const clean = payload.replace(/\s+/g, '')
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'))
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Percent-decoding to bytes, not to a string — a %89 is a byte, not a character. */
function percentToBytes(payload) {
  const out = []
  const enc = new TextEncoder()
  for (let i = 0; i < payload.length; ) {
    const cp = payload.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    if (ch === '%' && /^[0-9a-f]{2}$/i.test(payload.slice(i + 1, i + 3))) {
      out.push(parseInt(payload.slice(i + 1, i + 3), 16))
      i += 3
      continue
    }
    if (cp < 128) out.push(cp)
    else out.push(...enc.encode(ch))
    i += ch.length
  }
  return Uint8Array.from(out)
}

/**
 * `data:image/png;base64,…` → `{ ok: true, mime, bytes }`, or a refusal with
 * the HTTP status it deserves. The size is checked before decoding so a
 * hundred-megabyte string costs nothing but a length read.
 */
export function decodeDataUrl(s, { cap = Infinity, kind = 'file' } = {}) {
  const str = String(s ?? '').trimStart()
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(str)
  if (!m) return { ok: false, status: 400, error: 'not a data: URL — expected data:<mime>[;base64],<payload>' }
  const mb = (n) => (n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)
  const tooBig = (n) => ({
    ok: false,
    status: 413,
    error: `that data: URL decodes to about ${mb(n)} MB; an inline ${kind} is capped at ${mb(cap)} MB — host the file on a URL instead`,
  })
  const est = dataUrlSize(str)
  if (est > cap * 1.02) return tooBig(est)

  const mime = (m[1].split(';')[0] || 'application/octet-stream').trim().toLowerCase()
  let bytes
  try {
    bytes = m[2] ? base64ToBytes(m[3]) : percentToBytes(m[3])
  } catch (err) {
    return { ok: false, status: 400, error: `could not decode that data: URL: ${err?.message ?? err}` }
  }
  if (!bytes.length) return { ok: false, status: 400, error: 'that data: URL is empty' }
  if (bytes.length > cap) return tooBig(bytes.length)
  return { ok: true, mime, bytes }
}

export { looksLikeSvg }
