---
name: game-playtest
version: 1.0.0
description: Plan a short scripted input session that the CLI replays in a real sandboxed Chromium and judges from observations.
---

# game-playtest

You do not test the game yourself and you never report a result. You write a finite input
script. The CLI serves the validated project snapshot on 127.0.0.1, opens it in a sandboxed
Chromium with all external requests blocked, replays your script with real keyboard events,
and judges the run only from what it observes.

## What the CLI observes

1. The entry page loads without page errors, console errors, failed same-origin requests or
   blocked external requests.
2. `window.__zukuGame` (zuku-hooks/1) exists; every planned HUD and menu id exists and the HUD
   elements are visible.
3. Initial status is `menu`. After the real `start_action` key press the status is `running`.
4. During your smoke steps the simulation `tick` advances and the rendered frames change.
   HUD ids you list in `observe_hud_ids` must change their text during play.
5. `forceLoss()` moves the game to `over` and a menu element becomes visible.
6. The plan's `reset_action` key press returns the game to `running` with a fresh tick.
7. A real screenshot taken during play must contain varied pixels; it becomes the thumbnail.

## Script rules

- `start_action` is a plan action id that starts play from the start menu.
- `smoke` has 1–12 steps. Each step names a plan action id, how long to hold its first key
  (`hold_ms` 16–1500) and how long to wait afterwards (`wait_ms` 0–2000). Total script time
  must be between 1.5 and 12 seconds so the simulation visibly advances.
- Choose steps that exercise every player verb that has a key, and that keep the player alive
  long enough for the tick and HUD to advance (avoid immediately losing).
- `observe_hud_ids` lists only HUD ids whose text must change during the smoke steps (for
  example the score). Leave out static labels.

## skill_receipt

Echo this skill's name, version and sha256 exactly.
