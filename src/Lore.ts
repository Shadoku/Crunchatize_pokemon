import loreData from "./assets/moemonLore.json";
import {MoemonType} from "./MoemonType";

export interface SpeciesInfo {
    name: string;
    types: MoemonType[];
    content: string;
}

interface LoreEntry {
    name: string;
    content: string;
    constant: boolean;
}

const TYPE_TAG_PATTERN = /\ban? ([A-Za-z]+(?:\/[A-Za-z]+)?)-type girl/;

function parseTypes(content: string): MoemonType[] {
    const match = content.match(TYPE_TAG_PATTERN);
    if (!match) return [];
    return match[1]
        .split('/')
        .filter((token): token is MoemonType => (Object.values(MoemonType) as string[]).includes(token));
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Species (non-constant entries) keyed by lowercase name; location/NPC/item
// entries are 'constant' in the lorebook and aren't moemon party members.
const speciesIndex: Map<string, SpeciesInfo> = new Map();
for (const entry of Object.values(loreData.entries) as LoreEntry[]) {
    if (entry.constant) continue;
    speciesIndex.set(entry.name.toLowerCase(), {
        name: entry.name,
        types: parseTypes(entry.content),
        content: entry.content
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
    return speciesIndex.get(name.toLowerCase());
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
