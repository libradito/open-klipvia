/**
 * DOM -> canvas rasterizer.
 *
 * The preview is drawn by wrapping a snapshot of the live DOM in an SVG
 * <foreignObject> and decoding that as an image. The browser's own layout and
 * paint engine does the work, so CSS filters, gradients, blend modes, masks and
 * text rendering all come out right — unlike a reimplementation such as
 * html2canvas.
 *
 * Two constraints follow from an SVG-in-<img> being a sealed document:
 *
 *   1. It cannot reach the network, so every font and image is inlined as a
 *      data URI first (cross-origin ones via the server's /api/asset proxy).
 *   2. Its stylesheets would restart their own animations from zero. So the
 *      original stylesheets are dropped entirely and each element instead
 *      carries the *computed* style read from the live DOM at the seeked
 *      instant, which is already the interpolated value.
 */

import { colourMatrixValues, decorStyle } from '/effects.js'

const XHTML = 'http://www.w3.org/1999/xhtml'

/** Properties that CSS inherits — skipped when identical to the parent's value. */
const INHERITED = new Set([
  'azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'caret-color', 'color',
  'cursor', 'direction', 'empty-cells', 'font-family', 'font-feature-settings', 'font-kerning',
  'font-language-override', 'font-optical-sizing', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-synthesis', 'font-variant', 'font-variant-alternates', 'font-variant-caps',
  'font-variant-east-asian', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-variation-settings', 'font-weight', 'hyphens', 'image-orientation', 'image-rendering',
  'letter-spacing', 'line-height', 'list-style', 'list-style-image', 'list-style-position',
  'list-style-type', 'math-depth', 'math-style', 'orphans', 'overflow-wrap', 'paint-order',
  'pointer-events', 'quotes', 'ruby-align', 'ruby-position', 'tab-size', 'text-align',
  'text-align-last', 'text-anchor', 'text-combine-upright', 'text-decoration-color',
  'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style', 'text-indent',
  'text-justify', 'text-orientation', 'text-rendering', 'text-shadow', 'text-size-adjust',
  'text-transform', 'text-underline-offset', 'text-underline-position', 'text-wrap', 'visibility',
  'white-space', 'white-space-collapse', 'widows', 'word-break', 'word-spacing', 'writing-mode',
  '-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-color',
  '-webkit-text-stroke-width', '-webkit-text-emphasis-color',
])

/** Vendor-prefixed properties worth keeping; the rest are dropped as noise. */
const KEEP_PREFIXED = new Set([
  '-webkit-background-clip', '-webkit-box-decoration-break', '-webkit-box-orient',
  '-webkit-font-smoothing', '-webkit-line-clamp', '-webkit-mask-image', '-webkit-mask-position',
  '-webkit-mask-repeat', '-webkit-mask-size', '-webkit-text-emphasis-color',
  '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
])

/**
 * Never copied. The animation/transition longhands would re-arm inside the
 * snapshot; the rest are interaction-only and just bloat the SVG.
 */
/** Properties whose url() references are inlined as data URIs per element. */
const URL_PROPS = new Set(['background-image', '-webkit-mask-image', 'mask-image', 'border-image-source'])

const DROP = new Set([
  'animation', 'animation-composition', 'animation-delay', 'animation-direction',
  'animation-duration', 'animation-fill-mode', 'animation-iteration-count', 'animation-name',
  'animation-play-state', 'animation-range', 'animation-range-end', 'animation-range-start',
  'animation-timeline', 'animation-timing-function',
  'transition', 'transition-behavior', 'transition-delay', 'transition-duration',
  'transition-property', 'transition-timing-function',
  'will-change', 'view-transition-name', 'scroll-behavior', 'touch-action', 'user-select',
  '-webkit-user-select', 'overscroll-behavior', 'overscroll-behavior-x', 'overscroll-behavior-y',
  'contain-intrinsic-size', 'contain-intrinsic-block-size', 'contain-intrinsic-inline-size',
  'contain-intrinsic-height', 'contain-intrinsic-width', 'content-visibility',
])

/** Widths that must never be pinned tighter than the text they hold. */
const WIDTHISH = new Set(['width', 'inline-size', 'max-width', 'min-width'])

const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'title', 'noscript', 'template'])

/* -------------------------------------------------------------- asset cache */

const assetCache = new Map() // absolute url -> data URI (or null when it failed)

async function proxyFetch(url) {
  const res = await fetch(`/api/asset?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(`asset proxy ${res.status}`)
  return res.json()
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error ?? new Error('could not read blob'))
    fr.readAsDataURL(blob)
  })
}

function isSameOrigin(url) {
  try {
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

async function toDataUri(url) {
  if (!url || url.startsWith('data:')) return url
  if (assetCache.has(url)) return assetCache.get(url)

  let out = null
  try {
    if (isSameOrigin(url)) {
      // Fetch local files (the asset library) directly. Routing them through
      // /api/asset would fail: that proxy refuses localhost as an SSRF guard,
      // so uploaded images would render in the preview and then silently
      // disappear from every export.
      const res = await fetch(url)
      if (res.ok) out = await blobToDataUri(await res.blob())
    } else {
      const payload = await proxyFetch(url)
      out = payload.kind === 'data' ? payload.dataUri : null
    }
  } catch {
    out = null
  }
  assetCache.set(url, out)
  return out
}

/**
 * The same image, no larger than it is shown.
 *
 * Every frame's SVG carries every image it shows as a data URI, and Chrome
 * decodes each one afresh per frame. A recap card showing three 1920x1080
 * screenshots at 490px wide embedded 1.5 MB of PNG in every one of two
 * hundred frames — and decoded 24 MB of bitmaps per frame — until the tab
 * was killed. Scaled to a little over its box, the same card carries ~90 KB.
 * Opaque images go out as JPEG; anything with transparency stays PNG.
 */
const sizedCache = new Map() // `${url}@${w}x${h}` -> data URI (or null)

async function toDataUriSized(url, boxW, boxH) {
  const full = await toDataUri(url)
  if (!full || !(boxW > 0) || !(boxH > 0)) return full
  const w = Math.ceil(boxW * 1.25)
  const h = Math.ceil(boxH * 1.25)
  const key = `${url}@${w}x${h}`
  if (sizedCache.has(key)) return sizedCache.get(key) ?? full
  let out = null
  try {
    // Not <img> + decode(): in a background tab — where an agent's render
    // runs — decode() of a PNG can simply never settle, and the whole export
    // waited on it. createImageBitmap decodes regardless of visibility.
    const blob = await (await fetch(full)).blob()
    const bmp = await Promise.race([
      createImageBitmap(blob),
      new Promise((_, rej) => setTimeout(() => rej(new Error('decode timeout')), 8000)),
    ])
    try {
      // Small already: not worth re-encoding.
      if (bmp.width <= w * 1.2 && bmp.height <= h * 1.2) {
        sizedCache.set(key, null)
        return full
      }
      const scale = Math.min(1, w / bmp.width, h / bmp.height)
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(bmp.width * scale))
      c.height = Math.max(1, Math.round(bmp.height * scale))
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(bmp, 0, 0, c.width, c.height)
      const px = g.getImageData(0, 0, c.width, c.height).data
      let opaque = true
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] < 250) {
          opaque = false
          break
        }
      }
      out = opaque ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png')
    } finally {
      bmp.close()
    }
  } catch {
    out = null
  }
  sizedCache.set(key, out)
  return out ?? full
}

/** Rewrite every url(...) inside a CSS value to a data URI. */
async function inlineUrls(value, base) {
  if (!value || value === 'none' || !value.includes('url(')) return value
  const refs = [...value.matchAll(/url\((['"]?)([^'")]+)\1\)/g)]
  let out = value
  for (const m of refs) {
    const raw = m[2].trim()
    if (raw.startsWith('data:')) continue
    let abs
    try {
      abs = new URL(raw, base).href
    } catch {
      continue
    }
    const uri = await toDataUri(abs)
    if (uri) out = out.replace(m[0], `url("${uri}")`)
  }
  return out
}

/* ------------------------------------------------------------------- fonts */

/**
 * Gather every @font-face in the document and rewrite it against inlined font
 * files. Cross-origin sheets (Google Fonts) throw on `.cssRules`, so those are
 * re-fetched as text through the proxy and parsed with a regex.
 */
async function buildFontCss(doc, cache) {
  if (cache.css !== null) return cache.css

  const blocks = []

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules = null
    try {
      rules = sheet.cssRules
    } catch {
      rules = null // cross-origin
    }

    if (rules) {
      for (const rule of Array.from(rules)) {
        if (rule.constructor.name === 'CSSFontFaceRule' || rule.type === 5) {
          blocks.push({ text: rule.cssText, base: sheet.href || doc.baseURI })
        }
      }
    } else if (sheet.href) {
      try {
        const text = isSameOrigin(sheet.href)
          ? await fetch(sheet.href).then((r) => (r.ok ? r.text() : ''))
          : await proxyFetch(sheet.href).then((p) => (p.kind === 'text' ? p.text : ''))
        for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/g)) {
          blocks.push({ text: m[0], base: sheet.href })
        }
      } catch {
        /* unreachable sheet — fall back to whatever font is installed locally */
      }
    }
  }

  const out = []
  for (const b of blocks) {
    out.push(await inlineUrls(b.text, b.base))
  }
  cache.css = out.join('\n')
  return cache.css
}

/** Drop every downloaded font/image. Only needed if a remote asset changed. */
export function clearAssetCache() {
  sizedCache.clear()
  assetCache.clear()
}

/* -------------------------------------------------- computed-style baseline */

let baselineFrame = null
const baselineCache = new Map() // tagName -> { prop: value }

function baselineDoc() {
  if (!baselineFrame) {
    baselineFrame = document.createElement('iframe')
    baselineFrame.setAttribute('aria-hidden', 'true')
    baselineFrame.style.cssText =
      'position:absolute;width:0;height:0;border:0;visibility:hidden;left:-9999px'
    baselineFrame.srcdoc = '<!doctype html><html><head></head><body></body></html>'
    document.body.appendChild(baselineFrame)
  }
  return baselineFrame.contentDocument
}

/** Computed style of a bare element of this tag, in a document with no CSS. */
function baselineFor(tag) {
  if (baselineCache.has(tag)) return baselineCache.get(tag)
  const map = Object.create(null)
  try {
    const d = baselineDoc()
    const el = d.createElement(tag)
    d.body.appendChild(el)
    const cs = d.defaultView.getComputedStyle(el)
    for (let i = 0; i < cs.length; i++) map[cs[i]] = cs.getPropertyValue(cs[i])
    el.remove()
  } catch {
    /* leave empty: everything gets emitted, which is correct, just larger */
  }
  baselineCache.set(tag, map)
  return map
}

/* ------------------------------------------------------------- style dumper */

function cssTextFor(cs, parentCs, baseline, holdsText, skipUrlProps = false) {
  let out = ''

  // A single-line text box was sized shrink-to-fit around its own text. Its
  // width is therefore exact to the pixel, and copying it verbatim leaves no
  // room: the smallest difference in how the snapshot measures that text makes
  // the line wrap, which never happened in the preview. Such boxes get a
  // min-width floor instead, so they hold their place but can still grow.
  // A box whose text already spans several lines was constrained by the
  // author, so its width is kept exact.
  let floorWidth = false
  if (holdsText) {
    const h = parseFloat(cs.getPropertyValue('height'))
    const lh = parseFloat(cs.getPropertyValue('line-height'))
    floorWidth = Number.isFinite(h) && Number.isFinite(lh) && h <= lh * 1.35
  }
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i]
    if (DROP.has(prop)) continue
    if (prop.startsWith('--')) continue
    if (prop.charCodeAt(0) === 45 /* '-' */ && !KEEP_PREFIXED.has(prop)) continue

    let value = cs.getPropertyValue(prop)
    if (!value) continue
    if (parentCs && INHERITED.has(prop) && parentCs.getPropertyValue(prop) === value) continue
    if (!INHERITED.has(prop) && baseline[prop] === value) continue
    // The caller inlines these as data URIs right after; emitting the raw
    // url() here too would put a sprite sheet into every frame twice.
    if (skipUrlProps && URL_PROPS.has(prop) && value.includes('url(')) continue

    // A shrink-to-fit text box resolves to a fractional width that fits its
    // text exactly. Copying that verbatim leaves zero slack, so the smallest
    // sub-pixel difference in how the snapshot measures text makes the line
    // wrap — a wrap that never happened in the preview. Round such widths up.
    if (WIDTHISH.has(prop)) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(value)
      if (px) {
        const n = Math.ceil(parseFloat(px[1]) * 2) / 2
        if (floorWidth && (prop === 'width' || prop === 'inline-size')) {
          out += `min-${prop}:${n}px;`
          continue
        }
        value = `${n}px`
      }
    }

    out += `${prop}:${value};`
  }
  return out
}

/** Full dump, used for pseudo-elements where there is no useful baseline. */
function pseudoCssText(cs) {
  let out = ''
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i]
    if (DROP.has(prop)) continue
    if (prop.startsWith('--')) continue
    if (prop.charCodeAt(0) === 45 && !KEEP_PREFIXED.has(prop)) continue
    const value = cs.getPropertyValue(prop)
    if (value) out += `${prop}:${value};`
  }
  return out
}

/* --------------------------------------------------------------- tree build */

let peSeq = 0

async function buildNode(src, outDoc, parentCs, ctx) {
  if (src.nodeType === Node.TEXT_NODE) {
    return src.nodeValue ? outDoc.createTextNode(src.nodeValue) : null
  }
  if (src.nodeType !== Node.ELEMENT_NODE) return null

  const tag = src.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return null
  // The timeline's hover outline is editor chrome, not clip content.
  if (src.hasAttribute?.('data-stage-highlight')) return null

  const view = src.ownerDocument.defaultView
  const cs = view.getComputedStyle(src)
  if (cs.getPropertyValue('display') === 'none') return null

  // A <canvas> cannot be serialized; bake its current pixels into an <img>.
  if (tag === 'canvas') {
    const img = outDoc.createElementNS(XHTML, 'img')
    try {
      img.setAttribute('src', src.toDataURL('image/png'))
    } catch {
      return null // tainted canvas
    }
    img.setAttribute('style', cssTextFor(cs, parentCs, baselineFor('img')))
    return img
  }

  const el = outDoc.importNode(src, false)

  // A direct, non-whitespace text child means this box was sized around text.
  const holdsText = [...src.childNodes].some(
    (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue && n.nodeValue.trim(),
  )

  // Do NOT normalise box-sizing here. Chrome resolves width/height to the
  // *border* box for `box-sizing: border-box` elements and to the content box
  // otherwise, so the copied value is only meaningful alongside the element's
  // own box-sizing — which cssTextFor already carries. Forcing content-box
  // re-added padding and borders on top of a border-box measurement and
  // inflated every padded element (a 1px-bordered card with 22px padding grew
  // by 46px, swallowing the grid gaps around it).
  let style = cssTextFor(cs, parentCs, baselineFor(tag), holdsText, true)

  for (const prop of URL_PROPS) {
    const v = cs.getPropertyValue(prop)
    if (v && v !== 'none' && v.includes('url(')) {
      const inlined = await inlineUrls(v, src.ownerDocument.baseURI)
      style += `${prop}:${inlined};`
    }
  }

  // Pseudo-elements need real rules; they cannot live in an inline style.
  for (const pe of ['::before', '::after']) {
    const pcs = view.getComputedStyle(src, pe)
    const content = pcs.getPropertyValue('content')
    if (!content || content === 'none' || content === 'normal') continue
    const cls = `__pe${peSeq++}`
    el.setAttribute('class', `${el.getAttribute('class') || ''} ${cls}`.trim())
    let body = pseudoCssText(pcs)
    if (content.includes('url(')) {
      body += `content:${await inlineUrls(content, src.ownerDocument.baseURI)};`
    }
    ctx.pseudoRules.push(`.${cls}${pe}{${body}}`)
  }

  el.setAttribute('style', style)

  if (tag === 'img') {
    const abs = new URL(src.getAttribute('src') || '', src.ownerDocument.baseURI).href
    const box = src.getBoundingClientRect()
    const uri = await toDataUriSized(abs, box.width, box.height)
    if (uri) el.setAttribute('src', uri)
    el.removeAttribute('srcset')
    el.removeAttribute('loading')
  }

  for (const child of Array.from(src.childNodes)) {
    const c = await buildNode(child, outDoc, cs, ctx)
    if (c) el.appendChild(c)
  }
  return el
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* ---------------------------------------------------------------- public API */

/**
 * `decor` mirrors what buildStageDoc does to a decorated clip: the document is
 * laid out at `baseWidth × baseHeight` and *painted* into `width × height`
 * through one transform — scaled, turned, mirrored — with a colour matrix and a
 * shadow over it. The snapshot has to reproduce both halves, or a clip at 60%
 * would be laid out in a box 60% as wide and reflow instead of shrinking.
 */
export function createRasterizer(iframe, { width, height, decor = null, baseWidth = 0, baseHeight = 0 }) {
  const d = decor && baseWidth && baseHeight ? decor : null
  const layoutW = d ? baseWidth : width
  const layoutH = d ? baseHeight : height
  const fontCache = { css: null }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx2d = canvas.getContext('2d', { alpha: true, willReadFrequently: true })

  async function snapshotSvg() {
    const doc = iframe.contentDocument
    const view = iframe.contentWindow
    const body = doc.body

    peSeq = 0
    const ctx = { pseudoRules: [] }
    const outDoc = document.implementation.createHTMLDocument('')

    const bodyCs = view.getComputedStyle(body)
    const root = outDoc.createElementNS(XHTML, 'div')
    root.setAttribute(
      'style',
      cssTextFor(bodyCs, null, baselineFor('body')) +
        `box-sizing:border-box;width:${layoutW}px;height:${layoutH}px;margin:0;position:relative;` +
        'overflow:hidden;' +
        // Last wins: this overrides the transform and filter copied off the live
        // body, which say the same thing and would otherwise apply twice.
        (d ? decorStyle(d) : ''),
    )
    for (const child of Array.from(body.childNodes)) {
      const c = await buildNode(child, outDoc, bodyCs, ctx)
      if (c) root.appendChild(c)
    }

    const fontCss = await buildFontCss(doc, fontCache)
    const css = escapeXml(fontCss + '\n' + ctx.pseudoRules.join('\n'))
    const markup = new XMLSerializer().serializeToString(root)
    // `filter:url(#cc)` resolves in the document that holds the element, so the
    // matrix has to be reissued here; the copy in the clip is out of reach.
    const defs = d?.colour
      ? `<filter id="cc" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">` +
        `<feColorMatrix type="matrix" values="${colourMatrixValues(d.colour)}"/></filter>`
      : ''

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}">` +
      `<defs>${defs}<style type="text/css">${css}</style></defs>` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject>` +
      `</svg>`
    )
  }

  /**
   * Draw the current DOM state onto the canvas.
   * `background` null keeps the alpha channel intact.
   */
  // One <img> for the life of the rasterizer.
  const frameImg = new Image()
  frameImg.decoding = 'sync'

  async function drawFrame(background) {
    const svg = await snapshotSvg()

    // Must be a data: URI, not a blob: URL. Chrome taints the canvas when it
    // draws an SVG containing a <foreignObject> that was loaded from blob:,
    // which would make getImageData throw and break every export. The same
    // markup as a data: URI stays origin-clean. (createImageBitmap cannot
    // decode SVG at all, or it would be the answer.)
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)

    frameImg.src = url
    await frameImg.decode()

    ctx2d.clearRect(0, 0, width, height)
    if (background) {
      ctx2d.fillStyle = background
      ctx2d.fillRect(0, 0, width, height)
    }
    ctx2d.drawImage(frameImg, 0, 0, width, height)

    // Every frame is a different multi-megabyte data: URI; drop the reference
    // the moment the pixels are on the canvas so the decoded bitmap can go.
    // (Rasterizing alone stays flat over thousands of frames — measured; the
    // memory that used to pile up was the frame uploads, see export.js.)
    frameImg.src = ''
    return canvas
  }

  function rgbaBytes() {
    const d = ctx2d.getImageData(0, 0, width, height).data
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }

  return {
    canvas,
    ctx2d,
    drawFrame,
    rgbaBytes,
    snapshotSvg,
    invalidateFonts: () => {
      fontCache.css = null
    },
  }
}
