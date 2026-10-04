---
name: game-design
version: 1.0.0
description: Turn a short game request into a finite, testable design plan for a small browser game.
---

# game-design

You are designing a small, complete HTML5 game that a player can understand in ten seconds
and finish a round of in under three minutes. The output is a structured plan, not prose.
Every field you produce is checked by code before anything is built.

## Scope rules

- One screen, one core mechanic, one clear failure state. Cut every idea that needs a second
  mechanic, multiplayer, accounts, chat, purchases or a server. The game runs fully offline.
- Prefer a mechanic you can express in 3–6 player verbs ("jump", "dash", "collect", "dodge").
  Verbs are short imperative words, unique, and each one must be reachable by an input action.
- Respect the request's theme and tone, but never copy a named commercial game, character,
  logo, soundtrack or level layout. Invent original names and art directions.
- Keep the content rating at "all" unless the request explicitly asks for something mature.

## Core loop

Write the core loop as 2–8 ordered steps that repeat during play, for example:
"spawn hazard" → "player reads lane" → "player moves" → "score on survive" → "speed rises".
The last step must feed back into the first. If you cannot close the loop, the design is
too large; simplify it.

## Loss and reset

- `loss_condition` describes exactly what ends a round (collision, timer, lives reach zero).
- `reset` describes how the next round starts from a clean simulation state.
- `reset_action` is the id of an input action that restarts the game from the game-over
  menu. Reset must be possible with the keyboard alone.

## Input actions

- Each action has a snake_case id, 1–4 `KeyboardEvent.code` keys, an optional pointer flag
  and a purpose. One physical key maps to at most one action — the mapping must be explicit
  and conflict-free.
- Include a `start` style action usable from the start menu, and the `reset_action`.
- Pointer/touch support is welcome (`pointer: true`), but keyboard must cover every action so
  automated playtests can drive the game.

## HUD and menus are DOM

- HUD elements (score, lives, timer, best) are DOM elements with kebab-case ids layered over
  the canvas, not text drawn into the canvas. List 1–8 `hud` entries.
- Menus (start, pause, game over) are DOM elements too. List 1–4 `menus` entries. A game-over
  menu must exist and must become visible when the loss condition triggers.

## Assets

- Every asset is original and self-contained. Use `source: "procedural"` for shapes and sounds
  generated in code (path must be empty), or `source: "file"` for an SVG/JSON/text file you will
  author under `src/assets/` (path relative to `src`, starting with `assets/`).
- No remote URLs, fonts from CDNs, stock packs or copyrighted media. `license` is always
  `original`.

## Engine preference

- Default to `phaser` for 2D games: scenes, arcade physics, tweens and input are well proven.
- Choose `canvas` only when the game is simple enough that a plain Canvas 2D loop is clearer
  (single-screen arcade with a handful of rectangles), and say why in `reason`.
- The engine is a renderer and input helper. Game rules live outside it (see game-architecture).

## Simulation versus render

State in one sentence what belongs to the simulation (positions, velocities, timers, score,
random seed, collision results) and what belongs to rendering (sprites, tweens, particles,
camera shake, DOM text). The simulation must be steppable without a renderer.

## Save, debug and performance

- `save`: `none` or `local_storage_highscore` (only a best score, under a `zuku:` prefixed key).
- `debug`: what a developer toggle shows (e.g. hitboxes, fps). Debug code is off by default.
- `perf_budget`: target fps (30–120) and a hard cap on simultaneous entities.

## skill_receipt

Echo the exact skill name, version and sha256 you were given for this skill. A mismatch
rejects the stage. Echoing the receipt does not replace following these rules; the plan is
validated field by field.
