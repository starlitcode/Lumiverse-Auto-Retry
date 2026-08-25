# Find and replace in replies (beta)

This swaps words in a reply after it arrives and saves the change into the stored message. It has nothing to do with retrying or with refusal detection, and it is off by default. Turn on "Swap words in replies" and add rules to use it.

It is marked beta: it is new, it runs a backend that edits your saved messages, and it needs a privileged permission.

## What gets swapped

It never changes what the model generated. Because it edits the stored reply rather than just the display, the swap sticks, shows everywhere, and the model reads the swapped wording as context on later turns.

Only generated assistant replies are swapped, by either the automatic mode or the button. The opening greeting is authored, not generated, so it is never swapped, and your own messages are never touched.

## Tags in a reply

Some replies carry markup, like `<font color="#ffff00">` for coloured speech or `<i>` for emphasis. Those tags are not prose, and words that appear in ordinary writing also appear in them: `color`, `font`, `small`, `center`.

Swaps skip them. A rule of `color => colour` changes the word where you wrote it and leaves `<font color="...">` standing, because rewriting that does not change any wording, it just quietly stops the text being coloured. Words *between* tags are prose and swap as normal, so `<i>color</i>` becomes `<i>colour</i>`.

**Also swap inside HTML tags**, under Find and replace, turns that off. The reason to want it is a rule aimed at the markup on purpose, such as `#ffff00 => #00ffff` to recolour every line at once.

## The model's thinking

A reasoning model writes its working-out before the reply. Lumiverse shows that in its own block rather than in the message bubble, but when the model writes it as tags inside the reply it is still part of the stored message, which is the thing a swap rewrites.

Swaps leave it alone. Only the reply you read is swapped, and the thinking is put back exactly as it was, so your rules cannot quietly edit what the model worked out in a place you would not think to check. **Also swap inside the thinking**, under Find and replace, turns that off if you want the whole thing swapped.

The common wrappers are recognised, including `<think>`, `[thinking]` and the pipe and channel forms, along with any name you have added under **Extra thinking tag names**. Thinking that got cut off before the reply started counts too.

If your provider returns reasoning separately rather than inside the reply, it is never swapped either way, because the extension only ever writes to the reply itself.

## Swapping by hand

If you would rather apply swaps by hand than have them run on every reply, turn on **Show a 'swap words now' button** under Find and replace. That adds a button that applies your swaps on demand: in the chat input's Extras menu, next to the settings button, or in the floating on/off button's own menu while that button is showing. It only ever edits assistant replies, never your own messages.

By default it swaps just the latest reply and won't swap the same reply twice, so it won't stack on top of an automatic swap or an earlier tap. Two options change that:

- **Show a swap-whole-chat button** adds a second button beside it, **Swap words in every reply**, which applies your rules once to every generated reply in the chat you are viewing. Handy after adding a rule mid-chat or loading a different preset.
- **Allow swapping a reply again** lets it swap a reply you already swapped, which is useful after you change your rules, though it can stack swaps.

You cannot pick out individual messages. The choice is the latest reply, or the whole chat.

It acts on replies from the current session, the ones you have generated, so it is most reliable right after a reply. On a freshly opened old chat it will say there is no reply to swap until you generate one. It works whether or not automatic swapping is on, and is a tap away on both mobile and desktop.

## Confirming each swap

If you never want a swap to touch a reply without your say-so, turn on **Ask before editing a reply**. Every swap, automatic or from the button, then pops up a confirmation you can accept or cancel, so nothing is changed silently.

With automatic swapping on this can prompt often, which is the point for people who do not want surprises. It needs your Lumiverse to support confirm dialogs; if it does not, swaps proceed as normal.

## Writing rules

Rules go in the "Word swaps" box as `old => new`, one rule per line:

```
suddenly => abruptly
sort of => kind of
very => 
```

- The left side can be a single word, a phrase, or a whole sentence, and commas inside it are fine (each rule is a whole line, so a comma no longer splits it).
- A single word matches whole words only, so `cat => dog` changes "cat" but leaves "category" alone. This works in any language, so `café => bar` and `привет => hello` behave the same way and leave "cafétéria" and "приветствие" alone.
- A phrase or sentence matches exactly as you type it, so `sort of => kind of` swaps that phrase wherever it appears, and a full sentence swaps that whole sentence. It has to match your text exactly, including spacing and punctuation.
- Leave the right side empty to delete a word, like `very => ` above. It also removes one trailing space, so a mid-sentence deletion doesn't leave a double space.
- Put the same left side on more than one line to give it options (for example `sky => blue` on one line and `sky => aqua` on the next). By default it uses the first one. Turn on **Pick randomly when a word has more than one swap** and each time that word appears it picks one of its options at random, which is handy for variety.
- By default matching ignores letter case and keeps the original capitalization, so a swap at the start of a sentence stays capitalized. Turn on **Match case exactly** to swap only when the case matches your rule, which also lets `sky` and `Sky` have different swaps.
- Rules are applied in a single pass, so no rule ever acts on what another rule just wrote. `cat => dog` alongside `dog => wolf` turns cats into dogs and dogs into wolves, and it never turns a cat into a wolf. This also means two rules can swap past each other: `hot => cold` with `cold => hot` exchanges the two words rather than making everything one of them.
- Where two rules could match the same spot, the one with the longer left side wins. `cat nap => siesta` beats `cat => dog` on the words "cat nap", so the longer rule is never shadowed by a shorter one that starts the same way. If two left sides are the same length, the one you listed first wins.

### Longest match and random are not the same thing

These last two settle different questions and don't overlap:

- The longest-left-side rule picks **which rule fires** when two different rules compete for the same spot.
- The random option picks **which replacement one rule uses** when you've given that same left side several right sides.

Nothing competes in `sky => blue` and `sky => aqua`, since `sky` is the only rule matching "sky". The only question is whether every "sky" becomes "blue" or each one rolls between the two. Left sides that are identical can't be told apart by length either, so list order decides, which is exactly what the random option is there to override.

In short: longest match is about the left side of your rules, random is about the right side.

## When swapping runs

Swapping follows the extension's own switches. With Auto Retry switched off, or switched off in the chat you are in, nothing is swapped automatically there. The two buttons are the exception: pressing one is you asking for a swap then and there, so they act whatever the switches say.

That includes the waiting settings. **Wait for other extensions to finish** and its delay hold up automatic swapping only, and the panel shows them only while **Swap words in replies** is on. A button applies your swaps straight away and never waits.

Editing a saved reply needs the `chat_mutation` permission, which is [covered on the privacy page](privacy.md#what-it-can-reach-and-why-it-needs-to). If nothing in your rules matches a reply, that reply is left untouched.

## Seeing what your swaps did

Once a swap lands, the reply reads as though the model wrote it that way, so there is nothing left to look at. That makes a rule that never matched look exactly like a rule that is not running.

Turn on the on-screen panel (**Basics**, **Show the on-screen panel**) and it writes a line for each swap saying how many words it changed and the running total for that chat. The **Stats** tab shows the total, split between the chat you are in and everywhere else. Both count words changed rather than replies touched, so one reply with three matches counts as three.

The counts start fresh each time the page loads. They are there to answer "is this rule doing anything", not to keep a history.

## A swap is permanent

There is no undo. A swap rewrites the saved reply, and the wording it replaced is not kept anywhere, so the only way back is to edit the reply yourself in Lumiverse. Rules cannot simply be run backwards either: two of them can map onto the same word, a random rule has no single answer, and a rule that deletes a word leaves nothing to match.

That is worth knowing before you turn automatic swapping on. If you would rather see each edit coming, turn on **Ask before editing a reply**, which puts a confirmation in front of every swap. Trying your rules on one reply with the **swap words now** button, rather than switching automatic swapping on straight away, is the easy way to check a new rule does what you meant.

## Working alongside other extensions

If another extension also rewrites replies, the two can undo each other. [Hone](https://github.com/AMousePad/Hone) with **Auto-Refine AI** on is the case this was built for: it runs a second pass over each reply and saves the result a few seconds after the reply lands.

**Turn on Wait for other extensions to finish** and the swap holds off until the reply stops changing, then applies to whatever the text has become. Hone's refinement is kept, your swaps are applied on top of it, and neither erases the other. If something edits the reply later still and undoes a swap, it is applied again, up to three times per reply, so a slow second pass cannot leave a swap half-done.

**How long to wait** is the wait when nothing else edits at all. Each edit restarts the clock and the swap follows shortly after the last one, so a refinement that takes longer than the wait is still caught. There is a three-minute ceiling, so a reply that never settles is swapped anyway rather than never.

Leave it off if nothing else edits your replies. Auto Retry cannot tell whether Hone's auto-refine is on, since Hone exposes no state to other extensions, so this is a switch rather than something detected. With it off, swaps are instant, which is what you want with Hone set to manual.

## Presets

At the bottom of the find-and-replace settings you can save your word-swap setups as named presets and switch between them without copying rules by hand.

The find-and-replace settings are split into two runs so you can see this at a glance. Under **Saved in a preset** are your rules and the two options that decide how they match, **Pick a swap at random** and **Match case exactly**. Rules saved without those behave differently when loaded, which defeats the point of a preset.

Under **Yours, whatever preset you load** is everything a preset leaves alone. Whether swapping is switched on at all, which of the manual buttons you have, whether a reply can be swapped twice, and whether it confirms before editing all stay as you have them. Exporting still carries all of them, since an export is a backup of your whole setup rather than a preset you load.

The buttons:

- **Load** switches your settings to the preset picked in the list.
- **Save as new** stores the current setup under the name in the box.
- **Update selected** overwrites the chosen preset with your current settings.
- **Rename selected** renames it to the name in the box.
- **Delete** removes it.

Loading a preset takes effect right away and is saved, so there is no separate Save step. Presets are saved to your Lumiverse account the same way your settings are, so they follow you to other browsers and devices. A copy is kept in the browser too, which is what puts the list on screen straight away.

To share a preset with someone else, use **Import / export**, which can include your presets in the file.

---

[Back to the README](../README.md)
