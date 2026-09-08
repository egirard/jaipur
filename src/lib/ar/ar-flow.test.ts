import { describe, expect, it } from 'vitest';
import { reduceGame, legalSingleGoods } from '../jaipur-rules';
import type { GameEvent } from '../game-events';

// Verifies the game-logic changes the AR loop depends on, through the SAME
// pure reducer the app runs (no browser/emulator needed):
//  1. solitaire mode seats the bot on seat 1 (it starts the round),
//  2. the table seats an AR phone on its behalf (player/joined with a
//     host-chosen playerUid) — the phone never writes to the store, and
//  3. the table acts on behalf of a seated player (its own on-screen
//     controls emit these) and the turn passes.
const ev = (id: string, type: GameEvent['type'], actorUid: string, payload: Record<string, unknown>): GameEvent => ({
  id, type, actorUid, payload,
  clientSeq: 1, createdAtMillis: Number(id.match(/\d+/)?.[0] ?? 1),
  schemaVersion: 1, reducerVersion: 1,
});

const solitaireSetup = [
  ev('t-1', 'tabletop/created', 'table', { gameId: 'table' }),
  ev('t-2', 'bot/added', 'table', { botUid: 'bot', displayName: 'Boring Bot', difficulty: 'apprentice', engineVersion: 1, seat: 1 }),
  // The AR join: written by the TABLE for the phone that scanned seat 2's QR.
  ev('t-3', 'player/joined', 'table', { displayName: 'You', seat: 2, playerUid: 'human' }),
  ev('t-4', 'player/ready', 'table', { playerUid: 'human', ready: true }),
  ev('t-5', 'round/started', 'table', { seed: 'ar-flow', starterUid: 'bot' }),
];

describe('AR solitaire flow (phone joins over the relay, table acts)', () => {
  it('seats the bot on seat 1 and starts the round with the bot active', () => {
    const g = reduceGame(solitaireSetup);
    const bot = g.players.find((p) => p.uid === 'bot');
    expect(bot).toMatchObject({ seat: 1, ready: true });
    expect(g.mode).toBe('tabletop');
    expect(g.round?.status).toBe('active');
    expect(g.round?.activeUid).toBe('bot'); // seat 1 starts, upright seat 2 is the human
  });

  it('lets the table seat an AR phone on its behalf, attributed to the player', () => {
    const g = reduceGame(solitaireSetup.slice(0, 4));
    expect(g.players.find((p) => p.seat === 2)).toMatchObject({ uid: 'human', displayName: 'You', ready: true });
    expect(g.activity.find((a) => a.type === 'player/joined')?.actorUid).toBe('human');
    expect(g.diagnostics).toEqual([]);
  });

  it('refuses on-behalf joins that are not from the tabletop host, or collide', () => {
    const notHost = reduceGame([
      ...solitaireSetup.slice(0, 2),
      ev('x-3', 'player/joined', 'stranger', { displayName: 'Eve', seat: 2, playerUid: 'human' }),
    ]);
    // A non-host's playerUid is ignored: they join as themselves.
    expect(notHost.players.find((p) => p.seat === 2)?.uid).toBe('stranger');
    const selfUid = reduceGame([
      ...solitaireSetup.slice(0, 2),
      ev('t-3', 'player/joined', 'table', { displayName: 'Me', seat: 2, playerUid: 'table' }),
    ]);
    expect(selfUid.players.find((p) => p.seat === 2)).toBeUndefined();
    const twice = reduceGame([
      ...solitaireSetup.slice(0, 4),
      ev('t-9', 'player/joined', 'table', { displayName: 'Again', seat: 2, playerUid: 'human' }),
    ]);
    expect(twice.players).toHaveLength(2);
  });

  it('accepts an on-table private-card selection for the active seat only', () => {
    const g = reduceGame(solitaireSetup);
    const humanCard = g.round!.hands.human[0];
    const offTurn = reduceGame([
      ...solitaireSetup,
      ev('t-6', 'tabletop/intent', 'table', {
        playerUid: 'human', selectedReturnIds: [humanCard.id], exchangeLoads: {},
        roundNumber: 1, turnNumber: 1,
      }),
    ]);
    expect(offTurn.tabletopIntents.human).toBeUndefined(); // bot is active
  });

  it('accepts a table-driven take for the active seat and passes the turn', () => {
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

    // The human taps a market card ON THE TABLE -> the table writes the take
    // on the human's behalf (what chooseMarket/confirmPendingDraw emit).
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
