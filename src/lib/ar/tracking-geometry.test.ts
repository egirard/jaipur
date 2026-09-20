import { describe, expect, it } from 'vitest';
import { captureScale, centreMeters, columns, frameShare, overlappingColumns, pieces, piecesFor, rows, MAX_ASPECT } from './trackingGeometry';

// The 55" table at 1920 × 1080 CSS px (0.634 mm per px): the market band
// and a token rail as the layout lays them out.
const M_PER_PX = (55 * 0.0254) / Math.hypot(1920, 1080);
const band = { left: 288, top: 289, width: 1345, height: 502 };
const rail = { left: 10, top: 10, width: 269, height: 1060 };

describe('tracking geometry', () => {
  it('cuts the band into three columns of aspect ≤ 2:1 that tile it exactly', () => {
    const cols = columns(band, 3);
    expect(cols).toHaveLength(3);
    expect(cols[0].left).toBe(band.left);
    expect(cols[2].left + cols[2].width).toBeCloseTo(band.left + band.width, 6);
    for (const c of cols) {
      expect(c.height).toBe(band.height);
      expect(Math.max(c.width, c.height) / Math.min(c.width, c.height)).toBeLessThanOrEqual(MAX_ASPECT);
    }
  });

  it('lays three overlapping 40% columns from edge to edge, sharing a fifth of their width', () => {
    const cols = overlappingColumns(band, 3, 0.4);
    expect(cols).toHaveLength(3);
    expect(cols[0].left).toBe(band.left);
    expect(cols[2].left + cols[2].width).toBeCloseTo(band.left + band.width, 6);
    expect(cols[1].left + cols[1].width / 2).toBeCloseTo(band.left + band.width / 2, 6);
    for (const c of cols) expect(c.width).toBeCloseTo(band.width * 0.4, 6);
    expect(cols[0].left + cols[0].width - cols[1].left).toBeCloseTo(band.width * 0.1, 6); // overlap
    // 34 × 32 cm on the 55" table: a quarter of the frame out to ~54 cm.
    const wM = cols[0].width * M_PER_PX, hM = cols[0].height * M_PER_PX;
    expect(frameShare(wM, hM, 0.54)).toBeGreaterThan(0.25);
  });

  it('cuts a rail into the fewest rows that keep the aspect ratio in range', () => {
    expect(piecesFor(rail, 1.5)).toBe(3); // 3.94:1 → three rows of 1.3:1 (the rail's art is sparse; keep them compact)
    expect(piecesFor(rail)).toBe(2); // 3.94:1 → two rows of 1.97:1
    const two = pieces(rail);
    expect(two).toHaveLength(2);
    expect(two[1].top + two[1].height).toBeCloseTo(rail.top + rail.height, 6);
    const three = pieces(rail, MAX_ASPECT, 1);
    expect(three).toHaveLength(3);
    for (const r of three) expect(r.height / r.width).toBeLessThan(1.4);
    // A square-ish region is left whole; a wide one is cut into columns.
    expect(pieces({ left: 0, top: 0, width: 400, height: 300 })).toHaveLength(1);
    expect(pieces({ left: 0, top: 0, width: 900, height: 300 })).toEqual(columns({ left: 0, top: 0, width: 900, height: 300 }, 2));
    expect(rows(rail, 2)[0].height).toBe(rail.height / 2);
  });

  it('places region centres in metres from the screen centre', () => {
    const mid = columns(band, 3)[1];
    const c = centreMeters(mid, [1920, 1080], M_PER_PX);
    expect(c.xM).toBeCloseTo(0, 2); // the band is centred on the screen
    expect(c.zM).toBeCloseTo(0, 2);
    const left = centreMeters(columns(band, 3)[0], [1920, 1080], M_PER_PX);
    expect(left.xM).toBeCloseTo(-mid.width * M_PER_PX, 3);
    const top = centreMeters(rows(rail, 2)[0], [1920, 1080], M_PER_PX);
    expect(top.zM).toBeLessThan(0);
    expect(top.xM).toBeLessThan(-0.5);
  });

  it('bakes every target at 450 px or more on its short side, at most 3×', () => {
    expect(captureScale(columns(band, 3)[0])).toBeCloseTo(450 / 448.33, 2);
    expect(captureScale(rows(rail, 2)[0])).toBeCloseTo(450 / 269, 3);
    expect(captureScale({ left: 0, top: 0, width: 100, height: 100 })).toBe(3);
    expect(captureScale({ left: 0, top: 0, width: 900, height: 900 })).toBe(1);
  });

  it('sizes the band patches to ARCore\'s quarter-of-the-frame rule at arm\'s length', () => {
    const col = columns(band, 3)[0];
    const wM = col.width * M_PER_PX;
    const hM = col.height * M_PER_PX;
    expect(wM).toBeCloseTo(0.284, 2);
    expect(hM).toBeCloseTo(0.318, 2);
    expect(frameShare(wM, hM, 0.4)).toBeGreaterThan(0.25);
    expect(frameShare(wM, hM, 0.5)).toBeGreaterThan(0.2);
    // A cloth flank beside a mat (9 × 17 cm) never reaches the rule from arm's length.
    expect(frameShare(0.09, 0.17, 0.4)).toBeLessThan(0.1);
  });
});
