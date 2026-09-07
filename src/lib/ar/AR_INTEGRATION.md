# AR viewer integration (jaipur ↔ AR Card Viewer API)

Attaches AR phone viewers to the tabletop (`/tt`) screen via the AR Card
Viewer protocol — JSON over a WebSocket relay, documented in the ARViewer
repo (`docs/AR-CARD-VIEWER-API.md`). `arHost.ts` is the complete protocol
client; this note maps it onto jaipur's existing structure. No ARViewer
code exists in this repo; the protocol is the license boundary (this fork
stays GPLv3, ARViewer stays separate).

## Wiring plan for `src/routes/tt/+page.svelte`

1. **Session + QRs.** Create one `ArHost` when tabletop mode starts (persist
   `ar.session` alongside the gameId so reloads keep the session). The page
   already renders per-seat hand QRs (`/hand/?gameId=…&seat=N`); add the AR
   QR per seat from `ar.viewerUrl(String(seat))` — scanning the seat's AR QR
   *is* claiming that seat in AR. A shared/spectator QR uses
   `ar.viewerUrl()`.

2. **Registration layer.** Render the static board (background, engraving,
   the QR block — no cards/tokens) to a canvas, then
   `ar.publishTracking(canvas.toDataURL('image/jpeg', 0.85), widthM)`.
   Requirements from the ARViewer tuning work: the layer must be
   feature-rich (a flat background will not lock — composite a
   high-contrast, non-repeating texture into the board art), must be exactly
   the on-screen pixels, and must be republished whenever it changes.
   `widthM` comes from a screen-diagonal setting; ARViewer's bank-card
   verification pattern (draw an ISO ID-1 outline, 85.6×54.0mm, and let the
   user match a real card) is the recommended calibration affordance.

3. **Artwork.** Render each distinct card face/back and token image once to
   data URLs (`PieceArt.svelte` / `TokenChip.svelte` visuals → offscreen
   canvas), keyed by content id (goods type, not card instance):
   `ar.publishAssets({...})`. Jaipur has ~10 distinct faces — the whole
   deck is a handful of images.

4. **Shared scene projection.** A pure function of the replayed game state
   (the event-sourced store makes this natural): market row → 5 `card`
   nodes, deck → a `stack` node with `count`, discard → `card`, token
   piles → `tile`/`stack` nodes with `count`. Positions in meters in the
   tracked-image frame (origin = image center). Call `ar.publishScene` from
   the store subscription — it self-throttles to ~12Hz.

5. **Hands.** On every hand change:
   `ar.publishSceneFor(String(seat), { nodes: handNodes })`, with hand rows
   laid out along that player's table edge. Card faces that are private go
   through `publishAssetsFor`; backs reuse the shared asset id.

6. **AR taps → game intents.** `onAction` receives
   `{action:'tap', nodeId, seat}` (seat is relay-stamped, not
   viewer-claimed). Map nodeId → the same handler the on-screen tap uses;
   validate by rules as usual. For hand cards: toggle the card's
   "ready to trade" selection in the game UX **and** republish that seat's
   scene with `glow: true` on the node — the glow in AR is always
   host-driven state, so AR and the tabletop can never disagree.

## Testing without phones

The relay is dumb and the messages are plain JSON — a scripted WebSocket
client can join as a viewer and assert on everything the host publishes
(see ARViewer's scripted relay tests for the pattern). For a visual check,
the ARViewer web viewer's lobby shows the piece count as soon as state
arrives, before entering AR.
