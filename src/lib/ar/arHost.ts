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

export type ArAsset = { img: string; wM: number; hM: number };

export type ArNode = {
  id: string;
  kind?: 'card' | 'tile' | 'stack';
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
};

/** A scene; a seat's private scene may also carry who holds the seat, so
 *  the viewer can show "seated as NAME" (and a reconnecting phone knows it
 *  is already in). */
export type ArScene = { nodes: ArNode[]; player?: { name: string } };

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
  /** WebSocket relay, e.g. wss://arviewer-relay.onrender.com/ws */
  relayUrl?: string;
  /** Base URL of the AR viewer page the QR should open. */
  viewerBase?: string;
  /** Reuse a session code (e.g. restored from storage); default: generated. */
  session?: string;
  onAction?: (a: ArAction) => void;
  onViewers?: (count: number) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'closed') => void;
};

const DEFAULT_RELAY = 'wss://arviewer-relay.onrender.com/ws';
const DEFAULT_VIEWER = 'https://egirard.github.io/ARViewer/viewer/';
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

  // Everything published is remembered so a reconnect (ours or the relay's
  // restart) can replay the full picture.
  private tracking: { image: string; widthM: number; epoch?: number } | null = null;
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

  /** The URL a phone should open — embed this in the QR. With a seat token
   *  the viewer is seated (receives that seat's private scene); without it,
   *  it is a spectator. */
  viewerUrl(seat?: string): string {
    const u = new URL(this.viewerBase);
    u.searchParams.set('s', this.session);
    u.searchParams.set('relay', this.relayUrl);
    if (seat) u.searchParams.set('seat', seat);
    // Per-table-load nonce: the hosted viewer is cached by URL for 10 min,
    // so a re-scanned QR must not hand the phone a stale page.
    u.searchParams.set('t', this.loadNonce);
    return u.toString();
  }

  connect(): void {
    this.closed = false;
    this.open();
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
        if (typeof msg.viewers === 'number') this.opts.onViewers?.(msg.viewers);
      }
    };
    ws.onclose = () => {
      this.opts.onStatus?.('closed');
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
  publishTracking(imageJpegDataUrl: string, widthM: number, epoch?: number): void {
    this.tracking = { image: imageJpegDataUrl, widthM, ...(epoch != null ? { epoch } : {}) };
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
