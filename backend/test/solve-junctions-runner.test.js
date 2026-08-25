// How the bulk runner classifies a junction's outcome.
//
// This exists because of a real miscount: the read-back that fetches "295 connections, 19 problems"
// for the progress line threw a transient `fetch failed`, the exception escaped solveJunction, the
// caller's catch built a `status: failed` record, and a junction whose answer had already been
// computed, stored and paid for was reported as lost. Job 62 / solution 139, 192 connections, run
// summary "1 failed". The cost of getting this wrong is someone re-running work that is already in
// the database — or, worse, believing the area is less complete than it is.
import { afterEach, describe, expect, it } from 'vitest';
import { classifyJunctions, jobTimeoutFor, manualReviewKeys, setApiImpl, solveJunction, withRetry } from '../scripts/solve-junctions.js';
import { PROVIDER_TIMEOUT_MS } from '../lane-topology/cli-providers.js';

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

// Which junctions a run will actually pay for. Every branch here has been a real miscount.
describe('classifyJunctions', () => {
    const junction = (id, extra = {}) => ({
        key: `junction:${id}`, name: `J${id}`, laneCount: 4, resolved: false,
        unresolvedNodeIds: [`osm-node:${id}`], ...extra
    });

    it('leaves a junction nothing has answered as work', () => {
        const { open, deterministic, adjudicated } = classifyJunctions([junction(1)], {});
        expect(open.map(j => j.key)).toEqual(['junction:1']);
        expect(deterministic).toEqual([]);
        expect(adjudicated).toEqual([]);
    });

    it('does not pay a model to re-derive what the rules already settle', () => {
        const { open, deterministic } = classifyJunctions([junction(1, { resolved: true })], {});
        expect(open).toEqual([]);
        expect(deterministic.map(j => j.key)).toEqual(['junction:1']);
    });

    // The bug this was written for: a Claude sweep re-asking what Codex had already answered,
    // because resume keys on (junction, bbox, provider, model) and nothing consulted the store.
    it('skips a junction another provider has already answered', () => {
        const { open, adjudicated } = classifyJunctions([junction(1)], {
            settledNodes: new Set(['osm-node:1'])
        });
        expect(open).toEqual([]);
        expect(adjudicated.map(j => j.key)).toEqual(['junction:1']);
    });

    it('keeps a junction whose stored answer settled only some of its nodes', () => {
        const partly = junction(1, { unresolvedNodeIds: ['osm-node:1', 'osm-node:2'] });
        const { open, adjudicated } = classifyJunctions([partly], {
            settledNodes: new Set(['osm-node:1'])
        });
        expect(open.map(j => j.key)).toEqual(['junction:1']);
        expect(adjudicated).toEqual([]);
    });

    // `[].every(...)` is true, so an empty list would silently classify as fully answered.
    it('does not treat a junction with no named open nodes as answered', () => {
        const nameless = junction(1, { unresolvedNodeIds: [] });
        const { open, adjudicated } = classifyJunctions([nameless], {
            settledNodes: new Set(['osm-node:1'])
        });
        expect(open.map(j => j.key)).toEqual(['junction:1']);
        expect(adjudicated).toEqual([]);
    });

    it('sets the cost guard aside as skipped rather than dropping it', () => {
        const big = junction(1, { laneCount: 40 });
        const { open, oversized } = classifyJunctions([big], { maxLanes: 20 });
        expect(open).toEqual([]);
        expect(oversized.map(j => j.key)).toEqual(['junction:1']);
    });

    it('makes everything work again under --include-resolved', () => {
        const done = junction(1, { resolved: true });
        const { open } = classifyJunctions([done], {
            includeResolved: true, settledNodes: new Set(['osm-node:1'])
        });
        expect(open.map(j => j.key)).toEqual(['junction:1']);
    });
});

// The runner watches a job the backend is running, so its patience has to outlast the ceiling the
// backend puts on the CLI. An 18-minute runner over a 15-minute provider looked fine until the
// provider ceiling was raised for Opus and the runner became the shorter of the two — at which
// point it would give up on work still allowed to finish and report it failed. "Job 377 still
// running after 1080s" is what that reads like.
describe('jobTimeoutFor', () => {
    it('waits longer than the provider is allowed to take, for every provider', () => {
        Object.entries(PROVIDER_TIMEOUT_MS).forEach(([provider, ceiling]) => {
            expect(jobTimeoutFor(provider, PROVIDER_TIMEOUT_MS),
                `${provider} runner patience`).toBeGreaterThan(ceiling);
        });
    });

    it('tracks a ceiling that changes, instead of holding a number of its own', () => {
        expect(jobTimeoutFor('claude', { claude: 25 * 60 * 1000 }))
            .toBeGreaterThan(jobTimeoutFor('codex', { codex: 15 * 60 * 1000 }));
    });

    it('still gives an unknown provider a sane wait', () => {
        expect(jobTimeoutFor('nobody', PROVIDER_TIMEOUT_MS)).toBeGreaterThan(15 * 60 * 1000);
    });
});

// Some junctions are not model work. One failed four times across two providers on three unrelated
// causes — a reset socket, then the 15-minute ceiling, then the 25-minute one at 1507 s — so each
// further attempt spends a full provider ceiling to learn nothing. Retrying a reproducible failure
// is the thing we keep saying not to do, and a note in a summary does not stop the next batch.
describe('junctions that must be looked at by a person', () => {
    const junction = (key, extra = {}) => ({
        key, name: key, laneCount: 4, resolved: false, unresolvedNodeIds: [`${key}:n`], ...extra
    });

    it('keeps a listed junction out of the work', () => {
        const { open, needsPerson } = classifyJunctions([junction('a'), junction('b')], {
            manualReview: new Set(['a'])
        });
        expect(needsPerson.map(j => j.key)).toEqual(['a']);
        expect(open.map(j => j.key)).toEqual(['b']);
    });

    // It is still open work — it is just not work a model does. Counting it settled would hide it.
    it('does not pretend a listed junction is settled', () => {
        const { deterministic, adjudicated } = classifyJunctions([junction('a')], {
            manualReview: new Set(['a'])
        });
        expect(deterministic).toEqual([]);
        expect(adjudicated).toEqual([]);
    });

    it('accepts a plain array as well as a Set', () => {
        const { needsPerson } = classifyJunctions([junction('a')], { manualReview: ['a'] });
        expect(needsPerson).toHaveLength(1);
    });

    it('sends everything to the model when the list is empty', () => {
        const { open, needsPerson } = classifyJunctions([junction('a')], {});
        expect(needsPerson).toEqual([]);
        expect(open).toHaveLength(1);
    });

    it('reads the shipped list, and every entry says why it is there', async () => {
        const keys = manualReviewKeys();
        expect(keys.size).toBeGreaterThan(0);
        const listed = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(
            new URL('../lane-topology/manual-review.json', import.meta.url), 'utf8')));
        listed.junctions.forEach(entry => {
            expect(entry.key, 'every entry needs a stable junction key').toMatch(/^junction:/);
            expect(entry.why, `${entry.key} must say why a person has to look at it`)
                .toBeTruthy();
            expect(entry.since, `${entry.key} must say when it was parked`).toBeTruthy();
        });
    });

    it('treats a missing list as empty rather than failing a batch over it', () => {
        expect(manualReviewKeys('/nonexistent/manual-review.json').size).toBe(0);
    });
});
