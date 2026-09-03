# Reporting a bug

Two things here: a snapshot you can paste into a bug report, and a panel for watching the extension work while it happens.

## Debug info

If the extension seems to do nothing at all, check the top of the settings panel first. A permission that was never granted is the one fault that raises no error anywhere: the events the extension listens for simply never arrive, so it sits there looking installed and working. When one is missing, the panel says which and what it costs, and the debug report lists all of them. If you turned one off on purpose, each note has an × that hides it until you reload the page. Nothing is written down, so a reload brings them back, and so does granting a permission and then losing it again. The debug report lists every permission either way.

**Debug info** in the settings panel is the main tool. Tick the parts you want, press **Build preview**, then edit the text to take out anything private before you copy it. What you get is a short plain-text snapshot, no developer tools needed, and nothing leaves your device until you paste it somewhere.

The parts are **Your settings**, **Buttons and selectors**, **Permissions, browser and screen**, and **Session totals and recent activity**. Each name covers everything in that part, so leaving one out never drops something you did not know was in it. Your permissions ride with the browser part, and the selectors you wrote ride with whether they match.

The settings it reports come straight from the option list, so every setting is always in it. There is no second list to fall out of date and quietly leave something out.

**Session totals** count how many replies came back fine, how many retries fired, how many messages it gave up on, and a breakdown of retries by cause since the page loaded. Those answer the question a bug report usually cannot: "it retries too much" becomes "ninety retries, all of them for a cut-off reply".

Under that is the **activity timeline**, the last twenty things it did, kept whether or not console logging is on.

## It retried a reply you wanted to keep

Open the on-screen panel and go to the **Replaced** tab. The reply it threw away is there, with what it was thrown away for. Press **Copy** to take it back.

That covers the one reply. To stop it happening again, the reason on that tab is what to act on, because each one has its own switch under **When to count a reply as bad**:

- **cut off** or **stalled**: turn off **It cut off mid-sentence**. That one switch covers both, since a reply that stops partway with text already in it is a cut-off reply whichever way it stopped.
- **short**: turn off **It was very short**, or lower **What counts as "very short"**.
- **refusal**, **breaking off** or **crisis**: the [refusal tuning](detection.md) page covers narrowing these. Adding the wording it caught to **Never treat these as a refusal** is usually the quickest fix.
- **empty**, **cut off mid-reasoning** or **thinking only, no reply**: turn off **It came back blank**, which governs all three. Worth checking your model is not being cut short by a token limit first.

The Stats tab shows the same reasons as a tally, so if this keeps happening it says which check is responsible over a whole session rather than one reply.

## It called a reply stuck after you came back to the tab

Everything the extension knows about a generation arrives over Lumiverse's socket. A tab in the background can miss those events outright, and they are not held and handed over later, they are gone. So the extension went on waiting for a first word that had already come and gone, and **Give up waiting for it to start** ran out on a reply sitting in the chat finished.

Two things stop that now, and neither needs setting.

Before either wait acts, it looks at the page. The reply on screen when the generation started is remembered, and if what is on screen has changed, words arrived, whatever reached the tab. It stands down and writes a line saying so. It is not counted as a reply that came back fine, because it was never checked: nothing about it reached the tab to check.

A wait is also not judged over time the page spent asleep. A background tab has its timers held back, and one the browser freezes runs nothing at all and then delivers everything at once when you come back, so a wait coming due then is measuring the time you were away. Coming back starts the wait again from that moment, and the panel says why.

A generation that really produced nothing is still re-rolled either way.

## "No chat is open"

Anything that acts on the chat you are in has to know which chat that is, and the Extras menu and the floating button are both reachable from the chat list with nothing open. Asked there, they say **No chat is open** rather than acting on the chat you were last in.

How it knows is worth saying, because one of the two answers is not as good as it looks. Lumiverse can be asked which chat is open, but that question is answered on the server, and what comes back is the most recent chat on your account rather than the page in front of you. On the home screen it names the chat you just left. What actually tells the two apart is the address in your browser: while you are in a chat, the address carries that chat's id, and when it stops carrying it you are somewhere else. Auto Retry checks that a few times a second while it is holding a chat, and stops as soon as it is not.

If your Lumiverse uses addresses that do not carry the chat id, that signal is not there and nothing tries to guess. The extension then falls back to the last chat it saw you in, which is what it has always done when it cannot look.

The **Turn off here** row works from the same answer. Outside a chat it is greyed out and reads **No chat is open**, rather than going on naming the chat you left.

## When Lumiverse does not say which chat you are in

Rarely, Lumiverse reports a reply without saying which chat it belongs to. Retrying still works, and three things that need a chat by name do not:

- **Turn off here** is greyed out, with a note saying it is waiting to find out which chat this is. Sending a message, or switching to another chat and back, is usually enough. Use the main **Auto Retry** switch in the meantime.
- **The retry note is not added.** The note is held for one named chat and collected when the next reply is built, so with no chat to attach it to it could land on a reply somewhere else. The retry still happens, and the log says why the note was left out.
- **Anything named for the chat you are in** says **No chat is open**, since there is nothing for it to name.

In the Stats tab, any retries from this state are counted together on a row called **Chats without an id**.

## The on-screen panel

For watching it work live, turn on **Show the on-screen panel** under Basics, and pick where it goes with the row underneath: floating over the chat, or in Lumiverse's sidebar drawer. It is useful on a phone, where the browser console is out of reach.

Three tabs:

- **Log** updates as generations run and retries fire.
- **Prompt** shows the whole prompt that went to the model, with your refusal notes marked where they were inserted. This is the quickest way to answer "did my note go, and where". It needs the `interceptor` permission, and it tells you so if it is empty after a reply.
- **Stats** shows what it has been doing and what it keeps retrying for, and says when it has paused itself after repeated failures.

Drag the panel by its header and resize it from the bottom corner. **Copy** and **Clear** act on whichever tab you are looking at. The toggle is the only thing controlling it, so turning that off makes it disappear.

---

[Back to the README](../README.md)
