import { describe, expect, it } from 'vitest';
import { facingOverrides } from './arFacing';
import type { ArNode } from './arHost';

const card = (id: string, rotY = 0, extra: Partial<ArNode> = {}): ArNode =>
  ({ id, kind: 'card', xM: 0, zM: 0, rotY, faceUp: true, peek: false, face: 'k-cloth', back: 'back', ...extra }) as ArNode;

const shared: ArNode[] = [
  card('mkt:cloth-01'),
  card('mkt:camel-02', 0, { glow: '#ffd27a', tag: 'Taking?' }),
  { id: 'deck', kind: 'stack', xM: 0, zM: 0, rotY: 0, count: 30, face: 'back' } as ArNode,
  card('ret:spice-03', 0), // seat 2's card on a return slot, drawn for its owner
  card('ret:gold-04', Math.PI), // seat 1's
  { id: 'herdcount:p2', kind: 'badge', xM: 0, zM: 0, rotY: 0, count: 3, face: 'back' } as ArNode,
];

describe('facingOverrides (the market band turned to face a seat)', () => {
  it('turns every market card, the deck and the return slots to seat 1, keeping glow and tag', () => {
    const out = facingOverrides(shared, new Set(), Math.PI);
    expect(out.map((n) => n.id)).toEqual(['mkt:cloth-01', 'mkt:camel-02', 'deck', 'ret:spice-03']);
    expect(out.every((n) => n.rotY === Math.PI)).toBe(true);
    expect(out[1]).toMatchObject({ glow: '#ffd27a', tag: 'Taking?' });
    expect((out[2] as { count?: number }).count).toBe(30);
  });
  it('republishes for seat 2 only what the table drew upside down for it', () => {
    expect(facingOverrides(shared, new Set(), 0).map((n) => n.id)).toEqual(['ret:gold-04']);
  });
  it('never overrides a piece the seat scene already owns, and leaves badges to their owner', () => {
    const out = facingOverrides(shared, new Set(['ret:spice-03']), Math.PI);
    expect(out.map((n) => n.id)).toEqual(['mkt:cloth-01', 'mkt:camel-02', 'deck']);
    expect(out.some((n) => n.id.startsWith('herdcount:'))).toBe(false);
  });
  it('does not mutate the shared nodes', () => {
    facingOverrides(shared, new Set(), Math.PI);
    expect(shared[0].rotY).toBe(0);
  });
});
