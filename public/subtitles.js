/**
 * Reading and writing subtitles.
 *
 * SRT, WebVTT and the several shapes Whisper writes, in and out. This lives in
 * `public/` and is plain JavaScript on purpose: the server imports it to parse
 * an upload, and the browser imports it to do the same when there is no server.
 * One parser, so a file that imports cleanly on your machine imports cleanly on
 * a hosted build — and a cue that drifts a millisecond drifts in both or in
 * neither.
 *
 * Generated from the TypeScript it replaced; edit it here now, not there.
 */

function parseStamp(raw) {
  const s = raw.trim().replace(",", ".");
  const m = s.match(/^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m)
    return null;
  const [, a, b, c] = m;
  const secs = parseFloat(c);
  const mins = b !== undefined ? Number(b) : a !== undefined ? Number(a) : 0;
  const hours = b !== undefined && a !== undefined ? Number(a) : 0;
  return Math.round((hours * 3600 + mins * 60 + secs) * 1000);
}
function cleanText(lines) {
  return lines.join(`
`).replace(/<[^>]*>/g, "").trim();
}
function parseTimingLine(line) {
  const m = line.match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/);
  if (!m)
    return null;
  const startMs = parseStamp(m[1]);
  const endMs = parseStamp(m[2]);
  if (startMs === null || endMs === null)
    return null;
  return { startMs, endMs };
}
function parseCueText(text) {
  const lines = text.replace(/\r\n?/g, `
`).split(`
`);
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(WEBVTT|NOTE|STYLE|REGION)/.test(line) || !line.trim()) {
      i++;
      continue;
    }
    let timing = parseTimingLine(line);
    if (!timing) {
      const next = lines[i + 1];
      if (next && parseTimingLine(next)) {
        i++;
        timing = parseTimingLine(lines[i]);
      } else {
        i++;
        continue;
      }
    }
    i++;
    const body = [];
    while (i < lines.length && lines[i].trim() && !parseTimingLine(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    const content = cleanText(body);
    if (content && timing.endMs > timing.startMs) {
      cues.push({ startMs: timing.startMs, endMs: timing.endMs, text: content });
    }
  }
  return cues;
}
function parseWhisper(json) {
  const segments = Array.isArray(json) ? json : Array.isArray(json?.segments) ? json.segments : Array.isArray(json?.transcription) ? json.transcription : [];
  const toMs = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n))
      return null;
    return Math.round(n > 1e5 ? n : n * 1000);
  };
  const readWords = (raw) => {
    if (!Array.isArray(raw))
      return;
    const words = [];
    for (const w of raw) {
      const startMs = toMs(w.start ?? w.startTime ?? w.from);
      const endMs = toMs(w.end ?? w.endTime ?? w.to);
      const text = String(w.word ?? w.text ?? "").trim();
      if (startMs === null || endMs === null || !text)
        continue;
      words.push({ startMs, endMs, text });
    }
    return words.length ? words : undefined;
  };
  if (segments.length) {
    // Whisper hangs word timings off each segment; the OpenAI-shaped
    // `verbose_json` that every compatible server returns puts them in one flat
    // list beside the segments instead. Reading only the per-segment field
    // dropped them silently — the cues came out right and the karaoke
    // highlighting they exist for simply never worked. Fold the flat list back
    // into whichever segment each word falls inside.
    const loose = readWords(json?.words);
    const cues = [];
    for (const s of segments) {
      const startMs = toMs(s.start ?? s.startTime ?? s.offsets?.from);
      const endMs = toMs(s.end ?? s.endTime ?? s.offsets?.to);
      const text = String(s.text ?? "").trim();
      if (startMs === null || endMs === null || !text)
        continue;
      let words = readWords(s.words);
      if (!words && loose) {
        const inside = loose.filter((w) => w.startMs < endMs && w.endMs > startMs);
        if (inside.length)
          words = inside;
      }
      cues.push({ startMs, endMs, text, words });
    }
    if (cues.length)
      return cues;
  }
  const words = readWords(json?.words);
  if (!words)
    return [];
  const cues = [];
  let bucket = [];
  const flush = () => {
    if (!bucket.length)
      return;
    cues.push({
      startMs: bucket[0].startMs,
      endMs: bucket[bucket.length - 1].endMs,
      text: bucket.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
      words: bucket
    });
    bucket = [];
  };
  for (const w of words) {
    bucket.push(w);
    const long = bucket[bucket.length - 1].endMs - bucket[0].startMs > 4000;
    const sentenceEnd = /[.!?]$/.test(w.text);
    if (long || sentenceEnd || bucket.length >= 12)
      flush();
  }
  flush();
  return cues;
}
export function normaliseCues(cues) {
  const sorted = cues.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text && c.endMs > c.startMs).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const cue of sorted) {
    const prev = out[out.length - 1];
    if (prev && cue.text === prev.text && cue.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      if (cue.words?.length)
        prev.words = [...prev.words ?? [], ...cue.words];
      continue;
    }
    if (prev && cue.startMs < prev.endMs) {
      prev.endMs = cue.startMs;
      if (prev.words)
        prev.words = prev.words.filter((w) => w.startMs < prev.endMs).map((w) => ({ ...w, endMs: Math.min(w.endMs, prev.endMs) }));
      if (prev.endMs - prev.startMs < 40)
        out.pop();
    }
    out.push(cue);
  }
  return out;
}
function clampCue(c, a, b) {
  const startMs = Math.max(c.startMs, a);
  const endMs = Math.min(c.endMs, b);
  if (endMs - startMs < 40)
    return null;
  const words = c.words?.filter((w) => w.endMs > startMs && w.startMs < endMs).map((w) => ({ ...w, startMs: Math.max(w.startMs, startMs), endMs: Math.min(w.endMs, endMs) }));
  return { ...c, startMs, endMs, ...words?.length ? { words } : { words: undefined } };
}
export function replaceCuesInWindow(cues, fromMs, toMs, incoming) {
  const from = Math.max(0, Math.round(fromMs));
  const to = Math.round(toMs);
  if (to <= from)
    throw new Error("the window is empty");
  const kept = [];
  for (const c of cues) {
    if (c.endMs <= from || c.startMs >= to) {
      kept.push(c);
      continue;
    }
    const before = c.startMs < from ? clampCue(c, c.startMs, from) : null;
    const after = c.endMs > to ? clampCue(c, to, c.endMs) : null;
    if (before)
      kept.push(before);
    if (after)
      kept.push(after);
  }
  for (const n of incoming) {
    const text = String(n.text ?? "").trim();
    if (!text)
      continue;
    const cut = clampCue({ startMs: Number(n.startMs) || 0, endMs: Number(n.endMs) || 0, text, words: n.words }, from, to);
    if (cut)
      kept.push(cut);
  }
  return normaliseCues(kept);
}
export function finalizeTranscript(t, cues) {
  const clean = normaliseCues(cues);
  return {
    ...t,
    cues: clean,
    wordLevel: clean.some((q) => q.words?.length),
    durationMs: clean.length ? Math.max(...clean.map((q) => q.endMs)) : 0
  };
}
export function parseTranscript(filename, text) {
  const trimmed = text.trim();
  if (!trimmed)
    return { ok: false, error: "empty file" };
  const lower = filename.toLowerCase();
  const looksJson = lower.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson) {
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      return { ok: false, error: `not valid JSON: ${err.message}` };
    }
    const cues = normaliseCues(parseWhisper(json));
    if (!cues.length)
      return { ok: false, error: "no segments or words found in that JSON" };
    return { ok: true, cues, source: "whisper" };
  }
  const cues = normaliseCues(parseCueText(trimmed));
  if (!cues.length)
    return { ok: false, error: "no cues found — expected SRT, WebVTT or Whisper JSON" };
  return { ok: true, cues, source: lower.endsWith(".vtt") || /^WEBVTT/.test(trimmed) ? "vtt" : "srt" };
}
function stamp(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t % 3600000 / 60000);
  const s = Math.floor(t % 60000 / 1000);
  const f = t % 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}
export function toSrt(cues, offsetMs = 0) {
  return cues.map((c, i) => `${i + 1}
${stamp(c.startMs + offsetMs, ",")} --> ${stamp(c.endMs + offsetMs, ",")}
${c.text}
`).join(`
`);
}
export function toVtt(cues, offsetMs = 0) {
  const body = cues.map((c) => `${stamp(c.startMs + offsetMs, ".")} --> ${stamp(c.endMs + offsetMs, ".")}
${c.text}
`).join(`
`);
  return `WEBVTT

${body}`;
}
