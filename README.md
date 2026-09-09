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
  still in the code; a build with Firebase config can opt back in with
  `?firebase=1`. `?new=1` (or **New table** in the AR scale panel) starts
  a fresh game.
- Tap **AR scale** in the market header to set the screen diagonal in-app,
  check it against a bank card outline, see the screen/viewport geometry
  the phones are told about, and go full screen.
- The AR viewer and relay are hosted by the ARViewer project; the QR
  codes on the table embed them.

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

The verifier runs static checks, unit and Firestore Rules tests, every
two-browser Playwright scenario against the Firebase emulators, the production
build, and whitespace checks. Scenario walkthroughs and their zero-pixel
screenshots live under `tests/e2e/`.

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

## Firebase

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
