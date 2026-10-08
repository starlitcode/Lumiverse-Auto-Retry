#!/usr/bin/env bash
#
# Brings a fresh environment up to where the repo can be worked on.
#
# Two things make this more than "install the deps". A sandbox that cannot reach
# Launchpad takes apt down with exit 100 before anything useful runs, so any PPA
# left in the image is removed rather than fixed. And every script in
# package.json goes through bun, so an environment without bun looks like it
# came up fine and then fails on the first command you type.
#
# Nothing here is fatal that does not have to be. A setup script that refuses to
# finish leaves no session to debug it from, so every step that can be skipped
# reports and carries on, and only a missing bun stops it.

set -uo pipefail

note() { echo "$*"; }
warn() { echo "warn: $*" >&2; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else warn "root needed for: $*"; return 1
  fi
}

# deadsnakes and ondrej answer 403 from inside a sandbox, and apt treats an
# unreachable source as an unsigned one and stops. Neither carries anything this
# project uses, so they go rather than get fixed.
as_root rm -f \
  /etc/apt/sources.list.d/*deadsnakes* \
  /etc/apt/sources.list.d/*ondrej* \
  /etc/apt/sources.list.d/*launchpad* || true

# git is how the repo got here in most environments, so a missing one is worth
# trying to fix and not worth stopping over.
if ! command -v git >/dev/null 2>&1; then
  as_root apt-get update || warn "apt-get update failed, carrying on"
  as_root apt-get install -y git || warn "could not install git"
fi

if ! command -v bun >/dev/null 2>&1; then
  note "Installing bun..."
  # npm first because node is already in most images. The errors from both are
  # left visible: when this fails, the reason it failed is the whole message.
  npm install -g bun || curl -fsSL https://bun.sh/install | bash || true

  # Either installer can land bun somewhere the session's PATH does not look,
  # which reads as "bun failed to install" further down and sends you hunting
  # the wrong problem. Link whichever copy exists into a directory that is
  # always on PATH.
  for candidate in "${HOME:-/root}/.bun/bin/bun" "$(npm prefix -g 2>/dev/null)/bin/bun"; do
    if [ -x "$candidate" ] && ! command -v bun >/dev/null 2>&1; then
      as_root ln -sf "$candidate" /usr/local/bin/bun || true
    fi
  done
fi

if ! command -v bun >/dev/null 2>&1; then
  warn "bun is not installed and could not be."
  warn "registry.npmjs.org or bun.sh has to be reachable from here."
  exit 1
fi

if [ -f package.json ]; then
  bun install || warn "bun install did not finish; 'bun run check' will say what is missing"
else
  warn "no package.json in $PWD, so nothing was installed."
  warn "this script expects to run from the repo root."
fi

# What the browser checks will find when they run. They are the one tier that
# needs something outside the repo, and the two ways they go wrong are quiet
# ones: Playwright absent, which skips them, or a browser present under a name
# Playwright does not look for, which used to skip them too. Said here so the
# answer is known before a run rather than guessed at after one.
if [ -f test/ui.mjs ]; then
  if bun -e 'import("playwright").then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null; then
    found=""
    if [ -n "${CHROMIUM_PATH:-}" ] && [ -x "${CHROMIUM_PATH}" ]; then
      found="$CHROMIUM_PATH"
    elif [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
      found="$(find "$PLAYWRIGHT_BROWSERS_PATH" -maxdepth 3 -type f \
        \( -name chrome -o -name 'Chromium' -o -name 'chrome.exe' \) 2>/dev/null | head -1)"
    fi
    if [ -n "$found" ]; then
      note "Browser checks: ready, using $found"
    else
      note "Browser checks: playwright is here but no browser is."
      note "  bunx playwright install chromium"
    fi
  else
    note "Browser checks: playwright is not installed, so 'bun run test:ui' will skip them."
    note "  bun add -d playwright && bunx playwright install chromium"
  fi
fi

# Every date and time on this project is US Eastern, and a commit takes its
# time from TZ. The machine runs on UTC, so the shells this environment opens
# are told to use Eastern. Setting TZ in the environment's own settings does
# the same for every process, and is the surer of the two.
if [ -z "${TZ:-}" ]; then
  for rc in "${HOME:-/root}/.bashrc" "${HOME:-/root}/.profile"; do
    if [ -f "$rc" ] || [ "$rc" = "${HOME:-/root}/.bashrc" ]; then
      grep -q 'export TZ=America/New_York' "$rc" 2>/dev/null || \
        printf '\n# Commits and dates on this project are US Eastern.\nexport TZ=America/New_York\n' >> "$rc"
    fi
  done
  note "Time zone: shells will use America/New_York. Set TZ=America/New_York in the environment's variables to cover every process."
fi

# Lumiverse's own source, for checking how the host really behaves and for
# scripts/engine-themes.ts. Shallow, outside the repo, and skipped quietly when
# GitHub cannot be reached.
lumi="${LUMIVERSE_SRC:-${HOME:-/root}/lumiverse-src}"
if [ ! -d "$lumi/.git" ]; then
  if git clone -q --depth 1 https://github.com/prolix-oc/Lumiverse "$lumi" 2>/dev/null; then
    note "Lumiverse source: cloned to $lumi"
  else
    warn "could not clone the Lumiverse source to $lumi; checks against the host's code will need it cloned by hand"
  fi
else
  git -C "$lumi" pull -q --ff-only 2>/dev/null && note "Lumiverse source: updated in $lumi" || note "Lumiverse source: $lumi (not updated)"
fi

# Work happens on testing. A session can start on a branch of its own, and
# the rules in CLAUDE.md say not to work there.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" != "testing" ]; then
    warn "on branch '$branch'. Work happens on testing: git checkout testing"
  fi
fi

# dist is committed and is what Lumiverse loads, so it has to be what src
# builds to. Built into a scratch folder and compared, so nothing in the repo
# changes here.
if [ -f tsconfig.frontend.json ] && [ -d dist ] && [ -d node_modules/typescript ]; then
  scratch="$(mktemp -d)"
  if bunx tsc -p tsconfig.frontend.json --noEmit false --rootDir src --outDir "$scratch" >/dev/null 2>&1 &&
     bunx tsc -p tsconfig.backend.json --noEmit false --rootDir src --outDir "$scratch" >/dev/null 2>&1; then
    stale=""
    for f in "$scratch"/*.js; do
      cmp -s "$f" "dist/$(basename "$f")" || stale="$stale $(basename "$f")"
    done
    if [ -n "$stale" ]; then
      warn "dist does not match src ($stale ). Run 'bun run build' and commit both."
    else
      note "dist: matches src."
    fi
  else
    warn "src did not build; 'bun run check' will say why."
  fi
  rm -rf "$scratch"
fi

note "Browser checks: 'bun run test:ui' runs them all, 'bun run test:ui:only \"name\"' runs the sections whose title holds that name."

# 'bun run check' is left for you to run once you are in. Gating the session on
# a green test suite means a failing test costs you the environment you would
# have fixed it from.
note "Setup complete. bun $(bun --version)."
