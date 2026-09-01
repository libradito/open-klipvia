/**
 * Mounting a clip — the one place that knows how a clip becomes a live document.
 *
 * The visible stage, thumbnails, agent inspection tools and now sequence
 * overlay renders all go through here, so a clip behaves identically wherever
 * it is mounted. The offscreen variants exist so nothing that merely *looks* at
 * a clip can move the user's playhead.
 */

import { createRasterizer } from '/rasterize.js'
import { colourFilterSvg, decorStyle } from '/effects.js'
import { rewriteAssetUrls } from '/localstore.js'

let runtimeSrc = ''

/**
 * Whether this page has a server behind it. Set once at boot; every offscreen
 * mount asks, because a browser-only build has to rewrite its asset URLs and
 * nothing that calls these helpers should have to remember that.
 */
let localMode_ = false
export const setLocalMode = (on) => { localMode_ = !!on }
const isLocal = () => localMode_

/** The virtual clock, fetched once and injected ahead of every clip's code. */
export function setRuntimeSource(src) {
  runtimeSrc = src
}

/**
 * The same document, with `/assets/…` turned into object URLs.
 *
 * A clip is mounted as an iframe's srcdoc, so every image it names is loaded by
 * the browser itself — no `fetch` wrapper can see it. In a browser-only build
 * the markup has to carry URLs that already resolve.
 */
export async function buildStageDocAsync(clip, { local = false } = {}) {
  if (!local) return buildStageDoc(clip)
  return buildStageDoc({
    ...clip,
    html: await rewriteAssetUrls(clip.html),
    css: await rewriteAssetUrls(clip.css),
  })
}

export function buildStageDoc(clip) {
  const bg = clip.background?.mode === 'color' ? clip.background.color : 'transparent'
  // A decorated clip lays itself out at its own size and is painted through one
  // transform — scaled, turned, mirrored — so none of it costs any sharpness.
  // See decoratedClip; the html box is the finished frame, the body the layout.
  const d = clip.decor
  const bodyW = d ? clip.baseWidth : clip.width
  const bodyH = d ? clip.baseHeight : clip.height
  // The body clips its own content — that is what makes `border-radius` round
  // anything. A turn happens after clipping, and a shadow is a filter, which
  // draws outside the box regardless; neither needs the spill, and the html box
  // has already been grown to hold both.
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html{margin:0;padding:0;width:${clip.width}px;height:${clip.height}px;overflow:hidden;background:${bg};}
  body{margin:0;padding:0;width:${bodyW}px;height:${bodyH}px;overflow:hidden;${decorStyle(d)}}
  *{box-sizing:border-box}
</style>
<script>${runtimeSrc}<\/script>
<style>
${clip.css}
</style>
</head><body${d ? ` data-plain-transform="${d.plainTransform}"` : ''}>
${d ? colourFilterSvg(d.colour) : ''}
${clip.html}
<script>
${clip.js}
<\/script>
</body></html>`
}

/** Wait for the runtime to report in, or give up so a throwing clip still resolves. */
function waitForReady(iframe) {
  return new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.source === iframe.contentWindow && e.data?.type === 'stage:ready') {
        window.removeEventListener('message', onMsg)
        resolve()
      }
    }
    window.addEventListener('message', onMsg)
    setTimeout(resolve, 4000)
  })
}

export function makeStageFrame(clip) {
  const iframe = document.createElement('iframe')
  iframe.width = clip.width
  iframe.height = clip.height
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  iframe.setAttribute('aria-label', 'Animation stage')
  return iframe
}

/**
 * Mount a clip in a throwaway offscreen frame and hand it to `fn`.
 *
 * Everything that inspects or renders a clip out of band — thumbnails, timeline
 * probing, linting, contact strips, sequence overlays — goes through here, so
 * none of it disturbs the visible stage.
 */
export async function withOffscreenClip(clip, fn, { local: localMode = isLocal() } = {}) {
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden'
  const iframe = makeStageFrame(clip)
  holder.appendChild(iframe)
  document.body.appendChild(holder)

  try {
    const ready = waitForReady(iframe)
    const errors = []
    const onErr = (e) => {
      if (e.source === iframe.contentWindow && e.data?.type === 'stage:error') {
        errors.push(e.data.message)
      }
    }
    window.addEventListener('message', onErr)

    iframe.srcdoc = await buildStageDocAsync(clip, { local: localMode })
    await ready

    try {
      const stage = iframe.contentWindow?.__stage
      if (!stage) throw new Error('the clip never finished loading')
      stage.configure({ duration: clip.durationMs, fps: clip.fps })
      await stage.ready()

      return await fn({ iframe, stage, doc: iframe.contentDocument, errors })
    } finally {
      window.removeEventListener('message', onErr)
    }
  } finally {
    holder.remove()
  }
}

/**
 * An offscreen export host: the same `{ reload, seek, raster }` surface the
 * visible stage presents, so `studioExport` cannot tell the difference.
 *
 * Rendering a sequence means rendering every animation layer in it. Doing that
 * through the visible stage would tear the user's preview apart for the length
 * of the render; doing it here does not.
 */
export function createOffscreenHost(clip, { local: localMode = isLocal() } = {}) {
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden'
  document.body.appendChild(holder)

  let iframe = null
  let raster = null

  const mount = async () => {
    holder.innerHTML = ''
    iframe = makeStageFrame(clip)
    holder.appendChild(iframe)
    const ready = waitForReady(iframe)
    iframe.srcdoc = await buildStageDocAsync(clip, { local: localMode })
    await ready

    const stage = iframe.contentWindow?.__stage
    if (!stage) throw new Error(`"${clip.name}" never finished loading`)
    stage.configure({ duration: clip.durationMs, fps: clip.fps })
    await stage.ready()

    raster = createRasterizer(iframe, { width: clip.width, height: clip.height, decor: clip.decor, baseWidth: clip.baseWidth, baseHeight: clip.baseHeight })
  }

  return {
    reload: mount,
    seek: (t) => iframe.contentWindow.__stage.seek(t, { fast: true }),
    get raster() {
      return raster
    },
    dispose() {
      holder.remove()
      iframe = null
      raster = null
    },
  }
}
