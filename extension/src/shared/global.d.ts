import type Browser from 'webextension-polyfill'

declare global {
  /** Safari exposes the promise-based `browser` namespace natively — no polyfill shipped. */
  const browser: Browser.Browser
}

export {}
