// What a seat's phone shows besides the cards (GPLv3, part of this fork):
// the player's score as the table reveals it — goods tokens lie face up,
// bonus tokens face down, so the phone prints the face-up total and each
// hidden value — and what selling each good in the hand would earn right
// now. Pure; the table publishes the results in the seat's private scene
// (ArScene.score / ArScene.sales) and the phone view renders them.
import { bonusValueRange, type Good, type RoundState } from '../jaipur-rules';

export type PhoneScore = {
  /** Face-up value: the goods tokens' total, and how many there are. */
  goods: number;
  goodsCount: number;
  /** Each bonus token's hidden value, in the order earned. */
  bonus: number[];
  total: number;
};

export function phoneScore(round: RoundState | null, uid: string): PhoneScore {
  const goodsTokens = round?.ownedGoodsTokens[uid] ?? [];
  const bonus = (round?.ownedBonusTokens[uid] ?? []).map((t) => t.value);
  const goods = goodsTokens.reduce((sum, t) => sum + t.value, 0);
  return { goods, goodsCount: goodsTokens.length, bonus, total: goods + bonus.reduce((a, b) => a + b, 0) };
}

export type SaleOption = {
  kind: Good;
  /** How many cards the sale would move: the selected cards when they are all of this kind, else every card of the kind. */
  cards: number;
  /** The goods tokens the sale would take, summed. */
  base: number;
  /** The bonus range a sale of this size may add ("1–3"), or null when none is left or the sale is too small. */
  bonus: string | null;
  /** Whether the rules allow it (a single diamond, gold or silver does not sell). */
  legal: boolean;
  why?: string;
  /** Set by the host when the phone may start this sale now: the control id to send. */
  control?: string;
};

const PRECIOUS: ReadonlySet<string> = new Set(['diamond', 'gold', 'silver']);

/** One entry per good kind in the hand, in the hand's order, whether or not
 *  it is this player's turn: the phone shows the value of each potential
 *  sale as planning information. */
export function saleOptions(round: RoundState | null, uid: string, selectedIds: readonly string[] = []): SaleOption[] {
  if (!round) return [];
  const hand = round.hands[uid] ?? [];
  const selected = hand.filter((c) => selectedIds.includes(c.id));
  const out: SaleOption[] = [];
  for (const card of hand) {
    if (card.kind === 'camel' || out.some((o) => o.kind === card.kind)) continue;
    const kind = card.kind;
    const ofKind = hand.filter((c) => c.kind === kind).length;
    const cards = selected.length > 0 && selected.every((c) => c.kind === kind) ? selected.length : ofKind;
    const base = round.goodsTokens[kind].slice(0, cards).reduce((sum, t) => sum + t.value, 0);
    const size = cards >= 5 ? '5' : cards === 4 ? '4' : cards === 3 ? '3' : null;
    const range = size && round.bonusTokens[size].length > 0 ? bonusValueRange(size) : null;
    const legal = cards > 0 && !(PRECIOUS.has(kind) && cards < 2);
    out.push({
      kind, cards, base,
      bonus: range ? `${range.min}–${range.max}` : null,
      legal,
      ...(legal ? {} : { why: `${kind[0].toUpperCase()}${kind.slice(1)} sells two at a time or more` })
    });
  }
  return out;
}
