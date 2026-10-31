# The tablecloth's brightness, measured against what phones can register

A reviewer found the mandala tablecloth too intrusive. Dimming it is a CSS
knob; the question is how far it can go before the AR phones stop
registering on the screen — and that answer depends on the screen's panel
brightness, the room's light and the phone, so the table measures it at
runtime instead of assuming it. This note is the experiment and the
adapter built around it. Code: `src/lib/ar/backgroundAdapter.ts` (pure,
unit-tested), wired into Table options in `src/routes/tt/+page.svelte`.

## Why the wash can move at any time

The cloth is drawn under a dark wash: `--cloth-wash` is the alpha of a
`rgb(20 8 4)` layer over the photo (0.25 is the look the table shipped
with; the levels are 0.25 … 0.75 in steps of 0.10, shown to the operator as
brightness 75 % … 25 %).

The phones do **not** register against the washed screen. The tracking
image the table publishes is captured with the wash stripped
(`arTabletop.ts`, `onclone`): the phone's camera auto-exposes the screen and
the feature matcher works from contrast, not absolute brightness, and the
washed capture scored half as trackable with `arcoreimg`. So changing the
wash republishes nothing — phones in AR keep their reference and simply see
a dimmer screen. What dimming costs is physical: less light from the screen
means less signal (and more sensor noise) in the camera's view of the
cloth, until matches drop and tracking degrades. That is what the phones'
own reports measure.

## The signal

Every phone in AR reports to the table every two seconds (`diag` action):
frames rendered and frames in which ARCore reported the tracked image as
*tracked*, plus the state (`tracked`, `emulated`, `lost`, `searching`),
whether it has ever seen the table, and — since ARViewer's pose report —
**where the phone is and how it moved** in the interval: the camera's
`pitch` (degrees above the horizon: about −30 to −70 held over the table,
−90 lying face-up on the cloth, +90 face-down), `moved` (metres) and
`turned` (degrees), the farthest the camera got from where the interval
began.

`trackedShare()` aggregates the tracking numbers over a window across all
phones that have seen the table — **the fraction of frames in which the
screen was being tracked** — but only over *engaged* intervals
(`isEngaged`): pitch within ±70° and the phone moved at least 1 cm or
turned at least 1.5°. A hand-held phone exceeds one of those in any two
seconds; a phone lying on the table, propped against a cup or left
face-down exceeds neither, reports no tracking, and says nothing about the
screen — so it is dropped, not counted as failure. A viewer too old to
report its pose never counts either (the safe side). The window also says
how many phones were present but idle, so the panel can say "pick it up"
instead of "no phone".

The measure is coarse but honest, needs no camera access, and is the same
number the registration check reports. Its remaining blind spot: a phone
held up and moving but pointed at the other player also stops tracking.
That is why the automatic move below is confined to a phone's first
moments with the table, when it is being pointed at the screen on purpose.

## The sweep (Table options → Background → Evaluate with phones)

Preconditions: at least one phone in AR that has found the table and is
reporting frames (the button is disabled otherwise). The operator holds
the phone over the table as they would in play; a pill in the market header
shows the level under test and the live tracked share.

1. Start at the current level and measure it as the baseline: 2.5 s to
   settle, then 8 s of samples.
2. A level *holds* if, over its hold, the phones tracked at least 75 % of
   their frames, reported at least 40 frames, and none reported the table
   lost outright.
3. If it holds, step one level darker and repeat; if it fails, stop — the
   last level that held is the recommendation. If the baseline itself fails
   the sweep aborts and says so (point the phone at the table and retry).
4. Done: the recommendation becomes this screen's **target** and the wash
   moves there; the failed level (if any) is remembered as a ceiling for the
   session. Results per level (share, frames, phones, lost, held) are kept
   with the screen's record, last five sweeps.

A full sweep from 75 % to 25 % takes about a minute.

## The only automatic move: brighter, on a phone's first engagement

The table never dims itself, and never moves the saved setting on its own.
Players put their phones down for minutes at a time, look at each other,
leave a phone face-up on the cloth; none of that may touch the background.
What the table does do, with Auto-brighten on, is protect a player whose
phone is struggling at the moment it matters:

- A phone's **engagement window** opens when it first locks onto the table
  and lasts 90 s. It closes for good when the phone leaves AR (re-entering
  opens a new one).
- Each second, if any phone is inside its window, the table reads the
  engaged tracked share of those phones over the last 20 s (never reaching
  back past the last change, and needing at least 150 frames — about five
  seconds — of evidence). Under 50 % tracked, with the cloth darker than
  the brightest level and at least 25 s since the last step: **one level
  brighter**, for this session only, and the failed level is remembered
  as the session's ceiling.
- That is all. There is no darkening move. A phone in its window that
  tracks well changes nothing; a phone past its window changes nothing
  whatever it does.

The step shows on screen but is **not saved**: the Background row says
"Showing 65 % this session; 55 % is saved" and asks for a new evaluation.
The saved level changes only through the calibration controls — the sweep,
or − / + (which save the level they set; a step brighter past a failed
level forgets that ceiling). Every change is logged in the panel with its
reason.

### The sweep and a phone set down

The sweep reads only engaged samples too. If the phone is set down
mid-sweep the current hold waits up to 15 s for it to come back into hand
(the pill says so), then aborts with "the phone is lying still — pick it
up" and the wash returns to where the sweep started; the Evaluate button
is disabled, with the same reason in its tooltip, while no engaged phone is
reporting.

## Persistence

Settings live per screen under `jaipur:tabletop:cloth`, keyed by diagonal
and viewport (`55in-1920x1080`): the saved wash (`target` is kept equal to
it; older records may differ from when the wash crept at runtime), auto
on/off, the last five sweeps. A different display starts from the shipped
look and its own sweep. A session-only brightening is not written.

## What this does not do (yet)

- It cannot tell "the screen is too dim" from "the player looked away"
  while the phone is in hand; confining the automatic move to a phone's
  first 90 s with the table, brighten-only, one step at a time, is the
  mitigation, not a cure. A better signal would be ARCore's per-frame match
  quality, which WebXR does not expose.
- The engagement thresholds (±70°, 1 cm, 1.5°) are chosen from how ARCore
  poses behave, not yet measured on the 55" table with a real phone; the
  phone's own diagnostics panel prints its pitch, moved and turned so they
  can be checked.
- It does not change the reference image. Dimming the *capture* as well
  would be a different experiment (and scored badly offline).
- It measures only the phones present. A second phone model may need its
  own run; the adapter will back off for it during play.
- The sweep measures tracking that is already locked. Time to first lock at
  a dim level is measured by the existing registration check; run one at
  the chosen level to confirm (Table options → Registration check).
