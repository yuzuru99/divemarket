# DiveMarket

**A fishing game whose whole economy lives on NEAR: a finite sea, NPC traders
with real treasuries, and an endgame where players run the fishing zones.**

Built at NEAR HACKATHON — tracks: **Games With Real Economies** (primary),
Agent Economy, Social Money.

- **Play:** https://dist-swart-nu-14.vercel.app (NEAR testnet; no wallet needed to start fishing)
- **AI agents:** the NPC shopkeepers plan with NEAR AI Cloud and publish their reasoning on chain
- **Contract:** [`dm21.testnet`](https://testnet.nearblocks.io/address/dm21.testnet)
- **NPC accounts:** `bob.dm21.testnet`, `alice.dm21.testnet`, `john.dm21.testnet`

---

## The game in one minute

Open the page and click the water. A fish bites; click again inside the
strike window. Guests fish the Shallows with a loaner rod; to bring the catch
ashore, buy a Bamboo Rod for 0.1 NEAR. Then land fish, sell them, buy or craft
a better rod, keep it repaired, pick your bait, and fish deeper water.

What makes it more than a mini-game is that **the sea is shared and finite**:

- Every zone has an on-chain fish population that regrows slowly. Each fish
  you claim comes out of it, and the license per fish rises as the zone thins
  out. Overfishing is self-limiting.
- **Harbor masters** stake NEAR to run a zone and earn 30% of its licenses —
  only while the zone stays above 50% health. They can raise the fee, close the
  zone to let it recover, and build docks to make it bigger.
- Three **NPCs** trade with their own NEAR treasuries, each with a role: Bob
  runs the canteen and bait shop, Alice collects koi, John supplies the
  shipyard. Each keeps standing buy orders backed by escrow (Bob always buys
  guppy and tilapia, so his bait shelf never stays empty; Alice buys koi;
  John buys snapper), reposted as soon as they fill, plus one seasonal order
  a week. Staple orders pay fair +5%, and staples go back on the shelf at
  cost +12% at least: that spread is each shop's profit, and what its
  investors are paid from.
- The NPCs are **AI agents with wallets**. Once an hour each asks a model on
  **NEAR AI Cloud** how to run its shop this week (what premium to pay, how
  much to stock) and posts a one-line market note on chain from its own
  account. The model only advises: its answer is clamped to the NPC's own
  fish, its shelf room and its recent sales, and the contract still enforces
  every price band, reserve and escrow. Without an API key the NPCs run on
  their rules and their notes say so.
- The sea changes every week on its own: **calm, storm, koi run, tuna run**.

Progression: **angler** (Shallows, Bamboo Rod) → **captain** (Carbon or
Spinner Rod, Reef with guppy bait, records, tournaments) → **deep-water
captain** (Master Rod or Harpoon, Abyss with tilapia) → **harbor master** (run a
zone, build docks, back or be backed by a crew). At the top sits the
**Legendary Rod**, never sold: crafted only by anglers with a koi trophy on
the wall and a 30 kg tuna to their name.

## Try it — do X, see Y

| Do | See |
|---|---|
| Open the game, click the water, click again when the bobber dunks | A fish with a weight lands in your cooler (as a guest, kept in the browser) |
| Click too early | "Too early — you spooked it" |
| Connect a testnet wallet, then **Buy Bamboo Rod · 0.1 NEAR** | Your guest catch moves to your account |
| **Keep in inventory** | One transaction claims every fish; `holdings` rises on chain |
| Pick **Coral Reef** without a tier-1 rod | The card is locked: rods are bought or crafted on chain (`acquire_rod`) |
| Fish the Reef with no guppy | Refused: the Reef needs guppy or better as bait, burned one per fish |
| Pick **Tilapia** as bait in the Shallows | Optional there: +20% rare odds and +20% weight, one tilapia burned per fish |
| Rods → **Craft** the Carbon Rod | 12 snapper are burned and the rod is yours |
| Market → **Sell to vault (N%)** | NEAR arrives at the vault's current bid (75% of fair when its reserve is full); the fair price ticks down (▼) |
| Fish until a rod's bar runs red, then **Repair** | 85% of the NEAR goes to the vault and 15% to this week's tournament pot — or pay in fish instead |
| Market → **Buy 1** from the cheapest NPC | The NPC's stock drops and its treasury rises |
| Market → Player listings → **Buy 1** | The fish is yours and the seller is paid directly |
| Market → **Fill** an NPC order | Paid from the order's escrow; the NPC's stock rises |
| Weekly tournament → **Enter for 0.1 NEAR**, then fish | Your heaviest fish per zone appears as leader |
| Trophy room → **Mount a koi** | Koi burned; your license discount rises 5% |
| Harbor masters → **Stake 1.000** on a vacant zone | You run it; licenses start accruing to you |
| As harbor master, **Close** the zone; as someone else, tick **Poach** and fish it | Poached fish pay a 3× license fine to the harbor master |
| `near view dm21.testnet solvency '{}'` | `solvent: true`: the contract holds everything it owes |

## The economy

Every NEAR that leaves the contract was put in by someone. `solvency()` checks
it live, and the Market page shows it.

| Money in | Money out |
|---|---|
| Catch fee + zone licenses (Shallows 0.008, Reef 0.04, Abyss 0.07 per fish, up to 10x as a zone thins) → vault (30% to the harbor master while the zone is healthy) | Vault pays players who sell straight to it at 75% of fair × min(1, vault / 5 NEAR): the bid shrinks as the reserve runs low, so heavy selling can never drain it, and NPC orders stay the better outlet |
| Rod repairs → 85% vault, 15% tournament pot | Vault holdings above 10 NEAR → this week's tournament pot (`sweep_vault_surplus`, anyone may call it) |
| Rod purchases → vault | NPC treasuries pay players whose listings they buy, and fill orders from escrow |
| Players buying NPC stock → NPC treasury | Harbor masters and their crews withdraw their license share |
| Tournament tickets → weekly pot | Each zone's heaviest fish splits the pot (5% to the vault) |
| Poaching fines → harbor master | Investors take a 30% pool of NPC profit, pro rata |

**Prices** are a pure function of on-chain counters: NPC buying pushes a fish's
fair price up; listings, vault sales and NPC stock push it down; the pressure
fades every hour. No admin, oracle or AI sets a price.

**Sinks** that keep fish scarce: bait burned per baited catch, fish burned to
craft and repair rods, koi mounted as trophies or released into zones, snapper
burned for docks, and a daily cap of 80 fish per account (100 with a complete
Fishdex).

**What a fish costs, and what it pays:** licenses and rod wear take roughly a
third of a Shallows fish's value, two fifths on the Reef and half in the Abyss
(bait included). The rest is the angler's margin: about 0.01 NEAR a fish in the
Shallows, 0.05 on the Reef and 0.06 in the Abyss at the vault's full bid, more
through NPC orders. Licenses are what refill the vault as people fish.

**Fish supply** is on chain and goes both ways. Fish enter only when someone
catches one, out of a zone's finite, slowly regrowing population. They leave
for good as bait, rod crafting and repairs, docks, koi trophies and releases,
and sales to the vault, which keeps no fish. `supply()` shows caught, burned
(by sink) and circulating for every fish. Each zone's regrowth follows its
staple fish: when guppy in circulation passes 400 (tilapia 300 for the Reef,
tuna 150 for the Abyss), that zone regrows more slowly, down to a quarter of
its rate, until the glut clears.

**Why nobody goes broke:** the vault bids less as its reserve thins, and gives
anything above 10 NEAR back to players through the tournament pot. A shop
stops buying a fish once its shelf is full (Bob holds at most 30 guppy), sizes
its orders to what players bought from it last week, and never sells below
cost: its margin slides from 12% to 4% as stock piles up, so old stock still
sells at a profit.

**Why it does not inflate:** NEAR only leaves the contract as a payment from
someone who put it in — the vault from fees, licenses, rod sales and repairs;
NPCs from their own treasuries; pots from tickets. Players who fish well are
paid by players who spend (rods, repairs, licenses, bait, shop markups) and by
NPC investors, never by newly created NEAR.

## Features

| Feature | How it works |
|---|---|
| Zones | `register_zone`; population regrows per hour; license = base × capacity / population (≤10×) |
| Rods | `acquire_rod(rod_id, craft)`: buy (NEAR → vault) or craft (fish burned). Bamboo 0.1 NEAR (tier 0, everyone's first rod, 100 durability). Tier 1: Carbon (1.5 NEAR or 12 snapper, 200), Spinner (1.5 NEAR or 8 snapper + 5 tilapia, +15% weight, 150). Tier 2: Master (6 NEAR or 25 snapper + 3 tuna, 250), Harpoon (6 NEAR or 4 tuna + 1 koi, +30% weight, 200), Legendary (craft only: 5 tuna + 2 koi, plus a mounted trophy and a 30 kg tuna record, 600). Each receipt names its rod; every fish landed costs durability (tuna and koi 3), and a worn-out rod casts again only after `repair_rod` (NEAR: 85% vault, 15% this week's tournament pot; or fish, burned). `rod_status` shows what is left |
| Bait | Tiers: guppy 1 (+10% rare, +10% weight), tilapia 2 (+20%, +20%). `set_zone_bait` sets a zone's minimum: Reef guppy, Abyss tilapia; better bait is always accepted. The bait is part of the signed receipt and burned at claim |
| Weights & records | Weight is signed with the catch; `personal_best`, `records` |
| Trophies | `mount_trophy` (−5% license each, max −50%) or `release_koi` (+20 fish to a zone) |
| Tournament | `enter_tournament`, `settle_tournament(week)` — anyone can pay out a finished week |
| Seasons | `current_season` = week number mod 4; the game server and NPCs use the same formula |
| Docks | `build_dock`: harbor master burns 20 snapper, zone capacity +10% (max 10 docks) |
| Player market | `list_fair` puts fish up for 30 minutes; `buy_listing(index, units, max_price)` lets another player buy them, paid straight to the seller; NPCs buy from the same listings when the price suits them |
| Supply | `supply()`: caught, burned (bait, rods, vault, docks, koi) and circulating per fish; `regen_factor_bps(zone)` |
| NPC notes | `npc_post_note(npc_id, text, source)` from the NPC's own account (source `near-ai` or `rules`); `npc_notes`, and `world_state.notes` |
| NPC orders | One per NPC per fish, up to 4 each. `npc_post_order` locks escrow; `fill_order(npc_id, item_id, units)` pays from it; `expire_order` returns it |
| Fishdex | Land all 5 species once: +20 daily catches (100 instead of 80), permanently |
| Poaching | Closed zones accept only receipts signed as poached; each pays 3× license to the harbor master |
| Crew | `back_steward`: stake behind a harbor master, share its earnings pro rata, refunded when it leaves |
| NPC investing | `invest`, `claim_profit`, `withdraw_principal` |

## How NEAR is used

- **One contract holds the whole economy** — fish holdings, zone populations,
  NPC treasuries, escrow, pots and stakes — so every player audits the same sea.
- **NPCs are AI agents with real accounts** (`bob.dm21.testnet` …) that sign their own trades
  and notes. Their plans come from NEAR AI Cloud (OpenAI-compatible API), bounded twice:
  by the engine (own fish only, shelf caps, recent demand) and by the contract.
  The contract bounds what they may do (price bands, reserve, rate limit), so a
  misbehaving decision engine cannot overspend or misprice.
- **Catches are signed receipts.** The game server decides each catch and signs
  `catch:<contract>:<player>:<zone>:<fish>:1:<nonce>:<grams>[:poached][:bait:<fish>][:rod:<rod>]`; the
  contract verifies it with the runtime's `ed25519_verify` and spends the nonce
  once, globally.
- **Batched settlement:** a session of fishing is one `claim_catches`
  transaction, so playing costs no gas per cast.

## Anti-cheat

| Attack | Defence |
|---|---|
| Edit the catch in the browser | The server rolls the fish and weight; the receipt is signed |
| Claim a guppy receipt as a koi, or a heavier fish | Species, zone and weight are inside the signature |
| Re-send a strike to reroll | The roll is seeded from the cast; same cast, same result |
| Replay a receipt, or adopt one guest catch into two accounts | Nonces are spent once across all players |
| Fake a better rod, or dodge wear | The server checks the picked rod against `rod_status`; the rod is in the signed receipt, and the contract checks ownership and applies the wear |
| Claim bait you did not burn | The bait is in the signed receipt; the contract burns it or rejects the claim |
| Run 100 bots in parallel | Each account needs its own paid rod, and lands at most 80 fish a day, enforced on chain |
| Drop the poached flag | It is part of the signed message |

## Architecture

```
browser (React, app/)          game server (Vercel functions, app/api/)     NEAR testnet
  fishing scene  ── cast ──▶     /api/cast   reads rod, zone, bait, season   dm21.testnet
                 ◀─ bite time                                               (contract/)
                 ── strike ─▶    /api/strike judges timing, rolls fish,
                 ◀─ signed receipt          signs it
                 ── claim_catches(receipts) ─────────────────────────────▶  verifies, spends nonces,
  market, zones,                                                            moves population, pays licenses
  trophies, cups ◀─ world_state / player_state (2 view calls per refresh)
                                  NPC engine (npc/, Node)  ── npc_buy / npc_sell / npc_post_order ─▶
                                  sim anglers (sim/, Node) ── /api/cast, /api/strike, then their own txs ─▶
```

## Repository

```
contract/            Rust contract (near-sdk 5)
  src/lib.rs         economy, zones, rods, NPCs, orders, tournament, records, crew
  tests/economy.rs   133 tests
app/                 React game + Vercel functions
  src/               game.js (rules shared with the server), Fishing.jsx (scene),
                     Market.jsx, Zones.jsx, Endgame.jsx, App.jsx
  api/               cast.js, strike.js, adopt.js, _lib.js (signing)
  e2e/               test-only browser run (test wallet, local server, Playwright)
npc/                 NPC engine: decide.mjs (pure rules), brain.mjs (NEAR AI Cloud),
                     engine.mjs (signs and sends)
sim/                 anglers.mjs: the five [sim] players
scripts/             deploy.sh (fresh economy), vercel-env.sh (server secrets),
                     e2e.sh (browser run), run-bots.sh (NPCs + sims)
.cargo/config.toml   builds the wasm with `--cfg near` (see below)
```

## Run it

```bash
# contract
cargo test                                   # 133 tests
cargo build --target wasm32-unknown-unknown --release
# .cargo/config.toml adds `--cfg near`: without it near-sdk 5.30 compiles every
# require!/panic into a bare "unreachable" trap and errors lose their message.
# scripts/deploy.sh refuses a wasm built without it.

# fresh deployment on testnet (creates the account from the faucet)
bash scripts/deploy.sh my-divemarket.testnet my-funder.testnet

# NPCs and simulated anglers (repo root: npm install once)
CONTRACT_ID=my-divemarket.testnet npm run npc
CONTRACT_ID=my-divemarket.testnet GAME_URL=https://your-game.vercel.app npm run sim
npm test                                     # 53 NPC tests, offline
# NPC brains: put a NEAR AI Cloud key in .secrets/near-ai.key (or NEAR_AI_API_KEY);
# NEAR_AI_MODEL picks the model. No key: the NPCs run on rules.

# game
cd app && npm install
npx vitest run                               # 17 tests
VITE_CONTRACT_ID=my-divemarket.testnet npx vite   # UI; /api needs `vercel dev` or e2e/server.mjs
```

The game server needs `GAME_SIGNER_SECRET`, `CAST_HMAC_SECRET` and
`CONTRACT_ID`; `scripts/vercel-env.sh` sets them on Vercel from `.secrets/`
without printing them.

**End-to-end:** `app/e2e/run.mjs` drives the real UI in headless Chromium
against testnet — fish, claim, rod wear, list, cancel, sell, buy, fill an
order, invest, buy a Bamboo Rod, fish with bait, repair — and checks each
effect on chain (`bash scripts/e2e.sh`). It uses a test-only wallet
that exists only in the `e2e` Vite mode; production builds never include it.

## Simulated anglers

`sim/anglers.mjs` runs five clearly labelled bot players (`dmsim-*.testnet`,
shown as **[sim]** in the UI) so the testnet economy has traffic: a grinder
working toward the Reef, a casual Shallows angler, a record hunter with a
Spinner Rod, a harbor master holding the Shallows, and a trader who invests in
Bob and Alice and buys bait from Bob's shelf. They play through the same public
game server as everyone else (their strikes are judged like anyone's, with a
skill-based timing spread), pay for rods, licenses and repairs, fill NPC
orders first, and sell to the vault only when it bids well. They were funded
from the testnet faucet. `scripts/run-bots.sh` starts them and the NPC engine
if either is down.

## Hackathon notes

- Everything in this repository was written during the hackathon window
  (from the announcement on 2026-10-19).
- Libraries: near-sdk, near-api-js, @near-wallet-selector, React, Vite;
  Playwright for the e2e run. Built with help from AI coding assistants.
- Testnet only. NPC treasuries and the vault are small, so prices are small.

## License

MIT — see [LICENSE](LICENSE).
