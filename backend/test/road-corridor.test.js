// Unit tests for the server-authoritative corridor acquisition stats. The pure aggregator and the
// footprint resolver are tested directly; the endpoint + POST /proposals recompute are tested with a
// mock pool. The PostGIS query itself (against the real parcel layer) needs verification on prod data.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createMockPool } from './helpers/mock-pool.js';
import {
    computeCorridorAcquisitionStats,
    normalizeCorridorOwnershipType,
    resolveRoadFootprintGeometry,
    recomputeCorridorStats,
    setupRoadCorridorRoute
} from '../routes/road-corridor.js';

const SQUARE = {
    type: 'Polygon',
    coordinates: [[[15.97, 45.80], [15.972, 45.80], [15.972, 45.802], [15.97, 45.802], [15.97, 45.80]]]
};

// A classifier stub: the details object carries the type directly for the test.
const classify = (details) => (details && details.type) || 'private individual';

describe('normalizeCorridorOwnershipType', () => {
    it('maps classifier labels to coefficient keys', () => {
        expect(normalizeCorridorOwnershipType('private individual')).toBe('individual');
        expect(normalizeCorridorOwnershipType('government')).toBe('government');
        expect(normalizeCorridorOwnershipType('city')).toBe('government');
        expect(normalizeCorridorOwnershipType('institution')).toBe('institution');
        expect(normalizeCorridorOwnershipType('company')).toBe('company');
        expect(normalizeCorridorOwnershipType('mixed')).toBe('mixed');
        expect(normalizeCorridorOwnershipType(null)).toBe('individual');
    });
});

describe('computeCorridorAcquisitionStats', () => {
    it('sums market price and difficulty with the ownership coefficients', () => {
        const rows = [
            { parcelId: 'A', fullAreaM2: 100, takenAreaM2: 40, ownershipDetails: { type: 'private individual' } }, // coeff 2
            { parcelId: 'B', fullAreaM2: 200, takenAreaM2: 50, ownershipDetails: { type: 'company' } },            // coeff 1
            { parcelId: 'C', fullAreaM2: 300, takenAreaM2: 60, ownershipDetails: { type: 'government' } }          // coeff 0
        ];
        const stats = computeCorridorAcquisitionStats(rows, { classify, pricePerM2: 100 });

        expect(stats.parcelIds).toEqual(['A', 'B', 'C']);
        expect(stats.totalMarketPrice).toBe((100 + 200 + 300) * 100); // 60000
        // A: 100*100*2=20000, B: 200*100*1=20000, C: 300*100*0=0 → 40000
        expect(stats.totalAcquiringDifficulty).toBe(40000);
        expect(stats.ownershipCounts).toEqual({ individual: 1, company: 1, government: 1, institution: 0, mixed: 0 });
        expect(stats.individualOwners).toBe(1);
        expect(stats.areaTakenM2).toBe(150);
        expect(stats.source).toBe('server');
    });

    it('government and institution parcels add price but zero difficulty', () => {
        const rows = [
            { parcelId: 'G', fullAreaM2: 500, takenAreaM2: 500, ownershipDetails: { type: 'government' } },
            { parcelId: 'I', fullAreaM2: 500, takenAreaM2: 500, ownershipDetails: { type: 'institution' } }
        ];
        const stats = computeCorridorAcquisitionStats(rows, { classify, pricePerM2: 100 });
        expect(stats.totalMarketPrice).toBe(100000);
        expect(stats.totalAcquiringDifficulty).toBe(0);
    });

    it('skips parcels with no area and handles empty input', () => {
        expect(computeCorridorAcquisitionStats([], { classify }).totalMarketPrice).toBe(0);
        const stats = computeCorridorAcquisitionStats(
            [{ parcelId: 'X', fullAreaM2: 0, ownershipDetails: {} }], { classify });
        expect(stats.parcelIds).toEqual([]);
    });
});

describe('resolveRoadFootprintGeometry', () => {
    it('picks the stored footprint polygon', () => {
        const geom = resolveRoadFootprintGeometry({ roadProposal: { definition: { polygon: SQUARE } } });
        expect(geom).toEqual(SQUARE);
    });

    it('buffers the centerline when no polygon is stored', () => {
        const geom = resolveRoadFootprintGeometry({
            roadProposal: { definition: { points: [[15.97, 45.80], [15.98, 45.80]], width: 10 } }
        });
        expect(geom).toBeTruthy();
        expect(['Polygon', 'MultiPolygon']).toContain(geom.type);
    });

    it('returns null for a non-road / geometry-less proposal', () => {
        expect(resolveRoadFootprintGeometry({ roadProposal: { definition: {} } })).toBeNull();
        expect(resolveRoadFootprintGeometry(null)).toBeNull();
    });
});

describe('POST /road-corridor/stats', () => {
    function makeApp(pool) {
        const app = express();
        app.use(express.json());
        setupRoadCorridorRoute(app, pool);
        return app;
    }

    it('runs the query and returns aggregated stats for a footprint', async () => {
        const pool = createMockPool();
        pool.setResult({
            rows: [
                { parcel_id: 'HR-1', full_area_m2: '100', taken_area_m2: '40', ownership_details: null },
            ]
        });
        const app = makeApp(pool);
        const res = await request(app).post('/road-corridor/stats').send({ geometry: SQUARE });
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('server');
        expect(res.body.parcelIds).toEqual(['HR-1']);
        // details null → classifier returns null → 'individual' (coeff 2): price 10000, difficulty 20000
        expect(res.body.totalMarketPrice).toBe(10000);
        // The query buffers the footprint into 3765 and intersects the parcel layer.
        expect(pool.getCalls()[0].sql).toMatch(/ST_Intersection/);
        expect(pool.getCalls()[0].sql).toMatch(/FROM parcel p/);
    });

    it('400s without geometry or points+width', async () => {
        const res = await request(makeApp(createMockPool())).post('/road-corridor/stats').send({});
        expect(res.status).toBe(400);
    });

    it('500s when the query fails', async () => {
        const pool = createMockPool();
        pool.query = async () => { throw new Error('boom'); };
        const res = await request(makeApp(pool)).post('/road-corridor/stats').send({ geometry: SQUARE });
        expect(res.status).toBe(500);
    });
});

describe('recomputeCorridorStats (POST /proposals path)', () => {
    const roadProposal = { roadProposal: { definition: { polygon: SQUARE } } };

    it('returns server stats when the corridor touches parcels', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [{ parcel_id: 'HR-1', full_area_m2: '100', taken_area_m2: '40', ownership_details: null }] });
        const stats = await recomputeCorridorStats(pool, roadProposal);
        expect(stats).not.toBeNull();
        expect(stats.source).toBe('server');
        expect(stats.parcelIds).toEqual(['HR-1']);
    });

    it('returns null (keeps client value) for a non-road proposal', async () => {
        const pool = createMockPool();
        expect(await recomputeCorridorStats(pool, { buildingProposal: {} })).toBeNull();
    });

    it('returns null when the corridor touches no parcels (e.g. non-Zagreb)', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [] });
        expect(await recomputeCorridorStats(pool, roadProposal)).toBeNull();
    });

    it('returns null (never throws) when the query fails, so creation is not blocked', async () => {
        const pool = createMockPool();
        pool.query = async () => { throw new Error('db down'); };
        expect(await recomputeCorridorStats(pool, roadProposal)).toBeNull();
    });
});
