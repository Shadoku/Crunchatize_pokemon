// How much game the player wants showing.
//
// The card and the stage between them can run this as a straight novel or as
// a full stat-tracked RPG, and which one a player wants changes mid-chat -
// usually the moment a battle starts. Rather than making them edit config or
// argue with the narrator about stat blocks, the panel offers three settings
// and the stage tells the narrator which one is in force.

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
    story: 'Prose first; stat blocks appear once a battle does. Dice on.',
    rpg: 'Full readouts every time a number moves. Dice on.'
};

// Whether an action is put to the dice at all. Prose mode never rolls - the
// point of it is that nothing is being adjudicated.
export function modeRolls(mode: PlayMode): boolean {
    return mode !== 'prose';
}

// What the narrator is told about the current mode. Sent when the mode
// changes and on the periodic reminder, not every turn.
export function modeDirection(mode: PlayMode): string {
    switch (mode) {
        case 'prose':
            return 'Narrate in prose only. Do not display a stat block, HP, levels or any '
                + 'other readout this scene, and do not ask for dice. Mechanics still exist '
                + 'in the world - they simply are not being written down.';
        case 'rpg':
            return 'Play this as a tracked RPG. Display the full stat block whenever any '
                + 'value changes, using exactly the labels you were given, and keep HP, '
                + 'levels and status honest between turns.';
        case 'story':
        default:
            return 'Prose leads. Show the stat block only while a battle or another '
                + 'mechanical exchange is actually being resolved, and never as the closing '
                + 'beat of a reply; a quiet scene needs no block at all.';
    }
}
