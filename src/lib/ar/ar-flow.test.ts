import { describe, expect, it } from 'vitest';
import { reduceGame, legalSingleGoods } from '../jaipur-rules';
import type { GameEvent } from '../game-events';

// Verifies the two game-logic changes the AR loop depends on, through the
// SAME pure reducer the app runs (no browser/emulator needed):
//  1. solitaire mode seats the bot on seat 1 (it starts the round), and
//  2. an AR tap that the table maps to a take (cards/taken-one on behalf of
//     the tapping seat) is accepted and advances the turn.
const ev = (id: string, type: GameEvent['type'], actorUid: string, payload: Record<string, unknown>): GameEvent => ({
  id, type, actorUid, payload,
  clientSeq: 1, createdAtMillis: Number(id.match(/\d+/)?.[0] ?? 1),
  schemaVersion: 1, reducerVersion: 1,
});

const solitaireSetup = [
  ev('t-1', 'tabletop/created', 'table', { gameId: 'table' }),
  ev('t-2', 'bot/added', 'table', { botUid: 'bot', displayName: 'Boring Bot', difficulty: 'apprentice', engineVersion: 1, seat: 1 }),
  ev('h-3', 'player/joined', 'human', { displayName: 'You', seat: 2 }),
  ev('h-4', 'player/ready', 'human', { ready: true }),
  ev('t-5', 'round/started', 'table', { seed: 'ar-flow', starterUid: 'bot' }),
];

describe('AR solitaire + tap-to-take flow', () => {
  it('seats the bot on seat 1 and starts the round with the bot active', () => {
    const g = reduceGame(solitaireSetup);
    const bot = g.players.find((p) => p.uid === 'bot');
    expect(bot).toMatchObject({ seat: 1, ready: true });
    expect(g.mode).toBe('tabletop');
    expect(g.round?.status).toBe('active');
    expect(g.round?.activeUid).toBe('bot'); // seat 1 starts, upright seat 2 is the human
  });

  it('accepts an AR-driven take for the active seat and passes the turn', () => {
    // Bot (seat 1) takes first — the host writes it on the bot's behalf.
    const afterBot = [
      ...solitaireSetup,
      ev('t-6', 'cards/taken-one', 'table', {
        playerUid: 'bot',
        cardId: legalSingleGoods(reduceGame(solitaireSetup).round!, 'bot')[0].id,
        roundNumber: 1, turnNumber: 1,
      }),
    ];
    const midState = reduceGame(afterBot);
    expect(midState.round?.activeUid).toBe('human'); // now the human's turn

    // The human taps a market card in AR -> table maps it to a take on the
    // human's behalf (exactly what handleArTap -> chooseMarket/confirm emit).
    const humanCard = legalSingleGoods(midState.round!, 'human')[0];
    const afterHuman = reduceGame([
      ...afterBot,
      ev('t-7', 'cards/taken-one', 'table', {
        playerUid: 'human',
        cardId: humanCard.id,
        roundNumber: 1, turnNumber: midState.round!.turnNumber,
      }),
    ]);
    expect(afterHuman.round?.hands.human).toContainEqual(humanCard);
    expect(afterHuman.round?.activeUid).toBe('bot'); // turn returns to the bot
  });
});
