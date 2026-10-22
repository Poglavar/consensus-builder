// Evaluation scoring checks returned artifact content; model prose cannot turn a failed task green.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { buildEvalTasks } from '../agents/mcp-eval-tasks.js';
import { scoreArtifact } from '../scripts/mcp-eval.mjs';
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
        expect(scoreArtifact({ expected: { ...task.expected, drivingLanes: 4 } }, [artifact]).passed).toBe(false);
        expect(scoreArtifact(task, [{ ...artifact, cid: 'invented' }])).toEqual({ passed: false, reason: 'cid-mismatch' });
        expect(scoreArtifact(task, [{ message: 'I made a road.' }]).passed).toBe(false);
    });
    it('scores the actual approval target, amount and side', () => {
        const task = { expected: { action: 'bet', target: 'account', amount: '0.05', side: 'yes' } };
        expect(scoreArtifact(task, [{ approvalUrl: 'https://app.example/bets/account?act=bet&amount=0.05&side=yes' }]).passed).toBe(true);
        expect(scoreArtifact(task, [{ approvalUrl: 'https://app.example/bets/account?act=bet&amount=5&side=yes' }]).passed).toBe(false);
    });
});
