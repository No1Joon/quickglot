import {
  MAX_SELECTION_LENGTH,
  type SettingsResponse,
  type TranslateRequest,
  type TranslateResponse,
} from '../shared/messages'
import { cacheKey } from '../shared/logic'

/** Safari ignores this identifier and routes to the containing app's extension handler. */
const NATIVE_APP = 'application.id'

const CACHE_LIMIT = 200
const cache = new Map<string, TranslateResponse>()

function remember(key: string, res: TranslateResponse): void {
  // Only successes are worth keeping — a `notInstalled` answer goes stale the
  // moment the user downloads the language pack in the container app.
  if (!res.ok) return
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, res)
}

async function translate(req: TranslateRequest): Promise<TranslateResponse> {
  const key = cacheKey(req)
  const hit = cache.get(key)
  if (hit) return hit

  try {
    const res = (await browser.runtime.sendNativeMessage(
      NATIVE_APP,
      req,
    )) as TranslateResponse | undefined

    if (!res || typeof res !== 'object' || !('ok' in res)) {
      return { ok: false, error: 'unknown', message: 'Malformed native response' }
    }
    remember(key, res)
    return res
  } catch (e) {
    return {
      ok: false,
      error: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * The pinned target, cached for this worker's lifetime. It is only needed to key
 * the response cache — the native side reads the same shared setting and would
 * resolve the target anyway.
 */
let pinnedTarget: string | undefined
let targetLoaded = false

async function resolveTarget(): Promise<string | undefined> {
  if (targetLoaded) return pinnedTarget
  try {
    const res = (await browser.runtime.sendNativeMessage(NATIVE_APP, {
      type: 'settings',
    })) as SettingsResponse | undefined
    pinnedTarget = res && res.ok && res.target ? res.target : undefined
  } catch {
    pinnedTarget = undefined
  }
  targetLoaded = true
  return pinnedTarget
}

browser.runtime.onMessage.addListener(
  (message: unknown): Promise<TranslateResponse> | undefined => {
    const req = message as TranslateRequest | { type: 'targetChanged'; target: string }
    if (!req) return undefined

    if (req.type === 'targetChanged') {
      pinnedTarget = req.target || undefined
      targetLoaded = true
      // Entries keyed to the old target would answer in the wrong language.
      cache.clear()
      return undefined
    }

    if (req.type !== 'translate') return undefined

    const text = typeof req.text === 'string' ? req.text.trim() : ''
    if (!text) {
      return Promise.resolve({ ok: false, error: 'undetectable', message: 'Empty selection' })
    }

    return resolveTarget().then((target) =>
      translate({
        type: 'translate',
        text: text.slice(0, MAX_SELECTION_LENGTH),
        target,
      }),
    )
  },
)
