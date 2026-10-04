#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun install --frozen-lockfile
