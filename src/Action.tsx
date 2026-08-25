import {Outcome} from "./Outcome";
import {MoemonType} from "./MoemonType";

export class Action {
    description: string;
    // The elemental domain the scene calls for, or null if the action is
    // mundane/risk-free and needs no roll at all.
    domain: MoemonType | null;
    difficultyModifier: number;
    // How well the acting party member's (or the party's) type(s) match the domain.
    typeModifier: number;
    // The name of the party member performing the action, if any was identified.
    actor: string | null;

    constructor(description: string, domain: MoemonType | null, difficultyModifier: number, typeModifier: number, actor: string | null) {
        this.description = description;
        this.domain = domain;
        this.difficultyModifier = difficultyModifier;
        this.typeModifier = typeModifier;
        this.actor = actor;
    }

    // Method to simulate a dice roll
    diceRoll(): number {
        return Math.floor(Math.random() * 6) + 1;
    }

    // Method to determine success, partial success, or failure
    determineSuccess(): Outcome {
        const dieResult1: number = this.diceRoll();
        const dieResult2: number = this.diceRoll();
        return new Outcome(dieResult1, dieResult2, this);
    }
}
