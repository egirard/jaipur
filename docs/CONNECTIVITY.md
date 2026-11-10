# How the phones and the table connect

The supported product is the **AR tabletop**: one browser on the table
(`/tt`) runs the whole game, and each player's phone is a window onto it.
This note is the connectivity story end to end — what talks to what, over
which link, what happens when a link breaks, and how to run it with no
internet at all. The deprecated Firebase channel is Appendix A.

## The pieces

| Piece | Where it runs | What it holds |
| --- | --- | --- |
| **Table** (`src/routes/tt/`) | the tabletop's browser | the game, as an append-only event log in that browser's localStorage (`src/lib/local-game-repository.ts`). The only writer. |
| **Relay** (ARViewer `server/server.js`) | hosted on Render by default; or a laptop on the LAN | nothing durable: per session, the table's socket, the phones' sockets, and a cache of the last thing the table published so late phones catch up |
| **Viewer** (ARViewer `public/viewer/`) | each phone's browser, loaded from GitHub Pages by default | nothing: it renders what the relay sends and sends taps back |

The table and the phones never talk to each other directly and never share
a database. Everything crosses one WebSocket relay as JSON (the AR Card
Viewer API, documented in ARViewer `docs/AR-CARD-VIEWER-API.md`). The
protocol client on the table side is `src/lib/ar/arHost.ts`; the game-aware
layer over it is `src/lib/ar/arTabletop.ts`.

## One session, two seats

- **Session code.** The table makes a six-letter session code the first time
  it runs and remembers it (`jaipur:ar:session`), so reloads keep the same
  QRs. It joins the relay as the session's one *table*.
- **Seat tokens.** Each seat's QR carries a bearer token of the form
  `1-XXXXXXXX` / `2-XXXXXXXX` (`src/lib/ar/seatTokens.ts`), an independent
  secret per seat, remembered per session. The relay treats the token as an
  opaque string; only the table maps it to a seat. A phone that scanned
  seat 1's QR cannot read seat 2's hand by editing the number.
- **Every phone is a seat.** The viewer URL is
  `viewer/?s=SESSION&relay=wss://…&seat=TOKEN&t=…`. A viewer without a seat
  is turned away by the relay (`rejected: seat-required`); there are no
  spectator phones — the table is the shared view.

## What flows

Table → relay → phones (the relay caches each of these for late joiners):

| Message | Content | When |
| --- | --- | --- |
| `tracking` | the static picture of the screen the phones register against: a down-scaled whole-screen JPEG and cut-out regions (three market-band columns for everyone, token-rail rows per seat), each with its size in metres | on attach, and whenever the static layer changes (debounced ~1.2 s) |
| `assets` | artwork by id (card faces, coin tiles); shared, plus a private set per seat | when the set changes |
| `state` | the shared scene: market cards, deck, discard, tokens, badges, as nodes positioned in metres | on every store change, throttled to ~12/s |
| `stateFor` (per seat) | that seat's private scene: hand, herd, staged pieces, sale preview (each glowing coin printed with its value), bonus values, the sale raised in the hand (`handSale`: the numbers, bonus marks and ✕ the phone draws on its cards, and `sale:` tiles standing over the cards in AR), the market band turned to face the seat (same ids as the shared pieces; private wins), who holds the seat, bot offers, turn flag, notes, buttons | on discrete events, not throttled |

Phones → relay → table (the relay stamps the phone's `viewerId` and seat
token on every action, so the table never trusts what a phone claims):

| Action | Meaning |
| --- | --- |
| `join {name}` | sit down at this seat with this trader name (a reconnecting phone re-sends it; the table answers by naming the holder in `stateFor.player`) |
| `bot {difficulty}` | seat a computer opponent across from me (only while the table lists `offers.bot`) |
| `select nodeId` | toggle one of my own cards/camels for a trade (`hand:`/`herd:` ids only) |
| `control {id}` | a host-defined button (`clear`) |
| `diag`, `regcheck` | registration diagnostics, shown on the table and kept by the relay |

The table treats every action as an *intent* and validates it exactly like
a tap on the screen; the phones only ever see the result come back through
`state`/`stateFor`.

## Presence, drops and recovery

- **Both ends retry every 1.5 s.** On reconnect the table replays its whole
  published picture (tracking, assets, shared and per-seat scenes) and each
  phone re-asserts its seat join. A relay restart or a Render spin-down is
  survived without anyone rescanning.
- **Presence per seat.** The relay tells the table which seat tokens have a
  connected phone (`peers.seats`). A seat whose player joined by phone and
  whose token has no phone shows the rejoin QR in that player's header.
  Against an older relay that only counts phones, the table falls back to
  comparing the count with the number of phone-joined seats.
- **One table per session.** A second table window joining the same
  session takes it over; the relay tells the first (`displaced`), which
  stops reconnecting and says so in the market header.
- **The table shows its own link.** The join mat caption reads
  "AR viewer · ready / N phones / connecting… / relay offline — retrying /
  relay unreachable…", and the market header carries a rust pill for
  anything that needs a person: taken over, offline, unreachable.
- **Phones' side.** A phone whose table is gone shows "No tabletop is
  connected to this session" until it returns; a phone that scanned a stale
  QR (the table was reloaded onto a new session) says to rescan.

## Where the relay and the viewer are

`src/lib/ar/arEndpoints.ts` resolves the pair once per table load, each
field on its own, in this order:

1. `?relay=` / `?viewer=` on the table's URL — remembered in that browser;
   `?relay=default` forgets.
2. The remembered values.
3. `VITE_AR_RELAY_URL` / `VITE_AR_VIEWER_URL` baked into the build.
4. The page's own origin, when the ARViewer server is serving the table
   page itself (it answers `GET /inspect` with JSON): then the relay is
   `/ws` and the viewer `/viewer/` beside it, nothing to type.
5. The hosted pair: `wss://arviewer-relay.onrender.com/ws` and
   `https://egirard.github.io/ARViewer/viewer/`.

The table embeds the resolved relay in every seat QR, so phones follow
whichever was chosen. Table options shows the pair in use and its source.

### The LAN stand-in, and playing with no internet

A browser page cannot discover its host's LAN address, so for play without
internet the address of a local ARViewer server has to be provided once.
Table options has a **LAN server** field (`HOST:8443`; the table's own
keyboard has an address layout). It is a stand-in, not a primary setting:

- The table keeps using the relay it resolved above.
- If that relay proves **unreachable** — three failed connection attempts
  before the first one ever opened, or fifteen seconds without a connection
  after it dropped — the table switches to the LAN server, re-renders the
  seat QRs with it, and re-captures the tracking image. (A hosted relay
  waking from sleep holds the connection attempt open rather than failing
  it, so it does not trip this.)
- If no LAN server is set at that moment, the market header says the relay
  is unreachable and offers **Set LAN server**, which opens Table options.
- **Save** stores the address; **Use now** switches at once (for a venue
  known to be offline). An empty field forgets it.

**Planned: the tabletop OS supplies the address.** The LAN field exists
because a browser page cannot learn its host's address. The tabletop OS
that the 55" table runs will eventually know when it has joined a new
network, and at that moment it can determine the machine's own IP address
and record it in a system variable. Once that lands, the table page should
read that variable (how it is exposed to the page is for that work to
decide — a build variable, a query parameter the kiosk launcher appends, or
a small local endpoint) and use it as the LAN stand-in in place of a typed
address, so the field becomes a manual override rather than the normal
path. Nothing here implements that yet; this note records the intent.

To run the LAN server: in the ARViewer checkout, `npm run certs && npm
start` serves the viewer and the relay on `https://LAPTOP:8443` with a
self-signed certificate. WebXR requires HTTPS, so the table's browser and
each phone accept that certificate once (open `https://LAPTOP:8443`). The
table page itself can come from the dev server, from a static copy, or be
served from that same ARViewer server (copy or link jaipur's `build/` into
its `public/`), in which case step 4 above finds the relay by itself and
the LAN field is never needed.

## Deploying

Three things deploy, each from its own push; none needs a manual redeploy.

- **Relay** (ARViewer, `server/server.js`): the Render service was created
  once as a Blueprint from `render.yaml` and auto-deploys on every push to
  ARViewer `main`, live within a few minutes. A table or phone that is
  connected rides through the restart on its 1.5 s retry (the relay keeps
  nothing durable; the table replays its picture). To confirm which relay
  version is live without a phone, join it as a seatless viewer: the current
  server answers `{type:'rejected', reason:'seat-required'}`; an older one
  answers `joined`.

  ```sh
  node -e "const ws=new (require('ws'))('wss://arviewer-relay.onrender.com/ws');ws.on('open',()=>ws.send(JSON.stringify({type:'join',role:'viewer',session:'PROBE0'})));ws.on('message',m=>{console.log(String(m));process.exit()})"
  ```

  (Free tier: if the relay is asleep the first connection takes about a
  minute.) `GET https://arviewer-relay.onrender.com/inspect?session=CODE`
  shows what the relay holds for a table's session.
- **Viewer** (ARViewer, `public/viewer/`): the "Deploy static app" workflow
  publishes GitHub Pages on every push to `main`; `gh run list` in the
  ARViewer checkout shows it. The hosted viewer is cached by URL for ten
  minutes; the table's QRs carry a per-load nonce so a rescanned QR never
  hands a phone a stale page.
- **Table** (this repo): `scripts/deploy.sh` fast-forwards `main` to the
  current branch, pushes, and dispatches `ci-and-deploy.yml` (push events
  alone have not been starting runs on this fork). The site is
  `https://egirard.github.io/jaipur/tt/`.

Relay and table are deployed independently, so each tolerates the other
being a version behind: the table falls back to counting phones when the
relay sends no per-seat presence, and the relay ignores fields it does not
know.

## Security notes

- Seat QRs are bearer capabilities shown on a shared screen: anyone who
  photographs a seat's QR can see that hand. Fine for living-room play.
  Per-seat tokens mean one QR opens one hand only.
- The relay stamps identity server-side and never invents a seat; the table
  validates every action as an intent; the phones receive only what the
  table publishes to them (nothing a seat may not see is ever sent to it).
- The relay keeps nothing durable: a session's cache dies with its last
  socket, and the registration-check reports it holds are diagnostics.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Join mat says "connecting to the relay…" for a minute | the hosted relay is waking from sleep (free tier) | wait; it connects by itself |
| Join mat says "relay unreachable" | no internet, or the relay host is down | set a LAN server (Table options) or let a saved one take over |
| Phone says "No tabletop is connected" | the table is not on this session (reloaded onto a new one, or its link is down) | check the table's caption; rescan the current QR |
| Phone says the link has no seat | an old shared/spectator URL | scan a seat's QR |
| A player's header shows the rejoin QR | that seat's phone lost the relay | rescan; the hand is restored by the relay's cache |
| "Another table window took over" | two tabs/windows of the table on one browser | close one, or reload the one to keep |
| LAN server unreachable | server not running, or its certificate not yet accepted in this browser | open `https://HOST:8443` once, accept, retry |

## The bundled viewer

The table carries its own copy of the phone page: `static/viewer/` and
`static/shared/` are ARViewer's `public/viewer` and `public/shared`,
vendored by `bun run sync:viewer` (`scripts/sync-viewer.sh`, from a
checkout at `../ARViewer` or `$ARVIEWER`), stamped with the ARViewer commit
(`static/viewer/ARVIEWER_COMMIT`, and the build line on the phone reads
`<hash>·table`). The deploy of the table therefore publishes the phone page
too, at `<table>/viewer/index.html` (the file, not the directory: the dev
server routes a bare `/viewer/` to SvelteKit), and a change to the phone
interface needs one push instead of two.

Resolution (arEndpoints.ts): on an **https** table that carries the copy it
is the default viewer, with the hosted relay (Table options says "the
hosted relay and this table's own copy of the phone page"). On an http
table — the dev server — the hosted viewer stays the default, because a
phone cannot enter AR from an http page; `?viewer=bundled` asks for the
copy anyway (remembered as the keyword, so it follows the table to another
address), which is the fast path for working on the phone's 2D view:
`scripts/dev-ar.sh` binds vite to the LAN, open the table as
`http://<lan-ip>:5185/tt/?viewer=bundled`, and the seat QRs point phones at
the dev server's copy — edits to `static/viewer/` show on the next reload
of the phone page. (`bun run sync:viewer` overwrites that directory from
ARViewer; edit there and sync, or edit the copy and port the change back.)
`?viewer=default` returns to the hosted viewer. An explicit `?viewer=HOST`,
a remembered one, the build's `VITE_AR_VIEWER_URL` and the ARViewer server's
own `/viewer/` all still win over the bundled copy.

`scripts/deploy.sh` warns when the vendored copy differs from the ARViewer
checkout beside it, so a stale copy is not published by accident.

## Appendix A — the deprecated Firebase channel

jaipur began as a two-browser game: each player's browser held the Firebase
SDK, signed in anonymously, and appended events to a Firestore collection
per room; both browsers reduced the same event stream. Phones joined a
tabletop by scanning a QR to `/hand/?gameId=…&seat=N`, a page that read the
same Firestore stream. Firestore Security Rules enforced own-UID,
append-only writes, and the Firebase emulators backed the Playwright
scenarios and the rules tests that the Git hooks ran.

The AR tabletop changed the shape of the system: the table became the only
writer, and the phones became windows onto it over the relay. From
2026-09-08 phones joined over the relay, and the table kept its game in the
browser-local store. Nothing in the supported flow touches Firebase, so on
2026-10-30 the Firebase channel was **formally deprecated**:

| Deprecated | Replaced by | State |
| --- | --- | --- |
| Firebase channel — anonymous Auth, the Firestore event store (`src/lib/firebase.ts`, `src/lib/firebase-config.ts`, `src/lib/game-repository.ts`), `firestore.rules`, the emulators | the browser-local store; the table is the only writer | code kept; `?firebase=1` on a build with Firebase config still opts in, with a console warning and "deprecated" in the status line |
| Two-browser game at `/` | the AR tabletop at `/tt` | kept; not maintained |
| Phone hand controller at `/hand`, from a table opened with `?phone=1` | the viewer's "Play using phone" view from a seat's AR QR (no WebXR needed), minimal or complete | **retired 2026-11-03**: `/hand` is a notice page with no Firebase, the table prints no `/hand` QRs, `?phone=1` only warns |
| Firebase-backed verification (`test:rules`, the two-browser Playwright scenarios, `scripts/dev-ar.sh`'s `JAIPUR_FIREBASE=1`) | `bun run verify:change` (static checks, unit tests, build); `bun run verify:legacy` runs the old suite on request | the Git hooks no longer need Java or the emulators |
| Spectator phones (a viewer URL without a seat) | none — the table is the shared view | removed; the relay turns them away |
| The five-letter room code in the market's centre | nothing — phones join by QR | shown only with `?firebase=1` |

**What the AR flow needs instead:** the table's browser (localStorage and a
WebSocket to the relay) and, for each phone, the viewer page and the same
relay — hosted by the ARViewer project by default, or a laptop on the LAN
as above.

**Removal plan.** (1) Rework `tests/e2e/012-tabletop-mode` around the relay
join flow and refresh the screenshot baselines — the legacy suite has been
red since the relay join landed (it still expects the `?phone=1` QRs, which
are gone). (2) Delete `/`, the `/hand` notice page, the Firebase modules,
`firestore.rules`, `firebase.json`, the `firebase` dependencies and the
emulator scripts; drop `?firebase=1` from the table. (3) Point the front
page at `/tt`. Done so far: `/hand` retired and its QRs removed from the
table (2026-11-03).
