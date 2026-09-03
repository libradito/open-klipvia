/**
 * The browser as the whole back end.
 *
 * Klipvia was built against a small Bun server holding a folder of JSON and a
 * folder of media. That is the right shape on your own machine and the wrong
 * one on a host: it means a disk, a login, and every visitor sharing one set of
 * projects. So the same app can run with no server at all — projects and
 * timelines in IndexedDB, footage and images in the Origin Private File System,
 * which is a real filesystem the browser gives each origin, per visitor,
 * privately, with no quota theatre and no upload.
 *
 * The trick that makes this cheap: nothing above this file changes. The app
 * still calls `fetch('/api/projects')`. `install()` wraps `fetch` and answers
 * those requests from here instead, returning the same JSON the server would.
 * Eighty call sites keep working, and the one build runs both ways — against
 * the server when there is one, against the browser when there is not.
 *
 * Two things genuinely cannot be faked by intercepting `fetch`, because they
 * are not fetches: a `<video src>` and an `<img src>` inside a clip document
 * are subresource loads the browser makes on its own. Those get real object
 * URLs instead — see `mediaUrl` and `rewriteAssetUrls`.
 */

import { finalizeTranscript, parseTranscript, replaceCuesInWindow, toSrt, toVtt } from '/subtitles.js'
import { decodeDataUrl, INLINE_CAPS, isDataUrl, nameIncoming } from '/filetype.js'

const DB_NAME = 'klipvia'
const DB_VERSION = 1
/** id -> the document, for the three kinds that are only ever JSON. */
const STORES = ['projects', 'timelines', 'transcripts', 'mediaMeta', 'assetMeta']

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx(store, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    t.oncomplete = () => resolve(req?.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

const dbGet = (store, id) => tx(store, 'readonly', (s) => s.get(id))
const dbAll = (store) => tx(store, 'readonly', (s) => s.getAll())
const dbPut = (store, doc) => tx(store, 'readwrite', (s) => s.put(doc)).then(() => doc)
const dbDel = (store, id) => tx(store, 'readwrite', (s) => s.delete(id))

/* ----------------------------------------------------------------- files */

/**
 * OPFS: a private, per-origin filesystem. Footage goes here rather than into
 * IndexedDB because it is measured in gigabytes and because a file handle can
 * be turned into a `File`, and a `File` into an object URL a `<video>` can seek
 * inside — which is the whole reason scrubbing works without a server.
 */
async function dir(name) {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(name, { create: true })
}

/**
 * `data` is written as it is — a Blob or a File goes straight through.
 *
 * That matters: the client POSTs the `File` itself, and turning it into an
 * ArrayBuffer first would pull four gigabytes of footage into memory to put it
 * on a disk it is already on. A writable stream takes the Blob and never does.
 */
async function writeFile(folder, name, data) {
  const d = await dir(folder)
  const handle = await d.getFileHandle(name, { create: true })
  const w = await handle.createWritable()
  try {
    await w.write(data)
    await w.close()
  } catch (err) {
    await w.abort?.().catch(() => {})
    await d.removeEntry(name).catch(() => {})
    // A quota failure is the one error worth translating: "QuotaExceededError"
    // tells you nothing about what to do, and there is something to do.
    if (err?.name === 'QuotaExceededError') {
      const { usage, quota } = await navigator.storage.estimate()
      throw new Error(
        `no room left — this browser has given Klipvia ${(quota / 1024 ** 3).toFixed(1)} GB and ` +
        `${(usage / 1024 ** 3).toFixed(1)} GB is in use. Remove some footage, or free space on the disk.`,
      )
    }
    throw err
  }
  return handle
}

async function readFile(folder, name) {
  try {
    const d = await dir(folder)
    return await (await d.getFileHandle(name)).getFile()
  } catch {
    return null
  }
}

async function removeFile(folder, name) {
  try {
    ;(await dir(folder)).removeEntry(name)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------- urls */

/**
 * One object URL per file, kept for the life of the page.
 *
 * They are revoked only when the file itself goes, because a `<video>` holding
 * a revoked URL fails silently and the timeline just stops drawing.
 */
const urlCache = new Map()

export async function mediaUrl(filename) {
  if (urlCache.has(filename)) return urlCache.get(filename)
  const file = await readFile('media', filename)
  if (!file) return null
  const url = URL.createObjectURL(file)
  urlCache.set(filename, url)
  return url
}

export async function assetUrl(filename) {
  const key = `asset:${filename}`
  if (urlCache.has(key)) return urlCache.get(key)
  const file = await readFile('assets', filename)
  if (!file) return null
  const url = URL.createObjectURL(file)
  urlCache.set(key, url)
  return url
}

function dropUrl(key) {
  const url = urlCache.get(key)
  if (url) URL.revokeObjectURL(url)
  urlCache.delete(key)
}

/**
 * Clip HTML refers to `/assets/logo.png`, and a clip is mounted as an iframe's
 * srcdoc — a subresource load no `fetch` wrapper can see. Rewriting the markup
 * to object URLs before it is mounted is the one place that has to know.
 */
export async function rewriteAssetUrls(html) {
  if (!html || !html.includes('/assets/')) return html
  const names = [...new Set([...html.matchAll(/\/assets\/([^"'`)\s>]+)/g)].map((m) => m[1]))]
  let out = html
  for (const name of names) {
    const url = await assetUrl(decodeURIComponent(name))
    if (url) out = out.replaceAll(`/assets/${name}`, url)
  }
  return out
}

/**
 * A picture small enough to hand to whoever asked to look at it.
 *
 * JPEG rather than PNG, and no wider than `max`: a full-frame PNG is a couple
 * of megabytes, and nothing that wants to *see* a frame is better served by
 * two megabytes of it than by two hundred kilobytes.
 */
async function downscaleToDataUri(blob, max = 1280, quality = 0.82) {
  const bmp = await createImageBitmap(blob)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  // JPEG has no alpha; a transparent frame would come out black without this.
  g.fillStyle = '#000000'
  g.fillRect(0, 0, w, h)
  g.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  const dataUri = await new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(fr.error)
    fr.readAsDataURL(out)
  })
  return { dataUri, size: out.size, width: w, height: h }
}

/* --------------------------------------------------------------- helpers */

const uid = (p) => p + Math.random().toString(36).slice(2, 10)
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const notFound = () => json({ error: 'not found' }, 404)

/** The same starter clip the server writes, so a project made here matches one made there. */
export function blankClip(name = 'Untitled clip') {
  return {
    id: uid('c_'),
    name,
    html: '<div class="title"><span>Hello</span></div>',
    css: [
      '.title {',
      '  display: flex; align-items: center; justify-content: center;',
      '  width: 100%; height: 100%;',
      '  font: 700 120px/1 system-ui, sans-serif; color: #fff;',
      '}',
      '.title span {',
      '  animation: rise 1.2s cubic-bezier(.2,.8,.2,1) both;',
      '}',
      '@keyframes rise {',
      '  from { opacity: 0; transform: translateY(40px) scale(.9); }',
      '  to   { opacity: 1; transform: translateY(0)    scale(1);  }',
      '}',
    ].join('\n'),
    js: '',
    durationMs: 3000,
    width: 1920,
    height: 1080,
    fps: 30,
    // The same starter the server writes: transparent, over the editor's
    // checkerboard. White type on a white card is an invisible first run.
    background: { mode: 'transparent', color: '#00b140' },
  }
}

function blankTrack(kind, name) {
  return { id: uid('t_'), kind, name, items: [], muted: false, hidden: false, locked: false }
}

export function blankTimeline(projectId, name = 'Main') {
  const now = Date.now()
  return {
    id: uid('s_'),
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    background: { mode: 'color', color: '#000000' },
    tracks: [blankTrack('video', 'V2'), blankTrack('video', 'V1'), blankTrack('audio', 'A1')],
    projectId,
    rev: 1,
    createdAt: now,
    updatedAt: now,
  }
}

/* ------------------------------------------------------------- probing */

/**
 * What the server used ffprobe for: how long, how big, is there sound.
 *
 * A `<video>` answers the first two on its own. Sound is harder — nothing on
 * the element reliably reports whether an audio track exists — so the file is
 * decoded once with WebAudio, which answers it and produces the waveform in
 * the same pass. That decode is the expensive part of an import, and it is the
 * only reason importing is not instant.
 */
/**
 * `decodeAudioData` wants the entire file decoded into memory at once — an
 * hour of 48 kHz stereo is about 700 MB of float32 before the peaks are even
 * built. Past this, the waveform is skipped rather than the tab.
 */
const DECODE_CAP_BYTES = 400 * 1024 * 1024

async function probeMedia(file, filename, originalName = null) {
  const url = URL.createObjectURL(file)
  const el = document.createElement('video')
  el.preload = 'metadata'
  el.muted = true
  el.src = url

  const meta = await new Promise((resolve) => {
    const done = () =>
      resolve({
        durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
      })
    el.onloadedmetadata = done
    el.onerror = () => resolve({ durationMs: 0, width: 0, height: 0 })
    // Chrome does not load media in a background tab, so a probe that runs
    // while the tab is hidden answers nothing at all. Waiting longer would not
    // help; coming back when the tab is looked at again does.
    setTimeout(done, 12_000)
  })
  URL.revokeObjectURL(url)

  let hasAudio = false
  let peaks = null
  let sampleRate = null
  let channels = null
  let tooBigToDecode = false
  if (file.size <= DECODE_CAP_BYTES) {
    try {
      const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000)
      const buf = await ac.decodeAudioData(await file.arrayBuffer())
      hasAudio = buf.numberOfChannels > 0 && buf.length > 0
      sampleRate = buf.sampleRate
      channels = buf.numberOfChannels
      peaks = buildPeaks(buf)
      if (!meta.durationMs) meta.durationMs = Math.round(buf.duration * 1000)
    } catch {
      /* no decodable audio — a silent clip, or a container WebAudio will not take */
    }
  } else {
    // Assumed to have sound, because being wrong the other way silences a shot
    // and being wrong this way costs one decode attempt that fails harmlessly.
    tooBigToDecode = true
    hasAudio = true
  }

  // The container says what it holds even when the element could not be asked.
  // Trusting it means a shot imported in a background tab is still a shot —
  // it simply does not know its own size yet, and `needsProbe` says so.
  const looksVideo = /^video\//.test(file.type || '') || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(filename)
  const kind = meta.width > 0 || looksVideo ? 'video' : 'audio'
  const needsProbe = kind === 'video' && !meta.width
  return {
    needsProbe,
    /** Set when the file was too large to decode: no waveform, sound assumed. */
    tooBigToDecode,
    id: filename,
    filename,
    name: originalName || file.name || filename,
    url: `/media/${filename}`,
    mime: file.type || 'application/octet-stream',
    kind,
    size: file.size,
    modified: Date.now(),
    durationMs: meta.durationMs,
    width: meta.width || null,
    height: meta.height || null,
    // Nothing in the browser reports a file's real frame rate; 30 is the
    // sequence default and the number is only ever used as a hint.
    fps: kind === 'video' ? 30 : null,
    hasVideo: kind === 'video',
    hasAudio,
    sampleRate,
    channels,
    vcodec: null,
    acodec: null,
    posterUrl: null,
    hasPeaks: !!peaks,
    peaksPerSecond: peaks?.peaksPerSecond ?? null,
    _peaks: peaks,
  }
}

/** Min/max per slice, the shape the timeline's waveform painter expects. */
function buildPeaks(buf, perSecond = 100) {
  const ch = buf.getChannelData(0)
  const step = Math.max(1, Math.floor(buf.sampleRate / perSecond))
  const out = []
  for (let i = 0; i < ch.length; i += step) {
    let lo = 1, hi = -1
    const end = Math.min(i + step, ch.length)
    for (let j = i; j < end; j++) {
      const v = ch[j]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    out.push(Math.round(lo * 127), Math.round(hi * 127))
  }
  return { peaksPerSecond: perSecond, peaks: out }
}

/* -------------------------------------------------------------- routing */

/** Everything the client asks of `/api`, answered from the browser. */
const routes = [
  /* ------------------------------------------------------------- health */
  ['GET', /^\/api\/health$/, async () => {
    // No ffmpeg here, and saying so is what makes the UI hide the server-only
    // export formats rather than offering something that cannot happen.
    const { CLIENT_FORMATS } = await import('/clientexport.js')
    return json({ ok: true, local: true, ffmpeg: false, ffmpegVersion: null, alphaSupport: {}, formats: CLIENT_FORMATS })
  }],

  ['GET', /^\/api\/blank-clip$/, async () => json(blankClip('Clip 1'))],

  ['GET', /^\/api\/timeline-formats$/, async () => {
    const { CLIENT_FORMATS } = await import('/clientexport.js')
    return json(CLIENT_FORMATS)
  }],

  /* ----------------------------------------------------------- projects */
  ['GET', /^\/api\/projects$/, async () => {
    const all = await dbAll('projects')
    all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return json(all.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, clipCount: p.clips?.length ?? 0 })))
  }],

  ['POST', /^\/api\/projects$/, async (m, req) => {
    const body = await req.json().catch(() => ({}))
    const now = Date.now()
    const id = uid('p_')
    const main = blankTimeline(id, 'Main')
    await dbPut('timelines', main)
    const p = {
      id,
      name: body.name || 'Untitled project',
      clips: [blankClip('Clip 1')],
      timelineIds: [main.id],
      mainTimelineId: main.id,
      createdAt: now,
      updatedAt: now,
    }
    await dbPut('projects', p)
    return json(p, 201)
  }],

  ['GET', /^\/api\/projects\/([^/]+)$/, async (m) => {
    const p = await dbGet('projects', m[1])
    if (!p) return notFound()
    const timelines = []
    for (const id of p.timelineIds ?? []) {
      const t = await dbGet('timelines', id)
      if (t) timelines.push(t)
    }
    return json({ ...p, timelines })
  }],

  ['PUT', /^\/api\/projects\/([^/]+)$/, async (m, req) => {
    const prev = await dbGet('projects', m[1])
    if (!prev) return notFound()
    const body = await req.json()
    // Timelines are their own documents; a `sequences` key from the client is
    // ignored exactly as the server ignores it.
    const { sequences, timelines, ...rest } = body
    const next = { ...prev, ...rest, id: prev.id, updatedAt: Date.now() }
    await dbPut('projects', next)
    return json(next)
  }],

  ['DELETE', /^\/api\/projects\/([^/]+)$/, async (m) => {
    const p = await dbGet('projects', m[1])
    if (!p) return notFound()
    for (const id of p.timelineIds ?? []) await dbDel('timelines', id)
    await dbDel('projects', p.id)
    return json({ ok: true })
  }],

  /* ---------------------------------------------------------- timelines */
  ['GET', /^\/api\/timelines\/revs$/, async (m, req) => {
    const projectId = new URL(req.url, location.origin).searchParams.get('project')
    const all = await dbAll('timelines')
    return json(
      all.filter((t) => !projectId || t.projectId === projectId)
        .map((t) => ({ id: t.id, rev: t.rev ?? 0, updatedAt: t.updatedAt ?? 0 })),
    )
  }],

  ['POST', /^\/api\/timelines$/, async (m, req) => {
    const body = await req.json().catch(() => ({}))
    const t = { ...blankTimeline(body.projectId, body.name ?? 'Timeline'), ...body }
    t.id = body.id ?? uid('s_')
    t.rev = 1
    t.createdAt = t.createdAt ?? Date.now()
    t.updatedAt = Date.now()
    await dbPut('timelines', t)
    if (body.projectId) {
      const p = await dbGet('projects', body.projectId)
      if (p && !p.timelineIds.includes(t.id)) {
        p.timelineIds.push(t.id)
        p.updatedAt = Date.now()
        await dbPut('projects', p)
      }
    }
    return json(t, 201)
  }],

  ['GET', /^\/api\/timelines\/([^/]+)$/, async (m) => {
    const t = await dbGet('timelines', m[1])
    return t ? json(t) : notFound()
  }],

  ['PUT', /^\/api\/timelines\/([^/]+)$/, async (m, req) => {
    const prev = await dbGet('timelines', m[1])
    if (!prev) return notFound()
    const body = await req.json()
    // The revision check is the same one the server makes: a write that does
    // not carry the current revision is refused *with* what is on disk, so the
    // client can put its version on the undo stack rather than lose it.
    if (body.rev != null && prev.rev != null && body.rev !== prev.rev) {
      return json({ error: 'stale revision', current: prev }, 409)
    }
    const next = { ...prev, ...body, id: prev.id, rev: (prev.rev ?? 0) + 1, updatedAt: Date.now() }
    await dbPut('timelines', next)
    return json(next)
  }],

  ['DELETE', /^\/api\/timelines\/([^/]+)$/, async (m) => {
    const t = await dbGet('timelines', m[1])
    if (!t) return notFound()
    await dbDel('timelines', t.id)
    if (t.projectId) {
      const p = await dbGet('projects', t.projectId)
      if (p) {
        p.timelineIds = (p.timelineIds ?? []).filter((id) => id !== t.id)
        await dbPut('projects', p)
      }
    }
    return json({ ok: true })
  }],

  // One browser, one editor: a claim is always yours and never contended.
  ['POST', /^\/api\/timelines\/([^/]+)\/claim$/, async (m) => {
    const t = await dbGet('timelines', m[1])
    return t ? json(t) : notFound()
  }],

  /* -------------------------------------------------------- transcripts */
  ['GET', /^\/api\/transcripts$/, async () => {
    const all = await dbAll('transcripts')
    return json(all.map(({ cues, ...row }) => ({ ...row, cueCount: cues?.length ?? 0 })))
  }],

  /**
   * An upload is the *file*: SRT, WebVTT or Whisper JSON as text, parsed here
   * by the same code the server parses it with. Reading this as JSON — which is
   * what it did at first — quietly stored an unparsed blob with no cues in it.
   */
  ['POST', /^\/api\/transcripts$/, async (m, req, body) => {
    const url = new URL(req.url, location.origin)
    const name = url.searchParams.get('name') ?? 'transcript'
    const mediaFilename = url.searchParams.get('media') || null
    const text = typeof body === 'string' ? body : body instanceof Blob ? await body.text() : await req.text()

    const parsed = parseTranscript(name, text)
    if (!parsed.ok) return json({ error: parsed.error }, 400)

    const t = finalizeTranscript({
      id: uid('tr_'),
      name,
      mediaFilename,
      source: parsed.source,
      createdAt: Date.now(),
    }, parsed.cues)
    await dbPut('transcripts', t)
    return json({ ...t, cues: undefined, cueCount: t.cues.length }, 201)
  }],

  ['GET', /^\/api\/transcripts\/([^/]+)$/, async (m) => {
    const t = await dbGet('transcripts', m[1])
    return t ? json(t) : notFound()
  }],

  /*
   * The same three edits the server allows, and the same derivation after them.
   *
   * This was a bare spread of the request body over the stored document, which
   * looked equivalent and was not: `wordLevel` and `durationMs` are *derived*
   * from the cues, and `finalizeTranscript` is what sorts them, drops the empty
   * ones and recomputes both. Merging new cues without it left a transcript
   * claiming word-level timings it no longer had and a length from before the
   * edit — and, because the spread took whatever the body held, let any other
   * field be written onto the document as well.
   */
  ['PUT', /^\/api\/transcripts\/([^/]+)$/, async (m, req) => {
    const prev = await dbGet('transcripts', m[1])
    if (!prev) return notFound()
    const body = await req.json().catch(() => ({}))
    const hasCues = Array.isArray(body.cues)
    const hasName = typeof body.name === 'string'
    const hasMedia = 'mediaFilename' in body
    if (!hasCues && !hasName && !hasMedia) return json({ error: 'nothing to change: send cues, name or mediaFilename' }, 400)

    let next = prev
    if (hasCues) {
      const cues = body.cues
        .map((q) => ({
          startMs: Number(q?.startMs) || 0,
          endMs: Number(q?.endMs) || 0,
          text: String(q?.text ?? '').trim(),
          ...(Array.isArray(q?.words) ? { words: q.words } : {}),
        }))
        .filter((q) => q.text)
      next = finalizeTranscript(next, cues)
    }
    if (hasName) {
      const name = String(body.name).trim().slice(0, 120)
      if (name) next = { ...next, name }
    }
    if (hasMedia) {
      next = { ...next, mediaFilename: typeof body.mediaFilename === 'string' && body.mediaFilename ? body.mediaFilename : null }
    }
    next = { ...next, id: prev.id, updatedAt: Date.now() }
    await dbPut('transcripts', next)
    return json(next)
  }],

  ['PATCH', /^\/api\/transcripts\/([^/]+)\/cues$/, async (m, req) => {
    const prev = await dbGet('transcripts', m[1])
    if (!prev) return notFound()
    const body = await req.json()
    // A window replacement, not a merge: cues inside it go, ones that straddle
    // an edge are cut there, and the whole list is renormalised afterwards.
    const next = finalizeTranscript(
      { ...prev, updatedAt: Date.now() },
      body.fromMs != null && body.toMs != null
        ? replaceCuesInWindow(prev.cues ?? [], body.fromMs, body.toMs, body.cues ?? [])
        : (body.cues ?? prev.cues ?? []),
    )
    await dbPut('transcripts', next)
    return json(next)
  }],

  ['DELETE', /^\/api\/transcripts\/([^/]+)$/, async (m) => {
    await dbDel('transcripts', m[1])
    return json({ ok: true })
  }],

  /* -------------------------------------------------------------- media */
  ['GET', /^\/api\/media$/, async () => {
    const all = await dbAll('mediaMeta')
    return json(all.map(({ _peaks, ...m }) => m))
  }],

  ['POST', /^\/api\/media$/, async (m, req, body) => {
    const url = new URL(req.url, location.origin)
    const name = url.searchParams.get('name') || 'clip.mp4'
    const blob = body instanceof Blob ? body : new Blob([await req.arrayBuffer()], { type: guessMime(name) })
    const filename = safeName(name, await dbAll('mediaMeta'))
    await writeFile('media', filename, blob)
    // Probed from what is now on disk, so the copy in memory can go.
    const stored = (await readFile('media', filename)) ?? blob
    const meta = await probeMedia(stored, filename, name)
    await dbPut('mediaMeta', meta)
    const { _peaks, ...clean } = meta
    return json(clean, 201)
  }],

  ['GET', /^\/api\/media\/([^/]+)\/peaks$/, async (m) => {
    const meta = await dbGet('mediaMeta', decodeURIComponent(m[1]))
    if (!meta?._peaks) return notFound()
    return json(meta._peaks)
  }],

  ['GET', /^\/api\/media\/([^/]+)$/, async (m) => {
    const meta = await dbGet('mediaMeta', decodeURIComponent(m[1]))
    if (!meta) return notFound()
    const { _peaks, ...clean } = meta
    return json(clean)
  }],

  ['DELETE', /^\/api\/media\/([^/]+)$/, async (m) => {
    const filename = decodeURIComponent(m[1])
    await removeFile('media', filename)
    await dbDel('mediaMeta', filename)
    dropUrl(filename)
    return json({ ok: true })
  }],

  /**
   * Pull a file in from a URL.
   *
   * With a server this went through it, which sidestepped CORS. Here the page
   * fetches it directly, so it works for anything served with permissive
   * headers and fails with a reason for anything else — which is better than a
   * proxy that quietly makes every URL on the internet reachable from a page.
   *
   * A `data:` URL is the file itself: an agent that holds the bytes has no
   * other way to hand them to a page, since a tool call is JSON. It is decoded
   * here, capped, and sniffed before it is named — the same decision the
   * server makes, from the same code.
   */
  ['POST', /^\/api\/media\/from-url$/, async (m, req) => {
    const { url, name } = await req.json().catch(() => ({}))
    if (!url) return json({ error: 'missing url' }, 400)
    const arrived = await fetchIncoming('media', url, name, 'clip.mp4')
    if (!arrived.ok) return json({ error: arrived.error }, arrived.status)
    const { blob, base } = arrived
    const filename = safeName(base, await dbAll('mediaMeta'))
    await writeFile('media', filename, blob)
    const stored = (await readFile('media', filename)) ?? blob
    const meta = await probeMedia(stored, filename, base)
    await dbPut('mediaMeta', meta)
    const { _peaks, ...clean } = meta
    return json(clean, 201)
  }],

  /* ------------------------------------------------------------- assets */
  ['GET', /^\/api\/assets$/, async () => json(await dbAll('assetMeta'))],

  ['POST', /^\/api\/assets$/, async (m, req, body) => {
    const url = new URL(req.url, location.origin)
    const name = url.searchParams.get('name') || 'asset.png'
    const blob = body instanceof Blob ? body : new Blob([await req.arrayBuffer()], { type: guessMime(name) })
    const filename = safeName(name, await dbAll('assetMeta'))
    await writeFile('assets', filename, blob)
    const meta = await probeAsset(blob, filename, name)
    await dbPut('assetMeta', meta)
    return json(meta, 201)
  }],

  ['POST', /^\/api\/assets\/from-url$/, async (m, req) => {
    const { url, name } = await req.json().catch(() => ({}))
    if (!url) return json({ error: 'missing url' }, 400)
    const arrived = await fetchIncoming('asset', url, name, 'asset.png')
    if (!arrived.ok) return json({ error: arrived.error }, arrived.status)
    const { blob, base } = arrived
    const filename = safeName(base, await dbAll('assetMeta'))
    await writeFile('assets', filename, blob)
    const meta = await probeAsset(blob, filename, base)
    await dbPut('assetMeta', meta)
    return json(meta, 201)
  }],

  ['DELETE', /^\/api\/assets\/([^/]+)$/, async (m) => {
    const filename = decodeURIComponent(m[1])
    await removeFile('assets', filename)
    await dbDel('assetMeta', filename)
    dropUrl(`asset:${filename}`)
    return json({ ok: true })
  }],

  /* ------------------------------------------------------------- frames */

  /**
   * A captured frame. The server writes it to disk and hands back a URL; here
   * it goes into OPFS and comes back as an object URL, which is the same
   * promise — a thing you can look at and put in a clip.
   */
  ['POST', /^\/api\/frame$/, async (m, req, body) => {
    const url = new URL(req.url, location.origin)
    const raw = url.searchParams.get('name') ?? 'frame'
    const safe = (raw.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'frame')
    const blob = body instanceof Blob ? body : new Blob([await req.arrayBuffer()], { type: 'image/png' })
    if (!blob.size) return json({ error: 'empty body' }, 400)

    // Two quite different jobs behind one route. `dest=assets` means keep it —
    // it becomes a still you can put in a clip. Without it, the frame is being
    // *looked at*, and by an agent as often as by a person.
    if (url.searchParams.get('dest') !== 'assets') {
      // A blob: URL is the obvious answer and the wrong one: it resolves only
      // inside the page that made it, so an agent handed one has been handed
      // nothing. A data URI travels. Downscaled, because the point is to see
      // the frame, and two megabytes of PNG in a tool result helps nobody.
      const view = await downscaleToDataUri(blob, 1280)
      return json({ name: `${safe}.png`, url: view.dataUri, size: view.size, width: view.width, height: view.height, inline: true })
    }

    const filename = safeName(`${safe}.png`, await dbAll('assetMeta'))
    await writeFile('assets', filename, blob)
    const meta = await probeAsset(blob, filename, `${safe}.png`)
    await dbPut('assetMeta', meta)
    return json({ ...meta, size: blob.size, url: (await assetUrl(filename)) ?? meta.url, asset: true })
  }],

  /* -------------------------------------------------------------- proxy */

  /**
   * The rasterizer inlines every external font and image, because an SVG
   * loaded into an `<img>` cannot reach the network. The server did that with
   * a proxy to dodge CORS; here the page fetches it itself, which works for
   * anything that allows cross-origin reads — Google Fonts included — and
   * fails honestly for anything that does not.
   */
  ['GET', /^\/api\/asset$/, async (m, req) => {
    const target = new URL(req.url, location.origin).searchParams.get('url')
    if (!target) return json({ error: 'missing url' }, 400)
    try {
      const res = await originalFetch(target, { mode: 'cors', credentials: 'omit' })
      if (!res.ok) return json({ error: `upstream ${res.status}` }, 502)
      const blob = await res.blob()
      const dataUri = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })
      return json({ dataUri, mime: blob.type, size: blob.size })
    } catch (err) {
      // A font that will not allow a cross-origin read simply is not inlined;
      // the clip falls back to a system face rather than failing to render.
      return json({ error: `could not fetch ${target}: ${err?.message ?? err}` }, 502)
    }
  }],

  /* ----------------------------------------------------------- captions */

  /**
   * A subtitle file. Pure text, so there was never anything here a server had
   * to do — the only reason it lived there was that the exports folder did.
   */
  ['POST', /^\/api\/export\/captions$/, async (m, req) => {
    const body = await req.json().catch(() => ({}))
    if (!Array.isArray(body.cues)) return json({ error: 'cues must be an array' }, 400)
    const format = ['srt', 'vtt', 'txt'].includes(body.format) ? body.format : 'srt'
    const cues = body.cues
      .map((q) => ({
        startMs: Math.max(0, Math.round(Number(q?.startMs) || 0)),
        endMs: Math.round(Number(q?.endMs) || 0),
        text: String(q?.text ?? '').trim(),
      }))
      .filter((q) => q.text && q.endMs > q.startMs)
      .sort((a, b) => a.startMs - b.startMs)
    if (!cues.length) return json({ error: 'no captions in that range' }, 400)

    const text =
      format === 'srt' ? toSrt(cues)
      : format === 'vtt' ? toVtt(cues)
      : cues.map((q) => q.text.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n'
    const safe = String(body.name ?? 'captions').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'captions'
    const filename = `${safe}.${format}`
    const url = URL.createObjectURL(new Blob([text], { type: format === 'vtt' ? 'text/vtt' : 'text/plain' }))
    return json({ ok: true, name: filename, url, size: new TextEncoder().encode(text).length, count: cues.length, format })
  }],

  /* ------------------------------------------------------------ exports */
  // Renders are handed straight to the browser's downloads rather than kept,
  // so there is no export library to list.
  ['GET', /^\/api\/exports$/, async () => json([])],
]

/** A filename that is safe and not already taken. */
function safeName(name, existing) {
  const clean = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'file'
  const taken = new Set(existing.map((e) => e.filename))
  if (!taken.has(clean)) return clean
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ''
  return `${stem}-${Math.random().toString(36).slice(2, 8)}${ext}`
}

/**
 * The bytes behind a URL an agent gave, as a Blob with the name they should
 * be stored under — from a data: URL decoded here, or an http(s) one fetched
 * by the page. Only the head of a fetched file is read for the sniff; the
 * Blob itself stays wherever the browser put it.
 */
async function fetchIncoming(kind, url, name, fallback) {
  if (isDataUrl(url)) {
    const d = decodeDataUrl(url, { cap: INLINE_CAPS[kind], kind: kind === 'media' ? 'media file' : 'asset' })
    if (!d.ok) return { ok: false, status: d.status, error: d.error }
    const named = nameIncoming(kind, d.bytes, { name, mime: d.mime, strict: true })
    if (!named.ok) return { ok: false, status: 415, error: named.error }
    return { ok: true, blob: new Blob([d.bytes], { type: named.mime }), base: named.name }
  }
  try {
    const res = await originalFetch(url, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) return { ok: false, status: 502, error: `upstream ${res.status}` }
    const blob = await res.blob()
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer())
    const base = name || decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || fallback)
    const named = nameIncoming(kind, head, { name: base, mime: res.headers.get('content-type') ?? blob.type })
    if (!named.ok) return { ok: false, status: 415, error: named.error }
    return { ok: true, blob: blob.type === named.mime ? blob : new Blob([blob], { type: named.mime }), base: named.name }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error:
        `could not fetch ${url}: ${err?.message ?? err}. This build has no server, so the page fetches it itself and ` +
        `the file's host must allow cross-origin reads (CORS) — or, if you hold the bytes, pass them as a data: URL instead.`,
    }
  }
}

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
}
const guessMime = (name) => MIME[String(name).split('.').pop()?.toLowerCase()] ?? 'application/octet-stream'

async function probeAsset(file, filename, originalName = null) {
  const isImage = file.type.startsWith('image/')
  let width = null, height = null
  if (isImage) {
    try {
      const bmp = await createImageBitmap(file)
      width = bmp.width
      height = bmp.height
      bmp.close()
    } catch {
      /* an SVG without intrinsic size, or something that is not really an image */
    }
  }
  return {
    id: filename,
    filename,
    name: originalName || file.name || filename,
    url: `/assets/${filename}`,
    mime: file.type || guessMime(filename),
    kind: isImage ? 'image' : file.type.startsWith('font/') ? 'font' : 'file',
    size: file.size,
    width,
    height,
    modified: Date.now(),
  }
}

/* ------------------------------------------------------------- install */

let installed = false
/** The untouched `fetch`, kept so the proxy route can reach the network. */
let originalFetch = typeof window !== 'undefined' ? window.fetch.bind(window) : fetch

/**
 * Route `/api/*` here instead of over the network.
 *
 * Anything not matched falls through to the real `fetch`, so a hybrid — local
 * data, a server that still does one thing — needs no extra machinery.
 */
export function install() {
  if (installed) return
  installed = true
  document.addEventListener('visibilitychange', () => { reprobePending().catch(() => {}) })
  const original = window.fetch.bind(window)
  originalFetch = original
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    // Same origin AND /api/, not just the path. Matching on the path alone
    // meant this stood in front of every other server too: a local speech or
    // model endpoint at http://localhost:11434/api/… had its request eaten
    // here and answered with "needs the Klipvia server", which reads exactly
    // like the endpoint being down. Only this page's own API belongs to us.
    let target
    try {
      target = new URL(url, location.href)
    } catch {
      return original(input, init)
    }
    if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) return original(input, init)
    const path = target.pathname

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const req = input instanceof Request ? input : new Request(new URL(url, location.origin), init)

    for (const [verb, pattern, handler] of routes) {
      if (verb !== method) continue
      const m = pattern.exec(path)
      if (!m) continue
      try {
        // The original body, not a copy: an import is a Blob and must stay one.
        return await handler(m, req, init?.body ?? null)
      } catch (err) {
        return json({ error: String(err?.message ?? err) }, 500)
      }
    }
    // Everything the browser cannot do is an honest 501 rather than a hang.
    return json({ error: `${method} ${path} needs the Klipvia server; this build runs in the browser alone`, local: true }, 501)
  }
}

/**
 * Anything that could not be measured when it was imported, measured now.
 *
 * A background tab loads no media, so a file imported into one comes in
 * knowing its length and its sound but not its size. This runs when the tab is
 * looked at again, which is the moment the browser will actually answer.
 */
async function reprobePending() {
  if (document.visibilityState !== 'visible') return
  let all = []
  try {
    all = await dbAll('mediaMeta')
  } catch {
    return
  }
  for (const meta of all) {
    if (!meta.needsProbe) continue
    const file = await readFile('media', meta.filename)
    if (!file) continue
    // The display name comes from the *original* file; a File read back out of
    // OPFS is named after the sanitised filename, and letting that win would
    // rename "Interview take 3.mov" to "Interview-take-3.mov" behind your back.
    const fresh = await probeMedia(file, meta.filename, meta.name)
    if (fresh.needsProbe) continue
    await dbPut('mediaMeta', { ...meta, ...fresh })
  }
}

/* ---------------------------------------------------------- seeding */

/*
 * The three writes the demo needs, exposed so `demo.js` can stay a description
 * of the demo and know nothing about IndexedDB.
 */
export const putProject = (p) => dbPut('projects', p)
export const putTimeline = (t) => dbPut('timelines', t)

export async function putTranscript(name, text) {
  const parsed = parseTranscript(name, text)
  if (!parsed.ok) throw new Error(parsed.error)
  const t = finalizeTranscript(
    { id: uid('tr_'), name, mediaFilename: null, source: parsed.source, createdAt: Date.now() },
    parsed.cues,
  )
  await dbPut('transcripts', t)
  return t
}

/**
 * Can this browser actually store anything?
 *
 * Everything below is wrapped by `install()`, which turns a thrown handler
 * into a 500 so a single broken route cannot take the editor down with it.
 * That is right for a route and wrong for the storage under all of them: a
 * browser refusing this origin any storage — Incognito with site data blocked,
 * a strict privacy setting, an enterprise policy — produced a stream of 500s
 * and an editor that opened, responded to every click and kept nothing. An
 * invisible failure, in the one app where storage *is* the back end.
 *
 * So it is asked once, before anything else, and asked properly: opening the
 * database is not enough, because a quota of zero lets `open` succeed and
 * fails on the first write. Throws with something worth reading.
 */
export async function probeStorage() {
  const id = '__klipvia_probe__'
  try {
    await dbPut('projects', { id, at: Date.now() })
    const back = await dbGet('projects', id)
    if (!back) throw new Error('a write to IndexedDB read back as nothing')
    await dbDel('projects', id)
  } catch (err) {
    const why = err?.message ?? String(err)
    const e = new Error(`this browser is not letting Klipvia store anything (${why})`)
    e.name = err?.name ?? 'StorageError'
    e.storage = true
    throw e
  }
}

/** True when this browser holds nothing yet — a genuinely first visit. */
export async function isEmpty() {
  try {
    return (await dbAll('projects')).length === 0
  } catch {
    return false
  }
}

/* ------------------------------------------------------- keeping it */

/**
 * Ask the browser not to throw the work away.
 *
 * Without this, IndexedDB and OPFS are "best effort": under storage pressure a
 * browser may evict an origin's data with no warning and no undo. `persist()`
 * moves the origin to durable storage, and in Chrome it is granted silently to
 * a site the person actually uses. It is the difference between a local-first
 * app and a cache.
 */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return { supported: false, persisted: false }
    const already = await navigator.storage.persisted()
    const persisted = already || (await navigator.storage.persist())
    return { supported: true, persisted }
  } catch {
    return { supported: false, persisted: false }
  }
}

/** How much room the work is taking, and how much there is. */
export async function storageUse() {
  const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {}
  const media = await dbAll('mediaMeta').catch(() => [])
  const assets = await dbAll('assetMeta').catch(() => [])
  const projects = await dbAll('projects').catch(() => [])
  return {
    usage,
    quota,
    persisted: (await navigator.storage?.persisted?.()) ?? false,
    counts: {
      projects: projects.length,
      media: media.length,
      mediaBytes: media.reduce((n, m) => n + (m.size ?? 0), 0),
      assets: assets.length,
      assetBytes: assets.reduce((n, a) => n + (a.size ?? 0), 0),
    },
  }
}

/**
 * Everything, gone. Offered because a local-first app that cannot be emptied
 * is a local-first app you cannot trust with anything.
 */
export async function eraseEverything() {
  for (const key of [...urlCache.keys()]) dropUrl(key)
  try {
    const root = await navigator.storage.getDirectory()
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true }).catch(() => {})
  } catch { /* nothing there */ }
  const db = await openDb().catch(() => null)
  if (db) {
    db.close()
    dbPromise = null
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })

  // And what the editor itself left in localStorage: which project was open,
  // panel heights, remembered formats, and the cached timeline thumbnails —
  // which are base64 pictures of somebody's work and by far the largest of
  // them. "Erase everything" that leaves those behind is not the promise the
  // panel makes. Prefix-matched, so a key added later is caught without
  // anyone remembering to come back here.
  // Nothing puts anything in Cache Storage today. It is swept anyway, because
  // the day something does — a downloaded model, a cached font — is not the day
  // anybody will remember that "erase everything" has an exception.
  try {
    for (const key of await caches.keys()) await caches.delete(key)
  } catch {
    /* no Cache Storage here */
  }

  try {
    const ours = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('animationhtml:') || key.startsWith('klipvia:'))) ours.push(key)
    }
    for (const key of ours) localStorage.removeItem(key)
  } catch { /* a browser that will not let us read it will not let us write it either */ }
}

/**
 * A whole project as one file: its documents, and every byte of media and
 * assets it refers to.
 *
 * This is what makes "your work never leaves your browser" a promise rather
 * than a trap. It is a plain zip, written by hand because the format's stored
 * (uncompressed) form is short enough to justify not shipping a library for it.
 */
export async function exportProjectFile(projectId) {
  const project = await dbGet('projects', projectId)
  if (!project) throw new Error('no such project')
  const timelines = []
  for (const id of project.timelineIds ?? []) {
    const t = await dbGet('timelines', id)
    if (t) timelines.push(t)
  }

  // Only what this project actually uses.
  const wanted = { media: new Set(), assets: new Set(), transcripts: new Set() }
  for (const t of timelines) {
    for (const track of t.tracks ?? []) {
      for (const item of track.items ?? []) {
        if (item.type === 'media') wanted.media.add(item.sourceId)
        if (item.type === 'image') wanted.assets.add(item.sourceId)
        if (item.type === 'caption') wanted.transcripts.add(item.sourceId)
      }
    }
  }
  for (const clip of project.clips ?? []) {
    for (const m of `${clip.html}${clip.css}`.matchAll(/\/assets\/([^"'`)\s>]+)/g)) {
      wanted.assets.add(decodeURIComponent(m[1]))
    }
  }

  const transcripts = []
  for (const id of wanted.transcripts) {
    const t = await dbGet('transcripts', id)
    if (t) transcripts.push(t)
  }
  const mediaMeta = (await dbAll('mediaMeta')).filter((m) => wanted.media.has(m.filename))
  const assetMeta = (await dbAll('assetMeta')).filter((a) => wanted.assets.has(a.filename))

  const files = [
    ['klipvia.json', new Blob([JSON.stringify({
      format: 'klipvia-project@1',
      exportedAt: new Date().toISOString(),
      project,
      timelines,
      transcripts,
      // `_peaks` is derived; it rebuilds on import and would double the file.
      media: mediaMeta.map(({ _peaks, ...m }) => m),
      assets: assetMeta,
    }, null, 2)], { type: 'application/json' })],
  ]
  for (const m of mediaMeta) {
    const f = await readFile('media', m.filename)
    if (f) files.push([`media/${m.filename}`, f])
  }
  for (const a of assetMeta) {
    const f = await readFile('assets', a.filename)
    if (f) files.push([`assets/${a.filename}`, f])
  }
  return { blob: await makeZip(files), name: `${(project.name || 'project').replace(/[^A-Za-z0-9._-]+/g, '-')}.klipvia.zip` }
}

/** Read back what `exportProjectFile` wrote. */
export async function importProjectFile(file) {
  // Everything here is a file somebody chose from a picker, so every way it
  // can be the wrong file gets a sentence rather than a parser's complaint
  // about byte 4 — "Unexpected token" tells nobody they picked a PDF.
  const entries = await readZip(file).catch((err) => {
    throw new Error(`"${file.name}" is not a readable zip (${err?.message ?? err})`)
  })
  const manifest = entries.get('klipvia.json')
  if (!manifest) throw new Error(`"${file.name}" is a zip, but not a Klipvia project file`)
  let doc
  try {
    doc = JSON.parse(await manifest.text())
  } catch (err) {
    throw new Error(`the project file inside "${file.name}" is damaged (${err?.message ?? err})`)
  }
  if (!doc.project) throw new Error('that file has no project in it')

  // New ids throughout, so importing twice gives two projects rather than a
  // silent overwrite of the one already open. Everything a timeline points at
  // has to move with it, or the copy quietly shares state with the original.
  const idMap = new Map()
  const freshId = (old, prefix) => {
    if (!idMap.has(old)) idMap.set(old, uid(prefix))
    return idMap.get(old)
  }

  const projectId = freshId(doc.project.id, 'p_')
  const timelines = (doc.timelines ?? []).map((t) => ({
    ...t,
    id: freshId(t.id, 's_'),
    projectId,
    rev: 1,
    updatedAt: Date.now(),
  }))

  /*
   * Transcripts get fresh ids for the same reason timelines do.
   *
   * They used to be written straight back under the ids in the file, which
   * meant importing a project overwrote any transcript you already had with
   * that id — your caption edits gone — and left both projects pointing at the
   * one document, so fixing a typo in either changed both. Two projects that
   * came from the same export are two projects.
   */
  const transcripts = (doc.transcripts ?? []).map((t) => ({ ...t, id: freshId(t.id, 'tr_') }))

  /*
   * Media and assets are keyed by filename, not by id, so the same question
   * arrives in a different shape: a file called `intro.mp4` in the zip and a
   * different `intro.mp4` already here.
   *
   * Renaming every time would duplicate hundreds of megabytes whenever someone
   * re-imports their own project. Overwriting silently swaps one person's
   * footage for another's. So it is treated as the same file only when the
   * name, the byte count and the length all match — and given a fresh name
   * otherwise, with everything that referred to it moved across.
   */
  const nameMap = { media: new Map(), assets: new Map() }
  const sameFile = (a, b) => a && b && a.size === b.size && (a.durationMs ?? null) === (b.durationMs ?? null)

  async function placeFiles(kind, incoming, store) {
    const existing = await dbAll(store)
    const byName = new Map(existing.map((e) => [e.filename, e]))
    const taken = [...existing]
    for (const meta of incoming) {
      if (byName.has(meta.filename) && !sameFile(byName.get(meta.filename), meta)) {
        const fresh = safeName(meta.filename, taken)
        nameMap[kind].set(meta.filename, fresh)
        taken.push({ filename: fresh })
      }
    }
  }
  await placeFiles('media', doc.media ?? [], 'mediaMeta')
  await placeFiles('assets', doc.assets ?? [], 'assetMeta')

  const renamed = (kind, name) => nameMap[kind].get(name) ?? name

  /**
   * A meta row moved to a new filename.
   *
   * Both stores key on `id`, and `probeMedia`/`probeAsset` set `id` to the
   * filename. Renaming the `filename` field alone therefore writes the row
   * back under the *old* key — clobbering the very file the rename existed to
   * protect, and leaving its bytes on disk with nothing pointing at them. The
   * id and the url move with the name.
   */
  const renameMeta = (kind, meta, folder) => {
    const filename = renamed(kind, meta.filename)
    if (filename === meta.filename) return meta
    return { ...meta, id: filename, filename, url: `/${folder}/${filename}` }
  }

  for (const [path, blob] of entries) {
    if (path.startsWith('media/')) await writeFile('media', renamed('media', path.slice(6)), blob)
    else if (path.startsWith('assets/')) await writeFile('assets', renamed('assets', path.slice(7)), blob)
  }

  // Now every reference: nested timelines and captions by id, footage and
  // stills by filename.
  for (const t of timelines) {
    for (const track of t.tracks ?? []) {
      for (const item of track.items ?? []) {
        if (item.type === 'timeline' || item.type === 'caption') {
          if (idMap.has(item.sourceId)) item.sourceId = idMap.get(item.sourceId)
        } else if (item.type === 'media') {
          item.sourceId = renamed('media', item.sourceId)
        } else if (item.type === 'image') {
          item.sourceId = renamed('assets', item.sourceId)
        }
      }
    }
  }
  // A clip reaches its assets through /assets/NAME in its own markup.
  const clips = (doc.project.clips ?? []).map((clip) => {
    let { html, css } = clip
    for (const [from, to] of nameMap.assets) {
      const enc = encodeURIComponent(from)
      for (const n of new Set([from, enc])) {
        html = html?.replaceAll(`/assets/${n}`, `/assets/${to}`)
        css = css?.replaceAll(`/assets/${n}`, `/assets/${to}`)
      }
    }
    return { ...clip, html, css }
  })

  // The manifest already knows how long each file is, how big, and whether it
  // has sound — all of it measured when the file was first imported. Only the
  // waveform was left out, to keep the file small, and that is rebuilt in the
  // background rather than making the import wait on a decode per file.
  const rebuild = []
  for (const m of doc.media ?? []) {
    const meta = renameMeta('media', m, 'media')
    await dbPut('mediaMeta', { ...meta, hasPeaks: false, _peaks: null })
    rebuild.push(meta.filename)
  }
  rebuildPeaks(rebuild)
  for (const a of doc.assets ?? []) await dbPut('assetMeta', renameMeta('assets', a, 'assets'))
  for (const t of transcripts) await dbPut('transcripts', t)
  for (const t of timelines) await dbPut('timelines', t)

  // Importing your own project twice is the common case — a backup, a copy to
  // experiment on — and three rows all reading "Klipvia demo" tells you
  // nothing about which is which.
  const names = new Set((await dbAll('projects')).map((p) => p.name))
  let name = doc.project.name ?? 'Imported project'
  for (let n = 2; names.has(name); n++) name = `${doc.project.name} (${n})`

  const project = {
    ...doc.project,
    id: projectId,
    name,
    clips,
    timelineIds: timelines.map((t) => t.id),
    mainTimelineId: idMap.get(doc.project.mainTimelineId) ?? timelines[0]?.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await dbPut('projects', project)
  return project
}

/**
 * Waveforms for freshly imported files, one at a time, out of the way.
 *
 * A decode is seconds of work and the timeline is perfectly usable without the
 * picture of the sound, so this runs behind the import rather than inside it.
 */
async function rebuildPeaks(filenames) {
  for (const filename of filenames) {
    try {
      const meta = await dbGet('mediaMeta', filename)
      if (!meta || meta.hasPeaks) continue
      const file = await readFile('media', filename)
      if (!file || file.size > DECODE_CAP_BYTES) continue
      const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000)
      const buf = await ac.decodeAudioData(await file.arrayBuffer())
      const peaks = buildPeaks(buf)
      await dbPut('mediaMeta', { ...meta, hasPeaks: true, peaksPerSecond: peaks.peaksPerSecond, _peaks: peaks })
    } catch {
      /* a file with no decodable sound simply has no waveform */
    }
  }
}

/* ------------------------------------------------------------------- zip */
/*
 * Store-only zip, written and read by hand.
 *
 * Media is already compressed, so deflating it would cost seconds to save
 * nothing; and a zip with no compression is a header, the bytes, and a central
 * directory. That is small enough to be worth not shipping a library for.
 */

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function makeZip(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0

  for (const [name, blob] of files) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const nameBytes = enc.encode(name)
    const crc = crc32(bytes)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // names are UTF-8
    local.setUint16(8, 0, true) // stored
    local.setUint32(14, crc, true)
    local.setUint32(18, bytes.length, true)
    local.setUint32(22, bytes.length, true)
    local.setUint16(26, nameBytes.length, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes)

    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true)
    dir.setUint16(4, 20, true)
    dir.setUint16(6, 20, true)
    dir.setUint16(8, 0x0800, true)
    dir.setUint16(10, 0, true)
    dir.setUint32(16, crc, true)
    dir.setUint32(20, bytes.length, true)
    dir.setUint32(24, bytes.length, true)
    dir.setUint16(28, nameBytes.length, true)
    dir.setUint32(42, offset, true)
    central.push(new Uint8Array(dir.buffer), nameBytes)

    offset += 30 + nameBytes.length + bytes.length
  }

  const centralBytes = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralBytes, true)
  end.setUint32(16, offset, true)

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' })
}

async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(buf.buffer)
  const dec = new TextDecoder()
  const out = new Map()
  let i = 0
  while (i < buf.length - 4 && view.getUint32(i, true) === 0x04034b50) {
    const method = view.getUint16(i + 8, true)
    const size = view.getUint32(i + 18, true)
    const nameLen = view.getUint16(i + 26, true)
    const extraLen = view.getUint16(i + 28, true)
    const name = dec.decode(buf.subarray(i + 30, i + 30 + nameLen))
    const start = i + 30 + nameLen + extraLen
    if (method !== 0) throw new Error(`"${name}" is compressed; this reader only takes stored entries`)
    out.set(name, new Blob([buf.subarray(start, start + size)]))
    i = start + size
  }
  if (!out.size) throw new Error('that does not look like a zip')
  return out
}

/** True when this page has no server behind it. Decided once, at boot. */
export async function serverAvailable() {
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return false
    return !(await r.json()).local
  } catch {
    return false
  }
}
