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

    // A curated set is the species' characteristic four, used whole at any
    // level. It used to be filtered by level - the first N moves at low
    // levels, the rest filled from the type pool - which quietly assumed
    // every curated list ran basic to advanced. Half of them don't (an
    // evolved species is generally written strongest-first), so a Lv.5
    // Bulbasaur got Tackle and a Lv.5 Blastoise got Hydro Pump. There is no
    // way to verify that ordering across 160 hand-written entries, so the
    // contract is gone rather than silently half-kept: the level window now
    // applies only where it can be trusted, to the ordered type pools.
    const curated = speciesTable[info.name.toLowerCase()];
    if (curated) {
        const moves = curated.moves.filter(move => move.length > 0);
        return {nickname: '', level, moves: padToFour(moves), heldItem: curated.item ?? primary.item};
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

    return {nickname: '', level, moves: padToFour(moves), heldItem: primary.item};
}
