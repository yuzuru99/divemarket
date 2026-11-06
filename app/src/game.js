/**
 * Fishing rules, shared by the browser and the game server.
 *
 * Pure logic: no DOM, no React, no network. The server imports this file to
 * decide every catch, and the browser imports it to show the same numbers, so
 * the two can never disagree about what a rod or a strike is worth.
 */

export const FISH = {
  guppy:   { name: 'Guppy',         rarity: 'common',    weight: 50, color: '#94a3b8', size: 14, minG: 20,   maxG: 120 },
  tilapia: { name: 'Tilapia',       rarity: 'uncommon',  weight: 25, color: '#4ade80', size: 17, minG: 300,  maxG: 1600 },
  snapper: { name: 'Snapper',       rarity: 'rare',      weight: 14, color: '#60a5fa', size: 20, minG: 800,  maxG: 4500 },
  tuna:    { name: 'Tuna',          rarity: 'epic',      weight: 8,  color: '#c084fc', size: 26, minG: 4000, maxG: 45000 },
  koi:     { name: 'Legendary Koi', rarity: 'legendary', weight: 3,  color: '#fbbf24', size: 30, minG: 2000, maxG: 9500 },
};

export const FISH_IDS = Object.keys(FISH);

/**
 * Rods. `tier` gates the zones (the contract's `rod_of` is the best tier a
 * player owns); within a tier, rods trade a wide strike window for heavier
 * fish. Rods wear out: every fish landed costs a point of durability (tuna
 * and koi cost 3), and a worn-out rod must be repaired with NEAR or fish
 * before it casts again. Mirrors the contract's RODS table.
 */
export const RODS = {
  bamboo:    { tier: 0, name: 'Bamboo Rod',    windowMs: 520, rareBonus: 0,    weightBonus: 0,    cost: 0.1, recipe: null,
               durability: 100, repair: 0.03, repairRecipe: { guppy: 8 },
               blurb: 'Cheap and honest. Every angler starts here. Shallows only.' },
  carbon:    { tier: 1, name: 'Carbon Rod',    windowMs: 720, rareBonus: 0.10, weightBonus: 0,    cost: 1.5, recipe: { snapper: 12 },
               durability: 200, repair: 0.45, repairRecipe: { snapper: 5 },
               blurb: 'Forgiving strike window. Opens the Coral Reef.' },
  spinner:   { tier: 1, name: 'Spinner Rod',   windowMs: 600, rareBonus: 0.05, weightBonus: 0.15, cost: 1.5, recipe: { snapper: 8, tilapia: 5 },
               durability: 150, repair: 0.45, repairRecipe: { snapper: 3, tilapia: 3 },
               blurb: 'Tighter timing, heavier fish, wears faster. For record hunters.' },
  master:    { tier: 2, name: 'Master Rod',    windowMs: 950, rareBonus: 0.25, weightBonus: 0,    cost: 6, recipe: { snapper: 25, tuna: 3 },
               durability: 250, repair: 1.8, repairRecipe: { snapper: 8, tuna: 1 },
               blurb: 'The widest window and the best odds. Opens the Abyss.' },
  harpoon:   { tier: 2, name: 'Harpoon',       windowMs: 760, rareBonus: 0.15, weightBonus: 0.30, cost: 6, recipe: { tuna: 4, koi: 1 },
               durability: 200, repair: 1.8, repairRecipe: { tuna: 2 },
               blurb: 'Fewer rares, far heavier fish. Built for the tournament.' },
  legendary: { tier: 2, name: 'Legendary Rod', windowMs: 900, rareBonus: 0.25, weightBonus: 0.20, cost: 0, recipe: { tuna: 5, koi: 2 },
               durability: 600, repair: 3, repairRecipe: { tuna: 3, koi: 1 }, craftOnly: true,
               needs: 'a mounted koi trophy and a personal-best tuna of 30 kg',
               blurb: 'Never sold. Crafted only by anglers with a trophy on the wall and a record tuna.' },
};
export const ROD_IDS = Object.keys(RODS);

/** Durability a landed fish costs the rod that caught it. */
export const wearOf = (fishId) => (fishId === 'tuna' || fishId === 'koi' ? 3 : 1);

/** What the vault pays, in basis points of fair: 75% at a 5 NEAR reserve, less below. */
export const VAULT_TARGET_YOCTO = 5n * 10n ** 24n;
export const vaultBidBps = (vault) => {
  const v = BigInt(vault || 0);
  return Number((7500n * (v < VAULT_TARGET_YOCTO ? v : VAULT_TARGET_YOCTO)) / VAULT_TARGET_YOCTO);
};

/** The cheapest rod of each tier, used to name a zone's requirement. */
export const ROD_BY_TIER = ['bamboo', 'carbon', 'master'];

/**
 * Bait. A zone needing tier N accepts any bait of tier N or better, and bait
 * is optional in open water. Each fish caught with bait burns one bait fish,
 * so bait is where common fish keep their value at endgame.
 */
export const BAIT = {
  guppy:   { tier: 1, rareBonus: 0.10, weightBonus: 0.10 },
  tilapia: { tier: 2, rareBonus: 0.20, weightBonus: 0.20 },
};
export const baitTier = (id) => (id && BAIT[id] ? BAIT[id].tier : 0);

/**
 * Fishing zones. The contract holds each zone's population and license; this
 * table is what lives there and who may fish it. Pools are ordered common to
 * rare, and a better rod shifts the roll toward the end of the pool.
 */
export const ZONES = {
  shallows: { name: 'Shallows', minRod: 0, bait: null, pool: { guppy: 60, tilapia: 30, snapper: 10 }, hue: '#13466b' },
  reef:     { name: 'Coral Reef', minRod: 1, bait: 'guppy', pool: { tilapia: 35, snapper: 40, tuna: 25 }, hue: '#0f5d63' },
  abyss:    { name: 'The Abyss', minRod: 2, bait: 'tilapia', pool: { snapper: 40, tuna: 45, koi: 6 }, hue: '#0b1f3d' },
};
export const ZONE_IDS = Object.keys(ZONES);

/**
 * Seasons rotate weekly by themselves: the season is the week number modulo 4,
 * the same formula the contract uses in `current_season`, so the game server,
 * the NPCs and the contract always agree without anyone choosing.
 */
export const WEEK_MS = 7 * 86_400_000;
export const SEASONS = {
  calm:     { name: 'Calm seas', blurb: 'Nothing unusual. A good week to fish anywhere.' },
  storm:    { name: 'Storm', blurb: 'The Abyss is too rough to fish. Shallows and Reef stay open.' },
  koi_run:  { name: 'Koi run', blurb: 'Koi are migrating through the Coral Reef this week.' },
  tuna_run: { name: 'Tuna run', blurb: 'Tuna bite twice as often, and Bob pays top price for them.' },
};
export const SEASON_ORDER = ['calm', 'storm', 'koi_run', 'tuna_run'];
export const seasonAt = (ms = Date.now()) => {
  const week = Math.floor(ms / WEEK_MS);
  return { week, id: SEASON_ORDER[week % 4], endsMs: (week + 1) * WEEK_MS };
};

/** A zone's fish pool this season. */
export function zonePool(zoneId, season = 'calm') {
  const pool = { ...ZONES[zoneId].pool };
  if (season === 'koi_run' && zoneId === 'reef') pool.koi = 5;
  if (season === 'tuna_run' && pool.tuna) pool.tuna *= 2;
  return pool;
}

/** Whether a zone can be fished this season. */
export const zoneOpen = (zoneId, season) => !(season === 'storm' && zoneId === 'abyss');

/** Koi only show up in a zone at least this healthy (population / capacity). */
export const KOI_MIN_HEALTH = 0.6;

/** A thin zone bites less: at 0% health the hit chance is 60% of normal. */
export function zoneHitChance(rodId, quality, health) {
  return hitChance(rodId, quality) * (0.6 + 0.4 * Math.max(0, Math.min(1, health)));
}

/** Which fish a strike in `zoneId` lands, for a uniform random `r` in [0, 1). */
export function rollZoneFish(zoneId, rodId, quality, health, r, season = 'calm', bait = null) {
  const pool = zonePool(zoneId, season);
  const ids = Object.keys(pool);
  const bonus = RODS[rodId].rareBonus + quality * 0.15 + (BAIT[bait]?.rareBonus || 0);
  const weights = ids.map((id, rank) => {
    if (id === 'koi' && health < KOI_MIN_HEALTH) return 0;
    return pool[id] * (1 + bonus * rank);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = r * total;
  for (let i = 0; i < ids.length; i++) {
    roll -= weights[i];
    if (roll <= 0 && weights[i] > 0) return ids[i];
  }
  return ids[0];
}

/**
 * Weight of a landed fish in grams, for a uniform random `r` in [0, 1).
 * Squaring `r` makes heavy fish rare; a clean strike adds up to 20% of the
 * species' range on top, so timing matters for records too. Rod and bait
 * weight bonuses scale the result, capped at the species' maximum.
 */
export function weighFish(fishId, quality, r, bonus = 0) {
  const f = FISH[fishId];
  const span = f.maxG - f.minG;
  const base = f.minG + span * r * r * (0.8 + 0.2 * Math.max(0, Math.min(1, quality)));
  return Math.round(Math.min(f.maxG, base * (1 + bonus)));
}

/** Combined weight bonus of a rod and a bait. */
export const weightBonus = (rodId, bait) => (RODS[rodId]?.weightBonus || 0) + (BAIT[bait]?.weightBonus || 0);

/** Grams to a readable weight: 85 g, 1.42 kg. */
export const formatWeight = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g} g`);

export const BITE_MIN_MS = 900;
export const BITE_SPAN_MS = 2600;

/** Timing quality from where in the window the strike landed (0..1). */
export function strikeQuality(elapsedMs, windowMs) {
  if (elapsedMs < 0 || elapsedMs > windowMs) return 0;
  const progress = elapsedMs / windowMs;
  return Math.max(0, 1 - Math.abs(progress - 0.5) * 2);
}

/**
 * Chance a strike lands. Base 55%, +25% for a perfect strike, plus the rod
 * bonus, capped at 95%: even the best rod and a perfect strike can miss.
 */
export function hitChance(rodId, quality) {
  return Math.min(0.95, 0.55 + quality * 0.25 + RODS[rodId].rareBonus);
}

/** Which fish a strike lands, for a uniform random `r` in [0, 1). */
export function rollFishWith(rodId, quality, r) {
  const bonus = RODS[rodId].rareBonus + quality * 0.15;
  const weights = FISH_IDS.map((k) => {
    const f = FISH[k];
    if (f.rarity === 'common') return f.weight * (1 - bonus);
    if (f.rarity === 'legendary') return f.weight * (1 + bonus * 4);
    return f.weight * (1 + bonus * 2);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = r * total;
  for (let i = 0; i < FISH_IDS.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return FISH_IDS[i];
  }
  return 'guppy';
}

// Convenience wrappers kept for tests and offline play.
export const biteDelay = () => BITE_MIN_MS + Math.random() * BITE_SPAN_MS;
export const strikeHits = (rodId, quality) => Math.random() < hitChance(rodId, quality);
export const rollFish = (rodId, quality) => rollFishWith(rodId, quality, Math.random());


