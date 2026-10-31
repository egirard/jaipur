// The tablecloth's brightness, evaluated and adapted against what the AR
// phones can still register (GPLv3, part of this fork).
//
// The cloth is drawn under a dark wash (the `--cloth-wash` alpha; 0.25 is
// the look the table shipped with). The phones do NOT register against the
// washed screen: the tracking image the table publishes is captured with
// the wash stripped (arTabletop.ts, onclone), because the phone's camera
// auto-exposes the screen and matches contrast, not brightness. So the
// wash can change at any moment without republishing anything — the
// phones keep their reference and simply see a dimmer screen — and the
// only question is physical: at what dimness does the camera's view of the
// cloth lose enough signal that tracking suffers? That depends on the
// screen (its panel brightness), the room and the phone, so it is measured
// at runtime rather than assumed:
//
//  - The SWEEP (Table options → "Evaluate with phones") is an experiment
//    run with at least one phone in AR, held over the table as in play.
//    The table holds each wash level for a few seconds, from the current
//    one toward the darkest, reads the phones' tracking reports (every 2 s:
//    frames and tracked frames in the interval), and stops at the first
//    level whose tracked share falls under the floor. The last level that
//    held becomes this screen's target.
//  - The FIRST-ENGAGEMENT CHECK is the only automatic move, and it only
//    ever brightens. In the first minute and a half after a phone first
//    locks onto the table — the moment it is being held up and pointed at
//    the screen — if that phone tracks under half its frames, the cloth
//    steps one level brighter for this session (and remembers the level
//    that failed). After the window nothing moves on its own: a phone set
//    down for ten minutes, a player looking at the other player, a phone
//    left face-up on the cloth — none of it touches the background. The
//    saved setting changes only through the calibration controls (the
//    sweep, or − / +).
//
// Both read only ENGAGED samples: intervals in which the phone's camera
// was upright (not pointed straight into the table or at the ceiling) and
// the phone moved — a phone lying still reports no tracking and says
// nothing about the screen. The phone reports its pose with every sample
// (pitch, moved, turned; ARViewer's diag action); a viewer too old to
// report it never counts, which is the safe side.
//
// Everything here is pure: the page feeds samples and clock ticks in, and
// applies the wash it is handed back. Settings persist per screen.

/** Alpha of the dark wash over the cloth; index 0 is the brightest (the shipped look). */
export const WASH_LEVELS: readonly number[] = [0.25, 0.35, 0.45, 0.55, 0.65, 0.75];
export const brightnessPercent = (wash: number): number => Math.round((1 - wash) * 100);
export const washIndex = (wash: number): number => {
  let best = 0;
  WASH_LEVELS.forEach((w, i) => { if (Math.abs(w - wash) < Math.abs(WASH_LEVELS[best] - wash)) best = i; });
  return best;
};

/** One phone report, as the table receives it every ~2 s while the phone is in AR. */
export type PhoneSample = {
  at: number;
  frames: number;
  tracked: number;
  emulated: number;
  state: string;
  /** The phone has located the table at least once this session. */
  seen: boolean;
  /** The camera's forward axis, degrees above the horizon (−90: lying face-up on the table; +90: face-down). */
  pitch?: number | null;
  /** The farthest the camera moved (m) and turned (°) within the interval. */
  moved?: number | null;
  turned?: number | null;
};

export type EngagementConfig = {
  /** A camera pitched steeper than this, either way, is lying on something, not looking at the table. */
  maxPitchDeg: number;
  /** A hand-held phone exceeds one of these in any two seconds; one lying still exceeds neither. */
  minMovedM: number;
  minTurnedDeg: number;
};
export const ENGAGEMENT_DEFAULTS: EngagementConfig = { maxPitchDeg: 70, minMovedM: 0.01, minTurnedDeg: 1.5 };

/** Whether a sample came from a phone held up and moving. Without a pose
 *  (an older viewer, or no viewer pose that interval) it did not. */
export function isEngaged(s: PhoneSample, cfg: EngagementConfig = ENGAGEMENT_DEFAULTS): boolean {
  if (s.pitch == null || s.moved == null || s.turned == null) return false;
  return Math.abs(s.pitch) <= cfg.maxPitchDeg && (s.moved >= cfg.minMovedM || s.turned >= cfg.minTurnedDeg);
}

export type ShareWindow = {
  share: number; frames: number; tracked: number;
  /** Phones that contributed engaged samples. */
  phones: number;
  /** Phones in AR that had seen the table but were still or face-down for the whole window. */
  idle: number;
  /** Phones whose viewer reports no pose at all (too old to count). */
  blind: number;
  lost: boolean;
};

/** Aggregate tracked share over every phone's ENGAGED samples since
 *  `since` (inclusive), ignoring phones that never saw the table and
 *  samples from ended sessions. `lost` is true when an engaged phone that
 *  had the table reports it gone outright (state lost/searching) inside
 *  the window. `only` restricts to some viewers. */
export function trackedShare(samples: Record<string, PhoneSample[]>, since: number, only?: (viewerId: string) => boolean, cfg: EngagementConfig = ENGAGEMENT_DEFAULTS): ShareWindow {
  let frames = 0, tracked = 0, phones = 0, idle = 0, blind = 0, lost = false;
  for (const [id, list] of Object.entries(samples)) {
    if (only && !only(id)) continue;
    const inWindow = list.filter((s) => s.at >= since && s.seen && s.state !== 'ended' && s.state !== 'no-tracking');
    if (!inWindow.length) continue;
    const engaged = inWindow.filter((s) => isEngaged(s, cfg));
    if (!engaged.length) {
      if (inWindow.every((s) => s.pitch == null)) blind += 1; else idle += 1;
      continue;
    }
    phones += 1;
    for (const s of engaged) {
      frames += s.frames;
      tracked += s.tracked;
      if (s.state === 'lost' || s.state === 'searching') lost = true;
    }
  }
  return { share: frames ? tracked / frames : 0, frames, tracked, phones, idle, blind, lost };
}

/** Why a window has no usable evidence, for a person. */
export function noEvidenceReason(w: ShareWindow): string {
  if (w.idle) return w.phones ? 'a phone is lying still' : 'the phone is lying still — pick it up and hold it over the table as in play';
  if (w.blind) return "the phone's viewer is too old to report its pose — reload the AR page";
  return 'no phone in AR saw the table — enter AR and point it at the market first';
}

// ---- The sweep -----------------------------------------------------------------

export type SweepResult = { wash: number; share: number; frames: number; phones: number; lost: boolean; held: boolean };
export type SweepConfig = {
  /** Time at a level before its samples count (the phone's reports lag the screen). */
  settleMs: number;
  /** Time at a level during which samples are collected. */
  holdMs: number;
  /** A level holds when its tracked share is at least this. */
  floorShare: number;
  /** Fewer engaged frames than this in a hold means no phone was really tracking. */
  minFrames: number;
  /** How much longer a hold waits for an engaged phone (one set down mid-sweep) before aborting. */
  graceMs: number;
};
export const SWEEP_DEFAULTS: SweepConfig = { settleMs: 2500, holdMs: 8000, floorShare: 0.75, minFrames: 40, graceMs: 15_000 };

export type SweepState =
  | { phase: 'idle' }
  | { phase: 'holding'; index: number; since: number; from: number; results: SweepResult[] }
  | { phase: 'done'; from: number; results: SweepResult[]; recommended: number; reason: string }
  | { phase: 'aborted'; from: number; results: SweepResult[]; reason: string };

export const sweepIdle: SweepState = { phase: 'idle' };

/** Begin at the current level: it is measured first as the baseline. */
export function startSweep(now: number, fromIndex: number): SweepState {
  return { phase: 'holding', index: fromIndex, since: now, from: fromIndex, results: [] };
}

/** A hold that has run its course but is waiting out the grace for an engaged phone. */
export function sweepWaiting(state: SweepState, now: number, cfg: SweepConfig = SWEEP_DEFAULTS): boolean {
  return state.phase === 'holding' && now - state.since >= cfg.settleMs + cfg.holdMs;
}

/** The wash the screen should show for a sweep state (null: whatever it was). */
export function sweepWash(state: SweepState): number | null {
  return state.phase === 'holding' ? WASH_LEVELS[state.index] : null;
}

/** Advance the sweep by the clock; the page calls this about once a second. */
export function stepSweep(state: SweepState, now: number, samples: Record<string, PhoneSample[]>, cfg: SweepConfig = SWEEP_DEFAULTS): SweepState {
  if (state.phase !== 'holding') return state;
  if (now - state.since < cfg.settleMs + cfg.holdMs) return state;
  const w = trackedShare(samples, state.since + cfg.settleMs);
  const held = w.frames >= cfg.minFrames && w.share >= cfg.floorShare && !w.lost;
  const result: SweepResult = { wash: WASH_LEVELS[state.index], share: w.share, frames: w.frames, phones: w.phones, lost: w.lost, held };
  const results = [...state.results, result];
  if (w.frames < cfg.minFrames) {
    // Thin evidence: wait out the grace (the phone may be back in hand in a moment), then give up.
    if (now - state.since < cfg.settleMs + cfg.holdMs + cfg.graceMs) return state;
    return { phase: 'aborted', from: state.from, results, reason: w.phones ? 'the phone stopped reporting frames — is it still in AR?' : noEvidenceReason(w) };
  }
  if (!held) {
    if (state.index === state.from) {
      return { phase: 'aborted', from: state.from, results, reason: `tracking is already poor at the current brightness (${Math.round(w.share * 100)}% tracked) — hold the phone over the table as you would in play and try again` };
    }
    const recommended = state.index - 1;
    return { phase: 'done', from: state.from, results, recommended, reason: `${brightnessPercent(WASH_LEVELS[state.index])}% dropped to ${Math.round(w.share * 100)}% tracked${w.lost ? ' and lost the table' : ''}; ${brightnessPercent(WASH_LEVELS[recommended])}% is the dimmest that held` };
  }
  if (state.index === WASH_LEVELS.length - 1) {
    return { phase: 'done', from: state.from, results, recommended: state.index, reason: `every level held, down to ${brightnessPercent(WASH_LEVELS[state.index])}%` };
  }
  return { phase: 'holding', index: state.index + 1, since: now, from: state.from, results };
}

// ---- The first-engagement check -------------------------------------------------

export type EngagementCheckConfig = {
  /** How long after a phone's first lock its tracking may still move the cloth. */
  windowMs: number;
  /** Over how much recent evidence the share is read (never reaching back past the last change). */
  evalMs: number;
  /** Below this tracked share the cloth steps brighter. */
  poorShare: number;
  /** Least engaged frames of evidence (150 ≈ five seconds at 30 fps: a lock still settling is not evidence). */
  minFrames: number;
  /** Least time between two steps (the phone needs a moment at the new level). */
  cooldownMs: number;
};
export const ENGAGEMENT_CHECK_DEFAULTS: EngagementCheckConfig = { windowMs: 90_000, evalMs: 20_000, poorShare: 0.5, minFrames: 150, cooldownMs: 25_000 };

export type AdapterState = {
  /** The wash on screen now. */
  wash: number;
  /** A wash that failed on this screen this session; nothing will darken to it or past it. */
  ceiling: number | null;
  lastChangeAt: number;
};

export type AdapterMove = { wash: number; reason: string; direction: 'brighter' };

/** The one automatic move: while some phone is in its first engagement
 *  window (`firstSeen`: when each viewer first locked onto the table) and,
 *  held up and moving, tracks poorly, step one level brighter. Never
 *  darkens; never moves once every phone's window has closed. */
export function checkEngagement(state: AdapterState, now: number, samples: Record<string, PhoneSample[]>, firstSeen: Record<string, number>, cfg: EngagementCheckConfig = ENGAGEMENT_CHECK_DEFAULTS): AdapterMove | null {
  const i = washIndex(state.wash);
  if (i === 0 || now - state.lastChangeAt < cfg.cooldownMs) return null;
  const engaging = (id: string) => firstSeen[id] != null && now - firstSeen[id] <= cfg.windowMs;
  if (!Object.keys(firstSeen).some(engaging)) return null;
  const w = trackedShare(samples, Math.max(now - cfg.evalMs, state.lastChangeAt), engaging);
  if (w.frames < cfg.minFrames || w.share >= cfg.poorShare) return null;
  return { wash: WASH_LEVELS[i - 1], direction: 'brighter', reason: `a phone first engaging the table tracked only ${Math.round(w.share * 100)}% of its frames at ${brightnessPercent(state.wash)}% while held up and moving` };
}

/** Apply a move: the state after it (the level that failed becomes the session's ceiling). */
export function applyMove(state: AdapterState, move: AdapterMove, now: number): AdapterState {
  return { ...state, wash: move.wash, ceiling: Math.min(state.wash, state.ceiling ?? Infinity), lastChangeAt: now };
}

// ---- Persistence, per screen ----------------------------------------------------

/** The saved setting for one screen. `wash` is the level the table starts
 *  at; `target` is kept equal to it (older records could differ, when the
 *  wash crept at runtime — it no longer does). `auto` is the
 *  first-engagement check. */
export type ClothRecord = { wash: number; target: number; auto: boolean; sweeps: Array<{ at: number; results: SweepResult[]; recommended: number | null; reason: string }> };
export type ClothSettings = Record<string, ClothRecord>;
const CLOTH_KEY = 'jaipur:tabletop:cloth';
export const CLOTH_DEFAULT: ClothRecord = { wash: WASH_LEVELS[0], target: WASH_LEVELS[0], auto: true, sweeps: [] };

/** One key per physical screen and viewport, so a different display starts from its own record. */
export const screenKey = (diagInches: number, width: number, height: number): string => `${diagInches}in-${width}x${height}`;

export function loadCloth(storage: Pick<Storage, 'getItem'> | null, screen: string): ClothRecord {
  try {
    const all = JSON.parse(storage?.getItem(CLOTH_KEY) ?? '{}') as ClothSettings;
    const rec = all?.[screen];
    if (rec && typeof rec.wash === 'number' && typeof rec.target === 'number') {
      return { ...CLOTH_DEFAULT, ...rec, wash: WASH_LEVELS[washIndex(rec.wash)], target: WASH_LEVELS[washIndex(rec.target)], sweeps: Array.isArray(rec.sweeps) ? rec.sweeps.slice(-5) : [] };
    }
  } catch { /* unreadable: defaults */ }
  return { ...CLOTH_DEFAULT };
}

export function saveCloth(storage: Pick<Storage, 'getItem' | 'setItem'> | null, screen: string, rec: ClothRecord): void {
  try {
    const all = JSON.parse(storage?.getItem(CLOTH_KEY) ?? '{}') as ClothSettings;
    all[screen] = { ...rec, sweeps: rec.sweeps.slice(-5) };
    storage?.setItem(CLOTH_KEY, JSON.stringify(all));
  } catch { /* storage blocked: the setting lasts this page load */ }
}
