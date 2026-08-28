# Crunchatize — Takane

A three-piece set for a Moémon (moe-anthropomorphised Pokémon) roleplay on
[chub.ai](https://chub.ai). Each piece works on its own; together they are
built to stay out of each other's way.

| Piece | File | What it owns |
|---|---|---|
| **Stage** | this repo (`src/`, deployed to chub) | The party, the bag, open threads, recurring characters, the current scene, the dice, and the Prose/Story/RPG switch. |
| **Lorebook** | `lorebook/moemon-lore.json` | The Takane region — its towns, Gyms, Leaders, culture and rumours — plus Kanto and Johto next door, and every Moémon species. |
| **Character card** | `character/moemon-adventure-rpg.json` | The narrator: prose, pacing, battles, and the stat block's numbers. |

Import the lorebook and the card into chub, attach the stage to the chat, and
they hand off to each other. Missing one? The other two still work — the card
tracks everything itself when no panel notes arrive, and the stage runs on any
Moémon chat.

## The region

Takane is a mountainous island north-east of Kanto, opened to trainers a few
years ago. It sits over a fault that saturates the place in **the Verge**, an
energy that pushes Moémon far past the levels they reach anywhere else — the
Shelf, its beginner corridor, runs wild Moémon at Lv.15–25, and the Champion's
team sits above Lv.95. Everything about the culture follows from that: the
Warden Service that decides who may walk which road, the Tally that ranks
people by their team, and cresting — what happens to a Moémon pushed too far,
too fast. The Verge also pushes evolution lines into forms no other region has
recorded, which is why Sirfetch'd, Kleavor, Ursaluna, Annihilape and the rest
turn up here and nowhere else.

## Prose, Story, RPG

The switch at the top of the panel decides how much of the game is showing,
and it can be flipped mid-scene:

- **Prose** — a straight novel. No stat blocks, no dice, nothing adjudicated.
- **Story** (default) — prose leads; a stat block appears once a battle does.
- **RPG** — a readout whenever a value moves, and the narrator is sent full
  movesets so the block and the panel agree.

The narrator is told when the setting changes and not otherwise.

## Working on it

Requires Node 21.7.1 and yarn.

```bash
yarn install
yarn dev       # runs src/TestRunner.tsx standalone in a browser tab
yarn build     # sync-lore, typecheck, bundle, re-encode portraits
```

**The lorebook is the single source of truth for species.**
`src/assets/moemonSpecies.json` is generated from it by
`scripts/sync-lore.mjs` (which `yarn dev` and `yarn build` both run first).
Edit `lorebook/moemon-lore.json`, not the generated file. An entry counts as a
Moémon if its text carries a species type tag — "a Water/Fairy-type girl" —
which is the same string the stage reads types from. Locations, items and
people have no such tag and are never offered as party members.

Party artwork goes in `public/moemon/` — see the README there for naming and
build handling.

Pushing to `main` deploys to chub via `.github/workflows/deploy.yml`, which
needs a `CHUB_AUTH_TOKEN` repo secret.
