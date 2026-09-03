/**
 * The transcript editor — every line of a transcript, editable, while the
 * timeline keeps playing.
 *
 * It is a non-modal dialog on the right of the window: the transport, the
 * playhead and the stage stay live, so the workflow is "hear it, fix it".
 * Edits commit per field and write the whole cue list to the server through
 * the library, which keeps an undo stack; the captions on the timeline
 * recompile through `onChanged`. Bulk tools — find and replace, shift, split,
 * merge — go through the same door, one write each.
 *
 * A text fix keeps word-level timings when the word count is unchanged
 * (`rewordCue`), so correcting a misheard word does not throw away karaoke.
 */

import { setTip } from '/tooltip.js'
import { icon, hydrateIcons } from '/icons.js'
import { rewordCue } from '/sequence.js'

const $ = (sel, root = document) => root.querySelector(sel)
const h = (tag, cls, text) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text != null) el.textContent = text
  return el
}
const secs = (ms) => (ms / 1000).toFixed(2)
const clock = (ms) => {
  const s = Math.max(0, ms) / 1000
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function initTranscriptEditor({ lib, status, onChanged, seekToSource, currentSourceMs, mediaChoices, onExport = null }) {
  let open = null // { id, t, filter, follow, nowIndex, focus }
  let dlg = null
  let ui = null

  function build() {
    dlg = h('dialog', 'dlg tre-dlg')
    dlg.innerHTML = `
      <div class="tre-head">
        <input class="tre-name" type="text" spellcheck="false" data-tip="The transcript's name. Enter to rename.">
        <span class="tre-meta"></span>
        <button class="btn ghost small tre-export" data-tip="Export these lines as SRT, VTT or plain text — the section in timeline time, or the whole transcript in source time.">Export…</button>
        <button class="btn ghost small tre-close" data-tip="Close the editor. Everything is already saved." data-tip-key="Esc">Close</button>
      </div>
      <div class="tre-scope hidden">
        <div class="seg" role="radiogroup">
          <button class="seg-btn active" data-scope="section" data-tip="Only the lines inside the selected caption item, with times as they fall on the timeline.">This section</button>
          <button class="seg-btn" data-scope="all" data-tip="Every line of the transcript, in source seconds.">Whole transcript</button>
        </div>
        <span class="tre-scope-note"></span>
      </div>
      <div class="tre-tools">
        <input class="tre-search" type="search" placeholder="Search the words…" spellcheck="false" data-tip="Show only the lines containing this. Clear to see them all.">
        <label class="check tre-follow" data-tip="Keep the line under the playhead in view while the timeline plays."><input type="checkbox" checked> follow</label>
        <label class="tre-link" data-tip="The media these times belong to. Linking lets the play button and the playhead find the right moment.">linked to <select class="tre-media"></select></label>
      </div>
      <div class="tre-tools tre-bulk">
        <input class="tre-find" type="text" placeholder="find" spellcheck="false" data-tip="Text to find in every line (case-insensitive).">
        <input class="tre-repl" type="text" placeholder="replace with" spellcheck="false" data-tip="What to put in its place. Word timings survive when the number of words stays the same.">
        <button class="btn small tre-replace" data-tip="Replace in every line. One undo step.">Replace all</button>
        <span class="tre-sep"></span>
        <input class="tre-shift" type="number" step="0.1" value="0" data-tip="Seconds to add to every line (negative moves earlier). For a transcript that is off by a constant."> s
        <button class="btn small tre-shift-go" data-tip="Shift every line and word by that much.">Shift all</button>
        <span class="tre-sep"></span>
        <button class="btn small tre-add" data-tip="Add a two-second line at the playhead, where this transcript's media is on the timeline."><i data-icon="plus"></i>line at playhead</button>
        <button class="btn small ghost tre-undo" data-tip="Undo the last transcript edit. Transcript edits are outside ⌘Z." disabled>Undo</button>
      </div>
      <div class="tre-list" role="list"></div>
      <div class="tre-foot">Enter commits a line and moves to the next · ⇧Enter makes a line break · times are source seconds · <i data-icon="play" data-icon-size="10"></i> seeks the timeline · <i data-icon="split" data-icon-size="10"></i> splits at the caret · <i data-icon="merge" data-icon-size="10"></i> merges with the next line</div>
    `
    document.body.appendChild(dlg)
    hydrateIcons(dlg)
    ui = {
      export: $('.tre-export', dlg),
      scope: $('.tre-scope', dlg),
      scopeNote: $('.tre-scope-note', dlg),
      name: $('.tre-name', dlg),
      meta: $('.tre-meta', dlg),
      close: $('.tre-close', dlg),
      search: $('.tre-search', dlg),
      follow: $('.tre-follow input', dlg),
      media: $('.tre-media', dlg),
      find: $('.tre-find', dlg),
      repl: $('.tre-repl', dlg),
      replace: $('.tre-replace', dlg),
      shift: $('.tre-shift', dlg),
      shiftGo: $('.tre-shift-go', dlg),
      add: $('.tre-add', dlg),
      undo: $('.tre-undo', dlg),
      list: $('.tre-list', dlg),
    }

    ui.close.onclick = close
    ui.export.onclick = () => onExport?.(open?.section ? { item: open.section.item } : { transcriptId: open?.id })
    for (const b of ui.scope.querySelectorAll('.seg-btn')) {
      b.onclick = () => setScope(b.dataset.scope)
    }
    // The panel is resizable; wrapped lines change height with its width.
    new ResizeObserver(() => { if (open) for (const ta of ui.list.querySelectorAll('textarea')) autosize(ta) }).observe(ui.list)
    dlg.addEventListener('keydown', (e) => {
      e.stopPropagation() // the timeline's shortcuts stay out of the editor
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })
    ui.search.addEventListener('input', () => {
      if (!open) return
      open.filter = ui.search.value.trim().toLowerCase()
      applyFilter()
    })
    ui.follow.addEventListener('change', () => { if (open) open.follow = ui.follow.checked })
    ui.name.addEventListener('change', () => rename(ui.name.value))
    ui.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ui.name.blur() } })
    ui.media.addEventListener('change', () => relink(ui.media.value || null))
    ui.replace.onclick = replaceAll
    ui.shiftGo.onclick = shiftAll
    ui.add.onclick = addAtPlayhead
    ui.undo.onclick = undo
  }

  /* ------------------------------------------------------------ open/close */

  /**
   * `item` is a caption item: the editor opens on its section — only the lines
   * inside its window, with times as they fall on the timeline — and can widen
   * to the whole transcript with the switch in the head.
   */
  async function openEditor(id, { sourceMs = null, item = null } = {}) {
    if (!dlg) build()
    const t = await lib.loadTranscript(id)
    if (!t) throw new Error(`no transcript "${id}"`)
    open = { id, t, filter: '', follow: true, nowIndex: -1, focus: null, section: null, scope: 'all' }
    if (item && item.type === 'caption' && item.sourceId === id) {
      open.section = { item, fromMs: item.inMs, toMs: item.inMs + item.durationMs, offsetMs: item.startMs - item.inMs }
      open.scope = 'section'
    }
    ui.scope.classList.toggle('hidden', !open.section)
    for (const b of ui.scope.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.scope === open.scope)
    ui.search.value = ''
    ui.follow.checked = true
    // Shown before the rows are built: a textarea only measures itself once
    // it is displayed, and the rows size to their text.
    if (!dlg.open) dlg.show()
    renderHead()
    renderRows()
    if (sourceMs != null) revealSource(sourceMs)
    return t
  }

  function setScope(scope) {
    if (!open || !open.section) return
    open.scope = scope
    for (const b of ui.scope.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.scope === scope)
    renderRows()
  }

  /** Section scope shows timeline seconds; whole-transcript scope shows source seconds. */
  const inSection = () => !!open?.section && open.scope === 'section'
  const shown = (srcMs) => (inSection() ? srcMs + open.section.offsetMs : srcMs)
  const fromShown = (ms) => (inSection() ? ms - open.section.offsetMs : ms)
  const inWindow = (cue) => !inSection() || (cue.endMs > open.section.fromMs && cue.startMs < open.section.toMs)

  function close() {
    if (dlg?.open) dlg.close()
    open = null
  }

  const isOpen = () => !!open && !!dlg?.open

  /* --------------------------------------------------------------- render */

  function renderHead() {
    const t = open.t
    ui.name.value = t.name
    ui.meta.textContent = `${t.source.toUpperCase()} · ${t.cues.length} lines · ${clock(t.durationMs)}${t.wordLevel ? ' · word timings' : ''}`
    ui.media.innerHTML = ''
    const none = h('option', null, 'nothing')
    none.value = ''
    ui.media.appendChild(none)
    for (const m of mediaChoices()) {
      const o = h('option', null, m.name)
      o.value = m.filename
      ui.media.appendChild(o)
    }
    ui.media.value = t.mediaFilename ?? ''
    ui.undo.disabled = !(lib.transcriptHistory.get(open.id)?.length)
  }

  function renderRows() {
    const t = open.t
    const list = ui.list
    list.replaceChildren()
    const frag = document.createDocumentFragment()
    let inside = 0
    t.cues.forEach((cue, index) => {
      if (!inWindow(cue)) return
      inside++
      frag.appendChild(row(cue, index))
    })
    list.appendChild(frag)
    if (open.section) {
      const it = open.section.item
      ui.scopeNote.textContent = inSection()
        ? `${inside} line${inside === 1 ? '' : 's'} · ${clock(it.startMs)}–${clock(it.startMs + it.durationMs)} on the timeline · times below are timeline seconds`
        : `${t.cues.length} lines · times below are source seconds`
    }
    applyFilter()
    // Measure again once laid out: a wrapped line only knows its height then.
    // The timer covers a background tab, where rAF never fires.
    const remeasure = () => { for (const ta of list.querySelectorAll('textarea')) autosize(ta) }
    requestAnimationFrame(remeasure)
    setTimeout(remeasure, 40)
    ui.undo.disabled = !(lib.transcriptHistory.get(open.id)?.length)
    ui.meta.textContent = `${t.source.toUpperCase()} · ${t.cues.length} lines · ${clock(t.durationMs)}${t.wordLevel ? ' · word timings' : ''}`
    if (open.focus) {
      const r = rowAt(open.focus.index)
      const el = r?.querySelector(open.focus.field)
      if (el) {
        el.focus({ preventScroll: true })
        if (el.tagName === 'TEXTAREA' && open.focus.caret != null) el.setSelectionRange(open.focus.caret, open.focus.caret)
      }
      open.focus = null
    }
  }

  function row(cue, index) {
    const r = h('div', 'tre-row')
    r.dataset.index = String(index)
    r.setAttribute('role', 'listitem')

    const num = h('span', 'tre-num', String(index + 1))
    const unit = inSection() ? 'timeline' : 'source'
    const a = h('input', 'tre-time')
    a.type = 'number'
    a.step = '0.05'
    a.min = '0'
    a.value = secs(shown(cue.startMs))
    setTip(a, `Start, in ${unit} seconds.`)
    const b = h('input', 'tre-time')
    b.type = 'number'
    b.step = '0.05'
    b.min = '0'
    b.value = secs(shown(cue.endMs))
    setTip(b, `End, in ${unit} seconds.`)

    const text = h('textarea', 'tre-text')
    text.value = cue.text
    text.rows = 1
    text.spellcheck = true
    autosize(text)
    text.addEventListener('input', () => autosize(text))
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commitText(index, text.value, { next: true })
      }
    })
    text.addEventListener('change', () => commitText(index, text.value))

    a.addEventListener('change', () => commitTime(index, { startMs: Math.round(fromShown(Number(a.value) * 1000)) }))
    b.addEventListener('change', () => commitTime(index, { endMs: Math.round(fromShown(Number(b.value) * 1000)) }))

    const acts = h('div', 'tre-acts')
    const play = h('button', 'tre-btn')
    play.setAttribute('aria-label', 'Seek here')
    play.append(icon('play', { size: 11 }))
    setTip(play, 'Seek the timeline to this line (where its media is placed).')
    play.onclick = () => seek(cue)
    const split = h('button', 'tre-btn')
    split.setAttribute('aria-label', 'Split line')
    split.append(icon('split', { size: 12 }))
    setTip(split, 'Split this line in two at the caret — or in the middle when the caret is elsewhere.')
    split.onclick = () => splitAt(index, document.activeElement === text ? text.selectionStart : null)
    const merge = h('button', 'tre-btn')
    merge.setAttribute('aria-label', 'Merge with the next line')
    merge.append(icon('merge', { size: 12 }))
    setTip(merge, 'Join this line with the next one.')
    merge.disabled = index >= open.t.cues.length - 1
    merge.onclick = () => mergeWithNext(index)
    const del = h('button', 'tre-btn tre-del')
    del.setAttribute('aria-label', 'Delete line')
    del.append(icon('x', { size: 12 }))
    setTip(del, 'Delete this line.')
    del.onclick = () => remove(index)
    acts.append(play, split, merge, del)

    r.append(num, a, b, text, acts)
    return r
  }

  function autosize(ta) {
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(28, Math.min(160, ta.scrollHeight + 2))}px`
  }

  function applyFilter() {
    if (!open) return
    const q = open.filter
    let shown = 0
    for (const r of ui.list.children) {
      const cue = open.t.cues[Number(r.dataset.index)]
      const hit = !q || (cue && cue.text.toLowerCase().includes(q))
      r.hidden = !hit
      if (hit) shown++
    }
    ui.list.dataset.empty = shown ? '' : q ? 'nothing matches' : 'no lines yet'
  }

  /* ---------------------------------------------------------------- edits */

  const cloneCues = () => open.t.cues.map((c) => ({ ...c, words: c.words?.map((w) => ({ ...w })) }))

  async function save(cues, focus = null, message = null) {
    if (!open) return
    try {
      open.t = await lib.saveTranscriptCues(open.id, cues)
      open.focus = focus
      onChanged(open.id)
      renderRows()
      if (message) status(message)
    } catch (err) {
      status(err?.message ?? String(err), 'error')
      renderRows()
    }
  }

  function commitText(index, value, { next = false } = {}) {
    const cues = cloneCues()
    const cue = cues[index]
    if (!cue) return
    const text = value.replace(/\s+\n/g, '\n').trim()
    if (!text) {
      status('a line needs words — delete it with its delete button instead', 'error')
      renderRows()
      return
    }
    if (text === cue.text) {
      if (next) focusRow(index + 1)
      return
    }
    cues[index] = rewordCue(cue, text)
    save(cues, next ? { index: Math.min(index + 1, cues.length - 1), field: 'textarea' } : { index, field: 'textarea', caret: text.length })
  }

  function commitTime(index, patch) {
    const cues = cloneCues()
    const cue = cues[index]
    if (!cue) return
    if (patch.startMs != null) cue.startMs = Math.max(0, patch.startMs)
    if (patch.endMs != null) cue.endMs = patch.endMs
    if (cue.endMs <= cue.startMs) {
      status('a line must end after it starts', 'error')
      renderRows()
      return
    }
    if (cue.words) cue.words = cue.words.filter((w) => w.endMs > cue.startMs && w.startMs < cue.endMs).map((w) => ({ ...w, startMs: Math.max(w.startMs, cue.startMs), endMs: Math.min(w.endMs, cue.endMs) }))
    save(cues, { index, field: patch.startMs != null ? '.tre-time:first-of-type' : '.tre-time:nth-of-type(2)' })
  }

  const rowAt = (index) => ui.list.querySelector(`.tre-row[data-index="${index}"]`)

  function focusRow(index) {
    const r = rowAt(index)
    r?.querySelector('textarea')?.focus()
    r?.scrollIntoView({ block: 'nearest' })
  }

  function splitAt(index, caret) {
    const cue = open.t.cues[index]
    if (!cue) return
    const text = cue.text
    let at = caret
    if (at == null || at <= 0 || at >= text.length) {
      // Middle of the line, at a word boundary.
      const mid = Math.floor(text.length / 2)
      const before = text.lastIndexOf(' ', mid)
      const after = text.indexOf(' ', mid)
      at = before > 0 ? before : after > 0 ? after : -1
    }
    const a = text.slice(0, at).trim()
    const b = text.slice(at).trim()
    if (!a || !b) return status('put the caret between two words to split there', 'error')
    const cues = cloneCues()
    let first, second
    if (cue.words?.length) {
      const k = Math.max(1, Math.min(cue.words.length - 1, a.split(/\s+/).length))
      first = { ...cue, text: a, endMs: cue.words[k - 1].endMs, words: cue.words.slice(0, k) }
      second = { ...cue, text: b, startMs: cue.words[k].startMs, words: cue.words.slice(k) }
    } else {
      const frac = a.length / (a.length + b.length)
      const mid = Math.round(cue.startMs + (cue.endMs - cue.startMs) * frac)
      first = { startMs: cue.startMs, endMs: mid, text: a }
      second = { startMs: mid, endMs: cue.endMs, text: b }
    }
    cues.splice(index, 1, first, second)
    save(cues, { index: index + 1, field: 'textarea', caret: 0 }, `split into "${a.slice(0, 30)}…" and "${b.slice(0, 30)}…"`)
  }

  function mergeWithNext(index) {
    const cues = cloneCues()
    const cue = cues[index]
    const next = cues[index + 1]
    if (!cue || !next) return
    const merged = { startMs: cue.startMs, endMs: Math.max(cue.endMs, next.endMs), text: `${cue.text} ${next.text}`.replace(/\s+/g, ' ') }
    if (cue.words?.length && next.words?.length) merged.words = [...cue.words, ...next.words]
    cues.splice(index, 2, merged)
    save(cues, { index, field: 'textarea' }, 'lines joined')
  }

  function remove(index) {
    const cues = cloneCues()
    const [gone] = cues.splice(index, 1)
    if (!gone) return
    save(cues, { index: Math.min(index, cues.length - 1), field: 'textarea' }, `deleted "${gone.text.slice(0, 40)}"`)
  }

  function replaceAll() {
    const find = ui.find.value
    if (!find) return status('type what to find first', 'error')
    const repl = ui.repl.value
    const re = new RegExp(escapeRe(find), 'gi')
    const cues = cloneCues()
    let lines = 0
    let count = 0
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i]
      const hits = c.text.match(re)
      if (!hits) continue
      lines++
      count += hits.length
      cues[i] = rewordCue(c, c.text.replace(re, repl))
    }
    if (!count) return status(`"${find}" is not in any line`)
    save(cues, null, `replaced ${count} occurrence${count === 1 ? '' : 's'} in ${lines} line${lines === 1 ? '' : 's'}`)
  }

  function shiftAll() {
    const delta = Math.round(Number(ui.shift.value) * 1000)
    if (!delta) return status('enter how many seconds to shift by', 'error')
    const cues = cloneCues().map((c) => ({
      ...c,
      startMs: Math.max(0, c.startMs + delta),
      endMs: Math.max(40, c.endMs + delta),
      words: c.words?.map((w) => ({ ...w, startMs: Math.max(0, w.startMs + delta), endMs: Math.max(0, w.endMs + delta) })),
    }))
    ui.shift.value = '0'
    save(cues, null, `every line moved ${delta > 0 ? 'later' : 'earlier'} by ${Math.abs(delta / 1000).toFixed(2)}s`)
  }

  async function addAtPlayhead() {
    const src = currentSourceMs(open.id)
    if (src == null) return status('put the playhead over this transcript’s media on the timeline first', 'error')
    const cues = cloneCues()
    const startMs = Math.round(src)
    cues.push({ startMs, endMs: startMs + 2000, text: '…' })
    const t = open.t
    await save(cues, null)
    // Focus the new line, wherever normalisation put it.
    const idx = open.t.cues.findIndex((c) => c.startMs === startMs && c.text === '…')
    if (idx >= 0) {
      const r = rowAt(idx)
      const ta = r?.querySelector('textarea')
      if (ta) { ta.focus(); ta.select(); r.scrollIntoView({ block: 'nearest' }) }
    }
    void t
  }

  async function undo() {
    try {
      const t = await lib.undoTranscript(open.id)
      if (!t) return status('nothing to undo')
      open.t = t
      onChanged(open.id)
      renderRows()
      status('transcript edit undone')
    } catch (err) {
      status(err?.message ?? String(err), 'error')
    }
  }

  async function rename(name) {
    const clean = name.trim()
    if (!clean || clean === open.t.name) { ui.name.value = open.t.name; return }
    try {
      open.t = await lib.updateTranscript(open.id, { name: clean })
      status(`renamed to "${clean}"`)
    } catch (err) {
      status(err?.message ?? String(err), 'error')
      ui.name.value = open.t.name
    }
  }

  async function relink(filename) {
    try {
      open.t = await lib.updateTranscript(open.id, { mediaFilename: filename })
      onChanged(open.id)
      status(filename ? `linked to ${mediaChoices().find((m) => m.filename === filename)?.name ?? filename}` : 'unlinked from its media')
    } catch (err) {
      status(err?.message ?? String(err), 'error')
      ui.media.value = open.t.mediaFilename ?? ''
    }
  }

  async function seek(cue) {
    const ok = await seekToSource(open.id, cue.startMs)
    if (!ok) status('this transcript’s media is not on the open timeline, so there is nowhere to seek', 'error')
  }

  /* ------------------------------------------------------------ following */

  function revealSource(srcMs) {
    const idx = open.t.cues.findIndex((c) => srcMs >= c.startMs && srcMs < c.endMs)
    if (idx < 0) return
    markNow(idx, true)
  }

  function markNow(idx, scroll) {
    if (!open) return
    if (idx === open.nowIndex && !scroll) return
    open.nowIndex = idx
    for (const r of ui.list.children) r.classList.toggle('now', Number(r.dataset.index) === idx)
    if (idx >= 0 && (scroll || open.follow)) {
      const r = rowAt(idx)
      // Never yank the list while the user is typing in it.
      if (r && !ui.list.contains(document.activeElement)) r.scrollIntoView({ block: 'center' })
    }
  }

  /** Called every frame by the app while the timeline plays; cheap when nothing changed. */
  function tick() {
    if (!isOpen()) return
    const src = currentSourceMs(open.id)
    if (src == null) { markNow(-1); return }
    const idx = open.t.cues.findIndex((c) => src >= c.startMs && src < c.endMs)
    markNow(idx)
  }

  return { open: openEditor, close, isOpen, tick, get current() { return open?.id ?? null } }
}
