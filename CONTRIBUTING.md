# Working on Auto Retry

This page is for changing the code. Nothing here is needed to use the extension.

## The thing that catches people out

Lumiverse does not build anything. It loads two finished JavaScript files, `dist/frontend.js` and `dist/backend.js`, and both are committed to this repository so that installing the extension does not require a build step.

The code you actually edit is the TypeScript in `src/`. Those are two separate sets of files, and Lumiverse only ever reads the second one.

So a change made in `src/` and nothing else does nothing. Lumiverse keeps loading the old `dist/` files. The change looks right in the diff, reads correctly in review, and ships having no effect, with no error anywhere to say so. This is the one way to be completely wrong here while appearing to be completely right.

The fix is to run the build after changing anything, and to commit `dist/` in the same commit as `src/`.

## The commands

```
bun run build     # rewrite dist/ from src/
bun run check     # types and tests
bun run test:ui   # panel checks in a real browser, needs Playwright
```

`bun run check` is the one to run before every commit. It takes a couple of seconds.

## What CI checks

Every pull request runs both sets of tests. It also rebuilds `dist/` itself and compares the result against the `dist/` you committed. If they differ, the pull request fails, which is what stops the problem above from reaching anyone.

## Playwright

`test:ui` drives the built extension in a real browser, which is the only way to catch a panel that renders wrong or a button that stops working. Playwright is not listed as a dependency because installing it downloads a few hundred megabytes of browsers, which is a lot to force on somebody who only wanted to read the source.

To install it:

```
bun add -d playwright && bunx playwright install chromium
```

Without it, `test:ui` tells you it is missing and exits without failing, so you can work on the repository without it. On CI it counts as a failure, so the browser checks cannot be skipped on the way in.

## Two sets of tests, and what each is for

`bun test` covers the decisions: is this reply cut off, is this a refusal, which chat does this belong to. Plain functions with no browser involved.

`test/ui.mjs` covers what a person sees. It loads the built `dist/frontend.js` into headless Chromium against a stub Lumiverse and clicks things. Anything to do with the panel, the floating button, the menus, or the toasts belongs here, because none of that can be checked by calling a function.

A bug in behaviour usually wants a check in the first. A bug somebody reported by describing what they saw usually wants one in the second.

---

[Back to the README](README.md)
