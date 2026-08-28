import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheKey, placement, RTL_LANGUAGES, toPageCoordinates, GAP, MARGIN } from './logic.ts'

const viewport = { width: 1000, height: 800 }
const size = { width: 300, height: 200 }

test('cache key keeps target and text distinguishable', () => {
  const key = cacheKey({ text: 'hello', target: 'ko' })
  assert.ok(key.startsWith('ko'), 'key should begin with the target')
  assert.ok(key.endsWith('hello'), 'key should end with the text')
  assert.equal(cacheKey({ text: 'hello', target: 'ko' }), key, 'same input, same key')
})

test('cache key distinguishes automatic from a pinned target', () => {
  assert.notEqual(cacheKey({ text: 'hello' }), cacheKey({ text: 'hello', target: 'ko' }))
})

test('cache key cannot collide by shifting the boundary', () => {
  // Without a separator, target "ko" + text "rean" and target "korean" + text ""
  // would produce the same key.
  assert.notEqual(cacheKey({ text: 'rean', target: 'ko' }), cacheKey({ text: '', target: 'korean' }))
})

test('panel sits below the selection when there is room', () => {
  const anchor = { top: 100, bottom: 120, left: 400, right: 600 }
  const { top, left } = placement(anchor, size, viewport)
  assert.equal(top, 120 + GAP)
  // horizontally centred on the selection
  assert.equal(left, 500 - size.width / 2)
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
