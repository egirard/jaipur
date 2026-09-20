<script lang="ts">
  // A player's mat decoration, drawn once per mat size as a single bitmap
  // under everything on the mat: a corner rosette with a boteh in each
  // corner, a frieze of botehs, rosettes and lotus buds along every edge,
  // and a sparse scatter of pale motifs across the field. Every motif has
  // its own size, rotation, petal count and colour from a seeded generator
  // (seeded by the seat), so nothing on a mat repeats and the two mats
  // differ — the AR phones image-track the mats, and a feature matcher
  // needs unique, well-spread keypoints: a tiled pattern (every tile like
  // every other) was rated untrackable by ARCore, this is what replaces it.
  // Rendered as an <img>: the table's tracking capture copies bitmaps
  // exactly.
  import { onMount } from 'svelte';
  let { seat }: { seat: 1 | 2 } = $props();

  const teal = '#315f58';
  const ochre = '#a6442d';
  const gold = '#c9932a';
  const cream = '#fffaf0';

  let img: HTMLImageElement | undefined = $state();
  let src = $state('');

  function mulberry32(a: number) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rosette(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, petals: number, rot: number, a: number, fills: string[]) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = a;
    for (let i = 0; i < petals; i += 1) {
      const t = (i / petals) * Math.PI * 2, w = Math.PI / petals;
      ctx.beginPath();
      ctx.moveTo(Math.cos(t) * r * 0.3, Math.sin(t) * r * 0.3);
      ctx.quadraticCurveTo(Math.cos(t - w) * r * 0.75, Math.sin(t - w) * r * 0.75, Math.cos(t) * r, Math.sin(t) * r);
      ctx.quadraticCurveTo(Math.cos(t + w) * r * 0.75, Math.sin(t + w) * r * 0.75, Math.cos(t) * r * 0.3, Math.sin(t) * r * 0.3);
      ctx.fillStyle = fills[i % fills.length]; ctx.fill();
      ctx.strokeStyle = teal; ctx.lineWidth = Math.max(1, r * 0.05); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2); ctx.fillStyle = teal; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.1, 0, Math.PI * 2); ctx.fillStyle = cream; ctx.fill();
    ctx.restore();
  }

  function boteh(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number, flip: number, a: number, fill: string) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(flip * s, s); ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.moveTo(0, -20); ctx.bezierCurveTo(14, -18, 18, 2, 10, 12); ctx.bezierCurveTo(4, 20, -8, 18, -10, 8); ctx.bezierCurveTo(-12, -2, -4, -6, 2, -2); ctx.bezierCurveTo(6, 2, 4, 8, -1, 8);
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = teal; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-2, -4); ctx.bezierCurveTo(4, -6, 8, 0, 5, 5); ctx.strokeStyle = cream; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(1, -9, 2.2, 0, Math.PI * 2); ctx.fillStyle = gold; ctx.fill();
    ctx.restore();
  }

  function lotus(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number, lobes: number, a: number) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s); ctx.globalAlpha = a;
    for (let i = 0; i < lobes; i += 1) {
      const t = -Math.PI / 2 + ((i - (lobes - 1) / 2) * Math.PI) / (lobes + 1);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(Math.cos(t - 0.25) * 14, Math.sin(t - 0.25) * 14, Math.cos(t) * 18, Math.sin(t) * 18);
      ctx.quadraticCurveTo(Math.cos(t + 0.25) * 14, Math.sin(t + 0.25) * 14, 0, 0);
      ctx.fillStyle = i % 2 ? gold : ochre; ctx.fill(); ctx.strokeStyle = teal; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fillStyle = teal; ctx.fill();
    ctx.restore();
  }

  function draw(w: number, h: number) {
    const dpr = 2;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const rnd = mulberry32(seat * 7919 + 17);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const u = Math.min(w, h); // one mat-height unit
    // Corners: rosette + boteh, each corner its own petal count.
    const corners: [number, number, number][] = [[0, 0, 0], [w, 0, 1], [w, h, 2], [0, h, 3]];
    for (const [cx, cy, k] of corners) {
      const petals = 6 + k * 2 + (seat === 1 ? 1 : 0);
      rosette(ctx, cx, cy, u * 0.16, petals, rnd() * Math.PI, 0.95, [ochre, gold]);
      const dx = cx === 0 ? 1 : -1, dy = cy === 0 ? 1 : -1;
      boteh(ctx, cx + dx * u * 0.25, cy + dy * u * 0.16, u * 0.0062, rnd() * 0.6 - 0.3, dx * (seat === 1 ? -1 : 1), 0.95, ochre);
    }
    // Frieze along the long edges: motifs in a band, none alike.
    const band = u * 0.12;
    for (const edgeY of [band * 0.55, h - band * 0.55]) {
      let x = u * 0.5;
      while (x < w - u * 0.5) {
        const kind = rnd();
        const rot = (rnd() - 0.5) * 0.9;
        if (kind < 0.4) rosette(ctx, x, edgeY, band * (0.35 + rnd() * 0.2), 5 + Math.floor(rnd() * 8), rot, 0.9, [pick([ochre, gold, teal]), pick([gold, cream, ochre])]);
        else if (kind < 0.75) boteh(ctx, x, edgeY, band * 0.028 * (0.8 + rnd() * 0.5), rot + (edgeY > h / 2 ? Math.PI : 0), rnd() < 0.5 ? -1 : 1, 0.9, pick([ochre, gold, teal]));
        else lotus(ctx, x, edgeY, band * 0.032 * (0.8 + rnd() * 0.5), rot + (edgeY > h / 2 ? Math.PI : 0), 3 + Math.floor(rnd() * 3), 0.9);
        x += band * (0.9 + rnd() * 0.7);
      }
    }
    // Short edges: a column of small motifs.
    for (const edgeX of [band * 0.55, w - band * 0.55]) {
      let y = u * 0.42;
      while (y < h - u * 0.42) {
        rosette(ctx, edgeX, y, band * 0.3, 5 + Math.floor(rnd() * 6), rnd() * Math.PI, 0.85, [pick([ochre, gold]), teal]);
        y += band * (0.9 + rnd() * 0.5);
      }
    }
    // Field: sparse pale motifs (the cards and text sit over them).
    const n = Math.round((w / u) * 3);
    for (let i = 0; i < n; i += 1) {
      const x = u * 0.55 + rnd() * (w - u * 1.1), y = band * 1.3 + rnd() * (h - band * 2.6);
      const kind = rnd();
      if (kind < 0.5) rosette(ctx, x, y, u * (0.05 + rnd() * 0.05), 5 + Math.floor(rnd() * 8), rnd() * Math.PI, 0.32, [pick([ochre, gold, teal]), cream]);
      else if (kind < 0.8) boteh(ctx, x, y, u * 0.004 * (0.8 + rnd() * 0.6), rnd() * Math.PI * 2, rnd() < 0.5 ? -1 : 1, 0.32, pick([ochre, teal]));
      else lotus(ctx, x, y, u * 0.005 * (0.8 + rnd() * 0.6), rnd() * Math.PI * 2, 3 + Math.floor(rnd() * 3), 0.32);
    }
    src = c.toDataURL('image/png');
  }

  onMount(() => {
    const host = img?.parentElement;
    if (!host) return;
    let last = '';
    const redraw = () => {
      const r = host.getBoundingClientRect();
      const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (r.width < 40 || r.height < 40 || key === last) return;
      last = key;
      draw(r.width, r.height);
    };
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(host);
    return () => ro.disconnect();
  });
</script>

<img class="mat-art" bind:this={img} {src} alt="" draggable="false" data-seat={seat} />

<style>
  .mat-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; border-radius: inherit; }
</style>
