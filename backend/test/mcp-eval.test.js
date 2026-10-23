// Evaluation scoring checks returned artifact content; model prose cannot turn a failed task green.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as turf from '@turf/turf';
import { buildEvalTasks } from '../agents/mcp-eval-tasks.js';
import { scoreArtifact, scoreConversation, runEval } from '../scripts/mcp-eval.mjs';
import { createMcpHttpService } from '../agents/mcp-http.mjs';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
describe('MCP agent evaluation artifacts', () => {
    it('creates twenty concrete tasks from a source fixture and an optional bet task', () => {
        const seed = { city: 'london', parcelSourceId: 'test', parcelIds: ['A'], streetPoints: [[0, 0], [0.001, 0]] };
        expect(buildEvalTasks(seed)).toHaveLength(20);
        expect(buildEvalTasks({ ...seed, agreementAccount: '11111111111111111111111111111111' })).toHaveLength(21);
    });
    it('rejects invented CIDs, wrong lane counts and narrative-only claims', () => {
        const design = builder.build({ kind: 'road', city: 'london', points: [[0, 0], [0.001, 0]], preset: '1+1' }, { turf });
        const artifact = { untrusted: { design }, cid: cidOfObject(design), takes: ['A'], previewUrl: 'https://app.example/designs#draft=fixture' };
        const task = { expected: { goal: 'road-track', drivingLanes: 2, cycleLanes: 0 } };
        expect(scoreArtifact(task, [artifact]).passed).toBe(true);
        expect(scoreArtifact(task, [{ ...artifact, previewUrl: `https://app.example/mcp/previews/${'a'.repeat(32)}`, previewStatus: 'private-link' }]).passed).toBe(true);
        expect(scoreArtifact({ expected: { ...task.expected, drivingLanes: 4 } }, [artifact]).passed).toBe(false);
        expect(scoreArtifact(task, [{ ...artifact, cid: 'invented' }])).toEqual({ passed: false, reason: 'cid-mismatch' });
        expect(scoreArtifact(task, [{ message: 'I made a road.' }]).passed).toBe(false);
        const record = { artifacts: [artifact], messages: [{ role: 'assistant', content: [{ type: 'text', text: artifact.previewUrl + 'corrupted' }] }] };
        expect(scoreConversation(task, record)).toEqual({ passed: false, reason: 'preview-link-not-delivered' });
        record.messages[0].content[0].text = artifact.previewUrl.replace('fixture', 'changed');
        expect(scoreConversation(task, record)).toEqual({ passed: false, reason: 'preview-link-not-delivered' });
        record.messages[0].content[0].text = artifact.previewUrl;
        expect(scoreConversation(task, record).passed).toBe(true);
    });
    it('scores the actual approval target, amount and side', () => {
        const task = { expected: { action: 'bet', target: 'account', amount: '0.05', side: 'yes' } };
        expect(scoreArtifact(task, [{ approvalUrl: 'https://app.example/bets/account?act=bet&amount=0.05&side=yes' }]).passed).toBe(true);
        expect(scoreArtifact(task, [{ approvalUrl: 'https://app.example/bets/account?act=bet&amount=5&side=yes' }]).passed).toBe(false);
    });
});

describe('paid evaluation orchestration without a paid API', () => {
    async function fixture() {
        const args = { city: 'london', points: [[0, 0], [0.001, 0]], preset: '1+1' };
        const design = builder.build({ ...args, kind: 'road' }, { turf });
        const service = createMcpHttpService({ env: {}, factory: () => createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {}, tools: {
            draftRoad: () => ({ design, cid: cidOfObject(design), takes: ['A'], previewUrl: 'https://app.example/designs#draft=fixture' })
        } }) });
        service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
        const requests = [];
        const anthropic = { messages: { batches: {
            create: vi.fn(async request => { requests.push(request); return { id: `batch-${requests.length}` }; }),
            retrieve: vi.fn(async () => ({ processing_status: 'ended' })),
            async *results(id) { yield { result: { type: 'succeeded', message: { model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 50 },
                content: id === 'batch-1' ? [{ type: 'tool_use', id: 'draft-1', name: 'ugt_draft_road', input: args }]
                    : [{ type: 'text', text: 'The returned preview is ready: https://app.example/designs#draft=fixture' }] } } }; }
        } } };
        const options = { origin: `http://127.0.0.1:${service.http.address().port}`, model: 'fixture-model', budgetUsd: 1,
            inputUsdPerMillion: 1, outputUsdPerMillion: 5, output: join(mkdtempSync(join(tmpdir(), 'ugt-mcp-eval-')), 'checkpoint.json'),
            tasks: [{ id: 'street', request: 'Draft a road.', expected: { goal: 'road-track', drivingLanes: 2 } }], anthropic, recordUsage: vi.fn() };
        return { service, options, requests, args };
    }
    it('records two rounds, excludes publication, scores the actual draft and resumes without another submission', async () => {
        const { service, options, requests } = await fixture();
        try {
            const state = await runEval(options);
            expect(state.tasks[0].score.passed).toBe(true);
            expect(state.spentUsd).toBeCloseTo(0.0007);
            expect(options.recordUsage).toHaveBeenCalledTimes(2);
            expect(requests[0].requests[0].params.tools.some(t => /publish|propose_agreement/.test(t.name))).toBe(false);
            expect((await runEval(options)).spentUsd).toBeCloseTo(state.spentUsd);
            expect(options.anthropic.messages.batches.create).toHaveBeenCalledTimes(2);
        } finally { await service.close(); }
    });
    it('refuses a request whose reserved cost exceeds the cap before submitting anything', async () => {
        const { service, options } = await fixture();
        try {
            await expect(runEval({ ...options, budgetUsd: 0.00001 })).rejects.toThrow(/Budget exhausted/);
            expect(options.anthropic.messages.batches.create).not.toHaveBeenCalled();
        } finally { await service.close(); }
    });
    it('does not submit again after an uncertain submission outcome', async () => {
        const { service, options } = await fixture();
        options.anthropic.messages.batches.create.mockRejectedValue(new Error('Connection lost after submission'));
        try {
            await expect(runEval(options)).rejects.toThrow(/Connection lost/);
            await expect(runEval(options)).rejects.toThrow(/outcome is uncertain/);
            expect(options.anthropic.messages.batches.create).toHaveBeenCalledTimes(1);
        } finally { await service.close(); }
    });
    it('continues the same failed task with its accumulated spend and remaining round budget', async () => {
        const { service, options, args } = await fixture();
        options.anthropic.messages.batches.results = async function * (id) {
            yield { result: { type: 'succeeded', message: { model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 50 },
                content: id === 'batch-2' ? [{ type: 'tool_use', id: 'retry-draft', name: 'ugt_draft_road', input: args }]
                    : [{ type: 'text', text: id === 'batch-1' ? 'The server was unavailable.' : 'The draft is ready: https://app.example/designs#draft=fixture' }] } } };
        };
        try {
            expect((await runEval(options)).tasks[0].score.passed).toBe(false);
            const result = await runEval({ ...options, retryFailed: true });
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0].score.passed).toBe(true);
            expect(result.tasks[0].rounds).toHaveLength(3);
            expect(result.spentUsd).toBeCloseTo(0.00105);
        } finally { await service.close(); }
    });
});
