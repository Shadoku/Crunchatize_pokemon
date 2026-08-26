import {ReactElement, useState} from "react";
import type {Stage} from "./Stage";
import {speciesNames, getSpecies, speciesImageUrl} from "./Lore";
import {PartyMember, PartyMemberDetails, detailsOf} from "./Party";

// Renders as its own component (rather than inline in Stage.render()) so it
// can hold its own re-render state; the Stage instance isn't itself a React
// component, so button handlers call back into it and then force a refresh.
export function PartyPanel({stage}: {stage: Stage}): ReactElement {
    const [, setTick] = useState(0);
    const refresh = () => setTick(tick => tick + 1);

    const users = Object.values(stage.users).filter(user => !user.isRemoved);

    return (
        <div className="crunchatize-party-panel">
            {users.map(user => (
                <PartyBlock key={user.anonymizedId} stage={stage} anonymizedId={user.anonymizedId} name={user.name} refresh={refresh} />
            ))}
        </div>
    );
}

function PartyBlock({stage, anonymizedId, name, refresh}: {
    stage: Stage;
    anonymizedId: string;
    name: string;
    refresh: () => void;
}): ReactElement {
    const [expandedSpecies, setExpandedSpecies] = useState<string | null>(null);
    const [actionText, setActionText] = useState('');
    const [sending, setSending] = useState(false);

    const party = stage.getFullParty(anonymizedId);
    const partySpecies = new Set(party.map(member => member.species.toLowerCase()));

    // Enter and the "Send Dialogue" button both default to no-roll, per the
    // panel replacing Chub's own input box; "Send Action" is the deliberate
    // second step for anyone who wants a roll.
    async function send(dialogue: boolean) {
        const text = actionText.trim();
        if (!text || sending) return;
        setSending(true);
        setActionText('');
        try {
            if (dialogue) {
                await stage.sendPartyDialogue(anonymizedId, text);
            } else {
                await stage.sendPartyAction(anonymizedId, text);
            }
        } finally {
            setSending(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-party-block">
            <div className="crunchatize-party-title">{name}'s Party</div>
            {party.length === 0 && <div className="crunchatize-party-empty">No moemon yet.</div>}
            <ul className="crunchatize-party-list">
                {party.map(member => (
                    <PartyMemberRow
                        key={member.species}
                        member={member}
                        expanded={expandedSpecies === member.species}
                        onToggle={() => setExpandedSpecies(expandedSpecies === member.species ? null : member.species)}
                        onRemove={async () => {
                            await stage.removePartyMember(anonymizedId, member.species);
                            refresh();
                        }}
                        onSaveDetails={async (details) => {
                            await stage.updatePartyMemberDetails(anonymizedId, member.species, details);
                            setExpandedSpecies(null);
                            refresh();
                        }}
                    />
                ))}
            </ul>
            <select
                className="crunchatize-party-add"
                defaultValue=""
                onChange={async (event) => {
                    const species = event.target.value;
                    event.target.value = '';
                    if (species) {
                        await stage.addPartyMember(anonymizedId, species);
                        refresh();
                    }
                }}
            >
                <option value="" disabled>Add a moemon...</option>
                {speciesNames
                    .filter(name => !partySpecies.has(name.toLowerCase()))
                    .map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <div className="crunchatize-action-bar">
                <input
                    className="crunchatize-action-input"
                    type="text"
                    placeholder="Say or do something..."
                    value={actionText}
                    disabled={sending}
                    onChange={(event) => setActionText(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            send(true);
                        }
                    }}
                />
                <button
                    type="button"
                    className="crunchatize-action-send crunchatize-action-send-dialogue"
                    disabled={sending || !actionText.trim()}
                    onClick={() => send(true)}
                >Send Dialogue</button>
                <button
                    type="button"
                    className="crunchatize-action-send crunchatize-action-send-action"
                    disabled={sending || !actionText.trim()}
                    onClick={() => send(false)}
                >Send Action</button>
            </div>
        </div>
    );
}

function PartyMemberRow({member, expanded, onToggle, onRemove, onSaveDetails}: {
    member: PartyMember;
    expanded: boolean;
    onToggle: () => void;
    onRemove: () => void;
    onSaveDetails: (details: PartyMemberDetails) => void;
}): ReactElement {
    const info = getSpecies(member.species);
    const details = detailsOf(member);
    const [imageOk, setImageOk] = useState(true);

    return (
        <li className="crunchatize-party-member">
            <div className="crunchatize-party-member-row">
                {imageOk && (
                    <img
                        className="crunchatize-party-image"
                        src={speciesImageUrl(member.species)}
                        alt=""
                        onError={() => setImageOk(false)}
                    />
                )}
                <button type="button" className="crunchatize-party-name" onClick={onToggle}>
                    {member.species}
                </button>
                <span className="crunchatize-party-level">Lv.{details.level}</span>
                <span className="crunchatize-party-types">{(info?.types ?? []).join('/')}</span>
                <button
                    className="crunchatize-party-remove"
                    aria-label={`Remove ${member.species}`}
                    onClick={onRemove}
                >×</button>
            </div>
            {expanded && <PartyMemberEditor details={details} onSave={onSaveDetails} onCancel={onToggle} />}
        </li>
    );
}

function PartyMemberEditor({details, onSave, onCancel}: {
    details: PartyMemberDetails;
    onSave: (details: PartyMemberDetails) => void;
    onCancel: () => void;
}): ReactElement {
    const [level, setLevel] = useState(details.level);
    const [moves, setMoves] = useState(details.moves);
    const [heldItem, setHeldItem] = useState(details.heldItem);

    return (
        <div className="crunchatize-party-editor">
            <label className="crunchatize-party-editor-field">
                Level
                <input
                    type="number"
                    min={1}
                    max={100}
                    value={level}
                    onChange={(event) => setLevel(Number(event.target.value) || 1)}
                />
            </label>
            <label className="crunchatize-party-editor-field">
                Held Item
                <input type="text" value={heldItem} onChange={(event) => setHeldItem(event.target.value)} />
            </label>
            {moves.map((move, index) => (
                <label className="crunchatize-party-editor-field" key={index}>
                    Move {index + 1}
                    <input
                        type="text"
                        value={move}
                        onChange={(event) => {
                            const next = [...moves];
                            next[index] = event.target.value;
                            setMoves(next);
                        }}
                    />
                </label>
            ))}
            <div className="crunchatize-party-editor-actions">
                <button type="button" onClick={() => onSave({level, moves, heldItem})}>Save</button>
                <button type="button" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}
