<script lang="ts">
  import { assets as assetBase } from '$app/paths';
  import type { Good, Token } from '$lib/jaipur-rules';

  let {
    token,
    hidden = false,
    sideRim = false
  }: {
    token: Token;
    hidden?: boolean;
    sideRim?: boolean;
  } = $props();

  const isBonus = (kind: Token['kind']) => kind.startsWith('bonus-');
  const artKind = (kind: Token['kind']): Good | 'camel' | 'card-back' => {
    if (isBonus(kind)) return 'card-back';
    if (kind === 'camel') return 'camel';
    return kind as Good;
  };
  const rimLabel = (kind: Token['kind'], value: number) =>
    hidden ? `${kind.replace('bonus-', '')}+` : String(value);
</script>

<span
  class="token-chip"
  class:hidden
  class:side-rim={sideRim}
  data-chip-kind={token.kind}
  aria-hidden="true"
>
  <img
    class="token-chip-image"
    src={`${assetBase}/components/${artKind(token.kind)}.webp`}
    alt=""
    draggable="false"
  />
  <span class="token-chip-rim">{rimLabel(token.kind, token.value)}</span>
</span>

<style>
  .token-chip {
    position: relative;
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    overflow: hidden;
    border: 0.14rem solid #f8e7b7;
    border-radius: 50%;
    background: #183a37;
    box-shadow:
      inset 0 0 0 0.12rem rgb(24 58 55 / 78%),
      0 0.16rem 0.28rem rgb(24 58 55 / 34%);
    color: white;
    container-type: size;
    isolation: isolate;
  }
  .token-chip::before {
    position: absolute;
    z-index: 2;
    inset: 0.18rem;
    border: 0.08rem dashed rgb(255 250 229 / 88%);
    border-radius: 50%;
    content: '';
    pointer-events: none;
  }
  .token-chip-image {
    position: absolute;
    z-index: 0;
    width: 100%;
    height: 100%;
    inset: 0;
    opacity: 0.94;
    object-fit: cover;
  }
  .token-chip-rim {
    position: absolute;
    z-index: 3;
    right: auto;
    bottom: -0.02rem;
    left: 50%;
    display: grid;
    width: 1.3em;
    height: 1.3em;
    padding: 0;
    place-items: center;
    border-radius: 50%;
    background: transparent;
    color: #fffbea;
    font-size: clamp(0.72rem, 34cqi, 2.6rem);
    font-weight: 700;
    line-height: 1;
    text-align: center;
    paint-order: stroke fill;
    text-shadow: 0 1px 1px rgb(0 0 0 / 72%);
    transform: translateX(-50%);
    -webkit-text-stroke: 0.035em #07110f;
  }
  .token-chip.hidden .token-chip-image {
    opacity: 0.94;
  }
  .token-chip.side-rim .token-chip-rim {
    top: 50%;
    right: -0.02rem;
    bottom: auto;
    left: auto;
    transform: translateY(-50%);
  }
</style>
