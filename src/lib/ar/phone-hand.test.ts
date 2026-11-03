import { describe, expect, it } from 'vitest';
import { setupRound } from '../jaipur-rules';
import { phoneScore, saleOptions } from './phoneHand';

const card = (id: string, kind: string) => ({ id, kind: kind as never });

function round() {
  const r = setupRound(['a', 'b'], 'seed', 'a');
  r.hands.a = [card('h1', 'cloth'), card('h2', 'diamond'), card('h3', 'cloth'), card('h4', 'cloth'), card('h5', 'camel')];
  r.ownedGoodsTokens.a = [{ id: 'g1', kind: 'cloth', value: 5 }, { id: 'g2', kind: 'leather', value: 4 }];
  r.ownedBonusTokens.a = [{ id: 'b1', kind: 'bonus-3', value: 2 }, { id: 'b2', kind: 'bonus-4', value: 6 }];
  r.hands.b = [];
  return r;
}

describe('phone score', () => {
  it('splits the face-up goods total from each hidden bonus value', () => {
    expect(phoneScore(round(), 'a')).toEqual({ goodsTokens: [{ kind: 'cloth', value: 5 }, { kind: 'leather', value: 4 }], goods: 9, goodsCount: 2, bonus: [2, 6], total: 17 });
    expect(phoneScore(round(), 'b')).toEqual({ goodsTokens: [], goods: 0, goodsCount: 0, bonus: [], total: 0 });
    expect(phoneScore(null, 'a').total).toBe(0);
  });
});

describe('sale options', () => {
  it('prices every good in the hand, in hand order, whether or not it is the turn', () => {
    const r = round();
    const opts = saleOptions(r, 'a');
    expect(opts.map((o) => o.kind)).toEqual(['cloth', 'diamond']);
    const cloth = opts[0];
    expect(cloth.cards).toBe(3);
    expect(cloth.base).toBe(r.goodsTokens.cloth.slice(0, 3).reduce((s, t) => s + t.value, 0)); // 5+3+3
    expect(cloth.bonus).toBe('1–3');
    expect(cloth.legal).toBe(true);
    const diamond = opts[1];
    expect(diamond).toMatchObject({ cards: 1, base: 7, bonus: null, legal: false });
    expect(diamond.why).toContain('two at a time');
    expect(saleOptions(r, 'b')).toEqual([]);
  });

  it('prices the selection when it is all of one kind, and drops the bonus once that stack is empty', () => {
    const r = round();
    expect(saleOptions(r, 'a', ['h1', 'h3'])[0]).toMatchObject({ kind: 'cloth', cards: 2, bonus: null });
    expect(saleOptions(r, 'a', ['h1', 'h2'])[0].cards).toBe(3); // mixed selection: the whole kind
    r.bonusTokens['3'] = [];
    expect(saleOptions(r, 'a')[0].bonus).toBeNull();
  });
});
