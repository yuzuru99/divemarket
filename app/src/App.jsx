import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { connect, disconnect, restoreSession, onAccountChange, getWallet } from './wallet';
import { view, call, callMany, post, txHash, CONTRACT, yoctoToNear, nearToYocto, explain } from './contract';
import { BAIT, FISH, RODS, ROD_IDS, ZONES, baitTier, formatWeight, vaultBidBps, wearOf } from './game';
import { ZonePicker, StewardPanel, BaitShop } from './Zones';
import { RecordsPanel, TrophyRoom, TournamentPanel, SeasonBanner, FishdexPanel } from './Endgame';
import { Fishing } from './Fishing';
import { Market } from './Market';

export default function App() {
  const [page, setPage] = useState('game');
  const [who, setWho] = useState(null);
  const [status, setStatus] = useState('');
  const [season, setSeason] = useState(null);
  useEffect(() => {
    const load = () => view('current_season').then(setSeason).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Restore a wallet session saved by a previous page. Without this the user
  // reconnects every time they navigate.
  useEffect(() => {
    restoreSession().then((id) => {
      if (id) setWho(id);
    });
    return onAccountChange(setWho);
  }, []);

  const onConnect = useCallback(async () => {
    try {
      const id = await connect();
      setWho(id);
      setStatus('Wallet connected.');
    } catch (e) {
      setStatus(`Connect failed: ${e.message}`);
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    await disconnect();
    setWho(null);
    setStatus('Disconnected.');
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <nav>
          <button className={page === 'game' ? 'active' : ''} onClick={() => setPage('game')}>
            Play
          </button>
          <button className={page === 'market' ? 'active' : ''} onClick={() => setPage('market')}>
            Market
          </button>
        </nav>
        <div className="who">
          {who ? (
            <>
              <span className="addr">{who}</span>
              <button className="ghost" onClick={onDisconnect}>Disconnect</button>
            </>
          ) : (
            <button onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </header>

      {status && <div className="banner">{status}</div>}

      <SeasonBanner season={season} />

      {page === 'game'
        ? <Game who={who} setStatus={setStatus} onConnect={onConnect} season={season?.name || 'calm'} />
        : <Market who={who} setStatus={setStatus} />}
    </div>
  );
}

/** The fishing game: cast, strike, catch, then settle on-chain. */
const CATCH_FEE = '10000000000000000000000'; // 0.01 NEAR
const MAX_CLAIM = 40;

function loadReceipts(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function saveReceipts(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage blocked */ }
}

/** The bait a receipt burns when it is claimed: its own pick, else the zone's. */
const baitOf = (r) => r.bait || ZONES[r.zone_id]?.bait || null;

/** The best rod in a list, by tier, then by order in RODS. */
const bestRod = (ids) => ids.filter((r) => RODS[r]).reduce((b, r) => (b === null || RODS[r].tier > RODS[b].tier ? r : b), null);

/** A thin bar showing how much life a rod has left. */
function Durability({ left, total }) {
  const pct = total ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  return (
    <div className="dura" title={`${left} / ${total} durability`}>
      <div className={`dura-fill ${pct < 15 ? 'low' : pct < 40 ? 'mid' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Game({ who, setStatus, onConnect, season }) {
  const [ownedRaw, setOwned] = useState(null);
  const [life, setLife] = useState({});
  const [equipped, setEquipped] = useState(null);
  const [bait, setBait] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [escaped, setEscaped] = useState(0);
  const [prices, setPrices] = useState({});
  const [vault, setVault] = useState(0n);
  const [left, setLeft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [zones, setZones] = useState([]);
  const [zone, setZone] = useState('shallows');
  const [held, setHeld] = useState({});
  const [npcs, setNpcs] = useState([]);
  const [orders, setOrders] = useState([]);
  const [records, setRecords] = useState([]);
  const [bests, setBests] = useState({});
  const [mine, setMine] = useState({ trophies: 0, discount: 0 });
  const [boards, setBoards] = useState([[], []]);
  const [tourney, setTourney] = useState({ current: null, previous: null, entered: false });
  const [dex, setDex] = useState(null);
  const [docks, setDocks] = useState({});
  const [crews, setCrews] = useState({});
  const [poach, setPoach] = useState(false);
  const poachRef = useRef(false);
  poachRef.current = poach;
  const storeKey = who ? `dm:${CONTRACT}:${who}` : null;
  // A guest's catch: tickets the server judged but no account owns yet.
  const guestKey = `dm:${CONTRACT}:#guest`;
  const [tickets, setTickets] = useState(() => loadReceipts(guestKey));

  // Unclaimed receipts survive a refresh: they are the player's catch.
  // Receipts from before fish had weights can no longer be claimed.
  useEffect(() => {
    if (!storeKey) return setReceipts([]);
    const all = loadReceipts(storeKey);
    const valid = all.filter((r) => Number.isSafeInteger(r.weight_g));
    if (valid.length !== all.length) saveReceipts(storeKey, valid);
    setReceipts(valid);
  }, [storeKey]);

  // On connect, turn the guest catch into receipts for this account. It
  // needs a rod of the account's own, so it waits until one is bought.
  const ownsRod = !!ownedRaw?.length;
  useEffect(() => {
    if (!who || !storeKey || !ownsRod) return;
    const pending = loadReceipts(guestKey);
    if (!pending.length) return;
    post('/api/adopt', { player: who, tickets: pending })
      .then(({ receipts: adopted }) => {
        const next = [...loadReceipts(storeKey), ...adopted];
        saveReceipts(storeKey, next);
        saveReceipts(guestKey, []);
        setReceipts(next);
        setTickets([]);
        setStatus(`${adopted.length} fish from your guest session moved to ${who}.`);
      })
      .catch((e) => setStatus(`Could not move the guest catch: ${e.message}`));
  }, [who, storeKey, guestKey, setStatus, ownsRod]);

  // Two view calls per refresh: everything public, and everything about
  // this player. (A dozen separate views per player hit public RPC limits.)
  const refresh = useCallback(async () => {
    try {
      const [w, p] = await Promise.all([
        view('world_state', { trades: 5 }),
        who ? view('player_state', { player: who }) : null,
      ]);
      setPrices(Object.fromEntries(w.items.map((i) => [i.id, BigInt(i.fair_price)])));
      setVault(BigInt(w.vault));
      setZones(w.zones);
      setNpcs(w.npcs);
      setOrders(w.orders || []);
      setRecords(w.records);
      setBoards(w.leaderboards);
      setDocks(Object.fromEntries(w.docks.map(([z, n]) => [z, Number(n)])));
      setCrews(Object.fromEntries(w.crews));
      if (p) {
        setOwned(p.rods || []);
        setLife(Object.fromEntries((p.rod_status || []).map((s) => [s.id, s])));
        setLeft(p.catches_left);
        setHeld(Object.fromEntries(p.holdings.map(([i, n]) => [i, Number(n)])));
        setBests(Object.fromEntries(p.bests.map(([i, n]) => [i, Number(n)])));
        setMine({ trophies: Number(p.trophies), discount: Number(p.discount_bps) });
        setDex(p.fishdex);
      }
      setTourney({ current: w.tournament, previous: w.last_tournament, entered: !!p?.entered_this_week });
    } catch { /* offline, keep last values */ }
  }, [who]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const bestsRef = useRef(bests);
  bestsRef.current = bests;

  // The equipped rod is a per-browser choice among the rods owned on chain.
  const rodKey = who ? `dm:rod:${CONTRACT}:${who}` : null;
  useEffect(() => {
    if (!rodKey) return setEquipped(null);
    try { setEquipped(localStorage.getItem(rodKey)); } catch { setEquipped(null); }
  }, [rodKey]);
  const owned = ownedRaw || [];
  // Wear from catches still in the cooler, which lands on the rod at claim.
  const pendingWear = useMemo(() => {
    const n = {};
    for (const r of receipts) if (r.rod) n[r.rod] = (n[r.rod] || 0) + wearOf(r.item_id) * r.units;
    return n;
  }, [receipts]);
  const lifeLeft = (id) => Math.max(0, (life[id]?.left ?? RODS[id]?.durability ?? 0) - (pendingWear[id] || 0));
  const working = owned.filter((r) => lifeLeft(r) > 0);
  const rod = (equipped && owned.includes(equipped) ? equipped : bestRod(working) || bestRod(owned)) || 'bamboo';
  const equip = (id) => {
    setEquipped(id);
    try { if (rodKey) localStorage.setItem(rodKey, id); } catch { /* storage blocked */ }
  };
  const bestTier = Math.max(0, ...owned.map((r) => RODS[r]?.tier || 0));

  // Moving to a zone the equipped rod cannot fish swaps in the best one that can.
  useEffect(() => {
    const need = ZONES[zone].minRod;
    if (RODS[rod].tier < need && bestTier >= need) equip(bestRod(owned.filter((r) => RODS[r].tier >= need)));
  }, [zone, rod, bestTier]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bait still in the hold once the cooler's catch has been landed.
  const pendingBait = useMemo(() => {
    const n = {};
    for (const r of receipts) { const b = baitOf(r); if (b) n[b] = (n[b] || 0) + r.units; }
    return n;
  }, [receipts]);
  const spare = (id) => Math.max(0, (held[id] || 0) - (pendingBait[id] || 0));
  // A zone that needs bait gets the cheapest bait that qualifies.
  useEffect(() => {
    const need = ZONES[zone].bait;
    if (need && baitTier(bait) < baitTier(need)) setBait(need);
  }, [zone, bait]);

  // The scene's loop reads the zone through a ref, so switching zones never
  // restarts it.
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const gearRef = useRef({ rod, bait });
  gearRef.current = { rod, bait: who ? bait : null, hasRod: owned.length > 0, left: lifeLeft(rod), loaded: ownedRaw !== null };

  const api = useMemo(() => ({
    cast: async () => {
      const g = gearRef.current;
      if (who && g.loaded && !g.hasRod) throw new Error('Buy a Bamboo Rod (0.1 NEAR) to start fishing — see "Your first rod" below.');
      if (who && g.hasRod && g.left <= 0) throw new Error(`Your ${RODS[g.rod].name} is worn out. Bring your catch ashore, then repair it in the Rods panel.`);
      return post('/api/cast', {
      player: who || undefined, zone: zoneRef.current, poach: poachRef.current,
      rod: who ? gearRef.current.rod : undefined, bait: gearRef.current.bait || undefined,
      });
    },
    strike: (server, reactionMs) => post('/api/strike', { ...server, player: who || undefined, reactionMs }),
  }), [who]);

  const onResult = useCallback((r) => {
    if (r.hit && r.ticket) {
      setTickets((prev) => {
        const next = [...prev, r.ticket];
        saveReceipts(guestKey, next);
        return next;
      });
      setStatus('');
    } else if (r.hit) {
      if (r.weight > (bestsRef.current[r.fish] || 0)) {
        setStatus(`New personal best: ${formatWeight(r.weight)} ${FISH[r.fish].name}! It counts once you sell or keep the catch.`);
      }
      setReceipts((prev) => {
        const next = [...prev, r.receipt];
        if (storeKey) saveReceipts(storeKey, next);
        return next;
      });
      setStatus('');
    } else if (r.reason === 'warden') {
      setEscaped((n) => n + 1);
      setStatus('The warden chased you off. Poaching is a gamble.');
    } else if (r.reason === 'error') {
      setStatus(`Game server: ${r.error}`);
    } else {
      setEscaped((n) => n + 1);
    }
  }, [storeKey, guestKey, setStatus]);

  const haul = useMemo(() => {
    const by = {};
    for (const r of receipts) by[r.item_id] = (by[r.item_id] || 0) + r.units;
    for (const t of tickets) by[t.item_id] = (by[t.item_id] || 0) + 1;
    return by;
  }, [receipts, tickets]);
  const heaviest = useMemo(() => {
    const h = {};
    for (const r of [...receipts, ...tickets]) h[r.item_id] = Math.max(h[r.item_id] || 0, r.weight_g || 0);
    return h;
  }, [receipts, tickets]);
  const totalUnits = receipts.length + tickets.length;
  const valueOf = (id, q) => (prices[id] ? Number(prices[id] * BigInt(q)) / 1e6 : 0);
  const value = Object.entries(haul).reduce((a, [id, q]) => a + valueOf(id, q), 0);

  const run = async (label, method, args, deposit = '0') => {
    if (!who) return setStatus('Connect a wallet first.');
    try {
      setBusy(true);
      setStatus(`Signing ${label}…`);
      const wallet = await getWallet();
      const res = await call(wallet, method, args, deposit);
      setStatus(`${label} confirmed — ${txHash(res).slice(0, 12)}…`);
      refresh();
    } catch (e) {
      setStatus(`${label} failed: ${explain(e)}`);
      refresh();
    } finally { setBusy(false); }
  };

  /** Buy a rod (NEAR to the vault) or craft it (its recipe of fish is burned). */
  const getRod = async (id, craft) => {
    if (!who) return setStatus('Connect a wallet first.');
    try {
      setBusy(true);
      const wallet = await getWallet();
      await call(wallet, 'acquire_rod', { rod_id: id, craft }, craft ? '0' : nearToYocto(RODS[id].cost));
      setStatus(`${craft ? 'Crafted' : 'Bought'} the ${RODS[id].name} — confirmed.`);
      equip(id);
      refresh();
    } catch (e) {
      setStatus(`${craft ? 'Crafting' : 'Rod purchase'} failed: ${explain(e)}`);
    } finally { setBusy(false); }
  };
  const canCraft = (id) => Object.entries(RODS[id].recipe || {}).every(([f, n]) => spare(f) >= n);
  const canRepairFish = (id) => Object.entries(RODS[id].repairRecipe || {}).every(([f, n]) => spare(f) >= n);
  const repairRod = (id, withFish) => run(
    `repair the ${RODS[id].name}`, 'repair_rod', { rod_id: id, with_fish: withFish },
    withFish ? '0' : nearToYocto(RODS[id].repair),
  );
  const bid = vaultBidBps(vault);

  /**
   * Claim the catch and sell it in one transaction. Whatever the vault can
   * pay for is sold straight to it; the rest is listed for the NPCs to buy
   * with their own treasuries.
   */
  const settle = async (sell) => {
    if (!totalUnits || !who) return;
    // The contract lands receipts in order and burns one bait fish per
    // deep-water catch. Put bait-producing catches first, then take deep
    // catches only while there is bait to cover them; the rest wait.
    const stock = { ...held };
    const ordered = [...receipts].sort((x, y) => (baitOf(x) ? 1 : 0) - (baitOf(y) ? 1 : 0));
    const batch = [];
    for (const r of ordered) {
      if (batch.length >= MAX_CLAIM) break;
      const b = baitOf(r);
      if (b) {
        if ((stock[b] || 0) < r.units) continue;
        stock[b] -= r.units;
      }
      stock[r.item_id] = (stock[r.item_id] || 0) + r.units;
      batch.push(r);
    }
    if (!batch.length) return setStatus('Not enough bait to land these fish. Buy bait from Bob or catch some in the Shallows.');
    const inBatch = new Set(batch.map((r) => r.nonce));
    // Licenses depend on how thin each zone is right now; ask the contract,
    // then add 3% headroom for anyone else landing fish first. The excess is
    // refunded by the contract.
    const perZone = {};
    for (const r of batch) perZone[r.zone_id] = (perZone[r.zone_id] || 0) + r.units;
    let deposit = BigInt(CATCH_FEE);
    try {
      const q = await view('claim_quote', { counts: Object.entries(perZone), player: who });
      deposit = (BigInt(q) * 103n) / 100n;
    } catch { /* fall back to the fee alone; the contract will say if short */ }
    const calls = [{ method: 'claim_catches', args: { receipts: batch }, gas: 120, deposit: deposit.toString() }];
    if (sell) {
      const units = {};
      for (const r of batch) units[r.item_id] = (units[r.item_id] || 0) + r.units;
      // NPC orders pay above fair, so they go first, best price first.
      const week = Math.floor(Date.now() / (7 * 86_400_000));
      for (const o of [...orders].sort((a, b) => Number(BigInt(b.price) - BigInt(a.price)))) {
        const q = units[o.item_id] || 0;
        if (!q || o.units_left < 1 || Number(o.week) !== week) continue;
        const n = Math.min(q, Number(o.units_left));
        calls.push({ method: 'fill_order', args: { npc_id: o.npc_id, item_id: o.item_id, units: n }, gas: 30 });
        units[o.item_id] -= n;
      }
      // The vault pays 75% of fair. Leave a 15% margin: the sale moves the price.
      let budget = (vault * 85n) / 100n;
      const order = Object.entries(units).filter(([, q]) => q > 0).sort((a, b) => Number((prices[b[0]] || 0n) - (prices[a[0]] || 0n)));
      for (const [id, q] of order) {
        const unitYocto = ((prices[id] || 0n) * BigInt(bid) * 10n ** 24n) / 10_000n / 1_000_000n;
        const fit = unitYocto > 0n && bid > 0 ? Number(budget / unitYocto) : 0;
        const toVault = Math.min(q, fit);
        if (toVault > 0) {
          calls.push({ method: 'sell_to_market', args: { item_id: id, units: toVault }, gas: 20 });
          budget -= unitYocto * BigInt(toVault);
        }
        if (q - toVault > 0) calls.push({ method: 'list_fair', args: { item_id: id, units: q - toVault }, gas: 20 });
      }
    }
    try {
      setBusy(true);
      setStatus(sell ? `Selling ${batch.length} fish…` : `Bringing ${batch.length} fish ashore…`);
      const wallet = await getWallet();
      const res = await callMany(wallet, calls.slice(0, 11));
      const rest = receipts.filter((r) => !inBatch.has(r.nonce));
      setReceipts(rest);
      if (storeKey) saveReceipts(storeKey, rest);
      setStatus(`${sell ? 'Sold / listed' : 'Claimed'} ${batch.length} fish — ${txHash(res).slice(0, 12)}…`);
      refresh();
    } catch (e) {
      setStatus(`Settlement failed: ${explain(e)}`);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="hud">
        <div><span className="k">Rod</span><span className="v">{who && !owned.length ? 'none' : RODS[rod].name}{who && owned.includes(rod) && <small className="muted"> {lifeLeft(rod)}/{RODS[rod].durability}</small>}</span></div>
        <div><span className="k">Bait</span><span className="v">{who && bait ? `${FISH[bait].name} ×${spare(bait)}` : 'none'}</span></div>
        <div><span className="k">In the cooler</span><span className="v">{totalUnits}</span></div>
        <div><span className="k">Est. value</span><span className="v gold">{value.toFixed(3)}</span></div>
        <div><span className="k">Vault</span><span className="v">{yoctoToNear(vault)} <small className="muted" title="The vault pays 75% of fair while it holds 5 NEAR or more, and less as it runs low.">bids {Math.round(bid / 100)}%</small></span></div>
        <div><span className="k">Catches left today</span><span className="v">{left ?? '—'}</span></div>
        <div><span className="k">Escaped</span><span className="v">{escaped}</span></div>
      </div>

      <ZonePicker zones={zones} zone={zone} setZone={setZone} rodTier={bestTier} held={held} who={who} season={season} poach={poach} setPoach={setPoach} />

      {who && (
        <div className="bait-pick">
          <span className="k">Bait</span>
          {[null, ...Object.keys(BAIT)].map((id) => {
            const need = ZONES[zone].bait;
            const tooWeak = need && baitTier(id) < baitTier(need);
            const none = id && spare(id) < 1;
            const b = BAIT[id];
            return (
              <button key={id || 'none'} className={`chip ${bait === id ? 'active' : ''}`}
                disabled={tooWeak || none} onClick={() => setBait(id)}
                title={id ? `+${Math.round(b.rareBonus * 100)}% rare odds, +${Math.round(b.weightBonus * 100)}% weight. One burned per fish.` : 'No bait. Shallows only.'}>
                {id ? `${FISH[id].name} ×${spare(id)}` : 'None'}
                {id && <small> +{Math.round(b.rareBonus * 100)}% rare · +{Math.round(b.weightBonus * 100)}% kg</small>}
              </button>
            );
          })}
        </div>
      )}

      <Fishing rod={rod} zone={zone} disabled={false} api={api} onResult={onResult} />
      {!who && (
        <p className="muted guest-note">
          Playing as a guest with a loaner Bamboo rod — your catch is kept in this browser. Connect a testnet wallet and buy
          your own Bamboo Rod (0.1 NEAR) to bring it ashore and sell it.
        </p>
      )}
      {who && ownedRaw !== null && !owned.length && (
        <section className="panel first-rod">
          <h2>Your first rod</h2>
          <p>Every angler needs a rod of their own. The Bamboo Rod costs 0.1 NEAR (it goes to the market vault) and
            lands 200 fish before it needs a repair. {tickets.length > 0 && `Your ${tickets.length} guest fish come ashore as soon as you have it.`}</p>
          <button className="big" disabled={busy} onClick={() => getRod('bamboo', false)}>Buy Bamboo Rod · 0.1 NEAR</button>
        </section>
      )}

      <div className="cols">
        <section className="panel">
          <h2>Rods</h2>
          <div className="rods">
            {ROD_IDS.map((id) => {
              const r = RODS[id];
              const has = owned.includes(id);
              const recipe = Object.entries(r.recipe || {});
              return (
                <div key={id} className={`rod ${rod === id ? 'active' : has ? 'owned' : ''}`}>
                  <div>
                    <div className="name">{r.name} <span className="muted">· tier {r.tier}</span></div>
                    <div className="stat">
                      window {r.windowMs}ms · rare +{Math.round(r.rareBonus * 100)}%
                      {r.weightBonus > 0 && <> · weight +{Math.round(r.weightBonus * 100)}%</>}
                    </div>
                    <div className="stat">{r.blurb}</div>
                    {has && (
                      <>
                        <Durability left={lifeLeft(id)} total={r.durability} />
                        <div className="stat">
                          {lifeLeft(id)}/{r.durability} durability{pendingWear[id] ? ` (−${pendingWear[id]} in the cooler)` : ''}
                          {lifeLeft(id) === 0 && <b className="down"> · worn out</b>}
                        </div>
                      </>
                    )}
                    {r.needs && !has && <div className="stat">needs {r.needs}</div>}
                    {has && (life[id]?.left ?? r.durability) < r.durability && (
                      <div className="stat">repair: {r.repair} NEAR or {Object.entries(r.repairRecipe).map(([f, n]) => (
                        <span key={f} className={spare(f) >= n ? '' : 'down'}>{n} {FISH[f].name} ({spare(f)}) </span>
                      ))}</div>
                    )}
                    {!has && recipe.length > 0 && (
                      <div className="stat">craft: {recipe.map(([f, n]) => (
                        <span key={f} className={spare(f) >= n ? '' : 'down'}>{n} {FISH[f].name} ({spare(f)}) </span>
                      ))}</div>
                    )}
                  </div>
                  <div className="rod-actions">
                    {has
                      ? (
                        <>
                          {rod === id ? <button disabled>Equipped</button> : <button className="ghost" onClick={() => equip(id)}>Equip</button>}
                          {(life[id]?.left ?? r.durability) < r.durability && (
                            <>
                              <button className="ghost" disabled={busy} onClick={() => repairRod(id, false)}>Repair {r.repair} N</button>
                              <button className="ghost" disabled={busy || !canRepairFish(id)} onClick={() => repairRod(id, true)}>Repair w/ fish</button>
                            </>
                          )}
                        </>
                      )
                      : (
                        <>
                          {!r.craftOnly && <button disabled={busy || !who} onClick={() => getRod(id, false)}>{r.cost} NEAR</button>}
                          {recipe.length > 0 && <button className="ghost" disabled={busy || !who || !canCraft(id)} onClick={() => getRod(id, true)}>Craft</button>}
                        </>
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <h2>Catch</h2>
          {totalUnits === 0
            ? <p className="empty">Nothing caught yet — cast a line.</p>
            : (
              <table>
                <thead><tr><th>Fish</th><th>Rarity</th><th className="num">Qty</th><th className="num">Heaviest</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {Object.entries(haul).map(([id, q]) => (
                    <tr key={id}>
                      <td>{FISH[id].name}</td>
                      <td><span className={`rar ${FISH[id].rarity}`}>{FISH[id].rarity}</span></td>
                      <td className="num">{q}</td>
                      <td className={`num ${heaviest[id] > (bests[id] || 0) ? 'gold' : ''}`}>{heaviest[id] ? formatWeight(heaviest[id]) : '—'}</td>
                      <td className="num">{valueOf(id, q).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <div className="actions">
            <button className="big" onClick={() => (who ? settle(true) : onConnect())} disabled={busy || !totalUnits}>
              {who ? 'Sell catch' : 'Connect wallet to sell'}
            </button>
            <button className="ghost" onClick={() => settle(false)} disabled={busy || !totalUnits || !who}>Keep in inventory</button>
          </div>
          {totalUnits > MAX_CLAIM && <p className="muted">Up to {MAX_CLAIM} fish settle per transaction.</p>}
        </section>
      </div>

      <TournamentPanel who={who} current={tourney.current} previous={tourney.previous} entered={tourney.entered} busy={busy} run={run} />

      <TrophyRoom who={who} koi={held.koi || 0} trophies={mine.trophies} discountBps={mine.discount} boards={boards} zones={zones} busy={busy} run={run} />

      <RecordsPanel records={records} bests={bests} who={who} />

      <FishdexPanel dex={dex} who={who} />

      <BaitShop npcs={npcs} held={held} who={who} busy={busy} run={run} onError={(e) => { setStatus(explain(e)); refresh(); }} />

      <StewardPanel zones={zones} who={who} run={run} docks={docks} snapper={held.snapper || 0} crews={crews} />
    </>
  );
}

export { Market };








