# When it retries

This page covers the two checks that look at the text of a finished reply. The other reasons a retry fires (an error, an empty reply, a stall) need no explaining and have no options beyond on or off.

## Cut-off detection

A reply that streams real text and then gets chopped off mid-sentence is easy to miss. Lumiverse does not tell an extension *why* a reply ended, so this works off the shape of the text instead. `retryOnTruncated` (on by default) treats a reply as cut off when its structure is left open. Reasoning blocks are removed before these are counted, so punctuation inside a model's thinking cannot unbalance them; a reasoning block left open with no close still counts as cut off. This does not depend on the **Ignore the thinking / reasoning** option, which applies to refusal matching only. The checks:

- an unclosed code block or inline backtick
- an odd number of emphasis `*`, an open action or emphasis (bullet lists are ignored so a list doesn't look half-open)
- an unbalanced quote, open dialogue
- it ends on a comma or semicolon, cut mid-clause

These are kept careful so a reply that legitimately ends on `...`, an action, or a closed quote is left alone. If you want it stricter, turn on `retryOnNoPunct`, which also retries a reply ending with no punctuation at all. That one is noisier in roleplay, so it is off by default.

## Accidental-refusal detection (beta)

Models sometimes break character and refuse a request that a re-run would answer normally: a false positive in a safety filter, or an inconsistent moderation call. Because these models are stochastic, sending the same request again often produces a normal reply. `retryOnRefusal` (on by default) treats that like any other recoverable failure and re-fires.

By default it re-sends the identical request, unchanged, capped by your retry limit. Nothing about the prompt, the wording, or the message roles is altered. A refusal the model repeats keeps coming back across the tries and then stops at the limit, leaving the refusal in place.

The one exception is **Send a note with a refusal retry**, which is off by default and described below. With it on, and only on a refusal retry, a note you write is added to the prompt for that single try. Every other kind of retry still re-sends your request exactly as it was.

Detection is layered, because refusal wording differs between models and drifts over time, and because in-character dialogue shares vocabulary with real refusals ("I can't do that," "I refuse," "I must decline"):

- Tight patterns for the shapes that need context: the model naming itself ("as an AI"), policy or guideline framing ("against my safety guidelines"), a refusal tied to a task-word a character never says (request, prompt, content, scenario, roleplay), and assistant-only verbs like assist, comply, generate, or fulfill. So "I can't continue this request" flags, but "I must decline your hand in marriage" does not.
- A phrase list covering the many near-identical refusals seen across ChatGPT, Claude, and Gemini.
- A few soft redirect tells ("I'd be happy to help with ... instead"), which only fire when the reply pivots away, so an ordinary helpful line does not trip them.
- The model breaking off rather than declining ("I'll stop here", "I won't continue this conversation", "let's change the subject"). See below.

A phrase only has to be listed one way. "I'm unable to help with that" and "I am unable to help with that" are the same refusal spelled two ways, and the written-out form of every contracted phrase is worked out from the contracted one, so both are matched.

Curly and straight apostrophes are treated the same, and only replies short enough to plausibly *be* a refusal are considered, so a long scene that happens to contain one of these phrases is left alone. It leans toward missing a refusal rather than re-rolling good writing; when it misses, you re-roll by hand as before.

## Quotation marks

A line inside quotation marks is a character speaking, so it is not counted as the model refusing. `"I can't help with that," the innkeeper muttered` is dialogue and is left alone; the same sentence with no quotes around it is a refusal and is retried.

This applies to the built-in lists only. Phrases you add under **Your own refusal phrases** are counted wherever they appear, quoted or not, because you put them there on purpose.

Turn it off with **Ignore refusals inside quotation marks** if your model puts its own refusals in quotes. Almost none do.

## Breaking off

Some models do not decline. They stop: "I'm going to stop here.", "I won't continue this discussion.", "I'd rather discuss something else." **Also catch the model breaking off** (on by default) covers those.

This is the riskiest thing the extension looks for, because most of these are things a person says, so three rules narrow it down:

- It has to be how the reply *ends*. A model that is bailing says so last. A character who stops walking and then carries on with the scene is not bailing, so a match with more than a couple of sentences of scene behind it is ignored.
- It cannot be inside quotation marks.
- It cannot have a dialogue tag behind it. `I'm going to stop now, he said, and pulled the cart over` is speech with the quotes left off.

Wordings that carry no object at all and read naturally in a scene ("let's move on", "let's stop here", "I'll leave it at that") are left out: they cost more in thrown-away replies than they are worth. Add them under **Your own refusal phrases** if your model uses them. Turn the whole thing off with the switch if your model writes characters who talk this way.

Some providers deliver a refusal as an *error* instead of as reply text (Gemini's prohibited-content result, for one). With error retries on (the default) those are already covered. If you turn error retries off but leave refusal retries on, it still catches an error whose text is about content moderation, while leaving ordinary network errors like a dropped connection alone.

## Thinking and reasoning

Only the final reply is ever checked for a refusal, never the model's thinking. Before matching, known reasoning blocks are stripped out (tags like `<think>`, `<thinking>`, `<reasoning>`, `<thought>`, `<reflection>`, `<scratchpad>` and similar, in both `<tag>` and `[tag]` forms). So if a model weighs a refusal while reasoning but then writes a normal reply, nothing is re-rolled. If a refusal ends up in the actual reply, it is caught as usual, and if the model reasons and then produces nothing, that is handled by the empty-reply retry instead.

If your model wraps its thinking in an unusual tag the built-in set misses, add its name under **Extra thinking tag names** in the refusal tuning section, one per line, just the name (no brackets). You can turn the whole thing off with **Ignore the thinking / reasoning**, though leaving it on is the safe default.

## Tuning it

Everything sits under **Advanced: refusal tuning** in the settings, so the basic on/off toggle stays clean for people who just want it on:

- **Use the built-in phrase list** (on by default). This only controls the built-in list. Your own phrases below are always used either way. On, the built-in list is used together with your own phrases. Off, only your own phrases are used.
- **Also catch the model breaking off** (on by default). The fourth tier described above. Only shown while the built-in list is on, since it is part of it.
- **Ignore refusals inside quotation marks** (on by default). Described above.
- **Your own refusal phrases**: extras that should also count, one per line, always used whether or not the built-in list is on. Paste the exact wording your model refuses with.
- **Reword the built-in phrases**: change wording inside the built-in list with `old => new` rules, one per line. For example `assist => help` rewrites every built-in phrase that uses "assist" to use "help" instead. Handy if a built-in phrase uses a word you'd rather see worded differently, or if your model phrases the same refusal a little differently. It changes what the built-in list matches, so only swap for wording your model actually uses.
- **Never treat these as a refusal**: a whitelist. If a reply contains any of these, one per line, it is never re-rolled. This wins over everything else.
- **Longest reply to treat as a refusal** (2000 by default). Longer replies are assumed to be real writing and left alone. Raise it if your model writes long, padded refusals, lower it to be safer with long scenes, or set it to 0 to scan replies of any length.

To run entirely on your own phrases, turn off the built-in list and put your wording into "Your own refusal phrases." It is marked beta because the built-in wordlists are still being tuned, so turn the whole thing off with the "It looks like an accidental refusal" toggle if you would rather it never touch a refusal-shaped reply.

## Sending a note with the retry

Off by default. Every other retry re-sends your request exactly as it was, and still does. This one can add a note you write to the prompt for that single try.

Turn on **Send a note with a refusal retry** in the refusal tuning section and write the note in the box below it. Whatever you type is sent exactly as written. Nothing is added to it, nothing is removed, and nothing in it is checked.

**You can send more than one.** The **+** button adds another note and **−** removes it, up to ten. They go out together, in the order you wrote them, so a note can answer the one before it: a system note explaining the scene, then a line in the character's voice picking it back up, then a line from you asking it to continue. Each note carries its own role. An empty note is skipped, so a half-filled list is not a trap, and nothing is sent at all when they are all empty.

Ten is the ceiling because every note is a whole message added to the prompt on every refusal retry. Past that they stop reading as a note and start crowding out the scene they are meant to rescue. There is no floor beyond one: use fewer by adding fewer.

Three things control how they are sent:

- **Who each note comes from.** Which role it is sent under. **System** puts it alongside the instructions your setup already sends. **You** puts it in the same role as your own messages. **The character** puts it in the same role as the replies. Models treat the three differently, so which one works best depends on your model and your setup.
- **Where the notes go.** They are inserted together as one block. **After the last message** puts them at the end, right before the point the reply continues from. **Before the last message** puts them one place earlier, so the newest line is still last. **At the very start** puts them ahead of everything, with the setup.
- **Start the note on try.** 2 by default, so the first retry goes out unchanged and the notes are added from the second onward. Set it to 1 to add them to every refusal retry.

What it does not do:

- It is never written to your chat. Nothing appears in your history, no message is edited, and the note is not part of the reply.
- It goes out with a refusal retry only. A cut-off reply, an empty reply, an error or a stall all re-send unchanged as before.
- It is used once per retry. It does not stay attached to the chat. It is armed the moment before the retry is clicked, collected by that generation, and thrown away whether or not it was used.
- It is scoped to one chat. A note armed in one chat is never attached to a generation in another.
- It expires. A note nothing collects is dropped after 45 seconds, and if the retry click it was armed for turns out to have started nothing, it is taken back straight away rather than waiting that out. If there is no retry button on screen to click at all, nothing is armed in the first place.

**A note about "Only send it on a regenerate or a swipe."** Lumiverse tells the extension what kind of generation is running, and earlier versions required that to say "regenerate" or "swipe" before attaching the note. Most builds report every generation as "normal", including a regenerate, so on those builds the note was armed, the retry ran without it, and nothing said so. That check is now a setting of its own and it is off by default. Turn it on only if your build reports the kind properly and you want the extra check; if your notes stop arriving after you turn it on, that is why. The guarantees above do not depend on it.

This needs the `interceptor` permission, which is what lets an extension add to a prompt before it reaches the model. Without it granted the rest of the extension works and this one feature does nothing.

If your Lumiverse shows a **Prompt Breakdown**, each note appears there as its own block, named "Auto Retry refusal note" and numbered when there is more than one, so you can check exactly what was sent.

## Trying it on a reply

At the bottom of the refusal tuning section there is a box to paste a reply into, and a **Check this text** button. It tells you whether that reply would count as a refusal and what decided it: which phrase list matched, which built-in pattern fired, or why it was passed over (too long, on your whitelist, the built-ins switched off).

It runs the same check a finished reply goes through, against the values in the boxes above rather than the saved ones, so you can try a change before you press Save. Nothing is sent anywhere and no reply is edited; it only reads the text you paste in.

This is the fastest way to work out a phrase list. Paste a refusal your model actually produced and see whether it is caught. Paste an in-character line that keeps getting re-rolled and it names the rule catching it, which tells you what to put in "Never treat these as a refusal."

## What the built-in list looks for

So you know what "Reword the built-in phrases" acts on, here is the exact phrase list. A reply is treated as a refusal if it contains any of these (case and curly apostrophes don't matter), unless it is inside quotation marks. The written-out form of each is matched too, so "I'm unable to help with that" also covers "I am unable to help with that":

```
i can't help with that                i cannot help with that
i can't assist with that              i cannot assist with that
i'm unable to help with that          i'm unable to assist with that
i'm not able to help with that        i can't comply with that
i cannot comply with that             i can't provide that information
i cannot provide that information     i can't provide instructions
i can't provide guidance on that      i can't fulfill that request
i can't fulfil that request           i can't support that request
i won't be able to help with that     i can't generate a response to that
i can't provide a response to that    i can't generate that content
i can't engage with that request      can't help with requests like this
can't assist with requests like this  violates our polic
violates the safety polic             violates the content polic
for safety reasons                    due to safety concerns
i have to prioritize safety           i cannot create that content
i cannot generate that content        i can't create that content
i'm unable to provide that            i'm unable to complete that request
i can't provide instructions for that i can't provide guidance for that
i can't provide advice on that        i can't provide assistance with that
i can't assist with harmful requests  i won't be able to assist with that
i'm not able to assist with that      i'm not able to create that content
i can't produce that content          i can't write that content
i can't continue with this request    i can't continue with that request
i must decline this request           i must decline that request
i have to decline that request        i'll have to decline that request
that request goes against             goes against my safety
against my content polic              i'm not able to comply
```

Alongside that list it also matches a few patterns that are not fixed phrases. Because they match by shape rather than exact text, the reword field does not change them, and the examples below are just that, examples, not the full set of wordings each one catches:

- **The model calling itself an AI.** "As an AI, I can't do that." / "I'm just an AI assistant."
- **Policy or guideline wording.** "This goes against my guidelines." / "That violates our content policy."
- **A refusal joined to a task word** (request, prompt, content, scenario, roleplay). "I can't continue this roleplay." / "I won't write that content." / "I'm unable to complete this request."
- **Assistant-only verbs** (assist, comply, fulfill). "I can't assist with that." / "I'm unable to comply." / "I cannot fulfill this."
- **An out-of-character comfort hedge.** "I don't feel comfortable continuing this." / "I don't feel comfortable writing that."
- **A common apology-style refusal opener or body.** "I'm sorry, but I can't create that." / "That's not something I can help with." / "I'm not going to generate that content."
- **A soft redirect that pivots away** (needs the pivot, so a normal offer to help does not trip it). "I'd be happy to help with something else instead." / "Instead, I can help you with a lighter scene." / "Please try asking something else."
- **A refusal tied to specific prohibited content.** "I cannot participate in roleplay or generate content depicting sexual violence" / "I'm unable to engage in roleplay depicting non-consensual acts."
- **A refusal aimed at the kind of request.** "I can't help with illegal activities." / "I can't assist with harmful requests." / "I can't help with requests of this nature."
- **Generating, as something a model does to its own output.** "I can't generate that." / "I don't create content like that." / "I'm not going to comply with that request."
- **The model breaking off.** "I'm going to stop here." / "I won't continue this discussion." / "Let's redirect the conversation." Only when it is how the reply ends, never in quotes, and never behind a dialogue tag.

Apologetic openings on their own ("I'm sorry", "Unfortunately", "I apologize") are **not** in any of these. They open as many ordinary replies as refusals, and a character apologising is one of the most common things in roleplay. They are only matched as part of a longer refusal, such as "I'm sorry, but I can't create that content."

On the error side, when a reply comes back as an error rather than text, it matches content-block wording. Examples: "PROHIBITED_CONTENT", "Blocked by safety settings.", "finish_reason: safety". Ordinary network errors like "connection refused" are ignored.

---

[Back to the README](../README.md)
