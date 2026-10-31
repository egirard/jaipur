import { describe, expect, it } from 'vitest';
import { isSeatTokens, loadSeatTokens, makeSeatToken, seatOfToken } from './seatTokens';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe('seat tokens', () => {
  it('prefix the seat number and carry eight letters from the QR alphabet', () => {
    const t = makeSeatToken('2', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(t).toBe('2-ABCDEFGH');
    expect(isSeatTokens({ '1': makeSeatToken('1'), '2': makeSeatToken('2') })).toBe(true);
  });

  it('open a seat only by exact match — a bare number or a foreign token is nobody', () => {
    const tokens = { '1': '1-ABCDEFGH', '2': '2-JKMNPQRS' } as const;
    expect(seatOfToken('1-ABCDEFGH', tokens)).toBe('1');
    expect(seatOfToken('2-JKMNPQRS', tokens)).toBe('2');
    expect(seatOfToken('1', tokens)).toBeNull();
    expect(seatOfToken('2-ABCDEFGH', tokens)).toBeNull();
    expect(seatOfToken(undefined, tokens)).toBeNull();
  });

  it('are remembered per session, and reissued when the stored pair is malformed', () => {
    const storage = new MemoryStorage();
    const first = loadSeatTokens('ABCDEF', storage);
    expect(loadSeatTokens('ABCDEF', storage)).toEqual(first);
    expect(loadSeatTokens('OTHER1', storage)).not.toEqual(first);
    storage.setItem('jaipur:ar:seat-tokens:ABCDEF', JSON.stringify({ '1': '1', '2': '2' }));
    const reissued = loadSeatTokens('ABCDEF', storage);
    expect(reissued).not.toEqual(first);
    expect(isSeatTokens(reissued)).toBe(true);
    expect(loadSeatTokens('NOSTORE', null)['1']).toMatch(/^1-/);
  });
});
