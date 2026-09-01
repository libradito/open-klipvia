import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unlink } from 'node:fs/promises'

/**
 * ffmpeg encoding presets and job runner.
 *
 * Frames arrive from the browser as raw RGBA (straight, non-premultiplied alpha —
 * which is exactly what canvas `getImageData` produces and what ffmpeg's `rgba`
 * pixel format expects), so there is no intermediate PNG encode on either side.
 */

export interface FormatSpec {
  id: string
  label: string
  ext: string
  mime: string
  /** Whether the container/codec carries a real alpha channel. */
  alpha: boolean
  /** Short note surfaced in the export UI. */
  note: string
  args(opts: { quality: number }): string[]
}

export const FORMATS: Record<string, FormatSpec> = {
  mp4: {
    id: 'mp4',
    label: 'MP4 · H.264',
    ext: 'mp4',
    mime: 'video/mp4',
    alpha: false,
    note: 'Universal. No alpha — set the clip background to green for chroma keying.',
    args: ({ quality }) => [
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', String(quality),
      '-preset', 'medium',
      '-movflags', '+faststart',
      // H.264 4:2:0 requires even dimensions.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    ],
  },
  mov: {
    id: 'mov',
    label: 'MOV · ProRes 4444',
    ext: 'mov',
    mime: 'video/quicktime',
    alpha: true,
    note: 'True alpha, 12-bit. Drops straight into Premiere / Final Cut / Resolve. Large files.',
    args: () => [
      '-c:v', 'prores_ks',
      '-profile:v', '4444',
      '-pix_fmt', 'yuva444p10le',
      '-alpha_bits', '16',
      '-vendor', 'apl0',
    ],
  },
  qtrle: {
    id: 'qtrle',
    label: 'MOV · QuickTime Animation',
    ext: 'mov',
    mime: 'video/quicktime',
    alpha: true,
    note: 'Lossless RGBA. Ideal as a sequence overlay: exact edges, and a fraction of ProRes for graphics on an empty frame.',
    args: () => [
      '-c:v', 'qtrle',
      '-pix_fmt', 'argb',
    ],
  },
  webm: {
    id: 'webm',
    label: 'WebM · VP9',
    ext: 'webm',
    mime: 'video/webm',
    alpha: true,
    note: 'True alpha, small files, plays transparently in browsers.',
    args: ({ quality }) => [
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuva420p',
      '-crf', String(quality),
      '-b:v', '0',
      '-auto-alt-ref', '0',
      '-row-mt', '1',
    ],
  },
}

export interface JobOptions {
  format: string
  width: number
  height: number
  fps: number
  frameCount: number
  quality: number
  outPath: string
}

export type JobState = 'encoding' | 'finishing' | 'complete' | 'failed' | 'aborted'

export class EncodeJob {
  readonly id: string
  readonly opts: JobOptions
  readonly spec: FormatSpec
  readonly bytesPerFrame: number
  readonly startedAt = Date.now()

  state: JobState = 'encoding'
  framesWritten = 0
  error: string | null = null
  outSize = 0

  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private sink: Bun.FileSink
  private stderr: Promise<string>

  constructor(id: string, opts: JobOptions) {
    const spec = FORMATS[opts.format]
    if (!spec) throw new Error(`unknown format: ${opts.format}`)

    this.id = id
    this.opts = opts
    this.spec = spec
    this.bytesPerFrame = opts.width * opts.height * 4

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${opts.width}x${opts.height}`,
      '-framerate', String(opts.fps),
      '-i', 'pipe:0',
      ...spec.args({ quality: opts.quality }),
      opts.outPath,
    ]

    this.proc = Bun.spawn(['ffmpeg', ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>

    this.sink = this.proc.stdin as Bun.FileSink
    // Start draining stderr immediately so ffmpeg never blocks on a full pipe.
    this.stderr = new Response(this.proc.stderr).text()
  }

  /** Write one raw RGBA frame. Awaiting the flush gives us natural backpressure. */
  async writeFrame(bytes: Uint8Array): Promise<void> {
    if (this.state !== 'encoding') throw new Error(`job is ${this.state}`)
    if (bytes.byteLength !== this.bytesPerFrame) {
      throw new Error(
        `frame ${this.framesWritten}: expected ${this.bytesPerFrame} bytes ` +
          `(${this.opts.width}x${this.opts.height} RGBA), got ${bytes.byteLength}`,
      )
    }
    this.sink.write(bytes)
    await this.sink.flush()
    this.framesWritten++
  }

  async finish(): Promise<{ ok: boolean; size: number; error: string | null }> {
    if (this.state !== 'encoding') {
      return { ok: this.state === 'complete', size: this.outSize, error: this.error }
    }
    this.state = 'finishing'
    await this.sink.end()
    const code = await this.proc.exited
    const err = (await this.stderr).trim()

    if (code !== 0) {
      this.state = 'failed'
      this.error = err || `ffmpeg exited with code ${code}`
      return { ok: false, size: 0, error: this.error }
    }

    this.outSize = (await Bun.file(this.opts.outPath).exists())
      ? Bun.file(this.opts.outPath).size
      : 0

    if (this.outSize === 0) {
      this.state = 'failed'
      this.error = err || 'ffmpeg produced an empty file'
      return { ok: false, size: 0, error: this.error }
    }

    this.state = 'complete'
    // ffmpeg can succeed while still emitting warnings; keep them for the UI.
    this.error = err || null
    return { ok: true, size: this.outSize, error: null }
  }

  abort(): void {
    if (this.state === 'complete' || this.state === 'aborted') return
    this.state = 'aborted'
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
    // A half-written file has no index: some players open it, show no
    // duration and cannot seek. Better that it is not there at all.
    void unlink(this.opts.outPath).catch(() => {})
  }
}

/**
 * Which formats *actually* carry alpha on this machine.
 *
 * Asking the encoder what pixel formats it supports is not enough: some builds
 * of libvpx accept `-pix_fmt yuva420p` for VP9, report no error, and write a
 * plain yuv420p file. An overlay silently flattened to opaque black covers
 * everything beneath it in the render, and nothing in the log says so — so
 * every alpha format is encoded once and read back before it is offered.
 */
let alphaSupport: Record<string, boolean> | null = null

const ALPHA_PIX_FMT = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\b)/

async function encodesAlpha(spec: FormatSpec): Promise<boolean> {
  const tmp = join(tmpdir(), `ah-alpha-${spec.id}-${process.pid}.${spec.ext}`)
  try {
    const enc = Bun.spawn(
      [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64:r=1:d=1,format=rgba',
        '-frames:v', '1',
        ...spec.args({ quality: 20 }),
        tmp,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await new Response(enc.stderr).text()
    if ((await enc.exited) !== 0) return false

    const probe = Bun.spawn(
      ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', tmp],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const pixFmt = (await new Response(probe.stdout).text()).trim()
    await probe.exited
    return ALPHA_PIX_FMT.test(pixFmt)
  } catch {
    return false
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

/** Cached across calls; the answer cannot change while the server is up. */
export async function probeAlphaSupport(): Promise<Record<string, boolean>> {
  if (alphaSupport) return alphaSupport
  const out: Record<string, boolean> = {}
  for (const spec of Object.values(FORMATS)) {
    out[spec.id] = spec.alpha ? await encodesAlpha(spec) : false
  }
  alphaSupport = out
  return out
}

/** Verify ffmpeg is on PATH and report its version. */
export async function probeFfmpeg(): Promise<{ ok: boolean; version: string }> {
  try {
    const p = Bun.spawn(['ffmpeg', '-hide_banner', '-version'], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    if (code !== 0) return { ok: false, version: '' }
    return { ok: true, version: out.split('\n')[0] ?? '' }
  } catch {
    return { ok: false, version: '' }
  }
}
