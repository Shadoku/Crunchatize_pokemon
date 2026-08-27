export class Action {
    description: string;
    // The name of the party member performing the action, if any was identified.
    actor: string | null;

    constructor(description: string, actor: string | null) {
        this.description = description;
        this.actor = actor;
    }
}
