/**
 * The market: where fish turn into NEAR and back.
 *
 * Every number here is read from the contract. Prices are the contract's
 * fair price; NPC asks and orders are standing offers backed by each NPC's
 * own treasury; the solvency strip shows that everything the contract owes
 * is covered by what it holds.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { view, call, callMany, txHash, toNear, yoctoToNear, nearToYocto, explain, freshAsk } from './contract';
import { getWallet } from './wallet';
import { FISH, vaultBidBps } from './game';
import { short } from './names';

const NPC_INFO = {
  bob:   { role: 'Canteen & bait shop', style: 'aggressive', blurb: 'Always buying guppy and tilapia to restock his bait shelf, and tuna for the canteen. Sells bait to deep-water fishers.' },
  alice: { role: 'Collector', style: 'conservative', blurb: 'Always buying koi and snapper, and reselling both: where you buy a koi without diving the Abyss, or the snapper for your next rod.' },
  john:  { role: 'Shipwright supplier', style: 'opportunist', blurb: 'Always buying snapper for the shipyard (docks and rods are built from it), plus tilapia in storm weeks.' },
};
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const FEED = {
  npc_buy: (t) => `bought ${t.units} ${t.item_id} from ${t.counterparty}`,
  player_buy: (t) => `sold ${t.units} ${t.item_id} to ${t.counterparty}`,
  player_sell: (t) => `vault paid ${t.counterparty} for ${t.units} ${t.item_id}`,
  order_fill: (t) => `order filled: ${t.units} ${t.item_id} from ${t.counterparty}`,
  p2p: (t) => `sold ${t.units} ${t.item_id} to ${t.counterparty}`,
};

/** Listings live 30 minutes on chain (LISTING_TTL_SECONDS). */
const LISTING_TTL_MS = 30 * 60_000;
/**
 * The most an NPC will pay over fair for each fish today: its buy tolerance
 * plus the premium its role puts on that fish (npc/decide.mjs).
 */
const NPC_MAX_BPS = { guppy: 1_500, tilapia: 1_500, tuna: 2_000, snapper: 1_100, koi: 800 };

/** How long a listing has left, and how its price sits against fair now. */
function listingInfo(l, items) {
  const leftMs = Number(BigInt(l.created_ns) / 1_000_000n) + LISTING_TTL_MS - Date.now();
  const it = items.find((i) => i.id === l.item_id);
  const fair = it ? BigInt(it.fair_price) : 0n;
  const overBps = fair > 0n ? Number(((BigInt(l.ask_price) - fair) * 10_000n) / fair) : 0;
  const npcMax = fair > 0n ? (fair * BigInt(10_000 + (NPC_MAX_BPS[l.item_id] ?? 0))) / 10_000n : 0n;
  return { leftMs, expired: leftMs <= 0, overBps, npcMax, tooHigh: BigInt(l.ask_price) > npcMax };
}
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))} min`;
/**
 * Price history per fish, oldest first, from the fair price the contract
 * recorded at each trade, ending with the current fair price.
 */
function historyOf(id, trades, current) {
  const past = trades.filter((t) => t.item_id === id).map((t) => Number(t.fair_price)).reverse();
  return [...past.slice(-11), Number(current)];
}

function Sparkline({ points }) {
  if (points.length < 2) return <span className="spark muted">·</span>;
  const w = 64, h = 18, min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - min) / span) * (h - 2) - 1}`).join(' ');
  const up = points[points.length - 1] >= points[0];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={d} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" />
    </svg>
  );
}

/** Change from the previous recorded price to now, as an arrow and a percent. */
function Trend({ points }) {
  if (points.length < 2) return <span className="trend muted">—</span>;
  const prev = points[points.length - 2], now = points[points.length - 1];
  if (prev === now) return <span className="trend muted">0.0%</span>;
  const pct = ((now - prev) / prev) * 100;
  return <span className={`trend ${pct > 0 ? 'up' : 'down'}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%</span>;
}


export function Market({ who, setStatus }) {
  const [items, setItems] = useState([]);
  const [npcs, setNpcs] = useState([]);
  const [trades, setTrades] = useState([]);
  const [orders, setOrders] = useState([]);
  const [listings, setListings] = useState([]);
  const [solvency, setSolvency] = useState(null);
  const [notes, setNotes] = useState([]);
  const [stakes, setStakes] = useState({});
  const [supply, setSupply] = useState([]);
  const [held, setHeld] = useState({});
  const [qty, setQty] = useState({});
  const [busy, setBusy] = useState(false);
  // Flash a price cell green or red when it changes between refreshes.
  const lastPrice = useRef({});
  const [flash, setFlash] = useState({});

  // Two view calls per refresh: the whole world, and this player.
  const refresh = useCallback(async () => {
    try {
      const [w, p] = await Promise.all([
        view('world_state', { trades: 30 }),
        who ? view('player_state', { player: who }) : null,
      ]);
      const changed = {};
      for (const it of w.items) {
        const before = lastPrice.current[it.id];
        if (before !== undefined && String(before) !== String(it.fair_price)) changed[it.id] = BigInt(it.fair_price) > BigInt(before) ? 'flash-up' : 'flash-down';
        lastPrice.current[it.id] = it.fair_price;
      }
      setFlash(changed);
      setItems(w.items); setNpcs(w.npcs); setTrades(w.trades); setOrders(w.orders); setListings(w.listings); setSolvency(w.solvency); setNotes(w.notes || []); setSupply(w.supply || []);
      if (p) setHeld(Object.fromEntries(p.holdings.map(([i, n]) => [i, Number(n)])));
      if (who) {
        const ids = w.npcs.map((n) => n.id);
        const invs = await Promise.all(ids.map((id) => view('investment_of', { npc_id: id, investor: who }).catch(() => null)));
        setStakes(Object.fromEntries(ids.map((id, k) => [id, invs[k]])));
      }
    } catch { /* offline, keep last data */ }
  }, [who]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  /** Several calls in one signature, e.g. claim profit then invest more. */
  const runMany = async (label, calls) => {
    if (!who) return setStatus('Connect a wallet first.');
    setBusy(true);
    setStatus(`Signing ${label}…`);
    try {
      const wallet = await getWallet();
      const res = await callMany(wallet, calls);
      setStatus(`${label} confirmed — ${txHash(res).slice(0, 12)}…`);
      refresh();
    } catch (e) {
      setStatus(`${label} failed: ${explain(e)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const run = async (label, method, args, deposit = '0') => {
    if (!who) return setStatus('Connect a wallet first.');
    setBusy(true);
    setStatus(`Signing ${label}…`);
    try {
      const wallet = await getWallet();
      const res = await call(wallet, method, args, deposit);
      setStatus(`${label} confirmed — ${txHash(res).slice(0, 12)}…`);
      refresh();
    } catch (e) {
      setStatus(`${label} failed: ${explain(e)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // Cheapest NPC ask and richest open order per fish.
  const bestAsk = (id) => {
    let best = null;
    for (const n of npcs) {
      const a = n.asks?.find(([i]) => i === id);
      const stock = n.inventory.filter((l) => l.item_id === id).reduce((s, l) => s + l.units, 0);
      if (a && stock > 0 && (!best || BigInt(a[1]) < BigInt(best.price))) best = { npc: n.id, price: a[1], stock };
    }
    return best;
  };
  const bestOrder = (id) =>
    orders.filter((o) => o.item_id === id && o.units_left > 0)
      .sort((a, b) => Number(BigInt(b.price) - BigInt(a.price)))[0] || null;
  const q = (id) => Math.max(1, Number(qty[id]) || 1);

  const mine = listings.filter(([, l]) => l.seller === who);
  const total = (k) => (solvency ? yoctoToNear(solvency[k]) : '—');

  return (
    <>
      <div className="hud">
        <div><span className="k">Vault</span><span className="v">{total('vault')}</span></div>
        <div><span className="k">NPC treasuries</span><span className="v">{total('npc_treasuries')}</span></div>
        <div><span className="k">Order escrow</span><span className="v">{total('order_escrow')}</span></div>
        <div><span className="k">Tournament pots</span><span className="v">{total('tournaments')}</span></div>
        <div><span className="k">Harbor stakes</span><span className="v">{total('stewards')}</span></div>
        <div title={solvency ? `holds ${yoctoToNear(solvency.balance)} · owes ${yoctoToNear(solvency.liabilities)} + storage ${yoctoToNear(solvency.storage)}` : ''}>
          <span className="k">Solvent</span>
          <span className={`v ${solvency?.solvent ? 'up' : 'down'}`}>{solvency ? (solvency.solvent ? 'yes' : 'NO') : '—'}</span>
        </div>
      </div>

      <section className="panel">
        <h2>Fish prices</h2>
        <p className="muted">
          Fair price is computed by the contract from on-chain counters: NPC buying pushes it up,
          listings, vault sales and NPC stock push it down, and the pressure fades each hour. Buy
          straight from the cheapest NPC, or sell into the richest open order.
        </p>
        <table className="prices">
          <thead>
            <tr>
              <th>Fish</th><th>Rarity</th><th className="num">Fair</th><th>Trend</th>
              <th>Cheapest NPC</th><th>Best order</th>{who && <th className="num">You hold</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const ask = bestAsk(i.id);
              const ord = bestOrder(i.id);
              return (
                <tr key={i.id}>
                  <td className="p-name">{i.name}</td>
                  <td className="p-rar"><span className={`rar ${RARITY[i.rarity]}`}>{RARITY[i.rarity]}</span></td>
                  <td data-label="Fair" className={`num p-fair ${flash[i.id] || ''}`} title={`supply ${i.listed_supply} listed · NPC stock ${i.npc_inventory} · NPC buys this hour ${i.npc_buy_volume}`}>{toNear(i.fair_price)}</td>
                  <td className="trendcell p-trend"><Sparkline points={historyOf(i.id, trades, i.fair_price)} /> <Trend points={historyOf(i.id, trades, i.fair_price)} /></td>
                  <td data-label="Buy from" className="p-ask">
                    {ask ? (
                      <span className="offer">
                        {toNear(ask.price)} · {ask.npc} ({ask.stock})
                        <button className="ghost sm" disabled={!who || busy}
                          onClick={async () => {
                            try {
                              const f = await freshAsk(ask.npc, i.id);
                              run(`buy 1 ${i.id}`, 'buy_from_npc', { npc_id: ask.npc, item_id: i.id, units: 1, max_price: f.max }, f.cost(1));
                            } catch (e) { setStatus(explain(e)); refresh(); }
                          }}>
                          Buy 1
                        </button>
                      </span>
                    ) : <span className="muted">none</span>}
                  </td>
                  <td data-label="Sell to" className="p-ord">
                    {ord ? (
                      <span className="offer">
                        {toNear(ord.price)} · {ord.npc_id} wants {ord.units_left}
                        <button className="ghost sm" disabled={!who || busy || !(held[i.id] > 0)}
                          onClick={() => run(`fill ${ord.npc_id}'s order`, 'fill_order', { npc_id: ord.npc_id, item_id: i.id, units: Math.min(held[i.id] || 0, ord.units_left) })}>
                          Fill
                        </button>
                      </span>
                    ) : <span className="muted">none</span>}
                  </td>
                  {who && <td data-label="You hold" className="num p-held">{held[i.id] || 0}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Player listings</h2>
        <p className="muted">Fish other anglers have listed. Buy straight from them: the NEAR goes to the seller, and the listing
          closes after 30 minutes. NPCs buy from here too, when the price suits them.</p>
        {(() => {
          const open = listings.filter(([, l]) => l.seller !== who).map(([i, l]) => [i, l, listingInfo(l, items)]).filter(([, , s]) => !s.expired);
          if (!open.length) return <p className="empty">No listings right now. List fish from your inventory and other players can buy them here.</p>;
          return (
            <table className="p2p">
              <thead><tr><th>Seller</th><th>Fish</th><th className="num">Price each</th><th className="num">vs fair</th><th className="num">Closes in</th><th /></tr></thead>
              <tbody>
                {open.map(([idx, l, s]) => {
                  const buy = (n) => run(`buy ${n} ${l.item_id} from ${short(l.seller)}`, 'buy_listing',
                    { listing_index: idx, units: n, max_price: String(l.ask_price) },
                    ((BigInt(l.ask_price) * BigInt(n) * 10n ** 24n) / 1_000_000n).toString());
                  return (
                    <tr key={idx}>
                      <td>{short(l.seller)}</td>
                      <td>{l.units} {FISH[l.item_id]?.name || l.item_id}</td>
                      <td className="num">{toNear(l.ask_price)}</td>
                      <td className={`num ${s.overBps > 0 ? 'down' : 'up'}`}>{s.overBps > 0 ? '+' : ''}{(s.overBps / 100).toFixed(1)}%</td>
                      <td className="num">{minutes(s.leftMs)}</td>
                      <td className="p2p-actions">
                        <button className="ghost sm" disabled={!who || busy} onClick={() => buy(1)}>Buy 1</button>
                        <button className="ghost sm" disabled={!who || busy || l.units < 2} onClick={() => buy(l.units)}>Buy all</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })()}
      </section>

      <SupplyPanel supply={supply} />

      {who && (
        <section className="panel">
          <h2>Your fish</h2>
          {Object.values(held).every((n) => !n)
            ? <p className="empty">Nothing in your inventory. Catch fish and choose "Keep in inventory" to trade them here.</p>
            : (
              <table>
                <thead><tr><th>Fish</th><th className="num">Held</th><th className="num">Units</th><th /></tr></thead>
                <tbody>
                  {items.filter((i) => held[i.id] > 0).map((i) => (
                    <tr key={i.id}>
                      <td>{FISH[i.id]?.name || i.name}</td>
                      <td className="num">{held[i.id]}</td>
                      <td className="num">
                        <input type="number" min="1" max={held[i.id]} value={qty[i.id] || 1}
                          onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} className="qty" />
                      </td>
                      <td className="steward-actions">
                        <button className="ghost sm" disabled={busy} onClick={() => run(`sell ${q(i.id)} ${i.id} to the vault`, 'sell_to_market', { item_id: i.id, units: Math.min(q(i.id), held[i.id]) })} title="The vault always buys: 75% of fair while it holds 5 NEAR, less as it runs low. NPC orders and listings usually pay more.">Sell to vault ({Math.round(vaultBidBps(solvency?.vault) / 100)}%)</button>
                        <button className="ghost sm" disabled={busy} onClick={() => run(`list ${q(i.id)} ${i.id}`, 'list_fair', { item_id: i.id, units: Math.min(q(i.id), held[i.id]) })}>List for NPCs</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {mine.length > 0 && (
            <>
              <h3 className="sub">Your listings</h3>
              <table>
                <tbody>
                  {mine.map(([idx, l]) => {
                    const s = listingInfo(l, items);
                    return (
                      <tr key={idx}>
                        <td>{l.units} {l.item_id}</td>
                        <td className="num">{toNear(l.ask_price)} each</td>
                        <td className="listing-state">
                          {s.expired
                            ? <span className="down">Expired. Nobody can buy it now; take your fish back.</span>
                            : s.tooHigh
                              ? <span className="gold">Above what NPCs pay now (up to {toNear(s.npcMax)}). Players can still buy it for {minutes(s.leftMs)}.</span>
                              : <span className="up">NPCs and players can buy it for {minutes(s.leftMs)}.</span>}
                        </td>
                        <td className="steward-actions"><button className="ghost sm" disabled={busy} onClick={() => run('cancel listing', 'cancel_listing', { index: idx })}>{s.expired ? 'Take back' : 'Cancel'}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      <div className="npc-grid">
        {npcs.map((n) => {
          const info = NPC_INFO[n.id] || { role: 'trader', style: '', blurb: '' };
          const mine = orders.filter((o) => o.npc_id === n.id && o.units_left > 0);
          const stock = {};
          for (const l of n.inventory) stock[l.item_id] = (stock[l.item_id] || 0) + l.units;
          const profit = BigInt(n.realized_profit);
          return (
            <section className="panel npc" key={n.id}>
              <h2>{n.id} <span className={`tag ${info.style}`}>{info.role}</span></h2>
              <p className="muted">{info.blurb}</p>
              <NpcNote note={notes.find((x) => x.npc_id === n.id)} />
              <div className="zstat"><span>Treasury</span><b>{yoctoToNear(n.treasury)} Ⓝ</b></div>
              <div className="zstat"><span>Realized profit</span><b className={profit >= 0n ? 'up' : 'down'}>{toNear(n.realized_profit)} Ⓝ</b></div>
              <div className="zstat"><span>Trades</span><b>{n.trades}</b></div>
              <div className="chips">
                {Object.keys(stock).length === 0 ? <span className="muted">no stock</span>
                  : Object.entries(stock).map(([id, u]) => {
                    const a = n.asks?.find(([i]) => i === id);
                    return <span key={id} className="chip">{u} {id}{a ? ` @ ${toNear(a[1])}` : ''}</span>;
                  })}
              </div>
              {mine.length > 0 && (
                <div className="order">
                  {mine.map((o) => (
                    <div className="zstat" key={o.item_id}><span>Buying</span><b className="gold">{o.units_left} {o.item_id} @ {toNear(o.price)}</b></div>
                  ))}
                  <div className="muted small">
                    {yoctoToNear(mine.reduce((a, o) => a + BigInt(o.escrow), 0n))} Ⓝ locked in escrow. Staple orders are reposted as soon as they fill; the seasonal one once a week.
                  </div>
                </div>
              )}
              <Stake npc={n} inv={stakes[n.id]} who={who} busy={busy} run={run} runMany={runMany} />
            </section>
          );
        })}
      </div>

      <section className="panel">
        <h2>Trade feed</h2>
        <div className="feed">
          {trades.length === 0
            ? <p className="empty">No trades yet.</p>
            : trades.map((t, k) => {
                const d = new Date(Number(BigInt(t.at_ns) / 1_000_000n));
                return (
                  <div className="feed-row" key={k}>
                    <span className="muted">{String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}</span>
                    <span className={t.kind === 'player_sell' ? 'down' : 'up'}>{t.kind.replace('_', ' ')}</span>
                    <span><b>{t.kind === 'p2p' ? short(t.npc_id) : t.npc_id}</b> {(FEED[t.kind] || ((x) => `${x.units} ${x.item_id}`))({ ...t, counterparty: short(t.counterparty) })}</span>
                    <span className="muted">@ {toNear(t.price)}</span>
                  </div>
                );
              })}
        </div>
      </section>
    </>
  );
}

/** How long ago a nanosecond timestamp was, in words. */
export function ago(ns) {
  const s = Math.max(0, (Date.now() - Number(BigInt(ns) / 1_000_000n)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** An NPC's latest market note, posted on chain from its own account. */
export function NpcNote({ note, name }) {
  if (!note) return null;
  return (
    <figure className="npc-note">
      <blockquote>{note.text}</blockquote>
      <figcaption>
        {name && <b>{name}</b>}
        <span className={`src ${note.source}`}>{note.source === 'near-ai' ? 'NEAR AI Cloud' : 'Shop rules'}</span>
        <span>{ago(note.at_ns)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Profit an investor can claim now, in NEAR: the same formula as the
 * contract's owed_scaled. Investors together share 30% of the NPC's realized
 * profit since they joined, split by principal.
 */
function owedNear(npc, inv) {
  if (!inv || !npc.invested_total || BigInt(npc.invested_total) === 0n || BigInt(inv.principal) === 0n) return 0;
  const gain = BigInt(npc.realized_profit) - BigInt(inv.entry_profit);
  if (gain <= 0n) return 0;
  const pool = (gain * BigInt(inv.share_bps)) / 10_000n;
  const mine = (pool * BigInt(inv.principal)) / BigInt(npc.invested_total) - BigInt(inv.claimed);
  return mine > 0n ? Number(mine) / 1e6 : 0;
}

/** Invest in an NPC, see your stake, claim profit, withdraw after the lock. */
function Stake({ npc, inv, who, busy, run, runMany }) {
  const name = npc.id[0].toUpperCase() + npc.id.slice(1);
  const principal = inv ? BigInt(inv.principal) : 0n;
  const owed = owedNear(npc, inv);
  const unlockMs = inv ? Number(BigInt(inv.unlock_ns) / 1_000_000n) : 0;
  const locked = unlockMs > Date.now();
  const hours = Math.ceil((unlockMs - Date.now()) / 3_600_000);
  const amountOf = () => Number(document.getElementById(`inv-${npc.id}`).value);
  const invest = () => {
    const amt = amountOf();
    if (!amt) return;
    const y = nearToYocto(amt);
    // The contract wants unclaimed profit claimed before a top-up; do both in one go.
    if (owed > 0) {
      runMany(`claim profit and invest in ${npc.id}`, [
        { method: 'claim_profit', args: { npc_id: npc.id }, gas: 30 },
        { method: 'invest', args: { npc_id: npc.id, amount: y }, gas: 30, deposit: y },
      ]);
    } else {
      run(`invest in ${npc.id}`, 'invest', { npc_id: npc.id, amount: y }, y);
    }
  };
  return (
    <div className="invest">
      {principal > 0n && (
        <dl className="stake">
          <div><dt>Your stake</dt><dd>{yoctoToNear(principal)} NEAR</dd></div>
          <div><dt>Profit to claim</dt><dd className={owed > 0 ? 'up' : ''}>{owed.toFixed(4)} NEAR</dd></div>
          <div><dt>Principal</dt><dd>{locked ? `locked for ${hours} h` : 'free to withdraw'}</dd></div>
        </dl>
      )}
      {principal > 0n && (
        <div className="stake-actions">
          <button className="ghost" disabled={busy || owed <= 0} onClick={() => run(`claim profit from ${npc.id}`, 'claim_profit', { npc_id: npc.id })}>Claim profit</button>
          <button className="ghost" disabled={busy || locked} onClick={() => run(`withdraw from ${npc.id}`, 'withdraw_principal', { npc_id: npc.id })}>Withdraw</button>
        </div>
      )}
      <label htmlFor={`inv-${npc.id}`}>{principal > 0n ? `Add to your stake in ${name}, in NEAR` : `Invest in ${name}, in NEAR`}</label>
      <div className="invest-row">
        <input type="number" min="0.1" step="0.1" defaultValue="1" id={`inv-${npc.id}`} className="qty" />
        <button className="primary" disabled={!who || busy} onClick={invest}>Invest</button>
      </div>
      <p className="muted small">Investors share 30% of {name}'s realized profit by stake. Principal is locked for 24 hours after each deposit.</p>
    </div>
  );
}

/**
 * Where every fish went. Fish enter only by being caught; they leave as bait,
 * rods, docks, koi on the wall, or sales to the vault (which keeps no fish).
 * A zone regrows more slowly while its staple fish is above target.
 */
function SupplyPanel({ supply }) {
  if (!supply.length) return null;
  return (
    <section className="panel">
      <h2>Fish supply</h2>
      <p className="muted">Fish only enter the game when someone catches one, and leave for good as bait, rod crafting and
        repairs, docks, koi trophies, or sales to the vault. When a zone's staple fish piles up past its target, that zone
        regrows more slowly until the glut clears.</p>
      <table className="supply">
        <thead><tr><th>Fish</th><th className="num">Caught</th><th className="num">Burned</th><th className="num">In circulation</th><th>Zone regrowth</th></tr></thead>
        <tbody>
          {supply.map((s) => {
            const b = s.burned;
            const burned = s.burned_bait + b.rods + b.vault + b.docks + b.koi;
            const parts = [['bait', s.burned_bait], ['rods', b.rods], ['vault', b.vault], ['docks', b.docks], ['koi', b.koi]].filter(([, n]) => n > 0);
            const regen = s.regen_bps ? Number(s.regen_bps) / 100 : null;
            return (
              <tr key={s.item_id}>
                <td>{FISH[s.item_id]?.name || s.item_id}</td>
                <td className="num">{s.minted}</td>
                <td className="num" title={parts.map(([k, n]) => `${n} ${k}`).join(', ')}>{burned}{parts.length > 0 && <small className="muted"> ({parts.map(([k, n]) => `${n} ${k}`).join(', ')})</small>}</td>
                <td className="num">{s.circulating}{s.target ? <small className="muted"> / {s.target}</small> : null}</td>
                <td>{regen === null ? <span className="muted">no zone tied</span>
                  : <span className={regen < 100 ? 'gold' : 'up'}>{s.zone} at {regen.toFixed(0)}%</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
