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
        everyone fishing there. Other fish can be released from Market, one fish each. Conservationists
        are ranked by fish restocked.
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
        <Board title="Conservationists" rows={topReleases} unit="fish restocked" who={who} />
      </div>
    </section>
  );
}

/**
 * A top-10 board. When the viewer is not on it but has a score, their own
 * row is shown under the list, so everyone can see where they stand.
 */
function Board({ title, rows, unit, who, mine = null, fmt = (n) => n, empty = 'Nobody yet.' }) {
  const onBoard = who && rows.some(([a]) => a === who);
  return (
    <div>
      <h3>{title}</h3>
      {rows.length === 0
        ? <p className="empty">{empty}</p>
        : (
          <ol className="board">
            {rows.map(([a, n]) => <li key={a} className={a === who ? 'gold' : ''}><span>{short(a)}{a === who && ' (you)'}</span><span>{fmt(n)} {unit}</span></li>)}
          </ol>
        )}
      {who && !onBoard && mine !== null && (
        <p className="you-row"><span>You</span><span>{mine ? <>{fmt(mine)} {unit}, outside the top 10</> : 'not on the board yet'}</span></p>
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
        Buy a 0.1 NEAR ticket and your heaviest fish in each zone this week competes; fish landed
        before you enter do not count. Each zone's heaviest fish takes an equal share of the pot (5%
        goes to the vault). No winner? The pot rolls into next week. Every entrant is listed below.
      </p>
      <div className="trophy-row">
        <div><span className="k">Pot</span><span className="v gold">{current ? yoctoToNear(current.pot) : '—'} Ⓝ</span></div>
        <div><span className="k">Anglers</span><span className="v">{current?.entrants ?? '—'}</span></div>
        <div><span className="k">Ends in</span><span className="v">{left}</span></div>
      </div>
      <div className="standings">
        {Object.keys(ZONES).map((z) => {
          // Standings started with this contract version; the zone's leader
          // (who the pot is paid to) is always shown, even from before then.
          const rows = [...(current?.standings?.find((x) => x[0] === z)?.[1] || [])];
          const lead = current?.leaders?.find((x) => x[0] === z);
          if (lead) {
            const i = rows.findIndex(([a]) => a === lead[2]);
            if (i < 0) rows.push([lead[2], lead[1], lead[3]]);
            else if (Number(lead[1]) > Number(rows[i][1])) rows[i] = [lead[2], lead[1], lead[3]];
          }
          rows.sort((a, b) => Number(b[1]) - Number(a[1]));
          return (
            <div key={z} className="standing">
              <h3>{ZONES[z].name}</h3>
              {rows.length === 0
                ? <p className="empty">Open: no entrant has landed a fish here this week.</p>
                : (
                  <ol className="board">
                    {rows.map(([a, g, item], i) => (
                      <li key={a} className={a === who ? 'gold' : ''}>
                        <span><b className="pos">{i + 1}.</b> {short(a)}{a === who && ' (you)'}{i === 0 && <em className="lead"> leading</em>}</span>
                        <span>{formatWeight(Number(g))} {FISH[item]?.name.toLowerCase()}</span>
                      </li>
                    ))}
                  </ol>
                )}
            </div>
          );
        })}
      </div>
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

/** Where the connected angler stands this week, on every board at once. */
export function StandingCard({ who, week, current, dex, bests, records, trophies, releases }) {
  if (!who) {
    return (
      <section className="panel standing-card">
        <h2>Your standing</h2>
        <p className="empty">Connect a wallet to see where you rank this week.</p>
      </section>
    );
  }
  if (!week) return null;
  const rank = (r) => (r ? `#${r}` : 'outside the top 10');
  const zoneRows = Object.keys(ZONES).map((z) => {
    let mineZ = week.zones.find((x) => x[0] === z);
    const st = current?.standings?.find((x) => x[0] === z)?.[1] || [];
    const lead = current?.leaders?.find((x) => x[0] === z);
    // The zone leader may predate the standings: count them, and if it is
    // this angler with a heavier fish, that fish is their entry.
    const n = st.length + (lead && !st.some(([a]) => a === lead[2]) ? 1 : 0);
    if (lead && lead[2] === who && (!mineZ || Number(lead[1]) > Number(mineZ[1]))) mineZ = [z, lead[1], lead[3], 1];
    else if (mineZ && lead && lead[2] !== who && !st.some(([a]) => a === lead[2]) && mineZ[3]) mineZ = [...mineZ.slice(0, 3), mineZ[3] + 1];
    return { z, mineZ, n };
  });
  const recordsHeld = (records || []).filter(([, , a]) => a === who).length;
  const pbs = Object.values(bests || {}).filter((g) => g > 0).length;
  return (
    <section className="panel standing-card">
      <h2>Your standing <small>week {Number(week.week)}</small></h2>
      <div className="trophy-row">
        <div><span className="k">Tournament</span><span className={`v ${week.entered ? 'up' : ''}`}>{week.entered ? 'Entered' : 'Not entered'}</span></div>
        <div><span className="k">Fish this week</span><span className="v">{Number(week.catches)} <small>{Number(week.catches) ? rank(week.catches_rank) : ''}</small></span></div>
        <div><span className="k">Earned selling</span><span className="v gold">{yoctoToNear(week.earned)} Ⓝ <small>{BigInt(week.earned) > 0n ? rank(week.earned_rank) : ''}</small></span></div>
      </div>
      <table className="standing-zones">
        <thead><tr><th>Zone</th><th>Your heaviest this week</th><th className="num">Place</th></tr></thead>
        <tbody>
          {zoneRows.map(({ z, mineZ, n }) => (
            <tr key={z}>
              <td>{ZONES[z].name}</td>
              <td>{mineZ ? `${formatWeight(Number(mineZ[1]))} ${FISH[mineZ[2]]?.name.toLowerCase()}` : <span className="muted">{week.entered ? 'nothing landed yet' : '—'}</span>}</td>
              <td className={`num ${mineZ?.[3] === 1 ? 'gold' : ''}`}>{mineZ ? `${rank(mineZ[3])}${mineZ[3] ? ` of ${n}` : ''}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!week.entered && <p className="muted">Enter the tournament below and your heaviest fish in each zone gets a place in the standings.</p>}
      <p className="muted">
        Personal bests in {pbs} of {Object.keys(FISH).length} fish{recordsHeld ? `, ${recordsHeld} world record${recordsHeld > 1 ? 's' : ''}` : ''}.
        {' '}Fishdex {dex?.caught?.length || 0} of {Object.keys(FISH).length}. Trophies {trophies || 0}. Fish restocked {releases || 0}.
      </p>
    </section>
  );
}

/** This week's open boards: anyone who fishes or sells shows up. */
export function WeekBoards({ who, boards, week }) {
  return (
    <section className="panel">
      <h2>This week</h2>
      <p className="muted">Open to every angler, no ticket needed. The boards reset each week.</p>
      <div className="boards">
        <Board title="Top anglers" rows={(boards?.catches || []).map(([a, n]) => [a, Number(n)])} unit="fish landed" who={who}
          mine={week ? Number(week.catches) : null} empty="Nobody has landed a fish this week yet." />
        <Board title="Top traders" rows={(boards?.earned || []).map(([a, v]) => [a, v])} unit="Ⓝ earned" who={who}
          mine={week ? (BigInt(week.earned) > 0n ? week.earned : 0) : null} fmt={(v) => yoctoToNear(v)} empty="Nobody has sold a fish this week yet." />
      </div>
    </section>
  );
}
