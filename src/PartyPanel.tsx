import {ReactElement, useState} from "react";
import type {Stage} from "./Stage";
import {speciesNames, getSpecies} from "./Lore";

// Renders as its own component (rather than inline in Stage.render()) so it
// can hold its own re-render state; the Stage instance isn't itself a React
// component, so button handlers call back into it and then force a refresh.
export function PartyPanel({stage}: {stage: Stage}): ReactElement {
    const [, setTick] = useState(0);
    const refresh = () => setTick(tick => tick + 1);

    const users = Object.values(stage.users).filter(user => !user.isRemoved);

    return (
        <div className="crunchatize-party-panel">
            {users.map(user => {
                const party = stage.getFullParty(user.anonymizedId);
                const partySpecies = new Set(party.map(member => member.species.toLowerCase()));
                return (
                    <div className="crunchatize-party-block" key={user.anonymizedId}>
                        <div className="crunchatize-party-title">{user.name}'s Party</div>
                        {party.length === 0 && <div className="crunchatize-party-empty">No moemon yet.</div>}
                        <ul className="crunchatize-party-list">
                            {party.map(member => {
                                const info = getSpecies(member.species);
                                return (
                                    <li key={member.species} className="crunchatize-party-member">
                                        <span className="crunchatize-party-name">{member.species}</span>
                                        <span className="crunchatize-party-types">{(info?.types ?? []).join('/')}</span>
                                        <button
                                            className="crunchatize-party-remove"
                                            aria-label={`Remove ${member.species}`}
                                            onClick={async () => {
                                                await stage.removePartyMember(user.anonymizedId, member.species);
                                                refresh();
                                            }}
                                        >×</button>
                                    </li>
                                );
                            })}
                        </ul>
                        <select
                            className="crunchatize-party-add"
                            defaultValue=""
                            onChange={async (event) => {
                                const species = event.target.value;
                                event.target.value = '';
                                if (species) {
                                    await stage.addPartyMember(user.anonymizedId, species);
                                    refresh();
                                }
                            }}
                        >
                            <option value="" disabled>Add a moemon...</option>
                            {speciesNames
                                .filter(name => !partySpecies.has(name.toLowerCase()))
                                .map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                    </div>
                );
            })}
        </div>
    );
}
