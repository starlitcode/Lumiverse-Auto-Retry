# Working on Auto Retry

Auto Retry is a Lumiverse extension built on Spindle. Its sister extension is
[Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine), and the two are
kept in step: a fix to something they share, such as how a switch or a field row
behaves, goes into both. Treat them as twins: the same thing has the same name,
the same wording and the same behavior in both, such as **Extra thinking tag
names**, the thinking formats, the put-back and replaced-reply storage, and the
motion of bulk buttons.

## Branches and releases

- Work happens on `testing`. `stable` is what users install, and it only moves when
  the owner says to release.
- `testing` is the default branch. Commit straight to it. When the owner says
  to push to `stable`, push to `stable`.
- Do not make any other branch, such as a
  `claude/...` branch, unless the owner asks for one. This holds even when a
  session names a branch to work on.
- After a release, bring `stable` into `testing` with a merge. Never reset or
  force-push `testing`. People install from it, and Lumiverse cannot update a copy
  whose branch history was replaced.
- A release is dated the day the owner releases it to the public, which is
  the day the owner says it is announced. It is not dated by the day it goes
  to `stable`. Until the owner says it is announced, its date is the day it
  went to `stable`, and it moves to the announced day once the owner says so.
  Use US Eastern time (America/New_York), not UTC.
- The owner is in US Eastern time. Every date and time uses it, not UTC.
  Make every commit with `TZ=America/New_York`, so its time is Eastern.
- Versions follow semver. A patch only fixes things. Adding anything is a minor
  version. Bump `spindle.json`, `package.json` and the `VERSION` constants together.
- A version is released once the owner says it is announced, not when it goes to
  `stable`. Until then, new work joins that same version and its changelog entry,
  even if it is already on `stable`. Only start a new version after the owner
  says the last one is announced.
- When the owner says a version is released, that means it is announced. Work
  after that goes into the next version, even on the same day.

## Skills

Two skills are available. Load them before starting work.

- `lumiverse-extension-creator`: for anything about the extension itself, such
  as Spindle, the manifest, the panel, the backend, storage and the tests.
- `code-helper`: for any code work, such as fixing bugs, reviews, tests,
  comments and the changelog.

## Build and checks

- `src/` is the source. `dist/` is committed, readable, and is what Lumiverse
  loads. `bun run build` makes `dist` from `src`, and both go in the same commit.
  Never edit `dist` by hand.
- `setup.sh` gets a cloud session ready: packages, Eastern time, a Lumiverse
  source copy, and checks on the branch and on `dist`. A cloud session with only
  this repo runs it by itself when it starts. A session with both extensions
  does not, so run `bash setup.sh` in each repo first. It only runs in the
  cloud, never on your own computer.
- `bun run check` is types and the unit tests. The backend tests run
  `dist/backend.js` in a sandbox, so build before testing.
- `bun run test:ui` drives the built `dist/frontend.js` in headless Chromium.
- `bun run test:ui:only "name"` runs only the browser check sections whose title
  holds that name. The full suite takes several minutes. Run the full suite
  before anything goes to `stable`.
- The browser checks load Lumiverse's own page-wide CSS, `HOST_CSS` in
  `test/ui.mjs`, copied from `frontend/src/theme/reset.css` and `global.css`
  in `~/lumiverse-src`. Lumiverse styles some elements everywhere, such as
  sliders, and text boxes on a phone. A rule for one of those needs a
  selector that outranks Lumiverse's. When the Lumiverse copy changes,
  compare `HOST_CSS` with those two files.
- A check of how something looks reads what is drawn, from a screenshot,
  not the value the code set. A slider's track and knob are the usual case.
- `test/lumiverse-themes.json` holds the colors Lumiverse's own theme engine
  writes, dark and light. `bun scripts/engine-themes.ts` writes it again from a
  Lumiverse clone, which `setup.sh` puts in `~/lumiverse-src`.
- A double check covers more than the code just changed. It also covers the
  places that are easy to miss:
  - `setup.sh` and the workflow in `.github`.
  - `SECURITY.md` and `docs/privacy.md`, against the permissions in `spindle.json`.
  - Every link and anchor in the docs.
  - Comments, tests and docs that still describe something removed.
  - Names that nothing uses, and names only the tests use.
  - The README and the descriptions in `spindle.json` and `package.json`.
  - How the two extensions work together, such as the event Auto Retry sends
    when it adds a reroll.
  - How it behaves with another extension's panel, widget or pop-up open.
- Anything a person sets, picks to switch off, or has already answered
  follows the account, written with `spindle.userStorage` under their user
  id: settings, presets, prompts, the chats switched off, and the marks for
  notices already read. Only what belongs to one screen stays in the browser,
  such as where the panel sits. The browser's copy is used until the
  account answers, then the account's copy replaces it, and nothing is
  written to the account before that answer.
- Nothing reads, writes or presses inside another extension's part of the
  page. Lumiverse marks every such part with `data-spindle-extension-root`,
  `data-spindle-ext` or `data-spindle-modal`, and `OTHER_UI` holds those
  marks. Another extension can draw its own chat, with its own input box and
  its own Regenerate button.
- A new check has to be seen failing: break the rule it guards in `dist`, watch
  that check fail, then put `dist` back.
- `test/host-calls.test.ts` needs a `try {` within 60 lines above every
  `spindle.x.y(` call. Keep comments above the `try`, not between it and the call.
- The built-in retry notes carry a mark worked out from their text. Changing
  their text tells every user who took them that they have changed, so do it on
  purpose.
- Any other default that changes after it was released goes in
  `MOVED_DEFAULTS`. A user still on the old one is then told, and can take the
  new one. A setting added in the version being written has no old value, so
  it is not listed.
- Refusal and cut-off detection has corpus tests in `test/detection-corpus.test.ts`
  and `test/truncation-corpus.test.ts`. A new pattern gets a line in the corpus
  that it catches and one close to it that it must not.

## Thinking formats

- Both extensions recognize the same thinking formats. A new one goes into both,
  with a test for it closed and a test for it opened with no closer, and a row
  in both docs tables (`docs/detection.md` in Auto Retry, `docs/prompt.md` in
  Auto Refine).
- A Prefix and Suffix saved on a connection in Lumiverse's Reasoning settings
  are read with `spindle.connections.list`, from `reasoning_bindings.settings`.
  The global Reasoning settings cannot be read by an extension.

## Writing

This covers code comments, docs, the changelog, the README, and every word
shown in Lumiverse.

- American spelling everywhere: color, gray, behavior, recognize, judgment,
  canceled, labeled, center. Never British spelling, in code, comments, tests,
  docs, the changelog, commit messages or panel text. Two exceptions, each
  with a comment saying why: a pattern that has to match what a model writes
  takes both spellings, such as `fulfill?`, and the old name of a saved
  setting is read once to move it to its new name.
- No em dashes, and no en dash used as one.
- No clichés, no metaphors, no grand phrasing.
- Never the word "ship", in any form.
- No contractions in docs, the changelog, the README or text shown in the panel.
  The one exception is `docs/safety.md` in Auto Retry, which uses them.
- Comments describe the code as it is and why. They are not change notes.
- A hint under a field is one line, two at most. Detail goes in `docs/`.
- Write plainly and literally, for readers with a learning disability,
  dyslexia or autism: short sentences, one idea each, steps and bullets over long
  paragraphs. No figurative words such as "quietly", "hammers" or "breathes".
  This covers words borrowed from other crafts, such as "beats" for the events
  in a scene. Say "events" or "what happens".
- No clichés such as "deliberate", and no grand, old-fashioned or showy words.
- No dry, generic AI phrasing and no filler. Say the fact and stop.
- No opinions, moral or otherwise, in code, comments or docs. State what the
  code does. Advice that helps a user is fine.
- No announcements in comments. A comment never says what is new or what
  something used to do.
- Keep the panel and GitHub pages organized: short sections with headings,
  and detail in `docs/` rather than in the README.
- Every host call and every outside call handles failure and says what went
  wrong in words a user understands.

## The changelog

- Only released behavior. A bug that was made and fixed between two releases
  never reached anyone and is not listed.
- Before writing "Fixed" or "Changed", check the thing existed in the last
  announced version. Something added in this version is described as it is
  now, under "Added", never as a fix to something users had before.
- To check, read the code of the last announced version with `git show`,
  or run the check for the bug against that version's `dist`. If the bug is
  not in that version, it is not a fix. The same goes for the Discord post.
- Versions announced at the same time count as one release. A bug made in
  one of them and fixed in a later one of them never reached anyone, so it
  is not a fix. Check against the version announced before them.
- An announced entry keeps what it says. Wording in it that breaks the
  writing rules can be fixed at any time, as long as the facts stay the
  same. A correction of fact goes in the next version.
- An entry names a button, heading or setting as it was called in that
  version, even when the name holds a word the writing rules now ban, such
  as "Ships with it". A later rename goes in the version that made it.
- A fix that an announced version claimed and that did not work is listed
  again in the next version, as "Fixed again", saying which version claimed
  it and what it missed. The Discord post uses "Fixed again" as its lead.
- Credit for a report goes in the changelog, for example "Reported by a Discord
  user". Credit goes only to people the owner names.
- Whenever the owner passes on something from a user, such as a report, a
  request, a suggestion or a question, every changelog entry it leads to ends
  with the credit: "Reported by a Discord user." for a problem, "Suggested by
  a Discord user." for something new, "Asked about by a Discord user." for a
  question. Write it in the same commit as the entry. This covers every entry
  that comes from it:
  - the fix or the feature itself;
  - the same change made in the other extension;
  - a feature added after a user's question, even when the owner asks for it
    in their own words.
  Before a push to `stable`, read the owner's messages since the last release
  for anything that came from a user, and check each entry it led to.
- When a user opens a pull request, from Discord or anywhere else, the credit
  links that pull request instead of naming a Discord user. This gives them
  credit on GitHub. Use "Reported in", "Suggested in" or "Asked about in",
  such as "Reported in [pull request #12](https://github.com/starlitcode/Lumiverse-Auto-Retry/pull/12)."
  Add "which also suggested the fix" when it did. This holds whether or not
  the pull request is merged, and for every entry it leads to, in both
  extensions.

## Discord posts

A code block, in this shape and nothing else:

```
**Auto Retry vX.Y.Z**
- **Added: bold lead.** Plain prose.
- **Fixed: bold lead.** Plain prose.
- **Fixed again: bold lead.** Plain prose.
- **Changed: bold lead.** Plain prose.
```

No credits in the Discord post. They stay in the changelog.

The Discord post never mentions minors, age, or changes to the safety wording
and the **Made for adults** section. Those stay in the docs and the changelog.

Keep the post short, but give each line enough to be understood. Each line
says what changed and what the user will notice, in two plain sentences, three
at most. Leave out background, lists of colors or options, and other detail
the changelog already explains.

Write the Discord post each time a version is pushed to `stable`, and give it
to the owner in the reply. A push that changes nothing users see, such as a
change to CLAUDE.md, has no post.

## Phones and laptops

Every change to the panel or the page has to work on a phone and on a laptop.

- Check it at a phone width (about 360 to 420 pixels, touch) and at a laptop
  width (about 1280 pixels, mouse). A browser check or a screenshot at each
  counts. Say which was done.
- Nothing may run off the side, overlap, or need sideways scrolling.
- Tap targets on a phone are at least 32 pixels high.
- Use hover where hover helps on a laptop, such as a highlight or a title on a
  button. Hover is only ever an extra. Phones have no hover, so everything a
  hover shows or does must also work with a click or a tap.
- Use a click or a tap for anything that does something or opens something.
- Lumiverse's **UI Scale** zooms the whole page. A size read with
  `getBoundingClientRect` is in zoomed screen pixels, and a size written to a
  style is in CSS pixels. Convert before writing one back, as `cssHeight`
  does, or a row opens to the wrong height and jumps at the end. Browser
  checks for size and motion run at zoom 1, 1.25 and 0.85.
- A box fitted to a measured height leaves one pixel spare. Heights are read
  as rounded whole numbers, and with UI Scale on the real height can have a
  fraction in it. A box fitted exactly can then overflow by less than a pixel
  and scroll, with a second scroll bar. A check for this sets `scrollTop` very
  high and reads it back as 0, at every UI Scale step from 50% to 150%. It
  never compares `scrollHeight` with `clientHeight`, which can read as equal
  while the box still scrolls.

## Motion

The owner is sensitive to flashing and to busy movement. The rules below are
the defaults. An effect the owner asks for overrides them.

- The owner prefers fades and slides. Anything that appears or goes, such as
  a pop-up, a card, an editor, a notice or a description, fades in and out
  and slides a little. It never grows or zooms.
- Toggles, such as a switch or a tick box, may zoom, bounce or use whatever
  effect the owner asks for.
- Widgets, such as the floating button, are more complex, and these rules do
  not bind them. The owner decides how they move. Without a request, choose
  what suits the widget.
- A glow or a light-up is slow and runs once, so it reads as a glow and
  never as a blink. Nothing flashes more than once.
- Something that comes and goes with a switch opens and closes smoothly. Its
  space opens and closes over several frames, so the rows under it move with
  it, and it fades and slides 4 pixels. Nothing pops in or out between two
  frames.
- Reduce motion, from the panel or the device, turns all of it off. A part
  that would change size keeps its size, since a size change with no movement
  is a jump.
- Move opacity and position where possible, which is cheap to draw.

## Notifications

The owner does not want notifications to be noisy. Each extension sends one
only where it is needed, and leaves it out where it is not.

- Send a notification when nothing else on screen shows what happened. For
  example, Auto Retry's floating button can turn it on or off with the panel
  closed, so it says whether it is now on or off.
- Send none when the screen already shows the change. A switch in the panel
  or a Save in the settings shows its own new state.
- Warn when something could not be done, saved or remembered. Nothing else on
  screen says so.
- Before adding a notification, check whether the panel, a card or the status
  line already shows the same thing. If it does, leave the notification out.
- Copying and pasting send no notification. The phone or computer shows its
  own. Only a copy that fails warns, since nothing else says so.

## Talking to the owner

The owner has a learning disability. Contradictions are confusing.

- Say what was changed, plainly, in one statement. Do not say something is
  meant to work one way and then change it to work another way in the same
  message.
- If something the owner reports is working as designed, say so and ask
  whether to change it. Do not change it and also defend the old way.
- When a report is about how something looks or behaves, the fix is what the
  owner asked for. Reword a message instead only if the owner agrees.
- After a change, say exactly what is different now, not what it used to be
  meant to do.

## Rules from the owner

- The extensions are about giving people control. Nothing sent to a model is
  hidden: every built-in prompt, check and instruction can be read in the panel
  and changed there, with a way back to the built-in version.

- Never reveal anything personal the owner shares: email addresses,
  locations, IP addresses, chat conversations, persona names or character
  names. Not in code, tests, docs, the changelog, commit messages, pull
  requests or replies, and never say that any of these belong to the owner.

- Never mention anyone else's extension, in code, docs or anywhere else,
  unless the owner asks for it, as in the README credits. Never say that
  something was taken from another extension.
- If a page, file or doc cannot be opened or read, stop and ask the owner for
  a PDF or a copy of it. Do not guess what it says.
- Test fixtures use their own made-up characters and their own thinking format.
  Do not copy the owner's character names or thinking format into tests.
- Examples are made up fresh, in prompts, checks, docs, tests, the changelog and
  panel text. When the owner shows a line or an example to explain a problem,
  do not reuse it or a close copy of it. Write a new one that shows the same
  thing.
- Something that is inconsistent and wrong can be fixed without asking first.
- The extensions are made for adults, 18 and older. Lumiverse itself is not
  an adult app: anyone can use it, and it has no adult content of its own.
  Never write that Lumiverse is built for adults.
- The README says this in one short **Made for adults** section near the end,
  above Credits: who the extension is for, that it is not for sexual content
  involving minors, that the owner does not help anyone under 18 with
  anything, and one link to
  the details. Nothing more. The details live in the docs: **About age** in
  Auto Retry's `docs/detection.md`, and **The one thing they do not edit** in
  Auto Refine's `docs/prompt.md`.
- The README never grows with extra detail. Anything beyond a short summary
  goes in the doc it belongs to, with a link from the README.
- `docs/safety.md` in Auto Retry is in the owner's own voice: human, honest
  and a little blunt, in short sentences, with contractions. Every other
  writing rule above still applies to it.
- Refusal and false-positive handling stays broad: the owner wants every false
  refusal caught for users. Wording in prompts, comments and docs must never read
  as condoning sexual content involving minors. The README states this plainly.
