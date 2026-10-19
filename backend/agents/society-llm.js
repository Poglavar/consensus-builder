// Optional LLM controller for society roles (society-run.mjs --controller llm; off by default). The
// policy module still decides what is ELIGIBLE and prices each option against the caps; the model
// only chooses one of those options, or none, and writes the rationale. It rides the same Batches
// path as the proposer (llm-picker.js runPickBatch / estimateBatchCostUsd). Pure: request building
// and parsing only; the runner submits, ledgers the cost and enforces the daily model cap. The model
// is the shared layer's default (the `llm` passed in, from llm-picker.js createAgentLlm).
import { pickCustomId } from './llm-picker.js';

export const CHOICE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['choice', 'rationale'],
    properties: {
        choice: { type: 'string', description: 'an optionId from the list, or "none"' },
        rationale: { type: 'string' }
    }
};

const STANCES = {
    contrarian: 'You are a preservationist. You bet NO on proposals that add the most floor area, to put a price on density nobody has argued against.',
    speculator: 'You are a speculator. You pledge early behind proposals the market favours and withdraw when the market turns or the proposal goes stale.'
};

function optionDigest(option) {
    const { action } = option;
    return {
        optionId: `${action.type}:${action.proposalId}`,
        type: action.type, side: action.side || null, amountUsdc: action.amount,
        proposalId: action.proposalId, proposalName: action.proposalName,
        evidence: option.evidence?.detail || null,
        impliedYesProbability: option.probability ?? null,
        ageDays: typeof option.ageDays === 'number' ? Number(option.ageDays.toFixed(2)) : null,
        policyRationale: action.rationale
    };
}

export function optionId(option) {
    return `${option.action.type}:${option.action.proposalId}`;
}

/**
 * One Batches request asking the model to choose among the options that fit the budget. The cap
 * leaves room for the layer's default reasoning effort; billing is by tokens produced.
 */
export function buildChoiceRequest({ llm, runId, persona, role, seed, options, maxTokens = 4000 }) {
    if (!Array.isArray(options) || !options.length) throw new Error('buildChoiceRequest needs at least one option');
    return llm.batchRequest(pickCustomId(runId, persona.name), {
        system: `${STANCES[role] || `You act as the ${role} persona.`} Choose at most ONE option by its optionId, or "none". Every option already passed the persona's eligibility rules and spending caps; do not invent others. Explain the choice in one or two sentences a reader can check against the evidence.`,
        content: JSON.stringify({ gameDay: seed, persona: persona.name, options: options.map(optionDigest) }),
        schema: CHOICE_SCHEMA,
        maxTokens
    });
}

/**
 * The model's answer reduced to an option or none. An optionId not in the list is refused, never
 * repaired: it would be an action no policy checked.
 * @returns {{ option: object|null, rationale: string|null, rejected: string|null }}
 */
export function parseChoice(text, options) {
    let parsed;
    try {
        parsed = JSON.parse(String(text ?? ''));
    } catch (error) {
        return { option: null, rationale: null, rejected: `unparseable JSON: ${error.message}` };
    }
    const choice = typeof parsed?.choice === 'string' ? parsed.choice.trim() : '';
    const rationale = typeof parsed?.rationale === 'string' && parsed.rationale.trim() ? parsed.rationale.trim() : null;
    if (!choice) return { option: null, rationale, rejected: 'no choice in the answer' };
    if (choice === 'none') return { option: null, rationale, rejected: null };
    const option = (options || []).find(item => optionId(item) === choice) || null;
    if (!option) return { option: null, rationale, rejected: `unknown optionId ${choice}` };
    if (!rationale) return { option: null, rationale, rejected: 'missing rationale' };
    return { option, rationale, rejected: null };
}
