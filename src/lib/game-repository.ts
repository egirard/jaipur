// DEPRECATED (2026-10-30, see DEPRECATIONS.md): the Firebase channel is no
// longer part of the supported product. The AR tabletop keeps the game in
// the browser-local store and phones join over the AR relay; this Firestore event store is
// kept only for the legacy two-browser game (/), and will be removed with
// it (the /hand controller was retired on 2026-11-03).
import {
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  type Firestore,
  type Timestamp,
  type Unsubscribe
} from 'firebase/firestore';
import {
  REDUCER_VERSION,
  SCHEMA_VERSION,
  type GameEvent,
  type GameEventType
} from './game-events';

interface StoredEvent {
  type: GameEventType;
  payload: Record<string, unknown>;
  actorUid: string;
  clientSeq: number;
  createdAt?: Timestamp;
  schemaVersion: number;
  reducerVersion: number;
}

export interface GameRepository {
  append: (type: GameEventType, payload: Record<string, unknown>) => Promise<void>;
  subscribe: (
    onEvents: (events: GameEvent[]) => void,
    onError: (error: Error) => void,
    onStatus?: (status: 'offline' | 'syncing' | 'synced') => void
  ) => Unsubscribe;
  disconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
}

const compareRemoteEvents = (left: GameEvent, right: GameEvent) =>
  left.createdAtMillis - right.createdAtMillis || left.id.localeCompare(right.id);

const comparePendingEvents = (left: GameEvent, right: GameEvent) =>
  left.clientSeq - right.clientSeq || left.id.localeCompare(right.id);

export function orderEventStream(remote: GameEvent[], pending: GameEvent[]): GameEvent[] {
  const remoteIds = new Set(remote.map(({ id }) => id));
  return [
    ...[...remote].sort(compareRemoteEvents),
    ...pending.filter(({ id }) => !remoteIds.has(id)).sort(comparePendingEvents)
  ];
}

export async function gameRoomExists(db: Firestore, gameId: string): Promise<boolean> {
  const snapshot = await getDocs(
    query(collection(db, 'games', gameId, 'events'), limit(1))
  );
  return !snapshot.empty;
}

export function createGameRepository(
  db: Firestore,
  gameId: string,
  actorUid: string
): GameRepository {
  const stream = collection(db, 'games', gameId, 'events');
  const sequenceKey = `jaipur:${gameId}:${actorUid}:client-seq`;
  const cacheKey = `jaipur:${gameId}:event-cache:v1`;
  let pending: GameEvent[] = [];
  let remote: GameEvent[] = [];
  let notify: ((events: GameEvent[]) => void) | undefined;

  const ordered = () => orderEventStream(remote, pending);

  return {
    async append(type, payload) {
      const clientSeq = Number(localStorage.getItem(sequenceKey) ?? '0') + 1;
      const eventId = `${actorUid}-${String(clientSeq).padStart(8, '0')}`;
      localStorage.setItem(sequenceKey, String(clientSeq));
      pending.push({
        id: eventId,
        type,
        payload,
        actorUid,
        clientSeq,
        createdAtMillis: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        reducerVersion: REDUCER_VERSION
      });
      notify?.(ordered());
      try {
        await setDoc(doc(stream, eventId), {
          type,
          payload,
          actorUid,
          clientSeq,
          createdAt: serverTimestamp(),
          schemaVersion: SCHEMA_VERSION,
          reducerVersion: REDUCER_VERSION
        });
      } catch (error) {
        pending = pending.filter(({ id }) => id !== eventId);
        notify?.(ordered());
        throw error;
      }
    },

    subscribe(onEvents, onError, onStatus) {
      notify = onEvents;
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) ?? '[]') as GameEvent[];
        if (Array.isArray(cached) && cached.length > 0) {
          remote = cached;
          onEvents(ordered());
          onStatus?.('syncing');
        }
      } catch {
        localStorage.removeItem(cacheKey);
      }
      return onSnapshot(
        stream,
        { includeMetadataChanges: true },
        (snapshot) => {
          remote = snapshot.docs
            .filter((snapshotDocument) => !snapshotDocument.metadata.hasPendingWrites)
            .map((snapshotDocument): GameEvent => {
              const value = snapshotDocument.data() as StoredEvent;
              return {
                id: snapshotDocument.id,
                type: value.type,
                payload: value.payload,
                actorUid: value.actorUid,
                clientSeq: value.clientSeq,
                createdAtMillis: value.createdAt?.toMillis() ?? 0,
                schemaVersion: value.schemaVersion,
                reducerVersion: value.reducerVersion
              };
            });
          const remoteIds = new Set(remote.map(({ id }) => id));
          pending = pending.filter(({ id }) => !remoteIds.has(id));
          localStorage.setItem(cacheKey, JSON.stringify(remote));
          localStorage.setItem(`${cacheKey}:cursor`, remote.at(-1)?.id ?? '');
          onEvents(ordered());
          onStatus?.(
            snapshot.metadata.fromCache
              ? 'offline'
              : snapshot.metadata.hasPendingWrites
                ? 'syncing'
                : 'synced'
          );
        },
        (error) => onError(error)
      );
    },

    async disconnect() {
      await disableNetwork(db);
    },

    async reconnect() {
      await enableNetwork(db);
    }
  };
}
