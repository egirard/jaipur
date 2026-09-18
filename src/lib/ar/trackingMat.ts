// The table's background as a tracking target. Phones (WebXR image tracking,
// the native ORB tracker) register the screen by matching features against a
// capture of it. What a feature matcher wants: large, bold, high-contrast
// shapes (fine texture blurs away at a phone's viewing distance and scores
// as "too plain"), and no two of them alike (a repeated motif yields
// ambiguous matches that the ratio test throws out). What the upstream table
// offered was the opposite: one four-fold-symmetric tile repeated under a
// 62% white wash.
//
// This mat is a bazaar mandala cloth — deep maroon ground, rings of large
// paisley teardrops in orange, gold, green and cream with pale outlines —
// but with the symmetry broken on purpose: every petal in every ring has
// its own colour, size and inner motif from a seeded generator, the rings
// of each mandala start at their own phase, and the mandalas sit where the
// mat shows between the panels. Deterministic for a given viewport, so the
// capture always matches the screen.

const GROUND = '#5e150f';
const PETALS = ['#e8641c', '#f3b23c', '#c9391f', '#d9822b', '#3f7f2a', '#f6e7c8'];
const OUTLINE = 'rgba(255, 240, 214, 0.85)';

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** A paisley teardrop pointing up, tip at (0, -h/2). */
function teardrop(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.bezierCurveTo(w * 0.62, -h * 0.18, w * 0.62, h * 0.42, 0, h / 2);
  ctx.bezierCurveTo(-w * 0.62, h * 0.42, -w * 0.62, -h * 0.18, 0, -h / 2);
  ctx.closePath();
}

function mandala(ctx: CanvasRenderingContext2D, rnd: () => number, cx: number, cy: number, radius: number) {
  ctx.save();
  ctx.translate(cx, cy);
  // Rings from the outside in; each ring's petal count and phase are its own.
  const rings = [
    { r: radius * 0.86, n: 14 + Math.floor(rnd() * 5), len: radius * 0.3, wid: radius * 0.13 },
    { r: radius * 0.58, n: 10 + Math.floor(rnd() * 4), len: radius * 0.26, wid: radius * 0.12 },
    { r: radius * 0.33, n: 7 + Math.floor(rnd() * 3), len: radius * 0.2, wid: radius * 0.1 },
  ];
  for (const ring of rings) {
    const phase = rnd() * Math.PI * 2;
    for (let i = 0; i < ring.n; i++) {
      const a = phase + (i / ring.n) * Math.PI * 2;
      const scale = 0.8 + rnd() * 0.45;
      const fill = PETALS[Math.floor(rnd() * PETALS.length)];
      const inner = PETALS[Math.floor(rnd() * PETALS.length)];
      ctx.save();
      ctx.rotate(a);
      ctx.translate(0, -ring.r);
      ctx.scale(scale, scale);
      // Petal body with a pale outline (the cloth's white stitching).
      teardrop(ctx, ring.wid, ring.len);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = Math.max(2, ring.wid * 0.12);
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
      // Inner motif: a smaller drop, a ring, or a dot — never the same twice.
      const motif = Math.floor(rnd() * 3);
      ctx.fillStyle = inner === fill ? '#f6e7c8' : inner;
      if (motif === 0) { teardrop(ctx, ring.wid * 0.5, ring.len * 0.55); ctx.fill(); }
      else if (motif === 1) { ctx.beginPath(); ctx.arc(0, ring.len * 0.08, ring.wid * 0.28, 0, Math.PI * 2); ctx.lineWidth = Math.max(2, ring.wid * 0.1); ctx.strokeStyle = ctx.fillStyle; ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(0, ring.len * 0.1, ring.wid * 0.2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    // A thin band between rings, dotted at its own spacing.
    ctx.beginPath();
    ctx.arc(0, 0, ring.r - ring.len * 0.62, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, radius * 0.012);
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const dots = Math.round(ring.n * (1.6 + rnd()));
    for (let d = 0; d < dots; d++) {
      const a = (d / dots) * Math.PI * 2 + rnd() * 0.1;
      const rr = ring.r - ring.len * 0.62 - radius * 0.035;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, Math.max(1.5, radius * 0.012), 0, Math.PI * 2);
      ctx.fillStyle = PETALS[Math.floor(rnd() * PETALS.length)];
      ctx.fill();
    }
  }
  // Centre medallion.
  ctx.beginPath(); ctx.arc(0, 0, radius * 0.12, 0, Math.PI * 2); ctx.fillStyle = '#3f7f2a'; ctx.fill();
  ctx.lineWidth = Math.max(2, radius * 0.015); ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, radius * 0.05, 0, Math.PI * 2); ctx.fillStyle = '#f6e7c8'; ctx.fill();
  ctx.restore();
}

/** A data URL for a `width`×`height` CSS-pixel mat (drawn at `scale`). */
export function drawTrackingMat(_tile: HTMLImageElement | undefined, width: number, height: number, scale = 1): string {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  const rnd = seeded(Math.round(width) * 7919 + Math.round(height) * 104729 + 23);
  // Ground: maroon, a touch lighter toward the middle.
  const g = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
  g.addColorStop(0, '#7a1f16'); g.addColorStop(1, GROUND);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  // Mandalas where the mat shows: the gutters beside the market band (the
  // rails take ~14% each side, the band the middle 60%), the corners beside
  // the seat mats, and one big one under the market whose outer rings peek
  // out around the band and between the cards.
  const R = Math.min(width, height);
  const spots = [
    { x: width * 0.5, y: height * 0.5, r: R * 0.62 },
    { x: width * 0.17, y: height * 0.5, r: R * 0.24 },
    { x: width * 0.83, y: height * 0.5, r: R * 0.24 },
    { x: width * 0.17, y: height * 0.08, r: R * 0.17 },
    { x: width * 0.83, y: height * 0.08, r: R * 0.17 },
    { x: width * 0.17, y: height * 0.92, r: R * 0.17 },
    { x: width * 0.83, y: height * 0.92, r: R * 0.17 },
  ];
  for (const s of spots) mandala(ctx, rnd, s.x, s.y, s.r);
  // Loose paisley drops scattered over the ground between mandalas, each
  // its own size and turn, so even the plain areas carry distinct shapes.
  for (let i = 0; i < Math.round((width * height) / 60000); i++) {
    ctx.save();
    ctx.translate(rnd() * width, rnd() * height);
    ctx.rotate(rnd() * Math.PI * 2);
    const len = R * (0.05 + rnd() * 0.06);
    teardrop(ctx, len * 0.5, len);
    ctx.fillStyle = PETALS[Math.floor(rnd() * PETALS.length)];
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.restore();
  }
  return c.toDataURL('image/jpeg', 0.9);
}
