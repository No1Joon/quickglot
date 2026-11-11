import { isTranslatable } from '../shared/logic'
import { MAX_SELECTION_LENGTH, type TranslateResponse } from '../shared/messages'
import { dismiss, isOwnElement, show, type Anchor } from './ui'

declare global {
  interface Window {
    __quickglotInjected?: true
  }
}

/**
 * Updating the extension while a tab is open injects the new content script
 * without tearing down the one already running, and both then answer the same
 * selection — two chips, one per build. Content scripts of an extension share
 * one isolated world per frame, so a flag on window is enough to stand down.
 */
const alreadyRunning = window.__quickglotInjected === true
window.__quickglotInjected = true

/**
 * macOS: releasing the mouse over a selection translates immediately.
 * iOS: selection handles emit selectionchange while moving, so wait for the
 * selection to settle before translating without an extra tap.
 */
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches

const SELECTION_DEBOUNCE_MS = 300

/**
 * How long a translation may take before the loading panel is worth showing.
 * A same-language no-op answers in well under a millisecond and a cached hit is
 * instant, so painting the panel immediately only produces a flash.
 */
const LOADING_DELAY_MS = 200
const TRANSLATION_TIMEOUT_MS = 30_000

let sequence = 0
let cancelTranslation: (() => void) | undefined

interface Selected {
  text: string
  anchor: Anchor
  startContainer: Node
  startOffset: number
  endContainer: Node
  endOffset: number
}

function isEditable(node: Node | null): boolean {
  let el = node instanceof Element ? node : node?.parentElement
  while (el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    el = el.parentElement
  }
  return false
}

function readSelection(): Selected | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const text = selection.toString().trim()
  if (!isTranslatable(text)) return null
  const range = selection.getRangeAt(0)
  if (isEditable(range.startContainer) || isEditable(range.endContainer)) return null
  // A drag can begin and end outside an editor while still covering its text.
  // Check the entire range before sending any of it to the native handler.
  const ancestor = range.commonAncestorContainer
  if (ancestor instanceof Element || ancestor instanceof Document || ancestor instanceof DocumentFragment) {
    for (const element of ancestor.querySelectorAll('input, textarea, [contenteditable]')) {
      if (isEditable(element) && range.intersectsNode(element)) return null
    }
  }
  const rect = range.getBoundingClientRect()
  // Collapsed or off-screen rects give us nothing to anchor to.
  if (rect.width === 0 && rect.height === 0) return null

  return {
    text: text.slice(0, MAX_SELECTION_LENGTH),
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
    anchor: {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
  }
}

function describe(res: Extract<TranslateResponse, { ok: false }>): {
  message: string
  hint?: string
} {
  switch (res.error) {
    case 'notInstalled':
      return {
        message: browser.i18n.getMessage('errorNotInstalled'),
        hint: browser.i18n.getMessage('errorNotInstalledHint'),
      }
    case 'unsupported':
      return { message: browser.i18n.getMessage('errorUnsupported') }
    case 'undetectable':
      return { message: browser.i18n.getMessage('errorUndetectable') }
    default:
      return { message: res.message || browser.i18n.getMessage('errorGeneric') }
  }
}

async function translate(selected: Selected): Promise<void> {
  cancelTranslation?.()
  const ticket = ++sequence
  const started = performance.now()
  const loading = window.setTimeout(() => {
    // A newer selection may have superseded this one while we waited.
    if (ticket === sequence) show(selected.anchor, { kind: 'loading' })
  }, LOADING_DELAY_MS)

  // Bound the UI wait even if Safari's native bridge never settles. Closing or
  // replacing this request releases its timers; a late reply cannot repaint it.
  const res = await new Promise<TranslateResponse | undefined>((resolve) => {
    const finish = (response?: TranslateResponse) => {
      window.clearTimeout(timeout)
      window.clearTimeout(loading)
      if (cancelTranslation === cancel) cancelTranslation = undefined
      resolve(response)
    }
    const cancel = () => finish()
    const timeout = window.setTimeout(() => finish({
      ok: false, error: 'unknown', message: browser.i18n.getMessage('errorGeneric'),
    }), TRANSLATION_TIMEOUT_MS)
    cancelTranslation = cancel
    // Promise chaining also handles a synchronous bridge error.
    Promise.resolve().then(() => browser.runtime.sendMessage({
      type: 'translate', text: selected.text,
    })).then(response => finish(response as TranslateResponse), () => finish({
      ok: false, error: 'unknown', message: browser.i18n.getMessage('errorGeneric'),
    }))
  })

  console.debug(`[QuickGlot] translation round trip ${Math.round(performance.now() - started)}ms`)
  window.clearTimeout(loading)

  // A newer selection superseded this one while the native side was working.
  if (ticket !== sequence) return

  // Selecting text you can already read should do nothing at all — showing an
  // error card on every such selection makes the extension feel broken.
  if (res && !res.ok && res.error === 'sameLanguage') {
    close()
    return
  }

  if (res && res.ok) {
    show(selected.anchor, {
      kind: 'result',
      text: res.text,
      source: res.source,
      target: res.target,
    })
  } else {
    // Keep successful/same-language selections deduplicated, but let a failed
    // range be selected again after downloading packs or a transient failure.
    pinnedSelection = null
    const { message, hint } = describe(
      res ?? { ok: false, error: 'unknown', message: 'No response' },
    )
    show(selected.anchor, { kind: 'error', message, hint })
  }
}

/**
 * Keep an automatically requested result through Safari's empty-selection
 * notifications while scrolling. Remember the DOM range to avoid translating
 * the same selection again, including after an outside tap dismisses it.
 */
let resultPinned = false
let pinnedSelection: Selected | null = null
let selectionTimer: number | undefined

function close(): void {
  sequence++
  cancelTranslation?.()
  window.clearTimeout(selectionTimer)
  resultPinned = false
  dismiss()
}

function start(): void {
  if (IS_TOUCH) {
    document.addEventListener('selectionchange', () => {
      window.clearTimeout(selectionTimer)
      const selected = readSelection()
      if (!selected) {
        if (!resultPinned) {
          pinnedSelection = null
          close()
        }
        return
      }
      if (pinnedSelection &&
          selected.text === pinnedSelection.text &&
          selected.startContainer === pinnedSelection.startContainer &&
          selected.startOffset === pinnedSelection.startOffset &&
          selected.endContainer === pinnedSelection.endContainer &&
          selected.endOffset === pinnedSelection.endOffset) return

      // Invalidate the old response immediately, before the debounce expires.
      close()
      pinnedSelection = null
      selectionTimer = window.setTimeout(() => {
        const settled = readSelection()
        if (!settled) return
        resultPinned = true
        pinnedSelection = settled
        void translate(settled)
      }, SELECTION_DEBOUNCE_MS)
    })

    // Track a completed tap without depending on Safari's synthesized click.
    // Scrolling, selection drags, long presses and multi-touch must not dismiss.
    let tap: { id: number; x: number; y: number; time: number } | null = null
    const moved = (event: PointerEvent) => tap !== null &&
      Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10
    document.addEventListener('pointerdown', (event) => {
      tap = event.isPrimary && event.button === 0 && !isOwnElement(event.target)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }
        : null
    }, true)
    document.addEventListener('pointermove', (event) => {
      if (tap?.id === event.pointerId && moved(event)) tap = null
    }, true)
    document.addEventListener('pointercancel', () => { tap = null }, true)
    document.addEventListener('scroll', () => { tap = null }, true)
    document.addEventListener('pointerup', (event) => {
      if (tap?.id !== event.pointerId) return
      const dismissTap = !moved(event) && event.timeStamp - tap.time < 500 &&
        !isOwnElement(event.target)
      tap = null
      if (dismissTap) {
        close()
      }
    }, true)
  } else {
    document.addEventListener('mouseup', (event) => {
      if (isOwnElement(event.target)) return
      // The selection is not updated until after mouseup dispatches.
      window.setTimeout(() => {
        const selected = readSelection()
        if (!selected) {
          close()
          return
        }
        void translate(selected)
      }, 0)
    })

    document.addEventListener('mousedown', (event) => {
      if (!isOwnElement(event.target)) close()
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })

  // Safari's collapsing toolbar changes height during scrolling. Only a width
  // change invalidates the text layout on touch; desktop keeps its resize rule.
  let viewportWidth = window.innerWidth
  window.addEventListener('resize', () => {
    const widthChanged = window.innerWidth !== viewportWidth
    viewportWidth = window.innerWidth
    if (!IS_TOUCH || widthChanged) close()
  })
}

if (!alreadyRunning) start()
