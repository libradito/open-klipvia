/**
 * What a first visitor lands in.
 *
 * An empty editor is a fair thing to hand someone who chose to install one, and
 * the wrong thing to hand someone who followed a link. There is nothing to
 * scrub, nothing to select, nothing to ask an agent about — and the first
 * question is not "what shall I make" but "what is this".
 *
 * So a hosted build seeds one short piece: an animated backdrop that pushes
 * slowly in, a title, a rule that draws itself, and captions from a transcript.
 * Everything in it is made of the things Klipvia makes — HTML and CSS on a
 * virtual clock, laid out on a timeline — so it doubles as the shortest
 * possible answer to what the editor is. Nothing is downloaded: a few kilobytes
 * of markup and one SRT.
 *
 * The items are built with the same factories the editor uses rather than
 * written out longhand, so a change to what an item *is* cannot leave the demo
 * behind holding a shape nothing else understands.
 *
 * It seeds once, on a browser that holds no projects at all. Reaching zero
 * projects again means somebody deleted it, and putting it back would be
 * arguing with them — so delete it and it stays deleted. Erase everything
 * clears the flag along with the rest, because that is a factory reset.
 */

import { blankTimeline } from '/localstore.js'
import { makeAnimationItem, makeCaptionItem, makeTextItem, makeTrack } from '/sequence.js'

const uid = (p) => p + Math.random().toString(36).slice(2, 10)

const clip = (spec) => ({
  id: uid('c_'),
  js: '',
  width: 1920,
  height: 1080,
  fps: 30,
  background: { mode: 'transparent', color: '#00b140' },
  ...spec,
})

/* ------------------------------------------------------------------ clips */

/**
 * The backdrop: two soft lights drifting over a dark ruled ground.
 *
 * Pure CSS on the virtual clock, which is the point — the clock is a counter,
 * not a wall clock, so this renders frame-exact at any length and scrubs to any
 * moment without having to have played the moment before.
 */
const BACKDROP = {
  name: 'Backdrop',
  durationMs: 6000,
  html: '<div class="bg"><i class="a"></i><i class="b"></i><div class="grid"></div></div>',
  css: [
    '.bg { position:absolute; inset:0; background:#0b0e13; overflow:hidden; }',
    '.grid {',
    '  position:absolute; inset:-10%;',
    '  background-image:',
    '    linear-gradient(#ffffff0d 1px, transparent 1px),',
    '    linear-gradient(90deg, #ffffff0d 1px, transparent 1px);',
    '  background-size:96px 96px;',
    '  animation:drift 12s linear infinite;',
    '}',
    '.a, .b { position:absolute; width:60%; aspect-ratio:1; border-radius:50%; filter:blur(90px); opacity:.55; }',
    '.a { background:#5b9cff; left:-10%;  top:-25%;    animation:floatA  9s ease-in-out infinite alternate; }',
    '.b { background:#7ee0b8; right:-15%; bottom:-30%; animation:floatB 11s ease-in-out infinite alternate; }',
    '@keyframes drift  { to { transform:translate(96px, 96px); } }',
    '@keyframes floatA { to { transform:translate(18%, 12%) scale(1.15); } }',
    '@keyframes floatB { to { transform:translate(-14%, -10%) scale(1.1); } }',
  ].join('\n'),
}

/** A rule that draws itself in under the title. */
const RULE = {
  name: 'Rule',
  durationMs: 5100,
  html: '<div class="wrap"><span class="rule"></span></div>',
  css: [
    '.wrap { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }',
    '.rule {',
    '  display:block; height:6px; width:520px; border-radius:3px;',
    '  background:linear-gradient(90deg,#5b9cff,#7ee0b8);',
    '  transform-origin:left center;',
    '  animation:draw 900ms cubic-bezier(.2,.8,.2,1) both;',
    '}',
    '@keyframes draw { from { transform:scaleX(0); } to { transform:scaleX(1); } }',
  ].join('\n'),
}

const DEMO_SRT = `1
00:00:00,600 --> 00:00:02,800
Everything here runs in your browser.

2
00:00:03,000 --> 00:00:05,800
Ask an agent to change it, and watch it happen.
`

/* ------------------------------------------------------------------ build */

/** `store` is the localstore module, passed in so this file stays a description. */
export async function seedDemoProject(store) {
  const projectId = uid('p_')

  const backdrop = clip(BACKDROP)
  const rule = clip(RULE)
  const transcript = await store.putTranscript('Demo captions.srt', DEMO_SRT)

  // A slow push-in on the backdrop: two keys on one property, which is both a
  // real move and the smallest thing that puts keyframe diamonds on the
  // timeline for someone to find.
  const bg = makeAnimationItem(backdrop, { startMs: 0, durationMs: 6000 })
  bg.keys = { scale: [{ ms: 0, v: 1, ease: 'linear' }, { ms: 6000, v: 1.08, ease: 'linear' }] }

  const title = makeTextItem('title', {
    text: 'Klipvia',
    subtext: 'a video editor an agent can drive',
    startMs: 400,
    durationMs: 5600,
  })
  title.textStyle = { fontSize: 132, accent: '#7ee0b8' }
  title.offsetY = -40

  const line = makeAnimationItem(rule, { startMs: 900, durationMs: 5100 })
  line.offsetY = 190
  line.scale = 0.9

  const captions = makeCaptionItem(transcript, { startMs: 0, durationMs: 6000 })
  captions.captionStyle = { ...captions.captionStyle, fontSize: 52, transition: 'fade', marginPx: 90 }

  // First in the list is the top of the stack.
  const tracks = [
    { ...makeTrack('video', 'V4'), items: [captions] },
    { ...makeTrack('video', 'V3'), items: [line] },
    { ...makeTrack('video', 'V2'), items: [title] },
    { ...makeTrack('video', 'V1'), items: [bg] },
    makeTrack('audio', 'A1'),
  ]

  const timeline = { ...blankTimeline(projectId, 'Main'), tracks }
  const now = Date.now()
  const project = {
    id: projectId,
    name: 'Klipvia demo',
    clips: [rule, backdrop],
    timelineIds: [timeline.id],
    mainTimelineId: timeline.id,
    createdAt: now,
    updatedAt: now,
  }

  await store.putTimeline(timeline)
  await store.putProject(project)
  return project
}

/**
 * Things worth asking an agent, shown once beside a fresh demo.
 *
 * Each is answerable in one step and visibly different afterwards — somebody
 * meeting this for the first time should get a result, not a plan. Together
 * they walk the whole loop: read the timeline, change it, look at the change,
 * render it.
 */
export const DEMO_PROMPTS = [
  'What is on this timeline?',
  'Change the title to my name and turn it 6 degrees.',
  'Capture the frame at 2 seconds so you can see it.',
  'Render this timeline to MP4.',
]
