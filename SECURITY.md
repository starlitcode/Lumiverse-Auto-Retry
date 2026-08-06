# Security

Extensions run inside the app, so it is fair to want to know what one can reach before you install it. This page explains what Auto Retry touches and why, and points at the parts of the code you can read to check any of it.

## It works entirely on your own device

Auto Retry has no networking in it at all. It never opens a connection, never contacts a server of mine or anyone else's, and has no analytics. Everything it does happens inside your copy of Lumiverse, using events the app already gives it. If you would rather confirm that than take my word for it, searching the two source files for `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource` turns up nothing, and those are the only ways a browser extension can send anything out.

It also never treats text as code. There is no `eval` and no `new Function` anywhere, so nothing in a reply, a character card, or your own settings can be run. Word swaps come closest to acting on what you typed, and they are plain text replacements: your rules are escaped before they are matched, so a rule cannot turn into a regular expression by accident, let alone anything worse.

## What it can reach, and why it needs to

It asks Lumiverse for four permissions. `chat_mutation` is the one that matters: it lets the extension read the text of a reply, which is how it decides whether that reply failed, and rewrite a reply, which is how the word-swap feature saves a change. That is a privileged permission and worth thinking twice about, which is why word swaps are off by default and marked beta. `generation` is declared so the extension can follow the generation lifecycle, the events that tell it a reply started, streamed, or ended. `ui_panels` is what Lumiverse requires before an extension may put a floating widget on screen, and it is used for the optional on/off button and nothing else. It grants screen space, not access to your data. `interceptor` lets an extension add to a prompt on its way to the model, and it is used by one feature, "Send a note with a refusal retry", which is off by default.

That note is the only thing in the extension that changes what the model is asked, so it is worth being precise about. It carries the text you typed and nothing else: your prompt is not read, nothing is copied out of it, and nothing is stored. Nothing is written to your chat. Because it is never a message in your chat, it will not necessarily appear in Prompt Breakdown, which lists what your chat is built from; the extension labels it for that panel, but whether it shows depends on your Lumiverse build. To see for yourself what went out and when, turn on the on-screen log, which writes a line naming the note on the retry that carried it.

It is put in place the moment before the extension clicks your retry button, and four things keep it to that one generation. It belongs to the chat it was put in place for and is never attached to a generation in another. It is used once and cleared, whether it was used or not. It expires after 45 seconds. And when the retry click it was armed for turns out to have started nothing, it is taken straight back rather than left waiting; if there is no retry button on screen to click at all, nothing is armed in the first place. Lumiverse also reports what kind of generation is running, and you can require that to say "regenerate" or "swipe" as a fifth check, under **Only send it on a regenerate or a swipe**. It is off by default because most builds report every generation as "normal", including a regenerate, so leaving it on stopped the note from ever being sent.

Behind those it uses five Lumiverse APIs and nothing else: reading the messages in a chat, updating a message, reading and writing its own settings, and registering the interceptor above. Everything the extension does is built out of those five.

## What it has no way to reach

Your API keys, passwords, and account details are not available to it. Lumiverse does not hand those to extensions, and there is no code in Auto Retry that goes looking, which you can confirm by searching the source for `apikey`, `secret` or `credential` and finding nothing.

It reads a reply only to run its checks on the one that just arrived, and it does not keep a copy. The streamed text it holds while a reply is in flight is thrown away the moment that reply finishes.

## What it keeps

Your settings and your word-swap presets are saved twice over: once in your browser's local storage, and once in Lumiverse's own per-user storage so they follow your account between devices. That is the only thing written anywhere.

Separately it keeps the last twenty lines of what it did, and a few counters for the session: replies that came back fine, retries fired, and what they fired for. That is all in memory, so the Copy debug info button has something to report. Both die with the tab. Neither is written to disk and neither leaves your device.

The on-screen panel's **Prompt** tab is the one part that holds more than that, and only while you are looking at it. Opening that tab asks the extension to keep a copy of the prompt on its way to the model, which is the text of your chat, so that it can show it to you. Switch to the Log tab, close the panel, or close the browser tab and nothing is kept at all. It is never written to disk and never leaves your device, and only one prompt is held at a time: each generation replaces the last. This is why there is no separate switch to leave on and forget about.

## One thing to be careful with

The Copy debug info button gathers your settings, your button selectors, your browser string, the session counters, and that recent activity log. The activity log records what the extension saw, so it can contain short fragments of a reply. Read what you copied before pasting it somewhere public, and untick any section you would rather keep to yourself. The tick boxes are there for exactly that.

The **Copy** button on the on-screen panel is the same thing in miniature: on the Log tab it puts that whole activity log on your clipboard in one tap, fragments included, and on the Prompt tab it copies the entire prompt, which is most of your chat. It is there because selecting text by hand on a phone is awkward, and the same advice applies before you paste either anywhere.

The refusal tester in the settings panel only reads the text you paste into it. It runs the check on your device and reports the verdict; it sends nothing and stores nothing.

## If you find a problem

Open an issue at [github.com/starlitcode/Lumiverse-Auto-Retry/issues](https://github.com/starlitcode/Lumiverse-Auto-Retry/issues), or message me directly on Discord as `.moonsight.` in the Lumiverse server. Discord is the better route if it is something you would rather not describe in public, since an issue is visible to everyone.

I maintain this on my own in my spare time, so I cannot promise a fix by any particular date, but I will read what you send.

## Reading it yourself

The files Lumiverse actually loads are `dist/frontend.js` and `dist/backend.js`, and they are committed to the repo as readable code. They are not minified, obfuscated, or bundled, so what you read is what runs. They mirror the TypeScript in `src/` with the type annotations removed, which is why the extension installs without a build step.

---

[Back to the README](README.md)
