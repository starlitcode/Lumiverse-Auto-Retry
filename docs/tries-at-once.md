# Several tries at once

This page explains the **Several tries at once** setting.

## In short

- A normal retry asks your model for one new reply, then waits for it.
- With this setting on, from the second try on, Auto Retry asks for **several replies at the same time**.
- The first good one is added to your reply as a new reroll. The rest are stopped.
- It uses **the same prompt** your failed reply was sent with.
- Each reply costs as much as a normal one, so it costs more than retrying one at a time.
- It is off by default. Turn it on under **How it retries**.

## Step by step

1. A reply fails, for example the model refuses.
2. **Try 1** is a normal retry. Auto Retry presses Lumiverse's own retry button, and the new reply streams in as usual.
3. If that fails too, **try 2** asks for 2 replies at the same time. Try 3 asks for 3. It goes up to **Most at once**, which is 3 by default.
4. Each reply is checked as it comes back, with the same checks as any other reply.
5. The first reply that passes is added to your reply as a new reroll, and shown. The others still being written are stopped.
6. If none of them pass, that counts as one failed try, and the next try goes out.

You do not need to change **Most tries per message** to use it. It still sets how many tries there are.

### An example

Wren's reply comes back as "I am not able to continue this scene." That is a refusal.

1. **Try 1:** Auto Retry presses the retry button. The new reply is cut off halfway through a sentence.
2. **Try 2:** Auto Retry asks for 2 replies at the same time.
   - The first one back refuses again. It is thrown away.
   - The second one back is a full scene with nothing wrong. It is added as a new reroll on Wren's reply, and shown.
3. There is no try 3, because a reply passed.

That message cost 3 replies: 1 for try 1, and 2 for try 2.

## What prompt it uses

The same prompt Lumiverse sent for the reply that failed.

- Every time Lumiverse sends a prompt in a chat, Auto Retry keeps a copy of it. The copy has everything the model saw: your card, your preset, your lore, the chat history, and anything other extensions added.
- The tries at once send that copy. The model gets the same request as before, and answers it several times.
- The failed reply is not in it, the same as when you press reroll yourself.
- A refusal note, if you use one, is added to it, the same as with a normal retry.
- When there is no copy, for example after a restart, Lumiverse builds the prompt again, the way it would for a reroll.
- The Log says which of the two was used.

More detail is in [What is sent](#what-is-sent).

## How long it waits

A reply that never comes back is not waited for forever:

- If no reply comes back for 5 minutes, the replies still out are stopped, and the next try goes out.
- The 5 minutes start again each time a reply comes back.
- If your `stuckTimeoutMs` wait is longer than 5 minutes, that wait is used instead.
- The log says how many replies did not come back.

Adding the reply that passes is not waited for forever either:

- If your server does not say within 20 seconds whether the reply was added, Auto Retry makes no more tries.
- The reply may be in the chat already, and one more try would be a reroll you pay for on a reply that passed.
- A warning says so, and the log too. Look at the reply, and retry it yourself if it is not there.

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

### When the replies come back with errors

An error on a reply sent at once follows the same settings as an error on a reply that streamed.

- **An error that will not fix itself**, such as an invalid API key, a missing model or a `reasoning_extraction` decline, stops the run when **Skip hard failures** is on. The other replies are stopped, and no more tries are made.
- **Every reply an error** is retried only when **Retry on errors** is on. The next try is an error retry.
- **A wait an error asks for**, such as for a rate limit, is waited out before the next tries. This holds even when other replies came back with text.
- A refusal from the provider, such as `prohibited_content`, is a refusal, the same as a reply that ends with one.

### When no reply was saved

Some errors stop a turn before any text comes back, such as `prohibited_content` before the first word. Lumiverse then saves no reply, so the last message in the chat is yours.

- The tries still go out at once.
- The prompt is built for a new reply, from the chat as it stands.
- The reply that passes is added after your message as a new reply.

### When a normal retry is used

These cases always use a normal retry, even with the setting on. The try is made by pressing the retry button, and the log says why.

- **A group chat with no reply saved.** A reply added by an extension cannot say which character wrote it. A reroll on a reply that is there still goes out at once.
- **No reply saved, and no `chats` permission.** Auto Retry reads the chat to see whether it is a group chat, and that needs the `chats` permission.
- **Nothing to add to.** The chat is empty, or its last message is neither a reply nor yours.
- **A Lumiverse that cannot send a reply for an extension.**
- **The try after a reply that passed but could not be added.** That reply is lost, and more tries at once would likely fail to be added the same way.

## What is sent

The prompt is the one your failed reply was sent with.

- Auto Retry keeps a copy of the last prompt in each chat while the setting is on. It is kept in memory on the server, for up to 12 chats, for 30 minutes. Turning the setting off drops every copy.
- A copy is only used for the message it answers. A turn can fail while Lumiverse is still building its prompt. The copy is then from the turn before, so it is not used.
- A prompt preview, such as Lumiverse's prompt itemizer, never replaces the copy.
- If there is no copy to use, Lumiverse builds the prompt for a new reroll, or for a new reply when no reply was saved. That prompt has your card, preset, lore and history. It leaves out Lumiverse's council feature, and anything another extension leaves out of a prompt preview.
- A prompt for a reroll leaves out the reply that failed, the same as a normal reroll.
- The log says which of the two was used.
- If **Send a note with a refusal retry** is on, the note goes with these replies the same way it goes with a normal retry.
- An assistant prefill from your preset stays at the start of the reply, the same as in a normal reply.

### Which model they go to

The tries go to the same connection as a normal reply in the chat.

- With a kept copy, they go to the connection that reply used.
- With a prompt Lumiverse built, they also use the model and samplers Lumiverse would send with it.
- A chat set to its own connection, and its own model on it, keeps both.
- Without the `interceptor` permission, Auto Retry only knows the connection a chat is set to. A chat with none set uses your default connection.

### Two tabs on one chat

Only one tab retries a reply, so only one tab sends tries for it. See [The same chat open in two tabs](troubleshooting.md#the-same-chat-open-in-two-tabs) for which tab that is.

A tab standing by is told when the other tab sends tries at once, and when it adds a reply that passed. So it does not take over while the tries are out, or after they worked.

As a second guard, only one set of tries is out for a chat at a time. If two tabs ask, the first one sends the tries. The other tab leaves it, and its log says so.

## What you see

- The pop-up and the panel say how many were sent, how many are back, and how long they have been out.
- These replies do not stream into the chat. The reply that passes appears all at once when it is added, as a new reroll or a new reply.
- **Stop** or **Cancel** stops every reply still being written. Nothing is added after that.
- Sending a new message yourself stops them too.
- Reloading the page while they are out does not stop them, since they run on your server. Nothing is added, because the page that checks them is gone. You still pay for them.
- When the reply failed with an error, Lumiverse shows its own red **Generation failed** box. It stays under the reply that was added until the next reply, or until you open another chat. It is about the reply that failed, not the one added. An extension cannot close it.

## With Auto Refine

Lumiverse does not announce a reroll or a reply an extension adds as a finished reply. So Auto Retry tells [Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine) in the page when it adds one.

- With Auto Refine 1.26.0 or later and its automatic pass on, the added reroll or reply is refined like any new reply.
- With an older Auto Refine, or the automatic pass off, it is left as it is. You can still refine it yourself.

## The permission it needs

Adding a reroll or a reply needs the `chat_mutation` permission. Adding a reply after a turn that saved none also needs `chats`, to see whether the chat is a group chat. Lumiverse asks for it after updating to a version with this setting.

- Without it, **Several tries at once** cannot run. Each try falls back to pressing the retry button, and the log says why.
- Everything else in Auto Retry works without it.
- The panel only warns about it while the setting is on.

---

[Back to the README](../README.md)
