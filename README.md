<p align="center">
  <img src="docs/retry-banner.png" width="100%" alt="Auto Retry: on a city rooftop at night, a woman smiles at a glowing chat bubble above her open hand. A ribbon of light loops to it from an old chat bubble coming apart in the sky.">
</p>

# Auto Retry

A Lumiverse extension. It re-runs an AI reply when it fails, comes back empty, stalls partway, gets cut off mid-sentence, or refuses by mistake, so you do not have to catch it and press regenerate yourself.

It works alongside [Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine). Auto Retry decides whether a reply is worth keeping. Auto Refine improves the ones that are.

## What it does

It watches each reply and tries again when:

- the provider sends back an error (by default it skips errors that will not go away, like a wrong API key)
- the reply comes back empty, including one that "thinks" but never writes anything
- the thinking or the reply is one character over and over, like `!!!!!!!!` (see [One character over and over](docs/detection.md#one-character-over-and-over))
- the thinking or the reply turns into a jumble of words from several languages run together, words with no spaces, or broken characters (see [Garbled replies](docs/detection.md#garbled-replies) and [The thinking](docs/detection.md#the-thinking))
- the reply runs into the prompt's own format, such as `[/INST]` (see [Leaked prompt format](docs/detection.md#leaked-prompt-format))
- the thinking or the reply gets stuck repeating itself, or the reply runs on with no punctuation (see [Stuck repeating or rambling](docs/detection.md#stuck-repeating-or-rambling))
- the reply is cut off mid-sentence (see [Cut-off detection](docs/detection.md#cut-off-detection))
- the reply is an accidental out-of-character refusal, or the model breaks off mid-scene
  (see [Accidental-refusal detection](docs/detection.md#accidental-refusal-detection))
- a reply never starts, or stops partway and nothing more comes for a while
- (optional, off by default) the reply is very short
- (optional, off by default) the model leaves the scene to offer real-world support
  (see [Stopping to offer support](docs/detection.md#stopping-to-offer-support), and [Safety](docs/safety.md) before switching it on)

Also:

- Every retry waits a little longer than the last, and longer again when the server says it is busy.
- All the reasons share one retry limit, so no reply is retried more than you allow, and it can never loop forever.
- (optional, off by default) From the second try, it can send several tries at once and keep the first reply that passes. See [Several tries at once](docs/tries-at-once.md).
- An impersonation you start with **Impersonate** is tried again when it errors, is refused, comes back blank, is broken or is clearly cut off. What you had typed is put back first. See [Impersonations](docs/detection.md#impersonations).

## Install

1. In Lumiverse, open **Extensions**.
2. Install from this address:

   ```
   https://github.com/starlitcode/Lumiverse-Auto-Retry
   ```

3. To see its settings, open the chat input bar, tap **Extras**, and choose **Auto Retry settings**.

It works with no setup. Everything else is optional.

## You are in control

- **Stop**, or **Cancel** on the retry pop-up, stops it right away. Any waiting retry is dropped, the count resets, and a stopped reply cannot start again by itself.
- **Cancel** on the pop-up belongs to the extension, so it always works.
- To switch it off for one chat, or everywhere, see [Turning it off](docs/settings.md#turning-it-off-in-one-chat).

## Documentation

- [When it retries](docs/detection.md): cut-off detection and accidental-refusal detection
- [All settings](docs/settings.md): every option with its default, the panel, and turning it off
- [Several tries at once](docs/tries-at-once.md): what it does, what it costs, and when it is used
- [Buttons it clicks](docs/buttons.md): fixing the regenerate button, Regeneration Feedback, writing selectors
- [The on-screen panel](docs/settings.md#the-on-screen-panel): the log, the prompt viewer and the stats
- [Import and export](docs/import-export.md): moving your setup between devices
- [Reporting a bug](docs/troubleshooting.md)
- [Safety](docs/safety.md): who this is for, the one setting that asks before it turns on, and what the retry loop can turn into
- [Privacy](docs/privacy.md): what the extension can and cannot reach, what it keeps, and how to check any of it
- [Security policy](SECURITY.md): how to report a security problem
- [Changelog](CHANGELOG.md): what changed in every version

## How it works

- It listens to Lumiverse's own generation events. When a reply goes wrong, it presses your swipe or regenerate button to try again.
- Pressing that button is the only part that depends on the page layout. If a Lumiverse update moves the buttons, [Buttons it clicks](docs/buttons.md) shows how to point it at the new ones.
- A small backend keeps your settings with your account, not in one browser, and holds the retry note for the one reply it is meant for.
- With **Several tries at once** on, the backend also asks Lumiverse to send the prompt to your model several times, and adds the reply that passes as a new reroll, or as a new reply when the failed turn saved none.
- It makes no network calls of its own. [Privacy](docs/privacy.md) covers the six permissions it asks for and what still works without each one.
- The files Lumiverse loads are `dist/frontend.js` and `dist/backend.js`. They are plain, readable JavaScript. Nothing is minified. [Privacy](docs/privacy.md#checking-any-of-this-yourself) goes through the rest of the repo file by file.

## Help and feedback

Questions, bug reports and ideas are welcome in my [Auto Retry post](https://discord.com/channels/1484149939167821915/1514031700185714688) on the Lumiverse Discord server, or as a [GitHub issue](https://github.com/starlitcode/Lumiverse-Auto-Retry/issues). [Contributing](CONTRIBUTING.md) says what to put in a bug report.

## Made for adults

Auto Retry is for adults, 18 and older. It is not for sexual content involving minors, and I do not support anyone using it for that. I do not help anyone who tells me they are under 18, with anything. [About age](docs/detection.md#about-age) says exactly how the extension handles it.

## Credits

- **starlitcode**: built and maintains the extension
- **[Claude](https://claude.ai)** (Anthropic): wrote the code, directed and tested by starlitcode
- **[Hikarushmz](https://github.com/Hikarushmz/fetch-retry)**: their SillyTavern fetch-retry gave me the idea. Auto Retry is written from scratch and shares no code with it
- Everyone who has reported a bug or suggested something that turned into a fix

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
