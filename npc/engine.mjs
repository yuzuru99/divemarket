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

// ----------------------------------------------------------------- tick

/** Week each NPC last posted each weekly order (lost on restart: at worst one repost). */
const postedWeekly = {};

async function tick(provider, npcId) {
  const [npc, items, listings, orders, season] = await Promise.all([
    view(provider, 'get_npc', { id: npcId }),
    view(provider, 'market_snapshot'),
    view(provider, 'open_listings'),
    view(provider, 'orders'),
    view(provider, 'current_season'),
  ]);
  if (!npc) {
    console.log(`[${npcId}] not registered, skipping`);
    return;
  }

  // Orders: standing ones are reposted as soon as they fill, the seasonal
  // one once a week. One order per tick keeps each tick a single transaction.
  const posted = (postedWeekly[npcId] ||= {});
  const due = planOrders(npcId, npc, items, season.name, orders, season.week, posted);
  if (due.length) {
    const plan = due[0];
    console.log(`[${npcId}] ORDER ${plan.standing ? 'standing' : 'weekly'} ${plan.units} ${plan.itemId} @ ${plan.price} (${season.name})`);
    await sendCall(provider, `${npcId}.${CONTRACT}`, signerFor(`${npcId}.${CONTRACT}`), 'npc_post_order',
      { npc_id: npcId, item_id: plan.itemId, units: plan.units, price: plan.price.toString() }, '0');
    if (!plan.standing) posted[plan.itemId] = Number(season.week);
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
  console.log(`  tick:     ${TICK_MS}ms\n`);

  for (const id of npcIds) {
    try {
      await tick(near, id);
    } catch (err) {
      console.error(`[${id}] error:`, err.message);
    }
  }

  if (process.env.ONCE) return;

  setInterval(async () => {
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


