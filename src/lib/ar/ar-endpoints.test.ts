import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY, DEFAULT_VIEWER, bundledViewerBase, lanEndpoints, loadLanAddress, normalizeRelay, normalizeViewer, probeSameOriginRelay, resolveArEndpoints, sameOriginEndpoints, saveLanAddress } from './arEndpoints';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

describe('AR endpoint resolution', () => {
  it('falls back to the hosted relay and viewer', () => {
    const r = resolveArEndpoints({ params: new URLSearchParams(), storage: new MemoryStorage() });
    expect(r).toEqual({ relayUrl: DEFAULT_RELAY, viewerBase: DEFAULT_VIEWER, source: 'default' });
  });

  it('takes ?relay= and ?viewer= first, normalises them, and remembers them', () => {
    const storage = new MemoryStorage();
    const r = resolveArEndpoints({ params: new URLSearchParams('relay=192.168.1.20:8443&viewer=192.168.1.20:8443'), storage });
    expect(r).toEqual({ relayUrl: 'wss://192.168.1.20:8443/ws', viewerBase: 'https://192.168.1.20:8443/viewer/', source: 'param' });
    const again = resolveArEndpoints({ params: new URLSearchParams(), storage });
    expect(again).toEqual({ ...r, source: 'saved' });
  });

  it('forgets a remembered value on ?relay=default', () => {
    const storage = new MemoryStorage();
    resolveArEndpoints({ params: new URLSearchParams('relay=lan.local'), storage });
    const r = resolveArEndpoints({ params: new URLSearchParams('relay=default'), storage });
    expect(r.relayUrl).toBe(DEFAULT_RELAY);
    expect(r.source).toBe('default');
  });

  it('prefers the build environment over the page origin, and the page origin over the hosted pair', () => {
    const sameOrigin = sameOriginEndpoints({ protocol: 'https:', host: 'laptop.local:8443' });
    expect(sameOrigin).toEqual({ relayUrl: 'wss://laptop.local:8443/ws', viewerBase: 'https://laptop.local:8443/viewer/' });
    const viaOrigin = resolveArEndpoints({ params: new URLSearchParams(), storage: null, sameOrigin });
    expect(viaOrigin).toEqual({ ...sameOrigin, source: 'same-origin' });
    const viaEnv = resolveArEndpoints({ params: new URLSearchParams(), storage: null, env: { relay: 'wss://relay.example/ws' }, sameOrigin });
    expect(viaEnv.relayUrl).toBe('wss://relay.example/ws');
    expect(viaEnv.source).toBe('env');
    expect(viaEnv.viewerBase).toBe(sameOrigin.viewerBase); // each field resolves on its own
  });

  it('normalises hosts, schemes and paths', () => {
    expect(normalizeRelay('https://host:8443')).toBe('wss://host:8443/ws');
    expect(normalizeRelay('http://host:8080/')).toBe('ws://host:8080/ws');
    expect(normalizeRelay('wss://host/custom')).toBe('wss://host/custom');
    expect(normalizeRelay('  ')).toBeNull();
    expect(normalizeViewer('host')).toBe('https://host/viewer/');
    expect(normalizeViewer('https://host/path?x=1')).toBe('https://host/path/');
    expect(normalizeViewer('ws://127.0.0.1:8097')).toBe('http://127.0.0.1:8097/viewer/');
    expect(normalizeViewer('wss://host:8443/ws')).toBe('https://host:8443/viewer/');
  });

  it('recognises the ARViewer server by its /inspect answer', async () => {
    const json = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
    expect(await probeSameOriginRelay('https://laptop:8443', json({ session: 'PROBE', exists: false }))).toBe(true);
    expect(await probeSameOriginRelay('http://127.0.0.1:5185', json('<!doctype html>'))).toBe(false);
    expect(await probeSameOriginRelay('https://egirard.github.io', json({}, false))).toBe(false);
    expect(await probeSameOriginRelay('https://x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe('the LAN stand-in', () => {
  it('derives both endpoints from one host:port and is remembered on its own key', () => {
    expect(lanEndpoints('192.168.1.20:8443')).toEqual({ relayUrl: 'wss://192.168.1.20:8443/ws', viewerBase: 'https://192.168.1.20:8443/viewer/' });
    expect(lanEndpoints('')).toBeNull();
    const storage = new MemoryStorage();
    saveLanAddress(storage, ' laptop.local:8443 ');
    expect(loadLanAddress(storage)).toBe('laptop.local:8443');
    expect(resolveArEndpoints({ params: new URLSearchParams(), storage }).source).toBe('default'); // not a primary setting
    saveLanAddress(storage, '');
    expect(loadLanAddress(storage)).toBe('');
  });
});

describe('the bundled viewer', () => {
  const bundled = bundledViewerBase({ origin: 'https://egirard.github.io' }, '/jaipur');
  it('lives at <origin><base>/viewer/index.html', () => {
    expect(bundled).toBe('https://egirard.github.io/jaipur/viewer/index.html');
    expect(bundledViewerBase({ origin: 'http://192.168.1.20:5185' }, '')).toBe('http://192.168.1.20:5185/viewer/index.html');
  });
  it('is the default viewer on an https table that carries it, with the hosted relay', () => {
    const r = resolveArEndpoints({ params: new URLSearchParams(), storage: new MemoryStorage(), bundledViewer: bundled, preferBundled: true });
    expect(r).toEqual({ relayUrl: DEFAULT_RELAY, viewerBase: bundled, source: 'bundled' });
    // Not preferred (an http dev table): the hosted viewer stays, phones could not enter AR from http anyway.
    expect(resolveArEndpoints({ params: new URLSearchParams(), storage: new MemoryStorage(), bundledViewer: bundled, preferBundled: false }).viewerBase).toBe(DEFAULT_VIEWER);
  });
  it('?viewer=bundled asks for it anywhere and is remembered as the keyword, not the URL', () => {
    const storage = new MemoryStorage();
    const r = resolveArEndpoints({ params: new URLSearchParams('viewer=bundled'), storage, bundledViewer: 'http://192.168.1.20:5185/viewer/' });
    expect(r.viewerBase).toBe('http://192.168.1.20:5185/viewer/');
    expect(storage.getItem('jaipur:ar:viewer')).toBe('bundled');
    const moved = resolveArEndpoints({ params: new URLSearchParams(), storage, bundledViewer: 'http://10.0.0.5:5185/viewer/' });
    expect(moved.viewerBase).toBe('http://10.0.0.5:5185/viewer/');
    // Without a bundled copy the keyword falls through to the hosted viewer.
    expect(resolveArEndpoints({ params: new URLSearchParams(), storage, bundledViewer: null }).viewerBase).toBe(DEFAULT_VIEWER);
    // An explicit viewer still wins over the bundled default.
    expect(resolveArEndpoints({ params: new URLSearchParams('viewer=default'), storage, bundledViewer: 'http://x/viewer/', preferBundled: true }).viewerBase).toBe('http://x/viewer/');
  });
});
