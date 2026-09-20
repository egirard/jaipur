// AR bridge for the tabletop page (GPLv3, part of this fork).
//
// Owns everything AR about /tt so the page itself only needs a few calls:
// - registration: phones register from static patches of the tablecloth
//   (three columns of the market band for every phone, the rows of a
//   player's own token rail for that player), captured with html2canvas
//   with everything play-varying left out and published as `tracking`
//   regions; the whole-screen capture goes along for the native apps.
//   Nothing in a target changes with play, so a phone's targets stay
//   valid for the whole game; only a layout change (resize, diagonal, a
//   seat taken or left) republishes them with a new epoch. See ARViewer
//   docs/PLAN-jaipur-registration.md,
// - physical scale from a screen-diagonal setting (?diag=27, persisted),
// - artwork + scene projection: market/deck mapped from their real DOM
//   rects so AR pieces sit on their on-screen counterparts; hands laid
//   along the owner's table edge and sent only to that seat,
// - seat joins: a phone that scanned a seat QR asks to sit down (with a
//   name) over the relay; the page seats it in the game.
//
// The AR phone is a WINDOW onto the table, not a controller: after joining,
// every game interaction happens on the tabletop itself (the phone only
// reveals the owner's private cards). AR taps are therefore ignored here.
//
// Speaks only the AR Card Viewer protocol via ArHost; no ARViewer code.

import html2canvas from 'html2canvas';
import { ArHost, type ArAction, type ArAsset, type ArNode, type ArScene, type ArTrackingRegion } from './arHost';
import { captureScale, centreMeters, overlappingColumns, pieces, type Rect } from './trackingGeometry';

/** What a phone reports about its registration every couple of seconds. */
export type ArViewerDiag = {
  state: 'searching' | 'tracked' | 'emulated' | 'lost' | 'no-tracking' | 'ended';
  frames: number; tracked: number; emulated: number; fps: number;
  seen: boolean; score: string | null; epoch: number | null;
  target: number; targets: number; scale: number; sinceResultMs: number | null;
  /** The target registered from, by region id (null before the first lock). */
  targetId?: string | null;
  /** Target ids ARCore rated untrackable (`score` then reads "k/n trackable"). */
  untrackable?: string[];
};
import type { Card, GameState } from '../jaipur-rules';

/** What the table last published for the phones to track: the static
 *  patches (band columns, rail rows), each with its screen rectangle
 *  (CSS px), so the page can outline them in place. */
export type ArTrackingTarget = { id: string; seat?: string; rect: Rect; widthM: number; heightM: number; xM: number; zM: number };
export type ArTrackingTargets = { epoch: number; at: number; captureMs: number; bytes: number; regions: ArTrackingTarget[] };

export type ArJoinHandler = (seat: string, name: string) => void;
/** A seated phone asks for a computer opponent of the given level. */
export type ArBotRequestHandler = (seat: string, difficulty: string) => void;
/** The bot levels the table offers to phones (id = BotDifficulty). */
export type ArBotOffer = { id: string; name: string; blurb: string };
/** What selling a good would earn the active trader right now. */
export type SalePreview = { cards: number; base: number; bonus: string | null };

const KIND_COLORS: Record<string, string> = {
  diamond: '#9fd7e8',
  gold: '#e8c34a',
  silver: '#c9ccd4',
  cloth: '#b06ac0',
  spice: '#c96a3a',
  leather: '#8a5a34',
  camel: '#d8b26a',
};

/** A rail row is kept squarer than the general 2:1 limit: its stack art
 *  is sparser than the cloth (coins cover half of it on screen), so give
 *  the tracker compact pieces. Measured with arcoreimg (see the plan). */
const RAIL_MAX_ASPECT = 1.5;
/** The band's columns: three, each 40% of the band wide, overlapping their
 *  neighbours by a fifth of their width (the sizes and scores are in the plan). */
const BAND_COLUMNS = 3;
const BAND_COLUMN_FRACTION = 0.4;
/** Baked size of a target's short side. ARCore asks for 300 px or more;
 *  arcoreimg scored the band columns 65–80 at 508 px and 90–100 at ~890,
 *  so the bands get more, the rails (whose art is soft) the minimum. */
const BAND_MIN_PX = 720;
const RAIL_MIN_PX = 450;

const DIAG_KEY = 'jaipur:ar:diag';
export const DIAG_MIN = 5;
export const DIAG_MAX = 120;

function readDiagInches(): number {
  const p = new URLSearchParams(location.search).get('diag');
  if (p && Number(p) >= DIAG_MIN && Number(p) <= DIAG_MAX) {
    localStorage.setItem(DIAG_KEY, p);
    return Number(p);
  }
  return Number(localStorage.getItem(DIAG_KEY) ?? '55');
}

/** The screen diagonal (inches) the AR scale is computed from. */
export function currentDiagInches(): number {
  return Number(localStorage.getItem(DIAG_KEY) ?? '55');
}

/** Physical model of the display, derived from the screen diagonal and
 *  the browser's own measurements. Meters per CSS pixel comes from the
 *  WHOLE screen (screen.width × screen.height), not the viewport, so the
 *  page may occupy any part of the screen — full screen, a window, a
 *  split — and the tracked image's physical width is still exact: it is
 *  simply the viewport width × meters-per-pixel. Assumes browser zoom
 *  100% (the calibration card outline lets you verify by eye). */
export type PhysicalInfo = {
  diagIn: number;
  screenCss: [number, number];
  viewportCss: [number, number];
  dpr: number;
  mPerCssPx: number;
  screenM: [number, number];
  viewportM: [number, number];
  viewportFraction: number;
  fullscreen: boolean;
};

export function physicalInfo(diagIn = currentDiagInches()): PhysicalInfo {
  const sw = screen.width;
  const sh = screen.height;
  const mPerCssPx = (diagIn * 0.0254) / Math.hypot(sw, sh);
  return {
    diagIn,
    screenCss: [sw, sh],
    viewportCss: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    mPerCssPx,
    screenM: [sw * mPerCssPx, sh * mPerCssPx],
    viewportM: [innerWidth * mPerCssPx, innerHeight * mPerCssPx],
    viewportFraction: (innerWidth * innerHeight) / (sw * sh),
    fullscreen: Boolean(document.fullscreenElement) || (innerWidth === sw && innerHeight === sh),
  };
}

/** The game's own card art (static/components/*.webp), loaded once; until
 *  it arrives the art falls back to a plain colored card. */
/** Everything play changes, left out of the tracked image (matched with
 *  `Element.matches`, so a selector hits the element and hides its subtree). */
const STATIC_CAPTURE_IGNORE = [
  // The mats: the cream panel stays, everything on it changes with play.
  '.player-seat > *', '.join-seat > *',
  // The market band: only the cloth (and its border) is the target; the
  // deck, cards, return slots, prompts, overlays and labels all move.
  '.market-stage', '.market-prompt', '.table-exchange-target', '.scoring-overlay', '.end-overlay',
  '.help-icon', '.help-corner', '.corner-log', '.music-control', '.options-gear', '.scale-panel', '.tutorial', '.tabletop-mark',
  '.table-card-flight', '.table-token-flight', '.bonus-stack', '.seat-tokens',
  // Token rails: the stack boxes, their art and names stay (a rail's rows
  // are tracking regions); the coins, counts and sale marks change.
  '[data-supply-token-id]', '.rail-count', '.confirm-mark', '.empty-stack',
  '.score-stack', '.seat-seals', '.rejoin', '.shared-market > header',
  // Diagnostics overlays must never become part of the target they describe.
  '.ar-targets', '.ar-diag'
].join(', ');

/** The goods stacks of a player's token rail (the bonus-token stacks at
 *  the rail's end are left out of the capture and would make a blank
 *  target). */
function goodsStacksRect(seat: string): Rect | null {
  const stacks = [...document.querySelectorAll<HTMLElement>(`[data-token-view-seat="${seat}"] [data-token-kind]`)].map((el) => el.getBoundingClientRect());
  if (!stacks.length) return null;
  const left = Math.min(...stacks.map((r) => r.left)), top = Math.min(...stacks.map((r) => r.top));
  const right = Math.max(...stacks.map((r) => r.right)), bottom = Math.max(...stacks.map((r) => r.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

const cardImages = new Map<string, HTMLImageElement>();
let cardImagesReady: Promise<void> | null = null;
function loadCardImages(base: string): Promise<void> {
  if (cardImagesReady) return cardImagesReady;
  const kinds = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather', 'camel', 'card-back'];
  cardImagesReady = Promise.all(
    kinds.map(
      (kind) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            cardImages.set(kind, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = `${base}/components/${kind}.webp`;
        })
    )
  ).then(() => undefined);
  return cardImagesReady;
}

/** Card face: the real card icon with the goods name overlaid large and
 *  outlined, so it reads at a glance against the artwork in AR. */
// Card art is square: the table draws every card as a square, so the AR
// faces (and the phone view's images) must be too — portrait art had been
// squashed onto square planes in AR and drawn portrait on the phone.
function drawCardArt(kind: string): string {
  // Exactly the table's card presentation (`.market-card`: a 2px teal
  // border, 0.55rem radius, a thin dark gap, the art cover-fitted), and no
  // label band: the AR face lies on its physical counterpart and the
  // phones compose their tracking targets from this same art, so it must
  // be the pixels on the screen.
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = '#183a37';
  ctx.beginPath(); ctx.roundRect(2, 2, 252, 252, 19); ctx.fill();
  const img = cardImages.get(kind);
  ctx.save();
  ctx.beginPath(); ctx.roundRect(11, 11, 234, 234, 12); ctx.clip();
  if (img) {
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    const scale = Math.max(234 / iw, 234 / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, 128 - dw / 2, 128 - dh / 2, dw, dh);
  } else {
    ctx.fillStyle = KIND_COLORS[kind] ?? '#888';
    ctx.fillRect(11, 11, 234, 234);
    ctx.fillStyle = '#fffbea';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind.toUpperCase(), 128, 128);
  }
  ctx.restore();
  ctx.strokeStyle = '#315f58';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.roundRect(2, 2, 252, 252, 19); ctx.stroke();
  return c.toDataURL('image/png');
}

/** A coin-shaped private tile with a large value, in the table's token
 *  style (used for the sale preview total and secret bonus values). */
function drawCoinTile(text: string, fill: string, ring: string): string {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(128, 128, 118, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(128, 128, 100, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fffbea';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${text.length > 2 ? 96 : 120}px system-ui, sans-serif`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#07110f';
  ctx.strokeText(text, 128, 136);
  ctx.fillText(text, 128, 136);
  return c.toDataURL('image/png');
}

/** A translucent ring on a transparent square: laid over a physical coin
 *  it reads as the coin glowing (the node also carries a glow halo). */
let glowRing: string | null = null;
function drawGlowRing(): string {
  if (glowRing) return glowRing;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(102, 255, 204, 0.9)';
  ctx.beginPath();
  ctx.arc(64, 64, 54, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(102, 255, 204, 0.18)';
  ctx.beginPath();
  ctx.arc(64, 64, 49, 0, Math.PI * 2);
  ctx.fill();
  glowRing = c.toDataURL('image/png');
  return glowRing;
}

function drawBackArt(): string {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const img = cardImages.get('card-back');
  if (img) {
    const scale = Math.max(256 / (img.naturalWidth || 1), 256 / (img.naturalHeight || 1));
    const dw = (img.naturalWidth || 1) * scale;
    const dh = (img.naturalHeight || 1) * scale;
    ctx.drawImage(img, 128 - dw / 2, 128 - dh / 2, dw, dh);
    return c.toDataURL('image/png');
  }
  ctx.fillStyle = '#183a37';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#2e5a55';
  ctx.lineWidth = 3;
  for (let i = -256; i < 256; i += 24) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 256, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i + 256, 0);
    ctx.lineTo(i, 256);
    ctx.stroke();
  }
  ctx.fillStyle = '#fffaf0';
  ctx.font = 'bold 40px serif';
  ctx.textAlign = 'center';
  ctx.fillText('JAIPUR', 128, 192);
  return c.toDataURL('image/png');
}

export class ArTabletop {
  readonly host: ArHost;
  private mPerPx = 0;
  private attached = false;
  private trackingEpoch = 0;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private capturing = false;
  private captureAgain = false;
  private lastTrackingJpeg = '';
  private regionGeometryKey = '';
  private assetsKey = '';
  private artGeneration = 0;
  private lastSeatSceneJson = new Map<string, string>();
  onJoin: ArJoinHandler | null = null;
  onBotRequest: ArBotRequestHandler | null = null;
  /** A seat's phone toggled one of its own cards/camels for a trade. */
  onToggleReturn: ((seat: string, cardId: string) => void) | null = null;
  /** A seat's phone asked to unstage everything not yet placed. */
  onClear: ((seat: string) => void) | null = null;
  /** Set by the page; published to a seat while a bot may still be seated opposite it. */
  botOffers: ArBotOffer[] = [];
  /** Page-supplied: what selling `kind` earns the active trader now. */
  previewFor: ((kind: string) => SalePreview | null) | null = null;
  private lastSeatAssetsJson = new Map<string, string>();
  viewers = 0;
  onViewersChanged: ((n: number) => void) | null = null;
  /** A phone's registration report (see the API doc's `diag` action). */
  onViewerDiag: ((viewerId: string, seat: string | undefined, report: ArViewerDiag) => void) | null = null;
  /** The tracking regions just published (band columns, rail rows), with their screen rectangles. */
  onTrackingPublished: ((targets: ArTrackingTargets) => void) | null = null;
  lastTargets: ArTrackingTargets | null = null;
  /** Diagnostics the phones should show (published as `scene.debug`). */
  debug: { targets?: boolean; diag?: boolean } | null = null;
  get epoch(): number { return this.trackingEpoch; }
  private seatNames = new Map<string, string>();
  private lastPlayers: GameState['players'] = [];

  private readonly base: string;
  constructor(session?: string, assetBase = '') {
    this.base = assetBase;
    // Real card art arrives asynchronously; once it has, re-render the
    // assets (the key changes with the art generation) and republish.
    void loadCardImages(assetBase).then(() => {
      this.artGeneration += 1;
      this.onGeometryChanged?.();
    });
    this.host = new ArHost({
      session,
      onAction: (a: ArAction) => {
        // A seated phone asking to join with a trader name.
        if (a.action === 'join' && a.seat) {
          const name = (a.data as { name?: unknown } | undefined)?.name;
          if (typeof name === 'string' && name.trim()) this.onJoin?.(a.seat, name.trim().slice(0, 32));
        }
        // A seated phone asking for a computer opponent (the table checks
        // the seat is free and the level exists).
        if (a.action === 'bot' && a.seat) {
          const difficulty = (a.data as { difficulty?: unknown } | undefined)?.difficulty;
          if (typeof difficulty === 'string' && this.botOffers.some((o) => o.id === difficulty)) this.onBotRequest?.(a.seat, difficulty);
        }
        // The phone view is this seat's private hand controller (what the
        // upstream /hand page does): tapping one of its own cards or camels
        // toggles the piece in the seat's tabletop intent, exactly like a
        // tap on the table. The AR view sends the same intent for the seat's
        // own pieces. Only the seat's own pieces are honoured. (AR `tap` on
        // anything else stays viewer-local: an inspect, never a selection.)
        if (a.action === 'select' && a.seat && typeof a.nodeId === 'string') {
          const m = /^(hand|herd):(.+)$/.exec(a.nodeId);
          if (m) this.onToggleReturn?.(a.seat, m[2]);
        }
        // Registration reports from phones in AR: shown, never answered.
        if (a.action === 'diag' && a.viewerId && a.data && typeof a.data === 'object') {
          this.onViewerDiag?.(a.viewerId, a.seat, a.data as ArViewerDiag);
        }
        // Host-defined phone buttons (scene.controls).
        if (a.action === 'control' && a.seat) {
          const id = (a.data as { id?: unknown } | undefined)?.id;
          if (id === 'clear') this.onClear?.(a.seat);
        }
      },
      onViewers: (n) => {
        this.viewers = n;
        this.onViewersChanged?.(n);
      },
    });
  }

  /** Start publishing: physical scale from the screen diagonal, connect to
   *  the relay, and capture the screen as the tracked image. Call once after
   *  the board has mounted. */
  attach(): void {
    this.mPerPx = physicalInfo(readDiagInches()).mPerCssPx;
    this.attached = true;
    this.host.connect();
    this.refreshTracking(0);
    addEventListener('resize', this.onResize);
    // Browser zoom / moving to another monitor changes the pixel ratio.
    this.watchDpr();
  }

  detach(): void {
    this.attached = false;
    removeEventListener('resize', this.onResize);
    this.dprQuery?.removeEventListener('change', this.onResize);
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.host.close();
  }

  private dprQuery: MediaQueryList | null = null;
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onResize);
    this.dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onResize, { once: true });
  }

  /** Viewport or screen geometry changed: the tracked image's physical
   *  width (and every node position) must follow. */
  private onResize = () => {
    this.mPerPx = physicalInfo(currentDiagInches()).mPerCssPx;
    this.watchDpr();
    this.refreshTracking(300);
    this.onGeometryChanged?.();
  };

  /** Called after a resize/zoom so the page republishes node positions. */
  onGeometryChanged: (() => void) | null = null;

  /** Change the screen diagonal in-app: persists it, rescales, republishes
   *  the tracked image (new epoch) — phones pick the new size up when they
   *  next enter AR. */
  setDiagInches(diagIn: number): void {
    const clamped = Math.min(DIAG_MAX, Math.max(DIAG_MIN, diagIn));
    localStorage.setItem(DIAG_KEY, String(clamped));
    this.mPerPx = physicalInfo(clamped).mPerCssPx;
    this.lastTrackingJpeg = ''; // force a republish even if pixels match
    this.refreshTracking(200);
    this.onGeometryChanged?.();
  }

  /** The static patches the phones register from: the market band cut
   *  into three columns (every phone: the band lies right beside each
   *  hand and is what a phone over the cards or the market sees) and each
   *  player's token rail cut into rows (that player's phone only: where
   *  they sell). Each is captured on its own with everything play-varying
   *  left out, at a scale giving ARCore's tracker at least ~450 px on the
   *  short side, and kept under 2:1 (longer targets score 0 with
   *  arcoreimg). Pieces that move over a patch during play are occlusion.
   *  The mats themselves are plain cream and carry nothing static to
   *  match, and the cloth beside them is too small to be detected from
   *  arm's length (see ARViewer docs/PLAN-jaipur-registration.md). */
  private trackingRegions(canvas: HTMLCanvasElement, scale: number, out: ArTrackingTarget[]): ArTrackingRegion[] {
    if (!this.mPerPx) return [];
    const regions: ArTrackingRegion[] = [];
    const viewport: [number, number] = [innerWidth, innerHeight];
    const publish = (id: string, seat: string | undefined, r: Rect, minPx: number) => {
      const sx = Math.round(r.left * scale), sy = Math.round(r.top * scale);
      const sw = Math.round(r.width * scale), sh = Math.round(r.height * scale);
      if (sw < 32 || sh < 32) return;
      // Each target at its own scale (~450 px on the short side): the
      // capture is at the narrowest region's scale, and a band column at
      // that scale would be a 200 KB JPEG that helps the tracker not at all.
      const own = captureScale(r, minPx) / scale;
      const c = document.createElement('canvas');
      c.width = Math.round(sw * own); c.height = Math.round(sh * own);
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const mat = c.toDataURL('image/jpeg', 0.88);
      const { xM, zM } = centreMeters(r, viewport, this.mPerPx);
      const widthM = r.width * this.mPerPx;
      const heightM = r.height * this.mPerPx;
      regions.push({ id, ...(seat ? { seat } : {}), xM, zM, widthM, heightM, mat });
      out.push({ id, ...(seat ? { seat } : {}), rect: { left: r.left, top: r.top, width: r.width, height: r.height }, widthM, heightM, xM, zM });
    };
    const band = document.querySelector<HTMLElement>('.shared-market')?.getBoundingClientRect();
    if (band && band.width >= 300 && band.height >= 100) {
      const cols = overlappingColumns(band, BAND_COLUMNS, BAND_COLUMN_FRACTION);
      publish('band:L', undefined, cols[0], BAND_MIN_PX);
      publish('band:C', undefined, cols[1], BAND_MIN_PX);
      publish('band:R', undefined, cols[2], BAND_MIN_PX);
    }
    for (const seatNo of [1, 2] as const) {
      const seat = String(seatNo);
      const stacks = goodsStacksRect(seat);
      if (!stacks || stacks.width < 60 || stacks.height < 120) continue;
      for (const [i, r] of pieces(stacks, RAIL_MAX_ASPECT).entries()) publish(`rail:${seat}:${i + 1}`, seat, r, RAIL_MIN_PX);
    }
    return regions;
  }

  /** The scale of the one capture the targets are cut from: enough for
   *  ARCore's ~450 px on the narrowest region's short side (the rails),
   *  capped at 3×. */
  private captureScaleForRegions(): number {
    let scale = 1;
    const band = document.querySelector('.shared-market')?.getBoundingClientRect();
    if (band) scale = Math.max(scale, captureScale(band, BAND_MIN_PX));
    for (const seat of ['1', '2']) {
      const r = goodsStacksRect(seat);
      if (r) scale = Math.max(scale, captureScale(r, RAIL_MIN_PX));
    }
    return scale;
  }

  /** Re-capture the screen and republish it as the tracked image, debounced
   *  (a burst of state changes and their flight animations collapse into
   *  one capture once the screen has settled). */
  refreshTracking(delayMs = 1200): void {
    if (!this.attached) return;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      void this.captureAndPublish();
    }, delayMs);
  }

  private async captureAndPublish(): Promise<void> {
    if (this.capturing) {
      this.captureAgain = true;
      return;
    }
    this.capturing = true;
    const started = performance.now();
    try {
      // One capture serves both the whole-screen image (native apps; scaled
      // down to ~1280 px wide, small over the relay) and the regions (cut
      // from it at a scale giving ARCore ~450 px on their short side).
      const scale = this.captureScaleForRegions();
      const canvas = await html2canvas(document.body, {
        scale,
        width: innerWidth,
        height: innerHeight,
        x: 0,
        y: 0,
        scrollX: 0,
        scrollY: 0,
        windowWidth: innerWidth,
        windowHeight: innerHeight,
        backgroundColor: '#5e150f',
        logging: false,
        useCORS: true,
        // The screen mutes the cloth under a dark wash; the targets are
        // captured without it. The phone's camera auto-exposes the screen,
        // so what it sees is the cloth's contrast, not its brightness, and
        // the washed capture scored half with arcoreimg (band 100 → 45–60).
        onclone: (doc) => { const t = doc.querySelector<HTMLElement>('.tabletop'); if (t) t.style.backgroundImage = 'var(--table-mat)'; },
        // Only what never changes with play goes into the target: the mat,
        // the panels and the rail headings. Cards, tokens, prompts, logs,
        // QR codes and controls are left out, so the target stays valid for
        // the whole game (a target that changed with every move had the
        // phones re-registering, and the native tracker losing its lock).
        ignoreElements: (el) => el.matches?.(STATIC_CAPTURE_IGNORE) ?? false,
      });
      const whole = document.createElement('canvas');
      whole.width = Math.min(canvas.width, 1280);
      whole.height = Math.round((canvas.height * whole.width) / canvas.width);
      const wctx = whole.getContext('2d')!;
      wctx.imageSmoothingQuality = 'high';
      wctx.drawImage(canvas, 0, 0, whole.width, whole.height);
      const jpeg = whole.toDataURL('image/jpeg', 0.85);
      if (jpeg !== this.lastTrackingJpeg && this.attached) {
        this.lastTrackingJpeg = jpeg;
        this.trackingEpoch += 1;
        const out: ArTrackingTarget[] = [];
        const regions = this.trackingRegions(canvas, scale, out);
        this.host.publishTracking(jpeg, innerWidth * this.mPerPx, this.trackingEpoch, regions);
        const bytes = jpeg.length + regions.reduce((n, r) => n + r.mat.length, 0);
        this.lastTargets = { epoch: this.trackingEpoch, at: Date.now(), captureMs: Math.round(performance.now() - started), bytes, regions: out };
        this.onTrackingPublished?.(this.lastTargets);
      }
    } catch (error) {
      console.warn('AR: screen capture failed', error);
    } finally {
      this.capturing = false;
      if (this.captureAgain) {
        this.captureAgain = false;
        this.refreshTracking(200);
      }
    }
  }

  arViewerUrl(seat?: 1 | 2): string {
    return this.host.viewerUrl(seat ? String(seat) : undefined);
  }

  /** Screen rect center -> meters in the tracked-image frame (the tracked
   *  image is the whole screen, so its origin is the viewport center). */
  private toMeters(r: DOMRect): { xM: number; zM: number } {
    return {
      xM: (r.left + r.width / 2 - innerWidth / 2) * this.mPerPx,
      zM: (r.top + r.height / 2 - innerHeight / 2) * this.mPerPx,
    };
  }

  /** Publish artwork + shared scene + per-seat hands from the game state.
   *  Call after the DOM has settled (the market rects are measured live so
   *  AR pieces sit exactly on their on-screen counterparts). */
  publishFromState(lobby: GameState, shownHandUids: readonly string[] = []): void {
    if (!this.attached || !this.mPerPx) return;
    // The tracking regions are cut from the band and the rails; only their
    // rectangles matter. Re-capture when one moves (a resize, the diagonal,
    // a seat taken or left that reflows the grid); play never moves them,
    // so a game of forty moves publishes no new targets.
    const rectKey = (r: Rect | DOMRect | null | undefined) => (r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : '-');
    const geometryKey = [rectKey(document.querySelector('.shared-market')?.getBoundingClientRect()), rectKey(goodsStacksRect('1')), rectKey(goodsStacksRect('2'))].join('|');
    if (geometryKey !== this.regionGeometryKey) {
      this.regionGeometryKey = geometryKey;
      this.refreshTracking(600);
    }
    const shown = new Set(shownHandUids);
    this.lastPlayers = lobby.players;
    const round = lobby.round;
    const sampleRect = document.querySelector('[data-market-card-id]')?.getBoundingClientRect();
    const wM = (sampleRect?.width ?? 60) * this.mPerPx;
    const hM = (sampleRect?.height ?? 84) * this.mPerPx;
    // The table draws hand cards smaller than market cards; the AR faces
    // must match the physical card under them, so hands get their own
    // asset set at the hand-card size (`s-` ids share the same art).
    const handRect = document.querySelector('[data-table-hand-card]')?.getBoundingClientRect();
    const hwM = (handRect?.width ?? sampleRect?.width ?? 60) * this.mPerPx;
    const hhM = (handRect?.height ?? sampleRect?.height ?? 84) * this.mPerPx;

    // Artwork: card kinds + back at both sizes (content-addressed; only
    // re-sent when a physical card size changes).
    const kinds = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather', 'camel'];
    const key = `${wM.toFixed(4)}x${hM.toFixed(4)}|${hwM.toFixed(4)}x${hhM.toFixed(4)}|art${this.artGeneration}`;
    if (key !== this.assetsKey) {
      this.assetsKey = key;
      const back = drawBackArt();
      const assets: Record<string, ArAsset> = {
        back: { img: back, wM, hM },
        'back-s': { img: back, wM: hwM, hM: hhM },
      };
      for (const k of kinds) {
        const img = drawCardArt(k);
        assets[`k-${k}`] = { img, wM, hM };
        assets[`s-${k}`] = { img, wM: hwM, hM: hhM };
      }
      this.host.publishAssets(assets);
    }

    const nodes: ArNode[] = [];
    if (round) {
      // Market: aligned to the real DOM cards.
      for (const card of round.market) {
        const rect = document
          .querySelector(`[data-market-card-id="${CSS.escape(card.id)}"]`)
          ?.getBoundingClientRect();
        if (!rect) continue;
        const { xM, zM } = this.toMeters(rect);
        nodes.push({
          id: `mkt:${card.id}`, kind: 'card', xM, zM, rotY: 0,
          faceUp: true, peek: false, face: `k-${card.kind}`, back: 'back',
        });
      }
      // Deck: a stack with the remaining count.
      const deckRect = document.querySelector('.deck-card')?.getBoundingClientRect();
      if (deckRect && round.deck.length > 0) {
        const { xM, zM } = this.toMeters(deckRect);
        nodes.push({
          id: 'deck', kind: 'stack', xM, zM, rotY: 0,
          count: round.deck.length, face: 'back',
        });
      }
      // Cards placed face-down in the market's return slots: everyone sees
      // the back (no peeking), the owner's seat scene lays the face over it
      // (same id, private wins), and with Show hands on the face is public.
      // Camels on a return slot were already face up. Herd sizes float over
      // each pile as a badge (public on the table too).
      for (const player of lobby.players) {
        const loads = lobby.tabletopIntents[player.uid]?.exchangeLoads ?? {};
        for (const [targetId, cardId] of Object.entries(loads)) {
          const node = this.returnNode(round, player.uid, targetId, cardId, wM, shown.has(player.uid));
          if (node) nodes.push(node);
        }
        const herdSize = round.herds[player.uid]?.length ?? 0;
        const pileRect = document.querySelector(`[data-table-herd-pile="${CSS.escape(player.uid)}"]`)?.getBoundingClientRect();
        if (herdSize > 0 && pileRect) {
          const { xM, zM } = this.toMeters(pileRect);
          nodes.push({ id: `herdcount:${player.uid}`, kind: 'badge', xM, zM, rotY: player.seat === 1 ? Math.PI : 0, count: herdSize, face: 'back' });
        }
      }
    }
    this.host.publishScene({ nodes, ...(this.debug ? { debug: this.debug } : {}) });

    // Hands: private per seat, drawn on top of the owner's face-down cards
    // on the table (measured from the live DOM, so the AR face sits exactly
    // on its physical counterpart). Cards the owner has selected on the
    // tabletop glow — jaipur's tabletopIntents drive the glow, so the phone
    // and the table can never disagree. A seat's scene also names who holds
    // it, so the phone can confirm the join.
    for (const seatNo of [1, 2] as const) {
      const seat = String(seatNo);
      const player = lobby.players.find((p) => p.seat === seatNo);
      const hand: Card[] = (player && round?.hands[player.uid]) ?? [];
      const intent = player ? lobby.tabletopIntents[player.uid] : undefined;
      const selected = new Set(intent?.selectedReturnIds ?? []);
      const loaded = new Set(Object.values(intent?.exchangeLoads ?? {}));
      const myTurn = Boolean(player && round?.status === 'active' && round.activeUid === player.uid && !lobby.pendingDraw);
      const rotY = seatNo === 1 ? Math.PI : 0;
      const handNodes: ArNode[] = [];
      // The owner sees the faces of their own cards on the return slots.
      if (player && round) {
        for (const [targetId, cardId] of Object.entries(intent?.exchangeLoads ?? {})) {
          const node = this.returnNode(round, player.uid, targetId, cardId, wM, true);
          if (node) handNodes.push(node);
        }
      }
      for (const card of hand) {
        const rect = document
          .querySelector(`[data-table-hand-card="${CSS.escape(card.id)}"]`)
          ?.getBoundingClientRect();
        if (!rect) continue;
        const { xM, zM } = this.toMeters(rect);
        handNodes.push({
          id: `hand:${card.id}`,
          kind: 'card',
          xM, zM, rotY,
          faceUp: true,
          peek: false,
          glow: selected.has(card.id) ? '#66ffcc' : false,
          face: `s-${card.kind}`,
          back: 'back-s',
          ...(loaded.has(card.id) ? { tag: 'On table', tap: false } : myTurn ? {} : { tap: false }),
        });
      }
      // The herd, one node per camel (the table only draws the top five,
      // so the rest share the pile's position): the phone view lists them
      // like the upstream /hand page does, and taps stage them.
      const herd: Card[] = (player && round?.herds[player.uid]) ?? [];
      const pileRect = player
        ? document.querySelector(`[data-table-herd-pile="${CSS.escape(player.uid)}"]`)?.getBoundingClientRect()
        : undefined;
      for (const camel of herd) {
        const rect = document
          .querySelector(`[data-table-herd-card="${CSS.escape(camel.id)}"]`)
          ?.getBoundingClientRect() ?? pileRect;
        if (!rect) continue;
        const { xM, zM } = this.toMeters(rect);
        handNodes.push({
          id: `herd:${camel.id}`,
          kind: 'card',
          xM, zM, rotY,
          faceUp: true,
          peek: false,
          glow: selected.has(camel.id) ? '#66ffcc' : false,
          face: 's-camel',
          back: 'back-s',
          ...(loaded.has(camel.id) ? { tag: 'On table', tap: false } : myTurn ? {} : { tap: false }),
        });
      }
      // Private extras, drawn only for this seat: the sale preview over
      // each sellable good on the player's own token rail while it is their
      // turn, and the secret values of the bonus tokens they have earned.
      const seatAssets: Record<string, ArAsset> = {};
      const tileRot = seatNo === 1 ? Math.PI : 0;
      if (player && round?.status === 'active' && round.activeUid === player.uid && this.previewFor) {
        for (const good of ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather']) {
          const p: SalePreview | null = this.previewFor(good);
          if (!p) continue;
          const stack = document.querySelector(`[data-token-view-seat="${seatNo}"] [data-token-kind="${good}"]`);
          if (!stack) continue;
          // The first n coins (what the sale would take) glow in place…
          const coins = [...stack.querySelectorAll<HTMLElement>('[data-supply-token-id]')].slice(0, p.cards);
          let glowM = 0;
          coins.forEach((coin, i) => {
            const rect = coin.getBoundingClientRect();
            glowM = rect.width * this.mPerPx;
            seatAssets['glow-ring'] = { img: drawGlowRing(), wM: glowM, hM: glowM };
            const { xM, zM } = this.toMeters(rect);
            handNodes.push({ id: `prev:${good}:${i}`, kind: 'tile', xM, zM, rotY: tileRot, faceUp: true, peek: false, glow: '#66ffcc', face: 'glow-ring' });
          });
          // …and a glowing coin beside the stack's name shows the total.
          const head = stack.querySelector('.rail-head')?.getBoundingClientRect() ?? stack.getBoundingClientRect();
          const id = `prev-${p.base}`;
          const cw = Math.max(glowM * 1.4, head.height * this.mPerPx * 1.6);
          seatAssets[id] = { img: drawCoinTile(`+${p.base}`, '#1d7a4a', '#eafff0'), wM: cw, hM: cw };
          const { xM, zM } = this.toMeters(head);
          handNodes.push({ id: `prev:${good}:total`, kind: 'tile', xM, zM, rotY: tileRot, faceUp: true, peek: false, glow: '#66ffcc', face: id });
          if (p.bonus) {
            const bid = `prevb-${p.bonus}`;
            seatAssets[bid] = { img: drawCoinTile(`+${p.bonus}`, '#7a4a1d', '#fff0e0'), wM: cw * 0.8, hM: cw * 0.8 };
            handNodes.push({ id: `prev:${good}:bonus`, kind: 'tile', xM: xM + (seatNo === 1 ? -cw : cw), zM, rotY: tileRot, faceUp: true, peek: false, glow: '#ffd27a', face: bid });
          }
        }
      }
      if (player && round) {
        for (const token of round.ownedBonusTokens[player.uid] ?? []) {
          const rect = document
            .querySelector(`[data-owned-bonus="${CSS.escape(token.id)}"]`)
            ?.getBoundingClientRect();
          if (!rect) continue;
          const id = `bon-${token.value}`;
          const cw = rect.width * this.mPerPx * 1.5;
          seatAssets[id] = { img: drawCoinTile(String(token.value), '#a6442d', '#fff0e0'), wM: cw, hM: cw };
          const { xM, zM } = this.toMeters(rect);
          handNodes.push({ id: `bonus:${token.id}`, kind: 'tile', xM, zM, rotY: tileRot, faceUp: true, peek: false, glow: '#ffd27a', face: id });
        }
      }
      const seatAssetsJson = JSON.stringify(Object.keys(seatAssets).sort());
      if (this.lastSeatAssetsJson.get(seat) !== seatAssetsJson) {
        this.lastSeatAssetsJson.set(seat, seatAssetsJson);
        this.host.publishAssetsFor(seat, seatAssets);
      }
      const name = player?.displayName ?? this.seatNames.get(seat);
      const otherSeat = seatNo === 1 ? 2 : 1;
      const canSeatBot = !lobby.bot && !lobby.players.some((p) => p.seat === otherSeat) && this.botOffers.length > 0;
      // What the upstream /hand page prints above its cards: hand count,
      // staging summary, token tally, and round-over notice.
      const notes: string[] = [];
      let controls: { id: string; label: string }[] | undefined;
      if (player && round) {
        const unplaced = [...selected].filter((id) => !loaded.has(id)).length;
        notes.push(`${hand.length} / 7 cards`);
        notes.push(lobby.pendingDraw
          ? 'Draw awaiting confirmation on the table'
          : `${unplaced} selected for the table · ${loaded.size} placed face-down`);
        const tokens = [...(round.ownedGoodsTokens[player.uid] ?? []), ...(round.ownedBonusTokens[player.uid] ?? [])];
        const total = tokens.reduce((sum, t) => sum + t.value, 0);
        notes.push(tokens.length ? `Your tokens: ${tokens.length} worth ${total} points` : 'No tokens yet');
        if (round.status === 'complete') notes.push('Round complete — open the next round on the table.');
        if (myTurn && unplaced > 0) controls = [{ id: 'clear', label: 'Clear unplaced' }];
      }
      const scene: ArScene = {
        nodes: handNodes,
        ...(name ? { player: { name } } : {}),
        ...(canSeatBot ? { offers: { bot: this.botOffers } } : {}),
        ...(player && round ? { turn: myTurn, notes } : {}),
        ...(controls ? { controls } : {})
      };
      const json = JSON.stringify(scene);
      if (this.lastSeatSceneJson.get(seat) !== json) {
        this.lastSeatSceneJson.set(seat, json);
        this.host.publishSceneFor(seat, scene);
      }
    }
  }

  /** A card on a market return slot, sized to the image the table draws
   *  there (hand-size or market-size art, whichever is closer). */
  private returnNode(round: NonNullable<GameState['round']>, uid: string, targetId: string, cardId: string, marketWM: number, reveal: boolean): ArNode | undefined {
    const rect = (document.querySelector(`[data-loaded-return="${CSS.escape(cardId)}"]`)
      ?? document.querySelector(`[data-table-exchange-target="${CSS.escape(targetId)}"]`))?.getBoundingClientRect();
    if (!rect || !this.mPerPx) return undefined;
    const card = round.hands[uid]?.find((c) => c.id === cardId) ?? round.herds[uid]?.find((c) => c.id === cardId);
    if (!card) return undefined;
    const small = Math.abs(rect.width * this.mPerPx - marketWM) > marketWM * 0.15;
    const { xM, zM } = this.toMeters(rect);
    const seat = round && this.seatOf(uid);
    const faceUp = card.kind === 'camel' || reveal;
    return {
      id: `ret:${cardId}`, kind: 'card', xM, zM, rotY: seat === 1 ? Math.PI : 0,
      faceUp, peek: false, tap: false,
      face: `${small ? 's' : 'k'}-${card.kind}`, back: small ? 'back-s' : 'back',
    };
  }

  private seatOf(uid: string): 1 | 2 | undefined {
    const seat = this.lastPlayers.find((p) => p.uid === uid)?.seat;
    return seat === 1 || seat === 2 ? seat : undefined;
  }

  /** Remember a name the table accepted for a seat (so the seat scene can
   *  confirm it even before the game state catches up). */
  rememberSeatName(seat: string, name: string): void {
    this.seatNames.set(seat, name);
  }
}
