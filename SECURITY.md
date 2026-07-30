# Security

Extensions run inside the app, so it is fair to want to know what one can reach before you install it. This page explains what Auto Retry touches and why, and points at the parts of the code you can read to check any of it.

## It works entirely on your own device

Auto Retry has no networking in it at all. It never opens a connection, never contacts a server of mine or anyone else's, and has no analytics. Everything it does happens inside your copy of Lumiverse, using events the app already gives it. If you would rather confirm that than take my word for it, searching the two source files for `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource` turns up nothing, and those are the only ways a browser extension can send anything out.

It also never treats text as code. There is no `eval` and no `new Function` anywhere, so nothing in a reply, a character card, or your own settings can be run. Word swaps come closest to acting on what you typed, and they are plain text replacements: your rules are escaped before they are matched, so a rule cannot turn into a regular expression by accident, let alone anything worse.

## What it can reach, and why it needs to

It asks Lumiverse for two permissions. `chat_mutation` is the one that matters: it lets the extension read the text of a reply, which is how it decides whether that reply failed, and rewrite a reply, which is how the word-swap feature saves a change. That is a privileged permission and worth thinking twice about, which is why word swaps are off by default and marked beta. `generation` is declared so the extension can follow the generation lifecycle, the events that tell it a reply started, streamed, or ended.

Behind those it uses four Lumiverse APIs and nothing else: reading the messages in a chat, updating a message, and reading and writing its own settings. Everything the extension does is built out of those four.

## What it has no way to reach

Your API keys, passwords, and account details are not available to it. Lumiverse does not hand those to extensions, and there is no code in Auto Retry that goes looking, which you can confirm by searching the source for `apikey`, `secret` or `credential` and finding nothing.

It reads a reply only to run its checks on the one that just arrived, and it does not keep a copy. The streamed text it holds while a reply is in flight is thrown away the moment that reply finishes.

## What it keeps

Your settings and your word-swap presets are saved twice over: once in your browser's local storage, and once in Lumiverse's own per-user storage so they follow your account between devices. That is the only thing written anywhere.

Separately it keeps the last twenty lines of what it did, in memory only, so the Copy debug info button has something to report. That list dies with the tab. It is never written to disk and never leaves your device.

## One thing to be careful with

The Copy debug info button gathers your settings, your button selectors, your browser string, and that recent activity log. The activity log records what the extension saw, so it can contain short fragments of a reply. Read what you copied before pasting it somewhere public, and untick any section you would rather keep to yourself. The tick boxes are there for exactly that.

## If you find a problem

Open an issue at [github.com/starlitcode/Lumiverse-Auto-Retry/issues](https://github.com/starlitcode/Lumiverse-Auto-Retry/issues), or message me directly on Discord as `.moonsight.` in the Lumiverse server. Discord is the better route if it is something you would rather not describe in public, since an issue is visible to everyone.

I maintain this on my own in my spare time, so I cannot promise a fix by any particular date, but I will read what you send.

## Reading it yourself

The files Lumiverse actually loads are `dist/frontend.js` and `dist/backend.js`, and they are committed to the repo as readable code. They are not minified, obfuscated, or bundled, so what you read is what runs. They mirror the TypeScript in `src/` with the type annotations removed, which is why the extension installs without a build step.

---

[Back to the README](README.md)
