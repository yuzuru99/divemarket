/**
 * NPC brains on NEAR AI Cloud.
 *
 * Once an hour each NPC asks a model on NEAR AI Cloud (OpenAI-compatible
 * API) how to run its shop this week: what premium to pay and how much to
 * buy of each staple, plus a one-line market note for players. The answer is
 * advice, never authority:
 *
 *  - `sanitizePlan` keeps only the NPC's own items and clamps every number;
 *  - `boundPlan` (decide.mjs) then caps sizes by shelf room and recent sales;
 *  - the contract still enforces price bands, reserves and escrow.
 *
 * So a confused model can make an NPC more cautious, never reckless. With no
 * API key, or on any error, the NPC runs on its rules and says so.
 */
import { readFileSync } from 'node:fs';
import { ROLES, SHELF_CAP, stockOf, plansFor } from './decide.mjs';

const BASE = process.env.NEAR_AI_URL || 'https://cloud-api.near.ai/v1';
const MODEL = process.env.NEAR_AI_MODEL || 'z-ai/glm-5.3-flash';
const KEY_FILE = process.env.NEAR_AI_KEY_FILE || new URL('../.secrets/near-ai.key', import.meta.url).pathname;
const TIMEOUT_MS = 60_000;

export function apiKey() {
  if (process.env.NEAR_AI_API_KEY) return process.env.NEAR_AI_API_KEY.trim();
  try { return readFileSync(KEY_FILE, 'utf8').trim() || null; } catch { return null; }
}

const PERSONA = {
  bob: 'Bob runs the canteen and the bait shop. He needs guppy and tilapia on his shelf for anglers heading to deep water, and tuna for the canteen.',
  alice: 'Alice is a collector. She buys koi and snapper and resells them to anglers who want a koi without diving the Abyss, or snapper to craft rods.',
  john: 'John supplies the shipyard. He buys snapper (rods and docks are built from it) and tilapia in storm weeks.',
};

/**
 * Pull a plan out of a model reply and make it safe: the first JSON object in
 * the text, only `allowed` items, integer premiums in 0..2000 bps and units in
 * 0..100, and a note of at most 200 characters on one line. Null if unusable.
 */
export function sanitizePlan(text, allowed) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const orders = {};
  for (const [item, o] of Object.entries(raw.orders || {})) {
    if (!allowed.includes(item) || !o || typeof o !== 'object') continue;
    const premium = Number(o.premium_bps ?? o.premiumBps);
    const units = Number(o.units);
    const entry = {};
    if (Number.isFinite(premium)) entry.premiumBps = Math.max(0, Math.min(2_000, Math.round(premium)));
    if (Number.isFinite(units)) entry.units = Math.max(0, Math.min(100, Math.floor(units)));
    if (Object.keys(entry).length) orders[item] = entry;
  }
  const note = typeof raw.note === 'string'
    ? raw.note.replace(/\s+/g, ' ').trim().slice(0, 200)
    : '';
  return { orders, note };
}

/** The note an NPC posts when it runs on rules alone. */
export function rulesNote(npcId, npc, season) {
  const caps = SHELF_CAP[npcId] || {};
  const shelf = Object.entries(caps).map(([item, cap]) => `${item} ${stockOf(npc, item)}/${cap}`).join(', ');
  const wants = plansFor(npcId, season).map((p) => `${p.item} at +${Number(p.premiumBps) / 100}%`).join(', ');
  return `Buying ${wants}. Shelf: ${shelf}.`;
}

/**
 * Ask NEAR AI Cloud for this NPC's plan. `ctx` is plain market data. Returns
 * a sanitized plan, or null on any failure (the caller falls back to rules).
 */
export async function think(npcId, ctx) {
  const key = apiKey();
  if (!key) return null;
  const allowed = plansFor(npcId, ctx.season).map((p) => p.item);
  const system = [
    `You run an NPC shop in DiveMarket, a fishing game with a real on-chain economy on NEAR testnet.`,
    PERSONA[npcId] || '',
    `Goal: never lose money, keep your shelf useful to players, and leave anglers a fair profit.`,
    `You post buy orders for fish at fair price plus a premium (0 to 2000 basis points), and resell to players at cost plus a margin.`,
    `Pay more when your shelf is low or a season raises demand; pay less and buy fewer when your shelf is filling up or nobody bought last week.`,
    `Reply with JSON only: {"orders": {"<fish>": {"premium_bps": <int>, "units": <int>}}, "note": "<one friendly sentence for players, under 160 characters, about what you are buying and why>"}.`,
    `Only these fish: ${allowed.join(', ')}.`,
  ].join(' ');
  const user = JSON.stringify({
    npc: npcId,
    role: ROLES[npcId]?.role,
    season: ctx.season,
    treasury_near: ctx.treasuryNear,
    shelf: Object.fromEntries(Object.entries(SHELF_CAP[npcId] || {}).map(([i, cap]) => [i, { held: stockOf(ctx.npc, i), cap }])),
    sold_to_players_last_7_days: ctx.sold,
    fair_price_near: ctx.fair,
    default_plan: plansFor(npcId, ctx.season).map((p) => ({ fish: p.item, premium_bps: Number(p.premiumBps), units: p.units, standing: p.standing })),
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 1500,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.log(`[${npcId}] NEAR AI ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const json = await res.json();
    return sanitizePlan(json.choices?.[0]?.message?.content || '', allowed);
  } catch (e) {
    console.log(`[${npcId}] NEAR AI unreachable: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
