# Klipvia brand assets

The editor is dark, always, so the working wordmark and mark are **white on
transparent**. The black wordmark exists for one reason: a README rendered on a
light background, where white ink would be invisible.

| file | what it is | used by |
|---|---|---|
| `klipvia-wordmark.png` | white wordmark, 336×120 | the header; the README on a dark theme |
| `klipvia-wordmark-on-light.png` | black wordmark, 336×120 | the README on a light theme |
| `klipvia-mark.png` | white K, 236×256 | the header below 760px, where the topbar has real work to fit |
| `favicon.png` | 96×96 | the browser tab |
| `icon-180.png` | 180×180 | `apple-touch-icon` |

Both icons are the white K on a `#0e1013` rounded tile rather than bare white
ink, because a bare white mark disappears against a light tab strip and a bare
black one disappears against a dark one. A tile reads on both.

`source/` holds the 4× masters everything above was cut from — crop to the ink,
then scale. They are not requested by the app; they are here so the derived
files can be regenerated. The commands are in the project README's history, but
the shape is:

```bash
# trim to the ink, then scale by height
ffmpeg -i source/klipvia-wordmark-white@4x.png \
  -vf "crop=2508:897:327:87,scale=-2:120:flags=lanczos" klipvia-wordmark.png
```
