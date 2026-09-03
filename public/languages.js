/**
 * Languages, named and ordered the way a person picking a voice expects.
 *
 * Every voice provider labels its voices with a language, but each in its own
 * way — `es`, `es-MX`, `Spanish (Mexico)`, `spanish`. Everything here works on
 * BCP-47 codes and turns them into a name at the last moment, using the
 * browser's own dictionary so "es" reads as "Español" to somebody whose browser
 * is in Spanish and "Spanish" to somebody whose browser is not.
 *
 * Imports without a DOM: Bun runs the tests here, and `navigator` is guarded.
 */

/** The languages worth offering by name for transcription. */
export const COMMON_LANGUAGES = ['es', 'en', 'pt', 'fr', 'de', 'it', 'nl', 'ja', 'zh', 'ko', 'hi', 'ar', 'ru', 'tr', 'pl', 'sv']

/** For browsers without `Intl.DisplayNames`, and for codes it does not know. */
const FALLBACK_NAMES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch',
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', hi: 'Hindi', ar: 'Arabic', ru: 'Russian', tr: 'Turkish',
  pl: 'Polish', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', el: 'Greek', he: 'Hebrew',
  cs: 'Czech', hu: 'Hungarian', ro: 'Romanian', uk: 'Ukrainian', id: 'Indonesian', ms: 'Malay', vi: 'Vietnamese',
  th: 'Thai', ta: 'Tamil', fil: 'Filipino', sw: 'Swahili', bg: 'Bulgarian', hr: 'Croatian', sk: 'Slovak',
}

/** Names of the regions that matter for voices, when the browser cannot say. */
const FALLBACK_REGIONS = {
  US: 'United States', GB: 'United Kingdom', AU: 'Australia', IE: 'Ireland', PH: 'Philippines', IN: 'India',
  MX: 'Mexico', ES: 'Spain', CO: 'Colombia', AR: 'Argentina', 419: 'Latin America', BR: 'Brazil', PT: 'Portugal',
  CA: 'Canada', FR: 'France', DE: 'Germany', CN: 'China', TW: 'Taiwan',
}

/**
 * A language tag, tidied: `Spanish` → `es`, `es_MX` → `es-MX`, `EN-us` → `en-US`.
 * Anything unrecognisable comes back lower-cased rather than dropped, so a
 * provider's odd label still groups with its own kind.
 */
export function normaliseLang(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const byName = Object.entries(FALLBACK_NAMES).find(([, name]) => name.toLowerCase() === text.toLowerCase())
  if (byName) return byName[0]
  const [lang, region] = text.replace(/_/g, '-').split('-')
  if (!/^[a-z]{2,3}$/i.test(lang)) return text.toLowerCase()
  const l = lang.toLowerCase()
  if (!region) return l
  return /^\d{3}$/.test(region) ? `${l}-${region}` : `${l}-${region.toUpperCase()}`
}

/** `es-MX` → `es`. The part that decides which group a voice sits in. */
export const baseLang = (code) => normaliseLang(code).split('-')[0]

/** The language the browser is in, as a base code; `en` when there is no browser. */
export function uiLanguage() {
  try {
    return baseLang(globalThis.navigator?.language || 'en') || 'en'
  } catch {
    return 'en'
  }
}

let displayNames = null
const namer = () => {
  if (displayNames !== null) return displayNames
  try {
    displayNames = typeof Intl?.DisplayNames === 'function' ? new Intl.DisplayNames([globalThis.navigator?.language || 'en'], { type: 'language' }) : false
  } catch {
    displayNames = false
  }
  return displayNames
}

/**
 * "es-MX" → "Spanish (Mexico)" (or "español (México)" in a Spanish browser).
 * Capitalised, because Intl gives lower-case in some locales and a list of
 * languages reads as a list of names.
 */
export function languageName(code) {
  const tag = normaliseLang(code)
  if (!tag) return 'Unknown'
  if (tag === '*') return 'Any language'
  const n = namer()
  let name = null
  if (n) {
    try {
      name = n.of(tag)
    } catch {
      name = null
    }
  }
  if (!name || name === tag) {
    const [lang, region] = tag.split('-')
    const base = FALLBACK_NAMES[lang] ?? lang.toUpperCase()
    name = region ? `${base} (${FALLBACK_REGIONS[region] ?? region})` : base
  }
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * The voices grouped by language, in the order somebody wants them.
 *
 * The chosen language (or the browser's) first, then Spanish and English —
 * the two most of this editor's users narrate in — then the rest by name. A
 * voice that speaks several languages is listed once, under its first, and its
 * others are kept on it for a picker to show.
 */
export function groupVoices(list, { first = null } = {}) {
  const groups = new Map()
  for (const v of list ?? []) {
    // A bare name is a voice with no language of its own — "any", not "unknown".
    const voice = typeof v === 'string' ? { id: v, name: v, lang: '*' } : v
    const lang = baseLang(voice.lang || voice.langs?.[0] || '') || 'und'
    if (!groups.has(lang)) groups.set(lang, { lang, label: lang === 'und' ? 'Other' : languageName(lang), voices: [] })
    groups.get(lang).voices.push(voice)
  }
  const pin = [baseLang(first || '') || uiLanguage(), 'es', 'en']
  const rank = (g) => {
    const i = pin.indexOf(g.lang)
    return i === -1 ? pin.length : i
  }
  return [...groups.values()].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d) return d
    if (a.lang === 'und') return 1
    if (b.lang === 'und') return -1
    return a.label.localeCompare(b.label)
  })
}

/** The distinct base languages a voice list covers, in group order. */
export const languagesIn = (list, opts) => groupVoices(list, opts).map((g) => g.lang).filter((l) => l !== 'und' && l !== '*')

/** `en` · `es` · … as the short chips a row wears. */
export const langChip = (code) => (code === '*' ? 'any' : baseLang(code).toUpperCase())
