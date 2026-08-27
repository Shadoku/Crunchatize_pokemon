import {Action} from "./Action";

export enum Result {
    CriticalFailure = 'Critical Failure',
    Failure = 'Failure',
    Success = 'Success',
    CriticalSuccess = 'Critical Success',
    None = 'No Check'
}

export const ResultDescription: {[result in Result]: string} = {
    [Result.CriticalFailure]: `{{user}} will fail to achieve their goal in dramatic, over-the-top fashion, actively and severely worsening their situation. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.Failure]: `{{user}} will fail to achieve their goal and will actively sour or worsen their situation. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.Success]: `{{user}} will successfully achieve what they were attempting and improve their situation. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.CriticalSuccess]: `{{user}} will resoundingly achieve what they were attempting, dramatically improving their situation in incredible fashion or with better-than-dreamed-of results. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.None]: '{{user}} took a risk-free action. Describe their actions and dialog in your own words as you continue to propel the narrative.'
}

// CSS class suffix per result, used by the panel to color-code the last roll box.
export const ResultClass: {[result in Result]: string} = {
    [Result.CriticalFailure]: 'critical-failure',
    [Result.Failure]: 'failure',
    [Result.Success]: 'success',
    [Result.CriticalSuccess]: 'critical-success',
    [Result.None]: 'none',
}

export class Outcome {
    roll: number;
    result: Result;
    action: Action;

    constructor(roll: number, result: Result, action: Action) {
        this.roll = roll;
        this.result = result;
        this.action = action;
    }

    // Label for the panel's last-roll box, e.g. "Pikachu · Critical Success".
    getLabel(): string {
        return this.action.actor ? `${this.action.actor} · ${this.result}` : this.result;
    }
}
