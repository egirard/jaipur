/** The table's own keyboard for the "Play without phone" name field: a
 *  kiosk screen has no system keyboard to pop up. Pure key logic here (the
 *  Svelte component draws it); labels are plain text or SVG, never a glyph
 *  a bare Linux font set might lack. */

export type KeyAction = 'shift' | 'backspace' | 'space' | 'done';
export type KeyboardKey = { key: string; action?: KeyAction; span: number };

/** Five rows on a 20-column grid (a letter is 2 wide); the home row sits
 *  in by a column each side, as on a typewriter. */
export type KeyboardRow = { keys: KeyboardKey[]; inset: number };
const letters = (keys: string): KeyboardKey[] => [...keys].map((key) => ({ key, span: 2 }));
export const KEYBOARD_ROWS: KeyboardRow[] = [
  { inset: 0, keys: letters('1234567890') },
  { inset: 0, keys: letters('qwertyuiop') },
  { inset: 1, keys: letters('asdfghjkl') },
  { inset: 0, keys: [{ key: 'shift', action: 'shift', span: 3 }, ...letters('zxcvbnm'), { key: 'backspace', action: 'backspace', span: 3 }] },
  { inset: 0, keys: [...letters("'-"), { key: 'space', action: 'space', span: 12 }, { key: 'done', action: 'done', span: 4 }] }
];

/** A name capitalises each word on its own (autocapitalize="words");
 *  shift inverts that for the next letter. */
export const atWordStart = (value: string) => value.length === 0 || value.endsWith(' ');
export const upperNext = (value: string, shift: boolean) => shift !== atWordStart(value);

export type KeyboardState = { value: string; shift: boolean };

export function pressKey(state: KeyboardState, pressed: KeyboardKey, maxLength = 32): KeyboardState {
  const { value, shift } = state;
  switch (pressed.action) {
    case 'shift': return { value, shift: !shift };
    case 'backspace': return { value: value.slice(0, -1), shift };
    case 'done': return state;
    case 'space':
      // No leading or doubled spaces: the name is trimmed on sitting anyway.
      if (atWordStart(value) || value.length >= maxLength) return state;
      return { value: `${value} `, shift };
    default: {
      if (value.length >= maxLength) return { value, shift: false };
      const char = upperNext(value, shift) ? pressed.key.toUpperCase() : pressed.key;
      return { value: value + char, shift: false };
    }
  }
}
