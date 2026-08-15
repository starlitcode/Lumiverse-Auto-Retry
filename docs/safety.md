# Safety

Auto Retry discards replies and requests new ones. That is a useful thing to automate. There are two situations in which it is not, and this page is about both of them.

## Who this is for

This extension assumes you are an adult writing your own fiction, on an application built for adults. Nothing in it inspects what your scene is about. Every check in it answers one question, which is whether a reply failed as writing: it came back empty, it stopped mid-sentence, it broke character to decline. There is no filter, no scoring of any kind, and no network call anywhere in the code.

What follows from that? It cannot know anything about you. Its entire input is the text of a reply.

## The switch that stops the model offering help

Under **Refusal tuning** there is a setting called **Also catch it stopping to offer support**. It is off by default. Ticking it opens a warning that has to be answered before it takes effect, and it is the only setting in the panel that behaves that way.

What it detects is a reply that stops writing the scene and addresses you directly about your safety: what you have shared is deeply concerning, you are not alone, please contact a professional, followed by a list of services. In a scene about something painful, where the character is the one in trouble, that reply usually means the model has read your fiction as a statement about your life. With the setting on, that reply is discarded and another is requested.

So how does the extension know which of those two situations you are in? It does not. It reads the reply, and it has no information about you at all. Someone who is not writing fiction receives the same message, in the same words, and nothing in the text of it distinguishes the two cases.

Turning the setting on is therefore a decision made in advance: that you would rather have the scene. That decision belongs to you. My only concern is that it should be made by you and not by a default you never saw.

The detection itself is narrow. Two signals have to agree, at least one of them from a set of phrasings the model uses when it is addressing the reader rather than the character, and no match inside quotation marks is counted, so a character comforting another character is unaffected. [When it retries](detection.md#stopping-to-offer-support) sets out the mechanics. It is still wrong sometimes, in both directions.

## What retrying actually does

Auto Retry requests a new reply until one passes its checks. It holds no view on the content of any reply. Applied to a reply that was cut off, it recovers the scene. Applied to a reply that said something you did not want to be told, it will go on requesting new ones until a reply says something else.

What does the twentieth reply establish that the first did not? Nothing. It is the same model, run again with a different random seed. The nineteen replies that were discarded came from the same source as the one that was kept, and a reply is not more accurate because it took more attempts to obtain. Repetition can feel like confirmation, and the effort involved is exactly why it feels that way, but no information was added by any of it.

This is not a hypothetical risk. People have been seriously harmed following long exchanges in which a model was pushed toward agreeing with them.

The setting above removes the one category of reply that would have disagreed. That is most of the reason it is off by default and asks before it takes effect.

If none of this describes how you use the extension, then it does not, and there is nothing here to act on. If it does, everything in the next section switches the extension off, and none of it asks you for a reason.

## Turning it off

- **The master switch**, under **Basics**, stops every retry, and word swaps with it.
- **Turn off here** switches it off in one chat and leaves every other chat as it was.
- **Reset**, at the bottom of the settings panel, puts every setting back to what it shipped with. Tick every part, tick **Delete saved word swap presets** underneath, and nothing you configured survives. The presets go immediately and permanently; the settings are filled in behind the box and kept when you press **Save**. [All settings](settings.md#resetting) covers it in full.
- **Uninstalling** removes the extension. Your chats, characters and messages belong to Lumiverse and are not touched by any of this.

Two small things live in your browser rather than in your settings, and a reset does not reach them: where you left the panel on screen, and the list of chats you switched it off in. Clearing this site's storage in your browser clears those. [Privacy](privacy.md) itemises everything it writes, everywhere.

There is no streak to maintain and nothing that nags. I gain nothing from your keeping it installed. If it is making things worse, remove it; that is a legitimate outcome and nothing here is built to make it difficult.

## What it is not

It is not a safety system. It does not read your messages to assess how you are, it does not score anything about you, and there is no mechanism in it by which it could tell whether a scene is doing you any good.

It is not a therapist, and neither is the model, however well it writes. That is not a legal disclaimer. It is worth stating because it is an easy thing to forget at three in the morning, when something is replying to you as though it understands.

## If you are using this for something other than the writing

I do not know what that would look like for you and I am not going to guess at it. What I can do is say some true things about the tool, because I built it and I know how little is behind it.

Nothing a model wrote about you is a finding. It has no memory of you between chats, nothing at stake in what happens to you, and no opinion that persists from one reply to the next. It produced text that fitted the shape of the conversation in front of it. That is the whole of what occurred, and it is equally true of the replies that were kind and the ones that were not.

If you kept a reply because it agreed with the worst thing you believe about yourself, that reply is not a second opinion. It came out of the same process as the nineteen you discarded. Nothing becomes true because you found a version of it that said so.

Writing something down is also not the same as wanting it. Fiction is where a great many people put what they cannot say anywhere else, and that is a legitimate use of it.

I cannot do anything from here. This page is the one part of the extension where I get to write to a person instead of to a settings panel, so, plainly: I hope you are alright. If you are not, I hope the person you tell is not a language model.

---

[Back to the README](../README.md)
