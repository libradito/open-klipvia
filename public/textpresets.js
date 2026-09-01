/**
 * Text presets — titles you type into rather than code.
 *
 * Each preset compiles text plus a handful of style fields into the same shape
 * a caption item compiles to: a full-frame transparent clip, pure CSS, timed
 * against the item. It previews, scrubs and renders through the machinery that
 * already exists, and "Convert to animation clip" hands the generated HTML and
 * CSS over the moment a preset is not enough.
 *
 * Timing convention: the entrance runs from clip time zero; the exit is baked
 * to end exactly at the clip's last frame. An item's in-point trims the
 * entrance, its length moves the exit — the way trimming footage works.
 *
 * Every animation is written longhand: a var() inside the `animation`
 * shorthand is ambiguous about which time value it is.
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const L = (...lines) => lines.join('\n')

/** One span per word, `--i` counting up for staggers. */
const wordSpans = (text) =>
  String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => `<span class="w" style="--i:${i}">${esc(w)}</span>`)
    .join(' ')

/** One span per character, spaces kept so wrapping still works. */
const charSpans = (text) =>
  [...String(text ?? '')]
    .map((c, i) => (c === ' ' ? ' ' : `<span class="c" style="--i:${i}">${esc(c)}</span>`))
    .join('')

export function defaultTextStyle() {
  return {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 96,
    color: '#ffffff',
    accent: '#5b9cff',
    boxColor: '#000000b3',
    weight: 800,
    uppercase: false,
    align: 'center',
  }
}

/** Font, colour and case rules shared by every preset. */
const baseText = (style) => L(
  `  font-family:${style.fontFamily};`,
  `  font-weight:${style.weight};`,
  `  color:${style.color};`,
  style.uppercase ? '  text-transform:uppercase;' : '',
  '  -webkit-font-smoothing:antialiased;',
)

/** Two-animation timing: `in` from zero, `out` ending on the last frame. */
const inOut = (inName, inMs, outName, outMs, outAt, easeIn = 'cubic-bezier(.16,1,.3,1)', easeOut = 'cubic-bezier(.7,0,.84,0)') => L(
  `  animation-name:${inName}, ${outName};`,
  `  animation-duration:${inMs}ms, ${outMs}ms;`,
  `  animation-delay:0ms, ${outAt}ms;`,
  `  animation-timing-function:${easeIn}, ${easeOut};`,
  `  animation-fill-mode:both, forwards;`,
)

export const TEXT_PRESETS = [
  {
    id: 'title',
    name: 'Title',
    note: 'Centred, rises in, fades out',
    fields: ['text', 'subtext'],
    defaultDurationMs: 4000,
    inMs: 700,
    outMs: 500,
    defaults: { fontSize: 110 },
    build({ text, subtext, style, totalMs, outMs }) {
      const outAt = Math.max(0, totalMs - outMs)
      return {
        html: L(
          '<div class="stage">',
          `  <div class="t">${esc(text)}</div>`,
          subtext ? `  <div class="s">${esc(subtext)}</div>` : '',
          '</div>',
        ),
        css: L(
          `.stage { position:absolute; inset:0; display:flex; flex-direction:column; align-items:${style.align === 'left' ? 'flex-start' : style.align === 'right' ? 'flex-end' : 'center'}; justify-content:center; gap:.25em; padding:0 8%; text-align:${style.align}; }`,
          '.t {',
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:1.05; letter-spacing:-.02em; text-wrap:balance;`,
          inOut('rise', 700, 'leave', outMs, outAt),
          '}',
          '.s {',
          baseText(style),
          `  font-size:${Math.round(style.fontSize * 0.36)}px; font-weight:500; color:${style.accent}; letter-spacing:.08em; text-transform:uppercase;`,
          inOut('rise', 700, 'leave', outMs, outAt),
          '  animation-delay:180ms, ' + outAt + 'ms;',
          '}',
          '@keyframes rise { from { opacity:0; transform:translateY(.5em); } to { opacity:1; transform:translateY(0); } }',
          '@keyframes leave { from { opacity:1; transform:translateY(0); } to { opacity:0; transform:translateY(-.3em); } }',
        ),
      }
    },
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    note: 'Name and role, bar wipes in bottom-left',
    fields: ['text', 'subtext'],
    defaultDurationMs: 5000,
    inMs: 800,
    outMs: 500,
    defaults: { fontSize: 56, align: 'left' },
    build({ text, subtext, style, totalMs, outMs, seq }) {
      const outAt = Math.max(0, totalMs - outMs)
      const bottom = Math.round(seq.height * 0.1)
      const left = Math.round(seq.width * 0.06)
      return {
        html: L(
          '<div class="lt">',
          '  <div class="bar"></div>',
          '  <div class="box">',
          `    <div class="name">${esc(text)}</div>`,
          subtext ? `    <div class="role">${esc(subtext)}</div>` : '',
          '  </div>',
          '</div>',
        ),
        css: L(
          `.lt { position:absolute; left:${left}px; bottom:${bottom}px; display:flex; align-items:stretch; }`,
          `.bar { width:${Math.round(style.fontSize * 0.18)}px; background:${style.accent}; transform-origin:top; `,
          inOut('wipe', 500, 'unwipe', outMs, outAt),
          '}',
          `.box { padding:.35em .9em .4em; background:${style.boxColor}; overflow:hidden; }`,
          '.name, .role { display:block; transform:translateX(-110%); }',
          '.name {',
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:1.1;`,
          inOut('slide', 600, 'slideout', outMs, outAt),
          '  animation-delay:220ms, ' + outAt + 'ms;',
          '}',
          '.role {',
          baseText(style),
          `  font-size:${Math.round(style.fontSize * 0.5)}px; font-weight:500; color:${style.accent}; letter-spacing:.06em; margin-top:.15em;`,
          inOut('slide', 600, 'slideout', outMs, outAt),
          '  animation-delay:340ms, ' + outAt + 'ms;',
          '}',
          '@keyframes wipe { from { transform:scaleY(0); } to { transform:scaleY(1); } }',
          '@keyframes unwipe { from { transform:scaleY(1); } to { transform:scaleY(0); } }',
          '@keyframes slide { from { transform:translateX(-110%); } to { transform:translateX(0); } }',
          '@keyframes slideout { from { transform:translateX(0); } to { transform:translateX(-110%); } }',
        ),
      }
    },
  },
  {
    id: 'subtitle-bar',
    name: 'Subtitle bar',
    note: 'Full-width band along the bottom',
    fields: ['text'],
    defaultDurationMs: 4000,
    inMs: 450,
    outMs: 400,
    defaults: { fontSize: 46, weight: 600 },
    build({ text, style, totalMs, outMs, seq }) {
      const outAt = Math.max(0, totalMs - outMs)
      return {
        html: `<div class="band"><div class="txt">${esc(text)}</div></div>`,
        css: L(
          `.band { position:absolute; left:0; right:0; bottom:${Math.round(seq.height * 0.08)}px; padding:.5em 6%; background:${style.boxColor}; text-align:${style.align};`,
          inOut('up', 450, 'down', outMs, outAt),
          '}',
          '.txt {',
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:1.3; text-wrap:balance;`,
          inOut('fade', 500, 'unfade', outMs, outAt),
          '  animation-delay:150ms, ' + outAt + 'ms;',
          '}',
          '@keyframes up { from { transform:translateY(120%); } to { transform:translateY(0); } }',
          '@keyframes down { from { transform:translateY(0); } to { transform:translateY(120%); } }',
          '@keyframes fade { from { opacity:0; } to { opacity:1; } }',
          '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
        ),
      }
    },
  },
  {
    id: 'pop-words',
    name: 'Pop words',
    note: 'Each word pops in, one after another',
    fields: ['text'],
    defaultDurationMs: 4000,
    inMs: 900,
    outMs: 400,
    defaults: { fontSize: 104 },
    build({ text, style, totalMs, outMs }) {
      const outAt = Math.max(0, totalMs - outMs)
      return {
        html: `<div class="stage"><div class="line">${wordSpans(text)}</div></div>`,
        css: L(
          `.stage { position:absolute; inset:0; display:flex; align-items:center; justify-content:${style.align === 'left' ? 'flex-start' : style.align === 'right' ? 'flex-end' : 'center'}; padding:0 8%; }`,
          '.line {',
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:1.1; letter-spacing:-.02em; text-align:${style.align}; white-space:pre-wrap;`,
          inOut('hold', 1, 'unfade', outMs, outAt),
          '}',
          '.w { display:inline-block; transform:scale(0); opacity:0;',
          '  animation-name:pop; animation-duration:420ms; animation-delay:calc(var(--i) * 120ms);',
          '  animation-timing-function:cubic-bezier(.2,1.6,.4,1); animation-fill-mode:both;',
          '}',
          '@keyframes pop { from { transform:scale(0); opacity:0; } 60% { opacity:1; } to { transform:scale(1); opacity:1; } }',
          '@keyframes hold { from, to { opacity:1; } }',
          '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
        ),
      }
    },
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    note: 'Letter by letter, with a caret',
    fields: ['text'],
    defaultDurationMs: 5000,
    inMs: 1200,
    outMs: 400,
    defaults: { fontSize: 64, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', weight: 600, align: 'left' },
    build({ text, style, totalMs, outMs }) {
      const outAt = Math.max(0, totalMs - outMs)
      const n = [...String(text ?? '')].length
      const step = Math.max(28, Math.min(70, Math.round(1600 / Math.max(1, n))))
      return {
        html: `<div class="stage"><div class="line">${charSpans(text)}<span class="caret"></span></div></div>`,
        css: L(
          `.stage { position:absolute; inset:0; display:flex; align-items:center; justify-content:${style.align === 'center' ? 'center' : style.align === 'right' ? 'flex-end' : 'flex-start'}; padding:0 8%; }`,
          '.line {',
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:1.3; white-space:pre-wrap; max-width:100%;`,
          inOut('hold', 1, 'unfade', outMs, outAt),
          '}',
          '.c { opacity:0; animation-name:show; animation-duration:1ms; animation-delay:calc(var(--i) * ' + step + 'ms); animation-fill-mode:forwards; }',
          `.caret { display:inline-block; width:.55em; height:1em; vertical-align:-.12em; margin-left:.08em; background:${style.accent};`,
          '  animation-name:blink; animation-duration:900ms; animation-timing-function:steps(2, jump-none); animation-iteration-count:infinite; }',
          '@keyframes show { from { opacity:0; } to { opacity:1; } }',
          '@keyframes blink { from { opacity:1; } to { opacity:0; } }',
          '@keyframes hold { from, to { opacity:1; } }',
          '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
        ),
      }
    },
  },
  {
    id: 'impact',
    name: 'Impact',
    note: 'Huge outlined word slams in',
    fields: ['text'],
    defaultDurationMs: 2500,
    inMs: 400,
    outMs: 350,
    defaults: { fontSize: 200, weight: 900, uppercase: true },
    build({ text, style, totalMs, outMs }) {
      const outAt = Math.max(0, totalMs - outMs)
      return {
        html: `<div class="stage"><div class="big">${esc(text)}</div></div>`,
        css: L(
          '.stage { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:0 4%; }',
          '.big {',
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:.95; letter-spacing:-.03em; text-align:center; text-wrap:balance;`,
          `  -webkit-text-stroke:${Math.max(2, Math.round(style.fontSize * 0.03))}px ${style.accent}; paint-order:stroke fill;`,
          `  text-shadow:0 ${Math.round(style.fontSize * 0.06)}px 0 ${style.accent}55;`,
          inOut('slam', 400, 'blowout', outMs, outAt, 'cubic-bezier(.2,1.4,.3,1)'),
          '}',
          '@keyframes slam { from { transform:scale(3.2); opacity:0; } 55% { opacity:1; } to { transform:scale(1); opacity:1; } }',
          '@keyframes blowout { from { transform:scale(1); opacity:1; } to { transform:scale(1.25); opacity:0; } }',
        ),
      }
    },
  },
  {
    id: 'label',
    name: 'Label',
    note: 'Small tag in the corner, slides in',
    fields: ['text'],
    defaultDurationMs: 4000,
    inMs: 450,
    outMs: 350,
    defaults: { fontSize: 36, weight: 700 },
    build({ text, style, totalMs, outMs, seq }) {
      const outAt = Math.max(0, totalMs - outMs)
      return {
        html: `<div class="tag">${esc(text)}</div>`,
        css: L(
          `.tag { position:absolute; left:${Math.round(seq.width * 0.05)}px; top:${Math.round(seq.height * 0.07)}px;`,
          baseText(style),
          `  font-size:${style.fontSize}px; line-height:1; padding:.5em .9em; border-radius:.3em; background:${style.boxColor};`,
          `  border-left:.28em solid ${style.accent}; letter-spacing:.04em;`,
          inOut('inleft', 450, 'outleft', outMs, outAt),
          '}',
          '@keyframes inleft { from { transform:translateX(-130%); opacity:0; } to { transform:translateX(0); opacity:1; } }',
          '@keyframes outleft { from { transform:translateX(0); opacity:1; } to { transform:translateX(-130%); opacity:0; } }',
        ),
      }
    },
  },
  {
    id: 'quote',
    name: 'Quote',
    note: 'Quotation with a rule and attribution',
    fields: ['text', 'subtext'],
    defaultDurationMs: 6000,
    inMs: 900,
    outMs: 600,
    defaults: { fontSize: 72, weight: 500 },
    build({ text, subtext, style, totalMs, outMs }) {
      const outAt = Math.max(0, totalMs - outMs)
      return {
        html: L(
          '<div class="stage">',
          `  <div class="mark">“</div>`,
          `  <div class="q">${esc(text)}</div>`,
          '  <div class="rule"></div>',
          subtext ? `  <div class="by">${esc(subtext)}</div>` : '',
          '</div>',
        ),
        css: L(
          '.stage { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0 12%; text-align:center; }',
          `.mark { font-family:Georgia, "Times New Roman", serif; font-size:${Math.round(style.fontSize * 2.2)}px; line-height:.6; color:${style.accent}; margin-bottom:.15em;`,
          inOut('fadeup', 600, 'unfade', outMs, outAt),
          '}',
          '.q {',
          baseText(style),
          `  font-size:${style.fontSize}px; font-style:italic; line-height:1.25; text-wrap:balance;`,
          inOut('fadeup', 800, 'unfade', outMs, outAt),
          '  animation-delay:200ms, ' + outAt + 'ms;',
          '}',
          `.rule { width:8em; height:3px; margin:.6em 0; background:${style.accent}; transform-origin:center;`,
          inOut('grow', 700, 'unfade', outMs, outAt),
          '  animation-delay:500ms, ' + outAt + 'ms;',
          '}',
          '.by {',
          baseText(style),
          `  font-size:${Math.round(style.fontSize * 0.42)}px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:${style.color}cc;`,
          inOut('fadeup', 600, 'unfade', outMs, outAt),
          '  animation-delay:700ms, ' + outAt + 'ms;',
          '}',
          '@keyframes fadeup { from { opacity:0; transform:translateY(.4em); } to { opacity:1; transform:translateY(0); } }',
          '@keyframes grow { from { transform:scaleX(0); } to { transform:scaleX(1); } }',
          '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
        ),
      }
    },
  },
]

/* ------------------------------------------------------------------ shapes */
/*
 * Shapes ride the same rails as titles: a preset with no text, whose clip is
 * exactly the shape's size and is placed by the item's anchor and offsets. A
 * rectangle in the footage's own colour hides an account name; a ring or a
 * highlight points at something; an arrow says "here". No clip code, and
 * agents get them through add_shape.
 */

const SHAPE_DEFAULTS = { width: 320, height: 120, radius: 0, stroke: 0, color: '#1f2937', accent: '#5b9cff', direction: 'right' }

/** Encoders want even sizes; a 1px shape wants to exist. */
const even = (n, lo, hi) => Math.max(lo, Math.min(hi, 2 * Math.round((Number(n) || 0) / 2)))
const shapeSize = (style) => ({
  width: even(style.width ?? SHAPE_DEFAULTS.width, 4, 4096),
  height: even(style.height ?? SHAPE_DEFAULTS.height, 4, 4096),
})
const fillOf = (style) => (!style.color || String(style.color).toLowerCase() === 'none' ? 'transparent' : style.color)
const outlineOf = (style) =>
  Number(style.stroke) > 0 ? `box-shadow:inset 0 0 0 ${Math.round(Number(style.stroke))}px ${style.accent};` : ''

const ARROWS = {
  right: 'polygon(0 32%, 58% 32%, 58% 4%, 100% 50%, 58% 96%, 58% 68%, 0 68%)',
  left: 'polygon(100% 32%, 42% 32%, 42% 4%, 0 50%, 42% 96%, 42% 68%, 100% 68%)',
  down: 'polygon(32% 0, 68% 0, 68% 58%, 96% 58%, 50% 100%, 4% 58%, 32% 58%)',
  up: 'polygon(32% 100%, 68% 100%, 68% 42%, 96% 42%, 50% 0, 4% 42%, 32% 42%)',
}

/**
 * `body(style)` returns the CSS declarations of the one div the shape is.
 * `alpha` is the shape's resting opacity; the entrance and exit (if any)
 * fade to and from it.
 */
const shapePreset = ({ id, name, note, defaults = {}, body, inMs = 0, outMs = 0, alpha = 1 }) => ({
  id,
  name,
  note,
  kind: 'shape',
  fields: [],
  defaultDurationMs: 5000,
  inMs,
  outMs,
  defaults: { ...SHAPE_DEFAULTS, ...defaults },
  size: shapeSize,
  build({ style, totalMs, outMs: out }) {
    const outAt = Math.max(0, totalMs - out)
    return {
      html: '<div class="s"></div>',
      css: L(
        `.s { position:absolute; inset:0; box-sizing:border-box; opacity:${alpha};`,
        body(style),
        out ? inOut('fade', inMs, 'unfade', out, outAt, 'ease', 'ease') : '',
        '}',
        `@keyframes fade { from { opacity:0; } to { opacity:${alpha}; } }`,
        `@keyframes unfade { from { opacity:${alpha}; } to { opacity:0; } }`,
      ),
    }
  },
})

export const SHAPE_PRESETS = [
  shapePreset({
    id: 'shape-rect',
    name: 'Rectangle',
    note: 'A solid block — in the footage\'s own colour it hides anything',
    body: (st) => `background:${fillOf(st)}; border-radius:${Math.max(0, Number(st.radius) || 0)}px; ${outlineOf(st)}`,
  }),
  shapePreset({
    id: 'shape-ellipse',
    name: 'Ellipse',
    note: 'A filled oval or circle',
    defaults: { width: 240, height: 240 },
    body: (st) => `background:${fillOf(st)}; border-radius:50%; ${outlineOf(st)}`,
  }),
  shapePreset({
    id: 'shape-ring',
    name: 'Ring',
    note: 'An outline only, to circle something',
    defaults: { width: 240, height: 240, stroke: 10, color: 'none', accent: '#ff6b6b' },
    body: (st) => `background:${fillOf(st)}; border:${Math.max(1, Math.round(Number(st.stroke) || 10))}px solid ${st.accent}; border-radius:50%;`,
  }),
  shapePreset({
    id: 'shape-highlight',
    name: 'Highlight',
    note: 'A translucent marker over a line or a button, fades in and out',
    defaults: { width: 480, height: 90, radius: 8, color: '#ffd166' },
    alpha: 0.38,
    inMs: 180,
    outMs: 180,
    body: (st) => `background:${fillOf(st)}; border-radius:${Math.max(0, Number(st.radius) || 0)}px;`,
  }),
  shapePreset({
    id: 'shape-arrow',
    name: 'Arrow',
    note: 'A bold arrow that points right, left, up or down',
    defaults: { width: 260, height: 120, color: '#ff6b6b' },
    body: (st) => `background:${fillOf(st)}; clip-path:${ARROWS[st.direction] ?? ARROWS.right};`,
  }),
]
TEXT_PRESETS.push(...SHAPE_PRESETS)

export const isShapePreset = (id) => textPreset(id)?.kind === 'shape'

export const textPreset = (id) => TEXT_PRESETS.find((p) => p.id === id) ?? null

/** The clip a text item compiles to. Mirrors `captionClip` in shape. */
export function textClip(item, seq) {
  const preset = textPreset(item.sourceId) ?? TEXT_PRESETS[0]
  const style = { ...defaultTextStyle(), ...(preset.defaults ?? {}), ...(item.textStyle ?? {}) }
  const totalMs = Math.max(40, Math.round((item.inMs ?? 0) + item.durationMs))
  const text = String(item.text ?? '')
  const { html, css } = preset.build({
    text,
    subtext: preset.fields.includes('subtext') ? String(item.subtext ?? '') : '',
    style,
    seq,
    totalMs,
    outMs: preset.outMs,
  })
  const size = preset.size ? preset.size(style) : { width: seq.width, height: seq.height }
  return {
    id: item.id,
    name: item.name || preset.name,
    html,
    css,
    js: '',
    width: size.width,
    height: size.height,
    fps: seq.fps,
    durationMs: totalMs,
    background: { mode: 'transparent', color: '#000000' },
    empty: preset.kind === 'shape' ? false : !text.trim(),
    preset: preset.id,
  }
}
