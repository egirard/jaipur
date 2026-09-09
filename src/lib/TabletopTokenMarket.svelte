<script lang="ts">
  import { assets as assetBase } from '$app/paths';
  import TokenChip from '$lib/TokenChip.svelte';
  import TokenStack from '$lib/TokenStack.svelte';
  import type { Good, RoundState } from '$lib/jaipur-rules';

  let {
    seat,
    round,
    goods,
    inverted = false,
    label,
    canSell,
    onSell
  }: {
    seat: 1 | 2;
    round: RoundState | null;
    goods: Good[];
    inverted?: boolean;
    label: (kind: Good) => string;
    canSell: (kind: Good) => boolean;
    onSell: (kind: Good) => void | Promise<void>;
  } = $props();

  // Coins overlap slightly (the most valuable, leftmost coin on top) so a
  // stack of up to five fits on one line; six or more split into two
  // lines with the larger line on top. The top of the stack comes first.
  const rows = (tokens: RoundState['goodsTokens'][Good]) => {
    if (tokens.length <= 5) return [tokens];
    const top = Math.ceil(tokens.length / 2);
    return [tokens.slice(0, top), tokens.slice(top)];
  };
</script>

<aside
  class="token-market"
  class:inverted
  data-token-view-seat={seat}
  aria-label={`Player ${seat} token supplies`}
>
  <div class="token-market-content">
    <h2>Tokens</h2>
    {#if round}
      <div class="bonus-row" aria-label="Bonus supplies">
        {#each ['3', '4', '5'] as size}
          <span class="bonus-stack" data-bonus-size={size} aria-label={`${size}-card bonus tokens, ${round.bonusTokens[size as '3' | '4' | '5'].length} left`}>
            {#if round.bonusTokens[size as '3' | '4' | '5'].length > 0}
              <TokenStack tokens={round.bonusTokens[size as '3' | '4' | '5']} direction="vertical" hidden usage="supply" />
            {:else}
              <span class="empty-stack">—</span>
            {/if}
            <small>{size}{size === '5' ? '+' : ''} cards · {round.bonusTokens[size as '3' | '4' | '5'].length}</small>
          </span>
        {/each}
      </div>
      {#each goods as kind}
        <button
          type="button"
          class={`rail-token ${kind}`}
          class:sellable={canSell(kind)}
          disabled={!canSell(kind)}
          aria-label={`Sell to ${label(kind)} token stack, ${round.goodsTokens[kind].length} left`}
          data-token-kind={kind}
          style={`--good-art: url("${assetBase}/components/${kind}.webp")`}
          onclick={() => onSell(kind)}
        >
          <span class="rail-head">
            <span class="rail-name">{label(kind)}</span>
            <span class="rail-count">{round.goodsTokens[kind].length}</span>
          </span>
          <span class="rail-chip">
            {#if round.goodsTokens[kind].length > 0}
              {#each rows(round.goodsTokens[kind]) as row}
                <span class="chip-row">
                  {#each row as token, index (token.id)}
                    <span class="chip" style={`--z:${row.length - index}`} data-supply-token-id={token.id}>
                      <TokenChip {token} />
                    </span>
                  {/each}
                </span>
              {/each}
            {:else}
              <span class="empty-stack">sold out</span>
            {/if}
          </span>
        </button>
      {/each}
    {:else}
      <span class="empty-rail">Supplies appear when play begins.</span>
    {/if}
  </div>
</aside>

<style>
  .token-market {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid #9e8a68;
    border-radius: clamp(0.55rem, 1.3vmin, 1rem);
    background: #fffaf0;
    box-shadow: 0 0.25rem 0.8rem rgb(10 32 30 / 16%);
    /* Big chips: sized by the screen so they read from across a table. */
    --chip: clamp(1.8rem, min(5.6vmin, 3.6vw), 7rem);
  }
  .token-market-content {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto auto repeat(6, minmax(0, 1fr));
    gap: clamp(0.15rem, 0.45vmin, 0.35rem);
    padding: clamp(0.3rem, 0.65vmin, 0.55rem) 0.35rem;
  }
  .inverted .token-market-content { transform: rotate(180deg); }
  h2 {
    margin: 0;
    font-family: 'Cormorant Garamond', serif;
    font-size: clamp(1.05rem, 2.2vmin, 3rem);
    text-align: center;
  }
  /* Three face-down bonus stacks (3, 4, 5+ cards). */
  .bonus-row {
    display: flex;
    justify-content: space-evenly;
    align-items: flex-start;
    gap: 0.3rem;
    padding: 0.2rem 0;
    font-size: clamp(0.5rem, 0.9vmin, 1.2rem);
  }
  .bonus-stack { display: grid; justify-items: center; gap: 0.15rem; }
  .bonus-stack :global(.token-stack) {
    --token-stack-chip-size: calc(var(--chip) * 0.8);
    --token-stack-step: calc(var(--chip) * 0.12);
  }
  .bonus-stack small { font-weight: 700; white-space: nowrap; }
  /* One good per row: name + remaining count over the chips (rows of
     four), the good's own art behind. */
  .rail-token {
    position: relative;
    display: grid;
    min-width: 0;
    min-height: 44px;
    grid-template-rows: auto minmax(0, 1fr);
    align-items: center;
    justify-items: center;
    gap: 0.1rem;
    padding: 0.15rem 0.2rem;
    overflow: hidden;
    border: 1px solid #b7aa8d;
    border-radius: 0.6rem;
    background:
      linear-gradient(rgb(245 234 211 / 42%), rgb(245 234 211 / 42%)),
      var(--good-art) center / cover no-repeat;
    color: #183a37;
    font: inherit;
    font-size: clamp(0.6rem, 1.1vmin, 1.4rem);
    text-align: center;
    isolation: isolate;
  }
  .rail-token:disabled { opacity: 1; }
  .rail-token.sellable {
    border: 3px solid #1d7a4a;
    box-shadow: 0 0 0 3px rgb(29 122 74 / 22%);
  }
  .rail-head { display: flex; gap: 0.35rem; align-items: baseline; font-weight: 800; text-shadow: 0 0 4px #fffaf0, 0 0 4px #fffaf0; }
  .rail-count { padding: 0 0.4rem; border-radius: 99rem; background: #183a37; color: #fffaf0; text-shadow: none; }
  .rail-chip { display: grid; width: 100%; min-width: 0; justify-items: center; gap: 0.12rem; }
  .chip-row { display: flex; justify-content: center; padding-left: calc(var(--chip) * 0.22); }
  .chip { position: relative; z-index: var(--z); width: var(--chip); height: var(--chip); flex: 0 0 auto; margin-left: calc(var(--chip) * -0.22); }
  .empty-stack { font-style: italic; opacity: 0.7; }
  .empty-rail {
    align-self: center;
    grid-row: 3 / -1;
    font-size: 0.7rem;
    text-align: center;
  }
</style>
