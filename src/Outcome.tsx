import {Action} from "./Action";
import {NO_ODDS_IN_PROSE} from "./Mode";

// An action's roll is a percentage handed straight to the narrator: the
// chance the attempt comes off. It replaced a d20 plus a five-way verdict
// the chat's own model was asked to pick, which turned out to answer
// "no check" almost every time - an unparseable reply, an empty one (the
// request stopped on a newline), a truncated one, a timeout and an error all
// collapsed to the same permissive result. A number needs no parsing and
// cannot fail, and the narrator reads a gradient rather than one of five
// buckets.

export const ROLL_MIN = 0;
export const ROLL_MAX = 100;

// Only the extremes carry mechanical weight - they're what moves an acting
// moemon's condition. Everything between is narration.
export const CRITICAL_SUCCESS_AT = 95;
export const CRITICAL_FAILURE_AT = 5;

export function isCriticalSuccess(roll: number): boolean {
    return roll >= CRITICAL_SUCCESS_AT;
}

export function isCriticalFailure(roll: number): boolean {
    return roll <= CRITICAL_FAILURE_AT;
}

// CSS suffix for the panel's last-roll box. Bands the number rather than
// naming an outcome: the narrator decides what actually happens, so the panel
// would be inventing a verdict it doesn't have.
export function rollBand(roll: number): string {
    if (isCriticalSuccess(roll)) return 'critical-success';
    if (isCriticalFailure(roll)) return 'critical-failure';
    if (roll >= 60) return 'success';
    if (roll <= 30) return 'failure';
    return 'none';
}

// Named only where the stage itself did something with the number. An
// ordinary roll gets no label, because the panel genuinely doesn't know how
// it turned out.
export function describeRoll(roll: number): string {
    if (isCriticalSuccess(roll)) return 'critical success';
    if (isCriticalFailure(roll)) return 'critical failure';
    return '';
}

// The extra nudge given to the narrator at the extremes, on top of the
// percentage itself.
export function criticalDirection(roll: number): string {
    if (isCriticalSuccess(roll)) {
        return `This is an exceptional stroke of luck: let it succeed resoundingly, better than {{user}} could have hoped.`;
    }
    if (isCriticalFailure(roll)) {
        return `This goes disastrously wrong: let it fail dramatically and make {{user}}'s situation notably worse.`;
    }
    return '';
}

// Told to the narrator when the dice are off, so it treats the message as
// something that simply happens rather than something to be resolved. It says
// out loud that no roll was made: left to infer it, models fill the silence
// with a check of their own invention and open the reply with its verdict.
export const NO_ROLL_DIRECTION =
    `{{user}} took a risk-free action. Nothing was rolled for it and there are no odds `
    + `attached to it. ${NO_ODDS_IN_PROSE} Describe their actions and dialog in your own `
    + `words as you continue to propel the narrative.`;

// How the roll is put to the narrator. The number is the chance the attempt
// comes off, and the narrator is asked to read it as a gradient rather than
// a pass/fail line, so a middling roll produces a mixed result instead of
// being rounded to one or the other.
//
// The number is for the narrator alone. The panel logs it; the reply must not
// repeat it, because a reply that does teaches the model to write the same
// line in the modes where nothing is rolled at all.
export function rollDirection(roll: number): string {
    const lines = [
        `There is a ${roll}% chance this attempt succeeds.`,
        `Narrate it working out accordingly: a high number means it goes well, a low number means it goes badly, and a number near the middle means a partial or mixed result.`
    ];
    const critical = criticalDirection(roll);
    if (critical) lines.push(critical);
    lines.push(`This number is for you alone and {{user}} is not shown it. ${NO_ODDS_IN_PROSE}`);
    lines.push(`Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`);
    return lines.join(' ');
}

export class Outcome {
    // 0-100: the chance the action came off, as the narrator was told it.
    roll: number;
    action: Action;

    constructor(roll: number, action: Action) {
        this.roll = roll;
        this.action = action;
    }

    // Label for the panel's last-roll box, e.g. "Pikachu · 73%".
    getLabel(): string {
        return this.action.actor ? `${this.action.actor} · ${this.roll}%` : `${this.roll}%`;
    }
}
