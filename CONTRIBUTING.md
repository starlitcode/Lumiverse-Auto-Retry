# Contributing

Thank you for wanting to help with Auto Retry.

## Bug reports, not pull requests

Pull requests are not merged here. Every change to the code goes through me, for three reasons:

- The code stays clean and consistent.
- No code gets in that has not been checked for security.
- I do not have time to check every pull request closely.

What this means for you:

- Please do not spend your time, your limits or your AI usage writing a fix.
- A clear bug report is all I need. It helps me more than a pull request.
- If you already opened a pull request, it can still help me see the problem. It will not be merged.

Questions and ideas are welcome too.

## Where to send it

- Post in my [Auto Retry post](https://discord.com/channels/1484149939167821915/1514031700185714688) on the Lumiverse Discord server, or
- [open an issue](https://github.com/starlitcode/Lumiverse-Auto-Retry/issues).

For anything sensitive, such as a security problem, follow [SECURITY.md](SECURITY.md) instead.

## What to put in a bug report

I fix a bug from what the report says. If a report is short or vague, I cannot tell what went wrong or how to fix it. Please include:

1. How to make the problem happen again, step by step. Start from something everyone has, such as opening a chat, and list each thing you did in order. If it only happens sometimes, say how often.
2. What you expected to happen.
3. What happened instead. Copy any message word for word.
4. Whether you are on a phone or a computer, and which browser.

A screenshot or a screen recording is optional. It helps a lot, because I can see the problem for myself.

## The debug report

Auto Retry can build a report for you to paste in. You do not have to use it. It does help me see exactly what your problem is, because it shows your version, your settings and what the extension did.

1. Open the settings panel and find **Debug info**.
2. Tick the parts you want to include.
3. Press **Build preview**.
4. Read it, and take out anything you would rather keep private.
5. Press **Copy**, then paste it into your report.

Nothing leaves your device until you paste it. [Reporting a bug](docs/troubleshooting.md#debug-info) explains each part.

## The two branches

- `testing` gets every change first, including new and experimental features.
- `stable` is what most people install. It only moves when a version is released, so it can be behind `testing`.

If you installed from `testing`, say so in your report.

If you open a pull request anyway:

- Start from `testing`, and open the pull request against `testing`, not `stable`.
- Test your change on `testing`. `stable` can be behind `testing`, so a change that works on `stable` may not work on `testing`.
