# Vendored

Third-party code, copied in rather than installed, because the app ships as
plain ES modules with no bundler and no `node_modules` at runtime.

| file | version | licence | why |
|---|---|---|---|
| `mp4-muxer.mjs` | mp4-muxer 5.2.2 | MIT (`mp4-muxer.LICENSE`) | WebCodecs gives you encoded chunks and no container to put them in. This writes the MP4. Zero runtime dependencies of its own. |
