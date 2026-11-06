/**
 * Fishing rules, tested directly.
 *
 * The canvas is a rendering concern; these are the decisions that decide what
 * a player earns. Testing them separately is what keeps the economy honest.
 */
import { describe, it, expect } from 'vitest';
import { FISH, RODS, ZONES, weighFish, formatWeight, seasonAt, zonePool, zoneOpen, rollZoneFish as rzf, biteDelay, rollFish, rollFishWith, rollZoneFish, zoneHitChance, biteSlowdown, hitChance, strikeQuality, strikeHits } from './game';

describe('fishing rules', () => {
  it('a bite arrives within a playable window', () => {
    for (let i = 0; i < 50; i++) {
      const d = biteDelay();
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(3500);
    }
  });

  it('a perfect strike scores higher than an edge strike', () => {
    const perfect = strikeQuality(360, 720);
    const edge = strikeQuality(0, 720);
    expect(perfect).toBeGreaterThan(edge);
    expect(perfect).toBeCloseTo(1, 1);
  });

  it('a better rod widens the strike window', () => {
    expect(RODS.carbon.windowMs).toBeGreaterThan(RODS.bamboo.windowMs);
    expect(RODS.master.windowMs).toBeGreaterThan(RODS.carbon.windowMs);
  });

  it('a better rod improves rare odds', () => {
    const countRare = (rodId, n) => {
      let rare = 0;
      for (let i = 0; i < n; i++) {
        const id = rollFish(rodId, 1);
        if (FISH[id].rarity === 'rare' || FISH[id].rarity === 'epic' || FISH[id].rarity === 'legendary') rare++;
      }
      return rare;
    };
    const bamboo = countRare('bamboo', 3000);
    const master = countRare('master', 3000);
    expect(master).toBeGreaterThan(bamboo);
  });

  it('a strike can miss — fishing is not a guaranteed payout', () => {
    let misses = 0;
    for (let i = 0; i < 2000; i++) {
      if (!strikeHits('bamboo', 0.5)) misses++;
    }
    expect(misses).toBeGreaterThan(0);
    // And it is not a coin flip either: a decent strike lands more often.
    expect(misses).toBeLessThan(1000);
  });

  it('even the best rod and a perfect strike can miss', () => {
    let misses = 0;
    for (let i = 0; i < 2000; i++) {
      if (!strikeHits('master', 1.0)) misses++;
    }
    expect(misses).toBeGreaterThan(0);
  });

  it('a better rod lands more often', () => {
    const hits = (rodId) => {
      let n = 0;
      for (let i = 0; i < 3000; i++) if (strikeHits(rodId, 0.5)) n++;
      return n;
    };
    expect(hits('master')).toBeGreaterThan(hits('bamboo'));
  });

  it('every roll returns a real fish', () => {
    for (let i = 0; i < 500; i++) {
      const id = rollFish('bamboo', Math.random());
      expect(FISH[id]).toBeDefined();
    }
  });

  it('the server roll is a pure function of its random input', () => {
    expect(rollFishWith('master', 1, 0.42)).toBe(rollFishWith('master', 1, 0.42));
    expect(rollFishWith('bamboo', 0, 0)).toBe('guppy');
    expect(rollFishWith('bamboo', 0, 0.9999)).toBe('koi');
  });

  it('hit chance rises with timing and rod, capped at 95%', () => {
    expect(hitChance('bamboo', 1)).toBeGreaterThan(hitChance('bamboo', 0));
    expect(hitChance('master', 1)).toBeLessThanOrEqual(0.95);
  });

  it('koi only bite in a healthy abyss', () => {
    const rolls = (health) => Array.from({ length: 2000 }, (_, i) => rollZoneFish('abyss', 'master', 1, health, i / 2000));
    expect(rolls(0.9)).toContain('koi');
    expect(rolls(0.5)).not.toContain('koi');
  });

  it('a zone only yields its own fish', () => {
    for (let i = 0; i < 500; i++) {
      expect(Object.keys(ZONES.shallows.pool)).toContain(rollZoneFish('shallows', 'master', 1, 1, i / 500));
    }
  });

  it('a thin zone keeps the same strike odds', () => {
    expect(zoneHitChance('carbon', 1, 0.1)).toBe(zoneHitChance('carbon', 1, 1));
  });

  it('a scarce zone makes you wait longer for a bite, up to twice as long', () => {
    expect(biteSlowdown(1)).toBe(1);
    expect(biteSlowdown(0.5)).toBe(1);
    expect(biteSlowdown(0.25)).toBeCloseTo(1.5);
    expect(biteSlowdown(0)).toBe(2);
    expect(biteSlowdown(-1)).toBe(2);
  });

  it('every weight stays inside its species range and big fish are rare', () => {
    for (const id of Object.keys(FISH)) {
      const ws = Array.from({ length: 1000 }, (_, i) => weighFish(id, 1, i / 1000));
      expect(Math.min(...ws)).toBeGreaterThanOrEqual(FISH[id].minG);
      expect(Math.max(...ws)).toBeLessThanOrEqual(FISH[id].maxG);
      const median = [...ws].sort((a, b) => a - b)[500];
      expect(median).toBeLessThan((FISH[id].minG + FISH[id].maxG) / 2);
    }
  });

  it('a clean strike weighs a little more', () => {
    expect(weighFish('tuna', 1, 0.9)).toBeGreaterThan(weighFish('tuna', 0, 0.9));
    expect(formatWeight(850)).toBe('850 g');
    expect(formatWeight(12340)).toBe('12.34 kg');
  });

  it('seasons rotate weekly with the same formula as the contract', () => {
    const wk = 7 * 86_400_000;
    const a = seasonAt(2966 * wk + 5), b = seasonAt(2967 * wk + 5);
    expect(a.week).toBe(2966);
    expect(a.id).toBe('koi_run');
    expect(b.id).toBe('tuna_run');
  });

  it('a storm closes the Abyss and a koi run brings koi to the Reef', () => {
    expect(zoneOpen('abyss', 'storm')).toBe(false);
    expect(zoneOpen('reef', 'storm')).toBe(true);
    expect(Object.keys(zonePool('reef', 'calm'))).not.toContain('koi');
    expect(Object.keys(zonePool('reef', 'koi_run'))).toContain('koi');
    const reefRolls = Array.from({ length: 2000 }, (_, i) => rzf('reef', 'master', 1, 0.9, i / 2000, 'koi_run'));
    expect(reefRolls).toContain('koi');
  });
});
