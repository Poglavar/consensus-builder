// Site-model helpers: one identity per site across postings, plan outlines in metres, north as rotation.
import { describe, expect, it } from 'vitest';
import { buildSiteModels, northRotationDeg, planOutline, siteKey } from '../floor-plans/site-model.js';

describe('site model helpers', () => {
    it('identifies a site by permit case first, then address point, then parcels', () => {
        expect(siteKey({ permits: [{ caseId: 'P1' }], addressPoints: [{ id: 'A' }] })).toBe('permit:P1');
        expect(siteKey({ permits: [], addressPoints: [{ id: 'A' }] })).toBe('address:A');
        expect(siteKey({ parcels: [{ ko: '2', kc: '9' }, { ko: '1', kc: '5' }] })).toBe('parcels:1:5,2:9');
        expect(siteKey({})).toBeNull();
    });

    it('turns the normalized slab ring into metres with y pointing north', () => {
        const model = { architecture: { dimensionsM: [10, 8], slabs: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]] } };
        expect(planOutline(model)).toEqual([[0, -0], [10, -0], [10, -8], [0, -8]]);
        expect(planOutline({ architecture: { dimensionsM: [0, 8], slabs: [] } })).toBeNull();
    });

    it('reads a printed north arrow as the rotation that points it up', () => {
        expect(northRotationDeg({ source: { northPx: [[50, 60], [50, 10]] } })).toBeCloseTo(0, 6);   // arrow already up
        expect(northRotationDeg({ source: { northPx: [[10, 50], [60, 50]] } })).toBeCloseTo(90, 6);  // arrow points right
        expect(northRotationDeg({ source: { northPx: null } })).toBeNull();
    });
});

// Fake database for the build loop: located listings in, statements recorded.
function fakeDb(listings) {
    const statements = [];
    return {
        statements,
        async query(sql, params) {
            statements.push({ sql, params });
            if (/FROM floor_plan\.listing/.test(sql)) return { rows: listings };
            if (/^DELETE/.test(sql.trim())) return { rowCount: 2 };
            return { rowCount: 1, rows: [] };
        },
    };
}
const located = (url, caseId) => ({ url, location: { candidates: [{ permits: [{ caseId }] }] } });
const build = async (_db, url) => ({ schema: 'site-model.v1', listingUrl: url, siblings: [url] });

describe('buildSiteModels', () => {
    it('stores one model per site and retires models of sites no longer located', async () => {
        const db = fakeDb([located('https://a/1', 'P1'), located('https://a/2', 'P1'), located('https://a/3', 'P2')]);
        const result = await buildSiteModels(db, { build, log: () => {} });
        expect(result).toMatchObject({ sites: 2, built: 2, failed: 0, retired: 2 });
        const retire = db.statements.find(s => /^DELETE/.test(s.sql.trim()));
        expect(retire.params[0].sort()).toEqual(['permit:P1', 'permit:P2']);
    });

    it('keeps every stored model when the pass is truncated by the limit', async () => {
        const db = fakeDb([located('https://a/1', 'P1'), located('https://a/3', 'P2')]);
        const result = await buildSiteModels(db, { build, limit: 1, log: () => {} });
        expect(result).toMatchObject({ sites: 2, built: 1, retired: 0 });
        expect(db.statements.some(s => /^DELETE/.test(s.sql.trim()))).toBe(false);
    });
});
