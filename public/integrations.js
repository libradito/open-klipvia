/**
 * Connecting Klipvia to a voice and to a pair of ears.
 *
 * `speech.js` knows how to talk to each provider. This knows which one you
 * picked, remembers it, and turns the two jobs anybody actually wants — "write
 * down what is said in this clip" and "read this script out loud into my
 * video" — into things that land in the media library and on the timeline like
 * anything else.
 *
 * ── About the keys ──────────────────────────────────────────────────────────
 * A key is yours and belongs to this browser, not to the project. That is not a
 * style preference; it is what keeps a key out of a file you send someone.
 * `exportProjectFile` builds its zip from the `projects`, `timelines`,
 * `transcripts`, `mediaMeta` and `assetMeta` stores and from OPFS — settings
 * live in `localStorage` under a `klipvia:` prefix, which is reachable from
 * none of them. So a key cannot travel in a project by construction rather
 * than by remembering to strip it.
 *
 * The same prefix is what `eraseEverything()` sweeps, so "erase everything"
 * takes the keys with it, and the settings panel can forget them on their own.
 *
 * They are kept apart from the rest of the settings in their own entry so that
 * clearing credentials does not also forget which server you run and where.
 */

import * as SPEECH from './speech.js'
import { icon } from './icons.js'
import { COMMON_LANGUAGES, baseLang, groupVoices, langChip, languageName, languagesIn, normaliseLang } from './languages.js'

const SETTINGS_KEY = 'klipvia:integrations'
const KEYS_KEY = 'klipvia:integrations.keys'
const LOG_KEY = 'klipvia:integrations.log'
/**
 * Which library files a voice read from a script: filename → { provider,
 * voice, voiceName, language, at }. A media record is written once by the
 * probe and has no route for a note like this in either build, so the mark
 * lives beside the settings; under the same prefix, so "erase everything"
 * takes it with the rest and a project file can never carry it.
 */
const VOICES_KEY = 'klipvia:voiceovers'

/*
 * A caution that has to be repeated wherever a credential is near a document:
 * `PUT /api/projects/:id` merges whatever the body holds into the stored
 * project, and `exportProjectFile` spreads projects, timelines and transcripts
 * verbatim into the zip. A key written onto any of those would persist *and*
 * ship inside a file somebody emails a colleague. Credentials live in
 * localStorage and nowhere else, and there is no reason to ever move one.
 */

/* ------------------------------------------------------------------ store */

const readJson = (key, fallback) => {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key) ?? 'null') ?? {}) }
  } catch {
    return { ...fallback }
  }
}

const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* a browser that will not store this will say so elsewhere */
  }
}

const DEFAULTS = {
  /** Chosen provider ids, or null for "not set up". */
  stt: null,
  tts: null,
  /**
   * Per-provider config: base urls, model ids, chosen voice and language, the
   * last voice list (`voiceList`) and what it was loaded for (`voiceListFor`).
   * Never keys.
   */
  providers: {},
  /** The system voice picked for reading aloud, by voiceURI. */
  systemVoice: null,
  rate: 1,
  /**
   * May an agent send audio out of this computer on its own initiative?
   *
   * Off, and it has to stay off by default. Choosing a provider is consent to
   * your own sends; it is not consent to a model deciding to post an hour of
   * footage to one — least of all when the instruction to do so could have
   * arrived inside a transcript the model was asked to read.
   */
  agentMayEgress: false,
  /** Set once the person has been shown what this can do, so it is shown once. */
  introSeen: false,
}

export function load() {
  const s = readJson(SETTINGS_KEY, DEFAULTS)
  s.providers = s.providers && typeof s.providers === 'object' ? s.providers : {}
  return s
}

export function save(patch) {
  const next = { ...load(), ...patch }
  writeJson(SETTINGS_KEY, next)
  return next
}

/** Per-provider config, merged with its credential. Never persisted together. */
export function configFor(providerId) {
  const s = load()
  const keys = readJson(KEYS_KEY, {})
  return { ...(s.providers[providerId] ?? {}), ...(keys[providerId] ? { key: keys[providerId] } : {}) }
}

/** Everything a provider needs, indexed by id, ready for speech.js. */
export function allConfig() {
  const s = load()
  const keys = readJson(KEYS_KEY, {})
  const out = {}
  for (const id of new Set([...Object.keys(s.providers), ...Object.keys(keys)])) {
    out[id] = { ...(s.providers[id] ?? {}), ...(keys[id] ? { key: keys[id] } : {}) }
  }
  return out
}

export function setProviderConfig(providerId, patch) {
  const s = load()
  const { key, ...rest } = patch ?? {}
  s.providers[providerId] = { ...(s.providers[providerId] ?? {}), ...rest }
  writeJson(SETTINGS_KEY, s)
  if (key !== undefined) setKey(providerId, key)
  return s.providers[providerId]
}

export function setKey(providerId, key) {
  const keys = readJson(KEYS_KEY, {})
  if (key) keys[providerId] = String(key).trim()
  else delete keys[providerId]
  writeJson(KEYS_KEY, keys)
}

export const hasKey = (providerId) => !!readJson(KEYS_KEY, {})[providerId]

/** Which providers hold a credential right now — for the "forget these" line. */
export const providersWithKeys = () => Object.keys(readJson(KEYS_KEY, {}))

/* ----------------------------------------------------------------- ledger */

/**
 * What has actually left this browser.
 *
 * Everywhere else in the panel describes what *would* happen. This is the only
 * thing that keeps telling the truth after somebody stops reading: a plain
 * record of each send, what it was, how big, and to whom. It holds no content —
 * no script text, no audio, no transcript — because a privacy record that
 * copies the private thing is a second copy of the private thing.
 *
 * Fifty entries, newest first. It is a receipt, not an audit trail.
 */
const LOG_CAP = 50

export function recordSend({ provider, host, job, name, bytes = null, chars = null }) {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]')
    log.unshift({ at: Date.now(), provider, host, job, name, bytes, chars })
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, LOG_CAP)))
  } catch {
    /* a record nobody can keep is not worth failing a job over */
  }
}

export function sendLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function clearSendLog() {
  try {
    localStorage.removeItem(LOG_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** A one-line summary of the ledger, for the panel's footer. */
export function egressSummary() {
  const log = sendLog()
  const away = log.filter((e) => e.host && !SPEECH.isPrivateHost(e.host))
  if (!log.length) return 'Nothing has been sent anywhere from this browser.'
  if (!away.length) return `${log.length} job(s), all to a machine on your own network. Nothing has left it.`
  const hosts = [...new Set(away.map((e) => e.host))]
  return `${away.length} of ${log.length} job(s) went to ${hosts.join(', ')}.`
}

/** filename → what read it, for every voice-over made in this browser. */
export function voiceOvers() {
  try {
    const v = JSON.parse(localStorage.getItem(VOICES_KEY) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function markVoiceOver(filename, meta) {
  const all = voiceOvers()
  all[filename] = { ...meta, at: Date.now() }
  writeJson(VOICES_KEY, all)
}

export function forgetAllKeys() {
  try {
    localStorage.removeItem(KEYS_KEY)
  } catch {
    /* nothing to remove */
  }
  // The voice lists were fetched with those keys; their fingerprints go too,
  // so a new key lists its own voices instead of inheriting the old list.
  const s = load()
  for (const id of Object.keys(s.providers)) delete s.providers[id].voiceListFor
  writeJson(SETTINGS_KEY, s)
}

/**
 * Is this provider actually usable from where the page is standing?
 *
 * Two different "no"s, and they need different words. A provider that no
 * browser may call is never available without the Klipvia server. A provider
 * that simply has not been filled in yet is one form away from working.
 */
export function readiness(provider, { local = true } = {}) {
  if (!provider) return { ok: false, why: 'unknown' }
  if (!provider.browserDirect && !SPEECH.hasRelay()) {
    return { ok: false, blocked: true, why: `${provider.label} does not allow web pages to call it directly` }
  }
  const conf = configFor(provider.id)
  const missing = (provider.needs ?? []).filter((n) => !conf[n])
  if (missing.length) {
    return { ok: false, why: missing.includes('key') ? 'needs an API key' : 'needs an address' }
  }
  return { ok: true }
}

/* ----------------------------------------------------------------- voices */

/**
 * The voices a provider has right now, without asking it: the list loaded
 * last time, else the provider's own fixed set. Each `{ id, name, lang }`.
 */
export function voicesFor(providerId) {
  const p = SPEECH.ttsProvider(providerId)
  if (!p) return []
  const conf = configFor(providerId)
  const list = conf.voiceList?.length ? conf.voiceList : (p.voices ?? [])
  return list.map(SPEECH.asVoice)
}

/** What the voice list depends on; when this changes, the list is stale. */
function voiceFingerprint(providerId) {
  const c = configFor(providerId)
  return `${c.base ?? ''}|${c.key ? keyMark(c.key) : ''}|${providerId === 'cartesia' ? (c.language ?? '') : ''}`
}

/**
 * A mark that changes when the key does, without being a piece of the key.
 * The fingerprint is saved in the settings store, which must never hold
 * credential material — not even four characters of it.
 */
function keyMark(key) {
  let h = 0x811c9dc5
  for (const ch of String(key)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${String(key).length}.${h.toString(16)}`
}

/** Ask the provider for its voices and remember them. */
export async function refreshVoices(providerId, { signal } = {}) {
  const list = await SPEECH.listVoices(providerId, configFor(providerId), { signal })
  setProviderConfig(providerId, { voiceList: list, voiceListFor: voiceFingerprint(providerId) })
  return list
}

/** Put a voice that was just made at the top of the list and choose it. */
function adoptVoice(providerId, voice) {
  const rest = voicesFor(providerId).filter((v) => v.id !== voice.id)
  setProviderConfig(providerId, { voiceList: [voice, ...rest], voice: voice.id, language: baseLang(voice.lang) || undefined })
  return voice
}

/** One of VoiceBox's built-in voices, saved as a profile it can speak with. */
export async function addPresetVoice({ engine, voiceId, name, language, signal } = {}) {
  const voice = await SPEECH.addPresetVoice({ ...configFor('voicebox'), engine, voiceId, name, ...(language ? { language } : {}), signal })
  return adoptVoice('voicebox', voice)
}

/** A VoiceBox clone of a library recording. `referenceText` is what it says. */
export async function cloneVoice(filename, { name, language, referenceText, description, local = true, signal } = {}) {
  const blob = await mediaBlob(filename, { local })
  const voice = await SPEECH.cloneVoice({ ...configFor('voicebox'), name, ...(language ? { language } : {}), blob, referenceText, description, filename, signal })
  return adoptVoice('voicebox', voice)
}

/** An ElevenLabs instant clone of a library recording. */
export async function addVoice(filename, { name, language, description, local = true, signal } = {}) {
  const blob = await mediaBlob(filename, { local })
  const voice = await SPEECH.addVoice({ ...configFor('elevenlabs'), name, ...(language ? { language } : {}), blob, description, filename, signal })
  return adoptVoice('elevenlabs', voice)
}

/* ------------------------------------------------------------------ tasks */

/** The bytes of a library file, whichever back end is holding them. */
async function mediaBlob(filename, { local }) {
  if (local) {
    const LOCAL = await import('./localstore.js')
    const url = await LOCAL.mediaUrl(filename)
    if (!url) throw new Error(`"${filename}" is not in the library`)
    return await (await fetch(url)).blob()
  }
  const res = await fetch(`/media/${encodeURIComponent(filename)}`)
  if (!res.ok) throw new Error(`could not read "${filename}"`)
  return await res.blob()
}

/** How long a file actually is, asked of the browser rather than assumed. */
async function audioLength(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.src = url
    const seconds = await new Promise((resolve) => {
      el.onloadedmetadata = () => resolve(el.duration)
      el.onerror = () => resolve(0)
      setTimeout(() => resolve(0), 8000)
    })
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Write down what is said in a file, and put the words in the library.
 *
 * The provider's answer is bent into Whisper's shape by `speech.js` and handed
 * to the same `/api/transcripts` route a dropped `.srt` goes through, so the
 * result is an ordinary transcript: editable line by line, exportable as SRT,
 * and placeable as captions with karaoke highlighting where the words carry
 * their own timings. `language` is a code like `es`, or null to let the
 * provider guess; unset, the language last chosen for that provider is used.
 */
export async function transcribeMedia(filename, { local = true, media = null, language = null, signal, onProgress } = {}) {
  const settings = load()
  if (!settings.stt) throw new Error('no transcription set up yet')

  onProgress?.({ label: 'reading the file…' })
  const blob = await mediaBlob(filename, { local })
  // The length of the audio is what decides whether a provider answered in
  // seconds or milliseconds, so it is worth a decode rather than a zero — with
  // no duration the units cannot be checked at all.
  const durationMs = media?.durationMs || (await audioLength(blob))
  const doc = await SPEECH.transcribe(settings.stt, allConfig(), {
    blob,
    filename,
    language,
    durationMs,
    signal,
    onProgress,
  })
  recordSend({
    provider: SPEECH.sttProvider(settings.stt)?.label ?? settings.stt,
    host: SPEECH.hostOf(SPEECH.sttProvider(settings.stt), configFor(settings.stt)),
    job: 'transcription',
    name: filename,
    bytes: blob.size,
  })

  onProgress?.({ label: 'saving the words…' })
  // Posted as Whisper JSON, so segments and per-word timings both survive.
  const name = `${filename.replace(/\.[^.]+$/, '')}.json`
  const res = await fetch(`/api/transcripts?name=${encodeURIComponent(name)}&media=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? 'could not save the transcript')
  return body
}

/**
 * Read a script out loud and put the recording in the library.
 *
 * Only providers that hand back bytes can do this — the computer's own voices
 * cannot, and say so rather than producing a silent file. What comes back is an
 * ordinary audio file: it lands in the media library, carries a waveform, and
 * drops onto an audio track like anything imported. `voice` and `language`
 * default to the choices saved for the provider.
 */
export async function generateVoice(text, { name = null, voice = null, language = null, local = true, signal, onProgress } = {}) {
  const settings = load()
  if (!settings.tts) throw new Error('no voice set up yet')
  const provider = SPEECH.ttsProvider(settings.tts)
  if (provider && !provider.speak) {
    throw new Error(
      `${provider.label} can read a script aloud here, but a browser will not let a page record it. ` +
        `Pick a voice that returns a file to put narration in your video.`,
    )
  }

  const blob = await SPEECH.speak(settings.tts, allConfig(), { text, voice, language, signal, onProgress })
  recordSend({
    provider: provider?.label ?? settings.tts,
    host: SPEECH.hostOf(provider, configFor(settings.tts)),
    job: 'voice',
    name: name || `${text.slice(0, 30)}…`,
    chars: text.length,
  })
  onProgress?.({ label: 'adding it to the library…' })

  const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('ogg') ? 'ogg' : 'mp3'
  const stem = (name || text).replace(/\s+/g, ' ').trim().slice(0, 40).replace(/[^A-Za-z0-9 _-]+/g, '') || 'voice-over'
  const res = await fetch(`/api/media?name=${encodeURIComponent(`${stem}.${ext}`)}`, { method: 'POST', body: blob })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? 'could not store the audio')
  // Marked as a voice-over, so the Speech rail can list it by its voice.
  const conf = configFor(settings.tts)
  const voiceId = voice ?? conf.voice ?? null
  const v = voicesFor(settings.tts).find((x) => x.id === voiceId) ?? null
  const lang = language ?? conf.language ?? (v?.lang && v.lang !== '*' ? baseLang(v.lang) : null)
  markVoiceOver(body.filename, {
    provider: provider?.label ?? settings.tts,
    voice: voiceId,
    voiceName: v?.name ?? null,
    language: lang && lang !== 'auto' ? baseLang(lang) : null,
  })
  return body
}

/**
 * How long a script takes to say, without saying it out loud or sending it
 * anywhere. Always available: it is the computer's own voice, silenced.
 */
export async function timeScript(text) {
  const settings = load()
  const voices = await SPEECH.systemVoices()
  return SPEECH.timeSpeech(text, { voice: resolveSystemVoice(voices, settings), rate: settings.rate ?? 1 })
}

/** Read it aloud with the chosen system voice, for checking a line. */
export async function readAloud(text) {
  const settings = load()
  const voices = await SPEECH.systemVoices()
  return SPEECH.previewSpeech(text, { voice: resolveSystemVoice(voices, settings), rate: settings.rate ?? 1 })
}

export const stopReading = SPEECH.stopSpeech

/**
 * The chosen system voice, on whatever computer this now is.
 *
 * By id first, then by name and language, then by language alone. A project
 * carried to another machine finds the nearest voice rather than silently
 * getting whatever happens to be first in the list.
 */
export function resolveSystemVoice(voices, settings = load()) {
  const usable = voices.filter((v) => v.local)
  const pool = usable.length ? usable : voices
  return (
    pool.find((v) => v.id === settings.systemVoice) ??
    pool.find((v) => v.name === settings.systemVoiceName && v.lang === settings.systemVoiceLang) ??
    pool.find((v) => v.lang === settings.systemVoiceLang) ??
    pool.find((v) => v.default) ??
    pool[0] ??
    null
  )
}

/* --------------------------------------------------------------------- ui */

/**
 * The panel, and the two ways in.
 *
 * Written here rather than in app.js because the whole feature is one subject,
 * and because the ordering rule below is the design: every list is sorted by
 * where the audio goes, most private first, and every row says so out loud.
 * Nobody has to know what CORS is to understand "sent to a provider".
 *
 * Nothing is configured to begin with, and nothing insists on being. The panel
 * opens on what already works with no setup at all — this computer's own
 * voices, which are free, offline and numerous — and treats every provider as
 * an optional upgrade you go and get when you want it.
 */
export function initIntegrations({ $, status, refreshLibrary, insertMedia, insertTranscript, mediaWithSound, mediaFor, isLocal, playheadMs }) {
  const dlg = $('dlgSpeech')
  const body = $('speechBody')
  let tab = 'stt'
  let voiceCache = []
  /** Provider rows whose "Add a voice…" panel is open. */
  const addOpen = new Set()

  // The badge follows the address, not the row — see actualWhere().
  const where = (p) => SPEECH.actualWhere(p, configFor(p.id))
  const providersFor = (kind) =>
    [...(kind === 'stt' ? SPEECH.STT_PROVIDERS : SPEECH.TTS_PROVIDERS)].sort(
      (a, b) => (SPEECH.WHERE[a.where]?.rank ?? 9) - (SPEECH.WHERE[b.where]?.rank ?? 9),
    )

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const option = (value, text) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    return o
  }

  /* ---------------------------------------------------------- languages */

  /** "EN · ES · …" or one phrase, as small chips under a row's blurb. */
  function langChips(p) {
    const wrap = el('div', 'prov-langs')
    const langs = p.languages ?? []
    if (langs.length === 1 && langs[0] === '*') {
      wrap.append(el('span', 'chip', p.langChips ?? 'any language'))
    } else if (langs.length > 8) {
      wrap.append(el('span', 'chip', p.langChips ?? `${langs.length} languages`))
    } else {
      for (const l of langs) {
        const c = el('span', 'chip', langChip(l))
        c.title = languageName(l)
        wrap.append(c)
      }
    }
    return wrap
  }

  /**
   * A voice `<select>` with one group per language, and its label text.
   * Voices carry their language; a picker that flattens two hundred of them
   * into one column hides the only thing anybody scans for.
   */
  function fillVoicePick(select, list, { chosen = null, first = null, empty = 'no voices yet' } = {}) {
    select.replaceChildren()
    const groups = groupVoices(list, { first })
    if (!groups.length) {
      select.append(option('', empty))
      select.disabled = true
      return null
    }
    select.disabled = false
    for (const g of groups) {
      const og = document.createElement('optgroup')
      og.label = g.label
      for (const v of g.voices) {
        const bits = [v.name]
        const detail = [v.gender === 'f' ? '♀' : v.gender === 'm' ? '♂' : null, v.lang && v.lang.includes('-') ? v.lang : null, v.note].filter(Boolean).join(' · ')
        if (detail) bits.push(`— ${detail}`)
        og.append(option(v.id, bits.join(' ')))
      }
      select.append(og)
    }
    const ids = list.map((v) => v.id)
    select.value = chosen && ids.includes(chosen) ? chosen : (groups[0]?.voices[0]?.id ?? '')
    return select.value
  }

  /** "Auto" plus every language the voices cover, plus the usual ones. */
  function fillLangPick(select, { provider, list, chosen = null, auto = 'Auto (the voice’s own)' } = {}) {
    select.replaceChildren()
    select.append(option('auto', auto))
    const present = languagesIn(list ?? []).filter((l) => l !== '*')
    const declared = (provider?.languages ?? []).filter((l) => l !== '*')
    const any = (provider?.languages ?? []).includes('*')
    // Where every voice speaks every language, a language is a choice about
    // the script, not a search for a voice, so no language is "missing".
    const multilingual = any || !provider?.oneLanguageVoices
    const codes = [...new Set([...present, ...declared, ...(any ? COMMON_LANGUAGES : [])])]
    const rank = (l) => (present.includes(l) ? 0 : 1)
    codes.sort((a, b) => rank(a) - rank(b) || languageName(a).localeCompare(languageName(b)))
    for (const l of codes) select.append(option(l, present.includes(l) || multilingual ? languageName(l) : `${languageName(l)} (no voice)`))
    select.value = chosen && codes.includes(baseLang(chosen)) ? baseLang(chosen) : 'auto'
    select.disabled = false
    return select.value
  }

  /* ------------------------------------------------------------ one row */

  function providerRow(kind, p, chosen) {
    const w = where(p)
    const ready = readiness(p, { local: isLocal() })
    const row = el('div', `prov${chosen ? ' chosen' : ''}${ready.blocked ? ' blocked' : ''}`)

    const head = el('label', 'prov-head')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = `speech-${kind}`
    radio.checked = chosen
    radio.disabled = !!ready.blocked
    radio.onchange = () => {
      save(kind === 'stt' ? { stt: p.id } : { tts: p.id })
      render()
    }
    head.append(radio, el('span', 'prov-name', p.label), el('span', `where where-${w.id}`, w.label))
    if (ready.ok) head.append(el('span', 'prov-ok', 'ready'))
    row.append(head)
    row.append(el('p', 'prov-blurb', p.blurb))
    row.append(langChips(p))

    // The one thing a person cannot debug for themselves.
    if (ready.blocked) {
      row.append(el('p', 'prov-warn', `${ready.why}. Run the Klipvia server to use it, or pick one above.`))
      return row
    }
    if (!chosen) return row

    const fields = el('div', 'settings')
    const conf = configFor(p.id)

    const field = (label, key, { type = 'text', placeholder = '', wide = false, options = null, value = null, tip = null } = {}) => {
      const l = el('label', wide ? 'wide' : '')
      if (tip) l.dataset.tip = tip
      l.append(document.createTextNode(label))
      let input
      if (options) {
        input = document.createElement('select')
        for (const o of options) input.append(option(typeof o === 'string' ? o : o.id, typeof o === 'string' ? o : o.name))
        input.value = value ?? conf[key] ?? (typeof options[0] === 'string' ? options[0] : options[0]?.id) ?? ''
      } else {
        input = document.createElement('input')
        input.type = type
        input.placeholder = placeholder
        input.spellcheck = false
        input.value = value ?? conf[key] ?? ''
      }
      input.onchange = () => {
        setProviderConfig(p.id, { [key]: input.value })
        render()
      }
      l.append(input)
      fields.append(l)
      return input
    }

    if ((p.needs ?? []).includes('base')) field('Address', 'base', { placeholder: p.baseHint, wide: true })
    if ((p.needs ?? []).includes('key')) {
      // type=password so a key is not read over someone's shoulder or caught
      // in a screen share. It is stored as text either way; this is about eyes.
      field('API key', 'key', { type: 'password', placeholder: p.keyHint, wide: true })
    }
    if (p.models) field('Model', 'model', { options: p.models })
    else if (p.modelHint) field('Model', 'model', { placeholder: p.modelHint })
    if (kind === 'tts' && (p.voices || p.listVoices)) voiceFields(p, conf, fields)
    if (kind === 'tts' && p.formats) field('Format', 'format', { options: p.formats })
    row.append(fields)

    // Cross-origin advice is only advice when the page is the one calling.
    if (p.setupNote) {
      row.append(
        el(
          'p',
          'prov-note',
          SPEECH.relayFor(p, conf) ? 'Klipvia’s server makes this call, so nothing at the other end needs changing.' : p.setupNote,
        ),
      )
    }
    // http:// to somewhere that is not this machine is readable by anything in
    // between, and nothing else on screen would tell you.
    if (w.id === 'provider' && /^http:\/\//i.test(SPEECH.normaliseBase(conf.base ?? ''))) {
      row.append(el('p', 'prov-warn', 'That address is not encrypted: anything between you and it can read the audio.'))
    }

    const acts = el('div', 'prov-acts')
    const test = el('button', 'btn small', 'Test it')
    test.dataset.tip = kind === 'stt' ? 'Send one second of silence and see whether it answers.' : 'Ask it to say one short line and play it here.'
    test.onclick = () => runTest(kind, p, test)
    acts.append(test)
    if (kind === 'tts' && p.listVoices) {
      const list = el('button', 'btn small ghost', 'Refresh voices')
      list.dataset.tip = 'Ask it for its voices again. They load on their own when the address or key changes.'
      list.onclick = () => loadRemoteVoices(p, list)
      acts.append(list)
    }
    if (kind === 'tts' && p.id === 'voicebox' && ready.ok) {
      const add = el('button', 'btn small ghost', addOpen.has(p.id) ? 'Close' : 'Add a voice…')
      add.dataset.tip = 'Save one of VoiceBox’s built-in voices as a profile, or clone a recording from your library.'
      add.onclick = () => {
        if (addOpen.has(p.id)) addOpen.delete(p.id)
        else addOpen.add(p.id)
        render()
      }
      acts.append(add)
    }
    const result = el('span', 'prov-result')
    result.id = `provResult-${p.id}`
    acts.append(result)
    row.append(acts)
    const diag = el('div', 'prov-diag')
    diag.id = `provDiag-${p.id}`
    diag.hidden = true
    row.append(diag)
    if (kind === 'tts' && p.id === 'voicebox' && addOpen.has(p.id) && ready.ok) row.append(voiceAddPanel(p))

    // Voices load on their own once the row can reach the provider — with a
    // short delay so typing an address does not fire a request per keystroke.
    if (kind === 'tts' && p.listVoices && ready.ok) maybeLoadVoices(p)
    return row
  }

  /** The Voice and Language pickers on a provider row. */
  function voiceFields(p, conf, fields) {
    const list = voicesFor(p.id)
    const vl = el('label', 'wide')
    vl.dataset.tip = 'Grouped by language. The list comes from the provider itself where it has one.'
    vl.append(document.createTextNode('Voice'))
    const pick = document.createElement('select')
    const stale = failed.get(p.id) === voiceFingerprint(p.id)
    fillVoicePick(pick, list, { chosen: conf.voice ?? null, first: conf.language, empty: !p.listVoices ? 'no voices' : stale ? 'could not load them: see below' : 'loading…' })
    pick.onchange = () => {
      const v = list.find((x) => x.id === pick.value)
      setProviderConfig(p.id, { voice: pick.value, ...(p.oneLanguageVoices && v?.lang && v.lang !== '*' ? { language: baseLang(v.lang) } : {}) })
      render()
    }
    vl.append(pick)
    fields.append(vl)

    const ll = el('label', '')
    ll.dataset.tip = p.oneLanguageVoices
      ? 'Picking a language picks a voice that speaks it.'
      : 'Sent along with the script where the model takes a language; otherwise it is worked out from the text.'
    ll.append(document.createTextNode('Language'))
    const lang = document.createElement('select')
    fillLangPick(lang, { provider: p, list, chosen: conf.language ?? null })
    lang.onchange = () => {
      const language = lang.value === 'auto' ? null : lang.value
      const voice = SPEECH.resolveVoice(p, { voice: conf.voice ?? null, language, list })
      setProviderConfig(p.id, { language, ...(voice ? { voice } : {}) })
      render()
    }
    ll.append(lang)
    fields.append(ll)
  }

  /* -------------------------------------------------------------- system */

  /** The computer's own voices get their own row: no fields, a real caveat. */
  function systemRow(chosen) {
    const p = SPEECH.ttsProvider('system')
    const row = el('div', `prov${chosen ? ' chosen' : ''}`)
    const head = el('label', 'prov-head')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'speech-tts'
    radio.checked = chosen
    radio.onchange = () => {
      save({ tts: 'system' })
      render()
    }
    head.append(radio, el('span', 'prov-name', p.label), el('span', 'where where-browser', 'in this browser'), el('span', 'prov-ok', 'ready'))
    row.append(head, el('p', 'prov-blurb', p.blurb))
    const local = voiceCache.filter((v) => v.local)
    const chips = el('div', 'prov-langs')
    const langs = languagesIn(local)
    if (langs.length) {
      for (const l of langs.slice(0, 12)) {
        const c = el('span', 'chip', langChip(l))
        c.title = languageName(l)
        chips.append(c)
      }
      if (langs.length > 12) chips.append(el('span', 'chip', `+${langs.length - 12}`))
    } else {
      chips.append(el('span', 'chip', p.langChips))
    }
    row.append(chips)
    if (!chosen) return row

    const fields = el('div', 'settings')
    const s = load()
    const l = el('label', 'wide')
    l.append(document.createTextNode('Voice'))
    const pick = document.createElement('select')
    fillVoicePick(pick, local, { chosen: resolveSystemVoice(voiceCache, s)?.id ?? null, first: s.systemVoiceLang, empty: 'no voices found yet' })
    pick.onchange = () => {
      const v = voiceCache.find((x) => x.id === pick.value)
      // Three fields, because a voiceURI is machine-specific: carried to
      // another computer it matches nothing, and the name and language are
      // what let it find the nearest thing there instead of silently
      // falling back to whatever happens to be first.
      save({ systemVoice: pick.value, systemVoiceName: v?.name ?? null, systemVoiceLang: v?.lang ?? null })
    }
    l.append(pick)
    fields.append(l)

    const r = el('label', '')
    r.append(document.createTextNode('Speed'))
    const rate = document.createElement('input')
    rate.type = 'number'
    rate.step = '0.1'
    rate.min = '0.5'
    rate.max = '2'
    rate.value = String(s.rate ?? 1)
    rate.onchange = () => save({ rate: Number(rate.value) || 1 })
    r.append(rate)
    fields.append(r)
    row.append(fields)

    const acts = el('div', 'prov-acts')
    const say = el('button', 'btn small', 'Hear it')
    say.onclick = async () => {
      try {
        await readAloud(sampleLineFor(resolveSystemVoice(voiceCache, load())?.lang))
      } catch (err) {
        status(err.message, 'error')
      }
    }
    acts.append(say)
    // Only the voices that really are on this computer are offered. Some
    // browsers ship voices they synthesise over the network at their maker's
    // servers, and those do not belong in a row badged "in this browser" —
    // named as a count rather than a company, because which company it is
    // depends on which browser you happen to be reading this in.
    const remote = voiceCache.length - local.length
    acts.append(
      el(
        'span',
        'prov-result',
        `${local.length} voices in ${langs.length} language${langs.length === 1 ? '' : 's'}` +
          (remote ? ` · ${remote} more hidden: your browser makes those over the network` : ''),
      ),
    )
    row.append(acts)
    return row
  }

  /* --------------------------------------------------------------- tests */

  /** Does Chrome's local-network permission apply to this page and host? */
  const lnaApplies = (host) => {
    try {
      return !!isSecureContext && SPEECH.hostKind(location.hostname) === 'public' && SPEECH.hostKind(host) !== 'public'
    } catch {
      return false
    }
  }

  async function runTest(kind, p, button) {
    const out = $(`provResult-${p.id}`)
    button.disabled = true
    out.textContent = 'trying…'
    out.classList.remove('bad')
    hideDiag(p.id)
    try {
      if (kind === 'stt') {
        // A second of silence is a real file and a real round trip, and costs
        // a fraction of a penny at the worst provider's rate.
        const doc = await SPEECH.transcribe(p.id, allConfig(), { blob: silentWav(1), filename: 'test.wav', durationMs: 1000 })
        const n = doc?.segments?.length ?? 0
        showSuccess(p, `it answered${n ? ` with ${n} line(s)` : ''}. Working.`)
      } else {
        // A line the voice can say: in the chosen language, else the voice's own.
        const conf = configFor(p.id)
        const voice = voicesFor(p.id).find((v) => v.id === conf.voice)
        const lang = baseLang(conf.language && conf.language !== 'auto' ? conf.language : (voice?.lang ?? ''))
        const line = TEST_LINES[lang] ?? TEST_LINES.en
        const blob = await SPEECH.speak(p.id, allConfig(), { text: line, onProgress: (x) => x.label && say(p.id, x.label) })
        showSuccess(p, `it answered with ${(blob.size / 1024).toFixed(0)} KB of audio. Working.`)
        new Audio(URL.createObjectURL(blob)).play().catch(() => {})
      }
    } catch (err) {
      showFailure(p, err)
    } finally {
      button.disabled = false
    }
  }

  /**
   * What the computer's own voice says when asked to be heard: a line in its
   * language, because a Spanish voice reading an English sentence sounds
   * broken, and that is precisely the moment someone is judging it.
   */
  const SAMPLE_LINES = {
    en: 'This is how a line of narration will sound.',
    es: 'Así sonará una línea de narración.',
    pt: 'É assim que uma linha de narração vai soar.',
    fr: 'Voici comment sonnera une ligne de narration.',
    de: 'So wird eine Zeile der Erzählung klingen.',
    it: 'Ecco come suonerà una riga di narrazione.',
    nl: 'Zo klinkt een regel voice-over.',
    ca: 'Així sonarà una línia de narració.',
    ja: 'ナレーションはこのように聞こえます。',
    zh: '旁白听起来会是这样。',
    ko: '내레이션은 이렇게 들립니다.',
    hi: 'वर्णन की एक पंक्ति ऐसी सुनाई देगी।',
    ar: 'هكذا سيبدو سطر من التعليق الصوتي.',
    ru: 'Вот как будет звучать строка закадрового текста.',
    tr: 'Bir seslendirme satırı böyle duyulacak.',
    pl: 'Tak będzie brzmiała linia narracji.',
    sv: 'Så här kommer en rad berättarröst att låta.',
  }
  const sampleLineFor = (lang) => SAMPLE_LINES[baseLang(lang || '')] ?? SAMPLE_LINES.en

  /** One short line per language, so the test says something the voice can say. */
  const TEST_LINES = {
    en: 'Klipvia is connected.',
    es: 'Klipvia está conectado.',
    de: 'Klipvia ist verbunden.',
    fr: 'Klipvia est connecté.',
    it: 'Klipvia è collegato.',
    nl: 'Klipvia is verbonden.',
    pt: 'Klipvia está conectado.',
    ja: 'Klipvia が接続されました。',
    zh: 'Klipvia 已连接。',
    ko: 'Klipvia가 연결되었습니다.',
    hi: 'Klipvia जुड़ गया है।',
  }

  function showSuccess(p, text) {
    say(p.id, text)
    const conf = configFor(p.id)
    if (p.where !== 'machine') return
    let host = ''
    try {
      host = new URL(SPEECH.normaliseBase(conf.base ?? '')).hostname
    } catch {
      /* unknown host: no checklist */
    }
    const diag = $(`provDiag-${p.id}`)
    if (!diag) return
    diag.replaceChildren(checklist({ reachable: true, allows: true, lnaApplies: lnaApplies(host), permission: 'granted' }))
    diag.hidden = false
  }

  /**
   * A failure to reach a server is shown as what was found — three checks and
   * the steps that fix it — rather than as a sentence to decode.
   */
  function showFailure(p, err) {
    say(p.id, err.message, true)
    const diag = $(`provDiag-${p.id}`)
    if (!diag) return
    if (!err?.diagnosis) {
      diag.hidden = true
      return
    }
    diag.replaceChildren(checklist(err.diagnosis))
    if (err.remedy?.length) diag.append(remedyBlock(err.remedy))
    diag.hidden = false
  }

  function hideDiag(id) {
    const diag = $(`provDiag-${id}`)
    if (diag) {
      diag.hidden = true
      diag.replaceChildren()
    }
  }

  function checklist(d) {
    const ul = el('ul', 'diag-checks')
    const item = (state, label) => {
      const li = el('li', `chk ${state}`)
      li.append(icon(state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'minus', { size: 12 }), document.createTextNode(label))
      ul.append(li)
    }
    item(d.reachable ? 'ok' : 'bad', 'Reachable')
    item(d.allows === true ? 'ok' : d.allows === false ? 'bad' : 'na', 'Allows this page')
    item(
      !d.lnaApplies ? 'na' : d.permission === 'granted' ? 'ok' : d.permission === 'denied' ? 'bad' : 'na',
      !d.lnaApplies ? 'Local network permission: not needed here' : `Local network permission: ${d.permission ?? 'unknown'}`,
    )
    return ul
  }

  function remedyBlock(remedy) {
    const box = el('div', 'remedy')
    const byOs = remedy.filter((s) => s.os)
    const plain = remedy.filter((s) => !s.os)
    if (byOs.length) {
      box.append(remedySection(byOs[0]))
      if (byOs.length > 1) {
        const more = el('details', 'remedy-more')
        more.append(el('summary', '', 'Other systems'))
        for (const s of byOs.slice(1)) more.append(remedySection(s))
        box.append(more)
      }
    }
    for (const s of plain) box.append(remedySection(s))
    return box
  }

  function remedySection(s) {
    const wrap = el('div', 'remedy-sec')
    if (s.os) wrap.append(el('div', 'remedy-os', s.os))
    for (const step of s.steps ?? []) {
      if (step.text) wrap.append(el('p', 'remedy-step', step.text))
      if (step.command) wrap.append(commandLine(step.command))
    }
    return wrap
  }

  /** A command with a copy button. Every command shown is exact and complete. */
  function commandLine(cmd) {
    const row = el('div', 'cmd')
    row.append(el('code', '', cmd))
    const btn = el('button', 'btn small ghost cmd-copy', 'Copy')
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(cmd)
        btn.textContent = 'Copied'
      } catch {
        btn.textContent = 'Select it and copy'
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1400)
    }
    row.append(btn)
    return row
  }

  /* -------------------------------------------------------------- voices */

  /** Loads in flight and loads that failed, by what they were for. */
  const loading = new Map()
  const failed = new Map()
  const timers = {}

  function maybeLoadVoices(p) {
    const fp = voiceFingerprint(p.id)
    const conf = configFor(p.id)
    if (conf.voiceListFor === fp && conf.voiceList?.length) return
    if (loading.get(p.id) === fp || failed.get(p.id) === fp) return
    loading.set(p.id, fp)
    clearTimeout(timers[p.id])
    timers[p.id] = setTimeout(() => loadRemoteVoices(p, null, fp), 350)
  }

  async function loadRemoteVoices(p, button, fp = voiceFingerprint(p.id)) {
    if (button) button.disabled = true
    say(p.id, 'asking for its voices…')
    try {
      const list = await refreshVoices(p.id)
      failed.delete(p.id)
      // The message goes on after the redraw, not before it. Setting it first
      // and then calling render() wrote it onto an element that was about to be
      // replaced — the voices arrived, were saved, and the panel said nothing.
      render()
      const langs = languagesIn(list)
      say(p.id, list.length ? `${list.length} voice${list.length === 1 ? '' : 's'} in ${langs.length} language${langs.length === 1 ? '' : 's'}` : 'no voices saved in it yet')
    } catch (err) {
      failed.set(p.id, fp)
      if (loading.get(p.id) === fp) loading.delete(p.id)
      render()
      showFailure(p, err)
    } finally {
      if (loading.get(p.id) === fp) loading.delete(p.id)
      if (button) button.disabled = false
    }
  }

  /** Put a line under a provider's buttons, on whichever element is there now. */
  function say(providerId, text, bad = false) {
    const el = $(`provResult-${providerId}`)
    if (!el) return
    el.textContent = text
    el.classList.toggle('bad', bad)
  }

  /* -------------------------------------------------- adding a voicebox voice */

  /** Presets fetched once per address, so opening the panel twice is free. */
  const presetCache = new Map()

  /**
   * Two ways to a new VoiceBox voice, in one panel: one of its built-in
   * voices saved as a profile, or a recording from the library cloned. Both
   * end up in the picker above, selected.
   */
  function voiceAddPanel(p) {
    const panel = el('div', 'voice-add')
    const conf = configFor(p.id)
    const note = el('p', 'prov-result')
    note.id = `provAddResult-${p.id}`

    /* --- presets --- */
    const presets = el('div', 'settings')
    const pl = el('label', 'wide')
    pl.append(document.createTextNode('Built-in voice'))
    const presetPick = document.createElement('select')
    presetPick.append(option('', 'loading…'))
    presetPick.disabled = true
    pl.append(presetPick)
    const nl = el('label', 'wide')
    nl.append(document.createTextNode('Save it as'))
    const presetName = document.createElement('input')
    presetName.type = 'text'
    presetName.spellcheck = false
    presetName.placeholder = 'a name for the profile'
    nl.append(presetName)
    presets.append(pl, nl)
    const addBtn = el('button', 'btn small', 'Add this voice')
    addBtn.disabled = true
    const presetActs = el('div', 'prov-acts')
    presetActs.append(addBtn)
    panel.append(el('h5', 'voice-add-title', 'A built-in voice'), presets, presetActs)

    let presetList = []
    const showPresets = (list) => {
      presetList = list
      fillVoicePick(presetPick, list, { first: conf.language, empty: 'VoiceBox has no presets to offer' })
      addBtn.disabled = !list.length
      const cur = list.find((v) => v.id === presetPick.value)
      if (cur && !presetName.value) presetName.value = cur.name
    }
    presetPick.onchange = () => {
      const cur = presetList.find((v) => v.id === presetPick.value)
      if (cur) presetName.value = cur.name
    }
    const key = SPEECH.plainBase(conf.base)
    if (presetCache.has(key)) showPresets(presetCache.get(key))
    else {
      SPEECH.listPresets({ base: conf.base })
        .then((list) => {
          presetCache.set(key, list)
          showPresets(list)
        })
        .catch((err) => {
          presetPick.replaceChildren(option('', 'could not list them'))
          note.textContent = err.message
          note.classList.add('bad')
        })
    }
    addBtn.onclick = async () => {
      const cur = presetList.find((v) => v.id === presetPick.value)
      if (!cur) return
      addBtn.disabled = true
      note.classList.remove('bad')
      note.textContent = `adding ${cur.name}…`
      try {
        const v = await addPresetVoice({ engine: cur.engine, voiceId: cur.id, name: presetName.value.trim() || cur.name, language: cur.lang })
        addOpen.delete(p.id)
        render()
        say(p.id, `“${v.name}” added and selected (${languageName(v.lang)}).`)
      } catch (err) {
        note.textContent = err.message
        note.classList.add('bad')
        addBtn.disabled = false
      }
    }

    /* --- clone --- */
    const media = [...(mediaWithSound() ?? [])]
    if (media.length) {
      const clone = el('div', 'settings')
      const ml = el('label', 'wide')
      ml.append(document.createTextNode('Recording'))
      const mediaPick = document.createElement('select')
      for (const m of media) mediaPick.append(option(m.filename, `${m.name} · ${(m.durationMs / 1000).toFixed(1)}s`))
      ml.append(mediaPick)
      const cn = el('label', '')
      cn.append(document.createTextNode('Name'))
      const cloneName = document.createElement('input')
      cloneName.type = 'text'
      cloneName.spellcheck = false
      cloneName.placeholder = 'whose voice it is'
      cn.append(cloneName)
      const cl = el('label', '')
      cl.append(document.createTextNode('Language'))
      const cloneLang = document.createElement('select')
      for (const l of p.languages ?? []) cloneLang.append(option(l, languageName(l)))
      cloneLang.value = (p.languages ?? []).includes(baseLang(conf.language ?? '')) ? baseLang(conf.language) : 'es'
      cl.append(cloneLang)
      const tl = el('label', 'wide')
      tl.dataset.tip = 'VoiceBox needs the words to line the voice up with the sound. A transcript of the recording fills this in.'
      tl.append(document.createTextNode('What is said in it'))
      const refText = document.createElement('textarea')
      refText.className = 'voice-ref'
      refText.rows = 3
      refText.placeholder = 'The exact words spoken in the recording'
      tl.append(refText)
      clone.append(ml, cn, cl, tl)
      const cloneBtn = el('button', 'btn small', 'Clone this recording')
      const cloneActs = el('div', 'prov-acts')
      cloneActs.append(cloneBtn)
      panel.append(el('h5', 'voice-add-title', 'Or clone a recording from your library'), clone, cloneActs)

      const prefill = async () => {
        const wanted = mediaPick.value
        refText.value = ''
        const text = await transcriptTextFor(wanted)
        // Only if the recording is still the one asked about.
        if (text && mediaPick.value === wanted) refText.value = text
      }
      mediaPick.onchange = prefill
      prefill()

      cloneBtn.onclick = async () => {
        if (!cloneName.value.trim()) return (note.textContent = 'give the voice a name')
        if (!refText.value.trim()) return (note.textContent = 'write down what is said in the recording')
        cloneBtn.disabled = true
        note.classList.remove('bad')
        note.textContent = 'sending the recording to VoiceBox…'
        try {
          const v = await cloneVoice(mediaPick.value, {
            name: cloneName.value.trim(),
            language: cloneLang.value,
            referenceText: refText.value.trim(),
            local: isLocal(),
          })
          addOpen.delete(p.id)
          render()
          say(p.id, `“${v.name}” cloned and selected (${languageName(v.lang)}).`)
        } catch (err) {
          note.textContent = err.message
          note.classList.add('bad')
          cloneBtn.disabled = false
        }
      }
    }

    panel.append(note)
    return panel
  }

  /** The words of a recording, from its transcript, when there is one. */
  async function transcriptTextFor(filename) {
    try {
      const rows = await (await fetch('/api/transcripts')).json()
      const row = (Array.isArray(rows) ? rows : []).find((t) => t.mediaFilename === filename)
      if (!row) return ''
      const t = await (await fetch(`/api/transcripts/${encodeURIComponent(row.id)}`)).json()
      return (t.cues ?? []).map((c) => c.text).filter(Boolean).join(' ').trim()
    } catch {
      return ''
    }
  }

  /** One second of silence, as a real WAV, for testing a connection. */
  function silentWav(seconds) {
    const rate = 16000
    const n = rate * seconds
    const buf = new ArrayBuffer(44 + n * 2)
    const v = new DataView(buf)
    const tag = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
    tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE')
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    tag(36, 'data'); v.setUint32(40, n * 2, true)
    return new Blob([buf], { type: 'audio/wav' })
  }

  /* -------------------------------------------------------------- render */

  function render() {
    const s = load()
    const chosen = tab === 'stt' ? s.stt : s.tts
    body.replaceChildren()

    $('speechIntro').textContent = 'Where audio is listened to and where voices come from. Each row says where the sound goes.'

    for (const p of providersFor(tab)) {
      body.append(p.id === 'system' ? systemRow(chosen === 'system') : providerRow(tab, p, chosen === p.id))
    }

    // Only worth showing once something could actually be sent.
    const anyLeaves = ['stt', 'tts'].some((k) => {
      const id = s[k]
      const p = k === 'stt' ? SPEECH.sttProvider(id) : SPEECH.ttsProvider(id)
      return p && SPEECH.actualWhere(p, configFor(p.id)).id === 'provider'
    })
    if (anyLeaves) {
      const gate = el('label', 'egress-gate')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = !!s.agentMayEgress
      box.onchange = () => save({ agentMayEgress: box.checked })
      gate.append(
        box,
        el('span', '', 'Let an AI agent send audio out on its own'),
        el(
          'span',
          'prov-note',
          'Off by default. You choosing a provider is not the same as a model deciding to upload to one, possibly on words it read in your own footage.',
        ),
      )
      body.append(gate)
    }

    const keys = providersWithKeys()
    $('btnSpeechForget').hidden = !keys.length
    // The record beats the promise: once anything has actually been sent, say
    // what and to whom rather than repeating what would happen.
    $('speechNote').textContent = sendLog().length
      ? egressSummary()
      : keys.length
        ? `${keys.length} key${keys.length === 1 ? '' : 's'} kept in this browser only, never in a project file.`
        : 'Nothing is sent anywhere until you pick something that sends it.'

    for (const b of dlg.querySelectorAll('[data-speech-tab]')) b.classList.toggle('active', b.dataset.speechTab === tab)
    renderFoot()
  }

  /* ---------------------------------------------------------------- foot */

  /**
   * The Speech rail's foot: one line per job naming the provider and where
   * the sound goes. It never folds, because it is the privacy record in the
   * one place somebody looks before pressing either button.
   */
  function badge(w) {
    return el('span', `where where-${w.id}`, w.label)
  }

  function renderFoot() {
    const s = load()
    const stt = $('speechFootStt')
    const tts = $('speechFootTts')
    if (!stt || !tts) return
    const line = (node, job, p, fallback) => {
      node.replaceChildren(el('span', 'job', `${job}:`))
      if (!p) {
        if (fallback) node.append(el('span', 'who', fallback.text), badge(fallback.where))
        else node.append(icon('mic-off', { size: 12 }), el('span', 'unset', 'not set up'))
        return
      }
      node.append(el('span', 'who', p.label))
      const ready = readiness(p, { local: isLocal() })
      node.append(ready.ok ? badge(where(p)) : el('span', 'unset', `· ${ready.why}`))
    }
    line(stt, 'Transcribe', s.stt ? SPEECH.sttProvider(s.stt) : null, null)
    const tp = s.tts ? SPEECH.ttsProvider(s.tts) : null
    if (tp?.id === 'system' || !tp) line(tts, 'Voice', null, { text: 'this computer', where: SPEECH.WHERE.browser })
    else line(tts, 'Voice', tp, null)
  }

  /** "VoiceBox · on your machine", or null when nothing is set for that job. */
  function whereLine(kind) {
    const s = load()
    const p = kind === 'stt' ? (s.stt ? SPEECH.sttProvider(s.stt) : null) : s.tts ? SPEECH.ttsProvider(s.tts) : null
    if (!p || !readiness(p, { local: isLocal() }).ok) return null
    return `${p.label} · ${where(p).label}`
  }

  /** A badge element follows a choice: text, tone, and hidden when there is none. */
  function setBadge(node, w) {
    if (!node) return
    node.classList.remove('where-browser', 'where-machine', 'where-provider')
    node.textContent = w ? w.label : ''
    if (w) node.classList.add(`where-${w.id}`)
    node.hidden = !w
  }

  /** "0:02.20", the way the inspector writes a time. */
  const fmtAt = (ms) => {
    const sec = Math.max(0, ms) / 1000
    const m = Math.floor(sec / 60)
    return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`
  }

  /* -------------------------------------------------------- transcribing */

  /**
   * The Transcribe window: a clip in, an editable transcript out.
   *
   * The first line is the sentence of what will happen and where the sound
   * goes; the Where select is the same choice as under Providers, offered here
   * so nobody has to visit settings to start. A job that takes minutes and
   * sends somebody's audio somewhere is watched while it runs and stopped
   * when it should be; closing the window does not stop it, because a
   * window closed by accident should not cost a ten-minute upload.
   */
  const trDlg = $('dlgTranscribe')
  let trAbort = null
  let trLast = null
  /** Null when the window can run a job; a reason when it cannot. */
  let trBlocked = null
  /** The job in flight, if any: { filename, name }. */
  let trJob = null

  const readyStt = () => providersFor('stt').filter((p) => readiness(p, { local: isLocal() }).ok)

  /** The provider chosen in the window, or null when none is ready. */
  function trProvider() {
    const v = $('trProvider').value
    return v && v !== '__setup' ? SPEECH.sttProvider(v) : null
  }

  function fillTrProvider() {
    const pick = $('trProvider')
    const s = load()
    const ready = readyStt()
    pick.replaceChildren()
    // The badge beside the select says where; the option is just the name.
    for (const p of ready) pick.append(option(p.id, p.label))
    if (!ready.length) {
      const none = option('', 'nothing set up yet')
      none.disabled = true
      pick.append(none)
    }
    pick.append(option('__setup', ready.length ? 'Set up another…' : 'Set up a provider…'))
    pick.value = s.stt && ready.some((p) => p.id === s.stt) ? s.stt : (ready[0]?.id ?? '')
    return trProvider()
  }

  function trRunning(on) {
    $('trProgress').hidden = !on
    $('btnTrStop').hidden = !on
    $('trSource').disabled = on
    $('trProvider').disabled = on
    $('trLang').disabled = on
  }

  /** Everything that follows from the clip and the provider chosen. */
  function trSync() {
    const list = [...(mediaWithSound() ?? [])]
    const p = trProvider()
    const w = p ? where(p) : null
    const m = mediaFor($('trSource').value)
    trBlocked = !list.length ? 'nomedia' : !p ? 'unset' : null
    setBadge($('trWhereBadge'), w)
    setBadge($('trFootWhere'), w)
    $('trHint').textContent =
      trBlocked === 'nomedia'
        ? 'Nothing in Media has sound yet. Import a clip, or write a voice-over first.'
        : trBlocked === 'unset'
          ? 'Nothing can listen yet. Choose where the audio goes: your own machine, or a provider.'
          : `Listens to ${m?.name ?? 'the clip'} with ${p.label} (${w.label}) and writes down what is said. ` +
            'The words come back as a transcript you can edit and place as captions.'
    const run = $('btnTrRun')
    run.textContent = trBlocked === 'nomedia' ? 'Import media…' : trBlocked === 'unset' ? 'Set up a provider…' : 'Transcribe'
    run.dataset.tip =
      trBlocked === 'nomedia'
        ? 'Choose a video or audio file to import.'
        : trBlocked === 'unset'
          ? 'Open Providers on the Transcribe tab, then come back here.'
          : `Listen to the clip with ${p.label} and write down what is said.`
    run.disabled = !!trJob
  }

  /** The language chosen in the transcribe window: a code, or null for auto. */
  function trLanguage() {
    const v = $('trLang').value
    if (v === 'other') return normaliseLang($('trLangOther').value) || null
    return v === 'auto' ? null : v
  }

  function fillTrLang(p) {
    const pick = $('trLang')
    pick.replaceChildren()
    pick.append(option('auto', 'Auto (let it guess)'))
    const declared = (p?.languages ?? []).filter((l) => l !== '*')
    const codes = [...new Set([...(declared.length ? declared : COMMON_LANGUAGES), ...COMMON_LANGUAGES])]
    for (const l of codes) pick.append(option(l, languageName(l)))
    pick.append(option('other', 'Other…'))
    const saved = p ? configFor(p.id).language : null
    const code = saved ? baseLang(saved) : null
    if (code && codes.includes(code)) pick.value = code
    else if (code) {
      pick.value = 'other'
      $('trLangOther').value = code
    } else pick.value = 'auto'
    $('trLangOther').hidden = pick.value !== 'other'
  }

  $('trLang').onchange = () => {
    $('trLangOther').hidden = $('trLang').value !== 'other'
    if ($('trLang').value === 'other') $('trLangOther').focus()
  }

  async function openTranscribe(filename = null) {
    const list = [...(mediaWithSound() ?? [])]
    const pick = $('trSource')
    pick.replaceChildren()
    for (const m of list) pick.append(option(m.filename, `${m.name} · ${(m.durationMs / 1000).toFixed(1)}s`))
    if (filename && list.some((m) => m.filename === filename)) pick.value = filename
    else if (trJob && list.some((m) => m.filename === trJob.filename)) pick.value = trJob.filename

    const p = fillTrProvider()
    fillTrLang(p)
    if (!trJob) {
      $('btnTrPlace').hidden = true
      $('trResult').textContent = ''
      $('trResult').classList.remove('error')
    }
    trRunning(!!trJob)
    trSync()
    if (!trDlg.open) trDlg.showModal()
  }

  $('trSource').onchange = trSync
  $('trProvider').onchange = () => {
    const v = $('trProvider').value
    if (v === '__setup') {
      // Never two modal windows at once: this one goes, Providers opens on
      // the Transcribe tab, and this one comes back when that closes.
      const back = $('trSource').value || null
      trDlg.close()
      open('stt', { returnTo: () => openTranscribe(back) })
      return
    }
    save({ stt: v })
    fillTrLang(SPEECH.sttProvider(v))
    renderFoot()
    trSync()
  }

  // Cancel stops a running job. Esc, or anything else that closes the
  // window, leaves it running: the result lands in Transcripts either way.
  $('btnTrClose').onclick = () => {
    if (trJob) trAbort?.abort()
    trDlg.close()
  }
  trDlg.addEventListener('close', () => {
    if (trJob && !trAbort?.signal.aborted) status(`still transcribing "${trJob.name}". The words will land in Transcripts.`)
  })
  $('btnTrStop').onclick = () => {
    trAbort?.abort()
    $('trStep').textContent = 'stopping…'
  }
  $('btnTrRun').onclick = async () => {
    if (trBlocked === 'nomedia') {
      trDlg.close()
      $('mediaInput')?.click()
      status('import a clip with sound, then press Transcribe again')
      return
    }
    if (trBlocked === 'unset') {
      const back = $('trSource').value || null
      trDlg.close()
      open('stt', { returnTo: () => openTranscribe(back) })
      return
    }
    const filename = $('trSource').value
    const p = trProvider()
    if (!filename || !p || trJob) return
    const out = $('trResult')
    out.textContent = ''
    out.classList.remove('error')
    $('btnTrPlace').hidden = true
    trAbort = new AbortController()
    const media = mediaFor(filename)
    trJob = { filename, name: media?.name ?? filename }
    trRunning(true)
    trSync()
    $('trStep').textContent = 'starting…'
    const language = trLanguage()
    // The choice in this window is the choice: saved before the job so
    // transcribeMedia() and the foot agree. The language is remembered per
    // provider, so the next file in the same language needs no choosing;
    // passed explicitly too, because "auto" must mean auto now.
    save({ stt: p.id })
    setProviderConfig(p.id, { language })
    renderFoot()
    try {
      const t = await transcribeMedia(filename, {
        local: isLocal(),
        media,
        language: language ?? 'auto',
        signal: trAbort.signal,
        onProgress: (x) => x.label && ($('trStep').textContent = x.label),
      })
      trLast = t
      await refreshLibrary()
      const n = t.cueCount ?? t.cues?.length ?? 0
      const line = `${n} line${n === 1 ? '' : 's'}${t.wordLevel ? ', with word timings' : ''}. "${t.name}" is in Transcripts.`
      out.textContent = line
      $('btnTrPlace').hidden = false
      status(trDlg.open ? `transcribed "${trJob.name}"` : `transcribed "${trJob.name}": ${line}`)
    } catch (err) {
      // Stopping is a choice, not a failure, and should not be dressed as one.
      const stopped = err?.name === 'AbortError'
      out.textContent = stopped ? 'Stopped. Nothing was kept.' : err.message
      out.classList.toggle('error', !stopped)
      if (!trDlg.open && !stopped) status(`could not transcribe "${trJob.name}": ${err.message}`, 'error')
    } finally {
      trJob = null
      trAbort = null
      trRunning(false)
      trSync()
    }
  }
  $('btnTrPlace').onclick = () => {
    if (!trLast) return
    insertTranscript(trLast.id)
    trDlg.close()
    status('captions placed at the playhead')
  }

  /* --------------------------------------------------------- voice-over */

  /**
   * The Voice-over window: a script in, an audio file on the timeline out.
   *
   * "Voice from" is the same choice as under Providers, with the computer's
   * own voices first because they are free and already here; those can be
   * heard and timed but not recorded, and the window says so instead of
   * producing a silent file. `atMs` is where the audio lands when the window
   * was opened from an item; otherwise the playhead.
   */
  const voiceDlg = $('dlgVoice')
  let voOpts = { atMs: null, name: null }

  const readyTts = () => providersFor('tts').filter((p) => p.id === 'system' || readiness(p, { local: isLocal() }).ok)

  function voProvider() {
    const v = $('voiceProvider').value
    return (v && v !== '__setup' ? SPEECH.ttsProvider(v) : null) ?? SPEECH.ttsProvider('system')
  }

  function fillVoiceProvider() {
    const pick = $('voiceProvider')
    const s = load()
    const ready = readyTts()
    pick.replaceChildren()
    for (const p of ready) {
      pick.append(option(p.id, p.id === 'system' ? 'This computer (plays only)' : p.label))
    }
    pick.append(option('__setup', 'Set up another…'))
    pick.value = s.tts && ready.some((p) => p.id === s.tts) ? s.tts : 'system'
  }

  /** What the window will do, in one sentence: who reads it, where, and where it lands. */
  function voiceOverHint(provider, canRecord) {
    const landing = voOpts.atMs != null ? `${fmtAt(voOpts.atMs)}, where the item starts` : 'the playhead'
    if (!canRecord) {
      return (
        'Your computer reads this aloud here, in this browser, and can time it. ' +
        'To put it on the timeline, choose VoiceBox or a provider under Voice from.'
      )
    }
    const list = voicesFor(provider.id)
    const v = list.find((x) => x.id === $('voicePick').value)
    const lang = $('voiceLang').value
    const langText = lang && lang !== 'auto' ? languageName(lang) : v?.lang && v.lang !== '*' ? languageName(v.lang) : null
    const who = v ? `"${v.name}"` : 'its default voice'
    return (
      `${provider.label} reads this with ${who}${langText ? ` in ${langText}` : ''} (${where(provider).label}). ` +
      `The recording goes to Media and onto an audio track at ${landing}.`
    )
  }

  /** Everything that follows from the provider chosen in the window. */
  function voSync() {
    const provider = voProvider()
    const system = provider.id === 'system'
    const canRecord = !system && !!provider.speak && readiness(provider, { local: isLocal() }).ok
    const w = system ? SPEECH.WHERE.browser : where(provider)
    setBadge($('voiceWhereBadge'), w)
    setBadge($('voiceFootWhere'), w)

    const pick = $('voicePick')
    const lang = $('voiceLang')
    if (canRecord) {
      const conf = configFor(provider.id)
      const list = voicesFor(provider.id)
      fillVoicePick(pick, list, { chosen: conf.voice ?? null, first: conf.language, empty: 'the provider’s default' })
      fillLangPick(lang, { provider, list, chosen: conf.language ?? null })
      pick.onchange = () => {
        const v = list.find((x) => x.id === pick.value)
        setProviderConfig(provider.id, { voice: pick.value, ...(provider.oneLanguageVoices && v?.lang && v.lang !== '*' ? { language: baseLang(v.lang) } : {}) })
        if (provider.oneLanguageVoices && v?.lang && v.lang !== '*') lang.value = baseLang(v.lang)
        $('voiceHint').textContent = voiceOverHint(provider, true)
      }
      lang.onchange = () => {
        const language = lang.value === 'auto' ? null : lang.value
        const voice = SPEECH.resolveVoice(provider, { voice: pick.value || null, language, list })
        setProviderConfig(provider.id, { language, ...(voice ? { voice } : {}) })
        if (voice && voice !== pick.value) pick.value = voice
        $('voiceHint').textContent = voiceOverHint(provider, true)
      }
    } else {
      pick.replaceChildren(option('', 'your computer’s voice'))
      pick.disabled = true
      lang.replaceChildren(option('auto', 'the voice’s own'))
      lang.disabled = true
      pick.onchange = lang.onchange = null
    }

    $('voiceSystemNote').hidden = canRecord
    const make = $('btnVoiceMake')
    make.textContent = canRecord ? 'Add to timeline' : 'Choose a voice…'
    make.dataset.tip = canRecord
      ? `Record it with ${provider.label}, add it to Media and drop it on an audio track at ${voOpts.atMs != null ? fmtAt(voOpts.atMs) : 'the playhead'}.`
      : 'Open Providers on the Voice-over tab and pick a voice that returns a file.'
    make.disabled = false
    $('btnVoiceRead').dataset.tip = canRecord
      ? `Say it with the voice chosen above and play it here. Nothing is added to Media.`
      : "Read it aloud with your computer's own voice, to hear the wording. Nothing is recorded or sent."
    $('voiceHint').textContent = voiceOverHint(provider, canRecord)
  }

  async function openVoiceOver(prefill = '', { atMs = null, name = null } = {}) {
    stopPreview()
    dropPreviewCache()
    voOpts = { atMs, name }
    $('voiceScript').value = prefill || $('voiceScript').value
    if (name) $('voiceName').value = name
    $('voiceResult').textContent = ''
    $('voiceResult').classList.remove('error')
    $('voiceMeta').textContent = ''
    fillVoiceProvider()
    voSync()
    if (!voiceDlg.open) voiceDlg.showModal()
  }

  const script = () => $('voiceScript').value.trim()
  const voiceChoice = () => ($('voicePick').disabled ? null : $('voicePick').value || null)
  const langChoice = () => ($('voiceLang').disabled || $('voiceLang').value === 'auto' ? null : $('voiceLang').value)

  $('voiceProvider').onchange = () => {
    const v = $('voiceProvider').value
    if (v === '__setup') {
      const back = { ...voOpts }
      voiceDlg.close()
      open('tts', { returnTo: () => openVoiceOver('', back) })
      return
    }
    save({ tts: v })
    renderFoot()
    voSync()
  }

  $('btnVoiceClose').onclick = () => {
    stopPreview()
    dropPreviewCache()
    voiceDlg.close()
  }
  /**
   * Hearing it in the voice you picked.
   *
   * It reads with whatever is selected above, and falls back to the system
   * voice only when that is what is selected — a preview that ignores the
   * choice being previewed is worse than no preview.
   */
  let previewAudio = null
  /** The last thing generated for a preview, so the same line is not paid for twice. */
  let previewCache = null

  function stopPreview() {
    stopReading()
    const el = $('voicePreview')
    if (el) {
      el.pause()
      el.hidden = true
      el.removeAttribute('src')
      el.load()
    }
    previewAudio = null
  }

  function dropPreviewCache() {
    if (previewCache) URL.revokeObjectURL(previewCache.url)
    previewCache = null
  }

  $('btnVoiceRead').onclick = async () => {
    if (!script()) return
    const btn = $('btnVoiceRead')
    stopPreview()
    const provider = voProvider()
    const usable = provider.id !== 'system' && provider.speak && readiness(provider, { local: isLocal() }).ok

    if (!usable) {
      try {
        await readAloud(script())
      } catch (err) {
        status(err.message, 'error')
      }
      return
    }

    const meta = $('voiceMeta')
    const key = `${provider.id}|${voiceChoice()}|${langChoice()}|${script()}`
    btn.disabled = true
    try {
      if (previewCache?.key !== key) {
        meta.textContent = `asking ${provider.label}…`
        const blob = await SPEECH.speak(provider.id, allConfig(), {
          text: script(),
          voice: voiceChoice(),
          language: langChoice(),
          onProgress: (p) => p.label && (meta.textContent = p.label),
        })
        recordSend({
          provider: provider.label,
          host: SPEECH.hostOf(provider, configFor(provider.id)),
          job: 'voice preview',
          name: 'preview',
          chars: script().length,
        })
        // Played, not kept: a preview that quietly filled the media library
        // with half-finished takes would be its own kind of mess. Held only
        // until the line or the voice changes, so pressing it twice does not
        // ask a paid voice to say the same sentence again.
        dropPreviewCache()
        previewCache = { key, url: URL.createObjectURL(blob), seconds: null }
      }
      // Shown before it is started. A browser will not always begin audio on
      // its own — after a generation that took a few seconds it often decides
      // the click has gone stale — and a visible transport turns that from an
      // explanation into a play button.
      previewAudio = $('voicePreview')
      previewAudio.src = previewCache.url
      previewAudio.hidden = false
      meta.textContent = ''
      // Started, not waited on. `play()` settles when playback actually
      // begins, which may be never — a browser will not load media in a tab it
      // considers hidden, and it does not error, it simply never becomes
      // ready. Awaiting it left the button dead until the window was reopened.
      previewAudio.play().catch(() => {
        meta.textContent = 'ready: press play'
      })
    } catch (err) {
      meta.textContent = err.message
    } finally {
      btn.disabled = false
    }
  }
  $('btnVoiceTime').onclick = async () => {
    if (!script()) return
    $('voiceMeta').textContent = 'timing it…'
    try {
      const doc = await timeScript(script())
      $('voiceMeta').textContent = doc.estimated
        ? `About ${doc.duration.toFixed(1)}s, counted rather than spoken. Click anywhere on the page and ask again for a real timing.`
        : `${doc.duration.toFixed(1)}s at this speed · ${doc.words.length} words timed. ` +
          `That is your computer's voice; a recorded one will differ a little.`
    } catch (err) {
      $('voiceMeta').textContent = err.message
    }
  }
  $('btnVoiceMake').onclick = async () => {
    const provider = voProvider()
    if (provider.id === 'system' || !provider.speak) {
      const back = { ...voOpts }
      voiceDlg.close()
      open('tts', { returnTo: () => openVoiceOver('', back) })
      return
    }
    if (!script()) return
    const out = $('voiceResult')
    out.classList.remove('error')
    out.textContent = 'recording…'
    $('btnVoiceMake').disabled = true
    try {
      save({ tts: provider.id })
      const m = await generateVoice(script(), {
        name: $('voiceName').value.trim() || null,
        voice: voiceChoice(),
        language: langChoice(),
        local: isLocal(),
        onProgress: (p) => (out.textContent = p.label ?? ''),
      })
      await refreshLibrary()
      insertMedia(m.filename, voOpts.atMs != null ? { atMs: voOpts.atMs } : undefined)
      const at = voOpts.atMs != null ? fmtAt(voOpts.atMs) : 'the playhead'
      out.textContent = `${m.name} · ${(m.durationMs / 1000).toFixed(1)}s, added at ${at}`
      status(`voice-over added: ${m.name}`)
    } catch (err) {
      out.textContent = err.message
      out.classList.add('error')
    } finally {
      $('btnVoiceMake').disabled = false
    }
  }

  /* ----------------------------------------------------------------- open */

  /** Where to go when Providers closes: the job window that sent us here. */
  let returnTo = null

  async function open(which = 'stt', { returnTo: back = null } = {}) {
    tab = which
    returnTo = back
    if (!voiceCache.length) voiceCache = await SPEECH.systemVoices()
    render()
    save({ introSeen: true })
    if (!dlg.open) dlg.showModal()
  }

  dlg.addEventListener('close', () => {
    renderFoot()
    const back = returnTo
    returnTo = null
    if (back) back()
  })

  $('btnSpeech').onclick = () => open(load().stt ? 'stt' : 'tts')
  $('btnSpeechClose').onclick = () => dlg.close()
  $('btnSpeechForget').onclick = () => {
    forgetAllKeys()
    render()
    status('API keys forgotten')
  }
  for (const b of dlg.querySelectorAll('[data-speech-tab]')) {
    b.onclick = () => {
      tab = b.dataset.speechTab
      render()
    }
  }

  // Voices arrive asynchronously in most browsers; fill the cache early so the
  // panel is never briefly empty.
  SPEECH.systemVoices().then((v) => {
    voiceCache = v
    if (dlg.open) render()
  })

  renderFoot()

  return {
    open,
    openVoiceOver,
    openTranscribe,
    renderFoot,
    whereLine,
    isReady: (kind) => {
      const s = load()
      const id = kind === 'stt' ? s.stt : s.tts
      const p = kind === 'stt' ? SPEECH.sttProvider(id) : SPEECH.ttsProvider(id)
      return !!p && readiness(p, { local: isLocal() }).ok
    },
  }
}
