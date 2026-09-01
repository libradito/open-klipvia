/**
 * The two export paths. Both draw through the same rasterizer; they differ only
 * in who does the encoding and how time is driven.
 *
 *   Quick  — wall-clock playback into MediaRecorder. Entirely in the browser,
 *            finishes in realtime, WebM only. Drops frames if a frame takes
 *            longer than 1/fps to rasterize.
 *   Studio — the clock is stepped frame by frame regardless of how long each
 *            one takes, and raw RGBA is streamed to ffmpeg. Frame-exact, and
 *            the only path that can emit ProRes 4444 or H.264.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function triggerDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/* ------------------------------------------------------------------ studio */

export async function studioExport({
  host,
  clip,
  format,
  quality,
  onProgress,
  signal,
  // Agent-driven renders want the file on disk and a URL, not a download in the
  // user's Downloads folder.
  download = true,
}) {
  const frameCount = Math.max(1, Math.round((clip.durationMs / 1000) * clip.fps))
  const alphaFormat = format === 'mov' || format === 'webm'
  // An alpha-capable codec keeps the canvas transparent; everything else is
  // flattened onto the clip background so H.264 gets a real green screen.
  const background =
    alphaFormat && clip.background.mode === 'transparent'
      ? null
      : clip.background.mode === 'color'
        ? clip.background.color
        : null

  onProgress({ phase: 'preparing', progress: 0 })
  await host.reload()

  // One upload buffer for the whole export. Handing each frame's own
  // ImageData buffer to fetch() leaked ~6.5 MB a frame: Blink keeps a
  // reference to an ArrayBuffer body from its side of the fence until its
  // own collector runs, which during a tight export loop is roughly never —
  // a 60-second layer reached 12 GB and a smaller machine killed the tab.
  // Copying every frame into the same buffer keeps all of those references
  // pointing at one 8 MB allocation. The copy costs about a millisecond.
  const upload = new Uint8Array(clip.width * clip.height * 4)

  const start = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      format,
      quality,
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      frameCount,
      name: clip.name,
    }),
  })
  if (!start.ok) throw new Error((await start.json()).error ?? `export start failed (${start.status})`)
  const { jobId } = await start.json()

  const abort = async () => {
    await fetch(`/api/export/${jobId}/abort`, { method: 'POST' }).catch(() => {})
  }

  // One socket for the job's frames. If it cannot open (a proxy in the way,
  // say) the per-frame POSTs below take over — slower to leave memory behind,
  // never wrong.
  const socket = await openFrameSocket(jobId)

  try {
    const t0 = performance.now()
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) {
        await abort()
        throw new DOMException('aborted', 'AbortError')
      }

      const t = (i * 1000) / clip.fps

      // The virtual clock refuses to run backwards. If that ever happens mid
      // export the remaining frames would all be identical and the encode would
      // still "succeed", quietly shipping a frozen video — so fail loudly.
      const seeked = await host.seek(t)
      if (seeked?.rewound) {
        throw new Error(
          `clock desync at frame ${i}: asked for ${t.toFixed(1)}ms but the stage ` +
            `is already at ${seeked.time.toFixed(1)}ms`,
        )
      }
      await host.raster.drawFrame(background)

      // One POST per frame, thousands of them per layer: a single transient
      // network failure used to lose a render minutes in. A rejected frame is
      // a real error and still throws; only a failed *connection* is retried.
      const bytes = host.raster.rgbaBytes()
      upload.set(bytes.length === upload.length ? bytes : bytes.subarray(0, upload.length))
      let res = null
      if (socket) {
        const reply = await socket.frame(upload)
        if (reply.error) throw new Error(reply.error)
        res = { ok: true }
      }
      for (let attempt = 0; res == null; attempt++) {
        try {
          res = await fetch(`/api/export/${jobId}/frame`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: upload,
          })
          break
        } catch (err) {
          if (signal?.aborted || attempt >= 4) throw err
          await sleep(250 * (attempt + 1))
        }
      }
      if (!res.ok) throw new Error((await res.json()).error ?? `frame ${i} rejected`)

      const done = i + 1
      const elapsed = performance.now() - t0
      onProgress({
        phase: 'rendering',
        progress: done / frameCount,
        frame: done,
        frameCount,
        etaMs: done > 2 ? (elapsed / done) * (frameCount - done) : null,
      })

      // Yield so the progress bar can actually paint.
      if (i % 4 === 3) await sleep(0)
    }

    onProgress({ phase: 'encoding', progress: 1, frame: frameCount, frameCount })

    // The socket stays open until the server has answered /finish: a close
    // while still encoding is how it tells a dead tab from a finished job.
    const fin = await fetch(`/api/export/${jobId}/finish`, { method: 'POST' })
    socket?.close()
    if (!fin.ok) throw new Error((await fin.json()).error ?? 'encode failed')
    const result = await fin.json()

    onProgress({ phase: 'complete', progress: 1, ...result })
    if (download) triggerDownload(result.downloadUrl, result.filename)
    return result
  } catch (err) {
    socket?.close()
    await abort()
    throw err
  }
}

/**
 * The frame socket: send a frame, get the server's ack. Frames go one at a
 * time — the next is not sent until the previous is acknowledged — so the
 * server writes them to ffmpeg in order and never has more than one in hand.
 */
function openFrameSocket(jobId) {
  return new Promise((resolve) => {
    let ws
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/export/${jobId}/stream`)
    } catch {
      return resolve(null)
    }
    ws.binaryType = 'arraybuffer'
    let pending = null
    const settle = (value) => {
      const p = pending
      pending = null
      p?.(value)
    }
    ws.onopen = () =>
      resolve({
        frame(bytes) {
          return new Promise((res) => {
            pending = res
            ws.send(bytes)
          })
        },
        close() {
          try { ws.close() } catch { /* already closed */ }
        },
      })
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { msg = { error: 'bad ack' } }
      settle(msg)
    }
    ws.onerror = () => {
      if (pending) settle({ error: 'the frame socket failed' })
      else resolve(null)
    }
    ws.onclose = () => {
      if (pending) settle({ error: 'the frame socket closed' })
      else resolve(null)
    }
  })
}

/* ------------------------------------------------------------------- quick */

export function pickQuickMime(wantAlpha) {
  // VP8 is the codec Chrome's MediaRecorder will actually encode alpha with.
  const candidates = wantAlpha
    ? ['video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4;codecs=avc1.42E01E', 'video/webm']
  for (const m of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m
  }
  return ''
}

export async function quickExport({ host, clip, onProgress, signal }) {
  if (!window.MediaRecorder) throw new Error('MediaRecorder is not available in this browser')

  const wantAlpha = clip.background.mode === 'transparent'
  const mime = pickQuickMime(wantAlpha)
  const background = clip.background.mode === 'color' ? clip.background.color : null

  onProgress({ phase: 'preparing', progress: 0 })
  await host.reload()
  await host.raster.drawFrame(background)

  // captureStream(0) hands us manual control: a frame is published only when
  // requestFrame() is called, so a slow rasterize stretches the frame it is on
  // rather than silently duplicating the previous one.
  const stream = host.raster.canvas.captureStream(0)
  const track = stream.getVideoTracks()[0]

  const rec = new MediaRecorder(stream, {
    mimeType: mime || undefined,
    videoBitsPerSecond: Math.round(clip.width * clip.height * clip.fps * 0.12),
  })
  const chunks = []
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  const stopped = new Promise((res, rej) => {
    rec.onstop = res
    rec.onerror = (e) => rej(e.error ?? new Error('MediaRecorder failed'))
  })

  rec.start()
  const t0 = performance.now()
  let drawn = 0

  const frameInterval = 1000 / clip.fps
  const target = Math.round((clip.durationMs / 1000) * clip.fps)
  let lastIndex = -1

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      const elapsed = performance.now() - t0
      if (elapsed >= clip.durationMs) break

      // Pace to the clip's frame rate. Without this the loop pushes a frame as
      // fast as it can rasterize — several times the requested fps on a simple
      // clip, which bloats the file for no extra detail.
      const index = Math.floor(elapsed / frameInterval)
      if (index === lastIndex) {
        await sleep(1)
        continue
      }
      lastIndex = index

      await host.seek(elapsed)
      await host.raster.drawFrame(background)
      track.requestFrame()
      drawn++

      onProgress({
        phase: 'recording',
        progress: Math.min(1, elapsed / clip.durationMs),
        frame: drawn,
        frameCount: target,
      })
      await sleep(0)
    }
  } finally {
    rec.stop()
    track.stop()
  }

  await stopped
  const blob = new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' })
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
  let filename = `${clip.name.replace(/[^A-Za-z0-9_-]+/g, '-') || 'clip'}-quick.${ext}`

  // MediaRecorder writes no duration and no seek index. A stream copy on
  // the server rebuilds both; if that is not available, the raw recording
  // is still handed over.
  onProgress({ phase: 'finalizing', progress: 1, frame: drawn, frameCount: target })
  let finalized = null
  try {
    const res = await fetch(`/api/export/quick?name=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'video/webm' },
      body: blob,
    })
    if (res.ok) finalized = await res.json()
  } catch {
    finalized = null
  }
  if (finalized) {
    filename = finalized.filename
    triggerDownload(finalized.url, filename)
  } else {
    const url = URL.createObjectURL(blob)
    triggerDownload(url, filename)
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  const realFps = drawn / (clip.durationMs / 1000)
  onProgress({
    phase: 'complete',
    progress: 1,
    size: finalized?.size ?? blob.size,
    filename,
    frames: drawn,
    realFps,
  })
  return { blob, filename, size: finalized?.size ?? blob.size, frames: drawn, realFps, mime, finalized: !!finalized }
}
