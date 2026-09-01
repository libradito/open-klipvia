/**
 * What can be done to a layer, and the two languages it has to be said in.
 *
 * A layer can be turned, mirrored, cropped, tinted and blended. Each of those
 * has to happen twice — once in CSS so the preview shows it, once as an ffmpeg
 * filter so the file does — and the two must agree to the pixel or the editor
 * is lying. So every effect is defined *here*, once, as numbers; this module
 * turns those numbers into geometry, and into the CSS half. The ffmpeg half
 * reads the same numbers off the render plan in `src/sequence.ts`.
 *
 * The order is fixed and both halves obey it:
 *
 *     crop → flip → fit/scale → rotate → colour → place
 *
 * Crop is in the source's own pixels, so it happens before anything moves;
 * rotation is of the finished, sized layer, which is what turning something on
 * screen means; colour is last so a tint is not resampled.
 *
 * One shortcut is worth knowing. An **overlay** — a title, a shape, an image, a
 * caption, an animation clip — is a document the browser renders, in the
 * preview and again offscreen for the file. Anything CSS can do to it is
 * therefore free *and* exactly identical in both, so overlays take their turn,
 * mirror, colour and rounding through `decorCss` baked into the clip document
 * rather than through ffmpeg. Only footage and nested blocks, which never touch
 * a browser, need the filtergraph.
 */

const rad = (deg) => (deg * Math.PI) / 180
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
export const evenPx = (n, lo = 2, hi = 16384) => clamp(2 * Math.round(n / 2), lo, hi)

/* ------------------------------------------------------------------ fields */

/** Degrees clockwise, normalised to (-180, 180]. */
export function rotationOf(item) {
  const d = Number(item?.rotation)
  if (!Number.isFinite(d) || d === 0) return 0
  let r = d % 360
  if (r > 180) r -= 360
  if (r <= -180) r += 360
  return Math.round(r * 100) / 100
}

export const flipsOf = (item) => ({ h: !!item?.flipH, v: !!item?.flipV })

/**
 * How much of each edge is cut away, as a fraction of the source.
 *
 * Fractions rather than pixels: a crop set on a 4K master still means the same
 * framing after the shot is replaced with a 1080p proxy.
 */
export function cropOf(item) {
  const c = item?.crop
  if (!c) return null
  const g = (k) => clamp(Number(c[k]) || 0, 0, 0.95)
  const top = g('top'), right = g('right'), bottom = g('bottom'), left = g('left')
  if (!(top || right || bottom || left)) return null
  // Never let two opposite edges eat the whole picture.
  const kx = 1 - left - right, ky = 1 - top - bottom
  if (kx < 0.02 || ky < 0.02) return null
  return { top, right, bottom, left, kx, ky }
}

/* ---------------------------------------------------------------- geometry */

/** The axis-aligned box a `w × h` rectangle needs once it is turned `deg`. */
export function rotatedBox(w, h, deg) {
  if (!deg) return { w, h }
  const c = Math.abs(Math.cos(rad(deg))), s = Math.abs(Math.sin(rad(deg)))
  return { w: w * c + h * s, h: w * s + h * c }
}

/**
 * Rotation grows a layer's bounding box, and the growth is transparent margin
 * the anchor arithmetic must not count. This is how much was added per side —
 * the render plan carries it so `left` still means the left of the *picture*.
 */
export function rotationPad(w, h, deg) {
  const b = rotatedBox(w, h, deg)
  return { x: Math.round((b.w - w) / 2), y: Math.round((b.h - h) / 2), w: b.w, h: b.h }
}

/**
 * Where a footage element has to sit, and how it must be clipped, so that the
 * part of it the crop keeps lands exactly on `box`.
 *
 * The element is grown by the inverse of the crop and pulled back by the amount
 * cut off its top-left; `clip-path` then hides the rest. It is the same
 * arithmetic as `crop=…` followed by `scale=…`, written for a browser.
 */
export function croppedElement(box, crop) {
  if (!crop) {
    return { left: box.x, top: box.y, width: box.w, height: box.h, clip: '', originX: box.w / 2, originY: box.h / 2 }
  }
  const ew = box.w / crop.kx, eh = box.h / crop.ky
  const pct = (n) => `${(n * 100).toFixed(4)}%`
  return {
    left: box.x - crop.left * ew,
    top: box.y - crop.top * eh,
    width: ew,
    height: eh,
    clip: `inset(${pct(crop.top)} ${pct(crop.right)} ${pct(crop.bottom)} ${pct(crop.left)})`,
    // Turning it must turn it about the middle of what you can *see*.
    originX: crop.left * ew + box.w / 2,
    originY: crop.top * eh + box.h / 2,
  }
}

/* -------------------------------------------------------- the CSS half */

/**
 * The transform that mirrors and turns a layer, in the fixed order.
 *
 * CSS applies the rightmost function first, so `rotate(r) scale(fx,fy)` is
 * "mirror the source, then turn it" — which is the order ffmpeg's
 * `hflip,vflip,rotate` takes, and the order the crop above assumes.
 */
export function turnCss(item) {
  const r = rotationOf(item)
  const { h, v } = flipsOf(item)
  const parts = []
  if (r) parts.push(`rotate(${r}deg)`)
  if (h || v) parts.push(`scale(${h ? -1 : 1}, ${v ? -1 : 1})`)
  return parts.join(' ')
}

/**
 * How a clip document is laid out at its own size and painted at another.
 *
 * Zoom, turn and mirror all collapse into one transform about the document's
 * middle, and the frame it is painted into grows to hold the result. Written
 * once here because three places have to produce the identical string: the
 * stage document, the rasterizer's snapshot of it, and nothing else may differ
 * or the preview and the file drift apart.
 */
export function decorCss({ baseWidth, baseHeight, zoom = 1, rotation = 0, flipH = false, flipV = false, pad = 0 }) {
  const k = zoom > 0 ? zoom : 1
  const scaled = { w: baseWidth * k, h: baseHeight * k }
  const box = rotatedBox(scaled.w, scaled.h, rotation)
  const outW = evenPx(box.w + pad * 2, 4, 16384)
  const outH = evenPx(box.h + pad * 2, 4, 16384)
  const fx = flipH ? -1 : 1, fy = flipV ? -1 : 1
  // Put the document's middle on the output's middle, then turn and mirror it
  // there. transform-origin stays at 0 0 so the maths is one chain, not two.
  const transform =
    `translate(${outW / 2}px, ${outH / 2}px)` +
    (rotation ? ` rotate(${rotation}deg)` : '') +
    ` scale(${(k * fx).toFixed(6)}, ${(k * fy).toFixed(6)})` +
    ` translate(${-baseWidth / 2}px, ${-baseHeight / 2}px)`
  return { outW, outH, transform, plain: !rotation && !flipH && !flipV && Math.abs(k - 1) < 0.001 && !pad }
}

/* ------------------------------------------------------------------ colour */

export const COLOUR_NEUTRAL = { brightness: 1, contrast: 1, saturation: 1, temperature: 0 }

export function colourOf(item) {
  const c = item?.colour
  if (!c) return null
  const out = {
    brightness: clamp(Number(c.brightness ?? 1) || 1, 0.1, 3),
    contrast: clamp(Number(c.contrast ?? 1) || 1, 0, 3),
    saturation: clamp(Number(c.saturation ?? 1) ?? 1, 0, 3),
    temperature: clamp(Number(c.temperature) || 0, -1, 1),
  }
  if (typeof c.saturation === 'number') out.saturation = clamp(c.saturation, 0, 3)
  const same = (a, b) => Math.abs(a - b) < 0.001
  if (same(out.brightness, 1) && same(out.contrast, 1) && same(out.saturation, 1) && same(out.temperature, 0)) return null
  return out
}

/**
 * Temperature as a per-channel gain: warm lifts red and drops blue, cool the
 * reverse. Folded together with brightness so both halves can spend a single
 * multiply — `colorchannelmixer` in ffmpeg, one `feColorMatrix` in CSS.
 */
export function channelGain(colour) {
  const t = colour.temperature
  const b = colour.brightness
  return { r: b * (1 + 0.28 * t), g: b * (1 + 0.02 * t), b: b * (1 - 0.28 * t) }
}

/**
 * The CSS that reproduces a colour setting.
 *
 * `contrast()` and `saturate()` are defined identically to ffmpeg's `eq`, so
 * those two go straight through. The channel gain has no CSS shorthand, so it
 * rides on an SVG colour matrix the caller installs under `id`.
 */
export function colourCss(colour, id) {
  if (!colour) return ''
  const parts = []
  if (id) parts.push(`url(#${id})`)
  if (Math.abs(colour.contrast - 1) > 0.001) parts.push(`contrast(${colour.contrast.toFixed(4)})`)
  if (Math.abs(colour.saturation - 1) > 0.001) parts.push(`saturate(${colour.saturation.toFixed(4)})`)
  return parts.join(' ')
}

/** The 4×5 matrix for `feColorMatrix` — a diagonal channel gain, alpha kept. */
export function colourMatrixValues(colour) {
  const g = channelGain(colour)
  return [g.r, 0, 0, 0, 0, 0, g.g, 0, 0, 0, 0, 0, g.b, 0, 0, 0, 0, 0, 1, 0].map((n) => +n.toFixed(5)).join(' ')
}

/* ------------------------------------------------------------------- blend */

/**
 * Modes a layer can be mixed with what is under it. Every one of these exists
 * under the same name in CSS `mix-blend-mode` and in ffmpeg's `blend`, which
 * is exactly why the list stops here.
 */
export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'softlight', 'hardlight', 'difference', 'exclusion',
]
/** CSS spells two of them with a hyphen; ffmpeg does not. */
const CSS_BLEND = { softlight: 'soft-light', hardlight: 'hard-light' }
export const blendOf = (item) => (BLEND_MODES.includes(item?.blend) && item.blend !== 'normal' ? item.blend : null)
export const blendCss = (mode) => (mode ? CSS_BLEND[mode] ?? mode : '')

/* ------------------------------------------------------ rounding and shadow */

export const radiusOf = (item) => Math.max(0, Math.round(Number(item?.radius) || 0))

export function shadowOf(item) {
  const s = item?.shadow
  if (!s || !(Number(s.blur) || Number(s.x) || Number(s.y))) return null
  return {
    blur: clamp(Number(s.blur) || 0, 0, 400),
    x: clamp(Number(s.x) || 0, -400, 400),
    y: clamp(Number(s.y) || 0, -400, 400),
    color: typeof s.color === 'string' ? s.color : '#000000',
    opacity: clamp(Number(s.opacity ?? 0.45), 0, 1),
  }
}

/** Room a shadow needs outside the layer, so the frame it is drawn into fits it. */
export const shadowPad = (s) => (s ? Math.ceil(s.blur * 1.5 + Math.max(Math.abs(s.x), Math.abs(s.y))) : 0)

export function shadowCss(s) {
  if (!s) return ''
  const a = Math.round(s.opacity * 255).toString(16).padStart(2, '0')
  return `drop-shadow(${Math.round(s.x)}px ${Math.round(s.y)}px ${Math.round(s.blur)}px ${s.color}${a})`
}

/* -------------------------------------------------- what a clip is painted through */

/**
 * The colour matrix a tinted clip is painted through.
 *
 * CSS has `contrast()` and `saturate()` but no per-channel gain, which is what
 * brightness and temperature come to, so that half rides on an SVG filter. It
 * is written into the clip's own document because `url(#…)` only resolves
 * there — and into the rasterizer's snapshot, for the same reason.
 */
export function colourFilterSvg(colour, id = 'cc') {
  if (!colour) return ''
  return (
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="${id}" ` +
    `color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">` +
    `<feColorMatrix type="matrix" values="${colourMatrixValues(colour)}"/></filter></svg>`
  )
}

/** Everything a decorated clip does to its own body, as one style string. */
export function decorStyle(decor, { transform } = {}) {
  if (!decor) return ''
  const filter = [colourCss(decor.colour, decor.colour ? 'cc' : ''), shadowCss(decor.shadow)].filter(Boolean).join(' ')
  return (
    `transform:${transform ?? decor.transform};transform-origin:0 0;` +
    (filter ? `filter:${filter};` : '') +
    (decor.radius ? `border-radius:${decor.radius}px;` : '')
  )
}

/* ------------------------------------------------------- dissolves in time */

/**
 * A picture fade at the head or tail of an item, as a factor on its opacity.
 *
 * Two of these on neighbouring layers *are* a cross dissolve: the outgoing one
 * fades out while the incoming one, sitting above it, fades in. That is why
 * there is no separate transition object anywhere in the document — a
 * transition is a property of the two items it is between, which is the only
 * shape that survives moving, trimming or deleting either of them.
 */
export function dissolveAt(item, t) {
  const inMs = Math.max(0, Number(item?.dissolveInMs) || 0)
  const outMs = Math.max(0, Number(item?.dissolveOutMs) || 0)
  if (!inMs && !outMs) return 1
  const local = t - item.startMs
  const dur = item.durationMs
  let f = 1
  if (inMs && local < inMs) f = Math.min(f, Math.max(0, local / inMs))
  if (outMs && local > dur - outMs) f = Math.min(f, Math.max(0, (dur - local) / outMs))
  return f
}

