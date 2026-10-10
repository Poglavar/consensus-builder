// Prepare → publish against the real cadastre, over HTTP, inside one transaction that is rolled back:
// the server builds a street's land, binds it to real parcels and signs the artifact without storing
// it; the publication stores the artifact beside a row that carries exactly that land, site (same
// on-chain site hash), binding and declaration. A street published unprepared is refused. Run with
// RUN_DB_TESTS=1 (and PG* pointing at the local database).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

const { setupProposalsRoute } = await import('../routes/proposals.js');
const { publish } = await import('../scripts/lib/candlestick-common.mjs');
const { setupProposalPrepareRoute } = await import('../routes/proposal-prepare.js');
const { defaultThumbnailQueue } = await import('../thumbnails/thumbnail-queue.js');

const require = createRequire(import.meta.url);
const siteHashApi = require('../../frontend/js/proposals/site-hash.js');

const live = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

live('prepare → publish on the real cadastre (rolled back)', () => {
    let client;
    let app;
    let centre;

    beforeAll(async () => {
        // this server's signing key (proposals/prepare.js), whatever the local .env holds
        process.env.PREPARE_SIGNING_KEY = 'c3'.repeat(32);
        const { default: pg } = await import('pg');
        client = new pg.Client({
            host: process.env.PGHOST || 'localhost',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE || 'geodata'
        });
        await client.connect();
        await client.query('BEGIN');
        // Every statement of both routes runs on this one transaction.
        const txPool = {
            query: (...args) => client.query(...args),
            connect: async () => ({ query: (...args) => client.query(...args), release() {}, on() {}, off() {} })
        };
        app = express();
        app.use(express.json({ limit: '15mb' }));
        setupProposalPrepareRoute(app, txPool);
        setupProposalsRoute(app, txPool);
        const { rows } = await client.query(`
            SELECT ST_X(c) AS lng, ST_Y(c) AS lat
            FROM (SELECT ST_Transform(ST_PointOnSurface(geom), 4326) AS c FROM parcel
                  WHERE current AND maticni_broj_ko = 335649 AND broj_cestice = '1021/3') AS x`);
        expect(rows).toHaveLength(1);
        centre = rows[0];
    });

    afterAll(async () => {
        await defaultThumbnailQueue().onIdle?.();
        await client?.query('ROLLBACK');
        await client?.end();
    });

    const street = () => {
        const at = (dLng, dLat) => ({ lat: centre.lat + dLat, lng: centre.lng + dLng });
        const points = [at(-0.0008, 0), at(0.0004, 0.0001), at(0.0009, 0.0006)];
        return {
            proposalId: `prepare-db-test-${process.pid}-${Date.now()}`,
            city: 'zagreb',
            title: 'Prepared street',
            type: 'road',
            goal: 'road-track',
            roadProposal: { definition: { width: 12, points, segments: [points] } }
        };
    };

    it('publishes exactly the prepared land, site, binding and declaration', async () => {
        const draft = street();
        const prepared = await request(app).post('/proposals/prepare').set('Origin', 'http://localhost:8080').send({ proposal: draft });
        expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(201);
        const { artifact, proposal, preparationId, digest, preparedAt } = prepared.body;
        expect(artifact.corridor.constructionFrame.kind).toBe('local-tmerc');
        expect(artifact.binding.parcels.length).toBeGreaterThan(0);
        expect(proposal.cadastreParcelIds).toEqual(artifact.cadastreParcelIds);
        expect(proposal.preparedArtifact).toEqual(artifact);

        // idempotent, and nothing stored: preparing is free of side effects
        const again = await request(app).post('/proposals/prepare').send({ proposal: draft });
        expect(again.body.preparationId).toBe(preparationId);
        const before = await client.query('SELECT count(*)::int AS n FROM consensus.proposal_prepared WHERE id = $1', [preparationId]);
        expect(before.rows[0].n).toBe(0);

        const published = await request(app).post('/proposals').send(proposal);
        expect(published.status, JSON.stringify(published.body).slice(0, 400)).toBe(201);
        const { rows } = await client.query(`
            SELECT proposal_data, road_proposal, binding, cadastre_parcel_ids, ST_AsGeoJSON(site, 15)::json AS site_column
            FROM proposal WHERE id = $1`, [published.body.id]);
        const row = rows[0];
        expect(row.road_proposal.definition.polygon).toEqual(artifact.corridor.polygon);
        expect(row.road_proposal.definition.constructionFrame).toEqual(artifact.corridor.constructionFrame);
        expect(row.proposal_data.preparation).toEqual({ id: preparationId, digest, preparedAt });
        expect(row.proposal_data.preparedArtifact).toBeUndefined();
        expect(row.binding).toEqual({ ...artifact.binding, computedAt: preparedAt });
        // the publication stored the artifact it was verified against, once
        const prepRow = await client.query('SELECT artifact, prepared_at, city FROM consensus.proposal_prepared WHERE id = $1', [preparationId]);
        expect(prepRow.rows).toHaveLength(1);
        expect(prepRow.rows[0].artifact).toEqual(artifact);
        expect(prepRow.rows[0].prepared_at.toISOString()).toBe(preparedAt);
        expect(prepRow.rows[0].city).toBe('zagreb');
        expect([...row.cadastre_parcel_ids].sort()).toEqual([...artifact.cadastreParcelIds].sort());
        // the on-chain identity: what was minted from the artifact is what the row holds
        expect(await siteHashApi.siteHashHex(row.proposal_data.site)).toBe(artifact.siteHash);
        expect(await siteHashApi.siteHashHex(row.site_column)).toBe(artifact.siteHash);
    });

    it('the scripts\' publish() prepares and publishes the server-built land (over HTTP)', async () => {
        const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
        try {
            const backend = `http://127.0.0.1:${server.address().port}`;
            const draft = street();
            const result = await publish(draft, { backend, origin: 'http://localhost:8080', city: 'zagreb', parcelSourceId: null });
            expect(result.skipped).toBe(false);
            expect(result.preparationId).toMatch(/^prep_[0-9a-f]{32}$/);
            const { rows } = await client.query(`SELECT proposal_data->'preparation'->>'id' AS prep, road_proposal->'definition'->'constructionFrame'->>'kind' AS frame
                FROM proposal WHERE id = $1`, [result.id]);
            expect(rows[0]).toEqual({ prep: result.preparationId, frame: 'local-tmerc' });
            // a second run finds it and leaves it alone
            expect((await publish(draft, { backend, origin: 'http://localhost:8080', city: 'zagreb', parcelSourceId: null })).skipped).toBe(true);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('files a publication under the city its site lies in, and refuses one only another city covers', async () => {
        // drawn from Split's view (one countrywide cadastre): bound the same, stored as Zagreb's
        const fromSplit = { ...street(), city: 'split' };
        const prepared = await request(app).post('/proposals/prepare').send({ proposal: fromSplit });
        expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(201);
        expect(prepared.body.artifact).toMatchObject({ city: 'zagreb', requestedCity: 'split' });
        expect(prepared.body.artifact.binding.parcels.length).toBeGreaterThan(0);
        // an older client publishes the city it asked for
        const published = await request(app).post('/proposals').send({ ...prepared.body.proposal, city: 'split' });
        expect(published.status, JSON.stringify(published.body).slice(0, 400)).toBe(201);
        const { rows } = await client.query('SELECT city, proposal_data->>\'city\' AS data_city FROM proposal WHERE id = $1', [published.body.id]);
        expect(rows[0]).toEqual({ city: 'zagreb', data_city: 'zagreb' });

        // drawn while New York was loaded: New York's parcels do not cover Zagreb
        const fromNewYork = await request(app).post('/proposals/prepare').send({ proposal: { ...street(), city: 'new_york' } });
        expect(fromNewYork.status).toBe(422);
        expect(fromNewYork.body).toMatchObject({ code: 'site-in-other-city', siteCity: 'zagreb' });
    });

    it('refuses a street published unprepared, and one changed after preparing', async () => {
        const draft = street();
        const unprepared = await request(app).post('/proposals').send({ ...draft, cadastreParcelIds: [] });
        expect(unprepared.status).toBe(422);
        expect(unprepared.body.code).toBe('preparation-required');

        const { body } = await request(app).post('/proposals/prepare').send({ proposal: draft });
        const moved = JSON.parse(JSON.stringify(body.proposal));
        moved.roadProposal.definition.points[2].lat += 0.00001;
        moved.roadProposal.definition.segments[0][2].lat += 0.00001;
        const refused = await request(app).post('/proposals').send(moved);
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('preparation-mismatch');
    });
});
