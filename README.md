# Auto Retry

A Spindle extension for Lumiverse. It quietly re-runs an AI reply when it fails, comes back empty, stalls partway, gets cut off mid-sentence, or refuses by mistake, so you don't have to catch it and hit regenerate yourself. The idea came from [SillyTavern's fetch-retry](https://github.com/Hikarushmz/fetch-retry), but this is written from scratch and shares no code with it.

## What it does

It watches each reply and re-fires when:

- the reply comes back as a provider error (but skips permanent hard failures like invalid API keys by default)
- the reply comes back empty, including one that "thinks" but never writes anything
- the reply is cut off mid-sentence (see [Cut-off detection](docs/detection.md#cut-off-detection))
- the reply is an accidental out-of-character refusal, or the model breaks off mid-scene
  (see [Accidental-refusal detection](docs/detection.md#accidental-refusal-detection))
- the stream stalls mid-reply, tokens stop arriving for a while
- a reply never starts or never finishes
- (optional, off by default) the reply is very short
- (optional, off by default) the model leaves the scene to offer real-world support
  (see [Stopping to offer support](docs/detection.md#stopping-to-offer-support), and [Safety](docs/safety.md) before switching it on)

Every retry waits a little longer than the last so it never hammers the server, and waits extra when the server says it is busy. All of the triggers share one retry limit, so no reply is ever retried more than you allow, and nothing can loop forever.

It can also, optionally, run a find-and-replace on replies: swap words you don't like for ones you prefer, saved into the reply. See [Find and replace in replies](docs/word-swaps.md). This is off by default and is the only feature that edits a reply. A swap cannot be undone, so it is worth reading that page before switching it on.

## Install

In Lumiverse, open Extensions and install from the repository URL:

```
https://github.com/starlitcode/Lumiverse-Auto-Retry
```

Then open the chat input bar, tap the **Extras** popover, and choose **Auto Retry settings**. It works with no setup; everything below is optional.

## You are always in charge

Pressing your **Stop** button, or tapping **Cancel** on the retry pop-up, stops the extension right away. It drops any pending retry, resets the count, and a stopped reply cannot restart itself. The Cancel button on the pop-up is the extension's own, so it works no matter what.

To switch it off for one chat, or everywhere, see [Turning it off](docs/settings.md#turning-it-off-in-one-chat).

## Documentation

- [When it retries](docs/detection.md) - cut-off detection and accidental-refusal detection
- [All settings](docs/settings.md) - every option with its default, the panel, and turning it off
- [Word swaps](docs/word-swaps.md) - find and replace in finished replies, and presets
- [Buttons it clicks](docs/buttons.md) - fixing the regenerate button, Regeneration Feedback, writing selectors
- [The on-screen panel](docs/settings.md#the-on-screen-panel) - the log, the prompt viewer and the stats
- [Import and export](docs/import-export.md) - moving your setup between devices
- [Reporting a bug](docs/troubleshooting.md)
- [Safety](docs/safety.md) - who this is built for, the one setting that asks before it turns on, and what the retry loop can turn into
- [Privacy](docs/privacy.md) - what the extension can and can't reach, what it keeps, and how to check any of it
- [Security policy](SECURITY.md) - how to report a security problem
- [Changelog](CHANGELOG.md) - what changed in every version

## How it works

Auto Retry listens to Lumiverse's own generation events. When a reply fails, comes back empty, stalls, or looks cut off or refused, it clicks your regenerate button to try again. That button click is the only part that depends on the page layout, so it is the one thing you may have to fix yourself if a Lumiverse update ever moves those buttons, which [Buttons it clicks](docs/buttons.md) covers.

Find and replace works separately, since editing a saved reply is a backend job. A small backend module watches for finished replies and, when swaps are on, edits the saved message through Lumiverse's Chat Mutation API. That edit is treated as an edit rather than a new reply, so it cannot set itself off in a loop.

It makes no external network calls. [Privacy](docs/privacy.md) has the detail, including the six permissions it declares, what still works without each of them, and why `chats` and `characters` grant more than the extension uses.

Auditing it, or pointing a scanner at it? The two files Lumiverse loads are `dist/frontend.js` and `dist/backend.js`, named in `spindle.json`. They are committed as plain readable JavaScript, not minified or bundled. Everything else in the repo is for working on it, and [Privacy](docs/privacy.md#checking-any-of-this-yourself) goes through it file by file.

## Credits

- **starlitcode** - built and maintains the extension
- **[Claude](https://claude.ai)** (Anthropic) - wrote the code, directed and tested by starlitcode
- **[Hikarushmz](https://github.com/Hikarushmz/fetch-retry)** - their SillyTavern fetch-retry gave me the idea. Auto Retry is written from scratch and shares no code with it
- Everyone who has reported a bug or suggested something that turned into a fix

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
