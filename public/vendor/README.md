# Vendored

Third-party code, copied in rather than installed, because the app ships as
plain ES modules with no bundler and no `node_modules` at runtime.

| file | version | licence | why |
|---|---|---|---|
| `mp4-muxer.mjs` | mp4-muxer 5.2.2 | MIT (`mp4-muxer.LICENSE`) | WebCodecs gives you encoded chunks and no container to put them in. This writes the MP4. Zero runtime dependencies of its own. |
| `../icons.js` (shapes only) | Lucide 0.4xx | ISC (https://github.com/lucide-icons/lucide/blob/main/LICENSE) | The icon shapes — path data on a 24-unit grid — are Lucide's, transcribed into `public/icons.js` by hand so the app ships one small module instead of a font or a sprite sheet. The wrapper code around them is ours. |
