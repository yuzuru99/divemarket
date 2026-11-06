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
import { useEffect, useRef, useCallback, useState } from 'react';
import { FISH, RODS, ZONES, formatWeight } from './game';
import { sfx, unlock } from './sound';

// The scene is drawn in its own units and scaled to fit. A wide screen gets a
// wide sea; a phone gets a tall one, so the water fills the screen instead of
// shrinking to a strip. `layoutFor` switches between the two.
let W = 960;
let H = 500;
let SURFACE = 140;
let BOAT_X = 300;
const NARROW = { W: 560, H: 720, boat: 150, surface: 200 };
const WIDE = { W: 960, H: 500, boat: 290, surface: 140 };
function layoutFor(cssWidth) {
  const l = cssWidth < 620 ? NARROW : WIDE;
  const changed = l.W !== W || l.H !== H;
  W = l.W; H = l.H; BOAT_X = l.boat; SURFACE = l.surface;
  return changed;
}

/**
 * How each zone looks. The Shallows sit in a warm dusk by an island with a
 * lighthouse, the Reef glows at sunset over coral, and the Abyss is open
 * ocean at night, where only plankton and the boat's lantern give light.
 */
const LOOKS = {
  shallows: { sky: ['#17344d', '#d9795a', '#ffc58f'], sun: '#ffe1b0', sunY: 0.78, water: ['#2b7f86', '#145466', '#0a3040'],
    bed: 'sand', island: true, gulls: true, stars: false, weed: 'rgba(88,199,154,0.55)' },
  reef: { sky: ['#24183f', '#b4486e', '#ff9468'], sun: '#ffb38a', sunY: 0.9, water: ['#1a8c8a', '#0f5a66', '#072c3a'],
    bed: 'coral', island: true, gulls: true, stars: false, weed: 'rgba(120,214,170,0.5)' },
  abyss: { sky: ['#02060f', '#081a33', '#123155'], sun: null, water: ['#0f3352', '#081d36', '#020914'],
    bed: 'rock', island: false, gulls: false, stars: true, weed: 'rgba(60,140,140,0.35)' },
};
const STORM = { sky: ['#0d151c', '#26343d', '#3d4c55'], sun: null };
const FONT = '"Atkinson Hyperlegible", system-ui, sans-serif';
const DISPLAY = '"Big Shoulders Display", "Atkinson Hyperlegible", system-ui, sans-serif';
const CAST_MS = 650;
const REEL_MS = 950;
const REVEAL_MS = 1900;

const rand = (a, b) => a + Math.random() * (b - a);
const ease = (k) => 1 - Math.pow(1 - k, 3);
const surfaceY = (x, t) =>
  SURFACE + Math.sin(x * 0.018 + t * 0.0016) * 3 + Math.sin(x * 0.041 - t * 0.0011) * 1.5;

function makeScene() {
  const bedPts = [];
  for (let x = -20; x <= W + 20; x += 40) bedPts.push({ x, y: H - 26 - Math.sin(x * 0.011) * 10 - rand(0, 10) });
  return {
    bed: bedPts,
    corals: Array.from({ length: Math.ceil(W / 110) }, (_, i) => ({ x: 40 + i * 110 + rand(-30, 30), h: rand(30, 70), hue: ['#ff7b8a', '#ffb36b', '#d58bff', '#ff9f6e'][i % 4], seed: rand(0, 6) })),
    rocks: Array.from({ length: Math.ceil(W / 140) }, (_, i) => ({ x: 30 + i * 140 + rand(-40, 40), w: rand(30, 70), h: rand(16, 36) })),
    glow: Array.from({ length: 40 }, () => ({ x: rand(0, W), y: rand(SURFACE + 40, H), r: rand(0.8, 2.2), p: rand(0, 6.28), v: rand(0.05, 0.25) })),
    stars: Array.from({ length: 70 }, () => ({ x: rand(0, W), y: rand(0, SURFACE - 20), r: rand(0.4, 1.4), p: rand(0, 6.28) })),
    clouds: Array.from({ length: 4 }, (_, i) => ({ x: rand(0, W), y: rand(18, SURFACE * 0.5), w: rand(90, 170), v: rand(0.03, 0.08) * (i % 2 ? 1 : 0.6) })),
    gulls: Array.from({ length: 3 }, () => ({ x: rand(0, W), y: rand(24, SURFACE * 0.55), v: rand(0.25, 0.5), p: rand(0, 6.28) })),
    rain: Array.from({ length: 140 }, () => ({ x: rand(0, W), y: rand(0, H), v: rand(9, 14) })),
    flash: 0,
    nextFlash: 0,
    ambient: Array.from({ length: 9 }, () => ({
      x: rand(0, W), y: rand(SURFACE + 60, H - 50), size: rand(7, 16),
      vx: (Math.random() > 0.5 ? 1 : -1) * rand(0.25, 0.7), phase: rand(0, 6.28),
    })),
    bubbles: Array.from({ length: 22 }, () => ({ x: rand(0, W), y: rand(SURFACE, H), r: rand(1, 3), v: rand(0.2, 0.6) })),
    weeds: Array.from({ length: Math.ceil(W / 68) }, (_, i) => ({ x: 30 + i * 68 + rand(-18, 18), h: rand(40, 90), phase: rand(0, 6.28) })),
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

export function Fishing({ rod, zone = 'shallows', season = 'calm', disabled, api, onResult }) {
  const canvasRef = useRef(null);
  const [dims, setDims] = useState({ W, H });
  const sceneRef = useRef(null);
  const castRef = useRef(null);
  const lastFrameRef = useRef(0);
  // The loop outlives renders; read the latest callbacks through refs so a
  // strike resolved from inside the loop never calls a stale handler.
  const apiRef = useRef(api);
  const onResultRef = useRef(onResult);
  apiRef.current = api;
  const lookRef = useRef(null);
  const base = LOOKS[zone] || LOOKS.shallows;
  lookRef.current = { ...base, ...(season === 'storm' ? STORM : {}), storm: season === 'storm', zone };
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

    // Paint the whole frame first: nothing from the last frame may show
    // through at the edges.
    ctx.fillStyle = '#061726';
    ctx.fillRect(-20, -20, W + 40, H + 40);
    const look = lookRef.current;
    drawSky(ctx, t, scene, look);
    drawWater(ctx, t, scene, look);
    const tip = drawBoat(ctx, t, c, look);

    if (c) stepCast(ctx, t, c, tip, scene);
    else hint(ctx, disabled ? 'Connect a wallet to fish' : 'Tap the water to cast');

    drawParticles(ctx, scene);
    if (look.storm) drawStorm(ctx, t, scene);
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
        sfx.splash();
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
          sfx.bite();
        }
      }
      bobber(ctx, c.bobber, t, false);
      hint(ctx, c.server ? 'Wait for the bobber to dip…' : 'Casting…');
      return;
    }

    if (c.phase === 'bite') {
      const elapsed = t - c.biteAt;
      const win = c.server.windowMs;
      c.bobber = { x: base.x + Math.sin(t * 0.06) * 2.5, y: base.y + 9 + Math.sin(t * 0.03) * 3 };
      line(ctx, tip, c.bobber, 0.9);
      bobber(ctx, c.bobber, t, true);
      drawStrikeRing(ctx, c.bobber, elapsed / win, t);
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
      hint(ctx, 'Reeling in…');
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
        sfx.caught(f.rarity);
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
      sfx.reel(REEL_MS / 1000);
      splash(scene, c.target.x, surfaceY(c.target.x, now), 22);
    } else {
      c.phase = 'escaped';
      c.escapeAt = now;
      c.dir = Math.random() > 0.5 ? 1 : -1;
      sfx.escaped();
      splash(scene, c.target.x, surfaceY(c.target.x, now), 10);
    }
    onResultRef.current?.(result);
  };

  const act = useCallback(async (point) => {
    if (disabled) return;
    const c = castRef.current;
    const now = performance.now();

    if (!c) {
      unlock();
      sfx.cast();
      const tx = Math.max(BOAT_X + 140, Math.min(W - 60, point?.x ?? rand(BOAT_X + 260, W - 140)));
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
      sfx.spooked();
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
      // Pick the layout for the space the canvas has, then size the bitmap.
      if (layoutFor(canvas.parentElement?.clientWidth || window.innerWidth)) {
        sceneRef.current = makeScene();
        castRef.current = null;
        setDims({ W, H });
      }
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
      style={{ width: '100%', aspectRatio: `${dims.W} / ${dims.H}`, display: 'block', touchAction: 'manipulation', cursor: disabled ? 'not-allowed' : 'pointer' }}
      onPointerDown={onPointer}
      aria-label={`Fishing scene, ${RODS[rod]?.name || 'rod'} equipped`}
    />
  );
}

// --- drawing helpers ----------------------------------------------------------

function mix(a, b, k) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(',')})`;
}

function drawSky(ctx, t, scene, look) {
  const g = ctx.createLinearGradient(0, 0, 0, SURFACE);
  g.addColorStop(0, look.sky[0]);
  g.addColorStop(0.65, look.sky[1]);
  g.addColorStop(1, look.sky[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, SURFACE + 10);

  if (look.stars) {
    for (const s of scene.stars) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.0012 + s.p));
      ctx.fillStyle = '#e6f2ef';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // a cold moon high in the night
    ctx.fillStyle = 'rgba(230,242,239,0.12)';
    ctx.beginPath(); ctx.arc(W * 0.84, SURFACE * 0.55, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#dfe9f0';
    ctx.beginPath(); ctx.arc(W * 0.84, SURFACE * 0.55, 13, 0, Math.PI * 2); ctx.fill();
  }

  if (look.sun) {
    const sx = W * 0.64, sy = SURFACE * look.sunY;
    const halo = ctx.createRadialGradient(sx, sy, 4, sx, sy, 110);
    halo.addColorStop(0, 'rgba(255,225,176,0.55)');
    halo.addColorStop(1, 'rgba(255,225,176,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(sx - 110, sy - 110, 220, 220);
    ctx.fillStyle = look.sun;
    ctx.beginPath(); ctx.arc(sx, sy, 22, 0, Math.PI * 2); ctx.fill();
  }

  // drifting clouds
  for (const c of scene.clouds) {
    c.x += c.v; if (c.x - c.w > W) c.x = -c.w;
    ctx.fillStyle = look.storm ? 'rgba(30,42,50,0.85)' : look.stars ? 'rgba(20,40,70,0.45)' : 'rgba(255,214,190,0.18)';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, c.w * 0.5, 9, 0, 0, Math.PI * 2);
    ctx.ellipse(c.x + c.w * 0.18, c.y - 7, c.w * 0.28, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (look.island) drawIsland(ctx, t, look);

  if (look.gulls) {
    ctx.strokeStyle = 'rgba(20,30,40,0.7)'; ctx.lineWidth = 1.6;
    for (const b of scene.gulls) {
      b.x += b.v; if (b.x > W + 20) { b.x = -20; b.y = rand(24, SURFACE * 0.55); }
      const f = Math.sin(t * 0.008 + b.p) * 4;
      ctx.beginPath();
      ctx.moveTo(b.x - 9, b.y - f); ctx.quadraticCurveTo(b.x - 4, b.y - 3, b.x, b.y);
      ctx.quadraticCurveTo(b.x + 4, b.y - 3, b.x + 9, b.y - f);
      ctx.stroke();
    }
  }
}

/** An island on the horizon with a lighthouse whose beam sweeps the dusk. */
function drawIsland(ctx, t, look) {
  const x0 = W * 0.8, y = SURFACE + 2;
  ctx.fillStyle = mix(look.sky[0], '#000000', 0.35);
  ctx.beginPath();
  ctx.moveTo(x0 - 120, y);
  ctx.quadraticCurveTo(x0 - 70, y - 30, x0 - 20, y - 22);
  ctx.quadraticCurveTo(x0 + 30, y - 40, x0 + 90, y - 14);
  ctx.quadraticCurveTo(x0 + 130, y - 6, x0 + 170, y);
  ctx.closePath(); ctx.fill();
  // lighthouse
  const lx = x0 + 20, ly = y - 34;
  ctx.fillStyle = '#e6f2ef';
  ctx.beginPath(); ctx.moveTo(lx - 6, ly + 6); ctx.lineTo(lx + 6, ly + 6); ctx.lineTo(lx + 4, ly - 30); ctx.lineTo(lx - 4, ly - 30); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ff6b2c'; ctx.fillRect(lx - 5, ly - 14, 10, 5); ctx.fillRect(lx - 4.5, ly - 24, 9, 4);
  ctx.fillStyle = '#123038'; ctx.fillRect(lx - 5, ly - 36, 10, 6);
  const on = 0.6 + 0.4 * Math.sin(t * 0.004);
  ctx.fillStyle = `rgba(255,230,160,${on})`;
  ctx.beginPath(); ctx.arc(lx, ly - 33, 3.2, 0, Math.PI * 2); ctx.fill();
  // the beam
  const a = t * 0.0007;
  const len = 260;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const bg = ctx.createRadialGradient(lx, ly - 33, 2, lx, ly - 33, len);
  bg.addColorStop(0, 'rgba(255,230,160,0.35)'); bg.addColorStop(1, 'rgba(255,230,160,0)');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(lx, ly - 33);
  ctx.lineTo(lx + Math.cos(a) * len, ly - 33 + Math.sin(a) * len * 0.12 - 6);
  ctx.lineTo(lx + Math.cos(a) * len, ly - 33 + Math.sin(a) * len * 0.12 + 6);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawWater(ctx, t, scene, look) {
  const g = ctx.createLinearGradient(0, SURFACE, 0, H);
  g.addColorStop(0, look.water[0]);
  g.addColorStop(0.45, look.water[1]);
  g.addColorStop(1, look.water[2]);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 12) ctx.lineTo(x, surfaceY(x, t));
  ctx.lineTo(W, surfaceY(W, t));
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();

  // sun or moon glitter on the water
  const gx = look.sun ? W * 0.64 : look.stars ? W * 0.84 : null;
  if (gx !== null) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const y = SURFACE + 6 + i * 6;
      const w = (26 - i) * (0.7 + 0.3 * Math.sin(t * 0.004 + i * 1.7));
      ctx.fillStyle = look.sun ? `rgba(255,205,150,${0.32 - i * 0.018})` : `rgba(200,225,240,${0.2 - i * 0.012})`;
      ctx.fillRect(gx - w / 2 + Math.sin(t * 0.002 + i) * 6, y, w, 1.6);
    }
    ctx.restore();
  }

  // light shafts by day, plankton by night
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (!look.stars && !look.storm) {
    for (let i = 0; i < Math.ceil(W / 190); i++) {
      const x = 120 + i * 190 + Math.sin(t * 0.0004 + i) * 30;
      const lg = ctx.createLinearGradient(0, SURFACE, 0, H * 0.85);
      lg.addColorStop(0, 'rgba(160,230,230,0.08)');
      lg.addColorStop(1, 'rgba(160,230,230,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(x - 20, SURFACE); ctx.lineTo(x + 20, SURFACE); ctx.lineTo(x + 80, H * 0.85); ctx.lineTo(x - 10, H * 0.85);
      ctx.fill();
    }
  }
  if (look.stars) {
    for (const p of scene.glow) {
      p.y -= p.v; if (p.y < SURFACE + 20) { p.y = H - 10; p.x = rand(0, W); }
      const a = 0.25 + 0.55 * Math.abs(Math.sin(t * 0.002 + p.p));
      ctx.fillStyle = `rgba(110,240,210,${a})`;
      ctx.beginPath(); ctx.arc(p.x + Math.sin(t * 0.001 + p.p) * 4, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();

  drawSeabed(ctx, t, scene, look);

  // ambient fish
  for (const f of scene.ambient) {
    f.x += f.vx;
    if (f.x < -40) f.x = W + 40;
    if (f.x > W + 40) f.x = -40;
    shadowFish(ctx, f.x, f.y + Math.sin(t * 0.002 + f.phase) * 6, f.size, look.stars ? 0.35 : 0.22, f.vx > 0 ? 1 : -1);
  }

  // bubbles
  ctx.strokeStyle = 'rgba(200,235,240,0.35)';
  ctx.lineWidth = 1;
  for (const b of scene.bubbles) {
    b.y -= b.v;
    b.x += Math.sin(t * 0.003 + b.y * 0.05) * 0.2;
    if (b.y < SURFACE + 4) { b.y = H; b.x = rand(0, W); }
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
  }

  // surface: a bright crest and a soft second wave behind it
  ctx.strokeStyle = 'rgba(230,245,245,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 12) { const y = surfaceY(x, t); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.lineTo(W, surfaceY(W, t));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(230,245,245,0.14)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 12) { const y = surfaceY(x + 40, t * 1.3) + 9; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();

  // ripples
  for (const r of scene.ripples) {
    r.r += 1.2; r.life -= 0.02;
    ctx.strokeStyle = `rgba(230,245,245,${Math.max(0, r.life) * 0.6})`;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
  }
  scene.ripples = scene.ripples.filter((r) => r.life > 0);
}

/** Sand and weed in the Shallows, coral on the Reef, black rock in the Abyss. */
function drawSeabed(ctx, t, scene, look) {
  const bedColor = look.bed === 'sand' ? '#3f7a6c' : look.bed === 'coral' ? '#2a6266' : '#061019';
  ctx.fillStyle = bedColor;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (const p of scene.bed) ctx.lineTo(p.x, p.y);
  ctx.lineTo(W, H);
  ctx.closePath(); ctx.fill();
  if (look.bed === 'sand') {
    ctx.strokeStyle = 'rgba(255,230,190,0.12)'; ctx.lineWidth = 2;
    ctx.beginPath();
    scene.bed.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }

  if (look.bed === 'rock' || look.bed === 'coral') {
    ctx.fillStyle = look.bed === 'rock' ? '#0a1824' : '#1d4a50';
    for (const r of scene.rocks) {
      const y = H - 18;
      ctx.beginPath(); ctx.ellipse(r.x, y, r.w * 0.5, r.h * 0.5, 0, Math.PI, 0); ctx.fill();
    }
  }

  if (look.bed === 'coral') {
    for (const c of scene.corals) {
      ctx.strokeStyle = c.hue; ctx.globalAlpha = 0.75; ctx.lineCap = 'round';
      const y0 = H - 22;
      for (let b = 0; b < 4; b++) {
        const ang = -Math.PI / 2 + (b - 1.5) * 0.35 + Math.sin(t * 0.0012 + c.seed + b) * 0.05;
        const len = c.h * (0.6 + 0.12 * b);
        ctx.lineWidth = 5 - b * 0.6;
        ctx.beginPath(); ctx.moveTo(c.x, y0);
        const mx = c.x + Math.cos(ang) * len * 0.6, my = y0 + Math.sin(ang) * len * 0.6;
        ctx.quadraticCurveTo(mx, my, c.x + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineCap = 'butt';
    }
  }

  // weeds sway everywhere but the deepest water
  if (look.bed !== 'rock') {
    for (const w of scene.weeds) {
      ctx.strokeStyle = look.weed;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(w.x, H - 20);
      for (let k = 0; k <= 1; k += 0.1) ctx.lineTo(w.x + Math.sin(t * 0.0015 + w.phase + k * 3) * 10 * k, H - 20 - w.h * k);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }
}

function drawStorm(ctx, t, scene) {
  ctx.save();
  ctx.strokeStyle = 'rgba(200,220,235,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const r of scene.rain) {
    r.y += r.v; r.x -= r.v * 0.25;
    if (r.y > H) { r.y = rand(-40, 0); r.x = rand(0, W + 60); }
    ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + 3, r.y - 12);
  }
  ctx.stroke();
  if (t > scene.nextFlash) { scene.flash = 1; scene.nextFlash = t + rand(5000, 12000); }
  if (scene.flash > 0) {
    ctx.fillStyle = `rgba(230,240,255,${scene.flash * 0.35})`;
    ctx.fillRect(0, 0, W, H);
    scene.flash *= 0.86; if (scene.flash < 0.02) scene.flash = 0;
  }
  ctx.restore();
}

/** A small boat and an angler in an orange oilskin and brass sou'wester. */
function drawBoat(ctx, t, c, look) {
  const bx = BOAT_X;
  const by = surfaceY(bx, t) - 4;
  const tilt = Math.sin(t * 0.0012) * 0.035;
  const load = c && (c.phase === 'bite' || c.phase === 'resolving' || c.phase === 'reeling') ? 1 : 0;
  const swing = c && c.phase === 'casting' ? Math.sin(Math.min(1, (t - c.castAt) / CAST_MS) * Math.PI) : 0;

  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(tilt);
  // lantern glow at night
  if (look.stars) {
    const lg = ctx.createRadialGradient(-46, -18, 2, -46, -18, 70);
    lg.addColorStop(0, 'rgba(255,200,120,0.45)'); lg.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = lg; ctx.fillRect(-120, -90, 150, 150);
  }
  // hull
  ctx.fillStyle = '#5a3a28';
  ctx.beginPath(); ctx.moveTo(-66, -2); ctx.lineTo(66, -2); ctx.quadraticCurveTo(58, 22, 40, 24); ctx.lineTo(-44, 24); ctx.quadraticCurveTo(-60, 20, -66, -2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ff6b2c'; ctx.fillRect(-62, 4, 124, 4);
  ctx.fillStyle = '#3d281c'; ctx.fillRect(-66, -4, 132, 4);
  // lantern on a pole at the stern
  ctx.strokeStyle = '#2a1c14'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-46, -4); ctx.lineTo(-46, -24); ctx.stroke();
  ctx.fillStyle = look.stars ? '#ffd08a' : '#e5b54a';
  ctx.fillRect(-49, -30, 6, 7);
  // angler: oilskin, arm, sou'wester
  ctx.fillStyle = '#ff6b2c';
  ctx.beginPath(); ctx.moveTo(-14, -4); ctx.lineTo(12, -4); ctx.lineTo(9, -30); ctx.lineTo(-11, -30); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f2d2b0';
  ctx.beginPath(); ctx.arc(-1, -37, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e5b54a';
  ctx.beginPath(); ctx.ellipse(-1, -42, 12, 3.5, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(-1, -43, 7, Math.PI, 0); ctx.fill();
  ctx.strokeStyle = '#ff6b2c'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(4, -24); ctx.lineTo(12, -20); ctx.stroke();
  ctx.lineCap = 'butt';

  const tipLocal = { x: 78 - swing * 30, y: -78 + load * 24 + swing * -10 };
  ctx.strokeStyle = '#2a1c14';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(10, -20);
  ctx.quadraticCurveTo(44, -54 + load * 8, tipLocal.x, tipLocal.y);
  ctx.stroke();
  ctx.strokeStyle = '#e5b54a'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(10, -20); ctx.quadraticCurveTo(44, -54 + load * 8, tipLocal.x, tipLocal.y); ctx.stroke();
  ctx.restore();

  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  return { x: bx + tipLocal.x * cos - tipLocal.y * sin, y: by + tipLocal.x * sin + tipLocal.y * cos };
}

function line(ctx, a, b, tension) {
  ctx.strokeStyle = 'rgba(240,248,248,0.7)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo((a.x + b.x) / 2, Math.max(a.y, b.y) + 40 * (1 - tension), b.x, b.y);
  ctx.stroke();
}

/** The DiveMarket bobber: buoy orange over white. */
function bobber(ctx, p, t, dunk) {
  if (!dunk) {
    ctx.strokeStyle = `rgba(255,107,44,${0.25 + 0.2 * Math.sin(t * 0.006)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 14, 4, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = '#f4f8f8';
  ctx.beginPath(); ctx.arc(p.x, p.y + 1, 8, 0, Math.PI); ctx.fill();
  ctx.fillStyle = dunk ? '#ff8a55' : '#ff6b2c';
  ctx.beginPath(); ctx.arc(p.x, p.y, 8, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#123038';
  ctx.fillRect(p.x - 1, p.y - 14, 2, 7);
}

function shadowFish(ctx, x, y, size, alpha, dir) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#04121c';
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  ctx.beginPath(); ctx.ellipse(0, 0, size, size * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-size * 0.9, 0); ctx.lineTo(-size * 1.5, -size * 0.4); ctx.lineTo(-size * 1.5, size * 0.4); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-size * 0.1, -size * 0.38); ctx.lineTo(size * 0.25, -size * 0.75); ctx.lineTo(size * 0.4, -size * 0.32); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function fishSprite(ctx, x, y, size, color, t, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.shadowColor = color; ctx.shadowBlur = 16;
  const body = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
  body.addColorStop(0, color); body.addColorStop(1, mix(color.length === 7 ? color : '#94a3b8', '#ffffff', 0.45));
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.ellipse(0, 0, size, size * 0.45, 0, 0, Math.PI * 2); ctx.fill();
  const flap = Math.sin(t * 0.04) * size * 0.2;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(-size * 0.85, 0); ctx.lineTo(-size * 1.45, -size * 0.45 + flap); ctx.lineTo(-size * 1.45, size * 0.45 + flap); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#0f172a';
  ctx.beginPath(); ctx.arc(size * 0.55, -size * 0.1, Math.max(1.5, size * 0.09), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/**
 * Strike timing: a ring closes in on the bobber. Strike when it meets the
 * dashed target ring, the middle of the window, for the best fish.
 */
function drawStrikeRing(ctx, p, progress, t) {
  const k = Math.min(1, progress);
  const outer = 64, inner = 12;
  const r = outer - (outer - inner) * k;
  const target = (outer + inner) / 2;
  const near = 1 - Math.min(1, Math.abs(r - target) / (target - inner));
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(230,242,239,0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(p.x, p.y, target, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = near > 0.7 ? '#58c79a' : near > 0.35 ? '#e5b54a' : '#ff8f7a';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.textAlign = 'center';
  const pulse = 1 + Math.sin(t * 0.03) * 0.06;
  ctx.font = `900 ${Math.round(44 * pulse)}px ${DISPLAY}`;
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(10,46,54,0.8)';
  ctx.strokeText('Strike!', p.x, p.y + outer + 44);
  ctx.fillStyle = '#ff6b2c';
  ctx.fillText('Strike!', p.x, p.y + outer + 44);
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

const LABEL = { warden: 'The warden chased you off', late: 'Too late. It got away', escaped: 'It slipped the hook', spooked: 'Too early. You spooked it', error: 'Could not reach the game server' };

// A landed fish is shown as a market tag: paper card, punched hole, string
// up to the rod tip. The same tag shape is used in the cooler.
function drawReveal(ctx, t, c) {
  const k = Math.min(1, (t - c.revealAt) / 320);
  const fade = Math.min(1, Math.max(0, (REVEAL_MS - (t - c.revealAt)) / 300));
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = 'center';
  const cx = W / 2;
  const y = H / 2 - 30 - ease(k) * 14;
  if (c.result?.hit) {
    const f = FISH[c.result.fish];
    const tw = 300, th = 108;
    // swing in from a slight tilt, like a tag on a string
    const swing = Math.sin(k * Math.PI * 2.5) * (1 - k) * 0.18;
    ctx.translate(cx, y - th / 2 - 26);
    ctx.rotate(swing);
    ctx.strokeStyle = 'rgba(230,242,239,0.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(0, 26); ctx.stroke();
    ctx.fillStyle = '#f2e8d2';
    roundRect(ctx, -tw / 2, 20, tw, th, 10); ctx.fill();
    ctx.fillStyle = f.color; ctx.fillRect(-tw / 2, 20, 10, th);
    ctx.fillStyle = '#0a2e36'; ctx.beginPath(); ctx.arc(0, 34, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#123038';
    ctx.font = `800 30px ${DISPLAY}`;
    ctx.fillText(f.name, 0, 76);
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = '#3d5a5f';
    ctx.fillText(`${formatWeight(c.result.weight || 0)}   ${f.rarity}   strike ${Math.round((c.result.quality || 0) * 100)}%`, 0, 104);
  } else {
    ctx.fillStyle = '#ffb08a'; ctx.font = `800 30px ${DISPLAY}`;
    ctx.fillText(LABEL[c.result?.reason] || 'It got away', cx, y);
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
  const size = W < 700 ? 21 : 15;
  ctx.font = `700 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + size * 1.6;
  const y = SURFACE + (H - SURFACE) * 0.5;
  ctx.fillStyle = 'rgba(10,46,54,0.72)';
  roundRect(ctx, W / 2 - w / 2, y - size * 0.95, w, size * 1.9, size * 0.95); ctx.fill();
  ctx.fillStyle = 'rgba(230,242,239,0.92)';
  ctx.fillText(text, W / 2, y + size * 0.35);
  ctx.restore();
}
