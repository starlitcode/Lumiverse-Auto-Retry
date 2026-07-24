# Auto Retry (Lumiverse Spindle extension)

Auto Retry quietly re-runs an AI reply when it fails, comes back empty, stalls partway, gets cut off mid-sentence, or refuses by mistake, so you don't have to catch it and hit regenerate yourself. It is a rebuild of the [SillyTavern fetch-retry](https://github.com/Hikarushmz/fetch-retry) idea for Lumiverse.

## What it does

It watches each reply and re-fires when:

- the reply comes back as a provider error (but skips permanent hard failures like invalid API keys by default)
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

Open the chat input bar, tap the **Extras** popover, and choose **Auto Retry settings**. Options are grouped by what they do. Simple on/off switches are up top; the groups marked **Advanced** are collapsed by default, so tap one of those headers to reveal its options. Each setting has a **?** next to its name that shows a short description: hover it on a computer, tap it on a phone, so the list stays compact.

Only **Save** keeps your changes. Closing with the X or tapping outside discards anything you did not save, so you can experiment freely. Saved settings sync to your Lumiverse account, so they follow you to other browsers and devices, and they apply to the next reply. Long text boxes, like your word-swap rules, have an **Expand** button that opens a full-size editor.

## You are always in charge

Pressing your **Stop** button, or tapping **Cancel** on the retry pop-up, stops the extension right away. It drops any pending retry, resets the count, and briefly ignores new retries so a stopped reply's own trailing events cannot quietly restart it. The Cancel button on the pop-up is the extension's own, so it works no matter what.

## Cut-off detection

A reply that streams real text and then gets chopped off mid-sentence is easy to miss. Lumiverse does not tell an extension *why* a reply ended, so this works off the shape of the text instead. `retryOnTruncated` (on by default) treats a reply as cut off when it has a clearly open structure. Reasoning blocks are removed before these are counted, so punctuation inside a model's thinking cannot unbalance them; a reasoning block left open with no close still counts as cut off. This does not depend on the **Ignore the thinking / reasoning** option, which applies to refusal matching only. The checks:

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

### Thinking and reasoning

Only the final reply is ever checked for a refusal, never the model's thinking. Before matching, known reasoning blocks are stripped out (tags like `<think>`, `<thinking>`, `<reasoning>`, `<thought>`, `<reflection>`, `<scratchpad>` and similar, in both `<tag>` and `[tag]` forms). So if a model weighs a refusal while reasoning but then writes a normal reply, nothing is re-rolled. If a refusal ends up in the actual reply, it is caught as usual, and if the model reasons and then produces nothing, that is handled by the empty-reply retry instead.

If your model wraps its thinking in an unusual tag the built-in set misses, add its name under **Extra thinking tag names** in the refusal tuning section, one per line, just the name (no brackets). You can turn the whole thing off with **Ignore the thinking / reasoning**, though leaving it on is the safe default.

### Tuning it

Everything sits under **Advanced: refusal tuning** in the settings, so the basic on/off toggle stays clean for people who just want it on:

- **Use the built-in phrase list** (on by default). This only controls the built-in list. Your own phrases below are always used either way. On, the built-in list is used together with your own phrases. Off, only your own phrases are used.
- **Your own refusal phrases**: extras that should also count, one per line, always used whether or not the built-in list is on. Paste the exact wording your model refuses with.
- **Reword the built-in phrases**: change wording inside the built-in list with `old => new` rules, one per line. For example `assist => help` rewrites every built-in phrase that uses "assist" to use "help" instead. Handy if a built-in phrase uses a word you'd rather see worded differently, or if your model phrases the same refusal a little differently. It changes what the built-in list matches, so only swap for wording your model actually uses.
- **Never treat these as a refusal**: a whitelist. If a reply contains any of these, one per line, it is never re-rolled. This wins over everything else.
- **Longest reply to treat as a refusal** (2000 by default). Longer replies are assumed to be real writing and left alone. Raise it if your model writes long, padded refusals, lower it to be safer with long scenes, or set it to 0 to scan replies of any length.

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
i cannot create that content      i cannot generate that content
i can't create that content
```

Alongside that list it also matches a few patterns that are not fixed phrases. Because they match by shape rather than exact text, the reword field does not change them, and the examples below are just that, examples, not the full set of wordings each one catches:

- **The model calling itself an AI.** "As an AI, I can't do that." / "I'm just an AI assistant."
- **Policy or guideline wording.** "This goes against my guidelines." / "That violates our content policy."
- **A refusal joined to a task word** (request, prompt, content, scenario, roleplay). "I can't continue this roleplay." / "I won't write that content." / "I'm unable to complete this request."
- **Assistant-only verbs** (assist, comply, fulfill). "I can't assist with that." / "I'm unable to comply." / "I cannot fulfill this."
- **An out-of-character comfort hedge.** "I don't feel comfortable continuing this." / "I don't feel comfortable writing that."
- **A common apology-style refusal opener or body.** "I'm sorry, but I can't create that." / "That's not something I can help with." / "I'm not going to generate that content."
- **A soft redirect that pivots away** (needs the pivot, so a normal offer to help does not trip it). "I'd be happy to help with something else instead." / "Instead, I can help you with a lighter scene." / "Please try asking something else."
- **A refusal tied to specific prohibited content.** "I cannot participate in roleplay or generate content depicting sexual violence" / "I'm unable to engage in roleplay depicting non-consensual acts."

On the error side, when a reply comes back as an error rather than text, it matches content-block wording. Examples: "PROHIBITED_CONTENT", "Blocked by safety settings.", "finish_reason: safety". It deliberately ignores ordinary network errors like "connection refused".

## Find and replace in replies (beta)

This swaps words in a reply after it arrives and saves the change into the stored message. It is separate from everything above: it has nothing to do with retrying or with refusal detection, and it is off by default. Turn on "Swap words in replies" and add rules to use it.

It is marked beta: it is new, it runs a backend that edits your saved messages, and it needs a privileged permission.

It never changes what the model generated. A find-and-replace always runs after the reply already exists, so it only edits the text afterward. Because it edits the stored reply rather than just the display, the swap sticks, shows everywhere, and the model reads the swapped wording as context on later turns. Only generated assistant replies are swapped, by either the automatic mode or the button. The opening greeting is authored, not generated, so it is never swapped, and your own messages are never touched.

If you would rather apply swaps by hand than have them run on every reply, turn on **Show a 'swap words now' button** under Advanced: find and replace. That adds a button to the chat input's Extras menu (next to the settings button) that applies your swaps on demand. It only ever edits assistant replies, never your own messages.

By default it swaps just the latest reply and won't swap the same reply twice, so it won't stack on top of an automatic swap or an earlier tap. Two options change the picture. **Show a swap-whole-chat button** adds a second Extras button, **Swap words in every reply**, which applies your rules once to every generated reply in the chat you are viewing, which is handy after adding a rule mid-chat or loading a different preset. **Allow swapping a reply again** lets it swap a reply you already swapped, which is useful after you change your rules, though it can stack swaps. There is no way to pick individual arbitrary messages; the choice is the latest reply or the whole chat.

It acts on replies from the current session (the ones you have generated), so it is most reliable right after a reply; on a freshly opened old chat it will say there is no reply to swap until you generate one. It works whether or not automatic swapping is on, and appears in the Extras menu on both mobile and desktop.

If you never want a swap to touch a reply without your say-so, turn on **Ask before editing a reply**. Every swap, automatic or from the button, then pops up a confirmation you can accept or cancel, so nothing is changed silently. With automatic swapping on this can prompt often, which is the point for people who do not want surprises. It needs your Lumiverse to support confirm dialogs; if it does not, swaps proceed as normal.

Rules go in the "Word swaps" box as `old => new`, one rule per line:

```
suddenly => abruptly
sort of => kind of
very => 
```

- The left side can be a single word, a phrase, or a whole sentence, and commas inside it are fine (each rule is a whole line, so a comma no longer splits it).
- A single word matches whole words only, so `cat => dog` changes "cat" but leaves "category" alone.
- A phrase or sentence matches exactly as you type it, so `sort of => kind of` swaps that phrase wherever it appears, and a full sentence swaps that whole sentence. It has to match your text exactly, including spacing and punctuation.
- Leave the right side empty to delete a word, like `very => ` above. It also removes one trailing space, so a mid-sentence deletion doesn't leave a double space.
- Put the same left side on more than one line to give it options (for example `sky => blue` on one line and `sky => aqua` on the next). By default it uses the first one. Turn on **Pick randomly when a word has more than one swap** and each time that word appears it picks one of its options at random, which is handy for variety.
- By default matching ignores letter case and keeps the original capitalization, so a swap at the start of a sentence stays capitalized. Turn on **Match case exactly** to swap only when the case matches your rule, which also lets `sky` and `Sky` have different swaps.
- Rules are applied in a single pass, so no rule ever acts on what another rule just wrote. `cat => dog` alongside `dog => wolf` turns cats into dogs and dogs into wolves, and it never turns a cat into a wolf. This also means two rules can swap past each other: `hot => cold` with `cold => hot` exchanges the two words rather than making everything one of them.
- Where two rules could match the same spot, the one with the longer left side wins. `cat nap => siesta` beats `cat => dog` on the words "cat nap", so the longer rule is never shadowed by a shorter one that starts the same way. If two left sides are the same length, the one you listed first wins.

These last two settle different questions and don't overlap. The longest-left-side rule picks **which rule fires** when two different rules compete for the same spot. The random option picks **which replacement one rule uses** when you've given that same left side several right sides. Nothing competes in `sky => blue` and `sky => aqua`, since `sky` is the only rule matching "sky"; the only question is whether every "sky" becomes "blue" or each one rolls between the two. Left sides that are identical can't be told apart by length either, so list order decides, which is exactly what the random option is there to override. In short: longest match is about the left side of your rules, random is about the right side.

Editing a saved reply needs the `chat_mutation` permission (see Permissions below). If nothing in your rules matches a reply, that reply is left untouched.

### Presets

At the bottom of the find-and-replace settings you can save your word-swap setups as named presets and switch between them without copying rules by hand.

Pick a saved preset and press **Load** to switch your settings to it. To store the current setup, type a name and press **Save as new**. **Update selected** overwrites the chosen preset with your current settings, **Rename selected** renames it to the name in the box, and **Delete** removes it. Loading a preset takes effect right away and is saved, so there is no separate Save step. Presets are kept on this browser, so unlike your account settings they do not sync across devices. To move them to another device or share them, use **Advanced: import / export**, which can include your presets in the file.

## Import and export

You can save your settings to a file and load them back later. In the settings modal, open **Advanced: import / export**. Tick the parts you want, then either **Export to file** to save them as a small `.json` file, or **Import from file** to load one. Your settings already follow your Lumiverse account across browsers on their own, so this is mainly for keeping a backup, sharing a setup with someone else, or copying between accounts. Since word swap presets only live on one browser, this is also how you move them: tick **Word swap presets** to include them.

Imported settings fill in the fields for review and need a **Save** to stick. Imported presets are different: they are saved as soon as they come in, with same-named presets replaced and new ones added.

The parts are grouped so you only move what you mean to: retry behavior, refusal detection, word swaps, button selectors, and on-screen (the pop-up and live log). For sharing phrase and swap setups, tick just refusal detection and word swaps and leave the rest, since button selectors in particular are tied to one person's Lumiverse build.

Import puts the values from the file into the settings without saving them, so you can look them over and press **Save** to keep them, or close the modal to discard them. Every imported value runs through the same checks as your normal settings, so a file can only set known options to safe values, and anything it does not recognise is ignored.

## All settings

The settings modal is the easy path. The same options live in the CONFIG block at the top of `src/frontend.ts` and `dist/frontend.js`. `dist/frontend.js` is the file the host actually loads, so editing CONFIG there takes effect with no rebuild; editing `src/frontend.ts` needs a `bun build`.

| Option | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch. |
| maxRetries | 4 | Hard cap per message. Nothing retries past this. |
| pauseWhenFailing | true | Pause auto-retry after several whole runs give up in a row. Cleared by the next reply that comes back fine. |
| breakerRuns | 3 | How many failed runs in a row trigger the pause. A run is one message that used up all its tries. |
| breakerPauseMins | 5 | How long the pause lasts, in minutes. A reply that comes back fine ends it early. |
| retryDelayMs | 1200 | Wait before the first retry, in milliseconds. |
| backoffFactor | 2 | Each wait is this many times longer than the last. |
| maxDelayMs | 30000 | Longest it will ever wait. |
| jitter | true | Nudges each wait randomly so retries don't all land at once. |
| rateLimitDelayMs | 8000 | Floor wait when the server says it's busy. |
| retryByNewReroll | false | Off: a retry redoes the reply in place via the regenerate button. On: a retry clicks the next / swipe button, adding a new reroll and keeping the existing ones. Applies to every retry reason. The other button is the fallback. |
| stuckTimeoutMs | 90000 | Started but no token and no end within this. 0 disables. |
| idleTimeoutMs | 45000 | Tokens flowed then stopped for this long. 0 disables. |
| retryOnError | true | Retry provider errors. |
| ignoreHardErrors | true | Skip permanent failures like missing models or invalid API keys. |
| retryOnEmpty | true | Retry empty replies and mid-reasoning cutoffs. |
| retryOnTruncated | true | Retry a reply that ends mid-sentence. |
| retryOnNoPunct | false | Stricter: also retry a reply ending with no punctuation. Noisy in RP. |
| retryOnShort | false | Retry short replies. Off unless you mean it. |
| minChars | 24 | Short threshold, used when retryOnShort is on. |
| retryOnRefusal | true | (beta) Retry an accidental out-of-character refusal. |
| refusalUseBuiltins | true | Use the built-in English refusal lists. Off = only your own phrases. |
| refusalExtraPhrases | (empty) | Phrases that also count as a refusal, one per line. |
| refusalPhraseSubs | (empty) | Reword the built-in phrases with "old => new" rules, one per line. |
| refusalIgnorePhrases | (empty) | Whitelist, one per line; a reply containing any is never a refusal. |
| refusalMaxChars | 2000 | Longest reply still treated as a possible refusal. 0 = no limit. |
| refusalStripThinking | on | Only check the final reply, stripping known reasoning tags first. Off checks the whole raw output. |
| refusalThinkTags | (empty) | Extra reasoning tag names, one per line, for unusual thinking wrappers. |
| replaceEnabled | false | (beta) Turn on find-and-replace on replies. Edits the saved message. |
| replaceRules | (empty) | "old => new" word swaps, one per line. |
| replaceRandom | false | When a word has more than one swap, pick one at random each time. |
| replaceCaseSensitive | false | Match letter case exactly. Off = case-insensitive, capitalization kept. |
| showReplaceButton | false | Add a button to the input Extras menu that applies your word swaps to the latest reply on demand. |
| showSwapAllButton | false | Adds an Extras button that swaps every generated reply in the chat once. |
| allowReSwap | false | Let that button swap a reply again even if it was already swapped (can stack swaps). |
| confirmBeforeEdit | false | Ask you to confirm before any word-swap edit (automatic or manual); you can cancel. |
| regenerateSelector | (see file) | Host button. See below. |
| swipeNextSelector | (see file) | Backup button if your build retries by swiping. |
| stopSelector | (see file) | Host stop button, used to abort a stalled reply. |
| toast | true | Show the little retry pop-up with its Cancel button. |
| liveLog | false | Show a small on-screen panel with recent activity, updating live. |

The two watchdog waits (`stuckTimeoutMs`, `idleTimeoutMs`) lean long on purpose so a slow connection or a slow local model isn't mistaken for a freeze. If your provider is fast and you want quicker recovery, lower them.

## Fixing the regenerate button

Lumiverse has no built-in way for an extension to regenerate a reply, so the re-fire clicks your own on-screen regenerate or swipe button. The defaults match common Lumiverse builds, but a future update could rename those buttons.

There are three button fields: **regenerate** (redo a reply), **next / swipe** (a backup if your build retries by swiping), and **stop** (to halt a frozen reply). Each takes one CSS selector, the kind you'd pass to `document.querySelector`, and you can list several separated by commas as fallbacks. The extension checks these in the exact order you write them, so put your most specific selectors first (like data attributes) and broader ones last (like aria-label or title).

By default a retry uses the regenerate button, which on some builds redoes the reply in place and clears the other rerolls on that message. If you'd rather keep those rerolls, turn on **Retry by adding a new reroll** (under "How it redoes a reply" in settings). A retry then clicks the next / swipe button, which adds a new reroll and leaves the existing ones in place.

Whichever button the toggle prefers, the other one is the fallback, and the choice is made at the moment of the click from what is on screen and actually clickable. A button that is present but disabled or hidden is skipped rather than clicked, since clicking one of those does nothing and would burn a retry. This applies to every reason a retry fires, including empty replies and errors, so the toggle does what it says on all of them. Set the **next / swipe** selector below if retries stop happening after you turn it on.

### Setting the buttons without writing a selector

Each button setting has a **Pick it for me** button next to **Test**. Press it and the settings panel steps aside; click the real button in Lumiverse and the selector is filled in for you. The click is swallowed, so picking your stop or regenerate button doesn't also press it. Esc cancels.

It builds the selector from whatever is most likely to survive an app update, preferring `aria-label`, `title` and `data-` attributes over class names. Lumiverse rebuilds its class names on every release, so a selector based on one stops matching the next time the app updates, and those are skipped on purpose. If the element it lands on has nothing dependable, it says so rather than saving something that will break; clicking the button itself rather than an icon inside it usually fixes that.

If a click lands but no reply starts, which happens when a next / swipe button moves between rerolls that already exist rather than making a new one, it clicks the other button once before giving that attempt up.

### Writing selectors by hand

Each box takes one CSS selector, or several separated by commas as fallbacks. They're tried left to right, so put the most specific first (`data-action`, `data-testid`) and the broader ones last (`aria-label`, `title`). The first entry that finds a button you can actually click is the one used; an entry matching only a hidden or disabled button is passed over for the next, since clicking one of those does nothing and would waste a retry.

A comma inside brackets, parentheses or quotes stays part of the selector rather than splitting the list, so `:is(a, b)` and `[aria-label="Next, swipe"]` each count as one entry.

**Reset button selectors** at the bottom of that section puts all three back to the defaults without touching any other setting. It fills the boxes, so press Save to keep it.

If retries fire (the pop-up shows) but nothing regenerates, the selector needs adjusting:

1. Open developer tools (F12) with an AI message visible so its buttons are on screen.
2. Right-click the regenerate button and choose Inspect.
3. Find a stable attribute on it (a data attribute, aria-label, title, or class) and write a selector that matches it.
4. Paste it into the Regenerate selector field and hit **Test** with an AI message on screen. Save when it says it matches.

A "no match" doesn't always mean the selector is wrong. A button only exists while it's showing, so a correct selector still won't match if that button isn't on screen when you test. The **Stop** button is the clearest case: it only appears while a reply is generating, so test that one mid-reply.

## Reporting a bug

The main tool is **Advanced: debug info** in the settings modal. Tick the parts you want (your settings, button match status, browser and screen, recent activity), press **Build preview**, then edit the text to remove anything private before you copy. It copies a short plain-text snapshot you can paste into a bug report, no developer tools needed. The activity timeline is kept whether or not console logging is on, so for most bugs this is all anyone needs. Nothing leaves your device until you paste it somewhere.

For watching what the extension does live, turn on **Show a live log on screen** under Advanced: on-screen log. A small panel appears in the corner and updates in real time as generations run and retries fire, which is useful on mobile where the browser console is out of reach. Drag it around by its title bar and resize it from the bottom corner. It is controlled entirely by that toggle, so turn the toggle off to make it disappear.

## Permissions

Declares two permissions:

- `generation`: to hear when replies start, stream, and end. This drives all the retry logic.
- `chat_mutation`: to edit a saved reply. This is used only by the "Find and replace in replies" feature, and only when you turn it on and enter swaps. If you never use that feature, nothing is edited.

`chat_mutation` is a privileged permission, so depending on your Lumiverse setup it may need admin approval before it takes effect. The retry side works without it; only find-and-replace needs it.

The find-and-replace feature runs in a small backend module. The rest of the extension is frontend-only. It makes no external network calls. Your settings are saved to your Lumiverse account through the extension's own scoped storage, so they follow you across browsers, with a copy kept in the browser as a fast local cache.

## How it works

Auto Retry listens to Lumiverse's own generation events. When a reply fails, comes back empty, stalls, or looks cut off or refused, it clicks your regenerate button to try again. That button click is the only part that depends on the page layout, so it is the one thing you can fix yourself in the settings if a Lumiverse update ever moves those buttons.

Find and replace works separately, since editing a saved reply is a backend job. A small backend module watches for finished replies and, when swaps are on, edits the saved message through Lumiverse's Chat Mutation API. That edit is treated as an edit, not a new reply, so it can't set itself off in a loop.
