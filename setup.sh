#!/usr/bin/env bash
set -euo pipefail

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else echo "warn: root needed for: $*" >&2; return 1
  fi
}

# Launchpad is unreachable from the sandbox, so these PPAs 403 and take
# apt-get update down with exit 100. Nothing here needs them.
as_root rm -f \
  /etc/apt/sources.list.d/*deadsnakes* \
  /etc/apt/sources.list.d/*ondrej* \
  /etc/apt/sources.list.d/*launchpad* || true

if ! command -v git >/dev/null 2>&1; then
  as_root apt-get update
  as_root apt-get install -y git
fi

# bun is the toolchain: every script in package.json runs through it.
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun..."
  npm install -g bun || curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

command -v bun >/dev/null 2>&1 || {
  echo "error: bun could not be installed. Check that registry.npmjs.org or bun.sh is reachable." >&2
  exit 1
}

bun install
bun run check

echo "Setup complete. bun $(bun --version), $(git rev-parse --abbrev-ref HEAD)."
