/**
 * What a clip actually paints, as opposed to how big its frame is.
 *
 * A title compiles to a clip the size of the whole frame with a few words in
 * the middle of it. Its *box* is 1920×1080; its *ink* is a line of type. Every
 * part of the editor that wants to point at an overlay — the lint pass that
 * asks whether two things collide, and the stage handles that let you grab one
 * — needs the ink, not the box, so the measurement lives here and both use it.
 */

export function unionRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/**
 * The union of everything visible in `doc`, in clip pixels, clipped to the
 * clip's own frame. Null when the document paints nothing at this moment.
 *
 * "Visible" is deliberately generous — text, a fill, a border, a shadow, an
 * image — because a box that is merely a layout container is not what anyone
 * is pointing at, and a nearly-transparent one is not what anyone can see.
 */
export function paintedBounds(doc, clip, { straight = false } = {}) {
  const win = doc.defaultView
  if (!win || !doc.body) return null

  // A turned clip is painted through a transform on its own body, so every rect
  // measured inside it comes back as the *box round* the turned ink — useless
  // for drawing a handle on a corner. `straight` puts the turn back to zero for
  // the length of the measurement, which costs one forced layout of one small
  // document and gives the ink as it would be if the layer were upright.
  const body = doc.body
  const plain = straight ? body.dataset.plainTransform : null
  const was = plain ? body.style.transform : null
  if (plain) body.style.transform = plain

  try {
    return measure(doc, win, clip)
  } finally {
    if (plain) body.style.transform = was
  }
}

function measure(doc, win, clip) {
  const clear = (c) => !c || c === 'transparent' || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(c)
  let out = null
  for (const el of doc.body.querySelectorAll('*')) {
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    let o = 1
    for (let n = el; n && n.nodeType === 1 && o >= 0.06; n = n.parentElement) o *= parseFloat(win.getComputedStyle(n).opacity)
    if (o < 0.06) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    const paints =
      hasText ||
      !clear(cs.backgroundColor) ||
      (cs.backgroundImage && cs.backgroundImage !== 'none') ||
      (parseFloat(cs.borderTopWidth) > 0 && !clear(cs.borderTopColor)) ||
      (parseFloat(cs.borderBottomWidth) > 0 && !clear(cs.borderBottomColor)) ||
      (cs.boxShadow && cs.boxShadow !== 'none') ||
      /^(IMG|CANVAS|SVG|VIDEO)$/.test(el.tagName)
    if (!paints) continue
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top)
    const x1 = Math.min(clip.width, r.right), y1 = Math.min(clip.height, r.bottom)
    if (x1 <= x0 || y1 <= y0) continue
    const rr = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    out = out ? unionRect(out, rr) : rr
  }
  return out
}
