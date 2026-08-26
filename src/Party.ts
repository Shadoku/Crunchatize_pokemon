import {MoemonType} from "./MoemonType";
import {getSpecies} from "./Lore";

export type PartySource = 'auto' | 'manual';

// A party member's editable "build" - nickname, level, moveset, held item.
// Chat-wide, not message-state: unlike position/HP this shouldn't reset on
// a swipe/branch.
export interface PartyMemberDetails {
    nickname: string;
    level: number;
    moves: string[];
    heldItem: string;
}

export const DEFAULT_DETAILS: PartyMemberDetails = {
    nickname: '',
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
        nickname: typeof details.nickname === 'string' ? details.nickname.trim() : DEFAULT_DETAILS.nickname,
        level: typeof details.level === 'number' ? details.level : DEFAULT_DETAILS.level,
        moves: Array.isArray(details.moves) ? [0, 1, 2, 3].map(i => details.moves[i] ?? '') : DEFAULT_DETAILS.moves,
        heldItem: typeof details.heldItem === 'string' ? details.heldItem : DEFAULT_DETAILS.heldItem
    };
}

// What to call a member in the UI: their nickname if they have one.
export function displayNameOf(member: PartyMember): string {
    return detailsOf(member).nickname || member.species;
}

// How a member is named to the LLM: a nicknamed moemon is introduced as
// "Sparky" (Pikachu) so the narrator knows both, and can use the nickname.
export function labelFor(member: PartyMember, extra: string[] = []): string {
    const nickname = detailsOf(member).nickname;
    const inParens = [...(nickname ? [member.species] : []), ...extra].join(', ');
    const head = nickname ? `"${nickname}"` : member.species;
    return inParens ? `${head} (${inParens})` : head;
}
