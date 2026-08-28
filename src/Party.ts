import {MoemonType} from "./MoemonType";
import {getSpecies} from "./Lore";

export type PartySource = 'auto' | 'manual';

// One active moemon and five in balls, the same limit the card narrates.
export const MAX_PARTY = 6;

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

// A member's battle-readiness. Tracked separately from PartyMemberDetails
// (the "build") since it's a running consequence of play, not something a
// player sets and forgets - it belongs with message state, not the chat-wide
// roster, so it rewinds with a swipe the same way the story does.
export type Condition = 'ok' | 'hurt' | 'fainted';

// Ordered worst-to-best, so a step down/up is just an index shift.
const CONDITION_ORDER: Condition[] = ['fainted', 'hurt', 'ok'];

export function stepConditionDown(condition: Condition): Condition {
    const index = CONDITION_ORDER.indexOf(condition);
    return CONDITION_ORDER[Math.max(index - 1, 0)];
}

export function stepConditionUp(condition: Condition): Condition {
    const index = CONDITION_ORDER.indexOf(condition);
    return CONDITION_ORDER[Math.min(index + 1, CONDITION_ORDER.length - 1)];
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

// Reads a roster back from an untyped source - persisted chat state, or a
// save bundle pasted into the import box. Anything that doesn't name a real
// species is dropped, and details are normalised through detailsOf, so a
// hand-edited or truncated bundle degrades to a smaller party rather than
// throwing.
export function parseParty(raw: any, source: PartySource = 'manual'): PartyMember[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const party: PartyMember[] = [];
    for (const member of raw) {
        if (!member || typeof member.species !== 'string') continue;
        const info = getSpecies(member.species);
        if (!info) continue;
        // Canonical casing from the lorebook, so an imported "pikachu"
        // matches everything keyed off the species name.
        if (seen.has(info.name.toLowerCase())) continue;
        seen.add(info.name.toLowerCase());
        party.push({species: info.name, source, details: detailsOf(member)});
    }
    return party;
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
