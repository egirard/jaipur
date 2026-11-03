<script lang="ts">
  // RETIRED (2026-11-03, see DEPRECATIONS.md): the Firebase phone hand
  // controller that lived here is gone. Old QR codes and bookmarks land on
  // this notice; phones now join over the AR relay by scanning a seat QR on
  // the table and choosing "Play using phone" (or "Enter AR"). Nothing on
  // this page loads Firebase.
  import '@fontsource/atkinson-hyperlegible/400.css';
  import '@fontsource/atkinson-hyperlegible/700.css';
  import '@fontsource/cormorant-garamond/700.css';
  import { base } from '$app/paths';
</script>

<svelte:head>
  <title>Jaipur · this phone page has moved</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<main class="retired" data-hand-retired>
  <h1>Jaipur</h1>
  <h2>This phone page has moved</h2>
  <p>
    The hand controller that used to live here was retired. To play from your phone,
    scan the QR code at <strong>your seat</strong> on the table with your phone's camera,
    enter your trader name, and choose <strong>Play using phone</strong> (or <strong>Enter AR</strong>).
  </p>
  <p class="small">
    Your hand, your score and what each sale would earn appear on the phone; the table
    stays the shared view. See <a href="{base}/tt/">the tabletop</a> on the big screen.
  </p>
</main>

<style>
  :global(body) { margin: 0; background: #183a37; color: #fffaf0; font-family: 'Atkinson Hyperlegible', system-ui, sans-serif; }
  .retired { min-height: 100svh; box-sizing: border-box; padding: 2.5rem 1.5rem; display: flex; flex-direction: column; justify-content: center; gap: 0.8rem; max-width: 30rem; margin: 0 auto; }
  h1 { font-family: 'Cormorant Garamond', serif; font-size: 2.6rem; letter-spacing: 0.08em; margin: 0; color: #ffd27a; }
  h2 { font-size: 1.3rem; margin: 0; }
  p { margin: 0; line-height: 1.45; }
  .small { font-size: 0.9rem; opacity: 0.8; }
  a { color: #ffd27a; }
</style>
