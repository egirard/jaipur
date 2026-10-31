<script lang="ts">
  // DEPRECATED (2026-10-30, see DEPRECATIONS.md): the legacy two-browser game over Firestore; the supported product is the AR tabletop at /tt. Kept until removed; not maintained.
  import '@fontsource/atkinson-hyperlegible/400.css';
  import '@fontsource/atkinson-hyperlegible/700.css';
  import '@fontsource/cormorant-garamond/700.css';
  import { replaceState } from '$app/navigation';
  import { assets as assetBase } from '$app/paths';
  import { onMount, tick } from 'svelte';
  import { initializeFirebase } from '$lib/firebase';
  import {
    createGameRepository,
    gameRoomExists,
    type GameRepository
  } from '$lib/game-repository';
  import PieceArt from '$lib/PieceArt.svelte';
  import GameSummary from '$lib/GameSummary.svelte';
  import StableMarketLayout from '$lib/StableMarketLayout.svelte';
  import TokenChip from '$lib/TokenChip.svelte';
  import TokenStack from '$lib/TokenStack.svelte';
  import StrongBotWorker from '$lib/jaipur-bot.worker?worker';
  import type { StrongBotRequest, StrongBotResponse } from '$lib/jaipur-bot.worker';
  import {
    botActionEvent,
    botEngineVersion,
    chooseBotAction,
    createBotObservation,
    type BotObservation,
    type JaipurAction
  } from '$lib/jaipur-bot';
  import {
    isLegalExchange,
    isLegalSale,
    reduceGame,
    type Card,
    type GameState,
    type Good,
    type PendingDraw,
    type Token
  } from '$lib/jaipur-rules';
  import { generateRoomCode, isRoomCode, normalizeRoomCode } from '$lib/room-code';
  import type { BotDifficulty, GameActivity } from '$lib/game-events';

  type ActionMovementPlan = {
    activityId: string;
    cardId: string;
    kind: Good | 'camel' | 'card-back';
    sourceBox: DOMRect;
    destinationSelector: string;
    delay: number;
    concealDestination: boolean;
    revealKind?: Good | 'camel';
  };

  let status = $state<
    'connecting' | 'syncing' | 'synced' | 'offline' | 'conflict' | 'incompatible' | 'error'
  >('connecting');
  let statusText = $state('Connecting to Firebase…');
  let uid = $state('');
  let requestedGameId = $state('');
  let displayName = $state('');
  let lobby = $state<GameState>(reduceGame([]));
  let repository = $state<GameRepository>();
  let busy = $state(false);
  let pendingDraw = $derived<PendingDraw | null>(lobby.pendingDraw);
  let shellOnly = $state(true);
  let exchangeLoads = $state<Record<string, string>>({});
  let returnFlights = $state<Array<{
    key: number;
    marketCardId: string;
    cardId: string;
    kind: Good | 'camel';
    label: string;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
  }>>([]);
  let returnFlightSequence = 0;
  let tokenFlights = $state<Array<{
    key: number;
    token: Token;
    recipientUid: string;
    hidden: boolean;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
    delay: number;
  }>>([]);
  let tokenFlightSequence = 0;
  let actionCardFlights = $state<Array<{
    key: number;
    activityId: string;
    cardId: string;
    kind: Good | 'camel' | 'card-back';
    revealKind?: Good | 'camel';
    concealsDestination: boolean;
    label: string;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
    delay: number;
  }>>([]);
  let actionFlightSequence = 0;
  let arrivingCardIds = $state<string[]>([]);
  let animatedActivityIds = new Set<string>();
  let actionNotice = $state<{ key: number; text: string } | null>(null);
  let actionNoticeSequence = 0;
  let actionNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let logPage = $state(0);
  let repositorySnapshotReady = false;
  let animatedTokenAwardIds = new Set<string>();
  let activeExchangeTarget = $state<string | null>(null);
  let botThinking = $state(false);
  let botDifficulty = $state<BotDifficulty>('apprentice');
  let scheduledBotTurnKey = '';
  let botTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let activeBotWorker: Worker | undefined;
  let cancelActiveBotSearch: (() => void) | undefined;
  let selectedHand = $state<string[]>([]);
  let selectedCamelId = $state<string | null>(null);
  let draggedReturnId = $state<string | null>(null);
  let draggedReturnSource = $state<'hand' | 'camel' | null>(null);
  let pointerReturnDrag = $state<{
    cardId: string;
    source: 'hand' | 'camel';
    pointerId: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    moved: boolean;
  } | null>(null);
  let suppressReturnClickId = $state<string | null>(null);
  const goods: Good[] = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather'];
  const bonusSizes = ['3', '4', '5'] as const;
  const componentImage = (kind: Good | 'camel' | 'seal' | 'card-back') =>
    `${assetBase}/components/${kind}.webp`;
  const opponentPlayer = () => lobby.players.find((player) => player.uid !== uid);
  const opponentUid = () => opponentPlayer()?.uid ?? '';
  const opponentHandCount = () => lobby.round?.hands[opponentUid()]?.length ?? 0;
  const opponentTokenCount = () =>
    (lobby.round?.ownedGoodsTokens[opponentUid()]?.length ?? 0) +
    (lobby.round?.ownedBonusTokens[opponentUid()]?.length ?? 0);
  const buildHash = (import.meta.env.VITE_GIT_HASH ?? 'local').slice(0, 7);

  onMount(async () => {
    try {
      const params = new URLSearchParams(location.search);
      requestedGameId = normalizeRoomCode(params.get('gameId') ?? '');
      shellOnly = !requestedGameId;
      const services = await initializeFirebase();
      uid = services.auth.currentUser?.uid ?? '';
      const savedName = localStorage.getItem(`jaipur:${requestedGameId}:${uid}:name`);
      if (requestedGameId && savedName) {
        displayName = savedName;
        attachRepository(services.db);
      }
      status = 'synced';
      if (!savedName) {
        statusText =
          import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'
            ? 'Firebase emulator ready'
            : 'Firebase ready';
      }
    } catch (error) {
      showError(error);
    }
  });

  function showError(error: unknown) {
    status = 'error';
    statusText = error instanceof Error ? error.message : 'Firebase unavailable';
  }

  function attachRepository(db: Awaited<ReturnType<typeof initializeFirebase>>['db']) {
    repositorySnapshotReady = false;
    animatedTokenAwardIds = new Set();
    animatedActivityIds = new Set();
    tokenFlights = [];
    actionCardFlights = [];
    actionNotice = null;
    const attached = createGameRepository(db, requestedGameId.trim(), uid);
    repository = attached;
    attached.subscribe(
      (events) => {
        const nextLobby = reduceGame(events);
        const newActivities = repositorySnapshotReady
          ? nextLobby.activity.filter(({ id }) => !animatedActivityIds.has(id))
          : [];
        const movementPlans = newActivities.flatMap((activity) =>
          captureActionMovements(lobby, nextLobby, activity)
        );
        const tokenAwards = repositorySnapshotReady
          ? captureTokenAwards(lobby, nextLobby)
          : [];
        lobby = nextLobby;
        scheduleBotTurn();
        if (!repositorySnapshotReady) {
          rememberOwnedTokenAwards(nextLobby);
          rememberActivities(nextLobby);
        } else {
          for (const activity of newActivities) animatedActivityIds.add(activity.id);
        }
        repositorySnapshotReady = true;
        if (movementPlans.length > 0) void startActionCardFlights(movementPlans);
        if (tokenAwards.length > 0) {
          void startTokenFlights(tokenAwards, movementPlans.length > 0 ? 320 : 0);
        }
        if (newActivities.length > 0) {
          logPage = 0;
          showActionNotice(newActivities.at(-1)!);
        }
        if (lobby.diagnostics.some((diagnostic) => diagnostic.includes('incompatible version'))) {
          status = 'incompatible';
          statusText = 'This game contains an incompatible protocol version';
        } else if (lobby.diagnostics.length > 0) {
          status = 'conflict';
          statusText = `${lobby.diagnostics.length} conflicting event${lobby.diagnostics.length === 1 ? '' : 's'} ignored`;
        } else if (status === 'conflict' || status === 'incompatible') {
          status = 'syncing';
          statusText = 'Synchronizing game…';
        }
      },
      showError,
      (repositoryStatus) => {
        if (status === 'conflict' || status === 'incompatible') return;
        status = repositoryStatus === 'offline' ? 'syncing' : repositoryStatus;
        statusText =
          status === 'syncing' ? 'Synchronizing game…' : 'Game synced';
        if (status === 'synced') scheduleBotTurn();
      }
    );
    return attached;
  }

  async function connect(mode: 'create' | 'join' | 'bot') {
    if (!uid || !displayName.trim()) return;
    if (mode === 'join' && !isRoomCode(requestedGameId)) return;
    busy = true;
    try {
      const services = await initializeFirebase();
      if (mode !== 'join' && shellOnly) {
        let attempts = 0;
        do {
          requestedGameId = generateRoomCode();
          attempts += 1;
        } while (attempts < 8 && (await gameRoomExists(services.db, requestedGameId)));
        if (await gameRoomExists(services.db, requestedGameId)) {
          throw new Error('Could not reserve a unique game code. Please try again.');
        }
      }
      if (!isRoomCode(requestedGameId)) return;
      const attached = attachRepository(services.db);
      const requestedSeat = Number(new URLSearchParams(location.search).get('seat'));
      await attached.append(mode === 'join' ? 'player/joined' : 'game/created', {
        gameId: requestedGameId.trim(),
        displayName: displayName.trim(),
        ...(mode === 'join' && (requestedSeat === 1 || requestedSeat === 2)
          ? { seat: requestedSeat }
          : {})
      });
      if (mode === 'bot') await appendBotSeat(attached);
      if (mode === 'join' && (requestedSeat === 1 || requestedSeat === 2)) {
        await attached.append('player/ready', { ready: true });
      }
      localStorage.setItem(`jaipur:${requestedGameId.trim()}:${uid}:name`, displayName.trim());
      shellOnly = false;
      const params = new URLSearchParams(location.search);
      params.set('gameId', requestedGameId.trim());
      replaceState(`?${params.toString()}`, {});
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  function botPlayerUid(): string {
    return `bot-${uid}`;
  }

  const botDifficultyLabel = (difficulty: BotDifficulty) =>
    difficulty === 'maharaja' ? 'Maharaja' : 'Apprentice';

  async function appendBotSeat(target: GameRepository) {
    await target.append('bot/added', {
      botUid: botPlayerUid(),
      displayName: 'Maharaja',
      difficulty: botDifficulty,
      engineVersion: botEngineVersion(botDifficulty)
    });
  }

  async function addComputerOpponent() {
    if (!repository || lobby.hostUid !== uid || lobby.players.length !== 1 || lobby.mode !== 'standard') return;
    busy = true;
    try {
      await appendBotSeat(repository);
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  function currentBotTurnKey(): string {
    const botUid = lobby.bot?.uid;
    const round = lobby.round;
    return botUid && round?.status === 'active' && round.activeUid === botUid
      ? `${lobby.epoch}:${round.number}:${round.turnNumber}`
      : '';
  }

  function scheduleBotTurn() {
    const key = currentBotTurnKey();
    if (!key || !repository || lobby.hostUid !== uid || status === 'offline' || status === 'error') {
      if (botTurnTimer) clearTimeout(botTurnTimer);
      cancelStrongBotSearch();
      botTurnTimer = undefined;
      scheduledBotTurnKey = '';
      botThinking = false;
      return;
    }
    if (scheduledBotTurnKey === key) return;
    if (botTurnTimer) clearTimeout(botTurnTimer);
    cancelStrongBotSearch();
    scheduledBotTurnKey = key;
    botThinking = true;
    botTurnTimer = setTimeout(() => void playBotTurn(key), 450);
  }

  async function playBotTurn(expectedKey: string) {
    botTurnTimer = undefined;
    if (!repository || currentBotTurnKey() !== expectedKey) return;
    if (actionCardFlights.length > 0 || tokenFlights.length > 0) {
      botTurnTimer = setTimeout(() => void playBotTurn(expectedKey), 100);
      return;
    }
    const observation = createBotObservation(lobby);
    const action = observation
      ? lobby.bot?.difficulty === 'maharaja'
        ? await chooseStrongBotAction(expectedKey, observation)
        : chooseBotAction(observation)
      : null;
    if (currentBotTurnKey() !== expectedKey) return;
    if (!observation || !action) {
      scheduledBotTurnKey = '';
      botThinking = false;
      showError(new Error('The computer could not find a legal move'));
      return;
    }
    const event = botActionEvent(observation, action);
    try {
      await repository.append(event.type, event.payload);
    } catch (error) {
      scheduledBotTurnKey = '';
      botThinking = false;
      showError(error);
    }
  }

  function chooseStrongBotAction(
    key: string,
    observation: BotObservation
  ): Promise<JaipurAction | null> {
    cancelStrongBotSearch();
    const worker = new StrongBotWorker();
    activeBotWorker = worker;
    return new Promise((resolve) => {
      const fallback = () => {
        clearTimeout(timeout);
        worker.terminate();
        if (activeBotWorker === worker) activeBotWorker = undefined;
        if (cancelActiveBotSearch === cancel) cancelActiveBotSearch = undefined;
        resolve(chooseBotAction(observation));
      };
      const timeout = setTimeout(fallback, 5000);
      const cancel = () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(null);
      };
      cancelActiveBotSearch = cancel;
      worker.onmessage = (event: MessageEvent<StrongBotResponse>) => {
        if (event.data.key !== key) return;
        clearTimeout(timeout);
        worker.terminate();
        if (activeBotWorker === worker) activeBotWorker = undefined;
        if (cancelActiveBotSearch === cancel) cancelActiveBotSearch = undefined;
        resolve(event.data.action ?? chooseBotAction(observation));
      };
      worker.onerror = () => {
        fallback();
      };
      worker.postMessage({ key, observation } satisfies StrongBotRequest);
    });
  }

  function cancelStrongBotSearch() {
    const cancel = cancelActiveBotSearch;
    cancelActiveBotSearch = undefined;
    activeBotWorker?.terminate();
    activeBotWorker = undefined;
    cancel?.();
  }

  async function toggleReady() {
    const player = lobby.players.find((candidate) => candidate.uid === uid);
    if (!repository || !player) return;
    busy = true;
    try {
      await repository.append('player/ready', { ready: !player.ready });
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function startRound() {
    if (!repository || uid !== lobby.hostUid || lobby.players.length !== 2) return;
    busy = true;
    try {
      const roundNumber = (lobby.round?.number ?? 0) + 1;
      const fixedSeed = new URLSearchParams(location.search).get('seed');
      await repository.append('round/started', {
        seed: fixedSeed
          ? roundNumber === 1
            ? fixedSeed
            : `${fixedSeed}:round:${roundNumber}`
          : crypto.randomUUID(),
        starterUid: lobby.round?.loserUid ?? lobby.players[0].uid,
        roundNumber
      });
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function startRematch() {
    if (!repository || uid !== lobby.hostUid || !lobby.winnerUid) return;
    busy = true;
    try {
      const fixedSeed = new URLSearchParams(location.search).get('seed');
      const nextEpoch = lobby.epoch + 1;
      await repository.append('game/rematched', { epoch: nextEpoch });
      await repository.append('round/started', {
        seed: fixedSeed ? `${fixedSeed}:rematch:${nextEpoch}` : crypto.randomUUID(),
        starterUid: lobby.players[0].uid,
        roundNumber: 1
      });
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function takeOne(cardId: string) {
    if (!repository || lobby.round?.activeUid !== uid) return;
    busy = true;
    try {
      await repository.append('cards/taken-one', {
        cardId,
        roundNumber: lobby.round.number,
        turnNumber: lobby.round.turnNumber
      });
      resetInteractions();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function takeCamels() {
    if (!repository || lobby.round?.activeUid !== uid) return;
    busy = true;
    try {
      await repository.append('cards/taken-camels', {
        roundNumber: lobby.round.number,
        turnNumber: lobby.round.turnNumber
      });
      resetInteractions();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function initiateDraw(card: Card) {
    if (!repository || !lobby.round || lobby.round.activeUid !== uid || pendingDraw || busy) return;
    resetInteractions();
    busy = true;
    try {
      await repository.append('cards/draw-initiated', {
        cardId: card.id,
        roundNumber: lobby.round.number,
        turnNumber: lobby.round.turnNumber
      });
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function abandonPendingDraw() {
    const draw = pendingDraw;
    if (!repository || !lobby.round || !draw || draw.activeUid !== uid || busy) return;
    busy = true;
    try {
      await repository.append('cards/draw-abandoned', {
        roundNumber: draw.roundNumber,
        turnNumber: draw.turnNumber
      });
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function confirmPendingDraw() {
    const draw = pendingDraw;
    if (!draw || draw.activeUid !== uid) return;
    if (draw.kind === 'camels') await takeCamels();
    else await takeOne(draw.cardIds[0]);
  }

  function isPendingDrawCard(cardId: string): boolean {
    return pendingDraw?.cardIds.includes(cardId) ?? false;
  }

  function toggleSelection(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  }

  function resetInteractions() {
    exchangeLoads = {};
    returnFlights = [];
    activeExchangeTarget = null;
    selectedHand = [];
    selectedCamelId = null;
    draggedReturnId = null;
    draggedReturnSource = null;
  }

  function exchangeMarketIds(): string[] {
    return Object.keys(exchangeLoads);
  }

  function exchangeReturnIds(): string[] {
    return Object.values(exchangeLoads);
  }

  function handCard(cardId: string): Card | undefined {
    return lobby.round?.hands[uid]?.find(({ id }) => id === cardId);
  }

  function herdCamel(cardId: string): Card | undefined {
    return lobby.round?.herds[uid]?.find(({ id }) => id === cardId);
  }

  function exchangeReturnCard(marketCardId: string): Card | undefined {
    const returnId = exchangeLoads[marketCardId];
    return returnId ? handCard(returnId) ?? herdCamel(returnId) : undefined;
  }

  function returnCard(cardId: string): Card | undefined {
    return handCard(cardId) ?? herdCamel(cardId);
  }

  function marketGood(cardId: string): Card | undefined {
    return lobby.round?.market.find(({ id, kind }) => id === cardId && kind !== 'camel');
  }

  function availableCamel(marketCardId: string): Card | undefined {
    const currentReturn = exchangeLoads[marketCardId];
    const usedReturns = new Set(
      Object.entries(exchangeLoads)
        .filter(([targetId]) => targetId !== marketCardId)
        .map(([, returnId]) => returnId)
    );
    return [...(lobby.round?.herds[uid] ?? [])]
      .reverse()
      .find(({ id }) => id === currentReturn || !usedReturns.has(id));
  }

  function availableReturnCards(marketCardId: string): Card[] {
    const currentReturn = exchangeLoads[marketCardId];
    const usedReturns = new Set(
      Object.entries(exchangeLoads)
        .filter(([targetId]) => targetId !== marketCardId)
        .map(([, returnId]) => returnId)
    );
    return [
      ...(lobby.round?.hands[uid] ?? []),
      ...(lobby.round?.herds[uid] ?? [])
    ].filter(({ id }) => id === currentReturn || !usedReturns.has(id));
  }

  function assignExchangeReturn(
    marketCardId: string,
    returnCardId: string,
    mode: 'click' | 'drag' = 'click'
  ) {
    if (
      pendingDraw ||
      !marketGood(marketCardId) ||
      (!handCard(returnCardId) && !herdCamel(returnCardId))
    ) {
      return;
    }
    if (mode === 'click') startReturnFlight(marketCardId, returnCardId);
    const nextLoads = Object.fromEntries(
      Object.entries(exchangeLoads).filter(
        ([targetId, loadedReturnId]) =>
          targetId !== marketCardId && loadedReturnId !== returnCardId
      )
    );
    exchangeLoads = { ...nextLoads, [marketCardId]: returnCardId };
    selectedHand = selectedHand.filter((id) => id !== returnCardId);
    if (selectedCamelId === returnCardId) selectedCamelId = null;
    activeExchangeTarget = null;
  }

  function unloadExchange(marketCardId: string) {
    exchangeLoads = Object.fromEntries(
      Object.entries(exchangeLoads).filter(([targetId]) => targetId !== marketCardId)
    );
    returnFlights = returnFlights.filter(
      (flight) => flight.marketCardId !== marketCardId
    );
    if (activeExchangeTarget === marketCardId) activeExchangeTarget = null;
  }

  function startReturnFlight(marketCardId: string, returnCardId: string) {
    const card = returnCard(returnCardId);
    const source = document.querySelector<HTMLElement>(
      `[data-return-source="${CSS.escape(returnCardId)}"]`
    );
    const destination = document.querySelector<HTMLElement>(
      `[data-exchange-target="${CSS.escape(marketCardId)}"]`
    );
    if (!card || !source || !destination) return;

    const sourceBox = source.getBoundingClientRect();
    const destinationBox = destination.getBoundingClientRect();
    const startSize = Math.min(sourceBox.width, sourceBox.height);
    const endSize = Math.min(36, destinationBox.height - 8);
    const startLeft = sourceBox.left + (sourceBox.width - startSize) / 2;
    const startTop = sourceBox.top + (sourceBox.height - startSize) / 2;
    const endLeft = destinationBox.left + (destinationBox.width - endSize) / 2;
    const endTop = destinationBox.top + (destinationBox.height - endSize) / 2;
    const key = ++returnFlightSequence;
    returnFlights = [
      ...returnFlights,
      {
        key,
        marketCardId,
        cardId: returnCardId,
        kind: card.kind,
        label: cardLabel(card.kind),
        startLeft,
        startTop,
        startSize,
        endLeft,
        endTop,
        endSize
      }
    ];
    // `animationend` is the normal cleanup path. Keep a generous fallback for
    // backgrounded or heavily throttled browsers where that event can be late.
    setTimeout(() => finishReturnFlight(key), 3000);
  }

  function finishReturnFlight(key: number) {
    returnFlights = returnFlights.filter((flight) => flight.key !== key);
  }

  function chooseExchangeDrop(marketCardId: string) {
    if (pendingDraw) return;
    if (exchangeLoads[marketCardId]) {
      unloadExchange(marketCardId);
      return;
    }
    const selectedReturn = selectedHand.find(
      (cardId) => !exchangeReturnIds().includes(cardId) && handCard(cardId)
    ) ?? (
      selectedCamelId &&
      !exchangeReturnIds().includes(selectedCamelId) &&
      herdCamel(selectedCamelId)
        ? selectedCamelId
        : undefined
    );
    if (selectedReturn) {
      assignExchangeReturn(marketCardId, selectedReturn);
      return;
    }
    activeExchangeTarget =
      activeExchangeTarget === marketCardId ? null : marketCardId;
  }

  function chooseCamelSource() {
    if (pendingDraw) return;
    if (suppressReturnClickId && herdCamel(suppressReturnClickId)) {
      suppressReturnClickId = null;
      return;
    }
    const camel = selectedCamelId
      ? herdCamel(selectedCamelId)
      : availableCamel(activeExchangeTarget ?? '');
    if (!camel) return;
    if (activeExchangeTarget) {
      assignExchangeReturn(activeExchangeTarget, camel.id);
      return;
    }
    selectedCamelId = selectedCamelId === camel.id ? null : camel.id;
  }

  function chooseHandCard(card: Card) {
    if (pendingDraw) return;
    if (suppressReturnClickId === card.id) {
      suppressReturnClickId = null;
      return;
    }
    const loadedTarget = Object.entries(exchangeLoads).find(
      ([, returnId]) => returnId === card.id
    )?.[0];
    if (loadedTarget) {
      unloadExchange(loadedTarget);
      selectedHand = [...selectedHand, card.id];
      return;
    }
    if (activeExchangeTarget) {
      assignExchangeReturn(activeExchangeTarget, card.id);
      return;
    }
    selectedHand = toggleSelection(selectedHand, card.id);
  }

  function beginReturnPointer(
    event: PointerEvent,
    cardId: string,
    source: 'hand' | 'camel'
  ) {
    if (!event.isPrimary || event.button !== 0 || busy || pendingDraw || status === 'offline') return;
    pointerReturnDrag = {
      cardId,
      source,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      moved: false
    };
  }

  function moveReturnPointer(event: PointerEvent) {
    if (!pointerReturnDrag || event.pointerId !== pointerReturnDrag.pointerId) return;
    const distance = Math.hypot(
      event.clientX - pointerReturnDrag.startX,
      event.clientY - pointerReturnDrag.startY
    );
    if (!pointerReturnDrag.moved && distance < 7) return;
    pointerReturnDrag = {
      ...pointerReturnDrag,
      currentX: event.clientX,
      currentY: event.clientY,
      moved: true
    };
    draggedReturnId = pointerReturnDrag.cardId;
    draggedReturnSource = pointerReturnDrag.source;
    event.preventDefault();
  }

  function finishReturnPointer(event: PointerEvent) {
    if (!pointerReturnDrag || event.pointerId !== pointerReturnDrag.pointerId) return;
    const { cardId, moved } = pointerReturnDrag;
    if (moved) {
      const directTarget = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-exchange-target]');
      const dropTarget = directTarget ?? Array.from(
        document.querySelectorAll<HTMLElement>('[data-exchange-target]')
      ).find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return event.clientX >= box.left && event.clientX <= box.right &&
          event.clientY >= box.top && event.clientY <= box.bottom;
      });
      const marketCardId = dropTarget?.dataset.exchangeTarget;
      if (marketCardId && !dropTarget.matches(':disabled')) {
        assignExchangeReturn(marketCardId, cardId, 'drag');
      }
      suppressReturnClickId = cardId;
      setTimeout(() => {
        if (suppressReturnClickId === cardId) suppressReturnClickId = null;
      });
      event.preventDefault();
    }
    pointerReturnDrag = null;
    draggedReturnId = null;
    draggedReturnSource = null;
  }

  function cancelReturnPointer(event: PointerEvent) {
    if (!pointerReturnDrag || event.pointerId !== pointerReturnDrag.pointerId) return;
    pointerReturnDrag = null;
    draggedReturnId = null;
    draggedReturnSource = null;
  }

  function ownHerdCards(): Card[] {
    const loadedReturns = new Set(exchangeReturnIds());
    return (lobby.round?.herds[uid] ?? []).filter(({ id }) => !loadedReturns.has(id));
  }

  function camelStackStyle(index: number): string {
    const x = index < 3 ? index * 0.42 : 0.84 + (index - 2) * 0.1;
    const y = [0.08, 0, 0.12, 0.04, 0.1][index % 5];
    const rotation = [-7, 4, -2, 7, -4, 2][index % 6];
    return `--camel-x: ${x.toFixed(2)}rem; --camel-y: ${y.toFixed(2)}rem; --camel-rotation: ${rotation}deg; z-index: ${index + 1}`;
  }

  function ownCamelStackStyle(index: number): string {
    const x = index < 3 ? index * 0.72 : 1.44 + (index - 2) * 0.16;
    const y = [0.14, 0.02, 0.18, 0.08, 0.16][index % 5];
    const rotation = [-5, 3, -2, 5, -3, 2][index % 6];
    return `--camel-x: ${x.toFixed(2)}rem; --camel-y: ${y.toFixed(2)}rem; --camel-rotation: ${rotation}deg; z-index: ${index + 1}`;
  }

  function ownCamelStackSpan(): string {
    const count = ownHerdCards().length;
    if (count <= 1) return '0rem';
    const lastIndex = count - 1;
    const span = lastIndex < 3 ? lastIndex * 0.72 : 1.44 + (lastIndex - 2) * 0.16;
    return `${span.toFixed(2)}rem`;
  }

  function projectedHandSize() {
    if (!lobby.round) return 0;
    const handReturns = exchangeReturnIds().filter((id) =>
      lobby.round?.hands[uid]?.some((card) => card.id === id)
    ).length;
    return (lobby.round.hands[uid]?.length ?? 0) - handReturns + exchangeMarketIds().length;
  }

  async function confirmExchange() {
    const selectedMarket = exchangeMarketIds();
    const selectedReturn = exchangeReturnIds();
    if (
      !repository ||
      !lobby.round ||
      pendingDraw ||
      !isLegalExchange(lobby.round, uid, selectedMarket, selectedReturn)
    ) {
      return;
    }
    busy = true;
    try {
      await repository.append('cards/exchanged', {
        takenCardIds: selectedMarket,
        returnedCardIds: selectedReturn,
        roundNumber: lobby.round.number,
        turnNumber: lobby.round.turnNumber
      });
      resetInteractions();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  function saleCardsFor(kind: Good): string[] {
    if (selectedHand.length > 0) return selectedHand;
    return (lobby.round?.hands[uid] ?? [])
      .filter((card) => card.kind === kind)
      .map(({ id }) => id);
  }

  function canSellTo(kind: Good): boolean {
    if (
      busy ||
      pendingDraw ||
      status === 'offline' ||
      lobby.round?.activeUid !== uid ||
      exchangeMarketIds().length > 0 ||
      Boolean(activeExchangeTarget) ||
      Boolean(selectedCamelId) ||
      lobby.round.goodsTokens[kind].length === 0
    ) {
      return false;
    }
    const cardIds = saleCardsFor(kind);
    return (
      cardIds.length > 0 &&
      cardIds.every((cardId) => handCard(cardId)?.kind === kind) &&
      isLegalSale(lobby.round, uid, kind, cardIds)
    );
  }

  function saleActionLabel(kind: Good): string {
    const cardIds = saleCardsFor(kind);
    const selection = selectedHand.length > 0 ? `${cardIds.length} selected` : `all ${cardIds.length}`;
    return `Sell ${selection} ${cardLabel(kind)} to the ${cardLabel(kind)} token stack`;
  }

  async function sellToStack(kind: Good) {
    const cardIds = saleCardsFor(kind);
    if (
      !repository ||
      !lobby.round ||
      pendingDraw ||
      !cardIds.every((cardId) => handCard(cardId)?.kind === kind) ||
      !isLegalSale(lobby.round, uid, kind, cardIds)
    ) {
      return;
    }
    busy = true;
    try {
      await repository.append('cards/sold', {
        kind,
        cardIds,
        roundNumber: lobby.round.number,
        turnNumber: lobby.round.turnNumber
      });
      resetInteractions();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  function playerName(playerUid: string): string {
    return lobby.players.find(({ uid: candidateUid }) => candidateUid === playerUid)?.displayName ?? 'A trader';
  }

  function activityDescription(activity: GameActivity): string {
    const count = activity.cardIds?.length ?? 0;
    const kinds = activity.cardKinds?.map(cardLabel) ?? [];
    let description: string;
    switch (activity.type) {
      case 'game/created':
        description = 'opened the bazaar';
        break;
      case 'bot/added':
        description = 'joined as a client-controlled computer';
        break;
      case 'tabletop/created':
        description = 'opened a tabletop';
        break;
      case 'tabletop/intent':
        description = 'adjusted a private selection';
        break;
      case 'player/joined':
        description = 'joined the bazaar';
        break;
      case 'player/ready':
        description = activity.ready ? 'is ready' : 'is no longer ready';
        break;
      case 'round/started':
        description = `opened round ${activity.roundNumber ?? ''}`;
        if (activity.starterUid) description += ` · ${playerName(activity.starterUid)} starts`;
        break;
      case 'cards/draw-initiated':
        description = 'started a draw';
        break;
      case 'cards/draw-abandoned':
        description = 'cancelled a draw';
        break;
      case 'cards/taken-one':
        description = `took ${kinds[0] ?? 'a good'}`;
        break;
      case 'cards/taken-camels':
        description = `took all ${count} ${count === 1 ? 'camel' : 'camels'}`;
        break;
      case 'cards/exchanged':
        description = `traded ${activity.returnedCardKinds?.map(cardLabel).join(' + ') || `${count} cards`} for ${kinds.join(' + ') || `${count} goods`}`;
        break;
      case 'cards/sold':
        description = `sold ${count} ${kinds[0] ?? 'goods'}${activity.tokenCount ? ` · earned ${activity.tokenCount} ${activity.tokenCount === 1 ? 'token' : 'tokens'}` : ''}`;
        break;
      case 'game/rematched':
        description = 'started a rematch';
        break;
    }
    if (activity.roundWinnerUid) {
      description += ` · ${playerName(activity.roundWinnerUid)} won round ${activity.roundNumber ?? ''}`;
    }
    if (activity.gameWinnerUid) description += ' and the match';
    return description;
  }

  function activityText(activity: GameActivity): string {
    return `${playerName(activity.actorUid)} ${activityDescription(activity)}`;
  }

  const logPageSize = 5;

  function logPageCount(): number {
    return Math.max(1, Math.ceil(lobby.activity.length / logPageSize));
  }

  function visibleLogEntries(): GameActivity[] {
    const start = Math.min(logPage, logPageCount() - 1) * logPageSize;
    return [...lobby.activity].reverse().slice(start, start + logPageSize);
  }

  function showActionNotice(activity: GameActivity) {
    if (actionNoticeTimer) clearTimeout(actionNoticeTimer);
    actionNotice = { key: ++actionNoticeSequence, text: activityText(activity) };
    actionNoticeTimer = setTimeout(() => {
      actionNotice = null;
    }, 2600);
  }

  function rememberActivities(state: GameState) {
    for (const activity of state.activity) animatedActivityIds.add(activity.id);
  }

  function elementBox(selector: string): DOMRect | undefined {
    return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
  }

  function playerHandSelector(playerUid: string): string {
    return `[data-hand-destination="${CSS.escape(playerUid)}"]`;
  }

  function playerHerdSelector(playerUid: string): string {
    return `[data-herd-destination="${CSS.escape(playerUid)}"]`;
  }

  function playerCardSourceBox(
    state: GameState,
    playerUid: string,
    cardId: string
  ): DOMRect | undefined {
    if (playerUid === uid) {
      const loadedTarget = Object.entries(exchangeLoads).find(([, returnId]) => returnId === cardId)?.[0];
      if (loadedTarget) {
        const loadedBox = elementBox(
          `[data-exchange-target="${CSS.escape(loadedTarget)}"]`
        );
        if (loadedBox) return loadedBox;
      }
      const exactBox = elementBox(`[data-card-id="${CSS.escape(cardId)}"]`) ??
        elementBox(`[data-return-source="${CSS.escape(cardId)}"]`);
      if (exactBox) return exactBox;
    }
    const wasCamel = state.round?.herds[playerUid]?.some(({ id }) => id === cardId);
    return elementBox(
      wasCamel ? playerHerdSelector(playerUid) : playerHandSelector(playerUid)
    );
  }

  function captureActionMovements(
    previous: GameState,
    next: GameState,
    activity: GameActivity
  ): ActionMovementPlan[] {
    if (!previous.round || !next.round || previous.round.number !== next.round.number) return [];
    const plans: ActionMovementPlan[] = [];
    const pushPlan = (
      cardId: string,
      kind: Good | 'camel' | 'card-back',
      sourceBox: DOMRect | undefined,
      destinationSelector: string,
      delay: number,
      concealDestination = true,
      revealKind?: Good | 'camel'
    ) => {
      if (sourceBox) {
        plans.push({
          activityId: activity.id,
          cardId,
          kind,
          sourceBox,
          destinationSelector,
          delay,
          concealDestination,
          revealKind
        });
      }
    };
    const cardKinds = activity.cardKinds ?? [];
    const cardIds = activity.cardIds ?? [];

    if (activity.type === 'cards/taken-one' || activity.type === 'cards/taken-camels') {
      cardIds.forEach((cardId, index) => {
        pushPlan(
          cardId,
          (cardKinds[index] ?? 'card-back') as Good | 'camel' | 'card-back',
          elementBox(`[data-card-id="${CSS.escape(cardId)}"]`),
          activity.type === 'cards/taken-camels'
            ? playerHerdSelector(activity.actorUid)
            : playerHandSelector(activity.actorUid),
          index * 90
        );
      });
      const previousMarketIds = new Set(previous.round.market.map(({ id }) => id));
      const refillCards = next.round.market.filter(({ id }) => !previousMarketIds.has(id));
      const deckBox = elementBox('.deck-count img');
      refillCards.forEach((card, index) => {
        pushPlan(
          card.id,
          'card-back',
          deckBox,
          `[data-card-id="${CSS.escape(card.id)}"]`,
          cardIds.length * 90 + 160 + index * 90,
          true,
          card.kind
        );
      });
    }

    if (activity.type === 'cards/exchanged') {
      cardIds.forEach((cardId, index) => {
        pushPlan(
          cardId,
          (cardKinds[index] ?? 'card-back') as Good | 'camel' | 'card-back',
          elementBox(`[data-card-id="${CSS.escape(cardId)}"]`),
          playerHandSelector(activity.actorUid),
          index * 80
        );
      });
      (activity.returnedCardIds ?? []).forEach((cardId, index) => {
        pushPlan(
          cardId,
          'card-back',
          playerCardSourceBox(previous, activity.actorUid, cardId),
          `[data-card-id="${CSS.escape(cardId)}"]`,
          cardIds.length * 80 + index * 80,
          true,
          activity.returnedCardKinds?.[index] as Good | 'camel' | undefined
        );
      });
    }

    if (activity.type === 'cards/sold') {
      cardIds.forEach((cardId, index) => {
        pushPlan(
          cardId,
          (cardKinds[index] ?? 'card-back') as Good | 'camel' | 'card-back',
          playerCardSourceBox(previous, activity.actorUid, cardId),
          `[data-token-kind="${CSS.escape(cardKinds[index] ?? '')}"]`,
          index * 80,
          false
        );
      });
    }
    return plans;
  }

  async function startActionCardFlights(plans: ActionMovementPlan[]) {
    arrivingCardIds = [...new Set([
      ...arrivingCardIds,
      ...plans.filter(({ concealDestination }) => concealDestination).map(({ cardId }) => cardId)
    ])];
    await tick();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      arrivingCardIds = arrivingCardIds.filter(
        (cardId) => !plans.some((plan) => plan.concealDestination && plan.cardId === cardId)
      );
      return;
    }
    const flights = plans.flatMap((plan) => {
      const destination = document.querySelector<HTMLElement>(plan.destinationSelector);
      if (!destination) {
        arrivingCardIds = arrivingCardIds.filter((cardId) => cardId !== plan.cardId);
        return [];
      }
      const destinationBox = destination.getBoundingClientRect();
      const startSize = Math.min(plan.sourceBox.width, plan.sourceBox.height);
      const destinationSize = Math.min(destinationBox.width, destinationBox.height);
      const endSize = destination.matches('[data-card-id]')
        ? destinationSize
        : Math.min(48, Math.max(34, destinationSize));
      return [{
        key: ++actionFlightSequence,
        activityId: plan.activityId,
        cardId: plan.cardId,
        kind: plan.kind,
        revealKind: plan.revealKind,
        concealsDestination: plan.concealDestination,
        label: plan.kind === 'card-back' ? '' : cardLabel(plan.kind),
        startLeft: plan.sourceBox.left + (plan.sourceBox.width - startSize) / 2,
        startTop: plan.sourceBox.top + (plan.sourceBox.height - startSize) / 2,
        startSize,
        endLeft: destinationBox.left + (destinationBox.width - endSize) / 2,
        endTop: destinationBox.top + (destinationBox.height - endSize) / 2,
        endSize,
        delay: plan.delay
      }];
    });
    actionCardFlights = [...actionCardFlights, ...flights];
    for (const flight of flights) {
      setTimeout(() => finishActionCardFlight(flight.key), 3000 + flight.delay);
    }
  }

  function finishActionCardFlight(key: number) {
    const finished = actionCardFlights.find((flight) => flight.key === key);
    actionCardFlights = actionCardFlights.filter((flight) => flight.key !== key);
    if (finished?.concealsDestination) {
      arrivingCardIds = arrivingCardIds.filter((cardId) => cardId !== finished.cardId);
    }
  }

  function ownedTokens(state: GameState, playerUid: string): Token[] {
    if (!state.round) return [];
    return [
      ...(state.round.ownedGoodsTokens[playerUid] ?? []),
      ...(state.round.ownedBonusTokens[playerUid] ?? [])
    ];
  }

  function captureTokenAwards(previous: GameState, next: GameState): Array<{
    token: Token;
    recipientUid: string;
    sourceBox: DOMRect;
  }> {
    if (
      !previous.round ||
      !next.round ||
      previous.round.number !== next.round.number
    ) {
      return [];
    }
    return next.players.flatMap((player) => {
      const previousIds = new Set(
        ownedTokens(previous, player.uid).map(({ id }) => id)
      );
      return ownedTokens(next, player.uid)
        .filter(({ id }) => !previousIds.has(id))
        .flatMap((token) => {
          const awardId = tokenAwardId(next, player.uid, token.id);
          if (animatedTokenAwardIds.has(awardId)) return [];
          animatedTokenAwardIds.add(awardId);
          const source = document.querySelector<HTMLElement>(
            `[data-supply-token-id="${CSS.escape(token.id)}"]`
          );
          const fallback = document.querySelector<HTMLElement>('.token-area');
          const sourceBox = (source ?? fallback)?.getBoundingClientRect();
          return sourceBox ? [{ token, recipientUid: player.uid, sourceBox }] : [];
        });
    });
  }

  function tokenAwardId(state: GameState, recipientUid: string, tokenId: string): string {
    return `${state.epoch}:${state.round?.number ?? 0}:${recipientUid}:${tokenId}`;
  }

  function rememberOwnedTokenAwards(state: GameState) {
    for (const player of state.players) {
      for (const token of ownedTokens(state, player.uid)) {
        animatedTokenAwardIds.add(tokenAwardId(state, player.uid, token.id));
      }
    }
  }

  async function startTokenFlights(awards: Array<{
    token: Token;
    recipientUid: string;
    sourceBox: DOMRect;
  }>, baseDelay = 0) {
    await tick();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const flights = awards.flatMap(({ token, recipientUid, sourceBox }, index) => {
      const destination = document.querySelector<HTMLElement>(
        `[data-token-destination="${CSS.escape(recipientUid)}"]`
      ) ?? document.querySelector<HTMLElement>('.token-area');
      const destinationBox = destination?.getBoundingClientRect();
      if (!destinationBox) return [];
      const startSize = Math.min(sourceBox.width, sourceBox.height);
      const endSize = Math.min(startSize, Math.max(34, Math.min(42, destinationBox.height)));
      const startLeft = sourceBox.left + (sourceBox.width - startSize) / 2;
      const startTop = sourceBox.top + (sourceBox.height - startSize) / 2;
      const endLeft = destinationBox.left + (destinationBox.width - endSize) / 2;
      const endTop = destinationBox.top + (destinationBox.height - endSize) / 2;
      return [{
        key: ++tokenFlightSequence,
        token,
        recipientUid,
        hidden: token.kind.startsWith('bonus-') && recipientUid !== uid,
        startLeft,
        startTop,
        startSize,
        endLeft,
        endTop,
        endSize,
        delay: baseDelay + index * 90
      }];
    });
    tokenFlights = [...tokenFlights, ...flights];
    for (const flight of flights) {
      setTimeout(() => finishTokenFlight(flight.key), 3000 + flight.delay);
    }
  }

  function finishTokenFlight(key: number) {
    tokenFlights = tokenFlights.filter((flight) => flight.key !== key);
  }

  function supplyTokenStyle(index: number, count: number): string {
    return `--token-index: ${index}; --token-z: ${count - index}`;
  }

  function allOwnedTokens(playerUid: string): Token[] {
    return ownedTokens(lobby, playerUid);
  }

  function ownedTokenStep(count: number): number {
    return count <= 1 ? 0 : Math.min(1.05, 6.2 / (count - 1));
  }

  function tokenStackDescription(kind: Good): string {
    const values = lobby.round?.goodsTokens[kind].map(({ value }) => value) ?? [];
    return values.length > 0
      ? `${cardLabel(kind)} stack, top to bottom: ${values.join(', ')}`
      : `${cardLabel(kind)} stack is empty`;
  }

  const cardLabel = (kind: string) => kind[0].toUpperCase() + kind.slice(1);
</script>

<svelte:head>
  <title>Jaipur — Live card play</title>
</svelte:head>

<svelte:window
  onpointermove={moveReturnPointer}
  onpointerup={finishReturnPointer}
  onpointercancel={cancelReturnPointer}
/>

<a class="skip-link" href="#game-content">Skip to game</a>
<main id="game-content" data-e2e-layout>
  <section
    class="hero"
    class:compact={!shellOnly}
    class:game-shell={Boolean(lobby.round && lobby.round.status !== 'complete')}
    class:score-shell={lobby.round?.status === 'complete'}
    class:lobby-shell={Boolean(lobby.gameId && !lobby.round)}
    aria-labelledby="title"
  >
    <p class="eyebrow">A market for two</p>
    <h1 id="title">{shellOnly ? 'The bazaar is almost ready.' : 'Enter the bazaar.'}</h1>
    <p class="lede">
      Gather rare goods, trade with camels, and earn two Seals of Excellence before your rival.
    </p>

    {#if shellOnly}
      <div class="goods" aria-label="Goods in the Jaipur market">
        {#each goods as kind}
          <span class={kind}>
            <img src={componentImage(kind)} alt="" />
            {cardLabel(kind)}
          </span>
        {/each}
      </div>
    {/if}

    {#if !lobby.gameId}
      <form class="join-card" onsubmit={(event) => event.preventDefault()}>
        <label>
          Your trader name
          <input maxlength="32" autocomplete="name" bind:value={displayName} />
        </label>
        <div class="create-room">
          <label class="bot-difficulty">
            Computer difficulty
            <select bind:value={botDifficulty}>
              <option value="apprentice">Apprentice — quick learner</option>
              <option value="maharaja">Maharaja — strongest</option>
            </select>
          </label>
          <div class="create-actions">
            <button
              type="button"
              disabled={busy || !displayName.trim()}
              onclick={() => connect('create')}
            >
              Create new game
            </button>
            <button
              class="secondary"
              type="button"
              disabled={busy || !displayName.trim()}
              onclick={() => connect('bot')}
            >
              Play vs computer
            </button>
          </div>
          <span>Both choices generate a five-letter game code.</span>
        </div>
        <div class="join-room">
          <label>
            Five-letter game code
            <input
              maxlength="5"
              minlength="5"
              pattern="[A-Za-z]{5}"
              autocomplete="off"
              autocapitalize="characters"
              value={requestedGameId}
              oninput={(event) =>
                (requestedGameId = normalizeRoomCode(event.currentTarget.value))}
            />
          </label>
          <button
            class="secondary"
            type="button"
            disabled={busy || !displayName.trim() || !isRoomCode(requestedGameId)}
            onclick={() => connect('join')}>Join game</button
          >
        </div>
      </form>
    {:else if !lobby.round}
      <section class="lobby" aria-label="Game lobby">
        <img class="lobby-art" src={componentImage('card-back')} alt="" />
        <div class="room-code">
          <span>Game code</span>
          <strong>{lobby.gameId}</strong>
        </div>
        <ol>
          {#each lobby.players as player, index}
            <li class:local={player.uid === uid}>
              <span class="seat">{index + 1}</span>
              <strong>{player.displayName}</strong>
              <span>{player.uid === lobby.bot?.uid && lobby.bot
                ? `Computer · ${botDifficultyLabel(lobby.bot.difficulty)} · Ready`
                : player.ready ? 'Ready' : 'Choosing wares'}</span>
            </li>
          {/each}
          {#if lobby.players.length < 2}
            <li class="waiting">
              <span class="seat">2</span>
              <strong>Waiting for a rival…</strong>
            </li>
          {/if}
        </ol>
        <button type="button" disabled={busy || status === 'offline'} onclick={toggleReady}>
          {lobby.players.find((player) => player.uid === uid)?.ready ? 'Not ready' : 'Ready to trade'}
        </button>
        {#if lobby.hostUid === uid && lobby.players.length === 1 && lobby.mode === 'standard'}
          <label class="lobby-bot-difficulty">
            Computer difficulty
            <select bind:value={botDifficulty}>
              <option value="apprentice">Apprentice</option>
              <option value="maharaja">Maharaja — strongest</option>
            </select>
          </label>
          <button class="secondary" type="button" disabled={busy || status === 'offline'} onclick={addComputerOpponent}>
            Add computer opponent
          </button>
        {/if}
        {#if lobby.hostUid === uid && lobby.players.length === 2 && lobby.players.every((player) => player.ready)}
          <button class="secondary" type="button" disabled={busy || status === 'offline'} onclick={startRound}>
            Open the market
          </button>
        {/if}
      </section>
    {:else if lobby.round.status === 'complete'}
      <GameSummary
        {lobby}
        componentImage={componentImage}
        busy={busy}
        offline={status === 'offline'}
        onNextRound={lobby.hostUid === uid ? startRound : undefined}
        onRematch={lobby.hostUid === uid ? startRematch : undefined}
      />
    {:else}
      <section class="table" aria-label="Jaipur market">
        <header aria-live="polite" aria-atomic="true">
          <div>
            <span>Round {lobby.round.number}</span>
            <strong>{lobby.players.find((player) => player.uid === lobby.round?.activeUid)?.displayName}'s turn</strong>
            {#if botThinking && lobby.round.activeUid === lobby.bot?.uid}
              <small class="bot-thinking" role="status">Considering the market…</small>
            {/if}
          </div>
          <div class="deck-count">
            <img src={componentImage('card-back')} alt="" />
            <span>Deck</span>
            <strong>{lobby.round.deck.length}</strong>
          </div>
        </header>
        <div class="seal-track" aria-label="Seal track">
          {#each lobby.players as player}
            <span class="player-seals">
              <span>{player.displayName}:</span>
              <span class="seal-pips" aria-hidden="true">
                {#each Array(2) as _, sealIndex}
                  <img
                    class:earned={sealIndex < (lobby.seals[player.uid] ?? 0)}
                    src={componentImage('seal')}
                    alt=""
                  />
                {/each}
              </span>
              <strong>{lobby.seals[player.uid] ?? 0} / 2 seals</strong>
            </span>
          {/each}
        </div>
        <section
          class="market-zone"
          class:draw-pending={Boolean(pendingDraw)}
          aria-labelledby="market-heading"
          style={`--zone-art: url("${componentImage('card-back')}")`}
        >
          <h2 id="market-heading">Market</h2>
          <div class="cards market">
            <StableMarketLayout>
              {#snippet slot(marketIndex)}
              {@const round = lobby.round!}
              {@const card = round.market[marketIndex]}
              {@const loadedReturn = exchangeReturnCard(card.id)}
              <div
                class="market-slot"
                class:loaded={Boolean(exchangeLoads[card.id])}
                class:awaiting={activeExchangeTarget === card.id}
                data-market-slot-index={marketIndex}
              >
                {#if isPendingDrawCard(card.id)}
                  <button
                    class="card-action pending-draw-card"
                    type="button"
                    disabled={busy || status === 'offline' || pendingDraw?.activeUid !== uid}
                    aria-label={pendingDraw?.activeUid === uid
                      ? 'Confirm draw'
                      : pendingDraw?.kind === 'camels'
                        ? 'Draw Camels pending'
                        : 'Draw Single pending'}
                    data-card-id={card.id}
                    data-pending-draw-card={card.id}
                    onclick={confirmPendingDraw}
                  >
                    <PieceArt
                      kind="card-back"
                      label={pendingDraw?.kind === 'camels' ? 'Draw Camels' : 'Draw Single'}
                    />
                  </button>
                {:else if round.activeUid === uid}
                  <button
                    class="card-action"
                    class:camel={card.kind === 'camel'}
                    class:arriving={arrivingCardIds.includes(card.id)}
                    type="button"
                    disabled={busy || Boolean(pendingDraw) || status === 'offline' || (card.kind !== 'camel' && (round.hands[uid]?.length ?? 0) >= 7)}
                    aria-label={card.kind === 'camel'
                      ? `Take all ${round.market.filter(({ kind }) => kind === 'camel').length} camels`
                      : `Take ${cardLabel(card.kind)} ${card.id}`}
                    data-card-id={card.id}
                    data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
                    onclick={() => initiateDraw(card)}
                  >
                    <PieceArt kind={card.kind} label={cardLabel(card.kind)} detail={card.id} />
                  </button>
                {:else}
                  <article
                    class:camel={card.kind === 'camel'}
                    class:arriving={arrivingCardIds.includes(card.id)}
                    data-card-id={card.id}
                    data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
                  >
                    <PieceArt kind={card.kind} label={cardLabel(card.kind)} detail={card.id} />
                  </article>
                {/if}
                {#if card.kind !== 'camel' && round.activeUid === uid}
                  <button
                    class="exchange-drop-target"
                    class:loaded={Boolean(loadedReturn)}
                    class:awaiting={activeExchangeTarget === card.id}
                    class:drop-ready={Boolean(draggedReturnId)}
                    type="button"
                    disabled={busy || Boolean(pendingDraw) || status === 'offline' || (!loadedReturn && availableReturnCards(card.id).length === 0)}
                    data-exchange-target={card.id}
                    aria-label={loadedReturn
                      ? `Remove ${cardLabel(loadedReturn.kind)} ${loadedReturn.id} from the exchange for ${cardLabel(card.kind)} ${card.id}`
                      : `Return a hand card or camel for ${cardLabel(card.kind)} ${card.id}`}
                    aria-pressed={Boolean(loadedReturn) || activeExchangeTarget === card.id}
                    onclick={() => chooseExchangeDrop(card.id)}
                  >
                    {#if loadedReturn}
                      <span
                        class="loaded-return-card"
                        class:flight-arrival={returnFlights.some(
                          (flight) => flight.marketCardId === card.id
                        )}
                      >
                        <img src={componentImage('card-back')} alt="" draggable="false" />
                        <span>Return</span>
                      </span>
                    {:else}
                      <span class="drop-target-mark" aria-hidden="true"></span>
                      <span>Return card</span>
                    {/if}
                  </button>
                {/if}
              </div>
              {/snippet}
            </StableMarketLayout>
          </div>
        </section>
        <div class="opponent">
          <div class="opponent-identity">
            <strong>{opponentPlayer()?.displayName}</strong>
            <span>{opponentHandCount()} / 7 cards</span>
          </div>
          <div
            class="opponent-hand"
            data-hand-destination={opponentUid()}
            role="img"
            aria-label={`${opponentPlayer()?.displayName ?? 'Opponent'} has ${opponentHandCount()} of 7 cards`}
          >
            {#each lobby.round.hands[opponentUid()] ?? [] as card, index}
              <img
                class="opponent-card-back"
                class:arriving={arrivingCardIds.includes(card.id)}
                src={componentImage('card-back')}
                alt=""
                draggable="false"
                data-card-id={card.id}
                data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
                style={`--fan-offset: ${index - (opponentHandCount() - 1) / 2}`}
              />
            {/each}
            {#if opponentHandCount() === 0}
              <span class="opponent-hand-empty">No cards</span>
            {/if}
          </div>
          <div
            class="camel-herd opponent-herd"
            data-herd-destination={opponentUid()}
            role="img"
            aria-label={`${opponentPlayer()?.displayName ?? 'Opponent'} camel herd`}
          >
            <span>Herd</span>
            <span class="camel-pile" aria-hidden="true">
              {#each lobby.round.herds[opponentUid()] ?? [] as camel, index}
                <img
                  class:arriving={arrivingCardIds.includes(camel.id)}
                  src={componentImage('camel')}
                  alt=""
                  draggable="false"
                  data-card-id={camel.id}
                  data-card-arriving={arrivingCardIds.includes(camel.id) || undefined}
                  style={camelStackStyle(index)}
                />
              {/each}
            </span>
          </div>
          <div
            class="opponent-private"
            data-token-destination={opponentUid()}
          >
            <span
              class="opponent-token-pile"
              aria-hidden="true"
            >
              {#if opponentTokenCount() > 0}
                <TokenStack
                  tokens={allOwnedTokens(opponentUid())}
                  direction="horizontal"
                  usage="opponent"
                  stepRem={ownedTokenStep(opponentTokenCount())}
                  hidden
                />
              {/if}
            </span>
            <span>{opponentTokenCount()} tokens · values hidden</span>
          </div>
        </div>
        <section class="action-dock" aria-live="polite">
          {#if pendingDraw && pendingDraw.activeUid === uid}
            <div class="draw-confirmation" role="group" aria-label="Confirm draw" data-pending-draw={pendingDraw.kind}>
              <span>{pendingDraw.kind === 'camels' ? `Draw Camels · ${pendingDraw.cardIds.length} cards staged face down` : 'Draw Single · 1 card staged face down'}</span>
              <button type="button" disabled={busy || status === 'offline'} data-confirm-draw onclick={confirmPendingDraw}>Confirm</button>
              <button class="secondary" type="button" disabled={busy || status === 'offline'} data-abandon-draw onclick={abandonPendingDraw}>Undo</button>
            </div>
          {:else if lobby.round.activeUid === uid && (exchangeMarketIds().length > 0 || activeExchangeTarget || selectedHand.length > 0 || selectedCamelId)}
            <div class="interaction-tray">
              <p>
                {#if activeExchangeTarget}
                  Choose or drag a hand card or camel to the highlighted drop target.
                {:else if exchangeMarketIds().length > 0}
                  {exchangeMarketIds().length} market
                  {exchangeMarketIds().length === 1 ? 'card' : 'cards'} loaded ·
                  hand {projectedHandSize()} / 7
                {:else if selectedCamelId && selectedHand.length > 0}
                  {selectedHand.length} hand {selectedHand.length === 1 ? 'card' : 'cards'} and 1 camel selected ·
                  choose dashed return targets.
                {:else if selectedCamelId}
                  1 camel selected · choose a dashed return target.
                {:else}
                  {selectedHand.length} hand {selectedHand.length === 1 ? 'card' : 'cards'} selected ·
                  choose a matching token stack or a dashed return target.
                {/if}
              </p>
              {#if exchangeMarketIds().length > 0}
                <button
                  type="button"
                  disabled={!isLegalExchange(lobby.round, uid, exchangeMarketIds(), exchangeReturnIds()) || busy || status === 'offline'}
                  onclick={confirmExchange}
                >
                  Trade {exchangeMarketIds().length} for {exchangeReturnIds().length}
                </button>
              {/if}
              <button class="secondary" type="button" onclick={resetInteractions}>Clear</button>
            </div>
          {:else if lobby.round.activeUid === uid}
            <div class="turn-guidance">
              <strong>Choose your move</strong>
              <span>Draw from the market, or select cards below to trade or sell.</span>
            </div>
          {:else}
            <div class="turn-guidance waiting">
              <strong>Opponent's turn</strong>
              <span>Watch the market and the latest action while the other trader acts.</span>
            </div>
          {/if}
        </section>
        <section
          class="hand-zone"
          aria-labelledby="hand-heading"
          style={`--zone-art: url("${componentImage('card-back')}")`}
        >
          <h2 id="hand-heading">Your hand</h2>
          <div
            class="cards hand"
            data-hand-destination={uid}
            style={`grid-template-columns: repeat(${Math.max((lobby.round.hands[uid] ?? []).filter(({ id }) => !exchangeReturnIds().includes(id)).length, 1)}, minmax(0, var(--card-size)));`}
          >
          {#each (lobby.round.hands[uid] ?? []).filter(({ id }) => !exchangeReturnIds().includes(id)) as card}
            {#if lobby.round.activeUid === uid}
              <button
                class="card-action hand-card"
                class:arriving={arrivingCardIds.includes(card.id)}
                class:selected={selectedHand.includes(card.id) || exchangeReturnIds().includes(card.id)}
                class:dragging={draggedReturnId === card.id}
                type="button"
                disabled={busy || Boolean(pendingDraw) || status === 'offline'}
                aria-label={exchangeReturnIds().includes(card.id)
                  ? `${cardLabel(card.kind)} ${card.id} loaded for exchange`
                  : activeExchangeTarget
                    ? `Use ${cardLabel(card.kind)} ${card.id} for exchange`
                    : `${selectedHand.includes(card.id) ? 'Deselect' : 'Select'} ${cardLabel(card.kind)} ${card.id}`}
                aria-pressed={selectedHand.includes(card.id) || exchangeReturnIds().includes(card.id)}
                data-card-id={card.id}
                data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
                data-return-source={card.id}
                onpointerdown={(event) => beginReturnPointer(event, card.id, 'hand')}
                onclick={() => chooseHandCard(card)}
              >
                <PieceArt kind={card.kind} label={cardLabel(card.kind)} detail={card.id} />
              </button>
            {:else}
              <article
                class:arriving={arrivingCardIds.includes(card.id)}
                data-card-id={card.id}
                data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
              >
                <PieceArt kind={card.kind} label={cardLabel(card.kind)} detail={card.id} />
              </article>
            {/if}
          {/each}
          </div>
          <div class="own-herd">
            <span class="own-herd-label">
              <span>Your herd</span>
            </span>
            {#if lobby.round.activeUid === uid}
              <button
                class="own-camel-stack"
                data-herd-destination={uid}
                class:selected={Boolean(selectedCamelId)}
                class:dragging={draggedReturnSource === 'camel'}
                type="button"
                disabled={busy || Boolean(pendingDraw) || status === 'offline' || ownHerdCards().length === 0}
                aria-label="Select or drag a camel from your herd for exchange"
                aria-pressed={Boolean(selectedCamelId)}
                style={`--herd-span: ${ownCamelStackSpan()}`}
                onpointerdown={(event) => {
                  const camel = selectedCamelId
                    ? herdCamel(selectedCamelId)
                    : availableCamel(activeExchangeTarget ?? '');
                  if (camel) beginReturnPointer(event, camel.id, 'camel');
                }}
                onclick={chooseCamelSource}
              >
                <span
                  class="own-camel-pile"
                  aria-hidden="true"
                >
                  {#each ownHerdCards() as camel, index}
                    <span
                      class="own-camel-card"
                      class:selected={selectedCamelId === camel.id}
                      class:arriving={arrivingCardIds.includes(camel.id)}
                      data-card-id={camel.id}
                      data-card-arriving={arrivingCardIds.includes(camel.id) || undefined}
                      data-return-source={camel.id}
                      style={ownCamelStackStyle(index)}
                    >
                      <PieceArt kind="camel" label="Camel" detail={camel.id} />
                    </span>
                  {/each}
                </span>
              </button>
            {:else}
              <span
                class="own-camel-stack"
                data-herd-destination={uid}
                role="img"
                aria-label="Your camel herd"
                style={`--herd-span: ${ownCamelStackSpan()}`}
              >
                <span
                  class="own-camel-pile"
                  aria-hidden="true"
                >
                  {#each lobby.round.herds[uid] ?? [] as camel, index}
                    <span
                      class="own-camel-card"
                      class:arriving={arrivingCardIds.includes(camel.id)}
                      data-card-id={camel.id}
                      data-card-arriving={arrivingCardIds.includes(camel.id) || undefined}
                      style={ownCamelStackStyle(index)}
                    >
                      <PieceArt kind="camel" label="Camel" detail={camel.id} />
                    </span>
                  {/each}
                </span>
              </span>
            {/if}
          </div>
          <div
            class="own-token-tray"
            data-token-destination={uid}
            role="img"
            aria-label="Your earned token stack"
          >
            <span
              class="owned-token-pile"
              aria-hidden="true"
            >
              {#if allOwnedTokens(uid).length > 0}
                <TokenStack
                  tokens={allOwnedTokens(uid)}
                  direction="horizontal"
                  usage="owned"
                  stepRem={ownedTokenStep(allOwnedTokens(uid).length)}
                />
              {/if}
            </span>
          </div>
        </section>
        <section class="token-area" aria-label="Token supplies">
          <div class="token-supply-heading">
            <h2>Token supplies</h2>
            <div class="bonus-supplies" aria-label="Face-down bonus token supplies">
              {#each bonusSizes as size}
                <span class="bonus-supply" aria-label={`${size}-card bonus stack, ${lobby.round.bonusTokens[size].length} tokens left`}>
                  <span>{size}+</span>
                  <span class="bonus-chip-stack" aria-hidden="true">
                    {#each lobby.round.bonusTokens[size] as token, index}
                      <span
                        class="bonus-supply-token"
                        data-supply-token-id={token.id}
                        style={supplyTokenStyle(index, lobby.round.bonusTokens[size].length)}
                      >
                        <TokenChip {token} hidden />
                      </span>
                    {/each}
                  </span>
                </span>
              {/each}
            </div>
          </div>
          <div class="tokens">
            {#each goods as kind}
              <button
                class={`token ${kind}`}
                type="button"
                disabled={!canSellTo(kind)}
                aria-label={saleActionLabel(kind)}
                aria-describedby={`token-stack-${kind}`}
                data-token-kind={kind}
                onclick={() => sellToStack(kind)}
              >
                <span id={`token-stack-${kind}`} class="visually-hidden">
                  {tokenStackDescription(kind)}
                </span>
                <strong class="token-supply-label">{cardLabel(kind)}</strong>
                <span
                  class="supply-chip-stack"
                  aria-hidden="true"
                >
                  {#if lobby.round.goodsTokens[kind].length > 0}
                    <TokenStack
                      tokens={lobby.round.goodsTokens[kind]}
                      direction="vertical"
                      usage="supply"
                    />
                  {:else}
                    <span class="empty-token-stack">—</span>
                  {/if}
                </span>
                <span class="token-supply-count">{lobby.round.goodsTokens[kind].length} left</span>
              </button>
            {/each}
          </div>
        </section>
      </section>
    {/if}

    {#if actionNotice}
      <p class="action-notice" data-action-notice={actionNotice.key} aria-live="polite">
        {actionNotice.text}
      </p>
    {/if}
    {#if !shellOnly && lobby.round && lobby.activity.length > 0}
      {@const latestActivity = lobby.activity.at(-1)!}
      <p
        class="latest-action"
        data-latest-action
        data-latest-activity-id={latestActivity.id}
        data-latest-activity-type={latestActivity.type}
        aria-live="polite"
        title={activityText(latestActivity)}
      >
        <span>Latest</span>
        <strong>{activityText(latestActivity)}</strong>
      </p>
    {/if}
    {#if !shellOnly && lobby.activity.length > 0}
      <details class="game-log">
        <summary>Game log <span>{lobby.activity.length}</span></summary>
        <section class="game-log-panel" aria-labelledby="game-log-heading">
          <h2 id="game-log-heading">Game log</h2>
          <ol start={Math.max(1, lobby.activity.length - logPage * logPageSize)} reversed>
            {#each visibleLogEntries() as activity}
              <li data-activity-id={activity.id} data-activity-type={activity.type}>
                <strong>{playerName(activity.actorUid)}</strong>
                <span>{activityDescription(activity)}</span>
              </li>
            {/each}
          </ol>
          <nav aria-label="Game log pages">
            <button
              type="button"
              class="secondary"
              disabled={logPage === 0}
              onclick={() => logPage = Math.max(0, logPage - 1)}
            >Newer</button>
            <span>Page {Math.min(logPage + 1, logPageCount())} / {logPageCount()}</span>
            <button
              type="button"
              class="secondary"
              disabled={logPage >= logPageCount() - 1}
              onclick={() => logPage = Math.min(logPageCount() - 1, logPage + 1)}
            >Older</button>
          </nav>
        </section>
      </details>
    {/if}

    <p role={status === 'incompatible' ? 'alert' : 'status'} data-status={status}>{statusText}</p>
    {#if lobby.diagnostics.length > 0}
      <details class="diagnostics">
        <summary>Replay diagnostics ({lobby.diagnostics.length})</summary>
        <ul>
          {#each lobby.diagnostics as diagnostic}
            <li>{diagnostic}</li>
          {/each}
        </ul>
      </details>
    {/if}
    <p class="build" data-testid="build-marker">Build {buildHash}</p>
  </section>
  {#if draggedReturnId && pointerReturnDrag?.moved}
    {@const draggedCard = returnCard(draggedReturnId)}
    {#if draggedCard}
      <span
        class="return-drag-preview"
        aria-hidden="true"
        style={`left: ${pointerReturnDrag.currentX}px; top: ${pointerReturnDrag.currentY}px`}
      >
        <img src={componentImage(draggedCard.kind)} alt="" draggable="false" />
      </span>
    {/if}
  {/if}
  {#each returnFlights as flight (flight.key)}
    <span
      class="return-flight-card"
      data-flight-card-id={flight.cardId}
      data-flight-target-id={flight.marketCardId}
      aria-hidden="true"
      style={`--flight-start-left: ${flight.startLeft}px; --flight-start-top: ${flight.startTop}px; --flight-start-size: ${flight.startSize}px; --flight-end-left: ${flight.endLeft}px; --flight-end-top: ${flight.endTop}px; --flight-end-size: ${flight.endSize}px`}
      onanimationend={() => finishReturnFlight(flight.key)}
    >
      <img src={componentImage(flight.kind)} alt="" draggable="false" />
      <span>{flight.label}</span>
    </span>
  {/each}
  {#each actionCardFlights as flight (flight.key)}
    <span
      class="action-card-flight"
      class:flips={Boolean(flight.revealKind)}
      data-action-flight-id={flight.activityId}
      data-action-flight-card-id={flight.cardId}
      data-action-flight-kind={flight.kind}
      aria-hidden="true"
      style={`--action-flight-start-left: ${flight.startLeft}px; --action-flight-start-top: ${flight.startTop}px; --action-flight-start-size: ${flight.startSize}px; --action-flight-end-left: ${flight.endLeft}px; --action-flight-end-top: ${flight.endTop}px; --action-flight-end-size: ${flight.endSize}px; --action-flight-delay: ${flight.delay}ms`}
      onanimationend={(event) => {
        if (event.currentTarget === event.target) finishActionCardFlight(flight.key);
      }}
    >
      <span class="action-card-flight-inner">
        <img class="action-card-flight-back" src={componentImage(flight.kind)} alt="" draggable="false" />
        {#if flight.revealKind}
          <img class="action-card-flight-front" src={componentImage(flight.revealKind)} alt="" draggable="false" />
        {/if}
        {#if flight.label}<span>{flight.label}</span>{/if}
      </span>
    </span>
  {/each}
  {#each tokenFlights as flight (flight.key)}
    <span
      class="token-flight"
      data-token-flight-id={flight.token.id}
      data-token-kind={flight.token.kind}
      data-token-recipient={flight.recipientUid}
      aria-hidden="true"
      style={`--token-flight-start-left: ${flight.startLeft}px; --token-flight-start-top: ${flight.startTop}px; --token-flight-start-size: ${flight.startSize}px; --token-flight-end-left: ${flight.endLeft}px; --token-flight-end-top: ${flight.endTop}px; --token-flight-end-size: ${flight.endSize}px; --token-flight-delay: ${flight.delay}ms`}
      onanimationend={() => finishTokenFlight(flight.key)}
    >
      <TokenChip token={flight.token} hidden={flight.hidden} />
    </span>
  {/each}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html) {
    background: #f5e7c6;
    color: #183a37;
    font-family: 'Atkinson Hyperlegible', sans-serif;
  }
  :global(body) { margin: 0; }
  .arriving { visibility: hidden !important; }
  .skip-link {
    position: fixed;
    z-index: 10;
    top: 0.5rem;
    left: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: #183a37;
    color: white;
    font-weight: 700;
    transform: translateY(-150%);
  }
  .skip-link:focus { transform: translateY(0); }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding:
      max(2rem, env(safe-area-inset-top))
      max(2rem, env(safe-area-inset-right))
      max(2rem, env(safe-area-inset-bottom))
      max(2rem, env(safe-area-inset-left));
    background:
      radial-gradient(circle at 50% 18%, rgb(255 255 255 / 75%), transparent 31rem),
      linear-gradient(145deg, #f8efd9, #e7c98d);
  }
  .hero {
    width: min(62rem, 100%);
    padding: clamp(2rem, 6vw, 5rem);
    text-align: center;
    border: 1px solid rgb(24 58 55 / 25%);
    border-radius: 2rem;
    background: rgb(255 250 238 / 88%);
    box-shadow: 0 1.5rem 4rem rgb(80 46 20 / 16%);
  }
  .hero.compact { max-width: 46rem; }
  .eyebrow {
    margin: 0;
    color: #a23e2a;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0.5rem auto 1rem;
    max-width: 13ch;
    font: 700 clamp(3rem, 8vw, 6.5rem) / 0.9 'Cormorant Garamond', serif;
  }
  .compact h1 { font-size: clamp(2.8rem, 7vw, 5rem); }
  .lede {
    max-width: 42rem;
    margin: 0 auto 2rem;
    font-size: clamp(1.1rem, 2vw, 1.35rem);
  }
  .goods, .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.55rem;
    margin-bottom: 2rem;
  }
  .goods span {
    padding: 0.5rem 0.8rem;
    border-radius: 99rem;
    color: white;
    font-weight: 700;
  }
  .diamond { background: #a9323a; }
  .gold { background: #b17900; }
  .silver { background: #60727c; }
  .cloth { background: #72539a; }
  .spice { background: #3e7b51; }
  .leather { background: #8a552f; }
  .join-card {
    display: grid;
    gap: 1rem;
    max-width: 28rem;
    margin: 0 auto 1.5rem;
    text-align: left;
  }
  label { display: grid; gap: 0.35rem; font-weight: 700; }
  input,
  select {
    width: 100%;
    min-height: 44px;
    padding: 0.75rem;
    border: 1px solid #778b80;
    border-radius: 0.65rem;
    background: white;
    color: inherit;
    font: inherit;
  }
  .bot-difficulty,
  .lobby-bot-difficulty {
    font-size: 0.82rem;
  }
  .lobby-bot-difficulty {
    max-width: 17rem;
    margin: 0.65rem auto;
    text-align: left;
  }
  button {
    min-width: 44px;
    min-height: 44px;
    padding: 0.75rem 1.1rem;
    border: 0;
    border-radius: 99rem;
    background: #a23e2a;
    color: white;
    font: 700 1rem inherit;
    cursor: pointer;
  }
  button.secondary { background: #315f58; }
  button:disabled { cursor: not-allowed; opacity: 0.45; }
  :global(:focus-visible) {
    outline: 4px solid #145ca8;
    outline-offset: 3px;
  }
  .lobby { margin: 0 auto 1.5rem; }
  .lobby button + button { margin-left: 0.5rem; }
  .room-code { display: grid; margin-bottom: 1rem; }
  .room-code span { color: #66746e; font-size: 0.85rem; text-transform: uppercase; }
  .room-code strong { font-size: 1.35rem; letter-spacing: 0.08em; }
  ol { display: grid; gap: 0.65rem; padding: 0; list-style: none; }
  li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.8rem;
    padding: 0.8rem;
    border: 1px solid #b7aa8d;
    border-radius: 0.8rem;
    text-align: left;
  }
  li.local { border-color: #a23e2a; background: #fff4e4; }
  li.waiting { color: #66746e; }
  .seat {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border-radius: 50%;
    background: #183a37;
    color: white;
  }
  [role='status'] { margin: 0; font-weight: 700; }
  [data-status='synced'] { color: #236142; }
  [data-status='syncing'] { color: #725217; }
  [data-status='conflict'], [data-status='incompatible'], [data-status='error'] { color: #a3212a; }
  .diagnostics {
    max-width: 36rem;
    margin: 0.5rem auto;
    color: #7d2525;
    text-align: left;
  }
  .diagnostics ul { margin: 0.4rem 0; padding-left: 1.2rem; }
  .diagnostics li {
    display: list-item;
    padding: 0.15rem;
    border: 0;
    list-style: disc;
  }
  .action-notice {
    position: absolute;
    z-index: 170;
    top: 0.65rem;
    left: 50%;
    width: max-content;
    max-width: min(34rem, calc(100% - 1.4rem));
    margin: 0;
    padding: 0.48rem 0.75rem;
    border: 1px solid #8e826b;
    border-radius: 99rem;
    background: rgb(255 250 238 / 96%);
    box-shadow: 0 0.35rem 0.8rem rgb(24 58 55 / 24%);
    color: #183a37;
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1.1;
    pointer-events: none;
    animation: action-notice-arrival 2600ms ease both;
  }
  @keyframes action-notice-arrival {
    0% { opacity: 0; transform: translate(-50%, -0.75rem); }
    12%, 82% { opacity: 1; transform: translate(-50%, 0); }
    100% { opacity: 0; transform: translate(-50%, -0.25rem); }
  }
  .game-log {
    position: absolute;
    z-index: 160;
    bottom: 0.3rem;
    left: 0.7rem;
    color: #183a37;
    text-align: left;
  }
  .latest-action {
    position: absolute;
    z-index: 155;
    bottom: 0.3rem;
    left: 8.35rem;
    display: flex;
    width: min(34rem, calc(100% - 17rem));
    min-width: 0;
    min-height: 44px;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    padding: 0.35rem 0.65rem;
    overflow: hidden;
    border: 1px solid #8e826b;
    border-radius: 99rem;
    background: rgb(255 250 238 / 96%);
    box-shadow: 0 0.18rem 0.45rem rgb(24 58 55 / 18%);
    color: #183a37;
    font-size: 0.75rem;
    line-height: 1.1;
    pointer-events: none;
  }
  .latest-action > span {
    flex: 0 0 auto;
    color: #725217;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .latest-action > strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .game-log > summary {
    display: flex;
    min-width: 7.2rem;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0.55rem;
    border: 1px solid #8e826b;
    border-radius: 99rem;
    background: #fffaf0;
    box-shadow: 0 0.18rem 0.45rem rgb(24 58 55 / 18%);
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 700;
    list-style: none;
  }
  .game-log > summary::-webkit-details-marker { display: none; }
  .game-log > summary span {
    display: grid;
    min-width: 1.35rem;
    min-height: 1.35rem;
    padding: 0 0.25rem;
    place-items: center;
    border-radius: 99rem;
    background: #315f58;
    color: white;
  }
  .game-log-panel {
    position: absolute;
    bottom: calc(100% + 0.35rem);
    left: 0;
    display: grid;
    width: min(27rem, calc(100vw - 1.4rem));
    gap: 0.35rem;
    padding: 0.6rem;
    border: 1px solid #8e826b;
    border-radius: 0.75rem;
    background: rgb(255 250 238 / 98%);
    box-shadow: 0 0.7rem 1.4rem rgb(24 58 55 / 26%);
  }
  .game-log-panel h2 {
    margin: 0;
    font: 700 1.05rem 'Cormorant Garamond', serif;
  }
  .game-log-panel ol {
    display: grid;
    gap: 0.2rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .game-log-panel li {
    display: grid;
    min-height: 0;
    grid-template-columns: minmax(4.5rem, auto) 1fr;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.28rem 0.35rem;
    border: 0;
    border-radius: 0.35rem;
    background: #f2e8d3;
    font-size: 0.72rem;
    line-height: 1.15;
  }
  .game-log-panel li:first-child { background: #f6e5c7; }
  .game-log-panel nav {
    display: grid;
    grid-template-columns: 4.4rem 1fr 4.4rem;
    align-items: center;
    gap: 0.35rem;
    text-align: center;
  }
  .game-log-panel nav button {
    min-height: 36px;
    padding: 0.25rem 0.45rem;
    font-size: 0.7rem;
  }
  .game-log-panel nav span { font-size: 0.68rem; }
  .build { margin: 0.55rem 0 0; color: #5f6f69; font-size: 0.875rem; }
  .table { text-align: left; }
  .table header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.8rem;
    border-bottom: 1px solid #b7aa8d;
  }
  .table header div { display: grid; }
  .seal-track {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-top: 0.65rem;
    color: #5f6f69;
    font-size: 0.875rem;
  }
  .table h2 { margin: 1rem 0 0.5rem; font: 700 1.8rem 'Cormorant Garamond', serif; }
  .interaction-tray {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.65rem;
  }
  .interaction-tray p {
    flex: 1;
    margin: 0;
    padding: 0.45rem 0.65rem;
    border-left: 3px solid #a23e2a;
    background: #f6e5c7;
    color: #274d47;
  }
  .draw-confirmation {
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.65rem;
    padding: 0.35rem 0.45rem 0.35rem 0.65rem;
    border-left: 3px solid #a23e2a;
    background: #f6e5c7;
  }
  .draw-confirmation span { flex: 1; font-weight: 700; }
  .draw-confirmation button { border-radius: 99rem; }
  .market-zone.draw-pending .exchange-drop-target { visibility: hidden; }
  .pending-draw-card :global(.piece-image) {
    animation: pending-draw-turn 220ms ease-out both;
    transform-origin: center;
  }
  @keyframes pending-draw-turn {
    from { opacity: 0.45; transform: rotateY(80deg); }
    to { opacity: 1; transform: rotateY(0); }
  }
  .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.55rem; }
  .cards article, .cards .card-action {
    min-height: 7.5rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 0.65rem;
    border: 2px solid #315f58;
    border-radius: 0.75rem;
    background: #fffaf0;
    color: #183a37;
    font-weight: 700;
    text-align: left;
  }
  .cards .card-action { cursor: pointer; }
  .cards .card-action {
    transition:
      transform 120ms ease,
      box-shadow 120ms ease;
  }
  .cards .card-action:hover {
    transform: translateY(-2px);
    box-shadow: 0 0.4rem 0.8rem rgb(49 95 88 / 18%);
  }
  .market-slot {
    display: grid;
    min-width: 0;
    gap: 0.2rem;
  }
  .exchange-drop-target {
    display: flex;
    min-width: 0;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.15rem;
    border: 2px dashed #8e826b;
    border-radius: 0.45rem;
    background: rgb(242 232 211 / 72%);
    color: #315f58;
    font-size: 0.68rem;
  }
  .loaded-return-card {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.3rem;
  }
  .loaded-return-card img {
    width: 2rem;
    height: 2rem;
    border-radius: 0.25rem;
    object-fit: cover;
  }
  .loaded-return-card > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .exchange-drop-target.loaded,
  .exchange-drop-target.awaiting {
    border-color: #d38b21;
    background: #fff0ce;
    box-shadow: inset 0 0 0 2px #d38b21;
  }
  .exchange-drop-target.drop-ready {
    border-color: #315f58;
    background: #dce8df;
    box-shadow: inset 0 0 0 2px #315f58;
  }
  .drop-target-mark {
    position: relative;
    width: 0.8rem;
    height: 0.8rem;
    flex: 0 0 0.8rem;
  }
  .drop-target-mark::before,
  .drop-target-mark::after {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0.8rem;
    height: 2px;
    border-radius: 1px;
    background: currentColor;
    content: '';
    transform: translate(-50%, -50%);
  }
  .drop-target-mark::after {
    transform: translate(-50%, -50%) rotate(90deg);
  }
  .loaded-return-card.flight-arrival {
    animation: reveal-flight-arrival 520ms step-end both;
  }
  @keyframes reveal-flight-arrival {
    0%,
    99% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }
  .market-slot.loaded > .card-action,
  .market-slot.awaiting > .card-action {
    outline: 3px solid #d38b21;
    outline-offset: -3px;
  }
  .hand-card.dragging {
    opacity: 0.55;
  }
  .cards .selected, button.selected { outline: 4px solid #d38b21; outline-offset: -4px; }
  .cards article.camel { border-color: #a23e2a; background: #f7d69f; }
  :global(.cards small) { color: #66746e; font-size: 0.7rem; }
  .opponent {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 1rem;
    padding: 0.65rem;
    border-radius: 0.65rem;
    background: #e9dcc1;
  }
  .token-area { margin-top: 1rem; }
  .tokens {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 0.35rem;
  }
  .token {
    display: grid;
    justify-items: center;
    gap: 0.1rem;
    min-width: 0;
    min-height: 44px;
    padding: 0.25rem;
    border: 1px solid transparent;
    border-radius: 0.55rem;
    background: transparent;
    color: #183a37;
    cursor: pointer;
    text-align: center;
  }
  .token span { font-size: 0.72rem; }
  .own-token-tray { margin: 0.65rem 0 0; }
  @media (prefers-reduced-motion: reduce) {
    :global(*) {
      scroll-behavior: auto !important;
      transition-duration: 0s !important;
      animation-duration: 0s !important;
      animation-iteration-count: 1 !important;
    }
    .token-flight {
      animation-delay: 0ms !important;
    }
    .action-card-flight {
      animation-delay: 0ms !important;
    }
  }
  @media (forced-colors: active) {
    .cards .selected,
    button.selected {
      outline: 4px solid Highlight;
    }
    button,
    .cards article,
    .token {
      border: 2px solid ButtonText;
    }
  }
  @media (max-width: 480px) {
    main {
      padding:
        max(1rem, env(safe-area-inset-top))
        max(1rem, env(safe-area-inset-right))
        max(1rem, env(safe-area-inset-bottom))
        max(1rem, env(safe-area-inset-left));
    }
    .hero { padding: 2rem 1.2rem; border-radius: 1.4rem; }
    li { grid-template-columns: auto 1fr; }
    li > :last-child { grid-column: 2; }
    .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cards article, .cards .card-action { min-height: 5.5rem; padding: 0.45rem; }
    .opponent { flex-wrap: wrap; }
    .tokens { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .scorecards { grid-template-columns: 1fr; }
  }

  /* Viewport-fitted component table. Every state stays inside one screen. */
  :global(html),
  :global(body) {
    width: 100%;
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;
  }
  main {
    width: 100%;
    height: 100dvh;
    min-height: 0;
    padding:
      max(0.4rem, env(safe-area-inset-top))
      max(0.4rem, env(safe-area-inset-right))
      max(0.4rem, env(safe-area-inset-bottom))
      max(0.4rem, env(safe-area-inset-left));
    overflow: hidden;
  }
  .hero {
    position: relative;
    display: flex;
    width: min(80rem, 100%);
    height: 100%;
    min-height: 0;
    flex-direction: column;
    justify-content: center;
    padding: clamp(0.8rem, 2.5vmin, 2rem);
    overflow: hidden;
    border-radius: clamp(1rem, 3vmin, 2rem);
  }
  .hero.compact {
    max-width: 80rem;
    justify-content: flex-start;
    padding: 0.55rem 0.7rem 3.35rem;
  }
  .compact > .eyebrow,
  .compact > h1,
  .compact > .lede {
    display: none;
  }
  h1 {
    margin: 0.25rem auto 0.45rem;
    font-size: clamp(2.4rem, min(8vw, 9vh), 5.5rem);
  }
  .lede {
    margin-bottom: clamp(0.5rem, 2vh, 1.25rem);
    font-size: clamp(0.95rem, 2vmin, 1.25rem);
  }
  .goods {
    gap: 0.4rem;
    margin-bottom: clamp(0.5rem, 2vh, 1rem);
  }
  .goods span {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.55rem 0.25rem 0.25rem;
  }
  .goods img {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    object-fit: cover;
  }
  .join-card {
    width: min(44rem, 100%);
    max-width: 44rem;
    grid-template-columns: minmax(10rem, 1fr) minmax(10rem, 1fr);
    gap: 0.65rem 1rem;
    margin-bottom: 0.45rem;
  }
  .join-card > label {
    grid-column: 1 / -1;
  }
  .create-room,
  .join-room {
    display: grid;
    min-width: 0;
    gap: 0.35rem;
    align-content: end;
  }
  .create-room span {
    color: #5f6f69;
    font-size: 0.8rem;
  }
  .create-actions {
    display: grid;
    grid-template-columns: 1fr 1.25fr;
    gap: 0.35rem;
  }
  .create-actions button { padding-inline: 0.65rem; }
  .join-room {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
  }
  .join-room label {
    min-width: 0;
  }
  input,
  select {
    min-height: 44px;
    padding: 0.45rem 0.65rem;
  }
  .lobby {
    position: relative;
    width: min(35rem, 100%);
    flex: 1;
    min-height: 0;
    margin: 0 auto;
    align-content: center;
  }
  .lobby-art {
    width: clamp(3.5rem, 12vmin, 6.5rem);
    aspect-ratio: 1;
    margin-bottom: 0.4rem;
    border-radius: 1rem;
    object-fit: cover;
    box-shadow: 0 0.45rem 1rem rgb(24 58 55 / 18%);
  }
  .lobby ol {
    margin: 0.5rem 0;
  }
  .lobby li {
    padding: 0.55rem 0.7rem;
  }

  .table {
    --card-size: clamp(5.75rem, min(14vw, 18vh), 7.25rem);
    --card-gap: clamp(0.15rem, 0.7vmin, 0.35rem);
    display: grid;
    width: 100%;
    flex: 1;
    min-height: 0;
    grid-template:
      'meta seals' auto
      'market hand' minmax(0, 1fr)
      'opponent tokens' auto /
      minmax(0, 1.08fr) minmax(0, 0.92fr);
    gap: 0.4rem 0.65rem;
    text-align: left;
  }
  .table > header {
    grid-area: meta;
    align-items: center;
    min-height: 44px;
    padding: 0 0.5rem;
    border: 0;
    border-radius: 0.7rem;
    background: #e9dcc1;
  }
  .deck-count {
    display: grid !important;
    grid-template-columns: 1.8rem auto;
    align-items: center;
    column-gap: 0.35rem;
  }
  .deck-count img {
    width: 1.8rem;
    height: 2.25rem;
    grid-row: 1 / 3;
    border-radius: 0.25rem;
    object-fit: cover;
  }
  .seal-track {
    grid-area: seals;
    min-height: 44px;
    align-items: center;
    margin: 0;
    padding: 0.25rem 0.5rem;
    border-radius: 0.7rem;
    background: #e9dcc1;
    color: inherit;
    gap: 0.25rem;
  }
  .player-seals {
    display: grid;
    grid-template-columns: auto auto;
    align-items: center;
    gap: 0 0.35rem;
  }
  .player-seals > strong {
    grid-column: 1 / -1;
    font-size: 0.68rem;
  }
  .seal-pips {
    display: flex;
    gap: 0.15rem;
  }
  .seal-pips img,
  .score-seals img {
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 50%;
    filter: grayscale(1);
    opacity: 0.25;
    object-fit: cover;
  }
  .seal-pips img.earned {
    filter: none;
    opacity: 1;
  }
  .market-zone,
  .hand-zone {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    padding: 0.35rem;
    border: 1px solid #c8b995;
    border-radius: 0.8rem;
    background:
      linear-gradient(rgb(255 250 238 / 88%), rgb(255 250 238 / 88%)),
      var(--zone-art) center / min(55%, 24rem) auto no-repeat;
  }
  .market-zone { grid-area: market; }
  .hand-zone { grid-area: hand; }
  .table h2 {
    margin: 0 0 0.2rem;
    font-size: clamp(1.05rem, 3vmin, 1.55rem);
    line-height: 1;
  }
  .interaction-tray {
    min-height: 44px;
    gap: 0.3rem;
    margin: 0 0 0.3rem;
  }
  .interaction-tray p {
    min-width: 0;
    overflow: hidden;
    padding: 0.25rem 0.4rem;
    font-size: clamp(0.62rem, 1.4vmin, 0.78rem);
    line-height: 1.1;
    text-overflow: ellipsis;
  }
  .interaction-tray button {
    min-width: 44px;
    padding: 0.35rem 0.65rem;
    font-size: clamp(0.7rem, 1.6vmin, 0.9rem);
    white-space: nowrap;
  }
  .cards {
    min-width: 0;
    gap: var(--card-gap);
  }
  .cards.market {
    grid-template-columns: repeat(5, var(--card-size));
    justify-content: space-between;
  }
  .cards.hand {
    align-items: start;
    justify-content: start;
  }
  .cards.hand > * {
    justify-self: center;
  }
  .cards.hand > :first-child {
    justify-self: start;
  }
  .cards.hand > :last-child {
    justify-self: end;
  }
  .cards article,
  .cards .card-action {
    position: relative;
    display: grid;
    width: var(--card-size);
    height: var(--card-size);
    min-width: var(--card-size);
    min-height: var(--card-size);
    aspect-ratio: 1;
    flex: 0 0 var(--card-size);
    grid-template-rows: minmax(0, 1fr) auto;
    padding: 0.18rem;
    overflow: hidden;
    border-width: 2px;
    border-radius: 0.55rem;
    background: #183a37;
    color: white;
  }
  .market-slot,
  .exchange-drop-target {
    width: var(--card-size);
  }
  .cards article.camel {
    background: #a23e2a;
  }
  :global(.piece-image) {
    width: 100%;
    height: 100%;
    min-height: 0;
    border-radius: 0.35rem;
    object-fit: cover;
  }
  :global(.piece-label) {
    position: absolute;
    right: 0.18rem;
    bottom: 0.18rem;
    left: 0.18rem;
    padding: 0.15rem 0.2rem;
    overflow: hidden;
    border-radius: 0 0 0.3rem 0.3rem;
    background: rgb(10 32 30 / 82%);
    color: white;
    font-size: clamp(0.56rem, 1.35vmin, 0.78rem);
    line-height: 1;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hand-card {
    touch-action: none;
    user-select: none;
  }
  .hand-card.dragging {
    z-index: 20;
    opacity: 0.55;
    transform: scale(0.98);
  }
  .hand-card:focus-visible,
  .hand-card.selected {
    z-index: 10;
  }
  :global(.cards.hand .piece-label) {
    padding-left: 0.35rem;
    text-align: left;
  }
  :global(.cards small) {
    display: none;
  }
  .opponent {
    grid-area: opponent;
    min-height: 44px;
    display: grid;
    grid-template-columns:
      minmax(3.5rem, auto)
      minmax(0, 1fr)
      minmax(4.5rem, auto)
      minmax(5.5rem, auto);
    align-items: center;
    gap: 0.3rem;
    margin: 0;
    padding: 0.3rem 0.5rem;
    font-size: clamp(0.65rem, 1.5vmin, 0.82rem);
  }
  .bot-thinking {
    display: block;
    color: #526762;
    font-size: 0.68rem;
    font-weight: 700;
  }
  .opponent-identity,
  .opponent-private {
    display: grid;
    min-width: 0;
    line-height: 1.1;
  }
  .opponent-identity span,
  .opponent-private span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opponent-private {
    grid-template-rows: auto auto;
    justify-items: end;
    text-align: right;
  }
  .opponent-token-pile,
  .owned-token-pile {
    display: block;
    width: max-content;
    height: 2.55rem;
    --token-stack-chip-size: 2.4rem;
    --token-stack-step: 1.05rem;
  }
  .opponent-token-pile:empty {
    display: none;
  }
  .opponent-hand {
    display: flex;
    min-width: 0;
    min-height: 2rem;
    align-items: center;
    justify-content: center;
    padding: 0.1rem 0.35rem;
  }
  .opponent-card-back {
    width: 1.75rem;
    height: 1.75rem;
    flex: 0 0 1.75rem;
    border-radius: 0.25rem;
    box-shadow: 0 0.12rem 0.22rem rgb(24 58 55 / 28%);
    object-fit: cover;
    transform: rotate(calc(var(--fan-offset) * 2deg));
    transform-origin: 50% 90%;
  }
  .opponent-card-back + .opponent-card-back {
    margin-left: -0.65rem;
  }
  .opponent-hand-empty {
    color: #5f6f69;
    font-size: 0.65rem;
    font-style: italic;
  }
  .camel-herd {
    display: grid;
    min-width: 0;
    min-height: 44px;
    grid-template-columns: auto minmax(4rem, 1fr);
    align-items: center;
    gap: 0.3rem;
    margin: 0;
    font-size: 0.72rem;
  }
  .own-herd {
    display: grid;
    min-width: 0;
    min-height: var(--card-size);
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    align-self: start;
    gap: 0.45rem;
    margin-top: 0.25rem;
  }
  .own-herd-label {
    display: grid;
    min-width: 4.4rem;
    gap: 0.08rem;
    font-size: 0.72rem;
    line-height: 1.05;
  }
  .own-herd-label strong {
    white-space: nowrap;
  }
  .own-camel-stack {
    position: relative;
    display: grid;
    width: min(100%, calc(var(--card-size) + var(--herd-span, 0rem)));
    height: calc(var(--card-size) + 0.4rem);
    min-width: 44px;
    min-height: 44px;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 0.45rem;
    background: transparent;
    color: inherit;
    touch-action: none;
    user-select: none;
  }
  button.own-camel-stack:not(:disabled):hover {
    background: rgb(255 240 206 / 70%);
  }
  .own-camel-stack.dragging {
    opacity: 0.5;
  }
  .own-camel-pile {
    position: relative;
    display: block;
    width: min(100%, calc(var(--card-size) + var(--herd-span, 0rem)));
    height: calc(var(--card-size) + 0.4rem);
  }
  .own-camel-card {
    position: absolute;
    top: var(--camel-y);
    left: var(--camel-x);
    display: grid;
    width: var(--card-size);
    height: var(--card-size);
    grid-template-rows: minmax(0, 1fr) auto;
    padding: 0.18rem;
    overflow: hidden;
    border: 2px solid #315f58;
    border-radius: 0.55rem;
    background: #183a37;
    box-shadow: 0 0.24rem 0.4rem rgb(24 58 55 / 28%);
    color: white;
    transform: rotate(var(--camel-rotation));
    transform-origin: 50% 82%;
  }
  .own-camel-card :global(small) {
    display: none;
  }
  .own-camel-card.selected {
    border-color: #d38b21;
    box-shadow:
      0 0 0 3px #d38b21,
      0 0.24rem 0.4rem rgb(24 58 55 / 28%);
  }
  .camel-pile {
    position: relative;
    display: block;
    width: 4.6rem;
    height: 2.25rem;
  }
  .camel-pile img {
    position: absolute;
    top: var(--camel-y);
    left: var(--camel-x);
    width: 2.1rem;
    height: 2.1rem;
    border: 1px solid #315f58;
    border-radius: 0.35rem;
    box-shadow: 0 0.16rem 0.26rem rgb(24 58 55 / 30%);
    object-fit: cover;
    transform: rotate(var(--camel-rotation));
  }
  .opponent-herd {
    grid-template-columns: auto 3.7rem;
    min-height: 38px;
  }
  .opponent-herd .camel-pile {
    width: 3.7rem;
    transform: scale(0.84);
    transform-origin: center;
  }
  .return-drag-preview {
    position: fixed;
    z-index: 100;
    width: 3.5rem;
    height: 3.5rem;
    pointer-events: none;
    transform: translate(-50%, -50%) rotate(4deg);
    filter: drop-shadow(0 0.4rem 0.45rem rgb(24 58 55 / 30%));
  }
  .return-drag-preview img {
    width: 100%;
    height: 100%;
    border: 2px solid #315f58;
    border-radius: 0.45rem;
    object-fit: cover;
  }
  .return-flight-card {
    position: fixed;
    z-index: 120;
    top: var(--flight-start-top);
    left: var(--flight-start-left);
    display: grid;
    width: var(--flight-start-size);
    height: var(--flight-start-size);
    grid-template-rows: minmax(0, 1fr) auto;
    padding: 0.18rem;
    overflow: hidden;
    border: 2px solid #315f58;
    border-radius: 0.55rem;
    background: #183a37;
    box-shadow: 0 0.7rem 1.2rem rgb(24 58 55 / 36%);
    color: white;
    pointer-events: none;
    animation: return-card-flight 520ms ease-out both;
  }
  .return-flight-card img {
    width: 100%;
    height: 100%;
    min-height: 0;
    border-radius: 0.35rem;
    object-fit: cover;
  }
  .return-flight-card > span {
    position: absolute;
    right: 0.18rem;
    bottom: 0.18rem;
    left: 0.18rem;
    padding: 0.15rem 0.2rem;
    overflow: hidden;
    border-radius: 0 0 0.3rem 0.3rem;
    background: rgb(10 32 30 / 82%);
    color: white;
    font-size: clamp(0.5rem, 1.2vmin, 0.72rem);
    line-height: 1;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action-card-flight {
    position: fixed;
    z-index: 135;
    top: var(--action-flight-start-top);
    left: var(--action-flight-start-left);
    display: grid;
    width: var(--action-flight-start-size);
    height: var(--action-flight-start-size);
    padding: 0.18rem;
    overflow: hidden;
    border: 2px solid #315f58;
    border-radius: 0.55rem;
    background: #183a37;
    box-shadow: 0 0.7rem 1.2rem rgb(24 58 55 / 36%);
    color: white;
    pointer-events: none;
    perspective: 900px;
    animation: committed-card-flight 820ms cubic-bezier(0.2, 0.75, 0.22, 1) var(--action-flight-delay) both;
  }
  .action-card-flight-inner {
    position: absolute;
    inset: 0.18rem;
    display: block;
    transform-style: preserve-3d;
  }
  .action-card-flight.flips .action-card-flight-inner {
    animation: committed-card-flip 820ms ease-in-out var(--action-flight-delay) both;
  }
  .action-card-flight img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    backface-visibility: hidden;
    border-radius: 0.35rem;
    object-fit: cover;
  }
  .action-card-flight-front { transform: rotateY(180deg); }
  .action-card-flight-inner > span {
    position: absolute;
    right: 0.18rem;
    bottom: 0.18rem;
    left: 0.18rem;
    padding: 0.15rem 0.2rem;
    overflow: hidden;
    background: rgb(10 32 30 / 82%);
    font-size: clamp(0.5rem, 1.2vmin, 0.72rem);
    line-height: 1;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @keyframes committed-card-flight {
    0% {
      top: var(--action-flight-start-top);
      left: var(--action-flight-start-left);
      width: var(--action-flight-start-size);
      height: var(--action-flight-start-size);
      opacity: 1;
      transform: rotate(0deg) scale(1);
    }
    68% {
      top: var(--action-flight-end-top);
      left: var(--action-flight-end-left);
      width: var(--action-flight-end-size);
      height: var(--action-flight-end-size);
      opacity: 1;
      transform: rotate(-2deg) scale(1.05);
    }
    84% {
      top: var(--action-flight-end-top);
      left: var(--action-flight-end-left);
      width: var(--action-flight-end-size);
      height: var(--action-flight-end-size);
      opacity: 1;
      transform: rotate(1deg) scale(0.97);
    }
    100% {
      top: var(--action-flight-end-top);
      left: var(--action-flight-end-left);
      width: var(--action-flight-end-size);
      height: var(--action-flight-end-size);
      opacity: 1;
      transform: rotate(0) scale(1);
    }
  }
  @keyframes committed-card-flip {
    0%, 52% { transform: rotateY(0deg); }
    78%, 100% { transform: rotateY(180deg); }
  }
  @keyframes return-card-flight {
    0% {
      top: var(--flight-start-top);
      left: var(--flight-start-left);
      width: var(--flight-start-size);
      height: var(--flight-start-size);
      opacity: 1;
      transform: rotate(0deg) scale(1);
    }
    100% {
      top: var(--flight-end-top);
      left: var(--flight-end-left);
      width: var(--flight-end-size);
      height: var(--flight-end-size);
      opacity: 1;
      transform: rotate(0deg) scale(1);
    }
  }
  .token-area {
    --supply-chip-size: clamp(3rem, 8vmin, 3.75rem);
    --supply-chip-step: 1.05rem;
    display: grid;
    min-width: 0;
    grid-area: tokens;
    grid-template-rows: auto 1fr auto;
    margin: 0;
    padding: 0.3rem;
    border-radius: 0.8rem;
    background: #e9dcc1;
  }
  .token-supply-heading {
    display: flex;
    min-width: 0;
    min-height: 2rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.3rem;
  }
  .token-supply-heading h2 {
    margin: 0;
  }
  .bonus-supplies {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: flex-end;
    gap: 0.22rem;
  }
  .bonus-supply {
    display: grid;
    grid-template-columns: auto 2.4rem;
    align-items: center;
    gap: 0.08rem;
    color: #315f58;
    font-size: clamp(0.52rem, 1.1vmin, 0.66rem);
    font-weight: 700;
  }
  .bonus-chip-stack {
    position: relative;
    display: block;
    width: 2.4rem;
    height: 2.6rem;
  }
  .bonus-supply-token {
    position: absolute;
    top: calc(var(--token-index) * 0.035rem);
    left: calc(var(--token-index) * 0.025rem);
    display: block;
    width: 2.3rem;
    height: 2.3rem;
    z-index: var(--token-z);
  }
  .tokens {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    align-items: stretch;
    gap: 0.12rem;
  }
  .token {
    position: relative;
    display: grid;
    min-width: 0;
    min-height: 44px;
    grid-template-rows: auto auto auto;
    justify-items: center;
    align-content: start;
    gap: 0.04rem;
    padding: 0.08rem;
    overflow: visible;
    border: 1px solid transparent;
    border-radius: 0.5rem;
    background: transparent;
    color: #183a37;
  }
  .token:not(:disabled):hover {
    border-color: #8e826b;
    background: rgb(255 250 240 / 55%);
  }
  .token:disabled {
    opacity: 0.72;
  }
  .token-supply-label,
  .token-supply-count {
    max-width: 100%;
    overflow: hidden;
    color: #183a37;
    font-size: clamp(0.52rem, 1.15vmin, 0.68rem);
    line-height: 1;
    text-overflow: ellipsis;
    text-shadow: none;
    white-space: nowrap;
  }
  .supply-chip-stack {
    display: flex;
    width: 100%;
    justify-content: center;
  }
  .supply-chip-stack :global(.token-stack) {
    --token-stack-chip-size: var(--supply-chip-size);
    --token-stack-step: var(--supply-chip-step);
  }
  .empty-token-stack {
    display: grid;
    width: var(--supply-chip-size);
    height: var(--supply-chip-size);
    margin: 0 auto;
    place-items: center;
    border: 2px dashed #8e826b;
    border-radius: 50%;
    color: #66746e;
  }
  .own-token-tray {
    display: flex;
    min-width: 0;
    min-height: 2.55rem;
    align-items: center;
    gap: 0.3rem;
    margin: 0.18rem 0 0;
    font-size: 0.7rem;
  }
  .own-token-tray > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .owned-token-pile {
    flex: 0 0 auto;
  }
  .owned-token-pile:empty {
    display: none;
  }
  .own-token-tray:has(.owned-token-pile:empty) {
    min-height: 1.3rem;
  }
  .token-flight {
    position: fixed;
    z-index: 130;
    top: var(--token-flight-start-top);
    left: var(--token-flight-start-left);
    display: block;
    width: var(--token-flight-start-size);
    height: var(--token-flight-start-size);
    pointer-events: none;
    filter: drop-shadow(0 0.45rem 0.45rem rgb(24 58 55 / 38%));
    animation: token-award-flight 600ms ease-in-out var(--token-flight-delay) both;
  }
  @keyframes token-award-flight {
    0% {
      top: var(--token-flight-start-top);
      left: var(--token-flight-start-left);
      width: var(--token-flight-start-size);
      height: var(--token-flight-start-size);
      opacity: 1;
      transform: rotate(0deg) scale(1);
    }
    100% {
      top: var(--token-flight-end-top);
      left: var(--token-flight-end-left);
      width: var(--token-flight-end-size);
      height: var(--token-flight-end-size);
      opacity: 0.92;
      transform: rotate(360deg) scale(1);
    }
  }
  .compact > [role='status'] {
    position: absolute;
    right: 0.7rem;
    bottom: 1.35rem;
    margin: 0;
    font-size: 0.75rem;
  }
  .compact > .build {
    position: absolute;
    right: 0.7rem;
    bottom: 0.35rem;
    margin: 0;
    font-size: 0.65rem;
  }
  .compact > .diagnostics {
    position: absolute;
    z-index: 3;
    right: 0.7rem;
    bottom: 3rem;
    max-width: min(32rem, 80%);
    padding: 0.4rem;
    background: #fffaf0;
  }

  @media (max-width: 600px) and (min-height: 600px) {
    .hero {
      padding: 0.65rem;
    }
    .hero.compact {
      padding: 0.35rem 0.35rem 3.2rem;
    }
    .latest-action {
      right: 7.4rem;
      left: 8.35rem;
      width: auto;
      padding-inline: 0.5rem;
    }
    .latest-action > span {
      display: none;
    }
    .join-card {
      grid-template-columns: 1fr;
      gap: 0.55rem;
    }
    .join-card > label {
      grid-column: auto;
    }
    .goods span {
      font-size: 0.75rem;
    }
    .goods img {
      width: 1.65rem;
      height: 1.65rem;
    }
    .table {
      --card-size: clamp(4.15rem, 17.5vw, 4.5rem);
      grid-template:
        'meta seals' auto
        'market market' minmax(0, auto)
        'opponent opponent' auto
        'hand hand' minmax(0, auto)
        'tokens tokens' auto /
        minmax(0, 1fr) minmax(0, 1fr);
      gap: 0.25rem;
    }
    .market-zone,
    .hand-zone {
      padding: 0.2rem;
    }
    .cards {
      gap: 0.15rem;
    }
    .cards.market {
      grid-template-columns: repeat(5, var(--card-size));
      justify-content: space-between;
    }
    .cards article,
    .cards .card-action {
      min-height: 44px;
      padding: 0.12rem;
    }
    .seal-track {
      gap: 0.1rem;
    }
    .player-seals {
      min-width: 0;
      gap: 0 0.12rem;
      font-size: 0.72rem;
    }
    .seal-pips img {
      width: 1.05rem;
      height: 1.05rem;
    }
    .opponent {
      grid-template-columns:
        minmax(2.7rem, auto)
        minmax(0, 1fr)
        minmax(3.3rem, auto)
        minmax(4.5rem, auto);
      gap: 0.2rem;
      padding-inline: 0.35rem;
    }
    .opponent-card-back {
      width: 1.6rem;
      height: 1.6rem;
      flex-basis: 1.6rem;
    }
    .opponent-card-back + .opponent-card-back {
      margin-left: -0.65rem;
    }
    .token {
      min-height: 3.35rem;
    }
    .token-supply-count {
      display: none;
    }
    .token-area {
      padding: 0.2rem;
    }
  }

  @media (min-width: 601px) and (max-width: 900px) and (min-height: 600px) {
    .table {
      grid-template:
        'meta seals' auto
        'market market' auto
        'opponent opponent' auto
        'hand hand' auto
        'tokens tokens' auto /
        minmax(0, 1fr) minmax(0, 1fr);
    }
    .cards.market {
      grid-template-columns: repeat(5, var(--card-size));
    }
  }

  @media (max-height: 599px) {
    .hero {
      justify-content: flex-start;
      padding: 0.35rem 0.65rem;
    }
    .hero:not(.compact) {
      display: grid;
      grid-template-columns: minmax(12rem, 0.8fr) minmax(25rem, 1.2fr);
      grid-template-rows: auto auto 1fr auto;
      align-items: center;
      gap: 0.1rem 1rem;
    }
    .hero:not(.compact) > .eyebrow,
    .hero:not(.compact) > h1,
    .hero:not(.compact) > .lede,
    .hero:not(.compact) > .goods {
      grid-column: 1;
    }
    .hero:not(.compact) > .join-card {
      grid-column: 2;
      grid-row: 1 / 4;
      margin: 0;
    }
    .hero:not(.compact) > [role='status'],
    .hero:not(.compact) > .build {
      grid-column: 1;
      margin: 0;
    }
    h1 {
      margin: 0.05rem auto 0.2rem;
      font-size: clamp(2rem, 8vh, 2.8rem);
    }
    .lede {
      margin-bottom: 0.25rem;
      font-size: 0.82rem;
    }
    .goods {
      margin: 0;
    }
    .goods span {
      padding: 0.15rem 0.35rem 0.15rem 0.15rem;
      font-size: 0.68rem;
    }
    .goods img {
      width: 1.45rem;
      height: 1.45rem;
    }
    .join-card {
      grid-template-columns: minmax(8rem, 1fr) minmax(9rem, 1fr);
      gap: 0.35rem 0.6rem;
    }
    .join-card > label {
      grid-column: 1 / -1;
    }
    .create-room span {
      display: none;
    }
    .hero.compact {
      padding: 0.25rem 0.4rem 2.5rem;
    }
    .latest-action {
      right: 7.4rem;
      left: 8.35rem;
      width: auto;
      min-height: 36px;
    }
    .table {
      --card-size: clamp(3.25rem, 13.5vh, 3.5rem);
      grid-template:
        'meta meta' auto
        'market hand' minmax(0, 1fr)
        'opponent opponent' auto
        'tokens tokens' auto /
        minmax(0, 1.2fr) minmax(0, 0.8fr);
      gap: 0.2rem 0.4rem;
    }
    .cards.market {
      grid-template-columns: repeat(5, var(--card-size));
    }
    .cards.hand {
      gap: 0;
    }
    .seal-track {
      position: absolute;
      top: 0.2rem;
      right: 0.4rem;
      width: 13rem;
      gap: 0.2rem;
      background: transparent;
    }
    .market-zone,
    .hand-zone {
      padding: 0.18rem;
    }
    .hand-zone {
      position: relative;
    }
    .cards.hand {
      width: calc(100% - var(--card-size) - 0.3rem);
    }
    .own-herd {
      position: absolute;
      top: 1.15rem;
      right: 0.18rem;
      width: var(--card-size);
      min-height: var(--card-size);
      grid-template-columns: 1fr;
      margin: 0;
    }
    .own-herd-label {
      display: none;
    }
    .table h2 {
      font-size: 1rem;
    }
    .interaction-tray {
      min-height: 40px;
    }
    .interaction-tray button {
      min-height: 44px;
      padding: 0.2rem 0.45rem;
    }
    .token-area {
      grid-template-rows: auto auto;
    }
    .tokens {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.08rem;
    }
    .token {
      width: max-content;
      min-height: 0;
      flex: 0 0 auto;
      grid-template-rows: auto auto;
      --supply-chip-size: 2.55rem;
      --supply-chip-step: 1.05rem;
    }
    .token-supply-count {
      display: none;
    }
    .supply-chip-stack :global(.token-stack.vertical) {
      width: calc(
        var(--token-stack-chip-size) +
        (var(--token-stack-count) - 1) * var(--token-stack-step)
      );
      height: var(--token-stack-chip-size);
    }
    .supply-chip-stack :global(.token-stack.vertical .stacked-token) {
      top: 0;
      left: calc(var(--token-stack-index) * var(--token-stack-step));
    }
    .supply-chip-stack :global(.token-stack.vertical .token-chip-rim) {
      top: 50%;
      right: -0.02rem;
      bottom: auto;
      left: auto;
      transform: translateY(-50%);
    }
    .own-token-tray > span:last-child {
      display: none;
    }
    .own-token-tray {
      position: fixed;
      z-index: 55;
      bottom: 0.3rem;
      left: clamp(9rem, 18vw, 10rem);
      min-height: 2.55rem;
      margin: 0;
    }
    .camel-herd {
      min-height: 34px;
    }
  }

  /* Approved ordinary-game composition: public play flows toward the private tray. */
  .table {
    --card-size: clamp(5.5rem, min(12vw, 16vh), 7rem);
    grid-template:
      'meta seals' 3.1rem
      'opponent opponent' 5.2rem
      'market tokens' minmax(0, 1fr)
      'action action' 3.7rem
      'hand hand' 13rem /
      minmax(0, 1fr) minmax(20rem, 22rem);
    gap: 0.42rem 0.65rem;
  }
  .market-zone,
  .hand-zone {
    border-color: #9e8a68;
    background: #fffaf0;
    box-shadow: 0 0.25rem 0.8rem rgb(10 32 30 / 12%);
  }
  .market-zone {
    background-image:
      linear-gradient(rgb(255 250 238 / 84%), rgb(255 250 238 / 84%)),
      var(--zone-art);
    background-position: center;
    background-size: auto, min(40vh, 28rem);
  }
  .cards.market {
    flex: 1;
    align-content: center;
  }
  .market-slot {
    grid-template-rows: var(--card-size) var(--card-size);
    align-content: center;
  }
  .exchange-drop-target {
    width: var(--card-size);
    height: var(--card-size);
    min-height: var(--card-size);
    flex-direction: column;
  }
  .loaded-return-card {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
  }
  .loaded-return-card img {
    width: 100%;
    height: 100%;
    border-radius: 0.35rem;
  }
  .loaded-return-card > span {
    position: absolute;
    right: 0.15rem;
    bottom: 0.15rem;
    left: 0.15rem;
    padding: 0.12rem;
    border-radius: 0 0 0.25rem 0.25rem;
    background: rgb(10 32 30 / 82%);
    color: white;
    text-align: center;
  }
  .opponent {
    min-height: 0;
    grid-template-columns: minmax(7rem, auto) minmax(0, 1fr) 8rem 10rem;
    gap: 0.65rem;
    margin: 0;
    padding: 0.35rem 0.75rem;
    border: 1px solid #b7aa8d;
    border-radius: 0.8rem;
    box-shadow: 0 0.2rem 0.55rem rgb(10 32 30 / 10%);
  }
  .opponent-hand {
    justify-content: flex-start;
    min-height: 4.2rem;
  }
  .opponent-card-back {
    width: 3.75rem;
    height: 3.75rem;
    flex-basis: 3.75rem;
    border: 2px solid #315f58;
    border-radius: 0.45rem;
  }
  .opponent-card-back + .opponent-card-back {
    margin-left: -1.45rem;
  }
  .opponent-herd {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .opponent-herd .camel-pile {
    width: 5rem;
    transform: none;
  }
  .camel-pile img {
    width: 3.5rem;
    height: 3.5rem;
  }
  .action-dock {
    display: grid;
    min-width: 0;
    min-height: 0;
    grid-area: action;
    align-items: center;
    padding: 0.35rem 0.65rem;
    border: 2px solid #d38b21;
    border-radius: 0.8rem;
    background: #fff0ce;
    box-shadow: 0 0.2rem 0.55rem rgb(10 32 30 / 10%);
  }
  .action-dock .interaction-tray,
  .action-dock .draw-confirmation {
    min-width: 0;
    min-height: 44px;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .action-dock .interaction-tray p {
    border: 0;
    background: transparent;
  }
  .turn-guidance {
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline;
    gap: 0.6rem;
    padding-inline: 0.25rem;
  }
  .turn-guidance strong { font-size: 0.92rem; }
  .turn-guidance span {
    overflow: hidden;
    color: #526762;
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn-guidance.waiting { opacity: 0.78; }
  .hand-zone {
    display: grid;
    grid-template:
      'hand-heading hand-heading hand-heading' auto
      'private-hand private-herd private-tokens' minmax(0, 1fr) /
      minmax(0, 1fr) minmax(10rem, 16rem) minmax(7rem, 10rem);
    align-items: center;
    gap: 0.25rem 0.65rem;
  }
  .hand-zone > h2 { grid-area: hand-heading; }
  .cards.hand { grid-area: private-hand; }
  .own-herd {
    grid-area: private-herd;
    align-self: center;
    margin: 0;
  }
  .own-herd-label { min-width: auto; }
  .own-token-tray {
    position: static;
    display: grid;
    min-width: 0;
    min-height: var(--card-size);
    grid-area: private-tokens;
    place-items: center;
    margin: 0;
  }
  .owned-token-pile {
    height: 3.1rem;
    --token-stack-chip-size: 3rem;
    --token-stack-step: 1rem;
  }
  .token-area {
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    max-width: 100%;
    margin: 0;
    border: 1px solid #b7aa8d;
    background: #eadbbc;
    box-shadow: 0 0.25rem 0.8rem rgb(10 32 30 / 12%);
  }
  .tokens {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-rows: repeat(2, minmax(0, 1fr));
    gap: 0.35rem;
  }
  .token {
    border-color: #c3b38f;
    background: #f4e7ca;
  }
  .token:disabled { opacity: 0.78; }

  @media (max-width: 900px) and (min-height: 600px) {
    .table {
      --card-size: clamp(3.65rem, 14.8vw, 5.4rem);
      grid-template:
        'meta seals' auto
        'opponent opponent' 4rem
        'market market' calc(var(--card-size) * 2 + 2.15rem)
        'tokens tokens' 9.5rem
        'action action' 4.25rem
        'hand hand' minmax(0, 1fr) /
        minmax(0, 1fr) minmax(0, 1fr);
      gap: 0.3rem;
    }
    .market-zone { padding: 0.3rem; }
    .cards.market { gap: 0.22rem; }
    .opponent {
      grid-template-columns: minmax(4.5rem, auto) minmax(0, 1fr) 5.3rem 5.5rem;
      gap: 0.2rem;
      padding: 0.2rem 0.4rem;
    }
    .opponent-hand { min-height: 3.25rem; }
    .opponent-card-back {
      width: 3rem;
      height: 3rem;
      flex-basis: 3rem;
    }
    .opponent-card-back + .opponent-card-back { margin-left: -1.35rem; }
    .opponent-herd .camel-pile { width: 3.8rem; }
    .camel-pile img { width: 2.8rem; height: 2.8rem; }
    .opponent-private { font-size: 0.62rem; }
    .opponent-token-pile {
      height: 2.25rem;
      --token-stack-chip-size: 2.1rem;
      --token-stack-step: 0.65rem;
    }
    .token-area {
      --supply-chip-size: 3rem;
      --supply-chip-step: 0.55rem;
      padding: 0.18rem 0.28rem;
    }
    .token-supply-heading { min-height: 1.6rem; }
    .tokens { gap: 0.18rem; }
    .token {
      min-height: 3.35rem;
      grid-template-rows: auto minmax(0, 1fr);
      align-content: center;
    }
    .token-supply-count { display: none; }
    .supply-chip-stack :global(.token-stack.vertical) {
      width: calc(
        var(--token-stack-chip-size) +
        (var(--token-stack-count) - 1) * var(--token-stack-step)
      );
      height: var(--token-stack-chip-size);
    }
    .supply-chip-stack :global(.token-stack.vertical .stacked-token) {
      top: 0;
      left: calc(var(--token-stack-index) * var(--token-stack-step));
    }
    .supply-chip-stack :global(.token-stack.vertical .token-chip-rim) {
      top: 50%;
      right: -0.02rem;
      bottom: auto;
      left: auto;
      transform: translateY(-50%);
    }
    .action-dock { padding: 0.25rem 0.4rem; }
    .turn-guidance {
      grid-template-columns: 1fr;
      gap: 0.08rem;
    }
    .turn-guidance strong { font-size: 0.78rem; }
    .turn-guidance span { font-size: 0.62rem; }
    .action-dock .interaction-tray p { font-size: 0.62rem; }
    .action-dock .interaction-tray button,
    .action-dock .draw-confirmation button {
      padding: 0.3rem 0.55rem;
      font-size: 0.68rem;
    }
    .hand-zone {
      grid-template:
        'hand-heading hand-heading' auto
        'private-hand private-herd' minmax(0, 1fr)
        'private-hand private-tokens' 3.2rem /
        minmax(0, 1fr) 7rem;
      align-items: center;
      gap: 0.15rem 0.35rem;
      padding: 0.25rem;
    }
    .cards.hand {
      grid-template-columns: repeat(4, minmax(0, var(--card-size))) !important;
      align-content: center;
      gap: 0.18rem;
    }
    .cards.hand > :first-child,
    .cards.hand > :last-child { justify-self: center; }
    .own-herd {
      grid-template-columns: 1fr;
      gap: 0.1rem;
    }
    .own-herd-label { font-size: 0.62rem; }
    .own-camel-stack,
    .own-camel-pile { max-width: 7rem; }
    .own-token-tray { min-height: 3rem; }
    .owned-token-pile {
      height: 2.5rem;
      --token-stack-chip-size: 2.4rem;
      --token-stack-step: 0.7rem;
    }
  }

  @media (max-height: 599px) {
    .table {
      --card-size: clamp(3.25rem, 13.5vh, 3.5rem);
      grid-template:
        'meta seals' auto
        'opponent opponent' 2.6rem
        'market hand' minmax(0, 1fr)
        'action action' 2.9rem
        'tokens tokens' 4.25rem /
        minmax(0, 1.2fr) minmax(0, 0.8fr);
      gap: 0.2rem 0.4rem;
    }
    .seal-track {
      position: static;
      width: auto;
      gap: 0.15rem;
      padding: 0.1rem 0.35rem;
      background: #e9dcc1;
    }
    .player-seals { font-size: 0.65rem; }
    .seal-pips img { width: 0.95rem; height: 0.95rem; }
    .opponent {
      grid-template-columns: 5rem minmax(0, 1fr) 4rem 8rem;
      padding-block: 0.1rem;
    }
    .opponent-hand { min-height: 2.25rem; }
    .opponent-card-back {
      width: 2.1rem;
      height: 2.1rem;
      flex-basis: 2.1rem;
    }
    .opponent-card-back + .opponent-card-back { margin-left: -0.8rem; }
    .opponent-herd .camel-pile { width: 3rem; transform: scale(0.68); }
    .opponent-herd > span:first-child { display: none; }
    .action-dock { padding: 0.1rem 0.35rem; }
    .turn-guidance { grid-template-columns: auto 1fr; }
    .hand-zone {
      position: relative;
      display: grid;
      grid-template:
        'hand-heading hand-heading' auto
        'private-hand private-herd' minmax(0, 1fr) /
        minmax(0, 1fr) var(--card-size);
      gap: 0.15rem;
    }
    .cards.hand {
      width: 100%;
      grid-template-columns: repeat(4, minmax(0, var(--card-size))) !important;
    }
    .own-herd {
      position: static;
      width: var(--card-size);
      grid-template-columns: 1fr;
    }
    .own-token-tray {
      position: fixed;
      z-index: 55;
      bottom: 0.3rem;
      left: clamp(9rem, 18vw, 10rem);
      min-height: 2.55rem;
    }
    .token-area {
      --supply-chip-size: 2.4rem;
      --supply-chip-step: 0.45rem;
      grid-template: 'token-heading token-stacks' minmax(0, 1fr) / 8.5rem minmax(0, 1fr);
      align-items: center;
      gap: 0.2rem;
      padding: 0.12rem 0.25rem;
      overflow: hidden;
    }
    .token-supply-heading {
      grid-area: token-heading;
      align-content: center;
      align-items: flex-start;
      flex-direction: column;
      overflow: hidden;
    }
    .token-supply-heading h2 { font-size: 0.9rem; }
    .bonus-supplies {
      width: 13rem;
      justify-content: flex-start;
      transform: scale(0.58);
      transform-origin: left center;
    }
    .tokens {
      display: grid;
      min-width: 0;
      grid-area: token-stacks;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 0.08rem;
    }
    .token {
      --supply-chip-size: 2.4rem;
      --supply-chip-step: 0.45rem;
      width: 100%;
      min-width: 0;
      min-height: 3.6rem;
      grid-template-rows: auto minmax(0, 1fr);
      align-content: center;
      padding: 0.05rem;
    }
    .token-supply-count { display: none; }
    .supply-chip-stack :global(.token-stack.vertical) {
      width: calc(
        var(--token-stack-chip-size) +
        (var(--token-stack-count) - 1) * var(--token-stack-step)
      );
      height: var(--token-stack-chip-size);
    }
    .supply-chip-stack :global(.token-stack.vertical .stacked-token) {
      top: 0;
      left: calc(var(--token-stack-index) * var(--token-stack-step));
    }
    .supply-chip-stack :global(.token-stack.vertical .token-chip-rim) {
      top: 50%;
      right: -0.02rem;
      bottom: auto;
      left: auto;
      transform: translateY(-50%);
    }
  }
</style>
