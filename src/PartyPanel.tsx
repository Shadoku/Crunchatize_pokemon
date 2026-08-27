import {ReactElement, useEffect, useState} from "react";
import type {Stage, ScanOutcome} from "./Stage";
import {speciesNames, getSpecies, speciesImageUrl} from "./Lore";
import {anchorFor, onAnchorsLoaded} from "./Portrait";
import {PartyMember, PartyMemberDetails, DEFAULT_DETAILS, detailsOf, displayNameOf, Condition} from "./Party";
import {itemCategories} from "./Inventory";
import {NpcEntry, describeAffinity, AFFINITY_MIN, AFFINITY_MAX} from "./Npc";
import {SuggestionKind} from "./Scan";
import {Outcome, ResultClass} from "./Outcome";

function clampLevel(value: string): number {
    return Math.min(Math.max(Math.floor(Number(value)) || 1, 1), 100);
}

// Puts text on the clipboard so the player can paste it into Chub's own
// input box. A stage cannot write into that box itself - it runs in a
// sandboxed cross-origin iframe and the messenger exposes no way to set the
// composer's text - so one keystroke away is as close as this gets.
// execCommand is kept as the fallback: the async clipboard API needs a
// permission that an embedded frame is not always granted.
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Blocked or unavailable - fall through to the older route.
    }
    try {
        const carrier = document.createElement('textarea');
        carrier.value = text;
        carrier.setAttribute('readonly', '');
        carrier.style.position = 'fixed';
        carrier.style.opacity = '0';
        document.body.appendChild(carrier);
        carrier.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(carrier);
        return copied;
    } catch {
        return false;
    }
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
            {/* Shared by everyone in the chat, so it sits above the per-player
                blocks rather than being repeated inside each one. */}
            <EnvironmentField stage={stage} refresh={refresh} />
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

// Where and when the scene is happening. Free text, edited by any player,
// and handed to the narrator alongside the roster so a long stretch without
// scene-setting dialogue doesn't let the story drift somewhere else.
function EnvironmentField({stage, refresh}: {stage: Stage; refresh: () => void}): ReactElement {
    const saved = stage.getEnvironment();
    const [draft, setDraft] = useState(saved);
    const [busy, setBusy] = useState(false);

    // Another player (or an import) can change this underneath an untouched
    // field; adopt that rather than leaving a stale draft on screen.
    useEffect(() => setDraft(saved), [saved]);

    const dirty = draft.trim() !== saved;

    async function save() {
        if (busy || !dirty) return;
        setBusy(true);
        try {
            await stage.setEnvironment(draft);
        } finally {
            setBusy(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-scene">
            <div className="crunchatize-scene-title">Scene</div>
            <div className="crunchatize-scene-row">
                <input
                    type="text"
                    placeholder="where and when, e.g. Viridian Forest, dusk, raining"
                    value={draft}
                    disabled={busy}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            save();
                        }
                    }}
                />
                <button type="button" disabled={busy || !dirty} onClick={save}>Set</button>
            </div>
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
    const [addLevel, setAddLevel] = useState(DEFAULT_DETAILS.level);

    const party = stage.getFullParty(anonymizedId);
    const partySpecies = new Set(party.map(member => member.species.toLowerCase()));

    return (
        <div className="crunchatize-party-block">
            <SuggestionsPanel stage={stage} anonymizedId={anonymizedId} refresh={refresh} />
            <div className="crunchatize-party-title">{name}'s Party</div>
            {party.length === 0 && <div className="crunchatize-party-empty">No moemon yet.</div>}
            <ul className="crunchatize-party-list">
                {party.map(member => (
                    <PartyMemberRow
                        key={member.species}
                        member={member}
                        condition={stage.getCondition(anonymizedId, member.species)}
                        onViewPortrait={onViewPortrait}
                        expanded={expandedSpecies === member.species}
                        onToggle={() => setExpandedSpecies(expandedSpecies === member.species ? null : member.species)}
                        onRemove={async () => {
                            await stage.removePartyMember(anonymizedId, member.species);
                            refresh();
                        }}
                        onSetCondition={(condition) => {
                            stage.setCondition(anonymizedId, member.species, condition);
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
            <QuestPanel stage={stage} anonymizedId={anonymizedId} refresh={refresh} />
            <NpcPanel stage={stage} anonymizedId={anonymizedId} refresh={refresh} />
            <RollToggle stage={stage} anonymizedId={anonymizedId} refresh={refresh} />
            <LastRoll outcome={stage.getUserState(anonymizedId).lastOutcome} />
            <SavePanel stage={stage} anonymizedId={anonymizedId} refresh={refresh} />
        </div>
    );
}

// The player's bag. Items can be picked from the preset list or typed in by
// hand; clicking one spends it and copies its name for the chat input.
function InventoryPanel({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const [name, setName] = useState('');
    const [quantity, setQuantity] = useState(1);
    const [busy, setBusy] = useState(false);
    // Which item was last copied, and whether the copy actually worked.
    const [copied, setCopied] = useState<{name: string; ok: boolean} | null>(null);

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

    // Spends one and hands the name over for pasting into the chat input.
    async function use(itemName: string) {
        if (busy) return;
        setBusy(true);
        try {
            const ok = await copyToClipboard(itemName);
            setCopied({name: itemName, ok});
            await stage.spendItem(anonymizedId, itemName);
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
                            title={`Spend one ${item.name} and copy its name`}
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
            {copied && (
                // The clipboard can be refused outright in an embedded frame,
                // so when it is, the name is offered as selectable text
                // rather than silently doing nothing.
                <div className="crunchatize-bag-copied">
                    {copied.ok
                        ? <span>Copied <strong>{copied.name}</strong> - paste it into the chat box.</span>
                        : <>
                            <span>Copy this into the chat box:</span>
                            <input
                                type="text"
                                readOnly
                                value={copied.name}
                                onFocus={(event) => event.target.select()}
                            />
                        </>}
                </div>
            )}
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

// What the story scanner noticed and the player hasn't ruled on. Sits at the
// top of the block because it's the only part asking for a decision; when
// there's nothing pending it shrinks to just the button.
function SuggestionsPanel({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const [busy, setBusy] = useState(false);
    // What the last scan actually did. Without this a scan that found nothing
    // and a scan that never ran look identical - which is how a silent
    // early-return went unnoticed until someone reported a dead button.
    const [status, setStatus] = useState<string | null>(null);

    // A scan is fired and forgotten, so its findings arrive with nothing
    // awaiting them - the panel subscribes and re-renders when they land.
    useEffect(() => stage.onSuggestionsChanged(refresh), []);

    const suggestions = stage.getSuggestions(anonymizedId);
    const scanning = stage.isScanning;

    async function act(action: () => Promise<void>) {
        if (busy) return;
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
            refresh();
        }
    }

    async function scan() {
        if (busy) return;
        setBusy(true);
        setStatus(null);
        try {
            const outcome = await stage.runScan(anonymizedId);
            setStatus(describeScan(outcome));
        } finally {
            setBusy(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-suggestions">
            <div className="crunchatize-suggestions-header">
                <span className="crunchatize-bag-title">
                    {suggestions.length > 0 ? `Noticed (${suggestions.length})` : 'Story'}
                </span>
                <button
                    type="button"
                    className="crunchatize-scan-button"
                    disabled={scanning || busy}
                    title="Look over the recent story for changes to your party, threads, characters and scene"
                    onClick={scan}
                >{scanning ? 'Scanning…' : 'Scan now'}</button>
            </div>
            {status && <div className="crunchatize-scan-status">{status}</div>}
            {suggestions.length > 0 && (
                <ul className="crunchatize-suggestion-list">
                    {suggestions.map(suggestion => (
                        <li key={suggestion.id} className="crunchatize-suggestion">
                            <span className={`crunchatize-suggestion-kind crunchatize-suggestion-kind--${suggestion.kind}`}>
                                {KIND_LABELS[suggestion.kind] ?? suggestion.kind}
                            </span>
                            <span className="crunchatize-suggestion-text">{suggestion.description}</span>
                            <button
                                type="button"
                                className="crunchatize-suggestion-accept"
                                aria-label={`Accept: ${suggestion.description}`}
                                disabled={busy}
                                onClick={() => act(() => stage.acceptSuggestion(anonymizedId, suggestion.id))}
                            >✓</button>
                            <button
                                type="button"
                                className="crunchatize-suggestion-reject"
                                aria-label={`Reject: ${suggestion.description}`}
                                disabled={busy}
                                onClick={() => act(() => stage.rejectSuggestion(anonymizedId, suggestion.id))}
                            >✗</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// What to tell the player a scan did. "Nothing new" is a real, useful answer
// here, and has to be distinguishable from a scan that failed outright.
function describeScan(outcome: ScanOutcome): string {
    if (outcome.reason === 'busy') return 'Already scanning…';
    if (!outcome.ok) return 'Scan failed - try again.';
    if (outcome.found === 0) return 'Nothing new found.';
    return outcome.found === 1 ? 'Found 1 change.' : `Found ${outcome.found} changes.`;
}

// Short chips, so the row reads as "PARTY  Growlithe joins the party".
const KIND_LABELS: {[kind in SuggestionKind]: string} = {
    'party': 'Party',
    'quest': 'Thread',
    'quest-done': 'Done',
    'npc': 'Who',
    'scene': 'Scene',
    'condition': 'State'
};

// Open plot threads. Checked off rather than deleted when they resolve, so
// the player keeps the history; only unchecked ones are sent to the narrator.
function QuestPanel({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);

    const quests = stage.getQuests(anonymizedId);

    async function add() {
        if (!text.trim() || busy) return;
        setBusy(true);
        try {
            await stage.addQuest(anonymizedId, text);
            setText('');
        } finally {
            setBusy(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-threads">
            <div className="crunchatize-bag-title">Threads</div>
            {quests.length === 0 && <div className="crunchatize-party-empty">Nothing open.</div>}
            <ul className="crunchatize-bag-list">
                {quests.map(quest => (
                    <li key={quest.id} className="crunchatize-bag-item">
                        <button
                            type="button"
                            className={`crunchatize-thread-toggle${quest.done ? ' is-done' : ''}`}
                            disabled={busy}
                            title={quest.done ? 'Reopen this thread' : 'Mark this thread resolved'}
                            aria-pressed={quest.done}
                            onClick={async () => {
                                await stage.toggleQuest(anonymizedId, quest.id);
                                refresh();
                            }}
                        >
                            <span className="crunchatize-thread-check" aria-hidden="true">{quest.done ? '✓' : '○'}</span>
                            <span className="crunchatize-thread-text">{quest.text}</span>
                        </button>
                        <button
                            type="button"
                            className="crunchatize-party-remove"
                            aria-label={`Remove thread: ${quest.text}`}
                            disabled={busy}
                            onClick={async () => {
                                await stage.removeQuest(anonymizedId, quest.id);
                                refresh();
                            }}
                        >×</button>
                    </li>
                ))}
            </ul>
            <div className="crunchatize-bag-add">
                <input
                    className="crunchatize-bag-name-input"
                    type="text"
                    placeholder="track a thread..."
                    value={text}
                    disabled={busy}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
                <button
                    type="button"
                    className="crunchatize-bag-add-button"
                    disabled={busy || !text.trim()}
                    onClick={add}
                >Add</button>
            </div>
        </div>
    );
}

// Recurring characters, and how the player stands with them. Affinity moves
// on its own as checks involving a name land well or badly; the arrows are
// here for when the story says otherwise.
function NpcPanel({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);

    const npcs = stage.getNpcs(anonymizedId);

    async function add() {
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
            await stage.addNpc(anonymizedId, name);
            setName('');
        } finally {
            setBusy(false);
            refresh();
        }
    }

    async function nudge(npc: NpcEntry, delta: number) {
        if (busy) return;
        setBusy(true);
        try {
            await stage.updateNpc(anonymizedId, npc.name, {affinity: npc.affinity + delta});
        } finally {
            setBusy(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-npcs">
            <div className="crunchatize-bag-title">Characters</div>
            {npcs.length === 0 && <div className="crunchatize-party-empty">Nobody tracked.</div>}
            <ul className="crunchatize-npc-list">
                {npcs.map(npc => (
                    <li key={npc.name} className="crunchatize-npc">
                        <div className="crunchatize-npc-row">
                            <span className="crunchatize-npc-name">{npc.name}</span>
                            <span
                                className={`crunchatize-npc-affinity crunchatize-npc-affinity--${affinityTone(npc.affinity)}`}
                                title={`${npc.name} is ${describeAffinity(npc.affinity)}`}
                            >{describeAffinity(npc.affinity)}</span>
                            <span className="crunchatize-npc-nudge">
                                <button
                                    type="button"
                                    disabled={busy || npc.affinity >= AFFINITY_MAX}
                                    aria-label={`Warm ${npc.name} toward you`}
                                    onClick={() => nudge(npc, 1)}
                                >▲</button>
                                <button
                                    type="button"
                                    disabled={busy || npc.affinity <= AFFINITY_MIN}
                                    aria-label={`Cool ${npc.name} toward you`}
                                    onClick={() => nudge(npc, -1)}
                                >▼</button>
                            </span>
                            <button
                                type="button"
                                className="crunchatize-party-remove"
                                aria-label={`Remove ${npc.name}`}
                                disabled={busy}
                                onClick={async () => {
                                    await stage.removeNpc(anonymizedId, npc.name);
                                    refresh();
                                }}
                            >×</button>
                        </div>
                        <input
                            className="crunchatize-npc-note"
                            type="text"
                            placeholder="who are they?"
                            defaultValue={npc.note}
                            disabled={busy}
                            // Committed on blur rather than per keystroke:
                            // every save round-trips through the messenger.
                            onBlur={async (event) => {
                                if (event.target.value.trim() === npc.note) return;
                                await stage.updateNpc(anonymizedId, npc.name, {note: event.target.value});
                                refresh();
                            }}
                        />
                    </li>
                ))}
            </ul>
            <div className="crunchatize-bag-add">
                <input
                    className="crunchatize-bag-name-input"
                    type="text"
                    placeholder="track a character..."
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

// Which way an affinity leans, for coloring. The description carries the
// detail; this is just the sign.
function affinityTone(affinity: number): string {
    if (affinity > 0) return 'warm';
    if (affinity < 0) return 'cold';
    return 'neutral';
}

// Carries a roster, bag, threads, characters and scene between chats. The
// stage can't offer a file download from inside its frame, so the bundle is
// moved as text - copied out, pasted back in - the same route the bag
// already uses to get an item name into the chat box.
function SavePanel({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [status, setStatus] = useState<{ok: boolean; message: string} | null>(null);
    const [busy, setBusy] = useState(false);

    async function exportSave() {
        const bundle = stage.exportSave(anonymizedId);
        setDraft(bundle);
        const copied = await copyToClipboard(bundle);
        setStatus({
            ok: true,
            message: copied ? 'Copied - paste it somewhere safe.' : 'Select the text below and copy it.'
        });
    }

    async function importSave() {
        if (busy || !draft.trim()) return;
        setBusy(true);
        try {
            const result = await stage.importSave(anonymizedId, draft);
            setStatus(result.success
                ? {ok: true, message: 'Loaded.'}
                : {ok: false, message: result.error ?? 'Could not read that bundle.'});
        } finally {
            setBusy(false);
            refresh();
        }
    }

    return (
        <div className="crunchatize-save">
            <button
                type="button"
                className="crunchatize-save-disclosure"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >{open ? '▾' : '▸'} Save data</button>
            {open && (
                <div className="crunchatize-save-body">
                    <div className="crunchatize-save-actions">
                        <button type="button" disabled={busy} onClick={exportSave}>Export</button>
                        <button type="button" disabled={busy || !draft.trim()} onClick={importSave}>Import</button>
                    </div>
                    <textarea
                        className="crunchatize-save-text"
                        rows={6}
                        spellCheck={false}
                        placeholder="Export to copy this chat's party, bag, threads and characters - or paste a bundle here and Import to load it."
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setDraft(event.target.value)}
                        onFocus={(event) => event.target.select()}
                    />
                    {status && (
                        <div className={`crunchatize-save-status${status.ok ? '' : ' is-error'}`}>{status.message}</div>
                    )}
                </div>
            )}
        </div>
    );
}

// Whether the player's typed messages go to the dice. A sticky setting, not
// a one-shot: it stays where it's put until changed, and is read by
// beforePrompt when the message actually arrives.
function RollToggle({stage, anonymizedId, refresh}: {
    stage: Stage;
    anonymizedId: string;
    refresh: () => void;
}): ReactElement {
    const rolling = stage.isRollEnabled(anonymizedId);

    async function set(value: boolean) {
        if (value === rolling) return;
        await stage.setRollEnabled(anonymizedId, value);
        refresh();
    }

    return (
        <div className="crunchatize-rolltoggle">
            <div className="crunchatize-rolltoggle-header">
                <span className="crunchatize-rolltoggle-label">Your messages</span>
                <span className="crunchatize-rolltoggle-hint">{rolling ? 'rolls a d20' : 'no roll'}</span>
            </div>
            <div className="crunchatize-rolltoggle-options" role="group" aria-label="Roll for messages">
                <button
                    type="button"
                    className={`crunchatize-rolltoggle-option${rolling ? ' is-active' : ''}`}
                    aria-pressed={rolling}
                    onClick={() => set(true)}
                >Roll</button>
                <button
                    type="button"
                    className={`crunchatize-rolltoggle-option${rolling ? '' : ' is-active'}`}
                    aria-pressed={!rolling}
                    onClick={() => set(false)}
                >No Roll</button>
            </div>
        </div>
    );
}

// The result of the player's last dice check. This is the only place the
// numeric roll is ever shown - it never appears in chat or chat history,
// since the narrator is only ever told the qualitative outcome.
function LastRoll({outcome}: {outcome: Outcome | null}): ReactElement | null {
    if (!outcome) return null;

    return (
        <div className={`crunchatize-lastroll crunchatize-lastroll-${ResultClass[outcome.result]}`}>
            <span className="crunchatize-lastroll-label">Last Roll</span>
            <span className="crunchatize-lastroll-roll">d20: {outcome.roll}</span>
            <span className="crunchatize-lastroll-result">{outcome.getLabel()}</span>
        </div>
    );
}

function PartyMemberRow({member, condition, expanded, onToggle, onRemove, onSetCondition, onSaveDetails, onViewPortrait}: {
    member: PartyMember;
    condition: Condition;
    expanded: boolean;
    onToggle: () => void;
    onRemove: () => void;
    onSetCondition: (condition: Condition) => void;
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
                {condition !== 'ok' && (
                    <span
                        className={`crunchatize-condition crunchatize-condition--${condition}`}
                        title={`${displayNameOf(member)} is ${condition} - click to clear`}
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                            // The row itself toggles the details editor.
                            event.stopPropagation();
                            onSetCondition('ok');
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                onSetCondition('ok');
                            }
                        }}
                    >{condition}</span>
                )}
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
                    <PartyMemberEditor
                        details={details}
                        condition={condition}
                        onSetCondition={onSetCondition}
                        onSave={onSaveDetails}
                        onCancel={onToggle}
                    />
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
                                // Centred horizontally, unlike the square
                                // thumbnail. This box is tall and narrow, so
                                // it's the horizontal axis that overflows -
                                // the anchor would pin the art to the left
                                // and clip the right. The anchor still
                                // applies vertically, for the rare image tall
                                // enough to overflow that way instead.
                                style={{objectPosition: `50% ${anchorFor(member.species) * 100}%`}}
                            />
                        </button>
                    )}
                </div>
            )}
        </li>
    );
}

function PartyMemberEditor({details, condition, onSetCondition, onSave, onCancel}: {
    details: PartyMemberDetails;
    condition: Condition;
    onSetCondition: (condition: Condition) => void;
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
            {/* Applied on pick rather than on Save, unlike the fields around
                it: condition is message state, which the stage writes back on
                the next prompt, while the rest of this form is chat state
                saved through the messenger right away. */}
            <label className="crunchatize-party-editor-field">
                <span className="crunchatize-party-editor-label">Condition</span>
                <select value={condition} onChange={(event) => onSetCondition(event.target.value as Condition)}>
                    <option value="ok">OK</option>
                    <option value="hurt">Hurt</option>
                    <option value="fainted">Fainted</option>
                </select>
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
