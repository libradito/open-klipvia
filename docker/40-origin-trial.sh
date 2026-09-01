#!/bin/sh
# Turn WEBMCP_ORIGIN_TRIAL_TOKEN into a header, or into nothing.
#
# WebMCP is behind a Chrome origin trial. A deployed origin needs its own token
# (register at the Chrome origin trials console) before `document.modelContext`
# exists for visitors; without one they have to set
# chrome://flags/#enable-webmcp-testing by hand, which most people will not do.
#
# Written as a file rather than substituted into the config because
# `add_header Origin-Trial ""` is not the same as no header at all, and an
# empty Origin-Trial header is a thing Chrome has to parse and reject on every
# response. Absent is cleaner than empty.
#
# It lands in /tmp, not /etc/nginx, so the image can run with a read-only root
# filesystem — which is the whole posture of this service: it holds nothing, so
# nothing should be able to write to it either. Runs from nginx-alpine's
# entrypoint, before nginx parses anything.
set -eu

OUT=/tmp/klipvia-origin-trial.conf
TOKEN="${WEBMCP_ORIGIN_TRIAL_TOKEN:-}"

if [ -n "$TOKEN" ]; then
  # A token is one base64url blob: no quotes, no spaces, no newlines. Refusing
  # anything else keeps a stray shell variable from becoming a config
  # injection, and keeps a pasted-in newline from breaking the whole server.
  if printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9+/=_-]+$'; then
    printf 'add_header Origin-Trial "%s" always;\n' "$TOKEN" > "$OUT"
    echo "klipvia: Origin-Trial header set (${#TOKEN} chars) — WebMCP available to visitors"
  else
    : > "$OUT"
    echo "klipvia: WEBMCP_ORIGIN_TRIAL_TOKEN does not look like a token, ignoring it" >&2
  fi
else
  : > "$OUT"
  echo "klipvia: no WEBMCP_ORIGIN_TRIAL_TOKEN — visitors need chrome://flags/#enable-webmcp-testing"
fi
