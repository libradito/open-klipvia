/**
 * The sequence model: tracks against time.
 *
 * Tracks are held in **display order, top to bottom** — video tracks first,
 * audio after. Compositing runs the other way, so the last video track is the
 * bottom layer. The preview's z-index and the render's overlay order both come
 * from that single rule, which is why they cannot disagree.
 *
 * One invariant is enforced everywhere: **items on a track never overlap.**
 * Dropping an item over its neighbours trims or removes them, the way an
 * overwrite edit does. Without that, "which of these two clips is on screen at
 * 4.2 seconds" would have no answer the renderer and the preview both agree on.
 */

import { textClip, textPreset } from '/textpresets.js'
import {
  colourOf, cropOf, decorCss, radiusOf, rotationOf, shadowOf, shadowPad,
} from '/effects.js'
import { anyKeyed, keysFor, peakOf, resolveAt } from '/keys.js'

export const ITEM_DEFAULTS = {
  fit: 'contain',
  anchor: 'center',
  offsetX: 0,
  offsetY: 0,
  opacity: 1,
  volume: 1,
  muted: false,
  fadeInMs: 0,
  fadeOutMs: 0,
}

const uid = (p) => p + Math.random().toString(36).slice(2, 10)

/* ------------------------------------------------------------------ queries */

export const videoTracks = (seq) => seq.tracks.filter((t) => t.kind === 'video')
export const audioTracks = (seq) => seq.tracks.filter((t) => t.kind === 'audio')

/** Bottom layer first — the order the compositor stacks them in. */
export const compositeOrder = (seq) => videoTracks(seq).slice().reverse()

export function* allItems(seq) {
  for (const track of seq.tracks) for (const item of track.items) yield { track, item }
}

export function findItem(seq, id) {
  for (const { track, item } of allItems(seq)) if (item.id === id) return { track, item }
  return null
}

export function sequenceDuration(seq) {
  let end = 0
  for (const { item } of allItems(seq)) end = Math.max(end, item.startMs + item.durationMs)
  return Math.round(end)
}

/** The item under the playhead on a given track, if any. */
export function itemAt(track, ms) {
  return track.items.find((i) => ms >= i.startMs && ms < i.startMs + i.durationMs) ?? null
}

export const itemEnd = (item) => item.startMs + item.durationMs

/**
 * Where in its source an item is at sequence time `t`.
 *
 * Media and animation items carry an in-point. A caption item does not need
 * one here: the clip it compiles to is already generated relative to its own
 * in-point, so its local clock starts at zero.
 */
export function sourceTimeAt(item, t) {
  const local = (t - item.startMs) * speedOf(item)
  return item.type === 'caption' ? local : item.inMs + local
}

/**
 * How fast an item plays its source, against the timeline's own clock.
 *
 * Only the three kinds that *have* a source clock: footage, a nested block, and
 * an animation clip. A caption's times come from its transcript and a title's
 * from its own length, so speeding either would mean re-timing the words —
 * a different job, and not one a number on the item can do honestly.
 */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 8
export function speedOf(item) {
  if (item?.type !== 'media' && item?.type !== 'timeline' && item?.type !== 'animation') return 1
  const s = Number(item.speed)
  return Number.isFinite(s) && s > 0 ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, s)) : 1
}
/** How much of the source an item consumes, in the source's own milliseconds. */
export const sourceSpanOf = (item) => item.durationMs * speedOf(item)

/* ----------------------------------------------------------------- creation */

export function makeMediaItem(media, { startMs = 0, durationMs = null, inMs = 0 } = {}) {
  return {
    ...ITEM_DEFAULTS,
    id: uid('i_'),
    type: 'media',
    sourceId: media.filename,
    name: media.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(40, Math.round(durationMs ?? media.durationMs)),
    inMs: Math.max(0, Math.round(inMs)),
    // Footage that does not match the sequence aspect is letterboxed rather
    // than silently cropped; cropping is a choice, not a default.
    fit: media.kind === 'video' ? 'contain' : 'none',
  }
}

export function makeAnimationItem(clip, { startMs = 0, durationMs = null } = {}) {
  return {
    ...ITEM_DEFAULTS,
    id: uid('i_'),
    type: 'animation',
    sourceId: clip.id,
    name: clip.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(40, Math.round(durationMs ?? clip.durationMs)),
    inMs: 0,
    fit: 'none',
  }
}

export function defaultCaptionStyle() {
  return {
    fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
    fontSize: 54,
    color: '#ffffff',
    weight: 700,
    boxColor: '#000000a6',
    position: 'bottom',
    marginPx: 96,
    maxWidthPct: 80,
    uppercase: false,
    shadow: true,
    transition: 'cut',
    karaoke: 'off',
    accent: '#ffd166',
  }
}

export function makeCaptionItem(transcript, { startMs = 0, durationMs = null, inMs = 0 } = {}) {
  return {
    ...ITEM_DEFAULTS,
    id: uid('i_'),
    type: 'caption',
    sourceId: transcript.id,
    name: transcript.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(40, Math.round(durationMs ?? transcript.durationMs ?? 5000)),
    inMs: Math.max(0, Math.round(inMs)),
    fit: 'none',
    captionStyle: defaultCaptionStyle(),
  }
}

/** A typed title, drawn by a preset. Lives on a video track like any overlay. */
/* ------------------------------------------------------- nested timelines */

/** How deep sections may nest. Deeper than this is a mistake, not a design. */
export const MAX_NESTING = 8

/** Timelines arrive as a Map or an array; both are fine. */
export function timelineOf(timelines, id) {
  if (!timelines) return null
  if (typeof timelines.get === 'function') return timelines.get(id) ?? null
  return timelines.find?.((t) => t.id === id) ?? null
}

/**
 * A block that plays another timeline, with the in-point semantics of
 * footage: `inMs` into the child's content, `durationMs` long. It fits into
 * the parent frame like a video does, letterboxed rather than cropped.
 */
export function makeTimelineItem(child, { startMs = 0, durationMs = null, inMs = 0 } = {}) {
  const content = sequenceDuration(child)
  return {
    ...ITEM_DEFAULTS,
    id: uid('i_'),
    type: 'timeline',
    sourceId: child.id,
    name: child.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(40, Math.round(durationMs ?? Math.max(content - inMs, 40))),
    inMs: Math.max(0, Math.round(inMs)),
    fit: 'contain',
  }
}

/** Ids of every timeline reachable from `id` through nested blocks, `id` excluded. */
export function nestedTimelineIds(timelines, id) {
  const out = new Set()
  const stack = [id]
  while (stack.length) {
    const cur = timelineOf(timelines, stack.pop())
    if (!cur) continue
    for (const track of cur.tracks) {
      for (const item of track.items) {
        if (item.type !== 'timeline' || out.has(item.sourceId)) continue
        out.add(item.sourceId)
        stack.push(item.sourceId)
      }
    }
  }
  return out
}

/** Would placing `childId` inside `parentId` make a loop? */
export function wouldCycle(timelines, parentId, childId) {
  if (parentId === childId) return true
  return nestedTimelineIds(timelines, childId).has(parentId)
}

/** Longest chain of blocks below `id` (0 for a timeline that nests nothing). */
export function nestingDepth(timelines, id, seen = new Set()) {
  if (seen.has(id)) return 0
  const t = timelineOf(timelines, id)
  if (!t) return 0
  const next = new Set(seen).add(id)
  let deepest = 0
  for (const track of t.tracks) {
    for (const item of track.items) {
      if (item.type === 'timeline') deepest = Math.max(deepest, 1 + nestingDepth(timelines, item.sourceId, next))
    }
  }
  return deepest
}

/**
 * What grouping these items would do, checked before anything is created:
 * the members, and the span they cover. A member on a locked track refuses
 * the whole group — a partial one would surprise.
 */
export function nestPlan(parent, itemIds) {
  const members = []
  for (const id of new Set(itemIds)) {
    const found = findItem(parent, id)
    if (!found) throw new Error(`no item "${id}"`)
    if (found.track.locked) throw new Error(`track ${found.track.name} is locked`)
    members.push(found)
  }
  if (!members.length) throw new Error('nothing to group')
  const start = Math.min(...members.map((m) => m.item.startMs))
  const end = Math.max(...members.map((m) => itemEnd(m.item)))
  return { members, start, end }
}

/**
 * Move items out of `parent` into `child` (an empty timeline with the
 * parent's frame) and leave one block in their place.
 *
 * The child gets one track per parent track that held a member — same kind,
 * name and colour, same order — and the members keep their layout, re-based
 * so the span starts at zero. The block covers the span on the lowest video
 * track among the members (an audio track if every member is sound). If
 * something that is not a member still overlaps there, the block goes on a
 * new track above it: nothing is ever overwritten.
 */
export function nestItems(parent, child, itemIds) {
  const { members, start, end } = nestPlan(parent, itemIds)
  const memberTracks = new Set(members.map((m) => m.track))

  for (const track of parent.tracks) {
    if (!memberTracks.has(track)) continue
    const ct = makeTrack(track.kind, track.name)
    if (track.color) ct.color = track.color
    if (track.note) ct.note = track.note
    for (const m of members) {
      if (m.track !== track) continue
      removeItem(parent, m.item.id)
      m.item.startMs -= start
      ct.items.push(m.item)
    }
    sortTrack(ct)
    child.tracks.push(ct)
  }

  const block = makeTimelineItem(child, { startMs: start, durationMs: end - start, inMs: 0 })
  let target = [...videoTracks(parent)].reverse().find((t) => memberTracks.has(t)) ?? [...memberTracks][0]
  if (!trackIsFree(target, start, end)) {
    const n = target.kind === 'video' ? videoTracks(parent).length + 1 : audioTracks(parent).length + 1
    const made = makeTrack(target.kind, `${target.kind === 'video' ? 'V' : 'A'}${n}`)
    parent.tracks.splice(parent.tracks.indexOf(target), 0, made)
    target = made
  }
  placeItem(target, block)
  return { block, track: target, members: members.length, start, end }
}

/**
 * Replace a block with what is inside it. The block goes first, so its own
 * track is free again; the child's items then land on parent tracks of the
 * same kind and name where the window is free, or on new tracks — never on
 * top of something else. Items are clipped to the block's window exactly as
 * a render clips them (in-points advanced), their volume and opacity scaled
 * by the block's. The block's fades have nowhere to go and are dropped. The
 * child timeline itself is untouched.
 */
export function flattenItem(parent, child, blockId) {
  const found = findItem(parent, blockId)
  if (!found || found.item.type !== 'timeline') throw new Error(`"${blockId}" is not a timeline block`)
  const { item: block, track: blockTrack } = found
  if (blockTrack.locked) throw new Error(`track ${blockTrack.name} is locked`)

  removeItem(parent, block.id)
  const winFrom = block.inMs
  const winTo = block.inMs + block.durationMs
  const placed = []
  const dropped = []
  let insertAt = parent.tracks.indexOf(blockTrack)
  const madeTracks = new Map()

  for (const ct of child.tracks) {
    for (const src of ct.items) {
      const s = src.startMs
      const e = itemEnd(src)
      if (e <= winFrom || s >= winTo) {
        dropped.push(src.id)
        continue
      }
      const headCut = Math.max(0, winFrom - s)
      const tailCut = Math.max(0, e - winTo)
      const copy = {
        ...src,
        id: uid('i_'),
        startMs: block.startMs + (s + headCut - winFrom),
        durationMs: src.durationMs - headCut - tailCut,
        inMs: (src.inMs ?? 0) + headCut,
        opacity: (src.opacity ?? 1) * (block.opacity ?? 1),
        volume: (src.volume ?? 1) * (block.volume ?? 1),
        muted: !!(src.muted || block.muted),
      }
      if (src.textStyle) copy.textStyle = { ...src.textStyle }
      if (src.captionStyle) copy.captionStyle = { ...src.captionStyle }

      let target =
        parent.tracks.find((t) => t.kind === ct.kind && t.name === ct.name && trackIsFree(t, copy.startMs, itemEnd(copy))) ??
        (madeTracks.get(ct) && trackIsFree(madeTracks.get(ct), copy.startMs, itemEnd(copy)) ? madeTracks.get(ct) : null)
      if (!target) {
        target = makeTrack(ct.kind, ct.name)
        if (ct.color) target.color = ct.color
        if (ct.kind === 'video') parent.tracks.splice(insertAt++, 0, target)
        else parent.tracks.push(target)
        madeTracks.set(ct, target)
      }
      placeItem(target, copy)
      placed.push(copy)
    }
  }
  return { placed, dropped, fadesDropped: !!(block.fadeInMs || block.fadeOutMs), block }
}

/** Every parent that nests `id`, directly. */
export function parentsOf(timelines, id) {
  const list = typeof timelines.values === 'function' && !Array.isArray(timelines) ? [...timelines.values()] : timelines
  return list.filter((t) => t.id !== id && t.tracks.some((tr) => tr.items.some((i) => i.type === 'timeline' && i.sourceId === id)))
}

export function makeTextItem(presetId, { text = '', subtext = '', startMs = 0, durationMs = null } = {}) {
  const preset = textPreset(presetId)
  if (!preset) throw new Error(`unknown text preset "${presetId}"`)
  return {
    ...ITEM_DEFAULTS,
    id: uid('i_'),
    type: 'text',
    sourceId: preset.id,
    name: String(text).trim().slice(0, 40) || preset.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(40, Math.round(durationMs ?? preset.defaultDurationMs)),
    inMs: 0,
    fit: 'none',
    text: String(text),
    subtext: String(subtext),
    textStyle: {},
  }
}

/**
 * The same clip, laid out at its own size but *drawn* turned, mirrored, tinted
 * and k times as large.
 *
 * Not a scaled-up picture: the document keeps its native layout and the browser
 * paints it through one transform, so type stays type and a hairline stays a
 * hairline at 300%, at any angle. Because an overlay is rendered by a browser
 * both for the preview and for the file, everything here costs nothing and — far
 * more valuable — cannot possibly disagree between the two. The clip's declared
 * size is the final size, which is all the compositor, the rasterizer and the
 * filtergraph ever look at.
 */
export function decoratedClip(clip, item) {
  if (!clip) return null
  const colour = colourOf(item)
  const radius = radiusOf(item)
  const shadow = shadowOf(item)
  // A keyframed size is baked at its *peak*, and every other moment scales down
  // from there. Scaling a rendered picture down is free; scaling it up is not,
  // and a logo that pops in would be soft for exactly the frames you look at.
  const zoom = bakedScale(item)
  const d = decorCss({
    baseWidth: clip.width,
    baseHeight: clip.height,
    zoom,
    rotation: rotationOf(item),
    flipH: !!item?.flipH,
    flipV: !!item?.flipV,
    pad: shadowPad(shadow),
  })
  if (d.plain && !colour && !radius && !shadow) return clip
  return {
    ...clip,
    width: d.outW,
    height: d.outH,
    baseWidth: clip.width,
    baseHeight: clip.height,
    bakedScale: zoom,
    decor: {
      transform: d.transform,
      // Transparent margin the turn and the shadow added, per side. An anchor
      // names the *picture*, so this has to be discounted from the placement —
      // here and in the filtergraph — or a corner-anchored title would slide
      // sideways the moment you turned it.
      padX: (d.outW - clip.width * zoom) / 2,
      padY: (d.outH - clip.height * zoom) / 2,
      // The same frame with the turn taken out, so the handles can measure what
      // the layer would be if it were straight and draw a turned box round it.
      plainTransform: decorCss({
        baseWidth: clip.width, baseHeight: clip.height, zoom,
        rotation: 0, flipH: false, flipV: false, pad: shadowPad(shadow),
      }).transform,
      rotation: rotationOf(item),
      colour,
      radius,
      shadow,
    },
  }
}

/** A still from the asset library, held for the item's length. */
export function makeImageItem(asset, { startMs = 0, durationMs = null } = {}) {
  return {
    ...ITEM_DEFAULTS,
    id: uid('i_'),
    type: 'image',
    sourceId: asset.filename,
    name: String(asset.name ?? asset.filename).replace(/\.[a-z0-9]+$/i, '').slice(0, 40),
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(40, Math.round(durationMs ?? IMAGE_DEFAULT_MS)),
    inMs: 0,
    fit: 'contain',
    imageStyle: {},
  }
}

export const IMAGE_DEFAULT_MS = 5000

const evenPx = (n, lo, hi) => Math.max(lo, Math.min(hi, 2 * Math.round((Number(n) || 0) / 2)))

/**
 * The clip an image item compiles to: one <img> filling a clip the size of the
 * picture — its natural size, shrunk to fit the frame, unless the item says
 * otherwise — so anchor and offsets place it like any overlay. Static, so the
 * same frame every time; the renderer treats it like any other overlay.
 */
export function imageClip(item, asset, seq) {
  const st = item.imageStyle ?? {}
  let w = Number(st.width) || 0
  let h = Number(st.height) || 0
  const nw = Number(asset?.width) || 0
  const nh = Number(asset?.height) || 0
  if (!w && !h) {
    if (nw && nh) {
      const k = Math.min(1, seq.width / nw, seq.height / nh)
      w = nw * k
      h = nh * k
    } else {
      w = Math.round(seq.width * 0.4)
      h = Math.round(w * 0.75)
    }
  } else if (!h) h = nw && nh ? (w * nh) / nw : w * 0.75
  else if (!w) w = nw && nh ? (h * nw) / nh : h * 1.333
  const width = evenPx(w, 4, 8192)
  const height = evenPx(h, 4, 8192)
  const fit = ['contain', 'cover', 'fill', 'none'].includes(item.fit) ? item.fit : 'contain'
  const radius = Math.max(0, Math.round(Number(st.radius) || 0))
  const totalMs = Math.max(40, Math.round((item.inMs ?? 0) + item.durationMs))
  return {
    id: item.id,
    name: item.name || asset?.name || 'Image',
    html: `<img class="i" src="${asset?.url ?? ''}" alt="">`,
    css: [
      '* { margin:0; box-sizing:border-box; }',
      `.i { position:absolute; inset:0; width:100%; height:100%; object-fit:${fit}; object-position:center;`,
      `  border-radius:${radius}px; display:block;` + (st.shadow ? ' filter:drop-shadow(0 18px 40px rgba(0,0,0,.45));' : ''),
      '}',
    ].join('\n'),
    js: '',
    width,
    height,
    fps: seq.fps,
    durationMs: totalMs,
    background: { mode: 'transparent', color: '#000000' },
    empty: !asset,
    static: true,
  }
}

/**
 * Reorder a track among those of its kind. `to` is 'up', 'down', 'top',
 * 'bottom', or a position counted from the top within that kind (0 = the
 * topmost video track, or the topmost audio track). Video tracks always stay
 * above audio tracks: the list is normalised to that order on the way out.
 * Order is stacking order — the top track draws over everything beneath it —
 * in the preview and in the render alike.
 */
export function moveTrack(seq, trackId, to) {
  const track = seq.tracks.find((t) => t.id === trackId)
  if (!track) throw new Error(`no track "${trackId}"`)
  const same = seq.tracks.filter((t) => t.kind === track.kind)
  const others = seq.tracks.filter((t) => t.kind !== track.kind)
  const from = same.indexOf(track)
  let target =
    to === 'up' ? from - 1
    : to === 'down' ? from + 1
    : to === 'top' ? 0
    : to === 'bottom' ? same.length - 1
    : Math.round(Number(to))
  if (!Number.isFinite(target)) throw new Error('to must be up, down, top, bottom or a position from the top')
  target = Math.max(0, Math.min(same.length - 1, target))
  const moved = target !== from
  if (moved) {
    same.splice(from, 1)
    same.splice(target, 0, track)
  }
  seq.tracks = track.kind === 'video' ? [...same, ...others] : [...others, ...same]
  return { moved, from, index: target, of: same.length }
}

/**
 * A cue with new words. When the new text has exactly as many words as the
 * old timings, each word keeps its time — fixing "Exel" to "Excel" does not
 * lose karaoke. Otherwise the timings are dropped, because they would lie.
 */
export function rewordCue(cue, text) {
  const next = { ...cue, text: String(text) }
  const tokens = next.text.split(/\s+/).filter(Boolean)
  if (cue.words?.length === tokens.length && tokens.length > 0) {
    next.words = cue.words.map((w, i) => ({ ...w, text: tokens[i] }))
  } else {
    delete next.words
  }
  return next
}

export function makeTrack(kind, name) {
  return { id: uid('t_'), kind, name, items: [], muted: false, hidden: false, locked: false }
}

/* ------------------------------------------------------------------ rooms */

/** Is this stretch of track empty? */
export function trackIsFree(track, from, to) {
  return !track.items.some((i) => i.startMs < to && i.startMs + i.durationMs > from)
}

/** An unlocked audio track with room here, or a new one below the others. */
export function freeAudioTrack(seq, from, to) {
  const audio = audioTracks(seq)
  const free = audio.find((t) => !t.locked && trackIsFree(t, from, to))
  if (free) return free
  const made = makeTrack('audio', `A${audio.length + 1}`)
  seq.tracks.push(made)
  return made
}

/**
 * Separate an item's sound from its picture.
 *
 * The picture stays where it is, muted; its sound becomes an item of its own
 * on an audio track — same file, same in-point, same length — so either can
 * be trimmed, moved, replaced or silenced without the other. Audio-only is
 * simply a media item on an audio track; video-only is a muted one on a
 * video track. Nothing new in the model.
 */
export function detachAudio(seq, itemId, media) {
  const found = findItem(seq, itemId)
  if (!found) throw new Error(`no item "${itemId}"`)
  const { track, item } = found
  if (item.type !== 'media') throw new Error('only footage has sound to detach')
  if (track.kind !== 'video') throw new Error(`${item.name} is already sound only`)
  if (!media?.hasAudio) throw new Error(`${item.name} has no sound`)
  if (!media.hasVideo) throw new Error(`${item.name} is sound only already`)

  const audio = makeMediaItem(media, { startMs: item.startMs, durationMs: item.durationMs, inMs: item.inMs })
  audio.name = `${item.name} · audio`
  audio.fit = 'none'
  audio.volume = item.volume ?? 1
  audio.fadeInMs = item.fadeInMs ?? 0
  audio.fadeOutMs = item.fadeOutMs ?? 0
  audio.muted = !!item.muted
  audio.note = `sound of ${item.id}`

  const target = freeAudioTrack(seq, audio.startMs, audio.startMs + audio.durationMs)
  placeItem(target, audio)
  item.muted = true
  item.fadeInMs = 0
  item.fadeOutMs = 0
  return { audio, track: target }
}

/* ------------------------------------------------------------------- edits */

const sortTrack = (track) => track.items.sort((a, b) => a.startMs - b.startMs)

/**
 * Overwrite-place an item: whatever it lands on is trimmed out of its way, and
 * anything it fully covers is removed.
 */
export function placeItem(track, item) {
  const from = item.startMs
  const to = itemEnd(item)
  const kept = []

  for (const other of track.items) {
    if (other.id === item.id) continue
    const oFrom = other.startMs
    const oTo = itemEnd(other)

    if (oTo <= from || oFrom >= to) {
      kept.push(other)
      continue
    }
    // Fully covered — gone.
    if (oFrom >= from && oTo <= to) continue

    // Split in two: the new item lands in the middle of an existing one.
    if (oFrom < from && oTo > to) {
      const tail = { ...other, id: uid('i_') }
      tail.inMs = other.inMs + (to - oFrom)
      tail.startMs = to
      tail.durationMs = oTo - to
      other.durationMs = from - oFrom
      kept.push(other, tail)
      continue
    }
    // Overlapped at the head: push its in-point forward.
    if (oFrom < from) {
      other.durationMs = from - oFrom
      kept.push(other)
      continue
    }
    // Overlapped at the tail.
    const trimmed = to - oFrom
    other.inMs += trimmed
    other.startMs = to
    other.durationMs = oTo - to
    kept.push(other)
  }

  kept.push(item)
  track.items = kept
  sortTrack(track)
  return item
}

export function removeItem(seq, itemId) {
  for (const track of seq.tracks) {
    const i = track.items.findIndex((x) => x.id === itemId)
    if (i >= 0) {
      const [gone] = track.items.splice(i, 1)
      return gone
    }
  }
  return null
}

/** Move an item, optionally to another track of the same kind. */
export function moveItem(seq, itemId, { startMs, trackId }) {
  const found = findItem(seq, itemId)
  if (!found) return null
  const { track, item } = found

  const target = trackId ? seq.tracks.find((t) => t.id === trackId) : track
  if (!target || target.kind !== track.kind) return null

  item.startMs = Math.max(0, Math.round(startMs))
  if (target !== track) {
    track.items = track.items.filter((x) => x.id !== itemId)
  }
  placeItem(target, item)
  return item
}

/**
 * Move several items together by the same amount.
 *
 * Every member leaves its track before any is placed back: placing them one
 * at a time would let the first landing trim the head of a neighbour that is
 * itself about to move. Tracks never change in a group move.
 */
export function moveItems(seq, ids, deltaMs) {
  const wanted = new Set(ids)
  const members = []
  for (const track of seq.tracks) {
    if (track.locked) continue
    for (const item of track.items) if (wanted.has(item.id)) members.push({ track, item })
  }
  if (!members.length) return 0
  const minStart = Math.min(...members.map((m) => m.item.startMs))
  const delta = Math.max(-minStart, Math.round(deltaMs))
  if (!delta) return 0
  for (const { track, item } of members) track.items = track.items.filter((x) => x.id !== item.id)
  members.sort((a, b) => a.item.startMs - b.item.startMs)
  for (const { track, item } of members) {
    item.startMs += delta
    placeItem(track, item)
  }
  return members.length
}

/**
 * Trim one edge. Dragging the head moves the in-point with it, so the frame
 * under the cursor stays the frame under the cursor.
 */
export function trimItem(seq, itemId, edge, ms, limits = {}) {
  const found = findItem(seq, itemId)
  if (!found) return null
  const { item } = found
  const MIN = 40

  if (edge === 'start') {
    const maxStart = itemEnd(item) - MIN
    let next = Math.min(Math.max(0, Math.round(ms)), maxStart)
    const delta = next - item.startMs
    // Nothing can be trimmed back past the head of its source.
    if (item.inMs + delta < 0) next = item.startMs - item.inMs
    const applied = next - item.startMs
    item.startMs = next
    item.durationMs -= applied
    // Trimming the head skips frames, for every kind of item. Delaying an
    // animation is a move, not a trim.
    item.inMs = Math.max(0, item.inMs + applied)
  } else {
    let dur = Math.max(MIN, Math.round(ms) - item.startMs)
    const sourceLeft = limits.sourceDurationMs != null ? limits.sourceDurationMs - item.inMs : null
    // A media item cannot run past the end of its file; an animation cannot run
    // past its own last frame, because there is nothing after it to show.
    if (sourceLeft != null) dur = Math.min(dur, Math.max(MIN, sourceLeft))
    item.durationMs = dur
  }
  return item
}

/** Cut an item in two at an absolute sequence time. */
export function splitItem(seq, itemId, atMs) {
  const found = findItem(seq, itemId)
  if (!found) return null
  const { track, item } = found
  if (atMs <= item.startMs + 20 || atMs >= itemEnd(item) - 20) return null

  const offset = atMs - item.startMs
  const tail = { ...item, id: uid('i_') }
  if (item.captionStyle) tail.captionStyle = { ...item.captionStyle }
  if (item.textStyle) tail.textStyle = { ...item.textStyle }
  tail.startMs = atMs
  tail.durationMs = item.durationMs - offset
  // A sped-up item has run further into its source than the cut is along the
  // timeline, so the in-point advances by the source time, not the wall time.
  tail.inMs = Math.round(item.inMs + offset * speedOf(item))

  item.durationMs = offset
  track.items.push(tail)
  sortTrack(track)
  return tail
}

/** Close the gap left behind, pulling everything after it back on that track. */
export function rippleDelete(seq, itemId) {
  const found = findItem(seq, itemId)
  if (!found) return null
  const { track, item } = found
  const gap = item.durationMs
  const from = item.startMs

  track.items = track.items.filter((x) => x.id !== itemId)
  for (const other of track.items) {
    if (other.startMs >= from) other.startMs = Math.max(0, other.startMs - gap)
  }
  sortTrack(track)
  return item
}

/* ---------------------------------------------------------------- silence */

export const SILENCE_DEFAULTS = { thresholdDb: -40, minMs: 500, keepMs: 150 }

/**
 * Find the silent stretches in a waveform.
 *
 * Works on the peaks the server computed on import — one max-amplitude value
 * per 20 ms — so the threshold can be dragged and the bands redraw live,
 * without a round trip. That is the same test ffmpeg's `silencedetect` runs,
 * at a granularity of under a frame.
 *
 * `keepMs` is shaved off each end of every gap, so a cut lands a breath after
 * the last word rather than on top of it.
 */
export function detectSilence(peaksData, opts = {}) {
  const { thresholdDb, minMs, keepMs } = { ...SILENCE_DEFAULTS, ...opts }
  if (!peaksData?.peaks?.length) return []

  const { peaks, peaksPerSecond } = peaksData
  const bucketMs = 1000 / peaksPerSecond
  const threshold = Math.pow(10, thresholdDb / 20) * 255

  const raw = []
  let start = -1
  for (let i = 0; i <= peaks.length; i++) {
    const quiet = i < peaks.length && peaks[i] <= threshold
    if (quiet && start < 0) start = i
    if (!quiet && start >= 0) {
      raw.push({ startMs: start * bucketMs, endMs: i * bucketMs })
      start = -1
    }
  }

  const out = []
  for (const r of raw) {
    if (r.endMs - r.startMs < minMs) continue
    const startMs = Math.round(r.startMs + keepMs)
    const endMs = Math.round(r.endMs - keepMs)
    if (endMs - startMs >= 60) out.push({ startMs, endMs })
  }
  return out
}

/** The gaps that fall inside an item, as sequence-time ranges. */
export function silenceInItem(item, sourceRanges) {
  const from = item.inMs
  const to = item.inMs + item.durationMs
  const out = []
  for (const r of sourceRanges) {
    if (r.endMs <= from || r.startMs >= to) continue
    out.push({
      startMs: item.startMs + Math.max(r.startMs, from) - from,
      endMs: item.startMs + Math.min(r.endMs, to) - from,
    })
  }
  return out
}

/** Merge overlapping or touching ranges and sort them. */
export function normaliseRanges(ranges) {
  const sorted = ranges
    .map((r) => ({ startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs)
    else out.push({ ...r })
  }
  return out
}

/**
 * Remove stretches of time from the sequence.
 *
 * This is the ripple edit: every unlocked track loses those seconds, whatever
 * is on it. An item that spans a range is cut in two and the tail advances its
 * in-point, so the footage stays continuous minus the removed part; anything
 * after a range slides back to close the gap. Captions on the same footage cut
 * identically, because their in-point is that footage's time.
 *
 * Lock a track — a music bed, say — to leave it untouched.
 */
export function removeTimeRanges(seq, ranges, { skipLocked = true } = {}) {
  const cuts = normaliseRanges(ranges)
  const stats = { removedMs: 0, split: 0, removed: 0, shifted: 0 }

  // Last range first, so earlier ranges are still where they were measured.
  for (let k = cuts.length - 1; k >= 0; k--) {
    const { startMs: a, endMs: b } = cuts[k]
    const gap = b - a
    stats.removedMs += gap

    for (const track of seq.tracks) {
      if (skipLocked && track.locked) continue
      const next = []
      for (const item of track.items) {
        const s = item.startMs
        const e = itemEnd(item)

        if (e <= a) {
          next.push(item)
        } else if (s >= b) {
          item.startMs = s - gap
          stats.shifted++
          next.push(item)
        } else if (s < a && e > b) {
          const tail = { ...item, id: uid('i_') }
          if (item.captionStyle) tail.captionStyle = { ...item.captionStyle }
          if (item.textStyle) tail.textStyle = { ...item.textStyle }
          tail.inMs = item.inMs + (b - s)
          tail.startMs = a
          tail.durationMs = e - b
          item.durationMs = a - s
          next.push(item, tail)
          stats.split++
        } else if (s < a) {
          item.durationMs = a - s
          next.push(item)
        } else if (e > b) {
          item.inMs = item.inMs + (b - s)
          item.startMs = a
          item.durationMs = e - b
          next.push(item)
        } else {
          stats.removed++
        }
      }
      track.items = next.filter((i) => i.durationMs >= 40)
      sortTrack(track)
    }
  }
  return stats
}

/** Cut every item that spans any of these instants, without removing anything. */
export function splitAtTimes(seq, times, { skipLocked = true } = {}) {
  let count = 0
  for (const t of [...new Set(times.map(Math.round))].sort((x, y) => y - x)) {
    for (const track of seq.tracks) {
      if (skipLocked && track.locked) continue
      for (const item of [...track.items]) {
        if (t > item.startMs + 20 && t < itemEnd(item) - 20) {
          if (splitItem(seq, item.id, t)) count++
        }
      }
    }
  }
  return count
}

/* ---------------------------------------------------------------- snapping */

/** Every edge worth landing on: item boundaries, zero, and the playhead. */
export function snapTargets(seq, exceptId, playheadMs) {
  const times = [0]
  if (playheadMs != null) times.push(Math.round(playheadMs))
  for (const { item } of allItems(seq)) {
    if (item.id === exceptId) continue
    times.push(item.startMs, itemEnd(item))
  }
  return [...new Set(times)].sort((a, b) => a - b)
}

export function snap(ms, targets, toleranceMs) {
  let best = null
  let bestDist = toleranceMs
  for (const t of targets) {
    const d = Math.abs(t - ms)
    if (d <= bestDist) {
      bestDist = d
      best = t
    }
  }
  return best ?? ms
}

/* ------------------------------------------------------- captions -> a clip */

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * Compile a transcript into an animation clip.
 *
 * Captions are not a separate rendering path — they *are* a clip, with one
 * absolutely-positioned line per cue and a zero-to-one keyframe that holds it
 * visible for exactly its cue window. That means captions seek, preview and
 * export through the machinery that already exists, and "edit the CSS" is a
 * real answer to "can I restyle them".
 */
export function captionClip(transcript, item, seq) {
  const style = { ...defaultCaptionStyle(), ...(item.captionStyle ?? {}) }
  const from = item.inMs
  const to = item.inMs + item.durationMs

  // Rebase to item-local time, clamp to the item, and cut any cue that runs
  // into its successor — transcripts stored before import normalised them
  // still carry overlaps, and two cues on one spot is the bug this fixes.
  const cues = []
  const inWindow = (transcript.cues ?? [])
    .filter((c) => c.endMs > from && c.startMs < to)
    .sort((a, b) => a.startMs - b.startMs)
  for (const c of inWindow) {
    const startMs = Math.max(0, c.startMs - from)
    const endMs = Math.min(item.durationMs, c.endMs - from)
    const prev = cues[cues.length - 1]
    if (prev && prev.endMs > startMs) prev.endMs = startMs
    if (prev && prev.endMs - prev.startMs < 40) cues.pop()
    if (endMs <= startMs) continue
    cues.push({
      startMs,
      endMs,
      text: c.text,
      words: c.words?.map((w) => ({ startMs: w.startMs - from, endMs: w.endMs - from, text: w.text })),
    })
  }

  const fadeMs = style.transition === 'cut' ? 1 : 120
  const karaoke = style.karaoke && style.karaoke !== 'off'

  const html =
    `<div class="captions">` +
    cues
      .map((c) => {
        const outAt = Math.max(c.startMs, c.endMs - fadeMs)
        // Word delays are item-local: every span exists from the first frame,
        // so its clock starts with the document, not with its cue.
        const body =
          karaoke && c.words?.length
            ? c.words
                .map((w) => {
                  const ws = Math.max(c.startMs, w.startMs)
                  const wd = Math.max(1, Math.min(w.endMs, c.endMs) - ws)
                  return `<span class="w" style="--ws:${Math.round(ws)}ms;--wd:${Math.round(wd)}ms">${esc(w.text)}</span>`
                })
                .join(' ')
            : esc(c.text).replace(/\n/g, '<br>')
        return `<div class="cue" style="--s:${c.startMs}ms;--o:${outAt}ms">${body}</div>`
      })
      .join('') +
    `</div>`

  const placeTf = style.position === 'center' ? 'translate(-50%,-50%)' : 'translateX(-50%)'
  const place =
    style.position === 'top'
      ? `top:${style.marginPx}px;`
      : style.position === 'center'
        ? `top:50%;`
        : `bottom:${style.marginPx}px;`

  const inFrom =
    style.transition === 'pop'
      ? `opacity:0; transform:${placeTf} scale(.92)`
      : `opacity:0; transform:${placeTf}`

  const css = `
.captions { position:absolute; inset:0; }
.cue {
  position:absolute; left:50%; ${place}
  transform:${placeTf};
  max-width:${style.maxWidthPct}%;
  margin:0; padding:.22em .6em;
  font-family:${style.fontFamily};
  font-size:${style.fontSize}px;
  font-weight:${style.weight};
  line-height:1.25;
  color:${style.color};
  background:${style.boxColor};
  border-radius:.16em;
  text-align:center;
  text-wrap:balance;
  white-space:pre-wrap;
  ${style.uppercase ? 'text-transform:uppercase;' : ''}
  ${style.shadow ? 'text-shadow:0 2px 10px rgba(0,0,0,.55);' : ''}

  /* Two animations with absolute lengths, both holding their last frame:
     cue-in lands at the cue's start, cue-out at its end minus the fade, and
     the later one wins while it runs. Longhand, not the shorthand: a var()
     inside the animation shorthand is ambiguous about which time it is. */
  opacity:0;
  animation-name:cue-in, cue-out;
  animation-duration:${fadeMs}ms, ${fadeMs}ms;
  animation-delay:var(--s), var(--o);
  animation-timing-function:ease-out, ease-in;
  animation-fill-mode:forwards, forwards;
}
@keyframes cue-in { from { ${inFrom} } to { opacity:1; transform:${placeTf} } }
@keyframes cue-out { from { opacity:1 } to { opacity:0 } }
${
  karaoke
    ? `.w {
  display:inline-block;
  animation-name:w-on;
  animation-delay:var(--ws);
  animation-duration:${style.karaoke === 'fill' ? '1ms' : 'var(--wd)'};
  animation-timing-function:linear;
  animation-fill-mode:${style.karaoke === 'fill' ? 'forwards' : 'none'};
}
@keyframes w-on { from, to { color:${style.accent}; transform:scale(1.06); } }`
    : ''
}
`.trim()

  return {
    id: item.id,
    name: item.name || 'Captions',
    html,
    css,
    js: '',
    width: seq.width,
    height: seq.height,
    fps: seq.fps,
    durationMs: item.durationMs,
    background: { mode: 'transparent', color: '#000000' },
    cueCount: cues.length,
  }
}

/**
 * The clip an overlay item draws, whichever kind it is.
 * Returns null when the source has gone missing.
 */
export function overlayClipFor(item, { clips, transcripts, seq, assets }) {
  if (item.type === 'animation') {
    const clip = clips.find((c) => c.id === item.sourceId)
    if (!clip) return null
    // Render exactly what the item shows: from zero up to its out-point. An
    // item held past the animation's end shows the held last frame, in the
    // preview and in the file alike.
    // Long enough to cover what the item will consume: at 2× that is twice its
    // length on the timeline. The plan then trims and re-times that same file.
    return decoratedClip({ ...clip, durationMs: Math.max(40, item.inMs + sourceSpanOf(item)) }, item)
  }
  if (item.type === 'caption') {
    const transcript = transcripts.get(item.sourceId)
    if (!transcript) return null
    return decoratedClip(captionClip(transcript, item, seq), item)
  }
  if (item.type === 'text') return decoratedClip(textClip(item, seq), item)
  if (item.type === 'image') {
    const asset = assets?.get?.(item.sourceId)
    if (!asset) return null
    return decoratedClip(imageClip(item, asset, seq), item)
  }
  return null
}

/* --------------------------------------------------------------- placement */

/**
 * Where an overlay sits in the frame.
 *
 * These are the same formulas `src/sequence.ts` writes into the overlay
 * filter's x/y expressions. Preview and render place a graphic by the same
 * arithmetic, so a lower third that sits 40px off the bottom edge in the
 * preview sits 40px off the bottom edge in the file.
 */
export function placementPx(anchor, stageW, stageH, w, h, offsetX = 0, offsetY = 0) {
  const xs = {
    'left': 0, 'top-left': 0, 'bottom-left': 0,
    'right': stageW - w, 'top-right': stageW - w, 'bottom-right': stageW - w,
    'center': (stageW - w) / 2, 'top': (stageW - w) / 2, 'bottom': (stageW - w) / 2,
  }
  const ys = {
    'top': 0, 'top-left': 0, 'top-right': 0,
    'bottom': stageH - h, 'bottom-left': stageH - h, 'bottom-right': stageH - h,
    'center': (stageH - h) / 2, 'left': (stageH - h) / 2, 'right': (stageH - h) / 2,
  }
  return {
    x: Math.round((xs[anchor] ?? (stageW - w) / 2) + (offsetX || 0)),
    y: Math.round((ys[anchor] ?? (stageH - h) / 2) + (offsetY || 0)),
  }
}

/** The anchor's own contribution to a box's position, without the offsets. */
export function anchorPx(anchor, stageW, stageH, w, h) {
  return placementPx(anchor, stageW, stageH, w, h, 0, 0)
}

/**
 * How much bigger than its natural size an item is drawn.
 *
 * Only footage, nested blocks and animation clips use it: an image and a shape
 * carry their own width and height, and a title its own type size, so scaling
 * those would be a second way to say the same thing.
 */
export const SCALE_MIN = 0.05
export const SCALE_MAX = 4
export const scaleOf = (item) => {
  const k = Number(item?.scale)
  return Number.isFinite(k) && k > 0 ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, k)) : 1
}
export const scales = (item) => item?.type === 'media' || item?.type === 'timeline' || item?.type === 'animation'

/**
 * The size an overlay's clip is *rendered* at — its peak, when the size moves.
 * Everything downstream then scales relative to this rather than to 1.
 */
export function bakedScale(item) {
  const keys = keysFor(item, 'scale')
  if (!keys) return scaleOf(item)
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, peakOf(keys, scaleOf(item))))
}

/**
 * Where an item lands in the frame, in timeline pixels.
 *
 * The preview positions elements, the filtergraph writes overlay expressions
 * and the stage handles draw a rectangle — three code paths that must agree to
 * the pixel or dragging a title moves it somewhere the render disagrees about.
 * They agree because they all come back here.
 *
 * `sx`/`sy` are what the preview has to scale the element by to reach that box;
 * for an overlay they are always 1, because an overlay clip is *compiled* at
 * its final size rather than stretched into it.
 */
export function layerBox(rawItem, { seq, clips, transcripts, assets, media, timelines }, atMs = null) {
  if (!seq) return null
  // Resolved to one instant first, so nothing below has to know that some of
  // these numbers move.
  const item = atMs == null ? rawItem : resolveAt(rawItem, atMs)
  const W = seq.width, H = seq.height
  const whole = { x: 0, y: 0, w: W, h: H, sx: 1, sy: 1, fills: true }

  const rotation = rotationOf(item)
  /** Every layer turns about the middle of its own box. */
  const turned = (b) => ({ ...b, rotation, pivotX: b.x + b.w / 2, pivotY: b.y + b.h / 2 })

  /** Footage and nested blocks are a source rectangle fitted into the frame. */
  const fitted = (cw0, ch0) => {
    // Crop first, in the source's own pixels, so the fit sees what is left.
    const crop = cropOf(item)
    const cw = crop ? cw0 * crop.kx : cw0
    const ch = crop ? ch0 * crop.ky : ch0
    if (!cw || !ch) return whole
    const fit = ['fill', 'cover', 'none', 'contain'].includes(item.fit) ? item.fit : 'contain'
    if (fit === 'fill') return { x: 0, y: 0, w: W, h: H, sx: W / cw, sy: H / ch, fills: true }
    if (fit === 'none') {
      const s = scaleOf(item)
      // Down to even pixels, because `scale=trunc(iw*k/2)*2` is what the
      // filtergraph will do and the preview must not be a pixel ahead of it.
      const w = Math.max(2, Math.floor((cw * s) / 2) * 2)
      const h = Math.max(2, Math.floor((ch * s) / 2) * 2)
      const { x, y } = placementPx(item.anchor, W, H, w, h, item.offsetX, item.offsetY)
      return { x, y, w, h, sx: s, sy: s, fills: false }
    }
    const s = fit === 'cover' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch)
    return { x: (W - cw * s) / 2, y: (H - ch * s) / 2, w: cw * s, h: ch * s, sx: s, sy: s, fills: fit === 'cover' }
  }

  if (item.type === 'media') {
    const m = media?.get?.(item.sourceId)
    if (!m?.hasVideo) return null
    return turned(fitted(m.width, m.height))
  }
  if (item.type === 'timeline') {
    const child = timelineOf(timelines, item.sourceId)
    if (!child) return null
    return turned(fitted(child.width, child.height))
  }

  // An overlay's turn is already baked into the clip it compiles to, so the
  // clip's declared size *is* the box on the frame; the angle comes back too,
  // because the handles have to draw a turned rectangle, not the box round it.
  const clip = overlayClipFor(item, { clips, transcripts, seq, assets })
  if (!clip) return null
  // Placed by the size it would be if it were upright, then pulled back by the
  // margin the turn and the shadow added — so "top-left" keeps meaning the
  // top-left of the words, not of the box that now surrounds them.
  // The clip was compiled at its peak size; at this instant it is drawn at a
  // fraction of that, and the whole frame — margin included — shrinks with it.
  const rel = clip.bakedScale ? scaleOf(item) / clip.bakedScale : 1
  const outW = clip.width * rel
  const outH = clip.height * rel
  const k = scaleOf(item)
  const w0 = clip.baseWidth ? clip.baseWidth * k : outW
  const h0 = clip.baseHeight ? clip.baseHeight * k : outH
  const padX = (outW - w0) / 2
  const padY = (outH - h0) / 2
  const { x, y } = placementPx(item.anchor, W, H, w0, h0, item.offsetX, item.offsetY)
  return turned({
    x: x - padX, y: y - padY, w: outW, h: outH, sx: rel, sy: rel,
    padX, padY,
    fills: outW >= W && outH >= H,
  })
}
