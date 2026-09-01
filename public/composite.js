/**
 * The preview compositor — one clock, three kinds of layer.
 *
 * A sequence preview has to keep real decoded video, real audio and the virtual
 * clock inside each animation iframe agreed on what time it is. They cannot
 * share a clock, because a <video> owns its own and the virtual clock only runs
 * forward, so instead a wall-clock master drives all three and corrects drift.
 *
 * The layer stack mirrors the render exactly: bottom video track first, each
 * overlay placed by the same arithmetic the filtergraph uses. What you scrub is
 * what you get.
 */

import { buildStageDocAsync, makeStageFrame } from '/stagehost.js'
import { createRasterizer } from '/rasterize.js'
import {
  compositeOrder, audioTracks, layerBox, overlayClipFor, placementPx, sequenceDuration, sourceTimeAt,
  speedOf, MAX_NESTING,
} from '/sequence.js'
import { paintedBounds } from '/bounds.js'
import { anyKeyed, resolveAt } from '/keys.js'
import { mediaUrl } from '/localstore.js'
import {
  blendCss, blendOf, colourCss, colourMatrixValues, colourOf, cropOf, croppedElement,
  dissolveAt, radiusOf, rotationOf, shadowCss, shadowOf, turnCss,
} from '/effects.js'

/**
 * The next macrotask, without a timer.
 *
 * `setTimeout` is clamped to a second or more in a background tab; a
 * MessageChannel message is not. Anywhere a render needs to yield rather than
 * wait, this is what it should yield with.
 */
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
const macroQueue = []
if (channel) {
  channel.port1.onmessage = () => macroQueue.shift()?.()
}
function macrotask(fn) {
  if (!channel) return void setTimeout(fn, 0)
  macroQueue.push(fn)
  channel.port2.postMessage(0)
}

/** How far an animation layer may fall behind the clock before it is fast-forwarded. */
const DRIFT_MS = 140
/** How far ahead of the playhead an animation layer is mounted. */
const PREROLL_MS = 1500
/**
 * The clock follows the sounding footage. Each tick the wall clock is moved
 * at most this far toward the media's own time, so a decoder that started
 * a beat late is absorbed over a few dozen frames instead of being seeked —
 * a seek is an audible cut, a slew is nothing.
 */
const SLEW_MS = 4
/** Beyond this the footage and the clock have genuinely parted: jump, once. */
const RESYNC_MS = 900
/** A second piece of media is kept in step by playback rate, not seeks, up to this far. */
const SECONDARY_SEEK_MS = 600
/** Inside this band a media element is left alone. */
const NUDGE_MS = 24
/** An animation that has run this far ahead of the clock is paused until the clock catches up. */
const HOLD_MS = 24
/** An animation is dropped from memory this long after it ended… */
const LINGER_MS = 2500
/** …or when it starts this far ahead — beyond the preroll, plus a margin. */
const FAR_MS = PREROLL_MS + 800

export function createCompositor({
  container,
  getContext,
  onTime,
  onEnd,
  onPause,
  // A compositor inside a compositor: its container is a block in the parent
  // frame, and its clock is the parent's.
  nested = false,
  depth = 0,
  // Sound only — the block sits on an audio track.
  soundOnly = false,
}) {
  /** itemId -> { item, kind, el, mounted, busy, clipKey } */
  const layers = new Map()

  let time = 0
  let playing = false
  let raf = 0
  let wallAnchor = 0
  let disposed = false

  /**
   * Playback health, for the status line and get_timeline_state: how many
   * frames the tick loop managed, how often media had to be hard-seeked back
   * into sync (each one is an audible cut), and what is mounted.
   */
  const stats = { frames: 0, seeks: 0, nudges: 0, resyncs: 0, since: 0, worstGapMs: 0, lastTick: 0 }
  /** The media layer whose own clock the wall clock follows while playing. */
  let master = null

  const ctx = () => getContext()

  /* ------------------------------------------------------------- building */

  function layerKey(item, clip) {
    // Rebuild an animation layer when the clip behind it changes, not merely
    // when the timeline is redrawn. A nested timeline's key is only its id: the
    // child compositor reads the live document, so an edit inside it — or a
    // newer revision polled in — needs no rebuild here.
    if (!clip) return `${item.type}:${item.sourceId}`
    return [
      item.type, item.sourceId, item.durationMs, item.inMs,
      clip.width, clip.height, clip.html?.length, clip.css?.length, clip.js?.length,
      clip.html, clip.css, clip.js,
    ].join('|')
  }

  /**
   * Show or hide an overlay **without** taking it out of the render tree.
   *
   * `display:none` on an iframe stops its document being rendered, and Chrome
   * cancels the CSS animations inside it. They come back as new Animation
   * objects when it is shown again, which the runtime cannot tell apart from
   * animations that were genuinely born at that moment — so it measures them
   * from the wrong zero and they never advance. Opacity keeps the document
   * live and the identities stable.
   */
  /** A keyed opacity, as a factor on the item's own — 1 when it is not keyed. */
  function keyedOpacity(item, t) {
    if (!anyKeyed(item)) return 1
    const base = item.opacity ?? 1
    if (!base) return 1
    return (resolveAt(item, t).opacity ?? base) / base
  }

  function showLayer(layer, visible, fade = 1) {
    layer.visible = visible
    const target = visible ? (layer.item.opacity ?? 1) * fade : 0
    if (layer.kind === 'overlay') {
      layer.el.style.opacity = String(target)
    } else if (layer.kind === 'video') {
      // A <video> holds no animation identity, so it can leave the tree.
      layer.el.style.display = visible ? '' : 'none'
      layer.el.style.opacity = String(target)
    } else if (layer.kind === 'timeline') {
      // Not opacity: a child at opacity 0 would keep playing its sound. Not
      // display:none either: that cancels the CSS animations in its iframes.
      layer.el.style.visibility = visible ? '' : 'hidden'
      layer.el.style.opacity = String(target)
    }
  }

  /** Volume every media element below this layer is scaled by. */
  function gainFor(layer) {
    const silent = layer.track?.muted || layer.item.muted
    return (ctx().gain ?? 1) * (silent ? 0 : Math.max(0, Math.min(1, layer.item.volume ?? 1)))
  }

  /**
   * A nested block is the child's frame scaled into the parent's, with the
   * arithmetic drawVideo uses for footage: contain letterboxes, cover crops,
   * fill stretches, none places the frame as it is.
   */
  function styleNested(el, item, child, seq) {
    const b = boxIn(item, seq) ?? { x: 0, y: 0, w: child.width, h: child.height, sx: 1, sy: 1 }
    el.dataset.baseScale = `${b.sx},${b.sy}`
    const crop = cropOf(item)
    const e = croppedElement(b, crop)
    const turn = turnCss(item)
    // The child is laid out at its own size and scaled into its box, so the crop
    // is applied to that scaled result — the same order the render takes.
    const sx = e.width / child.width, sy = e.height / child.height
    el.style.cssText =
      `position:absolute;left:${e.left}px;top:${e.top}px;width:${child.width}px;height:${child.height}px;overflow:hidden;` +
      `transform-origin:0 0;transform:${turn ? `translate(${e.originX}px,${e.originY}px) ${turn} translate(${-e.originX}px,${-e.originY}px) ` : ''}scale(${sx},${sy});` +
      `opacity:${item.opacity ?? 1};visibility:hidden;` +
      (e.clip ? `clip-path:${e.clip};` : '') +
      effectCss(item, b.sx)
  }

  /**
   * Footage fills the frame by object-fit, except `none`, which is placed at
   * its native size by the same anchor arithmetic the filtergraph uses.
   */
  function styleVideo(el, item, media, seq) {
    const fit = ['fill', 'cover', 'none', 'contain'].includes(item.fit) ? item.fit : 'contain'
    const b = boxIn(item, seq)
    // `cover` and `fill` fill the frame and `contain` letterboxes inside it, all
    // of which layerBox already worked out — so once anything is done to the
    // layer it is simplest to place the element on that box explicitly and let
    // object-fit:fill do the stretching, exactly as the filtergraph does.
    if (b && (fit === 'none' || cropOf(item) || rotationOf(item) || item.flipH || item.flipV)) {
      const e = croppedElement(b, cropOf(item))
      const turn = turnCss(item)
      el.style.cssText =
        `position:absolute;left:${e.left}px;top:${e.top}px;width:${e.width}px;height:${e.height}px;` +
        `object-fit:fill;opacity:${item.opacity ?? 1};background:transparent;` +
        (e.clip ? `clip-path:${e.clip};` : '') +
        (turn ? `transform:${turn};transform-origin:${e.originX}px ${e.originY}px;` : '') +
        effectCss(item, b.sx)
      return
    }
    el.style.cssText =
      `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};` +
      `opacity:${item.opacity ?? 1};background:transparent;` +
      effectCss(item)
  }

  /** This level's geometry for an item — the one arithmetic the render shares. */
  function boxIn(item, seq, atMs = time) {
    return layerBox(item, { ...ctx(), seq }, atMs)
  }

  /**
   * Everything done to footage or a nested block that is not its position.
   *
   * An overlay gets all of this for free, baked into the clip document, because
   * a browser renders it twice and cannot disagree with itself. These two are
   * decoded video and a live sub-stage: they never pass through a clip, so the
   * CSS here and the filtergraph in `src/sequence.ts` are two hands that have
   * to write the same sentence.
   */
  function effectCss(item, sx = 1) {
    const colour = colourOf(item)
    const shadow = shadowOf(item)
    // In the source's own pixels, so it scales with the layer — the same thing
    // the filtergraph says, where the rounding is cut before anything resizes.
    const radius = Math.round(radiusOf(item) * (sx || 1))
    const blend = blendOf(item)
    const filter = [colourCss(colour, colour ? filterIdFor(item, colour) : ''), shadowCss(shadow)].filter(Boolean).join(' ')
    return (
      (filter ? `filter:${filter};` : '') +
      (blend ? `mix-blend-mode:${blendCss(blend)};` : '') +
      (radius ? `border-radius:${radius}px;` : '')
    )
  }

  /**
   * One SVG colour matrix per item that needs one, kept in the host document
   * next to the stage. `filter:url(#…)` only resolves in the document holding
   * the element, and these elements live here, not in a clip.
   */
  function filterIdFor(item, colour) {
    const id = `cc-${item.id}`
    let defs = document.getElementById('stageColourDefs')
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      defs.id = 'stageColourDefs'
      defs.setAttribute('width', '0')
      defs.setAttribute('height', '0')
      defs.setAttribute('aria-hidden', 'true')
      defs.style.cssText = 'position:absolute;width:0;height:0'
      document.body.appendChild(defs)
    }
    let f = document.getElementById(id)
    if (!f) {
      f = document.createElementNS('http://www.w3.org/2000/svg', 'filter')
      f.id = id
      f.setAttribute('color-interpolation-filters', 'sRGB')
      f.setAttribute('x', '0'); f.setAttribute('y', '0')
      f.setAttribute('width', '100%'); f.setAttribute('height', '100%')
      f.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix'))
      defs.appendChild(f)
    }
    const m = f.firstChild
    m.setAttribute('type', 'matrix')
    m.setAttribute('values', colourMatrixValues(colour))
    return id
  }

  function styleOverlay(el, item, clip, seq) {
    // Through layerBox like everything else, so the margin a turn or a shadow
    // added is discounted from the anchor here exactly as it is in the render.
    const b = boxIn(item, seq) ?? placementPx(item.anchor, seq.width, seq.height, clip.width, clip.height, item.offsetX, item.offsetY)
    // The element stays the clip's own pixel size and is *scaled* into its box,
    // so a size that moves is a transform rather than a reload of the document.
    const rel = b.sx ?? 1
    el.style.cssText =
      `position:absolute;left:${b.x}px;top:${b.y}px;` +
      `width:${clip.width}px;height:${clip.height}px;border:0;` +
      (Math.abs(rel - 1) > 0.0005 ? `transform-origin:0 0;transform:scale(${rel});` : '') +
      `opacity:0;pointer-events:none;` +
      (blendOf(item) ? `mix-blend-mode:${blendCss(blendOf(item))};` : '')
  }

  function makeLayer(item, seq, zIndex, track = null) {
    const { clips, transcripts, assets } = ctx()

    if (item.type === 'timeline') {
      const child = ctx().timelines?.get(item.sourceId)
      if (!child || depth >= MAX_NESTING) return null
      const isAudio = soundOnly || track?.kind === 'audio'
      const el = document.createElement('div')
      el.className = 'nested-timeline'
      if (isAudio) el.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;'
      else {
        styleNested(el, item, child, seq)
        el.style.zIndex = String(zIndex)
      }
      const layer = { item, kind: 'timeline', el, child: null, mounted: true, busy: false, clipKey: layerKey(item, null), active: false, track }
      // The child never runs its own clock: the parent's tick drives it.
      layer.child = createCompositor({
        container: el,
        nested: true,
        depth: depth + 1,
        soundOnly: isAudio,
        getContext: () => {
          const parent = ctx()
          return { ...parent, seq: parent.timelines?.get(layer.item.sourceId) ?? child, gain: gainFor(layer) }
        },
      })
      return layer
    }

    if (item.type === 'media') {
      const media = ctx().media.get(item.sourceId)
      // The track decides, not the file: footage on an audio track is its
      // sound only. An <audio> element plays an mp4's audio and draws nothing,
      // which is exactly what the render does with it.
      const isAudio = soundOnly || track?.kind === 'audio' || media?.kind === 'audio'
      const el = document.createElement(isAudio ? 'audio' : 'video')
      // A `<video src>` is a subresource load, not a fetch, so a browser-only
      // build cannot answer it by intercepting anything — it needs a real URL.
      // An object URL over the OPFS file is one, and the browser seeks inside
      // it natively, which is the whole reason scrubbing works without a server.
      el.src = `/media/${item.sourceId}`
      if (ctx().local) mediaUrl(item.sourceId).then((u) => { if (u) el.src = u })
      el.preload = 'auto'
      el.playsInline = true
      el.crossOrigin = 'anonymous'
      if (!isAudio) {
        styleVideo(el, item, media, seq)
        el.style.display = 'none'
      } else {
        el.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;'
      }
      return { item, kind: isAudio ? 'audio' : 'video', el, mounted: true, busy: false, clipKey: '' }
    }

    if (soundOnly) return null
    const clip = overlayClipFor(item, { clips, transcripts, seq, assets })
    if (!clip) return null

    const el = makeStageFrame(clip)
    styleOverlay(el, item, clip, seq)
    el.style.zIndex = String(zIndex)
    return { item, kind: 'overlay', el, clip, mounted: false, busy: false, clipKey: layerKey(item, clip) }
  }

  /** Rebuild the layer stack, keeping any element whose source is unchanged. */
  function rebuild() {
    if (disposed) return
    const { seq, clips, transcripts, assets } = ctx()
    if (!seq) return

    if (!soundOnly) {
      container.style.width = `${seq.width}px`
      container.style.height = `${seq.height}px`
      // A nested frame shows the child's colour, or nothing — never the
      // checkerboard, and never a transform of its own.
      if (!nested) container.classList.toggle('transparent', seq.background?.mode === 'transparent')
      container.style.background =
        seq.background?.mode === 'color' ? seq.background.color : ''
    }

    const wanted = new Set()
    let z = 1

    for (const track of compositeOrder(seq)) {
      for (const item of track.items) {
        wanted.add(item.id)
        const existing = layers.get(item.id)
        const clip = item.type === 'media' ? null : overlayClipFor(item, { clips, transcripts, seq, assets })
        const key = item.type === 'media' ? '' : layerKey(item, clip)

        if (existing && (item.type === 'media' ? existing.kind !== 'overlay' : existing.clipKey === key)) {
          existing.item = item
          existing.el.style.zIndex = String(z++)
          if (existing.kind === 'overlay') existing.el.style.opacity = String(existing.visible ? (item.opacity ?? 1) : 0)
          else existing.el.style.opacity = String(item.opacity ?? 1)
          if (existing.kind === 'video') {
            const wasDisplay = existing.el.style.display
            styleVideo(existing.el, item, ctx().media.get(item.sourceId), seq)
            existing.el.style.zIndex = String(z - 1)
            existing.el.style.display = wasDisplay
          } else if (existing.kind === 'overlay' && clip) {
            styleOverlay(existing.el, item, clip, seq)
            existing.el.style.zIndex = String(z - 1)
            existing.el.style.opacity = String(existing.visible ? (item.opacity ?? 1) : 0)
            existing.clip = clip
          } else if (existing.kind === 'timeline') {
            const child = ctx().timelines?.get(item.sourceId)
            if (child) styleNested(existing.el, item, child, seq)
            existing.el.style.zIndex = String(z - 1)
            existing.el.style.visibility = existing.visible ? '' : 'hidden'
            existing.child.rebuild()
          }
          if (track.hidden) existing.el.style.visibility = 'hidden'
          else if (existing.kind !== 'timeline') existing.el.style.visibility = ''
          continue
        }

        if (existing) removeLayer(existing)
        const made = makeLayer(item, seq, z++)
        if (!made) continue
        made.track = track
        if (track.hidden) made.el.style.visibility = 'hidden'
        if (made.kind !== 'overlay') container.appendChild(made.el)
        layers.set(item.id, made)
        // Built after it is in the tree: a detached iframe never loads.
        made.child?.rebuild()
      }
    }

    // Audio tracks carry no picture, but their elements still live in the stage
    // so one dispose tears everything down.
    for (const track of audioTracks(seq)) {
      for (const item of track.items) {
        wanted.add(item.id)
        const existing = layers.get(item.id)
        if (existing) {
          existing.item = item
          existing.track = track
          existing.child?.rebuild()
          continue
        }
        const made = makeLayer(item, seq, 0, track)
        if (!made) continue
        made.track = track
        container.appendChild(made.el)
        layers.set(item.id, made)
        made.child?.rebuild()
      }
    }

    for (const [id, layer] of layers) {
      if (wanted.has(id)) continue
      removeLayer(layer)
      layers.delete(id)
    }

    applyTime(time, { immediate: true })
  }

  function removeLayer(layer) {
    layer.raster = null
    stopLayer(layer)
    layer.child?.dispose()
    layer.el.remove()
  }

  /* -------------------------------------------------------------- mounting */

  /**
   * Load the clip into the frame. Callers own the busy flag.
   *
   * `gen` guards the tail: a mount takes several turns of the event loop, and
   * anything that tears the document down meanwhile — `invalidateOverlays`
   * when the stage was hidden, say — bumps the counter. Without the check the
   * finishing mount would flag a layer whose frame had just been removed as
   * mounted, and nothing would ever rebuild it.
   */
  async function mountFrame(layer) {
    const gen = (layer.gen = (layer.gen ?? 0) + 1)
    const clip = layer.clip
    const ready = new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.source === layer.el.contentWindow && e.data?.type === 'stage:ready') {
          window.removeEventListener('message', onMsg)
          resolve()
        }
      }
      window.addEventListener('message', onMsg)
      setTimeout(resolve, 4000)
    })
    // An overlay's frame only enters the tree when it is needed: a detached
    // iframe has no document at all, so the dozens of titles, captions and
    // stings a long timeline carries cost nothing until the playhead nears.
    if (!layer.el.isConnected) container.appendChild(layer.el)
    layer.el.srcdoc = await buildStageDocAsync(clip, { local: ctx().local })
    await ready

    if (layer.gen !== gen) return
    const stage = layer.el.contentWindow?.__stage
    if (stage) {
      stage.configure({ duration: clip.durationMs, fps: clip.fps })
      await stage.ready()
    }
    if (layer.gen !== gen) return
    layer.mounted = true
  }

  /**
   * Build an overlay's document, and hand back the same promise to anyone who
   * asks again while that is still happening.
   *
   * Returning early on `busy` was a dropped seek: switching to Timeline mode
   * starts the mounts at time zero, and a scrub arriving a few milliseconds
   * later found the layer busy, gave up, and left that one layer stuck on the
   * frame it happened to be built at while every faster layer moved. Chaining
   * on the in-flight mount instead means the last seek requested is the one
   * that lands, because `.then` callbacks run in the order they were added.
   */
  function mountOverlay(layer) {
    if (layer.mounted) return Promise.resolve()
    if (layer.mounting) return layer.mounting
    layer.busy = true
    layer.mounting = (async () => {
      try {
        await mountFrame(layer)
      } catch {
        /* a clip that will not mount simply does not draw */
      } finally {
        layer.busy = false
        layer.mounting = null
      }
    })()
    return layer.mounting
  }

  /** Drop an overlay's document and take its frame out of the tree. */
  function unmountOverlay(layer) {
    if (layer.busy || !layer.mounted) return
    try { layer.el.contentWindow?.__stage?.pause() } catch { /* gone */ }
    layer.mounted = false
    layer.el.srcdoc = ''
    layer.el.remove()
  }

  /**
   * Rebuild from zero and fast-forward.
   *
   * The virtual clock cannot be rewound — imperative code cannot be
   * un-executed — so this is the only way back to an earlier moment. It owns
   * the busy flag itself: an earlier version had the caller set it, which then
   * made the mount inside here no-op against its own guard and left the old
   * document in place, showing the wrong frame.
   *
   * It publishes `mounting` for the same reason `mountOverlay` does — a mount
   * asked for mid-rebuild waits for this one rather than racing it.
   */
  function remountOverlay(layer, toMs) {
    if (layer.mounting) return layer.mounting
    layer.busy = true
    layer.mounting = (async () => {
      try {
        layer.mounted = false
        await mountFrame(layer)
        const stage = layer.el.contentWindow?.__stage
        if (stage && toMs > 0) await stage.seek(Math.max(0, toMs), { fast: true })
      } catch {
        /* leave it unmounted; the next sync tries again */
      } finally {
        layer.busy = false
        layer.mounting = null
      }
    })()
    return layer.mounting
  }

  function stopLayer(layer) {
    if (layer.kind === 'video' || layer.kind === 'audio') {
      try {
        layer.el.pause()
        if (layer.el.playbackRate !== 1) layer.el.playbackRate = 1
      } catch { /* not started */ }
    } else if (layer.kind === 'timeline') {
      layer.child.pause()
      layer.active = false
    } else {
      try { layer.el.contentWindow?.__stage?.pause() } catch { /* not mounted */ }
    }
  }

  /* ------------------------------------------------------------- transport */

  /** Where the layer's own clock should be at sequence time `t`. */
  const localTime = sourceTimeAt

  function isActive(item, t) {
    return t >= item.startMs && t < item.startMs + item.durationMs
  }

  /** The inverse of localTime: sequence time for a media element's own time. */
  function seqTimeOf(item, sourceMs) {
    const local = item.type === 'caption' ? sourceMs : sourceMs - item.inMs
    return item.startMs + local / speedOf(item)
  }

  /**
   * The layer the clock should follow: sounding footage that is actually
   * running. Footage that started earliest wins, so a cut between two takes
   * hands the clock over only once the new take is really playing.
   */
  function pickMaster(t) {
    let best = null
    let bestSound = false
    for (const layer of layers.values()) {
      if (layer.kind !== 'video' && layer.kind !== 'audio') continue
      const { item, el } = layer
      if (!isActive(item, t) || layer.track?.hidden) continue
      if (el.paused || el.seeking || el.ended || el.readyState < 3 || !(el.currentTime > 0)) continue
      const sound = !(layer.track?.muted || item.muted) && (item.volume ?? 1) > 0
      if (best && bestSound && !sound) continue
      if (!best || (sound && !bestSound) || item.startMs < best.item.startMs) {
        best = layer
        bestSound = sound
      }
    }
    return best
  }

  /**
   * Put every layer where `t` says it should be.
   *
   * `immediate` means the caller is scrubbing: media is hard-seeked and an
   * animation that has run past the requested moment is rebuilt from zero. In
   * playback the same code only nudges, so a correction never stutters.
   */
  function applyTime(t, { immediate = false } = {}) {
    const { seq, gain = 1 } = ctx()
    if (!seq) return

    for (const layer of layers.values()) {
      const { item } = layer
      const active = isActive(item, t) && !layer.track?.hidden
      const local = localTime(item, t)

      if (layer.kind === 'timeline') {
        if (!active) {
          showLayer(layer, false)
          if (layer.active) stopLayer(layer)
          continue
        }
        if (anyKeyed(item)) reposition(item.id)
        showLayer(layer, true, dissolveAt(item, t) * keyedOpacity(item, t))
        layer.active = true
        layer.child.drive(local, { playing, immediate })
        continue
      }

      if (layer.kind === 'video' || layer.kind === 'audio') {
        const el = layer.el
        const silent = layer.track?.muted || item.muted
        el.volume = Math.max(0, Math.min(1, (silent ? 0 : (item.volume ?? 1)) * gain))

        if (!active) {
          showLayer(layer, false)
          if (!el.paused) el.pause()
          continue
        }
        if (anyKeyed(item)) reposition(item.id)
        showLayer(layer, true, dissolveAt(item, t) * keyedOpacity(item, t))

        const want = local / 1000
        const behindMs = (want - el.currentTime) * 1000 // > 0: the element is behind the clock
        const drift = Math.abs(behindMs)

        const rate = speedOf(item)
        if (immediate || !playing) {
          if (!el.paused) el.pause()
          if (el.playbackRate !== rate) el.playbackRate = rate
          if (drift > 30 && Number.isFinite(want)) el.currentTime = Math.max(0, want)
        } else if (layer === master) {
          // The clock follows this element (see tick), so it is never nudged
          // and only seeked when the two have truly parted.
          if (el.playbackRate !== rate) el.playbackRate = rate
          if (drift > RESYNC_MS && Number.isFinite(want)) {
            el.currentTime = Math.max(0, want)
            stats.seeks++
          }
        } else {
          // Anything else with sound — a music bed, a second take, detached
          // narration — is steered by playback rate. A few percent for a
          // second or two is inaudible; a seek never is.
          if (drift > SECONDARY_SEEK_MS && Number.isFinite(want)) {
            el.currentTime = Math.max(0, want)
            if (el.playbackRate !== rate) el.playbackRate = rate
            stats.seeks++
          } else {
            // The nudge is a few percent *around the item's own speed*, not
            // around 1 — an item playing at half speed must be steered at half
            // speed or it would be dragged back to normal a frame at a time.
            let want2 = rate
            if (behindMs > NUDGE_MS) want2 = rate * (1 + Math.min(0.08, behindMs / 1500))
            else if (behindMs < -NUDGE_MS) want2 = rate * (1 - Math.min(0.06, -behindMs / 1500))
            if (Math.abs(el.playbackRate - want2) > 0.004) {
              el.playbackRate = want2
              if (Math.abs(want2 - rate) > 0.001) stats.nudges++
            }
          }
          if (el.paused) el.play().catch(() => {})
        }
        continue
      }

      /* overlay */
      if (!active) {
        // Mount ahead of time so a title does not pop in a beat late.
        const soon = item.startMs - t
        const gone = t - (item.startMs + item.durationMs)
        if (playing && soon > 0 && soon < PREROLL_MS && !layer.mounted && !layer.track?.hidden) mountOverlay(layer)
        showLayer(layer, false)
        if (layer.mounted) {
          // Far from the playhead the document is dead weight: drop it. The
          // preroll rebuilds it in time, and scrubbing rebuilds it on demand.
          if (soon > FAR_MS || gone > LINGER_MS) unmountOverlay(layer)
          else try { layer.el.contentWindow?.__stage?.pause() } catch { /* gone */ }
        }
        continue
      }

      if (anyKeyed(item)) reposition(item.id)
      showLayer(layer, true, dissolveAt(item, t) * keyedOpacity(item, t))
      if (!layer.mounted) {
        mountOverlay(layer).then(() => syncOverlay(layer, local, immediate))
        continue
      }
      syncOverlay(layer, local, immediate)
    }
  }

  function syncOverlay(layer, local, immediate) {
    const stage = layer.el.contentWindow?.__stage
    if (!stage || layer.busy) return

    const now = stage.time
    const ahead = now - local // > 0: the document is past where the clock says
    if (ahead > (playing && !immediate ? 400 : 40)) {
      // Behind where the document already is: only a rebuild can go back.
      remountOverlay(layer, local).then(() => {
        if (playing) layer.el.contentWindow?.__stage?.play()
      })
      return
    }

    if (playing && !immediate) {
      if (ahead > HOLD_MS) {
        // The clock is slewing toward late footage: hold the animation a few
        // frames rather than rebuild it. It resumes below once time arrives.
        if (stage.playing) stage.pause()
        return
      }
      if (!stage.playing) {
        if (-ahead > 40) stage.seek(local, { fast: true })
        stage.play()
      } else if (-ahead > DRIFT_MS) {
        stage.seek(local, { fast: true })
      }
    } else {
      if (stage.playing) stage.pause()
      if (local - now > 8) stage.seek(local, { fast: true })
    }
  }

  function tick() {
    if (!playing || disposed) return
    const { seq } = ctx()
    const duration = sequenceDuration(seq)
    let t = performance.now() - wallAnchor

    // The sounding footage is the master clock. Its element reports where it
    // really is; the wall clock is eased toward that, a few milliseconds a
    // frame, so the picture, the titles and the captions follow the sound
    // instead of the sound being dragged to a stopwatch.
    master = pickMaster(t)
    if (master) {
      const tm = seqTimeOf(master.item, master.el.currentTime * 1000)
      const delta = tm - t
      if (Math.abs(delta) > RESYNC_MS) {
        wallAnchor = performance.now() - tm
        t = tm
        stats.resyncs++
      } else if (Math.abs(delta) > 2) {
        const step = Math.sign(delta) * Math.min(Math.abs(delta), SLEW_MS)
        wallAnchor -= step
        t += step
      }
    }

    if (t >= duration) {
      time = duration
      applyTime(duration, { immediate: true })
      pause()
      onTime?.(duration)
      onEnd?.()
      return
    }

    const nowMs = performance.now()
    if (stats.lastTick) stats.worstGapMs = Math.max(stats.worstGapMs, nowMs - stats.lastTick)
    stats.lastTick = nowMs
    stats.frames++

    time = t
    applyTime(t)
    onTime?.(t)
    raf = requestAnimationFrame(tick)
  }

  function play() {
    if (playing || disposed) return
    const { seq } = ctx()
    const duration = sequenceDuration(seq)
    if (duration <= 0) return
    if (time >= duration - 20) time = 0

    playing = true
    wallAnchor = performance.now() - time
    Object.assign(stats, { frames: 0, seeks: 0, nudges: 0, resyncs: 0, since: performance.now(), worstGapMs: 0, lastTick: 0 })
    applyTime(time, { immediate: true })
    raf = requestAnimationFrame(tick)
  }

  function pause() {
    const was = playing
    playing = false
    master = null
    cancelAnimationFrame(raf)
    for (const layer of layers.values()) stopLayer(layer)
    if (was) onPause?.()
  }

  /**
   * The parent's clock, handed down. Sets this level's time and whether its
   * media should be running, and never arms a tick of its own — one clock,
   * however deep the nesting.
   */
  function drive(ms, { playing: run = false, immediate = false } = {}) {
    const { seq } = ctx()
    if (!seq || disposed) return
    const duration = sequenceDuration(seq)
    time = Math.max(0, Math.min(duration, ms))
    const was = playing
    playing = run && time < duration
    if (was && !playing) for (const layer of layers.values()) stopLayer(layer)
    applyTime(time, { immediate: immediate || !playing })
  }

  function seekTo(ms) {
    const { seq } = ctx()
    const duration = sequenceDuration(seq)
    time = Math.max(0, Math.min(duration, ms))
    if (playing) wallAnchor = performance.now() - time
    applyTime(time, { immediate: true })
    onTime?.(time)
  }

  /* -------------------------------------------------------------- snapshot */

  /**
   * Resolve on the first of several events, or give up after `timeoutMs`.
   *
   * Several, not one, because of `loadeddata`: it fires once for the initial
   * load and never again. Seeking a media element drops `readyState` to 1 for
   * a moment, and code that reacted by waiting for `loadeddata` was waiting
   * for something already spent — so every frame of a render paid the whole
   * timeout instead of the two milliseconds the seek actually took. `canplay`
   * and `seeked` both fire per seek; whichever arrives first will do.
   */
  const onceAny = (el, events, timeoutMs) => {
    let timer = null
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const e of events) el.removeEventListener(e, finish)
        resolve()
      }
      for (const e of events) el.addEventListener(e, finish)
      timer = setTimeout(finish, timeoutMs)
    })
  }

  /** Wait until every active layer actually shows the current time. */
  async function settle() {
    const waits = []
    for (const layer of layers.values()) {
      const { item } = layer
      if (!isActive(item, time) || layer.track?.hidden) continue
      const el = layer.el
      if (layer.kind === 'timeline') {
        layer.child.drive(localTime(item, time), { immediate: true })
        waits.push(layer.child.settle())
        continue
      }
      if (layer.kind === 'video' || layer.kind === 'audio') {
        // Sound is not part of the picture. A render takes its audio from the
        // offline mix here, and from ffmpeg reading the files on a server —
        // never from these elements — so a snapshot has nothing to wait on.
        if (layer.kind === 'audio') continue
        // An element with nothing loaded is not worth waiting for: there is no
        // event coming.
        if (el.readyState === 0) continue
        // Past that, whether a hidden tab is worth waiting on depends on who
        // is doing the render. With a server this canvas frame is a stand-in —
        // ffmpeg decodes the real footage afterwards — so a background tab's
        // slow media is time thrown away. With no server this *is* the render,
        // and not waiting for a seek to land composites the frame the element
        // happened to be showing. An agent asked to render while its person
        // looks at another tab is the ordinary case, not the odd one.
        if (document.hidden && !ctx().local) continue
        if (el.readyState < 2 || el.seeking) waits.push(onceAny(el, ['seeked', 'canplay', 'loadeddata'], 1500))
      } else {
        waits.push(
          (async () => {
            const t0 = performance.now()
            while ((layer.busy || !layer.mounted) && performance.now() - t0 < 5000) {
              // Same clamp as above: a 30 ms poll becomes a 1000 ms poll in a
              // background tab, which is most of a render's wall clock.
              await new Promise((r) => (document.hidden ? macrotask(r) : setTimeout(r, 30)))
            }
            const stage = el.contentWindow?.__stage
            const want = localTime(item, time)
            if (stage && Math.abs(stage.time - want) > 8) {
              if (want < stage.time) await remountOverlay(layer, want)
              else await stage.seek(want, { fast: true })
            }
          })(),
        )
      }
    }
    await Promise.all(waits)
    // Two frames for the seeked media to paint — but a background tab never
    // fires rAF at all, and an agent's tab is usually in the background.
    //
    // The fallback used to be `setTimeout(90)`, which is the trap: a background
    // tab clamps timers to a second or more, so every frame of a render cost a
    // second of doing nothing and a thirty-second video took a quarter of an
    // hour. A MessageChannel task is not clamped, and a hidden tab has nothing
    // to paint anyway — the layout flush the runtime already forces is what the
    // rasterizer actually reads.
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      if (document.hidden) {
        macrotask(finish)
        setTimeout(finish, 250)
        return
      }
      requestAnimationFrame(() => requestAnimationFrame(finish))
      setTimeout(finish, 90)
    })
  }

  /** `el` is a <video> with data, or an ImageBitmap of a frame ffmpeg decoded. */
  /**
   * One layer of footage, painted onto a canvas exactly as the DOM would show
   * it — same box, same crop, same turn, same colour, same rounding.
   *
   * This is the third place the effect order has to be obeyed, after the CSS
   * and the filtergraph, and it is the one the browser-only render goes
   * through. Canvas can say all of it: `filter` takes the same strings CSS
   * does, `globalCompositeOperation` the same blend names, and a clipped
   * rounded rect is the same hole in the alpha that `geq` cuts.
   */
  function drawVideo(g, el, item, media, W, H, atMs = time) {
    const seq = ctx().seq
    const live = anyKeyed(item) ? resolveAt(item, atMs) : item
    const vw = el.videoWidth || el.width || media?.width || W
    const vh = el.videoHeight || el.height || media?.height || H
    const b = layerBox(live, { ...ctx(), seq }, atMs) ?? { x: 0, y: 0, w: W, h: H, sx: 1 }

    // Crop is in the source's own pixels, which is exactly what drawImage's
    // source rectangle is — so it costs nothing here.
    const crop = cropOf(live)
    const sx = crop ? vw * crop.left : 0
    const sy = crop ? vh * crop.top : 0
    const sw = crop ? vw * crop.kx : vw
    const sh = crop ? vh * crop.ky : vh

    const colour = colourOf(live)
    const shadow = shadowOf(live)
    const filter = [colourCss(colour, colour ? filterIdFor(live, colour) : ''), shadowCss(shadow)].filter(Boolean).join(' ')
    const blend = blendOf(live)
    const radius = radiusOf(live) * (b.sx ?? 1)

    g.save()
    g.globalAlpha = (live.opacity ?? 1) * dissolveAt(live, atMs)
    if (filter) g.filter = filter
    if (blend) g.globalCompositeOperation = blendCss(blend)

    // Turn and mirror about the middle of the box, as the transform does.
    g.translate(b.x + b.w / 2, b.y + b.h / 2)
    const deg = rotationOf(live)
    if (deg) g.rotate((deg * Math.PI) / 180)
    if (live.flipH || live.flipV) g.scale(live.flipH ? -1 : 1, live.flipV ? -1 : 1)
    g.translate(-b.w / 2, -b.h / 2)

    if (radius > 0 && g.roundRect) {
      g.beginPath()
      g.roundRect(0, 0, b.w, b.h, Math.min(radius, b.w / 2, b.h / 2))
      g.clip()
    }
    g.drawImage(el, sx, sy, sw, sh, 0, 0, b.w, b.h)
    g.restore()
  }

  /**
   * One frame of footage, decoded by ffmpeg. Fetched as a bitmap rather than
   * through an <img>: `HTMLImageElement.decode()` never settles for a network
   * image while the tab is hidden, and this is exactly the path a hidden tab
   * takes.
   */
  async function serverFrame(filename, sourceMs) {
    // No server, no decoder to ask. The element is the only source of frames
    // here, and `settle` has already waited for it; asking anyway would be a
    // failed request per frame of every render.
    if (ctx().local) return null
    try {
      const res = await fetch(`/api/media/${filename}/frame?t=${(Math.max(0, sourceMs) / 1000).toFixed(3)}`)
      if (!res.ok) return null
      return await createImageBitmap(await res.blob())
    } catch {
      return null
    }
  }

  /**
   * Composite the frame at `t` onto a canvas — footage drawn straight from the
   * decoded <video>, overlays through the same rasterizer the export uses,
   * stacked in the same order. What an agent sees here is what it will get.
   */
  async function snapshot(t) {
    const { seq, media } = ctx()
    if (!seq) throw new Error('no sequence')
    const W = seq.width
    const H = seq.height

    pause()
    seekTo(t)
    await settle()

    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const g = canvas.getContext('2d')
    if (seq.background?.mode === 'color') {
      g.fillStyle = seq.background.color
      g.fillRect(0, 0, W, H)
    }

    for (const track of compositeOrder(seq)) {
      if (track.hidden) continue
      for (const item of track.items) {
        const layer = layers.get(item.id)
        if (!layer || !isActive(item, time)) continue
        if (layer.kind === 'video') {
          const m = media.get(item.sourceId)
          const el = layer.el
          const ready = el.readyState >= 2 && !el.seeking && Math.abs(el.currentTime * 1000 - localTime(item, time)) < 60
          if (ready) {
            drawVideo(g, el, item, m, W, H, time)
          } else {
            // No decoded data — a background tab never loads media. ffmpeg
            // will decode the exact frame instead.
            const frame = await serverFrame(item.sourceId, localTime(item, time))
            if (frame) {
              drawVideo(g, frame, item, m, W, H, time)
              frame.close()
            }
          }
          continue
        }
        if (layer.kind === 'timeline') {
          // The child draws its own frame; it lands here like footage would.
          const frame = await layer.child.snapshot(localTime(item, time))
          drawVideo(g, frame, item, { width: frame.width, height: frame.height }, W, H, time)
          continue
        }
        if (layer.kind !== 'overlay' || !layer.mounted) continue
        const clip = layer.clip
        // One rasterizer per layer, not per frame. A rasterizer carries the
        // inlined font cache for its document, and building a new one every
        // frame re-fetches and re-inlines every font — invisible when only the
        // server rendered (one per overlay, reused for the whole clip), and
        // ruinous now that a browser render asks for a frame thirty times a
        // second. It is dropped with the layer, which is also when the clip it
        // was built for stops being the clip.
        if (!layer.raster) {
          layer.raster = createRasterizer(layer.el, {
            width: clip.width, height: clip.height,
            decor: clip.decor, baseWidth: clip.baseWidth, baseHeight: clip.baseHeight,
          })
        }
        const raster = layer.raster
        await raster.drawFrame(null)
        // An overlay's turn, colour and rounding are already in the picture —
        // they were baked into the clip. Only where it sits, how solid it is
        // and how it mixes are left to say here.
        const b = boxIn(item, seq, time) ?? { x: 0, y: 0, w: clip.width, h: clip.height, sx: 1 }
        const blend = blendOf(item)
        g.save()
        g.globalAlpha = (item.opacity ?? 1) * dissolveAt(item, time)
        if (blend) g.globalCompositeOperation = blendCss(blend)
        g.drawImage(raster.canvas, b.x, b.y, b.w, b.h)
        g.restore()
      }
    }
    return canvas
  }

  /**
   * Drop every mounted overlay so the next sync rebuilds it.
   *
   * Switching to clip mode hides the whole sequence stage, which cancels the
   * animations inside every overlay for the same reason as above. Coming back,
   * a rebuild from zero is both correct and cheap.
   */
  function invalidateOverlays() {
    for (const layer of layers.values()) {
      if (layer.kind === 'timeline') layer.child.invalidateOverlays()
      if (layer.kind !== 'overlay') continue
      layer.gen = (layer.gen ?? 0) + 1
      layer.mounted = false
      layer.el.srcdoc = ''
      layer.el.remove()
    }
  }

  /* ---------------------------------------------------- direct manipulation */

  /**
   * Restyle one layer in place, without touching the rest of the stack.
   *
   * Dragging a title across the stage would otherwise cost a full rebuild per
   * pointer event — every iframe re-keyed, every document reloaded — and the
   * thing being dragged would strobe. Only its left/top actually changed, so
   * only its left/top is written.
   */
  function reposition(itemId) {
    const layer = layers.get(itemId)
    if (!layer) return
    const { seq } = ctx()
    if (!seq) return
    const { zIndex, visibility, display } = layer.el.style

    // Resolved to the instant on the way in, so a keyed layer restyles to where
    // it is *now* rather than to where it starts.
    const item = anyKeyed(layer.item) ? resolveAt(layer.item, time) : layer.item
    if (layer.kind === 'overlay' && layer.clip) styleOverlay(layer.el, item, layer.clip, seq)
    else if (layer.kind === 'video') styleVideo(layer.el, item, ctx().media.get(item.sourceId), seq)
    else if (layer.kind === 'timeline') {
      const child = ctx().timelines?.get(item.sourceId)
      if (child) styleNested(layer.el, item, child, seq)
    } else return

    layer.el.style.zIndex = zIndex
    layer.el.style.visibility = visibility
    if (layer.kind === 'video') layer.el.style.display = display
    if (layer.kind !== 'video') layer.el.style.opacity = String(layer.visible === false ? 0 : (layer.item.opacity ?? 1))
  }

  /**
   * Draw one layer through an extra transform, for the length of a drag.
   *
   * Resizing changes the size the clip is *compiled* at, and recompiling an
   * iframe per pointer event is both slow and visibly flickery. So the drag
   * paints a transform of what is already on screen and the real size is
   * written once, on release. Pass null to put the layer back.
   */
  function previewTransform(itemId, t) {
    const layer = layers.get(itemId)
    if (!layer || layer.kind === 'audio') return
    if (!t) {
      layer.el.style.transform = ''
      if (layer.kind === 'timeline') reposition(itemId)
      return
    }
    // A nested block already carries the scale that fits it into the frame.
    let [bx, by] = (layer.el.dataset.baseScale ?? '1,1').split(',').map(Number)
    if (layer.kind !== 'timeline') bx = by = 1
    // A turn is previewed about the middle of the layer, which is the point the
    // clip itself turns about; everything else works from its top-left corner.
    layer.el.style.transformOrigin = t.rot ? '50% 50%' : '0 0'
    layer.el.style.transform =
      (t.rot ? `rotate(${t.rot}deg) ` : '') +
      `translate(${t.tx}px, ${t.ty}px) scale(${bx * t.sx}, ${by * t.sy})`
  }

  /**
   * Where an item is on screen, in frame pixels — and, for an overlay that is
   * currently mounted, where its *ink* is rather than where its frame is.
   *
   * A title is a clip the size of the whole frame with a line of type in the
   * middle; a rectangle drawn round the frame is not something anyone can grab,
   * and it would swallow every click meant for the footage underneath.
   */
  function boxOf(itemId) {
    const layer = layers.get(itemId)
    const { seq } = ctx()
    if (!layer || !seq || layer.kind === 'audio') return null
    const box = boxIn(layer.item, seq)
    if (!box) return null
    if (layer.kind !== 'overlay' || !layer.mounted || !layer.clip) return { ...box, painted: false }
    let ink = null
    try {
      const doc = layer.el.contentDocument
      // Straight: the ink as it would be if the layer were upright, so a handle
      // lands on a corner of the thing rather than on the box around it.
      if (doc?.body) ink = paintedBounds(doc, layer.clip, { straight: true })
    } catch {
      /* a frame mid-reload measures as nothing, which is what null means */
    }
    if (!ink || ink.w < 2 || ink.h < 2) return { ...box, painted: false }
    return {
      x: box.x + ink.x, y: box.y + ink.y, w: ink.w, h: ink.h, sx: 1, sy: 1,
      // The turn is about the middle of the clip's frame, not of its ink.
      rotation: box.rotation ?? 0,
      pivotX: box.pivotX,
      pivotY: box.pivotY,
      // "Fills the frame" decides what a click lands on, so it has to describe
      // the ink: a full-bleed image swallows clicks, a title over it does not.
      fills: ink.w >= seq.width * 0.98 && ink.h >= seq.height * 0.98,
      painted: true,
      frame: box,
    }
  }

  return {
    rebuild,
    invalidateOverlays,
    snapshot,
    seekTo,
    reposition,
    previewTransform,
    boxOf,
    play,
    pause,
    toggle: () => (playing ? pause() : play()),
    get playing() {
      return playing
    },
    get time() {
      return time
    },
    drive,
    settle,
    /** Playback health since play() was last pressed. */
    getStats() {
      const elapsed = Math.max(1, (playing ? performance.now() : stats.lastTick || performance.now()) - stats.since)
      let mounted = 0, media = 0, overlays = 0
      for (const l of layers.values()) {
        if (l.kind === 'overlay') { overlays++; if (l.mounted) mounted++ }
        else if (l.kind === 'video' || l.kind === 'audio') media++
      }
      return {
        playing,
        fps: Math.round((stats.frames / elapsed) * 1000),
        seconds: Math.round(elapsed / 100) / 10,
        seeks: stats.seeks,
        nudges: stats.nudges,
        resyncs: stats.resyncs,
        worstGapMs: Math.round(stats.worstGapMs),
        overlays,
        mounted,
        media,
        master: master ? master.item.name || master.item.type : null,
      }
    },
    dispose() {
      disposed = true
      pause()
      for (const layer of layers.values()) removeLayer(layer)
      layers.clear()
    },
  }
}
