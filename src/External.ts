// An optional second home for the story scan: an OpenAI-shaped chat
// completions endpoint (OpenRouter by default) asked for its findings under a
// JSON schema.
//
// The chat's own model answers the scan for free but under no constraint at
// all - no JSON mode, no schema, no temperature of the stage's choosing - which
// is why the built-in scan asks for one finding per line and parses
// line-by-line (see Scan.ts). A model reached directly can be held to a schema
// instead, so the shape of the reply stops being something to defend against.
// It costs the player an API key and a per-scan charge, so it is off unless
// they turn it on, and every failure falls back to the built-in scan rather
// than leaving the panel with nothing.
//
// The transport lives here; the parsing lives in Scan.ts with the parser it
// mirrors. Nothing in this file imports the stage.

import {RawDetection, KINDS, parseStructuredScan} from "./Scan";

// What the player configured, once it is known to be usable. Held separately
// from the raw config so the one check ("is this on and complete?") happens in
// a single place rather than at every call site.
export interface ExternalScanConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
}

// Where OpenRouter lives. A player pointing at a proxy of their own overrides
// it; anything OpenAI-shaped works, since the request below is the common
// subset rather than anything vendor-specific.
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// Same ceiling as the built-in scan's, in the same spirit: the scan reports,
// it does not narrate. Structured output spends a few more tokens on syntax
// than a line does, hence the larger default.
const DEFAULT_MAX_TOKENS = 512;
const MIN_MAX_TOKENS = 128;
const MAX_MAX_TOKENS = 2048;

// Nothing creative is being asked for - the model is reading a story it has
// been handed and reporting what changed - so the sampler is pinned cold. The
// built-in scan cannot do this; it inherits whatever the player set for the
// chat, which is usually tuned for prose.
const SCAN_TEMPERATURE = 0;

// OpenRouter attributes browser traffic with these. They are optional, and a
// non-OpenRouter endpoint simply ignores them.
const REFERER = 'https://chub.ai';
const TITLE = 'Crunchatize';

// The shape the model must answer in. Generated from Scan.ts's own vocabulary,
// so a verb added there reaches the schema without a second edit here.
//
// Every property is required and additionalProperties is false: strict schema
// mode rejects a schema that leaves either open, and a model with nothing to
// say for `detail` writes an empty string rather than omitting the field.
export function buildScanSchema(): Record<string, unknown> {
    return {
        name: 'story_scan',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            required: ['findings'],
            properties: {
                findings: {
                    type: 'array',
                    description: 'Everything that is new or changed. Empty if nothing is.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['kind', 'value', 'detail'],
                        properties: {
                            kind: {
                                type: 'string',
                                enum: KINDS,
                                description: 'What sort of change this is.'
                            },
                            value: {
                                type: 'string',
                                description: 'Species, thread text, character name, or scene.'
                            },
                            detail: {
                                type: 'string',
                                description: 'Character note, condition, or level. Empty when the kind takes none.'
                            }
                        }
                    }
                }
            }
        }
    };
}

// Reads the player's config, returning null unless the feature is both on and
// complete. A half-filled config is not an error worth shouting about - the
// player is mid-setup - it simply means the built-in scan handles this one.
export function readExternalConfig(config: any): ExternalScanConfig|null {
    if (!config?.externalScanEnabled) return null;

    const apiKey = typeof config.externalScanApiKey === 'string' ? config.externalScanApiKey.trim() : '';
    const model = typeof config.externalScanModel === 'string' ? config.externalScanModel.trim() : '';
    if (!apiKey || !model) return null;

    const rawBase = typeof config.externalScanBaseUrl === 'string' ? config.externalScanBaseUrl.trim() : '';
    // A trailing slash here and the joined path becomes "//chat/completions",
    // which some gateways route to a 404 rather than normalising.
    const baseUrl = (rawBase || DEFAULT_BASE_URL).replace(/\/+$/, '');

    const maxTokens = Number(config.externalScanMaxTokens);
    return {
        baseUrl,
        apiKey,
        model,
        maxTokens: Number.isFinite(maxTokens)
            ? Math.min(Math.max(Math.round(maxTokens), MIN_MAX_TOKENS), MAX_MAX_TOKENS)
            : DEFAULT_MAX_TOKENS
    };
}

// Whether the endpoint is one this stage is willing to send a key to. The
// stage runs in the player's browser, so a base URL is a place their key
// actually goes: http:// would put it on the wire in clear, and a URL that
// doesn't parse is a typo rather than a host.
export function isUsableEndpoint(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).protocol === 'https:';
    } catch {
        return false;
    }
}

// Asks the configured model for its findings. Throws on anything that isn't a
// usable answer - a dead endpoint, a refused key, a model that cannot honour
// the schema - because the caller's response to all of those is the same: run
// the built-in scan instead.
export async function scanExternally(
    config: ExternalScanConfig,
    instructions: string,
    transcript: string,
    signal?: AbortSignal
): Promise<RawDetection[]> {
    if (!isUsableEndpoint(config.baseUrl)) {
        throw new Error(`Crunchatize: external scan endpoint must be an https URL (got "${config.baseUrl}")`);
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
            'HTTP-Referer': REFERER,
            'X-Title': TITLE
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens,
            temperature: SCAN_TEMPERATURE,
            response_format: {type: 'json_schema', json_schema: buildScanSchema()},
            messages: [
                {role: 'system', content: instructions},
                // The story arrives as one user turn rather than as replayed
                // roles: it is material to read, not a conversation to
                // continue, and a model handed alternating roles tends to
                // answer the last one instead of reviewing all of them.
                {role: 'user', content: transcript}
            ]
        })
    });

    if (!response.ok) {
        // The body carries why - an unsupported schema, an exhausted balance,
        // a bad model id - and it is the only thing that makes a failed scan
        // diagnosable from the console, so a bounded slice of it travels with
        // the error.
        const body = await response.text().catch(() => '');
        throw new Error(`Crunchatize: external scan returned ${response.status} ${response.statusText} ${body.slice(0, 300)}`.trim());
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Crunchatize: external scan returned no content');
    }

    // Even under a schema this is parsed defensively: strict mode is honoured
    // by the provider, not guaranteed by it, and a reply that stopped at
    // max_tokens is truncated JSON no matter what was asked for.
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error('Crunchatize: external scan returned malformed JSON');
    }

    return parseStructuredScan(parsed);
}
