/**
 * POST /api/cast { player }
 *
 * Starts a cast with the rod and bait the player picked. The server checks on
 * chain that the rod is owned and the bait is in the hold, and picks when the
 * fish bites, so none of that can be faked by the client.
 */
import crypto from 'node:crypto';
import { ACCOUNT_RE, GUEST, hmac, readBody, send, view } from './_lib.js';
import { BAIT, BITE_MIN_MS, BITE_SPAN_MS, biteSlowdown, RODS, ROD_BY_TIER, ZONES, SEASONS, baitTier, seasonAt, zoneOpen } from '../src/game.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = readBody(req);
  const zone = body.zone || 'shallows';
  if (!ZONES[zone]) return send(res, 400, { error: 'unknown zone' });
  const season = seasonAt().id;
  if (!zoneOpen(zone, season)) return send(res, 409, { error: `${SEASONS[season].name}: ${ZONES[zone].name} cannot be fished this week` });
  // No account yet: fish as a guest. A guest's catch becomes a ticket that
  // the player cashes in after connecting a wallet (see /api/adopt).
  const guest = !body.player;
  const player = guest ? GUEST : body.player;
  if (!guest && (typeof player !== 'string' || player.length < 2 || player.length > 64 || !ACCOUNT_RE.test(player))) {
    return send(res, 400, { error: 'that is not a NEAR account id' });
  }

  const wanted = RODS[body.rod] ? body.rod : null;
  const bait = body.bait ? String(body.bait) : null;
  if (bait && !BAIT[bait]) return send(res, 400, { error: `${bait} is not bait` });
  if (guest && bait) return send(res, 403, { error: 'Connect a wallet to use bait — it is burned on chain.' });

  // Guests fish the Shallows with a loaner Bamboo rod; it never wears,
  // because their catch is only a ticket until a wallet that owns a rod
  // adopts it.
  let status = [];
  let z;
  let need;
  try {
    [status, z, need] = await Promise.all([
      guest ? [{ id: 'bamboo', left: 1, durability: 1 }] : view('rod_status', { player }),
      view('get_zone', { zone_id: zone }),
      view('zone_bait', { zone_id: zone }),
    ]);
    // The contract burns the bait at claim time; this is the friendly early
    // check so nobody fishes a batch they cannot cash.
    if (need && baitTier(bait) < baitTier(need)) {
      if (guest) return send(res, 403, { error: `${ZONES[zone].name} needs ${need} as bait — connect a wallet first` });
      return send(res, 403, { error: `${ZONES[zone].name} needs ${need} or better as bait. Catch some in the Shallows or buy from Bob.` });
    }
    if (bait) {
      const have = Number(await view('holdings', { player, item_id: bait })) || 0;
      if (have < 1) return send(res, 403, { error: `You have no ${bait} left to use as bait.` });
    }
  } catch {
    return send(res, 503, { error: 'cannot read the sea right now, try again' });
  }
  if (!z) return send(res, 400, { error: 'zone not open on this contract' });
  if (!status.length) return send(res, 403, { error: 'You need a rod first: buy a Bamboo Rod (0.1 NEAR) in the Rods panel.', needRod: true });
  // Default to the best working rod owned; an explicit pick must be owned
  // and not worn out.
  const working = status.filter((s) => s.left > 0 && RODS[s.id]);
  const pick = wanted ? status.find((s) => s.id === wanted) : null;
  if (wanted && !pick) return send(res, 403, { error: `You do not own a ${RODS[wanted].name}.` });
  if (pick && pick.left <= 0) return send(res, 403, { error: `Your ${RODS[wanted].name} is worn out. Repair it in the Rods panel.`, broken: wanted });
  if (!pick && !working.length) return send(res, 403, { error: 'All your rods are worn out. Repair one in the Rods panel.' });
  const rod = pick ? pick.id : working.reduce((b, s) => (RODS[s.id].tier > RODS[b].tier ? s.id : b), working[0].id);
  // A closed zone can still be fished by a poacher: the contract fines every
  // poached fish three licenses, paid to the harbor master.
  const poach = !!z.zone.closed;
  if (poach && !body.poach) return send(res, 409, { error: `${ZONES[zone].name} is closed by its harbor master. Turn on poaching to fish it anyway.` });
  if (poach && guest) return send(res, 403, { error: 'Connect a wallet to poach — fines are paid on chain.' });
  if (z.zone.population <= 0) return send(res, 409, { error: `${ZONES[zone].name} is fished out, let it recover` });
  if (RODS[rod].tier < ZONES[zone].minRod) return send(res, 403, { error: `${ZONES[zone].name} needs a ${RODS[ROD_BY_TIER[ZONES[zone].minRod]].name} or better` });
  // Health in basis points, frozen into the token so the roll uses the sea
  // as it was when the line went in.
  const health = Number(z.health_bps);

  // 48-bit nonce: unique per cast, safe as a JS number and a u64.
  const castId = crypto.randomBytes(6).readUIntBE(0, 6);
  const issuedAt = Date.now();
  // A scarce zone (below half health) bites less often: the wait stretches,
  // up to twice as long when the zone is nearly empty.
  const biteDelay = Math.round((BITE_MIN_MS + Math.random() * BITE_SPAN_MS) * biteSlowdown(health / 10_000));
  const token = hmac(`${player}|${castId}|${rod}|${zone}|${health}|${season}|${poach ? 1 : 0}|${bait || ''}|${issuedAt}|${biteDelay}`);

  return send(res, 200, { castId, rod, bait, zone, health, season, poach, issuedAt, biteDelay, windowMs: RODS[rod].windowMs, token });
}


