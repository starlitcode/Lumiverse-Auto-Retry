# Several tries at once

This page explains the **Several tries at once** setting: what it does, what it costs, and when it is used.

It is off by default. Turn it on under **How it retries**. You do not need to change **Most tries per message** to use it.

## What it does

A normal retry presses Lumiverse's own retry button. Lumiverse writes one reply at a time in a chat, so each try waits for the one before it.

With **Several tries at once** on, the second try and every try after it work differently:

1. Auto Retry sends the same prompt to your model several times at the same moment.
2. Each reply is checked with the same rules as any other reply.
3. The first reply that passes is added to the failed reply as a new reroll, and shown. If the failed turn saved no reply, it is added after your message as a new reply. See [When no reply was saved](#when-no-reply-was-saved).
4. The other replies still being written are stopped.
5. If none of them pass, that counts as one failed try. The next try is set up as usual.

A reply that never comes back is not waited for forever:

- If no reply comes back for 5 minutes, the replies still out are stopped, and the next try goes out.
- The 5 minutes start again each time a reply comes back.
- If your `stuckTimeoutMs` wait is longer than 5 minutes, that wait is used instead.
- The log says how many replies did not come back.

The first try is always a normal retry, because it can stream into the chat and it uses everything Lumiverse adds to a prompt.

## How many at once

The try number decides how many are sent, up to **Most at once**:

| Try | Sent at once, with **Most at once** at 3 |
| --- | --- |
| 1 | 1, a normal retry |
| 2 | 2 |
| 3 | 3 |
| 4 | 3 |

**Most at once** can be set from 2 to 5.

**Most tries per message** still decides how many tries there are. It counts tries, not replies.

- Several at once starts from the second try, so **Most tries per message** has to be 2 or more for it to do anything.
- At the default of 4, tries 2, 3 and 4 are sent at once.

## What it costs

Every reply sent at once is a whole reply, and your provider charges for each one.

- With the defaults, 4 tries and 3 at once, a message that fails every try costs up to 9 replies: 1 + 2 + 3 + 3.
- The same message with this setting off costs 4.
- The replies that are stopped early may still be charged in part. That depends on your provider.

It suits a model that refuses or cuts off often, where waiting for one try after another takes a long time.

## When it is used

Every reason for a retry uses it: a reply that failed a check, a refusal, an error from the provider, and a reply that froze or never started.

- A wait the provider asks for, such as for a rate limit, is waited out first. Then the tries go out at once.
- Every reply sent at once to a provider in trouble can fail the same way, and each one may still be charged. If your provider is often busy, a lower **Most at once** costs less.

### When no reply was saved

Some errors stop a turn before any text comes back, such as `prohibited_content` before the first word. Lumiverse then saves no reply, so the last message in the chat is yours.

- The tries still go out at once.
- The prompt is built for a new reply, from the chat as it stands.
- The reply that passes is added after your message as a new reply.

### When a normal retry is used

These cases always use a normal retry, even with the setting on. The try is made by pressing the retry button, and the log says why.

- **A group chat with no reply saved.** A reply added by an extension cannot say which character wrote it. A reroll on a reply that is there still goes out at once.
- **Nothing to add to.** The chat is empty, or its last message is neither a reply nor yours.

## What is sent

The prompt is the one your failed reply was sent with.

- Auto Retry keeps a copy of the last prompt in each chat while the setting is on. It is kept in memory on the server, for up to 12 chats, for 30 minutes. Turning the setting off drops every copy.
- If there is no copy, Lumiverse builds the prompt for a new reroll, or for a new reply when no reply was saved. That prompt has your card, preset, lore and history, but it leaves out anything another extension adds to the prompt as it is sent, and Lumiverse's council feature.
- The log says which of the two was used.
- If **Send a note with a refusal retry** is on, the note goes with these replies the same way it goes with a normal retry.

## What you see

- The pop-up and the panel say how many were sent, how many are back, and how long they have been out.
- These replies do not stream into the chat. The reply that passes appears all at once when it is added, as a new reroll or a new reply.
- **Stop** or **Cancel** stops every reply still being written. Nothing is added after that.
- Sending a new message yourself stops them too.

## With Auto Refine

Lumiverse does not announce a reroll or a reply an extension adds as a finished reply. So Auto Retry tells [Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine) in the page when it adds one.

- With Auto Refine 1.26.0 or later and its automatic pass on, the added reroll or reply is refined like any new reply.
- With an older Auto Refine, or the automatic pass off, it is left as it is. You can still refine it yourself.

## The permission it needs

Adding a reroll or a reply needs the `chat_mutation` permission. Lumiverse asks for it after updating to a version with this setting.

- Without it, **Several tries at once** cannot run. Each try falls back to pressing the retry button, and the log says why.
- Everything else in Auto Retry works without it.
- The panel only warns about it while the setting is on.

---

[Back to the README](../README.md)
