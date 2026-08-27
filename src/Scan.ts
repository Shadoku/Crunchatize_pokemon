// The story scanner's vocabulary and its parser.
//
// The stage's model surface offers no JSON mode, no schema constraint and no
// temperature - sampler config belongs to the player, and the model behind a
// given chat could be anything. Asking such a model for one well-formed JSON
// object is the fragile choice: a stray comma, an unescaped quote, or a reply
// cut off at max_tokens loses the whole scan. So the scan asks for one
// detection per line instead. Every line parses on its own, so a truncated or
// partly-garbled reply still yields the lines that did arrive.

export type SuggestionKind = 'party' | 'quest' | 'quest-done' | 'npc' | 'scene' | 'condition';

// A detection as it comes off the wire: a verb and its fields, with nothing
// yet checked against the lorebook or the chat's own state.
export interface RawDetection {
    kind: SuggestionKind;
    value: string;
    detail: string;
}

// A detection that survived validation and is waiting on the player.
export interface Suggestion {
    id: string;
    kind: SuggestionKind;
    // Species, thread text, character name, or scene text.
    value: string;
    // Character note, condition, or the id of the thread being resolved.
    detail: string;
    // What the panel shows.
    description: string;
}

// A rejection, remembered so the same guess doesn't come back every scan.
// Keyed to the scan it happened on, so it can expire: the story may keep
// insisting on something the player waved off early.
export interface Dismissal {
    key: string;
    scan: number;
}

// The verbs the scan may use, mapped from what the model actually writes.
const VERBS: {[verb: string]: SuggestionKind} = {
    PARTY: 'party',
    QUEST: 'quest',
    RESOLVED: 'quest-done',
    NPC: 'npc',
    SCENE: 'scene',
    CONDITION: 'condition'
};

// A rambling model shouldn't be able to bury the panel. Well past what a
// handful of turns can plausibly change.
const MAX_DETECTIONS = 12;

// Long enough for a thread or a scene, short enough that a model that starts
// narrating instead of reporting gets truncated rather than pasted in whole.
const MAX_FIELD_LENGTH = 200;

export function newSuggestionId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// What a dismissal is remembered by. Normalised so trivial rewording of the
// same suggestion is still recognised as the one already refused.
export function suggestionKey(kind: SuggestionKind, value: string): string {
    return `${kind}:${value.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

// Drops a ``` fence if the model wrapped its reply in one. Only the fence
// lines go - the content between them is the reply.
function stripFences(raw: string): string {
    return raw
        .split('\n')
        .filter(line => !/^\s*```/.test(line))
        .join('\n');
}

// Strips list decoration a model adds out of habit: "- ", "* ", "1. ", "1) ".
function stripBullet(line: string): string {
    return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '');
}

function trimField(value: string): string {
    return value.trim().slice(0, MAX_FIELD_LENGTH).trim();
}

// Reads the scan's reply into detections. Anything that isn't a recognised
// verb with a payload is skipped rather than guessed at - a model that
// answers in prose simply yields nothing, which reads to the player as "no
// changes found" rather than as noise to clear out.
export function parseScanOutput(raw: string | null | undefined): RawDetection[] {
    if (!raw) return [];

    const detections: RawDetection[] = [];
    for (const line of stripFences(raw).split('\n')) {
        if (detections.length >= MAX_DETECTIONS) break;

        const cleaned = stripBullet(line).trim();
        if (!cleaned) continue;

        const fields = cleaned.split('|').map(field => field.trim());
        // Letters only, so "PARTY:", "**PARTY**" and "party" all land on the
        // same verb.
        const verb = fields[0].toUpperCase().replace(/[^A-Z]/g, '');
        const kind = VERBS[verb];
        if (!kind) continue;

        const value = trimField(fields[1] ?? '');
        if (!value) continue;

        detections.push({kind, value, detail: trimField(fields[2] ?? '')});
    }
    return detections;
}

// Reads suggestions back from persisted (untyped) chat state, dropping
// anything malformed - the same defensiveness the rest of the stage's
// persisted lists get.
const KINDS: SuggestionKind[] = Object.values(VERBS);

export function parseSuggestions(raw: any): Suggestion[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(item => item
            && typeof item.value === 'string' && item.value.trim().length > 0
            && KINDS.includes(item.kind))
        .map(item => ({
            id: typeof item.id === 'string' && item.id.length > 0 ? item.id : newSuggestionId(),
            kind: item.kind as SuggestionKind,
            value: item.value.trim(),
            detail: typeof item.detail === 'string' ? item.detail.trim() : '',
            description: typeof item.description === 'string' && item.description.trim().length > 0
                ? item.description.trim()
                : describeSuggestion(item.kind, item.value, item.detail ?? '')
        }));
}

export function parseDismissals(raw: any): Dismissal[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(item => item && typeof item.key === 'string' && item.key.length > 0)
        .map(item => ({key: item.key, scan: Number.isFinite(Number(item.scan)) ? Number(item.scan) : 0}));
}

// The one-line summary shown in the panel. Written as what would happen if
// the player said yes, since that's the decision in front of them.
export function describeSuggestion(kind: SuggestionKind, value: string, detail: string): string {
    switch (kind) {
        case 'party': return `${value} joins the party`;
        case 'quest': return `New thread: ${value}`;
        case 'quest-done': return `Thread resolved: ${value}`;
        case 'npc': return detail ? `Remember ${value} - ${detail}` : `Remember ${value}`;
        case 'scene': return `Scene: ${value}`;
        case 'condition': return `${value} is ${detail}`;
        default: return value;
    }
}
