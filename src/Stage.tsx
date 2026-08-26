import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Action} from "./Action";
import {Outcome, Result, ResultDescription} from "./Outcome";
import {MoemonType, TypeDomainDescription, bestEffectiveness, modifierForMultiplier} from "./MoemonType";
import {getSpecies, findSpeciesMentions} from "./Lore";
import {PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, typesOf} from "./Party";
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
    // Prompts since the roster was last put in front of the LLM. Lives in
    // message state so rewinding the chat rewinds the cadence with it.
    turnsSinceRoster: number;
}

// How many prompts pass between roster reminders. The roster is reference
// material, not per-turn instruction, so repeating it every turn just spends
// tokens restating what rarely changes.
const DEFAULT_ROSTER_INTERVAL = 6;

// Chat-wide (not tied to a branch) record of what the player has set up by
// hand in the panel: their explicit party edits, and their bag. Both are
// edited outside the normal lifecycle hooks, so they're persisted straight
// through the messenger rather than returned from beforePrompt.
interface ChatPartyState {
    manualParty: PartyMember[];
    inventory: InventoryItem[];
}

const DOMAIN_HYPOTHESIS = 'The narrator\'s action principally draws upon {}.';
const MUNDANE_LABEL = 'ordinary conversation or a risk-free action';
const DOMAIN_MAPPING: {[key: string]: MoemonType|null} = Object.values(MoemonType).reduce((map, type) => {
    map[TypeDomainDescription[type]] = type;
    return map;
}, {[MUNDANE_LABEL]: null} as {[key: string]: MoemonType|null});

const DIFFICULTY_HYPOTHESIS = 'On a scale of 1-6, the difficulty of the narrator\'s actions is {}.';
const DIFFICULTY_MAPPING: {[key: string]: number} = {
    '1 (simple and safe)': 1000,
    '2 (straightforward or fiddly)': 1,
    '3 (complex or tricky)': 0,
    '4 (challenging and risky)': -1,
    '5 (arduous and dangerous)': -2,
    '6 (virtually impossible)': -3
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

    // Text the panel injected that must not be rolled on (the freeform box).
    // Matched by content rather than a marker in the message itself: the
    // message reaches the chat via impersonate(), which does not call
    // beforePrompt, so a marker would never get stripped and would show up
    // verbatim in the chat. Matching also means a flag left behind - if
    // beforePrompt never fires - can't swallow the roll on some later,
    // unrelated action.
    noRollContent: string|null = null;


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
        const existing = this.chatState[anonymizedId] ?? {manualParty: [], inventory: []};
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

    // Spends one of an item and announces it in the chat as an ordinary
    // action, so whether it works is put to the dice like anything else.
    // The stack is decremented first, and drops off the list at zero.
    async useInventoryItem(anonymizedId: string, name: string): Promise<void> {
        const inventory = this.getInventory(anonymizedId);
        const existing = inventory.find(item => sameItem(item.name, name));
        if (!existing) return;

        const updated = existing.quantity > 1
            ? inventory.map(item => sameItem(item.name, name) ? {...item, quantity: item.quantity - 1} : item)
            : inventory.filter(item => !sameItem(item.name, name));
        await this.patchChatState(anonymizedId, {inventory: updated});
        await this.speakAsPlayer(anonymizedId, `I use the ${existing.name}.`);
    }

    // Puts a message in the chat as the player, then asks a bot to reply.
    // impersonate() only inserts the message - it never prompts anyone - so
    // without the nudge the message just sits there and the chat stalls.
    async speakAsPlayer(anonymizedId: string, text: string): Promise<void> {
        await this.messenger.impersonate({speaker_id: anonymizedId, message: text, parent_id: null, is_main: true});
        await this.messenger.nudge({speaker_id: this.respondingCharacterId(), parent_id: null, is_main: true});
    }

    // Whichever character should answer something the panel injected. In a
    // one-character chat this is simply that character.
    respondingCharacterId(): string|undefined {
        return Object.values(this.characters).find(character => !character.isRemoved)?.anonymizedId;
    }

    // Sends the player's text as plain dialogue/narration that's guaranteed
    // not to trigger a roll. Rolled actions go through Chub's native input
    // instead, or through item use below.
    async sendPartyDialogue(anonymizedId: string, text: string): Promise<void> {
        this.noRollContent = text.trim();
        await this.speakAsPlayer(anonymizedId, text);
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

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            anonymizedId,
            content,
            promptForId
        } = userMessage;

        const errorMessage: string|null = null;
        let takenAction: Action|null = null;
        let finalContent: string|undefined = content;

        // Sent via the panel's freeform box: skip classification and rolling
        // entirely and pass the text straight through.
        if (finalContent && this.noRollContent !== null && finalContent.trim() === this.noRollContent) {
            this.noRollContent = null;
            this.addAutoPartyMembersFromText(anonymizedId, finalContent);
            this.setLastOutcome(anonymizedId, null);
            const rosterNote = this.rosterNoteIfDue(anonymizedId);

            return {
                stageDirections: rosterNote || null,
                messageState: this.buildMessageState(),
                modifiedMessage: finalContent,
                systemMessage: null,
                error: errorMessage,
                chatState: this.chatState,
            };
        }

        if (finalContent) {
            this.addAutoPartyMembersFromText(anonymizedId, finalContent);

            const sequence = this.replaceTags(content,
                {"user": anonymizedId ? this.users[anonymizedId].name : '', "char": promptForId ? this.characters[promptForId].name : ''});

            // Kick both classifications off together; only the difficulty one needs awaiting first.
            const domainPromise = this.query({sequence: sequence, candidate_labels: Object.keys(DOMAIN_MAPPING), hypothesis_template: DOMAIN_HYPOTHESIS, multi_label: true});

            let difficultyRating: number = 0;
            const difficultyResponse = await this.query({sequence: sequence, candidate_labels: Object.keys(DIFFICULTY_MAPPING), hypothesis_template: DIFFICULTY_HYPOTHESIS, multi_label: true });
            console.log(`Difficulty modifier selected: ${DIFFICULTY_MAPPING[difficultyResponse.labels[0]] + this.globalModifier}`);
            if (difficultyResponse && difficultyResponse.labels[0]) {
                difficultyRating = DIFFICULTY_MAPPING[difficultyResponse.labels[0]] + this.globalModifier;
            }

            let domain: MoemonType|null = null;
            const domainResponse = await domainPromise;
            if (domainResponse && domainResponse.labels && domainResponse.scores[0] > 0.1) {
                domain = DOMAIN_MAPPING[domainResponse.labels[0]];
                console.log(`Domain selected: ${domain}`);
            }

            if (domain && difficultyRating < 1000) {
                const party = this.getFullParty(anonymizedId);
                const mentionedSpecies = findSpeciesMentions(sequence);
                const actingSpecies = mentionedSpecies.find(name => party.some(member => member.species.toLowerCase() === name.toLowerCase()));

                let typeModifier = 0;
                let actor: string|null = null;
                if (actingSpecies) {
                    const member = party.find(member => member.species.toLowerCase() === actingSpecies.toLowerCase())!;
                    actor = member.species;
                    typeModifier = modifierForMultiplier(bestEffectiveness(typesOf(member), domain));
                } else if (party.length > 0) {
                    // No specific actor named; the party supports ambiently, at half strength.
                    const bestMatch = Math.max(...party.map(member => bestEffectiveness(typesOf(member), domain as MoemonType)));
                    typeModifier = Math.round(modifierForMultiplier(bestMatch) / 2);
                }

                takenAction = new Action(finalContent, domain, difficultyRating, typeModifier, actor);
            } else {
                takenAction = new Action(finalContent, null, 0, 0, null);
            }
        }

        if (takenAction) {
            this.setLastOutcome(anonymizedId, takenAction.determineSuccess());
            finalContent = this.getUserState(anonymizedId).lastOutcome?.getDescription();
        }

        return {
            stageDirections: `\n[INST]${this.replaceTags(this.getUserState(anonymizedId).lastOutcomePrompt,{
                "user": this.users[anonymizedId].name,
                "char": promptForId ? this.characters[promptForId].name : ''
            })}\n[/INST]${this.rosterNoteIfDue(anonymizedId)}`,
            messageState: this.buildMessageState(),
            modifiedMessage: finalContent,
            systemMessage: null,
            error: errorMessage,
            chatState: this.chatState,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const message = botMessage.content;

        for (const user of Object.values(this.users)) {
            this.addAutoPartyMembersFromText(user.anonymizedId, message);
            this.getUserState(user.anonymizedId).lastOutcomePrompt = '';
        }

        return {
            stageDirections: null,
            messageState: this.buildMessageState(),
            modifiedMessage: message.split(/---|\*\*\*|```|system:/i)[0].trim(),
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
                ? party.map(member => `${member.species} (${typesOf(member).join('/') || '???'}) Lv.${detailsOf(member).level}`).join(', ')
                : 'No moemon yet'}`);

            const bag = this.describeBag(user.anonymizedId);
            if (bag) lines.push(`${user.name}'s Bag: ${bag}`);
        }
        return '---\n```' + lines.join('\n') + '```';
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
                const held = details.heldItem ? `, holding ${details.heldItem}` : '';
                return `${member.species} (${typesOf(member).join('/') || '???'}-type, Lv.${details.level}${held})`;
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
                // Rewinding the chat rewinds the reminder cadence too, so a
                // swiped-away turn doesn't leave the counter out of step.
                userState.turnsSinceRoster = messageState[user.anonymizedId]?.['turnsSinceRoster'] ?? this.rosterInterval;
            } else {
                userState.autoParty = [];
                userState.lastOutcome = null;
                userState.lastOutcomePrompt = '';
                userState.turnsSinceRoster = this.rosterInterval;
            }
            this.userState[user.anonymizedId] = userState;
        }
    }

    convertOutcome(input: any): Outcome {
        return new Outcome(input['dieResult1'], input['dieResult2'], this.convertAction(input['action']));
    }

    convertAction(input: any): Action {
        return new Action(input['description'], input['domain'] ?? null, input['difficultyModifier'] ?? 0, input['typeModifier'] ?? 0, input['actor'] ?? null);
    }

    buildMessageState(): any {
        const messageState: any = {};
        for (const user of Object.values(this.users)) {
            const userState = this.getUserState(user.anonymizedId);
            messageState[user.anonymizedId] = {
                autoParty: userState.autoParty,
                lastOutcome: userState.lastOutcome ?? null,
                lastOutcomePrompt: userState.lastOutcomePrompt ?? '',
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

    async awaitPipeline(pipeline: string, eventId: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = `https://${pipeline}/${eventId}`;
            const evtSource = new EventSource(url, {withCredentials: false});

            evtSource.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    resolve(data);
                    evtSource.close();
                } catch (exception) {
                    reject(exception);
                }
            };

            evtSource.addEventListener("complete", (e) => {
                try {
                    const data = JSON.parse((e as MessageEvent).data);
                    resolve(data);
                } catch (exception) {
                    reject(exception);
                } finally {
                    evtSource.close();
                }
            });

            evtSource.onerror = (e) => {
                evtSource.close();
                reject(e);
            };
        });
    }

    async query(data: any) {
        let result: any = null;
        let retries = 3;
        const pipeline = "ravenok-statosphere-backend.hf.space/gradio_api/call/predict";
        while (retries > 0 && (!result || result.labels.length == 0)) {
            try {
                const request = await fetch(`https://${pipeline}`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({data: [JSON.stringify(data)]}),
                    credentials: "omit"
                });

                const { event_id } = await request.json();
                const response = await this.awaitPipeline(pipeline, event_id);
                result = JSON.parse(response[0]);
            } catch (error) {
                console.log(error);
                retries--;
            }
        }

        console.log(result);
        return result;
    }

    render(): ReactElement {
        return <PartyPanel stage={this} />;
    }

}
