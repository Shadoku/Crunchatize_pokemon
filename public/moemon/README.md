# Party panel artwork

Drop a `.png` per species in this folder and the party panel will pick it up
automatically. Missing artwork just leaves a blank thumbnail, so you can add
these incrementally.

## Naming

Lowercase the species name and strip everything but letters/numbers (spaces,
apostrophes, periods, hyphens all disappear); ♀/♂ become `f`/`m`.

| Species      | Filename          |
|--------------|-------------------|
| Charmander   | `charmander.png`  |
| Nidoran♀     | `nidoranf.png`    |
| Nidoran♂     | `nidoranm.png`    |
| Farfetch'd   | `farfetchd.png`   |
| Mr. Mime     | `mrmime.png`      |
| Ho-Oh        | `hooh.png`        |
| Mime Jr.     | `mimejr.png`      |
| Porygon-Z    | `porygonz.png`    |

See `speciesImageUrl`/`slugifySpecies` in `src/Lore.ts` for the exact rule.
