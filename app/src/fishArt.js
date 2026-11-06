/**
 * Fish art for the fishing scene: one drawing per species, so a guppy, a
 * tilapia, a snapper, a tuna and a koi each look and swim like themselves.
 *
 * Every fish is drawn facing +x, centred on (x, y), `len` scene units from
 * nose to tail tip. Colours can be pulled toward the water (`shade`) for fish
 * seen at depth, and `silhouette` draws a dark shape for a fish not yet seen.
 * Nothing here affects a catch: the game server decides what was caught.
 */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function tint(c, shade, to = '#0b2d3b') {
  if (!shade) return c;
  const a = hex(c), b = hex(to);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * shade)).join(',')})`;
}

/** How each species looks and moves. `beat` is tail beats per second. */
export const SPECIES = {
  guppy: {
    body: 0.34, beat: 4.2, amp: 0.34, px: 26,
    back: '#7fb9d6', belly: '#e3f1f4', fin: '#ff8a3d', fin2: '#4fc3e8',
  },
  tilapia: {
    body: 0.56, beat: 1.8, amp: 0.2, px: 46,
    back: '#55705f', belly: '#c9d3b8', fin: '#7d6a4d', bars: '#2f4438', edge: '#d0574a',
  },
  snapper: {
    body: 0.44, beat: 1.6, amp: 0.18, px: 56,
    back: '#d9475a', belly: '#ffc2c0', fin: '#e8636e', eye: '#ffd24a',
  },
  tuna: {
    body: 0.27, beat: 3.0, amp: 0.12, px: 96,
    back: '#1b2f63', belly: '#d7e1ea', fin: '#2b4a8a', finlet: '#ffcf3a', stripe: '#6f86b5',
  },
  koi: {
    body: 0.3, beat: 1.0, amp: 0.24, px: 74,
    back: '#fbf4ea', belly: '#fffaf2', fin: 'rgba(255,196,150,0.62)', patch: '#ff6a2a', ink: '#1d1d24',
  },
};

/** Scene length for a landed fish: its species size, scaled by its weight. */
export function landedLength(id, weightG, minG, maxG) {
  const s = SPECIES[id] || SPECIES.guppy;
  const k = maxG > minG ? Math.max(0, Math.min(1, (weightG - minG) / (maxG - minG))) : 0.5;
  return s.px * (0.78 + 0.5 * k);
}

/**
 * Draw one fish. `t` is the animation clock in ms; `phase` desyncs fish.
 * opts: { angle, dir (1 faces right, -1 left), alpha, shade 0..1,
 *         silhouette, glow, speed (tail beat multiplier), phase }
 */
export function drawFish(ctx, id, x, y, len, t, opts = {}) {
  const s = SPECIES[id] || SPECIES.guppy;
  const { angle = 0, dir = 1, alpha = 1, shade = 0, silhouette = false, glow = false, speed = 1, phase = 0 } = opts;
  const L = len, H = len * s.body;
  const beat = Math.sin((t / 1000) * s.beat * Math.PI * 2 * speed + phase);
  const col = (c) => (silhouette ? '#04131d' : tint(c, shade));

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(dir, 1);
  if (glow && !silhouette) { ctx.shadowColor = id === 'koi' ? 'rgba(255,190,120,0.9)' : 'rgba(150,220,255,0.6)'; ctx.shadowBlur = 18; }

  ART[id](ctx, L, H, beat, s, col, silhouette);

  ctx.restore();
}

// --- species ----------------------------------------------------------------

/** A body shape from nose (+L/2) to tail root, with top and bottom bulges. */
function bodyPath(ctx, L, H, { nose = 0.5, root = -0.34, top = 1, bottom = 1, peak = 0.08, head = 0.18 } = {}) {
  const n = L * nose, r = L * root;
  ctx.beginPath();
  ctx.moveTo(n, H * 0.02);
  ctx.bezierCurveTo(n - L * head, -H * 0.55 * top, L * peak, -H * 0.62 * top, r, -H * 0.11);
  ctx.lineTo(r, H * 0.11);
  ctx.bezierCurveTo(L * peak, H * 0.6 * bottom, n - L * head, H * 0.5 * bottom, n, H * 0.02);
  ctx.closePath();
}

function shade2(ctx, L, H, col, back, belly) {
  const g = ctx.createLinearGradient(0, -H * 0.55, 0, H * 0.55);
  g.addColorStop(0, col(back));
  g.addColorStop(0.55, col(belly));
  g.addColorStop(1, col(belly));
  return g;
}

function eye(ctx, x, y, r, col, iris = '#0d1116', ring = '#f4f4f0', sil = false) {
  if (sil) return;
  ctx.fillStyle = col(ring); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = iris; ctx.beginPath(); ctx.arc(x + r * 0.15, y, r * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(x + r * 0.35, y - r * 0.3, r * 0.22, 0, Math.PI * 2); ctx.fill();
}

const ART = {
  /** Small and quick, with a huge fan tail in orange and electric blue. */
  guppy(ctx, L, H, beat, s, col, sil) {
    const root = -L * 0.12;
    ctx.save();
    ctx.translate(root, 0);
    ctx.rotate(beat * s.amp);
    const tail = ctx.createLinearGradient(0, 0, -L * 0.42, 0);
    tail.addColorStop(0, col(s.fin)); tail.addColorStop(1, col(s.fin2));
    ctx.fillStyle = sil ? col('#000000') : tail;
    ctx.beginPath();
    ctx.moveTo(0, -H * 0.12);
    ctx.quadraticCurveTo(-L * 0.18, -H * 1.25, -L * 0.42, -H * 0.9);
    ctx.quadraticCurveTo(-L * 0.5, 0, -L * 0.42, H * 0.9);
    ctx.quadraticCurveTo(-L * 0.18, H * 1.25, 0, H * 0.12);
    ctx.closePath(); ctx.fill();
    if (!sil) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(0.6, L * 0.012);
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(-L * 0.04, 0); ctx.lineTo(-L * 0.4, i * H * 0.36); ctx.stroke(); }
    }
    ctx.restore();
    bodyPath(ctx, L, H, { nose: 0.38, root: -0.14, peak: 0.12, head: 0.12 });
    ctx.fillStyle = shade2(ctx, L, H, col, s.back, s.belly); ctx.fill();
    // a little dorsal flag
    ctx.fillStyle = col(s.fin2);
    ctx.beginPath(); ctx.moveTo(L * 0.02, -H * 0.42); ctx.lineTo(-L * 0.1, -H * 0.95); ctx.lineTo(-L * 0.12, -H * 0.36); ctx.closePath(); ctx.fill();
    eye(ctx, L * 0.26, -H * 0.08, Math.max(1.4, H * 0.17), col, '#0d1116', '#f4f4f0', sil);
  },

  /** Deep, round body with dark vertical bars and a long spiny back fin. */
  tilapia(ctx, L, H, beat, s, col, sil) {
    // tail: rounded paddle with a red edge
    ctx.save();
    ctx.translate(-L * 0.36, 0);
    ctx.rotate(beat * s.amp);
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.moveTo(0, -H * 0.12); ctx.quadraticCurveTo(-L * 0.17, -H * 0.55, -L * 0.15, 0); ctx.quadraticCurveTo(-L * 0.17, H * 0.55, 0, H * 0.12); ctx.closePath(); ctx.fill();
    if (!sil) { ctx.strokeStyle = col(s.edge); ctx.lineWidth = Math.max(1, L * 0.02); ctx.beginPath(); ctx.moveTo(-L * 0.12, -H * 0.4); ctx.quadraticCurveTo(-L * 0.17, 0, -L * 0.12, H * 0.4); ctx.stroke(); }
    ctx.restore();
    // spiny dorsal running most of the back
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.moveTo(L * 0.2, -H * 0.42);
    for (let i = 0; i <= 8; i++) { const fx = L * 0.2 - i * L * 0.065; ctx.lineTo(fx - L * 0.02, -H * (0.78 + (i % 2) * 0.08)); ctx.lineTo(fx - L * 0.05, -H * 0.48); }
    ctx.lineTo(-L * 0.34, -H * 0.2); ctx.closePath(); ctx.fill();
    // anal fin
    ctx.beginPath(); ctx.moveTo(-L * 0.05, H * 0.42); ctx.lineTo(-L * 0.25, H * 0.62); ctx.lineTo(-L * 0.32, H * 0.2); ctx.closePath(); ctx.fill();
    bodyPath(ctx, L, H, { nose: 0.42, root: -0.36, peak: 0.02, head: 0.16 });
    ctx.fillStyle = shade2(ctx, L, H, col, s.back, s.belly); ctx.fill();
    if (!sil) {
      ctx.save(); ctx.clip();
      ctx.fillStyle = col(s.bars); ctx.globalAlpha *= 0.4;
      for (let i = 0; i < 6; i++) { const bx = L * 0.22 - i * L * 0.1; ctx.fillRect(bx, -H * 0.6, L * 0.035, H * 1.2); }
      ctx.restore();
      ctx.strokeStyle = 'rgba(20,30,25,0.35)'; ctx.lineWidth = Math.max(0.8, L * 0.012);
      ctx.beginPath(); ctx.arc(L * 0.26, 0, H * 0.34, -1.1, 1.1); ctx.stroke(); // gill
    }
    // pectoral fin
    ctx.fillStyle = col(s.fin); ctx.globalAlpha *= 0.85;
    ctx.beginPath(); ctx.ellipse(L * 0.14, H * 0.12, L * 0.08, H * 0.1, 0.5 + beat * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha /= 0.85;
    eye(ctx, L * 0.33, -H * 0.12, Math.max(1.6, H * 0.1), col, '#0d1116', '#e9e1b8', sil);
  },

  /** Rosy red, a steep forehead, sharp dorsal spines and a forked tail. */
  snapper(ctx, L, H, beat, s, col, sil) {
    ctx.save();
    ctx.translate(-L * 0.34, 0);
    ctx.rotate(beat * s.amp);
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.moveTo(0, -H * 0.1); ctx.lineTo(-L * 0.2, -H * 0.62); ctx.quadraticCurveTo(-L * 0.12, 0, -L * 0.2, H * 0.62); ctx.lineTo(0, H * 0.1); ctx.closePath(); ctx.fill();
    ctx.restore();
    // spiny dorsal: tall at the front, soft at the back
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.moveTo(L * 0.18, -H * 0.42);
    const spines = [0.95, 1.05, 0.98, 0.9, 0.82, 0.74];
    spines.forEach((h, i) => { const fx = L * 0.15 - i * L * 0.055; ctx.lineTo(fx, -H * h); ctx.lineTo(fx - L * 0.03, -H * 0.5); });
    ctx.quadraticCurveTo(-L * 0.24, -H * 0.72, -L * 0.32, -H * 0.16); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-L * 0.08, H * 0.38); ctx.lineTo(-L * 0.24, H * 0.6); ctx.lineTo(-L * 0.3, H * 0.16); ctx.closePath(); ctx.fill();
    bodyPath(ctx, L, H, { nose: 0.46, root: -0.34, peak: 0.08, head: 0.08, top: 1.1 });
    ctx.fillStyle = shade2(ctx, L, H, col, s.back, s.belly); ctx.fill();
    if (!sil) {
      ctx.save(); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.ellipse(L * 0.02, H * 0.05, L * 0.34, H * 0.08, -0.05, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(120,20,30,0.35)'; ctx.lineWidth = Math.max(0.8, L * 0.01);
      ctx.beginPath(); ctx.arc(L * 0.3, H * 0.02, H * 0.36, -1.2, 1.1); ctx.stroke();
    }
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.ellipse(L * 0.16, H * 0.14, L * 0.09, H * 0.08, 0.6 + beat * 0.2, 0, Math.PI * 2); ctx.fill();
    eye(ctx, L * 0.36, -H * 0.12, Math.max(1.8, H * 0.11), col, '#20130f', s.eye, sil);
  },

  /** A torpedo: navy back, silver belly, yellow finlets, a crescent tail. */
  tuna(ctx, L, H, beat, s, col, sil) {
    // narrow tail stalk and a lunate tail
    ctx.save();
    ctx.translate(-L * 0.4, 0);
    ctx.rotate(beat * s.amp);
    ctx.fillStyle = col(s.back);
    ctx.beginPath();
    ctx.moveTo(L * 0.02, 0);
    ctx.quadraticCurveTo(-L * 0.04, -H * 0.4, -L * 0.1, -H * 1.25);
    ctx.quadraticCurveTo(-L * 0.06, -H * 0.3, -L * 0.04, 0);
    ctx.quadraticCurveTo(-L * 0.06, H * 0.3, -L * 0.1, H * 1.25);
    ctx.quadraticCurveTo(-L * 0.04, H * 0.4, L * 0.02, 0);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // second dorsal and anal: tall sickles
    ctx.fillStyle = col(s.finlet);
    ctx.beginPath(); ctx.moveTo(-L * 0.06, -H * 0.42); ctx.lineTo(-L * 0.16, -H * 1.15); ctx.lineTo(-L * 0.16, -H * 0.38); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-L * 0.08, H * 0.4); ctx.lineTo(-L * 0.18, H * 1.05); ctx.lineTo(-L * 0.17, H * 0.34); ctx.closePath(); ctx.fill();
    // first dorsal, low
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.moveTo(L * 0.16, -H * 0.46); ctx.lineTo(L * 0.04, -H * 0.85); ctx.lineTo(-L * 0.02, -H * 0.45); ctx.closePath(); ctx.fill();
    // body
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.bezierCurveTo(L * 0.38, -H * 0.62, L * 0.02, -H * 0.66, -L * 0.4, -H * 0.07);
    ctx.lineTo(-L * 0.4, H * 0.07);
    ctx.bezierCurveTo(L * 0.02, H * 0.66, L * 0.38, H * 0.6, L * 0.5, 0);
    ctx.closePath();
    const tg = ctx.createLinearGradient(0, -H * 0.6, 0, H * 0.6);
    tg.addColorStop(0, col(s.back)); tg.addColorStop(0.42, col(s.back)); tg.addColorStop(0.52, col(s.stripe)); tg.addColorStop(0.62, col(s.belly)); tg.addColorStop(1, col(s.belly));
    ctx.fillStyle = tg; ctx.fill();
    if (!sil) {
      ctx.save(); ctx.clip();
      ctx.strokeStyle = tint(s.stripe, 0); ctx.globalAlpha *= 0.6; ctx.lineWidth = Math.max(1, H * 0.06);
      ctx.beginPath(); ctx.moveTo(L * 0.36, -H * 0.05); ctx.quadraticCurveTo(0, H * 0.02, -L * 0.38, 0); ctx.stroke();
      ctx.restore();
    }
    // finlets: a row of small yellow flags on top and bottom of the stalk
    ctx.fillStyle = col(s.finlet);
    for (let i = 0; i < 6; i++) {
      const fx = -L * 0.2 - i * L * 0.032, hy = H * (0.36 - i * 0.045);
      ctx.beginPath(); ctx.moveTo(fx, -hy); ctx.lineTo(fx - L * 0.025, -hy - H * 0.16); ctx.lineTo(fx - L * 0.03, -hy); ctx.fill();
      ctx.beginPath(); ctx.moveTo(fx, hy); ctx.lineTo(fx - L * 0.025, hy + H * 0.16); ctx.lineTo(fx - L * 0.03, hy); ctx.fill();
    }
    // long pectoral
    ctx.fillStyle = col(s.fin);
    ctx.beginPath(); ctx.moveTo(L * 0.24, H * 0.05); ctx.lineTo(L * 0.02, H * 0.28 + beat * H * 0.04); ctx.lineTo(L * 0.2, H * 0.16); ctx.closePath(); ctx.fill();
    eye(ctx, L * 0.4, -H * 0.06, Math.max(1.8, H * 0.13), col, '#0b0f1a', '#c9d3de', sil);
  },

  /** Long and slow, white with red-orange patches, barbels and veil fins. */
  koi(ctx, L, H, beat, s, col, sil) {
    // the body flexes: tail and veil sway more than the head
    const bend = beat * s.amp;
    ctx.save();
    ctx.translate(-L * 0.3, 0);
    ctx.rotate(bend);
    ctx.fillStyle = sil ? col('#000000') : s.fin;
    ctx.beginPath();
    ctx.moveTo(0, -H * 0.12);
    ctx.bezierCurveTo(-L * 0.12, -H * 0.9, -L * 0.28, -H * 0.8, -L * 0.24, -H * 0.1);
    ctx.quadraticCurveTo(-L * 0.18, 0, -L * 0.24, H * 0.1);
    ctx.bezierCurveTo(-L * 0.28, H * 0.8, -L * 0.12, H * 0.9, 0, H * 0.12);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // veil pectorals
    ctx.fillStyle = sil ? col('#000000') : s.fin;
    ctx.save(); ctx.translate(L * 0.16, H * 0.3); ctx.rotate(0.7 + beat * 0.25);
    ctx.beginPath(); ctx.ellipse(-L * 0.06, 0, L * 0.1, H * 0.28, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    bodyPath(ctx, L, H, { nose: 0.48, root: -0.32, peak: 0.04, head: 0.2, top: 0.95, bottom: 0.9 });
    ctx.fillStyle = shade2(ctx, L, H, col, s.back, s.belly); ctx.fill();
    if (!sil) {
      ctx.save(); ctx.clip();
      ctx.fillStyle = col(s.patch);
      ctx.beginPath(); ctx.ellipse(L * 0.3, -H * 0.18, L * 0.12, H * 0.32, 0.2, 0, Math.PI * 2); ctx.fill(); // tancho cap
      ctx.beginPath(); ctx.ellipse(L * 0.02, -H * 0.3, L * 0.16, H * 0.3, -0.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-L * 0.2, -H * 0.15, L * 0.09, H * 0.25, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col(s.ink);
      ctx.beginPath(); ctx.ellipse(-L * 0.06, -H * 0.42, L * 0.03, H * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath(); ctx.ellipse(L * 0.05, H * 0.18, L * 0.3, H * 0.08, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // barbels
      ctx.strokeStyle = col('#e8c9a8'); ctx.lineWidth = Math.max(0.8, L * 0.008);
      ctx.beginPath(); ctx.moveTo(L * 0.47, H * 0.05); ctx.quadraticCurveTo(L * 0.52, H * 0.25, L * 0.46, H * 0.36 + beat * H * 0.05); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(L * 0.45, H * 0.08); ctx.quadraticCurveTo(L * 0.47, H * 0.3, L * 0.4, H * 0.4); ctx.stroke();
    }
    // a thin dorsal ridge
    ctx.fillStyle = sil ? col('#000000') : s.fin;
    ctx.beginPath(); ctx.moveTo(L * 0.12, -H * 0.46); ctx.quadraticCurveTo(-L * 0.04, -H * 0.85, -L * 0.18, -H * 0.36); ctx.closePath(); ctx.fill();
    eye(ctx, L * 0.38, -H * 0.06, Math.max(1.6, H * 0.1), col, '#1a1210', '#f0e2cf', sil);
  },
};
