# Moemon Engine — Build Plan

Folding the Crunchatize stage, the Takane lorebook and the narrator card into
one purpose-built RPG engine, forked from [Waidrin](https://github.com/p-e-w/waidrin) —
so the game stops advising a model it doesn't control and starts running the
loop itself.

| | |
|---|---|
| **From** | `Shadoku/Crunchatize_pokemon` |
| **Onto** | `p-e-w/waidrin` @ `1171787` |
| **Target** | Single-player Next.js app, OpenRouter, AGPL-3.0-or-later |
| **Name** | Moemon Engine ("Takane" below names the in-game region, not the project) |

**Settled going in:** the percentage-roll resolution mechanic is kept, including
in battle — no deterministic damage-calculator gets built. The Prose / Story /
RPG toggle is kept, unchanged in meaning. The world is anchored by the existing
Takane setting rather than authored from nothing or generated from nothing —
canon stays canon, generation fills only what the lorebook leaves open.
OpenRouter is the target backend. License is AGPL-3.0-or-later throughout,
matching Waidrin's own.

---

## Contents

1. [Why fork at all](#1-why-fork-at-all)
2. [What each side brings](#2-what-each-side-brings)
3. [The turn loop](#3-the-turn-loop)
4. [Repo layout](#4-repo-layout)
5. [Data pipeline](#5-data-pipeline)
6. [The setting as anchor](#6-the-setting-as-anchor)
7. [State & events](#7-state--events)
8. [Battle & the roll](#8-battle--the-roll)
9. [The Verge, cresting, the Tally](#9-the-verge-cresting-the-tally)
10. [OpenRouter & the backend](#10-openrouter--the-backend)
11. [Frontend](#11-frontend)
12. [What gets deleted](#12-what-gets-deleted)
13. [Phasing](#13-phasing)
14. [Licensing & naming](#14-licensing--naming)

---

## 1. Why fork at all

Three of the stage's most elaborate subsystems exist only because a chub
stage cannot own the generation loop. In an engine that does, all three
disappear — and nothing about the game itself has to change to get there.

The stage can only talk *around* the model: it injects `[INST]` blocks before
a turn and reads the prose afterwards. Everything downstream of that
constraint is compensation, not design.

- **The scan** — `Scan.ts`, `External.ts`, `StoryLog.ts`, the suggestion
  queue, the dismissal lifetimes. About a thousand lines reverse-engineering
  state changes out of narration that already happened.
- **The echo defences** — `trimTrailingBlock` and `ECHOED_READOUT` exist
  because the stage prints a fenced readout and models copy it back.
- **The odds gag order** — `NO_ODDS_IN_PROSE` repeated in every mode, on
  every turn, because the narrator kept opening with `76% success — good
  navigation`.

None of that touches the parts of the design that already work: the
percentage roll that reads as a gradient rather than a pass/fail line, the
Prose/Story/RPG ladder that decides how much of the game is showing, or a
Takane that is written down rather than invented per session. Those three
carry over intact — this is a plan for owning the loop the stage never
could, not for replacing the game it already plays well.

> **The payoff worth naming.** Cresting, the Verge, the level bands and the
> Tally are the region's signature mechanics, and today they are *prose
> asking a model to please remember*. In an engine that owns the loop they
> become real state: strain accumulates from the same rolls that already
> drive play, thresholds fire, and a Moémon pushed too fast actually crests.
> That is the thing a stage can never do — and it costs the dice nothing.

## 2. What each side brings

Nothing is discarded for novelty. The inventory, honestly counted:

### Mechanics — kept whole (`src/` — the chub stage)
- The percentage roll, difficulty steps, criticals at ≤5 / ≥95 — this stays
  the resolution mechanic everywhere, battle included
- Prose / Story / RPG crunch ladder — the one control that decides how much
  game is showing, unchanged
- Moveset generator: 18 type pools, 161 curated species, held items, level
  windows
- Party (6 + active slot), bag, conditions, quests, NPC affinity, scene
- Portrait pipeline: slug rule, crop anchors, sharp → WebP
- Item catalogue: 8 categories, 138 items

### World — anchor, not enum (`distributables/` — lorebook + card)
- 441 lorebook entries: 289 species, 152 world entries — stays canon and
  load-bearing
- Takane: ten towns, Gym Leaders, the Verge, the Tally, the Ledger, the
  Warden Service, level bands
- Kanto & Johto gazetteer next door
- Narrator card: tone, pacing, no-menus rule, stat-block spec, combat /
  capture / evolution rules
- Evolution edges written in prose, parseable

### Engine (`p-e-w/waidrin`)
- Typed zod state, zustand + immer + persist
- Async state machine with rollback on failure
- Constrained generation (`getObject`) + streaming narration
- Scene-based context compression with summaries
- Event log & per-event view components
- Radix frontend, wizard flow, plugin loader, backend abstraction — *its own
  world/genre generator is the one thing here that doesn't survive*

One Waidrin premise gets inverted and the rest stay: the world is
**anchored, not generated from scratch** — Takane's towns, Gyms and culture
are canon exactly as they are today, and Waidrin's generative machinery
fills in everything the lorebook leaves open (routes, minor NPCs, wild
encounters) *against* that anchor rather than instead of it. The turn loop
gains a Pokémon event vocabulary and a second machine for battle, but both
still resolve on the roll.

## 3. The turn loop

Waidrin's `next()` becomes a router on `state.battle`. Below, **[roll]**
marks the resolution mechanic, **[code]** marks deterministic TypeScript,
**[llm]** marks a model call.

**Overworld turn**

```
Action  →  [roll] Roll the check   →  [code] Context   →  [llm] Narrate
        →  [llm] Turn delta        →  [code] Validate & commit
```

- **Action** — free text, or one of three suggested actions
- **[roll] Roll the check** — RPG mode always rolls. Story rolls once a
  scene turns mechanical. Prose never rolls
- **[code] Context** — scenes + summaries + triggered codex entries
- **[llm] Narrate** — told the roll privately, reads it as a gradient.
  Never states a number
- **[llm] Turn delta** — scene, NPCs, threads, items, encounter?
- **[code] Validate & commit** — checked against the codex, then applied

**Battle turn** — entered when the delta reports an encounter

```
Move  →  [roll] Roll the exchange  →  [llm] Narrate
      →  [llm] Report HP/status    →  [code] Bound & commit
```

- **Move** — move buttons in RPG, free text otherwise
- **[roll] Roll the exchange** — same mechanic as overworld —
  difficulty-shifted %, criticals nudge condition hard
- **[llm] Narrate** — told the roll and the matchup as a hint, not a
  formula. Writes the exchange
- **[llm] Report HP/status** — same stat-block vocabulary the card already
  uses, now schema-shaped
- **[code] Bound & commit** — 0–100 clamp, faint at 0, XP/level/strain from
  the roll history

This is deliberately *not* a Pokémon damage-calculator. Battle uses the same
percentage check as everything else — a DM's ruling on a d20, not a JRPG
formula — so "dnd-esque" stays true of the whole game, not just the
overworld. What changes from today is only *who reads the roll's outcome
back into state*: the model reports the resulting HP/status/level in the
same reply it narrates, under a schema, instead of a separate scan reading
it out of old messages days later.

Validation stays exactly as strict as `resolveDetection` is today: species
must exist in the codex, HP and level are bounds-checked, a level report
that doesn't move the needle is dropped. What goes is the suggestion queue,
the dismissal lifetimes and the scan cadence — there is nothing to suggest
when the state was generated in the same turn it describes. Keep a **Review
before applying** setting for players who liked the tick-and-cross; it now
gates the turn delta instead of a periodic scan.

## 4. Repo layout

A fork of Waidrin with its shape intact — `lib/backend.ts`, `lib/context.ts`
and the store survive nearly untouched.

```
app/
  page.tsx, layout.tsx        — view router, near-unchanged
lib/
  backend.ts                  kept + extended — see §10, OpenRouter needs
                               more here than llama.cpp would
  context.ts                  kept — scene compression already does what
                               we need
  state.ts                    kept shape, new State
  schemas/                    split: world · trainer · party · battle ·
                               events
  engine/
    index.ts                  next(): view machine + turn router
    overworld.ts  battle.ts   the two turn loops — both call rules/roll.ts
    encounter.ts  capture.ts  evolution.ts  progression.ts
  rules/                      pure TS, no model calls, unit-testable
    roll.ts                   the one resolution mechanic — difficulty,
                               criticals, condition nudge
    catch.ts  levels.ts  verge.ts
    matchup.ts                advisory type chart — narration flavor,
                               never computes damage
  data/                       GENERATED — do not edit
    species.ts  moves.ts  items.ts  gazetteer.ts
  lore/
    codex.ts                  lorebook loader + keyword index — the
                               setting anchor
    inject.ts                 constant + triggered entries under a token
                               budget
  prompts/
    narration.ts  structured.ts  style.ts   the card, decomposed
components/ views/            Radix shell kept; panel ported from
                               PartyPanel.tsx
content/
  lore/takane.json            the lorebook — still the single source of
                               truth
  card/narrator.md            the card prose, now a prompt module
public/moemon/                portrait masters + anchors.json, unchanged
scripts/
  build-data.mjs              sync-lore.mjs's successor
  portraits.mjs                vite-plugin-portraits.ts, ported to a
                               prebuild step
```

## 5. Data pipeline

`scripts/build-data.mjs` inherits `sync-lore.mjs`'s one good rule — *the
lorebook is the single source of truth, and it fails the build rather than
shipping a silent mismatch* — and extends it from a species list to the
whole data layer.

| Emits | From | Build-time check |
|---|---|---|
| `species.ts` | 289 entries carrying a type tag (`a Water/Fairy-type girl`) — the same rule as today, plus the blurb and temperament | Unknown type token fails; duplicate name fails |
| `evolution edges` | Parsed out of the same prose: *"evolves into Ivysaur starting around level 16"*, *"the evolved form of Diglett, reached starting around level 26"*, stone and trade phrasings | Every named target must resolve to a species; every line must reach one form or the other |
| `gazetteer.ts` | Takane towns, Gyms, Leaders, badges, routes and level bands; Kanto/Johto as reachable neighbours | Each Gym names a Leader entry; each Leader names a town |
| `moves.ts` / `items.ts` | The hand-authored JSON, kept as-is and typed | Curated species must exist; held items must exist in the catalogue |
| `codex index` | `key` / `keysecondary` / `order` / `constant`, already on every entry | Token cost measured per entry so injection can budget |

This is where the *information* gets integrated rather than merely
attached. Today the lorebook is a keyword blob handed to somebody else's
model. Here one file is simultaneously the prose codex and the game's data
tables, and the build cross-checks the two against each other.

## 6. The setting as anchor

Not "authored" in the sense of a closed enum, and not "generated" in
Waidrin's original sense either. Takane is a fixed place; what happens in
it is still made up as you go — exactly how the current lorebook + card
pairing already works, just without a second model having to be told the
rules twice.

- **Canon, never generated** — the ten towns, their Gyms and Leaders, the
  Verge, the Tally, the Ledger, the Warden Service, the level bands. These
  are load-bearing facts about the region and nothing in the engine is
  allowed to contradict them.
- **Generated, but anchored** — routes between named places, minor NPCs,
  wild encounters, rumours, one-scene characters. Waidrin's existing
  generation machinery (`generateNewCharactersPrompt`-shaped calls) stays,
  but every such prompt is handed the current location's gazetteer entry
  and level band as ground truth instead of inventing a world from a
  one-line genre blurb.
- **Constant injection**, always present: Takane, The Verge, Takane Level
  Bands, Cresting, The Tally, The Ledger, Warden Service. This is the
  world's physics and it is never optional.
- **Pinned**: the current town, the Gym Leader if one is in play, and the
  species entry for every party member — a Moémon's own temperament is
  what the narrator most needs and most often loses.
- **Triggered**: keys scanned against the last N events, present NPCs and
  the current location, ranked by `order`/`priority`, filling whatever
  budget remains.

Budget arithmetic reuses `getApproximateTokenCount`, so lore and scene
history compete for one honest total instead of two guesses. Roughly 150
lines beside `getContext` — this replaces chub's lorebook engine in-repo,
it does not remove the idea of one.

## 7. State & events

The chub triad — init state, message state, chat state, plus
`pendingConditions` to paper over the fact that a panel edit isn't a
lifecycle hook — collapses into one persisted store. So does the
`anonymizedId` keying: **single-player, one protagonist**.

```
Trainer   { name, pronouns, biography, money, badges[], permits[], tally }
Moemon    { species, nickname, level, hp/maxHp, status, moves[4],
            heldItem, condition, temperament, strain, friendship }
Party     { members[6], boxed[] }        — PC storage, the card already
                                            narrates it
Bag       { items[{name, qty}] }
Journal   { quests[], npcs[{name, note, affinity}], scene, seenSpecies[] }
Progress  { gymsBeaten, badges, eliteFour, rival }
Battle    { null | { kind, opponent?, enemyParty[], turn, rollLog[] } }
Settings  { mode: prose|story|rpg, difficulty: -6..6, contentLevels }
```

Events gain a Pokémon grammar alongside `narration` and `location_change`:
`battle_start`, `battle_turn`, `capture`, `level_up`, `evolution`, `faint`,
`item_use`, `badge`, `travel`. Each gets a view component in Waidrin's
existing `EventView` pattern — **the transcript itself becomes the
readout**, which is why the model never writes a stat block and nothing has
to be trimmed back out.

Two things worth keeping from the old state layer: the defensive parsers
(`parseParty`, `parseInventory`, `parseQuests`, `parseNpcs`) become zod
schemas with the same forgiveness, and the save-bundle importer survives as
a one-way **import from chub**, so a game in progress can walk across.

Chub's swipe becomes an explicit **rewind to this event**. The event log
makes it about thirty lines, and it is a better version of the thing.

## 8. Battle & the roll

This is the section that changed most across drafts. An early version of
this plan replaced combat with a deterministic type-chart/damage-calc
simulator — clean, but it throws away the thing that makes both the stage
and D&D itself feel the way they do: **a number that reads as a gradient,
adjudicated once, not a formula chased through six variables.** Keeping the
roll means battle stays a special case of the same mechanic as everything
else, not a different game bolted on.

| Piece | Today (the card) | After (the engine) |
|---|---|---|
| Resolution | Model invents a percentage-flavored outcome from vibes | `rules/roll.ts` — same difficulty-shifted %, same criticals at ≤5/≥95, actually rolled |
| Type matchup | Model narrates "for extra effect" | Advisory chart in `matchup.ts`, handed to the narrator as a hint on the roll's difficulty — never a damage multiplier |
| HP / status | Model states a number; nothing checks it | Model reports it under schema in the same reply; `rules/` clamps 0–100, enforces faint at 0, ticks status |
| Capture | "usually a waste of a ball" — model's judgment call | A roll, modified like difficulty by HP%, status and ball — advantage/disadvantage, not a lookup table |
| Levels & evolution | Model states a level; the scan reads it back later and offers it to the player | Reported in the same schema reply, validated against the parsed evolution edges immediately |
| Movesets | Deterministic generator, sent to the model as text | Unchanged — same generator, now also the move-button list in RPG mode |

So `rules/` stays small on purpose: `roll.ts`, `catch.ts`, `levels.ts`,
`verge.ts`, and an advisory `matchup.ts` — no `damage.ts`, no `accuracy.ts`
as a separate simulation. The model's job in battle is still to narrate an
exchange it's been given the odds on, exactly as today; the engine's job is
to make sure what it reports back afterward is checked and applied instead
of trusted and forgotten.

The crunch ladder still governs what shows, and this is where it earns its
keep: **Prose** rolls silently and narrates a fight with no numbers
anywhere. **Story** surfaces the block once a battle starts, still no
visible roll. **RPG** shows the readout on every change and swaps the
free-text box for move buttons — but the roll underneath is identical in
all three. The ladder was already a display concern in the stage; it stays
one here.

## 9. The Verge, cresting, the Tally

Region systems that only a real engine can hold — and they plug directly
into the roll rather than needing a system of their own:

- **Verge exposure** per route drives encounter level bands straight out of
  the gazetteer — the Shelf at Lv.15–25, inland routes 30–55, the
  Deepwilds uncapped.
- **Strain** accrues from the same signal that already nudges condition
  today (`applyOutcomeCondition`'s critical-success/critical-failure
  logic) — a Moémon pushed to level up on nothing but critical rolls burns
  Verge exposure faster than one earning it the slow way. Visible in the
  panel long before it matters, which is what makes it a decision rather
  than a punishment.
- **Cresting** is a real terminal state once strain crosses its threshold:
  she keeps the power and loses the rest. Every training choice in the
  game acquires a cost the moment this can actually happen.
- **The Tally** reads off party strength and gates what NPCs, Wardens and
  brokers will do — a number the world already claims to care about,
  finally computed.
- **Permits** gate travel: the Warden Service turns back a team that isn't
  ready, which is the region's answer to a level curve.

## 10. OpenRouter & the backend

Waidrin was built against a local llama.cpp server, which
grammar-constrains every response at the sampler — the model *cannot* emit
invalid JSON. OpenRouter routes to dozens of providers with wildly
different structured-output support, which is exactly the problem
`External.ts` already spent real effort solving. Targeting OpenRouter means
promoting that effort from "the scan's fallback plumbing" to core backend
infrastructure.

`DefaultBackend.getObject()` in Waidrin assumes strict `json_schema` just
works. Against OpenRouter it can't: a rejected schema, a reasoning model
that burns its budget thinking and never answers, a provider that ignores
`strict` entirely. `lib/backend.ts` needs the degradation ladder
`External.ts` already proved out, generalized from "the scan" to "every
constrained call":

1. **Try strict `json_schema`**, same as Waidrin does today.
2. **On a 400/422, retry without vendor-specific params** (OpenRouter's
   `reasoning` switch, as `postScan` already does) before concluding the
   endpoint can't do structured output at all.
3. **On no content but a full reasoning budget spent**, surface the fix in
   the connection UI directly — "raise the reply length" — rather than a
   bare timeout, exactly as `scanExternally` reports it today.
4. **On no schema support at all**, fall back to the delimited-line format
   `Scan.ts` parses today, described in the prompt instead of enforced by
   the API. This is the path that keeps a wide range of OpenRouter models
   usable rather than gating the whole game behind "supports strict JSON
   schema."

Everything else about the abstraction is unaffected: `getNarration` stays a
plain stream, `ConnectionSetup` keeps its API URL / key / model fields, and
the connection check ("does this backend honour a schema at all?") becomes
informative rather than pass/fail — it decides which tier of the ladder a
given model gets, not whether the game will run.

Default `apiUrl` becomes `https://openrouter.ai/api/v1`, matching
`normalizeEndpoint`'s existing default. The player's key stays in the
browser exactly as Waidrin already does it
(`dangerouslyAllowBrowser: true`) — this is a self-hosted single-player
app, not a stage running in someone else's iframe, so there's no third
party the key needs hiding from. A server-side proxy route is worth adding
only if this ever gets deployed somewhere public; it's not P0.

## 11. Frontend

Waidrin's shell stays: Radix theme, the scrolling event stream,
`ActionChoice`, `ProcessingBar`, `MainMenu`, `StateDebugger`. Two changes.

**The wizard becomes an outfitting sequence.** Welcome → Connection
(OpenRouter by default) → **Trainer** (name, pronouns, a biography generated
against Takane rather than a random world) → **Starter & entry point**
(Tanbark Town, a Shelf-appropriate starter list) → **Play settings** (crunch
ladder, difficulty, content levels) → play. Genre select goes; race and
gender go with it, since there's exactly one setting and it isn't chosen at
the table.

**The panel comes across whole.** `PartyPanel.tsx` is 1,150 lines of
genuinely good UI and most of it survives as Radix components: party rows
with portraits and the active slot, HP and status, bag, threads, characters
with affinity, the scene field, save data, and — unchanged — the **Prose /
Story / RPG switch** at the top, still the one crunch control. It gains
badges, money, the Tally and strain. It loses only the suggestion queue and
the scan log, replaced by the (optional) review-before-applying step on the
turn delta.

Portraits keep the existing contract exactly — masters in `public/moemon/`,
the slug rule in one file, `anchors.json` for crops, sharp re-encoding to
WebP at a 768px long edge. Only the plugin host changes, from a Vite plugin
to a prebuild script.

## 12. What gets deleted

Worth stating plainly, because it is most of the argument — and the roll
and the ladder are not on this list:

| Goes | Lines | Because |
|---|---|---|
| `Scan.ts` · `StoryLog.ts` | ~290 | The engine owns the turn; state is generated under a schema in the same reply, not recovered from prose afterward |
| `SuggestionsPanel` + suggestion/dismissal state | ~200 | Nothing to review when nothing was guessed. Survives only as an optional review-before-apply step |
| `trimTrailingBlock` · `buildPartySystemMessage` | ~60 | The panel is the readout; the model never writes one |
| Message/chat/init triad · `pendingConditions` · per-user keying | ~250 | One store, one player, one lifecycle |
| `chub_meta.yaml` · deploy workflow · `@chub-ai/stages-ts` | — | No host to satisfy |
| The card's PANEL section and repeated no-odds hedging | — | The panel is not a suggestion to a stranger's model any more |
| Waidrin's from-scratch world/genre/race generation | — | Takane is the anchor; nothing generates a world to replace it |

**Kept whole:** the roll and its criticals, the Prose/Story/RPG ladder, the
moveset generator, the items catalogue, the portrait pipeline, the
defensive parsers (now generalized into the backend's degradation ladder),
the save bundle, and every word of the lorebook. `External.ts`'s
retry-and-degrade logic specifically survives and gets promoted, not cut —
see §10.

## 13. Phasing

Ordered so there is something playable before the biggest piece lands.
Estimates assume one person working steadily, not full-time.

| Phase | Scope | Estimate |
|---|---|---|
| **P0** | Fork, rename, AGPL headers, biome/tsconfig, running against OpenRouter with a real key. Confirm the connection-check tier (§10) against two or three OpenRouter models before building anything on top of it. | 1–2 days |
| **P1** | Data and lore: `build-data.mjs`, the four generated modules, the codex index and injection. Tests that all 289 species and every evolution edge resolve. | 3–5 days |
| **P2** | State and wizard: new schemas and store, the Takane onboarding sequence, panel skeleton (ladder switch included from day one), chub save import. | 3–5 days |
| **P3** | Overworld loop: narration prompts decomposed from the card, `rules/roll.ts`, the structured delta and its validation, threads / characters / scene, travel and permits, generation anchored to the gazetteer. **First playable build.** | ~1 week |
| **P4** | Battle & the roll extended: `catch.ts`, `levels.ts`, `matchup.ts`, the battle state machine, move buttons in RPG mode, capture and evolution. Smaller than a damage-calc simulator would have been — no type-chart math to get right, just the roll applied to a second context. | 1 week |
| **P5** | Region systems: Verge exposure, strain and cresting, the Tally, gyms and badges, the rival, the Ledger's background thread. | ~1 week |
| **P6** | Polish and packaging: portraits and location artwork, save/export, rewind, distribution. Retire the chub stage — or keep shipping it, deliberately. | ongoing |

Keep the chub stage running and unchanged until P4 lands. There is no
reason to lose a working game to a half-built one.

## 14. Licensing & naming

Both settled:

- **Name:** Moemon Engine. "Takane" continues to name the in-game region
  only — it is not the project name.
- **License:** AGPL-3.0-or-later throughout, matching Waidrin's own. The
  stage code sits under Chub's `LICENSE.txt` today, but nearly all of it is
  being rewritten against Waidrin's abstractions rather than carried over
  file-for-file; the pieces that do come across largely as-is — the
  moveset generator, the items catalogue, and the lorebook — are original
  work from this repo's own author, so relicensing them under AGPL-3.0 as
  part of the fork needs no one else's permission. Apply the AGPL header at
  P0, alongside the rename, rather than revisiting it later.

---

*Written against `Crunchatize_pokemon @ bb689c8` and `waidrin @ 1171787`.
Line counts are from the current tree. Estimates are ranges, not
commitments.*
