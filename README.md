# Jaipur

This repository contains a realtime, browser-based implementation of Jaipur,
the two-player trading card game by Sébastien Pauchon. It follows the same
architecture as the sibling `rebelprincess` project: a static SvelteKit client,
anonymous Firebase rooms, an append-only Firestore event stream, deterministic
replay, and browser-level tracer bullets verified with Playwright.

See [RULES.md](RULES.md) for the implementation-oriented rules summary and
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the proposed architecture,
commit contract, and vertical-slice sequence.

## Product

- Exactly two players per game.
- Private hands and bonus values in the trustworthy UI.
- A shared five-card market, visible goods supplies, and visible turn history.
- Complete best-of-three play: the first trader to earn two Seals of Excellence
  wins.
- Reconnect and replay from the complete immutable event history.
- Keyboard-, touch-, phone-, tablet-, and desktop-friendly play.

## Play

Open [the live game](https://anicolao.github.io/jaipur/), enter your trader
name, and create the room. The game automatically reserves an uppercase
five-letter code and places it in the invite URL. Share that URL with your
rival; they enter their name and join. Both players then mark themselves ready
and the host opens the first round.

For a shared touch table, open [tabletop mode](https://anicolao.github.io/jaipur/tt/).
Each load reserves a fresh game and displays one seat-specific QR code at each
end of the table. Both players scan the code nearest them and choose a name on
their phones; each phone becomes a private hand controller while play opens
automatically on the shared screen. Hands remain face-down on the table. A
player selects private goods or camels on their phone, then taps the public
exchange targets or token supplies on the tabletop. Earned-token counts remain
visible on the table, while the chip faces and exact score appear only on the
owner's phone. Player 1's
edge and game log face the opposite side of the table, Player 2's face the
near side, and either player performs their turn directly on the tabletop.

## Technical foundation

- SvelteKit, TypeScript, Bun, and `@sveltejs/adapter-static`.
- Firebase anonymous Authentication and Cloud Firestore.
- One append-only event stream at `games/{gameId}/events/{eventId}`.
- Deterministic, versioned shuffle and reducer logic.
- Vitest for pure rules and reducer tests.
- Playwright against Firebase emulators for real two-browser E2E scenarios.
- Zero-pixel screenshot comparisons and generated scenario walkthroughs.
- GitHub Pages production and retained pull-request previews.

The Firestore design is intentionally trusted-client multiplayer. Auth and
Security Rules will provide attribution and immutable history, not server-side
move validation or cheating prevention. All game events—including hands, deck
order, herds, and bonus-token order—will be readable by both authenticated
clients. The normal client will enforce legal actions and reveal only the
information appropriate to its player.

## AR tabletop (this fork)

This fork attaches the [AR Card Viewer](https://github.com/egirard/ARViewer)
to tabletop mode: phones scan a seat's AR QR, join over the AR relay, and
see their private cards in AR, while all play happens on the table.

- Deploy with `scripts/deploy.sh` (pushes `main` and dispatches the
  workflow — push events alone have not been starting runs on this fork).
- Public tabletop: **https://egirard.github.io/jaipur/tt/?bot=1** (solitaire
  against the bot; drop `bot=1` for two seats). Set the screen size once
  with `?diag=INCHES` (remembered; default 55).
- The Firebase channel is disabled in this fork: the tabletop keeps the
  game in the browser's local storage and resumes it after a reload or
  restart (the AR table is the only writer). The Firebase repository is
  still in the code but loaded on demand: a build with Firebase config can
  opt back in with `?firebase=1`, and nothing else needs an emulator.
  `scripts/dev-ar.sh` starts only vite; set `JAIPUR_FIREBASE=1` to start
  the emulators too. `?new=1` (or **New table** in the AR scale panel)
  starts a fresh game.
- Computer opponent: each open seat offers **Play vs Apprentice** and
  **Play vs Maharaja**; a seated phone gets the same buttons in its AR
  viewer while the seat across from it is empty. The bot "thinks" for a
  random 0.5–1.5 s under a turning hourglass before it moves.
- Hold a face-down hand card to peek at it on the table (shield it with
  your other hand); the AR phones are not told.
- The gear in each player's upper-left corner of the market opens **Table
  options**: the tabletop id, the screen diagonal (check it against a bank
  card outline), the screen/viewport geometry the phones are told about,
  full screen, a new table, the animation demo, and **Turn to trader**
  (rotate the market toward the active player; off by default because a
  phone in AR locks onto the pre-rotation capture and flips).
- A phone without WebXR (iPhone) can **Play using phone**: its hand,
  bonus values and the market as a plain page from the same relay.
- Round end plays out as a staged sequence: a "Game over" disc with the
  reason facing each player, goods tokens then bonus tokens (flipping to
  their values) flying up to each player's running score, glowing herds
  with a +5 for the larger one, tie-break text, a "Round winner" glow, a
  huge Seal of Excellence that shrinks into the winner's seat, and either
  the next round opening by itself or "N wins the game!" and **Play again**.
- The AR viewer and relay are hosted by the ARViewer project; the QR
  codes on the table embed them. Each seat QR carries its own bearer token
  (`seat=1-XXXXXXXX`), so a phone that scanned one seat cannot read the
  other's hand; the tokens are remembered per session, so a reload keeps the
  printed QRs valid. The join mat says whether the table is connected to the
  relay, and a second table window that joins the same session takes it over
  (the first one says so and stops).

### LAN-only play

The whole connectivity story — session and seat tokens, what flows over the
relay, presence and recovery, endpoint resolution, the LAN stand-in and the
deprecated Firebase channel — is in [docs/CONNECTIVITY.md](docs/CONNECTIVITY.md).
In short:

The table cannot learn its own LAN address — a browser page has no way to —
so for play without internet the two addresses have to be provided once.
Everything else already works offline: the game lives in the table's
browser and the phones talk only to the relay.

1. On a laptop on the same Wi-Fi, run the ARViewer server with its
   self-signed certificate (`npm run certs && npm start` in the ARViewer
   checkout; it serves the viewer and the relay on `https://LAPTOP:8443`).
   WebXR needs HTTPS, so each phone accepts the certificate once.
2. Enter `LAPTOP:8443` as the **LAN server** in Table options. The table
   keeps using the hosted relay and switches to the LAN server only when
   that relay cannot be reached (no internet); if nothing is set at that
   moment, the market header asks for it. **Use now** switches at once.
   To make a LAN pair the primary instead, open the table once with
   `/tt/?relay=LAPTOP:8443&viewer=LAPTOP:8443` (remembered; `?relay=default`
   forgets) or bake it into a build with `VITE_AR_RELAY_URL` and
   `VITE_AR_VIEWER_URL`; Table options shows which pair is in use and why.
3. Alternatively serve the table's own build from that server (copy or
   link `build/` into the ARViewer server's `public/` directory and open
   `https://LAPTOP:8443/<dir>/tt/`): the table probes its origin's
   `/inspect`, recognises the ARViewer server, and uses `/ws` and `/viewer/`
   beside itself with nothing to type. The seat QRs carry the relay address
   either way, so phones follow automatically.

### Play improvements (this fork)

Tabletop-play changes layered on upstream, all in `src/routes/tt/`:

- **Camel pile is one tap target**: each tap stages the next free camel; a
  count badge (total) and a "staged" badge sit on the pile. Placing a camel
  beside a market card re-selects the next camel, so multi-camel trades are
  one tap per market card.
- **In-place confirmation**: the card(s) about to be taken — all camels, a
  single good, or the market cards of a staged trade — get a green ✓ and a
  pulse; tapping one confirms. The prompt keeps explaining, and its
  Confirm/Undo/Trade buttons remain. **Cancel** / **Clear** abandon a
  partly staged trade.
- **Token supplies**: each good shows its art behind larger chips (two rows
  of five when there are more than five), and — when the active trader can
  sell it — a green **+N** preview (top tokens for the cards in hand, plus
  the bonus range for 3/4/5 cards), with the chips that would be earned
  outlined.
- **Sale celebration**: tokens arc to the seller's zone, then coin outlines
  and a large red "+N!" rise and fade from it (bonus values stay hidden:
  "+bonus").
- **AR card faces** use the game's card icons with a large outlined label;
  hand cards are published at the table's smaller hand-card size.
- **AR scale** control is a gear icon with the diagonal and arrows.

## Development

The complete rules loop is implemented: two traders can create and join a
room, play deterministic rounds through every take, exchange, and sale action,
score seals, complete a best-of-three match, and rematch. The client caches the
immutable event stream for immediate replay, recovers after network loss, and
surfaces stale, conflicting, or incompatible events without applying them.

Install dependencies and run the same verification contract used by the Git
hooks and CI:

```sh
bun install --frozen-lockfile
bun run verify:change
```

The Nix shell provides the pinned toolchain when Nix is available:

```sh
nix develop --command bun run verify:change
```

The verifier runs static checks, the unit tests, the production build and
whitespace checks; it needs no Firebase emulator. The Firestore rules tests
and the two-browser Playwright scenarios belong to the deprecated Firebase
channel and run on request with `bun run verify:legacy` (Java 21+ for the
emulators; see [DEPRECATIONS.md](DEPRECATIONS.md) for their state). Scenario
walkthroughs and their screenshots live under `tests/e2e/`.

## Accessibility and installation

Every game action uses native keyboard-operable controls with visible focus,
pressed states, text instructions, and touch targets of at least 44 CSS pixels.
Turn and connection changes are announced to assistive technology. The layout
accounts for device safe areas, honours reduced-motion preferences, and is
continuously checked for clipping and overlapping controls at phone portrait,
phone landscape, tablet, and desktop sizes. Every tested game, lobby, score,
and conflict state fits inside its viewport without document scrolling.

Cards, goods tokens, bonus tokens, camel markers, deck backs, and seals all use
an original generated gouache component system. See [ASSETS.md](ASSETS.md) for
the source prompts, inventory, and usage map.

On a turn, clicking a goods card takes it and clicking any market camel takes
the complete camel group. Each market good has camel and hand-card exchange
destinations beneath it. Returns can be routed by selecting either end first or
by dragging a hand card onto a card-back destination with a mouse, pen, or
touch gesture, then a legal multi-card trade is confirmed as one action. Cards
keep one square physical footprint between the market and either hand; crowded
hands overlap instead of shrinking the cards. Hand cards can also be selected and sold by
clicking their matching token stack; clicking a stack with no selection sells
all legal cards of that kind.

The static site includes a web app manifest and original scalable icon, so
supporting browsers can install it from the production URL. The game remains a
networked experience; installation does not make Firebase multiplayer
available without a connection, though an opened game can be viewed from its
local replay cache while disconnected.

## Firebase (deprecated)

The Firebase channel is deprecated as of 2026-10-30 and will be removed: the
AR tabletop keeps the game in the browser's local store and the phones join
over the AR relay, so nothing in the supported flow touches Firebase. The
notes below describe the legacy two-browser game and `/hand` controller while
they remain in the tree — see [DEPRECATIONS.md](DEPRECATIONS.md).

- Project: `jaipur-20260730`
- Web app: `Jaipur Web`
- Authentication: anonymous sign-in
- Database: Cloud Firestore in `nam5`
- Production rules: authenticated, own-UID, append-only event writes; all other
  paths denied

Firebase browser configuration is public configuration, not a secret.
Authentication and Firestore Security Rules provide attribution and immutable
history, not game-action validation or cheating prevention. Never commit
service-account credentials, private keys, Firebase CLI tokens, or production
data.

## License

Copyright (C) 2026 Alex Nicolaou. Licensed under the GNU General Public
License, version 3 only. See [LICENSE](LICENSE).

## Rules source and artwork

The rules target the current Space Cowboys edition. The publisher's
[Jaipur page](https://www.spacecowboys-games.com/game/jaipur/) links the
[English rulebook](https://cdn.svc.asmodee.net/production-spacecowboys/uploads/2025/11/Rules-JAIPUR-12x17-Version-EN_BD.pdf).
`RULES.md` is an implementation summary, not a replacement for that rulebook.

Published illustrations, logos, card layouts, and trade dress are reference
material only. Browser assets must be original or appropriately licensed while
preserving the game's necessary information hierarchy and component
distinctions.
