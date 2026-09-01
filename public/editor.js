/**
 * A small syntax-highlighting code editor.
 *
 * A transparent <textarea> sits over a highlighted <pre>, which is offset by the
 * textarea's own scroll position. The textarea keeps all native behaviour —
 * caret, selection, undo, IME, spellcheck — and we only paint colour behind it.
 *
 * Deliberately dependency-free: a CDN editor would make the whole tool stop
 * working offline, which is exactly when you want a local video editor.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c])

/* --------------------------------------------------------------- tokenizers */

const JS_KEYWORDS =
  /\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|switch|case|default|await|async|yield|delete|void|export|import|from)\b/y

const RULES = {
  css: [
    ['comment', /\/\*[\s\S]*?\*\//y],
    ['string', /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y],
    ['at', /@[\w-]+/y],
    ['color', /#[0-9a-fA-F]{3,8}\b/y],
    ['var', /--[\w-]+/y],
    ['num', /-?\d*\.?\d+(?:px|em|rem|%|s|ms|deg|turn|vh|vw|vmin|vmax|fr|ch|ex)?\b/y],
    ['prop', /[-a-z]+(?=\s*:)/y],
    ['func', /[\w-]+(?=\()/y],
    ['sel', /[.#][\w-]+|::?[a-z-]+/y],
    ['punct', /[{}();:,>~+*]/y],
  ],
  js: [
    ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ['string', /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y],
    ['kw', JS_KEYWORDS],
    ['bool', /\b(?:true|false|null|undefined|NaN|Infinity)\b/y],
    ['num', /\b\d*\.?\d+\b/y],
    ['func', /[A-Za-z_$][\w$]*(?=\s*\()/y],
    ['punct', /[{}()[\];,.]/y],
  ],
  html: [
    ['comment', /<!--[\s\S]*?-->/y],
    ['doctype', /<!doctype[^>]*>/iy],
    ['tag', /<\/?[a-zA-Z][\w-]*/y],
    ['attr', /[a-zA-Z-]+(?=\s*=)/y],
    ['string', /"(?:[^"]*)"|'(?:[^']*)'/y],
    ['punct', /\/?>/y],
  ],
}

/** Scan with sticky regexes; anything unmatched is consumed one char at a time. */
export function highlight(code, lang) {
  const rules = RULES[lang] ?? RULES.html
  let i = 0
  let plain = ''
  let out = ''

  const flush = () => {
    if (plain) {
      out += esc(plain)
      plain = ''
    }
  }

  while (i < code.length) {
    let hit = null
    for (const [type, re] of rules) {
      re.lastIndex = i
      const m = re.exec(code)
      if (m && m.index === i && m[0].length) {
        hit = [type, m[0]]
        break
      }
    }
    if (hit) {
      flush()
      out += `<span class="t-${hit[0]}">${esc(hit[1])}</span>`
      i += hit[1].length
    } else {
      plain += code[i]
      i++
    }
  }
  flush()
  return out
}

/* ------------------------------------------------------------------ editor */

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }

export function attachEditor(textarea, lang) {
  const host = document.createElement('div')
  host.className = 'code-edit'
  host.dataset.pane = lang

  const gutter = document.createElement('div')
  gutter.className = 'gutter'

  const field = document.createElement('div')
  field.className = 'field'

  const pre = document.createElement('pre')
  pre.className = 'hl'
  pre.setAttribute('aria-hidden', 'true')
  const code = document.createElement('code')
  pre.appendChild(code)

  textarea.parentNode.insertBefore(host, textarea)
  field.appendChild(pre)
  field.appendChild(textarea)
  host.appendChild(gutter)
  host.appendChild(field)

  let lineCount = -1

  function paint() {
    const value = textarea.value
    code.innerHTML = highlight(value, lang) + '\n'

    const lines = value.split('\n').length
    if (lines !== lineCount) {
      lineCount = lines
      let g = ''
      for (let n = 1; n <= lines; n++) g += `<i>${n}</i>`
      gutter.innerHTML = g
    }
    markActiveLine()
  }

  function markActiveLine() {
    const upto = textarea.value.slice(0, textarea.selectionStart)
    const line = upto.split('\n').length
    const prev = gutter.querySelector('i.on')
    if (prev) prev.classList.remove('on')
    gutter.children[line - 1]?.classList.add('on')
  }

  function syncScroll() {
    pre.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`
    gutter.scrollTop = textarea.scrollTop
  }

  textarea.addEventListener('input', () => {
    paint()
    syncScroll()
  })
  textarea.addEventListener('scroll', syncScroll)
  for (const ev of ['click', 'keyup', 'focus']) textarea.addEventListener(ev, markActiveLine)

  textarea.addEventListener('keydown', (e) => {
    const s = textarea.selectionStart
    const t = textarea.selectionEnd

    if (e.key === 'Tab') {
      e.preventDefault()
      textarea.setRangeText('  ', s, t, 'end')
      textarea.dispatchEvent(new Event('input'))
      return
    }

    // Wrap a selection, or auto-close an empty pair.
    if (PAIRS[e.key]) {
      const close = PAIRS[e.key]
      if (s !== t) {
        e.preventDefault()
        const picked = textarea.value.slice(s, t)
        textarea.setRangeText(e.key + picked + close, s, t, 'select')
        textarea.dispatchEvent(new Event('input'))
        return
      }
      if (e.key === '{' || e.key === '(' || e.key === '[') {
        e.preventDefault()
        textarea.setRangeText(e.key + close, s, t, 'end')
        textarea.selectionStart = textarea.selectionEnd = s + 1
        textarea.dispatchEvent(new Event('input'))
        return
      }
    }

    // Typing the closing half of a pair just steps over it.
    if ([')', ']', '}'].includes(e.key) && textarea.value[s] === e.key && s === t) {
      e.preventDefault()
      textarea.selectionStart = textarea.selectionEnd = s + 1
      markActiveLine()
      return
    }

    // Enter inside {} opens an indented block.
    if (e.key === 'Enter' && s === t) {
      const before = textarea.value.slice(0, s)
      const lineStart = before.lastIndexOf('\n') + 1
      const indent = (before.slice(lineStart).match(/^[ \t]*/) ?? [''])[0]
      const opensBlock = /[{([]$/.test(before.trimEnd()) && /^[)\]}]/.test(textarea.value.slice(s).trimStart())
      e.preventDefault()
      if (opensBlock) {
        textarea.setRangeText(`\n${indent}  \n${indent}`, s, t, 'end')
        textarea.selectionStart = textarea.selectionEnd = s + 1 + indent.length + 2
      } else {
        const extra = /[{([]$/.test(before.trimEnd()) ? '  ' : ''
        textarea.setRangeText(`\n${indent}${extra}`, s, t, 'end')
      }
      textarea.dispatchEvent(new Event('input'))
    }
  })

  paint()
  return { paint, host }
}
