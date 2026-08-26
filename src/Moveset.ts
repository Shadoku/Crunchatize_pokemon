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

// The level at which a member draws from the very top of its type pool;
// past this, higher levels change nothing.
const MASTERY_LEVEL = 70;

// How far up a curated species' signature moves come in. A freshly caught
// moemon knows one of them and fills the rest with type basics; by 40 it has
// the whole characteristic set.
const SIGNATURE_UNLOCKS = [1, 12, 25, 40];

// Stable per-species jitter, so two same-type moemon of the same level don't
// come out with a byte-identical moveset.
function speciesJitter(name: string): number {
    let hash = 0;
    for (let index = 0; index < name.length; index++) {
        hash = (hash * 31 + name.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % 2;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}

// 0 at level 1, 1 at MASTERY_LEVEL and beyond.
function advancement(level: number): number {
    return clamp((level - 1) / (MASTERY_LEVEL - 1), 0, 1);
}

// A window of `count` moves from a basic -> advanced pool, positioned by
// level: low levels sit at the basic end, high levels at the advanced end.
function windowForLevel(pool: string[], count: number, level: number, jitter: number): string[] {
    const maxStart = Math.max(pool.length - count, 0);
    const start = clamp(Math.round(advancement(level) * maxStart) + jitter, 0, maxStart);
    return pool.slice(start, start + count);
}

function padToFour(moves: string[]): string[] {
    return [0, 1, 2, 3].map(index => moves[index] ?? '');
}

// Fills up to `count` distinct moves, taking each group in priority order.
// Later groups act as backfill when earlier ones overlap.
function takeUnique(count: number, ...groups: string[][]): string[] {
    const chosen: string[] = [];
    for (const group of groups) {
        for (const move of group) {
            if (chosen.length >= count) return chosen;
            if (!chosen.includes(move)) chosen.push(move);
        }
    }
    return chosen;
}

// The moves and held item a party member has at a given level. Curated
// entries define a species' signature set; everything else is drawn from its
// type pool. Deterministic - the same species at the same level always comes
// out identical.
export function defaultDetailsFor(species: string, level: number = DEFAULT_DETAILS.level): PartyMemberDetails {
    const info = getSpecies(species);
    if (!info) return {...DEFAULT_DETAILS, level};

    const types: MoemonType[] = info.types;
    const primary = typeTable[types[0]] ?? typeTable[MoemonType.Normal];
    const jitter = speciesJitter(info.name);

    const curated = speciesTable[info.name.toLowerCase()];
    if (curated) {
        const signature = curated.moves.filter(move => move.length > 0);
        // A deliberately sparse entry (Ditto's Transform, Unown's Hidden
        // Power) is the whole moveset at any level - don't pad it out.
        const moves = signature.length < 4
            ? signature
            : fillWithBasics(signature, primary.moves, level);
        return {level, moves: padToFour(moves), heldItem: curated.item ?? primary.item};
    }

    // Dual types split their slots so both halves of the matchup show up.
    // A few moves (Sandstorm) sit in two pools, so the halves are merged
    // uniquely and backfilled from wider windows rather than concatenated.
    const secondary = types.length > 1 ? typeTable[types[1]] : undefined;
    const moves = secondary
        ? takeUnique(4,
            windowForLevel(primary.moves, 2, level, jitter),
            windowForLevel(secondary.moves, 2, level, jitter),
            windowForLevel(primary.moves, 4, level, jitter),
            windowForLevel(secondary.moves, 4, level, jitter))
        : windowForLevel(primary.moves, 4, level, jitter);

    return {level, moves: padToFour(moves), heldItem: primary.item};
}

// Signature moves come in as the member levels; any slot not yet earned is
// filled from the basic end of its type pool.
function fillWithBasics(signature: string[], pool: string[], level: number): string[] {
    const earned = Math.max(SIGNATURE_UNLOCKS.filter(unlock => level >= unlock).length, 1);
    const known = signature.slice(0, earned);
    for (const move of pool) {
        if (known.length >= 4) break;
        if (!known.includes(move) && !signature.includes(move)) known.push(move);
    }
    return known;
}
