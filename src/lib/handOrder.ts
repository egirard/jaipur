import type { Card, Good } from './jaipur-rules';

/** The goods in the order the table lists them (and the rails stack them). */
export const GOODS_ORDER: readonly Good[] = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather'];
const RANK = new Map<string, number>(GOODS_ORDER.map((kind, i) => [kind, i]));

/**
 * The order a hand is laid out on the mat, from the open-slot end outward.
 * Unsorted, the newest card is nearest the slots (the store appends; the
 * display reverses). Sorted, the cards run diamond → leather from the
 * slots, newest first within a kind — except the `pinned` ones (cards
 * still in flight, or just landed), which keep the newest-first place by
 * the slots until their animation is over, and only then sort in.
 */
export function displayOrder(hand: readonly Card[], sorted: boolean, pinned: ReadonlySet<string> = new Set()): Card[] {
  const display = [...hand].reverse();
  if (!sorted) return display;
  const held = display.filter((card) => pinned.has(card.id));
  const settled = display.filter((card) => !pinned.has(card.id));
  settled.sort((a, b) => (RANK.get(a.kind) ?? 99) - (RANK.get(b.kind) ?? 99)); // stable: newest first within a kind
  return [...held, ...settled];
}
