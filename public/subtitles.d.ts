/**
 * Types for the shared subtitle parser.
 *
 * `subtitles.js` is plain JavaScript so a browser can import it directly; this
 * gives the server back the types it had before the code moved here.
 */
import type { Cue, Transcript } from '../src/transcripts'

export declare function normaliseCues(cues: Cue[]): Cue[]

export declare function replaceCuesInWindow(
  cues: Cue[],
  fromMs: number,
  toMs: number,
  incoming: Cue[],
): Cue[]

export declare function finalizeTranscript(t: Transcript, cues: Cue[]): Transcript

export declare function parseTranscript(
  filename: string,
  text: string,
): { ok: true; cues: Cue[]; source: Transcript['source'] } | { ok: false; error: string }

export declare function toSrt(cues: Cue[], offsetMs?: number): string
export declare function toVtt(cues: Cue[], offsetMs?: number): string
