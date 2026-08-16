# Reporting a bug

Two things here: a snapshot you can paste into a bug report, and a panel for watching the extension work while it happens.

## Debug info

**Debug info** in the settings panel is the main tool. Tick the parts you want, press **Build preview**, then edit the text to take out anything private before you copy it. What you get is a short plain-text snapshot, no developer tools needed, and nothing leaves your device until you paste it somewhere.

The parts are your settings, button match status, browser and screen, and session totals with the recent activity.

The settings it reports come straight from the option list, so every setting is always in it. There is no second list to fall out of date and quietly leave something out.

**Session totals** count how many replies came back fine, how many retries fired, how many messages it gave up on, and a breakdown of retries by cause since the page loaded. Those answer the question a bug report usually cannot: "it retries too much" becomes "ninety retries, all of them for a cut-off reply".

Under that is the **activity timeline**, the last twenty things it did, kept whether or not console logging is on.

## The on-screen panel

For watching it work live, turn on **Show the on-screen panel** under Basics, and pick where it goes with the row underneath: floating over the chat, or in Lumiverse's sidebar drawer. It is useful on a phone, where the browser console is out of reach.

Three tabs:

- **Log** updates as generations run and retries fire.
- **Prompt** shows the whole prompt that went to the model, with your refusal notes marked where they were inserted. This is the quickest way to answer "did my note go, and where".
- **Stats** shows what it has been doing and what it keeps retrying for, and says when it has paused itself after repeated failures.

Drag the panel by its header and resize it from the bottom corner. **Copy** and **Clear** act on whichever tab you are looking at. The toggle is the only thing controlling it, so turning that off makes it disappear.

---

[Back to the README](../README.md)
