// GET /proposals/:id/lineage — where a proposal came from and which published records were made from
// it, so the original can list its counterproposals and a fork can link back to its source.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({ generateAndStoreProposalThumbnail: vi.fn(async () => null) }));

function app(results) {
    const pool = createMockPool();
    pool.setResults(results);
    return { pool, app: createTestApp(pool) };
}

describe('GET /proposals/:id/lineage', () => {
    it('resolves a published source and lists the records that name this one as theirs', async () => {
        const { pool, app: server } = app([
            { rows: [{ id: 879, proposal_id: 'c2-orig', source_key: 'c2-older', source_name: 'Older plan' }] },
            { rows: [{ id: 700, proposal_id: 'c2-older', title: 'Older plan', name: null, effective_status: 'Active' }] },
            { rows: [
                { id: 901, proposal_id: 'c2-fork-b', title: 'Counter B', name: null, author: 'Owner C', created_at: '2026-10-16T10:00:00Z', effective_status: 'Active', land_fork: false },
                { id: 900, proposal_id: 'c2-fork-a', title: null, name: 'Counter A', author: null, created_at: '2026-10-15T10:00:00Z', effective_status: 'Active', land_fork: true }
            ] }
        ]);
        const res = await request(server).get('/proposals/879/lineage');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ proposalRowId: 879, authoredProposalId: 'c2-orig' });
        expect(res.body.source).toEqual({ resolution: 'resolved', proposalRowId: 700, authoredProposalId: 'c2-older', title: 'Older plan', status: 'Active' });
        expect(res.body.derived.map(d => [d.proposalRowId, d.authoredProposalId, d.title, d.landFork])).toEqual([
            [901, 'c2-fork-b', 'Counter B', false], [900, 'c2-fork-a', 'Counter A', true]
        ]);
        for (const record of [res.body, res.body.source, ...res.body.derived]) {
            expect(record).not.toHaveProperty('id');
            expect(record).not.toHaveProperty('proposalId');
            expect(record).not.toHaveProperty('published');
        }
        const calls = pool.getCalls();
        expect(calls[0].params).toEqual(['879']);
        expect(calls[1].params).toEqual(['c2-older']);
        // Forks may name the original by its proposal id or by its row id; never itself.
        expect(calls[2].params).toEqual([['c2-orig', '879'], 879]);
        expect(calls[2].sql).toMatch(/sourceProposalId/);
        expect(calls[2].sql).toMatch(/replacementOfProposalId/);
        expect(calls[2].sql).toMatch(/id <> \$2/);
    });

    it('reports an unresolved source without claiming a publication history or identifier namespace', async () => {
        const { app: server } = app([
            { rows: [{ id: 879, proposal_id: 'c2-orig', source_key: 'p-local', source_name: 'Subdivide · 3 parcels' }] },
            { rows: [] },
            { rows: [] }
        ]);
        const res = await request(server).get('/proposals/c2-orig/lineage');
        expect(res.status).toBe(200);
        expect(res.body.source).toEqual({ resolution: 'not-found', reference: 'p-local', title: 'Subdivide · 3 parcels' });
        expect(res.body.derived).toEqual([]);
    });

    it('has no source for an original, and 404s for an unknown proposal', async () => {
        const { pool, app: server } = app([
            { rows: [{ id: 5, proposal_id: 'c2-root', source_key: null, source_name: null }] },
            { rows: [] }
        ]);
        const res = await request(server).get('/proposals/5/lineage');
        expect(res.body.source).toBeNull();
        expect(pool.getCalls()).toHaveLength(2);
        const missing = app([{ rows: [] }]);
        expect((await request(missing.app).get('/proposals/nope/lineage')).status).toBe(404);
    });
});
