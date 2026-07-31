# Find and replace in replies (beta)

This swaps words in a reply after it arrives and saves the change into the stored message. It is separate from everything above: it has nothing to do with retrying or with refusal detection, and it is off by default. Turn on "Swap words in replies" and add rules to use it.

It is marked beta: it is new, it runs a backend that edits your saved messages, and it needs a privileged permission.

It never changes what the model generated. Because it edits the stored reply rather than just the display, the swap sticks, shows everywhere, and the model reads the swapped wording as context on later turns. Only generated assistant replies are swapped, by either the automatic mode or the button. The opening greeting is authored, not generated, so it is never swapped, and your own messages are never touched.

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

## A swap is permanent

There is no undo. A swap rewrites the saved reply, and the wording it replaced is not kept anywhere, so the only way back is to edit the reply yourself in Lumiverse. Rules cannot simply be run backwards either: two of them can map onto the same word, a random rule has no single answer, and a rule that deletes a word leaves nothing to match.

That is worth knowing before you turn automatic swapping on. If you would rather see each edit coming, turn on **Ask before editing a reply**, which puts a confirmation in front of every swap. Trying your rules on one reply with the **swap words now** button, rather than switching automatic swapping on straight away, is the easy way to check a new rule does what you meant.

## Presets

At the bottom of the find-and-replace settings you can save your word-swap setups as named presets and switch between them without copying rules by hand.

The find-and-replace settings are split into two runs so you can see this at a glance. Under **Saved in a preset** are your rules and the two options that decide how they match, **Pick a swap at random** and **Match case exactly**. Rules saved without those behave differently when loaded, which defeats the point of a preset.

Under **Yours, whatever preset you load** is everything a preset leaves alone. Whether swapping is switched on at all, which buttons appear in your Extras menu, whether a reply can be swapped twice, and whether it confirms before editing all stay as you have them. Exporting still carries all of them, since an export is a backup of your whole setup rather than a preset you load.

Pick a saved preset and press **Load** to switch your settings to it. To store the current setup, type a name and press **Save as new**. **Update selected** overwrites the chosen preset with your current settings, **Rename selected** renames it to the name in the box, and **Delete** removes it. Loading a preset takes effect right away and is saved, so there is no separate Save step. Presets are saved to your Lumiverse account the same way your settings are, so they follow you to other browsers and devices. A copy is kept in the browser too, which is what puts the list on screen straight away. To share a preset with someone else, use **Advanced: import / export**, which can include your presets in the file.

---

[Back to the README](../README.md)
