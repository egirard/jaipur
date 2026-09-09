<script lang="ts">
  import { assets as assetBase } from '$app/paths';
  import TokenChip from '$lib/TokenChip.svelte';
  import type { Good, RoundState } from '$lib/jaipur-rules';

  export type SalePreview = { cards: number; base: number; bonus: string | null };

  let {
    seat,
    round,
    goods,
    inverted = false,
    label,
    canSell,
    onSell,
    preview
  }: {
    seat: 1 | 2;
    round: RoundState | null;
    goods: Good[];
    inverted?: boolean;
    label: (kind: Good) => string;
    canSell: (kind: Good) => boolean;
    onSell: (kind: Good) => void | Promise<void>;
    /** What selling to this stack would earn right now (null when not sellable). */
    preview?: (kind: Good) => SalePreview | null;
  } = $props();

  // Chips wrap into rows of up to five so each chip can be large; the
  // top of the stack (next to be earned) comes first.
  const rows = (tokens: RoundState['goodsTokens'][Good]) => {
    const out: typeof tokens[] = [];
    for (let i = 0; i < tokens.length; i += 5) out.push(tokens.slice(i, i + 5));
    return out;
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
          <span>{size}+ <strong>{round.bonusTokens[size as '3' | '4' | '5'].length}</strong></span>
        {/each}
      </div>
      {#each goods as kind}
        {@const sale = preview?.(kind) ?? null}
        <button
          type="button"
          class={`rail-token ${kind}`}
          class:sellable={canSell(kind)}
          disabled={!canSell(kind)}
          aria-label={`Sell to ${label(kind)} token stack, ${round.goodsTokens[kind].length} left${sale ? `, earns ${sale.base}${sale.bonus ? ` plus a ${sale.bonus} bonus` : ''}` : ''}`}
          data-token-kind={kind}
          style={`--good-art: url("${assetBase}/components/${kind}.webp")`}
          onclick={() => onSell(kind)}
        >
          <span class="rail-head">
            <span class="rail-name">{label(kind)}</span>
            <span class="rail-count">{round.goodsTokens[kind].length}</span>
          </span>
          <span class="rail-chip" class:two-rows={round.goodsTokens[kind].length > 5}>
            {#if round.goodsTokens[kind].length > 0}
              {#each rows(round.goodsTokens[kind]) as row, rowIndex}
                <span class="chip-row">
                  {#each row as token, index (token.id)}
                    <span class="chip" class:taken={sale ? rowIndex * 5 + index < sale.cards : false} data-supply-token-id={token.id}>
                      <TokenChip {token} />
                    </span>
                  {/each}
                </span>
              {/each}
            {:else}
              <span class="empty-stack">sold out</span>
            {/if}
          </span>
          {#if sale}
            <span class="sale-preview" data-sale-preview={kind}>
              <strong>+{sale.base}</strong>{#if sale.bonus}<small>+{sale.bonus} bonus</small>{/if}
            </span>
          {/if}
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
  .bonus-row {
    display: flex;
    justify-content: center;
    gap: 0.18rem;
    font-size: clamp(0.5rem, 0.9vmin, 1.2rem);
  }
  .bonus-row span {
    padding: 0.12rem 0.22rem;
    border-radius: 99rem;
    background: #e9dcc1;
  }
  /* One good per row: name + remaining count, the chips (up to two rows
     of five, large), and — when a sale is possible right now — what it
     would earn. The good's own art sits faded behind it all. */
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
      linear-gradient(rgb(245 234 211 / 82%), rgb(245 234 211 / 82%)),
      var(--good-art) center / cover no-repeat;
    color: #183a37;
    font: inherit;
    font-size: clamp(0.55rem, 1vmin, 1.3rem);
    text-align: center;
    isolation: isolate;
  }
  .rail-token:disabled { opacity: 1; }
  .rail-token.sellable {
    border: 2px solid #1d7a4a;
    background:
      linear-gradient(rgb(234 255 240 / 78%), rgb(234 255 240 / 78%)),
      var(--good-art) center / cover no-repeat;
    box-shadow: 0 0 0 3px rgb(29 122 74 / 22%);
  }
  .rail-head { display: flex; gap: 0.35rem; align-items: baseline; font-weight: 700; }
  .rail-count { padding: 0 0.35rem; border-radius: 99rem; background: #183a37; color: #fffaf0; }
  .rail-chip { display: grid; width: 100%; min-width: 0; justify-items: center; gap: 0.12rem; }
  .chip-row { display: flex; justify-content: center; gap: 0.12rem; }
  .chip { width: clamp(1.6rem, 3.2vmin, 4.6rem); height: clamp(1.6rem, 3.2vmin, 4.6rem); flex: 0 0 auto; }
  .two-rows .chip { width: clamp(1.4rem, 2.7vmin, 4rem); height: clamp(1.4rem, 2.7vmin, 4rem); }
  .chip.taken { outline: 3px solid #1d7a4a; outline-offset: 1px; border-radius: 50%; }
  .empty-stack { font-style: italic; opacity: 0.7; }
  .sale-preview {
    position: absolute;
    right: 0.25rem;
    bottom: 0.15rem;
    display: grid;
    justify-items: end;
    line-height: 1;
    color: #1d7a4a;
    text-shadow: 0 1px 0 #fff, 0 0 4px #fff;
  }
  .sale-preview strong { font-size: 1.9em; }
  .sale-preview small { font-size: 0.8em; font-weight: 700; }
  .empty-rail {
    align-self: center;
    grid-row: 3 / -1;
    font-size: 0.7rem;
    text-align: center;
  }
</style>
