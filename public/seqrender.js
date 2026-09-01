/**
 * Rendering a timeline.
 *
 * Two stages, and the split is the whole point of the design:
 *
 *   1. Every animation and caption layer is rendered by the existing
 *      frame-exact path into a file with a real alpha channel. Only the
 *      animated seconds pay for DOM rasterization.
 *   2. ffmpeg composites those over the source footage and mixes the audio.
 *      The footage itself never touches a canvas, so it keeps its own colour,
 *      its own scaling, and its own bit depth.
 *
 * The overlays are rendered in offscreen frames, so the preview the user is
 * looking at is not torn apart for the length of the render.
 */

import { studioExport } from '/export.js'
import { createOffscreenHost } from '/stagehost.js'
import {
  bakedScale, compositeOrder, layerBox, overlayClipFor, scaleOf, sequenceDuration,
  sourceSpanOf, speedOf, timelineOf,
} from '/sequence.js'
import {
  blendOf, colourOf, cropOf, radiusOf, rotationOf, rotationPad, shadowOf, shadowPad,
} from '/effects.js'
import { KEYABLE, keysFor } from '/keys.js'

/**
 * The moving half of a layer, as plain numbers the filtergraph can rebuild.
 *
 * `scale` is normalised to a multiplier on the *layer's own* pixels: an overlay
 * whose file was already rendered at its peak size sends the ratio down from
 * there, so the two halves mean the same thing by "twice as big".
 */
function keyFields(item, { bake = 1, total = null } = {}) {
  const keys = {}
  for (const prop of KEYABLE) {
    const list = keysFor(item, prop)
    if (!list) continue
    keys[prop] = prop === 'scale' ? list.map((k) => ({ ...k, v: k.v / bake })) : list
  }
  if (!Object.keys(keys).length) return {}
  return {
    keys,
    // The margin as a fraction of the layer, so it still lands right when the
    // size it is a margin *on* is moving.
    ...(total?.w ? { padFracX: (total.padX ?? 0) / total.w } : {}),
    ...(total?.h ? { padFracY: (total.padY ?? 0) / total.h } : {}),
  }
}

/**
 * The effect half of a plan layer, for footage and nested blocks.
 *
 * An overlay never comes through here: its turn, mirror, colour, rounding and
 * shadow are already in the file, baked into the clip a browser rendered. Only
 * `blend` is left out of that, because blending needs what is underneath and a
 * clip is rendered alone.
 */
function effectFields(item, box, { overlay = false } = {}) {
  const blend = blendOf(item)
  // A picture fade belongs to every kind of layer, overlays included: it is the
  // only half of a cross dissolve either side of one knows about.
  const dissolve = {
    ...(item.dissolveInMs ? { dissolveInMs: Math.round(item.dissolveInMs) } : {}),
    ...(item.dissolveOutMs ? { dissolveOutMs: Math.round(item.dissolveOutMs) } : {}),
  }
  // An overlay's effects are already in its file; only where it *sits* is left
  // to say, and the turn and shadow baked into it added a margin the anchor
  // must not count — the same discount `layerBox` makes for the preview.
  if (overlay) {
    return {
      ...dissolve,
      ...(blend ? { blend } : {}),
      padX: Math.round(box?.padX ?? 0),
      padY: Math.round(box?.padY ?? 0),
      ...keyFields(item, {
        bake: bakedScale(item),
        total: box ? { w: box.w, h: box.h, padX: box.padX ?? 0, padY: box.padY ?? 0 } : null,
      }),
    }
  }
  const rotation = rotationOf(item)
  const shadow = shadowOf(item)
  const pad = box ? rotationPad(box.w, box.h, rotation) : { x: 0, y: 0 }
  const sp = shadowPad(shadow)
  return {
    ...dissolve,
    ...keyFields(item, {
      bake: 1,
      total: box ? { w: box.w + 2 * (pad.x + sp), h: box.h + 2 * (pad.y + sp), padX: pad.x + sp, padY: pad.y + sp } : null,
    }),
    crop: cropOf(item),
    flipH: !!item.flipH,
    flipV: !!item.flipV,
    rotation,
    // Transparent margin the turn and the shadow added, which the anchor
    // arithmetic has to discount so "left" still means the left of the picture.
    padX: pad.x + sp,
    padY: pad.y + sp,
    colour: colourOf(item),
    blend,
    radius: radiusOf(item),
    shadow,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Formats an overlay layer can be handed to ffmpeg in.
 *
 * All of them must carry a real alpha channel — an overlay that loses its
 * transparency becomes an opaque rectangle covering every layer beneath it,
 * and nothing in the render logs says so. Which of these this machine's ffmpeg
 * genuinely produces is checked at startup, not assumed.
 */
const OVERLAY_FORMATS = {
  qtrle: { format: 'qtrle', quality: 0, label: 'QuickTime Animation' },
  mov: { format: 'mov', quality: 0, label: 'ProRes 4444' },
  webm: { format: 'webm', quality: 18, label: 'WebM VP9 alpha' },
}

/**
 * Render one overlay item (animation, caption or text) to an alpha file.
 * Returns `{skipped}` when there is nothing to draw. Shared by the timeline
 * render and by part exports, which hand the file out on its own.
 */
export async function renderOverlayItem({ item, seq, clips, transcripts, assets, overlayFormat = 'qtrle', signal, onProgress = () => {} }) {
  if (item.type === 'timeline') return { skipped: `"${item.name}" is a timeline block — render_timeline it with a range instead` }
  const clip = overlayClipFor(item, { clips, transcripts, seq, assets })
  if (!clip) return { skipped: `"${item.name}" — its source is gone` }
  if (item.type === 'caption' && clip.cueCount === 0) return { skipped: `"${item.name}" — no cues in that range` }
  if (item.type === 'text' && clip.empty) return { skipped: `"${item.name}" — no text` }

  const ovSpec = OVERLAY_FORMATS[overlayFormat] ?? OVERLAY_FORMATS.qtrle
  const host = createOffscreenHost(clip)
  try {
    const result = await studioExport({ host, clip, format: ovSpec.format, quality: ovSpec.quality, download: false, signal, onProgress })
    return { file: result.filename, durationMs: clip.durationMs, size: result.size }
  } finally {
    host.dispose()
  }
}

export async function renderSequence({
  seq,
  clips,
  transcripts,
  media,
  // Image assets, for image items.
  assets = new Map(),
  // Every timeline of the project, for the blocks that play another one.
  timelines = new Map(),
  format = 'mp4',
  quality = 20,
  overlayFormat = 'qtrle',
  onProgress = () => {},
  signal,
  // A window of the timeline, and whether picture, sound or both come out.
  fromMs = null,
  toMs = null,
  output = 'both',
  // Set by a parent render: the parent's colour under an opaque section, and
  // a cache so one child placed twice is rendered once.
  background = null,
  cache = new Map(),
  depth = 0,
}) {
  const durationMs = sequenceDuration(seq)
  if (durationMs <= 0) throw new Error('the timeline is empty')
  const range = fromMs != null && toMs != null ? { fromMs: Math.max(0, fromMs), toMs: Math.min(durationMs, toMs) } : null
  if (range && range.toMs - range.fromMs < 40) throw new Error('the range is empty')

  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  }
  const inRange = (item) => !range || (item.startMs < range.toMs && item.startMs + item.durationMs > range.fromMs)

  /* --------------------------------------------------- 1. overlay renders */

  const overlayItems = []
  if (output !== 'audio') {
    for (const track of compositeOrder(seq)) {
      if (track.hidden) continue
      for (const item of track.items) {
        if (item.type !== 'media' && item.type !== 'timeline' && inRange(item)) overlayItems.push({ track, item })
      }
    }
  }

  /* ------------------------------------------------ 1b. nested timelines */

  // A block that plays another timeline is rendered first, on its own, to a
  // file the parent then treats as footage. Picture and sound come out
  // together (a ProRes 4444 .mov carries both, with alpha), except where the
  // block sits on the bottom video track: there nothing shows through it, so
  // it is an opaque mp4 over the parent's colour — a ProRes intermediate of
  // an eight-minute section would run to tens of gigabytes.
  const nestedItems = []
  const bottom = compositeOrder(seq)[0] ?? null
  for (const track of seq.tracks) {
    if (track.kind === 'video' && track.hidden) continue
    if (track.kind === 'audio' && track.muted) continue
    for (const item of track.items) {
      if (item.type === 'timeline' && inRange(item)) nestedItems.push({ track, item })
    }
  }
  const nestedFiles = new Map() // itemId -> { file, durationMs, video, audio }
  const parentBg = background ?? seq.background ?? { mode: 'color', color: '#000000' }
  const steps = overlayItems.length + nestedItems.length

  for (let i = 0; i < nestedItems.length; i++) {
    throwIfAborted()
    const { track, item } = nestedItems[i]
    const child = timelineOf(timelines, item.sourceId)
    const note = (why) => onProgress({ phase: 'overlays', note: `skipped "${item.name}" — ${why}`, progress: i / (steps + 1) })
    if (!child) { note('its timeline is gone'); continue }
    if (depth >= 8) { note('nested too deep'); continue }
    const content = sequenceDuration(child)
    const from = item.inMs
    const to = Math.min(content, item.inMs + item.durationMs)
    if (to - from < 40) { note('it starts past the end of its content'); continue }

    const silent = track.muted || item.muted || (item.volume ?? 1) <= 0
    let childOutput = track.kind === 'audio' ? 'audio' : silent ? 'video' : 'both'
    if (output === 'video') { if (childOutput === 'audio') continue; childOutput = 'video' }
    if (output === 'audio') { if (childOutput === 'video') continue; childOutput = 'audio' }
    const opaque = track === bottom && parentBg.mode === 'color'
    const childFormat = childOutput === 'audio' ? 'wav' : opaque ? 'mp4' : 'mov'
    const key = [child.id, from, to, childOutput, childFormat, child.rev ?? 0, opaque ? parentBg.color : ''].join('|')

    let made = cache.get(key)
    if (!made) {
      try {
        const r = await renderSequence({
          seq: child, clips, transcripts, media, timelines, assets,
          format: childFormat, quality, overlayFormat, signal,
          fromMs: from, toMs: to, output: childOutput,
          background: opaque ? parentBg : null,
          cache, depth: depth + 1,
          onProgress: (p) => {
            if (p.note) { onProgress({ phase: 'overlays', note: `${child.name}: ${p.note}`, progress: i / (steps + 1) }); return }
            onProgress({
              phase: 'overlays',
              label: `${child.name} — ${Math.round((p.progress ?? 0) * 100)}%`,
              progress: ((i + (p.progress ?? 0)) / (steps || 1)) * 0.7,
            })
          },
        })
        made = { file: r.filename, durationMs: to - from, video: childOutput !== 'audio' && r.layers > 0, audio: r.audio > 0 }
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        note(err?.message ?? String(err))
        continue
      }
      cache.set(key, made)
    }
    nestedFiles.set(item.id, made)
  }

  const rendered = new Map() // itemId -> { file, durationMs }

  for (let i = 0; i < overlayItems.length; i++) {
    throwIfAborted()
    const { item } = overlayItems[i]
    const n = nestedItems.length + i
    const r = await renderOverlayItem({
      item, seq, clips, transcripts, assets, overlayFormat, signal,
      onProgress: (p) => {
        onProgress({
          phase: 'overlays',
          label: `${item.name || 'overlay'} — layer ${n + 1} of ${steps}`,
          frame: p.frame,
          frameCount: p.frameCount,
          // Overlays are the slow half; give them 70% of the bar.
          progress: ((n + (p.progress ?? 0)) / (steps || 1)) * 0.7,
        })
      },
    })
    if (r.skipped) {
      onProgress({ phase: 'overlays', note: `skipped ${r.skipped}`, progress: n / (steps + 1) })
      continue
    }
    rendered.set(item.id, { file: r.file, durationMs: r.durationMs })
  }

  throwIfAborted()

  /* ------------------------------------------------------------ 2. the plan */

  const ctx = { seq, clips, transcripts, assets, media, timelines }
  const videoLayers = []
  for (const track of compositeOrder(seq)) {
    if (track.hidden) continue
    for (const item of track.items) {
      if (item.type === 'media') {
        const m = media.get(item.sourceId)
        if (!m || !m.hasVideo) continue
        videoLayers.push({
          source: 'media',
          file: item.sourceId,
          startMs: item.startMs,
          // Clamped by what is left of the source, converted back to timeline
          // time — an item at 2× runs out of footage twice as fast.
          durationMs: Math.min(item.durationMs, Math.max(40, m.durationMs - item.inMs) / speedOf(item)),
          inMs: item.inMs,
          speed: speedOf(item),
          fit: item.fit ?? 'contain',
          anchor: item.anchor ?? 'center',
          offsetX: item.offsetX ?? 0,
          offsetY: item.offsetY ?? 0,
          opacity: item.opacity ?? 1,
          scale: scaleOf(item),
          ...effectFields(item, layerBox(item, ctx)),
        })
        continue
      }
      if (item.type === 'timeline') {
        const n = nestedFiles.get(item.id)
        if (!n?.video) continue
        // Rendered for exactly the block's window, so it starts from zero and
        // fits the frame the way the block says — this is footage now.
        videoLayers.push({
          source: 'export',
          file: n.file,
          startMs: item.startMs,
          durationMs: Math.min(item.durationMs, n.durationMs),
          inMs: 0,
          fit: item.fit ?? 'contain',
          anchor: item.anchor ?? 'center',
          offsetX: item.offsetX ?? 0,
          offsetY: item.offsetY ?? 0,
          opacity: item.opacity ?? 1,
          scale: scaleOf(item),
          ...effectFields(item, layerBox(item, ctx)),
        })
        continue
      }
      const made = rendered.get(item.id)
      if (!made) continue
      // An animation item's in-point trims the rendered file, exactly as a
      // media item's trims its footage. A caption clip was generated relative
      // to its own in-point already, so it starts from zero.
      const inMs = item.type === 'caption' ? 0 : item.inMs
      videoLayers.push({
        source: 'export',
        file: made.file,
        startMs: item.startMs,
        durationMs: Math.min(item.durationMs, Math.max(40, made.durationMs - inMs) / speedOf(item)),
        inMs,
        speed: speedOf(item),
        fit: 'none',
        anchor: item.anchor ?? 'center',
        offsetX: item.offsetX ?? 0,
        offsetY: item.offsetY ?? 0,
        opacity: item.opacity ?? 1,
        ...effectFields(item, layerBox(item, ctx), { overlay: true }),
      })
    }
  }

  const audioLayers = []
  for (const track of seq.tracks) {
    if (track.muted) continue
    for (const item of track.items) {
      if (item.type === 'timeline') {
        // Only when the child actually produced sound: ffmpeg fails outright
        // on an input mapped for audio that has no audio stream.
        const n = nestedFiles.get(item.id)
        if (!n?.audio || item.muted || (item.volume ?? 1) <= 0) continue
        audioLayers.push({
          source: 'export',
          file: n.file,
          startMs: item.startMs,
          durationMs: Math.min(item.durationMs, n.durationMs),
          inMs: 0,
          volume: item.volume ?? 1,
          fadeInMs: item.fadeInMs ?? 0,
          fadeOutMs: item.fadeOutMs ?? 0,
        })
        continue
      }
      if (item.type !== 'media' || item.muted) continue
      const m = media.get(item.sourceId)
      if (!m?.hasAudio) continue
      const volume = item.volume ?? 1
      if (volume <= 0) continue
      audioLayers.push({
        source: 'media',
        file: item.sourceId,
        startMs: item.startMs,
        durationMs: Math.min(item.durationMs, Math.max(40, m.durationMs - item.inMs) / speedOf(item)),
        inMs: item.inMs,
        speed: speedOf(item),
        volume,
        fadeInMs: item.fadeInMs ?? 0,
        fadeOutMs: item.fadeOutMs ?? 0,
      })
    }
  }

  if ((output === 'audio' && !audioLayers.length) || (output === 'video' && !videoLayers.length) || (!videoLayers.length && !audioLayers.length)) {
    throw new Error('nothing to render — every item is hidden, muted or missing its source')
  }

  const plan = {
    name: seq.name,
    format,
    quality,
    width: seq.width,
    height: seq.height,
    fps: seq.fps,
    durationMs,
    background: background ?? seq.background ?? { mode: 'color', color: '#000000' },
    video: output === 'audio' ? [] : videoLayers,
    audio: output === 'video' ? [] : audioLayers,
    output,
    ...(range ? { range } : {}),
  }

  /* ---------------------------------------------------------- 3. composite */

  onProgress({ phase: 'compositing', progress: 0.72, label: 'handing off to ffmpeg…' })

  const start = await fetch('/api/render/timeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan),
  })
  const started = await start.json()
  if (!start.ok) throw new Error(started.error ?? `render failed to start (${start.status})`)

  const jobId = started.jobId
  const abort = () => fetch(`/api/render/timeline/${jobId}/abort`, { method: 'POST' }).catch(() => {})

  try {
    for (;;) {
      if (signal?.aborted) {
        await abort()
        throw new DOMException('aborted', 'AbortError')
      }
      await sleep(350)

      const status = await fetch(`/api/render/timeline/${jobId}`).then((r) => r.json())
      if (status.state === 'failed') throw new Error(status.error ?? 'ffmpeg failed')
      if (status.state === 'aborted') throw new DOMException('aborted', 'AbortError')

      onProgress({
        phase: 'compositing',
        progress: 0.72 + (status.progress ?? 0) * 0.28,
        label: `compositing · ${(status.outTimeMs / 1000).toFixed(1)}s of ${(status.durationMs / 1000).toFixed(1)}s`,
      })

      if (status.state === 'complete') {
        onProgress({ phase: 'complete', progress: 1, ...status })
        return { ...status, overlays: rendered.size, nested: nestedFiles.size, layers: videoLayers.length, audio: audioLayers.length }
      }
    }
  } catch (err) {
    await abort()
    throw err
  }
}

/** What the render will do, without doing it — shown before the button is hit. */
export function describeRender(seq, { clips, transcripts, media, timelines, assets }) {
  const counts = { video: 0, overlay: 0, audio: 0, missing: 0, captionCues: 0, nested: 0 }

  for (const track of seq.tracks) {
    for (const item of track.items) {
      if (item.type === 'timeline') {
        if (timelineOf(timelines, item.sourceId)) counts.nested++
        else counts.missing++
        continue
      }
      if (item.type === 'media') {
        const m = media.get(item.sourceId)
        if (!m) { counts.missing++; continue }
        if (m.hasVideo && track.kind === 'video' && !track.hidden) counts.video++
        if (m.hasAudio && !track.muted && !item.muted && (item.volume ?? 1) > 0) counts.audio++
      } else if (item.type === 'animation') {
        if (clips.find((c) => c.id === item.sourceId)) counts.overlay++
        else counts.missing++
      } else if (item.type === 'text') {
        counts.overlay++
      } else if (item.type === 'image') {
        if (assets?.get?.(item.sourceId)) counts.overlay++
        else counts.missing++
      } else if (item.type === 'caption') {
        const t = transcripts.get(item.sourceId)
        if (!t) { counts.missing++; continue }
        counts.overlay++
        counts.captionCues += t.cues.filter(
          (c) => c.endMs > item.inMs && c.startMs < item.inMs + item.durationMs,
        ).length
      }
    }
  }
  return counts
}
