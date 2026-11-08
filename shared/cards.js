// Card definitions and procedural card art, shared by the table (2D DOM) and
// the viewer (3D textures). Rendering from the same code keeps the physical
// pixels on the table and the AR overlay visually consistent.

// Standard poker card physical size.
export const CARD = { wM: 0.063, hM: 0.088, texW: 512, texH: 716 };

export const DECK = [
  { id: 'c1', name: 'Ember Drake', cost: 4, attack: 5, health: 3, rarity: 'rare', hue: 14, seed: 101 },
  { id: 'c2', name: 'Tide Oracle', cost: 3, attack: 2, health: 5, rarity: 'epic', hue: 205, seed: 202 },
  { id: 'c3', name: 'Verdant Golem', cost: 6, attack: 6, health: 7, rarity: 'common', hue: 130, seed: 303 },
  { id: 'c4', name: 'Gloom Assassin', cost: 2, attack: 4, health: 1, rarity: 'rare', hue: 275, seed: 404 },
  { id: 'c5', name: 'Sun Herald', cost: 5, attack: 4, health: 5, rarity: 'legendary', hue: 45, seed: 505 },
  { id: 'c6', name: 'Frost Warden', cost: 3, attack: 3, health: 4, rarity: 'common', hue: 190, seed: 606 },
];

const RARITY_COLOR = {
  common: '#9aa4ad',
  rare: '#3f8cff',
  epic: '#b45cff',
  legendary: '#ffae2a',
};

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

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function statBadge(ctx, x, y, r, color, value) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = r * 0.14;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${r * 1.15}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), x, y + r * 0.05);
}

// Draws a card face onto the canvas. Corners outside the rounded rect stay
// transparent so the same texture works as an alpha-clipped 3D quad.
export function drawFace(canvas, def) {
  const w = (canvas.width = CARD.texW);
  const h = (canvas.height = CARD.texH);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const R = w * 0.07;
  roundedRect(ctx, 0, 0, w, h, R);
  ctx.save();
  ctx.clip();

  // Parchment body.
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#efe6d2');
  bg.addColorStop(1, '#d9cbae');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Art panel: seeded blobby "painting" in the card's hue.
  const ax = w * 0.07, ay = h * 0.16, aw = w * 0.86, ah = h * 0.44;
  const sky = ctx.createLinearGradient(0, ay, 0, ay + ah);
  sky.addColorStop(0, `hsl(${def.hue} 70% 72%)`);
  sky.addColorStop(1, `hsl(${def.hue} 60% 30%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(ax, ay, aw, ah);
  const rand = mulberry32(def.seed);
  for (let i = 0; i < 22; i++) {
    const cx = ax + rand() * aw;
    const cy = ay + rand() * ah;
    const cr = (0.04 + rand() * 0.14) * aw;
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${def.hue + (rand() - 0.5) * 60} ${50 + rand() * 40}% ${25 + rand() * 55}% / ${0.25 + rand() * 0.5})`;
    ctx.fill();
  }
  ctx.lineWidth = w * 0.012;
  ctx.strokeStyle = 'rgba(60,40,20,0.8)';
  ctx.strokeRect(ax, ay, aw, ah);

  // Name plate.
  ctx.fillStyle = 'rgba(40,28,16,0.9)';
  roundedRect(ctx, w * 0.07, h * 0.045, w * 0.86, h * 0.085, w * 0.02);
  ctx.fill();
  ctx.fillStyle = '#f4ead2';
  ctx.font = `bold ${w * 0.075}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(def.name, w / 2, h * 0.045 + h * 0.0425);

  // Rarity gem.
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.655, w * 0.035, 0, Math.PI * 2);
  ctx.fillStyle = RARITY_COLOR[def.rarity] ?? RARITY_COLOR.common;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = w * 0.008;
  ctx.stroke();

  // Flavor bar.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  roundedRect(ctx, w * 0.07, h * 0.7, w * 0.86, h * 0.16, w * 0.02);
  ctx.fill();
  ctx.fillStyle = '#4a3a26';
  ctx.font = `italic ${w * 0.048}px Georgia, serif`;
  ctx.fillText(`${def.rarity[0].toUpperCase()}${def.rarity.slice(1)} · ARViewer`, w / 2, h * 0.78);

  // Stats: cost (top-left), attack (bottom-left), health (bottom-right).
  statBadge(ctx, w * 0.1, h * 0.075, w * 0.062, '#2f6fce', def.cost);
  statBadge(ctx, w * 0.1, h * 0.92, w * 0.07, '#c8571f', def.attack);
  statBadge(ctx, w * 0.9, h * 0.92, w * 0.07, '#3e8f3e', def.health);

  ctx.restore();
  ctx.lineWidth = w * 0.02;
  ctx.strokeStyle = '#2b2118';
  roundedRect(ctx, ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, R);
  ctx.stroke();
}

export function drawBack(canvas) {
  const w = (canvas.width = CARD.texW);
  const h = (canvas.height = CARD.texH);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const R = w * 0.07;
  roundedRect(ctx, 0, 0, w, h, R);
  ctx.save();
  ctx.clip();

  const bg = ctx.createRadialGradient(w / 2, h / 2, w * 0.1, w / 2, h / 2, h * 0.75);
  bg.addColorStop(0, '#1d3a6e');
  bg.addColorStop(1, '#0c1830');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Diamond lattice.
  ctx.strokeStyle = 'rgba(120,160,230,0.28)';
  ctx.lineWidth = w * 0.006;
  const step = w * 0.11;
  for (let d = -h; d < w + h; d += step) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + h, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(d, h);
    ctx.lineTo(d + h, 0);
    ctx.stroke();
  }

  // Center emblem.
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,18,38,0.9)';
  ctx.fill();
  ctx.lineWidth = w * 0.014;
  ctx.strokeStyle = '#7ea3e0';
  ctx.stroke();
  ctx.fillStyle = '#a8c4f0';
  ctx.font = `bold ${w * 0.12}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AR', w / 2, h / 2 + w * 0.008);

  ctx.restore();
  ctx.lineWidth = w * 0.02;
  ctx.strokeStyle = '#0a1226';
  roundedRect(ctx, ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, R);
  ctx.stroke();
}
