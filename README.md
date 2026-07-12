# Auto Retry (Lumiverse Spindle extension)

Auto Retry quietly re-runs an AI reply when it fails, comes back empty, stalls partway, gets cut off mid-sentence, or refuses by mistake. You send a message, something goes wrong with the reply, and instead of you noticing and hitting regenerate, the extension does it for you. It is a rebuild of the [SillyTavern fetch-retry](https://github.com/Hikarushmz/fetch-retry) idea for Lumiverse.

## What it does

It watches each reply and re-fires when:

- the reply comes back as a provider error
- the reply comes back empty, including one that "thinks" but never writes anything
- the reply is cut off mid-sentence (see [Cut-off detection](#cut-off-detection) below)
- the reply is an accidental out-of-character refusal (see [Accidental-refusal detection](#accidental-refusal-detection-beta) below)
- the stream stalls mid-reply, tokens stop arriving for a while
- a reply never starts or never finishes
- (optional, off by default) the reply is very short

Every retry waits a little longer than the last so it never hammers the server, and waits extra when the server says it is busy. All of the triggers share one retry limit, so no reply is ever retried more than you allow, and nothing can loop forever.

## Install

In Lumiverse, open Extensions and install from the repository URL:

```
https://github.com/starlitcode/Lumiverse-Auto-Retry
```

## Settings

Open the chat input bar, tap the **Extras** popover, and choose **Auto Retry settings**. Everything is editable there, grouped by what it does, and the panel fits a phone as well as a desktop. Simple on/off switches are up top; the fiddly stuff is tucked under groups marked **Advanced** so you can ignore it if you just want it to work.

Only **Save** keeps your changes. Closing with the X or tapping outside discards anything you did not save, so you can experiment freely. Saved settings live in your browser and apply to the next reply.

## You are always in charge

Pressing your **Stop** button, or tapping **Cancel** on the retry pop-up, stops the extension right away. It drops any pending retry, resets the count, and briefly ignores new retries so a stopped reply's own trailing events cannot quietly restart it. The Cancel button on the pop-up is the extension's own, so it works no matter what.

## Cut-off detection

A reply that streams real text and then gets chopped off mid-sentence is easy to miss. Lumiverse does not tell an extension *why* a reply ended, so this works off the shape of the text instead. `retryOnTruncated` (on by default) treats a reply as cut off when it has a clearly open structure:

- an unclosed code block or inline backtick
- an odd number of emphasis `*`, an open action or emphasis (bullet lists are ignored so a list doesn't look half-open)
- an unbalanced quote, open dialogue
- it ends on a comma or semicolon, cut mid-clause

These are deliberately careful so a reply that legitimately ends on `...`, an action, or a closed quote is left alone. If you want it stricter, turn on `retryOnNoPunct`, which also retries a reply ending with no punctuation at all. That one is noisier in roleplay, so it is off by default.

## Accidental-refusal detection (beta)

Models sometimes break character and refuse a benign, SFW request by mistake: a false positive in a safety filter, or an inconsistent moderation call on ordinary creative writing. Because these models are a little random, running the *same* request again usually just produces a normal reply. `retryOnRefusal` (on by default) treats that like any other recoverable failure and re-fires.

What it does **not** do matters as much as what it does. It does not rewrite your prompt, swap words, or change any message's role. It re-sends the identical request, capped by your retry limit. So a refusal the model actually means will simply repeat across the tries and then stop, showing you the refusal, exactly as if you had re-rolled by hand a few times. It is a reliability feature for accidental refusals, not a way around a model's real safety behavior.

Detection is layered, because refusal wording differs between models and drifts over time, and because in-character dialogue shares vocabulary with real refusals ("I can't do that," "I refuse," "I must decline"):

- Tight patterns for the shapes that need context: the model naming itself ("as an AI"), policy or guideline framing ("against my guidelines"), a refusal tied to a task-word a character never says (request, prompt, content, scenario, roleplay), and assistant-only verbs like assist, comply, or fulfill. So "I can't continue this request" flags, but "I must decline your hand in marriage" does not.
- A phrase list covering the many near-identical refusals seen across ChatGPT, Claude, and Gemini.
- A few soft redirect tells ("I'd be happy to help with ... instead"), which only fire when the reply pivots away, so an ordinary helpful line does not trip them.

Curly and straight apostrophes are treated the same, and only replies short enough to plausibly *be* a refusal are considered, so a long scene that happens to contain one of these phrases is left alone. It leans toward missing a refusal rather than re-rolling good writing; when it misses, you re-roll by hand as before.

Some providers deliver a refusal as an *error* instead of as reply text (Gemini's prohibited-content result, for one). With error retries on (the default) those are already covered. If you turn error retries off but leave refusal retries on, it still catches an error whose text is clearly about content moderation, while leaving ordinary network errors like a dropped connection alone.

### Tuning it

Everything sits under **Advanced: refusal tuning** in the settings, so the basic on/off toggle stays clean for people who just want it on:

- **Use the built-in phrase list** (on by default). The built-in patterns are tuned for English. Turn this off to ignore them and match only your own phrases below, which is how you'd run it against a model that refuses in another language.
- **Your own refusal phrases**: comma-separated extras that should also count. Paste the exact wording your model refuses with, in any language.
- **Never treat these as a refusal**: a whitelist. If a reply contains any of these it is never re-rolled. Your escape hatch if a line in your roleplay keeps getting redone by mistake. This wins over everything else.
- **Longest reply to treat as a refusal** (1200 by default). Longer replies are assumed to be real writing and left alone. Raise it if your model writes long refusals, lower it to be safer with long scenes.

For a non-English model: turn off the built-in list, then paste your model's actual refusal wording into "Your own refusal phrases." It is marked beta because the built-in wordlists are still being tuned, so turn the whole thing off with the "It looks like an accidental refusal" toggle if you would rather it never touch a refusal-shaped reply.

## All settings

The settings modal is the easy path. The same options live in the CONFIG block at the top of `src/frontend.ts` and `dist/frontend.js`. `dist/frontend.js` is the file the host actually loads, so editing CONFIG there takes effect with no rebuild; editing `src/frontend.ts` needs a `bun build`.

| Option | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch. |
| maxRetries | 4 | Hard cap per message. Nothing retries past this. |
| retryDelayMs | 1200 | Wait before the first retry, in milliseconds. |
| backoffFactor | 2 | Each wait is this many times longer than the last. |
| maxDelayMs | 30000 | Longest it will ever wait. |
| jitter | true | Nudges each wait randomly so retries don't all land at once. |
| rateLimitDelayMs | 8000 | Floor wait when the server says it's busy. |
| stuckTimeoutMs | 90000 | Started but no token and no end within this. 0 disables. |
| idleTimeoutMs | 45000 | Tokens flowed then stopped for this long. 0 disables. |
| retryOnError | true | Retry provider errors. |
| retryOnEmpty | true | Retry empty replies and mid-reasoning cutoffs. |
| retryOnTruncated | true | Retry a reply that ends mid-sentence. |
| retryOnNoPunct | false | Stricter: also retry a reply ending with no punctuation. Noisy in RP. |
| retryOnShort | false | Retry short replies. Off unless you mean it. |
| minChars | 24 | Short threshold, used when retryOnShort is on. |
| retryOnRefusal | true | (beta) Retry an accidental out-of-character refusal. |
| refusalUseBuiltins | true | Use the built-in English refusal lists. Off = only your own phrases. |
| refusalExtraPhrases | (empty) | Comma-separated phrases that also count as a refusal. |
| refusalIgnorePhrases | (empty) | Comma-separated whitelist; a reply containing any is never a refusal. |
| refusalMaxChars | 1200 | Longest reply still treated as a possible refusal. |
| regenerateSelector | (see file) | Host button. See below. |
| swipeNextSelector | (see file) | Backup button if your build retries by swiping. |
| stopSelector | (see file) | Host stop button, used to abort a stalled reply. |
| toast | true | Show the little retry pop-up with its Cancel button. |
| log | false | Console logging, for troubleshooting only. |

The two watchdog waits (`stuckTimeoutMs`, `idleTimeoutMs`) lean long on purpose so a slow connection or a slow local model isn't mistaken for a freeze. If your provider is fast and you want quicker recovery, lower them.

## Fixing the regenerate button

Lumiverse has no built-in way for an extension to regenerate a reply, so the re-fire clicks your own on-screen regenerate or swipe button. The defaults match common Lumiverse builds, but a future update could rename those buttons.

There are three button fields: **regenerate** (redo a reply), **next / swipe** (a backup if your build retries by swiping), and **stop** (to halt a frozen reply). Each takes one CSS selector, the kind you'd pass to `document.querySelector`, and you can list several separated by commas as fallbacks.

If retries fire (the pop-up shows) but nothing regenerates, the selector needs adjusting:

1. Open developer tools (F12) with an AI message visible so its buttons are on screen.
2. Right-click the regenerate button and choose Inspect.
3. Find a stable attribute on it (a data attribute, aria-label, title, or class) and write a selector that matches it.
4. Paste it into the Regenerate selector field and hit **Test** with an AI message on screen. Save when it says it matches.

A "no match" doesn't always mean the selector is wrong. A button only exists while it's showing, so a correct selector still won't match if that button isn't on screen when you test. The **Stop** button is the clearest case: it only appears while a reply is generating, so test that one mid-reply.

## Reporting a bug

The settings modal has a **Copy debug info** button. It copies a short plain-text snapshot you can paste straight into a bug report, no developer tools needed: the version, your current settings, whether each button matches on screen right now, your screen and browser, and a timeline of the last things the extension did. That timeline is kept whether or not console logging is on, so for most bugs this one button is all anyone needs.

For a deeper trace, turn on **Write technical details to the console** in the Advanced section, reproduce the problem, then copy what appears in the browser console (F12).

## Permissions

Declares `generation` so it can hear when replies start, stream, and end. The settings UI needs no extra permission. There is no backend and no network access; settings are stored in your browser.

## How it works under the hood

SillyTavern's version patches the browser's fetch. That cannot work in Lumiverse, because the AI call runs on the server and streams back over a WebSocket, so there is no fetch to intercept. This extension is event-driven instead: it listens to Lumiverse's own generation events and, when something goes wrong, clicks your regenerate button. That button click is the only part that depends on the page layout, and it is the part you can fix yourself from the settings if a Lumiverse update ever moves those buttons.
