import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBudget, assertEvalTurnCanContinue, callEstimateUsd, checkpointFingerprint, contextForEvalCase, parseArgs, planFromSeed, pricesOf, refreshSelectionFromPlan, resolveSeededSelection, writeCheckpoint } from '../scripts/chat-eval.mjs';
import { costUsd, estimateTurnUsd, pricesFromEnv } from '../chat/cost.js';
import { createAnthropicModelCaller, MAX_CHAT_INPUT_TOKENS } from '../chat/model.js';
import { cidOfObject } from '../cid.js';

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
        const cases = [{ id: 'one' }], config = { model: 'haiku', mcp: 'http://localhost:3098/mcp', prices };
        expect(checkpointFingerprint(cases, config)).toBe(checkpointFingerprint(cases, config));
        expect(checkpointFingerprint(cases, { ...config, model: 'sonnet' })).not.toBe(checkpointFingerprint(cases, config));
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
        const client = { messages: { countTokens: async () => ({ input_tokens: MAX_CHAT_INPUT_TOKENS + 1 }), create: async () => { throw new Error('must not call'); } } };
        const callModel = createAnthropicModelCaller({ client, model: 'test' });
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
    it('re-resolves member selection against the latest plan CID each turn', async () => {
        const designA = { schema: 'design/v1', title: 'A' }, designB = { schema: 'design/v1', title: 'B' };
        const mcp = { callTool: async (_tool, { plan }) => ({ structuredContent: { designs: [{ cid: cidOfObject(plan === 'draft-1' ? designA : designB), untrusted: { content: plan === 'draft-1' ? designA : designB } }] } }) };
        expect(await refreshSelectionFromPlan(mcp, { memberIndex: 0 }, { draftRef: 'draft-1' })).toEqual({ designCid: cidOfObject(designA) });
        expect(await refreshSelectionFromPlan(mcp, { memberIndex: 0 }, { draftRef: 'draft-2' })).toEqual({ designCid: cidOfObject(designB) });
    });
    it('uses the case language over any stale language in its context', () => {
        expect(contextForEvalCase({ language: 'hr', context: { language: 'en', city: 'london' } })).toEqual({ language: 'hr', city: 'london' });
    });
    it('stops after uncertain paid calls and budget exhaustion before another turn is recorded', () => {
        const checkpoint = { inflight: { case: 'case-a' } };
        expect(() => assertEvalTurnCanContinue({ outcome: { type: 'error' } }, checkpoint)).toThrow(/uncertain paid call/);
        checkpoint.inflight = null;
        expect(() => assertEvalTurnCanContinue({ outcome: { code: 'eval-budget-exhausted' } }, checkpoint)).toThrowError(expect.objectContaining({ code: 'eval-budget-exhausted' }));
        expect(() => assertEvalTurnCanContinue({ outcome: { type: 'reply' } }, checkpoint)).not.toThrow();
    });
});
