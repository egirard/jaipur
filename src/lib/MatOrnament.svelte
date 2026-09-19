<script lang="ts">
  // A corner ornament for a player's mat, in the manner of a Rajput
  // manuscript border: a quarter rosette in the corner, a boteh (paisley)
  // beside it, a vine of buds along the edge. Beyond decoration, the mats
  // are what the AR phones image-track (a player points the phone at their
  // own cards), so the ornaments are drawn bold on the cream and every
  // corner of every seat differs: petal counts, ring counts and the boteh's
  // curl change with the seat and corner, so a feature matcher can tell
  // seat 1's mat (rotated 180° on screen) from seat 2's, and one corner
  // from its mirror. Rendered as an <img> of a PNG rasterised from SVG
  // markup (mirrored into its corner inside the SVG): the table's tracking
  // capture (html2canvas) copies a bitmap <img> exactly, but drew inline
  // and SVG-image ornaments only partially.
  import { onMount } from 'svelte';
  let { seat, corner }: { seat: 1 | 2; corner: 0 | 1 | 2 | 3 } = $props();

  const teal = '#315f58';
  const ochre = '#a6442d';
  const gold = '#c9932a';
  const rad = (deg: number) => (deg * Math.PI) / 180;
  // Petals of a quarter rosette centred on the corner (0,0), fanning 0..90°.
  const petal = (i: number, n: number, r0: number, r1: number) => {
    const a = rad((90 * (i + 0.5)) / n);
    const w = rad(44 / n);
    const x0 = Math.cos(a) * r0, y0 = Math.sin(a) * r0;
    const x1 = Math.cos(a - w) * (r0 + (r1 - r0) * 0.55), y1 = Math.sin(a - w) * (r0 + (r1 - r0) * 0.55);
    const x2 = Math.cos(a) * r1, y2 = Math.sin(a) * r1;
    const x3 = Math.cos(a + w) * (r0 + (r1 - r0) * 0.55), y3 = Math.sin(a + w) * (r0 + (r1 - r0) * 0.55);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} Q${x1.toFixed(1)} ${y1.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)} Q${x3.toFixed(1)} ${y3.toFixed(1)} ${x0.toFixed(1)} ${y0.toFixed(1)}Z`;
  };

  const markup = $derived.by(() => {
    const petals = 6 + corner * 2 + (seat === 1 ? 1 : 0); // 6..13, odd for seat 1
    const inner = Math.max(3, petals - 3);
    const buds = seat === 1 ? 5 : 4;
    const curl = seat === 1 ? 1 : -1;
    const flip = corner === 0 ? '' : corner === 1 ? 'translate(130 0) scale(-1 1)' : corner === 2 ? 'translate(130 70) scale(-1 -1)' : 'translate(0 70) scale(1 -1)';
    const budXs = Array.from({ length: buds }, (_, i) => 66 + i * 13);
    const parts: string[] = [];
    for (let i = 0; i < petals; i += 1) parts.push(`<path d="${petal(i, petals, 22, 54)}" fill="${i % 2 ? gold : ochre}" stroke="${teal}" stroke-width="1.2"/>`);
    for (let i = 0; i < inner; i += 1) parts.push(`<path d="${petal(i, inner, 6, 26)}" fill="${teal}" stroke="#fffaf0" stroke-width="0.8"/>`);
    parts.push(`<circle cx="0" cy="0" r="5" fill="${ochre}" stroke="${gold}" stroke-width="1.5"/>`);
    parts.push(`<path d="M0 58 A58 58 0 0 0 58 0" fill="none" stroke="${teal}" stroke-width="1.6" stroke-dasharray="3 3"/>`);
    // boteh (paisley) beside the rosette, curling one way per seat
    parts.push(`<g transform="translate(74 36) scale(${curl} 1)"><path d="M0 -20 C14 -18 18 2 10 12 C4 20 -8 18 -10 8 C-12 -2 -4 -6 2 -2 C6 2 4 8 -1 8" fill="${ochre}" stroke="${teal}" stroke-width="1.4"/><path d="M-2 -4 C4 -6 8 0 5 5" fill="none" stroke="#fffaf0" stroke-width="1.2"/><circle cx="1" cy="-9" r="2.2" fill="${gold}"/></g>`);
    // vine of buds along the top edge
    parts.push(`<path d="M60 8 Q${budXs[0] + 6} 2 ${budXs[budXs.length - 1] + 8} 8" fill="none" stroke="${teal}" stroke-width="1.4"/>`);
    budXs.forEach((x, i) => {
      const y = i % 2 ? 4 : 11;
      parts.push(`<ellipse cx="${x}" cy="${y}" rx="3.2" ry="2" fill="${i % 2 ? gold : ochre}" stroke="${teal}" stroke-width="0.9" transform="rotate(${i % 2 ? -30 : 30} ${x} ${y})"/>`);
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 70"><g transform="${flip}">${parts.join('')}</g></svg>`;
  });
  const svgSrc = $derived(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
  let pngSrc = $state('');
  onMount(() => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 520; c.height = 280;
      c.getContext('2d')?.drawImage(img, 0, 0, 520, 280);
      pngSrc = c.toDataURL('image/png');
    };
    img.src = svgSrc;
  });
</script>

<img class="mat-ornament" data-corner={corner} data-seat={seat} src={pngSrc || svgSrc} alt="" draggable="false" />

<style>
  .mat-ornament { position: absolute; width: clamp(5rem, 12vmin, 10rem); height: auto; pointer-events: none; opacity: 0.92; }
  .mat-ornament[data-corner='0'] { top: 0.25rem; left: 0.25rem; }
  .mat-ornament[data-corner='1'] { top: 0.25rem; right: 0.25rem; }
  .mat-ornament[data-corner='2'] { right: 0.25rem; bottom: 0.25rem; }
  .mat-ornament[data-corner='3'] { bottom: 0.25rem; left: 0.25rem; }
</style>
