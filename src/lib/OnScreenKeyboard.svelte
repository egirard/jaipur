<script lang="ts">
  import { KEYBOARD_ROWS, pressKey, upperNext, type KeyboardKey } from './on-screen-keyboard';

  /** The table's own keyboard (see on-screen-keyboard.ts). It edits the
   *  bound value directly, so the text field need not keep focus; keys
   *  swallow their pointer-down so a tap never blurs the field either. */
  let {
    value,
    onInput,
    onDone,
    maxLength = 32,
    label = 'On-screen keyboard'
  }: { value: string; onInput: (next: string) => void; onDone: () => void; maxLength?: number; label?: string } = $props();

  let shift = $state(false);
  const upper = $derived(upperNext(value, shift));

  function press(key: KeyboardKey) {
    if (key.action === 'done') { onDone(); return; }
    const next = pressKey({ value, shift }, key, maxLength);
    shift = next.shift;
    if (next.value !== value) onInput(next.value);
  }
  const caption = (key: KeyboardKey) => key.action ? key.key : upper ? key.key.toUpperCase() : key.key;
</script>

<div class="osk" role="group" aria-label={label} data-on-screen-keyboard>
  {#each KEYBOARD_ROWS as row, r (r)}
    <div class="row">
      {#each row.keys as key, i (key.key)}
        <button
          type="button"
          class="key"
          class:action={Boolean(key.action)}
          class:done={key.action === 'done'}
          class:held={key.action === 'shift' && shift}
          style={`--span:${key.span};--start:${i === 0 ? row.inset + 1 : 'auto'}`}
          aria-label={key.action === 'backspace' ? 'Delete the last letter' : key.action === 'shift' ? 'Shift' : key.action === 'space' ? 'Space' : key.action === 'done' ? 'Done' : caption(key)}
          aria-pressed={key.action === 'shift' ? shift : undefined}
          data-key={key.key}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => press(key)}
        >
          {#if key.action === 'shift'}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 8h-5v8H9v-8H4z" fill={shift ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
          {:else if key.action === 'backspace'}
            <svg viewBox="0 0 28 24" aria-hidden="true"><path d="M10 4h15a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H10l-8-8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /><path d="M14 8l8 8m0-8l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          {:else if key.action === 'space'}
            <span class="word">Space</span>
          {:else if key.action === 'done'}
            <span class="word">Done</span>
          {:else}
            {caption(key)}
          {/if}
        </button>
      {/each}
    </div>
  {/each}
</div>

<style>
  /* Sized from its own width (the mat's): ten keys to a row, the key height
     a share of the width, never under a finger's 44px. */
  .osk {
    container-type: inline-size;
    display: grid;
    gap: 1.2cqw;
    padding: 1.6cqw;
    border: 1px solid #9e8a68;
    border-radius: clamp(0.55rem, 1.3vmin, 1rem);
    background: #fffaf0;
    box-shadow: 0 0.25rem 0.8rem rgb(10 32 30 / 24%);
    color: #183a37;
    font: inherit;
  }
  .row { display: grid; grid-template-columns: repeat(20, minmax(0, 1fr)); gap: 1.2cqw; }
  .key {
    grid-column: var(--start) / span var(--span);
    display: grid;
    place-items: center;
    min-width: 0;
    height: clamp(2.6rem, 6.4cqw, 5rem);
    padding: 0;
    border: 1px solid #8e826b;
    border-radius: 0.5rem;
    background: #fff;
    color: inherit;
    font: inherit;
    font-size: clamp(0.95rem, 3cqw, 2rem);
    font-weight: 700;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
  }
  .key.action { background: #e9dcc1; }
  .key.held { border-color: #d38b21; box-shadow: inset 0 0 0 2px #d38b21; }
  .key.done { background: #a6442d; border-color: #a6442d; color: #fffaf0; }
  .key svg { height: 55%; width: auto; }
  .word { font-size: 0.8em; letter-spacing: 0.04em; }
  .key:active { transform: translateY(1px); background: #fff4d6; }
  .key.done:active { background: #8f3824; }
  .key:focus-visible { outline: 3px solid #d38b21; outline-offset: 2px; }
</style>
