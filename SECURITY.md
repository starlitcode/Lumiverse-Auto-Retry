# Security policy

## Reporting a problem

If you have found something in Auto Retry that could put someone's account, chats or machine at risk, tell me and I will look at it.

**Message me on Discord as `.moonsight.` in the Lumiverse server.** That is the better route for anything you would rather not describe in public, since a GitHub issue is visible to everyone the moment you open it.

If it is not sensitive, or you would rather have it written down in the open, [open an issue](https://github.com/starlitcode/Lumiverse-Auto-Retry/issues).

Useful things to include, as far as you have them:

- what you saw, and what you expected instead
- the steps that produce it, or the reply or setting that triggers it
- your Lumiverse build and browser, and the Auto Retry version from the top of the settings panel
- anything **Copy debug info** gives you, with the tick boxes used to leave out whatever you would rather not share

Please do not post a working exploit in a public issue before I have had a chance to reply.

## What happens next

I maintain this on my own in my spare time, so I cannot promise a fix by any particular date. I will read what you send, and I will tell you whether I think it is a real problem and what I intend to do about it. If it is, the fix goes out as a new version with the changelog saying what it was.

Only the latest version is supported. There is no back-porting: updating is the fix.

## Reviewing it yourself

The files Lumiverse actually loads are the two named in `spindle.json`, `dist/frontend.js` and `dist/backend.js`. They are committed to the repo as readable code. They are not minified, obfuscated, or bundled, so what you read is what runs, and it is why the extension installs without a build step. **If you are auditing this extension, or pointing a scanner at it, those two files are the whole of what ships.**

Everything else in the repo is there for working on it, and none of it reaches your browser:

- `src/` is the TypeScript the two `dist/` files are built from. An automated scanner that only parses JavaScript cannot read these, and will say so; the shipped `dist/` files are plain JavaScript and parse normally.
- `test/` runs only when a contributor types `bun run check`. It is not part of the install and adds nothing to its size.
- `setup.sh` prepares a development machine. It is not run by anything at install time and nothing in the extension calls it.
- `.github/workflows/` runs the checks on pull requests. Its actions are pinned to commit hashes rather than to movable tags, and the checkout step keeps no credentials in the build environment.

CI rebuilds `dist/` from `src/` on every pull request and fails if the result differs from what is committed, so the readable files you are auditing cannot quietly drift from the source they claim to come from.

## What it can reach

What the extension touches, what it keeps, and what it has no way to get at is a longer answer and lives in [Privacy](docs/privacy.md).

---

[Back to the README](README.md)
