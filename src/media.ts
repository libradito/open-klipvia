/**
 * Global media library — video and audio files a sequence can cut.
 *
 * Deliberately parallel to `assets.ts`, with one extra job: every file is
 * probed on the way in and the result is cached in a sidecar, because a
 * timeline cannot lay out an item without knowing how long the source runs,
 * and re-probing a 4K file on every list would make the library unusable.
 *
 * Files are served from /media/<filename> with byte-range support — the
 * browser's own <video> element does the preview decode, and it will not
 * scrub at all against a server that answers every request with the whole file.
 */

import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { saveAsset, writeAssetMeta, type Asset } from './assets'

export const MEDIA_DIR = join(process.cwd(), 'data', 'media')
export const MEDIA_META_DIR = join(MEDIA_DIR, '.meta')

export const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024

/** extension -> [mime, kind] */
const ALLOWED: Record<string, [string, 'video' | 'audio']> = {
  '.mp4': ['video/mp4', 'video'],
  '.m4v': ['video/mp4', 'video'],
  '.mov': ['video/quicktime', 'video'],
  '.webm': ['video/webm', 'video'],
  '.mkv': ['video/x-matroska', 'video'],
  '.avi': ['video/x-msvideo', 'video'],
  '.wav': ['audio/wav', 'audio'],
  '.mp3': ['audio/mpeg', 'audio'],
  '.m4a': ['audio/mp4', 'audio'],
  '.aac': ['audio/aac', 'audio'],
  '.flac': ['audio/flac', 'audio'],
  '.ogg': ['audio/ogg', 'audio'],
  '.opus': ['audio/ogg', 'audio'],
}

export interface MediaItem {
  filename: string
  name: string
  url: string
  mime: string
  kind: 'video' | 'audio'
  size: number
  modified: number

  durationMs: number
  width: number | null
  height: number | null
  fps: number | null
  hasVideo: boolean
  hasAudio: boolean
  sampleRate: number | null
  channels: number | null
  /** Codec names, purely informational in the UI. */
  vcodec: string | null
  acodec: string | null

  posterUrl: string | null
  /** Waveform resolution; the samples themselves come from /api/media/:f/peaks. */
  peaksPerSecond: number
  hasPeaks: boolean
}

export function mediaMimeFor(filename: string): { mime: string; kind: 'video' | 'audio' } | null {
  const entry = ALLOWED[extname(filename).toLowerCase()]
  return entry ? { mime: entry[0], kind: entry[1] } : null
}

/** Reject anything that could escape the media directory. */
export function safeMediaName(filename: string): string | null {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null
  }
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return null
  return mediaMimeFor(filename) ? filename : null
}

function slug(name: string): string {
  const base = basename(name, extname(name))
  return (
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .toLowerCase() || 'media'
  )
}

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return { code, stdout, stderr }
}

/* ------------------------------------------------------------------- probe */

interface Probe {
  durationMs: number
  width: number | null
  height: number | null
  fps: number | null
  hasVideo: boolean
  hasAudio: boolean
  sampleRate: number | null
  channels: number | null
  vcodec: string | null
  acodec: string | null
}

/** `30000/1001` and friends. ffprobe reports frame rates as rationals. */
function parseRate(r: string | undefined): number | null {
  if (!r) return null
  const [n, d] = r.split('/').map(Number)
  if (!Number.isFinite(n!) || !d) return Number.isFinite(n!) ? n! : null
  return Math.round((n! / d) * 1000) / 1000
}

export async function probeMedia(path: string): Promise<Probe> {
  const empty: Probe = {
    durationMs: 0, width: null, height: null, fps: null,
    hasVideo: false, hasAudio: false, sampleRate: null, channels: null,
    vcodec: null, acodec: null,
  }

  const { code, stdout } = await run([
    'ffprobe', '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', path,
  ])
  if (code !== 0) return empty

  let json: any
  try {
    json = JSON.parse(stdout)
  } catch {
    return empty
  }

  const streams: any[] = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const a = streams.find((s) => s.codec_type === 'audio')

  // Container duration is the honest one; a stream can lie or be missing it.
  const durSec =
    Number(json.format?.duration) ||
    Number(v?.duration) ||
    Number(a?.duration) ||
    0

  return {
    durationMs: Math.max(0, Math.round(durSec * 1000)),
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate),
    hasVideo: !!v,
    hasAudio: !!a,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    channels: a?.channels ?? null,
    vcodec: v?.codec_name ?? null,
    acodec: a?.codec_name ?? null,
  }
}

/* ------------------------------------------------------------------ poster */

async function makePoster(path: string, filename: string, durationMs: number): Promise<boolean> {
  // 10% in, so a fade-from-black opening does not become the poster.
  const at = Math.max(0, Math.min(durationMs * 0.1, durationMs - 100)) / 1000
  const out = join(MEDIA_META_DIR, `${filename}.jpg`)
  const { code } = await run([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', at.toFixed(3), '-i', path,
    '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4',
    out,
  ])
  return code === 0 && (await Bun.file(out).exists())
}

/* ------------------------------------------------------------------- peaks */

const PEAKS_PER_SECOND = 50
const MAX_PEAKS = 60_000
/** The fine tier, for a timeline zoomed in past where 20 ms buckets read as bars. */
const DETAIL_PER_SECOND = 500
const MAX_DETAIL = 600_000
const DECODE_RATE = 8000

/** Max |sample| per bucket, scaled to a byte. */
function bucketPeaks(samples: Int16Array, rate: number, perSecond: number): Uint8Array {
  const bucketSize = Math.max(1, Math.round(rate / perSecond))
  const count = Math.ceil(samples.length / bucketSize)
  const peaks = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    let max = 0
    const from = i * bucketSize
    const to = Math.min(samples.length, from + bucketSize)
    for (let j = from; j < to; j++) {
      const v = Math.abs(samples[j]!)
      if (v > max) max = v
    }
    peaks[i] = Math.min(255, Math.round((max / 32768) * 255))
  }
  return peaks
}

/**
 * Decode the audio once, to low-rate mono PCM, and keep the loudest sample in
 * each bucket at two resolutions: an overview the timeline draws at any zoom
 * and silence detection reads, and a fine tier it switches to when zoomed in
 * far enough that an overview bucket would be a flat bar. A waveform is the
 * only way to cut on a beat or trim to a breath; a 10 minute file takes about
 * a second here.
 *
 * The overview stays a plain array in the sidecar; the fine tier is base64,
 * because half a million numbers as JSON is four times the bytes.
 */
async function makePeaks(path: string, filename: string, durationMs: number): Promise<boolean> {
  if (durationMs <= 0) return false

  const seconds = durationMs / 1000
  const perSecond = Math.max(4, Math.min(PEAKS_PER_SECOND, Math.floor(MAX_PEAKS / seconds)))
  const detailPerSecond = Math.max(perSecond * 2, Math.min(DETAIL_PER_SECOND, Math.floor(MAX_DETAIL / seconds)))

  const p = Bun.spawn(
    [
      'ffmpeg', '-hide_banner', '-loglevel', 'error',
      '-i', path,
      '-map', 'a:0', '-ac', '1', '-ar', String(DECODE_RATE),
      '-f', 's16le', '-',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const raw = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  const drain = new Response(p.stderr).text()
  const code = await p.exited
  await drain
  if (code !== 0 || raw.byteLength < 2) return false

  const samples = new Int16Array(raw.buffer, 0, Math.floor(raw.byteLength / 2))
  const overview = bucketPeaks(samples, DECODE_RATE, perSecond)
  const detail = bucketPeaks(samples, DECODE_RATE, detailPerSecond)

  await Bun.write(join(MEDIA_META_DIR, `${filename}.peaks.json`), JSON.stringify({
    peaksPerSecond: perSecond,
    peaks: Array.from(overview),
    detail: { peaksPerSecond: detailPerSecond, base64: Buffer.from(detail).toString('base64') },
  }))
  return true
}

interface PeaksFile {
  peaksPerSecond: number
  peaks: number[]
  detail?: { peaksPerSecond: number; base64: string }
}

async function readPeaksFile(filename: string): Promise<PeaksFile | null> {
  const file = Bun.file(join(MEDIA_META_DIR, `${filename}.peaks.json`))
  if (!(await file.exists())) return null
  try {
    return (await file.json()) as PeaksFile
  } catch {
    return null
  }
}

/** The overview tier — what the timeline and silence detection use. */
export async function readPeaks(filename: string): Promise<{ peaksPerSecond: number; peaks: number[] } | null> {
  const safe = safeMediaName(filename)
  if (!safe) return null
  const stored = await readPeaksFile(safe)
  return stored ? { peaksPerSecond: stored.peaksPerSecond, peaks: stored.peaks } : null
}

/**
 * The fine tier. Sidecars written before it existed are rebuilt on first
 * request, so an older library gains it the first time someone zooms in.
 */
export async function readDetailPeaks(filename: string): Promise<{ peaksPerSecond: number; base64: string } | null> {
  const safe = safeMediaName(filename)
  if (!safe) return null
  let stored = await readPeaksFile(safe)
  if (stored && !stored.detail) {
    const rec = await getMedia(safe)
    if (rec && (await makePeaks(join(MEDIA_DIR, safe), safe, rec.durationMs))) stored = await readPeaksFile(safe)
  }
  return stored?.detail ?? null
}

/* ------------------------------------------------------------------ record */

function metaPath(filename: string) {
  return join(MEDIA_META_DIR, `${filename}.json`)
}

/** Probe, poster and waveform, cached in a sidecar next to the file. */
async function buildRecord(filename: string, size: number, modified: number): Promise<MediaItem | null> {
  const info = mediaMimeFor(filename)
  if (!info) return null

  const path = join(MEDIA_DIR, filename)
  const probe = await probeMedia(path)

  await mkdir(MEDIA_META_DIR, { recursive: true })
  const hasPoster = probe.hasVideo ? await makePoster(path, filename, probe.durationMs) : false
  const hasPeaks = probe.hasAudio ? await makePeaks(path, filename, probe.durationMs) : false

  const record: MediaItem = {
    filename,
    name: filename,
    url: `/media/${filename}`,
    mime: info.mime,
    kind: probe.hasVideo ? 'video' : 'audio',
    size,
    modified,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    vcodec: probe.vcodec,
    acodec: probe.acodec,
    posterUrl: hasPoster ? `/api/media/${filename}/poster` : null,
    peaksPerSecond: PEAKS_PER_SECOND,
    hasPeaks,
  }

  const stored = await readPeaks(filename)
  if (stored) record.peaksPerSecond = stored.peaksPerSecond

  await Bun.write(metaPath(filename), JSON.stringify(record, null, 2))
  return record
}

export async function saveMedia(
  originalName: string,
  bytes: Uint8Array,
): Promise<{ ok: true; media: MediaItem } | { ok: false; error: string }> {
  const info = mediaMimeFor(originalName)
  if (!info) {
    return { ok: false, error: `unsupported media type "${extname(originalName) || originalName}"` }
  }
  if (bytes.byteLength === 0) return { ok: false, error: 'empty file' }

  await mkdir(MEDIA_DIR, { recursive: true })
  const id = Math.random().toString(36).slice(2, 8)
  const filename = `${slug(originalName)}-${id}${extname(originalName).toLowerCase()}`
  await Bun.write(join(MEDIA_DIR, filename), bytes)

  const record = await buildRecord(filename, bytes.byteLength, Date.now())
  if (!record) return { ok: false, error: 'could not read that file' }
  if (record.durationMs <= 0) {
    // A file ffprobe cannot time cannot be laid on a timeline at all.
    await unlink(join(MEDIA_DIR, filename)).catch(() => {})
    return { ok: false, error: 'no readable audio or video stream in that file' }
  }
  // Keep the name the user recognises, not the slug.
  record.name = basename(originalName)
  await Bun.write(metaPath(filename), JSON.stringify(record, null, 2))
  return { ok: true, media: record }
}

export async function listMedia(): Promise<MediaItem[]> {
  await mkdir(MEDIA_DIR, { recursive: true })
  const names = (await readdir(MEDIA_DIR)).filter((f) => !f.startsWith('.'))
  const out: MediaItem[] = []

  for (const filename of names) {
    if (!mediaMimeFor(filename)) continue
    try {
      const st = await stat(join(MEDIA_DIR, filename))
      if (!st.isFile()) continue

      const cache = Bun.file(metaPath(filename))
      if (await cache.exists()) {
        const rec = (await cache.json()) as MediaItem
        // Trust the cache unless the file itself changed under it.
        if (rec.size === st.size) {
          out.push(rec)
          continue
        }
      }
      const rebuilt = await buildRecord(filename, st.size, st.mtimeMs)
      if (rebuilt) out.push(rebuilt)
    } catch {
      /* raced with a delete, or a file we cannot read */
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}

export async function getMedia(filename: string): Promise<MediaItem | null> {
  const safe = safeMediaName(filename)
  if (!safe) return null
  const cache = Bun.file(metaPath(safe))
  if (await cache.exists()) {
    try {
      return (await cache.json()) as MediaItem
    } catch {
      /* fall through and rebuild */
    }
  }
  try {
    const st = await stat(join(MEDIA_DIR, safe))
    return await buildRecord(safe, st.size, st.mtimeMs)
  } catch {
    return null
  }
}

export async function deleteMedia(filename: string): Promise<boolean> {
  const safe = safeMediaName(filename)
  if (!safe) return false
  const path = join(MEDIA_DIR, safe)
  if (!(await Bun.file(path).exists())) return false
  await unlink(path)
  for (const side of [`${safe}.json`, `${safe}.jpg`, `${safe}.peaks.json`]) {
    await unlink(join(MEDIA_META_DIR, side)).catch(() => {})
  }
  return true
}

/**
 * Serve a file with byte-range support.
 *
 * Chrome will not seek a <video> served without `accept-ranges`; it downloads
 * the whole thing and scrubbing stalls. This is the difference between a
 * timeline that responds and one that does not.
 */
export function rangeResponse(path: string, mime: string, size: number, rangeHeader: string | null): Response {
  const base = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  }

  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  if (!m) {
    return new Response(Bun.file(path), {
      headers: { ...base, 'content-length': String(size) },
    })
  }

  const startRaw = m[1]
  const endRaw = m[2]
  let start = startRaw ? parseInt(startRaw, 10) : 0
  let end = endRaw ? parseInt(endRaw, 10) : size - 1

  if (!startRaw && endRaw) {
    // "bytes=-500" means the last 500 bytes.
    start = Math.max(0, size - parseInt(endRaw, 10))
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { ...base, 'content-range': `bytes */${size}` },
    })
  }
  end = Math.min(end, size - 1)

  return new Response(Bun.file(path).slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    },
  })
}


/* -------------------------------------------------------------- extraction */

/**
 * Frames, frame series, sprite sheets and sub-clips, cut from a media file.
 *
 * The first three land in the asset library, where any clip can reference
 * them; the sprite sheet is the one that matters most. The rasterizer cannot
 * capture a <video>, but it inlines a CSS background-image — so a range of
 * footage laid out as a grid, played with a steps() animation, is real
 * footage inside an animation clip, masked, styled, and exported like any
 * other element.
 *
 * Caps live here, not in the UI: an agent hits this endpoint directly, and a
 * sheet that is too large is re-serialised into every exported frame.
 */

export const EXTRACT_LIMITS = {
  frames: 60,
  spriteFrames: 64,
  spriteWidth: 480,
  frameWidth: 3840,
  subclipMs: 10 * 60_000,
  /** Reversing buffers every frame, so it is capped far lower than a cut. */
  reverseMs: 3 * 60_000,
}

const stem = (filename: string) => filename.replace(/-[a-z0-9]{6}(\.[^.]+)$/i, '').replace(/\.[^.]+$/, '')
const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms))
  const m = Math.floor(t / 60_000)
  const sec = Math.floor((t % 60_000) / 1000)
  return `${m}m${String(sec).padStart(2, '0')}s${String(t % 1000).padStart(3, '0')}`
}

async function decodeFrame(path: string, ms: number, width: number, format: 'png' | 'jpg'): Promise<Uint8Array | null> {
  const args = [
    'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-ss', (Math.max(0, ms) / 1000).toFixed(3), '-i', path,
    '-frames:v', '1', '-an',
    ...(width ? ['-vf', `scale=${width}:-2`] : []),
    '-f', 'image2',
    ...(format === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '2']),
    'pipe:1',
  ]
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [bytes] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()])
  const code = await p.exited
  return code === 0 && bytes.byteLength ? new Uint8Array(bytes) : null
}

export async function extractFrame(
  filename: string,
  ms: number,
  { width = 0, format = 'png' as 'png' | 'jpg', name = '' } = {},
): Promise<{ ok: true; asset: Asset } | { ok: false; error: string }> {
  const safe = safeMediaName(filename)
  if (!safe) return { ok: false, error: 'bad media name' }
  const rec = await getMedia(safe)
  if (!rec?.hasVideo) return { ok: false, error: 'that file has no picture' }

  const at = Math.max(0, Math.min(ms, rec.durationMs - 1))
  const bytes = await decodeFrame(join(MEDIA_DIR, safe), at, Math.min(EXTRACT_LIMITS.frameWidth, width), format)
  if (!bytes) return { ok: false, error: 'no frame at that time' }

  // A name from the caller ("L4-ultima-fila") beats the media stem plus a
  // clock: an agent that saved twenty frames needs to tell them apart later.
  const base = name.trim() ? slug(name.trim()) : `${stem(safe)}-${clock(at)}`
  const saved = await saveAsset(`${base}.${format}`, bytes)
  if (!saved.ok) return saved
  await writeAssetMeta(saved.asset.filename, { origin: { source: safe, atMs: Math.round(at) } })
  return { ok: true, asset: { ...saved.asset, origin: { source: safe, atMs: Math.round(at) } } }
}

export async function extractFrames(
  filename: string,
  fromMs: number,
  toMs: number,
  { count = 0, fps = 0, width = 0, format = 'jpg' as 'png' | 'jpg' } = {},
): Promise<{ ok: true; assets: Asset[] } | { ok: false; error: string }> {
  const safe = safeMediaName(filename)
  if (!safe) return { ok: false, error: 'bad media name' }
  const rec = await getMedia(safe)
  if (!rec?.hasVideo) return { ok: false, error: 'that file has no picture' }

  const from = Math.max(0, fromMs)
  const to = Math.min(rec.durationMs, toMs > from ? toMs : rec.durationMs)
  if (to - from < 1) return { ok: false, error: 'the range is empty' }

  const times: number[] = []
  if (fps > 0) {
    for (let t = from; t < to && times.length < EXTRACT_LIMITS.frames; t += 1000 / fps) times.push(t)
  } else {
    const n = Math.max(1, Math.min(EXTRACT_LIMITS.frames, Math.round(count || 6)))
    for (let i = 0; i < n; i++) times.push(n === 1 ? from : from + ((to - from) * i) / (n - 1))
  }

  const assets: Asset[] = []
  for (const t of times) {
    const r = await extractFrame(safe, Math.min(t, rec.durationMs - 1), { width, format })
    if (r.ok) assets.push(r.asset)
  }
  return assets.length ? { ok: true, assets } : { ok: false, error: 'no frames could be decoded' }
}

export async function extractSprite(
  filename: string,
  fromMs: number,
  toMs: number,
  { fps = 10, width = 320, format = 'jpg' as 'png' | 'jpg' } = {},
): Promise<{ ok: true; asset: Asset; css: string } | { ok: false; error: string }> {
  const safe = safeMediaName(filename)
  if (!safe) return { ok: false, error: 'bad media name' }
  const rec = await getMedia(safe)
  if (!rec?.hasVideo || !rec.width || !rec.height) return { ok: false, error: 'that file has no picture' }

  const from = Math.max(0, fromMs)
  const to = Math.min(rec.durationMs, toMs > from ? toMs : from + 3000)
  const seconds = (to - from) / 1000
  if (seconds < 0.1) return { ok: false, error: 'the range is empty' }

  // Frame budget first: a longer range plays at a lower rate rather than
  // growing the sheet.
  const wantFps = Math.max(1, Math.min(30, fps))
  const rate = Math.min(wantFps, EXTRACT_LIMITS.spriteFrames / seconds)
  const wanted = Math.max(1, Math.min(EXTRACT_LIMITS.spriteFrames, Math.floor(seconds * rate)))
  // A full grid, exactly: the stepped animation walks every tile of every
  // row, so a partial last row would flash blank tiles once a loop.
  const cols = Math.ceil(Math.sqrt(wanted))
  const rows = Math.max(1, Math.floor(wanted / cols))
  const frames = cols * rows
  const frameWidth = Math.max(32, Math.min(EXTRACT_LIMITS.spriteWidth, Math.round(width))) & ~1
  const frameHeight = Math.round((frameWidth * rec.height) / rec.width / 2) * 2

  const vf =
    `fps=${rate.toFixed(4)},scale=${frameWidth}:${frameHeight}` +
    (format === 'png' ? ',format=rgba' : '') +
    `,tile=${cols}x${rows}:color=black@0`
  const args = [
    'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-ss', (from / 1000).toFixed(3), '-t', (frames / rate + 0.5 / rate).toFixed(3), '-i', join(MEDIA_DIR, safe),
    '-an', '-vf', vf, '-frames:v', '1', '-f', 'image2',
    ...(format === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '3']),
    'pipe:1',
  ]
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [bytes, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()])
  const code = await p.exited
  if (code !== 0 || !bytes.byteLength) return { ok: false, error: err.trim() || 'ffmpeg produced no sheet' }

  const saved = await saveAsset(`${stem(safe)}-sprite-${clock(from)}.${format}`, new Uint8Array(bytes))
  if (!saved.ok) return saved

  const sprite = {
    cols, rows, frameWidth, frameHeight, frames,
    fps: Math.round(rate * 100) / 100,
    fromMs: Math.round(from), toMs: Math.round(to), source: safe,
  }
  await writeAssetMeta(saved.asset.filename, { sprite, width: cols * frameWidth, height: rows * frameHeight })
  const asset = { ...saved.asset, sprite, width: cols * frameWidth, height: rows * frameHeight }
  return { ok: true, asset, css: spriteCss(asset) }
}

/** A drop-in snippet: one div, one keyframe, steps() over the grid. */
export function spriteCss(asset: Asset): string {
  const sp = asset.sprite
  if (!sp) return ''
  const cls = `sprite-${asset.filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  const seconds = (sp.frames / sp.fps).toFixed(3)
  // Two stepped animations: x walks the columns once per row, y drops a row
  // each time x wraps. steps(n, jump-end) lands on tile 0 at the start and
  // jumps at every 1/n, so the last keyframe (one whole sheet past the edge)
  // is never shown — that is what keeps both axes on tile boundaries.
  return [
    `.${cls} {`,
    `  width: ${sp.frameWidth}px; height: ${sp.frameHeight}px;`,
    `  background-image: url("${asset.url}");`,
    `  background-size: ${sp.cols * sp.frameWidth}px ${sp.rows * sp.frameHeight}px;`,
    `  background-repeat: no-repeat;`,
    `  animation-name: ${cls}-x, ${cls}-y;`,
    `  animation-duration: ${(sp.cols / sp.fps).toFixed(3)}s, ${seconds}s;`,
    `  animation-timing-function: steps(${sp.cols}, jump-end), steps(${sp.rows}, jump-end);`,
    `  animation-iteration-count: infinite, infinite;`,
    `}`,
    `@keyframes ${cls}-x { from { background-position-x: 0px; } to { background-position-x: -${sp.cols * sp.frameWidth}px; } }`,
    `@keyframes ${cls}-y { from { background-position-y: 0px; } to { background-position-y: -${sp.rows * sp.frameHeight}px; } }`,
    `/* <div class="${cls}"></div> — ${sp.frames} frames at ${sp.fps} fps, ${seconds}s per loop */`,
  ].join('\n')
}

/** A file that is already where the library keeps files: probe it and write its record, or remove it. */
async function adoptMediaFile(
  dest: string,
  filename: string,
  originalName: string,
  failure: string,
): Promise<{ ok: true; media: MediaItem } | { ok: false; error: string }> {
  const st = await stat(dest)
  const record = await buildRecord(filename, st.size, Date.now())
  if (!record || record.durationMs <= 0) {
    await unlink(dest).catch(() => {})
    return { ok: false, error: failure }
  }
  record.name = basename(originalName)
  await mkdir(MEDIA_META_DIR, { recursive: true })
  await Bun.write(join(MEDIA_META_DIR, `${filename}.json`), JSON.stringify(record, null, 2))
  return { ok: true, media: record }
}

function freshFilename(originalName: string) {
  const id = Math.random().toString(36).slice(2, 8)
  return `${slug(originalName)}-${id}${extname(originalName).toLowerCase()}`
}

/** Move a finished file into the library and probe it, without a second copy. */
export async function importMediaPath(
  path: string,
  originalName: string,
): Promise<{ ok: true; media: MediaItem } | { ok: false; error: string }> {
  const info = mediaMimeFor(originalName)
  if (!info) return { ok: false, error: `unsupported media type "${extname(originalName)}"` }
  await mkdir(MEDIA_DIR, { recursive: true })
  const filename = freshFilename(originalName)
  const dest = join(MEDIA_DIR, filename)
  await rename(path, dest)
  return adoptMediaFile(dest, filename, originalName, 'the cut produced nothing playable')
}

/**
 * The same media played backwards, as a new file in the library.
 *
 * A new file rather than a flag on the item, because `reverse` has to hold the
 * whole stream in memory to turn it round — there is no streaming way to know
 * the last frame first. That makes it a one-off cost you pay knowingly, with a
 * ceiling, instead of something the preview would have to do sixty times a
 * second and could not do at all.
 */
export async function reverseMedia(
  filename: string,
  name?: string,
): Promise<{ ok: true; media: MediaItem } | { ok: false; error: string }> {
  const safe = safeMediaName(filename)
  if (!safe) return { ok: false, error: 'bad media name' }
  const rec = await getMedia(safe)
  if (!rec) return { ok: false, error: 'no such media' }
  if (rec.durationMs > EXTRACT_LIMITS.reverseMs) {
    return {
      ok: false,
      error:
        `reversing holds the whole file in memory, so it is capped at ` +
        `${EXTRACT_LIMITS.reverseMs / 60_000} minutes — cut the part you want first ` +
        `(extract a sub-clip) and reverse that`,
    }
  }

  const ext = rec.hasVideo ? '.mp4' : '.m4a'
  const tmp = join(tmpdir(), `ah-reverse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  const filters: string[] = []
  if (rec.hasVideo) filters.push('-vf', 'reverse')
  if (rec.hasAudio) filters.push('-af', 'areverse')
  const args = [
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', join(MEDIA_DIR, safe),
    ...filters,
    ...(rec.hasVideo ? ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] : ['-vn']),
    ...(rec.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart',
    tmp,
  ]
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  if (code !== 0) return { ok: false, error: err.trim() || `ffmpeg exited with ${code}` }

  const base = (name && name.trim()) || `${stem(safe)}-reversed`
  return importMediaPath(tmp, base.replace(/\.[^.]+$/, '') + ext)
}

/** A frame-accurate cut of a media file, as a new file in the library. */
export async function extractSubclip(
  filename: string,
  fromMs: number,
  toMs: number,
  name?: string,
): Promise<{ ok: true; media: MediaItem } | { ok: false; error: string }> {
  const safe = safeMediaName(filename)
  if (!safe) return { ok: false, error: 'bad media name' }
  const rec = await getMedia(safe)
  if (!rec) return { ok: false, error: 'no such media' }

  const from = Math.max(0, fromMs)
  const to = Math.min(rec.durationMs, toMs)
  if (to - from < 40) return { ok: false, error: 'the range is empty' }
  if (to - from > EXTRACT_LIMITS.subclipMs) return { ok: false, error: 'sub-clips are capped at ten minutes' }

  const ext = rec.hasVideo ? '.mp4' : '.m4a'
  const tmp = join(tmpdir(), `ah-subclip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  // Re-encode rather than stream-copy: a copy can only cut on keyframes, and
  // a sub-clip that starts a second early is not the moment that was asked for.
  const args = [
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', (from / 1000).toFixed(3), '-to', (to / 1000).toFixed(3), '-i', join(MEDIA_DIR, safe),
    ...(rec.hasVideo ? ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] : ['-vn']),
    ...(rec.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart',
    tmp,
  ]
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  if (code !== 0) return { ok: false, error: err.trim() || `ffmpeg exited with ${code}` }

  const base = (name && name.trim()) || `${stem(safe)}-${clock(from)}-${clock(to)}`
  return importMediaPath(tmp, base.replace(/\.[^.]+$/, '') + ext)
}
