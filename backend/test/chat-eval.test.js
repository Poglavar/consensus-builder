import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { assertBudget, assertEvalTurnCanContinue, callEstimateUsd, canonicalPlanSnapshot, checkpointFingerprint, contextForEvalCase, evalExitCode, parseArgs, planFromSeed, pricesOf, readCanonicalPlan, recordFailedAttempt, refreshSelectionFromPlan, resolveSeededSelection, retryAttemptsOf, selectorForEvalTurn, writeCheckpoint } from '../scripts/chat-eval.mjs';
import { costUsd, estimateTurnUsd, pricesFromEnv } from '../chat/cost.js';
import { createOpenAIModelCaller, MAX_CHAT_INPUT_TOKENS } from '../chat/model.js';
import { cidOfObject } from '../cid.js';
const PlanRecord = createRequire(import.meta.url)('../../frontend/js/plan-record.js');

// This test covers the paid-eval CLI guards and checkpoint behavior without making model calls.
describe('chat eval CLI guards', () => {
    let directory;
    afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = null; });
    it('prints usage without --run and requires an explicit finite budget and prices to run', () => {
        expect(parseArgs([])).toEqual({ run: false });
        expect(() => parseArgs(['--run'])).toThrow(/required/);
        expect(() => parseArgs(['--run','--cases','x','--mcp','http://localhost/mcp','--model','m','--budget-usd','Infinity','--input-price','1','--output-price','1','--cache-read-price','1','--cache-write-price','1','--output','out'])).toThrow(/finite/);
    });
    it('checks a conservative estimate before spending and changes fingerprint with configuration', () => {
        const prices = { input: 0.1, output: 0.5, cache_read: 0.01, cache_creation: 0.125 };
        const estimate = callEstimateUsd(prices, { system: 'prompt', messages: [], tools: [] });
        expect(estimate).toBeGreaterThan(0);
        expect(() => assertBudget({ spentUsd: 0.999, budgetUsd: 1, nextEstimateUsd: estimate })).toThrowError(expect.objectContaining({ code: 'eval-budget-exhausted' }));
        const cases = [{ id: 'one' }], config = { provider: 'anthropic', model: 'haiku', mcp: 'http://localhost:3098/mcp', prices };
        expect(checkpointFingerprint(cases, config)).toBe(checkpointFingerprint(cases, config));
        expect(checkpointFingerprint(cases, { ...config, model: 'sonnet' })).not.toBe(checkpointFingerprint(cases, config));
        expect(checkpointFingerprint(cases, { ...config, provider: 'openai' })).not.toBe(checkpointFingerprint(cases, config));
    });
    it('writes an atomic checkpoint that carries cumulative spend and fingerprint', () => {
        directory = mkdtempSync(join(tmpdir(), 'chat-eval-'));
        const path = join(directory, 'checkpoint.json'), checkpoint = { fingerprint: 'abc', spentUsd: 0.012345, cases: {}, inflight: null };
        writeCheckpoint(path, checkpoint);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(checkpoint);
        expect(pricesOf({ inputprice: '1', outputprice: '2', cachereadprice: '3', cachewriteprice: '4' })).toEqual({ input: 1, output: 2, cache_read: 3, cache_creation: 4 });
    });
    it('requires every model price and charges cache tokens at their configured rates', () => {
        const prices = { input: 0.1, output: 0.5, cache_read: 0.01, cache_creation: 0.125 };
        expect(pricesFromEnv({ CHAT_PRICE_USD_PER_MTOK_INPUT: '0.1', CHAT_PRICE_USD_PER_MTOK_OUTPUT: '0.5', CHAT_PRICE_USD_PER_MTOK_CACHE_READ: '0.01', CHAT_PRICE_USD_PER_MTOK_CACHE_WRITE: '0.125' })).toEqual(prices);
        expect(() => pricesFromEnv({})).toThrow(/must be configured/);
        expect(() => costUsd({}, {})).toThrow(/prices are required/);
        expect(costUsd({ input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 50 }, prices)).toBe(0.000075);
        expect(estimateTurnUsd(prices, { maxSteps: 2 })).toBeGreaterThan(costUsd({ input_tokens: 30_000, output_tokens: 2048 }, prices));
    });
    it('checks token count before the paid model endpoint and marks over-limit failures as no-call', async () => {
        const client = { responses: { inputTokens: { count: async () => ({ input_tokens: MAX_CHAT_INPUT_TOKENS + 1 }) }, create: async () => { throw new Error('must not call'); } } };
        const callModel = createOpenAIModelCaller({ client, model: 'test' });
        await expect(callModel({ system: 'prompt', tools: [], messages: [] })).rejects.toMatchObject({ code: 'context-limit', noModelCall: true });
    });
    it('resolves eval-only member selectors to canonical seeded plan members', () => {
        const design = { schema: 'design/v1', geometry: { buildings: [{ properties: { floors: 4 } }] } }, cid = cidOfObject(design);
        expect(planFromSeed('ugt_draft_building', { structuredContent: { plan: { draftRef: 'http://localhost/plan', cid: 'plan-cid' }, placement: { status: 'placed' } } })).toEqual({ draftRef: 'http://localhost/plan', cid: 'plan-cid' });
        expect(resolveSeededSelection({ memberIndex: 0, buildingIndex: 0 }, { structuredContent: { designs: [{ cid, untrusted: { content: design } }] } })).toEqual({ designCid: cid, buildingIndex: 0 });
        expect(() => resolveSeededSelection({ memberIndex: 1 }, { designs: [{ cid, untrusted: { content: design } }] })).toThrow(/memberIndex/);
        expect(() => resolveSeededSelection({ memberIndex: 0, buildingIndex: 1 }, { designs: [{ cid, untrusted: { content: design } }] })).toThrow(/buildingIndex/);
        expect(() => resolveSeededSelection({ memberIndex: 0 }, { designs: [{ cid: 'wrong-cid', untrusted: { content: design } }] })).toThrow(/matching canonical/);
    });
    it('resolves a unique semantic memberGoal across plan ordering and rejects missing or ambiguous goals', async () => {
        const track = { schema: 'design/v1', goal: 'road-track', title: 'Track' }, station = { schema: 'design/v1', goal: 'station', title: 'Stop' };
        const stationCid = cidOfObject(station);
        const row = design => ({ cid: cidOfObject(design), untrusted: { content: design } });
        expect(resolveSeededSelection({ memberGoal: 'station' }, { designs: [row(track), row(station)] })).toEqual({ designCid: stationCid });
        const mcp = { callTool: async (_tool, { plan }) => ({ structuredContent: { designs: plan === 'first'
            ? [row(track), row(station)] : [row(station), row(track)] } }) };
        expect(await refreshSelectionFromPlan(mcp, { memberGoal: 'station' }, { draftRef: 'first' })).toEqual({ designCid: stationCid });
        expect(await refreshSelectionFromPlan(mcp, { memberGoal: 'station' }, { draftRef: 'second' })).toEqual({ designCid: stationCid });
        expect(() => resolveSeededSelection({ memberGoal: 'station' }, { designs: [row(track)] })).toThrow(/resolves to 0 plan members/);
        expect(() => resolveSeededSelection({ memberGoal: 'station' }, { designs: [row(station), row({ ...station, title: 'Second stop' })] })).toThrow(/resolves to 2 plan members/);
    });
    it('re-resolves member selection against the latest plan CID each turn', async () => {
        const designA = { schema: 'design/v1', title: 'A' }, designB = { schema: 'design/v1', title: 'B' };
        const mcp = { callTool: async (_tool, { plan }) => ({ structuredContent: { designs: [{ cid: cidOfObject(plan === 'draft-1' ? designA : designB), untrusted: { content: plan === 'draft-1' ? designA : designB } }] } }) };
        expect(await refreshSelectionFromPlan(mcp, { memberIndex: 0 }, { draftRef: 'draft-1' })).toEqual({ designCid: cidOfObject(designA) });
        expect(await refreshSelectionFromPlan(mcp, { memberIndex: 0 }, { draftRef: 'draft-2' })).toEqual({ designCid: cidOfObject(designB) });
    });
    it('uses the case language over any stale language in its context', () => {
        expect(contextForEvalCase({ language: 'hr', context: { language: 'en', city: 'london' } })).toEqual({ language: 'hr', city: 'london' });
    });
    it('uses eval-only per-turn member selectors without changing the model context', () => {
        const caseSelector = { memberIndex: 0, buildingIndex: 0 }, turn = { selection: { memberIndex: 1 } };
        expect(selectorForEvalTurn(caseSelector, turn)).toEqual({ memberIndex: 1 });
        expect(selectorForEvalTurn(caseSelector, {})).toBe(caseSelector);
        expect(turn).toEqual({ selection: { memberIndex: 1 } });
        const byGoal = { selection: { memberGoal: 'station' } };
        expect(selectorForEvalTurn(caseSelector, byGoal)).toEqual({ memberGoal: 'station' });
    });
    it('stops after uncertain paid calls and budget exhaustion before another turn is recorded', () => {
        const checkpoint = { inflight: { case: 'case-a' } };
        expect(() => assertEvalTurnCanContinue({ outcome: { type: 'error' } }, checkpoint)).toThrow(/uncertain paid call/);
        checkpoint.inflight = null;
        expect(() => assertEvalTurnCanContinue({ outcome: { code: 'eval-budget-exhausted' } }, checkpoint)).toThrowError(expect.objectContaining({ code: 'eval-budget-exhausted' }));
        expect(() => assertEvalTurnCanContinue({ outcome: { type: 'reply' } }, checkpoint)).not.toThrow();
    });
    it('reads canonical plan snapshots by a private draft reference and verifies member hashes', async () => {
        const design = { schema: 'design/v1', goal: 'park' }, designCid = cidOfObject(design);
        const planContent = PlanRecord.create('Eval plan', [designCid], { at: '51.5,-0.1,17', mode: '2d' });
        const planCid = cidOfObject(planContent);
        const plan = { cid: planCid, plan: planContent, designs: [{ cid: designCid, untrusted: { content: design } }] };
        expect(canonicalPlanSnapshot({ structuredContent: plan })).toMatchObject({ cid: planCid, plan: planContent, designs: [{ cid: designCid, designHash: designCid }] });
        const calls = [], mcp = { callTool: async (name, args) => { calls.push([name, args]); return { structuredContent: plan }; } };
        expect(await readCanonicalPlan(mcp, 'https://localhost/private-draft')).toMatchObject({ cid: planCid, plan: planContent });
        expect(calls).toEqual([['ugt_get_plan', { plan: 'https://localhost/private-draft' }]]);
        expect(() => canonicalPlanSnapshot({ structuredContent: { cid: planCid, designs: plan.designs } })).toThrow(/exact plan\/v1 content/);
        expect(() => canonicalPlanSnapshot({ structuredContent: { ...plan, cid: 'bad' } })).toThrow(/CID does not match/);
        expect(() => canonicalPlanSnapshot({ structuredContent: { ...plan,
            designs: [{ cid: 'bad', untrusted: { content: design } }] } })).toThrow(/ordered canonical plan designCids/);
        const wrongMembers = PlanRecord.create('Eval plan', [cidOfObject({ schema: 'design/v1', goal: 'square' })], { at: '51.5,-0.1,17', mode: '2d' });
        expect(() => canonicalPlanSnapshot({ structuredContent: { cid: cidOfObject(wrongMembers), plan: wrongMembers, designs: plan.designs } }))
            .toThrow(/ordered canonical plan designCids/);
        const secondDesign = { schema: 'design/v1', goal: 'square' }, secondCid = cidOfObject(secondDesign);
        const orderedPlan = PlanRecord.create('Two designs', [designCid, secondCid], { at: '51.5,-0.1,17', mode: '2d' });
        expect(() => canonicalPlanSnapshot({ structuredContent: { cid: cidOfObject(orderedPlan), plan: orderedPlan,
            designs: [{ cid: secondCid, untrusted: { content: secondDesign } }, { cid: designCid, untrusted: { content: design } }] } }))
            .toThrow(/ordered canonical plan designCids/);
        const invalidPlan = { ...planContent, title: ' ' };
        expect(() => canonicalPlanSnapshot({ structuredContent: { cid: cidOfObject(invalidPlan), plan: invalidPlan, designs: plan.designs } }))
            .toThrow(/invalid canonical content/);
    });
    it('retains failed or interrupted attempts and returns failure exit status until every selected case passes', () => {
        const failed = { status: 'failed', calls: [{ tool: 'ugt_edit_plan' }], turnScores: [{ score: { passed: false } }] };
        expect(retryAttemptsOf(failed)).toHaveLength(1);
        const interrupted = { status: 'running', attempts: [{ status: 'failed' }], currentAttempt: { calls: [{ tool: 'ugt_modify_design' }] } };
        expect(retryAttemptsOf(interrupted)).toEqual([{ status: 'failed' }, { status: 'incomplete', calls: [{ tool: 'ugt_modify_design' }] }]);
        const checkpoint = { cases: { a: { status: 'failed' }, b: { status: 'passed' } }, spentUsd: 0.25 };
        expect(evalExitCode(checkpoint, [{ id: 'a' }, { id: 'b' }])).toBe(1);
        expect(evalExitCode(checkpoint, [{ id: 'b' }])).toBe(0);
    });
    it('records seed setup failures without discarding earlier attempts', () => {
        const checkpoint = { spentUsd: 0.2, cases: {} }, attempts = [{ status: 'failed', calls: [{ tool: 'old-call' }] }];
        recordFailedAttempt(checkpoint, 'next', attempts, { seedCalls: [{ tool: 'ugt_draft_track', isError: true }], calls: [], turnScores: [] }, new Error('seed failed'));
        expect(checkpoint.cases.next).toMatchObject({ status: 'failed', attempts: [{ status: 'failed' }, { status: 'failed', seedCalls: [{ tool: 'ugt_draft_track', isError: true }], failure: { message: 'seed failed' } }] });
        expect(checkpoint.spentUsd).toBe(0.2);
    });
});
