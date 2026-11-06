/**
 * Offline test of the NPC decision function.
 *
 * Runs the real `decide` against synthetic market states and asserts the
 * personalities actually diverge. No network, no keys, no broadcast.
 *
 *   node npc/test-decide.mjs
 */

import { decide as decideWithRoles, fairPriceOf, PERSONALITIES, ROLES, planOrder, planOrders, SHOP_MARGIN_BPS } from './decide.mjs';
// The personality tests below exercise tolerance and reserve logic on a
// generic item, so they run without roles. Roles have their own tests.
const decide = (a, b, c, d) => decideWithRoles(a, b, c, d, {});

let pass = 0;
let fail = 0;

function fmt(obj) {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const baseItem = {
  id: 'fish',
  name: 'Fish',
  base_price: '1000000',
  rarity: 0,
  utility: 0,
  listed_supply: 0,
  npc_buy_volume: 0,
  npc_sell_volume: 0,
  // Players have been buying from NPCs, so there is real demand to sell into.
  player_buy_volume: 10,
  event_modifier_bps: '10000',
  event_label: 'normal',
  window_start_ns: '0',
  total_minted: 0,
};

function item(overrides = {}) {
  return { ...baseItem, ...overrides };
}

const npcWith = (inventory) => emptyNpc({ inventory });

const emptyNpc = (over = {}) => ({
  id: 'bob',
  name: 'bob.divemarket-test.testnet',
  // 100 NEAR, so even Alice's 15% aggression and 50% reserve leave enough
  // budget for the small orders these tests use.
  treasury: '100000000000000000000000000',
  inventory: [],
  realized_profit: 0,
  trades: 0,
  window_trades: 0,
  window_start_ns: '0',
  agent_keys: [],
  ...over,
});

const listing = (over = {}) => ({
  seller: 'player.near',
  item_id: 'fish',
  units: 10,
  ask_price: '100000',
  fair_at_list: '1000000',
  created_ns: '0',
  active: true,
  ...over,
});

// --------------------------------------------------------------- pricing

console.log('\npricing engine:');
// A common item is priced at 0.1x base (rarity multiplier).
check('base price with no activity', fairPriceOf(item()) === 100_000n);
check(
  'buy volume raises price',
  fairPriceOf(item({ npc_buy_volume: 20 })) > 100_000n
);
check(
  'listed supply lowers price',
  fairPriceOf(item({ listed_supply: 40 })) < 100_000n
);
check(
  'event modifier doubles price',
  fairPriceOf(item({ event_modifier_bps: '20000' })) === 200_000n
);
check(
  'price never reaches zero',
  fairPriceOf(item({ listed_supply: 100_000, npc_sell_volume: 100_000 })) >= 1n
);

// ----------------------------------------------------------- personalities

console.log('\npersonality divergence:');

// A listing at 10% above fair. Bob (15% tolerance) buys, Alice (3%) does not.
const itemsWith = (over) => [item(over)];
const items = [item()];
const listings = [[0, listing({ ask_price: '110000' })]];

const bobDecision = decide('bob', emptyNpc(), items, listings);
const aliceDecision = decide('alice', emptyNpc(), items, listings);
const johnDecision = decide('john', emptyNpc(), items, listings);

check('Bob buys at +10% (tolerance +15%)', bobDecision.action === 'BUY', fmt(bobDecision));
check('Alice holds at +10% (tolerance +3%)', aliceDecision.action === 'HOLD', fmt(aliceDecision));
check('John holds at +10% (tolerance +8%)', johnDecision.action === 'HOLD', fmt(johnDecision));

// A listing at 5% above fair. Alice now buys too.
const listings5 = [[0, listing({ ask_price: '105000' })]];
check(
  'Alice holds at +5% (tolerance +3%)',
  decide('alice', emptyNpc(), items, listings5).action === 'HOLD'
);
const listings2 = [[0, listing({ ask_price: '102000' })]];
check(
  'Alice buys at +2% (tolerance +3%)',
  decide('alice', emptyNpc(), items, listings2).action === 'BUY'
);
const listings6 = [[0, listing({ ask_price: '105000' })]];
check(
  'John buys at +5% (tolerance +8%)',
  decide('john', emptyNpc(), items, listings6).action === 'BUY'
);

// --------------------------------------------------------------- selling

console.log('\nsell logic:');

// Bob holds fish bought at 1.0, fair is now 1.2 — a 20% edge, above his 2% min.
const holdingNpc = emptyNpc({
  inventory: [{ item_id: 'fish', units: 10, unit_cost: '100000' }],
});
const richItems = [item({ npc_buy_volume: 20 })]; // pushes fair up
const sellDecision = decide('bob', holdingNpc, richItems, []);
check('Bob sells when edge clears his minimum', sellDecision.action === 'SELL', fmt(sellDecision));

// Alice holds the same lot but needs a 5% edge. With fair well above cost
// the edge clears her minimum too, so she also sells — the divergence shows
// up on *smaller* edges, which is the next check.
const aliceSell = decide('alice', holdingNpc, richItems, []);
check('Alice sells when the edge clears her 5% minimum', aliceSell.action === 'SELL', fmt(aliceSell));

// A thin edge: fair barely above cost. Bob (2% min) sells, Alice (5% min) holds.
const thinItems = [item({ npc_buy_volume: 1 })];
const bobThin = decide('bob', holdingNpc, thinItems, []);
const aliceThin = decide('alice', holdingNpc, thinItems, []);
check('Bob sells on a thin edge', bobThin.action === 'SELL', fmt(bobThin));
check('Alice holds on a thin edge', aliceThin.action === 'HOLD', fmt(aliceThin));

// --------------------------------------------------------------- reserves

console.log('\nreserve enforcement:');

// Alice keeps 50% in reserve, so with 5 NEAR she can spend 2.5 NEAR.
// A listing of 10 units at 1 NEAR costs 10 NEAR — beyond her budget.
const bigListing = [[0, listing({ units: 10, ask_price: '100000' })]];
const aliceBig = decide('alice', emptyNpc(), items, bigListing);
check(
  'Alice refuses an order her reserve cannot fund',
  aliceBig.action === 'HOLD' || aliceBig.action === 'BUY',
  fmt(aliceBig)
);

// With a small listing she can afford, she buys.
const smallListing = [[0, listing({ units: 2, ask_price: '100000' })]];
const aliceSmall = decide('alice', emptyNpc(), items, smallListing);
check('Alice buys a small order she can fund', aliceSmall.action === 'BUY', fmt(aliceSmall));

// --------------------------------------------------- stop-loss (regression)

// A losing position used to be held forever: the liquidation check compared
// treasury against a fraction of itself, which is never true. The NPC then
// stopped trading at all, because its whole treasury was tied up in stock it
// would not sell.
// Bought at 100000, market has fallen to 90000: holding is a dead loss and
// ties up treasury the NPC cannot spend.
const fallingItems = items.map((i) => ({ ...i, fair_price: '90000' }));
check(
  'a losing position is sold to free treasury',
  decide('bob', npcWith([{ item_id: 'fish', units: 10, unit_cost: '100000' }]), fallingItems, listings6)
    .action === 'SELL'
);

check(
  'a winning position is sold for profit',
  decide('bob', npcWith([{ item_id: 'fish', units: 10, unit_cost: '50000' }]), items, listings6)
    .action === 'SELL'
);


// ------------------------------------------------- demand is real, not churn

// Cold start: with no demand yet, a demand-only rule means nobody ever buys,
// so nobody ever has inventory to sell, so demand never appears. Buying below
// the base price is the way out.
check(
  'an NPC buys below base price even with no demand yet',
  decide(
    'bob',
    emptyNpc(),
    itemsWith({ player_buy_volume: 0 }),
    [[0, listing({ ask_price: '90000' })]]
  ).action === 'BUY'
);

check(
  'an NPC will not speculate above base with no demand',
  decide(
    'bob',
    emptyNpc(),
    itemsWith({ player_buy_volume: 0 }),
    [[0, listing({ ask_price: '110000' })]]
  ).action === 'HOLD'
);


// NPC-to-NPC volume is inventory moving around, not demand. Counting it let
// an NPC justify buying stock it could never sell, and the treasury drained.
check(
  'an NPC will not buy when only NPCs have been selling',
  decide('bob', emptyNpc(), itemsWith({ npc_sell_volume: 50, player_buy_volume: 0 }), listings)
    .action === 'HOLD'
);

check(
  'an NPC buys when players have been buying from NPCs',
  decide('bob', emptyNpc(), itemsWith({ npc_sell_volume: 0, player_buy_volume: 5 }), listings)
    .action === 'BUY'
);


// ------------------------------------------------------------------ roles

console.log('\nroles:');
const asItem = (id, over = {}) => item({ id, ...over });
const listOf = (id, ask) => [[0, listing({ item_id: id, ask_price: ask })]];

check(
  'Alice ignores guppy: a collector has no use for it',
  decideWithRoles('alice', emptyNpc(), [asItem('guppy')], listOf('guppy', '90000')).action === 'HOLD'
);
check(
  'Bob buys guppy for his bait shelf',
  decideWithRoles('bob', emptyNpc(), [asItem('guppy')], listOf('guppy', '90000')).action === 'BUY'
);
check(
  'Bob pays a premium for tuna beyond his normal tolerance',
  // +18% is above Bob's 15% tolerance but inside 15% + 5% tuna premium.
  decideWithRoles('bob', emptyNpc(), [asItem('tuna', { player_buy_volume: 3 })], listOf('tuna', '118000')).action === 'BUY'
);
check(
  'without the premium the same tuna ask is refused',
  decide('bob', emptyNpc(), [asItem('tuna', { player_buy_volume: 3 })], listOf('tuna', '118000')).action === 'HOLD'
);
check(
  'Bob keeps bait on the shelf even with no edge',
  decideWithRoles('bob', npcWith([{ item_id: 'guppy', units: 5, unit_cost: '100000' }]), [asItem('guppy')], []).action === 'SELL'
);
check(
  'every NPC has a role',
  Object.keys(PERSONALITIES).every((id) => ROLES[id]?.role)
);

// ----------------------------------------------------------------- orders

console.log('\norders:');
const richNpc = (id) => emptyNpc({ id, treasury: '100000000000000000000000000' });
check(
  'Bob orders more tuna in a tuna run',
  planOrder('bob', richNpc('bob'), [asItem('tuna')], 'tuna_run')?.units
    > planOrder('bob', richNpc('bob'), [asItem('tuna')], 'calm')?.units
);
const allFish = ['guppy', 'tilapia', 'snapper', 'tuna', 'koi'].map(asItem);
check(
  'Bob keeps standing bait orders for guppy and tilapia',
  (() => {
    const due = planOrders('bob', richNpc('bob'), allFish, 'calm', [], 5).map((o) => o.itemId);
    return due.includes('guppy') && due.includes('tilapia') && due.includes('tuna') && due.length <= 4;
  })()
);
check(
  'a filled standing order is reposted, a filled weekly order is not',
  (() => {
    const open = [
      { npc_id: 'bob', item_id: 'guppy', units_left: 0, week: 5 },
      { npc_id: 'bob', item_id: 'tilapia', units_left: 4, week: 5 },
      { npc_id: 'bob', item_id: 'tuna', units_left: 0, week: 5 },
    ];
    const due = planOrders('bob', richNpc('bob'), allFish, 'calm', open, 5).map((o) => o.itemId);
    return due.length === 1 && due[0] === 'guppy';
  })()
);
check(
  'a weekly order filled (and closed) this week is not posted again',
  !planOrders('bob', richNpc('bob'), allFish, 'calm',
    [{ npc_id: 'bob', item_id: 'guppy', units_left: 5, week: 5 }, { npc_id: 'bob', item_id: 'tilapia', units_left: 5, week: 5 }], 5, { tuna: 5 }).length
);
check(
  'every order is reposted in a new week',
  planOrders('john', richNpc('john'), allFish, 'calm',
    [{ npc_id: 'john', item_id: 'snapper', units_left: 3, week: 4 }, { npc_id: 'john', item_id: 'tilapia', units_left: 3, week: 4 }], 5).length === 2
);
check(
  'Alice and John each have a standing order',
  planOrders('alice', richNpc('alice'), allFish, 'calm', [], 1).some((o) => o.itemId === 'koi' && o.standing)
    && planOrders('john', richNpc('john'), allFish, 'calm', [], 1).some((o) => o.itemId === 'snapper' && o.standing)
);
check(
  'an order is priced above fair and inside the +20% band',
  (() => {
    const o = planOrders('john', richNpc('john'), [asItem('snapper')], 'calm', [], 1)[0];
    const fair = BigInt(fairPriceOf(asItem('snapper')));
    return o && o.price > fair && o.price <= (fair * 12_000n) / 10_000n;
  })()
);
check(
  'a poor NPC sizes its order down, or skips it',
  (() => {
    const poor = emptyNpc({ id: 'alice', treasury: '1000000000000000000' });
    return planOrder('alice', poor, [asItem('koi')], 'koi_run') === null;
  })()
);

// ------------------------------------------------------------ shop margin
check(
  'a staple bought above fair is shelved at cost plus the shop margin, never at a loss',
  (() => {
    const item = asItem('guppy');
    const fair = BigInt(fairPriceOf(item));
    const cost = (fair * 10_500n) / 10_000n;
    const npc = { ...richNpc('bob'), inventory: [{ item_id: 'guppy', units: 5, unit_cost: cost.toString() }], asks: [] };
    const d = decideWithRoles('bob', npc, [item], []);
    return d.action === 'SELL' && BigInt(d.askPrice) >= (cost * (10_000n + SHOP_MARGIN_BPS)) / 10_000n;
  })()
);
check(
  'Alice shelves snapper too, so rod crafters can buy it',
  ROLES.alice.stocks.includes('snapper')
);
check(
  'staple orders pay a small premium, leaving room for the shop margin',
  planOrders('bob', richNpc('bob'), [asItem('guppy')], 'calm', [], 1)[0].price
    <= (BigInt(fairPriceOf(asItem('guppy'))) * 10_500n) / 10_000n
);

// --------------------------------------------------------------- summary

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);


