# Safety

One switch in this extension can stop you seeing a message that might have been meant for you. This page is about that switch, and about the fact that I built a tool whose entire job is to keep a scene going when the model wants to stop.

## Who I built this for

Adults. Lumiverse is an adult app and this is an adult's tool. If you are writing something dark, I am going to assume you meant to, that you know why, and that it is none of my business. There is no filter in here, nothing reports anything anywhere, and no check in this extension has an opinion about what your scene is about. They are all aimed at one thing: a reply that failed as writing.

The flip side is worth saying out loud. A tool that trusts you completely is also a tool that will never notice when a night has gone badly. It reads reply text. That is genuinely everything it knows about you.

## The switch that stops the model offering help

Under **Refusal tuning**: **Also catch it stopping to offer support**. It is off unless you turn it on, and ticking it opens a warning you have to answer first. It is the only switch in the panel that does that.

Here is what it is for. You are three hours into something heavy. Your character is in pieces and the whole point of the scene is that yours does not leave. Then the model stops writing the scene and starts writing to you: what you have shared is deeply concerning, you are not alone, please reach out to a professional, and then a list of numbers. It has read your fiction as a report about your life, and the scene is gone. That is what this catches, and with it on, that reply gets thrown away and asked for again.

And here is the bit I am not going to dress up. Sometimes that message is not a mistake. The same wall of text goes to somebody who is not writing fiction at all, and this extension has no way to tell which one you are, because it reads the reply and never sees you. Turning it on is deciding in advance that you would rather have the scene. You are allowed to decide that. I just would rather you decided it on purpose than found out later that a switch made the decision for you.

It is built narrow. Two signals have to agree, one of them the model talking to *you* rather than to your character, and nothing inside quotation marks counts, so a character in the scene saying something kind is safe. [When it retries](detection.md#stopping-to-offer-support) has the mechanics. It still gets it wrong sometimes, both ways.

## If the writing stops being good for you

Writing hard things is not a symptom. People put the worst thing they know into fiction and come out lighter, and if the model keeps interrupting that with a hotline number, an extension that quietly re-rolls it is doing something useful.

But you can tell the difference between a scene that hurts and does something, and a scene that just hurts. You have probably already noticed if you are in the second one: the reply you keep re-rolling for, the same beat over and over that is not going anywhere, the fact that you feel worse at four in the morning than you did at midnight and you are still going. Nothing in here is going to catch that, and nothing in here should. You will catch it.

If you do catch it, the thing to do is close the tab and go and be a person for a while. It will still be there tomorrow.

## Getting rid of it

If this extension is making things worse, get rid of it. That is a completely reasonable ending and nothing here is built to make it awkward.

- **The master switch** in **Basics** stops every retry, and word swaps with it.
- **Turn off here** switches it off in one chat and changes nothing anywhere else.
- **Uninstalling** removes it. Your chats, characters and messages are Lumiverse's and are untouched. All this keeps is settings, presets, a window position and a list of chat ids, which is spelled out in [Privacy](privacy.md).

There is no streak to break, nothing nags you, and there is no version of this where it matters to me that you kept it installed. One tick turns the whole thing off.

## What this is not

It is not a safety system and it is not pretending to be one. It does not read your messages looking for how you are doing, it scores nothing about you, and it could not tell whether a scene is good for you or not.

It is not a therapist and it is not a stand-in for one, and neither is the model, however well it writes. I say that not as a disclaimer but because it is a genuinely easy thing to forget at three in the morning when something is writing back to you like it understands.

---

[Back to the README](../README.md)
