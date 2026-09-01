import { createRasterizer } from '/rasterize.js'
import { studioExport, quickExport, formatBytes } from '/export.js'
import { SNIPPETS } from '/snippets.js'
import { initWebMcp } from '/webmcp.js'
import { initIntegrations } from '/integrations.js'
import * as INTEGRATIONS from '/integrations.js'
import * as SPEECH from '/speech.js'
import { initAssets, snippetFor } from '/assets.js'
import { attachEditor } from '/editor.js'
import { initTooltips, setTip } from '/tooltip.js'
import { showContextMenu, closeContextMenu, initContextMenu, contextMenuOpen } from '/contextmenu.js'
import { buildStageDoc, setLocalMode, setRuntimeSource, withOffscreenClip } from '/stagehost.js'
import { initMediaLibrary, fmtClock } from '/medialib.js'
import { initTranscriptEditor } from '/transcript-editor.js'
import { createCompositor } from '/composite.js'
import { createTimeline } from '/timeline.js'
import { createStageTools } from '/stagetools.js'
import { paintedBounds, unionRect } from '/bounds.js'
import * as FX from '/effects.js'
import * as KEYS from '/keys.js'
import * as LOCAL from '/localstore.js'
import { renderSequence, renderOverlayItem, describeRender } from '/seqrender.js'
import * as SEQ from '/sequence.js'
import { TEXT_PRESETS, textPreset, defaultTextStyle } from '/textpresets.js'

const $ = (id) => document.getElementById(id)

/* --------------------------------------------------------------- app state */

const state = {
  project: null,
  clipIndex: 0,
  formats: [],
  iframe: null,
  raster: null,
  playing: false,
  exporting: false,
  abort: null,
  runtimeSrc: '',
  zoom: 'fit',
  assets: null,
  thumbs: new Map(),

  /* timeline mode */
  mode: 'clip',
  seqIndex: 0,
  lib: null,
  compositor: null,
  timeline: null,
  selectedItem: null,
  /** True when there is no server behind this page and the browser is the back end. */
  local: false,
  /** Set when this load created the demo, so the "ask an agent" card shows once. */
  seededDemo: false,
  /** Transcription and voice: the panel, and the two jobs it enables. */
  speech: null,
  stageTools: null,
  cropMode: false,
  selectedItems: [],
  selectedTrack: null,
  seqExporting: false,
  seqAbort: null,
  rail: 'clips',

  /** media filename -> silent source ranges, at the current silence params */
  silence: new Map(),
  silenceParams: { ...SEQ.SILENCE_DEFAULTS },
  showSilence: true,
}

const currentSequence = () => state.project?.sequences?.[state.seqIndex] ?? null

const currentClip = () => state.project?.clips[state.clipIndex] ?? null

/* ------------------------------------------------------------------ saving */

let saveTimer = null
const dirty = { timelines: new Set(), project: false }
let saving = false
let saveAgain = false

/* ------------------------------------------------------------------ scope */

/**
 * Which timeline a tool call means. A tool that names a `timelineId` works
 * there without opening it — the view stays where the person left it, and an
 * agent can cut a section while another agent, or a hand, is on the main
 * timeline. Without one, the open timeline. Set for the length of one call.
 */
const scope = { id: null }

function scopedSequence() {
  if (scope.id) {
    const t = timelineById(scope.id)
    if (!t) throw new Error(`no timeline "${scope.id}". Use list_timelines.`)
    return t
  }
  return currentSequence()
}

/**
 * An edit to one timeline, wherever it lives: saved, on its own undo stack,
 * and redrawn if it is on screen — directly, or through a block that plays it.
 */
function commit(seq) {
  if (!seq) return
  markTimelineDirty(seq)
  historyCaptureFor(seq)
  const open = currentSequence()
  if (open === seq || (open && SEQ.nestedTimelineIds(seqContext().timelines, open.id).has(seq.id))) refreshSequence()
  renderTimelineRail?.()
}

/**
 * The project itself changed: clips, its name, the order of timelines. Only
 * that. A clip edit used to dirty the open timeline as well, so an agent
 * patching sixty clips re-saved whatever lesson happened to be open sixty
 * times — and any second agent working there met sixty stale revisions.
 * Timeline edits go through `commit(seq)` or `markTimelineDirty(seq)`.
 */
function markDirty() {
  dirty.project = true
  scheduleSave()
}

function markTimelineDirty(seq) {
  if (seq) dirty.timelines.add(seq.id)
  scheduleSave()
}

function scheduleSave() {
  $('saveState').textContent = 'saving…'
  $('saveState').classList.add('dirty')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 700)
}

const timelineById = (id) => (state.project?.sequences ?? []).find((t) => t.id === id) ?? null

/**
 * Each timeline is its own document with a revision. A write that does not
 * carry the current revision is refused with what is on disk — another tab,
 * or another agent, got there first — and nothing is thrown away: the local
 * version goes onto that timeline's undo stack before the server's copy is
 * adopted, so ⌘Z is "keep mine".
 */
/** Flush whatever is pending and resolve when the store actually has it. */
async function saveNow() {
  await save()
  // `save` reschedules itself when a write arrived while it was running.
  if (saveAgain) await save()
}

async function save() {
  if (!state.project) return
  if (saving) {
    saveAgain = true
    return
  }
  saving = true
  let failed = false
  try {
    for (const id of [...dirty.timelines]) {
      const seq = timelineById(id)
      dirty.timelines.delete(id)
      if (!seq) continue
      const res = await fetch(`/api/timelines/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(seq),
      })
      if (res.status === 409) {
        const { current } = await res.json()
        adoptStaleTimeline(seq, current)
        continue
      }
      if (!res.ok) {
        failed = true
        dirty.timelines.add(id)
        continue
      }
      const saved = await res.json()
      seq.rev = saved.rev
      seq.updatedAt = saved.updatedAt
    }
    if (dirty.project) {
      dirty.project = false
      const res = await fetch(`/api/projects/${state.project.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: state.project.name,
          clips: state.project.clips,
          timelineIds: state.project.timelineIds,
          mainTimelineId: state.project.mainTimelineId,
        }),
      })
      if (!res.ok) {
        failed = true
        dirty.project = true
      }
    }
    localStorage.setItem('animationhtml:last', state.project.id)
    $('saveState').textContent = failed ? 'save failed' : 'saved'
    $('saveState').classList.toggle('dirty', failed)
  } catch {
    $('saveState').textContent = 'save failed'
  } finally {
    saving = false
    if (saveAgain) {
      saveAgain = false
      scheduleSave()
    }
  }
}

/** Another writer won. Keep ours as an undo point, take theirs. */
function adoptStaleTimeline(local, current) {
  historyFor(local).undo.push(historySnapshotOf(local))
  replaceTimeline(current)
  status(`"${current.name}" changed elsewhere — reloaded; ⌘Z keeps yours`)
}

/** Swap a timeline document in by id, keeping the UI on it if it is open. */
function replaceTimeline(doc) {
  const list = state.project.sequences
  const i = list.findIndex((t) => t.id === doc.id)
  const wasOpen = i === state.seqIndex
  if (i < 0) list.push(doc)
  else list[i] = doc
  const h = historyFor(doc)
  h.last = historySnapshotOf(doc)
  if (wasOpen) {
    const keep = (state.selectedItems ?? []).map((x) => x.id)
    refreshSequence()
    if (keep.length) state.timeline?.selectMany(keep.filter((id) => SEQ.findItem(doc, id)))
  } else if (SEQ.nestedTimelineIds(seqContext().timelines, currentSequence()?.id).has(doc.id)) {
    // The open timeline plays this one somewhere: its block redraws.
    refreshSequence()
  }
  renderCrumb()
  renderTimelineRail?.()
}

/**
 * Other tabs and other agents write too. Every few seconds the revisions are
 * compared and any timeline that moved on — and that we have not touched — is
 * fetched and swapped in. Runs in hidden tabs as well: that is where agents live.
 */
async function pollRevisions() {
  if (!state.project || saving || document.visibilityState === 'prerender') return
  try {
    const revs = await fetch(`/api/timelines/revs?project=${state.project.id}`).then((r) => (r.ok ? r.json() : null))
    if (!revs || !state.project) return
    const seen = new Set()
    for (const r of revs) {
      seen.add(r.id)
      const local = timelineById(r.id)
      if (local && local.claimedBy?.agent !== r.claimedBy?.agent) {
        local.claimedBy = r.claimedBy
        renderTimelineRail?.()
      }
      if (local && (r.rev <= local.rev || dirty.timelines.has(r.id))) continue
      const doc = await fetch(`/api/timelines/${r.id}`).then((x) => (x.ok ? x.json() : null))
      if (!doc) continue
      if (!local) {
        state.project.timelineIds = [...new Set([...(state.project.timelineIds ?? []), doc.id])]
      }
      replaceTimeline(doc)
    }
    // Timelines deleted elsewhere leave, unless they are open here.
    for (const t of [...state.project.sequences]) {
      if (!seen.has(t.id) && t !== currentSequence() && !dirty.timelines.has(t.id)) {
        state.project.sequences = state.project.sequences.filter((x) => x !== t)
        state.project.timelineIds = (state.project.timelineIds ?? []).filter((id) => id !== t.id)
        state.seqIndex = Math.max(0, state.project.sequences.indexOf(currentSequence()))
        renderTimelineRail?.()
      }
    }
  } catch {
    /* offline for a moment; the next poll tries again */
  }
}

/* ------------------------------------------------------------ stage mounting */

const buildDoc = buildStageDoc

/** Tear down the current preview and build a fresh one at t = 0. */
async function remount() {
  const clip = currentClip()
  if (!clip) return

  state.playing = false
  $('btnPlay').textContent = '▶'
  $('console').innerHTML = ''

  const wrap = $('stageWrap')
  wrap.innerHTML = ''

  const iframe = document.createElement('iframe')
  iframe.width = clip.width
  iframe.height = clip.height
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  // aria-label, not title: it names the frame for assistive tech without
  // popping a native tooltip every time the pointer crosses the stage.
  iframe.setAttribute('aria-label', 'Animation stage')

  const ready = new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.source === iframe.contentWindow && e.data?.type === 'stage:ready') {
        window.removeEventListener('message', onMsg)
        resolve()
      }
    }
    window.addEventListener('message', onMsg)
    // Do not hang forever if user JS throws before the runtime can report in.
    setTimeout(resolve, 4000)
  })

  // Adopt the frame before it loads. A clip whose script throws posts
  // stage:error *before* stage:ready, and the message handler ignores anything
  // that is not from the current iframe — adopting it late swallowed exactly
  // the errors the console panel exists to show.
  state.iframe = iframe
  state.raster = null

  wrap.appendChild(iframe)
  iframe.srcdoc = buildDoc(clip)
  await ready

  const stage = iframe.contentWindow?.__stage
  if (stage) {
    stage.configure({ duration: clip.durationMs, fps: clip.fps })
    await stage.ready()
  }

  state.raster = createRasterizer(iframe, { width: clip.width, height: clip.height, decor: clip.decor, baseWidth: clip.baseWidth, baseHeight: clip.baseHeight })
  fitStage()
  setTime(0)
  renderTimeline()
}

function fitStage() {
  if (state.mode === 'seq') return fitSeqStage()

  const clip = currentClip()
  if (!clip || !state.iframe) return

  const area = $('stageArea')
  const scale =
    state.zoom === 'fit'
      ? Math.min(1, (area.clientWidth - 40) / clip.width, (area.clientHeight - 40) / clip.height)
      : Number(state.zoom)

  state.iframe.style.transform = `scale(${scale})`
  const wrap = $('stageWrap')
  wrap.style.width = `${clip.width * scale}px`
  wrap.style.height = `${clip.height * scale}px`

  $('stageDims').textContent = `${clip.width}×${clip.height} · ${Math.round(scale * 100)}%`
  document.querySelectorAll('.zoom-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.zoom === String(state.zoom)),
  )
}

document.querySelectorAll('.zoom-btn').forEach((b) => {
  b.onclick = () => {
    state.zoom = b.dataset.zoom === 'fit' ? 'fit' : Number(b.dataset.zoom)
    fitStage()
  }
})

/* ---------------------------------------------------------------- transport */

function setTime(ms) {
  const clip = currentClip()
  if (!clip) return
  const pct = Math.max(0, Math.min(1, ms / clip.durationMs))
  $('playhead').style.left = `calc(${TL_GUTTER}px + ${pct} * (100% - ${TL_GUTTER}px))`
  $('timeLabel').textContent = `${(ms / 1000).toFixed(2)} / ${(clip.durationMs / 1000).toFixed(2)}s`
}

async function seekTo(ms) {
  const stage = state.iframe?.contentWindow?.__stage
  if (!stage) return
  // The virtual clock only runs forward, so scrubbing back means rebuilding.
  if (ms < stage.time) {
    await remount()
  }
  await state.iframe.contentWindow.__stage.seek(ms)
  setTime(ms)
  renderTimeline()
}

async function togglePlay() {
  const clip = currentClip()
  const stage = state.iframe?.contentWindow?.__stage
  if (!clip || !stage) return

  if (state.playing) {
    stage.pause()
    state.playing = false
    $('btnPlay').textContent = '▶'
    return
  }
  if (stage.time >= clip.durationMs - 1) await remount()
  state.playing = true
  $('btnPlay').textContent = '❚❚'
  state.iframe.contentWindow.__stage.play()
}

window.addEventListener('message', async (e) => {
  if (e.source !== state.iframe?.contentWindow) return
  const d = e.data
  if (!d || typeof d.type !== 'string') return

  if (d.type === 'stage:time') {
    setTime(d.time)
  } else if (d.type === 'stage:ended') {
    setTime(currentClip()?.durationMs ?? 0)
    if ($('chkLoop').checked && state.playing && !state.exporting) {
      await remount()
      state.playing = true
      $('btnPlay').textContent = '❚❚'
      state.iframe.contentWindow.__stage.play()
    } else {
      state.playing = false
      $('btnPlay').textContent = '▶'
    }
  } else if (d.type === 'stage:error') {
    const el = document.createElement('div')
    el.className = 'err'
    el.textContent = d.message
    $('console').appendChild(el)
    $('console').scrollTop = $('console').scrollHeight
  }
})

/* ------------------------------------------------------------------- clips */

function renderClips() {
  const ul = $('clipList')
  ul.innerHTML = ''
  state.project.clips.forEach((clip, i) => {
    const li = document.createElement('li')
    li.className = 'clip-item' + (i === state.clipIndex ? ' active' : '')
    li.draggable = true
    setTip(
      li,
      `${clip.name}\n${clip.width}×${clip.height} · ${(clip.durationMs / 1000).toFixed(1)}s · ${clip.fps}fps · ` +
        `${clip.background.mode === 'transparent' ? 'transparent' : clip.background.color}`,
      { at: 'right' },
    )

    const thumb = document.createElement('div')
    thumb.className = 'clip-thumb'
    const cached = state.thumbs.get(thumbKey(clip))
    if (cached) {
      thumb.classList.add('has-img')
      thumb.style.backgroundImage = `url("${cached}")`
    }
    li.appendChild(thumb)

    const meta = document.createElement('div')
    meta.className = 'clip-meta'
    const name = document.createElement('div')
    name.className = 'cname'
    name.textContent = clip.name
    meta.appendChild(name)
    const sub = document.createElement('div')
    sub.className = 'cmeta'
    sub.textContent = `${clip.width}×${clip.height} · ${(clip.durationMs / 1000).toFixed(1)}s`
    meta.appendChild(sub)
    li.appendChild(meta)

    if (state.project.clips.length > 1) {
      const del = document.createElement('button')
      del.className = 'cdel'
      del.textContent = '×'
      setTip(del, `Delete "${clip.name}" from this project.`)
      del.onclick = (ev) => {
        ev.stopPropagation()
        state.project.clips.splice(i, 1)
        state.clipIndex = Math.min(state.clipIndex, state.project.clips.length - 1)
        markDirty()
        renderClips()
        loadClipIntoUi()
      }
      li.appendChild(del)
    }

    li.onclick = () => {
      if (state.clipIndex === i) return
      state.clipIndex = i
      renderClips()
      loadClipIntoUi()
    }
    ul.appendChild(li)
  })
}

/* ------------------------------------------------------------ thumbnails */

/** Cache key that invalidates itself whenever the clip's look changes. */
function thumbKey(clip) {
  const src = `${clip.width}x${clip.height}|${clip.background.mode}${clip.background.color}|${clip.html}|${clip.css}|${clip.js}`
  let h = 5381
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0
  return `${clip.id}:${h.toString(36)}`
}

/**
 * Render a poster frame for a clip in its own offscreen iframe, so the visible
 * stage and the user's playhead are never disturbed.
 */
/** Step across the whole clip so timer- and rAF-created animations exist. */
async function walkClip(stage, durationMs, steps = 20) {
  for (let i = 1; i <= steps; i++) {
    await stage.seek((durationMs * i) / steps, { fast: true })
  }
}

async function generateThumb(clip) {
  const key = thumbKey(clip)
  if (state.thumbs.has(key)) return

  const cachedRaw = localStorage.getItem(`animationhtml:thumb:${key}`)
  if (cachedRaw) {
    state.thumbs.set(key, cachedRaw)
    renderClips()
    return
  }

  try {
    const data = await withOffscreenClip(clip, async ({ iframe, stage }) => {
      // Past the entrance, where the composition is fully formed.
      await stage.seek(clip.durationMs * 0.6, { fast: true })
      const raster = createRasterizer(iframe, { width: clip.width, height: clip.height, decor: clip.decor, baseWidth: clip.baseWidth, baseHeight: clip.baseHeight })
      await raster.drawFrame(clip.background.mode === 'color' ? clip.background.color : '#14171a')

      const small = document.createElement('canvas')
      small.width = 208
      small.height = Math.max(1, Math.round((208 * clip.height) / clip.width))
      small.getContext('2d').drawImage(raster.canvas, 0, 0, small.width, small.height)
      return small.toDataURL('image/jpeg', 0.7)
    })

    state.thumbs.set(key, data)
    try {
      localStorage.setItem(`animationhtml:thumb:${key}`, data)
    } catch {
      /* quota full — in-memory is enough */
    }
    renderClips()
  } catch {
    /* thumbnails are cosmetic; never let one break the editor */
  }
}

let thumbQueue = Promise.resolve()
function queueThumbs() {
  for (const clip of state.project?.clips ?? []) {
    thumbQueue = thumbQueue.then(() => generateThumb(clip)).catch(() => {})
  }
}

/* --------------------------------------------------------------- ui binding */

function loadClipIntoUi() {
  const clip = currentClip()
  if (!clip) return
  $('ed-html').value = clip.html
  $('ed-css').value = clip.css
  $('ed-js').value = clip.js
  for (const pane of ['html', 'css', 'js']) editors[pane]?.paint()
  updateTabBadges()
  $('setName').value = clip.name
  $('setDuration').value = String(clip.durationMs / 1000)
  $('setFps').value = String(clip.fps)
  $('setWidth').value = String(clip.width)
  $('setHeight').value = String(clip.height)
  $('setPreset').value = `${clip.width}x${clip.height}`
  $('bgColor').value = clip.background.color

  const mode =
    clip.background.mode === 'transparent'
      ? 'transparent'
      : clip.background.color.toLowerCase() === '#00b140'
        ? 'green'
        : 'color'
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.bg === mode))

  return remount()
}

let rebuildTimer = null
let thumbTimer = null
function scheduleRebuild() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(remount, 400)
}

/** Syntax-highlighted editors, one per pane. */
const editors = {}
for (const pane of ['html', 'css', 'js']) {
  editors[pane] = attachEditor($(`ed-${pane}`), pane)
  $(`ed-${pane}`).addEventListener('input', (e) => {
    const clip = currentClip()
    if (!clip) return
    clip[pane] = e.target.value
    markDirty()
    scheduleRebuild()
    updateTabBadges()
    clearTimeout(thumbTimer)
    thumbTimer = setTimeout(() => generateThumb(currentClip()), 1500)
  })
}

/** Only the active pane's editor is visible; the host owns that, not the textarea. */
function showPane(pane) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === pane))
  document.querySelectorAll('.code-edit').forEach((ed) => {
    ed.classList.toggle('hidden', ed.dataset.pane !== pane)
  })
  editors[pane]?.paint()
}
showPane('html')

/** Show how much code each pane holds, so empty ones are obvious. */
function updateTabBadges() {
  const clip = currentClip()
  document.querySelectorAll('.tab').forEach((tab) => {
    const pane = tab.dataset.pane
    let badge = tab.querySelector('.badge')
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'badge'
      tab.appendChild(badge)
    }
    const n = clip?.[pane]?.length ?? 0
    badge.textContent = n === 0 ? '—' : n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
    setTip(tab, n === 0 ? `${pane.toUpperCase()} — empty` : `${n.toLocaleString()} characters of ${pane.toUpperCase()}`)
  })
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => showPane(tab.dataset.pane)
})

/* --------------------------------------------------- resizable code panel */

$('codeResize').addEventListener('pointerdown', (e) => {
  const panel = $('codePanel')
  if (panel.classList.contains('collapsed')) return
  e.preventDefault()
  const startY = e.clientY
  const startH = panel.getBoundingClientRect().height
  document.body.classList.add('resizing')

  const onMove = (ev) => {
    const h = Math.max(120, Math.min(window.innerHeight - 260, startH - (ev.clientY - startY)))
    panel.style.height = `${h}px`
    fitStage()
  }
  const onUp = () => {
    document.body.classList.remove('resizing')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    localStorage.setItem('animationhtml:codeHeight', panel.style.height)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
})

/* ------------------------------------------------ resizable timeline panel */

$('seqResize').addEventListener('pointerdown', (e) => {
  const panel = $('seqPanel')
  e.preventDefault()
  const startY = e.clientY
  const startH = panel.getBoundingClientRect().height
  document.body.classList.add('resizing')

  const onMove = (ev) => {
    const h = Math.max(140, Math.min(window.innerHeight - 220, startH - (ev.clientY - startY)))
    panel.style.height = `${h}px`
    fitStage()
  }
  const onUp = () => {
    document.body.classList.remove('resizing')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    localStorage.setItem('animationhtml:seqHeight', panel.style.height)
    state.timeline?.repaintWaveforms()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
})

function bindSetting(id, apply, { rebuild = true } = {}) {
  $(id).addEventListener('change', () => {
    const clip = currentClip()
    if (!clip) return
    apply(clip, $(id).value)
    markDirty()
    renderClips()
    if (rebuild) remount()
  })
}

bindSetting('setName', (c, v) => { c.name = v || 'Untitled clip' }, { rebuild: false })
bindSetting('setDuration', (c, v) => {
  c.durationMs = Math.max(100, Math.round(parseFloat(v) * 1000) || 3000)
  $('setDuration').value = String(c.durationMs / 1000)
})
bindSetting('setFps', (c, v) => {
  c.fps = Math.min(120, Math.max(1, parseInt(v, 10) || 30))
  $('setFps').value = String(c.fps)
})
bindSetting('setWidth', (c, v) => {
  c.width = Math.min(7680, Math.max(16, parseInt(v, 10) || 1920))
  $('setWidth').value = String(c.width)
  $('setPreset').value = `${c.width}x${c.height}`
})
bindSetting('setHeight', (c, v) => {
  c.height = Math.min(7680, Math.max(16, parseInt(v, 10) || 1080))
  $('setHeight').value = String(c.height)
  $('setPreset').value = `${c.width}x${c.height}`
})
$('setPreset').addEventListener('change', () => {
  const v = $('setPreset').value
  if (!v) return
  const clip = currentClip()
  const [w, h] = v.split('x').map(Number)
  clip.width = w
  clip.height = h
  $('setWidth').value = String(w)
  $('setHeight').value = String(h)
  markDirty()
  renderClips()
  remount()
})

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.onclick = () => {
    const clip = currentClip()
    if (!clip) return
    const mode = btn.dataset.bg
    if (mode === 'transparent') clip.background = { mode: 'transparent', color: clip.background.color }
    else if (mode === 'green') clip.background = { mode: 'color', color: '#00b140' }
    else clip.background = { mode: 'color', color: $('bgColor').value }
    $('bgColor').value = clip.background.color
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn))
    markDirty()
    renderClips()
    remount()
  }
})
$('bgColor').addEventListener('input', () => {
  const clip = currentClip()
  clip.background = { mode: 'color', color: $('bgColor').value }
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.bg === 'color'))
  markDirty()
  renderClips()
  scheduleRebuild()
})

$('btnPlay').onclick = togglePlay
/* ------------------------------------------------------------- timeline */

/** Width of the track-label gutter; clicks left of it are not seeks. */
const TL_GUTTER = 132

function timeFromEvent(e) {
  const clip = currentClip()
  const rect = $('timeline').getBoundingClientRect()
  const span = Math.max(1, rect.width - TL_GUTTER)
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left - TL_GUTTER) / span))
  // Snap to whole frames: a video has no time between them.
  const frame = 1000 / clip.fps
  return Math.round((pct * clip.durationMs) / frame) * frame
}

function showBubble(ms, clientX) {
  const clip = currentClip()
  if (!clip) return
  const b = $('tlBubble')
  const rect = $('timeline').getBoundingClientRect()
  b.textContent = `${(ms / 1000).toFixed(2)}s · f${Math.round((ms / 1000) * clip.fps)}`
  b.style.left = `${Math.max(TL_GUTTER, Math.min(rect.width - 8, clientX - rect.left))}px`
  b.classList.add('on')
}
const hideBubble = () => $('tlBubble').classList.remove('on')

let scrubbing = false
$('timeline').addEventListener('pointerdown', async (e) => {
  if (!currentClip() || state.exporting) return
  scrubbing = true
  $('timeline').setPointerCapture(e.pointerId)
  const stage = state.iframe?.contentWindow?.__stage
  if (state.playing) {
    stage?.pause()
    state.playing = false
    $('btnPlay').textContent = '▶'
  }
  const t = timeFromEvent(e)
  showBubble(t, e.clientX)
  await seekTo(t)
})
$('timeline').addEventListener('pointermove', async (e) => {
  if (!state.exporting) showBubble(timeFromEvent(e), e.clientX)
  if (!scrubbing || state.exporting) return
  // Seeking backwards rebuilds the stage, so only chase the pointer forward
  // while dragging; the pointerup below lands the final position exactly.
  const t = timeFromEvent(e)
  const now = state.iframe?.contentWindow?.__stage?.time ?? 0
  if (t > now) await seekTo(t)
  else setTime(t)
})
$('timeline').addEventListener('pointerup', async (e) => {
  if (!scrubbing) return
  scrubbing = false
  await seekTo(timeFromEvent(e))
})
$('timeline').addEventListener('pointerleave', () => {
  hideBubble()
  state.iframe?.contentWindow?.__stage?.clearHighlight?.()
})

/** Draw the time ruler and one row per (animation name × target) group. */
function renderTimeline() {
  const clip = currentClip()
  const ruler = $('ruler')
  const tracks = $('tracks')
  ruler.innerHTML = ''
  tracks.innerHTML = ''
  if (!$('timeline').querySelector('.timeline-gutter-bg')) {
    const bg = document.createElement('div')
    bg.className = 'timeline-gutter-bg'
    $('timeline').prepend(bg)
  }
  if (!clip) return

  const dur = clip.durationMs
  const step = dur <= 4000 ? 500 : dur <= 12000 ? 1000 : 2000
  for (let t = 0; t <= dur; t += step) {
    const tick = document.createElement('div')
    tick.className = 'tick'
    tick.style.left = `${(t / dur) * 100}%`
    const label = document.createElement('span')
    label.textContent = `${(t / 1000).toFixed(t % 1000 ? 1 : 0)}s`
    tick.appendChild(label)
    ruler.appendChild(tick)
  }

  let anims = []
  try {
    anims = state.iframe?.contentWindow?.__stage?.animations?.() ?? []
  } catch {
    anims = []
  }

  if (!anims.length) {
    const empty = document.createElement('div')
    empty.className = 'timeline-empty'
    empty.textContent = 'No animations detected yet — they appear here as the clock reaches them.'
    tracks.appendChild(empty)
    return
  }

  // One row per animation name + target class, so a stagger reads as a row of
  // offset bars rather than eight near-identical tracks.
  const groups = new Map()
  for (const a of anims) {
    const key = `${a.label} · ${a.name}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(a)
  }

  for (const [key, list] of [...groups].sort((a, b) => a[1][0].start - b[1][0].start)) {
    const row = document.createElement('div')
    row.className = 'track'
    const label = document.createElement('span')
    label.className = 'track-label'
    label.textContent = list.length > 1 ? `${key} ×${list.length}` : key
    // The gutter ellipsises; the tooltip is the only way to read it in full.
    setTip(
      label,
      list.length > 1
        ? `${key}\n${list.length} instances, starting ${list.map((a) => (a.start / 1000).toFixed(2) + 's').join(', ')}`
        : key,
      { at: 'right' },
    )
    row.appendChild(label)

    for (const a of list) {
      const bar = document.createElement('div')
      const start = Math.max(0, a.start)
      const end = Math.min(dur, Math.max(a.end, a.start + 1))
      bar.className = 'bar' + (start > 0.001 ? ' late' : '')
      bar.style.left = `${(start / dur) * 100}%`
      bar.style.width = `${Math.max(0.4, ((end - start) / dur) * 100)}%`
      setTip(
        bar,
        `${key}\n${(start / 1000).toFixed(2)}s → ${(end / 1000).toFixed(2)}s  ·  ${((end - start) / 1000).toFixed(2)}s long\n` +
          `Click to jump here · hover to locate it on the stage`,
      )

      // Jumping to a bar's start is the single most common timeline action.
      bar.onpointerdown = (ev) => ev.stopPropagation()
      bar.onclick = async (ev) => {
        ev.stopPropagation()
        if (state.exporting) return
        await seekTo(start)
      }
      // Hovering points at the element the bar actually drives.
      bar.onpointerenter = () => state.iframe?.contentWindow?.__stage?.highlight?.(a.index)
      bar.onpointerleave = () => state.iframe?.contentWindow?.__stage?.clearHighlight?.()

      row.appendChild(bar)
    }
    tracks.appendChild(row)
  }
}

$('btnAddClip').onclick = async () => {
  const blank = await fetch('/api/blank-clip').then((r) => r.json())
  blank.name = `Clip ${state.project.clips.length + 1}`
  state.project.clips.push(blank)
  state.clipIndex = state.project.clips.length - 1
  markDirty()
  renderClips()
  loadClipIntoUi()
}

$('projectName').addEventListener('input', () => {
  state.project.name = $('projectName').value
  markDirty()
})

window.addEventListener('resize', fitStage)

/* ------------------------------------------------- code panel + shortcuts */

function toggleCode(force) {
  const panel = $('codePanel')
  const collapsed = force ?? !panel.classList.contains('collapsed')
  panel.classList.toggle('collapsed', collapsed)
  $('btnCollapse').textContent = collapsed ? '▴' : '▾'
  requestAnimationFrame(fitStage)
}
$('btnCollapse').onclick = () => toggleCode()

const activePane = () => document.querySelector('.tab.active')?.dataset.pane ?? 'html'

/** Append text to a given pane, whichever pane is showing. */
function insertInto(pane, text) {
  const el = $(`ed-${pane}`)
  if (!el) return
  const sep = el.value && !el.value.endsWith('\n') ? '\n' : ''
  el.value = el.value + sep + text
  el.dispatchEvent(new Event('input'))
}

/** Insert text at the caret of the active editor pane. */
function insertAtCursor(text) {
  const el = $(`ed-${activePane()}`)
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  el.value = el.value.slice(0, start) + text + el.value.slice(end)
  el.selectionStart = el.selectionEnd = start + text.length
  el.focus()
  el.dispatchEvent(new Event('input'))
}

const isTyping = (t) =>
  t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)

window.addEventListener('keydown', async (e) => {
  const mod = e.metaKey || e.ctrlKey

  if (!mod && !isTyping(e.target) && !e.target?.closest?.('dialog')) {
    if (e.key === '[') {
      e.preventDefault()
      togglePanel('rail')
      return
    }
    if (e.key === ']') {
      e.preventDefault()
      togglePanel('insp')
      return
    }
    if (e.key === 'Escape' && !contextMenuOpen()) {
      closeDrawers()
    }
  }
  if (mod && e.key === 'e') {
    e.preventDefault()
    // Same key, whichever thing is being exported.
    if (state.mode === 'seq') $('btnRenderSeq').click()
    else if (!$('btnStudio').disabled) $('btnStudio').click()
    return
  }
  if (mod && e.key === '\\') {
    e.preventDefault()
    toggleCode()
    return
  }
  // Everything below would fight with typing, or with timeline mode's own
  // transport, which owns the same keys against a different clock.
  if (isTyping(e.target) || e.target?.closest?.('dialog')) return
  if (state.exporting || state.mode === 'seq') return

  const clip = currentClip()
  if (!clip) return
  const frame = 1000 / clip.fps
  const now = state.iframe?.contentWindow?.__stage?.time ?? 0

  if (e.key === ' ') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    await seekTo(Math.min(clip.durationMs, now + (e.shiftKey ? 1000 : frame)))
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    await seekTo(Math.max(0, now - (e.shiftKey ? 1000 : frame)))
  } else if (e.key === 'Home') {
    e.preventDefault()
    await seekTo(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    await seekTo(clip.durationMs)
  }
})

/* ------------------------------------------------------------------ export */

const host = {
  reload: () => remount(),
  // Exports never need a painted frame, only correct layout.
  seek: async (t) => {
    const res = await state.iframe.contentWindow.__stage.seek(t, { fast: true })
    setTime(t)
    return res
  },
  get raster() {
    return state.raster
  },
}

/* ------------------------------------------------- agent-facing facade */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clipById = (id) => {
  const c = state.project?.clips.find((x) => x.id === id)
  if (!c) throw new Error(`unknown clip "${id}"`)
  return c
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/**
 * The surface `webmcp.js` drives. Everything here is built from functions the
 * UI already uses, so an agent and a human take exactly the same code paths.
 */
const editor = {
  getProjectName: () => state.project?.name ?? 'untitled',
  getClips: () => state.project?.clips ?? [],
  currentClip,
  snippetNames: () => SNIPPETS.map((s) => s.name),

  getStageState() {
    const stage = state.iframe?.contentWindow?.__stage
    return {
      mounted: !!stage,
      timeMs: stage?.time ?? 0,
      durationMs: currentClip()?.durationMs ?? 0,
      busy: state.exporting,
      errors: $('console').textContent.trim(),
    }
  },

  listExports: () => fetch('/api/exports').then((r) => r.json()),

  listAssets: () => fetch('/api/assets').then((r) => r.json()),

  /* ---------------------------------------------------------- projects */

  listProjects: () => fetch('/api/projects').then((r) => r.json()),

  currentProjectId: () => state.project?.id ?? null,

  async openProject(id) {
    const ok = await loadProject(id)
    if (!ok) throw new Error(`no project "${id}"`)
    queueThumbs()
    return state.project
  },

  async createProject(name) {
    const p = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name || 'Untitled project' }),
    }).then((r) => r.json())
    await loadProject(p.id)
    return state.project
  },

  /* ------------------------------------------------------------- clips */

  async duplicateClip(id) {
    const src = clipById(id)
    const copy = JSON.parse(JSON.stringify(src))
    copy.id = 'c_' + Math.random().toString(36).slice(2, 10)
    copy.name = `${src.name} copy`
    const at = state.project.clips.indexOf(src) + 1
    state.project.clips.splice(at, 0, copy)
    state.clipIndex = at
    markDirty()
    renderClips()
    await loadClipIntoUi()
    generateThumb(copy)
    return copy
  },

  /** Targeted find/replace, so an agent need not resend a whole stylesheet. */
  async patchClipCode(id, pane, find, replace, all) {
    const clip = clipById(id)
    if (!['html', 'css', 'js'].includes(pane)) throw new Error(`pane must be html, css or js`)
    const before = clip[pane]
    const count = before.split(find).length - 1
    if (count === 0) throw new Error(`"${find}" does not appear in the ${pane}`)
    if (count > 1 && !all) {
      throw new Error(`"${find}" appears ${count} times — pass all:true, or use a longer unique snippet`)
    }
    const after = all ? before.split(find).join(replace) : before.replace(find, replace)
    await editor.setClipCode(id, { [pane]: after })
    return { replaced: all ? count : 1, length: after.length }
  },

  /* -------------------------------------------------------- inspection */

  /** Full animation list, gathered offscreen so the playhead never moves. */
  probeTimeline(id) {
    const clip = clipById(id)
    return withOffscreenClip(clip, async ({ stage }) => {
      await walkClip(stage, clip.durationMs)
      return stage.animations()
    })
  },

  /** Preflight: the mistakes that only show up once you have rendered. */
  checkClip(id) {
    const clip = clipById(id)
    return withOffscreenClip(clip, async ({ iframe, stage, doc, errors }) => {
      // Sample DURING the forward walk, never after it. The virtual clock
      // refuses to run backwards, so walking to the end first and then seeking
      // back to 0 would silently observe the final frame seventeen times — and
      // report anything that deliberately exits as "off-frame".
      const everSeen = new WeakSet()
      const known = new Set()
      const SAMPLES = 20

      const observe = () => {
        for (const el of doc.body.querySelectorAll('*')) {
          known.add(el)
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          if (r.right > 0 && r.bottom > 0 && r.left < clip.width && r.top < clip.height) {
            everSeen.add(el)
          }
        }
      }

      observe()
      for (let i = 1; i <= SAMPLES; i++) {
        await stage.seek((clip.durationMs * i) / SAMPLES, { fast: true })
        observe()
      }

      const brokenImages = [...doc.images]
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute('src') || '(no src)')

      const anims = stage.animations()
      const overruns = anims
        .filter((a) => a.end > clip.durationMs + 1)
        .map((a) => ({ label: `${a.label} · ${a.name}`, end: a.end }))

      // Off-frame means off-frame for the WHOLE clip; partly-outside is bleed.
      const offstage = []
      for (const el of known) {
        if (everSeen.has(el)) continue
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue // empty, not misplaced
        const cls = (el.getAttribute('class') || '').split(/\s+/)[0]
        offstage.push(cls ? `.${cls}` : el.tagName.toLowerCase())
      }

      const lastEnd = anims.length ? Math.max(...anims.map((a) => a.end)) : 0
      return {
        frames: Math.round((clip.durationMs / 1000) * clip.fps),
        brokenImages,
        overruns,
        offstage: [...new Set(offstage)],
        errors,
        lastAnimationEnd: lastEnd,
        deadTailMs: Math.max(0, clip.durationMs - lastEnd),
      }
    })
  },

  /** A tiled contact sheet across the clip, saved as one PNG. */
  captureStrip(id, { count = 6, fromMs = 0, toMs = null } = {}) {
    const clip = clipById(id)
    const n = Math.max(2, Math.min(12, Math.round(count)))
    const end = toMs ?? clip.durationMs

    return withOffscreenClip(clip, async ({ iframe, stage }) => {
      const raster = createRasterizer(iframe, { width: clip.width, height: clip.height, decor: clip.decor, baseWidth: clip.baseWidth, baseHeight: clip.baseHeight })
      const cols = n <= 4 ? 2 : 3
      const rows = Math.ceil(n / cols)
      const tw = 460
      const th = Math.max(1, Math.round((tw * clip.height) / clip.width))
      const pad = 8

      const sheet = document.createElement('canvas')
      sheet.width = cols * tw + (cols + 1) * pad
      sheet.height = rows * th + (rows + 1) * pad
      const ctx = sheet.getContext('2d')
      ctx.fillStyle = '#0e1013'
      ctx.fillRect(0, 0, sheet.width, sheet.height)

      // Transparent clips get a mid grey behind them so alpha stays legible.
      const bg = clip.background.mode === 'color' ? clip.background.color : '#2a2f36'

      for (let i = 0; i < n; i++) {
        const t = fromMs + (end - fromMs) * (n === 1 ? 0 : i / (n - 1))
        await stage.seek(t, { fast: true })
        await raster.drawFrame(bg)

        const cx = pad + (i % cols) * (tw + pad)
        const cy = pad + Math.floor(i / cols) * (th + pad)
        ctx.drawImage(raster.canvas, cx, cy, tw, th)

        ctx.fillStyle = 'rgba(0,0,0,.66)'
        ctx.fillRect(cx, cy, 62, 19)
        ctx.fillStyle = '#fff'
        ctx.font = '12px ui-monospace, monospace'
        ctx.fillText(`${(t / 1000).toFixed(2)}s`, cx + 6, cy + 13)
      }

      const blob = await new Promise((res) => sheet.toBlob(res, 'image/png'))
      const res = await fetch(`/api/frame?name=${encodeURIComponent(clip.name + '-strip')}`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: blob,
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'strip upload failed')
      return { ...(await res.json()), frames: n, cols, rows }
    })
  },

  async addAssetFromUrl(url, name) {
    const res = await fetch('/api/assets/from-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, name }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? 'could not fetch that asset')
    await state.assets?.refresh()
    return body
  },

  async selectClip(id) {
    const i = state.project.clips.findIndex((c) => c.id === id)
    if (i < 0) throw new Error(`unknown clip "${id}"`)
    if (i !== state.clipIndex) {
      state.clipIndex = i
      renderClips()
      await loadClipIntoUi()
    }
    return state.project.clips[i]
  },

  async createClip(opts = {}) {
    const clip = await fetch('/api/blank-clip').then((r) => r.json())
    clip.name = opts.name || `Clip ${state.project.clips.length + 1}`
    if (opts.width != null) clip.width = clampInt(opts.width, 16, 7680, clip.width)
    if (opts.height != null) clip.height = clampInt(opts.height, 16, 7680, clip.height)
    if (opts.fps != null) clip.fps = clampInt(opts.fps, 1, 120, clip.fps)
    if (opts.durationMs != null) {
      clip.durationMs = Math.max(100, Math.round(opts.durationMs) || clip.durationMs)
    }
    if (opts.background) clip.background = opts.background

    state.project.clips.push(clip)
    state.clipIndex = state.project.clips.length - 1
    markDirty()
    renderClips()
    await loadClipIntoUi()
    return clip
  },

  async deleteClip(id) {
    const i = state.project.clips.findIndex((c) => c.id === id)
    if (i < 0) throw new Error(`unknown clip "${id}"`)
    state.project.clips.splice(i, 1)
    state.clipIndex = Math.min(state.clipIndex, state.project.clips.length - 1)
    markDirty()
    renderClips()
    await loadClipIntoUi()
  },

  async setClipCode(id, patch) {
    const clip = clipById(id)
    Object.assign(clip, patch)
    markDirty()
    if (clip === currentClip()) {
      for (const pane of ['html', 'css', 'js']) {
        if (pane in patch) {
          $(`ed-${pane}`).value = clip[pane]
          editors[pane]?.paint()
        }
      }
      updateTabBadges()
      await remount()
      // Give a synchronous throw in the clip's own script time to post back
      // before get_stage_state is asked for errors.
      await sleep(60)
    }
    generateThumb(clip)
    return clip
  },

  async setClipSettings(id, patch) {
    const clip = clipById(id)
    if (patch.name != null) clip.name = String(patch.name) || clip.name
    if (patch.width != null) clip.width = clampInt(patch.width, 16, 7680, clip.width)
    if (patch.height != null) clip.height = clampInt(patch.height, 16, 7680, clip.height)
    if (patch.fps != null) clip.fps = clampInt(patch.fps, 1, 120, clip.fps)
    if (patch.durationMs != null) {
      clip.durationMs = Math.max(100, Math.round(patch.durationMs) || clip.durationMs)
    }
    if (patch.background) clip.background = patch.background

    markDirty()
    renderClips()
    if (clip === currentClip()) await loadClipIntoUi()
    return clip
  },

  async applySnippet(id, name) {
    const snippet = SNIPPETS.find((s) => s.name === name)
    if (!snippet) throw new Error(`unknown snippet "${name}"`)
    const clip = clipById(id)
    clip.html = snippet.html
    clip.css = snippet.css
    clip.js = snippet.js ?? ''
    if (snippet.durationMs) clip.durationMs = snippet.durationMs
    markDirty()
    renderClips()
    if (clip === currentClip()) await loadClipIntoUi()
    return clip
  },

  // seekTo already rebuilds the stage when asked to move backwards.
  seek: (ms) => seekTo(ms),

  async captureFrame(id, timeMs) {
    await editor.selectClip(id)
    const clip = currentClip()
    if (timeMs != null) await seekTo(Math.max(0, Math.min(clip.durationMs, timeMs)))

    const bg = clip.background.mode === 'color' ? clip.background.color : null
    await state.raster.drawFrame(bg)

    const blob = await new Promise((res, rej) =>
      state.raster.canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas is empty'))), 'image/png'),
    )
    const res = await fetch(`/api/frame?name=${encodeURIComponent(clip.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: blob,
    })
    if (!res.ok) throw new Error((await res.json()).error ?? 'frame upload failed')

    const saved = await res.json()
    return { ...saved, timeMs: state.iframe.contentWindow.__stage.time }
  },

  async render(id, { format = 'mov', quality } = {}) {
    if (state.exporting) throw new Error('a render is already running; wait for it to finish')
    await editor.selectClip(id)
    const clip = currentClip()

    setExporting(true)
    try {
      return await exportClip({
        host,
        clip,
        format,
        quality,
        onProgress,
        download: false, // an agent wants the URL, not a file in Downloads
      })
    } finally {
      setExporting(false)
      await remount()
    }
  },

  /* ============================================================ sequences */

  /**
   * Everything below is what the timeline tools drive. As with the clip
   * tools, it is built from the functions the UI already uses, so an agent
   * editing the timeline takes the same paths a hand on the mouse does —
   * including the undo history.
   */

  ensureSequenceMode() {
    if (state.mode !== 'seq') setMode('seq')
  },

  /** The timeline a call is aimed at (see `scope`); `openSequence` is the one on screen. */
  getSequence: () => scopedSequence(),
  openSequence: () => currentSequence(),
  listSequences: () => state.project?.sequences ?? [],
  parentsOf: (id) => SEQ.parentsOf(seqContext().timelines, id),

  /** Run `fn` with every facade call aimed at `timelineId` (null: the open one). */
  async withScope(timelineId, fn) {
    const prev = scope.id
    if (timelineId && !timelineById(timelineId)) throw new Error(`no timeline "${timelineId}". Use list_timelines.`)
    scope.id = timelineId || null
    try {
      return await fn()
    } finally {
      scope.id = prev
    }
  },

  /**
   * Say who is working where. Advisory: it shows in list_timelines and the
   * rail, and an agent that has named itself is refused edits to a timeline
   * another agent holds — unless it takes it over with `force`. Fifteen
   * minutes without a renewal and a claim lapses.
   */
  async claimTimeline({ timelineId = null, agent, release = false, force = false } = {}) {
    const seq = timelineId ? timelineById(timelineId) : scopedSequence()
    if (!seq) throw new Error(`no timeline "${timelineId}"`)
    const name = String(agent ?? state.agentName ?? '').trim()
    if (!name) throw new Error('agent is required — a short name for whoever is working here')
    const res = await fetch(`/api/timelines/${seq.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: name, release, force }),
    })
    const out = await res.json()
    if (!res.ok) throw new Error(out.error ?? 'claim failed')
    seq.claimedBy = out.claimedBy
    state.agentName = name
    renderTimelineRail?.()
    return { timeline: seq, claimedBy: out.claimedBy }
  },

  /** Refuse an edit to a timeline another named agent holds. */
  guardClaim(seq) {
    const mine = state.agentName
    if (!mine || !seq?.claimedBy?.agent || seq.claimedBy.agent === mine) return
    throw new Error(`"${seq.name}" is claimed by ${seq.claimedBy.agent}. Work elsewhere, or claim_timeline it with force: true to take it over.`)
  },

  /** The project as a tree: main, its sections in order, then the unplaced. */
  timelineTree() {
    const timelines = seqContext().timelines
    const mainId = state.project?.mainTimelineId
    const openId = currentSequence()?.id
    const lines = []
    const seen = new Set()
    const line = (t, depth, block = null) => {
      const items = t.tracks.reduce((n, tr) => n + tr.items.length, 0)
      const parts = [
        `${t.id === openId ? '*' : ' '} ${'  '.repeat(depth)}${t.id === mainId ? '★ ' : depth ? '⧉ ' : ''}${t.id}  "${t.name}"`,
        `${(SEQ.sequenceDuration(t) / 1000).toFixed(1)}s`,
        `${t.width}x${t.height}`,
        `${items} item(s)`,
      ]
      if (block) parts.push(`at ${(block.startMs / 1000).toFixed(2)}–${(SEQ.itemEnd(block) / 1000).toFixed(2)}s`)
      if (t.claimedBy?.agent) parts.push(`claimed by ${t.claimedBy.agent}`)
      if (t.note) parts.push(`— ${t.note}`)
      lines.push(parts.join('  '))
    }
    const walk = (t, depth, ancestors) => {
      if (depth >= SEQ.MAX_NESTING) return
      const blocks = [...SEQ.allItems(t)].map((x) => x.item).filter((i) => i.type === 'timeline').sort((a, b) => a.startMs - b.startMs)
      for (const block of blocks) {
        const child = timelines.get(block.sourceId)
        if (!child) {
          lines.push(`  ${'  '.repeat(depth + 1)}⧉ "${block.name}" — its timeline is missing`)
          continue
        }
        seen.add(child.id)
        line(child, depth + 1, block)
        if (!ancestors.includes(child.id) && child.id !== t.id) walk(child, depth + 1, [...ancestors, t.id])
      }
    }
    const main = timelines.get(mainId)
    if (main) {
      seen.add(main.id)
      line(main, 0)
      walk(main, 0, [])
    }
    const rest = (state.project?.sequences ?? []).filter((t) => !seen.has(t.id))
    if (rest.length) {
      lines.push('unplaced:')
      for (const t of rest) line(t, 0)
    }
    return lines.join('\n')
  },

  /** A new timeline document in this project, opened. */
  async createSequence({ name, width, height, fps, background, note, tracks = null, open = true } = {}) {
    const list = (state.project.sequences ??= [])
    const res = await fetch('/api/timelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: state.project.id,
        name: name || `Timeline ${list.length + 1}`,
        width: clampInt(width, 16, 7680, 1920),
        height: clampInt(height, 16, 7680, 1080),
        fps: clampInt(fps, 1, 120, 30),
        background: background ?? { mode: 'color', color: '#000000' },
        tracks: Array.isArray(tracks) ? tracks : [SEQ.makeTrack('video', 'V2'), SEQ.makeTrack('video', 'V1'), SEQ.makeTrack('audio', 'A1')],
        ...(note ? { note } : {}),
      }),
    })
    const doc = await res.json()
    if (!res.ok) throw new Error(doc.error ?? 'could not create the timeline')
    list.push(doc)
    state.project.timelineIds = [...new Set([...(state.project.timelineIds ?? []), doc.id])]
    renderTimelineRail?.()
    return open ? editor.selectSequence(doc.id) : doc
  },

  async selectSequence(id, { keepCrumbs = false } = {}) {
    const i = (state.project.sequences ?? []).findIndex((x) => x.id === id)
    if (i < 0) throw new Error(`no timeline "${id}"`)
    // Opening a timeline directly (the rail, a tool) starts a fresh trail;
    // openNested and the crumbs manage the stack themselves.
    if (!keepCrumbs && crumbs.at(-1) !== currentSequence()?.id) crumbs.length = 0
    state.seqIndex = i
    state.selectedItem = null
    state.selectedItems = []
    loadSequenceIntoUi()
    rememberActiveTimeline()
    editor.ensureSequenceMode()
    refreshSequence()
    updateHistoryButtons()
    renderCrumb()
    state.timeline?.zoomToFit()
    renderTimelineRail?.()
    await ensureTranscriptsLoaded()
    return currentSequence()
  },

  /**
   * A new version of a timeline: every track and item copied with fresh ids,
   * placed right after the original in the project. Sections (blocks that
   * play another timeline) stay shared unless `deep`, which copies them too,
   * recursively, so the version can diverge all the way down. Notes that
   * point at another item ("sound of i_…") follow the copy.
   */
  async duplicateSequence({ timelineId = null, name = null, deep = false, open = true } = {}) {
    const source = timelineId ? timelineById(timelineId) : scopedSequence()
    if (!source) throw new Error(`no timeline "${timelineId}"`)
    const uid = (prefix) => prefix + Math.random().toString(36).slice(2, 10)
    const made = new Map() // source id -> copy
    const inProgress = new Set()
    const copyOf = async (src, wantedName) => {
      if (made.has(src.id)) return made.get(src.id)
      inProgress.add(src.id)
      const idMap = new Map()
      const tracks = []
      for (const t of src.tracks) {
        const nt = { ...t, id: uid('t_'), items: [] }
        for (const i of t.items) {
          const ni = { ...i, id: uid('i_') }
          idMap.set(i.id, ni.id)
          if (i.captionStyle) ni.captionStyle = { ...i.captionStyle }
          if (i.textStyle) ni.textStyle = { ...i.textStyle }
          if (deep && i.type === 'timeline' && !inProgress.has(i.sourceId)) {
            const child = timelineById(i.sourceId)
            if (child) {
              const c = await copyOf(child, null)
              ni.sourceId = c.id
              ni.name = c.name
            }
          }
          nt.items.push(ni)
        }
        tracks.push(nt)
      }
      for (const t of tracks) for (const i of t.items) if (i.note) i.note = i.note.replace(/\bi_[a-z0-9]+\b/g, (m) => idMap.get(m) ?? m)
      const doc = await editor.createSequence({
        name: wantedName || nextVersionName(src.name),
        width: src.width,
        height: src.height,
        fps: src.fps,
        background: { ...src.background },
        tracks,
        note: src.note,
        open: false,
      })
      // Right after its original, not at the end of the list.
      const ids = state.project.timelineIds
      const list = state.project.sequences
      ids.splice(ids.indexOf(doc.id), 1)
      ids.splice(ids.indexOf(src.id) + 1, 0, doc.id)
      list.splice(list.indexOf(doc), 1)
      list.splice(list.findIndex((t) => t.id === src.id) + 1, 0, doc)
      made.set(src.id, doc)
      inProgress.delete(src.id)
      return doc
    }
    const copy = await copyOf(source, name)
    dirty.project = true
    scheduleSave()
    renderTimelineRail?.()
    if (open) await editor.selectSequence(copy.id)
    return { copy, source, copied: made.size }
  },

  /** Remove a timeline document. The main timeline, and one placed as a section somewhere, are refused. */
  async deleteSequence(timelineId) {
    const doc = timelineById(timelineId)
    if (!doc) throw new Error(`no timeline "${timelineId}"`)
    if (doc.id === state.project.mainTimelineId) throw new Error('the main timeline cannot be deleted — make another one main first')
    const parents = SEQ.parentsOf(seqContext().timelines, doc.id)
    if (parents.length) throw new Error(`"${doc.name}" is placed in ${parents.map((p) => `"${p.name}"`).join(', ')} — flatten or delete those blocks first`)
    const res = await fetch(`/api/timelines/${doc.id}`, { method: 'DELETE' })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(out.error ?? 'could not delete')
    const wasOpen = currentSequence()?.id === doc.id
    state.project.sequences = state.project.sequences.filter((t) => t !== doc)
    state.project.timelineIds = (state.project.timelineIds ?? []).filter((id) => id !== doc.id)
    histories.delete(doc.id)
    dirty.timelines.delete(doc.id)
    dirty.project = true
    scheduleSave()
    if (wasOpen) {
      crumbs.length = 0
      await editor.selectSequence(state.project.mainTimelineId)
    } else {
      state.seqIndex = Math.max(0, state.project.sequences.indexOf(currentSequence()))
      renderTimelineRail?.()
    }
    return doc
  },

  /** Group items of the open timeline into a new sub-timeline, leaving one block. */
  async nestItems({ itemIds, name } = {}) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.guardClaim(seq)
    const ids = itemIds?.length ? itemIds : (state.selectedItems ?? []).map((i) => i.id)
    SEQ.nestPlan(seq, ids) // refuse before a document is created
    const n = (state.project.sequences ?? []).length
    const child = await editor.createSequence({
      name: name || `Section ${n}`,
      width: seq.width,
      height: seq.height,
      fps: seq.fps,
      background: { mode: 'transparent', color: '#000000' },
      tracks: [], // the members bring their own
      open: false,
    })
    const r = SEQ.nestItems(seq, child, ids)
    historyFor(child).last = historySnapshotOf(child)
    markTimelineDirty(child)
    commit(seq)
    if (seq === currentSequence()) {
      state.timeline?.select(r.block.id)
      selectItem(r.block)
    }
    return { ...r, child }
  },

  /** Replace a block with the items inside it. */
  async flattenItem(itemId) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.guardClaim(seq)
    const found = SEQ.findItem(seq, itemId)
    if (!found || found.item.type !== 'timeline') throw new Error(`"${itemId}" is not a timeline block`)
    const child = timelineById(found.item.sourceId)
    if (!child) throw new Error(`the timeline "${found.item.name}" plays no longer exists`)
    const r = SEQ.flattenItem(seq, child, itemId)
    commit(seq)
    if (seq === currentSequence()) {
      state.timeline?.selectMany(r.placed.map((i) => i.id))
      state.selectedItems = r.placed
      state.selectedItem = r.placed[0] ?? null
      renderItemInspector()
      renderSelectionPanel()
    }
    const parts = [`flattened "${child.name}": ${r.placed.length} item(s) placed`]
    if (r.dropped.length) parts.push(`${r.dropped.length} outside the block's window left out`)
    if (r.fadesDropped) parts.push("the block's fades were dropped")
    return { ...r, message: parts.join('; ') }
  },

  async setSequenceSettings(patch) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.guardClaim(seq)
    if (patch.name != null && String(patch.name) && String(patch.name) !== seq.name) {
      seq.name = String(patch.name)
      // Blocks carry the name they were made with; they follow the rename.
      for (const other of state.project.sequences ?? []) {
        let touched = false
        for (const { item } of SEQ.allItems(other)) {
          if (item.type === 'timeline' && item.sourceId === seq.id) {
            item.name = seq.name
            touched = true
          }
        }
        if (touched) commit(other)
      }
    }
    if (patch.width != null) seq.width = clampInt(patch.width, 16, 7680, seq.width)
    if (patch.height != null) seq.height = clampInt(patch.height, 16, 7680, seq.height)
    if (patch.fps != null) seq.fps = clampInt(patch.fps, 1, 120, seq.fps)
    if (patch.background) seq.background = patch.background
    if (patch.note != null) {
      if (String(patch.note).trim()) seq.note = String(patch.note).trim()
      else delete seq.note
    }
    if (patch.main === true && state.project.mainTimelineId !== seq.id) {
      state.project.mainTimelineId = seq.id
      dirty.project = true
      scheduleSave()
    }
    if (seq === currentSequence()) {
      loadSequenceIntoUi()
      editor.ensureSequenceMode()
    }
    commit(seq)
    if (seq === currentSequence()) fitSeqStage()
    renderCrumb()
    return seq
  },

  getSequenceState() {
    const seq = currentSequence()
    return {
      mode: state.mode,
      timelineId: seq?.id ?? null,
      name: seq?.name ?? null,
      timeMs: state.compositor?.time ?? 0,
      playing: !!state.compositor?.playing,
      durationMs: seq ? SEQ.sequenceDuration(seq) : 0,
      selectedItemId: state.selectedItem?.id ?? null,
      selectedItemIds: (state.selectedItems ?? []).map((i) => i.id),
      undoDepth: seq ? historyFor(seq).undo.length : 0,
      redoDepth: seq ? historyFor(seq).redo.length : 0,
      busy: state.seqExporting,
      preview: state.compositor?.getStats?.() ?? null,
    }
  },

  /* --------------------------------------------------------------- library */

  listMedia: () => [...(state.lib?.media.values() ?? [])],

  async addMediaFromUrl(url, name) {
    const res = await fetch('/api/media/from-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, name }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? 'could not fetch that file')
    await state.lib.refresh()
    return body
  },

  listTranscripts: () => state.lib?.transcriptList ?? [],

  async getTranscript(id) {
    const t = await state.lib.loadTranscript(id)
    if (!t) throw new Error(`no transcript "${id}". Use list_transcripts.`)
    return t
  },

  /**
   * Find a phrase. With word-level timings the match is exact to the word;
   * otherwise it is the cue that contains it.
   */
  async findInTranscript(id, query) {
    const t = await editor.getTranscript(id)
    const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim()
    const q = norm(String(query))
    if (!q) throw new Error('query is empty')
    const tokens = q.split(' ')

    const words = []
    for (const cue of t.cues) for (const w of cue.words ?? []) words.push({ ...w, key: norm(w.text) })
    const hits = []

    if (words.length) {
      for (let i = 0; i + tokens.length <= words.length; i++) {
        let ok = true
        for (let k = 0; k < tokens.length; k++) {
          if (words[i + k].key !== tokens[k]) { ok = false; break }
        }
        if (ok) {
          hits.push({
            startMs: words[i].startMs,
            endMs: words[i + tokens.length - 1].endMs,
            text: words.slice(i, i + tokens.length).map((w) => w.text).join(' '),
            exact: true,
          })
        }
      }
    }
    if (!hits.length) {
      t.cues.forEach((cue, index) => {
        if (norm(cue.text).includes(q)) {
          hits.push({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text, exact: false, cueIndex: index })
        }
      })
    }
    return hits
  },

  /* ----------------------------------------------------------------- items */

  addToSequence(kind, sourceId, opts = {}) {
    return insertSource({ kind, id: sourceId }, opts)
  },

  listTextPresets: () => TEXT_PRESETS.map((p) => ({ id: p.id, name: p.name, note: p.note, kind: p.kind ?? 'text', fields: p.fields, defaultDurationMs: p.defaultDurationMs })),

  addText({ preset, text, subtext, atMs, durationMs, trackId, anchor, offsetX, offsetY, opacity, style, name } = {}) {
    return insertSource(
      { kind: 'text', id: preset ?? 'title', text: text ?? '', subtext: subtext ?? '', textStyle: style, anchor, offsetX, offsetY, opacity, name },
      { atMs, durationMs, trackId },
    )
  },

  /** Select items on the timeline, as shift-click would. */
  selectItems(ids) {
    editor.ensureSequenceMode()
    const seq = currentSequence()
    const valid = (ids ?? []).filter((id) => SEQ.findItem(seq, id))
    state.timeline.selectMany(valid)
    return state.selectedItems
  },

  getItem(id) {
    const seq = scopedSequence()
    const found = seq && SEQ.findItem(seq, id)
    if (!found) throw new Error(`no item "${id}". Use get_timeline to see item ids.`)
    return { ...found, seq }
  },

  async setItem(id, patch) {
    const { item, track, seq } = editor.getItem(id)
    editor.guardClaim(seq)
    if (patch.name != null) item.name = String(patch.name) || item.name
    if (patch.startMs != null) item.startMs = Math.max(0, Math.round(patch.startMs))
    if (patch.durationMs != null) item.durationMs = Math.max(40, Math.round(patch.durationMs))
    if (patch.inMs != null) item.inMs = Math.max(0, Math.round(patch.inMs))
    if (patch.fit != null) {
      if (!['contain', 'cover', 'fill', 'none'].includes(patch.fit)) throw new Error('fit must be contain, cover, fill or none')
      item.fit = patch.fit
    }
    if (patch.anchor != null) item.anchor = patch.anchor
    if (patch.offsetX != null) item.offsetX = Math.round(Number(patch.offsetX) || 0)
    if (patch.offsetY != null) item.offsetY = Math.round(Number(patch.offsetY) || 0)
    if (patch.scale != null) {
      if (!SEQ.scales(item)) throw new Error(`a ${item.type} item has no scale — set its own size instead (imageStyle/textStyle width and height, or textStyle fontSize)`)
      const k = Number(patch.scale)
      if (!Number.isFinite(k) || k < SEQ.SCALE_MIN || k > SEQ.SCALE_MAX) throw new Error(`scale must be between ${SEQ.SCALE_MIN} and ${SEQ.SCALE_MAX}`)
      item.scale = k
    }
    if (patch.speed != null) {
      const rate = Number(patch.speed)
      if (!Number.isFinite(rate) || rate < SEQ.SPEED_MIN || rate > SEQ.SPEED_MAX) {
        throw new Error(`speed must be between ${SEQ.SPEED_MIN} and ${SEQ.SPEED_MAX}`)
      }
      if (item.type !== 'media' && item.type !== 'timeline' && item.type !== 'animation') {
        throw new Error(`a ${item.type} item has no speed — its timing comes from its own length or its transcript`)
      }
      if (Math.abs(rate - 1) < 0.001) delete item.speed
      else item.speed = rate
    }
    if (patch.dissolveInSeconds != null) {
      const n = Math.max(0, Math.round(Number(patch.dissolveInSeconds) * 1000) || 0)
      if (n) item.dissolveInMs = Math.min(n, item.durationMs)
      else delete item.dissolveInMs
    }
    if (patch.dissolveOutSeconds != null) {
      const n = Math.max(0, Math.round(Number(patch.dissolveOutSeconds) * 1000) || 0)
      if (n) item.dissolveOutMs = Math.min(n, item.durationMs)
      else delete item.dissolveOutMs
    }
    if (patch.rotation != null) {
      const d = ((Math.round(Number(patch.rotation) || 0) % 360) + 360) % 360
      const deg = d > 180 ? d - 360 : d
      if (deg) item.rotation = deg
      else delete item.rotation
    }
    if (patch.flipH != null) { if (patch.flipH) item.flipH = true; else delete item.flipH }
    if (patch.flipV != null) { if (patch.flipV) item.flipV = true; else delete item.flipV }
    if (patch.crop !== undefined) {
      if (!patch.crop) delete item.crop
      else {
        if (item.type !== 'media' && item.type !== 'timeline') {
          throw new Error(`only footage and nested blocks can be cropped — a ${item.type} item has its own size instead`)
        }
        const g = (k) => Math.max(0, Math.min(0.95, Number(patch.crop[k] ?? item.crop?.[k]) || 0))
        item.crop = { top: g('top'), right: g('right'), bottom: g('bottom'), left: g('left') }
        if (!FX.cropOf(item)) throw new Error('that crop leaves nothing of the picture')
      }
    }
    if (patch.colour !== undefined) {
      if (!patch.colour) delete item.colour
      else {
        item.colour = { ...FX.COLOUR_NEUTRAL, ...(item.colour ?? {}), ...patch.colour }
        if (!FX.colourOf(item)) delete item.colour
      }
    }
    if (patch.blend != null) {
      if (patch.blend && patch.blend !== 'normal') {
        if (!FX.BLEND_MODES.includes(patch.blend)) throw new Error(`blend must be one of ${FX.BLEND_MODES.join(', ')}`)
        item.blend = patch.blend
      } else delete item.blend
    }
    if (patch.radius != null) {
      const n = Math.max(0, Math.round(Number(patch.radius) || 0))
      if (n) item.radius = n
      else delete item.radius
    }
    if (patch.shadow !== undefined) {
      if (!patch.shadow) delete item.shadow
      else {
        item.shadow = { blur: 0, x: 0, y: 0, color: '#000000', opacity: 0.45, ...(item.shadow ?? {}), ...patch.shadow }
        if (!FX.shadowOf(item)) delete item.shadow
      }
    }
    if (patch.opacity != null) item.opacity = Math.max(0, Math.min(1, Number(patch.opacity)))
    if (patch.volume != null) item.volume = Math.max(0, Math.min(4, Number(patch.volume)))
    if (patch.muted != null) item.muted = !!patch.muted
    if (patch.fadeInMs != null) item.fadeInMs = Math.max(0, Math.round(patch.fadeInMs))
    if (patch.fadeOutMs != null) item.fadeOutMs = Math.max(0, Math.round(patch.fadeOutMs))
    if (patch.captionStyle && item.type === 'caption') {
      item.captionStyle = { ...(item.captionStyle ?? SEQ.defaultCaptionStyle()), ...patch.captionStyle }
    }
    if (patch.note != null) {
      if (String(patch.note).trim()) item.note = String(patch.note).trim()
      else delete item.note
    }
    if (item.type === 'image' && patch.imageStyle && typeof patch.imageStyle === 'object') {
      item.imageStyle = { ...(item.imageStyle ?? {}), ...patch.imageStyle }
      for (const k of Object.keys(item.imageStyle)) if (item.imageStyle[k] == null || item.imageStyle[k] === false) delete item.imageStyle[k]
    }
    if (item.type === 'text') {
      if (patch.text != null) {
        item.text = String(patch.text)
        if (patch.name == null) item.name = item.text.trim().slice(0, 40) || (textPreset(item.sourceId)?.name ?? 'Text')
      }
      if (patch.subtext != null) item.subtext = String(patch.subtext)
      if (patch.preset != null) {
        if (!textPreset(patch.preset)) throw new Error(`unknown text preset "${patch.preset}". Use list_text_presets.`)
        item.sourceId = patch.preset
      }
      if (patch.textStyle && typeof patch.textStyle === 'object') {
        item.textStyle = { ...(item.textStyle ?? {}), ...patch.textStyle }
      }
    }
    // Re-place, so a longer item still obeys the one-item-per-instant rule.
    SEQ.placeItem(track, item)
    commit(seq)
    return item
  },

  async moveItem(id, { startMs, trackId }) {
    const { item, track, seq } = editor.getItem(id)
    editor.guardClaim(seq)
    const target = trackId ? resolveTrack(seq, trackId) : track
    if (target.kind !== track.kind) throw new Error(`cannot move a ${track.kind} item onto ${target.name} (${target.kind})`)
    if (target.locked) throw new Error(`track ${target.name} is locked`)
    SEQ.moveItem(seq, id, { startMs: startMs ?? item.startMs, trackId: target.id })
    commit(seq)
    return item
  },

  async splitItem(id, atMs) {
    const { item, seq } = editor.getItem(id)
    editor.guardClaim(seq)
    const at = atMs ?? (seq === currentSequence() ? state.compositor?.time : null) ?? 0
    const tail = SEQ.splitItem(seq, id, at)
    if (!tail) {
      throw new Error(
        `${(at / 1000).toFixed(2)}s is not inside ${id} (${(item.startMs / 1000).toFixed(2)}–${((item.startMs + item.durationMs) / 1000).toFixed(2)}s)`,
      )
    }
    commit(seq)
    return { head: item, tail }
  },

  /** Split an item's sound off onto its own audio track. One undo step. */
  async detachAudio(id) {
    const { item, seq } = editor.getItem(id)
    editor.guardClaim(seq)
    const media = state.lib.media.get(item.sourceId)
    const r = SEQ.detachAudio(seq, id, media)
    commit(seq)
    return r
  },

  async deleteItem(id, { ripple = false } = {}) {
    const { seq } = editor.getItem(id)
    editor.guardClaim(seq)
    const gone = ripple ? SEQ.rippleDelete(seq, id) : SEQ.removeItem(seq, id)
    commit(seq)
    return gone
  },

  async removeTimeRanges(ranges) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.guardClaim(seq)
    const clean = SEQ.normaliseRanges(ranges)
    if (!clean.length) throw new Error('no ranges to remove')
    const stats = SEQ.removeTimeRanges(seq, clean)
    commit(seq)
    return { ranges: clean.length, ...stats }
  },

  /** Ranges in the item's *source* time — a transcript's times — to timeline time, then cut. */
  async removeSourceRanges(itemId, ranges) {
    const { item } = editor.getItem(itemId)
    const from = item.inMs
    const to = item.inMs + item.durationMs
    const mapped = []
    for (const r of ranges) {
      const a = Math.max(r.startMs, from)
      const b = Math.min(r.endMs, to)
      if (b > a) mapped.push({ startMs: item.startMs + a - from, endMs: item.startMs + b - from })
    }
    if (!mapped.length) {
      throw new Error(
        `none of those ranges fall inside ${itemId}, which shows source ${(from / 1000).toFixed(2)}–${(to / 1000).toFixed(2)}s`,
      )
    }
    return editor.removeTimeRanges(mapped)
  },

  /* --------------------------------------------------------------- silence */

  async detectSilence({ itemId, media } = {}, params = {}) {
    // Only the params actually given override the editor's; an omitted one
    // must not arrive as `undefined` and erase the default.
    const p = { ...state.silenceParams }
    for (const k of Object.keys(params)) if (params[k] != null) p[k] = params[k]
    const filename = itemId ? editor.getItem(itemId).item.sourceId : media
    const m = state.lib.media.get(filename)
    if (!m) throw new Error(`no media "${filename}"`)
    if (!m.hasAudio) throw new Error(`${m.name} has no audio`)
    if (!m.hasPeaks) throw new Error(`${m.name} has no waveform — re-import it`)
    const peaks = await state.lib.loadPeaks(filename)
    const source = SEQ.detectSilence(peaks, p)
    if (!itemId) {
      return { scope: 'source', media: m, ranges: source, params: p, totalMs: source.reduce((n, r) => n + r.endMs - r.startMs, 0) }
    }
    const { item } = editor.getItem(itemId)
    const ranges = SEQ.silenceInItem(item, source)
    return { scope: 'timeline', item, ranges, params: p, totalMs: ranges.reduce((n, r) => n + r.endMs - r.startMs, 0) }
  },

  async removeSilence(itemId, params = {}) {
    const { ranges } = await editor.detectSilence({ itemId }, params)
    if (!ranges.length) return { gaps: 0, removedMs: 0, split: 0, removed: 0, shifted: 0 }
    const seq = scopedSequence()
    editor.guardClaim(seq)
    const stats = SEQ.removeTimeRanges(seq, ranges)
    commit(seq)
    return { gaps: ranges.length, ...stats }
  },

  /* ---------------------------------------------------------------- tracks */

  addTrack(kind, name) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.guardClaim(seq)
    if (kind !== 'video' && kind !== 'audio') throw new Error('kind must be video or audio')
    const count = seq.tracks.filter((t) => t.kind === kind).length
    const track = SEQ.makeTrack(kind, name || `${kind === 'video' ? 'V' : 'A'}${count + 1}`)
    if (kind === 'video') seq.tracks.unshift(track)
    else seq.tracks.push(track)
    commit(seq)
    return track
  },

  /** One subtitle file from caption items (all of the timeline's when itemIds is empty), timed as on the timeline. */
  async exportCaptions({ itemIds = [], format = 'srt', times = 'timeline', name = null } = {}) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    const all = [...SEQ.allItems(seq)].map((x) => x.item)
    const items = itemIds.length ? itemIds.map((id) => { const it = all.find((i) => i.id === id); if (!it) throw new Error(`no item "${id}"`); return it }) : all.filter((i) => i.type === 'caption')
    const cues = await captionCuesOf(items, { times })
    const base = name || (items.length === 1 ? items[0].name : `${seq.name} captions`)
    const res = await fetch('/api/export/captions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: base, format, cues }) })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? 'captions export failed')
    return r
  },

  /** Reorder a track among those of its kind: direction up|down|top|bottom, or a position from the top. */
  moveTrack(id, { direction = null, index = null } = {}) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    const track = resolveTrack(seq, id)
    editor.guardClaim(seq)
    const r = SEQ.moveTrack(seq, track.id, index != null ? Number(index) : direction ?? 'up')
    if (r.moved) commit(seq)
    return { track, ...r, order: seq.tracks.map((t) => `${t.name} (${t.kind})`) }
  },

  setTrack(id, patch) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    const track = resolveTrack(seq, id)
    editor.guardClaim(seq)
    if (patch.name != null) track.name = String(patch.name) || track.name
    if (patch.muted != null) track.muted = !!patch.muted
    if (patch.hidden != null) track.hidden = !!patch.hidden
    if (patch.locked != null) track.locked = !!patch.locked
    if (patch.note != null) {
      if (String(patch.note).trim()) track.note = String(patch.note).trim()
      else delete track.note
    }
    if (patch.color != null) {
      const c = String(patch.color).trim().toLowerCase()
      if (!c || c === 'none') delete track.color
      else if (/^#[0-9a-f]{6}$/.test(c)) track.color = c
      else throw new Error('color must be #rrggbb or "none"')
    }
    commit(seq)
    return track
  },

  /* --------------------------------------------------------------- looking */

  seekSequence(ms) {
    editor.ensureSequenceMode()
    state.compositor.pause()
    $('btnSeqPlay').textContent = '▶'
    state.compositor.seekTo(Math.max(0, ms))
    return state.compositor.time
  },

  async captureSequenceFrame(ms) {
    const seq = currentSequence()
    if (!seq) throw new Error('no timeline is open')
    if (SEQ.sequenceDuration(seq) <= 0) throw new Error('the timeline is empty')
    editor.ensureSequenceMode()
    $('btnSeqPlay').textContent = '▶'
    const canvas = await state.compositor.snapshot(ms ?? state.compositor.time)
    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas is empty'))), 'image/png'),
    )
    const res = await fetch(`/api/frame?name=${encodeURIComponent(seq.name + '-frame')}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: blob,
    })
    if (!res.ok) throw new Error((await res.json()).error ?? 'frame upload failed')
    return { ...(await res.json()), timeMs: state.compositor.time, width: seq.width, height: seq.height }
  },

  /**
   * What is said when, in this timeline's own seconds. Captions map their
   * cues through their in-point; footage whose transcript is bound in the
   * library maps the same way. This is what an agent plans overlays from —
   * "at the moment he says X" — without converting source times by hand.
   */
  async narration({ fromMs = 0, toMs = Infinity, query = null } = {}) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim()
    const q = query ? norm(query) : null
    const sources = await transcriptSourcesOf(seq)
    const lines = []
    const seen = new Set()
    for (const { item, transcript } of sources) {
      const from = item.inMs
      const to = item.inMs + item.durationMs
      for (const cue of transcript.cues) {
        if (cue.endMs <= from || cue.startMs >= to) continue
        const tl = item.startMs + (cue.startMs - from)
        const tlEnd = item.startMs + (Math.min(cue.endMs, to) - from)
        if (tlEnd < fromMs || tl > toMs) continue
        const text = cue.text.replace(/\s+/g, ' ').trim()
        if (q && !norm(text).includes(q)) continue
        const key = `${Math.round(tl / 100)}|${text}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push({ tlMs: tl, endMs: tlEnd, text, itemId: item.id })
      }
    }
    lines.sort((a, b) => a.tlMs - b.tlMs)
    return { lines, sources: sources.length }
  },

  /** Where a source time of a transcript lands on this timeline, through every item that plays it. */
  async sourceToTimeline(transcriptId, srcMs, srcEndMs = srcMs) {
    const seq = scopedSequence()
    if (!seq) return []
    const out = []
    for (const { item, transcript } of await transcriptSourcesOf(seq)) {
      if (transcript.id !== transcriptId) continue
      const from = item.inMs, to = item.inMs + item.durationMs
      // A phrase that straddles a cut still lands: from its first instant inside the item.
      if (srcEndMs <= from || srcMs >= to) continue
      out.push({ tlMs: item.startMs + (Math.max(srcMs, from) - from), itemId: item.id })
    }
    return out
  },

  /** A tiled contact sheet of composited frames, saved as one PNG. */
  async captureSequenceStrip({ count = 6, fromMs = 0, toMs = null } = {}) {
    const seq = currentSequence()
    if (!seq) throw new Error('no timeline is open')
    const total = SEQ.sequenceDuration(seq)
    if (total <= 0) throw new Error('the timeline is empty')
    editor.ensureSequenceMode()
    $('btnSeqPlay').textContent = '▶'
    const n = Math.max(2, Math.min(12, Math.round(count)))
    const end = Math.max(0, Math.min(total, toMs ?? total))
    const start = Math.max(0, Math.min(fromMs, end))
    const frames = []
    for (let i = 0; i < n; i++) {
      const t = start + (end - start) * (i / (n - 1))
      frames.push({ t, canvas: await state.compositor.snapshot(t) })
    }
    const sheet = tileSheet(frames, seq.width, seq.height)
    const blob = await new Promise((res, rej) => sheet.toBlob((b) => (b ? res(b) : rej(new Error('canvas is empty'))), 'image/png'))
    const res = await fetch(`/api/frame?name=${encodeURIComponent(seq.name + '-strip')}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: blob,
    })
    if (!res.ok) throw new Error((await res.json()).error ?? 'strip upload failed')
    return { ...(await res.json()), frames: n, fromMs: start, toMs: end, width: seq.width, height: seq.height }
  },

  /**
   * Where the overlays actually are on screen, and which ones collide.
   *
   * Every overlay is a full-frame transparent clip; where its content sits
   * is only known by drawing it. Each one is mounted offscreen, sampled at a
   * quarter, half and three quarters of its life, and the union of its
   * painted elements taken. Pairs that share time and pixels are reported.
   */
  async checkLayout({ fromMs = 0, toMs = Infinity } = {}) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    await ensureTranscriptsLoaded(seq)
    const ctx = seqContext()
    const measured = []
    const skipped = []
    for (const track of SEQ.videoTracks(seq)) {
      if (track.hidden) continue
      for (const item of track.items) {
        if (item.type === 'media' || item.type === 'timeline') continue
        if (SEQ.itemEnd(item) < fromMs || item.startMs > toMs) continue
        const clip = SEQ.overlayClipFor(item, { ...ctx, seq })
        if (!clip) { skipped.push(item); continue }
        const bounds = await overlayBounds(item, clip, seq)
        measured.push({ item, track, bounds })
      }
    }
    const overlaps = []
    for (let a = 0; a < measured.length; a++) {
      for (let b = a + 1; b < measured.length; b++) {
        const A = measured[a], B = measured[b]
        if (!A.bounds || !B.bounds) continue
        const t0 = Math.max(A.item.startMs, B.item.startMs)
        const t1 = Math.min(SEQ.itemEnd(A.item), SEQ.itemEnd(B.item))
        if (t1 - t0 < 200) continue
        const ix = Math.min(A.bounds.x + A.bounds.w, B.bounds.x + B.bounds.w) - Math.max(A.bounds.x, B.bounds.x)
        const iy = Math.min(A.bounds.y + A.bounds.h, B.bounds.y + B.bounds.h) - Math.max(A.bounds.y, B.bounds.y)
        if (ix < 8 || iy < 8) continue
        const smaller = Math.min(A.bounds.w * A.bounds.h, B.bounds.w * B.bounds.h) || 1
        overlaps.push({ a: A, b: B, t0, t1, pct: Math.min(100, Math.round((100 * ix * iy) / smaller)) })
      }
    }
    overlaps.sort((x, y) => y.pct - x.pct || x.t0 - y.t0)
    return { measured, skipped, overlaps }
  },

  /** Preflight: the faults that only show once the file is rendered. */
  checkSequence() {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    const out = []
    const media = state.lib.media
    const clips = state.project.clips
    let items = 0
    let sound = 0

    for (const track of seq.tracks) {
      for (const item of track.items) {
        items++
        const where = `${item.id} "${item.name}" on ${track.name}`
        if (item.type === 'media') {
          const m = media.get(item.sourceId)
          if (!m) { out.push(`ERROR ${where}: its media file is missing from the library`); continue }
          if (m.hasAudio && !item.muted && !track.muted) sound++
          const over = item.inMs + item.durationMs - m.durationMs
          if (over > 40) out.push(`WARN ${where} runs ${(over / 1000).toFixed(2)}s past the end of its file — that tail will be empty`)
          if (m.kind === 'audio' && track.kind === 'video') out.push(`INFO ${where} is audio on a video track; it plays, but an audio track is tidier`)
          if (m.hasVideo && track.kind === 'video' && (item.fit ?? 'contain') === 'contain' && m.width && m.height) {
            const src = m.width / m.height
            const dst = seq.width / seq.height
            if (Math.abs(src - dst) > 0.02) out.push(`INFO ${where} is ${m.width}x${m.height} in a ${seq.width}x${seq.height} frame; fit:contain letterboxes it (fit:cover crops instead)`)
          }
        } else if (item.type === 'animation') {
          const clip = clips.find((c) => c.id === item.sourceId)
          if (!clip) { out.push(`ERROR ${where}: its clip no longer exists`); continue }
          if (clip.background.mode !== 'transparent' && track !== SEQ.videoTracks(seq).at(-1)) {
            out.push(`WARN ${where}: clip "${clip.name}" has a solid background, so as an overlay it covers everything beneath it. Set its background to transparent.`)
          }
          const over = item.inMs + item.durationMs - clip.durationMs
          if (over > 40) out.push(`INFO ${where} is held ${(over / 1000).toFixed(2)}s past the end of the animation (its last frame stays up)`)
          if (clip.width > seq.width || clip.height > seq.height) out.push(`WARN ${where}: clip is ${clip.width}x${clip.height}, larger than the ${seq.width}x${seq.height} frame`)
        } else if (item.type === 'text') {
          if (!textPreset(item.sourceId)) out.push(`ERROR ${where}: unknown text preset "${item.sourceId}"`)
          if ((textPreset(item.sourceId)?.kind ?? 'text') !== 'shape' && !(item.text ?? '').trim()) out.push(`WARN ${where} has no text — nothing will be shown`)
        } else if (item.type === 'image') {
          const asset = seqContext().assets.get(item.sourceId)
          if (!asset) { out.push(`ERROR ${where}: image "${item.sourceId}" is not in Assets any more`); continue }
          const st = item.imageStyle ?? {}
          if ((st.width && st.width > seq.width) || (st.height && st.height > seq.height)) out.push(`WARN ${where}: sized ${st.width ?? '?'}x${st.height ?? '?'}, larger than the ${seq.width}x${seq.height} frame`)
        } else if (item.type === 'caption') {
          const t = state.lib.transcripts.get(item.sourceId)
          if (!t) { out.push(`WARN ${where}: transcript not loaded yet — call get_transcript first`); continue }
          const n = t.cues.filter((c) => c.endMs > item.inMs && c.startMs < item.inMs + item.durationMs).length
          if (!n) out.push(`WARN ${where} covers no cues — nothing will be shown`)
        } else if (item.type === 'timeline') {
          const child = timelineById(item.sourceId)
          if (!child) { out.push(`ERROR ${where}: its timeline no longer exists`); continue }
          const all = seqContext().timelines
          if (SEQ.wouldCycle(all, seq.id, child.id)) { out.push(`ERROR ${where}: "${child.name}" contains this timeline — a loop; nothing inside it will render`); continue }
          const content = SEQ.sequenceDuration(child)
          if (content <= 0) out.push(`WARN ${where}: "${child.name}" is empty`)
          else {
            const over = item.inMs + item.durationMs - content
            if (over > 40) out.push(`WARN ${where} runs ${(over / 1000).toFixed(2)}s past the end of "${child.name}" — that tail will be empty`)
            if (item.inMs >= content) out.push(`ERROR ${where} starts past the end of its content — nothing will be shown`)
          }
          if (!item.muted && !track.muted) sound++
          if (child.width !== seq.width || child.height !== seq.height) out.push(`INFO ${where} is ${child.width}x${child.height} in a ${seq.width}x${seq.height} frame; fit:${item.fit ?? 'contain'}`)
        }
      }
      if (track.locked) out.push(`INFO track ${track.name} is locked; ripple edits skip it`)
    }
    if (!items) out.push('ERROR the timeline is empty')
    else if (!sound) out.push('INFO the timeline has no audible sound')
    if (seq.width % 2 || seq.height % 2) out.push(`INFO ${seq.width}x${seq.height} has an odd dimension; MP4 rounds it down`)
    out.push(`INFO ${items} item(s), ${(SEQ.sequenceDuration(seq) / 1000).toFixed(1)}s at ${seq.fps}fps, ${seq.width}x${seq.height}`)
    return out
  },

  async renderSequence({ format, quality } = {}) {
    editor.ensureSequenceMode()
    return runSequenceRender({ format, quality, download: false })
  },

  /* -------------------------------------------------- transcription, voice */

  /**
   * What speech this browser can currently do, and where it would happen.
   *
   * Deliberately read-only. An agent may use whatever the person has set up and
   * may say what is missing, but it never writes a credential: a key belongs to
   * the person at the keyboard, and a tool that could set one is a tool that
   * could be talked into setting one.
   */
  speechStatus() {
    const s = INTEGRATIONS.load()
    const describe = (kind, id) => {
      const p = kind === 'stt' ? SPEECH.sttProvider(id) : SPEECH.ttsProvider(id)
      if (!p) return { set: false, leaves: false }
      const r = INTEGRATIONS.readiness(p, { local: state.local })
      const conf = INTEGRATIONS.configFor(p.id)
      const w = SPEECH.actualWhere(p, conf)
      return {
        set: true,
        id: p.id,
        label: p.label,
        // Derived from the address as configured, never from the row: a text
        // box takes any host, and this is the value an agent reports onward.
        where: w.label,
        host: SPEECH.hostOf(p, conf),
        leaves: w.id === 'provider',
        ready: r.ok,
        why: r.why,
        canRecord: !!p.speak,
      }
    }
    return {
      transcription: describe('stt', s.stt),
      voice: describe('tts', s.tts),
      /** Agent-initiated uploads are off until the person turns them on. */
      agentMayEgress: !!s.agentMayEgress,
      // Always available, no setup, nothing leaves: the fallback worth naming.
      systemVoices: typeof speechSynthesis !== 'undefined',
    }
  },

  async transcribeMedia(filename) {
    const m = state.lib.media.get(filename)
    if (!m) throw new Error(`no media "${filename}". Use list_media.`)
    if (!m.hasAudio) throw new Error(`"${filename}" has no sound to write down`)
    return transcribeFromUi(m)
  },

  async addVoiceOver(text, { voice = null, name = null, atMs = null } = {}) {
    editor.ensureSequenceMode()
    const m = await INTEGRATIONS.generateVoice(text, { voice, name, local: state.local })
    await state.lib.refresh()
    if (atMs != null) state.compositor?.seekTo(Math.max(0, atMs))
    insertFromUi({ kind: 'media', id: m.filename })
    return m
  },

  timeScript: (text) => INTEGRATIONS.timeScript(text),

  undo: (timelineId = null) => undoSequence(timelineId ?? scope.id),
  redo: (timelineId = null) => redoSequence(timelineId ?? scope.id),
  /** Undo and redo depth of the timeline a call is aimed at. */
  historyDepth() {
    const seq = scopedSequence()
    const h = seq ? historyFor(seq) : null
    return { undo: h?.undo.length ?? 0, redo: h?.redo.length ?? 0 }
  },

  /* ---------------------------------------------------------- transcripts */

  /** "From 12.3 to 15.0 the new voice says …": replace the cues in a window. */
  async editTranscript(id, { fromMs, toMs, cues }) {
    const t = await state.lib.patchTranscript(id, fromMs, toMs, cues)
    markDirty()
    editor.ensureSequenceMode()
    refreshSequence()
    return t
  },

  async setCue(id, index, patch) {
    const t = await editor.getTranscript(id)
    if (!(index >= 0 && index < t.cues.length)) throw new Error(`cue ${index} does not exist (${t.cues.length} cues)`)
    const cues = t.cues.map((c) => ({ ...c }))
    const cue = cues[index]
    if (patch.delete) cues.splice(index, 1)
    else {
      if (patch.text != null) {
        // Timings survive a same-length fix; otherwise they go, not linger.
        const r = SEQ.rewordCue(cue, String(patch.text))
        delete cue.words
        Object.assign(cue, r)
      }
      if (patch.startMs != null) cue.startMs = Math.max(0, Math.round(patch.startMs))
      if (patch.endMs != null) cue.endMs = Math.round(patch.endMs)
      if (cue.endMs <= cue.startMs) throw new Error('a cue must end after it starts')
    }
    const next = await state.lib.saveTranscriptCues(id, cues)
    markDirty()
    refreshSequence()
    return next
  },

  async insertCue(id, cue) {
    const t = await editor.getTranscript(id)
    const cues = [...t.cues.map((c) => ({ ...c })), { startMs: Math.round(cue.startMs), endMs: Math.round(cue.endMs), text: String(cue.text ?? '') || '…' }]
    const next = await state.lib.saveTranscriptCues(id, cues)
    markDirty()
    refreshSequence()
    return next
  },

  async undoTranscriptEdit(id) {
    const t = await state.lib.undoTranscript(id)
    if (!t) return null
    markDirty()
    refreshSequence()
    return t
  },

  /* --------------------------------------------------------------- voice */

  /**
   * Put a new sound under an item: the item's own sound is muted and the new
   * file laid on an audio track, aligned to the item's start. The reply says
   * how much shorter or longer the new sound is, so the picture can be
   * trimmed or held to match.
   */
  async replaceAudio(itemId, mediaFilename, { inMs = 0 } = {}) {
    const { item, seq } = editor.getItem(itemId)
    editor.guardClaim(seq)
    const media = state.lib.media.get(mediaFilename)
    if (!media) throw new Error(`no media "${mediaFilename}". Use list_media.`)
    if (!media.hasAudio) throw new Error(`${media.name} has no sound`)
    const inPoint = Math.max(0, Math.round(inMs))
    const available = Math.max(40, media.durationMs - inPoint)

    const audio = SEQ.makeMediaItem(media, { startMs: item.startMs, durationMs: Math.min(item.durationMs, available), inMs: inPoint })
    audio.name = `${item.name} · voice`
    audio.fit = 'none'
    audio.note = `replaces sound of ${item.id}`
    const track = SEQ.freeAudioTrack(seq, audio.startMs, audio.startMs + audio.durationMs)
    SEQ.placeItem(track, audio)
    item.muted = true
    // A sound detached from this picture earlier is its sound too.
    const twins = []
    for (const { item: other } of SEQ.allItems(seq)) {
      if (other !== audio && other.note === `sound of ${item.id}` && !other.muted) {
        other.muted = true
        twins.push(other)
      }
    }
    if (media.hasPeaks) state.lib.loadPeaks(media.filename)

    commit(seq)
    return {
      audio,
      track,
      mutedTwins: twins,
      shorterByMs: Math.max(0, item.durationMs - available),
      longerByMs: Math.max(0, available - item.durationMs),
    }
  },

  /* -------------------------------------------------------------- parts */

  /**
   * Pieces as files. Footage items cut to their source range as picture,
   * sound or both; sound items as sound; titles, captions and animations as
   * alpha renders; the transcript excerpt of the same range, re-based to
   * zero; and optionally a window of the whole mix. Everything lands in
   * data/exports; with `zip` it comes back bundled too.
   */
  async exportParts({
    itemIds = [],
    range = null,
    what = null,
    audioFormat = 'wav',
    videoFormat = 'mp4',
    transcript = true,
    zip = true,
    name = null,
    onProgress = () => {},
  } = {}) {
    const seq = scopedSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.ensureSequenceMode()
    const parts = []
    const notes = []
    const ids = [...new Set(itemIds)]
    const transcriptFor = (mediaFile) => (state.lib.transcriptList ?? []).find((t) => t.mediaFilename === mediaFile)

    for (let i = 0; i < ids.length; i++) {
      const { item, track } = editor.getItem(ids[i])
      onProgress({ phase: 'parts', label: `${item.name} — ${i + 1} of ${ids.length}`, progress: i / (ids.length + 1) })
      const from = item.inMs
      const to = item.inMs + item.durationMs

      if (item.type === 'media') {
        const m = state.lib.media.get(item.sourceId)
        if (!m) {
          notes.push(`${item.name}: media missing`)
          continue
        }
        // An item on an audio track is its sound, whatever the file holds.
        let mode = track.kind === 'audio' ? 'audio' : (what ?? 'both')
        if (mode !== 'audio' && !m.hasVideo) mode = 'audio'
        if (mode !== 'video' && !m.hasAudio) mode = 'video'
        parts.push({ kind: 'media', file: item.sourceId, fromMs: from, toMs: to, what: mode, audioFormat, videoFormat, label: item.name })
        const t = transcript ? transcriptFor(item.sourceId) : null
        if (t) parts.push({ kind: 'transcript', id: t.id, fromMs: from, toMs: to, format: 'srt', label: `${item.name}-words` })
        continue
      }

      if (item.type === 'caption' && transcript) {
        parts.push({ kind: 'transcript', id: item.sourceId, fromMs: from, toMs: to, format: 'srt', label: `${item.name}-words` })
      }
      // Titles, captions and animations: their alpha render, on its own.
      const r = await renderOverlayItem({
        item,
        seq,
        clips: state.project.clips,
        transcripts: state.lib.transcripts,
        assets: seqContext().assets,
        overlayFormat: $('seqOverlayFormat').value,
        onProgress: (p) =>
          onProgress({ phase: 'parts', label: `${item.name} — rendering`, frame: p.frame, frameCount: p.frameCount, progress: (i + (p.progress ?? 0)) / (ids.length + 1) }),
      })
      if (r.skipped) notes.push(`skipped ${r.skipped}`)
      else parts.push({ kind: 'file', name: r.file, label: item.name })
    }

    if (range) {
      const output = range.output ?? 'both'
      const fmt = output === 'audio' ? (audioFormat === 'mp3' ? 'mp3' : 'wav') : videoFormat
      onProgress({ phase: 'parts', label: `mix ${(range.fromMs / 1000).toFixed(1)}–${(range.toMs / 1000).toFixed(1)}s`, progress: ids.length / (ids.length + 1) })
      const r = await runSequenceRender({ format: fmt, download: false, fromMs: range.fromMs, toMs: range.toMs, output })
      parts.push({ kind: 'file', name: r.filename, label: `mix-${output}` })
    }

    if (!parts.length) throw new Error(notes.length ? notes.join('; ') : 'nothing to export')

    onProgress({ phase: 'parts', label: zip ? 'bundling…' : 'finishing…', progress: 0.95 })
    const res = await fetch('/api/export/parts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name ?? seq.name, zip, parts }),
    })
    const out = await res.json()
    if (!res.ok) throw new Error(out.error ?? `export failed (${res.status})`)
    onProgress({ phase: 'complete', progress: 1 })
    return { ...out, errors: [...(out.errors ?? []), ...notes] }
  },

  /* --------------------------------------------------------- extraction */

  /** One frame into Assets: the footage under the playhead, or the composite. */
  async saveFrame({ timeMs, source = 'footage', name = '' } = {}) {
    editor.ensureSequenceMode()
    const at = timeMs ?? state.compositor.time
    if (source === 'composite') {
      const seq = currentSequence()
      state.compositor.pause()
      const canvas = await state.compositor.snapshot(at)
      const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas is empty'))), 'image/png'))
      const res = await fetch(`/api/frame?name=${encodeURIComponent(name || `${seq.name}-${(at / 1000).toFixed(2)}s`)}&dest=assets`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: blob,
      })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? 'frame upload failed')
      await state.assets?.refresh()
      return out
    }
    const under = footageAt(at)
    if (!under) throw new Error(`no footage under the playhead at ${(at / 1000).toFixed(2)}s`)
    const asset = await extractRequest(under.media.filename, { mode: 'frame', fromMs: under.sourceMs, format: 'png', ...(name ? { name } : {}) })
    await state.assets?.refresh()
    return asset
  },

  /** Frame series, sprite sheet or sub-clip from a media file. */
  /* ------------------------------------------------------------- markers */

  addMarker({ atMs, label, timelineId } = {}) {
    const seq = timelineId ? timelineById(timelineId) : currentSequence()
    if (!seq) throw new Error(`no timeline "${timelineId}". Use list_timelines.`)
    editor.guardClaim(seq)
    if (seq !== currentSequence()) throw new Error('open that timeline first — markers are placed on the open one')
    const m = addMarker(atMs, label ?? '')
    if (!m) throw new Error('could not place a marker there')
    return m
  },

  listMarkers(timelineId) {
    const seq = timelineId ? timelineById(timelineId) : currentSequence()
    if (!seq) throw new Error(`no timeline "${timelineId}". Use list_timelines.`)
    return (seq.markers ?? []).slice().sort((a, b) => a.ms - b.ms)
  },

  deleteMarker(id, timelineId) {
    const seq = timelineId ? timelineById(timelineId) : currentSequence()
    if (!seq) throw new Error(`no timeline "${timelineId}". Use list_timelines.`)
    editor.guardClaim(seq)
    if (seq !== currentSequence()) throw new Error('open that timeline first')
    return removeMarker(id)
  },

  /* ---------------------------------------------------------- keyframes */

  setKeyframe({ itemId, property, atSeconds, value, ease } = {}) {
    const { item, seq } = editor.getItem(itemId)
    editor.guardClaim(seq)
    if (!KEYS.KEYABLE.includes(property)) {
      throw new Error(`${property} cannot be keyframed — only ${KEYS.KEYABLE.join(', ')}. Turning is a property you set once, because a box that changed size every frame would make the placement arithmetic time-varying everywhere.`)
    }
    if (property === 'scale' && !SEQ.scales(item)) {
      throw new Error(`a ${item.type} item has no scale — key its size through imageStyle/textStyle instead`)
    }
    const at = atSeconds != null
      ? Math.round(atSeconds * 1000)
      : Math.round((state.compositor?.time ?? 0) - item.startMs)
    if (at < 0 || at > item.durationMs) {
      throw new Error(`${(at / 1000).toFixed(2)}s is outside "${item.name}" (0–${(item.durationMs / 1000).toFixed(2)}s of its own time)`)
    }
    const v = value != null ? Number(value) : keyValueNow(item, property)
    if (!Number.isFinite(v)) throw new Error('value must be a number')
    KEYS.setKey(item, property, at, v, ease ?? 'ease', 1000 / (seq.fps || 30))
    commit(seq)
    return { item, at, v }
  },

  clearKeyframes(itemId, property = null) {
    const { item, seq } = editor.getItem(itemId)
    editor.guardClaim(seq)
    KEYS.clearKeys(item, property)
    commit(seq)
    return item
  },

  listKeyframes(itemId) {
    const { item } = editor.getItem(itemId)
    const out = {}
    for (const p of KEYS.KEYABLE) {
      const list = KEYS.keysFor(item, p)
      if (list) out[p] = list
    }
    return out
  },

  async freezeFrame({ atMs, source } = {}) {
    const seq = currentSequence()
    if (!seq) throw new Error('no timeline is open')
    editor.guardClaim(seq)
    if (atMs != null) state.compositor.seekTo(Math.max(0, Math.round(atMs)))
    return freezeFrame({ source: source === 'footage' ? 'footage' : 'composite' })
  },

  async crossDissolve(itemId, ms) {
    const { item, seq } = editor.getItem(itemId)
    editor.guardClaim(seq)
    if (seq !== currentSequence()) throw new Error('open that timeline first')
    selectItem(item)
    await crossDissolve(ms)
    const live = SEQ.findItem(seq, itemId)?.item
    return live?.dissolveOutMs
      ? `"${live.name}" dissolves out over ${(live.dissolveOutMs / 1000).toFixed(2)}s into the next item, which moved to the track above.`
      : 'Nothing to dissolve into.'
  },

  async extract({ media, itemId, mode, fromMs, toMs, count, fps, width, format, name } = {}) {
    let filename = media
    let from = fromMs
    let to = toMs
    if (itemId) {
      const { item } = editor.getItem(itemId)
      if (item.type !== 'media') throw new Error(`${itemId} is not footage`)
      filename = item.sourceId
      if (from == null) from = item.inMs
      if (to == null) to = item.inMs + item.durationMs
    }
    const m = state.lib.media.get(filename)
    if (!m) throw new Error(`no media "${filename}". Use list_media.`)
    const out = await extractRequest(filename, { mode, fromMs: from ?? 0, toMs: to ?? 0, count, fps, width, format, name })
    if (mode === 'subclip' || mode === 'reverse') await state.lib.refresh()
    else await state.assets?.refresh()
    return out
  },
}

function renderFormats() {
  const sel = $('expFormat')
  sel.innerHTML = ''
  for (const f of state.formats) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label + (f.alpha ? (f.alphaVerified ? ' · alpha' : ' · alpha unavailable') : '')
    sel.appendChild(o)
  }
  // A remembered format that this build cannot write — `mov` on a browser-only
  // build, or a format dropped from a later ffmpeg — would set `value` to the
  // empty string and leave the picker blank with no way to tell why.
  const remembered = localStorage.getItem('animationhtml:format')
  sel.value = state.formats.some((f) => f.id === remembered) ? remembered : (state.formats[0]?.id ?? '')
  updateFormatNote()
}

function updateFormatNote() {
  const f = state.formats.find((x) => x.id === $('expFormat').value)
  $('formatNote').textContent =
    (f?.note ?? '') +
    (f?.alpha && !f.alphaVerified
      ? `\n\n⚠ This ffmpeg build accepted the alpha pixel format for ${f.label} and then wrote an opaque file. Use a format marked · alpha instead.`
      : '')
  // ProRes 4444 is effectively fixed-rate; the CRF slider does nothing for it.
  const usesQuality = f && f.id !== 'mov'
  $('expQuality').disabled = !usesQuality
  $('expQuality').closest('label').style.opacity = usesQuality ? '1' : '0.4'
  if (f?.id === 'webm' && Number($('expQuality').value) < 10) $('expQuality').value = '24'
  $('expQualityVal').textContent = usesQuality ? $('expQuality').value : '—'
  localStorage.setItem('animationhtml:format', f?.id ?? 'mov')
}
$('expFormat').addEventListener('change', updateFormatNote)
$('expQuality').addEventListener('input', () => {
  $('expQualityVal').textContent = $('expQuality').value
})

function setExporting(on) {
  state.exporting = on
  $('btnStudio').disabled = on
  $('btnQuick').disabled = on
  $('btnExportAll').disabled = on
  $('btnPlay').disabled = on
  $('progressWrap').classList.toggle('hidden', !on)
  if (on) {
    $('exportResult').textContent = ''
    $('exportResult').classList.remove('error')
  }
}

function onProgress(p) {
  $('progressBar').style.width = `${Math.round((p.progress ?? 0) * 100)}%`
  const parts = []
  if (p.phase === 'preparing') parts.push('preparing…')
  else if (p.phase === 'rendering') parts.push(`frame ${p.frame}/${p.frameCount}`)
  else if (p.phase === 'recording') parts.push(`recording · ${p.frame} frames`)
  else if (p.phase === 'encoding') parts.push('encoding…')
  else if (p.phase === 'complete') parts.push('done')
  if (p.etaMs != null) parts.push(`~${Math.ceil(p.etaMs / 1000)}s left`)
  $('progressText').textContent = parts.join('  ·  ')
}

$('btnStudio').onclick = async () => {
  const clip = currentClip()
  if (!clip) return
  const controller = new AbortController()
  state.abort = controller
  setExporting(true)
  try {
    const r = await exportClip({
      host,
      clip,
      format: $('expFormat').value,
      quality: Number($('expQuality').value),
      onProgress,
      signal: controller.signal,
    })
    $('exportResult').textContent =
      `${r.filename}\n${formatBytes(r.size)} · ${r.frames} frames · ${(r.elapsedMs / 1000).toFixed(1)}s`
  } catch (err) {
    if (err.name !== 'AbortError') {
      $('exportResult').textContent = String(err.message ?? err)
      $('exportResult').classList.add('error')
    }
  } finally {
    setExporting(false)
    state.abort = null
    remount()
  }
}

$('btnQuick').onclick = async () => {
  const clip = currentClip()
  if (!clip) return
  const controller = new AbortController()
  state.abort = controller
  setExporting(true)
  try {
    const r = await quickExport({ host, clip, onProgress, signal: controller.signal })
    const target = clip.fps
    const warn =
      r.realFps < target * 0.9
        ? `\n⚠ captured ${r.realFps.toFixed(1)} fps against a target of ${target} — use Studio export for exact timing.`
        : ''
    $('exportResult').textContent =
      `${r.filename}\n${formatBytes(r.size)} · ${r.frames} frames · ${r.realFps.toFixed(1)} fps${warn}`
  } catch (err) {
    if (err.name !== 'AbortError') {
      $('exportResult').textContent = String(err.message ?? err)
      $('exportResult').classList.add('error')
    }
  } finally {
    setExporting(false)
    state.abort = null
    remount()
  }
}

$('btnCancel').onclick = () => state.abort?.abort()

$('btnExportAll').onclick = async () => {
  const controller = new AbortController()
  state.abort = controller
  setExporting(true)
  const format = $('expFormat').value
  const quality = Number($('expQuality').value)
  const done = []
  try {
    for (let i = 0; i < state.project.clips.length; i++) {
      state.clipIndex = i
      renderClips()
      loadClipIntoUi()
      const clip = state.project.clips[i]
      const r = await exportClip({
        host,
        clip,
        format,
        quality,
        signal: controller.signal,
        onProgress: (p) => onProgress({ ...p, frameCount: p.frameCount }),
      })
      done.push(`${r.filename} · ${formatBytes(r.size)}`)
      $('exportResult').textContent = done.join('\n')
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      $('exportResult').textContent = [...done, String(err.message ?? err)].join('\n')
      $('exportResult').classList.add('error')
    }
  } finally {
    setExporting(false)
    state.abort = null
    remount()
  }
}

/* ---------------------------------------------------------------- projects */

function relTime(ms) {
  const d = Date.now() - ms
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  return `${Math.floor(d / 86_400_000)} d ago`
}

/** Poster for a project row: the thumbnail of its first clip, if we have one. */
async function projectThumb(id) {
  try {
    const p = await fetch(`/api/projects/${id}`).then((r) => r.json())
    const first = p.clips?.[0]
    if (!first) return null
    const key = thumbKey(first)
    return state.thumbs.get(key) ?? localStorage.getItem(`animationhtml:thumb:${key}`)
  } catch {
    return null
  }
}

async function renderProjects() {
  const list = await fetch('/api/projects').then((r) => r.json())
  const ul = $('projectList')
  ul.innerHTML = ''

  for (const p of list) {
    const li = document.createElement('li')
    li.className = 'proj' + (p.id === state.project?.id ? ' current' : '')

    const thumb = document.createElement('div')
    thumb.className = 'pthumb'
    li.appendChild(thumb)
    projectThumb(p.id).then((src) => {
      if (src) thumb.style.backgroundImage = `url("${src}")`
    })

    const info = document.createElement('div')
    info.className = 'pinfo'
    const name = document.createElement('div')
    name.className = 'pname'
    name.textContent = p.name
    const meta = document.createElement('div')
    meta.className = 'pmeta'
    meta.textContent =
      `${p.clipCount} clip${p.clipCount === 1 ? '' : 's'} · ${relTime(p.updatedAt)}` +
      (p.id === state.project?.id ? ' · open' : '')
    if (p.id === state.project?.id) meta.classList.add('pcurrent')
    info.append(name, meta)
    li.appendChild(info)

    const acts = document.createElement('div')
    acts.className = 'pacts'

    const rename = document.createElement('button')
    rename.textContent = '✎'
    setTip(rename, 'Rename this project.')
    rename.onclick = (ev) => {
      ev.stopPropagation()
      const input = document.createElement('input')
      input.value = p.name
      name.textContent = ''
      name.appendChild(input)
      input.focus()
      input.select()
      const commit = async () => {
        const next = input.value.trim() || p.name
        input.replaceWith(next)
        if (next !== p.name) {
          const full = await fetch(`/api/projects/${p.id}`).then((r) => r.json())
          await fetch(`/api/projects/${p.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: next, clips: full.clips }),
          })
          if (p.id === state.project?.id) {
            state.project.name = next
            $('projectName').value = next
          }
          renderProjects()
        }
      }
      input.onblur = commit
      input.onkeydown = (k) => {
        if (k.key === 'Enter') input.blur()
        if (k.key === 'Escape') {
          input.replaceWith(p.name)
        }
        k.stopPropagation()
      }
    }

    const dup = document.createElement('button')
    dup.textContent = '⧉'
    setTip(dup, 'Make a copy of this project, with independent clips.')
    dup.onclick = async (ev) => {
      ev.stopPropagation()
      const full = await fetch(`/api/projects/${p.id}`).then((r) => r.json())
      const made = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${p.name} copy` }),
      }).then((r) => r.json())
      // Fresh clip ids so the copy is genuinely independent.
      const clips = full.clips.map((c) => ({ ...c, id: 'c_' + Math.random().toString(36).slice(2, 10) }))
      await fetch(`/api/projects/${made.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: made.name, clips }),
      })
      renderProjects()
    }

    // Two-step delete rather than a blocking confirm dialog.
    const del = document.createElement('button')
    del.textContent = '×'
    del.className = 'danger'
    setTip(del, 'Delete this project. Click twice to confirm.')
    let armed = false
    del.onclick = async (ev) => {
      ev.stopPropagation()
      if (!armed) {
        armed = true
        del.textContent = 'Delete?'
        del.classList.add('confirm')
        acts.classList.add('armed')
        setTimeout(() => {
          if (!armed) return
          armed = false
          del.textContent = '×'
          del.classList.remove('confirm')
          acts.classList.remove('armed')
        }, 3500)
        return
      }
      await fetch(`/api/projects/${p.id}`, { method: 'DELETE' })
      if (p.id === state.project?.id) {
        const rest = await fetch('/api/projects').then((r) => r.json())
        if (rest.length) await loadProject(rest[0].id)
        else {
          const fresh = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'My animations' }),
          }).then((r) => r.json())
          await loadProject(fresh.id)
        }
      }
      renderProjects()
    }

    // Local-first only means anything if the work can leave: one file with the
    // project, its footage and its images inside it.
    if (state.local) {
      const save = document.createElement('button')
      save.textContent = '⤓'
      setTip(save, 'Save this project as a file — documents, footage and images in one zip.')
      save.onclick = async (e) => {
        e.stopPropagation()
        try {
          status(`packing "${p.name}"…`)
          // Edits sit in a save debounce for most of a second. A file written
          // from the store before that lands is a file missing the last thing
          // you did — so settle first, then read.
          clearTimeout(saveTimer)
          await saveNow()
          const { blob, name } = await LOCAL.exportProjectFile(p.id)
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = name
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
          status(`saved ${name}`)
        } catch (err) {
          status(err?.message ?? String(err), 'error')
        }
      }
      acts.append(save)
    }
    acts.append(rename, dup, del)
    li.appendChild(acts)

    li.onclick = async () => {
      if (p.id === state.project?.id) {
        $('dlgProjects').close()
        return
      }
      $('dlgProjects').close()
      await loadProject(p.id)
      queueThumbs()
    }
    ul.appendChild(li)
  }
}

$('btnProjects').onclick = async () => {
  $('newProjectName').value = ''
  await renderProjects()
  await renderLocalPanel()
  $('dlgProjects').showModal()
}

/* ================================================ what this browser holds */
/*
 * With no server, the projects list is also the only place that can answer
 * "where is my work, and how do I get it out of here" — so it answers it.
 */

const fmtBytes = (n) =>
  n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024 ** 3).toFixed(2)} GB`

async function renderLocalPanel() {
  $('localPanel').classList.toggle('hidden', !state.local)
  if (!state.local) return
  const s = await LOCAL.storageUse()
  const c = s.counts
  $('localUse').textContent =
    `${c.projects} project${c.projects === 1 ? '' : 's'} · ` +
    `${c.media} media (${fmtBytes(c.mediaBytes)}) · ${c.assets} image${c.assets === 1 ? '' : 's'} (${fmtBytes(c.assetBytes)})\n` +
    `${fmtBytes(s.usage)} of ${fmtBytes(s.quota)} used· ` +
    (s.persisted
      ? 'marked as durable, so the browser will not evict it to reclaim space.'
      : 'not yet marked durable — the browser may reclaim it under storage pressure.')
}

function initLocalPanel() {
  $('btnImportProject').onclick = () => $('importProjectFile').click()
  $('importProjectFile').onchange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      status(`reading ${file.name}…`)
      const p = await LOCAL.importProjectFile(file)
      await renderProjects()
      await renderLocalPanel()
      $('dlgProjects').close()
      await loadProject(p.id)
      queueThumbs()
      status(`imported "${p.name}"`)
    } catch (err) {
      status(err?.message ?? String(err), 'error')
    }
  }

  // Twice, like every other irreversible button here — and this one takes
  // everything, so it says what "everything" is before it does it.
  let armed = false
  $('btnEraseLocal').onclick = async () => {
    const b = $('btnEraseLocal')
    if (!armed) {
      armed = true
      b.textContent = 'Erase everything — click again'
      b.classList.add('confirm')
      setTimeout(() => {
        if (!armed) return
        armed = false
        b.textContent = 'Erase everything'
        b.classList.remove('confirm')
      }, 4000)
      return
    }
    armed = false
    await LOCAL.eraseEverything()
    location.reload()
  }
}
$('btnProjClose').onclick = () => $('dlgProjects').close()

$('btnNewProject').onclick = async () => {
  const name = $('newProjectName').value.trim() || 'Untitled project'
  const p = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => r.json())
  $('dlgProjects').close()
  await loadProject(p.id)
  queueThumbs()
}
$('newProjectName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnNewProject').click()
  e.stopPropagation()
})

/* ---------------------------------------------------------------- snippets */

$('btnSnippets').onclick = () => {
  const ul = $('snippetList')
  ul.innerHTML = ''
  for (const s of SNIPPETS) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="pname"></span><span class="pmeta"></span>`
    li.querySelector('.pname').textContent = s.name
    li.querySelector('.pmeta').textContent = s.note
    li.onclick = () => {
      const clip = currentClip()
      clip.html = s.html
      clip.css = s.css
      clip.js = s.js ?? ''
      if (s.durationMs) clip.durationMs = s.durationMs
      $('dlgSnippets').close()
      markDirty()
      loadClipIntoUi()
    }
    ul.appendChild(li)
  }
  $('dlgSnippets').showModal()
}

/* -------------------------------------------------------------------- init */

async function loadProject(id) {
  const p = await fetch(`/api/projects/${id}`).then((r) => (r.ok ? r.json() : null))
  if (!p) return false
  // In memory the timelines keep the old field name; every reader uses it.
  p.sequences = p.timelines ?? []
  delete p.timelines
  state.project = p
  state.clipIndex = 0
  dirty.timelines.clear()
  dirty.project = false
  $('projectName').value = p.name
  localStorage.setItem('animationhtml:last', p.id)

  resolveActiveTimeline()
  loadSequenceIntoUi()
  state.selectedItem = null
  state.selectedItems = []
  histories.clear()
  crumbs.length = 0
  updateHistoryButtons()
  renderCrumb()

  renderClips()
  loadClipIntoUi()
  ensureTranscriptsLoaded()
  if (state.mode === 'seq') {
    refreshSequence()
    state.timeline?.zoomToFit()
  }
  renderTimelineRail?.()
  return true
}

async function init() {
  // Before anything else asks for data: is there a server behind this page?
  //
  // Locally there is, holding a folder of projects and gigabytes of footage.
  // Hosted there is not, and the browser is the whole back end — IndexedDB for
  // documents, OPFS for files. The decision is made once, here, and nothing
  // downstream knows which it got: `fetch('/api/…')` answers either way.
  state.local = !(await LOCAL.serverAvailable())
  // With a server behind the page, provider calls go through it: no request
  // leaves this origin, so nothing has to be told to allow us — see the relay.
  SPEECH.useRelay(!state.local)
  if (state.local) {
    // Before anything else, because everything else is built on it. This is
    // the one failure `install()`'s per-route 500 must not swallow — see
    // probeStorage() — so it is asked here, where it can stop the boot.
    await LOCAL.probeStorage()
    LOCAL.install()
    initLocalPanel()
    // Without this, everything here is a cache the browser may reclaim.
    LOCAL.requestPersistence().then(({ persisted }) => {
      // Chrome declines this on an origin it has never seen and grants it once
      // the site has been used, so on a first visit it is news, not a fault.
      if (!persisted) {
        status('your work is saved in this browser; Chrome marks it durable once you have used the site')
      }
    })
  }
  setLocalMode(state.local)

  state.runtimeSrc = await fetch('/runtime.js').then((r) => r.text())
  setRuntimeSource(state.runtimeSrc)

  const health = await fetch('/api/health').then((r) => r.json())
  state.formats = health.formats
  const pill = $('ffmpegState')
  pill.textContent = state.local ? 'in-browser' : health.ffmpeg ? 'ffmpeg ready' : 'ffmpeg missing'
  pill.classList.add(state.local || health.ffmpeg ? 'ok' : 'bad')
  setTip(
    pill,
    state.local
      ? 'Everything runs in this browser: your projects are in this browser\'s storage, and renders are encoded here with WebCodecs.\nNothing is uploaded anywhere.'
      : health.ffmpeg
        ? `Studio export is available.\n${health.ffmpegVersion}`
        : 'Studio export needs ffmpeg on PATH. Install it with: brew install ffmpeg',
    { at: 'bottom' },
  )
  $('btnStudio').disabled = !state.local && !health.ffmpeg
  renderFormats()
  renderOverlayFormats(health)

  state.lib = initMediaLibrary({
    onInsert: (payload) => insertFromUi(payload),
    onStatus: (message, kind) => status(message, kind),
    onEdit: (id) => openTranscriptEditor(id),
    // Straight to the job if it can be done, to the choice if it cannot.
    onSetUpSpeech: () => (state.speech?.isReady('stt') ? state.speech.openTranscribe() : state.speech?.open('stt')),
  })
  state.transcriptEditor = initTranscriptEditor({
    lib: state.lib,
    status,
    onChanged: () => {
      markDirty()
      refreshSequence()
    },
    seekToSource: async (id, srcMs) => {
      editor.ensureSequenceMode()
      const hits = await editor.sourceToTimeline(id, srcMs)
      if (!hits.length) return false
      state.compositor.pause()
      $('btnSeqPlay').textContent = '▶'
      state.compositor.seekTo(hits[0].tlMs)
      return true
    },
    currentSourceMs: (id) => transcriptSourceMsAtPlayhead(id),
    mediaChoices: () => [...(state.lib?.media.values() ?? [])].filter((m) => m.hasAudio).map((m) => ({ filename: m.filename, name: m.name })),
    onExport: ({ item, transcriptId }) => {
      if (item) openCaptionsDialog({ scope: 'item', item })
      else if (transcriptId) window.location.href = `/api/transcripts/${transcriptId}/export?format=srt`
    },
  })
  initSequenceMode()
  await initSequenceFormats()

  $('btnImportMedia').onclick = () => $('mediaInput').click()
  $('mediaInput').onchange = (e) => {
    state.lib.importFiles(e.target.files)
    e.target.value = ''
  }
  $('btnVoiceOver').onclick = () => state.speech?.openVoiceOver()
  $('btnImportText').onclick = () => $('textInput').click()
  $('textInput').onchange = (e) => {
    state.lib.importFiles(e.target.files)
    e.target.value = ''
  }

  setInterval(pollRevisions, 4000)

  const last = localStorage.getItem('animationhtml:last')
  if (!(last && (await loadProject(last)))) {
    const existing = await fetch('/api/projects').then((r) => r.json())
    if (Array.isArray(existing) && existing.length) {
      await loadProject(existing[0].id)
    } else if (state.local && (await seedDemo())) {
      // Seeded and opened inside seedDemo(); nothing more to do here.
    } else {
      const p = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'My animations' }),
      }).then((r) => r.json())
      await loadProject(p.id)
    }
  }

  initTooltips()
  initPanels()
  initContextMenus()
  initCaptionsDialog()
  initAgentDialog()
  state.speech = initIntegrations({
    $,
    status,
    isLocal: () => state.local,
    refreshLibrary: () => state.lib.refresh(),
    insertMedia: (filename) => insertFromUi({ kind: 'media', id: filename }),
    insertTranscript: (id) => insertFromUi({ kind: 'transcript', id }),
    mediaWithSound: () => [...(state.lib?.media?.values() ?? [])].filter((m) => m.hasAudio),
    mediaFor: (filename) => state.lib?.media?.get(filename) ?? null,
    playheadMs: () => state.compositor?.time ?? 0,
  })

  const savedH = localStorage.getItem('animationhtml:codeHeight')
  if (savedH) $('codePanel').style.height = savedH
  const savedSeqH = localStorage.getItem('animationhtml:seqHeight')
  if (savedSeqH) $('seqPanel').style.height = savedSeqH

  state.assets = initAssets({
    insertAtCursor,
    insertInto,
    activePane,
    // In Timeline mode an image goes onto a track, not into the code.
    mode: () => state.mode,
    onInsertTimeline: (a) => insertFromUi({ kind: 'image', id: a.filename }),
    // A single drop can carry a logo, a piece of footage and a subtitle file.
    onForeignFiles: (files) => state.lib?.importFiles(files),
  })
  await state.assets.refresh()
  await state.lib.refresh()
  queueThumbs()

  // Exposed for debugging and for re-registering against a stubbed
  // document.modelContext without the origin-trial flag.
  window.__editor = editor
  window.__registerAgentTools = registerAgentTools

  // A seeded demo is a timeline, so open on the timeline. Clip mode would put
  // a first visitor in front of a CSS pane, which answers a question nobody
  // arriving from a link has asked yet.
  if (state.seededDemo) {
    setMode('seq')
    // Zero is the one moment nothing has entered yet. Park on a frame where
    // the whole composition is up, so the first thing on screen is the piece.
    state.compositor?.seekTo(2200)
  }

  initAgentHint(await registerAgentTools())
}

/**
 * Give a hosted first visit something to look at — see demo.js for why.
 *
 * Failing to build the demo is a reason to fall back to an empty project, not
 * a reason for the editor not to open, so this reports whether it worked
 * rather than throwing into `init`.
 */
async function seedDemo() {
  // Once, and only once. Reaching zero projects again means somebody deleted
  // the demo, and putting it back on the next reload would be arguing with
  // them. Erase everything clears this along with the rest, so a deliberate
  // reset does start over.
  if (localStorage.getItem('klipvia:seeded')) return false
  try {
    const { seedDemoProject } = await import('/demo.js')
    const p = await seedDemoProject(LOCAL)
    if (!(await loadProject(p.id))) return false
    localStorage.setItem('klipvia:seeded', '1')
    state.seededDemo = true
    return true
  } catch (err) {
    console.warn('could not seed the demo project', err)
    return false
  }
}

/** Publish the editor to any AI agent running in this browser. */
async function registerAgentTools() {
  const pill = $('mcpState')
  const status = await initWebMcp(editor, { local: state.local })
  window.__webmcp = status

  if (status.ok) {
    pill.textContent = `webmcp · ${status.count} tools`
    pill.classList.add('ok')
    setTip(
      pill,
      `AI agents in this browser can drive the editor.\nvia ${status.via}, ${status.resultStyle} results` +
        (status.omitted ? `\n${status.omitted} tool(s) that need ffmpeg are not offered by this browser-only build.` : '') +
        `\n${status.names.join(', ')}`,
      { at: 'bottom' },
    )
  } else {
    pill.textContent = 'webmcp off'
    pill.classList.remove('ok')
    pill.classList.add('bad')
    setTip(pill, `${status.reason}\nClick to see how to turn it on.`, { at: 'bottom' })
  }
  renderAgentDialog(status)
  return status
}

/* ------------------------------------------------------------ agent panel */

/**
 * What the header pill opens.
 *
 * The pill used to be the whole story: three words and a tooltip holding a
 * `chrome://` URL, which cannot be clicked from a page and is awkward to even
 * select. Somebody arriving to find out whether this works got a dead end at
 * the exact moment they were deciding. So the pill opens something that can
 * answer either state properly — the tools when they are published, and what
 * to do about it when they are not.
 *
 * Which fix to offer depends on where the page is. Origin trials do not cover
 * localhost, so on a machine the flag is the only route; on a deployed origin
 * the token is the better one, because it works for every visitor without
 * asking any of them to change a browser setting.
 */
function renderAgentDialog(status) {
  const title = $('agentDlgTitle')
  const body = $('agentDlgBody')
  const note = $('agentDlgNote')
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

  body.replaceChildren()
  const add = (html) => {
    const d = document.createElement('div')
    d.innerHTML = html
    body.append(...d.childNodes)
  }

  if (status?.ok) {
    title.textContent = `${status.count} tools published to this page`
    add(
      `<p class="dlg-hint">An AI agent running in this browser can read and edit this project
        directly — no plugin, no API key, nothing uploaded. Via <code>${escHtml(status.via)}</code>.</p>` +
        (status.omitted
          ? `<p class="dlg-hint">${status.omitted} tool(s) that are really ffmpeg are not offered by this
             browser-only build, so an agent plans around them instead of into them.</p>`
          : ''),
    )
    add('<div class="side-label">Things to try</div>')
    const list = document.createElement('ul')
    list.className = 'agent-prompts'
    import('/demo.js')
      .then(({ DEMO_PROMPTS }) => {
        for (const q of DEMO_PROMPTS) {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = q
          b.onclick = () => copyText(q, 'ask your agent')
          li.append(b)
          list.append(li)
        }
      })
      .catch(() => {})
    body.append(list)

    add('<div class="side-label">Every tool</div>')
    const names = document.createElement('p')
    names.className = 'agent-tools'
    names.textContent = status.names.join(' · ')
    body.append(names)
    note.textContent = 'Click a prompt to copy it.'
  } else {
    title.textContent = 'No agent is attached to this page'
    add(
      `<p class="dlg-hint">Klipvia publishes itself over
        <a href="https://github.com/webmachinelearning/webmcp" target="_blank" rel="noreferrer noopener">WebMCP</a>,
        which is behind an origin trial in Chrome 149–156. Everything else works
        without it.</p>` +
        (local
          ? `<div class="side-label">On this machine</div>
             <p class="dlg-hint">Origin trials do not cover localhost, so the flag is the only way here.</p>
             <ol class="agent-steps">
               <li>Open <code>chrome://flags/#enable-webmcp-testing</code> and set it to <b>Enabled</b>.</li>
               <li>Relaunch Chrome — the switch only takes effect on a restart.</li>
               <li>Come back and reload this page.</li>
             </ol>`
          : `<div class="side-label">For everyone who visits</div>
             <p class="dlg-hint">Register <code>${escHtml(location.origin)}</code> at the
               <a href="https://developer.chrome.com/origintrials" target="_blank" rel="noreferrer noopener">Chrome origin trials console</a>
               and serve the token as an <code>Origin-Trial</code> header. Then nobody has to change a setting.</p>
             <div class="side-label">Just for you, right now</div>
             <ol class="agent-steps">
               <li>Open <code>chrome://flags/#enable-webmcp-testing</code> and set it to <b>Enabled</b>.</li>
               <li>Relaunch Chrome, then reload this page.</li>
             </ol>`),
    )
    const copy = document.createElement('button')
    copy.className = 'btn small'
    copy.textContent = 'Copy the flag URL'
    copy.onclick = () => copyText('chrome://flags/#enable-webmcp-testing', 'paste into the address bar')
    body.append(copy)
    note.textContent = status?.reason ?? ''
  }
}

/** Minimal escaping for the few interpolations above. */
const escHtml = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function initAgentDialog() {
  const dlg = $('dlgAgent')
  const pill = $('mcpState')
  const open = () => {
    renderAgentDialog(window.__webmcp)
    dlg.showModal()
  }
  pill.onclick = open
  // It is a span with a button's job, so it needs a button's keys.
  pill.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    open()
  }
  $('btnAgentClose').onclick = () => dlg.close()
  $('btnAgentRecheck').onclick = withStatus(async () => {
    const s = await registerAgentTools()
    status(s.ok ? `${s.count} tools published.` : `still off — ${s.reason}`, s.ok ? '' : 'error')
  })
}

/**
 * "Write down what is said in this."
 *
 * The entry point that matters, because it is where somebody arrives already
 * wanting the thing — which is the only moment worth asking them to set it up.
 * With nothing configured this opens the panel on transcription rather than
 * refusing, so the answer to "I want this" is the choice, not an error.
 */
async function transcribeFromUi(media) {
  if (!state.speech?.isReady('stt')) {
    status('choose where transcription should happen')
    state.speech?.open('stt')
    return
  }
  status(`writing down "${media.name}"…`)
  const t = await INTEGRATIONS.transcribeMedia(media.filename, {
    local: state.local,
    media,
    onProgress: (p) => p.label && status(p.label),
  })
  await state.lib.refresh()
  setRail('text')
  status(`"${t.name}" — ${t.cueCount ?? t.cues?.length ?? 0} lines${t.wordLevel ? ', with word timings' : ''}`)
  return t
}

/**
 * The card a first visitor sees over the stage, once.
 *
 * Somebody who followed a link has two questions and no way to answer either
 * from the UI: is an agent actually attached to this page, and what would I
 * say to it. A pill in the corner reading "webmcp off" answers neither. So the
 * card names the state, gives the one-line fix when it is off, and offers five
 * things to say that each produce a visible result.
 *
 * It appears only over a freshly seeded demo, and closing it is permanent.
 */
function initAgentHint(mcp) {
  const el = $('agentHint')
  if (!el) return
  if (!state.seededDemo || localStorage.getItem('klipvia:hintDone')) return

  import('/demo.js').then(({ DEMO_PROMPTS }) => {
    const ok = !!mcp?.ok
    el.classList.toggle('off', !ok)
    el.innerHTML = `
      <h4><span class="dot"></span>${ok ? `An agent can drive this — ${mcp.count} tools` : 'No agent is attached yet'}</h4>
      <p>${
        ok
          ? 'Everything on this timeline was made here, in this browser. Open an agent in this tab and ask it for something:'
          : 'Klipvia publishes itself over WebMCP. Chrome needs <code>chrome://flags/#enable-webmcp-testing</code> turned on, then a relaunch. Everything else works without it — and once it is on, ask an agent:'
      }</p>
      <ul></ul>
      <div class="hint-foot">
        <small>Click one to copy it.</small>
        <button class="btn small ghost" id="btnHintDone">Got it</button>
      </div>`

    // The prompts go in as text, not markup: they are the one part of this
    // card anyone is likely to edit.
    const list = el.querySelector('ul')
    for (const q of DEMO_PROMPTS) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = q
      li.append(b)
      list.append(li)
    }

    el.hidden = false
    el.classList.remove('hidden')
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.id === 'btnHintDone') {
        localStorage.setItem('klipvia:hintDone', '1')
        el.remove()
        return
      }
      copyText(b.textContent, 'ask your agent')
    })
  })
}

/* ══════════════════════════════════════════════════════════════════════════
   SEQUENCE MODE

   Clip mode above authors one animation. This is where that animation meets
   footage, sound and captions on a timeline — and where the whole piece is
   rendered out as one file.
   ══════════════════════════════════════════════════════════════════════════ */

/** Older projects predate sequences; give them an empty one rather than a crash. */
/** Which timeline this tab shows: remembered per project, else the main one. */
function resolveActiveTimeline() {
  const p = state.project
  if (!p) return null
  const remembered = localStorage.getItem(`animationhtml:active:${p.id}`)
  const want = [remembered, p.mainTimelineId].filter(Boolean)
  let i = -1
  for (const id of want) {
    i = p.sequences.findIndex((s) => s.id === id)
    if (i >= 0) break
  }
  state.seqIndex = i >= 0 ? i : 0
  return currentSequence()
}

function rememberActiveTimeline() {
  const seq = currentSequence()
  if (state.project && seq) localStorage.setItem(`animationhtml:active:${state.project.id}`, seq.id)
}

let statusTimer = null
function status(message, kind = '') {
  const el = $('statusLine')
  el.textContent = message
  el.classList.toggle('error', kind === 'error')
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    el.textContent = ''
    el.classList.remove('error')
  }, kind === 'error' ? 9000 : 4500)
}

/* ------------------------------------------------------------------- modes */

function setMode(mode) {
  if (state.mode === mode) return
  state.mode = mode
  document.body.dataset.mode = mode
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.setmode === mode))

  if (mode === 'seq') {
    // The clip stage keeps running otherwise, playing to nobody.
    state.iframe?.contentWindow?.__stage?.pause()
    state.playing = false
    $('btnPlay').textContent = '▶'
    setRail(state.rail === 'clips' && !state.railTouched ? 'timelines' : state.rail)
    // The stage was display:none while clip mode had the screen, which stops
    // the overlay documents rendering; rebuild them rather than trust them.
    state.compositor?.invalidateOverlays()
    state.stageTools?.suppress(false)
    refreshSequence()
    state.compositor?.seekTo(state.compositor.time)
    state.timeline.zoomToFit()
  } else {
    state.compositor?.pause()
    state.stageTools?.suppress(true)
    setRail('clips')
    // A clip whose stage was left mid-playback by a previous session of clip
    // mode is rebuilt, so what appears matches the playhead at 0.
    remount()
  }
  requestAnimationFrame(fitStage)
}

function setRail(name) {
  state.rail = name
  document.querySelectorAll('.rail-tab').forEach((t) => t.classList.toggle('active', t.dataset.rail === name))
  document.querySelectorAll('[data-rail-panel]').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.railPanel !== name),
  )
}

/* ------------------------------------------------------------- stage sizing */

function fitSeqStage() {
  const seq = currentSequence()
  if (!seq) return
  const area = $('stageArea')
  const scale =
    state.zoom === 'fit'
      ? Math.min(1, (area.clientWidth - 40) / seq.width, (area.clientHeight - 40) / seq.height)
      : Number(state.zoom)

  const stage = $('seqStage')
  stage.style.transform = `scale(${scale})`
  const wrap = $('seqStageWrap')
  wrap.style.width = `${seq.width * scale}px`
  wrap.style.height = `${seq.height * scale}px`
  // The handles are drawn in screen pixels over a stage drawn in frame pixels.
  state.stageTools?.render()

  $('stageDims').textContent = `${seq.width}×${seq.height} · ${Math.round(scale * 100)}%`
  document.querySelectorAll('.zoom-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.zoom === String(state.zoom)),
  )
}

/* ----------------------------------------------------------------- context */

/** Everything the timeline and the compositor need to look at, in one object. */
/** Every transcript playing on `seq`: captions first (they are what is read), else footage with a bound transcript. */
async function transcriptSourcesOf(seq) {
  const out = []
  const items = [...SEQ.allItems(seq)].map((x) => x.item)
  for (const item of items.filter((i) => i.type === 'caption')) {
    const transcript = await state.lib.loadTranscript(item.sourceId).catch(() => null)
    if (transcript) out.push({ item, transcript })
  }
  if (out.length) return out
  for (const item of items.filter((i) => i.type === 'media')) {
    const row = (state.lib.transcriptList ?? []).find((r) => r.mediaFilename === item.sourceId)
    if (!row) continue
    const transcript = await state.lib.loadTranscript(row.id).catch(() => null)
    if (transcript) out.push({ item, transcript })
  }
  return out
}

/** Frames tiled into one labelled sheet, the way capture_frame does for a clip. */
function tileSheet(frames, w, h) {
  const n = frames.length
  const cols = n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const tw = 460
  const th = Math.max(1, Math.round((tw * h) / w))
  const pad = 8
  const sheet = document.createElement('canvas')
  sheet.width = cols * tw + (cols + 1) * pad
  sheet.height = rows * th + (rows + 1) * pad
  const g = sheet.getContext('2d')
  g.fillStyle = '#0e1013'
  g.fillRect(0, 0, sheet.width, sheet.height)
  frames.forEach(({ t, canvas }, i) => {
    const cx = pad + (i % cols) * (tw + pad)
    const cy = pad + Math.floor(i / cols) * (th + pad)
    g.drawImage(canvas, cx, cy, tw, th)
    g.fillStyle = 'rgba(0,0,0,.66)'
    g.fillRect(cx, cy, 62, 19)
    g.fillStyle = '#fff'
    g.font = '12px ui-monospace, monospace'
    g.fillText(`${(t / 1000).toFixed(2)}s`, cx + 6, cy + 13)
  })
  return sheet
}

/* ---------------------------------------------------------- overlay bounds */

const boundsCache = new Map()

/** Union of the painted elements of an overlay, in timeline frame pixels; null when nothing paints. */
async function overlayBounds(item, clip, seq) {
  const key = [item.type, item.sourceId, item.inMs, item.durationMs, item.anchor, item.offsetX, item.offsetY, clip.width, clip.height, clip.html, clip.css, clip.js].join('|')
  if (boundsCache.has(key)) return boundsCache.get(key)
  const locals = [0.25, 0.5, 0.75].map((f) => SEQ.sourceTimeAt(item, item.startMs + item.durationMs * f)).sort((a, b) => a - b)
  let union = null
  try {
    await withOffscreenClip(clip, async ({ doc, stage }) => {
      for (const t of locals) {
        await stage.seek(Math.max(0, Math.min(clip.durationMs - 1, t)), { fast: true })
        const r = paintedBounds(doc, clip)
        if (r) union = union ? unionRect(union, r) : r
      }
    })
  } catch {
    union = null
  }
  let rect = null
  if (union) {
    const { x, y } = SEQ.placementPx(item.anchor, seq.width, seq.height, clip.width, clip.height, item.offsetX, item.offsetY)
    rect = { x: Math.round(union.x + x), y: Math.round(union.y + y), w: Math.round(union.w), h: Math.round(union.h) }
  }
  if (boundsCache.size > 400) boundsCache.clear()
  boundsCache.set(key, rect)
  return rect
}

function seqContext() {
  return {
    local: state.local,
    seq: currentSequence(),
    clips: state.project?.clips ?? [],
    media: state.lib?.media ?? new Map(),
    transcripts: state.lib?.transcripts ?? new Map(),
    peaks: state.lib?.peaks ?? new Map(),
    timelines: new Map((state.project?.sequences ?? []).map((t) => [t.id, t])),
    assets: new Map((state.assets?.list ?? []).map((a) => [a.filename, a])),
    loadDetailPeaks: state.lib ? (f) => state.lib.loadDetailPeaks(f) : null,
    silence: state.silence,
    showSilence: state.showSilence,
    busy: state.seqExporting,
  }
}

/** Caption items need their transcript in hand before anything can draw them. */
async function ensureTranscriptsLoaded(seq = currentSequence()) {
  if (!seq || !state.lib) return
  const ids = new Set()
  for (const { item } of SEQ.allItems(seq)) if (item.type === 'caption') ids.add(item.sourceId)
  const missing = [...ids].filter((id) => !state.lib.transcripts.has(id))
  if (!missing.length) return
  await Promise.all(missing.map((id) => state.lib.loadTranscript(id)))
  if (seq === currentSequence()) refreshSequence()
}

function refreshSequence() {
  if (state.mode !== 'seq' || !currentSequence()) return
  historyCapture()
  recomputeSilence()
  state.compositor?.rebuild()
  state.timeline?.render()
  state.stageTools?.render()
  updateSeqMeta()
  renderItemInspector()
  renderTrackInspector()
  renderTimelineRail()
}

/* ----------------------------------------------------------------- history */

/**
 * Undo, by snapshot, per timeline.
 *
 * Every edit ends in a commit for its timeline, where the document is
 * compared with the last snapshot seen and the difference recorded — no call
 * site has to remember to. Each timeline has its own stack, so an agent
 * working in a sub-timeline and a person on the main one undo their own
 * work, and opening another timeline forgets nothing.
 *
 * Lane heights and document metadata (revision, claim, timestamps) are left
 * out of the snapshot: a drag on a track header is not an edit, and a
 * revision bump from a save must not read as one.
 */
const histories = new Map()
const HISTORY_MAX = 100
const DOC_META = new Set(['rev', 'updatedAt', 'createdAt', 'claimedBy', 'projectId'])

function snapshotReplacer(key, value) {
  if (this && Array.isArray(this.tracks) && DOC_META.has(key)) return undefined
  // `this` is the holder: only a track carries both `items` and `kind`.
  if (key === 'height' && this && Array.isArray(this.items) && this.kind) return undefined
  return value
}
const historySnapshotOf = (seq) => (seq ? JSON.stringify(seq, snapshotReplacer) : '')

function historyFor(seq) {
  let h = histories.get(seq.id)
  if (!h) {
    h = { undo: [], redo: [], last: historySnapshotOf(seq), applying: false }
    histories.set(seq.id, h)
  }
  return h
}

function historyCaptureFor(seq) {
  if (!seq) return
  const h = historyFor(seq)
  const now = historySnapshotOf(seq)
  if (now === h.last) return
  if (h.applying) {
    h.last = now
    return
  }
  h.undo.push(h.last)
  if (h.undo.length > HISTORY_MAX) h.undo.shift()
  h.redo = []
  h.last = now
  updateHistoryButtons()
}

const historyCapture = () => historyCaptureFor(currentSequence())

function historyApply(seq, snapshot) {
  const heights = new Map((seq.tracks ?? []).map((t) => [t.id, t.height]))
  const next = JSON.parse(snapshot)
  for (const t of next.tracks) {
    const h = heights.get(t.id)
    if (h != null) t.height = h
  }
  for (const k of DOC_META) if (seq[k] !== undefined) next[k] = seq[k]
  const list = state.project.sequences
  const i = list.findIndex((t) => t.id === seq.id)
  if (i >= 0) list[i] = next
  const h = historyFor(next)
  h.last = snapshot
  h.applying = true
  try {
    markTimelineDirty(next)
    if (i === state.seqIndex) refreshSequence()
    else if (currentSequence()?.tracks.some((tr) => tr.items.some((it) => it.type === 'timeline' && it.sourceId === next.id))) refreshSequence()
  } finally {
    h.applying = false
  }
  updateHistoryButtons()
}

function undoSequence(seqId = null) {
  const seq = seqId ? timelineById(seqId) : currentSequence()
  if (!seq) return false
  const h = historyFor(seq)
  if (!h.undo.length) return false
  h.redo.push(h.last)
  historyApply(seq, h.undo.pop())
  return true
}

function redoSequence(seqId = null) {
  const seq = seqId ? timelineById(seqId) : currentSequence()
  if (!seq) return false
  const h = historyFor(seq)
  if (!h.redo.length) return false
  h.undo.push(h.last)
  historyApply(seq, h.redo.pop())
  return true
}

function updateHistoryButtons() {
  const seq = currentSequence()
  const h = seq ? historyFor(seq) : null
  $('btnUndo').disabled = !h?.undo.length
  $('btnRedo').disabled = !h?.redo.length
}

/** "Intro" → "Intro v2"; "Intro v2" → "Intro v3"; never a name the project already has. */
function nextVersionName(name) {
  const base = String(name).replace(/\s+v\d+$/i, '')
  const taken = new Set((state.project?.sequences ?? []).map((t) => t.name))
  let n = 2
  const m = String(name).match(/\s+v(\d+)$/i)
  if (m) n = Number(m[1]) + 1
  while (taken.has(`${base} v${n}`)) n++
  return `${base} v${n}`
}

/** A track by id, or by name — agents think in names ("Animaciones"). */
function resolveTrack(seq, ref) {
  if (!ref) return null
  const byId = seq.tracks.find((t) => t.id === ref)
  if (byId) return byId
  const want = String(ref).trim().toLowerCase()
  const byName = seq.tracks.filter((t) => t.name.trim().toLowerCase() === want)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`${byName.length} tracks are named "${ref}" — use a track id from get_timeline`)
  throw new Error(`no track "${ref}" — use an id or a name from get_timeline`)
}

/* ---------------------------------------------------------- timelines rail */

/**
 * The project as the sketch draws it: the main timeline, then the sections
 * it plays in time order (and theirs, indented), then whatever is placed
 * nowhere yet. One row per timeline per place it is used.
 */
function renderTimelineRail() {
  const list = $('timelineList')
  if (!list || !state.project) return
  const timelines = seqContext().timelines
  const open = currentSequence()
  const mainId = state.project.mainTimelineId
  list.replaceChildren()
  const seen = new Set()

  const row = (t, { depth = 0, block = null, parent = null, ancestors = [] } = {}) => {
    const el = document.createElement('div')
    el.className = 'tl-row' + (t.id === open?.id ? ' active' : '') + (t.id === mainId ? ' main' : '')
    el.style.paddingLeft = `${6 + depth * 14}px`
    el.draggable = true
    el.dataset.id = t.id
    const dur = SEQ.sequenceDuration(t) / 1000
    const claim = t.claimedBy?.agent ? ` · claimed by ${t.claimedBy.agent}` : ''
    setTip(el, `${t.name}\n${t.width}×${t.height} · ${dur.toFixed(1)}s · ${t.fps}fps${claim}${t.note ? '\n' + t.note : ''}\nDrag onto a track to place it as a section.`, { at: 'right' })

    const name = document.createElement('span')
    name.className = 'tl-name'
    name.textContent = (t.id === mainId ? '★ ' : depth ? '⧉ ' : '') + t.name
    el.appendChild(name)

    const meta = document.createElement('span')
    meta.className = 'tl-meta'
    meta.textContent = `${dur.toFixed(1)}s`
    if (t.claimedBy?.agent) {
      const flag = document.createElement('span')
      flag.className = 'claim'
      flag.textContent = ' ⚑'
      meta.appendChild(flag)
    }
    el.appendChild(meta)

    const actions = document.createElement('span')
    actions.className = 'tl-actions'
    const mk = (label, tip, fn, disabled = false) => {
      const b = document.createElement('button')
      b.textContent = label
      b.disabled = disabled
      setTip(b, tip)
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        Promise.resolve(fn(e)).catch((err) => status(err.message, 'error'))
      })
      actions.appendChild(b)
    }
    if (block && parent) {
      const siblings = parent.tracks.find((tr) => tr.items.includes(block))?.items.filter((i) => i.type === 'timeline') ?? []
      const at = siblings.indexOf(block)
      mk('▲', 'Play this section earlier: swap it with the one before.', () => swapBlocks(parent, siblings[at - 1], block), at <= 0)
      mk('▼', 'Play this section later: swap it with the one after.', () => swapBlocks(parent, block, siblings[at + 1]), at >= siblings.length - 1)
    }
    mk('✎', 'Rename.', () => renameInline(name, t))
    mk('⧉', 'Duplicate as a new version and open it. Sections stay shared; ⌥-click copies them too.', (e) =>
      editor.duplicateSequence({ timelineId: t.id, deep: !!e?.altKey }).then((r) => status(`"${r.copy.name}" is a copy of "${r.source.name}"${r.copied > 1 ? ` with ${r.copied - 1} section(s) copied` : ''}`)),
    )
    if (t.id !== mainId) mk('★', 'Make this the main timeline — the one the project delivers.', () => {
      state.project.mainTimelineId = t.id
      dirty.project = true
      scheduleSave()
      renderTimelineRail()
      renderCrumb()
    })
    el.appendChild(actions)

    el.addEventListener('click', () => {
      if (name.querySelector('input')) return
      crumbs.length = 0
      crumbs.push(...ancestors)
      editor.selectSequence(t.id, { keepCrumbs: true }).catch((err) => status(err.message, 'error'))
    })
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-ah-source', JSON.stringify({ kind: 'timeline', id: t.id }))
      e.dataTransfer.effectAllowed = 'copy'
    })
    list.appendChild(el)
  }

  const walk = (t, depth, ancestors) => {
    if (depth >= SEQ.MAX_NESTING) return
    const blocks = [...SEQ.allItems(t)].map((x) => x.item).filter((i) => i.type === 'timeline').sort((a, b) => a.startMs - b.startMs)
    for (const block of blocks) {
      const child = timelines.get(block.sourceId)
      if (!child) {
        const el = document.createElement('div')
        el.className = 'tl-row missing'
        el.style.paddingLeft = `${6 + (depth + 1) * 14}px`
        el.textContent = `⧉ ${block.name} — missing`
        list.appendChild(el)
        continue
      }
      seen.add(child.id)
      row(child, { depth: depth + 1, block, parent: t, ancestors: [...ancestors, t.id] })
      if (!ancestors.includes(child.id) && child.id !== t.id) walk(child, depth + 1, [...ancestors, t.id])
    }
  }

  const main = timelines.get(mainId)
  if (main) {
    seen.add(main.id)
    row(main, { depth: 0 })
    walk(main, 0, [])
  }
  const rest = (state.project.sequences ?? []).filter((t) => !seen.has(t.id))
  if (rest.length) {
    const h = document.createElement('div')
    h.className = 'tl-head'
    h.textContent = 'Unplaced'
    list.appendChild(h)
    for (const t of rest) row(t, { depth: 0 })
  }
}

/** Two blocks on the same track trade places, the gap between them kept. */
function swapBlocks(parent, first, second) {
  if (!first || !second) return
  const gap = second.startMs - SEQ.itemEnd(first)
  const start = first.startMs
  second.startMs = start
  first.startMs = start + second.durationMs + gap
  const track = parent.tracks.find((tr) => tr.items.includes(first))
  if (track) track.items.sort((a, b) => a.startMs - b.startMs)
  commit(parent)
}

function renameInline(nameEl, t) {
  const input = document.createElement('input')
  input.value = t.name
  nameEl.replaceChildren(input)
  input.focus()
  input.select()
  let finished = false
  const done = (keep) => {
    if (finished) return
    finished = true
    const v = input.value.trim()
    if (keep && v && v !== t.name) {
      t.name = v
      // Blocks carry the name they were made with; they follow the rename.
      for (const other of state.project.sequences ?? []) {
        let touched = false
        for (const { item } of SEQ.allItems(other)) {
          if (item.type === 'timeline' && item.sourceId === t.id) {
            item.name = v
            touched = true
          }
        }
        if (touched) commit(other)
      }
      commit(t)
      if (t === currentSequence()) updateSeqMeta()
      renderCrumb()
    }
    renderTimelineRail()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true)
    if (e.key === 'Escape') done(false)
    e.stopPropagation()
  })
  input.addEventListener('blur', () => done(true))
  input.addEventListener('click', (e) => e.stopPropagation())
}

/** An empty section at the playhead, five seconds long, opened for editing. */
async function newSubTimeline() {
  const seq = currentSequence()
  if (!seq) throw new Error('no timeline is open')
  const n = (state.project.sequences ?? []).length
  const child = await editor.createSequence({
    name: `Section ${n}`,
    width: seq.width,
    height: seq.height,
    fps: seq.fps,
    background: { mode: 'transparent', color: '#000000' },
    open: false,
  })
  const at = state.compositor?.time ?? 0
  await insertSource({ kind: 'timeline', id: child.id }, { atMs: at, durationMs: 5000 })
  await openNested(child.id)
  status(`"${child.name}" placed at ${(at / 1000).toFixed(2)}s and opened — ⌘↑ goes back`)
}

/* ------------------------------------------------------------- breadcrumb */

/**
 * Where this tab is: Main › Intro › Logo. A stack per tab, pushed when a
 * block is opened from inside its parent and popped by ⌘↑ or a crumb — so
 * "up" means where you came from, which is what a person expects, even
 * though a timeline can be nested in more than one place.
 */
const crumbs = []

async function openNested(id, { from = currentSequence() } = {}) {
  if (!timelineById(id)) throw new Error(`no timeline "${id}"`)
  if (from && from.id !== id) crumbs.push(from.id)
  await editor.selectSequence(id)
}

async function goUp() {
  const parent = crumbs.pop()
  if (!parent || !timelineById(parent)) {
    crumbs.length = 0
    if (state.project?.mainTimelineId && currentSequence()?.id !== state.project.mainTimelineId) await editor.selectSequence(state.project.mainTimelineId)
    return
  }
  await editor.selectSequence(parent, { keepCrumbs: true })
}

function renderCrumb() {
  const el = $('seqCrumb')
  if (!el) return
  const seq = currentSequence()
  el.replaceChildren()
  if (!seq) return
  // Drop crumbs that no longer lead anywhere.
  for (let i = crumbs.length - 1; i >= 0; i--) if (!timelineById(crumbs[i]) || crumbs[i] === seq.id) crumbs.splice(i, 1)
  const chain = [...crumbs, seq.id]
  if (chain.length === 1 && seq.id !== state.project?.mainTimelineId) {
    const parents = SEQ.parentsOf(seqContext().timelines, seq.id)
    if (parents.length) {
      const hint = document.createElement('span')
      hint.className = 'sep'
      hint.textContent = `in ${parents.map((p) => p.name).join(', ')} ›`
      hint.title = 'Where this timeline is placed'
      el.appendChild(hint)
    }
  }
  chain.forEach((id, i) => {
    const t = timelineById(id)
    const b = document.createElement('button')
    b.className = 'crumb' + (i === chain.length - 1 ? ' current' : '')
    b.textContent = (id === state.project?.mainTimelineId ? '★ ' : '') + (t?.name ?? id)
    if (i < chain.length - 1) {
      b.addEventListener('click', async () => {
        crumbs.splice(i)
        await editor.selectSequence(id, { keepCrumbs: true })
      })
      el.appendChild(b)
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = '›'
      el.appendChild(sep)
    } else el.appendChild(b)
  })
}

/* ----------------------------------------------------------------- silence */

/** Recompute silence for every audio-bearing file on the timeline. */
function recomputeSilence() {
  const seq = currentSequence()
  if (!seq || !state.lib) return
  const files = new Set()
  for (const { item } of SEQ.allItems(seq)) {
    if (item.type !== 'media') continue
    const m = state.lib.media.get(item.sourceId)
    if (m?.hasAudio && m.hasPeaks) files.add(m.filename)
  }
  for (const f of files) {
    const peaks = state.lib.peaks.get(f)
    if (!peaks) {
      // Not here yet: fetch, then draw the bands when it lands.
      state.lib.loadPeaks(f).then((data) => {
        if (!data) return
        recomputeSilence()
        state.timeline?.render()
        updateSilenceSummary()
      })
      continue
    }
    state.silence.set(f, SEQ.detectSilence(peaks, state.silenceParams))
  }
}

/** The gaps inside one item, as timeline-time ranges. */
function itemSilence(item) {
  if (item?.type !== 'media') return []
  return SEQ.silenceInItem(item, state.silence.get(item.sourceId) ?? [])
}

function updateSilenceSummary() {
  const item = state.selectedItem
  const el = $('silSummary')
  if (!item) return
  const media = state.lib.media.get(item.sourceId)
  if (!media?.hasAudio) return
  if (!media.hasPeaks) {
    el.textContent = 'No waveform for this file.'
    return
  }
  const gaps = itemSilence(item)
  const total = gaps.reduce((n, r) => n + r.endMs - r.startMs, 0)
  el.textContent = gaps.length
    ? `${gaps.length} gap${gaps.length === 1 ? '' : 's'} · ${(total / 1000).toFixed(1)}s of ${(item.durationMs / 1000).toFixed(1)}s`
    : 'No gaps at this threshold.'
  $('btnCutGaps').disabled = !gaps.length
  $('btnRemoveGaps').disabled = !gaps.length
}

function initSilenceTools() {
  try {
    const saved = JSON.parse(localStorage.getItem('animationhtml:silence') || 'null')
    if (saved) Object.assign(state.silenceParams, saved)
    state.showSilence = localStorage.getItem('animationhtml:showSilence') !== 'off'
  } catch {
    /* defaults */
  }
  $('btnGaps').classList.toggle('on', state.showSilence)

  const paint = () => {
    $('silDb').value = String(state.silenceParams.thresholdDb)
    $('silDbVal').textContent = `${state.silenceParams.thresholdDb} dB`.replace('-', '−')
    $('silMin').value = (state.silenceParams.minMs / 1000).toFixed(1)
    $('silKeep').value = String(state.silenceParams.keepMs)
  }
  paint()

  // Tuning redraws the bands live; nothing about the timeline changes, so the
  // heavy refresh (and the undo capture) is skipped.
  const retune = () => {
    localStorage.setItem('animationhtml:silence', JSON.stringify(state.silenceParams))
    recomputeSilence()
    state.timeline?.render()
    updateSilenceSummary()
  }
  $('silDb').addEventListener('input', () => {
    state.silenceParams.thresholdDb = Number($('silDb').value)
    paint()
    retune()
  })
  $('silMin').addEventListener('change', () => {
    state.silenceParams.minMs = Math.max(100, Math.round(parseFloat($('silMin').value) * 1000) || 500)
    paint()
    retune()
  })
  $('silKeep').addEventListener('change', () => {
    state.silenceParams.keepMs = Math.max(0, Math.round(Number($('silKeep').value)) || 0)
    paint()
    retune()
  })

  $('btnGaps').onclick = () => {
    state.showSilence = !state.showSilence
    localStorage.setItem('animationhtml:showSilence', state.showSilence ? 'on' : 'off')
    $('btnGaps').classList.toggle('on', state.showSilence)
    state.timeline?.render()
  }

  $('btnCutGaps').onclick = () => {
    const item = state.selectedItem
    if (!item) return
    const times = itemSilence(item).flatMap((r) => [r.startMs, r.endMs])
    const n = SEQ.splitAtTimes(currentSequence(), times)
    markTimelineDirty(currentSequence())
    refreshSequence()
    status(`${n} cut${n === 1 ? '' : 's'} made — nothing removed`)
  }
  $('btnRemoveGaps').onclick = () => {
    const item = state.selectedItem
    if (!item) return
    const r = removeGapsFromItem(item)
    status(`removed ${r.gaps} gap${r.gaps === 1 ? '' : 's'} · ${(r.removedMs / 1000).toFixed(1)}s shorter · ⌘Z undoes`)
  }
}

/** Remove one item's silences from the whole timeline. Shared with the agent tools. */
function removeGapsFromItem(item) {
  const gaps = itemSilence(item)
  const stats = SEQ.removeTimeRanges(currentSequence(), gaps)
  markTimelineDirty(currentSequence())
  refreshSequence()
  return { gaps: gaps.length, ...stats }
}

/** The transport clock alone — this runs every frame, so it touches nothing else. */
let seqClockText = ''
function updateSeqClock(ms = state.compositor?.time ?? 0) {
  const seq = currentSequence()
  if (!seq) return
  const text = `${clock(ms)} / ${clock(SEQ.sequenceDuration(seq))}`
  if (text === seqClockText) return
  seqClockText = text
  $('seqTimeLabel').textContent = text
}

/**
 * Playback health. While the preview plays, every few seconds the compositor's
 * numbers are checked; a preview that cannot keep up says so in the status
 * line once, with the remedy, instead of leaving the user to guess.
 */
let healthWarnedAt = 0
let healthLastCheck = 0
function previewHealthTick() {
  const now = performance.now()
  if (now - healthLastCheck < 3000) return
  healthLastCheck = now
  const p = state.compositor?.getStats?.()
  if (!p || p.seconds < 4) return
  const struggling = p.fps < 28 || p.seeks >= 3 || p.worstGapMs > 400
  if (!struggling || now - healthWarnedAt < 30000) return
  healthWarnedAt = now
  status(
    `preview is struggling — ${p.fps} fps, ${p.seeks} audio seek(s), ${p.mounted} overlays live. ` +
      'Hide the tracks you are not working on (◌ in the track header) or collapse the code panel; the render is unaffected.',
    'error',
  )
}
function previewHealthSummary() {
  const p = state.compositor?.getStats?.()
  if (!p || p.seconds < 2) return
  status(`preview · ${p.fps} fps over ${p.seconds}s · ${p.seeks} audio seek(s) · ${p.nudges} rate nudge(s) · ${p.mounted}/${p.overlays} overlays live`)
}

function updateSeqMeta() {
  const seq = currentSequence()
  if (!seq) return
  const dur = SEQ.sequenceDuration(seq)

  $('seqLength').textContent = (dur / 1000).toFixed(1)
  updateSeqClock()

  const counts = describeRender(seq, seqContext())
  const bits = []
  if (counts.video) bits.push(`${counts.video} video`)
  if (counts.overlay) bits.push(`${counts.overlay} overlay${counts.overlay === 1 ? '' : 's'}`)
  if (counts.audio) bits.push(`${counts.audio} audio`)
  if (counts.captionCues) bits.push(`${counts.captionCues} cues`)
  if (counts.missing) bits.push(`${counts.missing} missing source${counts.missing === 1 ? '' : 's'}`)
  $('seqPlanNote').textContent = bits.length
    ? `${bits.join(' · ')} · ${(dur / 1000).toFixed(1)}s at ${seq.fps}fps`
    : 'Nothing on the timeline yet.'
}

/** m:ss.cc — a video length, not a stopwatch reading. */
function clock(ms) {
  const t = Math.max(0, ms)
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const c = Math.floor((t % 1000) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/* --------------------------------------------------------------- inserting */

/**
 * Where a newly dropped source should land when the user did not aim.
 *
 * Footage looks for room from the bottom video track up; graphics look from
 * the top down; sound takes the first audio track with room, or a new one.
 * Either way it must be *room* — dropping a second title onto a track already
 * holding one would overwrite it, and a user who did not choose a track did
 * not choose to lose anything.
 */
function pickTrack(seq, payload, from, to) {
  const video = SEQ.videoTracks(seq)
  const isAudioOnly = payload.kind === 'media' && state.lib.media.get(payload.id)?.kind === 'audio'
  if (isAudioOnly) return SEQ.freeAudioTrack(seq, from, to)

  // Footage and sections from the bottom up; overlays from the top down.
  const order = payload.kind === 'media' || payload.kind === 'timeline' ? [...video].reverse() : video
  const free = order.find((t) => SEQ.trackIsFree(t, from, to))
  if (free) return free

  // A project that named its overlay track "Animaciones" gets "Animaciones 2",
  // not "V4": the names are how a person — and an agent — tells them apart.
  const top = video[0]
  const m = top && !/^V\d+$/i.test(top.name) ? top.name.match(/^(.*?)(?:\s+(\d+))?$/) : null
  const made = SEQ.makeTrack('video', m ? `${m[1]} ${(Number(m[2]) || 1) + 1}` : `V${video.length + 1}`)
  seq.tracks.unshift(made)
  return made
}

async function insertSource(payload, { trackId = null, atMs = null, durationMs = null, inMs = null } = {}) {
  const seq = scopedSequence()
  if (!seq) throw new Error('no timeline is open')
  editor.guardClaim(seq)
  const open = seq === currentSequence()
  const at = Math.max(0, Math.round(atMs ?? (open ? state.compositor?.time : 0) ?? 0))
  let item = null

  if (payload.kind === 'media') {
    const m = state.lib.media.get(payload.id)
    if (!m) throw new Error(`no media "${payload.id}" in the library`)
    item = SEQ.makeMediaItem(m, { startMs: at, durationMs, inMs: inMs ?? 0 })
    if (m.hasPeaks) await state.lib.loadPeaks(m.filename)
  } else if (payload.kind === 'clip') {
    const clip = state.project.clips.find((c) => c.id === payload.id)
    if (!clip) throw new Error(`no clip "${payload.id}"`)
    item = SEQ.makeAnimationItem(clip, { startMs: at, durationMs })
    if (inMs) item.inMs = Math.max(0, Math.round(inMs))
  } else if (payload.kind === 'transcript') {
    const t = await state.lib.loadTranscript(payload.id)
    if (!t) throw new Error(`no transcript "${payload.id}"`)
    item = SEQ.makeCaptionItem(t, { startMs: at, durationMs, inMs: inMs ?? 0 })

    // If its media is already on the timeline, land the captions exactly on it.
    // Cue times are source times, so matching the item's in-point is all it
    // takes for the words to line up with the mouth.
    if (t.mediaFilename && durationMs == null && inMs == null) {
      const onTimeline = [...SEQ.allItems(seq)].find(
        (x) => x.item.type === 'media' && x.item.sourceId === t.mediaFilename,
      )
      if (onTimeline) {
        item.startMs = onTimeline.item.startMs
        item.inMs = onTimeline.item.inMs
        item.durationMs = onTimeline.item.durationMs
        status(`captions aligned to ${onTimeline.item.name}`)
      }
    }
  } else if (payload.kind === 'timeline') {
    const child = timelineById(payload.id)
    if (!child) throw new Error(`no timeline "${payload.id}". Use list_timelines.`)
    const all = seqContext().timelines
    if (SEQ.wouldCycle(all, seq.id, child.id)) throw new Error(`"${child.name}" contains this timeline (or is it) — that would loop`)
    if (SEQ.nestingDepth(all, child.id) + 1 >= SEQ.MAX_NESTING) throw new Error(`nesting deeper than ${SEQ.MAX_NESTING} levels`)
    item = SEQ.makeTimelineItem(child, { startMs: at, durationMs, inMs: inMs ?? 0 })
  } else if (payload.kind === 'text') {
    const preset = textPreset(payload.id)
    if (!preset) throw new Error(`unknown text preset "${payload.id}". Use list_text_presets.`)
    item = SEQ.makeTextItem(preset.id, {
      text: payload.text ?? '',
      subtext: payload.subtext ?? '',
      startMs: at,
      durationMs,
    })
    if (payload.textStyle && typeof payload.textStyle === 'object') item.textStyle = { ...payload.textStyle }
    if (payload.anchor) item.anchor = payload.anchor
    if (payload.offsetX != null) item.offsetX = Math.round(Number(payload.offsetX) || 0)
    if (payload.offsetY != null) item.offsetY = Math.round(Number(payload.offsetY) || 0)
    if (payload.opacity != null) item.opacity = Math.max(0, Math.min(1, Number(payload.opacity)))
    if (payload.name) item.name = String(payload.name)
  } else if (payload.kind === 'image' || payload.kind === 'asset') {
    const asset = (state.assets?.list ?? []).find((a) => a.filename === payload.id || a.name === payload.id)
    if (!asset) throw new Error(`no asset "${payload.id}". Use list_assets.`)
    if (asset.kind !== 'image') throw new Error(`"${asset.name}" is a ${asset.kind}, not an image`)
    item = SEQ.makeImageItem(asset, { startMs: at, durationMs })
    if (payload.imageStyle && typeof payload.imageStyle === 'object') item.imageStyle = { ...payload.imageStyle }
    if (payload.fit) item.fit = payload.fit
    if (payload.anchor) item.anchor = payload.anchor
    if (payload.offsetX != null) item.offsetX = Math.round(Number(payload.offsetX) || 0)
    if (payload.offsetY != null) item.offsetY = Math.round(Number(payload.offsetY) || 0)
    if (payload.opacity != null) item.opacity = Math.max(0, Math.min(1, Number(payload.opacity)))
    if (payload.name) item.name = String(payload.name)
  } else {
    throw new Error(`unknown source kind "${payload.kind}"`)
  }

  const track =
    (trackId && resolveTrack(seq, trackId)) ||
    pickTrack(seq, payload, item.startMs, item.startMs + item.durationMs)
  if (!track) throw new Error('this timeline has no tracks')

  // Overlays cannot live on an audio track. Footage and sections can: there
  // they are their sound only.
  if (track.kind === 'audio' && payload.kind !== 'media' && payload.kind !== 'timeline') {
    throw new Error('animation and caption layers belong on a video track')
  }
  if (track.locked) throw new Error(`track ${track.name} is locked`)

  const wasEmpty = SEQ.sequenceDuration(seq) === 0
  SEQ.placeItem(track, item)
  if (!open) {
    commit(seq)
    return { item, track }
  }
  if (state.mode !== 'seq') setMode('seq')
  markTimelineDirty(currentSequence())
  refreshSequence()
  if (wasEmpty) state.timeline.zoomToFit()
  state.timeline.select(item.id)
  selectItem(item)
  return { item, track }
}

/** The UI's way in: failures become a status line, not an unhandled rejection. */
const insertFromUi = (payload, opts) =>
  insertSource(payload, opts).catch((err) => status(err?.message ?? String(err), 'error'))

/* ------------------------------------------------------------- item panel */

function selectItem(item) {
  selectItems(item ? [item] : [])
}

/** The timeline hands over every selected item; the last is the primary. */
function selectItems(items) {
  state.selectedItems = items
  state.selectedItem = items.at(-1) ?? null
  if (items.length) state.selectedTrack = null
  // Cropping is aimed at one particular layer; picking another ends it.
  if (state.cropMode && state.selectedItem?.type !== 'media' && state.selectedItem?.type !== 'timeline') setCropMode(false)
  state.stageTools?.render()
  renderItemInspector()
  renderTrackInspector()
  renderSelectionPanel()
}

const multiSelected = () => (state.selectedItems?.length ?? 0) > 1

/**
 * Double-clicking something on the stage should land on the thing you would
 * have gone to the panel for: the words of a title, the size of a shape, the
 * code of an animation, the inside of a nested block.
 */
function focusItemFields(item) {
  if (!item) return
  if (item.type === 'animation') return void $('btnEditClip').click()
  if (item.type === 'timeline') return void openNested(item.sourceId).catch((err) => status(err.message, 'error'))
  const field = {
    text: textPreset(item.sourceId)?.kind === 'shape' ? 'shapeW' : 'textText',
    image: 'imgW',
    caption: 'capSize',
  }[item.type]
  const el = field && $(field)
  if (!el || el.closest('.hidden')) return
  el.focus()
  el.select?.()
}

function renderSelectionPanel() {
  const many = multiSelected()
  $('multiInspector').classList.toggle('hidden', !many)
  if (!many) return
  const items = state.selectedItems
  $('multiCount').textContent = `${items.length} items · ${items.map((i) => i.name).join(', ').slice(0, 120)}`
  const detachable = items.some((i) => {
    if (i.type !== 'media') return false
    const m = state.lib.media.get(i.sourceId)
    const track = currentSequence()?.tracks.find((t) => t.items.includes(i))
    return m?.hasVideo && m?.hasAudio && track?.kind === 'video'
  })
  $('btnMultiDetach').classList.toggle('hidden', !detachable)
  $('btnMultiCaptions').classList.toggle('hidden', !items.some((i) => i.type === 'caption'))
}

/* ====================================================== arranging layers */
/*
 * Lining things up, stacking them, and copying them. All of it writes the same
 * two offsets a drag on the stage writes, so the panel, the handles and an
 * agent are three ways to say one thing.
 */

/** Put an item's box at `x, y` on the frame, through its anchor and offsets. */
function placeBoxAt(item, x, y, box) {
  const seq = currentSequence()
  const a = SEQ.anchorPx(item.anchor ?? 'center', seq.width, seq.height, box.w, box.h)
  item.offsetX = Math.round(x - a.x)
  item.offsetY = Math.round(y - a.y)
}

/** The live boxes of everything selected, skipping what has no picture. */
function selectionBoxes() {
  const ctx = seqContext()
  const out = []
  for (const item of state.selectedItems ?? []) {
    const box = SEQ.layerBox(item, ctx)
    if (box) out.push({ item, box })
  }
  return out
}

/**
 * Align to the frame when one thing is selected, and to each other when
 * several are — which is what every other editor does, and what you mean.
 */
function alignSelection(kind) {
  const seq = currentSequence()
  const picked = selectionBoxes()
  if (!picked.length) return status('nothing on the stage is selected', 'error')

  const free = picked.filter(({ item }) => item.type !== 'media' || item.fit === 'none' || freePlaceItem(item))
  if (!free.length) return status('nothing selected can be moved', 'error')

  if (kind === 'dx' || kind === 'dy') return distributeSelection(kind, free)

  const many = free.length > 1
  const xs = free.map((p) => p.box.x)
  const rs = free.map((p) => p.box.x + p.box.w)
  const ys = free.map((p) => p.box.y)
  const bs = free.map((p) => p.box.y + p.box.h)
  const bounds = many
    ? { x0: Math.min(...xs), x1: Math.max(...rs), y0: Math.min(...ys), y1: Math.max(...bs) }
    : { x0: 0, x1: seq.width, y0: 0, y1: seq.height }

  for (const { item, box } of free) {
    let { x, y } = box
    if (kind === 'left') x = bounds.x0
    else if (kind === 'right') x = bounds.x1 - box.w
    else if (kind === 'cx') x = (bounds.x0 + bounds.x1 - box.w) / 2
    else if (kind === 'top') y = bounds.y0
    else if (kind === 'bottom') y = bounds.y1 - box.h
    else if (kind === 'cy') y = (bounds.y0 + bounds.y1 - box.h) / 2
    placeBoxAt(item, x, y, box)
  }
  markTimelineDirty(seq)
  refreshSequence()
  status(many ? `aligned ${free.length} layers to each other` : 'aligned to the frame')
}

/** Even gaps between three or more, with the outermost two left where they are. */
function distributeSelection(kind, picked) {
  if (picked.length < 3) return status('select three or more layers to spread them out', 'error')
  const horiz = kind === 'dx'
  const sorted = picked.slice().sort((a, b) => (horiz ? a.box.x - b.box.x : a.box.y - b.box.y))
  const first = sorted[0].box
  const last = sorted[sorted.length - 1].box
  const span = horiz ? last.x + last.w - first.x : last.y + last.h - first.y
  const used = sorted.reduce((n, p) => n + (horiz ? p.box.w : p.box.h), 0)
  const gap = (span - used) / (sorted.length - 1)
  let at = horiz ? first.x : first.y
  for (const { item, box } of sorted) {
    placeBoxAt(item, horiz ? at : box.x, horiz ? box.y : at, box)
    at += (horiz ? box.w : box.h) + gap
  }
  markTimelineDirty(currentSequence())
  refreshSequence()
  status(`spread ${sorted.length} layers evenly`)
}

/**
 * Give footage or a nested block a place of its own, at the size it already
 * had. The stage handles do this on the first drag; the panel needs it too.
 */
function freePlaceItem(item) {
  if (item.type !== 'media' && item.type !== 'timeline') return false
  if (item.fit === 'none') return true
  const seq = currentSequence()
  const before = SEQ.layerBox(item, seqContext())
  if (!before) return false
  item.fit = 'none'
  item.scale = FX.clamp(before.sx || 1, SEQ.SCALE_MIN, SEQ.SCALE_MAX)
  item.anchor = 'center'
  placeBoxAt(item, before.x, before.y, before)
  return true
}

/**
 * Stacking order is which *track* an item is on, so moving a layer forward
 * moves it up a track — making one above if it is already at the top, because
 * "bring to front" should always do something.
 */
function restackItem(where) {
  const seq = currentSequence()
  const item = state.selectedItem
  if (!seq || !item) return
  const found = SEQ.findItem(seq, item.id)
  if (!found || found.track.kind !== 'video') return status('only a picture layer has a stacking order', 'error')

  const vids = SEQ.videoTracks(seq)
  const at = vids.indexOf(found.track)
  // Video tracks are listed top-first, so "forward" is a lower index.
  let target =
    where === 'front' ? 0 :
    where === 'back' ? vids.length - 1 :
    where === 'up' ? at - 1 : at + 1

  if (target < 0 || target >= vids.length) {
    if (where === 'up' || where === 'front') {
      const made = SEQ.makeTrack('video', `V${vids.length + 1}`)
      seq.tracks.splice(0, 0, made)
      target = 0
    } else {
      return status(`"${item.name}" is already at the back`, 'error')
    }
  }
  const dest = SEQ.videoTracks(seq)[target]
  if (!dest || dest === found.track) return
  if (dest.locked) return status(`${dest.name} is locked`, 'error')
  SEQ.moveItem(seq, item.id, { startMs: item.startMs, trackId: dest.id })
  markTimelineDirty(seq)
  refreshSequence()
  state.timeline.select(item.id)
  selectItem(SEQ.findItem(seq, item.id)?.item ?? null)
  status(`"${item.name}" → ${dest.name}`)
}

/**
 * Turn the cut between this item and the next into a cross dissolve.
 *
 * One track holds one item at a time — the rule that makes every other edit
 * predictable — so two items on the same track cannot overlap, and without an
 * overlap a "dissolve" is really a dip to whatever is underneath. So the next
 * item is lifted to the track above and pulled back over this one, and both get
 * the matching half of the fade. Nothing new is invented: the result is two
 * ordinary items with ordinary dissolves, which trim, move and delete as such.
 */
async function crossDissolve(ms = 600) {
  const seq = currentSequence()
  const item = state.selectedItem
  if (!seq || !item) return status('select an item first', 'error')
  const found = SEQ.findItem(seq, item.id)
  if (!found || found.track.kind !== 'video') return status('a cross dissolve is between two picture layers', 'error')

  const after = found.track.items
    .filter((i) => i.startMs >= item.startMs + item.durationMs)
    .sort((a, b) => a.startMs - b.startMs)[0]
  if (!after) return status(`nothing follows "${item.name}" on ${found.track.name}`, 'error')

  const overlap = Math.min(ms, Math.floor(item.durationMs / 2), Math.floor(after.durationMs / 2))
  if (overlap < 80) return status('those two items are too short to dissolve between', 'error')

  const vids = SEQ.videoTracks(seq)
  const at = vids.indexOf(found.track)
  let above = vids[at - 1]
  if (!above || above.locked || !SEQ.trackIsFree?.(above, after.startMs - overlap, after.startMs + after.durationMs)) {
    above = SEQ.makeTrack('video', `V${seq.tracks.length + 1}`)
    seq.tracks.splice(seq.tracks.indexOf(found.track), 0, above)
  }

  const gap = item.startMs + item.durationMs - after.startMs
  SEQ.moveItem(seq, after.id, { startMs: after.startMs - overlap + gap, trackId: above.id })
  item.dissolveOutMs = overlap
  const live = SEQ.findItem(seq, after.id)?.item
  if (live) live.dissolveInMs = overlap

  markTimelineDirty(seq)
  refreshSequence()
  status(`"${item.name}" dissolves into "${after.name}" over ${(overlap / 1000).toFixed(2)}s`)
}

/**
 * Hold one frame: save it to Assets and drop it in as a still.
 *
 * A freeze is not a property of a shot — it is a picture of it. Making it an
 * image item means it trims, moves, scales, turns and renders like any other
 * still, instead of being a fourth kind of thing the compositor has to know.
 */
async function freezeFrame({ source = 'composite' } = {}) {
  const seq = currentSequence()
  if (!seq) return
  const at = Math.round(state.compositor?.time ?? 0)
  try {
    const saved = await editor.saveFrame({ source })
    const r = await insertSource(
      { kind: 'image', id: saved.filename ?? saved.name },
      { atMs: at, durationMs: 2000 },
    )
    if (r?.item) r.item.name = `Freeze ${fmtClock(at)}`
    markTimelineDirty(seq)
    refreshSequence()
    status(`froze the frame at ${fmtClock(at)}`)
    return { item: r?.item, asset: saved, atMs: at }
  } catch (err) {
    status(err?.message ?? String(err), 'error')
    throw err
  }
}

/* ---------------------------------------------------------------- markers */
/*
 * A marker is a moment you have decided matters — a beat to cut on, a mistake
 * to come back to, the top of a section. It belongs to the timeline, not to an
 * item, because the moment usually *is* the join between two items and a note
 * pinned to either would go when that one was trimmed.
 */

const MARKER_COLOURS = ['#ffd166', '#7ee0b8', '#ff8fab', '#5b9cff', '#c39bff']

function addMarker(atMs = null, label = '') {
  const seq = currentSequence()
  if (!seq) return null
  const ms = Math.max(0, Math.round(atMs ?? state.compositor?.time ?? 0))
  seq.markers = seq.markers ?? []
  // One marker per moment: dropping a second on the same frame renames the
  // first rather than stacking two flags nobody can tell apart.
  const near = seq.markers.find((m) => Math.abs(m.ms - ms) < 1000 / (seq.fps || 30))
  if (near) {
    if (label) near.label = label
    markTimelineDirty(seq)
    refreshSequence()
    return near
  }
  const marker = {
    id: `m_${Math.random().toString(36).slice(2, 10)}`,
    ms,
    label: String(label ?? ''),
    color: MARKER_COLOURS[seq.markers.length % MARKER_COLOURS.length],
  }
  seq.markers.push(marker)
  seq.markers.sort((a, b) => a.ms - b.ms)
  markTimelineDirty(seq)
  refreshSequence()
  status(`marker at ${fmtClock(ms)}${label ? ` — ${label}` : ''}`)
  return marker
}

/** Type the label onto the flag itself, the way a track header is renamed. */
function renameMarker(m) {
  const seq = currentSequence()
  const flag = document.querySelector(`.tl2-marker[data-marker-id="${m.id}"]`)
  if (!flag) return
  const input = document.createElement('input')
  input.className = 'mk-rename'
  input.value = m.label ?? ''
  input.placeholder = 'what happens here'
  flag.replaceChildren(input)
  input.focus()
  input.select()
  let done = false
  const finish = (keep) => {
    if (done) return
    done = true
    if (keep) {
      m.label = input.value.trim()
      markTimelineDirty(seq)
    }
    refreshSequence()
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
}

function removeMarker(id) {
  const seq = currentSequence()
  if (!seq?.markers) return false
  const n = seq.markers.length
  seq.markers = seq.markers.filter((m) => m.id !== id)
  if (seq.markers.length === n) return false
  markTimelineDirty(seq)
  refreshSequence()
  return true
}

/** The nearest marker either side of the playhead — what ⇧M and the menu jump to. */
function jumpToMarker(dir) {
  const seq = currentSequence()
  const list = (seq?.markers ?? []).slice().sort((a, b) => a.ms - b.ms)
  if (!list.length) return status('no markers on this timeline', 'error')
  const now = state.compositor?.time ?? 0
  const next = dir > 0 ? list.find((m) => m.ms > now + 1) : [...list].reverse().find((m) => m.ms < now - 1)
  if (!next) return status(dir > 0 ? 'no marker after here' : 'no marker before here', 'error')
  state.compositor.pause()
  $('btnSeqPlay').textContent = '▶'
  state.compositor.seekTo(next.ms)
  status(`${next.label || 'marker'} — ${fmtClock(next.ms)}`)
}

/* ------------------------------------------------------- copy and duplicate */

/** Items cut or copied from a timeline, as plain data. Survives switching timeline. */
let itemClipboard = []

function copySelectedItems({ cut = false } = {}) {
  const seq = currentSequence()
  const items = state.selectedItems ?? []
  if (!items.length) return status('nothing is selected', 'error')
  const base = Math.min(...items.map((i) => i.startMs))
  itemClipboard = items.map((i) => {
    const found = SEQ.findItem(seq, i.id)
    return { item: JSON.parse(JSON.stringify(i)), at: i.startMs - base, trackName: found?.track?.name ?? null, kind: found?.track?.kind ?? 'video' }
  })
  if (cut) {
    state.timeline.deleteSelected()
    markTimelineDirty(seq)
    refreshSequence()
  }
  status(`${cut ? 'cut' : 'copied'} ${items.length} item${items.length === 1 ? '' : 's'}`)
}

/**
 * Paste at the playhead, onto the track each item came from where that track
 * still exists and is free — otherwise the first track of the right kind that
 * is. Nothing is ever overwritten silently: `placeItem` trims what it lands on,
 * the same rule a drag on the timeline obeys.
 */
function pasteItems({ atMs = null } = {}) {
  const seq = currentSequence()
  if (!seq || !itemClipboard.length) return status('nothing has been copied', 'error')
  const at = Math.max(0, Math.round(atMs ?? state.compositor?.time ?? 0))
  const made = []
  for (const entry of itemClipboard) {
    const copy = { ...JSON.parse(JSON.stringify(entry.item)), id: `i_${Math.random().toString(36).slice(2, 10)}` }
    copy.startMs = at + entry.at
    const track =
      seq.tracks.find((t) => t.name === entry.trackName && t.kind === entry.kind && !t.locked) ??
      seq.tracks.find((t) => t.kind === entry.kind && !t.locked)
    if (!track) continue
    SEQ.placeItem(track, copy)
    made.push(copy)
  }
  if (!made.length) return status('no unlocked track to paste onto', 'error')
  markTimelineDirty(seq)
  refreshSequence()
  state.timeline.selectMany(made.map((m) => m.id))
  selectItems(made)
  status(`pasted ${made.length} item${made.length === 1 ? '' : 's'}`)
}

/** A copy of everything selected, laid down right after it. */
function duplicateSelectedItems() {
  const items = state.selectedItems ?? []
  if (!items.length) return status('nothing is selected', 'error')
  const was = itemClipboard
  copySelectedItems()
  const end = Math.max(...items.map((i) => i.startMs + i.durationMs))
  pasteItems({ atMs: end })
  itemClipboard = was.length ? was : itemClipboard
}

/* ------------------------------------------------------------ track panel */

const TRACK_SWATCHES = ['#5b9cff', '#7ee0b8', '#ffd166', '#ff8fab', '#c39bff', '#ff9f5b', '#6ee7f0', '#b8c4d6']

function selectTrack(track) {
  state.selectedTrack = track
  state.selectedItem = null
  state.timeline?.select(null)
  renderItemInspector()
  renderTrackInspector()
}

function renderTrackInspector() {
  const seq = currentSequence()
  const live = state.selectedTrack && seq ? seq.tracks.find((t) => t.id === state.selectedTrack.id) : null
  state.selectedTrack = live
  $('trackInspector').classList.toggle('hidden', !live)
  $('itemInspector').classList.toggle('hidden', !!live || multiSelected())
  if (!live) return

  $('trackName').value = live.name
  $('trackNote').value = live.note ?? ''
  $('trackLocked').checked = !!live.locked
  $('trackMuted').checked = !!live.muted
  $('trackHidden').checked = !!live.hidden
  $('rowTrackHidden').classList.toggle('hidden', live.kind !== 'video')
  {
    const same = seq.tracks.filter((t) => t.kind === live.kind)
    const pos = same.indexOf(live)
    $('btnTrackUp').disabled = $('btnTrackTop').disabled = pos <= 0
    $('btnTrackDown').disabled = $('btnTrackBottom').disabled = pos >= same.length - 1
    $('trackOrder').textContent = `${pos + 1} of ${same.length} ${live.kind} track${same.length === 1 ? '' : 's'} · top draws over the rest`
    const canDelete = !live.items.length && seq.tracks.length > 1
    $('btnTrackDelete').disabled = !canDelete
    setTip($('btnTrackDelete'), canDelete ? 'Remove this empty track. Click twice.' : live.items.length ? 'Empty the track first — deleting items is a separate, undoable step.' : 'A timeline keeps at least one track.')
  }

  const wrap = $('trackSwatches')
  wrap.innerHTML = ''
  for (const color of [null, ...TRACK_SWATCHES]) {
    const b = document.createElement('button')
    b.className = 'swatch' + (color ? '' : ' none') + ((live.color ?? null) === color ? ' active' : '')
    if (color) b.style.setProperty('--sw', color)
    setTip(b, color ? color : 'No colour')
    b.onclick = () => {
      if (color) live.color = color
      else delete live.color
      markTimelineDirty(currentSequence())
      refreshSequence()
    }
    wrap.appendChild(b)
  }
}

function initTrackInspector() {
  const bind = (id, apply, event = 'change') =>
    $(id).addEventListener(event, () => {
      const t = state.selectedTrack
      if (!t) return
      apply(t, $(id).value, $(id).checked)
      markTimelineDirty(currentSequence())
      refreshSequence()
    })
  bind('trackName', (t, v) => { t.name = v.trim() || t.name })
  bind('trackNote', (t, v) => { if (v.trim()) t.note = v.trim(); else delete t.note })
  bind('trackLocked', (t, _v, c) => { t.locked = !!c })
  bind('trackMuted', (t, _v, c) => { t.muted = !!c })
  bind('trackHidden', (t, _v, c) => { t.hidden = !!c })
  $('btnTrackUp').onclick = () => state.selectedTrack && moveTrack(state.selectedTrack, 'up')
  $('btnTrackDown').onclick = () => state.selectedTrack && moveTrack(state.selectedTrack, 'down')
  $('btnTrackTop').onclick = () => state.selectedTrack && moveTrack(state.selectedTrack, 'top')
  $('btnTrackBottom').onclick = () => state.selectedTrack && moveTrack(state.selectedTrack, 'bottom')
  // Two clicks within three seconds, like deleting a timeline: a stray click removes nothing.
  let trackDeleteArmed = 0
  $('btnTrackDelete').onclick = () => {
    const t = state.selectedTrack
    if (!t) return
    if (Date.now() - trackDeleteArmed > 3000) {
      trackDeleteArmed = Date.now()
      status(`click Delete again to remove track "${t.name}"`)
      return
    }
    trackDeleteArmed = 0
    try {
      removeTrack(t)
    } catch (err) {
      status(err?.message ?? String(err), 'error')
    }
  }
  $('trackNote').addEventListener('keydown', (e) => e.stopPropagation())
  $('trackName').addEventListener('keydown', (e) => e.stopPropagation())
}

function renderItemInspector() {
  const item = state.selectedItem
  const settings = $('itemSettings')
  const empty = $('itemEmpty')

  // A selected item that has since been deleted or split away is not selected;
  // one that survived an undo is a *new object* with the same id, so always
  // re-point at whatever the timeline holds now.
  const seq = currentSequence()
  const found = item && seq ? SEQ.findItem(seq, item.id) : null
  state.selectedItem = found ? found.item : null
  const live = state.selectedItem

  settings.classList.toggle('hidden', !live)
  empty.classList.toggle('hidden', !!live)
  $('itemInspector').classList.toggle('hidden', multiSelected() || !!state.selectedTrack)
  if (!live) return

  const media = live.type === 'media' ? state.lib.media.get(live.sourceId) : null
  const nested = live.type === 'timeline'
  const isOverlay = live.type !== 'media' && !nested
  const hasAudio = (live.type === 'media' && !!media?.hasAudio) || nested
  const hasPicture = live.type === 'media' ? !!media?.hasVideo : true

  $('itemName').value = live.name ?? ''
  $('itemStart').value = (live.startMs / 1000).toFixed(2)
  $('itemDur').value = (live.durationMs / 1000).toFixed(2)
  $('itemIn').value = (live.inMs / 1000).toFixed(2)
  $('itemIn').disabled = live.type === 'animation' || live.type === 'image'
  $('itemOpacity').value = String(live.opacity ?? 1)
  $('itemOpacityVal').textContent = Math.round((live.opacity ?? 1) * 100) + '%'

  $('rowFit').classList.toggle('hidden', !((live.type === 'media' && hasPicture) || nested || live.type === 'image'))
  $('itemFit').value = live.fit ?? 'contain'
  $('rowNested').classList.toggle('hidden', !nested)

  const placeable = isOverlay || ((live.type === 'media' || nested) && live.fit === 'none')
  $('rowAnchor').classList.toggle('hidden', !placeable)
  $('rowOffX').classList.toggle('hidden', !placeable)
  $('rowOffY').classList.toggle('hidden', !placeable)
  $('itemAnchor').value = live.anchor ?? 'center'

  // Only the layers that have no size of their own are scaled; an image and a
  // shape carry a width and a height, and a title a type size.
  const scalable = SEQ.scales(live) && (isOverlay || live.fit === 'none')
  $('rowScale').classList.toggle('hidden', !scalable)
  $('placeHint').classList.toggle('hidden', !placeable && !scalable)
  updatePlacementFields(live)

  renderTransformInspector(live, { placeable, isOverlay, nested, media })
  renderLookInspector(live)
  renderKeyInspector(live, { placeable, hasPicture })
  const canSpeed = live.type === 'media' || nested || live.type === 'animation'
  $('rowSpeed').classList.toggle('hidden', !canSpeed)
  if (canSpeed) $('itemSpeed').value = String(SEQ.speedOf(live))
  $('rowDissolve').classList.toggle('hidden', !hasPicture)
  $('dissolveIn').value = ((live.dissolveInMs ?? 0) / 1000).toFixed(1)
  $('dissolveOut').value = ((live.dissolveOutMs ?? 0) / 1000).toFixed(1)

  $('rowAudio').classList.toggle('hidden', !hasAudio)
  $('btnDetach').classList.toggle('hidden', !(hasAudio && hasPicture && found?.track?.kind === 'video'))
  $('itemVolume').value = String(live.volume ?? 1)
  $('itemVolumeVal').textContent = Math.round((live.volume ?? 1) * 100) + '%'
  $('itemMuted').checked = !!live.muted
  $('itemFadeIn').value = ((live.fadeInMs ?? 0) / 1000).toFixed(1)
  $('itemFadeOut').value = ((live.fadeOutMs ?? 0) / 1000).toFixed(1)

  const txt = live.type === 'text'
  $('rowText').classList.toggle('hidden', !txt)
  if (txt) {
    const preset = textPreset(live.sourceId) ?? TEXT_PRESETS[0]
    const st = { ...defaultTextStyle(), ...(preset.defaults ?? {}), ...(live.textStyle ?? {}) }
    if (document.activeElement !== $('textText')) $('textText').value = live.text ?? ''
    $('textSub').value = live.subtext ?? ''
    $('rowTextSub').classList.toggle('hidden', !preset.fields.includes('subtext'))
    $('textPreset').value = preset.id
    $('textFont').value = st.fontFamily
    $('textSize').value = String(st.fontSize)
    $('textWeight').value = String(st.weight)
    $('textColor').value = st.color
    $('textAccent').value = st.accent
    $('textAlign').value = st.align
    $('textUpper').checked = !!st.uppercase

    // A shape is a title with no words: size and outline instead of type.
    const shape = preset.kind === 'shape'
    $('rowShape').classList.toggle('hidden', !shape)
    for (const el of document.querySelectorAll('#rowText .text-only')) el.classList.toggle('hidden', shape)
    if (shape) {
      $('shapeW').value = String(st.width)
      $('shapeH').value = String(st.height)
      $('shapeRadius').value = String(st.radius ?? 0)
      $('shapeStroke').value = String(st.stroke ?? 0)
      $('rowShapeDir').classList.toggle('hidden', preset.id !== 'shape-arrow')
      $('shapeDir').value = st.direction ?? 'right'
    }
  }

  const img = live.type === 'image'
  $('rowImage').classList.toggle('hidden', !img)
  if (img) {
    const st = live.imageStyle ?? {}
    const asset = seqContext().assets.get(live.sourceId)
    $('imgW').value = st.width ? String(st.width) : ''
    $('imgH').value = st.height ? String(st.height) : ''
    $('imgW').placeholder = asset?.width ? `${asset.width} (natural)` : 'auto'
    $('imgH').placeholder = asset?.height ? `${asset.height} (natural)` : 'auto'
    $('imgRadius').value = String(st.radius ?? 0)
    $('imgShadow').checked = !!st.shadow
    $('imgSource').textContent = asset ? `${asset.name} · ${asset.width ?? '?'}×${asset.height ?? '?'}` : `${live.sourceId} — missing from Assets`
  }

  const cap = live.type === 'caption'
  $('rowCaption').classList.toggle('hidden', !cap)
  if (cap) {
    const s = live.captionStyle ?? SEQ.defaultCaptionStyle()
    live.captionStyle = s
    $('capSize').value = String(s.fontSize)
    $('capMargin').value = String(s.marginPx)
    $('capColor').value = s.color
    $('capPos').value = s.position
    $('capTransition').value = s.transition ?? 'cut'
    $('capKaraoke').value = s.karaoke ?? 'off'
    $('capAccent').value = s.accent ?? '#ffd166'
    $('capUpper').checked = s.uppercase
    $('capShadow').checked = s.shadow
  }

  $('btnEditClip').classList.toggle('hidden', live.type !== 'animation')
  $('itemNote').value = live.note ?? ''
  if (hasAudio) updateSilenceSummary()
  if (hasAudio || live.type === 'media') renderReplaceChoices(live)
  if (cap) renderCueEditor(live)
}

/**
 * The keyframe rows: one per property, each a diamond you fill.
 *
 * The diamond is the whole interaction, and it is the one every editor uses:
 * filled means "there is a key on this exact frame", so clicking it removes
 * one and clicking an empty one puts the value that is in the panel right now.
 * Setting a value while a property is already keyed writes a key at the
 * playhead rather than a constant — which is what you meant, and what makes
 * the panel and the diamonds one control instead of two.
 */
function renderKeyInspector(live, { placeable, hasPicture }) {
  const rows = $('keyRows')
  const canKey = placeable || hasPicture
  $('rowKeys').classList.toggle('hidden', !canKey)
  if (!canKey) return

  const local = Math.round((state.compositor?.time ?? 0) - live.startMs)
  const inside = local >= 0 && local <= live.durationMs
  $('keysHint').textContent = inside
    ? 'Put the playhead where you want a value, set it, then press ◆.'
    : 'The playhead is outside this item — move it inside to add a key.'

  const frame = 1000 / (currentSequence()?.fps || 30)
  rows.replaceChildren()
  for (const prop of KEYS.KEYABLE) {
    if (prop === 'scale' && !SEQ.scales(live)) continue
    const keys = KEYS.keysFor(live, prop)
    const here = keys?.find((k) => Math.abs(k.ms - local) < frame / 2) ?? null

    const row = document.createElement('div')
    row.className = 'key-row'
    row.append(Object.assign(document.createElement('span'), { className: 'k-name', textContent: KEYS.KEY_LABELS[prop] }))

    const diamond = document.createElement('button')
    diamond.textContent = '◆'
    diamond.className = here ? 'on' : ''
    diamond.disabled = !inside
    setTip(diamond, here
      ? `Remove the key on this frame.`
      : `Key ${KEYS.KEY_LABELS[prop].toLowerCase()} here, at whatever it is now.`)
    diamond.onclick = () => toggleKey(prop, local)
    row.appendChild(diamond)

    row.append(Object.assign(document.createElement('span'), {
      className: 'k-count',
      textContent: keys ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : 'still',
    }))

    if (here) {
      const ease = document.createElement('select')
      for (const e of KEYS.EASES) ease.appendChild(Object.assign(document.createElement('option'), { value: e, textContent: e }))
      ease.value = here.ease
      setTip(ease, 'How it leaves this key: ease slows in and out, linear is a straight line, hold stays put until the next one.')
      ease.onchange = () => {
        here.ease = ease.value
        markTimelineDirty(currentSequence())
        refreshSequence()
      }
      row.appendChild(ease)
    }
    rows.appendChild(row)
  }
}

/** What a property is worth right now, from the same fields the panel shows. */
function keyValueNow(item, prop) {
  if (prop === 'scale') return SEQ.scaleOf(item)
  if (prop === 'opacity') return item.opacity ?? 1
  return item[prop] ?? 0
}

function toggleKey(prop, localMs) {
  const item = state.selectedItem
  const seq = currentSequence()
  if (!item || !seq) return
  const frame = 1000 / (seq.fps || 30)
  const existing = KEYS.keysFor(item, prop)?.find((k) => Math.abs(k.ms - localMs) < frame / 2)
  if (existing) KEYS.removeKey(item, prop, localMs, frame)
  else KEYS.setKey(item, prop, localMs, keyValueNow(item, prop), 'ease', frame)
  markTimelineDirty(seq)
  refreshSequence()
}

/**
 * Writing a value while its property is keyed puts a key at the playhead.
 *
 * Otherwise the panel and the diamonds would disagree: you would type a number,
 * see nothing change, and have to press ◆ to find out it had gone somewhere.
 */
function noteKeyedEdit(item, prop) {
  if (!item || !KEYS.isKeyed(item, prop)) return
  const seq = currentSequence()
  const local = Math.round((state.compositor?.time ?? 0) - item.startMs)
  if (local < 0 || local > item.durationMs) return
  KEYS.setKey(item, prop, local, keyValueNow(item, prop), 'ease', 1000 / (seq?.fps || 30))
}

function initKeyInspector() {
  $('btnKeysClear').onclick = () => {
    const item = state.selectedItem
    if (!item) return
    KEYS.clearKeys(item)
    markTimelineDirty(currentSequence())
    refreshSequence()
  }
  const jump = (dir) => {
    const item = state.selectedItem
    if (!item) return
    const times = KEYS.keyTimes(item).map((ms) => ms + item.startMs)
    if (!times.length) return status('this item has no keyframes', 'error')
    const now = state.compositor?.time ?? 0
    const to = dir > 0 ? times.find((t) => t > now + 1) : [...times].reverse().find((t) => t < now - 1)
    if (to == null) return status(dir > 0 ? 'no key after here' : 'no key before here', 'error')
    state.compositor.pause()
    $('btnSeqPlay').textContent = '▶'
    state.compositor.seekTo(to)
  }
  $('btnKeyPrev').onclick = () => jump(-1)
  $('btnKeyNext').onclick = () => jump(1)
}

/** Turning, mirroring and cropping — and whether this kind of layer can. */
function renderTransformInspector(live, { placeable, isOverlay, nested, media }) {
  const canTurn = isOverlay || ((live.type === 'media' || nested) && !!(media?.hasVideo || nested))
  // Cropping is cutting the source's own edges, which only a source has. A
  // title or a shape has a size instead, and an image a box and a fit.
  const canCrop = (live.type === 'media' && !!media?.hasVideo) || nested
  $('rowTransform').classList.toggle('hidden', !canTurn)
  $('rowArrange').classList.toggle('hidden', !placeable && !canTurn)
  if (!canTurn) return

  $('itemRotate').value = String(FX.rotationOf(live))
  $('btnFlipH').classList.toggle('on', !!live.flipH)
  $('btnFlipV').classList.toggle('on', !!live.flipV)

  $('rowCrop').classList.toggle('hidden', !canCrop)
  if (canCrop) {
    const c = live.crop ?? {}
    const pct = (v) => String(Math.round((Number(v) || 0) * 100))
    $('cropT').value = pct(c.top)
    $('cropR').value = pct(c.right)
    $('cropB').value = pct(c.bottom)
    $('cropL').value = pct(c.left)
    $('btnCropMode').classList.toggle('on', state.cropMode)
  } else if (state.cropMode) setCropMode(false)
}

/** Colour, blending and edges. Every layer that paints something has these. */
function renderLookInspector(live) {
  const paints = live.type !== 'media' || !!state.lib.media.get(live.sourceId)?.hasVideo
  $('rowLook').classList.toggle('hidden', !paints)
  if (!paints) return
  const c = { ...FX.COLOUR_NEUTRAL, ...(live.colour ?? {}) }
  const setPct = (id, v) => { $(id).value = String(Math.round(v * 100)); $(`${id}Val`).textContent = `${Math.round(v * 100)}%` }
  setPct('ccBright', c.brightness)
  setPct('ccContrast', c.contrast)
  setPct('ccSat', c.saturation)
  $('ccTemp').value = String(Math.round(c.temperature * 100))
  $('ccTempVal').textContent = c.temperature > 0 ? `+${Math.round(c.temperature * 100)} warm` : c.temperature < 0 ? `${Math.round(c.temperature * 100)} cool` : '0'
  $('itemBlend').value = FX.blendOf(live) ?? 'normal'
  $('itemRadius').value = String(FX.radiusOf(live))
  const sh = live.shadow ?? {}
  $('shBlur').value = String(Math.round(Number(sh.blur) || 0))
  $('shX').value = String(Math.round(Number(sh.x) || 0))
  $('shY').value = String(Math.round(Number(sh.y) || 0))
  $('shColor').value = typeof sh.color === 'string' ? sh.color : '#000000'
  const op = sh.opacity == null ? 0.45 : Number(sh.opacity)
  $('shOpacity').value = String(Math.round(op * 100))
  $('shOpacityVal').textContent = `${Math.round(op * 100)}%`
}

/**
 * Crop mode swaps what the stage handles do: cut the source's edges instead of
 * resizing the layer. It is a mode because the two gestures are the same drag
 * on the same handles, and every editor that has tried to infer which one you
 * meant has got it wrong.
 */
function setCropMode(on) {
  const item = state.selectedItem
  const canCrop = item && (item.type === 'media' || item.type === 'timeline')
  state.cropMode = !!on && !!canCrop
  $('btnCropMode').classList.toggle('on', state.cropMode)
  document.body.classList.toggle('cropping', state.cropMode)
  state.stageTools?.setCropMode(state.cropMode)
  if (state.cropMode) status('cropping — drag the handles to cut the edges; Esc or C to stop')
}

function initTransformInspector() {
  bindItem('itemRotate', (i, v) => {
    let d = Math.round(Number(v) || 0)
    d = ((d % 360) + 360) % 360
    i.rotation = d > 180 ? d - 360 : d
  })
  $('btnFlipH').onclick = () => toggleItemFlag('flipH')
  $('btnFlipV').onclick = () => toggleItemFlag('flipV')
  $('btnUnturn').onclick = () => {
    const item = state.selectedItem
    if (!item) return
    delete item.rotation
    delete item.flipH
    delete item.flipV
    markTimelineDirty(currentSequence())
    refreshSequence()
  }

  for (const [id, side] of [['cropT', 'top'], ['cropR', 'right'], ['cropB', 'bottom'], ['cropL', 'left']]) {
    bindItem(id, (i, v) => {
      const n = Math.max(0, Math.min(95, Math.round(Number(v) || 0))) / 100
      i.crop = { ...(i.crop ?? {}), [side]: n }
      if (!FX.cropOf(i)) delete i.crop
    })
  }
  $('btnCropMode').onclick = () => setCropMode(!state.cropMode)
  $('btnCropReset').onclick = () => {
    const item = state.selectedItem
    if (!item) return
    delete item.crop
    markTimelineDirty(currentSequence())
    refreshSequence()
  }

  const applySpeed = (item, rate) => {
    const was = SEQ.speedOf(item)
    const next = Math.max(SEQ.SPEED_MIN, Math.min(SEQ.SPEED_MAX, Number(rate) || 1))
    // Keeping the same stretch of source means the item's length on the
    // timeline moves the other way: twice as fast, half as long.
    if ($('speedRipple').checked && Math.abs(next - was) > 0.001) {
      item.durationMs = Math.max(40, Math.round((item.durationMs * was) / next))
    }
    if (Math.abs(next - 1) < 0.001) delete item.speed
    else item.speed = next
    const seq = currentSequence()
    const found = SEQ.findItem(seq, item.id)
    if (found) SEQ.placeItem(found.track, item)
  }
  bindItem('itemSpeed', (i, v) => applySpeed(i, parseFloat(v)))
  document.querySelectorAll('.speed-btn').forEach((b) => {
    b.onclick = () => {
      const item = state.selectedItem
      if (!item) return
      applySpeed(item, Number(b.dataset.speed))
      markTimelineDirty(currentSequence())
      refreshSequence()
    }
  })

  bindItem('dissolveIn', (i, v) => { const n = Math.max(0, Math.round(parseFloat(v) * 1000) || 0); if (n) i.dissolveInMs = Math.min(n, i.durationMs); else delete i.dissolveInMs })
  bindItem('dissolveOut', (i, v) => { const n = Math.max(0, Math.round(parseFloat(v) * 1000) || 0); if (n) i.dissolveOutMs = Math.min(n, i.durationMs); else delete i.dissolveOutMs })
  $('btnCrossDissolve').onclick = () => crossDissolve()

  document.querySelectorAll('.align-btn').forEach((b) => {
    b.onclick = () => alignSelection(b.dataset.align)
  })
  $('btnItemFront').onclick = () => restackItem('front')
  $('btnItemBack').onclick = () => restackItem('back')
  $('btnItemUpOne').onclick = () => restackItem('up')
  $('btnItemDownOne').onclick = () => restackItem('down')
}

function toggleItemFlag(key) {
  const item = state.selectedItem
  if (!item) return
  if (item[key]) delete item[key]
  else item[key] = true
  markTimelineDirty(currentSequence())
  refreshSequence()
}

/** Write one colour field, keeping the object out of the document when neutral. */
function setColour(item, key, value) {
  item.colour = { ...FX.COLOUR_NEUTRAL, ...(item.colour ?? {}), [key]: value }
  if (!FX.colourOf(item)) delete item.colour
}

function initLookInspector() {
  const slider = (id, apply, fmt) => {
    $(id).addEventListener('input', () => {
      const item = state.selectedItem
      if (!item) return
      apply(item, Number($(id).value))
      $(`${id}Val`).textContent = fmt(Number($(id).value))
    })
    $(id).addEventListener('change', () => { markTimelineDirty(currentSequence()); refreshSequence() })
  }
  const pct = (n) => `${n}%`
  slider('ccBright', (i, v) => setColour(i, 'brightness', v / 100), pct)
  slider('ccContrast', (i, v) => setColour(i, 'contrast', v / 100), pct)
  slider('ccSat', (i, v) => setColour(i, 'saturation', v / 100), pct)
  slider('ccTemp', (i, v) => setColour(i, 'temperature', v / 100), (n) => (n > 0 ? `+${n} warm` : n < 0 ? `${n} cool` : '0'))
  slider('shOpacity', (i, v) => setShadow(i, 'opacity', v / 100), pct)

  bindItem('itemBlend', (i, v) => { if (v && v !== 'normal') i.blend = v; else delete i.blend })
  bindItem('itemRadius', (i, v) => { const n = Math.max(0, Math.round(Number(v) || 0)); if (n) i.radius = n; else delete i.radius })
  const px = (v) => Math.round(Number(v) || 0)
  bindItem('shBlur', (i, v) => setShadow(i, 'blur', Math.max(0, px(v))))
  bindItem('shX', (i, v) => setShadow(i, 'x', px(v)))
  bindItem('shY', (i, v) => setShadow(i, 'y', px(v)))
  bindItem('shColor', (i, v) => setShadow(i, 'color', v))

  $('btnLookReset').onclick = () => {
    const item = state.selectedItem
    if (!item) return
    for (const k of ['colour', 'blend', 'radius', 'shadow']) delete item[k]
    markTimelineDirty(currentSequence())
    refreshSequence()
  }
}

function setShadow(item, key, value) {
  item.shadow = { blur: 0, x: 0, y: 0, color: '#000000', opacity: 0.45, ...(item.shadow ?? {}), [key]: value }
  if (!FX.shadowOf(item)) delete item.shadow
}

/**
 * The half of the panel a stage drag writes: where the item sits and how big
 * it is. Split out because a drag repaints it on every pointer event and the
 * rest of the inspector — the cue list above all — must not be rebuilt at that
 * rate.
 */
function updatePlacementFields(item = state.selectedItem) {
  if (!item) return
  $('itemOffX').value = String(item.offsetX ?? 0)
  $('itemOffY').value = String(item.offsetY ?? 0)
  const pct = Math.round(SEQ.scaleOf(item) * 100)
  $('itemScale').value = String(pct)
  $('itemScaleVal').textContent = `${pct}%`
  const st = item.type === 'image' ? item.imageStyle : item.textStyle
  if (item.type === 'image') {
    $('imgW').value = st?.width ? String(st.width) : ''
    $('imgH').value = st?.height ? String(st.height) : ''
  } else if (item.type === 'text') {
    if (st?.width != null) $('shapeW').value = String(st.width)
    if (st?.height != null) $('shapeH').value = String(st.height)
    if (st?.fontSize != null) $('textSize').value = String(st.fontSize)
  } else if (item.type === 'caption' && item.captionStyle?.fontSize != null) {
    $('capSize').value = String(item.captionStyle.fontSize)
  }
}

/** Mark the cue row the playhead is in, without rebuilding the list. */
let cueRowNow = -1
function highlightCueRow(ms) {
  const item = state.selectedItem
  if (item?.type !== 'caption') {
    cueRowNow = -1
    return
  }
  const t = state.lib.transcripts.get(item.sourceId)
  if (!t) return
  const now = SEQ.sourceTimeAt(item, ms)
  const idx = t.cues.findIndex((c) => now >= c.startMs && now < c.endMs)
  if (idx === cueRowNow) return // every frame otherwise walks hundreds of rows for nothing
  cueRowNow = idx
  for (const row of $('cueList').children) {
    row.classList.toggle('now', Number(row.dataset.index) === idx)
  }
}

/** Open the transcript editor, parked on whatever the playhead is over. */
function openTranscriptEditor(id, item = null) {
  const src = transcriptSourceMsAtPlayhead(id)
  state.transcriptEditor?.open(id, { sourceMs: src, item }).catch((err) => status(err?.message ?? String(err), 'error'))
}

/* ------------------------------------------------------- captions export */

/**
 * The captions of some items as one list, timed as they fall on the timeline
 * (or in source time, when every item plays the same transcript). Cues cut by
 * an item's edges are clipped to it, exactly as the render shows them.
 */
async function captionCuesOf(items, { times = 'timeline' } = {}) {
  const caps = items.filter((i) => i.type === 'caption')
  if (!caps.length) throw new Error('no caption items there')
  if (times === 'source' && new Set(caps.map((i) => i.sourceId)).size > 1) {
    throw new Error('source times only make sense for one transcript — these items play several; use timeline times')
  }
  const out = []
  for (const item of caps) {
    const t = await state.lib.loadTranscript(item.sourceId)
    if (!t) continue
    const from = item.inMs
    const to = item.inMs + item.durationMs
    const shift = times === 'timeline' ? item.startMs - item.inMs : 0
    for (const c of t.cues) {
      if (c.endMs <= from || c.startMs >= to) continue
      out.push({ startMs: Math.max(c.startMs, from) + shift, endMs: Math.min(c.endMs, to) + shift, text: c.text })
    }
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out
}

/** Write one subtitle file into Exports from caption items; returns { url, name, size, count }. */
async function exportCaptions({ items, format = 'srt', times = 'timeline', name = null }) {
  const cues = await captionCuesOf(items, { times })
  const seq = currentSequence()
  const base = name || (items.length === 1 ? items[0].name : `${seq?.name ?? 'timeline'} captions`)
  const res = await fetch('/api/export/captions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: base, format, cues }),
  })
  const r = await res.json()
  if (!res.ok) throw new Error(r.error ?? 'captions export failed')
  return r
}

function captionItemsFor(scope, item = null) {
  const seq = currentSequence()
  if (!seq) return []
  if (scope === 'item') return item ? [item] : (state.selectedItem?.type === 'caption' ? [state.selectedItem] : [])
  if (scope === 'selection') return (state.selectedItems ?? []).filter((i) => i.type === 'caption')
  return [...SEQ.allItems(seq)].map((x) => x.item).filter((i) => i.type === 'caption')
}

let captionsDialogItem = null
function openCaptionsDialog({ scope = 'timeline', item = null } = {}) {
  const dlg = $('dlgCaptions')
  captionsDialogItem = item
  const sel = $('capExScope')
  sel.querySelector('[value=item]').disabled = !(item || state.selectedItem?.type === 'caption')
  sel.querySelector('[value=selection]').disabled = !(state.selectedItems ?? []).some((i) => i.type === 'caption')
  sel.value = scope
  if (sel.options[sel.selectedIndex]?.disabled) sel.value = 'timeline'
  $('capExResult').textContent = ''
  $('capExResult').classList.remove('error')
  refreshCaptionsDialog()
  if (!dlg.open) dlg.showModal()
}

function refreshCaptionsDialog() {
  const scope = $('capExScope').value
  const items = captionItemsFor(scope, captionsDialogItem)
  const seq = currentSequence()
  const one = new Set(items.map((i) => i.sourceId)).size <= 1
  $('capExTimes').querySelector('[value=source]').disabled = !one
  if (!one) $('capExTimes').value = 'timeline'
  const total = items.reduce((n, i) => n + i.durationMs, 0)
  $('capExInfo').textContent = items.length
    ? `${items.length} caption item${items.length === 1 ? '' : 's'} · ${(total / 1000).toFixed(1)}s of captions · ${one ? 'one transcript' : `${new Set(items.map((i) => i.sourceId)).size} transcripts`}`
    : 'no caption items in that scope'
  if (!$('capExName').dataset.edited) {
    $('capExName').value = items.length === 1 ? items[0].name : `${seq?.name ?? 'timeline'} captions`
  }
  $('btnCapExRun').disabled = !items.length
}

function initCaptionsDialog() {
  $('capExScope').addEventListener('change', refreshCaptionsDialog)
  $('capExName').addEventListener('input', () => { $('capExName').dataset.edited = '1' })
  $('dlgCaptions').addEventListener('close', () => { delete $('capExName').dataset.edited })
  $('btnCapExClose').onclick = () => $('dlgCaptions').close()
  $('btnCapExRun').onclick = async () => {
    const out = $('capExResult')
    out.classList.remove('error')
    out.textContent = 'writing…'
    try {
      const r = await exportCaptions({
        items: captionItemsFor($('capExScope').value, captionsDialogItem),
        format: $('capExFormat').value,
        times: $('capExTimes').value,
        name: $('capExName').value.trim() || null,
      })
      // There is no Exports library in a build with no server; the browser's
      // downloads is the only place the file goes.
      out.textContent =
        `${r.name} · ${r.count} line${r.count === 1 ? '' : 's'} · ${formatBytes(r.size)} — ` +
        (state.local ? 'downloaded' : 'saved to Exports and downloaded')
      saveFile('captions', r.url, r.name)
      status(`captions exported: ${r.name}`)
    } catch (err) {
      out.textContent = err?.message ?? String(err)
      out.classList.add('error')
    }
  }
  $('btnMultiCaptions').onclick = () => openCaptionsDialog({ scope: 'selection' })
}

/**
 * Where the playhead is, in this transcript's source seconds: through a
 * caption item of it under the playhead, or its media on a video track.
 */
function transcriptSourceMsAtPlayhead(id, tlMs = state.compositor?.time ?? 0) {
  const seq = currentSequence()
  if (!seq || state.mode !== 'seq') return null
  for (const track of seq.tracks) {
    const item = SEQ.itemAt(track, tlMs)
    if (item?.type === 'caption' && item.sourceId === id) return SEQ.sourceTimeAt(item, tlMs)
  }
  const row = (state.lib?.transcriptList ?? []).find((t) => t.id === id)
  const mediaFile = row?.mediaFilename ?? state.lib?.transcripts.get(id)?.mediaFilename
  if (!mediaFile) return null
  for (const track of SEQ.videoTracks(seq)) {
    const item = SEQ.itemAt(track, tlMs)
    if (item?.type === 'media' && item.sourceId === mediaFile) return SEQ.sourceTimeAt(item, tlMs)
  }
  return null
}

/** The sounds that could replace this item's: audio-bearing media, newest first. */
function renderReplaceChoices(item) {
  const sel = $('itemReplaceAudio')
  sel.innerHTML = '<option value="">choose a sound…</option>'
  const media = [...state.lib.media.values()].filter((m) => m.hasAudio && m.filename !== item.sourceId)
  for (const m of media) {
    const o = document.createElement('option')
    o.value = m.filename
    o.textContent = `${m.name} · ${(m.durationMs / 1000).toFixed(1)}s`
    sel.appendChild(o)
  }
  $('rowReplace').classList.toggle('hidden', !media.length)
}

/**
 * The cues inside a caption item's window, editable in place. Commits write
 * to the server and recompile the captions; the row under the playhead is
 * marked so a fix can be found by scrubbing.
 */
function renderCueEditor(item) {
  const list = $('cueList')
  list.innerHTML = ''
  cueRowNow = -1
  const t = state.lib.transcripts.get(item.sourceId)
  if (!t) {
    list.textContent = 'loading…'
    return
  }
  const from = item.inMs
  const to = item.inMs + item.durationMs
  const now = SEQ.sourceTimeAt(item, state.compositor?.time ?? 0)
  let shown = 0
  t.cues.forEach((cue, index) => {
    if (cue.endMs <= from || cue.startMs >= to) return
    shown++
    const row = document.createElement('div')
    row.className = 'cue-row' + (now >= cue.startMs && now < cue.endMs ? ' now' : '')
    row.dataset.index = String(index)
    const a = document.createElement('input')
    a.type = 'number'
    a.step = '0.05'
    a.value = (cue.startMs / 1000).toFixed(2)
    a.title = 'start, source seconds'
    const b = document.createElement('input')
    b.type = 'number'
    b.step = '0.05'
    b.value = (cue.endMs / 1000).toFixed(2)
    b.title = 'end, source seconds'
    const text = document.createElement('input')
    text.type = 'text'
    text.value = cue.text.replace(/\n/g, ' ')
    text.spellcheck = true
    const del = document.createElement('button')
    del.textContent = '×'
    del.title = 'Remove this cue'
    const commit = (patch) =>
      editor.setCue(item.sourceId, index, patch).catch((err) => status(err?.message ?? String(err), 'error'))
    a.addEventListener('change', () => commit({ startMs: Math.round(parseFloat(a.value) * 1000) }))
    b.addEventListener('change', () => commit({ endMs: Math.round(parseFloat(b.value) * 1000) }))
    text.addEventListener('change', () => commit({ text: text.value }))
    del.onclick = () => commit({ delete: true })
    for (const el of [a, b, text]) el.addEventListener('keydown', (e) => e.stopPropagation())
    row.append(a, b, text, del)
    list.appendChild(row)
  })
  if (!shown) list.textContent = 'No cues in this item\'s range.'
  $('btnCueUndo').disabled = !(state.lib.transcriptHistory.get(item.sourceId)?.length)
}

function initCueEditor() {
  $('btnCueEditAll').onclick = () => {
    const item = state.selectedItem
    if (item?.type === 'caption') openTranscriptEditor(item.sourceId, item)
  }
  $('btnCueExport').onclick = () => {
    const item = state.selectedItem
    if (item?.type === 'caption') openCaptionsDialog({ scope: 'item', item })
  }
  $('btnCueAdd').onclick = () => {
    const item = state.selectedItem
    if (item?.type !== 'caption') return
    const at = Math.round(SEQ.sourceTimeAt(item, state.compositor?.time ?? 0))
    editor.insertCue(item.sourceId, { startMs: at, endMs: at + 2000, text: 'New line' }).catch((err) => status(err?.message ?? String(err), 'error'))
  }
  $('btnCueUndo').onclick = () => {
    const item = state.selectedItem
    if (item?.type !== 'caption') return
    editor.undoTranscriptEdit(item.sourceId).then((t) => status(t ? 'cue edit undone' : 'nothing to undo'))
  }
  $('itemReplaceAudio').addEventListener('change', async () => {
    const item = state.selectedItem
    const file = $('itemReplaceAudio').value
    if (!item || !file) return
    try {
      const r = await editor.replaceAudio(item.id, file)
      const diff = r.shorterByMs ? ` — ${(r.shorterByMs / 1000).toFixed(1)}s shorter than the picture` : r.longerByMs ? ` — ${(r.longerByMs / 1000).toFixed(1)}s of it unused` : ''
      status(`"${r.audio.name}" laid on ${r.track.name}; the item is muted${diff}`)
    } catch (err) {
      status(err?.message ?? String(err), 'error')
    }
  })
}

/** Write a value back onto the selected item and refresh what depends on it. */
function bindItem(id, apply, { event = 'change' } = {}) {
  $(id).addEventListener(event, () => {
    const item = state.selectedItem
    if (!item) return
    apply(item, $(id).value, $(id).checked)
    markTimelineDirty(currentSequence())
    refreshSequence()
  })
}

function initItemInspector() {
  $('btnOpenNested').addEventListener('click', () => {
    const live = state.selectedItem
    if (live?.type === 'timeline') openNested(live.sourceId)
  })
  $('btnFlatten').addEventListener('click', async () => {
    const live = state.selectedItem
    if (live?.type !== 'timeline') return
    try {
      const r = await editor.flattenItem(live.id)
      status(r.message ?? 'flattened')
    } catch (err) {
      status(err.message, 'error')
    }
  })

  initTransformInspector()
  initLookInspector()
  initKeyInspector()

  bindItem('itemName', (i, v) => { i.name = v || i.name })
  bindItem('itemNote', (i, v) => { if (v.trim()) i.note = v.trim(); else delete i.note })
  $('itemNote').addEventListener('keydown', (e) => e.stopPropagation())
  bindItem('itemStart', (i, v) => { i.startMs = Math.max(0, Math.round(parseFloat(v) * 1000) || 0) })
  bindItem('itemDur', (i, v) => { i.durationMs = Math.max(40, Math.round(parseFloat(v) * 1000) || 40) })
  bindItem('itemIn', (i, v) => { i.inMs = Math.max(0, Math.round(parseFloat(v) * 1000) || 0) })
  bindItem('itemFit', (i, v) => { i.fit = v })
  bindItem('itemAnchor', (i, v) => { i.anchor = v })
  bindItem('itemOffX', (i, v) => { i.offsetX = Math.round(Number(v) || 0); noteKeyedEdit(i, 'offsetX') })
  bindItem('itemOffY', (i, v) => { i.offsetY = Math.round(Number(v) || 0); noteKeyedEdit(i, 'offsetY') })

  // Like opacity: the slider paints its own label while it moves and only
  // rebuilds the layer when it is let go.
  $('itemScale').addEventListener('input', () => {
    const item = state.selectedItem
    if (!item) return
    item.scale = Math.max(SEQ.SCALE_MIN, Number($('itemScale').value) / 100)
    $('itemScaleVal').textContent = `${Math.round(item.scale * 100)}%`
    // Footage and nested blocks are one restyle away, so they follow the
    // slider. An animation clip has to be recompiled, which waits for release.
    if (item.type !== 'animation') {
      state.compositor?.reposition(item.id)
      state.stageTools?.render()
    }
  })
  $('itemScale').addEventListener('change', () => {
    noteKeyedEdit(state.selectedItem, 'scale')
    markTimelineDirty(currentSequence())
    refreshSequence()
  })
  bindItem('itemMuted', (i, _v, checked) => { i.muted = !!checked })
  bindItem('itemFadeIn', (i, v) => { i.fadeInMs = Math.max(0, Math.round(parseFloat(v) * 1000) || 0) })
  bindItem('itemFadeOut', (i, v) => { i.fadeOutMs = Math.max(0, Math.round(parseFloat(v) * 1000) || 0) })

  // Sliders update live; a rebuild on every pixel of drag would be wasteful, so
  // they paint their own label and only commit on release.
  $('itemOpacity').addEventListener('input', () => {
    const item = state.selectedItem
    if (!item) return
    item.opacity = Number($('itemOpacity').value)
    $('itemOpacityVal').textContent = Math.round(item.opacity * 100) + '%'
  })
  $('itemOpacity').addEventListener('change', () => {
    noteKeyedEdit(state.selectedItem, 'opacity')
    markTimelineDirty(currentSequence())
    refreshSequence()
  })

  $('itemVolume').addEventListener('input', () => {
    const item = state.selectedItem
    if (!item) return
    item.volume = Number($('itemVolume').value)
    $('itemVolumeVal').textContent = Math.round(item.volume * 100) + '%'
  })
  $('itemVolume').addEventListener('change', () => { markTimelineDirty(currentSequence()); refreshSequence() })

  const capField = (id, apply, event = 'change') =>
    $(id).addEventListener(event, () => {
      const item = state.selectedItem
      if (!item?.captionStyle) return
      apply(item.captionStyle, $(id).value, $(id).checked)
      markTimelineDirty(currentSequence())
      refreshSequence()
    })
  capField('capSize', (s, v) => { s.fontSize = Math.max(8, Math.min(300, Math.round(Number(v) || 54))) })
  capField('capMargin', (s, v) => { s.marginPx = Math.max(0, Math.round(Number(v) || 0)) })
  capField('capColor', (s, v) => { s.color = v }, 'input')
  capField('capPos', (s, v) => { s.position = v })
  capField('capTransition', (s, v) => { s.transition = v })
  capField('capKaraoke', (s, v) => { s.karaoke = v })
  capField('capAccent', (s, v) => { s.accent = v }, 'input')
  capField('capUpper', (s, _v, c) => { s.uppercase = !!c })
  capField('capShadow', (s, _v, c) => { s.shadow = !!c })

  /* text items */
  const sel = $('textPreset')
  for (const p of TEXT_PRESETS) {
    const o = document.createElement('option')
    o.value = p.id
    o.textContent = p.name
    sel.appendChild(o)
  }
  const textField = (id, apply, event = 'change') =>
    $(id).addEventListener(event, () => {
      const item = state.selectedItem
      if (item?.type !== 'text') return
      apply(item, $(id).value, $(id).checked)
      markTimelineDirty(currentSequence())
      refreshSequence()
    })
  const styleField = (id, key, parse = (v) => v, event = 'change') =>
    textField(id, (item, v) => { item.textStyle = { ...(item.textStyle ?? {}), [key]: parse(v) } }, event)

  // Typing redraws the stage live without touching the history; the undo
  // step lands when the field commits.
  $('textText').addEventListener('input', () => {
    const item = state.selectedItem
    if (item?.type !== 'text') return
    item.text = $('textText').value
    state.compositor?.rebuild()
  })
  textField('textText', (item, v) => {
    item.text = v
    if (!item.nameEdited) item.name = v.trim().slice(0, 40) || (textPreset(item.sourceId)?.name ?? 'Text')
  })
  textField('textSub', (item, v) => { item.subtext = v })
  textField('textPreset', (item, v) => { if (textPreset(v)) item.sourceId = v })
  styleField('textFont', 'fontFamily', (v) => v.trim() || defaultTextStyle().fontFamily)
  styleField('textSize', 'fontSize', (v) => Math.max(8, Math.min(600, Math.round(Number(v) || 96))))
  styleField('textWeight', 'weight', (v) => Number(v))
  styleField('textColor', 'color', (v) => v, 'input')
  styleField('textAccent', 'accent', (v) => v, 'input')
  styleField('textAlign', 'align')
  styleField('shapeW', 'width', (v) => Math.max(4, Math.min(4096, Math.round(Number(v) || 320))))
  styleField('shapeH', 'height', (v) => Math.max(4, Math.min(4096, Math.round(Number(v) || 120))))
  styleField('shapeRadius', 'radius', (v) => Math.max(0, Math.round(Number(v) || 0)))
  styleField('shapeStroke', 'stroke', (v) => Math.max(0, Math.round(Number(v) || 0)))
  styleField('shapeDir', 'direction')
  textField('textUpper', (item, _v, c) => { item.textStyle = { ...(item.textStyle ?? {}), uppercase: !!c } })
  for (const id of ['textText', 'textSub', 'textFont']) $(id).addEventListener('keydown', (e) => e.stopPropagation())
  $('btnTextToClip').onclick = () => convertOverlayToClip(state.selectedItem)
  $('btnDetach').onclick = async () => {
    const item = state.selectedItem
    if (!item) return
    try {
      const r = await editor.detachAudio(item.id)
      status(`sound moved to ${r.track.name} as "${r.audio.name}" — the picture is muted`)
    } catch (err) {
      status(err?.message ?? String(err), 'error')
    }
  }

  // The title gallery in the Text rail.
  const grid = $('titleGrid')
  for (const p of TEXT_PRESETS) {
    const shape = p.kind === 'shape'
    if (shape && !grid.querySelector('.title-head')) {
      const h = document.createElement('div')
      h.className = 'title-head'
      h.textContent = 'Shapes'
      setTip(h, 'Rectangles, rings, highlights and arrows. Size, colour and place them in the inspector.\nA rectangle in the footage\'s own colour hides a name or a detail.', { at: 'right' })
      grid.appendChild(h)
    }
    const tile = document.createElement('div')
    tile.className = `title-tile p-${p.id}${shape ? ' p-shape' : ''}`
    tile.draggable = true
    tile.innerHTML = `<div class="tname"></div><div class="tnote"></div>`
    tile.querySelector('.tname').textContent = p.name
    tile.querySelector('.tnote').textContent = p.note
    setTip(tile, `${p.name}\n${p.note}\n${(p.defaultDurationMs / 1000).toFixed(1)}s by default · click to add at the playhead, or drag onto a track`, { at: 'right' })
    const words = shape ? '' : p.fields.includes('subtext') && p.id === 'lower-third' ? 'Name' : p.name
    tile.onclick = () => insertFromUi({ kind: 'text', id: p.id, text: words })
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-ah-source', JSON.stringify({ kind: 'text', id: p.id, text: words }))
      e.dataTransfer.effectAllowed = 'copy'
    })
    grid.appendChild(tile)
  }

  $('btnEditClip').onclick = () => {
    const item = state.selectedItem
    if (item?.type !== 'animation') return
    const i = state.project.clips.findIndex((c) => c.id === item.sourceId)
    if (i < 0) return status('that clip is gone', 'error')
    state.clipIndex = i
    renderClips()
    loadClipIntoUi()
    setMode('clip')
  }

  /**
   * Captions and titles become a real clip.
   *
   * This is the escape hatch that keeps the caption and text panels small: a
   * handful of controls cover the common case, and anything beyond them is
   * answered by turning the generated HTML and CSS into a clip you can edit
   * like any other. The item keeps its place on the timeline.
   */
  $('btnCaptionToClip').onclick = () => convertOverlayToClip(state.selectedItem)

  // Image items: size (blank = natural), corners, shadow.
  const imageField = (id, apply, event = 'change') =>
    $(id).addEventListener(event, () => {
      const item = state.selectedItem
      if (item?.type !== 'image') return
      apply(item, $(id).value, $(id).checked)
      markTimelineDirty(currentSequence())
      refreshSequence()
    })
  const setImageStyle = (key, parse) => (item, v, c) => {
    const val = parse(v, c)
    const st = { ...(item.imageStyle ?? {}) }
    if (val == null) delete st[key]
    else st[key] = val
    item.imageStyle = st
  }
  imageField('imgW', setImageStyle('width', (v) => (v.trim() ? Math.max(4, Math.min(8192, Math.round(Number(v)))) : null)))
  imageField('imgH', setImageStyle('height', (v) => (v.trim() ? Math.max(4, Math.min(8192, Math.round(Number(v)))) : null)))
  imageField('imgRadius', setImageStyle('radius', (v) => Math.max(0, Math.round(Number(v) || 0)) || null))
  imageField('imgShadow', setImageStyle('shadow', (_v, c) => (c ? true : null)))
  $('btnImageToClip').onclick = () => convertOverlayToClip(state.selectedItem)
}

function convertOverlayToClip(item) {
  const seq = currentSequence()
  if (!item || (item.type !== 'caption' && item.type !== 'text' && item.type !== 'image')) return
  const built = SEQ.overlayClipFor(item, seqContext())
  if (!built) return status('nothing to convert — the source is missing', 'error')

  const clip = {
    id: 'c_' + Math.random().toString(36).slice(2, 10),
    name: item.type === 'caption' ? `${item.name} (captions)` : item.type === 'image' ? `${item.name} (image)` : `${item.name} (title)`,
    html: built.html,
    css: built.css,
    js: '',
    // A caption clip is generated relative to the item's in-point; a text clip
    // spans in-point plus length, so the item's own in-point keeps meaning.
    durationMs: built.durationMs,
    width: built.width ?? seq.width,
    height: built.height ?? seq.height,
    fps: seq.fps,
    background: { mode: 'transparent', color: '#00b140' },
  }
  state.project.clips.push(clip)
  const wasCaption = item.type === 'caption'
  item.type = 'animation'
  item.sourceId = clip.id
  item.name = clip.name
  if (wasCaption) item.inMs = 0
  delete item.captionStyle
  delete item.imageStyle
  delete item.text
  delete item.subtext
  delete item.textStyle

  markDirty()
  markTimelineDirty(currentSequence())
  renderClips()
  refreshSequence()
  status(`"${clip.name}" is now an editable clip`)
}

/* --------------------------------------------------------- timeline panel */

function initSequenceInspector() {
  $('btnDupTimeline').addEventListener('click', async (e) => {
    try {
      const r = await editor.duplicateSequence({ deep: !!e.altKey })
      status(`"${r.copy.name}" is a copy of "${r.source.name}" — edits here leave the original alone`)
    } catch (err) {
      status(err.message, 'error')
    }
  })
  // Two clicks within three seconds, so a stray click deletes nothing.
  let armed = 0
  $('btnDelTimeline').addEventListener('click', async () => {
    const seq = currentSequence()
    if (!seq) return
    if (Date.now() - armed > 3000) {
      armed = Date.now()
      status(`click Delete again to remove "${seq.name}"`)
      return
    }
    armed = 0
    try {
      const gone = await editor.deleteSequence(seq.id)
      status(`deleted "${gone.name}"`)
    } catch (err) {
      status(err.message, 'error')
    }
  })
  const apply = (fn, { rebuild = true } = {}) => () => {
    const seq = currentSequence()
    if (!seq) return
    fn(seq)
    markTimelineDirty(currentSequence())
    if (rebuild) {
      refreshSequence()
      fitSeqStage()
    }
  }

  $('seqName').addEventListener('input', apply((s) => { s.name = $('seqName').value || s.name }, { rebuild: false }))
  $('seqFps').addEventListener('change', apply((s) => {
    s.fps = Math.min(120, Math.max(1, parseInt($('seqFps').value, 10) || 30))
    $('seqFps').value = String(s.fps)
  }))
  $('seqWidth').addEventListener('change', apply((s) => {
    s.width = Math.min(7680, Math.max(16, parseInt($('seqWidth').value, 10) || 1920))
    $('seqWidth').value = String(s.width)
  }))
  $('seqHeight').addEventListener('change', apply((s) => {
    s.height = Math.min(7680, Math.max(16, parseInt($('seqHeight').value, 10) || 1080))
    $('seqHeight').value = String(s.height)
  }))
  $('seqPreset').addEventListener('change', apply((s) => {
    const v = $('seqPreset').value
    if (!v) return
    const [w, h] = v.split('x').map(Number)
    s.width = w
    s.height = h
    $('seqWidth').value = String(w)
    $('seqHeight').value = String(h)
  }))
  $('seqBgMode').addEventListener('change', apply((s) => {
    s.background = { mode: $('seqBgMode').value, color: $('seqBgColor').value }
  }))
  $('seqBgColor').addEventListener('input', apply((s) => {
    s.background = { mode: 'color', color: $('seqBgColor').value }
    $('seqBgMode').value = 'color'
  }))
}

function loadSequenceIntoUi() {
  const seq = currentSequence()
  if (!seq) return
  $('seqName').value = seq.name
  $('seqFps').value = String(seq.fps)
  $('seqWidth').value = String(seq.width)
  $('seqHeight').value = String(seq.height)
  $('seqPreset').value = `${seq.width}x${seq.height}`
  $('seqBgMode').value = seq.background?.mode ?? 'color'
  $('seqBgColor').value = seq.background?.color ?? '#000000'
}

/* ------------------------------------------------------------- the render */

function setSeqExporting(on) {
  state.seqExporting = on
  $('btnRenderSeq').disabled = on
  $('btnSeqPlay').disabled = on
  $('seqProgressWrap').classList.toggle('hidden', !on)
  if (on) {
    $('seqResult').textContent = ''
    $('seqResult').classList.remove('error')
  }
}

function onSeqProgress(p) {
  $('seqProgressBar').style.width = `${Math.round((p.progress ?? 0) * 100)}%`
  const parts = []
  if (p.phase === 'overlays') {
    parts.push(p.label ?? 'rendering layers…')
    if (p.frame) parts.push(`frame ${p.frame}/${p.frameCount}`)
  } else if (p.phase === 'compositing') {
    parts.push(p.label ?? 'compositing…')
  } else if (p.phase === 'complete') {
    parts.push('done')
  }
  if (p.note) parts.push(p.note)
  $('seqProgressText').textContent = parts.join('  ·  ')
}

/**
 * Hand a browser-side render to the person who asked for it.
 *
 * With a server the file is written to disk and `downloadUrl` is a path
 * anything can fetch. With no server it is a `blob:` URL, which is a different
 * animal in two ways that both used to bite:
 *
 * It was never revoked, so every render pinned its own megabytes for the life
 * of the tab. At most one is kept alive now — the previous one goes as soon as
 * a new one arrives, which cannot cut short a download that has already begun.
 *
 * And it was only saved when a *person* pressed the button. An agent asked to
 * render got a blob URL it could not fetch, a file that went nowhere, and a
 * tab that would take the render with it when it closed. In a build with no
 * disk, the browser's downloads folder is the only place a file can land, so
 * that is where a render goes — whoever asked for it.
 */
const lastBlobUrl = new Map()

function saveFile(kind, url, filename) {
  // Revoking on a timer risks cutting short a download that has not started;
  // revoking immediately certainly does. Replacing the previous one of the
  // same kind bounds it at one blob per kind with neither risk.
  const prev = lastBlobUrl.get(kind)
  if (prev && prev !== url) URL.revokeObjectURL(prev)
  if (url?.startsWith('blob:')) lastBlobUrl.set(kind, url)
  else lastBlobUrl.delete(kind)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const saveRender = (r) => saveFile('render', r.downloadUrl, r.filename)

/** Render the open timeline. Resolves with the server's result; throws on failure. */
/**
 * Render one clip, through whichever back end this page has.
 *
 * The server encodes with ffmpeg and can write true alpha; the browser encodes
 * with WebCodecs and cannot. Everything else about the two is the same, which
 * is why the three call sites do not care which they got.
 */
async function exportClip({ host, clip, format, quality, onProgress, signal, download = true }) {
  if (!state.local) {
    return studioExport({ host, clip, format, quality, onProgress, signal, download })
  }
  const { exportClipLocal } = await import('/clientexport.js')
  const r = await exportClipLocal({ host, clip, onProgress, signal })
  if (r.flattened) {
    status(`"${clip.name}" was rendered over black — no browser writes alpha into MP4`, 'error')
  }
  saveRender(r)
  return r
}

async function runSequenceRender({ format, quality, overlayFormat, download, fromMs = null, toMs = null, output = 'both' }) {
  const seq = currentSequence()
  if (!seq) throw new Error('no timeline is open')
  if (state.seqExporting) throw new Error('a timeline render is already running')
  if (SEQ.sequenceDuration(seq) <= 0) throw new Error('nothing on the timeline to render')

  state.compositor?.pause()
  $('btnSeqPlay').textContent = '▶'
  const controller = new AbortController()
  state.seqAbort = controller
  setSeqExporting(true)

  try {
    // With no server there is no ffmpeg, so the browser does the whole render
    // itself — same compositor, same frames, encoded here instead of shipped.
    const r = state.local
      ? await (await import('/clientexport.js')).renderSequenceLocal({
          seq,
          compositor: state.compositor,
          media: state.lib.media,
          quality: quality ?? Number($('seqQuality').value),
          onProgress: onSeqProgress,
          signal: controller.signal,
          fromMs,
          toMs,
          output,
        })
      : await renderSequence({
      timelines: seqContext().timelines,
      assets: seqContext().assets,
      seq,
      clips: state.project.clips,
      transcripts: state.lib.transcripts,
      media: state.lib.media,
      format: format ?? $('seqFormat').value,
      quality: quality ?? Number($('seqQuality').value),
      overlayFormat: overlayFormat ?? $('seqOverlayFormat').value,
      onProgress: onSeqProgress,
      signal: controller.signal,
      fromMs,
      toMs,
      output,
    })
    // Kept for the browser console and for tests: the last render, as a blob.
    if (r.blob) window.__lastRender = { filename: r.filename, blob: r.blob }
    $('seqResult').textContent =
      `${r.filename}\n${formatBytes(r.size)} · ${(r.durationMs / 1000).toFixed(1)}s · ` +
      `${r.layers} layer${r.layers === 1 ? '' : 's'}, ${r.audio} audio · ${(r.elapsedMs / 1000).toFixed(1)}s`
    // With a server, `download` is a choice: the file is on disk either way.
    // With none it is not — see saveRender().
    if (download || state.local) saveRender(r)
    return r
  } finally {
    setSeqExporting(false)
    state.seqAbort = null
  }
}

async function doRenderSequence() {
  if (state.seqExporting) return
  try {
    await runSequenceRender({ download: true })
  } catch (err) {
    if (err.name === 'AbortError') return
    $('seqResult').textContent = String(err.message ?? err)
    $('seqResult').classList.add('error')
  }
}

/* ------------------------------------------------------------ export parts */

function openPartsDialog(preselected = []) {
  const seq = currentSequence()
  if (!seq) return
  const list = $('partsList')
  list.innerHTML = ''
  const picked = new Set(preselected.map((i) => i.id))
  const bound = new Map((state.lib.transcriptList ?? []).map((t) => [t.mediaFilename, t]))

  for (const track of seq.tracks) {
    if (!track.items.length) continue
    const head = document.createElement('div')
    head.className = 'parts-track'
    head.textContent = track.name
    list.appendChild(head)
    for (const item of track.items) {
      const row = document.createElement('label')
      row.className = 'parts-row'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.dataset.item = item.id
      cb.checked = picked.has(item.id)
      row.appendChild(cb)
      const name = document.createElement('span')
      name.className = 'parts-name'
      name.textContent = item.name
      row.appendChild(name)
      const meta = document.createElement('span')
      meta.className = 'parts-meta'
      const m = item.type === 'media' ? state.lib.media.get(item.sourceId) : null
      const kind =
        item.type === 'media'
          ? track.kind === 'audio' || !m?.hasVideo ? 'sound' : m?.hasAudio ? 'picture + sound' : 'picture'
          : item.type === 'caption' ? 'captions' : item.type === 'text' ? 'title' : 'animation'
      const words = (item.type === 'media' && bound.has(item.sourceId)) || item.type === 'caption' ? ' · words' : ''
      meta.textContent = `${kind}${words} · ${(item.durationMs / 1000).toFixed(1)}s`
      row.appendChild(meta)
      list.appendChild(row)
    }
  }
  if (!list.children.length) return status('the timeline is empty', 'error')

  const dur = SEQ.sequenceDuration(seq)
  $('partsRangeOn').checked = false
  $('partsFrom').value = '0.00'
  $('partsTo').value = (dur / 1000).toFixed(2)
  $('partsResult').innerHTML = ''
  $('partsProgress').textContent = ''
  $('dlgParts').showModal()
}

function initPartsDialog() {
  $('btnParts').onclick = () => openPartsDialog(state.selectedItems ?? [])
  $('btnMultiExport').onclick = () => openPartsDialog(state.selectedItems ?? [])
  $('btnPartsClose').onclick = () => $('dlgParts').close()
  $('btnPartsAll').onclick = () => $('partsList').querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = true })
  $('btnPartsNone').onclick = () => $('partsList').querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false })

  $('btnPartsRun').onclick = async () => {
    const btn = $('btnPartsRun')
    const itemIds = [...$('partsList').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.dataset.item)
    const range = $('partsRangeOn').checked
      ? {
          fromMs: Math.round(parseFloat($('partsFrom').value) * 1000) || 0,
          toMs: Math.round(parseFloat($('partsTo').value) * 1000) || 0,
          output: $('partsRangeOutput').value,
        }
      : null
    if (!itemIds.length && !range) return status('tick some items, or a range of the mix', 'error')
    btn.disabled = true
    $('partsResult').innerHTML = ''
    $('partsResult').classList.remove('error')
    try {
      const r = await editor.exportParts({
        itemIds,
        range,
        what: $('partsWhat').value === 'auto' ? null : $('partsWhat').value,
        audioFormat: $('partsAudioFmt').value,
        videoFormat: $('partsVideoFmt').value,
        transcript: $('partsWords').checked,
        zip: $('partsZip').checked,
        onProgress: (p) => {
          $('partsProgress').textContent = [p.label, p.frame ? `frame ${p.frame}/${p.frameCount}` : null].filter(Boolean).join(' · ')
        },
      })
      const out = $('partsResult')
      for (const f of r.files) {
        const a = document.createElement('a')
        a.href = f.url
        a.download = f.name
        a.textContent = `${f.name} · ${formatBytes(f.size)}`
        out.appendChild(a)
      }
      if (r.zip) {
        const a = document.createElement('a')
        a.href = r.zip.url
        a.download = r.zip.name
        a.className = 'zip'
        a.textContent = `${r.zip.name} · ${formatBytes(r.zip.size)} — everything above, in one file`
        out.appendChild(a)
        a.click()
      }
      for (const e of r.errors ?? []) {
        const p = document.createElement('div')
        p.className = 'err'
        p.textContent = e
        out.appendChild(p)
      }
      $('partsProgress').textContent = `${r.files.length} file${r.files.length === 1 ? '' : 's'} in data/exports`
    } catch (err) {
      if (err.name !== 'AbortError') {
        $('partsResult').textContent = String(err?.message ?? err)
        $('partsResult').classList.add('error')
      }
      $('partsProgress').textContent = ''
    } finally {
      btn.disabled = false
    }
  }
}

/* ------------------------------------------------------- frames & sprites */

/** The footage under the playhead: the topmost visible media item with picture. */
function footageAt(ms) {
  const seq = currentSequence()
  if (!seq) return null
  for (const track of SEQ.videoTracks(seq)) {
    if (track.hidden) continue
    const item = SEQ.itemAt(track, ms)
    if (!item || item.type !== 'media') continue
    const m = state.lib.media.get(item.sourceId)
    if (m?.hasVideo) return { item, media: m, sourceMs: SEQ.sourceTimeAt(item, ms) }
  }
  return null
}

async function extractRequest(filename, body) {
  const res = await fetch(`/api/media/${encodeURIComponent(filename)}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await res.json()
  if (!res.ok) throw new Error(out.error ?? `extract failed (${res.status})`)
  return out
}

function initFrameTools() {
  const menu = $('frameMenu')
  $('btnFrame').onclick = (e) => {
    e.stopPropagation()
    menu.classList.toggle('hidden')
  }
  window.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu-wrap')) menu.classList.add('hidden')
  })
  menu.querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      menu.classList.add('hidden')
      try {
        if (b.dataset.act === 'footage') {
          const r = await editor.saveFrame({ source: 'footage' })
          status(`saved ${r.name} to Assets`)
        } else if (b.dataset.act === 'composite') {
          const r = await editor.saveFrame({ source: 'composite' })
          status(`saved ${r.name} to Assets`)
        } else {
          openExtractDialog()
        }
      } catch (err) {
        status(err?.message ?? String(err), 'error')
      }
    }
  })

  const modeRows = () => {
    const mode = $('exMode').value
    $('exRowCount').classList.toggle('hidden', mode !== 'frames')
    $('exRowFps').classList.toggle('hidden', mode !== 'sprite')
    $('exRowWidth').classList.toggle('hidden', mode === 'subclip')
    $('exRowPng').classList.toggle('hidden', mode === 'subclip')
  }
  $('exMode').addEventListener('change', modeRows)
  $('btnExtractClose').onclick = () => $('dlgExtract').close()
  $('btnExtractRun').onclick = async () => {
    const btn = $('btnExtractRun')
    btn.disabled = true
    $('exResult').textContent = 'working…'
    $('exResult').classList.remove('error')
    try {
      const mode = $('exMode').value
      const r = await editor.extract({
        media: $('exSource').value,
        mode,
        fromMs: Math.round(parseFloat($('exFrom').value) * 1000) || 0,
        toMs: Math.round(parseFloat($('exTo').value) * 1000) || 0,
        count: parseInt($('exCount').value, 10) || 6,
        fps: parseInt($('exFps').value, 10) || 10,
        width: parseInt($('exWidth').value, 10) || 320,
        format: $('exPng').checked ? 'png' : 'jpg',
      })
      $('exResult').textContent =
        mode === 'frames'
          ? `${r.assets.length} frame(s) added to Assets`
          : mode === 'sprite'
            ? `${r.asset.name}: ${r.asset.sprite.frames} frames, ${r.asset.sprite.cols}×${r.asset.sprite.rows} grid, ${formatBytes(r.asset.size)} — open it in Assets and “Insert as animated sprite”`
            : `${r.name} added to Media (${(r.durationMs / 1000).toFixed(2)}s)`
      setRail(mode === 'subclip' ? 'media' : 'assets')
    } catch (err) {
      $('exResult').textContent = String(err?.message ?? err)
      $('exResult').classList.add('error')
    } finally {
      btn.disabled = false
    }
  }
  modeRows()
}

function openExtractDialog() {
  const sel = $('exSource')
  sel.innerHTML = ''
  const onTimeline = new Set()
  for (const { item } of SEQ.allItems(currentSequence() ?? { tracks: [] })) if (item.type === 'media') onTimeline.add(item.sourceId)
  for (const m of state.lib.media.values()) {
    if (!m.hasVideo) continue
    const o = document.createElement('option')
    o.value = m.filename
    o.textContent = (onTimeline.has(m.filename) ? '● ' : '') + m.name
    sel.appendChild(o)
  }
  if (!sel.options.length) return status('no footage in the library', 'error')

  // Default to the selected item's own range, in source time.
  const item = state.selectedItem
  const m = item?.type === 'media' ? state.lib.media.get(item.sourceId) : null
  if (m?.hasVideo) {
    sel.value = m.filename
    $('exFrom').value = (item.inMs / 1000).toFixed(2)
    $('exTo').value = ((item.inMs + item.durationMs) / 1000).toFixed(2)
  } else {
    const under = footageAt(state.compositor?.time ?? 0)
    if (under) sel.value = under.media.filename
    const chosen = state.lib.media.get(sel.value)
    $('exFrom').value = '0.00'
    $('exTo').value = ((Math.min(chosen?.durationMs ?? 5000, 5000)) / 1000).toFixed(2)
  }
  $('exResult').textContent = ''
  $('dlgExtract').showModal()
}

/* -------------------------------------------------------------- the wiring */

function initSequenceMode() {
  state.compositor = createCompositor({
    container: $('seqStage'),
    getContext: seqContext,
    onTime: (ms) => {
      state.timeline?.setPlayhead(ms)
      updateSeqClock(ms)
      highlightCueRow(ms)
      state.transcriptEditor?.tick()
      if (state.compositor?.playing) {
        state.timeline?.followPlayhead()
        previewHealthTick()
      } else {
        // Scrubbing moves what an overlay paints, so the rectangle round it
        // has to follow. Measuring it every frame of *playback* would not pay
        // for itself, which is why the handles stand down while it runs.
        state.stageTools?.render()
        // A diamond means "there is a key on this frame", so it has to change
        // as the frame does. Only worth redrawing when there are any.
        if (state.selectedItem && KEYS.anyKeyed(state.selectedItem)) {
          renderKeyInspector(state.selectedItem, { placeable: true, hasPicture: true })
          updatePlacementFields()
        }
      }
    },
    onEnd: () => {
      $('btnSeqPlay').textContent = '▶'
      state.stageTools?.suppress(false)
    },
    onPause: () => {
      previewHealthSummary()
      state.stageTools?.suppress(false)
    },
  })

  /**
   * Handles over the preview.
   *
   * The compositor owns the geometry — it is the thing that has to agree with
   * the filtergraph — so the tools ask it where an item is and hand back the
   * fields to change. Everything a drag writes is an ordinary item edit: it
   * lands on the undo stack, saves with the timeline and reads back in the
   * inspector like anything typed there.
   */
  state.stageTools = createStageTools({
    root: $('stageOverlay'),
    getContext: seqContext,
    // Measured, not remembered: the handles are drawn over the stage and must
    // agree with wherever it actually ended up.
    getScale: () => {
      const seq = currentSequence()
      const w = $('seqStageWrap').clientWidth
      return seq && w ? w / seq.width : 1
    },
    getTime: () => state.compositor?.time ?? 0,
    // Resolved against the live document every time: an undo replaces the whole
    // timeline, so the objects the panel is holding can be a generation stale.
    getSelection: () => {
      const seq = currentSequence()
      if (!seq) return []
      return (state.selectedItems ?? []).map((i) => SEQ.findItem(seq, i.id)?.item).filter(Boolean)
    },
    isLocked: (track) => !!track?.locked,
    boxOf: (id) => state.compositor?.boxOf(id) ?? null,
    reposition: (id) => state.compositor?.reposition(id),
    preview: (id, t) => state.compositor?.previewTransform(id, t),
    onSelect: (item, { open = false } = {}) => {
      state.timeline.select(item?.id ?? null)
      selectItem(item)
      if (open) focusItemFields(item)
    },
    // Mid-drag the item is already changed; only the fields the drag writes
    // have to catch up. A full inspector render per pointer event would rebuild
    // the cue list of a caption forty times a second.
    onLive: () => updatePlacementFields(),
    isCropping: () => state.cropMode,
    onCommit: (props = ['offsetX', 'offsetY', 'scale']) => {
      // Same rule as the panel: moving something that is keyed puts a key here
      // rather than quietly overwriting the whole move.
      for (const p of props) noteKeyedEdit(state.selectedItem, p)
      markTimelineDirty(currentSequence())
      refreshSequence()
    },
    onStatus: (msg) => status(msg),
  })

  state.timeline = createTimeline({
    onOpen: (item) => openNested(item.sourceId).catch((err) => status(err.message, 'error')),
    onContext: (info) => timelineMenu(info),
    root: $('seqTimeline'),
    getContext: seqContext,
    onSeek: (ms) => {
      state.compositor.pause()
      $('btnSeqPlay').textContent = '▶'
      state.compositor.seekTo(ms)
    },
    onSelect: (items) => selectItems(items),
    onSelectTrack: (track) => selectTrack(track),
    onChange: (evt = {}) => {
      if (evt.drop) {
        insertFromUi(evt.drop, { trackId: evt.trackId, atMs: evt.atMs })
        return
      }
      if (evt.reorderTrack) {
        moveTrack(evt.reorderTrack.trackId, evt.reorderTrack.to ?? evt.reorderTrack.index)
        return
      }
      markTimelineDirty(currentSequence())
      refreshSequence()
    },
  })

  $('btnSeqPlay').onclick = () => {
    state.compositor.toggle()
    $('btnSeqPlay').textContent = state.compositor.playing ? '❚❚' : '▶'
    state.stageTools?.suppress(state.compositor.playing)
  }
  $('btnZoomIn').onclick = () => state.timeline.zoom(1.5)
  $('btnZoomOut').onclick = () => state.timeline.zoom(1 / 1.5)
  $('btnZoomFit').onclick = () => state.timeline.zoomToFit()

  $('btnSplit').onclick = () => {
    const n = state.timeline.splitSelectedAt(state.compositor.time)
    if (!n) return status('put the playhead inside a selected item to split it', 'error')
    markTimelineDirty(currentSequence())
    refreshSequence()
  }
  $('btnMultiDelete').onclick = () => $('btnDeleteItem').click()
  $('btnMultiRipple').onclick = () => $('btnRipple').click()
  $('btnMultiDetach').onclick = async () => {
    const seq = currentSequence()
    let n = 0
    for (const item of [...state.selectedItems]) {
      const m = state.lib.media.get(item.sourceId)
      const track = seq.tracks.find((t) => t.items.includes(item))
      if (item.type !== 'media' || !m?.hasVideo || !m?.hasAudio || track?.kind !== 'video') continue
      try {
        SEQ.detachAudio(seq, item.id, m)
        n++
      } catch {
        /* skip the ones that cannot */
      }
    }
    if (!n) return status('nothing selected has sound to detach', 'error')
    markTimelineDirty(currentSequence())
    refreshSequence()
    status(`detached the sound of ${n} item${n === 1 ? '' : 's'}`)
  }
  $('btnDeleteItem').onclick = () => {
    if (!state.timeline.deleteSelected()) return
    markTimelineDirty(currentSequence())
    refreshSequence()
  }
  $('btnRipple').onclick = () => {
    if (!state.timeline.deleteSelected({ ripple: true })) return
    markTimelineDirty(currentSequence())
    refreshSequence()
  }
  $('btnAddTrack').onclick = () => {
    const seq = currentSequence()
    const videoCount = SEQ.videoTracks(seq).length
    const audioCount = SEQ.audioTracks(seq).length
    // Video stacks upward from the top of the list, audio downward from the end.
    if (videoCount <= audioCount + 1) {
      seq.tracks.unshift(SEQ.makeTrack('video', `V${videoCount + 1}`))
    } else {
      seq.tracks.push(SEQ.makeTrack('audio', `A${audioCount + 1}`))
    }
    markTimelineDirty(currentSequence())
    refreshSequence()
  }

  initFrameTools()
  initPartsDialog()
  initCueEditor()

  $('btnRenderSeq').onclick = doRenderSequence
  $('btnSeqCancel').onclick = () => state.seqAbort?.abort()

  $('seqQuality').addEventListener('input', () => {
    $('seqQualityVal').textContent = $('seqQuality').value
  })
  $('seqFormat').addEventListener('change', updateSeqFormatNote)

  initSequenceInspector()
  initItemInspector()
  initTrackInspector()
  initSilenceTools()

  $('btnUndo').onclick = () => undoSequence()
  $('btnRedo').onclick = () => redoSequence()

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.onclick = () => setMode(b.dataset.setmode)
  })
  document.querySelectorAll('.rail-tab').forEach((t) => {
    t.onclick = () => {
      state.railTouched = true
      setRail(t.dataset.rail)
    }
  })
  $('btnNewSub').addEventListener('click', () => newSubTimeline().catch((err) => status(err.message, 'error')))
  $('btnMultiGroup').addEventListener('click', async () => {
    try {
      const r = await editor.nestItems({})
      status(`grouped ${r.members} item(s) into "${r.child.name}" — double-click the block to open it`)
    } catch (err) {
      status(err.message, 'error')
    }
  })

  // Clips are a drag source for the timeline too.
  $('clipList').addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.clip-item')
    if (!li) return
    const i = [...$('clipList').children].indexOf(li)
    const clip = state.project?.clips[i]
    if (!clip) return
    e.dataTransfer.setData('application/x-ah-source', JSON.stringify({ kind: 'clip', id: clip.id }))
    e.dataTransfer.effectAllowed = 'copy'
  })

  $('btnToSequence').onclick = () => {
    const clip = currentClip()
    if (!clip) return
    insertFromUi({ kind: 'clip', id: clip.id })
  }
}

/** Offer only intermediates whose alpha this ffmpeg was seen to produce. */
function renderOverlayFormats(health) {
  const sel = $('seqOverlayFormat')
  const options = [
    { id: 'qtrle', label: 'QuickTime Animation — lossless, small' },
    { id: 'mov', label: 'ProRes 4444 — 10-bit, very large' },
    { id: 'webm', label: 'WebM VP9 — smallest' },
  ]
  sel.innerHTML = ''
  const usable = options.filter((o) => health.alphaSupport?.[o.id])
  for (const o of usable.length ? usable : options) {
    const el = document.createElement('option')
    el.value = o.id
    el.textContent = o.label
    sel.appendChild(el)
  }
  const saved = localStorage.getItem('animationhtml:overlayFormat')
  sel.value = usable.some((o) => o.id === saved) ? saved : (usable[0]?.id ?? 'qtrle')

  const dropped = options.filter((o) => !health.alphaSupport?.[o.id]).map((o) => o.id)
  setTip(
    sel,
    'Animation and caption layers are rendered to this format first, then composited by ffmpeg.\n' +
      'It must carry a real alpha channel, or the layer becomes an opaque rectangle.' +
      (dropped.length ? `\n\nNot offered on this ffmpeg — it drops the alpha plane: ${dropped.join(', ')}.` : ''),
  )
  sel.onchange = () => localStorage.setItem('animationhtml:overlayFormat', sel.value)
}

async function initSequenceFormats() {
  try {
    const formats = await fetch('/api/timeline-formats').then((r) => r.json())
    const sel = $('seqFormat')
    sel.innerHTML = ''
    for (const f of formats) {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label + (f.alpha ? ' · alpha' : '')
      sel.appendChild(o)
    }
    state.seqFormats = formats
    const remembered = localStorage.getItem('animationhtml:seqFormat')
    sel.value = formats.some((f) => f.id === remembered) ? remembered : (formats[0]?.id ?? '')
    updateSeqFormatNote()
  } catch {
    /* the health check already tells the user ffmpeg is missing */
  }
}

function updateSeqFormatNote() {
  const f = (state.seqFormats ?? []).find((x) => x.id === $('seqFormat').value)
  $('seqFormatNote').textContent = f?.note ?? ''
  localStorage.setItem('animationhtml:seqFormat', f?.id ?? 'mp4')
}

/* ------------------------------------------------------- timeline keyboard */

window.addEventListener('keydown', async (e) => {
  if (state.mode !== 'seq') return
  if (isTyping(e.target) || e.target?.closest?.('dialog')) return
  if (state.seqExporting) return

  const seq = currentSequence()
  if (!seq) return
  const frame = 1000 / seq.fps
  const now = state.compositor.time
  const mod = e.metaKey || e.ctrlKey

  if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.selectedTrack) {
    e.preventDefault()
    const up = e.key === 'ArrowUp'
    moveTrack(state.selectedTrack, e.shiftKey ? (up ? 'top' : 'bottom') : up ? 'up' : 'down')
    return
  }
  if (mod && e.key === 'ArrowUp' && state.mode === 'seq') {
    e.preventDefault()
    goUp()
    return
  }
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    ;(e.shiftKey ? redoSequence : undoSequence)()
    return
  }
  if (mod && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault()
    state.timeline.selectAll()
    return
  }
  if (mod && !e.shiftKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySelectedItems(); return }
  if (mod && !e.shiftKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); copySelectedItems({ cut: true }); return }
  if (mod && !e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteItems(); return }
  if (mod && !e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelectedItems(); return }
  if (mod && (e.key === ']' || e.key === '[')) {
    e.preventDefault()
    restackItem(e.key === ']' ? (e.shiftKey ? 'front' : 'up') : e.shiftKey ? 'back' : 'down')
    return
  }
  if (!mod && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault()
    if (e.shiftKey) jumpToMarker(1)
    else if (e.altKey) jumpToMarker(-1)
    else addMarker()
    return
  }
  if (!mod && !e.altKey && (e.key === 'c' || e.key === 'C') && state.selectedItem) {
    e.preventDefault()
    setCropMode(!state.cropMode)
    return
  }
  if (e.key === 'Escape' && state.cropMode) {
    e.preventDefault()
    setCropMode(false)
    return
  }

  if (e.altKey && !mod && state.selectedItem && e.key.startsWith('Arrow')) {
    // ⌥ arrows place the selected item; the bare arrows still step the
    // playhead, and ⌥↑/↓ still reorders a track when a *track* is selected.
    const step = e.shiftKey ? 10 : 1
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (d && state.stageTools?.nudge(d[0], d[1])) {
      e.preventDefault()
      markTimelineDirty(seq)
      refreshSequence()
      return
    }
  }

  if (e.key === ' ') {
    e.preventDefault()
    state.compositor.toggle()
    $('btnSeqPlay').textContent = state.compositor.playing ? '❚❚' : '▶'
    state.stageTools?.suppress(state.compositor.playing)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    state.compositor.seekTo(now + (e.shiftKey ? 1000 : frame))
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    state.compositor.seekTo(Math.max(0, now - (e.shiftKey ? 1000 : frame)))
  } else if (e.key === 'Home') {
    e.preventDefault()
    state.compositor.seekTo(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    state.compositor.seekTo(SEQ.sequenceDuration(seq))
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault()
    $('btnSplit').click()
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault()
    ;(e.shiftKey ? $('btnRipple') : $('btnDeleteItem')).click()
  }
})


/* ================================================================ panels */
/*
 * The rail and the inspector can be hidden, brought back, and dragged to a
 * width. On a wide window they are grid columns; below 900px the stylesheet
 * turns them into drawers over the stage, and the same buttons open and close
 * those instead. Widths and the shown/hidden state are remembered per browser.
 */

const PANEL_KEY = 'animationhtml:panels'
const PANEL_DEFAULTS = { rail: true, insp: true, railW: 216, inspW: 300 }
const panels = { ...PANEL_DEFAULTS }
const drawerMode = window.matchMedia('(max-width: 900px)')

function loadPanels() {
  try {
    Object.assign(panels, JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}'))
  } catch {
    /* a bad value just means defaults */
  }
  panels.railW = Math.max(150, Math.min(520, Number(panels.railW) || PANEL_DEFAULTS.railW))
  panels.inspW = Math.max(220, Math.min(640, Number(panels.inspW) || PANEL_DEFAULTS.inspW))
}

function savePanels() {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panels))
  } catch {
    /* private mode */
  }
}

/** Re-fit the stage and redraw the timeline after the layout settles. */
let layoutRaf = 0
function afterLayout() {
  cancelAnimationFrame(layoutRaf)
  layoutRaf = requestAnimationFrame(() => {
    fitStage()
    if (state.mode === 'seq') {
      state.timeline?.render()
      state.timeline?.repaintWaveforms()
    }
  })
}

function applyPanels() {
  const root = document.documentElement
  root.style.setProperty('--rail', `${panels.railW}px`)
  root.style.setProperty('--insp', `${panels.inspW}px`)
  const body = document.body
  if (drawerMode.matches) {
    // Drawers: the persisted state is not applied; they open on demand.
    body.classList.remove('rail-off', 'insp-off')
  } else {
    body.classList.remove('rail-open', 'insp-open')
    body.classList.toggle('rail-off', !panels.rail)
    body.classList.toggle('insp-off', !panels.insp)
  }
  const railOn = drawerMode.matches ? body.classList.contains('rail-open') : panels.rail
  const inspOn = drawerMode.matches ? body.classList.contains('insp-open') : panels.insp
  $('btnRailToggle').classList.toggle('on', railOn)
  $('btnInspToggle').classList.toggle('on', inspOn)
  setTip($('btnRailToggle'), `${railOn ? 'Hide' : 'Show'} the left rail — timelines, clips, media, text and assets.`, { key: '[', at: 'bottom' })
  setTip($('btnInspToggle'), `${inspOn ? 'Hide' : 'Show'} the inspector on the right.`, { key: ']', at: 'bottom' })
  savePanels()
  afterLayout()
}

function togglePanel(which, force) {
  const body = document.body
  if (drawerMode.matches) {
    const cls = which === 'rail' ? 'rail-open' : 'insp-open'
    const other = which === 'rail' ? 'insp-open' : 'rail-open'
    const open = force ?? !body.classList.contains(cls)
    body.classList.toggle(cls, open)
    if (open) body.classList.remove(other) // one drawer at a time on a small screen
  } else {
    panels[which] = force ?? !panels[which]
  }
  applyPanels()
}

function closeDrawers() {
  if (!drawerMode.matches) return
  document.body.classList.remove('rail-open', 'insp-open')
  applyPanels()
}

/** Dragging the edge between a side panel and the centre resizes that panel. */
function initColumnResize(handle, which) {
  const app = document.querySelector('.app')
  const min = which === 'rail' ? 150 : 220
  const max = which === 'rail' ? 520 : 640
  const key = which === 'rail' ? 'railW' : 'inspW'
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* a pointer that cannot be captured still drags while it stays over the handle */
    }
    handle.classList.add('dragging')
    document.body.classList.add('col-dragging')
    const rect = app.getBoundingClientRect()
    let width = panels[key]
    const move = (ev) => {
      const raw = which === 'rail' ? ev.clientX - rect.left : rect.right - ev.clientX
      width = Math.round(Math.max(min, Math.min(max, raw)))
      handle.dataset.shut = raw < min - 40 ? '1' : ''
      document.documentElement.style.setProperty(`--${which === 'rail' ? 'rail' : 'insp'}`, `${width}px`)
      afterLayout()
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      handle.classList.remove('dragging')
      document.body.classList.remove('col-dragging')
      if (handle.dataset.shut) {
        // Dragged past the minimum: the panel closes and keeps its old width
        // for when it comes back.
        handle.dataset.shut = ''
        panels[which] = false
      } else {
        panels[key] = width
      }
      applyPanels()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
  handle.addEventListener('dblclick', () => {
    panels[key] = PANEL_DEFAULTS[key]
    applyPanels()
  })
}

function initPanels() {
  loadPanels()
  $('btnRailToggle').onclick = () => togglePanel('rail')
  $('btnInspToggle').onclick = () => togglePanel('insp')
  $('edgeRail').onclick = () => togglePanel('rail', true)
  $('edgeInsp').onclick = () => togglePanel('insp', true)
  $('drawerBackdrop').onclick = closeDrawers
  initColumnResize($('railResize'), 'rail')
  initColumnResize($('inspResize'), 'insp')
  drawerMode.addEventListener('change', applyPanels)

  // Anything that changes the centre's size — a panel, the window, the code
  // panel, a drawer — refits the stage and the lanes.
  const ro = new ResizeObserver(() => afterLayout())
  ro.observe($('stageArea'))
  ro.observe(document.querySelector('.centre'))

  // A drawer is for one thing at a time: picking something in it closes it.
  document.querySelector('.rail').addEventListener('click', (e) => {
    if (!drawerMode.matches) return
    if (e.target.closest('.clip-item, .tl-row, .media-tile, .tr-row, .asset, .title-tile')) closeDrawers()
  })

  applyPanels()
}

/* ========================================================== context menus */
/*
 * Right-click builds a menu for whatever is under the pointer. Every entry
 * calls the same function a button or a tool would, so the menu can never do
 * something the rest of the editor cannot. Where nothing has a menu — inputs,
 * the code editor, plain text — the browser's own menu stays, because copy and
 * paste live there.
 */

const atClock = (ms) => fmtClock(Math.max(0, ms))

const withStatus = (fn) => () => Promise.resolve(fn()).catch((err) => status(err?.message ?? String(err), 'error'))

const copyText = (text, what = 'copied') =>
  navigator.clipboard.writeText(text).then(() => status(`${what}: ${text}`)).catch(() => status('clipboard is not available here', 'error'))

/** Open the inspector if it is hidden, then focus a field in it. */
function focusInspector(id) {
  if (drawerMode.matches) togglePanel('insp', true)
  else if (!panels.insp) togglePanel('insp', true)
  requestAnimationFrame(() => {
    const el = $(id)
    el?.focus()
    el?.select?.()
  })
}

function zoomItems() {
  return [
    { heading: 'Preview' },
    { label: 'Fit to panel', checked: state.zoom === 'fit', run: () => document.querySelector('.zoom-btn[data-zoom="fit"]').click() },
    { label: '50 %', checked: state.zoom === 0.5, run: () => document.querySelector('.zoom-btn[data-zoom="0.5"]').click() },
    { label: '100 %', checked: state.zoom === 1, run: () => document.querySelector('.zoom-btn[data-zoom="1"]').click() },
  ]
}

function stageMenu(e) {
  const items = []
  if (state.mode === 'seq') {
    const seq = currentSequence()
    if (!seq) return
    const playing = state.compositor?.playing
    items.push(
      { label: playing ? 'Pause' : 'Play', key: 'Space', run: () => $('btnSeqPlay').click() },
      { label: 'Go to start', key: 'Home', run: () => state.compositor.seekTo(0) },
      '-',
      { heading: `Frame at ${atClock(state.compositor.time)}` },
      { label: 'Footage frame → Assets', hint: 'The raw footage under the playhead, without overlays.', run: withStatus(async () => status(`saved ${(await editor.saveFrame({ source: 'footage' })).name} to Assets`)) },
      { label: 'Composited frame → Assets', hint: 'Everything the preview shows at this instant.', run: withStatus(async () => status(`saved ${(await editor.saveFrame({ source: 'composite' })).name} to Assets`)) },
      { label: 'Extract frames, sprites, sub-clips…', run: () => openExtractDialog() },
      '-',
      ...zoomItems(),
      '-',
      { label: 'Render timeline…', key: '⌘E', run: () => $('btnRenderSeq').click() },
    )
    showContextMenu(e.clientX, e.clientY, items, { title: seq.name })
    return
  }
  const clip = currentClip()
  if (!clip) return
  items.push(
    { label: state.playing ? 'Pause' : 'Play', key: 'Space', run: () => togglePlay() },
    { label: 'Go to start', key: 'Home', run: withStatus(() => seekTo(0)) },
    '-',
    { label: 'Save this frame → Assets', hint: 'A PNG of the stage at the playhead, kept with the project assets.', run: withStatus(async () => {
      const r = await editor.captureFrame(clip.id, state.iframe?.contentWindow?.__stage?.time ?? 0)
      status(`saved ${r.name ?? 'frame'} to Assets`)
      await state.assets?.refresh()
    }) },
    '-',
    ...zoomItems(),
    '-',
    { label: 'Add to timeline at playhead', run: () => $('btnToSequence').click() },
    { label: 'Studio export…', key: '⌘E', disabled: $('btnStudio').disabled, run: () => $('btnStudio').click() },
    { label: $('codePanel').classList.contains('collapsed') ? 'Expand code panel' : 'Collapse code panel', key: '⌘\\', run: () => toggleCode() },
  )
  showContextMenu(e.clientX, e.clientY, items, { title: clip.name })
}

function timelineMenu(info) {
  const seq = currentSequence()
  if (!seq) return
  const { kind, item, track, atMs, x, y, selected, markerId } = info
  const items = []

  if (markerId) {
    const m = (seq.markers ?? []).find((k) => k.id === markerId)
    if (m) {
      showContextMenu(x, y, [
        { heading: `${m.label || 'Marker'} · ${atClock(m.ms)}` },
        { label: 'Go to it', run: () => { state.compositor.pause(); state.compositor.seekTo(m.ms) } },
        { label: 'Rename…', run: () => renameMarker(m) },
        '-',
        { label: 'Delete marker', run: () => removeMarker(m.id) },
      ], { title: 'Marker' })
      return
    }
  }

  if (kind === 'item' && item) {
    const many = selected.length > 1
    const media = item.type === 'media' ? state.lib.media.get(item.sourceId) : null
    const hasSound = (item.type === 'media' && media?.hasAudio) || item.type === 'timeline'
    const inside = atMs > item.startMs && atMs < SEQ.itemEnd(item)
    items.push(
      { label: many ? `Split ${selected.length} items at playhead` : 'Split at playhead', key: 'S', run: () => $('btnSplit').click() },
      { label: `Split here (${atClock(atMs)})`, disabled: !inside, run: withStatus(() => editor.splitItem(item.id, atMs)) },
      '-',
      { label: many ? `Delete ${selected.length} items` : 'Delete', key: '⌫', run: () => $('btnDeleteItem').click() },
      { label: 'Ripple delete', key: '⇧⌫', hint: 'Remove and close the gap; every unlocked track follows.', run: () => $('btnRipple').click() },
      '-',
    )
    if (item.type === 'timeline') {
      items.push(
        { label: 'Open timeline →', hint: 'Edit the section on its own. Edits there show up here.', run: withStatus(() => openNested(item.sourceId)) },
        { label: 'Flatten', hint: 'Replace the block with the items inside it.', run: withStatus(async () => {
          const r = await editor.flattenItem(item.id)
          status(r.message)
        }) },
      )
    }
    items.push({ label: many ? `Group ${selected.length} items into a sub-timeline` : 'Group into a sub-timeline', run: withStatus(async () => {
      const r = await editor.nestItems({ itemIds: selected.map((i) => i.id) })
      status(`grouped ${r.members} item(s) into "${r.child.name}" — double-click the block to open it`)
    }) })
    if (item.type === 'animation') items.push({ label: 'Edit this clip →', run: () => $('btnEditClip').click() })
    if (item.type === 'caption') items.push(
      { label: 'Edit captions…', hint: 'This item\'s lines in the transcript editor, timed as on the timeline.', run: () => openTranscriptEditor(item.sourceId, item) },
      { label: 'Export captions…', hint: 'SRT, VTT or plain text of this item, timed as on the timeline.', run: () => openCaptionsDialog({ scope: 'item', item }) },
    )
    if (item.type === 'text' || item.type === 'caption') items.push({ label: 'Convert to animation clip', hint: 'A normal clip with HTML and CSS you can change.', run: () => convertOverlayToClip(item) })
    if (item.type === 'media' || item.type === 'timeline' || item.type === 'animation') {
      items.push({ label: 'Freeze this frame', hint: 'Hold the frame under the playhead as a still, placed on the timeline.', disabled: !inside, run: () => { state.compositor.seekTo(atMs); freezeFrame() } })
    }
    items.push({ label: 'Cross dissolve into the next item', hint: 'Overlap the two and fade between them; the next one moves to the track above.', run: () => { selectItem(item); crossDissolve() } })
    if (media?.hasVideo && media?.hasAudio && track?.kind === 'video') items.push({ label: 'Detach audio', hint: 'Sound onto its own track; the picture goes mute.', run: withStatus(() => editor.detachAudio(item.id)) })
    // The other place somebody wants the words: looking at the clip itself.
    if (media?.hasAudio) items.push({ label: 'Write down what is said…', hint: 'Transcribe this file into an editable transcript you can place as captions.', run: () => state.speech?.openTranscribe(media.filename) })
    if (hasSound || track?.kind === 'audio') items.push({ label: item.muted ? 'Unmute' : 'Mute', checked: !!item.muted, run: withStatus(() => editor.setItem(item.id, { muted: !item.muted })) })
    items.push(
      '-',
      { label: 'Export as parts…', hint: 'Picture, sound, titles or captions as separate files.', run: () => openPartsDialog(selected) },
      { label: 'Go to its start', run: () => state.compositor.seekTo(item.startMs) },
      { label: 'Note…', hint: 'Free text an agent reads in get_timeline.', run: () => focusInspector('itemNote') },
      { label: 'Copy item id', run: () => copyText(item.id, 'item id') },
    )
    const title = `${item.name || item.type} · ${(item.durationMs / 1000).toFixed(2)}s${many ? ` · ${selected.length} selected` : ''}`
    showContextMenu(x, y, items, { title })
    return
  }

  if (kind === 'track' && track) {
    const idx = seq.tracks.indexOf(track)
    const sameKind = seq.tracks.filter((t) => t.kind === track.kind)
    const kindPos = sameKind.indexOf(track)
    const kindCount = sameKind.length
    const empty = !track.items.length
    items.push(
      { label: 'Rename…', run: () => { selectTrack(track); focusInspector('trackName') } },
      { label: track.locked ? 'Unlock' : 'Lock', checked: !!track.locked, hint: 'Locked tracks are left alone by ripple edits and silence removal.', run: withStatus(() => editor.setTrack(track.id, { locked: !track.locked })) },
      { label: track.muted ? 'Unmute' : 'Mute', checked: !!track.muted, run: withStatus(() => editor.setTrack(track.id, { muted: !track.muted })) },
    )
    if (track.kind === 'video') items.push({ label: track.hidden ? 'Show' : 'Hide', checked: !!track.hidden, hint: 'Hidden tracks stay out of the preview and the render.', run: withStatus(() => editor.setTrack(track.id, { hidden: !track.hidden })) })
    items.push(
      { label: 'Colour', swatches: ['', ...TRACK_SWATCHES], value: track.color ?? '', run: (c) => withStatus(() => editor.setTrack(track.id, { color: c || 'none' }))() },
      '-',
      { label: `Select all on ${track.name}`, disabled: empty, run: () => state.timeline.selectMany(track.items.map((i) => i.id)) },
      '-',
      { label: `Add ${track.kind} track above`, run: withStatus(() => addTrackAt(idx, track.kind)) },
      { label: `Add ${track.kind} track below`, run: withStatus(() => addTrackAt(idx + 1, track.kind)) },
      { label: 'Move up', key: '⌥↑', disabled: kindPos <= 0, run: () => moveTrack(track, 'up') },
      { label: 'Move down', key: '⌥↓', disabled: kindPos >= kindCount - 1, run: () => moveTrack(track, 'down') },
      { label: 'Move to top', key: '⌥⇧↑', disabled: kindPos <= 0, run: () => moveTrack(track, 'top') },
      { label: 'Move to bottom', key: '⌥⇧↓', disabled: kindPos >= kindCount - 1, run: () => moveTrack(track, 'bottom') },
      '-',
      { label: 'Note…', run: () => { selectTrack(track); focusInspector('trackNote') } },
      { label: 'Delete track', danger: true, confirm: true, disabled: !empty, hint: empty ? 'Remove this empty track.' : 'Empty the track first — deleting items is a separate, undoable step.', run: withStatus(() => removeTrack(track)) },
    )
    showContextMenu(x, y, items, { title: `${track.name} · ${track.kind} · ${track.items.length} item${track.items.length === 1 ? '' : 's'}` })
    return
  }

  // Empty lane, ruler, or the space below the tracks.
  const clipNow = currentClip()
  const here = { trackId: track?.id, atMs }
  items.push(
    { label: `Seek to ${atClock(atMs)}`, run: () => state.compositor.seekTo(atMs) },
    { label: `Marker here (${atClock(atMs)})`, key: 'M', hint: 'A moment worth coming back to. ⇧M and ⌥M walk between them.', run: () => { const m = addMarker(atMs); if (m) renameMarker(m) } },
    '-',
    { heading: `Add at ${atClock(atMs)}` },
    { label: 'Title', hint: 'A ready-made animated title. Type into it in the inspector.', run: withStatus(() => editor.addText({ atMs, trackId: track?.kind === 'video' ? track.id : undefined })) },
    clipNow && { label: `Clip "${clipNow.name}"`, hint: 'The clip open in Clip mode, as an overlay.', run: () => insertFromUi({ kind: 'clip', id: clipNow.id }, here) },
    { label: 'New sub-timeline', hint: 'An empty section placed here, five seconds long, and opened.', run: withStatus(async () => { state.compositor.seekTo(atMs); await newSubTimeline() }) },
    '-',
    { label: 'Add video track', run: withStatus(() => editor.addTrack('video')) },
    { label: 'Add audio track', run: withStatus(() => editor.addTrack('audio')) },
    '-',
    { label: 'Footage frame here → Assets', run: withStatus(async () => status(`saved ${(await editor.saveFrame({ timeMs: atMs, source: 'footage' })).name} to Assets`)) },
    { label: 'Composited frame here → Assets', run: withStatus(async () => status(`saved ${(await editor.saveFrame({ timeMs: atMs, source: 'composite' })).name} to Assets`)) },
    { label: 'Freeze this frame onto the timeline', hint: 'The frame becomes a still in Assets and is placed here as an image item, so it trims, moves and scales like any other.', run: () => { state.compositor.seekTo(atMs); freezeFrame() } },
    '-',
    { label: 'Select all', key: '⌘A', run: () => state.timeline.selectAll() },
    { label: 'Export captions of this timeline…', hint: 'One SRT, VTT or text file from every caption item, timed as rendered.', disabled: !captionItemsFor('timeline').length, run: () => openCaptionsDialog({ scope: 'timeline' }) },
    { label: 'Fit timeline in view', run: () => $('btnZoomFit').click() },
    { label: 'Check layout & timing', hint: 'The same checks an agent runs: gaps, overlaps, items past their footage.', run: withStatus(async () => {
      const lines = editor.checkSequence()
      const problems = lines.filter((l) => /^(ERROR|WARN)/.test(l))
      status(problems.length ? `${problems.length} thing(s) to look at — ${problems[0].slice(0, 90)}` : 'timeline checks out')
      if (lines.length) console.info('[check_timeline]\n' + lines.join('\n'))
    }) },
  )
  showContextMenu(x, y, items, { title: track ? `${track.name} · ${atClock(atMs)}` : atClock(atMs) })
}

function addTrackAt(index, kind) {
  const seq = currentSequence()
  editor.guardClaim(seq)
  const count = seq.tracks.filter((t) => t.kind === kind).length
  seq.tracks.splice(index, 0, SEQ.makeTrack(kind, `${kind === 'video' ? 'V' : 'A'}${count + 1}`))
  commit(seq)
}

/** Move a track of the open timeline: 'up' | 'down' | 'top' | 'bottom' | a position within its kind. */
function moveTrack(trackOrId, to) {
  const seq = currentSequence()
  if (!seq) return
  const id = typeof trackOrId === 'string' ? trackOrId : trackOrId?.id
  try {
    editor.guardClaim(seq)
    const r = SEQ.moveTrack(seq, id, to)
    if (!r.moved) return
    commit(seq)
    const track = seq.tracks.find((t) => t.id === id)
    if (state.selectedTrack?.id === id) renderTrackInspector()
    status(`${track.name} is now ${r.index === 0 ? 'the top' : r.index === r.of - 1 ? 'the bottom' : `${r.index + 1} of ${r.of}`} ${track.kind} track`)
  } catch (err) {
    status(err?.message ?? String(err), 'error')
  }
}

function removeTrack(track) {
  const seq = currentSequence()
  editor.guardClaim(seq)
  if (track.items.length) throw new Error('empty the track first')
  if (seq.tracks.length <= 1) throw new Error('a timeline keeps at least one track')
  seq.tracks.splice(seq.tracks.indexOf(track), 1)
  if (state.selectedTrack?.id === track.id) selectTrack(null)
  commit(seq)
  status(`removed track "${track.name}"`)
}

function railTimelineMenu(e, row) {
  const id = row.dataset.id
  const t = seqContext().timelines.get(id)
  if (!t) return
  const open = currentSequence()
  const isMain = state.project.mainTimelineId === id
  const nameEl = row.querySelector('.tl-name')
  const placed = SEQ.parentsOf ? SEQ.parentsOf(seqContext().timelines, id).length > 0 : false
  const items = [
    { label: 'Open', disabled: open?.id === id, run: () => row.click() },
    { label: 'Rename…', run: () => renameInline(nameEl, t) },
    '-',
    { label: 'Duplicate as a new version', hint: 'Tracks and items are copied; sections stay shared.', run: withStatus(async () => {
      const r = await editor.duplicateSequence({ timelineId: id })
      status(`"${r.copy.name}" is a copy of "${r.source.name}"`)
    }) },
    { label: 'Duplicate with its sections', hint: 'Every nested timeline is copied too.', run: withStatus(async () => {
      const r = await editor.duplicateSequence({ timelineId: id, deep: true })
      status(`"${r.copy.name}" copies "${r.source.name}" with ${r.copied - 1} section(s)`)
    }) },
    !isMain && { label: 'Make this the main timeline', hint: 'The one the project delivers.', run: () => {
      state.project.mainTimelineId = id
      dirty.project = true
      scheduleSave()
      renderTimelineRail()
      renderCrumb()
    } },
    '-',
    open && open.id !== id && { label: `Place in "${open.name}" at playhead`, hint: 'The same as dragging the row onto a track.', run: () => insertFromUi({ kind: 'timeline', id }) },
    { label: 'Export captions…', hint: 'One subtitle file from this timeline\'s caption items, timed as rendered.', run: withStatus(async () => { await editor.selectSequence(id); openCaptionsDialog({ scope: 'timeline' }) }) },
    { label: 'Copy timeline id', run: () => copyText(id, 'timeline id') },
    '-',
    { label: 'Delete timeline', danger: true, confirm: true, disabled: isMain || placed, hint: isMain ? 'The main timeline cannot be deleted; make another one main first.' : placed ? 'Placed as a section — flatten or remove the block first.' : 'Remove this timeline and its history.', run: withStatus(async () => status(`deleted "${(await editor.deleteSequence(id)).name}"`)) },
  ]
  showContextMenu(e.clientX, e.clientY, items, { title: `${t.name} · ${(SEQ.sequenceDuration(t) / 1000).toFixed(1)}s` })
}

function clipMenu(e, li) {
  const i = [...$('clipList').children].indexOf(li)
  const clip = state.project?.clips[i]
  if (!clip) return
  const items = [
    { label: 'Edit', disabled: state.clipIndex === i && state.mode === 'clip', run: withStatus(async () => { await editor.selectClip(clip.id); if (state.mode !== 'clip') document.querySelector('.mode-btn[data-setmode="clip"]').click() }) },
    { label: 'Duplicate', run: withStatus(async () => status(`duplicated as "${(await editor.duplicateClip(clip.id)).name}"`)) },
    { label: 'Add to timeline at playhead', run: () => insertFromUi({ kind: 'clip', id: clip.id }) },
    '-',
    { label: 'Studio export…', key: '⌘E', run: withStatus(async () => { await editor.selectClip(clip.id); $('btnStudio').click() }) },
    { label: 'Copy clip id', run: () => copyText(clip.id, 'clip id') },
    '-',
    { label: 'Delete clip', danger: true, confirm: true, disabled: state.project.clips.length <= 1, hint: state.project.clips.length <= 1 ? 'A project keeps at least one clip.' : 'Remove it from the project. Timeline items using it will show as missing.', run: withStatus(() => editor.deleteClip(clip.id)) },
  ]
  showContextMenu(e.clientX, e.clientY, items, { title: `${clip.name} · ${clip.width}×${clip.height} · ${(clip.durationMs / 1000).toFixed(1)}s` })
}

function mediaMenu(e, tile) {
  const m = state.lib?.media.get(tile.dataset.media)
  if (!m) return
  const items = [
    { label: 'Insert at playhead', run: () => insertFromUi({ kind: 'media', id: m.filename }) },
    m.hasAudio && {
      label: 'Write down what is said…',
      hint: 'Transcribe it into an editable transcript you can place as captions.',
      run: () => state.speech?.openTranscribe(m.filename),
    },
    m.hasVideo && { label: 'Extract frames, sprites, sub-clips…', run: () => { openExtractDialog(); $('exSource').value = m.filename } },
    { label: 'Copy file name', run: () => copyText(m.filename, 'file') },
    '-',
    { label: 'Remove from library', danger: true, confirm: true, hint: 'The file is deleted. Items using it show as missing.', run: withStatus(() => state.lib.removeMedia(m.filename)) },
  ]
  showContextMenu(e.clientX, e.clientY, items, { title: `${m.name} · ${fmtClock(m.durationMs)}` })
}

function transcriptMenu(e, row) {
  const id = row.dataset.transcript
  const t = (state.lib?.transcriptList ?? []).find((x) => x.id === id)
  if (!t) return
  const items = [
    { label: 'Add captions at playhead', run: () => insertFromUi({ kind: 'transcript', id }) },
    { label: 'Edit transcript…', hint: 'Every line, its times and words — fixable while the timeline plays.', run: () => openTranscriptEditor(id) },
    { label: 'Download as .srt', run: () => { window.location.href = `/api/transcripts/${id}/export?format=srt` } },
    { label: 'Download as .vtt', run: () => { window.location.href = `/api/transcripts/${id}/export?format=vtt` } },
    { label: 'Copy transcript id', run: () => copyText(id, 'transcript id') },
    '-',
    { label: 'Delete transcript', danger: true, confirm: true, run: withStatus(() => state.lib.removeTranscript(id)) },
  ]
  showContextMenu(e.clientX, e.clientY, items, { title: `${t.name} · ${t.cueCount} cues` })
}

function assetMenu(e, tile) {
  const a = (state.assets?.list ?? []).find((x) => x.filename === tile.dataset.asset)
  if (!a) return
  const items = [
    { label: 'Open', run: () => state.assets.openViewer(a) },
    a.kind === 'image' && { label: 'Add to timeline at playhead', hint: 'A still on an overlay track, held for five seconds; resize and place it in the inspector.', run: withStatus(async () => { await editor.ensureSequenceMode(); await insertFromUi({ kind: 'image', id: a.filename }) }) },
    { label: 'Insert into HTML', run: () => insertInto('html', snippetFor(a, 'html')) },
    { label: 'Insert into CSS', run: () => insertInto('css', snippetFor(a, 'css')) },
    { label: 'Copy URL', run: () => copyText(a.url, 'url') },
    '-',
    { label: 'Delete asset', danger: true, confirm: true, hint: 'Clips that reference it will show a broken image.', run: withStatus(() => state.assets.remove(a.filename)) },
  ]
  showContextMenu(e.clientX, e.clientY, items, { title: `${a.name} · ${a.kind}` })
}

function initContextMenus() {
  initContextMenu()
  document.addEventListener('contextmenu', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    // Text fields keep the browser's menu: cut, copy, paste, spelling.
    if (isTyping(t) || t.closest('dialog, .cmenu, .tip')) return
    // The timeline lanes build their own menu through onContext.
    if (t.closest('.seq-timeline')) return

    const on = (sel, fn) => {
      const el = t.closest(sel)
      if (!el) return false
      e.preventDefault()
      fn(e, el)
      return true
    }
    on('.tl-row[data-id]', railTimelineMenu) ||
      on('.clip-item', clipMenu) ||
      on('.media-tile[data-media]', mediaMenu) ||
      on('.tr-row[data-transcript]', transcriptMenu) ||
      on('.asset[data-asset]', assetMenu) ||
      on('#stageArea', stageMenu)
  })
}


/**
 * When start-up does not finish.
 *
 * `init()` was called bare, so anything that threw inside it left the static
 * shell on screen — a complete-looking editor where every button does nothing
 * and the only sign of trouble is a line in a console nobody has open. In a
 * local-first app the likeliest cause is also the most invisible: a browser
 * that refuses this origin any storage at all. There is no server to fall back
 * to, so that is fatal rather than degraded, and it should say so.
 */
function showBootFailure(err) {
  const el = $('bootFail')
  const message = String(err?.message ?? err ?? 'unknown error')
  // A blocked or missing IndexedDB throws a handful of different names
  // depending on the browser and the reason; they all mean the same thing here.
  const storage = /indexeddb|quota|storage|SecurityError|InvalidStateError|UnknownError|database/i.test(
    `${err?.name ?? ''} ${message}`,
  )

  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = storage
    ? `<h2>This browser will not let Klipvia store anything</h2>
       <p>Klipvia keeps every project in your own browser — there is no server holding
          a copy — so with storage blocked there is nowhere at all to put your work.</p>
       <p>Usually one of:</p>
       <ul>
         <li>a private or Incognito window with site data blocked</li>
         <li>a browser or extension set to block storage for this site</li>
         <li>an enterprise policy doing the same</li>
       </ul>
       <p>Allowing site data for this origin and reloading is all it needs.</p>`
    : `<h2>Klipvia could not start</h2>
       <p>Something went wrong before the editor finished loading. Reloading fixes
          most of it; if it does not, the message below is the useful part.</p>`

  const why = document.createElement('pre')
  why.className = 'why'
  why.textContent = `${err?.name ? `${err.name}: ` : ''}${message}`
  card.append(why)

  const acts = document.createElement('div')
  acts.className = 'acts'
  const reload = document.createElement('button')
  reload.className = 'btn primary'
  reload.textContent = 'Reload'
  reload.onclick = () => location.reload()
  acts.append(reload)
  card.append(acts)

  el.replaceChildren(card)
  el.hidden = false
  console.error('Klipvia failed to start', err)
}

init().catch(showBootFailure)
