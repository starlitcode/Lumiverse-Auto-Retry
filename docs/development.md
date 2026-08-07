# Working on the extension

Nothing here matters if you only want to use Auto Retry. This is for changing it.

## The build

`src/` is the TypeScript source and `dist/` is what Lumiverse actually loads. `bun run build` regenerates `dist/` from `src/`, and `bun run check` runs the type check and the tests together. Run both before committing, so `dist/` never drifts from `src/`.

`dist/` is committed as readable code rather than built on install, which is what lets the extension install without a build step and lets anyone read what runs. It is not minified, obfuscated or bundled; it is the same code with the type annotations removed.

## The tests

`test/` is for working on the extension and nothing else. Lumiverse only ever loads `dist/`, so the tests are not part of the install, add nothing to its size, and never run for anyone using the extension. They run when you type `bun run check`, and that is the only time.

`bun test` covers the decisions that are expensive to get wrong, and needs nothing installed:

- **Refusal and cut-off detection**, including the in-character lines that must *not* be treated as refusals, since a false positive throws away good writing.
- **What happens when a reply is not a reply**: rubbish input, and replies shaped to make a careless pattern backtrack until the tab locks up.
- **The prompt viewer**: that nothing is captured until the panel asks, that one account watching does not capture another's prompt, and that a vast prompt is trimmed rather than shipped whole. Driven through `dist/backend.js` itself.
- **The word-swap engine**: single-pass application, longest match wins, whole-word matching, capitalisation, and the greeting exemption. Driven through `dist/backend.js` itself, so a bad build fails these too.
- **The contrast maths** that keeps panel text readable on any theme.
- **That the hints match what ships**: every hint quoting a number is held against the defaults block, and every setting is held against the table in [All settings](settings.md), so neither can go stale without something failing.

`bun run test:ui` adds browser checks for the settings panel: contrast across themes, hints not shifting the list, keyboard reach, saved settings surviving a reload, and teardown. It needs Playwright, which is not a dependency here and should not become one, since it pulls a few hundred megabytes of browsers:

```
bun add -d playwright && bunx playwright install chromium
```

Without it the script says so and exits cleanly.

## What GitHub runs

Both tiers run for every pull request, along with a check that rebuilds `dist/` and fails if it differs from what is committed. That last one is the reason the workflow exists: `dist/` is what Lumiverse loads, so a change made in `src/` and not mirrored into `dist/` reviews as correct and ships doing nothing, and that is not something you can spot by reading a diff.

The browser tier skips itself when Playwright is missing, which is right on your own machine and wrong on a build server, so on GitHub a skip is treated as a failure rather than a pass.

---

[Back to the README](../README.md)
