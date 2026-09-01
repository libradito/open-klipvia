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

import * as SPEECH from '/speech.js'

const SETTINGS_KEY = 'klipvia:integrations'
const KEYS_KEY = 'klipvia:integrations.keys'
const LOG_KEY = 'klipvia:integrations.log'

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
  /** Per-provider config: base urls, model ids, chosen voice. Never keys. */
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
  const away = log.filter((e) => e.host && !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(e.host))
  if (!log.length) return 'Nothing has been sent anywhere from this browser.'
  if (!away.length) return `${log.length} job(s), all to a machine on your own network. Nothing has left it.`
  const hosts = [...new Set(away.map((e) => e.host))]
  return `${away.length} of ${log.length} job(s) went to ${hosts.join(', ')}.`
}

export function forgetAllKeys() {
  try {
    localStorage.removeItem(KEYS_KEY)
  } catch {
    /* nothing to remove */
  }
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

/* ------------------------------------------------------------------ tasks */

/** The bytes of a library file, whichever back end is holding them. */
async function mediaBlob(filename, { local }) {
  if (local) {
    const LOCAL = await import('/localstore.js')
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
 * their own timings.
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
 * drops onto an audio track like anything imported.
 */
export async function generateVoice(text, { name = null, voice = null, local = true, signal, onProgress } = {}) {
  const settings = load()
  if (!settings.tts) throw new Error('no voice set up yet')
  const provider = SPEECH.ttsProvider(settings.tts)
  if (provider && !provider.speak) {
    throw new Error(
      `${provider.label} can read a script aloud here, but a browser will not let a page record it. ` +
        `Pick a voice that returns a file to put narration in your video.`,
    )
  }

  const blob = await SPEECH.speak(settings.tts, allConfig(), { text, voice, signal, onProgress })
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

    // The one thing a person cannot debug for themselves.
    if (ready.blocked) {
      row.append(el('p', 'prov-warn', `${ready.why}. Run the Klipvia server to use it, or pick one above.`))
      return row
    }
    if (!chosen) return row

    const fields = el('div', 'settings')
    const conf = configFor(p.id)

    const field = (label, key, { type = 'text', placeholder = '', wide = false, options = null, value = null } = {}) => {
      const l = el('label', wide ? 'wide' : '')
      l.append(document.createTextNode(label))
      let input
      if (options) {
        input = document.createElement('select')
        for (const o of options) {
          const opt = document.createElement('option')
          opt.value = typeof o === 'string' ? o : o.id
          opt.textContent = typeof o === 'string' ? o : o.name
          input.append(opt)
        }
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
    if (kind === 'tts' && p.voices) field('Voice', 'voice', { options: p.voices })
    if (kind === 'tts' && p.formats) field('Format', 'format', { options: p.formats })
    row.append(fields)

    // Cross-origin advice is only advice when the page is the one calling.
    if (p.setupNote && !SPEECH.hasRelay()) row.append(el('p', 'prov-note', p.setupNote))
    if (p.setupNote && SPEECH.hasRelay()) {
      row.append(el('p', 'prov-note', 'Klipvia’s own server makes this call, so it needs nothing turned on at the other end.'))
    }
    // http:// to somewhere that is not this machine is readable by anything in
    // between, and nothing else on screen would tell you.
    if (w.id === 'provider' && /^http:\/\//i.test(SPEECH.normaliseBase(conf.base ?? ''))) {
      row.append(el('p', 'prov-warn', 'That address is not encrypted — anything between you and it can read the audio.'))
    }

    const acts = el('div', 'prov-acts')
    const test = el('button', 'btn small', 'Test it')
    test.onclick = () => runTest(kind, p, test)
    acts.append(test)
    if (kind === 'tts' && p.listVoices) {
      const list = el('button', 'btn small ghost', 'List my voices')
      list.onclick = () => loadRemoteVoices(p, list)
      acts.append(list)
    }
    const result = el('span', 'prov-result')
    result.id = `provResult-${p.id}`
    acts.append(result)
    row.append(acts)
    return row
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
    if (!chosen) return row

    const fields = el('div', 'settings')
    const l = el('label', 'wide')
    l.append(document.createTextNode('Voice'))
    const pick = document.createElement('select')
    const s = load()
    for (const v of voiceCache.filter((x) => x.local)) {
      const o = document.createElement('option')
      o.value = v.id
      o.textContent = `${v.name} · ${v.lang}`
      pick.append(o)
    }
    pick.value = resolveSystemVoice(voiceCache, s)?.id ?? ''
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
        await readAloud('This is how a line of narration will sound.')
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
    const local = voiceCache.filter((v) => v.local).length
    const remote = voiceCache.length - local
    acts.append(
      el(
        'span',
        'prov-result',
        `${local} voices on this computer` +
          (remote ? ` · ${remote} more are hidden: your browser makes those over the network at its maker's servers` : ''),
      ),
    )
    row.append(acts)
    return row
  }

  /* --------------------------------------------------------------- tests */

  async function runTest(kind, p, button) {
    const out = $(`provResult-${p.id}`)
    button.disabled = true
    out.textContent = 'trying…'
    out.classList.remove('bad')
    try {
      if (kind === 'stt') {
        // A second of silence is a real file and a real round trip, and costs
        // a fraction of a penny at the worst provider's rate.
        const doc = await SPEECH.transcribe(p.id, allConfig(), { blob: silentWav(1), filename: 'test.wav', durationMs: 1000 })
        const n = doc?.segments?.length ?? 0
        out.textContent = `it answered${n ? ` with ${n} line(s)` : ''} — working`
      } else {
        const blob = await SPEECH.speak(p.id, allConfig(), { text: 'Klipvia is connected.' })
        out.textContent = `it answered with ${(blob.size / 1024).toFixed(0)} KB of audio — working`
        new Audio(URL.createObjectURL(blob)).play().catch(() => {})
      }
    } catch (err) {
      out.textContent = err.message
      out.classList.add('bad')
    } finally {
      button.disabled = false
    }
  }

  async function loadRemoteVoices(p, button) {
    button.disabled = true
    $(`provResult-${p.id}`).textContent = 'asking…'
    try {
      const list = await p.listVoices(configFor(p.id))
      setProviderConfig(p.id, { voiceList: list })
      // The message goes on after the redraw, not before it. Setting it first
      // and then calling render() wrote it onto an element that was about to be
      // replaced — the voices arrived, were saved, and the panel said nothing.
      render()
      say(p.id, list.length ? `${list.length} voices: ${list.map((v) => v.name).slice(0, 4).join(', ')}${list.length > 4 ? '…' : ''}` : 'no voices saved in it yet')
    } catch (err) {
      say(p.id, err.message, true)
    } finally {
      button.disabled = false
    }
  }

  /** Put a line under a provider's buttons, on whichever element is there now. */
  function say(providerId, text, bad = false) {
    const el = $(`provResult-${providerId}`)
    if (!el) return
    el.textContent = text
    el.classList.toggle('bad', bad)
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

    $('speechIntro').textContent =
      tab === 'stt'
        ? 'Turn what is said in a clip into words you can edit, fix and place as captions. Nothing here is set up until you choose something.'
        : 'Your computer already has voices and they cost nothing. A voice that can be recorded into your video needs a model, on your machine or someone else’s.'

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
          'Off by default. You choosing a provider is not the same as a model deciding to upload to one — and it may be acting on words it read in your own footage.',
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
        ? `${keys.length} key${keys.length === 1 ? '' : 's'} kept in this browser only — never in a project file.`
        : 'Nothing is sent anywhere until you pick something that sends it.'

    for (const b of dlg.querySelectorAll('[data-speech-tab]')) b.classList.toggle('active', b.dataset.speechTab === tab)
  }

  /* -------------------------------------------------------- transcribing */

  /**
   * The other half of the feature, which had no window of its own.
   *
   * Transcription used to be a menu item that fired and reported through the
   * status line: no sense of a file being chosen, no sign of work happening, no
   * way to stop it, and on a long recording nothing between the click and
   * several minutes of silence. A job that takes minutes and sends somebody's
   * audio somewhere deserves to be watched while it runs and abandoned when it
   * should be.
   */
  const trDlg = $('dlgTranscribe')
  let trAbort = null
  let trLast = null
  /** Null when the window can run a job; a reason when it cannot. */
  let trBlocked = null

  function trRunning(on) {
    $('trProgress').hidden = !on
    $('btnTrStop').hidden = !on
    $('trSource').disabled = on
    // Not `disabled = on`. Doing that re-enabled the button whenever a job
    // finished — including the "job" of opening the window with nothing set
    // up, which left a live button that could only produce an error.
    $('btnTrRun').disabled = on || trBlocked === 'nomedia'
  }

  async function openTranscribe(filename = null) {
    const list = [...(mediaWithSound() ?? [])]
    const pick = $('trSource')
    pick.replaceChildren()
    for (const m of list) {
      const o = document.createElement('option')
      o.value = m.filename
      o.textContent = `${m.name} · ${(m.durationMs / 1000).toFixed(1)}s`
      pick.append(o)
    }
    if (filename) pick.value = filename

    const s = load()
    const p = s.stt ? SPEECH.sttProvider(s.stt) : null
    const ready = p ? readiness(p, { local: isLocal() }) : { ok: false }
    const w = p ? SPEECH.actualWhere(p, configFor(p.id)) : null

    trBlocked = !list.length ? 'nomedia' : ready.ok ? null : 'unset'
    $('trWhere').value = p ? `${p.label} — ${w.label}` : 'nothing chosen yet'
    $('trHint').textContent =
      trBlocked === 'nomedia'
        ? 'Nothing in the library has sound in it yet. Import a clip or record a voice-over first.'
        : trBlocked === 'unset'
          ? 'Nothing is listening yet. Choose where it should happen — your own machine, or a provider.'
          : 'The words come back as an ordinary transcript: editable line by line, and placeable as captions.'
    // A dead button is a worse answer than a live one that does the next
    // useful thing: with nothing set up, the button goes and sets it up.
    $('btnTrRun').textContent = trBlocked === 'unset' ? 'Choose where…' : 'Write it down'
    $('btnTrPlace').hidden = true
    $('trResult').textContent = ''
    $('trResult').classList.remove('error')
    trRunning(false)
    if (!trDlg.open) trDlg.showModal()
  }

  $('btnTrClose').onclick = () => {
    trAbort?.abort()
    trDlg.close()
  }
  $('btnTrStop').onclick = () => {
    trAbort?.abort()
    $('trStep').textContent = 'stopping…'
  }
  $('btnTrRun').onclick = async () => {
    if (trBlocked === 'unset') {
      trDlg.close()
      open('stt')
      return
    }
    const filename = $('trSource').value
    if (!filename) return
    const out = $('trResult')
    out.textContent = ''
    out.classList.remove('error')
    $('btnTrPlace').hidden = true
    trAbort = new AbortController()
    trRunning(true)
    $('trStep').textContent = 'starting…'
    try {
      const media = mediaFor(filename)
      const t = await transcribeMedia(filename, {
        local: isLocal(),
        media,
        language: $('trLang').value.trim() || null,
        signal: trAbort.signal,
        onProgress: (p) => p.label && ($('trStep').textContent = p.label),
      })
      trLast = t
      await refreshLibrary()
      const n = t.cueCount ?? t.cues?.length ?? 0
      out.textContent = `${n} line${n === 1 ? '' : 's'}${t.wordLevel ? ', with word timings' : ''} — "${t.name}" is in Transcripts.`
      $('btnTrPlace').hidden = false
      status(`wrote down "${media?.name ?? filename}"`)
    } catch (err) {
      // Stopping is a choice, not a failure, and should not be dressed as one.
      out.textContent = err?.name === 'AbortError' ? 'Stopped. Nothing was kept.' : err.message
      out.classList.toggle('error', err?.name !== 'AbortError')
    } finally {
      trRunning(false)
      trAbort = null
    }
  }
  $('btnTrPlace').onclick = () => {
    if (!trLast) return
    insertTranscript(trLast.id)
    trDlg.close()
    status('captions placed at the playhead')
  }

  /* --------------------------------------------------------- voice-over */

  const voiceDlg = $('dlgVoice')

  async function openVoiceOver(prefill = '') {
    stopPreview()
    dropPreviewCache()
    const s = load()
    const provider = s.tts ? SPEECH.ttsProvider(s.tts) : null
    const canRecord = !!provider?.speak && readiness(provider, { local: isLocal() }).ok

    $('voiceScript').value = prefill || $('voiceScript').value
    $('voiceResult').textContent = ''
    $('voiceMeta').textContent = ''
    $('voiceHint').textContent = canRecord
      ? `${provider.label} will read this and add it to your library as an audio file.`
      : 'Your computer can read this aloud and time it. To record it into your video, choose a voice in Transcription and voice.'
    $('btnVoiceMake').disabled = !canRecord
    // Named, because the whole confusion was a button that did not say whose
    // voice it was about to use.
    $('btnVoiceRead').textContent = canRecord ? `Hear it in ${provider.label}` : 'Read it aloud'
    $('btnVoiceRead').dataset.tip = canRecord
      ? 'Say it with the voice selected above and play it here. Nothing is added to your library.'
      : "Read it aloud with your computer's own voice, to hear the wording. Nothing is recorded or sent."

    const pick = $('voicePick')
    pick.replaceChildren()
    const list = provider?.voices ?? configFor(s.tts ?? '')?.voiceList ?? []
    if (canRecord && list.length) {
      for (const v of list) {
        const o = document.createElement('option')
        o.value = typeof v === 'string' ? v : v.id
        o.textContent = typeof v === 'string' ? v : v.name
        pick.append(o)
      }
      pick.value = configFor(s.tts).voice ?? pick.options[0]?.value ?? ''
      pick.disabled = false
    } else {
      const o = document.createElement('option')
      o.textContent = canRecord ? 'the server’s default' : 'your computer’s voice'
      pick.append(o)
      pick.disabled = true
    }
    if (!voiceDlg.open) voiceDlg.showModal()
  }

  const script = () => $('voiceScript').value.trim()

  $('btnVoiceClose').onclick = () => {
    stopPreview()
    dropPreviewCache()
    voiceDlg.close()
  }
  /**
   * Hearing it in the voice you picked.
   *
   * This used to always use the computer's own voice, whatever was chosen in
   * the picker directly above it — so somebody who selected a cloned voice and
   * pressed the obvious button heard a stock system voice and reasonably
   * concluded the setting had not taken. A preview that ignores the choice
   * being previewed is worse than no preview.
   *
   * So it reads with whatever is selected, and falls back to the system voice
   * only when there is nothing else — which is also the one case where the
   * fallback is the honest answer rather than a substitution.
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
    const s = load()
    const provider = s.tts ? SPEECH.ttsProvider(s.tts) : null
    const usable = provider?.speak && readiness(provider, { local: isLocal() }).ok

    if (!usable) {
      try {
        await readAloud(script())
      } catch (err) {
        status(err.message, 'error')
      }
      return
    }

    const meta = $('voiceMeta')
    const key = `${s.tts}|${$('voicePick').value}|${script()}`
    btn.disabled = true
    try {
      if (previewCache?.key !== key) {
        const voice = $('voicePick').disabled ? null : $('voicePick').value
        meta.textContent = `asking ${provider.label}…`
        const blob = await SPEECH.speak(s.tts, allConfig(), { text: script(), voice })
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
      // The take exists and the transport is on screen; that is the job done.
      previewAudio.play().catch(() => {
        meta.textContent = 'ready — press play'
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
        ? `About ${doc.duration.toFixed(1)}s — counted, not spoken. Click anywhere on the page and ask again for a real timing.`
        : `${doc.duration.toFixed(1)}s at this speed · ${doc.words.length} words timed. ` +
          `That is your computer's voice; a recorded one will differ a little.`
    } catch (err) {
      $('voiceMeta').textContent = err.message
    }
  }
  $('btnVoiceMake').onclick = async () => {
    if (!script()) return
    const out = $('voiceResult')
    out.classList.remove('error')
    out.textContent = 'recording…'
    $('btnVoiceMake').disabled = true
    try {
      const m = await generateVoice(script(), {
        name: $('voiceName').value.trim() || null,
        voice: $('voicePick').disabled ? null : $('voicePick').value,
        local: isLocal(),
        onProgress: (p) => (out.textContent = p.label ?? ''),
      })
      await refreshLibrary()
      insertMedia(m.filename)
      out.textContent = `${m.name} · ${(m.durationMs / 1000).toFixed(1)}s — added at the playhead`
      status(`voice-over added: ${m.name}`)
    } catch (err) {
      out.textContent = err.message
      out.classList.add('error')
    } finally {
      $('btnVoiceMake').disabled = false
    }
  }

  /* ----------------------------------------------------------------- open */

  async function open(which = 'stt') {
    tab = which
    if (!voiceCache.length) voiceCache = await SPEECH.systemVoices()
    render()
    save({ introSeen: true })
    if (!dlg.open) dlg.showModal()
  }

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

  return { open, openVoiceOver, openTranscribe, isReady: (kind) => {
    const s = load()
    const id = kind === 'stt' ? s.stt : s.tts
    const p = kind === 'stt' ? SPEECH.sttProvider(id) : SPEECH.ttsProvider(id)
    return !!p && readiness(p, { local: isLocal() }).ok
  } }
}
