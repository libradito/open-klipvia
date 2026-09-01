/**
 * Parts: pieces of a media file or a transcript, as files of their own.
 *
 * This is how a stretch of sound leaves the editor to be re-voiced, or a
 * stretch of picture goes somewhere on its own. Cuts re-encode rather than
 * stream-copy — a copy can only cut on keyframes, and a part that starts a
 * second early is not the part that was asked for. A transcript excerpt is
 * re-based to zero, so it lines up with the audio exported beside it.
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { EXPORT_DIR } from './paths'
import { MEDIA_DIR, getMedia, safeMediaName } from './media'
import { getTranscript, toSrt, toVtt, type Cue } from './transcripts'
import { newId } from './store'

export interface PartFile {
  name: string
  url: string
  size: number
  label: string
}

export const safeLabel = (s: string | undefined, fallback = 'part') =>
  (s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms))
  const m = Math.floor(t / 60_000)
  const sec = Math.floor((t % 60_000) / 1000)
  return `${m}m${String(sec).padStart(2, '0')}s${String(t % 1000).padStart(3, '0')}`
}

async function fileRecord(name: string, label: string): Promise<PartFile> {
  const f = Bun.file(join(EXPORT_DIR, name))
  return { name, url: `/api/exports/${name}`, size: f.size, label }
}

export type PartWhat = 'video' | 'audio' | 'both'

export async function exportMediaPart({
  file,
  fromMs,
  toMs,
  what = 'both',
  audioFormat = 'wav',
  videoFormat = 'mp4',
  label,
}: {
  file: string
  fromMs: number
  toMs: number
  what?: PartWhat
  audioFormat?: 'wav' | 'mp3'
  videoFormat?: 'mp4' | 'mov'
  label?: string
}): Promise<{ ok: true; file: PartFile } | { ok: false; error: string }> {
  const safe = safeMediaName(file)
  if (!safe) return { ok: false, error: 'bad media name' }
  const rec = await getMedia(safe)
  if (!rec) return { ok: false, error: `no media "${file}"` }

  const from = Math.max(0, fromMs)
  const to = Math.min(rec.durationMs, toMs > from ? toMs : rec.durationMs)
  if (to - from < 40) return { ok: false, error: 'the range is empty' }

  if (what === 'audio' && !rec.hasAudio) return { ok: false, error: `${rec.name} has no sound` }
  if (what === 'video' && !rec.hasVideo) return { ok: false, error: `${rec.name} has no picture` }
  let mode: PartWhat = what
  if (mode === 'both' && !rec.hasVideo) mode = 'audio'
  if (mode === 'both' && !rec.hasAudio) mode = 'video'

  let ext: string
  let codec: string[]
  if (mode === 'audio') {
    ext = audioFormat === 'mp3' ? 'mp3' : 'wav'
    codec = ['-vn', ...(ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_s16le', '-ar', '48000'])]
  } else if (mode === 'video') {
    ext = videoFormat === 'mov' ? 'mov' : 'mp4'
    codec = [
      '-an',
      ...(ext === 'mov'
        ? ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
        : ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']),
    ]
  } else {
    ext = videoFormat === 'mov' ? 'mov' : 'mp4'
    codec =
      ext === 'mov'
        ? ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-ar', '48000']
        : ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
  }

  await mkdir(EXPORT_DIR, { recursive: true })
  const base = safeLabel(label, safe.replace(/\.[^.]+$/, ''))
  const name = `${base}-${clock(from)}-${clock(to)}-${mode}-${newId()}.${ext}`
  const out = join(EXPORT_DIR, name)

  const p = Bun.spawn(
    ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', (from / 1000).toFixed(3), '-to', (to / 1000).toFixed(3), '-i', join(MEDIA_DIR, safe), ...codec, out],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  if (code !== 0) return { ok: false, error: err.trim() || `ffmpeg exited with ${code}` }
  return { ok: true, file: await fileRecord(name, label ?? rec.name) }
}

/** The cues inside a window, re-based so the first one starts near zero. */
export function cuesInWindow(cues: Cue[], fromMs: number, toMs: number): Cue[] {
  return cues
    .filter((c) => c.endMs > fromMs && c.startMs < toMs)
    .map((c) => ({
      ...c,
      startMs: Math.max(c.startMs, fromMs) - fromMs,
      endMs: Math.min(c.endMs, toMs) - fromMs,
      words: c.words?.filter((w) => w.endMs > fromMs && w.startMs < toMs).map((w) => ({ ...w, startMs: Math.max(w.startMs, fromMs) - fromMs, endMs: Math.min(w.endMs, toMs) - fromMs })),
    }))
    .filter((c) => c.endMs > c.startMs)
}

export async function exportTranscriptPart({
  id,
  fromMs,
  toMs,
  format = 'srt',
  label,
}: {
  id: string
  fromMs: number
  toMs: number
  format?: 'srt' | 'vtt' | 'txt'
  label?: string
}): Promise<{ ok: true; file: PartFile; cues: number } | { ok: false; error: string }> {
  const t = await getTranscript(id).catch(() => null)
  if (!t) return { ok: false, error: `no transcript "${id}"` }
  const from = Math.max(0, fromMs)
  const to = toMs > from ? toMs : t.durationMs
  const cues = cuesInWindow(t.cues, from, to)
  if (!cues.length) return { ok: false, error: 'no cues in that range' }

  const body =
    format === 'txt'
      ? cues.map((c) => c.text.replace(/\s+/g, ' ')).join('\n') + '\n'
      : format === 'vtt'
        ? toVtt(cues)
        : toSrt(cues)

  await mkdir(EXPORT_DIR, { recursive: true })
  const base = safeLabel(label, t.name.replace(/\.[^.]+$/, ''))
  const name = `${base}-${clock(from)}-${clock(to)}-${newId()}.${format}`
  await Bun.write(join(EXPORT_DIR, name), body)
  return { ok: true, file: await fileRecord(name, label ?? t.name), cues: cues.length }
}
