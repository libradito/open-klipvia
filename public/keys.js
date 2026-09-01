/**
 * Keyframes: a value that is different at two moments, and the line between.
 *
 * The whole model is four lists of `{ms, v, ease}` hung off an item — where it
 * sits, how big it is, how solid. `ms` is the item's *own* time, counted from
 * its start, so trimming the head of a shot does not silently re-time the move
 * inside it, and copying the item copies the move with it.
 *
 * Three shapes of interpolation and no more, because both halves of the editor
 * have to compute the identical curve: the browser between frames of the
 * preview, and an ffmpeg expression between frames of the render. Every easing
 * here is one line of arithmetic in both languages. A bezier editor would be a
 * fifth list nobody could render.
 *
 * Rotation is deliberately not keyframable. Turning a layer changes the size of
 * the box it needs, and a box that changes size *per frame* would make the
 * anchor arithmetic time-varying everywhere it is used — placement, padding,
 * the handles, the filtergraph. Position, size and opacity cover the moves
 * people actually make: a still that drifts, a logo that pops, a card that
 * fades. Turning stays a property you set once.
 */

/** The properties a key can be put on, and what they mean when there are none. */
export const KEYABLE = ['offsetX', 'offsetY', 'scale', 'opacity']

export const KEY_LABELS = {
  offsetX: 'Across',
  offsetY: 'Down',
  scale: 'Size',
  opacity: 'Opacity',
}

/** `hold` steps; `linear` is a straight line; `ease` slows in and out of it. */
export const EASES = ['ease', 'linear', 'hold']

const smooth = (u) => u * u * (3 - 2 * u)

function shape(ease, u) {
  if (ease === 'hold') return 0
  if (ease === 'linear') return u
  return smooth(u)
}

/** A property's keys, cleaned up and in time order, or null when there are none. */
export function keysFor(item, prop) {
  const list = item?.keys?.[prop]
  if (!Array.isArray(list) || !list.length) return null
  const out = list
    .filter((k) => k && Number.isFinite(Number(k.ms)) && Number.isFinite(Number(k.v)))
    .map((k) => ({
      ms: Math.max(0, Math.round(Number(k.ms))),
      v: Number(k.v),
      ease: EASES.includes(k.ease) ? k.ease : 'ease',
    }))
    .sort((a, b) => a.ms - b.ms)
  return out.length ? out : null
}

export const isKeyed = (item, prop) => !!keysFor(item, prop)
export const anyKeyed = (item) => KEYABLE.some((p) => keysFor(item, p))

/**
 * The value at `ms` — item-local. Before the first key and after the last it
 * holds flat, which is what makes a single key mean "this value, from here".
 */
export function valueAt(keys, ms, fallback = 0) {
  if (!keys?.length) return fallback
  if (ms <= keys[0].ms) return keys[0].v
  const last = keys[keys.length - 1]
  if (ms >= last.ms) return last.v
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1]
    if (ms < a.ms || ms > b.ms) continue
    const span = b.ms - a.ms
    if (span <= 0) return b.v
    // The *outgoing* key owns the segment: its easing is what happens next.
    return a.v + (b.v - a.v) * shape(a.ease, (ms - a.ms) / span)
  }
  return last.v
}

/** The largest value a property ever reaches — what a clip is rendered at. */
export function peakOf(keys, fallback) {
  if (!keys?.length) return fallback
  return keys.reduce((n, k) => Math.max(n, k.v), -Infinity)
}

/**
 * The item as it is at one instant: a shallow copy with every keyed field
 * resolved to a plain number.
 *
 * Everything downstream — the box arithmetic, the CSS the compositor writes,
 * the handles — then goes on reading ordinary properties and never has to know
 * that some of them move. `atMs` is timeline time; the keys are item time.
 */
export function resolveAt(item, atMs) {
  if (!item || !anyKeyed(item)) return item
  const local = atMs == null ? 0 : atMs - item.startMs
  const out = { ...item }
  for (const prop of KEYABLE) {
    const keys = keysFor(item, prop)
    if (!keys) continue
    const base = prop === 'scale' || prop === 'opacity' ? (Number(item[prop]) || 1) : (Number(item[prop]) || 0)
    out[prop] = valueAt(keys, local, base)
  }
  return out
}

/** Put a key on `prop` at item-local `ms`, replacing one already on that frame. */
export function setKey(item, prop, ms, v, ease = 'ease', frameMs = 33) {
  if (!KEYABLE.includes(prop)) throw new Error(`${prop} cannot be keyframed`)
  const at = Math.max(0, Math.min(Math.round(ms), item.durationMs))
  item.keys = item.keys ?? {}
  const list = (item.keys[prop] ?? []).filter((k) => Math.abs(k.ms - at) >= frameMs / 2)
  list.push({ ms: at, v: Number(v), ease })
  list.sort((a, b) => a.ms - b.ms)
  item.keys[prop] = list
  return list
}

/** Remove one key. Dropping the last one on a property drops the property. */
export function removeKey(item, prop, ms, frameMs = 33) {
  const list = item?.keys?.[prop]
  if (!list) return false
  const next = list.filter((k) => Math.abs(k.ms - ms) >= frameMs / 2)
  if (next.length === list.length) return false
  if (next.length) item.keys[prop] = next
  else delete item.keys[prop]
  if (!Object.keys(item.keys).length) delete item.keys
  return true
}

export function clearKeys(item, prop = null) {
  if (!item?.keys) return
  if (prop) delete item.keys[prop]
  else item.keys = {}
  if (!Object.keys(item.keys).length) delete item.keys
}

/** Every keyed moment on an item, deduplicated — what the timeline draws. */
export function keyTimes(item) {
  const at = new Set()
  for (const prop of KEYABLE) for (const k of keysFor(item, prop) ?? []) at.add(k.ms)
  return [...at].sort((a, b) => a - b)
}
