# Changelog

Every released version of Auto Retry, newest first.

**Two releases need a reinstall rather than an update: [4.0.0](#400) and [3.0.0](#300).** Both are marked below. Your settings, presets and word swap rules are stored separately and are not touched by reinstalling.

---

## 4.0.0

_2026-07-31_

**Reinstall required.** Renaming the repository's main branch broke the link your install used to find updates. Remove Auto Retry and install it again from the same URL and it will pick up the new name. Your settings are saved to your Lumiverse account, so they come back with it.

- **Main is now called `stable`, and there is a new `testing` branch.** Stable only moves when there is a real release, so installing from it means a notification when something has actually shipped. Testing is where work in progress goes, so install from there for an early look, bugs included.
- **The clear button in the search box follows your theme.** The cross that empties the search field was white. It now uses the same muted colour as the **?** circles next to each setting. Chrome, Edge and Safari only; Firefox does not add a clear button to search fields at all, so there is nothing there to restyle.

Nothing else changed from 3.3.0. The major version is for the forced reinstall, not for the size of the change.

## 3.3.0

_2026-07-31_

- **Search the settings.** A box at the top of the settings panel finds any option by its name or its description, and opens whichever Advanced section it lives in. There are over forty options now, so this saves remembering which group something is under. Clear the box and the panel goes back exactly as it was.
- **Floating on/off button.** Optional, off by default. Puts a small round button over the chat that turns Auto Retry on or off in one tap and shows which state it is in. Drag it anywhere, it snaps to the nearest edge and stays where you leave it, and you can set its size or right-click it to hide it. Needs the new `ui_panels` permission.
- **Try your refusal settings on a reply.** New box at the bottom of the refusal tuning section. Paste a reply, press Check this text, and it says whether it counts as a refusal and what decided it: which phrase matched, which built-in pattern fired, or why it was passed over. It uses the values in the boxes as they are, so you can try a change before saving. It works the other way round too: paste an in-character line that keeps getting re-rolled and it names the rule catching it, which tells you what to put in "Never treat these as a refusal".
- **Descriptions no longer shove the list around.** Tapping a **?** used to open the description inside the row and push everything below it down the screen, and opening a second one moved everything again. It now floats just below that setting, so nothing moves and the setting you asked about stays visible. Only one shows at a time. Tap the description, tap the **?** again, tap elsewhere, scroll, or press Esc to dismiss it.
- **Find and replace says what a preset carries.** That section is split under two headings. **Saved in a preset** holds your rules and the two options that decide how they match. **Yours, whatever preset you load** holds everything a preset leaves alone: whether swapping is on at all, which buttons appear in your Extras menu, whether a reply can be swapped twice, and whether it confirms before editing. Loading a preset cannot change any of those.
- **Word swap presets follow your account.** They used to live only in the browser you made them in, so your settings would move to a new device and your presets would not. They now sync the same way your settings do, with a copy kept in the browser so the list is on screen instantly.
- **Copy and Clear on the live log.** The on-screen log is there because the browser console is out of reach on a phone, which is also where selecting text by hand is worst. Copy puts the whole log on your clipboard in one tap. Clear empties it so a long session does not bury what you are watching for.
- **Session totals in the debug report.** Alongside the activity timeline it now counts how many replies came back fine, how many retries fired, how many messages it gave up on, and a breakdown of retries by reason. It turns "it retries too much" into "ninety retries, all of them for cut off".
- **Keyboard access to the Advanced sections.** Those headers could not be reached without a pointer, so refusal tuning, find and replace, buttons, debug info and import/export could not be opened from a keyboard at all. They are proper buttons now: tab to one and press Enter or Space.
- **More of the list on screen.** The settings panel was capped short enough that a tall phone had most of its screen sitting empty underneath it. It now uses the height it is given, so roughly 40% more options are visible before scrolling.
- **The panel looks more like the rest of Lumiverse.** Buttons like Reset to defaults were see-through with just an outline, so they read as text rather than as buttons. They use the theme's own button colour now, and hovering one switches to the theme's hover colour instead of just brightening it. The retry pop-up, the on-screen log and the full-size text editor were also rendering with the wrong corner rounding, asking for the small radius when they meant the larger one.
- **Button labels stay readable on any theme.** On a theme whose accent colour sits close to white, the label on a filled button like Save washed out and was hard to make out. The panel now checks as it draws whether each label stands out from what is behind it, and repaints only the ones that do not. Everything else is left exactly as the theme set it.
- **Fixed: the retry pop-up was nearly see-through.** It was painted with a colour meant to tint a surface rather than be one, so it came out as a faint smudge over the chat instead of a solid pill.
- **Fixed: backups were quietly dropping four settings.** Pause when everything is failing, Failed runs before pausing, How long to pause, and Extra dialog buttons it may press were all missing from import and export, so a backup came back without them. They are included now, and any setting added in future is carried automatically.
- **Fixed: the debug report was missing the same four.** It now reads the list straight from the options themselves, so every setting is always in it and there is no second list to fall out of date.
- **Fixed: duplicate swap-whole-chat button.** That Extras entry was not being cleaned up when the extension reloaded, so it stacked up another copy each time.
- **Word swaps update the chat faster.** Applying swaps to what is already on screen walked the whole page once per rule, so a long rule list meant dozens of passes over every message. It walks once now.

**Updating:** the on/off button setting was renamed internally, so if you had it switched on you will need to switch it back on. Lumiverse also asks you to approve the new `ui_panels` permission. That one only lets the floating button take up screen space; everything except the floating button works without it.

## 3.2.1

_2026-07-29_

- **Clearer settings descriptions.** Trimmed the wordier ones again so they say what the setting does without the bloat.
- **The docs are split into pages.** The README was getting long, so it is now a short intro plus a `docs/` folder: when it retries, word swaps, all settings, buttons it clicks, import and export, reporting a bug.

## 3.2.0

_2026-07-28_

- **Works with Regeneration Feedback.** Reported by a Discord user. With Lumiverse's Regeneration Feedback turned on, pressing regenerate opens a box asking for guidance, and that box is what actually starts the reply. Auto Retry was clicking regenerate and stopping there, so nothing happened. It now presses Skip and carries on. Manual regenerates still open the box normally, so neither setting needs changing.
- **Extra dialog buttons it may press.** New box in the buttons settings, for the rare case where that dialog's button says something other than Skip. Type the wording exactly as it appears, one per line. Most people will not need it.
- **README.** New sections on how Regeneration Feedback and Auto Retry work together, and on writing selectors by hand.

## 3.1.2

_2026-07-24_

- **Catches more refusals.** Some slipped through, especially ones phrased around roleplay itself, like "I cannot participate in romantic or sexual roleplay scenarios, even in a fictional context." Those are caught now. In-character lines are still safe, so a character saying "I cannot participate in this duel" will not trigger a retry.

## 3.1.1

_2026-07-24_

- **Word swaps show up right away.** Swapped replies were saved correctly but the chat did not render them, so the change only appeared after leaving and reopening the window. The swap now updates the reply on screen as soon as it is made.

## 3.1.0

_2026-07-24_

- **Word swap presets stick to your rules.** A preset used to carry the whole word-swap section, so loading one could switch swapping on, remove the confirm-before-editing prompt, allow double swaps, or move buttons around in your Extras menu. It now saves your rules plus **Pick a swap at random** and **Match case exactly**, and leaves the rest alone. Exports are unchanged, and presets already saved keep working.
- **Fewer good replies re-rolled as refusals.** A character saying something like "I can't assist you with the horses" no longer reads as the model refusing, and a self-identifying AI character in dialogue is treated as a character rather than the model breaking scene. Real refusals are still caught.
- **The short-reply check measures the visible reply.** It was counting reasoning blocks toward the length, so on a thinking model a two-word reply could pass as long enough. Only affects you if that option is on, since it is off by default.

## 3.0.2

_2026-07-24_

- **Tidier buttons section.** The Test and Reset messages sat in different places depending on their length, since a short one fit beside the button and a long one wrapped below it. On narrow screens the Test result also got squeezed by the two buttons sharing its line. Both messages now sit on their own line under the buttons, with the space reserved so nothing shifts when text appears.

## 3.0.1

_2026-07-23_

- **Reset button selectors.** New button at the bottom of Advanced: buttons it clicks. Puts all three selectors back to the defaults without touching anything else. It fills the boxes, so press Save to keep it or close the panel to undo.
- **Shorter description on that section.** It had grown into a wall of text. The panel now covers what you need on first read, and the README has the fallback list and selector syntax.
- **README: word swaps.** Clearer on how the longest-match rule and the random option differ. Longest match decides which rule fires when two compete for the same spot; random decides which replacement one rule uses when several are given. Also notes that identical left sides fall back to list order.

## 3.0.0

_2026-07-23_

**Reinstall required.** The repository history was rewritten, so this version does not arrive as a normal update. Remove Auto Retry and install it again from the repo.

**Check your word swap rules.** Rules now run in a single pass, so no rule acts on what another rule just wrote. `cat => dog` alongside `dog => wolf` turns cats into dogs and dogs into wolves, and never turns a cat into a wolf. If you relied on rules chaining, your output will change. The upside is that two rules can now swap past each other: `hot => cold` with `cold => hot` exchanges the two words instead of making everything one of them. Where two rules could match the same spot, the one with the longer left side wins.

- **Retry by adding a new reroll works on everything.** It used to fall back to regenerate on empty replies and errors, which is exactly when regenerate clears the rerolls the option exists to keep.
- **It will not click a dead button.** Hidden and disabled buttons accept a click and do nothing, and that counted as a retry. They are skipped now, and if a click starts no reply it tries the other button once.
- **Empty and cut-off checks no longer depend on the refusal option.** Turning off Ignore the thinking / reasoning was also switching off those two checks, so thinking-only and mid-thought replies slipped through. That option covers refusal matching only now.
- **Fewer false cut-offs on reasoning models.** Punctuation inside a closed thinking block was skewing the check.
- **Stalled replies retry every time.** Only the first stall per chat worked; after that the extension's own stop click was read as the user pressing Stop.
- **Pick it for me.** New button by each button setting. Press it, then click the real button in Lumiverse. It builds selectors from labels and data attributes rather than class names, which Lumiverse regenerates every release.
- **Pause when everything is failing.** On by default. Several failed runs in a row pauses auto-retry instead of retrying on every message. Two boxes set how many and how long. A good reply ends it early.
- **Selectors can contain commas.** `:is(a, b)` and `[aria-label="Next, swipe"]` each count as one entry.
- **Debug info says why retries stopped.** It now opens with whether auto-retry is active, off, or paused.

## 2.8.3

_2026-07-22_

- **Fixed retries failing on truncated or refused replies.** Chat UIs attach a swipe or regenerate button to every message. The extension was clicking the button for the first message in the chat instead of the newest one, so the retry did nothing. It now targets the last matching button on the page.

## 2.8.2

_2026-07-22_

- **Fixed retries stopping on empty replies.** With "Retry by adding a new reroll", an empty or error reply creates no message bubble on screen. The extension looked for the swipe button anyway, and because the real one was missing, the broad default selector (`aria-label*="next"`) matched an unrelated button such as "Next chat" and clicked it. The extension believed the retry had fired and waited indefinitely. It now checks whether the reply has visible content, and if not it skips the swipe button and goes straight to regenerate.
- **Fixed stuck retry budgets.** Added a 6-second timer. If a retry click fails to start a generation, the extension resets its counter so the next message works normally.
- **Selectors check in the order given.** Comma-separated selectors now evaluate left to right. Put specific selectors first, broad ones last.
- **New refusal pattern.** Covers models breaking character to refuse by naming specific prohibited content policies.

**Action required unless you rely on your own selectors.** Saved settings override the new code defaults. Open settings, press Reset to defaults, and Save. Or paste these by hand:

- Regenerate: `[title="Regenerate"], [data-action="regenerate"], [data-testid="regenerate"], button[aria-label*="regenerate" i], button[title*="regenerate" i]`
- Next / swipe: `[aria-label="Next swipe"], [data-action="swipe-right"], [data-testid="swipe-right"], button[aria-label*="next swipe" i], button[aria-label*="swipe right" i], button[aria-label*="reroll" i], button[title*="swipe" i]`
- Stop: `[aria-label="Stop generation"], [data-action="stop"], [data-testid="stop"], button[aria-label*="stop" i], button[title*="stop" i], [class*="_sendBtnStop_"]`

## 2.8.1

_2026-07-21_

- **Fixed: a refusal buried in the thinking with no reply after it now retries.** Some models put their whole refusal inside the reasoning and then write nothing. The empty-reply check now sees through inline think blocks, so an output that is all thinking and no reply gets retried instead of slipping past. A refusal in the thinking followed by a fine reply is still left alone, and a reply that itself refuses was already caught.

## 2.8.0

_2026-07-21_

- **Whole-chat swapping is its own button.** The "Button swaps the whole chat" toggle is gone. A new option adds a second Extras button, **Swap words in every reply**, that applies your rules once to every generated reply in the chat, which is handy after adding a rule mid-chat or loading a different preset. Off by default, and the original swap button now always does just the latest reply.

## 2.7.0

_2026-07-21_

- **Presets travel with your exports.** Advanced: import / export has a Word swap presets option. Tick it to include your presets in the export file. Importing merges them: same-named presets are replaced, new ones are added, the rest are left alone. Since presets lived on one browser at the time, this was how to move them between devices or share them. Imported presets save right away, with no Save press needed.
- **Importing no longer jumps the panel.** Importing general settings used to snap the panel back to the top. It now fills the fields where you are and stays put.
- **Shorter store description.** Trimmed to one line so it reads clean in the extension list.

## 2.6.0

_2026-07-19_

- **Word swap presets.** Save your word-swap setups as named presets and switch between them without copying rules by hand. They live at the bottom of Advanced: find and replace. Pick one and press Load, or use Save as new, Rename selected, Update selected and Delete. Loading takes effect right away. Kept on your browser, so they do not sync across devices.
- **Expand button on long text boxes.** Any multiline field, such as word-swap rules or refusal phrase lists, has an Expand button that opens a full-size editor. It opens without popping the keyboard, so you can read first and tap in when you want to type.
- **Descriptions moved into tooltips.** Each setting's explanation sits behind a small **?** next to its name. Hover on a computer, tap on a phone. Keeps the panel much more compact.
- **Follows your theme's fonts.** Panels and the settings UI use the Lumiverse global font, headers use the bold version, and the code areas (debug preview and live log) use the mono font.
- **Removed the input focus glow.** Text boxes get a clean border tint on focus instead of the glow ring.
- **Advanced sections stay put.** Opening the find and replace Advanced section and then loading a preset no longer scrolls the panel up.
- **Leaner wording.** Trimmed the rambling hints and descriptions in the settings and README down to what helps.

## 2.5.0

_2026-07-18_

- **Keep your rerolls on retry.** Suggested by a Discord user. New toggle, "Retry by adding a new reroll", under a "How it redoes a reply" section. Off (the default), a retry redoes the reply in place with your regenerate button, which on some builds clears the other rerolls on that message. On, a retry clicks your next / swipe button instead, adding a fresh reroll and leaving existing ones in place. It falls back to regenerate if the swipe button is not found, so set that selector in the buttons section if retries stop after turning it on.
- **Heads up on repeated failures.** In the new mode each retry adds a reroll rather than replacing one, so a reply that fails a few times before it lands can leave a couple of empty or partial rerolls stacked next to the good one. Regenerate mode still replaces in place with no pile-up, so both behaviours are there to pick from.
- **Easier to debug.** Copy debug info lists which retry mode is active, and the "couldn't find your button" messages no longer assume regenerate, so they read right in either mode.

## 2.4.0

_2026-07-17_

- **Optional "swap words now" button.** A toggle adds a button to the input's Extras menu that applies your word swaps on demand, so you can swap by hand instead of leaving automatic swapping on. Off by default.
- **More swap control.** Two new options: swap the whole chat at once instead of just the latest reply, and allow re-swapping a reply already swapped, useful after changing your rules. By default a reply is only swapped once, so swaps never stack.
- **Ask before editing.** New toggle that makes every swap, automatic or manual, ask for confirmation before changing a reply. Off by default.
- **The greeting is never touched.** Word swaps only apply to generated replies. The opening message is always left alone, in both automatic and manual modes.
- **Clearer input focus.** Text and swap-rule boxes show a soft accent glow when focused instead of a barely visible outline.
- **Follows your theme.** The settings panel, buttons, live log and preview box use your Lumiverse theme's corner rounding instead of fixed values.
- **Sturdier under bad input.** A single malformed swap rule is skipped on its own instead of quietly disabling all your swaps, plus general error-handling hardening.
- **Tidier settings.** Find and replace moved under Advanced so it does not clutter the main list.

## 2.3.0

_2026-07-16_

- **Refusals inside the model's thinking are ignored.** Only the final reply is checked. Reasoning blocks (`<think>`, `<thinking>`, `<reasoning>`, `<reflection>`, `<scratchpad>` and similar, plus `[tag]` forms) are stripped before matching.
- **Custom thinking tags.** Add any wrapper your model uses under "Extra thinking tag names", one per line. New "Ignore the thinking / reasoning" toggle, on by default.
- **Settings sync to your Lumiverse account.** They follow you across browsers and devices instead of living in one browser. Existing settings migrate up automatically.
- **Broader refusal detection.** Added apology-style refusals like "I'm sorry, but I can't create...", "that's not something I can help with" and "I'm not going to generate that". Written so in-character lines stay untouched.
- **Fixed content blocks getting dropped instead of retried.** Errors like "403 Forbidden: content blocked" now route to the accidental-refusal retry. Real auth, not-found and balance errors are still skipped.
- **Cleanup.** Removed an unverified `metadata` field from message edits, fixed a broken word-swap hint, and fixed checkbox theming.

## 2.2.0

_2026-07-15_

- **More retryable error codes.** Added 408, 500, 502, 503, 504 and Cloudflare 520 to 524. These temporary server failures now trigger exponential backoff retries. Also added `timeout`, `temporary` and `network` message patterns to catch network transients.
- **Expanded hard error detection.** Added `permission`, `forbidden` and `not allowed` to the existing auth checks, plus HTTP 411 and 415, to prevent retries on malformed-request errors where the problem is the request rather than the server.

## 2.1.1

_2026-07-15_

- **Added HTTP 402 (Payment Required) to hard failures.** If a provider cuts you off for running out of credits or an unpaid balance, the extension recognises it immediately and stops retrying.

## 2.1.0

_2026-07-15_

- **Added a "Skip hard failures" toggle.** Permanent errors such as missing models, invalid API keys or dead-end HTTP codes now stop the extension immediately instead of leaving it in a useless retry loop. On by default, and can be turned off.

## 2.0.0

_2026-07-14_

Changes how rules are formatted, plus a spacing fix.

- **Rules and phrases are one per line.** Word swaps, custom refusal phrases, the whitelist and reword rules are no longer separated by commas.
- **Word swap and refusal settings use multi-line text areas.** Easier to manage lists, and Enter starts a new rule directly in the settings.
- **Commas can be used inside your swaps.** Because rules split on line breaks, you can swap phrases and full sentences containing commas, for example `Well, she left. => He stayed quietly.` **If you have multiple comma-separated entries on one line, move them onto separate lines.**
- **Word deletions clean up trailing spaces.** Leaving the right side empty to delete a word now swallows one trailing space, so removing a word mid-sentence leaves single spacing instead of a double space.

## 1.5.0

_2026-07-13_

- **The "longest reply to treat as a refusal" cap defaults to 2000** (was 1200). Some models write long, padded refusals (apology, "as an AI", a paragraph of reasoning, then offered alternatives) that ran past the old limit and slipped through. 2000 catches those while leaving genuinely long replies alone.
- **That cap can be set to 0 to turn it off entirely**, so refusals are caught at any length. It stays safe because length alone never triggers a retry: a reply still has to match the refusal patterns, so a long scene will not be re-rolled just for being long.

## 1.4.1

_2026-07-13_

A patch: fixes and cleanup, nothing new.

- **Fixed:** resizing the live log on mobile. Dragging the panel's corner to resize now works on Android and other touch screens. It was mouse-only before, so there was nothing to grab on a phone.
- **Removed:** the "write technical details to the console" toggle. Redundant now that the live log shows the same activity on screen and the debug report already captures it.
- **Renamed:** the "On / off" settings group to "Basics".
- **Renamed:** the "Notifications" import/export category to "On-screen", since it covers the retry pop-up and the live log.
- **Moved:** the retry pop-up toggle out of the old feedback group and up into Basics, since it is not an advanced option.
- **Regrouped:** the live log and the debug info section now sit next to each other as one debugging area, instead of being split apart by import/export, which moved to the bottom.
- **Reworded:** the import/export description, so it is clearer about what importing does.

## 1.4.0

_2026-07-13_

- **Import and export your settings.** Open Advanced: import / export, tick which parts to include (retry behaviour, refusal detection, word swaps, button selectors, notifications), then Export to file to save them or Import from file to load one. An import puts the values into the settings without saving, so you can review them first, then press Save to keep them or close to discard.
- **Choosable debug info**, in a new Advanced: debug info section. Pick which parts to include (your settings, button match status, browser and screen, recent activity), build a preview, edit out anything you would rather not share, then copy. The old Copy debug info button in the footer is gone, replaced by this section.
- **A live log you can watch on screen**, under Advanced: feedback. A small panel shows recent activity as it happens: generations, retries and why, finishes. Handy on mobile especially, where the browser console is out of reach.

## 1.3.1

_2026-07-12_

- **Cleaned up a quote in one of the settings descriptions** so it displays properly.

## 1.3.0

_2026-07-12_

Follow-up building on find and replace.

- **A word can have more than one swap.** List it more than once and it collects all the options. By default it uses the first one.
- **New random-pick toggle.** Turn it on and each time that word appears it picks one of its options at random, so "the sky... the sky" can become "the blue... the aqua".
- **New match-case-exactly toggle.** Off by default, swapping any case and keeping the original capitalisation. On, it only swaps when the case matches your rule, which also lets `sky` and `Sky` have different swaps.

## 1.2.0

_2026-07-12_

- **Accidental-refusal retry (beta).** When the model breaks character to refuse something harmless, it re-sends the exact same request and tries again, capped by your retry limit. It never changes your prompt or swaps any words, it just gives the reply another roll. A refusal the model really means will repeat and stop on its own.
- **Refusal detection you can tune**, under a new Advanced section: add your own refusal phrases, whitelist lines that should never count, reword the built-in ones, or switch the built-in list off entirely. The whole feature is one toggle to turn off.
- **Find and replace in replies (beta).** Swap words you do not like for ones you prefer, saved right into the reply. Whole words only by default, so "cat" will not touch "category". It keeps capitalisation, and an empty right side deletes a word. Off by default.
- **A new chat-editing permission** (`chat_mutation`) alongside the existing generation one. Only used by find and replace, so it can save its edits to a reply. Depending on your setup it may need admin approval when you update, and if you never use find and replace nothing is touched.
- **Advanced settings now collapse**, tucked behind a tap-to-open header so the basic switches stay front and centre.
- **README cleaned up and updated**, reorganised, and now covering the new settings and permissions.

## 1.1.6

_2026-06-27_

- **Fixed contradictory wording in the frozen-reply settings.** The settings said to make the timeout numbers bigger for a slow connection or local model, but the defaults are already long for exactly that case. It now matches the README: the defaults lean long on purpose, and you lower them if your provider is fast and you want quicker retries.

## 1.1.5

_2026-06-27_

- **The selector Test no longer overstates what it knows.** A failed match says "no match right now" instead of "not on screen right now".

## 1.1.4

_2026-06-27_

- **Closing settings with the X discards unsaved changes.** Before, edits took effect the moment you made them, so closing without saving still left them applied to the current session, which was confusing. Now only **Save** keeps changes, and closing with X or tapping outside throws away anything unsaved. **Reset** counts as a change you made, so it sticks.
- **Number settings cannot be left blank or broken.** Empty, non-numeric, negative or absurd values snap back to a sensible default or the nearest allowed limit, whether you blur the box, hit Save mid-edit, or load saved settings. Before, clearing a box could quietly save a zero.
- **Testing an empty selector box gives a clearer message.** It says "type a selector first" instead of reporting no match right now.
- **Fixed a rare timing bug where a retry could cancel itself.** If a stalled reply was aborted and its "stopped" signal arrived late, the extension could mistake it for you pressing Stop and cancel the retry it had just started. It now remembers aborted replies properly, so their late signals are ignored even after the next reply has begun.
- **The "buttons it clicks" settings are explained better.** It spells out that each box takes a CSS selector, that the three boxes are three different buttons for three different jobs, and that you can list a few separated by commas as fallbacks. The README matches.

## 1.1.3

_2026-06-26_

- **Testing a button selector is clearer.** A button only exists in the page while it is on screen, so a correct selector will not match if that button is not showing. The result now reads "not on screen right now" instead of "no match", and the settings and README explain it: the **Stop** button only appears while a reply is generating, so test that selector mid-generation rather than from an idle screen.
- **Tightened up the wording** in the settings descriptions and README.

## 1.1.2

_2026-06-25_

- **Buttons respond to taps on mobile.** Before, they only reacted to mouse hover, which phones do not have, so pressing Save, Test or Cancel gave no feedback. The retry pop-up's Cancel button is also sized to match the others for an easier tap.
- **Fixed a settings hint that showed the wrong example time**, so the "wait before the first retry" description matches the actual default.

## 1.1.1

_2026-06-17_

- **Copy debug info includes a recent-activity log**, so a bug report shows what actually happened (generations starting, retries firing and why, a clean finish) rather than just a snapshot of your settings.

## 1.1.0

_2026-06-17_

- **A Cancel button on the retry pop-up**, so you can pull the plug even while it is counting down to a retry.
- **Settings reworded in plain language**, with a short description on each group.
- **Tuned the defaults** so a slow reply or a slow local model is not mistaken for a frozen one and retried into a pile-up.
- **Better on mobile**, with bigger tap targets and a layout that fits narrow screens.
- **Fixed a couple of menu colours** that were not matching the theme.
- **A Copy debug info button**, so reporting a bug is one tap with no dev tools needed.
- **README updated** with the new settings, defaults, and a how-to-report-a-bug section.

## 1.0.0

_2026-06-08_

First release.

---

[Back to the README](README.md)
