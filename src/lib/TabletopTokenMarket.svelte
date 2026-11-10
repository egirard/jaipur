<script lang="ts">
  import { assets as assetBase } from '$app/paths';
  import TokenChip from '$lib/TokenChip.svelte';
  import TokenStack from '$lib/TokenStack.svelte';
  import { bonusValueRange, type Good, type RoundState } from '$lib/jaipur-rules';

  let {
    seat,
    round,
    goods,
    inverted = false,
    label,
    canSell,
    pending = null,
    pendingCounts = [],
    onSell,
    onCancel
  }: {
    seat: 1 | 2;
    round: RoundState | null;
    goods: Good[];
    inverted?: boolean;
    label: (kind: Good) => string;
    canSell: (kind: Good) => boolean;
    /** The good whose sale is staged (first tap): its stack shows a ✓ and an ✕. */
    pending?: Good | null;
    /** The legal card counts of the staged sale (full sale last): those
     *  coins glow and carry the running total; the one at a legal count
     *  sells that many when tapped. */
    pendingCounts?: number[];
    /** The second tap: on the stack (or its ✓) the full sale, on a priced coin that count. */
    onSell: (kind: Good, count?: number) => void | Promise<void>;
    /** The ✕ beside the ✓. */
    onCancel?: () => void;
  } = $props();

  // The glowing coins of a staged sale: the top `max` of the stack, each
  // with the total of selling down to it (the sale takes from the top).
  const saleMax = $derived(pendingCounts.length ? Math.max(...pendingCounts) : 0);
  const runningTotal = (tokens: RoundState['goodsTokens'][Good], n: number) => tokens.slice(0, n).reduce((sum, token) => sum + token.value, 0);
  // The stack is one button (its coins cannot be buttons of their own):
  // the tap's target says what was meant.
  function tapStack(kind: Good, event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (pending === kind) {
      if (target?.closest('[data-cancel-sale]')) { onCancel?.(); return; }
      const priced = target?.closest<HTMLElement>('[data-sale-count]');
      if (priced) { void onSell(kind, Number(priced.dataset.saleCount)); return; }
    }
    void onSell(kind);
  }

  // One wrapping row: the coins are sized so five fit the rail's width
  // side by side (see .chip), and a sixth and more wrap onto further
  // lines. They used to overlap by a fifth and split 5/4 by count, which
  // on a wide-CSS-pixel 55" screen (the rail's width is capped in rem,
  // the coins grew with vmin) ran the coins off the stack's edge. The top
  // of the stack comes first.
  const rows = (tokens: RoundState['goodsTokens'][Good]) => [tokens];
</script>

<aside
  class="token-market"
  class:inverted
  data-token-view-seat={seat}
  aria-label={`Player ${seat} token supplies`}
>
  <div class="token-market-content">
    <h2>Bonus tokens</h2>
    {#if round}
      <div class="bonus-row" aria-label="Bonus supplies">
        {#each ['3', '4', '5'] as size}
          {@const stack = round.bonusTokens[size as '3' | '4' | '5']}
          {@const range = bonusValueRange(size as '3' | '4' | '5')}
          <span class="bonus-stack" data-bonus-size={size} aria-label={`${size}${size === '5' ? '+' : ''}-card bonus tokens worth ${range.min} to ${range.max}, ${stack.length} left`}>
            <span class="bonus-pile">
              {#if stack.length > 0}
                <TokenStack tokens={stack} direction="vertical" hidden usage="supply" />
              {:else}
                <span class="empty-stack">—</span>
              {/if}
              <span class="bonus-count" data-bonus-count={size} aria-hidden="true">{stack.length}</span>
            </span>
            <small>+{range.min} to +{range.max}</small>
          </span>
        {/each}
      </div>
      {#each goods as kind}
        <button
          type="button"
          class={`rail-token ${kind}`}
          class:sellable={canSell(kind)}
          class:confirm-ready={pending === kind}
          disabled={!canSell(kind)}
          aria-label={pending === kind ? `Confirm: sell ${label(kind)} (tap a priced coin to sell fewer, ✕ to cancel)` : `Sell to ${label(kind)} token stack, ${round.goodsTokens[kind].length} left`}
          data-sale-pending={pending === kind || undefined}
          data-token-kind={kind}
          style={`--good-art: url("${assetBase}/components/${kind}.webp")`}
          onclick={(e) => tapStack(kind, e)}
        >
          {#if pending === kind}
            <span class="cancel-mark" data-cancel-sale aria-hidden="true">✕</span>
            <span class="confirm-mark" aria-hidden="true">✓</span>
          {/if}
          <span class="rail-head">
            <span class="rail-name">{label(kind)}</span>
            <span class="rail-count">{round.goodsTokens[kind].length}</span>
          </span>
          <span class="rail-chip">
            {#if round.goodsTokens[kind].length > 0}
              {#each rows(round.goodsTokens[kind]) as row}
                <span class="chip-row">
                  {#each row as token, index (token.id)}
                    {@const inSale = pending === kind && index < saleMax}
                    {@const priced = inSale && pendingCounts.includes(index + 1)}
                    <span class="chip" class:in-sale={inSale} class:priced style={`--z:${row.length - index}`} data-supply-token-id={token.id} data-sale-count={priced ? index + 1 : undefined}>
                      <TokenChip {token} />
                      {#if priced}<span class="sale-price" aria-hidden="true">{runningTotal(row, index + 1)}</span>{/if}
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
    font-size: clamp(0.6rem, 1.25vmin, 1.5rem);
  }
  .bonus-stack { display: grid; justify-items: center; gap: 0.15rem; }
  .bonus-stack :global(.token-stack) {
    --token-stack-chip-size: calc(var(--chip) * 0.8);
    --token-stack-step: calc(var(--chip) * 0.12);
  }
  .bonus-stack small { font-weight: 700; white-space: nowrap; }
  .bonus-pile { position: relative; display: block; }
  /* Remaining count: the same red badge as the herd count, bottom right. */
  .bonus-count {
    position: absolute; right: -0.6em; bottom: 0.35em; z-index: 20; /* above every chip (chips use z = stack size … 1) */
    min-width: 1.7em; padding: 0.1em 0.35em; border: 2px solid #fffaf0; border-radius: 99rem;
    background: #a6442d; color: #fffaf0; font-size: clamp(0.7rem, 1.6vmin, 1.4rem); font-weight: 900;
    line-height: 1.2; text-align: center; box-shadow: 0 0.2rem 0.5rem rgb(10 32 30 / 35%);
  }
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
    container-type: inline-size; /* the coins size themselves to this width (cqw) */
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
  /* Deliberately no `.sellable` styling: a highlight on the stacks the
     active trader could sell to told the other player what their hand
     holds. The button is still disabled when a sale is impossible. */
  /* A staged sale: the same green ✓ and pulse as a market card awaiting its confirming tap. */
  .rail-token.confirm-ready { border: 3px solid #1d7a4a; box-shadow: 0 0 0 4px rgb(29 122 74 / 30%); animation: confirm-pulse 1.1s ease-in-out infinite; }
  .confirm-mark, .cancel-mark { position: absolute; right: 0.15rem; top: 0.15rem; z-index: 3; display: grid; width: 1.8em; height: 1.8em; place-items: center; border-radius: 50%; background: #1d7a4a; color: #eafff0; font-size: clamp(0.9rem, 2.4vmin, 2rem); font-weight: 900; box-shadow: 0 0.15rem 0.4rem rgb(0 0 0 / 35%); }
  /* The ✕ sits beside the ✓ (a tap anywhere else on the stack is the full sale). */
  .cancel-mark { right: calc(0.15rem + 1.8em + 0.25rem); background: #a6442d; color: #fff4f0; }
  /* The staged sale's coins, counted from the top of the stack: an outline
     and glow on each coin the full sale takes, and over every coin at a
     legal count the running total of selling that many — the same number
     the prompt's "Sell N" shows, tappable here. */
  .chip.in-sale { z-index: 2; border-radius: 50%; box-shadow: 0 0 0 3px #66ffcc, 0 0 0.6em 0.1em rgb(102 255 204 / 70%); }
  .chip.priced { cursor: pointer; }
  .sale-price { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; border-radius: 50%; background: rgb(7 17 15 / 58%); color: #eafff0; font-size: clamp(0.8rem, 2.2vmin, 2rem); font-weight: 900; text-shadow: 0 1px 2px #07110f; pointer-events: none; }
  @keyframes confirm-pulse { 0%, 100% { box-shadow: 0 0 0 4px rgb(29 122 74 / 30%); } 50% { box-shadow: 0 0 0 9px rgb(29 122 74 / 12%); } }
  .rail-head { display: flex; gap: 0.35rem; align-items: baseline; font-weight: 800; text-shadow: 0 0 4px #fffaf0, 0 0 4px #fffaf0; }
  .rail-count { padding: 0 0.4rem; border-radius: 99rem; background: #183a37; color: #fffaf0; text-shadow: none; }
  .rail-chip { display: grid; width: 100%; min-width: 0; justify-items: center; gap: 0.12rem; }
  .chip-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.12rem; }
  /* No bigger than a fifth of the stack's width (minus the gaps), so five
     coins always sit side by side without overlapping; the rest wrap. */
  .chip { position: relative; width: min(var(--chip), calc((100cqw - 0.4rem - 4 * 0.12rem) / 5)); height: min(var(--chip), calc((100cqw - 0.4rem - 4 * 0.12rem) / 5)); flex: 0 0 auto; }
  .empty-stack { font-style: italic; opacity: 0.7; }
  .empty-rail {
    align-self: center;
    grid-row: 3 / -1;
    font-size: 0.7rem;
    text-align: center;
  }
</style>
