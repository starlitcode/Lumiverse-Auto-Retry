# Reporting a bug

This page covers the debug report you can paste into a bug report, the on-screen panel for watching the extension work, and some common questions.

## If it seems to do nothing

Check the top of the settings panel first. A permission that was never granted causes no error: the events the extension listens for never arrive, so it looks installed and working.

- When a permission is missing, the panel says which one and what it stops.
- If you refused one on purpose, press the × on its note to hide it until you reload.
- The debug report always lists every permission.

## Debug info

**Debug info**, in the settings panel, builds a short plain-text report. Adding it to a bug report is optional, but it helps show exactly what went wrong.

1. Tick the parts you want.
2. Press **Build preview**.
3. Edit the text to take out anything private.
4. Copy it.

Nothing leaves your device until you paste it somewhere.

- **The first two lines** are always included. They name the version of the panel and the version of the backend. These only differ if you updated without reloading the tab.
- **The parts** are **Your settings**, **Buttons and selectors**, **Permissions, browser and screen**, and **Session totals and recent activity**. Each covers everything in that part.
- **Your settings** lists every setting you changed, by its name in the panel and in the code, with its default beside it. A default that is empty says "empty". Every other setting is at its default for your version.
- **Session totals** count replies that came back fine, retries, messages it gave up on, and retries by reason, since the page loaded. So "it retries too much" becomes "ninety retries, all for a cut-off reply".
- **The activity timeline** is the last forty things it did, in your own time, and says which kind of line each one is.
- **Several tries at once, last run** shows up when the setting is on. It says how many tries were sent, which prompt and connection they used, and how the run ended.
- **Lumiverse's version** is near the top, when your Lumiverse says what it is.
- **Secure page** says whether the page is on `https` or opened on the same device that Lumiverse runs on, such as a phone running Lumiverse itself. Some browser features only work on a secure page. It never shows the address or the port.
- **The time** at the top is your own time, with your time zone.

## It retried a reply you wanted to keep

Open the on-screen panel and go to the **Replaced** tab. The reply it threw away is there, with the reason. Press **Copy** to take it back.

To stop it happening again, look at the reason. Each has its own switch under **When to count a reply as bad**:

- **cut off** or **stalled**: turn off **It cut off mid-sentence**. It covers both.
- **one character over and over**: turn off **It was one character over and over**. It only fires when one character is most of the reply.
- **thinking was one character over and over**: turn off **Its thinking was one character over and over**. The reply may have looked fine, and it is kept on the **Replaced** tab.
- **garbled**: turn off **It was garbled**. It only fires on many broken words or characters, or a long switch to another alphabet that runs to the end.
- **thinking was garbled** or **thinking got stuck repeating**: turn off **Its thinking was garbled** or **Its thinking got stuck repeating**. The reply may have looked fine, and it is kept on the **Replaced** tab.
- **leaked the prompt's format**: turn off **It leaked the prompt's format**. It only fires on markers no story uses, such as `[/INST]`, outside code.
- **stuck repeating or rambling**: turn off **It got stuck repeating or rambling**. It only fires when the repeats or the run-on reach the end of the reply.
- **short**: turn off **It was very short**, or lower **What counts as "very short"**.
- **refusal**, **breaking off** or **crisis**: see [When it retries](detection.md). Adding the wording it caught to **Never treat these as a refusal** is usually the quickest fix.
- **empty**, **cut off mid-reasoning** or **thinking only, no reply**: turn off **It came back blank**, which covers all three. First check your model is not being cut short by a token limit.

The **Stats** tab counts the reasons over the whole session, so you can see which check keeps firing.

**Impersonate is never retried.** It writes your own turn into the input box. Lumiverse says what kind of generation is starting, and Auto Retry reads that. So an impersonation started with a shortcut, or in another tab, is left alone too. On a Lumiverse that does not say, Auto Retry notices the press on Lumiverse's **Impersonate** button instead, and an impersonation started another way is judged like a reply.

## It called a reply stuck after you came back to the tab

A tab in the background can miss Lumiverse's events completely. So the extension could wait for a first word that had already arrived. Two things prevent a wrong retry here, and neither needs setting:

- **It checks the page before acting.** If the reply on screen has changed since the generation started, words arrived, so it does not retry. It writes a line saying so. Another extension's own chat, and anything another extension puts inside a reply, such as a card, are not counted.
- **Time the tab spent asleep does not count.** A background tab's timers are held back or frozen. When you come back, the wait starts again from that moment, and the panel says why.

A generation that really produced nothing is still retried.

## The same chat open in two tabs

This covers two browser tabs, and also a phone and a computer.

- Lumiverse names one tab on each reply. It is the tab opened or reloaded last.
- That tab retries the reply. The countdown and the pop-up show in that tab, even when you sent the message from the other one.
- The other tab stands by. Its Log says "another tab retries this reply".
- If no retry has started 20 seconds after the usual wait, the other tab retries instead. This covers a named tab that the browser has paused, such as on a phone with its screen off.
- **Cancel** on the pop-up, or switching Auto Retry off, stops retrying in every tab. **Stop** on a reply does too.
- When a paused tab runs again, it calls off any retry it had waiting, once it sees that the other tab has retried the reply or given up on it.
- On a Lumiverse that names no tab, every tab retries, as before.

## "No chat is open"

The Extras menu and the floating button can be reached from the chat list, with no chat open. There they say **No chat is open** instead of acting on the chat you were last in.

How it knows which chat you are in:

- Lumiverse can be asked which chat is open, but it answers with your account's most recent chat, not the page you are looking at. On the home screen, that is the chat you just left.
- So Auto Retry also checks the address in your browser. While you are in a chat, the address contains its id. When it does not, you are somewhere else.
- If your Lumiverse's addresses do not contain the chat id, it falls back to the last chat it saw you in.

**Turn off here** follows the same answer. Outside a chat it is grayed out and says **No chat is open**.

## When Lumiverse does not say which chat you are in

Sometimes Lumiverse reports a reply without saying which chat it is in. Retrying still works, but three things that need the chat do not:

- **Turn off here** is grayed out, with a note that it is waiting to find out which chat this is. Sending a message, or switching chats and back, usually fixes it. Use the main **Auto Retry** switch meanwhile.
- **The retry note is not added.** A note belongs to one chat, and without a chat it could be added to a reply in another chat. The retry still happens, and the log says why the note was left out.
- **Anything that names the chat you are in** says **No chat is open**.

On the **Stats** tab, these retries are counted on a row called **Chats without an id**.

## The on-screen panel

Turn on **Show the on-screen panel** under Basics to watch it work live. The row under it chooses where it goes: floating over the chat, or in Lumiverse's sidebar drawer. It is useful on a phone, where there is no browser console.

It has four tabs:

- **Log** updates as replies arrive and retries happen.
- **Prompt** shows the whole prompt that went to the model, with your retry notes marked where they were added. It needs the `interceptor` permission, and says so if it is empty.
- **Stats** shows what it has been doing and what it keeps retrying for, and says when it has paused itself after repeated failures.
- **Replaced** shows the last reply a retry threw away in this chat.

Drag the panel by its header, and resize it from the bottom corner. **Copy** and **Clear** act on the tab you are looking at. Turning off **Show the on-screen panel** hides it. More about each tab is in [All settings](settings.md#the-on-screen-panel).

---

[Back to the README](../README.md)
