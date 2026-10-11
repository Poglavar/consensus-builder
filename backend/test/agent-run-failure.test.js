import { describe, expect, it } from 'vitest';
import { createMockPool } from './helpers/mock-pool.js';
import { markAgentRunFailed, safeFailureDiagnostic } from '../agents/run-failure.js';

describe('agent run failure checkpoint', () => {
    it('redacts endpoint URLs and bearer tokens while retaining a bounded diagnostic', () => {
        expect(safeFailureDiagnostic(new Error('fetch https://rpc.example/rpc?token=secret failed with Bearer abc123')))
            .toBe('fetch [redacted URL] failed with Bearer [redacted]');
        expect(safeFailureDiagnostic('x'.repeat(300))).toHaveLength(240);
    });

    it('writes a terminal failed status and safe diagnostic to the run summary', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [{ run_id: '2026-10-11-h09-supporter-01' }], rowCount: 1 });
        await markAgentRunFailed(pool, '2026-10-11-h09-supporter-01', new Error('request to https://rpc.test/?key=secret timed out'), {
            summaryPatch: { role: 'supporter' }
        });
        const call = pool.getCalls().at(-1);
        expect(call.sql.replace(/\s+/g, ' ')).toContain('status = COALESCE($3, status)');
        expect(call.params[0]).toBe('2026-10-11-h09-supporter-01');
        expect(call.params[2]).toBe('failed');
        expect(JSON.parse(call.params[3])).toEqual({ role: 'supporter', outcome: 'failed', error: 'request to [redacted URL] timed out' });
    });
});
