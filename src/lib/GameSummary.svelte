<script lang="ts">
  import TokenChip from '$lib/TokenChip.svelte';
  import type { GameState, Good, Token } from '$lib/jaipur-rules';
  import { describeTieBreak } from '$lib/score-summary';

  type SummaryAsset = Good | 'camel' | 'seal' | 'card-back';

  let {
    lobby,
    componentImage,
    busy = false,
    offline = false,
    onNextRound,
    onRematch
  }: {
    lobby: GameState;
    componentImage: (kind: SummaryAsset) => string;
    busy?: boolean;
    offline?: boolean;
    onNextRound?: () => void;
    onRematch?: () => void;
  } = $props();

  const playerName = (uid: string) => lobby.players.find((player) => player.uid === uid)?.displayName ?? 'Unknown trader';
  const isMatchComplete = () => Boolean(lobby.winnerUid);
  const actionDisabled = () => busy || offline;
  const tokenName = (token: Token) => token.kind.startsWith('bonus-')
    ? `${token.kind.replace('bonus-', '')}-card bonus token worth ${token.value}`
    : `${token.kind[0].toUpperCase()}${token.kind.slice(1)} token worth ${token.value}`;
  const currentTieBreak = $derived(lobby.round ? describeTieBreak(lobby.round, lobby.players) : null);
  const winnerName = $derived(playerName(lobby.winnerUid ?? lobby.round?.winnerUid ?? ''));
  const reason = $derived(lobby.winnerUid
    ? 'Two Seals of Excellence decide the match.'
    : lobby.round?.endReason === 'three-empty-supplies'
      ? 'Three goods supplies are empty.'
      : 'The deck could not completely refill the market.');
  const camelToken = (uid: string): Token | null => {
    const value = lobby.round?.scores?.[uid]?.camel ?? 0;
    return value > 0 ? { id: `camel-bonus-${uid}`, kind: 'camel', value } : null;
  };
</script>

{#if lobby.round}
  <!-- Read from both sides of the table: the seal sits in the middle with the
       result facing each player; scores, reason and actions are printed
       twice, one copy turned for the far seat. -->
  <section class="score-review" aria-labelledby="round-result">
    <div class="side-column">
      <div class="facing far">{@render notes(false)}</div>
      <div class="facing near">{@render notes(true)}</div>
    </div>
    <div class="seal-column">
      <p class="facing far headline" aria-hidden="true">{@render headline()}</p>
      <img class="result-seal" src={componentImage('seal')} alt="" data-result-seal />
      <h2 id="round-result" class="facing near" class:match-winner={isMatchComplete()}>{@render headline()}</h2>
    </div>
    <div class="scores-column">
      <div class="facing far" aria-hidden="true">{@render scorecards()}</div>
      <div class="facing near">{@render scorecards()}</div>
    </div>
  </section>
{/if}

{#snippet headline()}
  {#if isMatchComplete()}
    {winnerName} wins Jaipur
  {:else}
    {winnerName} received a Seal of Excellence <small>(2 seals to win)</small>
  {/if}
{/snippet}

{#snippet notes(primary: boolean)}
  <p class="eyebrow">{isMatchComplete() ? 'Match complete' : `Round ${lobby.round?.number} complete`}</p>
  <p class="reason">{reason}</p>
  {#if currentTieBreak}
    <aside class="tie-break" data-tie-break={primary ? currentTieBreak.kind : undefined} aria-label="Tie-break result">
      <strong>Tie-break:</strong> {currentTieBreak.text}
    </aside>
  {/if}
  {#if isMatchComplete()}
    <section class="match-history" aria-label="Round history">
      <h3>Round history</h3>
      {#each lobby.rounds as completedRound}
        {@const historyTieBreak = describeTieBreak(completedRound, lobby.players)}
        <p>
          Round {completedRound.number}:
          <strong>{playerName(completedRound.winnerUid ?? '')}</strong>
          {lobby.players
            .map((player) => `${player.displayName} ${completedRound.scores?.[player.uid]?.total ?? 0}`)
            .join(' · ')}
          {#if historyTieBreak}<span class="history-tie-break">{historyTieBreak.text}</span>{/if}
        </p>
      {/each}
    </section>
    {#if onRematch}
      <button type="button" disabled={actionDisabled()} onclick={onRematch}>Start rematch</button>
    {:else}
      <p>Match complete.</p>
    {/if}
  {:else if onNextRound}
    <button type="button" disabled={actionDisabled()} onclick={onNextRound}>
      Open round {(lobby.round?.number ?? 0) + 1}
    </button>
  {:else}
    <p>Waiting for the host to open the next market…</p>
  {/if}
{/snippet}

{#snippet scorecards()}
  {#if lobby.round}
    <div class="scorecards">
      {#each lobby.players as player}
        {@const score = lobby.round.scores?.[player.uid]}
        <article class:winner={player.uid === lobby.round.winnerUid}>
          <h3>{player.displayName}</h3>
          <dl>
            <div><dt>Goods</dt><dd>{score?.goods ?? 0}</dd></div>
            <div><dt>Bonus value</dt><dd>{score?.bonus ?? 0}</dd></div>
            <div><dt>Camel bonus</dt><dd>{score?.camel ?? 0}</dd></div>
            <div><dt>Total</dt><dd>{score?.total ?? 0}</dd></div>
          </dl>
          <div class="token-ledger" data-token-ledger={player.uid}>
            <div class="token-group">
              <span class="token-group-heading">
                <strong>Goods tokens:</strong>
                <span>{score?.goodsTokenCount ?? 0} worth {score?.goods ?? 0}</span>
              </span>
              <span class="collected-tokens">
                {#each lobby.round.ownedGoodsTokens[player.uid] ?? [] as token (token.id)}
                  <span
                    class="summary-token"
                    role="img"
                    aria-label={tokenName(token)}
                    title={tokenName(token)}
                    data-collected-goods-token={token.id}
                  ><TokenChip {token} /></span>
                {:else}
                  <span class="no-tokens">none</span>
                {/each}
              </span>
            </div>
            <div class="token-group">
              <span class="token-group-heading">
                <strong>Bonus tokens:</strong>
                <span>{score?.bonusTokenCount ?? 0} worth {score?.bonus ?? 0}</span>
              </span>
              <span class="collected-tokens">
                {#each lobby.round.ownedBonusTokens[player.uid] ?? [] as token (token.id)}
                  <span
                    class="summary-token"
                    role="img"
                    aria-label={tokenName(token)}
                    title={tokenName(token)}
                    data-collected-bonus-token={token.id}
                  ><TokenChip {token} /></span>
                {:else}
                  <span class="no-tokens">none</span>
                {/each}
              </span>
            </div>
            {#if camelToken(player.uid)}
              {@const token = camelToken(player.uid)!}
              <div class="token-group camel-award">
                <span class="token-group-heading"><strong>Camel token:</strong><span>worth {token.value}</span></span>
                <span class="collected-tokens">
                  <span
                    class="summary-token"
                    role="img"
                    aria-label={tokenName(token)}
                    title={tokenName(token)}
                    data-collected-camel-token
                  ><TokenChip {token} /></span>
                </span>
              </div>
            {/if}
          </div>
          <div class="score-components">
            <span class="camel-total">
              <img src={componentImage('camel')} alt="" />
              Herd: {lobby.round.herds[player.uid]?.length ?? 0} camels
            </span>
            <span class="score-seals">
              {#each Array(2) as _, sealIndex}
                <img
                  class:earned={sealIndex < (lobby.seals[player.uid] ?? 0)}
                  src={componentImage('seal')}
                  alt=""
                />
              {/each}
              <strong>{lobby.seals[player.uid] ?? 0} / 2 seals</strong>
            </span>
          </div>
        </article>
      {/each}
    </div>
  {/if}
{/snippet}

<style>
  .score-review {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    grid-template-columns: minmax(0, 1.1fr) auto minmax(0, 1.4fr);
    align-items: center;
    /* clear the market header, whichever edge it sits on */
    /* the market header sits at the top edge (bottom when the table faces seat 1: see the tabletop page) */
    padding: calc(var(--market-edge-inset, 1rem) + 1.6rem) 0.4rem 0.5rem;
    column-gap: clamp(0.5rem, 1.5vw, 1.4rem);
    color: #183a37;
    text-align: left;
  }
  .side-column, .scores-column { display: grid; min-height: 0; align-content: center; gap: clamp(0.25rem, 0.8vmin, 0.5rem); }
  .facing.far { transform: rotate(180deg); }
  .seal-column { display: grid; justify-items: center; align-items: center; text-align: center; gap: 0.35rem; }
  .seal-column h2, .seal-column .headline { max-width: 15ch; margin: 0; font: 700 clamp(1.05rem, 2.7vmin, 1.65rem) 'Cormorant Garamond', serif; line-height: 0.95; }
  .seal-column h2 small, .seal-column .headline small { display: block; font-size: 0.6em; font-weight: 600; opacity: 0.75; }
  .result-seal {
    width: clamp(4rem, 12vmin, 7.5rem);
    height: clamp(4rem, 12vmin, 7.5rem);
    border-radius: 50%;
    object-fit: cover;
  }
  .side-column p { margin: 0.1rem 0; font-size: clamp(0.68rem, 1.5vmin, 0.9rem); }
  .eyebrow {
    color: #a6442d;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .scorecards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: clamp(0.3rem, 1vmin, 0.7rem);
    text-align: left;
  }
  .scorecards article {
    min-width: 0;
    padding: clamp(0.2rem, 0.7vmin, 0.45rem) clamp(0.3rem, 0.8vmin, 0.55rem);
    border: 2px solid #b7aa8d;
    border-radius: 0.7rem;
    background: #fffaf0;
  }
  .scorecards article.winner { border-color: #a23e2a; background: #fff0dd; }
  .scorecards h3 { margin: 0 0 0.1rem; font-size: clamp(0.78rem, 1.7vmin, 1rem); }
  .scorecards dl { margin: 0; font-size: clamp(0.54rem, 1.2vmin, 0.7rem); line-height: 1.02; }
  .scorecards dl div { display: flex; justify-content: space-between; }
  .scorecards dd { margin: 0; font-weight: 700; }
  .token-ledger { display: grid; gap: 0; margin-top: 0.1rem; }
  .token-group { display: grid; grid-template-columns: minmax(5.4rem, auto) minmax(0, 1fr); align-items: center; gap: 0.2rem; }
  .token-group-heading { display: flex; gap: 0.2rem; font-size: clamp(0.5rem, 1.05vmin, 0.6rem); line-height: 1.05; white-space: nowrap; }
  .token-group-heading > span { color: #526762; }
  .collected-tokens { display: flex; min-width: 0; flex-wrap: wrap; justify-content: flex-end; gap: 0.1rem; }
  .summary-token { display: block; width: clamp(0.95rem, 2.4vmin, 1.3rem); height: clamp(0.95rem, 2.4vmin, 1.3rem); flex: 0 0 auto; }
  .summary-token :global(.token-chip-rim) { width: 0.7rem; height: 0.7rem; font-size: clamp(0.5rem, 28cqi, 0.68rem); }
  .no-tokens { color: #526762; font-size: 0.62rem; }
  .score-components {
    display: flex;
    min-height: 0;
    flex-wrap: nowrap;
    white-space: nowrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.35rem;
    margin-top: 0.1rem;
    font-size: clamp(0.55rem, 1.2vmin, 0.66rem);
  }
  .camel-total, .score-seals { display: flex; align-items: center; gap: 0.18rem; }
  .camel-total { white-space: nowrap; }
  .camel-total img { width: 1.2rem; height: 1.2rem; border-radius: 50%; object-fit: cover; }
  .score-seals { flex-wrap: nowrap; justify-content: flex-end; }
  .score-seals img { width: 1.05rem; height: 1.05rem; border-radius: 50%; filter: grayscale(1); opacity: 0.25; object-fit: cover; }
  .score-seals img.earned { filter: none; opacity: 1; }
  .tie-break {
    margin: 0.3rem 0;
    padding: clamp(0.3rem, 1vmin, 0.6rem);
    border: 2px solid #a6442d;
    border-radius: 0.75rem;
    background: #fff0dd;
    font-size: clamp(0.62rem, 1.4vmin, 0.8rem);
  }
  .match-history {
    margin: 0.3rem 0;
    padding: clamp(0.3rem, 0.9vmin, 0.7rem);
    border-radius: 0.8rem;
    background: #e9dcc1;
    font-size: clamp(0.58rem, 1.25vmin, 0.72rem);
  }
  .match-history h3, .match-history p { margin: 0.2rem; }
  .history-tie-break { display: block; color: #7d3123; }
  .side-column button {
    min-height: 36px;
    margin-top: 0.35rem;
    padding: 0.3rem 0.8rem;
    border: 0;
    border-radius: 99rem;
    background: #a6442d;
    color: white;
    font: inherit;
    font-weight: 700;
  }
  .side-column button:disabled { cursor: not-allowed; opacity: 0.55; }
  @media (max-width: 700px) {
    .score-review { grid-template-columns: 1fr; padding-block: 2.4rem; }
    .facing.far { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .score-review *, .score-review *::before, .score-review *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
  }
</style>
