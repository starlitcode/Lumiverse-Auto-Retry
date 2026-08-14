# All settings

Switching Auto Retry itself off changes nothing in here. Every setting stays where it is and stays editable, because off means paused rather than unconfigured, and setting it up while it is off is a normal thing to want to do. A line at the top says it is off and that your settings are saved.

The settings modal is the easy path, and the **Search settings** box at the top of it is the quickest way to reach one option out of the fifty-odd below: type part of a name or a description and it shows the matching rows, opening whichever closed section they live in. Clear the box to put the panel back as it was.

There are eight sections. Three are open when the panel opens:

- **Basics** is the master switch and every way of reaching or watching it: the floating button, the Extras entry, the retry pop-up, the on-screen panel, and the switch for the chat you are in.
- **How it retries** is how persistent it is, how long it waits between tries, when it pauses itself, and whether a retry redoes the reply in place or adds a new reroll.
- **When to count a reply as bad** is which kinds of bad reply set off a retry, ending with the two waits for a reply that freezes or never arrives.

Five start shut, each with a **▸** to open it: **Refusal tuning**, **Find and replace**, **Buttons it clicks**, **Debug info** and **Import / export**. They are closed because nothing in them is needed to use the extension, not because they are difficult.

Each option's **?** shows its description in a small popover just below that option. Where it opens is fixed per setting rather than decided on the fly, so a given description is always in the same place. The one exception is **What the notes say**, which opens above: that row holds the whole note list, its roles, its buttons and its counter, so below it would be a long way from the **?** you pressed. It floats over the panel, so opening one leaves the rows where they are and never hides the setting you are reading about. A description too long for the room on its side scrolls inside itself rather than moving to the other side. Only one shows at a time. Tap the description, tap the **?** again, tap elsewhere, scroll the panel, or press Esc to close it.

A setting that does nothing until something else is switched on is not shown until it is. Whole sections work the same way: turning **It looks like an accidental refusal** off takes the entire **Refusal tuning** section away, heading included, because nothing under it does anything while that is off. Turning **Send a note with a refusal retry** on adds the note rows below it, and turning it off takes them away again, so the panel only lists what is actually in use. The switch itself never moves. The search box ignores this and finds a setting whichever way its switch is set, so nothing is ever hidden from you when you go looking for it by name. A row found that way says which switch it is waiting on, so changing it never looks like it did nothing.

Only **Save** keeps what you changed. Closing with the X or tapping outside discards it, so you can try things freely. Saved settings sync to your Lumiverse account, so they follow you to other browsers and devices, and they apply from the next reply onward. Long text boxes, like your word-swap rules, have an **Expand** button that opens a full-size editor.

## Turning it off everywhere

Two options in **Basics**, and you can use either or both:

- **Floating on/off button** puts a small button over the chat that toggles it in one tap. Drag it anywhere; it snaps to the nearest edge and stays where you leave it, and you can set its size. Hold it, or right-click on a computer, for a menu with **Auto Retry settings** and **Hide this button**. When the on-screen panel is set to live in the sidebar drawer, **Open the Auto Retry panel** is in there too.
- **On/off button in the Extras menu** adds an entry next to the settings button. Its label says which state it is currently in, so you can check and change it without opening settings, and it takes up no room on screen.

## Turning it off in one chat

The master switch is all or nothing, which is the wrong shape for a scene where the model is meant to refuse, or a chat you are using to test something.

In the settings panel, under **Basics**, the **This chat** row has a **Turn off here** button. That chat is left alone and every other chat carries on, and the button becomes **Turn on here**. Left alone covers word swaps too: nothing is swapped automatically in a chat you have switched off. This is the only place it is: it is not in the floating button's menu, which is kept to the button's own business.

If the button is greyed out while you are in a chat, it has not been told which chat that is yet. With the `chats` permission granted it asks outright and this clears on its own. Without it, it waits to be told: a reply arriving, a message sent, or switching away and back all do it. The case where you will see it waiting is updating the extension without leaving the chat, since nothing re-renders and so nothing announces where you are.

It is written down in your browser, so it survives a reload. It is not a setting: it is a list of chat ids, which would mean nothing on another account, so it is not synced and not included in an export.

While you are in a chat that is switched off, the top of the settings panel says so and offers **Turn it back on here**. That line is there because a chat you switched off weeks ago and forgot about looks exactly like the extension having stopped working.

## Resetting

**Reset…** at the bottom of the panel opens a picker rather than putting everything back at once. Tick the parts you want returned to their defaults; anything you leave unticked is not touched. The parts are the same ones import and export use, so the names match between the two.

Each line says how many of its settings have actually been changed from the default. A part still at its defaults cannot be ticked, because there would be nothing for it to do. **Tick every setting** ticks all the parts that have something to reset.

**Reset ticked** asks before it does anything. It shows you the parts you picked, how many settings are in each, and whether presets are going with them, and nothing happens until you press **Yes, reset**. **Go back** returns to the list with your ticks where you left them, and Escape or a click outside closes the whole thing without touching a setting. The ticks are held while it is asking, so what it describes and what it does cannot come apart.

The question is asked by the extension rather than handed to Lumiverse's own confirm dialog. Not every Lumiverse build has one, and the old reset treated a missing dialog as a yes.

A reset fills the settings in behind the box without saving them, the same as an import does, so you can look at what it did first. Press **Save** to keep it, or close the panel to discard it. If you press Reset by mistake, closing the panel undoes it.

**Delete saved word swap presets** sits below a rule of its own, and it is the one thing in the picker that is not undone by closing the panel: presets are stored separately from your settings, so deleting them happens straight away. **Tick every setting** never ticks it.

Nothing a reset does goes near your chats, your replies or your characters. Auto Retry only ever reads replies, and a reset does not touch them at all.

Only settings the extension genuinely ignores are hidden this way. Some options look dependent and are not: the word swap rules are still read by the two manual swap buttons whether or not automatic swapping is on, so they stay put.

One setting inside the refusal tuning section is an exception worth knowing about. `refusalThinkTags` goes away with the rest of that section, but it is still used with accidental-refusal retrying off: the blank-reply and short-reply checks read it to find where the reply starts. Search for it by name to reach it while the section is hidden.

The find-and-replace section is split under two headings, **Saved in a preset** and **Yours, whatever preset you load**, so it is clear which of those options loading a preset will change.

Every section header is a proper button, so the closed sections open with Enter or Space if you are working from the keyboard rather than a pointer.

## The on-screen panel

One switch, **Show the on-screen panel**, turns it on. It has three tabs, and **Where that panel goes** decides where it appears. Both choices are the same panel with the same tabs; only the frame around it differs.

**Floating over the chat** is the original: a small box in the corner. Drag the header to move it, drag the bottom-right corner to resize it. Both work with a mouse and with a finger.

Where you leave it is remembered, along with its size and which tab was open, so an update does not put it back in the corner. The floating button is the same. Both are checked against the screen they open on, so a layout saved on a desktop window cannot strand the panel off the edge of a phone. Nothing offers to move the button back to its corner, because dragging it there is fewer taps and the check above already stops it stranding itself.

This is kept in your browser rather than in your settings, like the list of chats you have switched Auto Retry off in. A position belongs to the screen you are sitting at, so it does not follow you between devices and it is not included in an export.

**In the sidebar drawer** puts it in Lumiverse's own drawer instead, next to the app's own tabs. Lumiverse places, sizes and themes it, so there is nothing to drag and nothing to remember, and it cannot cover the reply you are reading. While a retry is running the tab carries a dot, so you can see something is happening without opening it.

Changing this moves the panel as you pick, before you save. Closing the settings without saving puts it back. If your Lumiverse build has no drawer for extensions, asking for the sidebar gets you the floating panel and a line in the Log saying why.

To open it: **Extras → Open the Auto Retry panel**, next to the settings entry. On a computer **Ctrl+K** and typing `Auto Retry` does the same. Neither is offered while the panel is floating, where it is already on screen.

Under the tabs is a line saying what is happening this second, with a dot beside it. The dot is dim and flat when Auto Retry is off or paused, lit and still when it is on with nothing to do, and pulsing while something is actually happening, so a glance at the corner answers the question without reading the line. The pulse is dropped if your system asks for less movement; the glow stays. It sits above all three tabs because the answer is the same whichever one you are reading, and because none of them answered it: the Log says what already happened and the Stats say what has happened overall. It counts down a pending retry in hours, minutes and seconds as each is needed (`47s`, `5m 03s`, `1h 05m 03s`), names what the retry is for and which try it is, says when a reply is arriving and roughly how much of it has landed, says when the model is thinking, and says when it has paused itself after repeated failures. When nothing is happening it says so. A retry running in a chat you have since moved away from is still reported, marked as being in another chat.

The line and the pop-up read from the same place, so they never disagree. Both stop the moment the panel is closed, so nothing is being redrawn for a panel nobody is looking at.

**Log** is what the extension is doing as it happens: generations starting, retries and why, replies that came back fine, notes going out.

**Stats** is what it has been doing since you opened the tab: replies that came back fine, retries fired, messages it gave up on, and a breakdown of what it retried for, with a bar for each so the shape reads at a glance. **Watching for** counts up while you are looking at it, in the same `1h 05m 03s` form as everything else here. It also says how often a reply needed a retry at all, and tells you when it has paused itself after repeated failures, which is the state that otherwise looks like it having stopped working. **Clear** on this tab starts the counting again.

**Prompt** is the whole prompt that went to the model. Every message in order, with its role, how large it is, and whether it came from your chat or was added around it. Tap one to read it.

Your **refusal notes are marked** in that list, in the accent colour, and opened for you. A line at the top says how many went and where in the prompt they landed. That is the thing the Prompt view is most likely to be open for: seeing exactly how and where a note was inserted.

This is what actually went, after your setup, your world info, your persona and every extension have had their turn at it. That is a different question from the one Lumiverse's own **Prompt Breakdown** answers, which is what your chat is built from.

**Copy** and **Clear** act on whichever tab you are looking at. Copy takes everything that tab is showing, in the order it is shown: the whole log, every counter and the retry breakdown, or the whole prompt with its summary, where your notes landed, and which message carried one.

Switching tabs works by tapping, and from a keyboard with the left and right arrows.

The prompt is only captured while the Prompt tab is actually open. Switch to Log, close the panel, or close the tab, and nothing is captured at all. That is why there is no separate switch for it: a setting left on would go on paying for itself in every chat long after you looked once. What is captured is captured on your device and shown to you. Nothing is sent anywhere, nothing is written to disk, and it goes when you close the tab. A very long prompt is trimmed for display and says so rather than showing you part of it silently.

The same options live in the CONFIG block at the top of `src/frontend.ts` and `dist/frontend.js`. `dist/frontend.js` is the file the host actually loads, so editing CONFIG there takes effect with no rebuild; editing `src/frontend.ts` needs a `bun run build`.

| Option | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch. |
| showFloatingToggle | false | Put a small draggable on/off button over the chat. |
| floatingToggleSize | 44 | How wide that floating button is, in pixels (28-96). Shown only while `showFloatingToggle` is on. |
| showExtrasToggle | false | Add an on/off entry to the chat input's Extras menu. Its label says which state it is in. |
| maxRetries | 4 | Hard cap per message. Nothing retries past this. The lowest is 1: to stop it retrying, switch it off rather than setting this to 0. |
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
| retryOnNoPunct | true | Retry a reply that stops on a word with nothing after it. Punctuation in any script counts as an ending, and so does an emoji. |
| retryOnShort | false | Retry short replies. Off unless you mean it. |
| minChars | 24 | Short threshold, used when retryOnShort is on. Counts the visible reply only, not any reasoning block. Shown only while `retryOnShort` is on. |
| retryOnRefusal | true | Retry an accidental out-of-character refusal. |
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
| refusalNotes | one empty note | The notes themselves. Each carries its own role (system, user or assistant) and its own first try, so notes can be set to escalate. Up to ten. Whichever have come due are sent together, in order. Empty ones are skipped, and nothing is sent while they all are. Shown only while `refusalNote` is on. |
| refusalNotePlacement | after | For the whole list, not one note. Where the block of due notes goes: after the last message, before it, or at the very start. Shown only while `refusalNote` is on. |
| refusalNoteStrictType | false | For the whole list, not one note: it decides whether any of them are sent at all. Only attach them when Lumiverse reports the generation as a regenerate or a swipe. Most builds report every generation as "normal", and on those this stops the note going out at all, which is why it is off. Shown only while `refusalNote` is on. |
| replaceEnabled | false | (beta) Turn on find-and-replace on replies. Edits the saved message. |
| replaceRules | (empty) | "old => new" word swaps, one per line. |
| replaceRandom | false | When a word has more than one swap, pick one at random each time. |
| replaceCaseSensitive | false | Match letter case exactly. Off = case-insensitive, capitalization kept. |
| showReplaceButton | false | Add a button to the input Extras menu that applies your word swaps to the latest reply on demand. |
| showSwapAllButton | false | Adds an Extras button that swaps every generated reply in the chat once. |
| allowReSwap | false | Let either swap button swap a reply again even if it was already swapped (can stack swaps). Applies to both the swap-this-reply and swap-whole-chat buttons. Shown only while one of those two buttons is switched on. |
| confirmBeforeEdit | false | Ask you to confirm before any word-swap edit (automatic or manual); you can cancel. |
| swapWaitForEdits | false | Wait for another extension to finish editing a reply before swapping it. For running alongside Hone with auto-refine on. |
| swapWaitSecs | 85 | How long to wait for that, in seconds (1-300). A refinement pass is a whole generation, so how long it takes depends on the model, the prompt and how much it has to read. Each edit restarts the clock. Shown only while `swapWaitForEdits` is on. |
| regenerateSelector | (see file) | Host button. See below. |
| swipeNextSelector | (see file) | Backup button if your build retries by swiping. |
| confirmButtonsCustom | false | Read the box below. Off, only the built-in dialog button list is used, and the box is not shown. |
| confirmButtonLabels | (blank) | Extra dialog button labels it may press when a dialog appears after a retry, one per line. Tried before the built-in list, which is used as well. Shown and read only while `confirmButtonsCustom` is on. |
| stopSelector | (see file) | Host stop button, used to abort a stalled reply. |
| toast | true | Show the little retry pop-up with its Cancel button. It counts the wait down in real time and names what the retry is for and which try it is. |
| liveLog | false | Show the on-screen panel. Two tabs: Log for what the extension is doing, Prompt for what went to the model. |

The two watchdog waits (`stuckTimeoutMs`, `idleTimeoutMs`) are long, and the defaults assume a slow model rather than a fast one. A watchdog that fires early on a model that is slow but healthy is worse than one that fires late: it throws away a reply that was still arriving, and the replacement comes from the same slow model, so it fires again on that one too. If your provider is fast and you want quicker recovery, lower them.

These defaults only apply to a fresh install. Settings already saved to your account keep the values they had, so if you have been using an earlier version and want the new timings, open **Reset…** and tick **Retry behavior**.

---

[Back to the README](../README.md)
