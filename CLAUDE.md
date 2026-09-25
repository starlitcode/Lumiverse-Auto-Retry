# Working on Auto Retry

Auto Retry is a Lumiverse extension built on Spindle. Its sister extension is
[Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine), and the two are
kept in step: a fix to something they share, such as how a switch or a field row
behaves, goes into both.

## Branches and releases

- Work happens on `testing`. `stable` is what users install, and it only moves when
  the owner says to release.
- A release is dated the day it goes to `stable`.
- Versions follow semver. A patch only fixes things. Adding anything is a minor
  version. Bump `spindle.json`, `package.json` and the `VERSION` constants together.
- A version is released once the owner says it is announced, not when it goes to
  `stable`. Until then, new work joins that same version and its changelog entry,
  even if it is already on `stable`. Only start a new version after the owner
  says the last one is announced.

## Build and checks

- `src/` is the source. `dist/` is committed, readable, and is what Lumiverse
  loads. `bun run build` makes `dist` from `src`, and both go in the same commit.
  Never edit `dist` by hand.
- `bun run check` is types and the unit tests. The backend tests run
  `dist/backend.js` in a sandbox, so build before testing.
- `bun run test:ui` drives the built `dist/frontend.js` in headless Chromium.
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

## Rules from the owner

- Never mention anyone else's extension, in code, docs or anywhere else,
  unless the owner asks for it, as in the README credits. Never say that
  something was taken from another extension.
- If a page, file or doc cannot be opened or read, stop and ask the owner for
  a PDF or a copy of it. Do not guess what it says.
- Test fixtures use their own made-up characters and their own thinking format.
  Do not copy the owner's character names or thinking format into tests.
- Something that is inconsistent and wrong can be fixed without asking first.
- Refusal and false-positive handling stays broad: the owner wants every false
  refusal caught for users. Wording in prompts, comments and docs must never read
  as condoning sexual content involving minors. The README states this plainly.
