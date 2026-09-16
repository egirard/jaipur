<script lang="ts">
  import '@fontsource/atkinson-hyperlegible/400.css';
  import '@fontsource/atkinson-hyperlegible/700.css';
  import '@fontsource/cormorant-garamond/700.css';
  import { base } from '$app/paths';
  import { onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import QRCode from 'qrcode';
  import PieceArt from '$lib/PieceArt.svelte';
  import { describeTieBreak } from '$lib/score-summary';
  import StableMarketLayout from '$lib/StableMarketLayout.svelte';
  import TabletopTokenMarket from '$lib/TabletopTokenMarket.svelte';
  import TokenChip from '$lib/TokenChip.svelte';
  import {
    createLocalGameRepository,
    localGameRoomExists,
    localHostUid
  } from '$lib/local-game-repository';
  import type { GameRepository } from '$lib/game-repository';
  import type { BotDifficulty, GameActivity, GameEvent, GameEventType, Player } from '$lib/game-events';
  import {
    isLegalExchange,
    isLegalSale,
    reduceGame,
    applySale,
    resolveRound,
    setupRound,
    type Card,
    type CardKind,
    type GameState,
    type Good,
    type PendingDraw,
    type Token,
    isGood
  } from '$lib/jaipur-rules';
  import { generateRoomCode, isRoomCode } from '$lib/room-code';
  import { ArTabletop, currentDiagInches, physicalInfo, DIAG_MIN, DIAG_MAX, type PhysicalInfo, type SalePreview } from '$lib/ar/arTabletop';
  import { botActionEvent, botEngineVersion, chooseBotAction, createBotObservation, type BotObservation, type JaipurAction } from '$lib/jaipur-bot';
  import StrongBotWorker from '$lib/jaipur-bot.worker?worker';
  import type { StrongBotRequest, StrongBotResponse } from '$lib/jaipur-bot.worker';

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
    /** Arc flight: flips where it lies first (if it has a reveal image), then arcs and resizes. */
    arc?: boolean;
    /** Seat 1 acts from the far (inverted) side: arcs lift toward that side. */
    inverted?: boolean;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
    delay: number;
    speed?: number;
  }>>([]);
  let flightSequence = 0;
  let botThinking = $state(false);
  // Hold a face-down hand card to peek at it on the table (the player's
  // other hand shields the view). Purely local: the AR phones are not told.
  // Several cards may be held at once (one finger each): every card keeps
  // its own fingers and timer, and its peek ends only when its last finger
  // lifts, so a shielding hand (or a second finger) never cuts it short.
  let revealedCardIds = $state<string[]>([]);
  const presses = new Map<string, { pointers: Set<number>; timer?: ReturnType<typeof setTimeout>; fired: boolean }>();
  const pressFor = (cardId: string) => {
    let press = presses.get(cardId);
    if (!press) { press = { pointers: new Set(), fired: false }; presses.set(cardId, press); }
    return press;
  };
  function startLongPress(event: PointerEvent, cardId: string) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const press = pressFor(cardId);
    press.pointers.add(event.pointerId);
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    if (press.pointers.size > 1) return; // this card is already held
    clearTimeout(press.timer);
    press.fired = false;
    press.timer = setTimeout(() => {
      press.fired = true;
      if (!revealedCardIds.includes(cardId)) revealedCardIds = [...revealedCardIds, cardId];
    }, 380);
  }
  function endLongPress(event: PointerEvent, cardId: string) {
    const press = presses.get(cardId);
    if (!press) return;
    press.pointers.delete(event.pointerId);
    if (press.pointers.size > 0) return; // another finger still holds this card
    clearTimeout(press.timer);
    press.timer = undefined;
    revealedCardIds = revealedCardIds.filter((id) => id !== cardId);
  }
  // Holding an earned bonus token on the mat shows its value the same way
  // (its holder shields it); nothing is sent to the phones.
  let revealedTokenIds = $state<string[]>([]);
  function startTokenPress(event: PointerEvent, tokenId: string) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const press = pressFor(`token:${tokenId}`);
    press.pointers.add(event.pointerId);
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    if (press.pointers.size > 1) return;
    clearTimeout(press.timer);
    press.timer = setTimeout(() => {
      if (!revealedTokenIds.includes(tokenId)) revealedTokenIds = [...revealedTokenIds, tokenId];
    }, 380);
  }
  function endTokenPress(event: PointerEvent, tokenId: string) {
    const press = presses.get(`token:${tokenId}`);
    if (!press) return;
    press.pointers.delete(event.pointerId);
    if (press.pointers.size > 0) return;
    clearTimeout(press.timer);
    press.timer = undefined;
    revealedTokenIds = revealedTokenIds.filter((id) => id !== tokenId);
  }
  // A click that follows a peek must not toggle the card's selection.
  function consumeLongPress(cardId: string) {
    const press = presses.get(cardId);
    const fired = press?.fired ?? false;
    if (press) press.fired = false;
    return fired;
  }
  // AR phones must never see a card before the table shows it: while move
  // animations run, scene publishes are held and sent once every flight has
  // landed (stale beats early).
  let arPublishHeld = false;
  function publishAr() {
    if (actionAnimating) { arPublishHeld = true; return; }
    arPublishHeld = false;
    void tick().then(() => ar?.publishFromState(lobby));
  }
  let arrivingCardIds = $state<string[]>([]);
  // Safety net: a card hidden as "arriving" whose flight never finished
  // (or never started) would stay invisible in the hand while still
  // counting toward the 7-card limit. Reveal anything no flight owns.
  let arrivingWatchdog: ReturnType<typeof setTimeout> | undefined;
  function scheduleArrivingWatchdog() {
    clearTimeout(arrivingWatchdog);
    arrivingWatchdog = setTimeout(() => {
      const owned = new Set(cardFlights.filter((f) => f.concealsDestination).map((f) => f.cardId));
      const stuck = arrivingCardIds.filter((id) => !owned.has(id));
      if (stuck.length > 0) {
        console.warn('Revealing cards stuck in flight state', stuck);
        arrivingCardIds = arrivingCardIds.filter((id) => owned.has(id));
      }
      if (arrivingCardIds.length > 0) scheduleArrivingWatchdog();
    }, 6000);
  }
  /** Seal of Excellence in flight from the round summary to its seat: the seat's new seal stays hidden until it lands. */
  let sealFlights = $state<Array<{
    key: number;
    inverted: boolean;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
  }>>([]);
  let arrivingSealUid = $state<string | null>(null);

  // ---- Round-end scoring sequence ----------------------------------------
  // When a round completes in front of the players, the summary is preceded
  // by a staged animation, both sides at once: a "Game over" disc grows in
  // the market (why the round ended, facing each player); every goods token
  // flies up to its owner's running score; the bonus tokens follow, flipping
  // to show their values; the herds glow with their counts and the larger
  // one grows a +5 that flies up too; tie-break text if needed, then the
  // winner's mat glows under a "Round winner" banner; a huge Seal of
  // Excellence grows in the middle, pauses, and shrinks into the winner's
  // seat. A second seal makes both grow under "N wins the game!" and the
  // screen stays put ('final') with Rematch / New game / Quit facing each
  // player; otherwise the next round opens.
  type ScoringStage = 'pending' | 'gameover' | 'goods' | 'bonus' | 'camels' | 'result' | 'seal' | 'final';
  type Scoring = {
    key: string;
    stage: ScoringStage;
    reason: string;
    label: string;
    totals: Record<string, number>;
    revealedBonus: string[];
    camelBonusUid: string | null;
    camelToken: boolean;
    tieText: string | null;
    winnerUid: string | null;
    winnerBanner: boolean;
    bigSeal: boolean;
    sealsWon: boolean;
    /** Tokens that have landed in each player's three zones (goods, bonus, most camels). */
    landed: Record<string, { goods: Token[]; bonus: Token[]; camel: Token[] }>;
    /** "N wins the game!" has cross-faded into the end-of-game actions. */
    bannerGone: boolean;
  };
  type ScoreZone = 'goods' | 'bonus' | 'camel';
  const ZONE_LABEL: Record<ScoreZone, string> = { goods: 'Goods sold', bonus: 'Bonus tokens', camel: 'Most camels' };
  const zoneTotal = (uid: string, zone: ScoreZone) => (scoring?.landed[uid]?.[zone] ?? []).reduce((sum, t) => sum + t.value, 0);
  let scoring = $state<Scoring | null>(null);
  // The round whose seal has already reached the winner's seat (so the seat
  // may show it while the round is still "complete").
  let deliveredSealKey = $state('');
  const scoringKey = () => `${lobby.epoch}:${lobby.round?.number}`;
  const scoringLive = (key: string) => scoring?.key === key && lobby.round?.status === 'complete' && scoringKey() === key;
  // The match is decided and its closing sequence has finished (or was never
  // seen: a reload lands here too) — the seats show the winner and the
  // end-of-game actions.
  const gameWon = $derived(Boolean(lobby.winnerUid) && lobby.round?.status === 'complete' && (!scoring || scoring.stage === 'final' || scoring.sealsWon));

  function scoreFlight(source: DOMRect, destination: DOMRect, token: Token, delay: number, inverted: boolean, reveal = false) {
    const startSize = Math.min(source.width, source.height, 84);
    const endSize = Math.min(destination.width, destination.height, startSize);
    const key = ++flightSequence;
    tokenFlights = [...tokenFlights, {
      key, token, inverted, reveal, delay, speed: SCORE_SPEED,
      startLeft: source.left + (source.width - startSize) / 2,
      startTop: source.top + (source.height - startSize) / 2,
      startSize,
      endLeft: destination.left + (destination.width - endSize) / 2,
      endTop: destination.top + (destination.height - endSize) / 2,
      endSize
    }];
    setTimeout(() => (tokenFlights = tokenFlights.filter((f) => f.key !== key)), 1000 * SCORE_SPEED + delay);
  }

  // Claimed synchronously when the round completes (the summary and the
  // next round wait for the sequence); the stages start once the closing
  // move's flights have landed.
  function claimRoundScoring(key: string) {
    if (scoring && scoring.stage !== 'final') return;
    scoring = { key, stage: 'pending', reason: '', label: '', totals: {}, revealedBonus: [], camelBonusUid: null, camelToken: false, tieText: null, winnerUid: null, winnerBanner: false, bigSeal: false, sealsWon: false, landed: {}, bannerGone: false };
  }

  async function runRoundScoring(key: string) {
    const round = lobby.round;
    if (!round || round.status !== 'complete' || !round.scores || scoringKey() !== key || (scoring && scoring.key !== key)) { if (scoring?.key === key) scoring = null; return; }
    const players = lobby.players;
    const state: Scoring = {
      key,
      stage: 'gameover',
      reason: round.endReason === 'three-empty-supplies' ? 'Three goods supplies are empty' : 'The deck could not refill the market',
      // The second seal decides the game; any other round end is just that.
      label: lobby.winnerUid ? 'Game over' : 'Round over',
      totals: Object.fromEntries(players.map((p) => [p.uid, 0])),
      revealedBonus: [],
      camelBonusUid: round.camelBonusUid,
      camelToken: false,
      tieText: null,
      winnerUid: round.winnerUid,
      winnerBanner: false,
      bigSeal: false,
      sealsWon: false,
      landed: Object.fromEntries(players.map((p) => [p.uid, { goods: [], bonus: [], camel: [] }])),
      bannerGone: false
    };
    scoring = state;
    const live = () => scoringLive(key);
    // Every beat below is in base milliseconds; SCORE_SPEED stretches them.
    const S = SCORE_SPEED;
    const step = async (ms: number) => { await wait(ms * S); return live(); };
    // Tokens fly into the player's zone for their category and stay there
    // (with a subtotal); the total below the zones grows as they land.
    const zoneBox = (uid: string, zone: ScoreZone) => box(`[data-score-zone="${CSS.escape(uid)}:${zone}"] .zone-chips`);
    const land = (uid: string, zone: ScoreZone, token: Token, at: number) =>
      setTimeout(() => {
        if (!live() || !scoring) return;
        const zones = scoring.landed[uid] ?? (scoring.landed[uid] = { goods: [], bonus: [], camel: [] });
        zones[zone] = [...zones[zone], token];
        scoring.totals[uid] = (scoring.totals[uid] ?? 0) + token.value;
      }, at * S);
    try {
      if (!(await step(4300))) return;
      // Goods tokens, in sequence, both sides together.
      scoring.stage = 'goods'; scoring.label = 'Goods tokens';
      await tick();
      let longest = 0;
      for (const p of players) {
        const dest = zoneBox(p.uid, 'goods');
        const tokens = round.ownedGoodsTokens[p.uid] ?? [];
        tokens.forEach((token, i) => {
          const src = box(`[data-owned-token-id="${CSS.escape(token.id)}"]`);
          if (src && dest) scoreFlight(src, dest, token, i * 260 * S, invertedFor(p.uid));
          land(p.uid, 'goods', token, i * 260 + 850);
        });
        longest = Math.max(longest, tokens.length * 260 + 1000);
      }
      if (!(await step(longest + 600))) return;
      // Bonus tokens: flip to their values on the way up.
      scoring.stage = 'bonus'; scoring.label = 'Bonus tokens';
      await tick();
      longest = 0;
      for (const p of players) {
        const dest = zoneBox(p.uid, 'bonus');
        const tokens = round.ownedBonusTokens[p.uid] ?? [];
        tokens.forEach((token, i) => {
          const src = box(`[data-owned-token-id="${CSS.escape(token.id)}"]`);
          if (src && dest) scoreFlight(src, dest, token, i * 420 * S, invertedFor(p.uid), true);
          setTimeout(() => { if (live() && scoring) scoring.revealedBonus = [...scoring.revealedBonus, token.id]; }, (i * 420 + 500) * S);
          land(p.uid, 'bonus', token, i * 420 + 850);
        });
        longest = Math.max(longest, tokens.length * 420 + 1000);
      }
      if (!(await step(longest + 600))) return;
      // Camel herds glow with their counts; the larger one earns +5.
      scoring.stage = 'camels'; scoring.label = 'Camel herds';
      await tick();
      if (!(await step(1600))) return;
      const camelUid = round.camelBonusUid;
      if (camelUid) {
        scoring.camelToken = true; // grows from the pile
        await tick();
        if (!(await step(1600))) return;
        const src = box('[data-camel-bonus-token]');
        const dest = zoneBox(camelUid, 'camel');
        const camelToken: Token = { id: `camel-bonus-${camelUid}`, kind: 'camel', value: 5 };
        if (src && dest) scoreFlight(src, dest, camelToken, 0, invertedFor(camelUid));
        scoring.camelToken = false;
        land(camelUid, 'camel', camelToken, 850);
        if (!(await step(1400))) return;
      }
      // Result: tie-break, then the winner's mat glows.
      scoring.stage = 'result'; scoring.label = 'Final score';
      scoring.tieText = describeTieBreak(round, players)?.text ?? null;
      if (!(await step(scoring.tieText ? 3600 : 1200))) return;
      scoring.winnerBanner = true;
      if (!(await step(2600))) return;
      // The Seal of Excellence.
      scoring.stage = 'seal'; scoring.label = 'Seal of Excellence';
      scoring.winnerBanner = false;
      scoring.bigSeal = true;
      await tick();
      if (!(await step(2400))) return;
      flySeal(round.winnerUid);
      scoring.bigSeal = false;
      if (!(await step(1350))) return;
      deliveredSealKey = key;
      if (lobby.winnerUid) {
        scoring.sealsWon = true;
        if (!(await step(4200))) return;
        // Stay on this screen: "N wins the game!" cross-fades into the
        // actions, which face each player until one is chosen.
        scoring.stage = 'final'; scoring.label = '';
        if (!(await step(END_FADE_MS / S))) return;
        scoring.bannerGone = true;
      } else {
        if (!(await step(1000))) return;
        scoring = null;
        if (!demo) await nextRound(false); // the demo holds the final state instead
      }
    } finally {
      if (scoring?.key === key && scoring.stage !== 'final') scoring = null;
    }
  }
  let tokenFlights = $state<Array<{
    inverted?: boolean;
    reveal?: boolean; // face-down bonus token flips to its value in flight
    key: number;
    token: Token;
    startLeft: number;
    startTop: number;
    startSize: number;
    endLeft: number;
    endTop: number;
    endSize: number;
    speed?: number;
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
  // Pacing multipliers (1 = the base timings). Flights carry theirs as a
  // `--speed` CSS variable so the keyframes stretch with the JS delays.
  const SALE_SPEED = 1.5; // selling at two-thirds speed (2 read as too slow)
  const SCORE_SPEED = 1.5; // the round-end / game-end sequence, 50% slower
  const END_FADE_MS = 2800; // "N wins the game!" cross-fading into the end-of-game actions

  const componentImage = (kind: Good | 'camel' | 'seal' | 'card-back') =>
    `${base}/components/${kind}.webp`;

  onMount(async () => {
    try {
      marketFacingEnabled = localStorage.getItem('jaipur:tabletop:turn-facing-market') === 'on';
      const savedHands = localStorage.getItem('jaipur:tabletop:show-hands');
      if (savedHands === 'on' || savedHands === 'off') showHandsChoice = savedHands;
      const pageParams = new URLSearchParams(location.search);
      // The Firebase channel is disabled for this AR fork: the table is
      // the only writer (phones join and watch over the AR relay), so the
      // game lives in this browser's localStorage and survives reloads.
      // The Firebase repository stays in the code base; ?firebase=1 opts a
      // build with Firebase config back into it.
      localStore = !(pageParams.get('firebase') === '1' && import.meta.env.VITE_FIREBASE_API_KEY);
      // Firebase is optional: its SDK is only loaded (dynamically) when the
      // page opts in, so a table with no Firestore around never touches it.
      const remote = localStore
        ? null
        : await (async () => {
            const [{ initializeFirebase }, { createGameRepository, gameRoomExists }] = await Promise.all([
              import('$lib/firebase'),
              import('$lib/game-repository')
            ]);
            const services = await initializeFirebase();
            return { services, createGameRepository, gameRoomExists };
          })();
      hostUid = localStore ? localHostUid() : (remote!.services.auth.currentUser?.uid ?? '');
      const roomExists = async (id: string) =>
        localStore ? localGameRoomExists(id) : remote!.gameRoomExists(remote!.services.db, id);
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
        : remote!.createGameRepository(remote!.services.db, gameId, hostUid);
      repository = attached;
      attached.subscribe(
        (events) => {
          if (demo) { demoDeferred = events; return; } // replayed when the demo ends
          const previous = lobby;
          const next = reduceGame(events);
          const newActivities = repositoryReady
            ? next.activity.filter(({ id }) => !knownActivityIds.has(id))
            : [];
          const previousActiveSeat = activeSeat(previous);
          const nextActiveSeat = activeSeat(next);
          const roundJustEnded = repositoryReady && previous.round?.status === 'active' && next.round?.status === 'complete';
          lobby = next;
          // A rematch / new round clears the held end-of-game screen.
          if (scoring?.stage === 'final' && (next.round?.status !== 'complete' || scoringKey() !== scoring.key)) scoring = null;
          for (const activity of next.activity) knownActivityIds.add(activity.id);
          repositoryReady = true;
          const actionAnimation = newActivities.length > 0
            ? animateActivities(newActivities, previous, next)
            : Promise.resolve();
          if (roundJustEnded) {
            const key = `${next.epoch}:${next.round?.number}`;
            claimRoundScoring(key);
            void actionAnimation.then(() => runRoundScoring(key));
          }
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
          publishAr();
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
      ar.botOffers = botLevels.map(({ difficulty, name, blurb }) => ({ id: difficulty, name, blurb }));
      ar.onJoin = (seat, name) => void joinFromAr(seat, name);
      ar.onBotRequest = (seat, difficulty) => {
        // The phone asks for a computer opponent: it sits across from the
        // phone's own seat.
        const other: Seat = seat === '1' ? 2 : 1;
        const level = botLevels.find((l) => l.difficulty === difficulty);
        if (level) void addBot(other, level.difficulty);
      };
      // The phone view doubles as the seat's hand controller (upstream
      // /hand): its taps and Clear go through the same intent path as taps
      // on the table, for whoever holds that seat (never a bot).
      ar.onToggleReturn = (seat, cardId) => {
        const player = playerForSeat(Number(seat) as Seat);
        if (player && player.uid !== lobby.bot?.uid) void toggleFromPhone(player.uid, cardId);
      };
      ar.onClear = (seat) => {
        const player = playerForSeat(Number(seat) as Seat);
        if (player && player.uid !== lobby.bot?.uid && canSelectReturns(player.uid)) void publishIntent(player.uid, [], exchangeLoads(player.uid));
      };
      ar.previewFor = (kind) => (isGood(kind) ? salePreview(kind) : null); // AR-only sale preview
      ar.onViewersChanged = (n) => (arViewers = n);
      ar.attach();
      arDiag = currentDiagInches();
      refreshPhysical();
      if (pageParams.get('scale') === '1') scalePanelOpen = true; // deep link to the panel
      ar.onGeometryChanged = () => {
        refreshPhysical();
        publishAr();
      };
      // Publish what the store already holds: with the local store the
      // last notification fired before the AR bridge existed.
      publishAr();
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
      publishAr(); // busy cleared
    }
  }

  // "Show hands": a human's hand cards lie face up on the table (a computer
  // opponent's never are). Unless the players
  // chose otherwise, it is on against a computer opponent (nobody to hide
  // from) and off with two humans (their phones show their cards).
  let showHandsChoice = $state<'auto' | 'on' | 'off'>('auto');
  const showHands = $derived(showHandsChoice === 'auto' ? Boolean(lobby.bot) : showHandsChoice === 'on');
  function toggleShowHands() {
    showHandsChoice = showHands ? 'off' : 'on';
    localStorage.setItem('jaipur:tabletop:show-hands', showHandsChoice);
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

  // A second line of detail where the move has one (what a trade gave and
  // took, how many tokens a sale earned).
  function activityDetail(activity: GameActivity): string | null {
    const kinds = (list?: string[]) => list?.map((kind) => label(kind as Good | 'camel')).join(', ');
    switch (activity.type) {
      case 'cards/exchanged': return `gave ${kinds(activity.returnedCardKinds) ?? '?'} · took ${kinds(activity.cardKinds) ?? '?'}`;
      case 'cards/sold': return activity.tokenCount ? `${activity.tokenCount} token${activity.tokenCount === 1 ? '' : 's'} earned` : null;
      case 'cards/taken-camels': return null;
      case 'round/started': return activity.starterUid ? `${playerName(activity.starterUid)} starts` : null;
      default: return null;
    }
  }
  // The game log: the latest move (the other player's, on your turn) is
  // always visible in each corner; + opens the full, scrollable list, oldest
  // first, opened (and kept) at its newest entries.
  function scrollToEnd(node: HTMLElement) {
    const toEnd = () => { node.scrollTop = node.scrollHeight; };
    toEnd();
    const observer = new MutationObserver(() => {
      // Follow new entries unless the reader has scrolled back up.
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 80) toEnd();
    });
    observer.observe(node, { childList: true, subtree: true });
    return { destroy: () => observer.disconnect() };
  }
  let logOpen = $state<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });
  const isMove = (a: GameActivity) => a.type.startsWith('cards/') || a.type.startsWith('round/') || a.type === 'game/rematched';

  // ---- Table guide (the "?" on the prompt) ---------------------------------
  // Callouts grow and glow into place over the real pieces, facing the player
  // who asked: a translucent body so the piece beneath still shows, opaque
  // text. Pieces the market happens to lack (a camel, a good) are drawn over
  // the market for the duration. A tap anywhere fades the whole guide.
  type TutorialItem = {
    key: string;
    kind: 'circle' | 'tap' | 'pill' | 'card';
    x: number; y: number; // centre, viewport px
    w: number; h: number;
    text?: string;
    card?: CardKind;
    /** Where the text sits relative to the tap ring, in the player's frame. */
    side?: 'below' | 'above' | 'left' | 'right' | 'over';
    /** First line is a heading (the overview pill). */
    title?: boolean;
    delay: number;
  };
  let tutorial = $state<{ seat: Seat; items: TutorialItem[]; fading: boolean } | null>(null);
  // Stand-in cards by market slot: a camel stand-in hides the slot's return
  // area; a good stand-in over a camel shows one.
  const tutorialFakes = $derived<Record<number, CardKind>>(Object.fromEntries(
    (tutorial?.items ?? []).filter((i) => i.kind === 'card').map((i) => [Number(i.key.replace('card-', '')), i.card ?? 'camel'])
  ));
  const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });

  async function openTutorial(seat: Seat) {
    if (tutorial || !lobby.round) return;
    const round = lobby.round;
    const flip = seat === 1 ? -1 : 1; // +1: the player's "down" is the screen's down
    const items: TutorialItem[] = [];
    let delay = 0;
    const next = () => { const d = delay; delay += 700; return d; };
    // Market slots, with stand-in cards where the real market lacks a kind.
    const slots = [...document.querySelectorAll<HTMLElement>('[data-market-slot-index]')].map((slot, i) => ({
      i,
      kind: (round.market[i]?.kind ?? 'gold') as CardKind,
      card: slot.querySelector('.market-card')?.getBoundingClientRect() ?? slot.getBoundingClientRect(),
      target: slot.querySelector('.table-exchange-target')?.getBoundingClientRect() ?? null
    }));
    // Fixed teaching slots: the first card is a camel, the third a trade
    // good (take), the fourth a trade good (trade); stand-ins are drawn over
    // whatever the market really holds there.
    const need: Array<{ i: number; kind: CardKind; goods: boolean }> = [
      { i: 0, kind: 'camel', goods: false },
      { i: 2, kind: 'cloth', goods: true },
      { i: 3, kind: 'spice', goods: true }
    ];
    for (const n of need) {
      const slot = slots[n.i];
      if (!slot) continue;
      const ok = n.goods ? slot.kind !== 'camel' : slot.kind === 'camel';
      if (!ok) { slot.kind = n.kind; items.push({ key: `card-${n.i}`, kind: 'card', ...centre(slot.card), card: n.kind, delay: 0 }); }
    }
    const deckArea = document.querySelector('.deck')?.getBoundingClientRect();
    const deck = document.querySelector('.deck-card')?.getBoundingClientRect();
    if (deck) {
      const c = { ...centre(deckArea ?? deck), w: deck.width, h: deck.height }; // centred on the whole deck area, sized to the card
      const d = Math.max(c.w, c.h) * 1.15;
      items.push({ key: 'deck', kind: 'circle', x: c.x, y: c.y, w: d, h: d, delay: next(),
        text: `${round.deck.length} card${round.deck.length === 1 ? '' : 's'} remain in the deck;round ends when the deck or three trade goods are exhausted` });
    }
    // A ring in the upper-left quadrant of a card (in the player's frame),
    // its text wrapping within the card's width below and to the right.
    const quadrant = (r: DOMRect) => {
      const c = centre(r);
      return { x: c.x - flip * c.w / 4, y: c.y - flip * c.h / 4, w: c.w * 0.62, h: c.h };
    };
    if (slots[0]) items.push({ key: 'camels', kind: 'tap', ...quadrant(slots[0].card), side: 'below', delay: next(), text: 'Pick up all camels into your herd' });
    if (slots[2]) items.push({ key: 'take', kind: 'tap', ...quadrant(slots[2].card), side: 'below', delay: next(), text: 'Take this card from the market (if you have space in your hand)' });
    if (slots[3]) {
      const c = centre(slots[3].target ?? slots[3].card);
      items.push({ key: 'trade', kind: 'tap', x: c.x, y: c.y, w: slots[3].card.width * 1.1, h: c.h, side: 'below', delay: next(), text: 'Trade two or more cards (camels or trade goods) from your hand with trade cards from the market' });
    }
    const stack = document.querySelector(`[data-token-view-seat="${seat}"] [data-token-kind="${seat === 1 ? 'diamond' : 'gold'}"]`)?.getBoundingClientRect()
      ?? document.querySelector(`[data-token-view-seat="${seat}"] [data-token-kind]`)?.getBoundingClientRect();
    if (stack) items.push({ key: 'sell', kind: 'tap', ...centre(stack), side: 'left', delay: next(), text: 'Sell one category of trade good;Bonus token if 3+ cards sold;Diamond/Gold/Silver need 2+' });
    // The hand container runs the full mat width; centre on the cards and
    // slots it actually shows.
    const handCells = [...document.querySelectorAll<HTMLElement>(`[data-seat="${seat}"] [data-table-hand] .hand-cell`)].map((el) => el.getBoundingClientRect());
    const hand = handCells.length
      ? new DOMRect(Math.min(...handCells.map((r) => r.left)), Math.min(...handCells.map((r) => r.top)), Math.max(...handCells.map((r) => r.right)) - Math.min(...handCells.map((r) => r.left)), Math.max(...handCells.map((r) => r.bottom)) - Math.min(...handCells.map((r) => r.top)))
      : document.querySelector(`[data-seat="${seat}"] [data-table-hand]`)?.getBoundingClientRect();
    if (hand) {
      const c = centre(hand);
      items.push({ key: 'hand', kind: 'pill', x: c.x, y: c.y, w: 0, h: 0, side: 'over', delay: next(), text: 'You can hold up to 7 trade goods in your hand' });
    }
    const herd = document.querySelector(`[data-seat="${seat}"] [data-table-herd]`)?.getBoundingClientRect();
    if (herd) {
      const c = centre(herd);
      items.push({ key: 'herd', kind: 'pill', x: c.x + flip * (c.w / 2 - 28), y: c.y, w: 0, h: 0, side: 'right', delay: next(),
        text: 'You can have any number of camels;Player with the most camels wins +5' });
    }
    if (deckArea) {
      const c = centre(deckArea);
      items.push({ key: 'overview', kind: 'pill', x: c.x + (seat === 1 ? innerWidth * 0.22 : 0), y: c.y - flip * (c.h / 2 + 6), w: 0, h: 0, side: 'above', delay: next(), title: true,
        text: 'Game overview;Players alternate turns, taking one of four actions [hand] each turn;Round ends when deck or three trade goods are exhausted;Win by having more points (goods traded, bonus tokens, camel bonus);Game ends when a player wins two rounds' });
    }
    // Presentation order (stand-in cards appear at once, with the first callout).
    const order = ['overview', 'take', 'camels', 'trade', 'sell', 'hand', 'herd', 'deck'];
    for (const item of items) {
      const at = order.indexOf(item.key);
      item.delay = at < 0 ? 0 : at * 875;
    }
    tutorial = { seat, items, fading: false };
  }
  function dismissTutorial() {
    if (!tutorial || tutorial.fading) return;
    tutorial.fading = true;
    setTimeout(() => (tutorial = null), 700);
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
    if (cardFlights.length > 0 || tokenFlights.length > 0 || busy) {
      setTimeout(() => void playBotTurn(expectedKey), 120);
      return;
    }
    // The bot visibly "thinks" for a random 500–1500 ms (hourglass in its
    // seat) so the players' eyes are on it when the move plays out. The
    // Maharaja search runs during that pause rather than after it.
    const observation = createBotObservation(lobby);
    if (!observation) return;
    botThinking = true;
    try {
      const [action] = await Promise.all([
        lobby.bot?.difficulty === 'maharaja'
          ? chooseStrongBotAction(expectedKey, observation)
          : Promise.resolve(chooseBotAction(observation)),
        wait(500 + Math.random() * 1000)
      ]);
      if (`${lobby.epoch}:${lobby.round?.number}:${lobby.round?.turnNumber}` !== expectedKey) return;
      if (!action) return;
      const event = botActionEvent(observation, action);
      try {
        await repository.append(event.type, event.payload);
      } catch {
        scheduledBotKey = '';
      }
    } finally {
      botThinking = false;
    }
  }

  // The Maharaja bot searches in a Web Worker; on error or after 5 s it
  // falls back to the apprentice's instant heuristic move.
  function chooseStrongBotAction(key: string, observation: BotObservation): Promise<JaipurAction | null> {
    const worker = new StrongBotWorker();
    return new Promise((resolve) => {
      const finish = (action: JaipurAction | null) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(action ?? chooseBotAction(observation));
      };
      const timeout = setTimeout(() => finish(null), 5000);
      worker.onmessage = (event: MessageEvent<StrongBotResponse>) => {
        if (event.data.key === key) finish(event.data.action);
      };
      worker.onerror = () => finish(null);
      worker.postMessage({ key, observation } satisfies StrongBotRequest);
    });
  }

  // Every shipped bot level, in strength order, as offered on the table and
  // on the phones.
  const botLevels: { difficulty: BotDifficulty; name: string; blurb: string }[] = [
    { difficulty: 'apprentice', name: 'Apprentice', blurb: 'quick learner' },
    { difficulty: 'maharaja', name: 'Maharaja', blurb: 'strongest' }
  ];

  // Seat a bot of the chosen level on an empty seat (one bot per table).
  async function addBot(seat: Seat, difficulty: BotDifficulty = 'apprentice') {
    if (!repository || lobby.bot || playerForSeat(seat) || busy) return;
    const level = botLevels.find((l) => l.difficulty === difficulty);
    if (!level) return;
    await repository.append('bot/added', {
      botUid: `bot-${hostUid}`,
      displayName: `${level.name} Bot`,
      difficulty,
      engineVersion: botEngineVersion(difficulty),
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
    else {
      // Picking a hand card means "return this one": staged camels would
      // otherwise be placed first and surprise the player.
      const herd = lobby.round?.herds[uid] ?? [];
      for (const id of [...selected]) if (herd.some((c) => c.id === id)) selected.delete(id);
      selected.add(cardId);
    }
    await publishIntent(uid, [...selected], loads);
  }

  // The phone's hand controller toggles a specific piece: hand cards take
  // the table's path (which unstages camels first); a named camel is a
  // plain toggle, as on the upstream /hand page.
  async function toggleFromPhone(uid: string, cardId: string) {
    if (!canSelectReturns(uid)) return;
    const herd = lobby.round?.herds[uid] ?? [];
    if (!herd.some((c) => c.id === cardId)) return toggleReturn(uid, cardId);
    const loads = exchangeLoads(uid);
    if (Object.values(loads).includes(cardId)) return;
    const selected = selectedReturnIds(uid);
    await publishIntent(uid, selected.includes(cardId) ? selected.filter((id) => id !== cardId) : [...selected, cardId], loads);
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
    const held = round.hands[uid]?.length ?? 0;
    const after = held - fromHand + taken.length;
    if (after > 7) return `Over the 7-card hand limit (${after}).`;
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
  let saleSummaries = $state<Array<{ key: number; left: number; top: number; inverted: boolean; count: number; cards: number; label?: string; speed?: number }>>([]);

  function canSell(kind: Good): boolean {
    const uid = lobby.round?.activeUid;
    if (!uid || !lobby.round || busy || pendingDraw || Object.keys(exchangeLoads(uid)).length > 0) return false;
    const ids = saleIds(uid, kind);
    return isLegalSale(lobby.round, uid, kind, ids);
  }

  async function sell(kind: Good, supplySeat: Seat, count?: number) {
    const uid = lobby.round?.activeUid;
    if (!uid) return;
    saleTokenViewSeats[uid] = supplySeat;
    const ids = saleIds(uid, kind);
    await appendFor(uid, 'cards/sold', { kind, cardIds: count ? ids.slice(0, count) : ids });
  }

  // Partial sales are legal (rarely useful): while a sale is staged, the
  // prompt offers every legal count, the full sale preselected.
  function saleCounts(uid: string, kind: Good): number[] {
    const ids = saleIds(uid, kind);
    const round = lobby.round;
    if (!round) return [];
    return ids.map((_, i) => i + 1).filter((n) => isLegalSale(round, uid, kind, ids.slice(0, n)));
  }
  function salePoints(kind: Good, count: number): number {
    return lobby.round?.goodsTokens[kind].slice(0, count).reduce((sum, token) => sum + token.value, 0) ?? 0;
  }

  // Selling takes two taps like every other move: the first stages the
  // sale (the stack shows a ✓ and the prompt describes it, with Cancel), the
  // second on the same stack confirms. Table-local: nothing is written to
  // the store until the sale itself.
  let pendingSale = $state<{ uid: string; kind: Good; seat: Seat; ids: string; count: number } | null>(null);
  function tapSell(kind: Good, supplySeat: Seat) {
    const uid = lobby.round?.activeUid;
    if (!uid || !canSell(kind)) return;
    if (pendingSale && pendingSale.uid === uid && pendingSale.kind === kind) {
      const { count } = pendingSale;
      pendingSale = null;
      void sell(kind, supplySeat, count);
      return;
    }
    const ids = saleIds(uid, kind);
    pendingSale = { uid, kind, seat: supplySeat, ids: ids.join(','), count: ids.length };
  }
  function chooseSaleCount(count: number) {
    if (pendingSale) pendingSale = { ...pendingSale, count };
  }
  function confirmSale() {
    if (pendingSale) tapSell(pendingSale.kind, pendingSale.seat);
  }
  function cancelSale() {
    pendingSale = null;
  }
  // A staged sale lapses when it stops describing the table: the turn
  // passes, the selection changes, or the sale is no longer legal.
  $effect(() => {
    if (!pendingSale) return;
    const uid = lobby.round?.activeUid;
    if (uid !== pendingSale.uid || pendingDraw || saleIds(pendingSale.uid, pendingSale.kind).join(',') !== pendingSale.ids || !isLegalSale(lobby.round!, pendingSale.uid, pendingSale.kind, saleIds(pendingSale.uid, pendingSale.kind))) {
      pendingSale = null;
    }
  });

  function ownedTokens(uid: string): Token[] {
    if (!lobby.round) return [];
    return [
      ...(lobby.round.ownedGoodsTokens[uid] ?? []),
      ...(lobby.round.ownedBonusTokens[uid] ?? [])
    ];
  }

  // The newest seal stays hidden in its seat while the round summary shows it
  // (and while it is flying down); it appears when the flight lands.
  const sealStillOnSummary = (uid: string) =>
    arrivingSealUid === uid ||
    (lobby.round?.status === 'complete' && !lobby.winnerUid && lobby.round.winnerUid === uid && deliveredSealKey !== scoringKey());

  // The seal shown on the round summary flies down to the winner's seat
  // as the next market opens; the seat's new seal appears when it lands.
  function flySeal(winnerUid: string | null | undefined) {
    if (!winnerUid) return;
    const source = box('[data-result-seal]');
    const earned = lobby.seals[winnerUid] ?? 0;
    const destination = box(`[data-seat-seals="${CSS.escape(winnerUid)}"] [data-seat-seal-index="${earned - 1}"]`)
      ?? box(`[data-seat-seals="${CSS.escape(winnerUid)}"]`);
    if (!source || !destination) return;
    const startSize = Math.min(source.width, source.height);
    const endSize = Math.min(destination.width, destination.height, startSize);
    const key = ++flightSequence;
    arrivingSealUid = winnerUid;
    sealFlights = [...sealFlights, {
      key,
      inverted: invertedFor(winnerUid),
      startLeft: source.left + (source.width - startSize) / 2,
      startTop: source.top + (source.height - startSize) / 2,
      startSize,
      endLeft: destination.left + (destination.width - endSize) / 2,
      endTop: destination.top + (destination.height - endSize) / 2,
      endSize
    }];
    setTimeout(() => {
      sealFlights = sealFlights.filter((flight) => flight.key !== key);
      if (arrivingSealUid === winnerUid) arrivingSealUid = null;
    }, 1300 * SCORE_SPEED);
  }

  async function nextRound(flySealFirst = true) {
    if (!repository || !lobby.round || lobby.round.status !== 'complete' || lobby.winnerUid || scoring) return;
    if (flySealFirst) flySeal(lobby.round.winnerUid);
    await repository.append('round/started', {
      seed: crypto.randomUUID(),
      starterUid: lobby.round.loserUid,
      roundNumber: lobby.round.number + 1
    });
  }

  function quitTable() {
    // Leave the tabletop: back to the site's front page (a new table can be
    // opened from there; this one stays resumable from its game id).
    if (document.fullscreenElement) void document.exitFullscreen();
    location.href = `${base}/`;
  }

  async function rematch() {
    if (!repository || !lobby.winnerUid || demo) return;
    await repository.append('game/rematched', { epoch: lobby.epoch + 1 });
    await repository.append('round/started', {
      seed: crypto.randomUUID(),
      starterUid: playerForSeat(1)?.uid,
      roundNumber: 1
    });
  }

  // Comma-separated selectors are tried in the order given (querySelector
  // alone would return whichever matches first in DOCUMENT order, which made
  // "the card's own slot, else the hand" resolve to the hand container).
  function box(selector: string): DOMRect | undefined {
    for (const part of selector.split(/,(?![^\[]*\])/)) {
      const rect = document.querySelector<HTMLElement>(part.trim())?.getBoundingClientRect();
      if (rect) return rect;
    }
    return undefined;
  }

  const invertedFor = (uid: string) => lobby.players.find((p) => p.uid === uid)?.seat === 1;

  // Continuity: while a sale or trade animates, cards that just left the
  // hand keep their space as invisible ghosts (so the rest of the hand
  // doesn't jump); when the flights are done the ghosts collapse and the
  // remaining cards slide over.
  let handGhosts = $state<Record<string, { order: string[]; collapsing: boolean }>>({});

  // The hand is drawn newest-first: a drawn card takes the open slot next to
  // the cards (the left end) and stays there. While a move animates, cards
  // that just left keep their place as ghosts; on release the ghosts move to
  // the slot side so only the cards left of a gap slide over to close it.
  function handLayout(uid: string): Array<{ card?: Card; ghost?: string }> {
    const display = [...(lobby.round?.hands[uid] ?? [])].reverse();
    const ghosts = handGhosts[uid];
    if (!ghosts) return display.map((card) => ({ card }));
    const byId = new Map(display.map((card) => [card.id, card]));
    const ordered: Array<{ card?: Card; ghost?: string }> = ghosts.order.map((id) =>
      byId.has(id) ? { card: byId.get(id) } : { ghost: id });
    const fresh = display.filter(({ id }) => !ghosts.order.includes(id)).map((card) => ({ card }));
    if (ghosts.collapsing) {
      return [...ordered.filter((entry) => entry.ghost), ...fresh, ...ordered.filter((entry) => entry.card)];
    }
    return [...fresh, ...ordered];
  }

  // Slots, ghosts and cards are ONE keyed list so a slot appearing or
  // disappearing never shifts the cards between FLIP measurements.
  function handCells(uid: string): Array<{ key: string; slot?: number; card?: Card; ghost?: string }> {
    const layout = handLayout(uid);
    const slots = Array.from({ length: Math.max(0, 7 - layout.length) }, (_, slot) => ({ key: `slot:${slot}`, slot }));
    return [...slots, ...layout.map((entry) => ({ ...entry, key: entry.card?.id ?? `ghost:${entry.ghost}` }))];
  }

  // FLIP for hand cells. Seat 1's panel is rotated 180°, so a screen-space
  // offset has to be negated to move the element the right way.
  function handFlip(
    _node: Element,
    { from, to }: { from: DOMRect; to: DOMRect },
    params: { duration?: number; inverted?: boolean } = {}
  ) {
    const sign = params.inverted ? -1 : 1;
    const dx = (from.left - to.left) * sign;
    const dy = (from.top - to.top) * sign;
    return {
      duration: dx === 0 && dy === 0 ? 0 : params.duration ?? 420,
      easing: cubicOut,
      css: (_t: number, u: number) => `transform: translate(${u * dx}px, ${u * dy}px)`
    };
  }

  function holdHandSpaces(uid: string, handOrder: string[]) {
    handGhosts = { ...handGhosts, [uid]: { order: [...handOrder].reverse(), collapsing: false } };
  }

  function releaseHandSpaces(uid: string) {
    const ghosts = handGhosts[uid];
    if (!ghosts) return;
    handGhosts = { ...handGhosts, [uid]: { ...ghosts, collapsing: true } }; // ghosts join the slot side; cards slide over
    // Swap the ghosts for real slots only once the slide is long finished:
    // another list update mid-slide would restart the FLIP from the layout
    // position (a visible jump).
    setTimeout(() => {
      const { [uid]: _gone, ...rest } = handGhosts;
      handGhosts = rest;
    }, 1500);
  }

  function cardFlight(
    source: DOMRect | undefined,
    destination: DOMRect | undefined,
    image: string,
    delay = 0,
    cardId?: string,
    revealImage?: string,
    concealsDestination = false,
    arc = false,
    inverted = false,
    speed = 1
  ) {
    if (!source || !destination) {
      if (cardId) arrivingCardIds = arrivingCardIds.filter((id) => id !== cardId);
      return;
    }
    const startSize = Math.min(source.width, source.height);
    // Into a card slot: match the slot (growing if need be); onto a token
    // stack: never larger than the card was.
    const endSize = concealsDestination
      ? Math.min(destination.width, destination.height)
      : Math.min(destination.width, destination.height, startSize);
    const key = ++flightSequence;
    cardFlights = [...cardFlights, {
      key,
      cardId,
      image,
      revealImage,
      concealsDestination,
      arc,
      inverted,
      startLeft: source.left + (source.width - startSize) / 2,
      startTop: source.top + (source.height - startSize) / 2,
      startSize,
      endLeft: destination.left + (destination.width - endSize) / 2,
      endTop: destination.top + (destination.height - endSize) / 2,
      endSize,
      delay,
      speed
    }];
    setTimeout(() => finishCardFlight(key), (arc ? 1900 : 1400) * speed + delay);
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
    scheduleArrivingWatchdog();
    cardFlight(
      source,
      destination,
      componentImage(fromHand ? 'card-back' : 'camel'),
      0,
      returnCardId,
      // A hand card flips (and stays face-down: private) before arcing
      // below the market card; a camel is public and just arcs face up.
      fromHand ? componentImage('card-back') : undefined,
      true,
      true,
      invertedFor(uid)
    );
  }

  // ---- Development: animation demos ------------------------------------
  // Each side of the table gets buttons that play the sale animation from
  // that side with faked card positions (no game state involved), then tidy
  // up after a 3 s pause.
  const devMode = import.meta.env.DEV || new URLSearchParams(location.search).get('dev') === '1';
  // Dev hook: seat a player without a phone (drives the table from tests).
  if (devMode && typeof window !== 'undefined') {
    (window as unknown as { __jaipurDev?: unknown }).__jaipurDev = {
      sit: (seat: number, name = 'Tester') => joinFromAr(String(seat), name),
      viewerUrl: (seat: 1 | 2) => ar?.arViewerUrl(seat),
      // Play one move for whoever is active (the apprentice heuristic
      // stands in for a human), or run the whole game to its summary —
      // used to capture screens for the progress log.
      play: async () => {
        const round = lobby.round;
        if (!repository || round?.status !== 'active') return false;
        const observation = createBotObservation(lobby, round.activeUid);
        const action = observation ? chooseBotAction(observation) : null;
        if (!observation || !action) return false;
        const event = botActionEvent(observation, action);
        await repository.append(event.type, event.payload);
        return true;
      },
      finishGame: async () => {
        const deadline = Date.now() + 20 * 60_000;
        while (Date.now() < deadline && !lobby.winnerUid) {
          const round = lobby.round;
          if (round?.status === 'complete') { await nextRound(); await wait(60); continue; }
          if (round?.status !== 'active') { await wait(60); continue; }
          if (round.activeUid === lobby.bot?.uid) { await wait(60); continue; }
          const hook = (window as unknown as { __jaipurDev: { play: () => Promise<boolean> } }).__jaipurDev;
          if (!(await hook.play())) await wait(60);
        }
        return Boolean(lobby.winnerUid);
      },
      demo: () => runAnimationDemo(),
      demoStep: (index: number, seat: Seat) => DEMO_CATEGORIES[index].run(seat)
    };
  }
  const DEMO_VALUES: Record<string, number[]> = { diamond: [7, 7, 5, 5, 5], silver: [5, 5, 5, 5, 5], leather: [4, 3, 2, 1, 1, 1, 1, 1, 1] };

  function demoSale(seat: Seat, kind: Good, count: number) {
    const panel = box(`[data-seat="${seat}"]`);
    if (!panel) return;
    const view = `[data-token-view-seat="${seat}"]`;
    const stack = box(`${view} [data-token-kind="${kind}"]`) ?? box(view);
    if (!stack) return;
    // Card sources: real hand cards, else empty hand slots, else a fan
    // laid across the seat panel.
    const handRects = [...document.querySelectorAll<HTMLElement>(`[data-seat="${seat}"] [data-table-hand-card], [data-seat="${seat}"] .hand-slot`)]
      .map((el) => el.getBoundingClientRect());
    const size = Math.min(panel.height * 0.6, panel.width / 9);
    const sources = Array.from({ length: count }, (_, i) =>
      handRects[i] ?? new DOMRect(panel.left + panel.width * 0.25 + i * size * 0.8, panel.top + (panel.height - size) / 2, size, size));
    sources.forEach((src, i) =>
      cardFlight(src, stack, componentImage('card-back'), i * 90 * SALE_SPEED, undefined, componentImage(kind), false, true, seat === 1, SALE_SPEED));
    // Tokens: the stack's coins if the round is on, else the stack itself.
    const coins = [...document.querySelectorAll<HTMLElement>(`${view} [data-token-kind="${kind}"] [data-supply-token-id]`)].slice(0, count);
    const dest = box(`[data-seat="${seat}"] [data-table-tokens]`) ?? new DOMRect(panel.left + panel.width / 2 - 40, panel.bottom - 60, 80, 40);
    const tokenDelay = (1250 + count * 90) * SALE_SPEED;
    const fly = (source: DOMRect, token: Token, delay: number) => {
      const startSize = Math.min(source.width, source.height, 64);
      const endSize = Math.min(dest.width, dest.height, startSize);
      const key = ++flightSequence;
      tokenFlights = [...tokenFlights, {
        key, token, inverted: seat === 1,
        startLeft: source.left + (source.width - startSize) / 2, startTop: source.top + (source.height - startSize) / 2, startSize,
        endLeft: dest.left + (dest.width - endSize) / 2, endTop: dest.top + (dest.height - endSize) / 2, endSize, delay, speed: SALE_SPEED
      }];
      setTimeout(() => tokenFlights = tokenFlights.filter((flight) => flight.key !== key), 1000 * SALE_SPEED + delay);
    };
    for (let i = 0; i < count; i += 1) {
      fly(coins[i]?.getBoundingClientRect() ?? stack, { id: `demo-${kind}-${i}`, kind, value: DEMO_VALUES[kind]?.[i] ?? 1 } as Token, tokenDelay + i * 80 * SALE_SPEED);
    }
    if (count >= 3) {
      const bonusSize = count >= 5 ? '5' : count === 4 ? '4' : '3';
      fly(box(`${view} [data-bonus-size="${bonusSize}"]`) ?? stack, { id: `demo-bonus-${bonusSize}`, kind: `bonus-${bonusSize}`, value: 0 } as Token, tokenDelay + count * 80 * SALE_SPEED);
    }
    const key = ++flightSequence;
    setTimeout(() => {
      saleSummaries = [...saleSummaries, { key, left: dest.left + dest.width / 2, top: dest.top + dest.height / 2, inverted: seat === 1, count: count + (count >= 3 ? 1 : 0), cards: count, speed: SALE_SPEED }];
      setTimeout(() => saleSummaries = saleSummaries.filter((entry) => entry.key !== key), 2600 * SALE_SPEED);
    }, (900 + count * 80) * SALE_SPEED + tokenDelay);
    // Flights and the summary remove themselves; nothing else to reset
    // (a blanket clear here wiped the next run when buttons were pressed
    // in quick succession).
  }

  // ---- Animation demo (settings panel) ------------------------------------
  // Walks every animation category from each side of the table using the
  // REAL move path: each step builds a before/after game state and hands the
  // synthetic move to animateActivities exactly as a store update would. The
  // live game is parked meanwhile (store updates are deferred) and restored
  // when the demo ends or is cancelled.
  let demo = $state<{ index: number; total: number; title: string; seat: Seat } | null>(null);
  let demoCancelled = false;
  let demoDeferred: GameEvent[] | null = null;
  let demoSavedLobby: GameState | null = null;
  let demoSavedSealKey = '';
  const DEMO_UIDS: Record<Seat, string> = { 1: 'demo-north', 2: 'demo-south' };
  let demoCardSeq = 0;
  const demoCard = (kind: CardKind): Card => ({ id: `demo-${kind}-${++demoCardSeq}`, kind });
  const demoCards = (kinds: CardKind[]): Card[] => kinds.map(demoCard);
  const demoOther = (seat: Seat): Seat => (seat === 1 ? 2 : 1);

  function demoBase(actorSeat: Seat): GameState {
    const actor = DEMO_UIDS[actorSeat];
    const other = DEMO_UIDS[demoOther(actorSeat)];
    const round = setupRound([DEMO_UIDS[1], DEMO_UIDS[2]], 'animation-demo', actor);
    round.hands[actor] = demoCards(['gold', 'cloth', 'spice', 'leather', 'gold']);
    round.hands[other] = demoCards(['cloth', 'spice', 'leather', 'gold', 'silver']);
    round.herds[actor] = demoCards(['camel', 'camel']);
    round.herds[other] = demoCards(['camel', 'camel', 'camel']);
    round.market = demoCards(['diamond', 'gold', 'silver', 'cloth', 'spice']);
    round.deck = demoCards(['leather', 'spice', 'cloth', 'gold', 'diamond', 'silver', 'leather', 'cloth', 'spice', 'gold']);
    return {
      gameId: lobby.gameId,
      hostUid: lobby.hostUid,
      mode: 'tabletop',
      bot: null,
      players: [
        { uid: DEMO_UIDS[1], displayName: playerForSeat(1)?.displayName ?? 'North', ready: true, seat: 1 },
        { uid: DEMO_UIDS[2], displayName: playerForSeat(2)?.displayName ?? 'South', ready: true, seat: 2 }
      ],
      activity: [],
      diagnostics: [],
      round,
      rounds: [round],
      seals: { [DEMO_UIDS[1]]: 0, [DEMO_UIDS[2]]: 0 },
      winnerUid: null,
      epoch: 999, // never matches a live bot-turn key
      tabletopIntents: {},
      pendingDraw: null
    };
  }

  // Show `previous`, then switch to `next` and animate the move between them.
  async function demoMove(
    previous: GameState,
    next: GameState,
    activity: Omit<GameActivity, 'id'>
  ) {
    // Show the starting position first, so the viewer sees the scope of
    // the animation before it moves.
    lobby = previous;
    await tick();
    await wait(500);
    if (demoCancelled) return;
    lobby = next;
    await animateActivities([{ id: `demo-${++flightSequence}`, ...activity }], previous, next);
  }

  const demoSellStep = (kind: Good, count: number) => async (seat: Seat) => {
    const previous = demoBase(seat);
    const actor = DEMO_UIDS[seat];
    const sold = demoCards(Array<CardKind>(count).fill(kind));
    previous.round!.hands[actor] = [...sold, ...previous.round!.hands[actor].slice(0, 7 - count)];
    const next = structuredClone(previous);
    applySale(next.round!, actor, kind, sold.map(({ id }) => id));
    await demoMove(previous, next, {
      type: 'cards/sold',
      actorUid: actor,
      cardIds: sold.map(({ id }) => id),
      cardKinds: sold.map(({ kind }) => kind),
      tokenCount: count + (count >= 3 ? 1 : 0)
    });
  };

  const demoTakeOne = async (seat: Seat) => {
    const previous = demoBase(seat);
    const actor = DEMO_UIDS[seat];
    const next = structuredClone(previous);
    const taken = next.round!.market[1];
    next.round!.market[1] = next.round!.deck.shift()!;
    next.round!.hands[actor].push(taken);
    await demoMove(previous, next, { type: 'cards/taken-one', actorUid: actor, cardIds: [taken.id], cardKinds: [taken.kind] });
  };

  const demoTakeCamels = async (seat: Seat) => {
    const previous = demoBase(seat);
    const actor = DEMO_UIDS[seat];
    previous.round!.market = demoCards(['camel', 'gold', 'camel', 'camel', 'silver']);
    const next = structuredClone(previous);
    const camels = next.round!.market.filter(({ kind }) => kind === 'camel');
    next.round!.market = next.round!.market.map((card) => (card.kind === 'camel' ? next.round!.deck.shift()! : card));
    next.round!.herds[actor].push(...camels);
    await demoMove(previous, next, {
      type: 'cards/taken-camels',
      actorUid: actor,
      cardIds: camels.map(({ id }) => id),
      cardKinds: camels.map(({ kind }) => kind)
    });
  };

  const demoTrade = async (seat: Seat) => {
    const previous = demoBase(seat);
    const actor = DEMO_UIDS[seat];
    const round = previous.round!;
    const [h0, h1] = round.hands[actor];
    const [c0] = round.herds[actor];
    const [m0, m1, m2] = round.market;
    // The returns already sit below their targets, as they do after the
    // player has placed them on the table.
    previous.tabletopIntents = { [actor]: { selectedReturnIds: [], exchangeLoads: { [m0.id]: h0.id, [m1.id]: h1.id, [m2.id]: c0.id } } };
    const next = structuredClone(previous);
    next.tabletopIntents = {};
    next.round!.hands[actor] = [...next.round!.hands[actor].filter(({ id }) => id !== h0.id && id !== h1.id), m0, m1, m2];
    next.round!.herds[actor] = next.round!.herds[actor].filter(({ id }) => id !== c0.id);
    next.round!.market = [h0, h1, c0, ...next.round!.market.slice(3)];
    await demoMove(previous, next, {
      type: 'cards/exchanged',
      actorUid: actor,
      cardIds: [m0.id, m1.id, m2.id],
      cardKinds: [m0.kind, m1.kind, m2.kind],
      returnedCardIds: [h0.id, h1.id, c0.id],
      returnedCardKinds: [h0.kind, h1.kind, c0.kind]
    });
  };

  // The real round-end sequence (runRoundScoring) over a staged position:
  // both players hold goods and bonus tokens, the actor holds more and the
  // larger herd. With `gameOver` the actor already has one seal, so the
  // round hands over the second and the end-of-game screen stays up.
  const demoScoring = (gameOver: boolean) => async (seat: Seat) => {
    const previous = demoBase(seat);
    const actor = DEMO_UIDS[seat];
    const other = DEMO_UIDS[demoOther(seat)];
    const round = previous.round!;
    round.ownedGoodsTokens[actor] = [...round.goodsTokens.diamond.splice(0, 3), ...round.goodsTokens.gold.splice(0, 2)];
    round.ownedBonusTokens[actor] = [...round.bonusTokens['3'].splice(0, 1), ...round.bonusTokens['5'].splice(0, 1)];
    round.ownedGoodsTokens[other] = [...round.goodsTokens.silver.splice(0, 2), ...round.goodsTokens.cloth.splice(0, 3)];
    round.ownedBonusTokens[other] = round.bonusTokens['3'].splice(0, 1);
    round.herds[actor] = demoCards(['camel', 'camel', 'camel', 'camel']);
    round.herds[other] = demoCards(['camel']);
    if (gameOver) previous.seals = { [actor]: 1, [other]: 0 };
    const complete = structuredClone(previous);
    const result = resolveRound(complete.round!, [DEMO_UIDS[1], DEMO_UIDS[2]]);
    Object.assign(complete.round!, {
      status: 'complete',
      endReason: 'three-empty-supplies',
      camelBonusUid: result.camelBonusUid,
      scores: result.scores,
      winnerUid: result.winnerUid,
      loserUid: result.loserUid,
      tieBreak: result.tieBreak
    });
    complete.seals = { ...complete.seals, [result.winnerUid]: (complete.seals[result.winnerUid] ?? 0) + 1 };
    if (gameOver) complete.winnerUid = result.winnerUid;
    lobby = previous;
    await tick();
    await wait(500); // the position before the round ends
    if (demoCancelled) return;
    lobby = complete;
    await tick();
    const key = scoringKey();
    claimRoundScoring(key);
    await runRoundScoring(key);
    if (demoCancelled) return;
    await wait(2000); // hold the final state
  };

  const DEMO_CATEGORIES: Array<{ title: string; run: (seat: Seat) => Promise<void>; once?: boolean }> = [
    { title: 'Sell 2 silver', run: demoSellStep('silver', 2) },
    { title: 'Sell 3 diamonds (3-card bonus)', run: demoSellStep('diamond', 3) },
    { title: 'Sell 5 leather (5-card bonus, two coin lines)', run: demoSellStep('leather', 5) },
    { title: 'Take one card, deck refills', run: demoTakeOne },
    { title: 'Take 3 camels, deck refills', run: demoTakeCamels },
    { title: 'Trade 2 cards + 1 camel for 3', run: demoTrade },
    { title: 'Round end: scoring and the Seal of Excellence', run: demoScoring(false), once: true },
    { title: 'Game end: second seal, winner, end-of-game actions', run: demoScoring(true), once: true }
  ];

  async function runAnimationDemo() {
    if (demo) return;
    scalePanelOpen = false;
    demoCancelled = false;
    demoDeferred = null;
    demoSavedLobby = lobby;
    demoSavedSealKey = deliveredSealKey;
    // Each move is shown from both seats; the scoring sequences once (they
    // already play to both sides at once).
    const steps = DEMO_CATEGORIES.flatMap((category) => ((category.once ? [2] : [2, 1]) as Seat[]).map((seat) => ({ ...category, seat })));
    try {
      for (const [index, step] of steps.entries()) {
        if (demoCancelled) break;
        demo = { index: index + 1, total: steps.length, title: step.title, seat: step.seat };
        await step.run(step.seat);
        if (demoCancelled) break;
        await wait(900);
      }
    } finally {
      endAnimationDemo();
    }
  }

  function cancelAnimationDemo() {
    demoCancelled = true;
    scoring = null;
    cardFlights = [];
    tokenFlights = [];
    sealFlights = [];
    saleSummaries = [];
    arrivingCardIds = [];
    arrivingSealUid = null;
    handGhosts = {};
  }

  function endAnimationDemo() {
    demo = null;
    if (scoring) scoring = null; // a demo scoring sequence never outlives the demo
    deliveredSealKey = demoSavedSealKey;
    if (demoSavedLobby) lobby = demoSavedLobby;
    demoSavedLobby = null;
    if (demoDeferred) {
      // Moves made while the demo ran: catch up without animating them.
      lobby = reduceGame(demoDeferred);
      for (const activity of lobby.activity) knownActivityIds.add(activity.id);
      demoDeferred = null;
    }
    scheduledBotKey = '';
    maybeBotTurn();
    publishAr();
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
      arc?: boolean;
      inverted?: boolean;
      speed?: number;
    }> = [];
    const tokenMovements: Array<{
      source: DOMRect | undefined;
      destinationSelector: string;
      token: Token;
      delay: number;
      bonus?: boolean;
      speed?: number;
    }> = [];

    let refillDelay = 120;
    let refillStep = 70;
    // Everything in this batch animates for the acting player; seat 1 sits
    // on the far side, so their arcs lift the other way.
    const actorInverted = invertedFor(activities[0]?.actorUid ?? '');
    for (const activity of activities) {
      const uid = activity.actorUid;
      if (activity.type === 'cards/taken-one' || activity.type === 'cards/taken-camels') {
        // The taken card(s) flip face-down where they lie, then arc into the
        // hand (or every camel into the herd), shrinking; deck refills wait.
        activity.cardIds?.forEach((cardId, index) => {
          const kind = activity.cardKinds?.[index] as Good | 'camel' | undefined;
          movements.push({
            cardId,
            source: box(`[data-market-card-id="${CSS.escape(cardId)}"]`),
            // Straight into the slot the card now occupies (rendered hidden
            // until it lands), not the middle of the hand/herd.
            destinationSelector: kind === 'camel'
              ? `[data-table-herd-card="${CSS.escape(cardId)}"], [data-table-herd="${CSS.escape(uid)}"]`
              : `[data-table-hand-card="${CSS.escape(cardId)}"], [data-table-hand="${CSS.escape(uid)}"]`,
            image: componentImage(kind ?? 'card-back'),
            // Camels stay camels: no flip, straight into the arc.
            revealImage: kind === 'camel' ? undefined : componentImage('card-back'),
            concealDestination: true,
            delay: index * 90,
            arc: true
          });
        });
        refillDelay = 1350 + (activity.cardIds?.length ?? 1) * 90;
        refillStep = activity.type === 'cards/taken-camels' ? 260 : 70;
      }
      if (activity.type === 'cards/exchanged') {
        // The chosen market cards flip face-down and arc into the hand;
        // then the returned cards (already face-down below them) flip face
        // up and slide into the vacated market slots.
        const taken = activity.cardIds?.length ?? 0;
        holdHandSpaces(uid, (previous.round?.hands[uid] ?? []).map(({ id }) => id));
        activity.cardIds?.forEach((cardId, index) => movements.push({
          cardId,
          source: box(`[data-market-card-id="${CSS.escape(cardId)}"]`),
          destinationSelector: `[data-table-hand-card="${CSS.escape(cardId)}"], [data-table-hand="${CSS.escape(uid)}"]`,
          image: componentImage((activity.cardKinds?.[index] as Good) ?? 'card-back'),
          revealImage: componentImage('card-back'),
          concealDestination: true,
          delay: index * 90,
          arc: true
        }));
        const previousLoads = previous.tabletopIntents[uid]?.exchangeLoads ?? {};
        activity.returnedCardIds?.forEach((cardId, index) => {
          const targetId = Object.entries(previousLoads).find(([, returnId]) => returnId === cardId)?.[0];
          const returnedKind = (activity.returnedCardKinds?.[index] as Good | 'camel' | undefined) ?? 'card-back';
          movements.push({
            cardId,
            source: targetId ? box(`[data-table-exchange-target="${CSS.escape(targetId)}"]`) : undefined,
            destinationSelector: `[data-market-card-id="${CSS.escape(cardId)}"]`,
            // Camels were already face up on the Return target: no flip.
            image: componentImage(returnedKind === 'camel' ? 'camel' : 'card-back'),
            revealImage: returnedKind === 'camel' ? undefined : componentImage(returnedKind),
            concealDestination: true,
            delay: 1350 + taken * 90 + index * 120,
            arc: true
          });
        });
      }
      if (activity.type === 'cards/sold') {
        // Tokens come from the token section facing the seller (their own
        // side), whichever stack was tapped.
        const tokenView = tokenViewSelector(uid);
        delete saleTokenViewSeats[uid];
        // The sold cards flip face-up in the hand, then arc (shrinking) to
        // that good's stack on the seller's side; the tokens follow after.
        // Their places in the hand stay open until everything has landed.
        holdHandSpaces(uid, (previous.round?.hands[uid] ?? []).map(({ id }) => id));
        activity.cardIds?.forEach((cardId, index) => movements.push({
          cardId,
          source: box(`[data-table-hand-card="${CSS.escape(cardId)}"]`),
          destinationSelector: `${tokenView} [data-token-kind="${CSS.escape(
            (activity.cardKinds?.[index] as Good | undefined) ?? 'leather'
          )}"]`,
          image: componentImage('card-back'),
          revealImage: componentImage((activity.cardKinds?.[index] as Good | undefined) ?? 'leather'),
          concealDestination: false,
          delay: index * 90 * SALE_SPEED,
          arc: true,
          speed: SALE_SPEED
        }));
        const oldTokens = new Set([
          ...(previous.round?.ownedGoodsTokens[uid] ?? []),
          ...(previous.round?.ownedBonusTokens[uid] ?? [])
        ].map(({ id }) => id));
        const awards = [
          ...(next.round?.ownedGoodsTokens[uid] ?? []),
          ...(next.round?.ownedBonusTokens[uid] ?? [])
        ].filter(({ id }) => !oldTokens.has(id));
        const goodsAwards = awards.filter(({ kind }) => !kind.startsWith('bonus-'));
        const bonusAwards = awards.filter(({ kind }) => kind.startsWith('bonus-'));
        // after the sold cards have landed on the stack
        const firstTokenDelay = (1250 + (activity.cardIds?.length ?? 1) * 90) * SALE_SPEED;
        goodsAwards.forEach((token, index) => tokenMovements.push({
          source: box(`${tokenView} [data-token-kind="${CSS.escape(token.kind)}"] .rail-chip`),
          destinationSelector: `[data-table-tokens="${CSS.escape(uid)}"]`,
          token,
          delay: firstTokenDelay + index * 80 * SALE_SPEED,
          speed: SALE_SPEED
        }));
        // The bonus token is its own beat: it flies once the "cards sold"
        // message has played, and gets a message of its own.
        const soldMessageAt = 900 * SALE_SPEED + firstTokenDelay + Math.max(0, goodsAwards.length - 1) * 80 * SALE_SPEED;
        bonusAwards.forEach((token, index) => tokenMovements.push({
          source: box(`${tokenView} [data-bonus-size="${token.kind.replace('bonus-', '')}"]`),
          destinationSelector: `[data-table-tokens="${CSS.escape(uid)}"]`,
          token,
          bonus: true,
          delay: soldMessageAt + (1400 + index * 80) * SALE_SPEED,
          speed: SALE_SPEED
        }));
      }
    }

    const previousMarketIds = new Set(previous.round?.market.map(({ id }) => id) ?? []);
    // (refillDelay/refillStep are set by the take/camel cases above)
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
      delay: refillDelay + index * refillStep,
      arc: true,
      // The deck belongs to nobody: refills always rise up the screen
      // (an inherited seat-1 arc dipped them toward the bottom player,
      // which read as the cards sinking under the market).
      inverted: false
    }));

    const hasAnimation = movements.length > 0 || tokenMovements.length > 0;
    if (hasAnimation) actionAnimating = true;
    arrivingCardIds = [...new Set([
      ...arrivingCardIds,
      ...movements.filter(({ concealDestination }) => concealDestination).map(({ cardId }) => cardId)
    ])];
    scheduleArrivingWatchdog();
    await tick();
    movements.forEach(({ cardId, source, destinationSelector, image, revealImage, concealDestination, delay, arc, inverted, speed }) =>
      cardFlight(
        source,
        box(destinationSelector),
        image,
        delay,
        cardId,
        revealImage,
        concealDestination,
        arc,
        inverted ?? actorInverted,
        speed ?? 1
      )
    );
    tokenMovements.forEach(({ source, destinationSelector, token, delay, speed = 1 }) => {
      const destination = box(destinationSelector);
      if (!source || !destination) return;
      const startSize = Math.min(source.width, source.height, 64);
      const endSize = Math.min(destination.width, destination.height, startSize);
      const key = ++flightSequence;
      tokenFlights = [...tokenFlights, {
        key,
        token,
        inverted: actorInverted,
        startLeft: source.left + (source.width - startSize) / 2,
        startTop: source.top + (source.height - startSize) / 2,
        startSize,
        endLeft: destination.left + (destination.width - endSize) / 2,
        endTop: destination.top + (destination.height - endSize) / 2,
        endSize,
        delay,
        speed
      }];
      setTimeout(() => tokenFlights = tokenFlights.filter((flight) => flight.key !== key), 1000 * speed + delay);
    });
    for (const activity of activities) {
      if (activity.type !== 'cards/sold' || tokenMovements.length === 0) continue;
      const uid = activity.actorUid;
      const target = box(`[data-table-tokens="${CSS.escape(uid)}"]`);
      if (!target) continue;
      const cards = activity.cardIds?.length ?? 0;
      const seat = lobby.players.find((p) => p.uid === uid)?.seat;
      const goodsMoves = tokenMovements.filter((m) => !m.bonus);
      const bonusMoves = tokenMovements.filter((m) => m.bonus);
      const showSummary = (at: number, count: number, label: string) => {
        const key = ++flightSequence;
        setTimeout(() => {
          saleSummaries = [...saleSummaries, {
            key, left: target.left + target.width / 2, top: target.top + target.height / 2,
            inverted: seat === 1, count, cards, label, speed: SALE_SPEED
          }];
          setTimeout(() => saleSummaries = saleSummaries.filter((entry) => entry.key !== key), 2600 * SALE_SPEED);
        }, at);
      };
      if (goodsMoves.length > 0) {
        showSummary(900 * SALE_SPEED + Math.max(...goodsMoves.map((m) => m.delay)), goodsMoves.length, `${cards} card${cards === 1 ? '' : 's'} sold!`);
      }
      for (const move of bonusMoves) {
        showSummary(900 * SALE_SPEED + move.delay, 1, `${move.token.kind.replace('bonus-', '')}-card bonus token!`);
      }
    }
    if (hasAnimation) {
      try {
        while (cardFlights.length > 0 || tokenFlights.length > 0) await wait(25);
      } finally {
        actionAnimating = false;
        for (const uid of Object.keys(handGhosts)) releaseHandSpaces(uid);
        // Every flight has landed: the AR phones may now see the result
        // (also needed for the sale preview, which depends on !busy).
        if (!demo || arPublishHeld) publishAr();
      }
    } else {
      for (const uid of Object.keys(handGhosts)) releaseHandSpaces(uid);
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
      <div class="bot-seat-buttons" role="group" aria-label="Seat a computer opponent here">
        {#each botLevels as level (level.difficulty)}
          <button
            type="button"
            class="bot-seat-button"
            data-bot-seat={seat}
            data-bot-level={level.difficulty}
            disabled={!repository || busy}
            onclick={() => addBot(seat, level.difficulty)}
          >
            Play as {level.name} <small>{level.blurb}</small>
          </button>
        {/each}
      </div>
    {/if}
  </section>
{/snippet}

{#snippet optionsGear(seat: Seat)}
  <button
    type="button"
    class="orientation-toggle options-gear"
    class:for-top={seat === 1}
    data-options-seat={seat}
    aria-expanded={scalePanelOpen}
    aria-label="Table options and AR screen scale"
    data-ar-diag={arDiag}
    onclick={() => { scalePanelOpen = !scalePanelOpen; refreshPhysical(); }}
  ><span class="scale-gear" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="1em" height="1em">
        <path fill="currentColor" d="M24 4l3 4.5 5.3-1.4 1.4 5.3L38.5 15 36 20l4 3.6-4 3.6 2.5 5-4.8 2.6-1.4 5.3-5.3-1.4L24 44l-3-4.5-5.3 1.4-1.4-5.3L9.5 33 12 28l-4-3.6 4-3.6-2.5-5 4.8-2.6 1.4-5.3 5.3 1.4z" opacity="0.28"/>
        <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M15 33L33 15M15 33h5m-5 0v-5M33 15h-5m5 0v5"/>
      </svg>
      <b>{arDiag}″</b>
    </span>{#if physical && !physical.fullscreen}<small class="scale-note">win</small>{/if}</button>
{/snippet}

{#snippet tutLines(text: string | undefined, titled = false)}
  {#each (text ?? '').split(';') as line, i}
    {#if i > 0}<br />{/if}
    {#if titled && i === 0}<strong class="tut-title">{line.trim()}</strong>
    {:else}{#each line.trim().split('[hand]') as part, j}{#if j > 0}{@render handIcon()}{/if}{part}{/each}{/if}
  {/each}
{/snippet}

{#snippet handIcon()}
  <svg class="tut-finger inline" viewBox="0 0 24 24" aria-label="tap"><path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V11l1-.2V8.5a1.5 1.5 0 0 1 3 0v3l1 .1V10a1.5 1.5 0 0 1 3 0v6.5c0 3-2.5 5.5-5.5 5.5h-2.2a5 5 0 0 1-4.2-2.3l-3.4-5.4a1.5 1.5 0 0 1 2.4-1.7L9 15z" fill="currentColor" /></svg>
{/snippet}

{#snippet endActions()}
  {#if lobby.winnerUid}
    <button type="button" class="end-primary" disabled={busy || Boolean(demo)} onclick={rematch}>Rematch</button>
    <button type="button" disabled={Boolean(demo)} onclick={newTable}>New game</button>
    <button type="button" disabled={Boolean(demo)} onclick={quitTable}>Quit</button>
  {:else}
    <button type="button" class="end-primary" disabled={busy || Boolean(demo)} onclick={() => nextRound()}>Open round {(lobby.round?.number ?? 0) + 1}</button>
  {/if}
{/snippet}

{#snippet playerSeat(seat: Seat, player: Player)}
  {@const isActive = lobby.round?.status === 'active' && seat === marketFacingSeat}
  <section
    class="player-seat"
    class:active={isActive}
    class:round-winner={scoring?.winnerBanner && scoring.winnerUid === player.uid}
    data-seat={seat}
    data-player-uid={player.uid}
    aria-label={`Player ${seat}, ${player.displayName}`}
  >
    {#if scoring?.winnerBanner && scoring.winnerUid === player.uid}
      <div class="round-winner-banner" data-round-winner-banner role="status">Round winner</div>
    {/if}
    {#if gameWon && lobby.winnerUid === player.uid && scoring?.sealsWon && !scoring.bannerGone}
      <div class="game-winner-banner" class:fading={scoring.stage === 'final'} style={`--fade:${END_FADE_MS}ms`} data-game-winner-banner role="status">{player.displayName} wins the game!</div>
    {/if}
    {#if botThinking && player.uid === lobby.bot?.uid}
      <div class="bot-thinking" data-bot-thinking={player.uid} role="status" aria-label={`${player.displayName} is thinking`}>
        <svg class="hourglass" viewBox="0 0 64 96" aria-hidden="true">
          <path d="M10 6h44v8a24 24 0 0 1-14 21.8v8.4A24 24 0 0 1 54 66v24H10V66a24 24 0 0 1 14-21.8v-8.4A24 24 0 0 1 10 14z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" />
          <path d="M18 14h28a16 16 0 0 1-14 16 16 16 0 0 1-14-16z" fill="currentColor" opacity="0.55" />
          <path d="M22 84h20a10 10 0 0 0-10-14 10 10 0 0 0-10 14z" fill="currentColor" opacity="0.55" />
          <path d="M32 40v30" stroke="currentColor" stroke-width="3" stroke-dasharray="3 4" />
        </svg>
      </div>
    {/if}
    <header>
      <div>
        <span class="seat-kicker">Player {seat}</span>
        <h2>{player.displayName}</h2>
      </div>
      <strong class="turn-state">{isActive ? 'Your turn' : 'Waiting'}</strong>
      {#if scoring || lobby.round?.status === 'complete'}
        <span class="score-stack">
          {#if scoring && scoring.stage !== 'pending'}
            <!-- Three landing zones above the total (bottom to top: goods
                 sold, bonus tokens, most camels). Tokens stay where they
                 land, each zone with its subtotal, through the seal delivery. -->
            <span class="score-zones" data-score-zones={player.uid} aria-label="Round score breakdown">
              {#each ['goods', 'bonus', 'camel'] as const as zone}
                {@const landed = scoring.landed[player.uid]?.[zone] ?? []}
                <span class="score-zone" class:filled={landed.length > 0} data-score-zone={`${player.uid}:${zone}`}>
                  <small>{ZONE_LABEL[zone]}</small>
                  <span class="zone-chips">{#each landed as token (token.id)}<span class="zone-chip"><TokenChip {token} /></span>{/each}</span>
                  <b>{zoneTotal(player.uid, zone)}</b>
                </span>
              {/each}
            </span>
          {/if}
          <span class="score-total" data-score-total={player.uid} aria-label="Round score">
            {scoring ? scoring.totals[player.uid] ?? 0 : lobby.round?.scores?.[player.uid]?.total ?? 0}<small>pts</small>
          </span>
        </span>
      {/if}
      <span class="seat-seals" class:won={gameWon && lobby.winnerUid === player.uid} data-seat-seals={player.uid} aria-label={`${lobby.seals[player.uid] ?? 0} of 2 Seals of Excellence`}>
        {#each Array(2) as _, sealIndex}
          <img
            class:earned={sealIndex < (lobby.seals[player.uid] ?? 0)}
            class:arriving={sealIndex === (lobby.seals[player.uid] ?? 0) - 1 && sealStillOnSummary(player.uid)}
            data-seat-seal-index={sealIndex}
            src={componentImage('seal')}
            alt=""
          />
        {/each}
      </span>
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
        {#each handCells(player.uid) as entry (entry.key)}
          <span class="hand-cell" animate:handFlip={{ duration: 420, inverted: seat === 1 }}>
          {#if entry.slot !== undefined}
            <span class="hand-slot" aria-hidden="true" data-hand-slot={entry.slot}></span>
          {:else if entry.ghost}
            <span class="table-hand-card ghost" class:as-slot={handGhosts[player.uid]?.collapsing} aria-hidden="true" data-hand-ghost={entry.ghost}></span>
          {:else if entry.card}
          {@const card = entry.card}
          {@const selected = selectedReturnIds(player.uid).includes(card.id)}
          {@const loaded = Object.values(exchangeLoads(player.uid)).includes(card.id)}
          <button
            type="button"
            class="table-hand-card"
            class:arriving={arrivingCardIds.includes(card.id)}
            class:selected
            class:loaded
            class:revealed={(showHands && player.uid !== lobby.bot?.uid) || revealedCardIds.includes(card.id)}
            aria-disabled={!canSelectReturns(player.uid) || loaded}
            aria-pressed={selected}
            aria-label={`${selected ? 'Deselect' : 'Select'} face-down card for a trade; hold to peek at it`}
            data-table-hand-card={card.id}
            data-card-arriving={arrivingCardIds.includes(card.id) || undefined}
            data-card-revealed={(showHands && player.uid !== lobby.bot?.uid) || revealedCardIds.includes(card.id) || undefined}
            onclick={() => { if (consumeLongPress(card.id)) return; if (canSelectReturns(player.uid) && !loaded) toggleReturn(player.uid, card.id); }}
            onpointerdown={(e) => startLongPress(e, card.id)}
            onpointerup={(e) => endLongPress(e, card.id)}
            onpointercancel={(e) => endLongPress(e, card.id)}
            onpointerleave={(e) => endLongPress(e, card.id)}
            onlostpointercapture={(e) => endLongPress(e, card.id)}
            oncontextmenu={(e) => e.preventDefault()}
          >
            <span class="peek-card" aria-hidden="true">
              <img class="peek-back" src={componentImage('card-back')} alt="" draggable="false" />
              <img class="peek-face" src={componentImage(card.kind)} alt="" draggable="false" />
            </span>
          </button>
          {/if}
          </span>
        {/each}
      </div>
      <div
        class="tabletop-herd"
        data-table-herd={player.uid}
        class:scoring-glow={scoring?.stage === 'camels'}
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
          {#if scoring?.camelToken && scoring.camelBonusUid === player.uid}
            <span class="camel-bonus-token" data-camel-bonus-token aria-label="Camel bonus, 5 points"><TokenChip token={{ id: `camel-bonus-${player.uid}`, kind: 'camel', value: 5 }} /></span>
          {/if}
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
        <span
          class="earned bonus"
          class:peeking={revealedTokenIds.includes(token.id)}
          data-owned-token-id={token.id}
          data-owned-bonus={token.id}
          role="button"
          tabindex="-1"
          aria-label="Bonus token; hold to see its value"
          onpointerdown={(e) => startTokenPress(e, token.id)}
          onpointerup={(e) => endTokenPress(e, token.id)}
          onpointercancel={(e) => endTokenPress(e, token.id)}
          onpointerleave={(e) => endTokenPress(e, token.id)}
          onlostpointercapture={(e) => endTokenPress(e, token.id)}
          oncontextmenu={(e) => e.preventDefault()}
        ><TokenChip {token} hidden={!(revealedTokenIds.includes(token.id) || (scoring ? scoring.revealedBonus.includes(token.id) : lobby.round?.status === 'complete'))} /></span>
      {/each}
      {#if ownedTokens(player.uid).length === 0}<small>No tokens yet</small>{/if}
    </div>
  </section>
{/snippet}

{#snippet gameLog(inverted: boolean)}
  {@const side = inverted ? 'top' : 'bottom'}
  {@const latest = lobby.activity.findLast(isMove)}
  {@const open = logOpen[side]}
  <div class="corner-log" class:inverted class:open aria-label={inverted ? 'Player 1 game log' : 'Player 2 game log'} data-game-log={side}>
    <div class="log-latest" data-log-latest>
      {#if latest}
        <span><strong>{playerName(latest.actorUid)}</strong> {activityDescription(latest)}</span>
      {:else}
        <span>Game log</span>
      {/if}
      {#if !open}
        <button type="button" class="log-toggle" aria-label="Show the full game log" onclick={() => (logOpen = { ...logOpen, [side]: true })}>+</button>
      {/if}
    </div>
    {#if open}
      <div class="log-panel" data-log-panel>
        <div class="log-head">
          <strong>Game log</strong> <span>{lobby.activity.length}</span>
          <button type="button" class="log-toggle" aria-label="Hide the game log" onclick={() => (logOpen = { ...logOpen, [side]: false })}>−</button>
        </div>
        <ol use:scrollToEnd>
          {#each lobby.activity as activity (activity.id)}
            {@const detail = activityDetail(activity)}
            <li><strong>{playerName(activity.actorUid)}</strong> {activityDescription(activity)}{#if detail}<small>{detail}</small>{/if}</li>
          {/each}
        </ol>
      </div>
    {/if}
  </div>
{/snippet}

<svelte:head>
  <title>Jaipur Tabletop</title>
  <meta name="description" content="A shared two-player Jaipur tabletop." />
</svelte:head>

<main class="tabletop" data-e2e-tabletop data-e2e-layout style={`--market-art: url("${componentImage('card-back')}")`}>
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
  >
    <!-- Options (gear) in each player's upper-left corner of the market. -->
    {#each [2, 1] as const as gearSeat}
      {@render optionsGear(gearSeat)}
    {/each}
    <!-- The prompt's "?" faces one player; the other gets one in their own
         lower-right corner of the market, so both can open the guide. -->
    {#if lobby.round?.status === 'active'}
      {#each ([2, 1] as const).filter((s) => s !== marketFacingSeat) as helpSeat}
        <button
          type="button"
          class="help-icon help-corner"
          class:for-top={helpSeat === 1}
          class:active={tutorial?.seat === helpSeat}
          aria-label={tutorial ? 'Dismiss help' : `How to play: show the table guide for Player ${helpSeat}`}
          data-help-icon={helpSeat}
          onclick={(e) => { e.stopPropagation(); if (tutorial) dismissTutorial(); else void openTutorial(helpSeat); }}
        >?</button>
      {/each}
    {/if}
    <header>
      {#if lobby.round}
        <span>Round {lobby.round.number}</span>
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
        data-pending-sale={pendingSale?.kind}
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
        {:else if pendingSale}
          {@const preview = salePreview(pendingSale.kind)}
          {@const counts = saleCounts(pendingSale.uid, pendingSale.kind)}
          <span>Sell {preview?.cards ?? 0} {label(pendingSale.kind).toLowerCase()} for +{preview?.base ?? 0}{preview?.bonus ? ` and a +${preview.bonus} bonus token` : ''}? Tap the ✓ stack again to confirm.</span>
          {#if counts.length > 1}
            <span class="sale-counts" role="group" aria-label="How many to sell">
              {#each counts as n (n)}
                <button
                  type="button"
                  class="sale-count"
                  class:chosen={pendingSale.count === n}
                  aria-pressed={pendingSale.count === n}
                  aria-label={`Sell ${n} for ${salePoints(pendingSale.kind, n)} points`}
                  data-sale-count={n}
                  onclick={() => chooseSaleCount(n)}
                >
                  <span class="sale-count-title">Sell {n}</span>
                  <span class="sale-count-icons">{#each Array(n) as _}<img src={componentImage(pendingSale.kind)} alt="" />{/each}</span>
                  <b>+{salePoints(pendingSale.kind, n)}</b>
                </button>
              {/each}
            </span>
          {/if}
          <button type="button" disabled={busy} data-confirm-sale onclick={confirmSale}>Sell {pendingSale.count}</button>
          <button type="button" class="cancel" disabled={busy} data-cancel-sale onclick={cancelSale}>Cancel</button>
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
          {@const activeName = lobby.players.find((p) => p.uid === activeUid)?.displayName ?? 'Trader'}
          <span>
            <strong>{activeName}</strong>: take a card from the market; trade 2+ cards with the market; take all camels; or sell cards.
          </span>
          <button
            type="button"
            class="help-icon"
            class:active={Boolean(tutorial)}
            aria-label={tutorial ? 'Dismiss help' : 'How to play: show the table guide'}
            aria-pressed={Boolean(tutorial)}
            data-help-icon
            onclick={(e) => { e.stopPropagation(); if (tutorial) dismissTutorial(); else void openTutorial(marketFacingSeat); }}
          >?</button>
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
          {@const fake = tutorialFakes[marketIndex]}
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
                class:tut-hidden={fake === 'camel'}
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
                  {@const loadedCamel = round.herds[activeUid]?.some(({ id }) => id === loadedReturnId)}
                  <img
                    class:arriving={arrivingCardIds.includes(loadedReturnId)}
                    src={componentImage(loadedCamel ? 'camel' : 'card-back')}
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
                class:tut-visible={Boolean(fake) && fake !== 'camel'}
                disabled
                aria-hidden="true"
                tabindex="-1"
                data-return-seat={marketFacingSeat}
              >{#if fake && fake !== 'camel'}<span aria-hidden="true">＋</span><small>Return</small>{/if}</button>
            {/if}
          </div>
          {/snippet}
          </StableMarketLayout>
        </div>
      </div>
    {:else if lobby.round?.status === 'complete' && scoring?.stage === 'pending'}
      <!-- the closing move is still animating; the sequence starts when it lands -->
    {:else if lobby.round?.status === 'complete' && scoring && scoring.stage !== 'final'}
      <div class="scoring-overlay" data-scoring-stage={scoring.stage} aria-live="polite">
        <div class="scoring-disc-wrap">
          <div class="scoring-disc" class:compact={scoring.stage !== 'gameover'}>
            <p class="facing far">{scoring.stage === 'gameover' ? scoring.reason : scoring.tieText ?? ''}</p>
            <strong class="far">{scoring.label}</strong>
            <strong>{scoring.label}</strong>
            <p class="facing near">{scoring.stage === 'gameover' ? scoring.reason : scoring.tieText ?? ''}</p>
          </div>
        </div>
        {#if scoring.bigSeal}
          <img class="big-seal" data-result-seal src={componentImage('seal')} alt="Seal of Excellence" />
        {/if}
      </div>
    {:else if lobby.round?.status === 'complete' && (lobby.winnerUid || !demo)}
      <!-- End state, held on screen: the game's actions (or, after a reload
           mid-sequence, "Open round N") printed twice, one copy turned for
           the far seat. The scores stay on the mats; no summary screen. -->
      <div class="end-overlay" data-end-state={lobby.winnerUid ? 'game' : 'round'} style={`--fade:${scoring?.stage === 'final' ? END_FADE_MS : 500}ms`}>
        <div class="end-actions far">{@render endActions()}</div>
        <div class="end-actions near">{@render endActions()}</div>
      </div>
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
        <strong>Table options · Tabletop <span class="table-id">{gameId || '•••••'}</span></strong>
        <button type="button" onclick={() => (scalePanelOpen = false)} aria-label="Close">✕</button>
      </header>
      <div class="facing-option">
        <button
          type="button"
          class="orientation-toggle"
          aria-pressed={marketFacingEnabled}
          aria-label="Face market cards toward the active trader"
          onclick={toggleMarketFacing}
        >Turn to trader {marketFacingEnabled ? 'on' : 'off'}</button>
        <small>Rotates the market 180° so its cards and prompt face whoever's turn it is. Off by default: the market reads fine from both sides, and a phone in AR locks onto the pre-rotation capture and flips.</small>
      </div>
      <div class="facing-option">
        <button
          type="button"
          class="orientation-toggle"
          aria-pressed={showHands}
          aria-label="Show hand cards face up on the table"
          data-show-hands={showHands ? 'on' : 'off'}
          onclick={toggleShowHands}
        >Show hands {showHands ? 'on' : 'off'}</button>
        <small>Hand cards lie face up on the table. On by default against a computer opponent{showHandsChoice === 'auto' ? ' (as now)' : ''}; off with two players, whose phones show them their cards. Hold a card to peek either way.</small>
      </div>
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
        <button type="button" onclick={runAnimationDemo} disabled={Boolean(demo) || busy}>Run animation demo</button>
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

  {#if devMode}
    <div class="dev-anim top" aria-label="Animation demos, top side">
      <span>Initiate animation</span>
      <button type="button" onclick={() => demoSale(1, 'diamond', 3)}>3 diamonds</button>
      <button type="button" onclick={() => demoSale(1, 'silver', 2)}>2 silver</button>
      <button type="button" onclick={() => demoSale(1, 'leather', 5)}>5 leather</button>
    </div>
    <div class="dev-anim bottom" aria-label="Animation demos, bottom side">
      <span>Initiate animation</span>
      <button type="button" onclick={() => demoSale(2, 'diamond', 3)}>3 diamonds</button>
      <button type="button" onclick={() => demoSale(2, 'silver', 2)}>2 silver</button>
      <button type="button" onclick={() => demoSale(2, 'leather', 5)}>5 leather</button>
    </div>
  {/if}

  {#if demo}
    {@const demoLabel = `${demo.title} · Player ${demo.seat} (${demo.seat === 1 ? 'top' : 'bottom'})`}
    <div class="demo-banner" role="status" aria-live="polite">
      <strong>Demo {demo.index}/{demo.total}</strong>
      <span>{demoLabel}</span>
      <button type="button" onclick={cancelAnimationDemo}>Cancel demo</button>
    </div>
    <div class="demo-banner top" aria-hidden="true">
      <strong>Demo {demo.index}/{demo.total}</strong>
      <span>{demoLabel}</span>
      <button type="button" tabindex="-1" onclick={cancelAnimationDemo}>Cancel demo</button>
    </div>
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
      pending={pendingSale?.kind ?? null}
      onSell={(kind) => tapSell(kind, 1)}
    />
  </div>
  <div class="token-view bottom-token-view">
    <TabletopTokenMarket
      seat={2}
      round={lobby.round}
      {goods}
      {label}
      {canSell}
      pending={pendingSale?.kind ?? null}
      onSell={(kind) => tapSell(kind, 2)}
    />
  </div>

  <div class="top-log">{@render gameLog(true)}</div>
  <div class="bottom-log">{@render gameLog(false)}</div>
  <p class="table-status" class:for-top={marketFacingSeat === 1} data-status={statusKind}>{status} · Build {buildHash}</p>
  {#if tutorial}
    <!-- Table guide: fixed over the whole screen; every callout faces the
         player who asked (rotated for seat 1). A tap anywhere fades it. -->
    <div
      class="tutorial"
      class:fading={tutorial.fading}
      class:for-top={tutorial.seat === 1}
      role="button"
      tabindex="-1"
      aria-label="Table guide; tap anywhere to dismiss"
      data-tutorial={tutorial.seat}
      onpointerdown={dismissTutorial}
    >
      {#each tutorial.items as item (item.key)}
        {#if item.kind === 'card'}
          <img class="tut-card" src={componentImage(item.card ?? 'camel')} alt="" style={`left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px`} />
        {:else if item.kind === 'circle'}
          <div class="tut-circle" style={`left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px;--delay:${item.delay}ms`}><span>{@render tutLines(item.text)}</span></div>
        {:else if item.kind === 'tap'}
          <div class={`tut-tap ${item.side ?? 'below'}`} style={`left:${item.x}px;top:${item.y}px;--text-w:${item.w}px;--delay:${item.delay}ms`}>
            <span class="tut-ring" aria-hidden="true"><svg class="tut-finger" viewBox="0 0 24 24"><path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V11l1-.2V8.5a1.5 1.5 0 0 1 3 0v3l1 .1V10a1.5 1.5 0 0 1 3 0v6.5c0 3-2.5 5.5-5.5 5.5h-2.2a5 5 0 0 1-4.2-2.3l-3.4-5.4a1.5 1.5 0 0 1 2.4-1.7L9 15z" fill="currentColor" /></svg></span>
            <span class="tut-text">{@render tutLines(item.text)}</span>
          </div>
        {:else}
          <div class={`tut-pill ${item.side ?? 'above'}`} class:overview={item.title} style={`left:${item.x}px;top:${item.y}px;--delay:${item.delay}ms`}><span class="tut-text">{@render tutLines(item.text, item.title)}</span></div>
        {/if}
      {/each}
    </div>
  {/if}
  {#each cardFlights as flight (flight.key)}
    <span
      class="table-card-flight"
      class:flips={Boolean(flight.revealImage)}
      class:arc={Boolean(flight.arc)}
      class:noflip={Boolean(flight.arc) && !flight.revealImage}
      aria-hidden="true"
      style={`--start-left:${flight.startLeft}px;--start-top:${flight.startTop}px;--start-size:${flight.startSize}px;--end-left:${flight.endLeft}px;--end-top:${flight.endTop}px;--end-size:${flight.endSize}px;--flight-delay:${flight.delay}ms;--speed:${flight.speed ?? 1};--end-scale:${flight.concealsDestination ? 1 : 0.7};--arc-lift:${(flight.inverted ? -1 : 1) * Math.max(40, Math.hypot(flight.endLeft - flight.startLeft, flight.endTop - flight.startTop) * 0.25)}px`}
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
      style={`--start-left:${flight.startLeft}px;--start-top:${flight.startTop}px;--start-size:${flight.startSize}px;--end-left:${flight.endLeft}px;--end-top:${flight.endTop}px;--end-size:${flight.endSize}px;--flight-delay:${flight.delay}ms;--speed:${flight.speed ?? 1};--arc-lift:${(flight.inverted ? -1 : 1) * Math.max(40, Math.hypot(flight.endLeft - flight.startLeft, flight.endTop - flight.startTop) * 0.28)}px`}
    >{#if flight.reveal}
        <span class="token-flip"><span class="token-flip-back"><TokenChip token={flight.token} hidden /></span><span class="token-flip-front"><TokenChip token={flight.token} /></span></span>
      {:else}
        <TokenChip token={flight.token} hidden={flight.token.kind.startsWith('bonus-')} />
      {/if}</span>
  {/each}
  {#each sealFlights as flight (flight.key)}
    <span
      class="table-seal-flight"
      style={`--start-left:${flight.startLeft}px;--start-top:${flight.startTop}px;--start-size:${flight.startSize}px;--end-left:${flight.endLeft}px;--end-top:${flight.endTop}px;--end-size:${flight.endSize}px;--arc-lift:${(flight.inverted ? -1 : 1) * Math.max(40, Math.hypot(flight.endLeft - flight.startLeft, flight.endTop - flight.startTop) * 0.2)}px`}
    ><img src={componentImage('seal')} alt="" /></span>
  {/each}
  {#each saleSummaries as summary (summary.key)}
    <span
      class="sale-summary"
      class:inverted={summary.inverted}
      aria-hidden="true"
      style={`--left:${summary.left}px;--top:${summary.top}px;--speed:${summary.speed ?? 1}`}
    >
      <span class="sale-coins">{#each Array(summary.count) as _, i}<i style={`--i:${i}`}></i>{/each}</span>
      <strong>{summary.label ?? `${summary.cards} card${summary.cards === 1 ? '' : 's'} sold!`}</strong>
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
  button { font: inherit; }
  button:focus-visible { outline: 3px solid #d38b21; outline-offset: 2px; }
  .tabletop {
    --rail-width: clamp(8.5rem, 14vw, 24rem);
    /* Player mats keep their 25vh height but are 78% of the column wide,
       so the market pattern shows on either side of them. */
    --edge-size: minmax(0, 25vh);
    --hand-card-size: clamp(3.4rem, 8.4vh, 10rem);
    --mat-width: 78%;
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-columns: var(--rail-width) minmax(0, 1fr) var(--rail-width);
    grid-template-rows: var(--edge-size) minmax(0, 1fr) var(--edge-size);
    gap: clamp(0.25rem, 0.7vmin, 0.55rem);
    padding: clamp(0.3rem, 0.8vmin, 0.65rem);
    overflow: hidden;
    /* The market pattern is the whole table's background (the mats, rails
       and market float on it). Lighter wash than upstream: AR phones
       image-track this pattern. */
    background-image: linear-gradient(rgb(255 250 238 / 62%), rgb(255 250 238 / 62%)), var(--market-art);
    background-position: center;
    background-size: auto, min(40vh, 28rem);
    background-color: #e9dcc1;
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
  /* Above the market section, so the scoring zones overhanging a mat are not painted under it. */
  .edge { position: relative; z-index: 6; width: var(--mat-width); justify-self: center; }
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
    padding: clamp(0.3rem, 0.7vmin, 0.55rem) clamp(1.2rem, 2.6vw, 2.6rem);
    border: 3px solid transparent;
    border-radius: inherit;
    transition: border-color 180ms ease, background 180ms ease;
  }
  .player-seat.active { border-color: #d38b21; background: #fff4d6; }
  .player-seat { position: relative; }
  .bot-thinking {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    border-radius: inherit;
    background: rgba(255, 244, 214, 0.45);
    pointer-events: none;
  }
  .bot-thinking .hourglass {
    height: 62%;
    width: auto;
    color: #7a3e1d;
    opacity: 0.6;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3));
    animation: hourglass-turn 1.2s ease-in-out infinite;
  }
  @keyframes hourglass-turn {
    0%, 35% { transform: rotate(0deg); }
    65%, 100% { transform: rotate(180deg); }
  }
  @media (prefers-reduced-motion: reduce) { .bot-thinking .hourglass { animation: none; } }
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
  .seat-body { display: grid; min-height: 0; grid-template-columns: minmax(0, 1fr) clamp(5rem, 9vw, 14rem); align-items: center; gap: 0.5rem; }
  .tabletop-hand { display: flex; min-width: 0; height: 100%; align-items: center; }
  .hand-cell { display: block; flex: 0 0 auto; }
  .hand-cell > .table-hand-card, .market-card {
    position: relative;
    width: var(--hand-card-size, var(--hand-card-size));
    height: var(--hand-card-size, var(--hand-card-size));
    flex: 0 0 auto;
    padding: 0.18rem;
    overflow: hidden;
    border: 2px solid #315f58;
    border-radius: 0.55rem;
    background: #183a37;
    color: white;
    object-fit: cover;
  }
  .tabletop-hand > .hand-cell + .hand-cell { margin-left: clamp(-1.1rem, -1.9vw, -0.35rem); }
  .table-hand-card, .table-herd-card { cursor: pointer; transition: transform 160ms ease, box-shadow 160ms ease; }
  .table-hand-card.ghost { display: block; visibility: hidden; border-color: transparent; background: none; }
  /* Released ghost: it has moved to the slot side and looks exactly like an
     open slot, so swapping it for a real slot later is invisible. */
  .table-hand-card.ghost.as-slot { visibility: visible; border: 2px dashed #b7aa8d; border-right: none; border-radius: 0.55rem 0 0 0.55rem; opacity: 0.45; }
  /* Hold to peek: the back flips to the face for as long as the finger stays
     down (the other hand shields it); nothing is sent to the AR phones. */
  .table-hand-card { perspective: 600px; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  /* The touch target reaches 25% below the card (toward the player, in the
     seat's own frame) so a finger can hold it without covering it. Invisible;
     the card's own overflow must not clip it (the peek images round their
     own corners, so nothing else needs the clip). */
  .hand-cell > .table-hand-card { overflow: visible; }
  .hand-cell > .table-hand-card::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 25%; }
  .table-hand-card[aria-disabled='true'], .herd-pile:disabled { cursor: default; }
  .peek-card { position: relative; display: block; width: 100%; height: 100%; transform-style: preserve-3d; transition: transform 260ms ease; }
  .peek-card > img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; backface-visibility: hidden; border-radius: 0.35rem; }
  .peek-face { transform: rotateY(180deg); }
  .table-hand-card.revealed .peek-card { transform: rotateY(180deg); }
  .table-hand-card.revealed { z-index: 2; box-shadow: 0 0 0 3px #ffd27a, 0 0.5rem 1rem rgb(10 32 30 / 35%); }
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
  .herd-pile { position: relative; width: clamp(5rem, 9vw, 14rem); height: var(--hand-card-size); }
  .herd-pile .table-herd-card { position: absolute; padding: 0; background: none; overflow: hidden; pointer-events: none; left: calc(var(--pile-index) * clamp(0.55rem, 1.1vmin, 1.4rem)); width: var(--hand-card-size); height: var(--hand-card-size); border: 2px solid #a6442d; border-radius: 0.55rem; transform: rotate(calc((var(--pile-index) - 2) * 2deg)); }
  .herd-pile .table-herd-card.selected { transform: rotate(calc((var(--pile-index) - 2) * 2deg)) translateY(-14%); }
  .seat-tokens { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem; min-height: clamp(1.6rem, 3.6vmin, 4rem); padding: 0.15rem 0.5rem; border: 1px solid #b7aa8d; border-radius: 99rem; background: #f5ead3; font-size: clamp(0.65rem, 1.3vmin, 0.82rem); }
  .seat-tokens .earned { width: clamp(1.4rem, 3.2vmin, 3.6rem); height: clamp(1.4rem, 3.2vmin, 3.6rem); flex: 0 0 auto; }
  .seat-tokens .earned.bonus { filter: saturate(0.7); touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; cursor: pointer; }
  .seat-tokens .earned.bonus.peeking { filter: none; z-index: 2; transform: scale(1.35); box-shadow: 0 0 0 3px #ffd27a; border-radius: 50%; transition: transform 160ms ease; }
  /* Empty hand slots sit to the left of the fanned cards; only the edges
     a real card would show are drawn (top, bottom, left — the right edge
     hides under the next card). */
  .hand-slot { display: block; width: var(--hand-card-size); height: var(--hand-card-size); flex: 0 0 auto; border: 2px dashed #b7aa8d; border-right: none; border-radius: 0.55rem 0 0 0.55rem; opacity: 0.45; }
  .shared-market {
    --table-market-card-size: clamp(4rem, min(18vh, 10.5vw), 20rem);
    --table-target-height: clamp(2.7rem, 6.5vh, 7rem);
    --stable-market-gap: clamp(0.2rem, 0.5vw, 0.9rem);
    --market-edge-inset: clamp(0.9rem, 1.6vmin, 2.5rem);
    position: relative;
    grid-column: 2;
    grid-row: 2;
    min-height: 0;
    padding: clamp(0.4rem, 1vmin, 0.75rem) clamp(0.65rem, 1.5vw, 1.25rem);
    border: none;
    background: none;
    box-shadow: none;
  }
  .shared-market > header { position: absolute; z-index: 3; top: var(--market-edge-inset); left: 50%; display: flex; min-height: 36px; align-items: center; justify-content: center; gap: clamp(0.6rem, 2vw, 3rem); font-size: clamp(0.7rem, 1.5vmin, 1.5rem); transform: translateX(-50%); }
  .shared-market[data-market-facing-seat='1'] > header { top: auto; bottom: var(--market-edge-inset); transform: translateX(-50%) rotate(180deg); }
  .shared-market[data-market-facing-seat='1'] :global(.score-review) { padding-top: 0.5rem; padding-bottom: calc(var(--market-edge-inset) + 1.6rem); }
  /* Each player's gear sits at their own edge of the market, on their left. */
  .options-gear { position: absolute; z-index: 3; bottom: var(--market-edge-inset); left: var(--market-edge-inset); }
  .options-gear.for-top { bottom: auto; left: auto; top: var(--market-edge-inset); right: var(--market-edge-inset); transform: rotate(180deg); }
  .scale-panel .table-id { letter-spacing: 0.14em; }
  .scale-panel .facing-option { display: flex; align-items: center; gap: 0.6rem; margin: 0.6rem 0; }
  .scale-panel .facing-option small { flex: 1; line-height: 1.25; color: #5d5240; }
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
  .bot-seat-buttons { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; }
  .bot-seat-button small { display: block; font-weight: 400; font-size: 0.75em; opacity: 0.75; }
  .bot-seat-button { min-height: 44px; padding: 0.4rem 0.9rem; border: 1px solid #8e826b; border-radius: 99rem; background: #fff; font: inherit; font-weight: 700; color: #183a37; }
  .rejoin { display: inline-flex; align-items: center; gap: 0.4rem; }
  .rejoin img { width: clamp(3.4rem, 8vh, 7rem); aspect-ratio: 1; border: 2px solid #0d2622; border-radius: 0.4rem; }
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
  /* Table guide stand-ins: a camel drawn over a good loses its return area; a good drawn over a camel gains one. */
  .table-exchange-target.tut-hidden { visibility: hidden; }
  .target-placeholder.tut-visible { visibility: visible; }
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
  .corner-log { position: relative; width: min(20rem, 30vw); }
  .log-latest { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.35rem 0.4rem 0.35rem 0.7rem; border: 1px solid #8e826b; border-radius: 99rem; background: #fffaf0; box-shadow: 0 0.2rem 0.5rem rgb(10 32 30 / 24%); font-size: 0.78rem; }
  .log-latest > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-toggle { display: grid; width: 2rem; height: 2rem; flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: 99rem; background: #315f58; color: white; font: inherit; font-size: 1.1rem; font-weight: 900; line-height: 1; cursor: pointer; }
  /* The full log opens over the table (upward from the bottom corner, downward from the rotated top one): taller and narrower than the pill, scrolling when long. */
  .log-panel { position: absolute; right: 0; bottom: calc(100% + 0.35rem); z-index: 1; display: grid; width: 100%; max-height: min(72vh, 40rem); grid-template-rows: auto minmax(0, 1fr); border: 1px solid #8e826b; border-radius: 0.7rem; background: #fffaf0; box-shadow: 0 0.7rem 1.2rem rgb(10 32 30 / 24%); }
  .corner-log.inverted .log-panel { top: calc(100% + 0.35rem); right: auto; bottom: auto; left: 0; }
  .log-head { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.4rem 0.4rem 0.7rem; border-bottom: 1px solid #e4d8bd; font-size: 0.75rem; }
  .log-head span { display: grid; min-width: 1.4rem; min-height: 1.4rem; place-items: center; border-radius: 99rem; background: #315f58; color: white; font-weight: 700; }
  .log-head .log-toggle { margin-left: auto; }
  .corner-log ol { min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 0.55rem; list-style: none; }
  .corner-log li { padding: 0.22rem 0.3rem; border-radius: 0.25rem; background: #f2e8d3; font-size: 0.7rem; }
  .corner-log li small { display: block; margin-top: 0.1rem; font-size: 0.62rem; color: #5d5240; }
  .corner-log li + li { margin-top: 0.18rem; }
  /* The "?" floating to the right of the prompt pill; while the guide shows it carries a small × to dismiss. */
  .help-icon { position: absolute; left: calc(100% + 0.45rem); top: 50%; display: grid; width: 2.3rem; height: 2.3rem; place-items: center; padding: 0; border: 2px solid #fffaf0; border-radius: 50%; background: #2b6cd4; color: #fff; font: inherit; font-size: 1.25rem; font-weight: 900; line-height: 1; box-shadow: 0 0.2rem 0.6rem rgb(10 32 30 / 35%); transform: translateY(-50%); cursor: pointer; }
  .help-corner { left: auto; top: auto; right: var(--market-edge-inset); bottom: var(--market-edge-inset); z-index: 3; transform: none; }
  .help-corner.for-top { right: auto; bottom: auto; left: var(--market-edge-inset); top: var(--market-edge-inset); transform: rotate(180deg); }
  .help-icon.active::after { content: '×'; position: absolute; right: -0.35rem; top: -0.35rem; display: grid; width: 1.1rem; height: 1.1rem; place-items: center; border-radius: 50%; background: #a6442d; color: #fff; font-size: 0.8rem; line-height: 1; }
  .tutorial { position: fixed; inset: 0; z-index: 60; background: rgb(24 58 55 / 12%); transition: opacity 650ms ease; cursor: pointer; }
  .tutorial.fading { opacity: 0; pointer-events: none; }
  .tutorial > * { position: absolute; translate: -50% -50%; }
  .tutorial.for-top .tut-circle, .tutorial.for-top .tut-tap, .tutorial.for-top .tut-pill { rotate: 180deg; }
  .tut-card { border: 2px solid #315f58; border-radius: 0.55rem; object-fit: cover; box-shadow: 0 0.4rem 1rem rgb(10 32 30 / 35%); }
  .tut-circle, .tut-tap, .tut-pill { animation: tut-grow 1250ms cubic-bezier(0.2, 0.9, 0.3, 1.25) var(--delay) both, tut-glow 1800ms ease-in-out calc(var(--delay) + 1250ms) infinite; }
  /* Text sits in the blue: a translucent blue body (the piece shows through) with opaque white text. */
  .tut-text { display: block; padding: 0.35rem 0.55rem; border-radius: 0.7rem; background: rgb(43 108 212 / 62%); color: #fff; font-size: clamp(0.7rem, 1.4vmin, 1.1rem); font-weight: 700; line-height: 1.5; text-align: left; box-shadow: 0 0.3rem 0.8rem rgb(10 32 30 / 35%); }
  /* The deck circle carries its text directly. */
  .tut-circle { border: 3px solid #2b6cd4; border-radius: 50%; background: rgb(43 108 212 / 62%); color: #fff; text-align: center; box-shadow: 0 0.3rem 0.8rem rgb(10 32 30 / 35%); }
  .tut-circle span { position: absolute; left: 50%; top: 50%; width: 120%; translate: -50% -50%; font-size: clamp(0.7rem, 1.4vmin, 1.1rem); font-weight: 700; line-height: 1.5; }
  /* The tap ring: half again the "?" icon, a bright white finger; its text hangs below and to the right. */
  .tut-tap { width: 0; height: 0; }
  .tut-ring { position: absolute; left: 50%; top: 50%; display: grid; width: 3.45rem; height: 3.45rem; place-items: center; border: 2px solid #fffaf0; border-radius: 50%; background: rgb(43 108 212 / 85%); translate: -50% -50%; box-shadow: 0 0 0 0.4rem rgb(43 108 212 / 25%), 0 0.2rem 0.6rem rgb(10 32 30 / 35%); }
  .tut-finger { width: 2.1rem; height: 2.1rem; color: #fff; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 45%)); }
  .tut-tap .tut-text { position: absolute; left: 1.2rem; top: 1.2rem; width: var(--text-w, 12rem); }
  .tut-tap.above .tut-text { top: auto; bottom: 1.2rem; }
  .tut-tap.left .tut-text { left: auto; right: 1.2rem; }
  .tut-pill { display: grid; width: max-content; max-width: clamp(12rem, 30vmin, 24rem); }
  .tut-pill .tut-text { border-radius: 99rem; text-align: center; }
  /* The overview: an oversized pill above the deck, reaching into the other player's side. */
  .tut-pill.overview { max-width: min(54rem, 70vw); }
  .tut-pill.overview .tut-text { padding: 0.7rem 1.4rem; border-radius: 1.6rem; font-size: clamp(0.85rem, 1.9vmin, 1.5rem); text-align: left; }
  .tut-title { display: block; margin-bottom: 0.2em; font-family: 'Cormorant Garamond', serif; font-size: 1.35em; letter-spacing: 0.04em; text-align: center; }
  .tut-finger.inline { display: inline-block; width: 1.1em; height: 1.1em; vertical-align: -0.2em; margin: 0 0.15em; }
  .tut-pill.over { translate: -50% -50%; }
  .tut-pill.above { translate: -50% -100%; }
  .tutorial.for-top .tut-pill.above { translate: -50% 0; }
  .tut-pill.right { translate: -25% -50%; }
  .tutorial.for-top .tut-pill.right { translate: -75% -50%; }
  @keyframes tut-grow { from { scale: 0; opacity: 0; } to { scale: 1; opacity: 1; } }
  @keyframes tut-glow { 0%, 100% { filter: drop-shadow(0 0 0.3rem rgb(43 108 212 / 50%)); } 50% { filter: drop-shadow(0 0 1.2rem rgb(43 108 212 / 90%)); } }
  @media (prefers-reduced-motion: reduce) { .tut-circle, .tut-tap, .tut-pill { animation: tut-grow 1ms both; } }
  /* Partial-sale choices in the prompt: n good icons and the points they earn. */
  .sale-counts { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .sale-count { display: grid; justify-items: center; gap: 0.1rem; min-height: 44px; padding: 0.25rem 0.45rem; border: 2px solid #b7aa8d; border-radius: 0.6rem; background: #fffaf0; color: #183a37; font: inherit; font-size: 0.8em; font-weight: 800; }
  .sale-count.chosen { border-color: #1d7a4a; background: #eafff0; box-shadow: 0 0 0 3px rgb(29 122 74 / 22%); }
  .sale-count-title { font-size: 0.85em; letter-spacing: 0.04em; text-transform: uppercase; color: #a6442d; }
  .sale-count-icons { display: flex; }
  .sale-count-icons img { width: 1.4em; height: 1.4em; border-radius: 0.2em; object-fit: cover; margin-left: -0.5em; box-shadow: 0 0 0 1px #fffaf0; }
  .sale-count-icons img:first-child { margin-left: 0; }
  .table-card-flight, .table-token-flight { position: fixed; z-index: 40; top: var(--start-top); left: var(--start-left); width: var(--start-size); height: var(--start-size); pointer-events: none; animation: table-flight 860ms cubic-bezier(0.2, 0.75, 0.22, 1) var(--flight-delay) both; animation-duration: calc(860ms * var(--speed, 1)); }
  .table-card-flight { perspective: 900px; }
  .table-card-flight-inner { position: absolute; inset: 0; display: block; transform-style: preserve-3d; }
  .table-card-flight.flips .table-card-flight-inner { animation: table-card-flip 860ms ease-in-out var(--flight-delay) both; animation-duration: calc(860ms * var(--speed, 1)); }
  .table-card-flight img { position: absolute; width: 100%; height: 100%; inset: 0; backface-visibility: hidden; border: 2px solid #315f58; border-radius: 0.55rem; box-shadow: 0 0.7rem 1rem rgb(0 0 0 / 28%); object-fit: cover; }
  .table-card-flight-front { transform: rotateY(180deg); }
  /* Tokens fly on an arc: `translate` carries them across, `transform`
     lifts them mid-way; the two animate independently. */
  .table-token-flight { animation: token-flight-across 1000ms cubic-bezier(0.3, 0.6, 0.35, 1) var(--flight-delay) both, token-flight-lift 1000ms ease-in-out var(--flight-delay) both; animation-duration: calc(1000ms * var(--speed, 1)); }
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
  /* ---- Round-end scoring sequence ---- */
  /* Fixed to the viewport: the disc and the big seal sit at the centre of
     the screen, not of the market section (whose header offset them). */
  .scoring-overlay { position: fixed; inset: 0; z-index: 44; display: grid; place-items: center; pointer-events: none; }
  .scoring-disc-wrap { animation: scoring-grow 1200ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
  .scoring-disc {
    display: grid; place-items: center; gap: 0.2rem; box-sizing: border-box;
    width: min(60vh, 42vw); aspect-ratio: 1; padding: 7%; border-radius: 50%;
    border: 4px solid #d38b21; background: radial-gradient(circle, #fffaf0 55%, #f2e2bf);
    box-shadow: 0 1rem 3rem rgb(10 32 30 / 35%), 0 0 0 1rem rgb(255 244 214 / 55%);
    text-align: center; transition: transform 900ms ease;
  }
  .scoring-disc.compact { transform: scale(0.62); }
  @keyframes scoring-grow { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .scoring-disc strong { font-family: 'Cormorant Garamond', serif; font-size: clamp(1.5rem, 4.6vmin, 4.2rem); line-height: 1; color: #a6442d; letter-spacing: 0.05em; }
  .scoring-disc .facing { max-width: 88%; margin: 0; font-size: clamp(0.8rem, 1.9vmin, 1.6rem); line-height: 1.25; color: #183a37; font-weight: 700; }
  .scoring-disc .far { transform: rotate(180deg); }
  .end-overlay { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; justify-content: space-between; align-items: center; padding: clamp(0.4rem, 2vmin, 1.5rem); pointer-events: none; }
  .end-actions { display: flex; gap: clamp(0.4rem, 1.5vmin, 1rem); pointer-events: auto; animation: banner-fade var(--fade, 500ms) ease both; }
  .game-winner-banner.fading { animation: banner-fade-out var(--fade, 2800ms) ease both; }
  @keyframes banner-fade-out { from { opacity: 1; transform: translate(-50%, -50%) scale(1); } to { opacity: 0; transform: translate(-50%, -50%) scale(1.06); } }
  .end-actions.far { transform: rotate(180deg); }
  .end-actions button {
    min-height: 44px; padding: 0.5em 1.3em; border: 2px solid #a6442d; border-radius: 99rem; background: #fffaf0; color: #a6442d;
    font-family: 'Cormorant Garamond', serif; font-size: clamp(1rem, 2.6vmin, 2rem); font-weight: 700; letter-spacing: 0.04em;
    box-shadow: 0 0.5rem 1.4rem rgb(10 32 30 / 30%);
  }
  .end-actions button.end-primary { background: #a6442d; color: #fffaf0; }
  .end-actions button:disabled { opacity: 0.55; }
  @keyframes banner-fade { from { opacity: 0; } to { opacity: 1; } }
  .big-seal {
    position: fixed; left: 50%; top: 50%; translate: -50% -50%; width: min(34vh, 24vw); z-index: 45;
    /* The artwork is a square image: clip it to the round seal, like the seat seals. */
    aspect-ratio: 1; border-radius: 50%; object-fit: cover;
    filter: drop-shadow(0 0 2rem #ffd27a) drop-shadow(0 0.8rem 1.6rem rgb(10 32 30 / 45%));
    animation: big-seal-grow 1350ms cubic-bezier(0.2, 0.9, 0.3, 1.25) both, big-seal-glow 2400ms ease-in-out 1350ms infinite;
  }
  @keyframes big-seal-grow { from { transform: scale(0) rotate(-120deg); opacity: 0; } to { transform: scale(1) rotate(0deg); opacity: 1; } }
  @keyframes big-seal-glow { 0%, 100% { filter: drop-shadow(0 0 1.2rem #ffd27a) drop-shadow(0 0.8rem 1.6rem rgb(10 32 30 / 45%)); } 50% { filter: drop-shadow(0 0 3rem #ffe9b0) drop-shadow(0 0.8rem 1.6rem rgb(10 32 30 / 45%)); } }
  .score-total {
    display: inline-grid; grid-auto-flow: column; align-items: baseline; gap: 0.15em; min-width: 2.6em; padding: 0.12em 0.55em;
    border-radius: 99rem; background: #183a37; color: #fffaf0; font-weight: 900; font-size: clamp(1rem, 2.6vmin, 2.2rem); line-height: 1.1;
  }
  .score-total small { font-size: 0.45em; font-weight: 700; opacity: 0.8; }
  /* Landing zones stack upward from the total (which stays where it is);
     they overhang the mat into the market, above everything on the table. */
  .score-stack { position: relative; display: inline-grid; justify-items: center; }
  .score-zones { position: absolute; bottom: calc(100% + 0.4rem); left: 50%; z-index: 7; display: flex; flex-direction: column-reverse; gap: 0.5rem; translate: -50% 0; }
  .score-zone {
    display: grid; grid-template-columns: auto minmax(4.4rem, 1fr) auto; align-items: center; gap: 0.7rem; box-sizing: border-box;
    min-width: clamp(18rem, 44vmin, 32rem); min-height: clamp(3.4rem, 8vmin, 6rem); padding: 0.3rem 1rem;
    border: 2px dashed #b7aa8d; border-radius: 99rem; background: rgb(255 250 240 / 88%); color: #315f58; white-space: nowrap;
    transition: border-color 300ms, background 300ms;
  }
  .score-zone.filled { border-style: solid; border-color: #d38b21; background: #fffaf0; }
  .score-zone small { font-size: clamp(1.1rem, 2.4vmin, 1.7rem); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .score-zone b { min-width: 1.6em; padding: 0.05em 0.4em; border-radius: 99rem; background: #183a37; color: #fffaf0; font-size: clamp(1.6rem, 3.8vmin, 3rem); text-align: center; }
  /* Landed tokens sit in wrapping rows at a fixed round size (like the mat's
     earned tokens), so a full zone grows taller instead of squashing them. */
  .zone-chips { display: flex; flex-wrap: wrap; justify-content: center; align-content: center; gap: 0.2rem; min-width: clamp(2.4rem, 6vmin, 4.4rem); min-height: clamp(2.4rem, 6vmin, 4.4rem); max-width: clamp(8rem, 26vmin, 20rem); }
  .zone-chip { display: block; flex: 0 0 auto; width: clamp(2.4rem, 6vmin, 4.4rem); height: clamp(2.4rem, 6vmin, 4.4rem); animation: zone-chip-land 350ms cubic-bezier(0.2, 0.9, 0.3, 1.3) both; }
  .zone-chip :global(.token-chip) { width: 100%; height: 100%; }
  @keyframes zone-chip-land { from { transform: scale(1.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .tabletop-herd.scoring-glow .herd-pile { animation: herd-glow 1400ms ease-in-out infinite; }
  @keyframes herd-glow { 0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 #ffd27a); } 50% { transform: scale(1.15); filter: drop-shadow(0 0 1.2rem #ffd27a); } }
  .tabletop-herd.scoring-glow .herd-count { transform: translateX(-50%) scale(1.7); transition: transform 750ms ease; }
  .camel-bonus-token {
    position: absolute; left: 50%; top: 50%; z-index: 5; width: clamp(3rem, 9vmin, 7rem); height: clamp(3rem, 9vmin, 7rem);
    filter: drop-shadow(0 0 1rem #ffd27a); animation: camel-bonus-grow 1200ms cubic-bezier(0.2, 0.9, 0.3, 1.3) both;
  }
  .camel-bonus-token :global(.token-chip) { width: 100%; height: 100%; }
  @keyframes camel-bonus-grow { from { transform: translate(-50%, -50%) scale(0); } to { transform: translate(-50%, -50%) scale(1); } }
  .player-seat.round-winner { border-color: #ffd27a; animation: seat-glow 1200ms ease-in-out infinite; }
  @keyframes seat-glow { 0%, 100% { box-shadow: 0 0 0 0 rgb(255 210 122 / 0); } 50% { box-shadow: 0 0 2.5rem 0.6rem rgb(255 210 122 / 85%); } }
  .round-winner-banner, .game-winner-banner {
    position: absolute; left: 50%; top: 50%; z-index: 6; padding: 0.25em 1em; border-radius: 99rem;
    background: #a6442d; color: #fffaf0; font-family: 'Cormorant Garamond', serif; font-size: clamp(1.6rem, 5vmin, 4.5rem); font-weight: 700;
    white-space: nowrap; box-shadow: 0 0.8rem 2rem rgb(10 32 30 / 40%); pointer-events: none;
    animation: banner-pop 900ms cubic-bezier(0.2, 0.9, 0.3, 1.3) both;
  }
  @keyframes banner-pop { from { transform: translate(-50%, -50%) scale(0); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
  .seat-seals.won { position: relative; z-index: 5; transform: scale(2.1); transform-origin: center; transition: transform 1350ms cubic-bezier(0.2, 0.9, 0.3, 1.2); filter: drop-shadow(0 0 1rem #ffd27a); }
  .token-flip { position: relative; display: block; width: 100%; height: 100%; transform-style: preserve-3d; animation: token-flip 1000ms ease-in-out var(--flight-delay) both; animation-duration: calc(1000ms * var(--speed, 1)); }
  .token-flip > span { position: absolute; inset: 0; display: block; backface-visibility: hidden; }
  .token-flip > span :global(.token-chip) { width: 100%; height: 100%; }
  .token-flip-front { transform: rotateY(180deg); }
  @keyframes token-flip { from { transform: rotateY(0deg); } to { transform: rotateY(180deg); } }
  @media (prefers-reduced-motion: reduce) {
    .scoring-disc-wrap, .big-seal, .camel-bonus-token, .round-winner-banner, .game-winner-banner, .tabletop-herd.scoring-glow .herd-pile, .player-seat.round-winner { animation: none; }
  }
  .seat-seals { display: inline-flex; align-items: center; gap: 0.2rem; }
  .seat-seals img { width: clamp(2rem, 5vmin, 3.6rem); height: clamp(2rem, 5vmin, 3.6rem); border-radius: 50%; object-fit: cover; filter: grayscale(1); opacity: 0.25; transition: filter 300ms, opacity 300ms; }
  .seat-seals img.earned { filter: none; opacity: 1; }
  .seat-seals img.earned.arriving { filter: grayscale(1); opacity: 0.25; transition: none; }
  .table-seal-flight { position: fixed; z-index: 45; top: var(--start-top); left: var(--start-left); width: var(--start-size); height: var(--start-size); pointer-events: none; --flight-delay: 0ms; animation: seal-flight-across 1800ms cubic-bezier(0.3, 0.6, 0.35, 1) both, seal-flight-lift 1800ms ease-in-out both; }
  .table-seal-flight img { display: block; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; filter: drop-shadow(0 0.5rem 0.6rem rgb(0 0 0 / 32%)); }
  @keyframes seal-flight-across {
    0% { translate: 0 0; width: var(--start-size); height: var(--start-size); }
    100% { translate: calc(var(--end-left) - var(--start-left)) calc(var(--end-top) - var(--start-top)); width: var(--end-size); height: var(--end-size); }
  }
  @keyframes seal-flight-lift {
    0% { transform: translateY(0) rotate(0turn); }
    45% { transform: translateY(calc(var(--arc-lift) * -1)) rotate(0.5turn); }
    100% { transform: translateY(0) rotate(1turn); }
  }
  .demo-banner { position: fixed; z-index: 35; left: 50%; bottom: 0.45rem; display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.5rem 0.35rem 0.9rem; border-radius: 99rem; background: #183a37; color: #fffaf0; font-size: clamp(0.75rem, 1.6vmin, 1.05rem); box-shadow: 0 0.3rem 0.9rem rgb(10 32 30 / 40%); transform: translateX(-50%); }
  .demo-banner strong { color: #ffd88a; letter-spacing: 0.04em; }
  .demo-banner button { min-height: 36px; padding: 0.2rem 0.7rem; border: 1px solid #ffd88a; border-radius: 99rem; background: transparent; font: inherit; font-weight: 700; color: #ffd88a; }
  .demo-banner.top { bottom: auto; top: 0.45rem; transform: translateX(-50%) rotate(180deg); }
  .sale-summary { position: fixed; z-index: 45; left: var(--left); top: var(--top); display: grid; justify-items: center; gap: 0.2rem; pointer-events: none; transform: translate(-50%, -50%); animation: sale-summary 2600ms ease-out both; animation-duration: calc(2600ms * var(--speed, 1)); }
  .sale-summary.inverted { animation-name: sale-summary-inverted; }
  .sale-summary strong { color: #c8281e; font-size: clamp(1.6rem, 5vmin, 4rem); font-weight: 900; line-height: 1; text-shadow: 0 2px 0 #fff, 0 0 12px #fff; }
  .sale-coins { display: flex; gap: 0.15rem; }
  .sale-coins i { display: block; width: clamp(0.9rem, 2.2vmin, 1.8rem); height: clamp(0.9rem, 2.2vmin, 1.8rem); border: 2px solid #c8281e; border-radius: 50%; opacity: 0.7; animation: sale-coin 1400ms ease-out both; animation-duration: calc(1400ms * var(--speed, 1)); animation-delay: calc(var(--i) * 60ms * var(--speed, 1)); }
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
  .dev-anim { position: fixed; z-index: 25; display: flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.5rem; border: 1px dashed #a6442d; border-radius: 0.6rem; background: rgb(255 244 240 / 92%); font-size: 0.7rem; }
  .dev-anim span { font-weight: 700; color: #a6442d; text-transform: uppercase; letter-spacing: 0.06em; }
  .dev-anim button { min-height: 36px; padding: 0.2rem 0.55rem; border: 1px solid #a6442d; border-radius: 99rem; background: #fff; font: inherit; font-weight: 700; color: #a6442d; }
  .dev-anim.bottom { left: calc(var(--rail-width) + 1rem); bottom: 0.4rem; }
  .dev-anim.top { right: calc(var(--rail-width) + 1rem); top: 0.4rem; transform: rotate(180deg); }
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
  /* Arc flight: the card flips where it lies (first 30%), then rises on an
     arc to its destination, resizing as it goes. Used for sales, takes,
     trades, camels and deck refills. */
  .table-card-flight.arc { animation: sale-card-across 1500ms cubic-bezier(0.35, 0.5, 0.3, 1) var(--flight-delay) both, sale-card-lift 1500ms ease-in-out var(--flight-delay) both; animation-duration: calc(1500ms * var(--speed, 1)); }
  .table-card-flight.arc .table-card-flight-inner { animation: sale-card-flip 1500ms ease-in-out var(--flight-delay) both; animation-duration: calc(1500ms * var(--speed, 1)); }
  /* Arc without a flip (camels): no initial hold. */
  .table-card-flight.arc.noflip { animation: arc-card-across-now 1200ms cubic-bezier(0.35, 0.5, 0.3, 1) var(--flight-delay) both, arc-card-lift-now 1200ms ease-in-out var(--flight-delay) both; animation-duration: calc(1200ms * var(--speed, 1)); }
  /* No flip means no back face to turn to: the inner must not rotate, or
     the card turns edge-on and disappears a third of the way along. */
  .table-card-flight.arc.noflip .table-card-flight-inner { animation: none; }
  @keyframes arc-card-across-now {
    0% { translate: 0 0; width: var(--start-size); height: var(--start-size); opacity: 1; }
    100% { translate: calc(var(--end-left) - var(--start-left)) calc(var(--end-top) - var(--start-top)); width: var(--end-size); height: var(--end-size); opacity: 0.85; }
  }
  @keyframes arc-card-lift-now {
    0% { transform: translateY(0) scale(1); }
    50% { transform: translateY(calc(var(--arc-lift) * -1)) scale(1.08); }
    100% { transform: translateY(0) scale(var(--end-scale, 0.7)); }
  }
  @keyframes sale-card-across {
    0%, 30% { translate: 0 0; width: var(--start-size); height: var(--start-size); opacity: 1; }
    100% { translate: calc(var(--end-left) - var(--start-left)) calc(var(--end-top) - var(--start-top)); width: var(--end-size); height: var(--end-size); opacity: 0.85; }
  }
  @keyframes sale-card-lift {
    0%, 30% { transform: translateY(0) scale(1); }
    65% { transform: translateY(calc(var(--arc-lift) * -1)) scale(1.08); }
    100% { transform: translateY(0) scale(var(--end-scale, 0.7)); }
  }
  @keyframes sale-card-flip {
    0% { transform: rotateY(0deg); }
    26%, 100% { transform: rotateY(180deg); }
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
