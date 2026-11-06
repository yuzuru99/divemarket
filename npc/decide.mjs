/**
 * DiveMarket NPC decision logic — pure, no network, no keys.
 *
 * This module is deliberately free of imports so it can be unit-tested
 * offline and reasoned about in isolation. `engine.mjs` wraps it with the
 * NEAR client and the broadcast step.
 */

const PRICE_SCALE = 1_000_000n;
const ONE_NEAR = 10n ** 24n;
const BPS = 10_000n;

/**
 * What each NPC is for. `wants` are the only items it buys, each with an extra
 * premium (bps) on top of its tolerance; `stocks` are items it always keeps on
 * offer for players, like a shop, whatever its edge on them.
 *
 *   Bob   — the canteen and bait shop: buys food fish, pays most for tuna,
 *           and sells guppy and tilapia as bait for deep-water anglers.
 *   Alice — the collector: buys snapper and koi, pays most for koi, and is
 *           where a player who never reaches the Abyss can buy a koi.
 *   John  — the shipwright's supplier: buys snapper as building material
 *           and keeps it on offer for harbor masters.
 */
export const ROLES = {
  bob:   { role: 'canteen & bait shop', wants: { guppy: 0n, tilapia: 0n, tuna: 500n }, stocks: ['guppy', 'tilapia'] },
  alice: { role: 'collector',           wants: { snapper: 200n, koi: 500n },           stocks: ['koi', 'snapper'] },
  john:  { role: 'shipwright supplier', wants: { snapper: 300n },                      stocks: ['snapper'] },
};

export const PERSONALITIES = {
  bob: {
    label: 'aggressive',
    buyToleranceBps: 1_500n,
    sellToleranceBps: 1_000n,
    aggressionBps: 4_000n,
    reserveBps: 1_000n,
    minEdgeBps: 200n,
  },
  alice: {
    label: 'conservative',
    buyToleranceBps: 300n,
    sellToleranceBps: 300n,
    aggressionBps: 1_500n,
    reserveBps: 5_000n,
    minEdgeBps: 500n,
  },
  john: {
    label: 'opportunist',
    buyToleranceBps: 800n,
    sellToleranceBps: 1_200n,
    aggressionBps: 2_500n,
    reserveBps: 2_500n,
    minEdgeBps: 100n,
  },
};

/**
 * Rarity price multipliers, mirroring the contract's `rarity_price_bps`.
 * A legendary item is worth 60x a common one before any market movement.
 */
const RARITY_BPS = [1_000n, 3_000n, 10_000n, 30_000n, 60_000n];

const rarityBps = (item) => RARITY_BPS[Number(item.rarity)] ?? 1_000n;

/**
 * The contract's fair-price formula, reproduced exactly.
 *
 * Prefer the contract's own `fair_price` from market_snapshot: the contract
 * rolls its pricing window by block timestamp, so a value recomputed here can
 * disagree with the one the contract enforces — and an NPC that decides
 * against a different price than the contract uses gets its trade refused.
 * This function is the fallback for when no snapshot is available.
 */
export function fairPriceOf(item) {
  if (item.fair_price !== undefined) return BigInt(item.fair_price);
  const demand =
    BPS + (BigInt(item.npc_buy_volume) * 6_000n) / 20n;
  const supply =
    BPS - (BigInt(item.listed_supply) * 2_500n) / 100n;
  const scarcity =
    BPS - (BigInt(item.npc_sell_volume) * 2_000n) / 100n;
  const event = BigInt(item.event_modifier_bps);
  const rarity = RARITY_BPS[Number(item.rarity)] ?? 1_000n;

  const d = demand > 50_000n ? 50_000n : demand;
  const s = supply < 4_000n ? 4_000n : supply;
  const sc = scarcity < 4_000n ? 4_000n : scarcity;

  let price = BigInt(item.base_price);
  price = (price * rarity) / BPS;
  price = (price * d) / BPS;
  price = (price * s) / BPS;
  price = (price * sc) / BPS;
  price = (price * event) / BPS;
  return price < 1n ? 1n : price;
}

/** Listings live 30 minutes on chain (LISTING_TTL_SECONDS); keep a minute of margin. */
const LISTING_TTL_MS = 29 * 60_000;

export function decide(npcId, npc, items, listings, roles = ROLES) {
  const p = PERSONALITIES[npcId];
  if (!p) return { action: 'HOLD', reason: `no personality for ${npcId}` };

  const treasury = BigInt(npc.treasury);
  const spendable = (treasury * (BPS - p.reserveBps)) / BPS;

  // --- SELL: do we hold anything worth selling? -------------------------
  for (const lot of npc.inventory) {
    const item = items.find((i) => i.id === lot.item_id);
    if (!item) continue;

    const fair = BigInt(fairPriceOf(item));
    const avgCost = BigInt(lot.unit_cost);
    const edgeBps =
      avgCost === 0n ? 0n : ((fair - avgCost) * BPS) / avgCost;

    // Sell when the edge clears this NPC's minimum.
    const clearsEdge = edgeBps >= p.minEdgeBps;

    // Or cut the loss: a position held at a loss ties up treasury the NPC
    // cannot spend, so it is dead money. The old check compared treasury
    // against a fraction of itself, which is never true -- so a losing
    // position was held forever and the NPC stopped trading entirely.
    const underwater = edgeBps < 0n;
    const mustLiquidate = underwater && lot.units > 0;

    // A shop keeps its staples on the shelf regardless of edge, and always
    // at a margin over what it paid: that margin is the shop's living, and
    // what its investors are paid from. Staples are never dumped at a loss.
    const staple = (roles[npcId]?.stocks || []).includes(lot.item_id);

    if ((clearsEdge || mustLiquidate || staple) && lot.units > 0) {
      const units = lot.units;
      // Ask a little above fair, inside the undercut band...
      let ask = (fair * (BPS + p.sellToleranceBps)) / BPS;
      // ...but a staple never sells for less than cost plus the shop margin.
      if (staple) {
        const margin = shopMarginBps(stockOf(npc, lot.item_id), SHELF_CAP[npcId]?.[lot.item_id]);
        const floor = (avgCost * (BPS + margin)) / BPS;
        if (ask < floor) ask = floor;
      }
      // An ask is a standing offer: a sale needs a player to pay it. If the
      // NPC already has an ask close to this one, re-posting it changes
      // nothing, so move on and look for something to buy instead.
      const posted = (npc.asks || []).find(([id]) => id === lot.item_id);
      if (posted) {
        const prev = BigInt(posted[1]);
        const driftBps = prev === 0n ? BPS : ((prev > ask ? prev - ask : ask - prev) * BPS) / prev;
        if (driftBps <= 200n) continue;
      }
      return {
        action: 'SELL',
        itemId: lot.item_id,
        units,
        askPrice: ask,
        reason: staple
          ? `shelf: ${lot.item_id} at ${ask} (cost ${avgCost} + margin)`
          : mustLiquidate
          ? `cutting a ${edgeBps}bps loss on ${lot.item_id} to free treasury`
          : `edge ${edgeBps}bps >= min ${p.minEdgeBps}bps on ${lot.item_id}`,
      };
    }
  }

  // --- BUY: is there a listing worth taking? ----------------------------
  // Listings arrive as [globalIndex, listing] pairs: the contract looks them
  // up by their position in the full vector, closed entries included, so a
  // filtered list without the real index asks for the wrong listing.
  const wants = roles[npcId]?.wants;
  for (const [globalIndex, l] of listings) {
    const item = items.find((it) => it.id === l.item_id);
    if (!item) continue;
    // An NPC only buys what it has a use for, and only while its shelf has room.
    if (wants && !(l.item_id in wants)) continue;
    const cap = SHELF_CAP[npcId]?.[l.item_id];
    const room = cap === undefined ? Infinity : cap - stockOf(npc, l.item_id);
    if (room <= 0) continue;
    // The contract refuses listings past their 30-minute life; skip them.
    if (Number(l.created_ns) > 0 && Date.now() * 1e6 - Number(l.created_ns) > LISTING_TTL_MS * 1e6) continue;
    const premium = wants ? wants[l.item_id] : 0n;

    const fair = BigInt(fairPriceOf(item));
    const ask = BigInt(l.ask_price);
    const premiumBps = fair === 0n ? 0n : ((ask - fair) * BPS) / fair;

    // The contract refuses an ask more than 20% above the fair price, so a
    // listing outside that band is dead weight — skip it rather than burn
    // gas on a call that cannot succeed.
    const ceiling = (fair * (BPS + 2_000n)) / BPS;
    if (ask > ceiling) continue;

    // Only buy at or below this NPC's tolerance.
    if (premiumBps > p.buyToleranceBps + premium) continue;

    // And only when there is a way out. An NPC that buys without any prospect
    // of selling is just moving its treasury into inventory, and every such
    // trade is a loss the moment the price mean-reverts.
    //
    // Two ways out, either is enough:
    //   1. Real demand — players have been buying from NPCs, so there is a
    //      buyer. (NPC-to-NPC volume does not count: it is inventory churn,
    //      and counting it lets an NPC justify stock it can never sell.)
    //   2. The ask is at or below the item's base price, so the NPC is buying
    //      at a discount to the anchor rather than speculating on a higher
    //      price.
    //
    // The second matters for cold start: with no demand yet, a strict
    // demand-only rule means nobody ever buys, so nobody ever has inventory
    // to sell, so demand never appears. The market needs a maker before it
    // has a taker.
    const demand = BigInt(item.player_buy_volume || 0);
    const base = BigInt(item.base_price) * rarityBps(item) / 10_000n;
    const atOrBelowBase = ask <= base;
    if (demand === 0n && !atOrBelowBase) continue;

    // Size the order: a fraction of spendable, capped by what is listed.
    const budget = (spendable * p.aggressionBps) / BPS;
    const perUnit = (ask * ONE_NEAR) / PRICE_SCALE;
    if (perUnit === 0n) continue;
    let units = Number(budget / perUnit);
    units = Math.min(units, l.units, room);
    if (units <= 0) continue;

    return {
      action: 'BUY',
      listingIndex: globalIndex,
      units,
      reason: `${l.item_id} at ${premiumBps}bps premium <= ${p.buyToleranceBps}bps tolerance`,
    };
  }

  return { action: 'HOLD', reason: 'nothing inside this NPC\'s tolerance' };
}






/**
 * Each NPC's weekly order, by role and season. A pure function of public
 * state, like `decide`: it names the order, the engine posts it, and the
 * contract checks the price band and locks the escrow.
 *
 *   Bob   wants tilapia for the canteen, or tuna (at +20%) in a tuna run.
 *   Alice wants koi, a few more of them in a koi run.
 *   John  wants snapper for the shipyard.
 */
/**
 * What each NPC orders, as escrowed buy orders players fill with their fish.
 *
 * Standing orders are the NPC's everyday needs and are reposted as soon as
 * they fill, so there is always somewhere to sell the staple fish: Bob buys
 * guppy and tilapia to restock his bait shop, Alice buys koi for her
 * collection, John buys snapper for dock timber. The weekly order follows
 * the season and is posted once per week.
 */
/** A shop's margin over cost on its staples: 12% normally... */
export const SHOP_MARGIN_BPS = 1_200n;
/** ...sliding to 4% as the shelf fills up, so old stock still sells at a profit. */
export const MIN_SHOP_MARGIN_BPS = 400n;

/**
 * How much of each staple a shop will hold. A shop stops buying when its
 * shelf is full, so its treasury never drains into fish nobody buys.
 */
export const SHELF_CAP = {
  bob: { guppy: 30, tilapia: 30, tuna: 10 },
  alice: { koi: 4, snapper: 15 },
  john: { snapper: 25, tilapia: 15 },
};

/** Units of an item an NPC holds, across its lots. */
export const stockOf = (npc, item) =>
  (npc.inventory || []).filter((l) => l.item_id === item).reduce((s, l) => s + Number(l.units), 0);

/** The shop margin at a given fill level: 12% up to half full, then down to 4% when full. */
export function shopMarginBps(stock, cap) {
  if (!cap || stock <= cap / 2) return SHOP_MARGIN_BPS;
  const k = Math.min(1, (stock - cap / 2) / (cap / 2));
  const span = Number(SHOP_MARGIN_BPS - MIN_SHOP_MARGIN_BPS);
  return SHOP_MARGIN_BPS - BigInt(Math.round(span * k));
}

const ORDER_PLANS = {
  bob: (season) => [
    { item: 'guppy',   units: 20, premiumBps: 500n, budgetBps: 1_500n, standing: true },
    { item: 'tilapia', units: 10, premiumBps: 500n, budgetBps: 2_000n, standing: true },
    season === 'tuna_run'
      ? { item: 'tuna', units: 10, premiumBps: 2_000n, budgetBps: 3_000n, standing: false }
      : { item: 'tuna', units: 3,  premiumBps: 1_500n, budgetBps: 2_000n, standing: false },
  ],
  alice: (season) => [
    { item: 'koi', units: season === 'koi_run' ? 4 : 2, premiumBps: 1_000n, budgetBps: 4_000n, standing: true },
    { item: 'snapper', units: season === 'storm' ? 10 : 6, premiumBps: 500n, budgetBps: 2_000n, standing: true },
  ],
  john: (season) => [
    { item: 'snapper', units: 15, premiumBps: 500n, budgetBps: 3_000n, standing: true },
    { item: 'tilapia', units: season === 'storm' ? 12 : 6, premiumBps: 1_000n, budgetBps: 1_500n, standing: false },
  ],
};

/** Price and size one order plan against the NPC's treasury. */
function sizeOrder(npcId, npc, items, plan) {
  const p = PERSONALITIES[npcId];
  if (!plan || !p) return null;
  const item = items.find((i) => i.id === plan.item);
  if (!item) return null;
  const fair = BigInt(fairPriceOf(item));
  const price = (fair * (BPS + plan.premiumBps)) / BPS;
  const spendable = (BigInt(npc.treasury) * (BPS - p.reserveBps)) / BPS;
  const budget = (spendable * plan.budgetBps) / BPS;
  const perUnit = (price * ONE_NEAR) / PRICE_SCALE;
  if (perUnit === 0n) return null;
  const units = Math.min(plan.units, Number(budget / perUnit));
  if (units < 1) return null;
  return { itemId: plan.item, units, price, standing: plan.standing };
}

/** Smallest order a shop posts while it has shelf room, even with no recent sales. */
const MIN_ORDER_UNITS = 5;

/**
 * The orders an NPC should (re)post now, given what is open. A standing order
 * is reposted when it is missing, filled, or from an older week; a weekly
 * order once per week (`posted` maps item → week it was last posted), so
 * filling it ends the deal until next week.
 *
 * Sizes are bounded three ways: the plan, the room left on the shelf
 * (SHELF_CAP minus stock), and recent demand (`sold`: units players bought
 * from this NPC in the last week; the shop buys about 1.5x what it sells).
 * `ai` may adjust premium and size per item, but only inside those bounds.
 */
export function planOrders(npcId, npc, items, season, open, week, posted = {}, opts = {}) {
  const { sold, ai } = opts;
  const plans = ORDER_PLANS[npcId]?.(season) || [];
  const out = [];
  for (const base of plans) {
    const o = open.find((x) => x.npc_id === npcId && x.item_id === base.item);
    const stale = !o || Number(o.week) < Number(week);
    const empty = o && Number(o.units_left) === 0;
    if (!(stale || (base.standing && empty))) continue;
    // A filled order is closed on chain, so "missing" can mean "done":
    // a weekly order already posted this week is not posted again.
    if (!base.standing && !o && Number(posted[base.item]) === Number(week)) continue;
    const plan = boundPlan(npcId, npc, base, sold, ai);
    if (!plan) continue;
    const sized = sizeOrder(npcId, npc, items, plan);
    if (sized) out.push(sized);
  }
  return out;
}

/** Apply the shelf cap, recent demand and any AI adjustment to one plan. */
export function boundPlan(npcId, npc, base, sold, ai) {
  const cap = SHELF_CAP[npcId]?.[base.item];
  const room = cap === undefined ? base.units : cap - stockOf(npc, base.item);
  if (room <= 0) return null;
  let units = Math.min(base.units, room);
  if (sold) units = Math.min(units, Math.max(MIN_ORDER_UNITS, Math.ceil((sold[base.item] || 0) * 1.5)));
  let premiumBps = base.premiumBps;
  const a = ai?.[base.item];
  if (a) {
    if (Number.isFinite(a.units)) units = Math.max(0, Math.min(units, Math.floor(a.units)));
    if (Number.isFinite(a.premiumBps)) premiumBps = BigInt(Math.max(0, Math.min(2_000, Math.round(a.premiumBps))));
  }
  if (units < 1) return null;
  return { ...base, units, premiumBps };
}

/** What a plan looks like before bounds, for the AI to reason about. */
export const plansFor = (npcId, season) => ORDER_PLANS[npcId]?.(season) || [];

/** The NPC's seasonal weekly order (kept for callers that want just one). */
export function planOrder(npcId, npc, items, season) {
  const plan = (ORDER_PLANS[npcId]?.(season) || []).find((x) => !x.standing);
  return sizeOrder(npcId, npc, items, plan);
}
