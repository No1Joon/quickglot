import {
  MAX_SELECTION_LENGTH,
  TARGET_SETTING,
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

/** The pinned target language, or undefined to let the native side choose. */
async function resolveTarget(): Promise<string | undefined> {
  try {
    const stored = await browser.storage.local.get(TARGET_SETTING)
    const value = stored[TARGET_SETTING]
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

browser.runtime.onMessage.addListener(
  (message: unknown): Promise<TranslateResponse> | undefined => {
    const req = message as TranslateRequest
    if (!req || req.type !== 'translate') return undefined

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
