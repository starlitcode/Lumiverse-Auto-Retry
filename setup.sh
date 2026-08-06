#!/usr/bin/env bash
set -e

# 1. Remove the broken PPAs that are causing the 403 Forbidden / Exit Code 100 errors
echo "Cleaning up broken PPA lists..."
rm -f /etc/apt/sources.list.d/*deadsnakes* /etc/apt/sources.list.d/*ondrej* 2>/dev/null || sudo rm -f /etc/apt/sources.list.d/*deadsnakes* /etc/apt/sources.list.d/*ondrej* 2>/dev/null || true

# 2. Install Git if it's not already available.
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update || sudo apt-get update || true
    apt-get install -y git || sudo apt-get install -y git
  fi
fi

# 3. Install Node.js dependencies.
if [ -f package.json ]; then
  npm install
fi

# 4. Install Python dependencies.
if [ -f requirements.txt ]; then
  python3 -m pip install -r requirements.txt
fi

# 5. Install Python project defined by pyproject.toml.
if [ -f pyproject.toml ]; then
  python3 -m pip install -e .
fi

echo "✅ Setup complete."
