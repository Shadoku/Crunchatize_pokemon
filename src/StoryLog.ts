// The stretch of story the stage carries itself.
//
// The built-in scan never needed this: it asks the platform for the chat's
// history and the platform supplies it. A model reached directly (External.ts)
// has no such route, so the story has to travel with the request, which means
// the stage has to have kept it.
//
// It has tried before. An earlier version kept a buffer on the instance, which
// could only be written from inside a lifecycle hook and so was empty on any
// chat opened fresh - the scan button quietly did nothing, and it took a while
// for anyone to notice. This log lives in message state instead: message state
// is handed back on load and on every swipe, so the log survives a reload and
// rewinds with the story rather than carrying a branch's events into a branch
// where they never happened.
//
// Message state is paid for per message, so the log is capped three ways: how
// many turns it keeps, how much of any one turn it keeps, and how much it may
// come to in total.

export interface StoryEntry {
    // Whose turn this was, as the scan should see it: the player's name, or
    // the narrator's.
    who: string;
    text: string;
}

// Enough turns for a scan at the default interval (ten) to see the whole
// stretch it is meant to be reviewing, with a little room either side.
const MAX_ENTRIES = 12;

// One reply cannot crowd out the ten around it. A long reply is cut from the
// front rather than the back: what a scan is looking for - who joined, where
// the scene moved to, what was resolved - lands at the end of a turn far more
// often than at the start of one.
const MAX_ENTRY_CHARS = 1200;

// The ceiling on the whole transcript, trimmed oldest-first. Roughly a
// thousand tokens of story, which is the sort of window this scan is for.
const MAX_TOTAL_CHARS = 6000;

function clampEntryText(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > MAX_ENTRY_CHARS
        ? `…${trimmed.slice(trimmed.length - MAX_ENTRY_CHARS)}`
        : trimmed;
}

// Reads the log back from (untyped) message state, dropping anything
// malformed - the same defensiveness autoParty and partyStatus get, and for
// the same reason: this state is persisted, so a change in shape has to land
// softly on chats already saved.
export function parseStoryLog(raw: any): StoryEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim().length > 0)
        .map(entry => ({
            who: typeof entry.who === 'string' && entry.who.trim() ? entry.who.trim() : 'Narrator',
            text: clampEntryText(entry.text)
        }))
        .slice(-MAX_ENTRIES);
}

// Adds a turn, returning a new log rather than mutating the old one: the log
// is written into message state, and a message state that shares an array with
// the next one is how a swipe ends up rewriting the branch it came from.
//
// An empty turn is not recorded at all - it would spend an entry's worth of
// the window saying nothing.
export function appendStoryEntry(log: StoryEntry[], who: string, text: string): StoryEntry[] {
    const entry = {who: who.trim() || 'Narrator', text: clampEntryText(text ?? '')};
    if (!entry.text) return log;

    const appended = [...log, entry].slice(-MAX_ENTRIES);

    // Then the total: drop whole turns off the front until the rest fits. The
    // newest turn is kept even if it alone is over the ceiling, since a scan
    // with nothing recent to read has nothing to report.
    let total = appended.reduce((sum, item) => sum + item.text.length, 0);
    while (appended.length > 1 && total > MAX_TOTAL_CHARS) {
        total -= appended[0].text.length;
        appended.shift();
    }
    return appended;
}

// The log as the external model reads it. Speaker-labelled, oldest first -
// the same order the story happened in.
export function renderTranscript(log: StoryEntry[]): string {
    return log.map(entry => `${entry.who}: ${entry.text}`).join('\n\n');
}
