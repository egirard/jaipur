// AR bridge for the tabletop page (GPLv3, part of this fork).
//
// Owns everything AR about /tt so the page itself only needs a few calls:
// - registration: phones image-track the WHOLE tabletop screen. The page
//   captures itself (html2canvas) and publishes the capture as the tracked
//   image, re-capturing whenever the table changes so the phone's target
//   never drifts from the glass. The game's own panels (cards, QR codes,
//   text) carry the features — no synthetic pattern is drawn,
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
import { ArHost, type ArAction, type ArAsset, type ArNode } from './arHost';
import type { Card, GameState } from '../jaipur-rules';

export type ArJoinHandler = (seat: string, name: string) => void;

const KIND_COLORS: Record<string, string> = {
  diamond: '#9fd7e8',
  gold: '#e8c34a',
  silver: '#c9ccd4',
  cloth: '#b06ac0',
  spice: '#c96a3a',
  leather: '#8a5a34',
  camel: '#d8b26a',
};

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

/** Simple bold artwork for the test loop: colored card with the goods name.
 *  (Matching jaipur's DOM art pixel-for-pixel is a later polish pass.) */
function drawCardArt(kind: string): string {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 358;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fffaf0';
  ctx.fillRect(0, 0, 256, 358);
  ctx.fillStyle = KIND_COLORS[kind] ?? '#888';
  ctx.fillRect(12, 12, 232, 334);
  ctx.fillStyle = '#183a37';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(kind.toUpperCase(), 128, 190);
  ctx.strokeStyle = '#183a37';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, 232, 334);
  return c.toDataURL('image/png');
}

function drawBackArt(): string {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 358;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#183a37';
  ctx.fillRect(0, 0, 256, 358);
  ctx.strokeStyle = '#2e5a55';
  ctx.lineWidth = 3;
  for (let i = -358; i < 256; i += 24) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 358, 358);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i + 358, 0);
    ctx.lineTo(i, 358);
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
  private assetsKey = '';
  private lastSeatSceneJson = new Map<string, string>();
  onJoin: ArJoinHandler | null = null;
  viewers = 0;
  onViewersChanged: ((n: number) => void) | null = null;
  private seatNames = new Map<string, string>();

  constructor(session?: string) {
    this.host = new ArHost({
      session,
      onAction: (a: ArAction) => {
        // The only action the table honours: a seated phone asking to join
        // with a trader name. Taps stay viewer-local (peek at hidden sides).
        if (a.action === 'join' && a.seat) {
          const name = (a.data as { name?: unknown } | undefined)?.name;
          if (typeof name === 'string' && name.trim()) this.onJoin?.(a.seat, name.trim().slice(0, 32));
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
    try {
      // ~1280px wide keeps the JPEG small over the relay while leaving the
      // card art and QR modules sharp enough to match features against.
      const scale = Math.min(1, 1280 / innerWidth);
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
        backgroundColor: '#f5ead3',
        logging: false,
        useCORS: true,
        // In-flight pieces are transient; leave them out of the target.
        ignoreElements: (el) =>
          el.classList?.contains('table-card-flight') || el.classList?.contains('table-token-flight'),
      });
      const jpeg = canvas.toDataURL('image/jpeg', 0.8);
      if (jpeg !== this.lastTrackingJpeg && this.attached) {
        this.lastTrackingJpeg = jpeg;
        this.trackingEpoch += 1;
        this.host.publishTracking(jpeg, innerWidth * this.mPerPx, this.trackingEpoch);
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
  publishFromState(lobby: GameState): void {
    if (!this.attached || !this.mPerPx) return;
    // The screen just changed under the phones: refresh their target once
    // the pieces have settled.
    this.refreshTracking();
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
    const key = `${wM.toFixed(4)}x${hM.toFixed(4)}|${hwM.toFixed(4)}x${hhM.toFixed(4)}`;
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
    }
    this.host.publishScene({ nodes });

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
      const selected = new Set((player && lobby.tabletopIntents[player.uid]?.selectedReturnIds) ?? []);
      const rotY = seatNo === 1 ? Math.PI : 0;
      const handNodes: ArNode[] = [];
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
        });
      }
      const name = player?.displayName ?? this.seatNames.get(seat);
      const scene = { nodes: handNodes, ...(name ? { player: { name } } : {}) };
      const json = JSON.stringify(scene);
      if (this.lastSeatSceneJson.get(seat) !== json) {
        this.lastSeatSceneJson.set(seat, json);
        this.host.publishSceneFor(seat, scene);
      }
    }
  }

  /** Remember a name the table accepted for a seat (so the seat scene can
   *  confirm it even before the game state catches up). */
  rememberSeatName(seat: string, name: string): void {
    this.seatNames.set(seat, name);
  }
}
