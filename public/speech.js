/**
 * Speech in and out: turning sound into words, and words into sound.
 *
 * Klipvia's promise is that your work never leaves your browser, and speech is
 * the first place that promise has to be qualified rather than repeated. So the
 * organising fact here is not who makes the model — it is **where the audio
 * goes**. Every entry below carries that, the UI shows it on every row, and the
 * list is ordered from the answer that keeps everything here to the answer that
 * sends it somewhere else.
 *
 * Things learned the hard way, all of which shape this file:
 *
 * 1. A browser can only call what will let it, and it will not say why it
 *    could not. A refused origin, a server that is off, and a Chrome permission
 *    somebody clicked "Block" on all reject as the same bare `TypeError`. So a
 *    failure to reach a machine provider is *diagnosed* rather than guessed
 *    (`diagnoseReach`), and the answer names the one thing to do.
 *
 * 2. The browser's own voices cannot be recorded. `speechSynthesis` has no
 *    route to a MediaStream or an AudioBuffer. They read text aloud for free,
 *    offline, in two hundred voices — and they can never put a byte into a
 *    video file. What they *can* do is time a script: see `timeSpeech`.
 *
 * 3. Almost everything speaks OpenAI's shape. whisper.cpp's server, Speaches,
 *    LocalAI, Kokoro-FastAPI and Groq all take the same two routes, so one
 *    adapter with a configurable base URL covers a local model and a hosted one.
 *
 * 4. Every voice has a language, and a picker that hides that is a picker that
 *    offers forty English voices to somebody narrating in Spanish. Every voice
 *    object here is `{ id, name, lang, gender?, note?, langs? }`, and every
 *    provider says which languages it can speak.
 *
 * Imports without a DOM: Bun runs the pure functions as tests. Anything that
 * reads `location` or `navigator` does so inside a function, guarded.
 */

import { baseLang, normaliseLang } from './languages.js'

/* ------------------------------------------------------------------- where */

/**
 * The only distinction that matters to the person choosing, in their words.
 * `rank` orders every list: the most private answer that works comes first.
 */
export const WHERE = {
  browser: { id: 'browser', label: 'in this browser', rank: 0, tone: 'good' },
  machine: { id: 'machine', label: 'on your machine', rank: 1, tone: 'ok' },
  provider: { id: 'provider', label: 'sent to a provider', rank: 2, tone: 'warn' },
}

/* ------------------------------------------------------------------ errors */

class SpeechError extends Error {
  constructor(message, { provider, status, diagnosis = null, remedy = null } = {}) {
    super(message)
    this.name = 'SpeechError'
    this.provider = provider
    this.status = status
    /** What `diagnoseReach` found, when the failure was reaching a server. */
    this.diagnosis = diagnosis
    /** Steps that fix it: `[{ os?, steps: [{ text, command? }] }]`. */
    this.remedy = remedy
  }
}

/* ------------------------------------------------------------- the network */

const trimSlash = (s) => String(s ?? '').replace(/\/+$/, '')

/**
 * Which network a host is on: `loopback` (this machine), `local` (this
 * network: RFC 1918, link-local, `.local`), or `public`. The same three
 * classes Chrome's Local Network Access uses, because that is what decides
 * whether a request is even allowed to be made.
 */
export function hostKind(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return 'public'
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)) return 'loopback'
  if (
    h.endsWith('.local') ||
    /^10(\.\d{1,3}){3}$/.test(h) ||
    /^192\.168(\.\d{1,3}){2}$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h) ||
    /^169\.254(\.\d{1,3}){2}$/.test(h) ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h)
  ) {
    return 'local'
  }
  return 'public'
}

export const isPrivateHost = (host) => hostKind(host) !== 'public'

/** The page, or a stand-in when there is none (tests). */
function pageInfo() {
  const loc = globalThis.location
  if (!loc?.origin || loc.origin === 'null') return { origin: null, host: '', href: 'http://localhost/', secure: false, protocol: 'http:' }
  return { origin: loc.origin, host: loc.hostname, href: loc.href, secure: !!globalThis.isSecureContext, protocol: loc.protocol }
}

const pageOrigin = () => pageInfo().origin ?? 'this page'

/**
 * The fetch options a request to a machine on this network needs.
 *
 * From an https page, Chrome will only talk http to a private address when the
 * request says which network it expects to reach (`targetAddressSpace`), and
 * refuses a plain fetch as mixed content when the host is a name rather than
 * an IP. Adding the field costs nothing where it is not needed; a browser that
 * does not know it ignores it, and one that rejects a value is asked with the
 * next one. `new Request()` is the feature test.
 */
export function fetchInit(url, init = {}) {
  const page = pageInfo()
  if (!page.secure || init.targetAddressSpace) return init
  let host
  try {
    host = new URL(url, page.href).hostname
  } catch {
    return init
  }
  const kind = hostKind(host)
  if (kind === 'public') return init
  const spaces = kind === 'loopback' ? ['loopback'] : ['local', 'private']
  for (const space of spaces) {
    const next = { ...init, targetAddressSpace: space }
    try {
      if (typeof Request === 'function') new Request(new URL(url, page.href).href, { ...next, body: undefined })
      return next
    } catch {
      /* not this value; try the older name */
    }
  }
  return init
}

/* ------------------------------------------------------------------- relay */

/**
 * Where a provider request is actually sent from.
 *
 * With no server, the page calls the provider itself and lives with whoever
 * refuses it. With a server — the one serving this page — hosted APIs go
 * through `/api/speech/relay` so there is no cross-origin request for anyone
 * to refuse. A machine provider is different: "127.0.0.1" means *the
 * browser's* machine, and the server is only on that machine when the page
 * itself is served from a loopback address. A Klipvia server on another
 * computer asking its own loopback for VoiceBox would find nothing there, so in
 * that case the page calls the machine directly, as it does with no server.
 */
let relayVia = null

export function useRelay(on) {
  relayVia = on ? '/api/speech/relay' : null
}

/** True when this page has a server that can call providers on its behalf. */
export const hasRelay = () => !!relayVia

export function relayDecision(url, { page = pageInfo(), relay = !!relayVia } = {}) {
  if (!relay) return false
  let target
  try {
    target = new URL(url, page.href)
  } catch {
    return false
  }
  if (page.origin && target.origin === page.origin) return false
  if (hostKind(target.hostname) === 'public') return true
  return hostKind(page.host) === 'loopback'
}

const viaRelay = (url) => (relayDecision(url) ? `${relayVia}?url=${encodeURIComponent(url)}` : url)

/** Would this provider's calls go through Klipvia's server, as configured? */
export function relayFor(provider, conf = {}) {
  if (!relayVia || !provider) return false
  if (provider.where === 'browser') return false
  if (provider.where === 'provider') return true
  const base = provider.id === 'voicebox' ? plainBase(conf.base) : normaliseBase(conf.base)
  return relayDecision(base || `http://127.0.0.1/`)
}

/* --------------------------------------------------------------- diagnosis */

/** mac | windows | linux | other, from what the browser will say. */
export function platformOf() {
  const nav = globalThis.navigator
  const p = String(nav?.userAgentData?.platform ?? nav?.platform ?? '').toLowerCase()
  if (/mac|iphone|ipad/.test(p)) return 'mac'
  if (/win/.test(p)) return 'windows'
  if (/linux|android|cros/.test(p)) return 'linux'
  return 'other'
}

const isSafari = () => {
  const ua = String(globalThis.navigator?.userAgent ?? '')
  return /safari/i.test(ua) && !/chrome|chromium|crios|android|edg/i.test(ua)
}

/**
 * Why a machine on this network could not be reached — measured, not guessed.
 *
 * Three signals, because the browser gives none: a `no-cors` fetch resolves
 * (opaquely) when *something* answered and rejects when nothing did, which
 * separates "not running" from "running but refuses this page"; a plain CORS
 * fetch of the same cheap route says whether this origin is allowed; and the
 * Permissions API says whether Chrome itself is refusing local-network access
 * for this site. The permission only counts when it applies — a public https
 * page reaching a local address — because an http page always reports
 * `denied` even though nothing is being blocked.
 *
 * `probe` is a cheap GET on that server: VoiceBox `/health`, OpenAI-shaped
 * `/models`. Returns `{ reachable, refused, allows, permission, mixedContent,
 * secure, origin, target, kind, lnaApplies, outcome }`; `outcome` is one of
 * `refused | ok | permission | mixed | down | address`.
 */
export async function diagnoseReach(base, { probe = '/', timeoutMs = 4000, fetchImpl, permissions, page } = {}) {
  const f = fetchImpl ?? globalThis.fetch
  const perms = permissions === undefined ? globalThis.navigator?.permissions : permissions
  const pg = page ?? pageInfo()
  let target
  try {
    target = new URL(base)
  } catch {
    return { reachable: false, refused: false, allows: null, permission: null, mixedContent: false, secure: pg.secure, origin: pg.origin, target: String(base), kind: 'public', lnaApplies: false, outcome: 'address' }
  }
  const probeUrl = /^https?:\/\//i.test(probe) ? probe : `${target.origin}${trimSlash(target.pathname)}${probe}`
  const kind = hostKind(target.hostname)
  const secure = !!pg.secure
  const lnaApplies = secure && kind !== 'public' && hostKind(pg.host) === 'public'
  const mixedContent = secure && target.protocol === 'http:' && kind !== 'loopback'

  let permission = null
  if (lnaApplies && perms?.query) {
    const names = [kind === 'loopback' ? 'loopback-network' : 'local-network', 'local-network-access']
    for (const name of names) {
      try {
        const st = await perms.query({ name })
        if (st?.state) {
          permission = st.state
          break
        }
      } catch {
        /* this browser has no such permission; try the older name */
      }
    }
  }

  const timeout = () => {
    try {
      return AbortSignal.timeout(timeoutMs)
    } catch {
      return undefined
    }
  }
  let reachable = false
  try {
    await f(probeUrl, fetchInit(probeUrl, { mode: 'no-cors', cache: 'no-store', signal: timeout() }))
    reachable = true
  } catch {
    reachable = false
  }
  let allows = null
  if (reachable) {
    try {
      await f(probeUrl, fetchInit(probeUrl, { mode: 'cors', cache: 'no-store', signal: timeout() }))
      allows = true
    } catch {
      allows = false
    }
  }
  const refused = reachable && allows === false
  const outcome = refused ? 'refused' : reachable ? 'ok' : lnaApplies && permission === 'denied' ? 'permission' : mixedContent ? 'mixed' : 'down'
  return { reachable, refused, allows, permission, mixedContent, secure, origin: pg.origin, target: target.origin, kind, lnaApplies, outcome }
}

/**
 * The steps that let a server answer this page, per server.
 *
 * Each section is `{ os?, steps: [{ text, command? }] }`. Sections with an
 * `os` are ordered so the one for this computer comes first; the UI shows that
 * one and folds the rest. Every command is exact, ready to paste.
 */
function voiceboxRemedy(origin, platform) {
  const pair = `VOICEBOX_CORS_ORIGINS=${origin}`
  const by = {
    mac: {
      os: 'macOS',
      steps: [
        { text: 'Quit Voicebox, then start it from Terminal with this page allowed:', command: `open -a Voicebox --env ${pair}` },
        { text: 'To keep that until you log out, set it once and relaunch Voicebox from the Dock:', command: `launchctl setenv VOICEBOX_CORS_ORIGINS ${origin}` },
      ],
    },
    windows: {
      os: 'Windows',
      steps: [{ text: 'In a command prompt, then quit Voicebox from the tray and start it again:', command: `setx VOICEBOX_CORS_ORIGINS ${origin}` }],
    },
    linux: {
      os: 'Linux / Docker',
      steps: [
        { text: 'Export it in the shell that starts the server:', command: `export ${pair}` },
        { text: 'Or in docker-compose, under the voicebox service:', command: `environment:\n  - ${pair}` },
      ],
    },
  }
  const order = [...new Set([platform, 'mac', 'windows', 'linux'])].filter((k) => by[k])
  return [
    ...order.map((k) => by[k]),
    {
      steps: [
        { text: 'Several pages: separate them with commas. Serving Klipvia on port 5173 (PORT=5173 bun run dev, or the static build there) needs no change to VoiceBox.' },
      ],
    },
  ]
}

function serverRemedy(origin) {
  return [
    {
      steps: [
        { text: 'Tell the server to allow this page. Which setting depends on what you run:' },
        { text: 'Speaches:', command: `ALLOW_ORIGINS='["${origin}"]'` },
        { text: 'LocalAI:', command: `LOCALAI_CORS=true LOCALAI_CORS_ALLOW_ORIGINS=${origin}` },
        { text: 'Kokoro-FastAPI (port 8880) allows every page unless CORS_ORIGINS was changed:', command: `CORS_ORIGINS='["${origin}"]'` },
        { text: 'whisper.cpp already allows every page.' },
      ],
    },
  ]
}

function permissionRemedy(d) {
  const loop = d.kind === 'loopback'
  return [
    {
      steps: [
        {
          text: `Click the site-information icon left of the address bar, set ${loop ? '“Apps on device”' : '“Local network”'} (older Chrome: “Local network access”) to Allow, then reload.`,
        },
        { text: 'Or open the setting directly and allow this site:', command: loop ? 'chrome://settings/content/loopbackNetwork' : 'chrome://settings/content/localNetwork' },
        { text: 'Chrome only asks this on an https page. An http page is refused without asking.' },
      ],
    },
  ]
}

function downRemedy(providerId, d) {
  const steps = []
  if (providerId === 'voicebox') steps.push({ text: 'Start VoiceBox. It listens on 127.0.0.1:17493 unless you changed the port, and the address here has to match it.' })
  else steps.push({ text: 'Start the server and check the port: Kokoro-FastAPI uses 8880, Speaches and LocalAI 8000, whisper.cpp 8080.' })
  if (d?.lnaApplies && d.permission === 'prompt') steps.push({ text: 'Chrome may be waiting for an answer to its local-network prompt; look in the address bar and allow it.' })
  if (d?.secure && isSafari()) steps.push({ text: 'Safari will not connect an https page to any http address, this machine included. Open Klipvia over http://localhost instead.' })
  return [{ steps }]
}

/**
 * One precise sentence per outcome, and the steps that fix it.
 * `providerId` picks the remedy; `label` is the provider's name for the text.
 */
export function explainReach(d, { providerId = null, label = 'that server', platform = platformOf() } = {}) {
  const target = d?.target ?? 'that address'
  const origin = d?.origin ?? 'this page'
  switch (d?.outcome) {
    case 'refused':
      return {
        message: `${label} is running at ${target} but does not allow pages from ${origin}.`,
        remedy: providerId === 'voicebox' ? voiceboxRemedy(origin, platform) : providerId === 'openai-compatible' ? serverRemedy(origin) : [{ steps: [{ text: `Tell it to allow the origin ${origin}.` }] }],
      }
    case 'permission':
      return { message: `Chrome is blocking this page from reaching ${target}: local network access is refused for ${origin}.`, remedy: permissionRemedy(d) }
    case 'mixed':
      return {
        message: `${target} is http and this page is https, and this browser will not connect the two.`,
        remedy: [{ steps: [{ text: 'Open Klipvia at an http:// address (http://localhost:5173 works with VoiceBox unchanged), or give the server an https address.' }] }],
      }
    case 'ok':
      return {
        message: `${target} answers this page, but this call failed. ${providerId === 'openai-compatible' ? 'Check that the address ends in /v1 and that the server has that route.' : 'Check the address and try again.'}`,
        remedy: [],
      }
    case 'address':
      return { message: `${target} is not an address a browser can reach.`, remedy: [] }
    default:
      return {
        message: `Nothing answered at ${target}. ${label} is not running there, or it is on another port.`,
        remedy: downRemedy(providerId, d),
      }
  }
}

/* -------------------------------------------------------------------- call */

/**
 * One request, wherever it goes, with one honest failure.
 *
 * `opts` carries what a diagnosis needs when the request never gets an answer:
 * `{ id, base, probe, label }` for a machine provider, `{ hint }` for a hosted
 * one. A hosted API that cannot be reached is a connection problem, not a
 * configuration one, so it gets a sentence rather than a probe.
 */
async function call(url, init, provider, opts = {}) {
  const relayed = relayDecision(url)
  let res
  try {
    res = await fetch(relayed ? viaRelay(url) : url, relayed ? init : fetchInit(url, init))
  } catch (err) {
    if (err?.name === 'AbortError' || init?.signal?.aborted) throw err
    throw await unreachable(url, { ...opts, relayed, provider })
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let detail = body.slice(0, 300)
    try {
      const j = JSON.parse(body)
      // Every provider nests its message somewhere different, and one of them
      // nests an object — reading it straight put "[object Object]" in front
      // of the person instead of "invalid api key".
      const pick = (v) =>
        typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.message ?? v.detail ?? v.error ?? v.reason ?? v.err_msg) : null
      detail = pick(j?.error) ?? pick(j?.detail) ?? pick(j?.message) ?? pick(j) ?? detail
    } catch {
      /* not json; the text will do */
    }
    // HTTP/2 carries no status text, so it is only shown when there is one.
    throw new SpeechError(`${provider}: ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${detail ? ` — ${detail}` : ''}`, { provider, status: res.status })
  }
  return res
}

async function unreachable(url, { relayed, id = null, base = null, probe = '/', label = null, hint = null, provider }) {
  let origin = String(url)
  try {
    origin = new URL(url, pageInfo().href).origin
  } catch {
    /* keep the text */
  }
  if (relayed) {
    return new SpeechError(`could not reach ${origin}: Klipvia's server got no answer from it, so it is probably not running.`, { provider })
  }
  let kind = 'public'
  try {
    kind = hostKind(new URL(url, pageInfo().href).hostname)
  } catch {
    /* public */
  }
  if (kind === 'public' && !base) {
    return new SpeechError(`could not reach ${origin}. ${hint ?? 'Check the connection; a browser extension that blocks requests can also do this.'}`, { provider })
  }
  const diagnosis = await diagnoseReach(base ?? origin, { probe }).catch(() => null)
  const { message, remedy } = explainReach(diagnosis, { providerId: id, label: label ?? provider })
  return new SpeechError(message, { provider, diagnosis, remedy })
}

/* ---------------------------------------------------------------- addresses */

/**
 * A base URL as somebody would actually type it, turned into one we can use.
 *
 * People paste `localhost:8000`, `http://localhost:8000/v1`, and
 * `http://localhost:8000/v1/` interchangeably, and all three mean the same
 * server. The `/v1` is added when it is missing rather than demanded.
 */
export function normaliseBase(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return ''
  }
  // Rebuilt from the parts rather than patched as a string. Appending "/v1" to
  // whatever was typed put it after the query when there was one, and the
  // request went to the wrong path with the rest of the URL as a parameter —
  // a 404 that reads like the server is missing a route it actually has.
  // A base is an origin and a path; a query or a fragment on it is a paste
  // accident and is dropped.
  const path = trimSlash(url.pathname)
  return `${url.origin}${/\/v\d+$/.test(path) ? path : `${path}/v1`}`
}

/** VoiceBox is addressed at its origin; it has no `/v1` under it. */
export function plainBase(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`)
    return `${url.origin}${trimSlash(url.pathname)}`
  } catch {
    return ''
  }
}

/* -------------------------------------------------------------- timestamps */

/**
 * Seconds, milliseconds and nanoseconds all arrive as bare numbers.
 *
 * `subtitles.js` guesses the unit per value, which is right for one file and
 * wrong for one transcript: a provider answering in milliseconds gives values
 * both under and over the threshold, so half the cues get scaled and half do
 * not, and the result is a timeline that looks plausible and is nonsense.
 * Deciding the unit once for the whole document, from its largest value against
 * the length of the audio, is the only way to get it right every time.
 */
export function normaliseUnits(doc, durationMs) {
  // With no idea how long the audio is there is nothing to compare against,
  // and a guess here rewrites every timestamp in the document. Seconds is what
  // the format says; leave it alone.
  if (!durationMs) return doc

  const nums = []
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'start' || k === 'end') && Number.isFinite(Number(v))) nums.push(Number(v))
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(doc)
  if (!nums.length) return doc

  const max = Math.max(...nums)
  const seconds = durationMs / 1000
  // A band, not a ceiling. With only an upper bound, a document whose timings
  // simply overshoot the audio had "seconds" rejected and then accepted
  // milliseconds — six seconds became six thousandths, and the whole transcript
  // collapsed into the first instant. Both ends matter: a reading far shorter
  // than the audio is as impossible as one far longer.
  const plausible = (v) => v >= seconds * 0.2 && v <= seconds * 1.5 + 2

  // Seconds unless seconds is impossible, and then only if another unit is
  // actually plausible. When nothing fits, the timings are simply wrong and
  // rescaling them makes them wrong in a new and less obvious way.
  if (plausible(max)) return doc
  const div = plausible(max / 1e3) ? 1e3 : plausible(max / 1e9) ? 1e9 : 0
  if (!div) return doc

  const scale = (o) => {
    if (!o || typeof o !== 'object') return o
    if (Array.isArray(o)) return o.map(scale)
    const out = {}
    for (const [k, v] of Object.entries(o)) {
      out[k] = (k === 'start' || k === 'end') && Number.isFinite(Number(v)) ? Number(v) / div : scale(v)
    }
    return out
  }
  return scale(doc)
}

/* -------------------------------------------------------------------- text */

/**
 * A script cut into pieces a provider will take, at sentence ends.
 *
 * Deepgram stops at 2000 characters, ElevenLabs v3 at 5000. Cutting at a
 * sentence end keeps the prosody of each piece whole; a sentence longer than
 * the limit is cut at its last space instead. The pieces come back as one
 * audio file — MP3 frames concatenate cleanly.
 */
export function chunkText(text, max = 1900) {
  const s = String(text ?? '').trim()
  if (!s) return []
  if (s.length <= max) return [s]
  const sentences = s.split(/(?<=[.!?…]["'”’)\]]?)\s+|\n+/).map((t) => t.trim()).filter(Boolean)
  const out = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush()
      let rest = sentence
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max)
        if (cut < max / 2) cut = max
        out.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      cur = rest
      continue
    }
    if (cur && cur.length + 1 + sentence.length > max) flush()
    cur = cur ? `${cur} ${sentence}` : sentence
  }
  flush()
  return out
}

const joinAudio = (parts) => (parts.length === 1 ? parts[0] : new Blob(parts, { type: parts[0]?.type || 'audio/mpeg' }))

/* ------------------------------------------------------------------ voices */

const cap = (s) => String(s ?? '').replace(/^\w/, (c) => c.toUpperCase())

/** `{ id, name, lang }` whatever a provider entry looks like. */
export const asVoice = (v) => (typeof v === 'string' ? { id: v, name: v, lang: '*' } : { lang: '*', ...v })

/**
 * The voice that will actually be used, given a choice of voice and language.
 *
 * Where each voice speaks one language (Deepgram, VoiceBox, Kokoro), a chosen
 * language wins: a voice that does not match it is swapped for the provider's
 * default in that language, or the first one. Where voices are multilingual
 * (ElevenLabs, OpenAI) the voice is kept and the language is sent alongside.
 */
export function resolveVoice(provider, { voice = null, language = null, list = [] } = {}) {
  const voices = (list?.length ? list : provider?.voices ?? []).map(asVoice)
  const lang = language && language !== 'auto' ? baseLang(language) : null
  const speaks = (v, l) => baseLang(v.lang) === l || (v.langs ?? []).some((x) => baseLang(x) === l)
  if (!lang || !provider?.oneLanguageVoices || !voices.length) return voice || null
  const current = voices.find((v) => v.id === voice)
  if (current && speaks(current, lang)) return voice
  const preferred = provider.defaultVoices?.[lang]
  if (preferred && voices.some((v) => v.id === preferred)) return preferred
  return voices.find((v) => speaks(v, lang))?.id ?? voice ?? null
}

/* ------------------------------------------------- transcription providers */

/** POST a file to anything that speaks OpenAI's `/v1/audio/transcriptions`. */
async function openAiTranscribe({ base, key, model, language, blob, filename, signal, provider, authHeader, reach }) {
  // An address that will not parse comes back empty, and an empty base makes
  // the request relative — it would go to Klipvia's own origin and fail with
  // something that says nothing about the address being wrong.
  if (!base) throw new SpeechError(`${provider}: that address is not one a browser can reach`, { provider })
  const form = new FormData()
  form.append('file', blob, filename || 'audio.wav')
  if (model) form.append('model', model)
  form.append('response_format', 'verbose_json')
  // Word timings are what the caption system's karaoke highlighting runs on,
  // and they cost nothing to ask for. A server that does not understand the
  // field ignores it.
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  if (language) form.append('language', baseLang(language))

  const headers = {}
  if (key) Object.assign(headers, authHeader ? authHeader(key) : { authorization: `Bearer ${key}` })

  const res = await call(`${base}/audio/transcriptions`, { method: 'POST', body: form, headers, signal }, provider, reach ?? {})
  return res.json()
}

const serverReach = (base, label) => ({ id: 'openai-compatible', base, probe: '/models', label })
const voiceboxReach = (base) => ({ id: 'voicebox', base, probe: '/health', label: 'VoiceBox' })

/**
 * VoiceBox — a voice-cloning server somebody runs themselves.
 *
 * Its own shape rather than OpenAI's, and three things about it decide this
 * code. Generation is asynchronous: `/generate` answers at once with an id and
 * `status: "generating"`, and the audio only exists later. Its status endpoint
 * is Server-Sent Events, not JSON, so `/history/{id}` — the same record as
 * plain JSON — is what gets polled. And the engine is not free to choose: a
 * preset profile refuses any engine but its own, so it is read off the profile
 * rather than guessed, which is a 400 the first time otherwise.
 */
const VOICEBOX_POLL_MS = 700
const VOICEBOX_LIMIT_MS = 10 * 60 * 1000
/** What VoiceBox's `language` field accepts; anything else is refused with a 422. */
const VOICEBOX_LANGS = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it', 'he', 'ar', 'da', 'el', 'fi', 'hi', 'ms', 'nl', 'no', 'pl', 'sv', 'sw', 'tr']
const voiceboxLang = (code) => {
  const l = baseLang(code || '')
  return VOICEBOX_LANGS.includes(l) ? l : null
}

async function voiceboxProfile(base, id, signal) {
  const res = await call(`${base}/profiles/${encodeURIComponent(id)}`, { signal }, 'VoiceBox', voiceboxReach(base))
  return res.json()
}

async function voiceboxSpeak({ base: raw, voice, text, language, signal, onProgress }) {
  const base = plainBase(raw)
  if (!base) throw new SpeechError('VoiceBox: that address is not one a browser can reach', { provider: 'VoiceBox' })

  let profileId = voice
  if (!profileId) {
    const list = await voiceboxVoices({ base: raw, signal })
    const lang = voiceboxLang(language)
    profileId = (lang && list.find((v) => baseLang(v.lang) === lang))?.id ?? list[0]?.id
    if (!profileId) throw new SpeechError('VoiceBox has no voice profiles yet. Add one with “Add a voice…” or in VoiceBox itself.', { provider: 'VoiceBox' })
  }

  // A preset profile only answers to the engine it was made with.
  const profile = await voiceboxProfile(base, profileId, signal).catch(() => null)
  const engine = profile?.preset_engine || profile?.default_engine || undefined
  // Never the server's silent default of English: the chosen language, else
  // the language the profile was saved with.
  const lang = voiceboxLang(language) ?? voiceboxLang(profile?.language)

  onProgress?.({ label: 'asking VoiceBox…' })
  const started = await call(
    `${base}/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        profile_id: profileId,
        text,
        ...(lang ? { language: lang } : {}),
        ...(engine ? { engine } : {}),
      }),
    },
    'VoiceBox',
    voiceboxReach(base),
  )
  const job = await started.json()
  if (!job?.id) throw new SpeechError('VoiceBox did not start a generation', { provider: 'VoiceBox' })

  const deadline = Date.now() + VOICEBOX_LIMIT_MS
  let state = job
  while (state.status !== 'completed') {
    if (signal?.aborted) {
      // It is generating on somebody's GPU; tell it to stop rather than
      // walking away and leaving the work running.
      call(`${base}/generate/${job.id}/cancel`, { method: 'POST' }, 'VoiceBox').catch(() => {})
      throw new DOMException('cancelled', 'AbortError')
    }
    // Anything that is not "still going" and not "done" is over: failed,
    // cancelled, or a state this code has never seen. Waiting on those is
    // waiting forever.
    if (state.error || !['generating', 'pending', 'queued', 'processing', 'running'].includes(state.status)) {
      throw new SpeechError(`VoiceBox could not say that: ${state.error ?? `generation ${state.status ?? 'failed'}`}`, { provider: 'VoiceBox' })
    }
    if (Date.now() > deadline) throw new SpeechError('VoiceBox is still going after ten minutes; giving up', { provider: 'VoiceBox' })
    await new Promise((r) => setTimeout(r, VOICEBOX_POLL_MS))
    onProgress?.({ label: `VoiceBox is speaking… (${state.status})` })
    const poll = await call(`${base}/history/${job.id}`, { signal }, 'VoiceBox', voiceboxReach(base))
    state = await poll.json()
  }

  onProgress?.({ label: 'fetching the audio…' })
  const audio = await call(`${base}/audio/${job.id}`, { signal }, 'VoiceBox', voiceboxReach(base))
  return audio.blob()
}

async function voiceboxVoices({ base: raw, signal }) {
  const base = plainBase(raw)
  if (!base) return []
  const res = await call(`${base}/profiles`, { signal }, 'VoiceBox', voiceboxReach(base))
  const body = await res.json()
  const rows = Array.isArray(body) ? body : (body.items ?? [])
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    lang: normaliseLang(p.language) || 'en',
    note: [p.voice_type === 'cloned' ? 'cloned' : p.voice_type === 'designed' ? 'designed' : p.preset_engine, p.preset_voice_id].filter(Boolean).join(' · '),
    type: p.voice_type,
  }))
}

/** The engines VoiceBox ships ready-made voices for; the others clone or design. */
const VOICEBOX_PRESET_ENGINES = ['kokoro', 'qwen_custom_voice']

/**
 * VoiceBox's built-in voices, before any of them is a profile.
 * Each is `{ id, name, lang, gender, engine }`, and `addPresetVoice` turns one
 * into a profile that then appears in `listVoices`.
 */
export async function listPresets({ base: raw, signal } = {}) {
  const base = plainBase(raw)
  if (!base) throw new SpeechError('VoiceBox: that address is not one a browser can reach', { provider: 'VoiceBox' })
  const out = []
  let failure = null
  for (const engine of VOICEBOX_PRESET_ENGINES) {
    try {
      const res = await call(`${base}/profiles/presets/${engine}`, { signal }, 'VoiceBox', voiceboxReach(base))
      const j = await res.json()
      for (const v of j.voices ?? []) {
        out.push({
          id: v.voice_id,
          name: v.name,
          lang: normaliseLang(v.language) || 'en',
          gender: /^f/i.test(v.gender ?? '') ? 'f' : /^m/i.test(v.gender ?? '') ? 'm' : undefined,
          engine,
          note: engine === 'kokoro' ? 'Kokoro' : 'Qwen',
        })
      }
    } catch (err) {
      failure ??= err
    }
  }
  if (!out.length && failure) throw failure
  return out
}

/** Save one of VoiceBox's built-in voices as a profile it can speak with. */
export async function addPresetVoice({ base: raw, engine, voiceId, name, language, signal } = {}) {
  const base = plainBase(raw)
  if (!base) throw new SpeechError('VoiceBox: that address is not one a browser can reach', { provider: 'VoiceBox' })
  if (!engine || !voiceId) throw new SpeechError('VoiceBox: a preset needs an engine and a voice id', { provider: 'VoiceBox' })
  const res = await call(
    `${base}/profiles`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        name: name || voiceId,
        language: voiceboxLang(language) ?? 'en',
        voice_type: 'preset',
        preset_engine: engine,
        preset_voice_id: voiceId,
        default_engine: engine,
      }),
    },
    'VoiceBox',
    voiceboxReach(base),
  )
  const p = await res.json()
  return { id: p.id, name: p.name, lang: normaliseLang(p.language) || 'en', note: [engine, voiceId].join(' · '), type: 'preset' }
}

/**
 * Clone a voice from a recording: a profile, then one sample with the words it
 * says. `referenceText` is required by VoiceBox — it is what the model aligns
 * the sample against — so it is required here rather than sent empty.
 */
export async function cloneVoice({ base: raw, name, language, blob, referenceText, description = '', filename = 'sample.wav', signal } = {}) {
  const base = plainBase(raw)
  if (!base) throw new SpeechError('VoiceBox: that address is not one a browser can reach', { provider: 'VoiceBox' })
  if (!name) throw new SpeechError('VoiceBox: a cloned voice needs a name', { provider: 'VoiceBox' })
  if (!blob?.size) throw new SpeechError('VoiceBox: a cloned voice needs a recording', { provider: 'VoiceBox' })
  if (!String(referenceText ?? '').trim()) throw new SpeechError('VoiceBox: write down what is said in the recording first', { provider: 'VoiceBox' })
  const made = await call(
    `${base}/profiles`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ name, description, language: voiceboxLang(language) ?? 'en', voice_type: 'cloned' }),
    },
    'VoiceBox',
    voiceboxReach(base),
  )
  const profile = await made.json()
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('reference_text', String(referenceText).trim())
  await call(`${base}/profiles/${encodeURIComponent(profile.id)}/samples`, { method: 'POST', body: form, signal }, 'VoiceBox', voiceboxReach(base))
  return { id: profile.id, name: profile.name, lang: normaliseLang(profile.language) || 'en', note: 'cloned', type: 'cloned' }
}

/**
 * VoiceBox transcribes too, but gives back only the words and a length.
 *
 * With no timings there is nothing to hang a caption on, so the text is split
 * into sentences and spread across the length in proportion to how long each
 * one is. That is an estimate and is described as one wherever it is offered:
 * good enough to read and to edit, and not something to trust frame by frame.
 */
async function voiceboxTranscribe({ base: raw, blob, filename, language, signal }) {
  const base = plainBase(raw)
  if (!base) throw new SpeechError('VoiceBox: that address is not one a browser can reach', { provider: 'VoiceBox' })
  const form = new FormData()
  form.append('file', blob, filename || 'audio.wav')
  const lang = voiceboxLang(language)
  if (lang) form.append('language', lang)
  const res = await call(`${base}/transcribe`, { method: 'POST', body: form, signal }, 'VoiceBox', voiceboxReach(base))
  // 202: it is fetching its Whisper model for the first time. Not an answer.
  if (res.status === 202) throw new SpeechError('VoiceBox is downloading its Whisper model; try again in a minute.', { provider: 'VoiceBox', status: 202 })
  const { text = '', duration = 0 } = await res.json()

  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter(Boolean)
  if (!sentences.length) return { text, duration }
  const total = sentences.reduce((n, t) => n + t.length, 0) || 1
  let at = 0
  const segments = sentences.map((t, i) => {
    const span = (t.length / total) * duration
    const seg = { id: i, start: at, end: at + span, text: t }
    at += span
    return seg
  })
  return { text, duration, segments, estimatedTimings: true }
}

/** Said once, on both VoiceBox rows. */
const VOICEBOX_NOTE =
  'VoiceBox answers the pages it has been told about. Served on port 5173, Klipvia is one of them; from any other address, ' +
  'set VOICEBOX_CORS_ORIGINS where VoiceBox launches. “Test it” shows the exact command.'

const ANY = ['*']

export const STT_PROVIDERS = [
  {
    id: 'openai-compatible',
    label: 'A Whisper server you run',
    where: 'machine',
    browserDirect: true,
    needs: ['base'],
    baseHint: 'http://localhost:8000/v1',
    modelHint: 'Systran/faster-whisper-small',
    languages: ANY,
    langChips: 'Whisper: 99 languages',
    blurb: 'whisper.cpp, Speaches, LocalAI, LM Studio or anything else with OpenAI’s API. The sound goes to that machine and no further.',
    setupNote:
      'The server has to allow this page: Speaches ALLOW_ORIGINS, LocalAI LOCALAI_CORS=true. ' +
      'whisper.cpp allows every page but serves /inference, so start it with --inference-path /v1/audio/transcriptions.',
    transcribe: (o) => {
      const base = normaliseBase(o.base)
      return openAiTranscribe({ ...o, base, provider: 'your Whisper server', reach: serverReach(base, 'your Whisper server') })
    },
  },
  {
    id: 'voicebox',
    label: 'VoiceBox',
    where: 'machine',
    browserDirect: true,
    needs: ['base'],
    baseHint: 'http://127.0.0.1:17493',
    languages: ANY,
    langChips: 'Whisper: 99 languages',
    blurb: 'The Whisper inside VoiceBox. It returns the words and the length but no per-word times, so the lines are spread evenly: fine to read and edit, not frame-exact.',
    setupNote: VOICEBOX_NOTE,
    transcribe: voiceboxTranscribe,
  },
  {
    id: 'groq',
    label: 'Groq',
    where: 'provider',
    browserDirect: true,
    needs: ['key'],
    keyHint: 'gsk_… from console.groq.com/keys',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    languages: ANY,
    langChips: 'Whisper: 99 languages',
    blurb: 'Whisper large, very fast and very cheap. Allows browser requests, which most hosted APIs do not.',
    transcribe: (o) =>
      openAiTranscribe({ ...o, base: 'https://api.groq.com/openai/v1', model: o.model || 'whisper-large-v3-turbo', provider: 'Groq' }),
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs Scribe',
    where: 'provider',
    browserDirect: true,
    needs: ['key'],
    keyHint: 'from elevenlabs.io → profile → API key',
    languages: ANY,
    langChips: '99 languages',
    blurb: 'Accurate, and returns per-word timings.',
    async transcribe({ key, blob, filename, language, signal }) {
      const form = new FormData()
      form.append('file', blob, filename || 'audio.wav')
      form.append('model_id', 'scribe_v2')
      if (language) form.append('language_code', baseLang(language))
      const res = await call(
        'https://api.elevenlabs.io/v1/speech-to-text',
        { method: 'POST', body: form, headers: { 'xi-api-key': key }, signal },
        'ElevenLabs',
      )
      const j = await res.json()
      // Scribe interleaves spacing entries with the words; only words are words.
      const words = (j.words ?? []).filter((w) => w.type === 'word' || !w.type)
      return { text: j.text ?? words.map((w) => w.text).join(' '), words: words.map((w) => ({ word: w.text, start: w.start, end: w.end })) }
    },
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    where: 'provider',
    browserDirect: true,
    needs: ['key'],
    keyHint: 'from console.deepgram.com',
    languages: ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'hi', 'ru'],
    langChips: 'EN · ES · FR · DE · PT · IT · NL · JA · HI · RU',
    blurb: 'Fast, with good punctuation and speaker labels.',
    async transcribe({ key, blob, language, signal }) {
      const lang = language ? `&language=${encodeURIComponent(baseLang(language))}` : '&detect_language=true'
      const res = await call(
        `https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true${lang}`,
        { method: 'POST', body: blob, headers: { authorization: `Token ${key}`, 'content-type': blob.type || 'audio/wav' }, signal },
        'Deepgram',
      )
      const j = await res.json()
      const alt = j?.results?.channels?.[0]?.alternatives?.[0] ?? {}
      const utterances = j?.results?.utterances ?? []
      return {
        text: alt.transcript ?? '',
        // Utterances break lines where a person pauses, which is where a
        // caption should break too.
        segments: utterances.map((u, i) => ({ id: i, start: u.start, end: u.end, text: u.transcript })),
        words: (alt.words ?? []).map((w) => ({ word: w.punctuated_word ?? w.word, start: w.start, end: w.end })),
      }
    },
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    where: 'provider',
    browserDirect: true,
    needs: ['key'],
    keyHint: 'from assemblyai.com dashboard',
    languages: ANY,
    langChips: '99 languages',
    blurb: 'Upload, then poll. Slower to start, strong on long recordings.',
    async transcribe({ key, blob, language, signal, onProgress }) {
      const headers = { authorization: key }
      onProgress?.({ label: 'uploading…' })
      const up = await call('https://api.assemblyai.com/v2/upload', { method: 'POST', body: blob, headers, signal }, 'AssemblyAI')
      const { upload_url } = await up.json()

      const started = await call(
        'https://api.assemblyai.com/v2/transcript',
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ audio_url: upload_url, ...(language ? { language_code: baseLang(language) } : { language_detection: true }) }),
          signal,
        },
        'AssemblyAI',
      )
      const { id } = await started.json()

      for (let i = 0; i < 600; i++) {
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
        const poll = await call(`https://api.assemblyai.com/v2/transcript/${id}`, { headers, signal }, 'AssemblyAI')
        const j = await poll.json()
        if (j.status === 'completed') {
          // AssemblyAI answers in milliseconds; everything downstream assumes
          // seconds unless told otherwise. normaliseUnits settles it.
          return { text: j.text ?? '', words: (j.words ?? []).map((w) => ({ word: w.text, start: w.start, end: w.end })) }
        }
        if (j.status === 'error') throw new SpeechError(`AssemblyAI: ${j.error}`, { provider: 'AssemblyAI' })
        onProgress?.({ label: `transcribing… (${j.status})` })
        await new Promise((r) => setTimeout(r, 2000))
      }
      throw new SpeechError('AssemblyAI did not finish in ten minutes', { provider: 'AssemblyAI' })
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    where: 'provider',
    // Callable from a page since 2025 (it answers CORS preflights), with one
    // catch: a wrong key gets a 401 that carries no CORS header, so it looks
    // like the API vanished. The hint says so.
    browserDirect: true,
    needs: ['key'],
    keyHint: 'sk-… from platform.openai.com',
    models: ['gpt-4o-transcribe', 'whisper-1'],
    languages: ANY,
    langChips: '99 languages',
    blurb: 'Whisper and gpt-4o-transcribe, from OpenAI directly.',
    setupNote: 'Works from a page. If it fails with “could not reach api.openai.com”, the key is wrong or OpenAI has turned browser requests off again; through the Klipvia server it always works.',
    unreachableHint: 'With OpenAI this usually means the key is wrong: a bad key gets an answer no browser may read. Through the Klipvia server it always works.',
    transcribe: (o) =>
      openAiTranscribe({ ...o, base: 'https://api.openai.com/v1', model: o.model || 'whisper-1', provider: 'OpenAI', reach: { hint: STT_OPENAI_HINT } }),
  },
]
const STT_OPENAI_HINT = STT_PROVIDERS.at(-1).unreachableHint

/* --------------------------------------------------------- voice providers */

/** Anything that speaks OpenAI's `/v1/audio/speech`, which is nearly everything. */
async function openAiSpeak({ base, key, model, voice, text, format = 'mp3', signal, provider, authHeader, extra = {}, reach }) {
  if (!base) throw new SpeechError(`${provider}: that address is not one a browser can reach`, { provider })
  const headers = { 'content-type': 'application/json' }
  if (key) Object.assign(headers, authHeader ? authHeader(key) : { authorization: `Bearer ${key}` })
  const res = await call(
    `${base}/audio/speech`,
    { method: 'POST', headers, signal, body: JSON.stringify({ model, input: text, voice, response_format: format, ...extra }) },
    provider,
    reach ?? {},
  )
  return res.blob()
}

/** OpenAI's own voice names, which most OpenAI-shaped servers also answer to. */
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map((id) => ({ id, name: cap(id), lang: '*' }))
const SIX_VOICES = OPENAI_VOICES.filter((v) => ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(v.id)).map((v) => ({ ...v, note: 'standard name' }))

/**
 * Kokoro names its voices by language and gender: `ef_dora` is a Spanish
 * (e) female (f) voice. The letter is also what its `lang_code` field takes.
 */
const KOKORO_LANG = { a: 'en-US', b: 'en-GB', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-BR', z: 'zh' }
const KOKORO_CODE = { en: 'a', es: 'e', fr: 'f', hi: 'h', it: 'i', ja: 'j', pt: 'p', zh: 'z' }
const kokoroVoice = (id) => {
  const m = /^([abefhijpz])([fm])_(.+)$/.exec(id)
  if (!m) return null
  return { id, name: cap(m[3].replace(/_/g, ' ')), lang: KOKORO_LANG[m[1]], gender: m[2], note: id, src: 'voices' }
}

async function serverVoices({ base: raw, key, signal }) {
  const base = normaliseBase(raw)
  if (!base) return []
  const headers = key ? { authorization: `Bearer ${key}` } : {}
  const reach = serverReach(base, 'your voice server')
  let listed = null
  try {
    const res = await call(`${base}/audio/voices`, { headers, signal }, 'your voice server', reach)
    const j = await res.json()
    const rows = Array.isArray(j) ? j : (j.voices ?? j.data ?? [])
    listed = rows.map((v) => {
      const id = typeof v === 'string' ? v : (v.id ?? v.name ?? v.voice_id)
      const known = kokoroVoice(String(id))
      if (known) return known
      const o = typeof v === 'object' && v ? v : {}
      return { id, name: o.name ?? o.display_name ?? id, lang: normaliseLang(o.lang ?? o.language ?? '') || '*', gender: o.gender?.[0]?.toLowerCase(), src: 'voices' }
    })
  } catch (err) {
    // A 404 means "no such route", which is what most servers say; anything
    // else — unreachable, refused — is the real answer and is passed on.
    if (!(err instanceof SpeechError) || err.status !== 404) throw err
  }
  if (listed?.length) return listed
  // The server answered but does not list voices; the standard six names
  // are what the OpenAI-shaped servers map their own voices to.
  await call(`${base}/models`, { headers, signal }, 'your voice server', reach)
  return SIX_VOICES.map((v) => ({ ...v, src: 'models' }))
}

/* ---- Deepgram: the catalogue, because a browser may not ask for it ---- */

/**
 * Every Aura-2 voice, by language: `name gender [REGION] note`.
 *
 * Deepgram's `/v1/models` lists these but refuses cross-origin pages, so the
 * browser build cannot ask. The list is what the live endpoint returned on
 * 2026-09-02 (90 voices; 41 en, 17 es, 7 de, 2 fr, 9 nl, 9 it, 5 ja) and is
 * refreshed from the endpoint through the server relay where there is one.
 */
const AURA2 = {
  en:
    'thalia f US clear, confident, energetic|andromeda f US casual, expressive|helena f US caring, natural, raspy|apollo m US confident, casual|' +
    'arcas m US natural, smooth|aries m US warm, energetic|amalthea f PH engaging, cheerful|asteria f US clear, knowledgeable|' +
    'athena f US calm, professional|atlas m US enthusiastic, friendly|aurora f US cheerful, expressive|callista f US clear, professional|' +
    'cora f US smooth, melodic|cordelia f US warm, polite|delia f US casual, breathy|electra f US professional, engaging|' +
    'harmonia f US empathetic, calm|hera f US smooth, warm|hermes m US expressive, professional|iris f US cheerful, approachable|' +
    'janus f US smooth, trustworthy, Southern|juno f US natural, melodic|jupiter m US expressive, baritone|luna f US friendly, natural|' +
    'mars m US smooth, patient, baritone|minerva f US positive, friendly|neptune m US professional, patient|odysseus m US calm, professional|' +
    'ophelia f US expressive, cheerful|orion m US approachable, calm|orpheus m US professional, trustworthy|phoebe f US energetic, warm|' +
    'pluto m US smooth, empathetic, baritone|saturn m US knowledgeable, baritone|selene f US expressive, energetic|vesta f US natural, patient|' +
    'zeus m US deep, trustworthy|draco m GB warm, baritone|pandora f GB smooth, calm, breathy|hyperion m AU caring, warm|theia f AU expressive, polite',
  es:
    'sirio m MX calm, professional, baritone|estrella f MX approachable, natural|javier m MX approachable, friendly|luciano m MX charismatic, energetic|' +
    'olivia f MX breathy, calm, warm|valerio m MX deep, professional|nestor m ES calm, professional|carina f ES professional, raspy|' +
    'alvaro m ES calm, clear|diana f ES professional, expressive|agustina f ES calm, clear|silvia f ES charismatic, warm|' +
    'celeste f CO clear, energetic, friendly|gloria f CO casual, smooth|aquila m 419 expressive, confident|selena f 419 approachable, calm|' +
    'antonia f AR approachable, friendly',
  de: 'elara f calm, clear|aurelia f casual, natural|lara f caring, warm|julius m cheerful, friendly|fabian m confident, professional|kara f caring, professional|viktoria f charismatic, warm',
  fr: 'agathe f charismatic, friendly|hector m confident, patient',
  nl: 'beatrix f|daphne f|cornelia f|sander m|hestia f|lars m|roman m|rhea f|leda f',
  it: 'melia f|elio m|flavio m|maia f|cinzia f mature|cesare m|livia f|dionisio m|demetra f',
  ja: 'uzume f young|ebisu m young|fujin m|izanami f|ama f',
}

export const DEEPGRAM_VOICES = Object.entries(AURA2).flatMap(([lang, rows]) =>
  rows.split('|').map((row) => {
    const [name, gender, ...rest] = row.trim().split(' ')
    const region = rest[0] && /^([A-Z]{2}|\d{3})$/.test(rest[0]) ? rest.shift() : null
    return { id: `aura-2-${name}-${lang}`, name: cap(name), lang: region ? `${lang}-${region}` : lang, gender, note: rest.join(' '), family: 'aura-2' }
  }),
)

const DEEPGRAM_DEFAULTS = { en: 'aura-2-thalia-en', es: 'aura-2-celeste-es', de: 'aura-2-julius-de', fr: 'aura-2-agathe-fr', nl: 'aura-2-rhea-nl', it: 'aura-2-livia-it', ja: 'aura-2-izanami-ja' }

/** The live catalogue, through the relay only: Deepgram refuses pages. */
async function deepgramVoices({ key, signal }) {
  if (!hasRelay()) return DEEPGRAM_VOICES
  try {
    const res = await call('https://api.deepgram.com/v1/models', { headers: key ? { authorization: `Token ${key}` } : {}, signal }, 'Deepgram')
    const j = await res.json()
    const rank = { 'aura-2': 0, aura: 1, flux: 2 }
    const live = (j.tts ?? [])
      .filter((m) => m.canonical_name)
      .map((m) => {
        const tags = m.metadata?.tags ?? []
        const langs = (m.languages ?? []).map(normaliseLang).filter(Boolean)
        return {
          id: m.canonical_name,
          name: cap(m.metadata?.display_name || m.name || m.canonical_name),
          lang: langs.find((l) => l.includes('-')) ?? langs[0] ?? baseLang(m.canonical_name.split('-').at(-1)),
          gender: tags.includes('feminine') ? 'f' : tags.includes('masculine') ? 'm' : undefined,
          note: [m.metadata?.accent, m.architecture === 'aura' ? 'Aura 1' : m.architecture === 'flux' ? 'Flux' : null].filter(Boolean).join(' · '),
          family: m.architecture,
        }
      })
      .sort((a, b) => (rank[a.family] ?? 9) - (rank[b.family] ?? 9))
    return live.length ? live : DEEPGRAM_VOICES
  } catch {
    return DEEPGRAM_VOICES
  }
}

/* ---- ElevenLabs ---- */

export const ELEVEN_MODELS = [
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2 · 29 languages, best for narration', limit: 9500 },
  { id: 'eleven_v3', name: 'v3 · 74 languages, most expressive', limit: 4500 },
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5 · 32 languages, fast and cheap', limit: 9500 },
]

const elevenVoice = (v) => {
  const labels = v.labels ?? {}
  const verified = [...new Set((v.verified_languages ?? []).map((l) => normaliseLang(l.language)).filter(Boolean))]
  const gender = String(labels.gender ?? '').toLowerCase()
  return {
    id: v.voice_id,
    name: v.name,
    lang: normaliseLang(labels.language) || verified[0] || 'en',
    ...(verified.length ? { langs: verified } : {}),
    gender: gender.startsWith('f') ? 'f' : gender.startsWith('m') ? 'm' : undefined,
    note: [labels.accent, labels.descriptive ?? labels.description, ['cloned', 'professional', 'generated'].includes(v.category) ? v.category : null]
      .filter(Boolean)
      .join(' · '),
  }
}

async function elevenVoices({ key, signal }) {
  const headers = key ? { 'xi-api-key': key } : {}
  const out = []
  try {
    let token = null
    for (let page = 0; page < 10; page++) {
      const url = `https://api.elevenlabs.io/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`
      const res = await call(url, { headers, signal }, 'ElevenLabs')
      const j = await res.json()
      out.push(...(j.voices ?? []))
      if (!j.has_more || !j.next_page_token) break
      token = j.next_page_token
    }
  } catch (err) {
    if (out.length) return out.map(elevenVoice)
    // The older route works without a key for the stock voices, which makes
    // an empty-key preview possible; with a wrong key it fails the same way.
    const res = await call('https://api.elevenlabs.io/v1/voices', { headers, signal }, 'ElevenLabs').catch(() => {
      throw err
    })
    const j = await res.json()
    return (j.voices ?? []).map(elevenVoice)
  }
  return out.map(elevenVoice)
}

/**
 * Clone a voice on ElevenLabs from a recording (an "instant" clone).
 * `labels` is what their picker filters on, so the language goes there.
 * Returns the new voice, ready for `speak`.
 */
export async function addVoice({ key, name, blob, description = '', language = null, filename = 'sample.wav', removeNoise = false, signal } = {}) {
  if (!key) throw new SpeechError('ElevenLabs needs an API key first', { provider: 'ElevenLabs' })
  if (!name) throw new SpeechError('ElevenLabs: a cloned voice needs a name', { provider: 'ElevenLabs' })
  if (!blob?.size) throw new SpeechError('ElevenLabs: a cloned voice needs a recording', { provider: 'ElevenLabs' })
  const form = new FormData()
  form.append('name', name)
  form.append('files', blob, filename)
  if (description) form.append('description', description)
  if (removeNoise) form.append('remove_background_noise', 'true')
  form.append('labels', JSON.stringify(language ? { language: baseLang(language) } : {}))
  const res = await call('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal }, 'ElevenLabs')
  const j = await res.json()
  return { id: j.voice_id, name, lang: language ? baseLang(language) : 'en', note: 'cloned', requiresVerification: !!j.requires_verification }
}

/* ---- Cartesia ---- */

const CARTESIA = 'https://api.cartesia.ai'
const CARTESIA_VERSION = '2026-08-14'
const cartesiaHeaders = (key) => ({ authorization: `Bearer ${key}`, 'cartesia-version': CARTESIA_VERSION })

async function cartesiaVoices({ key, language, signal }) {
  const out = []
  let after = null
  const lang = language && language !== 'auto' ? baseLang(language) : null
  for (let page = 0; page < 5; page++) {
    const url = `${CARTESIA}/voices?limit=100${lang ? `&language=${encodeURIComponent(lang)}` : ''}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`
    const res = await call(url, { headers: cartesiaHeaders(key), signal }, 'Cartesia')
    const j = await res.json()
    const rows = j.data ?? []
    for (const v of rows) {
      const gender = String(v.gender ?? '').toLowerCase()
      out.push({
        id: v.id,
        name: v.name,
        lang: normaliseLang(v.language) || 'en',
        gender: gender.startsWith('f') ? 'f' : gender.startsWith('m') ? 'm' : undefined,
        note: [v.accents?.[0]?.accent, v.description ? String(v.description).slice(0, 60) : null].filter(Boolean).join(' · '),
      })
    }
    if (!j.has_more || !rows.length) break
    after = j.next_page ?? rows.at(-1).id
  }
  return out
}

/*
 * Groq is not in this list although it is in the transcription one: its
 * voices after the PlayAI retirement speak English and Arabic only, 200
 * characters at a time, which is no fit for narration.
 */
export const TTS_PROVIDERS = [
  {
    id: 'system',
    label: 'Your computer’s own voices',
    where: 'browser',
    browserDirect: true,
    needs: [],
    // The honest headline. Everything else about this option is delightful:
    // free, instant, offline, and there are usually a couple of hundred of them.
    canRecord: false,
    languages: ANY,
    langChips: 'whatever your computer has installed',
    blurb: 'Free, instant and private. Browsers do not let a page record them, so they can read a script aloud and time it, but not put sound into your video.',
  },
  {
    id: 'openai-compatible',
    label: 'A voice server you run',
    where: 'machine',
    browserDirect: true,
    canRecord: true,
    needs: ['base'],
    baseHint: 'http://localhost:8880/v1',
    modelHint: 'tts-1',
    formats: ['wav', 'mp3', 'opus', 'flac'],
    languages: ANY,
    langChips: 'depends on the model',
    oneLanguageVoices: true,
    blurb: 'Kokoro-FastAPI (port 8880), Speaches, LocalAI or openedai-speech. The text goes to that machine and no further.',
    setupNote: 'Kokoro-FastAPI allows every page as shipped; Speaches and LocalAI have to be told to. “Test it” shows what to set.',
    listVoices: serverVoices,
    // wav rather than mp3, unlike the hosted providers: these servers only
    // encode mp3 when they happen to have ffmpeg, and asking for one they
    // cannot make is a 400 rather than a fallback. wav is always there, always
    // decodes, and the file never leaves the machine anyway.
    speak: (o) => {
      const base = normaliseBase(o.base)
      const fromList = (o.voiceList ?? []).find((v) => v.id === o.voice)
      const lang = o.language && o.language !== 'auto' ? baseLang(o.language) : null
      // `lang_code` is Kokoro's own field and only sent when the list came
      // from a Kokoro-like server; other servers would refuse the extra key.
      const extra = fromList?.src === 'voices' && lang && KOKORO_CODE[lang] ? { lang_code: lang === 'en' && /^b/.test(o.voice) ? 'b' : KOKORO_CODE[lang] } : {}
      return openAiSpeak({ ...o, base, model: o.model || 'tts-1', format: o.format || 'wav', provider: 'your voice server', extra, reach: serverReach(base, 'your voice server') })
    },
  },
  {
    id: 'voicebox',
    label: 'VoiceBox',
    where: 'machine',
    browserDirect: true,
    canRecord: true,
    needs: ['base'],
    baseHint: 'http://127.0.0.1:17493',
    languages: VOICEBOX_LANGS,
    langChips: 'your profiles’ languages',
    oneLanguageVoices: true,
    blurb: 'Voice cloning on your own machine. Your saved profiles appear here, and its Kokoro and Qwen presets can be added in one click.',
    setupNote: VOICEBOX_NOTE,
    listVoices: voiceboxVoices,
    speak: voiceboxSpeak,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    where: 'provider',
    browserDirect: true,
    canRecord: true,
    needs: ['key'],
    keyHint: 'from elevenlabs.io → profile → API key',
    models: ELEVEN_MODELS,
    languages: ANY,
    langChips: '29 languages · 74 with v3',
    blurb: 'The most natural voices. Any of yours speaks every language its model knows.',
    listVoices: elevenVoices,
    async speak({ key, voice, model, language, text, signal, onProgress, voiceList }) {
      const lang = language && language !== 'auto' ? baseLang(language) : null
      let id = voice
      if (!id) {
        const list = voiceList?.length ? voiceList : await elevenVoices({ key, signal })
        id = (lang && list.find((v) => baseLang(v.lang) === lang || (v.langs ?? []).includes(lang)))?.id ?? list[0]?.id
        if (!id) throw new SpeechError('ElevenLabs has no voices on this account yet', { provider: 'ElevenLabs' })
      }
      const model_id = model || 'eleven_multilingual_v2'
      const limit = ELEVEN_MODELS.find((m) => m.id === model_id)?.limit ?? 4500
      const body = { model_id }
      // Honoured by v3 and Flash; documented as ignored by multilingual v2.
      if (lang && model_id !== 'eleven_multilingual_v2') body.language_code = lang
      const chunks = chunkText(text, limit)
      const parts = []
      for (const [i, chunk] of chunks.entries()) {
        if (chunks.length > 1) onProgress?.({ label: `ElevenLabs is speaking… (${i + 1}/${chunks.length})` })
        const res = await call(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`,
          { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, text: chunk }), signal },
          'ElevenLabs',
        )
        parts.push(await res.blob())
      }
      return joinAudio(parts)
    },
  },
  {
    id: 'deepgram',
    label: 'Deepgram Aura',
    where: 'provider',
    browserDirect: true,
    canRecord: true,
    needs: ['key'],
    keyHint: 'from console.deepgram.com',
    voices: DEEPGRAM_VOICES,
    languages: ['en', 'es', 'de', 'fr', 'nl', 'it', 'ja'],
    langChips: 'EN · ES · DE · FR · NL · IT · JA',
    oneLanguageVoices: true,
    defaultVoices: DEEPGRAM_DEFAULTS,
    blurb: 'Low latency and natural. English, Spanish, German, French, Dutch, Italian and Japanese.',
    listVoices: deepgramVoices,
    async speak({ key, voice, language, text, signal, onProgress, voiceList }) {
      const list = voiceList?.length ? voiceList : DEEPGRAM_VOICES
      const model = resolveVoice(TTS_PROVIDERS.find((p) => p.id === 'deepgram'), { voice, language, list }) || DEEPGRAM_DEFAULTS[baseLang(language || 'en')] || 'aura-2-thalia-en'
      // 2000 characters a request, and a 413 above it.
      const chunks = chunkText(text, 1900)
      const parts = []
      for (const [i, chunk] of chunks.entries()) {
        if (chunks.length > 1) onProgress?.({ label: `Deepgram is speaking… (${i + 1}/${chunks.length})` })
        const res = await call(
          `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`,
          { method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: chunk }), signal },
          'Deepgram',
        )
        parts.push(await res.blob())
      }
      return joinAudio(parts)
    },
  },
  {
    id: 'cartesia',
    label: 'Cartesia',
    where: 'provider',
    browserDirect: true,
    canRecord: true,
    needs: ['key'],
    keyHint: 'sk_car_… from play.cartesia.ai',
    languages: ANY,
    langChips: '44 languages',
    oneLanguageVoices: true,
    blurb: 'Sonic: fast, natural, and strong in Spanish. Hundreds of voices, each labelled with its language.',
    listVoices: cartesiaVoices,
    async speak({ key, voice, language, text, signal, onProgress, voiceList }) {
      const lang = language && language !== 'auto' ? baseLang(language) : null
      let id = voice
      if (!id) {
        const list = voiceList?.length ? voiceList : await cartesiaVoices({ key, language: lang, signal })
        id = (lang && list.find((v) => baseLang(v.lang) === lang))?.id ?? list[0]?.id
        if (!id) throw new SpeechError('Cartesia listed no voices', { provider: 'Cartesia' })
      }
      // Its default language is English; a Spanish voice asked in English
      // sounds like it. The chosen language wins, then the voice's own.
      const spoken = lang ?? baseLang((voiceList ?? []).find((v) => v.id === id)?.lang ?? '') ?? null
      const chunks = chunkText(text, 4000)
      const parts = []
      for (const [i, chunk] of chunks.entries()) {
        if (chunks.length > 1) onProgress?.({ label: `Cartesia is speaking… (${i + 1}/${chunks.length})` })
        const res = await call(
          `${CARTESIA}/tts/bytes`,
          {
            method: 'POST',
            headers: { ...cartesiaHeaders(key), 'content-type': 'application/json' },
            body: JSON.stringify({
              model_id: 'sonic-3.6',
              transcript: chunk,
              voice: { mode: 'id', id },
              ...(spoken ? { language: spoken } : {}),
              output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
            }),
            signal,
          },
          'Cartesia',
        )
        parts.push(await res.blob())
      }
      return joinAudio(parts)
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    where: 'provider',
    browserDirect: true,
    canRecord: true,
    needs: ['key'],
    keyHint: 'sk-… from platform.openai.com',
    models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    voices: OPENAI_VOICES,
    languages: ANY,
    langChips: '57 languages',
    blurb: 'gpt-4o-mini-tts speaks 57 languages, Spanish included. The voices are tuned for English.',
    setupNote: 'Works from a page. If it fails with “could not reach api.openai.com”, the key is wrong or OpenAI has turned browser requests off again; through the Klipvia server it always works.',
    unreachableHint: 'With OpenAI this usually means the key is wrong: a bad key gets an answer no browser may read. Through the Klipvia server it always works.',
    speak: (o) =>
      openAiSpeak({
        ...o,
        base: 'https://api.openai.com/v1',
        model: o.model || 'gpt-4o-mini-tts',
        voice: o.voice || 'alloy',
        provider: 'OpenAI',
        reach: { hint: TTS_PROVIDERS.find((p) => p.id === 'openai')?.unreachableHint },
      }),
  },
]

export const sttProvider = (id) => STT_PROVIDERS.find((p) => p.id === id) ?? null
export const ttsProvider = (id) => TTS_PROVIDERS.find((p) => p.id === id) ?? null

/** The host a provider's request actually reaches, for the record it leaves. */
export function hostOf(provider, conf = {}) {
  if (!provider) return null
  const known = {
    groq: 'api.groq.com',
    elevenlabs: 'api.elevenlabs.io',
    deepgram: 'api.deepgram.com',
    assemblyai: 'api.assemblyai.com',
    openai: 'api.openai.com',
    cartesia: 'api.cartesia.ai',
  }
  if (known[provider.id]) return known[provider.id]
  if (provider.id === 'system') return null
  try {
    return new URL(normaliseBase(conf.base ?? '')).hostname || null
  } catch {
    return null
  }
}

/**
 * Where the audio *actually* goes, which is not always where the row says.
 *
 * "A server you run" is a text box, and a text box takes any address. Someone
 * who points it at a machine across the internet has been told, by a badge
 * fixed to the row rather than to the value, that their audio stays on their
 * own machine. That is the one claim in this whole feature that must never be
 * wrong, so it is computed from the address as typed and names the host when
 * the host is somebody else's.
 */
export function actualWhere(provider, conf = {}) {
  if (!provider) return WHERE.provider
  if (provider.where !== 'machine') return WHERE[provider.where] ?? WHERE.provider
  const base = String(conf.base ?? '').trim()
  if (!base) return WHERE.machine
  let host
  try {
    host = new URL(normaliseBase(base)).hostname
  } catch {
    return WHERE.machine
  }
  return isPrivateHost(host) ? WHERE.machine : { ...WHERE.provider, label: `sent to ${host}`, host }
}

/* ------------------------------------------------------- the browser's own */

/**
 * Every voice this computer has, ready to use.
 *
 * `getVoices()` is empty on the first call in most browsers and fills in
 * asynchronously, which is a race everybody loses once. `localService` is the
 * field worth reading: a voice that is not local is synthesised by the
 * browser's vendor, over the network, which matters here more than it does in
 * most apps.
 */
export function systemVoices() {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve([])
  const read = () =>
    speechSynthesis.getVoices().map((v) => ({
      id: v.voiceURI,
      name: v.name,
      lang: v.lang,
      local: v.localService !== false,
      default: v.default,
      voice: v,
    }))
  const now = read()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => resolve(read())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500)
  })
}

const utteranceFor = (text, { voice, rate = 1, pitch = 1, volume = 1 } = {}) => {
  const u = new SpeechSynthesisUtterance(text)
  if (voice?.voice) u.voice = voice.voice
  if (voice?.lang) u.lang = voice.lang
  u.rate = rate
  u.pitch = pitch
  u.volume = volume
  return u
}

/** Read it aloud, here and now. Resolves when it stops. */
export function previewSpeech(text, opts = {}) {
  return new Promise((resolve, reject) => {
    if (typeof speechSynthesis === 'undefined') return reject(new Error('this browser has no speech synthesis'))
    speechSynthesis.cancel()
    const u = utteranceFor(text, opts)
    u.onend = () => resolve()
    u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(new Error(`speech failed: ${e.error}`)))
    speechSynthesis.speak(u)
  })
}

export const stopSpeech = () => {
  try {
    speechSynthesis?.cancel()
  } catch {
    /* nothing was speaking */
  }
}

/**
 * How long a script runs, worked out rather than measured.
 *
 * Narration sits around 160 words a minute; this is that, adjusted for the
 * speed setting. It is never as good as hearing the voice say it, which is why
 * everything that uses it says which one it got.
 */
function estimate(text, rate = 1) {
  const words = String(text).trim().split(/\s+/).filter(Boolean)
  return {
    text,
    words: [],
    duration: words.length / ((160 / 60) * (rate || 1)),
    estimated: true,
    source: 'estimate',
  }
}

/**
 * How long a script takes to say, and when each word lands.
 *
 * The consolation prize for not being able to record these voices, and a
 * surprisingly good one. `onboundary` fires per word with an `elapsedTime`, so
 * reading a script silently — `volume = 0`, so nothing is heard — produces real
 * word timings for free, offline, with no key and no download. That is enough
 * to lay captions under a narration, or to find out whether a script fits the
 * shot before paying anyone to voice it.
 *
 * Resolves to a Whisper-shaped document, so it feeds the same parser every
 * other source here does.
 */
export function timeSpeech(text, opts = {}) {
  return new Promise((resolve, reject) => {
    if (typeof speechSynthesis === 'undefined') return reject(new Error('this browser has no speech synthesis'))
    if (!String(text ?? '').trim()) return reject(new SpeechError('there is nothing to time — the script is empty'))
    speechSynthesis.cancel()
    const u = utteranceFor(text, { ...opts, volume: 0 })
    const marks = []
    u.onboundary = (e) => {
      if (e.name && e.name !== 'word') return
      marks.push({ charIndex: e.charIndex, at: e.elapsedTime })
    }
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return resolve(build(0))
      // A browser will not speak on a page nobody has touched yet, even
      // silently — and an agent asking how long a script runs is very often
      // the first thing that happens on a page. Refusing outright would make
      // the one tool that needs no setup the one that fails first, so the
      // answer falls back to arithmetic and says that it did.
      if (e.error === 'not-allowed') return resolve(estimate(text, opts.rate ?? 1))
      reject(new Error(`speech failed: ${e.error}`))
    }

    const started = performance.now()
    const build = (totalMs) => {
      const total = totalMs || (marks.length ? marks[marks.length - 1].at + 400 : 0)
      const words = []
      for (let i = 0; i < marks.length; i++) {
        const from = marks[i]
        const to = marks[i + 1]
        const slice = text.slice(from.charIndex, to ? to.charIndex : undefined).trim()
        if (!slice) continue
        words.push({ word: slice, start: from.at / 1000, end: (to ? to.at : total) / 1000 })
      }
      return { text, words, duration: total / 1000, source: 'system-voice' }
    }
    u.onend = () => resolve(build(performance.now() - started))
    speechSynthesis.speak(u)
  })
}

/* ----------------------------------------------------------------- running */

const chosenLang = (v) => (v && v !== 'auto' ? String(v) : null)

/**
 * Transcribe one file, whoever is doing the transcribing.
 *
 * Returns a Whisper-shaped document — `{text, segments?, words?}` — because
 * that is what `subtitles.js` already reads, including the word timings the
 * karaoke captions run on. Every provider above is bent into that shape rather
 * than each having its own path through the app. `language` is a BCP-47 code
 * or null for "let it guess"; unset, the provider's saved language is used.
 */
export async function transcribe(providerId, settings, { blob, filename, durationMs, language = null, signal, onProgress } = {}) {
  const p = sttProvider(providerId)
  if (!p) throw new SpeechError(`no transcription provider "${providerId}"`)
  if (!p.transcribe) throw new SpeechError(`${p.label} cannot transcribe`)
  const conf = settings?.[p.id] ?? {}
  for (const need of p.needs ?? []) {
    if (!conf[need]) throw new SpeechError(`${p.label} needs ${need === 'key' ? 'an API key' : 'an address'} first`)
  }
  onProgress?.({ label: `sending to ${p.label}…` })
  const doc = await p.transcribe({ ...conf, language: chosenLang(language ?? conf.language), blob, filename, signal, onProgress })
  return normaliseUnits(doc, durationMs)
}

/**
 * Say one piece of text, and hand back the bytes.
 *
 * `voice` and `language` fall back to the provider's saved choices. Where each
 * voice speaks one language, a chosen language picks the voice: see
 * `resolveVoice`.
 */
export async function speak(providerId, settings, { text, voice, language, signal, onProgress } = {}) {
  const p = ttsProvider(providerId)
  if (!p) throw new SpeechError(`no voice provider "${providerId}"`)
  // Caught here rather than by the provider. An empty script is a round trip
  // that can only fail, and against a hosted voice it is a billable one.
  if (!String(text ?? '').trim()) throw new SpeechError('there is nothing to say — the script is empty')
  if (!p.speak) throw new SpeechError(`${p.label} cannot be recorded — it can only read aloud here`)
  const conf = settings?.[p.id] ?? {}
  for (const need of p.needs ?? []) {
    if (!conf[need]) throw new SpeechError(`${p.label} needs ${need === 'key' ? 'an API key' : 'an address'} first`)
  }
  // A voice named outright is used as named. The language remembered in the
  // panel swaps voices only when nobody said which voice — an agent asking for
  // aura-2-zeus-en while the panel remembers Spanish should get Zeus, not
  // Celeste — and then the language sent along is that voice's own, where it
  // has one, rather than the panel's.
  const named = voice || null
  const list = (conf.voiceList ?? []).map(asVoice)
  const ownLang = (id) => {
    const v = list.find((x) => x.id === id) ?? (p.voices ?? []).map(asVoice).find((x) => x.id === id)
    return v && v.lang && v.lang !== '*' ? baseLang(v.lang) : null
  }
  const asked = chosenLang(language)
  const picked = named
    ? resolveVoice(p, { voice: named, language: asked, list: conf.voiceList })
    : resolveVoice(p, { voice: conf.voice || null, language: chosenLang(conf.language), list: conf.voiceList })
  const lang = asked ?? (named && p.oneLanguageVoices ? ownLang(picked) : chosenLang(conf.language))
  onProgress?.({ label: `asking ${p.label}…` })
  const blob = await p.speak({ ...conf, voice: picked, language: lang, voiceList: conf.voiceList ?? [], text, signal, onProgress })
  if (!blob?.size) throw new SpeechError(`${p.label} returned nothing`)
  return blob
}

/**
 * The voices a provider offers, each `{ id, name, lang, gender?, note? }`.
 * Static for providers that publish a fixed set, live for the ones that list
 * an account's or a server's voices, the computer's own for `system`.
 */
export async function listVoices(providerId, conf = {}, { signal } = {}) {
  const p = ttsProvider(providerId)
  if (!p) throw new SpeechError(`no voice provider "${providerId}"`)
  if (p.id === 'system') return systemVoices()
  if (!p.listVoices) return (p.voices ?? []).map(asVoice)
  for (const need of p.needs ?? []) {
    if (!conf[need]) throw new SpeechError(`${p.label} needs ${need === 'key' ? 'an API key' : 'an address'} first`)
  }
  return (await p.listVoices({ ...conf, signal })).map(asVoice)
}

export { SpeechError }
