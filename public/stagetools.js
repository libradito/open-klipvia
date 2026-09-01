/**
 * Moving things by pointing at them.
 *
 * Everything an item's placement needs was always in the inspector — anchor,
 * two offsets, a size in pixels — and typing numbers into it is a poor way to
 * decide where a title goes. This layer puts a rectangle and eight handles over
 * the preview and writes those same fields, so the panel and the stage are two
 * views of one truth rather than two ways of editing.
 *
 * Three things make it honest:
 *
 *   • It measures the *ink*, not the frame. A title compiles to a clip the size
 *     of the whole frame; a box drawn round the frame would be impossible to
 *     grab and would swallow every click meant for the footage under it.
 *   • It never invents a placement the renderer cannot express. A drag writes
 *     offsets; a resize writes the one field that item type actually has — an
 *     image's width, a shape's box, a title's type size, a clip's scale — so
 *     what you drag is what ffmpeg composites.
 *   • Footage and nested blocks fill the frame by a fit rule, which has no room
 *     for a position. Dragging one switches it to free placement first, at the
 *     size it already had, so the picture does not jump under the cursor.
 */

import { textPreset } from '/textpresets.js'
import { anchorPx, compositeOrder, layerBox, SCALE_MAX, SCALE_MIN, scaleOf } from '/sequence.js'
import { clamp, cropOf, rotationOf } from '/effects.js'
import { anyKeyed, keyTimes, keysFor } from '/keys.js'

/** How close, in screen pixels, a guide has to be before it pulls. */
const SNAP_PX = 6
/** No item may be dragged smaller than this, in frame pixels. */
const MIN_PX = 8
/** Drag further than this before anything moves, so a click stays a click. */
const SLOP_PX = 3

/** How close to a multiple of 15° a turn has to be, holding ⇧, to snap to it. */
const TURN_SNAP_DEG = 15

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CORNERS = new Set(['nw', 'ne', 'se', 'sw'])
const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
}

const even = (n) => Math.max(4, Math.min(8192, 2 * Math.round(n / 2)))
const isShape = (item) => item.type === 'text' && textPreset(item.sourceId)?.kind === 'shape'

/**
 * What a resize *means* for this kind of item.
 *
 *   box   — the item owns a width and a height. Written straight through.
 *   scale — the whole document is drawn k times as large, so its ink scales
 *           with it exactly and the arithmetic closes.
 *   type  — the item owns a type size and the clip around it does not change,
 *           so the ink can only be scaled about its own middle. Approximate by
 *           nature; it re-measures the moment the drag ends.
 */
export function resizeMode(item) {
  if (!item) return 'none'
  if (item.type === 'image') return 'box'
  if (item.type === 'text') return isShape(item) ? 'box' : 'type'
  if (item.type === 'caption') return 'type'
  if (item.type === 'animation' || item.type === 'media' || item.type === 'timeline') return 'scale'
  return 'none'
}

export function createStageTools({
  root,
  getContext,
  getScale,
  getTime,
  getSelection,
  isLocked,
  boxOf,
  reposition,
  preview,
  onSelect,
  onLive,
  onCommit,
  onStatus,
}) {
  const sel = document.createElement('div')
  sel.className = 'st-sel'
  sel.hidden = true
  for (const dir of HANDLES) {
    const h = document.createElement('i')
    h.className = `st-h st-h-${dir}`
    h.dataset.dir = dir
    h.style.cursor = CURSORS[dir]
    sel.appendChild(h)
  }
  const turn = document.createElement('i')
  turn.className = 'st-h st-turn'
  turn.dataset.dir = 'turn'
  turn.style.cursor = 'grab'
  sel.appendChild(turn)

  const chip = document.createElement('div')
  chip.className = 'st-chip'
  sel.appendChild(chip)

  const hover = document.createElement('div')
  hover.className = 'st-hover'
  hover.hidden = true

  const guides = document.createElement('div')
  guides.className = 'st-guides'

  /** Where a keyed layer travels, drawn as a line with a dot on every key. */
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  path.setAttribute('class', 'st-path')
  path.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible'

  root.append(hover, guides, path, sel)

  /** Non-null for the length of one pointer gesture. */
  let drag = null
  let suppressed = false
  let cropping = false
  /**
   * The last measured ink of each item.
   *
   * A resize recompiles the clip, and for a beat afterwards there is no
   * document to measure — the rectangle would jump out to the whole frame and
   * back. Remembering the last honest measurement keeps it still.
   */
  const lastInk = new Map()
  let settleTimer = 0

  const ctx = () => getContext()
  const k = () => getScale() || 1
  /** The one selected item, or nothing: handles over a multi-selection would lie. */
  const sole = () => (getSelection().length === 1 ? getSelection()[0] : null)

  /* ------------------------------------------------------------- geometry */

  /** Every item drawn at the playhead, bottom of the stack first. */
  function onStage() {
    const { seq } = ctx()
    if (!seq) return []
    const t = getTime()
    const out = []
    for (const track of compositeOrder(seq)) {
      if (track.hidden) continue
      for (const item of track.items) {
        if (t < item.startMs || t >= item.startMs + item.durationMs) continue
        const box = boxOf(item.id)
        if (!box || box.w < 1 || box.h < 1) continue
        out.push({ item, track, box })
      }
    }
    return out
  }

  /** Turn a point about a pivot. Positive degrees are clockwise, as on screen. */
  function spin(p, deg, cx, cy) {
    if (!deg) return p
    const a = (-deg * Math.PI) / 180
    const dx = p.x - cx, dy = p.y - cy
    return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) }
  }

  /**
   * Is the point in the box — asked in the box's own frame, so a turned layer
   * is hit where it looks like it is rather than where its bounding box is.
   */
  function inside(box, p) {
    const q = box.rotation ? spin(p, -box.rotation, box.pivotX, box.pivotY) : p
    return q.x >= box.x && q.x <= box.x + box.w && q.y >= box.y && q.y <= box.y + box.h
  }

  /** Frame pixels from a pointer event. */
  function point(e) {
    const r = root.getBoundingClientRect()
    return { x: (e.clientX - r.left) / k(), y: (e.clientY - r.top) / k() }
  }

  /**
   * The topmost item under the pointer.
   *
   * A layer that fills the frame — background footage, a full-bleed image — is
   * only picked when nothing smaller is there, so clicking a title that sits on
   * top of footage selects the title and clicking beside it selects the shot.
   */
  function pick(p, { after = null } = {}) {
    const hits = onStage().filter((c) => inside(c.box, p) && !isLocked?.(c.track))
    if (!hits.length) return null
    const small = hits.filter((c) => !c.box.fills)
    const list = (small.length ? small : hits).reverse()
    if (after) {
      const i = list.findIndex((c) => c.item.id === after)
      if (i >= 0) return list[(i + 1) % list.length]
    }
    return list[0]
  }

  /* --------------------------------------------------------------- writing */

  /**
   * Give footage or a nested block a position of its own.
   *
   * `contain` and `cover` describe how a picture fills the frame and have no
   * room for an offset, so the first drag converts the item to free placement
   * at exactly the size and position it already had. Nothing moves; it simply
   * becomes movable.
   */
  function freePlace(item) {
    if (item.type !== 'media' && item.type !== 'timeline') return false
    if (item.fit === 'none') return false
    const { seq } = ctx()
    const before = layerBox(item, ctx())
    if (!before) return false
    const native = { w: before.w / (before.sx || 1), h: before.h / (before.sy || 1) }
    item.fit = 'none'
    item.scale = clamp(before.sx || 1, SCALE_MIN, SCALE_MAX)
    item.anchor = 'center'
    const a = anchorPx('center', seq.width, seq.height, native.w * item.scale, native.h * item.scale)
    item.offsetX = Math.round(before.x - a.x)
    item.offsetY = Math.round(before.y - a.y)
    return true
  }

  /** Put the item's layer box at `x, y` by way of its anchor and offsets. */
  function placeLayerBox(item, x, y, w, h) {
    const { seq } = ctx()
    const a = anchorPx(item.anchor ?? 'center', seq.width, seq.height, w, h)
    item.offsetX = Math.round(x - a.x)
    item.offsetY = Math.round(y - a.y)
  }

  /* -------------------------------------------------------------- snapping */

  /**
   * The lines a dragged edge is drawn to: the frame, its middle, a 5% safe
   * margin, and every other item on stage. Hold ⌘ to ignore them.
   */
  function guideLines(exceptId) {
    const { seq } = ctx()
    const W = seq.width, H = seq.height
    const xs = [0, W / 2, W, Math.round(W * 0.05), Math.round(W * 0.95)]
    const ys = [0, H / 2, H, Math.round(H * 0.05), Math.round(H * 0.95)]
    for (const { item, box } of onStage()) {
      if (item.id === exceptId || box.fills) continue
      xs.push(box.x, box.x + box.w / 2, box.x + box.w)
      ys.push(box.y, box.y + box.h / 2, box.y + box.h)
    }
    return { xs, ys }
  }

  /** The smallest nudge that puts one of `values` onto one of `lines`. */
  function pull(values, lines, tol) {
    let best = null
    for (const v of values) {
      for (const l of lines) {
        const d = l - v
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: l }
      }
    }
    return best
  }

  function showGuides(lines) {
    guides.innerHTML = ''
    for (const g of lines) {
      const el = document.createElement('i')
      el.className = `st-guide st-guide-${g.axis}`
      if (g.axis === 'x') el.style.left = `${g.at * k()}px`
      else el.style.top = `${g.at * k()}px`
      guides.appendChild(el)
    }
  }

  /* ----------------------------------------------------------------- drags */

  function beginDrag(e, dir) {
    const { seq } = ctx()
    if (!seq || suppressed) return
    const p = point(e)

    let target = null
    if (dir) {
      const item = sole()
      if (!item) return
      target = { item, box: boxOf(item.id) }
      if (!target.box) return
    } else {
      const hit = pick(p, { after: e.altKey ? sole()?.id : null })
      if (!hit) {
        onSelect(null)
        return
      }
      target = hit
      if (sole()?.id !== hit.item.id) onSelect(hit.item)
    }

    const item = target.item
    const mode = dir === 'turn' ? 'turn' : dir ? (cropping ? 'crop' : resizeMode(item)) : 'move'
    if (dir && mode === 'none') return

    // Footage has to become placeable before it can be placed.
    const converted = freePlace(item)
    if (converted) {
      reposition(item.id)
      onStatus?.(`"${item.name}" is now placed freely — Fit is set to none`)
    }

    const box = converted ? boxOf(item.id) : target.box
    if (!box) return
    const frame = box.frame ?? box

    drag = {
      item,
      dir,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      box0: { x: box.x, y: box.y, w: box.w, h: box.h },
      frame0: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      // Where the ink sits inside the frame, as a fraction. Scaling the whole
      // document leaves this untouched, which is what closes the arithmetic.
      ink: {
        x: frame.w ? (box.x - frame.x) / frame.w : 0,
        y: frame.h ? (box.y - frame.y) / frame.h : 0,
        w: frame.w ? box.w / frame.w : 1,
        h: frame.h ? box.h / frame.h : 1,
      },
      base: baseOf(item, mode),
      // The whole gesture happens in the layer's own upright frame; the pointer
      // is turned into it on the way in and nothing else has to know.
      spinDeg: box.rotation ?? 0,
      pivotX: box.pivotX ?? box.x + box.w / 2,
      pivotY: box.pivotY ?? box.y + box.h / 2,
      moved: false,
      lines: null,
      dirty: converted,
    }
    if (mode === 'turn') {
      const p0 = point(e)
      drag.turnFrom = Math.atan2(p0.y - drag.pivotY, p0.x - drag.pivotX)
      drag.turnBase = rotationOf(item)
    }

    root.setPointerCapture?.(e.pointerId)
    root.classList.add('dragging')
    e.preventDefault()
  }

  /** The value a resize multiplies, captured before the first pointer move. */
  function baseOf(item, mode) {
    if (mode === 'crop') {
      const c = cropOf(item)
      return { crop: { top: c?.top ?? 0, right: c?.right ?? 0, bottom: c?.bottom ?? 0, left: c?.left ?? 0 } }
    }
    if (mode === 'scale') return { scale: scaleOf(item) }
    if (mode === 'type') {
      if (item.type === 'caption') return { fontSize: Number(item.captionStyle?.fontSize) || 42 }
      const preset = textPreset(item.sourceId)
      const st = { ...(preset?.defaults ?? {}), ...(item.textStyle ?? {}) }
      return { fontSize: Number(st.fontSize) || 96 }
    }
    return { offsetX: item.offsetX ?? 0, offsetY: item.offsetY ?? 0 }
  }

  function moveDrag(e) {
    const dx = (e.clientX - drag.startX) / k()
    const dy = (e.clientY - drag.startY) / k()
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < SLOP_PX) return
    drag.moved = true
    drag.dirty = true

    if (drag.mode === 'turn') applyTurn(e)
    else if (drag.mode === 'move') applyMove(dx, dy, e)
    else if (drag.mode === 'crop') applyCrop(dx, dy, e)
    else applyResize(dx, dy, e)

    onLive?.()
  }

  function applyMove(dx, dy, e) {
    const { item, box0, base } = drag
    // ⇧ locks the drag to the axis it started along.
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0
      else dx = 0
    }

    let x = box0.x + dx
    let y = box0.y + dy
    const shown = []

    if (!(e.metaKey || e.ctrlKey)) {
      const tol = SNAP_PX / k()
      const { xs, ys } = drag.lines ?? (drag.lines = guideLines(item.id))
      const px = pull([x, x + box0.w / 2, x + box0.w], xs, tol)
      const py = pull([y, y + box0.h / 2, y + box0.h], ys, tol)
      if (px) { x += px.d; shown.push({ axis: 'x', at: px.line }) }
      if (py) { y += py.d; shown.push({ axis: 'y', at: py.line }) }
    }
    showGuides(shown)

    item.offsetX = Math.round(base.offsetX + (x - box0.x))
    item.offsetY = Math.round(base.offsetY + (y - box0.y))
    reposition(item.id)
    drawSelection(
      { x, y, w: box0.w, h: box0.h, rotation: drag.spinDeg, pivotX: x + box0.w / 2, pivotY: y + box0.h / 2 },
      `${Math.round(x)}, ${Math.round(y)}`,
    )
  }

  /**
   * Turning follows the pointer round the layer's middle. ⇧ snaps to 15°, which
   * is how you get something exactly upright, exactly square or exactly
   * diagonal without typing a number.
   */
  function applyTurn(e) {
    const { item, pivotX, pivotY, turnFrom, turnBase } = drag
    const p = point(e)
    const now = Math.atan2(p.y - pivotY, p.x - pivotX)
    let deg = turnBase + ((now - turnFrom) * 180) / Math.PI
    if (e.shiftKey) deg = Math.round(deg / TURN_SNAP_DEG) * TURN_SNAP_DEG
    deg = Math.round(deg)
    deg = ((deg % 360) + 360) % 360
    if (deg > 180) deg -= 360
    if (deg) item.rotation = deg
    else delete item.rotation

    showGuides([])
    // Footage restyles in place; an overlay has its turn baked into the clip it
    // compiles to, so until release it is previewed by turning what is drawn.
    if (item.type === 'media' || item.type === 'timeline') reposition(item.id)
    else preview(item.id, { tx: 0, ty: 0, sx: 1, sy: 1, rot: deg - drag.spinDeg })
    drawSelection({ ...drag.box0, rotation: deg, pivotX, pivotY }, `${deg}°`)
  }

  /**
   * Cropping cuts the source's own edges. The handles are the same ones that
   * resize — the mode decides which, because no editor has ever guessed right.
   *
   * A cut is a fraction of the source, so it holds if the shot is swapped for a
   * different resolution; and the edge you are *not* dragging is pinned, so the
   * picture does not slide out from under the cursor.
   */
  function applyCrop(dx, dy, e) {
    const { item, dir, box0, base } = drag
    const d = spin({ x: dx, y: dy }, -drag.spinDeg, 0, 0)
    const kx = Math.max(0.02, 1 - base.crop.left - base.crop.right)
    const ky = Math.max(0.02, 1 - base.crop.top - base.crop.bottom)
    // How wide the whole source would be, in frame pixels, at this size.
    const ew = box0.w / kx, eh = box0.h / ky

    const next = { ...base.crop }
    if (dir.includes('w')) next.left = base.crop.left + d.x / ew
    if (dir.includes('e')) next.right = base.crop.right - d.x / ew
    if (dir.includes('n')) next.top = base.crop.top + d.y / eh
    if (dir.includes('s')) next.bottom = base.crop.bottom - d.y / eh
    for (const key of ['top', 'right', 'bottom', 'left']) next[key] = clamp(next[key], 0, 0.95)
    if (1 - next.left - next.right < 0.04) { next.left = base.crop.left; next.right = base.crop.right }
    if (1 - next.top - next.bottom < 0.04) { next.top = base.crop.top; next.bottom = base.crop.bottom }

    item.crop = next
    if (!cropOf(item)) delete item.crop

    // Freely placed footage would otherwise slide as its box shrinks: pin the
    // edge opposite the one being dragged.
    const after = layerBox(item, ctx())
    if (after && item.fit === 'none') {
      const x = dir.includes('w') ? box0.x + box0.w - after.w : box0.x
      const y = dir.includes('n') ? box0.y + box0.h - after.h : box0.y
      placeLayerBox(item, x, y, after.w, after.h)
    }
    reposition(item.id)
    showGuides([])
    const shown = layerBox(item, ctx()) ?? box0
    drag.pending = { x: shown.x, y: shown.y, w: shown.w, h: shown.h }
    drawSelection({ ...shown, rotation: drag.spinDeg, pivotX: shown.x + shown.w / 2, pivotY: shown.y + shown.h / 2 },
      `${Math.round(shown.w)} × ${Math.round(shown.h)}`)
  }

  /**
   * Resize about the handle's opposite corner — or about the centre with ⌥.
   *
   * Corners keep the aspect ratio (⇧ frees them); edges stretch one dimension,
   * which only a `box` item has. `scale` and `type` items are uniform by
   * definition, so their edges are inert.
   */
  function applyResize(dxRaw, dyRaw, e) {
    const { item, dir, mode, box0, frame0, ink, base } = drag
    // The handles sit on a turned box, so the pointer is turned into the box's
    // own upright frame first and every line below is written as if straight.
    const d = spin({ x: dxRaw, y: dyRaw }, -drag.spinDeg, 0, 0)
    const dx = d.x, dy = d.y
    const uniform = mode !== 'box'
    const corner = CORNERS.has(dir)
    if (uniform && !corner) return

    const lock = corner && (uniform || !e.shiftKey)
    const fromCentre = e.altKey

    let x0 = box0.x, y0 = box0.y, x1 = box0.x + box0.w, y1 = box0.y + box0.h
    if (dir.includes('w')) x0 += dx
    if (dir.includes('e')) x1 += dx
    if (dir.includes('n')) y0 += dy
    if (dir.includes('s')) y1 += dy

    let w = Math.max(MIN_PX, x1 - x0)
    let h = Math.max(MIN_PX, y1 - y0)

    if (lock) {
      // The corner cannot be both under the pointer and on the diagonal, so put
      // it at the closest point of the diagonal — the projection. Taking the
      // larger of the two ratios instead makes a box that outruns the cursor.
      const t = (w * box0.w + h * box0.h) / (box0.w * box0.w + box0.h * box0.h)
      w = Math.max(MIN_PX, box0.w * t)
      h = Math.max(MIN_PX, box0.h * t)
    }

    // Which corner stays put: the one the handle is not on.
    let x = dir.includes('w') ? x1 - w : x0
    let y = dir.includes('n') ? y1 - h : y0
    if (!dir.includes('w') && !dir.includes('e')) x = box0.x + (box0.w - w) / 2
    if (!dir.includes('n') && !dir.includes('s')) y = box0.y + (box0.h - h) / 2
    if (fromCentre) {
      x = box0.x + box0.w / 2 - w / 2
      y = box0.y + box0.h / 2 - h / 2
    }

    // Turning is about the box's middle, so a box that changes size turns about
    // a different point — nudge it back so the corner you are not dragging
    // stays where it looks like it is.
    if (drag.spinDeg) {
      const fx = dir.includes('w') ? box0.x + box0.w : dir.includes('e') ? box0.x : box0.x + box0.w / 2
      const fy = dir.includes('n') ? box0.y + box0.h : dir.includes('s') ? box0.y : box0.y + box0.h / 2
      const p0 = spin({ x: fx, y: fy }, drag.spinDeg, box0.x + box0.w / 2, box0.y + box0.h / 2)
      const p1 = spin({ x: fx, y: fy }, drag.spinDeg, x + w / 2, y + h / 2)
      x += p0.x - p1.x
      y += p0.y - p1.y
    }

    showGuides([])

    let label = ''
    if (mode === 'box') {
      const size = { width: even(w), height: even(h) }
      if (item.type === 'image') item.imageStyle = { ...(item.imageStyle ?? {}), ...size }
      else item.textStyle = { ...(item.textStyle ?? {}), ...size }
      placeLayerBox(item, x, y, size.width, size.height)
      drag.pending = { x, y, w: size.width, h: size.height }
      label = `${size.width} × ${size.height}`
    } else if (mode === 'scale') {
      item.scale = clamp(base.scale * (w / box0.w), SCALE_MIN, SCALE_MAX)
      // The ratio that survived the clamp, so the box drawn is the box rendered.
      const r = item.scale / base.scale
      const fw = frame0.w * r, fh = frame0.h * r
      placeLayerBox(item, x - ink.x * fw, y - ink.y * fh, fw, fh)
      drag.pending = { x, y, w: box0.w * r, h: box0.h * r }
      label = `${Math.round(item.scale * 100)}%`
    } else {
      const size = Math.max(6, Math.round(base.fontSize * (w / box0.w)))
      if (item.type === 'caption') item.captionStyle = { ...(item.captionStyle ?? {}), fontSize: size }
      else item.textStyle = { ...(item.textStyle ?? {}), fontSize: size }
      // Type grows about its own middle inside a clip whose size does not
      // change, so this is a prediction; the ink is measured again on release.
      const r = size / base.fontSize
      const cx = box0.x + box0.w / 2, cy = box0.y + box0.h / 2
      drag.pending = { x: cx - (box0.w * r) / 2, y: cy - (box0.h * r) / 2, w: box0.w * r, h: box0.h * r }
      label = `${size}px type`
    }

    // Recompiling the clip on every pointer event would flicker, so the layer
    // is painted through a transform and written for real on release. The
    // element is the *frame*; solve for the transform that lands its ink on
    // the rectangle the pointer is drawing.
    const p = drag.pending
    const sx = p.w / box0.w, sy = p.h / box0.h
    preview(item.id, {
      tx: p.x - frame0.x - (box0.x - frame0.x) * sx,
      ty: p.y - frame0.y - (box0.y - frame0.y) * sy,
      sx,
      sy,
    })
    drawSelection({ ...p, rotation: drag.spinDeg, pivotX: p.x + p.w / 2, pivotY: p.y + p.h / 2 }, label)
  }

  function endDrag() {
    if (!drag) return
    const { item, dirty, mode, pending } = drag
    // A `scale` preview transforms the layer about its own top-left, which is
    // not where the frame ends up; only the real geometry is right, so clear
    // the transform before the rebuild rather than after it.
    preview(item.id, null)
    drag = null
    root.classList.remove('dragging')
    showGuides([])
    if (mode !== 'move' && pending) {
      // The transform is gone and the rebuild has not happened yet; keep the
      // rectangle where the pointer left it so nothing flashes back.
      drawSelection(pending, '')
      lastInk.set(item.id, { ...pending, painted: true, fills: false, at: Date.now() })
    }
    // Which fields this gesture wrote, so a keyed item gets keys on them.
    if (dirty) onCommit?.(mode === 'move' ? ['offsetX', 'offsetY'] : ['offsetX', 'offsetY', 'scale'])
    else render()
  }

  /* -------------------------------------------------------------- painting */

  function drawSelection(box, label) {
    const s = k()
    sel.hidden = false
    sel.style.left = `${box.x * s}px`
    sel.style.top = `${box.y * s}px`
    sel.style.width = `${box.w * s}px`
    sel.style.height = `${box.h * s}px`
    // Drawn upright and then turned about the same point the layer turns about,
    // so the handles sit on the corners of the picture, not of the box round it.
    const deg = box.rotation ?? 0
    if (deg) {
      sel.style.transform = `rotate(${deg}deg)`
      sel.style.transformOrigin = `${((box.pivotX ?? box.x + box.w / 2) - box.x) * s}px ${((box.pivotY ?? box.y + box.h / 2) - box.y) * s}px`
    } else {
      sel.style.transform = ''
      sel.style.transformOrigin = ''
    }
    // The readout must stay upright even when what it describes is not.
    chip.style.transform = deg ? `translate(-50%, 6px) rotate(${-deg}deg)` : ''
    chip.textContent = label ?? ''
    chip.hidden = !label
  }

  /**
   * The route a keyed layer takes, through the middle of its box at each key.
   *
   * Drawn because a list of numbers in a panel does not tell you that a title
   * is about to fly off the frame, and a line through the picture does.
   */
  function drawPath(item) {
    path.replaceChildren()
    if (!item || !anyKeyed(item) || (!keysFor(item, 'offsetX') && !keysFor(item, 'offsetY'))) return
    const s = k()
    const stops = keyTimes(item)
    if (stops.length < 2) return
    const pts = []
    for (const ms of stops) {
      const b = layerBox(item, ctx(), item.startMs + ms)
      if (b) pts.push([(b.x + b.w / 2) * s, (b.y + b.h / 2) * s])
    }
    if (pts.length < 2) return
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    line.setAttribute('points', pts.map((p) => p.join(',')).join(' '))
    line.setAttribute('class', 'st-path-line')
    path.appendChild(line)
    for (const [x, y] of pts) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      dot.setAttribute('cx', x)
      dot.setAttribute('cy', y)
      dot.setAttribute('r', 3.5)
      dot.setAttribute('class', 'st-path-dot')
      path.appendChild(dot)
    }
  }

  /** Redraw the selection from the document. Cheap enough to call freely. */
  function render() {
    if (drag) return
    const { seq } = ctx()
    const item = sole()
    if (!seq || !item || suppressed) {
      sel.hidden = true
      hover.hidden = true
      showGuides([])
      path.replaceChildren()
      return
    }
    const t = getTime()
    if (t < item.startMs || t >= item.startMs + item.durationMs) {
      sel.hidden = true
      return
    }
    const fresh = boxOf(item.id)
    if (!fresh) {
      sel.hidden = true
      return
    }
    // A clip that has just been recompiled has no document to measure yet. Show
    // where it was until it reports back, rather than flashing out to its frame.
    let box = fresh
    clearTimeout(settleTimer)
    if (fresh.painted) lastInk.set(item.id, { ...fresh, at: Date.now() })
    else {
      const held = lastInk.get(item.id)
      if (held && Date.now() - held.at < 2000) {
        box = held
        settleTimer = setTimeout(render, 100)
      }
    }

    const mode = cropping ? 'crop' : resizeMode(item)
    sel.dataset.mode = mode
    sel.classList.toggle('cropping', cropping)
    drawPath(item)
    // Footage that fills the frame has nothing to grab until it is placed
    // freely, which the first drag does — so the handles are shown, not hidden.
    sel.classList.toggle('fills', !!box.fills)
    drawSelection(box, '')
  }

  /* -------------------------------------------------------------- pointers */

  const onDown = (e) => {
    if (e.button !== 0) return
    const h = e.target.closest?.('.st-h')
    beginDrag(e, h?.dataset.dir ?? null)
  }

  const onMove = (e) => {
    if (drag) {
      moveDrag(e)
      return
    }
    if (suppressed || e.target.closest?.('.st-h')) {
      hover.hidden = true
      return
    }
    const hit = pick(point(e))
    root.style.cursor = hit ? 'move' : 'default'
    if (!hit || hit.item.id === sole()?.id) {
      hover.hidden = true
      return
    }
    const s = k()
    hover.hidden = false
    hover.style.left = `${hit.box.x * s}px`
    hover.style.top = `${hit.box.y * s}px`
    hover.style.width = `${hit.box.w * s}px`
    hover.style.height = `${hit.box.h * s}px`
    hover.dataset.name = hit.item.name ?? ''
  }

  const onUp = () => endDrag()
  const onLeave = () => {
    if (!drag) hover.hidden = true
  }

  root.addEventListener('pointerdown', onDown)
  root.addEventListener('pointermove', onMove)
  root.addEventListener('pointerup', onUp)
  root.addEventListener('pointercancel', onUp)
  root.addEventListener('pointerleave', onLeave)
  root.addEventListener('dblclick', (e) => {
    const hit = pick(point(e))
    if (hit) onSelect(hit.item, { open: true })
  })

  return {
    render,

    /** Swap what the handles do: cut the source's edges instead of resizing. */
    setCropMode(on) {
      cropping = !!on
      render()
    },

    /** Hide the handles while something else owns the stage — playback, a render. */
    suppress(on) {
      if (suppressed === on) return
      suppressed = on
      if (on) endDrag()
      render()
    },

    /** Arrow-key placement, in frame pixels. */
    nudge(dx, dy) {
      const item = sole()
      if (!item) return false
      const t = getTime()
      if (t < item.startMs || t >= item.startMs + item.durationMs) return false
      if (freePlace(item)) onStatus?.(`"${item.name}" is now placed freely — Fit is set to none`)
      item.offsetX = Math.round((item.offsetX ?? 0) + dx)
      item.offsetY = Math.round((item.offsetY ?? 0) + dy)
      return true
    },

    dispose() {
      clearTimeout(settleTimer)
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
      root.removeEventListener('pointerleave', onLeave)
      sel.remove()
      hover.remove()
      guides.remove()
      path.remove()
    },
  }
}
