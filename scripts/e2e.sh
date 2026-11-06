#!/usr/bin/env bash
# Build the test-only bundle, serve it, run the browser test, clean up.
#
#   E2E_ACCOUNT=<testnet account with a key in ~/.near-credentials> bash scripts/e2e.sh
#
# Needs playwright-core installed in $PW_DIR (default /tmp/pw) and a Chromium
# headless shell in ~/.cache/ms-playwright. The test wallet's key is baked
# into the e2e bundle only; the script fails if it ever reaches dist/.
set -u
cd "$(dirname "$0")/../app"
ACC=${E2E_ACCOUNT:-fisher.dm21.testnet}
PW_DIR=${PW_DIR:-/tmp/pw}
VITE_E2E_ACCOUNT=$ACC VITE_E2E_KEY=$(node -pe "require('/root/.near-credentials/testnet/$ACC.json').private_key") \
  npx vite build --mode e2e --outDir /tmp/e2e-dist --emptyOutDir > /tmp/e2e-build.log 2>&1 || { echo BUILD_FAILED; tail -20 /tmp/e2e-build.log; exit 1; }
TK=$(node -pe "require('/root/.near-credentials/testnet/$ACC.json').private_key.slice(8,30)")
npx vite build >/dev/null 2>&1; grep -l "$TK" dist/assets/*.js >/dev/null 2>&1 && { echo "TEST KEY IN PRODUCTION DIST"; exit 1; } || echo "production dist clean"
node e2e/server.mjs /tmp/e2e-dist 5190 > /tmp/e2e-server.log 2>&1 &
SRV=$!
sleep 2
cp e2e/run.mjs "$PW_DIR/e2e-run.mjs"
(cd "$PW_DIR" && timeout 900 node e2e-run.mjs "$ACC")
kill $SRV; rm -rf /tmp/e2e-dist "$PW_DIR/e2e-run.mjs"
echo E2E_DONE
