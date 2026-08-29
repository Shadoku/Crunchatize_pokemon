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
// Well above what the findings themselves need. A reasoning model spends this
// budget on thinking *before* it writes a single character of the answer, so a
// ceiling sized for the answer alone leaves it truncated mid-thought with an
// empty reply - which is exactly how a DeepSeek scan fails.
const MAX_MAX_TOKENS = 8000;

// Nothing creative is being asked for - the model is reading a story it has
// been handed and reporting what changed - so the sampler is pinned cold. The
// built-in scan cannot do this; it inherits whatever the player set for the
// chat, which is usually tuned for prose.
const SCAN_TEMPERATURE = 0;

// OpenRouter attributes browser traffic with these. They are optional, and a
// non-OpenRouter endpoint simply ignores them.
const REFERER = 'https://chub.ai';
const TITLE = 'Crunchatize';

// OpenRouter's switch for reasoning models. `enabled: false` asks the model
// not to think at all where that is possible, and `exclude: true` keeps the
// thinking out of the reply where it isn't - nothing here wants to read it.
//
// It is only a request. Some models (R1 and its kin) always reason and cannot
// be talked out of it, and their thinking still counts against max_tokens
// either way, which is why the ceiling above is what it is. It is also
// OpenRouter's own parameter: an endpoint that validates its inputs strictly
// will reject it outright, so postScan retries without it.
const REASONING_OFF = {enabled: false, exclude: true};

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

// What came back, once the useful parts are picked out of the envelope. Kept
// separate from the parsing so the awkward cases - a reply that is all
// thinking and no answer, a reply cut off at the token limit - can be named
// precisely instead of all arriving as "no content".
export interface ScanReply {
    content: string;
    // Thinking, when the provider hands it back in its own field. Never
    // parsed; only its presence and size are worth knowing, since a scan that
    // produced nothing but this is a scan that ran out of budget.
    reasoning: string;
    // 'length' means the reply was cut off - for a reasoning model, usually
    // mid-thought and before the answer.
    finishReason: string;
}

export function readReply(payload: unknown): ScanReply {
    const choice = (payload as {choices?: unknown[]} | null)?.choices?.[0] as {
        message?: {content?: unknown; reasoning?: unknown; reasoning_content?: unknown};
        finish_reason?: unknown;
    } | undefined;
    const message = choice?.message;
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    return {
        content: text(message?.content),
        // OpenRouter puts it in `reasoning`; DeepSeek's own API calls the same
        // field `reasoning_content`. Either may turn up depending on which one
        // the player pointed the stage at.
        reasoning: text(message?.reasoning) || text(message?.reasoning_content),
        finishReason: text(choice?.finish_reason)
    };
}

// Finds the findings object in whatever the model wrapped it in.
//
// Under a JSON schema the content should be bare JSON and usually is. But a
// reasoning model reached through a provider that does not split its thinking
// into its own field writes that thinking into the content instead - as a
// <think> block, or simply as prose before the answer - and models of every
// sort still reach for a ``` fence out of habit. Rather than trusting the
// schema was honoured, this takes the outermost {...} span from what is left
// after the thinking is removed. Returns null when there is no object at all.
export function extractScanJson(raw: string): string|null {
    // Thinking first, since a <think> block can itself contain braces - a
    // model reasoning *about* the JSON it is going to write is the common
    // case, and taking the first brace would grab an example out of its
    // notes rather than its answer.
    const withoutThinking = raw
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ' ')
        // An unclosed tag means the reply was cut off inside the thinking;
        // everything after it is notes, not an answer.
        .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, ' ');

    // Fences go before the brace hunt so ```json ... ``` doesn't leave the
    // closing fence inside the span.
    const unfenced = withoutThinking.replace(/```[a-z]*\n?/gi, ' ');

    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return unfenced.slice(start, end + 1);
}

// Posts one scan request. Sends OpenRouter's reasoning switch on the first
// attempt and, if the endpoint rejects the request outright for it, sends the
// same request again without it: the parameter is OpenRouter's own, and a
// strict OpenAI-shaped endpoint answers an unknown field with a 400 rather
// than ignoring it. Anything else - a bad key, no credit, an unsupported
// schema - is returned as it came, since retrying would not change it.
async function postScan(
    config: ExternalScanConfig,
    messages: {role: string; content: string}[],
    signal?: AbortSignal,
    log?: DebugLog
): Promise<Response> {
    const url = `${config.baseUrl}/chat/completions`;
    const send = (extras: Record<string, unknown>) => fetch(url, {
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
            messages,
            ...extras
        })
    });

    const response = await send({reasoning: REASONING_OFF});
    if (response.status !== 400 && response.status !== 422) return response;

    log?.warn(`Endpoint rejected the request with ${response.status}; retrying without the reasoning setting.`);
    return send({});
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
        `reply budget: ${config.maxTokens} tokens`,
        '',
        'Instructions sent:',
        instructions,
        '',
        'Story sent:',
        transcript
    ].join('\n'));

    const response = await postScan(config, [
        {role: 'system', content: instructions},
        // The story arrives as one user turn rather than as replayed roles:
        // it is material to read, not a conversation to continue, and a model
        // handed alternating roles tends to answer the last one instead of
        // reviewing all of them.
        {role: 'user', content: transcript}
    ], signal, log);

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
    const reply = readReply(payload);

    // What the model actually said, verbatim. This is the entry worth reading
    // when the scan "worked" but found nothing. Thinking is noted by size
    // rather than quoted: it can run to thousands of characters and would
    // bury every other entry in the drawer.
    log?.info(`${config.model} replied`, [
        reply.reasoning ? `(plus ${reply.reasoning.length} characters of reasoning, not shown)` : '',
        reply.content || '(no content)'
    ].filter(Boolean).join('\n'));

    if (!reply.content.trim()) {
        // A reasoning model that thought until the budget ran out. This is the
        // ordinary way a DeepSeek scan fails, and it is fixable from the
        // settings, so it says so rather than reporting a blank reply.
        if (reply.reasoning || reply.finishReason === 'length') {
            log?.error('The model spent its whole reply budget thinking and never wrote an answer.',
                [
                    `finish_reason: ${reply.finishReason || '(none given)'}`,
                    `reasoning returned: ${reply.reasoning.length} characters`,
                    `reply budget: ${config.maxTokens} tokens`,
                    '',
                    'Reasoning counts against the reply budget, so a reasoning model needs a'
                    + ' much larger one than the findings themselves do. Raise "External Scan'
                    + ` Reply Length" (up to ${MAX_MAX_TOKENS}), or pick a model that does not reason.`
                ].join('\n'));
            throw new Error(`Crunchatize: external scan produced only reasoning (finish_reason ${reply.finishReason || 'unknown'}) - raise the reply length`);
        }

        // The whole payload, since whatever went wrong is in the half that
        // isn't the content: a refusal, a provider error object, an empty
        // choices array.
        log?.error('Endpoint answered with no content', JSON.stringify(payload, null, 2));
        throw new Error('Crunchatize: external scan returned no content');
    }

    // Even under a schema this is parsed defensively: strict mode is honoured
    // by the provider, not guaranteed by it. A reasoning model reached through
    // a provider that does not split its thinking out writes it into the
    // content, so the object is dug out of the reply rather than assumed to be
    // the whole of it.
    const json = extractScanJson(reply.content);
    if (json == null) {
        // Cut off before the object even closed. Blaming the model's schema
        // support here would send the player looking in the wrong place.
        log?.error(reply.finishReason === 'length'
            ? `Reply was cut off at the ${config.maxTokens}-token limit before the findings were complete. Raise "External Scan Reply Length".`
            : 'No findings object in the reply - the model may not support structured outputs.');
        throw new Error('Crunchatize: external scan returned no JSON object');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        log?.error(reply.finishReason === 'length'
            ? `Reply was cut off at the ${config.maxTokens}-token limit, leaving incomplete JSON. Raise "External Scan Reply Length".`
            : 'Reply was not valid JSON - the model may not support structured outputs.',
            json === reply.content ? undefined : `What was parsed:\n${json}`);
        throw new Error('Crunchatize: external scan returned malformed JSON');
    }

    const detections = parseStructuredScan(parsed);
    log?.info(`Parsed ${detections.length} finding${detections.length === 1 ? '' : 's'} from the reply`,
        detections.map(one => `${one.kind} | ${one.value}${one.detail ? ` | ${one.detail}` : ''}`).join('\n') || undefined);
    return detections;
}
