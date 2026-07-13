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

It can also, optionally, run a find-and-replace on replies: swap words you don't like for ones you prefer, saved into the reply. See [Find and replace in replies](#find-and-replace-in-replies-beta) below. This is off by default and is the only feature that edits a reply.

## Install

In Lumiverse, open Extensions and install from the repository URL:

```
https://github.com/starlitcode/Lumiverse-Auto-Retry
```

## Settings

Open the chat input bar, tap the **Extras** popover, and choose **Auto Retry settings**. Everything is editable there, grouped by what it does, and the panel fits a phone as well as a desktop. Simple on/off switches are up top; the groups marked **Advanced** are collapsed by default, so tap one of those headers to reveal its options when you want them.

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

Models sometimes break character and refuse a request that a re-run would answer normally: a false positive in a safety filter, or an inconsistent moderation call. Because these models are stochastic, sending the same request again often produces a normal reply. `retryOnRefusal` (on by default) treats that like any other recoverable failure and re-fires.

It re-sends the identical request, unchanged, capped by your retry limit. Nothing about the prompt, the wording, or the message roles is altered. A refusal the model repeats keeps coming back across the tries and then stops at the limit, leaving the refusal in place.

Detection is layered, because refusal wording differs between models and drifts over time, and because in-character dialogue shares vocabulary with real refusals ("I can't do that," "I refuse," "I must decline"):

- Tight patterns for the shapes that need context: the model naming itself ("as an AI"), policy or guideline framing ("against my guidelines"), a refusal tied to a task-word a character never says (request, prompt, content, scenario, roleplay), and assistant-only verbs like assist, comply, or fulfill. So "I can't continue this request" flags, but "I must decline your hand in marriage" does not.
- A phrase list covering the many near-identical refusals seen across ChatGPT, Claude, and Gemini.
- A few soft redirect tells ("I'd be happy to help with ... instead"), which only fire when the reply pivots away, so an ordinary helpful line does not trip them.

Curly and straight apostrophes are treated the same, and only replies short enough to plausibly *be* a refusal are considered, so a long scene that happens to contain one of these phrases is left alone. It leans toward missing a refusal rather than re-rolling good writing; when it misses, you re-roll by hand as before.

Some providers deliver a refusal as an *error* instead of as reply text (Gemini's prohibited-content result, for one). With error retries on (the default) those are already covered. If you turn error retries off but leave refusal retries on, it still catches an error whose text is clearly about content moderation, while leaving ordinary network errors like a dropped connection alone.

### Tuning it

Everything sits under **Advanced: refusal tuning** in the settings, so the basic on/off toggle stays clean for people who just want it on:

- **Use the built-in phrase list** (on by default). This only controls the built-in list. Your own phrases below are always used either way. On, the built-in list is used together with your own phrases. Off, only your own phrases are used.
- **Your own refusal phrases**: comma-separated extras that should also count, always used whether or not the built-in list is on. Paste the exact wording your model refuses with.
- **Reword the built-in phrases**: change wording inside the built-in list with `old => new` rules, separated by commas. For example `assist => help` rewrites every built-in phrase that uses "assist" to use "help" instead. Handy if a built-in phrase uses a word you'd rather see worded differently, or if your model phrases the same refusal a little differently. It changes what the built-in list matches, so only swap for wording your model actually uses.
- **Never treat these as a refusal**: a whitelist. If a reply contains any of these it is never re-rolled. Your escape hatch if a line in your roleplay keeps getting redone by mistake. This wins over everything else.
- **Longest reply to treat as a refusal** (1200 by default). Longer replies are assumed to be real writing and left alone. Raise it if your model writes long refusals, lower it to be safer with long scenes.

To run entirely on your own phrases, turn off the built-in list and put your wording into "Your own refusal phrases." It is marked beta because the built-in wordlists are still being tuned, so turn the whole thing off with the "It looks like an accidental refusal" toggle if you would rather it never touch a refusal-shaped reply.

### What the built-in list looks for

So you know what "Reword the built-in phrases" acts on, here is the exact phrase list. A reply is treated as a refusal if it contains any of these (case and curly apostrophes don't matter):

```
i can't help with that            i cannot help with that
i can't assist with that          i cannot assist with that
i'm unable to help with that      i'm unable to assist with that
i am unable to assist with that   i'm not able to help with that
i can't comply with that          i cannot comply with that
i can't provide that information  i cannot provide that information
i can't provide instructions      i can't provide guidance on that
i can't fulfill that request      i can't fulfil that request
i can't support that request      i won't be able to help with that
i can't generate a response to that   i can't provide a response to that
i can't generate that content     i can't engage with that request
can't help with requests like this    can't assist with requests like this
violates our polic                violates the safety polic
violates the content polic        for safety reasons
due to safety concerns            i have to prioritize safety
```

Alongside that list it also matches a few patterns that are not fixed phrases. Because they match by shape rather than exact text, the reword field does not change them, and the examples below are just that, examples, not the full set of wordings each one catches:

- **The model calling itself an AI.** "As an AI, I can't do that." / "I'm just an AI assistant."
- **Policy or guideline wording.** "This goes against my guidelines." / "That violates our content policy."
- **A refusal joined to a task word** (request, prompt, content, scenario, roleplay). "I can't continue this roleplay." / "I won't write that content." / "I'm unable to complete this request."
- **Assistant-only verbs** (assist, comply, fulfill). "I can't assist with that." / "I'm unable to comply." / "I cannot fulfill this."
- **An out-of-character comfort hedge.** "I don't feel comfortable continuing this." / "I don't feel comfortable writing that."
- **A soft redirect that pivots away** (needs the pivot, so a normal offer to help does not trip it). "I'd be happy to help with something else instead." / "Instead, I can help you with a lighter scene." / "Please try asking something else."

On the error side, when a reply comes back as an error rather than text, it matches content-block wording. Examples: "PROHIBITED_CONTENT", "Blocked by safety settings.", "finish_reason: safety". It deliberately ignores ordinary network errors like "connection refused".

## Find and replace in replies (beta)

This swaps words in a reply after it arrives and saves the change into the stored message. It is separate from everything above: it has nothing to do with retrying or with refusal detection, and it is off by default. Turn on "Swap words in replies" and add rules to use it.

It is marked beta: it is new, it runs a backend that edits your saved messages, and it needs a privileged permission.

It never changes what the model generated. A find-and-replace always runs after the reply already exists, so it only edits the text afterward. Because it edits the stored reply rather than just the display, the swap sticks, shows everywhere, and the model reads the swapped wording as context on later turns.

Rules go in the "Word swaps" box as `old => new`, separated by commas:

```
suddenly => abruptly, sort of => kind of, very => 
```

- A single word matches whole words only, so `cat => dog` changes "cat" but leaves "category" alone.
- Anything with a space or punctuation is matched literally, so `sort of => kind of` works as a phrase.
- Leave the right side empty to delete a word, like `very => ` above.
- List the same word more than once to give it options, like `sky => blue, sky => aqua`. By default it uses the first one. Turn on **Pick randomly when a word has more than one swap** and each time that word appears it picks one of its options at random, which is handy for variety.
- By default matching ignores letter case and keeps the original capitalization, so a swap at the start of a sentence stays capitalized. Turn on **Match case exactly** to swap only when the case matches your rule, which also lets `sky` and `Sky` have different swaps.

Editing a saved reply needs the `chat_mutation` permission (see Permissions below). If nothing in your rules matches a reply, that reply is left untouched.

## Import and export

You can save your settings to a file or share them with someone else. In the settings modal, open **Advanced: import / export**. Tick the parts you want, then either **Export to file** to save them as a small `.json` file, or **Import from file** to load one someone gave you.

The parts are grouped so you only move what you mean to: retry behavior, refusal detection, word swaps, button selectors, and notifications. For sharing phrase and swap setups, tick just refusal detection and word swaps and leave the rest, since button selectors in particular are tied to one person's Lumiverse build.

Import fills the form but does not save on its own, so you can look it over and press **Save** to keep it or close the modal to discard it. Every imported value runs through the same checks as your normal settings, so a pasted block can only set known options to safe values, and anything it does not recognise is ignored.

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
| refusalPhraseSubs | (empty) | Reword the built-in phrases with "old => new" rules, comma-separated. |
| refusalIgnorePhrases | (empty) | Comma-separated whitelist; a reply containing any is never a refusal. |
| refusalMaxChars | 1200 | Longest reply still treated as a possible refusal. |
| replaceEnabled | false | (beta) Turn on find-and-replace on replies. Edits the saved message. |
| replaceRules | (empty) | "old => new" word swaps, comma-separated. |
| replaceRandom | false | When a word has more than one swap, pick one at random each time. |
| replaceCaseSensitive | false | Match letter case exactly. Off = case-insensitive, capitalization kept. |
| regenerateSelector | (see file) | Host button. See below. |
| swipeNextSelector | (see file) | Backup button if your build retries by swiping. |
| stopSelector | (see file) | Host stop button, used to abort a stalled reply. |
| toast | true | Show the little retry pop-up with its Cancel button. |
| log | false | Console logging, for troubleshooting only. |
| liveLog | false | Show a small on-screen panel with recent activity, updating live. |

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

The main tool is **Advanced: debug info** in the settings modal. Tick the parts you want (your settings, button match status, browser and screen, recent activity), press **Build preview**, then edit the text to remove anything private before you copy. It copies a short plain-text snapshot you can paste into a bug report, no developer tools needed. The activity timeline is kept whether or not console logging is on, so for most bugs this is all anyone needs. Nothing leaves your device until you paste it somewhere.

For watching what the extension does live, turn on **Show a live log on screen** under Advanced: feedback. A small panel appears in the corner and updates in real time as generations run and retries fire, which is useful on mobile where the browser console is out of reach. It is controlled entirely by that toggle, so turn the toggle off to make it disappear.

For a deeper trace, turn on **Write technical details to the console** in Advanced: feedback, reproduce the problem, then copy what appears in the browser console (F12).

## Permissions

Declares two permissions:

- `generation`: to hear when replies start, stream, and end. This drives all the retry logic.
- `chat_mutation`: to edit a saved reply. This is used only by the "Find and replace in replies" feature, and only when you turn it on and enter swaps. If you never use that feature, nothing is edited.

`chat_mutation` is a privileged permission, so depending on your Lumiverse setup it may need admin approval before it takes effect. The retry side works without it; only find-and-replace needs it.

The find-and-replace feature runs in a small backend module. The rest of the extension is frontend-only. There is no network access, and your settings are stored in your browser.

## How it works under the hood

SillyTavern's version patches the browser's fetch. That cannot work in Lumiverse, because the AI call runs on the server and streams back over a WebSocket, so there is no fetch to intercept. The retry side is event-driven instead: it listens to Lumiverse's own generation events and, when something goes wrong, clicks your regenerate button. That button click is the only part that depends on the page layout, and it is the part you can fix yourself from the settings if a Lumiverse update ever moves those buttons.

Find-and-replace works differently, because editing a saved reply is a backend job. A small backend module listens for finished replies and, when you have swaps enabled, edits the stored message through Lumiverse's Chat Mutation API. Your swap rules travel from the settings UI to that backend and are saved so they persist. Editing a reply this way emits an edit event, not a generation event, so it cannot loop back into itself.
