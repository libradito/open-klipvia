/**
 * Tooltips driven by a `data-tip` attribute.
 *
 * Native `title` waits about a second, cannot be styled, cannot show a keyboard
 * shortcut, and is unreadable on a dark UI. This is a single reused element
 * placed by measurement, with a short delay that drops to zero once a tooltip is
 * already open — so sweeping along a toolbar feels continuous rather than
 * flickering one delay per button.
 *
 *   data-tip      the text; "\n" starts a new line
 *   data-tip-key  optional shortcut rendered as a chip, e.g. "⌘E"
 *   data-tip-at   "top" (default) | "bottom" | "right"
 */

const DELAY = 320
const GAP = 9

let tip = null
let timer = null
let current = null
let warm = false // a tooltip is already open, so show the next one instantly

function ensure() {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  return tip
}

function place(el) {
  const t = ensure()
  const r = el.getBoundingClientRect()
  const b = t.getBoundingClientRect()
  const at = el.dataset.tipAt || 'top'

  let top
  let left = r.left + r.width / 2 - b.width / 2

  if (at === 'right') {
    left = r.right + GAP
    top = r.top + r.height / 2 - b.height / 2
  } else if (at === 'bottom' || r.top - b.height - GAP < 4) {
    top = r.bottom + GAP
    t.dataset.flip = 'down'
  } else {
    top = r.top - b.height - GAP
    t.dataset.flip = 'up'
  }

  // Keep it fully on screen.
  left = Math.max(6, Math.min(window.innerWidth - b.width - 6, left))
  top = Math.max(6, Math.min(window.innerHeight - b.height - 6, top))

  t.style.left = `${Math.round(left)}px`
  t.style.top = `${Math.round(top)}px`
}

function show(el) {
  const text = el.dataset.tip
  if (!text) return
  const t = ensure()

  t.innerHTML = ''
  // Accept both a real newline (JS template literals) and a literal \n
  // sequence, which is what you get when writing data-tip in HTML.
  for (const line of text.split(/\\n|\n/)) {
    const p = document.createElement('div')
    p.className = 'tip-line'
    p.textContent = line
    t.appendChild(p)
  }
  if (el.dataset.tipKey) {
    const k = document.createElement('kbd')
    k.textContent = el.dataset.tipKey
    t.appendChild(k)
  }

  t.classList.add('on')
  place(el)
  current = el
  warm = true
}

function hide() {
  clearTimeout(timer)
  timer = null
  current = null
  if (tip) tip.classList.remove('on')
  // Stay warm briefly so moving to a neighbouring control is instant.
  setTimeout(() => {
    if (!current) warm = false
  }, 260)
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    const el = e.target?.closest?.('[data-tip]')
    if (!el || el === current) return
    clearTimeout(timer)
    if (warm) show(el)
    else timer = setTimeout(() => show(el), DELAY)
  })

  document.addEventListener('pointerout', (e) => {
    const el = e.target?.closest?.('[data-tip]')
    if (!el) return
    if (e.relatedTarget?.closest?.('[data-tip]') === el) return
    hide()
  })

  // A tooltip during a drag, a click or a scroll is only ever in the way.
  for (const ev of ['pointerdown', 'wheel', 'scroll']) {
    document.addEventListener(ev, hide, { capture: true, passive: true })
  }
  document.addEventListener('keydown', hide)

  // Keyboard users get them too.
  document.addEventListener('focusin', (e) => {
    const el = e.target?.closest?.('[data-tip]')
    if (el) show(el)
  })
  document.addEventListener('focusout', hide)
}

/** Set a tooltip on a dynamically built element. */
export function setTip(el, text, { key, at } = {}) {
  if (text == null) {
    delete el.dataset.tip
    return el
  }
  el.dataset.tip = text
  if (key) el.dataset.tipKey = key
  if (at) el.dataset.tipAt = at
  el.removeAttribute('title') // never both
  return el
}
