/**
 * Simulated anglers: a handful of clearly labelled bot players (account ids
 * start with `dmsim-`, shown as [sim] in the UI) who play DiveMarket the way
 * a person would, through the same public game server and contract calls.
 *
 * They exist so the testnet economy has traffic to show: catches, NPC order
 * fills, listings, bait purchases, rod repairs, a harbor master, tournament
 * entries. They get no privileges: the server judges their strikes like
 * anyone else's, and every NEAR they spend or earn moves on chain.
 *
 *   node sim/anglers.mjs            run forever
 *   node sim/anglers.mjs --once     one session per sim, then exit
 */
import { execFileSync } from 'node:child_process';

const CONTRACT = process.env.CONTRACT_ID || 'dm21.testnet';
const GAME = process.env.GAME_URL || 'https://dist-swart-nu-14.vercel.app';
const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
const ONCE = process.argv.includes('--once');
const MIN = 60_000;

/**
 * Who plays, and how. `skill` is how close to the centre of the strike
 * window they usually hit; `goal` is the zone they work toward; `every` is
 * the gap between sessions in minutes [min, max].
 */
const SIMS = [
  { id: 'dmsim-rani.testnet', persona: 'grinder',       skill: 0.75, goal: 'reef',     every: [50, 110],  cup: true },
  { id: 'dmsim-budi.testnet', persona: 'casual',        skill: 0.45, goal: 'shallows', every: [120, 300] },
  { id: 'dmsim-sari.testnet', persona: 'record hunter', skill: 0.9,  goal: 'reef',     every: [60, 140],  cup: true, buys: 'spinner', mounts: true },
  { id: 'dmsim-agus.testnet', persona: 'harbor master', skill: 0.6,  goal: 'shallows', every: [70, 160],  cup: true, steward: 'shallows' },
  { id: 'dmsim-dewi.testnet', persona: 'trader',        skill: 0.65, goal: 'reef',     every: [80, 180],  buys: 'carbon', invest: { bob: '0.5', alice: '0.3' }, buysBait: true },
];

const RODS = {
  bamboo: { tier: 0, recipe: null, repairRecipe: { guppy: 8 }, repair: '0.03' },
  carbon: { tier: 1, recipe: { snapper: 12 }, repairRecipe: { snapper: 5 }, repair: '0.45', price: '1.5' },
  spinner: { tier: 1, recipe: { snapper: 8, tilapia: 5 }, repairRecipe: { snapper: 3, tilapia: 3 }, repair: '0.45', price: '1.5' },
  master: { tier: 2, recipe: { snapper: 25, tuna: 3 }, repairRecipe: { snapper: 8, tuna: 1 }, repair: '1.8', price: '6' },
};
const ZONE_BAIT = { shallows: null, reef: 'guppy', abyss: 'tilapia' };
const BAIT_TIER = { guppy: 1, tilapia: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const log = (sim, ...m) => console.log(new Date().toISOString().slice(5, 19), `[${sim.id.replace(/^dmsim-|\.testnet$/g, '')}]`, ...m);

async function view(method, args = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: {
          request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT, method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
      });
      const j = await r.json();
      if (j.result?.result) {
        // Keep u128s exact: quote long numbers before parsing.
        return JSON.parse(Buffer.from(j.result.result).toString().replace(/([:\[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
      }
    } catch { /* retry */ }
    await sleep(1500);
  }
  throw new Error(`view ${method} failed`);
}

async function balance(account) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }) });
  const j = await r.json();
  return Number(BigInt(j.result.amount) / 10n ** 21n) / 1000;
}

/** Sign and send one contract call with near-cli. Returns true on success. */
function call(sim, method, args, { deposit, depositYocto, gas } = {}) {
  const cmd = ['call', CONTRACT, method, JSON.stringify(args), '--accountId', sim.id, '--networkId', 'testnet'];
  if (deposit) cmd.push('--deposit', deposit);
  if (depositYocto) cmd.push('--depositYocto', depositYocto);
  if (gas) cmd.push('--gas', gas);
  try {
    execFileSync('near', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000,
      env: { ...process.env, NEAR_TESTNET_RPC: RPC } });
    return true;
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const why = out.match(/Smart contract panicked: ([^"\\\n]*)/)?.[1] || out.split('\n').find((l) => /Error/.test(l)) || 'failed';
    log(sim, `✗ ${method}: ${why.slice(0, 140)}`);
    return false;
  }
}

async function post(path, body) {
  const r = await fetch(GAME + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `server ${r.status}`);
  return j;
}

/** One cast and strike through the public game server. */
async function castOnce(sim, zone, rod, bait) {
  const c = await post('/api/cast', { player: sim.id, zone, rod, bait: bait || undefined });
  // A skilled angler strikes near the middle of the window; a sloppy one
  // spreads wide and sometimes misses it entirely.
  const spread = 0.12 + 0.3 * (1 - sim.skill);
  const reaction = Math.max(30, Math.round(c.windowMs * (0.5 + gauss() * spread)));
  await sleep(c.biteDelay + reaction);
  return post('/api/strike', { ...c, player: sim.id, reactionMs: reaction });
}

const holdOf = (p) => Object.fromEntries(p.holdings.map(([i, n]) => [i, Number(n)]));
const has = (held, recipe) => Object.entries(recipe || {}).every(([f, n]) => (held[f] || 0) >= n);

/** Fish the sim keeps back instead of selling: bait and crafting stock. */
function reserve(sim, rods) {
  const keep = {};
  if (sim.goal !== 'shallows') keep.guppy = 25;
  if (sim.goal !== 'shallows' && !rods.some((r) => RODS[r]?.tier >= 1)) keep.snapper = 12;
  if (sim.mounts) keep.koi = 1;
  return keep;
}

/** Buy up to `units` of an item from the cheapest NPC shelf that has it. */
async function buyFromShelf(sim, item, units) {
  const npcs = (await view('world_state', { trades: 0 })).npcs;
  const offers = npcs.map((n) => ({
    id: n.id,
    ask: n.asks?.find(([i]) => i === item)?.[1],
    stock: n.inventory.filter((l) => l.item_id === item).reduce((s, l) => s + Number(l.units), 0),
  })).filter((o) => o.ask && o.stock > 0).sort((a, b) => Number(BigInt(a.ask) - BigInt(b.ask)));
  let bought = 0;
  for (const o of offers) {
    const n = Math.min(units - bought, o.stock);
    if (n < 1) break;
    const maxP = (BigInt(o.ask) * 105n) / 100n;
    const cost = (maxP * BigInt(n) * 10n ** 24n) / 1_000_000n;
    if (call(sim, 'buy_from_npc', { npc_id: o.id, item_id: item, units: n, max_price: maxP.toString() }, { depositYocto: cost.toString() })) {
      bought += n;
      log(sim, `bought ${n} ${item} from ${o.id}'s shelf`);
    }
  }
  return bought;
}

async function session(sim) {
  const week = Math.floor(Date.now() / (7 * 86_400_000));
  let p = await view('player_state', { player: sim.id });
  let held = holdOf(p);
  let rods = p.rods;
  const near = await balance(sim.id);
  log(sim, `session · ${sim.persona} · ${near.toFixed(2)} NEAR · rods ${rods.join(',') || 'none'} · left today ${p.catches_left}`);

  // ---- gear and one-off moves
  if (!rods.length) call(sim, 'acquire_rod', { rod_id: 'bamboo', craft: false }, { deposit: '0.1' }) && log(sim, 'bought a Bamboo Rod');
  if (sim.buys && !rods.includes(sim.buys) && near > 3) {
    call(sim, 'acquire_rod', { rod_id: sim.buys, craft: false }, { deposit: RODS[sim.buys].price }) && log(sim, `bought a ${sim.buys} rod`);
  }
  // Close to a Carbon Rod: finish the recipe from the NPC shelves.
  if (sim.goal !== 'shallows' && !rods.some((r) => RODS[r]?.tier >= 1) && (held.snapper || 0) >= 6 && (held.snapper || 0) < 12 && near > 1) {
    await buyFromShelf(sim, 'snapper', 12 - held.snapper);
    held = holdOf(await view('player_state', { player: sim.id }));
  }
  if (sim.goal !== 'shallows' && !rods.some((r) => RODS[r]?.tier >= 1) && has(held, RODS.carbon.recipe)) {
    call(sim, 'acquire_rod', { rod_id: 'carbon', craft: true }) && log(sim, 'crafted a Carbon Rod from 12 snapper');
  }
  if (sim.steward) {
    const z = await view('get_zone', { zone_id: sim.steward });
    if (!z.zone.steward) call(sim, 'become_steward', { zone_id: sim.steward }, { deposit: '1' }) && log(sim, `became harbor master of ${sim.steward}`);
    else if (z.zone.steward === sim.id && BigInt(z.zone.steward_earned || 0) > 10n ** 21n) {
      call(sim, 'claim_steward_earnings', { zone_id: sim.steward }) && log(sim, 'claimed harbor master earnings');
    }
  }
  if (sim.invest) {
    for (const [npc, amt] of Object.entries(sim.invest)) {
      const inv = await view('investment_of', { npc_id: npc, investor: sim.id });
      if (!inv) call(sim, 'invest', { npc_id: npc, amount: (BigInt(Math.round(Number(amt) * 1000)) * 10n ** 21n).toString() }, { deposit: amt })
        && log(sim, `invested ${amt} NEAR in ${npc}`);
    }
  }
  if (sim.cup && !p.entered_this_week) call(sim, 'enter_tournament', {}, { deposit: '0.1' }) && log(sim, 'entered the weekly tournament');
  if (sim.mounts && (held.koi || 0) >= 1) call(sim, 'mount_trophy', {}) && log(sim, 'mounted a koi trophy');

  p = await view('player_state', { player: sim.id });
  held = holdOf(p);
  rods = p.rods;
  if (!rods.length) return;

  // ---- pick rod, zone and bait
  const status = Object.fromEntries(p.rod_status.map((s) => [s.id, s]));
  const best = rods.filter((r) => RODS[r]).sort((a, b) => RODS[b].tier - RODS[a].tier)[0];
  for (const r of rods) {
    const s = status[r];
    if (!RODS[r] || s.left >= 15) continue;
    const spare = Object.entries(RODS[r].repairRecipe).every(([f, n]) => (held[f] || 0) >= n + (reserve(sim, rods)[f] || 0));
    call(sim, 'repair_rod', { rod_id: r, with_fish: spare }, spare ? {} : { deposit: RODS[r].repair })
      && log(sim, `repaired the ${r} rod with ${spare ? 'fish' : 'NEAR'}`);
  }
  const season = (await view('current_season')).name;
  let zone = RODS[best].tier >= 1 ? sim.goal : 'shallows';
  if (zone === 'abyss' && season === 'storm') zone = 'reef';
  let baitNeed = ZONE_BAIT[zone];
  if (baitNeed && (held[baitNeed] || 0) < 3 && sim.buysBait) {
    // Short of bait: buy some from the NPC shelves, which is the shops' living.
    if (await buyFromShelf(sim, baitNeed, 5)) held = holdOf(await view('player_state', { player: sim.id }));
  }
  if (baitNeed && (held[baitNeed] || 0) < 1) { zone = 'shallows'; baitNeed = null; }
  const rod = zone === 'shallows' ? (sim.persona === 'record hunter' ? best : (rods.includes('bamboo') && status.bamboo?.left > 0 ? 'bamboo' : best)) : best;
  if (!status[rod] || status[rod].left <= 0) return log(sim, `${rod} is worn out, skipping`);

  // ---- fish
  const casts = Math.min(p.catches_left, Math.round(rand(10, 24)));
  let baitLeft = baitNeed ? held[baitNeed] : 0;
  const caught = [];
  let wear = 0;
  for (let i = 0; i < casts; i++) {
    if (status[rod].left - wear <= 0) break;
    const useBait = baitNeed ? (baitLeft > 0 ? baitNeed : null) : null;
    if (baitNeed && !useBait) break;
    try {
      const s = await castOnce(sim, zone, rod, useBait);
      if (s.hit) {
        caught.push(s.receipt);
        if (useBait) baitLeft--;
        wear += s.fish === 'tuna' || s.fish === 'koi' ? 3 : 1;
      }
    } catch (e) {
      log(sim, `cast: ${e.message}`);
      break;
    }
    await sleep(rand(1500, 4000));
  }
  log(sim, `${zone} with ${rod}${baitNeed ? ` + ${baitNeed}` : ''}: ${caught.length}/${casts} landed (${caught.map((r) => r.item_id).join(' ') || '—'})`);
  if (!caught.length) return;

  // ---- bring the catch ashore
  const counts = {};
  for (const r of caught) counts[r.zone_id] = (counts[r.zone_id] || 0) + 1;
  for (let i = 0; i < caught.length; i += 40) {
    const batch = caught.slice(i, i + 40);
    const per = {};
    for (const r of batch) per[r.zone_id] = (per[r.zone_id] || 0) + 1;
    const quote = BigInt(await view('claim_quote', { counts: Object.entries(per), player: sim.id }));
    call(sim, 'claim_catches', { receipts: batch }, { depositYocto: ((quote * 103n) / 100n).toString(), gas: '300000000000000' });
  }

  // ---- sell: NPC orders first, then the vault if it bids well, else list
  p = await view('player_state', { player: sim.id });
  held = holdOf(p);
  const keep = reserve(sim, p.rods);
  const sell = Object.fromEntries(Object.entries(held).map(([i, n]) => [i, Math.max(0, n - (keep[i] || 0))]).filter(([, n]) => n > 0));
  const orders = (await view('orders')).filter((o) => Number(o.week) === week && Number(o.units_left) > 0)
    .sort((a, b) => Number(BigInt(b.price) - BigInt(a.price)));
  for (const o of orders) {
    const n = Math.min(sell[o.item_id] || 0, Number(o.units_left));
    if (n < 1) continue;
    if (call(sim, 'fill_order', { npc_id: o.npc_id, item_id: o.item_id, units: n }, { gas: '60000000000000' })) {
      sell[o.item_id] -= n;
      log(sim, `filled ${o.npc_id}'s ${o.item_id} order with ${n}`);
    }
  }
  const bid = Number(await view('vault_bid_bps'));
  for (const [item, n] of Object.entries(sell)) {
    if (n < 1) continue;
    // A thin vault pays badly; list for the NPCs instead and wait.
    if (bid >= 5000 && Math.random() < 0.5) {
      call(sim, 'sell_to_market', { item_id: item, units: n }) && log(sim, `sold ${n} ${item} to the vault at ${bid / 100}%`);
    } else {
      call(sim, 'list_fair', { item_id: item, units: n }) && log(sim, `listed ${n} ${item} at fair`);
    }
  }
}

async function runSim(sim, offsetMs) {
  await sleep(offsetMs);
  for (;;) {
    try { await session(sim); } catch (e) { log(sim, `session error: ${e.message}`); }
    if (ONCE) return;
    await sleep(rand(sim.every[0], sim.every[1]) * MIN);
  }
}

console.log(`DiveMarket sim anglers → ${CONTRACT} via ${GAME}`);
await Promise.all(SIMS.map((s, i) => runSim(s, ONCE ? i * 20_000 : i * rand(2, 6) * MIN)));
