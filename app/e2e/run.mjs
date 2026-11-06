/**
 * TEST-ONLY browser run: clicks the real UI against dm21.testnet and checks
 * every action's effect on chain. Usage: node e2e/run.mjs <account>
 */
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';

const P = process.argv[2];
const URL = 'http://127.0.0.1:5190/';
const RPCS = ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseExact = (t) => JSON.parse(t.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
async function view(method, args = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(RPCS[attempt % RPCS.length], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: 'dm21.testnet',
          method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
      const j = await r.json();
      if (j.result?.result) return parseExact(Buffer.from(j.result.result).toString());
    } catch { /* retry */ }
    await sleep(1500);
  }
  throw new Error(`view ${method} failed`);
}
const held = (item) => view('holdings', { player: P, item_id: item });

const dir = '/root/.cache/ms-playwright/' + readdirSync('/root/.cache/ms-playwright').find((d) => d.startsWith('chromium_headless_shell'));
const exe = dir + '/' + readdirSync(dir).find((d) => d.startsWith('chrome')) + '/chrome-headless-shell';
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

async function settled(prev, timeout = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = (await page.locator('.banner').textContent().catch(() => '')) || '';
    if (s !== prev && /confirmed|failed|Claimed|Sold|listed|Settlement/i.test(s) && !/Signing|Bringing|Selling/i.test(s)) return s;
    await sleep(500);
  }
  return 'TIMEOUT';
}
const banner = async () => (await page.locator('.banner').textContent().catch(() => '')) || '';
const step = async (name, click, check) => {
  try {
    const before = await banner();
    await click();
    const s = await settled(before);
    await sleep(2500); // let the chain view catch up
    const [ok, detail] = await check(s);
    rec(name, ok && !/failed|TIMEOUT/i.test(s), `${detail} | ${s.slice(0, 90)}`);
  } catch (e) { rec(name, false, String(e.message).slice(0, 160)); }
};

await page.goto(URL);
await sleep(7000);
rec('wallet shown as connected', ((await page.locator('.addr').textContent().catch(() => '')) || '').includes(P));

// ---- fishing: cast, strike on the bite, collect at least 2 fish
const before = Object.fromEntries(await Promise.all(['guppy', 'tilapia', 'snapper'].map(async (i) => [i, await held(i)])));
let hits = 0, casts = 0;
const landed = [];
const wearOf = (f) => (f === 'tuna' || f === 'koi' ? 3 : 1);
const rod0 = await view('rod_status', { player: P });
while (hits < 2 && casts < 10) {
  casts++;
  const castResp = page.waitForResponse((r) => r.url().includes('/api/cast'));
  await page.locator('canvas.sea').click({ position: { x: 700, y: 140 } });
  const cast = await (await castResp).json();
  if (cast.error) { rec(`cast ${casts}`, false, cast.error); break; }
  await sleep(Math.max(cast.biteDelay, 900) + 330);
  const strikeResp = page.waitForResponse((r) => r.url().includes('/api/strike'));
  await page.locator('canvas.sea').click({ position: { x: 500, y: 200 } });
  const s = await (await strikeResp).json();
  if (s.hit) { hits++; landed.push(s.fish); }
  console.log(`  cast ${casts}: ${s.hit ? `${s.fish} ${s.weight}g` : s.reason}`);
  await sleep(3200);
}
const cooler = await page.locator('.hud > div', { hasText: 'In the cooler' }).locator('.v').textContent();
rec('fishing: catches land in the cooler', Number(cooler) === hits && hits > 0, `${hits} hits in ${casts} casts, cooler shows ${cooler}`);

await step('claim catch (Keep in inventory)', () => page.getByRole('button', { name: 'Keep in inventory' }).click(), async () => {
  const after = Object.fromEntries(await Promise.all(['guppy', 'tilapia', 'snapper'].map(async (i) => [i, await held(i)])));
  const gained = Object.keys(after).reduce((s, k) => s + after[k] - before[k], 0);
  return [gained === hits, `gained ${gained} on chain`];
});
{
  const rod1 = await view('rod_status', { player: P });
  const worn = rod0.reduce((s, r) => s + r.left, 0) - rod1.reduce((s, r) => s + r.left, 0);
  const want = landed.reduce((s, f) => s + wearOf(f), 0);
  rec('the rod wears per fish landed', worn === want, `wear ${worn}, expected ${want}`);
}

// ---- market
await page.getByRole('button', { name: 'Market', exact: true }).click();
await page.locator('.trendcell').first().waitFor({ timeout: 20000 }).catch(() => {});
rec('market: price trend markers render', (await page.locator('.trendcell').count()) === 5, `${await page.locator('.trendcell').count()} rows`);
const yours = page.locator('section.panel', { hasText: 'Your fish' });
await yours.locator('tbody tr').first().waitFor({ timeout: 30000 });
const fishRow = yours.locator('tbody tr').first();
const fishName = ((await fishRow.locator('td').first().textContent()) || '').trim();
const fishId = { Guppy: 'guppy', Tilapia: 'tilapia', Snapper: 'snapper', Tuna: 'tuna', 'Legendary Koi': 'koi' }[fishName];
let h0 = await held(fishId);
await step(`list 1 ${fishId} for NPCs`, () => fishRow.getByRole('button', { name: 'List for NPCs' }).click(), async () => {
  const mine = (await view('open_listings')).filter(([, l]) => l.seller === P);
  return [mine.length > 0 && (await held(fishId)) === h0 - 1, `${mine.length} open listing(s)`];
});
await sleep(4000);
await step('cancel the listing', () => page.locator('section.panel', { hasText: 'Your listings' }).getByRole('button', { name: 'Cancel' }).first().click(), async () => {
  const mine = (await view('open_listings')).filter(([, l]) => l.seller === P);
  return [mine.length === 0 && (await held(fishId)) === h0, `holdings back to ${await held(fishId)}`];
});
// If an NPC bought the listing first, the cancel fails by design; the UI must say so in plain words.
const lastBanner = await banner();
if (/failed/.test(lastBanner)) rec('a failed cancel is explained in plain words', /an NPC probably bought it/.test(lastBanner), lastBanner.slice(0, 100));
await sleep(4000);
h0 = await held(fishId);
const vault0 = BigInt(await view('vault_balance'));
await step(`sell 1 ${fishId} to the vault`, () => yours.locator('tbody tr').first().getByRole('button', { name: 'Sell to vault' }).click(), async () => {
  const v = BigInt(await view('vault_balance'));
  return [(await held(fishId)) === h0 - 1 && v < vault0, `vault ${vault0} -> ${v}`];
});
await sleep(4000);
const prices = page.locator('section.panel', { hasText: 'Fish prices' });
const g0 = await held('guppy');
if (await prices.locator('tr', { hasText: 'Guppy' }).getByRole('button', { name: 'Buy 1' }).count()) {
  await step('buy 1 guppy from the cheapest NPC', () => prices.locator('tr', { hasText: 'Guppy' }).getByRole('button', { name: 'Buy 1' }).click(), async () => {
    const g = await held('guppy');
    return [g === g0 + 1, `guppy ${g0} -> ${g}`];
  });
} else rec('buy 1 guppy from the cheapest NPC', true, 'skipped: no NPC has guppy in stock right now');
await sleep(4000);
const orders0 = await view('orders');
const fillable = orders0.find((o) => o.units_left > 0 && ['guppy', 'tilapia', 'snapper'].includes(o.item_id));
if (fillable && (await held(fillable.item_id)) > 0) {
  const name = { guppy: 'Guppy', tilapia: 'Tilapia', snapper: 'Snapper' }[fillable.item_id];
  await step(`fill ${fillable.npc_id}'s ${fillable.item_id} order`, () => prices.locator('tr', { hasText: name }).getByRole('button', { name: 'Fill' }).click(), async () => {
    const o = (await view('orders')).find((x) => x.npc_id === fillable.npc_id && x.item_id === fillable.item_id);
    return [!o || o.units_left < fillable.units_left, `units left ${fillable.units_left} -> ${o ? o.units_left : 'closed'}`];
  });
  await sleep(4000);
} else rec('fill an order', true, 'skipped: no fillable order for fish held');
const inv0 = await view('investment_of', { npc_id: 'alice', investor: P });
await page.locator('#inv-alice').fill('0.1');
await step('invest 0.1 NEAR in Alice', () => page.locator('section.npc', { hasText: 'alice' }).getByRole('button', { name: /Invest/ }).click(), async () => {
  const inv = await view('investment_of', { npc_id: 'alice', investor: P });
  const p0 = BigInt(inv0?.principal || 0), p1 = BigInt(inv?.principal || 0);
  return [p1 - p0 === 10n ** 23n, `principal ${p0} -> ${p1}`];
});

// ---- play page: bait shop
await page.getByRole('button', { name: 'Play', exact: true }).click();
await sleep(6000);
const gb = await held('guppy');
const bait = page.locator('section.panel', { hasText: 'Bait shop' });
if (await bait.locator('tr', { hasText: 'Guppy' }).getByRole('button', { name: 'Buy 1' }).isEnabled()) {
  await step('bait shop: buy 1 guppy from Bob', () => bait.locator('tr', { hasText: 'Guppy' }).getByRole('button', { name: 'Buy 1' }).click(), async () => {
    const g = await held('guppy');
    return [g === gb + 1, `guppy ${gb} -> ${g}`];
  });
} else rec('bait shop: buy 1 guppy from Bob', true, 'skipped: Bob is out of guppy');

// ---- rods: all five shown with buy and craft options
rec('rods panel lists all six rods', (await page.locator('.rods .rod').count()) === 6, `${await page.locator('.rods .rod').count()} rods`);
if (!(await view('rods_of', { player: P })).includes('bamboo')) {
  await step('buy a Bamboo Rod for 0.1 NEAR', () => page.locator('.rod', { hasText: 'Bamboo Rod' }).getByRole('button', { name: '0.1 NEAR' }).click(), async () => {
    const rods = await view('rods_of', { player: P });
    return [rods.includes('bamboo'), rods.join(',')];
  });
  await sleep(3000);
}
await page.locator('.rod', { hasText: 'Bamboo Rod' }).getByRole('button', { name: 'Equip' }).click().catch(() => {});
await sleep(500);
const snap = await held('snapper');
if (snap >= 12 && !(await view('rods_of', { player: P })).includes('carbon')) {
  await step('craft a Carbon Rod from 12 snapper', () => page.locator('.rod', { hasText: 'Carbon Rod' }).getByRole('button', { name: 'Craft' }).click(), async () => {
    const rods = await view('rods_of', { player: P });
    return [rods.includes('carbon') && (await held('snapper')) === snap - 12, rods.join(',')];
  });
} else rec('craft a Carbon Rod', true, `skipped: ${snap} snapper or already owned`);

// ---- bait in open water: pick guppy, land one fish, the guppy is burned
if ((await held('guppy')) > 0) {
  await page.locator('.bait-pick button', { hasText: 'Guppy' }).click();
  await sleep(500);
  const burned0 = Number(await view('bait_burned', { item_id: 'guppy' }));
  let baitHit = null; let tries = 0; let sentBait = null;
  while (!baitHit && tries < 10) {
    tries++;
    const castResp = page.waitForResponse((r) => r.url().includes('/api/cast'));
    await page.locator('canvas.sea').click({ position: { x: 700, y: 140 } });
    const cr = await castResp;
    sentBait = JSON.parse(cr.request().postData() || '{}').bait;
    var sentRod = JSON.parse(cr.request().postData() || '{}').rod;
    const cast = await cr.json();
    if (cast.error) { rec('cast with bait', false, cast.error); break; }
    await sleep(Math.max(cast.biteDelay, 900) + 330);
    const strikeResp = page.waitForResponse((r) => r.url().includes('/api/strike'));
    await page.locator('canvas.sea').click({ position: { x: 500, y: 200 } });
    const s = await (await strikeResp).json();
    if (s.hit) baitHit = s;
    await sleep(3200);
  }
  rec('cast sends the chosen bait and the receipt is signed with it', sentBait === 'guppy' && baitHit?.receipt?.bait === 'guppy', `sent ${sentBait}, receipt ${baitHit?.receipt?.bait}`);
  rec('the equipped rod goes into the receipt', sentRod === 'bamboo' && baitHit?.receipt?.rod === 'bamboo', `sent ${sentRod}, receipt ${baitHit?.receipt?.rod}`);
  if (baitHit) {
    await step('claim a baited catch burns the bait', () => page.getByRole('button', { name: 'Keep in inventory' }).click(), async () => {
      const b = Number(await view('bait_burned', { item_id: 'guppy' }));
      return [b === burned0 + 1, `guppy burned ${burned0} -> ${b}`];
    });
  }
} else rec('cast with bait', true, 'skipped: no guppy');

// ---- repair: a worn bamboo is repaired for 0.03 NEAR, 15% of it into the tournament pot
await sleep(4000);
const bam = (await view('rod_status', { player: P })).find((r) => r.id === 'bamboo');
if (bam && bam.left < bam.durability) {
  const week = Math.floor(Date.now() / (7 * 86_400_000));
  const pot0 = BigInt((await view('tournament', { week })).pot);
  await step('repair the Bamboo Rod with NEAR', () => page.locator('.rod', { hasText: 'Bamboo Rod' }).getByRole('button', { name: /Repair 0.03/ }).click(), async () => {
    const b = (await view('rod_status', { player: P })).find((r) => r.id === 'bamboo');
    const pot = BigInt((await view('tournament', { week })).pot);
    return [b.left === b.durability && pot - pot0 === 4_500_000_000_000_000_000_000n, `left ${b.left}, pot +${pot - pot0}`];
  });
} else rec('repair the Bamboo Rod', true, 'skipped: not worn');

rec('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
