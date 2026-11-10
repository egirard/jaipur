import { describe, expect, it } from 'vitest';
import { displayOrder } from './handOrder';
import type { Card } from './jaipur-rules';

const card = (id: string, kind: Card['kind']): Card => ({ id, kind });
const ids = (cards: Card[]) => cards.map((c) => c.id);

describe('displayOrder', () => {
  const hand = [card('a', 'leather'), card('b', 'diamond'), card('c', 'spice'), card('d', 'leather'), card('e', 'gold')];

  it('unsorted: the newest card is nearest the slots', () => {
    expect(ids(displayOrder(hand, false))).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('sorted: diamond → leather from the slots, newest first within a kind', () => {
    expect(ids(displayOrder(hand, true))).toEqual(['b', 'e', 'c', 'd', 'a']);
  });

  it('pinned cards keep their newest-first place by the slots until released', () => {
    expect(ids(displayOrder(hand, true, new Set(['e', 'd'])))).toEqual(['e', 'd', 'b', 'c', 'a']);
    expect(ids(displayOrder(hand, true, new Set(['a'])))).toEqual(['a', 'b', 'e', 'c', 'd']);
  });

  it('does not mutate the hand', () => {
    const before = ids(hand);
    displayOrder(hand, true);
    expect(ids(hand)).toEqual(before);
  });
});
