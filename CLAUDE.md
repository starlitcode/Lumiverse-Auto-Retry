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

## The changelog

- Only released behaviour. A bug that was made and fixed between two releases
  never reached anyone and is not listed.
- A released entry is not rewritten. Corrections go in the next version.
- Credit for a report goes in the changelog, for example "Reported by a Discord
  user". Credit goes only to people the owner names.

## Discord posts

A code block, in this shape and nothing else:

```
**Auto Retry vX.Y.Z**
- **Added: bold lead.** Plain prose.
- **Fixed: bold lead.** Plain prose.
- **Changed: bold lead.** Plain prose.
```

No credits in the Discord post. They stay in the changelog.

## Rules from the owner

- Never mention anyone else's extension, in code, docs or anywhere else.
- Test fixtures use their own made-up characters and their own thinking format.
  Do not copy the owner's character names or thinking format into tests.
- Something that is inconsistent and wrong can be fixed without asking first.
- Refusal and false-positive handling stays broad: the owner wants every false
  refusal caught for users. Wording in prompts, comments and docs must never read
  as condoning sexual content involving minors. The README states this plainly.
