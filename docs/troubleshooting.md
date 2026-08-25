# Reporting a bug

Two things here: a snapshot you can paste into a bug report, and a panel for watching the extension work while it happens.

## Debug info

If the extension seems to do nothing at all, check the top of the settings panel first. A permission that was never granted is the one fault that raises no error anywhere: the events the extension listens for simply never arrive, so it sits there looking installed and working. When one is missing, the panel says which and what it costs, and the debug report lists all of them. If you turned one off on purpose, each note has an × that hides it until you reload the page. Nothing is written down, so a reload brings them back, and so does granting a permission and then losing it again. The debug report lists every permission either way.

**Debug info** in the settings panel is the main tool. Tick the parts you want, press **Build preview**, then edit the text to take out anything private before you copy it. What you get is a short plain-text snapshot, no developer tools needed, and nothing leaves your device until you paste it somewhere.

The parts are your settings, button match status, browser and screen, and session totals with the recent activity.

The settings it reports come straight from the option list, so every setting is always in it. There is no second list to fall out of date and quietly leave something out.

**Session totals** count how many replies came back fine, how many retries fired, how many messages it gave up on, and a breakdown of retries by cause since the page loaded. Those answer the question a bug report usually cannot: "it retries too much" becomes "ninety retries, all of them for a cut-off reply".

Under that is the **activity timeline**, the last twenty things it did, kept whether or not console logging is on.

## "No answer from the word swapper"

You get this after pressing **Swap words in the last reply** or **Swap words in every reply**, when nothing answers within a few seconds. The swap runs in the extension's backend, so this means the backend is not running, or the message never reached it.

Reload the page and try again. If it keeps happening, the backend part of the extension is not loading, which is worth reporting. Everything else in Auto Retry works without it: only the word swaps need it.

A long chat is not the cause. The backend says it has the request as soon as it gets it, before it starts any work, so a swap that simply takes a while never shows this message.

## "No chat is open"

The swap buttons live in the Extras menu or the floating button's menu, and both are reachable from the chat list with nothing open. Pressing one there says **No chat is open. Open a chat and try again.** It asks Lumiverse which chat you are in first, so with the `chats` permission granted it knows the difference between the home screen and a chat, and will not edit the chat you were last in by mistake.

Without that permission it cannot ask, and falls back to the last chat it saw you in. That is the one case where a swap from the home screen still lands somewhere, and it is the same fallback the rest of the extension runs on when it is not allowed to look.

## Temporary chats

Retrying works in a temporary chat the same way it works anywhere else. An empty reply, a cut-off reply, a refusal, or an error gets retried, the try limit applies as usual, and pressing Stop calls it off.

Three things work differently there, because a temporary chat is thrown away when you go home and on some versions of Lumiverse it has no id for the extension to refer to:

- **Turn off here** is greyed out. There is no id to remember the exclusion against, and one that stopped applying the moment the chat was discarded would be worse than none. Use the main **Auto Retry** switch to turn it off while you are testing.
- **The retry note is not added.** The note is held for one named chat and collected when the next reply is built. With no chat to attach it to, it could land on a reply in a different chat, so it is left out. The retry itself still happens, and the log says so.
- **Swapping words by hand** says **No chat is open**, since those buttons edit saved replies and there is nothing for them to name. Swaps that run automatically on each reply are unaffected.

In the Stats tab, retries from these chats are counted together on a row called **Chats without an id**.

## The on-screen panel

For watching it work live, turn on **Show the on-screen panel** under Basics, and pick where it goes with the row underneath: floating over the chat, or in Lumiverse's sidebar drawer. It is useful on a phone, where the browser console is out of reach.

Three tabs:

- **Log** updates as generations run and retries fire.
- **Prompt** shows the whole prompt that went to the model, with your refusal notes marked where they were inserted. This is the quickest way to answer "did my note go, and where". It needs the `interceptor` permission, and it tells you so if it is empty after a reply.
- **Stats** shows what it has been doing and what it keeps retrying for, and says when it has paused itself after repeated failures.

Drag the panel by its header and resize it from the bottom corner. **Copy** and **Clear** act on whichever tab you are looking at. The toggle is the only thing controlling it, so turning that off makes it disappear.

---

[Back to the README](../README.md)
