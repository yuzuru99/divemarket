/**
 * Contract access layer.
 *
 * Everything the app knows about the DiveMarket contract lives here: the
 * address, the view calls, and the signing path. Components never build a
 * transaction themselves.
 */
import { actionCreators } from '@near-js/transactions';

export const CONTRACT = import.meta.env.VITE_CONTRACT_ID || 'dm21.testnet';
export const RPC = 'https://test.rpc.fastnear.com';
export const NETWORK = 'testnet';

const PRICE_SCALE = 1_000_000n;
const ONE_NEAR = 10n ** 24n;

/**
 * Parse contract JSON without losing precision. Some fields (treasuries,
 * stakes, escrow) are u128 and arrive as bare JSON numbers; JavaScript would
 * round them to 53 bits. Long integers are turned into strings first, so the
 * UI can use BigInt on them exactly.
 */
export function parseExact(text) {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

/**
 * Turn a failed transaction into a sentence a player can act on. Wallet
 * errors bury the contract's panic message inside nested JSON.
 */
const FRIENDLY = [
  [/listing already closed|no such listing/i, 'That listing is gone — an NPC probably bought it first.'],
  [/npc ask is above your max price/i, 'The NPC just changed its price. Try again at the new price.'],
  [/npc does not hold that many units|npc is not selling/i, 'The NPC sold out a moment ago.'],
  [/vault cannot cover/i, 'The market vault is short right now. List the fish for NPCs instead.'],
  [/needs one \w+ as bait|needs one \w+ per fish/i, null],
  [/daily catch limit/i, 'Daily catch limit reached. The sea needs rest until tomorrow (UTC).'],
  [/this order has expired/i, 'That order expired with last week.'],
];
export function explain(err) {
  const raw = String(err?.message || err);
  const m = raw.match(/Smart contract panicked: ([^"\\]+)/) || raw.match(/panicked at[^:]*: ([^"\\]+)/);
  const msg = m ? m[1].trim() : raw;
  for (const [re, text] of FRIENDLY) if (re.test(msg)) return text || msg;
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/**
 * A fresh NPC ask for a purchase, with 2% headroom so a small re-price in
 * the meantime does not fail the trade. The contract charges the NPC's real
 * ask and refunds the rest.
 */
export async function freshAsk(npcId, itemId) {
  const npc = await view('get_npc', { id: npcId });
  const entry = npc?.asks?.find(([i]) => i === itemId);
  const stock = (npc?.inventory || []).filter((l) => l.item_id === itemId).reduce((s, l) => s + l.units, 0);
  if (!entry || stock < 1) throw new Error(`${npcId} is not selling ${itemId} right now.`);
  const max = (BigInt(entry[1]) * 102n) / 100n;
  return { max: max.toString(), cost: (units) => ((max * BigInt(units) * 10n ** 24n) / 1_000_000n).toString() };
}

/** Public testnet RPCs, tried in order: a rate limit on one falls back to the next. */
const RPCS = [RPC, 'https://rpc.testnet.near.org'];

/** Call a view method and parse the JSON result. */
export async function view(method, args = {}) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'dontcare',
          method: 'query',
          params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: CONTRACT,
            method_name: method,
            args_base64: btoa(JSON.stringify(args)),
          },
        }),
      });
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'rpc error');
      if (json.result?.error) throw new Error(json.result.error);
      return parseExact(new TextDecoder().decode(new Uint8Array(json.result.result)));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Scaled price units -> NEAR string, e.g. 979000 -> "0.979". */
export function toNear(scaled) {
  const v = BigInt(scaled);
  const whole = v / PRICE_SCALE;
  const frac = ((v % PRICE_SCALE) * 1000n) / PRICE_SCALE;
  return `${whole}.${frac.toString().padStart(3, '0')}`;
}

/** yoctoNEAR -> NEAR string with more precision, for small fees. */
export function yoctoToNearFine(yocto, digits = 4) {
  const v = BigInt(yocto);
  const scale = 10n ** BigInt(digits);
  const whole = v / ONE_NEAR;
  const frac = ((v % ONE_NEAR) * scale) / ONE_NEAR;
  return `${whole}.${frac.toString().padStart(digits, '0')}`;
}

/** yoctoNEAR -> NEAR string. */
export function yoctoToNear(yocto) {
  const v = BigInt(yocto);
  const whole = v / ONE_NEAR;
  const frac = ((v % ONE_NEAR) * 1000n) / ONE_NEAR;
  return `${whole}.${frac.toString().padStart(3, '0')}`;
}

/** NEAR number -> yoctoNEAR string. */
export function nearToYocto(near) {
  return (BigInt(Math.round(near * 1000)) * ONE_NEAR / 1000n).toString();
}

/**
 * Sign and broadcast a contract call.
 *
 * The action is built with @near-js/transactions because Wallet Selector v10
 * speaks that dialect, not the near-api-js v4 shape. Some older wallets still
 * reject it with "Unsupported NAJ action", so the legacy shape is tried as a
 * fallback before giving up.
 */
export async function call(wallet, method, args, deposit = '0') {
  const action = actionCreators.functionCall(
    method,
    args,
    BigInt('30000000000000'),
    BigInt(deposit)
  );

  try {
    return await wallet.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [action],
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/Unsupported NAJ action|unsupported action/i.test(msg)) throw err;

    return wallet.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [
        {
          type: 'FunctionCall',
          params: { methodName: method, args, gas: '30000000000000', deposit },
        },
      ],
    });
  }
}

/** Pull a transaction hash out of whatever shape the wallet returned. */
export function txHash(result) {
  const outcome = Array.isArray(result) ? result[0] : result;
  return (
    outcome?.transaction?.hash ||
    outcome?.transaction_outcome?.id ||
    outcome?.id ||
    ''
  );
}


/**
 * Sign and broadcast several calls as one transaction. The actions run in
 * order inside a single receipt, so a later action can use what an earlier
 * one created (claim the catch, then sell it) and a failure reverts them all.
 */
export async function callMany(wallet, calls) {
  const actions = calls.map(({ method, args, gas = 30, deposit = '0' }) =>
    actionCreators.functionCall(method, args, BigInt(gas) * 10n ** 12n, BigInt(deposit))
  );
  return wallet.signAndSendTransaction({ receiverId: CONTRACT, actions });
}

/** POST to the game server. */
export async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `server ${res.status}`);
  return json;
}


