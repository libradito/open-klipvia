/**
 * Collapsible sections — the inspector's and the rails'.
 *
 * One shell, used everywhere a panel has more in it than fits:
 *
 *   <section class="insp-section" data-section="text">
 *     <button class="insp-section-head" type="button" aria-expanded="true">
 *       <i data-icon="type"></i><span>Text</span>
 *       <span class="insp-section-meta"></span>
 *       <i data-icon="chevron-down" class="chev"></i>
 *     </button>
 *     <div class="insp-section-body">…</div>
 *   </section>
 *
 * A click on the head folds the body; ⌥-click keeps this one open and folds
 * every other section under the same root (⌥-click again on the only open
 * section unfolds them all). The choice is remembered per `data-section` in
 * localStorage under the key the root was initialised with, so a person who
 * closes Look on Monday finds it closed on Tuesday. A section marked
 * `data-remember="session"` remembers for as long as the page is open, which
 * is what a group wants when the editor also opens and closes it by itself.
 *
 * What is *not* remembered is decided per refresh: `refreshSections` re-reads
 * the defaults it is given, so the same section can start open for one kind
 * of item and closed for another, and a section whose body has nothing
 * visible in it hides altogether rather than offering an empty fold.
 */

import { icon } from '/icons.js'

/** root element -> { storageKey, stored, session, defaults } */
const roots = new WeakMap()

const readStore = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
const writeStore = (key, v) => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode, quota: the fold still works, it just is not remembered */
  }
}

const sectionsOf = (root) => [...root.querySelectorAll('.insp-section[data-section]')]

/** A child counts as visible unless it is folded away by class or attribute. */
const visibleChild = (el) =>
  el.nodeType === 1 && !el.classList.contains('hidden') && !el.hidden && el.style.display !== 'none'

function apply(section, open) {
  const was = !section.classList.contains('collapsed')
  section.classList.toggle('collapsed', !open)
  const head = section.querySelector(':scope > .insp-section-head, :scope > .insp-section-headrow > .insp-section-head')
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false')
  // Whoever laid out the body while it was folded gets a chance to measure.
  if (was !== open) section.dispatchEvent(new CustomEvent('section-toggle', { bubbles: true, detail: { key: section.dataset.section, open } }))
}

/** On screen right now: not folded away by a parent, not display:none. */
const onScreen = (section) => section.getClientRects().length > 0

function chosen(ctx, section) {
  const key = section.dataset.section
  if (section.dataset.remember === 'session') return ctx.session[key]
  return ctx.stored[key]
}

function remember(ctx, section, open) {
  const key = section.dataset.section
  if (section.dataset.remember === 'session') {
    ctx.session[key] = open
    return
  }
  ctx.stored[key] = open
  writeStore(ctx.storageKey, ctx.stored)
}

function isOpen(section) {
  return !section.classList.contains('collapsed')
}

/**
 * Wire every section under `root`. `defaults` maps a `data-section` key to
 * whether it starts open when nothing has been chosen yet; a key not listed
 * starts open. Returns the controller `refreshSections` also finds by root.
 */
export function initSections(root, storageKey, defaults = {}) {
  const ctx = { storageKey, stored: readStore(storageKey), session: {}, defaults: { ...defaults } }
  roots.set(root, ctx)

  root.addEventListener('click', (e) => {
    const head = e.target.closest('.insp-section-head')
    if (!head || !root.contains(head)) return
    const section = head.closest('.insp-section')
    if (!section?.dataset.section) return
    e.preventDefault()

    if (e.altKey) {
      // Only what the person can see takes part: a hidden group must not
      // wake up folded, and a group the editor opens and closes by itself
      // (session-remembered) is not theirs to pin.
      const all = sectionsOf(root).filter(
        (s) => !s.classList.contains('insp-section-empty') && onScreen(s) && s.dataset.remember !== 'session',
      )
      if (!all.includes(section)) return
      const others = all.filter((s) => s !== section)
      // The only open one, ⌥-clicked again: open everything back up.
      const solo = isOpen(section) && others.every((s) => !isOpen(s))
      for (const s of all) {
        const open = solo ? true : s === section
        apply(s, open)
        remember(ctx, s, open)
      }
      return
    }

    const open = !isOpen(section)
    apply(section, open)
    remember(ctx, section, open)
  })

  refreshSections(root)
  return controller(root)
}

/**
 * Re-apply state under `root`: a section with a remembered choice keeps it,
 * any other takes the default given here (else the one given at init, else
 * open), and a section whose body holds nothing visible is hidden. Call it
 * after anything that shows or hides rows inside a section.
 */
export function refreshSections(root, { defaults = null } = {}) {
  const ctx = roots.get(root)
  if (!ctx) return
  const d = defaults ? { ...ctx.defaults, ...defaults } : ctx.defaults
  for (const section of sectionsOf(root)) {
    const key = section.dataset.section
    const body = section.querySelector(':scope > .insp-section-body')
    const empty = !!body && ![...body.children].some(visibleChild)
    section.classList.toggle('insp-section-empty', empty)
    if (empty) continue
    const c = chosen(ctx, section)
    apply(section, c != null ? c : d[key] != null ? !!d[key] : true)
  }
}

function controller(root) {
  const find = (key) => root.querySelector(`.insp-section[data-section="${key}"]`)
  return {
    root,
    /** Whether the person has chosen a state for this section themselves. */
    hasChoice(key) {
      const ctx = roots.get(root)
      const s = find(key)
      return !!(ctx && s) && chosen(ctx, s) != null
    },
    isOpen(key) {
      const s = find(key)
      return !!s && isOpen(s)
    },
    /** Open or close from code. `remember` records it as if the person had. */
    setOpen(key, open, { remember: rem = false } = {}) {
      const ctx = roots.get(root)
      const s = find(key)
      if (!ctx || !s) return
      apply(s, !!open)
      if (rem) remember(ctx, s, !!open)
    },
    /** The small grey summary in the head: "12°", "3 keys", "2 cues · 0:06". */
    meta(key, text) {
      setSectionMeta(find(key), text)
    },
    /** Retitle a head — the Text section reads "Shape" for a shape preset. */
    head(key, { title, icon: name } = {}) {
      setSectionHead(find(key), { title, icon: name })
    },
    refresh(opts) {
      refreshSections(root, opts)
    },
  }
}

export function setSectionMeta(section, text) {
  const meta = section?.querySelector('.insp-section-meta')
  if (meta) meta.textContent = text ?? ''
}

export function setSectionHead(section, { title, icon: name } = {}) {
  const head = section?.querySelector('.insp-section-head')
  if (!head) return
  if (title != null) {
    const span = head.querySelector('.insp-section-title') ?? head.querySelector('span')
    if (span && span.textContent !== title) span.textContent = title
  }
  if (name) {
    // First icon in the head is the section's; the chevron is the last.
    const cur = head.querySelector(':scope > .icon:not(.chev), :scope > i[data-icon]:not(.chev)')
    if (cur && !cur.classList.contains(`icon-${name}`)) cur.replaceWith(icon(name, { size: 14 }))
  }
}
