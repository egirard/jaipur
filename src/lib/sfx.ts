// Table sound effects: short, randomised excerpts of longer recordings so
// the same move never sounds quite the same twice. Each play picks a gain,
// a playback rate, a start offset within the recording and a duration,
// fades in and out, then stops. Effects follow the table's mute and focus
// state through `setSfxEnabled`.
//
// The recordings are decoded once into Web Audio buffers and played through
// buffer sources, not media elements: a media element needs a user gesture
// to play on stricter browsers, and an AudioContext created outside a
// gesture stays suspended — which is why a table could play the music
// (started from a tap) but none of the effects (fired by animations).
// `unlockSfx` runs from the table's own gesture handlers and both creates
// and resumes the context; effects then play from anywhere.

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
const buffers = new Map<string, AudioBuffer>();
const encoded = new Map<string, Promise<ArrayBuffer | null>>();
const live = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>();
const between = (range: [number, number]) => range[0] + Math.random() * (range[1] - range[0]);

/** Where the sfx files live (the app's base path + /audio/sfx). Starts
 *  fetching the recordings; decoding waits for the context. */
export function configureSfx(base: string) {
  baseUrl = `${base}/audio/sfx/`;
  if (typeof window === 'undefined') return;
  for (const clip of Object.values(CLIPS)) for (const file of clip.files) {
    if (!encoded.has(file)) encoded.set(file, fetch(baseUrl + file).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
  }
}

/** Call from a user gesture (any tap or key on the table): creates and
 *  resumes the audio context, then decodes the recordings. */
export function unlockSfx() {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return;
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
  const ctx = context;
  for (const [file, promise] of encoded) {
    if (buffers.has(file)) continue;
    void promise.then((bytes) => {
      if (!bytes || buffers.has(file)) return;
      // decodeAudioData detaches the buffer: hand it a copy so a retry can reuse it.
      return ctx.decodeAudioData(bytes.slice(0)).then((decoded) => { buffers.set(file, decoded); }).catch(() => undefined);
    });
  }
}

/** Mute/unmute every effect (the table's mute button and focus state). */
export function setSfxEnabled(on: boolean) {
  enabled = on;
  if (!on) for (const entry of [...live]) stopNow(entry);
}

/** Master level (the table's volume slider, 1 = the default position). */
export function setSfxVolume(level: number) {
  master = Math.min(3, Math.max(0, level));
}

function stopNow(entry: { source: AudioBufferSourceNode; gain: GainNode }) {
  try { entry.source.stop(); } catch { /* already ended */ }
  entry.source.disconnect();
  entry.gain.disconnect();
  live.delete(entry);
}

/** Play one randomised excerpt of an effect after `delayMs`. */
export function playSfx(name: SfxName, delayMs = 0) {
  if (typeof window === 'undefined') return;
  const clip = CLIPS[name];
  const file = clip.files[Math.floor(Math.random() * clip.files.length)];
  const seconds = between(clip.seconds);
  const peak = between(clip.volume) * master;
  const rate = between(clip.rate);
  const fadeOut = (clip.fadeOut ?? FADE_OUT_MS) / 1000;
  window.setTimeout(() => {
    const ctx = context;
    const buffer = buffers.get(file);
    // A source started on a suspended context would queue up and burst out
    // at the first tap: skip until the table has been touched once.
    if (!enabled || peak <= 0 || !ctx || !buffer || ctx.state !== 'running') {
      log.push({ name, file, skipped: !ctx ? 'no-context' : ctx.state !== 'running' ? ctx.state : !buffer ? 'not-decoded' : !enabled ? 'muted' : 'silent', at: Date.now() });
      return;
    }
    // Somewhere in the recording, leaving room for the excerpt (plus a
    // little tail so the fade-out never runs off the end).
    const room = Math.max(0, buffer.duration - seconds * rate - 0.3);
    const offset = Math.random() * room;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + FADE_IN_MS / 1000);
    gain.gain.setValueAtTime(peak, now + Math.max(FADE_IN_MS / 1000, seconds - fadeOut));
    gain.gain.linearRampToValueAtTime(0, now + seconds);
    source.connect(gain);
    gain.connect(ctx.destination);
    const entry = { source, gain };
    live.add(entry);
    source.onended = () => stopNow(entry);
    source.start(now, offset, seconds * rate + 0.05);
    log.push({ name, file, seconds: Number(seconds.toFixed(2)), start: Number(offset.toFixed(2)), peak: Number(peak.toFixed(2)), rate: Number(rate.toFixed(2)), at: Date.now() });
    if (log.length > 60) log.shift();
  }, Math.max(0, delayMs));
}

/** State for diagnostics and tests (`window.__jaipurSfx`). */
export function sfxStatus() {
  return { context: context?.state ?? 'none', decoded: [...buffers.keys()], fetched: [...encoded.keys()], enabled, master, live: live.size };
}

/** The last plays, for tests (`window.__jaipurSfx`). */
export const log: Array<{ name: SfxName; file: string; at: number; seconds?: number; start?: number; peak?: number; rate?: number; skipped?: string }> = [];
if (typeof window !== 'undefined') Object.assign(window as unknown as Record<string, unknown>, { __jaipurSfx: log, __jaipurSfxStatus: sfxStatus });
