/**
 * Pure logic lifted out of the content script and background so it can be
 * tested without a browser. Every function here is one that has already gone
 * wrong once — the cache key carried an invisible NUL, the panel was positioned
 * from stale coordinates, and selections inside inputs were nearly translated.
 */

/** Right-to-left scripts among the languages Apple's models cover. */
export const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur'])

export interface CacheKeyInput {
  text: string
  target?: string
}

/**
 * A language code can never contain U+0000, so no target/text pair can collide
 * with another by shifting the boundary between them.
 */
export function cacheKey({ text, target }: CacheKeyInput): string {
  return `${target ?? '*'}\u0000${text}`
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
 * Where the panel goes, in viewport coordinates. Below the selection by default
 * because on iOS the system callout claims the space above it; flipped above
 * only when there is no room below.
 */
export function placement(anchor: Rect, size: Size, viewport: Viewport): { left: number; top: number } {
  let left = anchor.left + (anchor.right - anchor.left) / 2 - size.width / 2
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN))

  let top = anchor.bottom + GAP
  if (top + size.height > viewport.height - MARGIN) {
    const above = anchor.top - size.height - GAP
    top = above >= MARGIN ? above : Math.max(MARGIN, viewport.height - size.height - MARGIN)
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
