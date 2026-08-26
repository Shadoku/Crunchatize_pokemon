import {MoemonType} from "./MoemonType";
import {getSpecies} from "./Lore";

export type PartySource = 'auto' | 'manual';

// A party member's editable "build" - level, moveset, and held item.
// Chat-wide, not message-state: unlike position/HP this shouldn't reset on
// a swipe/branch.
export interface PartyMemberDetails {
    level: number;
    moves: string[];
    heldItem: string;
}

export const DEFAULT_DETAILS: PartyMemberDetails = {
    level: 5,
    moves: ['', '', '', ''],
    heldItem: ''
};

export interface PartyMember {
    species: string;
    source: PartySource;
    details: PartyMemberDetails;
}

export function typesOf(member: PartyMember): MoemonType[] {
    return getSpecies(member.species)?.types ?? [];
}

// Defensively fills in details for a member read back from persisted state
// (chat/message state is untyped, so a member saved before this field
// existed - or corrupted externally - may be missing it).
export function detailsOf(member: PartyMember): PartyMemberDetails {
    const details = member.details;
    if (!details || typeof details !== 'object') return DEFAULT_DETAILS;
    return {
        level: typeof details.level === 'number' ? details.level : DEFAULT_DETAILS.level,
        moves: Array.isArray(details.moves) ? [0, 1, 2, 3].map(i => details.moves[i] ?? '') : DEFAULT_DETAILS.moves,
        heldItem: typeof details.heldItem === 'string' ? details.heldItem : DEFAULT_DETAILS.heldItem
    };
}
