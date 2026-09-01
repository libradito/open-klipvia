/**
 * Transcript library — SRT, WebVTT and Whisper JSON, normalised to one shape.
 *
 * A transcript is bound to a media file, not to a place on the timeline: cue
 * times are *source* times. Whatever the editor later does to that footage —
 * trim its head, move it, cut it in two — the caption item recomputes which
 * cues land where from the item's in-point, so captions cannot drift out of
 * sync with the picture they belong to.
 */

import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'data', 'transcripts')

export interface Word {
  startMs: number
  endMs: number
  text: string
}

export interface Cue {
  startMs: number
  endMs: number
  text: string
  /** Present only for word-level sources (Whisper with `word_timestamps`). */
  words?: Word[]
}

export interface Transcript {
  id: string
  name: string
  /** The media file these cue times belong to, if known. */
  mediaFilename: string | null
  source: 'srt' | 'vtt' | 'whisper'
  cues: Cue[]
  wordLevel: boolean
  durationMs: number
  createdAt: number
}

function pathFor(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid transcript id')
  return join(DIR, `${id}.json`)
}

/* ------------------------------------------------------------------ parsing */

/** `01:02:03,456`, `01:02:03.456`, `02:03.456` and bare seconds all appear. */
/*
 * Parsing and writing subtitles lives in `public/subtitles.js`, as plain
 * JavaScript, because the browser needs the identical code: a hosted build has
 * no server to hand an uploaded SRT to. Re-exported here so every existing
 * caller is unchanged.
 */
export {
  normaliseCues,
  replaceCuesInWindow,
  finalizeTranscript,
  parseTranscript,
  toSrt,
  toVtt,
} from '../public/subtitles.js'


/* -------------------------------------------------------------------- store */

export async function saveTranscript(t: Transcript): Promise<Transcript> {
  await mkdir(DIR, { recursive: true })
  await Bun.write(pathFor(t.id), JSON.stringify(t, null, 2))
  return t
}

export async function getTranscript(id: string): Promise<Transcript | null> {
  const file = Bun.file(pathFor(id))
  if (!(await file.exists())) return null
  return (await file.json()) as Transcript
}

/** Listing omits the cues; a long transcript is megabytes the rail never shows. */
export async function listTranscripts(): Promise<Array<Omit<Transcript, 'cues'> & { cueCount: number }>> {
  await mkdir(DIR, { recursive: true })
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'))
  const out = []
  for (const f of files) {
    try {
      const { cues, ...rest } = (await Bun.file(join(DIR, f)).json()) as Transcript
      out.push({ ...rest, cueCount: cues?.length ?? 0 })
    } catch {
      /* skip corrupt files rather than failing the listing */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteTranscript(id: string): Promise<boolean> {
  const file = pathFor(id)
  if (!(await Bun.file(file).exists())) return false
  await unlink(file)
  return true
}
