/**
 * dsh-web-pick — Client half.
 *
 * Runs in the DSH GUI page, which is exactly where the built-in browser's
 * `<webview>` elements live. That is the whole trick: no proxy, no CDP, no
 * project change — the GUI hands a page's `<webview>` our overlay through
 * `webview.executeJavaScript()`, and reads the overlay's outbox the same way.
 *
 * Flow: watch for `<webview>` elements → inject the overlay on every
 * `dom-ready` → poll `outbox()` → when the page's 「发送到对话」 fires, turn the
 * batch into one chat message (with cropped screenshots) for the session that
 * is currently open. Diagnostics are POSTed to the Host half so they can be
 * read back through `webpick_status`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-web-pick',
  factory(require) {
    const NS = 'dsh-web-pick'
    const OVERLAY_URL = '/dsh-web-pick/overlay.js'
    const REPORT_URL = '/dsh-web-pick/report'
    const BATCH_URL = '/dsh-web-pick/batch'
    const POLL_MS = 700
    const SCAN_MS = 600

    let currentSessionId = ''
    let currentActions = null
    let overlaySource = ''
    let overlayFetchedAt = 0

    function report(tag, extra) {
      try {
        fetch(REPORT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tag, at: Date.now(), sessionId: currentSessionId, extra: extra ?? null }),
        }).catch(() => {})
      } catch {
        /* reporting must never break the feature */
      }
    }

    function text(value, max = 120) {
      if (typeof value !== 'string') return ''
      const flat = value.replace(/\s+/gu, ' ').trim()
      return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
    }

    /* --------------------------------------------------------------- webviews */

    function findWebviews() {
      const found = []
      try {
        for (const element of document.querySelectorAll('webview')) found.push(element)
      } catch {
        return found
      }
      // The panel may live under a shadow root; only pay for a deep walk when
      // the cheap query found nothing.
      if (found.length) return found
      try {
        const visit = (root, depth) => {
          if (depth > 6 || !root) return
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) {
              for (const nested of element.shadowRoot.querySelectorAll('webview')) found.push(nested)
              visit(element.shadowRoot, depth + 1)
            }
          }
        }
        visit(document, 0)
      } catch {
        /* a hostile DOM is not worth a crash */
      }
      return found
    }

    async function loadOverlay() {
      if (overlaySource && Date.now() - overlayFetchedAt < 8000) return overlaySource
      const response = await fetch(OVERLAY_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`overlay fetch failed: HTTP ${response.status}`)
      overlaySource = await response.text()
      overlayFetchedAt = Date.now()
      return overlaySource
    }

    function describeWebview(element) {
      try {
        const url = typeof element.getURL === 'function' ? element.getURL() : element.src
        return String(url || '')
      } catch {
        return ''
      }
    }

    async function injectInto(element) {
      const source = await loadOverlay()
      await element.executeJavaScript(source, false)
      return true
    }

    async function drain(element) {
      let actions = null
      try {
        actions = await element.executeJavaScript(
          'window.__dshWebPick ? window.__dshWebPick.outbox() : null',
          false,
        )
      } catch (error) {
        return { injected: false, error: error && error.message }
      }
      if (actions === null) return { injected: false }
      if (!Array.isArray(actions) || !actions.length) return { injected: true, actions: [] }
      return { injected: true, actions }
    }

    /* ------------------------------------------------------------------ batch */

    /**
     * Only selectors that survive a rebuild are worth sending: an id or an
     * explicit test hook. Generic class chains are noise on a site the user does
     * not own, so they stay out of the message.
     */
    function stableSelector(selector) {
      if (typeof selector !== 'string' || !selector) return ''
      const last = selector.split('>').pop().trim()
      if (/^#[A-Za-z][\w-]*$/u.test(last)) return last
      if (/\[(data-testid|data-test|data-cy|aria-label|name)=/u.test(last)) {
        return last.length > 60 ? `${last.slice(0, 59)}…` : last
      }
      return ''
    }

    /**
     * Production builds minify component names to `Xt`/`Ji`; keep only the ones
     * that still read like a real component.
     */
    function usefulComponents(components) {
      if (typeof components !== 'string' || !components) return ''
      const kept = components
        .split('>')
        .map((name) => name.trim())
        .filter((name) => name.length >= 4 || /^[A-Z][a-z]+[A-Z]/.test(name))
      return kept.length ? kept.join(' > ') : ''
    }

    const KIND_LABEL = { element: '元素', region: '区域' }

    /** One line per pick: kind, locator, visible text + optional note. */
    function formatBatch(batch, imageCount = 0) {
      const items = Array.isArray(batch && batch.items) ? batch.items : []
      const page = text(batch && batch.url, 200)
      const title = text(batch && batch.title, 40)
      const head = [`【网页选取】${items.length} 条${title ? ` · ${title}` : ''}`, `页面：${page}`]
      if (imageCount > 0) head.push(`截图：${imageCount} 张（已附在下面）`)
      const body = items
        .map((item) => {
          const kind = KIND_LABEL[item.kind] || '元素'
          const parts = [`${item.index}. ${kind}`]
          if (item.kind === 'region') {
            const rect = item.rect || {}
            parts.push(`${rect.w || 0}×${rect.h || 0}`)
          } else {
            const hook = stableSelector(item.selector)
            parts.push(`\`${hook || item.tag || 'element'}\``)
            const label = text(item.text, 24)
            if (label) parts.push(`「${label}」`)
          }
          if (item.comment) parts.push(`· ${text(item.comment, 400)}`)
          const lines = [parts.join(' ')]
          if (item.source) lines.push(`   源码：${text(item.source, 120)}`)
          else {
            const chain = usefulComponents(item.components)
            if (chain) lines.push(`   组件：${text(chain, 80)}`)
          }
          return lines.join('\n')
        })
        .join('\n\n')
      return `${head.join('\n')}\n\n${body}`
    }

    /**
     * The page cannot see whether the chat accepted the batch, so the result is
     * pushed back into it through the same `executeJavaScript` bridge.
     */
    function notifyPage(element, payload) {
      if (!element || typeof element.executeJavaScript !== 'function') return
      try {
        const call = element.executeJavaScript(
          `window.__dshWebPick && window.__dshWebPick.notify(${JSON.stringify(payload)})`,
          true,
        )
        if (call && typeof call.catch === 'function') call.catch(() => {})
      } catch {
        /* the page may be navigating away; the toast is best effort */
      }
    }

    /* ------------------------------------------------------------- screenshots */

    const MAX_IMAGES = 6
    const MAX_SIDE = 900
    const SHOT_PAD = 40
    const SETTLE_MS = 320

    const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function loadImage(source) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('screenshot decode failed'))
        image.src = source
      })
    }

    /**
     * One cropped screenshot per pick that still knows where it is on the page.
     * An element out of view is scrolled into the middle of the viewport first
     * and the original scroll position is restored afterwards. Items without
     * geometry (a region whose page scrolled away) travel as text only.
     */
    async function captureImages(element, batch) {
      if (!element || typeof element.capturePage !== 'function') {
        report('shot', { ok: false, reason: 'capturePage unavailable' })
        return { images: [], skipped: [] }
      }
      const items = Array.isArray(batch && batch.items) ? batch.items : []
      const viewport = (batch && batch.viewport) || {}
      const origin = Number(viewport.scrollY) || 0
      const vw = Math.max(1, Number(viewport.w) || 1)
      const vh = Math.max(1, Number(viewport.h) || 1)
      const docH = Math.max(vh, Number(viewport.docH) || vh)
      const maxScroll = Math.max(0, docH - vh)
      const images = []
      const missing = []
      const reasons = []
      let current = origin
      let moved = false

      const grab = async () => {
        const shot = await element.capturePage()
        const url = shot && typeof shot.toDataURL === 'function' ? shot.toDataURL() : ''
        return url ? loadImage(url) : null
      }

      const encode = (image, x, y, w, h, name) => {
        const factor = Math.min(1, MAX_SIDE / Math.max(w, h))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * factor))
        canvas.height = Math.max(1, Math.round(h * factor))
        const context = canvas.getContext('2d')
        if (!context) return null
        context.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height)
        const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
        return data ? { mediaType: 'image/jpeg', data, name } : null
      }

      try {
        for (const item of items) {
          if (!item) continue
          if (images.length >= MAX_IMAGES) {
            missing.push(item.index)
            reasons.push({ index: item.index, reason: 'over-limit' })
            continue
          }
          const rect = item.rect
          if (!rect || !(rect.w > 0) || !(rect.h > 0)) {
            reasons.push({ index: item.index, reason: 'no-geometry' })
            continue
          }
          const docY = Number.isFinite(rect.docY) ? rect.docY : rect.y + current
          const target = clamp(Math.round(docY - vh / 2 + rect.h / 2), 0, maxScroll)
          if (Math.abs(target - current) > 1) {
            await element.executeJavaScript(`window.scrollTo(0, ${Math.round(target)})`, false)
            current = target
            moved = true
            await sleep(SETTLE_MS)
          }
          const image = await grab()
          if (image) {
            const k = image.naturalWidth / vw
            const pad = Math.round(SHOT_PAD * k)
            const x = clamp(Math.round(rect.x * k) - pad, 0, Math.max(0, image.naturalWidth - 1))
            const y = clamp(Math.round((docY - target) * k) - pad, 0, Math.max(0, image.naturalHeight - 1))
            const w = Math.min(Math.round(rect.w * k) + pad * 2, image.naturalWidth - x)
            const h = Math.min(Math.round(rect.h * k) + pad * 2, image.naturalHeight - y)
            const encoded = w >= 8 && h >= 8 ? encode(image, x, y, w, h, `pick-${item.index}.jpg`) : null
            if (encoded) {
              images.push(encoded)
              continue
            }
            reasons.push({ index: item.index, reason: 'crop-too-small' })
          } else {
            reasons.push({ index: item.index, reason: 'capture-empty' })
          }
          missing.push(item.index)
        }
      } catch (error) {
        report('shot', { ok: false, reason: error && error.message ? error.message : String(error) })
      } finally {
        if (moved) {
          try {
            await element.executeJavaScript(`window.scrollTo(0, ${Math.round(origin)})`, false)
          } catch {
            /* the page may be gone; nothing to restore */
          }
        }
      }
      report('shot', {
        ok: images.length > 0,
        images: images.length,
        missing: missing.length,
        reasons,
        kb: Math.round(images.reduce((sum, entry) => sum + entry.data.length, 0) / 1024),
      })
      return { images, skipped: missing }
    }

    /**
     * Attach the crops to the draft the same way a paste does: hand the
     * composer's own file input a DataTransfer and fire `change`, which is the
     * shipped intake path (upload, rail thumbnail, removable by the user).
     * @returns how many files the composer accepted.
     */
    function composerFileInput() {
      const inCard = document.querySelector('[data-composer-card] input[type="file"]')
      if (inCard instanceof HTMLInputElement) return inCard
      const all = Array.from(document.querySelectorAll('input[type="file"]')).filter(
        (node) => node instanceof HTMLInputElement && !node.disabled,
      )
      return all.length ? all[all.length - 1] : null
    }

    function attachImagesToDraft(images) {
      if (!images.length) return 0
      const input = composerFileInput()
      if (!(input instanceof HTMLInputElement) || input.disabled) {
        report('attach', { ok: false, error: 'composer file input not found' })
        return 0
      }
      try {
        const transfer = new DataTransfer()
        for (const image of images) {
          const binary = atob(image.data)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          transfer.items.add(new File([bytes], image.name || 'pick.jpg', { type: image.mediaType || 'image/jpeg' }))
        }
        if (!transfer.files.length) return 0
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
        report('attach', { ok: true, count: transfer.files.length })
        return transfer.files.length
      } catch (error) {
        report('attach', { ok: false, error: error && error.message ? error.message : String(error) })
        return 0
      }
    }

    /**
     * Put the batch into the composer draft instead of sending it: the user gets
     * to read and edit before anything reaches the agent.
     */
    function insertIntoDraft(actions, text) {
      try {
        const span = actions.captureInsertion()
        if (actions.insertText(text, span)) return true
        report('insert', { ok: false, mode: 'insertText', error: 'insertText refused' })
      } catch (error) {
        report('insert', { ok: false, mode: 'insertText', error: error && error.message ? error.message : String(error) })
      }
      try {
        actions.setDraft(text)
        return true
      } catch (error) {
        report('insert', { ok: false, mode: 'setDraft', error: error && error.message ? error.message : String(error) })
        return false
      }
    }

    async function submitBatch(ctx, batch, element) {
      const items = Array.isArray(batch && batch.items) ? batch.items : []
      if (!items.length) return
      try {
        await fetch(BATCH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch),
        })
      } catch {
        /* the draft below is the primary channel */
      }
      const actions = currentActions
      if (!actions) {
        report('insert', { ok: false, error: 'composer not mounted', url: batch && batch.url })
        notifyPage(element, { ok: false, error: '没有找到输入框（对话可能没打开）' })
        return
      }
      const { images } = await captureImages(element, batch)
      const attached = attachImagesToDraft(images)
      const message = formatBatch(batch, attached)
      if (!insertIntoDraft(actions, message)) {
        notifyPage(element, { ok: false, error: '输入框当前不可写（可能正在发送上一条）' })
        return
      }
      try {
        if (typeof actions.persistDraft === 'function') actions.persistDraft()
      } catch {
        /* persistence is best effort */
      }
      try {
        if (typeof actions.notify === 'function') {
          actions.notify(
            'info',
            `网页选取 ${items.length} 条已放入输入框${attached > 0 ? `，${attached} 张截图已附上` : ''}，检查后再发送`,
          )
        }
      } catch {
        /* a notice failing must not undo the insertion */
      }
      report('submit', {
        ok: true,
        mode: 'draft',
        count: items.length,
        images: attached,
        url: batch && batch.url,
      })
      notifyPage(element, { ok: true, count: items.length, images: attached })
    }

    /* ------------------------------------------------------------------- life */

    return {
      inject: ['slots'],
      apply(ctx) {
        /** @type {WeakMap<Element, { timer: number, injected: boolean, attempts: number }>} */
        const watched = new WeakMap()
        let scanTimer = 0
        let disposed = false
        let deepScanTick = 0

        function watch(element) {
          if (!element || watched.has(element)) return
          const state = { timer: 0, injected: false, attempts: 0, domReady: false }
          watched.set(element, state)
          const onReady = () => {
            state.domReady = true
            injectInto(element)
              .then(() => {
                state.injected = true
                report('inject', { ok: true, url: describeWebview(element) })
              })
              .catch((error) =>
                report('inject', { ok: false, url: describeWebview(element), error: error && error.message }),
              )
          }
          try {
            element.addEventListener('dom-ready', onReady)
            element.addEventListener('did-navigate', () => {
              state.injected = false
            })
          } catch {
            /* an element that cannot take listeners still gets polled */
          }
          state.timer = setInterval(async () => {
            if (disposed) return
            if (!element.isConnected) {
              clearInterval(state.timer)
              return
            }
            try {
              const result = await drain(element)
              if (!result.injected) {
                state.attempts += 1
                if (state.attempts % 3 === 1) {
                  await injectInto(element)
                  state.injected = true
                }
                return
              }
              state.injected = true
              for (const action of result.actions || []) {
                if (action && action.type === 'submit') submitBatch(ctx, action, element)
                else if (action && action.type === 'ping') report('overlay-ping', action)
              }
            } catch (error) {
              report('poll', { error: error && error.message })
            }
          }, POLL_MS)
        }

        function scan() {
          if (disposed) return
          deepScanTick += 1
          const elements = findWebviews()
          for (const element of elements) watch(element)
          if (elements.length && deepScanTick % 20 === 0) {
            report('alive', {
              webviews: elements.length,
              injected: elements.filter((element) => watched.get(element)?.injected).length,
            })
          }
        }

        // The built-in browser is a session-scoped panel; its `webview` lives in
        // this page, so a plain interval plus the panel's own lifecycle is enough.
        scanTimer = setInterval(scan, SCAN_MS)
        scan()

        // Session identity: the composer's dock slot receives `sessionId` for the
        // conversation on screen. Keeping it in a module variable lets a batch
        // sent from the page land in the chat the user is actually reading.
        function SessionProbe(props) {
          try {
            if (props && typeof props.sessionId === 'string') currentSessionId = props.sessionId
            // The composer's own action face: insertText/setDraft write the draft
            // without submitting it, which is what "send to the conversation"
            // now means — the user reviews first.
            if (props && props.inputActions) currentActions = props.inputActions
          } catch {
            /* ignore */
          }
          return null
        }

        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-web-pick-session', order: 90 }, SessionProbe),
          )
        } catch (error) {
          report('slot', { ok: false, error: error && error.message })
        }

        report('boot', { href: location.href, version: '1.3.0' })

        const cleanup = () => {
          disposed = true
          clearInterval(scanTimer)
          overlaySource = ''
        }
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
        } catch {
          /* cleanup is best effort */
        }
      },
    }
  },
})
