/** Wire protocol shared by content script, background, and the native Swift handler. */

export interface SettingsRequest {
  type: 'settings'
}

export interface SetTargetRequest {
  type: 'setTarget'
  /** BCP-47 tag, or empty string for automatic. */
  target: string
}

/** Sent from the popup to the background when the pinned target changes. */
export interface TargetChangedMessage {
  type: 'targetChanged'
  target: string
}

export interface Language {
  /** BCP-47 language code, e.g. "ko". */
  code: string
  /** Localised display name for the user's own locale. */
  name: string
}

export type SettingsResponse =
  | { ok: true; target: string; languages: Language[] }
  | { ok: false; message: string }

export interface TranslateRequest {
  type: 'translate'
  /** Raw selected text, already trimmed and length-capped by the content script. */
  text: string
  /** BCP-47 tag. Omit to let the native side use the user's preferred language. */
  target?: string
}

export type TranslateFailure =
  /** Language pair is supported but not downloaded — the container app must fetch it. */
  | 'notInstalled'
  /** Apple's models don't cover this pair. */
  | 'unsupported'
  /** Source language could not be identified from the selection. */
  | 'undetectable'
  /** The selection is already in the user's language and English is unavailable as a fallback. */
  | 'sameLanguage'
  | 'unknown'

export type TranslateResponse =
  | { ok: true; text: string; source: string; target: string }
  | { ok: false; error: TranslateFailure; message: string; source?: string }

export const MAX_SELECTION_LENGTH = 5000
