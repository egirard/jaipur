// Bezel registration: find the display in a camera frame by its dark bezel
// and solve the table's pose from the screen's four corners.
//
// Pure functions over typed arrays — no DOM, no three.js — so the whole
// pipeline runs under `node --test` on synthetic frames (test/bezel.test.mjs).
// viewer.js feeds it a small grey copy of the WebXR camera image
// (`camera-access`) and the view's projection matrix, and fuses what comes
// back with ARCore's image tracking (docs/TRACKING-DIAGNOSTICS.md, "Bezel
// registration").
//
// Why the bezel and not the screen: the screen's content is anything but
// uniform (a red cloth, cream mats, cards), so no single brightness
// threshold isolates it; the bezel is the one near-black ring in the
// frame, and the screen is simply the hole in that ring. The hole's convex
// hull, reduced to four corners, is the screen's inner edge; the ring's
// outer hull is the bezel's outer edge, and the gap between them, in
// metres once the pose is known, is the bezel's width — the "captured"
// profile a session learns at start (`BezelProfile`).

// ---- Grey frames -----------------------------------------------------------

/** RGBA (as `readPixels` returns it, rows bottom-up) → grey, rows top-down
 *  when `flipY` (the GL convention), as the image is seen. */
export function greyFromRGBA(rgba, W, H, flipY = true) {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    const srcRow = flipY ? H - 1 - y : y;
    let s = srcRow * W * 4, d = y * W;
    for (let x = 0; x < W; x += 1, s += 4, d += 1) g[d] = (rgba[s] * 77 + rgba[s + 1] * 151 + rgba[s + 2] * 28) >> 8;
  }
  return g;
}

/** Otsu's threshold over a 256-bin histogram of `g` (optionally only the
 *  pixels below `below`, to split a dark class off the rest). */
export function otsu(g, below = 256) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < g.length; i += 1) if (g[i] < below) { hist[g[i]] += 1; total += 1; }
  if (!total) return 0;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 0;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// ---- Masks and components --------------------------------------------------

/** 1 where g < t (the dark pixels), then closed by one dilation so a thin
 *  bezel ring with a pixel-wide break (a card edge, noise) still encloses
 *  its hole. */
export function darkMask(g, W, H, t, dilate = 1) {
  let m = new Uint8Array(W * H);
  for (let i = 0; i < g.length; i += 1) m[i] = g[i] < t ? 1 : 0;
  for (let k = 0; k < dilate; k += 1) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) out[i] = 1;
    }
    m = out;
  }
  return m;
}

/** Flood fill (4-connected) over `mask === value` from `start`; writes
 *  `label` into `labels` and returns the component's size, bounding box
 *  and whether it touches the frame border. */
export function flood(mask, W, H, start, value, labels, label) {
  const stack = [start];
  let n = 0, minX = W, minY = H, maxX = -1, maxY = -1, border = false;
  labels[start] = label;
  while (stack.length) {
    const i = stack.pop();
    n += 1;
    const x = i % W, y = (i - x) / W;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
    if (x > 0 && mask[i - 1] === value && !labels[i - 1]) { labels[i - 1] = label; stack.push(i - 1); }
    if (x < W - 1 && mask[i + 1] === value && !labels[i + 1]) { labels[i + 1] = label; stack.push(i + 1); }
    if (y > 0 && mask[i - W] === value && !labels[i - W]) { labels[i - W] = label; stack.push(i - W); }
    if (y < H - 1 && mask[i + W] === value && !labels[i + W]) { labels[i + W] = label; stack.push(i + W); }
  }
  return { n, minX, minY, maxX, maxY, border };
}

/** Boundary pixels of component `label` (pixels with a 4-neighbour of
 *  another label or the frame edge), as [x, y] pairs. */
export function boundary(labels, W, H, label) {
  const pts = [];
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const i = y * W + x;
    if (labels[i] !== label) continue;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || labels[i - 1] !== label || labels[i + 1] !== label || labels[i - W] !== label || labels[i + W] !== label) pts.push([x, y]);
  }
  return pts;
}

// ---- Geometry ----------------------------------------------------------------

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise in image
 *  coordinates (y down, so it reads clockwise on screen). */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a) / 2;
}

/** The four hull points that span the largest quadrilateral — the corners
 *  of a convex, roughly rectangular hull. Each corner is grown greedily
 *  from the pair farthest apart, then refined by one pass of coordinate
 *  ascent (every corner moved to the hull point that maximises the area
 *  with the other three fixed), which is exact for the hulls a screen
 *  produces and cheap at hull sizes of a few hundred points. */
export function quadFromHull(hull) {
  const n = hull.length;
  if (n < 4) return null;
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) {
    const dx = hull[i][0] - hull[j][0], dy = hull[i][1] - hull[j][1], d = dx * dx + dy * dy;
    if (d > best) { best = d; a = i; b = j; }
  }
  const side = (i) => cross(hull[a], hull[b], hull[i]);
  let c = -1, d = -1, cBest = 0, dBest = 0;
  for (let i = 0; i < n; i += 1) { const s = side(i); if (s > cBest) { cBest = s; c = i; } if (s < dBest) { dBest = s; d = i; } }
  if (c < 0 || d < 0) return null;
  let idx = [a, c, b, d].sort((x, y) => x - y);
  const area = (ix) => polygonArea(ix.map((i) => hull[i]));
  for (let pass = 0; pass < 3; pass += 1) {
    let moved = false;
    for (let k = 0; k < 4; k += 1) {
      let bestI = idx[k], bestA = area(idx);
      for (let i = 0; i < n; i += 1) {
        if (idx.includes(i)) continue;
        const trial = idx.slice(); trial[k] = i;
        const aa = area(trial.sort((x, y) => x - y)); // in hull order, so the area is a convex quad's
        if (aa > bestA + 1e-9) { bestA = aa; bestI = i; }
      }
      if (bestI !== idx[k]) { idx[k] = bestI; moved = true; }
    }
    idx = idx.sort((x, y) => x - y);
    if (!moved) break;
  }
  return idx.map((i) => hull[i]);
}

/** Order four corners top-left, top-right, bottom-right, bottom-left in
 *  image space (y down): by angle around the centroid, starting from the
 *  corner with the smallest x + y. */
export function orderCorners(q) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const sorted = q.slice().sort((p, r) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(r[1] - cy, r[0] - cx));
  let start = 0, bestS = Infinity;
  for (let i = 0; i < 4; i += 1) { const s = sorted[i][0] + sorted[i][1]; if (s < bestS) { bestS = s; start = i; } }
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

/** Mean grey along a band just inside (`inset` > 0) or outside (< 0) each
 *  edge of a quad, for the bezel-contrast check. Returns one value per edge
 *  (TL→TR, TR→BR, BR→BL, BL→TL). */
export function edgeBands(g, W, H, q, inset, samples = 24) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const out = [];
  for (let e = 0; e < 4; e += 1) {
    const p = q[e], r = q[(e + 1) % 4];
    const mx = (p[0] + r[0]) / 2, my = (p[1] + r[1]) / 2;
    // Unit vector from the edge midpoint toward the centre.
    let nx = cx - mx, ny = cy - my; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    let sum = 0, n = 0;
    for (let s = 0; s < samples; s += 1) {
      const f = (s + 0.5) / samples;
      const v = sample(g, W, H, p[0] + (r[0] - p[0]) * f + nx * inset, p[1] + (r[1] - p[1]) * f + ny * inset);
      if (Number.isNaN(v)) continue;
      sum += v; n += 1;
    }
    out.push(n ? sum / n : NaN);
  }
  return out;
}

// ---- The detector ------------------------------------------------------------

/**
 * Find the screen in a grey frame by its dark bezel.
 *
 * Returns `{ ok: true, corners, outer, bezelPx, inside, bezel, surround, area, threshold }`
 * — `corners` the screen's inner edge TL/TR/BR/BL in pixels, `outer` the
 * bezel's outer edge the same way, `bezelPx` the ring's width per edge,
 * `inside`/`bezel`/`surround` the mean grey just inside the screen, on the
 * ring and just outside it — or `{ ok: false, reason }`.
 *
 * `opts.threshold` fixes the dark threshold (else Otsu, twice: the frame
 * split bright/rest, then the rest split dark/mid, clamped to
 * `opts.minT..opts.maxT`); `opts.minArea` is the least share of the frame
 * the screen may fill (default 0.03).
 */
export function findScreen(g, W, H, opts = {}) {
  const minArea = opts.minArea ?? 0.03;
  let t = opts.threshold;
  if (t == null) {
    const t1 = otsu(g);
    t = otsu(g, Math.max(t1, 2));
    // Capped low: the bezel is the near-black thing in the frame (a camera
    // exposing for a lit screen puts it at 5–30), and a dark band of the
    // screen's own cloth (60–100) must stay out of the ring or it welds
    // the ring to the content and fragments the hole.
    t = Math.max(opts.minT ?? 20, Math.min(opts.maxT ?? 56, t));
  }
  const mask = darkMask(g, W, H, t, opts.dilate ?? 1);
  const labels = new Int32Array(W * H);
  let next = 1;
  let best = null;
  // Every dark component big enough to be a bezel ring (an eighth of the
  // frame across, a twelfth down: a 27" screen seen across the table from
  // a metre is about a fifth of a portrait frame tall), not solid (a ring
  // fills little of its box). Its hole is the screen.
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || labels[i]) continue;
    const label = next; next += 1;
    const c = flood(mask, W, H, i, 1, labels, label);
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (bw < W * 0.12 || bh < H * 0.08) continue;
    if (c.n > 0.6 * bw * bh) continue; // a solid dark blob, not a ring
    // The hole: flood the non-dark pixels from the ring's box centre. It
    // must stay inside the frame (a ring with a gap leaks out) and fill a
    // good part of the box.
    const cx = Math.round((c.minX + c.maxX) / 2), cy = Math.round((c.minY + c.maxY) / 2);
    let seed = cy * W + cx;
    if (mask[seed]) {
      // The centre may land on a dark pixel of the screen (a card edge); step right until clear.
      let x = cx; while (x < c.maxX && mask[cy * W + x]) x += 1; seed = cy * W + x;
      if (mask[seed]) continue;
    }
    if (labels[seed]) continue; // already another ring's hole
    const hole = flood(mask, W, H, seed, 0, labels, next);
    const holeLabel = next; next += 1;
    if (hole.border) continue;
    const hw = hole.maxX - hole.minX + 1, hh = hole.maxY - hole.minY + 1;
    if (hole.n < minArea * W * H || hole.n < 0.5 * hw * hh) continue;
    if (hole.minX <= c.minX || hole.minY <= c.minY || hole.maxX >= c.maxX || hole.maxY >= c.maxY) continue; // not enclosed by this ring
    if (!best || hole.n > best.hole.n) best = { ring: c, ringLabel: label, hole, holeLabel };
  }
  if (!best) return { ok: false, reason: 'no bezel ring', threshold: t };
  const innerHull = convexHull(boundary(labels, W, H, best.holeLabel));
  const innerArea = polygonArea(innerHull);
  if (innerArea > best.hole.n * 1.35) return { ok: false, reason: 'hole not convex', threshold: t };
  const inner = quadFromHull(innerHull);
  if (!inner) return { ok: false, reason: 'no corners', threshold: t };
  const quadArea = polygonArea(inner);
  if (quadArea < innerArea * 0.85) return { ok: false, reason: 'not a quadrilateral', threshold: t };
  const corners = refineQuad(g, W, H, orderCorners(inner));
  const outerHull = convexHull(boundary(labels, W, H, best.ringLabel));
  const outerQ = quadFromHull(outerHull);
  const outer = outerQ ? orderCorners(outerQ) : null;
  // The ring's width per edge (its outer edge is a pixel wide of the mask's
  // dilation; the inner edge was refined, so this reads about a pixel over).
  const bezelPx = outer ? corners.map((p, e) => {
    const r = corners[(e + 1) % 4], op = outer[e], or = outer[(e + 1) % 4];
    const mx = (p[0] + r[0]) / 2, my = (p[1] + r[1]) / 2, ox = (op[0] + or[0]) / 2, oy = (op[1] + or[1]) / 2;
    return Math.max(1, Math.hypot(ox - mx, oy - my) - 1);
  }) : [2, 2, 2, 2];
  // The ring must be dark against both the screen and its surroundings on
  // at least three edges (one may be washed out or cut by a hand). Sampled
  // in the middle of the ring, however thin it is.
  const inside = edgeBands(g, W, H, corners, 4);
  const bezel = corners.map((_, e) => edgeBands(g, W, H, corners, -Math.max(0.5, Math.min(3, bezelPx[e] / 2)))[e]);
  const surround = outer ? edgeBands(g, W, H, outer, -3) : [NaN, NaN, NaN, NaN];
  let dark = 0;
  for (let e = 0; e < 4; e += 1) if (bezel[e] < t + 16 && bezel[e] < inside[e] - 20) dark += 1;
  if (dark < 3) return { ok: false, reason: 'ring not dark', threshold: t, corners, bezel, inside };
  return { ok: true, corners, outer, bezelPx, inside, bezel, surround, area: quadArea / (W * H), threshold: t };
}

/** Grey at a sub-pixel position (bilinear), or NaN off the frame. */
function sample(g, W, H, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) return NaN;
  const fx = x - x0, fy = y - y0, i = y0 * W + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + W] * (1 - fx) + g[i + W + 1] * fx) * fy;
}

/**
 * Pull each edge of a quad onto the actual dark-to-light transition and
 * intersect the four lines for sub-pixel corners. The mask the quad came
 * from was dilated (so a broken ring still closes), which moves the hole's
 * boundary a pixel inward; here, along each edge, the grey profile across
 * it is sampled and the crossing of the mid level between the bezel and
 * the screen found, a line fitted through those crossings, and the corners
 * taken where neighbouring lines meet. An edge whose crossings are too
 * few (a hand, the frame's border) keeps its place.
 */
export function refineQuad(g, W, H, q, reach = 4, samples = 20) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const lines = [];
  for (let e = 0; e < 4; e += 1) {
    const p = q[e], r = q[(e + 1) % 4];
    const ex = r[0] - p[0], ey = r[1] - p[1], el = Math.hypot(ex, ey) || 1;
    let nx = cx - (p[0] + r[0]) / 2, ny = cy - (p[1] + r[1]) / 2; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const pts = [];
    for (let s = 0; s < samples; s += 1) {
      const f = 0.1 + (0.8 * (s + 0.5)) / samples; // stay clear of the corners
      const bx = p[0] + ex * f, by = p[1] + ey * f;
      const prof = [];
      for (let d = -reach; d <= reach; d += 0.5) prof.push(sample(g, W, H, bx + nx * d, by + ny * d));
      if (prof.some((v) => Number.isNaN(v))) continue;
      const lo = Math.min(...prof), hi = Math.max(...prof);
      if (hi - lo < 30) continue;
      const mid = (lo + hi) / 2;
      // First crossing of the mid level walking inward (dark bezel → light screen).
      let at = null;
      for (let k = 1; k < prof.length; k += 1) {
        if (prof[k - 1] < mid && prof[k] >= mid) { const frac = (mid - prof[k - 1]) / (prof[k] - prof[k - 1]); at = -reach + (k - 1 + frac) * 0.5; break; }
      }
      if (at == null) continue;
      pts.push([bx + nx * at, by + ny * at]);
    }
    if (pts.length < 4) { lines.push({ p: [p[0], p[1]], d: [ex / el, ey / el] }); continue; }
    // Least-squares line through the crossings: mean point, principal direction.
    let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of pts) { sxx += (x - mx) * (x - mx); sxy += (x - mx) * (y - my); syy += (y - my) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] });
  }
  const out = [];
  for (let e = 0; e < 4; e += 1) {
    const a = lines[(e + 3) % 4], b = lines[e]; // the edges meeting at corner e
    const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(den) < 1e-6) { out.push(q[e]); continue; }
    const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
    const x = a.p[0] + a.d[0] * t, y = a.p[1] + a.d[1] * t;
    // A refinement is a nudge, never a jump: fall back if it moved more than 5 px.
    out.push(Math.hypot(x - q[e][0], y - q[e][1]) <= 5 ? [x, y] : q[e]);
  }
  return out;
}

// ---- Pose from the four corners ----------------------------------------------

/** Solve the 8×8 system for a homography mapping `src` (plane, [X, Z]) to
 *  `dst` (normalised image, [x/d, y/d]) with h33 = 1. Returns the 3×3 as
 *  a row-major array of 9, or null when singular. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i += 1) {
    const [X, Y] = src[i], [x, y] = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]); b.push(y);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** A pixel of a `W`×`H` camera image (top-left origin) → the normalised
 *  ray [x/d, y/d] in view space (d = distance along −z), using the view's
 *  projection matrix `P` (column-major 4×4, as WebXR gives it). */
export function pixelToRay(u, v, W, H, P) {
  const nx = ((u + 0.5) / W) * 2 - 1, ny = 1 - ((v + 0.5) / H) * 2;
  return [(nx + P[8]) / P[0], (ny + P[9]) / P[5]];
}

const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * The table's pose in view space from the screen's four image corners.
 *
 * `corners`: TL, TR, BR, BL in pixels of a `W`×`H` camera image whose
 * projection matrix is `P`; `widthM`/`heightM` the screen's physical size;
 * `rotate` (0 or 2) which image corner is the table's top-left — the
 * screen is a rectangle, so the camera cannot tell the table's top edge
 * from its bottom; the caller resolves that (its seat, or the image
 * tracker's pose) and asks for the other assignment with `rotate: 2`.
 * The 90° assignments are tried too and the one whose columns come out
 * orthonormal (the right aspect) wins.
 *
 * Returns `{ matrix, ortho, aspect, distance }` with `matrix` the
 * column-major 4×4 taking table coordinates (x right, y up, z toward the
 * bottom edge, origin at the screen centre) to view coordinates, or null.
 */
export function poseFromCorners(corners, W, H, P, widthM, heightM, rotate = 0) {
  const w = widthM / 2, h = heightM / 2;
  const plane = [[-w, -h], [w, -h], [w, h], [-w, h]]; // TL, TR, BR, BL in table x, z
  const rays = corners.map(([u, v]) => pixelToRay(u, v, W, H, P));
  let best = null;
  for (const r of [rotate, rotate + 1]) {
    const dst = [0, 1, 2, 3].map((k) => rays[(k + r) % 4]);
    const Hm = homography(plane, dst);
    if (!Hm) continue;
    // The ray is (p.x, p.y) / −p.z, so the homography is diag(1, 1, −1) · [X Z t]: undo the sign of the third row.
    let h1 = [Hm[0], Hm[3], -Hm[6]], h2 = [Hm[1], Hm[4], -Hm[7]], h3 = [Hm[2], Hm[5], -Hm[8]];
    const n1 = norm3(h1), n2 = norm3(h2);
    if (!n1 || !n2) continue;
    const lambda = 2 / (n1 + n2);
    let r1 = scale3(h1, lambda), r2 = scale3(h2, lambda), t = scale3(h3, lambda);
    if (t[2] > 0) { r1 = scale3(r1, -1); r2 = scale3(r2, -1); t = scale3(t, -1); } // in front of the camera (−z)
    const ortho = Math.abs(dot3(r1, r2));
    const aspect = n1 / n2;
    // Gram–Schmidt: keep r1, square r2 to it.
    r2 = sub3(r2, scale3(r1, dot3(r1, r2)));
    r1 = scale3(r1, 1 / norm3(r1)); r2 = scale3(r2, 1 / norm3(r2));
    const score = ortho + Math.abs(Math.log(aspect));
    if (!best || score < best.score) best = { score, r1, r2, t, ortho, aspect, r };
  }
  if (!best) return null;
  const { r1: X, r2: Z, t } = best;
  const Y = cross3(Z, X); // right-handed: x × y = z
  return {
    matrix: [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, t[0], t[1], t[2], 1],
    ortho: best.ortho, aspect: best.aspect, distance: norm3(t), assignment: best.r,
  };
}

/** Multiply two column-major 4×4 matrices (a · b). */
export function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

/** Apply a column-major 4×4 to a point. */
export function apply4(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Project a view-space point with `P` into pixels of a `W`×`H` image. */
export function projectToPixel(p, W, H, P) {
  const cx = P[0] * p[0] + P[4] * p[1] + P[8] * p[2] + P[12];
  const cy = P[1] * p[0] + P[5] * p[1] + P[9] * p[2] + P[13];
  const cw = P[3] * p[0] + P[7] * p[1] + P[11] * p[2] + P[15];
  const nx = cx / cw, ny = cy / cw;
  return [((nx + 1) / 2) * W - 0.5, ((1 - ny) / 2) * H - 0.5];
}

// ---- The startup profile -------------------------------------------------------

/**
 * What a session learns about this display from its first detections: the
 * bezel's width in metres (median over detections and edges), its grey
 * level, the screen's and the surroundings', and the dark threshold that
 * found it — so later frames use a threshold tuned to this room and a
 * detection whose ring does not look like the captured one is rejected.
 */
export class BezelProfile {
  constructor(need = 6) { this.need = need; this.samples = []; this.settled = null; }
  get ready() { return Boolean(this.settled); }
  /** Feed one accepted detection, with the metres-per-pixel at the screen (from its pose). */
  add(det, mPerPx) {
    if (this.settled) return;
    const widths = (det.bezelPx ?? []).filter((v) => Number.isFinite(v)).map((v) => v * mPerPx);
    this.samples.push({
      bezelM: widths.length ? median(widths) : null,
      bezel: median(det.bezel.filter(Number.isFinite)), inside: median(det.inside.filter(Number.isFinite)),
      surround: median(det.surround.filter(Number.isFinite)), threshold: det.threshold,
    });
    if (this.samples.length >= this.need) {
      const col = (k) => median(this.samples.map((s) => s[k]).filter((v) => v != null && Number.isFinite(v)));
      this.settled = { bezelM: col('bezelM'), bezel: col('bezel'), inside: col('inside'), surround: col('surround'), threshold: col('threshold'), samples: this.samples.length };
    }
  }
  /** Does a later detection look like the captured bezel? (Grey levels
   *  within a wide band — lighting drifts — and the ring still darker than
   *  both sides by the captured margin's half.) */
  accepts(det) {
    const p = this.settled;
    if (!p) return true;
    const ring = median(det.bezel.filter(Number.isFinite));
    const inside = median(det.inside.filter(Number.isFinite));
    if (!(inside - ring > (p.inside - p.bezel) * 0.4)) return false;
    if (Math.abs(ring - p.bezel) > 60) return false;
    return true;
  }
  /** The threshold to use for the next frame: a third of the way from the
   *  ring's grey up to the darker of its two neighbours (the screen, or the
   *  table around it — a dark table must not be swept in with the ring). */
  get threshold() {
    const p = this.settled; if (!p) return null;
    const neighbour = Number.isFinite(p.surround) ? Math.min(p.inside, p.surround) : p.inside;
    return Math.round(Math.min(72, Math.max(20, p.bezel + Math.max(0, neighbour - p.bezel) * 0.3)));
  }
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
