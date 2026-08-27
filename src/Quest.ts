// An open plot thread the player wants the narrator to keep in mind. Unlike
// party members, quests have no closed vocabulary to match against - the
// lorebook can name every species, but not every story - so these are
// entered by hand rather than detected from narration.
export interface QuestEntry {
    id: string;
    text: string;
    done: boolean;
}

// Ids only have to be unique within one chat's list, and the list is small
// and player-paced, so a timestamp plus a short random tail is plenty - and
// avoids depending on crypto.randomUUID, which isn't guaranteed in every
// embedded frame the stage runs in.
export function newQuestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Reads back a quest log from persisted (untyped) chat state, dropping
// anything malformed and backfilling ids for entries written before they
// existed - or by hand, through the import panel.
export function parseQuests(raw: any): QuestEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(quest => quest && typeof quest.text === 'string' && quest.text.trim().length > 0)
        .map(quest => ({
            id: typeof quest.id === 'string' && quest.id.length > 0 ? quest.id : newQuestId(),
            text: quest.text.trim(),
            done: quest.done === true
        }));
}
