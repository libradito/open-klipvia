# Klipvia — WebMCP Challenge demo

Target length: 2:35–2:45  
Hard limit: 3:00  
Format: 1920×1080, 30 fps, H.264 + AAC  
Voice: Deepgram, confident and conversational, medium pace

## Creative direction

Use the existing Klipvia screenshot as the visual anchor. Begin with a clean,
dark branded title, push into the screenshot, then alternate between the real
editor and short typographic cards. Keep the palette close to Klipvia's UI:
charcoal, warm white, and one bright accent. Use restrained motion—smooth
push-ins, masks, cursor highlights, and short kinetic-type transitions—so the
product remains the hero.

Record the real WebMCP interaction live. The strongest proof is the visible
sequence: natural-language request → WebMCP tool call → timeline changes in the
same interface → visual inspection → render.

## Narration master

Most video editors were designed for a person clicking through hundreds of
small controls. AI can suggest an edit, but it usually cannot reach the real
timeline where the work happens.

This is Klipvia: a browser-based animation and video editor that an AI agent can
drive through WebMCP.

Klipvia exposes the editor's real operations as structured, in-page tools. The
agent does not operate a separate automation layer or a hidden copy of the
project. It uses the same editor functions as the interface, so every change
appears on the timeline immediately and remains visible, editable, and
undoable by the person.

Let’s build this demo together. I can ask the agent to inspect the current
project, find the screenshot, and create a polished animated sequence around
it. The agent can add clips, place media, write animation code, edit timing,
create captions, and generate this voice-over with the provider I already
selected.

Now I’ll ask it to make the screenshot the focus, add a controlled camera
push, and place a title above it. The timeline updates as the tools run. I can
scrub the result, move an item by hand, or ask the agent for another revision.
Human and agent are working on one shared edit—not passing files back and
forth.

WebMCP also makes the workflow inspectable. The agent can read timeline state,
find narration, capture real composited frames, check layout collisions, and
run a preflight before rendering. Those inspection tools close the loop:
create, look, verify, and improve.

The browser-only build exposes eighty-four WebMCP tools and keeps projects,
media, and renders in the browser. Write operations are identified for user
confirmation, untrusted content is marked, and credentials cannot be changed
by an agent tool.

What used to require repetitive timeline work can now begin as a creative
instruction and finish as a transparent, editable result. The person keeps
control of the story. The agent handles the mechanics.

Klipvia is a video editor built for people and agents to create together on the
open web.

## Timed storyboard

### 0:00–0:10 — Hook

Narration:

> Most video editors were designed for a person clicking through hundreds of
> small controls. AI can suggest an edit, but it usually cannot reach the real
> timeline where the work happens.

Visual:

- Start black with a thin animated Klipvia rule.
- Reveal: **Video editing has a new collaborator.**
- Cut on “real timeline” to the existing Klipvia screenshot.

### 0:10–0:24 — Product reveal

Narration:

> This is Klipvia: a browser-based animation and video editor that an AI agent
> can drive through WebMCP.

Visual:

- Slow 104% → 112% push into the screenshot.
- Animate small labels toward the preview, code panel, and timeline.
- Show the `webmcp · … tools` badge and explain that its focused catalog follows
  the active workspace.

### 0:24–0:45 — Why the implementation matters

Narration:

> Klipvia exposes the editor's real operations as structured, in-page tools.
> The agent does not operate a separate automation layer or a hidden copy of
> the project. It uses the same editor functions as the interface, so every
> change appears on the timeline immediately and remains visible, editable,
> and undoable by the person.

Visual:

- Three-step animated diagram:
  **Instruction → WebMCP tool → Klipvia editor facade**.
- Resolve the diagram into the real timeline.
- Briefly show an edit appearing and the Undo control becoming available.

### 0:45–1:12 — Live WebMCP proof

Narration:

> Let’s build this demo together. I can ask the agent to inspect the current
> project, find the screenshot, and create a polished animated sequence around
> it. The agent can add clips, place media, write animation code, edit timing,
> create captions, and generate this voice-over with the provider I already
> selected.

Visual:

- Record the actual prompt in the ChatGPT in-app browser.
- Show concise tool activity, not a long chat transcript.
- Show the screenshot and newly generated animation clips appearing on the
  Klipvia timeline.
- Show **Deepgram · sent to provider** briefly when creating the voice-over.

On-screen prompt:

> Create a professional WebMCP Challenge demo around the Klipvia screenshot.
> Use a clean dark editorial style, restrained motion, and this narration.
> Generate the voice-over with my configured Deepgram provider, place it on the
> main timeline, and add readable captions.

### 1:12–1:37 — Human and agent share the edit

Narration:

> Now I’ll ask it to make the screenshot the focus, add a controlled camera
> push, and place a title above it. The timeline updates as the tools run. I can
> scrub the result, move an item by hand, or ask the agent for another revision.
> Human and agent are working on one shared edit—not passing files back and
> forth.

Visual:

- Show the tool-driven camera push.
- Scrub the timeline manually.
- Make one small manual adjustment, then ask the agent for one refinement.
- Use a split-screen moment: prompt on the left, evolving preview on the right.

### 1:37–2:02 — Agent verification loop

Narration:

> WebMCP also makes the workflow inspectable. The agent can read timeline
> state, find narration, capture real composited frames, check layout
> collisions, and run a preflight before rendering. Those inspection tools
> close the loop: create, look, verify, and improve.

Visual:

- Rapid but readable sequence:
  `get_timeline` → `capture_timeline_frame` → `check_layout` → `check_timeline`.
- Show the captured frame/contact sheet.
- Finish on a clean preflight result.

### 2:02–2:22 — Trust and architecture

Narration:

> The browser-only build exposes a focused WebMCP catalog for the workspace on
> screen and keeps projects, media, and renders in the browser. Write operations
> are identified for user confirmation, untrusted content is marked, and
> credentials cannot be changed by an agent tool.

Visual:

- Minimal security card with three checks:
  **Local-first · Confirmed writes · Protected credentials**.
- Show the in-browser status and WebMCP tool count in the real UI.

### 2:22–2:43 — Result and close

Narration:

> What used to require repetitive timeline work can now begin as a creative
> instruction and finish as a transparent, editable result. The person keeps
> control of the story. The agent handles the mechanics.

> Klipvia is a video editor built for people and agents to create together on
> the open web.

Visual:

- Play the finished sequence full-screen.
- End card:
  **Klipvia**  
  **A video editor an agent can drive**  
  `klipvia.miztton.com`
- Hold the final card for at least two seconds.

## Suggested animation clips

1. **Opening rule** — 4 seconds; thin accent line draws left-to-right, title
   rises by 18 px, subtle grain or gradient drift.
2. **Interface map** — 10 seconds; screenshot with three callouts for Preview,
   Code, and Timeline; camera pushes from 104% to 112%.
3. **WebMCP flow** — 12 seconds; three nodes connected by an animated signal:
   Instruction, WebMCP Tool, Editor Facade.
4. **Verification loop** — 10 seconds; four tool names enter sequentially and
   resolve to a green preflight check.
5. **Trust card** — 8 seconds; three understated checkmarks with no exaggerated
   claims.
6. **End card** — 5 seconds; logo, tagline, and production URL.

## Capture checklist

- Capture the production URL and active `webmcp · … tools` badge in the same shot.
- Record at least one real write tool changing the timeline.
- Record a manual adjustment after an agent edit.
- Show one visual inspection result and one preflight result.
- Keep tool-call waiting time out of the final cut.
- Keep all text inside title-safe margins and captions above the bottom UI.
- Export under 2:50 to preserve margin beneath the three-minute limit.
- Use only music and visual assets you own or are licensed to include.
