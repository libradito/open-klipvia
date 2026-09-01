/**
 * Asset library panel — upload, browse and insert images and fonts.
 *
 * Assets are served from /assets/<file>, same-origin with the editor, which is
 * what lets the rasterizer inline them for export without going through the
 * /api/asset proxy (that proxy refuses localhost by design).
 */

import { setTip } from '/tooltip.js'

const $ = (id) => document.getElementById(id)

const fmtSize = (n) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

/** The CSS that plays a sprite sheet: one class, two stepped keyframes. */
export function spriteCss(asset) {
  const sp = asset.sprite
  if (!sp) return ''
  const cls = spriteClass(asset)
  const seconds = (sp.frames / sp.fps).toFixed(3)
  return [
    `.${cls} {`,
    `  width: ${sp.frameWidth}px; height: ${sp.frameHeight}px;`,
    `  background-image: url("${asset.url}");`,
    `  background-size: ${sp.cols * sp.frameWidth}px ${sp.rows * sp.frameHeight}px;`,
    `  background-repeat: no-repeat;`,
    `  animation-name: ${cls}-x, ${cls}-y;`,
    `  animation-duration: ${(sp.cols / sp.fps).toFixed(3)}s, ${seconds}s;`,
    `  animation-timing-function: steps(${sp.cols}, jump-end), steps(${sp.rows}, jump-end);`,
    `  animation-iteration-count: infinite, infinite;`,
    `}`,
    `@keyframes ${cls}-x { from { background-position-x: 0px; } to { background-position-x: -${sp.cols * sp.frameWidth}px; } }`,
    `@keyframes ${cls}-y { from { background-position-y: 0px; } to { background-position-y: -${sp.rows * sp.frameHeight}px; } }`,
    `/* <div class="${cls}"></div> — ${sp.frames} frames at ${sp.fps} fps, ${seconds}s per loop */`,
  ].join('\n')
}

export const spriteClass = (asset) =>
  `sprite-${asset.filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`

/** The text an asset should drop into a given editor pane. */
export function snippetFor(asset, pane) {
  if (asset.sprite) {
    if (pane === 'css') return spriteCss(asset) + '\n'
    if (pane === 'html') return `<div class="${spriteClass(asset)}"></div>`
  }
  if (asset.kind === 'font') {
    const family = asset.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
    const format = asset.filename.endsWith('.woff2')
      ? 'woff2'
      : asset.filename.endsWith('.woff')
        ? 'woff'
        : asset.filename.endsWith('.otf')
          ? 'opentype'
          : 'truetype'
    if (pane === 'css') {
      return `@font-face {\n  font-family: "${family}";\n  src: url("${asset.url}") format("${format}");\n}\n`
    }
    return asset.url
  }

  if (pane === 'html') {
    const dims = asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : ''
    return `<img src="${asset.url}"${dims} alt="">`
  }
  if (pane === 'css') return `url("${asset.url}")`
  return asset.url
}

/** Extensions this library owns. Anything else a drop brings is somebody's job. */
const ASSET_EXT = /\.(png|jpe?g|webp|gif|avif|svg|woff2?|ttf|otf)$/i

export function initAssets({ insertAtCursor, insertInto, activePane, onChange, onForeignFiles, mode = () => 'clip', onInsertTimeline = null }) {
  let assets = []

  async function refresh() {
    try {
      assets = await fetch('/api/assets').then((r) => r.json())
    } catch {
      assets = []
    }
    render()
    onChange?.(assets)
    return assets
  }

  function render() {
    const grid = $('assetGrid')
    grid.innerHTML = ''

    if (!assets.length) {
      const empty = document.createElement('p')
      empty.className = 'rail-hint'
      empty.style.gridColumn = '1 / -1'
      empty.textContent = 'No assets yet.'
      grid.appendChild(empty)
      return
    }

    for (const a of assets) {
      const el = document.createElement('div')
      el.className = 'asset'
      el.dataset.asset = a.filename
      // Images are a timeline source too: drag one onto a track.
      if (a.kind === 'image') {
        el.draggable = true
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-ah-source', JSON.stringify({ kind: 'image', id: a.filename }))
          e.dataTransfer.effectAllowed = 'copy'
        })
      }
      setTip(
        el,
        `${a.name}\n${a.width && a.height ? `${a.width}×${a.height} · ` : ''}${fmtSize(a.size)} · ${a.kind}\n` +
          (a.kind === 'image'
            ? `Clip mode: click to preview, + inserts it into the code.\nTimeline mode: click to add it at the playhead, or drag it onto a track.`
            : `Click to preview it large · + inserts it straight into the code`),
        { at: 'right' },
      )

      if (a.kind === 'image') {
        const t = document.createElement('div')
        t.className = 'thumb img'
        // The asset URL goes first so it paints over the checkerboard.
        t.style.backgroundImage = `url("${a.url}"),
          linear-gradient(45deg, #191d23 25%, transparent 25%, transparent 75%, #191d23 75%),
          linear-gradient(45deg, #191d23 25%, #141719 25%, #141719 75%, #191d23 75%)`
        el.appendChild(t)
      } else {
        const t = document.createElement('div')
        t.className = 'font-badge'
        t.textContent = 'Aa'
        el.appendChild(t)
      }

      if (a.width && a.height) {
        const d = document.createElement('span')
        d.className = 'adim'
        d.textContent = `${a.width}×${a.height}`
        el.appendChild(d)
      }

      const name = document.createElement('div')
      name.className = 'aname'
      name.textContent = a.name
      el.appendChild(name)

      if (a.sprite) {


        const badge = document.createElement('span')


        badge.className = 'abadge'


        badge.textContent = `sprite ${a.sprite.frames}f`


        el.appendChild(badge)


      }

      const del = document.createElement('button')
      del.className = 'adel'
      del.textContent = '×'
      setTip(del, `Delete ${a.name} from the library.`)
      del.onclick = async (ev) => {
        ev.stopPropagation()
        await fetch(`/api/assets/${encodeURIComponent(a.filename)}`, { method: 'DELETE' })
        refresh()
      }
      el.appendChild(del)

      // Clicking opens the viewer; the + is the fast path for people who
      // already know what the asset looks like.
      const ins = document.createElement('button')
      ins.className = 'ains'
      ins.textContent = '+'
      setTip(ins, `Insert into the ${activePane().toUpperCase()} pane at the caret.`)
      ins.onclick = (ev) => {
        ev.stopPropagation()
        if (mode() === 'seq' && a.kind === 'image' && onInsertTimeline) onInsertTimeline(a)
        else insertAtCursor(snippetFor(a, activePane()))
      }
      el.appendChild(ins)

      el.onclick = () => {
        if (mode() === 'seq' && a.kind === 'image' && onInsertTimeline) onInsertTimeline(a)
        else openViewer(a)
      }
      grid.appendChild(el)
    }
  }

  async function upload(files) {
    const all = [...files]
    if (!all.length) return

    // One drop can contain a logo, a piece of footage and a subtitle file.
    // Route by extension rather than making the user aim at the right panel.
    const list = all.filter((f) => ASSET_EXT.test(f.name))
    const foreign = all.filter((f) => !ASSET_EXT.test(f.name))
    if (foreign.length) onForeignFiles?.(foreign)
    if (!list.length) return

    for (const file of list) {
      try {
        const res = await fetch(`/api/assets?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: res.statusText }))
          console.warn(`[assets] ${file.name}: ${error}`)
        }
      } catch (err) {
        console.warn(`[assets] ${file.name}: ${err?.message ?? err}`)
      }
    }
    await refresh()
  }

  /* ------------------------------------------------------------- viewer */

  let viewing = null

  function setStageBg(mode) {
    $('assetStage').dataset.abg = mode
    document
      .querySelectorAll('#dlgAsset .seg-btn[data-abg]')
      .forEach((b) => b.classList.toggle('active', b.dataset.abg === mode))
  }

  function setZoom(mode) {
    const img = $('assetImg')
    if (mode === 'fit') {
      img.classList.add('fit')
      img.style.width = ''
      img.style.height = ''
    } else {
      img.classList.remove('fit')
      // SVGs have no intrinsic pixel size to fall back on; use the probed one.
      if (viewing?.width) img.style.width = `${viewing.width}px`
      if (viewing?.height) img.style.height = `${viewing.height}px`
    }
    document
      .querySelectorAll('#assetZoom .seg-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.azoom === mode))
  }

  /** Load a font asset and render a specimen with it. */
  async function showSpecimen(asset) {
    const box = $('assetSpecimen')
    const family = `preview-${asset.filename.replace(/[^a-z0-9]/gi, '')}`
    box.innerHTML = ''
    try {
      const face = new FontFace(family, `url("${asset.url}")`)
      await face.load()
      document.fonts.add(face)
    } catch {
      box.textContent = 'This font could not be loaded for preview.'
      return
    }
    const rows = [
      ['64px', 'Aa Bb Cc'],
      ['34px', 'ABCDEFGHIJKLM NOPQRSTUVWXYZ'],
      ['22px', 'abcdefghijklmnopqrstuvwxyz 0123456789'],
      ['17px', 'Ejecutar operaciones básicas — the quick brown fox jumps over the lazy dog.'],
    ]
    for (const [size, text] of rows) {
      const wrap = document.createElement('div')
      wrap.className = 'row'
      const tag = document.createElement('div')
      tag.className = 'sz'
      tag.textContent = size
      const line = document.createElement('div')
      line.style.font = `400 ${size}/1.25 "${family}", system-ui, sans-serif`
      line.textContent = text
      wrap.append(tag, line)
      box.appendChild(wrap)
    }
  }

  function openViewer(asset) {
    viewing = asset
    const isImage = asset.kind === 'image'

    $('assetName').textContent = asset.name
    $('assetImg').hidden = !isImage
    $('assetSpecimen').hidden = isImage
    $('zoomLabel').hidden = !isImage
    $('assetZoom').hidden = !isImage

    const meta = $('assetMeta')
    meta.innerHTML = ''
    const rows = [
      ['Type', asset.mime],
      ['Size', fmtSize(asset.size)],
      ...(asset.width && asset.height ? [['Pixels', `${asset.width} × ${asset.height}`]] : []),
      ...(asset.sprite
        ? [
            ['Sprite', `${asset.sprite.frames} frames · ${asset.sprite.cols}×${asset.sprite.rows} grid · ${asset.sprite.frameWidth}×${asset.sprite.frameHeight} each`],
            ['Plays', `${asset.sprite.fps} fps · ${(asset.sprite.frames / asset.sprite.fps).toFixed(2)}s from ${asset.sprite.source}`],
          ]
        : []),
      ...(asset.origin ? [['From', `${asset.origin.source} at ${(asset.origin.atMs / 1000).toFixed(2)}s`]] : []),
      ['URL', asset.url],
    ]
    const sp = asset.sprite
    const spriteEl = $('assetSprite')
    $('btnInsSprite').classList.toggle('hidden', !sp)
    if (sp) {
      spriteEl.hidden = false
      spriteEl.style.cssText =
        `width:${sp.frameWidth}px;height:${sp.frameHeight}px;background-image:url("${asset.url}");` +
        `background-size:${sp.cols * sp.frameWidth}px ${sp.rows * sp.frameHeight}px;` +
        `--cols:${sp.cols};--rows:${sp.rows};--dx:${(sp.cols / sp.fps).toFixed(3)}s;--dy:${(sp.frames / sp.fps).toFixed(3)}s;` +
        `--endx:-${sp.cols * sp.frameWidth}px;--endy:-${sp.rows * sp.frameHeight}px;`
    } else {
      spriteEl.hidden = true
    }
    for (const [k, v] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      meta.append(dt, dd)
    }

    setStageBg('checker')
    if (isImage) {
      const img = $('assetImg')
      img.src = asset.url
      setZoom('fit')
    } else {
      showSpecimen(asset)
    }

    $('assetHint').textContent = ''
    $('dlgAsset').showModal()
  }

  const flash = (msg) => {
    $('assetHint').textContent = msg
    setTimeout(() => {
      if ($('assetHint').textContent === msg) $('assetHint').textContent = ''
    }, 2200)
  }

  document
    .querySelectorAll('#dlgAsset .seg-btn[data-abg]')
    .forEach((b) => (b.onclick = () => setStageBg(b.dataset.abg)))
  document
    .querySelectorAll('#assetZoom .seg-btn')
    .forEach((b) => (b.onclick = () => setZoom(b.dataset.azoom)))

  $('btnInsSprite').onclick = () => {
    if (!viewing?.sprite) return
    insertInto('css', snippetFor(viewing, 'css'))
    insertInto('html', snippetFor(viewing, 'html'))
    flash('Sprite added to HTML and CSS.')
  }
  $('btnInsHtml').onclick = () => {
    insertAtCursor(snippetFor(viewing, 'html'))
    flash('Inserted into HTML.')
  }
  $('btnInsCss').onclick = () => {
    insertAtCursor(snippetFor(viewing, 'css'))
    flash('Inserted into CSS.')
  }
  $('btnCopyUrl').onclick = async () => {
    try {
      await navigator.clipboard.writeText(viewing.url)
      flash('URL copied.')
    } catch {
      flash(viewing.url)
    }
  }
  $('btnDelAsset').onclick = async () => {
    await fetch(`/api/assets/${encodeURIComponent(viewing.filename)}`, { method: 'DELETE' })
    $('dlgAsset').close()
    refresh()
  }
  $('btnAssetClose').onclick = () => $('dlgAsset').close()

  /* ------------------------------------------------------------- wiring */

  $('btnUpload').onclick = () => $('fileInput').click()
  $('fileInput').onchange = (e) => {
    upload(e.target.files)
    e.target.value = ''
  }

  // Drag and drop anywhere in the window.
  let dragDepth = 0
  const zone = $('dropZone')
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files')

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (++dragDepth === 1) zone.classList.add('on')
  })
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault()
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    if (--dragDepth <= 0) {
      dragDepth = 0
      zone.classList.remove('on')
    }
  })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    zone.classList.remove('on')
    upload(e.dataTransfer.files)
  })

  // Paste an image straight from the clipboard.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean)
    if (!files.length) return
    e.preventDefault()
    // Clipboard images arrive unnamed; give them something readable.
    upload(
      files.map((f) =>
        f.name && f.name !== 'image.png'
          ? f
          : new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, { type: f.type }),
      ),
    )
  })

  async function remove(filename) {
    await fetch(`/api/assets/${encodeURIComponent(filename)}`, { method: 'DELETE' })
    await refresh()
  }

  return { refresh, upload, openViewer, remove, get list() { return assets } }
}
