// Table sound effects: short, randomised excerpts of longer recordings so
// the same move never sounds quite the same twice. Each play picks a
// volume, a playback rate, a start offset within the recording and a
// duration, fades in and out, then stops. Effects follow the table's mute
// and focus state through `setSfxEnabled`.

export type SfxName = 'camel-herd' | 'pickup-goods' | 'selling-goods' | 'coins-landing';

type Clip = { files: string[]; seconds: [number, number]; volume: [number, number]; rate: [number, number] };

// Duration range of an excerpt, the volume and playback-rate ranges it is
// drawn from. The recordings are ~13 s each.
const CLIPS: Record<SfxName, Clip> = {
  'camel-herd': { files: ['camel-herd.mp3'], seconds: [2.2, 3.6], volume: [0.5, 0.85], rate: [0.9, 1.1] },
  'pickup-goods': { files: ['pickup-goods-1.mp3', 'pickup-goods-2.mp3'], seconds: [1.1, 2.0], volume: [0.45, 0.8], rate: [0.9, 1.15] },
  'selling-goods': { files: ['selling-goods.mp3'], seconds: [1.6, 2.8], volume: [0.5, 0.85], rate: [0.92, 1.08] },
  'coins-landing': { files: ['coins-landing.mp3'], seconds: [1.0, 1.9], volume: [0.5, 0.9], rate: [0.9, 1.15] }
};

const FADE_IN_MS = 60;
const FADE_OUT_MS = 260;

let baseUrl = '';
let enabled = true;
let master = 1;
const live = new Set<HTMLAudioElement>();
const between = (range: [number, number]) => range[0] + Math.random() * (range[1] - range[0]);

/** Where the sfx files live (the app's base path + /audio/sfx). */
export function configureSfx(base: string) {
  baseUrl = `${base}/audio/sfx/`;
}

/** Mute/unmute every effect (the table's mute button and focus state). */
export function setSfxEnabled(on: boolean) {
  enabled = on;
  if (!on) for (const a of live) stopNow(a);
}

/** Master level, 0–1 (the table's volume slider). */
export function setSfxVolume(level: number) {
  master = Math.min(1, Math.max(0, level));
}

function stopNow(a: HTMLAudioElement) {
  a.pause();
  a.src = '';
  live.delete(a);
}

/** Play one randomised excerpt of an effect after `delayMs`. */
export function playSfx(name: SfxName, delayMs = 0) {
  if (typeof window === 'undefined') return;
  const clip = CLIPS[name];
  const file = clip.files[Math.floor(Math.random() * clip.files.length)];
  const seconds = between(clip.seconds);
  const peak = between(clip.volume) * master;
  const rate = between(clip.rate);
  window.setTimeout(() => {
    if (!enabled || peak <= 0) return;
    const a = new Audio(baseUrl + file);
    a.preload = 'auto';
    a.playbackRate = rate;
    a.volume = 0;
    live.add(a);
    const begin = () => {
      if (!live.has(a)) return;
      // Somewhere in the recording, leaving room for the excerpt (plus a
      // little tail so the fade-out never runs off the end).
      const room = Math.max(0, (a.duration || 0) - seconds * rate - 0.3);
      a.currentTime = Math.random() * room;
      const started = performance.now();
      const holdMs = seconds * 1000;
      const tickFade = () => {
        if (!live.has(a)) return;
        const t = performance.now() - started;
        if (t < FADE_IN_MS) a.volume = peak * (t / FADE_IN_MS);
        else if (t < holdMs - FADE_OUT_MS) a.volume = peak;
        else if (t < holdMs) a.volume = peak * Math.max(0, (holdMs - t) / FADE_OUT_MS);
        else { stopNow(a); return; }
        requestAnimationFrame(tickFade);
      };
      a.play().then(() => requestAnimationFrame(tickFade)).catch(() => stopNow(a));
      log.push({ name, file, seconds: Number(seconds.toFixed(2)), start: Number(a.currentTime.toFixed(2)), peak: Number(peak.toFixed(2)), rate: Number(rate.toFixed(2)), at: Date.now() });
      if (log.length > 40) log.shift();
    };
    if (a.readyState >= 1) begin(); else a.addEventListener('loadedmetadata', begin, { once: true });
    a.addEventListener('error', () => stopNow(a), { once: true });
  }, Math.max(0, delayMs));
}

/** The last plays, for tests (`window.__jaipurSfx`). */
export const log: Array<{ name: SfxName; file: string; seconds: number; start: number; peak: number; rate: number; at: number }> = [];
if (typeof window !== 'undefined') (window as unknown as { __jaipurSfx: typeof log }).__jaipurSfx = log;
