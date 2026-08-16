#!/usr/bin/env bash
#
# Brings a fresh Claude Code environment up to where the repo can be worked on.
#
# Two things make this more than "install the deps". The sandbox cannot reach
# Launchpad, so any PPA left in the image takes apt down with exit 100 before
# anything useful runs. And every script in package.json goes through bun, so an
# environment without bun looks like it came up fine and then fails on the first
# command you type.
#
# Nothing here is fatal that does not have to be. A setup script that refuses to
# finish leaves no session to debug it from.

set -euo pipefail

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else echo "warn: root needed for: $*" >&2; return 1
  fi
}

# deadsnakes and ondrej answer 403 from inside the sandbox, and apt treats an
# unreachable source as an unsigned one and stops. Neither carries anything this
# project uses, so they go rather than get fixed.
as_root rm -f \
  /etc/apt/sources.list.d/*deadsnakes* \
  /etc/apt/sources.list.d/*ondrej* \
  /etc/apt/sources.list.d/*launchpad* || true

if ! command -v git >/dev/null 2>&1; then
  as_root apt-get update
  as_root apt-get install -y git
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun..."
  # npm first because node is already in the image. The errors from both are
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
  echo "error: bun is not installed and could not be." >&2
  echo "       registry.npmjs.org or bun.sh has to be reachable from the sandbox." >&2
  exit 1
fi

if [ -f package.json ]; then
  bun install
else
  echo "warn: no package.json in $PWD, so nothing was installed." >&2
  echo "warn: this script expects to run from the repo root." >&2
fi

# 'bun run check' is left for you to run once you are in. Gating the session on
# a green test suite means a failing test costs you the environment you would
# have fixed it from.
echo "Setup complete. bun $(bun --version)."
