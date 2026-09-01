# syntax=docker/dockerfile:1

###############################################################################
# Klipvia in a container — two images, because Klipvia is two things.
#
#   --target static   nginx serving public/. No server, no state, no ffmpeg.
#                     Projects live in the visitor's IndexedDB, footage in
#                     their OPFS, renders come out of their WebCodecs. This is
#                     the one to deploy: it holds nothing, so it can lose
#                     nothing, and it scales by doing nothing.
#
#   --target server   Bun + ffmpeg + a data volume. The full editor: alpha
#                     renders, ProRes, sprite sheets, frame extraction — the
#                     jobs that are genuinely ffmpeg and cannot be a browser.
#                     One person's machine, not a shared host: there is no
#                     login, so anyone who can reach the port owns the data.
#
# Both are built from the same tree and serve the same `public/`. The app asks
# `/api/health` at boot and becomes whichever it is standing in.
###############################################################################


# ── dependencies ────────────────────────────────────────────────────────────
# Its own stage so a source edit does not re-resolve the lockfile.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production


# ── server ──────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS server

# The one thing the browser cannot do for itself. Pinned to the distro's
# build, which carries libx264, libmp3lame, libvpx, prores_ks and qtrle —
# every encoder the export formats name.
RUN apk add --no-cache ffmpeg tini

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

# Everything the server writes lands under one directory, so one volume is the
# whole of the state. Created up front and owned by the runtime user, because
# a bind mount arrives owned by root and a process that cannot write its own
# data directory fails on the first save rather than at boot.
RUN mkdir -p data/projects data/timelines data/media data/assets data/transcripts data/exports \
 && chown -R bun:bun /app/data

USER bun
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

# tini reaps the ffmpeg children. Without it a cancelled render leaves a
# zombie per attempt and the container slowly fills with them.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]


# ── static ──────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS static

# nginx's stock mime.types has no entry for .mjs, so it goes out as
# application/octet-stream — and Chrome refuses to execute a module served as
# anything but JavaScript. The one .mjs here is the MP4 muxer, imported at the
# top of clientexport.js, so without this every browser-side render fails at
# import with nothing on screen to explain it.
#
# Edited into nginx's own table rather than declared in the site config: a
# `types` block in a server or location does not extend the inherited map, it
# replaces it — which silently turns CSS and HTML into octet-stream too.
RUN sed -i 's|application/javascript  *js;|application/javascript                           js mjs;|' /etc/nginx/mime.types \
 && grep -q 'js mjs;' /etc/nginx/mime.types

COPY public /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/klipvia-common.conf /etc/nginx/klipvia-common.conf
# nginx-alpine runs everything in /docker-entrypoint.d before starting, which
# is where the origin-trial token becomes a header — see the script.
COPY docker/40-origin-trial.sh /docker-entrypoint.d/40-origin-trial.sh
# The include has to exist even with no token, or nginx will not start. The
# entrypoint writes it on every boot; this is only for an overridden one.
RUN chmod +x /docker-entrypoint.d/40-origin-trial.sh \
 && touch /tmp/klipvia-origin-trial.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
