import { describe, expect, it } from 'vitest';
import { KEYBOARD_ROWS, pressKey, upperNext, type KeyboardKey, keyboardRows } from './on-screen-keyboard';

const letter = (key: string): KeyboardKey => ({ key, span: 2 });
const action = (key: 'shift' | 'backspace' | 'space' | 'done'): KeyboardKey => ({ key, action: key, span: 2 });
const type = (text: string, start = { value: '', shift: false }) =>
  [...text].reduce((state, ch) => pressKey(state, ch === ' ' ? action('space') : letter(ch)), start);

describe('on-screen keyboard', () => {
  it('lays every row out on the same 20-column grid', () => {
    for (const row of KEYBOARD_ROWS) expect(row.inset * 2 + row.keys.reduce((n, k) => n + k.span, 0)).toBe(20);
  });

  it('capitalises the first letter of each word on its own', () => {
    expect(type('asha ravi').value).toBe('Asha Ravi');
  });

  it('shift inverts the case of the next letter only', () => {
    expect(upperNext('', false)).toBe(true);
    expect(upperNext('', true)).toBe(false);
    const lower = pressKey(pressKey({ value: '', shift: false }, action('shift')), letter('d'));
    expect(lower).toEqual({ value: 'd', shift: false });
    const upper = type('ab', pressKey({ value: 'Mc', shift: false }, action('shift')));
    expect(upper.value).toBe('McAb');
  });

  it('allows no leading or doubled spaces and deletes one character at a time', () => {
    expect(type(' a  b').value).toBe('A B');
    expect(pressKey({ value: 'Asha', shift: true }, action('backspace'))).toEqual({ value: 'Ash', shift: true });
    expect(pressKey({ value: '', shift: false }, action('backspace')).value).toBe('');
  });

  it('stops at the name length limit', () => {
    const full = type('abcdefgh', { value: '', shift: false });
    expect(pressKey(full, letter('x'), 8).value).toBe('Abcdefgh');
    expect(pressKey(full, action('space'), 8).value).toBe('Abcdefgh');
    expect(pressKey(full, action('done'), 8)).toBe(full);
  });
});

describe('address layout', () => {
  it('offers dot, dash, colon and slash instead of space and apostrophe, twenty columns wide', () => {
    const rows = keyboardRows('address');
    const bottom = rows[rows.length - 1];
    expect(bottom.keys.map((k) => k.key)).toEqual(['.', '-', ':', '/', 'done']);
    expect(bottom.keys.reduce((n, k) => n + k.span, 0)).toBe(20);
    expect(rows.slice(0, 4)).toEqual(keyboardRows('name').slice(0, 4));
  });

  it('does not capitalise the first letter unless shift is held', () => {
    const l = { key: 'l', span: 2 };
    expect(pressKey({ value: '', shift: false }, l, 64, false).value).toBe('l');
    expect(pressKey({ value: '', shift: true }, l, 64, false).value).toBe('L');
    expect(pressKey({ value: '192.168.1.', shift: false }, { key: '2', span: 2 }, 64, false).value).toBe('192.168.1.2');
  });
});
