# Working on Auto Retry

`src/` is the TypeScript, `dist/` is what Lumiverse loads, and `dist/` is committed so the extension installs without a build step. That means the two can drift, and a change made in `src/` alone would review as correct and ship doing nothing, so:

```
bun run build     # regenerate dist/ from src/
bun run check     # types and tests
bun run test:ui   # panel checks in a browser, needs Playwright
```

Run `bun run check` before committing, and commit `dist/` with `src/`. CI runs both tiers on every pull request, rebuilds `dist/` and fails if it differs from what you committed. Playwright is not a dependency, since it pulls a few hundred megabytes of browsers: `bun add -d playwright && bunx playwright install chromium`. Without it `test:ui` says so and exits cleanly on your machine, and counts as a failure on CI.

---

[Back to the README](README.md)
