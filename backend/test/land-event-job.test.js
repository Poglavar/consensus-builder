// The land-event job body (oracle/land-event-job.js) behind oracle/agreement-lifecycle-job.mjs: the RPC is
// checked to be the cluster before the agreement lifecycle pass runs, a failed check or pass fails the run
// without a result, and the per-agreement problems a finished pass reports (accounts that are not the
// agreement's, terminal accounts without their transaction, agreements whose step threw) poison the
// verdict. The pass is a stub here except where the real chain reader proves the ordering.
import { describe, expect, it } from 'vitest';
import { createMockPool } from './helpers/mock-pool.js';
import { createAgreementChain } from '../agreements/onchain.js';
import { landEventProblem, runLandEventJob } from '../oracle/land-event-job.js';

const CLEAN = Object.freeze({
    scanned: 3, reconciled: 3, moved: 1, terminal: 1, events: [{ id: 'e1' }, { id: 'e2' }], inserted: 2,
    invalidAccounts: [], missingEvidence: [], failed: [], dryRun: false
});

function harness({ connection = async () => ({}), result = CLEAN, throws = null } = {}) {
    const calls = [];
    const lines = [];
    return {
        calls,
        lines,
        options: {
            pool: { query: async () => ({ rows: [] }) },
            chain: { cluster: 'devnet', connection: async () => { calls.push('network'); return connection(); } },
            log: line => lines.push(line),
            sync: async options => {
                calls.push('sync');
                if (throws) throw new Error(throws);
                return { ...result, dryRun: !options.apply, received: options };
            }
        }
    };
}

describe('runLandEventJob', () => {
    it('checks the network, then runs one pass with the options it was given', async () => {
        const h = harness();
        const now = () => 1;
        const job = await runLandEventJob({ ...h.options, apply: true, now });
        expect(h.calls).toEqual(['network', 'sync']);
        expect(job).toMatchObject({ exitCode: 0, error: null, result: { inserted: 2, dryRun: false } });
        expect(job.result.received).toMatchObject({ pool: h.options.pool, chain: h.options.chain, apply: true, now });
        expect(h.lines.at(-1)).toBe('pass done: scanned 3 · onchain written 3 · moved 1 · terminal 1 · events 2 · inserted 2 · invalid 0 · missing evidence 0 · failed 0');
    });

    it('says a dry run wrote nothing', async () => {
        const h = harness();
        const job = await runLandEventJob(h.options);
        expect(job.result.dryRun).toBe(true);
        expect(h.lines.at(-1)).toMatch(/\(dry run, nothing written\)$/);
    });

    it('fails without a result, and without a pass, when the RPC is not the cluster', async () => {
        const h = harness({ connection: async () => { throw Object.assign(new Error('the RPC for devnet answers genesis X'), { code: 'rpc-wrong-cluster' }); } });
        const job = await runLandEventJob(h.options);
        expect(h.calls).toEqual(['network']);
        expect(job).toMatchObject({ result: null, exitCode: 1, error: { code: 'rpc-wrong-cluster' } });
        expect(h.lines).toEqual(['network check failed: the RPC for devnet answers genesis X']);
    });

    it('checks the genesis of the real chain reader before the pass touches the index', async () => {
        const pool = createMockPool();
        const chain = createAgreementChain({ connection: { getGenesisHash: async () => 'another-cluster' } });
        const lines = [];
        const job = await runLandEventJob({ pool, chain, apply: true, log: line => lines.push(line) });
        expect(job.exitCode).toBe(1);
        expect(job.error.code).toBe('rpc-wrong-cluster');
        expect(pool.getCalls()).toEqual([]);
    });

    it('fails without a result when the pass throws', async () => {
        const h = harness({ throws: 'database down' });
        const job = await runLandEventJob(h.options);
        expect(job).toMatchObject({ result: null, exitCode: 1, error: { message: 'database down' } });
        expect(h.lines.at(-1)).toMatch(/^agreement lifecycle pass failed: Error: database down/);
    });

    it('fails the run on per-agreement problems, keeping the result', async () => {
        const failed = [1, 2, 3, 4].map(n => ({ cid: `cid-${n}`, error: `boom ${n}` }));
        const h = harness({ result: { ...CLEAN, invalidAccounts: [{ cid: 'x' }], missingEvidence: ['acc-1', 'acc-2'], failed } });
        const job = await runLandEventJob(h.options);
        expect(job.exitCode).toBe(1);
        expect(job.result.failed).toHaveLength(4);
        expect(job.error.message).toBe('1 agreement account(s) missing or not the agreement\'s; 2 terminal agreement(s) lack their transaction; '
            + '4 agreement(s) failed: cid-1 (boom 1), cid-2 (boom 2), cid-3 (boom 3)');
    });
});

describe('landEventProblem', () => {
    it('is null for a clean pass and names each kind of problem alone', () => {
        expect(landEventProblem(CLEAN)).toBeNull();
        expect(landEventProblem({ ...CLEAN, invalidAccounts: [{}] })).toBe('1 agreement account(s) missing or not the agreement\'s');
        expect(landEventProblem({ ...CLEAN, missingEvidence: ['a'] })).toBe('1 terminal agreement(s) lack their transaction');
        expect(landEventProblem({ ...CLEAN, failed: [{ cid: 'c', error: 'e' }] })).toBe('1 agreement(s) failed: c (e)');
    });
});
