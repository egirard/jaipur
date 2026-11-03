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
//   5. for the viewer only: the table's own bundled copy of the phone page
//      (static/viewer/, vendored by scripts/sync-viewer.sh), when the table
//      is served over https — one deploy of the table then publishes both;
//      `?viewer=bundled` asks for it on any origin (remembered),
//   6. the hosted pair.
// The table embeds the resolved relay in every seat QR, so phones follow.

export const DEFAULT_RELAY = 'wss://arviewer-relay.onrender.com/ws';
export const DEFAULT_VIEWER = 'https://egirard.github.io/ARViewer/viewer/';

const RELAY_KEY = 'jaipur:ar:relay';
const VIEWER_KEY = 'jaipur:ar:viewer';

export type ArEndpointSource = 'param' | 'saved' | 'env' | 'same-origin' | 'bundled' | 'default' | 'lan';
export type ArEndpoints = { relayUrl: string; viewerBase: string; source: ArEndpointSource };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ArEndpointInput = {
  params: URLSearchParams;
  storage: StorageLike | null;
  env?: { relay?: string | undefined; viewer?: string | undefined };
  /** The page's own relay and viewer, when the ARViewer server serves this page. */
  sameOrigin?: { relayUrl: string; viewerBase: string } | null;
  /** The table's bundled copy of the phone page (bundledViewerBase), when the build carries one. */
  bundledViewer?: string | null;
  /** Prefer the bundled copy over the hosted viewer by default (the page is https, so phones can enter AR from it). */
  preferBundled?: boolean;
};

/** Where the bundled phone page lives beside a table page:
 *  <origin><base>/viewer/index.html — the file itself, because the dev
 *  server hands a bare /viewer/ to SvelteKit's router (no such route) while
 *  a static host would serve the index; the page's relative imports
 *  (../shared/) resolve the same either way. */
export function bundledViewerBase(loc: { origin: string }, base: string): string {
  return `${loc.origin}${base.replace(/\/$/, '')}/viewer/index.html`;
}

/** Does this table carry the bundled phone page? (vite and the static host answer HEAD on it; a missing file is a 404 — or vite's SPA fallback HTML, which the content type tells apart). */
export async function probeBundledViewer(viewerBase: string, fetchFn: typeof fetch = fetch, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(viewerBase.replace(/index\.html$/, 'viewer.js'), { method: 'HEAD', signal: ctl.signal, cache: 'no-store' });
    return res.ok && /javascript/.test(res.headers.get('content-type') ?? '');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
  } else if (name === 'viewer' && param === 'bundled') {
    // The keyword is remembered, not the URL: the copy moves with the table.
    try { input.storage?.setItem(key, 'bundled'); } catch { /* ignore */ }
    if (input.bundledViewer) return { value: input.bundledViewer, source: 'bundled' };
  } else if (param) {
    const value = normalize(param);
    if (value) {
      try { input.storage?.setItem(key, value); } catch { /* ignore */ }
      return { value, source: 'param' };
    }
  }
  let saved: string | null = null;
  let rawSaved: string | null = null;
  try { rawSaved = input.storage?.getItem(key) ?? null; saved = normalize(rawSaved); } catch { /* ignore */ }
  if (name === 'viewer' && rawSaved === 'bundled') { if (input.bundledViewer) return { value: input.bundledViewer, source: 'bundled' }; }
  else if (saved) return { value: saved, source: 'saved' };
  const env = normalize(input.env?.[name]);
  if (env) return { value: env, source: 'env' };
  if (input.sameOrigin) return { value: name === 'relay' ? input.sameOrigin.relayUrl : input.sameOrigin.viewerBase, source: 'same-origin' };
  if (name === 'viewer' && input.bundledViewer && input.preferBundled) return { value: input.bundledViewer, source: 'bundled' };
  return { value: fallback, source: 'default' };
}

export function resolveArEndpoints(input: ArEndpointInput): ArEndpoints {
  const relay = pick('relay', RELAY_KEY, normalizeRelay, input, DEFAULT_RELAY);
  const viewer = pick('viewer', VIEWER_KEY, normalizeViewer, input, DEFAULT_VIEWER);
  // `source` describes the relay, except that a bundled viewer with a default relay says so.
  return { relayUrl: relay.value, viewerBase: viewer.value, source: relay.source === 'default' && viewer.source === 'bundled' ? 'bundled' : relay.source };
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
