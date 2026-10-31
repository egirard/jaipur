// Per-seat bearer tokens for the AR seat QRs (GPLv3, part of this fork).
//
// A seat QR's URL carries ?seat=TOKEN. The relay treats the token as an
// opaque string — it routes that seat's private scene to the viewers
// holding it and stamps it on their actions — and only the table maps
// tokens to seats. A token is "<seat>-<8 random letters>" with an
// independent secret per seat, so a phone that scanned seat 1 cannot reach
// seat 2's hand by editing the number (with plain "1"/"2" tokens the
// session code alone opened both hands). The viewer reads the seat number
// off the front for its labels. Tokens are remembered per session in
// localStorage so a reload keeps the printed QRs valid and reconnecting
// phones keep their seat.

export type SeatNo = '1' | '2';
export type SeatTokens = Record<SeatNo, string>;

export const SEAT_NOS: readonly SeatNo[] = ['1', '2'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_SHAPE = /^[12]-[A-HJ-NP-Z2-9]{8}$/;

export function makeSeatToken(seat: SeatNo, random: Uint8Array = crypto.getRandomValues(new Uint8Array(8))): string {
  return `${seat}-${[...random].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

export function makeSeatTokens(): SeatTokens {
  return { '1': makeSeatToken('1'), '2': makeSeatToken('2') };
}

/** The seat a token opens, by exact match; anything else (a bare "1", a
 *  token from another session) is nobody's seat. */
export function seatOfToken(token: string | null | undefined, tokens: SeatTokens): SeatNo | null {
  if (!token) return null;
  for (const seat of SEAT_NOS) if (tokens[seat] === token) return seat;
  return null;
}

export function isSeatTokens(value: unknown): value is SeatTokens {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return SEAT_NOS.every((seat) => typeof v[seat] === 'string' && TOKEN_SHAPE.test(v[seat] as string) && (v[seat] as string).startsWith(seat));
}

const storageKey = (session: string) => `jaipur:ar:seat-tokens:${session}`;

/** The session's seat tokens: the remembered pair, or a fresh pair that is
 *  remembered from now on. */
export function loadSeatTokens(session: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null): SeatTokens {
  const key = storageKey(session);
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
    if (isSeatTokens(parsed)) return parsed;
  } catch { /* unreadable: issue new tokens */ }
  const fresh = makeSeatTokens();
  try { storage?.setItem(key, JSON.stringify(fresh)); } catch { /* storage blocked: tokens last this page load */ }
  return fresh;
}
