/**
 * Stage runtime — injected as the first script inside every preview iframe,
 * before any user code runs.
 *
 * It replaces the page's clock with a virtual one so the animation can be
 * *seeked* rather than merely played. That is what makes an export frame-exact:
 * the exporter walks t = 0, 1/fps, 2/fps ... and the page renders exactly that
 * moment, no matter how long the rasterizer actually took.
 *
 * Three kinds of animation are driven:
 *   - CSS animations / transitions  -> Web Animations API currentTime
 *   - requestAnimationFrame loops   -> fed the virtual timestamp
 *   - setTimeout / setInterval      -> fired in virtual order
 * plus GSAP's global timeline when the user loads GSAP.
 */
(function () {
  'use strict'

  var REAL = {
    now: performance.now.bind(performance),
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    dateNow: Date.now.bind(Date),
  }

  var EPOCH = REAL.dateNow()
  var vt = 0 // virtual time, ms since stage start
  var seq = 1
  var rafs = new Map() // id -> callback
  var timers = [] // { id, at, fn, args, interval }
  var birth = new WeakMap() // Animation -> virtual time it first appeared
  var playing = false
  var lastReal = 0
  var duration = 3000
  var fps = 30

  /* ------------------------------------------------------------ clock shims */

  performance.now = function () {
    return vt
  }
  Date.now = function () {
    return EPOCH + vt
  }

  window.requestAnimationFrame = function (cb) {
    var id = seq++
    rafs.set(id, cb)
    return id
  }
  window.cancelAnimationFrame = function (id) {
    rafs.delete(id)
  }

  window.setTimeout = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2)
    var id = seq++
    timers.push({ id: id, at: vt + Math.max(0, ms || 0), fn: fn, args: args, interval: 0 })
    return id
  }
  window.setInterval = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2)
    var iv = Math.max(1, ms || 1)
    var id = seq++
    timers.push({ id: id, at: vt + iv, fn: fn, args: args, interval: iv })
    return id
  }
  function clear(id) {
    for (var i = 0; i < timers.length; i++) {
      if (timers[i].id === id) {
        timers.splice(i, 1)
        return
      }
    }
  }
  window.clearTimeout = clear
  window.clearInterval = clear

  /* --------------------------------------------------------------- stepping */

  function report(err) {
    try {
      parent.postMessage(
        { type: 'stage:error', message: String((err && err.message) || err), stack: err && err.stack },
        '*',
      )
    } catch (_) {}
  }

  function run(fn, args) {
    try {
      if (typeof fn === 'function') fn.apply(window, args)
      else if (typeof fn === 'string') (0, eval)(fn)
    } catch (err) {
      report(err)
    }
  }

  /** Advance the virtual clock to `to`, firing everything due along the way. */
  function step(to) {
    var guard = 0
    for (;;) {
      if (++guard > 5000) break // runaway setInterval protection
      var next = null
      for (var i = 0; i < timers.length; i++) {
        if (timers[i].at <= to && (next === null || timers[i].at < next.at)) next = timers[i]
      }
      if (!next) break

      vt = Math.max(vt, next.at)
      if (next.interval) next.at += next.interval
      else clear(next.id)
      run(next.fn, next.args)
    }

    vt = to

    // Snapshot before iterating: callbacks routinely re-register themselves.
    var batch = Array.from(rafs.values())
    rafs.clear()
    for (var j = 0; j < batch.length; j++) run(batch[j], [vt])
  }

  /**
   * Pin every declarative animation to `t`.
   *
   * Animations that only come into existence partway through (a class added at
   * t=1200, say) must be measured from their own birth, not from stage zero, or
   * they would be fast-forwarded the moment they appear.
   */
  function syncDeclarative(t) {
    var list
    try {
      list = document.getAnimations()
    } catch (_) {
      list = []
    }
    for (var i = 0; i < list.length; i++) {
      var a = list[i]
      if (!birth.has(a)) birth.set(a, t)
      try {
        a.pause()
        a.currentTime = Math.max(0, t - birth.get(a))
      } catch (_) {}
    }
    if (window.gsap && window.gsap.globalTimeline) {
      try {
        window.gsap.globalTimeline.pause()
        window.gsap.globalTimeline.time(t / 1000)
      } catch (_) {}
    }
  }

  /**
   * Let the new state take effect.
   *
   * `fast` skips waiting for a paint, which the exporter does not need: the
   * rasterizer reads computed styles, so a forced style+layout is sufficient
   * and saves ~30ms on every single frame.
   */
  function settle(fast) {
    return new Promise(function (res) {
      var done = false
      function finish() {
        if (done) return
        done = true
        // Forcing layout makes getComputedStyle reflect the seeked time even
        // when nothing is going to be painted.
        void document.body.offsetHeight
        res()
      }
      if (fast) return finish()
      REAL.raf(function () {
        REAL.raf(finish)
      })
      // A hidden or throttled tab never fires rAF at all. Without this fallback
      // an export the user tabbed away from would hang forever.
      REAL.setTimeout(finish, 60)
    })
  }

  /* ------------------------------------------------------------- public API */

  async function seek(t, opts) {
    t = Math.max(0, t)
    if (t < vt) {
      // The virtual clock only runs forward — imperative code cannot be
      // un-executed. The host reloads the frame to scrub backwards.
      return { rewound: true, time: vt }
    }
    var stepMs = 1000 / Math.max(1, fps)
    while (vt + stepMs <= t) step(vt + stepMs)
    if (vt < t) step(t)
    syncDeclarative(t)
    await settle(opts && opts.fast)
    return { rewound: false, time: vt }
  }

  function play() {
    if (playing) return
    playing = true
    lastReal = REAL.now()
    ;(function tick() {
      if (!playing) return
      var n = REAL.now()
      var dt = Math.min(100, n - lastReal) // clamp after a tab stall
      lastReal = n
      var target = vt + dt
      if (target >= duration) {
        step(duration)
        syncDeclarative(duration)
        playing = false
        post('stage:ended', { time: duration })
        return
      }
      step(target)
      syncDeclarative(target)
      post('stage:time', { time: vt })
      REAL.raf(tick)
    })()
  }

  function pause() {
    playing = false
  }

  function post(type, data) {
    try {
      parent.postMessage(Object.assign({ type: type }, data), '*')
    } catch (_) {}
  }

  window.onerror = function (msg, src, line, col, err) {
    report(err || msg + ' (line ' + line + ')')
    return false
  }
  window.addEventListener('unhandledrejection', function (e) {
    report(e.reason)
  })

  /** A short, human-readable name for an animation's target. */
  function describeTarget(el) {
    if (!el || !el.tagName) return 'element'
    var raw = (el.getAttribute && el.getAttribute('class')) || ''
    var cls = raw.trim().split(/\s+/).filter(function (c) {
      return c && c.indexOf('__pe') !== 0 // skip rasterizer-generated classes
    })
    if (cls.length) return '.' + cls[0]
    if (el.id) return '#' + el.id
    return el.tagName.toLowerCase()
  }

  /**
   * Every animation currently known to the document, with its position on the
   * stage clock. Animations created partway through are measured from when they
   * first appeared, matching how syncDeclarative drives them.
   */
  function animations() {
    var out = []
    var list
    try {
      list = document.getAnimations()
    } catch (_) {
      return out
    }
    for (var i = 0; i < list.length; i++) {
      var a = list[i]
      var born = birth.has(a) ? birth.get(a) : 0
      var t = {}
      var target = null
      try {
        t = a.effect.getComputedTiming()
        target = a.effect.target
      } catch (_) {}

      var delay = t.delay || 0
      var end = t.endTime
      if (end == null || !isFinite(end)) end = delay + (t.duration || 0)

      out.push({
        index: i,
        name: a.animationName || a.transitionProperty || 'animation',
        label: describeTarget(target),
        start: born + delay,
        end: born + end,
      })
    }
    return out
  }

  var hlBox = null

  /** Remove any timeline hover outline. */
  function clearHighlight() {
    if (hlBox && hlBox.parentNode) hlBox.parentNode.removeChild(hlBox)
    hlBox = null
  }

  /**
   * Outline the element driven by animation `i`, so hovering a timeline bar
   * points at the thing it actually moves. The overlay carries a data flag the
   * rasterizer skips, so it can never leak into an export.
   */
  function highlight(i) {
    clearHighlight()
    var list
    try {
      list = document.getAnimations()
    } catch (_) {
      return
    }
    var a = list[i]
    var el = a && a.effect && a.effect.target
    if (!el || !el.getBoundingClientRect) return

    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return

    var box = document.createElement('div')
    box.setAttribute('data-stage-highlight', '1')
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;' +
      'border:2px solid #5b9cff;background:rgba(91,156,255,.13);border-radius:3px;' +
      'left:' + r.left + 'px;top:' + r.top + 'px;' +
      'width:' + r.width + 'px;height:' + r.height + 'px;'
    document.body.appendChild(box)
    hlBox = box
  }

  window.__stage = {
    animations: animations,
    highlight: highlight,
    clearHighlight: clearHighlight,
    seek: seek,
    play: play,
    pause: pause,
    get time() {
      return vt
    },
    get playing() {
      return playing
    },
    configure: function (opts) {
      if (opts && typeof opts.duration === 'number') duration = opts.duration
      if (opts && typeof opts.fps === 'number') fps = opts.fps
    },
    /** Fonts and images must be decoded before the first frame is rasterized. */
    ready: async function () {
      try {
        await document.fonts.ready
      } catch (_) {}
      var imgs = Array.from(document.images).map(function (img) {
        if (img.complete) return Promise.resolve()
        return new Promise(function (res) {
          img.addEventListener('load', res, { once: true })
          img.addEventListener('error', res, { once: true })
        })
      })
      await Promise.all(imgs)
      await settle()
      return true
    },
  }

  // Freeze at frame zero as soon as the document is parsed, so nothing plays
  // ahead of the host's first seek.
  function init() {
    syncDeclarative(0)
    post('stage:ready', {})
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
