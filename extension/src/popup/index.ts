import type { SettingsResponse } from '../shared/messages'

const NATIVE_APP = 'application.id'

const select = document.getElementById('target') as HTMLSelectElement
const hint = document.getElementById('hint') as HTMLParagraphElement

const AUTO_HINT =
  'Automatic picks the first of your system languages that differs from the selected text.'

function fail(message: string): void {
  hint.textContent = message
  hint.classList.add('error')
}

async function load(): Promise<void> {
  // The setting lives in the app group, shared with the QuickGlot app, so it is
  // read through the native handler rather than from extension storage.
  const res = (await browser.runtime.sendNativeMessage(NATIVE_APP, {
    type: 'settings',
  })) as SettingsResponse | undefined

  if (!res || !res.ok) {
    fail(res?.message ?? 'Could not read the settings.')
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
  if (res.target && select.value !== res.target) {
    fail(`${res.target} is no longer available — falling back to Automatic.`)
    await save('')
  }
  hint.textContent = select.value ? PINNED_HINT : AUTO_HINT
  select.disabled = false
}

const PINNED_HINT = 'Text already in this language is left alone.'

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
