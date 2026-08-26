import {ReactElement, useEffect, useState} from "react";
import type {Stage} from "./Stage";
import {speciesNames, getSpecies, speciesImageUrl} from "./Lore";
import {anchorFor, onAnchorsLoaded} from "./Portrait";
import {PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, displayNameOf} from "./Party";
import {itemCategories} from "./Inventory";

function clampLevel(value: string): number {
    return Math.min(Math.max(Math.floor(Number(value)) || 1, 1), 100);
}

// Renders as its own component (rather than inline in Stage.render()) so it
// can hold its own re-render state; the Stage instance isn't itself a React
// component, so button handlers call back into it and then force a refresh.
export function PartyPanel({stage}: {stage: Stage}): ReactElement {
    const [, setTick] = useState(0);
    const refresh = () => setTick(tick => tick + 1);
    // Which portrait is open full-size, if any. Held here rather than per row
    // so the viewer can cover the whole panel.
    const [viewing, setViewing] = useState<string | null>(null);

    // The anchors file arrives after first paint; re-render when it lands so
    // portraits settle into their configured crop.
    useEffect(() => onAnchorsLoaded(refresh), []);

    const users = Object.values(stage.users).filter(user => !user.isRemoved);

    return (
        <div className="crunchatize-party-panel">
            {users.map(user => (
                <PartyBlock
                    key={user.anonymizedId}
                    stage={stage}
                    anonymizedId={user.anonymizedId}
                    name={user.name}
                    refresh={refresh}
                    onViewPortrait={setViewing}
                />
            ))}
            {viewing && <PortraitViewer species={viewing} onClose={() => setViewing(null)} />}
        </div>
    );
}

// Full, uncropped portrait over the panel. Dismissed by clicking anywhere or
// pressing Escape.
function PortraitViewer({species, onClose}: {species: string; onClose: () => void}): ReactElement {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="crunchatize-portrait-viewer" role="dialog" aria-label={`${species} portrait`} onClick={onClose}>
            <img className="crunchatize-portrait-full" src={speciesImageUrl(species)} alt={species} />
            <div className="crunchatize-portrait-caption">{species}</div>
            <button type="button" className="crunchatize-portrait-close" aria-label="Close portrait" onClick={onClose}>×</button>
        </div>
    );
}

function PartyBlock({stage, anonymizedId, name, refresh, onViewPortrait}: {
    stage: Stage;
    anonymizedId: string;
    name: string;
    refresh: () => void;
    onViewPortrait: (species: string) => void;
}): ReactElement {
    const [expandedSpecies, setExpandedSpecies] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [addLevel, setAddLevel] = useState(DEFAULT_DETAILS.level);

    const party = stage.getFullParty(anonymizedId);
    const partySpecies = new Set(party.map(member => member.species.toLowerCase()));

    async function send(text: string) {
        if (!text || sending) return;
        setSending(true);
        try {
            await stage.sendPartyDialogue(anonymizedId, text);
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
                        onViewPortrait={onViewPortrait}
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
            <div className="crunchatize-add-row">
                <select
                    className="crunchatize-party-add"
                    defaultValue=""
                    onChange={async (event) => {
                        const species = event.target.value;
                        event.target.value = '';
                        if (species) {
                            await stage.addPartyMember(anonymizedId, species, addLevel);
                            refresh();
                        }
                    }}
                >
                    <option value="" disabled>Add a moemon...</option>
                    {speciesNames
                        .filter(name => !partySpecies.has(name.toLowerCase()))
                        .map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                <label className="crunchatize-add-level" title="Level for newly added moemon; sets their starting moves">
                    Lv.
                    <input
                        type="number"
                        min={1}
                        max={100}
                        value={addLevel}
                        onChange={(event) => setAddLevel(clampLevel(event.target.value))}
                    />
                </label>
            </div>
            <InventoryPanel stage={stage} anonymizedId={anonymizedId} refresh={refresh} />
            <ComposeBox disabled={sending} onSend={send} />
        </div>
    );
}

// The player's bag. Items can be picked from the preset list or typed in by
// hand; clicking one spends it and announces its use in the chat.
function InventoryPanel({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const [name, setName] = useState('');
    const [quantity, setQuantity] = useState(1);
    const [busy, setBusy] = useState(false);

    const inventory = stage.getInventory(anonymizedId);

    async function add() {
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
            await stage.addInventoryItem(anonymizedId, name, quantity);
            setName('');
            setQuantity(1);
        } finally {
            setBusy(false);
            refresh();
        }
    }

    async function use(itemName: string) {
        if (busy) return;
        setBusy(true);
        try {
            await stage.useInventoryItem(anonymizedId, itemName);
        } finally {
            setBusy(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-bag">
            <div className="crunchatize-bag-title">Bag</div>
            {inventory.length === 0 && <div className="crunchatize-party-empty">Empty.</div>}
            <ul className="crunchatize-bag-list">
                {inventory.map(item => (
                    <li key={item.name} className="crunchatize-bag-item">
                        <button
                            type="button"
                            className="crunchatize-bag-use"
                            disabled={busy}
                            title={`Use one ${item.name}`}
                            onClick={() => use(item.name)}
                        >
                            <span className="crunchatize-bag-name">{item.name}</span>
                            <span className="crunchatize-bag-quantity">×{item.quantity}</span>
                        </button>
                        <button
                            type="button"
                            className="crunchatize-party-remove"
                            aria-label={`Remove ${item.name}`}
                            disabled={busy}
                            onClick={async () => {
                                await stage.removeInventoryItem(anonymizedId, item.name);
                                refresh();
                            }}
                        >×</button>
                    </li>
                ))}
            </ul>
            <select
                className="crunchatize-party-add"
                value=""
                // Picking a preset fills the name field rather than adding
                // outright, so quantity can be set before committing - and so
                // a preset can be tweaked into a custom name.
                onChange={(event) => setName(event.target.value)}
            >
                <option value="" disabled>Choose an item...</option>
                {itemCategories.map(category => (
                    <optgroup key={category.name} label={category.name}>
                        {category.items.map(item => <option key={item} value={item}>{item}</option>)}
                    </optgroup>
                ))}
            </select>
            <div className="crunchatize-bag-add">
                <input
                    className="crunchatize-bag-name-input"
                    type="text"
                    placeholder="or type an item name..."
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
                <input
                    className="crunchatize-bag-quantity-input"
                    type="number"
                    min={1}
                    max={999}
                    aria-label="Quantity"
                    value={quantity}
                    disabled={busy}
                    onChange={(event) => setQuantity(Math.min(Math.max(Math.floor(Number(event.target.value)) || 1, 1), 999))}
                />
                <button
                    type="button"
                    className="crunchatize-bag-add-button"
                    disabled={busy || !name.trim()}
                    onClick={add}
                >Add</button>
            </div>
        </div>
    );
}

// The freeform box: anything that shouldn't be put to the dice - dialogue,
// narration, scene-setting, OOC asides. Ordinary actions go through Chub's
// own input box below the chat, which rolls as normal.
function ComposeBox({disabled, onSend}: {
    disabled: boolean;
    onSend: (text: string) => void | Promise<void>;
}): ReactElement {
    const [text, setText] = useState('');
    const trimmed = text.trim();

    async function submit() {
        if (!trimmed || disabled) return;
        setText('');
        await onSend(trimmed);
    }

    return (
        <div className="crunchatize-compose">
            <div className="crunchatize-compose-header">
                <span className="crunchatize-compose-label">Freeform</span>
                <span className="crunchatize-compose-hint">no roll</span>
            </div>
            <textarea
                className="crunchatize-compose-input"
                rows={2}
                placeholder="Dialogue, narration, anything not put to the dice..."
                value={text}
                disabled={disabled}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    // Enter sends; Shift+Enter keeps a newline for longer prose.
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submit();
                    }
                }}
            />
            <button
                type="button"
                className="crunchatize-compose-send"
                disabled={disabled || !trimmed}
                onClick={submit}
            >Send</button>
        </div>
    );
}

function PartyMemberRow({member, expanded, onToggle, onRemove, onSaveDetails, onViewPortrait}: {
    member: PartyMember;
    expanded: boolean;
    onToggle: () => void;
    onRemove: () => void;
    onSaveDetails: (details: PartyMemberDetails) => void;
    onViewPortrait: (species: string) => void;
}): ReactElement {
    const info = getSpecies(member.species);
    const details = detailsOf(member);
    const [imageOk, setImageOk] = useState(true);

    return (
        <li className="crunchatize-party-member">
            <div
                className="crunchatize-party-member-row"
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={onToggle}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onToggle();
                    }
                }}
            >
                {imageOk ? (
                    <img
                        className="crunchatize-party-image crunchatize-party-image--clickable"
                        src={speciesImageUrl(member.species)}
                        alt=""
                        title={`View ${member.species}'s portrait`}
                        // Only the overflowing axis honours object-position
                        // under object-fit: cover, so this one value anchors
                        // the crop to the top of a portrait image and to the
                        // left of a landscape one.
                        style={{objectPosition: `${anchorFor(member.species) * 100}% ${anchorFor(member.species) * 100}%`}}
                        onError={() => setImageOk(false)}
                        onClick={(event) => {
                            // The row itself toggles the details editor.
                            event.stopPropagation();
                            onViewPortrait(member.species);
                        }}
                    />
                ) : (
                    // Keeps the row height stable (and shows where artwork
                    // would go) until a PNG is dropped into public/moemon.
                    <span className="crunchatize-party-image crunchatize-party-image--empty" aria-hidden="true">
                        {member.species.charAt(0)}
                    </span>
                )}
                <span className="crunchatize-party-names">
                    <span className="crunchatize-party-name">{displayNameOf(member)}</span>
                    {details.nickname && <span className="crunchatize-party-species">{member.species}</span>}
                </span>
                <span className="crunchatize-party-level">Lv.{details.level}</span>
                <span className="crunchatize-party-types">
                    {(info?.types ?? []).map(type => (
                        <span key={type} className={`crunchatize-type crunchatize-type--${type.toLowerCase()}`}>{type}</span>
                    ))}
                </span>
                <button
                    className="crunchatize-party-remove"
                    aria-label={`Remove ${member.species}`}
                    onClick={(event) => {
                        // Otherwise removing a member would also toggle the
                        // row it lives in.
                        event.stopPropagation();
                        onRemove();
                    }}
                >×</button>
            </div>
            {expanded && (
                // Mounted fresh on expand, so the CSS entry animations below
                // run each time the row is opened.
                <div className="crunchatize-party-details">
                    <PartyMemberEditor details={details} onSave={onSaveDetails} onCancel={onToggle} />
                    {imageOk && (
                        <button
                            type="button"
                            className="crunchatize-party-portrait"
                            title={`View ${displayNameOf(member)}'s portrait`}
                            onClick={(event) => {
                                event.stopPropagation();
                                onViewPortrait(member.species);
                            }}
                        >
                            <img
                                src={speciesImageUrl(member.species)}
                                alt=""
                                style={{objectPosition: `${anchorFor(member.species) * 100}% ${anchorFor(member.species) * 100}%`}}
                            />
                        </button>
                    )}
                </div>
            )}
        </li>
    );
}

function PartyMemberEditor({details, onSave, onCancel}: {
    details: PartyMemberDetails;
    onSave: (details: PartyMemberDetails) => void;
    onCancel: () => void;
}): ReactElement {
    const [nickname, setNickname] = useState(details.nickname);
    const [level, setLevel] = useState(details.level);
    const [moves, setMoves] = useState(details.moves);
    const [heldItem, setHeldItem] = useState(details.heldItem);

    return (
        <div className="crunchatize-party-editor">
            <label className="crunchatize-party-editor-field">
                <span className="crunchatize-party-editor-label">Nickname</span>
                <input
                    type="text"
                    placeholder="none"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                />
            </label>
            <label className="crunchatize-party-editor-field">
                <span className="crunchatize-party-editor-label">Level</span>
                <input
                    type="number"
                    min={1}
                    max={100}
                    value={level}
                    onChange={(event) => setLevel(Number(event.target.value) || 1)}
                />
            </label>
            <label className="crunchatize-party-editor-field">
                <span className="crunchatize-party-editor-label">Held Item</span>
                <input type="text" value={heldItem} onChange={(event) => setHeldItem(event.target.value)} />
            </label>
            {moves.map((move, index) => (
                <label className="crunchatize-party-editor-field" key={index}>
                    <span className="crunchatize-party-editor-label">Move {index + 1}</span>
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
                <button type="button" onClick={() => onSave({nickname: nickname.trim(), level, moves, heldItem})}>Save</button>
                <button type="button" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}
