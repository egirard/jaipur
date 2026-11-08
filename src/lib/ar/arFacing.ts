// Which way the AR market faces each seat (GPLv3, part of this fork). Pure.
import type { ArNode } from './arHost';

/** The pieces of the shared scene that a seated phone should see the right
 *  way up: the market cards, the deck and the cards on the return slots
 *  (the band every phone looks at). The shared scene draws them as the
 *  table does — upright for seat 2 — so seat 1's phone would read the art
 *  upside down. The seat scene overrides them (same id, private wins)
 *  with the face turned to that seat; only the pieces whose rotation
 *  differs are republished, and never one the seat scene already owns. */
export function facingOverrides(shared: readonly ArNode[], privateIds: ReadonlySet<string>, facing: number): ArNode[] {
  return shared
    .filter((n) => (/^(mkt:|ret:)/.test(n.id) || n.id === 'deck') && !privateIds.has(n.id) && n.rotY !== facing)
    .map((n) => ({ ...n, rotY: facing }));
}
