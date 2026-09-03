<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/klipvia-wordmark.png">
  <img src="public/brand/klipvia-wordmark-on-light.png" alt="Klipvia" height="34">
</picture>

Author animations in plain HTML / CSS / JS, cut them together with video and
audio on a timeline, and export either one — a clip with a real alpha channel,
or a finished film with sound.

## WebMCP Challenge submission

Klipvia is a strong fit for WebMCP because video editing is a long, structured
workflow rather than a single prompt. The editor exposes its real editing
operations as in-page tools, allowing a person to direct the creative work
while an agent performs precise, inspectable actions on the same project and
timeline.

This makes the experience better in two ways: people can describe an outcome
instead of manually repeating dozens of edits, and they can immediately inspect,
adjust, undo, or continue every change through the normal interface. Together,
a person and an agent can import material, build animations, edit a timeline,
check layout and timing, and render the result without maintaining a separate
agent-only copy of the project.

Klipvia implements WebMCP in [`public/webmcp.js`](public/webmcp.js). It registers
tool descriptors with `document.modelContext.registerTool`, validates tool
arguments, marks read-only and untrusted-content behavior, and routes each call
through the same editor facade used by the UI. The complete registration example,
tool catalogue, security model, and implementation notes are in
[Agent control (WebMCP)](#agent-control-webmcp).

### Try the challenge build

- **Live app:** _Add the public deployment URL before submitting._
- **Supported clients:** ChatGPT's in-app browser, or Google Chrome 149 or later
  with `chrome://flags/#enable-webmcp-testing` enabled.
- **No account is required** for the browser-only build.
- On load, confirm that the header shows `webmcp · 84 tools` for the browser-only
  build (`89 tools` when running with the full server and ffmpeg).
- Ask the agent to list projects, open the seeded demo, inspect its timeline,
  make a visible edit, capture a frame, run `check_timeline`, and render it.
- **Demo video:** _Add the public YouTube URL before submitting._

### Existing project and challenge-period work

Klipvia's editor foundation existed before the challenge. The challenge entry is
the meaningful WebMCP extension: the in-page tool layer in `public/webmcp.js`, its
connection to the editor facade, tool input validation and safety annotations,
agent-visible inspection and editing workflows, and the WebMCP status and setup
experience described in this README.

Development of that extension began before this Git repository was initialized,
so the first commit imports work already completed during the submission period
instead of recording every early change as a separate commit. Later commits show
continued challenge-period work. This note documents that history limitation
rather than presenting the initial commit as proof that every imported line was
written at once.

For judges, the challenge-specific implementation begins at
[`public/webmcp.js`](public/webmcp.js); the pre-existing product foundation is the
clip, timeline, media, caption, and rendering editor that those tools operate.

```bash
bun install
bun run dev        # http://localhost:3000
```

Requires **ffmpeg** on `PATH` for Studio export (`brew install ffmpeg`).
The header shows `ffmpeg ready` when it is found.

### Or with no server at all

`public/` is a complete application on its own. Serve it as static files and
Klipvia runs entirely in the browser: projects and timelines in IndexedDB,
footage and images in the Origin Private File System, and renders encoded on
the spot with WebCodecs. No disk, no database, no ffmpeg, no login — and no way
for one visitor's work to reach another's, because there is no server holding
either of them.

```bash
cd public && python3 -m http.server 8080     # or any static host
```

It decides which it is at boot by asking `/api/health`: a server answers, and a
static host does not. Nothing above that line knows the difference — the app
still calls `fetch('/api/projects')` either way, and `public/localstore.js`
answers those from the browser when there is nobody else to. The header pill
reads `ffmpeg ready` in one mode and `in-browser` in the other.

The two are separate stores, deliberately: what is on your machine stays on
your machine, and what a hosted visitor makes stays in their browser.

**Getting work out.** A browser-only app that cannot hand your work back is a
trap, so the Projects dialog gains three things when there is no server: how
much this browser is holding, **⤓ on every project** — one zip with the
project, its footage and its images inside it — and **Import a project file**,
which reads one back under fresh ids. The zip is store-only and ordinary
`unzip` opens it. There is also **Erase everything**, because storage you
cannot empty is storage you cannot trust.

Klipvia also asks for `navigator.storage.persist()` on first run. Without it,
IndexedDB and OPFS are best-effort and a browser may reclaim them under
storage pressure; with it, the work is durable. The panel says which you have.

**What the browser cannot do.** No browser encoder writes an alpha channel into
MP4, so a transparent clip renders over its background colour and says so
rather than handing back a file that looks right until it is layered. Alpha
export stays a reason to run the server. Audio is decoded whole to be mixed, so
files over 400 MB are rendered silent with a note rather than taking the tab
down with them. The five tools that are really ffmpeg wearing a tool's clothes
— `extract_frames`, `extract_sprite`, `extract_subclip`, `reverse_media`,
`export_parts` — are not registered at all in a browser-only build, so an agent
plans around their absence instead of discovering it as an error halfway
through.

**Subtitles are parsed in one place.** `public/subtitles.js` is plain
JavaScript, imported by the browser directly and re-exported by
`src/transcripts.ts` for the server. A file that imports cleanly on your machine
imports cleanly on a hosted build, and a cue that drifts a millisecond drifts in
both or in neither.

**Two things that cost a render dearly, and are worth knowing.** A background
tab clamps `setTimeout` to a second or more, and the compositor's settle step
used a 90 ms timer as its fallback — so every frame of a render in a
backgrounded tab waited a full second doing nothing, and a thirty-second video
took a quarter of an hour. `MessageChannel` is not clamped and a hidden tab has
nothing to paint anyway. Separately, the snapshot built a **new rasterizer per
overlay per frame**, and a rasterizer carries the inlined-font cache for its
document — so every font was re-fetched and re-inlined thirty times a second.
Both were invisible while only the server rendered. Together they were about a
twenty-fold difference: a second a frame became forty-four milliseconds.

### Or with Docker

```bash
cp .env.example .env          # optional: paste an origin-trial token
docker compose up             # browser-only editor → http://localhost:8080
docker compose up studio      # that, plus the full editor → http://localhost:3000
```

Two targets in one `Dockerfile`, built from the same tree and serving the same
`public/`:

| | `--target static` | `--target server` |
|---|---|---|
| what it is | nginx and a directory of files | Bun, Hono and ffmpeg |
| holds | nothing | `./data`, mounted as a volume |
| renders with | the visitor's WebCodecs | ffmpeg, alpha and ProRes included |
| image | ~78 MB | ~290 MB |
| for | deploying | your own machine |

`static` is the one to put on the internet. It is a web server holding files:
no database, no uploads directory, no session, nothing to back up and nothing
to leak, and it runs with a read-only root filesystem because there is nothing
for it to write. `server` has **no authentication of any kind**, so compose
binds it to `127.0.0.1` — anyone who can reach that port can read and delete
every project on it.

Set `WEBMCP_ORIGIN_TRIAL_TOKEN` in `.env` and both serve it as an
`Origin-Trial` header; leave it empty and the header is simply absent.

Deploy config for the hosts that do not take a container is in `render.yaml`
(Render) and `public/_headers` / `public/_redirects` (Netlify, Cloudflare
Pages). All of them carry the same **Chrome origin-trial token** placeholder —
WebMCP is in an origin trial, and without a token for the deployed origin a
visitor has to enable `chrome://flags/#enable-webmcp-testing` by hand before an
agent can see the editor's tools. The header pill says which state it is in,
and clicking it says what to do about it.

### Landing cold

A hosted first visit seeds a short demo — an animated backdrop with a
keyframed push-in, a title, a rule and captions — built out of the things
Klipvia makes, so there is something to scrub, select and ask an agent about
within a second of the page loading. It is a few kilobytes of markup and one
SRT; nothing is downloaded. It seeds once. Delete it and it stays deleted;
**Erase everything** puts it back, because that is a factory reset.

---

## Transcription and voice

Two jobs with a name each, **Transcribe** and **Voice-over**, and one home:
the **Speech** tab in the left rail. Its Transcripts group opens with
*Transcribe a clip…* and lists every transcript (imported or written), its
Voice-overs group opens with *Write a voice-over…* and lists every recording
a voice has made, and its foot always says which provider does each job and
where the sound goes (*Transcribe: VoiceBox · on your machine*), with
**Providers…** to change that. The same two words appear on the things you
would act on: a *Transcribe* button on every media tile with sound, *Transcribe…*
and *Voice-over…* in a selected item's Sound section (the voice-over lands at
that item's start), *Voice-over from these lines…* on a caption item, and
*Transcribe…* on the right-click menus.

Each job window opens with the sentence of what will happen and where the
audio goes, *"Listens to talk.mp4 with VoiceBox (on your machine) and writes
down what is said"*, and a **Where** / **Voice from** select that lists only
the providers that are ready, with the privacy badge beside it and again
beside the button that starts the send; *Set up another…* opens Providers and
brings you back. Nothing is configured to begin with and nothing insists on
being; the computer's own voices are offered first because they already work.

Every row answers the same question first, and the lists are ordered by the
answer:

| | |
|---|---|
| **in this browser** | your computer's own voices. Free, offline, nothing sent. |
| **on your machine** | a Whisper or voice server you run, or VoiceBox. |
| **sent to a provider** | a hosted API, with your key. |

Under each row, chips say which languages it speaks. Every voice carries its
language, the pickers group voices by it, and a **Language** choice next to the
voice picks a voice that speaks it where each voice speaks one (Deepgram,
VoiceBox, Kokoro) or is sent along with the script where the voices are
multilingual (ElevenLabs, OpenAI, Cartesia). The choice is remembered per
provider and used by the Voice-over window and by agents alike.

**Your computer's own voices** need no key, no download and no network; there
are usually a couple of hundred of them, in dozens of languages. They can read
a script aloud, and they can **time** one: `Write a voice-over… → Time it`
speaks the script silently and returns the length and a timing for every word.
What they cannot do is be recorded. `speechSynthesis` has no route to a
MediaStream or an AudioBuffer in any browser, so a system voice can never put a
byte into your video, and the UI says so rather than producing a silent file.

**A server you run** is one address. whisper.cpp, [Speaches][], LocalAI,
[Kokoro-FastAPI][] (port 8880) and openedai-speech all speak OpenAI's two
routes, so one setting covers all of them, and the audio goes to that machine
and no further. Voices are read from `/v1/audio/voices` where the server has
it (Kokoro names its voices by language: `ef_dora` is Spanish, `ff_siwis`
French) and fall back to the standard six names otherwise.

**VoiceBox** gets its own row, because it is not OpenAI-shaped. It is a
voice-cloning server you run yourself: the profiles you have saved in it appear
in the voice list by name and language, and the audio never leaves the machine.
**Add a voice…** on its row lists VoiceBox's built-in Kokoro and Qwen voices
grouped by language (59 of them, in nine languages) and saves one as a profile
in a click, or clones a recording from your library, with the reference text
pre-filled from that recording's transcript when there is one. Its Whisper is
offered too, with the caveat that it returns words and a length but no per-word
times, so the lines are spread across the length by their own length: fine to
read and edit, not frame-exact.

**Hosted providers** are Groq, ElevenLabs, Deepgram, Cartesia, AssemblyAI and
OpenAI. Deepgram Aura speaks English, Spanish, German, French, Dutch, Italian
and Japanese (ninety voices, all listed with no key needed); ElevenLabs speaks
29 languages with any of your voices, 74 with its v3 model; Cartesia Sonic 44;
OpenAI 57. Scripts longer than a provider's limit are cut at sentence ends and
the pieces joined, so a long narration is one request from your side.

### When a machine on your network will not answer

A page can only call what will let it, and a browser will not say why it
could not: a server that is off, a server that refuses this page's origin, and
a Chrome permission somebody clicked *Block* on all fail identically. So
**Test it** diagnoses rather than guesses. It probes the address without
CORS (which tells running from not running), probes it with CORS (which tells
allowed from refused), asks Chrome's Permissions API about local-network
access where that applies, and shows three checks — *Reachable · Allows this
page · Local network permission* — with one precise sentence and the exact
commands that fix it, each with a copy button.

VoiceBox only answers the origins it has been told about. `http://localhost:5173`
is one of them out of the box, so serving Klipvia there (`PORT=5173 bun run
dev`, or the static build) needs no change. From any other address, including
a hosted Klipvia, VoiceBox has to be started with the page's origin in
`VOICEBOX_CORS_ORIGINS`. That is an environment variable of the app, not a
setting, and the panel shows the command for your system: on macOS quit
Voicebox and run `open -a Voicebox --env VOICEBOX_CORS_ORIGINS=https://your-klipvia`
(or `launchctl setenv …` once and relaunch from the Dock); on Windows `setx`
then relaunch; on Linux and Docker export it or put it under `environment:`.
Several origins are comma-separated. Speaches takes `ALLOW_ORIGINS`, LocalAI
`LOCALAI_CORS=true LOCALAI_CORS_ALLOW_ORIGINS=…`, Kokoro-FastAPI allows every
page as shipped, whisper.cpp too.

From an https page, Chrome asks once before letting a site reach your own
machine or network ("Apps on device" for 127.0.0.1, "Local network" for
192.168.x). Blocking it makes every call fail the same silent way; the panel
tells you where to allow it again (the site-information icon left of the
address bar). Private addresses are requested with `targetAddressSpace`, so a
LAN server on plain http works from an https page in Chrome.

**With the Klipvia server running**, hosted APIs go through `/api/speech/relay`:
the page asks its own origin, the server asks the provider, and there is no
cross-origin request for anyone to refuse. A machine provider is relayed only
when the page itself is served from a loopback address, that is when the
server and the browser are the same computer; a Klipvia server on another
machine would otherwise ask *its own* 127.0.0.1 for a VoiceBox that is on
yours. The relay reaches only loopback and private addresses or one of the
named speech APIs, and carries only the headers a speech API reads, never
cookies. "Any URL" would make it a request-forgery tool pointed at whatever
else is on the network.

Whatever answers, the result is an ordinary transcript: editable line by line,
exportable as SRT, and placeable as captions with karaoke highlighting wherever
the words carry their own timings. A voice-over is an ordinary audio file: it
lands in the library with a waveform and drops onto an audio track.

**Your keys stay here.** They live in `localStorage` under `klipvia:`, which is
reachable from none of the stores `exportProjectFile` reads, so a key cannot
travel inside a project you send someone, by construction rather than by
remembering to strip it. **Forget my keys** clears them on their own; **Erase
everything** takes them with the rest.

**The badge follows the address, not the row.** "A server you run" is a text
box, and a text box takes any host. Point it at `collect.example.com` and the
row says **sent to collect.example.com**, in amber, with a second line if the
address is `http://`. The one claim in this feature that must never be wrong
is computed from what you typed, not from which row you clicked.

**The ledger.** Once anything has actually been sent, the panel stops promising
and starts reporting: *"1 of 2 jobs went to api.groq.com."* Fifty entries,
newest first: what, how big, to which host, and no content, because a privacy
record that copies the private thing is a second copy of the private thing.

Six tools go to agents: `speech_setup`, `list_voices`, `transcribe_media`,
`add_voice_over`, `add_voice` and `time_script`. Three rules they cannot argue their way around:

- **No tool writes a credential.** A key belongs to the person at the keyboard,
  and a tool that could set one is a tool that could be talked into setting one.
- **No tool changes where audio goes**, not the provider, not the endpoint.
  Transcript text is user-imported and flows into an agent's context; without
  this, "read me this clip's transcript" is an exfiltration primitive.
- **Agent-initiated sending is off by default.** You choosing a provider is
  consent to your own sends, not to a model deciding to upload an hour of
  footage to one. With it off, agents run only what stays on the machine and
  say so. There is a checkbox, and it explains itself.

Every result that moved audio names where it went, *"It ran on your own
machine; nothing left the computer"* or *"The audio was sent to api.groq.com"*,
because the destination is not a detail of the job, it is half of what the job
was.

[Speaches]: https://github.com/speaches-ai/speaches
[Kokoro-FastAPI]: https://github.com/remsky/Kokoro-FastAPI

---

## What it does

A project holds **clips** and **timelines**.

A **clip** is one animation: its own HTML, CSS and JS plus a size, duration,
frame rate and background. Export one clip, or batch export every clip in the
project.

A **timeline** is the edit: tracks against time, carrying video, audio,
animation clips and captions. Export it as a finished film.

The two are not alternatives, and the clip is not a lesser thing that got
replaced. A clip is the *graphics engine* — titles, lower thirds, logo stings,
animated captions — and a timeline is where those meet footage and sound.
Everything that made a clip exportable with a real alpha channel is exactly what
makes it usable as an overlay layer. The editor opens in **Clip** mode; the
**Timeline** button in the header switches between the two.

### Two ways out

| | Studio export | Quick export |
|---|---|---|
| Encoder | ffmpeg (server) | MediaRecorder (browser) |
| Timing | **frame-exact** | realtime, can drop frames |
| Speed | slower than realtime for heavy clips | always realtime |
| Formats | MP4 · MOV ProRes 4444 · WebM VP9 | WebM |
| Alpha | yes (MOV, WebM) | VP8 alpha only |

**Studio** is the one to use for real work. The browser still does all the
rendering — there is no headless browser — but the clock is stepped frame by
frame and raw RGBA is streamed to ffmpeg, so a frame that takes 200 ms to
rasterize still lands on its exact timestamp.

### Formats

- **MP4 · H.264** — universal, no alpha. Set the background to **Green screen**
  (`#00b140`) to key it out later.
- **MOV · ProRes 4444** — true 12-bit alpha. Drops straight into Premiere,
  Final Cut and Resolve with no keying. Large files.
- **WebM · VP9** — true alpha, small files, plays transparently in browsers.

Transparent background + an alpha format means the exported file has genuine
per-pixel transparency; no keying, no green fringe on your text edges.

---

## How the timing works

The preview iframe gets a **virtual clock** injected before your code runs
(`public/runtime.js`). It replaces `performance.now`, `Date.now`,
`requestAnimationFrame`, `setTimeout` and `setInterval`, and drives
`document.getAnimations()` directly. That means all of these are seekable and
export identically:

- CSS `@keyframes` and transitions
- Web Animations API (`el.animate(...)`)
- `requestAnimationFrame` loops
- `setTimeout` / `setInterval` chains
- GSAP, if you load it — its global timeline is driven too

**The clock only runs forward.** Imperative JS cannot be un-executed, so
scrubbing backwards rebuilds the frame from zero and fast-forwards. Exports
always start from a fresh mount, and a mid-export desync is a hard error rather
than a silently frozen video.

## How frames are captured

The DOM is snapshotted into an SVG `<foreignObject>` and decoded as an image, so
the browser's own layout and paint engine does the work — CSS filters, blend
modes, masks, gradients and `background-clip: text` all come out right.

Two consequences worth knowing:

- **External assets are inlined.** Fonts and images are fetched and embedded as
  data URIs, cross-origin ones through `/api/asset`. Google Fonts works: link it
  in your HTML as usual.
- **Original stylesheets are dropped** from the snapshot and every element
  instead carries its *computed* style at the seeked instant. This is what stops
  the snapshot's own CSS animations from restarting at zero on every frame.

Known limits of this approach: no `<iframe>` content, and a `<canvas>` is baked
to a still image per frame (tainted canvases are skipped).

---

---

---

## The editor

```
┌ topbar ─────────────────────────────────────────────────┐
│ CLIPS   │                              │  INSPECTOR     │
│ [thumb] │           STAGE              │  size · fps    │
│ ASSETS  │                              │  duration · bg │
│ [grid]  ├──────────────────────────────┤  EXPORT        │
│         │ ▶  timeline + animation bars │                │
│         ├──────────────────────────────┤                │
│         │ HTML · CSS · JS   (⌘\ hides) │                │
└─────────┴──────────────────────────────┴────────────────┘
```

### Panels

The rail on the left and the inspector on the right can each be hidden and
brought back — the `◧` `◨` buttons at the ends of the top bar, `[` and `]` on
the keyboard, or the small tab that appears on the window edge while a panel
is away. Drag the edge between a panel and the stage to change its width;
drag it shut to hide it; double-click the edge to reset. Widths and what is
shown are remembered per browser.

The stage re-fits whenever the centre changes size — a panel, the code panel,
the window — and the timeline lanes redraw to the new width, so nothing has to
be nudged after a resize.

Below 900px wide the two panels become drawers that slide over the stage: they
start closed, the same buttons and edge tabs open one at a time, and picking
something in a drawer (a clip, a timeline, a media file) closes it. Below
720px the top bar keeps only what matters — modes, the project name and
Projects. Dialogs cap at the viewport, and on a screen that cannot hover the
per-row buttons that normally appear on hover are always shown.

### Right-click

Everything that has actions has a menu on right-click, and every entry calls
the same function a button or an agent tool would — the menu can never do
something the rest of the editor cannot.

| Where | What is offered |
|---|---|
| a timeline item | split at the playhead or right here, delete, ripple delete, group into a sub-timeline, detach audio, mute, open or flatten a section, convert a title or captions to a clip, edit the animation clip, export as parts, go to its start, note, copy id |
| a track header | rename, lock, mute, hide, a colour row, select everything on it, add a track above or below, move it up or down, note, delete when empty |
| an empty lane or the ruler | seek here, add a title / the open clip / a new sub-timeline here, add a track, save the footage or composited frame here to Assets, select all, fit in view, check layout and timing |
| a row in the Timelines rail | open, rename, duplicate (with or without its sections), make it main, place it in the open timeline at the playhead, copy id, delete |
| a clip in the Clips rail | edit, duplicate, add to the timeline, Studio export, copy id, delete |
| a media file, a transcript, an asset | insert or add at the playhead, extract frames, download .srt / .vtt, open, insert into HTML or CSS, copy the URL, remove |
| the stage | play, go to start, save a frame to Assets, extract, zoom, add to timeline, export or render |

Dangerous entries — deleting a track, a timeline, a clip, a file — ask once
inside the menu: the first click turns the entry into a question, the second
does it. Text fields and the code editor keep the browser's own menu, because
cut, copy, paste and spelling live there.

### Timeline

The runtime drives every animation through the Web Animations API, so the editor
can ask the stage what is actually running and draw it. Each row is one
animation name against one target; a staggered group appears as a row of offset
bars, so eight card reveals read as eight bars on a single `.card · reveal ×8`
track.

- **Drag** anywhere right of the labels to scrub. The playhead snaps to whole
  frames — there is no time between them in a video — and a bubble shows the
  exact second and frame number.
- **Click a bar** to jump to the moment that animation starts.
- **Hover a bar** to outline the element it drives, on the stage. The outline is
  editor chrome and is skipped by the rasterizer, so it can never reach a frame.

Animations that only come into existence partway through appear on the timeline
as the clock reaches them — the same reason the virtual clock only runs forward.

### Code panel

Syntax highlighting for HTML, CSS and JS, with line numbers and a current-line
marker. It is a transparent `<textarea>` over a highlighted `<pre>`, so the
caret, selection, undo history and IME all stay native — and there is no editor
library, because a CDN dependency would break the tool offline, which is exactly
when a local video editor needs to work.

Brackets and quotes auto-close, wrapping a selection if there is one; Enter
inside a block indents. Each tab shows how much code its pane holds. Drag the
bar above the tabs to resize the panel; the height is remembered.

### Tooltips

Anything non-obvious carries a `data-tip`: what Alpha actually costs you at
export time, why the quality slider is dead for ProRes, the difference between
Studio and Quick, and the full text of any label the layout had to truncate.
Keyboard shortcuts render as a chip inside the tooltip.

They appear after ~320ms, then instantly while you keep moving along a toolbar,
and get out of the way on any pointer-down, scroll or keypress. Native `title`
is used nowhere in the UI — it is too slow, cannot be styled, and cannot show a
shortcut. Add one with `data-tip` in markup, or `setTip(el, text, { key, at })`
for elements built in JS.

### Projects

The Projects dialog lists every project with a poster frame from its first clip,
its clip count and when it was last touched. Rows carry rename, duplicate and
delete. Delete is two-step — the button arms itself and disarms after a few
seconds — rather than a blocking browser confirm.

### Keyboard

| | Clip mode | Timeline mode |
|---|---|---|
| `Space` | play / pause | play / pause |
| `←` `→` | step one frame | step one frame |
| `⇧←` `⇧→` | step one second | step one second |
| `Home` `End` | jump to start / end | jump to start / end |
| `S` | — | split the selected item at the playhead |
| `⌫` / `⇧⌫` | — | delete / ripple delete |
| `⌘Z` / `⌘⇧Z` | — | undo / redo |
| `⌘-click` | — | add an item to the selection, or take it out |
| `⇧-click` | — | select the run of items between your last pick and this one, on that track |
| `⌘` + wheel | — | zoom the timeline about the cursor |
| drag the bar above the timeline | — | resize stage vs timeline |
| drag a track header's bottom edge | — | resize that lane (double-click resets) |
| drag a track header up or down | — | reorder the track (video stays above audio) |
| `⌥↑` `⌥↓` · `⌥⇧↑` `⌥⇧↓` | — | move the selected track one step · to the top or bottom |
| `⌥←` `⌥→` `⌥↑` `⌥↓` · `⌥⇧` | — | nudge the selected item across the frame by a pixel · by ten |
| `⌘C` `⌘X` `⌘V` `⌘D` | — | copy · cut · paste at the playhead · duplicate |
| `⌘]` `⌘[` · `⌘⇧]` `⌘⇧[` | — | one track forward / back · to the front / the back |
| `C` | — | crop the selected footage on the stage (`Esc` to stop) |
| `M` · `⇧M` `⌥M` | — | drop a marker · jump to the next / previous one |
| drag on the preview | — | move the item under the pointer; a handle resizes it |
| `⇧` / `⌥` / `⌘` while dragging the preview | — | straighten the drag (or free a corner's proportions) · resize from the middle · ignore the guides |
| `⌘E` | Studio export | render the timeline |
| `⌘\` | collapse the code panel | — |
| `[` / `]` | hide or show the rail / the inspector | hide or show the rail / the inspector |
| `Esc` | close a menu or a drawer | close a menu or a drawer |
| right-click | a menu for the thing under the pointer | a menu for the thing under the pointer |

Clip thumbnails are rendered in an offscreen frame at 60% of the clip's
duration, so generating them never disturbs the stage or your playhead. They are
cached against a hash of the clip's code and size, and regenerate when either
changes.

---

## Timelines

A timeline is tracks against time. Video tracks stack — the bottom one is the
picture, the ones above it are overlays — and audio tracks sit below them.

```
┌ V3 ────┐            [ Logo sting ]
┌ V2 ────┐  [ captions ─────────────────────── ]
┌ V1 ────┐  [ interview.mp4 ───── ][ broll.mp4 ─ ]
┌ A1 ────┐  [ music.mp3 ──────────────────────── ]
            0s        4s        8s        12s
```

Four kinds of thing go on a track:

| | |
|---|---|
| **video** | imported footage, letterboxed, cropped or stretched to the frame |
| **audio** | imported sound, with its own level and fades |
| **animation** | one of your clips, as an overlay layer with real transparency |
| **caption** | an imported transcript, compiled into an animation clip |
| **timeline** | another timeline of the project, as one block — a section |

A timeline is exactly as long as its last item. There is no separate duration to
keep in sync with the content.

### The one rule

**Items on a track never overlap.** Dropping an item over its neighbours trims
them out of its way, and removes anything it fully covers — an overwrite edit.

That is not a stylistic choice. Without it, "which of these two clips is on
screen at 4.2 seconds" has no answer that the preview and the renderer are
guaranteed to agree on, and the two would drift apart the first time you
overlapped something. Dropping an item where you did not aim never overwrites
anything: it finds a free track, or makes one.

### Editing

Selection follows the usual grammar: click picks one item, **⌘-click** adds
one to the selection (or takes it out), **⇧-click** selects the whole run
between your last pick and the clicked item on that track — a stretch of
caption blocks in two clicks — and `⌘A` selects everything. The Selection
panel then offers parts export, captions export, detach, group, delete.

Tracks are a stack: the top one draws over everything beneath it, in the
preview and in the render alike, and video tracks always sit above audio
tracks. To reorder, click the ▲ ▼ arrows on a track header, drag the header
up or down (a line shows where it lands), use the **Order** buttons in the
Track inspector, press `⌥↑` / `⌥↓` (`⇧` for all the way), or right-click the
header. The inspector also deletes an empty track. Agents: `move_track`.

- **Drag** an item to move it, including onto another track of the same kind.
- **Drag its edges** to trim. Dragging the head moves the in-point with it, so
  the frame under the cursor stays the frame under the cursor.
- Both snap to item edges, to zero and to the playhead, within 8 pixels.
- **Split** (`S`) cuts the selected item at the playhead. The tail resumes on
  the frame the head stopped on, so the cut does not jump.
- **Delete** (`⌫`) leaves a gap; **Ripple** (`⇧⌫`) closes it.
- **Lock** a track (🔒 in its header) and ripple edits leave it alone — the
  music bed under an interview you are tightening, typically.
- **Undo** (`⌘Z`) and redo (`⌘⇧Z`), a hundred steps deep. Every edit to the
  timeline — a drag, an inspector field, an agent removing forty silences in one
  call — is one step. It works by snapshot: every change funnels through one
  refresh, which compares the timeline with the last one it saw and records the
  difference, so no call site has to remember to.
- `⌘` + wheel zooms the timeline about the cursor.
- **Room to work.** Drag the bar above the timeline to trade stage for
  timeline; drag the bottom edge of a track header to make that lane taller
  (double-click resets). Lane heights are saved with the timeline but kept out
  of the undo history — they are layout, not edit.
- **Many at once.** Shift-click adds items to the selection, `⌘A` takes all;
  the inspector shows the selection with Export parts, Detach audio, Delete and
  Ripple across all of it. Dragging any member moves the whole group by the
  same amount. Every member leaves its track before any is placed back, which
  is the only order that stops the first one landing from trimming the head of
  a neighbour that is itself about to move.
- **Track names, colours and notes.** Double-click a track name to rename it;
  click a header to open the track in the inspector, where it can take a colour
  swatch and a **note**. Items take a note too. Notes are free text for whoever
  edits next, and that includes an agent: `get_timeline` prints them after a
  dash, and `set_track` / `set_item` write them. "Lower thirds only, brand
  blue, never over the presenter's face" on a track is an instruction an agent
  will read before it places anything there.
- Drag from the Media, Text or Clips rail onto a lane, or click a tile to insert
  at the playhead.

The timeline is only redrawn on release — during a drag just the dragged
element moves. That is the difference between a timeline that feels attached to
the cursor and one that does not.

### The preview

Real decoded video, real audio and the virtual clock inside each animation
iframe cannot share a clock: a `<video>` owns its own, and the virtual clock
only runs forward. So one clock drives all three — and that clock **follows the
sounding footage**. Each frame the compositor reads where the playing footage
really is and eases its own clock toward it, at most four milliseconds a
frame. A decoder that started a beat late, or stalled for a moment, is
absorbed over a few dozen frames; the picture, the titles and the captions
follow the sound rather than the sound being dragged to a stopwatch.

That matters because the alternative is a seek, and a seek is an audible cut.
An earlier version corrected every drift over 140 ms by seeking the element,
which on a heavy timeline — dozens of overlays, a big project — became a loop:
seek, decoder latency, drift, seek again, every second or two, heard as
lagging audio with tiny cuts. Now the footage that carries the sound is never
seeked while it plays (only re-synced if it and the clock have parted by
nearly a second). A second piece of media — a music bed, a detached voice — is
steered by **playback rate**, a few percent for a second or two, which is
inaudible; it is seeked only beyond 600 ms. An animation that has run a few
frames ahead of the eased clock is **held** (paused) until time arrives, not
rebuilt; one that has fallen behind is fast-forwarded.

Overlays are also only in memory while they matter: an animation's iframe is
attached and loaded 1.5 s before its start, and dropped 2.5 s after its end
or when the playhead is far away. A long lesson with sixty titles, rings and
caption blocks keeps a handful of documents live, not sixty.

While the preview plays, the compositor counts frames, hard seeks and rate
nudges; pausing prints the tally in the status line (`preview · 59 fps · 0
audio seek(s)…`), a preview that cannot keep up says so once with the remedy,
and `get_timeline_state` reports the same numbers to an agent.

The layer stack mirrors the render exactly, and overlays are placed by the same
arithmetic the filtergraph uses. What you scrub is what you get.

One thing worth knowing: layers are hidden with **opacity, never
`display:none`**. Taking an iframe out of the render tree makes Chrome cancel
the CSS animations inside it, and they come back as new animation objects that
the runtime cannot distinguish from ones genuinely born at that instant — so it
measures them from the wrong zero and they never advance again. This cost an
afternoon; it is why the code looks the way it does.

### Placing things by hand

Anchor, two offsets and a size in pixels are a poor way to decide where a title
goes, so the preview carries the same fields as a rectangle you can grab.

Click something on the stage to select it, drag it to move it, drag one of the
eight handles to resize it. Corners keep the proportions (`⇧` frees them);
edges stretch one dimension. `⌥` resizes from the middle. Edges, middles and a
5% safe margin — of the frame and of every other item on stage — pull the box
as it passes, drawing a guide where it caught; `⌘` turns that off. `⌥` with the
arrow keys nudges a pixel at a time, `⌥⇧` ten. Double-clicking opens whatever
the panel would have opened: the words of a title, the size of a shape, the
code of an animation, the inside of a nested block.

Two things keep it honest. It measures the **ink**, not the frame: a title
compiles to a clip the size of the whole frame with a line of type in the middle
of it, and a rectangle drawn round the frame would be impossible to grab and
would swallow every click meant for the footage underneath. And a drag only ever
writes a field the renderer already understands — offsets to move, and to
resize, the one thing that item type actually has:

| | resizing writes |
|---|---|
| image | `imageStyle` width and height |
| shape | `textStyle` width and height |
| title, captions | the type size — uniform, so only the corners are live |
| animation clip, footage, a nested block | `scale` |

Footage and nested blocks fill the frame by a fit rule, which has nowhere to put
a position. The first drag converts one to `fit: none` at exactly the size and
place it already had, so nothing jumps: that is how a shot becomes a
picture-in-picture. Resizing an **animation clip** does not resample it — the
clip is re-rendered at the new size, laid out at its own dimensions and painted
through a transform, so type stays type at 300%. Footage and nested blocks are
resampled by ffmpeg, like any other scale.

The handles stand down while the preview plays; measuring the ink of every
overlay sixty times a second would not pay for itself. And a drag is an ordinary
item edit — it lands on the undo stack, saves with the timeline, reads back in
the inspector, and `set_item` can do all of it from an agent.

### Turning, mirroring and cropping

The round handle above the selection turns the layer; `⇧` snaps to 15°, which is
how you get something exactly upright or exactly diagonal without typing a
number. **Flip H** and **Flip V** mirror it. Press `C` — or **Crop on the stage**
— and the same eight handles cut the source's edges instead of resizing the
layer. It is a mode rather than a guess, because the two gestures are the same
drag on the same handle and every editor that has tried to infer which one you
meant has got it wrong. The edge you are *not* dragging stays pinned, so the
picture does not slide out from under the cursor.

A crop is stored as fractions of the source, not pixels, so the framing survives
swapping a 4K master for a 1080p proxy. Cropping is for footage and nested
blocks — things that *have* a source; an image has a box and a fit, and a title
has a size.

Turning a layer makes the box it needs bigger, and that growth is transparent
margin an anchor must not count, or a corner-anchored title would slide sideways
the moment you turned it. So the margin is measured and discounted — in the
preview and in the filtergraph, by the same number.

### Lining things up

**Arrange** aligns the selected layer to the frame; select several and the same
buttons align them to *each other*, which is what you meant. Three or more can
be spread evenly with the outermost two left where they are.

Stacking order is which **track** a layer is on, so ⌘] moves it up one and ⌘⇧]
puts it on top — making a new track above if it is already there, because "bring
to front" should always do something.

⌘C, ⌘X, ⌘V and ⌘D copy, cut, paste and duplicate items. Paste lands at the
playhead, onto the track each item came from where that track still exists and
is free, and nothing is ever silently overwritten: the same one-item-per-instant
rule a drag obeys trims whatever it lands on.

### The look of a layer

Every layer that paints something carries brightness, contrast, saturation and
temperature, a blend mode, rounded corners and a drop shadow — the last of which
is what makes a picture-in-picture read as a card over the footage rather than a
hole in it.

The interesting part is how these stay honest. Each effect is one number, and it
has to be said twice: once in CSS so the preview shows it, once as an ffmpeg
filter so the file does. So the numbers live in one place (`public/effects.js`),
the CSS half is generated there, and the filtergraph half reads the same numbers
off the render plan. The order is fixed and both halves obey it:

    crop → flip → fit/scale → rotate → colour → place

There is a shortcut worth knowing. An **overlay** — a title, a shape, an image,
a caption, an animation clip — is a document a browser renders, for the preview
and again offscreen for the file. Anything CSS can do to it is therefore free
*and* incapable of disagreeing with itself, so overlays take their turn, mirror,
colour and rounding baked into the clip rather than through ffmpeg. Only footage
and nested blocks, which never touch a browser, need the filtergraph. It is also
why resizing an animation clip does not resample it: the clip is re-rendered at
the new size, so type stays type at 300%.

Three things learned the hard way, all of them silent failures:

* **`vignette` is not here.** It turns a layer's transparent margin opaque, which
  lands a black rectangle over the frame, and it has no CSS equivalent that works
  on a video element without a wrapper. One number that cannot be said in both
  languages is not a feature.
* **`rotw()` takes the angle**, not a width. Passing `iw` sized the canvas for a
  rotation of six hundred radians — very nearly a square — and put every turned
  layer in the wrong place, with no error anywhere.
* **`geq` fixes its output size when the graph is configured.** Put one after a
  per-frame `scale` and the layer silently stops resizing. Every `geq` therefore
  happens on the source's own pixels, before anything decides how big the layer
  ends up — which is also what settles a corner radius as source pixels that
  scale with the layer.

### Speed

Footage, nested blocks and animation clips play at a rate: 2 runs twice as fast,
0.5 is slow motion. Sound is re-timed with its pitch kept where it was, which is
what anyone speeding up a talking head wants. By default the item's length on
the timeline changes to match, so it keeps showing the same stretch of source.

A caption has no speed, and neither does a title: a caption's times come from its
transcript and a title's from its own length, so "faster" would mean re-timing
the words — a different job, and not one a number on the item can do honestly.

Speed lives in `sourceTimeAt`, the one function that maps timeline time to
source time, so everything downstream — the preview's clock, splitting, the
filtergraph's trim — follows from a single line. The preview steers a sped-up
element *around its own rate* rather than around 1, or the drift correction
would drag it back to normal a frame at a time.

### Dissolves

An item can fade its picture up at the start and down at the end. Two of those on
neighbouring layers **are** a cross dissolve — the outgoing one fading out under
the incoming one fading in — which is why there is no transition object anywhere
in the document. A transition is a property of the two items it is between, and
that is the only shape that survives moving, trimming or deleting either of them.

**Cross dissolve into the next item** sets it up: one track holds one item at a
time, so the next item is lifted to the track above and pulled back over this
one, and both get the matching half of the fade. What you end up with is two
ordinary items with ordinary dissolves.

### Markers, freezes and reverses

`M` pins a marker at the playhead; `⇧M` and `⌥M` walk between them. A marker
belongs to the timeline rather than to any item, because what it usually marks is
the *join* between two, and a note pinned to either would go when that one was
trimmed.

**Freeze this frame** saves the frame to Assets and drops it on the timeline as a
still. A freeze is a picture of a shot rather than a property of it, so what you
get is an ordinary image item that trims, moves, scales and turns like any other.

**Reverse** makes a new media file rather than setting a flag, because reversing
has to hold the whole stream in memory — there is no streaming way to know the
last frame first. That makes it a one-off cost you pay knowingly, with a
three-minute ceiling, instead of something the preview would have to do sixty
times a second and could not do at all.

### Keyframes

Put the playhead where you want a value, set it, and press ◆. The diamond is the
whole interaction: filled means there is a key on this exact frame, so clicking a
filled one removes it. Setting a value while a property is already keyed writes a
key at the playhead rather than a constant — otherwise you would type a number,
see nothing change, and have to press ◆ to find out where it had gone.

Four properties can move: where the layer sits (across, down), how big it is, and
how solid. Times are the item's **own**, counted from its start, so trimming its
head does not silently re-time the move inside it and copying the item copies the
move with it. Diamonds appear on the block in the timeline, and the route a layer
takes is drawn on the preview as a dashed line with a dot on every key — because
a list of numbers does not tell you that a title is about to fly off the frame,
and a line through the picture does.

Three easings, and no more: `ease` slows in and out, `linear` is a straight line,
`hold` stays put until the next key. Both halves of the editor have to compute
the identical curve — the browser between frames of the preview, an ffmpeg
expression between frames of the render — and each of these is one line of
arithmetic in both languages. A bezier editor would be a fourth shape nobody
could render.

**Rotation is deliberately not keyframable.** Turning a layer changes the size of
the box it needs, and a box that changed size every frame would make the anchor
arithmetic time-varying everywhere it is used: placement, padding, the handles,
the filtergraph. Position, size and opacity cover the moves people actually make
— a still that drifts, a logo that pops, a card that fades. Turning stays a
property you set once.

A keyframed size is *baked at its peak*: the overlay's clip is rendered at the
largest size it ever reaches and every other moment scales down from there.
Scaling a rendered picture down is free; scaling it up is not, and a logo that
pops in would be soft for exactly the frames you look at.

### Sound

Every item with audio draws its waveform: an audio item fills its lane, footage
draws a strip along the bottom edge over the filmstrip. Each pixel column shows
the loudest sample it covers, so zooming out never hides a transient — a snare
hit two seconds wide on screen is still a spike, not an average.

The canvas behind a waveform covers only the part of the item that is on
screen, repainted on scroll and zoom. A zoomed-in item can be forty thousand
pixels wide, and a canvas that size is past what Chrome will allocate: it
silently draws nothing, which is exactly how the waveform used to vanish at
high zoom. Two tiers of peaks are kept per file — 50 a second for the overview
and up to 500 a second for close work, fetched only once you zoom in far enough
to need them (about 0.8 MB for a twenty-minute file). Older libraries gain the
fine tier the first time someone zooms.

The waveform is also where **silence** is found. Select an item with sound and
the inspector's Silence panel lists the gaps; the timeline hatches them in red.
Detection runs on the peaks the server computed at import — one value per
20 ms — so the threshold can be dragged and the bands redraw live, no round
trip. It is the same test ffmpeg's `silencedetect` runs, at under a frame.

| | |
|---|---|
| **Threshold** | quieter than this is silence. −40 dB suits a normal recording; raise it towards −25 for a noisy room |
| **Min gap** | ignore anything shorter. Half a second skips the pauses between words and keeps the ones between sentences |
| **Keep** | how much of each gap survives on either side, so a cut lands a breath after the last word rather than on it |

Then either:

- **Cut at gaps** — split at every gap edge, removing nothing, so you decide
  gap by gap.
- **Remove gaps** — take them all out and close the timeline up. This ripples
  through **every unlocked track**, which is what keeps captions and overlays in
  sync with the words: they are cut in exactly the same places. Lock the music
  first. `⌘Z` undoes the lot.

An item that spans a removed range is cut in two and the tail advances its
in-point, so the footage stays continuous minus the removed part; anything
after slides back. A caption item on the same footage cuts identically, because
its in-point *is* that footage's time.

### Picture and sound apart

**Detach audio** moves an item's sound onto its own audio track — same file,
same in-point, same length — and mutes the picture. From then on either can be
trimmed, moved, replaced or silenced without the other. There is nothing new in
the model for this: sound-only is a media item on an audio track, picture-only
is a muted one on a video track. The compositor decides `<audio>` or `<video>`
by the *track* an item sits on, not by the file — an audio element plays an
mp4's sound and draws nothing, which is what the render does with it too.

**Replace sound with…** lays a different file — a new voice, say — on an audio
track aligned to the item's start and mutes the item's own sound. It tells you
if the new sound is shorter or longer than the picture, so you can trim or hold
the picture to match.

---

### Sections and sub-timelines

The main timeline is a stack of sections, and any section opens as a timeline
of its own. That is the unit of work: "make the intro" happens inside the
intro's timeline without touching the rest, and several people — or several
agents — work at once, each in a different section, the main timeline
assembling them.

```
★ Main      [ Intro ──── ][ Lesson ──────────────────── ][ Outro ── ]
              │
              ▼
  ⧉ Intro   ┌ V2 ┐  [ logo sting ]
            ┌ V1 ┐  [ title ──── ]
            ┌ A1 ┐  [ whoosh ]
```

A **block** plays another timeline with the semantics of footage: an in-point
into its content, a length, a fit into the frame. The bar along the bottom of
the purple block shows how much of it the content actually fills; what is
past the content is empty. A block can sit on an audio track too, as the
section's sound alone.

- **Group into sub-timeline** (the selection panel, or `nest_items`) moves the
  selected items into a new timeline with the parent's frame and a transparent
  background, re-based to start at zero, and leaves one block in their place —
  on the lowest video track among them, or on a new track above it if
  something else still overlaps there. Nothing is overwritten. One undo step.
- **Flatten** (the block's inspector, or `flatten_item`) is the reverse: the
  items land on parent tracks of the same kind and name where the window is
  free, else on new tracks, clipped to the block's window exactly as a render
  clips them, their volume and opacity scaled by the block's. The block's own
  fades have nowhere to go and are dropped; the sub-timeline stays in the
  project, listed as unplaced.
- **Open** a block by double-clicking it, from its inspector, or from the
  Timelines rail. The transport shows where you are — `★ Main › Intro` — each
  crumb goes back, and so does `⌘↑`. A timeline opened straight from the rail
  says where it is placed instead.
- **The Timelines rail** (the first tab) is the sketch: the main timeline, its
  sections in time order, their sections indented, then *Unplaced*. `▲▼` swap
  a section with its neighbour, `★` makes a timeline the main one, `✎`
  renames, `⧉` copies it as a new version, `+` makes a new empty section at
  the playhead and opens it, and a row drags onto a track to place it.
- **Versions.** `⧉` (or `duplicate_timeline`) copies a timeline — every track
  and item, fresh ids, named *Intro v2*, placed right after the original — and
  opens it, so an idea can be tried without touching what works. Sections
  stay shared, so a change inside one shows in both versions; ⌥-click (or
  `deep: true`) copies them too, all the way down. `★` makes the version the
  one the project delivers; Delete (twice) or `delete_timeline` prunes it.

The preview of a block is a compositor inside a compositor. The child never
runs a clock of its own: the parent's tick drives every level, so one master
clock rules however deep the nesting. An inactive block is hidden with
`visibility` — not `opacity`, which would keep its sound playing, and not
`display:none`, which cancels the CSS animations in its iframes. Its volume,
and its track's mute, scale every media element beneath it.

The render is recursive. Each block is rendered first, for exactly its
window, and the parent then treats the file as footage. Where the block sits
decides the format: on the bottom video track nothing shows through it, so it
is an opaque MP4 over the parent's colour — a ProRes intermediate of an
eight-minute section would run to tens of gigabytes; on a higher track a
ProRes 4444 `.mov`, alpha and sound in one file; on an audio track a WAV. Its
sound is mixed in only when the child actually produced some, because ffmpeg
fails outright on an input mapped for audio that has none. A child placed
twice is rendered once. Placing a timeline inside itself, however indirectly,
is refused, and nesting stops at eight levels.

### Working in parallel

Every timeline is its own document, `data/timelines/<id>.json`, with a
revision number; the project file keeps the clips, the timelines' order and
which one is main. A save carries the revision it was based on. If someone
else — another tab, another agent — has written since, the save is refused
and the current document comes back with the refusal. Nothing is lost: the
editor puts your version on that timeline's undo stack, adopts theirs, and
says *"Intro changed elsewhere — reloaded; ⌘Z keeps yours"*. `⌘Z` then
writes yours over their revision, and their poll picks it up.

Every four seconds each tab compares revisions and swaps in any timeline that
moved on and that it has not touched itself — in background tabs too, which
is where an agent's tab is. Two saves arriving in the same millisecond queue
on the server, so exactly one wins and the other is told.

**Claims** are advisory. `claim_timeline` says who is working where; the rail
shows a `⚑` and `list_timelines` says *claimed by agent-intro*. An agent that
has named itself is refused edits to a timeline another agent holds, unless it
takes it over with `force`. A claim lapses after fifteen minutes.

**Scope.** Every timeline tool takes a `timelineId` and works there without
opening it — the view stays where the person left it. Each timeline has its
own undo history, so `undo_edit` with a `timelineId` undoes that agent's own
work. The tools that need the stage (capture, seek, render, select) open the
timeline first.

The recipe for a team: `list_timelines` → each agent `claim_timeline` its
section → edit with `timelineId` → `capture_timeline_frame` to look →
release → one `render_timeline` of the main timeline.

Projects saved before this kept every timeline inline. The first load moves
them out into documents, keeping every id, with a copy of the old file at
`data/projects/.backup/<id>.pre-timelines.json`.

## Media

Video and audio live in one global library at `data/media`, beside the asset
library, for the same reason: footage outlives the project it was first cut
into. What a project stores is the *edit*, never the file.

Every file is probed on the way in — duration, dimensions, frame rate, codecs —
and the result is cached in a sidecar, along with a poster frame and a waveform.
A timeline cannot lay a clip out without knowing how long it runs, and
re-probing a 4K file on every listing would make the library unusable.

- **Add**: drag files anywhere onto the window, or use the `+` button. One drop
  can carry a logo, a piece of footage and a subtitle file; each is routed to
  the library it belongs to.
- **Formats**: mp4, m4v, mov, webm, mkv, avi · wav, mp3, m4a, aac, flac, ogg, opus.

Media is served from `/media/<file>` **with byte-range support**. Chrome will
not seek a `<video>` against a server that answers every request with the whole
file; without ranges the timeline's scrub stalls on the first drag.

```
POST   /api/media?name=<filename>   raw body → probed record
GET    /api/media                   list
GET    /api/media/:file             one record
GET    /api/media/:file/poster      poster frame
GET    /api/media/:file/peaks       waveform samples
GET    /api/media/:file/frame?t=    one decoded frame at a source time, JPEG
POST   /api/media/from-url          { url, name? } → pull a file in: http(s), or a data: URL (24 MB decoded)
DELETE /api/media/:file
GET    /media/:file                 serve, with ranges
```

`from-url` takes a `data:` URL as well as an address, because that is the only
way an agent holding the bytes can hand them over — and the bytes, not the
name, decide what the file is: they are sniffed against the format list above
before a filename is chosen, and anything else is refused.

---

## Transcripts and captions

Import an **SRT**, **WebVTT** or **Whisper JSON** file — including word-level
Whisper output, whose per-word timings are kept even though the built-in caption
style does not yet use them.

A transcript binds to a media file, not to a place on the timeline: **cue times
are source times.** Trim the head off a piece of footage, move it, cut it in
two, and the caption item recomputes which cues land where from the item's
in-point. Captions cannot drift out of sync with the picture they belong to.

Drop a transcript named like its media (`talk.mp4` / `talk.srt`) and it links
itself. Add it to a timeline whose footage is already on the timeline and it
lands exactly on that footage, with the same in-point and length.

### One cue at a time

Real subtitle files overlap. YouTube's rolling SRT starts each cue before the
last one ends and repeats its line; Whisper segments touch or cross by a frame.
Drawn naively, two boxes land on the same spot at once — which is what the first
version did. Cues are now normalised on import: sorted, a cue that runs into its
successor is cut at the successor's start, and an identical line that merely
continues the previous one is folded into it. Text is never rewritten. The
caption compiler clamps again, so transcripts imported before this still draw
one cue at a time.

Each cue carries two animations with absolute lengths — one in at its start,
one out ending at its end — rather than one keyframe stretched over the cue,
because a 120 ms fade must not scale with how long the line is on screen. The
inspector picks **cut**, **fade** or **pop**.

**Karaoke** needs word-level timings (Whisper JSON has them). Every word becomes
its own span with its own delayed animation; `word` lights the word being said,
`fill` keeps every word said so far lit, in the accent colour. All spans exist
from the first frame and the runtime pins every animation from the document's
start, so the timing is exact to the word.

### Fixing the words

The **transcript editor** (✎ on a transcript in the Speech rail, *Edit
transcript…* on right-click, or *Edit the whole transcript…* in a caption's
inspector) opens every line of a transcript in a panel on the right that
does not block the timeline — play, scrub and fix at the same time. Each line
has its start and end in source seconds and its words; Enter commits and moves
on. The line under the playhead is marked and kept in view. Per line: ▶ seeks
the timeline to it, ⑂ splits it at the caret, ⌄ joins it with the next, ×
deletes. Across the transcript: search, find-and-replace, shift every line by
a number of seconds, add a line at the playhead, rename, relink to its media,
undo. A text fix keeps word-level timings when the number of words is
unchanged — correcting a misheard word does not lose karaoke.

Opened from a caption item (*Edit captions…* in its inspector or on
right-click) the editor shows **that section only** — the lines inside the
item's window, with times as they fall on the timeline — and a switch widens
it to the whole transcript in source seconds.

**Exporting captions.** *Export captions…* — in a caption item's inspector,
in the Selection panel when caption items are selected, on right-click on an
empty lane (the whole timeline) or on a timeline in the rail — writes one SRT,
WebVTT or plain-text file from those items, **timed as the captions fall on
the timeline**, so it lines up with the rendered video; several items, even
from different transcripts, become one file. The file lands in Exports and
downloads. Agents: `export_captions { itemIds?, format, times, name }`.

A caption item's inspector lists the cues inside its window — start, end and
text — editable in place, with a line added at the playhead and the row under
the playhead marked as you scrub. Edits write to the transcript, so every
caption item reading it recompiles; a line you retype loses its word timings.

Transcript edits live outside the timeline's undo (a transcript is shared by
every item that reads it), so they carry their own: **Undo cue edit**, twenty
deep, and `undo_transcript_edit` for agents. `PATCH /api/transcripts/:id/cues`
replaces what is said in a window of source time: cues inside go, cues crossing
an edge are cut at it, a cue spanning both edges is split with its words
partitioned by time.

### Captions are a clip

A caption item is not a separate rendering path. It **is** an animation clip,
generated on the fly: one absolutely-positioned line per cue, and a
zero-to-one keyframe that holds it visible for exactly its cue window.

```css
.cue { opacity: 0; animation-name: cue-on; animation-duration: var(--d);
       animation-delay: var(--s); animation-fill-mode: none; }
@keyframes cue-on { from, to { opacity: 1 } }
```

With `fill-mode: none` the line is invisible before its delay and after its
duration, and the runtime's virtual clock seeks it like anything else. So
captions preview, scrub and export through machinery that already existed.

The inspector offers six controls — size, margin, colour, position, uppercase,
shadow. Beyond that, **Convert to animation clip** turns the generated HTML and
CSS into a real clip in the project, still in its place on the timeline, and
from then on you style it like any other clip. That is the whole answer to "can
I restyle these", and it is why the caption panel stays small.

Cues also come back out as sidecar files:

```
GET /api/transcripts/:id/export?format=srt|vtt&offsetMs=&fromMs=&toMs=
```

---

## Titles

The Text rail holds eight presets — **Title**, **Lower third**, **Subtitle
bar**, **Pop words**, **Typewriter**, **Impact**, **Label**, **Quote**. Click one
to add it at the playhead, type into it in the inspector, and it animates. No
clip code.

A text item compiles to the same shape a caption does: a full-frame transparent
clip, pure CSS, previewed, scrubbed and rendered by the machinery that already
exists. The presets live in `public/textpresets.js` as small `build()` functions
that take the text and a handful of style fields (font, size, weight, colour,
accent, alignment, case) and return HTML and CSS.

Timing follows footage. The entrance runs from the item's first frame; the exit
is baked to end on its last. Trim the head and the entrance is skipped, exactly
as trimming footage skips its first seconds; lengthen the item and the exit
moves with the end. Presets that animate word by word or letter by letter give
every span a delay from a counter; the typewriter's caret is a second animation.

When a preset is not enough, **Convert to animation clip** turns the generated
HTML and CSS into a real clip in the project, still in place on the timeline,
and from then on it is yours to edit. Agents get the same: `list_text_presets`,
`add_text`, and `set_item` with `text`, `subtext`, `preset` and `textStyle`.

### Shapes

Under the titles the Text rail holds eleven shapes, grouped by the four jobs an
overlay does in a tutorial: **hide** — Rectangle, Ellipse; **enclose** — Frame,
Ring, Highlight; **point** — Line, Arrow, Pulse, Pointer; **count or confirm**
— Marker, Check. They are titles with no words: the same preset machinery, a
clip exactly the shape's size, placed by the item's anchor and offsets, sized
and coloured in the inspector.

| | What it is for |
|---|---|
| **Rectangle**, **Ellipse** | A solid patch. In the footage's own colour — read it from a saved frame — a rectangle hides an account name or a detail in preview and render alike, with nothing to key, blur or re-encode. It cuts in and out: a cover that faded would show what it covers for a frame. |
| **Frame**, **Ring** | An outline that draws itself on around something, clockwise from the top-left corner or from 12 o'clock. |
| **Highlight** | A translucent wash swiped over a line or a button, left to right. |
| **Line**, **Arrow** | A rule with round ends that draws from one end to the other; the arrow adds an open chevron head. *Points* is the end it draws towards. |
| **Marker** | A numbered dot for steps — 1, 2, 3 — that pops in. Its number is the item's text, the *Number* row. |
| **Check** | A tick in a disc: the disc pops, then the tick draws. |
| **Pulse** | A dot with rings that ripple outward, over and over. "Click here" in a screen recording. |
| **Pointer** | A mouse pointer that lands and clicks once. Its tip is the item's centre, so anchor and offsets place the tip. |

They share one drawing grammar, so they read as one set on any footage. One
weight key (`stroke`) is the line everywhere, whatever the row is called for a
shape — Outline on a patch, Weight on a frame, Ring on a marker; one corner key
(`radius`: 0, 8, 12, or 999 for a pill or a circle); Colour is the fill and
Accent the line — or the number, or the tick. Lines are white by default and
carry one small shadow, so a light stroke stays legible over a light UI.
Stroked shapes draw themselves on; marker shapes pop on the easing the titles
use; patches cut. *Dashed* makes a frame, ring, line or arrow dashed — a dashed
stroke cannot draw on, so it fades in instead.

The inspector shows only the rows a shape uses (a ring has no Corners, a line
no Fill), each named for that shape. Every shape is an HTML or inline-SVG clip
against the clip clock, so it scrubs and renders frame-exactly like a title,
and **Convert to animation clip** hands its code over when a preset is not
enough.

Agents place them with `add_shape` (`shape`, `width`, `height`, `fill`,
`outline`, `outlineWidth`, `corners`, `points`, `dashed`, `label`, `anchor`,
`offsetX/Y`, timing) and adjust them with `set_item` (`textStyle` width,
height, radius, stroke, color, accent, direction, dashed; `text` for a marker's
number); `list_text_presets` lists them alongside the titles with the
parameters each one takes.

---

## Frames, sprites and sub-clips

The 📷 menu in the transport cuts footage into things the rest of the editor —
and an agent — can use:

| | Where it goes | What for |
|---|---|---|
| **Footage frame** | Assets, PNG at source size | a still to freeze on, draw over, put in a clip with `<img>` |
| **Composited frame** | Assets | the whole stacked frame: footage, overlays, captions |
| **Frame series** | Assets, up to 60 | contact sheets, flipbooks, before/after grids |
| **Sprite sheet** | Assets, one grid image + its CSS | **footage inside an animation clip** |
| **Sub-clip** | Media, a new frame-accurate file | collecting selects, reusing a moment across timelines |

### Footage inside a clip

A clip cannot hold a `<video>`: the rasterizer snapshots the DOM into an SVG,
and a video element renders as nothing there. But it does inline every CSS
`background-image` as a data URI, and it copies each element's computed style
at the seeked instant. So a range of footage laid out as a grid, played with a
`steps()` animation over `background-position`, is real footage in a clip —
masked, rounded, tilted, picture-in-picture, stuttered, whatever CSS can do —
and it exports frame-exactly like everything else.

```css
.sprite-x { width: 320px; height: 180px; background-image: url("/assets/x.jpg");
  background-size: 1920px 900px;
  animation-name: sprite-x-x, sprite-x-y; animation-duration: .6s, 3s;
  animation-timing-function: steps(6, jump-none), steps(5, jump-none);
  animation-iteration-count: infinite, infinite; }
```

The asset viewer animates a sprite sheet's preview and **Insert as animated
sprite** drops the div and the CSS into the open clip; `extract_sprite` returns
the CSS to an agent directly.

The caps are the point. A sheet is re-serialised into every exported frame of
any clip that uses it, so they are enforced on the server, where an agent's
request lands: 64 frames, 480 px per frame, JPEG unless transparency is asked
for. A long range plays at a lower rate rather than growing the sheet — ask for
20 seconds at 30 fps and you get 64 frames at 3.2 fps. At the 320 px default a
sheet is around a megabyte and costs an export a few tens of milliseconds a
frame. The rasterizer also no longer emits the raw `url()` alongside the inlined
copy, which used to double that.

Sub-clips are re-encoded, not stream-copied: a copy can only cut on keyframes,
and a sub-clip that starts a second early is not the moment that was asked for.

```
POST /api/media/:file/extract   { mode: frame|frames|sprite|subclip, fromMs, toMs, count?, fps?, width?, format? }
POST /api/frame?dest=assets     a PNG straight into the asset library
```

Assets now carry a sidecar in `data/assets/.meta`, the media library's pattern:
the probed size (so a listing no longer runs ffprobe over every image), a sprite
sheet's grid, and which file and second a frame came from.

---

## Exporting parts

Some pieces need to leave the editor on their own. A teacher wants the sound of
one section run through a voice generator and put back under the same picture;
an animator wants the lower third as an alpha file; someone wants seconds 40 to
65 of the finished mix.

📤 **Export parts** (also in the selection panel) lists every item with a
checkbox, pre-ticked from the selection, and makes each one a file of its own:

| Item | Becomes |
|---|---|
| footage | picture only, sound only, or both — MP4 / MOV, **WAV** / MP3 |
| sound | WAV or MP3 |
| a title, captions, an animation | an alpha render, as the timeline would use it |
| any of those with a transcript bound | plus the **words of that range as `.srt`, re-based to zero** so they line up with the exported sound |

Tick **range of the whole mix** for a window of the finished timeline, as
picture, sound or both. Everything lands in `data/exports`; **bundle as zip**
hands it over as one file.

Two things the review of this feature caught. A window of the mix is cut out
of the *plan* before the filtergraph is built, not with an output `-ss`: the
output form decodes and discards the whole prefix and reports no progress while
it does. And ffmpeg refuses a filtergraph whose output pad is not mapped, so a
sound-only render leaves the picture out of the graph entirely rather than
adding `-vn` after the fact.

The zip is written by `src/zip.ts`, ninety lines of STORE with no dependency —
everything bundled is compressed already — streaming each file from disk so a
gigabyte of footage never sits in memory. Cuts re-encode rather than
stream-copy, for the same reason sub-clips do: a copy can only cut on
keyframes.

### The round trip

`export_parts` the sound of a part as WAV → make the new voice elsewhere →
drop it into Media → **Replace sound with…** (or `replace_audio`) → fix the
words in the cue editor (or `edit_transcript`: "from 12.3 to 15.0 it now
says…") → the captions follow.

```
POST /api/export/parts     { name, zip, parts: [ media | transcript | file … ] } → { files, zip, errors }
PUT  /api/transcripts/:id  { cues }
PATCH /api/transcripts/:id/cues  { fromMs, toMs, cues }
```

---

## Rendering a timeline

Two stages, and the split is the point of the design.

**1. The browser renders every animation and caption layer** through the same
frame-exact path a clip export uses, into a file with a real alpha channel. Only
the animated seconds pay for DOM rasterization. It happens in offscreen frames,
so the preview you are looking at is not torn apart for the length of the render.

**2. ffmpeg composites and mixes.** One filtergraph: the source footage, those
alpha layers, and the audio.

```
color=…[base]
[0:v]trim,setpts,fps,scale,pad,format=rgba[l0]
[base][l0]overlay=…:enable='between(t,0,8)'[c0]
[1:v]…,tpad=start_duration=8[l1]
[c0][l1]overlay=…:enable='between(t,8,13)'[c1]
[2:a]atrim,asetpts,aformat,volume,afade,adelay[a0]
[a0][a1]amix=…,apad=whole_dur=13[aout]
```

Source video therefore **never passes through a canvas**: no 8-bit round trip,
no rescale in JavaScript, no per-frame decode stall. A 13-second 1080p timeline
with four video layers and two audio sources composites in about a second.

Every visual layer is placed the same way — an `overlay` onto a base canvas, in
z-order. Gaps, overlaps, mismatched resolutions and transparent graphics all
fall out of one code path instead of four.

Two details that are easy to get wrong, both of which cost a debugging session:

- Layers are shifted with **`tpad`**, not a bare `setpts`. An overlay input
  whose first frame arrives ten seconds in stalls ffmpeg's frame synchroniser,
  so every layer is padded with transparent frames back to `t=0` and then gated
  with `enable`.
- The audio mix is padded with **`apad=whole_dur=…`**, never a bare `apad`.
  Unbounded `apad` generates silence for ever, and a following `atrim` discards
  those frames without ever asking it to stop — ffmpeg then spins with
  `out_time` frozen, writing an output file that grows without end.

### Output formats

| | Video | Audio | Alpha |
|---|---|---|---|
| **MP4** | H.264 | AAC 192k | no |
| **MOV** | ProRes 4444 | PCM | yes |
| **WebM** | VP9 | Opus | yes |

### Alpha is verified, not assumed

Animation layers are rendered to an intermediate that **must** carry an alpha
channel. One that loses it becomes an opaque rectangle covering every layer
beneath it, and nothing in the render log says so.

Asking the encoder what it supports is not enough. Some builds of libvpx accept
`-pix_fmt yuva420p` for VP9, report no error, and write a plain `yuv420p` file —
the build on this machine is one of them. So on startup each alpha-capable
format is encoded once and **read back**, and only the ones that actually
produced an alpha plane are offered. Formats that fail the check are struck from
the overlay list and marked *alpha unavailable* in the clip exporter.

The intermediate defaults to **QuickTime Animation** (`qtrle`, lossless RGBA):
exact edges, and a fraction of the size of ProRes for graphics sitting on an
empty frame — 1.9 MB against 12 MB for a typical lower third.

```
POST /api/render/timeline          -> { jobId }
GET  /api/render/timeline/:id      -> { state, progress, outTimeMs, error }
GET  /api/render/timeline/:id/download
POST /api/render/timeline/:id/abort
POST /api/render/timeline/dry-run  -> the filtergraph, without running it
```

Progress comes from ffmpeg's own `-progress` stream, so the bar reflects the
encoder rather than a guess.


---

## Assets

Images and fonts live in one global library at `data/assets`, shared by every
project.

- **Add**: drag files anywhere onto the window, press `⌘V` to paste an image
  from the clipboard, or use the `+` button.
- **Inspect**: click a tile to open the viewer — the asset large, on a
  checkerboard, on black or on white, at Fit or 100%. Worth doing before you
  commit to a mark: a mid-grey logo that reads beautifully on white can vanish
  on dark footage, and this is where you find that out. Fonts render a live
  specimen at four sizes instead of a filename.
- **Use**: from the viewer, *Insert into HTML* / *Insert into CSS* / *Copy URL*.
  If you already know the asset, the `+` on the tile inserts it straight at the
  caret without opening anything.
- **Formats**: png, jpg, webp, gif, avif, svg, woff2, woff, ttf, otf. 32MB each.

SVGs are measured from their `viewBox`, so the viewer's 100% shows true size
even though the file has no intrinsic pixel dimensions.

Assets are served from `/assets/<file>`, which is deliberately **same-origin**
with the editor. That matters more than it looks: the rasterizer inlines every
external reference before snapshotting, and it routes cross-origin ones through
`/api/asset` — a proxy that refuses localhost as an SSRF guard. A local asset
sent through that proxy would render perfectly in the preview and then silently
vanish from every exported frame, so same-origin URLs are fetched directly
instead.

```
POST   /api/assets?name=<filename>   raw body → { filename, url, width, height }
GET    /api/assets                   list
DELETE /api/assets/:filename
POST   /api/assets/from-url          { url, name? } → pull a file in: http(s), or a data: URL (8 MB decoded)
GET    /assets/:filename             serve
```

An SVG an agent wrote goes in as its text: `add_asset_text` posts it to
`POST /api/assets?name=logo.svg`, 2 MB at most, and gets the same record back.
As with media, a `data:` URL is sniffed before it is named — a PNG called
`.jpg` is stored as a PNG, and text called `.png` is refused.

### Images on the timeline

An image asset is also a timeline source. In Timeline mode, click an image in
the Assets rail to add it at the playhead, or drag it onto a track; it becomes
an `image` item on an overlay track, five seconds long, held for as long as
you stretch it (a still has no length of its own). The block shows the
picture; the inspector offers Fit (contain, cover, fill, none), a box size
(blank means natural size, shrunk to fit the frame), corner rounding, a drop
shadow so a screenshot reads as a card over the footage, and the usual anchor,
offsets and opacity. Right-click an asset for the same.

Under the hood an image item compiles to a one-line clip — an `<img>` filling
a box the size of the picture — through the same path titles and shapes take,
so it previews, scrubs, checks (`check_layout` sees its painted bounds) and
renders like any overlay, and **Convert to animation clip** hands you the clip
to animate. Agents: `list_assets`, then `add_to_timeline { kind: "image",
sourceId }`, then `set_item` with `fit` and `imageStyle { width, height,
radius, shadow }`.

---

## Agent control (WebMCP)

The editor publishes itself as **WebMCP** tools, so an AI agent running in Chrome
can create clips, write animation code, look at a frame, and render a video.

### How tools are registered

Every tool is registered on the page's own `document.modelContext`, in
[`public/webmcp.js`](public/webmcp.js):

```js
document.modelContext.registerTool({
  name: 'add_to_timeline',
  description: 'Place media, an animation clip, a transcript or another timeline on a track.',
  inputSchema: { type: 'object', properties: { /* … */ }, required: ['kind', 'sourceId'] },
  execute: async (input) => { /* … drives the same editor facade the UI does … */ },
})
```

The file builds one descriptor per tool with exactly those fields, plus
`annotations.readOnlyHint` on the ones that only read, and registers them in a
loop against an `AbortSignal`, so re-registering replaces the set rather than
stacking on it. `navigator.modelContext` is accepted as the deprecated alias.

Every tool calls the same `editor` facade the buttons call, so an agent's edit
lands in the same undo history as a hand's and shows up in the preview at once.

### Enable it

WebMCP is behind an origin trial. For local development:

1. Open `chrome://flags/#enable-webmcp-testing`, set it to **Enabled**
2. Relaunch Chrome
3. Load the editor — the header pill should read **webmcp · 89 tools**

The count is the honest one for the build you are on: **89 with the server, 84
without**, because the five tools that are really ffmpeg are not registered
where there is no ffmpeg to run them.

The pill reads `webmcp off` when the flag is not on; everything else still works.
To serve the editor from a real origin instead, register that origin at the
Chrome origin trials console and set `WEBMCP_ORIGIN_TRIAL_TOKEN` — as an
environment variable for `bun run dev` or the Docker builds, or as the
`Origin-Trial` header in `render.yaml` / `public/_headers`. Then a visitor
needs no flag at all. Origin trials do not cover `localhost`, so the flag stays
the only local route.

### Tools

| Tool | Read-only | What it does |
|---|:--:|---|
| `list_projects` | ✓ | Every project; the open one is starred |
| `list_clips` | ✓ | Every clip with id, size, duration, fps, background |
| `get_clip` | ✓ | Settings, and `fields:["css"]` for source |
| `get_clip_animations` | ✓ | Every animation's start and end, without moving the preview |
| `check_clip` | ✓ | Preflight: broken images, overruns, off-frame elements, JS errors |
| `get_stage_state` | ✓ | Preview time, mount state, clip JS errors |
| `list_exports` | ✓ | Recently rendered files |
| `list_assets` | ✓ | Images and fonts in the library, with URLs |
| `open_project` | | Switch the editor to another project |
| `create_project` | | Create, open and select a starter clip |
| `add_asset_from_url` | | An image or font into the library — from a public URL, or a `data:` URL the agent holds (8 MB) |
| `add_asset_text` | | An SVG the agent wrote, as text, into the library (2 MB) |
| `create_clip` | | Add and select a clip |
| `duplicate_clip` | | Copy a clip and select the copy |
| `set_clip_code` | | Replace html / css / js wholesale |
| `patch_clip_code` | | Find-and-replace one snippet, no full resend |
| `set_clip_settings` | | Name, size, duration, fps, background |
| `apply_snippet` | | Overwrite with a built-in starter |
| `delete_clip` | | |
| `select_clip` | | Make a clip active |
| `seek_preview` | | Move the virtual clock |
| `capture_frame` | | One frame, or `count:6` for a timestamped contact sheet |
| `render_clip` | | Full render → `mov` / `webm` / `mp4` |

### Timeline tools

The second set edits the timeline. They drive the same functions the mouse
does, so an agent's edits land in the same undo history as yours.

| Tool | Read-only | What it does |
|---|:--:|---|
| `get_timeline` | ✓ | Tracks and every item with id, times and in-point; filter by track or window |
| `list_timelines` · `get_timeline_state` | ✓ | The project as a tree — main, its sections in order, the unplaced — with claims and notes; playhead, selection, undo depth |
| `list_media` · `list_transcripts` | ✓ | The libraries, with the ids to use as `sourceId` |
| `get_transcript` | ✓ | Cues, words with their own timings, or plain text — paged, in **source** seconds |
| `find_in_transcript` | ✓ | Where a phrase is spoken, exact to the word when timings allow — and where that moment falls on the timeline |
| `get_narration` | ✓ | What is said when, in **timeline** seconds — the map to plan overlays from; filter by window or phrase |
| `check_layout` | ✓ | Where every overlay actually paints on screen, and which pairs collide in time and space |
| `detect_silence` | ✓ | The gaps in an item (timeline time) or a file (source time) |
| `check_timeline` | ✓ | Preflight: missing sources, overruns, opaque overlays, letterboxing, empty captions |
| `capture_timeline_frame` | | One composited frame, or a labelled contact sheet of a window (`count`), as a PNG URL |
| `create_timeline` · `open_timeline` · `set_timeline_settings` | | Settings include a **note** for whoever works there next, and `main: true` |
| `nest_items` · `flatten_item` | | Group items into a sub-timeline and leave a block; put a block's items back |
| `duplicate_timeline` · `delete_timeline` | | A new version of a timeline (sections shared, or copied with `deep`); remove a version |
| `claim_timeline` | | Say who is working on a timeline; `release`, or `force` to take it over |
| `add_media_from_url` | | Footage or audio into the library — from a public URL, or a `data:` URL the agent holds (24 MB) |
| `add_to_timeline` | | Place media, a clip (as an alpha overlay), a transcript (as captions) or another timeline (as a section) |
| `set_item` · `move_item` · `split_item` · `delete_item` | | The item edits — everything a stage drag writes (`anchor`, `offsetX/Y`, `scale`), the transform (`rotation`, `flipH`, `flipV`, `crop`), the look (`colour`, `blend`, `radius`, `shadow`), `speed`, and the picture fades |
| `set_keyframe` · `list_keyframes` · `clear_keyframes` | | Make a value different at two moments: position, size, opacity |
| `cross_dissolve` | | Turn the cut after an item into a dissolve, overlap and all |
| `freeze_frame` | | Hold one frame as a still on the timeline |
| `reverse_media` | | Play a file backwards, as a new file in the library |
| `add_marker` · `list_markers` · `delete_marker` | | Pin the moments that matter |
| `cut_time_range` | | Remove a stretch of timeline time from every unlocked track |
| `cut_source_ranges` | | Remove parts of an item by **source** time — the transcript's times |
| `remove_silence` | | Detect and cut the gaps, rippling everything into sync |
| `add_track` · `set_track` | | Tracks: name, colour, **note**; `locked` protects one from ripple edits |
| `list_text_presets` · `add_text` | | Animated titles from presets, typed in |
| `add_shape` | | One of eleven shapes — rectangle, ellipse, frame, ring, highlight, line, arrow, marker, check, pulse, pointer — sized, coloured and placed; a cover for a name in the footage |
| `move_track` | | Reorder a track: up, down, top, bottom, or a position — stacking order for overlays |
| `export_captions` | | One SRT / VTT / TXT from caption items, timed as on the timeline |
| `select_items` | | Select on the timeline, as shift-click would |
| `detach_audio` · `replace_audio` | | Picture and sound apart; a new sound under an item |
| `export_parts` | | Items and/or a window of the mix as separate files — WAV for a voice tool, alpha renders, `.srt` re-based to zero, zip |
| `edit_transcript` · `set_cue` · `undo_transcript_edit` | | Replace what is said in a window; fix one cue; revert |
| `save_frame` | | The footage frame under the playhead, or the composite, into Assets — with a `name` you can find again |
| `extract_frames` · `extract_sprite` · `extract_subclip` | | Frame series and sprite sheets into Assets; frame-accurate cuts into Media |
| `seek_timeline` · `render_timeline` | | |
| `speech_setup` · `list_voices` | ✓ | What speech is set up and where audio would go; the voices it can use, grouped by language, with the language chosen |
| `transcribe_media` · `add_voice_over` · `time_script` | · · ✓ | Words from a file; a script read into an audio file (with a `language`) and placed; how long a script runs, free |
| `add_voice` | | A new voice: one of VoiceBox's built-in presets saved as a profile, or a clone of a library recording (VoiceBox, or ElevenLabs when agent sending is on) |
| `undo_edit` · `redo_edit` | | The same history as `⌘Z`, one per timeline |

Every timeline tool takes an optional `timelineId` (from `list_timelines`) and
works in that timeline without opening it; without one, the open timeline.
Tracks can be named where an id is asked for (`trackId: "Animaciones"`), and
a track the editor makes for an overlay follows the naming of the one on top
("Animaciones 2", not "V4"). An argument a tool does not know is refused with
the nearest real name — `durationMs (did you mean durationSeconds?)` — rather
than ignored.

### Bringing files in

A tool call is JSON on both sides. A `Blob` in an argument arrives as `{}`, and
`execute()` runs without user activation, so a tool cannot open a file picker
either: the person can drop an hour of footage on the editor, an agent cannot.
So there are two ways for an agent to bring a file in, in the order to try
them:

1. **A public URL.** `add_media_from_url` / `add_asset_from_url` fetch it. With
   the server, the server fetches; in the browser-only build the page fetches,
   so the host must allow cross-origin reads — and the error says so.
2. **A `data:` URL**, when the agent holds the bytes itself — a logo it drew, a
   voice-over a tool handed back. The same two tools take one, base64 or
   percent-encoded, decoded and sniffed on arrival: 8 MB for an asset, 24 MB
   for media, said in the tool description and in the refusal. An SVG needs
   no encoding at all: `add_asset_text` takes it as text. The caps are low on
   purpose — the whole file rides inside one JSON argument and is held whole.

The from-url routes fetch on the agent's say-so, which is the definition of a
request-forgery risk, so the server checks every address before fetching it
and again at each redirect. Loopback and the LAN are *allowed* there — this
server runs on one person's machine, and their NAS is the most ordinary place
footage lives — but link-local and the cloud metadata addresses never are,
and neither is any scheme but http(s). The rasterizer's `/api/asset` proxy
keeps its stricter rule and refuses the local network entirely: it exists to
reach fonts on the internet, and a page that can read the LAN through it has
been handed a scanner.

### What building with the tools taught them

The second afternoon of using the tools *as* the agent — placing forty
overlays on a nine-lesson course — is where four of them come from:

- **`get_narration`.** Placing a keycap "where he presses Ctrl" needs the
  narration in the timeline's own seconds. `find_in_transcript` spoke source
  seconds, and converting through each footage item's in-point was a script
  the agent had to write on the side. Now the map is a tool, and
  `find_in_transcript` says where each hit lands on the timeline.
- **`check_layout`.** Every collision — a card over Excel's real save
  dialog, a caption pill grazing the subtitles — was found by capturing frames
  and looking. The editor knows every overlay's placement; what it did not
  know was where the *content* of a full-frame transparent clip sits. Each
  overlay is drawn offscreen and the box of what it paints measured, so the
  check names the pair, the seconds, and how much of the smaller box is
  covered.
- **The unknown-argument guard.** A `durationMs` passed to a tool that wanted
  `durationSeconds` was silently dropped; every title came out at the default
  length and nobody said why.
- **Contact sheets of the timeline, paging in `list_clips`, tracks by name,
  named saved frames.** Each one a small friction, met twenty times.
- **Clip edits no longer touch the open timeline.** Sixty `patch_clip_code`
  calls with lesson 08 open had re-saved lesson 08 sixty times — its revision
  read 62 while its neighbours read 5 — because one dirty flag covered both
  the project and whatever timeline was on screen. Now a clip edit saves the
  project; a timeline edit saves that timeline. A second agent on lesson 08
  would have met sixty stale revisions for nothing.

Two of these are the point. `cut_source_ranges` takes the times
`find_in_transcript` and `get_transcript` hand back, so "drop every *um*" or
"cut the part where she repeats herself" is: find the words, pass their ranges.
The footage is cut, the captions on it are cut identically, everything after
slides up. And `capture_timeline_frame` composites the real frame — ffmpeg
decodes the footage, the overlays render through the export rasterizer — so an
agent can *look* at what it did before rendering.

A typical loop for a talking-head edit: `add_to_timeline` the footage and its
transcript → `remove_silence` → `find_in_transcript` the filler words →
`cut_source_ranges` → `create_clip` + `set_clip_code` a lower third →
`find_in_transcript("my name is")` → `add_to_timeline` the clip at that second →
`capture_timeline_frame` to check it → `check_timeline` → `render_timeline`.

Captures and renders work with the tab in the background, which is where an
agent's tab always is. Chrome loads no media there and never fires
`requestAnimationFrame`, so the capture asks ffmpeg for each frame of footage
and every wait has a timer behind it — two afternoons, both now in the code.

Three of the clip tools exist because building with the earlier set was awkward:

- **`get_clip_animations`** reads the animation schedule straight out of the running
  document, so pacing can be checked in one call instead of rendering a video
  and measuring it. A stagger comes back as one row listing every start.
- **`check_clip`** catches the faults that otherwise only surface after a
  render: an image that 404s, an animation still moving when the clip cuts, an
  element parked off-frame, a script that threw.
- **`patch_clip_code`** edits one snippet instead of resending a whole
  stylesheet. It refuses ambiguous matches rather than guessing.

Inspection tools mount the clip in a throwaway offscreen frame, so nothing they
do moves your playhead or disturbs the stage.

A typical loop: `create_clip` → `set_clip_code` → `check_clip` (anything
broken?) → `capture_frame` with `count:6` (does it look right?) → `get_clip_animations`
(is the pacing right?) → `patch_clip_code` to adjust → `render_clip`.

Tool output is capped at 1500 characters, so `get_clip` takes a `fields`
argument and `capture_frame` returns a URL rather than an inline image.

### Calling the tools by hand

Chrome's `executeTool` takes the arguments as a **JSON string**, not an object —
passing an object fails with `Failed to parse input arguments`:

```js
const tools = await document.modelContext.getTools()
const byName = Object.fromEntries(tools.map(t => [t.name, t]))

await document.modelContext.executeTool(byName.list_clips, JSON.stringify({}))
await document.modelContext.executeTool(
  byName.create_clip,
  JSON.stringify({ name: 'Title card', width: 1080, height: 1080, durationSeconds: 2 }),
)
```

Native Chrome returns a plain string; the W3C polyfills return
`{ content: [{ type: 'text', text }] }`. The editor detects which runtime it is
on and emits the matching shape. Force one with `?mcpResult=string|content`.

### Security

Agents can write raw HTML, CSS and JS into a clip — that is the point of the
tool, but it has a consequence worth stating plainly:

> **Clip JS runs same-origin with the editor. Treat agent-authored clips as you
> would code you pasted in yourself.**

The preview iframe *must* stay same-origin because the rasterizer reads its
`contentDocument` to snapshot the DOM; an opaque origin would break every export.
So clip code is not sandboxed from the app.

What is done about it, following Chrome's tool security guide: every write tool
is marked `readOnlyHint: false` so agents confirm before acting; tools returning
clip code or clip error text are marked `untrustedContentHint: true`; no tool
exposes a path outside `data/exports`; and
`exposedTo` is left unset, so tools are same-origin only and are not shared
with other sites.

### Not included

WebMCP is an **in-page browser API**. Chrome-resident agents see these tools;
**Codex CLI, Claude Code and other terminal agents cannot** — they need a real
MCP server. Adding one means a `/mcp` Streamable HTTP endpoint reusing the same
tool definitions, plus either a bridge to an open editor tab or a headless
render, since rasterization needs a browser.

---

## Layout

```
src/
  index.ts       Bun + Hono server
  api.ts         projects, media, transcripts, asset proxy, render endpoints
  ffmpeg.ts      clip format presets, the encode job, the alpha capability probe
  sequence.ts    the timeline filtergraph builder, cutPlan, and its ffmpeg job
  parts.ts       a media range or a transcript excerpt as a file of its own
  zip.ts         a dependency-free STORE zip writer
  paths.ts       where exports live
  media.ts       media library: probe, poster, waveform, ranged serving
  transcripts.ts SRT / VTT / Whisper parsing, and writing them back out
  store.ts       flat-file store: projects (clips, timeline order) and timeline documents with revisions
public/
  index.html     editor shell, both modes
  app.js         editor: modes, clips, panes, transport, inspectors, export UI
  runtime.js     virtual clock, injected into every preview iframe
  rasterize.js   DOM -> SVG foreignObject -> canvas
  stagehost.js   mounting a clip: the visible stage, offscreen probes, render hosts
  export.js      the two clip export paths
  sequence.js    the timeline model: items, tracks, edits, captions-as-a-clip
  textpresets.js the title presets, each a build() from text + style to HTML/CSS
  timeline.js    the timeline UI
  composite.js   the preview compositor and its master clock
  medialib.js    media and transcript rail
  seqrender.js   render orchestration: overlays first, then ffmpeg
  snippets.js    starter animations
data/
  projects/      one JSON per project: clips, the timelines' order, which one is main
  projects/.backup/  a project as it was before its timelines moved out
  timelines/     one JSON per timeline, with its revision and claim
  media/         imported video and audio, with probe sidecars in .meta
  assets/.meta/  probed sizes, sprite grids, frame origins
  transcripts/   one JSON per imported transcript
  exports/       rendered files
```

### Why frames travel over a socket

Every frame of an overlay render used to be one `POST` of raw RGBA — 8 MB at
1080p, thirty times a second. It worked, and it was killing tabs: with a
long caption layer the renderer process climbed at ~250 MB/s, past 12 GB on
a 60-second layer, and Chrome killed the tab on any machine with less
memory than that. Measured from outside the browser, phase by phase: the
uploads alone stay flat, rasterizing alone stays flat, and the two together
grow by one frame's worth of memory per frame — Blink keeps hold of each
request's body from its side of the fence until its own collector runs,
which during a tight export loop is effectively never. A shared upload
buffer halved it; `XMLHttpRequest` leaked the same. What does not leak is a
message on a WebSocket: the copy is handed to the network process as it is
sent. So a render now opens one socket per job (`/api/export/:id/stream`),
sends each frame as a binary message and waits for the server's ack before
the next — the same one-frame-in-flight order as before — and the process
stays where it started (368 MB → 439 MB over the same 1,800 frames). The
per-frame `POST` remains as the fallback when a socket cannot open.

### The mute render

Every lesson render for an afternoon came out with an audio stream that
was silent from end to end, and ffmpeg had exited 0 every time. The graph
was right — run by hand into PCM it had sound — but into AAC in an MP4 it
did not: after `atrim` → `adelay` → `amix` one audio frame comes out with an
impossible timestamp, and from that packet on the encoder drops everything.
The file kept its stream (236 packets, the leading silence, then nothing),
so nothing downstream noticed. Short test plans passed because the fault
only shows with a long delay. The audio chain now ends in
`asetpts=N/SR/TB`, counting samples from zero for the encoder whatever the
filters upstream produced; the same plan yields all 4,797 packets.

### A file with no duration

A video that plays but shows no total time and cannot be skipped through is
a file without its index. Two ways to get one: a render that did not finish
— the MP4's index is written last, so a job that died mid-way leaves a torso
— and a Quick export, because MediaRecorder never writes a duration or a
seek table at all. Both are handled: an aborted or orphaned job (a socket
that closes before `/finish`) deletes its half-written file rather than
leaving it in the exports list, and a Quick export is stream-copied through
ffmpeg on its way back (`POST /api/export/quick`), which rebuilds the index
without re-encoding a frame. Every finished render already carries
`+faststart`, so its index is at the front and it seeks while it streams.

### Export protocol

```
POST /api/export             -> { jobId }        spawns ffmpeg, stdin open
POST /api/export/:id/frame   -> { frames }       one raw RGBA frame, awaited
POST /api/export/:id/finish  -> { downloadUrl }  closes stdin, waits for encode
GET  /api/export/:id/download
POST /api/export/:id/abort
```

Frames are raw RGBA rather than PNG: no encode cost on either side, and awaiting
each POST gives natural backpressure so ffmpeg is never outrun. Each frame's
length is validated against `width * height * 4`.

---

## Notes

- The stage applies `* { box-sizing: border-box }`. Everything else is yours.
- `console` errors from your clip's JS appear under the code panes.
- Projects autosave; the last one reopens on load.
- Rendering keeps working while the tab is in the background.
- `window.__editor` and `window.__registerAgentTools()` are exposed for debugging
  and for re-registering tools against a stubbed `document.modelContext`.
- Timeline playback is driven by `requestAnimationFrame`, which Chrome suspends
  in a background tab. Scrubbing, captures and rendering work regardless; live
  playback needs the tab visible.
- Undo history lives for the page session; reloading starts it fresh.
