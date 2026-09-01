import { Hono } from 'hono'
import type { Context } from 'hono'
import { join } from 'node:path'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { EncodeJob, FORMATS, probeAlphaSupport, probeFfmpeg } from './ffmpeg'
import { deleteAsset, listAssets, MAX_ASSET_BYTES, saveAsset } from './assets'
import {
  deleteMedia,
  EXTRACT_LIMITS,
  extractFrame,
  extractFrames,
  extractSprite,
  extractSubclip,
  reverseMedia,
  getMedia,
  listMedia,
  MAX_MEDIA_BYTES,
  MEDIA_DIR,
  MEDIA_META_DIR,
  readDetailPeaks,
  readPeaks,
  safeMediaName,
  saveMedia,
} from './media'
import {
  deleteTranscript,
  finalizeTranscript,
  getTranscript,
  listTranscripts,
  parseTranscript,
  replaceCuesInWindow,
  saveTranscript,
  toSrt,
  toVtt,
  type Transcript,
} from './transcripts'
import {
  buildGraph,
  cutPlan,
  ensureExportDir,
  resolveLayerPath,
  SEQUENCE_FORMATS,
  SequenceJob,
  type SequencePlan,
} from './sequence'
import {
  blankClip,
  createProject,
  createTimeline,
  deleteProject,
  deleteTimeline,
  getProject,
  getTimeline,
  listProjects,
  listTimelineRevs,
  loadTimelines,
  newId,
  saveProject,
  timelinesNesting,
  updateProject,
  updateTimeline,
  writeTimeline,
  type Project,
  type Timeline,
} from './store'

import { EXPORT_DIR } from './paths'
import { exportMediaPart, exportTranscriptPart, safeLabel, type PartFile } from './parts'
import { writeStoreZip } from './zip'

/** Live encode jobs, keyed by job id. Cleared when downloaded or aborted. */
const jobs = new Map<string, EncodeJob>()

export const api = new Hono()

/* ------------------------------------------------------------------ health */

api.get('/health', async (c) => {
  const ff = await probeFfmpeg()
  // `alpha` is what the format claims; `alphaVerified` is what this ffmpeg
  // actually produced when asked. They disagree more often than they should.
  const verified = ff.ok ? await probeAlphaSupport() : {}
  return c.json({
    ok: true,
    ffmpeg: ff.ok,
    ffmpegVersion: ff.version,
    alphaSupport: verified,
    formats: Object.values(FORMATS).map((f) => ({
      id: f.id,
      label: f.label,
      ext: f.ext,
      alpha: f.alpha,
      alphaVerified: !!verified[f.id],
      note: f.note,
    })),
  })
})

/* ---------------------------------------------------------------- projects */

api.get('/projects', async (c) => c.json(await listProjects()))

api.post('/projects', async (c) => {
  const body = await c.req.json().catch(() => ({}) as { name?: string })
  return c.json(await createProject(body.name || 'Untitled project'), 201)
})

/** The project with its timelines embedded — one load. */
api.get('/projects/:id', async (c) => {
  const p = await getProject(c.req.param('id'))
  if (!p) return c.json({ error: 'not found' }, 404)
  return c.json({ ...p, timelines: await loadTimelines(p) })
})

/**
 * Project-level fields only. Timelines are written through /api/timelines
 * with a revision; a `sequences` key from an older client is ignored, not
 * refused, so its clip saves still land.
 */
api.put('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const incoming = (await c.req.json()) as Partial<Project>
  const saved = await updateProject(id, (p) => {
    const ids = Array.isArray(incoming.timelineIds) ? incoming.timelineIds.filter((x) => typeof x === 'string') : p.timelineIds
    p.name = incoming.name ?? p.name
    p.clips = incoming.clips ?? p.clips
    p.timelineIds = ids.length ? ids : p.timelineIds
    p.mainTimelineId = incoming.mainTimelineId && ids.includes(incoming.mainTimelineId) ? incoming.mainTimelineId : p.mainTimelineId
  })
  if (!saved) return c.json({ error: 'not found' }, 404)
  return c.json({ ...saved, timelines: await loadTimelines(saved) })
})

/* --------------------------------------------------------------- timelines */

api.get('/timelines/revs', async (c) => {
  const p = await getProject(c.req.query('project') ?? '')
  if (!p) return c.json({ error: 'no such project' }, 404)
  return c.json(await listTimelineRevs(p))
})

api.get('/timelines/:id', async (c) => {
  const t = await getTimeline(c.req.param('id')).catch(() => null)
  return t ? c.json(t) : c.json({ error: 'not found' }, 404)
})

api.post('/timelines', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { projectId?: string } & Record<string, unknown>
  const p = await getProject(String(b.projectId ?? ''))
  if (!p) return c.json({ error: 'no such project' }, 404)
  const { projectId: _pid, ...partial } = b
  const t = await createTimeline(p.id, partial as any)
  await updateProject(p.id, (q) => {
    if (!q.timelineIds.includes(t.id)) q.timelineIds.push(t.id)
  })
  return c.json(t, 201)
})

/** Body carries `rev`; a stale one is refused with the current document. */
api.put('/timelines/:id', async (c) => {
  const id = c.req.param('id')
  const b = (await c.req.json().catch(() => ({}))) as Partial<Timeline>
  const current = await getTimeline(id).catch(() => null)
  if (!current) return c.json({ error: 'not found' }, 404)
  const expect = Number(b.rev)
  if (!Number.isFinite(expect)) return c.json({ error: 'rev is required' }, 400)
  const r = await writeTimeline({ ...current, ...b, id, projectId: current.projectId, claimedBy: b.claimedBy === undefined ? current.claimedBy : b.claimedBy } as Timeline, expect)
  if (!r.ok) return c.json({ error: 'stale', current: r.current }, 409)
  return c.json(r.timeline)
})

api.delete('/timelines/:id', async (c) => {
  const id = c.req.param('id')
  const t = await getTimeline(id).catch(() => null)
  if (!t) return c.json({ error: 'not found' }, 404)
  const p = await getProject(t.projectId)
  if (p) {
    const nesting = await timelinesNesting(p, id)
    if (nesting.length) return c.json({ error: `still nested in ${nesting.map((x) => x.name).join(', ')}` }, 409)
    if (p.mainTimelineId === id) return c.json({ error: 'the main timeline cannot be deleted' }, 409)
    await updateProject(p.id, (q) => {
      q.timelineIds = q.timelineIds.filter((x) => x !== id)
    })
  }
  await deleteTimeline(id)
  return c.json({ ok: true })
})

/** Advisory: who is working here. Expires after fifteen minutes. */
api.post('/timelines/:id/claim', async (c) => {
  const t = await getTimeline(c.req.param('id')).catch(() => null)
  if (!t) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as { agent?: string; release?: boolean; force?: boolean }
  const agent = String(b.agent ?? '').trim().slice(0, 60)
  if (!b.release && !agent) return c.json({ error: 'agent is required' }, 400)
  let refused: { agent: string; at: number } | null = null
  const saved = await updateTimeline(t.id, (doc) => {
    // Another agent's claim stands unless this one takes it over.
    if (doc.claimedBy && agent && doc.claimedBy.agent !== agent && !b.force) {
      refused = doc.claimedBy
      return
    }
    doc.claimedBy = b.release ? null : { agent, at: Date.now() }
  })
  if (refused) return c.json({ error: `claimed by ${(refused as { agent: string }).agent}`, claimedBy: refused }, 409)
  return c.json({ id: t.id, claimedBy: saved?.claimedBy ?? null, rev: saved?.rev ?? t.rev })
})

api.delete('/projects/:id', async (c) => {
  const ok = await deleteProject(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

api.get('/blank-clip', (c) => c.json(blankClip()))

/* ------------------------------------------------------------------- proxy */

/**
 * Fetch an external font/image and hand it back as a data URI.
 *
 * The rasterizer inlines every external asset because an SVG loaded into an
 * <img> cannot reach the network. This also sidesteps CORS on cross-origin
 * stylesheets (Google Fonts in particular), whose cssRules are unreadable.
 */
api.get('/asset', async (c) => {
  const raw = c.req.query('url')
  if (!raw) return c.json({ error: 'missing url' }, 400)

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return c.json({ error: 'invalid url' }, 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return c.json({ error: 'only http(s) urls are allowed' }, 400)
  }
  // Minimal SSRF guard: this server is meant to be bound to localhost, but do
  // not let it be used as a relay into the local network.
  const host = url.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    host === '[::1]'
  if (blocked) return c.json({ error: 'blocked host' }, 403)

  try {
    const res = await fetch(url, {
      headers: {
        // Google Fonts serves woff2 only to browser-like UAs.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: '*/*',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502)

    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
    const buf = Buffer.from(await res.arrayBuffer())

    // CSS comes back as text so the client can rewrite the url() references
    // inside it; everything else becomes a data URI.
    if (mime.includes('css') || mime.startsWith('text/')) {
      return c.json({ kind: 'text', mime, text: buf.toString('utf8'), finalUrl: res.url })
    }
    return c.json({
      kind: 'data',
      mime,
      dataUri: `data:${mime};base64,${buf.toString('base64')}`,
      finalUrl: res.url,
    })
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 502)
  }
})

/* ------------------------------------------------------------------ export */

interface StartBody {
  format: string
  width: number
  height: number
  fps: number
  frameCount: number
  quality?: number
  name?: string
}

api.post('/export', async (c) => {
  const b = (await c.req.json()) as StartBody

  const spec = FORMATS[b.format]
  if (!spec) return c.json({ error: `unknown format "${b.format}"` }, 400)

  const width = Math.round(b.width)
  const height = Math.round(b.height)
  const fps = Math.round(b.fps)
  const frameCount = Math.round(b.frameCount)

  if (!(width > 0 && height > 0 && width <= 7680 && height <= 7680)) {
    return c.json({ error: 'width/height must be between 1 and 7680' }, 400)
  }
  if (!(fps > 0 && fps <= 120)) return c.json({ error: 'fps must be between 1 and 120' }, 400)
  if (!(frameCount > 0 && frameCount <= 36_000)) {
    return c.json({ error: 'frameCount must be between 1 and 36000' }, 400)
  }

  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg was not found on PATH' }, 500)

  await mkdir(EXPORT_DIR, { recursive: true })

  const id = newId('j_')
  const safeName = (b.name || 'clip').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'clip'
  const outPath = join(EXPORT_DIR, `${safeName}-${id}.${spec.ext}`)

  try {
    const job = new EncodeJob(id, {
      format: b.format,
      width,
      height,
      fps,
      frameCount,
      quality: Math.min(63, Math.max(0, Math.round(b.quality ?? (b.format === 'webm' ? 24 : 18)))),
      outPath,
    })
    jobs.set(id, job)
    return c.json({ jobId: id, bytesPerFrame: job.bytesPerFrame, frameCount, alpha: spec.alpha })
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 500)
  }
})

/**
 * Frames over one WebSocket per job, one binary message per frame, one text
 * ack per frame. The per-request path below still works and is the fallback;
 * it just cannot be the default any more: every frame POST left its 8 MB body
 * behind in the renderer until Chrome's own collector got round to it, which
 * during an export loop was effectively never — a 60-second layer reached
 * 12 GB and killed the tab on a smaller machine. A socket message is copied
 * out of the renderer as it is sent.
 */
export interface ExportSocketData {
  jobId: string
}

export function upgradeExportStream(req: Request, server: { upgrade: (req: Request, opts: { data: ExportSocketData }) => boolean }): Response | undefined {
  const m = new URL(req.url).pathname.match(/^\/api\/export\/([A-Za-z0-9_-]+)\/stream$/)
  if (!m) return undefined
  const jobId = m[1]!
  if (!jobs.has(jobId)) return new Response(JSON.stringify({ error: 'no such job' }), { status: 404, headers: { 'content-type': 'application/json' } })
  if (server.upgrade(req, { data: { jobId } })) return undefined
  return new Response('websocket upgrade failed', { status: 400 })
}

export const exportSocket = {
  // 4K RGBA is 33 MB a frame; leave room.
  maxPayloadLength: 128 * 1024 * 1024,
  idleTimeout: 255,
  async message(ws: { data: ExportSocketData; send: (m: string) => void; close: () => void }, data: unknown) {
    const job = jobs.get(ws.data.jobId)
    if (!job) {
      ws.send(JSON.stringify({ error: 'no such job' }))
      ws.close()
      return
    }
    if (typeof data === 'string') return // nothing textual is expected
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBufferLike)
      await job.writeFrame(bytes)
      ws.send(JSON.stringify({ frames: job.framesWritten }))
    } catch (err) {
      job.abort()
      ws.send(JSON.stringify({ error: String((err as Error).message ?? err) }))
      ws.close()
    }
  },
  open() {},
  close(ws: { data: ExportSocketData }) {
    // The client keeps the socket open until /finish has answered, so a
    // close while still encoding means the tab died. Nothing will ever
    // finish this job; kill the encoder and drop its half-written file.
    const job = jobs.get(ws.data.jobId)
    if (job && job.state === 'encoding') {
      job.abort()
      jobs.delete(ws.data.jobId)
    }
  },
}

api.post('/export/:id/frame', async (c) => {
  const job = jobs.get(c.req.param('id'))
  if (!job) return c.json({ error: 'no such job' }, 404)

  try {
    const buf = await c.req.arrayBuffer()
    await job.writeFrame(new Uint8Array(buf))
    return c.json({ frames: job.framesWritten })
  } catch (err) {
    job.abort()
    return c.json({ error: String((err as Error).message ?? err) }, 400)
  }
})

api.post('/export/:id/finish', async (c) => {
  const id = c.req.param('id')
  const job = jobs.get(id)
  if (!job) return c.json({ error: 'no such job' }, 404)

  const result = await job.finish()
  if (!result.ok) {
    jobs.delete(id)
    return c.json({ error: result.error ?? 'encode failed' }, 500)
  }
  return c.json({
    jobId: id,
    frames: job.framesWritten,
    size: result.size,
    filename: job.opts.outPath.split('/').pop(),
    downloadUrl: `/api/export/${id}/download`,
    elapsedMs: Date.now() - job.startedAt,
  })
})

api.get('/export/:id/download', async (c) => {
  const job = jobs.get(c.req.param('id'))
  if (!job || job.state !== 'complete') return c.json({ error: 'not ready' }, 404)

  const file = Bun.file(job.opts.outPath)
  if (!(await file.exists())) return c.json({ error: 'file is gone' }, 404)

  const name = job.opts.outPath.split('/').pop()!
  return new Response(file, {
    headers: {
      'content-type': job.spec.mime,
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': String(file.size),
    },
  })
})

api.post('/export/:id/abort', (c) => {
  const id = c.req.param('id')
  const job = jobs.get(id)
  if (job) {
    job.abort()
    jobs.delete(id)
  }
  return c.json({ ok: true })
})

/**
 * A Quick export is whatever MediaRecorder hands back, and MediaRecorder
 * writes no duration and no seek index — the file plays, but a player shows
 * no total time and cannot skip. A stream copy through ffmpeg rebuilds
 * both without re-encoding a frame.
 */
api.post('/export/quick', async (c) => {
  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg was not found on PATH' }, 500)
  const raw = String(c.req.query('name') ?? 'quick').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'quick'
  const type = c.req.header('content-type') ?? ''
  const ext = type.includes('mp4') ? 'mp4' : 'webm'
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (!bytes.length) return c.json({ error: 'empty recording' }, 400)
  await ensureExportDir()
  const id = newId('q_')
  const tmp = join(EXPORT_DIR, `.${id}.${ext}`)
  const filename = `${raw.replace(/\.(webm|mp4)$/i, '')}-${id}.${ext}`
  const out = join(EXPORT_DIR, filename)
  await Bun.write(tmp, bytes)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-c', 'copy', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), out]
  const proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'ignore', stderr: 'pipe' })
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  await unlink(tmp).catch(() => {})
  if (code !== 0) return c.json({ error: err.trim().split('\n').pop() || `ffmpeg exited with ${code}` }, 500)
  return c.json({ filename, url: `/api/exports/${encodeURIComponent(filename)}`, size: Bun.file(out).size })
})

/* ------------------------------------------------------- agent-facing extras */

const FRAME_MAGIC = [0x89, 0x50, 0x4e, 0x47] // \x89PNG

/**
 * Save a single rasterized PNG frame and hand back a URL.
 *
 * WebMCP caps a tool's output at ~1.5K characters, so a base64 image cannot be
 * returned inline. An agent gets a URL it can fetch and look at instead.
 */
api.post('/frame', async (c) => {
  const buf = new Uint8Array(await c.req.arrayBuffer())

  if (buf.byteLength === 0) return c.json({ error: 'empty body' }, 400)
  if (buf.byteLength > 64 * 1024 * 1024) return c.json({ error: 'frame too large' }, 413)
  if (!FRAME_MAGIC.every((b, i) => buf[i] === b)) {
    return c.json({ error: 'body must be a PNG' }, 400)
  }

  const raw = c.req.query('name') ?? 'frame'
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'frame'

  // Into the asset library when asked, so a clip can use the frame at once.
  if (c.req.query('dest') === 'assets') {
    const result = await saveAsset(`${safe}.png`, buf)
    return result.ok
      ? c.json({ ...result.asset, filename: result.asset.filename, url: result.asset.url, size: buf.byteLength, asset: true })
      : c.json({ error: result.error }, 400)
  }

  await mkdir(EXPORT_DIR, { recursive: true })
  const filename = `${safe}-${newId()}.png`
  await Bun.write(join(EXPORT_DIR, filename), buf)

  return c.json({ filename, url: `/api/exports/${filename}`, size: buf.byteLength })
})

/** Recently rendered files, newest first. */
api.get('/exports', async (c) => {
  await mkdir(EXPORT_DIR, { recursive: true })
  const names = (await readdir(EXPORT_DIR)).filter((f) => !f.startsWith('.'))
  const rows = []
  for (const name of names) {
    try {
      const st = await stat(join(EXPORT_DIR, name))
      if (st.isFile()) rows.push({ name, size: st.size, modified: st.mtimeMs })
    } catch {
      /* raced with a delete; skip */
    }
  }
  rows.sort((a, b) => b.modified - a.modified)
  return c.json(rows.slice(0, 50))
})

api.get('/exports/:name', async (c) => {
  const name = c.req.param('name')
  // Generated names only; never let a path escape the exports directory.
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) {
    return c.json({ error: 'bad name' }, 400)
  }
  const file = Bun.file(join(EXPORT_DIR, name))
  if (!(await file.exists())) return c.json({ error: 'not found' }, 404)

  const MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    zip: 'application/zip', srt: 'application/x-subrip', vtt: 'text/vtt',
    txt: 'text/plain; charset=utf-8', json: 'application/json',
  }
  const type = MIME[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'

  return new Response(file, {
    headers: { 'content-type': type, 'content-length': String(file.size) },
  })
})

/* ------------------------------------------------------------------ assets */

/**
 * Upload one asset. The body is the raw file; the original filename comes in as
 * ?name= so the extension can be validated and a readable slug derived.
 */
api.post('/assets', async (c) => {
  const name = c.req.query('name')
  if (!name) return c.json({ error: 'missing ?name=' }, 400)

  const buf = await c.req.arrayBuffer()
  if (buf.byteLength > MAX_ASSET_BYTES) {
    return c.json({ error: `file is larger than ${MAX_ASSET_BYTES / 1024 / 1024}MB` }, 413)
  }

  const result = await saveAsset(name, new Uint8Array(buf))
  return result.ok ? c.json(result.asset, 201) : c.json({ error: result.error }, 400)
})

api.get('/assets', async (c) => c.json(await listAssets()))

api.delete('/assets/:filename', async (c) => {
  const ok = await deleteAsset(c.req.param('filename'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

/** Pull a remote image into the library — the path an agent can use. */
api.post('/assets/from-url', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string; name?: string }
  if (!body.url) return c.json({ error: 'missing url' }, 400)

  let url: URL
  try {
    url = new URL(body.url)
  } catch {
    return c.json({ error: 'invalid url' }, 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return c.json({ error: 'only http(s) urls are allowed' }, 400)
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502)
    const buf = new Uint8Array(await res.arrayBuffer())
    const fallback = decodeURIComponent(url.pathname.split('/').pop() || 'asset')
    const result = await saveAsset(body.name || fallback, buf)
    return result.ok ? c.json(result.asset, 201) : c.json({ error: result.error }, 400)
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 502)
  }
})

/* ------------------------------------------------------------------- media */

/**
 * Upload one media file. Like /assets, the body is the raw file and the
 * original name arrives as ?name= — but this one probes, posters and computes
 * a waveform before it answers, so the timeline can lay the clip out the
 * instant it appears in the rail.
 */
api.post('/media', async (c) => {
  const name = c.req.query('name')
  if (!name) return c.json({ error: 'missing ?name=' }, 400)

  const buf = await c.req.arrayBuffer()
  if (buf.byteLength > MAX_MEDIA_BYTES) {
    return c.json({ error: `file is larger than ${MAX_MEDIA_BYTES / 1024 ** 3}GB` }, 413)
  }

  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg/ffprobe were not found on PATH' }, 500)

  const result = await saveMedia(name, new Uint8Array(buf))
  return result.ok ? c.json(result.media, 201) : c.json({ error: result.error }, 400)
})

api.get('/media', async (c) => c.json(await listMedia()))

api.get('/media/:filename', async (c) => {
  const m = await getMedia(c.req.param('filename'))
  return m ? c.json(m) : c.json({ error: 'not found' }, 404)
})

api.delete('/media/:filename', async (c) => {
  const ok = await deleteMedia(c.req.param('filename'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

/** Pull remote footage or audio into the library — the path an agent can use. */
api.post('/media/from-url', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string; name?: string }
  if (!body.url) return c.json({ error: 'missing url' }, 400)

  let url: URL
  try {
    url = new URL(body.url)
  } catch {
    return c.json({ error: 'invalid url' }, 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return c.json({ error: 'only http(s) urls are allowed' }, 400)
  }

  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg/ffprobe were not found on PATH' }, 500)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_MEDIA_BYTES) return c.json({ error: 'file too large' }, 413)
    const fallback = decodeURIComponent(url.pathname.split('/').pop() || 'media.mp4')
    const result = await saveMedia(body.name || fallback, buf)
    return result.ok ? c.json(result.media, 201) : c.json({ error: result.error }, 400)
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 502)
  }
})

api.get('/media/:filename/peaks', async (c) => {
  const name = c.req.param('filename')
  if (c.req.query('tier') === 'detail') {
    const detail = await readDetailPeaks(name)
    return detail ? c.json(detail) : c.json({ error: 'no waveform for that file' }, 404)
  }
  const peaks = await readPeaks(name)
  return peaks ? c.json(peaks) : c.json({ error: 'no waveform for that file' }, 404)
})

/**
 * One decoded frame of a media file at a source time, as JPEG.
 *
 * The preview's <video> cannot be asked for a frame in a background tab —
 * Chrome defers media loading there — and an agent's tab is nearly always in
 * the background. ffmpeg has no such opinion, so a composited capture falls
 * back to this for every piece of footage that has no decoded data.
 */
api.get('/media/:filename/frame', async (c) => {
  const safe = safeMediaName(c.req.param('filename'))
  if (!safe) return c.json({ error: 'bad name' }, 400)
  const path = join(MEDIA_DIR, safe)
  if (!(await Bun.file(path).exists())) return c.json({ error: 'not found' }, 404)

  const t = Math.max(0, Number(c.req.query('t') ?? 0) || 0)
  const w = Math.min(3840, Math.max(0, Math.round(Number(c.req.query('w') ?? 0) || 0)))

  const args = [
    'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-ss', t.toFixed(3), '-i', path,
    '-frames:v', '1', '-an',
    ...(w ? ['-vf', `scale=${w}:-2`] : []),
    '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1',
  ]
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [bytes, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()])
  const code = await p.exited
  if (code !== 0 || bytes.byteLength === 0) {
    return c.json({ error: err.trim() || 'no frame at that time' }, 500)
  }
  return new Response(bytes, {
    headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength), 'cache-control': 'no-cache' },
  })
})

/**
 * Frames, frame series, sprite sheets and sub-clips.
 *
 * Caps are enforced in media.ts, not here and not in the UI: agents call this
 * directly, and a sprite sheet that is too large gets serialised into every
 * exported frame of any clip that uses it.
 */
api.post('/media/:filename/extract', async (c) => {
  const name = c.req.param('filename')
  const b = (await c.req.json().catch(() => ({}))) as {
    mode?: string; fromMs?: number; toMs?: number; count?: number; fps?: number; width?: number; format?: string; name?: string
  }
  const fromMs = Math.max(0, Number(b.fromMs ?? 0) || 0)
  const toMs = Number(b.toMs ?? 0) || 0
  const format = b.format === 'png' ? 'png' : 'jpg'
  const width = Math.max(0, Math.round(Number(b.width ?? 0) || 0))

  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg was not found on PATH' }, 500)

  switch (b.mode) {
    case 'frame': {
      const r = await extractFrame(name, fromMs, { width, format: b.format === 'jpg' ? 'jpg' : 'png', name: String(b.name ?? '').slice(0, 80) })
      return r.ok ? c.json(r.asset, 201) : c.json({ error: r.error }, 400)
    }
    case 'frames': {
      const r = await extractFrames(name, fromMs, toMs, {
        count: Number(b.count ?? 0) || 0, fps: Number(b.fps ?? 0) || 0, width, format,
      })
      return r.ok ? c.json({ assets: r.assets, limit: EXTRACT_LIMITS.frames }, 201) : c.json({ error: r.error }, 400)
    }
    case 'sprite': {
      const r = await extractSprite(name, fromMs, toMs, { fps: Number(b.fps ?? 10) || 10, width: width || 320, format })
      return r.ok ? c.json({ asset: r.asset, css: r.css, limits: EXTRACT_LIMITS }, 201) : c.json({ error: r.error }, 400)
    }
    case 'reverse': {
      const r = await reverseMedia(name, b.name)
      return r.ok ? c.json(r.media, 201) : c.json({ error: r.error }, 400)
    }
    case 'subclip': {
      const r = await extractSubclip(name, fromMs, toMs, b.name)
      return r.ok ? c.json(r.media, 201) : c.json({ error: r.error }, 400)
    }
    default:
      return c.json({ error: 'mode must be frame, frames, sprite, subclip or reverse' }, 400)
  }
})

api.get('/media/:filename/poster', async (c) => {
  const safe = safeMediaName(c.req.param('filename'))
  if (!safe) return c.json({ error: 'bad name' }, 400)
  const file = Bun.file(join(MEDIA_META_DIR, `${safe}.jpg`))
  if (!(await file.exists())) return c.json({ error: 'not found' }, 404)
  return new Response(file, {
    headers: { 'content-type': 'image/jpeg', 'content-length': String(file.size) },
  })
})

/* ------------------------------------------------------------- transcripts */

/** Import an SRT, VTT or Whisper JSON file. The body is the raw text. */
api.post('/transcripts', async (c) => {
  const name = c.req.query('name') ?? 'transcript'
  const mediaFilename = c.req.query('media') ?? null

  const text = await c.req.text()
  const parsed = parseTranscript(name, text)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const cues = parsed.cues
  const transcript: Transcript = {
    id: newId('tr_'),
    name,
    mediaFilename: mediaFilename ? safeMediaName(mediaFilename) : null,
    source: parsed.source,
    cues,
    wordLevel: cues.some((q) => q.words?.length),
    durationMs: cues.length ? Math.max(...cues.map((q) => q.endMs)) : 0,
    createdAt: Date.now(),
  }
  await saveTranscript(transcript)
  return c.json({ ...transcript, cues: undefined, cueCount: cues.length }, 201)
})

api.get('/transcripts', async (c) => c.json(await listTranscripts()))

api.get('/transcripts/:id', async (c) => {
  const t = await getTranscript(c.req.param('id'))
  return t ? c.json(t) : c.json({ error: 'not found' }, 404)
})

/** Replace every cue. The body is `{ cues }`, source times in ms. */
api.put('/transcripts/:id', async (c) => {
  const t = await getTranscript(c.req.param('id')).catch(() => null)
  if (!t) return c.json({ error: 'not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { cues?: unknown; name?: unknown; mediaFilename?: unknown }
  const hasCues = Array.isArray(body.cues)
  const hasName = typeof body.name === 'string'
  const hasMedia = 'mediaFilename' in body
  if (!hasCues && !hasName && !hasMedia) return c.json({ error: 'nothing to change: send cues, name or mediaFilename' }, 400)
  let next = t
  if (hasCues) {
    const cues = (body.cues as any[])
      .map((q: any) => ({ startMs: Number(q?.startMs) || 0, endMs: Number(q?.endMs) || 0, text: String(q?.text ?? '').trim(), ...(Array.isArray(q?.words) ? { words: q.words } : {}) }))
      .filter((q) => q.text)
    next = finalizeTranscript(next, cues)
  }
  if (hasName) {
    const name = String(body.name).trim().slice(0, 120)
    if (name) next = { ...next, name }
  }
  if (hasMedia) {
    const f = body.mediaFilename
    next = { ...next, mediaFilename: typeof f === 'string' && f ? safeMediaName(f) : null }
  }
  await saveTranscript(next)
  return c.json(next)
})

/**
 * Replace what is said between two source times: `{ fromMs, toMs, cues }`.
 * Cues outside the window are untouched; those crossing an edge are cut at
 * it. Returns the whole transcript, so a client can swap its copy.
 */
api.patch('/transcripts/:id/cues', async (c) => {
  const t = await getTranscript(c.req.param('id')).catch(() => null)
  if (!t) return c.json({ error: 'not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { fromMs?: number; toMs?: number; cues?: unknown }
  if (!Array.isArray(body.cues)) return c.json({ error: 'cues must be an array' }, 400)
  try {
    const cues = replaceCuesInWindow(t.cues, Number(body.fromMs) || 0, Number(body.toMs) || 0, body.cues as any)
    const next = finalizeTranscript(t, cues)
    await saveTranscript(next)
    return c.json(next)
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 400)
  }
})

api.delete('/transcripts/:id', async (c) => {
  const ok = await deleteTranscript(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

/**
 * Cues as a sidecar subtitle file, shifted to where the item sits on the
 * timeline — the same numbers the burnt-in captions used, so a soft subtitle
 * track and a burnt-in one cannot disagree.
 */
api.get('/transcripts/:id/export', async (c) => {
  const t = await getTranscript(c.req.param('id'))
  if (!t) return c.json({ error: 'not found' }, 404)

  const format = c.req.query('format') === 'srt' ? 'srt' : 'vtt'
  const offset = Number(c.req.query('offsetMs') ?? 0) || 0
  const from = Number(c.req.query('fromMs') ?? 0) || 0
  const to = Number(c.req.query('toMs') ?? 0) || Infinity

  const cues = t.cues.filter((q) => q.endMs > from && q.startMs < to)
  const body = format === 'srt' ? toSrt(cues, offset) : toVtt(cues, offset)
  const safe = t.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'captions'

  return new Response(body, {
    headers: {
      'content-type': format === 'srt' ? 'application/x-subrip' : 'text/vtt',
      'content-disposition': `attachment; filename="${safe}.${format}"`,
    },
  })
})

/* --------------------------------------------------------- timeline render */

const sequenceJobs = new Map<string, SequenceJob>()

api.get('/timeline-formats', (c) =>
  c.json(
    Object.values(SEQUENCE_FORMATS).map((f) => ({
      id: f.id, label: f.label, ext: f.ext, alpha: f.alpha, note: f.note,
    })),
  ),
)

/**
 * Render a whole timeline.
 *
 * The client has already rendered every animation and caption layer to an
 * alpha file through the existing frame-exact path; what arrives here is a
 * flat list of files with times, and it becomes one filtergraph.
 */
api.post('/render/timeline', async (c) => {
  const body = (await c.req.json()) as SequencePlan & { range?: { fromMs: number; toMs: number } }
  let plan: SequencePlan = { ...body, video: body.video ?? [], audio: body.audio ?? [] }

  // Sound-only output goes to a sound-only container; a sound-only container
  // implies sound-only output.
  if (plan.output === 'audio' && SEQUENCE_FORMATS[plan.format]?.video) plan.format = 'wav'
  if (SEQUENCE_FORMATS[plan.format] && !SEQUENCE_FORMATS[plan.format]!.video) plan.output = 'audio'

  const spec = SEQUENCE_FORMATS[plan.format]
  if (!spec) return c.json({ error: `unknown format "${plan.format}"` }, 400)

  if (body.range) {
    try {
      plan = cutPlan(plan, Number(body.range.fromMs) || 0, Number(body.range.toMs) || plan.durationMs)
    } catch (err) {
      return c.json({ error: String((err as Error).message ?? err) }, 400)
    }
  }

  const width = Math.floor(Math.round(plan.width) / 2) * 2
  const height = Math.floor(Math.round(plan.height) / 2) * 2
  if (!(width > 0 && height > 0 && width <= 7680 && height <= 7680)) {
    return c.json({ error: 'width/height must be between 2 and 7680' }, 400)
  }
  if (!(plan.fps > 0 && plan.fps <= 120)) return c.json({ error: 'fps must be between 1 and 120' }, 400)
  if (!(plan.durationMs > 0 && plan.durationMs <= 4 * 3600_000)) {
    return c.json({ error: 'the timeline is empty, or longer than four hours' }, 400)
  }
  if (!plan.video?.length && !plan.audio?.length) {
    return c.json({ error: 'nothing to render — the timeline has no items' }, 400)
  }

  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg was not found on PATH' }, 500)

  const dir = await ensureExportDir()
  const id = newId('sq_')
  const safeName = (plan.name || 'timeline').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'timeline'
  const outPath = join(dir, `${safeName}-${id}.${spec.ext}`)

  try {
    const job = new SequenceJob(
      id,
      {
        ...plan,
        width,
        height,
        fps: Math.round(plan.fps),
        quality: Math.min(63, Math.max(0, Math.round(plan.quality ?? 20))),
        video: plan.video ?? [],
        audio: plan.audio ?? [],
      },
      outPath,
    )
    sequenceJobs.set(id, job)
    return c.json({ jobId: id, durationMs: plan.durationMs, filename: outPath.split('/').pop() })
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 400)
  }
})

api.get('/render/timeline/:id', (c) => {
  const id = c.req.param('id')
  const job = sequenceJobs.get(id)
  if (!job) return c.json({ error: 'no such job' }, 404)

  return c.json({
    jobId: id,
    state: job.state,
    progress: job.progress,
    outTimeMs: job.outTimeMs,
    durationMs: job.plan.durationMs,
    error: job.error,
    size: job.outSize,
    filename: job.outPath.split('/').pop(),
    downloadUrl: job.state === 'complete' ? `/api/render/timeline/${id}/download` : null,
    elapsedMs: Date.now() - job.startedAt,
  })
})

api.get('/render/timeline/:id/download', async (c) => {
  const job = sequenceJobs.get(c.req.param('id'))
  if (!job || job.state !== 'complete') return c.json({ error: 'not ready' }, 404)

  const file = Bun.file(job.outPath)
  if (!(await file.exists())) return c.json({ error: 'file is gone' }, 404)

  const name = job.outPath.split('/').pop()!
  return new Response(file, {
    headers: {
      'content-type': job.spec.mime,
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': String(file.size),
    },
  })
})

api.post('/render/timeline/:id/abort', (c) => {
  const job = sequenceJobs.get(c.req.param('id'))
  if (job) job.abort()
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------- parts */

/**
 * Pieces as files: a media range as picture / sound / both, a transcript
 * excerpt, and files already rendered into the exports folder — optionally
 * bundled into one zip. Everything lands in data/exports and is listed by
 * /api/exports; the reply carries the URLs.
 */
/**
 * One subtitle file from cues the client has already placed in time — the
 * captions of one item, of a selection, or of a whole timeline, shifted to
 * where they fall on the timeline (or left in source time). SRT, WebVTT or
 * the words alone. Written into Exports so agents can fetch it and the UI can
 * download it.
 */
api.post('/export/captions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; format?: unknown; cues?: unknown }
  if (!Array.isArray(body.cues)) return c.json({ error: 'cues must be an array' }, 400)
  const format = (['srt', 'vtt', 'txt'].includes(String(body.format)) ? String(body.format) : 'srt') as 'srt' | 'vtt' | 'txt'
  const cues = (body.cues as any[])
    .map((q) => ({ startMs: Math.max(0, Math.round(Number(q?.startMs) || 0)), endMs: Math.round(Number(q?.endMs) || 0), text: String(q?.text ?? '').trim() }))
    .filter((q) => q.text && q.endMs > q.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  if (!cues.length) return c.json({ error: 'no captions in that range' }, 400)
  const text = format === 'srt' ? toSrt(cues) : format === 'vtt' ? toVtt(cues) : cues.map((q) => q.text.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n'
  const safe = String(body.name ?? 'captions').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'captions'
  const id = Math.random().toString(36).slice(2, 10)
  const filename = `${safe}-${id}.${format}`
  await mkdir(EXPORT_DIR, { recursive: true })
  await Bun.write(join(EXPORT_DIR, filename), text)
  return c.json({ ok: true, name: filename, url: `/api/exports/${filename}`, size: Buffer.byteLength(text), count: cues.length, format })
})

api.post('/export/parts', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    name?: string
    zip?: boolean
    parts?: Array<Record<string, unknown>>
  }
  const parts = Array.isArray(b.parts) ? b.parts.slice(0, 40) : []
  if (!parts.length) return c.json({ error: 'no parts given' }, 400)

  const ff = await probeFfmpeg()
  if (!ff.ok) return c.json({ error: 'ffmpeg was not found on PATH' }, 500)

  const files: PartFile[] = []
  const errors: string[] = []
  for (const part of parts) {
    const label = typeof part.label === 'string' ? part.label : undefined
    if (part.kind === 'media') {
      const r = await exportMediaPart({
        file: String(part.file ?? ''),
        fromMs: Number(part.fromMs ?? 0) || 0,
        toMs: Number(part.toMs ?? 0) || 0,
        what: (['video', 'audio', 'both'].includes(String(part.what)) ? part.what : 'both') as 'video' | 'audio' | 'both',
        audioFormat: part.audioFormat === 'mp3' ? 'mp3' : 'wav',
        videoFormat: part.videoFormat === 'mov' ? 'mov' : 'mp4',
        label,
      })
      if (r.ok) files.push(r.file)
      else errors.push(`${label ?? part.file}: ${r.error}`)
    } else if (part.kind === 'transcript') {
      const r = await exportTranscriptPart({
        id: String(part.id ?? ''),
        fromMs: Number(part.fromMs ?? 0) || 0,
        toMs: Number(part.toMs ?? 0) || 0,
        format: (['srt', 'vtt', 'txt'].includes(String(part.format)) ? part.format : 'srt') as 'srt' | 'vtt' | 'txt',
        label,
      })
      if (r.ok) files.push(r.file)
      else errors.push(`${label ?? part.id}: ${r.error}`)
    } else if (part.kind === 'file') {
      const name = String(part.name ?? '')
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) {
        errors.push(`${name}: bad file name`)
        continue
      }
      const f = Bun.file(join(EXPORT_DIR, name))
      if (!(await f.exists())) {
        errors.push(`${name}: not found`)
        continue
      }
      files.push({ name, url: `/api/exports/${name}`, size: f.size, label: label ?? name })
    } else {
      errors.push(`unknown part kind "${String(part.kind)}"`)
    }
  }

  let zip: { name: string; url: string; size: number } | null = null
  if (b.zip && files.length) {
    const name = `${safeLabel(b.name, 'parts')}-${newId()}.zip`
    try {
      const r = await writeStoreZip(
        files.map((f) => ({ path: join(EXPORT_DIR, f.name), name: f.name })),
        join(EXPORT_DIR, name),
      )
      zip = { name, url: `/api/exports/${name}`, size: r.size }
    } catch (err) {
      errors.push(`zip: ${String((err as Error).message ?? err)}`)
    }
  }

  return c.json({ files, zip, errors })
})

/** The filtergraph a plan would produce, without running it. For debugging. */
api.post('/render/timeline/dry-run', async (c) => {
  const plan = (await c.req.json()) as SequencePlan
  try {
    const graph = buildGraph(plan, resolveLayerPath)
    return c.json({ inputs: graph.inputs, filter: graph.filter, hasAudio: graph.hasAudio })
  } catch (err) {
    return c.json({ error: String((err as Error).message ?? err) }, 400)
  }
})

/* ─────────────────────────────── speech relay ──────────────────────────── */

/**
 * Passing a speech request through, so the browser does not have to.
 *
 * A page can only call what will let it, and almost nothing will. A Whisper or
 * voice server somebody runs at home ships with cross-origin requests off;
 * `api.openai.com` refuses them outright and no key changes that. The browser
 * reports both as an indistinguishable network error.
 *
 * When Klipvia is running as a server, none of that has to be anybody's
 * problem: the page asks its own origin, this asks the model, and there is no
 * cross-origin request anywhere in the chain. The audio still goes only where
 * the person chose — from their browser to their own machine to whatever they
 * picked — and for a local model it never leaves the computer at all.
 *
 * Two rules keep this from being a way to make the machine fetch anything:
 *
 *  - the target must be a loopback or private address, or one of the speech
 *    APIs named below. Not "any URL" — that would turn a convenience into a
 *    request-forgery tool aimed at whatever else is on this network.
 *  - only the headers a speech API needs are carried, so a page cannot use
 *    this to replay a cookie at something.
 */
const SPEECH_HOSTS = new Set([
  'api.openai.com',
  'api.groq.com',
  'api.elevenlabs.io',
  'api.deepgram.com',
  'api.assemblyai.com',
])

const PRIVATE_HOST =
  /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[\w-]+\.local)$/i

/** Only what a speech API reads. Notably not cookies. */
const CARRIED = ['content-type', 'authorization', 'xi-api-key', 'accept']

function relayTarget(raw: string | undefined): URL | { error: string } {
  if (!raw) return { error: 'missing url' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: 'that is not a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'only http and https' }
  if (PRIVATE_HOST.test(url.hostname) || SPEECH_HOSTS.has(url.hostname)) return url
  return { error: `${url.hostname} is not a speech API or a machine on your own network` }
}

async function relay(c: Context, method: 'GET' | 'POST') {
  const target = relayTarget(c.req.query('url'))
  if ('error' in target) return c.json({ error: target.error }, 400)

  const headers = new Headers()
  for (const name of CARRIED) {
    const v = c.req.header(name)
    if (v) headers.set(name, v)
  }

  let res: Response
  try {
    res = await fetch(target.toString(), {
      method,
      headers,
      body: method === 'POST' ? c.req.raw.body : undefined,
      // Streaming a request body without this is a runtime error in Bun.
      ...(method === 'POST' ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch (err) {
    return c.json({ error: `could not reach ${target.origin}: ${String((err as Error).message ?? err)}` }, 502)
  }

  // Handed back as it came: the status matters (a 401 is a wrong key, not a
  // relay failure) and so does the body, which is often audio.
  const out = new Headers()
  for (const name of ['content-type', 'content-length', 'content-disposition']) {
    const v = res.headers.get(name)
    if (v) out.set(name, v)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

api.get('/speech/relay', (c) => relay(c, 'GET'))
api.post('/speech/relay', (c) => relay(c, 'POST'))
