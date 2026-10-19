// A binding decision within measurement error of its threshold is `unresolved` (projections.md §4):
// the browser/provider rule reports it, the server refuses to publish it, and the browser stops the
// publish early with a readable message. The real-SQL case lives in proposal-binding-db.test.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { checkProposalBinding, BINDING_SQL, BINDING_COUNT_SQL, BINDING_CODES, bindingUncertaintyM } from '../proposals/binding.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { bindingFromParcels, SPHERE_BAND } = require('../../frontend/js/proposals/site-binding.js');
const { prepareForPublish, createFetchPrepare, refusalMessage } = require('../../frontend/js/proposals/publish-binding.js');
const { frameFor } = require('../../frontend/js/metric-frame.js');

const ANCHOR = [15.97, 45.81];
const frame = frameFor([ANCHOR]);
const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(xy => frame.toLngLat(xy));
const polygon = (...box) => ({ type: 'Polygon', coordinates: [ring(...box)] });

describe('the browser/provider rule reports a decision inside its band as unresolved', () => {
    // A 40 m × 40 m parcel; the site overlaps its west edge by a strip `w` metres wide.
    const parcel = { id: 'HR-1-1', geometry: polygon(0, 0, 40, 40) };
    const siteReaching = w => polygon(-30, 5, w, 35);

    it('binds well above the tolerance, leaves well below it touched, and refuses to guess at it', () => {
        const toleranceM = 0.5;
        const ids = list => (list || []).map(p => p.parcelId);
        expect(ids(bindingFromParcels(siteReaching(0.6), [parcel], { toleranceM, turf }).parcels)).toEqual(['HR-1-1']);
        expect(ids(bindingFromParcels(siteReaching(0.4), [parcel], { toleranceM, turf }).touched)).toEqual(['HR-1-1']);
        const exact = bindingFromParcels(siteReaching(0.5), [parcel], { toleranceM, turf });
        expect(ids(exact.unresolved)).toEqual(['HR-1-1']);
        expect(exact.parcels).toEqual([]);
        expect(exact.touched).toEqual([]);
    });

    it('sizes its band for turf\'s sphere (0.35 %), the server\'s for its projection (0.015 %)', () => {
        expect(SPHERE_BAND.RELATIVE).toBeGreaterThanOrEqual(0.003);
        expect(bindingUncertaintyM(0.25)).toBeCloseTo(0.25 * 1.5e-4, 12);
        expect(bindingUncertaintyM(0.0005)).toBe(1e-6);
    });
});

describe('the server refuses to publish an unresolved binding', () => {
    const SITE = polygon(0, 0, 20, 20);
    const db = {
        async query(sql) {
            if (sql === BINDING_COUNT_SQL) return { rows: [{ parcels: 2 }] };
            if (sql === BINDING_SQL) {
                return { rows: [{
                    parcels: [
                        { parcelId: 'HR-1-1', overlapM2: 400, intrusionM: 20, bound: true, unresolved: false },
                        { parcelId: 'HR-1-2', overlapM2: 2, intrusionM: 0.3, bound: false, unresolved: true }
                    ],
                    site_m2: 400, in_region: true, unsurveyed_m2: 0, unknown_m2: 0,
                    site_geojson: JSON.stringify({ type: 'MultiPolygon', coordinates: [SITE.coordinates] })
                }] };
            }
            throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
        }
    };

    it('answers 409 binding-unresolved naming the parcel, whatever the declaration says', async () => {
        for (const declared of [['HR-1-1'], ['HR-1-1', 'HR-1-2']]) {
            const result = await checkProposalBinding(db, { type: 'building', goal: 'buildings' }, declared, { site: SITE, toleranceM: 0.3 });
            expect(result.ok).toBe(false);
            expect(result.status).toBe(409);
            expect(result.code).toBe(BINDING_CODES.unresolved);
            expect(result.unresolved).toEqual([{ id: 'HR-1-2', intrusionM: 0.3 }]);
        }
    });
});

describe('the browser stops a publish early on an unresolved binding', () => {
    it('throws binding-unresolved with a sentence naming the parcel', async () => {
        const site = polygon(0, 0, 20, 20);
        // POST /proposals/prepare refuses an undecidable binding (409, proposals/binding.js) before
        // anything is stored, minted or published.
        const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({
            code: 'binding-unresolved', error: 'undecidable', unresolved: [{ id: 'HR-1-2', intrusionM: 0.3 }] }) });
        const proposal = { type: 'building', goal: 'buildings', site, toleranceM: 0.3, cadastreParcelIds: ['HR-1-1'] };
        await expect(prepareForPublish(proposal, { fetchPrepare: createFetchPrepare(fetchImpl, '') }))
            .rejects.toMatchObject({ code: 'binding-unresolved', status: 409, unresolved: [{ id: 'HR-1-2', intrusionM: 0.3 }], message: expect.stringMatching(/HR-1-2/) });
        const message = refusalMessage({ code: 'binding-unresolved', unresolved: [{ id: 'HR-1-2', intrusionM: 0.3 }] });
        expect(message).toMatch(/HR-1-2/);
        expect(message).toMatch(/cannot be decided/);
    });
});
