// Resolves which WebSocket relay to use. The static app may be hosted
// anywhere (GitHub Pages, the bundled Node server, a laptop), so the relay
// address is configurable rather than assumed to be same-origin.
//
// Priority: ?relay= URL param (persisted for next time) > saved setting >
// same-origin /ws when the page is served by the bundled Node server.
// On static hosts (github.io) there is no same-origin relay, so the deployed
// relay below is the default; the param or the table's config panel override
// it, and the table embeds the resolved address in the QR code so phones
// inherit it automatically.

// The project's hosted relay (Render deployment of server/server.js).
const DEFAULT_RELAY = 'wss://arviewer-relay.onrender.com/ws';

export function normalizeRelay(value) {
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

export function resolveRelay() {
  const param = new URLSearchParams(location.search).get('relay');
  if (param && normalizeRelay(param)) localStorage.setItem('arviewer.relay', param);
  const saved = param ?? localStorage.getItem('arviewer.relay');
  const normalized = normalizeRelay(saved);
  if (normalized) return normalized;
  if (location.host.endsWith('.github.io')) return DEFAULT_RELAY;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
