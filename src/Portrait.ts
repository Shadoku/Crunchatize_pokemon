import {slugifySpecies} from "./Lore";

// Where the crop sits along whichever axis overflows the square thumbnail.
// 0 puts it at the top of a portrait image (or the left of a landscape one),
// which is nearly always where a character's face is; 1 pushes it fully to
// the bottom/right, 0.5 centres it.
export const DEFAULT_ANCHOR = 0;

const ANCHORS_URL = '/moemon/anchors.json';

let anchors: {[slug: string]: number} = {};
let fallbackAnchor = DEFAULT_ANCHOR;
const listeners = new Set<() => void>();

function clampAnchor(value: any): number | undefined {
    const anchor = Number(value);
    if (!isFinite(anchor)) return undefined;
    return Math.min(Math.max(anchor, 0), 1);
}

// Loaded from public/moemon/ at runtime rather than bundled, so the overrides
// sit in the same folder as the artwork they describe. The file is optional:
// a missing or malformed one just leaves every portrait on the default.
async function loadAnchors(): Promise<void> {
    try {
        const response = await fetch(ANCHORS_URL, {credentials: 'omit'});
        if (!response.ok) return;
        const data = await response.json();
        if (!data || typeof data !== 'object') return;

        const loaded: {[slug: string]: number} = {};
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('_')) continue;
            const anchor = clampAnchor(value);
            if (anchor === undefined) continue;
            // Keys go through the same slug rule as the image filenames, so
            // "Mr. Mime", "mr. mime" and "mrmime" all land on the same entry.
            if (key.toLowerCase() === 'default') fallbackAnchor = anchor;
            else loaded[slugifySpecies(key)] = anchor;
        }
        anchors = loaded;
    } catch {
        // No anchors file, or it isn't readable - defaults are fine.
    } finally {
        listeners.forEach(listener => listener());
    }
}

const ready: Promise<void> = loadAnchors();

export function anchorFor(species: string): number {
    return anchors[slugifySpecies(species)] ?? fallbackAnchor;
}

// Portraits render before the anchors file arrives, so the panel subscribes
// and re-renders once it does.
export function onAnchorsLoaded(listener: () => void): () => void {
    listeners.add(listener);
    ready.then(() => { /* already notified via loadAnchors */ });
    return () => listeners.delete(listener);
}
