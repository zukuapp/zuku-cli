---
name: game-implementation
version: 1.0.0
description: Write the complete, self-contained source files under src/ that implement the approved plan and architecture.
---

# game-implementation

Produce every file of the game as `{ path, content }` entries. Paths are relative to the
project root and must start with `src/`. The CLI writes them into a fresh directory, validates
the project, and plays it in a real sandboxed browser before anything is packaged.

## Allowed files

- Extensions: `.html`, `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.txt`, `.md`. Text only, UTF-8.
- `src/index.html` is the entry point. Do not write `zukujs.json`, `src/vendor/**`, dot-files,
  `node_modules`, build configs, shell scripts or anything outside `src/`.
- At most 48 files, 512 KiB per file, 1.5 MB in total.

## Entry HTML

- Load scripts with relative `src` attributes only (`<script src="vendor/phaser.min.js">`,
  `<script type="module" src="main.js">`). No inline `<script>` bodies, no inline event
  handler attributes, no `<base>`, `<iframe>`, `<object>`, `<embed>` or meta refresh. The
  playtest serves the game with a strict Content-Security-Policy.
- Every HUD and menu id from the plan exists in `index.html` as a DOM element with that exact
  `id`. The game-over menu is hidden until the loss condition and visible afterwards.
- Inline `<style>` and stylesheet files are fine. Make the layout responsive to the viewport.

## Code rules

- Implement every module listed by the architecture at exactly its path with its role.
- Simulation modules are pure: no `document`, `window`, `Phaser`, canvas, `requestAnimationFrame`,
  `performance`, `localStorage`, timers or audio. Advance with a fixed timestep.
- The input module contains the explicit `KeyboardEvent.code` strings of every planned key
  (for example `'Space'`, `'ArrowLeft'`), mapped to the plan's action ids. Listen on
  `window` keydown/keyup (call `preventDefault` for mapped keys) and optionally pointer events.
- The boot module installs `window.__zukuGame` per `zuku-hooks/1`: `getState()` returns a
  fresh plain object `{ status, score, tick, last_action }`; `forceLoss()` runs the real loss
  path. `status` is `menu` before the start action, `running` during play, `over` after loss,
  and `running` again after the reset action. `tick` increases while running and returns to a
  small value after reset.
- Update DOM HUD text from simulation state each frame (or on change).
- No network: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
  `importScripts`, workers, service workers, dynamic `import()`, `eval`, `new Function`,
  string timers, `document.cookie`, `window.open`, or absolute `http(s)://` URLs. SVG namespace
  URIs are the only allowed absolute URLs.
- No Node or shell APIs (`require`, `process`, `child_process`, `node:` modules). Artifacts are
  data; the CLI never executes anything you write outside the browser sandbox.
- Never embed credentials, tokens, API keys or personal data. Assets are original: draw with
  shapes, generate SVG, synthesize sound with WebAudio.
- Save only a best score under a `zuku:` prefixed `localStorage` key, guarded by try/catch.

## Repairs

When called with `repair` input you receive the previous file list and structured playtest or
gate failure codes. Return the complete corrected file set (not a diff). Fix causes, do not
hide symptoms: never stub `getState`, never fake status transitions without real game logic.

## skill_receipt

Echo this skill's name, version and sha256 exactly.
