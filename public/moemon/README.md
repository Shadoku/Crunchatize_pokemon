# Party panel artwork

Drop one image per species in this folder and the party panel will pick it up
automatically. Missing artwork just leaves a blank thumbnail, so you can add
these incrementally.

These are the **masters**: keep them at full quality and whatever size they
were drawn at. They are never shipped as-is — see [Build handling](#build-handling).
`.png`, `.jpg` and `.webp` are all accepted.

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

## Build handling

`yarn build` re-encodes every master here to **WebP with a 768px long edge**
and writes only those into `dist/`. The masters themselves, this README and
`.gitkeep` are all left out of the build, so the deploy zip stays small no
matter how large the source art is — a 1.1 MB PNG comes out around 37 KB.

`yarn dev` does the same conversion on the fly, so what you see locally
matches what deploys. Nothing needs regenerating by hand and no optimised
copies get checked in.

The size and quality live at the top of `scripts/vite-plugin-portraits.ts`.
That step needs `sharp`, which `yarn install` provides; if it is ever
unavailable the build still succeeds and warns, shipping the full-size
masters instead.

## Cropping

Party rows show a square crop of the portrait. The crop is anchored to the
**top** of a portrait image and the **left** of a landscape one — normally
where the face is — rather than centred. Clicking a portrait opens the full,
uncropped image.

To shift the crop for a particular moemon, add an entry to `anchors.json`
here. The value is `0`–`1`: `0` is top/left (the default), `0.5` centres it,
`1` pushes it to the bottom/right.

```json
{
  "charizard": 0.2,
  "Mr. Mime": 0.35,
  "default": 0
}
```

Keys accept a species name in any form (`Mr. Mime`, `mr. mime` and `mrmime`
all match). The special key `default` changes the fallback for every portrait
without its own entry. Keys starting with `_` are ignored, so you can leave
comments in the file. The whole file is optional — if it's missing or
malformed, every portrait just uses the default anchor.
