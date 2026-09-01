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
 * Three things learned the hard way, all of which shape this file:
 *
 * 1. A browser can only call what will let it. `api.openai.com` sends no
 *    `Access-Control-Allow-Origin`, so OpenAI simply cannot be reached from a
 *    page — no key, no header, no flag changes that. Providers carry
 *    `browserDirect` and the UI refuses the ones that would fail, at the moment
 *    of choosing rather than at the moment of use. An opaque CORS error in a
 *    console nobody has open is the worst possible way to learn this.
 *
 * 2. The browser's own voices cannot be recorded. `speechSynthesis` has no
 *    route to a MediaStream or an AudioBuffer, and there is no workaround that
 *    is not "ask the user to reconfigure their operating system's audio". They
 *    read text aloud beautifully, for free, offline, in two hundred voices —
 *    and they can never put a single byte into a video file. That is a
 *    limitation to state plainly, not to paper over. What they *can* do is time
 *    a script, which is genuinely useful and costs nothing: see `timeSpeech`.
 *
 * 3. Almost everything speaks OpenAI's shape. whisper.cpp's server, Speaches,
 *    LocalAI, LM Studio, openedai-speech, vLLM and Groq all take the same two
 *    routes, so one adapter with a configurable base URL covers a local model
 *    on your own machine and a hosted one, identically. The presets below are
 *    that one adapter with the fields filled in.
 */

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

/* ------------------------------------------------------- shared http bits */

class SpeechError extends Error {
  constructor(message, { provider, status } = {}) {
    super(message)
    this.name = 'SpeechError'
    this.provider = provider
    this.status = status
  }
}

/**
 * The one failure worth translating.
 *
 * A blocked cross-origin request rejects as a bare `TypeError: Failed to
 * fetch`, indistinguishable from the machine being asleep. Since the browser
 * deliberately withholds the reason, the honest thing is to name both
 * possibilities rather than guess one.
 */
/**
 * Where a provider request is actually sent from.
 *
 * With no server, the page has to call the provider itself and lives with
 * whoever refuses it. With a server — the same one serving this page — the
 * request goes to our own origin and the server makes the call, so there is no
 * cross-origin request in the chain at all and every provider works, including
 * the ones no browser may call. `useRelay` is set once at boot.
 */
let relayVia = null

export function useRelay(on) {
  relayVia = on ? '/api/speech/relay' : null
}

const viaRelay = (url) => {
  if (!relayVia) return url
  try {
    if (new URL(url, location.href).origin === location.origin) return url
  } catch {
    return url
  }
  return `${relayVia}?url=${encodeURIComponent(url)}`
}

async function call(url, init, provider, hint = null) {
  let res
  try {
    res = await fetch(viaRelay(url), init)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // The browser will not say which of the two it was, so both are named —
    // and, because the second one is fixed by telling the server about *this*
    // page, this page's address is included ready to be pasted in.
    const where = new URL(url, location.href).origin
    throw new SpeechError(
      relayVia
        ? `could not reach ${where} — Klipvia's server tried and could not get an answer, so it is probably not running`
        : `could not reach ${where} — either it is not running, or it is running and has not been told ` +
          `to allow pages from ${location.origin}.` + (hint ? ` ${hint}` : ''),
      { provider },
    )
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
        typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.message ?? v.detail ?? v.error ?? v.reason) : null
      detail = pick(j?.error) ?? pick(j?.detail) ?? pick(j?.message) ?? pick(j) ?? detail
    } catch {
      /* not json; the text will do */
    }
    throw new SpeechError(`${provider}: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, {
      provider,
      status: res.status,
    })
  }
  return res
}

const trimSlash = (s) => String(s ?? '').replace(/\/+$/, '')

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

  // Seconds unless seconds is impossible. Picking whichever unit lands
  // *closest* to the duration was the bug: a provider whose timings merely
  // disagree with the audio — a fixed-length stub, a trimmed file, a bad
  // estimate — got its whole document divided by a thousand, and the result
  // looked like a transcript that had collapsed into the first hundredth of a
  // second. Only an interpretation that cannot be true is rejected.
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

/* ------------------------------------------------- transcription providers */

/** POST a file to anything that speaks OpenAI's `/v1/audio/transcriptions`. */
async function openAiTranscribe({ base, key, model, language, blob, filename, signal, provider, authHeader }) {
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
  if (language) form.append('language', language)

  const headers = {}
  if (key) Object.assign(headers, authHeader ? authHeader(key) : { authorization: `Bearer ${key}` })

  const res = await call(`${base}/audio/transcriptions`, { method: 'POST', body: form, headers, signal }, provider)
  return res.json()
}

/**
 * VoiceBox — a Qwen3-TTS voice-cloning server somebody runs themselves.
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

async function voiceboxProfile(base, id, signal) {
  const res = await call(`${base}/profiles/${encodeURIComponent(id)}`, { signal }, 'VoiceBox', voiceboxHint())
  return res.json()
}

async function voiceboxSpeak({ base: raw, voice, text, language, signal, onProgress }) {
  const base = plainBase(raw)
  if (!base) throw new SpeechError('VoiceBox: that address is not one a browser can reach', { provider: 'VoiceBox' })

  let profileId = voice
  if (!profileId) {
    const list = await voiceboxVoices({ base: raw, signal })
    profileId = list[0]?.id
    if (!profileId) throw new SpeechError('VoiceBox has no voice profiles yet — make one in VoiceBox first', { provider: 'VoiceBox' })
  }

  // A preset profile only answers to the engine it was made with.
  const profile = await voiceboxProfile(base, profileId, signal).catch(() => null)
  const engine = profile?.preset_engine || profile?.default_engine || undefined

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
        ...(language || profile?.language ? { language: language || profile.language } : {}),
        ...(engine ? { engine } : {}),
      }),
    },
    'VoiceBox',
    voiceboxHint(),
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
    if (state.status === 'failed' || state.error) {
      throw new SpeechError(`VoiceBox could not say that: ${state.error ?? 'generation failed'}`, { provider: 'VoiceBox' })
    }
    if (Date.now() > deadline) throw new SpeechError('VoiceBox is still going after ten minutes; giving up', { provider: 'VoiceBox' })
    await new Promise((r) => setTimeout(r, VOICEBOX_POLL_MS))
    onProgress?.({ label: `VoiceBox is speaking… (${state.status})` })
    const poll = await call(`${base}/history/${job.id}`, { signal }, 'VoiceBox', voiceboxHint())
    state = await poll.json()
  }

  onProgress?.({ label: 'fetching the audio…' })
  const audio = await call(`${base}/audio/${job.id}`, { signal }, 'VoiceBox', voiceboxHint())
  return audio.blob()
}

async function voiceboxVoices({ base: raw, signal }) {
  const base = plainBase(raw)
  if (!base) return []
  const res = await call(`${base}/profiles`, { signal }, 'VoiceBox', voiceboxHint())
  const body = await res.json()
  const rows = Array.isArray(body) ? body : (body.items ?? [])
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    note: [p.language, p.voice_type === 'cloned' ? 'cloned' : p.preset_engine].filter(Boolean).join(' · '),
  }))
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
  if (language) form.append('language', language)
  const res = await call(`${base}/transcribe`, { method: 'POST', body: form, signal }, 'VoiceBox', voiceboxHint())
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

/** Named once so both provider entries say the same thing about reaching it. */
const VOICEBOX_CORS =
  'VoiceBox only answers pages it has been told about. It allows http://localhost:5173 out of the box, ' +
  'so serving Klipvia on port 5173 works with no change to VoiceBox — otherwise add this page’s address ' +
  'to VoiceBox’s allowed origins.'

/** Appended to a VoiceBox connection failure, where the remedy is known. */
const voiceboxHint = () =>
  `VoiceBox allows http://localhost:5173 out of the box: serving Klipvia there needs no change to VoiceBox. ` +
  `Otherwise add ${location.origin} to its allowed origins.`

export const STT_PROVIDERS = [
  {
    id: 'openai-compatible',
    label: 'A Whisper server you run',
    where: 'machine',
    browserDirect: true,
    needs: ['base'],
    baseHint: 'http://localhost:8000/v1',
    modelHint: 'Systran/faster-whisper-small',
    blurb:
      'whisper.cpp, Speaches, LocalAI, LM Studio or anything else that speaks OpenAI’s API. ' +
      'The sound goes to that machine and no further.',
    // Every one of these ships with CORS off, and a blocked request looks
    // exactly like a server that is not running, so the UI says this up front.
    setupNote:
      'Most of these need cross-origin requests turned on — Speaches: --allow-origins "*", LocalAI: --cors. ' +
      "whisper.cpp already allows them but serves /inference, so start it with --inference-path /v1/audio/transcriptions or every call is a 404.",
    transcribe: (o) => openAiTranscribe({ ...o, base: normaliseBase(o.base), provider: 'your Whisper server' }),
  },
  {
    id: 'voicebox',
    label: 'VoiceBox',
    where: 'machine',
    browserDirect: true,
    needs: ['base'],
    baseHint: 'http://127.0.0.1:17493',
    blurb:
      'The Whisper built into VoiceBox. It returns the words and the length but no per-word times, ' +
      'so the lines are spread across the length by their own length — fine to read and edit, not frame-exact.',
    setupNote: VOICEBOX_CORS,
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
    blurb: 'Accurate, and returns per-word timings.',
    async transcribe({ key, blob, filename, signal }) {
      const form = new FormData()
      form.append('file', blob, filename || 'audio.wav')
      form.append('model_id', 'scribe_v2')
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
    blurb: 'Fast, with good punctuation and speaker labels.',
    async transcribe({ key, blob, signal }) {
      const res = await call(
        'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true',
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
    blurb: 'Upload, then poll. Slower to start, strong on long recordings.',
    async transcribe({ key, blob, signal, onProgress }) {
      const headers = { authorization: key }
      onProgress?.({ label: 'uploading…' })
      const up = await call('https://api.assemblyai.com/v2/upload', { method: 'POST', body: blob, headers, signal }, 'AssemblyAI')
      const { upload_url } = await up.json()

      const started = await call(
        'https://api.assemblyai.com/v2/transcript',
        { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ audio_url: upload_url }), signal },
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
    // The one that cannot work from a page. Kept in the list, disabled and
    // explained, because it is the first name everybody looks for and a
    // missing row reads as an oversight rather than a decision.
    browserDirect: false,
    needs: ['key'],
    models: ['gpt-4o-transcribe', 'whisper-1'],
    blurb: 'OpenAI does not allow web pages to call its API directly, so this needs the Klipvia server. Groq runs the same Whisper model and does allow it.',
    transcribe: (o) => openAiTranscribe({ ...o, base: 'https://api.openai.com/v1', model: o.model || 'whisper-1', provider: 'OpenAI' }),
  },
]

/* --------------------------------------------------------- voice providers */

/** Anything that speaks OpenAI's `/v1/audio/speech`, which is nearly everything. */
async function openAiSpeak({ base, key, model, voice, text, format = 'mp3', signal, provider, authHeader }) {
  if (!base) throw new SpeechError(`${provider}: that address is not one a browser can reach`, { provider })
  const headers = { 'content-type': 'application/json' }
  if (key) Object.assign(headers, authHeader ? authHeader(key) : { authorization: `Bearer ${key}` })
  const res = await call(
    `${base}/audio/speech`,
    { method: 'POST', headers, signal, body: JSON.stringify({ model, input: text, voice, response_format: format }) },
    provider,
  )
  return res.blob()
}

/*
 * Groq is not in this list although it is in the transcription one. Its
 * `playai-tts` was retired at the end of 2025 and the replacement model id
 * could not be confirmed against a live account, and a wrong model id is a 400
 * at the moment somebody is trying the feature for the first time. Its 200
 * characters a request would make it a poor fit for narration in any case.
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
    blurb:
      'Free, instant and completely private — but browsers do not let a page record them, ' +
      'so they can read a script aloud and time it, and cannot put sound into your video.',
  },
  {
    id: 'openai-compatible',
    label: 'A voice server you run',
    where: 'machine',
    browserDirect: true,
    canRecord: true,
    needs: ['base'],
    baseHint: 'http://localhost:8000/v1',
    modelHint: 'tts-1',
    formats: ['wav', 'mp3', 'opus', 'flac'],
    blurb: 'Kokoro, Piper, Speaches, LocalAI or openedai-speech. The text goes to that machine and no further.',
    setupNote: 'Most of these need cross-origin requests turned on before a page can call them.',
    // wav rather than mp3, unlike the hosted providers: these servers only
    // encode mp3 when they happen to have ffmpeg, and asking for one they
    // cannot make is a 400 rather than a fallback. wav is always there, always
    // decodes, and the file never leaves the machine anyway.
    speak: (o) =>
      openAiSpeak({ ...o, base: normaliseBase(o.base), model: o.model || 'tts-1', format: o.format || 'wav', provider: 'your voice server' }),
  },
  {
    id: 'voicebox',
    label: 'VoiceBox',
    where: 'machine',
    browserDirect: true,
    canRecord: true,
    needs: ['base'],
    baseHint: 'http://127.0.0.1:17493',
    blurb: 'Qwen3-TTS voice cloning on your own machine. The voices you have saved in it appear here.',
    setupNote: VOICEBOX_CORS,
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
    blurb: 'The most natural voices, and it will list yours.',
    async listVoices({ key, signal }) {
      const res = await call('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal }, 'ElevenLabs')
      const j = await res.json()
      return (j.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, note: v.labels?.description ?? '' }))
    },
    async speak({ key, voice, text, signal }) {
      const id = voice || '21m00Tcm4TlvDq8ikWAM'
      const res = await call(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
          signal,
        },
        'ElevenLabs',
      )
      return res.blob()
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
    voices: ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-2-apollo-en', 'aura-2-arcas-en'],
    blurb: 'Low latency, natural, English only.',
    async speak({ key, voice, text, signal }) {
      const res = await call(
        `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice || 'aura-2-thalia-en')}&encoding=mp3`,
        { method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal },
        'Deepgram',
      )
      return res.blob()
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    where: 'provider',
    browserDirect: false,
    canRecord: true,
    needs: ['key'],
    voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    blurb: 'OpenAI does not allow web pages to call its API directly, so this needs the Klipvia server.',
    speak: (o) => openAiSpeak({ ...o, base: 'https://api.openai.com/v1', model: o.model || 'gpt-4o-mini-tts', voice: o.voice || 'alloy', provider: 'OpenAI' }),
  },
]

export const sttProvider = (id) => STT_PROVIDERS.find((p) => p.id === id) ?? null
export const ttsProvider = (id) => TTS_PROVIDERS.find((p) => p.id === id) ?? null

/** The host a provider's request actually reaches, for the record it leaves. */
export function hostOf(provider, conf = {}) {
  if (!provider) return null
  const known = { groq: 'api.groq.com', elevenlabs: 'api.elevenlabs.io', deepgram: 'api.deepgram.com', assemblyai: 'api.assemblyai.com', openai: 'api.openai.com' }
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
/** True when this page can use a provider no browser may call directly. */
export const hasRelay = () => !!relayVia

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
  const isHere =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  return isHere ? WHERE.machine : { ...WHERE.provider, label: `sent to ${host}`, host }
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

/**
 * Transcribe one file, whoever is doing the transcribing.
 *
 * Returns a Whisper-shaped document — `{text, segments?, words?}` — because
 * that is what `subtitles.js` already reads, including the word timings the
 * karaoke captions run on. Every provider above is bent into that shape rather
 * than each having its own path through the app.
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
  const doc = await p.transcribe({ ...conf, language: language ?? conf.language ?? null, blob, filename, signal, onProgress })
  return normaliseUnits(doc, durationMs)
}

/** Say one piece of text, and hand back the bytes. */
export async function speak(providerId, settings, { text, voice, signal, onProgress } = {}) {
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
  onProgress?.({ label: `asking ${p.label}…` })
  const blob = await p.speak({ ...conf, voice: voice ?? conf.voice, text, signal })
  if (!blob?.size) throw new SpeechError(`${p.label} returned nothing`)
  return blob
}

export { SpeechError }
