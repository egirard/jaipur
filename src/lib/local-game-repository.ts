// Browser-local event store (GPLv3, part of this fork).
//
// The AR tabletop is the only writer in AR mode — phones join and watch
// over the AR relay and never touch the game store — so a single table can
// run a complete game with its events kept in this browser's localStorage.
// That lets the hosted fork be tried from a public URL with no Firebase
// project configured (`/tt/?local=1`, or automatically when the build has
// no Firebase config). Same interface as the Firestore repository.

import {
  REDUCER_VERSION,
  SCHEMA_VERSION,
  type GameEvent,
  type GameEventType
} from './game-events';
import type { GameRepository } from './game-repository';

const eventsKey = (gameId: string) => `jaipur:local:${gameId}:events:v1`;

function readEvents(gameId: string): GameEvent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(eventsKey(gameId)) ?? '[]');
    return Array.isArray(parsed) ? (parsed as GameEvent[]) : [];
  } catch {
    return [];
  }
}

/** A stable per-browser host identity (no auth involved). */
export function localHostUid(): string {
  const key = 'jaipur:local:host-uid';
  let uid = localStorage.getItem(key);
  if (!uid) {
    uid = `local-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    localStorage.setItem(key, uid);
  }
  return uid;
}

export function localGameRoomExists(gameId: string): boolean {
  return readEvents(gameId).length > 0;
}

export function createLocalGameRepository(gameId: string, actorUid: string): GameRepository {
  let events = readEvents(gameId);
  let clientSeq = events.filter((event) => event.actorUid === actorUid).length;
  let notify: ((events: GameEvent[]) => void) | undefined;
  const key = eventsKey(gameId);

  // Other tabs of this browser on the same game (e.g. a second tabletop
  // window) see appends through the storage event.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key) return;
    events = readEvents(gameId);
    notify?.([...events]);
  };

  return {
    async append(type, payload) {
      clientSeq += 1;
      const event: GameEvent = {
        id: `${actorUid}-${String(clientSeq).padStart(8, '0')}`,
        type,
        payload,
        actorUid,
        clientSeq,
        createdAtMillis: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        reducerVersion: REDUCER_VERSION
      };
      events = [...events, event];
      localStorage.setItem(key, JSON.stringify(events));
      notify?.([...events]);
    },

    subscribe(onEvents, _onError, onStatus) {
      notify = onEvents;
      addEventListener('storage', onStorage);
      onEvents([...events]);
      onStatus?.('synced');
      return () => {
        removeEventListener('storage', onStorage);
        notify = undefined;
      };
    },

    async disconnect() {},
    async reconnect() {}
  };
}
