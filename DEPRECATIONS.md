# Deprecations

The Firebase channel — anonymous Auth, the Firestore event store, the
two-browser game at `/`, the `/hand` phone controller, the emulator-backed
verification — is deprecated as of 2026-10-30. The supported product is the
AR tabletop (`/tt`) on the browser-local store, with phones joining over the
AR relay. Spectator phones were removed at the same time.

The `/hand` phone controller was **retired on 2026-11-03**: the route now
shows a notice pointing at the seat QRs, the table no longer prints its QRs
(`?phone=1` only logs a warning), and nothing on it touches Firebase. The
phone's hand controller is the viewer's "Play using phone" view, in its
minimal or complete form (ARViewer `docs/AR-CARD-VIEWER-API.md`).

The full story, the table of what is deprecated and what replaces it, and
the removal plan are **Appendix A of [docs/CONNECTIVITY.md](docs/CONNECTIVITY.md)**.
