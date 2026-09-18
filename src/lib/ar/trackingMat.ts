// The table's background as a tracking target. Phones (WebXR image tracking,
// the native ORB tracker) register the screen by matching features against a
// capture of it. What a feature matcher wants: large, bold, high-contrast
// shapes (fine texture blurs away at a phone's viewing distance and scores
// as "too plain"), and no two of them alike (a repeated motif yields
// ambiguous matches that the ratio test throws out). What the upstream table
// offered was the opposite: one four-fold-symmetric tile repeated under a
// 62% white wash.
//
// This mat is a bazaar mandala cloth after the owner's reference — deep
// maroon ground, one mandala centred on the table — with the symmetry
// broken on purpose (see drawTrackingMat). Deterministic for a given
// viewport, so the capture always matches the screen.

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


/** A data URL for a `width`×`height` CSS-pixel mat (drawn at `scale`).
 *
 *  One mandala centred on the table and reaching its corners, built from
 *  wedges radiating from the centre. Each wedge carries a sequence of
 *  medallions (circles with an inner motif) growing outward, like the
 *  reference cloth's paisley rays. Two things vary, so a glimpse of any
 *  patch tells the tracker where it is: the wedge's own colouring and
 *  motifs (orientation, since no two wedges match) and the ring's base
 *  colour, which drifts from green at the centre through gold and orange
 *  to red at the rim (distance from the centre). */
export function drawTrackingMat(_tile: HTMLImageElement | undefined, width: number, height: number, scale = 1): string {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  const rnd = seeded(Math.round(width) * 7919 + Math.round(height) * 104729 + 29);
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.hypot(cx, cy) * 1.02; // to the corners
  // Ground: maroon, a touch lighter toward the middle.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, '#7a1f16'); g.addColorStop(1, GROUND);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Ring bands: the base colour by distance from the centre.
  const BANDS = ['#3f7f2a', '#5e9a34', '#c9a227', '#f3b23c', '#e8641c', '#d9822b', '#c9391f', '#a82a1a'];
  const bandAt = (r: number) => BANDS[Math.min(BANDS.length - 1, Math.floor((r / R) * BANDS.length))];

  const wedges = 28;
  const half = Math.PI / wedges;
  // Spokes between wedges: thin pale rays, each with its own dash rhythm.
  for (let i = 0; i < wedges; i++) {
    const a = i * 2 * half;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.setLineDash([R * (0.02 + rnd() * 0.03), R * (0.01 + rnd() * 0.02)]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 240, 214, 0.5)';
    ctx.beginPath(); ctx.moveTo(R * 0.06, 0); ctx.lineTo(R, 0); ctx.stroke();
    ctx.restore();
  }
  // Concentric rings at the band edges.
  for (let b = 1; b < BANDS.length; b++) {
    ctx.beginPath(); ctx.arc(cx, cy, (b / BANDS.length) * R, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.setLineDash([]); ctx.stroke();
  }

  // Each wedge: medallions marching outward along its middle radius, each
  // sized to the wedge's width there, coloured by ring band and tinted by
  // the wedge, with a motif no neighbour shares.
  for (let i = 0; i < wedges; i++) {
    const mid = i * 2 * half + half;
    const wedgeTint = PETALS[Math.floor(rnd() * PETALS.length)];
    const wedgeMotif = Math.floor(rnd() * 4); // the wedge's signature motif family
    const wedgeSkew = (rnd() - 0.5) * 0.5; // the medallions sit a little off the wedge's centre line
    let r = R * 0.07;
    let k = 0;
    while (r < R) {
      const fit = r * Math.sin(half) * 0.92; // half the wedge's width at this radius
      const rad = Math.min(fit, R * 0.028 + r * 0.055) * (0.85 + rnd() * 0.3);
      const base = bandAt(r);
      const x = cx + Math.cos(mid + wedgeSkew * half) * r;
      const y = cy + Math.sin(mid + wedgeSkew * half) * r;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(mid + Math.PI / 2);
      // Medallion: band colour, pale outline, a wedge-tinted inner shape.
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fillStyle = base; ctx.fill();
      ctx.lineWidth = Math.max(1.5, rad * 0.14); ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.fillStyle = wedgeTint === base ? '#f6e7c8' : wedgeTint;
      const motif = (wedgeMotif + k) % 4; // the family rotates along the ray
      if (motif === 0) { teardrop(ctx, rad * 0.9, rad * 1.3); ctx.fill(); }
      else if (motif === 1) { ctx.beginPath(); ctx.arc(0, 0, rad * 0.55, 0, Math.PI * 2); ctx.lineWidth = Math.max(1.5, rad * 0.16); ctx.strokeStyle = ctx.fillStyle; ctx.stroke(); }
      else if (motif === 2) { ctx.beginPath(); ctx.arc(0, 0, rad * 0.4, 0, Math.PI * 2); ctx.fill(); }
      else { const pts = 5 + (i % 3); ctx.beginPath(); for (let p = 0; p < pts * 2; p++) { const rr = p % 2 ? rad * 0.3 : rad * 0.62; const a = (p * Math.PI) / pts; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); }
      // A small pale dot beside the medallion, on alternating sides, so the
      // ray reads as a stitched chain like the cloth.
      ctx.beginPath(); ctx.arc((k % 2 ? 1 : -1) * rad * 1.15, 0, Math.max(1.5, rad * 0.14), 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.restore();
      r += rad * 2.35 + R * 0.012;
      k += 1;
    }
  }
  // Centre medallion.
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.055, 0, Math.PI * 2); ctx.fillStyle = '#3f7f2a'; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.022, 0, Math.PI * 2); ctx.fillStyle = '#f6e7c8'; ctx.fill();
  return c.toDataURL('image/jpeg', 0.9);
}
