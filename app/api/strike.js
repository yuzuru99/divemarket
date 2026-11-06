/**
 * POST /api/strike { player, castId, rod, issuedAt, biteDelay, token, reactionMs }
 *
 * Resolves a strike. `reactionMs` is how long after the bite the player
 * clicked, as the browser measured it. The server only accepts it if it is
 * consistent with its own clock: the request cannot arrive before the bite
 * plus the claimed reaction, and cannot arrive absurdly late.
 */
import { CONTRACT, GUEST, hmac, readBody, safeEqual, send, signReceipt, ticketMac, uniforms } from './_lib.js';
import { BAIT, RODS, ZONES, zoneHitChance, rollZoneFish, strikeQuality, weighFish, weightBonus } from '../src/game.js';

const CLOCK_SKEW_MS = 80;
const WARDEN_CHANCE = 0.3;
const POACH_BITE_BONUS = 0.15;
const MAX_NETWORK_MS = 2500;
const MAX_CAST_AGE_MS = 60_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = readBody(req);
  const { castId, rod, zone, health, season, poach, issuedAt, biteDelay, token, reactionMs } = body;
  const bait = body.bait || null;
  const player = body.player || GUEST;
  if (!RODS[rod] || !ZONES[zone] || (bait && !BAIT[bait]) || !Number.isSafeInteger(castId)) return send(res, 400, { error: 'bad cast' });

  const expected = hmac(`${player}|${castId}|${rod}|${zone}|${health}|${season}|${poach ? 1 : 0}|${bait || ''}|${issuedAt}|${biteDelay}`);
  if (!safeEqual(expected, token)) return send(res, 400, { error: 'cast token does not match' });

  const now = Date.now();
  if (now - issuedAt > MAX_CAST_AGE_MS) return send(res, 400, { error: 'cast expired' });
  const sinceBite = now - issuedAt - biteDelay;
  const reaction = Math.max(0, Number(reactionMs) || 0);

  if (sinceBite < reaction - CLOCK_SKEW_MS) return send(res, 400, { error: 'strike before the bite' });
  const windowMs = RODS[rod].windowMs;
  if (reaction > windowMs || sinceBite - reaction > MAX_NETWORK_MS) {
    return send(res, 200, { hit: false, reason: 'late' });
  }

  const quality = strikeQuality(reaction, windowMs);
  const h = Number(health) / 10_000;
  const [rHit, rFish, rWeight, rWarden] = uniforms(`${player}|${castId}`, 4);
  // Poaching: an undisturbed closed zone bites better, but the warden
  // chases off three poachers in ten.
  if (poach && rWarden < WARDEN_CHANCE) return send(res, 200, { hit: false, reason: 'warden', quality });
  const chance = Math.min(0.95, zoneHitChance(rod, quality) + (poach ? POACH_BITE_BONUS : 0));
  if (rHit >= chance) return send(res, 200, { hit: false, reason: 'escaped', quality });

  const fish = rollZoneFish(zone, rod, quality, h, rFish, season, bait);
  const weight = weighFish(fish, quality, rWeight, weightBonus(rod, bait));
  if (player === GUEST) {
    const ticket = { zone_id: zone, item_id: fish, nonce: castId, weight_g: weight, mac: ticketMac(zone, fish, castId, weight) };
    return send(res, 200, { hit: true, fish, weight, zone, quality, contract: CONTRACT, ticket });
  }
  const receipt = {
    zone_id: zone, item_id: fish, units: 1, nonce: castId, weight_g: weight, poached: !!poach, bait, rod,
    signature: signReceipt(player, zone, fish, 1, castId, weight, !!poach, bait, rod),
  };
  return send(res, 200, { hit: true, fish, weight, zone, bait, quality, contract: CONTRACT, receipt });
}



