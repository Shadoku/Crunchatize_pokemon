import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Action} from "./Action";
import {
    Outcome, ROLL_MIN, ROLL_MAX, NO_ROLL_DIRECTION,
    rollDirection, isCriticalSuccess, isCriticalFailure
} from "./Outcome";
import {getSpecies, findSpeciesMentions, escapeRegex} from "./Lore";
import {
    PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, displayNameOf, labelFor, typesOf,
    Condition, stepConditionDown, stepConditionUp, parseParty, MAX_PARTY
} from "./Party";
import {defaultDetailsFor} from "./Moveset";
import {InventoryItem, parseInventory, sameItem} from "./Inventory";
import {QuestEntry, parseQuests, newQuestId} from "./Quest";
import {NpcEntry, parseNpcs, clampAffinity, sameNpc, describeAffinity} from "./Npc";
import {PlayMode, DEFAULT_MODE, parseMode, parseModeOrNull, modeRolls, modeDirection} from "./Mode";
import {
    Suggestion, Dismissal, RawDetection, SuggestionKind,
    parseScanOutput, parseSuggestions, parseDismissals,
    suggestionKey, describeSuggestion, newSuggestionId
} from "./Scan";
import {ExternalScanConfig, readExternalConfig, scanExternally} from "./External";
import {StoryEntry, parseStoryLog, appendStoryEntry, renderTranscript} from "./StoryLog";
import {PartyPanel} from "./PartyPanel";

type MessageStateType = any;

type ConfigType = any;

type InitStateType = any;

type ChatStateType = any;

/*
  nvm use 21.7.1
  yarn install (if dependencies have changed)
  yarn dev --host --mode staging
*/

interface UserState {
    // Moemon detected automatically from the character roster, the player's
    // own messages, and narration. Tied to message state, since it should
    // track the story's progression through the chat tree.
    autoParty: PartyMember[];
    lastOutcome: Outcome|null;
    lastOutcomePrompt: string;
    // The play mode the narrator was last told about. Kept so the mode line
    // is sent when it changes rather than restated every turn, and so a
    // rewind re-announces whatever mode that part of the story was told.
    lastModeSent: PlayMode|null;
    // Prompts since the roster was last put in front of the LLM. Lives in
    // message state so rewinding the chat rewinds the cadence with it.
    turnsSinceRoster: number;
    // Condition (ok/hurt/fainted) per party member, keyed by lowercase
    // species. Lives in message state, not the chat-wide roster: it's a
    // running consequence of play, so a swipe should rewind it along with
    // the story rather than carry it into a branch where it never happened.
    partyStatus: {[speciesLower: string]: Condition};
    // Prompts since the story was last scanned. Message state, so the cadence
    // rewinds with the story exactly like turnsSinceRoster. Written from
    // inside afterResponse, which is the only place message state can be
    // written from - see runScan for what happened when that was forgotten.
    turnsSinceScan: number;
}

// How many prompts pass between roster reminders. The roster is reference
// material, not per-turn instruction, so repeating it every turn just spends
// tokens restating what rarely changes.
const DEFAULT_ROSTER_INTERVAL = 6;

// Percentage points one step of the configured difficulty modifier is worth.
const DIFFICULTY_POINTS_PER_STEP = 5;

// Bounds on the configured difficulty modifier. Past six steps either way the
// roll is pinned to 0 or 100 and the dice stop meaning anything, so the config
// is clamped here as well as in the schema.
const MAX_DIFFICULTY_STEPS = 6;

// The stage posts its party readout as a fenced block under each reply, and
// models copy it. This strips that copy - and only that: it must match the
// stage's own shape (a trailing fence whose contents are the readout's own
// labels) and it must be at the end.
//
// It used to be `content.split(/---|\*\*\*|```|system:/i)[0]`, which deleted
// everything after the first horizontal rule, the first ***emphasis*** or the
// first code fence anywhere in the reply. On a card that ends scenes with a
// stat block, that silently ate the block; on any card at all, one italicised
// aside ate the rest of the message.
const ECHOED_READOUT = /\n*(?:^|\n)-{3,}\s*\n*```[^\n]*\n(?<body>[\s\S]*?)```\s*$/;

export function trimTrailingBlock(content: string): string {
    const match = content.match(ECHOED_READOUT);
    const body = match?.groups?.body ?? '';
    if (match && /'s (Party|Bag):/i.test(body)) {
        return content.slice(0, match.index).trimEnd();
    }
    return content.trim();
}

// What resolveAction worked out: the roll, and who the stage decided was
// taking the action. The member travels with it so the directions can say
// what she's carrying without hunting for her again by name.
interface ResolvedAction {
    outcome: Outcome;
    actingMember: PartyMember|undefined;
}

// Beyond this many tracked NPCs, only the most recently added are put in
// front of the LLM - the roster note is reference material, not a directory.
const MAX_NPCS_IN_NOTE = 6;

// Stamped into exported bundles. Nothing reads it yet - every field is
// validated on import regardless - but it's what a future format change
// would branch on to migrate an older save instead of rejecting it.
const SAVE_VERSION = 1;

// How many prompts pass between story scans, when the player hasn't said.
const DEFAULT_SCAN_INTERVAL = 10;

// The scan blocks nothing - it's fired and forgotten, and its findings land
// in the panel whenever they arrive - so it can afford to be far more patient
// than the classifier, which runs inside a hook Chub is waiting on.
const SCAN_TIMEOUT_MS = 30000;

// Room for a dozen one-line detections and no more; the scan is meant to
// report, not narrate.
const SCAN_MAX_TOKENS = 256;

// How many scans a rejection is remembered for. At the default interval
// that's roughly fifty turns - long enough that a wrong guess stops nagging,
// short enough that a story genuinely insisting on something can raise it
// again.
const DISMISSAL_LIFETIME_SCANS = 5;

// What a scan did, so the panel can tell "found nothing" from "never ran".
// Which model answered travels with it as well: a player who has paid for an
// external scan is owed the difference between it having run and it having
// quietly handed the work back to the chat's own model.
export interface ScanOutcome {
    ok: boolean;
    found: number;
    reason?: 'busy' | 'failed';
    source?: 'external' | 'builtin';
    // Set when the external scan was configured but did not answer, so the
    // built-in scan stood in for it.
    fellBack?: boolean;
    // Set when the external scan was configured but there was no recorded
    // story to send it yet - the log starts empty on a chat that was already
    // under way when the setting was switched on.
    noStoryYet?: boolean;
}

// Chat-wide (not tied to a branch) record of what the player has set up by
// hand in the panel: their explicit party edits, and their bag. Both are
// edited outside the normal lifecycle hooks, so they're persisted straight
// through the messenger rather than returned from beforePrompt.
interface ChatPartyState {
    manualParty: PartyMember[];
    inventory: InventoryItem[];
    // Whether typed messages are put to the dice. Set from the panel, and
    // ignored in prose mode, which never rolls.
    rollEnabled: boolean;
    // How much game is showing: prose, story or full RPG. Chat-wide, because
    // it is a table-level agreement about how this chat is being played
    // rather than a fact about any one point in the story.
    mode: PlayMode;
    // Conditions set by hand from the panel since the last message.
    //
    // Conditions live in message state, so they rewind with a swipe - but
    // message state can only be written from inside a lifecycle hook, and the
    // panel isn't one. A change made between messages therefore existed only
    // in memory and was lost on reload. These are the pending overrides:
    // written straight through the messenger, laid over message state on
    // load, and folded into it by the next hook that runs.
    pendingConditions: {[speciesLower: string]: Condition};
    // Open plot threads, and the recurring characters the story keeps
    // returning to. Chat-wide rather than message state: a thread the player
    // opened shouldn't vanish because they swiped a reply away.
    quests: QuestEntry[];
    npcs: NpcEntry[];
    // Where and when the scene is taking place. Shared by everyone in the
    // chat - see setEnvironment for why it's stored per-user anyway.
    environment: string;
    // What the scanner found and the player hasn't ruled on, and what they
    // already turned down. Chat-wide: a pending decision shouldn't evaporate
    // because a reply was swiped away, and a rejection has to outlive the
    // branch it was made on to be worth remembering at all.
    suggestions: Suggestion[];
    dismissals: Dismissal[];
    // Completed scans, counting up. Dismissals are stamped with it to expire
    // against, so unlike the per-branch cadence counter it must never rewind.
    scanCount: number;
}

const EMPTY_CHAT_STATE: ChatPartyState = {
    manualParty: [],
    inventory: [],
    rollEnabled: true,
    mode: DEFAULT_MODE,
    pendingConditions: {},
    quests: [],
    npcs: [],
    environment: '',
    suggestions: [],
    dismissals: [],
    scanCount: 0
};

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // message-level variables
    userState: {[key: string]: UserState} = {};

    // chat-wide variables
    chatState: {[anonymizedId: string]: ChatPartyState} = {};

    // other:
    users: {[key: string]: User} = {};
    characters: {[key: string]: Character} = {};
    globalModifier: number;
    rosterInterval: number;
    scanInterval: number;
    // Where a brand-new chat starts before anyone touches the panel.
    defaultMode: PlayMode;

    // A scan is fired and forgotten, so the panel has no call to await; it
    // subscribes instead and re-renders when findings land. Same shape as
    // Portrait.ts's onAnchorsLoaded, for the same reason - data that arrives
    // after the render that wanted it.
    scanListeners: Set<() => void> = new Set();
    // Guards against a second scan starting on top of one in flight (the
    // player pressing Scan now while the interval scan is still out), and
    // drives the button's own disabled state. Per player: a shared flag meant
    // that in a multiplayer chat only the first player due a scan got one and
    // everyone else was silently told the stage was busy.
    scanning: Set<string> = new Set();
    // The external scanner, when the player has both switched it on and
    // filled it in; null otherwise, which is the whole of the "is it on?"
    // check - see readExternalConfig.
    externalScan: ExternalScanConfig|null;
    // The recent story, kept only because an external scan has no other way
    // to see it (see StoryLog.ts) - the built-in scan asks the platform for
    // the history instead. One log rather than one per player: everyone in a
    // chat is reading the same story, and a copy per player would pay for it
    // again in message state each time.
    storyLog: StoryEntry[] = [];



    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
            messageState,
            chatState,
            config
        } = data;
        this.users = users;
        this.characters = characters;
        const modifier = Number(config?.difficultyModifier ?? 0);
        this.globalModifier = Number.isFinite(modifier)
            ? Math.min(Math.max(Math.round(modifier), -MAX_DIFFICULTY_STEPS), MAX_DIFFICULTY_STEPS)
            : 0;
        this.rosterInterval = Math.max(config?.rosterReminderInterval ?? DEFAULT_ROSTER_INTERVAL, 0);
        this.scanInterval = Math.max(config?.scanInterval ?? DEFAULT_SCAN_INTERVAL, 0);
        this.defaultMode = parseMode(config?.playMode);
        this.externalScan = readExternalConfig(config);
        this.chatState = chatState ?? {};

        for (const user of Object.values(this.users)) {
            this.userState[user.anonymizedId] = this.initializeUserState();
        }
        this.setStateFromMessageState(messageState);
    }

    initializeUserState(): UserState {
        return {
            autoParty: [],
            lastOutcome: null,
            lastOutcomePrompt: '',
            // Null rather than the current mode, so the first prompt of a
            // chat always says which way this one is being played.
            lastModeSent: null,
            // Starts due, so the LLM gets the roster on the first prompt
            // rather than only after a full interval has gone by.
            turnsSinceRoster: this.rosterInterval,
            partyStatus: {},
            // Unlike the roster reminder, this starts at zero rather than
            // due: there's no story to scan yet on the first turn.
            turnsSinceScan: 0
        }
    }

    // Stores the fallback rather than handing back a throwaway: callers mutate
    // what they get back, and an unstored object silently swallows the write.
    getUserState(anonymizedId: string): UserState {
        if (!this.userState[anonymizedId]) {
            this.userState[anonymizedId] = this.initializeUserState();
        }
        return this.userState[anonymizedId];
    }

    getManualParty(anonymizedId: string): PartyMember[] {
        return this.chatState[anonymizedId]?.manualParty ?? [];
    }

    // The manual roster plus anything left over from auto-detection, deduped
    // by species. Nothing writes autoParty any more - moemon join by way of a
    // scanner suggestion the player accepts, or by hand - but it is still read
    // back so entries detected before that change stay visible and removable
    // instead of vanishing from someone's party mid-chat.
    //
    // Order is meaningful: the first member is the active moemon, the one the
    // card's stat block leads with and the one the narrator sends out first.
    getFullParty(anonymizedId: string): PartyMember[] {
        const manual = this.getManualParty(anonymizedId);
        const seen = new Set(manual.map(member => member.species.toLowerCase()));
        const combined = [...manual];
        for (const member of this.getUserState(anonymizedId).autoParty) {
            if (!seen.has(member.species.toLowerCase())) {
                combined.push(member);
                seen.add(member.species.toLowerCase());
            }
        }
        return combined;
    }

    // Writes one slice of a player's chat state without disturbing the rest -
    // the party and the bag live side by side, so a wholesale replace here
    // would silently drop whichever one wasn't being edited.
    async patchChatState(anonymizedId: string, patch: Partial<ChatPartyState>): Promise<void> {
        this.stageChatState(anonymizedId, patch);
        await this.messenger.updateChatState(this.chatState);
    }

    // The in-memory half of patchChatState, for the one caller that runs
    // inside beforePrompt: that hook returns chatState in its response, so
    // pushing the same write through the messenger as well would spend a
    // round-trip Chub is actively waiting on to say what it's about to be
    // told anyway.
    stageChatState(anonymizedId: string, patch: Partial<ChatPartyState>): void {
        const existing = this.chatState[anonymizedId] ?? {...EMPTY_CHAT_STATE, mode: this.defaultMode};
        this.chatState = {...this.chatState, [anonymizedId]: {...existing, ...patch}};
    }

    // Whether there is still room in the party. Six, the same limit the card
    // narrates: one active and five in balls.
    isPartyFull(anonymizedId: string): boolean {
        return this.getFullParty(anonymizedId).length >= MAX_PARTY;
    }

    // Adds a moemon to the player's roster by hand, at the level given (its
    // moves and held item follow from that level). Reports why it declined,
    // so the panel can say "party is full" instead of nothing happening.
    async addPartyMember(anonymizedId: string, species: string, level: number = DEFAULT_DETAILS.level): Promise<{added: boolean; reason?: string}> {
        const info = getSpecies(species);
        if (!info) return {added: false, reason: `${species} is not a moemon in the lorebook.`};

        const existing = this.getManualParty(anonymizedId);
        if (this.getFullParty(anonymizedId).some(member => member.species.toLowerCase() === info.name.toLowerCase())) {
            return {added: false, reason: `${info.name} is already with you.`};
        }
        if (this.isPartyFull(anonymizedId)) {
            return {added: false, reason: `Your party is full (${MAX_PARTY}). Release someone first.`};
        }

        const member = {species: info.name, source: 'manual', details: defaultDetailsFor(info.name, level)} as PartyMember;
        await this.patchChatState(anonymizedId, {manualParty: [...existing, member]});
        return {added: true};
    }

    // Moves a member to the front of the roster, making her the active
    // moemon. Auto-detected members are promoted into the manual roster on
    // the way, since ordering is something the player set on purpose.
    async setActiveMember(anonymizedId: string, species: string): Promise<void> {
        const party = this.getFullParty(anonymizedId);
        const target = party.find(member => member.species.toLowerCase() === species.toLowerCase());
        if (!target) return;
        const rest = party.filter(member => member !== target);
        const manualParty = [target, ...rest].map(member => ({...member, source: 'manual'} as PartyMember));
        const userState = this.getUserState(anonymizedId);
        userState.autoParty = [];
        await this.patchChatState(anonymizedId, {manualParty});
    }

    async removePartyMember(anonymizedId: string, species: string): Promise<void> {
        const manualParty = this.getManualParty(anonymizedId).filter(member => member.species.toLowerCase() !== species.toLowerCase());
        const userState = this.getUserState(anonymizedId);
        userState.autoParty = userState.autoParty.filter(member => member.species.toLowerCase() !== species.toLowerCase());
        await this.patchChatState(anonymizedId, {manualParty});
    }

    // Saves edited level/moves/held item for a party member, whether it was
    // previously manual, auto-only, or brand new - "editing" always targets
    // a member currently surfaced by getFullParty, so this always promotes
    // it into the persisted, chat-wide roster.
    async updatePartyMemberDetails(anonymizedId: string, species: string, details: PartyMemberDetails): Promise<void> {
        const info = getSpecies(species);
        if (!info) return;

        const member = {species: info.name, source: 'manual', details} as PartyMember;
        const manual = this.getManualParty(anonymizedId);
        const index = manual.findIndex(existing => existing.species.toLowerCase() === info.name.toLowerCase());

        // Edited in place. Rebuilding the list as "everyone else, then her"
        // would move whoever was edited to the back - which, now that the
        // first slot is the active moemon, would swap out the moemon in front
        // of {{user}} every time she was given a held item.
        const manualParty = index >= 0
            ? manual.map((existing, at) => at === index ? member : existing)
            : [...manual, member];
        await this.patchChatState(anonymizedId, {manualParty});
    }

    getInventory(anonymizedId: string): InventoryItem[] {
        return parseInventory(this.chatState[anonymizedId]?.inventory);
    }

    // Adding an item the player already carries tops up the stack rather than
    // creating a second entry.
    async addInventoryItem(anonymizedId: string, name: string, quantity: number = 1): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) return;
        const amount = Math.max(Math.floor(quantity) || 1, 1);
        const inventory = this.getInventory(anonymizedId);
        const existing = inventory.find(item => sameItem(item.name, trimmed));
        const updated = existing
            ? inventory.map(item => sameItem(item.name, trimmed) ? {...item, quantity: item.quantity + amount} : item)
            : [...inventory, {name: trimmed, quantity: amount}];
        await this.patchChatState(anonymizedId, {inventory: updated});
    }

    async removeInventoryItem(anonymizedId: string, name: string): Promise<void> {
        const inventory = this.getInventory(anonymizedId).filter(item => !sameItem(item.name, name));
        await this.patchChatState(anonymizedId, {inventory});
    }

    // Spends one of an item. The stack drops off the list at zero.
    //
    // Nothing is sent to the chat from here. The stage cannot make Chub
    // generate on its own: impersonating a message and then nudging, and
    // nudging alone, both ended in Chub timing out on the stage and failing
    // generation on a half-built message. The player sends the message
    // themselves through Chub's own input, and the panel just hands them the
    // item's name to put in it.
    async spendItem(anonymizedId: string, name: string): Promise<void> {
        const inventory = this.getInventory(anonymizedId);
        const existing = inventory.find(item => sameItem(item.name, name));
        if (!existing) return;

        const updated = existing.quantity > 1
            ? inventory.map(item => sameItem(item.name, name) ? {...item, quantity: item.quantity - 1} : item)
            : inventory.filter(item => !sameItem(item.name, name));
        await this.patchChatState(anonymizedId, {inventory: updated});
    }

    getQuests(anonymizedId: string): QuestEntry[] {
        return parseQuests(this.chatState[anonymizedId]?.quests);
    }

    async addQuest(anonymizedId: string, text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return;
        const quests = [...this.getQuests(anonymizedId), {id: newQuestId(), text: trimmed, done: false}];
        await this.patchChatState(anonymizedId, {quests});
    }

    async toggleQuest(anonymizedId: string, id: string): Promise<void> {
        const quests = this.getQuests(anonymizedId)
            .map(quest => quest.id === id ? {...quest, done: !quest.done} : quest);
        await this.patchChatState(anonymizedId, {quests});
    }

    async removeQuest(anonymizedId: string, id: string): Promise<void> {
        const quests = this.getQuests(anonymizedId).filter(quest => quest.id !== id);
        await this.patchChatState(anonymizedId, {quests});
    }

    getNpcs(anonymizedId: string): NpcEntry[] {
        return parseNpcs(this.chatState[anonymizedId]?.npcs);
    }

    async addNpc(anonymizedId: string, name: string, note: string = ''): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) return;
        const existing = this.getNpcs(anonymizedId);
        if (existing.some(npc => sameNpc(npc.name, trimmed))) return;
        await this.patchChatState(anonymizedId, {
            npcs: [...existing, {name: trimmed, note: note.trim(), affinity: 0}]
        });
    }

    async updateNpc(anonymizedId: string, name: string, patch: Partial<NpcEntry>): Promise<void> {
        const npcs = this.getNpcs(anonymizedId).map(npc => sameNpc(npc.name, name)
            ? {...npc, ...patch, affinity: clampAffinity(patch.affinity ?? npc.affinity)}
            : npc);
        await this.patchChatState(anonymizedId, {npcs});
    }

    async removeNpc(anonymizedId: string, name: string): Promise<void> {
        const npcs = this.getNpcs(anonymizedId).filter(npc => !sameNpc(npc.name, name));
        await this.patchChatState(anonymizedId, {npcs});
    }

    // Affinity moves only from the panel now. It used to shift on every check
    // that named a tracked character, keyed off the outcome the model was
    // asked to pick - and that verdict was unreliable enough that the standing
    // it drove was too. A number the player nudges deliberately beats one that
    // drifts on a guess.

    // Everything chat-wide worth carrying between chats: the roster the
    // player built, their bag, their open threads, who they know, and where
    // they are. Message state (auto-detected party, last roll, conditions)
    // stays out - it's derived from the story being exported away from.
    exportSave(anonymizedId: string): string {
        return JSON.stringify({
            version: SAVE_VERSION,
            manualParty: this.getManualParty(anonymizedId),
            inventory: this.getInventory(anonymizedId),
            quests: this.getQuests(anonymizedId),
            npcs: this.getNpcs(anonymizedId),
            environment: this.getEnvironment()
        }, null, 2);
    }

    // Replaces the player's chat-wide state from a pasted bundle. Every field
    // goes through the same validators used to read persisted state, so a
    // truncated or hand-edited bundle loses the bad entries rather than the
    // whole import.
    async importSave(anonymizedId: string, json: string): Promise<{success: boolean; error?: string}> {
        let parsed: any;
        try {
            parsed = JSON.parse(json);
        } catch {
            return {success: false, error: 'That is not valid JSON.'};
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {success: false, error: 'That JSON is not a save bundle.'};
        }

        const manualParty = parseParty(parsed.manualParty);
        const inventory = parseInventory(parsed.inventory);
        const quests = parseQuests(parsed.quests);
        const npcs = parseNpcs(parsed.npcs);
        const environment = typeof parsed.environment === 'string' ? parsed.environment.trim() : '';

        // A bundle that contributes nothing recognisable is far more likely a
        // paste of the wrong thing than a deliberate wipe, so it's refused
        // rather than silently clearing the roster.
        if (manualParty.length === 0 && inventory.length === 0 && quests.length === 0
            && npcs.length === 0 && !environment) {
            return {success: false, error: 'No usable party, bag, threads, or characters in that bundle.'};
        }

        await this.patchChatState(anonymizedId, {manualParty, inventory, quests, npcs});
        // Written across every player's slot, unlike the rest of the bundle.
        if (environment) await this.setEnvironment(environment);
        return {success: true};
    }

    // The scene everyone in the chat shares. chatState is keyed per user, so
    // rather than reshaping it (and migrating every chat already saved), the
    // same value is written into each player's slot and read back from
    // whichever one answers first.
    getEnvironment(): string {
        for (const state of Object.values(this.chatState)) {
            const environment = typeof state?.environment === 'string' ? state.environment.trim() : '';
            if (environment) return environment;
        }
        return '';
    }

    async setEnvironment(environment: string): Promise<void> {
        const trimmed = environment.trim();
        for (const user of Object.values(this.users)) {
            await this.patchChatState(user.anonymizedId, {environment: trimmed});
        }
    }

    // ---- Story scanner -------------------------------------------------
    //
    // Reads the stretch of story since the last scan against what's already
    // tracked, and offers what it finds as suggestions. Nothing it detects is
    // applied on its own: the existing party auto-detection already shows
    // that guessing from prose gets things wrong, which is why the panel has
    // manual add/remove in the first place.

    onSuggestionsChanged(listener: () => void): () => void {
        this.scanListeners.add(listener);
        return () => this.scanListeners.delete(listener);
    }

    notifySuggestionsChanged(): void {
        this.scanListeners.forEach(listener => listener());
    }

    getSuggestions(anonymizedId: string): Suggestion[] {
        return parseSuggestions(this.chatState[anonymizedId]?.suggestions);
    }

    getDismissals(anonymizedId: string): Dismissal[] {
        return parseDismissals(this.chatState[anonymizedId]?.dismissals);
    }

    getScanCount(anonymizedId: string): number {
        const count = Number(this.chatState[anonymizedId]?.scanCount);
        return Number.isFinite(count) ? count : 0;
    }

    // Appends a turn to the shared story log. In-memory only: the log rides
    // out in message state, which none of these callers may write directly -
    // the hooks return it instead, and both hooks that record a turn build
    // that state after calling this.
    recordStoryEntry(who: string, text: string): void {
        // Nothing is recorded unless a scan could actually want it. The log
        // costs message state on every message, and a player who has not
        // turned the external scan on gets no use from it at all.
        if (!this.externalScan) return;
        this.storyLog = appendStoryEntry(this.storyLog, who, text);
    }

    // The vocabulary both scans share: one entry per finding the panel knows
    // how to act on. Held in one place so the two transports cannot drift
    // apart on what a finding *means* while differing, as they must, on how
    // it is written down.
    scanVocabulary(player: string): {verb: string; kind: SuggestionKind; value: string; detail: string; note: string}[] {
        return [
            // Spelled out because this is now the only route a moemon takes
            // into the roster. Matching every species named in the prose is
            // what used to recruit every wild moemon and every opponent the
            // story mentioned.
            {verb: 'PARTY', kind: 'party', value: 'species', detail: '', note: `ONLY a moemon that has actually joined ${player}'s party. Never one that merely appears, is fought, is owned by someone else, or is only spoken about.`},
            {verb: 'QUEST', kind: 'quest', value: 'short description of a new goal or open thread', detail: '', note: ''},
            {verb: 'RESOLVED', kind: 'quest-done', value: 'the tracked thread that is now finished', detail: '', note: ''},
            {verb: 'NPC', kind: 'npc', value: 'name', detail: 'who they are, briefly', note: ''},
            {verb: 'SCENE', kind: 'scene', value: 'where and when the scene now is', detail: '', note: ''},
            {verb: 'CONDITION', kind: 'condition', value: 'species', detail: 'ok, hurt, or fainted', note: ''},
            // The card narrates level gains; the panel is where the number
            // actually lives. Without this the two drift apart within a few
            // battles and the player has to reconcile them by hand.
            {verb: 'LEVEL', kind: 'level', value: 'species', detail: 'her new level, digits only', note: `only for a moemon already in ${player}'s party whose level the story has changed.`}
        ];
    }

    // What both scans are told before the vocabulary: what is already tracked,
    // and that only changes to it are wanted. Where the story is differs by
    // transport - the platform puts the history above the built-in scan's
    // prompt, while the external one is handed a transcript of its own - so
    // that much is the caller's to say.
    buildScanPreamble(anonymizedId: string, where: string): string[] {
        // buildContextNote already says exactly what's tracked - roster,
        // scene, open threads, characters - so the scan tells the model what
        // it already knows in the same words the narrator gets.
        const tracked = this.buildContextNote(anonymizedId);

        return [
            `You are reviewing the roleplay ${where} to spot what has changed.`,
            ``,
            `Already tracked:`,
            tracked || '(nothing yet)',
            ``,
            `Report only what is NEW or CHANGED versus what is already tracked.`
        ];
    }

    // Spelled out rather than left as {{user}}: a scan prompt goes straight
    // to the model without passing through replaceTags, so a tag here would
    // reach it unsubstituted.
    scanPlayerName(anonymizedId: string): string {
        return this.users[anonymizedId]?.name || 'the player';
    }

    // What the external model is told. Same preamble and same vocabulary as
    // the built-in scan; the formatting rules are gone because the schema
    // enforces the shape now (see External.ts), leaving only meaning.
    buildExternalScanInstructions(anonymizedId: string): string {
        const player = this.scanPlayerName(anonymizedId);

        return [
            ...this.buildScanPreamble(anonymizedId, 'in the message that follows'),
            `Answer with the findings array. Use these kinds:`,
            ...this.scanVocabulary(player).map(entry => {
                const detail = entry.detail ? `detail = <${entry.detail}>` : `leave detail empty`;
                return `${entry.kind}: value = <${entry.value}>, ${detail}${entry.note ? ` - ${entry.note}` : ''}`;
            }),
            ``,
            `Return an empty findings array if nothing has changed. Report nothing that is already tracked.`
        ].join('\n');
    }

    buildScanPrompt(anonymizedId: string): string {
        // The story itself comes from include_history rather than from the
        // stage's own log: the platform has the whole chat, while the log is
        // capped to the recent stretch and is only kept at all when the
        // external scan is switched on.
        const player = this.scanPlayerName(anonymizedId);

        return [
            ...this.buildScanPreamble(anonymizedId, 'above'),
            `Write one finding per line, in exactly these forms:`,
            ...this.scanVocabulary(player).map(entry => {
                const detail = entry.detail ? ` | <${entry.detail}>` : '';
                return `${entry.verb} | <${entry.value}>${detail}${entry.note ? ` - ${entry.note}` : ''}`;
            }),
            ``,
            `Write NONE if nothing has changed. Write no other text.`
        ].join('\n');
    }

    // Turns raw detections into suggestions worth showing: each is checked
    // against the lorebook, against what's already true, against what's
    // already pending, and against what the player has recently refused.
    filterDetections(anonymizedId: string, detections: RawDetection[]): Suggestion[] {
        const party = this.getFullParty(anonymizedId);
        const quests = this.getQuests(anonymizedId);
        const npcs = this.getNpcs(anonymizedId);
        const environment = this.getEnvironment();
        const pending = this.getSuggestions(anonymizedId);
        const scanCount = this.getScanCount(anonymizedId);

        // Only rejections still inside their lifetime suppress anything.
        const suppressed = new Set(this.getDismissals(anonymizedId)
            .filter(dismissal => scanCount - dismissal.scan < DISMISSAL_LIFETIME_SCANS)
            .map(dismissal => dismissal.key));

        const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
        const accepted: Suggestion[] = [];
        const taken = new Set(pending.map(item => suggestionKey(item.kind, item.value)));

        for (const detection of detections) {
            const resolved = this.resolveDetection(anonymizedId, detection, {party, quests, npcs, environment, normalize});
            if (!resolved) continue;

            const key = suggestionKey(resolved.kind, resolved.value);
            if (suppressed.has(key) || taken.has(key)) continue;
            taken.add(key);

            accepted.push({
                id: newSuggestionId(),
                kind: resolved.kind,
                value: resolved.value,
                detail: resolved.detail,
                description: describeSuggestion(resolved.kind, resolved.value, resolved.detail)
            });
        }
        return accepted;
    }

    // Validates one detection and canonicalises it, or returns null if it's
    // unrecognisable or already true. Split out from filterDetections so the
    // per-kind rules read as a list rather than as nesting.
    resolveDetection(
        anonymizedId: string,
        detection: RawDetection,
        context: {
            party: PartyMember[];
            quests: QuestEntry[];
            npcs: NpcEntry[];
            environment: string;
            normalize: (text: string) => string;
        }
    ): RawDetection | null {
        const {party, quests, npcs, environment, normalize} = context;

        switch (detection.kind) {
            case 'party': {
                // The lorebook is the authority on what's a moemon, the same
                // rule parseParty applies to an imported roster.
                const info = getSpecies(detection.value);
                if (!info) return null;
                if (party.some(member => member.species.toLowerCase() === info.name.toLowerCase())) return null;
                return {kind: 'party', value: info.name, detail: ''};
            }
            case 'quest': {
                if (quests.some(quest => normalize(quest.text) === normalize(detection.value))) return null;
                return {kind: 'quest', value: detection.value, detail: ''};
            }
            case 'quest-done': {
                // Has to name a thread that's actually open; the id travels
                // in detail so accepting doesn't have to match text again.
                const match = quests.find(quest => !quest.done
                    && (normalize(quest.text) === normalize(detection.value)
                        || normalize(quest.text).includes(normalize(detection.value))
                        || normalize(detection.value).includes(normalize(quest.text))));
                if (!match) return null;
                return {kind: 'quest-done', value: match.text, detail: match.id};
            }
            case 'npc': {
                if (npcs.some(npc => sameNpc(npc.name, detection.value))) return null;
                return {kind: 'npc', value: detection.value, detail: detection.detail};
            }
            case 'scene': {
                if (normalize(environment) === normalize(detection.value)) return null;
                return {kind: 'scene', value: detection.value, detail: ''};
            }
            case 'level': {
                const info = getSpecies(detection.value);
                if (!info) return null;
                const member = party.find(one => one.species.toLowerCase() === info.name.toLowerCase());
                if (!member) return null;
                const level = Math.floor(Number(detection.detail.replace(/[^0-9]/g, '')));
                if (!Number.isFinite(level) || level < 1 || level > 100) return null;
                if (detailsOf(member).level === level) return null;
                return {kind: 'level', value: info.name, detail: String(level)};
            }
            case 'condition': {
                const info = getSpecies(detection.value);
                if (!info) return null;
                if (!party.some(member => member.species.toLowerCase() === info.name.toLowerCase())) return null;
                const condition = detection.detail.trim().toLowerCase();
                if (condition !== 'ok' && condition !== 'hurt' && condition !== 'fainted') return null;
                if (this.getCondition(anonymizedId, info.name) === condition) return null;
                return {kind: 'condition', value: info.name, detail: condition};
            }
            default:
                return null;
        }
    }

    // Runs a scan. Never awaited by a lifecycle hook: the caller fires it and
    // the panel picks the findings up through onSuggestionsChanged, so the
    // chat never waits on the model here.
    //
    // Reports what happened rather than returning void. A scan that finds
    // nothing and a scan that never ran look identical from the panel
    // otherwise, which is precisely how this went unnoticed the first time.
    async runScan(anonymizedId: string): Promise<ScanOutcome> {
        if (this.scanning.has(anonymizedId)) return {ok: false, found: 0, reason: 'busy'};

        this.scanning.add(anonymizedId);
        this.notifySuggestionsChanged();
        try {
            let detections: RawDetection[]|null = null;
            let source: 'external' | 'builtin' = 'builtin';
            let fellBack = false;
            let noStoryYet = false;

            if (this.externalScan) {
                try {
                    detections = await this.runExternalScan(anonymizedId);
                    if (detections) source = 'external';
                    else noStoryYet = true;
                } catch (error) {
                    // Everything the external scan can go wrong with - a
                    // refused key, an exhausted balance, a model that cannot
                    // honour the schema, a proxy that never answers - has the
                    // same remedy here, so it is logged for the player's
                    // console and the chat's own model takes the scan.
                    console.log(error);
                    fellBack = true;
                }
            }

            if (detections == null) {
                const response = await this.withTimeout(
                    this.generator.textGen({
                        prompt: this.buildScanPrompt(anonymizedId),
                        max_tokens: SCAN_MAX_TOKENS,
                        // The platform supplies the story; the stage cannot
                        // keep its own copy across a reload (see
                        // buildScanPrompt).
                        include_history: true
                    }),
                    SCAN_TIMEOUT_MS
                );

                // textGen resolves null on failure rather than throwing, so
                // tell a dead generation apart from one that simply found
                // nothing.
                if (response?.result == null) return {ok: false, found: 0, reason: 'failed', source, fellBack, noStoryYet};

                detections = parseScanOutput(response.result);
            }

            const found = this.filterDetections(anonymizedId, detections);

            // Read through patchChatState rather than a snapshot taken before
            // the await: a panel edit made while the scan was in flight is
            // already in this.chatState, and writing back a stale copy would
            // silently drop it.
            await this.patchChatState(anonymizedId, {
                suggestions: [...this.getSuggestions(anonymizedId), ...found],
                // Expired rejections are pruned here rather than accumulating
                // for the life of the chat.
                dismissals: this.getDismissals(anonymizedId)
                    .filter(dismissal => this.getScanCount(anonymizedId) - dismissal.scan < DISMISSAL_LIFETIME_SCANS),
                scanCount: this.getScanCount(anonymizedId) + 1
            });
            return {ok: true, found: found.length, source, fellBack, noStoryYet};
        } catch (error) {
            console.log(error);
            return {ok: false, found: 0, reason: 'failed'};
        } finally {
            this.scanning.delete(anonymizedId);
            this.notifySuggestionsChanged();
        }
    }

    // The external half of a scan. Returns null - rather than throwing - when
    // there is simply no story to send yet: a chat opened fresh has an empty
    // log until a turn or two has passed, and that is the built-in scan's
    // case to take, not a failure to report.
    //
    // Throws on anything that is a failure, since the caller treats every one
    // of them the same way.
    async runExternalScan(anonymizedId: string): Promise<RawDetection[]|null> {
        const config = this.externalScan;
        if (!config) return null;

        const transcript = renderTranscript(this.storyLog);
        if (!transcript.trim()) return null;

        // Aborted as well as timed out: withTimeout only stops the stage
        // waiting, and a request left running would still spend the player's
        // credit on an answer nothing is listening for.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
        try {
            return await this.withTimeout(
                scanExternally(
                    config,
                    this.buildExternalScanInstructions(anonymizedId),
                    transcript,
                    controller.signal
                ),
                SCAN_TIMEOUT_MS
            );
        } finally {
            clearTimeout(timer);
        }
    }

    async acceptSuggestion(anonymizedId: string, id: string): Promise<void> {
        const suggestion = this.getSuggestions(anonymizedId).find(item => item.id === id);
        if (!suggestion) return;

        // Everything routes through the methods the panel already uses, so
        // accepting isn't a second way to write the same state.
        switch (suggestion.kind) {
            case 'party':
                await this.addPartyMember(anonymizedId, suggestion.value);
                break;
            // (a full party simply declines; the suggestion still clears, so
            // the panel doesn't keep asking about a moemon there's no room for)
            case 'quest':
                await this.addQuest(anonymizedId, suggestion.value);
                break;
            case 'quest-done': {
                // The thread may have been closed by hand since the scan.
                const quest = this.getQuests(anonymizedId).find(item => item.id === suggestion.detail);
                if (quest && !quest.done) await this.toggleQuest(anonymizedId, quest.id);
                break;
            }
            case 'npc':
                await this.addNpc(anonymizedId, suggestion.value, suggestion.detail);
                break;
            case 'scene':
                await this.setEnvironment(suggestion.value);
                break;
            case 'condition':
                await this.setCondition(anonymizedId, suggestion.value, suggestion.detail as Condition);
                break;
            case 'level': {
                const member = this.getFullParty(anonymizedId)
                    .find(one => one.species.toLowerCase() === suggestion.value.toLowerCase());
                if (member) {
                    await this.updatePartyMemberDetails(anonymizedId, member.species,
                        {...detailsOf(member), level: Number(suggestion.detail)});
                }
                break;
            }
        }

        await this.dropSuggestion(anonymizedId, id, false);
    }

    async rejectSuggestion(anonymizedId: string, id: string): Promise<void> {
        await this.dropSuggestion(anonymizedId, id, true);
    }

    // Removes a suggestion, optionally remembering it as refused so the next
    // scan doesn't propose it straight back.
    async dropSuggestion(anonymizedId: string, id: string, remember: boolean): Promise<void> {
        const suggestions = this.getSuggestions(anonymizedId);
        const suggestion = suggestions.find(item => item.id === id);
        if (!suggestion) return;

        const patch: Partial<ChatPartyState> = {
            suggestions: suggestions.filter(item => item.id !== id)
        };
        if (remember) {
            patch.dismissals = [
                ...this.getDismissals(anonymizedId),
                {key: suggestionKey(suggestion.kind, suggestion.value), scan: this.getScanCount(anonymizedId)}
            ];
        }
        await this.patchChatState(anonymizedId, patch);
        this.notifySuggestionsChanged();
    }

    getCondition(anonymizedId: string, species: string): Condition {
        return this.getUserState(anonymizedId).partyStatus[species.toLowerCase()] ?? 'ok';
    }

    // Manual override from the panel, or an accepted scan finding - corrects
    // an auto-nudge, or applies a status the narration described.
    //
    // Written twice on purpose. The in-memory copy is what this turn reads;
    // the chat-state copy is what survives a reload, because message state
    // can only be written from inside a lifecycle hook and the panel is not
    // one. The next hook folds the pending copy back in and clears it.
    async setCondition(anonymizedId: string, species: string, condition: Condition): Promise<void> {
        this.applyCondition(anonymizedId, species, condition);
        await this.patchChatState(anonymizedId, {
            pendingConditions: {
                ...this.getPendingConditions(anonymizedId),
                [species.toLowerCase()]: condition
            }
        });
    }

    // The in-memory half, for the callers already inside a hook whose
    // response carries message state back anyway.
    applyCondition(anonymizedId: string, species: string, condition: Condition): void {
        const userState = this.getUserState(anonymizedId);
        userState.partyStatus = {...userState.partyStatus, [species.toLowerCase()]: condition};
    }

    getPendingConditions(anonymizedId: string): {[speciesLower: string]: Condition} {
        return this.parsePartyStatus(this.chatState[anonymizedId]?.pendingConditions);
    }

    // Called from the hooks, which are returning message state anyway: the
    // overrides are in it by then, so the pending copy has done its job.
    clearPendingConditions(anonymizedId: string): void {
        if (Object.keys(this.getPendingConditions(anonymizedId)).length === 0) return;
        this.stageChatState(anonymizedId, {pendingConditions: {}});
    }

    // An extreme roll nudges the acting member's condition one notch; an
    // ordinary one leaves it alone. Flavor for the dramatic swings, not a
    // full HP economy - and now read straight off the number, so it can't be
    // lost to a verdict that failed to parse.
    applyOutcomeCondition(anonymizedId: string, member: PartyMember|undefined, roll: number): void {
        if (!member) return;

        const current = this.getCondition(anonymizedId, member.species);
        if (isCriticalFailure(roll)) {
            this.applyCondition(anonymizedId, member.species, stepConditionDown(current));
        } else if (isCriticalSuccess(roll)) {
            this.applyCondition(anonymizedId, member.species, stepConditionUp(current));
        }
    }

    // Whether the player's next message goes to the dice. Persisted per
    // player, so the choice survives a reload; defaults to rolling. Prose
    // mode overrides it: nothing is being adjudicated there.
    isRollEnabled(anonymizedId: string): boolean {
        if (!modeRolls(this.getMode())) return false;
        return this.chatState[anonymizedId]?.rollEnabled ?? true;
    }

    async setRollEnabled(anonymizedId: string, rollEnabled: boolean): Promise<void> {
        await this.patchChatState(anonymizedId, {rollEnabled});
    }

    // How much game is showing. Chat-wide, and stored in every player's slot
    // for the same reason the scene is - see setEnvironment.
    getMode(): PlayMode {
        for (const state of Object.values(this.chatState)) {
            if (state?.mode) return parseMode(state.mode);
        }
        return this.defaultMode;
    }

    async setMode(mode: PlayMode): Promise<void> {
        const parsed = parseMode(mode);
        for (const user of Object.values(this.users)) {
            await this.patchChatState(user.anonymizedId, {mode: parsed});
        }
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        // Chub's native input is the box for ordinary, rolled actions. Set
        // explicitly rather than relying on the default, so a chat left over
        // from a build that hid the input gets it back.
        await this.messenger.updateEnvironment({input_enabled: true});

        return {
            success: true,
            error: null,
            initState: null,
            chatState: this.chatState,
        };
    }

    // Resolves a line of action by rolling the chance it comes off. No model
    // call: the number goes straight to the narrator, which is the whole
    // point - the old two-step (roll a d20, then ask the model to name one of
    // five verdicts) answered "no check" for every reply it couldn't parse,
    // and this hook is one Chub blocks on, so it was paying a round-trip for
    // the privilege.
    resolveAction(anonymizedId: string, text: string, charName: string = ''): ResolvedAction {
        const sequence = this.replaceTags(text, {
            "user": this.users[anonymizedId]?.name ?? '',
            "char": charName
        });

        const roll = this.rollChance();
        const party = this.getFullParty(anonymizedId);
        const actingMember = this.findActingMember(party, sequence);
        const actor = actingMember ? displayNameOf(actingMember) : null;

        const outcome = new Outcome(roll, new Action(text, actor));
        this.applyOutcomeCondition(anonymizedId, actingMember, roll);
        return {outcome, actingMember};
    }

    // The chance an attempt succeeds, shifted by the configured difficulty.
    // The modifier used to be phrased at the judge in words ("judge somewhat
    // more generously"); with the judge gone it moves the number instead,
    // which is both plainer and impossible to misread.
    rollChance(): number {
        const roll = Math.round(Math.random() * (ROLL_MAX - ROLL_MIN)) + ROLL_MIN
            + this.globalModifier * DIFFICULTY_POINTS_PER_STEP;
        return Math.min(Math.max(roll, ROLL_MIN), ROLL_MAX);
    }

    // What the narrator should know about whoever is taking the action: what
    // they're carrying, and whether they're in any shape to act. Both are
    // handed over as plain description rather than as rules - the model
    // decides whether a Focus Sash or a limp matters to *this* action, the
    // same way it decides everything else.
    actorNote(anonymizedId: string, member: PartyMember|undefined): string {
        if (!member) return '';
        const name = displayNameOf(member);
        const facts: string[] = [];

        const heldItem = detailsOf(member).heldItem.trim();
        if (heldItem) facts.push(`is holding ${heldItem}`);

        const condition = this.getCondition(anonymizedId, member.species);
        if (condition !== 'ok') facts.push(`is ${condition}`);

        return facts.length > 0 ? `${name} ${facts.join(' and ')}.` : '';
    }

    withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Generation timed out after ${timeoutMs}ms`)), timeoutMs);
            promise.then(
                (value) => { clearTimeout(timer); resolve(value); },
                (error) => { clearTimeout(timer); reject(error); }
            );
        });
    }

    // Told to the narrator when the dice are off, so it treats the message as
    // something that simply happens rather than something to be resolved.
    buildNoRollDirections(anonymizedId: string, charName: string = ''): string {
        const instruction = this.replaceTags(NO_ROLL_DIRECTION, {
            "user": this.users[anonymizedId]?.name ?? '',
            "char": charName
        });
        return `\n[INST]${instruction}${this.modeLineIfDue(anonymizedId)}\n[/INST]${this.rosterNoteIfDue(anonymizedId)}`;
    }

    // The [INST] block handed to the LLM for a resolved action.
    buildStageDirections(anonymizedId: string, charName: string = ''): string {
        const prompt = this.replaceTags(this.getUserState(anonymizedId).lastOutcomePrompt, {
            "user": this.users[anonymizedId]?.name ?? '',
            "char": charName
        });
        return `\n[INST]${prompt}${this.modeLineIfDue(anonymizedId)}\n[/INST]${this.rosterNoteIfDue(anonymizedId)}`;
    }

    // How this chat is being played, told to the narrator when it changes
    // and then left alone. Restating it every turn would spend tokens saying
    // what the previous forty replies already established; saying it only
    // once would leave a mode switch mid-chat unheard.
    modeLineIfDue(anonymizedId: string): string {
        const mode = this.getMode();
        const userState = this.getUserState(anonymizedId);
        if (userState.lastModeSent === mode) return '';
        userState.lastModeSent = mode;
        return `\n${modeDirection(mode)}`;
    }

    // The runtime answers the host's BEFORE/AFTER/SET message with whatever
    // these hooks return - but if one throws, it posts an ERROR and never
    // sends that answer at all. The host then waits, times out, and force
    // refreshes the frame, which comes back with a null stage that silently
    // drops every message after it. So a hook must always return something,
    // however little it managed to do: degrading costs a turn's worth of
    // stage behaviour, while throwing costs the whole chat.
    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        try {
            return await this.beforePromptInner(userMessage);
        } catch (error) {
            console.error('Crunchatize: beforePrompt failed', error);
            return this.safeResponse(userMessage.content);
        }
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        try {
            return await this.afterResponseInner(botMessage);
        } catch (error) {
            console.error('Crunchatize: afterResponse failed', error);
            return this.safeResponse(botMessage.content);
        }
    }

    async setState(state: MessageStateType): Promise<void> {
        try {
            this.setStateFromMessageState(state);
        } catch (error) {
            console.error('Crunchatize: setState failed', error);
        }
    }

    // A response that leaves the message exactly as it was and adds nothing.
    // Deliberately omits messageState and chatState: state that may be
    // half-written is better left alone than written back malformed.
    safeResponse(content: string|undefined): Partial<StageResponse<ChatStateType, MessageStateType>> {
        return {
            stageDirections: null,
            messageState: null,
            modifiedMessage: content,
            systemMessage: null,
            error: null,
            chatState: null
        };
    }

    async beforePromptInner(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            anonymizedId,
            content,
            promptForId
        } = userMessage;

        // Recorded before either branch below returns, so a chat with the
        // dice switched off still builds a story for the external scan to
        // read. What goes in is the player's own text: the roll and the
        // stage directions are the stage talking to itself, and a scan that
        // saw them would report the stage's own bookkeeping back to it.
        this.recordStoryEntry(this.users[anonymizedId]?.name || 'Player', content);

        const errorMessage: string|null = null;
        // The player's original message, sent to chat untouched - the roll
        // and its outcome are never written into the visible text or history,
        // only into stageDirections (for the narrator) and the panel.
        const finalContent: string|undefined = content;

        // Dice turned off from the panel: the message goes through untouched,
        // with no classification and so no waiting on the classifier either.
        if (!this.isRollEnabled(anonymizedId)) {
            this.setLastOutcome(anonymizedId, null);

            return {
                stageDirections: this.buildNoRollDirections(anonymizedId,
                    promptForId ? this.characters[promptForId]?.name ?? '' : ''),
                messageState: this.buildMessageState(),
                modifiedMessage: finalContent,
                systemMessage: null,
                error: errorMessage,
                chatState: this.chatState,
            };
        }

        if (finalContent) {
            const {outcome, actingMember} = this.resolveAction(anonymizedId, content,
                promptForId ? this.characters[promptForId]?.name ?? '' : '');
            this.setLastOutcome(anonymizedId, outcome, actingMember);
        }

        return {
            stageDirections: this.buildStageDirections(anonymizedId,
                promptForId ? this.characters[promptForId]?.name ?? '' : ''),
            messageState: this.buildMessageState(),
            modifiedMessage: finalContent,
            systemMessage: null,
            error: errorMessage,
            chatState: this.chatState,
        };
    }

    async afterResponseInner(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const narratorResponse = trimTrailingBlock(botMessage.content);

        // The trimmed reply, not the raw one: the stage's own readout is
        // echoed back by some models, and the scan reading it would be the
        // stage confirming its own guesses to itself.
        this.recordStoryEntry(this.characters[botMessage.anonymizedId]?.name || 'Narrator', narratorResponse);

        const due: string[] = [];
        for (const user of Object.values(this.users)) {
            const userState = this.getUserState(user.anonymizedId);
            userState.lastOutcomePrompt = '';
            // Panel edits made between messages have been folded into the
            // message state this hook is about to return.
            this.clearPendingConditions(user.anonymizedId);

            if (this.scanInterval > 0) {
                userState.turnsSinceScan = (userState.turnsSinceScan ?? 0) + 1;
                if (userState.turnsSinceScan >= this.scanInterval) {
                    // Reset before the response is built below, so the cadence
                    // the player rewinds to is the one after this scan fired.
                    userState.turnsSinceScan = 0;
                    due.push(user.anonymizedId);
                }
            }
        }

        // Fired, not awaited: the scan writes its own chat state and wakes the
        // panel when it lands, so nothing here waits on the model. A rejection
        // would otherwise be invisible, hence the catch.
        for (const anonymizedId of due) {
            this.runScan(anonymizedId).catch(error => console.log(error));
        }

        return {
            stageDirections: null,
            messageState: this.buildMessageState(),
            modifiedMessage: narratorResponse,
            error: null,
            systemMessage: this.buildPartySystemMessage(),
            chatState: this.chatState
        };
    }

    // The block shown under each bot message. This is display-only - Chub
    // never sends system messages to the LLM - so it's kept to what a player
    // wants at a glance. Held items and movesets live in the panel, where
    // they can be read on demand instead of restated every turn.
    buildPartySystemMessage(): string {
        const lines: string[] = [];
        for (const user of Object.values(this.users)) {
            const party = this.getFullParty(user.anonymizedId);
            lines.push(`${user.name}'s Party: ${party.length > 0
                ? party.map((member, index) => {
                    const facts = [typesOf(member).join('/') || '???'];
                    const condition = this.getCondition(user.anonymizedId, member.species);
                    if (condition !== 'ok') facts.push(condition);
                    // A star rather than a word: the row is already dense and
                    // "active" would be the longest thing on it.
                    return `${index === 0 ? '* ' : ''}${labelFor(member, facts)} Lv.${detailsOf(member).level}`;
                }).join(', ')
                : 'No moemon yet'}`);

            const bag = this.describeBag(user.anonymizedId);
            if (bag) lines.push(`${user.name}'s Bag: ${bag}`);
        }
        // The newlines matter: with the first line jammed against the
        // opening fence, markdown reads it as the block's language tag and
        // the readout renders as one long broken line.
        return '---\n```\n' + lines.join('\n') + '\n```';
    }

    // Which party member the player named as taking the action, if any. A
    // nickname counts as naming them - a player who calls her Pikachu "Sparky"
    // shouldn't have to write "Pikachu" to get the type bonus - and is checked
    // first, since it's the more specific reference.
    findActingMember(party: PartyMember[], text: string): PartyMember|undefined {
        const byNickname = party.find(member => {
            const nickname = detailsOf(member).nickname;
            return nickname.length > 0 && new RegExp(`\\b${escapeRegex(nickname)}(?![A-Za-z0-9])`, 'i').test(text);
        });
        if (byNickname) return byNickname;

        const mentioned = findSpeciesMentions(text);
        return party.find(member => mentioned.some(name => name.toLowerCase() === member.species.toLowerCase()));
    }

    describeBag(anonymizedId: string): string {
        return this.getInventory(anonymizedId)
            .map(item => `${item.name} x${item.quantity}`)
            .join(', ');
    }

    // Who's in the party and what they're carrying. Movesets are deliberately
    // left out: they're the bulkiest part and the narrator doesn't need a
    // move list to describe what a moemon does.
    buildRosterNote(anonymizedId: string): string {
        const user = this.users[anonymizedId];
        if (!user) return '';

        const party = this.getFullParty(anonymizedId);
        if (party.length === 0) {
            return `${user.name} has no moemon yet.`;
        }

        // Movesets ride along only in RPG mode. They are the bulkiest part of
        // the note, and they are the one thing the card's stat block asks the
        // narrator to reproduce verbatim - so in RPG mode withholding them
        // guarantees the block and the panel disagree, and in the other two
        // modes sending them is paying for a line nobody will print.
        const withMoves = this.getMode() === 'rpg';

        const describe = (member: PartyMember) => {
            const details = detailsOf(member);
            const facts = [`${typesOf(member).join('/') || '???'}-type`, `Lv.${details.level}`];
            const condition = this.getCondition(anonymizedId, member.species);
            if (condition !== 'ok') facts.push(condition);
            if (details.heldItem) facts.push(`holding ${details.heldItem}`);
            if (withMoves) {
                const moves = details.moves.filter(move => move.trim().length > 0);
                if (moves.length > 0) facts.push(`knows ${moves.join(', ')}`);
            }
            // Nicknamed members read as "Sparky" (Pikachu, Electric-type,
            // ...) so the narrator can use the nickname and still knows
            // what she is.
            return labelFor(member, facts);
        };

        // The first member is the active one. Said plainly, because the stat
        // block the card asks for leads with her and otherwise the narrator
        // picks whoever it happened to mention last.
        const [active, ...bench] = party;
        const lines = [`${user.name}'s active moemon: ${describe(active)}.`];
        if (bench.length > 0) {
            lines.push(`In her balls: ${bench.map(describe).join('; ')}.`);
        }

        const bag = this.describeBag(anonymizedId);
        if (bag) lines.push(`Carrying: ${bag}.`);
        return lines.join(' ');
    }

    // Everything the narrator is periodically reminded of: the roster, plus
    // the continuity a long chat loses once it scrolls out of context. Kept
    // separate from buildRosterNote because the two have different readers -
    // this goes to the narrator on an interval, while the judge gets the
    // roster on its own, as one line among several it weighs per check.
    buildContextNote(anonymizedId: string): string {
        const roster = this.buildRosterNote(anonymizedId);
        if (!roster) return '';
        const lines = [roster];

        const setting = this.getEnvironment();
        if (setting) lines.push(`Setting: ${setting}.`);

        // Only open threads go over: a finished quest is a closed loop, and
        // restating it invites the narrator to reopen it.
        const open = this.getQuests(anonymizedId).filter(quest => !quest.done);
        if (open.length > 0) lines.push(`Open threads: ${open.map(quest => quest.text).join('; ')}.`);

        const npcs = this.getNpcs(anonymizedId).slice(-MAX_NPCS_IN_NOTE);
        if (npcs.length > 0) {
            lines.push(`Known characters: ${npcs.map(npc => {
                const facts = [describeAffinity(npc.affinity)];
                if (npc.note) facts.unshift(npc.note);
                return `${npc.name} (${facts.join('; ')})`;
            }).join('; ')}.`);
        }

        return lines.join(' ');
    }

    // Counts down to the next roster reminder, returning the note only on the
    // turns it's actually due.
    rosterNoteIfDue(anonymizedId: string): string {
        if (this.rosterInterval <= 0) return '';
        const userState = this.getUserState(anonymizedId);
        userState.turnsSinceRoster = (userState.turnsSinceRoster ?? 0) + 1;
        if (userState.turnsSinceRoster < this.rosterInterval) return '';
        userState.turnsSinceRoster = 0;
        const note = this.buildContextNote(anonymizedId);
        return note ? `\n[INST]${note}[/INST]` : '';
    }

    setStateFromMessageState(messageState: MessageStateType) {
        for (const user of Object.values(this.users)) {
            const userState = this.getUserState(user.anonymizedId);
            if (messageState != null) {
                const rawParty = messageState[user.anonymizedId]?.['autoParty'] ?? [];
                userState.autoParty = (Array.isArray(rawParty) ? rawParty : [])
                    .filter((member: any) => member && typeof member.species === 'string' && getSpecies(member.species))
                    // Details are regenerated rather than read back: they're
                    // deterministic per species, so auto members always show
                    // their species defaults without bloating message state.
                    .map((member: any) => ({species: member.species, source: 'auto', details: defaultDetailsFor(member.species)}));
                const lastOutcome = messageState[user.anonymizedId]?.['lastOutcome'] ?? null;
                userState.lastOutcome = lastOutcome ? this.convertOutcome(lastOutcome) : null;
                userState.lastOutcomePrompt = messageState[user.anonymizedId]?.['lastOutcomePrompt'] ?? '';
                userState.lastModeSent = parseModeOrNull(messageState[user.anonymizedId]?.['lastModeSent']);
                // Rewinding the chat rewinds the reminder cadence too, so a
                // swiped-away turn doesn't leave the counter out of step.
                userState.turnsSinceRoster = messageState[user.anonymizedId]?.['turnsSinceRoster'] ?? this.rosterInterval;
                userState.partyStatus = this.parsePartyStatus(messageState[user.anonymizedId]?.['partyStatus']);
                userState.turnsSinceScan = messageState[user.anonymizedId]?.['turnsSinceScan'] ?? 0;
            } else {
                userState.autoParty = [];
                userState.lastOutcome = null;
                userState.lastOutcomePrompt = '';
                userState.lastModeSent = null;
                userState.turnsSinceRoster = this.rosterInterval;
                userState.partyStatus = {};
                userState.turnsSinceScan = 0;
            }
            // Conditions set from the panel since the last message go on top:
            // they were made after this message state was written, so they
            // are the newer truth right up until the next hook folds them in.
            userState.partyStatus = {
                ...userState.partyStatus,
                ...this.getPendingConditions(user.anonymizedId)
            };
            this.userState[user.anonymizedId] = userState;
        }
        // Outside the per-player loop: the log is one shared record, so it
        // rewinds with a swipe exactly like the slots around it but is not
        // keyed by whoever happened to be swiping.
        this.storyLog = messageState != null ? parseStoryLog(messageState['storyLog']) : [];
    }

    // Reads conditions back from (untyped) message state, dropping keys that
    // no longer name a species and values that aren't conditions - the same
    // defensiveness autoParty gets, for the same reason.
    parsePartyStatus(raw: any): {[speciesLower: string]: Condition} {
        if (!raw || typeof raw !== 'object') return {};
        const parsed: {[speciesLower: string]: Condition} = {};
        for (const [species, condition] of Object.entries(raw)) {
            if (!getSpecies(species)) continue;
            if (condition === 'hurt' || condition === 'fainted' || condition === 'ok') {
                parsed[species.toLowerCase()] = condition;
            }
        }
        return parsed;
    }

    convertOutcome(input: any): Outcome {
        // Rolls persisted before the switch to percentages carried a d20 value
        // and a verdict string; the verdict is simply ignored, which leaves
        // the old number rendering as a small percentage in the panel. That is
        // cosmetic, on already-sent messages only, and not worth a migration.
        return new Outcome(input['roll'] ?? 0, this.convertAction(input['action']));
    }

    convertAction(input: any): Action {
        return new Action(input['description'], input['actor'] ?? null);
    }

    buildMessageState(): any {
        const messageState: any = {};
        for (const user of Object.values(this.users)) {
            const userState = this.getUserState(user.anonymizedId);
            messageState[user.anonymizedId] = {
                autoParty: userState.autoParty,
                lastOutcome: userState.lastOutcome ?? null,
                lastOutcomePrompt: userState.lastOutcomePrompt ?? '',
                lastModeSent: userState.lastModeSent ?? null,
                turnsSinceRoster: userState.turnsSinceRoster ?? 0,
                partyStatus: userState.partyStatus ?? {},
                turnsSinceScan: userState.turnsSinceScan ?? 0
            };
        }
        messageState['storyLog'] = this.storyLog;
        return messageState;
    }

    setLastOutcome(anonymizedId: string, outcome: Outcome|null, actingMember?: PartyMember) {
        const userState = this.getUserState(anonymizedId);
        userState.lastOutcome = outcome;
        userState.lastOutcomePrompt = '';
        if (!outcome) return;

        const lines = [`{{user}} has chosen the following action: ${outcome.action.description ?? ''}`];
        // What she's carrying and what shape she's in used to go to the judge;
        // with the judge gone it belongs to the narrator, or a held item stops
        // reaching the model at all.
        const actor = this.actorNote(anonymizedId, actingMember);
        if (actor) lines.push(actor);
        lines.push(rollDirection(outcome.roll));
        if (Object.values(this.users).length > 1) {
            lines.push(`Use third-person language for {{user}}.`);
        }
        userState.lastOutcomePrompt = `${lines.join('\n')}\n`;
    }

    // Substitutes {{user}}/{{char}}. A tag with no replacement is left as it
    // was rather than replaced with the string "undefined", which is what
    // reading straight off the map used to put in front of the model.
    replaceTags(source: string, replacements: {[name: string]: string}) {
        return source.replace(/{{([A-Za-z_]+)}}/g, (match, name) =>
            replacements[name] ?? match);
    }

    render(): ReactElement {
        return <PartyPanel stage={this} />;
    }

}
