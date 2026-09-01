import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { api, exportSocket, upgradeExportStream } from './api'
import { probeFfmpeg } from './ffmpeg'
import { ASSET_DIR, mimeFor, safeAssetName } from './assets'
import { MEDIA_DIR, mediaMimeFor, rangeResponse, safeMediaName } from './media'
import { join } from 'node:path'

const app = new Hono()

// WebMCP is behind an origin trial. On localhost the chrome://flags switch is
// enough; to serve the editor from a real origin, set this and Chrome will
// enable document.modelContext for it.
const originTrialToken = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN
if (originTrialToken) {
  app.use('*', async (c, next) => {
    await next()
    c.header('Origin-Trial', originTrialToken)
  })
}

app.route('/api', api)

// Uploaded assets live at /assets/<file> — same-origin with the editor so the
// rasterizer can inline them directly instead of via the (localhost-blocking)
// asset proxy.
app.get('/assets/:filename', async (c) => {
  const name = safeAssetName(c.req.param('filename'))
  if (!name) return c.json({ error: 'bad asset name' }, 400)

  const file = Bun.file(join(ASSET_DIR, name))
  if (!(await file.exists())) return c.json({ error: 'not found' }, 404)

  return new Response(file, {
    headers: {
      'content-type': mimeFor(name)?.mime ?? 'application/octet-stream',
      'content-length': String(file.size),
      'cache-control': 'no-cache',
    },
  })
})

// Imported footage, served with byte ranges. Chrome will not seek a <video>
// against a server that answers every request with the whole file — without
// this the timeline's scrub stalls on the first drag.
app.get('/media/:filename', async (c) => {
  const name = safeMediaName(c.req.param('filename'))
  if (!name) return c.json({ error: 'bad media name' }, 400)

  const path = join(MEDIA_DIR, name)
  const file = Bun.file(path)
  if (!(await file.exists())) return c.json({ error: 'not found' }, 404)

  const mime = mediaMimeFor(name)?.mime ?? 'application/octet-stream'
  return rangeResponse(path, mime, file.size, c.req.header('range') ?? null)
})

app.get('/', serveStatic({ path: './public/index.html' }))
app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT ?? 3000)

const ff = await probeFfmpeg()
console.log(`\n  Klipvia  →  http://localhost:${port}`)
console.log(`  ffmpeg         →  ${ff.ok ? ff.version : 'NOT FOUND on PATH — Studio export disabled'}`)
console.log(`  webmcp         →  enable chrome://flags/#enable-webmcp-testing${originTrialToken ? ' (origin-trial token set)' : ''}\n`)

export default {
  port,
  fetch(req: Request, server: Parameters<typeof upgradeExportStream>[1]) {
    // Export frames stream over a socket; everything else is Hono.
    const upgraded = upgradeExportStream(req, server)
    if (upgraded !== undefined) return upgraded
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket' && new URL(req.url).pathname.endsWith('/stream')) return undefined
    return app.fetch(req, server)
  },
  websocket: exportSocket,
  // ProRes encodes of long clips can keep the /finish request open for a while.
  idleTimeout: 255,
  maxRequestBodySize: 256 * 1024 * 1024,
}
