<script lang="ts">
  import '@fontsource/atkinson-hyperlegible/400.css';
  import '@fontsource/atkinson-hyperlegible/700.css';
  import '@fontsource/cormorant-garamond/700.css';
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import PieceArt from '$lib/PieceArt.svelte';
  import TokenStack from '$lib/TokenStack.svelte';
  import { initializeFirebase } from '$lib/firebase';
  import { createGameRepository, type GameRepository } from '$lib/game-repository';
  import { reduceGame, type Card, type GameState, type Token } from '$lib/jaipur-rules';
  import { isRoomCode, normalizeRoomCode } from '$lib/room-code';

  const buildHash = (import.meta.env.VITE_GIT_HASH ?? 'local').slice(0, 7);
  let gameId = $state('');
  let seat = $state<1 | 2>();
  let uid = $state('');
  let displayName = $state('');
  let repository = $state<GameRepository>();
  let game = $state<GameState>(reduceGame([]));
  let status = $state<'connecting' | 'syncing' | 'synced' | 'error'>('connecting');
  let statusText = $state('Connecting to the tabletop…');
  let busy = $state(false);

  const componentImage = (kind: 'card-back' | 'camel') => `${base}/components/${kind}.webp`;
  const player = () => game.players.find((candidate) => candidate.uid === uid);
  const isActive = () =>
    game.round?.status === 'active' && game.round.activeUid === uid && !game.pendingDraw;
  const intent = () => game.tabletopIntents[uid] ?? { selectedReturnIds: [], exchangeLoads: {} };
  const loadedReturnIds = () => Object.values(intent().exchangeLoads);
  const selectedReturnIds = () => intent().selectedReturnIds;
  const selectedCount = () => selectedReturnIds().length;
  const ownedTokens = (): Token[] => game.round ? [
    ...(game.round.ownedGoodsTokens[uid] ?? []),
    ...(game.round.ownedBonusTokens[uid] ?? [])
  ] : [];
  const tokenTotal = () => ownedTokens().reduce((total, token) => total + token.value, 0);
  const tokenStep = () => {
    const count = Math.min(ownedTokens().length, 6);
    return count <= 1 ? 0 : Math.min(1.05, 6.2 / (count - 1));
  };

  onMount(async () => {
    const params = new URLSearchParams(location.search);
    gameId = normalizeRoomCode(params.get('gameId') ?? '');
    const requestedSeat = Number(params.get('seat'));
    seat = requestedSeat === 1 || requestedSeat === 2 ? requestedSeat : undefined;
    if (!isRoomCode(gameId) || !seat) {
      status = 'error';
      statusText = 'This hand link is incomplete. Scan the QR code on the table again.';
      return;
    }
    try {
      const services = await initializeFirebase();
      uid = services.auth.currentUser?.uid ?? '';
      displayName = localStorage.getItem(`jaipur:${gameId}:${uid}:name`) ?? '';
      // Test hook: ?name=Tester&auto=1 prefills and auto-takes the seat
      // (used by scripted E2E runs; harmless for humans).
      const presetName = params.get('name');
      if (presetName) displayName = presetName.slice(0, 32);
      attach(services.db);
      status = 'synced';
      statusText = displayName ? 'Private hand connected' : 'Choose your trader name';
      if (presetName && params.get('auto') === '1') void join();
    } catch (error) {
      fail(error);
    }
  });

  function attach(db: Parameters<typeof createGameRepository>[0]) {
    const attached = createGameRepository(db, gameId, uid);
    repository = attached;
    attached.subscribe(
      (events) => game = reduceGame(events),
      fail,
      (next) => {
        status = next === 'synced' ? 'synced' : 'syncing';
        statusText = next === 'synced' ? 'Private hand connected' : 'Synchronizing hand…';
      }
    );
  }

  function fail(error: unknown) {
    status = 'error';
    statusText = error instanceof Error ? error.message : 'Could not connect this hand';
  }

  async function join() {
    if (!repository || !displayName.trim() || !seat || busy) return;
    busy = true;
    try {
      await repository.append('player/joined', { displayName: displayName.trim(), seat });
      await repository.append('player/ready', { ready: true });
      localStorage.setItem(`jaipur:${gameId}:${uid}:name`, displayName.trim());
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function publishIntent(selectedReturnIds: string[]) {
    if (!repository || !game.round || !isActive() || busy) return;
    busy = true;
    try {
      await repository.append('tabletop/intent', {
        selectedReturnIds,
        exchangeLoads: intent().exchangeLoads,
        roundNumber: game.round.number,
        turnNumber: game.round.turnNumber
      });
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  function toggle(card: Card) {
    if (!isActive() || loadedReturnIds().includes(card.id)) return;
    const selected = selectedReturnIds();
    void publishIntent(
      selected.includes(card.id)
        ? selected.filter((id) => id !== card.id)
        : [...selected, card.id]
    );
  }

  function cardLabel(card: Card): string {
    return card.kind === 'camel' ? 'Camel' : card.kind[0].toUpperCase() + card.kind.slice(1);
  }
</script>

<svelte:head>
  <title>Jaipur — Private tabletop hand</title>
  <meta name="description" content="Your private hand controller for a shared Jaipur tabletop." />
</svelte:head>

<main class="hand-controller" data-e2e-hand-controller>
  <header>
    <img src={componentImage('card-back')} alt="" />
    <div>
      <span>Tabletop {gameId || '•••••'} · Player {seat ?? '—'}</span>
      <h1>Your private hand</h1>
    </div>
    <strong class:active={isActive()}>{isActive() ? 'Your turn' : 'Watch the table'}</strong>
  </header>

  {#if !player()}
    <form onsubmit={(event) => { event.preventDefault(); void join(); }}>
      <label>
        Your trader name
        <input maxlength="32" autocomplete="name" bind:value={displayName} />
      </label>
      <button type="submit" disabled={busy || !displayName.trim()}>Take this seat</button>
      <p>Your cards stay private on this phone. All public play happens on the table.</p>
    </form>
  {:else if !game.round}
    <section class="waiting">
      <img src={componentImage('card-back')} alt="" />
      <h2>{player()?.displayName}, you are seated.</h2>
      <p>Keep this screen private. The table will deal when the other trader joins.</p>
    </section>
  {:else}
    <section class="selection-summary" aria-live="polite">
      <div>
        <span>{game.round.hands[uid]?.length ?? 0} / 7 cards</span>
        {#if game.pendingDraw}
          <strong data-pending-draw={game.pendingDraw.kind}>Draw awaiting confirmation on the table</strong>
        {:else}
          <strong>{selectedCount()} selected for the table</strong>
        {/if}
        <span>{loadedReturnIds().length} placed face-down</span>
      </div>
      <button type="button" disabled={!isActive() || selectedCount() === 0 || busy} onclick={() => publishIntent([])}>
        Clear unplaced
      </button>
    </section>

    <section class="private-tokens" aria-labelledby="private-tokens-heading" data-private-token-tray>
      <div>
        <h2 id="private-tokens-heading">Your tokens</h2>
        <strong>{ownedTokens().length} worth {tokenTotal()} points</strong>
      </div>
      {#if ownedTokens().length > 0}
        <span class="private-earned-chip-row" aria-hidden="true">
          <TokenStack
            tokens={ownedTokens().slice(-6)}
            direction="horizontal"
            usage="private"
            stepRem={tokenStep()}
          />
        </span>
      {:else}
        <span class="no-tokens">No tokens yet</span>
      {/if}
    </section>

    <section class="private-cards" aria-labelledby="private-cards-heading">
      <h2 id="private-cards-heading">Goods</h2>
      <p>Tap cards you may return or sell, then use the target or token stack on the table.</p>
      <div class="card-grid">
        {#each game.round.hands[uid] ?? [] as card}
          <button
            type="button"
            class:selected={selectedReturnIds().includes(card.id)}
            class:loaded={loadedReturnIds().includes(card.id)}
            disabled={!isActive() || busy || loadedReturnIds().includes(card.id)}
            aria-pressed={selectedReturnIds().includes(card.id) || loadedReturnIds().includes(card.id)}
            aria-label={`${selectedReturnIds().includes(card.id) ? 'Deselect' : 'Select'} ${cardLabel(card)} ${card.id}`}
            data-private-card-id={card.id}
            onclick={() => toggle(card)}
          >
            <PieceArt kind={card.kind} label={cardLabel(card)} detail={card.id} />
            {#if loadedReturnIds().includes(card.id)}<span>On table</span>{/if}
          </button>
        {/each}
      </div>
    </section>

    <section class="private-herd" aria-labelledby="private-herd-heading">
      <div>
        <h2 id="private-herd-heading">Your herd</h2>
        <strong>{game.round.herds[uid]?.length ?? 0} camels</strong>
      </div>
      <div class="camel-row">
        {#each game.round.herds[uid] ?? [] as camel, index}
          <button
            type="button"
            class:selected={selectedReturnIds().includes(camel.id)}
            class:loaded={loadedReturnIds().includes(camel.id)}
            disabled={!isActive() || busy || loadedReturnIds().includes(camel.id)}
            aria-label={`${selectedReturnIds().includes(camel.id) ? 'Deselect' : 'Select'} camel ${index + 1}`}
            aria-pressed={selectedReturnIds().includes(camel.id) || loadedReturnIds().includes(camel.id)}
            data-private-card-id={camel.id}
            onclick={() => toggle(camel)}
          >
            <img src={componentImage('camel')} alt="" />
            <span>{loadedReturnIds().includes(camel.id) ? 'On table' : index + 1}</span>
          </button>
        {/each}
      </div>
    </section>

    {#if game.round.status === 'complete'}
      <section class="round-over">
        <h2>Round complete</h2>
        <p>Review the result and open the next round on the table.</p>
      </section>
    {/if}
  {/if}

  <footer>
    <span data-status={status}>{statusText}</span>
    <span>Build {buildHash}</span>
  </footer>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html), :global(body) { min-height: 100%; margin: 0; }
  :global(body) { background: #183a37; color: #183a37; font-family: 'Atkinson Hyperlegible', sans-serif; }
  button, input { font: inherit; }
  button:focus-visible, input:focus-visible { outline: 3px solid #f0b44d; outline-offset: 2px; }
  .hand-controller { min-height: 100dvh; padding: max(0.8rem, env(safe-area-inset-top)) max(0.8rem, env(safe-area-inset-right)) max(0.7rem, env(safe-area-inset-bottom)) max(0.8rem, env(safe-area-inset-left)); background: linear-gradient(#fffaf0, #eadcbf); }
  header { display: grid; grid-template-columns: 3rem minmax(0, 1fr) auto; align-items: center; gap: 0.65rem; }
  header img { width: 3rem; height: 3rem; border-radius: 0.45rem; object-fit: cover; }
  header span { color: #a6442d; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  h1, h2 { margin: 0; font-family: 'Cormorant Garamond', serif; }
  h1 { font-size: clamp(1.55rem, 7vw, 2.25rem); }
  h2 { font-size: 1.35rem; }
  header > strong { padding: 0.35rem 0.55rem; border-radius: 99rem; background: #d8d0bc; font-size: 0.72rem; white-space: nowrap; }
  header > strong.active { background: #a6442d; color: white; }
  form, .waiting, .round-over { display: grid; max-width: 32rem; margin: 12vh auto 0; gap: 0.8rem; padding: 1rem; border: 1px solid #9e8a68; border-radius: 1rem; background: #fffaf0; box-shadow: 0 0.6rem 1.5rem rgb(0 0 0 / 18%); text-align: center; }
  form label { display: grid; gap: 0.3rem; font-weight: 700; text-align: left; }
  input { min-height: 48px; padding: 0.55rem; border: 1px solid #6e756d; border-radius: 0.5rem; }
  form button, .selection-summary button { min-height: 44px; padding: 0.55rem 0.8rem; border: 0; border-radius: 99rem; background: #a6442d; color: white; font-weight: 700; }
  button:disabled { opacity: 0.55; }
  form p, .waiting p { margin: 0; }
  .waiting > img { width: 6rem; margin: auto; border-radius: 0.7rem; }
  .selection-summary { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; margin: 0.75rem 0; padding: 0.65rem 0.75rem; border-radius: 0.75rem; background: #315f58; color: white; }
  .selection-summary > div { display: flex; flex-wrap: wrap; gap: 0.35rem 0.7rem; font-size: 0.78rem; }
  .selection-summary strong { width: 100%; font-size: 1rem; }
  .private-tokens { display: grid; min-height: 3.35rem; grid-template-columns: minmax(7.5rem, auto) minmax(0, 1fr); align-items: center; gap: 0.65rem; margin-top: 0.65rem; padding: 0.4rem 0.65rem; border: 1px solid #b7aa8d; border-radius: 0.8rem; background: #fffaf0; }
  .private-tokens > div { display: grid; gap: 0.05rem; }
  .private-tokens h2 { font-size: 1.1rem; }
  .private-tokens strong { font-size: 0.78rem; }
  .private-earned-chip-row { display: flex; min-width: 0; height: 2.7rem; align-items: center; justify-content: flex-end; overflow: hidden; padding-right: 0.15rem; }
  .private-earned-chip-row :global(.token-stack) { --token-stack-chip-size: 2.55rem; --token-stack-step: 1.05rem; }
  .no-tokens { color: #6e756d; font-size: 0.75rem; text-align: right; }
  .private-cards, .private-herd { margin-top: 0.75rem; }
  .private-cards > p { margin: 0.15rem 0 0.55rem; font-size: 0.78rem; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(5rem, 1fr)); gap: 0.5rem; }
  .card-grid button { position: relative; min-width: 0; aspect-ratio: 1; padding: 0.18rem; overflow: hidden; border: 2px solid #315f58; border-radius: 0.65rem; background: #183a37; color: white; }
  .card-grid button :global(.piece-image) { width: 100%; height: 100%; object-fit: cover; }
  .card-grid button.selected, .camel-row button.selected { border-color: #f0b44d; box-shadow: 0 0 0 3px #d38b21; transform: translateY(-0.2rem); }
  .card-grid button.loaded, .camel-row button.loaded { border-color: #315f58; filter: saturate(0.55); }
  .card-grid button > span { position: absolute; inset: auto 0 0; padding: 0.25rem; background: rgb(24 58 55 / 88%); font-size: 0.7rem; font-weight: 700; }
  .private-herd > div:first-child { display: flex; align-items: baseline; justify-content: space-between; }
  .camel-row { display: flex; min-height: 4.2rem; align-items: center; padding: 0.35rem 0; overflow-x: auto; }
  .camel-row button { position: relative; width: 4rem; height: 4rem; flex: 0 0 auto; margin-right: -0.65rem; padding: 0.12rem; border: 2px solid #a6442d; border-radius: 0.55rem; background: #fff4d6; }
  .camel-row img { width: 100%; height: 100%; border-radius: 0.4rem; object-fit: cover; }
  .camel-row span { position: absolute; right: 0.15rem; bottom: 0.15rem; display: grid; min-width: 1.25rem; min-height: 1.25rem; place-items: center; border-radius: 99rem; background: #183a37; color: white; font-size: 0.68rem; }
  footer { display: flex; justify-content: space-between; gap: 1rem; margin-top: 0.8rem; color: #315f58; font-size: 0.68rem; font-weight: 700; }
  footer [data-status='error'] { color: #a3212a; }
  @media (max-height: 600px) and (orientation: landscape) {
    .hand-controller { display: grid; grid-template-columns: minmax(0, 1fr) 12rem; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 0.5rem; }
    header, .selection-summary, footer { grid-column: 1 / 3; margin: 0; }
    .private-cards { min-height: 0; margin: 0; }
    .private-herd { margin: 0; }
    .card-grid { grid-template-columns: repeat(7, minmax(3.2rem, 1fr)); }
  }
</style>
