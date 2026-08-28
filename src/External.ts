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
import {DebugLog, describeValue} from "./DebugLog";

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
//
// Written without the scheme because Chub's config UI rendered a default of
// "https://openrouter.ai/api/v1" as "[object Object]" in the settings form -
// the only field in the schema that did, and the only one whose default
// contained "://". normalizeEndpoint puts the https:// back, and a player who
// types the full URL themselves is unaffected.
const DEFAULT_ENDPOINT = 'openrouter.ai/api/v1';

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
export function readExternalConfig(config: any, log?: DebugLog): ExternalScanConfig|null {
    // The key is registered before anything is written, so no later entry can
    // carry it even by accident.
    if (typeof config?.externalScanApiKey === 'string') log?.keepSecret(config.externalScanApiKey);

    // Every field as it actually arrived, types and all. This is the entry
    // that says whether a setting the form showed reached the stage at all,
    // and in what shape - the settings form has been seen to hand back an
    // object where a string was configured.
    log?.info('Config read', [
        `externalScanEnabled: ${describeValue(config?.externalScanEnabled)}`,
        `externalScanModel: ${describeValue(config?.externalScanModel)}`,
        `externalScanEndpoint: ${describeValue(config?.externalScanEndpoint)}`,
        `externalScanMaxTokens: ${describeValue(config?.externalScanMaxTokens)}`,
        // Never the key itself: only whether there is one and how long it is,
        // which is enough to tell "empty" from "pasted with a stray space".
        `externalScanApiKey: ${typeof config?.externalScanApiKey === 'string' && config.externalScanApiKey.trim()
            ? `set, ${config.externalScanApiKey.trim().length} characters`
            : 'not set'}`
    ].join('\n'));

    // A string enum ('off'/'on') rather than type: boolean - Chub's config UI
    // does not reliably render a bare top-level boolean as a toggle, while a
    // string enum is the same shape playMode already uses successfully in
    // this schema.
    if (config?.externalScanEnabled !== 'on') {
        log?.info('External scan is off - the chat\'s own model will answer scans.');
        return null;
    }

    const apiKey = typeof config.externalScanApiKey === 'string' ? config.externalScanApiKey.trim() : '';
    const model = typeof config.externalScanModel === 'string' ? config.externalScanModel.trim() : '';
    if (!apiKey || !model) {
        log?.warn(`External scan is on but ${!apiKey ? 'no API key' : 'no model'} is set - falling back to the chat's own model.`);
        return null;
    }

    const baseUrl = normalizeEndpoint(config.externalScanEndpoint);

    const maxTokens = Number(config.externalScanMaxTokens);
    const resolved = {
        baseUrl,
        apiKey,
        model,
        maxTokens: Number.isFinite(maxTokens)
            ? Math.min(Math.max(Math.round(maxTokens), MIN_MAX_TOKENS), MAX_MAX_TOKENS)
            : DEFAULT_MAX_TOKENS
    };
    log?.info('External scan is on', [
        `endpoint: ${resolved.baseUrl}/chat/completions`,
        `model: ${resolved.model}`,
        `max tokens: ${resolved.maxTokens}`
    ].join('\n'));
    return resolved;
}

// Turns whatever the config carries into a URL worth trying.
//
// Anything that is not a usable string - absent, blank, or the object Chub's
// form has been seen to hand back - falls through to OpenRouter rather than
// being stringified into a nonsense host. A value with no scheme gets https,
// since that is the only scheme this will send a key over anyway.
export function normalizeEndpoint(value: unknown): string {
    const raw = (typeof value === 'string' ? value : '').trim();
    const chosen = raw || DEFAULT_ENDPOINT;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(chosen) ? chosen : `https://${chosen}`;
    // A trailing slash here and the joined path becomes "//chat/completions",
    // which some gateways route to a 404 rather than normalising.
    return withScheme.replace(/\/+$/, '');
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
    signal?: AbortSignal,
    log?: DebugLog
): Promise<RawDetection[]> {
    if (!isUsableEndpoint(config.baseUrl)) {
        throw new Error(`Crunchatize: external scan endpoint must be an https URL (got "${config.baseUrl}")`);
    }

    const url = `${config.baseUrl}/chat/completions`;
    log?.info(`Sending scan to ${config.model}`, [
        `POST ${url}`,
        `${transcript.length} characters of story`,
        '',
        'Instructions sent:',
        instructions,
        '',
        'Story sent:',
        transcript
    ].join('\n'));

    const response = await fetch(url, {
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
        // diagnosable, so it goes to the log whole and a bounded slice of it
        // travels with the error.
        const body = await response.text().catch(() => '');
        log?.error(`Endpoint returned ${response.status} ${response.statusText}`, body || '(empty body)');
        throw new Error(`Crunchatize: external scan returned ${response.status} ${response.statusText} ${body.slice(0, 300)}`.trim());
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        // The whole payload, since whatever went wrong is in the half that
        // isn't the content: a refusal, a provider error object, an empty
        // choices array.
        log?.error('Endpoint answered with no content', JSON.stringify(payload, null, 2));
        throw new Error('Crunchatize: external scan returned no content');
    }

    // What the model actually said, verbatim. This is the entry worth reading
    // when the scan "worked" but found nothing.
    log?.info(`${config.model} replied`, content);

    // Even under a schema this is parsed defensively: strict mode is honoured
    // by the provider, not guaranteed by it, and a reply that stopped at
    // max_tokens is truncated JSON no matter what was asked for.
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        log?.error('Reply was not valid JSON - the model may not support structured outputs.');
        throw new Error('Crunchatize: external scan returned malformed JSON');
    }

    const detections = parseStructuredScan(parsed);
    log?.info(`Parsed ${detections.length} finding${detections.length === 1 ? '' : 's'} from the reply`,
        detections.map(one => `${one.kind} | ${one.value}${one.detail ? ` | ${one.detail}` : ''}`).join('\n') || undefined);
    return detections;
}
