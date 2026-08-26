---
title: Privacy Policy
description: QuickGlot collects, transmits, and stores nothing
---

**QuickGlot does not collect, transmit, or store your data. There is no server.**

Last updated: 26 August 2026

## What the extension does

When you select text on a web page, QuickGlot passes that selection to Apple's
on-device Translation framework and shows the result next to your selection.

## Where your text goes

Nowhere. The selected text is handed to the operating system's local translation models and the result comes straight back. It is never sent over the network, because the extension makes no network requests of any kind — there is no backend, no analytics service, no crash reporter, and no third-party SDK. The developer operates no servers and therefore has no way to receive your text, your browsing history, or anything else.

For the same reason, translation keeps working with the device offline once the language pack has been downloaded.

To be explicit about what a browser extension inherently does: QuickGlot reads the text you select on a page, because that is the text being translated. It reads; it does not transmit, store, or share.

## What is stored

One setting — the language you chose to translate into — kept in the browser's local extension storage on your device. Nothing else is written anywhere.

Recently translated selections are held in memory only, to avoid re-translating the same phrase, and are discarded when the browser releases the extension.

## Accounts

QuickGlot has no accounts. There is no sign-up, no sign-in, and no user identifier, so there is no account data to delete.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| Access to the pages you visit | Translating a selection requires reading the selection, which can only be done from within the page. Any page may be the one you want to translate, so this cannot be narrowed ahead of time. Safari lets you restrict it per site in Settings → Extensions. |
| Native messaging | Carries the selected text to the app's local translation handler on the same device. It talks only to QuickGlot's own handler. |
| Storage | Remembers the target language you picked. |

QuickGlot does **not** request permission for tabs, browsing history, cookies, downloads, or any remote host.

## Safeguards

- Text inside password fields, text inputs, and editable areas is ignored.
- Diagnostic logs record only the character count and the language pair, never the text itself or its translation.
- The on-page panel is rendered in a closed shadow root, so scripts on the page cannot read what was translated.

## Verify it yourself

QuickGlot is open source. The claims above are checkable in the code — in particular, searching the extension sources for any networking call returns nothing.

Source: [github.com/No1Joon/quickglot](https://github.com/No1Joon/quickglot)

## Children's privacy

QuickGlot collects no personal information from any user, and therefore collects none from children.

## Contact

Please open an issue at [GitHub Issues](https://github.com/No1Joon/quickglot/issues).

## Changes

Any change to this policy is committed to the repository above, so its history is public.
