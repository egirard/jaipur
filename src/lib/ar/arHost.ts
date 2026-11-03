// AR Card Viewer host client for jaipur (GPLv3, part of this fork).
//
// Speaks the AR Card Viewer API v1 — a JSON-over-WebSocket protocol
// documented in the ARViewer repo (docs/AR-CARD-VIEWER-API.md). This file
// contains no ARViewer code: the protocol is the boundary between the two
// codebases, which is what keeps them separate works.
//
// Usage sketch (from the tabletop page):
//   const ar = new ArHost({ onAction: handleArAction }); // 'join' actions seat phones
//   ar.connect();
//   ar.publishTracking(boardJpegDataUrl, widthM);      // static board layer
//   ar.publishAssets(cardArtwork);                      // shared artwork
//   ar.publishScene({ nodes });                         // on every store change
//   ar.publishAssetsFor('1', privateArtwork);           // seat 1's faces
//   ar.publishSceneFor('1', { nodes: handNodes });      // seat 1's hand
//   qrImage = await QRCode.toDataURL(ar.viewerUrl('1')) // seat 1's AR QR

import { DEFAULT_RELAY, DEFAULT_VIEWER } from './arEndpoints';

export type ArAsset = { img: string; wM: number; hM: number };

/** The relay connection as the table sees it. `closed`: dropped, retrying.
 *  `unreachable`: the retries are not getting through — three failures
 *  before the first connection ever opened, or fifteen seconds without one
 *  since it dropped (a Render relay waking from sleep holds the connect
 *  open rather than failing it, so it does not trip this); the table may
 *  switch to a LAN stand-in. `displaced`: another table window joined the
 *  same session and the relay handed it over; this one stops reconnecting
 *  (two tables would otherwise displace each other every 1.5 s and the
 *  phones would see the host flap). */
export type ArRelayStatus = 'connecting' | 'connected' | 'closed' | 'unreachable' | 'displaced';
const UNREACHABLE_FAILURES = 3;
const UNREACHABLE_AFTER_MS = 15_000;

/** A static patch of the screen the phones register from, published
 *  alongside the whole-screen image: a column of the market band, or a
 *  row of a player's token rail. `mat` is the patch's static layer (JPEG
 *  data URL, everything play-varying left out) and IS the tracked image;
 *  pieces that move over it during play are occlusion the tracker
 *  tolerates. A region with `seat` is for that seat's phone only (a
 *  player sells on their own rail and never looks at the opponent's);
 *  spectators take every region. Positions are metres in the table frame
 *  (x right, z toward the bottom edge, origin at the screen centre). */
export type ArTrackingRegion = {
  id: string;
  seat?: string;
  xM: number; zM: number; widthM: number; heightM: number;
  mat: string;
};

export type ArNode = {
  id: string;
  /** `badge`: a floating count marker with no piece under it (e.g. a herd's size). */
  kind?: 'card' | 'tile' | 'stack' | 'badge';
  xM: number;
  zM: number;
  rotY?: number;
  faceUp?: boolean;
  /** May the viewer locally peek at the hidden side (default true for cards). */
  peek?: boolean;
  /** Host-driven highlight: true, or a CSS color string. */
  glow?: boolean | string;
  count?: number;
  /** Asset ids. */
  face: string;
  back?: string;
  /** Short caption the phone view prints on the piece (e.g. "On table"). */
  tag?: string;
  /** false = the host will not act on a tap right now; the phone view
   *  shows the piece inert (default true). */
  tap?: boolean;
};

/** A scene; a seat's private scene may also carry who holds the seat, so
 *  the viewer can show "seated as NAME" (and a reconnecting phone knows it
 *  is already in). */
export type ArScene = {
  nodes: ArNode[];
  player?: { name: string };
  /** What the phone may ask the table for right now: `bot` lists the
   *  computer-opponent levels it can seat across from this seat (empty or
   *  absent when the other seat is taken). */
  offers?: { bot?: { id: string; name: string; blurb: string }[] };
  /** It is this seat's turn to act (the phone view shows "Your turn"). */
  turn?: boolean;
  /** Status lines for the phone view ("3 / 7 cards", token totals…). */
  notes?: string[];
  /** Host-defined buttons the phone view offers; pressing one sends
   *  `{action:'control', data:{id}}`. `kind` lets the view style a
   *  confirmation apart from a cancel. */
  controls?: { id: string; label: string; kind?: 'confirm' | 'cancel' | 'plain' }[];
  /** The seat's score as the table reveals it: goods tokens lie face up
   *  (`goods`, their total, over `goodsCount` tokens), bonus tokens face
   *  down (`bonus`, each hidden value). */
  score?: { goods: number; goodsCount: number; bonus: number[]; total: number };
  /** What selling each good in the hand would earn now, one entry per kind
   *  in the hand; `control` names the button to send to start that sale
   *  when the host allows it right now. */
  sales?: { kind: string; cards: number; base: number; bonus: string | null; legal: boolean; why?: string; control?: string }[];
  /** Diagnostics the host asks viewers to show (shared scene only):
   *  `targets` outlines the tracking targets in AR, `diag` prints the
   *  viewer's registration numbers on screen, `regcheck` asks the named
   *  seat's phone to run the registration walk-through (a new `id` per
   *  request; the phone reports `regcheck` actions back). */
  debug?: ArDebugFlags;
};

/** Diagnostics flags published to the phones in the shared scene. */
export type ArDebugFlags = { targets?: boolean; diag?: boolean; regcheck?: { seat: string; id: string } | null };

/** An action forwarded by the relay; viewerId/seat are relay-stamped. */
export type ArAction = {
  action: string;
  nodeId?: string;
  viewerId?: string;
  seat?: string;
  epoch?: number;
  data?: unknown;
};

export type ArHostOptions = {
  /** WebSocket relay, e.g. wss://arviewer-relay.onrender.com/ws (see arEndpoints.ts). */
  relayUrl?: string;
  /** Base URL of the AR viewer page the QR should open. */
  viewerBase?: string;
  /** Reuse a session code (e.g. restored from storage); default: generated. */
  session?: string;
  onAction?: (a: ArAction) => void;
  onViewers?: (count: number) => void;
  /** Who is connected: the phone count and the seat tokens with at least
   *  one phone (`seats` is null when the relay predates per-seat presence). */
  onPeers?: (peers: { viewers: number; seats: string[] | null }) => void;
  onStatus?: (status: ArRelayStatus) => void;
};

const SCENE_THROTTLE_MS = 80; // ~12 publishes/sec while state churns

function makeSessionCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export class ArHost {
  readonly session: string;
  private readonly loadNonce = Date.now().toString(36);
  private relayUrl: string;
  private viewerBase: string;
  private opts: ArHostOptions;
  private ws: WebSocket | null = null;
  private closed = false;
  private displaced = false;
  private everOpened = false;
  private failures = 0;
  private downSince: number | null = null;

  // Everything published is remembered so a reconnect (ours or the relay's
  // restart) can replay the full picture.
  private tracking: { image: string; widthM: number; epoch?: number; regions?: ArTrackingRegion[] } | null = null;
  private assets: Record<string, ArAsset> | null = null;
  private seatAssets = new Map<string, Record<string, ArAsset>>();
  private scene: ArScene | null = null;
  private seatScenes = new Map<string, ArScene>();

  private sceneTimer: ReturnType<typeof setTimeout> | null = null;
  private scenePending = false;

  constructor(opts: ArHostOptions = {}) {
    this.opts = opts;
    this.relayUrl = opts.relayUrl ?? DEFAULT_RELAY;
    this.viewerBase = opts.viewerBase ?? DEFAULT_VIEWER;
    this.session = opts.session ?? makeSessionCode();
  }

  /** The URL a seat's phone should open — embed this in that seat's QR.
   *  `seat` is the seat's bearer token (seatTokens.ts); the phone receives
   *  that seat's private scene and acts for it. Every phone is a seat: the
   *  relay turns away a viewer without one (spectating was dropped — the
   *  table is the shared view). */
  viewerUrl(seat: string): string {
    const u = new URL(this.viewerBase);
    u.searchParams.set('s', this.session);
    u.searchParams.set('relay', this.relayUrl);
    u.searchParams.set('seat', seat);
    // Per-table-load nonce: the hosted viewer is cached by URL for 10 min,
    // so a re-scanned QR must not hand the phone a stale page.
    u.searchParams.set('t', this.loadNonce);
    return u.toString();
  }

  connect(): void {
    this.closed = false;
    this.displaced = false;
    this.open();
  }

  /** Where the relay and viewer are right now (Table options shows them). */
  get endpoints(): { relayUrl: string; viewerBase: string } {
    return { relayUrl: this.relayUrl, viewerBase: this.viewerBase };
  }

  /** Move to another relay and viewer (the LAN stand-in): drop the current
   *  socket without retrying it, connect to the new one and replay the
   *  whole published picture there. Seat QRs must be re-rendered by the
   *  caller: they embed the relay. */
  setEndpoints(next: { relayUrl: string; viewerBase: string }): void {
    this.relayUrl = next.relayUrl;
    this.viewerBase = next.viewerBase;
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try { old.close(1000); } catch { /* already closing */ }
    }
    this.everOpened = false;
    this.failures = 0;
    this.downSince = null;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    this.ws?.close(1000);
    this.ws = null;
  }

  private open(): void {
    if (this.closed) return;
    this.opts.onStatus?.('connecting');
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.everOpened = true;
      this.failures = 0;
      this.downSince = null;
      this.opts.onStatus?.('connected');
      this.send({ v: 1, type: 'join', role: 'table', session: this.session, game: 'jaipur' });
      // Replay the whole published picture for the fresh connection.
      if (this.tracking) this.send({ type: 'tracking', tracking: this.tracking });
      if (this.assets) this.send({ type: 'assets', assets: this.assets });
      for (const [seat, assets] of this.seatAssets) this.send({ type: 'assets', seat, assets });
      if (this.scene) this.send({ type: 'state', state: { v: 1, ...this.scene } });
      for (const [seat, scene] of this.seatScenes) {
        this.send({ type: 'stateFor', seat, state: { v: 1, ...scene } });
      }
    };
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.type === 'action') this.opts.onAction?.(msg as ArAction);
      else if (msg.type === 'peers' || msg.type === 'joined') {
        if (typeof msg.viewers === 'number') {
          this.opts.onViewers?.(msg.viewers);
          const seats = Array.isArray(msg.seats) ? msg.seats.filter((x): x is string => typeof x === 'string') : null;
          this.opts.onPeers?.({ viewers: msg.viewers, seats });
        }
      } else if (msg.type === 'displaced') {
        // Another table window took the session: stay closed (see ArRelayStatus).
        this.displaced = true;
        this.closed = true;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced by setEndpoints: not ours to retry
      this.failures += 1;
      this.downSince ??= Date.now();
      const unreachable = (!this.everOpened && this.failures >= UNREACHABLE_FAILURES) || Date.now() - this.downSince > UNREACHABLE_AFTER_MS;
      this.opts.onStatus?.(this.displaced ? 'displaced' : unreachable ? 'unreachable' : 'closed');
      if (!this.closed) setTimeout(() => this.open(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Publish the static board layer (JPEG data URL of exactly the on-screen
   *  pixels, no moving pieces) and its physical width in meters. Republish
   *  whenever the static layer or the physical scale changes. The layer must
   *  be feature-rich or phones will not lock — see the API doc. */
  /** What was last published as `tracking` (dev hooks and tests read it). */
  get lastTracking(): { image: string; widthM: number; epoch?: number; regions?: ArTrackingRegion[] } | null { return this.tracking; }

  publishTracking(imageJpegDataUrl: string, widthM: number, epoch?: number, regions?: ArTrackingRegion[]): void {
    this.tracking = { image: imageJpegDataUrl, widthM, ...(epoch != null ? { epoch } : {}), ...(regions?.length ? { regions } : {}) };
    this.send({ type: 'tracking', tracking: this.tracking });
  }

  /** Shared artwork by content id. Send only when it actually changes;
   *  the relay caches it for late joiners. */
  publishAssets(assets: Record<string, ArAsset>): void {
    this.assets = assets;
    this.send({ type: 'assets', assets });
  }

  /** A seat's private artwork (only truly private faces — reuse shared ids
   *  for public art like card backs). */
  publishAssetsFor(seat: string, assets: Record<string, ArAsset>): void {
    this.seatAssets.set(seat, assets);
    this.send({ type: 'assets', seat, assets });
  }

  /** Publish the shared scene. Trailing-edge throttled so store churn
   *  (drags, animations) collapses to ~12 messages/sec. */
  publishScene(scene: ArScene): void {
    this.scene = scene;
    if (this.sceneTimer) {
      this.scenePending = true;
      return;
    }
    this.sendScene();
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = null;
      if (this.scenePending) {
        this.scenePending = false;
        this.publishScene(this.scene!);
      }
    }, SCENE_THROTTLE_MS);
  }

  private sendScene(): void {
    if (this.scene) this.send({ type: 'state', state: { v: 1, ...this.scene } });
  }

  /** Publish one seat's private scene (their hand), merged by the viewer
   *  over the shared table. Not throttled: hands change on discrete events. */
  publishSceneFor(seat: string, scene: ArScene): void {
    this.seatScenes.set(seat, scene);
    this.send({ type: 'stateFor', seat, state: { v: 1, ...scene } });
  }
}
