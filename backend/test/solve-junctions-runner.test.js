// How the bulk runner classifies a junction's outcome.
//
// This exists because of a real miscount: the read-back that fetches "295 connections, 19 problems"
// for the progress line threw a transient `fetch failed`, the exception escaped solveJunction, the
// caller's catch built a `status: failed` record, and a junction whose answer had already been
// computed, stored and paid for was reported as lost. Job 62 / solution 139, 192 connections, run
// summary "1 failed". The cost of getting this wrong is someone re-running work that is already in
// the database — or, worse, believing the area is less complete than it is.
import { afterEach, describe, expect, it } from 'vitest';
import { setApiImpl, solveJunction, withRetry } from '../scripts/solve-junctions.js';

const ARGS = {
    city: 'zagreb', provider: 'codex', model: 'gpt-5.6-sol',
    imagery: null, pollMs: 1, jobTimeoutMs: 5000
};
const JUNCTION = { key: 'junction:1+2', name: 'Miramarska × Vukovara', armCount: 21 };
const BBOX = [15.973, 45.797, 15.976, 45.800];

// A server that answers the whole conversation: enqueue, poll, read back.
function fakeApi({ readBack }) {
    const calls = [];
    setApiImpl(async (base, path) => {
        calls.push(path);
        if (path === '/lane-topology/process') {
            return { job: { id: 62 } };
        }
        if (path.startsWith('/lane-topology/jobs/')) {
            return {
                job: {
                    id: 62, status: 'completed', resultSolutionId: 139,
                    usage: { outputTokens: 15090, inputTokens: 132662 }
                }
            };
        }
        if (path.startsWith('/lane-topology/solutions/')) return readBack(calls);
        throw new Error(`unexpected path ${path}`);
    });
    return calls;
}

afterEach(() => setApiImpl(null));

describe('a junction whose summary cannot be read', () => {
    it('is still solved, and says which solution holds the answer', async () => {
        fakeApi({ readBack: () => { throw new Error('fetch failed'); } });

        const record = await solveJunction('http://api', ARGS, JUNCTION, BBOX);

        // The outcome of the WORK, not of the summary fetch.
        expect(record.status).toBe('completed');
        expect(record.solutionId).toBe(139);
        expect(record.error).toBeNull();
        // And the miss is stated rather than passed off as a junction that produced nothing.
        expect(record.statsError).toContain('fetch failed');
        expect(record.stats).toBeUndefined();
    });

    it('retries the read before giving up on it', async () => {
        let attempts = 0;
        fakeApi({
            readBack: () => {
                attempts += 1;
                if (attempts < 3) throw new Error('fetch failed');
                return { solution: { stats: { connections: 192, problems: 8, errors: 0 } } };
            }
        });

        const record = await solveJunction('http://api', ARGS, JUNCTION, BBOX);

        expect(attempts).toBe(3);
        expect(record.statsError).toBeUndefined();
        expect(record.stats).toEqual({ connections: 192, problems: 8, errors: 0 });
    });

    it('reports the counts normally when the read works first time', async () => {
        fakeApi({ readBack: () => ({ solution: { stats: { connections: 192, problems: 8, errors: 1 } } }) });

        const record = await solveJunction('http://api', ARGS, JUNCTION, BBOX);

        expect(record.status).toBe('completed');
        expect(record.stats).toEqual({ connections: 192, problems: 8, errors: 1 });
        expect(record.statsError).toBeUndefined();
    });

    it('still fails a junction whose JOB failed, which is a different thing entirely', async () => {
        setApiImpl(async (base, path) => {
            if (path === '/lane-topology/process') return { job: { id: 70 } };
            if (path.startsWith('/lane-topology/jobs/')) {
                return { job: { id: 70, status: 'failed', error: 'model refused', resultSolutionId: null } };
            }
            throw new Error(`unexpected path ${path}`);
        });

        const record = await solveJunction('http://api', ARGS, JUNCTION, BBOX);

        expect(record.status).toBe('failed');
        expect(record.error).toBe('model refused');
        expect(record.solutionId).toBeNull();
    });
});

describe('withRetry', () => {
    it('gives the caller the last error when every attempt fails', async () => {
        let attempts = 0;
        await expect(withRetry(async () => {
            attempts += 1;
            throw new Error(`attempt ${attempts}`);
        }, { pollMs: 1 })).rejects.toThrow('attempt 3');
        expect(attempts).toBe(3);
    });

    it('does not retry something that worked', async () => {
        let attempts = 0;
        const value = await withRetry(async () => { attempts += 1; return 'ok'; }, { pollMs: 1 });

        expect(value).toBe('ok');
        expect(attempts).toBe(1);
    });
});
