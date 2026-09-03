/**
 * Types for the shared file-type sniffer.
 *
 * `filetype.js` is plain JavaScript so a browser can import it directly; this
 * gives the server the types.
 */

export declare const INLINE_CAPS: { asset: number; media: number; text: number }
export declare const ASSET_TYPES: Record<string, string>
export declare const MEDIA_TYPES: Record<string, string>

export declare function sniffAsset(bytes: Uint8Array): string | null
export declare function sniffMedia(bytes: Uint8Array): string | null
export declare function looksLikeSvg(bytes: Uint8Array): boolean

export declare function nameIncoming(
  kind: 'asset' | 'media',
  bytes: Uint8Array,
  opts?: { name?: string; mime?: string; strict?: boolean },
): { ok: true; name: string; ext: string; mime: string; sniffed: string | null } | { ok: false; error: string }

export declare function isDataUrl(s: unknown): boolean
export declare function dataUrlSize(s: string): number
export declare function decodeDataUrl(
  s: string,
  opts?: { cap?: number; kind?: string },
): { ok: true; mime: string; bytes: Uint8Array } | { ok: false; status: 400 | 413; error: string }
