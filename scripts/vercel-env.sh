#!/usr/bin/env bash
# Set the game server's environment on Vercel, reading secrets from the local
# .secrets file so they never appear on screen or in shell history.
# Run from /root/divemarket:   bash scripts/vercel-env.sh
set -euo pipefail
cd "$(dirname "$0")/../app"
S=../.secrets/game-signer.json
[ -f "$S" ] || { echo "missing $S"; exit 1; }
put() { for target in preview production; do
  # --yes applies a preview variable to every preview branch without a prompt.
  printf '%s' "$2" | vercel env add "$1" --environment "$target" --yes --force >/dev/null 2>&1 \
    && echo "set $1 ($target)" || echo "FAILED $1 ($target)"
done; }
put GAME_SIGNER_SECRET "$(node -e "process.stdout.write(require('$PWD/$S').secret_key)")"
put CAST_HMAC_SECRET  "$(node -e "process.stdout.write(require('$PWD/$S').hmac)")"
put CONTRACT_ID dm21.testnet
put VITE_CONTRACT_ID dm21.testnet
echo "done. preview deploy:  cd app && vercel deploy"
