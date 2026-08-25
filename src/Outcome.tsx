import {Action} from "./Action";

export enum Result {
    Failure = 'Failure',
    MixedSuccess = 'Mixed Success',
    CompleteSuccess = 'Complete Success',
    CriticalSuccess = 'Critical Success',
    None = 'No Roll Needed'
}

export const ResultDescription: {[result in Result]: string} = {
    [Result.Failure]: `{{user}} will fail to achieve their goal and will actively sour or worsen their situation. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.MixedSuccess]: `{{user}} may achieve their goal, but in an inferior way or at some cost. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.CompleteSuccess]: `{{user}} will successfully achieve what they were attempting and improve their situation. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.CriticalSuccess]: `{{user}} will resoundingly achieve what they were attempting, dramatically improving their situation in incredible fashion or with better-than-dreamed-of results. Describe {{user}}'s actions and outcomes in your own words as you continue to propel the narrative.`,
    [Result.None]: '{{user}} took a risk-free action. Describe their actions and dialog in your own words as you continue to propel the narrative.'
}

export const ResultSpan: {[result in Result]: (input: string) => string} = {
    [Result.Failure]: (input: string) => `<span style='color: red;'>${input}</span>`,
    [Result.MixedSuccess]: (input: string) => `<span style='color: darkorange;'>${input}</span>`,
    [Result.CompleteSuccess]: (input: string) => `<span style='color: mediumseagreen;'>${input}</span>`,
    [Result.CriticalSuccess]: (input: string) => `<span style='color: #b9f2ff;''>${input}</span>`,
    [Result.None]: (input: string) => input,
}

const emojiDice: {[key: number]: string} = {
    1: ResultSpan["Failure"]('⚀ 1'),
    2: ResultSpan["Mixed Success"]('⚁ 2'),
    3: ResultSpan["Mixed Success"]('⚂ 3'),
    4: ResultSpan["Complete Success"]('⚃ 4'),
    5: ResultSpan["Complete Success"]('⚄ 5'),
    6: ResultSpan["Critical Success"]('⚅ 6')
}

export class Outcome {
    result: Result;
    dieResult1: number;
    dieResult2: number;
    action: Action;
    total: number;

    constructor(dieResult1: number, dieResult2: number, action: Action) {
        const total = dieResult1 + dieResult2 + action.difficultyModifier + action.typeModifier;
        this.result = (!action.domain ? Result.None : (dieResult1 + dieResult2 == 12 ? Result.CriticalSuccess : (total >= 10 ? Result.CompleteSuccess : (total >= 7 ? Result.MixedSuccess : Result.Failure))));

        this.dieResult1 = dieResult1;
        this.dieResult2 = dieResult2;
        this.action = action;
        this.total = this.dieResult1 + this.dieResult2 + this.action.difficultyModifier + this.action.typeModifier;
    }

    getDieEmoji(side: number): string {
        return emojiDice[side];
    }

    getDifficultyColor(modifier: number): string {
        const modString = `${Math.abs(modifier)}`;
        switch(modifier) {
            case 1:
                return `${modifier >= 0 ? ' + ' : ' - '}${ResultSpan["Critical Success"](modString)}`;
            case 0:
                return `${modifier >= 0 ? ' + ' : ' - '}${ResultSpan["Complete Success"](modString)}`;
            case -1:
                return `${modifier >= 0 ? ' + ' : ' - '}${ResultSpan["Mixed Success"](modString)}`;
            default:
                return `${modifier >= 0 ? ' + ' : ' - '}${ResultSpan["Failure"](modString)}`;
        }
    }

    getLabel(): string {
        const domainLabel = this.action.domain ?? 'No Check';
        return this.action.actor ? `${this.action.actor} · ${domainLabel}` : domainLabel;
    }

    getDescription(): string {
        if (this.action.domain) {
            return `###(${this.getLabel()}) ${this.action.description}###\n#${this.getDieEmoji(this.dieResult1)} + ${this.getDieEmoji(this.dieResult2)}${this.getDifficultyColor(this.action.difficultyModifier)}<sup><sub><sup>(difficulty)</sup></sub></sup>${this.action.typeModifier != 0 ? ` ${this.action.typeModifier > 0 ? '+' : '-'} ${ResultSpan["Complete Success"](`${Math.abs(this.action.typeModifier)}`)}<sup><sub><sup>(type)</sup></sub></sup>` : ''} = ${ResultSpan[this.result](`${this.total} (${this.result})`)}#`
        } else {
            return `###(No Check) ${this.action.description}###`;
        }
    }
}
