/**
 * All page-visible UI lives inside a closed shadow root so host-page CSS
 * (and page scripts) cannot reach in and break it.
 */

const HOST_ID = 'quickglot-root'
const Z = '2147483647'

const STYLE = `
:host { all: initial; }
.layer {
  position: absolute;
  z-index: ${Z};
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  color-scheme: light dark;
}
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 999px;
  border: none;
  background: #1c7ef3;
  color: #fff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.chip:active { transform: scale(0.96); }
.panel {
  max-width: min(380px, calc(100vw - 24px));
  max-height: 50vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 14px;
  border-radius: 12px;
  background: Canvas;
  color: CanvasText;
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.24);
  border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
}
.meta {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.5;
  margin-bottom: 6px;
}
.body { white-space: pre-wrap; word-break: break-word; }
.error { color: #d1453b; }
.action {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.7;
}
.dots::after {
  content: '';
  animation: dots 1.2s steps(4, end) infinite;
}
@keyframes dots {
  0% { content: ''; }
  25% { content: '.'; }
  50% { content: '..'; }
  75% { content: '...'; }
}
`

import {
  anchorNow,
  CALLOUT_GAP,
  chipPlacement,
  intersectsViewport,
  placement,
  RTL_LANGUAGES,
  sideAwayFromCallout,
  toPageCoordinates,
} from '../shared/logic'

/** Touch means the iOS callout shares the selection with us; see `position`. */
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches

/** How long after the last scroll event the chip is re-placed. */
const SCROLL_SETTLE_MS = 120

export interface Anchor {
  /** Viewport coordinates of the selection, as measured when it was made. */
  top: number
  bottom: number
  left: number
  right: number
  /** Page scroll at that same moment, so the anchor survives later scrolling. */
  scrollX: number
  scrollY: number
}

type Content =
  | { kind: 'chip'; onTap: () => void }
  | { kind: 'loading' }
  | { kind: 'result'; text: string; source: string; target: string }
  | { kind: 'error'; message: string; hint?: string }

let host: HTMLDivElement | null = null
let root: ShadowRoot | null = null

/** What is on screen, so a scroll can re-place the chip. */
let shown: { layer: HTMLElement; anchor: Anchor; isChip: boolean } | null = null
let scrollTimer: number | undefined

/**
 * The callout re-decides its side whenever the selection moves in the viewport,
 * so a chip placed before the scroll can end up under it. Wait for the scroll
 * to settle and place the chip again from where the selection is now; the
 * panels stay put, since tapping the chip cleared the selection and the callout
 * with it.
 */
function onScroll(): void {
  window.clearTimeout(scrollTimer)
  scrollTimer = window.setTimeout(() => {
    if (!shown?.isChip || !shown.layer.isConnected) return
    const { layer, anchor } = shown
    shown.anchor = anchorNow(anchor, { scrollX: window.scrollX, scrollY: window.scrollY })
    position(layer, shown.anchor, true)
  }, SCROLL_SETTLE_MS)
}

function ensureRoot(): ShadowRoot {
  if (root && host?.isConnected) return root
  host = document.createElement('div')
  host.id = HOST_ID
  root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)
  document.documentElement.append(host)
  if (IS_TOUCH) window.addEventListener('scroll', onScroll, { passive: true })
  return root
}

/** True when the click landed on our own UI, which must not dismiss it. */
export function isOwnElement(target: EventTarget | null): boolean {
  return host !== null && target instanceof Node && host.contains(target)
}

export function dismiss(): void {
  window.removeEventListener('scroll', onScroll)
  window.clearTimeout(scrollTimer)
  shown = null
  host?.remove()
  host = null
  root = null
}

export function show(anchor: Anchor, content: Content): void {
  const shadow = ensureRoot()
  shadow.querySelector('.layer')?.remove()

  const layer = document.createElement('div')
  layer.className = 'layer'

  if (content.kind === 'chip') {
    const chip = document.createElement('button')
    chip.className = 'chip'
    chip.textContent = browser.i18n.getMessage('chipTranslate')
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      content.onTap()
    })
    layer.append(chip)
  } else {
    const panel = document.createElement('div')
    panel.className = 'panel'
    const meta = document.createElement('div')
    meta.className = 'meta'
    const body = document.createElement('div')

    if (content.kind === 'loading') {
      meta.textContent = 'QuickGlot'
      body.className = 'body dots'
    } else if (content.kind === 'result') {
      meta.textContent = `${content.source} → ${content.target}`
      body.className = 'body'
      body.textContent = content.text
      if (RTL_LANGUAGES.has(content.target)) {
        body.dir = 'rtl'
        body.style.textAlign = 'right'
      }
    } else {
      meta.textContent = 'QuickGlot'
      body.className = 'body error'
      body.textContent = content.message
    }

    panel.append(meta, body)
    if (content.kind === 'error' && content.hint) {
      const hint = document.createElement('div')
      hint.className = 'action'
      hint.textContent = content.hint
      panel.append(hint)
    }
    layer.append(panel)
  }

  shadow.append(layer)
  shown = { layer, anchor, isChip: content.kind === 'chip' }
  position(layer, anchor, shown.isChip)
}

/**
 * On touch the iOS callout (Copy / Look Up / Translate) shares the selection
 * with us and a page cannot ask where it went. The chip takes the other side
 * when it fits, or sits beyond the callout near a viewport edge. On macOS there
 * is no callout and the panel sits above.
 *
 * Placement is decided in viewport space — using the coordinates captured when
 * the selection was made, not the live ones — and then written out in page
 * coordinates. The layer is absolutely positioned, so it stays with the text it
 * describes while the page scrolls, and the loading and result panels land in
 * the same spot even if the user scrolled while the translation was running.
 */
function position(layer: HTMLElement, anchor: Anchor, isChip = false): void {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  // Keep the selection state so scrolling back can reveal the chip again.
  const hideChip = isChip && !intersectsViewport(anchor, viewport)
  layer.style.visibility = hideChip ? 'hidden' : 'visible'
  if (hideChip) return

  const { width, height } = layer.getBoundingClientRect()
  const spot = isChip && IS_TOUCH
    ? chipPlacement(anchor, { width, height }, viewport)
    : placement(anchor, { width, height }, viewport, {
      prefer: IS_TOUCH ? sideAwayFromCallout(anchor.top) : 'above',
      gap: CALLOUT_GAP,
      align: isChip ? 'end' : 'center',
    })
  const page = toPageCoordinates(spot, anchor)
  layer.style.left = `${page.left}px`
  layer.style.top = `${page.top}px`
}
