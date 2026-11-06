#!/usr/bin/env bash
# Deploy and seed a fresh DiveMarket economy on NEAR testnet, end to end.
#
#   bash scripts/deploy.sh <contract-account.testnet> <funder-account.testnet>
#
# <contract-account> must not exist yet; it is created from the testnet
# faucet. <funder-account> pays the NPC treasuries (3 NEAR) and the vault.
# Afterwards set the game server's secrets on Vercel: scripts/vercel-env.sh.
set -euo pipefail
C="${1:?contract account}"; FUNDER="${2:?funder account}"
N="near --networkId testnet"
cd "$(dirname "$0")/.."

echo "==> build + test"
cargo test -q
cargo build --target wasm32-unknown-unknown --release -q
WASM=target/wasm32-unknown-unknown/release/divemarket.wasm
# Without `--cfg near` (.cargo/config.toml) contract errors lose their message
# and show up as "unreachable". Refuse to ship such a build.
grep -q panic_utf8 "$WASM" || { echo "wasm has no panic_utf8 import: build without --cfg near"; exit 1; }

echo "==> account + code"
$N create-account "$C" --useFaucet
yes y | $N deploy "$C" "$WASM"

echo "==> game server key (secret stays in .secrets/, never printed)"
mkdir -p .secrets && chmod 700 .secrets
node -e '
const c=require("crypto"),fs=require("fs");
const {publicKey,privateKey}=c.generateKeyPairSync("ed25519");
const seed=privateKey.export({format:"der",type:"pkcs8"}).subarray(16),pub=publicKey.export({format:"der",type:"spki"}).subarray(12);
const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58=b=>{let n=BigInt("0x"+Buffer.from(b).toString("hex")),o="";while(n>0n){o=A[Number(n%58n)]+o;n/=58n}for(const x of b){if(x===0)o="1"+o;else break}return o};
fs.writeFileSync(".secrets/game-signer.json",JSON.stringify({public_key:"ed25519:"+b58(pub),secret_key:"ed25519:"+b58(Buffer.concat([seed,pub])),hmac:c.randomBytes(32).toString("hex")}),{mode:0o600});'
PUB=$(node -pe 'require("./.secrets/game-signer.json").public_key')
$N call "$C" new "{\"owner\":\"$C\",\"game_signer\":\"$C\"}" --accountId "$C"
$N call "$C" set_game_signer "{\"public_key\":\"$PUB\"}" --accountId "$C"

echo "==> fish (base 0.1 NEAR, scaled by rarity)"
for spec in "guppy Guppy 0 0" "tilapia Tilapia 1 0" "snapper Snapper 2 2" "tuna Tuna 3 0" "koi Legendary_Koi 4 3"; do
  set -- $spec
  $N call "$C" register_item "{\"id\":\"$1\",\"name\":\"${2//_/ }\",\"base_price\":\"100000\",\"rarity\":$3,\"utility\":$4}" --accountId "$C"
done

echo "==> zones + bait"
$N call "$C" register_zone '{"id":"shallows","name":"Shallows","capacity":600,"regen_per_hour":90,"base_fee":"8000000000000000000000","min_rod":0}' --accountId "$C"
$N call "$C" register_zone '{"id":"reef","name":"Coral Reef","capacity":300,"regen_per_hour":40,"base_fee":"40000000000000000000000","min_rod":1}' --accountId "$C"
$N call "$C" register_zone '{"id":"abyss","name":"The Abyss","capacity":120,"regen_per_hour":12,"base_fee":"70000000000000000000000","min_rod":2}' --accountId "$C"
$N call "$C" set_zone_bait '{"zone_id":"reef","item_id":"guppy"}' --accountId "$C"
$N call "$C" set_zone_bait '{"zone_id":"abyss","item_id":"tilapia"}' --accountId "$C"

echo "==> NPCs (each signs its own trades from its own sub-account)"
reg(){ $N call "$C" register_npc "{\"id\":\"$1\",\"name\":\"$1.$C\",\"treasury\":\"1000000000000000000000000\",\"personality\":$2}" --accountId "$C" --deposit 1; }
reg bob   '{"buy_tolerance_bps":1500,"sell_tolerance_bps":1000,"aggression_bps":4000,"reserve_bps":1000,"min_edge_bps":200}'
reg alice '{"buy_tolerance_bps":300,"sell_tolerance_bps":300,"aggression_bps":1500,"reserve_bps":5000,"min_edge_bps":500}'
reg john  '{"buy_tolerance_bps":800,"sell_tolerance_bps":1200,"aggression_bps":2500,"reserve_bps":2500,"min_edge_bps":100}'
for n in bob alice john; do
  $N create-account "$n.$C" --useAccount "$C" --initialBalance 0.3
  $N call "$C" fund_npc "{\"npc_id\":\"$n\"}" --accountId "$FUNDER" --deposit 2
done

echo "==> vault"
$N call "$C" fund_vault '{"_amount":"0"}' --accountId "$FUNDER" --deposit 1
$N view "$C" solvency '{}'

cat <<MSG

Done. Next:
  CONTRACT_ID=$C npm run npc                  # start the NPCs
  CONTRACT_ID=$C GAME_URL=<your game> npm run sim   # optional: the [sim] anglers
  bash scripts/vercel-env.sh                 # game server secrets on Vercel
  cd app && vercel deploy                    # preview
MSG
