/**
 * The market: where fish turn into NEAR and back.
 *
 * Every number here is read from the contract. Prices are the contract's
 * fair price; NPC asks and orders are standing offers backed by each NPC's
 * own treasury; the solvency strip shows that everything the contract owes
 * is covered by what it holds.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { view, call, txHash, toNear, yoctoToNear, nearToYocto, explain, freshAsk } from './contract';
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
};
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
      setItems(w.items); setNpcs(w.npcs); setTrades(w.trades); setOrders(w.orders); setListings(w.listings); setSolvency(w.solvency);
      if (p) setHeld(Object.fromEntries(p.holdings.map(([i, n]) => [i, Number(n)])));
    } catch { /* offline, keep last data */ }
  }, [who]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

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
        <table>
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
                  <td>{i.name}</td>
                  <td><span className={`rar ${RARITY[i.rarity]}`}>{RARITY[i.rarity]}</span></td>
                  <td className={`num ${flash[i.id] || ''}`} title={`supply ${i.listed_supply} listed · NPC stock ${i.npc_inventory} · NPC buys this hour ${i.npc_buy_volume}`}>{toNear(i.fair_price)}</td>
                  <td className="trendcell"><Sparkline points={historyOf(i.id, trades, i.fair_price)} /> <Trend points={historyOf(i.id, trades, i.fair_price)} /></td>
                  <td>
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
                  <td>
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
                  {who && <td className="num">{held[i.id] || 0}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

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
                  {mine.map(([idx, l]) => (
                    <tr key={idx}>
                      <td>{l.units} {l.item_id}</td>
                      <td className="num">{toNear(l.ask_price)} each</td>
                      <td className="steward-actions"><button className="ghost sm" disabled={busy} onClick={() => run('cancel listing', 'cancel_listing', { index: idx })}>Cancel</button></td>
                    </tr>
                  ))}
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
              <div className="actions">
                <input type="number" min="0.1" step="0.1" defaultValue="1" id={`inv-${n.id}`} className="qty" />
                <button className="ghost sm" disabled={!who || busy}
                  onClick={() => {
                    const amt = Number(document.getElementById(`inv-${n.id}`).value);
                    if (!amt) return;
                    const y = nearToYocto(amt);
                    run(`invest in ${n.id}`, 'invest', { npc_id: n.id, amount: y }, y);
                  }}>
                  Invest Ⓝ
                </button>
              </div>
              <p className="muted small">Investors share 30% of realized profit, pro rata. Principal locked 24h.</p>
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
                    <span><b>{t.npc_id}</b> {(FEED[t.kind] || ((x) => `${x.units} ${x.item_id}`))({ ...t, counterparty: short(t.counterparty) })}</span>
                    <span className="muted">@ {toNear(t.price)}</span>
                  </div>
                );
              })}
        </div>
      </section>
    </>
  );
}



