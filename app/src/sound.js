/**
 * Sound for the fishing scene, synthesized with Web Audio: no files to load.
 *
 * Browsers only allow audio after a user gesture, so nothing plays until the
 * first cast calls `unlock()`. The mute choice is remembered per browser.
 */
let ctx = null;
let master = null;
let waves = null;
let muted = (() => { try { return localStorage.getItem('dm:sound') === 'off'; } catch { return false; } })();
const listeners = new Set();

export const isMuted = () => muted;
export function onMuteChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('dm:sound', m ? 'off' : 'on'); } catch { /* storage blocked */ }
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.05);
  listeners.forEach((fn) => fn(m));
}

/** Create the audio graph on the first gesture and start the sea. */
export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.9;
  master.connect(ctx.destination);
  startWaves();
}

function noiseBuffer(seconds) {
  const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** Soft surf: looping noise through a low-pass whose level breathes slowly. */
function startWaves() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(4);
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 420;
  const g = ctx.createGain(); g.gain.value = 0.035;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.025;
  lfo.connect(lfoGain).connect(g.gain);
  src.connect(lp).connect(g).connect(master);
  src.start(); lfo.start();
  waves = g;
}

function tone({ type = 'sine', from, to = from, dur = 0.2, vol = 0.2, at = 0 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.3, vol = 0.2, from = 2000, to = 400, type = 'bandpass', q = 1, at = 0 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

const NOTES = { C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568 };

export const sfx = {
  /** The line whips out. */
  cast() { noise({ dur: 0.45, vol: 0.12, from: 600, to: 3200, q: 0.8 }); },
  /** The bobber lands. */
  splash() { noise({ dur: 0.35, vol: 0.18, from: 1800, to: 300, type: 'lowpass' }); tone({ from: 320, to: 120, dur: 0.18, vol: 0.08 }); },
  /** Something takes the bait: two quick bloops. */
  bite() { tone({ from: 420, to: 180, dur: 0.14, vol: 0.22 }); tone({ from: 460, to: 190, dur: 0.14, vol: 0.2, at: 0.13 }); noise({ dur: 0.2, vol: 0.12, from: 2400, to: 600, at: 0.02 }); },
  /** The reel ratchets as the fish comes in. */
  reel(seconds = 0.9) {
    const n = Math.round(seconds * 22);
    for (let i = 0; i < n; i++) tone({ type: 'square', from: 2200, to: 1800, dur: 0.018, vol: 0.035, at: i * (seconds / n) });
  },
  /** A chime that grows with the fish's rarity. */
  caught(rarity = 'common') {
    const seq = {
      common: ['C5', 'E5'],
      uncommon: ['C5', 'E5', 'G5'],
      rare: ['C5', 'E5', 'G5', 'C6'],
      epic: ['C5', 'E5', 'G5', 'C6', 'E6'],
      legendary: ['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C6', 'G6'],
    }[rarity] || ['C5', 'E5'];
    seq.forEach((n, i) => tone({ type: 'triangle', from: NOTES[n], dur: 0.32, vol: 0.14, at: i * 0.085 }));
    if (rarity === 'legendary' || rarity === 'epic') noise({ dur: 0.9, vol: 0.05, from: 6000, to: 9000, type: 'highpass', at: 0.2 });
  },
  /** It got away. */
  escaped() { tone({ type: 'triangle', from: 392, to: 196, dur: 0.38, vol: 0.12 }); noise({ dur: 0.25, vol: 0.08, from: 1200, to: 300, type: 'lowpass' }); },
  /** Struck too early. */
  spooked() { tone({ type: 'sine', from: 300, to: 140, dur: 0.22, vol: 0.12 }); },
};
