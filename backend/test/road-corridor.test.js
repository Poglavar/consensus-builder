// Unit tests for server-authoritative corridor acquisition stats. The pure aggregator and the
// footprint resolver are tested directly; the endpoint is tested with a mock pool. The PostGIS
// query itself (against the real parcel layer) needs verification on prod data.
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createMockPool } from './helpers/mock-pool.js';
import {
    computeCorridorAcquisitionStats,
    normalizeCorridorOwnershipType,
    resolveRoadFootprintGeometry,
    setupRoadCorridorRoute
} from '../routes/road-corridor.js';

const SQUARE = {
    type: 'Polygon',
    coordinates: [[[15.97, 45.80], [15.972, 45.80], [15.972, 45.802], [15.97, 45.802], [15.97, 45.80]]]
};

// A classifier stub: the details object carries the type directly for the test.
const classify = (details) => (details && details.type) || 'private individual';
const economicSource = (currency = 'GBP', amount = 100) => ({
    metric: 'roadLand', unit: 'm2-land', amount, currency, basis: 'assumption', asOf: null,
    sourceId: 'test-road-rate', sourceName: 'Test road rate', sourceUrl: 'https://example.test/rates', scope: null
});
const sourceDescriptor = (currency = 'GBP', amount = 100, metric = 'roadLand') => ({
    version: 1, id: 'test-road-rate', name: 'Test road rate', adapter: 'rate-table',
    url: 'https://example.test/rates',
    rates: [{ metric, unit: metric === 'sale' ? 'm2-floor' : 'm2-land', amount, currency, basis: 'assumption' }]
});

describe('normalizeCorridorOwnershipType', () => {
    it('maps classifier labels to coefficient keys', () => {
        expect(normalizeCorridorOwnershipType('private individual')).toBe('individual');
        expect(normalizeCorridorOwnershipType('government')).toBe('government');
        expect(normalizeCorridorOwnershipType('city')).toBe('government');
        expect(normalizeCorridorOwnershipType('institution')).toBe('institution');
        expect(normalizeCorridorOwnershipType('company')).toBe('company');
        expect(normalizeCorridorOwnershipType('mixed')).toBe('mixed');
        expect(normalizeCorridorOwnershipType(null)).toBeNull();
    });
});

describe('computeCorridorAcquisitionStats', () => {
    it('sums modeled land value and difficulty using the explicit source rate', () => {
        const rows = [
            { parcelId: 'A', fullAreaM2: 100, takenAreaM2: 40, ownershipDetails: { type: 'private individual', owners: [{ name: 'A1', ownership: '50%' }, { name: 'A2', ownership: '50%' }] } }, // coeff 2, two source owners
            { parcelId: 'B', fullAreaM2: 200, takenAreaM2: 50, ownershipDetails: { type: 'company', owners: [{ name: 'B1', ownership: '100%' }] } }, // coeff 1
            { parcelId: 'C', fullAreaM2: 300, takenAreaM2: 60, ownershipDetails: { type: 'government', owners: [{ name: 'C1', ownership: '100%' }] } } // coeff 0
        ];
        const source = economicSource('GBP', 100);
        const stats = computeCorridorAcquisitionStats(rows, { classify, economicSource: source });

        expect(stats.parcelIds).toEqual(['A', 'B', 'C']);
        expect(stats.totalMarketPrice).toBe((100 + 200 + 300) * 100); // 60000
        // A: 100*100*2=20000, B: 200*100*1=20000, C: 300*100*0=0 → 40000
        expect(stats.totalAcquiringDifficulty).toBe(40000);
        expect(stats.ownershipCounts).toEqual({ individual: 1, company: 1, government: 1, institution: 0, mixed: 0 });
        expect(stats.ownerEntryCount).toBe(4);
        expect(stats.knownOwnerEntryCount).toBe(4);
        expect(stats.missingOwnerEvidenceParcelCount).toBe(0);
        expect(stats.areaTakenM2).toBe(150);
        expect(stats.currency).toBe('GBP');
        expect(stats.priceBasis).toEqual({ kind: 'area-model', ratePerM2: 100, currency: 'GBP', economicSource: source });
        expect(stats.source).toBe('server');
    });

    it('government and institution parcels add price but zero difficulty', () => {
        const rows = [
            { parcelId: 'G', fullAreaM2: 500, takenAreaM2: 500, ownershipDetails: { type: 'government', owners: [{ name: 'Agency', ownership: '100%' }] } },
            { parcelId: 'I', fullAreaM2: 500, takenAreaM2: 500, ownershipDetails: { type: 'institution', owners: [{ name: 'Institution', ownership: '100%' }] } }
        ];
        const stats = computeCorridorAcquisitionStats(rows, { classify, economicSource: economicSource('EUR', 100) });
        expect(stats.totalMarketPrice).toBe(100000);
        expect(stats.totalAcquiringDifficulty).toBe(0);
    });

    it('skips parcels with no area and leaves price unavailable without a source', () => {
        expect(computeCorridorAcquisitionStats([], { classify }).totalMarketPrice).toBeNull();
        expect(computeCorridorAcquisitionStats([], { classify, economicSource: economicSource() }).totalMarketPrice).toBe(0);
        const stats = computeCorridorAcquisitionStats(
            [{ parcelId: 'X', fullAreaM2: 0, ownershipDetails: {} }], { classify });
        expect(stats.parcelIds).toEqual([]);
        expect(stats.totalMarketPrice).toBeNull();
        expect(stats.totalAcquiringDifficulty).toBeNull();
    });

    it('does not invent missing ownership evidence or a difficulty score', () => {
        const stats = computeCorridorAcquisitionStats([
            { parcelId: 'unknown', fullAreaM2: 100, takenAreaM2: 25, ownershipDetails: null }
        ], { classify, economicSource: economicSource('EUR', 100) });
        expect(stats.totalMarketPrice).toBe(10000);
        expect(stats.totalAcquiringDifficulty).toBeNull();
        expect(stats.ownerEntryCount).toBeNull();
        expect(stats.knownOwnerEntryCount).toBe(0);
        expect(stats.missingOwnerEvidenceParcelCount).toBe(1);
        expect(stats.unknownOwnershipParcelCount).toBe(1);
        expect(stats.currency).toBe('EUR');
        expect(stats.priceBasis).toMatchObject({ kind: 'area-model', ratePerM2: 100, currency: 'EUR', economicSource: { sourceId: 'test-road-rate' } });
    });

    it('keeps all monetary fields unknown when the explicit rate is missing or invalid', () => {
        for (const source of [null, { ...economicSource(), amount: null }, { ...economicSource(), unit: 'm2-floor' }]) {
            for (const rows of [[], [{ parcelId: 'A', fullAreaM2: 20, takenAreaM2: 10, ownershipDetails: null }]]) {
                const stats = computeCorridorAcquisitionStats(rows, { economicSource: source, classify });
                expect(stats.totalMarketPrice).toBeNull();
                expect(stats.totalAcquiringDifficulty).toBeNull();
                expect(stats.priceBasis).toMatchObject({ kind: 'unavailable', ratePerM2: null, currency: null, economicSource: null });
            }
        }
    });
});

describe('resolveRoadFootprintGeometry', () => {
    it('picks the stored footprint polygon', () => {
        const geom = resolveRoadFootprintGeometry({ roadProposal: { definition: { polygon: SQUARE } } });
        expect(geom).toEqual(SQUARE);
    });

    it('does not synthesize a competing footprint when no canonical polygon is stored', () => {
        const geom = resolveRoadFootprintGeometry({
            roadProposal: { definition: { points: [[15.97, 45.80], [15.98, 45.80]], width: 10 } }
        });
        expect(geom).toBeNull();
    });

    it('returns null for a non-road / geometry-less proposal', () => {
        expect(resolveRoadFootprintGeometry({ roadProposal: { definition: {} } })).toBeNull();
        expect(resolveRoadFootprintGeometry(null)).toBeNull();
    });
});

describe('POST /road-corridor/stats', () => {
    function makeApp(pool) {
        const app = express();
        setupRoadCorridorRoute(app, pool);
        return app;
    }

    async function postStats(app, body) {
        const layer = app._router.stack.find(item => item.route?.path === '/road-corridor/stats');
        const handler = layer.route.stack.find(item => item.method === 'post').handle;
        let status = 200;
        let responseBody;
        const response = { status(code) { status = code; return this; }, json(value) { responseBody = value; return this; } };
        await handler({ body }, response);
        return { status, body: responseBody };
    }

    it('rejects a missing or unsupported parcel source before querying the database', async () => {
        for (const parcelSourceId of [undefined, 'other']) {
            const pool = createMockPool();
            const res = await postStats(makeApp(pool), { parcelSourceId, geometry: SQUARE, economicSource: sourceDescriptor() });
            expect(res.status).toBe(400);
            expect(pool.getCalls()).toHaveLength(0);
        }
    });

    it('rejects invalid economic evidence or a descriptor without roadLand before querying', async () => {
        for (const source of [null, sourceDescriptor('GBP', 100, 'sale'), sourceDescriptor('GBP', null)]) {
            const pool = createMockPool();
            const res = await postStats(makeApp(pool), { parcelSourceId: 'oss-wfs', geometry: SQUARE, economicSource: source });
            expect(res.status).toBe(400);
            expect(pool.getCalls()).toHaveLength(0);
        }
    });

    it('runs the query with the explicit descriptor rate and returns its provenance', async () => {
        const pool = createMockPool();
        pool.setResult({
            rows: [
                { parcel_id: 'HR-1', full_area_m2: '100', taken_area_m2: '40', ownership_details: null },
            ]
        });
        const app = makeApp(pool);
        const descriptor = sourceDescriptor('GBP', 25);
        const res = await postStats(app, { parcelSourceId: 'oss-wfs', geometry: SQUARE, economicSource: descriptor });
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('server');
        expect(res.body.parcelIds).toEqual(['HR-1']);
        // Missing ownership leaves difficulty unknown while the sourced area model remains available.
        expect(res.body.totalMarketPrice).toBe(2500);
        expect(res.body.totalAcquiringDifficulty).toBeNull();
        expect(res.body.ownerEntryCount).toBeNull();
        expect(res.body.currency).toBe('GBP');
        expect(res.body.priceBasis).toMatchObject({ kind: 'area-model', ratePerM2: 25, currency: 'GBP', economicSource: {
            metric: 'roadLand', unit: 'm2-land', amount: 25, currency: 'GBP', basis: 'assumption',
            sourceId: 'test-road-rate', sourceName: 'Test road rate'
        } });
        // The query buffers the footprint into 3765 and intersects the parcel layer.
        expect(pool.getCalls()[0].sql).toMatch(/ST_Intersection/);
        expect(pool.getCalls()[0].sql).toMatch(/FROM parcel p/);
    });

    it('400s without geometry or points+width', async () => {
        const res = await postStats(makeApp(createMockPool()), { parcelSourceId: 'oss-wfs', economicSource: sourceDescriptor() });
        expect(res.status).toBe(400);
    });

    it('500s when the query fails', async () => {
        const pool = createMockPool();
        pool.query = async () => { throw new Error('boom'); };
        const res = await postStats(makeApp(pool), { parcelSourceId: 'oss-wfs', economicSource: sourceDescriptor(), geometry: SQUARE });
        expect(res.status).toBe(500);
    });
});
