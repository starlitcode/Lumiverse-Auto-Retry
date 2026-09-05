# Privacy

Extensions run inside the app, so it is fair to want to know what one can reach before you install it. This page explains what Auto Retry touches, what it keeps, and what it has no way to get at. If you want to report a security problem instead, that is in [SECURITY.md](../SECURITY.md).

## It works entirely on your own device

Auto Retry has no networking in it at all. It never opens a connection, never contacts a server of mine or anyone else's, and has no analytics. Everything it does happens inside your copy of Lumiverse, using events the app already gives it. If you would rather confirm that than take my word for it, searching the two source files for `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource` turns up nothing, and those are the only ways a browser extension can send anything out.

There is one link in it, in the warning that stands in front of the crisis-support check, and it points at the safety page in this repository. Drawing it fetches nothing. If you tap it your browser opens GitHub in a new tab, which is your browser going somewhere, not the extension sending anything, and if you never tap it nothing happens at all.

It also never treats text as code. There is no `eval` and no `new Function` anywhere, so nothing in a reply, a character card, or your own settings can be run.

## What it can reach, and why it needs to

It asks Lumiverse for six permissions. Lumiverse sorts permissions into two tiers: some are granted the moment you install, and some are privileged and do nothing at all until an admin approves them. Four of these six are privileged, so on a shared instance they may sit inactive until someone with admin turns them on.

None of the five is required for the extension to start, which is why each one below says what you still have if you refuse it.

### `generation`

Privileged. Declared so the extension can follow the generation lifecycle, the events that tell it a reply started, streamed, or ended.

**Refuse it** and the extension cannot see replies happening at all. This is the one it genuinely cannot work without.

### `ui_panels`

Privileged. What Lumiverse requires before an extension may put a floating widget or a docked edge panel on screen. It is used for the optional on/off button, and for the on-screen panel when that panel floats over the chat.

It grants screen space, not access to your data, and putting the panel in the sidebar drawer instead needs no permission at all: drawer tabs are open to every extension.

**Refuse it** and everything works. There is no floating button.

### `chats`

Privileged, and the one to read carefully, because it grants more than the extension uses. Lumiverse bundles reading, creating and deleting chat sessions into a single permission and there is no narrower one to ask for.

Auto Retry uses exactly one call from it, the one that answers which chat you are currently looking at. It never creates a chat, never deletes one, and never changes a chat's settings or title.

**Refuse it** and everything works. The **Turn off here** button waits to be told which chat you are in rather than asking, which is how it behaved before this permission existed.

### `characters`

Privileged. Only ever used to turn the card id a chat carries into a name, so the panel can say who a chat is with rather than showing you an id. It reads one card at a time, the one belonging to the chat you are in, and it never creates, edits or deletes a card.

**Refuse it** and everything works. No chat is named, and the panel says "This chat" as it always did.

### `interceptor`

Privileged. Lets an extension add to a prompt on its way to the model. Two things use it: "Send a note with a refusal retry", which is off by default, and the on-screen panel's **Prompt** tab, which reads the assembled prompt there because that is the only place the whole of it is visible.

**Refuse it** and everything works. The refusal note is not sent, and the Prompt tab stays empty and says so.

### The APIs behind them

Behind those permissions it uses eight Lumiverse APIs and nothing else, and everything the extension does is built out of these:

- reading the messages in a chat
- updating a message
- asking which chat is currently open
- reading the name off one character card
- counting the tokens in a prompt
- reading its own settings
- writing its own settings
- registering the interceptor above

### The note sent with a refusal retry

That note is the only thing in the extension that changes what the model is asked, so it is worth being precise about. It carries the text you typed and nothing else: your prompt is not read, nothing is copied out of it, and nothing is stored. Nothing is written to your chat.

Because it is never a message in your chat, it will not necessarily appear in Prompt Breakdown, which lists what your chat is built from. The extension labels it for that panel, but whether it shows depends on your Lumiverse build. To see for yourself what went out and when, turn on the on-screen panel, which writes a line naming the note on the retry that carried it.

It is put in place the moment before the extension clicks your retry button, and four things keep it to that one generation:

- It belongs to the chat it was put in place for, and is never attached to a generation in another.
- It is used once and cleared, whether it was used or not.
- It expires after 45 seconds.
- When the retry click it was armed for turns out to have started nothing, it is taken straight back rather than left waiting. If there is no retry button on screen to click at all, nothing is armed in the first place.

Lumiverse also reports what kind of generation is running, and you can require that to say "regenerate" or "swipe" as a fifth check, under **Only send them on a regenerate or a swipe**. It is off by default because most builds report every generation as "normal", including a regenerate, so leaving it on stopped the note from ever being sent.

## This page can change

A new feature can need a permission the extension does not have yet, and when that happens this page is updated to say so before the version that needs it ships. `chats` is the one that has happened so far.

It is not expected to happen often. What is declared now covers what the extension is for, and a new permission is a real cost rather than a formality: every user has to approve it, and the ones who read this page have to decide again whether they still want it installed. So the bar for asking is high, and "it would be tidier" does not clear it.

Two things will not change. The extension will not start making network calls, and it will not start sending anything anywhere. Those are not features waiting on a permission; they are the point of the thing.

If you want to know exactly what a release asks for, `spindle.json` in the repository lists the permissions, and the changelog says when one is added and why.

## What it has no way to reach

Your API keys, passwords, and account details are not available to it. Lumiverse does not hand those to extensions, and there is no code in Auto Retry that goes looking, which you can confirm by searching the source for `apikey`, `secret` or `credential` and finding nothing.

It reads a reply only to run its checks on the one that just arrived, and it does not keep a copy. While a reply is streaming it does hold the text arriving so far, because some Lumiverse builds do not put the finished reply on the event that says it ended, and then what streamed is the only thing there is to check. That copy is dropped the moment the reply ends, and the moment you stop one partway.

It reads the reply on screen when a generation starts, to have something to compare against if a wait later runs out with nothing having reached the tab. What it keeps is a fingerprint, a length and a number worked out from the characters, not the reply: enough to answer "has this changed" and no use for anything else. It is dropped when the generation ends.

It also reads the address in your browser's bar, and asks it one question: does the address still contain the id of the chat it thinks you are in. That is how it notices you have gone back to the home screen, which Lumiverse does not always say. The answer is a yes or a no. The address is not stored, not sent anywhere, and not looked at for anything else.

## What it keeps

Your settings and your saved presets are saved twice over: once in your browser's local storage, and once in Lumiverse's own per-user storage so they follow your account between devices. That is the only thing that reaches your account.

Two more things are written, and both stay in this browser:

- Where you left the on-screen panel and the floating button, which is two positions, a size and which tab was open, so an update does not put them back in the corner.
- The list of chats you have switched Auto Retry off in, which is chat ids and nothing more: no titles and no text.

Neither is synced and neither is included in an export, since a position on one screen and an id on one account mean nothing on another. That is everything written anywhere.

Separately it keeps the last twenty lines of what it did, and a few counters for the session: replies that came back fine, retries fired, what they fired for, how many happened in each chat, named where a name was available, and refusal notes sent and skipped. The per-chat counts are kept against the chat id, never against anything a reply said. That is all in memory, so the Copy debug info button has something to report. Both die with the tab.

**Keep the reply a retry replaced** adds one more thing to that list, and it is the only one that holds a whole reply. When a retry throws a reply away, the text of that reply is kept for the chat it came from, so you can read it back on the **Replaced** tab if the retry was a mistake. At most eight chats' worth is kept, the newest replacing the oldest. It is never written to disk, never synced, never sent anywhere, and it goes when the tab closes. Turn it off under **How it retries** and nothing is kept. Neither is written to disk and neither leaves your device.

The on-screen panel's **Prompt** tab is the one part that holds more than that, and only once you have asked it to. Opening that tab asks the extension to keep a copy of the prompt on its way to the model, which is the text of your chat, so that it can show it to you. Until you open it, nothing is kept: someone who uses the panel for its log and never goes near this tab is not paying for it.

From then on it keeps up while the panel stays open, so glancing at the log does not lose the prompt you sent while you were there. Close the panel, or the browser tab, and nothing is kept at all, and the next time you open the panel it waits to be asked again. It is never written to disk and never leaves your device, and only one prompt is held at a time: each generation replaces the last. This is why there is no separate switch to leave on and forget about.

## One thing to be careful with

Nothing in this section leaves your device by itself. All three are buttons that put something on your clipboard when you press them, and the only risk is what you then paste, and where.

The Copy debug info button gathers your settings, your button selectors, your browser string, the session counters, and that recent activity log. The activity log records what the extension saw, so it can contain short fragments of a reply. Read what you copied before pasting it somewhere public, and untick any section you would rather keep to yourself. The tick boxes are there for exactly that.

The **Copy** button on the on-screen panel is the same thing in miniature, and it takes everything the tab is showing. On the **Replaced** tab that is a whole reply. On the Log tab that is the whole activity log in one tap, fragments included, and on the Prompt tab the entire prompt, which is most of your chat. The Stats tab is the safe one: counters and the names of what it retried for, no text from any reply.

It is there because selecting text by hand on a phone is awkward, and the same advice applies before you paste any of it anywhere.

The refusal tester in the settings panel only reads the text in its box. **Use my last reply** fills that box by reading the reply rendered on the page at the moment you press it, which is the same reply the extension already reads to run its checks. Nothing is kept between replies. It runs the check on your device and reports the verdict; it sends nothing and stores nothing.

## Checking any of this yourself

The files Lumiverse actually loads are the two named in `spindle.json`, `dist/frontend.js` and `dist/backend.js`. They are committed as readable code: not minified, not obfuscated, not bundled. What you read is what runs, which is also why the extension installs without a build step. If you are auditing this extension, or pointing a scanner at it, those two files are the whole of what ships.

Everything else in the repo exists for working on it, and none of it reaches your browser:

- `src/` is the TypeScript those two files are built from. A scanner that only parses JavaScript cannot read it and will say so. The shipped `dist/` files are plain JavaScript and parse normally.
- `test/` runs only when a contributor types `bun run check`. It is not part of the install and adds nothing to its size.
- `setup.sh` prepares a development machine. Nothing runs it at install time and nothing in the extension calls it.
- `docs/` is these pages. None of it is code.
- `.github/workflows/` runs the checks on pull requests. Its actions are pinned to commit hashes rather than to movable tags, and the checkout step keeps no credentials in the build environment.

Those checks rebuild `dist/` from `src/` on every pull request and fail if the result differs from what is committed, so the readable files you are auditing cannot quietly drift from the source they claim to come from.

---

[Back to the README](../README.md)
