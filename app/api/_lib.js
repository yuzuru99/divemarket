/**
 * Game server helpers, shared by /api/cast and /api/strike.
 *
 * The server is the authority on every catch: it picks the bite time, checks
 * the strike timing, rolls the fish, and signs a one-fish receipt the
 * contract will accept exactly once. It is stateless; tokens are HMAC'd so a
 * client cannot edit them, and replays die on the contract's nonce set.
 */
import crypto from 'node:crypto';

export const CONTRACT = process.env.CONTRACT_ID || 'dm21.testnet';
const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of buf) { if (byte === 0) out = '1' + out; else break; }
  return out;
}
export function b58decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(n === 0n ? '' : hex, 'hex')]);
}

function secret(name) {
  const v = process.env[name];
  if (!v) throw new Error(`server misconfigured: ${name} missing`);
  return v;
}

export function hmac(text) {
  return crypto.createHmac('sha256', secret('CAST_HMAC_SECRET')).update(text).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Deterministic uniforms in [0,1) for a cast, so re-sending a strike cannot reroll it. */
export function uniforms(seedText, count) {
  const h = crypto.createHmac('sha256', secret('CAST_HMAC_SECRET')).update('roll|' + seedText).digest();
  return Array.from({ length: count }, (_, i) => h.readUInt32BE(i * 4) / 2 ** 32);
}

let signingKey;
function key() {
  if (!signingKey) {
    // NEAR secret key format: "ed25519:<base58 of seed(32) + public key(32)>".
    const raw = b58decode(secret('GAME_SIGNER_SECRET').replace(/^ed25519:/, ''));
    const seed = raw.subarray(0, 32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    signingKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
  return signingKey;
}

/** Sign the exact message the contract verifies in claim_catches. */
export function signReceipt(player, zoneId, itemId, units, nonce, weightG, poached = false, bait = null, rod = null) {
  const message = `catch:${CONTRACT}:${player}:${zoneId}:${itemId}:${units}:${nonce}:${weightG}`
    + (poached ? ':poached' : '') + (bait ? `:bait:${bait}` : '') + (rod ? `:rod:${rod}` : '');
  return b58encode(crypto.sign(null, Buffer.from(message), key()));
}

export async function view(method, args) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'srv', method: 'query',
      params: {
        request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT,
        method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const json = await res.json();
  if (json.error || json.result?.error) throw new Error('rpc view failed');
  return JSON.parse(Buffer.from(json.result.result).toString());
}

/** Placeholder player id for casts made before a wallet is connected. */
export const GUEST = '#guest';

/** A guest ticket: proof the server judged this catch, not yet bound to an account. */
export const ticketMac = (zone, item, nonce, weightG) => hmac(`ticket|${zone}|${item}|${nonce}|${weightG}`);

export const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}


