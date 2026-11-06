/**
 * POST /api/adopt { player, tickets: [{ zone_id, item_id, nonce, mac }] }
 *
 * Turns a guest's catch into receipts for the account that just connected.
 * Each ticket keeps its nonce, and the contract spends a nonce once across all
 * players, so a ticket can be cashed by exactly one account.
 */
import { ACCOUNT_RE, readBody, safeEqual, send, signReceipt, ticketMac, view } from './_lib.js';
import { ZONES, FISH, RODS } from '../src/game.js';

const MAX_TICKETS = 200;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const { player, tickets } = readBody(req);
  if (typeof player !== 'string' || !ACCOUNT_RE.test(player) || player.length > 64) {
    return send(res, 400, { error: 'connect a NEAR account first' });
  }
  if (!Array.isArray(tickets) || tickets.length === 0) return send(res, 400, { error: 'no tickets' });
  if (tickets.length > MAX_TICKETS) return send(res, 400, { error: `at most ${MAX_TICKETS} tickets at once` });

  // A guest fished with a loaner. Bringing that catch ashore needs a rod
  // of your own, so a free guest session cannot mint fish for an account
  // that never paid for one.
  let status = [];
  try { status = await view('rod_status', { player }); } catch { return send(res, 503, { error: 'cannot read the sea right now, try again' }); }
  if (!status.length) return send(res, 403, { error: 'Buy a Bamboo Rod (0.1 NEAR) to bring your guest catch ashore.', needRod: true });
  // The catch wears a rod of the player's own, like any other: the Bamboo Rod
  // if it still has life, else the lowest-tier rod that does. Without this a
  // guest session would be a way to land fish without wearing any rod.
  const working = status.filter((s) => s.left > 0 && RODS[s.id]).sort((a, b) => RODS[a.id].tier - RODS[b.id].tier);
  if (!working.length) return send(res, 403, { error: 'All your rods are worn out. Repair one in Gear to bring your guest catch ashore.' });
  const rod = (working.find((s) => s.id === 'bamboo') || working[0]).id;

  const receipts = [];
  const rejected = [];
  for (const t of tickets) {
    const ok = t && ZONES[t.zone_id] && FISH[t.item_id] && Number.isSafeInteger(t.nonce)
      && Number.isSafeInteger(t.weight_g)
      && safeEqual(ticketMac(t.zone_id, t.item_id, t.nonce, t.weight_g), t.mac);
    if (!ok) { rejected.push(t?.nonce ?? null); continue; }
    receipts.push({
      zone_id: t.zone_id, item_id: t.item_id, units: 1, nonce: t.nonce, weight_g: t.weight_g, rod,
      signature: signReceipt(player, t.zone_id, t.item_id, 1, t.nonce, t.weight_g, false, null, rod),
    });
  }
  return send(res, 200, { receipts, rejected });
}

