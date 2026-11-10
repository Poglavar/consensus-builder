import { describe, expect, it } from 'vitest';
import { createMockPool } from './helpers/mock-pool.js';
import { markAgentRunFailed, markAgentRunFundingShort, safeFailureDiagnostic } from '../agents/run-failure.js';
import { FundingSourceShortError, isFundingSourceShort } from '../agents/funding.js';

describe('agent run failure checkpoint', () => {
    it('redacts third-party paths, query strings and bearer tokens while retaining a bounded diagnostic', () => {
        expect(safeFailureDiagnostic(new Error('fetch https://rpc.example/rpc?token=secret failed with Bearer abc123')))
            .toBe('fetch rpc.example/[path redacted] failed with Bearer [redacted]');
        // RPC providers put the API key in the path itself.
        expect(safeFailureDiagnostic('POST https://solana-devnet.g.alchemy.com/v2/AbCdEf0123456789AbCdEf0123456789 failed'))
            .toBe('POST solana-devnet.g.alchemy.com/[path redacted] failed');
        expect(safeFailureDiagnostic('https://user:pw@rpc.example?api-key=secret')).toBe('rpc.example');
        expect(safeFailureDiagnostic('x'.repeat(300))).toHaveLength(240);
    });

    it('keeps our own API path, without its query, so an alert says which endpoint failed', () => {
        expect(safeFailureDiagnostic(new Error('https://api.urbangametheory.xyz/parcel-sources/es-dgc-inspire-cp-wfs?bbox=-3.7,40.41,-3.69,40.42 returned HTTP 502')))
            .toBe('api.urbangametheory.xyz/parcel-sources/es-dgc-inspire-cp-wfs returned HTTP 502');
        expect(safeFailureDiagnostic('http://localhost:3000/agent/lenses?x=1 refused')).toBe('localhost:3000/agent/lenses refused');
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
        expect(JSON.parse(call.params[3])).toEqual({ role: 'supporter', outcome: 'failed', error: 'request to rpc.test timed out' });
    });

    it('ends a run whose shared funding wallet is short as done/funding-short, naming the wallet and asset', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [{ run_id: 'run-1' }], rowCount: 1 });
        const error = new FundingSourceShortError('USDC funding wallet W cannot top up R while retaining 1 test USDC', { sourceWallet: 'W', asset: 'USDC' });
        expect(isFundingSourceShort(error)).toBe(true);
        expect(isFundingSourceShort(new Error('USDC funding wallet W cannot top up R'))).toBe(false);
        await markAgentRunFundingShort(pool, 'run-1', error, { summaryPatch: { role: 'supporter' } });
        const call = pool.getCalls().at(-1);
        expect(call.params[2]).toBe('done');
        // updateRun nulls `error` on a done run, so the message travels in fundingShort.
        expect(JSON.parse(call.params[3])).toEqual({ role: 'supporter', outcome: 'funding-short', error: null,
            fundingShort: { sourceWallet: 'W', asset: 'USDC', message: 'USDC funding wallet W cannot top up R while retaining 1 test USDC' } });
    });
});
