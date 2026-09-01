/** Flat-file project store. One JSON document per project under data/projects. */

import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface Background {
  mode: 'transparent' | 'color'
  color: string
}

export interface Clip {
  id: string
  name: string
  html: string
  css: string
  js: string
  durationMs: number
  width: number
  height: number
  fps: number
  background: Background
}

export interface Project {
  id: string
  name: string
  clips: Clip[]
  /** Timelines in display order; each is its own document under data/timelines. */
  timelineIds: string[]
  mainTimelineId: string
  createdAt: number
  updatedAt: number
  /** Pre-migration shape: timelines inline. Read once, then moved out. */
  sequences?: Sequence[]
  activeSequenceId?: string
}

const DIR = join(process.cwd(), 'data', 'projects')
const BACKUP_DIR = join(DIR, '.backup')
const TL_DIR = join(process.cwd(), 'data', 'timelines')

export const GREEN = '#00b140' // broadcast chroma green

/**
 * Writes are read-check-write across awaits, and two saves can arrive in the
 * same millisecond — two hidden tabs align their timers to the same second —
 * so each document's writes queue behind one another.
 */
const locks = new Map<string, Promise<unknown>>()
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

export function newId(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10)
}

export function blankClip(name = 'Untitled clip'): Clip {
  return {
    id: newId('c_'),
    name,
    html: '<div class="title"><span>Hello</span></div>',
    css: [
      '.title {',
      '  display: flex; align-items: center; justify-content: center;',
      '  width: 100%; height: 100%;',
      '  font: 700 120px/1 system-ui, sans-serif; color: #fff;',
      '}',
      '.title span {',
      '  animation: rise 1.2s cubic-bezier(.2,.8,.2,1) both;',
      '}',
      '@keyframes rise {',
      '  from { opacity: 0; transform: translateY(40px) scale(.9); }',
      '  to   { opacity: 1; transform: translateY(0)    scale(1);  }',
      '}',
    ].join('\n'),
    js: '',
    durationMs: 3000,
    width: 1920,
    height: 1080,
    fps: 30,
    background: { mode: 'transparent', color: GREEN },
  }
}

async function ensureDir() {
  await mkdir(DIR, { recursive: true })
}

function pathFor(id: string) {
  // Guard against traversal: ids are generated, but this is a local server.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid project id')
  return join(DIR, `${id}.json`)
}

export async function listProjects(): Promise<Array<Pick<Project, 'id' | 'name' | 'updatedAt'> & { clipCount: number }>> {
  await ensureDir()
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'))
  const out = []
  for (const f of files) {
    try {
      const p = (await Bun.file(join(DIR, f)).json()) as Project
      out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, clipCount: p.clips?.length ?? 0 })
    } catch {
      /* skip unreadable/corrupt files rather than failing the whole listing */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Read a project, moving its timelines out into documents the first time.
 *
 * Projects used to carry every sequence inline, and every save rewrote all of
 * them: two tabs — or two agents — editing different sections silently
 * overwrote each other. Now each timeline is its own document with a
 * revision. The migration keeps every id, backs the old file up outside the
 * listing directory, skips documents that already exist (a crash halfway is
 * harmless), and a project with no timelines gets its main one here rather
 * than in a client.
 */
export async function getProject(id: string): Promise<Project | null> {
  const file = Bun.file(pathFor(id))
  if (!(await file.exists())) return null
  const p = (await file.json()) as Project
  if (!Array.isArray(p.sequences) && Array.isArray(p.timelineIds) && p.timelineIds.length && p.timelineIds.includes(p.mainTimelineId)) return p
  return withLock(`project:${id}`, () => migrateProject(p))
}

async function migrateProject(p: Project): Promise<Project> {
  let changed = false
  if (Array.isArray(p.sequences)) {
    await mkdir(BACKUP_DIR, { recursive: true })
    const backup = join(BACKUP_DIR, `${p.id}.pre-timelines.json`)
    if (!(await Bun.file(backup).exists())) await Bun.write(backup, JSON.stringify(p, null, 2))

    const ids: string[] = []
    for (const seq of p.sequences) {
      if (!(await Bun.file(tlPath(seq.id)).exists())) {
        await saveTimeline({ ...timelineFromSequence(seq, p.id), rev: 1 })
      }
      ids.push(seq.id)
    }
    p.timelineIds = [...new Set([...(p.timelineIds ?? []), ...ids])]
    p.mainTimelineId = p.mainTimelineId ?? p.activeSequenceId ?? ids[0]!
    delete p.sequences
    delete p.activeSequenceId
    changed = true
  }
  if (!Array.isArray(p.timelineIds)) {
    p.timelineIds = []
    changed = true
  }
  if (!p.timelineIds.length) {
    const main = await createTimeline(p.id, { name: 'Main' })
    p.timelineIds = [main.id]
    p.mainTimelineId = main.id
    changed = true
  }
  if (!p.mainTimelineId || !p.timelineIds.includes(p.mainTimelineId)) {
    p.mainTimelineId = p.timelineIds[0]!
    changed = true
  }
  if (changed) await saveProject(p)
  return p
}

/** Read-modify-write a project without another request slipping in between. */
export async function updateProject(id: string, fn: (p: Project) => Promise<void> | void): Promise<Project | null> {
  return withLock(`project:${id}`, async () => {
    const p = await getProject(id)
    if (!p) return null
    await fn(p)
    return saveProject(p)
  })
}

export async function saveProject(p: Project): Promise<Project> {
  await ensureDir()
  p.updatedAt = Date.now()
  delete p.sequences
  delete p.activeSequenceId
  await Bun.write(pathFor(p.id), JSON.stringify(p, null, 2))
  return p
}

export async function createProject(name = 'Untitled project'): Promise<Project> {
  const now = Date.now()
  const id = newId('p_')
  const main = await createTimeline(id, { name: 'Main' })
  return saveProject({
    id,
    name,
    clips: [blankClip('Clip 1')],
    timelineIds: [main.id],
    mainTimelineId: main.id,
    createdAt: now,
    updatedAt: now,
  })
}

export async function deleteProject(id: string): Promise<boolean> {
  const file = pathFor(id)
  if (!(await Bun.file(file).exists())) return false
  const p = (await Bun.file(file).json()) as Project
  for (const tid of p.timelineIds ?? []) await unlink(tlPath(tid)).catch(() => {})
  await unlink(file)
  return true
}

/* -------------------------------------------------------------- timelines */

/** A sequence that lives as its own document. */
export interface Timeline extends Sequence {
  projectId: string
  note?: string
  claimedBy?: { agent: string; at: number } | null
  rev: number
  createdAt: number
  updatedAt: number
}

export const CLAIM_TTL_MS = 15 * 60_000

function tlPath(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid timeline id')
  return join(TL_DIR, `${id}.json`)
}

export function timelineFromSequence(seq: Sequence, projectId: string): Timeline {
  const now = Date.now()
  return { ...seq, projectId, rev: 0, createdAt: now, updatedAt: now }
}

export async function getTimeline(id: string): Promise<Timeline | null> {
  const file = Bun.file(tlPath(id))
  if (!(await file.exists())) return null
  const t = (await file.json()) as Timeline
  // An expired claim is no claim.
  if (t.claimedBy && Date.now() - t.claimedBy.at > CLAIM_TTL_MS) t.claimedBy = null
  return t
}

/** Write as-is (the caller has settled the revision). */
export async function saveTimeline(t: Timeline): Promise<Timeline> {
  await mkdir(TL_DIR, { recursive: true })
  t.updatedAt = Date.now()
  await Bun.write(tlPath(t.id), JSON.stringify(t, null, 2))
  return t
}

/**
 * Write only if the caller saw the current revision. The refusal hands back
 * what is on disk, so a client can adopt it rather than guess.
 */
export function writeTimeline(
  incoming: Timeline,
  expectRev: number,
): Promise<{ ok: true; timeline: Timeline } | { ok: false; current: Timeline }> {
  return withLock(`timeline:${incoming.id}`, async () => {
    const current = await getTimeline(incoming.id)
    if (current && current.rev !== expectRev) return { ok: false, current }
    const next: Timeline = {
      ...(current ?? timelineFromSequence(incoming, incoming.projectId)),
      ...incoming,
      projectId: current?.projectId ?? incoming.projectId,
      createdAt: current?.createdAt ?? incoming.createdAt ?? Date.now(),
      rev: (current?.rev ?? 0) + 1,
    }
    return { ok: true, timeline: await saveTimeline(next) }
  })
}

/** Read-modify-write a timeline's metadata (claims) without bumping its revision. */
export function updateTimeline(id: string, fn: (t: Timeline) => void): Promise<Timeline | null> {
  return withLock(`timeline:${id}`, async () => {
    const t = await getTimeline(id)
    if (!t) return null
    fn(t)
    return saveTimeline(t)
  })
}

export async function createTimeline(projectId: string, partial: Partial<Sequence> & { note?: string } = {}): Promise<Timeline> {
  const seq = blankSequence(partial.name ?? 'Timeline')
  const t = timelineFromSequence({ ...seq, ...partial, id: partial.id ?? seq.id }, projectId)
  t.rev = 1
  return saveTimeline(t)
}

export async function deleteTimeline(id: string): Promise<boolean> {
  const path = tlPath(id)
  if (!(await Bun.file(path).exists())) return false
  await unlink(path)
  return true
}

/** The project's timelines, in its display order; ids without a document are dropped. */
export async function loadTimelines(p: Project): Promise<Timeline[]> {
  const out: Timeline[] = []
  for (const id of p.timelineIds ?? []) {
    const t = await getTimeline(id).catch(() => null)
    if (t) out.push(t)
  }
  return out
}

/** Cheap enough to poll: id, revision and claim per timeline. */
export async function listTimelineRevs(p: Project): Promise<Array<{ id: string; name: string; rev: number; updatedAt: number; claimedBy: Timeline['claimedBy'] }>> {
  const out = []
  for (const t of await loadTimelines(p)) {
    out.push({ id: t.id, name: t.name, rev: t.rev, updatedAt: t.updatedAt, claimedBy: t.claimedBy ?? null })
  }
  return out
}

/** Every timeline in the project that nests `id`. */
export async function timelinesNesting(p: Project, id: string): Promise<Timeline[]> {
  const out: Timeline[] = []
  for (const t of await loadTimelines(p)) {
    if (t.id === id) continue
    if (t.tracks.some((tr) => tr.items.some((i) => i.type === 'timeline' && i.sourceId === id))) out.push(t)
  }
  return out
}

/* ------------------------------------------------------------- sequences */

/**
 * A sequence is the timeline: tracks against time, with the animation clips
 * above as one item type among several.
 *
 * Tracks are stored in **display order, top to bottom** — video tracks first,
 * audio after. Compositing runs the other way, so the last video track in the
 * array is the bottom layer. Both the preview's z-index and the render's
 * overlay order derive from that one rule.
 */

export type TrackKind = 'video' | 'audio'
export type ItemType = 'media' | 'animation' | 'caption' | 'text' | 'timeline' | 'image'

/** Style fields a text preset reads. Compiles to CSS, so it stays editable. */
export interface TextStyle {
  fontFamily?: string
  fontSize?: number
  color?: string
  accent?: string
  boxColor?: string
  weight?: number
  uppercase?: boolean
  align?: 'left' | 'center' | 'right'
}
export type ItemFit = 'contain' | 'cover' | 'fill' | 'none'
export type ItemAnchor =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** How an imported transcript is drawn. Compiles to CSS, so it stays editable. */
export interface CaptionStyle {
  fontFamily: string
  fontSize: number
  color: string
  weight: number
  boxColor: string
  position: 'bottom' | 'top' | 'center'
  marginPx: number
  maxWidthPct: number
  uppercase: boolean
  shadow: boolean
  /** How a cue arrives and leaves. */
  transition?: 'cut' | 'fade' | 'pop'
  /** Word highlight from word-level timings: the spoken word, or every word so far. */
  karaoke?: 'off' | 'word' | 'fill'
  accent?: string
}

export function defaultCaptionStyle(): CaptionStyle {
  return {
    fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
    fontSize: 54,
    color: '#ffffff',
    weight: 700,
    boxColor: '#000000a6',
    position: 'bottom',
    marginPx: 96,
    maxWidthPct: 80,
    uppercase: false,
    shadow: true,
    transition: 'cut',
    karaoke: 'off',
    accent: '#ffd166',
  }
}

export interface SequenceItem {
  id: string
  type: ItemType
  /** media filename · clip id · transcript id, depending on `type`. */
  sourceId: string
  name: string

  /** Position and length on the sequence timeline. */
  startMs: number
  durationMs: number
  /** In-point within the source. Meaningless for animation items, which
   *  always play from their own zero. */
  inMs: number

  fit: ItemFit
  anchor: ItemAnchor
  offsetX: number
  offsetY: number
  opacity: number

  volume: number
  muted: boolean
  fadeInMs: number
  fadeOutMs: number

  captionStyle?: CaptionStyle
  /** Text items: what is typed, and how the preset draws it. */
  text?: string
  subtext?: string
  textStyle?: TextStyle
  note?: string
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  items: SequenceItem[]
  muted: boolean
  hidden: boolean
  locked: boolean
  /** Lane height in px; absent means the default for the kind. */
  height?: number
  /** Free text for whoever edits next — a person, or an agent reading get_timeline. */
  note?: string
  /** A swatch colour, purely visual. */
  color?: string
}

export interface Sequence {
  id: string
  name: string
  width: number
  height: number
  fps: number
  background: Background
  tracks: Track[]
}

export function blankTrack(kind: TrackKind, name: string): Track {
  return { id: newId('t_'), kind, name, items: [], muted: false, hidden: false, locked: false }
}

export function blankSequence(name = 'Sequence 1'): Sequence {
  return {
    id: newId('s_'),
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    background: { mode: 'color', color: '#000000' },
    tracks: [
      blankTrack('video', 'V2'),
      blankTrack('video', 'V1'),
      blankTrack('audio', 'A1'),
    ],
  }
}

/** Where the last item ends. A sequence is exactly as long as its content. */
export function sequenceDurationMs(seq: Sequence): number {
  let end = 0
  for (const track of seq.tracks) {
    for (const item of track.items) {
      end = Math.max(end, item.startMs + item.durationMs)
    }
  }
  return Math.round(end)
}
