// Where the table finds the AR relay and the viewer page (GPLv3, part of
// this fork).
//
// The hosted pair (the Render relay and the GitHub Pages viewer) is the
// default. For a LAN-only table — the ARViewer Node server on a laptop with
// its self-signed certificate, no internet — the table must be told where
// they are, because a browser page cannot learn its host's LAN address on
// its own. Priority, each field on its own:
//   1. ?relay= / ?viewer= on the table's URL (remembered; "default" forgets),
//   2. the remembered values,
//   3. VITE_AR_RELAY_URL / VITE_AR_VIEWER_URL baked into the build,
//   4. the page's own origin when the ARViewer server is serving the table
//      page itself (it answers GET /inspect) — then relay and viewer are
//      simply /ws and /viewer/ beside it, and nothing has to be typed,
//   5. the hosted pair.
// The table embeds the resolved relay in every seat QR, so phones follow.

export const DEFAULT_RELAY = 'wss://arviewer-relay.onrender.com/ws';
export const DEFAULT_VIEWER = 'https://egirard.github.io/ARViewer/viewer/';

const RELAY_KEY = 'jaipur:ar:relay';
const VIEWER_KEY = 'jaipur:ar:viewer';

export type ArEndpointSource = 'param' | 'saved' | 'env' | 'same-origin' | 'default' | 'lan';
export type ArEndpoints = { relayUrl: string; viewerBase: string; source: ArEndpointSource };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ArEndpointInput = {
  params: URLSearchParams;
  storage: StorageLike | null;
  env?: { relay?: string | undefined; viewer?: string | undefined };
  /** The page's own relay and viewer, when the ARViewer server serves this page. */
  sameOrigin?: { relayUrl: string; viewerBase: string } | null;
};

/** "host", "host:8443", "https://host:8443", "wss://host/ws" → a wss:// URL on /ws. */
export function normalizeRelay(value: string | null | undefined): string | null {
  let v = (value ?? '').trim();
  if (!v) return null;
  v = v.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  if (!/^wss?:\/\//.test(v)) v = `wss://${v}`;
  try {
    const url = new URL(v);
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws';
    return url.toString();
  } catch {
    return null;
  }
}

/** "host", "host:8443", "https://host:8443", "https://host/viewer" → an
 *  https:// page URL ending in a slash (the ARViewer server's /viewer/). */
export function normalizeViewer(value: string | null | undefined): string | null {
  let v = (value ?? '').trim();
  if (!v) return null;
  v = v.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://'); // a relay-style address names the same server
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  try {
    const url = new URL(v);
    if (url.pathname === '' || url.pathname === '/' || url.pathname === '/ws') url.pathname = '/viewer/';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function pick(
  name: 'relay' | 'viewer',
  key: string,
  normalize: (v: string | null | undefined) => string | null,
  input: ArEndpointInput,
  fallback: string
): { value: string; source: ArEndpointSource } {
  const param = input.params.get(name);
  if (param === 'default') {
    try { input.storage?.removeItem(key); } catch { /* ignore */ }
  } else if (param) {
    const value = normalize(param);
    if (value) {
      try { input.storage?.setItem(key, value); } catch { /* ignore */ }
      return { value, source: 'param' };
    }
  }
  let saved: string | null = null;
  try { saved = normalize(input.storage?.getItem(key)); } catch { /* ignore */ }
  if (saved) return { value: saved, source: 'saved' };
  const env = normalize(input.env?.[name]);
  if (env) return { value: env, source: 'env' };
  if (input.sameOrigin) return { value: name === 'relay' ? input.sameOrigin.relayUrl : input.sameOrigin.viewerBase, source: 'same-origin' };
  return { value: fallback, source: 'default' };
}

export function resolveArEndpoints(input: ArEndpointInput): ArEndpoints {
  const relay = pick('relay', RELAY_KEY, normalizeRelay, input, DEFAULT_RELAY);
  const viewer = pick('viewer', VIEWER_KEY, normalizeViewer, input, DEFAULT_VIEWER);
  return { relayUrl: relay.value, viewerBase: viewer.value, source: relay.source };
}

// ---- The LAN stand-in --------------------------------------------------------
// Table options holds one address, "HOST:8443", of an ARViewer server on the
// local network. It is not a primary setting: the table keeps using the
// relay it resolved above, and switches to the LAN server only when that
// relay turns out to be unreachable (ArRelayStatus 'unreachable'); with no
// address set, the table asks for one at that moment instead.
const LAN_KEY = 'jaipur:ar:lan';

export function loadLanAddress(storage: Pick<Storage, 'getItem'> | null): string {
  try { return storage?.getItem(LAN_KEY)?.trim() ?? ''; } catch { return ''; }
}

export function saveLanAddress(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, address: string): void {
  try {
    if (address.trim()) storage?.setItem(LAN_KEY, address.trim());
    else storage?.removeItem(LAN_KEY);
  } catch { /* storage blocked: the address lasts this page load */ }
}

/** Relay and viewer on one ARViewer server: wss://HOST/ws and https://HOST/viewer/. */
export function lanEndpoints(address: string): { relayUrl: string; viewerBase: string } | null {
  const relayUrl = normalizeRelay(address);
  const viewerBase = normalizeViewer(address);
  return relayUrl && viewerBase ? { relayUrl, viewerBase } : null;
}

/** The relay and viewer that sit beside a page the ARViewer server serves. */
export function sameOriginEndpoints(loc: { protocol: string; host: string }): { relayUrl: string; viewerBase: string } {
  const ws = loc.protocol === 'https:' ? 'wss' : 'ws';
  return { relayUrl: `${ws}://${loc.host}/ws`, viewerBase: `${loc.protocol}//${loc.host}/viewer/` };
}

/** Is this page served by the ARViewer server? It answers GET /inspect with
 *  JSON naming the session asked about; a static host or vite answers with
 *  HTML or a 404. */
export async function probeSameOriginRelay(origin: string, fetchFn: typeof fetch = fetch, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${origin}/inspect?session=PROBE`, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return Boolean(body && typeof body === 'object' && (body as { session?: unknown }).session === 'PROBE');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
