# Privacy Policy — QuickGlot

**QuickGlot does not collect, transmit, or store your data. There is no server.**

## What the extension does

When you select text on a web page, QuickGlot passes that selection to Apple's
on-device Translation framework and shows the result next to your selection.

## Where your text goes

Nowhere. The selected text is handed to the operating system's local translation
models and the result comes straight back. It is never sent over the network,
because the extension makes no network requests of any kind — there is no
backend, no analytics service, no crash reporter, and no third-party SDK. The
developer operates no servers and therefore never receives your text, your
browsing history, or anything else.

This also means translation works with the device offline, once the language
pack has been downloaded.

## What is stored

One setting — the language you chose to translate into — kept in the browser's
local extension storage on your device. Nothing else is written anywhere.

Recently translated selections are held in memory only, to avoid re-translating
the same phrase, and are discarded when the browser releases the extension.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| Access to the pages you visit (`<all_urls>`) | Translating a selection requires reading the selection, which can only be done from within the page. There is no way to scope this ahead of time, because any page may be the one you want to translate. Safari lets you narrow this per site in Settings → Extensions. |
| `nativeMessaging` | Carries the selected text to the app's local translation handler. It talks only to QuickGlot's own bundled handler on this device. |
| `storage` | Remembers the target language you picked. |

QuickGlot deliberately does **not** request permission for tabs, browsing
history, cookies, downloads, or any remote host.

## Safeguards

- Text inside password fields, text inputs, and editable areas is ignored.
- Diagnostic logs record only the character count and the language pair, never
  the text itself or its translation.
- The on-page panel is rendered in a closed shadow root, so scripts on the page
  cannot read what was translated.

## Verify it yourself

QuickGlot is open source. The claims above are checkable in the code — in
particular, searching the extension sources for any networking call returns
nothing.

Source: TODO({{REPO_URL}})

## Contact

TODO({{CONTACT_EMAIL}})

## Changes

Any change to this policy will be committed to the repository above, so its
history is public.
