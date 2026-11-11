import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import type { TranslateResponse } from '../shared/messages.ts'

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

async function harness(touch = true, initialize = true) {
  const handlers = new Map<string, Array<(event: object) => void>>()
  const timers = new Map<number, { callback: () => void; at: number }>()
  let now = 0
  let respond: () => Promise<TranslateResponse> = async () =>
    ({ ok: true, text: '안녕하세요', source: 'en', target: 'ko', pinned: '' })
  let id = 0
  let text = 'Hello there'
  let top = 300
  let node = {}
  let endNode: object | undefined
  let ancestor: object | undefined
  const intersected = new Set<object>()
  class FakeElement {
    parentElement: FakeElement | null = null
    children: FakeElement[] = []
    querySelectorAll() { return this.children }
  }
  class FakeHTMLElement extends FakeElement { isContentEditable = false }
  class FakeInput extends FakeHTMLElement {}
  class FakeTextArea extends FakeHTMLElement {}
  class FakeDocument extends FakeElement {}
  class FakeDocumentFragment extends FakeElement {}
  let offset = 0
  let requests = 0
  const requestedTexts: string[] = []
  const addEventListener = (name: string, callback: (event: object) => void) => {
    handlers.set(name, [...(handlers.get(name) ?? []), callback])
  }
  const window = {
    innerWidth: 390, innerHeight: 800, scrollX: 0, scrollY: 0,
    matchMedia: () => ({ matches: touch }), addEventListener,
    setTimeout: (callback: () => void, delay = 0) => {
      timers.set(++id, { callback, at: now + delay }); return id
    },
    clearTimeout: (key: number) => timers.delete(key),
  }
  const context = {
    window, console: { debug() {} }, performance,
    Node: FakeElement, Element: FakeElement, HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextArea,
    Document: FakeDocument, DocumentFragment: FakeDocumentFragment,
    document: {
      addEventListener,
      getSelection: () => ({
        isCollapsed: text === '', rangeCount: 1, anchorNode: null,
        toString: () => text,
        getRangeAt: () => ({ startContainer: node, endContainer: endNode ?? node,
          commonAncestorContainer: ancestor ?? node,
          intersectsNode: (element: object) => intersected.has(element),
          startOffset: offset, endOffset: offset + text.length, getBoundingClientRect: () => ({
          top: top - window.scrollY, bottom: top + 20 - window.scrollY,
          left: 20, right: 180, width: 160, height: 20,
        }) }),
      }),
    },
    browser: { runtime: { sendMessage: async (message: { text: string }) => {
      requests++
      requestedTexts.push(message.text)
      return respond()
    } }, i18n: { getMessage: (key: string) => key } },
    rendered: null as null | { kind: string; text?: string },
  }
  runInNewContext((await bundled).outputFiles![0]!.text, context)
  const emit = (type: string, event = {}) => handlers.get(type)?.forEach(fn => fn({
    pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10, timeStamp: 100,
    ...event,
  }))
  const advance = async (ms: number) => {
    const until = now + ms
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
      await setImmediate()
    }
    now = until
    await setImmediate()
  }
  const settleSelection = async () => {
    emit('selectionchange')
    await advance(300)
  }
  if (initialize) {
    if (touch) await settleSelection()
    else { emit('mouseup'); await advance(0) }
    assert.equal(context.rendered?.kind, 'result')
  }
  return { context, emit, settleSelection, advance, requestedTexts,
    rendered: () => context.rendered,
    setResponse: (value: typeof respond) => { respond = value },
    setText: (value: string) => { text = value },
    setTop: (value: number) => { top = value },
    setRange: (start: object, end: object, common: object, covered: object[] = []) => {
      node = start; endNode = end; ancestor = common
      intersected.clear()
      covered.forEach(element => intersected.add(element))
    },
    changeNode: () => { node = {} }, changeOffset: () => { offset += 20 }, requests: () => requests }
}

test('iOS scroll gesture and toolbar resize preserve the translated result', async () => {
  const h = await harness()
  h.emit('pointerdown', { target: 'page' })
  h.context.window.scrollY = 100
  h.emit('scroll')
  h.emit('pointercancel', { target: 'page' })
  h.context.window.innerHeight = 900
  h.emit('resize')
  await h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
  assert.equal(h.requests(), 1)
  h.setText('')
  await h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
})

test('selection touching editable content never sends a translation request', async () => {
  for (const kind of ['input', 'textarea', 'editable']) {
    for (const location of ['start', 'end', 'inside']) {
      const h = await harness()
      h.emit('keydown', { key: 'Escape' })
      const outside = new h.context.HTMLElement()
      const editor = kind === 'input' ? new h.context.HTMLInputElement()
        : kind === 'textarea' ? new h.context.HTMLTextAreaElement()
          : Object.assign(new h.context.HTMLElement(), { isContentEditable: true })
      const textNode = { parentElement: editor }
      const common = new h.context.HTMLElement()
      common.children = location === 'inside' ? [editor] : []
      h.setRange(location === 'start' ? textNode : outside,
        location === 'end' ? textNode : outside, common, [editor])
      await h.settleSelection()
      assert.equal(h.context.rendered, null, `${kind} at ${location}`)
      assert.equal(h.requests(), 1, 'only the harness setup translated')
    }
  }
})

test('an editor outside the selection does not block ordinary text', async () => {
  const h = await harness()
  h.emit('keydown', { key: 'Escape' })
  const outside = new h.context.HTMLElement()
  const common = new h.context.HTMLElement()
  common.children = [new h.context.HTMLInputElement()]
  h.setRange(outside, outside, common)
  await h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
  assert.equal(h.requests(), 2)
})

test('completed outside tap dismisses, but tapping the panel does not', async () => {
  const h = await harness()
  h.emit('pointerdown', { target: 'panel' })
  h.emit('pointerup', { target: 'panel' })
  assert.equal(h.context.rendered?.kind, 'result')
  h.emit('pointerdown', { target: 'page' })
  h.emit('pointerup', { target: 'page' })
  assert.equal(h.context.rendered, null)
  await h.settleSelection()
  assert.equal(h.context.rendered, null)
  assert.equal(h.requests(), 1)
})

test('rotation invalidates the anchor', async () => {
  const h = await harness()
  h.context.window.innerWidth = 800
  h.emit('resize')
  assert.equal(h.context.rendered, null)
})

test('selecting identical words elsewhere automatically translates the new DOM range', async () => {
  const h = await harness()
  h.setTop(600)
  h.changeNode()
  await h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
  assert.equal(h.requests(), 2)
})

test('subpixel drift of the same DOM selection preserves the result', async () => {
  const h = await harness()
  h.context.window.scrollY = 100.3333
  h.setTop(300.3333)
  await h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
})

test('identical text at different offsets is a new selection', async () => {
  const h = await harness()
  h.changeOffset()
  await h.settleSelection()
  assert.equal(h.context.rendered?.kind, 'result')
  assert.equal(h.requests(), 2)
})

test('drags, scrolls, cancellations, long presses and multi-touch are not taps', async () => {
  for (const gesture of ['move', 'scroll', 'cancel', 'hold', 'multi', 'up-moved']) {
    const h = await harness()
    h.emit('pointerdown', { target: 'page' })
    if (gesture === 'move') h.emit('pointermove', { clientY: 50 })
    if (gesture === 'scroll') h.emit('scroll')
    if (gesture === 'cancel') h.emit('pointercancel')
    if (gesture === 'multi') h.emit('pointerdown', { pointerId: 2, isPrimary: false })
    h.emit('pointerup', { target: 'page',
      timeStamp: gesture === 'hold' ? 800 : 200,
      clientY: gesture === 'up-moved' ? 50 : 10,
    })
    assert.equal(h.context.rendered?.kind, 'result', gesture)
  }
})

test('iOS automatically translates only after the latest selection settles for 300ms', async () => {
  const h = await harness(true, false)
  h.emit('selectionchange')
  await h.advance(299)
  assert.equal(h.requests(), 0)
  h.setText('Hello world')
  h.emit('selectionchange')
  await h.advance(299)
  assert.equal(h.requests(), 0)
  await h.advance(1)
  assert.equal(h.requests(), 1)
  assert.deepEqual(h.requestedTexts, ['Hello world'])
  assert.equal(h.context.rendered?.kind, 'result')
  await h.settleSelection()
  assert.equal(h.requests(), 1)
})

test('selection changes invalidate an in-flight response before the debounce expires', async () => {
  const h = await harness(true, false)
  let finish!: (response: TranslateResponse) => void
  h.setResponse(() => new Promise(resolve => { finish = resolve }))
  await h.settleSelection()
  h.setText('Another sentence')
  h.emit('selectionchange')
  finish({ ok: true, text: 'stale', source: 'en', target: 'ko', pinned: '' })
  await h.advance(200)
  assert.equal(h.context.rendered, null, 'neither the old result nor its loading panel returns')
  assert.equal(h.requests(), 1)
  h.setResponse(async () => ({ ok: true, text: 'new', source: 'en', target: 'ko', pinned: '' }))
  await h.advance(100)
  assert.equal(h.rendered()?.text, 'new')
  assert.equal(h.requests(), 2)
})

test('deselection and dismissal cancel a pending automatic translation', async () => {
  for (const action of ['deselect', 'escape', 'rotate', 'tap']) {
    const h = await harness(true, false)
    h.emit('selectionchange')
    if (action === 'deselect') { h.setText(''); h.emit('selectionchange') }
    if (action === 'escape') h.emit('keydown', { key: 'Escape' })
    if (action === 'rotate') { h.context.window.innerWidth = 800; h.emit('resize') }
    if (action === 'tap') { h.emit('pointerdown'); h.emit('pointerup') }
    await h.advance(1000)
    assert.equal(h.requests(), 0, action)
    assert.equal(h.context.rendered, null, action)
  }
})

test('same-language automatic translations remain silent', async () => {
  const h = await harness(true, false)
  h.setResponse(async () => ({ ok: false, error: 'sameLanguage', message: '' }))
  await h.settleSelection()
  await h.advance(1000)
  assert.equal(h.context.rendered, null)
  await h.settleSelection()
  assert.equal(h.requests(), 1)
})

test('macOS continues to translate on mouseup without the touch debounce', async () => {
  const h = await harness(false, false)
  h.emit('selectionchange')
  await h.advance(1000)
  assert.equal(h.requests(), 0)
  h.emit('mouseup', { target: 'page' })
  await h.advance(0)
  assert.equal(h.requests(), 1)
  assert.equal(h.context.rendered?.kind, 'result')
})

test('a stalled bridge stops loading after 30 seconds and the same range can retry', async () => {
  const h = await harness(true, false)
  let finish!: (response: TranslateResponse) => void
  h.setResponse(() => new Promise(resolve => { finish = resolve }))
  await h.settleSelection()
  await h.advance(29_999)
  assert.equal(h.rendered()?.kind, 'loading')
  await h.advance(1)
  assert.equal(h.rendered()?.kind, 'error')
  h.setResponse(async () => ({ ok: true, text: 'retried', source: 'en', target: 'ko', pinned: '' }))
  await h.settleSelection()
  assert.equal(h.requests(), 2)
  assert.equal(h.rendered()?.text, 'retried')
  finish({ ok: true, text: 'late', source: 'en', target: 'ko', pinned: '' })
  await h.advance(30_000)
  assert.equal(h.rendered()?.text, 'retried')
})

test('bridge rejection and translation failures allow the same iOS range to retry', async () => {
  for (const failure of ['rejection', 'notInstalled', 'unknown'] as const) {
    const h = await harness(true, false)
    h.setResponse(async () => {
      if (failure === 'rejection') throw new Error('bridge unavailable')
      return { ok: false, error: failure, message: 'failed' }
    })
    await h.settleSelection()
    assert.equal(h.rendered()?.kind, 'error', failure)
    h.setResponse(async () => ({ ok: true, text: 'recovered', source: 'en', target: 'ko', pinned: '' }))
    await h.settleSelection()
    assert.equal(h.requests(), 2, failure)
    assert.equal(h.rendered()?.text, 'recovered', failure)
    await h.settleSelection()
    assert.equal(h.requests(), 2, 'success is still deduplicated')
  }
})

test('dismissal and a newer selection suppress the old timeout and late rejection', async () => {
  for (const action of ['dismiss', 'replace']) {
    const h = await harness(true, false)
    let reject!: (error: Error) => void
    h.setResponse(() => new Promise((_, fail) => { reject = fail }))
    await h.settleSelection()
    if (action === 'dismiss') h.emit('keydown', { key: 'Escape' })
    else {
      h.setText('Another sentence')
      h.setResponse(async () => ({ ok: true, text: 'new', source: 'en', target: 'ko', pinned: '' }))
      await h.settleSelection()
    }
    reject(new Error('late failure'))
    await h.advance(31_000)
    if (action === 'dismiss') assert.equal(h.rendered(), null)
    else assert.equal(h.rendered()?.text, 'new')
  }
})

test('Mac keyboard selection translates after release and 300ms of rest', async () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
    const h = await harness(false, false)
    const modifiers = { shiftKey: true }
    h.emit('keydown', { key, ...modifiers })
    h.emit('keydown', { key, repeat: true, ...modifiers })
    await h.advance(1000)
    assert.equal(h.requests(), 0, key)
    // Selection modifiers may be released before the navigation key itself.
    h.emit('keyup', { key })
    await h.advance(299)
    assert.equal(h.requests(), 0, key)
    await h.advance(1)
    assert.equal(h.requests(), 1, key)
    assert.equal(h.rendered()?.kind, 'result', key)
  }
})

test('Mac Command selection shortcuts work without a keyup event', async () => {
  for (const event of [
    { key: 'a', metaKey: true }, { key: 'A', metaKey: true },
    { key: 'a', ctrlKey: true }, { key: 'ArrowRight', shiftKey: true, metaKey: true },
  ]) {
    const h = await harness(false, false)
    h.emit('keydown', event)
    await h.advance(200)
    h.emit('keydown', { ...event, repeat: true })
    await h.advance(299)
    assert.equal(h.requests(), 0)
    await h.advance(1)
    assert.equal(h.requests(), 1)
    h.emit('keyup', { key: event.key })
    await h.advance(1000)
    assert.equal(h.requests(), 1, 'keyup does not translate twice')
  }
})

test('Mac selection keystrokes debounce and invalidate the previous response immediately', async () => {
  const h = await harness(false, false)
  let finish!: (response: TranslateResponse) => void
  h.setResponse(() => new Promise(resolve => { finish = resolve }))
  h.emit('mouseup')
  await h.advance(0)
  h.setText('Another sentence')
  h.emit('keydown', { key: 'ArrowRight', shiftKey: true })
  h.emit('keyup', { key: 'ArrowRight' })
  await h.advance(200)
  h.emit('keydown', { key: 'ArrowRight', shiftKey: true })
  h.emit('keyup', { key: 'ArrowRight' })
  finish({ ok: true, text: 'stale', source: 'en', target: 'ko', pinned: '' })
  await h.advance(299)
  assert.equal(h.rendered(), null)
  h.setResponse(async () => ({ ok: true, text: 'new', source: 'en', target: 'ko', pinned: '' }))
  await h.advance(1)
  assert.equal(h.requests(), 2)
  assert.equal(h.rendered()?.text, 'new')
})

test('ordinary, prevented and composing Mac keys do not request translation', async () => {
  const h = await harness(false, false)
  for (const event of [
    { key: 'ArrowRight' }, { key: 'a' }, { key: 'c', metaKey: true },
    { key: 'ArrowRight', shiftKey: true, defaultPrevented: true },
    { key: 'ArrowRight', shiftKey: true, isComposing: true },
  ]) {
    h.emit('keydown', event)
    h.emit('keyup', { key: event.key })
    await h.advance(1000)
  }
  assert.equal(h.requests(), 0)
})

test('Mac editable selections and editor keystrokes never translate', async () => {
  for (const inEditor of [true, false]) {
    const h = await harness(false, false)
    const input = new h.context.HTMLInputElement()
    if (!inEditor) h.setRange(input, input, input)
    h.emit('keydown', { key: 'a', metaKey: true, target: inEditor ? input : 'page' })
    h.emit('keyup', { key: 'a' })
    await h.advance(1000)
    assert.equal(h.requests(), 0)
  }
})

test('Escape, blur and mouse interaction cancel pending Mac keyboard translation', async () => {
  for (const action of ['escape-before-release', 'escape-after-release', 'blur', 'mouse']) {
    const h = await harness(false, false)
    h.emit('keydown', { key: 'ArrowRight', shiftKey: true })
    if (action === 'escape-before-release') h.emit('keydown', { key: 'Escape' })
    h.emit('keyup', { key: 'ArrowRight' })
    if (action === 'escape-after-release') h.emit('keydown', { key: 'Escape' })
    if (action === 'blur') h.emit('blur')
    if (action === 'mouse') h.emit('mousedown')
    await h.advance(1000)
    assert.equal(h.requests(), 0, action)
  }
})
