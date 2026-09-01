/**
 * Rendering with no server.
 *
 * The server render is two halves: the browser draws every animation layer and
 * ffmpeg composites them over the footage. Half of that was already happening
 * here — `compositor.snapshot(t)` paints the entire stage, every layer, in
 * order, onto one canvas. So a browser-only render is the other half brought
 * home: walk the timeline a frame at a time, hand each canvas to a hardware
 * video encoder, mix the sound in an offline audio graph, and write an MP4.
 *
 * It is frame-exact for the same reason the server path is: the clock is a
 * counter, not a wall clock. Nothing is captured in real time, nothing is
 * dropped when a frame takes too long to draw, and a title that rasterizes in
 * 80 ms simply makes the render slower rather than making the file wrong.
 *
 * What it cannot do is alpha — no browser encoder writes an alpha channel into
 * MP4 — so a transparent timeline comes out over its background colour. That is
 * the one thing the server still does better, and the UI says so rather than
 * quietly flattening it.
 */

import { Muxer, ArrayBufferTarget } from '/vendor/mp4-muxer.mjs'
import { audioTracks, sequenceDuration, sourceTimeAt, speedOf } from '/sequence.js'
import { mediaUrl } from '/localstore.js'

/** What a browser can actually write. Offered instead of the server's list. */
export const CLIENT_FORMATS = [
  {
    id: 'mp4',
    label: 'MP4 · H.264 + AAC',
    ext: 'mp4',
    mime: 'video/mp4',
    alpha: false,
    alphaVerified: false,
    note: 'Encoded in this browser with WebCodecs — hardware accelerated, frame-exact, never uploaded. Plays everywhere.',
  },
]

const isAborted = (signal) => {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
}

/* ----------------------------------------------------------------- video */

/**
 * H.264 at a level that covers 4K, falling back through what this machine has.
 *
 * `isConfigSupported` is asked rather than assumed: hardware encoders differ,
 * and a rejected config throws asynchronously in a place that is hard to
 * attribute later.
 */
async function pickVideoCodec(width, height, fps, bitrate) {
  const candidates = ['avc1.640034', 'avc1.640028', 'avc1.4d0032', 'avc1.42E01E']
  for (const codec of candidates) {
    const config = {
      codec, width, height, framerate: fps, bitrate,
      avc: { format: 'avc' },
    }
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config)
      if (supported) return config
    } catch {
      /* try the next */
    }
  }
  throw new Error('this browser has no H.264 encoder — Chrome 94+ is needed')
}

async function pickAudioCodec(channels, sampleRate) {
  for (const codec of ['mp4a.40.2', 'opus']) {
    const config = { codec, numberOfChannels: channels, sampleRate, bitrate: 192_000 }
    try {
      const { supported } = await AudioEncoder.isConfigSupported(config)
      if (supported) return config
    } catch {
      /* try the next */
    }
  }
  return null
}

/* ----------------------------------------------------------------- audio */

/**
 * Every sounding item, mixed offline into one buffer.
 *
 * An `OfflineAudioContext` is the browser's equivalent of the filtergraph's
 * `amix`: sources start at their own moment, a gain node per item carries the
 * volume and the fades as real ramps, and `playbackRate` does what `atempo`
 * does — except it moves the pitch, which is the one place this path and the
 * server's differ audibly. Rendering is faster than real time.
 */
async function mixAudio({ seq, media, fromMs, toMs, signal, onProgress }) {
  const spanMs = toMs - fromMs
  const rate = 48_000
  const frames = Math.ceil((spanMs / 1000) * rate)
  if (frames <= 0) return null

  const items = []
  for (const track of audioTracks(seq).concat(seq.tracks.filter((t) => t.kind === 'video'))) {
    if (track.muted) continue
    for (const item of track.items) {
      if (item.type !== 'media' || item.muted) continue
      const m = media.get(item.sourceId)
      if (!m?.hasAudio) continue
      if ((item.volume ?? 1) <= 0) continue
      if (item.startMs >= toMs || item.startMs + item.durationMs <= fromMs) continue
      items.push({ item, media: m })
    }
  }
  if (!items.length) return null

  const ctx = new OfflineAudioContext(2, frames, rate)
  // One decode per distinct file, however many times it is cut in.
  const decoded = new Map()
  for (const { item } of items) {
    if (decoded.has(item.sourceId)) continue
    isAborted(signal)
    onProgress?.({ phase: 'audio', label: `decoding ${item.sourceId}` })
    try {
      const url = (await mediaUrl(item.sourceId)) ?? `/media/${item.sourceId}`
      const blob = await (await fetch(url)).blob()
      // Same ceiling the import uses: decoding is all-or-nothing and an hour
      // of stereo is most of a gigabyte of float32. Better one silent layer,
      // said out loud, than a render that dies at 80%.
      if (blob.size > 400 * 1024 * 1024) {
        onProgress?.({ phase: 'audio', note: `"${item.sourceId}" is too large to decode in the browser — its sound is left out` })
        decoded.set(item.sourceId, null)
        continue
      }
      decoded.set(item.sourceId, await ctx.decodeAudioData(await blob.arrayBuffer()))
    } catch {
      decoded.set(item.sourceId, null)
    }
  }

  for (const { item } of items) {
    const buf = decoded.get(item.sourceId)
    if (!buf) continue
    const speed = speedOf(item)
    const startS = Math.max(0, (item.startMs - fromMs) / 1000)
    // Where in the file, and how much of it: a sped-up item eats more source
    // than it occupies on the timeline.
    const offsetS = sourceTimeAt(item, Math.max(item.startMs, fromMs)) / 1000
    const endMs = Math.min(item.startMs + item.durationMs, toMs)
    const lenS = Math.max(0, (endMs - Math.max(item.startMs, fromMs)) / 1000)
    if (lenS <= 0) continue

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = speed
    const gain = ctx.createGain()
    const vol = Math.max(0, item.volume ?? 1)
    gain.gain.setValueAtTime(vol, 0)

    const fadeIn = Math.min((item.fadeInMs ?? 0) / 1000, lenS)
    const fadeOut = Math.min((item.fadeOutMs ?? 0) / 1000, lenS)
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, startS)
      gain.gain.linearRampToValueAtTime(vol, startS + fadeIn)
    }
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(vol, startS + lenS - fadeOut)
      gain.gain.linearRampToValueAtTime(0, startS + lenS)
    }
    src.connect(gain).connect(ctx.destination)
    src.start(startS, offsetS, lenS * speed)
  }

  isAborted(signal)
  onProgress?.({ phase: 'audio', label: 'mixing' })
  return ctx.startRendering()
}

/* ------------------------------------------------------------ one clip */

/**
 * A single animation clip to an MP4, in this browser.
 *
 * Same encoder as the timeline; the difference is where the frames come from —
 * a clip is one document on a virtual clock, so it is seeked and rasterized
 * directly rather than composited.
 *
 * A clip is the one place alpha is usually the point (an overlay is meant to
 * sit over something), and no browser writes alpha into MP4. So a transparent
 * clip is rendered over the checkerboard's stand-in colour and the caller is
 * told, rather than being handed a file that looks right until it is layered.
 */
export async function exportClipLocal({ host, clip, onProgress = () => {}, signal }) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('this browser has no WebCodecs — Chrome 94+ is needed to render here')
  }
  const W = clip.width
  const H = clip.height
  const fps = clip.fps || 30
  const frameCount = Math.max(1, Math.round((clip.durationMs / 1000) * fps))
  const started = performance.now()
  const transparent = clip.background?.mode !== 'color'
  const background = transparent ? '#000000' : clip.background.color

  const videoConfig = await pickVideoCodec(W, H, fps, Math.max(1_000_000, Math.min(W * H * fps * 0.16, 80_000_000)))
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    fastStart: 'in-memory',
  })

  let encodeError = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e },
  })
  encoder.configure(videoConfig)

  try {
    for (let i = 0; i < frameCount; i++) {
      isAborted(signal)
      if (encodeError) throw encodeError

      const t = (i * 1000) / fps
      // The virtual clock only runs forwards; if it ever rewinds mid-render the
      // rest of the frames would be identical and the file would look fine.
      const seeked = await host.seek(t)
      if (seeked?.rewound) {
        throw new Error(`clock desync at frame ${i}: asked for ${t.toFixed(1)}ms but the stage is at ${seeked.time.toFixed(1)}ms`)
      }
      await host.raster.drawFrame(background)

      const frame = new VideoFrame(host.raster.canvas, {
        timestamp: Math.round((i * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      })
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
      frame.close()

      if (encoder.encodeQueueSize > 8) {
        await new Promise((r) => {
          const wait = () => (encoder.encodeQueueSize > 4 ? setTimeout(wait, 8) : r())
          wait()
        })
      }
      if (i % 5 === 0 || i === frameCount - 1) {
        onProgress({ phase: 'encoding', frame: i + 1, frameCount, progress: (i + 1) / frameCount })
      }
    }
    await encoder.flush()
    if (encodeError) throw encodeError

    muxer.finalize()
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' })
    onProgress({ phase: 'complete', progress: 1 })
    return {
      filename: `${(clip.name || 'clip').replace(/[^A-Za-z0-9._-]+/g, '-')}.mp4`,
      size: blob.size,
      durationMs: clip.durationMs,
      elapsedMs: Math.round(performance.now() - started),
      frames: frameCount,
      blob,
      downloadUrl: URL.createObjectURL(blob),
      local: true,
      flattened: transparent,
    }
  } finally {
    try { if (encoder.state !== 'closed') encoder.close() } catch { /* already gone */ }
  }
}

/* ---------------------------------------------------------------- render */

/**
 * The whole timeline to an MP4, in this browser.
 *
 * Mirrors `renderSequence`'s shape so the caller cannot tell which one it got.
 */
export async function renderSequenceLocal({
  seq,
  compositor,
  media,
  quality = 20,
  onProgress = () => {},
  signal,
  fromMs = null,
  toMs = null,
  output = 'both',
}) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('this browser has no WebCodecs — Chrome 94+ is needed to render here')
  }
  const total = sequenceDuration(seq)
  if (total <= 0) throw new Error('the timeline is empty')

  const from = Math.max(0, fromMs ?? 0)
  const to = Math.min(total, toMs ?? total)
  if (to - from < 40) throw new Error('the range is empty')

  const W = seq.width
  const H = seq.height
  const fps = seq.fps || 30
  const frameCount = Math.max(1, Math.round(((to - from) / 1000) * fps))
  const started = performance.now()

  // CRF is an ffmpeg idea; a browser encoder wants bits per second. Lower CRF
  // means better, so the mapping is inverted, and scaled by how many pixels a
  // second there are to spend them on.
  const pixels = W * H * fps
  const bitrate = Math.round(pixels * (0.16 * Math.pow(0.75, (quality - 18) / 6)))

  const videoConfig = await pickVideoCodec(W, H, fps, Math.max(1_000_000, Math.min(bitrate, 80_000_000)))

  onProgress({ phase: 'audio', progress: 0, label: 'mixing sound…' })
  const mixed = output === 'video' ? null : await mixAudio({ seq, media, fromMs: from, toMs: to, signal, onProgress })
  const audioConfig = mixed ? await pickAudioCodec(mixed.numberOfChannels, mixed.sampleRate) : null

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    ...(audioConfig
      ? { audio: { codec: audioConfig.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: mixed.numberOfChannels, sampleRate: mixed.sampleRate } }
      : {}),
    // The moov atom up front, so the file plays before it has finished
    // downloading — which is what anyone does with it next.
    fastStart: 'in-memory',
  })

  let encodeError = null
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e },
  })
  videoEncoder.configure(videoConfig)

  /* ------------------------------------------------------------ picture */

  const wasPlaying = compositor.playing
  compositor.pause()
  try {
    for (let n = 0; n < frameCount; n++) {
      isAborted(signal)
      if (encodeError) throw encodeError

      const t = from + (n * 1000) / fps
      const canvas = await compositor.snapshot(t)
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((n * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      })
      // A keyframe every two seconds: enough for a player to seek, few enough
      // not to double the file.
      videoEncoder.encode(frame, { keyFrame: n % (fps * 2) === 0 })
      frame.close()

      // The encoder queues; letting it get far ahead is how a long render runs
      // the tab out of memory.
      if (videoEncoder.encodeQueueSize > 8) {
        await new Promise((r) => {
          const wait = () => (videoEncoder.encodeQueueSize > 4 ? setTimeout(wait, 8) : r())
          wait()
        })
      }

      if (n % 5 === 0 || n === frameCount - 1) {
        onProgress({
          phase: 'encoding',
          frame: n + 1,
          frameCount,
          progress: ((n + 1) / frameCount) * (audioConfig ? 0.9 : 1),
          label: `frame ${n + 1} of ${frameCount}`,
        })
      }
    }
    await videoEncoder.flush()
    if (encodeError) throw encodeError

    /* -------------------------------------------------------------- sound */

    if (audioConfig && mixed) {
      onProgress({ phase: 'encoding', progress: 0.92, label: 'encoding sound…' })
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => { encodeError = e },
      })
      audioEncoder.configure(audioConfig)

      // In slices, because one AudioData of a ten-minute mix is hundreds of
      // megabytes and the encoder wants it in pieces anyway.
      const chunkFrames = mixed.sampleRate
      const channels = mixed.numberOfChannels
      for (let offset = 0; offset < mixed.length; offset += chunkFrames) {
        isAborted(signal)
        const len = Math.min(chunkFrames, mixed.length - offset)
        const interleaved = new Float32Array(len * channels)
        for (let c = 0; c < channels; c++) {
          const data = mixed.getChannelData(c)
          for (let i = 0; i < len; i++) interleaved[i * channels + c] = data[offset + i]
        }
        const audio = new AudioData({
          format: 'f32',
          sampleRate: mixed.sampleRate,
          numberOfFrames: len,
          numberOfChannels: channels,
          timestamp: Math.round((offset / mixed.sampleRate) * 1_000_000),
          data: interleaved,
        })
        audioEncoder.encode(audio)
        audio.close()
      }
      await audioEncoder.flush()
      audioEncoder.close()
      if (encodeError) throw encodeError
    }

    muxer.finalize()
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' })
    const filename = `${(seq.name || 'timeline').replace(/[^A-Za-z0-9._-]+/g, '-')}.mp4`

    onProgress({ phase: 'complete', progress: 1 })
    return {
      filename,
      size: blob.size,
      durationMs: to - from,
      elapsedMs: Math.round(performance.now() - started),
      layers: frameCount,
      audio: audioConfig ? 1 : 0,
      blob,
      downloadUrl: URL.createObjectURL(blob),
      local: true,
    }
  } finally {
    try { if (videoEncoder.state !== 'closed') videoEncoder.close() } catch { /* already gone */ }
    if (wasPlaying) compositor.play()
  }
}
