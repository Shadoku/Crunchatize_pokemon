import speciesData from "./assets/moemonSpecies.json";
import {MoemonType} from "./MoemonType";
import {slugifySpecies} from "./slug";

export interface SpeciesInfo {
    name: string;
    types: MoemonType[];
}

interface SpeciesRecord {
    name: string;
    types: string[];
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Generated from lorebook/moemon-lore.json by scripts/sync-lore.mjs, which is
// also what decides that an entry is a moemon at all (it carries a species
// type tag) rather than a town, an item or a person. Keeping that rule in one
// place is deliberate: the stage used to infer it from a flag that existed
// only in its private copy of the book, so re-exporting the book from chub
// turned every location and item into a catchable moemon.
const speciesIndex: Map<string, SpeciesInfo> = new Map();
for (const record of (speciesData.species as SpeciesRecord[])) {
    speciesIndex.set(record.name.toLowerCase(), {
        name: record.name,
        types: record.types.filter((token): token is MoemonType =>
            (Object.values(MoemonType) as string[]).includes(token))
    });
}

export const speciesNames: string[] = Array.from(speciesIndex.values())
    .map(species => species.name)
    .sort((a, b) => a.localeCompare(b));

// Longest names first, so a match like 'Nidoran' checked against
// 'Nidoran♀' etc. never has an opportunity to shadow the longer form.
const matchers: {name: string; regex: RegExp}[] = speciesNames
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(name => ({name, regex: new RegExp(`\\b${escapeRegex(name)}(?![A-Za-z0-9])`, 'i')}));

export function getSpecies(name: string): SpeciesInfo | undefined {
    return speciesIndex.get(name.trim().toLowerCase());
}

// Re-exported so existing callers can keep importing it from here.
export {slugifySpecies};

// Portraits are always requested as WebP. The build re-encodes the masters in
// public/moemon/ to that, and the dev server converts them on the fly, so the
// master on disk can be a .png/.jpg of any size.
export function speciesImageUrl(name: string): string {
    return `/moemon/${slugifySpecies(name)}.webp`;
}

// Finds every lorebook species mentioned by name in a block of free text,
// e.g. narration or a user's action, in longest-match-first order.
export function findSpeciesMentions(text: string): string[] {
    const found: string[] = [];
    for (const {name, regex} of matchers) {
        if (regex.test(text)) {
            found.push(name);
        }
    }
    return found;
}
