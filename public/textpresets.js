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
 * Shapes ride the same rails as titles: a preset with no words, whose clip is
 * exactly the shape's size and is placed by the item's anchor and offsets.
 * Eleven of them cover the four jobs of a tutorial overlay — hide (Rectangle,
 * Ellipse), enclose (Frame, Ring, Highlight), point (Line, Arrow, Pulse,
 * Pointer) and count or confirm (Marker, Check). No clip code, and agents get
 * them through add_shape.
 *
 * One drawing grammar. `stroke` is the one line-weight key whatever the
 * inspector calls it for a given shape (Outline, Weight, Ring); `radius` the
 * one corner key (0, 8, 12, or 999 for a pill or circle); `color` the fill and
 * `accent` the line — or the number, or the tick. Lines are white by default
 * and carry one small shadow so they read on any footage. Stroked shapes draw
 * themselves on (stroke-dashoffset over a pathLength of 1), marker shapes pop
 * on the easing the titles already use, and patches cut: a cover that faded
 * would show what it covers for a frame.
 *
 * Every stroke sits inset from the clip edge by half its width plus PAD, so
 * round caps and the shadow stay inside the box the compositor cuts to. The
 * item box is still width×height; only the drawing sits inside it.
 */

const SHAPE_DEFAULTS = { width: 320, height: 120, radius: 0, stroke: 0, color: '#1f2937', accent: '#ffffff', direction: 'right', dashed: false }
const EASE_IN = 'cubic-bezier(.16,1,.3,1)'
const EASE_OUT = 'cubic-bezier(.7,0,.84,0)'
const POP = 'cubic-bezier(.2,1.4,.4,1)'
/** The one shadow: on strokes and markers, never on a patch (a patch must match the footage exactly). */
const SHADOW = 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));'
/** Room between a stroke's outer edge and the clip edge, for the shadow. */
const PAD = 2

/** Encoders want even sizes; a 1px shape wants to exist. */
const even = (n, lo, hi) => Math.max(lo, Math.min(hi, 2 * Math.round((Number(n) || 0) / 2)))
const shapeSize = (style) => ({
  width: even(style.width ?? SHAPE_DEFAULTS.width, 4, 4096),
  height: even(style.height ?? SHAPE_DEFAULTS.height, 4, 4096),
})
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v))
/** The one stroke width, px at timeline size. */
const S = (st, d = 6) => Math.max(0, Math.round(num(st.stroke, d)))
/** A shape that is only its line has no use for a weight of 0. */
const S1 = (st, d = 6) => Math.max(1, S(st, d))
const R = (st, d = 0) => Math.max(0, Math.round(num(st.radius, d)))
/** How far a stroke's centre line sits from the clip edge. */
const inset = (s) => s / 2 + PAD
const fillOf = (style, none = 'transparent') => (!style.color || String(style.color).toLowerCase() === 'none' ? none : style.color)
const fx = (n) => String(Math.round(n * 100) / 100)

const svgOpen = (w, h) => `<svg class="s" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`
const strokeCss = (st, s) => `fill:${fillOf(st, 'none')}; stroke:${st.accent}; stroke-width:${s}px; stroke-linecap:round; stroke-linejoin:round;`

/**
 * Draw-on. pathLength="1" on the element makes one dash unit the whole path
 * whatever its size, so the same keyframes draw a 60px ring and a 600px one.
 * At dashoffset 1 a round cap still paints a dot at the path's start, so the
 * keyframe keeps the stroke invisible until it has moved: frame 0 is empty.
 * Dashed strokes cannot draw on (the dash array is taken), so they fade in;
 * dash = 2S, gap = 1.6S.
 */
const drawCss = (st, len, s, inMs, outMs, outAt) => st.dashed
  ? `stroke-dasharray:${(2 * s / len).toFixed(4)} ${(1.6 * s / len).toFixed(4)}; ${inOut('fade', inMs, 'unfade', outMs, outAt, EASE_IN, EASE_OUT)}`
  : `stroke-dasharray:1; stroke-dashoffset:1; ${inOut('draw', inMs, 'unfade', outMs, outAt, EASE_IN, EASE_OUT)}`
const KF = L(
  '@keyframes draw { 0% { stroke-dashoffset:1; opacity:0; } 2% { opacity:1; } 100% { stroke-dashoffset:0; opacity:1; } }',
  '@keyframes fade { from { opacity:0; } to { opacity:1; } }',
  '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
)
const POP_KF = L(
  '@keyframes pop { from { transform:scale(.6); opacity:0; } to { transform:scale(1); opacity:1; } }',
  '@keyframes shrink { from { transform:scale(1); opacity:1; } to { transform:scale(.8); opacity:0; } }',
)

/** Start and end of a line or arrow, inset so round caps and their shadow stay inside the clip. */
const ends = (dir, w, h, s) => {
  const ix = Math.min(inset(s), w / 2)
  const iy = Math.min(inset(s), h / 2)
  if (dir === 'left') return [[w - ix, h / 2], [ix, h / 2]]
  if (dir === 'down') return [[w / 2, iy], [w / 2, h - iy]]
  if (dir === 'up') return [[w / 2, h - iy], [w / 2, iy]]
  return [[ix, h / 2], [w - ix, h / 2]]
}

/** A patch: one div, no motion, no shadow. It cuts in and out. */
const patch = (st, radius) => {
  const s = S(st, 0)
  return {
    html: '<div class="s"></div>',
    css: `.s { position:absolute; inset:0; box-sizing:border-box; background:${fillOf(st)}; border-radius:${radius};${s ? ` box-shadow:inset 0 0 0 ${s}px ${st.accent};` : ''} }`,
  }
}

/**
 * A shape preset. `controls` names the inspector rows that apply (width,
 * height, radius, stroke, fill, accent, direction, dashed, text), `labels`
 * what a row is called for this shape, `glyph` the 28×20 tile picture in
 * currentColor and `glyphMotion` how the tile plays on hover: 'draw' for
 * strokes, 'pop' for the rest.
 */
const shapePreset = ({ id, name, note, defaults = {}, controls, labels = {}, glyph, glyphMotion = 'pop', fields = [], placeholder, inMs = 0, outMs = 0, build }) => ({
  id,
  name,
  note,
  kind: 'shape',
  fields,
  placeholder,
  controls,
  labels,
  glyph,
  glyphMotion,
  defaultDurationMs: 5000,
  inMs,
  outMs,
  defaults: { ...SHAPE_DEFAULTS, ...defaults },
  size: shapeSize,
  build,
})

export const SHAPE_PRESETS = [
  shapePreset({
    id: 'shape-rect',
    name: 'Rectangle',
    note: 'A solid patch. In the footage\'s own colour it hides a name or a detail; it cuts in and out so nothing shows through a fade',
    controls: ['width', 'height', 'radius', 'stroke', 'fill', 'accent'],
    labels: { stroke: 'Outline', fill: 'Fill', accent: 'Outline colour' },
    glyph: '<rect x="3" y="4" width="22" height="12" rx="1.5" fill="currentColor"/>',
    build: ({ style: st }) => patch(st, `${R(st)}px`),
  }),
  shapePreset({
    id: 'shape-ellipse',
    name: 'Ellipse',
    note: 'A filled oval or circle. A patch or a dot; cuts in and out',
    defaults: { width: 240, height: 240 },
    controls: ['width', 'height', 'stroke', 'fill', 'accent'],
    labels: { stroke: 'Outline', fill: 'Fill', accent: 'Outline colour' },
    glyph: '<circle cx="14" cy="10" r="8" fill="currentColor"/>',
    build: ({ style: st }) => patch(st, '50%'),
  }),
  shapePreset({
    id: 'shape-frame',
    name: 'Frame',
    note: 'An outline box that draws itself around something, clockwise from the top-left corner',
    defaults: { width: 360, height: 200, radius: 12, stroke: 6, color: 'none' },
    controls: ['width', 'height', 'radius', 'stroke', 'fill', 'accent', 'dashed'],
    labels: { stroke: 'Weight', fill: 'Fill', accent: 'Line colour' },
    glyph: '<rect class="draw" pathLength="1" x="3.75" y="3.75" width="20.5" height="12.5" rx="2.5"/>',
    glyphMotion: 'draw',
    inMs: 480,
    outMs: 200,
    build({ style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S1(st)
      const i = Math.min(inset(s), w / 2, h / 2)
      const iw = Math.max(1, w - 2 * i)
      const ih = Math.max(1, h - 2 * i)
      const r = Math.min(Math.max(0, R(st, 12) - s / 2), iw / 2, ih / 2)
      const len = Math.max(1, 2 * (iw + ih))
      return {
        html: svgOpen(w, h) + `<rect pathLength="1" x="${fx(i)}" y="${fx(i)}" width="${fx(iw)}" height="${fx(ih)}" rx="${fx(r)}"/></svg>`,
        css: L(
          `.s { position:absolute; inset:0; overflow:visible; ${SHADOW} }`,
          `rect { ${strokeCss(st, s)} ${drawCss(st, len, s, 480, out, Math.max(0, totalMs - out))} }`,
          KF,
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-ring',
    name: 'Ring',
    note: 'An outline circle that draws itself around something, clockwise from 12 o\'clock',
    defaults: { width: 240, height: 240, stroke: 6, color: 'none' },
    controls: ['width', 'height', 'stroke', 'fill', 'accent', 'dashed'],
    labels: { stroke: 'Weight', fill: 'Fill', accent: 'Line colour' },
    glyph: '<circle class="draw" pathLength="1" cx="14" cy="10" r="7.5" transform="rotate(-90 14 10)"/>',
    glyphMotion: 'draw',
    inMs: 480,
    outMs: 200,
    build({ style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S1(st)
      const cx = w / 2
      const cy = h / 2
      const rx = Math.max(1, cx - inset(s))
      const ry = Math.max(1, cy - inset(s))
      const len = Math.max(1, Math.PI * (rx + ry))
      return {
        html: svgOpen(w, h) + `<ellipse pathLength="1" cx="${fx(cx)}" cy="${fx(cy)}" rx="${fx(rx)}" ry="${fx(ry)}" transform="rotate(-90 ${fx(cx)} ${fx(cy)})"/></svg>`,
        css: L(
          `.s { position:absolute; inset:0; overflow:visible; ${SHADOW} }`,
          `ellipse { ${strokeCss(st, s)} ${drawCss(st, len, s, 480, out, Math.max(0, totalMs - out))} }`,
          KF,
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-highlight',
    name: 'Highlight',
    note: 'A translucent marker stroke over a line or a button, swiped on left to right',
    defaults: { width: 480, height: 72, radius: 6, color: '#ffd166' },
    controls: ['width', 'height', 'radius', 'fill'],
    labels: { fill: 'Fill' },
    glyph: '<rect x="2" y="6" width="24" height="8" rx="1" fill="currentColor" opacity=".45"/>',
    inMs: 360,
    outMs: 180,
    build({ style: st, totalMs, outMs: out }) {
      const outAt = Math.max(0, totalMs - out)
      return {
        html: '<div class="s"></div>',
        css: L(
          `.s { position:absolute; inset:0; background:${fillOf(st)}; border-radius:${R(st, 6)}px; opacity:.35; transform-origin:left center;`,
          inOut('swipe', 360, 'unfade', out, outAt, EASE_IN, EASE_OUT),
          '}',
          '@keyframes swipe { from { transform:scaleX(0); } to { transform:scaleX(1); } }',
          '@keyframes unfade { from { opacity:.35; } to { opacity:0; } }',
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-line',
    name: 'Line',
    note: 'A straight rule with round ends that draws from one end to the other. Connect a marker to the thing it marks',
    defaults: { width: 320, height: 24, stroke: 6, color: 'none' },
    controls: ['width', 'height', 'stroke', 'accent', 'direction', 'dashed'],
    labels: { stroke: 'Weight', accent: 'Colour', direction: 'Points' },
    glyph: '<line class="draw" pathLength="1" x1="3" y1="10" x2="25" y2="10"/>',
    glyphMotion: 'draw',
    inMs: 400,
    outMs: 200,
    build({ style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S1(st)
      const [[x0, y0], [x1, y1]] = ends(st.direction, w, h, s)
      const len = Math.max(1, Math.hypot(x1 - x0, y1 - y0))
      return {
        html: svgOpen(w, h) + `<line pathLength="1" x1="${fx(x0)}" y1="${fx(y0)}" x2="${fx(x1)}" y2="${fx(y1)}"/></svg>`,
        css: L(
          `.s { position:absolute; inset:0; overflow:visible; ${SHADOW} }`,
          `line { ${strokeCss(st, s)} ${drawCss(st, len, s, 400, out, Math.max(0, totalMs - out))} }`,
          KF,
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-arrow',
    name: 'Arrow',
    note: 'A line with an open chevron head. The shaft draws first, then the head. Says "here"',
    defaults: { width: 260, height: 80, stroke: 6, color: 'none' },
    controls: ['width', 'height', 'stroke', 'accent', 'direction', 'dashed'],
    labels: { stroke: 'Weight', accent: 'Colour', direction: 'Points' },
    glyph: '<path class="draw" pathLength="1" d="M3 10 L24 10 M18.5 4.5 L24 10 L18.5 15.5"/>',
    glyphMotion: 'draw',
    inMs: 420,
    outMs: 200,
    // One path, so the shaft and the head draw in sequence.
    build({ style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S1(st)
      const [[x0, y0], [x1, y1]] = ends(st.direction, w, h, s)
      const dx = x1 - x0
      const dy = y1 - y0
      const shaft = Math.max(1, Math.hypot(dx, dy))
      const ux = dx / shaft
      const uy = dy / shaft
      const nx = -uy
      const ny = ux
      // The wings stay inside the clip, shadow included.
      const perp = st.direction === 'up' || st.direction === 'down' ? w : h
      const head = Math.max(s, Math.min(4 * s, 0.4 * shaft, (perp - 2 * inset(s)) / 1.1))
      const ax = x1 - ux * head + nx * 0.55 * head
      const ay = y1 - uy * head + ny * 0.55 * head
      const bx = x1 - ux * head - nx * 0.55 * head
      const by = y1 - uy * head - ny * 0.55 * head
      const d = `M${fx(x0)} ${fx(y0)} L${fx(x1)} ${fx(y1)} M${fx(ax)} ${fx(ay)} L${fx(x1)} ${fx(y1)} L${fx(bx)} ${fx(by)}`
      const len = shaft + 2 * head * 1.14
      return {
        html: svgOpen(w, h) + `<path pathLength="1" d="${d}"/></svg>`,
        css: L(
          `.s { position:absolute; inset:0; overflow:visible; ${SHADOW} }`,
          `path { ${strokeCss({ ...st, color: 'none' }, s)} ${drawCss(st, len, s, 420, out, Math.max(0, totalMs - out))} }`,
          KF,
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-marker',
    name: 'Marker',
    note: 'A numbered dot for steps: 1, 2, 3. Pops in. Corners 999 is a circle; 10 makes a rounded square',
    fields: ['text'],
    placeholder: '1',
    defaults: { width: 64, height: 64, radius: 999, color: '#5b9cff' },
    controls: ['text', 'width', 'height', 'radius', 'stroke', 'fill', 'accent'],
    labels: { text: 'Number', stroke: 'Ring', fill: 'Fill', accent: 'Number colour' },
    glyph: '<circle cx="14" cy="10" r="8" fill="currentColor"/><text x="14" y="13.4" text-anchor="middle" font-family="system-ui, sans-serif" font-size="9.5" font-weight="700" fill="var(--bg-2)" stroke="none">1</text>',
    inMs: 320,
    outMs: 200,
    // The number is the item's text; add_shape passes it as `label`.
    build({ text, style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S(st, 0)
      const outAt = Math.max(0, totalMs - out)
      return {
        html: `<div class="s"><span class="n">${esc(String(text ?? '').trim() || '1')}</span></div>`,
        css: L(
          `.s { position:absolute; inset:${PAD}px; box-sizing:border-box; display:flex; align-items:center; justify-content:center;`,
          `  background:${fillOf(st)}; border-radius:${R(st, 999)}px;${s ? ` box-shadow:inset 0 0 0 ${s}px ${st.accent};` : ''} ${SHADOW}`,
          inOut('pop', 320, 'shrink', out, outAt, POP, EASE_OUT),
          '}',
          `.n { font-family:system-ui, -apple-system, "Segoe UI", sans-serif; font-weight:700; font-size:${Math.round(Math.min(w, h) * 0.5)}px; line-height:1; letter-spacing:-.02em; font-variant-numeric:tabular-nums; color:${st.accent}; -webkit-font-smoothing:antialiased; }`,
          POP_KF,
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-check',
    name: 'Check',
    note: 'A tick in a disc. The disc pops, then the tick draws. For "done" beats',
    defaults: { width: 64, height: 64, radius: 999, color: '#7ee0b8' },
    controls: ['width', 'height', 'radius', 'stroke', 'fill', 'accent'],
    labels: { stroke: 'Ring', fill: 'Fill', accent: 'Tick colour' },
    glyph: '<circle cx="14" cy="10" r="8" fill="currentColor"/><path class="draw" pathLength="1" d="M10 10.2 L12.8 13 L18.2 7.4" stroke="var(--bg-2)" stroke-width="1.8"/>',
    glyphMotion: 'draw',
    inMs: 440,
    outMs: 200,
    build({ style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S(st, 0)
      const i = Math.min(inset(s), w / 2, h / 2)
      const m = Math.min(w, h)
      const outAt = Math.max(0, totalMs - out)
      const tick = Math.max(3, Math.round(m / 10)) // one weight: a tenth of the disc
      const iw = Math.max(1, w - 2 * i)
      const ih = Math.max(1, h - 2 * i)
      const rx = Math.min(Math.max(0, Math.min(R(st, 999), m / 2) - s / 2), iw / 2, ih / 2)
      const d = `M${fx(w * 0.28)} ${fx(h * 0.52)} L${fx(w * 0.44)} ${fx(h * 0.68)} L${fx(w * 0.72)} ${fx(h * 0.36)}`
      return {
        html: svgOpen(w, h) + `<rect class="d" x="${fx(i)}" y="${fx(i)}" width="${fx(iw)}" height="${fx(ih)}" rx="${fx(rx)}"/><path class="t" pathLength="1" d="${d}"/></svg>`,
        css: L(
          `.s { position:absolute; inset:0; overflow:visible; ${SHADOW} transform-origin:50% 50%;`,
          inOut('pop', 320, 'shrink', out, outAt, POP, EASE_OUT),
          '}',
          `.d { fill:${fillOf(st, 'none')}; stroke:${st.accent}; stroke-width:${s}px; }`,
          `.t { fill:none; stroke:${st.accent}; stroke-width:${tick}px; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:1; stroke-dashoffset:1;`,
          `  animation-name:draw; animation-duration:260ms; animation-delay:180ms; animation-timing-function:${EASE_IN}; animation-fill-mode:both; }`,
          POP_KF,
          '@keyframes draw { 0% { stroke-dashoffset:1; opacity:0; } 2% { opacity:1; } 100% { stroke-dashoffset:0; opacity:1; } }',
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-pulse',
    name: 'Pulse',
    note: 'A dot with rings that ripple outward, over and over. "Click here" in a screen recording',
    defaults: { width: 120, height: 120, stroke: 4, color: '#ffffff' },
    controls: ['width', 'height', 'stroke', 'fill', 'accent'],
    labels: { stroke: 'Ring weight', fill: 'Dot', accent: 'Ring colour' },
    glyph: '<circle cx="14" cy="10" r="2.2" fill="currentColor"/><circle cx="14" cy="10" r="5.5" opacity=".7"/><circle cx="14" cy="10" r="8.5" opacity=".35"/>',
    inMs: 200,
    outMs: 200,
    // The ripple loops on the clip clock: an infinite iteration is as deterministic as the typewriter's caret.
    build({ style: st, totalMs, outMs: out }) {
      const s = Math.max(2, S(st, 4))
      const dot = Math.max(8, 3 * s)
      const outAt = Math.max(0, totalMs - out)
      return {
        html: '<div class="s"><i class="r"></i><i class="r r2"></i><i class="dot"></i></div>',
        css: L(
          `.s { position:absolute; inset:0; ${SHADOW}`,
          inOut('fade', 200, 'unfade', out, outAt, EASE_IN, EASE_OUT),
          '}',
          `.r { position:absolute; inset:${PAD}px; box-sizing:border-box; border-radius:50%; border:${s}px solid ${st.accent}; opacity:0; transform:scale(.25);`,
          '  animation-name:ripple; animation-duration:1400ms; animation-timing-function:cubic-bezier(.2,.6,.3,1); animation-iteration-count:infinite; }',
          '.r2 { animation-delay:700ms; }',
          `.dot { position:absolute; left:50%; top:50%; width:${dot}px; height:${dot}px; margin:${-dot / 2}px 0 0 ${-dot / 2}px; border-radius:50%; background:${fillOf(st)}; }`,
          '@keyframes ripple { 0% { transform:scale(.25); opacity:.9; } 70% { opacity:0; } 100% { transform:scale(1); opacity:0; } }',
          '@keyframes fade { from { opacity:0; } to { opacity:1; } }',
          '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
        ),
      }
    },
  }),
  shapePreset({
    id: 'shape-pointer',
    name: 'Pointer',
    note: 'A mouse pointer that lands and clicks once. The tip is the item\'s centre, so offsets place the tip',
    defaults: { width: 80, height: 80, stroke: 4, color: '#ffffff', accent: '#0e1013' },
    controls: ['width', 'height', 'stroke', 'fill', 'accent'],
    labels: { stroke: 'Outline', fill: 'Fill', accent: 'Outline colour' },
    glyph: '<path d="M9 2 L9 16.5 L12.6 13.3 L14.9 18.6 L17.3 17.5 L15.1 12.3 L20 11.9 Z" fill="currentColor"/>',
    inMs: 320,
    outMs: 200,
    // The glyph is 13 units wide and 18 tall from its tip. It is scaled to fill the
    // quadrant below and right of the centre, less room for its outline and shadow.
    build({ style: st, totalMs, outMs: out }) {
      const { width: w, height: h } = shapeSize(st)
      const s = S(st, 4)
      const outAt = Math.max(0, totalMs - out)
      const cx = w / 2
      const cy = h / 2
      const k = Math.max(0.05, Math.min((cx - inset(s)) / 13, (cy - inset(s)) / 18))
      const pts = [[5, 3], [5, 18.5], [9.2, 15], [11.8, 21], [14.8, 19.7], [12.2, 13.8], [18, 13.3]]
      const d = pts.map(([x, y], n) => `${n ? 'L' : 'M'}${fx(cx + (x - 5) * k)} ${fx(cy + (y - 3) * k)}`).join(' ') + ' Z'
      return {
        html: svgOpen(w, h) + `<path d="${d}"/></svg>`,
        css: L(
          `.s { position:absolute; inset:0; overflow:visible; ${SHADOW}`,
          inOut('land', 320, 'unfade', out, outAt, EASE_IN, EASE_OUT),
          '}',
          `path { fill:${fillOf(st, 'none')}; stroke:${st.accent}; stroke-width:${s}px; stroke-linejoin:round; transform-box:view-box; transform-origin:${fx(cx)}px ${fx(cy)}px;`,
          '  animation-name:click; animation-duration:180ms; animation-delay:700ms; animation-timing-function:ease-in-out; animation-fill-mode:both; }',
          '@keyframes land { from { transform:translate(12%, 12%); opacity:0; } to { transform:translate(0, 0); opacity:1; } }',
          '@keyframes click { 0% { transform:scale(1); } 50% { transform:scale(.85); } 100% { transform:scale(1); } }',
          '@keyframes unfade { from { opacity:1; } to { opacity:0; } }',
        ),
      }
    },
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
