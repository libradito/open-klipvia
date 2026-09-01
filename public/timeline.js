/**
 * The sequence timeline.
 *
 * Tracks down, time across. Drag an item to move it, drag its edges to trim,
 * drop media onto a lane to place it. Every edit goes through the model in
 * `sequence.js`, so the overwrite rule that keeps one item per track per
 * instant is enforced in exactly one place.
 *
 * During a drag only the dragged element's own style is touched; the timeline
 * is redrawn once on release. Re-rendering forty items per pointermove is the
 * difference between a timeline that feels attached to the cursor and one that
 * does not.
 */

import {
  itemEnd, moveItem, moveItems, placeItem, removeItem, rippleDelete,
  sequenceDuration, snap, snapTargets, splitItem, trimItem,
} from '/sequence.js'
import { keyTimes } from '/keys.js'
import { setTip } from '/tooltip.js'

const HEAD_W = 146
const EDGE_PX = 9
const SNAP_PX = 8
const MIN_ITEM_PX = 14

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

export function createTimeline({ root, getContext, onChange, onSeek, onSelect, onSelectTrack, onOpen, onContext }) {
  let pxPerMs = 0.06 // ~60px per second
  let playheadMs = 0
  /** Selected item ids; the last one added is the primary the inspector shows. */
  let selectedIds = new Set()
  /** The last item picked by a click — the anchor a shift-click ranges from. */
  let lastPickedId = null
  let drag = null

  const primaryId = () => [...selectedIds].at(-1) ?? null
  /** Selected items as objects, in track order, primary last. */
  const selectedItems = () => {
    const seq = ctx().seq
    if (!seq) return []
    const out = []
    for (const track of seq.tracks) for (const item of track.items) if (selectedIds.has(item.id)) out.push(item)
    const p = primaryId()
    return out.filter((i) => i.id !== p).concat(out.filter((i) => i.id === p))
  }

  const ctx = () => getContext()

  root.classList.add('tl2')
  const body = el('div', 'tl2-body')
  const ruler = el('div', 'tl2-ruler')
  const lanes = el('div', 'tl2-lanes')
  const playhead = el('div', 'tl2-playhead')
  body.append(ruler, lanes, playhead)
  root.appendChild(body)

  const contentWidth = () => {
    const seq = ctx().seq
    const dur = Math.max(sequenceDuration(seq), 10_000)
    return HEAD_W + dur * pxPerMs + 240
  }

  const xToMs = (clientX) => {
    const rect = body.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left - HEAD_W) / pxPerMs)
  }
  const msToX = (ms) => HEAD_W + ms * pxPerMs

  /* ---------------------------------------------------------------- ruler */

  function renderRuler() {
    ruler.innerHTML = ''
    const seq = ctx().seq
    const dur = Math.max(sequenceDuration(seq), 10_000)

    // Pick a tick spacing that never crowds: at least 64px apart.
    const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 300_000]
    const step = steps.find((s) => s * pxPerMs >= 64) ?? steps[steps.length - 1]

    for (let t = 0; t <= dur + step; t += step) {
      const tick = el('div', 'tl2-tick')
      tick.style.left = `${msToX(t)}px`
      const secs = t / 1000
      tick.appendChild(
        el('span', null, secs >= 60
          ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
          : `${step < 1000 ? secs.toFixed(1) : secs.toFixed(0)}s`),
      )
      ruler.appendChild(tick)
    }

    // Markers: the places you have decided matter. They belong to the timeline
    // rather than to any item, because what they mark is usually the *cut*
    // between two — a note pinned to one item would vanish when it was trimmed.
    for (const m of seq?.markers ?? []) {
      const flag = el('div', 'tl2-marker')
      flag.style.left = `${msToX(m.ms)}px`
      if (m.color) flag.style.setProperty('--mk', m.color)
      flag.dataset.markerId = m.id
      flag.title = `${m.label || 'Marker'} — ${(m.ms / 1000).toFixed(2)}s`
      if (m.label) flag.appendChild(el('span', null, m.label))
      ruler.appendChild(flag)
    }
  }

  /* ---------------------------------------------------------------- items */

  function sourceDurationOf(item) {
    const { media, clips, transcripts } = ctx()
    if (item.type === 'media') return media.get(item.sourceId)?.durationMs ?? null
    if (item.type === 'animation') return clips.find((c) => c.id === item.sourceId)?.durationMs ?? null
    if (item.type === 'caption') return transcripts.get(item.sourceId)?.durationMs ?? null
    if (item.type === 'timeline') {
      const child = ctx().timelines?.get(item.sourceId)
      return child ? sequenceDuration(child) : null
    }
    // A still has no length of its own: hold it as long as you like.
    if (item.type === 'image') return null
    return null
  }

  /**
   * Paint one slice of an item's waveform.
   *
   * Each pixel column shows the loudest bucket it covers, so zooming out never
   * hides a transient — a single snare hit two seconds wide on screen is still
   * a spike, not an average. Footage draws its sound as a strip along the
   * bottom edge, over the filmstrip; an audio item fills its lane.
   *
   * `fromPx` is where this canvas sits inside the item: the canvas never covers
   * more than the visible part, because a zoomed-in item can be tens of
   * thousands of pixels wide and a canvas that size silently draws nothing.
   */
  function paintWaveform(canvas, item, { strip = false, fromPx = 0 } = {}) {
    const { peaks, loadDetailPeaks } = ctx()
    const data = peaks.get(item.sourceId)
    if (!data) return

    // Zoomed in far enough that one overview bucket is a flat bar, switch to
    // the fine tier — fetched once, painted when it lands.
    let tier = data
    if ((pxPerMs * 1000) / data.peaksPerSecond > 3) {
      if (data.detail) tier = data.detail
      else if (!data.detailRequested && loadDetailPeaks) {
        data.detailRequested = true
        loadDetailPeaks(item.sourceId).then((ok) => ok && queueWavePaint())
      }
    }

    const w = Math.max(1, Math.round(canvas.clientWidth))
    const h = Math.max(1, Math.round(canvas.clientHeight))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = w * dpr
    canvas.height = h * dpr

    const g = canvas.getContext('2d')
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, h)

    const perMs = tier.peaksPerSecond / 1000
    const bandH = strip ? Math.max(8, Math.round(h * 0.42)) : h
    const bandTop = h - bandH
    if (strip) {
      g.fillStyle = 'rgba(0,0,0,.45)'
      g.fillRect(0, bandTop, w, bandH)
    }
    g.fillStyle = strip ? 'rgba(126,224,184,.75)' : 'rgba(255,255,255,.46)'

    for (let x = 0; x < w; x++) {
      const ms0 = item.inMs + (fromPx + x) / pxPerMs
      const ms1 = item.inMs + (fromPx + x + 1) / pxPerMs
      const i0 = Math.floor(ms0 * perMs)
      const i1 = Math.max(i0 + 1, Math.floor(ms1 * perMs))
      let max = 0
      for (let i = i0; i < i1; i++) {
        const v = tier.peaks[i] ?? 0
        if (v > max) max = v
      }
      const bar = Math.max(1, (max / 255) * (bandH - 4))
      g.fillRect(x, bandTop + (bandH - bar) / 2, 1, bar)
    }
  }

  /** Every waveform canvas of the current render, with its item on it. */
  let waveCanvases = []
  let wavePaintQueued = false

  /**
   * Size each waveform canvas to the part of its item that is on screen (plus
   * a margin either side) and paint that. Runs on scroll, zoom and render, so
   * the canvas stays small no matter how far in the timeline is zoomed.
   */
  function paintVisibleWaveforms() {
    wavePaintQueued = false
    const MARGIN = 512
    const viewLeft = root.scrollLeft
    const viewRight = viewLeft + root.clientWidth
    for (const canvas of waveCanvases) {
      if (!canvas.isConnected) continue
      const item = canvas.__item
      const itemLeft = HEAD_W + item.startMs * pxPerMs
      const itemW = Math.max(MIN_ITEM_PX, item.durationMs * pxPerMs)
      const a = Math.max(0, Math.floor(viewLeft - MARGIN - itemLeft))
      const b = Math.min(itemW, Math.ceil(viewRight + MARGIN - itemLeft))
      if (b <= a) {
        canvas.style.display = 'none'
        continue
      }
      canvas.style.display = ''
      canvas.style.left = `${a}px`
      canvas.style.width = `${b - a}px`
      paintWaveform(canvas, item, { strip: canvas.__strip, fromPx: a })
    }
  }

  function queueWavePaint() {
    if (wavePaintQueued) return
    wavePaintQueued = true
    // rAF for the smooth case; the timer for a background tab, where rAF
    // never fires and an agent scrubbing by tool would otherwise see stale
    // waveforms. paintVisibleWaveforms clears the flag, so the second one
    // to arrive is a no-op.
    const run = () => wavePaintQueued && paintVisibleWaveforms()
    requestAnimationFrame(run)
    setTimeout(run, 60)
  }
  root.addEventListener('scroll', queueWavePaint, { passive: true })

  /** Silence bands: sequence-time gaps inside this item, drawn over it. */
  function paintSilence(node, item) {
    const { silence, showSilence } = ctx()
    if (!showSilence || !silence) return
    const ranges = silence.get(item.sourceId)
    if (!ranges?.length) return
    const from = item.inMs
    const to = item.inMs + item.durationMs
    for (const r of ranges) {
      if (r.endMs <= from || r.startMs >= to) continue
      const a = Math.max(r.startMs, from) - from
      const b = Math.min(r.endMs, to) - from
      const band = el('div', 'tl2-silence')
      band.style.left = `${a * pxPerMs}px`
      band.style.width = `${Math.max(2, (b - a) * pxPerMs)}px`
      band.title = `${((b - a) / 1000).toFixed(2)}s of silence`
      node.appendChild(band)
    }
  }

  function renderItem(item, track) {
    const node = el('div', `tl2-item type-${item.type}${selectedIds.has(item.id) ? ' selected' : ''}`)
    node.dataset.item = item.id
    node.dataset.track = track.id
    node.style.left = `${item.startMs * pxPerMs}px`
    node.style.width = `${Math.max(MIN_ITEM_PX, item.durationMs * pxPerMs)}px`

    if (item.type === 'media') {
      const media = ctx().media.get(item.sourceId)
      const filmstrip = !!(media?.posterUrl && media.kind === 'video' && track.kind === 'video')
      if (filmstrip) node.style.backgroundImage = `url("${media.posterUrl}")`
      if (media?.hasAudio) {
        const canvas = el('canvas', 'tl2-wave')
        canvas.__item = item
        canvas.__strip = filmstrip
        node.appendChild(canvas)
        waveCanvases.push(canvas)
        paintSilence(node, item)
      }
      if (!media) node.classList.add('missing')
    }
    if (item.type === 'timeline') {
      // The sketch's purple block: a section that opens as a timeline of its
      // own. The bar along the bottom is how much of the block its content
      // fills; the rest would be empty.
      const child = ctx().timelines?.get(item.sourceId)
      if (!child) node.classList.add('missing')
      else {
        const content = Math.max(0, sequenceDuration(child) - item.inMs)
        const bar = el('div', 'tl2-item-content')
        bar.style.width = `${Math.max(0, Math.min(100, (content / item.durationMs) * 100))}%`
        node.appendChild(bar)
      }
      node.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        onOpen?.(item)
      })
    }
    if (item.type === 'image') {
      const asset = ctx().assets?.get(item.sourceId)
      if (asset?.url) node.style.backgroundImage = `url("${asset.url}")`
      else node.classList.add('missing')
    }
    if (track.locked) node.classList.add('locked')
    if (track.color) node.style.boxShadow = `inset 0 -3px 0 ${track.color}`
    setTip(node, `${item.name || item.type} · ${(item.durationMs / 1000).toFixed(2)}s from ${(item.startMs / 1000).toFixed(2)}s`
      + (item.type === 'media' || item.type === 'timeline' ? ` · in-point ${(item.inMs / 1000).toFixed(2)}s` : '')
      + (item.note ? `\n${item.note}` : '')
      + '\nDrag to move · edges trim · ⌘-click adds to the selection · ⇧-click selects the run between · right-click for more', { at: 'top' })

    const label = el('div', 'tl2-item-label')
    const soundOnly = (item.type === 'media' && track.kind === 'audio' && ctx().media.get(item.sourceId)?.hasVideo) || (item.type === 'timeline' && track.kind === 'audio')
    label.append(el('span', 'tl2-item-name', (soundOnly ? '♪ ' : '') + (item.type === 'timeline' ? '⧉ ' : '') + (item.name || item.type)))
    const secs = (item.durationMs / 1000).toFixed(1)
    label.append(el('span', 'tl2-item-dur', `${secs}s`))
    node.appendChild(label)

    if ((item.muted || track.muted) && (track.kind === 'audio' || item.type === 'media')) {
      node.classList.add('muted')
    }

    // A diamond per keyed moment, so a move is visible on the block without
    // opening anything. Only where the block is wide enough to tell them apart.
    const keyed = keyTimes(item)
    if (keyed.length && item.durationMs * pxPerMs > 40) {
      for (const ms of keyed) {
        const d = el('div', 'tl2-key')
        d.style.left = `${(ms / item.durationMs) * 100}%`
        node.appendChild(d)
      }
    }

    node.append(el('div', 'tl2-grip start'), el('div', 'tl2-grip end'))
    return node
  }

  /**
   * The bottom edge of a track header resizes that lane. Only the row's own
   * style moves during the drag; the height is written to the model on release
   * and the timeline redrawn once. Double-click puts the default back.
   */
  function trackGrip(track, row) {
    const grip = el('div', 'tl2-head-grip')
    grip.title = 'Drag to resize this track · double-click to reset'
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const startY = e.clientY
      const startH = row.getBoundingClientRect().height
      grip.classList.add('dragging')
      document.body.classList.add('resizing')
      const lane = row.querySelector('.tl2-lane')
      const onMove = (ev) => {
        const h = Math.max(32, Math.min(260, Math.round(startH + ev.clientY - startY)))
        row.style.minHeight = `${h}px`
        if (lane) lane.style.minHeight = `${h}px`
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        grip.classList.remove('dragging')
        document.body.classList.remove('resizing')
        const h = Math.round(parseFloat(row.style.minHeight))
        const current = track.height ?? (track.kind === 'audio' ? 62 : 54)
        if (h !== current) {
          track.height = h
          onChange({ structural: true })
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    })
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      if (track.height == null) return
      delete track.height
      onChange({ structural: true })
    })
    return grip
  }

  /**
   * Drag a header up or down to reorder the track among those of its kind.
   * A line shows where it will land; the model changes only on release,
   * through onChange({ reorderTrack }), so undo sees one step.
   */
  let dropLine = null
  function attachReorder(head, row, track) {
    let drag = null
    const sameKindRows = () => [...lanes.querySelectorAll(`.tl2-track.kind-${track.kind}`)]

    const target = (clientY) => {
      const rows = sameKindRows()
      const lanesTop = lanes.getBoundingClientRect().top
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect()
        if (clientY < r.top + r.height / 2) return { gap: i, y: r.top - lanesTop }
      }
      const last = rows[rows.length - 1]?.getBoundingClientRect()
      return { gap: rows.length, y: last ? last.bottom - lanesTop : 0 }
    }

    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, .tl2-head-grip')) return
      if (ctx().busy) return
      drag = { y0: e.clientY, pointerId: e.pointerId, active: false, gap: null }
    })
    head.addEventListener('pointermove', (e) => {
      if (!drag) return
      if (!drag.active) {
        if (Math.abs(e.clientY - drag.y0) < 6) return
        drag.active = true
        try { head.setPointerCapture(drag.pointerId) } catch { /* fine */ }
        row.classList.add('reordering')
        dropLine = el('div', 'tl2-drop-line')
        lanes.appendChild(dropLine)
      }
      const t = target(e.clientY)
      drag.gap = t.gap
      dropLine.style.top = `${t.y}px`
    })
    const finish = () => {
      if (!drag) return
      const d = drag
      drag = null
      if (!d.active) return
      row.classList.remove('reordering')
      dropLine?.remove()
      dropLine = null
      head.dataset.dragged = '1'
      setTimeout(() => delete head.dataset.dragged, 0)
      const rows = sameKindRows()
      const from = rows.findIndex((r) => r === row)
      if (d.gap == null || from < 0) return
      // The gap is a slot between rows; taking the row out first shifts the
      // slots after it up by one.
      const index = d.gap > from ? d.gap - 1 : d.gap
      if (index === from) return
      onChange({ reorderTrack: { trackId: track.id, index } })
    }
    head.addEventListener('pointerup', finish)
    head.addEventListener('pointercancel', finish)
  }

  function renderTracks() {
    lanes.innerHTML = ''
    waveCanvases = []
    const seq = ctx().seq
    if (!seq) return

    for (const track of seq.tracks) {
      const row = el('div', `tl2-track kind-${track.kind}`)
      row.dataset.track = track.id
      const laneH = track.height ?? (track.kind === 'audio' ? 62 : 54)
      row.style.minHeight = `${laneH}px`

      const head = el('div', 'tl2-head')
      head.dataset.track = track.id
      if (track.color) {
        head.style.boxShadow = `inset 3px 0 0 ${track.color}`
        row.style.setProperty('--track-color', track.color)
      }
      const name = el('span', 'tl2-head-name', track.name)
      setTip(name, `${track.name}${track.note ? `\n${track.note}` : ''}\nClick to select · double-click to rename · drag up or down to reorder`, { at: 'right' })
      // Double-click renames in place; a click selects the track for the inspector.
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        const input = el('input', 'tl2-head-rename')
        input.value = track.name
        name.replaceWith(input)
        input.focus()
        input.select()
        let done = false
        const commit = () => {
          if (done) return
          done = true
          const next = input.value.trim()
          if (next && next !== track.name) {
            track.name = next
            onChange({ structural: true })
          } else {
            input.replaceWith(name)
          }
        }
        input.addEventListener('blur', commit)
        input.addEventListener('keydown', (k) => {
          k.stopPropagation()
          if (k.key === 'Enter') commit()
          if (k.key === 'Escape') {
            done = true
            input.replaceWith(name)
          }
        })
        input.addEventListener('pointerdown', (k) => k.stopPropagation())
      })
      head.addEventListener('click', (e) => {
        if (e.target.closest('button, input, .tl2-head-grip')) return
        if (head.dataset.dragged) return
        onSelectTrack?.(track)
      })
      attachReorder(head, row, track)

      // Up and down, right on the header. Dim until the pointer is near;
      // an arrow that cannot move any further is disabled, not hidden, so
      // the header keeps its shape.
      const same = seq.tracks.filter((t) => t.kind === track.kind)
      const pos = same.indexOf(track)
      const order = el('div', 'tl2-head-order')
      const arrow = (glyph, to, disabled, tip, key) => {
        const b = el('button', 'tl2-obtn', glyph)
        b.disabled = disabled
        setTip(b, tip, { key })
        b.onclick = (e) => {
          e.stopPropagation()
          onChange({ reorderTrack: { trackId: track.id, to } })
        }
        return b
      }
      order.append(
        arrow('▲', 'up', pos <= 0, 'Move this track up — it will draw over the one above.', '⌥↑'),
        arrow('▼', 'down', pos >= same.length - 1, 'Move this track down — the one above will draw over it.', '⌥↓'),
      )
      head.append(order, name)
      head.appendChild(trackGrip(track, row))

      const buttons = el('div', 'tl2-head-btns')
      if (track.kind === 'video') {
        const eye = el('button', `tl2-tbtn${track.hidden ? ' off' : ''}`, track.hidden ? '◌' : '◉')
        setTip(eye, track.hidden ? 'Track hidden — click to show it.' : 'Hide this track from the preview and the render.')
        eye.onclick = (e) => {
          e.stopPropagation()
          track.hidden = !track.hidden
          onChange({ structural: true })
        }
        buttons.appendChild(eye)
      }
      const lock = el('button', `tl2-tbtn${track.locked ? ' on' : ''}`, track.locked ? '🔒' : '🔓')
      setTip(lock, track.locked
        ? 'Track locked — ripple edits and silence removal leave it alone. Click to unlock.'
        : 'Lock this track so ripple edits and silence removal leave it alone.')
      lock.onclick = (e) => {
        e.stopPropagation()
        track.locked = !track.locked
        onChange({ structural: true })
      }
      buttons.appendChild(lock)

      const mute = el('button', `tl2-tbtn${track.muted ? ' off' : ''}`, track.muted ? '🔇' : '🔊')
      setTip(mute, track.muted ? 'Track muted — click to unmute.' : 'Mute this track.')
      mute.onclick = (e) => {
        e.stopPropagation()
        track.muted = !track.muted
        onChange({ structural: true })
      }
      buttons.appendChild(mute)
      head.appendChild(buttons)
      row.appendChild(head)

      const lane = el('div', 'tl2-lane')
      lane.dataset.track = track.id
      lane.style.width = `${contentWidth() - HEAD_W}px`
      lane.style.minHeight = `${laneH}px`
      for (const item of track.items) lane.appendChild(renderItem(item, track))
      row.appendChild(lane)

      lanes.appendChild(row)
    }
  }

  function render() {
    body.style.width = `${contentWidth()}px`
    renderRuler()
    renderTracks()
    setPlayhead(playheadMs)
    paintVisibleWaveforms()
  }

  function setPlayhead(ms) {
    playheadMs = Math.max(0, ms)
    playhead.style.left = `${msToX(playheadMs)}px`
  }

  /* ----------------------------------------------------------- interaction */

  /** Capture is an optimisation, not a requirement — never let it stop a drag. */
  function capture(pointerId) {
    try {
      body.setPointerCapture(pointerId)
    } catch {
      /* the pointer is already gone, or was never real */
    }
  }

  function trackFromPoint(clientY) {
    const seq = ctx().seq
    for (const row of lanes.querySelectorAll('.tl2-track')) {
      const r = row.getBoundingClientRect()
      if (clientY >= r.top && clientY <= r.bottom) {
        return seq.tracks.find((t) => t.id === row.dataset.track) ?? null
      }
    }
    return null
  }

  // Right-click: pick what is under the pointer, make an unselected item the
  // selection (a selected one keeps its group), and let the app build a menu.
  root.addEventListener('contextmenu', (e) => {
    if (!onContext) return
    const { seq, busy } = ctx()
    if (!seq || busy) return
    e.preventDefault()
    const itemEl = e.target.closest?.('.tl2-item')
    const head = e.target.closest?.('.tl2-head')
    const lane = e.target.closest?.('.tl2-lane')
    const onRuler = !!e.target.closest?.('.tl2-ruler')
    const markerId = e.target.closest?.('.tl2-marker')?.dataset?.markerId ?? null
    const trackId = itemEl?.dataset.track ?? head?.dataset.track ?? lane?.dataset.track
    const track = seq.tracks.find((t) => t.id === trackId) ?? null
    const item = itemEl ? track?.items.find((i) => i.id === itemEl.dataset.item) ?? null : null
    if (item && !selectedIds.has(item.id)) {
      selectedIds = new Set([item.id])
      render()
      onSelect?.(selectedItems())
    }
    onContext({
      kind: item ? 'item' : head ? 'track' : lane ? 'lane' : onRuler ? 'ruler' : 'empty',
      markerId,
      item,
      track,
      atMs: xToMs(e.clientX),
      x: e.clientX,
      y: e.clientY,
      selected: selectedItems(),
    })
  })

  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const { seq, busy } = ctx()
    if (!seq || busy) return

    const itemEl = e.target.closest?.('.tl2-item')
    const onHead = e.target.closest?.('.tl2-head')
    if (onHead) return

    if (!itemEl) {
      // Empty lane or ruler: scrub.
      selectedIds = new Set()
      onSelect?.([])
      render()
      drag = { mode: 'scrub' }
      capture(e.pointerId)
      onSeek?.(xToMs(e.clientX))
      return
    }

    const found = seq.tracks
      .flatMap((t) => t.items.map((i) => ({ track: t, item: i })))
      .find((x) => x.item.id === itemEl.dataset.item)
    if (!found || found.track.locked) return

    // ⌘/Ctrl-click toggles an item in and out of the selection. Shift-click
    // selects the run between the last pick and this item on the same track
    // — a stretch of captions in two clicks. A plain click on an unselected
    // item selects just it; on a selected one it keeps the group, so a group
    // drag can start from any member.
    const toggle = e.metaKey || e.ctrlKey
    const anchor = e.shiftKey && lastPickedId && !toggle ? found.track.items.find((i) => i.id === lastPickedId) : null
    if (anchor && anchor.id !== found.item.id) {
      const a = Math.min(anchor.startMs, found.item.startMs)
      const b = Math.max(anchor.startMs, found.item.startMs)
      for (const it of found.track.items) if (it.startMs >= a && it.startMs <= b) selectedIds.add(it.id)
    } else if (toggle || e.shiftKey) {
      if (selectedIds.has(found.item.id)) selectedIds.delete(found.item.id)
      else selectedIds.add(found.item.id)
    } else if (!selectedIds.has(found.item.id)) {
      selectedIds = new Set([found.item.id])
    } else {
      selectedIds.delete(found.item.id)
      selectedIds.add(found.item.id)
    }
    if (selectedIds.has(found.item.id)) lastPickedId = found.item.id
    onSelect?.(selectedItems())
    if (!selectedIds.has(found.item.id)) {
      render()
      return
    }

    const rect = itemEl.getBoundingClientRect()
    const mode =
      e.clientX - rect.left < EDGE_PX ? 'trim-start'
      : rect.right - e.clientX < EDGE_PX ? 'trim-end'
      : 'move'

    // A group moves together; trims stay single.
    const group = mode === 'move' && selectedIds.size > 1 ? [...selectedIds] : null

    drag = {
      mode,
      itemEl,
      item: found.item,
      track: found.track,
      grabMs: xToMs(e.clientX) - found.item.startMs,
      startSnapshot: { ...found.item },
      targetTrack: found.track,
      moved: false,
      group,
      groupEls: null,
    }
    capture(e.pointerId)
    render()
    // render() rebuilt the DOM: re-find the dragged element and its group.
    drag.itemEl = lanes.querySelector(`.tl2-item[data-item="${found.item.id}"]`) ?? itemEl
    drag.itemEl.classList.add('dragging')
    if (group) {
      drag.groupEls = [...lanes.querySelectorAll('.tl2-item.selected')]
        .filter((n) => n !== drag.itemEl)
        .map((n) => ({ el: n, left: parseFloat(n.style.left) || 0 }))
    }
  })

  body.addEventListener('pointermove', (e) => {
    if (!drag) return

    if (drag.mode === 'scrub') {
      onSeek?.(xToMs(e.clientX))
      return
    }

    drag.moved = true
    const seq = ctx().seq
    const targets = snapTargets(seq, drag.item.id, playheadMs)
    const tolerance = SNAP_PX / pxPerMs
    const ms = xToMs(e.clientX)

    if (drag.mode === 'move') {
      const raw = Math.max(0, ms - drag.grabMs)
      // Snap whichever edge is closer to something.
      const snappedStart = snap(raw, targets, tolerance)
      const snappedEnd = snap(raw + drag.item.durationMs, targets, tolerance) - drag.item.durationMs
      const start = Math.abs(snappedStart - raw) <= Math.abs(snappedEnd - raw) ? snappedStart : snappedEnd
      drag.pendingStart = Math.max(0, start)
      drag.itemEl.style.left = `${drag.pendingStart * pxPerMs}px`

      if (drag.group) {
        // The whole group slides with the cursor; no member changes track.
        const deltaPx = (drag.pendingStart - drag.item.startMs) * pxPerMs
        for (const g of drag.groupEls) g.el.style.left = `${Math.max(0, g.left + deltaPx)}px`
        return
      }

      const over = trackFromPoint(e.clientY)
      if (over && over.kind === drag.track.kind && over !== drag.targetTrack) {
        drag.targetTrack = over
        const lane = lanes.querySelector(`.tl2-lane[data-track="${over.id}"]`)
        lane?.appendChild(drag.itemEl)
      }
      return
    }

    const edge = drag.mode === 'trim-start' ? 'start' : 'end'
    const at = snap(ms, targets, tolerance)
    const preview = { ...drag.item }
    // Preview the trim on a copy so an illegal drag never corrupts the model.
    const sourceDurationMs = sourceDurationOf(drag.item)
    applyTrim(preview, edge, at, sourceDurationMs)
    drag.pendingTrim = preview
    drag.itemEl.style.left = `${preview.startMs * pxPerMs}px`
    drag.itemEl.style.width = `${Math.max(MIN_ITEM_PX, preview.durationMs * pxPerMs)}px`
  })

  /** The pure part of trimItem, so a drag can preview without committing. */
  function applyTrim(item, edge, ms, sourceDurationMs) {
    const MIN = 40
    if (edge === 'start') {
      const maxStart = itemEnd(item) - MIN
      let next = Math.min(Math.max(0, Math.round(ms)), maxStart)
      const delta = next - item.startMs
      if (item.type !== 'animation' && item.inMs + delta < 0) next = item.startMs - item.inMs
      const applied = next - item.startMs
      item.startMs = next
      item.durationMs -= applied
      if (item.type !== 'animation') item.inMs = Math.max(0, item.inMs + applied)
    } else {
      let dur = Math.max(MIN, Math.round(ms) - item.startMs)
      if (sourceDurationMs != null) dur = Math.min(dur, Math.max(MIN, sourceDurationMs - item.inMs))
      item.durationMs = dur
    }
  }

  body.addEventListener('pointerup', (e) => {
    if (!drag) return
    const finished = drag
    drag = null
    try { body.releasePointerCapture(e.pointerId) } catch { /* never captured */ }

    if (finished.mode === 'scrub') {
      onSeek?.(xToMs(e.clientX))
      return
    }

    finished.itemEl.classList.remove('dragging')
    const seq = ctx().seq

    if (!finished.moved) {
      render()
      return
    }

    if (finished.mode === 'move' && finished.group) {
      moveItems(seq, finished.group, (finished.pendingStart ?? finished.item.startMs) - finished.item.startMs)
    } else if (finished.mode === 'move') {
      moveItem(seq, finished.item.id, {
        startMs: finished.pendingStart ?? finished.item.startMs,
        trackId: finished.targetTrack.id,
      })
    } else {
      const p = finished.pendingTrim
      if (p) {
        const edge = finished.mode === 'trim-start' ? 'start' : 'end'
        trimItem(seq, finished.item.id, edge, edge === 'start' ? p.startMs : p.startMs + p.durationMs, {
          sourceDurationMs: sourceDurationOf(finished.item),
        })
        // Re-place so a trim that grew into a neighbour still obeys the rule.
        const track = seq.tracks.find((t) => t.items.some((i) => i.id === finished.item.id))
        if (track) placeItem(track, finished.item)
      }
    }

    onChange({ structural: true })
  })

  /* ------------------------------------------------------------------ wheel */

  /**
   * ⌘/ctrl + wheel zooms about the cursor, so the moment under the pointer
   * stays under the pointer. A plain wheel scrolls, as the browser already
   * does for an overflow container.
   */
  root.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = root.getBoundingClientRect()
      const cursorX = e.clientX - rect.left + root.scrollLeft
      const msUnderCursor = (cursorX - HEAD_W) / pxPerMs
      const factor = Math.exp(-e.deltaY * 0.0022)
      pxPerMs = Math.max(0.004, Math.min(2, pxPerMs * factor))
      render()
      root.scrollLeft = Math.max(0, HEAD_W + msUnderCursor * pxPerMs - (e.clientX - rect.left))
    },
    { passive: false },
  )

  /* ------------------------------------------------------------ drag & drop */

  body.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('application/x-ah-source')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const lane = e.target.closest?.('.tl2-lane')
    lanes.querySelectorAll('.tl2-lane.drop').forEach((l) => l.classList.remove('drop'))
    lane?.classList.add('drop')
  })
  body.addEventListener('dragleave', (e) => {
    if (e.target.closest?.('.tl2-lane')) e.target.closest('.tl2-lane').classList.remove('drop')
  })
  body.addEventListener('drop', (e) => {
    const raw = e.dataTransfer?.getData('application/x-ah-source')
    if (!raw) return
    e.preventDefault()
    lanes.querySelectorAll('.tl2-lane.drop').forEach((l) => l.classList.remove('drop'))

    const lane = e.target.closest?.('.tl2-lane')
    const track = lane ? ctx().seq.tracks.find((t) => t.id === lane.dataset.track) : null
    const targets = snapTargets(ctx().seq, null, playheadMs)
    const at = snap(xToMs(e.clientX), targets, SNAP_PX / pxPerMs)
    onChange({ drop: JSON.parse(raw), trackId: track?.id ?? null, atMs: Math.max(0, at) })
  })

  /* ---------------------------------------------------------------- public */

  return {
    render,
    setPlayhead,
    get selectedId() {
      return primaryId()
    },
    get selectedIds() {
      return [...selectedIds]
    },
    select(id) {
      selectedIds = id ? new Set([id]) : new Set()
      render()
    },
    selectMany(ids) {
      selectedIds = new Set(ids)
      render()
      onSelect?.(selectedItems())
    },
    selectAll() {
      const seq = ctx().seq
      selectedIds = new Set(seq ? seq.tracks.flatMap((t) => t.items.map((i) => i.id)) : [])
      render()
      onSelect?.(selectedItems())
    },
    get pxPerMs() {
      return pxPerMs
    },
    zoom(factor) {
      pxPerMs = Math.max(0.004, Math.min(2, pxPerMs * factor))
      render()
    },
    zoomToFit() {
      const seq = ctx().seq
      const dur = Math.max(sequenceDuration(seq), 5000)
      const room = Math.max(240, root.clientWidth - HEAD_W - 48)
      pxPerMs = Math.max(0.004, Math.min(2, room / dur))
      render()
    },
    repaintWaveforms: () => queueWavePaint(),
    /** Scroll so the playhead stays in view during playback. */
    followPlayhead() {
      const x = msToX(playheadMs)
      const left = root.scrollLeft
      const right = left + root.clientWidth
      if (x < left + HEAD_W + 40) root.scrollLeft = Math.max(0, x - HEAD_W - 40)
      else if (x > right - 80) root.scrollLeft = x - root.clientWidth + 200
    },
    /** Cut every selected item that spans the time. Returns how many were cut. */
    splitSelectedAt(ms) {
      const seq = ctx().seq
      let n = 0
      for (const id of [...selectedIds]) if (splitItem(seq, id, ms)) n++
      return n
    },
    /** Remove every selected item; ripple works latest-first so earlier gaps stay put. */
    deleteSelected({ ripple = false } = {}) {
      const seq = ctx().seq
      const items = selectedItems().sort((a, b) => b.startMs - a.startMs)
      if (!items.length) return null
      const gone = []
      for (const item of items) {
        const track = seq.tracks.find((t) => t.items.includes(item))
        if (!track || track.locked) continue
        gone.push(ripple ? rippleDelete(seq, item.id) : removeItem(seq, item.id))
      }
      selectedIds = new Set()
      onSelect?.([])
      return gone.length ? gone : null
    },
  }
}
