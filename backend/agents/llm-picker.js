// The agent runner's LLM step: one Anthropic Batches job per run, one request per persona, the
// model choosing which planned candidates to post and writing each rationale. Batch is half price
// and is the only mode used here — bulk work never goes through single calls.
//
// Submitting, waiting, collecting and cost accounting are the shared harness's job
// (agents/lib/llm-cost); what goes in the prompt and what comes back out is this repo's, so the
// request builder and the parser below are pure and tested, and the harness is injectable so no
// test touches the network.

import { computeCost } from '../../../agents/lib/llm-cost/index.mjs';
import * as batchHarness from '../../../agents/lib/llm-cost/batch.mjs';

export const DEFAULT_MODEL = 'claude-opus-5';

// Where the batch spend lands in the shared ledger (`llm-cost --repo consensus-builder`).
const LEDGER_REPO = 'consensus-builder';
const LEDGER_SCRIPT = 'agent-runner';
const PROVIDER = 'anthropic';

// A name longer than this is a paragraph pretending to be a title; it is cut, not rejected.
const MAX_NAME_CHARS = 60;

// Anthropic's own rule of thumb; only used for the pre-flight estimate, never for billing.
const CHARS_PER_TOKEN = 4;

export const PICK_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['picks'],
    properties: {
        picks: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['candidateId', 'name', 'rationale'],
                properties: {
                    candidateId: { type: 'string' },
                    name: { type: 'string' },
                    rationale: { type: 'string' }
                }
            }
        }
    }
};

function round(value, digits = 0) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function maxPicksOf(persona) {
    const declared = Number(persona && persona.dailyProposals);
    return Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 1;
}

// The persona's weights in words. A weight vector in the prompt reads as noise; "you care most
// about X, and you do not care about Y" is what a model can act on — and it keeps the stance and
// the score the planner already applied describing the same thing.
function stanceOf(persona) {
    const weights = (persona && persona.weights) || {};
    const labels = {
        density: 'adding floor area where the plan permits it',
        openSpace: 'keeping ground open and unbuilt',
        valueUplift: 'the € value a proposal creates',
        heritage: 'the existing built fabric and its character'
    };
    const ranked = Object.keys(labels)
        .map(key => ({ key, weight: Number.isFinite(Number(weights[key])) ? Number(weights[key]) : 0 }))
        .sort((a, b) => b.weight - a.weight);
    return ranked
        .map(({ key, weight }) => `  - ${labels[key]} — weight ${weight}${weight === 0 ? ' (you are indifferent to this)' : ''}`)
        .join('\n');
}

function systemPromptFor(persona, day) {
    const maxPicks = maxPicksOf(persona);
    return [
        `You are ${persona.name}, an autonomous participant in Urban Game Theory, a public game about what a city could build.`,
        `You are choosing which of today's (${day}) planned building proposals to actually post, in your own voice.`,
        '',
        'What you care about, in order:',
        stanceOf(persona),
        '',
        'Rules:',
        `- Choose AT MOST ${maxPicks} candidate${maxPicks === 1 ? '' : 's'}. Fewer is fine; choosing none is fine if none is worth posting.`,
        '- Prefer single-parcel lots with real uplift over the floor area already built there.',
        '- Write each rationale as 2-3 sentences in English, addressed to the parcel owner and to the public: what you propose, and why it is worth their while.',
        `- Write a short name, at most ${MAX_NAME_CHARS} characters.`,
        '- Use ONLY the numbers given to you in the candidate list. Never invent an area, a height, a price or a gain that is not there.',
        '- Answer with JSON matching the schema: an object with a "picks" array, each pick carrying candidateId, name and rationale.'
    ].join('\n');
}

// Geometry never goes in the prompt: the model is choosing between lots, not drawing them, and a
// polygon is thousands of tokens of coordinates it cannot use.
function candidateDigest(candidate) {
    return {
        candidateId: candidate.candidateId,
        parcelId: candidate.parcelId,
        koName: candidate.koName ?? null,
        areaM2: round(candidate.areaM2),
        buildingCount: candidate.buildingCount ?? 0,
        builtGfaM2: round(candidate.builtGfaM2),
        allowedFloors: candidate.allowedFloors ?? null,
        proposedGfaM2: round(candidate.proposedGfaM2),
        gainEur: round(candidate.gainEur),
        offerEur: round(candidate.offerEur),
        score: round(candidate.score, 4)
    };
}

/**
 * One Anthropic batch request per persona. Pure.
 *
 * @param {Object} args
 * @param {string} args.runId
 * @param {string} args.day      the run's day, as the caller states it (never invented here)
 * @param {Array}  args.entries  [{ persona, candidates }]
 * @param {string} [args.model]
 * @param {number} [args.maxTokens]
 */
// Anthropic constrains custom_id to ^[a-zA-Z0-9_-]{1,64}$ — no colons, no timestamps with "T…Z"
// punctuation. Run id and persona are joined with an underscore and anything else is squashed.
export function pickCustomId(runId, personaName) {
    const clean = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${clean(runId)}_${clean(personaName)}`.slice(0, 64);
}

export function buildPickRequests({ runId, day, entries, model = DEFAULT_MODEL, maxTokens = 4000 }) {
    const list = Array.isArray(entries) ? entries : [];
    return list
        .filter(entry => entry && entry.persona && entry.persona.name && Array.isArray(entry.candidates) && entry.candidates.length)
        .map(({ persona, candidates }) => ({
            custom_id: pickCustomId(runId, persona.name),
            params: {
                model,
                max_tokens: maxTokens,
                system: systemPromptFor(persona, day),
                messages: [{
                    role: 'user',
                    content: JSON.stringify({ day, persona: persona.name, candidates: candidates.map(candidateDigest) })
                }],
                output_config: {
                    effort: 'medium',
                    format: { type: 'json_schema', schema: PICK_SCHEMA }
                }
            }
        }));
}

/**
 * The model's answer, reduced to picks this run can actually act on. Pure.
 *
 * Anything the model made up is dropped rather than repaired: an unknown candidateId is a parcel
 * that was never planned, and posting it would be a proposal over land nobody measured.
 *
 * @returns {{ picks: Array<{candidateId: string, name: string, rationale: string}>,
 *             rejected: Array<{candidateId: (string|null), reason: string}> }}
 */
export function parsePicks(text, candidates, maxPicks) {
    const known = new Map((Array.isArray(candidates) ? candidates : [])
        .filter(c => c && c.candidateId)
        .map(c => [String(c.candidateId), c]));
    const cap = Number.isFinite(Number(maxPicks)) && Number(maxPicks) > 0 ? Math.floor(Number(maxPicks)) : 0;
    const picks = [];
    const rejected = [];

    let parsed;
    try {
        parsed = JSON.parse(String(text ?? ''));
    } catch (error) {
        return { picks, rejected: [{ candidateId: null, reason: `unparseable JSON: ${error.message}` }] };
    }
    if (!parsed || !Array.isArray(parsed.picks)) {
        return { picks, rejected: [{ candidateId: null, reason: 'no picks array in the answer' }] };
    }

    const seen = new Set();
    for (const item of parsed.picks) {
        const candidateId = (item && typeof item.candidateId === 'string') ? item.candidateId : null;
        if (!candidateId || !known.has(candidateId)) {
            rejected.push({ candidateId, reason: 'unknown candidateId' });
            continue;
        }
        if (seen.has(candidateId)) {
            rejected.push({ candidateId, reason: 'duplicate pick' });
            continue;
        }
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
        if (!name || !rationale) {
            rejected.push({ candidateId, reason: 'missing name or rationale' });
            continue;
        }
        if (picks.length >= cap) {
            rejected.push({ candidateId, reason: `over the persona's daily limit of ${cap}` });
            continue;
        }
        seen.add(candidateId);
        picks.push({ candidateId, name: name.slice(0, MAX_NAME_CHARS), rationale });
    }

    return { picks, rejected };
}

/**
 * What this batch could cost, at most, in USD. Pure.
 *
 * An UPPER BOUND, not a prediction: input tokens are estimated at 4 characters each (a rule of
 * thumb, not a tokenizer) and every request is billed as if the model wrote its full max_tokens,
 * which no pick answer does. The real spend is what the harness ledgers per item as it arrives.
 * Batch is priced at half the online rate by the shared table.
 */
export function estimateBatchCostUsd(requests, model = DEFAULT_MODEL) {
    const list = Array.isArray(requests) ? requests : [];
    let total = 0;
    for (const request of list) {
        const params = request && request.params ? request.params : {};
        const chars = String(params.system ?? '').length
            + JSON.stringify(params.messages ?? []).length;
        const usage = {
            input_tokens: Math.ceil(chars / CHARS_PER_TOKEN),
            output_tokens: Number(params.max_tokens) || 0
        };
        total += computeCost(model || params.model || DEFAULT_MODEL, usage, { batch: true });
    }
    return total;
}

/**
 * Submit (or resume) the pick batch and collect it, with every item priced into the shared ledger.
 *
 * A batch that has not finished within `awaitMs` is NOT an error: the caller gets
 * `{ batchId, done: false, results: [] }`, checkpoints the id, and reruns later with
 * `existingBatchId` — a batch already paid for must never be resubmitted.
 *
 * @param {Object} args
 * @param {Object} args.client            an Anthropic client
 * @param {Array}  args.requests          from buildPickRequests
 * @param {string} args.model
 * @param {string} args.runId
 * @param {string} [args.existingBatchId] resume instead of submitting
 * @param {number} [args.awaitMs]         ceiling on waiting, not on the batch
 * @param {Function} [args.onProgress]
 * @param {Object} [args.harness]         injected for tests; defaults to the shared batch harness
 */
export async function runPickBatch({
    client,
    requests,
    model = DEFAULT_MODEL,
    runId,
    existingBatchId = null,
    awaitMs = 10 * 60 * 1000,
    onProgress,
    harness = batchHarness
}) {
    const batchId = existingBatchId
        || await harness.submitBatch({ client, provider: PROVIDER, requests });

    let status = null;
    try {
        status = await harness.awaitBatch({
            client, provider: PROVIDER, batchId, timeoutMs: awaitMs, onProgress
        });
    } catch (error) {
        // awaitBatch throws when it hits its own ceiling. "Still running" and "the API is broken"
        // both arrive as a throw, so ask the batch itself which it was rather than guessing from
        // the message; only a batch that is genuinely still running becomes a checkpoint.
        let poll = null;
        try {
            poll = await harness.pollBatch({ client, provider: PROVIDER, batchId });
        } catch (_) {
            throw error;
        }
        if (!poll || !poll.done) return { batchId, done: false, results: [] };
        status = poll;
    }

    if (!status || !status.done) return { batchId, done: false, results: [] };

    const results = [];
    for await (const item of harness.collectBatch({
        client,
        provider: PROVIDER,
        batchId,
        model,
        repo: LEDGER_REPO,
        script: LEDGER_SCRIPT,
        meta: { runId }
    })) {
        results.push({
            customId: item.customId ?? null,
            text: item.text ?? null,
            usage: item.usage ?? null,
            costUsd: item.costUsd ?? null,
            error: item.error ?? null
        });
    }
    return { batchId, done: true, results };
}
