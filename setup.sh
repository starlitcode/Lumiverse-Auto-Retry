#!/usr/bin/env bash
set -e

# Remove broken PPAs causing 403 Forbidden errors
echo "Cleaning up broken PPA lists..."
rm -f /etc/apt/sources.list.d/*deadsnakes* /etc/apt/sources.list.d/*ondrej* 2>/dev/null || sudo rm -f /etc/apt/sources.list.d/*deadsnakes* /etc/apt/sources.list.d/*ondrej* 2>/dev/null || true

# Install Git if missing
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update || sudo apt-get update || true
    apt-get install -y git || sudo apt-get install -y git
  fi
fi

# Install Node.js dependencies
if [ -f package.json ]; then
  npm install
fi

# Install Python dependencies
if [ -f requirements.txt ]; then
  python3 -m pip install -r requirements.txt
fi

# Install Python project defined by pyproject.toml
if [ -f pyproject.toml ]; then
  python3 -m pip install -e .
fi

echo "✅ Setup complete."
