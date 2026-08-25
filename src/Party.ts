import {MoemonType} from "./MoemonType";
import {getSpecies} from "./Lore";

export type PartySource = 'auto' | 'manual';

export interface PartyMember {
    species: string;
    source: PartySource;
}

export function typesOf(member: PartyMember): MoemonType[] {
    return getSpecies(member.species)?.types ?? [];
}
