<script lang="ts">
  import '@fontsource/atkinson-hyperlegible/400.css';
  import '@fontsource/atkinson-hyperlegible/700.css';
  import '@fontsource/cormorant-garamond/700.css';
  import { base } from '$app/paths';
  import { onMount, tick } from 'svelte';
  import QRCode from 'qrcode';
  import PieceArt from '$lib/PieceArt.svelte';
  import GameSummary from '$lib/GameSummary.svelte';
  import StableMarketLayout from '$lib/StableMarketLayout.svelte';
  import TabletopTokenMarket from '$lib/TabletopTokenMarket.svelte';
  import TokenChip from '$lib/TokenChip.svelte';
  import { initializeFirebase } from '$lib/firebase';
  import {
    createLocalGameRepository,
    localGameRoomExists,
    localHostUid
  } from '$lib/local-game-repository';
  import {
    createGameRepository,
    gameRoomExists,
    type GameRepository
  } from '$lib/game-repository';
  import type { GameActivity, GameEventType, Player } from '$lib/game-events';
  import {
    isLegalExchange,
    isLegalSale,
    reduceGame,
    type Card,
    type GameState,
    type Good,
    type PendingDraw,
    type Token,
    isGood
  } from '$lib/jaipur-rules';
  import { generateRoomCode, isRoomCode } from '$lib/room-code';
  import { ArTabletop, currentDiagInches, physicalInfo, DIAG_MIN, DIAG_MAX, type PhysicalInfo, type SalePreview } from '$lib/ar/arTabletop';
  import { botActionEvent, chooseBotAction, createBotObservation } from '$lib/jaipur-bot';

  type Seat = 1 | 2;
  type SeatQr = { seat: Seat; url: string; image: string };

  const goods: Good[] = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather'];
  const buildHash = (import.meta.env.VITE_GIT_HASH ?? 'local').slice(0, 7);
  let status = $state('Preparing a new tabletop…');
  let statusKind = $state<'syncing' | 'synced' | 'error'>('syncing');
  let hostUid = $state('');
  let gameId = $state('');
  let repository = $state<GameRepository>();
  let lobby = $state<GameState>(reduceGame([]));
  let seatQrs = $state<SeatQr[]>([]);
  // AR Card Viewer attachment (see src/lib/ar/): per-seat AR QRs + solitaire bot.
  let ar = $state<ArTabletop | undefined>(undefined);
  let arQrs = $state<Array<{ seat: Seat; url: string; image: string }>>([]);
  let arViewers = $state(0);
  // The AR phone is the way to sit down at this table. The upstream phone
  // controller (/hand, Firebase-driven) is a distinct offering; ?phone=1
  // brings its QR back for anyone who wants it, never both per player.
  let legacyPhone = $state(false);
  let arDiag = $state(55);
  let localStore = $state(false);
  let scalePanelOpen = $state(false);
  let physical = $state<PhysicalInfo | null>(null);

  function refreshPhysical() {
    physical = physicalInfo(arDiag);
  }

  function setDiag(value: number) {
    const next = Math.round(Math.min(DIAG_MAX, Math.max(DIAG_MIN, value)) * 2) / 2;
    if (!Number.isFinite(next)) return;
    arDiag = next;
    ar?.setDiagInches(next);
    refreshPhysical();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen().catch(() => {});
    setTimeout(refreshPhysical, 300);
  }

  function newTable() {
    const url = new URL(location.href);
    url.searchParams.delete('game');
    url.searchParams.set('new', '1');
    location.href = url.toString();
  }
  let solitaire = false;
  let scheduledBotKey = '';
  let startingRound = false;
  let repositoryReady = false;
  let knownActivityIds = new Set<string>();
  let cardFlights = $state<Array<{
    key: number;
    cardId?: string;
    image: string;
    revealImage?: string;
    concealsDestination: boolean;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
    delay: number;
  }>>([]);
  let flightSequence = 0;
  let arrivingCardIds = $state<string[]>([]);
  let tokenFlights = $state<Array<{
    key: number;
    token: Token;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
    delay: number;
  }>>([]);
  let requestBusy = $state(false);
  let actionAnimating = $state(false);
  let turnPause = $state(false);
  let turnTransitioning = $state(false);
  let busy = $derived(requestBusy || actionAnimating || turnPause || turnTransitioning);
  let pendingDraw = $derived<PendingDraw | null>(lobby.pendingDraw);
  // Off by default on the AR table: the market band rotating 180° toward
  // the active trader makes the screen stop matching the image the phones
  // registered against, and the whole AR scene flips with it. The header
  // toggle still turns it on (remembered).
  let marketFacingEnabled = $state(false);
  let marketFacingSeat = $state<Seat>(2);
  let marketRotation = $state(0);
  let pendingTurnSeat: Seat | undefined;
  const saleTokenViewSeats: Partial<Record<string, Seat>> = {};
  const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

  const componentImage = (kind: Good | 'camel' | 'seal' | 'card-back') =>
    `${base}/components/${kind}.webp`;

  onMount(async () => {
    try {
      marketFacingEnabled = localStorage.getItem('jaipur:tabletop:turn-facing-market') === 'on';
      const pageParams = new URLSearchParams(location.search);
      // The Firebase channel is disabled for this AR fork: the table is
      // the only writer (phones join and watch over the AR relay), so the
      // game lives in this browser's localStorage and survives reloads.
      // The Firebase repository stays in the code base; ?firebase=1 opts a
      // build with Firebase config back into it.
      localStore = !(pageParams.get('firebase') === '1' && import.meta.env.VITE_FIREBASE_API_KEY);
      const services = localStore ? null : await initializeFirebase();
      hostUid = localStore ? localHostUid() : (services!.auth.currentUser?.uid ?? '');
      const roomExists = async (id: string) =>
        localStore ? localGameRoomExists(id) : gameRoomExists(services!.db, id);
      // ?game=ABCDE pins the room code. Otherwise a local table resumes the
      // game it was last running (reload/restart safe); ?new=1 or the
      // "New table" control starts another.
      const currentKey = 'jaipur:local:current-game';
      const remembered = localStore && pageParams.get('new') !== '1' ? localStorage.getItem(currentKey) : null;
      const forcedGame = pageParams.get('game') ?? (remembered && localGameRoomExists(remembered) ? remembered : null);
      let freshGame = true;
      if (forcedGame && isRoomCode(forcedGame.toUpperCase())) {
        gameId = forcedGame.toUpperCase();
        freshGame = !(await roomExists(gameId));
      } else {
        let attempts = 0;
        do {
          gameId = generateRoomCode();
          attempts += 1;
        } while (attempts < 8 && (await roomExists(gameId)));
        if (await roomExists(gameId)) {
          throw new Error('Could not reserve a tabletop. Reload to try again.');
        }
      }

      const joinBase = `${location.origin}${base}/hand/`;
      legacyPhone = pageParams.get('phone') === '1';
      if (legacyPhone) seatQrs = await Promise.all(([1, 2] as const).map(async (seat) => {
        const url = `${joinBase}?gameId=${gameId}&seat=${seat}`;
        return {
          seat,
          url,
          image: await QRCode.toDataURL(url, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 360,
            color: { dark: '#183a37', light: '#fffaf0' }
          })
        };
      }));

      if (localStore) localStorage.setItem(currentKey, gameId);
      const attached = localStore
        ? createLocalGameRepository(gameId, hostUid)
        : createGameRepository(services!.db, gameId, hostUid);
      repository = attached;
      attached.subscribe(
        (events) => {
          const previous = lobby;
          const next = reduceGame(events);
          const newActivities = repositoryReady
            ? next.activity.filter(({ id }) => !knownActivityIds.has(id))
            : [];
          const previousActiveSeat = activeSeat(previous);
          const nextActiveSeat = activeSeat(next);
          lobby = next;
          for (const activity of next.activity) knownActivityIds.add(activity.id);
          repositoryReady = true;
          const actionAnimation = newActivities.length > 0
            ? animateActivities(newActivities, previous, next)
            : Promise.resolve();
          if (
            nextActiveSeat &&
            nextActiveSeat !== marketFacingSeat &&
            pendingTurnSeat !== nextActiveSeat
          ) {
            if (previousActiveSeat && newActivities.length > 0) {
              pendingTurnSeat = nextActiveSeat;
              void completeTurnTransition(nextActiveSeat, actionAnimation);
            } else {
              applyMarketFacing(nextActiveSeat);
            }
          }
          void maybeOpenFirstRound();
          void tick().then(() => ar?.publishFromState(lobby));
          maybeBotTurn();
        },
        (error) => {
          statusKind = 'error';
          status = error.message;
        },
        (nextStatus) => {
          statusKind = nextStatus === 'synced' ? 'synced' : 'syncing';
          status = nextStatus === 'synced'
            ? (localStore ? 'Tabletop (local store)' : 'Tabletop synced')
            : 'Synchronizing tabletop…';
        }
      );
      if (freshGame) await attached.append('tabletop/created', { gameId });

      // Solitaire/test mode (?bot=1): seat 2 is a computer opponent, so a
      // single player and a single AR phone can exercise the whole loop.
      // Seat 1: the human plays seat 2, which is upright from the test
      // table's viewing side. The join panels also offer "Play as a bot"
      // per seat, so a table can be tested with one or two humans at will.
      solitaire = pageParams.get('bot') === '1';
      if (solitaire && freshGame) await addBot(1);

      // AR attachment: registration underlay + relay session + seat AR QRs.
      ar = new ArTabletop(
        pageParams.get('arsession')?.slice(0, 32) ??
        localStorage.getItem('jaipur:ar:session') ??
        undefined,
        base
      );
      localStorage.setItem('jaipur:ar:session', ar.host.session);
      ar.onJoin = (seat, name) => void joinFromAr(seat, name);
      ar.previewFor = (kind) => (isGood(kind) ? salePreview(kind) : null); // AR-only sale preview
      ar.onViewersChanged = (n) => (arViewers = n);
      ar.attach();
      arDiag = currentDiagInches();
      refreshPhysical();
      if (pageParams.get('scale') === '1') scalePanelOpen = true; // deep link to the panel
      ar.onGeometryChanged = () => {
        refreshPhysical();
        void tick().then(() => ar?.publishFromState(lobby));
      };
      // Publish what the store already holds: with the local store the
      // last notification fired before the AR bridge existed.
      await tick();
      ar.publishFromState(lobby);
      arQrs = await Promise.all(([1, 2] as const).map(async (seat) => ({
        seat,
        url: ar!.arViewerUrl(seat),
        image: await QRCode.toDataURL(ar!.arViewerUrl(seat), {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 360,
          color: { dark: '#0d2622', light: '#eafff0' }
        })
      })));
      // The seat QRs are prime tracking features: re-capture once they show.
      await tick();
      ar.refreshTracking(600);
    } catch (error) {
      statusKind = 'error';
      status = error instanceof Error ? error.message : 'Could not create tabletop';
    }
  });

  function playerForSeat(seat: Seat): Player | undefined {
    return lobby.players.find((player) => player.seat === seat);
  }

  function activeSeat(state = lobby): Seat | undefined {
    const seat = state.players.find((player) => player.uid === state.round?.activeUid)?.seat;
    return seat === 1 || seat === 2 ? seat : undefined;
  }

  function applyMarketFacing(seat: Seat) {
    if (seat === marketFacingSeat) return;
    marketFacingSeat = seat;
    marketRotation += 180;
  }

  async function completeTurnTransition(seat: Seat, actionAnimation: Promise<void>) {
    try {
      await actionAnimation;
      if (seat === marketFacingSeat) return;
      turnPause = true;
      await wait(200);
      turnPause = false;
      turnTransitioning = true;
      applyMarketFacing(seat);
      await wait(matchMedia('(prefers-reduced-motion: reduce)').matches ? 20 : 450);
      turnTransitioning = false;
    } finally {
      turnPause = false;
      turnTransitioning = false;
      if (pendingTurnSeat === seat) pendingTurnSeat = undefined;
      // The turn may already have passed again while this transition ran
      // (the bot answers within a second); catch up instead of waiting for
      // the next store change.
      const live = activeSeat();
      if (live && live !== marketFacingSeat && pendingTurnSeat === undefined) applyMarketFacing(live);
    }
  }

  function toggleMarketFacing() {
    marketFacingEnabled = !marketFacingEnabled;
    localStorage.setItem(
      'jaipur:tabletop:turn-facing-market',
      marketFacingEnabled ? 'on' : 'off'
    );
  }

  function tokenViewSelector(uid: string, selectedSeat?: Seat): string {
    const seat = selectedSeat ?? lobby.players.find((player) => player.uid === uid)?.seat;
    return `[data-token-view-seat="${seat === 1 ? 1 : 2}"]`;
  }

  function playerName(uid: string): string {
    return lobby.players.find((player) => player.uid === uid)?.displayName ?? 'Tabletop';
  }

  function label(kind: Good | 'camel'): string {
    return kind === 'camel' ? 'Camel' : kind[0].toUpperCase() + kind.slice(1);
  }

  function activityDescription(activity: GameActivity): string {
    const count = activity.cardIds?.length ?? 0;
    const kinds = activity.cardKinds?.map((kind) => label(kind as Good | 'camel')) ?? [];
    switch (activity.type) {
      case 'tabletop/created': return 'opened the tabletop';
      case 'tabletop/intent': return 'adjusted a private selection';
      case 'game/created': return 'opened the bazaar';
      case 'bot/added': return 'joined as a client-controlled computer';
      case 'player/joined': return 'joined the table';
      case 'player/ready': return activity.ready ? 'is ready' : 'is no longer ready';
      case 'round/started': return `opened round ${activity.roundNumber ?? ''}`;
      case 'cards/draw-initiated': return 'started a draw';
      case 'cards/draw-abandoned': return 'cancelled a draw';
      case 'cards/taken-one': return `took ${kinds[0] ?? 'a good'}`;
      case 'cards/taken-camels': return `took all ${count} ${count === 1 ? 'camel' : 'camels'}`;
      case 'cards/exchanged': return `traded ${count} for ${count}`;
      case 'cards/sold': return `sold ${count} ${kinds[0] ?? 'goods'}${activity.tokenCount ? ` · ${activity.tokenCount} tokens` : ''}`;
      case 'game/rematched': return 'started a rematch';
    }
  }

  async function maybeOpenFirstRound() {
    if (
      !repository ||
      startingRound ||
      lobby.mode !== 'tabletop' ||
      lobby.players.length !== 2 ||
      !lobby.players.every(({ ready }) => ready) ||
      lobby.round
    ) return;
    startingRound = true;
    try {
      await repository.append('round/started', {
        seed: new URLSearchParams(location.search).get('seed') ?? crypto.randomUUID(),
        starterUid: playerForSeat(1)?.uid,
        roundNumber: 1
      });
    } finally {
      startingRound = false;
    }
  }

  // The boring computer opponent: the shipped apprentice bot, driven from
  // the tabletop page. Tabletop mode already lets the host act on behalf of
  // any seated player, so its moves need no additional trust.
  function maybeBotTurn() {
    const botUid = lobby.bot?.uid;
    const round = lobby.round;
    if (!botUid || !repository || round?.status !== 'active' || round.activeUid !== botUid) return;
    const key = `${lobby.epoch}:${round.number}:${round.turnNumber}`;
    if (scheduledBotKey === key) return;
    scheduledBotKey = key;
    setTimeout(() => void playBotTurn(key), 800);
  }

  async function playBotTurn(expectedKey: string) {
    const botUid = lobby.bot?.uid;
    const round = lobby.round;
    if (!botUid || !repository || round?.status !== 'active' || round.activeUid !== botUid) return;
    if (`${lobby.epoch}:${round.number}:${round.turnNumber}` !== expectedKey) return;
    if (cardFlights.length > 0 || tokenFlights.length > 0) {
      setTimeout(() => void playBotTurn(expectedKey), 120);
      return;
    }
    const observation = createBotObservation(lobby);
    const action = observation ? chooseBotAction(observation) : null;
    if (!observation || !action) return;
    const event = botActionEvent(observation, action);
    try {
      await repository.append(event.type, event.payload);
    } catch {
      scheduledBotKey = '';
    }
  }

  // Seat the shipped apprentice bot on an empty seat (one bot per table).
  async function addBot(seat: Seat) {
    if (!repository || lobby.bot || playerForSeat(seat) || busy) return;
    await repository.append('bot/added', {
      botUid: `bot-${hostUid}`,
      displayName: 'Boring Bot',
      difficulty: 'apprentice',
      engineVersion: 1,
      seat
    });
  }

  // AR phones seated at this table (their uid marks them); when fewer
  // phones are connected than AR seats, someone has dropped and the seat
  // QR is shown again inline so they can rescan.
  const arSeatedCount = () => lobby.players.filter((p) => p.uid.startsWith('ar-')).length;
  const seatDropped = (player: Player) => player.uid.startsWith('ar-') && arViewers < arSeatedCount();

  // A phone that scanned a seat's AR QR asks to sit down with a trader
  // name. The relay stamps the seat, so a phone can only ever claim the seat
  // it scanned. The table seats it on the phone's behalf (the phone never
  // touches the game store), marks it ready, and from then on the phone is
  // purely a window: every game interaction happens on this tabletop.
  const arSeatUid = (seat: Seat) => `ar-${gameId}-${seat}`;
  async function joinFromAr(seatToken: string, name: string) {
    const seat = Number(seatToken);
    if ((seat !== 1 && seat !== 2) || !repository || !gameId) return;
    const uid = arSeatUid(seat as Seat);
    const holder = playerForSeat(seat as Seat);
    if (holder) {
      // Already seated (a reconnecting phone re-sends its join): just make
      // sure the phone hears its name back.
      if (holder.uid === uid) ar?.rememberSeatName(seatToken, holder.displayName);
      return;
    }
    if (lobby.players.some((player) => player.uid === uid)) return;
    ar?.rememberSeatName(seatToken, name);
    await repository.append('player/joined', { displayName: name, seat, playerUid: uid });
    await repository.append('player/ready', { playerUid: uid, ready: true });
  }

  // On-table private-card selection: the active trader taps their own
  // face-down cards (or herd camels) to stage them for a trade — the AR
  // phone shows which is which and glows the selected ones.
  function canSelectReturns(uid: string): boolean {
    return lobby.round?.status === 'active' && lobby.round.activeUid === uid && !pendingDraw && !busy;
  }

  // The camel pile is one tap target: each tap stages the top camel that
  // isn't already selected or placed; once none is left, a tap unstages the
  // most recently selected one (so the pile cycles rather than dead-ends).
  function herdSelectedCount(uid: string): number {
    const selected = selectedReturnIds(uid);
    return (lobby.round?.herds[uid] ?? []).filter((c) => selected.includes(c.id)).length;
  }

  async function toggleHerd(uid: string) {
    if (!canSelectReturns(uid)) return;
    const herd = lobby.round?.herds[uid] ?? [];
    const loads = Object.values(exchangeLoads(uid));
    const selected = selectedReturnIds(uid);
    const next = [...herd].reverse().find((c) => !selected.includes(c.id) && !loads.includes(c.id));
    if (next) {
      await publishIntent(uid, [...selected, next.id], exchangeLoads(uid));
      return;
    }
    const lastCamel = [...selected].reverse().find((id) => herd.some((c) => c.id === id));
    if (lastCamel) await publishIntent(uid, selected.filter((id) => id !== lastCamel), exchangeLoads(uid));
  }

  async function toggleReturn(uid: string, cardId: string) {
    if (!canSelectReturns(uid)) return;
    const loads = exchangeLoads(uid);
    if (Object.values(loads).includes(cardId)) return; // already placed beside a market card
    const selected = new Set(selectedReturnIds(uid));
    if (selected.has(cardId)) selected.delete(cardId);
    else selected.add(cardId);
    await publishIntent(uid, [...selected], loads);
  }

  async function appendFor(
    playerUid: string,
    type: GameEventType,
    payload: Record<string, unknown>
  ) {
    if (!repository || !lobby.round || lobby.round.activeUid !== playerUid || busy) return;
    requestBusy = true;
    try {
      await repository.append(type, {
        ...payload,
        playerUid,
        roundNumber: lobby.round.number,
        turnNumber: lobby.round.turnNumber
      });
    } finally {
      requestBusy = false;
    }
  }

  function selectedReturnIds(uid: string): string[] {
    return lobby.tabletopIntents[uid]?.selectedReturnIds ?? [];
  }

  function exchangeLoads(uid: string): Record<string, string> {
    return lobby.tabletopIntents[uid]?.exchangeLoads ?? {};
  }

  async function publishIntent(
    uid: string,
    selectedReturnIds: string[],
    loads: Record<string, string>
  ) {
    if (!lobby.round) return;
    await appendFor(uid, 'tabletop/intent', {
      selectedReturnIds,
      exchangeLoads: loads
    });
  }

  async function chooseMarket(card: Card) {
    if (!lobby.round || pendingDraw || busy) return;
    await appendFor(lobby.round.activeUid, 'cards/draw-initiated', { cardId: card.id });
  }

  async function abandonPendingDraw() {
    const draw = pendingDraw;
    if (!draw || busy) return;
    await appendFor(draw.activeUid, 'cards/draw-abandoned', {});
  }

  async function confirmPendingDraw() {
    const draw = pendingDraw;
    if (!draw) return;
    if (draw.kind === 'camels') {
      await appendFor(draw.activeUid, 'cards/taken-camels', {});
    } else {
      await appendFor(draw.activeUid, 'cards/taken-one', { cardId: draw.cardIds[0] });
    }
  }

  function isPendingDrawCard(cardId: string): boolean {
    return pendingDraw?.cardIds.includes(cardId) ?? false;
  }

  async function chooseExchangeTarget(uid: string, marketCardId: string) {
    if (!lobby.round || lobby.round.activeUid !== uid || busy || pendingDraw) return;
    const loads = exchangeLoads(uid);
    const loadedReturn = loads[marketCardId];
    if (loadedReturn) {
      const nextLoads = Object.fromEntries(
        Object.entries(loads).filter(([candidate]) => candidate !== marketCardId)
      );
      await publishIntent(uid, [...selectedReturnIds(uid), loadedReturn], nextLoads);
      return;
    }
    const returnCardId = selectedReturnIds(uid)[0];
    if (!returnCardId) return;
    startIntentFlight(uid, returnCardId, marketCardId);
    let remaining = selectedReturnIds(uid).filter((id) => id !== returnCardId);
    const nextLoads = { ...loads, [marketCardId]: returnCardId };
    // Play improvement: placing a camel re-selects the next free camel, so
    // a multi-camel trade is one tap per market card.
    const herd = lobby.round.herds[uid] ?? [];
    if (herd.some((c) => c.id === returnCardId) && remaining.length === 0) {
      const placed = Object.values(nextLoads);
      const nextCamel = [...herd].reverse().find((c) => !placed.includes(c.id));
      if (nextCamel) remaining = [nextCamel.id];
    }
    await publishIntent(uid, remaining, nextLoads);
  }

  // Why the staged exchange can't be confirmed yet, in the player's terms
  // (mirrors isLegalExchange, which only answers yes/no).
  function exchangeProblem(uid: string): string | null {
    const round = lobby.round;
    if (!round) return null;
    const loads = exchangeLoads(uid);
    const taken = round.market.filter(({ id }) => id in loads);
    const returnedIds = Object.values(loads);
    const available = [...(round.hands[uid] ?? []), ...(round.herds[uid] ?? [])];
    const returned = available.filter(({ id }) => returnedIds.includes(id));
    if (taken.length < 2) return 'Place at least two returns to trade.';
    const takenGoods = new Set(taken.map(({ kind }) => kind));
    const clash = returned.find(({ kind }) => kind !== 'camel' && takenGoods.has(kind));
    if (clash) return `You can't return ${label(clash.kind)} while taking ${label(clash.kind)}.`;
    const fromHand = returned.filter((card) => round.hands[uid]?.some(({ id }) => id === card.id)).length;
    if ((round.hands[uid]?.length ?? 0) - fromHand + taken.length > 7) return 'That would leave more than 7 cards in your hand.';
    return isLegalExchange(round, uid, Object.keys(loads), returnedIds) ? null : 'This trade is not allowed.';
  }

  async function confirmExchange(uid: string) {
    if (!lobby.round || pendingDraw) return;
    const loads = exchangeLoads(uid);
    const takenCardIds = Object.keys(loads);
    const returnedCardIds = Object.values(loads);
    if (!isLegalExchange(lobby.round, uid, takenCardIds, returnedCardIds)) return;
    await appendFor(uid, 'cards/exchanged', { takenCardIds, returnedCardIds });
  }

  function saleIds(uid: string, kind: Good): string[] {
    if (!lobby.round) return [];
    const selected = selectedReturnIds(uid);
    if (selected.length > 0) {
      return selected.every((id) => lobby.round?.hands[uid]?.find((card) => card.id === id)?.kind === kind)
        ? selected
        : [];
    }
    return lobby.round.hands[uid]?.filter((card) => card.kind === kind).map(({ id }) => id) ?? [];
  }

  // What selling `kind` right now would earn: the top tokens of that stack
  // for the cards that would be sold, plus the bonus range for 3/4/5+.
  function salePreview(kind: Good): SalePreview | null {
    const uid = lobby.round?.activeUid;
    if (!uid || !lobby.round || !canSell(kind)) return null;
    const cards = saleIds(uid, kind).length;
    const base = lobby.round.goodsTokens[kind].slice(0, cards).reduce((sum, token) => sum + token.value, 0);
    const size = cards >= 5 ? '5' : cards === 4 ? '4' : cards === 3 ? '3' : null;
    const bonus = size && lobby.round.bonusTokens[size].length > 0
      ? { '3': '1–3', '4': '4–6', '5': '8–10' }[size]
      : null;
    return { cards, base, bonus };
  }

  // Abandon a partially staged trade: clears placed returns and selection.
  async function cancelTrade(uid: string) {
    if (!lobby.round || lobby.round.activeUid !== uid) return;
    await publishIntent(uid, [], {});
  }

  // Sale celebration: after the token flights land, a summary rises from
  // the player's token zone ("4 tokens · +7!") and fades.
  let saleSummaries = $state<Array<{ key: number; left: number; top: number; inverted: boolean; count: number; cards: number }>>([]);

  function canSell(kind: Good): boolean {
    const uid = lobby.round?.activeUid;
    if (!uid || !lobby.round || busy || pendingDraw || Object.keys(exchangeLoads(uid)).length > 0) return false;
    const ids = saleIds(uid, kind);
    return isLegalSale(lobby.round, uid, kind, ids);
  }

  async function sell(kind: Good, supplySeat: Seat) {
    const uid = lobby.round?.activeUid;
    if (!uid) return;
    saleTokenViewSeats[uid] = supplySeat;
    await appendFor(uid, 'cards/sold', { kind, cardIds: saleIds(uid, kind) });
  }

  function ownedTokens(uid: string): Token[] {
    if (!lobby.round) return [];
    return [
      ...(lobby.round.ownedGoodsTokens[uid] ?? []),
      ...(lobby.round.ownedBonusTokens[uid] ?? [])
    ];
  }

  async function nextRound() {
    if (!repository || !lobby.round || lobby.round.status !== 'complete' || lobby.winnerUid) return;
    await repository.append('round/started', {
      seed: crypto.randomUUID(),
      starterUid: lobby.round.loserUid,
      roundNumber: lobby.round.number + 1
    });
  }

  async function rematch() {
    if (!repository || !lobby.winnerUid) return;
    await repository.append('game/rematched', { epoch: lobby.epoch + 1 });
    await repository.append('round/started', {
      seed: crypto.randomUUID(),
      starterUid: playerForSeat(1)?.uid,
      roundNumber: 1
    });
  }

  function box(selector: string): DOMRect | undefined {
    return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
  }

  function cardFlight(
    source: DOMRect | undefined,
    destination: DOMRect | undefined,
    image: string,
    delay = 0,
    cardId?: string,
    revealImage?: string,
    concealsDestination = false
  ) {
    if (!source || !destination) {
      if (cardId) arrivingCardIds = arrivingCardIds.filter((id) => id !== cardId);
      return;
    }
    const startSize = Math.min(source.width, source.height);
    const endSize = Math.min(destination.width, destination.height, startSize);
    const key = ++flightSequence;
    cardFlights = [...cardFlights, {
      key,
      cardId,
      image,
      revealImage,
      concealsDestination,
      startLeft: source.left + (source.width - startSize) / 2,
      startTop: source.top + (source.height - startSize) / 2,
      startSize,
      endLeft: destination.left + (destination.width - endSize) / 2,
      endTop: destination.top + (destination.height - endSize) / 2,
      endSize,
      delay
    }];
    setTimeout(() => finishCardFlight(key), 1400 + delay);
  }

  function finishCardFlight(key: number) {
    const finished = cardFlights.find((flight) => flight.key === key);
    cardFlights = cardFlights.filter((flight) => flight.key !== key);
    if (finished?.concealsDestination && finished.cardId) {
      arrivingCardIds = arrivingCardIds.filter((cardId) => cardId !== finished.cardId);
    }
  }

  function startIntentFlight(uid: string, returnCardId: string, marketCardId: string) {
    const fromHand = lobby.round?.hands[uid]?.some(({ id }) => id === returnCardId);
    const source = fromHand
      ? box(`[data-table-hand-card="${CSS.escape(returnCardId)}"]`)
      : box(`[data-table-herd="${CSS.escape(uid)}"] img:last-of-type`);
    const destination = box(`[data-table-exchange-target="${CSS.escape(marketCardId)}"]`);
    arrivingCardIds = [...new Set([...arrivingCardIds, returnCardId])];
    cardFlight(
      source,
      destination,
      componentImage('card-back'),
      0,
      returnCardId,
      undefined,
      true
    );
  }

  async function animateActivities(
    activities: GameActivity[],
    previous: GameState,
    next: GameState
  ) {
    const movements: Array<{
      cardId: string;
      source: DOMRect | undefined;
      destinationSelector: string;
      image: string;
      revealImage?: string;
      concealDestination: boolean;
      delay: number;
    }> = [];
    const tokenMovements: Array<{
      source: DOMRect | undefined;
      destinationSelector: string;
      token: Token;
      delay: number;
    }> = [];

    for (const activity of activities) {
      const uid = activity.actorUid;
      if (activity.type === 'cards/taken-one' || activity.type === 'cards/taken-camels') {
        activity.cardIds?.forEach((cardId, index) => {
          const kind = activity.cardKinds?.[index] as Good | 'camel' | undefined;
          movements.push({
            cardId,
            source: box(`[data-market-card-id="${CSS.escape(cardId)}"]`),
            destinationSelector: kind === 'camel'
              ? `[data-table-herd="${CSS.escape(uid)}"]`
              : `[data-table-hand="${CSS.escape(uid)}"]`,
            image: componentImage(kind ?? 'card-back'),
            concealDestination: true,
            delay: index * 70
          });
        });
      }
      if (activity.type === 'cards/exchanged') {
        activity.cardIds?.forEach((cardId, index) => movements.push({
          cardId,
          source: box(`[data-market-card-id="${CSS.escape(cardId)}"]`),
          destinationSelector: `[data-table-hand="${CSS.escape(uid)}"]`,
          image: componentImage((activity.cardKinds?.[index] as Good) ?? 'card-back'),
          concealDestination: true,
          delay: index * 70
        }));
        const previousLoads = previous.tabletopIntents[uid]?.exchangeLoads ?? {};
        activity.returnedCardIds?.forEach((cardId, index) => {
          const targetId = Object.entries(previousLoads).find(([, returnId]) => returnId === cardId)?.[0];
          movements.push({
            cardId,
            source: targetId ? box(`[data-table-exchange-target="${CSS.escape(targetId)}"]`) : undefined,
            destinationSelector: `[data-market-card-id="${CSS.escape(cardId)}"]`,
            image: componentImage('card-back'),
            revealImage: componentImage(
              (activity.returnedCardKinds?.[index] as Good | 'camel' | undefined) ?? 'card-back'
            ),
            concealDestination: true,
            delay: index * 70
          });
        });
      }
      if (activity.type === 'cards/sold') {
        const tokenView = tokenViewSelector(uid, saleTokenViewSeats[uid]);
        delete saleTokenViewSeats[uid];
        activity.cardIds?.forEach((cardId, index) => movements.push({
          cardId,
          source: box(`[data-table-hand-card="${CSS.escape(cardId)}"]`),
          destinationSelector: `${tokenView} [data-token-kind="${CSS.escape(
            (activity.cardKinds?.[index] as Good | undefined) ?? 'leather'
          )}"]`,
          image: componentImage('card-back'),
          concealDestination: false,
          delay: index * 55
        }));
        const oldTokens = new Set([
          ...(previous.round?.ownedGoodsTokens[uid] ?? []),
          ...(previous.round?.ownedBonusTokens[uid] ?? [])
        ].map(({ id }) => id));
        const awards = [
          ...(next.round?.ownedGoodsTokens[uid] ?? []),
          ...(next.round?.ownedBonusTokens[uid] ?? [])
        ].filter(({ id }) => !oldTokens.has(id));
        awards.forEach((token, index) => tokenMovements.push({
          source: token.kind.startsWith('bonus-')
            ? box(`${tokenView} [data-bonus-size="${token.kind.replace('bonus-', '')}"]`)
            : box(`${tokenView} [data-token-kind="${CSS.escape(token.kind)}"] .rail-chip`),
          destinationSelector: `[data-table-tokens="${CSS.escape(uid)}"]`,
          token,
          delay: 180 + index * 80
        }));
      }
    }

    const previousMarketIds = new Set(previous.round?.market.map(({ id }) => id) ?? []);
    const returnedIds = new Set(activities.flatMap(({ returnedCardIds }) => returnedCardIds ?? []));
    const refills = next.round?.market.filter(
      ({ id }) => !previousMarketIds.has(id) && !returnedIds.has(id)
    ) ?? [];
    refills.forEach((card, index) => movements.push({
      cardId: card.id,
      source: box('.deck-card'),
      destinationSelector: `[data-market-card-id="${CSS.escape(card.id)}"]`,
      image: componentImage('card-back'),
      revealImage: componentImage(card.kind),
      concealDestination: true,
      delay: 120 + index * 70
    }));

    const hasAnimation = movements.length > 0 || tokenMovements.length > 0;
    if (hasAnimation) actionAnimating = true;
    arrivingCardIds = [...new Set([
      ...arrivingCardIds,
      ...movements.filter(({ concealDestination }) => concealDestination).map(({ cardId }) => cardId)
    ])];
    await tick();
    movements.forEach(({ cardId, source, destinationSelector, image, revealImage, concealDestination, delay }) =>
      cardFlight(
        source,
        box(destinationSelector),
        image,
        delay,
        cardId,
        revealImage,
        concealDestination
      )
    );
    tokenMovements.forEach(({ source, destinationSelector, token, delay }) => {
      const destination = box(destinationSelector);
      if (!source || !destination) return;
      const startSize = Math.min(source.width, source.height, 64);
      const endSize = Math.min(destination.width, destination.height, startSize);
      const key = ++flightSequence;
      tokenFlights = [...tokenFlights, {
        key,
        token,
        startLeft: source.left + (source.width - startSize) / 2,
        startTop: source.top + (source.height - startSize) / 2,
        startSize,
        endLeft: destination.left + (destination.width - endSize) / 2,
        endTop: destination.top + (destination.height - endSize) / 2,
        endSize,
        delay
      }];
      setTimeout(() => tokenFlights = tokenFlights.filter((flight) => flight.key !== key), 1000 + delay);
    });
    for (const activity of activities) {
      if (activity.type !== 'cards/sold' || tokenMovements.length === 0) continue;
      const uid = activity.actorUid;
      const target = box(`[data-table-tokens="${CSS.escape(uid)}"]`);
      if (!target) continue;
      const cards = activity.cardIds?.length ?? 0;
      const seat = lobby.players.find((p) => p.uid === uid)?.seat;
      const key = ++flightSequence;
      const lastDelay = Math.max(...tokenMovements.map((m) => m.delay));
      setTimeout(() => {
        saleSummaries = [...saleSummaries, {
          key, left: target.left + target.width / 2, top: target.top + target.height / 2,
          inverted: seat === 1, count: tokenMovements.length, cards
        }];
        setTimeout(() => saleSummaries = saleSummaries.filter((entry) => entry.key !== key), 2600);
      }, 900 + lastDelay);
    }
    if (hasAnimation) {
      try {
        while (cardFlights.length > 0 || tokenFlights.length > 0) await wait(25);
      } finally {
        actionAnimating = false;
      }
    }
  }
</script>

{#snippet joinSeat(seat: Seat)}
  {@const qr = seatQrs.find((candidate) => candidate.seat === seat)}
  {@const arQr = arQrs.find((candidate) => candidate.seat === seat)}
  <section class="join-seat" data-seat={seat} aria-label={`Player ${seat} join code`}>
    <div>
      <span class="seat-kicker">Player {seat}</span>
      <h2>Scan to sit here</h2>
      <p>Scan with the AR viewer and enter your name. The market opens when both seats join.</p>
    </div>
    {#if arQr}
      <div class="ar-join">
        <a href={arQr.url} class="qr-frame ar-frame" aria-label={`Sit here with the AR viewer as Player ${seat}`}>
          <img src={arQr.image} alt={`QR code to sit here with the AR viewer as Player ${seat}`} />
        </a>
        <span data-ar-session={ar?.host.session}>AR viewer{arViewers > 0 ? ` · ${arViewers} phone${arViewers === 1 ? '' : 's'}` : ''}</span>
      </div>
    {:else}
      <span class="qr-placeholder" aria-hidden="true"></span>
    {/if}
    {#if legacyPhone && qr}
      <a href={qr.url} class="qr-frame" aria-label={`Join tabletop ${gameId} as Player ${seat} with the phone controller`}>
        <img src={qr.image} alt={`QR code to join as Player ${seat} with the phone controller`} />
      </a>
    {/if}
    {#if !lobby.bot}
      <button type="button" class="bot-seat-button" data-bot-seat={seat} disabled={!repository || busy} onclick={() => addBot(seat)}>
        Play as a bot
      </button>
    {/if}
  </section>
{/snippet}

{#snippet playerSeat(seat: Seat, player: Player)}
  {@const isActive = lobby.round?.status === 'active' && seat === marketFacingSeat}
  <section
    class="player-seat"
    class:active={isActive}
    data-seat={seat}
    data-player-uid={player.uid}
    aria-label={`Player ${seat}, ${player.displayName}`}
  >
    <header>
      <div>
        <span class="seat-kicker">Player {seat}</span>
        <h2>{player.displayName}</h2>
      </div>
      <strong class="turn-state">{isActive ? 'Your turn' : 'Waiting'}</strong>
      <span>{lobby.seals[player.uid] ?? 0} / 2 seals</span>
      {#if seatDropped(player)}
        {@const arQr = arQrs.find((candidate) => candidate.seat === seat)}
        {#if arQr}
          <span class="rejoin" data-rejoin-seat={seat}>
            <img src={arQr.image} alt={`QR code to rejoin as Player ${seat}`} />
            <small>Phone dropped — rescan to rejoin</small>
          </span>
        {/if}
      {/if}
    </header>
    <div class="seat-body">
      <div
        class="tabletop-hand"
        data-table-hand={player.uid}
        role="group"
        aria-label={`${player.displayName} has ${lobby.round?.hands[player.uid]?.length ?? 0} face-down cards`}
      >
        {#each Array(Math.max(0, 7 - (lobby.round?.hands[player.uid]?.length ?? 0))) as _, slot}
          <span class="hand-slot" aria-hidden="true" data-hand-slot={slot}></span>
        {/each}
        {#each lobby.round?.hands[player.uid] ?? [] as card}
          {@const selected = selectedReturnIds(player.uid).includes(card.id)}
          {@const loaded = Object.values(exchangeLoads(player.uid)).includes(card.id)}
          <button
            type="button"
            class="table-hand-card"
            class:arriving={arrivingCardIds.includes(card.id)}
            class:selected
            class:loaded
            disabled={!canSelectReturns(player.uid) || loaded}
            aria-pressed={selected}
            aria-label={`${selected ? 'Deselect' : 'Select'} face-down card for a trade`}
            data-table-hand-card={card.id}
            data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
            onclick={() => toggleReturn(player.uid, card.id)}
          >
            <img src={componentImage('card-back')} alt="" draggable="false" />
          </button>
        {/each}
      </div>
      <div
        class="tabletop-herd"
        data-table-herd={player.uid}
        role="img"
        aria-label={`${player.displayName}'s camel herd`}
      >
        <button
          type="button"
          class="herd-pile"
          disabled={!canSelectReturns(player.uid) || (lobby.round?.herds[player.uid]?.length ?? 0) === 0}
          aria-label={`Camel pile: tap to select the next camel for a trade (${herdSelectedCount(player.uid)} selected)`}
          data-table-herd-pile={player.uid}
          onclick={() => toggleHerd(player.uid)}
        >
          {#each (lobby.round?.herds[player.uid] ?? []).slice(-5) as camel, index}
            {@const selected = selectedReturnIds(player.uid).includes(camel.id)}
            {@const loaded = Object.values(exchangeLoads(player.uid)).includes(camel.id)}
            <img
              class="table-herd-card"
              class:arriving={arrivingCardIds.includes(camel.id)}
              class:selected
              class:loaded
              src={componentImage('camel')}
              alt=""
              draggable="false"
              data-table-herd-card={camel.id}
              data-card-arriving={arrivingCardIds.includes(camel.id) || undefined}
              style={`--pile-index:${index}`}
            />
          {/each}
          <span class="herd-count" data-herd-count={player.uid} aria-hidden="true">{lobby.round?.herds[player.uid]?.length ?? 0}</span>
          {#if herdSelectedCount(player.uid) > 0}<span class="herd-badge">{herdSelectedCount(player.uid)} staged</span>{/if}
        </button>
        <span>Herd</span>
      </div>
    </div>
    <div class="seat-tokens" data-table-tokens={player.uid} aria-label={`${player.displayName}'s earned tokens`}>
      {#each lobby.round?.ownedGoodsTokens[player.uid] ?? [] as token (token.id)}
        <span class="earned" data-owned-token-id={token.id}><TokenChip {token} /></span>
      {/each}
      {#each lobby.round?.ownedBonusTokens[player.uid] ?? [] as token (token.id)}
        <span class="earned bonus" data-owned-token-id={token.id} data-owned-bonus={token.id}><TokenChip {token} hidden /></span>
      {/each}
      {#if ownedTokens(player.uid).length === 0}<small>No tokens yet</small>{/if}
    </div>
  </section>
{/snippet}

{#snippet gameLog(inverted: boolean)}
  <details class="corner-log" class:inverted aria-label={inverted ? 'Player 1 game log' : 'Player 2 game log'}>
    <summary>Game log <span>{lobby.activity.length}</span></summary>
    <ol reversed>
      {#each [...lobby.activity].reverse().slice(0, 7) as activity}
        <li><strong>{playerName(activity.actorUid)}</strong> {activityDescription(activity)}</li>
      {/each}
    </ol>
  </details>
{/snippet}

<svelte:head>
  <title>Jaipur Tabletop</title>
  <meta name="description" content="A shared two-player Jaipur tabletop." />
</svelte:head>

<main class="tabletop" data-e2e-tabletop data-e2e-layout>
  <div class="top-edge edge">
    <div class="inverted-content">
      {#if playerForSeat(1)}
        {@render playerSeat(1, playerForSeat(1)!)}
      {:else}
        {@render joinSeat(1)}
      {/if}
    </div>
  </div>

  <section
    class="shared-market"
    class:draw-pending={Boolean(pendingDraw)}
    class:turn-facing={marketFacingEnabled}
    aria-label="Shared market"
    data-market-facing-seat={marketFacingSeat}
    data-turn-facing-enabled={marketFacingEnabled}
    data-turn-phase={actionAnimating ? 'action' : turnPause ? 'pause' : turnTransitioning ? 'rotation' : 'ready'}
    style={`--market-art: url("${componentImage('card-back')}")`}
  >
    <header>
      <span>Tabletop <strong>{gameId || '•••••'}</strong></span>
      <button
        type="button"
        class="orientation-toggle"
        aria-expanded={scalePanelOpen}
        aria-label="AR screen scale settings"
        data-ar-diag={arDiag}
        onclick={() => { scalePanelOpen = !scalePanelOpen; refreshPhysical(); }}
      ><span class="scale-gear" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="1em" height="1em">
            <path fill="currentColor" d="M24 4l3 4.5 5.3-1.4 1.4 5.3L38.5 15 36 20l4 3.6-4 3.6 2.5 5-4.8 2.6-1.4 5.3-5.3-1.4L24 44l-3-4.5-5.3 1.4-1.4-5.3L9.5 33 12 28l-4-3.6 4-3.6-2.5-5 4.8-2.6 1.4-5.3 5.3 1.4z" opacity="0.28"/>
            <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M15 33L33 15M15 33h5m-5 0v-5M33 15h-5m5 0v5"/>
          </svg>
          <b>{arDiag}″</b>
        </span>{#if physical && !physical.fullscreen}<small class="scale-note">win</small>{/if}</button>
      {#if lobby.round}
        <span>Round {lobby.round.number}</span>
        <button
          type="button"
          class="orientation-toggle"
          aria-pressed={marketFacingEnabled}
          aria-label="Face market cards toward the active trader"
          onclick={toggleMarketFacing}
        >Facing {marketFacingEnabled ? 'on' : 'off'}</button>
      {:else}
        <span>Waiting for both traders</span>
      {/if}
    </header>
    {#if lobby.round?.status === 'active'}
      {@const activeUid = lobby.round.activeUid}
      {@const promptLoads = exchangeLoads(activeUid)}
      {@const promptReturns = selectedReturnIds(activeUid)}
      <div
        class="market-prompt"
        class:for-top={marketFacingSeat === 1}
        class:rotating={turnTransitioning}
        role="group"
        aria-label="Tabletop action prompt"
        aria-live="polite"
        data-pending-draw={pendingDraw?.kind}
        data-prompt-seat={marketFacingSeat}
        data-prompt-phase={actionAnimating ? 'action' : turnPause ? 'pause' : turnTransitioning ? 'rotation' : 'ready'}
      >
        {#if actionAnimating}
          <span>Finishing move…</span>
        {:else if turnPause}
          <span>Turn complete</span>
        {:else if turnTransitioning}
          <span>Passing turn…</span>
        {:else if pendingDraw}
          <span>{pendingDraw.kind === 'camels' ? `Take all ${pendingDraw.cardIds.length} camels? Tap a ✓ camel to confirm.` : 'Take this card? Tap it again to confirm.'}</span>
          <button type="button" disabled={busy} data-confirm-draw onclick={confirmPendingDraw}>Confirm</button>
          <button type="button" disabled={busy} data-abandon-draw onclick={abandonPendingDraw}>Undo</button>
        {:else if Object.keys(promptLoads).length >= 2}
          {@const problem = exchangeProblem(activeUid)}
          <span>{problem ?? `${Object.keys(promptLoads).length} returns placed · tap a ✓ card or Trade.`}</span>
          <button
            type="button"
            disabled={!isLegalExchange(lobby.round, activeUid, Object.keys(promptLoads), Object.values(promptLoads))}
            data-confirm-exchange
            onclick={() => confirmExchange(activeUid)}
          >Trade {Object.keys(promptLoads).length} for {Object.values(promptLoads).length}</button>
          <button type="button" class="cancel" disabled={busy} data-cancel-trade onclick={() => cancelTrade(activeUid)}>Cancel</button>
        {:else if Object.keys(promptLoads).length === 1}
          <span>1 return placed · place another, or cancel.</span>
          <button type="button" class="cancel" disabled={busy} data-cancel-trade onclick={() => cancelTrade(activeUid)}>Cancel</button>
        {:else if promptReturns.length > 0}
          <span>{promptReturns.length} selected · tap a return area or token stack.</span>
          <button type="button" class="cancel" disabled={busy} data-cancel-trade onclick={() => cancelTrade(activeUid)}>Clear</button>
        {:else}
          {@const last = lobby.activity.findLast((a) => a.type.startsWith('cards/'))}
          {@const activeName = lobby.players.find((p) => p.uid === activeUid)?.displayName ?? 'Trader'}
          <span>
            {#if last && last.actorUid !== activeUid}<strong>{playerName(last.actorUid)}</strong> {activityDescription(last)} · {/if}
            <strong>{activeName}</strong>: tap your face-down cards (see them in AR) to select, then use the market or token supplies.
          </span>
        {/if}
      </div>
      <div class="market-stage">
        <span class="deck" aria-label={`Deck, ${lobby.round.deck.length} cards`}>
          <span class="deck-count deck-count-top" aria-hidden="true">
            <span>Deck</span><b>{lobby.round.deck.length}</b>
          </span>
          <img class="deck-card" src={componentImage('card-back')} alt="" />
          <span class="deck-count" aria-hidden="true">
            <span>Deck</span><b>{lobby.round.deck.length}</b>
          </span>
        </span>
        <div class="market-cards">
          <StableMarketLayout>
          {#snippet slot(marketIndex)}
          {@const round = lobby.round!}
          {@const card = round.market[marketIndex]}
          {@const activeUid = round.activeUid}
          {@const loadedReturnId = exchangeLoads(activeUid)[card.id]}
          {@const exchangeReady = Boolean(loadedReturnId) && !pendingDraw &&
            isLegalExchange(round, activeUid, Object.keys(exchangeLoads(activeUid)), Object.values(exchangeLoads(activeUid)))}
          <div
            class="table-market-slot"
            data-market-slot-index={marketIndex}
            style={`--market-rotation:${marketRotation}deg`}
          >
            {#if isPendingDrawCard(card.id)}
              <button
                type="button"
                class="market-card confirm-ready"
                class:camel={card.kind === 'camel'}
                disabled={busy}
                aria-label={pendingDraw?.kind === 'camels' ? 'Confirm: take all camels' : 'Confirm: take this card'}
                data-market-card-id={card.id}
                data-pending-draw-card={card.id}
                onclick={confirmPendingDraw}
              >
                <PieceArt kind={card.kind} label={label(card.kind)} detail={card.id} />
                <span class="confirm-mark" aria-hidden="true">✓</span>
              </button>
            {:else if exchangeReady}
              <button
                type="button"
                class="market-card confirm-ready"
                disabled={busy}
                aria-label={`Confirm the trade (taking ${label(card.kind)})`}
                data-market-card-id={card.id}
                data-confirm-exchange-card={card.id}
                onclick={() => confirmExchange(activeUid)}
              >
                <PieceArt kind={card.kind} label={label(card.kind)} detail={card.id} />
                <span class="confirm-mark" aria-hidden="true">✓</span>
              </button>
            {:else}
            <button
              type="button"
              class="market-card"
              class:camel={card.kind === 'camel'}
              class:arriving={arrivingCardIds.includes(card.id)}
              disabled={busy || Boolean(pendingDraw) || (card.kind !== 'camel' && (round.hands[activeUid]?.length ?? 0) >= 7)}
              aria-label={card.kind === 'camel' ? `Take all ${round.market.filter(({ kind }) => kind === 'camel').length} camels` : `Take ${label(card.kind)} ${card.id}`}
              data-market-card-id={card.id}
              data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
              onclick={() => chooseMarket(card)}
            >
              <PieceArt kind={card.kind} label={label(card.kind)} detail={card.id} />
            </button>
            {/if}
            {#if card.kind !== 'camel'}
              <button
                type="button"
                class="table-exchange-target"
                class:loaded={Boolean(loadedReturnId)}
                disabled={busy || Boolean(pendingDraw) || (!loadedReturnId && selectedReturnIds(activeUid).length === 0)}
                aria-pressed={Boolean(loadedReturnId)}
                aria-label={loadedReturnId
                  ? `Return the face-down card beside ${label(card.kind)} to your selection`
                  : `Place a selected private card face-down beside ${label(card.kind)}`}
                data-table-exchange-target={card.id}
                data-return-seat={marketFacingSeat}
                onclick={() => chooseExchangeTarget(activeUid, card.id)}
              >
                {#if loadedReturnId}
                  <img
                    class:arriving={arrivingCardIds.includes(loadedReturnId)}
                    src={componentImage('card-back')}
                    alt=""
                    data-loaded-return={loadedReturnId}
                    data-card-arriving={arrivingCardIds.includes(loadedReturnId) || undefined}
                  />
                {:else}
                  <span aria-hidden="true">＋</span>
                  <small>Return</small>
                {/if}
              </button>
            {:else}
              <button
                type="button"
                class="table-exchange-target target-placeholder"
                disabled
                aria-hidden="true"
                tabindex="-1"
                data-return-seat={marketFacingSeat}
              ></button>
            {/if}
          </div>
          {/snippet}
          </StableMarketLayout>
        </div>
      </div>
    {:else if lobby.round?.status === 'complete'}
      <GameSummary
        {lobby}
        componentImage={componentImage}
        onNextRound={lobby.winnerUid ? undefined : nextRound}
        onRematch={lobby.winnerUid ? rematch : undefined}
      />
    {:else}
      <div class="tabletop-mark">
        <img src={componentImage('card-back')} alt="" />
        <strong>{gameId || 'Creating…'}</strong>
        <span>Two seats · one shared market</span>
      </div>
    {/if}
  </section>

  {#if scalePanelOpen && physical}
    {@const cardW = 0.0856 / physical.mPerCssPx}
    {@const cardH = 0.05398 / physical.mPerCssPx}
    <section class="scale-panel" aria-label="AR screen scale">
      <header>
        <strong>AR screen scale</strong>
        <button type="button" onclick={() => (scalePanelOpen = false)} aria-label="Close">✕</button>
      </header>
      <div class="scale-row">
        <span>Screen diagonal</span>
        <button type="button" onclick={() => setDiag(arDiag - 5)} aria-label="5 inches smaller">−5</button>
        <button type="button" onclick={() => setDiag(arDiag - 0.5)} aria-label="Half an inch smaller">−½</button>
        <input
          type="number"
          min={DIAG_MIN}
          max={DIAG_MAX}
          step="0.5"
          value={arDiag}
          onchange={(e) => setDiag(Number((e.currentTarget as HTMLInputElement).value))}
          aria-label="Screen diagonal in inches"
        />
        <span>inches</span>
        <button type="button" onclick={() => setDiag(arDiag + 0.5)} aria-label="Half an inch larger">+½</button>
        <button type="button" onclick={() => setDiag(arDiag + 5)} aria-label="5 inches larger">+5</button>
      </div>
      <p class="scale-check">
        Hold a bank card on the outline: it should match exactly.
        <span class="card-outline" style={`width:${cardW}px;height:${cardH}px`} aria-hidden="true"></span>
      </p>
      <dl class="scale-facts">
        <dt>Screen</dt><dd>{physical.screenCss[0]}×{physical.screenCss[1]} px · {(physical.screenM[0] * 100).toFixed(1)}×{(physical.screenM[1] * 100).toFixed(1)} cm</dd>
        <dt>This page</dt><dd>{physical.viewportCss[0]}×{physical.viewportCss[1]} px · {(physical.viewportM[0] * 100).toFixed(1)}×{(physical.viewportM[1] * 100).toFixed(1)} cm · {(physical.viewportFraction * 100).toFixed(0)}% of the screen{physical.fullscreen ? ' (full screen)' : ''}</dd>
        <dt>Pixel</dt><dd>{(physical.mPerCssPx * 1000).toFixed(3)} mm · ratio {physical.dpr.toFixed(2)} (browser zoom must be 100%)</dd>
        <dt>Phones</dt><dd>told the table image is {(physical.viewportM[0] * 100).toFixed(1)} cm wide; they re-enter AR to pick up a change.</dd>
      </dl>
      <div class="scale-actions">
        <button type="button" onclick={toggleFullscreen}>{physical.fullscreen ? 'Exit full screen' : 'Full screen'}</button>
        <button type="button" onclick={newTable}>New table</button>
      </div>
      <div class="rejoin-codes" aria-label="AR join codes">
        {#each arQrs as arQr}
          {@const holder = playerForSeat(arQr.seat)}
          <figure>
            <img src={arQr.image} alt={`AR viewer QR for Player ${arQr.seat}`} />
            <figcaption>Player {arQr.seat}{holder ? ` · ${holder.displayName}` : ' · open'}<br /><small>{holder ? 'rescan to rejoin' : 'scan to sit here'}</small></figcaption>
          </figure>
        {/each}
        <p><small>{arViewers} phone{arViewers === 1 ? '' : 's'} connected · session {ar?.host.session}</small></p>
      </div>
    </section>
  {/if}

  <div class="bottom-edge edge">
    {#if playerForSeat(2)}
      {@render playerSeat(2, playerForSeat(2)!)}
    {:else}
      {@render joinSeat(2)}
    {/if}
  </div>

  <div class="token-view top-token-view">
    <TabletopTokenMarket
      seat={1}
      round={lobby.round}
      {goods}
      inverted
      {label}
      {canSell}
      onSell={(kind) => sell(kind, 1)}
    />
  </div>
  <div class="token-view bottom-token-view">
    <TabletopTokenMarket
      seat={2}
      round={lobby.round}
      {goods}
      {label}
      {canSell}
      onSell={(kind) => sell(kind, 2)}
    />
  </div>

  <div class="top-log">{@render gameLog(true)}</div>
  <div class="bottom-log">{@render gameLog(false)}</div>
  <p class="table-status" class:for-top={marketFacingSeat === 1} data-status={statusKind}>{status} · Build {buildHash}</p>
  {#each cardFlights as flight (flight.key)}
    <span
      class="table-card-flight"
      class:flips={Boolean(flight.revealImage)}
      aria-hidden="true"
      style={`--start-left:${flight.startLeft}px;--start-top:${flight.startTop}px;--start-size:${flight.startSize}px;--end-left:${flight.endLeft}px;--end-top:${flight.endTop}px;--end-size:${flight.endSize}px;--flight-delay:${flight.delay}ms`}
      onanimationend={(event) => {
        if (event.currentTarget === event.target) finishCardFlight(flight.key);
      }}
    >
      <span class="table-card-flight-inner">
        <img class="table-card-flight-back" src={flight.image} alt="" />
        {#if flight.revealImage}
          <img class="table-card-flight-front" src={flight.revealImage} alt="" />
        {/if}
      </span>
    </span>
  {/each}
  {#each tokenFlights as flight (flight.key)}
    <span
      class="table-token-flight"
      aria-hidden="true"
      style={`--start-left:${flight.startLeft}px;--start-top:${flight.startTop}px;--start-size:${flight.startSize}px;--end-left:${flight.endLeft}px;--end-top:${flight.endTop}px;--end-size:${flight.endSize}px;--flight-delay:${flight.delay}ms;--arc-lift:${Math.max(40, Math.hypot(flight.endLeft - flight.startLeft, flight.endTop - flight.startTop) * 0.28)}px`}
    ><TokenChip token={flight.token} hidden={flight.token.kind.startsWith('bonus-')} /></span>
  {/each}
  {#each saleSummaries as summary (summary.key)}
    <span
      class="sale-summary"
      class:inverted={summary.inverted}
      aria-hidden="true"
      style={`--left:${summary.left}px;--top:${summary.top}px`}
    >
      <span class="sale-coins">{#each Array(summary.count) as _, i}<i style={`--i:${i}`}></i>{/each}</span>
      <strong>{summary.cards} card{summary.cards === 1 ? '' : 's'} sold!</strong>
    </span>
  {/each}
</main>

<style>
  /* AR QR sits beside the hand QR at the identical footprint. */
  .ar-join { display: grid; justify-items: center; align-content: center; gap: 0.3rem; font-size: 0.66rem; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.9; }
  .qr-frame { display: block; height: min(22vh, 11rem); aspect-ratio: 1; }
  .qr-frame img { width: 100%; height: 100%; border-radius: 0.65rem; }
  .ar-frame img { border: 2px solid #0d2622; }

  :global(*) { box-sizing: border-box; }
  :global(html), :global(body) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
  }
  :global(body) {
    background: #183a37;
    color: #183a37;
    font-family: 'Atkinson Hyperlegible', sans-serif;
  }
  .arriving { visibility: hidden !important; }
  button, summary { font: inherit; }
  button:focus-visible, summary:focus-visible { outline: 3px solid #d38b21; outline-offset: 2px; }
  .tabletop {
    --rail-width: clamp(8.5rem, 17vw, 30rem);
    --edge-size: minmax(0, 25vh);
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-columns: var(--rail-width) minmax(0, 1fr) var(--rail-width);
    grid-template-rows: var(--edge-size) minmax(0, 1fr) var(--edge-size);
    gap: clamp(0.25rem, 0.7vmin, 0.55rem);
    padding: clamp(0.3rem, 0.8vmin, 0.65rem);
    overflow: hidden;
    background:
      radial-gradient(circle at center, rgb(255 250 238 / 94%), rgb(233 220 193 / 98%)),
      #e9dcc1;
  }
  .edge, .shared-market {
    min-width: 0;
    min-height: 0;
    border: 1px solid #9e8a68;
    border-radius: clamp(0.55rem, 1.3vmin, 1rem);
    background: #fffaf0;
    box-shadow: 0 0.25rem 0.8rem rgb(10 32 30 / 16%);
  }
  .top-edge { grid-column: 2; grid-row: 1; }
  .bottom-edge { grid-column: 2; grid-row: 3; }
  .inverted-content { width: 100%; height: 100%; transform: rotate(180deg); }
  .join-seat {
    display: grid;
    width: 100%;
    height: 100%;
    grid-template-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    grid-auto-columns: auto;
    align-items: center;
    gap: 1rem;
    padding: clamp(0.7rem, 1.8vmin, 1.4rem) clamp(5rem, 11vw, 10rem);
  }
  .join-seat h2, .player-seat h2 {
    margin: 0;
    font-family: 'Cormorant Garamond', serif;
    font-size: clamp(1.2rem, 2.8vmin, 2rem);
  }
  .join-seat p { max-width: 34rem; margin: 0.25rem 0 0; font-size: clamp(0.7rem, 1.6vmin, 1rem); }
  .join-seat a { display: block; height: min(22vh, 11rem); aspect-ratio: 1; }
  .join-seat img { width: 100%; height: 100%; border: 2px solid #315f58; border-radius: 0.65rem; }
  .qr-placeholder { width: min(22vh, 11rem); aspect-ratio: 1; border-radius: 0.65rem; background: #e9dcc1; }
  .seat-kicker { color: #a6442d; font-size: clamp(0.62rem, 1.2vmin, 0.78rem); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .player-seat {
    display: grid;
    width: 100%;
    height: 100%;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 0.25rem;
    padding: clamp(0.35rem, 0.8vmin, 0.65rem) clamp(4.6rem, 9vw, 8rem);
    border: 3px solid transparent;
    border-radius: inherit;
    transition: border-color 180ms ease, background 180ms ease;
  }
  .player-seat.active { border-color: #d38b21; background: #fff4d6; }
  .player-seat > header {
    display: grid;
    grid-template-columns: 1fr;
    grid-auto-flow: column;
    grid-auto-columns: auto;
    align-items: center;
    gap: clamp(0.55rem, 1.5vw, 1.4rem);
  }
  .player-seat > header > div { display: flex; align-items: baseline; gap: 0.45rem; }
  .turn-state { padding: 0.2rem 0.55rem; border-radius: 99rem; background: #e9dcc1; }
  .active .turn-state { background: #a6442d; color: white; }
  .seat-body { display: grid; min-height: 0; grid-template-columns: minmax(0, 1fr) clamp(5rem, 10vw, 16rem); align-items: center; gap: 0.5rem; }
  .tabletop-hand { display: flex; min-width: 0; height: 100%; align-items: center; }
  .tabletop-hand > .table-hand-card, .market-card {
    position: relative;
    width: clamp(3.7rem, 9.8vh, 12rem);
    height: clamp(3.7rem, 9.8vh, 12rem);
    flex: 0 0 auto;
    padding: 0.18rem;
    overflow: hidden;
    border: 2px solid #315f58;
    border-radius: 0.55rem;
    background: #183a37;
    color: white;
    object-fit: cover;
  }
  .tabletop-hand > .table-hand-card + .table-hand-card { margin-left: clamp(-1.1rem, -1.9vw, -0.35rem); }
  .table-hand-card, .table-herd-card { cursor: pointer; transition: transform 160ms ease, box-shadow 160ms ease; }
  .table-hand-card > img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .table-hand-card:disabled, .herd-pile:disabled { cursor: default; }
  .herd-pile { display: block; padding: 0; border: none; background: none; cursor: pointer; }
  .herd-badge { position: absolute; right: -0.2rem; bottom: -0.4rem; z-index: 3; min-width: 1.6rem; padding: 0.15rem 0.4rem; border-radius: 99rem; background: #66ffcc; color: #0d2622; font-weight: 800; font-size: 0.9rem; text-align: center; box-shadow: 0 0.2rem 0.5rem rgb(10 32 30 / 35%); }
  .table-hand-card.selected, .table-herd-card.selected { transform: translateY(-14%); box-shadow: 0 0 0 3px #66ffcc, 0 0.5rem 1rem rgb(10 32 30 / 35%); z-index: 1; }
  .table-hand-card.loaded, .table-herd-card.loaded { opacity: 0.45; }
  .market-card :global(.piece-image) { width: 100%; height: 100%; object-fit: cover; }
  .tabletop-herd {
    display: grid;
    min-width: 44px;
    min-height: 44px;
    grid-template-columns: 1fr;
    place-items: center;
    padding: 0.15rem;
    border-radius: 0.55rem;
  }
  .herd-pile { position: relative; width: clamp(6.8rem, 13vw, 22rem); height: clamp(3.7rem, 9.8vh, 12rem); }
  .herd-pile .table-herd-card { position: absolute; padding: 0; background: none; overflow: hidden; pointer-events: none; left: calc(var(--pile-index) * clamp(0.55rem, 1.1vmin, 1.4rem)); width: clamp(3.7rem, 9.8vh, 12rem); height: clamp(3.7rem, 9.8vh, 12rem); border: 2px solid #a6442d; border-radius: 0.55rem; transform: rotate(calc((var(--pile-index) - 2) * 2deg)); }
  .herd-pile .table-herd-card.selected { transform: rotate(calc((var(--pile-index) - 2) * 2deg)) translateY(-14%); }
  .seat-tokens { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem; min-height: clamp(1.6rem, 3.6vmin, 4rem); padding: 0.15rem 0.5rem; border: 1px solid #b7aa8d; border-radius: 99rem; background: #f5ead3; font-size: clamp(0.65rem, 1.3vmin, 0.82rem); }
  .seat-tokens .earned { width: clamp(1.4rem, 3.2vmin, 3.6rem); height: clamp(1.4rem, 3.2vmin, 3.6rem); flex: 0 0 auto; }
  .seat-tokens .earned.bonus { filter: saturate(0.7); }
  .hand-slot { width: clamp(3.7rem, 9.8vh, 12rem); height: clamp(3.7rem, 9.8vh, 12rem); flex: 0 0 auto; border: 2px dashed #b7aa8d; border-radius: 0.55rem; opacity: 0.45; }
  .tabletop-hand > .hand-slot + .hand-slot, .tabletop-hand > .hand-slot + .table-hand-card { margin-left: clamp(-1.1rem, -1.9vw, -0.35rem); }
  .shared-market {
    --table-market-card-size: clamp(4rem, min(18vh, 10.5vw), 20rem);
    --table-target-height: clamp(2.7rem, 6.5vh, 7rem);
    --stable-market-gap: clamp(0.25rem, 0.8vw, 1.5rem);
    --market-edge-inset: clamp(0.9rem, 1.6vmin, 2.5rem);
    position: relative;
    grid-column: 2;
    grid-row: 2;
    min-height: 0;
    padding: clamp(0.4rem, 1vmin, 0.75rem) clamp(0.65rem, 1.5vw, 1.25rem);
    /* Lighter wash than upstream (84%): the pattern is a large part of what AR phones image-track. */
    background-image: linear-gradient(rgb(255 250 238 / 62%), rgb(255 250 238 / 62%)), var(--market-art);
    background-position: center;
    background-size: auto, min(40vh, 28rem);
  }
  .shared-market > header { position: absolute; z-index: 3; top: var(--market-edge-inset); left: 50%; display: flex; min-height: 36px; align-items: center; justify-content: center; gap: clamp(0.6rem, 2vw, 3rem); font-size: clamp(0.7rem, 1.5vmin, 1.5rem); transform: translateX(-50%); }
  .shared-market[data-market-facing-seat='1'] > header { top: auto; bottom: var(--market-edge-inset); transform: translateX(-50%) rotate(180deg); }
  .shared-market > header strong { letter-spacing: 0.14em; }
  .scale-panel {
    position: fixed; z-index: 30; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(34rem, 92vw); padding: 0.9rem 1.1rem; border: 1px solid #8e826b; border-radius: 0.9rem;
    background: #fffaf0; box-shadow: 0 1rem 2.4rem rgb(10 32 30 / 35%); font-size: clamp(0.8rem, 1.6vmin, 1.1rem);
  }
  .scale-panel > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
  .scale-panel button { min-width: 44px; min-height: 44px; padding: 0.3rem 0.7rem; border: 1px solid #8e826b; border-radius: 0.6rem; background: #fff; font: inherit; font-weight: 700; color: #183a37; }
  .scale-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
  .scale-row input { width: 5.5rem; min-height: 44px; padding: 0.3rem; border: 1px solid #8e826b; border-radius: 0.6rem; font: inherit; font-size: 1.2em; text-align: center; }
  .scale-check { display: grid; gap: 0.4rem; margin: 0.8rem 0; }
  .card-outline { display: block; border: 2px dashed #a6442d; border-radius: 3.18mm; background: rgb(166 68 45 / 8%); }
  .scale-facts { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 0.8rem; margin: 0; }
  .scale-facts dt { font-weight: 700; color: #a6442d; }
  .scale-facts dd { margin: 0; }
  .scale-actions { display: flex; gap: 0.5rem; margin-top: 0.8rem; }
  .rejoin-codes { display: flex; flex-wrap: wrap; gap: 0.8rem; align-items: flex-start; margin-top: 0.9rem; padding-top: 0.7rem; border-top: 1px solid #d8ccb0; }
  .rejoin-codes figure { margin: 0; text-align: center; }
  .rejoin-codes img { width: min(9rem, 24vw); aspect-ratio: 1; border: 2px solid #0d2622; border-radius: 0.5rem; }
  .rejoin-codes p { flex-basis: 100%; margin: 0; }
  .bot-seat-button { min-height: 44px; padding: 0.4rem 0.9rem; border: 1px solid #8e826b; border-radius: 99rem; background: #fff; font: inherit; font-weight: 700; color: #183a37; }
  .rejoin { display: inline-flex; align-items: center; gap: 0.4rem; }
  .rejoin img { width: clamp(3rem, 7vh, 6rem); aspect-ratio: 1; border: 2px solid #0d2622; border-radius: 0.4rem; }
  .rejoin small { max-width: 8rem; color: #a6442d; font-weight: 700; line-height: 1.15; }
  .orientation-toggle {
    min-width: 44px;
    min-height: 36px;
    padding: 0.25rem 0.55rem;
    border: 1px solid #8e826b;
    border-radius: 99rem;
    background: #fffaf0;
    color: #315f58;
    font-weight: 700;
  }
  .orientation-toggle[aria-pressed='true'] { border-color: #a6442d; background: #fff4d6; color: #a6442d; }
  .deck { display: grid; grid-template-rows: clamp(1.8rem, 3.5vmin, 3.5rem) var(--table-market-card-size) clamp(1.8rem, 3.5vmin, 3.5rem); place-items: center; gap: clamp(0.25rem, 0.6vmin, 0.75rem); }
  .deck-count { display: flex; min-width: 3rem; align-items: baseline; justify-content: center; gap: 0.3rem; font-size: clamp(0.8rem, 1.4vmin, 1.5rem); }
  .deck-count-top { transform: rotate(180deg); }
  .deck-card {
    width: var(--table-market-card-size);
    height: var(--table-market-card-size);
    border: 2px solid #315f58;
    border-radius: 0.55rem;
    box-shadow: 0 0.25rem 0.5rem rgb(10 32 30 / 22%);
    object-fit: cover;
  }
  .market-stage {
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: clamp(0.45rem, 1.1vw, 1rem);
    padding: clamp(3rem, 7vh, 7rem) 0;
  }
  .market-cards {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    place-items: center;
    gap: var(--stable-market-gap);
  }
  .table-market-slot {
    display: grid;
    min-width: 0;
    grid-template-rows: var(--table-target-height) var(--table-market-card-size) var(--table-target-height);
    place-items: center;
    gap: clamp(0.2rem, 0.7vh, 0.4rem);
  }
  .market-card {
    width: var(--table-market-card-size);
    height: var(--table-market-card-size);
    grid-row: 2;
    transform: rotate(0deg);
    transition: transform 420ms ease-in-out;
  }
  .turn-facing .market-card { transform: rotate(var(--market-rotation)); }
  .market-prompt {
    position: absolute;
    z-index: 12;
    bottom: var(--market-edge-inset);
    left: 50%;
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: 0.45rem;
    padding: 0.3rem 0.45rem 0.3rem 0.65rem;
    border: 2px solid #d38b21;
    border-radius: 99rem;
    background: #fff4d6;
    box-shadow: 0 0.3rem 0.7rem rgb(10 32 30 / 24%);
    max-width: min(44rem, 72%);
    font-size: clamp(0.75rem, 1.35vmin, 1.35rem);
    font-weight: 700;
    text-align: center;
    transform: translateX(-50%);
    transition: opacity 100ms ease;
  }
  .market-prompt.for-top {
    top: var(--market-edge-inset);
    bottom: auto;
    transform: translateX(-50%) rotate(180deg);
  }
  .market-prompt.rotating { opacity: 0; }
  .market-prompt button { min-height: 36px; padding: 0.3rem 0.65rem; border-radius: 99rem; }
  .draw-pending .table-exchange-target { visibility: hidden; }
  @keyframes pending-draw-turn {
    from { opacity: 0.45; transform: rotateY(80deg); }
    to { opacity: 1; transform: rotateY(0); }
  }
  .market-card.camel { border-color: #a6442d; }
  .table-exchange-target { display: grid; width: var(--table-market-card-size); height: var(--table-target-height); min-height: var(--table-target-height); grid-row: 1; grid-template-columns: auto 1fr; place-items: center; gap: 0.2rem; padding: 0.2rem; border: 2px dashed #315f58; border-radius: 0.6rem; background: rgb(255 250 240 / 72%); color: #315f58; font-weight: 700; transform: rotate(var(--market-rotation)); transition: transform 420ms ease-in-out; }
  .shared-market[data-market-facing-seat='2'] .table-exchange-target { grid-row: 3; }
  .target-placeholder { visibility: hidden; }
  .table-exchange-target:disabled { opacity: 0.48; }
  .table-exchange-target.loaded { border-style: solid; border-color: #d38b21; background: #fff4d6; opacity: 1; }
  .table-exchange-target > span { font-size: 1.2rem; }
  .table-exchange-target small { font-size: clamp(0.55rem, 1.1vmin, 0.72rem); }
  .table-exchange-target img { width: clamp(2.25rem, 5.7vh, 3.4rem); height: clamp(2.25rem, 5.7vh, 3.4rem); border: 1px solid #315f58; border-radius: 0.35rem; object-fit: cover; }
  .tabletop-mark { display: grid; place-content: center; place-items: center; gap: 0.25rem; }
  .tabletop-mark img { width: clamp(3rem, 9vh, 5rem); border-radius: 0.55rem; }
  .tabletop-mark strong { font-size: clamp(1.4rem, 4vmin, 2.5rem); letter-spacing: 0.2em; }
  .token-view {
    grid-row: 1 / 4;
    min-height: 0;
  }
  .top-token-view { grid-column: 1; }
  .bottom-token-view { grid-column: 3; }
  .top-log, .bottom-log { position: fixed; z-index: 20; }
  .top-log { top: 0.75rem; left: calc(var(--rail-width) + 1rem); transform: rotate(180deg); }
  .bottom-log { right: calc(var(--rail-width) + 1rem); bottom: 0.75rem; }
  .corner-log { position: relative; }
  .corner-log summary { display: flex; min-width: 7rem; min-height: 44px; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.35rem 0.55rem; border: 1px solid #8e826b; border-radius: 99rem; background: #fffaf0; box-shadow: 0 0.2rem 0.5rem rgb(10 32 30 / 24%); cursor: pointer; font-size: 0.75rem; font-weight: 700; list-style: none; }
  .corner-log summary::-webkit-details-marker { display: none; }
  .corner-log summary span { display: grid; min-width: 1.4rem; min-height: 1.4rem; place-items: center; border-radius: 99rem; background: #315f58; color: white; }
  .corner-log ol { position: absolute; right: 0; bottom: calc(100% + 0.35rem); width: min(25rem, 42vw); margin: 0; padding: 0.55rem; border: 1px solid #8e826b; border-radius: 0.7rem; background: #fffaf0; box-shadow: 0 0.7rem 1.2rem rgb(10 32 30 / 24%); list-style: none; }
  .corner-log.inverted ol { top: calc(100% + 0.35rem); right: auto; bottom: auto; left: 0; }
  .corner-log li { padding: 0.22rem 0.3rem; border-radius: 0.25rem; background: #f2e8d3; font-size: 0.68rem; }
  .corner-log li + li { margin-top: 0.18rem; }
  .table-card-flight, .table-token-flight { position: fixed; z-index: 40; top: var(--start-top); left: var(--start-left); width: var(--start-size); height: var(--start-size); pointer-events: none; animation: table-flight 860ms cubic-bezier(0.2, 0.75, 0.22, 1) var(--flight-delay) both; }
  .table-card-flight { perspective: 900px; }
  .table-card-flight-inner { position: absolute; inset: 0; display: block; transform-style: preserve-3d; }
  .table-card-flight.flips .table-card-flight-inner { animation: table-card-flip 860ms ease-in-out var(--flight-delay) both; }
  .table-card-flight img { position: absolute; width: 100%; height: 100%; inset: 0; backface-visibility: hidden; border: 2px solid #315f58; border-radius: 0.55rem; box-shadow: 0 0.7rem 1rem rgb(0 0 0 / 28%); object-fit: cover; }
  .table-card-flight-front { transform: rotateY(180deg); }
  /* Tokens fly on an arc: `translate` carries them across, `transform`
     lifts them mid-way; the two animate independently. */
  .table-token-flight { animation: token-flight-across 1000ms cubic-bezier(0.3, 0.6, 0.35, 1) var(--flight-delay) both, token-flight-lift 1000ms ease-in-out var(--flight-delay) both; }
  .table-token-flight :global(.token-chip) { width: 100%; height: 100%; filter: drop-shadow(0 0.5rem 0.5rem rgb(0 0 0 / 28%)); }
  @keyframes token-flight-across {
    0% { translate: 0 0; opacity: 1; }
    80% { translate: calc(var(--end-left) - var(--start-left)) calc(var(--end-top) - var(--start-top)); opacity: 1; width: var(--start-size); height: var(--start-size); }
    100% { translate: calc(var(--end-left) - var(--start-left)) calc(var(--end-top) - var(--start-top)); opacity: 0; width: var(--end-size); height: var(--end-size); }
  }
  @keyframes token-flight-lift {
    0% { transform: translateY(0) scale(1); }
    45% { transform: translateY(calc(var(--arc-lift) * -1)) scale(1.25); }
    100% { transform: translateY(0) scale(0.9); }
  }
  .sale-summary { position: fixed; z-index: 45; left: var(--left); top: var(--top); display: grid; justify-items: center; gap: 0.2rem; pointer-events: none; transform: translate(-50%, -50%); animation: sale-summary 2600ms ease-out both; }
  .sale-summary.inverted { animation-name: sale-summary-inverted; }
  .sale-summary strong { color: #c8281e; font-size: clamp(1.6rem, 5vmin, 4rem); font-weight: 900; line-height: 1; text-shadow: 0 2px 0 #fff, 0 0 12px #fff; }
  .sale-coins { display: flex; gap: 0.15rem; }
  .sale-coins i { display: block; width: clamp(0.9rem, 2.2vmin, 1.8rem); height: clamp(0.9rem, 2.2vmin, 1.8rem); border: 2px solid #c8281e; border-radius: 50%; opacity: 0.7; animation: sale-coin 1400ms ease-out both; animation-delay: calc(var(--i) * 60ms); }
  @keyframes sale-coin { 0% { transform: scale(1); opacity: 0.9; } 100% { transform: scale(0.6); opacity: 0; } }
  @keyframes sale-summary {
    0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0; }
    15% { transform: translate(-50%, -60%) scale(1.1); opacity: 1; }
    70% { transform: translate(-50%, -90%) scale(1); opacity: 1; }
    100% { transform: translate(-50%, -120%) scale(0.95); opacity: 0; }
  }
  @keyframes sale-summary-inverted {
    0% { transform: translate(-50%, -50%) rotate(180deg) scale(0.6); opacity: 0; }
    15% { transform: translate(-50%, -40%) rotate(180deg) scale(1.1); opacity: 1; }
    70% { transform: translate(-50%, -10%) rotate(180deg) scale(1); opacity: 1; }
    100% { transform: translate(-50%, 20%) rotate(180deg) scale(0.95); opacity: 0; }
  }
  .market-card.confirm-ready { border: 3px solid #1d7a4a; box-shadow: 0 0 0 4px rgb(29 122 74 / 30%), 0 0.4rem 1rem rgb(10 32 30 / 30%); animation: confirm-pulse 1.1s ease-in-out infinite; }
  .confirm-mark { position: absolute; right: 0.15rem; top: 0.15rem; z-index: 3; display: grid; width: 1.8em; height: 1.8em; place-items: center; border-radius: 50%; background: #1d7a4a; color: #eafff0; font-size: clamp(0.9rem, 2.4vmin, 2rem); font-weight: 900; box-shadow: 0 0.15rem 0.4rem rgb(0 0 0 / 35%); }
  @keyframes confirm-pulse { 0%, 100% { box-shadow: 0 0 0 4px rgb(29 122 74 / 30%); } 50% { box-shadow: 0 0 0 9px rgb(29 122 74 / 12%); } }
  .market-prompt button.cancel { border-color: #a6442d; color: #a6442d; background: #fff4f0; }
  .scale-gear { position: relative; display: inline-grid; place-items: center; font-size: 2.2em; line-height: 1; }
  .scale-gear svg { display: block; }
  .scale-gear b { position: absolute; font-size: 0.34em; font-weight: 800; color: #183a37; text-shadow: 0 0 3px #fff, 0 0 3px #fff; }
  .scale-note { margin-left: 0.2rem; font-size: 0.6em; opacity: 0.7; }
  .herd-count { position: absolute; left: 50%; bottom: -0.6rem; transform: translateX(-50%); z-index: 3; min-width: 1.9rem; padding: 0.15rem 0.45rem; border: 2px solid #fffaf0; border-radius: 99rem; background: #a6442d; color: #fffaf0; font-size: clamp(0.85rem, 2vmin, 1.6rem); font-weight: 900; line-height: 1.2; text-align: center; box-shadow: 0 0.2rem 0.5rem rgb(10 32 30 / 35%); }
  @keyframes table-flight {
    0% { opacity: 0.96; transform: translate(0, 0) rotate(-3deg); }
    68% { width: var(--end-size); height: var(--end-size); opacity: 1; transform: translate(calc(var(--end-left) - var(--start-left)), calc(var(--end-top) - var(--start-top))) rotate(-2deg) scale(1.05); }
    84% { width: var(--end-size); height: var(--end-size); opacity: 1; transform: translate(calc(var(--end-left) - var(--start-left)), calc(var(--end-top) - var(--start-top))) rotate(1deg) scale(0.97); }
    100% { width: var(--end-size); height: var(--end-size); opacity: 1; transform: translate(calc(var(--end-left) - var(--start-left)), calc(var(--end-top) - var(--start-top))) rotate(0) scale(1); }
  }
  @keyframes table-card-flip {
    0%, 52% { transform: rotateY(0deg); }
    78%, 100% { transform: rotateY(180deg); }
  }
  .table-status { position: fixed; z-index: 15; right: calc(var(--rail-width) + 1rem); bottom: 0.4rem; margin: 0; color: #315f58; font-size: 0.65rem; font-weight: 700; }
  .table-status.for-top { top: 0.4rem; right: auto; bottom: auto; left: calc(var(--rail-width) + 1rem); transform: rotate(180deg); }
  .table-status[data-status='error'] { color: #a3212a; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
  }
  @media (max-aspect-ratio: 1/1) {
    .tabletop { --rail-width: clamp(9.5rem, 18vw, 10rem); }
    .join-seat, .player-seat { padding-right: 3.4rem; padding-left: 3.4rem; }
    .seat-body { grid-template-columns: minmax(0, 1fr) 5rem; }
    .seat-tokens { display: none; }
    .shared-market { padding-right: 1rem; padding-left: 1rem; }
  }
</style>
