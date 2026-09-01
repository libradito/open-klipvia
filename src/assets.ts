/**
 * Global asset library — images and fonts that any clip can reference.
 *
 * Files are served from /assets/<filename>, which is same-origin with the
 * editor. That matters: the rasterizer inlines every external reference before
 * snapshotting, and it must fetch these directly rather than through the
 * /api/asset proxy, which deliberately refuses localhost.
 */

import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'

export const ASSET_DIR = join(process.cwd(), 'data', 'assets')
/** Sidecars: probed size, and for sprite sheets the grid — the media library's pattern. */
export const ASSET_META_DIR = join(ASSET_DIR, '.meta')

export const MAX_ASSET_BYTES = 32 * 1024 * 1024

/** extension -> [mime, kind] */
const ALLOWED: Record<string, [string, 'image' | 'font']> = {
  '.png': ['image/png', 'image'],
  '.jpg': ['image/jpeg', 'image'],
  '.jpeg': ['image/jpeg', 'image'],
  '.webp': ['image/webp', 'image'],
  '.gif': ['image/gif', 'image'],
  '.avif': ['image/avif', 'image'],
  '.svg': ['image/svg+xml', 'image'],
  '.woff2': ['font/woff2', 'font'],
  '.woff': ['font/woff', 'font'],
  '.ttf': ['font/ttf', 'font'],
  '.otf': ['font/otf', 'font'],
}

/** A sprite sheet's grid: what a CSS steps() animation needs to play it. */
export interface SpriteMeta {
  cols: number
  rows: number
  frameWidth: number
  frameHeight: number
  frames: number
  fps: number
  fromMs: number
  toMs: number
  /** The media file it was cut from. */
  source: string
}

export interface Asset {
  filename: string
  name: string
  url: string
  mime: string
  kind: 'image' | 'font'
  size: number
  width: number | null
  height: number | null
  modified: number
  sprite?: SpriteMeta
  /** Which media file and time a frame grab came from, when it did. */
  origin?: { source: string; atMs: number }
}

interface AssetMeta {
  name?: string
  width?: number | null
  height?: number | null
  sprite?: SpriteMeta
  origin?: { source: string; atMs: number }
}

function metaPath(filename: string) {
  return join(ASSET_META_DIR, `${filename}.json`)
}

async function readAssetMeta(filename: string): Promise<AssetMeta | null> {
  const file = Bun.file(metaPath(filename))
  if (!(await file.exists())) return null
  try {
    return (await file.json()) as AssetMeta
  } catch {
    return null
  }
}

export async function writeAssetMeta(filename: string, meta: AssetMeta): Promise<void> {
  await mkdir(ASSET_META_DIR, { recursive: true })
  const current = (await readAssetMeta(filename)) ?? {}
  await Bun.write(metaPath(filename), JSON.stringify({ ...current, ...meta }, null, 2))
}

export function mimeFor(filename: string): { mime: string; kind: 'image' | 'font' } | null {
  const entry = ALLOWED[extname(filename).toLowerCase()]
  return entry ? { mime: entry[0], kind: entry[1] } : null
}

/** Reject anything that could escape the asset directory. */
export function safeAssetName(filename: string): string | null {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null
  }
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return null
  return mimeFor(filename) ? filename : null
}

function slug(name: string): string {
  const base = basename(name, extname(name))
  return (
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .toLowerCase() || 'asset'
  )
}

/** Pixel dimensions, via ffprobe for raster formats and a parse for SVG. */
async function probeSize(path: string, kind: string, mime: string): Promise<{ w: number | null; h: number | null }> {
  if (kind !== 'image') return { w: null, h: null }

  if (mime === 'image/svg+xml') {
    try {
      const text = await Bun.file(path).text()
      const head = text.slice(0, 4000)
      const w = head.match(/\bwidth\s*=\s*["']([\d.]+)/i)
      const h = head.match(/\bheight\s*=\s*["']([\d.]+)/i)
      if (w && h) return { w: Math.round(+w[1]!), h: Math.round(+h[1]!) }
      const vb = head.match(/viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i)
      if (vb) return { w: Math.round(+vb[1]!), h: Math.round(+vb[2]!) }
    } catch {
      /* fall through */
    }
    return { w: null, h: null }
  }

  try {
    const p = Bun.spawn(
      ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const out = (await new Response(p.stdout).text()).trim()
    await p.exited
    const [w, h] = out.split(',').map((n) => parseInt(n, 10))
    if (Number.isFinite(w) && Number.isFinite(h)) return { w: w!, h: h! }
  } catch {
    /* ffprobe missing or unreadable file */
  }
  return { w: null, h: null }
}

export async function saveAsset(
  originalName: string,
  bytes: Uint8Array,
): Promise<{ ok: true; asset: Asset } | { ok: false; error: string }> {
  const info = mimeFor(originalName)
  if (!info) {
    return { ok: false, error: `unsupported file type "${extname(originalName) || originalName}"` }
  }
  if (bytes.byteLength === 0) return { ok: false, error: 'empty file' }
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return { ok: false, error: `file is larger than ${MAX_ASSET_BYTES / 1024 / 1024}MB` }
  }

  await mkdir(ASSET_DIR, { recursive: true })
  const id = Math.random().toString(36).slice(2, 8)
  const filename = `${slug(originalName)}-${id}${extname(originalName).toLowerCase()}`
  const path = join(ASSET_DIR, filename)
  await Bun.write(path, bytes)

  const { w, h } = await probeSize(path, info.kind, info.mime)
  // The probe is cached, so a listing never re-runs ffprobe over the library.
  await writeAssetMeta(filename, { name: basename(originalName), width: w, height: h })
  return {
    ok: true,
    asset: {
      filename,
      name: basename(originalName),
      url: `/assets/${filename}`,
      mime: info.mime,
      kind: info.kind,
      size: bytes.byteLength,
      width: w,
      height: h,
      modified: Date.now(),
    },
  }
}

export async function listAssets(): Promise<Asset[]> {
  await mkdir(ASSET_DIR, { recursive: true })
  const names = (await readdir(ASSET_DIR)).filter((f) => !f.startsWith('.'))
  const out: Asset[] = []
  for (const filename of names) {
    const info = mimeFor(filename)
    if (!info) continue
    try {
      const path = join(ASSET_DIR, filename)
      const st = await stat(path)
      if (!st.isFile()) continue
      const meta = await readAssetMeta(filename)
      const { w, h } =
        meta && meta.width !== undefined
          ? { w: meta.width ?? null, h: meta.height ?? null }
          : await probeSize(path, info.kind, info.mime)
      out.push({
        filename,
        name: meta?.name ?? filename,
        url: `/assets/${filename}`,
        mime: info.mime,
        kind: info.kind,
        size: st.size,
        width: w,
        height: h,
        modified: st.mtimeMs,
        ...(meta?.sprite ? { sprite: meta.sprite } : {}),
        ...(meta?.origin ? { origin: meta.origin } : {}),
      })
    } catch {
      /* raced with a delete */
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}

export async function deleteAsset(filename: string): Promise<boolean> {
  const safe = safeAssetName(filename)
  if (!safe) return false
  const path = join(ASSET_DIR, safe)
  if (!(await Bun.file(path).exists())) return false
  await unlink(path)
  await unlink(metaPath(safe)).catch(() => {})
  return true
}
