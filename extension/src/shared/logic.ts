/**
 * Pure logic lifted out of the content script and background so it can be
 * tested without a browser. Every function here is one that has already gone
 * wrong once — the panel was positioned from stale coordinates, and selections
 * inside inputs were nearly translated.
 */

/** Right-to-left scripts among the languages Apple's models cover. */
export const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur'])

/**
 * Whether a selection is worth offering to translate. Trimmed already by the
 * caller; this rejects what is left when the drag caught nothing that reads as
 * language. Two letters is the bar: one letter with punctuation ("a.") or a
 * number ("v2") is not a word, and digits, symbols and punctuation alone never
 * are. Letters are counted across scripts, so "한국" passes like "hi".
 */
export function isTranslatable(text: string): boolean {
  return (text.match(/\p{L}/gu)?.length ?? 0) >= 2
}

export interface Rect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface Viewport {
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export const GAP = 8
export const MARGIN = 12

/**
 * Room the iOS callout (Copy / Look Up / Translate) needs above a selection:
 * the menu bar plus its arrow. A page cannot ask where the system put it, so
 * this is the estimate everything below works from.
 */
export const CALLOUT_HEIGHT = 60

/** Extra distance kept from the selection on touch, where the callout also lives. */
export const CALLOUT_GAP = 20

/**
 * Which side of the selection the iOS callout is on. The system draws it above
 * the selection when it fits there and below otherwise, and re-decides each
 * time the selection moves in the viewport, so the answer changes with scroll.
 */
export function calloutSide(anchorTop: number): 'above' | 'below' {
  return anchorTop >= CALLOUT_HEIGHT ? 'above' : 'below'
}

/** The side our own UI takes: whichever the callout does not. */
export function sideAwayFromCallout(anchorTop: number): 'above' | 'below' {
  return calloutSide(anchorTop) === 'above' ? 'below' : 'above'
}

/**
 * Where the anchor is in the viewport now, given where it was measured and how
 * far the page has scrolled since. Lets the chip follow the callout's
 * re-placement after a scroll without re-reading the selection.
 */
export function anchorNow<T extends Rect & { scrollX: number; scrollY: number }>(
  anchor: T,
  scroll: { scrollX: number; scrollY: number },
): T {
  const dx = scroll.scrollX - anchor.scrollX
  const dy = scroll.scrollY - anchor.scrollY
  return {
    ...anchor,
    top: anchor.top - dy,
    bottom: anchor.bottom - dy,
    left: anchor.left - dx,
    right: anchor.right - dx,
    scrollX: scroll.scrollX,
    scrollY: scroll.scrollY,
  }
}

/** Whether any of the selection remains inside the viewport. */
export function intersectsViewport(anchor: Rect, viewport: Viewport): boolean {
  return anchor.bottom > 0 && anchor.top < viewport.height &&
    anchor.right > 0 && anchor.left < viewport.width
}

/**
 * Where the panel goes, in viewport coordinates. Below the selection unless
 * asked otherwise; flipped to the other side only when there is no room.
 */
export function placement(
  anchor: Rect,
  size: Size,
  viewport: Viewport,
  options: { align?: 'center' | 'end'; gap?: number; prefer?: 'above' | 'below' } = {},
): { left: number; top: number } {
  const gap = options.gap ?? GAP

  let left =
    options.align === 'end'
      ? anchor.right - size.width
      : anchor.left + (anchor.right - anchor.left) / 2 - size.width / 2
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN))

  const above = anchor.top - size.height - gap
  const below = anchor.bottom + gap
  const fitsAbove = above >= MARGIN
  const fitsBelow = below + size.height <= viewport.height - MARGIN

  let top: number
  if (options.prefer === 'above') {
    top = fitsAbove ? above : below
  } else {
    top = fitsBelow ? below : above
  }
  // Neither side has room: keep it on screen rather than half off it.
  if (top < MARGIN || top + size.height > viewport.height - MARGIN) {
    top = Math.max(MARGIN, Math.min(top, viewport.height - size.height - MARGIN))
  }
  return { left, top }
}

/** Page coordinates, using the scroll offsets captured when the selection was made. */
export function toPageCoordinates(
  placementResult: { left: number; top: number },
  scroll: { scrollX: number; scrollY: number },
): { left: number; top: number } {
  return {
    left: Math.round(placementResult.left + scroll.scrollX),
    top: Math.round(placementResult.top + scroll.scrollY),
  }
}
