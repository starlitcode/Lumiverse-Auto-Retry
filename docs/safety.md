# Safety

Auto Retry throws replies away and asks for new ones. Nearly always that is a small convenience. There are two places where it is more than that, and I would rather write them down here than let you run into them on your own.

## Who I built this for

Adults, writing their own fiction, on an app made for adults.

The extension cannot see what your scene is about. Every check in it is asking one question, which is whether a reply failed as writing: it came back empty, it stopped mid-sentence, it broke character to turn you down. There is no filter, nothing scoring you, and no network call anywhere in the code. The only thing it ever looks at is the text of a reply, and it drops that as soon as it has decided.

So it does not know you, and it cannot. The next part depends on that being true, which is why I have said it first.

## The switch that stops the model offering help

Under Refusal tuning there is a setting called **Also catch it stopping to offer support**. It is off. Ticking it opens a warning you have to answer, and it is the only setting in the whole panel that stops to ask.

Here is the reply it catches. The scene ends. The model starts talking to you rather than to your character: what you have written is concerning, you are not alone, please talk to someone, and here are some numbers. If you are writing something painful and your character is the one in trouble, that reply has usually read your fiction as a report about your life, and it arrives at the worst possible moment in the scene.

I cannot tell those two situations apart from out here, and neither can the extension. It reads the reply and that is all it has. Someone who is not writing fiction gets the same message in the same words, and there is nothing in the text that separates them.

So switching it on is a decision made in advance, before you know which reply it will land on: that you would rather have the scene. That is yours to make. What I care about is that you are the one making it, rather than a default you never saw.

The detection is narrow. Two signals have to agree, at least one of them from the phrasings a model uses once it has stopped addressing your character, and nothing inside quotation marks is counted, so a character comforting another character is safe. [When it retries](detection.md#stopping-to-offer-support) has the mechanics. It still gets it wrong in both directions sometimes.

## What retrying is really doing

Auto Retry asks for a new reply until one passes its checks. It holds no view about any of them. Pointed at a reply that got cut off, it rescues your scene. Pointed at a reply that told you something you did not want to hear, it will keep asking until one tells you something else.

I want to be straight with you about what you are holding at the end of that. The twentieth reply is the same model as the first, run again with a different seed. The nineteen you threw away came from the same place as the one you kept. Going round that many times can feel like the answer is being confirmed, and I think the work involved is exactly why it feels that way, but nothing was added along the way.

People have been badly hurt after long conversations in which a model kept agreeing with them. I bring it up because it is the reason the setting above is off and asks before it goes on: that setting takes away the one kind of reply that would have pushed back.

If this is not how you use the extension, then it isn't, and there is nothing here to act on.

## Turning it off

None of this asks you why.

- **The master switch**, under Basics, stops every retry, and word swaps with it.
- **Turn off here** switches it off in one chat and leaves every other chat alone.
- **Reset**, at the bottom of the settings panel, puts everything back to how it shipped. Tick every part, tick **Delete saved word swap presets** underneath, and nothing you set up survives. The presets go immediately; the settings are filled in behind the box and kept when you press **Save**. [All settings](settings.md#resetting) covers it properly.
- **Uninstalling** removes the extension. Your chats, characters and messages belong to Lumiverse, and none of this touches them.

Two small things live in your browser rather than in your settings, and a reset does not reach them: where you left the panel on screen, and the list of chats you switched it off in. Clearing this site's storage clears those. [Privacy](privacy.md) lists everything it writes down, everywhere.

There is no streak here, nothing that nags, and I get nothing from you keeping it installed. If it is making things worse for you, take it off. I built it easy to remove on purpose.

## Whatever it sounds like, there is nobody there

The model writes well. That is the thing it is genuinely good at, and I am not being sniffy about it.

It has no memory of you between chats, nothing at stake in what becomes of you, and no view that survives from one reply to the next. When it wrote something kind, it produced text that fitted the shape of the conversation in front of it. When it wrote something cruel, the same. Neither was a judgement about you, because there was no one there to make one.

That is easy to forget at three in the morning, when something is replying to you as though it understands.

If you have kept a reply because it agreed with the worst thing you believe about yourself, I would ask you to hold it a bit more loosely than that. It came out of the same process as the ones you discarded and would have written the opposite just as readily. Nothing becomes true because you found a version of it that said so.

Writing something down is also not the same as wanting it. Fiction is where a great many people put what they cannot say anywhere else, and that is one of the oldest and best things it is for.

I cannot do anything from here. This page is the one part of the extension where I get to write to a person instead of to a settings panel, so, plainly: I hope you are alright. If you are not, I hope the one you tell is not a language model.

---

[Back to the README](../README.md)
