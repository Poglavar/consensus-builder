// The strict land rule on the server: every current parcel a proposal's own geometry covers by >= 1 m²
// must be in cadastreParcelIds. Covers the shared footprint builder per type, the PostGIS check, the
// free POST /proposals and the paid /agent/proposals route (which must refuse before any payment).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSigner } from '@solana/kit';
import { createMockPool } from './helpers/mock-pool.js';
import { validProposalBody, insertResult, updateResult } from './helpers/fixtures.js';
import {
    MAX_FOOTPRINT_VERTICES,
    PARCEL_OVERLAP_SQL,
    checkDeclaredParcels,
    footprintParts,
    footprintQueryParams,
    proposalGeometryView
} from '../proposals/footprint.js';
import { setupProposalsRoute } from '../routes/proposals.js';
import { setupAgentProposalsRoute, AGENT_PROPOSALS_PATH } from '../routes/agent-proposals.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const PARK = box(15.97, 45.80, 15.971, 45.801);

describe('footprintParts (shared by browser, API and migration)', () => {
    it('takes each typology\'s authored geometry', () => {
        expect(footprintParts({ structureProposal: { geometry: PARK } }).sources).toEqual(['structureProposal.geometry']);
        expect(footprintParts({ geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: PARK }] } }).sources)
            .toEqual(['geometry.buildings']);
        expect(footprintParts({ roadProposal: { definition: { polygon: PARK } } }).sources)
            .toEqual(['roadProposal.definition.polygon']);
        const plan = footprintParts({
            reparcellization: { polygons: [{ geometry: PARK }, { geometry: box(15.971, 45.80, 15.972, 45.801) }] },
            geometry: box(0, 0, 1, 1)
        });
        // A readjustment's polygons are its footprint; proposal.geometry on it is ignored.
        expect(plan.polygons).toHaveLength(2);
        expect(plan.sources).toEqual(['reparcellization.polygons']);
        expect(plan.approximate).toBe(false);
    });

    it('marks a road stored without its corridor polygon as an approximate centreline footprint', () => {
        const parts = footprintParts({ roadProposal: { definition: {
            width: 12,
            points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }]
        } } });
        expect(parts.approximate).toBe(true);
        expect(parts.polygons).toEqual([]);
        expect(parts.centerline.halfWidthM).toBe(6);
        expect(parts.centerline.segments).toEqual([[[15.97, 45.8], [15.971, 45.801]]]);
        const [, lines] = footprintQueryParams(parts);
        expect(JSON.parse(lines)).toEqual([{ line: { type: 'LineString', coordinates: [[15.97, 45.8], [15.971, 45.801]] }, halfWidthM: 6 }]);
    });

    it('reports malformed coordinates and over-large footprints instead of passing them to PostGIS', () => {
        expect(footprintParts({ structureProposal: { geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 'x']]] } } }).invalid)
            .toMatch(/structureProposal.geometry is not a valid/);
        const ring = Array.from({ length: MAX_FOOTPRINT_VERTICES + 1 }, (_, i) => [15 + i * 1e-7, 45]);
        ring.push(ring[0]);
        expect(footprintParts({ structureProposal: { geometry: { type: 'Polygon', coordinates: [ring] } } }).invalid)
            .toMatch(/vertices \(limit/);
    });

    it('reads sub-proposals from their columns first, like the serializer', () => {
        const view = proposalGeometryView({
            structure_proposal: { geometry: PARK },
            proposal_data: { structureProposal: { geometry: box(0, 0, 1, 1) }, title: 'x' }
        });
        expect(view.structureProposal.geometry).toBe(PARK);
        expect(view.title).toBe('x');
    });
});

function overlapDb(rows) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return { rows };
        }
    };
}

describe('checkDeclaredParcels', () => {
    it('measures overlaps in one GiST-usable query with a 1 m² floor', async () => {
        const db = overlapDb([]);
        await checkDeclaredParcels(db, { structureProposal: { geometry: PARK } }, ['HR-1-1']);
        expect(db.calls).toHaveLength(1);
        const [{ sql, params }] = db.calls;
        expect(sql).toBe(PARCEL_OVERLAP_SQL);
        expect(sql).toMatch(/p\.geom && f\.geom AND ST_Intersects\(p\.geom, f\.geom\)/);
        expect(params[2]).toBe(1);
    });

    it('refuses geometry on an undeclared parcel and names it; declared-but-untouched parcels are fine', async () => {
        const db = overlapDb([
            { id: 'HR-1-1', parcel_area_m2: 900, overlap_m2: 850 },
            { id: 'HR-1-9', parcel_area_m2: 400, overlap_m2: 12.34 }
        ]);
        const refused = await checkDeclaredParcels(db, { structureProposal: { geometry: PARK } }, ['HR-1-1', 'HR-1-2']);
        expect(refused).toMatchObject({ ok: false, code: 'undeclared-parcels', parcels: [{ id: 'HR-1-9', overlapM2: 12.3 }] });
        const accepted = await checkDeclaredParcels(db, { structureProposal: { geometry: PARK } }, ['HR-1-1', 'HR-1-2', 'HR-1-9']);
        expect(accepted).toEqual({ ok: true, undeclared: [], checked: true });
    });

    it('does not query for a proposal without geometry, and refuses invalid geometry without querying', async () => {
        const db = overlapDb([]);
        expect(await checkDeclaredParcels(db, { title: 'vote' }, ['HR-1-1'])).toMatchObject({ ok: true, checked: false });
        const invalid = await checkDeclaredParcels(db, { structureProposal: { geometry: { type: 'Polygon', coordinates: 'x' } } }, []);
        expect(invalid).toMatchObject({ ok: false, code: 'invalid-footprint' });
        expect(db.calls).toHaveLength(0);
    });
});

// A mock pool that answers the parcel-overlap query from `overlapRows` and everything else from
// the queued results (the create handler's INSERT/UPDATE).
function routePool(overlapRows) {
    const pool = createMockPool();
    const queued = pool.query.bind(pool);
    pool.overlapQueries = 0;
    pool.query = async (sql, params) => {
        if (sql === PARCEL_OVERLAP_SQL) {
            pool.overlapQueries += 1;
            return { rows: overlapRows };
        }
        return queued(sql, params);
    };
    pool.connect = async () => ({ query: pool.query, release() {}, on() {}, off() {} });
    return pool;
}

const parkBody = (overrides = {}) => validProposalBody({
    type: 'structure',
    cadastreParcelIds: ['HR-335649-100'],
    structureProposal: { kind: 'park', geometry: PARK },
    ...overrides
});
const SPILL = [
    { id: 'HR-335649-100', parcel_area_m2: 9000, overlap_m2: 8500 },
    { id: 'HR-335649-101', parcel_area_m2: 700, overlap_m2: 45.6 }
];

describe('POST /proposals — undeclared parcels', () => {
    it('answers 400 undeclared-parcels with the list and writes nothing', async () => {
        const pool = routePool(SPILL);
        const app = express();
        app.use(express.json({ limit: '15mb' }));
        setupProposalsRoute(app, pool);
        const res = await request(app).post('/proposals').send(parkBody());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('undeclared-parcels');
        expect(res.body.parcels).toEqual([{ id: 'HR-335649-101', overlapM2: 45.6 }]);
        expect(pool.getCalls().some(call => /INSERT INTO proposal/.test(call.sql))).toBe(false);
    });

    it('stores the proposal when every covered parcel is declared', async () => {
        const pool = routePool(SPILL);
        pool.setResults([insertResult(), updateResult()]);
        const app = express();
        app.use(express.json({ limit: '15mb' }));
        setupProposalsRoute(app, pool);
        const res = await request(app).post('/proposals')
            .send(parkBody({ cadastreParcelIds: ['HR-335649-100', 'HR-335649-101'] }));
        expect(res.status).toBe(201);
        expect(pool.overlapQueries).toBe(1);
    });
});

describe(`POST ${AGENT_PROPOSALS_PATH} — undeclared parcels`, () => {
    let env;
    beforeAll(async () => {
        const treasury = await generateKeyPairSigner();
        env = {
            X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            X402_FACILITATOR_URL: 'https://facilitator.test',
            X402_PAY_TO: treasury.address,
            X402_PRICE_PROPOSAL: '$0.05'
        };
    });

    function paidApp(pool, facilitator) {
        const app = express();
        app.use(express.json({ limit: '15mb' }));
        setupProposalsRoute(app, pool);
        setupAgentProposalsRoute(app, pool, { env, facilitatorClient: facilitator });
        return app;
    }

    it('refuses with 400 before the payment challenge and never settles', async () => {
        const facilitator = { getSupported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })), verify: vi.fn(), settle: vi.fn() };
        const pool = routePool(SPILL);
        const body = parkBody();
        delete body.author;
        const unpaid = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH).send(body);
        expect(unpaid.status).toBe(400);
        expect(unpaid.body.code).toBe('undeclared-parcels');
        expect(unpaid.headers['payment-required']).toBeUndefined();

        // A client that attaches a payment anyway is refused at the same point, before the gate.
        const paid = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH)
            .set('PAYMENT-SIGNATURE', 'anything').send(body);
        expect(paid.status).toBe(400);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it('lets a complete declaration through to the payment challenge', async () => {
        const facilitator = { getSupported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })), verify: vi.fn(), settle: vi.fn() };
        const pool = routePool(SPILL);
        const body = parkBody({ cadastreParcelIds: ['HR-335649-100', 'HR-335649-101'] });
        delete body.author;
        const res = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH).send(body);
        expect(res.status).not.toBe(400);
        expect(pool.overlapQueries).toBe(1);
    });

    it('refuses with 503 (nothing charged) when the parcel lookup fails', async () => {
        const facilitator = { getSupported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })), verify: vi.fn(), settle: vi.fn() };
        const pool = routePool([]);
        pool.query = async () => { throw new Error('db down'); };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const body = parkBody();
        delete body.author;
        const res = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH).send(body);
        error.mockRestore();
        expect(res.status).toBe(503);
        expect(facilitator.settle).not.toHaveBeenCalled();
    });
});
