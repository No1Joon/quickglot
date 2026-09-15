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
 * iOS: the system callout owns the selection gesture, so we surface a chip
 * that the user taps — settled in the design pass, see docs/DECISIONS.md.
 */
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches

const SELECTION_DEBOUNCE_MS = 300

/**
 * How long a translation may take before the loading panel is worth showing.
 * A same-language no-op answers in well under a millisecond and a cached hit is
 * instant, so painting the panel immediately only produces a flash.
 */
const LOADING_DELAY_MS = 200

let sequence = 0

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
  if (isEditable(selection.anchorNode)) return null

  const range = selection.getRangeAt(0)
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
  const ticket = ++sequence
  const started = performance.now()
  const loading = window.setTimeout(() => {
    // A newer selection may have superseded this one while we waited.
    if (ticket === sequence) show(selected.anchor, { kind: 'loading' })
  }, LOADING_DELAY_MS)

  let res: TranslateResponse
  try {
    res = (await browser.runtime.sendMessage({
      type: 'translate',
      text: selected.text,
    })) as TranslateResponse
  } catch (e) {
    res = {
      ok: false,
      error: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    }
  }

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
    const { message, hint } = describe(
      res ?? { ok: false, error: 'unknown', message: 'No response' },
    )
    show(selected.anchor, { kind: 'error', message, hint })
  }
}

/**
 * True once a tap has produced a result. Tapping the chip clears the text
 * selection on iOS, which fires selectionchange with nothing selected — that
 * must not dismiss the translation the tap just asked for.
 */
let resultPinned = false
let pinnedSelection: Selected | null = null

function close(): void {
  sequence++
  resultPinned = false
  pinnedSelection = null
  dismiss()
}

function start(): void {
  if (IS_TOUCH) {
    let timer: number | undefined
    document.addEventListener('selectionchange', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const selected = readSelection()
        if (!selected) {
          if (!resultPinned) close()
          return
        }
        if (resultPinned && pinnedSelection &&
          selected.text === pinnedSelection.text &&
          selected.startContainer === pinnedSelection.startContainer &&
          selected.startOffset === pinnedSelection.startOffset &&
          selected.endContainer === pinnedSelection.endContainer &&
          selected.endOffset === pinnedSelection.endOffset) return
        resultPinned = false
        pinnedSelection = null
        sequence++
        show(selected.anchor, {
          kind: 'chip',
          onTap: () => {
            window.clearTimeout(timer)
            resultPinned = true
            pinnedSelection = selected
            void translate(selected)
          },
        })
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
        window.clearTimeout(timer)
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
