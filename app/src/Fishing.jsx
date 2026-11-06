/**
 * The fishing scene.
 *
 * The browser animates; the game server decides. A click asks the server for
 * a cast (it picks the bite time), and a strike sends the reaction time back
 * for the server to judge and roll. This component only renders those
 * answers, so nothing it draws can change what a catch is worth.
 *
 * Phases: idle -> casting -> waiting -> bite -> resolving -> reeling | escaped
 *         -> reveal -> idle
 */
import { useEffect, useRef, useCallback } from 'react';
import { FISH, RODS, ZONES, formatWeight } from './game';

const W = 960;
const H = 440;
const SURFACE = 96;
const BOAT_X = 300;
const CAST_MS = 650;
const REEL_MS = 950;
const REVEAL_MS = 1900;

const rand = (a, b) => a + Math.random() * (b - a);
const ease = (k) => 1 - Math.pow(1 - k, 3);
const surfaceY = (x, t) =>
  SURFACE + Math.sin(x * 0.018 + t * 0.0016) * 3 + Math.sin(x * 0.041 - t * 0.0011) * 1.5;

function makeScene() {
  return {
    ambient: Array.from({ length: 9 }, () => ({
      x: rand(0, W), y: rand(SURFACE + 60, H - 50), size: rand(7, 16),
      vx: (Math.random() > 0.5 ? 1 : -1) * rand(0.25, 0.7), phase: rand(0, 6.28),
    })),
    bubbles: Array.from({ length: 22 }, () => ({ x: rand(0, W), y: rand(SURFACE, H), r: rand(1, 3), v: rand(0.2, 0.6) })),
    weeds: Array.from({ length: 14 }, (_, i) => ({ x: 30 + i * 68 + rand(-18, 18), h: rand(40, 90), phase: rand(0, 6.28) })),
    particles: [],
    ripples: [],
    shake: 0,
  };
}

function splash(scene, x, y, n, color = 'rgba(186,230,253,0.9)') {
  for (let i = 0; i < n; i++) {
    scene.particles.push({ x, y, vx: rand(-2.2, 2.2), vy: rand(-4.5, -1.5), life: 1, color, r: rand(1.5, 3) });
  }
  scene.ripples.push({ x, y, r: 4, life: 1 });
}

function sparkle(scene, x, y) {
  for (let i = 0; i < 40; i++) {
    const a = rand(0, 6.28), s = rand(1, 5);
    scene.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.4, color: '#fde68a', r: rand(1.5, 3.5), glow: true });
  }
}

export function Fishing({ rod, zone = 'shallows', disabled, api, onResult }) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const castRef = useRef(null);
  const lastFrameRef = useRef(0);
  // The loop outlives renders; read the latest callbacks through refs so a
  // strike resolved from inside the loop never calls a stale handler.
  const apiRef = useRef(api);
  const onResultRef = useRef(onResult);
  apiRef.current = api;
  const hueRef = useRef(ZONES[zone]?.hue);
  hueRef.current = ZONES[zone]?.hue || '#13466b';
  onResultRef.current = onResult;

  if (!sceneRef.current) sceneRef.current = makeScene();

  const draw = useCallback((t) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const dpr = canvas.width / W;
    const scene = sceneRef.current;
    const c = castRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (scene.shake > 0) {
      ctx.translate(rand(-scene.shake, scene.shake), rand(-scene.shake, scene.shake));
      scene.shake *= 0.9;
      if (scene.shake < 0.3) scene.shake = 0;
    }

    drawSky(ctx, t);
    drawWater(ctx, t, scene, hueRef.current);
    const tip = drawBoat(ctx, t, c);

    if (c) stepCast(ctx, t, c, tip, scene);
    else hint(ctx, disabled ? 'connect a wallet to fish' : 'click the water or press space to cast');

    drawParticles(ctx, scene);
    if (c && c.phase === 'reveal') drawReveal(ctx, t, c);
  }, [disabled]);

  // --- phase machine --------------------------------------------------------
  const stepCast = (ctx, t, c, tip, scene) => {
    if (c.phase === 'casting') {
      const k = Math.min(1, (t - c.castAt) / CAST_MS);
      const e = ease(k);
      const x = tip.x + (c.target.x - tip.x) * e;
      // A shallow arc that never leaves the frame: the bobber stays visible.
      const y = Math.max(10, tip.y + (c.target.y - tip.y) * e - Math.sin(k * Math.PI) * 28);
      c.bobber = { x, y };
      line(ctx, tip, c.bobber, 0.2);
      bobber(ctx, c.bobber, t, false);
      if (k >= 1) {
        splash(scene, c.target.x, c.target.y, 12);
        c.landedAt = t;
        c.phase = 'waiting';
      }
      return;
    }

    const by = surfaceY(c.target.x, t);
    const base = { x: c.target.x, y: by };

    if (c.phase === 'waiting') {
      c.bobber = { x: base.x, y: base.y + Math.sin(t * 0.004) * 1.5 };
      line(ctx, tip, c.bobber, 0.5);
      if (c.server) {
        // A shadow circles in as the bite approaches: tension, not a timer.
        const left = Math.max(0, c.biteShowAt - t);
        const k = 1 - Math.min(1, left / c.server.biteDelay);
        const ang = t * 0.002;
        const dist = 160 * (1 - k) + 18;
        shadowFish(ctx, base.x + Math.cos(ang) * dist, base.y + 46 + Math.sin(ang) * 18 * (1 - k), 18, 0.18 + 0.25 * k, Math.cos(ang) > 0 ? -1 : 1);
        if (left <= 0) {
          c.phase = 'bite';
          c.biteAt = t;
          splash(scene, base.x, base.y, 18);
          scene.shake = 3;
        }
      }
      bobber(ctx, c.bobber, t, false);
      hint(ctx, c.server ? 'wait for it…' : 'casting…');
      return;
    }

    if (c.phase === 'bite') {
      const elapsed = t - c.biteAt;
      const win = c.server.windowMs;
      c.bobber = { x: base.x + Math.sin(t * 0.06) * 2.5, y: base.y + 9 + Math.sin(t * 0.03) * 3 };
      line(ctx, tip, c.bobber, 0.9);
      bobber(ctx, c.bobber, t, true);
      drawStrikeBar(ctx, elapsed / win, t);
      if (Math.random() < 0.25) scene.ripples.push({ x: base.x, y: base.y, r: 4, life: 0.6 });
      if (elapsed > win) {
        c.phase = 'resolving';
        c.reaction = win + 1; // too late; the server will say so too
        resolve(c, scene);
      }
      return;
    }

    if (c.phase === 'resolving') {
      c.bobber = { x: base.x + Math.sin(t * 0.08) * 4, y: base.y + 6 + Math.sin(t * 0.05) * 4 };
      line(ctx, tip, c.bobber, 1);
      bobber(ctx, c.bobber, t, true);
      hint(ctx, 'reeling…');
      return;
    }

    if (c.phase === 'reeling') {
      const k = Math.min(1, (t - c.reelAt) / REEL_MS);
      const e = ease(k);
      const f = FISH[c.result.fish];
      const from = { x: base.x, y: base.y + 30 };
      const pos = { x: from.x + (tip.x - from.x) * e, y: from.y + (tip.y + 34 - from.y) * e - Math.sin(k * Math.PI) * 40 };
      line(ctx, tip, pos, 1);
      if (Math.random() < 0.4) scene.particles.push({ x: pos.x, y: pos.y, vx: rand(-0.5, 0.5), vy: rand(0, 1), life: 0.7, color: 'rgba(186,230,253,0.8)', r: 1.5 });
      fishSprite(ctx, pos.x, pos.y, f.size, f.color, t, Math.PI / 2 * 0.8 + Math.sin(t * 0.03) * 0.5);
      if (k >= 1) {
        c.phase = 'reveal';
        c.revealAt = t;
        if (f.rarity === 'legendary' || f.rarity === 'epic') { sparkle(scene, tip.x, tip.y + 30); scene.shake = f.rarity === 'legendary' ? 9 : 4; }
      }
      return;
    }

    if (c.phase === 'escaped') {
      const k = Math.min(1, (t - c.escapeAt) / 900);
      shadowFish(ctx, base.x + k * 420 * c.dir, base.y + 40 + k * 60, 20, 0.35 * (1 - k), c.dir);
      line(ctx, tip, { x: base.x, y: base.y }, 0.3);
      if (k >= 1) { c.phase = 'reveal'; c.revealAt = t; }
      return;
    }

    if (c.phase === 'reveal') {
      if (c.result?.hit) {
        const f = FISH[c.result.fish];
        fishSprite(ctx, tip.x, tip.y + 34, f.size, f.color, t, Math.PI / 2 * 0.8 + Math.sin(t * 0.02) * 0.2);
      }
      if (t - c.revealAt > REVEAL_MS) castRef.current = null;
    }
  };

  const resolve = async (c, scene) => {
    let result;
    try {
      result = await apiRef.current.strike(c.server, Math.round(c.reaction));
    } catch (e) {
      result = { hit: false, reason: 'error', error: String(e.message || e) };
    }
    c.result = result;
    const now = performance.now();
    if (result.hit) {
      c.phase = 'reeling';
      c.reelAt = now;
      splash(scene, c.target.x, surfaceY(c.target.x, now), 22);
    } else {
      c.phase = 'escaped';
      c.escapeAt = now;
      c.dir = Math.random() > 0.5 ? 1 : -1;
      splash(scene, c.target.x, surfaceY(c.target.x, now), 10);
    }
    onResultRef.current?.(result);
  };

  const act = useCallback(async (point) => {
    if (disabled) return;
    const c = castRef.current;
    const now = performance.now();

    if (!c) {
      const tx = Math.max(BOAT_X + 140, Math.min(W - 60, point?.x ?? rand(560, 820)));
      const next = { phase: 'casting', castAt: now, target: { x: tx, y: SURFACE }, server: null };
      castRef.current = next;
      try {
        const server = await apiRef.current.cast();
        if (castRef.current !== next) return;
        next.server = server;
        // Show the bite where the server's clock puts it, but never before
        // the bobber has landed.
        next.biteShowAt = Math.max(performance.now() + server.biteDelay, now + CAST_MS + 250);
      } catch (e) {
        castRef.current = null;
        onResultRef.current?.({ hit: false, reason: 'error', error: String(e.message || e) });
      }
      return;
    }

    if (c.phase === 'waiting' && c.server) {
      // Striking before the bite spooks the fish.
      c.phase = 'escaped';
      c.escapeAt = now;
      c.dir = 1;
      c.result = { hit: false, reason: 'spooked' };
      splash(sceneRef.current, c.target.x, surfaceY(c.target.x, now), 8);
      onResultRef.current?.(c.result);
      return;
    }

    if (c.phase === 'bite') {
      c.reaction = now - c.biteAt;
      c.phase = 'resolving';
      resolve(c, sceneRef.current);
    }
  }, [disabled]);

  // --- loop, sizing, input ---------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    };
    fit();
    window.addEventListener('resize', fit);

    let raf;
    const loop = (t) => { lastFrameRef.current = t; draw(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    // Hidden tabs pause rAF; keep stepping so a bite is not missed silently.
    const fallback = setInterval(() => {
      const now = performance.now();
      if (now - lastFrameRef.current > 100) { lastFrameRef.current = now; draw(now); }
    }, 100);

    const onKey = (e) => {
      if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
        e.preventDefault();
        act(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf); clearInterval(fallback);
      window.removeEventListener('resize', fit); window.removeEventListener('keydown', onKey);
    };
  }, [draw, act]);

  const onPointer = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    act({ x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H });
  };

  return (
    <canvas
      ref={canvasRef}
      className="sea"
      style={{ width: '100%', aspectRatio: `${W} / ${H}`, display: 'block', touchAction: 'manipulation', cursor: disabled ? 'not-allowed' : 'pointer' }}
      onPointerDown={onPointer}
      aria-label={`Fishing scene, ${RODS[rod]?.name || 'rod'} equipped`}
    />
  );
}

// --- drawing helpers ----------------------------------------------------------

function drawSky(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, 0, SURFACE);
  g.addColorStop(0, '#0b1b2e');
  g.addColorStop(1, '#1e3a5f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, SURFACE + 8);
  ctx.fillStyle = 'rgba(253,230,138,0.85)';
  ctx.beginPath(); ctx.arc(820, 34, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(253,230,138,0.12)';
  ctx.beginPath(); ctx.arc(820, 34, 30 + Math.sin(t * 0.002) * 2, 0, Math.PI * 2); ctx.fill();
}

function drawWater(ctx, t, scene, hue) {
  const g = ctx.createLinearGradient(0, SURFACE, 0, H);
  g.addColorStop(0, hue);
  g.addColorStop(0.5, '#0c2f4c');
  g.addColorStop(1, '#061726');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 12) ctx.lineTo(x, surfaceY(x, t));
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();

  // light shafts
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    const x = 120 + i * 190 + Math.sin(t * 0.0004 + i) * 30;
    const lg = ctx.createLinearGradient(0, SURFACE, 0, H * 0.85);
    lg.addColorStop(0, 'rgba(125,211,252,0.07)');
    lg.addColorStop(1, 'rgba(125,211,252,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(x - 20, SURFACE); ctx.lineTo(x + 20, SURFACE); ctx.lineTo(x + 80, H * 0.85); ctx.lineTo(x - 10, H * 0.85);
    ctx.fill();
  }
  ctx.restore();

  // weeds
  for (const w of scene.weeds) {
    ctx.strokeStyle = 'rgba(34,197,94,0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(w.x, H);
    for (let k = 0; k <= 1; k += 0.1) {
      ctx.lineTo(w.x + Math.sin(t * 0.0015 + w.phase + k * 3) * 10 * k, H - w.h * k);
    }
    ctx.stroke();
  }

  // ambient fish
  for (const f of scene.ambient) {
    f.x += f.vx;
    if (f.x < -40) f.x = W + 40;
    if (f.x > W + 40) f.x = -40;
    shadowFish(ctx, f.x, f.y + Math.sin(t * 0.002 + f.phase) * 6, f.size, 0.22, f.vx > 0 ? 1 : -1);
  }

  // bubbles
  ctx.strokeStyle = 'rgba(186,230,253,0.35)';
  ctx.lineWidth = 1;
  for (const b of scene.bubbles) {
    b.y -= b.v;
    b.x += Math.sin(t * 0.003 + b.y * 0.05) * 0.2;
    if (b.y < SURFACE + 4) { b.y = H; b.x = rand(0, W); }
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
  }

  // surface highlight
  ctx.strokeStyle = 'rgba(186,230,253,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 12) { const y = surfaceY(x, t); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();

  // ripples
  for (const r of scene.ripples) {
    r.r += 1.2; r.life -= 0.02;
    ctx.strokeStyle = `rgba(186,230,253,${Math.max(0, r.life) * 0.6})`;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
  }
  scene.ripples = scene.ripples.filter((r) => r.life > 0);
}

function drawBoat(ctx, t, c) {
  const bx = BOAT_X;
  const by = surfaceY(bx, t) - 4;
  const tilt = Math.sin(t * 0.0012) * 0.03;
  // Rod bends under load once a fish is on.
  const load = c && (c.phase === 'bite' || c.phase === 'resolving' || c.phase === 'reeling') ? 1 : 0;
  const swing = c && c.phase === 'casting' ? Math.sin(Math.min(1, (t - c.castAt) / CAST_MS) * Math.PI) : 0;

  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(tilt);
  ctx.fillStyle = '#7c4a2d';
  ctx.beginPath(); ctx.moveTo(-60, 0); ctx.lineTo(60, 0); ctx.lineTo(44, 22); ctx.lineTo(-44, 22); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#5d3720'; ctx.fillRect(-60, 0, 120, 5);
  ctx.fillStyle = '#1f2937'; ctx.fillRect(-14, -28, 26, 28);
  ctx.beginPath(); ctx.arc(-1, -36, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b45309'; ctx.fillRect(-12, -46, 22, 5);

  const tipLocal = { x: 70 - swing * 30, y: -70 + load * 22 + swing * -10 };
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(8, -22);
  ctx.quadraticCurveTo(40, -50 + load * 6, tipLocal.x, tipLocal.y);
  ctx.stroke();
  ctx.restore();

  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  return { x: bx + tipLocal.x * cos - tipLocal.y * sin, y: by + tipLocal.x * sin + tipLocal.y * cos };
}

function line(ctx, a, b, tension) {
  ctx.strokeStyle = 'rgba(226,232,240,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo((a.x + b.x) / 2, Math.max(a.y, b.y) + 40 * (1 - tension), b.x, b.y);
  ctx.stroke();
}

function bobber(ctx, p, t, dunk) {
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath(); ctx.arc(p.x, p.y + 2, 7, 0, Math.PI); ctx.fill();
  ctx.fillStyle = dunk ? '#f87171' : '#ef4444';
  ctx.beginPath(); ctx.arc(p.x, p.y, 7, Math.PI, 0); ctx.fill();
  ctx.fillRect(p.x - 1, p.y - 12, 2, 7);
}

function shadowFish(ctx, x, y, size, alpha, dir) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#020617';
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  ctx.beginPath(); ctx.ellipse(0, 0, size, size * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-size * 0.9, 0); ctx.lineTo(-size * 1.5, -size * 0.4); ctx.lineTo(-size * 1.5, size * 0.4); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function fishSprite(ctx, x, y, size, color, t, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.shadowColor = color; ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 0, size, size * 0.45, 0, 0, Math.PI * 2); ctx.fill();
  const flap = Math.sin(t * 0.04) * size * 0.2;
  ctx.beginPath(); ctx.moveTo(-size * 0.85, 0); ctx.lineTo(-size * 1.45, -size * 0.45 + flap); ctx.lineTo(-size * 1.45, size * 0.45 + flap); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#0f172a';
  ctx.beginPath(); ctx.arc(size * 0.55, -size * 0.1, Math.max(1.5, size * 0.09), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawStrikeBar(ctx, progress, t) {
  const bw = 300, bx = W / 2 - bw / 2, by = H - 52;
  ctx.save();
  ctx.textAlign = 'center';
  const pulse = 1 + Math.sin(t * 0.03) * 0.06;
  ctx.font = `bold ${Math.round(32 * pulse)}px ui-monospace, monospace`;
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('STRIKE!', W / 2, by - 14);
  ctx.fillStyle = 'rgba(15,23,42,0.85)'; ctx.fillRect(bx, by, bw, 12);
  // the sweet spot sits in the middle of the window
  const sg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  sg.addColorStop(0, 'rgba(239,68,68,0.5)'); sg.addColorStop(0.35, 'rgba(250,204,21,0.6)');
  sg.addColorStop(0.5, 'rgba(52,211,153,0.95)'); sg.addColorStop(0.65, 'rgba(250,204,21,0.6)');
  sg.addColorStop(1, 'rgba(239,68,68,0.5)');
  ctx.fillStyle = sg; ctx.fillRect(bx, by, bw, 12);
  const mx = bx + bw * Math.min(1, progress);
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(mx - 2, by - 5, 4, 22);
  ctx.restore();
}

function drawParticles(ctx, scene) {
  for (const p of scene.particles) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.18; p.life -= 0.025;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    if (p.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = 8; }
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
  scene.particles = scene.particles.filter((p) => p.life > 0);
}

const LABEL = { warden: 'The warden chased you off!', late: 'Too late — it got away', escaped: 'It slipped the hook', spooked: 'Too early — you spooked it', error: 'Connection hiccup' };

function drawReveal(ctx, t, c) {
  const k = Math.min(1, (t - c.revealAt) / 260);
  const fade = Math.min(1, Math.max(0, (REVEAL_MS - (t - c.revealAt)) / 300));
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = 'center';
  const y = H / 2 - 20 - ease(k) * 16;
  if (c.result?.hit) {
    const f = FISH[c.result.fish];
    ctx.fillStyle = 'rgba(2,6,23,0.75)';
    roundRect(ctx, W / 2 - 170, y - 44, 340, 76, 12); ctx.fill();
    ctx.strokeStyle = f.color; ctx.lineWidth = 2; roundRect(ctx, W / 2 - 170, y - 44, 340, 76, 12); ctx.stroke();
    ctx.fillStyle = f.color; ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.fillText(`+1 ${f.name}`, W / 2, y - 10);
    ctx.fillStyle = 'rgba(203,213,225,0.9)'; ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(`${formatWeight(c.result.weight || 0)} · ${f.rarity} · strike ${(Math.round((c.result.quality || 0) * 100))}%`, W / 2, y + 16);
  } else {
    ctx.fillStyle = '#f87171'; ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.fillText(LABEL[c.result?.reason] || 'It got away', W / 2, y);
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function hint(ctx, text) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(148,180,203,0.9)';
  ctx.fillText(text, W / 2, H - 16);
  ctx.restore();
}


