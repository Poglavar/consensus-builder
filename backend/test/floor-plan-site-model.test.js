// Site-model helpers: one identity per site across postings, plan outlines in metres, north as rotation.
import { describe, expect, it } from 'vitest';
import { buildSiteModels, northRotationDeg, planOutline, siteKey } from '../floor-plans/site-model.js';

const ring = { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.9001, 45.8], [15.9001, 45.8001], [15.9, 45.8001], [15.9, 45.8]]] };

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
            if (/FROM floor_plan\.listing/.test(sql)) {
                const urls = params?.[0];
                return { rows: urls ? listings.filter(row => urls.includes(row.url)) : listings };
            }
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

    it('scopes model builds to an HTTP URL allowlist and never retires outside models', async () => {
        const db = fakeDb([located('https://a/1', 'P1'), located('https://a/2', 'P2')]);
        const referencesDb = { query: async () => ({ rows: [] }) };
        const seen = [];
        const result = await buildSiteModels(db, { urls: ['https://a/1'], referencesDb,
            build: async (...args) => { seen.push(args); return { schema: 'site-model.v1', listingUrl: args[1], siblings: [args[1]] }; },
            log: () => {} });
        expect(result).toMatchObject({ sites: 1, built: 1, retired: 0 });
        expect(seen[0][1]).toBe('https://a/1');
        expect(seen[0][2]).toEqual({ referencesDb });
        expect(db.statements[0].params).toEqual([['https://a/1']]);
        expect(db.statements.some(s => /^DELETE/.test(s.sql.trim()))).toBe(false);
    });

    it.each([[], ['relative/path'], ['file:///tmp/site'], [null], null, 'https://a'])('rejects invalid scoped URL allowlists: %j', async urls => {
        await expect(buildSiteModels(fakeDb([]), { urls, log: () => {} }))
            .rejects.toThrow('non-empty array of absolute HTTP(S) URLs');
    });

    it('routes footprint lookups through referencesDb while retaining all same-site siblings', async () => {
        const candidate = { permits: [{ caseId: 'P1' }], featureIds: ['eDozvola_building_polygon.1'] };
        const current = { url: 'https://a/1', facts: {}, location_status: 'located', location: { candidates: [candidate] } };
        const sibling = { url: 'https://a/2', facts: {}, location_status: 'probable', location: { candidates: [candidate] } };
        const other = located('https://a/3', 'P2');
        const localQueries = [];
        const localDb = { async query(sql) {
            localQueries.push(sql);
            if (/SELECT url, facts, location, location_status FROM floor_plan\.listing/.test(sql)) return { rows: [current] };
            if (/SELECT url, facts, location FROM floor_plan\.listing/.test(sql)) return { rows: [current, sibling, other] };
            return { rows: [] };
        } };
        const referenceQueries = [];
        const referencesDb = { async query(sql) {
            referenceQueries.push(sql);
            return { rows: [{ case_id: 'P1', case_kind: 'građevinska dozvola', g: ring, area: 100 }] };
        } };
        const model = await (await import('../floor-plans/site-model.js')).siteModel(localDb, current.url, { referencesDb });
        expect(model.siblings).toEqual(['https://a/1', 'https://a/2']);
        expect(model.footprint).toMatchObject({ source: 'permit-footprint', caseId: 'P1' });
        expect(referenceQueries).toHaveLength(1);
        expect(referenceQueries[0]).toContain('public.edozvola_feature');
        expect(localQueries.every(sql => !/public\.(?:edozvola_feature|gdi_building_3d|parcel|street)\b/.test(sql))).toBe(true);
    });
});
