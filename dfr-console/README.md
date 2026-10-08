# DFR Handover Console (prototype)

A clickable, self-running prototype of an operator console for a drone-as-first-responder programme. It is a design exploration of human oversight at the moment of handover. The city, units, rules and procedures are all fictional.

## Run it

Open `index.html` in a browser by double-clicking it. You don't need a server, npm or a build step. Designed for 1440×900 and up.

Use the striped **Prototype** strip at the top to drive the simulation: Play/Pause (Space), 1×/2×/4×, Restart, and Jump to handover. Choose the oversight mode in the top bar before you press Play.

Keyboard: **T** take control · **A** audit trail · **Space** play/pause · **Esc** close or cancel.

## Files

| File | What it holds |
|---|---|
| `index.html` | Page structure. |
| `styles.css` | All styling. **Section 1 holds every theme token.** |
| `app.js` | State machine and audit log (pure), selectors, playback, rendering, input. |
| `scenario.js` | Scenario data: timeline, positions, detections, unknowns, decisions, map. |

## Tweaking the look

Edit the `:root` block at the top of `styles.css`. Everything else reads from it, including the SVG map and the canvas live view:

- **Surfaces and text:** `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--line`, `--line-2`, `--text`, `--text-2`, `--text-3`.
- **State colours** (the only colours with meaning): `--sys` (system acting), `--ask` (needs a human), `--crit` (critical), each with `-line` and `-bg` variants.
- **Map:** `--map-*`.
- **Live view:** `--thermal-tint` (R G B multipliers), `--feed-*`.
- **Camo on the top bar:** `--camo-base`, `--camo-1`, `--camo-2`, `--camo-3`.
- **Prototype strip:** `--proto-*`.
- **Type:** `--font`, `--mono`, `--label` (the voice for labels and buttons), `--size`.
- **Shape and spacing:** `--r`, `--r-sm`, `--gutter`, `--pad`, `--bracket`.

Keep text at WCAG AA (4.5:1) against its surface. The defaults are 7:1 or better for body text.

## Adding a scenario

Copy `scenario.js`, give the object a new `id`, and register it on `window.DFR_SCENARIOS`. To load it, set `window.DFR_SCENARIO_ID` before `app.js`. The UI code doesn't change.
