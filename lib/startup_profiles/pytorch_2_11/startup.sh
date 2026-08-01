#!/usr/bin/env bash
set -Eeuo pipefail

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi
npm install -g --bin-links=true @openai/codex@latest @anthropic-ai/claude-code@latest
