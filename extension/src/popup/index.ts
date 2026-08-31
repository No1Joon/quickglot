import type { SettingsResponse } from '../shared/messages'

const NATIVE_APP = 'application.id'

const select = document.getElementById('target') as HTMLSelectElement
const hint = document.getElementById('hint') as HTMLParagraphElement
const label = document.getElementById('label') as HTMLLabelElement

const t = (key: string, ...args: string[]) => browser.i18n.getMessage(key, args)

const AUTO_HINT = t('popupAutoHint')
const PINNED_HINT = t('popupPinnedHint')

function fail(message: string): void {
  hint.textContent = message
  hint.classList.add('error')
}

// The markup ships empty so no English flashes before the localised text lands.
label.textContent = t('popupTranslateInto')
const automaticOption = select.options[0]
if (automaticOption) automaticOption.textContent = t('popupAutomatic')
hint.textContent = AUTO_HINT

async function load(): Promise<void> {
  // The setting lives in the app group, shared with the QuickGlot app, so it is
  // read through the native handler rather than from extension storage.
  const res = (await browser.runtime.sendNativeMessage(NATIVE_APP, {
    type: 'settings',
  })) as SettingsResponse | undefined

  if (!res || !res.ok) {
    fail(res?.message ?? t('popupSettingsFailed'))
    return
  }

  for (const language of res.languages) {
    const option = document.createElement('option')
    option.value = language.code
    option.textContent = language.name
    select.append(option)
  }

  select.value = res.target
  // A stored language the system no longer supports would silently fall back to
  // Automatic; make that visible rather than pretending the setting still holds.
  // The warning has to be the last word here — writing the ordinary hint
  // afterwards would erase it and leave the error styling on a normal message.
  if (res.target && select.value !== res.target) {
    fail(t('popupLanguageGone', res.target))
    await save('')
  } else {
    hint.textContent = select.value ? PINNED_HINT : AUTO_HINT
  }
  select.disabled = false
}

async function save(target: string): Promise<void> {
  await browser.runtime.sendNativeMessage(NATIVE_APP, { type: 'setTarget', target })
  // The background caches the target for its request cache key, so it has to be
  // told rather than left to notice.
  try {
    await browser.runtime.sendMessage({ type: 'targetChanged', target })
  } catch {
    // The background may be asleep; it re-reads the setting when it wakes.
  }
}

select.addEventListener('change', () => {
  void save(select.value)
  hint.classList.remove('error')
  hint.textContent = select.value ? PINNED_HINT : AUTO_HINT
})

void load()
