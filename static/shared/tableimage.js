// Composes the table's play area — felt, QR join code, card backs — into a
// square canvas. The table displays this exact canvas on screen AND ships a
// downscaled copy to phones as the WebXR tracked image, so what the phone
// camera sees is pixel-identical to what the tracker is matching against.
// The square is centered on the table origin, preserving the center-origin
// coordinate frame documented in docs/ARCHITECTURE.md. The QR code sits at
// that center: it is the join point for phones and doubles as the tracked
// image's high-contrast, rotationally-unambiguous anchor (the card ring
// alone is nearly rotationally symmetric).

import { drawBack, drawFace } from './cards.js';

let backCanvas = null;
const faceCanvases = new Map();

function cardImage(card) {
  if (!card.faceUp) {
    if (!backCanvas) {
      backCanvas = document.createElement('canvas');
      drawBack(backCanvas);
    }
    return backCanvas;
  }
  let c = faceCanvases.get(card.id);
  if (!c) {
    c = document.createElement('canvas');
    drawFace(c, card.def);
    faceCanvases.set(card.id, c);
  }
  return c;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ARCore's augmented-image tracker needs well-distributed, non-repetitive
// features; a plain dark felt gives it almost nothing. Draw a deterministic
// asymmetric "engraving" over the felt: a bright border, scattered filigree
// arcs, and a distinct glyph in each corner (circle/triangle/square/diamond)
// so no rotation of the image resembles another.
function drawFeltPattern(ctx, sizePx) {
  const rand = mulberry32(0xa11ce);

  ctx.lineWidth = sizePx * 0.006;
  ctx.strokeStyle = 'rgba(178, 214, 182, 0.9)';
  const inset = sizePx * 0.015;
  ctx.strokeRect(inset, inset, sizePx - 2 * inset, sizePx - 2 * inset);

  for (let i = 0; i < 60; i++) {
    const x = rand() * sizePx;
    const y = rand() * sizePx;
    const r = (0.01 + rand() * 0.06) * sizePx;
    ctx.beginPath();
    ctx.arc(x, y, r, rand() * Math.PI * 2, rand() * Math.PI * 2 + 0.5 + rand() * 3);
    ctx.strokeStyle = `hsla(${120 + rand() * 40} ${25 + rand() * 25}% ${55 + rand() * 25}% / ${0.3 + rand() * 0.35})`;
    ctx.lineWidth = sizePx * (0.002 + rand() * 0.004);
    ctx.stroke();
  }

  // Border tick marks: pseudo-random lengths, like an engraved ruler. The
  // border band is never covered by cards, so these features stay visible
  // to the tracker no matter what the game draws in the middle.
  ctx.strokeStyle = 'rgba(178, 214, 182, 0.8)';
  ctx.lineWidth = sizePx * 0.004;
  const tickInset = sizePx * 0.03;
  for (let i = 0; i < 36; i++) {
    const f = (i + 0.5) / 36;
    const len = sizePx * (0.012 + rand() * 0.022);
    for (const [x0, y0, dx, dy] of [
      [f * sizePx, tickInset, 0, 1],
      [f * sizePx, sizePx - tickInset, 0, -1],
      [tickInset, f * sizePx, 1, 0],
      [sizePx - tickInset, f * sizePx, -1, 0],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + dx * len, y0 + dy * len);
      ctx.stroke();
    }
  }

  const g = sizePx * 0.045; // corner glyph radius
  const cx = [sizePx * 0.08, sizePx * 0.92, sizePx * 0.08, sizePx * 0.92];
  const cy = [sizePx * 0.08, sizePx * 0.08, sizePx * 0.92, sizePx * 0.92];
  ctx.strokeStyle = 'rgba(190, 224, 194, 0.95)';
  ctx.lineWidth = sizePx * 0.007;
  ctx.beginPath(); // top-left: circle
  ctx.arc(cx[0], cy[0], g, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath(); // top-right: triangle
  ctx.moveTo(cx[1], cy[1] - g);
  ctx.lineTo(cx[1] + g, cy[1] + g);
  ctx.lineTo(cx[1] - g, cy[1] + g);
  ctx.closePath();
  ctx.stroke();
  ctx.strokeRect(cx[2] - g, cy[2] - g, g * 2, g * 2); // bottom-left: square
  ctx.beginPath(); // bottom-right: diamond
  ctx.moveTo(cx[3], cy[3] - g);
  ctx.lineTo(cx[3] + g, cy[3]);
  ctx.lineTo(cx[3], cy[3] + g);
  ctx.lineTo(cx[3] - g, cy[3]);
  ctx.closePath();
  ctx.stroke();
}

// Calibration test pattern: a TV-test-pattern-style target — outer circle,
// center bullseye, radial wedges, crosshair with pitch ticks, and four
// corner bullseyes with distinct glyphs (circle/triangle/square/diamond) so
// the tracker sees rich, rotationally-unambiguous texture while the human
// aligns the same design shown on the phone. Geometry is fractions of
// sizePx so the phone can render an identical pattern at its own scale.
export function drawTestPattern(ctx, cxPx, cyPx, sizePx) {
  const s = sizePx;
  const r = (f) => f * s;
  ctx.save();
  ctx.translate(cxPx, cyPx);
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(-s / 2, -s / 2, s, s);
  ctx.strokeStyle = '#f2f2f2';
  ctx.fillStyle = '#f2f2f2';
  ctx.lineWidth = s * 0.008;
  ctx.strokeRect(-s / 2 + s * 0.01, -s / 2 + s * 0.01, s * 0.98, s * 0.98);
  ctx.beginPath();
  ctx.arc(0, 0, r(0.46), 0, Math.PI * 2);
  ctx.stroke();
  // Crosshair with pitch ticks every s/10. The lines extend FAR beyond the
  // target square (the canvas clips them): while aligning, the phone
  // occludes the target's center, so these long rails are what the user
  // lines the phone's own crosshair against.
  ctx.lineWidth = s * 0.005;
  ctx.beginPath();
  ctx.moveTo(-s * 3, 0);
  ctx.lineTo(s * 3, 0);
  ctx.moveTo(0, -s * 3);
  ctx.lineTo(0, s * 3);
  ctx.stroke();
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    const p = (i / 10) * s;
    ctx.beginPath();
    ctx.moveTo(p, -r(0.03));
    ctx.lineTo(p, r(0.03));
    ctx.moveTo(-r(0.03), p);
    ctx.lineTo(r(0.03), p);
    ctx.stroke();
  }
  // Radial wedges (fan blades) between the bullseye and outer circle.
  for (let i = 0; i < 8; i += 2) {
    const a0 = (i / 8) * Math.PI * 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(0, 0, r(0.34), a0, a1);
    ctx.arc(0, 0, r(0.22), a1, a0, true);
    ctx.closePath();
    ctx.fill();
  }
  // Center bullseye.
  ctx.beginPath();
  ctx.arc(0, 0, r(0.05), 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = s * 0.01;
  ctx.beginPath();
  ctx.arc(0, 0, r(0.12), 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r(0.19), 0, Math.PI * 2);
  ctx.stroke();
  // Corner bullseyes + unique glyphs offset toward the center.
  const cc = r(0.36);
  const g = r(0.045);
  [[-cc, -cc], [cc, -cc], [-cc, cc], [cc, cc]].forEach(([x, y], i) => {
    ctx.lineWidth = s * 0.008;
    ctx.beginPath();
    ctx.arc(x, y, r(0.06), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r(0.025), 0, Math.PI * 2);
    ctx.fill();
    const gx = x * 0.72;
    const gy = y * 0.72;
    ctx.beginPath();
    if (i === 0) ctx.arc(gx, gy, g, 0, Math.PI * 2);
    else if (i === 1) {
      ctx.moveTo(gx, gy - g);
      ctx.lineTo(gx + g, gy + g);
      ctx.lineTo(gx - g, gy + g);
      ctx.closePath();
    } else if (i === 2) ctx.rect(gx - g, gy - g, 2 * g, 2 * g);
    else {
      ctx.moveTo(gx, gy - g);
      ctx.lineTo(gx + g, gy);
      ctx.lineTo(gx, gy + g);
      ctx.lineTo(gx - g, gy);
      ctx.closePath();
    }
    ctx.stroke();
  });
  ctx.restore();
}

// The static layer: everything that never changes during a game — felt,
// engraving, border ticks, corner glyphs, and the QR join code. This layer
// alone is the phones' tracked image, so gameplay (flipping, moving, adding,
// removing cards) never invalidates tracking: cards merely occlude part of
// the static layer, which ARCore's partial matching tolerates.
export function drawTableStatic(canvas, state, widthM, sizePx, qrImage, calib) {
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  const pxPerM = sizePx / widthM;
  const c = sizePx / 2;

  // Felt, matching the table page's body background so the canvas blends in.
  const felt = ctx.createRadialGradient(c, c, sizePx * 0.05, c, c, sizePx * 0.75);
  felt.addColorStop(0, '#14351f');
  felt.addColorStop(0.7, '#0a1f12');
  felt.addColorStop(1, '#081808');
  ctx.fillStyle = felt;
  ctx.fillRect(0, 0, sizePx, sizePx);
  drawFeltPattern(ctx, sizePx);

  // QR join code at the center.
  if (qrImage?.complete && qrImage.naturalWidth) {
    const qrPx = state.qr.widthM * pxPerM;
    ctx.imageSmoothingEnabled = false; // keep QR modules crisp
    ctx.drawImage(qrImage, c - qrPx / 2, c - qrPx / 2, qrPx, qrPx);
    ctx.imageSmoothingEnabled = true;
  }

  // Calibration target, drawn INTO the static/tracked layer so the phone's
  // tracker locks onto exactly what the user is aligning against.
  if (calib) {
    const px = c + calib.xM * pxPerM;
    const py = c + calib.zM * pxPerM;
    const size = calib.widthM * pxPerM;
    drawTestPattern(ctx, px, py, size);
    if (calib.label) {
      ctx.fillStyle = '#f2f2f2';
      ctx.font = `bold ${Math.round(size * 0.055)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(calib.label, px, py + size * 0.62);
    }
  }
}

// Full table render (static layer + cards) — what the table displays.
export function drawTableImage(canvas, state, widthM, sizePx, qrImage, calib) {
  drawTableStatic(canvas, state, widthM, sizePx, qrImage, calib);
  const ctx = canvas.getContext('2d');
  const pxPerM = sizePx / widthM;
  const c = sizePx / 2;

  const cardWPx = state.card.wM * pxPerM;
  const cardHPx = state.card.hM * pxPerM;
  for (const card of state.cards) {
    ctx.save();
    ctx.translate(c + card.xM * pxPerM, c + card.zM * pxPerM);
    // rotY is the rotation about the table frame's +Y axis; canvas 2D
    // rotation (clockwise, y-down) is its negation (see table.js).
    ctx.rotate(-card.rotY);
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = cardWPx * 0.1;
    ctx.shadowOffsetY = cardWPx * 0.05;
    ctx.drawImage(cardImage(card), -cardWPx / 2, -cardHPx / 2, cardWPx, cardHPx);
    ctx.restore();
  }
}
