/**
 * The long game: records, the trophy room and the weekly tournament.
 */
import { useEffect, useState } from 'react';
import { FISH, ZONES, SEASONS, formatWeight } from './game';
import { yoctoToNear } from './contract';
import { short } from './names';


export function RecordsPanel({ records, bests, who }) {
  return (
    <section className="panel">
      <h2>Records</h2>
      <table>
        <thead><tr><th>Fish</th><th className="num">World record</th><th>Held by</th>{who && <th className="num">Your best</th>}</tr></thead>
        <tbody>
          {Object.keys(FISH).map((id) => {
            const rec = records.find(([i]) => i === id);
            return (
              <tr key={id}>
                <td>{FISH[id].name}</td>
                <td className="num">{rec ? formatWeight(Number(rec[1])) : '—'}</td>
                <td className="muted">{rec ? short(rec[2]) : 'unclaimed'}</td>
                {who && <td className={`num ${rec && rec[2] === who ? 'gold' : ''}`}>{bests[id] ? formatWeight(bests[id]) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function TrophyRoom({ who, koi, trophies, discountBps, boards, zones, busy, run }) {
  const [target, setTarget] = useState('abyss');
  const [topTrophies, topReleases] = boards;
  return (
    <section className="panel">
      <h2>Trophy room</h2>
      <p className="muted">
        A koi is a choice. <b>Mount</b> it and it is gone for good, but every trophy takes 5% off
        your fishing licenses (up to 50%). <b>Release</b> it and it restocks a zone by 20 fish for
        everyone fishing there.
      </p>
      <div className="trophy-row">
        <div><span className="k">Koi held</span><span className="v gold">{koi}</span></div>
        <div><span className="k">Trophies</span><span className="v">{trophies}</span></div>
        <div><span className="k">License discount</span><span className="v up">{Number(discountBps) / 100}%</span></div>
      </div>
      <div className="actions">
        <button disabled={!who || busy || koi < 1} onClick={() => run('mount trophy', 'mount_trophy', {})}>Mount a koi</button>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {zones.map((v) => <option key={v.zone.id} value={v.zone.id}>{ZONES[v.zone.id]?.name || v.zone.id} ({Math.round(v.health_bps / 100)}%)</option>)}
        </select>
        <button className="ghost" disabled={!who || busy || koi < 1} onClick={() => run('release koi', 'release_koi', { zone_id: target })}>Release into zone</button>
      </div>
      <div className="cols boards">
        <Board title="Trophy hunters" rows={topTrophies} unit="trophies" who={who} />
        <Board title="Conservationists" rows={topReleases} unit="released" who={who} />
      </div>
    </section>
  );
}

function Board({ title, rows, unit, who }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.length === 0
        ? <p className="empty">Nobody yet.</p>
        : (
          <ol className="board">
            {rows.map(([a, n]) => <li key={a} className={a === who ? 'gold' : ''}><span>{short(a)}</span><span>{n} {unit}</span></li>)}
          </ol>
        )}
    </div>
  );
}

function useCountdown(endsNs) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, Number(BigInt(endsNs || 0) / 1_000_000n) - now);
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

export function TournamentPanel({ who, current, previous, entered, busy, run }) {
  const left = useCountdown(current?.ends_ns);
  const canSettle = previous && !previous.settled && BigInt(previous.pot) > 0n;
  return (
    <section className="panel">
      <h2>Weekly tournament</h2>
      <p className="muted">
        Buy a 0.1 NEAR ticket and your heaviest fish in each zone this week competes. Each zone's
        heaviest fish takes an equal share of the pot (5% goes to the vault). No winner? The pot
        rolls into next week.
      </p>
      <div className="trophy-row">
        <div><span className="k">Pot</span><span className="v gold">{current ? yoctoToNear(current.pot) : '—'} Ⓝ</span></div>
        <div><span className="k">Anglers</span><span className="v">{current?.entrants ?? '—'}</span></div>
        <div><span className="k">Ends in</span><span className="v">{left}</span></div>
      </div>
      <table>
        <thead><tr><th>Zone</th><th>Leader</th><th>Fish</th><th className="num">Weight</th></tr></thead>
        <tbody>
          {Object.keys(ZONES).map((z) => {
            const l = current?.leaders?.find((x) => x[0] === z);
            return (
              <tr key={z}>
                <td>{ZONES[z].name}</td>
                <td className={l && l[2] === who ? 'gold' : ''}>{l ? short(l[2]) : <span className="muted">open</span>}</td>
                <td>{l ? FISH[l[3]]?.name : ''}</td>
                <td className="num">{l ? formatWeight(Number(l[1])) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions">
        {entered
          ? <button disabled>You're in this week</button>
          : <button disabled={!who || busy} onClick={() => run('enter tournament', 'enter_tournament', {}, '100000000000000000000000')}>Enter for 0.1 NEAR</button>}
        {canSettle && (
          <button className="ghost" disabled={!who || busy} onClick={() => run('pay out last week', 'settle_tournament', { week: previous.week })}>
            Pay out last week ({yoctoToNear(previous.pot)} Ⓝ)
          </button>
        )}
      </div>
    </section>
  );
}


export function SeasonBanner({ season }) {
  const left = useCountdown(season?.ends_ns);
  if (!season) return null;
  const s = SEASONS[season.name] || { name: season.name, blurb: '' };
  return (
    <div className={`season s-${season.name}`} role="note">
      <b>{s.name}</b>
      <span className="season-blurb">{s.blurb}</span>
      <span className="season-left">Next change in {left}</span>
    </div>
  );
}

export function FishdexPanel({ dex, who }) {
  return (
    <section className="panel">
      <h2>Fishdex {dex?.complete && <span className="tag">complete · +20 daily catches</span>}</h2>
      <p className="muted">Land every species once to complete it. The reward is permanent: 20 more fish a day.</p>
      <div className="dex">
        {Object.keys(FISH).map((id) => {
          const got = dex?.caught?.includes(id);
          return (
            <div key={id} className={got ? 'got' : ''} style={{ color: got ? FISH[id].color : undefined }}>
              <div style={{ fontSize: 20 }}>{got ? '◆' : '◇'}</div>
              {FISH[id].name}
            </div>
          );
        })}
      </div>
      {!who && <p className="muted small">Connect a wallet to track your Fishdex.</p>}
    </section>
  );
}
