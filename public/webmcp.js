/**
 * WebMCP integration — exposes the editor to browser-resident AI agents.
 *
 * The API is `document.modelContext`. It moved there from `navigator.modelContext`
 * on 2026-08-10; Chrome kept the old name as a deprecated alias, and the `@mcp-b`
 * polyfills still ship the older `provideContext()` surface. Both are handled.
 *
 * Two tool sets are registered: the clip tools (author one animation) and the
 * timeline tools (cut footage, sound, overlays and captions on the timeline).
 * Both drive the same `editor` facade the UI uses, so an agent's edits land
 * in the same undo history as a hand's.
 *
 * Enable locally with chrome://flags/#enable-webmcp-testing, then relaunch.
 * With the flag off this module registers nothing and the editor behaves exactly
 * as before.
 *
 * Chrome's tool security guide sets hard budgets that shape the design here:
 * names <= 30 chars, descriptions <= 500, parameter descriptions <= 150, and
 * tool output <= ~1.5K. That output cap is why `get_clip` takes a `fields`
 * argument and why `capture_frame` returns a URL rather than a base64 image.
 */

import { blendOf, colourOf, cropOf, flipsOf, radiusOf, rotationOf, shadowOf } from '/effects.js'
import { KEYABLE, keysFor } from '/keys.js'
import { baseLang, groupVoices, languageName } from '/languages.js'

const OUTPUT_BUDGET = 1500

let controller = null
let resultStyle = 'string'

/* ------------------------------------------------------------- plumbing */

function resolveContainer() {
  if (typeof document !== 'undefined' && document.modelContext) {
    return { ctx: document.modelContext, via: 'document.modelContext' }
  }
  if (typeof navigator !== 'undefined' && navigator.modelContext) {
    return { ctx: navigator.modelContext, via: 'navigator.modelContext (deprecated alias)' }
  }
  return { ctx: null, via: null }
}

/** Clamp to the output budget, telling the agent how to get the rest. */
function respond(text) {
  const s = String(text ?? '')
  if (s.length <= OUTPUT_BUDGET) return s
  // Size the marker first so the total never exceeds the budget.
  const marker = `\n…[truncated — ${s.length} chars total; request one field or one clip at a time]`
  return s.slice(0, Math.max(0, OUTPUT_BUDGET - marker.length)).trimEnd() + marker
}

/**
 * A picture, returned as itself.
 *
 * A tool that hands back an image must not hand back base64 in a sentence:
 * `respond()` cuts every result to the output budget, and a data URI cut in
 * half is a corrupt image the agent has no way to know is corrupt. It only
 * looks like it worked. Wrapping it marks the picture as something the budget
 * does not apply to, so the formatter can emit it as an MCP image block where
 * the runtime understands one and say where to look where it does not.
 */
export class ToolImage {
  constructor(text, dataUri, unavailable) {
    this.text = text
    this.dataUri = dataUri
    this.unavailable = unavailable
  }

  /** `data:image/png;base64,AAA…` → the two halves an image block wants. */
  parts() {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(this.dataUri ?? '')
    return m ? { mimeType: m[1], data: m[2] } : null
  }

  /** What to say when the picture cannot travel with the result. */
  fallback() {
    return `${this.text}. ${this.unavailable}`
  }
}

/**
 * Chrome's native execute() returns a bare string; the W3C spec and the
 * polyfills expect MCP content blocks. Emit whichever the live runtime wants.
 *
 * A failure carries `isError` as well as the sentence. The sentence is what an
 * agent reads, but the flag is what a harness checks, and a run that reports
 * "Playhead at 3.00s" and one that reports "seek_timeline failed" should not
 * be indistinguishable to anything counting successes. The bare-string style
 * has nowhere to put the flag and keeps saying it in words.
 */
function formatResult({ text, image, isError }) {
  // An image goes out only to a runtime that understands image blocks. Chrome's
  // native surface today serialises whatever it is handed to JSON and gives the
  // agent that string, so an image block there is 50KB of base64 in a sentence
  // — worse than the truncation it was meant to fix. `ToolImage.fallback()`
  // says where the picture is instead, and an agent sharing the tab can look.
  if (image && resultStyle === 'content') {
    return { content: [{ type: 'text', text }, { type: 'image', ...image }] }
  }
  if (resultStyle !== 'content') return text
  const content = [{ type: 'text', text }]
  return isError ? { content, isError: true } : { content }
}

/** Agents recover from a described failure far better than from a rejection. */
async function runSafely(tool, input, opts) {
  try {
    const out = await tool.run(input ?? {}, opts ?? {})
    if (out instanceof ToolImage) {
      const image = resultStyle === 'content' ? out.parts() : null
      return image ? { text: respond(out.text), image } : { text: respond(out.fallback()) }
    }
    return { text: respond(out) }
  } catch (err) {
    return { text: respond(`${tool.name} failed: ${err?.message ?? err}`), isError: true }
  }
}

/* ------------------------------------------------------------ formatting */

const secs = (ms) => `${(ms / 1000).toFixed(2)}s`

/**
 * How a captured frame comes back.
 *
 * With a server, the frame is a file and a URL is the cheapest thing to hand
 * over: the agent fetches it when it wants it, and nothing large crosses the
 * tool boundary. With no server there is no URL anyone outside the page can
 * fetch — a blob: URL resolves only in the page that made it — so the frame
 * itself is the answer, attached as an image rather than spelled out in the
 * sentence.
 */
function capturedFrame(text, url, unavailable) {
  return url?.startsWith('data:') ? new ToolImage(text, url, unavailable) : `${text} → ${url}. Fetch that URL to view it.`
}

/**
 * Where a finished render went.
 *
 * With a server it is a file and a URL, and `list_exports` finds it again.
 * With none it is a `blob:` URL — private to the page that made it, gone when
 * the tab closes, and unfetchable by anything outside. Printing one told an
 * agent nothing and implied a file it could go and get. The browser's
 * downloads folder is where it actually is, so that is what the result says.
 */
function renderedTo(url) {
  return url?.startsWith('blob:') ? "Saved to the browser's downloads." : `Saved → ${url}`
}

/**
 * Where the audio went, said in every result that moved any.
 *
 * Without this an agent can upload a customer's footage to a company on the
 * other side of the world and report it back in language indistinguishable
 * from work done on the machine in front of them. The destination is not a
 * detail of the job, it is half of what the job was.
 */
const destination = (d) =>
  d.leaves ? `The audio was sent to ${d.host ?? d.label}.` : 'It ran on your own machine; nothing left the computer.'

/**
 * Agent-initiated uploads are off until somebody says otherwise.
 *
 * A person choosing a provider consents to their own sends. It does not follow
 * that they consent to a model deciding, unprompted, to post an hour of footage
 * to it — and transcripts flow back into an agent's context, so the instruction
 * to do so need not even come from them. The switch is in the panel, off.
 */
function egressRefused(job, d) {
  return (
    `${job} sends audio to ${d.host ?? d.label}, and agent-initiated sending is switched off. ` +
    `Ask the person to run it themselves, or to turn on "Let an agent send audio out" under Speech providers. ` +
    `Anything set to run on their own machine works without that.`
  )
}

/**
 * What to say when speech has not been set up.
 *
 * A plan rather than a refusal: the person can fix this in about thirty
 * seconds, and an agent that knows where the button is can tell them, which is
 * far more use than a failure the model has to interpret.
 */
function notSetUp(what, detail) {
  return (
    `No ${what} is set up in this browser yet` +
    (detail?.set ? ` — ${detail.label} is chosen but ${detail.why}.` : '.') +
    `\nAsk the person to open the Speech tab in the left rail and press Providers… (the Transcribe a clip… and Write a voice-over… buttons there ask on their own). There are three kinds of answer: ` +
    `their computer's own voices (free, offline, nothing sent), a Whisper or voice server on their own machine, ` +
    `or a hosted provider with their key. Only they can enter a key. ` +
    `time_script needs none of it and works now.`
  )
}

/** A single frame is left on the stage, so an agent sharing the tab can look. */
const ON_STAGE = 'The stage is parked on that frame, so look at the page to see it.'
/** A sheet is only ever a file; with no server and no image support it is lost. */
const SHEET_LOST =
  'This runtime cannot carry the sheet and this build has no server to host it — capture single frames instead, which the stage does show.'

function describeBackground(bg) {
  if (bg.mode === 'transparent') return 'transparent'
  return bg.color.toLowerCase() === '#00b140' ? `green screen (${bg.color})` : bg.color
}

function clipLine(clip, selectedId) {
  return (
    `${clip.id === selectedId ? '* ' : '  '}${clip.id}  "${clip.name}"  ` +
    `${clip.width}x${clip.height}  ${secs(clip.durationMs)}  ${clip.fps}fps  ` +
    `bg:${describeBackground(clip.background)}`
  )
}

/** 'transparent' | 'green' | '#rrggbb' -> the stored background shape. */
function parseBackground(value) {
  const v = String(value).trim().toLowerCase()
  if (v === 'transparent') return { mode: 'transparent', color: '#00b140' }
  if (v === 'green' || v === 'greenscreen' || v === 'green screen') {
    return { mode: 'color', color: '#00b140' }
  }
  if (/^#[0-9a-f]{6}$/.test(v)) return { mode: 'color', color: v }
  throw new Error(`background must be "transparent", "green", or #rrggbb — got "${value}"`)
}

/** What a new asset or media file is called back as. Short: never the bytes it came from. */
const addedAsset = (a) =>
  `Added ${a.url}${a.width ? ` (${a.width}x${a.height})` : ''}, ${(a.size / 1024).toFixed(0)}KB. Use it with <img src="${a.url}">, or on the timeline with add_to_timeline kind image.`
const addedMedia = (m) =>
  `Added ${m.filename}: ${m.kind}, ${(m.durationMs / 1000).toFixed(2)}s${m.hasVideo ? `, ${m.width}x${m.height}` : ''}${m.hasAudio ? ', with audio' : ', silent'}. Use it as sourceId in add_to_timeline.`

/* ---------------------------------------------------------------- tools */

function buildTools(editor) {
  /** Resolve an optional clipId to a clip, defaulting to the selected one. */
  const pick = (id) => {
    if (!id) {
      const cur = editor.currentClip()
      if (!cur) throw new Error('no clip is selected')
      return cur
    }
    const found = editor.getClips().find((c) => c.id === id)
    if (!found) {
      throw new Error(`no clip "${id}". Use list_clips to see valid ids.`)
    }
    return found
  }

  const clipIdProp = {
    type: 'string',
    description: 'Clip id from list_clips. Omit to use the currently selected clip.',
  }
  const backgroundProp = {
    type: 'string',
    description: 'Background: "transparent" for alpha export, "green" for chroma key, or a #rrggbb colour.',
  }

  return [
    /* ------------------------------------------------------- read-only */
    {
      name: 'list_clips',
      description:
        'List the clips of the open project with id, name, pixel size, duration, frame rate and background. The selected clip is marked with an asterisk. Filter by a name fragment with query; page with offset (40 per page). Start here to discover clip ids.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Only clips whose name contains this, case-insensitive.' },
          offset: { type: 'integer', description: 'Skip this many matches (paging).' },
        },
      },
      run: ({ query, offset } = {}) => {
        const all = editor.getClips()
        if (!all.length) return 'No clips. Use create_clip to add one.'
        const sel = editor.currentClip()?.id
        const q = String(query ?? '').trim().toLowerCase()
        const clips = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all
        if (!clips.length) return `No clip matches "${query}".`
        const PAGE = 40
        const from = Math.max(0, Math.min(clips.length - 1, Math.round(offset ?? 0)))
        const page = clips.slice(from, from + PAGE)
        const compact = clips.length > 24
        const line = (c) => (compact ? `${c.id === sel ? '* ' : '  '}${c.id}  "${c.name}"  ${secs(c.durationMs)}` : clipLine(c, sel))
        const more = from + PAGE < clips.length ? `\n…${clips.length - from - PAGE} more — offset: ${from + PAGE}` : ''
        return `Project "${editor.getProjectName()}" — ${clips.length}${q ? ` matching "${query}"` : ''} of ${all.length} clip(s)${from ? ` (from ${from})` : ''}:\n` +
          page.map(line).join('\n') + more
      },
    },
    {
      name: 'get_clip',
      description:
        'Read one clip. By default returns only its settings. Pass fields to read the source, e.g. ["css"]. Output is capped at ~1.5K characters, so request one field at a time for long files.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          fields: {
            type: 'array',
            items: { type: 'string', enum: ['settings', 'html', 'css', 'js'] },
            description: 'Which parts to return. Defaults to ["settings"].',
          },
        },
      },
      run: ({ clipId, fields }) => {
        const clip = pick(clipId)
        const want = Array.isArray(fields) && fields.length ? fields : ['settings']
        const out = []
        if (want.includes('settings')) {
          out.push(
            `id: ${clip.id}\nname: ${clip.name}\nsize: ${clip.width}x${clip.height}\n` +
              `duration: ${secs(clip.durationMs)}\nfps: ${clip.fps}\n` +
              `background: ${describeBackground(clip.background)}\n` +
              `code sizes: html ${clip.html.length}, css ${clip.css.length}, js ${clip.js.length} chars`,
          )
        }
        for (const f of ['html', 'css', 'js']) {
          if (want.includes(f)) out.push(`--- ${f} ---\n${clip[f] || '(empty)'}`)
        }
        return out.join('\n\n')
      },
    },
    {
      name: 'get_stage_state',
      description:
        'Current preview state: selected clip, the virtual clock position, whether the stage is mounted, and any JavaScript errors thrown by the clip. Call this after set_clip_code to check the animation actually runs.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const s = editor.getStageState()
        const clip = editor.currentClip()
        return (
          `clip: ${clip ? `${clip.id} "${clip.name}"` : 'none'}\n` +
          `mounted: ${s.mounted}\ntime: ${secs(s.timeMs)} of ${secs(s.durationMs)}\n` +
          `busy: ${s.busy}\n` +
          `errors: ${s.errors ? `\n${s.errors}` : 'none'}`
        )
      },
    },
    {
      name: 'list_exports',
      description:
        'List recently rendered files (videos from render_clip and PNGs from capture_frame), newest first, with size and a URL to fetch.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const rows = await editor.listExports()
        if (!rows.length) return 'No exports yet.'
        return rows
          .slice(0, 20)
          .map((r) => `${r.name}  ${(r.size / 1024).toFixed(0)}KB  /api/exports/${r.name}`)
          .join('\n')
      },
    },

    /* ----------------------------------------------------------- write */
    {
      name: 'get_clip_animations',
      description:
        'Every animation in a clip with the exact second it starts and ends, gathered without moving the preview. Use it to verify pacing before rendering — a stagger shows as one row with each instance listed.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { clipId: clipIdProp } },
      run: async ({ clipId }) => {
        const clip = pick(clipId)
        const anims = await editor.probeTimeline(clip.id)
        if (!anims.length) return `${clip.name} has no animations.`

        const groups = new Map()
        for (const a of anims) {
          const key = `${a.label} · ${a.name}`
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(a)
        }
        const rows = [...groups]
          .sort((a, b) => a[1][0].start - b[1][0].start)
          .map(([key, list]) => {
            const starts = list.map((a) => (a.start / 1000).toFixed(2)).join(', ')
            const end = Math.max(...list.map((a) => a.end)) / 1000
            return list.length > 1
              ? `${key} ×${list.length}  starts ${starts}  last ends ${end.toFixed(2)}s`
              : `${key}  ${(list[0].start / 1000).toFixed(2)}–${end.toFixed(2)}s`
          })
        return `${clip.name} · ${secs(clip.durationMs)} · ${anims.length} animations\n` + rows.join('\n')
      },
    },
    {
      name: 'check_clip',
      description:
        'Preflight a clip for the faults that only surface after rendering: images that failed to load, animations that run past the end of the clip, elements sitting entirely off-frame, JS errors, and dead time at the tail.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: { type: 'object', properties: { clipId: clipIdProp } },
      run: async ({ clipId }) => {
        const clip = pick(clipId)
        const r = await editor.checkClip(clip.id)
        const out = []

        if (r.errors.length) out.push(`ERROR clip JS threw: ${r.errors.join(' | ')}`)
        if (r.brokenImages.length) {
          out.push(`ERROR ${r.brokenImages.length} image(s) failed to load: ${r.brokenImages.join(', ')}`)
        }
        if (r.overruns.length) {
          const worst = Math.max(...r.overruns.map((o) => o.end))
          out.push(
            `WARN ${r.overruns.length} animation(s) run past the ${secs(clip.durationMs)} clip ` +
              `(latest ends ${secs(worst)}) — they will be cut mid-motion. Lengthen the clip or shorten them.`,
          )
        }
        if (r.offstage.length) {
          out.push(`WARN entirely off-frame: ${r.offstage.join(', ')}`)
        }
        if (r.deadTailMs > 1500 && r.lastAnimationEnd > 0) {
          out.push(`INFO all motion ends at ${secs(r.lastAnimationEnd)}, leaving ${secs(r.deadTailMs)} of still frames.`)
        }
        out.push(`INFO renders ${r.frames} frames at ${clip.fps}fps.`)
        return (out.length === 1 ? 'No problems found.\n' : '') + out.join('\n')
      },
    },
    {
      name: 'list_projects',
      description: 'List every saved project with its id and clip count. The open one is marked with an asterisk.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const rows = await editor.listProjects()
        const open = editor.currentProjectId()
        if (!rows.length) return 'No projects yet.'
        return rows
          .map((p) => `${p.id === open ? '* ' : '  '}${p.id}  "${p.name}"  ${p.clipCount} clip(s)`)
          .join('\n')
      },
    },
    {
      name: 'list_assets',
      description:
        'List the images and fonts in the asset library, with their URLs and pixel sizes. Reference one from a clip with <img src="/assets/NAME"> or url("/assets/NAME"). Sprite sheets (from extract_sprite) show their grid; play one with the CSS extract_sprite returned. An image asset can also go on the timeline as a still: add_to_timeline with kind image.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const rows = await editor.listAssets()
        if (!rows.length) return 'No assets yet. Use add_asset_from_url (a public or data: URL), add_asset_text for an SVG, or drag a file into the editor.'
        return rows
          .slice(0, 30)
          .map(
            (a) =>
              `${a.url}  ${a.kind}${a.width ? `  ${a.width}x${a.height}` : ''}  ${(a.size / 1024).toFixed(0)}KB` +
              (a.sprite ? `  SPRITE ${a.sprite.frames}f ${a.sprite.cols}x${a.sprite.rows} @${a.sprite.fps}fps from ${a.sprite.source}` : '') +
              (a.origin ? `  frame of ${a.origin.source} @${(a.origin.atMs / 1000).toFixed(2)}s` : ''),
          )
          .join('\n')
      },
    },
    {
      name: 'add_asset_from_url',
      description:
        'Bring an image or font into the asset library and get its /assets/ URL, ready for a clip. url is a public http(s) URL, or — when you hold the bytes yourself — a data: URL (base64; 8 MB decoded at most). The bytes are sniffed: png, jpg, webp, gif, avif, svg, woff2, woff, ttf, otf; anything else is refused. For an SVG you wrote, add_asset_text is simpler.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public http(s) URL, or data:<mime>;base64,… holding the file (8 MB decoded max).' },
          name: { type: 'string', description: 'Optional filename. Its extension is corrected if it disagrees with the bytes.' },
        },
        required: ['url'],
      },
      run: async ({ url, name }) => {
        const a = await editor.addAssetFromUrl(url, name)
        return addedAsset(a)
      },
    },
    {
      name: 'add_asset_text',
      description:
        'Save an SVG you wrote as an asset and get its /assets/ URL — a logo, an icon, a shape to animate. name must end in .svg (the one text format the library stores); content is the SVG document, 2 MB at most. Nothing is sanitised: it is a same-origin file, like one the person dropped in. For a raster image or a font, use add_asset_from_url with a data: URL.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename ending in .svg, e.g. "logo.svg".' },
          content: { type: 'string', description: 'The SVG document, starting with <svg …>.' },
        },
        required: ['name', 'content'],
      },
      run: async ({ name, content }) => {
        const a = await editor.addAssetText(name, content)
        return addedAsset(a)
      },
    },
    {
      name: 'create_clip',
      description:
        'Add a new clip to the project and select it. Defaults to 1920x1080, 3s, 30fps, transparent. The new clip starts from a simple placeholder animation; follow with set_clip_code or apply_snippet.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Clip name.' },
          width: { type: 'integer', description: 'Width in pixels, 16-7680.' },
          height: { type: 'integer', description: 'Height in pixels, 16-7680.' },
          durationSeconds: { type: 'number', description: 'Clip length in seconds.' },
          fps: { type: 'integer', description: 'Frames per second, 1-120.' },
          background: backgroundProp,
        },
      },
      run: async (input) => {
        const clip = await editor.createClip({
          name: input.name,
          width: input.width,
          height: input.height,
          durationMs: input.durationSeconds != null ? input.durationSeconds * 1000 : undefined,
          fps: input.fps,
          background: input.background ? parseBackground(input.background) : undefined,
        })
        return `Created and selected ${clip.id} "${clip.name}" (${clip.width}x${clip.height}, ${secs(clip.durationMs)}, ${clip.fps}fps, bg ${describeBackground(clip.background)}).`
      },
    },
    {
      name: 'set_clip_code',
      description:
        'Replace a clip\'s HTML, CSS and/or JS. Only the fields you pass change. The preview rebuilds and the clock resets to 0. CSS keyframes, Web Animations, requestAnimationFrame and setTimeout are all seekable and export frame-exact.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          html: { type: 'string', description: 'Body markup. No <html> or <body> wrapper.' },
          css: { type: 'string', description: 'Stylesheet. The stage is exactly the clip size.' },
          js: { type: 'string', description: 'Script run after the markup parses.' },
        },
      },
      run: async ({ clipId, html, css, js }) => {
        const clip = pick(clipId)
        const patch = {}
        for (const [k, v] of Object.entries({ html, css, js })) {
          if (typeof v === 'string') patch[k] = v
        }
        if (!Object.keys(patch).length) return 'Nothing to change: pass html, css or js.'
        await editor.setClipCode(clip.id, patch)
        const state = editor.getStageState()
        return (
          `Updated ${Object.keys(patch).join(', ')} on ${clip.id}. Preview rebuilt at 0s.` +
          (state.errors ? `\nClip JS reported errors:\n${state.errors}` : '')
        )
      },
    },
    {
      name: 'set_clip_settings',
      description:
        'Change a clip\'s name, size, duration, frame rate or background without touching its code. Setting background to "transparent" is what makes an alpha export possible; "green" gives a chroma key for MP4.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          name: { type: 'string', description: 'Clip name.' },
          width: { type: 'integer', description: 'Width in pixels, 16-7680.' },
          height: { type: 'integer', description: 'Height in pixels, 16-7680.' },
          durationSeconds: { type: 'number', description: 'Clip length in seconds.' },
          fps: { type: 'integer', description: 'Frames per second, 1-120.' },
          background: backgroundProp,
        },
      },
      run: async (input) => {
        const clip = pick(input.clipId)
        const patch = {}
        if (typeof input.name === 'string') patch.name = input.name
        if (input.width != null) patch.width = input.width
        if (input.height != null) patch.height = input.height
        if (input.durationSeconds != null) patch.durationMs = input.durationSeconds * 1000
        if (input.fps != null) patch.fps = input.fps
        if (input.background != null) patch.background = parseBackground(input.background)
        if (!Object.keys(patch).length) return 'Nothing to change.'

        const updated = await editor.setClipSettings(clip.id, patch)
        return `Updated ${clip.id}: ${updated.width}x${updated.height}, ${secs(updated.durationMs)}, ${updated.fps}fps, bg ${describeBackground(updated.background)}.`
      },
    },
    {
      name: 'apply_snippet',
      description:
        'Overwrite a clip with one of the built-in starter animations. Useful as a working base to then modify with set_clip_code.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          snippet: {
            type: 'string',
            enum: editor.snippetNames(),
            description: 'Which starter to apply.',
          },
        },
        required: ['snippet'],
      },
      run: async ({ clipId, snippet }) => {
        const clip = pick(clipId)
        await editor.applySnippet(clip.id, snippet)
        return `Applied "${snippet}" to ${clip.id}. Preview rebuilt at 0s.`
      },
    },
    {
      name: 'open_project',
      description: 'Switch the editor to another project. Clip tools then act on that project.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project id from list_projects.' } },
        required: ['projectId'],
      },
      run: async ({ projectId }) => {
        const p = await editor.openProject(projectId)
        return `Opened "${p.name}" with ${p.clips.length} clip(s). Selected ${p.clips[0]?.name ?? 'none'}.`
      },
    },
    {
      name: 'create_project',
      description: 'Create a new project, open it, and select its starter clip. Use this to keep unrelated work apart rather than piling clips into one project.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Project name.' } },
        required: ['name'],
      },
      run: async ({ name }) => {
        const p = await editor.createProject(name)
        return `Created and opened "${p.name}" (${p.id}). Its starter clip ${p.clips[0].id} is selected.`
      },
    },
    {
      name: 'duplicate_clip',
      description: 'Copy a clip, insert it after the original and select it. The fastest way to make a variant without resending all the code.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { clipId: clipIdProp } },
      run: async ({ clipId }) => {
        const src = pick(clipId)
        const copy = await editor.duplicateClip(src.id)
        return `Duplicated ${src.id} as ${copy.id} "${copy.name}", now selected.`
      },
    },
    {
      name: 'patch_clip_code',
      description:
        'Change one snippet of a clip\'s code without resending the whole file. Fails if the text is absent, or ambiguous unless all:true. Prefer this over set_clip_code for tweaks like a colour or a timing value.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          pane: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which pane to edit.' },
          find: { type: 'string', description: 'Exact text to replace. Include enough context to be unique.' },
          replace: { type: 'string', description: 'Replacement text.' },
          all: { type: 'boolean', description: 'Replace every occurrence instead of failing on ambiguity.' },
        },
        required: ['pane', 'find', 'replace'],
      },
      run: async ({ clipId, pane, find, replace, all }) => {
        const clip = pick(clipId)
        const r = await editor.patchClipCode(clip.id, pane, find, replace, all === true)
        const state = editor.getStageState()
        return (
          `Replaced ${r.replaced} occurrence(s) in ${pane}; it is now ${r.length} chars.` +
          (state.errors ? `\nClip JS reported errors:\n${state.errors}` : '')
        )
      },
    },
    {
      name: 'delete_clip',
      description: 'Remove a clip from the project. Refuses to delete the last remaining clip.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { clipId: { type: 'string', description: 'Clip id to delete.' } },
        required: ['clipId'],
      },
      run: async ({ clipId }) => {
        const clip = pick(clipId)
        if (editor.getClips().length <= 1) return 'Cannot delete the only clip in the project.'
        await editor.deleteClip(clip.id)
        return `Deleted ${clip.id} "${clip.name}".`
      },
    },
    {
      name: 'select_clip',
      description: 'Make a clip the active one in the editor. Other tools default to the selected clip.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { clipId: { type: 'string', description: 'Clip id to select.' } },
        required: ['clipId'],
      },
      run: async ({ clipId }) => {
        const clip = pick(clipId)
        await editor.selectClip(clip.id)
        return `Selected ${clip.id} "${clip.name}".`
      },
    },
    {
      name: 'seek_preview',
      description:
        'Move the preview to a point in time so the next capture_frame shows that moment. Seeking backwards rebuilds the clip from 0 first, which is normal.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: { type: 'number', description: 'Time within the clip, in seconds.' },
        },
        required: ['timeSeconds'],
      },
      run: async ({ timeSeconds }) => {
        const clip = pick()
        const ms = Math.max(0, Math.min(clip.durationMs, timeSeconds * 1000))
        await editor.seek(ms)
        return `Preview at ${secs(ms)} of ${secs(clip.durationMs)}.`
      },
    },
    {
      name: 'capture_frame',
      description:
        'Render frames to a PNG and show it. With a server you get a URL to fetch; with no server the preview is left on that frame for you to look at, and the picture is attached to the result where the runtime supports images. With count > 1 you get a labelled contact sheet spread across the clip — the quickest way to judge motion without rendering video. Much faster than render_clip.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          timeSeconds: {
            type: 'number',
            description: 'Moment to capture, in seconds. Defaults to the current preview time. Ignored when count > 1.',
          },
          count: {
            type: 'integer',
            description: 'Number of frames, 2-12. Produces one tiled contact sheet labelled with timestamps.',
          },
          fromSeconds: { type: 'number', description: 'Start of the range for a contact sheet. Default 0.' },
          toSeconds: { type: 'number', description: 'End of the range for a contact sheet. Default the clip end.' },
        },
      },
      run: async ({ clipId, timeSeconds, count, fromSeconds, toSeconds }) => {
        const clip = pick(clipId)

        if (count && count > 1) {
          const r = await editor.captureStrip(clip.id, {
            count,
            fromMs: fromSeconds != null ? fromSeconds * 1000 : 0,
            toMs: toSeconds != null ? toSeconds * 1000 : null,
          })
          return capturedFrame(`Contact sheet of ${r.frames} frames (${r.cols}x${r.rows}, timestamped), ${(r.size / 1024).toFixed(0)}KB`, r.url, SHEET_LOST)
        }

        const r = await editor.captureFrame(clip.id, timeSeconds != null ? timeSeconds * 1000 : null)
        return capturedFrame(`Captured ${clip.id} at ${secs(r.timeMs)}, ${clip.width}x${clip.height}, ${(r.size / 1024).toFixed(0)}KB`, r.url, ON_STAGE)
      },
    },
    {
      name: 'render_clip',
      description:
        'Render the clip to a video file, frame by frame, and return its URL. mov = ProRes 4444 with true alpha; webm = VP9 with alpha; mp4 = H.264 with no alpha (set the background to green first). Takes seconds to minutes.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          clipId: clipIdProp,
          format: {
            type: 'string',
            enum: ['mov', 'webm', 'mp4'],
            description: 'mov and webm carry alpha; mp4 does not. Defaults to mov.',
          },
          quality: {
            type: 'integer',
            description: 'CRF for mp4/webm, lower is better. Ignored for mov. Default 18 (mp4) / 24 (webm).',
          },
        },
      },
      run: async ({ clipId, format, quality }) => {
        const clip = pick(clipId)
        const fmt = format ?? 'mov'
        if (clip.background.mode === 'transparent' && fmt === 'mp4') {
          return 'mp4 cannot store transparency. Either set the background to "green" and key it later, or render as mov or webm.'
        }
        const r = await editor.render(clip.id, { format: fmt, quality })
        return (
          `Rendered ${clip.id} "${clip.name}" as ${r.filename}. ${renderedTo(r.downloadUrl)}\n` +
          `${fmt}, ${clip.width}x${clip.height}, ${r.frames} frames at ${clip.fps}fps, ` +
          `${(r.size / 1024 / 1024).toFixed(1)}MB in ${(r.elapsedMs / 1000).toFixed(1)}s.`
        )
      },
    },
  ]
}

/* ------------------------------------------------------- timeline tools */

const fmtT = (ms) => (ms / 1000).toFixed(2)
/** A shape preset's inspector controls, in add_shape's own parameter names. */
const SHAPE_PARAM = { radius: 'corners', stroke: 'outlineWidth', accent: 'outline', direction: 'points', text: 'label' }

/**
 * The non-default parts of how an item is drawn.
 *
 * Without these the timeline read back to an agent described *when* every item
 * plays and nothing about how it looks, so `set_item` was a blind write: a
 * model asked to turn a title six degrees had no way to know it was already
 * turned, already keyframed, already scaled to 90%. Only what has been changed
 * from the default is listed, so an ordinary timeline reads exactly as before.
 */
function lookFlags(item) {
  const out = []
  const rot = rotationOf(item)
  if (rot) out.push(`turned ${rot}°`)
  if (Number(item.scale) && Number(item.scale) !== 1) out.push(`scale ${Number(item.scale)}`)
  if (item.offsetX || item.offsetY) out.push(`offset ${Math.round(item.offsetX || 0)},${Math.round(item.offsetY || 0)}`)

  const flip = flipsOf(item)
  if (flip.h || flip.v) out.push(`flipped ${[flip.h && 'H', flip.v && 'V'].filter(Boolean).join('+')}`)
  if (cropOf(item)) out.push('cropped')
  const blend = blendOf(item)
  if (blend) out.push(`blend ${blend}`)
  if (colourOf(item)) out.push('graded')
  const radius = radiusOf(item)
  if (radius) out.push(`radius ${radius}`)
  if (shadowOf(item)) out.push('shadow')

  const dIn = Math.round(Number(item.dissolveInMs) || 0)
  const dOut = Math.round(Number(item.dissolveOutMs) || 0)
  if (dIn || dOut) out.push(`dissolve ${dIn}/${dOut}ms`)
  const fIn = Math.round(Number(item.fadeInMs) || 0)
  const fOut = Math.round(Number(item.fadeOutMs) || 0)
  if (fIn || fOut) out.push(`fade ${fIn}/${fOut}ms`)

  // The one that changes what a write means: a keyed property is a curve, and
  // setting it flat throws the curve away. list_keyframes has the numbers.
  const keyed = KEYABLE.filter((prop) => keysFor(item, prop))
  if (keyed.length) out.push(`keyed: ${keyed.join('+')}`)
  return out
}

function itemLine(item, track, selectedId, { isAudio = false } = {}) {
  const flags = []
  const footage = item.type === 'media' && !isAudio
  if (footage && track.kind === 'video' && item.fit && item.fit !== 'contain') flags.push(item.fit)
  if (footage && track.kind === 'audio') flags.push('audio-only')
  if (item.muted) flags.push(footage && track.kind === 'video' ? 'video-only (muted)' : 'muted')
  if (item.opacity != null && item.opacity < 1) flags.push(`opacity ${item.opacity}`)
  if (item.volume != null && item.volume !== 1) flags.push(`vol ${item.volume}`)
  if (item.anchor && item.anchor !== 'center') flags.push(item.anchor)
  if (!isAudio) flags.push(...lookFlags(item))
  if (item.type === 'text') flags.unshift(item.sourceId)
  if (item.type === 'image') flags.unshift(`image ${item.sourceId}`)
  return (
    `${item.id === selectedId ? '* ' : '  '}${item.id}  ${item.type.padEnd(9)} "${item.name}"  ${track.name}  ` +
    `${fmtT(item.startMs)}–${fmtT(item.startMs + item.durationMs)}s  in ${fmtT(item.inMs)}s` +
    (flags.length ? `  [${flags.join(', ')}]` : '') +
    (item.type === 'text' && item.text ? `  “${item.text.replace(/\s+/g, ' ').slice(0, 60)}”` : '') +
    (item.note ? `  — ${item.note}` : '')
  )
}

function trackLine(t) {
  const flags = [t.muted && 'muted', t.hidden && 'hidden', t.locked && 'locked'].filter(Boolean)
  return (
    `${t.id}  ${t.name}  ${t.kind}  ${t.items.length} item(s)${flags.length ? `  [${flags.join(', ')}]` : ''}` +
    (t.note ? `  — "${t.note}"` : '')
  )
}

/** Lines that fit the budget, plus a hint about what was left out. */
function fitLines(lines, budgetUsed, continueHint) {
  const out = []
  let used = budgetUsed
  for (const line of lines) {
    if (used + line.length + 1 > OUTPUT_BUDGET - 120) {
      out.push(`…${lines.length - out.length} more. ${continueHint}`)
      break
    }
    out.push(line)
    used += line.length + 1
  }
  return out.join('\n')
}

function buildSequenceTools(editor) {
  const itemIdProp = { type: 'string', description: 'Item id from get_timeline.' }
  const timelineIdProp = { type: 'string', description: 'Id from list_timelines. Defaults to the open timeline.' }
  const seconds = (desc) => ({ type: 'number', description: desc })
  const toMs = (sec) => (sec == null ? undefined : Math.round(sec * 1000))

  const silenceProps = {
    thresholdDb: { type: 'number', description: 'Quieter than this is silence. Default -40; raise towards -25 for a noisy room.' },
    minGapSeconds: seconds('Ignore gaps shorter than this. Default 0.5.'),
    keepMs: { type: 'integer', description: 'Milliseconds of each gap to keep at both ends, so cuts land after the breath. Default 150.' },
  }
  const silenceParams = (i) => ({
    thresholdDb: i.thresholdDb,
    minMs: toMs(i.minGapSeconds),
    keepMs: i.keepMs,
  })

  const tools = [
    /* ------------------------------------------------------ read-only */
    {
      name: 'get_timeline',
      description:
        'The open timeline: settings, tracks and every item with id, type, track, start–end in seconds and source in-point. Tracks are listed top to bottom; the last video track is the picture, those above are overlays. Notes left on tracks and items (by a person, or by set_track/set_item) follow a dash — read them, they are instructions. Filter by trackId or a time window when long.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Only items on this track.' },
          fromSeconds: seconds('Only items ending after this time.'),
          toSeconds: seconds('Only items starting before this time.'),
        },
      },
      run: ({ trackId, fromSeconds, toSeconds }) => {
        const seq = editor.getSequence()
        if (!seq) return 'No timeline. Use create_timeline.'
        const st = editor.getSequenceState()
        const durationMs = Math.max(0, ...seq.tracks.flatMap((t) => t.items.map((i) => i.startMs + i.durationMs)))
        const parents = editor.parentsOf(seq.id)
        const head =
          `${seq.id} "${seq.name}"  ${seq.width}x${seq.height}  ${seq.fps}fps  ${fmtT(durationMs)}s  ` +
          `bg:${seq.background.mode === 'transparent' ? 'transparent' : seq.background.color}` +
          `${seq.id === editor.openSequence()?.id ? '' : '  (not the open one)'}\n` +
          (seq.note ? `note: ${seq.note}\n` : '') +
          (seq.claimedBy?.agent ? `claimed by ${seq.claimedBy.agent}\n` : '') +
          (parents.length ? `nested in: ${parents.map((p) => `${p.id} "${p.name}"`).join(', ')}\n` : '') +
          `tracks (top to bottom):\n` + seq.tracks.map((t) => `  ${trackLine(t)}`).join('\n') + '\nitems:\n'
        const audioFiles = new Set(editor.listMedia().filter((m) => m.kind === 'audio').map((m) => m.filename))
        const lines = []
        for (const t of seq.tracks) {
          if (trackId && t.id !== trackId) continue
          for (const it of t.items) {
            if (fromSeconds != null && it.startMs + it.durationMs <= fromSeconds * 1000) continue
            if (toSeconds != null && it.startMs >= toSeconds * 1000) continue
            lines.push(itemLine(it, t, st.selectedItemId, { isAudio: audioFiles.has(it.sourceId) }))
          }
        }
        if (!lines.length) return head + '  (none) — use add_to_timeline.'
        return head + fitLines(lines, head.length, 'Narrow with trackId or fromSeconds/toSeconds.')
      },
    },
    {
      name: 'list_timelines',
      description:
        'The project as a tree: the main timeline (★, what the project delivers), the sections it plays (⧉, indented, in time order, with where they sit), then timelines placed nowhere yet. Shows claims and notes. The open one is marked *. Pass any id as timelineId to other tools to work there without opening it.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const list = editor.listSequences()
        if (!list.length) return 'No timelines. Use create_timeline.'
        return editor.timelineTree()
      },
    },
    {
      name: 'get_timeline_state',
      description:
        'Playhead position, whether it is playing, timeline length, the selected item, and how many edits can be undone. Cheap; call it before capture_timeline_frame or after a batch of edits.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const s = editor.getSequenceState()
        return (
          `mode: ${s.mode}\ntimeline: ${s.timelineId ? `${s.timelineId} "${s.name}"` : 'none'}\n` +
          `playhead: ${fmtT(s.timeMs)}s of ${fmtT(s.durationMs)}s${s.playing ? ' (playing)' : ''}\n` +
          `selected: ${s.selectedItemIds?.length ? s.selectedItemIds.join(', ') : 'none'}\nundo: ${s.undoDepth} step(s), redo: ${s.redoDepth}\nbusy: ${s.busy}` +
          (s.preview ? `\npreview: ${s.preview.fps} fps over ${s.preview.seconds}s · ${s.preview.seeks} hard seek(s) · ${s.preview.nudges} nudge(s) · worst frame gap ${s.preview.worstGapMs}ms · ${s.preview.mounted}/${s.preview.overlays} overlays mounted · ${s.preview.media} media element(s)` : '')
        )
      },
    },
    {
      name: 'list_media',
      description:
        'Video and audio files in the media library, with the filename to use as sourceId, duration, size, frame rate and whether each has picture and sound.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const rows = editor.listMedia()
        if (!rows.length) return 'No media yet. Use add_media_from_url (a public or data: URL), or drop a file into the editor.'
        const lines = rows.map(
          (m) =>
            `${m.filename}  "${m.name}"  ${m.kind}  ${fmtT(m.durationMs)}s` +
            (m.hasVideo ? `  ${m.width}x${m.height}${m.fps ? ` ${Math.round(m.fps)}fps` : ''}` : '') +
            (m.hasAudio ? '  +audio' : '  silent'),
        )
        return fitLines(lines, 0, '')
      },
    },
    {
      name: 'list_transcripts',
      description:
        'Imported transcripts (SRT, VTT, Whisper JSON) with id, cue count, length, whether they carry word-level timings, and the media file each is bound to.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const rows = editor.listTranscripts()
        if (!rows.length) return 'No transcripts yet. Drop an .srt, .vtt or Whisper .json into the editor.'
        return rows
          .map(
            (t) =>
              `${t.id}  "${t.name}"  ${t.cueCount} cues  ${fmtT(t.durationMs)}s` +
              `${t.wordLevel ? '  word-level' : ''}${t.mediaFilename ? `  → ${t.mediaFilename}` : '  (unbound)'}`,
          )
          .join('\n')
      },
    },
    {
      name: 'get_transcript',
      description:
        'Read a transcript window. format "cues" gives timed lines, "words" gives every word with its own start/end (when the source has them), "text" gives plain prose. Times are SOURCE seconds of the media file. Output is capped, so page with fromSeconds; the last line says where to continue.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          transcriptId: { type: 'string', description: 'From list_transcripts.' },
          fromSeconds: seconds('Start of the window in source seconds. Default 0.'),
          toSeconds: seconds('End of the window. Default: as much as fits.'),
          format: { type: 'string', enum: ['cues', 'words', 'text'], description: 'Default "cues".' },
        },
        required: ['transcriptId'],
      },
      run: async ({ transcriptId, fromSeconds = 0, toSeconds, format = 'cues' }) => {
        const t = await editor.getTranscript(transcriptId)
        const from = fromSeconds * 1000
        const to = toSeconds != null ? toSeconds * 1000 : Infinity
        const cues = t.cues.filter((c) => c.endMs > from && c.startMs < to)
        if (!cues.length) return `No cues between ${fmtT(from)}s and ${to === Infinity ? 'the end' : fmtT(to) + 's'}. Transcript runs to ${fmtT(t.durationMs)}s.`

        const head = `"${t.name}" ${fmtT(t.durationMs)}s ${t.wordLevel ? 'word-level' : 'cue-level'}${t.mediaFilename ? ` → ${t.mediaFilename}` : ''}\n`
        const out = []
        let used = head.length
        let lastEnd = from
        let clipped = false

        const push = (line, endMs) => {
          if (used + line.length + 1 > OUTPUT_BUDGET - 90) {
            clipped = true
            return false
          }
          out.push(line)
          used += line.length + 1
          lastEnd = endMs
          return true
        }

        outer: for (const c of cues) {
          if (format === 'words' && c.words?.length) {
            for (const w of c.words) {
              if (w.endMs <= from || w.startMs >= to) continue
              if (!push(`${fmtT(w.startMs)}-${fmtT(w.endMs)} ${w.text}`, w.endMs)) break outer
            }
          } else if (format === 'text') {
            if (!push(c.text.replace(/\s+/g, ' '), c.endMs)) break
          } else {
            if (!push(`[${fmtT(c.startMs)}–${fmtT(c.endMs)}] ${c.text.replace(/\s+/g, ' ')}`, c.endMs)) break
          }
        }
        const tail = clipped ? `\n…more. Continue with fromSeconds=${fmtT(lastEnd)}` : `\n(end of window at ${fmtT(Math.min(to, t.durationMs))}s)`
        return head + out.join(format === 'text' ? ' ' : '\n') + tail
      },
    },
    {
      name: 'find_in_transcript',
      description:
        'Find where a phrase is spoken. Returns each match with its SOURCE start/end seconds — exact to the word when the transcript has word timings, otherwise the containing cue. Feed the times to cut_source_ranges to remove that speech, or to add_to_timeline (converted through the item\'s in-point) to place a title where it is said.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          transcriptId: { type: 'string', description: 'From list_transcripts.' },
          query: { type: 'string', description: 'Word or phrase, case-insensitive.' },
        },
        required: ['transcriptId', 'query'],
      },
      run: async ({ transcriptId, query }) => {
        const hits = await editor.findInTranscript(transcriptId, query)
        if (!hits.length) return `"${query}" was not found.`
        const lines = []
        let placed = 0
        for (const h of hits) {
          const on = await editor.sourceToTimeline(transcriptId, h.startMs, h.endMs)
          if (on.length) placed++
          const where = on.length ? `  → timeline ${on.map((o) => `${fmtT(o.tlMs)}s`).join(', ')}` : ''
          lines.push(`${fmtT(h.startMs)}–${fmtT(h.endMs)}s  ${h.exact ? '' : '(cue) '}${h.text.replace(/\s+/g, ' ')}${where}`)
        }
        const note = placed ? ' Source seconds, then where that moment is on the timeline.' : ' Source seconds; this transcript is not placed on the timeline, so no timeline time.'
        return `${hits.length} match(es)${hits[0].exact ? ' (word-exact)' : ' (cue-level: times cover the whole line)'}.${note}\n` + fitLines(lines, 60, 'Use a longer phrase.')
      },
    },
    {
      name: 'detect_silence',
      description:
        'Find silent gaps from the waveform. With itemId the gaps come back in SEQUENCE seconds for that item; with media (a filename) they come back in SOURCE seconds for the whole file. Tune with thresholdDb / minGapSeconds / keepMs. remove_silence applies the same detection.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          media: { type: 'string', description: 'Media filename from list_media, when not using itemId.' },
          ...silenceProps,
        },
      },
      run: async (i) => {
        if (!i.itemId && !i.media) return 'Pass itemId or media.'
        const r = await editor.detectSilence({ itemId: i.itemId, media: i.media }, silenceParams(i))
        const p = r.params
        const head = `${r.ranges.length} gap(s), ${fmtT(r.totalMs)}s total, in ${r.scope} time  (threshold ${p.thresholdDb}dB, min ${fmtT(p.minMs)}s, keep ${p.keepMs}ms)\n`
        if (!r.ranges.length) return head + 'Nothing at this threshold — try raising thresholdDb.'
        const lines = r.ranges.map((g) => `${fmtT(g.startMs)}–${fmtT(g.endMs)}s  (${fmtT(g.endMs - g.startMs)}s)`)
        return head + fitLines(lines, head.length, 'Raise minGapSeconds to see fewer.')
      },
    },
    {
      name: 'check_timeline',
      description:
        'Preflight the timeline for what only shows after rendering: missing media or clips, items running past the end of their file, opaque clips used as overlays (they cover everything beneath), letterboxed footage, captions covering no cues, and a timeline with no sound.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const lines = editor.checkSequence()
        const bad = lines.filter((l) => !l.startsWith('INFO'))
        return (bad.length ? '' : 'No problems found.\n') + lines.join('\n')
      },
    },
    {
      name: 'capture_timeline_frame',
      description:
        'Composite the timeline — footage, overlays and captions stacked exactly as the render will — and show it. With a server you get a PNG URL to fetch; with no server the stage is left parked on that frame for you to look at, and the picture is attached to the result where the runtime supports images. One frame at timeSeconds, or with count 2–12 a labelled contact sheet spread between fromSeconds and toSeconds: the quickest way to see an overlay against the footage over its whole life. The editor is left parked on the last frame.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: seconds('Timeline time to capture. Defaults to the playhead.'),
          count: { type: 'integer', description: 'Frames for a contact sheet, 2–12.' },
          fromSeconds: seconds('Sheet start. Default 0.'),
          toSeconds: seconds('Sheet end. Default the timeline end.'),
        },
      },
      run: async ({ timeSeconds, count, fromSeconds, toSeconds }) => {
        if (count && count > 1) {
          const r = await editor.captureSequenceStrip({ count, fromMs: toMs(fromSeconds) ?? 0, toMs: toSeconds != null ? toMs(toSeconds) : null })
          return capturedFrame(`Contact sheet: ${r.frames} frames from ${fmtT(r.fromMs)}s to ${fmtT(r.toMs)}s, ${(r.size / 1024).toFixed(0)}KB`, r.url, SHEET_LOST)
        }
        const r = await editor.captureSequenceFrame(toMs(timeSeconds))
        return capturedFrame(`Captured ${fmtT(r.timeMs)}s, ${r.width}x${r.height}, ${(r.size / 1024).toFixed(0)}KB`, r.url, ON_STAGE)
      },
    },

    /* ---------------------------------------------------------- write */
    {
      name: 'create_timeline',
      description: 'Add a timeline to the project and open it. Defaults to 1920x1080, 30fps, black. Comes with tracks V2, V1 (picture) and A1.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Timeline name.' },
          width: { type: 'integer', description: 'Frame width, 16-7680.' },
          height: { type: 'integer', description: 'Frame height, 16-7680.' },
          fps: { type: 'integer', description: 'Frames per second, 1-120.' },
          background: { type: 'string', description: '"transparent" or a #rrggbb colour behind everything.' },
        },
      },
      run: async (i) => {
        const seq = await editor.createSequence({
          name: i.name, width: i.width, height: i.height, fps: i.fps,
          background: i.background ? parseBackground(i.background) : undefined,
        })
        return `Created and opened ${seq.id} "${seq.name}" ${seq.width}x${seq.height} ${seq.fps}fps with tracks ${seq.tracks.map((t) => t.name).join(', ')}.`
      },
    },
    {
      name: 'open_timeline',
      description: 'Open another timeline of the project in the editor.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { timelineId: { type: 'string', description: 'From list_timelines.' } }, required: ['timelineId'] },
      run: async ({ timelineId }) => {
        const seq = await editor.selectSequence(timelineId)
        return `Opened ${seq.id} "${seq.name}".`
      },
    },
    {
      name: 'set_timeline_settings',
      description: 'Change a timeline\'s name, frame size, frame rate, background or note, or make it the main timeline. Items are not rescaled; footage refits by its fit mode. A note is read by whoever works there next — leave instructions in it.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New name.' },
          width: { type: 'integer', description: 'Frame width.' },
          height: { type: 'integer', description: 'Frame height.' },
          fps: { type: 'integer', description: 'Frames per second.' },
          background: { type: 'string', description: '"transparent" or #rrggbb.' },
          note: { type: 'string', description: 'Free text about this timeline; "" clears it.' },
          main: { type: 'boolean', description: 'true makes this the main timeline — the one the project delivers.' },
        },
      },
      run: async (i) => {
        const seq = await editor.setSequenceSettings({
          name: i.name, width: i.width, height: i.height, fps: i.fps,
          background: i.background ? parseBackground(i.background) : undefined,
          note: i.note, main: i.main === true,
        })
        return `${seq.id} is now "${seq.name}" ${seq.width}x${seq.height} ${seq.fps}fps${seq.note ? ` — note: ${seq.note}` : ''}.`
      },
    },
    {
      name: 'add_media_from_url',
      description:
        'Bring a video or audio file into the media library. url is a public http(s) URL, or a data: URL (base64; 24 MB decoded at most) when you hold the bytes — a voice-over a tool returned, say. Sniffed on arrival: mp4, m4v, mov, webm, mkv, avi, wav, mp3, m4a, aac, flac, ogg, opus. It is probed and the reply gives the filename to use as sourceId. Anything larger: host it, or ask the person to drop the file in.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public http(s) URL, or data:<mime>;base64,… holding the file (24 MB decoded max).' },
          name: { type: 'string', description: 'Optional filename. Its extension is corrected if it disagrees with the bytes.' },
        },
        required: ['url'],
      },
      run: async ({ url, name }) => {
        const m = await editor.addMediaFromUrl(url, name)
        return addedMedia(m)
      },
    },
    {
      name: 'list_text_presets',
      description:
        'The ready-made animated title styles a text item can use — title, lower third, subtitle bar, pop-words, typewriter, impact, label, quote — with the fields each takes and its default length, plus the shapes add_shape places (rectangle, ellipse, frame, ring, highlight, line, arrow, marker, check, pulse, pointer), each with the add_shape parameters it takes. Use with add_text; no clip code needed.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () =>
        editor
          .listTextPresets()
          .map((p) => `${p.id.padEnd(15)} "${p.name}"  ${p.kind === 'shape' ? `[shape: ${(p.controls ?? []).map((c) => SHAPE_PARAM[c] ?? c).join(' ')}]` : p.fields.join('+')}  ${fmtT(p.defaultDurationMs)}s  — ${p.note}`)
          .join('\n'),
    },
    {
      name: 'add_text',
      description:
        'Put an animated title on the timeline from a preset: type the words, pick the preset, place it. (For a shape — a rectangle, frame, ring, arrow, marker and so on — use add_shape.) It animates in from its start and out at its end, whatever length it is given. Placement uses anchor; style takes fontFamily, fontSize, color, accent, boxColor, weight, uppercase, align. Convertible to a clip later for full control.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          preset: { type: 'string', description: 'Preset id from list_text_presets. Default "title".' },
          text: { type: 'string', description: 'The words.' },
          subtext: { type: 'string', description: 'Second line, for presets that have one (lower-third role, quote attribution, title strap).' },
          atSeconds: seconds('Start on the timeline. Defaults to the playhead.'),
          durationSeconds: seconds('Length. Defaults to the preset default.'),
          trackId: { type: 'string', description: 'A video track id; otherwise a free overlay track is chosen or made.' },
          anchor: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], description: 'Nudge the whole title from the preset\'s own placement.' },
          style: { type: 'object', description: 'fontFamily, fontSize, color, accent, boxColor, weight, uppercase, align.' },
          name: { type: 'string', description: 'Item name on the timeline; defaults to the text.' },
        },
        required: ['text'],
      },
      run: async (i) => {
        const { item, track } = await editor.addText({
          preset: i.preset, text: i.text, subtext: i.subtext, atMs: toMs(i.atSeconds), durationMs: toMs(i.durationSeconds),
          trackId: i.trackId, anchor: i.anchor, style: i.style, name: i.name,
        })
        return `Added ${item.id} [${item.sourceId}] "${item.name}" on ${track.name}, ${fmtT(item.startMs)}–${fmtT(item.startMs + item.durationMs)}s. capture_timeline_frame to see it.`
      },
    },
    {
      name: 'add_shape',
      description:
        'Put a shape on the timeline, sized in timeline pixels and placed by anchor and offsets (default anchor top-left, so offsetX/offsetY are its top-left corner in frame pixels; anchor center places its middle). ' +
        'rect and ellipse are solid patches that cut in and out: in the footage\'s own colour (save_frame or capture_timeline_frame to read it) a rect hides an account name or a detail. ' +
        'frame and ring are outlines that draw themselves on around something (fill none by default). highlight is a translucent wash swiped over a line or a button. ' +
        'line and arrow draw from one end to the other: points is the end they draw towards, where the arrow\'s head is (for up or down make height the long side). ' +
        'marker is a numbered dot for steps (label is the number, "1" by default). check is a tick in a disc: the disc pops, then the tick draws. pulse is a dot with rings rippling outward, for "click here". ' +
        'pointer is a mouse pointer that lands and clicks once; its tip is the item\'s centre, so anchor center plus offsets place the tip. ' +
        'Lines are white with a small shadow by default; dashed makes a frame, ring, line or arrow dashed (it then fades in rather than drawing on). ' +
        'It is a text item with no words, so set_item changes it later (textStyle width/height/radius/stroke/color/accent/direction/dashed, text for a marker\'s number, offsetX/offsetY, opacity, timing) and it renders like any overlay.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          shape: { type: 'string', enum: ['rect', 'ellipse', 'frame', 'ring', 'highlight', 'line', 'arrow', 'marker', 'check', 'pulse', 'pointer'], description: 'Default rect.' },
          width: { type: 'number', description: 'Pixels at timeline size. Rounded to even.' },
          height: { type: 'number', description: 'Pixels at timeline size. Rounded to even.' },
          fill: { type: 'string', description: '#rrggbb, or "none": the patch, the marker or check disc, the pulse\'s dot, the pointer\'s body. Frames and rings default to none; a highlight is drawn translucent whatever the colour.' },
          outline: { type: 'string', description: 'Line colour #rrggbb: a patch\'s outline, the stroke of a frame, ring, line or arrow, the marker\'s number, the check\'s tick, the pulse\'s rings, the pointer\'s edge. Default white (the pointer\'s is near-black).' },
          outlineWidth: { type: 'number', description: 'Line weight in pixels. 0 = no outline on a patch, marker or check; frames, rings, lines and arrows default to 6; pulse rings and the pointer\'s edge to 4.' },
          corners: { type: 'number', description: 'Corner radius in pixels for a rect, frame, highlight, marker or check. 999 is a circle (the marker and check default).' },
          points: { type: 'string', enum: ['right', 'left', 'up', 'down'], description: 'Line and arrow: the end it draws towards, where the head is. Default right.' },
          dashed: { type: 'boolean', description: 'Frame, ring, line, arrow: draw the stroke dashed. A dashed stroke fades in rather than drawing on.' },
          label: { type: 'string', description: 'Marker: the number or short label in the dot. Default "1".' },
          opacity: { type: 'number', description: 'Whole-item opacity 0–1. Default 1.' },
          anchor: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], description: 'Where the offsets are measured from. Default top-left.' },
          offsetX: { type: 'number', description: 'Pixels from the anchor, rightwards.' },
          offsetY: { type: 'number', description: 'Pixels from the anchor, downwards.' },
          atSeconds: seconds('Start on the timeline. Defaults to the playhead.'),
          durationSeconds: seconds('Length. Default 5.'),
          trackId: { type: 'string', description: 'A video track id; otherwise a free overlay track is chosen or made.' },
          name: { type: 'string', description: 'Item name on the timeline; defaults to the shape name.' },
        },
      },
      run: async (i) => {
        const style = {}
        if (i.width != null) style.width = i.width
        if (i.height != null) style.height = i.height
        if (i.fill != null) style.color = i.fill
        if (i.outline != null) style.accent = i.outline
        if (i.outlineWidth != null) style.stroke = i.outlineWidth
        if (i.corners != null) style.radius = i.corners
        if (i.points) style.direction = i.points
        if (i.dashed != null) style.dashed = !!i.dashed
        // The marker's number is the item's text; every other shape has no words.
        const label = i.shape === 'marker' && i.label != null ? String(i.label).trim() : ''
        const { item, track } = await editor.addText({
          preset: `shape-${i.shape ?? 'rect'}`, text: label, atMs: toMs(i.atSeconds), durationMs: toMs(i.durationSeconds), trackId: i.trackId,
          anchor: i.anchor ?? 'top-left', offsetX: i.offsetX, offsetY: i.offsetY, opacity: i.opacity, style,
          name: i.name ?? (label ? `Marker ${label}`.slice(0, 40) : undefined),
        })
        return `Added ${item.id} [${item.sourceId}] "${item.name}" on ${track.name}, ${fmtT(item.startMs)}–${fmtT(item.startMs + item.durationMs)}s, ${item.anchor} +${item.offsetX ?? 0},${item.offsetY ?? 0}. capture_timeline_frame to see it.`
      },
    },
    {
      name: 'add_to_timeline',
      description:
        'Place a source on the timeline. kind "media" takes a filename from list_media, "clip" a clip id (an overlay layer with real alpha), "transcript" an id (burnt-in captions, auto-aligned to its footage if placed), "timeline" another timeline id (a block that plays it — a section). Without trackId a free track is chosen or made; nothing is overwritten. Returns the new item id.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['media', 'clip', 'transcript', 'timeline', 'image'], description: 'What sourceId refers to. image = an image asset filename from list_assets: a still on an overlay track, held for durationSeconds (default 5), sized in set_item via imageStyle {width, height, radius, shadow} and fit.' },
          sourceId: { type: 'string', description: 'Media filename, clip id, transcript id, timeline id or image asset filename.' },
          atSeconds: seconds('Where it starts on the timeline. Defaults to the playhead.'),
          durationSeconds: seconds('Length on the timeline. Defaults to the source length.'),
          inSeconds: seconds('In-point inside the source. Default 0.'),
          trackId: { type: 'string', description: 'A track id from get_timeline. Placing over an existing item trims it out of the way.' },
        },
        required: ['kind', 'sourceId'],
      },
      run: async (i) => {
        const { item, track } = await editor.addToSequence(i.kind, i.sourceId, {
          atMs: toMs(i.atSeconds), durationMs: toMs(i.durationSeconds), inMs: toMs(i.inSeconds), trackId: i.trackId,
        })
        return `Added ${item.id} "${item.name}" on ${track.name}, ${fmtT(item.startMs)}–${fmtT(item.startMs + item.durationMs)}s.`
      },
    },
    {
      name: 'set_item',
      description:
        'Change one item: timing (start, length, in-point), placement (fit for footage; anchor/offsetX/offsetY for overlays), size (scale for footage, nested blocks and animation clips; imageStyle/textStyle width and height for images and shapes; textStyle fontSize for titles), transform (rotation, flipH, flipV, crop), look (colour, blend, radius, shadow), opacity, sound (volume, muted, fades), captionStyle for captions, text/subtext/preset/textStyle for titles, or a note. Only the fields given change. A longer item trims whatever it now overlaps.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          name: { type: 'string', description: 'Display name.' },
          startSeconds: seconds('Start on the timeline.'),
          durationSeconds: seconds('Length on the timeline.'),
          inSeconds: seconds('In-point inside the source.'),
          fit: { type: 'string', enum: ['contain', 'cover', 'fill', 'none'], description: 'Footage: letterbox, crop, stretch, or native size.' },
          anchor: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], description: 'Where an overlay (or fit:none footage) sits.' },
          offsetX: { type: 'integer', description: 'Pixels from the anchor, horizontally.' },
          offsetY: { type: 'integer', description: 'Pixels from the anchor, vertically.' },
          speed: { type: 'number', description: 'Footage, nested blocks and animation clips only: how fast the source runs against the timeline. 1 is normal, 2 plays twice as fast, 0.5 is slow motion. The item keeps its length on the timeline and shows more or less of the source; sound is re-timed with its pitch kept. A caption or a title has no speed — its timing comes from its transcript or its own length.' },
          dissolveInSeconds: seconds('Fade the picture up over this long at the start. Half of a cross dissolve.'),
          dissolveOutSeconds: seconds('Fade the picture down over this long at the end.'),
          scale: { type: 'number', description: 'Footage, nested blocks and animation clips only, and only with fit:none: how big the layer is drawn against its natural size. 1 is unchanged, 0.3 is a picture-in-picture corner. An animation clip is re-rendered at that size, so it stays sharp; footage is resampled. An image, shape or title has no scale — give it a size instead.' },
          rotation: { type: 'number', description: 'Degrees clockwise, about the middle of the layer. -180 to 180.' },
          flipH: { type: 'boolean', description: 'Mirror left to right.' },
          flipV: { type: 'boolean', description: 'Mirror top to bottom.' },
          crop: {
            type: 'object',
            description: 'Footage and nested blocks only: how much of each edge to cut off before the fit, as fractions 0-0.95 — {top, right, bottom, left}. Fractions of the source, so the framing survives swapping the shot for another resolution. null clears it.',
          },
          colour: {
            type: 'object',
            description: 'Colour correction: {brightness, contrast, saturation} where 1 is unchanged, and {temperature} from -1 (cool) to 1 (warm). null clears it.',
          },
          blend: { type: 'string', enum: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'softlight', 'hardlight', 'difference', 'exclusion'], description: 'How the layer mixes with what is under it.' },
          radius: { type: 'integer', description: 'Round the layer\'s corners, in frame pixels. 0 is square.' },
          shadow: {
            type: 'object',
            description: 'A drop shadow under the layer: {blur, x, y, color, opacity}. blur 0 turns it off; null clears it. This is what makes a picture-in-picture read as a card over the footage.',
          },
          opacity: { type: 'number', description: '0-1.' },
          volume: { type: 'number', description: '0-4; 1 is unchanged.' },
          muted: { type: 'boolean', description: 'Silence the item.' },
          fadeInSeconds: seconds('Audio fade in.'),
          fadeOutSeconds: seconds('Audio fade out.'),
          captionStyle: {
            type: 'object',
            description: 'Caption items: fontSize, color, boxColor, position (top|center|bottom), marginPx, maxWidthPct, uppercase, shadow, fontFamily, weight, transition (cut|fade|pop), karaoke (off|word|fill), accent.',
          },
          note: { type: 'string', description: 'Free text kept on the item and shown in get_timeline. Empty string clears it.' },
          text: { type: 'string', description: 'Text items: the words.' },
          subtext: { type: 'string', description: 'Text items: the second line, where the preset has one.' },
          preset: { type: 'string', description: 'Text items: switch preset (see list_text_presets).' },
          imageStyle: {
            type: 'object',
            description: 'Image items: width, height (pixels at timeline size; omit for natural size), radius (corner px), shadow (boolean). Use fit for contain/cover/fill/none.',
          },
          textStyle: {
            type: 'object',
            description: 'Text items: fontFamily, fontSize, color, accent, boxColor, weight (400-900), uppercase, align (left|center|right). Shapes: width, height, radius, stroke (the one line weight), color (fill), accent (line), direction (right|left|up|down), dashed; a marker\'s number is the item\'s text.',
          },
        },
        required: ['itemId'],
      },
      run: async (i) => {
        const item = await editor.setItem(i.itemId, {
          name: i.name, startMs: toMs(i.startSeconds), durationMs: toMs(i.durationSeconds), inMs: toMs(i.inSeconds),
          fit: i.fit, anchor: i.anchor, offsetX: i.offsetX, offsetY: i.offsetY, scale: i.scale, opacity: i.opacity,
          speed: i.speed, dissolveInSeconds: i.dissolveInSeconds, dissolveOutSeconds: i.dissolveOutSeconds,
          rotation: i.rotation, flipH: i.flipH, flipV: i.flipV, crop: i.crop,
          colour: i.colour, blend: i.blend, radius: i.radius, shadow: i.shadow,
          volume: i.volume, muted: i.muted, fadeInMs: toMs(i.fadeInSeconds), fadeOutMs: toMs(i.fadeOutSeconds),
          captionStyle: i.captionStyle, note: i.note,
          text: i.text, subtext: i.subtext, preset: i.preset, textStyle: i.textStyle, imageStyle: i.imageStyle,
        })
        return `Updated ${item.id}: ${fmtT(item.startMs)}–${fmtT(item.startMs + item.durationMs)}s, in ${fmtT(item.inMs)}s.`
      },
    },
    {
      name: 'move_item',
      description: 'Move an item to a time, optionally onto another track of the same kind. Whatever it lands on is trimmed out of its way.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          atSeconds: seconds('New start time.'),
          trackId: { type: 'string', description: 'Destination track id.' },
        },
        required: ['itemId', 'atSeconds'],
      },
      run: async ({ itemId, atSeconds, trackId }) => {
        const item = await editor.moveItem(itemId, { startMs: toMs(atSeconds), trackId })
        return `Moved ${item.id} to ${fmtT(item.startMs)}–${fmtT(item.startMs + item.durationMs)}s.`
      },
    },
    {
      name: 'split_item',
      description: 'Cut an item in two at a timeline time (default: the playhead). The tail keeps source continuity, so the cut does not jump. Returns both ids.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { itemId: itemIdProp, atSeconds: seconds('Timeline time inside the item.') },
        required: ['itemId'],
      },
      run: async ({ itemId, atSeconds }) => {
        const { head, tail } = await editor.splitItem(itemId, toMs(atSeconds))
        return `Split: ${head.id} ${fmtT(head.startMs)}–${fmtT(head.startMs + head.durationMs)}s, ${tail.id} ${fmtT(tail.startMs)}–${fmtT(tail.startMs + tail.durationMs)}s.`
      },
    },
    {
      name: 'delete_item',
      description: 'Remove an item. ripple:true also closes the gap by pulling everything after it on that track back.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { itemId: itemIdProp, ripple: { type: 'boolean', description: 'Close the gap on that track. Default false.' } },
        required: ['itemId'],
      },
      run: async ({ itemId, ripple }) => {
        const gone = await editor.deleteItem(itemId, { ripple: !!ripple })
        return `Deleted ${gone.id} "${gone.name}"${ripple ? ' and closed the gap' : ''}.`
      },
    },
    {
      name: 'cut_time_range',
      description:
        'Remove a stretch of SEQUENCE time from every unlocked track and close the gap — items spanning it are cut and rejoined, later items slide back. Lock a track (set_track) to protect a music bed. Undoable.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { fromSeconds: seconds('Start of the range.'), toSeconds: seconds('End of the range.') },
        required: ['fromSeconds', 'toSeconds'],
      },
      run: async ({ fromSeconds, toSeconds }) => {
        const r = await editor.removeTimeRanges([{ startMs: toMs(fromSeconds), endMs: toMs(toSeconds) }])
        return `Removed ${fmtT(r.removedMs)}s: ${r.split} item(s) split, ${r.removed} removed, ${r.shifted} shifted. Timeline is now ${fmtT(editor.getSequenceState().durationMs)}s.`
      },
    },
    {
      name: 'cut_source_ranges',
      description:
        'Remove parts of an item by SOURCE time — the times find_in_transcript and get_transcript give — and ripple the whole timeline closed. This is how "cut the part where she repeats herself" or "drop every um" is done: find the words, pass their ranges. Captions on the same footage stay in sync. Undoable.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          ranges: {
            type: 'array',
            description: 'Source-time ranges to remove, e.g. [{"fromSeconds":12.3,"toSeconds":12.9}].',
            items: {
              type: 'object',
              properties: { fromSeconds: { type: 'number' }, toSeconds: { type: 'number' } },
              required: ['fromSeconds', 'toSeconds'],
            },
          },
        },
        required: ['itemId', 'ranges'],
      },
      run: async ({ itemId, ranges }) => {
        if (!Array.isArray(ranges) || !ranges.length) return 'ranges is empty.'
        const r = await editor.removeSourceRanges(
          itemId,
          ranges.map((x) => ({ startMs: toMs(x.fromSeconds), endMs: toMs(x.toSeconds) })),
        )
        return `Removed ${r.ranges} range(s), ${fmtT(r.removedMs)}s: ${r.split} split, ${r.removed} removed, ${r.shifted} shifted. Timeline is now ${fmtT(editor.getSequenceState().durationMs)}s.`
      },
    },
    {
      name: 'remove_silence',
      description:
        'Detect the silent gaps in an item and cut them all out of the timeline, rippling every unlocked track so captions and overlays stay aligned. Run detect_silence first to see what will go; lock a music bed with set_track. Undoable.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { itemId: itemIdProp, ...silenceProps },
        required: ['itemId'],
      },
      run: async (i) => {
        const r = await editor.removeSilence(i.itemId, silenceParams(i))
        if (!r.gaps) return 'No gaps found at this threshold — nothing removed.'
        return `Removed ${r.gaps} gap(s), ${fmtT(r.removedMs)}s in total. Timeline is now ${fmtT(editor.getSequenceState().durationMs)}s. undo_edit reverts it.`
      },
    },
    {
      name: 'replace_audio',
      description:
        'Put a different sound under an item — the new voice back from a voice tool, say. The item\'s own sound is muted and the new file is laid on an audio track aligned to the item\'s start. The reply says if the new sound is shorter or longer than the picture, so you can trim or hold it. Then edit_transcript to update the words.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          media: { type: 'string', description: 'The new sound: a media filename from list_media (import it first with add_media_from_url or a drop).' },
          inSeconds: seconds('In-point inside the new sound. Default 0.'),
        },
        required: ['itemId', 'media'],
      },
      run: async ({ itemId, media, inSeconds }) => {
        const r = await editor.replaceAudio(itemId, media, { inMs: toMs(inSeconds) ?? 0 })
        const diff = r.shorterByMs ? ` The new sound is ${fmtT(r.shorterByMs)}s shorter than the picture.` : r.longerByMs ? ` ${fmtT(r.longerByMs)}s of the new sound is unused.` : ''
        const twins = r.mutedTwins?.length ? ` Its detached sound (${r.mutedTwins.map((t) => t.id).join(', ')}) is muted too.` : ''
        return `${r.audio.id} "${r.audio.name}" on ${r.track.name}, ${fmtT(r.audio.startMs)}–${fmtT(r.audio.startMs + r.audio.durationMs)}s; ${itemId} is muted.${twins}${diff}`
      },
    },
    {
      name: 'edit_transcript',
      description:
        'Replace what is said in a window of SOURCE time: cues wholly inside go, cues crossing an edge are cut at it, the new cues are put in. This is how the words of a re-voiced part are updated — captions on that footage recompile. Edited cues have no word timings (karaoke falls back to plain). Not part of undo_edit; undo_transcript_edit reverts it.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          transcriptId: { type: 'string', description: 'From list_transcripts.' },
          fromSeconds: seconds('Start of the window, source time.'),
          toSeconds: seconds('End of the window, source time.'),
          cues: {
            type: 'array',
            description: 'The new lines, e.g. [{"fromSeconds":12.3,"toSeconds":15,"text":"…"}]. Empty array just clears the window.',
            items: { type: 'object', properties: { fromSeconds: { type: 'number' }, toSeconds: { type: 'number' }, text: { type: 'string' } }, required: ['fromSeconds', 'toSeconds', 'text'] },
          },
        },
        required: ['transcriptId', 'fromSeconds', 'toSeconds', 'cues'],
      },
      run: async ({ transcriptId, fromSeconds, toSeconds, cues }) => {
        const t = await editor.editTranscript(transcriptId, {
          fromMs: toMs(fromSeconds), toMs: toMs(toSeconds),
          cues: (cues ?? []).map((c) => ({ startMs: toMs(c.fromSeconds), endMs: toMs(c.toSeconds), text: c.text })),
        })
        const inside = t.cues.filter((c) => c.endMs > fromSeconds * 1000 && c.startMs < toSeconds * 1000)
        return `Transcript now ${t.cues.length} cues; in ${fmtT(fromSeconds * 1000)}–${fmtT(toSeconds * 1000)}s:\n` + inside.map((c) => `[${fmtT(c.startMs)}–${fmtT(c.endMs)}] ${c.text}`).join('\n')
      },
    },
    {
      name: 'set_cue',
      description: 'Change one cue by index (from get_transcript order): its text, start or end in source seconds, or delete it. Text edits drop that cue\'s word timings. Reverted by undo_transcript_edit.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          transcriptId: { type: 'string', description: 'From list_transcripts.' },
          index: { type: 'integer', description: 'Zero-based cue index.' },
          text: { type: 'string', description: 'New words.' },
          fromSeconds: seconds('New start.'),
          toSeconds: seconds('New end.'),
          delete: { type: 'boolean', description: 'Remove the cue instead.' },
        },
        required: ['transcriptId', 'index'],
      },
      run: async ({ transcriptId, index, text, fromSeconds, toSeconds, delete: del }) => {
        const t = await editor.setCue(transcriptId, index, { text, startMs: toMs(fromSeconds), endMs: toMs(toSeconds), delete: !!del })
        const c = t.cues[Math.min(index, t.cues.length - 1)]
        return del ? `Cue ${index} removed; ${t.cues.length} left.` : `Cue ${index}: [${fmtT(c.startMs)}–${fmtT(c.endMs)}] ${c.text}`
      },
    },
    {
      name: 'undo_transcript_edit',
      description: 'Revert the last edit_transcript / set_cue on a transcript (twenty deep, this session).',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { transcriptId: { type: 'string', description: 'From list_transcripts.' } }, required: ['transcriptId'] },
      run: async ({ transcriptId }) => {
        const t = await editor.undoTranscriptEdit(transcriptId)
        return t ? `Reverted; ${t.cues.length} cues.` : 'Nothing to undo for that transcript.'
      },
    },
    {
      name: 'export_parts',
      description:
        'Export pieces as separate files: each item as picture / sound / both (footage), WAV or MP3 (sound — what a voice tool wants), an alpha render (titles, captions, animations), plus the words of that range as .srt re-based to zero; and/or a window of the whole mix. Files land in data/exports and come back as URLs (list_exports shows only the newest 50, so keep them); zip bundles them. Bring a new voice back with replace_audio.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemIds: { type: 'array', items: { type: 'string' }, description: 'Items to export. Omit for none (range only).' },
          what: { type: 'string', enum: ['both', 'video', 'audio'], description: 'Footage as picture+sound, picture, or sound. Default: both on video tracks, sound on audio tracks.' },
          audioFormat: { type: 'string', enum: ['wav', 'mp3'], description: 'Default wav.' },
          videoFormat: { type: 'string', enum: ['mp4', 'mov'], description: 'Default mp4.' },
          transcript: { type: 'boolean', description: 'Include the .srt excerpt where a transcript is bound. Default true.' },
          fromSeconds: seconds('With toSeconds: also export this window of the whole mix.'),
          toSeconds: seconds('End of the mix window.'),
          rangeOutput: { type: 'string', enum: ['both', 'video', 'audio'], description: 'What the mix window contains. Default both.' },
          zip: { type: 'boolean', description: 'Bundle everything into one zip. Default false.' },
        },
      },
      run: async (i) => {
        const range = i.fromSeconds != null && i.toSeconds != null ? { fromMs: toMs(i.fromSeconds), toMs: toMs(i.toSeconds), output: i.rangeOutput ?? 'both' } : null
        const r = await editor.exportParts({
          itemIds: i.itemIds ?? [], range, what: i.what ?? null, audioFormat: i.audioFormat ?? 'wav', videoFormat: i.videoFormat ?? 'mp4',
          transcript: i.transcript ?? true, zip: !!i.zip,
        })
        const lines = r.files.map((f) => `${f.url}  ${(f.size / 1024).toFixed(0)}KB  ${f.label}`)
        if (r.zip) lines.push(`${r.zip.url}  ${(r.zip.size / 1024).toFixed(0)}KB  zip of all`)
        for (const e of r.errors ?? []) lines.push(`! ${e}`)
        return `${r.files.length} file(s):\n` + fitLines(lines, 20, '')
      },
    },
    {
      name: 'get_narration',
      description:
        'What is said when, in TIMELINE seconds — the map to plan overlays from ("put the keycap where he presses Ctrl"). Uses the captions placed on the timeline, else the transcript bound to its footage, mapped through each item\'s in-point. Filter with a time window or a query phrase.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          fromSeconds: seconds('Only lines after this timeline time.'),
          toSeconds: seconds('Only lines before this timeline time.'),
          query: { type: 'string', description: 'Only lines containing this phrase, case-insensitive.' },
        },
      },
      run: async ({ fromSeconds, toSeconds, query }) => {
        const r = await editor.narration({ fromMs: toMs(fromSeconds) ?? 0, toMs: toSeconds != null ? toMs(toSeconds) : Infinity, query: query || null })
        if (!r.sources) return 'No transcript plays on this timeline: place captions (add_to_timeline kind "transcript") or import a transcript for its footage.'
        if (!r.lines.length) return query ? `"${query}" is not said in that window.` : 'Nothing is said in that window.'
        const lines = r.lines.map((l) => `[${fmtT(l.tlMs)}] ${l.text}`)
        return `${r.lines.length} line(s), timeline seconds:\n` + fitLines(lines, 40, 'Narrow with fromSeconds/toSeconds or query.')
      },
    },
    {
      name: 'check_layout',
      description:
        'Where the overlays sit on screen, and which collide. Each overlay is drawn offscreen and the box of what it actually paints measured (at a quarter, half and three quarters of its life); pairs that share time and pixels — a title over the captions, two cards in the same corner — are reported with the overlap. Run it after placing overlays; a window keeps it quick.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { fromSeconds: seconds('Window start.'), toSeconds: seconds('Window end.') },
      },
      run: async ({ fromSeconds, toSeconds }) => {
        const r = await editor.checkLayout({ fromMs: toMs(fromSeconds) ?? 0, toMs: toSeconds != null ? toMs(toSeconds) : Infinity })
        const box = (b) => (b ? `[${b.x},${b.y} ${b.w}×${b.h}]` : '[paints nothing]')
        const out = []
        for (const o of r.overlaps) {
          out.push(`WARN ${o.a.item.id} "${o.a.item.name}" ${box(o.a.bounds)} overlaps ${o.b.item.id} "${o.b.item.name}" ${box(o.b.bounds)} for ${fmtT(o.t0)}–${fmtT(o.t1)}s (${o.pct}% of the smaller)`)
        }
        if (!r.overlaps.length) out.push(`No overlaps among ${r.measured.length} overlay(s).`)
        for (const m of r.measured) out.push(`INFO ${m.item.id} "${m.item.name}" ${m.track.name} ${fmtT(m.item.startMs)}–${fmtT(m.item.startMs + m.item.durationMs)}s ${box(m.bounds)}`)
        for (const it of r.skipped) out.push(`INFO ${it.id} "${it.name}" could not be drawn (source missing or not loaded)`)
        return fitLines(out, 60, 'Use fromSeconds/toSeconds for a window.')
      },
    },
    {
      name: 'duplicate_timeline',
      description:
        'Copy a timeline as a new version — every track and item with fresh ids, placed right after the original, named "<name> v2" unless told otherwise. Sections (blocks playing other timelines) stay shared; deep: true copies them too, recursively, so the version can diverge all the way down. Opens the copy unless open: false. Iterate on the copy; the original is untouched.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the copy. Default: the original\'s name with the next version number.' },
          deep: { type: 'boolean', description: 'Also copy the timelines its blocks play (default false: shared).' },
          open: { type: 'boolean', description: 'Open the copy (default true).' },
        },
      },
      run: async ({ name, deep, open }) => {
        const r = await editor.duplicateSequence({ name, deep: !!deep, open: open !== false })
        return `Copied "${r.source.name}" → ${r.copy.id} "${r.copy.name}"${r.copied > 1 ? ` with ${r.copied - 1} section(s) copied` : ''}. Pass timelineId: "${r.copy.id}" to work on the version.`
      },
    },
    {
      name: 'delete_timeline',
      description:
        'Remove a timeline document — a version you are done with. Refused for the main timeline and for one placed as a section somewhere (flatten or delete the blocks first). Its undo history goes with it; the timeline is not recoverable.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { timelineId: { type: 'string', description: 'The timeline to delete, from list_timelines. Required — never the open one by default.' } },
        required: ['timelineId'],
      },
      run: async ({ timelineId }) => {
        const gone = await editor.deleteSequence(timelineId)
        return `Deleted ${gone.id} "${gone.name}".`
      },
    },
    {
      name: 'claim_timeline',
      description:
        'Say who is working on a timeline, so others keep off. Advisory: the claim shows in list_timelines and the rail; once you have named yourself here, edits to a timeline another agent holds are refused unless you take it over with force. Claims lapse after fifteen minutes; claim again to renew, release when done.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          timelineId: { type: 'string', description: 'Id from list_timelines. Defaults to the open timeline.' },
          agent: { type: 'string', description: 'Your name for this session, e.g. "agent-intro". Remembered for later calls.' },
          release: { type: 'boolean', description: 'true gives the claim up.' },
          force: { type: 'boolean', description: 'true takes over another agent\'s claim.' },
        },
        required: ['agent'],
      },
      run: async ({ timelineId, agent, release, force }) => {
        const r = await editor.claimTimeline({ timelineId, agent, release: !!release, force: !!force })
        return release
          ? `Released "${r.timeline.name}".`
          : `"${r.timeline.name}" (${r.timeline.id}) is claimed by ${r.claimedBy.agent}. Pass timelineId: "${r.timeline.id}" to work there.`
      },
    },
    {
      name: 'nest_items',
      description:
        'Group items into a new sub-timeline: they move into it (same layout, re-based to zero) and one block plays it in their place. The block opens as its own timeline — the unit of work to hand to an agent. Nothing is overwritten; a member on a locked track refuses the whole group. Returns the new timeline id and the block id.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemIds: { type: 'array', items: { type: 'string' }, description: 'Item ids from get_timeline. Defaults to the selection.' },
          name: { type: 'string', description: 'Name of the new sub-timeline.' },
        },
      },
      run: async ({ itemIds, name }) => {
        const r = await editor.nestItems({ itemIds, name })
        const sec = (ms) => (ms / 1000).toFixed(2) + 's'
        return `Grouped ${r.members} item(s) into ${r.child.id} "${r.child.name}"; block ${r.block.id} on ${r.track.name}, ${sec(r.start)}–${sec(r.end)}. open_timeline it to work inside.`
      },
    },
    {
      name: 'flatten_item',
      description:
        'Replace a timeline block with the items inside it, on parent tracks of the same kind and name (new tracks where those are busy; nothing is overwritten). Items are clipped to the block\'s window, volume and opacity scaled by the block\'s; the block\'s own fades are dropped. The sub-timeline itself stays in the project.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { itemId: { type: 'string', description: 'The block\'s item id from get_timeline.' } },
        required: ['itemId'],
      },
      run: async ({ itemId }) => {
        const r = await editor.flattenItem(itemId)
        return r.message
      },
    },
    {
      name: 'select_items',
      description: 'Select items on the timeline, as shift-clicking them would. The selection is what the Export parts dialog and the multi-item actions start from; an empty list clears it.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { itemIds: { type: 'array', items: { type: 'string' }, description: 'Item ids from get_timeline.' } },
        required: ['itemIds'],
      },
      run: ({ itemIds }) => {
        const items = editor.selectItems(itemIds)
        return items.length ? `Selected ${items.length}: ${items.map((i) => i.id).join(', ')}` : 'Selection cleared.'
      },
    },
    {
      name: 'detach_audio',
      description:
        'Separate an item\'s sound from its picture: the sound becomes its own item on an audio track (same file, in-point and length) and the picture is muted. Then either can be trimmed, moved, replaced (replace_audio) or silenced on its own. One undo step.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { itemId: itemIdProp }, required: ['itemId'] },
      run: async ({ itemId }) => {
        const r = await editor.detachAudio(itemId)
        return `Sound of ${itemId} is now ${r.audio.id} "${r.audio.name}" on ${r.track.name} (${fmtT(r.audio.startMs)}–${fmtT(r.audio.startMs + r.audio.durationMs)}s); ${itemId} is muted.`
      },
    },
    {
      name: 'add_track',
      description: 'Add a video track (above the others) or an audio track (below).',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['video', 'audio'], description: 'Track kind.' },
          name: { type: 'string', description: 'Optional name, e.g. "Titles".' },
        },
        required: ['kind'],
      },
      run: ({ kind, name }) => {
        const t = editor.addTrack(kind, name)
        return `Added ${t.id} "${t.name}" (${t.kind}).`
      },
    },
    {
      name: 'export_captions',
      description:
        'One subtitle file from the timeline\'s caption items — every caption item when itemIds is empty, or just those — timed as the captions fall on the timeline, so it lines up with the rendered video (times "source" keeps the original file\'s times; one transcript only). SRT, WebVTT or plain text (the words alone). Written into Exports; fetch the returned URL.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemIds: { type: 'array', items: { type: 'string' }, description: 'Caption item ids from get_timeline. Omit for all of them.' },
          format: { type: 'string', enum: ['srt', 'vtt', 'txt'], description: 'Default srt.' },
          times: { type: 'string', enum: ['timeline', 'source'], description: 'Default timeline.' },
          name: { type: 'string', description: 'File name without extension. Defaults to the item or timeline name.' },
        },
      },
      run: async (i) => {
        const r = await editor.exportCaptions({ itemIds: i.itemIds ?? [], format: i.format ?? 'srt', times: i.times ?? 'timeline', name: i.name ?? null })
        return `Wrote ${r.name} (${r.count} line(s), ${(r.size / 1024).toFixed(1)}KB) → ${r.url}`
      },
    },
    {
      name: 'move_track',
      description:
        'Reorder a track among those of its kind. Order is stacking order: the top track draws over everything beneath it, in the preview and in the render, so an overlay track that must show over another goes above it. Video tracks always stay above audio tracks. Give a direction (up, down, top, bottom) or a position counted from the top within the kind (0 = topmost). get_timeline lists tracks top to bottom.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track id or name from get_timeline.' },
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'One step, or all the way.' },
          index: { type: 'integer', description: 'Position from the top among tracks of the same kind, 0 = topmost. Overrides direction.' },
        },
        required: ['trackId'],
      },
      run: ({ trackId, direction, index }) => {
        const r = editor.moveTrack(trackId, { direction, index })
        return (r.moved ? `Moved ${r.track.id} "${r.track.name}" to position ${r.index + 1} of ${r.of} ${r.track.kind} tracks.` : `${r.track.id} "${r.track.name}" already there (${r.index + 1} of ${r.of}).`) +
          `\nTracks, top to bottom: ${r.order.join(' · ')}`
      },
    },
    {
      name: 'set_track',
      description: 'Rename, colour, annotate, mute, hide or lock a track. A note is free text shown in get_timeline — leave instructions for later. A locked track is skipped by cut_time_range, cut_source_ranges and remove_silence.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'From get_timeline.' },
          name: { type: 'string', description: 'New name, e.g. "Lower thirds".' },
          note: { type: 'string', description: 'Free text kept on the track. Empty string clears it.' },
          color: { type: 'string', description: '#rrggbb swatch for the track, or "none".' },
          muted: { type: 'boolean', description: 'Silence the whole track.' },
          hidden: { type: 'boolean', description: 'Hide a video track from preview and render.' },
          locked: { type: 'boolean', description: 'Protect it from ripple edits.' },
        },
        required: ['trackId'],
      },
      run: ({ trackId, name, note, color, muted, hidden, locked }) => {
        const t = editor.setTrack(trackId, { name, note, color, muted, hidden, locked })
        return `${trackLine(t)}`
      },
    },
    {
      name: 'seek_timeline',
      description: 'Move the timeline playhead so the preview shows that moment.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { timeSeconds: seconds('Timeline time.') }, required: ['timeSeconds'] },
      run: ({ timeSeconds }) => `Playhead at ${fmtT(editor.seekSequence(toMs(timeSeconds)))}s.`,
    },
    {
      name: 'speech_setup',
      description:
        'What this browser can currently do with speech: whether transcription and a voice are set up, which provider each uses, and where the audio would go. Call it before promising to transcribe or narrate — none of it is configured by default, and only the person at the keyboard can add a key. In the UI this is the Speech tab in the left rail: its foot names the provider for each job, and its Providers… button is where one is set up when nothing is.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const s = editor.speechStatus()
        const line = (what, d) =>
          !d.set
            ? `${what}: not set up. Ask the person to open the Speech tab in the left rail and press Providers…, or press Transcribe a clip… or Write a voice-over… there, which ask on their own.`
            : `${what}: ${d.label} — ${d.where}${d.language ? ` — language ${d.language}` : ''}${d.ready ? '' : ` — not usable yet: ${d.why}`}`
        return (
          `${line('transcription', s.transcription)}\n${line('voice', s.voice)}` +
          (s.voice.set && !s.voice.canRecord
            ? '\nThat voice reads aloud on this computer and cannot be recorded into a video; time_script still works with it.'
            : '') +
          (s.systemVoices ? '\nsystem voices: available for reading aloud and timing a script, always, with nothing sent anywhere.' : '') +
          ((s.transcription.leaves || s.voice.leaves) && !s.agentMayEgress
            ? '\nAgent-initiated sending is off, so I can only run the parts that stay on this computer. The person can change that in the same panel.'
            : '')
        )
      },
    },
    {
      name: 'transcribe_media',
      description:
        'Write down what is said in a library file, using whatever transcription the person has set up, and add the words as a transcript. Comes back with word timings where the provider gives them, so the result can be placed as karaoke captions. Check speech_setup first. The same job as the Transcribe button in the Speech rail, on a media tile with sound, and in a selected item\u2019s Sound section.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { sourceId: { type: 'string', description: 'The filename from list_media.' } },
        required: ['sourceId'],
      },
      run: async ({ sourceId }) => {
        // Not set up is not a failure, it is a missing step — and the thing an
        // agent can usefully do with a missing step is say what it is. An error
        // here reads as "this editor cannot transcribe", which is false.
        const s = editor.speechStatus()
        if (!s.transcription.set || !s.transcription.ready) {
          return notSetUp('transcription', s.transcription)
        }
        if (s.transcription.leaves && !s.agentMayEgress) return egressRefused('Transcription', s.transcription)
        const t = await editor.transcribeMedia(sourceId)
        return (
          `Wrote down "${sourceId}" → transcript ${t.id} "${t.name}": ${t.cueCount ?? t.cues?.length ?? 0} line(s), ` +
          `${fmtT(t.durationMs)}s${t.wordLevel ? ', with word timings' : ', no word timings'}. ` +
          `${destination(s.transcription)}\n` +
          `add_to_timeline with kind "transcript" places it as captions.`
        )
      },
    },
    {
      name: 'add_voice_over',
      description:
        'Read a script aloud into an audio file and drop it on an audio track. Needs a voice that returns audio — the computer\u2019s own voices cannot be recorded. Check speech_setup first; use time_script to see how long a script runs before committing to it. The same job as the Write a voice-over… button in the Speech rail, Voice-over… in a selected item\u2019s Sound section, and Voice-over from these lines… on a caption item.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What should be said.' },
          voice: { type: 'string', description: 'Voice id from list_voices. Default: the one chosen in the panel.' },
          language: { type: 'string', description: 'ISO code the script is in (es, en, pt…). Picks a voice of that language where each voice speaks one, or is sent with the script where voices are multilingual. Default: the language chosen in the panel, else auto.' },
          name: { type: 'string', description: 'A name for the audio file.' },
          atSeconds: seconds('Where on the timeline it starts. Defaults to the playhead.'),
        },
        required: ['text'],
      },
      run: async ({ text, voice, language, name, atSeconds }) => {
        const s = editor.speechStatus()
        if (!s.voice.set || !s.voice.ready) return notSetUp('a voice', s.voice)
        if (s.voice.leaves && !s.agentMayEgress) return egressRefused('This voice', s.voice)
        if (!s.voice.canRecord) {
          return (
            `${s.voice.label}: a browser will not let a page record what it says, so it cannot become a file. ` +
            `time_script still works with it and costs nothing. ` +
            `To put narration in the video the person needs a voice that returns audio — ask them to open the ` +
            `Speech tab in the left rail, press Providers… and pick one under Voice-over.`
          )
        }
        const m = await editor.addVoiceOver(text, { voice, name, language: language || null, atMs: atSeconds != null ? toMs(atSeconds) : null })
        // The id goes last and unpunctuated: a filename with a full stop welded
        // to its extension is a filename something will read one dot short.
        return (
          `Recorded "${m.name}" — ${fmtT(m.durationMs)}s — and placed it on an audio track. ` +
          `${s.voice.leaves ? `The script was sent to ${s.voice.host ?? s.voice.label}.` : 'It was made on your own machine; nothing left the computer.'}\n` +
          `sourceId: ${m.filename}`
        )
      },
    },
    {
      name: 'list_voices',
      description:
        'The voices the chosen voice provider can speak with, grouped by language, each with the id to pass as voice to add_voice_over — and which voice and language the person has selected. With VoiceBox it also counts the built-in presets add_voice can save as profiles. Check speech_setup first.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { language: { type: 'string', description: 'Only voices of this language, as an ISO code such as es or en.' } },
      },
      run: async ({ language }) => {
        const v = editor.listVoices()
        if (!v) return notSetUp('a voice', editor.speechStatus().voice)
        const want = language ? baseLang(language) : null
        const groups = groupVoices(v.voices, { first: want ?? v.language }).filter((g) => !want || g.lang === want || g.lang === 'und')
        const head =
          `${v.label}: ${v.voices.length} voice(s)` +
          (v.language ? `, language set to ${languageName(v.language)} (${v.language})` : ', language: auto') +
          (v.chosen ? `, selected: ${v.chosen}` : '') +
          '.\n'
        const lines = []
        for (const g of groups) {
          lines.push(`${g.label}:`)
          for (const x of g.voices) {
            lines.push(`  ${x.id}${x.name && x.name !== x.id ? `  ${x.name}` : ''}${x.gender ? `  ${x.gender}` : ''}${x.note ? `  ${x.note}` : ''}`)
          }
        }
        // VoiceBox's presets are voices it does not have yet: worth a count, and
        // the ids when one language was asked for, never the whole catalogue.
        let tail = ''
        if (v.id === 'voicebox') {
          try {
            const presets = await editor.listVoicePresets()
            const by = groupVoices(presets, { first: want ?? v.language }).filter((g) => !want || g.lang === want)
            const ids = want ? by.flatMap((g) => g.voices).slice(0, 10).map((x) => `${x.engine}/${x.id}`) : []
            tail =
              `\nVoiceBox presets not saved as profiles yet: ${presets.length} — ${by.map((g) => `${g.label} ${g.voices.length}`).join(', ')}. ` +
              `add_voice with preset "<engine>/<id>" saves one${ids.length ? `: ${ids.join(', ')}` : '; ask with a language to see ids'}.`
          } catch {
            /* the presets are a nicety; the voices above are the answer */
          }
        }
        if (!lines.length) {
          return head + (want ? `No voices in ${languageName(want)}.` : 'No voices listed yet — the person can press "Refresh voices" in the panel.') + tail
        }
        return head + fitLines(lines, head.length + tail.length, 'ask for one language.') + tail
      },
    },
    {
      name: 'add_voice',
      description:
        'Give the chosen voice provider a new voice and select it. VoiceBox: one of its built-in presets ("kokoro/ef_dora", from list_voices) saved as a profile, or a clone of a recording in the library — fromSourceId plus referenceText, the words said in it (the recording\u2019s transcript is used when there is one). ElevenLabs: an instant clone of a recording, which sends the audio there. Returns the voice id for add_voice_over.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What to call the voice.' },
          preset: { type: 'string', description: 'VoiceBox only: "<engine>/<voice id>" from list_voices, e.g. "kokoro/em_alex".' },
          fromSourceId: { type: 'string', description: 'A library recording with sound (filename from list_media) to clone.' },
          referenceText: { type: 'string', description: 'What is said in that recording, for VoiceBox. Default: its transcript.' },
          language: { type: 'string', description: 'ISO code of the voice\u2019s language, e.g. es. Default: the preset\u2019s, else the panel\u2019s choice.' },
        },
        required: ['name'],
      },
      run: async ({ name, preset, fromSourceId, referenceText, language }) => {
        const s = editor.speechStatus()
        if (!s.voice.set || !s.voice.ready) return notSetUp('a voice', s.voice)
        if (s.voice.id !== 'voicebox' && s.voice.id !== 'elevenlabs') {
          return `${s.voice.label} takes no new voices from here; its voices are what list_voices shows. VoiceBox and ElevenLabs can take one.`
        }
        if (preset && s.voice.id !== 'voicebox') return 'Presets are VoiceBox\u2019s; ElevenLabs takes a clone from a recording (fromSourceId).'
        if (!preset && !fromSourceId) return 'Give a preset (VoiceBox) or a fromSourceId (a library recording) to clone.'
        // A clone sends the recording to the provider; a preset sends nothing
        // but a name. Only the first is a send an agent may not make on its own.
        if (fromSourceId && s.voice.leaves && !s.agentMayEgress) return egressRefused('Cloning a voice', s.voice)
        const v = await editor.addVoice({ name, preset, fromSourceId, referenceText, language })
        return (
          `Added voice "${v.name}" (${languageName(v.lang)}) and selected it — use voice "${v.id}" in add_voice_over. ` +
          (fromSourceId ? (s.voice.leaves ? `The recording was sent to ${s.voice.host ?? s.voice.label}.` : 'The recording stayed on this machine.') : 'Nothing was sent anywhere.')
        )
      },
    },
    {
      name: 'time_script',
      description:
        'How long a script takes to say, and when each word lands, without recording anything or sending it anywhere. Uses the computer\u2019s own voice silently, so it always works, costs nothing, and is the cheap way to check a script fits a shot before paying anyone to voice it.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The script to time.' } },
        required: ['text'],
      },
      run: async ({ text }) => {
        const doc = await editor.timeScript(text)
        const words = doc.words ?? []
        // Not measured, because the browser would not speak. Say so rather
        // than presenting arithmetic as a reading.
        if (doc.estimated) {
          return (
            `About ${doc.duration.toFixed(1)}s to say — worked out from the word count, not measured. ` +
            `This browser will not speak on a page nobody has clicked yet; once the person has clicked ` +
            `anything, asking again gives the real timing and a time for every word.`
          )
        }
        return (
          `${doc.duration.toFixed(1)}s to say, ${words.length} words.\n` +
          fitLines(words.slice(0, 40).map((w) => `  ${w.start.toFixed(2)}–${w.end.toFixed(2)}s  ${w.word}`), 60, 'ask for a shorter passage to see the rest')
        )
      },
    },
    {
      name: 'render_timeline',
      description:
        'Render the whole timeline to a file: animation and caption layers are rendered to alpha first, then ffmpeg composites them over the footage and mixes the audio. mp4 = H.264+AAC; mov = ProRes 4444+PCM with alpha; webm = VP9+Opus. Takes seconds to minutes; run check_timeline first.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['mp4', 'mov', 'webm'], description: 'Default mp4.' },
          quality: { type: 'integer', description: 'CRF for mp4/webm, lower is better. Default 20.' },
        },
      },
      run: async ({ format, quality }) => {
        const r = await editor.renderSequence({ format: format ?? 'mp4', quality })
        return `Rendered ${r.filename}. ${renderedTo(r.downloadUrl)}\n${fmtT(r.durationMs)}s, ${r.layers} video layer(s), ${r.audio} audio, ${(r.size / 1024 / 1024).toFixed(1)}MB in ${(r.elapsedMs / 1000).toFixed(1)}s.`
      },
    },
    {
      name: 'save_frame',
      description:
        'Grab one frame into the asset library as a PNG: "footage" takes the exact source frame of the footage under the playhead (or timeSeconds); "composite" takes the whole stacked frame — footage, overlays, captions. Use it in a clip with <img src="/assets/NAME">: freeze frames, before/after, a still to draw over.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: seconds('Timeline time. Defaults to the playhead.'),
          source: { type: 'string', enum: ['footage', 'composite'], description: 'Default "footage".' },
          name: { type: 'string', description: 'A name for the asset file, e.g. "L4-ultima-fila". Default: the footage name and time.' },
        },
      },
      run: async ({ timeSeconds, source, name }) => {
        const a = await editor.saveFrame({ timeMs: toMs(timeSeconds), source: source ?? 'footage', name: name ?? '' })
        return `Saved ${a.url}${a.width ? ` (${a.width}x${a.height})` : ''}, ${(a.size / 1024).toFixed(0)}KB${a.origin ? ` — frame of ${a.origin.source} at ${fmtT(a.origin.atMs)}s` : ''}. Use it with <img src="${a.url}">.`
      },
    },
    {
      name: 'extract_frames',
      description:
        'Pull a series of frames from a media file into the asset library — evenly spaced (count) or at a rate (fps) between two SOURCE times, up to 60. Give an itemId to use that item\'s footage and range. For contact sheets, flipbooks, before/after grids.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          media: { type: 'string', description: 'Media filename from list_media (or use itemId).' },
          itemId: { type: 'string', description: 'A footage item; its source range is the default range.' },
          fromSeconds: seconds('Start, source time.'),
          toSeconds: seconds('End, source time.'),
          count: { type: 'integer', description: 'How many frames, evenly spaced. Default 6, max 60.' },
          fps: { type: 'number', description: 'Alternatively, frames per second across the range.' },
          width: { type: 'integer', description: 'Frame width in px. Default: source size.' },
          format: { type: 'string', enum: ['jpg', 'png'], description: 'Default jpg.' },
        },
      },
      run: async (i) => {
        const r = await editor.extract({ media: i.media, itemId: i.itemId, mode: 'frames', fromMs: toMs(i.fromSeconds), toMs: toMs(i.toSeconds), count: i.count, fps: i.fps, width: i.width, format: i.format })
        return `${r.assets.length} frame(s) added:\n` + fitLines(r.assets.map((a) => `${a.url}  @${fmtT(a.origin?.atMs ?? 0)}s`), 40, '')
      },
    },
    {
      name: 'extract_sprite',
      description:
        'Turn a range of footage into a sprite sheet asset plus the CSS that plays it with steps(). This is how real footage goes INSIDE an animation clip — masked, rounded, tilted, picture-in-picture, stuttered — since a clip cannot hold a <video>. Paste the returned CSS into the clip and add the div. Caps: 64 frames, 480px wide; a long range plays at a lower fps.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          media: { type: 'string', description: 'Media filename from list_media (or use itemId).' },
          itemId: { type: 'string', description: 'A footage item; its source range is the default range.' },
          fromSeconds: seconds('Start, source time.'),
          toSeconds: seconds('End, source time. Default: start + 3s.'),
          fps: { type: 'number', description: 'Frames per second in the sheet. Default 10.' },
          width: { type: 'integer', description: 'Width of each frame in px. Default 320 (about 1MB per sheet).' },
          format: { type: 'string', enum: ['jpg', 'png'], description: 'jpg (default) for footage; png keeps transparency.' },
        },
      },
      run: async (i) => {
        const r = await editor.extract({ media: i.media, itemId: i.itemId, mode: 'sprite', fromMs: toMs(i.fromSeconds), toMs: toMs(i.toSeconds), fps: i.fps, width: i.width, format: i.format })
        const sp = r.asset.sprite
        return `Sprite ${r.asset.url}: ${sp.frames} frames, ${sp.cols}x${sp.rows} grid of ${sp.frameWidth}x${sp.frameHeight}, ${sp.fps}fps, ${(r.asset.size / 1024).toFixed(0)}KB.\nCSS to paste into a clip (then add the div):\n${r.css}`
      },
    },
    {
      name: 'extract_subclip',
      description:
        'Cut a range of a media file into a new, frame-accurate media file in the library (re-encoded, up to ten minutes). For collecting selects and reusing a moment across timelines. Returns the new filename to use as sourceId.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          media: { type: 'string', description: 'Media filename from list_media (or use itemId).' },
          itemId: { type: 'string', description: 'A footage item; its source range is the default range.' },
          fromSeconds: seconds('Start, source time.'),
          toSeconds: seconds('End, source time.'),
          name: { type: 'string', description: 'Name for the new file.' },
        },
      },
      run: async (i) => {
        const m = await editor.extract({ media: i.media, itemId: i.itemId, mode: 'subclip', fromMs: toMs(i.fromSeconds), toMs: toMs(i.toSeconds), name: i.name })
        return `Added ${m.filename}: ${fmtT(m.durationMs)}s${m.hasVideo ? `, ${m.width}x${m.height}` : ''}${m.hasAudio ? ', with audio' : ''}. Use it as sourceId in add_to_timeline.`
      },
    },
    {
      name: 'reverse_media',
      description:
        'Play a media file backwards, as a new file in the library. Reversing has to hold the whole stream in memory — there is no way to know the last frame first — so it is capped at three minutes; cut the part you want with extract_subclip and reverse that. Returns the new filename to use as sourceId.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          media: { type: 'string', description: 'Media filename from list_media (or use itemId).' },
          itemId: { type: 'string', description: 'A footage item; its source is reversed.' },
          name: { type: 'string', description: 'Name for the new file.' },
        },
      },
      run: async (i) => {
        const m = await editor.extract({ media: i.media, itemId: i.itemId, mode: 'reverse', name: i.name })
        return `Added ${m.filename}: ${fmtT(m.durationMs)}s reversed${m.hasVideo ? `, ${m.width}x${m.height}` : ''}${m.hasAudio ? ', with audio' : ''}. Use it as sourceId in add_to_timeline.`
      },
    },
    {
      name: 'set_keyframe',
      description:
        'Make a value different at two moments and the editor draws the line between: where the layer sits (offsetX, offsetY), how big it is (scale) and how solid (opacity). Times are the *item\'s own*, counted from its start, so trimming its head does not re-time the move inside it. Leave value out to key whatever the item is at right now. Rotation cannot be keyframed — turning changes the size of the box a layer needs, and a box that changed size every frame would make the placement arithmetic time-varying everywhere.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          property: { type: 'string', enum: ['offsetX', 'offsetY', 'scale', 'opacity'] },
          atSeconds: { type: 'number', description: "Where, in the item's own time (0 = its start). Defaults to the playhead." },
          value: { type: 'number', description: 'What it should be there. Defaults to what it is now.' },
          ease: { type: 'string', enum: ['ease', 'linear', 'hold'], description: 'How it leaves this key. ease slows in and out, linear is a straight line, hold stays put until the next. Default ease.' },
        },
        required: ['itemId', 'property'],
      },
      run: (i) => {
        const r = editor.setKeyframe({ itemId: i.itemId, property: i.property, atSeconds: i.atSeconds, value: i.value, ease: i.ease })
        return `${i.property} = ${r.v} at ${fmtT(r.at)}s into "${r.item.name}".`
      },
    },
    {
      name: 'list_keyframes',
      description: "Every keyframe on an item, per property, in the item's own time.",
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { itemId: itemIdProp }, required: ['itemId'] },
      run: (i) => {
        const k = editor.listKeyframes(i.itemId)
        const props = Object.keys(k)
        if (!props.length) return 'That item stands still — no keyframes.'
        return props.map((p) => `${p}: ${k[p].map((x) => `${fmtT(x.ms)}s=${x.v}${x.ease === 'ease' ? '' : ` (${x.ease})`}`).join(', ')}`).join('\n')
      },
    },
    {
      name: 'clear_keyframes',
      description: 'Remove keyframes from an item — one property, or all of them. It goes back to standing still at whatever its plain values are.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          property: { type: 'string', enum: ['offsetX', 'offsetY', 'scale', 'opacity'], description: 'Leave out to clear every property.' },
        },
        required: ['itemId'],
      },
      run: (i) => `Cleared ${i.property ?? 'every'} keyframe(s) on ${editor.clearKeyframes(i.itemId, i.property).id}.`,
    },
    {
      name: 'freeze_frame',
      description:
        'Hold one frame: save it to Assets and place it on the timeline as a still. A freeze is a picture of a shot rather than a property of it, so what you get is an ordinary image item — it trims, moves, scales, turns and renders like any other.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          atSeconds: seconds('Which moment. Defaults to the playhead.'),
          source: { type: 'string', enum: ['composite', 'footage'], description: 'composite = everything the preview shows; footage = the raw shot with no overlays. Default composite.' },
        },
      },
      run: async (i) => {
        const r = await editor.freezeFrame({ atMs: toMs(i.atSeconds), source: i.source })
        return `Froze ${fmtT(r.atMs)}s as ${r.asset?.name ?? 'a still'} and placed it${r.item ? ` as ${r.item.id}` : ''}.`
      },
    },
    {
      name: 'add_marker',
      description:
        'Pin a moment on the timeline — a beat to cut on, a mistake to come back to, the top of a section. Markers belong to the timeline rather than to any item, because what they usually mark is the join between two, and a note on either would go when that one was trimmed. Dropping one on a moment that already has a marker renames it instead of stacking two.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          atSeconds: seconds('Where. Defaults to the playhead.'),
          label: { type: 'string', description: 'What happens here.' },
          timelineId: timelineIdProp,
        },
      },
      run: (i) => {
        const m = editor.addMarker({ atMs: toMs(i.atSeconds), label: i.label, timelineId: i.timelineId })
        return `Marker at ${fmtT(m.ms)}s${m.label ? ` — ${m.label}` : ''}.`
      },
    },
    {
      name: 'list_markers',
      description: 'Every marker on a timeline, in time order.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { timelineId: timelineIdProp } },
      run: (i) => {
        const list = editor.listMarkers(i.timelineId)
        if (!list.length) return 'No markers on that timeline.'
        return list.map((m) => `${fmtT(m.ms)}s  ${m.label || '(no label)'}  [${m.id}]`).join('\n')
      },
    },
    {
      name: 'delete_marker',
      description: 'Remove a marker by its id (from list_markers).',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { markerId: { type: 'string' }, timelineId: timelineIdProp }, required: ['markerId'] },
      run: (i) => (editor.deleteMarker(i.markerId, i.timelineId) ? `Removed ${i.markerId}.` : `No marker ${i.markerId}.`),
    },
    {
      name: 'cross_dissolve',
      description:
        'Turn the cut after an item into a cross dissolve. One track holds one item at a time, so the next item is lifted to the track above and pulled back over this one, and both get the matching half of the fade. The result is two ordinary items with ordinary dissolves — they trim, move and delete as such.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          itemId: itemIdProp,
          seconds: { type: 'number', description: 'How long the dissolve lasts. Default 0.6.' },
        },
        required: ['itemId'],
      },
      run: async (i) => editor.crossDissolve(i.itemId, toMs(i.seconds ?? 0.6)),
    },
    {
      name: 'undo_edit',
      description: 'Undo the last edit to a timeline (any tool that changed it, or a hand edit). Each timeline has its own history, up to 100 steps.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: {} },
      run: () => (editor.undo() ? `Undone. ${editor.historyDepth().undo} step(s) left.` : 'Nothing to undo.'),
    },
    {
      name: 'redo_edit',
      description: 'Redo the last undone timeline edit.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: {} },
      run: () => (editor.redo() ? 'Redone.' : 'Nothing to redo.'),
    },
  ]

  /**
   * Scope. Every tool that reads or edits a timeline takes an optional
   * `timelineId` and works there without opening it — an agent cuts its
   * section while the person, or another agent, is on the main timeline.
   * The few that need the stage (capture, seek, render, select) open the
   * timeline first, since the stage shows one thing at a time.
   */
  const SCOPED = new Set([
    'duplicate_timeline', 'get_narration', 'check_layout', 'find_in_transcript',
    'get_timeline', 'check_timeline', 'set_timeline_settings', 'add_text', 'add_shape', 'add_to_timeline', 'set_item', 'move_item',
    'split_item', 'delete_item', 'cut_time_range', 'cut_source_ranges', 'detect_silence', 'remove_silence', 'replace_audio',
    'export_parts', 'export_captions', 'nest_items', 'flatten_item', 'detach_audio', 'add_track', 'set_track', 'move_track', 'undo_edit', 'redo_edit',
  ])
  const OPENS = new Set(['capture_timeline_frame', 'seek_timeline', 'render_timeline', 'select_items', 'save_frame'])
  const scopeProp = {
    type: 'string',
    description: 'Work in this timeline (id from list_timelines) instead of the open one. It need not be open; the view stays where it is.',
  }
  for (const t of tools) {
    if (SCOPED.has(t.name)) {
      t.inputSchema = { ...(t.inputSchema ?? { type: 'object' }), properties: { ...(t.inputSchema?.properties ?? {}), timelineId: scopeProp } }
      const run = t.run
      t.run = (args = {}) => editor.withScope(args.timelineId, () => run(args))
    } else if (OPENS.has(t.name)) {
      t.inputSchema = {
        ...(t.inputSchema ?? { type: 'object' }),
        properties: { ...(t.inputSchema?.properties ?? {}), timelineId: { type: 'string', description: 'Open this timeline first (id from list_timelines).' } },
      }
      const run = t.run
      t.run = async (args = {}) => {
        if (args.timelineId && args.timelineId !== editor.openSequence()?.id) await editor.selectSequence(args.timelineId)
        return run(args)
      }
    }
  }
  return tools
}

/**
 * Check the arguments a tool did recognise before running it.
 *
 * A wrong *name* is caught elsewhere; this catches a wrong *value*, and the
 * one that matters is a number that is not one. `timeSeconds * 1000` on a
 * missing or non-numeric argument is NaN, and NaN does not throw — it clamps
 * through `Math.min`/`Math.max` unchanged and lands in the transport, the
 * geometry and the saved document, where it shows up later as a blank frame
 * nobody can explain. An agent can recover from a sentence; it cannot recover
 * from a timeline quietly holding NaN.
 *
 * Numeric strings are accepted and coerced: an agent that sends "2" for a
 * number means 2, and refusing it teaches nothing.
 *
 * Returns the arguments to actually run with.
 */
function checkArguments(tool, schema, args) {
  const props = schema?.properties ?? {}
  const out = { ...args }

  for (const name of schema?.required ?? []) {
    if (out[name] === undefined || out[name] === null) {
      throw new Error(`${tool}: ${name} is required`)
    }
  }

  for (const [name, v] of Object.entries(out)) {
    const type = props[name]?.type
    if (type !== 'number' && type !== 'integer') continue
    if (v === undefined || v === null) continue
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!Number.isFinite(n)) {
      throw new Error(`${tool}: ${name} must be a number, got ${JSON.stringify(v)}`)
    }
    out[name] = type === 'integer' ? Math.round(n) : n
  }
  return out
}

/**
 * Names that mean the same thing across the tool surface.
 *
 * A moment in time is `timeSeconds` on the four tools that move the playhead
 * and `atSeconds` on the seven that do something at a point — both read well
 * where they are, and neither is wrong. But a model holding seventy-odd tools
 * in its head does not reliably remember which is which, and guessing costs a
 * whole round trip to be told the other name.
 *
 * So a synonym the tool does not take is quietly resolved to the one it does.
 * A correct call is untouched, an explicit value always wins over an aliased
 * one, and a genuinely unknown argument is still refused by name.
 */
const SYNONYMS = [['timeSeconds', 'atSeconds', 'startSeconds']]

function resolveSynonyms(args, known) {
  let out = args
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue
    const group = SYNONYMS.find((g) => g.includes(key))
    if (!group) continue
    const target = group.find((n) => n !== key && known.includes(n))
    // Only when there is exactly one place for it to go and nothing there yet.
    if (!target || args[target] !== undefined) continue
    if (out === args) out = { ...args }
    out[target] = out[key]
    delete out[key]
  }
  return out
}

/** "unknown argument durationMs (did you mean durationSeconds?) — add_text takes: …" */
function unknownArguments(tool, bad, known) {
  const stem = (x) => x.toLowerCase().replace(/(millis|ms|seconds|secs|sec|id|ids)$/, '')
  const nearest = (k) => {
    let best = null
    let score = 0
    for (const n of known) {
      const a = k.toLowerCase(), b = n.toLowerCase()
      let s = 0
      if (stem(a) === stem(b)) s = 90
      else {
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        s = i >= 4 ? 50 + i : i
      }
      if (s > score) { score = s; best = n }
    }
    return score >= 4 ? best : null
  }
  const hint = (k) => { const n = nearest(k); return n ? `${k} (did you mean ${n}?)` : k }
  return `unknown argument${bad.length > 1 ? 's' : ''} ${bad.map(hint).join(', ')} — ${tool} takes: ${known.join(', ') || 'no arguments'}`
}

/* --------------------------------------------------------------- public */

/**
 * Register the editor's tools with the browser's model context.
 * Returns a status object for the UI; never throws.
 */
export async function initWebMcp(editor, { local = false } = {}) {
  const isLocalBuild = () => local

  const { ctx, via } = resolveContainer()
  if (!ctx) {
    return {
      ok: false,
      count: 0,
      reason: 'document.modelContext unavailable — enable chrome://flags/#enable-webmcp-testing and relaunch Chrome',
    }
  }

  const override = new URLSearchParams(location.search).get('mcpResult')
  resultStyle =
    override === 'content' || override === 'string'
      ? override
      : typeof ctx.provideContext === 'function'
        ? 'content'
        : 'string'

  let tools
  try {
    tools = [...buildTools(editor), ...buildSequenceTools(editor)]
  } catch (err) {
    return { ok: false, count: 0, reason: `could not build tools: ${err?.message ?? err}` }
  }

  // An argument the tool does not know is refused, with the nearest real
  // name. Silently ignoring `durationMs` where the tool wants
  // `durationSeconds` cost an afternoon once; a wrong call must say so.
  for (const t of tools) {
    const known = Object.keys(t.inputSchema?.properties ?? {})
    const run = t.run
    t.run = (args = {}) => {
      const input = resolveSynonyms(args ?? {}, known)
      const bad = Object.keys(input).filter((k) => !known.includes(k))
      if (bad.length) throw new Error(unknownArguments(t.name, bad, known))
      return run(checkArguments(t.name, t.inputSchema, input))
    }
  }

  /**
   * A few tools are ffmpeg wearing a tool's clothes, and a build with no server
   * has no ffmpeg. Rather than register them and let an agent discover the
   * truth as a 501 halfway through a plan, they are left out and the rest say
   * what this build is — so a model plans around it instead of into it.
   */
  const SERVER_ONLY = {
    extract_frames: 'pulling frames out of a file needs ffmpeg. Use capture_timeline_frame, which draws the frame in the browser.',
    extract_sprite: 'sprite sheets need ffmpeg.',
    extract_subclip: 'cutting a new media file needs ffmpeg. Trim the item on the timeline instead — it costs nothing and is undoable.',
    reverse_media: 'reversing a file needs ffmpeg.',
    export_parts: 'rendering each item to its own file needs ffmpeg. render_timeline renders the whole timeline here.',
  }
  const usable = tools.filter((t) => !(isLocalBuild() && SERVER_ONLY[t.name]))

  const descriptors = usable.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
    execute: (input, opts) => runSafely(t, input, opts).then(formatResult),
  }))

  try {
    controller?.abort()
    controller = new AbortController()

    if (typeof ctx.registerTool === 'function') {
      for (const d of descriptors) {
        await ctx.registerTool(d, { signal: controller.signal })
      }
    } else if (typeof ctx.provideContext === 'function') {
      // Older surface: set the whole tool list at once.
      ctx.provideContext({ tools: descriptors })
    } else {
      return { ok: false, count: 0, reason: 'modelContext exposes neither registerTool nor provideContext' }
    }
  } catch (err) {
    return { ok: false, count: 0, reason: `registration failed: ${err?.message ?? err}` }
  }

  return {
    ok: true,
    count: descriptors.length,
    omitted: tools.length - usable.length,
    via,
    resultStyle,
    names: usable.map((t) => t.name),
  }
}

/** Remove every registered tool. Exposed mainly for tests. */
export function teardownWebMcp() {
  controller?.abort()
  controller = null
}
