/**
 * One context menu for the whole editor.
 *
 * A right-click anywhere that has something to say builds a list of items and
 * hands it here. There is a single menu element, positioned in fixed
 * coordinates and flipped to stay on screen; it closes on any pointer-down
 * outside it, on Escape, on scroll, on resize and when the window loses focus.
 * Native menus are left alone wherever text is being edited, because copy and
 * paste live there.
 *
 *   showContextMenu(x, y, items, { title })
 *
 *   items: an array of
 *     '-'                                  a separator
 *     { heading: 'Text' }                  a section label
 *     { label, run, key?, hint?, disabled?, checked?, danger?, confirm? }
 *     { label, swatches: [...colors], value, run(color) }
 *
 *   `confirm` makes a dangerous item ask once: the first click relabels it and
 *   keeps the menu open, the second click runs it. A stray click deletes
 *   nothing, and there is no blocking browser dialog.
 */

let menu = null
let onClose = null

function ensure() {
  if (menu) return menu
  menu = document.createElement('div')
  menu.className = 'cmenu'
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  document.body.appendChild(menu)
  return menu
}

export function closeContextMenu() {
  if (!menu || menu.hidden) return
  menu.hidden = true
  menu.replaceChildren()
  const fn = onClose
  onClose = null
  fn?.()
}

function place(x, y) {
  const m = menu
  const r = m.getBoundingClientRect()
  const W = window.innerWidth
  const H = window.innerHeight
  let left = x
  let top = y
  // Flip rather than clip: a menu that opens off-screen is a menu nobody sees.
  if (left + r.width + 6 > W) left = Math.max(6, x - r.width)
  if (top + r.height + 6 > H) top = Math.max(6, Math.min(y - r.height, H - r.height - 6))
  m.style.left = `${Math.round(left)}px`
  m.style.top = `${Math.round(top)}px`
}

function buttonFor(item) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'cmenu-item'
  b.setAttribute('role', 'menuitem')
  if (item.danger) b.classList.add('danger')
  if (item.disabled) b.disabled = true
  if (item.checked) b.classList.add('checked')

  const label = document.createElement('span')
  label.className = 'cmenu-label'
  label.textContent = item.label
  b.appendChild(label)
  if (item.key) {
    const k = document.createElement('kbd')
    k.textContent = item.key
    b.appendChild(k)
  }
  if (item.hint) b.dataset.tip = item.hint

  let armed = false
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    if (b.disabled) return
    if (item.confirm && !armed) {
      armed = true
      b.classList.add('arming')
      label.textContent = typeof item.confirm === 'string' ? item.confirm : `Really ${item.label.toLowerCase()}?`
      return
    }
    closeContextMenu()
    Promise.resolve(item.run?.()).catch((err) => console.warn('[menu]', err))
  })
  return b
}

function swatchRow(item) {
  const row = document.createElement('div')
  row.className = 'cmenu-swatches'
  if (item.label) {
    const l = document.createElement('span')
    l.className = 'cmenu-swatch-label'
    l.textContent = item.label
    row.appendChild(l)
  }
  for (const color of item.swatches) {
    const s = document.createElement('button')
    s.type = 'button'
    s.className = 'cmenu-swatch' + (color === item.value ? ' on' : '')
    s.style.background = color || 'transparent'
    if (!color) s.classList.add('none')
    s.dataset.tip = color ? color : 'No colour'
    s.addEventListener('click', (e) => {
      e.stopPropagation()
      closeContextMenu()
      Promise.resolve(item.run?.(color)).catch((err) => console.warn('[menu]', err))
    })
    row.appendChild(s)
  }
  return row
}

export function showContextMenu(x, y, items, { title, onClose: closeFn } = {}) {
  closeContextMenu()
  const m = ensure()
  onClose = closeFn ?? null

  if (title) {
    const t = document.createElement('div')
    t.className = 'cmenu-title'
    t.textContent = title
    m.appendChild(t)
  }

  let lastSep = true
  for (const item of items.filter(Boolean)) {
    if (item === '-') {
      if (lastSep) continue
      const s = document.createElement('div')
      s.className = 'cmenu-sep'
      m.appendChild(s)
      lastSep = true
      continue
    }
    if (item.heading) {
      const h = document.createElement('div')
      h.className = 'cmenu-heading'
      h.textContent = item.heading
      m.appendChild(h)
      lastSep = true
      continue
    }
    m.appendChild(item.swatches ? swatchRow(item) : buttonFor(item))
    lastSep = false
  }
  if (m.lastElementChild?.classList.contains('cmenu-sep')) m.lastElementChild.remove()

  m.hidden = false
  m.style.left = '0px'
  m.style.top = '0px'
  place(x, y)
  m.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  return m
}

export function contextMenuOpen() {
  return !!menu && !menu.hidden
}

function moveFocus(dir) {
  const buttons = [...menu.querySelectorAll('.cmenu-item:not(:disabled)')]
  if (!buttons.length) return
  const at = buttons.indexOf(document.activeElement)
  const next = at < 0 ? (dir > 0 ? 0 : buttons.length - 1) : (at + dir + buttons.length) % buttons.length
  buttons[next].focus({ preventScroll: true })
}

export function initContextMenu() {
  ensure()
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (menu.hidden || e.target.closest?.('.cmenu')) return
      closeContextMenu()
    },
    { capture: true },
  )
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeContextMenu()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      moveFocus(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Tab') {
      closeContextMenu()
    }
  }, { capture: true })
  for (const ev of ['scroll', 'wheel']) document.addEventListener(ev, closeContextMenu, { capture: true, passive: true })
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
}
