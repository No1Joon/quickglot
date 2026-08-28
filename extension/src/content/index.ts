import { MAX_SELECTION_LENGTH, type TranslateResponse } from '../shared/messages'
import { dismiss, isOwnElement, show, type Anchor } from './ui'

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
  if (!text) return null
  if (isEditable(selection.anchorNode)) return null

  const rect = selection.getRangeAt(0).getBoundingClientRect()
  // Collapsed or off-screen rects give us nothing to anchor to.
  if (rect.width === 0 && rect.height === 0) return null

  return {
    text: text.slice(0, MAX_SELECTION_LENGTH),
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
        message: 'This language pair is not downloaded yet.',
        hint: 'Open the QuickGlot app once to download it — then it works offline.',
      }
    case 'unsupported':
      return { message: 'Apple’s on-device models don’t cover this language pair.' }
    case 'undetectable':
      return { message: 'Could not tell what language that is.' }
    default:
      return { message: res.message || 'Translation failed.' }
  }
}

async function translate(selected: Selected): Promise<void> {
  const ticket = ++sequence
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

function close(): void {
  sequence++
  dismiss()
}

if (IS_TOUCH) {
  let timer: number | undefined
  document.addEventListener('selectionchange', () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const selected = readSelection()
      if (!selected) {
        close()
        return
      }
      sequence++
      show(selected.anchor, { kind: 'chip', onTap: () => void translate(selected) })
    }, SELECTION_DEBOUNCE_MS)
  })
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

// Deliberately not dismissed on scroll: the panel is anchored to the page, so
// it stays with the text it translated. A resize does invalidate the anchor.
window.addEventListener('resize', close)
