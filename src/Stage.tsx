import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Action} from "./Action";
import {Outcome, Result, ResultDescription} from "./Outcome";
import {getSpecies, findSpeciesMentions, escapeRegex} from "./Lore";
import {
    PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, displayNameOf, labelFor, typesOf,
    Condition, stepConditionDown, stepConditionUp, parseParty
} from "./Party";
import {defaultDetailsFor} from "./Moveset";
import {InventoryItem, parseInventory, sameItem} from "./Inventory";
import {QuestEntry, parseQuests, newQuestId} from "./Quest";
import {NpcEntry, parseNpcs, clampAffinity, sameNpc, describeAffinity, findNpcMentions} from "./Npc";
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
    // The narrator's last reply, truncated the same way it's shown to the
    // player. Fed into the next action's classification prompt as context.
    lastNarratorResponse: string;
    // Prompts since the roster was last put in front of the LLM. Lives in
    // message state so rewinding the chat rewinds the cadence with it.
    turnsSinceRoster: number;
    // Condition (ok/hurt/fainted) per party member, keyed by lowercase
    // species. Lives in message state, not the chat-wide roster: it's a
    // running consequence of play, so a swipe should rewind it along with
    // the story rather than carry it into a branch where it never happened.
    partyStatus: {[speciesLower: string]: Condition};
}

// How many prompts pass between roster reminders. The roster is reference
// material, not per-turn instruction, so repeating it every turn just spends
// tokens restating what rarely changes.
const DEFAULT_ROSTER_INTERVAL = 6;

// The classifier is awaited inside beforePrompt, which Chub is waiting on, so
// it needs a ceiling well inside Chub's own patience for a stage.
const CLASSIFIER_TIMEOUT_MS = 12000;

// How far a check involving an NPC moves where the player stands with them.
// Criticals move twice as far, matching how they're the only results that
// move a party member's condition.
const AFFINITY_SHIFT: {[result in Result]: number} = {
    [Result.CriticalSuccess]: 2,
    [Result.Success]: 1,
    [Result.Failure]: -1,
    [Result.CriticalFailure]: -2,
    [Result.None]: 0
};

// Beyond this many tracked NPCs, only the most recently added are put in
// front of the LLM - the roster note is reference material, not a directory.
const MAX_NPCS_IN_NOTE = 6;

// Stamped into exported bundles. Nothing reads it yet - every field is
// validated on import regardless - but it's what a future format change
// would branch on to migrate an older save instead of rejecting it.
const SAVE_VERSION = 1;

// Chat-wide (not tied to a branch) record of what the player has set up by
// hand in the panel: their explicit party edits, and their bag. Both are
// edited outside the normal lifecycle hooks, so they're persisted straight
// through the messenger rather than returned from beforePrompt.
interface ChatPartyState {
    manualParty: PartyMember[];
    inventory: InventoryItem[];
    // Whether typed messages are put to the dice. Set from the panel.
    rollEnabled: boolean;
    // Open plot threads, and the recurring characters the story keeps
    // returning to. Chat-wide rather than message state: a thread the player
    // opened shouldn't vanish because they swiped a reply away.
    quests: QuestEntry[];
    npcs: NpcEntry[];
    // Where and when the scene is taking place. Shared by everyone in the
    // chat - see setEnvironment for why it's stored per-user anyway.
    environment: string;
}

const EMPTY_CHAT_STATE: ChatPartyState = {
    manualParty: [],
    inventory: [],
    rollEnabled: true,
    quests: [],
    npcs: [],
    environment: ''
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
        this.globalModifier = config?.difficultyModifier ?? 0;
        this.rosterInterval = Math.max(config?.rosterReminderInterval ?? DEFAULT_ROSTER_INTERVAL, 0);
        this.chatState = chatState ?? {};

        for (const user of Object.values(this.users)) {
            this.userState[user.anonymizedId] = this.initializeUserState();
        }
        this.setStateFromMessageState(messageState);
        this.seedPartyFromCharacters();
    }

    initializeUserState(): UserState {
        return {
            autoParty: [],
            lastOutcome: null,
            lastOutcomePrompt: '',
            lastNarratorResponse: '',
            // Starts due, so the LLM gets the roster on the first prompt
            // rather than only after a full interval has gone by.
            turnsSinceRoster: this.rosterInterval,
            partyStatus: {}
        }
    }

    getUserState(anonymizedId: string): UserState {
        return this.userState[anonymizedId] ?? this.initializeUserState();
    }

    // Any moemon character card already in the chat counts as a party member.
    seedPartyFromCharacters() {
        for (const character of Object.values(this.characters)) {
            if (character.isRemoved) continue;
            const species = getSpecies(character.name);
            if (!species) continue;
            for (const user of Object.values(this.users)) {
                this.addAutoPartyMember(user.anonymizedId, species.name);
            }
        }
    }

    getManualParty(anonymizedId: string): PartyMember[] {
        return this.chatState[anonymizedId]?.manualParty ?? [];
    }

    // The manual roster plus whatever's been auto-detected, deduped by species.
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

    addAutoPartyMember(anonymizedId: string, species: string) {
        const alreadyKnown = this.getFullParty(anonymizedId).some(member => member.species.toLowerCase() === species.toLowerCase());
        if (!alreadyKnown) {
            const userState = this.getUserState(anonymizedId);
            userState.autoParty = [...userState.autoParty, {species, source: 'auto', details: defaultDetailsFor(species)} as PartyMember];
        }
    }

    addAutoPartyMembersFromText(anonymizedId: string, text: string) {
        for (const species of findSpeciesMentions(text)) {
            this.addAutoPartyMember(anonymizedId, species);
        }
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
        const existing = this.chatState[anonymizedId] ?? EMPTY_CHAT_STATE;
        this.chatState = {...this.chatState, [anonymizedId]: {...existing, ...patch}};
    }

    // Adds a moemon to the player's roster by hand, at the level given (its
    // moves and held item follow from that level).
    async addPartyMember(anonymizedId: string, species: string, level: number = DEFAULT_DETAILS.level): Promise<void> {
        if (!getSpecies(species)) return;
        const existing = this.getManualParty(anonymizedId);
        if (existing.some(member => member.species.toLowerCase() === species.toLowerCase())) return;
        const member = {species, source: 'manual', details: defaultDetailsFor(species, level)} as PartyMember;
        await this.patchChatState(anonymizedId, {manualParty: [...existing, member]});
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
        if (!getSpecies(species)) return;
        const withoutSpecies = this.getManualParty(anonymizedId).filter(member => member.species.toLowerCase() !== species.toLowerCase());
        const member = {species, source: 'manual', details} as PartyMember;
        await this.patchChatState(anonymizedId, {manualParty: [...withoutSpecies, member]});
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

    // Shifts the standing of every tracked NPC named in the action or in the
    // narration it answers. Auto-detection in the same spirit as the party
    // list: a guess the player can always correct from the panel. Only
    // existing entries move - a name appearing in prose isn't evidence it's
    // an NPC worth tracking, so nothing is created here.
    applyOutcomeAffinity(anonymizedId: string, outcome: Outcome): void {
        const shift = AFFINITY_SHIFT[outcome.result] ?? 0;
        if (shift === 0) return;

        const npcs = this.getNpcs(anonymizedId);
        if (npcs.length === 0) return;

        const context = `${outcome.action.description ?? ''}\n${this.getUserState(anonymizedId).lastNarratorResponse}`;
        const mentioned = findNpcMentions(context, npcs);
        if (mentioned.length === 0) return;

        const touched = new Set(mentioned.map(npc => npc.name.toLowerCase()));
        this.stageChatState(anonymizedId, {
            npcs: npcs.map(npc => touched.has(npc.name.toLowerCase())
                ? {...npc, affinity: clampAffinity(npc.affinity + shift)}
                : npc)
        });
    }

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

    getCondition(anonymizedId: string, species: string): Condition {
        return this.getUserState(anonymizedId).partyStatus[species.toLowerCase()] ?? 'ok';
    }

    // Manual override from the panel - corrects an auto-nudge or applies a
    // status the narration described but the classifier didn't trigger.
    setCondition(anonymizedId: string, species: string, condition: Condition): void {
        const userState = this.getUserState(anonymizedId);
        userState.partyStatus = {...userState.partyStatus, [species.toLowerCase()]: condition};
    }

    // A critical result nudges the acting member's condition one notch;
    // everything else (including plain Failure/Success) leaves it alone -
    // this is flavor for the dramatic swings, not a full HP economy.
    applyOutcomeCondition(anonymizedId: string, member: PartyMember|undefined, result: Result): void {
        if (!member) return;

        const current = this.getCondition(anonymizedId, member.species);
        if (result === Result.CriticalFailure) {
            this.setCondition(anonymizedId, member.species, stepConditionDown(current));
        } else if (result === Result.CriticalSuccess) {
            this.setCondition(anonymizedId, member.species, stepConditionUp(current));
        }
    }

    // Whether the player's next message goes to the dice. Persisted per
    // player, so the choice survives a reload; defaults to rolling.
    isRollEnabled(anonymizedId: string): boolean {
        return this.chatState[anonymizedId]?.rollEnabled ?? true;
    }

    async setRollEnabled(anonymizedId: string, rollEnabled: boolean): Promise<void> {
        await this.patchChatState(anonymizedId, {rollEnabled});
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

    async setState(state: MessageStateType): Promise<void> {
        this.setStateFromMessageState(state);
    }

    // Resolves a line of action: rolls a d20 and asks the platform's own LLM
    // to judge the outcome from the roll plus scene context. Shared by the
    // normal chat path and by panel-initiated actions like using an item,
    // which never pass through beforePrompt and so must be resolved here.
    async resolveAction(anonymizedId: string, text: string, charName: string = ''): Promise<Outcome> {
        const sequence = this.replaceTags(text, {
            "user": this.users[anonymizedId]?.name ?? '',
            "char": charName
        });

        const roll = 1 + Math.floor(Math.random() * 20);
        const party = this.getFullParty(anonymizedId);
        const actingMember = this.findActingMember(party, sequence);
        const actor = actingMember ? displayNameOf(actingMember) : null;

        const result = await this.classifyOutcome(this.buildClassificationPrompt(anonymizedId, sequence, roll, actingMember));
        const outcome = new Outcome(roll, result, new Action(text, actor));
        this.applyOutcomeCondition(anonymizedId, actingMember, result);
        this.applyOutcomeAffinity(anonymizedId, outcome);
        return outcome;
    }

    // Turns a configured difficulty modifier into a plain-language lean for
    // the classification prompt, since there's no longer a numeric total to
    // add it to.
    difficultyHint(): string {
        const magnitude = Math.abs(this.globalModifier);
        if (magnitude === 0) return '';
        const intensity = magnitude >= 3 ? 'much' : magnitude >= 2 ? 'somewhat' : 'slightly';
        return this.globalModifier > 0
            ? `Judge ${intensity} more generously than usual.`
            : `Judge ${intensity} more strictly than usual.`;
    }

    // What the judge should know about whoever is taking the action: what
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

    buildClassificationPrompt(anonymizedId: string, sequence: string, roll: number, actingMember?: PartyMember): string {
        const lastNarratorResponse = this.getUserState(anonymizedId).lastNarratorResponse;
        const roster = this.buildRosterNote(anonymizedId);
        const hint = this.difficultyHint();
        const setting = this.getEnvironment();
        const actor = this.actorNote(anonymizedId, actingMember);

        return [
            `Resolve this dice check for a Pokémon-style tabletop roleplay.`,
            lastNarratorResponse ? `Previous narration: ${lastNarratorResponse}` : null,
            setting ? `Setting: ${setting}` : null,
            roster ? `Party: ${roster}` : null,
            `Action: ${sequence}`,
            actor ? `Actor: ${actor}` : null,
            `d20 roll: ${roll} (1-20)`,
            hint ? `Note: ${hint}` : null,
            `Respond with exactly one word: NoCheck, Failure, Success, CriticalSuccess, or CriticalFailure.`
        ].filter((line): line is string => !!line).join('\n');
    }

    async classifyOutcome(prompt: string): Promise<Result> {
        try {
            const response = await this.withTimeout(
                this.generator.textGen({prompt, max_tokens: 8, include_history: false, stop: ['\n']}),
                CLASSIFIER_TIMEOUT_MS
            );
            const result = this.parseClassificationResult(response?.result);
            console.log(`Classification result: ${response?.result} -> ${result}`);
            return result ?? Result.None;
        } catch (error) {
            console.log(error);
            return Result.None;
        }
    }

    withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Classifier timed out after ${timeoutMs}ms`)), timeoutMs);
            promise.then(
                (value) => { clearTimeout(timer); resolve(value); },
                (error) => { clearTimeout(timer); reject(error); }
            );
        });
    }

    // Reduces the LLM's free-text reply to one of the strict outcome labels.
    // Anything that doesn't clearly match falls through to null, which the
    // caller treats as a safe no-op rather than forcing a failure.
    parseClassificationResult(raw: string|undefined|null): Result|null {
        if (!raw) return null;
        const normalized = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
        if (!normalized) return null;

        const critical = normalized.includes('crit');
        if (critical && normalized.includes('fail')) return Result.CriticalFailure;
        if (critical && (normalized.includes('success') || normalized.includes('pass'))) return Result.CriticalSuccess;
        if (normalized.includes('fail')) return Result.Failure;
        if (normalized.includes('success') || normalized.includes('pass')) return Result.Success;
        if (normalized.includes('nocheck') || normalized.includes('none')) return Result.None;
        return null;
    }

    // Told to the narrator when the dice are off, so it treats the message as
    // something that simply happens rather than something to be resolved.
    buildNoRollDirections(anonymizedId: string, charName: string = ''): string {
        const instruction = this.replaceTags(ResultDescription[Result.None], {
            "user": this.users[anonymizedId]?.name ?? '',
            "char": charName
        });
        return `\n[INST]${instruction}\n[/INST]${this.rosterNoteIfDue(anonymizedId)}`;
    }

    // The [INST] block handed to the LLM for a resolved action.
    buildStageDirections(anonymizedId: string, charName: string = ''): string {
        const prompt = this.replaceTags(this.getUserState(anonymizedId).lastOutcomePrompt, {
            "user": this.users[anonymizedId]?.name ?? '',
            "char": charName
        });
        return `\n[INST]${prompt}\n[/INST]${this.rosterNoteIfDue(anonymizedId)}`;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            anonymizedId,
            content,
            promptForId
        } = userMessage;

        const errorMessage: string|null = null;
        // The player's original message, sent to chat untouched - the roll
        // and its outcome are never written into the visible text or history,
        // only into stageDirections (for the narrator) and the panel.
        const finalContent: string|undefined = content;

        // Dice turned off from the panel: the message goes through untouched,
        // with no classification and so no waiting on the classifier either.
        if (!this.isRollEnabled(anonymizedId)) {
            if (finalContent) this.addAutoPartyMembersFromText(anonymizedId, finalContent);
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
            this.addAutoPartyMembersFromText(anonymizedId, finalContent);
            const outcome = await this.resolveAction(anonymizedId, content,
                promptForId ? this.characters[promptForId]?.name ?? '' : '');
            this.setLastOutcome(anonymizedId, outcome);
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

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const message = botMessage.content;
        const narratorResponse = message.split(/---|\*\*\*|```|system:/i)[0].trim();

        for (const user of Object.values(this.users)) {
            this.addAutoPartyMembersFromText(user.anonymizedId, message);
            const userState = this.getUserState(user.anonymizedId);
            userState.lastOutcomePrompt = '';
            // Kept as context for the next action's classification prompt.
            userState.lastNarratorResponse = narratorResponse;
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
                ? party.map(member => `${labelFor(member, [typesOf(member).join('/') || '???'])} Lv.${detailsOf(member).level}`).join(', ')
                : 'No moemon yet'}`);

            const bag = this.describeBag(user.anonymizedId);
            if (bag) lines.push(`${user.name}'s Bag: ${bag}`);
        }
        return '---\n```' + lines.join('\n') + '```';
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
        const roster = party.length > 0
            ? party.map(member => {
                const details = detailsOf(member);
                const facts = [`${typesOf(member).join('/') || '???'}-type`, `Lv.${details.level}`];
                if (details.heldItem) facts.push(`holding ${details.heldItem}`);
                const condition = this.getCondition(anonymizedId, member.species);
                if (condition !== 'ok') facts.push(condition);
                // Nicknamed members read as "Sparky" (Pikachu, Electric-type,
                // ...) so the narrator can use the nickname and still knows
                // what she is.
                return labelFor(member, facts);
            }).join('; ')
            : 'no moemon';

        const bag = this.describeBag(anonymizedId);
        return `${user.name}'s party: ${roster}.${bag ? ` Carrying: ${bag}.` : ''}`;
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
                userState.lastNarratorResponse = messageState[user.anonymizedId]?.['lastNarratorResponse'] ?? '';
                // Rewinding the chat rewinds the reminder cadence too, so a
                // swiped-away turn doesn't leave the counter out of step.
                userState.turnsSinceRoster = messageState[user.anonymizedId]?.['turnsSinceRoster'] ?? this.rosterInterval;
                userState.partyStatus = this.parsePartyStatus(messageState[user.anonymizedId]?.['partyStatus']);
            } else {
                userState.autoParty = [];
                userState.lastOutcome = null;
                userState.lastOutcomePrompt = '';
                userState.lastNarratorResponse = '';
                userState.turnsSinceRoster = this.rosterInterval;
                userState.partyStatus = {};
            }
            this.userState[user.anonymizedId] = userState;
        }
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
        return new Outcome(input['roll'] ?? 0, input['result'] ?? Result.None, this.convertAction(input['action']));
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
                lastNarratorResponse: userState.lastNarratorResponse ?? '',
                turnsSinceRoster: userState.turnsSinceRoster ?? 0,
                partyStatus: userState.partyStatus ?? {}
            };
        }
        return messageState;
    }

    setLastOutcome(anonymizedId: string, outcome: Outcome|null) {
        const userState = this.getUserState(anonymizedId);
        userState.lastOutcome = outcome;
        userState.lastOutcomePrompt = '';
        if (userState.lastOutcome) {
            userState.lastOutcomePrompt += `{{user}} has chosen the following action: ${userState.lastOutcome.action.description ?? ''}\n`;
            userState.lastOutcomePrompt += `${ResultDescription[userState.lastOutcome.result ?? Result.None]}\n`
            if (Object.values(this.users).length > 1) {
                userState.lastOutcomePrompt += `Use third-person language for {{user}}.\n`;
            }
        }
    }

    replaceTags(source: string, replacements: {[name: string]: string}) {
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            return replacements[match.substring(2, match.length - 2)];
        });
    }

    render(): ReactElement {
        return <PartyPanel stage={this} />;
    }

}
