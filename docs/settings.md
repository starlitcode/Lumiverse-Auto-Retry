# All settings

Switching Auto Retry itself off changes nothing in here. Every setting stays where it is and stays editable, because off means paused rather than unconfigured, and setting it up while it is off is a normal thing to want to do. A line at the top says it is off and that your settings are saved.

The settings modal is the easy path, and the **Search settings** box at the top of it is the quickest way to reach one option out of the forty-odd below: type part of a name or a description and it shows the matching rows, opening whichever Advanced section they live in. Clear the box to put the panel back as it was.

Each option's **?** shows its description in a small popover just below that option. Where it opens is fixed per setting rather than decided on the fly, so a given description is always in the same place. The one exception is **What the notes say**, which opens above: that row holds the whole note list, its roles, its buttons and its counter, so below it would be a long way from the **?** you pressed. It floats over the panel, so opening one leaves the rows where they are and never hides the setting you are reading about. A description too long for the room on its side scrolls inside itself rather than moving to the other side. Only one shows at a time. Tap the description, tap the **?** again, tap elsewhere, scroll the panel, or press Esc to close it.

A setting that does nothing until something else is switched on is not shown until it is. Whole sections work the same way: turning **It looks like an accidental refusal** off takes the entire **Advanced: refusal tuning** section away, heading included, because nothing under it does anything while that is off. Turning **Send a note with a refusal retry** on adds the note rows below it, and turning it off takes them away again, so the panel only lists what is actually in use. The switch itself never moves. The search box ignores this and finds a setting whichever way its switch is set, so nothing is ever hidden from you when you go looking for it by name. A row found that way says which switch it is waiting on, so changing it never looks like it did nothing.

Only settings the extension genuinely ignores are hidden this way. Some options look dependent and are not: the word swap rules are still read by the two manual swap buttons whether or not automatic swapping is on, so they stay put.

One setting inside the refusal tuning section is an exception worth knowing about. `refusalThinkTags` goes away with the rest of that section, but it is still used with accidental-refusal retrying off: the blank-reply and short-reply checks read it to find where the reply starts. Search for it by name to reach it while the section is hidden.

The find-and-replace section is split under two headings, **Saved in a preset** and **Yours, whatever preset you load**, so it is clear which of those options loading a preset will change.

Every section header is a proper button, so the Advanced groups open with Enter or Space if you are working from the keyboard rather than a pointer.

The same options live in the CONFIG block at the top of `src/frontend.ts` and `dist/frontend.js`. `dist/frontend.js` is the file the host actually loads, so editing CONFIG there takes effect with no rebuild; editing `src/frontend.ts` needs a `bun run build`.

| Option | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch. |
| showFloatingToggle | false | Put a small draggable on/off button over the chat. |
| floatingToggleSize | 44 | How wide that floating button is, in pixels (28-96). Shown only while `showFloatingToggle` is on. |
| showExtrasToggle | false | Add an on/off entry to the chat input's Extras menu. Its label says which state it is in. |
| maxRetries | 4 | Hard cap per message. Nothing retries past this. |
| pauseWhenFailing | true | Pause auto-retry after several whole runs give up in a row. Cleared by the next reply that comes back fine. |
| breakerRuns | 3 | How many failed runs in a row trigger the pause. A run is one message that used up all its tries. Shown only while `pauseWhenFailing` is on. |
| breakerPauseMins | 5 | How long the pause lasts, in minutes. A reply that comes back fine ends it early. Shown only while `pauseWhenFailing` is on. |
| retryDelayMs | 2000 | Wait before the first retry, in milliseconds. |
| backoffFactor | 2 | Each wait is this many times longer than the last. |
| maxDelayMs | 60000 | Longest it will ever wait. |
| jitter | true | Nudges each wait randomly so retries don't all land at once. |
| rateLimitDelayMs | 15000 | Floor wait when the server says it's busy. Most shared tiers meter per minute, so a shorter wait usually spends a try hitting the same limit. |
| retryByNewReroll | false | Off: a retry redoes the reply in place via the regenerate button. On: a retry clicks the next / swipe button, adding a new reroll and keeping the existing ones. Applies to every retry reason. The other button is the fallback. |
| stuckTimeoutMs | 180000 | Started, then nothing arrived and it never finished, within this. 0 disables. |
| idleTimeoutMs | 90000 | Tokens flowed then stopped for this long. 0 disables. |
| retryOnError | true | Retry provider errors. |
| ignoreHardErrors | true | Skip permanent failures like missing models or invalid API keys. |
| retryOnEmpty | true | Retry empty replies and mid-reasoning cutoffs. |
| retryOnTruncated | true | Retry a reply that ends mid-sentence. |
| retryOnNoPunct | false | Stricter: also retry a reply ending with no punctuation. Noisy in RP. |
| retryOnShort | false | Retry short replies. Off unless you mean it. |
| minChars | 24 | Short threshold, used when retryOnShort is on. Counts the visible reply only, not any reasoning block. Shown only while `retryOnShort` is on. |
| retryOnRefusal | true | (beta) Retry an accidental out-of-character refusal. |
| refusalUseBuiltins | true | Use the built-in English refusal lists. Off = only your own phrases. |
| refusalCatchDisengage | true | Also catch the model breaking off ("I'll stop here", "I won't continue this conversation"). Only counted when it is how the reply ends, never inside quotation marks, and never behind a dialogue tag. Shown only while `refusalUseBuiltins` is on. |
| refusalIgnoreQuoted | true | A built-in match inside quotation marks is a character speaking, so it is not counted. Your own phrases are counted either way. |
| refusalExtraPhrases | (empty) | Phrases that also count as a refusal, one per line. |
| refusalPhraseSubs | (empty) | Reword the built-in phrases with "old => new" rules, one per line. Shown only while `refusalUseBuiltins` is on. |
| refusalIgnorePhrases | (empty) | Whitelist, one per line; a reply containing any is never a refusal. |
| refusalMaxChars | 2000 | Longest reply still treated as a possible refusal. 0 = no limit. |
| refusalStripThinking | true | Only check the final reply, stripping known reasoning tags first. Off checks the whole raw output. |
| refusalThinkTags | (empty) | Extra reasoning tag names, one per line, for unusual thinking wrappers. |
| refusalNote | false | Send a note with a refusal retry, and only a refusal retry. Needs the `interceptor` permission. |
| refusalNotes | one empty note | The notes themselves, each with its own role (system, user or assistant). Up to ten, sent in order as one block. Empty ones are skipped, and nothing is sent while they all are. Shown only while `refusalNote` is on. |
| refusalNotePlacement | after | Where the block goes: after the last message, before it, or at the very start. Shown only while `refusalNote` is on. |
| refusalNoteFromTry | 2 | Which retry the note starts on. 1 sends it every time. Shown only while `refusalNote` is on. |
| refusalNoteStrictType | false | Only attach the note when Lumiverse reports the generation as a regenerate or a swipe. Most builds report every generation as "normal", and on those this stops the note going out at all, which is why it is off. Shown only while `refusalNote` is on. |
| replaceEnabled | false | (beta) Turn on find-and-replace on replies. Edits the saved message. |
| replaceRules | (empty) | "old => new" word swaps, one per line. |
| replaceRandom | false | When a word has more than one swap, pick one at random each time. |
| replaceCaseSensitive | false | Match letter case exactly. Off = case-insensitive, capitalization kept. |
| showReplaceButton | false | Add a button to the input Extras menu that applies your word swaps to the latest reply on demand. |
| showSwapAllButton | false | Adds an Extras button that swaps every generated reply in the chat once. |
| allowReSwap | false | Let either swap button swap a reply again even if it was already swapped (can stack swaps). Applies to both the swap-this-reply and swap-whole-chat buttons. Shown only while one of those two buttons is switched on. |
| confirmBeforeEdit | false | Ask you to confirm before any word-swap edit (automatic or manual); you can cancel. |
| swapWaitForEdits | false | Wait for another extension to finish editing a reply before swapping it. For running alongside Hone with auto-refine on. |
| swapWaitSecs | 15 | How long to wait for that, in seconds (1-120). Each edit restarts the clock. Shown only while `swapWaitForEdits` is on. |
| regenerateSelector | (see file) | Host button. See below. |
| swipeNextSelector | (see file) | Backup button if your build retries by swiping. |
| confirmButtonLabels | (blank) | Extra dialog button labels it may press when a dialog appears after a retry, one per line. Blank uses the built-in list. |
| stopSelector | (see file) | Host stop button, used to abort a stalled reply. |
| toast | true | Show the little retry pop-up with its Cancel button. |
| liveLog | false | Show a small on-screen panel with recent activity, updating live. |

The two watchdog waits (`stuckTimeoutMs`, `idleTimeoutMs`) are deliberately long, and the defaults assume a slow model rather than a fast one. A watchdog that fires early on a model that is slow but healthy is worse than one that fires late: it throws away a reply that was still arriving, and the replacement comes from the same slow model, so it fires again on that one too. If your provider is fast and you want quicker recovery, lower them.

These defaults only apply to a fresh install. Settings already saved to your account keep the values they had, so if you have been using an earlier version and want the new timings, press **Reset to defaults** in the panel.

---

[Back to the README](../README.md)
