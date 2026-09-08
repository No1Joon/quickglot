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
 * The pinned target, read before every request. It is only needed to key the
 * response cache — the native side reads the same shared setting and would
 * resolve the target anyway. It cannot be cached for the worker's lifetime: the
 * popup announces its changes, but the app writes the same setting from its
 * "To" row and has no way to tell this worker, so a remembered value would key
 * cache hits to a language the user has since moved away from.
 */
async function resolveTarget(): Promise<string | undefined> {
  try {
    const res = (await browser.runtime.sendNativeMessage(NATIVE_APP, {
      type: 'target',
    })) as SettingsResponse | undefined
    return res && res.ok && res.target ? res.target : undefined
  } catch {
    return undefined
  }
}

browser.runtime.onMessage.addListener(
  (message: unknown): Promise<TranslateResponse> | undefined => {
    const req = message as TranslateRequest | { type: 'targetChanged'; target: string }
    if (!req) return undefined

    if (req.type === 'targetChanged') {
      // Entries keyed to the old target are unreachable now; drop them rather
      // than let them fill the cache.
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
