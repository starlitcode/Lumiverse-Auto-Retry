# Auto Retry (Lumiverse Spindle extension)

Auto Retry quietly re-runs an AI reply when it fails, comes back empty, stalls partway, gets cut off mid-sentence, or refuses by mistake, so you don't have to catch it and hit regenerate yourself. The idea came from [SillyTavern's fetch-retry](https://github.com/Hikarushmz/fetch-retry), but Auto Retry is written from scratch for Lumiverse and shares no code with it.

## What it does

It watches each reply and re-fires when:

- the reply comes back as a provider error (but skips permanent hard failures like invalid API keys by default)
- the reply comes back empty, including one that "thinks" but never writes anything
- the reply is cut off mid-sentence (see [Cut-off detection](docs/detection.md#cut-off-detection))
- the reply is an accidental out-of-character refusal (see [Accidental-refusal detection](docs/detection.md#accidental-refusal-detection-beta))
- the stream stalls mid-reply, tokens stop arriving for a while
- a reply never starts or never finishes
- (optional, off by default) the reply is very short

Every retry waits a little longer than the last so it never hammers the server, and waits extra when the server says it is busy. All of the triggers share one retry limit, so no reply is ever retried more than you allow, and nothing can loop forever.

It can also, optionally, run a find-and-replace on replies: swap words you don't like for ones you prefer, saved into the reply. See [Find and replace in replies](docs/word-swaps.md). This is off by default and is the only feature that edits a reply. A swap cannot be undone, so it is worth reading that page before switching it on.

## Install

In Lumiverse, open Extensions and install from the repository URL:

```
https://github.com/starlitcode/Lumiverse-Auto-Retry
```

## You are always in charge

Pressing your **Stop** button, or tapping **Cancel** on the retry pop-up, stops the extension right away. It drops any pending retry, resets the count, and a stopped reply cannot restart itself. The Cancel button on the pop-up is the extension's own, so it works no matter what.

## Settings

Open the chat input bar, tap the **Extras** popover, and choose **Auto Retry settings**. Options are grouped by what they do. Simple on/off switches are up top; the groups marked **Advanced** are collapsed by default, so tap one of those headers to reveal its options. Each setting has a **?** next to its name that shows a short description: hover it on a computer, tap it on a phone. The description floats just below that setting, so nothing shifts around and the setting you asked about stays visible. Only one shows at a time. To dismiss it, tap the description, tap the **?** again, tap anywhere else, scroll, or press Esc.

The **Search settings** box at the top finds any option by its name or its description, and opens whichever section it lives in, so you never have to remember which group something is under. Clearing the box puts the panel back exactly as it was.

Only **Save** keeps your changes. Closing with the X or tapping outside discards anything you did not save, so you can experiment freely. Saved settings sync to your Lumiverse account, so they follow you to other browsers and devices, and they apply to the next reply. Long text boxes, like your word-swap rules, have an **Expand** button that opens a full-size editor.

## Turning it off quickly

Two options in Basics, and you can use either or both:

- **Floating on/off button** puts a small button over the chat that toggles it in one tap. Drag it anywhere; it snaps to the nearest edge and stays where you leave it, and you can set its size. Hold it, or right-click on a computer, for a menu with **Move back to the corner** and **Hide this button**.
- **On/off button in the Extras menu** adds an entry next to the settings button. Its label says which state it is currently in, so you can check and change it without opening settings, and it takes up no room on screen.

## Documentation

- [When it retries](docs/detection.md) - cut-off detection and accidental-refusal detection
- [Word swaps](docs/word-swaps.md) - find and replace in finished replies, and presets
- [All settings](docs/settings.md) - every option with its default
- [Buttons it clicks](docs/buttons.md) - fixing the regenerate button, Regeneration Feedback, writing selectors
- [Import and export](docs/import-export.md) - moving your setup between devices
- [Reporting a bug](docs/troubleshooting.md)
- [Security](SECURITY.md) - what the extension can and can't reach, and how to check
- [Changelog](CHANGELOG.md) - what changed in every version

## Permissions

Declares four permissions:

- `generation`: to hear when replies start, stream, and end. This drives all the retry logic.
- `chat_mutation`: to edit a saved reply. This is used only by the "Find and replace in replies" feature, and only when you turn it on and enter swaps. If you never use that feature, nothing is edited.
- `ui_panels`: what Lumiverse requires before an extension may put a floating widget on screen. It is used only by the optional on/off button, and grants screen space rather than access to anything.
- `interceptor`: to add to a prompt before it reaches the model. Used only by "Send a note with a refusal retry", and only on a refusal retry once you turn it on and write a note. Nothing is read from your prompt and nothing is stored.

`chat_mutation` is a privileged permission, so depending on your Lumiverse setup it may need admin approval before it takes effect. The retry side works without it; only find-and-replace needs it. Without `ui_panels` everything still works, there is just no floating button. Without `interceptor` everything still works and the refusal note is not sent.

The find-and-replace feature runs in a small backend module. The rest of the extension is frontend-only. It makes no external network calls. Your settings are saved to your Lumiverse account through the extension's own scoped storage, so they follow you across browsers, with a copy kept in the browser as a fast local cache.

## How it works

Auto Retry listens to Lumiverse's own generation events. When a reply fails, comes back empty, stalls, or looks cut off or refused, it clicks your regenerate button to try again. That button click is the only part that depends on the page layout, so it is the one thing you can fix yourself in the settings if a Lumiverse update ever moves those buttons.

Find and replace works separately, since editing a saved reply is a backend job. A small backend module watches for finished replies and, when swaps are on, edits the saved message through Lumiverse's Chat Mutation API. That edit is treated as an edit, not a new reply, so it can't set itself off in a loop.

## Working on the extension

`src/` is the TypeScript source and `dist/` is what Lumiverse actually loads. `bun run build` regenerates `dist/` from `src/`, and `bun run check` runs the type check and the tests together. Run both before committing, so `dist/` never drifts from `src/`.

`test/` is for working on the extension and nothing else. Lumiverse only ever loads `dist/`, so the tests are not part of the install, add nothing to its size, and never run for anyone using the extension. They run when you type `bun run check`, and that is the only time.

`bun test` covers the decisions that are expensive to get wrong, and needs nothing installed:

- **Refusal and cut-off detection** - including the in-character lines that must *not* be treated as refusals, since a false positive throws away good writing.
- **The word-swap engine** - single-pass application, longest match wins, whole-word matching, capitalisation, and the greeting exemption. Driven through `dist/backend.js` itself, so a bad build fails these too.
- **The contrast maths** that keeps panel text readable on any theme.

`bun run test:ui` adds browser checks for the settings panel: contrast across themes, hints not shifting the list, keyboard reach, and teardown. It needs Playwright, which is not a dependency here and should not become one, since it pulls a few hundred megabytes of browsers (`bun add -d playwright && bunx playwright install chromium`). Without it the script says so and exits cleanly.

## Credits

- **starlitcode** - built and maintains the extension
- **[Claude](https://claude.ai)** (Anthropic) - wrote the code, directed and tested by starlitcode
- **[Hikarushmz](https://github.com/Hikarushmz/fetch-retry)** - their SillyTavern fetch-retry gave me the idea. Auto Retry is written from scratch and shares no code with it
- Everyone who has reported a bug or suggested something that turned into a fix

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
