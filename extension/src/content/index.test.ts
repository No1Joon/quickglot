import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'

// Run the real event handlers with a controlled Safari event stream. Only the
// renderer and browser APIs are substituted; selection and dismissal stay real.
const bundled = build({
  entryPoints: ['extension/src/content/index.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  plugins: [{
    name: 'test-renderer',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/ui$/ }, () => ({ path: 'ui', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        export const show = (anchor, content) => globalThis.rendered = content;
        export const dismiss = () => globalThis.rendered = null;
        export const isOwnElement = target => target === 'panel';
      ` }))
    },
  }],
})

async function harness() {
  const handlers = new Map<string, Array<(event: object) => void>>()
  const timers = new Map<number, () => void>()
  let id = 0
  let text = 'Hello there'
  let top = 300
  let requests = 0
  const addEventListener = (name: string, callback: (event: object) => void) => {
    handlers.set(name, [...(handlers.get(name) ?? []), callback])
  }
  const window = {
    innerWidth: 390, innerHeight: 800, scrollX: 0, scrollY: 0,
    matchMedia: () => ({ matches: true }), addEventListener,
    setTimeout: (callback: () => void) => { timers.set(++id, callback); return id },
    clearTimeout: (key: number) => timers.delete(key),
  }
  const context = {
    window, console: { debug() {} }, performance,
    Element: class {}, HTMLElement: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    document: {
      addEventListener,
      getSelection: () => ({
        isCollapsed: text === '', rangeCount: 1, anchorNode: null,
        toString: () => text,
        getRangeAt: () => ({ getBoundingClientRect: () => ({
          top: top - window.scrollY, bottom: top + 20 - window.scrollY,
          left: 20, right: 180, width: 160, height: 20,
        }) }),
      }),
    },
    browser: { runtime: { sendMessage: async () => {
      requests++
      return { ok: true, text: '안녕하세요', source: 'en', target: 'ko', pinned: '' }
    } } },
    rendered: null as null | { kind: string; onTap?: () => void },
  }
  runInNewContext((await bundled).outputFiles![0]!.text, context)
  const emit = (type: string, event = {}) => handlers.get(type)?.forEach(fn => fn(event))
  const settleSelection = () => {
    emit('selectionchange')
    const pending = [...timers.values()]
    timers.clear()
    pending.forEach(fn => fn())
  }
  settleSelection()
  assert.equal(context.rendered?.kind, 'chip')
  context.rendered?.onTap?.()
  await setImmediate()
  assert.equal(context.rendered?.kind, 'result')
  return { context, emit, settleSelection, setText: (value: string) => { text = value },
    setTop: (value: number) => { top = value }, requests: () => requests }
}

test('iOS scroll gesture and toolbar resize preserve the translated result', async () => {
  const h = await harness()
  h.emit('pointerdown', { target: 'page' })
  h.context.window.scrollY = 100
  h.emit('scroll')
  h.emit('pointercancel', { target: 'page' })
  h.context.window.innerHeight = 900
  h.emit('resize')
  h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
  assert.equal(h.requests(), 1)
  h.setText('')
  h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
})

test('completed outside tap dismisses, but tapping the panel does not', async () => {
  const h = await harness()
  h.emit('click', { target: 'panel' })
  assert.equal(h.context.rendered?.kind, 'result')
  h.emit('click', { target: 'page' })
  assert.equal(h.context.rendered, null)
})

test('rotation invalidates the anchor', async () => {
  const h = await harness()
  h.context.window.innerWidth = 800
  h.emit('resize')
  assert.equal(h.context.rendered, null)
})

test('selecting identical words elsewhere replaces the pinned result with a chip', async () => {
  const h = await harness()
  h.setTop(600)
  h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'chip')
})
