/**
 * Media and transcript library — the rail a sequence is cut from.
 *
 * Both live in one global library beside the asset library, for the same
 * reason: footage outlives the project it was first cut into. What is stored
 * per project is the *edit*, never the file.
 *
 * Waveform peaks are fetched once per file and cached here, because the
 * timeline redraws them on every zoom and re-fetching a 60,000 point array to
 * paint 200 pixels would make zooming feel broken.
 */

import { setTip } from '/tooltip.js'
import { icon } from '/icons.js'
import { languageName } from '/languages.js'

const $ = (id) => document.getElementById(id)

const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wav|mp3|m4a|aac|flac|ogg|opus)$/i
const TRANSCRIPT_EXT = /\.(srt|vtt|json)$/i

const fmtSize = (n) =>
  n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024 ** 3).toFixed(2)} GB`

export const fmtClock = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(t / 60)
  const s = t % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * `onTranscribe(filename)` opens the Transcribe window on that file;
 * `speechLine()` is "VoiceBox · on your machine" or null, for the tile tips;
 * `voiceOvers()` maps a library filename to the voice that read it, for the
 * Voice-overs list in the Speech rail.
 */
export function initMediaLibrary({ onInsert, onStatus, onEdit = null, onTranscribe = null, speechLine = null, voiceOvers = null }) {
  /** filename -> MediaItem */
  const media = new Map()
  /** transcript id -> full transcript, loaded on demand */
  const transcripts = new Map()
  /** filename -> { peaksPerSecond, peaks } */
  const peaks = new Map()

  let transcriptList = []
  let importing = 0

  /* --------------------------------------------------------------- loading */

  async function refresh() {
    try {
      const list = await fetch('/api/media').then((r) => r.json())
      media.clear()
      for (const m of list) media.set(m.filename, m)
    } catch {
      /* server down; keep whatever we had */
    }
    try {
      transcriptList = await fetch('/api/transcripts').then((r) => r.json())
    } catch {
      transcriptList = []
    }
    render()
    // Waveforms are wanted the moment a clip lands on a track.
    for (const m of media.values()) if (m.hasPeaks) loadPeaks(m.filename)
    return [...media.values()]
  }

  async function loadPeaks(filename) {
    if (peaks.has(filename)) return peaks.get(filename)
    try {
      const data = await fetch(`/api/media/${filename}/peaks`).then((r) => (r.ok ? r.json() : null))
      if (data) peaks.set(filename, data)
      return data
    } catch {
      return null
    }
  }

  /**
   * The fine waveform tier, wanted only once the timeline is zoomed in. It is
   * hung on the overview object so the painter finds it where it already
   * looks; decoded from base64 once, never re-fetched.
   */
  async function loadDetailPeaks(filename) {
    const data = peaks.get(filename) ?? (await loadPeaks(filename))
    if (!data) return false
    if (data.detail) return true
    try {
      const d = await fetch(`/api/media/${filename}/peaks?tier=detail`).then((r) => (r.ok ? r.json() : null))
      if (!d?.base64) return false
      const bin = atob(d.base64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      data.detail = { peaksPerSecond: d.peaksPerSecond, peaks: arr }
      return true
    } catch {
      return false
    }
  }

  async function loadTranscript(id) {
    if (transcripts.has(id)) return transcripts.get(id)
    try {
      const t = await fetch(`/api/transcripts/${id}`).then((r) => (r.ok ? r.json() : null))
      if (t) transcripts.set(id, t)
      return t
    } catch {
      return null
    }
  }

  /* ------------------------------------------------------------- importing */

  /**
   * Import whatever was dropped. Media is probed server-side before it answers
   * — a poster, a duration and a waveform — so the tile appears complete rather
   * than filling itself in afterwards.
   */
  async function importFiles(files) {
    const list = [...files]
    const mediaFiles = list.filter((f) => MEDIA_EXT.test(f.name))
    const textFiles = list.filter((f) => TRANSCRIPT_EXT.test(f.name) && !MEDIA_EXT.test(f.name))
    const rejected = list.filter((f) => !mediaFiles.includes(f) && !textFiles.includes(f))

    for (const f of rejected) onStatus?.(`${f.name}: not a media or transcript file`, 'error')
    if (!mediaFiles.length && !textFiles.length) return

    importing++
    render()
    try {
      for (const file of mediaFiles) {
        onStatus?.(`importing ${file.name}…`)
        try {
          const res = await fetch(`/api/media?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file,
          })
          const body = await res.json()
          if (!res.ok) throw new Error(body.error ?? res.statusText)
          media.set(body.filename, body)
          onStatus?.(`added ${body.name} · ${fmtClock(body.durationMs)}`)
        } catch (err) {
          onStatus?.(`${file.name}: ${err.message ?? err}`, 'error')
        }
      }

      for (const file of textFiles) {
        try {
          const text = await file.text()
          // A transcript dropped while its media is in the library binds to it
          // by name, which is what a `talk.mp4` / `talk.srt` pair expects.
          const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase()
          const match = [...media.values()].find(
            (m) => m.name.replace(/\.[^.]+$/, '').toLowerCase() === stem,
          )
          const q = new URLSearchParams({ name: file.name })
          if (match) q.set('media', match.filename)

          const res = await fetch(`/api/transcripts?${q}`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: text,
          })
          const body = await res.json()
          if (!res.ok) throw new Error(body.error ?? res.statusText)
          onStatus?.(
            `added ${body.name} · ${body.cueCount} cues` +
              (match ? ` · linked to ${match.name}` : '') +
              (body.wordLevel ? ' · word level' : ''),
          )
        } catch (err) {
          onStatus?.(`${file.name}: ${err.message ?? err}`, 'error')
        }
      }
    } finally {
      importing--
      await refresh()
    }
  }

  /* ---------------------------------------------------------------- render */

  function dragPayload(el, payload) {
    el.draggable = true
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-ah-source', JSON.stringify(payload))
      e.dataTransfer.effectAllowed = 'copy'
    })
  }

  function render() {
    renderMedia()
    renderTranscripts()
    renderVoiceOvers()
  }

  const anySound = () => [...media.values()].some((m) => m.hasAudio)
  const transcriptFor = (filename) => transcriptList.find((t) => t.mediaFilename === filename) ?? null

  function renderMedia() {
    const grid = $('mediaGrid')
    if (!grid) return
    grid.innerHTML = ''

    if (importing) {
      grid.appendChild(Object.assign(document.createElement('p'), {
        className: 'rail-empty', textContent: 'importing…',
      }))
    }
    if (!media.size && !importing) {
      grid.appendChild(Object.assign(document.createElement('p'), {
        className: 'rail-empty',
        textContent: 'Drop video or audio here.',
      }))
      return
    }

    for (const m of media.values()) {
      const withSound = !!m.hasAudio || m.kind === 'audio'
      const transcript = withSound ? transcriptFor(m.filename) : null
      const tile = document.createElement('div')
      tile.className = `media-tile ${m.kind}${transcript ? ' transcribed' : ''}`
      tile.dataset.media = m.filename
      dragPayload(tile, { kind: 'media', id: m.filename })

      const thumb = document.createElement('div')
      thumb.className = 'media-thumb'
      if (m.posterUrl) thumb.style.backgroundImage = `url("${m.posterUrl}")`
      else thumb.append(icon(m.kind === 'audio' ? 'audio-lines' : 'film', { size: 18 }))
      if (transcript && m.posterUrl) {
        const badge = document.createElement('span')
        badge.className = 'media-tr'
        badge.append(icon('captions', { size: 11 }))
        thumb.appendChild(badge)
      }
      thumb.appendChild(
        Object.assign(document.createElement('span'), { className: 'media-dur', textContent: fmtClock(m.durationMs) }),
      )
      tile.appendChild(thumb)

      const meta = document.createElement('div')
      meta.className = 'media-meta'
      meta.appendChild(Object.assign(document.createElement('div'), { className: 'mname', textContent: m.name }))
      meta.appendChild(Object.assign(document.createElement('div'), {
        className: 'msub',
        textContent: (m.kind === 'video'
          ? `${m.width}×${m.height}${m.fps ? ` · ${Math.round(m.fps)}fps` : ''}${m.hasAudio ? ' · sound' : ' · silent'}`
          : `${m.channels === 1 ? 'mono' : 'stereo'} · ${((m.sampleRate ?? 0) / 1000).toFixed(1)}kHz`) +
          (transcript ? ' · transcribed' : ''),
      }))
      tile.appendChild(meta)

      setTip(
        tile,
        `${m.name}\n${m.kind} · ${fmtClock(m.durationMs)} · ${fmtSize(m.size)}\n` +
          `${m.vcodec ? `${m.vcodec} ` : ''}${m.acodec ?? ''}\n` +
          (withSound ? 'Drag onto a track, click to insert at the playhead, or Transcribe.' : 'Drag onto a track, or click to insert at the playhead.'),
        { at: 'right' },
      )

      if (withSound) {
        const tr = document.createElement('button')
        tr.className = 'media-transcribe'
        tr.textContent = 'Transcribe'
        tr.dataset.tool = 'transcribe_media'
        tr.setAttribute('aria-label', transcript ? 'Transcribe again' : 'Transcribe')
        const line = speechLine?.() ?? null
        setTip(
          tr,
          transcript
            ? 'Transcribed. Click to transcribe again.'
            : 'Transcribe: write down what is said, as a transcript you can place as captions.\n' +
                (line ?? 'Nothing is set up to listen yet; the window will ask.'),
        )
        tr.onclick = (e) => {
          e.stopPropagation()
          onTranscribe?.(m.filename)
        }
        tile.appendChild(tr)
      }

      const add = document.createElement('button')
      add.className = 'media-add'
      add.setAttribute('aria-label', 'Insert at the playhead')
      add.append(icon('plus', { size: 13 }))
      setTip(add, 'Insert at the playhead')
      add.onclick = (e) => {
        e.stopPropagation()
        onInsert?.({ kind: 'media', id: m.filename })
      }
      tile.appendChild(add)

      const del = document.createElement('button')
      del.className = 'media-del'
      del.setAttribute('aria-label', 'Remove from the library')
      del.append(icon('x', { size: 13 }))
      setTip(del, 'Remove from the library. Click twice to confirm.')
      let armed = false
      del.onclick = async (e) => {
        e.stopPropagation()
        if (!armed) {
          armed = true
          del.classList.add('confirm')
          setTimeout(() => { armed = false; del.classList.remove('confirm') }, 3000)
          return
        }
        await fetch(`/api/media/${m.filename}`, { method: 'DELETE' })
        onStatus?.(`removed ${m.name} — items using it will show as missing`)
        await refresh()
      }
      tile.appendChild(del)

      tile.onclick = () => onInsert?.({ kind: 'media', id: m.filename })
      grid.appendChild(tile)
    }
  }

  function renderTranscripts() {
    const list = $('transcriptList')
    if (!list) return
    list.innerHTML = ''
    // The count in the group's head, beside its name.
    const meta = document.querySelector('.insp-section[data-section="transcripts"] .insp-section-meta')
    if (meta) meta.textContent = transcriptList.length ? String(transcriptList.length) : ''

    // The button stays live with nothing to listen to: the window it opens
    // says so and offers to import a clip, which a dead button cannot do.
    const sound = anySound()

    if (!transcriptList.length) {
      const empty = Object.assign(document.createElement('p'), { className: 'rail-empty', textContent: 'No transcripts yet.' })
      const sub = document.createElement('span')
      sub.className = 'rail-empty-sub'
      if (sound) {
        sub.textContent = 'or drop an .srt, .vtt or Whisper .json here.'
      } else {
        sub.textContent = 'Import a clip with sound, or drop an .srt, .vtt or Whisper .json here.'
      }
      empty.appendChild(sub)
      list.appendChild(empty)
      return
    }

    for (const t of transcriptList) {
      const row = document.createElement('div')
      row.className = 'tr-row'
      row.dataset.transcript = t.id
      dragPayload(row, { kind: 'transcript', id: t.id })

      const ico = document.createElement('div')
      ico.className = 'tr-ico'
      ico.append(icon('captions', { size: 16 }))
      row.appendChild(ico)
      const meta = document.createElement('div')
      meta.className = 'tr-meta'
      meta.appendChild(Object.assign(document.createElement('div'), { className: 'tr-name', textContent: t.name }))
      const bound = t.mediaFilename ? media.get(t.mediaFilename)?.name : null
      meta.appendChild(Object.assign(document.createElement('div'), {
        className: 'tr-sub',
        textContent: `${t.cueCount} cues · ${fmtClock(t.durationMs)}${t.wordLevel ? ' · words' : ''}` +
          (bound ? ` · ${bound}` : ''),
      }))
      row.appendChild(meta)
      setTip(
        row,
        `${t.name}\n${t.source.toUpperCase()} · ${t.cueCount} cues${t.wordLevel ? ' · word-level timings' : ''}\n` +
          (bound ? `Linked to ${bound}\n` : 'Not linked to any media\n') +
          'Drag onto a track to burn in, or click to add at the playhead.',
        { at: 'right' },
      )

      const acts = document.createElement('div')
      acts.className = 'tr-acts'

      const srt = document.createElement('button')
      srt.setAttribute('aria-label', 'Download as SRT')
      srt.append(icon('download', { size: 11 }), 'srt')
      setTip(srt, 'Download as an .srt sidecar file')
      srt.onclick = (e) => {
        e.stopPropagation()
        window.location.href = `/api/transcripts/${t.id}/export?format=srt`
      }
      const vtt = document.createElement('button')
      vtt.setAttribute('aria-label', 'Download as WebVTT')
      vtt.append(icon('download', { size: 11 }), 'vtt')
      setTip(vtt, 'Download as a WebVTT sidecar file')
      vtt.onclick = (e) => {
        e.stopPropagation()
        window.location.href = `/api/transcripts/${t.id}/export?format=vtt`
      }
      const edit = document.createElement('button')
      edit.setAttribute('aria-label', 'Edit transcript')
      edit.append(icon('pencil', { size: 12 }))
      setTip(edit, 'Open the transcript editor: every line, its times and words, fixable while the timeline plays.')
      edit.onclick = (e) => {
        e.stopPropagation()
        onEdit?.(t.id)
      }
      const del = document.createElement('button')
      del.setAttribute('aria-label', 'Delete transcript')
      del.append(icon('x', { size: 12 }))
      del.className = 'danger'
      setTip(del, 'Delete this transcript. Click twice to confirm.')
      let armed = false
      del.onclick = async (e) => {
        e.stopPropagation()
        if (!armed) {
          armed = true
          del.classList.add('confirm')
          setTimeout(() => { armed = false; del.classList.remove('confirm') }, 3000)
          return
        }
        await fetch(`/api/transcripts/${t.id}`, { method: 'DELETE' })
        transcripts.delete(t.id)
        await refresh()
      }
      acts.append(edit, srt, vtt, del)
      row.appendChild(acts)

      row.onclick = () => onInsert?.({ kind: 'transcript', id: t.id })
      list.appendChild(row)
    }
  }

  /**
   * The Voice-overs group: every library audio file a voice read from a
   * script. They are ordinary media (the Media rail lists them too); this
   * list is the one that says which voice and language, and drags with the
   * same payload.
   */
  function renderVoiceOvers() {
    const list = $('voiceList')
    if (!list) return
    list.innerHTML = ''
    const marks = voiceOvers?.() ?? {}
    const rows = [...media.values()].filter((m) => marks[m.filename]).reverse()
    const meta = document.querySelector('.insp-section[data-section="voiceovers"] .insp-section-meta')
    if (meta) meta.textContent = rows.length ? String(rows.length) : ''

    if (!rows.length) {
      const empty = Object.assign(document.createElement('p'), { className: 'rail-empty', textContent: 'No voice-overs yet.' })
      empty.appendChild(Object.assign(document.createElement('span'), {
        className: 'rail-empty-sub',
        textContent: 'Type a script, pick a voice, and the audio lands on a track.',
      }))
      list.appendChild(empty)
      return
    }

    for (const m of rows) {
      const mark = marks[m.filename]
      const row = document.createElement('div')
      row.className = 'tr-row voice-row'
      row.dataset.media = m.filename
      dragPayload(row, { kind: 'media', id: m.filename })

      const ico = document.createElement('div')
      ico.className = 'tr-ico'
      ico.append(icon('mic', { size: 16 }))
      row.appendChild(ico)
      const info = document.createElement('div')
      info.className = 'tr-meta'
      info.appendChild(Object.assign(document.createElement('div'), { className: 'tr-name', textContent: m.name }))
      const bits = [mark.voiceName || mark.voice, mark.language ? languageName(mark.language) : null, fmtClock(m.durationMs)].filter(Boolean)
      info.appendChild(Object.assign(document.createElement('div'), { className: 'tr-sub', textContent: bits.join(' · ') }))
      row.appendChild(info)
      setTip(
        row,
        `${m.name}\n${bits.join(' · ')}${mark.provider ? ` · ${mark.provider}` : ''}\n` +
          'Drag onto an audio track, or click to add at the playhead.',
        { at: 'right' },
      )

      const acts = document.createElement('div')
      acts.className = 'tr-acts'
      const add = document.createElement('button')
      add.setAttribute('aria-label', 'Insert at the playhead')
      add.append(icon('plus', { size: 12 }))
      setTip(add, 'Insert at the playhead, on an audio track.')
      add.onclick = (e) => {
        e.stopPropagation()
        onInsert?.({ kind: 'media', id: m.filename })
      }
      const del = document.createElement('button')
      del.setAttribute('aria-label', 'Remove from the library')
      del.append(icon('x', { size: 12 }))
      del.className = 'danger'
      setTip(del, 'Remove from the library. Click twice to confirm.')
      let armed = false
      del.onclick = async (e) => {
        e.stopPropagation()
        if (!armed) {
          armed = true
          del.classList.add('confirm')
          setTimeout(() => { armed = false; del.classList.remove('confirm') }, 3000)
          return
        }
        await fetch(`/api/media/${m.filename}`, { method: 'DELETE' })
        onStatus?.(`removed ${m.name}; items using it will show as missing`)
        await refresh()
      }
      acts.append(add, del)
      row.appendChild(acts)
      row.onclick = () => onInsert?.({ kind: 'media', id: m.filename })
      list.appendChild(row)
    }
  }

  /**
   * Transcript edits, with their own undo.
   *
   * They live outside the sequence snapshot — a transcript is shared by every
   * caption item that reads it — so ⌘Z does not reach them. Each write keeps
   * the previous cue list here, twenty deep, and the cache is swapped for the
   * server's reply so caption items recompile from what was saved.
   */
  const transcriptHistory = new Map()

  function remember(id) {
    const t = transcripts.get(id)
    if (!t) return
    const stack = transcriptHistory.get(id) ?? []
    stack.push(t.cues.map((c) => ({ ...c, words: c.words?.map((w) => ({ ...w })) })))
    if (stack.length > 20) stack.shift()
    transcriptHistory.set(id, stack)
  }

  async function absorb(id, res) {
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `transcript write failed (${res.status})`)
    transcripts.set(id, body)
    const row = transcriptList.find((t) => t.id === id)
    if (row) Object.assign(row, { cueCount: body.cues.length, durationMs: body.durationMs, wordLevel: body.wordLevel, name: body.name, mediaFilename: body.mediaFilename })
    render()
    return body
  }

  async function saveTranscriptCues(id, cues) {
    await loadTranscript(id)
    remember(id)
    return absorb(id, await fetch(`/api/transcripts/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cues }) }))
  }

  async function patchTranscript(id, fromMs, toMs, cues) {
    await loadTranscript(id)
    remember(id)
    return absorb(id, await fetch(`/api/transcripts/${id}/cues`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromMs, toMs, cues }) }))
  }

  /** Rename or relink a transcript: { name } and/or { mediaFilename } (null unlinks). */
  async function updateTranscript(id, patch) {
    await loadTranscript(id)
    return absorb(id, await fetch(`/api/transcripts/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }))
  }

  async function undoTranscript(id) {
    const stack = transcriptHistory.get(id)
    if (!stack?.length) return null
    const prev = stack.pop()
    return absorb(id, await fetch(`/api/transcripts/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cues: prev }) }))
  }

  return {
    refresh,
    updateTranscript,
    /** Remove a media file from the library (items using it show as missing). */
    async removeMedia(filename) {
      const m = media.get(filename)
      await fetch(`/api/media/${filename}`, { method: 'DELETE' })
      onStatus?.(`removed ${m?.name ?? filename} — items using it will show as missing`)
      await refresh()
    },
    async removeTranscript(id) {
      await fetch(`/api/transcripts/${id}`, { method: 'DELETE' })
      transcripts.delete(id)
      await refresh()
    },
    get transcriptList() {
      return transcriptList
    },
    render,
    importFiles,
    saveTranscriptCues,
    patchTranscript,
    undoTranscript,
    transcriptHistory,
    loadPeaks,
    loadDetailPeaks,
    loadTranscript,
    media,
    transcripts,
    peaks,
    get transcriptList() {
      return transcriptList
    },
  }
}
