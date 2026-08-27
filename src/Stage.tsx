import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Action} from "./Action";
import {Outcome, Result, ResultDescription} from "./Outcome";
import {getSpecies, findSpeciesMentions, escapeRegex} from "./Lore";
import {PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, displayNameOf, labelFor, typesOf} from "./Party";
import {defaultDetailsFor} from "./Moveset";
import {InventoryItem, parseInventory, sameItem} from "./Inventory";
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
}

// How many prompts pass between roster reminders. The roster is reference
// material, not per-turn instruction, so repeating it every turn just spends
// tokens restating what rarely changes.
const DEFAULT_ROSTER_INTERVAL = 6;

// The classifier is awaited inside beforePrompt, which Chub is waiting on, so
// it needs a ceiling well inside Chub's own patience for a stage.
const CLASSIFIER_TIMEOUT_MS = 12000;

// Chat-wide (not tied to a branch) record of what the player has set up by
// hand in the panel: their explicit party edits, and their bag. Both are
// edited outside the normal lifecycle hooks, so they're persisted straight
// through the messenger rather than returned from beforePrompt.
interface ChatPartyState {
    manualParty: PartyMember[];
    inventory: InventoryItem[];
    // Whether typed messages are put to the dice. Set from the panel.
    rollEnabled: boolean;
}

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
            turnsSinceRoster: this.rosterInterval
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
        const existing = this.chatState[anonymizedId] ?? {manualParty: [], inventory: [], rollEnabled: true};
        this.chatState = {...this.chatState, [anonymizedId]: {...existing, ...patch}};
        await this.messenger.updateChatState(this.chatState);
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

        const result = await this.classifyOutcome(this.buildClassificationPrompt(anonymizedId, sequence, roll));
        return new Outcome(roll, result, new Action(text, actor));
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

    buildClassificationPrompt(anonymizedId: string, sequence: string, roll: number): string {
        const lastNarratorResponse = this.getUserState(anonymizedId).lastNarratorResponse;
        const roster = this.buildRosterNote(anonymizedId);
        const hint = this.difficultyHint();

        return [
            `Resolve this dice check for a Pokémon-style tabletop roleplay.`,
            lastNarratorResponse ? `Previous narration: ${lastNarratorResponse}` : null,
            roster ? `Party: ${roster}` : null,
            `Action: ${sequence}`,
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

    // Roster reference for the LLM, appended to the prompt every
    // rosterInterval turns rather than every turn. Movesets are deliberately
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
                // Nicknamed members read as "Sparky" (Pikachu, Electric-type,
                // ...) so the narrator can use the nickname and still knows
                // what she is.
                return labelFor(member, facts);
            }).join('; ')
            : 'no moemon';

        const bag = this.describeBag(anonymizedId);
        return `${user.name}'s party: ${roster}.${bag ? ` Carrying: ${bag}.` : ''}`;
    }

    // Counts down to the next roster reminder, returning the note only on the
    // turns it's actually due.
    rosterNoteIfDue(anonymizedId: string): string {
        if (this.rosterInterval <= 0) return '';
        const userState = this.getUserState(anonymizedId);
        userState.turnsSinceRoster = (userState.turnsSinceRoster ?? 0) + 1;
        if (userState.turnsSinceRoster < this.rosterInterval) return '';
        userState.turnsSinceRoster = 0;
        const note = this.buildRosterNote(anonymizedId);
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
            } else {
                userState.autoParty = [];
                userState.lastOutcome = null;
                userState.lastOutcomePrompt = '';
                userState.lastNarratorResponse = '';
                userState.turnsSinceRoster = this.rosterInterval;
            }
            this.userState[user.anonymizedId] = userState;
        }
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
                turnsSinceRoster: userState.turnsSinceRoster ?? 0
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
