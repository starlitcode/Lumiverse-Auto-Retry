# Working on Auto Retry

Auto Retry is a Lumiverse extension built on Spindle. Its sister extension is
[Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine), and the two are
kept in step: a fix to something they share, such as how a switch or a field row
behaves, goes into both. Treat them as twins: the same thing has the same name,
the same wording and the same behaviour in both, such as **Extra thinking tag
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
- `test/lumiverse-themes.json` holds the colours Lumiverse's own theme engine
  writes, dark and light. `bun scripts/engine-themes.ts` writes it again from a
  Lumiverse clone, which `setup.sh` puts in `~/lumiverse-src`.
- A new check has to be seen failing: break the rule it guards in `dist`, watch
  that check fail, then put `dist` back.
- `test/host-calls.test.ts` needs a `try {` within 60 lines above every
  `spindle.x.y(` call. Keep comments above the `try`, not between it and the call.
- The built-in retry notes carry a mark worked out from their text. Changing
  their text tells every user who took them that they have changed, so do it on
  purpose.
- Refusal and cut-off detection has corpus tests in `test/detection-corpus.test.ts`
  and `test/truncation-corpus.test.ts`. A new pattern gets a line in the corpus
  that it catches and one close to it that it must not.

## Thinking formats

- Both extensions recognise the same thinking formats. A new one goes into both,
  with a test for it closed and a test for it opened with no closer, and a row
  in both docs tables (`docs/detection.md` in Auto Retry, `docs/prompt.md` in
  Auto Refine).
- A Prefix and Suffix saved on a connection in Lumiverse's Reasoning settings
  are read with `spindle.connections.list`, from `reasoning_bindings.settings`.
  The global Reasoning settings cannot be read by an extension.

## Writing

This covers code comments, docs, the changelog, the README, and every word
shown in Lumiverse.

- No em dashes, and no en dash used as one.
- No clichés, no metaphors, no grand phrasing.
- Never the word "ship", in any form.
- No contractions in docs, the changelog, the README or text shown in the panel.
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
- Keep the panel and GitHub pages organised: short sections with headings,
  and detail in `docs/` rather than in the README.
- Every host call and every outside call handles failure and says what went
  wrong in words a user understands.

## The changelog

- Only released behaviour. A bug that was made and fixed between two releases
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

Keep the post short, but give each line enough to be understood. Each line
says what changed and what the user will notice, in two plain sentences, three
at most. Leave out background, lists of colours or options, and other detail
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
- Refusal and false-positive handling stays broad: the owner wants every false
  refusal caught for users. Wording in prompts, comments and docs must never read
  as condoning sexual content involving minors. The README states this plainly.
