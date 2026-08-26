import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Action} from "./Action";
import {Outcome, Result, ResultDescription} from "./Outcome";
import {MoemonType, TypeDomainDescription, bestEffectiveness, modifierForMultiplier} from "./MoemonType";
import {getSpecies, findSpeciesMentions} from "./Lore";
import {PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, typesOf} from "./Party";
import {PartyPanel} from "./PartyPanel";

// Prefix used to mark a message sent via the panel's freeform box so
// beforePrompt skips classification/rolling entirely; always stripped before
// the message is displayed. Chub's native input box handles ordinary (rolled)
// actions, so anything typed there takes the normal path. A player who typed
// this marker verbatim would skip their own roll, which is harmless.
const NO_ROLL_MARKER = '[[NOROLL]]';

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
}

// Chat-wide (not tied to a branch) record of party members the player has
// explicitly added or removed by hand via the party panel.
interface ChatPartyState {
    manualParty: PartyMember[];
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
            lastOutcomePrompt: ''
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
            userState.autoParty = [...userState.autoParty, {species, source: 'auto', details: DEFAULT_DETAILS} as PartyMember];
        }
    }

    addAutoPartyMembersFromText(anonymizedId: string, text: string) {
        for (const species of findSpeciesMentions(text)) {
            this.addAutoPartyMember(anonymizedId, species);
        }
    }

    // Adds a moemon to the player's roster by hand; persisted immediately via
    // the messenger, since this happens outside the normal lifecycle hooks.
    async addPartyMember(anonymizedId: string, species: string): Promise<void> {
        if (!getSpecies(species)) return;
        const existing = this.getManualParty(anonymizedId);
        if (existing.some(member => member.species.toLowerCase() === species.toLowerCase())) return;
        this.chatState = {
            ...this.chatState,
            [anonymizedId]: {manualParty: [...existing, {species, source: 'manual', details: DEFAULT_DETAILS} as PartyMember]}
        };
        await this.messenger.updateChatState(this.chatState);
    }

    async removePartyMember(anonymizedId: string, species: string): Promise<void> {
        const manualParty = this.getManualParty(anonymizedId).filter(member => member.species.toLowerCase() !== species.toLowerCase());
        this.chatState = {...this.chatState, [anonymizedId]: {manualParty}};
        const userState = this.getUserState(anonymizedId);
        userState.autoParty = userState.autoParty.filter(member => member.species.toLowerCase() !== species.toLowerCase());
        await this.messenger.updateChatState(this.chatState);
    }

    // Saves edited level/moves/held item for a party member, whether it was
    // previously manual, auto-only, or brand new - "editing" always targets
    // a member currently surfaced by getFullParty, so this always promotes
    // it into the persisted, chat-wide roster.
    async updatePartyMemberDetails(anonymizedId: string, species: string, details: PartyMemberDetails): Promise<void> {
        if (!getSpecies(species)) return;
        const withoutSpecies = this.getManualParty(anonymizedId).filter(member => member.species.toLowerCase() !== species.toLowerCase());
        this.chatState = {
            ...this.chatState,
            [anonymizedId]: {manualParty: [...withoutSpecies, {species, source: 'manual', details} as PartyMember]}
        };
        await this.messenger.updateChatState(this.chatState);
    }

    // Sends the player's text as plain dialogue/narration that's guaranteed
    // not to trigger a roll - see the NO_ROLL_MARKER handling in beforePrompt.
    // Rolled actions go through Chub's native input instead.
    async sendPartyDialogue(anonymizedId: string, text: string): Promise<void> {
        await this.messenger.impersonate({speaker_id: anonymizedId, message: NO_ROLL_MARKER + text, parent_id: null, is_main: true});
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

        // Sent via the panel's "Send Dialogue" button: skip classification
        // and rolling entirely, and just pass the (unmarked) text through.
        if (finalContent?.startsWith(NO_ROLL_MARKER)) {
            finalContent = finalContent.slice(NO_ROLL_MARKER.length);
            this.addAutoPartyMembersFromText(anonymizedId, finalContent);
            this.setLastOutcome(anonymizedId, null);

            return {
                stageDirections: null,
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
            })}\n[/INST]`,
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

    buildPartySystemMessage(): string {
        const lines = Object.values(this.users).map(user => {
            const party = this.getFullParty(user.anonymizedId);
            const partyDescription = party.length > 0
                ? party.map(member => this.describePartyMember(member)).join(', ')
                : 'No moemon yet';
            return `${user.name}'s Party: ${partyDescription}`;
        });
        return '---\n```' + lines.join('\n') + '```';
    }

    // Compact roster line for one member, including the editable build info
    // (level/item/moves) so it actually informs narration, not just the panel.
    describePartyMember(member: PartyMember): string {
        const details = detailsOf(member);
        const parts = [`Lv.${details.level}`];
        if (details.heldItem) parts.push(`Item: ${details.heldItem}`);
        const moves = details.moves.filter(move => move.trim().length > 0);
        if (moves.length > 0) parts.push(`Moves: ${moves.join(', ')}`);
        return `${member.species} (${typesOf(member).join('/') || '???'}) ${parts.join(' | ')}`;
    }

    setStateFromMessageState(messageState: MessageStateType) {
        for (const user of Object.values(this.users)) {
            const userState = this.getUserState(user.anonymizedId);
            if (messageState != null) {
                const rawParty = messageState[user.anonymizedId]?.['autoParty'] ?? [];
                userState.autoParty = (Array.isArray(rawParty) ? rawParty : [])
                    .filter((member: any) => member && typeof member.species === 'string' && getSpecies(member.species))
                    .map((member: any) => ({species: member.species, source: 'auto', details: DEFAULT_DETAILS}));
                const lastOutcome = messageState[user.anonymizedId]?.['lastOutcome'] ?? null;
                userState.lastOutcome = lastOutcome ? this.convertOutcome(lastOutcome) : null;
                userState.lastOutcomePrompt = messageState[user.anonymizedId]?.['lastOutcomePrompt'] ?? '';
            } else {
                userState.autoParty = [];
                userState.lastOutcome = null;
                userState.lastOutcomePrompt = '';
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
                lastOutcomePrompt: userState.lastOutcomePrompt ?? ''
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
