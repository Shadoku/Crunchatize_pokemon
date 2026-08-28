// A recurring character the story keeps coming back to, and how the player
// stands with them. Name and note are what the narrator is reminded of;
// affinity is nudged by how checks involving them land.
export interface NpcEntry {
    name: string;
    note: string;
    affinity: number;
}

// Affinity is deliberately a short scale rather than an open counter: it's
// reference for the narrator, not a stat to grind, and a bounded range keeps
// it describable in a few words.
export const AFFINITY_MIN = -5;
export const AFFINITY_MAX = 5;

export function clampAffinity(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(Math.round(value), AFFINITY_MIN), AFFINITY_MAX);
}

export function sameNpc(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// How an NPC's standing reads to the narrator. The number itself is never
// sent - "warming" carries the same information and reads as characterization
// rather than as a score the player is expected to farm. Deliberately phrased
// without naming the player: the roster note is appended after the {{user}}
// tags in stage directions have already been substituted, so a tag here would
// reach the LLM unreplaced.
export function describeAffinity(affinity: number): string {
    if (affinity >= 4) return 'devoted';
    if (affinity >= 2) return 'friendly';
    if (affinity >= 1) return 'warming';
    if (affinity <= -4) return 'hostile';
    if (affinity <= -2) return 'resentful';
    if (affinity <= -1) return 'wary';
    return 'neutral';
}

// Reads back an NPC list from persisted (untyped) chat state, dropping
// anything malformed and normalising affinities into range.
export function parseNpcs(raw: any): NpcEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(npc => npc && typeof npc.name === 'string' && npc.name.trim().length > 0)
        .map(npc => ({
            name: npc.name.trim(),
            note: typeof npc.note === 'string' ? npc.note.trim() : '',
            affinity: clampAffinity(Number(npc.affinity))
        }));
}
