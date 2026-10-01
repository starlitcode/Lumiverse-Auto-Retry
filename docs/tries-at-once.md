# Several tries at once

This page explains the **Several tries at once** setting: what it does, what it costs, and when it is used.

It is off by default. Turn it on under **How it retries**.

## What it does

A normal retry presses Lumiverse's own retry button. Lumiverse writes one reply at a time in a chat, so each try waits for the one before it.

With **Several tries at once** on, the second try and every try after it work differently:

1. Auto Retry sends the same prompt to your model several times at the same moment.
2. Each reply is checked with the same rules as any other reply.
3. The first reply that passes is added to the failed reply as a new reroll, and shown.
4. The other replies still being written are stopped.
5. If none of them pass, that counts as one failed try. The next try is set up as usual.

The first try is always a normal retry, because it can stream into the chat and it uses everything Lumiverse adds to a prompt.

## How many at once

The try number decides how many are sent, up to **Most at once**:

| Try | Sent at once, with **Most at once** at 3 |
| --- | --- |
| 1 | 1, a normal retry |
| 2 | 2 |
| 3 | 3 |
| 4 | 3 |

**Most at once** can be set from 2 to 5. **Most tries per message** still counts tries, not replies.

## What it costs

Every reply sent at once is a whole reply, and your provider charges for each one.

- With the defaults, 4 tries and 3 at once, a message that fails every try costs up to 9 replies: 1 + 2 + 3 + 3.
- The same message with this setting off costs 4.
- The replies that are stopped early may still be charged in part. That depends on your provider.

It suits a model that refuses or cuts off often, where waiting for one try after another takes a long time.

## When it is not used

These cases always use a normal retry, even with the setting on:

- **An error from the provider, or a rate limit.** A provider in trouble gets more trouble from several calls at once.
- **A reply that froze or never started.**
- **A provider that blocked the request before anything was written.**
- **No reply to add a reroll to.** If the last message in the chat is not a reply, the try is made by pressing the retry button instead. The log says why.

## What is sent

The prompt is the one your failed reply was sent with.

- Auto Retry keeps a copy of the last prompt in each chat while the setting is on. It is kept in memory on the server, for up to 12 chats, for 30 minutes. Turning the setting off drops every copy.
- If there is no copy, Lumiverse builds the prompt for a new reroll. That prompt has your card, preset, lore and history, but it leaves out anything another extension adds to the prompt as it is sent, and Lumiverse's council feature.
- The log says which of the two was used.
- If **Send a note with a refusal retry** is on, the note goes with these replies the same way it goes with a normal retry.

## What you see

- The pop-up and the panel say how many were sent, how many are back, and how long they have been out.
- These replies do not stream into the chat. The reply that passes appears all at once when it is added.
- **Stop** or **Cancel** stops every reply still being written. Nothing is added after that.
- Sending a new message yourself stops them too.

## With Auto Refine

Lumiverse does not announce a reroll an extension adds as a finished reply. So Auto Retry tells [Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine) in the page when it adds one.

- With Auto Refine 1.26.0 or later and its automatic pass on, the added reroll is refined like any new reply.
- With an older Auto Refine, or the automatic pass off, the reroll is left as it is. You can still refine it yourself.

## Most tries per message

**Several tries at once** works inside **Most tries per message**. It does not replace it.

- The first try is always a normal retry. Several at once starts from the second try.
- So **Most tries per message** has to be 2 or more for it to do anything. At the default of 4, tries 2, 3 and 4 are sent at once.

## The permission it needs

Adding a reroll needs the `chat_mutation` permission. Lumiverse asks for it after updating to a version with this setting.

- Without it, **Several tries at once** cannot run. Each try falls back to pressing the retry button, and the log says why.
- Everything else in Auto Retry works without it.
- The panel only warns about it while the setting is on.

---

[Back to the README](../README.md)
