// Geometry of the AR tracking targets (GPLv3, part of this fork).
//
// Pure functions, so the choice of what the phones register from can be
// unit-tested without a browser. The phones register from static patches
// of the tablecloth: the market band cut into columns (every phone) and
// each player's token rail cut into rows (that player's phone). See
// ARViewer docs/PLAN-jaipur-registration.md for why these and not the mats.

export type Rect = { left: number; top: number; width: number; height: number };

/** ARCore's image tracker wants targets no longer than about 2:1 on a
 *  side (measured with arcoreimg: the same art scores 100 at 2:1 and 0 at
 *  2.7:1), so a long rectangle is cut into pieces no longer than this. */
export const MAX_ASPECT = 2;

/** Cut a rectangle into `n` equal columns, left to right. */
export function columns(r: Rect, n: number): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < n; i += 1) out.push({ left: r.left + (r.width * i) / n, top: r.top, width: r.width / n, height: r.height });
  return out;
}

/** `n` overlapping columns each `frac` of the width, spaced evenly from
 *  the left edge to the right edge (with 3 at 0.4 the middle 20% of each
 *  neighbour pair is shared). Wider pieces are detected from further away
 *  (ARCore wants about a quarter of the camera frame) and see more of a
 *  patterned cloth than a repeating strip of it. */
export function overlappingColumns(r: Rect, n: number, frac: number): Rect[] {
  const w = r.width * frac;
  const step = n > 1 ? (r.width - w) / (n - 1) : 0;
  const out: Rect[] = [];
  for (let i = 0; i < n; i += 1) out.push({ left: r.left + step * i, top: r.top, width: w, height: r.height });
  return out;
}

/** Cut a rectangle into `n` equal rows, top to bottom. */
export function rows(r: Rect, n: number): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < n; i += 1) out.push({ left: r.left, top: r.top + (r.height * i) / n, width: r.width, height: r.height / n });
  return out;
}

/** The fewest equal pieces (along the long side) that bring every piece's
 *  aspect ratio to `maxAspect` or under. */
export function piecesFor(r: Rect, maxAspect = MAX_ASPECT): number {
  const aspect = Math.max(r.width, r.height) / Math.max(1, Math.min(r.width, r.height));
  return Math.max(1, Math.ceil(aspect / maxAspect - 1e-9));
}

/** Cut a rectangle along its long side into the fewest pieces of aspect
 *  ≤ `maxAspect`, plus `extra` more (a smaller, safer piece when the
 *  minimum lands exactly on the limit). */
export function pieces(r: Rect, maxAspect = MAX_ASPECT, extra = 0): Rect[] {
  const n = piecesFor(r, maxAspect) + extra;
  return r.height > r.width ? rows(r, n) : columns(r, n);
}

/** Centre of a screen rectangle → metres in the table frame: origin at the
 *  viewport centre, x right, z toward the bottom edge. */
export function centreMeters(r: Rect, viewport: [number, number], mPerPx: number): { xM: number; zM: number } {
  return {
    xM: (r.left + r.width / 2 - viewport[0] / 2) * mPerPx,
    zM: (r.top + r.height / 2 - viewport[1] / 2) * mPerPx,
  };
}

/** The capture scale that gives a region at least `minPx` on its short
 *  side (ARCore asks for 300 px or more; the 1280 px screen capture had
 *  left regions at 180–200 px), capped so a big screen does not bake
 *  multi-megapixel targets (resolution beyond that does not help). */
export function captureScale(r: Rect, minPx = 450, maxScale = 3): number {
  return Math.min(maxScale, Math.max(1, minPx / Math.max(1, Math.min(r.width, r.height))));
}

/** The share of a phone's camera frame a flat target fills, seen face on
 *  from `distanceM` (portrait; 70° × 55° field, the frame is about
 *  1.04 × 1.40 times the distance). ARCore detects at about 0.25. */
export function frameShare(widthM: number, heightM: number, distanceM: number): number {
  const frameW = 2 * distanceM * Math.tan((55 / 2) * (Math.PI / 180));
  const frameH = 2 * distanceM * Math.tan((70 / 2) * (Math.PI / 180));
  return (widthM * heightM) / (frameW * frameH);
}
