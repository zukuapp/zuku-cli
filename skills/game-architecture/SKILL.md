---
name: game-architecture
version: 1.0.0
description: Choose the engine and module layout that keeps simulation, rendering, input and DOM UI separate.
---

# game-architecture

Convert the approved design plan into a module plan for a static HTML5 project. The project
root contains `zukujs.json` (written by the CLI) and a `src/` directory that is the only
packaged content. You decide which files exist under `src/` and what each one owns.

## Engine choice

- `phaser`: the CLI bundles a pinned local Phaser build at `src/vendor/phaser.min.js`. Load it
  with a relative classic script tag before your own modules. Never reference a CDN and never
  author or modify `src/vendor/`.
- `canvas`: plain Canvas 2D with `requestAnimationFrame`. When `uses_create_scaffold` is true
  you start from the `zukujs create` scaffold (provided as input) and evolve it.
- If the plan prefers an engine that is not in `available_engines`, pick an available one and
  explain the trade-off in `reason`.

## Required module roles

List 2–16 modules under `src/` with `.js` or `.mjs` extensions. Roles:

- `simulation` (required): pure game rules. Exports a way to create state and to advance it by
  a fixed timestep from a list of action ids. It must not touch `document`, `window`, the
  canvas, Phaser, timers, storage or audio. It may use a seeded PRNG passed in state.
- `render` (required): draws simulation state with Canvas or Phaser. Reads state, never
  mutates game rules.
- `input` (required): the single explicit mapping from `KeyboardEvent.code` (and pointer) to
  action ids. It must contain every key string from the plan's input actions.
- `boot` (required): wires modules together, owns the frame loop, DOM menus and test hooks.
- Optional: `hud` (DOM HUD updates), `assets` (procedural/SVG asset creation), `audio`
  (WebAudio synthesis), `save` (best score only), `debug` (off by default).

## Boundary

`boundary.simulation_modules` and `boundary.render_modules` must list exactly the module paths
with those roles. `boundary.rule` restates the separation in one sentence.

## State shape

List the simulation state keys (1–24) with their types and purpose. `status` (menu, running,
over), `score` and `tick` must be present: they back the playtest hook.

## Input mapping

Copy the plan's input actions verbatim into `input_mapping` (action id and keys). The CLI
rejects any difference.

## Test hook contract

Use `test_hook_contract: "zuku-hooks/1"`. The boot module defines:

```js
window.__zukuGame = Object.freeze({
  contract: 'zuku-hooks/1',
  getState: () => ({ status, score, tick, last_action }), // plain JSON, read-only copy
  forceLoss: () => { /* triggers the real loss path; debug only */ },
});
```

The hook only reports and triggers the existing loss path. Starting and resetting must happen
through real input events so the browser playtest can observe them.

## skill_receipt

Echo this skill's name, version and sha256 exactly.
