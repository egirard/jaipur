// Table sound effects: short, randomised excerpts of longer recordings so
// the same move never sounds quite the same twice. Each play picks a
// volume, a playback rate, a start offset within the recording and a
// duration, fades in and out, then stops. Effects follow the table's mute
// and focus state through `setSfxEnabled`. Playback runs through a Web
// Audio gain node so an effect can sit well above the media element's
// 1.0 ceiling (the recordings are quiet next to the music bed).

export type SfxName = 'camel-herd' | 'pickup-goods' | 'selling-goods' | 'coins-landing' | 'coin-clink';

type Clip = { files: string[]; seconds: [number, number]; volume: [number, number]; rate: [number, number]; fadeOut?: number };

// Duration range of an excerpt, the gain and playback-rate ranges it is
// drawn from, and (optionally) a longer fade-out. The recordings are ~13 s.
const CLIPS: Record<SfxName, Clip> = {
  // Camels keep bleating for a while after the herd has settled.
  'camel-herd': { files: ['camel-herd.mp3'], seconds: [4.5, 7], volume: [1.4, 2.2], rate: [0.9, 1.1], fadeOut: 1400 },
  'pickup-goods': { files: ['pickup-goods-1.mp3', 'pickup-goods-2.mp3'], seconds: [1.1, 2.0], volume: [1.2, 2.0], rate: [0.9, 1.15] },
  'selling-goods': { files: ['selling-goods.mp3'], seconds: [1.6, 2.8], volume: [1.3, 2.1], rate: [0.92, 1.08] },
  'coins-landing': { files: ['coins-landing.mp3'], seconds: [1.0, 1.9], volume: [1.3, 2.2], rate: [0.9, 1.15] },
  // One short burst per landing coin; they overlap into a clatter.
  'coin-clink': { files: ['coins-landing.mp3'], seconds: [0.35, 0.75], volume: [1.0, 2.0], rate: [0.95, 1.3], fadeOut: 120 }
};

const FADE_IN_MS = 60;
const FADE_OUT_MS = 260;

let baseUrl = '';
let enabled = true;
let master = 1;
let context: AudioContext | undefined;
const live = new Map<HTMLAudioElement, GainNode | undefined>();

function audioContext(): AudioContext | undefined {
  if (typeof AudioContext === 'undefined') return undefined;
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
  return context;
}
const between = (range: [number, number]) => range[0] + Math.random() * (range[1] - range[0]);

/** Where the sfx files live (the app's base path + /audio/sfx). */
export function configureSfx(base: string) {
  baseUrl = `${base}/audio/sfx/`;
}

/** Mute/unmute every effect (the table's mute button and focus state). */
export function setSfxEnabled(on: boolean) {
  enabled = on;
  if (!on) for (const a of [...live.keys()]) stopNow(a);
}

/** Master level (the table's volume slider, 1 = the default position). */
export function setSfxVolume(level: number) {
  master = Math.min(3, Math.max(0, level));
}

function stopNow(a: HTMLAudioElement) {
  a.pause();
  live.get(a)?.disconnect();
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
  const fadeOutMs = clip.fadeOut ?? FADE_OUT_MS;
  window.setTimeout(() => {
    if (!enabled || peak <= 0) return;
    const a = new Audio(baseUrl + file);
    a.preload = 'auto';
    a.playbackRate = rate;
    const ctx = audioContext();
    // Through a gain node when Web Audio is there (gain may exceed 1);
    // otherwise the element's own volume, capped at 1.
    let gain: GainNode | undefined;
    if (ctx) {
      gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(a).connect(gain);
      gain.connect(ctx.destination);
    } else {
      a.volume = 0;
    }
    const setLevel = (v: number) => { if (gain) gain.gain.value = v; else a.volume = Math.min(1, v); };
    live.set(a, gain);
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
        if (t < FADE_IN_MS) setLevel(peak * (t / FADE_IN_MS));
        else if (t < holdMs - fadeOutMs) setLevel(peak);
        else if (t < holdMs) setLevel(peak * Math.max(0, (holdMs - t) / fadeOutMs));
        else { stopNow(a); return; }
        requestAnimationFrame(tickFade);
      };
      a.play().then(() => requestAnimationFrame(tickFade)).catch(() => stopNow(a));
      log.push({ name, file, seconds: Number(seconds.toFixed(2)), start: Number(a.currentTime.toFixed(2)), peak: Number(peak.toFixed(2)), rate: Number(rate.toFixed(2)), at: Date.now() });
      if (log.length > 60) log.shift();
    };
    if (a.readyState >= 1) begin(); else a.addEventListener('loadedmetadata', begin, { once: true });
    a.addEventListener('error', () => stopNow(a), { once: true });
  }, Math.max(0, delayMs));
}

/** The last plays, for tests (`window.__jaipurSfx`). */
export const log: Array<{ name: SfxName; file: string; seconds: number; start: number; peak: number; rate: number; at: number }> = [];
if (typeof window !== 'undefined') (window as unknown as { __jaipurSfx: typeof log }).__jaipurSfx = log;
