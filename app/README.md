# DiveMarket — game client and game server

- `src/` — the React game. `game.js` holds the rules (fish, rods and their
  durability, bait, zones, seasons, weights, the vault bid) and is imported by
  the game server too, so the browser and
  the server never disagree. `Fishing.jsx` is the canvas scene; `Market.jsx`,
  `Zones.jsx` and `Endgame.jsx` are the panels. `contract.js` is the only file
  that talks to NEAR; `names.js` labels [sim] and [test] accounts.
- `api/` — Vercel functions. `cast.js` picks the bite time and checks on chain
  that the picked rod is owned and not worn out, and that the bait is in the
  hold; `strike.js` judges the timing, rolls the fish and weight, and signs a
  receipt naming the zone, bait and rod; `adopt.js` turns a guest's catch into
  receipts once the wallet owns a rod.
- `e2e/` — test-only: a wallet that signs with a throwaway testnet key, a
  local server that runs `api/` in-process, and a Playwright run that clicks
  the real UI. Used only by `vite build --mode e2e`.

```bash
npm install
npx vitest run          # rules tests
npx vite build          # production bundle in dist/
```

Environment: `VITE_CONTRACT_ID` (build), and for `api/`:
`GAME_SIGNER_SECRET`, `CAST_HMAC_SECRET`, `CONTRACT_ID`.
