// AR bridge for the tabletop page (GPLv3, part of this fork).
//
// Owns everything AR about /tt so the page itself only needs a few calls:
// - a feature-rich registration underlay canvas behind the board (phones
//   image-track it; game DOM occludes parts of it, which is fine),
// - physical scale from a screen-diagonal setting (?diag=27, persisted),
// - artwork + scene projection: market/deck mapped from their real DOM
//   rects so AR pieces sit on their on-screen counterparts; hands laid
//   along the owner's table edge and sent only to that seat,
// - AR taps surfaced as intents with the relay-stamped seat.
//
// Speaks only the AR Card Viewer protocol via ArHost; no ARViewer code.

import { ArHost, type ArAction, type ArAsset, type ArNode } from './arHost';
import type { Card, GameState } from '../jaipur-rules';

export type ArTapHandler = (seat: string, nodeId: string) => void;

const KIND_COLORS: Record<string, string> = {
  diamond: '#9fd7e8',
  gold: '#e8c34a',
  silver: '#c9ccd4',
  cloth: '#b06ac0',
  spice: '#c96a3a',
  leather: '#8a5a34',
  camel: '#d8b26a',
};

function readDiagInches(): number {
  const p = new URLSearchParams(location.search).get('diag');
  if (p && Number(p) >= 5 && Number(p) <= 120) {
    localStorage.setItem('jaipur:ar:diag', p);
    return Number(p);
  }
  return Number(localStorage.getItem('jaipur:ar:diag') ?? '27');
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

/** Non-repeating high-contrast pattern: image tracking needs rich features
 *  (a flat board never locks — hard-won ARViewer lesson). Deterministic so
 *  the published image only changes when the size does. */
function drawUnderlay(canvas: HTMLCanvasElement, px: number): void {
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0d2622';
  ctx.fillRect(0, 0, px, px);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 260; i++) {
    const x = rnd() * px;
    const y = rnd() * px;
    const r = 4 + rnd() * (px / 14);
    ctx.strokeStyle = `rgba(${120 + rnd() * 120}, ${170 + rnd() * 60}, ${140 + rnd() * 60}, ${0.25 + rnd() * 0.5})`;
    ctx.lineWidth = 1 + rnd() * 3;
    ctx.beginPath();
    ctx.arc(x, y, r, rnd() * Math.PI * 2, rnd() * Math.PI * 2 + 1 + rnd() * 4);
    ctx.stroke();
    if (i % 5 === 0) {
      ctx.fillStyle = `rgba(${180 + rnd() * 75}, ${200 + rnd() * 55}, ${170 + rnd() * 60}, ${0.5 + rnd() * 0.4})`;
      ctx.fillRect(rnd() * px, rnd() * px, 2 + rnd() * 8, 2 + rnd() * 8);
    }
  }
  // border ticks, ruler-style
  ctx.strokeStyle = 'rgba(220,240,225,0.8)';
  ctx.lineWidth = 2;
  for (let t = 0; t < px; t += px / 40) {
    const len = t % (px / 8) < 1 ? 18 : 9;
    for (const [x1, y1, x2, y2] of [
      [t, 0, t, len], [t, px, t, px - len], [0, t, len, t], [px, t, px - len, t],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
}

export class ArTabletop {
  readonly host: ArHost;
  private underlay: HTMLCanvasElement | null = null;
  private mPerPx = 0;
  private trackedPx = 0;
  private assetsKey = '';
  private lastSeatSceneJson = new Map<string, string>();
  onTap: ArTapHandler | null = null;
  viewers = 0;
  onViewersChanged: ((n: number) => void) | null = null;

  constructor(session?: string) {
    this.host = new ArHost({
      session,
      onAction: (a: ArAction) => {
        if (a.action === 'tap' && a.seat && a.nodeId) this.onTap?.(a.seat, a.nodeId);
      },
      onViewers: (n) => {
        this.viewers = n;
        this.onViewersChanged?.(n);
      },
    });
  }

  /** Mount the registration pattern as the shared-market band's background
   *  layer — the largest VISIBLE square the camera can track, with game
   *  pieces merely occluding parts of it (occlusion is fine; invisible
   *  pixels are not: the tracked image must be exactly what is on screen).
   *  Call once after the board has mounted. */
  attach(): void {
    const diag = readDiagInches();
    const cssDiag = Math.hypot(innerWidth, innerHeight);
    this.mPerPx = (diag * 0.0254) / cssDiag;
    const band = document.querySelector<HTMLElement>('.shared-market');
    const canvas = document.createElement('canvas');
    let sizeCss: number;
    if (band) {
      const r = band.getBoundingClientRect();
      sizeCss = Math.min(r.width, r.height);
      canvas.style.cssText =
        'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
        `width:${sizeCss}px;height:${sizeCss}px;z-index:0;pointer-events:none;`;
      band.prepend(canvas);
    } else {
      sizeCss = Math.min(innerWidth, innerHeight) * 0.5;
      canvas.style.cssText =
        'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
        `width:${sizeCss}px;height:${sizeCss}px;z-index:1;pointer-events:none;`;
      document.body.prepend(canvas);
    }
    drawUnderlay(canvas, 1024);
    this.underlay = canvas;
    this.trackedPx = sizeCss;
    this.host.connect();
    this.host.publishTracking(canvas.toDataURL('image/jpeg', 0.85), sizeCss * this.mPerPx);
  }

  detach(): void {
    this.underlay?.remove();
    this.host.close();
  }

  arViewerUrl(seat?: 1 | 2): string {
    return this.host.viewerUrl(seat ? String(seat) : undefined);
  }

  /** Screen rect center -> meters in the tracked-image frame. */
  private toMeters(r: DOMRect): { xM: number; zM: number } {
    const u = this.underlay!.getBoundingClientRect();
    return {
      xM: (r.left + r.width / 2 - (u.left + u.width / 2)) * this.mPerPx,
      zM: (r.top + r.height / 2 - (u.top + u.height / 2)) * this.mPerPx,
    };
  }

  /** Publish artwork + shared scene + per-seat hands from the game state.
   *  Call after the DOM has settled (the market rects are measured live so
   *  AR pieces sit exactly on their on-screen counterparts). */
  publishFromState(lobby: GameState): void {
    if (!this.underlay || !this.mPerPx) return;
    const round = lobby.round;
    const sampleRect = document.querySelector('[data-market-card-id]')?.getBoundingClientRect();
    const wM = (sampleRect?.width ?? 60) * this.mPerPx;
    const hM = (sampleRect?.height ?? 84) * this.mPerPx;

    // Artwork: one asset per card kind + the back (content-addressed).
    const kinds = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather', 'camel'];
    const key = `${wM.toFixed(4)}x${hM.toFixed(4)}`;
    if (key !== this.assetsKey) {
      this.assetsKey = key;
      const assets: Record<string, ArAsset> = { back: { img: drawBackArt(), wM, hM } };
      for (const k of kinds) assets[`k-${k}`] = { img: drawCardArt(k), wM, hM };
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

    // Hands: private per seat, along that player's table edge, glowing when
    // selected as ready-to-trade (jaipur's tabletopIntents drive the glow —
    // the host's game state is the single source of truth).
    if (round) {
      const half = (this.trackedPx * this.mPerPx) / 2;
      for (const player of lobby.players) {
        if (player.seat !== 1 && player.seat !== 2) continue;
        const hand: Card[] = round.hands[player.uid] ?? [];
        const selected = new Set(lobby.tabletopIntents[player.uid]?.selectedReturnIds ?? []);
        const edgeZ = player.seat === 1 ? half - hM * 0.75 : -(half - hM * 0.75);
        const rotY = player.seat === 1 ? 0 : Math.PI;
        const pitch = wM * 1.15;
        const handNodes: ArNode[] = hand.map((card, i) => ({
          id: `hand:${card.id}`,
          kind: 'card',
          xM: (i - (hand.length - 1) / 2) * pitch * (player.seat === 1 ? 1 : -1),
          zM: edgeZ,
          rotY,
          faceUp: true,
          peek: false,
          glow: selected.has(card.id) ? '#66ffcc' : false,
          face: `k-${card.kind}`,
          back: 'back',
        }));
        const json = JSON.stringify(handNodes);
        if (this.lastSeatSceneJson.get(String(player.seat)) !== json) {
          this.lastSeatSceneJson.set(String(player.seat), json);
          this.host.publishSceneFor(String(player.seat), { nodes: handNodes });
        }
      }
    }
  }
}
