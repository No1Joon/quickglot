import { TARGET_SETTING, type LanguagesResponse } from '../shared/messages'

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
  const stored = await browser.storage.local.get(TARGET_SETTING)
  const current = typeof stored[TARGET_SETTING] === 'string' ? stored[TARGET_SETTING] : ''

  const res = (await browser.runtime.sendNativeMessage(NATIVE_APP, {
    type: 'languages',
  })) as LanguagesResponse | undefined

  if (!res || !res.ok) {
    fail(res?.message ?? 'Could not read the supported languages.')
    return
  }

  for (const language of res.languages) {
    const option = document.createElement('option')
    option.value = language.code
    option.textContent = language.name
    select.append(option)
  }

  select.value = current
  // A stored language the system no longer supports would silently fall back to
  // Automatic; make that visible rather than pretending the setting still holds.
  if (current && select.value !== current) {
    fail(`${current} is no longer available — falling back to Automatic.`)
    await browser.storage.local.set({ [TARGET_SETTING]: '' })
  }
  select.disabled = false
}

select.addEventListener('change', () => {
  void browser.storage.local.set({ [TARGET_SETTING]: select.value })
  hint.classList.remove('error')
  hint.textContent = select.value
    ? 'Text already in this language is left alone.'
    : AUTO_HINT
})

void load()
