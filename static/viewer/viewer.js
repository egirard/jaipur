// Phone WebXR viewer: registers the table by image-tracking the exact
// play-area image the table publishes (with a tap-to-place fallback) and
// renders the synced card layout anchored to it. Reveals and zoom are local.

import * as THREE from 'three';
import { drawFace, drawBack } from '../shared/cards.js';
import { resolveRelay } from '../shared/relay.js';

const params = new URLSearchParams(location.search);
const sessionId = (params.get('s') ?? '').toUpperCase();
// Seat identity comes from the QR the player scanned (AR Card Viewer API):
// a seat QR embeds ?seat=TOKEN. The token is opaque to the relay and only
// the table maps it to a seat; for the labels here the seat number is the
// part before the first '-' (jaipur issues "1-XXXXXXXX"; a bare "1" also
// works). There are no spectators: a link without a seat is turned away.
const seatToken = params.get('seat');
const seatNo = seatToken ? seatToken.split('-')[0] : null;

const lobby = document.getElementById('lobby');
const lobbyMsg = document.getElementById('lobbyMsg');
const joinForm = document.getElementById('join');
const nameInput = document.getElementById('name');
const nameLabel = document.getElementById('nameLabel');
const goBtn = document.getElementById('go');
const goFlatBtn = document.getElementById('goFlat');
const flagHint = document.getElementById('flagHint');
const seatedMsg = document.getElementById('seated');
// One button does everything: it joins the table AND enters AR in the
// same tap (entering AR without joining left the player locked out).
let lobbyReady = false;
// "Play using phone": a plain 2D hand view for browsers without WebXR.
let flatReady = false;
let flatActive = false;
let xrSupported = null;
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const exitBtn = document.getElementById('exit');

// ---- Networking ------------------------------------------------------------

// Diagnostics switches: from the table's Table options (scene.debug), or
// forced for a standalone test with ?debug=targets,diag.
const debugParam = new Set((params.get('debug') ?? '').split(',').filter(Boolean));
let debugFlags = { targets: debugParam.has('targets'), diag: debugParam.has('diag'), regcheck: null };

let latestState = null;
let latestSeatState = null; // this seat's private scene (stateFor)
let latestTracking = null; // static-layer tracked image, sent separately
let ws;
// Diagnostics surfaced in the lobby so a stuck viewer shows WHY.
const diag = { relay: 'connecting', tableConnected: null, tracking: false, state: false, assets: false, seat: seatToken ?? null };
function diagLine() {
  const mark = (b) => (b ? '✓' : '✗');
  const host = diag.tableConnected == null ? '…' : diag.tableConnected ? 'connected' : 'absent';
  return `session ${sessionId || '—'} · relay ${diag.relay} · table ${host} · ` +
    `tracking ${mark(diag.tracking)} state ${mark(diag.state)} assets ${mark(diag.assets)}` +
    (diag.seat ? ` · seat ${seatNo}` : ' · no seat');
}

// ---- Probe: what this phone holds and draws, reported with the check ------
// The registration check's reports (kept by the relay, GET /regchecks) carry
// a `probe`: the diag line, every asset and whether its texture decoded,
// the seat scene, each 3D card with its screen position, recent errors and
// the GL context — and `shots`, a small offscreen rendering of the virtual
// layer from the phone's own pose at the end of the hand and re-lock steps.
// So a "my cards don't show" report can be read remotely without the phone.
const probeErrors = [];
function noteError(kind, text) {
  probeErrors.push({ at: new Date().toISOString(), kind, text: String(text ?? '').slice(0, 300) });
  if (probeErrors.length > 12) probeErrors.shift();
}
window.addEventListener('error', (e) => noteError('error', `${e.message ?? e} @${e.filename?.split('/').pop() ?? ''}:${e.lineno ?? ''}`));
window.addEventListener('unhandledrejection', (e) => noteError('rejection', e.reason?.message ?? e.reason));
{
  const orig = console.error.bind(console);
  console.error = (...a) => { noteError('console', a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); orig(...a); };
}
const textureStatus = new Map(); // asset id -> { bytes, loaded, w, h, error }

// ---- Seat join ---------------------------------------------------------------
// A seated phone is a WINDOW onto the table, not a controller: the only
// thing it asks the host for is to sit down under a name. The host seats
// it in the game and confirms by naming the seat holder in this seat's
// private scene (stateFor.player). The join is re-sent on every reconnect
// (idempotent on the host), so a dropped socket never loses the seat.
let joinName = '';
try { joinName = localStorage.getItem('arviewer:name') ?? ''; } catch { /* private mode */ }
let joinRequested = false;
let seatedAs = null;

function sendJoin() {
  if (!seatToken || !joinName || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'action', action: 'join', data: { name: joinName } }));
}

const needsName = () => Boolean(seatToken) && !seatedAs;

// ---- Play against an AI ------------------------------------------------------
// While the seat across from this phone is empty, the table lists the bot
// levels it can seat there (stateFor.offers.bot). One button per level, in
// the lobby and as a DOM overlay in AR; tapping asks the table to seat that
// bot (action 'bot'), and the offer disappears once the seat is taken.
const botOfferEls = [document.getElementById('botOffer'), document.getElementById('botOfferAr'), document.getElementById('botOfferFlat')];
let botOffers = [];
function requestBot(difficulty) {
  if (!seatToken || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'action', action: 'bot', data: { difficulty } }));
  setHud(`Seating the ${difficulty} bot…`);
}
function renderBotOffer() {
  const show = Boolean(seatToken) && botOffers.length > 0;
  overlay.classList.toggle('has-offer', show); // the HUD line steps up over the in-AR buttons
  for (const el of botOfferEls) {
    if (!el) continue;
    el.classList.toggle('hidden', !show);
    el.replaceChildren();
    if (!show) continue;
    const title = document.createElement('span');
    title.textContent = 'Play against an AI';
    el.append(title);
    for (const offer of botOffers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.botLevel = offer.id;
      b.append(`vs ${offer.name}`);
      const blurb = document.createElement('small');
      blurb.textContent = offer.blurb ?? '';
      b.append(blurb);
      b.addEventListener('click', () => requestBot(offer.id));
      el.append(b);
    }
  }
}

function renderJoin() {
  if (seatToken) {
    if (seatedAs) {
      seatedMsg.textContent = `Seated as ${seatedAs} · Player ${seatNo}`;
      seatedMsg.classList.remove('hidden');
    } else {
      seatedMsg.classList.add('hidden');
    }
    nameInput.classList.toggle('hidden', !needsName());
    nameLabel.classList.toggle('hidden', !needsName());
  }
  const nameOk = !needsName() || nameInput.value.trim().length > 0;
  const tableOk = !needsName() || diag.tableConnected === true;
  const open = ws?.readyState === WebSocket.OPEN;
  // No WebXR (iPhone): the AR button stays visible but disabled and says
  // why, so the phone view reads as the intended path rather than a fallback.
  const noXr = xrSupported === false;
  goBtn.disabled = noXr || !(lobbyReady && nameOk && tableOk && open);
  goBtn.textContent = noXr ? 'Enter AR — not available in this browser'
    : needsName() ? 'Join table & enter AR' : seatedAs ? `Enter AR as ${seatedAs}` : 'Enter AR';
  goBtn.classList.toggle('unavailable', noXr);
  goFlatBtn.classList.toggle('primary', noXr);
  goFlatBtn.disabled = !(flatReady && nameOk && tableOk && open);
  goFlatBtn.textContent = needsName() ? 'Join table & play using phone' : 'Play using phone';
  renderFlagHint();
}

// Image tracking (auto-alignment on the table) sits behind
// chrome://flags/#webxr-incubations. Chromium exposes the Image Tracking
// interfaces only while that feature is on — XRFrame.getImageTrackingResults
// is absent otherwise — so a phone with WebXR can tell before any session;
// failing that, the last AR session on this phone remembers whether it got
// the feature (arviewer:image-tracking). true / false / null (no way to know).
function imageTrackingEnabled() {
  if (typeof XRFrame !== 'undefined') return 'getImageTrackingResults' in XRFrame.prototype;
  try {
    const seen = localStorage.getItem('arviewer:image-tracking');
    if (seen === 'yes' || seen === 'no') return seen === 'yes';
  } catch { /* ignore */ }
  return null;
}
function renderFlagHint() {
  const known = xrSupported === true ? imageTrackingEnabled() : true;
  flagHint.classList.toggle('hidden', known === true);
  if (known === true) return;
  flagHint.innerHTML = known === false
    ? 'Image tracking is off in this Chrome: turn on <code>chrome://flags/#webxr-incubations</code> and relaunch for auto-alignment; otherwise tap the table surface to place the cards.'
    : 'Auto-alignment needs <code>chrome://flags/#webxr-incubations</code>; otherwise tap the table surface to place the cards.';
}

if (seatToken) {
  nameInput.value = joinName;
  nameInput.addEventListener('input', renderJoin);
}
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (goBtn.disabled) return;
  if (needsName()) {
    joinName = nameInput.value.trim().slice(0, 32);
    if (!joinName) return;
    try { localStorage.setItem('arviewer:name', joinName); } catch { /* ignore */ }
    joinRequested = true;
    sendJoin();
  }
  void enterAR(); // same user gesture: WebXR needs it
});
goFlatBtn.addEventListener('click', () => {
  if (goFlatBtn.disabled) return;
  if (needsName()) {
    joinName = nameInput.value.trim().slice(0, 32);
    if (!joinName) return;
    try { localStorage.setItem('arviewer:name', joinName); } catch { /* ignore */ }
    joinRequested = true;
    sendJoin();
  }
  enterFlat();
});

let rejected = null; // the relay's reason for turning this phone away, if it did
function connect() {
  const relay = resolveRelay();
  if (!relay) {
    lobbyMsg.textContent = 'No relay server configured — scan the QR code on the table to join.';
    return;
  }
  ws = new WebSocket(relay);
  ws.onopen = () => {
    diag.relay = 'open';
    ws.send(JSON.stringify({
      type: 'join', role: 'viewer', session: sessionId,
      ...(seatToken ? { seat: seatToken } : {}),
    }));
    if (joinRequested) sendJoin(); // reconnect: re-assert the seat
    readyCheck();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'joined') {
      diag.tableConnected = msg.tableConnected;
      readyCheck();
    } else if (msg.type === 'rejected') {
      // The relay turned this phone away (no seat token): the lobby says so
      // and the connection is not retried.
      rejected = msg.reason ?? 'rejected';
      readyCheck();
    } else if (msg.type === 'host') {
      diag.tableConnected = msg.connected;
      if (msg.connected && joinRequested) sendJoin(); // table came (back) up
      readyCheck();
      renderFlat(); // the phone view says when the table has gone
    } else if (msg.type === 'state') {
      latestState = msg.state;
      diag.state = true;
      // Diagnostics the table asked for (Table options): outline the
      // tracking targets in AR, print the registration numbers on screen.
      const dbg = msg.state?.debug;
      debugFlags = { targets: Boolean(dbg?.targets) || debugParam.has('targets'), diag: Boolean(dbg?.diag) || debugParam.has('diag'), regcheck: dbg?.regcheck ?? null };
      applyDebugFlags();
      onRegCheckFlag();
      applyScene();
      readyCheck();
    } else if (msg.type === 'stateFor') {
      // This seat's private scene (e.g. the player's hand), merged over the
      // shared table. The relay only sends it to the holder of the seat.
      latestSeatState = msg.state;
      // The host names the seat holder once the join is accepted.
      const offered = msg.state?.offers?.bot;
      botOffers = Array.isArray(offered) ? offered.filter((o) => o && typeof o.id === 'string') : [];
      renderBotOffer();
      const holder = msg.state?.player?.name;
      if (typeof holder === 'string' && holder && seatedAs !== holder) {
        seatedAs = holder;
        readyCheck();
        if (xrSession) setHud(`Seated as ${holder}. ${hud.textContent ?? ''}`.trim());
      }
      applyScene();
    } else if (msg.type === 'assets') {
      // Out-of-band artwork (cached+replayed by the relay like tracking).
      if (msg.seat) seatAssets = msg.assets ?? {};
      else { sharedAssets = msg.assets ?? {}; diag.assets = true; }
      applyScene();
    } else if (msg.type === 'tracking') {
      // The table re-captures its whole screen whenever it changes; the
      // newest image is used the next time an AR session starts.
      latestTracking = msg.tracking;
      window.__arvTracking = latestTracking; // DevTools/test hook
      diag.tracking = true;
      readyCheck();
    }
  };
  ws.onclose = () => {
    if (rejected) { diag.relay = 'closed'; readyCheck(); return; }
    diag.relay = 'reconnecting';
    diag.tableConnected = null;
    readyCheck();
    setTimeout(connect, 1500);
  };
}

function sendAction(action, nodeId, data) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'action', action, ...(nodeId ? { nodeId } : {}), ...(data ? { data } : {}) }));
}

// The AR view mirrors the table pixel-for-pixel by default (back on back,
// face on face). Tapping a card in AR shows its HIDDEN side — the face of a
// face-down card, or the back of a face-up one — only in this player's view.
// Nothing is sent over the network for a reveal.
function updateTarget(node) {
  const showFront = node.faceUp !== node.flipped;
  node.target = showFront ? 0 : Math.PI; // flip angle: 0 = front visible
}

function toggleReveal(id) {
  const node = cardNodes.get(id);
  if (node) {
    node.flipped = !node.flipped;
    updateTarget(node);
  }
}

// ---- Lobby / capability gate ----------------------------------------------

async function readyCheck() {
  if (xrSession || flatActive) return; // in AR / phone view: the lobby is hidden
  lobbyReady = false;
  flatReady = false;
  if (!sessionId) {
    lobbyMsg.textContent = 'No session code in the URL. Scan the QR code on the table to join.';
    renderJoin();
    return;
  }
  if (!seatToken || rejected) {
    // Every phone is a seat: without a seat token there is nothing to show
    // (spectating was dropped — the table is the shared view).
    lobbyMsg.textContent = 'This link has no seat. Scan the QR code on one of the table\u2019s two seats to join.';
    renderJoin();
    return;
  }
  if (xrSupported === null) {
    try { xrSupported = Boolean(navigator.xr) && Boolean(await navigator.xr.isSessionSupported?.('immersive-ar')); }
    catch { xrSupported = false; }
  }
  const tableGate = needsName() && diag.tableConnected !== true;
  // The phone view only needs the table's state (its hand arrives with the seat).
  flatReady = Boolean(latestState || latestSeatState) && !tableGate;
  if (!xrSupported) {
    lobbyMsg.textContent = (flatReady
      ? 'No WebXR AR in this browser (iOS Safari does not ship it): play using the phone view — your hand, herd and selections, like a private hand controller.'
      : diag.tableConnected === false
        ? 'No tabletop is connected to this session — open/reload the tabletop, or check you scanned its current QR.'
        : 'No WebXR AR in this browser. Waiting for the table to publish its layout…') + `\n${diagLine()}`;
    renderJoin();
    return;
  }
  if (!latestState || !latestTracking || tableGate) {
    const why = diag.tableConnected === false
      ? 'No tabletop is connected to this session — open/reload the tabletop, or check you scanned its current QR.'
      : 'Waiting for the table to publish its layout…';
    lobbyMsg.textContent = `${why}\n${diagLine()}`;
    renderJoin();
    return;
  }
  lobbyReady = true;
  const pieceCount = ((latestState.v ?? 0) >= 1 ? latestState.nodes : latestState.cards)?.length ?? 0;
  lobbyMsg.textContent =
    `Session ${sessionId} · ${pieceCount} pieces` +
    `${seatedAs ? '' : ` · Player ${seatNo}`}`;
  renderJoin();
}

// ---- Three.js scene --------------------------------------------------------

// Android Chrome 147+ exposes WebXR Layers, so three.js draws into an
// XRProjectionLayer — which, in immersive-ar, Chrome draws but never
// composites over the camera: the cards are there (taps hit them, the
// offscreen probe shows them) and the screen shows only the passthrough
// (three.js #33404; seen here on Chrome 156, Mali-G715, 2026-10-30). Hiding
// `renderState.layers` makes three take its classic XRWebGLLayer path, which
// Chrome composites. ?layers=1 keeps the projection-layer path for comparison.
// Retest on new Chrome versions: docs/KNOWN-ISSUES.md.
const forceBaseLayer = params.get('layers') !== '1';
if (forceBaseLayer && typeof XRRenderState !== 'undefined') {
  try { Object.defineProperty(XRRenderState.prototype, 'layers', { configurable: true, get() { return undefined; } }); }
  catch (err) { noteError('layers', `could not hide renderState.layers: ${err?.message ?? err}`); }
}
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
// Per the technical guide: the GL layer must clear to zero alpha so the
// device composites the passthrough camera feed behind our render.
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);
// The drawing buffer follows the viewport (the stylesheet pins the canvas to
// it); three would otherwise leave a 300 × 150 buffer whose CSS size widened
// the page on phones.
const fitCanvas = () => renderer.setSize(window.innerWidth, window.innerHeight, false);
fitCanvas();
window.addEventListener('resize', fitCanvas);

const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera();

// Root group registered to the physical table (or manual placement).
const tableRoot = new THREE.Group();
tableRoot.visible = false;
scene.add(tableRoot);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.06, 0.075, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x3f8cff, transparent: true, opacity: 0.85 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// ---- Cards -----------------------------------------------------------------

const cardNodes = new Map(); // id -> { group, flip, target, current, hoverPhase }
const raycastMeshes = [];

// ---- Textures --------------------------------------------------------------
// One registry for every artwork source. v0 states draw the shared
// procedural deck; v1 states carry artwork as assets (data URLs or https),
// content-addressed by the host so repeated cards share one texture.
const textureRegistry = new Map(); // key -> THREE.Texture

function proceduralTexture(key, draw, def) {
  let tex = textureRegistry.get(key);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  draw(canvas, def);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureRegistry.set(key, tex);
  return tex;
}

function assetTexture(assetId, img) {
  const key = `asset:${assetId}`;
  let tex = textureRegistry.get(key);
  if (tex) return tex;
  tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const status = { bytes: typeof img === 'string' ? img.length : 0, loaded: false, w: 0, h: 0, error: null, at: null };
  textureStatus.set(assetId, status);
  image.onload = () => {
    tex.image = image;
    tex.needsUpdate = true;
    Object.assign(status, { loaded: true, w: image.naturalWidth, h: image.naturalHeight, at: new Date().toISOString() });
  };
  image.onerror = (e) => { status.error = `image failed to decode (${e?.type ?? 'error'})`; noteError('texture', `${assetId}: ${status.error}`); };
  image.src = img;
  textureRegistry.set(key, tex);
  return tex;
}

const NEUTRAL_BACK = 'proc:neutral-back';
function neutralBackTexture() {
  let tex = textureRegistry.get(NEUTRAL_BACK);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#39404a';
  ctx.fillRect(0, 0, 8, 8);
  tex = new THREE.CanvasTexture(canvas);
  textureRegistry.set(NEUTRAL_BACK, tex);
  return tex;
}

// Soft radial halo used for host-driven glow ("ready to trade" etc.).
function haloTexture() {
  let tex = textureRegistry.get('proc:halo');
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 24, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  tex = new THREE.CanvasTexture(canvas);
  textureRegistry.set('proc:halo', tex);
  return tex;
}

// ---- Scene normalization ---------------------------------------------------
// Both protocol versions and both channels (shared state + this seat's
// stateFor) normalize into one node list; a single render path consumes it.
// v1 assets persist per channel ("assets": null/omitted = unchanged).
let sharedAssets = {};
let seatAssets = {};

function normalizeChannel(state, channel) {
  if (!state) return [];
  if ((state.v ?? 0) >= 1) {
    if (state.assets && typeof state.assets === 'object') {
      if (channel === 'shared') sharedAssets = state.assets;
      else seatAssets = state.assets;
    }
    // Private nodes may reference shared artwork (e.g. the common card back).
    const assets = channel === 'shared' ? sharedAssets : { ...sharedAssets, ...seatAssets };
    return (state.nodes ?? []).flatMap((n) => {
      // A badge is a floating count with no piece under it: no artwork needed.
      if (n.kind === 'badge') {
        return [{
          id: n.id, kind: 'badge', xM: n.xM ?? 0, zM: n.zM ?? 0, rotY: n.rotY ?? 0,
          faceUp: true, peek: false, glow: false, count: n.count ?? 0, wM: 0, hM: 0,
          getFaceTex: () => null, getBackTex: () => null,
        }];
      }
      const face = assets[n.face];
      if (!face) return []; // unknown asset: skip node rather than crash
      const back = assets[n.back];
      return [{
        id: n.id,
        kind: n.kind === 'tile' || n.kind === 'stack' ? n.kind : 'card',
        xM: n.xM ?? 0, zM: n.zM ?? 0, rotY: n.rotY ?? 0,
        faceUp: n.kind === 'card' ? !!n.faceUp : true,
        peek: n.kind === 'card' && n.peek !== false,
        glow: n.glow ?? false,
        // This seat's own hand card or camel: a tap in AR stages it on the
        // table (a `select` intent), the same as a tap on the table itself.
        own: channel === 'seat' && /^(hand|herd|sale):/.test(String(n.id)), // sale: the numbers and ✕ over a raised set
        tap: n.tap !== false,
        tag: typeof n.tag === 'string' ? n.tag : '',
        count: n.count ?? 0,
        wM: face.wM ?? 0.063, hM: face.hM ?? 0.088,
        faceId: n.face, backId: back ? n.back : null,
        getFaceTex: () => assetTexture(n.face, face.img),
        getBackTex: () => (back ? assetTexture(n.back, back.img) : neutralBackTexture()),
      }];
    });
  }
  // v0: the ARViewer procedural deck (shared channel only).
  const { wM, hM } = state.card;
  return (state.cards ?? []).map((c) => ({
    id: c.id,
    kind: 'card',
    xM: c.xM, zM: c.zM, rotY: c.rotY,
    faceUp: !!c.faceUp,
    peek: true,
    glow: false,
    count: 0,
    wM, hM,
    getFaceTex: () => proceduralTexture(`proc:face:${JSON.stringify(c.def)}`, drawFace, c.def),
    getBackTex: () => proceduralTexture('proc:back', drawBack),
  }));
}

// A stable, distinct height offset per card. When two revealed cards are
// zoomed they enlarge and overlap; sharing the same plane makes them z-fight
// (the flicker that reads as continual flipping). A fraction-of-a-mm lift per
// card keeps neighbours on their own planes. The ordinal wraps: ids keep
// arriving over a game (market, hand, herd and return-slot nodes for every
// card), and an ever-growing ordinal had lifted late cards centimetres off
// the table. Twelve planes (max ~4.4mm) is plenty for any two neighbours.
const cardOrdinals = new Map();
let nextCardOrdinal = 0;
function cardZBias(id) {
  let o = cardOrdinals.get(id);
  if (o === undefined) {
    o = nextCardOrdinal++;
    cardOrdinals.set(id, o);
  }
  return (o % 12) * 0.0004;
}

function countBadgeTexture(count) {
  return proceduralTexture(`proc:count:${count}`, (canvas) => {
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(10, 20, 14, 0.85)';
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#d8e6da';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), 32, 34);
  });
}

function buildNode(n) {
  const { wM, hM } = n;
  const group = new THREE.Group(); // sits at the node's table slot
  const flip = new THREE.Group(); // animates the end-over-end flip (cards)
  group.add(flip);

  // Front faces +Y (up off the table), top edge toward -Z, matching the
  // table frame documented in docs/ARCHITECTURE.md.
  if (n.kind !== 'badge') {
    const frontGeo = new THREE.PlaneGeometry(wM, hM).rotateX(-Math.PI / 2);
    const front = new THREE.Mesh(
      frontGeo,
      new THREE.MeshBasicMaterial({ map: n.getFaceTex(), transparent: true })
    );
    front.userData.cardId = n.id;
    flip.add(front);
    raycastMeshes.push(front);
  }
  if (n.kind === 'card') {
    const backGeo = new THREE.PlaneGeometry(wM, hM).rotateY(Math.PI).rotateX(-Math.PI / 2);
    const back = new THREE.Mesh(
      backGeo,
      new THREE.MeshBasicMaterial({ map: n.getBackTex(), transparent: true })
    );
    back.userData.cardId = n.id;
    flip.add(back);
    raycastMeshes.push(back);
  }

  // Host-driven highlight halo, just under the piece.
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(wM * 1.45, hM * 1.45).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: haloTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0x66ffcc,
    })
  );
  // Sits 4mm under the card: below every neighbour's per-card lift too, so
  // fanned/overlapping cards never z-fight with a selected card's halo.
  halo.position.y = -0.004;
  halo.visible = false;
  group.add(halo);

  // Count badge: a stack's pile count at its near-right corner, or a
  // standalone badge (e.g. a herd's size) centred on its spot. Drawn last
  // and without depth testing, floating a little above the table, so the
  // cards around it never cover it.
  let badge = null;
  if (n.kind === 'stack' || n.kind === 'badge') {
    const size = n.kind === 'badge' ? 0.03 : 0.024;
    badge = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: countBadgeTexture(n.count), transparent: true, depthWrite: false, depthTest: false })
    );
    badge.renderOrder = 100;
    if (n.kind === 'badge') badge.position.set(0, 0.012, 0);
    else badge.position.set(wM / 2, 0.012, hM / 2);
    group.add(badge);
  }

  group.position.set(n.xM, 0.002, n.zM);
  group.rotation.y = n.rotY;
  tableRoot.add(group);

  const faceDown = n.kind === 'card' && !n.faceUp;
  return {
    group,
    flip,
    halo,
    badge,
    kind: n.kind,
    count: n.count,
    peek: n.peek,
    sizeKey: `${wM}x${hM}`,
    faceUp: !faceDown,
    flipped: false, // this viewer is looking at the hidden side
    target: faceDown ? Math.PI : 0,
    current: faceDown ? Math.PI : 0,
    zBias: cardZBias(n.id), // per-card height offset (anti z-fight)
    // Slide targets: new cards spawn in place, then glide toward updates.
    tx: n.xM,
    tz: n.zM,
    trot: n.rotY,
  };
}

function disposeNode(node) {
  tableRoot.remove(node.group);
  for (const mesh of node.flip.children) {
    const i = raycastMeshes.indexOf(mesh);
    if (i >= 0) raycastMeshes.splice(i, 1);
    mesh.material.dispose(); // textures live in the shared registry
    mesh.geometry.dispose();
  }
  node.halo.material.dispose();
  node.halo.geometry.dispose();
  node.badge?.material.dispose();
  node.badge?.geometry.dispose();
}

// ---- Phone (flat) view --------------------------------------------------------
// This seat's private hand controller as a 2D page, driven over the relay
// (what jaipur's retired /hand page used to do from the game's store). Two
// forms, chosen on the phone and remembered there:
//  - MINIMAL shows only what the player needs: the hand (a tap selects or
//    deselects a card — the one interaction), the herd, the score split into
//    the face-up goods total and each hidden bonus value, and what selling
//    each good would earn. Moves are finished on the table.
//  - COMPLETE adds the shared market and whole moves from the phone: tap a
//    market card and confirm to draw it (or the camels); select returns,
//    tap two or more market cards, confirm to trade; tap a sale, confirm.
// Nothing is decided here: selection is the host's (glow), the move in
// progress is the host's (notes + controls), and every tap is an intent
// the host validates. No tracking, no WebXR: any phone browser can play.
const flatEl = document.getElementById('flat');
const flatTitle = document.getElementById('flatTitle');
const flatTurn = document.getElementById('flatTurn');
const flatMsg = document.getElementById('flatMsg');
const flatPrompt = document.getElementById('flatPrompt');
const flatNotes = document.getElementById('flatNotes');
const flatControls = document.getElementById('flatControls');
const flatHand = document.getElementById('flatHand');
const flatHerdWrap = document.getElementById('flatHerdWrap');
const flatHerd = document.getElementById('flatHerd');
const flatMarketWrap = document.getElementById('flatMarketWrap');
const flatMarket = document.getElementById('flatMarket');
const flatScore = document.getElementById('flatScore');
const flatSales = document.getElementById('flatSales');
const flatSaleList = document.getElementById('flatSaleList');
const flatModes = document.getElementById('flatModes');

const FLAT_MODE_KEY = 'arviewer:phone-view';
let flatMode = 'minimal';
try { if (localStorage.getItem(FLAT_MODE_KEY) === 'complete') flatMode = 'complete'; } catch { /* storage blocked: minimal */ }
function setFlatMode(mode) {
  flatMode = mode === 'complete' ? 'complete' : 'minimal';
  try { localStorage.setItem(FLAT_MODE_KEY, flatMode); } catch { /* fine */ }
  renderFlat();
}
flatModes.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setFlatMode(b.dataset.mode);
});

function enterFlat() {
  flatActive = true;
  lobby.classList.add('hidden');
  flatEl.classList.remove('hidden');
  renderFlat();
}
document.getElementById('flatExit').addEventListener('click', () => {
  flatActive = false;
  flatEl.classList.add('hidden');
  lobby.classList.remove('hidden');
  readyCheck();
});

// A piece in the phone view. Tappable pieces are buttons that send a
// `select` intent for their node id (own cards and camels; market cards in
// the complete view) — distinct from AR `tap`, which stays a local peek;
// the host answers with glow / a tag.
function flatCard(n, assets, big, tappable, extraClass) {
  const face = assets[n.faceUp === false && n.back ? n.back : n.face];
  if (!face) return null;
  const inert = n.tap === false;
  const cell = document.createElement(tappable ? 'button' : 'div');
  if (tappable) {
    cell.type = 'button';
    cell.disabled = inert;
    cell.setAttribute('aria-pressed', String(Boolean(n.glow)));
    cell.setAttribute('aria-label', `${n.glow ? 'Deselect' : 'Select'} ${n.id}`);
    cell.addEventListener('click', () => { sendAction('select', n.id); flatMsg.textContent = 'Sent to the table…'; });
  }
  cell.dataset.node = n.id;
  if (extraClass) cell.classList.add(extraClass);
  if (n.glow) { cell.classList.add('glow'); if (typeof n.glow === 'string') cell.style.setProperty('--glow', n.glow); }
  if (inert) cell.classList.add('inert');
  const img = document.createElement('img');
  img.src = face.img;
  img.alt = big ? 'hand card' : 'market card';
  cell.append(img);
  if (n.tag) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = n.tag; cell.append(tag); }
  return cell;
}

const controlsOf = (seat) => (Array.isArray(seat?.controls) ? seat.controls.filter((c) => c && typeof c.id === 'string') : []);
const GOOD_NAMES = { diamond: 'Diamonds', gold: 'Gold', silver: 'Silver', cloth: 'Cloth', spice: 'Spice', leather: 'Leather' };

function renderFlat() {
  if (!flatActive) return;
  const complete = flatMode === 'complete';
  for (const b of flatModes.querySelectorAll('button[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === flatMode));
  flatEl.dataset.mode = flatMode;
  const assets = { ...sharedAssets, ...seatAssets };
  const seat = latestSeatState;
  flatTitle.textContent = seatedAs ? `${seatedAs} · Player ${seatNo}` : `Player ${seatNo}`;
  const nodes = seat?.nodes ?? [];
  const own = Boolean(seatToken && seatedAs);
  const myTurn = seat?.turn === true;
  const hand = nodes.filter((n) => typeof n.id === 'string' && n.id.startsWith('hand:'));
  const flip = hand.some((n) => Math.abs((n.rotY ?? 0) - Math.PI) < 0.01) ? -1 : 1;
  hand.sort((a, b) => flip * ((a.xM ?? 0) - (b.xM ?? 0)));
  flatHand.replaceChildren(...hand.map((n) => flatCard(n, assets, true, own)).filter(Boolean));
  flatHand.style.setProperty('--cols', String(hand.length <= 4 ? Math.max(1, hand.length) : Math.ceil(hand.length / 2)));
  // The sale raised in the hand (the host's `handSale`): on each raised card
  // the worth of selling it and the cards before it (greyed where that
  // many cannot be sold), the bonus it would earn, and an ✕ on the last.
  // A number or the ✕ sends a `control` — the host sells or lowers; the
  // phone keeps nothing. (Spans with a role: the cell is itself a button.)
  const handSale = own && seat?.handSale && typeof seat.handSale.kind === 'string' && Array.isArray(seat.handSale.steps) ? seat.handSale : null;
  if (handSale) {
    const control = (id, label) => (ev) => { ev.stopPropagation(); ev.preventDefault(); sendAction('control', undefined, { id }); flatMsg.textContent = label; };
    const mark = (cls, text, role) => { const el = document.createElement('span'); el.className = cls; el.textContent = text; if (role) { el.setAttribute('role', 'button'); el.tabIndex = 0; } return el; };
    for (const step of handSale.steps) {
      if (!step || typeof step.id !== 'string') continue;
      const cell = flatHand.querySelector(`[data-node="hand:${CSS.escape(step.id)}"]`);
      if (!cell) continue;
      const number = mark(`sale-step${step.legal ? '' : ' illegal'}`, String(step.total ?? ''), step.legal);
      number.dataset.saleCount = String(step.k);
      number.setAttribute('aria-label', step.legal ? `Sell ${step.k} for ${step.total}` : `${step.k} cannot be sold`);
      if (step.legal) number.addEventListener('click', control(`sale:${handSale.kind}:${step.k}`, `Selling ${step.k}…`));
      cell.append(number);
      if (step.bonus) cell.append(mark('sale-bonus', step.bonus === '5' ? '5+' : String(step.bonus)));
      if (step.last) {
        const x = mark('sale-cancel', '✕', true);
        x.dataset.saleCancel = '1';
        x.setAttribute('aria-label', 'Lower the cards');
        x.addEventListener('click', control('sale:cancel', 'Lowering…'));
        cell.append(x);
      }
    }
  }
  document.getElementById('flatHandCount').textContent = hand.length ? `${hand.length} / 7` : '';
  const herd = nodes.filter((n) => typeof n.id === 'string' && n.id.startsWith('herd:'));
  flatHerdWrap.classList.toggle('hidden', !own || (!herd.length && !hand.length));
  document.getElementById('flatHerdCount').textContent = herd.length ? `${herd.length} camel${herd.length === 1 ? '' : 's'}` : 'no camels';
  flatHerd.replaceChildren(...herd.map((n) => flatCard(n, assets, false, own)).filter(Boolean));
  // The turn pill is the host's.
  const hasTurn = typeof seat?.turn === 'boolean';
  flatTurn.classList.toggle('hidden', !own || !hasTurn);
  flatTurn.classList.toggle('active', myTurn);
  flatTurn.textContent = myTurn ? 'Your turn' : 'Watch the table';
  // Score: face-up goods total, each hidden bonus value.
  const score = seat?.score;
  flatScore.classList.toggle('hidden', !own || !score);
  if (score) {
    // The tokens themselves, as the table has them: each goods token (face
    // up) in its good's colour, each bonus token's hidden value in rust.
    const chip = (v, kind) => { const b = document.createElement('b'); b.textContent = String(v); if (kind) b.dataset.kind = kind; return b; };
    const none = (t) => Object.assign(document.createElement('span'), { className: 'none', textContent: t });
    document.getElementById('flatScoreTotal').textContent = String(score.total ?? 0);
    const goods = Array.isArray(score.goodsTokens) ? score.goodsTokens : [];
    document.getElementById('flatScoreGoods').replaceChildren(...(goods.length ? goods.map((t) => chip(t.value, t.kind)) : [none('no goods tokens yet')]));
    document.getElementById('flatScoreGoodsSum').textContent = goods.length ? String(score.goods ?? 0) : '';
    const bonus = Array.isArray(score.bonus) ? score.bonus : [];
    // Bonus tokens read "+3": a plus marks them off from the goods tokens.
    document.getElementById('flatScoreBonus').replaceChildren(...(bonus.length ? bonus.map((v) => chip(`+${v}`)) : [none('no bonus tokens yet')]));
    document.getElementById('flatScoreBonusSum').textContent = bonus.length ? `+${bonus.reduce((a, b) => a + b, 0)}` : '';
  }
  // Sell now: one line per good in the hand; a button when the host allows the sale from here (complete view).
  const sales = Array.isArray(seat?.sales) ? seat.sales.filter((o) => o && typeof o.kind === 'string') : [];
  flatSales.classList.toggle('hidden', !own || !sales.length);
  // In the complete view each sale is a button: the whole row, lit when the
  // host offers it now (your turn, legal, nothing else pending); otherwise
  // the row says why it waits. Minimal shows the values only.
  const pending = controlsOf(seat).length > 0;
  flatSaleList.replaceChildren(...sales.map((o) => {
    const li = document.createElement('li');
    li.dataset.sale = o.kind;
    if (!o.legal) li.classList.add('illegal');
    const offered = complete && Boolean(o.control) && myTurn;
    const row = document.createElement(offered ? 'button' : 'span');
    row.className = 'sale-row';
    if (offered) {
      row.type = 'button';
      row.dataset.control = o.control;
      row.setAttribute('aria-label', `Sell ${o.cards} ${o.kind} for ${o.base}`);
      // The host raises that good's cards in the hand (one advances on the table); the numbers on the cards here finish the sale.
      row.addEventListener('click', () => { sendAction('control', undefined, { id: o.control }); flatMsg.textContent = 'Tap a number on the raised cards to sell that many, or ✕ to lower them.'; });
      li.classList.add('offered');
    }
    const art = assets[`s-${o.kind}`] ?? assets[`k-${o.kind}`];
    if (art) { const img = document.createElement('img'); img.src = art.img; img.alt = ''; row.append(img); }
    const what = document.createElement('span');
    what.className = 'sale-what';
    what.textContent = `${GOOD_NAMES[o.kind] ?? o.kind} × ${o.cards}`;
    const why = !o.legal ? o.why : complete && !offered ? (!myTurn ? 'Not your turn' : pending ? 'Finish the move in progress first' : 'Not sellable right now') : null;
    if (why) { const w = document.createElement('small'); w.textContent = why; what.append(w); if (complete && o.legal) li.classList.add('held'); }
    row.append(what);
    const value = document.createElement('span');
    value.className = 'sale-value';
    value.textContent = `+${o.base}`;
    if (o.bonus) { const b = document.createElement('small'); b.textContent = `+${o.bonus} bonus`; value.append(b); }
    row.append(value);
    if (offered) { const go = document.createElement('span'); go.className = 'sale-go'; go.textContent = 'Sell'; row.append(go); }
    li.append(row);
    return li;
  }));
  // Complete view only: the market (tappable on this player's turn), the move in progress.
  const market = complete ? (latestState?.nodes ?? []).filter((n) => (n.kind ?? 'card') === 'card' && String(n.id).startsWith('mkt:')) : [];
  market.sort((a, b) => (a.xM ?? 0) - (b.xM ?? 0));
  flatMarketWrap.classList.toggle('hidden', !complete || !market.length);
  flatMarket.replaceChildren(...market.map((n) => flatCard(n, assets, false, own && myTurn, own && myTurn ? 'mkt-tappable' : undefined)).filter(Boolean));
  const notes = complete && Array.isArray(seat?.notes) ? seat.notes.filter((t) => typeof t === 'string') : [];
  const controls = complete ? controlsOf(seat) : [];
  flatNotes.replaceChildren(...notes.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  flatControls.replaceChildren(...controls.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.control = c.id;
    if (c.kind === 'confirm' || c.kind === 'cancel') b.classList.add(c.kind);
    b.textContent = String(c.label ?? c.id);
    b.addEventListener('click', () => { sendAction('control', undefined, { id: c.id }); flatMsg.textContent = 'Sent to the table…'; });
    return b;
  }));
  flatPrompt.classList.toggle('hidden', !own || (!notes.length && !controls.length));
  flatPrompt.classList.toggle('active', controls.length > 0); // a move awaiting the player
  flatMsg.textContent = diag.tableConnected === false
    ? 'No table is connected to this session any more (a new table was opened, or the table reloaded). Scan the seat QR on the table again.'
    : seatToken
    ? (hand.length || herd.length
      ? (myTurn
        ? (complete
          ? 'Your turn. Tap a market card above to take it (a camel takes the whole herd), or select cards from your hand and tap market cards to trade; tap a sale below to sell. Each move asks you to confirm.'
          : 'Your turn. Tap a card to raise it with the others of its kind: a number on a raised card sells that many, the ✕ lowers them; tap a market card on the table to trade instead.')
        : (complete ? 'Watch the table. Your cards stay private here.' : 'Your cards stay private here. On your turn, tap a card to raise it with its kind and sell from the numbers; trades happen on the table.'))
      : seatedAs ? 'Waiting for the round to open…' : 'Joining the table…')
    : 'This link has no seat.';
}

function applyScene() {
  renderFlat();
  // Shared table plus this seat's private scene; same id in both = private
  // wins (drawn once, from the private definition).
  const byId = new Map();
  for (const n of normalizeChannel(latestState, 'shared')) byId.set(n.id, n);
  for (const n of normalizeChannel(latestSeatState, 'seat')) byId.set(n.id, n);

  for (const n of byId.values()) {
    let node = cardNodes.get(n.id);
    // Geometry bakes size and kind at build time; rebuild on change.
    if (node && (node.sizeKey !== `${n.wM}x${n.hM}` || node.kind !== n.kind)) {
      disposeNode(node);
      cardNodes.delete(n.id);
      node = null;
    }
    if (!node) {
      node = buildNode(n);
      cardNodes.set(n.id, node);
    }
    // Set slide targets rather than snapping; animateCards glides there, so
    // table-side drags render as smooth motion between ~12Hz state updates.
    node.tx = n.xM;
    node.tz = n.zM;
    node.trot = n.rotY;
    node.peek = n.peek;
    node.own = !!n.own;
    node.faceId = n.faceId ?? null;
    node.backId = n.backId ?? null;
    node.tap = n.tap !== false;
    node.tag = n.tag ?? '';
    if (node.kind === 'card') {
      node.faceUp = n.faceUp;
      updateTarget(node);
    }
    node.halo.visible = !!n.glow;
    if (typeof n.glow === 'string') node.halo.material.color.set(n.glow);
    if ((node.kind === 'stack' || node.kind === 'badge') && node.count !== n.count) {
      node.count = n.count;
      node.badge.material.map = countBadgeTexture(n.count);
      node.badge.material.needsUpdate = true;
    }
  }
  // The game may remove pieces from the table; drop their nodes.
  for (const [id, node] of cardNodes) {
    if (byId.has(id)) continue;
    disposeNode(node);
    cardNodes.delete(id);
  }
}

// ---- Session ---------------------------------------------------------------

let xrSession = null;
let hitTestSource = null;
let imageTrackingActive = false;
// The browser's rating of the tracked image ('trackable' / 'untrackable'), once known.
let trackScore = null;
let placed = false; // fallback-mode manual placement done
let hitValid = false; // latest hit-test produced a usable surface pose
let tableSeen = false; // image tracking has locked at least once this session
let searchHintTimer = null;

const smoothPos = new THREE.Vector3();
const smoothQuat = new THREE.Quaternion();
let declaredWidthM = 0; // tracked-image width the table published
let trackedTargets = []; // per tracked image: { id, region, widthM, heightM, xM, zM } (centre offset from the table centre)
let smoothScale = 1; // layout scale correction from ARCore's measured width
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const raycaster = new THREE.Raycaster();
const tmpOffset = new THREE.Vector3();

const fatal = document.getElementById('fatal');
function note(text) {
  // Progress/failure of the AR start, kept visible (readyCheck rewrites
  // lobbyMsg on every relay message, so this lives in its own element).
  fatal.textContent = text;
  fatal.classList.toggle('hidden', !text);
}

async function enterAR() {
  goBtn.disabled = true;
  let slowTimer = null;
  try {
    if (!latestTracking?.image && !latestTracking?.regions?.length) {
      throw new Error('the table has not published its tracking targets — reload the table page');
    }
    note('Preparing the tracking targets…');
    // Targets. Regions are static patches of the table (jaipur: three
    // columns of the market band, the rows of a player's token rail) that
    // lie where a phone is actually pointed and never change with play;
    // each region's image is the target as it is. Without regions (an
    // older host) the whole screen image is the one target.
    trackedTargets = [];
    const trackedImages = [];
    // The phone takes only the regions for everyone and its own seat's (a
    // player sells on their own rail, never the opponent's).
    const regions = regionsForThisPhone();
    const trackedWidthM = latestTracking.widthM;
    declaredWidthM = trackedWidthM;
    let targetSummary = '';
    if (regions.length) {
      for (const region of regions) {
        try {
          const bitmap = await regionBitmap(region);
          trackedImages.push({ image: bitmap, widthInMeters: region.widthM });
          trackedTargets.push({ id: region.id, region: region.id, widthM: region.widthM, heightM: region.heightM, xM: region.xM, zM: region.zM });
        } catch (err) { console.warn('region skipped', region.id, err); }
      }
      targetSummary = `${trackedTargets.length} targets`;
    }
    if (!trackedTargets.length) {
      if (!latestTracking?.image) throw new Error('the table has not published a tracking image — reload the table page');
      const img = new Image();
      img.src = latestTracking.image;
      await img.decode();
      trackedImages.push({ image: await createImageBitmap(img), widthInMeters: trackedWidthM });
      trackedTargets.push({ id: 'screen', region: 'screen', widthM: trackedWidthM, heightM: trackedWidthM * img.naturalHeight / img.naturalWidth, xM: 0, zM: 0 });
      targetSummary = `whole screen ${img.naturalWidth}×${img.naturalHeight}, ${trackedWidthM.toFixed(2)} m wide`;
    }
    buildTargetOutlines();
    note(`Starting AR session (${targetSummary})…`);
    slowTimer = setTimeout(() => note('Still waiting for Chrome to start the AR session — look for a camera/AR permission prompt, or tap Quit and retry.'), 6000);
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['image-tracking', 'hit-test', 'dom-overlay'],
      trackedImages,
      domOverlay: { root: overlay },
    });
  } catch (err) {
    clearTimeout(slowTimer);
    note(`Could not start AR session: ${err?.name ?? ''} ${err?.message ?? err}`);
    renderJoin();
    return;
  }
  clearTimeout(slowTimer);
  note('');
  const died = new Promise((resolve) => xrSession.addEventListener('end', resolve, { once: true }));

  imageTrackingActive = xrSession.enabledFeatures?.includes('image-tracking') ?? false;
  try { localStorage.setItem('arviewer:image-tracking', imageTrackingActive ? 'yes' : 'no'); } catch { /* ignore */ }
  startDiagReports();
  applyDebugFlags();
  const hitTestAvailable = xrSession.enabledFeatures?.includes('hit-test') ?? true;
  // ARCore grades the target; an 'untrackable' screen capture (too flat /
  // too repetitive) is the usual silent reason for "still searching". The
  // score promise only settles once frames are flowing, so it must NOT be
  // awaited before the render loop starts (that deadlocked the session).
  trackScore = null;

  lobby.classList.add('hidden');
  overlay.classList.remove('hidden');
  setHud(
    imageTrackingActive
      ? 'Searching for the table… (or tap the table surface to place the cards by hand)'
      : hitTestAvailable
        ? 'Image tracking unavailable (enable chrome://flags/#webxr-incubations and relaunch Chrome) — tap the table surface to place the cards.'
        : 'No tracking features available on this device.'
  );
  if (imageTrackingActive) {
    // If the tracker can't find the table, say so instead of staying silent:
    // the usual cause is a stale tracked image (table page changed after this
    // phone received its snapshot).
    searchHintTimer = setTimeout(() => {
      if (!tableSeen) {
        setHud(
          `Still searching (target ${trackScore ?? 'unrated'}, epoch ${latestTracking?.epoch ?? '?'}). ` +
          'Hold the phone face on over the middle of the table, about 40 cm away. If the table shows a newer epoch, exit and re-enter AR — or tap the table surface to place manually.'
        );
      }
    }, 12000);
  }

  xrSession.addEventListener('end', () => {
    stopDiagReports();
    onSessionEndGuide();
    overlay.classList.add('hidden');
    lobby.classList.remove('hidden');
    hitTestSource = null;
    placed = false;
    tableSeen = false;
    smoothScale = 1;
    tableRoot.scale.setScalar(1);
    clearTimeout(searchHintTimer);
    tableRoot.visible = false;
    xrSession = null;
    applyDebugFlags();
    readyCheck(); // back in the lobby: re-enable the button (still seated)
  });
  xrSession.addEventListener('select', onSelect);
  exitBtn.onclick = () => xrSession?.end();
  // Screen lock / app switch: Chrome keeps the immersive session but it
  // never recovers cleanly on return (frozen camera, dead tracking). End it
  // ourselves so the player lands back in the lobby and can re-enter.
  const session = xrSession;
  const bail = (why) => {
    if (xrSession !== session) return;
    note(`AR closed: ${why}. Tap Enter AR to start again.`);
    try { void session.end(); } catch { /* already ending */ }
  };
  session.addEventListener('visibilitychange', () => {
    if (session.visibilityState === 'hidden') bail('the screen locked or the app went to the background');
  });
  const onDocHidden = () => { if (document.visibilityState === 'hidden') bail('the phone was locked'); };
  document.addEventListener('visibilitychange', onDocHidden);
  session.addEventListener('end', () => document.removeEventListener('visibilitychange', onDocHidden), { once: true });

  try {
    await Promise.race([renderer.xr.setSession(xrSession), died.then(() => { throw new Error('the AR session ended during setup'); })]);
  } catch (err) {
    note(`AR session failed: ${err?.message ?? err}`);
    try { await xrSession?.end(); } catch { /* already ended */ }
    return;
  }

  // Manual placement stays available even when image tracking is enabled —
  // if the tracker never locks (poor lighting, stale image), the player can
  // still tap to place; a later real lock simply takes over.
  if (hitTestAvailable) {
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  }

  renderer.setAnimationLoop(onFrame);

  // Guidance: a check the table asked this seat to run starts now (the
  // session is cold, so its first step measures a real first detection);
  // otherwise the ordinary first-lock cue.
  if (regCheck && !regCheck.running) startRegCheck();
  else if (imageTrackingActive) startOnboardGuide();

  if (imageTrackingActive && xrSession.getTrackedImageScores) {
    xrSession.getTrackedImageScores().then((scores) => {
      // One rating per target: the overlay and the reports say how many
      // ARCore accepted, and which it refused.
      arvDiag.scores = scores.map((sc, i) => ({ id: trackedTargets[i]?.id ?? String(i), score: sc }));
      const ok = scores.filter((sc) => sc === 'trackable').length;
      trackScore = `${ok}/${scores.length} trackable`;
      if (ok === 0 && !tableSeen) {
        setHud('ARCore rates every tracking target untrackable (too plain or too small) — reload the table so it recaptures, or tap the table surface to place manually.');
      }
    }).catch(() => { /* unsupported */ });
  }
}

// What a tap does for this viewer: a seated player stages their own cards
// on the table; before the join a phone can only look. (Peeking at hidden sides is
// gone: the table publishes nothing this viewer may not see.)
function playHint() {
  if (seatToken && seatedAs) return 'Tap your cards or camels to stage them for a trade — they glow here and on the table. Tap a market card to look closer; pinch to zoom.';
  return 'Tap a card to look closer; pinch to zoom.';
}

function setHud(text) {
  hud.textContent = text;
}

// ---- Pinch zoom ------------------------------------------------------------
// The passthrough camera can't be magnified in WebXR, so pinching scales the
// revealed (face-up) virtual cards instead — face-down cards stay perfectly
// aligned with their physical counterparts.

let zoomTarget = 1;
let zoomCurrent = 1;
let pinchDist = 0;
let pinchGuardUntil = 0; // suppress the XR select a pinch/drag release fires
let dragX = null;
let dragAccum = 0;

function touchDist(e) {
  const [a, b] = e.touches;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

// A tap on one of the overlay's buttons (Quit AR, the bot offer, the guide's
// Close) is a DOM click only: without this Chrome also fires an XR `select`
// for it, which onSelect would raycast into the cards under the finger.
overlay.addEventListener('beforexrselect', (e) => {
  if (e.target instanceof Element && e.target.closest('button')) e.preventDefault();
});
overlay.addEventListener('touchstart', (e) => {
  if (e.target === exitBtn) return;
  if (e.touches.length === 2) {
    pinchDist = touchDist(e);
    pinchGuardUntil = performance.now() + 400;
  } else if (e.touches.length === 1) {
    dragX = e.touches[0].clientX;
    dragAccum = 0;
  }
});
overlay.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length === 2 && pinchDist > 0) {
      const d = touchDist(e);
      zoomTarget = THREE.MathUtils.clamp(zoomTarget * (d / pinchDist), 1, 3);
      pinchDist = d;
      pinchGuardUntil = performance.now() + 400;
      e.preventDefault();
    } else if (e.touches.length === 1 && dragX !== null && placed && !tableSeen) {
      // Manual-placement fine-tuning: drag horizontally to rotate the
      // placed layout around its center until it lines up with the table.
      const x = e.touches[0].clientX;
      tableRoot.rotateY(-(x - dragX) * 0.005); // about the surface normal
      dragAccum += Math.abs(x - dragX);
      dragX = x;
      if (dragAccum > 12) pinchGuardUntil = performance.now() + 400; // a drag, not a tap
      e.preventDefault();
    }
  },
  { passive: false }
);
overlay.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) pinchDist = 0;
  if (e.touches.length === 0) dragX = null;
});

function onSelect(event) {
  if (performance.now() < pinchGuardUntil) return; // pinch release, not a tap
  const frame = event.frame;
  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getPose(event.inputSource.targetRaySpace, refSpace);
  if (!pose) return;

  // First, try to hit a card.
  if (tableRoot.visible) {
    tmpMat.fromArray(pose.transform.matrix);
    raycaster.ray.origin.setFromMatrixPosition(tmpMat);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(tmpMat));
    const hit = raycaster.intersectObjects(raycastMeshes, false)[0];
    if (hit) {
      const id = hit.object.userData.cardId;
      const node = cardNodes.get(id);
      // The seat's own hand card or camel: the tap stages it on the table
      // (or unstages it) through the host's tabletop intent, exactly like a
      // tap on the table; the host answers by republishing the glow, so the
      // AR view and the table always agree on what is selected.
      if (node?.own) {
        if (node.tap) {
          sendAction('select', id);
          setHud(id.startsWith('sale:')
            ? (id === 'sale:cancel' ? 'Sent to the table — lowering the cards.' : 'Sent to the table — selling.')
            : 'Sent to the table — a glow on the card confirms it is staged; tap again to unstage. A number over a raised card sells that many; the ✕ lowers them.');
        } else {
          setHud(node.tag === 'On table'
            ? 'That card is already placed face-down on the table; take it back from the table.'
            : 'Wait for your turn to stage cards.');
        }
        return;
      }
      // Anything else is reported to the host (it may answer by republishing
      // state) and peeked or inspected locally, gated by the host's per-node
      // peek permission.
      sendAction('tap', id);
      if (node?.kind === 'card' && node.peek) toggleReveal(id);
      else if (node?.kind === 'card') {
        // No hidden side to peek at (e.g. the owner's own hand, already
        // face up): a tap toggles a local magnified "inspect" view instead,
        // so small table cards stay legible. Pinch adjusts the size.
        node.inspected = !node.inspected;
        if (node.inspected && zoomTarget < 1.4) zoomTarget = 2;
      }
      return;
    }
  }

  // Manual placement: until image tracking locks, a tap places (or
  // re-places) the table at the latest surface hit, rotated so the layout
  // faces the player.
  if (!tableSeen && hitValid) {
    placeOnSurface(reticle.matrix, tmpMat.fromArray(pose.transform.matrix));
    setHud(`Placed. Drag sideways to rotate until the cards line up; tap empty space to re-place. ${playHint()}`);
  }
}

// Lay the table flat on the hit surface, whatever its orientation: the hit
// pose's +Y is the surface normal (WebXR hit-test), so a vertical screen
// gets an upright layout instead of one lying on the floor. "Down" on the
// layout (+z, the table's screen-down axis) points toward the floor on a
// vertical surface, and away from the viewer on a horizontal one.
const tmpNormal = new THREE.Vector3();
const tmpDown = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const placeQuat = new THREE.Quaternion();
function placeOnSurface(hitMatrix, viewerMatrix) {
  tableRoot.position.setFromMatrixPosition(hitMatrix);
  tmpNormal.set(0, 1, 0).applyQuaternion(placeQuat.setFromRotationMatrix(hitMatrix)).normalize();
  const vertical = Math.abs(tmpNormal.y) < 0.6;
  if (vertical) tmpDown.set(0, -1, 0);
  else tmpDown.setFromMatrixPosition(viewerMatrix).sub(tableRoot.position).negate();
  // Project the chosen "down" onto the surface plane.
  tmpDown.addScaledVector(tmpNormal, -tmpDown.dot(tmpNormal)).normalize();
  tmpRight.crossVectors(tmpNormal, tmpDown).normalize();
  tableRoot.quaternion.setFromRotationMatrix(tmpMat.makeBasis(tmpRight, tmpNormal, tmpDown));
  tableRoot.visible = true;
  placed = true;
}

// Per-frame tracking diagnostics, readable over DevTools as window.__arvDiag:
// what the image tracker reports each frame, so a "never registers" report
// can be separated into "never detected", "detected but emulated" and
// "detected at the wrong size".
const arvDiag = { frames: 0, results: [], scores: [], tracked: 0, emulated: 0, untracked: 0, tableSeen: false, imageTrackingActive: false, trackScore: null, epoch: null, declaredWidthM: 0, lastMeasuredWidthM: 0, lastResultAt: 0, lastTarget: -1, lastScale: 1 };
window.__arvDiag = arvDiag;

// Every two seconds in AR the phone tells the table how registration is
// going (a small `diag` action, fire-and-forget over the relay): counts
// since the last report, the state right now, which target it registered
// from and how the measured size compares with the declared one. The
// table shows a dot on the mat and a summary in its options panel.
// Where the phone is and how it moves, for the table's background adapter
// (jaipur docs/BACKGROUND-ADAPTATION.md): a phone lying on the table —
// camera straight down into the cloth or straight up at the ceiling, and
// not moving — reports no tracking, and that must not count as evidence
// about the screen's brightness. Each report carries the camera's pitch
// (degrees of its forward axis above the horizon: about −30…−70 held over
// the table, −90 face-up on it, +90 face-down) and the farthest the camera
// got, in metres and degrees, from where it was at the start of the
// interval (net excursion, so pose jitter at rest stays near zero).
const viewerMotion = { startPos: null, startFwd: null, moved: 0, turned: 0, pitch: null, frames: 0 };
const poseFwd = new THREE.Vector3(), posePos = new THREE.Vector3();
function noteViewerPose(frame, refSpace) {
  const vp = frame.getViewerPose?.(refSpace);
  if (!vp) return;
  const m = vp.transform.matrix;
  poseFwd.set(-m[8], -m[9], -m[10]).normalize(); // the view looks down its −Z; +Y is up
  posePos.set(m[12], m[13], m[14]);
  viewerMotion.pitch = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, poseFwd.y))));
  if (!viewerMotion.startPos) { viewerMotion.startPos = posePos.clone(); viewerMotion.startFwd = poseFwd.clone(); }
  viewerMotion.moved = Math.max(viewerMotion.moved, posePos.distanceTo(viewerMotion.startPos));
  viewerMotion.turned = Math.max(viewerMotion.turned, THREE.MathUtils.radToDeg(viewerMotion.startFwd.angleTo(poseFwd)));
  viewerMotion.frames += 1;
}
function takeViewerMotion() {
  const had = viewerMotion.frames > 0;
  const out = had
    ? { pitch: Math.round(viewerMotion.pitch), moved: Number(viewerMotion.moved.toFixed(3)), turned: Number(viewerMotion.turned.toFixed(1)) }
    : { pitch: null, moved: null, turned: null };
  viewerMotion.startPos = null; viewerMotion.startFwd = null; viewerMotion.moved = 0; viewerMotion.turned = 0; viewerMotion.frames = 0;
  return out;
}
const DIAG_REPORT_MS = 2000;
let diagTimer = null;
let diagPrev = { frames: 0, tracked: 0, emulated: 0, at: 0 };
function reportDiag(final = false) {
  const now = performance.now();
  const dtMs = Math.max(1, now - (diagPrev.at || now - DIAG_REPORT_MS));
  const frames = arvDiag.frames - diagPrev.frames;
  const tracked = arvDiag.tracked - diagPrev.tracked;
  const emulated = arvDiag.emulated - diagPrev.emulated;
  diagPrev = { frames: arvDiag.frames, tracked: arvDiag.tracked, emulated: arvDiag.emulated, at: now };
  const sinceResult = arvDiag.lastResultAt ? Date.now() - arvDiag.lastResultAt : null;
  const state = final ? 'ended' : !imageTrackingActive ? 'no-tracking' : sinceResult != null && sinceResult < 1500 ? (tracked > 0 ? 'tracked' : 'emulated') : arvDiag.tableSeen ? 'lost' : 'searching';
  sendAction('diag', undefined, {
    state, frames, tracked, emulated, fps: Math.round((frames * 1000) / dtMs),
    seen: arvDiag.tableSeen, score: arvDiag.trackScore, epoch: arvDiag.epoch,
    untrackable: arvDiag.scores.filter((x) => x.score !== 'trackable').map((x) => x.id),
    target: arvDiag.lastTarget, targetId: trackedTargets[arvDiag.lastTarget]?.id ?? null, targets: trackedTargets.length,
    scale: Number(arvDiag.lastScale.toFixed(3)), sinceResultMs: sinceResult,
    ...takeViewerMotion(),
  });
}
function startDiagReports() {
  stopDiagReports();
  diagPrev = { frames: arvDiag.frames, tracked: arvDiag.tracked, emulated: arvDiag.emulated, at: performance.now() };
  diagTimer = setInterval(() => reportDiag(false), DIAG_REPORT_MS);
}
function stopDiagReports() {
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null; reportDiag(true); }
}

// ---- Targets -----------------------------------------------------------------
// A region's image is the tracked image as it is: the host captures a
// static patch of its screen (jaipur: cloth columns of the market band,
// rows of a token rail) with everything play-varying left out. Pieces
// that later lie over the patch on screen are occlusion the tracker
// tolerates, so nothing here depends on the scene and the targets stay
// valid for the whole game (WebXR fixes them at session start anyway).
const regionBitmaps = new Map(); // region id + image length -> ImageBitmap
async function regionBitmap(region) {
  const key = `${region.id}:${region.mat.length}`;
  let bitmap = regionBitmaps.get(key);
  if (!bitmap) {
    const mat = new Image();
    mat.src = region.mat;
    await mat.decode();
    bitmap = await createImageBitmap(mat);
    regionBitmaps.set(key, bitmap);
  }
  return bitmap;
}
function regionsForThisPhone() {
  return (latestTracking?.regions ?? []).filter((r) => r && (r.seat == null || !seatToken || String(r.seat) === String(seatToken)));
}
window.__arvCompose = async () => {
  // DevTools/test hook: this phone's targets as data URLs.
  const out = [];
  for (const region of regionsForThisPhone()) {
    const bitmap = await regionBitmap(region);
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    out.push({ id: region.id, seat: region.seat ?? null, width: c.width, height: c.height, widthM: region.widthM, heightM: region.heightM, url: c.toDataURL('image/jpeg', 0.8) });
  }
  return out;
};

// ---- Diagnostics: target outlines and the numbers overlay -----------------
// "Show AR tracking targets" (Table options) draws each tracking target
// where the layout believes it lies: a flat frame on the table plane,
// blue for the whole screen (target 0), pink for a patch, turning green
// while the tracker sees that target this frame and amber while it only
// extrapolates ('emulated'). A wedge marks the top-left corner, so a
// mirrored or rotated registration is obvious. They live in tableRoot, so
// they move and scale with the cards.
const TARGET_COLORS = { region: 0xd6336c, tracked: 0x2f9e44, emulated: 0xe0a100 };
const targetsGroup = new THREE.Group();
targetsGroup.visible = false;
tableRoot.add(targetsGroup);
let regionOutlines = new Map(); // region id -> mesh

function buildTargetOutlines() {
  for (const m of regionOutlines.values()) { targetsGroup.remove(m); m.geometry.dispose(); m.material.dispose(); }
  regionOutlines = new Map();
  for (const t of trackedTargets) {
    if (regionOutlines.has(t.region)) continue;
    const w = t.widthM, h = t.heightM || t.widthM;
    const b = Math.max(0.004, Math.min(w, h) * 0.02); // frame thickness
    const shape = new THREE.Shape([new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2), new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2)]);
    shape.holes.push(new THREE.Path([new THREE.Vector2(-w / 2 + b, -h / 2 + b), new THREE.Vector2(w / 2 - b, -h / 2 + b), new THREE.Vector2(w / 2 - b, h / 2 - b), new THREE.Vector2(-w / 2 + b, h / 2 - b)]));
    // Corner wedge: top-left of the region (−x, −z on the table).
    const wedge = Math.min(w, h) * 0.12;
    const corner = new THREE.Shape([new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(-w / 2 + wedge, -h / 2), new THREE.Vector2(-w / 2, -h / 2 + wedge)]);
    const geo = new THREE.ShapeGeometry([shape, corner]);
    geo.rotateX(Math.PI / 2); // shape y → table z (screen-down), laid flat
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: TARGET_COLORS.region, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    }));
    mesh.renderOrder = 90;
    mesh.position.set(t.xM, 0.003, t.zM);
    targetsGroup.add(mesh);
    regionOutlines.set(t.region, mesh);
  }
}

function colorTargetOutlines(results) {
  if (!targetsGroup.visible) return;
  const best = new Map(); // region -> 'tracked' | 'emulated'
  for (const r of results) {
    const t = trackedTargets[r.index];
    if (!t || r.trackingState === 'untracked') continue;
    if (r.trackingState === 'tracked' || !best.has(t.region)) best.set(t.region, r.trackingState);
  }
  for (const [region, mesh] of regionOutlines) {
    const st = best.get(region);
    mesh.material.color.set(st === 'tracked' ? TARGET_COLORS.tracked : st === 'emulated' ? TARGET_COLORS.emulated : TARGET_COLORS.region);
    mesh.material.opacity = st === 'tracked' ? 1 : st === 'emulated' ? 0.9 : 0.55;
  }
}

// "Show AR diagnostics": the same numbers the phone reports to the table,
// live on the phone (DOM overlay, refreshed a few times a second).
const diagEl = document.getElementById('diag');
let diagShownAt = 0;
let fpsFrames = 0, fpsAt = 0, fpsValue = 0;
function applyDebugFlags() {
  targetsGroup.visible = debugFlags.targets;
  diagEl.classList.toggle('hidden', !debugFlags.diag || !xrSession);
}
function renderDiagOverlay(now) {
  fpsFrames += 1;
  if (now - fpsAt >= 1000) { fpsValue = Math.round((fpsFrames * 1000) / (now - fpsAt)); fpsFrames = 0; fpsAt = now; }
  if (!debugFlags.diag || now - diagShownAt < 250) return;
  diagShownAt = now;
  const counts = { tracked: 0, emulated: 0, untracked: 0 };
  for (const r of arvDiag.results) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const t = trackedTargets[arvDiag.lastTarget];
  const measured = arvDiag.lastMeasuredWidthM;
  const since = arvDiag.lastResultAt ? Date.now() - arvDiag.lastResultAt : null;
  const state = !imageTrackingActive ? 'no-tracking' : since != null && since < 1500 ? (counts.tracked ? 'tracked' : 'emulated') : tableSeen ? 'lost' : 'searching';
  const dist = tableRoot.visible ? camera.position.distanceTo(tableRoot.position) : null;
  diagEl.textContent = [
    `state ${state} · ${fpsValue} fps · frame ${arvDiag.frames}`,
    `this frame: ${counts.tracked} tracked · ${counts.emulated} emulated · ${counts.untracked} untracked (of ${trackedTargets.length})`,
    `totals: tracked ${arvDiag.tracked} · emulated ${arvDiag.emulated} · untracked ${arvDiag.untracked}`,
    `target ${t ? t.id : 'none yet'} of ${trackedTargets.length}` +
      (t ? ` · declared ${t.widthM.toFixed(3)} m · measured ${measured ? measured.toFixed(3) : '—'} m` : ''),
    `scale ×${arvDiag.lastScale.toFixed(3)} · images ${trackScore ?? 'unrated'} · epoch ${latestTracking?.epoch ?? '?'}`,
    arvDiag.scores.some((x) => x.score !== 'trackable') ? `untrackable: ${arvDiag.scores.filter((x) => x.score !== 'trackable').map((x) => x.id).join(' ')}` : '',
    `seen ${tableSeen ? 'yes' : 'no'} · placed ${placed ? 'manual' : 'no'} · last result ${since == null ? '—' : `${since} ms ago`}`,
    dist != null ? `table ${dist.toFixed(2)} m from the camera` : 'table not shown',
    viewerMotion.pitch != null ? `pitch ${Math.round(viewerMotion.pitch)}° · moved ${viewerMotion.moved.toFixed(3)} m · turned ${viewerMotion.turned.toFixed(1)}° this interval` : '',
  ].filter(Boolean).join('\n');
}

function updateTracking(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  noteViewerPose(frame, refSpace);
  arvDiag.frames += 1;
  arvDiag.tableSeen = tableSeen;
  arvDiag.imageTrackingActive = imageTrackingActive;
  arvDiag.trackScore = trackScore ?? null;
  arvDiag.epoch = latestTracking?.epoch ?? null;
  arvDiag.declaredWidthM = declaredWidthM;

  if (imageTrackingActive && frame.getImageTrackingResults) {
    const results = frame.getImageTrackingResults();
    arvDiag.results = results.map((r) => ({ index: r.index, state: r.trackingState, widthM: r.measuredWidthInMeters }));
    colorTargetOutlines(results);
    regCheckFrame(results);
    for (const r of results) {
      if (r.trackingState === 'tracked') { arvDiag.tracked += 1; arvDiag.lastMeasuredWidthM = r.measuredWidthInMeters; arvDiag.lastResultAt = Date.now(); arvDiag.lastTarget = r.index; }
      else if (r.trackingState === 'emulated') { arvDiag.emulated += 1; arvDiag.lastResultAt = Date.now(); }
      else arvDiag.untracked += 1;
    }
    // Prefer a directly tracked target over an emulated one, and among
    // those the widest (the most reliable pose); one result per frame.
    const usable = results.filter((r) => r.trackingState !== 'untracked' && trackedTargets[r.index]);
    usable.sort((a, b) => (a.trackingState === b.trackingState ? trackedTargets[b.index].widthM - trackedTargets[a.index].widthM : a.trackingState === 'tracked' ? -1 : 1));
    for (const result of usable.slice(0, 1)) {
      const target = trackedTargets[result.index];
      const pose = frame.getPose(result.imageSpace, refSpace);
      if (!pose) continue;
      tmpMat.fromArray(pose.transform.matrix);
      tmpMat.decompose(tmpPos, tmpQuat, tmpScale);
      // The target's centre sits at (xM, zM) from the table centre in the
      // table's own axes, which the target shares: step back by that offset
      // along the target's axes to land on the table origin.
      if (target.xM || target.zM) tmpPos.add(tmpOffset.set(-target.xM, 0, -target.zM).applyQuaternion(tmpQuat));
      if (!tableSeen) {
        smoothPos.copy(tmpPos);
        smoothQuat.copy(tmpQuat);
        tableSeen = true;
        clearTimeout(searchHintTimer);
        setHud(`Locked onto the table. ${playHint()}`);
      } else {
        // Trust direct sightings aggressively — the overlay should snap to
        // the observed pixels. 'emulated' results are ARCore extrapolating
        // while the table is out of view; barely move on those, since they
        // drift and are the main source of steady misplacement.
        const alpha = result.trackingState === 'tracked' ? 0.7 : 0.05;
        smoothPos.lerp(tmpPos, alpha);
        smoothQuat.slerp(tmpQuat, alpha);
      }
      // ARCore measures the physical size of the tracked image; use it to
      // correct the layout scale, so a slightly wrong screen-diagonal
      // setting on the table can't offset the outer cards.
      if (result.trackingState === 'tracked' && result.measuredWidthInMeters > 0 && target.widthM > 0) {
        const corr = THREE.MathUtils.clamp(result.measuredWidthInMeters / target.widthM, 0.7, 1.4);
        smoothScale = THREE.MathUtils.lerp(smoothScale, corr, 0.2);
        arvDiag.lastScale = smoothScale;
        tableRoot.scale.setScalar(smoothScale);
      }
      tableRoot.position.copy(smoothPos);
      tableRoot.quaternion.copy(smoothQuat);
      tableRoot.visible = true;
    }
  }

  if (hitTestSource) {
    // Keep hit-testing even after placement so a tap on empty space can
    // always re-place; the reticle only shows before the first placement.
    const hits = frame.getHitTestResults(hitTestSource);
    hitValid = hits.length > 0;
    if (hitValid) reticle.matrix.fromArray(hits[0].getPose(refSpace).transform.matrix);
    reticle.visible = hitValid && !placed && !tableSeen;
  } else {
    hitValid = false;
    reticle.visible = false;
  }
}

function animateCards(dt, t) {
  zoomCurrent += (zoomTarget - zoomCurrent) * Math.min(1, dt * 10);
  const slide = Math.min(1, dt * 12);
  for (const node of cardNodes.values()) {
    // Glide toward the latest published position/rotation.
    node.group.position.x += (node.tx - node.group.position.x) * slide;
    node.group.position.z += (node.tz - node.group.position.z) * slide;
    let dr = node.trot - node.group.rotation.y;
    dr = ((dr + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    node.group.rotation.y += dr * slide;
    const diff = node.target - node.current;
    if (Math.abs(diff) > 1e-3) {
      node.current += diff * Math.min(1, dt * 6);
    } else {
      node.current = node.target;
    }
    node.flip.rotation.x = node.current;
    // Pinch zoom applies to the cards this viewer has flipped to inspect.
    const scaleGoal = node.flipped || node.inspected ? zoomCurrent : 1;
    const scale = THREE.MathUtils.lerp(node.flip.scale.x, scaleGoal, Math.min(1, dt * 10));
    node.flip.scale.setScalar(scale);
    // The card sits directly on top of its physical counterpart; it lifts
    // mid-flip so the animation doesn't clip through the table (flip angle
    // runs 0..PI, so sin peaks mid-flip), and rises slightly as it's zoomed
    // so an enlarged card floats above its unrevealed neighbors.
    const flipLift = Math.sin(THREE.MathUtils.clamp(node.current, 0, Math.PI)) * 0.05;
    node.group.position.y = 0.001 + node.zBias + flipLift + (scale - 1) * 0.02;
  }
}

let lastT = 0;
function onFrame(timeMs, frame) {
  const t = timeMs / 1000;
  const dt = Math.min(0.05, t - lastT || 0.016);
  lastT = t;
  if (frame) updateTracking(frame);
  renderDiagOverlay(timeMs);
  renderGuide(timeMs);
  animateCards(dt, t);
  renderer.render(scene, camera);
  if (shotRequested) { const label = shotRequested; shotRequested = null; captureShot(label); }
}

// ---- Probe (see the note by diagLine) --------------------------------------
let shotRequested = null; // a step id: render the virtual layer after this frame
const shots = {}; // step id -> { at, w, h, jpeg, camera } (the last check's)
function nodeScreenList() {
  const v = new THREE.Vector3();
  return [...cardNodes.entries()].map(([id, node]) => {
    node.group.getWorldPosition(v);
    const world = [v.x, v.y, v.z].map((x) => +x.toFixed(3));
    const p = v.project(camera);
    const front = node.flip.children[0]?.material?.map;
    const back = node.flip.children[1]?.material?.map;
    return {
      id, own: !!node.own, kind: node.kind, faceUp: node.faceUp, flipped: !!node.flipped, flip: +(node.current ?? 0).toFixed(2),
      faceId: node.faceId ?? null, backId: node.backId ?? null,
      frontTex: textureStatus.get(node.faceId)?.loaded ?? (front?.image ? true : false), backTex: textureStatus.get(node.backId)?.loaded ?? (back?.image ? true : false),
      visible: node.group.visible && tableRoot.visible, scale: +node.flip.scale.x.toFixed(2), glow: node.halo.visible,
      world, screen: [Math.round(((p.x + 1) / 2) * 100), Math.round(((1 - p.y) / 2) * 100)], depth: +p.z.toFixed(3),
      onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1,
    };
  });
}
function buildProbe() {
  const session = renderer.xr.getSession?.() ?? null;
  const layer = session?.renderState?.baseLayer ?? null;
  let gl = {};
  try {
    const ctx = renderer.getContext();
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    gl = { version: ctx.getParameter(ctx.VERSION), renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null, maxTexture: renderer.capabilities.maxTextureSize, lost: ctx.isContextLost() };
  } catch (err) { gl = { error: String(err?.message ?? err) }; }
  const assetsOf = (set) => Object.fromEntries(Object.entries(set ?? {}).map(([id, a]) => [id, { bytes: a?.img?.length ?? 0, kind: typeof a?.img === 'string' ? a.img.slice(5, a.img.indexOf(';')) : typeof a?.img, wM: a?.wM ?? null, hM: a?.hM ?? null, texture: textureStatus.get(id) ?? null }]));
  const seatNodes = (latestSeatState?.nodes ?? []).map((n) => ({ id: n.id, kind: n.kind, faceUp: n.faceUp, peek: n.peek, face: n.face, back: n.back, tap: n.tap, tag: n.tag, glow: n.glow, xM: n.xM, zM: n.zM, rotY: n.rotY }));
  const camPos = new THREE.Vector3(); camera.getWorldPosition(camPos);
  const textures = [...textureStatus.values()];
  return {
    at: new Date().toISOString(), line: diagLine(), diag: { ...diag }, debugFlags: { targets: debugFlags.targets, diag: debugFlags.diag },
    session: sessionId, seatToken, seatedAs, joinRequested, href: location.href.replace(/([?&]relay=)[^&]*/, '$1…'),
    xr: { active: Boolean(xrSession), presenting: renderer.xr.isPresenting, layerPath: session ? (session.renderState?.baseLayer ? 'XRWebGLLayer' : 'projection-layer') : null, forceBaseLayer, imageTracking: imageTrackingActive, features: session?.enabledFeatures ?? null, framebuffer: layer ? [layer.framebufferWidth, layer.framebufferHeight] : null, pixelRatio: devicePixelRatio, viewport: [innerWidth, innerHeight], flat: flatActive },
    tracking: { tableSeen, placed, targets: trackedTargets.length, epoch: latestTracking?.epoch ?? null, score: trackScore ?? null, frames: arvDiag.frames, tracked: arvDiag.tracked, emulated: arvDiag.emulated, untracked: arvDiag.untracked, lastScale: +arvDiag.lastScale.toFixed(3), lastTarget: trackedTargets[arvDiag.lastTarget]?.id ?? null, lastResultAgoMs: arvDiag.lastResultAt ? Date.now() - arvDiag.lastResultAt : null },
    shared: { nodes: latestState?.nodes?.length ?? null, nodeKinds: (latestState?.nodes ?? []).reduce((a, n) => ((a[String(n.id).split(':')[0]] = (a[String(n.id).split(':')[0]] ?? 0) + 1), a), {}), assets: assetsOf(sharedAssets) },
    seat: { player: latestSeatState?.player ?? null, turn: latestSeatState?.turn ?? null, notes: latestSeatState?.notes ?? null, controls: latestSeatState?.controls ?? null, nodes: seatNodes, assets: Object.keys(seatAssets ?? {}) },
    scene3d: { tableRootVisible: tableRoot.visible, tableRootScale: +tableRoot.scale.x.toFixed(3), tableRootPos: [tableRoot.position.x, tableRoot.position.y, tableRoot.position.z].map((x) => +x.toFixed(3)), camera: [camPos.x, camPos.y, camPos.z].map((x) => +x.toFixed(3)), cardNodes: cardNodes.size, raycastMeshes: raycastMeshes.length, nodes: nodeScreenList() },
    textures: { total: textures.length, loaded: textures.filter((t) => t.loaded).length, failed: textures.filter((t) => t.error).length, pending: textures.filter((t) => !t.loaded && !t.error).length },
    errors: probeErrors.slice(),
    gl,
  };
}
// Render the virtual layer alone (no camera image: the passthrough is composited
// by the device) from the current pose into a small offscreen target, so what
// the phone draws, and where, can be seen remotely.
function captureShot(label) {
  const prevTarget = renderer.getRenderTarget();
  const prevXr = renderer.xr.enabled;
  let rt = null;
  try {
    const session = renderer.xr.getSession?.();
    const layer = session?.renderState?.baseLayer;
    const aspect = layer ? layer.framebufferHeight / layer.framebufferWidth : renderer.domElement.height / Math.max(1, renderer.domElement.width);
    const W = 288, H = Math.max(96, Math.round(W * (aspect || 1.8)));
    rt = new THREE.WebGLRenderTarget(W, H);
    renderer.xr.enabled = false; // render our own camera (holding the XR pose) instead of the XR views
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x1e1e1e, 1);
    renderer.clear();
    renderer.render(scene, camera);
    const buf = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4); // GL rows are bottom-up
    ctx.putImageData(img, 0, 0);
    shots[label] = { at: new Date().toISOString(), w: W, h: H, jpeg: c.toDataURL('image/jpeg', 0.6), nodes: nodeScreenList() };
  } catch (err) {
    shots[label] = { at: new Date().toISOString(), error: String(err?.message ?? err) };
    noteError('shot', `${label}: ${err?.message ?? err}`);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    renderer.setClearColor(0x000000, 0);
    rt?.dispose();
  }
  return shots[label];
}
window.__arvProbe = buildProbe; // DevTools/test hooks
window.__arvShot = captureShot;

// ---- Guidance: first-lock cue and the registration check ------------------
// Everything a tester (or a player) must do is said on the PHONE, with a
// countdown, and every transition buzzes: the table has no keyboard, and
// a hand holding a phone on target cannot also reach for the screen. The
// same panel serves two modes:
//  - 'onboard': every AR session opens with "point across the table at the
//    middle of the market" until the first lock (detection needs a band
//    column to fill a quarter of the frame; over the player's own cards it
//    is mostly hidden under the prompt and the market cards — measured
//    2026-10-06: no detection in 17 s from the hand, lock in ~1 s from the
//    market, then 100% tracked back over the hand).
//  - 'regcheck': the table (Table options → Registration check → Player N)
//    publishes state.debug.regcheck = {seat, id}; the seat's phone restarts
//    AR cold and walks through REG_STEPS, measuring time to first lock,
//    tracked share over the hand and the rail, and re-lock time, then
//    reports `regcheck` actions (running/done/aborted) the table shows.
//    ?debug=regcheck runs it standalone at the next AR start.
const guideEl = document.getElementById('guide');
const guideStepEl = document.getElementById('guideStep');
const guideTitleEl = document.getElementById('guideTitle');
const guideTextEl = document.getElementById('guideText');
const guideCountEl = document.getElementById('guideCount');
const guideLiveEl = document.getElementById('guideLive');
const guideListEl = document.getElementById('guideList');
const guideCloseBtn = document.getElementById('guideClose');
const armedEl = document.getElementById('armed');

const REG_STEPS = [
  { id: 'lock', title: 'Find the table', text: 'Point across the table at the middle of the market, about an arm’s length away. Hold there until it locks.', maxMs: 30000, until: 'lock' },
  { id: 'hand', title: 'Your cards', text: 'Now hold the phone over your own cards, as if reading your hand. Keep it there.', maxMs: 15000 },
  { id: 'rail', title: 'Your coins', text: 'Point at your token rail — the coins and goods beside your mat.', maxMs: 10000 },
  { id: 'away', title: 'Look away', text: 'Point the phone at the floor, away from the table.', maxMs: 5000 },
  { id: 'back', title: 'Back to your cards', text: 'Return to your own cards and hold still. How fast does it re-lock?', maxMs: 10000, until: 'tracked' },
];
const REG_LABELS = { lock: 'first lock from the market', hand: 'over the hand', rail: 'over the rail', away: 'looking away', back: 're-lock over the hand' };

let guideMode = null; // 'onboard' | 'regcheck' | 'summary' | null
let guideShownAt = 0;
let onboardLockedAt = 0;
let regCheck = null; // { id, seat, running, done, stepIndex, step, steps[] }
let regCheckLastId = null;
const vibrate = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } };

function showGuide(mode, { step = '', title = '', text = '', cls = '' } = {}) {
  guideMode = mode;
  guideEl.className = cls;
  guideStepEl.textContent = step;
  guideTitleEl.textContent = title;
  guideTextEl.textContent = text;
  guideCountEl.textContent = '';
  guideLiveEl.textContent = '';
  guideListEl.classList.add('hidden');
  guideListEl.replaceChildren();
  guideCloseBtn.classList.add('hidden');
}
function hideGuide() {
  guideMode = null;
  guideEl.classList.add('hidden');
}

function startOnboardGuide() {
  onboardLockedAt = 0;
  showGuide('onboard', { title: 'Find the table', text: 'Point across the table at the middle of the market, about an arm’s length away. Once it locks you can look at your own cards.', cls: 'searching' });
  guideLiveEl.textContent = 'searching…';
}

// The table asked a seat to run the check (state.debug.regcheck), or
// ?debug=regcheck asked for one at the next AR start.
function onRegCheckFlag() {
  const rc = debugFlags.regcheck;
  if (!rc || typeof rc !== 'object' || !rc.id || rc.id === regCheckLastId) return;
  if (rc.seat != null && String(rc.seat) !== String(seatToken ?? '')) return; // another seat's check
  regCheckLastId = rc.id;
  armRegCheck({ id: String(rc.id), seat: rc.seat != null ? String(rc.seat) : null });
}
function armRegCheck({ id, seat }) {
  regCheck = { id, seat, running: false, done: false, stepIndex: -1, step: null, steps: [] };
  sendRegCheck('armed');
  const who = seat ? `Player ${seat}` : 'this phone';
  armedEl.textContent = `Registration check for ${who} is ready — tap Enter AR to begin. The phone will tell you where to point and for how long.`;
  armedEl.classList.remove('hidden');
  vibrate([40, 60, 40]);
  if (xrSession) {
    // A cold session is the point of the first step: leave this one.
    setHud('Registration check requested — leaving AR so it can start cold. Tap Enter AR to begin.');
    setTimeout(() => { try { xrSession?.end(); } catch { /* ending */ } }, 1200);
  }
}
function startRegCheck() {
  armedEl.classList.add('hidden');
  for (const k of Object.keys(shots)) delete shots[k]; // a fresh check, fresh pictures
  regCheck.running = true;
  regCheck.startedAt = performance.now();
  beginRegStep(0);
}
function beginRegStep(i) {
  const now = performance.now();
  if (i >= REG_STEPS.length) { finishRegCheck(); return; }
  const def = REG_STEPS[i];
  regCheck.stepIndex = i;
  regCheck.step = { id: def.id, def, startAt: now, frames: 0, tracked: 0, emulated: 0, targets: new Set(), lockMs: null, firstTrackedMs: null, endAt: null, ms: null, timedOut: false };
  // Already locked when a 'lock' step starts (should not happen cold): say so.
  if (def.until === 'lock' && tableSeen) { regCheck.step.lockMs = 0; regCheck.step.endAt = now + 1500; }
  showGuide('regcheck', { step: `Registration check · step ${i + 1} of ${REG_STEPS.length}`, title: def.title, text: def.text, cls: def.until ? 'searching' : '' });
  vibrate(i === 0 ? [60] : [60, 80, 60]);
  sendRegCheck('running');
}
function regStepSummary(st) {
  return { id: st.id, ms: st.ms == null ? null : Math.round(st.ms), frames: st.frames, tracked: st.tracked, emulated: st.emulated, lockMs: st.lockMs == null ? null : Math.round(st.lockMs), firstTrackedMs: st.firstTrackedMs == null ? null : Math.round(st.firstTrackedMs), targets: [...st.targets], timedOut: st.timedOut };
}
// Per frame while a step runs: count sightings, decide when the step ends.
function regCheckFrame(results) {
  if (!regCheck?.running || !regCheck.step) return;
  const st = regCheck.step, now = performance.now();
  st.frames += 1;
  let tracked = false, emulated = false;
  for (const r of results) {
    if (r.trackingState === 'tracked') { tracked = true; const t = trackedTargets[r.index]; if (t) st.targets.add(t.id); }
    else if (r.trackingState === 'emulated') emulated = true;
  }
  if (tracked) { st.tracked += 1; if (st.firstTrackedMs == null) st.firstTrackedMs = now - st.startAt; }
  else if (emulated) st.emulated += 1;
  if (st.def.until === 'lock' && st.lockMs == null && tableSeen) { st.lockMs = now - st.startAt; st.endAt = now + 1500; vibrate([30]); }
  if (st.def.until === 'tracked' && st.endAt == null && st.firstTrackedMs != null) { st.endAt = now + 1500; vibrate([30]); }
  const elapsed = now - st.startAt;
  if (st.endAt == null && elapsed >= st.def.maxMs) { st.endAt = now; st.timedOut = Boolean(st.def.until); }
  if (st.endAt != null && now >= st.endAt) {
    st.ms = now - st.startAt;
    if (st.id === 'hand' || st.id === 'back') shotRequested = st.id; // what the phone draws over the hand, rendered after this frame
    regCheck.steps.push(regStepSummary(st));
    beginRegStep(regCheck.stepIndex + 1);
  }
}
function finishRegCheck() {
  regCheck.running = false;
  regCheck.done = true;
  regCheck.step = null;
  vibrate([80, 60, 80, 60, 160]);
  // The last step's shot is rendered after this frame: let it land in the report.
  if (shotRequested) setTimeout(() => sendRegCheck('done'), 0); else sendRegCheck('done');
  showGuide('summary', { step: 'Registration check · done', title: 'Results sent to the table', cls: 'ok' });
  guideListEl.replaceChildren(...regCheck.steps.map((st) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    const pct = st.frames ? Math.round((100 * st.tracked) / st.frames) : 0;
    let value, bad = false;
    if (st.id === 'lock') { value = st.lockMs == null ? 'no lock' : st.lockMs === 0 ? 'already locked' : `${(st.lockMs / 1000).toFixed(1)} s`; bad = st.lockMs == null; }
    else if (st.id === 'back') { value = st.firstTrackedMs == null ? 'no re-lock' : `${(st.firstTrackedMs / 1000).toFixed(1)} s`; bad = st.firstTrackedMs == null; }
    else if (st.id === 'away') { value = `${st.emulated ? 'held' : 'dropped'}`; }
    else { value = `${pct}% tracked`; bad = pct < 50; }
    b.textContent = value;
    li.append(`${REG_LABELS[st.id] ?? st.id}: `, b, st.targets.length ? ` (${st.targets.join(', ')})` : '');
    if (bad) li.classList.add('bad');
    return li;
  }));
  guideListEl.classList.remove('hidden');
  guideCloseBtn.classList.remove('hidden');
  guideCloseBtn.onclick = () => { hideGuide(); regCheck = null; };
  setTimeout(() => { if (guideMode === 'summary') { hideGuide(); regCheck = null; } }, 45000);
}
function sendRegCheck(status) {
  if (!regCheck) return;
  const st = regCheck.step;
  // The finished report carries what a tuning pass needs to interpret it:
  // which targets this phone had and their declared sizes, ARCore's
  // ratings, the device, and the whole run's duration.
  const final = status === 'done' || status === 'aborted';
  sendAction('regcheck', undefined, {
    id: regCheck.id, seat: regCheck.seat, status,
    step: regCheck.stepIndex, stepId: st?.id ?? null, stepTitle: st?.def.title ?? null, totalSteps: REG_STEPS.length,
    steps: regCheck.steps, score: trackScore ?? null, epoch: latestTracking?.epoch ?? null, targets: trackedTargets.length,
    probe: buildProbe(),
    ...(final ? {
      shots: { ...shots },
      totalMs: regCheck.startedAt ? Math.round(performance.now() - regCheck.startedAt) : null,
      layout: { widthM: latestTracking?.widthM ?? null, targets: trackedTargets.map((t) => ({ id: t.id, widthM: +t.widthM.toFixed(3), heightM: +(t.heightM ?? 0).toFixed(3), xM: +t.xM.toFixed(3), zM: +t.zM.toFixed(3) })) },
      ratings: arvDiag.scores, scale: Number(arvDiag.lastScale.toFixed(3)), measuredWidthM: Number(arvDiag.lastMeasuredWidthM.toFixed(3)),
      device: { ua: navigator.userAgent, screen: `${screen.width}x${screen.height}@${devicePixelRatio}` },
    } : {}),
  });
}
function onSessionEndGuide() {
  if (regCheck?.running) { sendRegCheck('aborted'); regCheck = null; }
  else if (regCheck?.done) regCheck = null;
  hideGuide();
  if (regCheck && !regCheck.running) armedEl.classList.remove('hidden'); // still armed: the lobby says so
}
// A few times a second: countdown, live tracking line, mode transitions.
function renderGuide(now) {
  if (!guideMode || now - guideShownAt < 200) return;
  guideShownAt = now;
  guideEl.classList.remove('hidden');
  if (guideMode === 'onboard') {
    if (!tableSeen && !placed) return;
    if (!onboardLockedAt) {
      onboardLockedAt = now;
      guideEl.className = 'ok';
      guideTitleEl.textContent = tableSeen ? 'Locked on' : 'Placed by hand';
      guideTextEl.textContent = tableSeen ? 'Now look at your own cards. If the cards drift, glance back at the market.' : 'Image tracking did not lock; the layout sits where you tapped. Drag sideways to turn it.';
      guideLiveEl.textContent = '';
      vibrate([40]);
    } else if (now - onboardLockedAt > 3500) hideGuide();
    return;
  }
  if (guideMode === 'regcheck' && regCheck?.step) {
    const st = regCheck.step;
    const left = Math.max(0, Math.ceil((st.def.maxMs - (now - st.startAt)) / 1000));
    guideCountEl.textContent = st.endAt != null && st.def.until ? '' : `${left}`;
    const pct = st.frames ? Math.round((100 * st.tracked) / st.frames) : 0;
    if (st.def.until === 'lock') guideLiveEl.textContent = st.lockMs != null ? `locked in ${(st.lockMs / 1000).toFixed(1)} s ✓` : 'searching…';
    else if (st.def.until === 'tracked') guideLiveEl.textContent = st.firstTrackedMs != null ? `re-locked in ${(st.firstTrackedMs / 1000).toFixed(1)} s ✓` : 'waiting for a sighting…';
    else guideLiveEl.textContent = `${pct}% tracked${st.targets.size ? ` · ${[...st.targets].join(' ')}` : ''}`;
    guideEl.className = st.lockMs != null || st.firstTrackedMs != null ? 'ok' : st.def.until ? 'searching' : '';
  }
}
if (debugParam.has('regcheck')) armRegCheck({ id: `param-${Date.now().toString(36)}`, seat: seatToken ?? null });
// DevTools/test hook: drive the walk-through without an XR session (the
// harness feeds synthetic tracking results and checks the table's report).
window.__arvGuide = {
  armRegCheck, startRegCheck, finishRegCheck, hideGuide,
  frame: (results) => regCheckFrame(results),
  render: () => renderGuide(performance.now()),
  setSeen: (v) => { tableSeen = Boolean(v); },
  setTargets: (ids) => { trackedTargets = ids.map((id) => ({ id, region: id, widthM: 0.3, heightM: 0.3, xM: 0, zM: 0 })); },
  get state() { return regCheck ? { id: regCheck.id, seat: regCheck.seat, running: regCheck.running, done: regCheck.done, stepIndex: regCheck.stepIndex, stepId: regCheck.step?.id ?? null, steps: regCheck.steps } : null; },
  get mode() { return guideMode; },
};

connect();
readyCheck();
