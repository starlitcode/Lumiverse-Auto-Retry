# Fixing the regenerate button

Lumiverse has no built-in way for an extension to regenerate a reply, so the re-fire clicks your own on-screen regenerate or swipe button. The defaults match common Lumiverse builds, but a future update could rename those buttons.

There are three button fields: **regenerate** (redo a reply), **next / swipe** (a backup if your build retries by swiping), and **stop** (to halt a frozen reply). Each takes one CSS selector, the kind you'd pass to `document.querySelector`, and you can list several separated by commas as fallbacks. The extension checks these in the exact order you write them, so put your most specific selectors first (like data attributes) and broader ones last (like aria-label or title).

By default a retry uses the regenerate button, which on some builds redoes the reply in place and clears the other rerolls on that message. If you'd rather keep those rerolls, turn on **Retry by adding a new reroll** (under "How it redoes a reply" in settings). A retry then clicks the next / swipe button, which adds a new reroll and leaves the existing ones in place.

Whichever button the toggle prefers, the other one is the fallback, and the choice is made at the moment of the click from what is on screen and actually clickable. A button that is present but disabled or hidden is skipped rather than clicked, since clicking one of those does nothing and would burn a retry. This applies to every reason a retry fires, including empty replies and errors, so the toggle does what it says on all of them. Set the **next / swipe** selector below if retries stop happening after you turn it on.

## Setting the buttons without writing a selector

Each button setting has a **Pick it for me** button next to **Test**. Press it and the settings panel steps aside; click the real button in Lumiverse and the selector is filled in for you. The click is swallowed, so picking your stop or regenerate button doesn't also press it. Press Cancel on the prompt to back out, or Esc if you're on a keyboard.

It builds the selector from what is most likely to survive an app update, preferring `aria-label`, `title` and `data-` attributes over class names. Lumiverse rebuilds its class names on every release, so a selector based on one stops matching the next time the app updates. Those are skipped. If the element it lands on has nothing dependable, it says so rather than saving something that will break; clicking the button itself rather than an icon inside it usually fixes that.

If a click lands but no reply starts, which happens when a next / swipe button moves between rerolls that already exist rather than making a new one, it clicks the other button once before giving that attempt up.

## Regeneration Feedback

Lumiverse has a **Regeneration Feedback** option. With it on, pressing regenerate opens a box asking for guidance to send with the next attempt. The reply only starts once you press a button in that box, so Auto Retry has to handle it.

When a retry opens the box, Auto Retry presses **Skip**, which regenerates without guidance. The box is hidden for the moment that takes, so you shouldn't see it. It still has to open, because Auto Retry presses the real button.

Some limits worth knowing:

- A box **you** opened is left alone. Auto Retry only acts in the moment right after its own click, so a regenerate you pressed still opens the box and waits for you to type.
- If you tap anything, or press stop, while it's about to skip, it stops and leaves the box alone.
- It presses Skip, so a draft you saved in the box is never sent. It never presses **Cancel**.
- If it can't close the box, it shows it again straight away. A hidden box can still be tapped through, so it can't lock up the app.

You don't need to change either setting. Keep Regeneration Feedback on if you use it; it still opens every time you press regenerate yourself.

## Extra dialog buttons it may press

Only needed if the Regeneration Feedback box stays on screen when a retry opens it, which means Auto Retry didn't recognise its button. It already knows `Skip`, `Regenerate`, `Confirm`, `Proceed`, `Submit` and `OK`. If yours says something else, for example in another language, add that wording here.

Type the button's text exactly as it appears, one per line. **Expand** opens a bigger editor if the box is too small:

```
Überspringen
Doorgaan
```

Capitals are ignored. Anything you add is tried before the built-in list, so you can also use it to change which button Auto Retry prefers.

Auto Retry only presses buttons inside a box that opened right after a retry. Putting `Continue` here won't make it press the Continue button on your toolbar.

## Writing selectors by hand

Each box takes one CSS selector, or several separated by commas as fallbacks. They're tried left to right, so put the most specific first (`data-action`, `data-testid`) and the broader ones last (`aria-label`, `title`). The first entry that finds a button you can actually click is the one used, so an entry matching only a hidden or disabled button is passed over for the next.

A comma inside brackets, parentheses or quotes stays part of the selector rather than splitting the list, so `:is(a, b)` and `[aria-label="Next, swipe"]` each count as one entry.

**Reset button selectors** at the bottom of that section puts all three back to the defaults without touching any other setting. It fills the boxes, so press Save to keep it.

If retries fire (the pop-up shows) but nothing regenerates, the selector needs adjusting:

1. Open developer tools (F12) with an AI message visible so its buttons are on screen.
2. Right-click the regenerate button and choose Inspect.
3. Find a stable attribute on it (a data attribute, aria-label, title, or class) and write a selector that matches it.
4. Paste it into the Regenerate selector field and hit **Test** with an AI message on screen. Save when it says it matches.

A "no match" doesn't always mean the selector is wrong. A button only exists while it's showing, so a correct selector still won't match if that button isn't on screen when you test. The **Stop** button is the clearest case: it only appears while a reply is generating, so test that one mid-reply.

---

[Back to the README](../README.md)
