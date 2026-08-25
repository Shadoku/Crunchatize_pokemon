export enum MoemonType {
    Normal = 'Normal',
    Fire = 'Fire',
    Water = 'Water',
    Electric = 'Electric',
    Grass = 'Grass',
    Ice = 'Ice',
    Fighting = 'Fighting',
    Poison = 'Poison',
    Ground = 'Ground',
    Flying = 'Flying',
    Psychic = 'Psychic',
    Bug = 'Bug',
    Rock = 'Rock',
    Ghost = 'Ghost',
    Dragon = 'Dragon',
    Dark = 'Dark',
    Steel = 'Steel',
    Fairy = 'Fairy'
}

// A short phrase describing what kind of scene/action each type represents,
// used as a zero-shot classification label so the narrator's action can be
// matched to a domain without a hardcoded/rigid skill list.
export const TypeDomainDescription: {[type in MoemonType]: string} = {
    [MoemonType.Normal]: 'plain physical effort or mundane, everyday activity',
    [MoemonType.Fire]: 'fire, heat, or burning',
    [MoemonType.Water]: 'water, swimming, or rain',
    [MoemonType.Electric]: 'electricity or lightning',
    [MoemonType.Grass]: 'plants, nature, or foliage',
    [MoemonType.Ice]: 'ice, cold, or freezing',
    [MoemonType.Fighting]: 'brawling, martial arts, or brute force',
    [MoemonType.Poison]: 'poison or toxins',
    [MoemonType.Ground]: 'earth, digging, or rugged terrain',
    [MoemonType.Flying]: 'flight or aerial maneuvering',
    [MoemonType.Psychic]: 'psychic powers or the mind',
    [MoemonType.Bug]: 'insects or creeping, crawling things',
    [MoemonType.Rock]: 'stone, rock, or minerals',
    [MoemonType.Ghost]: 'the supernatural or spirits',
    [MoemonType.Dragon]: 'draconic or primal, ancient force',
    [MoemonType.Dark]: 'trickery, stealth, or malice',
    [MoemonType.Steel]: 'metal or hardened defense',
    [MoemonType.Fairy]: 'charm, magic, or whimsy'
};

// Standard type effectiveness chart. Only exceptions to a neutral (1x)
// matchup are listed; anything absent from both lists here is neutral.
const SUPER_EFFECTIVE: {[attacker in MoemonType]?: MoemonType[]} = {
    [MoemonType.Fire]: [MoemonType.Grass, MoemonType.Ice, MoemonType.Bug, MoemonType.Steel],
    [MoemonType.Water]: [MoemonType.Fire, MoemonType.Ground, MoemonType.Rock],
    [MoemonType.Electric]: [MoemonType.Water, MoemonType.Flying],
    [MoemonType.Grass]: [MoemonType.Water, MoemonType.Ground, MoemonType.Rock],
    [MoemonType.Ice]: [MoemonType.Grass, MoemonType.Ground, MoemonType.Flying, MoemonType.Dragon],
    [MoemonType.Fighting]: [MoemonType.Normal, MoemonType.Ice, MoemonType.Rock, MoemonType.Dark, MoemonType.Steel],
    [MoemonType.Poison]: [MoemonType.Grass, MoemonType.Fairy],
    [MoemonType.Ground]: [MoemonType.Fire, MoemonType.Electric, MoemonType.Poison, MoemonType.Rock, MoemonType.Steel],
    [MoemonType.Flying]: [MoemonType.Grass, MoemonType.Fighting, MoemonType.Bug],
    [MoemonType.Psychic]: [MoemonType.Fighting, MoemonType.Poison],
    [MoemonType.Bug]: [MoemonType.Grass, MoemonType.Psychic, MoemonType.Dark],
    [MoemonType.Rock]: [MoemonType.Fire, MoemonType.Ice, MoemonType.Flying, MoemonType.Bug],
    [MoemonType.Ghost]: [MoemonType.Psychic, MoemonType.Ghost],
    [MoemonType.Dragon]: [MoemonType.Dragon],
    [MoemonType.Dark]: [MoemonType.Psychic, MoemonType.Ghost],
    [MoemonType.Steel]: [MoemonType.Ice, MoemonType.Rock, MoemonType.Fairy],
    [MoemonType.Fairy]: [MoemonType.Fighting, MoemonType.Dragon, MoemonType.Dark]
};

const NOT_VERY_EFFECTIVE: {[attacker in MoemonType]?: MoemonType[]} = {
    [MoemonType.Normal]: [MoemonType.Rock, MoemonType.Steel],
    [MoemonType.Fire]: [MoemonType.Fire, MoemonType.Water, MoemonType.Rock, MoemonType.Dragon],
    [MoemonType.Water]: [MoemonType.Water, MoemonType.Grass, MoemonType.Dragon],
    [MoemonType.Electric]: [MoemonType.Electric, MoemonType.Grass, MoemonType.Dragon],
    [MoemonType.Grass]: [MoemonType.Fire, MoemonType.Grass, MoemonType.Poison, MoemonType.Flying, MoemonType.Bug, MoemonType.Dragon, MoemonType.Steel],
    [MoemonType.Ice]: [MoemonType.Fire, MoemonType.Water, MoemonType.Ice, MoemonType.Steel],
    [MoemonType.Fighting]: [MoemonType.Poison, MoemonType.Flying, MoemonType.Psychic, MoemonType.Bug, MoemonType.Fairy],
    [MoemonType.Poison]: [MoemonType.Poison, MoemonType.Ground, MoemonType.Rock, MoemonType.Ghost],
    [MoemonType.Ground]: [MoemonType.Grass, MoemonType.Bug],
    [MoemonType.Flying]: [MoemonType.Electric, MoemonType.Rock, MoemonType.Steel],
    [MoemonType.Psychic]: [MoemonType.Psychic, MoemonType.Steel],
    [MoemonType.Bug]: [MoemonType.Fire, MoemonType.Fighting, MoemonType.Poison, MoemonType.Flying, MoemonType.Ghost, MoemonType.Steel, MoemonType.Fairy],
    [MoemonType.Rock]: [MoemonType.Fighting, MoemonType.Ground, MoemonType.Steel],
    [MoemonType.Ghost]: [MoemonType.Dark],
    [MoemonType.Dragon]: [MoemonType.Steel],
    [MoemonType.Dark]: [MoemonType.Fighting, MoemonType.Dark, MoemonType.Fairy],
    [MoemonType.Steel]: [MoemonType.Fire, MoemonType.Water, MoemonType.Electric, MoemonType.Steel],
    [MoemonType.Fairy]: [MoemonType.Fire, MoemonType.Poison, MoemonType.Steel]
};

const NO_EFFECT: {[attacker in MoemonType]?: MoemonType[]} = {
    [MoemonType.Normal]: [MoemonType.Ghost],
    [MoemonType.Electric]: [MoemonType.Ground],
    [MoemonType.Fighting]: [MoemonType.Ghost],
    [MoemonType.Poison]: [MoemonType.Steel],
    [MoemonType.Ground]: [MoemonType.Flying],
    [MoemonType.Psychic]: [MoemonType.Dark],
    [MoemonType.Ghost]: [MoemonType.Normal],
    [MoemonType.Dragon]: [MoemonType.Fairy]
};

// A single type's effectiveness multiplier against another.
export function effectiveness(attacker: MoemonType, defender: MoemonType): number {
    if (NO_EFFECT[attacker]?.includes(defender)) return 0;
    if (SUPER_EFFECTIVE[attacker]?.includes(defender)) return 2;
    if (NOT_VERY_EFFECTIVE[attacker]?.includes(defender)) return 0.5;
    return 1;
}

// The best matchup any of a set of attacking types has against a domain;
// defaults to neutral (1) if there are no attacking types at all.
export function bestEffectiveness(attackerTypes: MoemonType[], domain: MoemonType): number {
    if (attackerTypes.length === 0) return 1;
    return Math.max(...attackerTypes.map(type => effectiveness(type, domain)));
}

// Converts an effectiveness multiplier into a modifier on the same scale
// the situational difficulty rating uses.
export function modifierForMultiplier(multiplier: number): number {
    if (multiplier >= 2) return 2;
    if (multiplier === 1) return 0;
    if (multiplier === 0.5) return -1;
    return -2;
}
