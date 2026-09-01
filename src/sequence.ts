import { unlink } from 'node:fs/promises'
/**
 * Sequence rendering — the timeline's way out.
 *
 * The browser renders animation layers exactly as it always has (frame-exact
 * DOM -> raw RGBA -> ProRes 4444 / VP9 with real alpha), and this module hands
 * those files, the source footage and the audio to a single ffmpeg filtergraph.
 *
 * Source video therefore never passes through a canvas: no 8-bit round trip, no
 * rescale in JavaScript, no per-frame decode stall. Only the animated seconds
 * pay the cost of DOM rasterization, and audio is mixed by the one tool that
 * should ever be mixing audio.
 *
 * Every visual layer is composited the same way — as an `overlay` onto a base
 * canvas, in z-order. That is what lets gaps, overlaps, mismatched resolutions
 * and transparent graphics all fall out of one code path instead of four.
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { MEDIA_DIR, safeMediaName } from './media'
import { EXPORT_DIR } from './paths'

export type LayerFit = 'contain' | 'cover' | 'fill' | 'none'
export type LayerAnchor =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface VideoLayer {
  /** `media` reads data/media, `export` reads data/exports (a rendered overlay). */
  source: 'media' | 'export'
  file: string
  /** Where the layer sits on the sequence timeline. */
  startMs: number
  durationMs: number
  /** In-point within the source file. */
  inMs: number
  /**
   * How fast the source runs against the timeline's clock. `durationMs` stays
   * timeline time whatever this is; only how much source is consumed, and the
   * presentation timestamps, change.
   */
  speed?: number
  fit: LayerFit
  anchor: LayerAnchor
  offsetX: number
  offsetY: number
  opacity: number
  /**
   * How much bigger than its own pixels the layer is drawn. Only `fit: none`
   * has anywhere to put it — the other three already say what size the layer
   * comes out at. An animation overlay never sets it: it is *re-rendered* at
   * the size it wants, so it stays sharp where a resample would not.
   */
  scale?: number

  /*
   * Everything below is set only for footage and nested blocks. An overlay is a
   * document a browser renders, so its turn, mirror, colour and rounding are
   * already baked into the file this layer points at — see `decoratedClip`.
   * These are the same effects said again in ffmpeg, for the two kinds of layer
   * that never pass through a browser.
   *
   * The order is fixed, and matches the CSS half exactly:
   *     crop → flip → fit/scale → rotate → colour → place
   */
  /** Fractions of the source cut off each edge, before anything else. */
  crop?: { top: number; right: number; bottom: number; left: number } | null
  flipH?: boolean
  flipV?: boolean
  /** Degrees clockwise, about the middle of the finished layer. */
  rotation?: number
  /**
   * Transparent margin `rotation` added per side. The anchor arithmetic must
   * not count it, or a layer anchored left would drift as it turns.
   */
  padX?: number
  padY?: number
  /**
   * A picture fade at the head and tail, in milliseconds — distinct from the
   * audio fades, which live on the audio layer. Two of these on neighbouring
   * layers are a cross dissolve: the outgoing one fades out under the incoming
   * one fading in.
   */
  dissolveInMs?: number
  dissolveOutMs?: number
  /**
   * A value that moves over the layer's own life. `ms` is counted from the
   * layer's start; `scale` is a multiplier on the layer's *own* pixels, so an
   * overlay whose file was already rendered large sends the ratio.
   *
   * Deliberately structured rather than pre-built expressions: the browser
   * says what it wants and this module decides how to say it to ffmpeg, so
   * nothing from a document is ever spliced into a filtergraph.
   */
  keys?: {
    offsetX?: Keyframe[]
    offsetY?: Keyframe[]
    scale?: Keyframe[]
    opacity?: Keyframe[]
  } | null
  /**
   * The transparent margin, as a fraction of the layer's own width and height
   * rather than in pixels — so it still lands correctly when the size moves.
   */
  padFracX?: number
  padFracY?: number
  colour?: { brightness: number; contrast: number; saturation: number; temperature: number } | null
  /** A CSS/ffmpeg blend mode; `normal` and absent both mean a plain overlay. */
  blend?: string | null
  /** Corner rounding, in frame pixels, applied to the placed layer. */
  radius?: number
  shadow?: { blur: number; x: number; y: number; color: string; opacity: number } | null
}

export interface Keyframe {
  /** Milliseconds from the layer's start. */
  ms: number
  v: number
  ease?: 'ease' | 'linear' | 'hold'
}

export interface AudioLayer {
  source: 'media' | 'export'
  file: string
  startMs: number
  durationMs: number
  inMs: number
  /** As on a video layer; `atempo` keeps the pitch where it was. */
  speed?: number
  volume: number
  fadeInMs: number
  fadeOutMs: number
}

export interface SequencePlan {
  name: string
  format: string
  quality: number
  width: number
  height: number
  fps: number
  durationMs: number
  background: { mode: 'transparent' | 'color'; color: string }
  /** Bottom layer first. */
  video: VideoLayer[]
  audio: AudioLayer[]
  /** Picture, sound, or both. Defaults to both. */
  output?: 'both' | 'video' | 'audio'
}

export interface SequenceFormatSpec {
  id: string
  label: string
  ext: string
  mime: string
  alpha: boolean
  note: string
  /** null for a sound-only container. */
  video: ((quality: number) => string[]) | null
  audio(): string[]
}

export const SEQUENCE_FORMATS: Record<string, SequenceFormatSpec> = {
  mp4: {
    id: 'mp4',
    label: 'MP4 · H.264 + AAC',
    ext: 'mp4',
    mime: 'video/mp4',
    alpha: false,
    note: 'The deliverable. Plays everywhere, carries sound, no alpha.',
    video: (q) => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(q), '-preset', 'medium', '-movflags', '+faststart'],
    audio: () => ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'],
  },
  mov: {
    id: 'mov',
    label: 'MOV · ProRes 4444 + PCM',
    ext: 'mov',
    mime: 'video/quicktime',
    alpha: true,
    note: 'Mastering copy: true alpha, uncompressed audio, edits again without loss. Large.',
    video: () => ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0'],
    audio: () => ['-c:a', 'pcm_s16le', '-ar', '48000'],
  },
  wav: {
    id: 'wav',
    label: 'WAV · sound only',
    ext: 'wav',
    mime: 'audio/wav',
    alpha: false,
    note: 'Sound only, uncompressed 48 kHz. What a voice tool wants.',
    video: null,
    audio: () => ['-c:a', 'pcm_s16le', '-ar', '48000'],
  },
  mp3: {
    id: 'mp3',
    label: 'MP3 · sound only',
    ext: 'mp3',
    mime: 'audio/mpeg',
    alpha: false,
    note: 'Sound only, small.',
    video: null,
    audio: () => ['-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '48000'],
  },
  webm: {
    id: 'webm',
    label: 'WebM · VP9 + Opus',
    ext: 'webm',
    mime: 'video/webm',
    alpha: true,
    note: 'Small, transparent in browsers, sound included.',
    video: (q) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', String(q), '-b:v', '0', '-auto-alt-ref', '0', '-row-mt', '1'],
    audio: () => ['-c:a', 'libopus', '-b:a', '160k', '-ar', '48000'],
  },
}

/* --------------------------------------------------------------- filtergraph */

const s3 = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3)

/** Anchor + offset -> an overlay x/y expression, in overlay's own variables. */
function placement(
  anchor: LayerAnchor,
  offsetX: number,
  offsetY: number,
  padX = 0,
  padY = 0,
  moving?: { x: string | null; y: string | null; padFracX: number; padFracY: number },
): { x: string; y: string } {
  // W/H are the base frame, w/h the layer being placed.
  //
  // `padX`/`padY` are transparent margin a rotation added on every side. The
  // *picture* is what an anchor names, so a left-anchored layer has to be pulled
  // back by the margin and a right-anchored one pushed forward by it; a centred
  // one is unaffected, because the margin is symmetrical about the middle.
  const xs: Record<string, [string, number]> = {
    'left': ['0', -1], 'top-left': ['0', -1], 'bottom-left': ['0', -1],
    'right': ['(W-w)', 1], 'top-right': ['(W-w)', 1], 'bottom-right': ['(W-w)', 1],
    'center': ['(W-w)/2', 0], 'top': ['(W-w)/2', 0], 'bottom': ['(W-w)/2', 0],
  }
  const ys: Record<string, [string, number]> = {
    'top': ['0', -1], 'top-left': ['0', -1], 'top-right': ['0', -1],
    'bottom': ['(H-h)', 1], 'bottom-left': ['(H-h)', 1], 'bottom-right': ['(H-h)', 1],
    'center': ['(H-h)/2', 0], 'left': ['(H-h)/2', 0], 'right': ['(H-h)/2', 0],
  }
  const [x, sx] = xs[anchor] ?? ['(W-w)/2', 0]
  const [y, sy] = ys[anchor] ?? ['(H-h)/2', 0]

  // When the offset moves — or the size does, which changes the margin — the
  // whole thing becomes one expression. The margin is written as a fraction of
  // the layer's current width so it still lands right at any size.
  if (moving && (moving.x || moving.y || moving.padFracX || moving.padFracY)) {
    const padXe = moving.padFracX ? `${sx >= 0 ? '+' : '-'}(w*${n4(Math.abs(sx) * moving.padFracX)})` : ''
    const padYe = moving.padFracY ? `${sy >= 0 ? '+' : '-'}(h*${n4(Math.abs(sy) * moving.padFracY)})` : ''
    return {
      x: `${x}+(${orNum(moving.x, offsetX || 0)})${sx ? padXe : ''}`,
      y: `${y}+(${orNum(moving.y, offsetY || 0)})${sy ? padYe : ''}`,
    }
  }

  const ox = Math.round((offsetX || 0) + sx * (padX || 0))
  const oy = Math.round((offsetY || 0) + sy * (padY || 0))
  return {
    x: ox ? `${x}${ox >= 0 ? '+' : ''}${ox}` : x,
    y: oy ? `${y}${oy >= 0 ? '+' : ''}${oy}` : y,
  }
}

/** The same placement, written in `pad`'s variables instead of `overlay`'s. */
function padPlacement(
  anchor: LayerAnchor,
  offsetX: number,
  offsetY: number,
  padX = 0,
  padY = 0,
): { x: string; y: string } {
  const { x, y } = placement(anchor, offsetX, offsetY, padX, padY)
  const swap = (e: string) => e.replace(/\bW\b/g, 'ow').replace(/\bw\b/g, 'iw').replace(/\bH\b/g, 'oh').replace(/\bh\b/g, 'ih')
  return { x: swap(x), y: swap(y) }
}

const n4 = (n: number) => Number(n).toFixed(4)

/**
 * A list of keyframes as one ffmpeg expression in `v` (a time in seconds,
 * counted from the layer's start).
 *
 * Built as nested `if`s from the outside in: before the first key it holds, in
 * each span it interpolates, after the last it holds. The three easings are
 * one line of arithmetic each — the same line `public/keys.js` computes in the
 * browser, which is what keeps the preview and the file on the same curve.
 */
function keyExpr(keys: Keyframe[] | undefined, v: string, fallback: number): string | null {
  const list = (keys ?? [])
    .filter((k) => Number.isFinite(k.ms) && Number.isFinite(k.v))
    .slice()
    .sort((a, b) => a.ms - b.ms)
  if (!list.length) return null
  if (list.length === 1) return n4(list[0].v)

  const shape = (ease: string | undefined, u: string) =>
    ease === 'hold' ? '0' : ease === 'linear' ? u : `(${u})*(${u})*(3-2*(${u}))`

  // Innermost first: past the last key the value holds.
  let expr = n4(list[list.length - 1].v)
  for (let i = list.length - 2; i >= 0; i--) {
    const a = list[i], b = list[i + 1]
    const t0 = a.ms / 1000, t1 = b.ms / 1000
    const span = t1 - t0
    const seg =
      span <= 0
        ? n4(b.v)
        : `${n4(a.v)}+(${n4(b.v - a.v)})*(${shape(a.ease, `((${v})-${n4(t0)})/${n4(span)}`)})`
    expr = `if(lt(${v},${n4(t1)}),${seg},${expr})`
  }
  // Before the first key it holds too.
  return `if(lt(${v},${n4(list[0].ms / 1000)}),${n4(list[0].v)},${expr})`
}

/** `fallback` is only reached when a property has no keys at all. */
const orNum = (expr: string | null, fallback: number) => expr ?? n4(fallback)

/** `atempo` is limited to 0.5–100 per instance, so slow rates are chained. */
function atempoChain(rate: number): string[] {
  if (!(rate > 0) || Math.abs(rate - 1) < 0.001) return []
  const out: string[] = []
  let r = rate
  while (r < 0.5) {
    out.push('atempo=0.5')
    r /= 0.5
  }
  while (r > 100) {
    out.push('atempo=100')
    r /= 100
  }
  if (Math.abs(r - 1) > 0.001) out.push(`atempo=${n4(r)}`)
  return out
}

/**
 * The filters that reproduce, in ffmpeg, everything `public/effects.js` does in
 * CSS — for the two layer kinds that never pass through a browser.
 *
 * Order is the contract: crop is in the source's own pixels so it comes first;
 * the fit follows; the turn is of the finished, sized layer; colour is last so
 * a tint is not resampled. Change the order here and the preview starts lying.
 */
function effectFilters(layer: VideoLayer, before: boolean): string[] {
  const out: string[] = []
  if (before) {
    const c = layer.crop
    if (c && (c.top || c.right || c.bottom || c.left)) {
      const kx = 1 - c.left - c.right, ky = 1 - c.top - c.bottom
      out.push(`crop=iw*${n4(kx)}:ih*${n4(ky)}:iw*${n4(c.left)}:ih*${n4(c.top)}`)
    }
    if (layer.flipH) out.push('hflip')
    if (layer.flipV) out.push('vflip')

    // Both of these are `geq`, and `geq` fixes its output size when the graph
    // is configured — put one after a per-frame `scale` and the layer stops
    // resizing, silently. So every geq happens here, on the source's own
    // pixels, before anything decides how big the layer ends up.
    //
    // Which also settles what a corner radius means: it is in the source's
    // pixels and scales with the layer, so a shot at 30% gets 30% of the
    // rounding. That is the reading the preview can match with one number.
    const r = Math.round(layer.radius ?? 0)
    // Rounded corners are a hole cut in the layer's own alpha; touching the
    // alpha plane alone leaves the colour exactly as it was.
    if (r > 0) {
      const inside =
        `if(gt(abs(X-(W-1)/2),(W-1)/2-${r})*gt(abs(Y-(H-1)/2),(H-1)/2-${r}),` +
        `lte(hypot(abs(X-(W-1)/2)-((W-1)/2-${r}),abs(Y-(H-1)/2)-((H-1)/2-${r})),${r}),1)`
      out.push('format=rgba', `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${inside}'`)
    }

    // An opacity that moves cannot go through `colorchannelmixer`, which takes
    // no expressions. `T` here is the layer's own time — the same zero the
    // keyframes are counted from.
    const alphaExpr = keyExpr(layer.keys?.opacity, 'T', layer.opacity)
    if (alphaExpr) out.push('format=rgba', `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${alphaExpr},0,1)'`)
    return out
  }

  const col = layer.colour
  if (col) {
    const t = col.temperature ?? 0
    const b = col.brightness ?? 1
    const gain = [b * (1 + 0.28 * t), b * (1 + 0.02 * t), b * (1 - 0.28 * t)]
    if (gain.some((g) => Math.abs(g - 1) > 0.001)) {
      out.push(`colorchannelmixer=rr=${n4(gain[0])}:gg=${n4(gain[1])}:bb=${n4(gain[2])}`)
    }
    const eq: string[] = []
    if (Math.abs((col.contrast ?? 1) - 1) > 0.001) eq.push(`contrast=${n4(col.contrast)}`)
    if (Math.abs((col.saturation ?? 1) - 1) > 0.001) eq.push(`saturation=${n4(col.saturation)}`)
    if (eq.length) out.push(`eq=${eq.join(':')}`)
  }

  // Last, so everything above is turned together — the same order CSS takes,
  // where a filter paints the element and the transform then moves the result.
  // `c=none` keeps the corners transparent; without it a turned layer arrives
  // as a black diamond that covers everything under it.
  if (layer.rotation) {
    // `rotw`/`roth` take the *angle*, not a dimension — they read iw/ih
    // themselves. Passing iw made ffmpeg size the canvas for a rotation of six
    // hundred radians, which is very nearly a square and put every turned layer
    // in the wrong place.
    const a = n4((layer.rotation * Math.PI) / 180)
    // Long option names throughout, and they are not decoration: positionally,
    // a leading minus is read as an option name, and the short alias `c` is
    // also a constant in rotate's own expression language, so `a=…:c=none`
    // parses as one expression `-0.1396=none` and the filter refuses to build.
    out.push(`rotate=angle=${a}:fillcolor=none:out_w=rotw(${a}):out_h=roth(${a})`)
  }
  return out
}

/** ffmpeg spells three blend modes without the hyphen CSS uses. */
const BLEND_OK = new Set([
  'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'softlight', 'hardlight', 'difference', 'exclusion',
])

function fitFilters(fit: LayerFit, w: number, h: number, scale = 1, moving?: string | null): string[] {
  // A size that moves only means anything to a freely placed layer; the other
  // three fits say what size the layer comes out at and leave nothing to move.
  if (moving && (fit === 'none' || !fit)) {
    // `eval=frame` is what makes the expression time-varying at all; without it
    // the scale is computed once and the move never happens.
    return [`scale=w='trunc(iw*(${moving})/2)*2':h='trunc(ih*(${moving})/2)*2':eval=frame`]
  }
  switch (fit) {
    case 'fill':
      return [`scale=${w}:${h}`]
    case 'cover':
      // Fill the frame and crop the overflow — the usual choice for footage
      // that does not match the sequence aspect.
      return [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`]
    case 'contain':
      // Pad transparent, never black: a letterboxed layer must still let the
      // layers underneath it show through.
      return [
        `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      ]
    case 'none':
    default:
      // Freely placed, so a scale has somewhere to go. Rounded to even pixels:
      // several encoders downstream refuse an odd dimension.
      if (!(scale > 0) || Math.abs(scale - 1) < 0.001) return []
      return [`scale=trunc(iw*${scale.toFixed(4)}/2)*2:trunc(ih*${scale.toFixed(4)}/2)*2`]
  }
}

export interface BuiltGraph {
  inputs: string[]
  filter: string
  hasAudio: boolean
  hasVideo: boolean
}

/**
 * Turn a plan into `-i` arguments plus one filter_complex.
 *
 * Layers are placed with `tpad`, not with a plain `setpts` shift: an overlay
 * input whose first frame arrives ten seconds in will stall ffmpeg's frame
 * synchroniser, so every layer is padded with transparent frames back to t=0
 * and then hard-gated with `enable`.
 */
/**
 * Regenerate the audio timestamps right before the encoder.
 *
 * After atrim → adelay → amix the frames' timestamps are not reliably
 * monotonic — one frame after a long delay comes out with an impossible
 * DTS — and the AAC encoder inside the MP4 muxer answers by dropping every
 * packet from there on. The file kept its audio stream, ffmpeg exited 0,
 * and the sound was five seconds of silence followed by nothing: a whole
 * lesson rendered mute with no error anywhere. PCM in a MOV did not care,
 * which is how it hid. Counting samples from zero gives the encoder what
 * it needs, whatever the filters upstream did.
 */
const CLEAN_PTS = 'asetpts=N/SR/TB'

export function buildGraph(plan: SequencePlan, resolve: (l: { source: string; file: string }) => string): BuiltGraph {
  const { width: W, height: H, fps } = plan
  const totalSec = s3(plan.durationMs)
  const inputs: string[] = []
  const chains: string[] = []

  // ffmpeg refuses a graph with an output pad nobody maps, so a sound-only
  // render must not build the picture at all, and vice versa.
  const wantVideo = plan.output !== 'audio'
  const wantAudio = plan.output !== 'video'

  const bg =
    plan.background.mode === 'color'
      ? `${plan.background.color.replace('#', '0x')}@1.0`
      : 'black@0.0'

  if (wantVideo) chains.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${totalSec},format=rgba[base]`)

  let last = 'base'
  ;(wantVideo ? plan.video : []).forEach((layer, i) => {
    const idx = inputs.length / 2
    inputs.push('-i', resolve(layer))

    const shadow = layer.shadow && (layer.shadow.blur || layer.shadow.x || layer.shadow.y) ? layer.shadow : null
    // Room for the shadow to fall outside the picture. It is added to both the
    // layer and its shadow so the two stay the same size and share one placement
    // expression, and the browser has already counted it into padX/padY.
    const sp = shadow ? Math.ceil(shadow.blur * 1.5 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y))) : 0
    const blend = layer.blend && BLEND_OK.has(layer.blend) ? layer.blend : null

    // `durationMs` is timeline time; a layer at 2× eats twice that much source
    // and then has its timestamps divided to fit back into it.
    const rate = layer.speed && layer.speed > 0 ? layer.speed : 1
    // `t` inside the layer's own chain starts at zero — `setpts=PTS-STARTPTS`
    // above put it there — which is the same zero the keyframes count from.
    const scaleKeys = keyExpr(layer.keys?.scale, 't', layer.scale ?? 1)
    const parts = [
      `trim=start=${s3(layer.inMs)}:end=${s3(layer.inMs + layer.durationMs * rate)}`,
      'setpts=PTS-STARTPTS',
      ...(rate !== 1 ? [`setpts=PTS/${n4(rate)}`] : []),
      `fps=${fps}`,
      // Before anything cuts or turns the layer, so an edge stays transparent
      // rather than becoming black.
      'format=rgba',
      ...effectFilters(layer, true),
      ...fitFilters(layer.fit, W, H, layer.scale ?? 1, scaleKeys),
      ...effectFilters(layer, false),
    ]
    // On the layer's own clock, which `setpts=PTS-STARTPTS` above started at
    // zero — and before `tpad`, which prepends frames that are not part of it.
    // `alpha=1` fades the alpha rather than to black, so a dissolve reveals the
    // layers underneath instead of punching a hole to the background.
    const dIn = Math.max(0, Math.min(layer.dissolveInMs ?? 0, layer.durationMs))
    const dOut = Math.max(0, Math.min(layer.dissolveOutMs ?? 0, layer.durationMs))
    if (dIn > 0) parts.push(`fade=t=in:st=0:d=${s3(dIn)}:alpha=1`)
    if (dOut > 0) parts.push(`fade=t=out:st=${s3(layer.durationMs - dOut)}:d=${s3(dOut)}:alpha=1`)

    if (sp) parts.push(`pad=iw+${sp * 2}:ih+${sp * 2}:${sp}:${sp}:color=black@0`)
    // A keyed opacity was already written onto the alpha plane above; applying
    // the constant too would multiply the fade by itself.
    if (layer.opacity < 1 && !layer.keys?.opacity?.length) {
      parts.push(`colorchannelmixer=aa=${Math.max(0, layer.opacity).toFixed(3)}`)
    }
    if (layer.startMs > 0) {
      parts.push(`tpad=start_duration=${s3(layer.startMs)}:start_mode=add:color=black@0`)
    }
    // A blend has no `enable` to gate it, so the layer must run transparent to
    // the very end of the sequence instead of simply stopping.
    const tail = plan.durationMs - (layer.startMs + layer.durationMs)
    if (blend && tail > 0) parts.push(`tpad=stop_duration=${s3(tail)}:stop_mode=add:color=black@0`)

    chains.push(`[${idx}:v]${parts.join(',')}[l${i}]`)

    // In the overlay expression `t` is *sequence* time, so the layer's own clock
    // is that minus where it starts.
    const own = `(t-${s3(layer.startMs)})`
    const { x, y } = placement(layer.anchor, layer.offsetX, layer.offsetY, layer.padX, layer.padY, {
      x: keyExpr(layer.keys?.offsetX, own, layer.offsetX),
      y: keyExpr(layer.keys?.offsetY, own, layer.offsetY),
      // Only worth the expression form when the size moves under it.
      padFracX: scaleKeys ? layer.padFracX ?? 0 : 0,
      padFracY: scaleKeys ? layer.padFracY ?? 0 : 0,
    })
    const from = s3(layer.startMs)
    const to = s3(layer.startMs + layer.durationMs)
    const gate = `enable='between(t,${from},${to})'`
    let src = `l${i}`

    // The shadow is the layer's own silhouette, flattened to one colour, blurred
    // and laid down first. Same size as the layer, so the same x/y places it.
    // A comma separates filters in a filtergraph, and a keyframed expression is
    // full of them — `if(lt(t,a),b,c)`. Quoting keeps the value one option.
    const qx = `'${x}'`
    const qy = `'${y}'`

    if (shadow) {
      const rgb = shadow.color.replace('#', '')
      const [sr, sg, sb] = [0, 2, 4].map((k) => parseInt(rgb.slice(k, k + 2) || '0', 16) || 0)
      chains.push(`[l${i}]split=2[lf${i}][ls${i}]`)
      chains.push(
        `[ls${i}]geq=r='${sr}':g='${sg}':b='${sb}':a='alpha(X,Y)',` +
          `gblur=sigma=${Math.max(0.1, shadow.blur / 2).toFixed(2)}:steps=2:planes=15,` +
          `colorchannelmixer=aa=${Math.max(0, shadow.opacity).toFixed(3)}[sh${i}]`,
      )
      const sx = Math.round(shadow.x), sy = Math.round(shadow.y)
      const shx = sx ? `${x}${sx >= 0 ? '+' : ''}${sx}` : x
      const shy = sy ? `${y}${sy >= 0 ? '+' : ''}${sy}` : y
      chains.push(
        `[${last}][sh${i}]overlay=x='${shx}':y='${shy}':${gate}:eof_action=pass:repeatlast=0:format=auto[cs${i}]`,
      )
      last = `cs${i}`
      src = `lf${i}`
    }

    const out = `c${i}`
    if (blend) {
      // `blend` mixes two whole frames and knows nothing about position or
      // transparency: it multiplies the transparent margin too, which comes out
      // as a black rectangle over everything. So the layer is padded to the
      // frame where it sits, blended for its *colour* only, and then given its
      // own alpha back and composited normally. Outside the picture the alpha
      // is zero, so the mix cannot reach anything it should not.
      const { x: px, y: py } = padPlacement(layer.anchor, layer.offsetX, layer.offsetY, layer.padX, layer.padY)
      chains.push(`[${src}]pad=${W}:${H}:'${px}':'${py}':color=black@0,format=rgba[p${i}]`)
      chains.push(`[p${i}]split=2[pc${i}][pa${i}]`)
      chains.push(`[pa${i}]alphaextract[pm${i}]`)
      chains.push(`[${last}]split=2[b1${i}][b2${i}]`)
      chains.push(`[b1${i}][pc${i}]blend=all_mode=${blend}:shortest=0,format=rgba[blc${i}]`)
      chains.push(`[blc${i}][pm${i}]alphamerge[bla${i}]`)
      chains.push(
        `[b2${i}][bla${i}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${out}]`,
      )
    } else {
      chains.push(
        `[${last}][${src}]overlay=x=${qx}:y=${qy}:${gate}:` +
          `eof_action=pass:repeatlast=0:format=auto[${out}]`,
      )
    }
    last = out
  })

  if (wantVideo) chains.push(`[${last}]setsar=1,format=rgba[vout]`)

  /* ----------------------------------------------------------------- audio */

  const alabels: string[] = []
  ;(wantAudio ? plan.audio : []).forEach((a, i) => {
    const idx = inputs.length / 2
    inputs.push('-i', resolve(a))

    const arate = a.speed && a.speed > 0 ? a.speed : 1
    const parts = [
      `atrim=start=${s3(a.inMs)}:end=${s3(a.inMs + a.durationMs * arate)}`,
      'asetpts=PTS-STARTPTS',
      // `atempo` keeps the pitch where it was, which is what anyone speeding up
      // a talking head wants. It only accepts 0.5–100, so anything slower is
      // reached by chaining halves.
      ...atempoChain(arate),
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    ]
    if (a.volume !== 1) parts.push(`volume=${Math.max(0, a.volume).toFixed(3)}`)
    if (a.fadeInMs > 0) parts.push(`afade=t=in:st=0:d=${s3(a.fadeInMs)}`)
    if (a.fadeOutMs > 0) {
      parts.push(`afade=t=out:st=${s3(Math.max(0, a.durationMs - a.fadeOutMs))}:d=${s3(a.fadeOutMs)}`)
    }
    if (a.startMs > 0) parts.push(`adelay=${Math.round(a.startMs)}:all=1`)

    chains.push(`[${idx}:a]${parts.join(',')}[a${i}]`)
    alabels.push(`[a${i}]`)
  })

  // A voice-over that stops before the picture does must not truncate the file,
  // so the mix is padded with silence to the sequence length.
  //
  // `whole_dur` and not a bare `apad`: unbounded apad generates silence for
  // ever, and a following `atrim` discards those frames without ever asking it
  // to stop — ffmpeg then spins, out_time frozen, writing an output that grows
  // without end. This form terminates on its own.
  if (alabels.length === 1) {
    chains.push(`${alabels[0]}apad=whole_dur=${totalSec},${CLEAN_PTS}[aout]`)
  } else if (alabels.length > 1) {
    chains.push(
      `${alabels.join('')}amix=inputs=${alabels.length}:duration=longest:normalize=0,` +
        `apad=whole_dur=${totalSec},${CLEAN_PTS}[aout]`,
    )
  }

  return { inputs, filter: chains.join(';'), hasAudio: alabels.length > 0, hasVideo: wantVideo }
}

/**
 * The part of a plan between two sequence times, re-based to start at zero.
 *
 * Cutting the plan rather than the output is what keeps a range render fast
 * and honest: an output-side `-ss` decodes and discards everything before the
 * range and reports no progress while it does. Here every layer is
 * intersected with the window, its in-point advanced by what was cut off its
 * head, and a fade dropped on any side that was cut. Everything downstream —
 * the base canvas length, the audio padding, `-t`, the progress ratio —
 * then works unchanged.
 */
export function cutPlan(plan: SequencePlan, fromMs: number, toMs: number): SequencePlan {
  const from = Math.max(0, Math.round(fromMs))
  const to = Math.min(plan.durationMs, Math.round(toMs))
  if (to - from < 40) throw new Error('the range is empty')

  const clip = <T extends { startMs: number; durationMs: number; inMs: number }>(layer: T): T | null => {
    const a = Math.max(layer.startMs, from)
    const b = Math.min(layer.startMs + layer.durationMs, to)
    if (b - a < 1) return null
    return { ...layer, startMs: a - from, inMs: layer.inMs + (a - layer.startMs), durationMs: b - a }
  }

  return {
    ...plan,
    durationMs: to - from,
    video: plan.video.map(clip).filter((l): l is VideoLayer => !!l),
    audio: plan.audio
      .map((a) => {
        const cut = clip(a)
        if (!cut) return null
        // A fade belongs to the edge it was on; a cut edge has none.
        if (cut.inMs !== a.inMs) cut.fadeInMs = 0
        if (a.startMs + a.durationMs > to) cut.fadeOutMs = 0
        return cut
      })
      .filter((l): l is AudioLayer => !!l),
  }
}

/** Resolve a layer's file to a real path, refusing anything outside our dirs. */
export function resolveLayerPath(layer: { source: string; file: string }): string {
  if (layer.source === 'media') {
    const safe = safeMediaName(layer.file)
    if (!safe) throw new Error(`unusable media file "${layer.file}"`)
    return join(MEDIA_DIR, safe)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(layer.file) || layer.file.includes('..')) {
    throw new Error(`unusable render file "${layer.file}"`)
  }
  return join(EXPORT_DIR, layer.file)
}

/* ----------------------------------------------------------------- the job */

export type SequenceState = 'rendering' | 'complete' | 'failed' | 'aborted'

export class SequenceJob {
  readonly id: string
  readonly plan: SequencePlan
  readonly spec: SequenceFormatSpec
  readonly outPath: string
  readonly startedAt = Date.now()
  readonly args: string[]

  state: SequenceState = 'rendering'
  /** Output position in ms, straight from ffmpeg's own progress stream. */
  outTimeMs = 0
  error: string | null = null
  outSize = 0

  private proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  private stderrTail: string[] = []
  readonly done: Promise<void>

  constructor(id: string, plan: SequencePlan, outPath: string) {
    const spec = SEQUENCE_FORMATS[plan.format]
    if (!spec) throw new Error(`unknown format "${plan.format}"`)

    this.id = id
    this.plan = plan
    this.spec = spec
    this.outPath = outPath

    const graph = buildGraph(plan, resolveLayerPath)

    if (!graph.hasVideo && !graph.hasAudio) throw new Error('nothing to render in that range')
    if (graph.hasVideo && !spec.video) throw new Error(`${spec.label} holds sound only; render it with output "audio"`)

    this.args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...graph.inputs,
      '-filter_complex', graph.filter,
      ...(graph.hasVideo ? ['-map', '[vout]'] : ['-vn']),
      ...(graph.hasAudio ? ['-map', '[aout]', ...spec.audio()] : ['-an']),
      ...(graph.hasVideo && spec.video ? [...spec.video(plan.quality), '-r', String(plan.fps)] : []),
      '-t', s3(plan.durationMs),
      '-progress', 'pipe:1', '-nostats',
      outPath,
    ]

    this.proc = Bun.spawn(['ffmpeg', ...this.args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>

    this.done = this.watch()
  }

  private async watch(): Promise<void> {
    const readProgress = (async () => {
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of this.proc.stdout) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const [key, value] = line.split('=')
          if (key === 'out_time_us' || key === 'out_time_ms') {
            // Both keys are microseconds in practice; ffmpeg's naming is a
            // long-standing bug, and reading it as ms shows 1000x progress.
            const us = Number(value)
            if (Number.isFinite(us) && us >= 0) this.outTimeMs = us / 1000
          }
        }
      }
    })()

    const readErr = (async () => {
      const text = await new Response(this.proc.stderr).text()
      this.stderrTail = text.trim().split('\n').filter(Boolean).slice(-12)
    })()

    const code = await this.proc.exited
    await Promise.all([readProgress.catch(() => {}), readErr.catch(() => {})])

    if (this.state === 'aborted') return

    if (code !== 0) {
      this.state = 'failed'
      this.error = this.stderrTail.join('\n') || `ffmpeg exited with code ${code}`
      return
    }

    const file = Bun.file(this.outPath)
    this.outSize = (await file.exists()) ? file.size : 0
    if (this.outSize === 0) {
      this.state = 'failed'
      this.error = this.stderrTail.join('\n') || 'ffmpeg produced an empty file'
      return
    }
    this.outTimeMs = this.plan.durationMs
    this.state = 'complete'
  }

  get progress(): number {
    if (this.state === 'complete') return 1
    if (this.plan.durationMs <= 0) return 0
    return Math.max(0, Math.min(1, this.outTimeMs / this.plan.durationMs))
  }

  abort(): void {
    if (this.state !== 'rendering') return
    this.state = 'aborted'
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
    // A half-written file has no index: some players open it, show no
    // duration and cannot seek. Better that it is not there at all.
    void unlink(this.outPath).catch(() => {})
  }
}

export async function ensureExportDir(): Promise<string> {
  await mkdir(EXPORT_DIR, { recursive: true })
  return EXPORT_DIR
}
