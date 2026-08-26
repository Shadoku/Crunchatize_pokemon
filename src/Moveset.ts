import moveData from "./assets/moemonMoves.json";
import {MoemonType} from "./MoemonType";
import {getSpecies} from "./Lore";
import {PartyMemberDetails, DEFAULT_DETAILS} from "./Party";

interface TypeEntry {
    item: string;
    moves: string[];
}

interface SpeciesEntry {
    moves: string[];
    item?: string;
}

const typeTable = moveData.types as {[type: string]: TypeEntry};
const speciesTable = moveData.species as {[species: string]: SpeciesEntry};

// Stable per-species offset, so a species always draws the same slice of its
// type pool - the same moemon looks identical in every chat and across
// reloads - while different species of the same type don't all come out with
// an identical moveset.
function speciesOffset(name: string): number {
    let hash = 0;
    for (let index = 0; index < name.length; index++) {
        hash = (hash * 31 + name.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
}

function pick(pool: string[], offset: number, count: number): string[] {
    const chosen: string[] = [];
    for (let index = 0; index < count && index < pool.length; index++) {
        chosen.push(pool[(offset + index) % pool.length]);
    }
    return chosen;
}

function padToFour(moves: string[]): string[] {
    return [0, 1, 2, 3].map(index => moves[index] ?? '');
}

// The moves and held item a newly-added party member starts with. Curated
// entries win; everything else is drawn from its type pool, which covers
// every species in the lorebook.
export function defaultDetailsFor(species: string): PartyMemberDetails {
    const info = getSpecies(species);
    if (!info) return DEFAULT_DETAILS;

    const types: MoemonType[] = info.types;
    const primary = typeTable[types[0]] ?? typeTable[MoemonType.Normal];

    const curated = speciesTable[info.name.toLowerCase()];
    if (curated) {
        return {
            level: DEFAULT_DETAILS.level,
            moves: padToFour(curated.moves),
            heldItem: curated.item ?? primary.item
        };
    }

    const offset = speciesOffset(info.name);
    // Dual types split their slots so both halves of the matchup show up;
    // single types just take four from their own pool.
    const moves = types.length > 1 && typeTable[types[1]]
        ? [...pick(primary.moves, offset, 2), ...pick(typeTable[types[1]].moves, offset, 2)]
        : pick(primary.moves, offset, 4);

    return {
        level: DEFAULT_DETAILS.level,
        moves: padToFour(moves),
        heldItem: primary.item
    };
}
