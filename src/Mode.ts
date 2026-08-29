// How much game the player wants showing, and whether anything is being
// adjudicated.
//
// This used to be two controls: a three-way mode switch (prose/story/rpg) and
// a separate Roll/No Roll toggle. They were really one axis - how much crunch
// is in force - and splitting them let a player ask for combinations nobody
// wanted (a full stat readout with nothing decided) while making the common
// choice a two-step. One ladder now: each rung says both how much of the game
// is written down and whether the dice are involved.

export type PlayMode = 'prose' | 'story' | 'rpg';

export const PLAY_MODES: PlayMode[] = ['prose', 'story', 'rpg'];

export const DEFAULT_MODE: PlayMode = 'story';

export function parseMode(raw: any): PlayMode {
    return PLAY_MODES.includes(raw) ? raw as PlayMode : DEFAULT_MODE;
}

// For "which mode was the narrator last told about", where "none yet" is a
// real answer and must not be rounded up to the default.
export function parseModeOrNull(raw: any): PlayMode|null {
    return PLAY_MODES.includes(raw) ? raw as PlayMode : null;
}

export const MODE_LABELS: {[mode in PlayMode]: string} = {
    prose: 'Prose',
    story: 'Story',
    rpg: 'RPG'
};

// Shown under the mode buttons, so the choice explains itself rather than
// needing the stage's description open in another tab.
export const MODE_BLURBS: {[mode in PlayMode]: string} = {
    prose: 'Pure narrative. No stat blocks, no dice.',
    story: 'Prose first; stat blocks appear once a battle does. No dice.',
    rpg: 'Full readouts every time a number moves, and every action is rolled.'
};

// Whether an action is put to the dice at all. Only RPG rolls: the other two
// rungs are the player saying they would rather write the scene than have it
// adjudicated.
export function modeRolls(mode: PlayMode): boolean {
    return mode === 'rpg';
}

// The rule that holds in every mode, and the reason this text exists at all:
// models were opening replies with a summary of the check ("76% success -
// good navigation, smooth return."). Once one reply does that the pattern
// sticks, and the model goes on writing those lines in modes where no dice
// were ever rolled - inventing numbers wholesale. So the ban is stated
// everywhere, not only where a roll actually happened.
export const NO_ODDS_IN_PROSE =
    'Never write a percentage, chance, roll, dice result, check, or a success/failure '
    + 'verdict anywhere in your reply, and never open with a line summarising how the '
    + 'attempt went. Show what happens in the narration itself.';

// What the narrator is told about the current mode. Sent when the mode
// changes and on the periodic reminder, not every turn.
export function modeDirection(mode: PlayMode): string {
    switch (mode) {
        case 'prose':
            return 'Narrate in prose only. Do not display a stat block, HP, levels or any '
                + 'other readout this scene. Nothing is being rolled for or adjudicated in '
                + `this mode: ${NO_ODDS_IN_PROSE} Mechanics still exist in the world - they `
                + 'simply are not being written down.';
        case 'rpg':
            return 'Play this as a tracked RPG. Display the full stat block whenever any '
                + 'value changes, using exactly the labels you were given, and keep HP, '
                + 'levels and status honest between turns. Actions are rolled for behind '
                + `the scenes and the result reaches you as a bracketed note. ${NO_ODDS_IN_PROSE}`;
        case 'story':
        default:
            return 'Prose leads. Show the stat block only while a battle or another '
                + 'mechanical exchange is actually being resolved, and never as the closing '
                + 'beat of a reply; a quiet scene needs no block at all. Nothing is being '
                + `rolled for or adjudicated in this mode: ${NO_ODDS_IN_PROSE}`;
    }
}
