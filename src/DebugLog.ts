// A record of what the scan actually did, for the panel's debug drawer.
//
// The scan runs in the background and reports to the player in one line -
// "Found 2 changes", "Scan failed - try again" - which is the right amount of
// detail for playing and far too little for working out *why* an external
// model isn't answering. The console has the rest, but a stage runs inside a
// sandboxed cross-origin iframe: on mobile, and for most players on desktop,
// there is no reachable console at all. So the same detail is kept here and
// shown in the panel.
//
// This holds no secrets. The API key never reaches an entry - see redact -
// because the drawer has a copy button, and a log that gets pasted into a
// bug report should not be a way to leak the player's key.

export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEntry {
    id: number;
    // Wall clock, so entries can be read against when a message was sent.
    time: string;
    level: DebugLevel;
    // One line, always present: what happened.
    label: string;
    // The body, when there is one: a raw reply, an error, a prompt. Shown in
    // a monospace block the player can expand.
    detail?: string;
}

// Enough to cover several scans with their prompts and replies. Older entries
// fall off the front: this is a running tail, not an archive.
const MAX_ENTRIES = 60;

// A single detail is capped well below the size of a chat, but generously
// enough to hold a whole scan reply or an error body intact - a truncated
// error is often the half that mattered.
const MAX_DETAIL_CHARS = 4000;

export class DebugLog {
    entries: DebugEntry[] = [];
    private nextId = 1;
    private listeners: Set<() => void> = new Set();
    // Strings that must never appear in an entry, longest first so a key that
    // contains another is replaced whole rather than in pieces.
    private secrets: string[] = [];

    // Registers a value to scrub from every entry, now and later. Called with
    // the API key when the config is read.
    keepSecret(value: string): void {
        const secret = (value ?? '').trim();
        // Two characters of "secret" would blank half the log; a real key is
        // far longer than this.
        if (secret.length < 8 || this.secrets.includes(secret)) return;
        this.secrets.push(secret);
        this.secrets.sort((a, b) => b.length - a.length);
    }

    redact(text: string): string {
        return this.secrets.reduce(
            (scrubbed, secret) => scrubbed.split(secret).join('***'),
            text);
    }

    add(level: DebugLevel, label: string, detail?: string): void {
        const clipped = detail == null ? undefined : (() => {
            const text = this.redact(String(detail));
            return text.length > MAX_DETAIL_CHARS
                ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… (${text.length - MAX_DETAIL_CHARS} more characters)`
                : text;
        })();

        this.entries = [...this.entries, {
            id: this.nextId++,
            time: new Date().toLocaleTimeString(),
            level,
            label: this.redact(label),
            detail: clipped
        }].slice(-MAX_ENTRIES);

        this.notify();
    }

    info(label: string, detail?: string): void { this.add('info', label, detail); }
    warn(label: string, detail?: string): void { this.add('warn', label, detail); }
    error(label: string, detail?: string): void { this.add('error', label, detail); }

    clear(): void {
        this.entries = [];
        this.notify();
    }

    // The whole log as text, for the drawer's copy button.
    asText(): string {
        if (this.entries.length === 0) return 'Crunchatize debug log: empty.';
        return this.entries
            .map(entry => `[${entry.time}] ${entry.level.toUpperCase()}: ${entry.label}${entry.detail ? `\n${entry.detail}` : ''}`)
            .join('\n\n');
    }

    // Same subscribe/unsubscribe shape the scan listeners use, for the same
    // reason: entries arrive from a background task, after the render that
    // would have wanted them.
    onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        this.listeners.forEach(listener => listener());
    }
}

// Describes a value as the debug drawer should show it: what it is, not just
// what it stringifies to. `String(value)` is what turns an object into
// "[object Object]" and loses the thing worth knowing, which is precisely the
// case this was written to diagnose.
export function describeValue(value: unknown): string {
    if (value === undefined) return '(not set)';
    if (value === null) return 'null';
    if (typeof value === 'string') return value === '' ? '(empty string)' : `"${value}"`;
    if (typeof value === 'object') return `${Array.isArray(value) ? 'array' : 'object'} ${JSON.stringify(value)}`;
    return `${typeof value} ${String(value)}`;
}
