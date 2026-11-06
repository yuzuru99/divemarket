# DiveMarket NPC engine

Bob, Alice and John are NEAR accounts (`bob.<contract>` …) with treasuries
held by the contract. This engine is their brain: every tick it reads public
views, decides, and signs one action from the NPC's own account.

## Roles

| NPC | Role | Standing orders (reposted as soon as they fill) | Shelf (resold at cost +12% or more) | Weekly order |
|---|---|---|---|---|
| Bob | Canteen & bait shop | guppy, tilapia at fair +5% | guppy, tilapia (bait) | tuna; 10 at +20% in a tuna run |
| Alice | Collector | koi at +10% (4 in a koi run), snapper at +5% | koi, snapper | — |
| John | Shipwright supplier | snapper at +5% | snapper (rods, docks) | tilapia; more in a storm week |

The spread between what a shop pays (fair +5%) and what it sells for (cost
+4% to +12%) is its profit. Each shop has a shelf cap per fish (Bob: 30 guppy,
30 tilapia, 10 tuna; Alice: 4 koi, 15 snapper; John: 25 snapper, 15 tilapia)
and stops buying when it is full; order sizes follow what players bought from
it in the last seven days (about 1.5x, at least 5). The margin is 12% up to
half a shelf and slides to 4% when full. Staples are never dumped below cost, so a shop
that buys a lot simply waits for players who need bait or crafting fish. That
profit is what NPC investors are paid from.

Personalities (tolerance, aggression, reserve) are stored on chain at
registration; the engine reads them but cannot change them.

## Actions

| Action | Contract call | What the contract enforces |
|---|---|---|
| Buy a player's listing | `npc_buy` | price within +20% of fair, reserve kept, rate limit |
| Post or update an ask | `npc_sell` | ask not more than 30% below fair; no money moves until a player pays it |
| Post a standing or weekly order | `npc_post_order` | one order per NPC per fish, at most 4; price between fair and +20%; escrow locked from the treasury |

The engine cannot change prices (fair price is a pure function of on-chain
counters), cannot spend beyond the treasury, and cannot move funds out: every
payout path is a contract method with its own checks.

## Brain: NEAR AI Cloud

`brain.mjs` asks a model on NEAR AI Cloud (`https://cloud-api.near.ai/v1`,
OpenAI-compatible) every 30-50 minutes per NPC (a random gap each time), with the season, fair prices, the
NPC's shelf, treasury and last week's sales. The model answers with a premium
and a size per fish, and a one-line note for players. The answer is advice:
`sanitizePlan` keeps only the NPC's own fish and clamps every number,
`boundPlan` caps sizes by shelf room and demand, and the contract still checks
price bands and escrow. The note is posted on chain with `npc_post_note`,
labelled `near-ai`; without a key, or on any error, the NPC uses its rules and
labels its note `rules`.

| Variable | Default | Meaning |
|---|---|---|
| `NEAR_AI_API_KEY` | read from `.secrets/near-ai.key` | NEAR AI Cloud key |
| `NEAR_AI_MODEL` | `z-ai/glm-5.3-flash` | model (`z-ai/glm-5.3` for the larger one) |
| `GAP_MIN_MS` / `GAP_MAX_MS` | 1800000 / 3000000 | random range for how often each NPC re-plans and posts a radio note |

The engine also sweeps vault holdings above 10 NEAR into the weekly
tournament pot once an hour.

Every 10 minutes it checks each NPC account's own balance, which pays the
NPC's gas. An account below `GAS_FLOOR_NEAR` (0.3) gets `GAS_TOP_UP_NEAR` (1)
from `GAS_FUNDER` (the contract account by default). If the funder itself is
below `GAS_FUNDER_FLOOR_NEAR` (3), the engine stops sending and logs a
warning so the funder can be topped up by hand.

## Keys

The engine signs with the NPC accounts' keys from the local NEAR credentials
directory (`NEAR_KEYSTORE`, default `~/.near-credentials`). For a production
deployment the owner can add a function-call key scoped to the contract with
`issue_agent_key` and remove the full-access key, so a compromised engine host
can only trade within the limits above.

## Files

| File | Purpose |
|---|---|
| `decide.mjs` | Pure decisions: `decide` (buy / ask / hold, with the shop margin) and `planOrders` (which standing and weekly orders to post). No network, no keys. |
| `engine.mjs` | Reads views, calls `decide` / `planOrders`, signs and sends one action per NPC per tick. |
| `brain.mjs` | NEAR AI Cloud planning: prompt, call, `sanitizePlan`, and the rule fallback note. |
| `test-decide.mjs` | 51 offline assertions: pricing, personalities, reserve, roles, orders, shelf caps, margin decay, AI parsing. |

## Run

```bash
npm test                                         # offline tests (repo root)

CONTRACT_ID=dm21.testnet TICK_MS=60000 node npc/engine.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `CONTRACT_ID` | `dm21.testnet` | contract to trade against |
| `NEAR_NETWORK` | `testnet` | network |
| `NEAR_NODE_URL` | `https://test.rpc.fastnear.com` | RPC endpoint |
| `NEAR_KEYSTORE` | `~/.near-credentials` | where the NPC keys live |
| `TICK_MS` | — | delay between ticks |
| `ONCE` | — | run a single tick and exit |
