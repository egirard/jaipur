import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_CHECK_DEFAULTS, SWEEP_DEFAULTS, WASH_LEVELS, applyMove, brightnessPercent, checkEngagement, isEngaged, loadCloth,
  noEvidenceReason, saveCloth, screenKey, startSweep, stepSweep, sweepWaiting, sweepWash, trackedShare, washIndex, type PhoneSample
} from './backgroundAdapter';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

/** A phone's pose in hand over the table: tilted down, swaying a little. */
const inHand = { pitch: -45, moved: 0.03, turned: 4 };
/** Lying face-up on the cloth: camera straight down into the table, not moving. */
const faceUp = { pitch: -90, moved: 0.001, turned: 0.1 };
/** Propped against something, pointing at the table, but not moving. */
const propped = { pitch: -40, moved: 0.002, turned: 0.2 };

/** A phone reporting every 2 s from `from` to `to` with the given tracked share. */
function phone(from: number, to: number, share: number, extra: Partial<PhoneSample> = {}): PhoneSample[] {
  const out: PhoneSample[] = [];
  for (let at = from; at <= to; at += 2000) {
    const frames = 60;
    const tracked = Math.round(frames * share);
    out.push({ at, frames, tracked, emulated: frames - tracked, state: tracked > 0 ? 'tracked' : 'emulated', seen: true, ...inHand, ...extra });
  }
  return out;
}

describe('engagement', () => {
  const base: PhoneSample = { at: 0, frames: 60, tracked: 60, emulated: 0, state: 'tracked', seen: true };
  it('is a phone held upright that moved or turned in the interval', () => {
    expect(isEngaged({ ...base, ...inHand })).toBe(true);
    expect(isEngaged({ ...base, pitch: -60, moved: 0, turned: 2 })).toBe(true); // turned only
    expect(isEngaged({ ...base, pitch: -60, moved: 0.02, turned: 0 })).toBe(true); // moved only
    expect(isEngaged({ ...base, ...faceUp })).toBe(false);
    expect(isEngaged({ ...base, pitch: 90, moved: 0.5, turned: 90 })).toBe(false); // face-down, however it moves
    expect(isEngaged({ ...base, ...propped })).toBe(false);
    expect(isEngaged(base)).toBe(false); // no pose: an older viewer
  });
});

describe('tracked share', () => {
  it('aggregates every engaged phone that has seen the table since the window start and flags a lost table', () => {
    const w = trackedShare({ a: phone(0, 10_000, 1), b: phone(0, 10_000, 0.5) }, 4000);
    expect(w.phones).toBe(2);
    expect(w.frames).toBe(4 * 60 * 2);
    expect(w.share).toBeCloseTo(0.75);
    expect(w.lost).toBe(false);
    const lost = trackedShare({ a: [...phone(0, 4000, 1), { at: 6000, frames: 60, tracked: 0, emulated: 0, state: 'lost', seen: true, ...inHand }] }, 0);
    expect(lost.lost).toBe(true);
  });

  it('ignores phones that never saw the table and ended sessions', () => {
    const w = trackedShare({ blind: phone(0, 10_000, 0, { seen: false }), gone: phone(0, 10_000, 1, { state: 'ended' }) }, 0);
    expect(w).toEqual({ share: 0, frames: 0, tracked: 0, phones: 0, idle: 0, blind: 0, lost: false });
  });

  it('drops the intervals a phone lay still, counts such a phone as idle, and a poseless viewer as blind', () => {
    // Tracking fine in hand, then set down face-up and "lost": the lost intervals must not count.
    const setDown = { p: [...phone(0, 6000, 1), ...phone(8000, 20_000, 0, { ...faceUp, state: 'lost' })] };
    const w = trackedShare(setDown, 0);
    expect(w.phones).toBe(1);
    expect(w.share).toBe(1);
    expect(w.lost).toBe(false);
    const later = trackedShare(setDown, 8000);
    expect(later).toMatchObject({ frames: 0, phones: 0, idle: 1, blind: 0 });
    expect(noEvidenceReason(later)).toContain('lying still');
    const old = trackedShare({ p: phone(0, 6000, 1, { pitch: undefined, moved: undefined, turned: undefined }) }, 0);
    expect(old).toMatchObject({ frames: 0, phones: 0, idle: 0, blind: 1 });
    expect(noEvidenceReason(old)).toContain('too old');
    expect(noEvidenceReason(trackedShare({}, 0))).toContain('no phone in AR');
    // `only` restricts to some viewers.
    expect(trackedShare({ a: phone(0, 6000, 1), b: phone(0, 6000, 0) }, 0, (id) => id === 'a').share).toBe(1);
  });
});

describe('the sweep', () => {
  const cfg = SWEEP_DEFAULTS;
  const levelMs = cfg.settleMs + cfg.holdMs;

  it('measures the current level first, steps darker while the floor holds, and recommends the last level that held', () => {
    // Tracking is perfect down to 55% brightness (wash 0.45) and collapses at 45% (wash 0.55).
    const shareAt = (wash: number) => (wash <= 0.45 ? 0.98 : 0.3);
    let s = startSweep(0, 0);
    let now = 0;
    const samples: Record<string, PhoneSample[]> = { p: [] };
    for (let guard = 0; guard < 20 && s.phase === 'holding'; guard++) {
      const wash = sweepWash(s)!;
      samples.p.push(...phone(now, now + levelMs, shareAt(wash)));
      now += levelMs + 1;
      s = stepSweep(s, now, samples, cfg);
    }
    expect(s.phase).toBe('done');
    if (s.phase !== 'done') return;
    expect(WASH_LEVELS[s.recommended]).toBe(0.45);
    expect(s.results.map((r) => r.held)).toEqual([true, true, true, false]);
    expect(s.reason).toContain('55% is the dimmest that held');
  });

  it('holds every level when the phone never falters', () => {
    let s = startSweep(0, 2);
    let now = 0;
    const samples: Record<string, PhoneSample[]> = { p: [] };
    while (s.phase === 'holding') {
      samples.p.push(...phone(now, now + levelMs, 1));
      now += levelMs + 1;
      s = stepSweep(s, now, samples, cfg);
    }
    expect(s.phase).toBe('done');
    if (s.phase === 'done') expect(s.recommended).toBe(WASH_LEVELS.length - 1);
  });

  it('waits out the grace for a phone that was set down, then aborts saying so; aborts outright on a poor baseline', () => {
    let s = startSweep(0, 0);
    expect(stepSweep(s, levelMs - 1, {}, cfg).phase).toBe('holding'); // not yet
    expect(sweepWaiting(s, levelMs - 1, cfg)).toBe(false);
    s = stepSweep(s, levelMs + 1, {}, cfg);
    expect(s.phase).toBe('holding'); // grace: nothing counted yet
    expect(sweepWaiting(s, levelMs + 1, cfg)).toBe(true);
    s = stepSweep(s, levelMs + cfg.graceMs + 1, {}, cfg);
    expect(s.phase).toBe('aborted');
    if (s.phase === 'aborted') expect(s.reason).toContain('no phone in AR');
    // The phone lay face-up on the cloth the whole hold.
    const down = stepSweep(startSweep(0, 0), levelMs + cfg.graceMs + 1, { p: phone(0, levelMs + cfg.graceMs, 0, faceUp) }, cfg);
    expect(down.phase).toBe('aborted');
    if (down.phase === 'aborted') expect(down.reason).toContain('lying still');
    // Picked up again inside the grace: the hold completes from the engaged samples.
    const back = stepSweep(startSweep(0, 0), levelMs + 6000, { p: [...phone(0, levelMs, 0, faceUp), ...phone(levelMs + 1000, levelMs + 6000, 1)] }, cfg);
    expect(back.phase).toBe('holding');
    if (back.phase === 'holding') expect(back.index).toBe(1);
    const poor = stepSweep(startSweep(0, 0), levelMs + 1, { p: phone(0, levelMs, 0.2) }, cfg);
    expect(poor.phase).toBe('aborted');
    if (poor.phase === 'aborted') expect(poor.reason).toContain('already poor');
  });
});

describe('the first-engagement check', () => {
  const cfg = ENGAGEMENT_CHECK_DEFAULTS;
  const now = 1_000_000;
  const state = { wash: 0.55, ceiling: null, lastChangeAt: 0 };
  const poorInHand = { p: phone(now - cfg.evalMs, now, 0.3) };

  it('steps one level brighter while a phone in its first window tracks poorly in hand, once per cooldown, remembering the failed level', () => {
    const move = checkEngagement(state, now, poorInHand, { p: now - 30_000 }, cfg);
    expect(move?.direction).toBe('brighter');
    expect(move?.wash).toBe(0.45);
    expect(move?.reason).toContain('first engaging');
    const after = applyMove(state, move!, now);
    expect(after.ceiling).toBe(0.55);
    expect(checkEngagement(after, now + 1000, { p: phone(now - cfg.evalMs, now + 1000, 0.3) }, { p: now - 30_000 }, cfg)).toBeNull(); // cooling down
    // After the cooldown, only evidence since the change counts: the phone did fine at the new level.
    const later = now + cfg.cooldownMs + 1;
    expect(checkEngagement(after, later, { p: [...phone(now - cfg.evalMs, now, 0.3), ...phone(now + 1, later, 0.95)] }, { p: now - 30_000 }, cfg)).toBeNull();
  });

  it('does nothing once the window has closed, for a phone lying still, for a phone that never locked, or at the brightest level', () => {
    expect(checkEngagement(state, now, poorInHand, { p: now - cfg.windowMs - 1 }, cfg)).toBeNull(); // window over: a phone set down for minutes
    expect(checkEngagement(state, now, { p: phone(now - cfg.evalMs, now, 0, faceUp) }, { p: now - 30_000 }, cfg)).toBeNull();
    expect(checkEngagement(state, now, { p: phone(now - cfg.evalMs, now, 0, propped) }, { p: now - 30_000 }, cfg)).toBeNull();
    expect(checkEngagement(state, now, poorInHand, {}, cfg)).toBeNull(); // never locked: no window
    expect(checkEngagement({ ...state, wash: 0.25 }, now, poorInHand, { p: now - 30_000 }, cfg)).toBeNull();
    // A second phone outside its window tracking poorly does not count against the one inside it tracking well.
    const mixed = { fresh: phone(now - cfg.evalMs, now, 0.98), old: phone(now - cfg.evalMs, now, 0.1) };
    expect(checkEngagement(state, now, mixed, { fresh: now - 20_000, old: now - cfg.windowMs - 60_000 }, cfg)).toBeNull();
    // Thin evidence.
    expect(checkEngagement(state, now, { p: [{ at: now, frames: 10, tracked: 0, emulated: 10, state: 'emulated', seen: true, ...inHand }] }, { p: now - 5000 }, cfg)).toBeNull();
  });

  it('never darkens: there is no such move', () => {
    const good = { p: phone(now - cfg.evalMs, now, 0.99) };
    expect(checkEngagement({ wash: 0.25, ceiling: null, lastChangeAt: 0 }, now, good, { p: now - 30_000 }, cfg)).toBeNull();
    expect(checkEngagement({ wash: 0.45, ceiling: null, lastChangeAt: 0 }, now, good, { p: now - 30_000 }, cfg)).toBeNull();
  });
});

describe('settings', () => {
  it('round-trip per screen, snapping to known levels and keeping the last five sweeps', () => {
    const storage = new MemoryStorage();
    const key = screenKey(55, 1920, 1080);
    expect(loadCloth(storage, key)).toEqual({ wash: 0.25, target: 0.25, auto: true, sweeps: [] });
    const sweeps = Array.from({ length: 7 }, (_, i) => ({ at: i, results: [], recommended: 1, reason: `r${i}` }));
    saveCloth(storage, key, { wash: 0.47, target: 0.55, auto: false, sweeps });
    const back = loadCloth(storage, key);
    expect(back.wash).toBe(0.45);
    expect(back.target).toBe(0.55);
    expect(back.auto).toBe(false);
    expect(back.sweeps.map((s) => s.reason)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
    expect(loadCloth(storage, screenKey(27, 2560, 1440)).wash).toBe(0.25); // another screen starts fresh
    expect(brightnessPercent(0.45)).toBe(55);
    expect(washIndex(0.5)).toBe(2);
  });
});
