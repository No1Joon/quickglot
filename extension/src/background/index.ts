import {
  MAX_SELECTION_LENGTH,
  type SettingsResponse,
  type TranslateRequest,
  type TranslateResponse,
} from '../shared/messages'

/** Safari ignores this identifier and routes to the containing app's extension handler. */
const NATIVE_APP = 'application.id'

const CACHE_LIMIT = 200

/**
 * Keyed by text alone. The pinned target the answer was produced under rides
 * along in the entry, and a hit is only served after the native side confirms
 * that setting is still current — see `translate` for why that check cannot
 * happen up front.
 */
interface Entry {
  pinned: string
  res: Extract<TranslateResponse, { ok: true }>
}
const cache = new Map<string, Entry>()

function remember(text: string, res: TranslateResponse): void {
  // Only successes are worth keeping — a `notInstalled` answer goes stale the
  // moment the user downloads the language pack in the container app.
  if (!res.ok) return
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(text, { pinned: res.pinned, res })
}

/**
 * The pinned target as the native side sees it right now. The popup announces
 * its own changes, but the app writes the same setting from its "To" row and
 * has no way to tell this worker, so a remembered value could serve a cached
 * translation into a language the user has since moved away from.
 */
async function currentPinned(): Promise<string | undefined> {
  try {
    const res = (await browser.runtime.sendNativeMessage(NATIVE_APP, {
      type: 'target',
    })) as SettingsResponse | undefined
    return res && res.ok ? res.target : undefined
  } catch {
    return undefined
  }
}

/**
 * One native round trip on the common path. Asking for the pinned target first
 * and then translating doubled the cost on iOS, where each message can mean
 * launching the handler process. So the native side resolves the target itself
 * and reports what it used; only a cache hit pays for the extra question, and
 * that is still cheaper than translating again.
 */
async function translate(req: TranslateRequest): Promise<TranslateResponse> {
  const hit = cache.get(req.text)
  if (hit) {
    const pinned = await currentPinned()
    if (pinned === hit.pinned) return hit.res
    cache.delete(req.text)
  }

  try {
    const res = (await browser.runtime.sendNativeMessage(
      NATIVE_APP,
      req,
    )) as TranslateResponse | undefined

    if (!res || typeof res !== 'object' || !('ok' in res)) {
      return { ok: false, error: 'unknown', message: 'Malformed native response' }
    }
    remember(req.text, res)
    return res
  } catch (e) {
    return {
      ok: false,
      error: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    }
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

    return translate({ type: 'translate', text: text.slice(0, MAX_SELECTION_LENGTH) })
  },
)
