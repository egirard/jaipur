// The table's background as a tracking target. Phones (WebXR image tracking,
// the native ORB tracker) register the screen by matching features against
// a capture of it, and a feature matcher wants the opposite of what the
// upstream table offered: it had tiled one four-fold-symmetric mandala under
// a 62% white wash — every tile looked like every other (ambiguous matches
// fail the ratio test) and the wash flattened the contrast (few features).
//
// This mat draws the same mandala art, but no two cells alike: each cell is
// rotated, mirrored and tinted by a seeded generator, and unique ornaments
// are scattered between them. Lighter wash. Deterministic for a given size,
// so every render of the same viewport is pixel-identical (the capture must
// match the screen).

const PALETTE = ['#a6442d', '#315f58', '#d38b21', '#183a37', '#f0b44d', '#7a2f2a'];

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** A data URL for a `width`×`height` CSS-pixel mat (drawn at `scale`). */
export function drawTrackingMat(tile: HTMLImageElement | undefined, width: number, height: number, scale = 1): string {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#e9dcc1';
  ctx.fillRect(0, 0, width, height);
  const rnd = seeded(Math.round(width) * 7919 + Math.round(height) * 104729 + 17);
  // Cells about a hand-card wide: dense enough that a phone's view of any
  // part of the screen holds several distinct cells.
  const cell = Math.max(90, Math.min(width, height) / 7);
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const x = q * cell;
      const y = r * cell;
      ctx.save();
      ctx.translate(x + cell / 2, y + cell / 2);
      ctx.rotate((Math.floor(rnd() * 4) * Math.PI) / 2 + (rnd() - 0.5) * 0.35);
      if (rnd() < 0.5) ctx.scale(-1, 1);
      const zoom = 0.85 + rnd() * 0.5;
      // Subtle tints: enough to tell cells apart, not enough to shout.
      ctx.filter = `hue-rotate(${Math.round((rnd() - 0.5) * 24)}deg) saturate(${(0.85 + rnd() * 0.3).toFixed(2)}) brightness(${(0.9 + rnd() * 0.2).toFixed(2)})`;
      const size = cell * zoom;
      if (tile) ctx.drawImage(tile, -size / 2, -size / 2, size, size);
      else { ctx.fillStyle = PALETTE[Math.floor(rnd() * PALETTE.length)]; ctx.fillRect(-size / 2, -size / 2, size, size); }
      ctx.restore();
    }
  }
  // Unique ornaments: rings, diamonds, stars and dots in the palette, each
  // with its own size and orientation, so no region repeats another.
  const marks = Math.round((width * height) / (cell * cell) * 1.1);
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < marks; i++) {
    const x = rnd() * width;
    const y = rnd() * height;
    const size = cell * (0.1 + rnd() * 0.18);
    const color = PALETTE[Math.floor(rnd() * PALETTE.length)];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * Math.PI * 2);
    ctx.lineWidth = Math.max(2, size * 0.18);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    const kind = Math.floor(rnd() * 4);
    ctx.beginPath();
    if (kind === 0) { ctx.arc(0, 0, size / 2, 0, Math.PI * 2); ctx.stroke(); }
    else if (kind === 1) { ctx.moveTo(0, -size / 2); ctx.lineTo(size / 2, 0); ctx.lineTo(0, size / 2); ctx.lineTo(-size / 2, 0); ctx.closePath(); ctx.fill(); }
    else if (kind === 2) {
      const points = 5 + Math.floor(rnd() * 3);
      for (let p = 0; p < points * 2; p++) { const rad = p % 2 ? size / 4 : size / 2; const a = (p * Math.PI) / points; ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); }
      ctx.closePath(); ctx.fill();
    } else { ctx.arc(0, 0, size / 4, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(0, 0, size / 2, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  // A light wash keeps the table readable; lighter than before (62%) so the
  // pattern keeps its contrast for the trackers.
  ctx.fillStyle = 'rgba(255, 250, 238, 0.4)';
  ctx.fillRect(0, 0, width, height);
  return c.toDataURL('image/jpeg', 0.9);
}
