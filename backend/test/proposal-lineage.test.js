// GET /proposals/:id/lineage resolves only a publication reference in this API store.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({ generateAndStoreProposalThumbnail: vi.fn(async () => null) }));

const API_A = 'https://api-a.example.test';
const API_B = 'https://api-b.example.test';
function app(results) {
    const pool = createMockPool();
    pool.setResults(results);
    return { pool, app: createTestApp(pool) };
}

async function getLineage(server, id) {
    const layer = server._router.stack.find(item => item.route?.path === '/proposals/:id/lineage');
    const handler = layer.route.stack.find(item => item.method === 'get').handle;
    let status = 200;
    let body;
    const response = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    await handler({ params: { id } }, response);
    return { status, body };
}

afterEach(() => vi.unstubAllEnvs());

describe('GET /proposals/:id/lineage', () => {
    it('resolves a same-store published source and lists typed derived references', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', API_A);
        const { pool, app: server } = app([
            { rows: [{ id: 879, proposal_id: 'c2-orig', proposal_origin: { relation: 'revision', source: { kind: 'publication', apiBase: API_A, proposalRowId: '700' }, title: 'Older plan' } }] },
            { rows: [{ id: 700, proposal_id: 'c2-older', title: 'Older plan', name: null, effective_status: 'Active' }] },
            { rows: [
                { id: 901, proposal_id: 'c2-fork-b', title: 'Counter B', name: null, author: 'Owner C', created_at: '2026-10-16T10:00:00Z', effective_status: 'Active', land_fork: false },
                { id: 900, proposal_id: 'c2-fork-a', title: null, name: 'Counter A', author: null, created_at: '2026-10-15T10:00:00Z', effective_status: 'Active', land_fork: true }
            ] }
        ]);
        const res = await getLineage(server, '879');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ proposalRowId: 879, authoredProposalId: 'c2-orig', publicationApiBase: API_A });
        expect(res.body.source).toEqual({ resolution: 'resolved', reference: { kind: 'publication', apiBase: API_A, proposalRowId: '700' }, proposalRowId: 700, publicationApiBase: API_A, authoredProposalId: 'c2-older', title: 'Older plan', status: 'Active' });
        expect(res.body.derived.map(d => [d.proposalRowId, d.publicationApiBase, d.authoredProposalId, d.title, d.landFork])).toEqual([
            [901, API_A, 'c2-fork-b', 'Counter B', false], [900, API_A, 'c2-fork-a', 'Counter A', true]
        ]);
        expect(pool.getCalls().map(call => call.params)).toEqual([['879'], ['700'], [API_A, 879, '879']]);
        expect(pool.getCalls()[2].sql).toMatch(/proposalOrigin/);
        expect(pool.getCalls()[2].sql).toMatch(/'apiBase' = \$1/);
        expect(pool.getCalls()[2].sql).toMatch(/'proposalRowId' = \$3/);
    });

    it('marks another publication store external and does not query its row', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', API_A);
        const { pool, app: server } = app([
            { rows: [{ id: 879, proposal_id: 'c2-orig', proposal_origin: { relation: 'copy', source: { kind: 'publication', apiBase: API_B, proposalRowId: '700' }, title: 'Remote plan' } }] },
            { rows: [] }
        ]);
        const res = await getLineage(server, '879');
        expect(res.body.source).toEqual({ resolution: 'external', reference: { kind: 'publication', apiBase: API_B, proposalRowId: '700' }, title: 'Remote plan' });
        expect(pool.getCalls()).toHaveLength(2);
        expect(pool.getCalls()[1].params).toEqual([API_A, 879, '879']);
    });

    it('cannot resolve publication lineage when this API has no configured public base', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', '');
        const { pool, app: server } = app([
            { rows: [{ id: 879, proposal_id: 'c2-orig', proposal_origin: { relation: 'revision', source: { kind: 'publication', apiBase: API_A, proposalRowId: '700' }, title: 'Older plan' } }] }
        ]);
        const res = await getLineage(server, '879');
        expect(res.body.source.resolution).toBe('external');
        expect(res.body.derived).toEqual([]);
        expect(pool.getCalls()).toHaveLength(1);
    });

    it('has no source for an original, and 404s for an unknown proposal', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', API_A);
        const { pool, app: server } = app([
            { rows: [{ id: 5, proposal_id: 'c2-root', proposal_origin: null }] },
            { rows: [] }
        ]);
        const res = await getLineage(server, '5');
        expect(res.body.source).toBeNull();
        expect(pool.getCalls()).toHaveLength(2);
        const missing = app([{ rows: [] }]);
        expect((await getLineage(missing.app, 'nope')).status).toBe(404);
    });
});
