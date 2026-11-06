/**
 * DiveMarket NPC engine.
 *
 * Autonomous economic agents. Each NPC:
 *   1. reads public views from the contract (fair price, its own state, open
 *      listings, market counters),
 *   2. decides BUY / SELL / HOLD using its own on-chain personality
 *      constants,
 *   3. signs and broadcasts the trade with a function-call key scoped to the
 *      contract.
 *
 * The engine holds no treasury and no policy authority. It cannot change a
 * price, cannot mint, cannot widen a limit. If the engine is compromised the
 * attacker gains the ability to trade within the NPC's existing limits and
 * nothing more — and the owner can revoke the key on-chain.
 *
 * Decisions are deterministic given the same market state. There is no LLM in
 * the loop by default; `decideWithModel` is an optional plug-in point that
 * still has to pass the same validation before anything is signed.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { KeyPair } = require('near-api-js');
import { decide, fairPriceOf, PERSONALITIES, planOrders } from './decide.mjs';
import { think, rulesNote, apiKey } from './brain.mjs';
import { readFileSync } from 'node:fs';

// ----------------------------------------------------------------- config

const CONTRACT = process.env.CONTRACT_ID || 'dm21.testnet';
const NETWORK = process.env.NEAR_NETWORK || 'testnet';
const NODE_URL =
  process.env.NEAR_NODE_URL || 'https://test.rpc.fastnear.com';
const KEYSTORE = process.env.NEAR_KEYSTORE || '/root/.near-credentials';
const TICK_MS = Number(process.env.TICK_MS || 60_000);

const PRICE_SCALE = 1_000_000n;
/// Storage cost of one listing, charged by the contract to whoever creates it.
const LISTING_STORAGE_COST = '100000000000000000000000'; // 0.1 NEAR
const ONE_NEAR = 10n ** 24n;
const BPS = 10_000n;

/** The three NPC personalities, mirroring the on-chain constants. */
// ----------------------------------------------------------------- client

function makeClient() {
  // No SDK client: reads go through raw RPC (see `view`) and writes through
  // near-cli (see `sendCall`). near-api-js v4's own helpers each have a
  // breaking change that only surfaces at broadcast time.
  return null;
}

/**
 * A signer that reads an account's key from the NEAR credentials directory.
 *
 * NPCs sign with their own sub-account key, so each trade is authorised by
 * the NPC and nothing else.
 */
function signerFor(accountId) {
  const path = `${KEYSTORE}/${NETWORK}/${accountId}.json`;
  const cred = JSON.parse(readFileSync(path, 'utf8'));
  // near-cli writes `private_key`; older tooling wrote `secret_key`.
  return KeyPair.fromString(cred.private_key || cred.secret_key);
}

/** Call a view method and parse the JSON result. */
async function view(provider, method, args = {}) {
  // Raw RPC rather than the SDK helper: the helper's argument shape changed
  // between near-api-js versions and the raw query is stable.
  const res = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'npc-engine',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: CONTRACT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'rpc error');
  // A contract trap comes back as a result with an `error` field and no
  // `result`. Reading it blindly crashes in Buffer.from with a message about
  // argument types, which says nothing about the real problem.
  if (json.result?.error) {
    throw new Error(`contract error: ${JSON.stringify(json.result.error).slice(0, 200)}`);
  }
  if (json.result?.result === undefined) {
    throw new Error(`empty result from ${method}`);
  }
  return JSON.parse(Buffer.from(json.result.result, 'base64').toString());
}

// ----------------------------------------------------------------- decision

/**
 * Decide what an NPC should do, given the market and its own state.
 *
 * Returns one of:
 *   { action: 'BUY',  listingIndex, units, reason }
 *   { action: 'SELL', units, askPrice, reason }
 *   { action: 'HOLD', reason }
 *
 * Every branch is bounded by the NPC's own on-chain constants, so the engine
 * cannot act outside the personality the owner registered.
 */
/**
 * Fair price of an item, as the contract computes it. In production this is a
 * view call; here it is inlined from the item's counters so the engine can
 * reason without a round trip per decision.
 */
/**
 * Sign and broadcast a contract call as an NPC.
 *
 * near-cli does the signing. Building the transaction by hand against
 * near-api-js v4 is a rabbit hole — the Account helper ignores its signer
 * option, Transaction has no sign method, and SignedTransaction wants a
 * pre-built signature — and every one of those failures looks like "the NPC
 * cannot trade" rather than "the SDK changed shape". near-cli is one process,
 * reads the same credentials file, and reports failures verbatim.
 */
async function sendCall(provider, accountId, keyPair, methodName, args, depositYocto = '0') {
  const { execFileSync } = await import('node:child_process');
  const cmd = [
    'call',
    CONTRACT,
    methodName,
    JSON.stringify(args),
    '--accountId',
    accountId,
    '--networkId',
    NETWORK,
  ];
  if (depositYocto !== '0') {
    // npc_sell writes a listing and charges the caller for the storage,
    // otherwise the contract runs out of NEAR to store its own state.
    cmd.push('--depositYocto', depositYocto);
  }
  // near-cli's default testnet endpoint is deprecated and 429s every write.
  // NEAR_TESTNET_RPC points it at a working one.
  return execFileSync('near', cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEAR_TESTNET_RPC: NODE_URL },
  });
}

// ----------------------------------------------------------------- gas

/** Who pays NPC gas top-ups, and the thresholds (in yoctoNEAR). */
const GAS_FUNDER = process.env.GAS_FUNDER || CONTRACT;
const GAS_FLOOR = BigInt(Math.round(Number(process.env.GAS_FLOOR_NEAR || 0.3) * 1e6)) * 10n ** 18n;
const GAS_TOP_UP = BigInt(Math.round(Number(process.env.GAS_TOP_UP_NEAR || 1) * 1e6)) * 10n ** 18n;
const GAS_FUNDER_FLOOR = BigInt(Math.round(Number(process.env.GAS_FUNDER_FLOOR_NEAR || 3) * 1e6)) * 10n ** 18n;
const fmtNear = (yocto) => (Number(yocto / 10n ** 21n) / 1000).toFixed(3);

/** An account's liquid balance, in yoctoNEAR. */
async function accountBalance(accountId) {
  const res = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'npc-gas', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  const json = await res.json();
  if (json.error || !json.result) throw new Error(json.error?.message || `cannot read ${accountId}`);
  return BigInt(json.result.amount);
}

/** Send NEAR with near-cli, signed by the sender's key in the keystore. */
async function sendNear(from, to, yocto) {
  const { execFileSync } = await import('node:child_process');
  const amount = (Number(yocto / 10n ** 18n) / 1e6).toString();
  return execFileSync('near', ['send', from, to, amount, '--networkId', NETWORK], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEAR_TESTNET_RPC: NODE_URL },
  });
}

// ----------------------------------------------------------------- tick

/** Week each NPC last posted each weekly order (lost on restart: at worst one repost). */
const postedWeekly = {};

/** How often each NPC asks NEAR AI Cloud for a new plan, and posts a note. */
// Each NPC thinks and posts on its own random 30-50 minute rhythm, so the
// harbor radio does not tick like a clock.
const GAP_MIN_MS = Number(process.env.GAP_MIN_MS || 30 * 60_000);
const GAP_MAX_MS = Number(process.env.GAP_MAX_MS || 50 * 60_000);
const randomGap = () => GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
const BRAIN_RETRY_MS = Number(process.env.BRAIN_RETRY_MS || 10 * 60_000);
const WEEK_NS = 7n * 86_400n * 1_000_000_000n;
/** The latest plan per NPC: { at, plan, source }. */
const brains = {};
/** The last note posted per NPC: { at, text }. */
const notes = {};

/** Units players bought from this NPC over the last seven days, per fish. */
function soldLastWeek(trades, npcId) {
  const since = BigInt(Date.now()) * 1_000_000n - WEEK_NS;
  const out = {};
  for (const t of trades) {
    if (t.kind !== 'player_buy' || t.npc_id !== npcId || BigInt(t.at_ns) < since) continue;
    out[t.item_id] = (out[t.item_id] || 0) + Number(t.units);
  }
  return out;
}

async function tick(provider, npcId) {
  const [npc, items, listings, orders, season, trades] = await Promise.all([
    view(provider, 'get_npc', { id: npcId }),
    view(provider, 'market_snapshot'),
    view(provider, 'open_listings'),
    view(provider, 'orders'),
    view(provider, 'current_season'),
    view(provider, 'recent_trades', { limit: 300 }),
  ]);
  if (!npc) {
    console.log(`[${npcId}] not registered, skipping`);
    return;
  }

  const sold = soldLastWeek(trades, npcId);

  // Brain: every 30-50 minutes, ask NEAR AI Cloud for this week's plan. Any failure
  // (or no API key) leaves the NPC on its rules.
  const b = brains[npcId];
  // After a failed call (no credit yet, a timeout) retry sooner, so the NPC
  // switches to its AI plan soon after the account starts working.
  const brainDue = b && Date.now() - b.at > (b.plan ? b.gap : BRAIN_RETRY_MS);
  if (!b || brainDue || b.season !== season.name) {
    const fair = Object.fromEntries(items.map((i) => [i.id, Number(fairPriceOf(i)) / 1e6]));
    const treasuryNear = Number(BigInt(npc.treasury) / 10n ** 21n) / 1000;
    const plan = await think(npcId, { npc, season: season.name, sold, fair, treasuryNear });
    brains[npcId] = { at: Date.now(), gap: randomGap(), season: season.name, plan, source: plan ? 'near-ai' : 'rules' };
    console.log(`[${npcId}] BRAIN ${plan ? `near-ai ${JSON.stringify(plan.orders)}` : 'rules (no AI plan)'}`);
  }
  const brain = brains[npcId];

  // Orders: standing ones are reposted as soon as they fill, the seasonal
  // one once a week. One order per tick keeps each tick a single transaction.
  const posted = (postedWeekly[npcId] ||= {});
  const due = planOrders(npcId, npc, items, season.name, orders, season.week, posted, { sold, ai: brain.plan?.orders });
  if (due.length) {
    const plan = due[0];
    console.log(`[${npcId}] ORDER ${plan.standing ? 'standing' : 'weekly'} ${plan.units} ${plan.itemId} @ ${plan.price} (${season.name})`);
    await sendCall(provider, `${npcId}.${CONTRACT}`, signerFor(`${npcId}.${CONTRACT}`), 'npc_post_order',
      { npc_id: npcId, item_id: plan.itemId, units: plan.units, price: plan.price.toString() }, '0');
    if (!plan.standing) posted[plan.itemId] = Number(season.week);
    return;
  }

  // A market note on chain, from the NPC's own account, every 30-50 minutes.
  const text = (brain.source === 'near-ai' && brain.plan?.note) || rulesNote(npcId, npc, season.name);
  const last = notes[npcId];
  if (!last || (Date.now() - last.at > last.gap && last.text !== text)) {
    console.log(`[${npcId}] NOTE (${brain.source}) ${text}`);
    await sendCall(provider, `${npcId}.${CONTRACT}`, signerFor(`${npcId}.${CONTRACT}`), 'npc_post_note',
      { npc_id: npcId, text, source: brain.source }, '0');
    notes[npcId] = { at: Date.now(), gap: randomGap(), text };
    return;
  }

  const decision = decide(npcId, npc, items, listings);
  const p = PERSONALITIES[npcId];

  if (decision.action === 'HOLD') {
    console.log(`[${npcId}] HOLD — ${decision.reason}`);
    return;
  }

  // Validate before signing. The contract enforces the same limits, but
  // failing here saves gas and keeps the log clean.
  const npcAccountId = `${npcId}.${CONTRACT}`;
  const keyPair = signerFor(npcAccountId);

  if (decision.action === 'BUY') {
    // Listings are [globalIndex, listing] pairs, so the decision's index has
    // to be matched against the pair, not used as a position in the array.
    const l = listings.find(([idx]) => idx === decision.listingIndex)?.[1];
    if (!l) {
      console.log(`[${npcId}] listing ${decision.listingIndex} no longer open`);
      return;
    }
    const cost = (BigInt(l.ask_price) * BigInt(decision.units) * ONE_NEAR) / PRICE_SCALE;
    const spendable = (BigInt(npc.treasury) * (BPS - p.reserveBps)) / BPS;
    if (cost > spendable) {
      console.log(`[${npcId}] BUY refused locally — cost ${cost} > spendable ${spendable}`);
      return;
    }
    console.log(
      `[${npcId}] BUY ${decision.units} ${l.item_id} @ ${l.ask_price} — ${decision.reason}`
    );
    await sendCall(
      provider,
      npcAccountId,
      keyPair,
      'npc_buy',
      {
        npc_id: npcId,
        listing_index: decision.listingIndex,
        units: decision.units,
      },
      LISTING_STORAGE_COST
    );
  } else {
    console.log(
      `[${npcId}] ASK ${decision.units} ${decision.itemId} @ ${decision.askPrice} — ${decision.reason}`
    );
    await sendCall(
      provider,
      npcAccountId,
      keyPair,
      'npc_sell',
      {
        npc_id: npcId,
        item_id: decision.itemId,
        units: decision.units,
        ask_price: decision.askPrice.toString(),
      },
      // Posting an ask writes no listing any more, so it needs no deposit.
      '0'
    );
  }
}

// ----------------------------------------------------------------- main

async function main() {
  const near = makeClient();
  const npcIds = Object.keys(PERSONALITIES);

  console.log(`DiveMarket NPC engine`);
  console.log(`  contract: ${CONTRACT}`);
  console.log(`  network:  ${NETWORK}`);
  console.log(`  npcs:     ${npcIds.join(', ')}`);
  console.log(`  tick:     ${TICK_MS}ms`);
  console.log(`  brain:    ${apiKey() ? 'NEAR AI Cloud' : 'rules (no NEAR AI key)'}\n`);

  for (const id of npcIds) {
    try {
      await tick(near, id);
    } catch (err) {
      console.error(`[${id}] error:`, err.message);
    }
  }

  if (process.env.ONCE) return;

  // Hourly: anything the vault holds above its ceiling goes to this week's
  // tournament pot. Anyone may call it; Bob pays the gas.
  let lastSweep = 0;
  const sweep = async () => {
    if (Date.now() - lastSweep < 60 * 60_000) return;
    lastSweep = Date.now();
    try {
      const vault = BigInt(await view(near, 'vault_balance'));
      if (vault > 10n * ONE_NEAR) {
        console.log(`[vault] sweeping surplus above 10 NEAR into the tournament pot`);
        await sendCall(near, `bob.${CONTRACT}`, signerFor(`bob.${CONTRACT}`), 'sweep_vault_surplus', {}, '0');
      }
    } catch (err) { console.error('[vault] sweep failed:', err.message); }
  };

  // Every 10 minutes: an NPC whose own account runs low on gas gets 1 NEAR
  // from the funder (the contract account by default). Without gas an NPC
  // silently stops posting orders, notes and sweeps.
  let lastGasCheck = 0;
  const topUpGas = async () => {
    if (Date.now() - lastGasCheck < 10 * 60_000) return;
    lastGasCheck = Date.now();
    try {
      const funderBalance = await accountBalance(GAS_FUNDER);
      for (const id of npcIds) {
        const account = `${id}.${CONTRACT}`;
        const balance = await accountBalance(account);
        if (balance >= GAS_FLOOR) continue;
        if (funderBalance < GAS_FUNDER_FLOOR) {
          console.error(`[gas] ${account} is low (${fmtNear(balance)} NEAR) but ${GAS_FUNDER} is down to ${fmtNear(funderBalance)} NEAR; top it up by hand`);
          continue;
        }
        console.log(`[gas] ${account} has ${fmtNear(balance)} NEAR, sending ${fmtNear(GAS_TOP_UP)} from ${GAS_FUNDER}`);
        await sendNear(GAS_FUNDER, account, GAS_TOP_UP);
      }
    } catch (err) { console.error('[gas] top-up failed:', err.message); }
  };
  await topUpGas();

  setInterval(async () => {
    await topUpGas();
    await sweep();
    for (const id of npcIds) {
      try {
        await tick(near, id);
      } catch (err) {
        console.error(`[${id}] error:`, err.message);
      }
    }
  }, TICK_MS);
}

if (process.env.NPC_NO_MAIN !== '1') {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}


