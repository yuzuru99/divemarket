import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { connect, disconnect, restoreSession, onAccountChange, getWallet } from './wallet';
import { view, call, callMany, post, txHash, CONTRACT, yoctoToNear, nearToYocto, explain } from './contract';
import { BAIT, FISH, RODS, ROD_IDS, ZONES, baitTier, floodAfter, formatWeight, vaultBidBps, wearOf } from './game';
import { ZonePicker, StewardPanel, BaitShop } from './Zones';
import { RecordsPanel, TrophyRoom, TournamentPanel, SeasonBanner, FishdexPanel, StandingCard, WeekBoards } from './Endgame';
import { Fishing } from './Fishing';
import { Market, NpcNote } from './Market';
import { isMuted, setMuted, onMuteChange } from './sound';

export default function App() {
  const [tab, setTab] = useState('fish');
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
        <a className="brand" href="/" aria-label="DiveMarket home">
          <Mark />
          <span className="wordmark">DiveMarket</span>
        </a>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => { setTab(t.id); window.scrollTo({ top: 0 }); }}>
              <TabIcon id={t.id} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="who">
          <span className="net-badge" title="DiveMarket runs on NEAR testnet. Test NEAR has no real value.">Testnet</span>
          {who ? (
            <>
              <span className="addr" title={who}>{who}</span>
              <button className="ghost sm" onClick={onDisconnect}>Disconnect</button>
            </>
          ) : (
            <button className="primary" onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </header>

      <SeasonBanner season={season} />

      <main>
        <Game who={who} setStatus={setStatus} onConnect={onConnect} season={season?.name || 'calm'} tab={tab} setTab={setTab} />
        {tab === 'market' && <Market who={who} setStatus={setStatus} />}
      </main>

      {status && (
        <div className="banner toast" role="status">
          <span>{status}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={() => setStatus('')}>×</button>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: 'fish', label: 'Fish' },
  { id: 'gear', label: 'Gear' },
  { id: 'market', label: 'Market' },
  { id: 'harbor', label: 'Harbor' },
  { id: 'ranks', label: 'Ranks' },
];

/** The DiveMarket mark: a bobber riding a wave. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#11414b" />
      <path d="M16 4v6" stroke="#e6f2ef" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 15a6 6 0 0 1 12 0z" fill="#ff6b2c" />
      <path d="M10 15h12a6 6 0 0 1-12 0z" fill="#e6f2ef" />
      <path d="M3 22c3 0 3-2 6.5-2S13 22 16 22s3-2 6.5-2S26 22 29 22" stroke="#58c79a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Small line icons for the section tabs (shown in the phone tab bar). */
function TabIcon({ id }) {
  const p = {
    fish: <path d="M3 12c3-4 7-6 11-6 3 0 5 2 7 6-2 4-4 6-7 6-4 0-8-2-11-6zm0 0-1-3m1 3-1 3M16 10.5v.01" />,
    gear: <path d="M5 21 19 3M19 3v6M5 21l-1-3m1 3 3-1M14 8l2 2" />,
    market: <path d="M4 9h16l-1 11H5L4 9zm3 0V7a5 5 0 0 1 10 0v2" />,
    harbor: <path d="M12 3v15m0-15a2 2 0 1 0 0 .01M6 12H3a9 9 0 0 0 18 0h-3M8 7h8" />,
    ranks: <path d="M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4m10-4h3a3 3 0 0 1-3 4" />,
  }[id];
  return <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
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

function Game({ who, setStatus, onConnect, season, tab, setTab }) {
  const [ownedRaw, setOwned] = useState(null);
  const [life, setLife] = useState({});
  const [equipped, setEquipped] = useState(null);
  const [bait, setBait] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [escaped, setEscaped] = useState(0);
  const [prices, setPrices] = useState({});
  const [vault, setVault] = useState(0n);
  // The vault's bid per fish after today's flood discount, in bps of fair.
  const [vaultBids, setVaultBids] = useState({});
  const [left, setLeft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [zones, setZones] = useState([]);
  const [zone, setZone] = useState('shallows');
  const [held, setHeld] = useState({});
  const [npcs, setNpcs] = useState([]);
  const [orders, setOrders] = useState([]);
  const [notes, setNotes] = useState([]);
  const [records, setRecords] = useState([]);
  const [bests, setBests] = useState({});
  const [mine, setMine] = useState({ trophies: 0, discount: 0 });
  const [boards, setBoards] = useState([[], []]);
  const [tourney, setTourney] = useState({ current: null, previous: null, entered: false });
  const [dex, setDex] = useState(null);
  // This week across every board: mine, and the open top-10 boards.
  const [myWeek, setMyWeek] = useState(null);
  const [weekBoards, setWeekBoards] = useState(null);
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
      setVaultBids(Object.fromEntries((w.vault_bids || []).map(([id, b]) => [id, Number(b)])));
      setZones(w.zones);
      setNpcs(w.npcs);
      setOrders(w.orders || []);
      setNotes(w.notes || []);
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
        setMyWeek(p.week || null);
      } else setMyWeek(null);
      setTourney({ current: w.tournament, previous: w.last_tournament, entered: !!p?.entered_this_week });
      view('week_boards', {}).then(setWeekBoards).catch(() => {});
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
      if (who && g.loaded && !g.hasRod) throw new Error('You need a rod of your own. Buy a Bamboo Rod for 0.1 NEAR above the water.');
      if (who && g.hasRod && g.left <= 0) throw new Error(`Your ${RODS[g.rod].name} is worn out. Bring your catch ashore, then repair it in Gear.`);
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
   * What "Sell catch" would do right now, in the same order as `settle`:
   * open NPC orders first (best price first), then the vault at its bid while
   * it can pay (keeping the same 15% margin), and the rest listed.
   */
  const sellPreview = useMemo(() => {
    const left = { ...haul };
    const week = Math.floor(Date.now() / (7 * 86_400_000));
    let total = 0;
    const toOrders = [];
    for (const o of [...orders].sort((p, q) => Number(BigInt(q.price) - BigInt(p.price)))) {
      const n = Math.min(left[o.item_id] || 0, Number(o.units_left));
      if (n < 1 || Number(o.week) !== week) continue;
      left[o.item_id] -= n;
      total += (Number(o.price) / 1e6) * n;
      toOrders.push(`${n} ${FISH[o.item_id]?.name.toLowerCase() || o.item_id} to ${o.npc_id[0].toUpperCase() + o.npc_id.slice(1)}`);
    }
    let budget = (vault * 85n) / 100n;
    let toVault = 0;
    let listed = 0;
    let vaultPaid = 0;
    let vaultFair = 0;
    for (const [id, q] of Object.entries(left).sort((x, y) => Number((prices[y[0]] || 0n) - (prices[x[0]] || 0n)))) {
      if (q < 1) continue;
      // Today's flood discount for this fish, priced at the middle of this sale like the contract.
      const factor = bid > 0 && vaultBids[id] !== undefined ? (vaultBids[id] * 10_000) / bid : 10_000;
      const bidOf = Math.round((bid * floodAfter(factor, Math.floor(q / 2))) / 10_000);
      const unitYocto = ((prices[id] || 0n) * BigInt(bidOf) * 10n ** 24n) / 10_000n / 1_000_000n;
      const fit = unitYocto > 0n ? Math.min(q, Number(budget / unitYocto)) : 0;
      budget -= unitYocto * BigInt(fit);
      toVault += fit;
      const fair = (Number(prices[id] || 0n) / 1e6) * fit;
      vaultFair += fair;
      vaultPaid += fair * (bidOf / 10_000);
      listed += q - fit;
    }
    total += vaultPaid;
    const vaultPct = vaultFair > 0 ? Math.round((vaultPaid / vaultFair) * 100) : Math.round(bid / 100);
    return { total, toOrders, toVault, listed, vaultPct };
  }, [haul, orders, prices, vault, bid, vaultBids]);

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

  const rarityRank = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };
  const tags = Object.entries(haul).sort((a, b) => rarityRank[FISH[a[0]].rarity] - rarityRank[FISH[b[0]].rarity]);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const needsFirstRod = who && ownedRaw !== null && !owned.length;

  return (
    <>
      {/* The sea stays mounted on every tab so a cast in flight is never lost. */}
      <div className="fish-layout" hidden={tab !== 'fish'}>
        <div className="sea-col">
          {needsFirstRod && (
            <section className="first-rod">
              <div>
                <h2>Get your first rod</h2>
                <p>Every angler needs a rod of their own. The Bamboo Rod costs 0.1 NEAR, paid into the market vault,
                  and lands about 100 fish before it needs a repair.{tickets.length > 0 && ` Your ${tickets.length} guest fish come ashore as soon as you have it.`}</p>
              </div>
              <button className="primary" disabled={busy} onClick={() => getRod('bamboo', false)}>Buy Bamboo Rod for 0.1 NEAR</button>
            </section>
          )}

          <ZonePicker part="tabs" zones={zones} zone={zone} setZone={setZone} rodTier={bestTier} held={held} who={who} season={season} poach={poach} setPoach={setPoach} />

          <div className="scene">
            <Fishing rod={rod} zone={zone} season={season} disabled={false} api={api} onResult={onResult} />
            <div className="scene-top">
              <SoundToggle />
            </div>
            <div className="scene-bottom">
              <span className="schip rod-chip">
                <b>{who && !owned.length ? 'No rod' : who ? RODS[rod].name : 'Loaner Bamboo'}</b>
                {who && owned.includes(rod) && (
                  <>
                    <Durability left={lifeLeft(rod)} total={RODS[rod].durability} />
                    <small>{lifeLeft(rod)}/{RODS[rod].durability}</small>
                  </>
                )}
              </span>
              {who && (
                <div className="bait-pick tray" role="group" aria-label="Bait">
                  {[null, ...Object.keys(BAIT)].map((id) => {
                    const need = ZONES[zone].bait;
                    const tooWeak = need && baitTier(id) < baitTier(need);
                    const none = id && spare(id) < 1;
                    const b = BAIT[id];
                    return (
                      <button key={id || 'none'} className={`chip ${bait === id ? 'active' : ''}`}
                        disabled={tooWeak || none} onClick={() => setBait(id)}
                        title={id ? `${pct(b.rareBonus)} better odds of a rare fish, ${pct(b.weightBonus)} heavier. One is used per fish.` : 'No bait. Open water only.'}>
                        {id ? <>{FISH[id].name} <small>×{spare(id)}</small></> : 'No bait'}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <ZonePicker part="detail" zones={zones} zone={zone} setZone={setZone} rodTier={bestTier} held={held} who={who} season={season} poach={poach} setPoach={setPoach} />
          {who && bait && (
            <p className="zone-detail">Bait: {FISH[bait].name} gives {pct(BAIT[bait].rareBonus)} better odds of a rare fish and {pct(BAIT[bait].weightBonus)} more weight. One is used per fish you land.</p>
          )}

          {notes.length > 0 && (
            // Harbor radio: each NPC's latest note (a new note replaces that
            // NPC's previous one), newest first.
            <section className="radio" aria-label="Harbor radio">
              <h2>Harbor radio <small>the latest word from each NPC</small></h2>
              <ol className="radio-list">
                {[...notes].sort((p, q) => Number(BigInt(q.at_ns) - BigInt(p.at_ns))).map((n) => (
                  <li key={n.npc_id}>
                    <NpcNote note={n} name={n.npc_id[0].toUpperCase() + n.npc_id.slice(1)} />
                  </li>
                ))}
              </ol>
            </section>
          )}

          {!who && (
            <ol className="howto">
              <li><b>Tap the water</b> to cast. You are fishing as a guest with a loaner rod.</li>
              <li><b>Tap again</b> when the closing ring meets the dashed one. That is the middle of the window, and it lands the best fish.</li>
              <li><b>Bring it ashore:</b> connect a testnet wallet and buy a Bamboo Rod for 0.1 NEAR to sell your catch.</li>
            </ol>
          )}
        </div>

        <aside className="cooler" aria-label="Cooler">
          <div className="cooler-head">
            <h2>Cooler</h2>
            <span className="cooler-count" data-testid="cooler-count">{totalUnits}</span>
          </div>
          <p className="cooler-sub">{totalUnits
            ? <>Selling now pays about <b className="brass">{sellPreview.total.toFixed(3)} NEAR</b>
                {': '}{[
                  sellPreview.toOrders.length ? `${sellPreview.toOrders.join(', ')} through NPC orders` : null,
                  sellPreview.toVault ? `${sellPreview.toVault} to the vault at ${sellPreview.vaultPct}% of fair` : null,
                  sellPreview.listed ? `${sellPreview.listed} listed for buyers` : null,
                ].filter(Boolean).join('; ')}. At fair price the catch is worth {value.toFixed(3)}.</>
            : 'Fish you land wait here until you bring them ashore.'}</p>
          {tags.length > 0 && (
            <ul className="tags">
              {tags.map(([id, q]) => {
                const f = FISH[id];
                const record = !!who && heaviest[id] > (bests[id] || 0);
                return (
                  <li key={`${id}-${q}`} className={`ctag ${f.rarity}`} style={{ '--fish': f.color }}>
                    <span className="hole" aria-hidden="true" />
                    <span className="ctag-name">{f.name}</span>
                    <span className="ctag-count">×{q}</span>
                    <span className="ctag-weight">{formatWeight(heaviest[id])}{record && <em> new best</em>}</span>
                    <span className="ctag-rarity">{f.rarity}</span>
                    <span className="ctag-value">{valueOf(id, q).toFixed(3)} N</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="actions">
            {/* Guest fish only come ashore on a rod of the player's own, so a
                connected player without one is sent to buy it, not to sell. */}
            {needsFirstRod ? (
              <button className="primary big" onClick={() => getRod('bamboo', false)} disabled={busy}>
                Buy Bamboo Rod to sell (0.1 NEAR)
              </button>
            ) : (
              <button className="primary big" onClick={() => (who ? settle(true) : onConnect())} disabled={busy || !totalUnits}>
                {who ? 'Sell catch' : 'Connect wallet to sell'}
              </button>
            )}
            <button className="ghost" onClick={() => settle(false)} disabled={busy || !totalUnits || !who || needsFirstRod}>Keep in inventory</button>
          </div>
          <div className="cooler-help">
            <p><b>Sell catch</b> brings your fish ashore and sells them in one go: first into NPC orders, which pay
              the most, then to the vault at up to {Math.round(bid / 100)}% of fair price (a little less for a fish it
              already bought a lot of today). Anything the vault cannot cover is listed for NPCs and other players.</p>
            <p><b>Keep in inventory</b> only brings them ashore, to use as bait, craft or repair rods, or sell
              yourself in Market.</p>
          </div>
          {totalUnits > MAX_CLAIM && <p className="muted">Up to {MAX_CLAIM} fish come ashore per transaction.</p>}
          <dl className="ledger">
            <div><dt>Catches left today</dt><dd>{left ?? '—'}</dd></div>
            <div><dt>Got away</dt><dd>{escaped}</dd></div>
            <div><dt title="The vault pays 75% of fair while it holds 5 NEAR or more, and less as it runs low.">Vault buys at</dt><dd>{Math.round(bid / 100)}% of fair</dd></div>
            <div><dt>Vault holds</dt><dd className="brass">{yoctoToNear(vault)} NEAR</dd></div>
          </dl>
        </aside>
      </div>

      {tab === 'gear' && (
        <div className="page">
          <header className="page-head">
            <h1>Gear</h1>
            <p>Rods wear out as they land fish: one point a fish, three for tuna and koi. Buy a rod with NEAR or craft it from
              your catch, and repair it the same way. Your best rod decides which zones you can fish.</p>
          </header>
          <div className="rods">
            {ROD_IDS.map((id) => {
              const r = RODS[id];
              const has = owned.includes(id);
              const recipe = Object.entries(r.recipe || {});
              const worn = has && (life[id]?.left ?? r.durability) < r.durability;
              return (
                <article key={id} className={`rod ${rod === id && has ? 'active' : has ? 'owned' : ''}`}>
                  <div className="rod-top">
                    <h3 className="name">{r.name}</h3>
                    <span className="tier">{r.tier === 0 ? 'Shallows' : r.tier === 1 ? 'Reef' : 'Abyss'}</span>
                  </div>
                  <p className="rod-blurb">{r.blurb}</p>
                  <dl className="rod-stats">
                    <div><dt>Window</dt><dd>{r.windowMs} ms</dd></div>
                    <div><dt>Rare</dt><dd>+{pct(r.rareBonus)}</dd></div>
                    <div><dt>Weight</dt><dd>+{pct(r.weightBonus)}</dd></div>
                    <div><dt>Durability</dt><dd>{r.durability}</dd></div>
                  </dl>
                  {has && (
                    <div className="rod-life">
                      <Durability left={lifeLeft(id)} total={r.durability} />
                      <span>{lifeLeft(id)} of {r.durability} left{pendingWear[id] ? `, ${pendingWear[id]} still in the cooler` : ''}
                        {lifeLeft(id) === 0 && <b className="down"> Worn out</b>}</span>
                    </div>
                  )}
                  {!has && r.needs && <p className="rod-needs">Needs {r.needs}.</p>}
                  {!has && recipe.length > 0 && (
                    <Recipe label="Craft from" items={recipe} spare={spare} />
                  )}
                  {worn && <Recipe label={`Repair for ${r.repair} NEAR, or`} items={Object.entries(r.repairRecipe)} spare={spare} />}
                  <div className="rod-actions">
                    {has ? (
                      <>
                        {rod === id ? <button disabled>Equipped</button> : <button className="ghost" onClick={() => equip(id)}>Equip</button>}
                        {worn && (
                          <>
                            <button className="primary" disabled={busy} onClick={() => repairRod(id, false)}>Repair for {r.repair} NEAR</button>
                            <button className="ghost" disabled={busy || !canRepairFish(id)} onClick={() => repairRod(id, true)}>Repair with fish</button>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {!r.craftOnly && <button className="primary" disabled={busy || !who} onClick={() => getRod(id, false)}>Buy for {r.cost} NEAR</button>}
                        {recipe.length > 0 && <button className="ghost" disabled={busy || !who || !canCraft(id)} onClick={() => getRod(id, true)}>Craft</button>}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <BaitShop npcs={npcs} held={held} who={who} busy={busy} run={run} onError={(e) => { setStatus(explain(e)); refresh(); }} />
        </div>
      )}

      {tab === 'harbor' && (
        <div className="page">
          <header className="page-head">
            <h1>Harbor</h1>
            <p>Harbor masters stake NEAR to run a zone and earn 30% of its licenses while it stays healthy. They can raise the
              fee, close the zone to let it recover, and build docks to make it bigger.</p>
          </header>
          <StewardPanel zones={zones} who={who} run={run} docks={docks} snapper={held.snapper || 0} crews={crews} />
        </div>
      )}

      {tab === 'ranks' && (
        <div className="page">
          <header className="page-head">
            <h1>Ranks</h1>
            <p>Where you stand this week, the tournament, the heaviest fish ever landed, and the koi on everyone's wall.</p>
          </header>
          <StandingCard who={who} week={myWeek} current={tourney.current} dex={dex} bests={bests} records={records} trophies={mine.trophies} releases={(boards?.[1] || []).find(([a]) => a === who)?.[1]} />
          <TournamentPanel who={who} current={tourney.current} previous={tourney.previous} entered={tourney.entered} busy={busy} run={run} />
          <WeekBoards who={who} boards={weekBoards} week={myWeek} />
          <RecordsPanel records={records} bests={bests} who={who} />
          <TrophyRoom who={who} koi={held.koi || 0} trophies={mine.trophies} discountBps={mine.discount} boards={boards} zones={zones} busy={busy} run={run} />
          <FishdexPanel dex={dex} who={who} />
        </div>
      )}
    </>
  );
}

/** Mute or unmute the scene's sound. */
function SoundToggle() {
  const [m, setM] = useState(isMuted());
  useEffect(() => onMuteChange(setM), []);
  return (
    <button className="sound" aria-pressed={!m} aria-label={m ? 'Turn sound on' : 'Turn sound off'} title={m ? 'Sound off' : 'Sound on'}
      onClick={() => setMuted(!m)}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9H4z" />
        {m ? <path d="m17 9 5 6m0-6-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
      </svg>
    </button>
  );
}

/** Fish a recipe needs, with how many of each you can spare right now. */
function Recipe({ label, items, spare }) {
  return (
    <div className="recipe">
      <span className="recipe-label">{label}</span>
      <ul>
        {items.map(([f, n]) => {
          const have = Math.min(spare(f), n);
          return (
            <li key={f} className={have >= n ? 'ready' : ''}>
              <span>{FISH[f].name}</span>
              <span className="recipe-n">{have}/{n}</span>
              <span className="recipe-bar"><span style={{ width: `${(have / n) * 100}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export { Market };








