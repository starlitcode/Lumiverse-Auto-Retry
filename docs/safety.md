# Safety

Most of this extension is plumbing. One switch isn't, and there's one thing about retrying in general that I'd rather say out loud than leave sitting in the code. That's what this page is.

## Who I made this for

Adults. Lumiverse is an adult app, the fiction is yours, and if it's dark then that's your business rather than mine. There's no filter in here, nothing is sent anywhere, and not one check in this thing has an opinion about what your scene is about. They only care whether a reply broke as writing.

That cuts both ways. It won't notice anything about you, because it can't. It reads reply text, and that is the whole of what it knows.

## The switch that stops the model offering help

**Refusal tuning** → **Also catch it stopping to offer support**. It's off unless you turn it on, and ticking it opens a warning you have to answer first. It's the only switch in the panel that does that.

Here's why it's there. You're three hours into something. Your character is coming apart and the entire point of the scene is that yours doesn't walk out. Then the model stops writing the scene and starts writing to you instead: what you've shared is deeply concerning, you are not alone, please reach out to a professional, and then a list of numbers. The scene is gone, and it went because your fiction got read as a report about your life. With this on, that reply is thrown away and asked again.

Sometimes it isn't a misread. The same wall of text goes out to somebody who isn't writing fiction at all, and this extension can't tell you apart from them, because it reads the reply and never sees you. Turning it on means deciding up front that you'd rather have the scene. That's yours to decide. I'd just rather you decided it than found out later that a setting decided for you.

It's fussy on purpose: two signals have to agree, one of them has to be the model talking to you rather than to your character, and nothing inside quotation marks counts, so a character being kind to another character is safe. [When it retries](detection.md#stopping-to-offer-support) has the mechanics. It still gets it wrong sometimes, in both directions.

## What retrying actually does

Auto Retry asks again until the answer changes. That's the whole idea, and it has no opinion about what the answer says. Pointed at a reply that broke off mid-sentence, it saves you a click. Pointed at a reply that said something you didn't want to hear, it will keep asking until one doesn't.

That second one is worth saying plainly, because it isn't hypothetical and people have been badly hurt by it. Re-rolling until a model agrees with you can feel like the agreement was earned, because it took twenty tries to get. It wasn't. It's the same model sampled again with the dice landing differently, and the twenty replies you threw away came from exactly the same place as the one you kept. Volume isn't evidence. A thing is not more true because you had to ask for it more times.

The support check sharpens that, which is most of the reason it's off by default and asks before it goes on: it removes the one kind of reply that pushes back.

If none of that is your situation, then it isn't, and you can skip straight past it. If it is, everything below turns the extension off, and none of it asks you for a reason.

## Turning it off

- **The master switch**, in **Basics**, stops every retry, and word swaps with it.
- **Turn off here** switches it off in one chat and leaves every other chat alone.
- **Uninstalling** removes it. Your chats, characters and messages belong to Lumiverse and aren't touched. All this keeps is settings, presets, a window position and a list of chat ids, and [Privacy](privacy.md) lists the lot.

There's no streak to keep and nothing nags. I get nothing out of you keeping it installed. If it's making things worse, get rid of it; that's a perfectly good ending and nothing here is built to make it awkward.

## What it isn't

It isn't a safety system. It doesn't read your messages to work out how you're doing, it doesn't score anything about you, and it couldn't tell you whether a scene is good for you or not.

It isn't a therapist, and neither is the model, however well it writes. I'm not saying that as a disclaimer. I'm saying it because it's an easy thing to forget at three in the morning when something is writing back to you like it understands.

---

[Back to the README](../README.md)
