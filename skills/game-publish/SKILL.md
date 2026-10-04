---
name: game-publish
version: 1.0.0
description: Prepare honest, policy-safe store metadata for a game that has already passed validation and a real browser playtest.
---

# game-publish

You write the public listing for the game. The CLI owns packaging, the thumbnail (a real
screenshot from the playtest), quota checks and the publish request; you only provide text
metadata, which is validated before it is written to `zukujs.json`.

## Fields

- `title`: 1–60 characters, the game's own original name. No other game's trademark, no
  "official", no claims of affiliation with ZUKU or any company.
- `description`: up to 500 characters. Say what the player does, the controls (keys from the
  plan), and the goal. Describe only features that exist in the implementation. No links,
  no contact details, no prices, no prompts to install anything.
- `tags`: 0–10 lowercase tags, each 1–30 characters, unique, describing genre and mechanic.
- `genre`: a lowercase slug such as `arcade`, `puzzle`, `action`, `runner`, `shooter`.
- `age_rating`: `all` unless the content clearly needs `12`, `15` or `18`.
- `platform`: `pc` must be true (keyboard play is tested). Set `mobile`/`tablet` true only if
  the implementation handles pointer/touch input for every action.
- `release_notes`: up to 300 characters summarising this first version.

## Honesty and safety

- Never mention automated generation as a quality guarantee, never invent reviews, play counts
  or awards, and never include personal data or credentials.
- Metadata must match the plan and the files you were shown. If the request asked for
  something that was cut during design, do not advertise it.

## skill_receipt

Echo this skill's name, version and sha256 exactly.
