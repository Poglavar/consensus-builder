// Unit tests for backend/agents/llm-picker.js. The pure parts — request building, parsing and the
// cost estimate — are covered directly; runPickBatch is driven through an injected stub layer and,
// end to end, through the REAL shared layer over a fake Anthropic client, so nothing here submits a
// batch or spends money, and the ledger rows land in a throwaway LLM_COST_DIR.
//
// The property that matters most in parsePicks: anything the model invented is DROPPED, not
// repaired. An unknown candidateId is a parcel nobody planned or measured, and posting it would be
// a proposal over land the runner never looked at.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The shared ledger path is fixed when the layer is first loaded, so point it at a temp dir before
// any import can load it. The guard below refuses to run the real-layer tests if it landed anywhere else.
// (vi.hoisted runs before the imports, so it can only use globals; record() creates the dir.)
const ledgerDir = vi.hoisted(() => {
    const dir = `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/agent-llm-picker-${process.pid}-${Date.now()}`;
    process.env.LLM_COST_DIR = dir;
    return dir;
});

import {
    buildPickRequests,
    parsePicks,
    estimateBatchCostUsd,
    runPickBatch,
    createAgentLlm,
    PICK_SCHEMA,
    pickCustomId } from '../agents/llm-picker.js';
import { buildChoiceRequest } from '../agents/society-llm.js';
import { DEFAULTS } from '../../../agents/lib/llm-cost/llm.mjs';
import { LEDGER } from '../../../agents/lib/llm-cost/index.mjs';

// The model every call must run on: the shared layer's default, never one named in this repo.
const LAYER_MODEL = DEFAULTS.providers.anthropic.model;
const LAYER_EFFORT = DEFAULTS.providers.anthropic.effort;

// A fake Anthropic SDK client: records what was submitted, answers with canned batch results.
function fakeAnthropic({ status = 'ended', results = [] } = {}) {
    const submitted = [];
    return {
        submitted,
        messages: {
            create: vi.fn(async () => { throw new Error('online calls are not used by the agent runner'); }),
            batches: {
                create: vi.fn(async ({ requests }) => { submitted.push(...requests); return { id: 'msgbatch_fake' }; }),
                retrieve: vi.fn(async () => ({ processing_status: status, request_counts: { processing: status === 'ended' ? 0 : 1, succeeded: results.length } })),
                results: vi.fn(async () => (async function* () { yield* results; })())
            }
        }
    };
}

const LLM = createAgentLlm({ client: fakeAnthropic(), meta: { runId: 'test' } });

const PERSONA = {
    name: 'densifier-01',
    weights: { density: 0.6, openSpace: 0.1, valueUplift: 0.3, heritage: 0.0 },
    dailyProposals: 3
};

function candidate(n, extra = {}) {
    return {
        candidateId: `densifier-01:HR-335614-${n}`,
        parcelId: `HR-335614-${n}`,
        koName: 'RUDEŠ',
        areaM2: 422.0912,
        centroid: { lng: 15.93, lat: 45.79 },
        geometry: { type: 'Polygon', coordinates: [[[15.93, 45.79], [15.94, 45.79], [15.94, 45.8], [15.93, 45.79]]] },
        buildingCount: 2,
        builtGfaM2: 295.34,
        allowedFloors: 4,
        envelope: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
        massing: { type: 'Feature', properties: { floors: 3, height: 9 }, geometry: { type: 'Polygon', coordinates: [] } },
        proposedGfaM2: 900.12,
        gainEur: 2418800.5,
        offerEur: 725640,
        score: 0.7123456,
        scoreParts: { density: 0.67, valueUplift: 1, openSpace: 0.75, heritage: 0 },
        ...extra
    };
}

const RUN_ID = '2026-09-17T02:00Z';
const DAY = '2026-09-17';

describe('buildPickRequests', () => {
    const requests = buildPickRequests({
        llm: LLM,
        runId: RUN_ID,
        day: DAY,
        entries: [{ persona: PERSONA, candidates: [candidate(1), candidate(2)] }]
    });

    it('produces one request per persona, keyed by run and persona', () => {
        expect(requests).toHaveLength(1);
        expect(requests[0].custom_id).toBe('2026-09-17T02_00Z_densifier-01');
        expect(requests[0].custom_id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    });

    it('asks for structured JSON output against PICK_SCHEMA', () => {
        const { output_config: outputConfig } = requests[0].params;
        expect(outputConfig.format.type).toBe('json_schema');
        expect(outputConfig.format.schema).toEqual(PICK_SCHEMA);
        expect(PICK_SCHEMA.properties.picks.items.required).toEqual(['candidateId', 'name', 'rationale']);
        expect(PICK_SCHEMA.additionalProperties).toBe(false);
    });

    it('runs on the shared layer\'s default model and effort, with a real token ceiling', () => {
        expect(requests[0].params.model).toBe(LAYER_MODEL);
        expect(requests[0].params.output_config.effort).toBe(LAYER_EFFORT);
        expect(requests[0].params.max_tokens).toBe(4000);
        const custom = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [{ persona: PERSONA, candidates: [candidate(1)] }], maxTokens: 800 });
        expect(custom[0].params.max_tokens).toBe(800);
    });

    it('ignores the retired AGENT_LLM_MODEL override and any model argument', () => {
        process.env.AGENT_LLM_MODEL = 'claude-sonnet-5';
        try {
            const reqs = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [{ persona: PERSONA, candidates: [candidate(1)] }], model: 'claude-sonnet-5' });
            expect(reqs[0].params.model).toBe(LAYER_MODEL);
        } finally {
            delete process.env.AGENT_LLM_MODEL;
        }
    });

    it('states the persona\'s own daily cap in its prompt', () => {
        expect(requests[0].params.system).toMatch(/AT MOST 3 candidates/);
        const one = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [{ persona: { ...PERSONA, dailyProposals: 1 }, candidates: [candidate(1)] }] });
        expect(one[0].params.system).toMatch(/AT MOST 1 candidate\./);
        // A persona that declares nothing must not read as "unlimited".
        const none = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [{ persona: { name: 'p' }, candidates: [candidate(1)] }] });
        expect(none[0].params.system).toMatch(/AT MOST 1 candidate\./);
    });

    it('puts the persona\'s weights into the prompt in words, strongest first', () => {
        const system = requests[0].params.system;
        expect(system).toContain('densifier-01');
        expect(system.indexOf('adding floor area')).toBeLessThan(system.indexOf('the € value'));
        expect(system.indexOf('the € value')).toBeLessThan(system.indexOf('keeping ground open'));
        expect(system).toMatch(/weight 0 \(you are indifferent to this\)/);
    });

    it('forbids inventing numbers and asks for a 2-3 sentence rationale and a short name', () => {
        const system = requests[0].params.system;
        expect(system).toMatch(/Never invent/);
        expect(system).toMatch(/2-3 sentences/);
        expect(system).toMatch(/at most 60 characters/);
    });

    it('sends the candidate figures and NO geometry', () => {
        const payload = JSON.parse(requests[0].params.messages[0].content[0].text);
        expect(payload.day).toBe(DAY);
        expect(payload.candidates).toHaveLength(2);
        expect(payload.candidates[0]).toEqual({
            candidateId: 'densifier-01:HR-335614-1',
            parcelId: 'HR-335614-1',
            koName: 'RUDEŠ',
            areaM2: 422,
            buildingCount: 2,
            builtGfaM2: 295,
            allowedFloors: 4,
            proposedGfaM2: 900,
            gainEur: 2418801,
            offerEur: 725640,
            score: 0.7123
        });
        expect(requests[0].params.messages[0].content[0].text).not.toContain('coordinates');
        expect(requests[0].params.messages[0].content[0].text).not.toContain('massing');
    });

    it('skips a persona with nothing to choose from rather than sending an empty prompt', () => {
        expect(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [{ persona: PERSONA, candidates: [] }] })).toEqual([]);
        expect(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [] })).toEqual([]);
        expect(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: null })).toEqual([]);
    });

    it('builds one request per persona for a multi-persona run', () => {
        const other = { name: 'preserver-02', weights: { openSpace: 0.9 }, dailyProposals: 2 };
        const many = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [
            { persona: PERSONA, candidates: [candidate(1)] },
            { persona: other, candidates: [candidate(2)] }
        ] });
        expect(many.map(r => r.custom_id)).toEqual([pickCustomId(RUN_ID, 'densifier-01'), pickCustomId(RUN_ID, 'preserver-02')]);
        expect(many[1].params.system).toMatch(/AT MOST 2 candidates/);
    });
});

describe('parsePicks', () => {
    const candidates = [candidate(1), candidate(2), candidate(3)];
    const id = n => `densifier-01:HR-335614-${n}`;
    const pick = (n, extra = {}) => ({ candidateId: id(n), name: `Name ${n}`, rationale: `Because ${n}.`, ...extra });

    it('keeps well-formed picks in order', () => {
        const { picks, rejected } = parsePicks(JSON.stringify({ picks: [pick(2), pick(1)] }), candidates, 3);
        expect(picks).toEqual([
            { candidateId: id(2), name: 'Name 2', rationale: 'Because 2.' },
            { candidateId: id(1), name: 'Name 1', rationale: 'Because 1.' }
        ]);
        expect(rejected).toEqual([]);
    });

    it('drops a candidateId that was never planned', () => {
        const { picks, rejected } = parsePicks(JSON.stringify({ picks: [pick(1), { candidateId: 'densifier-01:HR-999-1', name: 'x', rationale: 'y' }] }), candidates, 3);
        expect(picks.map(p => p.candidateId)).toEqual([id(1)]);
        expect(rejected).toEqual([{ candidateId: 'densifier-01:HR-999-1', reason: 'unknown candidateId' }]);
    });

    it('drops a duplicate pick', () => {
        const { picks, rejected } = parsePicks(JSON.stringify({ picks: [pick(1), pick(1)] }), candidates, 3);
        expect(picks).toHaveLength(1);
        expect(rejected).toEqual([{ candidateId: id(1), reason: 'duplicate pick' }]);
    });

    it('trims to the persona\'s cap and says what it dropped', () => {
        const { picks, rejected } = parsePicks(JSON.stringify({ picks: [pick(1), pick(2), pick(3)] }), candidates, 2);
        expect(picks.map(p => p.candidateId)).toEqual([id(1), id(2)]);
        expect(rejected).toEqual([{ candidateId: id(3), reason: "over the persona's daily limit of 2" }]);
    });

    it('caps the name at 60 characters and trims whitespace', () => {
        const long = 'x'.repeat(200);
        const { picks } = parsePicks(JSON.stringify({ picks: [pick(1, { name: `   ${long}   ` })] }), candidates, 3);
        expect(picks[0].name).toHaveLength(60);
        expect(picks[0].name).toBe('x'.repeat(60));
    });

    it('rejects a pick with no name or no rationale rather than posting a blank one', () => {
        const { picks, rejected } = parsePicks(JSON.stringify({ picks: [pick(1, { name: '  ' }), pick(2, { rationale: '' })] }), candidates, 3);
        expect(picks).toEqual([]);
        expect(rejected.map(r => r.reason)).toEqual(['missing name or rationale', 'missing name or rationale']);
    });

    it('survives an answer that is not JSON at all', () => {
        const { picks, rejected } = parsePicks('I would pick the second one.', candidates, 3);
        expect(picks).toEqual([]);
        expect(rejected[0].candidateId).toBeNull();
        expect(rejected[0].reason).toMatch(/unparseable JSON/);
    });

    it('survives JSON with no picks array', () => {
        expect(parsePicks('{"answer":"none"}', candidates, 3)).toEqual({ picks: [], rejected: [{ candidateId: null, reason: 'no picks array in the answer' }] });
        expect(parsePicks('null', candidates, 3).rejected[0].reason).toBe('no picks array in the answer');
        expect(parsePicks(null, candidates, 3).picks).toEqual([]);
    });

    it('accepts an empty pick list — choosing nothing is a valid answer', () => {
        expect(parsePicks('{"picks":[]}', candidates, 3)).toEqual({ picks: [], rejected: [] });
    });

    it('keeps nothing when the cap is zero', () => {
        const { picks, rejected } = parsePicks(JSON.stringify({ picks: [pick(1)] }), candidates, 0);
        expect(picks).toEqual([]);
        expect(rejected).toHaveLength(1);
    });
});

describe('estimateBatchCostUsd', () => {
    const entry = n => ({ persona: PERSONA, candidates: Array.from({ length: n }, (_, i) => candidate(i + 1)) });

    it('is a positive number for a real batch', () => {
        const cost = estimateBatchCostUsd(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(5)] }));
        expect(cost).toBeGreaterThan(0);
        expect(Number.isFinite(cost)).toBe(true);
    });

    it('rises with the number of candidates', () => {
        const small = estimateBatchCostUsd(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(2)] }));
        const large = estimateBatchCostUsd(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(20)] }));
        expect(large).toBeGreaterThan(small);
    });

    it('rises with the number of personas', () => {
        const one = estimateBatchCostUsd(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(4)] }));
        // Same-length name, so the two prompts are the same size and the doubling is exact.
        const two = estimateBatchCostUsd(buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(4), { ...entry(4), persona: { ...PERSONA, name: 'densifier-02' } }] }));
        expect(two).toBeGreaterThan(one);
        expect(two).toBeCloseTo(one * 2, 6);
    });

    it('is half the online price — batch is priced at 50% by the shared table', async () => {
        const { computeCost } = await import('../../../agents/lib/llm-cost/index.mjs');
        const requests = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(3)] });
        const params = requests[0].params;
        const chars = params.system.length + JSON.stringify(params.messages).length;
        const usage = { input_tokens: Math.ceil(chars / 4), output_tokens: params.max_tokens };
        expect(estimateBatchCostUsd(requests)).toBeCloseTo(computeCost(LAYER_MODEL, usage, { batch: true }), 12);
        expect(computeCost(LAYER_MODEL, usage, { batch: true }) * 2)
            .toBeCloseTo(computeCost(LAYER_MODEL, usage), 12);
    });

    it('is zero for nothing to send', () => {
        expect(estimateBatchCostUsd([])).toBe(0);
        expect(estimateBatchCostUsd(null)).toBe(0);
    });

    it('throws on an unpriced model rather than reporting a guessed number', () => {
        const [request] = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [entry(1)] });
        const unpriced = { ...request, params: { ...request.params, model: 'claude-imaginary-9' } };
        expect(() => estimateBatchCostUsd([unpriced])).toThrow(/no rate for model/);
    });
});

// A stub standing in for the shared layer's batch methods — same four functions, no network, no ledger.
function stubLlm({ done = true, results = [], awaitThrows = false, pollDone = false } = {}) {
    return {
        submitBatch: vi.fn(async () => 'msgbatch_stub'),
        pollBatch: vi.fn(async () => ({ done: pollDone, status: 'in_progress' })),
        awaitBatch: vi.fn(async () => {
            if (awaitThrows) throw new Error('llm-cost/batch: msgbatch_stub still in_progress after 1h — giving up');
            return { done, status: done ? 'ended' : 'in_progress' };
        }),
        collectBatch: vi.fn(async function* () { yield* results; })
    };
}

describe('runPickBatch', () => {
    const requests = buildPickRequests({ llm: LLM, runId: RUN_ID, day: DAY, entries: [{ persona: PERSONA, candidates: [candidate(1)] }] });

    it('submits, waits and collects through the layer', async () => {
        const llm = stubLlm({ results: [
            { customId: pickCustomId(RUN_ID, 'densifier-01'), text: '{"picks":[]}', model: LAYER_MODEL, usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.002 }
        ] });
        const out = await runPickBatch({ llm, requests });

        expect(llm.submitBatch).toHaveBeenCalledWith(requests);
        expect(out).toEqual({
            batchId: 'msgbatch_stub',
            done: true,
            results: [{ customId: pickCustomId(RUN_ID, 'densifier-01'), text: '{"picks":[]}', model: LAYER_MODEL, usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.002, error: null }]
        });
        expect(llm.collectBatch).toHaveBeenCalledWith('msgbatch_stub');
    });

    it('resumes an existing batch instead of paying for it twice', async () => {
        const llm = stubLlm();
        const out = await runPickBatch({ llm, requests, existingBatchId: 'msgbatch_earlier' });
        expect(llm.submitBatch).not.toHaveBeenCalled();
        expect(llm.awaitBatch).toHaveBeenCalledWith('msgbatch_earlier', expect.any(Object));
        expect(out.batchId).toBe('msgbatch_earlier');
    });

    it('passes the wait ceiling to the layer as its timeout', async () => {
        const llm = stubLlm();
        await runPickBatch({ llm, requests, awaitMs: 1234 });
        expect(llm.awaitBatch).toHaveBeenCalledWith('msgbatch_stub', expect.objectContaining({ timeoutMs: 1234 }));
    });

    it('returns a checkpoint, not an error, when the batch is still running at the ceiling', async () => {
        const llm = stubLlm({ awaitThrows: true, pollDone: false });
        const out = await runPickBatch({ llm, requests });
        expect(out).toEqual({ batchId: 'msgbatch_stub', done: false, results: [] });
        expect(llm.collectBatch).not.toHaveBeenCalled();
    });

    it('also returns a checkpoint when the layer reports not-done without throwing', async () => {
        const llm = stubLlm({ done: false });
        const out = await runPickBatch({ llm, requests });
        expect(out).toEqual({ batchId: 'msgbatch_stub', done: false, results: [] });
        expect(llm.collectBatch).not.toHaveBeenCalled();
    });

    it('collects after all when the ceiling fired but the batch had in fact ended', async () => {
        const llm = stubLlm({ awaitThrows: true, pollDone: true, results: [{ customId: 'a', text: '{}', usage: {}, costUsd: 0.001 }] });
        const out = await runPickBatch({ llm, requests });
        expect(out.done).toBe(true);
        expect(out.results).toHaveLength(1);
    });

    it('still throws when the API itself is broken — a failure must not look like patience', async () => {
        const llm = stubLlm({ awaitThrows: true });
        llm.pollBatch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        await expect(runPickBatch({ llm, requests })).rejects.toThrow(/giving up/);
    });

    it('carries a per-item error through, with its reason and its cost, instead of dropping the item', async () => {
        const llm = stubLlm({ results: [
            { customId: 'a', error: 'errored', reason: 'errored', costUsd: null },
            { customId: 'b', error: 'answer truncated at max_tokens', reason: 'max_tokens', costUsd: 0.01, usage: { input_tokens: 1, output_tokens: 4000 } }
        ] });
        const out = await runPickBatch({ llm, requests });
        expect(out.results).toEqual([
            { customId: 'a', text: null, model: null, usage: null, costUsd: null, error: 'errored: errored' },
            { customId: 'b', text: null, model: null, usage: { input_tokens: 1, output_tokens: 4000 }, costUsd: 0.01, error: 'max_tokens: answer truncated at max_tokens' }
        ]);
    });
});

// End to end through the REAL shared layer: what reaches the Batches API, and what is ledgered.
// Deleting the layer's default (or re-pinning a model in this repo) fails these.
describe('runPickBatch through the shared layer', () => {
    it('writes its ledger rows to the throwaway dir, never the real ledger', () => {
        expect(LEDGER.startsWith(ledgerDir)).toBe(true);
    });

    it('submits on the layer default, prices the answering model and ledgers under consensus-builder', async () => {
        if (!LEDGER.startsWith(ledgerDir)) throw new Error(`refusing to write the real ledger at ${LEDGER}`);
        const customId = pickCustomId(DAY, 'densifier-01');
        const client = fakeAnthropic({ results: [{
            custom_id: customId,
            result: { type: 'succeeded', message: {
                model: LAYER_MODEL, stop_reason: 'end_turn',
                content: [{ type: 'text', text: JSON.stringify({ picks: [{ candidateId: 'densifier-01:HR-335614-1', name: 'N', rationale: 'R.' }] }) }],
                usage: { input_tokens: 1000, output_tokens: 500 }
            } }
        }] });
        const llm = createAgentLlm({ client, meta: { runId: DAY } });
        const requests = buildPickRequests({ llm, runId: DAY, day: DAY, entries: [{ persona: PERSONA, candidates: [candidate(1)] }] });
        const out = await runPickBatch({ llm, requests });

        expect(client.submitted).toHaveLength(1);
        expect(client.submitted[0].params.model).toBe(LAYER_MODEL);
        expect(client.submitted[0].params.output_config.effort).toBe(LAYER_EFFORT);
        expect(client.submitted[0].params).not.toHaveProperty('temperature');
        expect(out.done).toBe(true);
        expect(out.results[0]).toMatchObject({ customId, model: LAYER_MODEL, error: null });
        // Batch is half the online rate: (1000 × input + 500 × output) / 1e6 / 2.
        const { computeCost } = await import('../../../agents/lib/llm-cost/index.mjs');
        expect(out.results[0].costUsd).toBeCloseTo(computeCost(LAYER_MODEL, { input_tokens: 1000, output_tokens: 500 }) / 2, 12);
        expect(parsePicks(out.results[0].text, [candidate(1)], 3).picks).toHaveLength(1);

        const rows = fs.readFileSync(path.join(ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(r => r.customId === customId);
        expect(row).toMatchObject({ repo: 'consensus-builder', script: 'agent-runner', model: LAYER_MODEL, batch: true,
            runId: DAY, batchId: 'msgbatch_fake', cost_usd: out.results[0].costUsd });
    });

    it('turns a refusal into an error that still carries what it cost', async () => {
        const client = fakeAnthropic({ results: [{
            custom_id: 'x',
            result: { type: 'succeeded', message: { model: LAYER_MODEL, stop_reason: 'refusal', content: [], usage: { input_tokens: 100, output_tokens: 10 } } }
        }] });
        const out = await runPickBatch({ llm: createAgentLlm({ client }), requests: [{ custom_id: 'x', params: {} }] });
        expect(out.results[0].error).toMatch(/^refusal: refused/);
        expect(out.results[0].costUsd).toBeGreaterThan(0);
    });

    it('society choices ride the same default model', () => {
        const option = { action: { type: 'stake', side: 'no', amount: '0.01', proposalId: 'a', proposalName: 'A', rationale: 'r' } };
        const request = buildChoiceRequest({ llm: LLM, runId: 'r1', persona: { name: 'p' }, role: 'contrarian', seed: 's', options: [option] });
        expect(request.params.model).toBe(LAYER_MODEL);
        expect(request.params.output_config.effort).toBe(LAYER_EFFORT);
    });

    it('no agent source names a model id — the default lives in the shared layer only', () => {
        const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'agents');
        for (const file of ['llm-picker.js', 'society-llm.js', 'run.mjs', 'society-run.mjs']) {
            const src = fs.readFileSync(path.join(dir, file), 'utf8');
            expect(src, file).not.toMatch(/['"`]claude-[a-z0-9-]+['"`]/);
            expect(src, file).not.toMatch(/AGENT_LLM_MODEL|DEFAULT_MODEL/);
        }
    });
});
