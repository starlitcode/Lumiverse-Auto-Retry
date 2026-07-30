# All settings

The settings modal is the easy path, and the **Search settings** box at the top of it is the quickest way to reach one option out of the forty-odd below: type part of a name or a description and it shows the matching rows, opening whichever Advanced section they live in. Clear the box to put the panel back as it was.

Each option's **?** shows its description in a small popover over the panel, so opening one never shifts the rows underneath it. Only one is open at a time; tap the **?** again, tap elsewhere, scroll, or press Esc to close it.

Every section header is a proper button, so the Advanced groups open with Enter or Space if you are working from the keyboard rather than a pointer.

The same options live in the CONFIG block at the top of `src/frontend.ts` and `dist/frontend.js`. `dist/frontend.js` is the file the host actually loads, so editing CONFIG there takes effect with no rebuild; editing `src/frontend.ts` needs a `bun run build`.

| Option | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch. |
| showFloatingToggle | false | Put a small draggable on/off button over the chat. |
| floatingToggleSize | 44 | How wide that floating button is, in pixels (28-96). |
| showExtrasToggle | false | Add an on/off entry to the chat input's Extras menu. Its label says which state it is in. |
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
| stuckTimeoutMs | 90000 | Started, then nothing arrived and it never finished, within this. 0 disables. |
| idleTimeoutMs | 45000 | Tokens flowed then stopped for this long. 0 disables. |
| retryOnError | true | Retry provider errors. |
| ignoreHardErrors | true | Skip permanent failures like missing models or invalid API keys. |
| retryOnEmpty | true | Retry empty replies and mid-reasoning cutoffs. |
| retryOnTruncated | true | Retry a reply that ends mid-sentence. |
| retryOnNoPunct | false | Stricter: also retry a reply ending with no punctuation. Noisy in RP. |
| retryOnShort | false | Retry short replies. Off unless you mean it. |
| minChars | 24 | Short threshold, used when retryOnShort is on. Counts the visible reply only, not any reasoning block. |
| retryOnRefusal | true | (beta) Retry an accidental out-of-character refusal. |
| refusalUseBuiltins | true | Use the built-in English refusal lists. Off = only your own phrases. |
| refusalExtraPhrases | (empty) | Phrases that also count as a refusal, one per line. |
| refusalPhraseSubs | (empty) | Reword the built-in phrases with "old => new" rules, one per line. |
| refusalIgnorePhrases | (empty) | Whitelist, one per line; a reply containing any is never a refusal. |
| refusalMaxChars | 2000 | Longest reply still treated as a possible refusal. 0 = no limit. |
| refusalStripThinking | true | Only check the final reply, stripping known reasoning tags first. Off checks the whole raw output. |
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
| confirmButtonLabels | (blank) | Extra dialog button labels it may press when a dialog appears after a retry, one per line. Blank uses the built-in list. |
| stopSelector | (see file) | Host stop button, used to abort a stalled reply. |
| toast | true | Show the little retry pop-up with its Cancel button. |
| liveLog | false | Show a small on-screen panel with recent activity, updating live. |

The two watchdog waits (`stuckTimeoutMs`, `idleTimeoutMs`) are long so a slow connection or a slow local model isn't mistaken for a freeze. If your provider is fast and you want quicker recovery, lower them.

---

[Back to the README](../README.md)
