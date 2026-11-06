/**
 * The sea as a map: one card per zone with its live health and license, and
 * the harbor-master (steward) panel for whoever runs a zone.
 */
import { ZONES, ROD_BY_TIER, RODS, FISH, SEASONS, zoneOpen, zonePool } from './game';
import { yoctoToNear, yoctoToNearFine, nearToYocto, freshAsk } from './contract';
import { short } from './names';

const pct = (bps) => Math.round(Number(bps) / 100);

function HealthBar({ bps }) {
  const p = pct(bps);
  const color = p >= 60 ? 'var(--up)' : p >= 30 ? '#fbbf24' : 'var(--down)';
  return (
    <div className="health" title={`${p}% of capacity`}>
      <div style={{ width: `${p}%`, background: color }} />
    </div>
  );
}

/**
 * The zone switcher above the water: one tab per zone with its health, and a
 * sentence under it about the zone in use. Locked zones say what opens them.
 */
export function ZonePicker({ zones, zone, setZone, rodTier, held = {}, who, season = 'calm', poach = false, setPoach, part = 'all' }) {
  const anyClosed = zones.some((v) => v.zone.closed);
  const cur = zones.find((v) => v.zone.id === zone);
  const meta = ZONES[zone];
  const names = Object.keys(zonePool(zone, season)).map((id) => FISH[id]?.name || id);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return (
    <div className={`zonebar zonebar-${part}`}>
      {part !== 'detail' && (
      <div className="zone-tabs" role="tablist" aria-label="Fishing zone">
        {zones.map((v) => {
          const m = ZONES[v.zone.id];
          if (!m) return null;
          const locked = rodTier < m.minRod;
          const stormed = !zoneOpen(v.zone.id, season);
          const blocked = locked || stormed || (v.zone.closed && !poach) || v.zone.population === 0;
          const note = locked ? `Needs a ${RODS[ROD_BY_TIER[m.minRod]].name}`
            : stormed ? SEASONS[season].name
            : v.zone.closed ? 'Closed by its harbor master'
            : `${v.zone.population} of ${v.zone.capacity} fish`;
          return (
            <button
              key={v.zone.id}
              role="tab"
              aria-selected={zone === v.zone.id}
              className={`zone-tab ${zone === v.zone.id ? 'active' : ''}`}
              disabled={blocked}
              onClick={() => setZone(v.zone.id)}
              style={{ '--zone': m.hue }}
            >
              <span className="zt-name">{m.name}</span>
              <span className="zt-note">{note}</span>
              <HealthBar bps={v.health_bps} />
            </button>
          );
        })}
      </div>
      )}
      {part !== 'tabs' && cur && meta && (
        <p className="zone-detail">
          {list} live here. The license is <b className="brass">{yoctoToNearFine(cur.fee_per_fish)} NEAR</b> a fish
          {meta.bait ? <>, and each fish needs one {FISH[meta.bait].name.toLowerCase()} or better as bait{who && <> (you have {held[meta.bait] || 0})</>}</> : ''}.
          {' '}{cur.zone.steward ? <>Harbor master: {short(cur.zone.steward)}.</> : 'No harbor master yet.'}
        </p>
      )}
      {part !== 'tabs' && anyClosed && (
        <label className="poach">
          <input type="checkbox" checked={poach} onChange={(e) => setPoach?.(e.target.checked)} disabled={!who} />
          <span>Poach closed zones. Fish bite better there, but the warden chases you off 3 casts in 10, and every
            poached fish pays its harbor master a fine of three licenses.</span>
        </label>
      )}
    </div>
  );
}

export function StewardPanel({ zones, who, run, docks = {}, snapper = 0, crews = {} }) {
  return (
    <section className="panel">
      <h2>Harbor masters</h2>
      <p className="muted">
        Join a harbor master's crew to share its earnings by stake, refunded in full when it
        leaves. Stake NEAR to run a zone and earn 30% of its fishing licenses. Burn 20 snapper to build a
        dock (+10% capacity, up to 10 docks) — but only while the zone
        stays above 50% health. Overfish it and the share goes to the vault instead. Close a zone
        to let it regrow twice as fast. A challenger can take your zone by staking 20% more; you
        get your stake and earnings back.
      </p>
      <table>
        <thead>
          <tr><th>Zone</th><th>Health</th><th>Harbor master</th><th className="num">Docks</th><th className="num">Stake</th><th className="num">Crew</th><th className="num">Earned</th><th /></tr>
        </thead>
        <tbody>
          {zones.map((v) => {
            const z = v.zone;
            const mine = who && z.steward === who;
            const crew = crews[z.id] || [];
            const crewTotal = crew.reduce((s, [, a]) => s + BigInt(a), 0n);
            const inCrew = who && crew.some(([a]) => a === who);
            const minStake = z.steward ? ((BigInt(z.steward_stake) + crewTotal) * 12n) / 10n : 10n ** 24n;
            return (
              <tr key={z.id}>
                <td>{ZONES[z.id]?.name || z.id}</td>
                <td><HealthBar bps={v.health_bps} /></td>
                <td>{z.steward ? short(z.steward) : <span className="muted">vacant</span>}</td>
                <td className="num">{docks[z.id] ?? 0}/10</td>
                <td className="num">{yoctoToNear(z.steward_stake)}</td>
                <td className="num" title={crew.map(([a, s]) => `${a}: ${yoctoToNear(s)}`).join('\n')}>{crew.length ? `${crew.length} · ${yoctoToNear(crewTotal)}` : '—'}</td>
                <td className="num">{yoctoToNearFine(z.steward_earned)}</td>
                <td className="steward-actions">
                  {mine ? (
                    <>
                      <select
                        defaultValue={String(z.fee_bps)}
                        onChange={(e) => run('policy', 'set_zone_policy', { zone_id: z.id, fee_bps: e.target.value, closed: z.closed })}
                      >
                        {[5000, 7500, 10000, 15000, 20000].map((b) => <option key={b} value={b}>fee x{b / 10000}</option>)}
                      </select>
                      <button className="ghost" onClick={() => run('policy', 'set_zone_policy', { zone_id: z.id, fee_bps: String(z.fee_bps), closed: !z.closed })}>
                        {z.closed ? 'Reopen' : 'Close'}
                      </button>
                      <button className="ghost" disabled={BigInt(z.steward_earned) === 0n} onClick={() => run('claim earnings', 'claim_steward_earnings', { zone_id: z.id })}>Claim</button>
                      <button className="ghost" disabled={snapper < 20 || (docks[z.id] ?? 0) >= 10} title="Burn 20 snapper: +10% capacity" onClick={() => run('build dock', 'build_dock', { zone_id: z.id })}>Build dock (20 snapper)</button>
                      <button className="ghost" onClick={() => run('resign', 'resign_steward', { zone_id: z.id })}>Resign</button>
                    </>
                  ) : (
                    <>
                      {z.steward && (
                        <button className="ghost" disabled={!who} title="Back this harbor master: share its earnings pro rata, refunded in full when it leaves"
                          onClick={() => run('join crew', 'back_steward', { zone_id: z.id }, nearToYocto(0.5))}>
                          {inCrew ? 'Add 0.5 Ⓝ' : 'Join crew 0.5 Ⓝ'}
                        </button>
                      )}
                      <button
                        disabled={!who}
                        onClick={() => {
                          const near = Number(yoctoToNear(minStake)) + 0.001;
                          run('stake', 'become_steward', { zone_id: z.id }, nearToYocto(near));
                        }}
                      >
                        {z.steward ? 'Take over' : 'Stake'} {yoctoToNear(minStake)}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}


/**
 * Bob's bait shelf. Deep zones burn one bait fish per catch, so anglers who
 * do not want to fish the Shallows for bait buy it here, at Bob's ask.
 */
export function BaitShop({ npcs, held = {}, who, busy, run, onError }) {
  const bob = npcs.find((n) => n.id === 'bob');
  const items = ['guppy', 'tilapia'];
  return (
    <section className="panel">
      <h2>Bait shop — Bob</h2>
      <p className="muted">
        Coral Reef takes one guppy per fish, The Abyss one tilapia. Catch your own in the Shallows,
        or buy from Bob, who restocks from what anglers sell him.
      </p>
      <table>
        <thead><tr><th>Bait</th><th className="num">Bob's price</th><th className="num">Bob has</th><th className="num">You have</th><th /></tr></thead>
        <tbody>
          {items.map((id) => {
            const ask = bob?.asks?.find(([i]) => i === id)?.[1];
            const stock = (bob?.inventory || []).filter((l) => l.item_id === id).reduce((s, l) => s + l.units, 0);
            return (
              <tr key={id}>
                <td>{FISH[id].name}</td>
                <td className="num">{ask ? `${(Number(ask) / 1e6).toFixed(4)} Ⓝ` : '—'}</td>
                <td className="num">{stock}</td>
                <td className="num">{held[id] || 0}</td>
                <td className="steward-actions">
                  {[1, 5].map((n) => (
                    <button
                      key={n}
                      className="ghost"
                      disabled={!who || busy || !ask || stock < n}
                      onClick={async () => {
                        try {
                          const f = await freshAsk('bob', id);
                          run(`buy ${n} ${id}`, 'buy_from_npc', { npc_id: 'bob', item_id: id, units: n, max_price: f.max }, f.cost(n));
                        } catch (e) { onError?.(e); }
                      }}
                    >
                      Buy {n}
                    </button>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}



