import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  anchorNow,
  calloutSide,
  isTranslatable,
  intersectsViewport,
  placement,
  RTL_LANGUAGES,
  sideAwayFromCallout,
  toPageCoordinates,
  CALLOUT_GAP,
  CALLOUT_HEIGHT,
  GAP,
  MARGIN,
} from './logic.ts'

const viewport = { width: 1000, height: 800 }
const size = { width: 300, height: 200 }

test('panel sits below the selection when nothing asks otherwise', () => {
  const anchor = { top: 300, bottom: 320, left: 400, right: 600 }
  const { top, left } = placement(anchor, size, viewport)
  assert.equal(top, 320 + GAP)
  // horizontally centred on the selection
  assert.equal(left, 500 - size.width / 2)
})

test('the iOS callout sits above the selection when it fits, else below', () => {
  assert.equal(calloutSide(CALLOUT_HEIGHT), 'above')
  assert.equal(calloutSide(CALLOUT_HEIGHT - 1), 'below')
  assert.equal(calloutSide(0), 'below')
})

test('our UI takes the side the callout does not', () => {
  assert.equal(sideAwayFromCallout(400), 'below', 'callout above, so we go below')
  assert.equal(sideAwayFromCallout(20), 'above', 'callout below, so we go above')
})

test('the anchor follows the page as it scrolls', () => {
  const measured = { top: 400, bottom: 420, left: 100, right: 300, scrollX: 0, scrollY: 1000 }
  const now = anchorNow(measured, { scrollX: 10, scrollY: 1350 })
  assert.equal(now.top, 50, 'scrolled down 350, so it is 350 higher in the viewport')
  assert.equal(now.bottom, 70)
  assert.equal(now.left, 90)
  assert.equal(now.right, 290)
  assert.equal(now.scrollY, 1350, 'and the new scroll is what page coordinates add back')
  assert.equal(calloutSide(now.top), 'below', 'which is what moves the callout below it')
})

test('preferring above puts it over the selection', () => {
  const anchor = { top: 400, bottom: 420, left: 400, right: 600 }
  const { top } = placement(anchor, size, viewport, { prefer: 'above', gap: CALLOUT_GAP })
  assert.equal(top, 400 - size.height - CALLOUT_GAP)
})

test('preferring above falls back below when the selection is near the top', () => {
  const anchor = { top: 20, bottom: 40, left: 400, right: 600 }
  const { top } = placement(anchor, size, viewport, { prefer: 'above', gap: CALLOUT_GAP })
  assert.equal(top, 40 + CALLOUT_GAP, 'no room above, so it goes below')
})

test('panel flips above the selection when it would fall off the bottom', () => {
  const anchor = { top: 700, bottom: 720, left: 400, right: 600 }
  const { top } = placement(anchor, size, viewport)
  assert.equal(top, 700 - size.height - GAP)
})

test('panel stays on screen when the selection is at the very edge', () => {
  const leftEdge = placement({ top: 10, bottom: 30, left: 0, right: 20 }, size, viewport)
  assert.ok(leftEdge.left >= MARGIN, `left ${leftEdge.left} should respect the margin`)

  const rightEdge = placement({ top: 10, bottom: 30, left: 980, right: 1000 }, size, viewport)
  assert.ok(
    rightEdge.left + size.width <= viewport.width - MARGIN,
    `right edge ${rightEdge.left + size.width} should stay inside the viewport`,
  )
})

test('a selection too tall for the viewport still leaves the panel on screen', () => {
  const tall = { width: 300, height: 780 }
  const { top } = placement({ top: 400, bottom: 420, left: 400, right: 600 }, tall, viewport)
  assert.ok(top >= MARGIN, `top ${top} should respect the margin`)
})

test('page coordinates use the scroll captured with the selection, not the current one', () => {
  const spot = { left: 100, top: 200 }
  const page = toPageCoordinates(spot, { scrollX: 0, scrollY: 1500 })
  assert.deepEqual(page, { left: 100, top: 1700 })
})

test('right-to-left targets are recognised', () => {
  assert.ok(RTL_LANGUAGES.has('ar'))
  assert.ok(!RTL_LANGUAGES.has('ko'))
  assert.ok(!RTL_LANGUAGES.has('en'))
})

test('the chip aligns to the end of the selection', () => {
  const anchor = { top: 400, bottom: 420, left: 300, right: 700 }
  const centred = placement(anchor, size, viewport)
  const aligned = placement(anchor, size, viewport, {
    align: 'end',
    gap: CALLOUT_GAP,
    prefer: 'above',
  })

  assert.equal(aligned.left + size.width, anchor.right, 'right edges should line up')
  assert.ok(aligned.left > centred.left, 'end alignment sits right of centre alignment')
  assert.equal(aligned.top, anchor.top - size.height - CALLOUT_GAP, 'and above the selection')
})

test('end alignment still respects the viewport margin', () => {
  const narrow = { top: 100, bottom: 120, left: 0, right: 60 }
  const { left } = placement(narrow, size, viewport, {
    align: 'end',
    gap: CALLOUT_GAP,
    prefer: 'above',
  })
  assert.ok(left >= MARGIN, `left ${left} should respect the margin`)
})

test('a single letter is not offered for translation, whatever surrounds it', () => {
  assert.equal(isTranslatable('a'), false)
  assert.equal(isTranslatable('山'), false)
  assert.equal(isTranslatable('a.'), false)
  assert.equal(isTranslatable('v2'), false)
  assert.equal(isTranslatable('(a)'), false)
})

test('a selection with no letters is not offered for translation', () => {
  assert.equal(isTranslatable(''), false)
  assert.equal(isTranslatable('123'), false)
  assert.equal(isTranslatable('...'), false)
  assert.equal(isTranslatable('— !?'), false)
  assert.equal(isTranslatable('12:30'), false)
  assert.equal(isTranslatable('🙂'), false)
})

test('two letters are enough, in any script and with anything around them', () => {
  assert.equal(isTranslatable('hi'), true)
  assert.equal(isTranslatable('한국'), true)
  assert.equal(isTranslatable('a b'), true)
  assert.equal(isTranslatable('1st'), true)
  assert.equal(isTranslatable('Hello, world!'), true)
})


test('scrolling a selection outside any viewport edge hides its chip', () => {
  const measured = { top: 400, bottom: 420, left: 100, right: 300, scrollX: 1000, scrollY: 1000 }
  for (const scroll of [
    { scrollX: 1000, scrollY: 1420 },
    { scrollX: 1000, scrollY: 600 },
    { scrollX: 1300, scrollY: 1000 },
    { scrollX: 100, scrollY: 1000 },
  ]) {
    const outside = anchorNow(measured, scroll)
    assert.equal(intersectsViewport(outside, viewport), false)
    const restored = anchorNow(outside, { scrollX: 1000, scrollY: 1000 })
    assert.equal(intersectsViewport(restored, viewport), true, 'scrolling back restores visibility')
  }
})

test('a partly visible selection still offers its chip', () => {
  for (const anchor of [
    { top: -10, bottom: 10, left: 100, right: 200 },
    { top: 790, bottom: 810, left: 100, right: 200 },
    { top: 100, bottom: 120, left: -10, right: 10 },
    { top: 100, bottom: 120, left: 990, right: 1010 },
  ]) {
    assert.equal(intersectsViewport(anchor, viewport), true)
  }
})
