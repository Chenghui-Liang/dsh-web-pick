/**
 * dsh-web-pick — the in-page overlay.
 *
 * Injected into every page the built-in browser opens (the Client half does the
 * injecting). Self-contained IIFE: no imports, one namespaced global, safe to
 * re-run on every navigation because `boot()` takes over an existing copy.
 *
 * UX in one sentence: one ⌖ icon at the top-right of the page turns the
 * pointer into a picker — click an element, or drag a rectangle to frame a
 * region; both open a small comment card on the spot; every pick lands in a
 * per-page list, and 「发送到对话」 hands the batch to the GUI, which posts it as
 * one message into the conversation the user is reading.
 */
;(() => {
  const VERSION = '1.1.0'
  const NS = 'dsh-web-pick'
  const ROOT_ATTR = 'data-dsh-webpick-root'
  const MAX_TEXT = 90
  const DRAG_THRESHOLD = 5

  if (window.__dshWebPick && window.__dshWebPick.version === VERSION) {
    return
  }

  /* ------------------------------------------------------------- utilities */

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)

  const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  function textOf(node) {
    if (!node) return ''
    const raw = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') || node.textContent || '' : ''
    const flat = String(raw).replace(/\s+/gu, ' ').trim()
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat
  }

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/gu, (char) => `\\${char}`)
  }

  /** A short, human-checkable selector: `#id`, `.a.b`, or `tag:nth-of-type`. */
  function selectorOf(element) {
    if (!element || element.nodeType !== 1) return ''
    if (element.id) return `#${escapeIdent(element.id)}`
    const parts = []
    let node = element
    let depth = 0
    while (node && node.nodeType === 1 && depth < 4) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      if (node.id) {
        parts.unshift(`#${escapeIdent(node.id)}`)
        break
      }
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id')
      if (testId) {
        parts.unshift(`${tag}[data-testid="${testId}"]`)
        break
      }
      const classes = Array.from(node.classList || [])
        .filter((name) => name && !/^(is-|has-)|^js-/u.test(name))
        .slice(0, 2)
        .map((name) => `.${escapeIdent(name)}`)
        .join('')
      let part = `${tag}${classes}`
      const parent = node.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
      }
      parts.unshift(part)
      node = parent
      depth += 1
    }
    return parts.join(' > ') || element.tagName.toLowerCase()
  }

  function fiberOf(element) {
    try {
      for (const key in element) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return element[key]
      }
    } catch {
      /* framework internals are a bonus, never a requirement */
    }
    return null
  }

  /** Best-effort component name for React / Vue front-ends. */
  function componentOf(element) {
    try {
      let fiber = fiberOf(element)
      for (let depth = 0; fiber && depth < 24; depth += 1) {
        const type = fiber.elementType || fiber.type
        const name =
          typeof type === 'function'
            ? type.displayName || type.name
            : typeof type === 'string'
              ? ''
              : type && (type.displayName || type.name)
        if (name && /^[A-Z]/u.test(name)) return name
        fiber = fiber.return
      }
      const vue = element.__vueParentComponent || element.__vueParentInstance
      return (vue && vue.type && (vue.type.__name || vue.type.name)) || ''
    } catch {
      /* the page's framework internals are a bonus, never a requirement */
    }
    return ''
  }

  /** The component nesting that owns the element, outermost first. */
  function componentChain(element) {
    const names = []
    try {
      let node = fiberOf(element)
      for (let depth = 0; node && depth < 28; depth += 1) {
        const type = node.elementType || node.type
        const name = typeof type === 'function' ? type.displayName || type.name : type && (type.displayName || type.name)
        if (name && /^[A-Z]/u.test(name) && !names.includes(name)) names.push(name)
        if (names.length >= 4) break
        node = node.return
      }
    } catch {
      /* ignore */
    }
    return names.reverse().join(' > ')
  }

  /**
   * React 18/19 dev builds and Vue keep the JSX / SFC that rendered an element;
   * `file:line` lets the agent open the exact source instead of guessing.
   */
  function sourceOf(element) {
    try {
      let node = fiberOf(element)
      for (let depth = 0; node && depth < 32; depth += 1) {
        const direct = node._debugSource
        if (direct && typeof direct.fileName === 'string' && direct.fileName) {
          return `${direct.fileName}:${direct.lineNumber || 0}`
        }
        const info = node._debugInfo
        if (Array.isArray(info)) {
          for (const entry of info) {
            if (entry && typeof entry.fileName === 'string' && entry.fileName) {
              return `${entry.fileName}:${entry.lineNumber || 0}`
            }
          }
        }
        node = node.return
      }
      const vue = element.__vueParentComponent || element.__vueParentInstance
      const file = vue && vue.type && vue.type.__file
      if (typeof file === 'string' && file) return file
    } catch {
      /* production builds strip this; the selector stays the fallback */
    }
    return ''
  }

  function cssOf(element) {
    try {
      const style = window.getComputedStyle(element)
      return {
        display: style.display,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      }
    } catch {
      return null
    }
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      docY: Math.round(rect.top + window.scrollY),
    }
  }

  function describeElement(element, extra) {
    return {
      kind: 'element',
      id: newId(),
      selector: selectorOf(element),
      tag: element.tagName.toLowerCase(),
      component: componentOf(element),
      components: componentChain(element),
      source: sourceOf(element),
      text: textOf(element),
      comment: '',
      css: cssOf(element),
      rect: rectOf(element),
      scrollY: Math.round(window.scrollY),
      at: Date.now(),
      url: location.href,
      ...(extra || {}),
    }
  }

  /* ------------------------------------------------------------------ state */

  const state = {
    mode: '', // '' | 'pick'
    hover: null,
    press: null,
    items: [],
    listOpen: false,
    draft: null,
    editing: false,
  }

  const storeKey = () => `${NS}:${location.origin}${location.pathname}`

  function persist() {
    try {
      sessionStorage.setItem(storeKey(), JSON.stringify(state.items.map(plainItem)))
    } catch {
      /* private-mode quota is not worth a broken overlay */
    }
  }

  function plainItem(item) {
    return {
      kind: item.kind,
      id: item.id,
      selector: item.selector,
      tag: item.tag,
      component: item.component,
      components: item.components,
      source: item.source,
      text: item.text,
      comment: item.comment,
      css: item.css,
      rect: item.rect || null,
      scrollY: item.scrollY || 0,
      at: item.at,
      url: item.url,
    }
  }

  function restore() {
    let raw = ''
    try {
      raw = sessionStorage.getItem(storeKey()) || ''
    } catch {
      return
    }
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        state.items = parsed.filter(
          (item) => item && item.id && (item.kind === 'element' || item.kind === 'region'),
        )
      }
    } catch {
      /* a corrupt key only loses the draft */
    }
  }

  /* ------------------------------------------------------------------- view */

  let uiHost = null
  let shadow = null
  let layer = null
  let dock = null
  let pickIcon = null
  let countButton = null
  let hoverBox = null
  let dragBox = null
  let composer = null
  let listPanel = null
  let toastNode = null

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      font: 12px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #1f2328;
      -webkit-font-smoothing: antialiased;
      pointer-events: none;
    }
    .pill, .card, .list, .countbtn { pointer-events: auto; }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
    .dock { position: fixed; right: 14px; bottom: 14px; z-index: 3; display: flex; align-items: center; gap: 6px; width: max-content; }
    .pill {
      display: flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px;
      border-radius: 13px; background: rgba(32, 36, 44, .82); color: #fff;
      box-shadow: 0 2px 10px rgba(0,0,0,.22); backdrop-filter: blur(7px);
      font-size: 11.5px; letter-spacing: .2px; user-select: none;
    }
    .pill:hover { background: rgba(32, 36, 44, .95); }
    .pill[data-on="true"] { background: #2f6feb; }
    .pill .glyph { font-size: 12px; line-height: 1; }
    .countbtn {
      display: inline-block; height: 26px; min-width: 26px; padding: 0 7px; border-radius: 13px;
      background: #2f6feb; color: #fff; font-size: 11.5px; line-height: 26px; text-align: center;
      font-variant-numeric: tabular-nums; box-shadow: 0 2px 10px rgba(0,0,0,.22);
    }
    .countbtn:hover { background: #2760d0; }
    .layer { position: fixed; inset: 0; z-index: 2; pointer-events: none; }
    .hoverbox { position: absolute; border: 1.5px solid #2f6feb; border-radius: 3px; background: rgba(47,111,235,.10); }
    .dragbox { position: absolute; border: 1.5px dashed #2f6feb; border-radius: 3px; background: rgba(47,111,235,.14); }
    .hovertag {
      position: absolute; left: 0; top: 0; transform: translateY(-100%);
      max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 2px 6px; border-radius: 3px 3px 0 0; background: #2f6feb; color: #fff; font-size: 10.5px;
    }
    .mark {
      position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px;
      border-radius: 50%; background: #2f6feb; color: #fff; font-size: 10px; line-height: 18px;
      text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.3); pointer-events: auto; cursor: pointer;
      border: 1.5px solid #fff;
    }
    .mark.flash { animation: dash .7s ease-out 2; }
    .regionbox { position: absolute; border: 1.5px dotted #2f6feb; border-radius: 3px; background: rgba(47,111,235,.06); }
    @keyframes dash { 50% { box-shadow: 0 0 0 5px rgba(47,111,235,.35); } }

    .card {
      position: fixed; z-index: 5; width: 320px; padding: 9px 10px;
      border-radius: 8px; background: #fff; border: 1px solid #d8dde5;
      box-shadow: 0 8px 26px rgba(20,26,36,.18);
    }
    .card .head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .card .where { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #57606a; font-size: 11px; }
    .card .where b { color: #1f2328; font-weight: 600; }
    .card .tag { flex: none; padding: 0 5px; height: 16px; line-height: 16px; border-radius: 8px; background: rgba(47,111,235,.10); color: #2f6feb; font-size: 10px; }
    .x { width: 18px; height: 18px; border-radius: 4px; color: #6e7781; font-size: 13px; line-height: 16px; text-align: center; }
    .x:hover { background: #f1f3f6; color: #1f2328; }
    textarea {
      width: 100%; height: 58px; resize: vertical; padding: 6px 7px; font: inherit; font-size: 12px;
      color: #1f2328; border: 1px solid #d8dde5; border-radius: 6px; outline: none; background: #fff;
    }
    textarea:focus { border-color: #2f6feb; box-shadow: 0 0 0 3px rgba(47,111,235,.13); }
    .actions { display: flex; align-items: center; gap: 6px; }
    .hint { flex: 1; color: #8a939d; font-size: 10.5px; }
    .btn { flex: none; white-space: nowrap; height: 24px; padding: 0 10px; border-radius: 6px; border: 1px solid #d8dde5; color: #1f2328; font-size: 11.5px; }
    .btn:hover { background: #f6f8fa; }
    .btn.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
    .btn.primary:hover { background: #2760d0; }
    .btn.ghost { border-color: transparent; color: #6e7781; }

    .list {
      position: fixed; right: 14px; bottom: 46px; z-index: 4; width: min(292px, calc(100vw - 28px));
      max-height: min(46vh, 400px); display: flex; flex-direction: column; border-radius: 9px; background: #fff;
      border: 1px solid #d8dde5; box-shadow: 0 10px 30px rgba(20,26,36,.18); overflow: hidden;
    }
    .list > header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid #eef1f5; background: #fbfcfd; }
    .list > header .title { flex: 1; font-size: 11.5px; font-weight: 600; }
    .rows { overflow: auto; }
    .row { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid #f2f4f7; }
    .row:last-child { border-bottom: 0; }
    .row:hover { background: #fbfcfd; }
    .row .num { flex: none; width: 15px; height: 15px; margin-top: 1px; border-radius: 50%; background: #2f6feb; color: #fff; font-size: 9px; line-height: 15px; text-align: center; }
    .row .body { flex: 1; min-width: 0; cursor: pointer; }
    .row .top { display: flex; align-items: center; gap: 5px; min-width: 0; }
    .row .kindchip { flex: none; padding: 0 5px; height: 15px; line-height: 15px; border-radius: 7px; font-size: 9.5px; background: #eef2fb; color: #2f6feb; }
    .row .kindchip[data-kind="region"] { background: #eef7f0; color: #1f7a4d; }
    .row .sel { flex: 1; min-width: 0; color: #6e7781; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .row .sel:hover { color: #2f6feb; text-decoration: underline; }
    .row .comment {
      margin-top: 1px; font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .row .comment[data-empty="true"] { color: #a0a8b2; font-style: italic; }
    .row .tools { display: flex; flex-direction: column; gap: 2px; }
    .row .tools button { width: 18px; height: 18px; border-radius: 4px; color: #8a939d; font-size: 11px; }
    .row .tools button:hover { background: #f1f3f6; color: #1f2328; }
    .list > footer { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid #eef1f5; background: #fbfcfd; }
    .list > footer .url { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8a939d; font-size: 10.5px; }
    .list > footer .spacer { flex: 1; min-width: 8px; }
    .empty { padding: 16px 9px; color: #8a939d; font-size: 11.5px; text-align: center; }

    .toast {
      position: fixed; right: 14px; bottom: 48px; z-index: 6; max-width: 300px;
      padding: 6px 10px; border-radius: 6px; background: rgba(32,36,44,.92); color: #fff; font-size: 11.5px;
    }
    .toast[data-tone="ok"] { background: #1f7a4d; }
    .toast[data-tone="warn"] { background: #a25b00; }
  `

  function h(tag, props, ...children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'style') node.setAttribute('style', value)
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return node
  }

  const isOwn = (node) => {
    if (!uiHost || !node) return false
    return uiHost === node || (node.nodeType === 1 && uiHost.contains(node)) || (uiHost.getRootNode && uiHost.getRootNode() === node)
  }

  function mountUi() {
    if (uiHost) return
    uiHost = document.createElement('div')
    uiHost.setAttribute(ROOT_ATTR, 'root')
    // Fixed full-viewport host at the top of the stacking order: pages routinely
    // pin their own sidebar at 9999, and anything lower would let it paint over
    // our card. The host is inert; interactive surfaces opt back in.
    uiHost.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible'
    shadow = uiHost.attachShadow({ mode: 'open' })
    shadow.append(h('style', { text: CSS }))
    const wrap = h('div', { class: 'wrap' })
    shadow.append(wrap)

    layer = h('div', { class: 'layer' })
    hoverBox = h('div', { class: 'hoverbox', style: 'display:none' })
    dragBox = h('div', { class: 'dragbox', style: 'display:none' })
    layer.append(dragBox, hoverBox)

    pickIcon = h(
      'button',
      {
        class: 'pill',
        title: '选取：点元素，或按住拖动框选一块区域（Esc 退出）',
        'data-on': 'false',
        onclick: () => setMode(state.mode ? '' : 'pick'),
      },
      h('span', { class: 'glyph', text: '⌖' }),
      h('span', { class: 'label', text: '选取' }),
    )
    countButton = h('button', {
      class: 'countbtn',
      style: 'display:none',
      title: '查看本页选取，确认后一次性发送到对话',
      onclick: () => (state.listOpen ? closeList() : openList()),
    })

    dock = h('div', { class: 'dock' })
    dock.append(pickIcon, countButton)

    wrap.append(layer, dock)
    document.documentElement.append(uiHost)
    renderPill()
  }

  function renderPill() {
    if (!pickIcon) return
    pickIcon.setAttribute('data-on', state.mode ? 'true' : 'false')
    pickIcon.title = state.mode
      ? '选取中：点元素或拖动框选（Esc 退出）'
      : '选取：点元素，或按住拖动框选一块区域'
    const label = pickIcon.querySelector('.label')
    if (label) label.textContent = state.mode ? '选取中' : '选取'
    const total = state.items.length
    countButton.style.display = total ? '' : 'none'
    countButton.textContent = String(total)
    countButton.title = `查看 ${total} 条选取，确认后一次性发送到对话`
  }

  function showToast(message, tone = 'ok', ttl = 2200) {
    if (!shadow) return
    if (toastNode) toastNode.remove()
    toastNode = h('div', { class: 'toast', 'data-tone': tone, text: message })
    shadow.querySelector('.wrap').append(toastNode)
    setTimeout(() => {
      if (toastNode) {
        toastNode.remove()
        toastNode = null
      }
    }, ttl)
  }

  /* ------------------------------------------------------------ interaction */

  function setMode(next) {
    state.mode = next
    state.press = null
    hideBox()
    if (!next) hideHover()
    closeComposer()
    try {
      document.documentElement.style.cursor = next ? 'crosshair' : ''
    } catch {
      /* cursor is cosmetic */
    }
    renderPill()
  }

  function hideHover() {
    if (hoverBox) hoverBox.style.display = 'none'
    state.hover = null
  }

  function hideBox() {
    if (dragBox) dragBox.style.display = 'none'
  }

  /** Keep the picked frame on screen while its comment card is open. */
  function showBox(rect) {
    if (!dragBox || !rect) return
    dragBox.style.cssText = `display:block;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`
  }

  /** Same for an element pick: outline + its size label, held still. */
  function showHoverBox(rect, label) {
    if (!hoverBox || !rect) return
    hoverBox.style.cssText = `display:block;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`
    let tag = hoverBox.querySelector('.hovertag')
    if (!tag) {
      tag = h('span', { class: 'hovertag' })
      hoverBox.append(tag)
    }
    tag.textContent = label || ''
  }

  function showHover(target) {
    if (!hoverBox || !target || target.nodeType !== 1) return
    if (state.hover === target) return
    state.hover = target
    const rect = target.getBoundingClientRect()
    hoverBox.style.cssText = `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
    let tag = hoverBox.querySelector('.hovertag')
    if (!tag) {
      tag = h('span', { class: 'hovertag' })
      hoverBox.append(tag)
    }
    const css = cssOf(target)
    const tagName = target.tagName.toLowerCase()
    const parts = [tagName, `${Math.round(rect.width)}×${Math.round(rect.height)}`]
    if (css && css.color) parts.push(css.color)
    if (css && css.fontSize) parts.push(css.fontSize)
    tag.textContent = parts.join(' · ')
  }

  function drawBox(x0, y0, x1, y1) {
    if (!dragBox) return
    const left = Math.min(x0, x1)
    const top = Math.min(y0, y1)
    const width = Math.abs(x1 - x0)
    const height = Math.abs(y1 - y0)
    dragBox.style.cssText = `display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px`
  }

  function onMouseDown(event) {
    if (!state.mode) return
    if (isOwn(event.target)) return
    if (state.draft) {
      closeComposer()
      return
    }
    if (event.button !== 0) return
    // Pick mode owns the pointer: no text selection, no link drag, no page
    // scrollbar grabs from a mis-click.
    event.preventDefault()
    state.press = { x: event.clientX, y: event.clientY, target: event.target, moved: false }
  }

  function onMouseMove(event) {
    if (!state.mode || state.draft) return
    const press = state.press
    if (press) {
      const distance = Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y)
      if (!press.moved && distance >= DRAG_THRESHOLD) press.moved = true
      if (press.moved) {
        hideHover()
        drawBox(press.x, press.y, event.clientX, event.clientY)
        return
      }
    }
    if (!event.target || isOwn(event.target) || event.target === document.documentElement) {
      hideHover()
      return
    }
    showHover(event.target)
  }

  function onMouseUp(event) {
    if (!state.mode || state.draft) return
    const press = state.press
    state.press = null
    if (!press) return
    if (press.moved) {
      const rect = {
        x: Math.round(Math.min(press.x, event.clientX)),
        y: Math.round(Math.min(press.y, event.clientY)),
        w: Math.round(Math.abs(event.clientX - press.x)),
        h: Math.round(Math.abs(event.clientY - press.y)),
      }
      if (rect.w < 8 || rect.h < 8) {
        hideBox()
        return
      }
      // A frame selection opens the same comment card the element pick uses, so
      // the note can be written right there instead of only at send time. The
      // frame itself stays on screen under the card so the note has context.
      openComposer(buildRegionDraft(rect), null)
      return
    }
    const target = press.target
    if (!target || target.nodeType !== 1 || isOwn(target)) return
    openComposer(describeElement(target), null)
  }

  /** Pick mode swallows the click that follows a pointer-down, so links stay cold. */
  function onClickCapture(event) {
    if (!state.mode) return
    if (isOwn(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return
    if (state.draft) {
      closeComposer()
      event.preventDefault()
      return
    }
    if (state.mode) {
      setMode('')
      event.preventDefault()
    }
  }

  function buildRegionDraft(rect) {
    return {
      kind: 'region',
      id: newId(),
      selector: '',
      tag: 'region',
      component: '',
      components: '',
      source: '',
      text: `${rect.w}×${rect.h}`,
      comment: '',
      css: null,
      rect: { ...rect, docY: rect.y + Math.round(window.scrollY) },
      scrollY: Math.round(window.scrollY),
      at: Date.now(),
      url: location.href,
    }
  }

  /* ---------------------------------------------------------------- composer */

  function whereOf(draft) {
    if (draft.kind === 'region') {
      const rect = draft.rect || {}
      return `区域 ${rect.w || 0}×${rect.h || 0}`
    }
    return `${draft.tag}${draft.component ? ` · ${draft.component}` : ''}${draft.selector ? ` · ${draft.selector}` : ''}`
  }

  /**
   * `draft` is a fresh pick (element or region); `existing` re-opens a saved
   * row for editing. The card is placed just under the picked box when one is
   * known, so a frame selection is commented on right where it was drawn.
   */
  function openComposer(draft, existing) {
    closeComposer()
    state.draft = existing ? { ...existing } : { ...(draft || {}) }
    state.draft.comment = state.draft.comment || ''
    state.editing = Boolean(existing)
    const width = 320
    const box = boxOf(state.draft)
    if (state.draft.kind === 'region') {
      if (box) showBox(box)
    } else if (box) {
      // Keep the element's highlight on screen under the card, so the note is
      // written with the target still framed.
      showHoverBox(box, `${state.draft.tag || 'element'} · ${box.w}×${box.h}`)
    }
    let left
    let top
    if (box) {
      left = clamp(box.x, 8, window.innerWidth - width - 8)
      top =
        box.y + box.h + 8 + 200 < window.innerHeight
          ? box.y + box.h + 8
          : clamp(box.y - 200, 8, window.innerHeight - 214)
    } else {
      left = clamp((window.innerWidth - width) / 2, 8, window.innerWidth - width - 8)
      top = clamp(window.innerHeight / 2 - 110, 8, window.innerHeight - 230)
    }

    const textarea = h('textarea', {
      placeholder:
        state.draft.kind === 'region'
          ? '这块要改什么？（可留空，Ctrl+Enter 保存，Esc 取消）'
          : '补充一句说明（可以留空，Ctrl+Enter 保存，Esc 取消）',
      onkeydown: (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          saveDraft()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeComposer()
        }
      },
    })
    textarea.value = state.draft.comment || ''
    const head = h(
      'div',
      { class: 'head' },
      h('div', { class: 'where', text: whereOf(state.draft) }),
      existing ? h('span', { class: 'tag', text: '编辑' }) : null,
      h('button', { class: 'x', title: '取消（Esc）', text: '✕', onclick: () => closeComposer() }),
    )
    const hintText = existing
      ? '编辑中'
      : state.draft.kind === 'element' && state.draft.text
        ? `「${state.draft.text.slice(0, 16)}」`
        : ''
    const actions = h(
      'div',
      { class: 'actions' },
      h('span', { class: 'hint', text: hintText }),
      h('button', { class: 'btn ghost', text: '取消', onclick: () => closeComposer() }),
      h('button', { class: 'btn primary', text: '保存', onclick: () => saveDraft() }),
    )
    composer = h(
      'div',
      { class: 'card', style: `left:${left}px;top:${top}px` },
      head,
      textarea,
      actions,
    )
    shadow.querySelector('.wrap').append(composer)
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }

  function closeComposer() {
    if (composer) {
      composer.remove()
      composer = null
    }
    hideBox()
    hideHover()
    state.draft = null
    state.editing = false
  }

  function saveDraft() {
    if (!state.draft || !composer) return
    const textarea = composer.querySelector('textarea')
    const comment = textarea ? textarea.value.trim() : ''
    const wasEditing = state.editing
    const item = { ...state.draft, comment }
    const index = state.items.findIndex((entry) => entry.id === item.id)
    if (index >= 0) state.items[index] = item
    else state.items.push(item)
    persist()
    closeComposer()
    renderMarks()
    renderPill()
    renderList()
    showToast(
      wasEditing ? '已更新这条选取' : `已记下第 ${state.items.length} 条，点右上角数字统一发送`,
      'ok',
      wasEditing ? 1600 : 2400,
    )
  }

  function editItem(item) {
    if (!item) return
    openComposer(null, item)
  }

  function removeItem(id) {
    state.items = state.items.filter((item) => item.id !== id)
    persist()
    renderMarks()
    renderPill()
    renderList()
  }

  /* ------------------------------------------------------------ markers/pins */

  function elementFor(item) {
    if (!item || item.kind === 'region' || !item.selector) return null
    try {
      return document.querySelector(item.selector)
    } catch {
      return null
    }
  }

  /** Viewport-space box for one item, live when the element still exists. */
  function boxOf(item) {
    if (item.kind === 'region') {
      const rect = item.rect
      if (!rect) return null
      const scrollY = window.scrollY
      const docY = Number.isFinite(rect.docY) ? rect.docY : rect.y + (item.scrollY || 0)
      return { x: rect.x, y: docY - scrollY, w: rect.w, h: rect.h }
    }
    const element = elementFor(item)
    if (element && element.isConnected) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    }
    const rect = item.rect
    if (!rect) return null
    const scrollY = window.scrollY
    const docY = Number.isFinite(rect.docY) ? rect.docY : rect.y + (item.scrollY || 0)
    return { x: rect.x, y: docY - scrollY, w: rect.w, h: rect.h }
  }

  const marks = new Map() // id → { badge, outline }

  function renderMarks() {
    if (!layer) return
    for (const [id, entry] of marks) {
      if (!state.items.some((item) => item.id === id)) {
        entry.badge.remove()
        if (entry.outline) entry.outline.remove()
        marks.delete(id)
      }
    }
    state.items.forEach((item, index) => {
      let entry = marks.get(item.id)
      if (!entry) {
        const badge = h('div', {
          class: 'mark',
          text: String(index + 1),
          onclick: (event) => {
            event.stopPropagation()
            event.preventDefault()
            flash(item)
          },
        })
        const outline = item.kind === 'region' ? h('div', { class: 'regionbox' }) : null
        if (outline) layer.append(outline)
        layer.append(badge)
        entry = { badge, outline }
        marks.set(item.id, entry)
      }
      entry.badge.textContent = String(index + 1)
      entry.badge.title = `${index + 1}. ${item.comment || item.selector || item.text}`
    })
    positionMarks()
  }

  function positionMarks() {
    state.items.forEach((item) => {
      const entry = marks.get(item.id)
      if (!entry) return
      const box = boxOf(item)
      if (!box) {
        entry.badge.style.display = 'none'
        if (entry.outline) entry.outline.style.display = 'none'
        return
      }
      entry.badge.style.display = ''
      entry.badge.style.left = `${box.x + box.w}px`
      entry.badge.style.top = `${box.y}px`
      if (entry.outline) {
        entry.outline.style.display = ''
        entry.outline.style.cssText = `display:block;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`
      }
    })
  }

  function scrollToItem(item) {
    const box = boxOf(item)
    if (!box) return false
    const element = elementFor(item)
    if (element && element.isConnected) {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return true
    }
    window.scrollTo({ top: Math.max(0, box.y + window.scrollY - window.innerHeight / 2), behavior: 'smooth' })
    return true
  }

  function flash(item) {
    if (!scrollToItem(item)) {
      showToast('这条的位置已经找不到了（页面可能变了）', 'warn')
      return
    }
    const entry = marks.get(item.id)
    if (entry && entry.badge) {
      entry.badge.classList.remove('flash')
      void entry.badge.offsetWidth
      entry.badge.classList.add('flash')
    }
  }

  /* ------------------------------------------------------------------- list */

  function openList() {
    state.listOpen = true
    renderList()
  }

  function closeList() {
    state.listOpen = false
    renderList()
  }

  const kindLabel = (kind) => (kind === 'region' ? '区域' : '元素')

  function labelOf(item) {
    if (item.kind === 'region') {
      const rect = item.rect || {}
      return `区域 ${rect.w || 0}×${rect.h || 0}`
    }
    return `${item.selector || item.tag}${item.component ? ` · ${item.component}` : ''}`
  }

  function renderList() {
    if (!shadow) return
    if (listPanel) {
      listPanel.remove()
      listPanel = null
    }
    if (!state.listOpen) return
    const rows = h('div', { class: 'rows' })
    if (!state.items.length) {
      rows.append(h('div', { class: 'empty', text: '还没有选取。点右下角「选取」，再点页面元素或按住拖出一块区域。' }))
    }
    state.items.forEach((item, index) => {
      rows.append(
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'num', text: String(index + 1) }),
          h(
            'div',
            { class: 'body', title: '点击补充/编辑说明', onclick: () => editItem(item) },
            h(
              'div',
              { class: 'top' },
              h('span', { class: 'kindchip', 'data-kind': item.kind, text: kindLabel(item.kind) }),
              h('div', {
                class: 'sel',
                title: '点一下定位到页面上的位置',
                text: labelOf(item),
                onclick: (event) => {
                  event.stopPropagation()
                  flash(item)
                },
              }),
            ),
            item.comment
              ? h('div', { class: 'comment', text: item.comment })
              : h('div', { class: 'comment', 'data-empty': 'true', text: '（无说明，点击补充）' }),
          ),
          h(
            'div',
            { class: 'tools' },
            h('button', { text: '✎', title: '编辑说明', onclick: () => editItem(item) }),
            h('button', { text: '✕', title: '删除这条', onclick: () => removeItem(item.id) }),
          ),
        ),
      )
    })
    const footer = h(
      'footer',
      null,
      h('span', { class: 'url', text: `${location.pathname}` }),
      h('span', { class: 'spacer' }),
      state.items.length ? h('button', { class: 'btn ghost', text: '清空', onclick: () => clearAll() }) : null,
      h('button', {
        class: 'btn primary',
        text: `发送到对话 (${state.items.length})`,
        style: state.items.length ? '' : 'opacity:.45;cursor:default',
        onclick: () => submitAll(),
      }),
    )
    listPanel = h(
      'div',
      { class: 'list' },
      h(
        'header',
        null,
        h('span', { class: 'title', text: `本页选取 ${state.items.length}` }),
        h('button', { class: 'x', title: '收起列表（选取会保留）', text: '✕', onclick: () => closeList() }),
      ),
      rows,
      footer,
    )
    shadow.querySelector('.wrap').append(listPanel)
  }

  function clearAll() {
    state.items = []
    persist()
    renderMarks()
    renderPill()
    renderList()
    showToast('已清空本页选取', 'ok', 1400)
  }

  /* ----------------------------------------------------------------- submit */

  function submitAll() {
    if (!state.items.length) return
    const payload = {
      type: 'submit',
      url: location.href,
      origin: location.origin,
      title: document.title,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollY: Math.round(window.scrollY),
        docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      },
      items: state.items.map((item, index) => {
        const box = boxOf(item)
        const rect = box
          ? {
              x: Math.round(box.x),
              y: Math.round(box.y),
              w: Math.round(box.w),
              h: Math.round(box.h),
              docY: Math.round(box.y + window.scrollY),
            }
          : null
        return {
          index: index + 1,
          kind: item.kind,
          selector: item.selector,
          tag: item.tag,
          component: item.component || '',
          components: item.components || '',
          source: item.source || '',
          text: item.text || '',
          css: item.css || null,
          comment: item.comment || '',
          rect,
        }
      }),
    }
    pushOutbox(payload)
    showToast(`正在发送 ${state.items.length} 条选取…`, 'ok', 2000)
    setMode('')
    closeList()
    renderPill()
  }

  /* ----------------------------------------------------------------- outbox */

  const outbox = []

  function pushOutbox(action) {
    outbox.push(action)
  }

  /** Called by the GUI half through `executeJavaScript`; drains the queue. */
  function takeOutbox() {
    if (!outbox.length) return []
    return outbox.splice(0, outbox.length)
  }

  /* -------------------------------------------------------------------- boot */

  function onScrollOrResize() {
    positionMarks()
    if (state.draft) {
      const box = boxOf(state.draft)
      if (box && state.draft.kind === 'region') showBox(box)
      else if (box) showHoverBox(box, `${state.draft.tag || 'element'} · ${box.w}×${box.h}`)
    }
    if (state.mode === 'pick' && state.hover && state.hover.isConnected) {
      const rect = state.hover.getBoundingClientRect()
      hoverBox.style.cssText = `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
    }
  }

  let rafPending = false
  function scheduleReposition() {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      onScrollOrResize()
    })
  }

  function boot() {
    const stale = document.documentElement.querySelector(`[${ROOT_ATTR}="root"]`)
    if (stale && stale !== uiHost) stale.remove()
    restore()
    mountUi()
    renderPill()
    renderMarks()
    renderList()
    // One ping per injection: the GUI half records it, so `webpick_status` can
    // prove the overlay actually booted instead of merely being handed to the
    // page.
    pushOutbox({
      type: 'ping',
      at: Date.now(),
      state: { version: VERSION, url: location.href, mode: state.mode, items: state.items.length, mounted: Boolean(uiHost) },
    })
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('click', onClickCapture, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('auxclick', onClickCapture, true)
    window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true })
    window.addEventListener('resize', scheduleReposition, { passive: true })
    try {
      new MutationObserver(scheduleReposition).observe(document.documentElement, { childList: true, subtree: true })
    } catch {
      /* repositioning also runs on scroll */
    }
  }

  /**
   * Called back by the GUI half once the chat accepted (or refused) a batch.
   * Until this lands the page only knows the batch left the page.
   */
  function notify(action) {
    if (!action || typeof action.ok !== 'boolean') return
    if (action.ok) {
      const images = Number(action.images) || 0
      state.items = []
      persist()
      renderMarks()
      renderPill()
      renderList()
      if (action.note) {
        showToast(String(action.note), 'warn', 4000)
        return
      }
      showToast(images > 0 ? `已发送（含 ${images} 张截图），切回对话即可看到` : '已发送，切回对话即可看到', 'ok', 2400)
      return
    }
    showToast(`发送失败：${action.error || '未知原因'}（选取还在列表里）`, 'warn', 4000)
  }

  window.__dshWebPick = {
    version: VERSION,
    boot,
    outbox: takeOutbox,
    notify,
    toggle: (mode) => setMode(mode ? 'pick' : ''),
    state: () => ({ mode: state.mode, count: state.items.length, listOpen: state.listOpen, url: location.href }),
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(), { once: true })
  } else {
    boot()
  }
})()
