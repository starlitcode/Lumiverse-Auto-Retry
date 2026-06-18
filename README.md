# Auto Retry (Lumiverse Spindle extension)

Automatically re-fires generations that fail, come back empty, stall mid-stream, or get cut off. It is a rebuild of the [SillyTavern fetch-retry](https://github.com/Hikarushmz/fetch-retry) idea for Lumiverse's Spindle framework.

## Why it is built differently

SillyTavern's version monkey-patches the browser's fetch. That cannot work in Lumiverse, because the LLM call runs server-side and streams back over the WebSocket, so there is no browser fetch to intercept. This extension is event-driven: it listens to the host's generation lifecycle events and re-triggers the chat's regenerate control when something goes wrong.

There is also no Spindle API to stop or regenerate a chat reply (checked against the Generation, Chats, Chat Mutation, and UI Automation APIs), so the re-fire clicks the host's own on-screen button. That is the only DOM-dependent part, and it is the part you can fix yourself from the settings if a Lumiverse update ever changes those buttons.

## What it does

- Retries on a provider error.
- Retries on an empty response.
- Retries when a generation is cut off mid-reasoning (reasoning streamed, final content empty).
- Retries when the final response is present but cut off mid-sentence (see Cut-off detection below).
- Retries when the stream stalls mid-flight (tokens stop arriving for idleTimeoutMs), the common shape of a model cutting off mid-generation.
- Retries when a generation never starts streaming or never ends (stuckTimeoutMs).
- Exponential backoff with jitter, plus a longer cooldown when the error looks rate-limited (429, overloaded, quota).
- Optionally retries short responses (off by default).

## You are always in charge

Pressing your **Stop** button, or tapping **Cancel** on the retry pop-up, stops the extension immediately. It cancels any pending retry, resets the retry count, and briefly ignores new automatic retries so a stopped reply's own trailing events can't quietly restart the loop. This holds even under lag or with a customized stop button, because the Cancel button on the pop-up doesn't depend on any selector. The watchdog timeouts also default high enough that a slow-but-fine reply isn't mistaken for a stall and retried into a pile-up.

## Settings UI

Open the chat input bar, click the **Extras** popover, and choose **Auto Retry settings**. Every option is editable there, grouped by what it does. You can test your button selectors against the current screen and reset everything to defaults. The modal is sized to fit phones as well as desktop.

Settings are saved to the browser's `localStorage` and apply to the next generation. They override both the code defaults and any `opts` passed at setup. Editing the CONFIG block in the source still works as the fallback, but the UI is the easy path.

## Reporting a bug

The settings modal has a **Copy debug info** button. It copies a short plain-text snapshot you can paste straight into a bug report, no developer tools needed: the version, your current settings, whether each button selector matches on screen right now, your screen size and browser, and a timeline of the last things the extension did (when generations started, when retries fired and why, when one came back clean). That timeline is recorded whether or not console logging is on, so for most bugs this one button is all anyone needs.

For an even longer, every-step trace for a deep dive, turn on **Write technical details to the console** in the Advanced section, make the problem happen again, then copy what appears in the browser console (press F12).

## Cut-off detection (final response)

The original could only tell a final response was bad when it came back completely empty. A reply that streamed real text and then got chopped off mid-sentence slipped through.

Lumiverse does not put `finish_reason` on the `GENERATION_ENDED` event a frontend extension receives (confirmed against the Generation API: the ended payload is just `generationId`, `chatId`, `messageId`, `content`, `error`). `finish_reason` only exists on generations an extension fires itself, not on the host's chat generations, so there is no clean truncation flag to read.

So detection works off the only signal available frontend-side: the shape of the text. `retryOnTruncated` (on by default) flags a reply as cut off when it has a clearly open structure:

- an unclosed code fence or unclosed inline backtick
- an odd number of emphasis `*` (an open emphasis or roleplay action); markdown bullet lists are ignored so a list doesn't read as a half-open action
- an unbalanced `"` or mismatched smart quotes (open dialogue)
- it ends on a comma or semicolon (cut mid-clause)

These are intentionally conservative to avoid re-rolling good roleplay that legitimately ends on `...`, an em dash, an action, or a closed quote. If you want it stricter, turn on `retryOnNoPunct`, which also retries a reply that ends with no terminal punctuation at all. That one is noisier in roleplay, so it is off by default.

All cut-off retries share the same `maxRetries` budget, so this cannot loop.

## Improvements over the original

- Cannot loop forever. Every retry path shares one hard maxRetries cap per message, and the noisy retry paths are off by default.
- Catches mid-stream, mid-reasoning, and cut-off final responses the original could not see.
- Aborts a stalled run before retrying, and ignores the dead generation's late events so it never double-fires.
- Respects manual stops, and gives you a Cancel button so you can pull the plug even while it is waiting to retry.
- Settings live in one place, in plain language, editable from the UI, and the panel fits on mobile.

## Install

In Lumiverse, open Extensions and install from this extension's repository URL:

```
https://github.com/starlitcode/Lumiverse-Auto-Retry
```

## Configuration

The easiest way is the settings modal (see above). The same options live in the CONFIG block at the top of `src/frontend.ts` and `dist/frontend.js`. `dist/frontend.js` is prebuilt and is the file the host loads, so editing CONFIG there takes effect with no rebuild. Editing `src/frontend.ts` requires a rebuild (`bun build`).

| Option | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch. Can be toggled live from the UI. |
| maxRetries | 4 | Hard cap per message. Cannot loop past this. |
| retryDelayMs | 1200 | Base backoff. |
| backoffFactor | 2 | Exponential growth. |
| maxDelayMs | 30000 | Backoff ceiling. |
| jitter | true | Randomizes each wait slightly so retries don't all land at once. |
| rateLimitDelayMs | 8000 | Floor wait when the error looks rate-limited. |
| stuckTimeoutMs | 90000 | Started but no token and no end within this. 0 disables. |
| idleTimeoutMs | 45000 | Tokens were flowing then stopped for this long. 0 disables. |
| retryOnError | true | Retry provider errors. |
| retryOnEmpty | true | Retry empty responses and mid-reasoning cutoffs. |
| retryOnTruncated | true | Retry a final response that ends mid-sentence (structural heuristic). |
| retryOnNoPunct | false | Stricter: also retry a reply that ends with no terminal punctuation. Noisy in RP. |
| retryOnShort | false | Retry short responses. Leave off unless you mean it. |
| minChars | 24 | Short threshold when retryOnShort is on. |
| regenerateSelector | (see file) | Host-specific. See below. |
| swipeNextSelector | (see file) | Host-specific fallback if the build retries via swipe. |
| stopSelector | (see file) | Host-specific stop button, used to abort a stalled run. |
| toast | true | Show the little retry pop-up (with its Cancel button). |
| log | false | Console logging, for troubleshooting only. |

The watchdog defaults (`stuckTimeoutMs`, `idleTimeoutMs`) lean long on purpose so a slow connection or a slow local model isn't mistaken for a stall. If your provider is fast and you want quicker recovery, lower them in the settings modal.

## Setting regenerateSelector

Spindle has no public API to regenerate a message, so the re-fire clicks the host's existing regenerate or swipe control in the DOM. The default selectors cover common attribute and label patterns but may not match every Lumiverse build, and a future Lumiverse update could rename them.

If retries fire (the pop-up appears) but nothing regenerates, the selector needs adjusting:

1. Open the browser developer tools (F12), with an AI message visible so its action buttons are present.
2. Right-click the regenerate button and choose Inspect.
3. Find a stable attribute on it (a data attribute, an aria-label, a title, or a class) and write a CSS selector that matches it.
4. Put that selector in the settings modal's Regenerate selector field and hit **Test** with an AI message on screen. It will tell you whether it matches. Save when it does.

You can still confirm a selector from the console if you prefer:

```js
document.querySelector(YOUR_SELECTOR_STRING) ? 'MATCH' : 'no match'
```

## Permissions

Declares `generation` to receive generation lifecycle events. The settings UI uses the modal and input-bar-action placements, which need no extra permission. There is no backend module or network access. Settings are stored in the browser via `localStorage`.
