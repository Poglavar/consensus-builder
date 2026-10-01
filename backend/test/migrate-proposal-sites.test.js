// The site migration's classifier (scripts/migrate-proposal-sites.mjs): every row gets a site and a
// binding that records its CURRENT declaration unchanged; a recomputed binding that differs is
// reported (missing / extra) and never written into the declaration.
import { describe, expect, it } from 'vitest';
import {
    MIGRATION_ID,
    MIGRATION_SOURCE,
    classifySiteRow,
    intrusionBucket,
    parseArgs,
    siteSourceOf
} from '../scripts/migrate-proposal-sites.mjs';

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const SITE = { type: 'MultiPolygon', coordinates: [box(15.97, 45.8, 15.971, 45.801).coordinates] };
const row = (overrides = {}) => ({
    id: 7,
    type: 'structure',
    cadastre_parcel_ids: ['HR-1-A', 'HR-1-B'],
    proposal_data: { goal: 'park', cadastreParcelIds: ['HR-1-A', 'HR-1-B'] },
    structure_proposal: { kind: 'park', geometry: box(15.97, 45.8, 15.971, 45.801) },
    site: null,
    binding: null,
    ...overrides
});
const recomputed = (parcels, extra = {}) => ({
    parcels: parcels.map(([parcelId, intrusionM]) => ({ parcelId, overlapM2: 10, intrusionM })),
    touched: [{ parcelId: 'HR-1-B', overlapM2: 0.0001, intrusionM: 0.0005 }],
    coverage: 'complete',
    unsurveyedM2: 0,
    unknownM2: 0,
    siteM2: 9000,
    ...extra
});

describe('classifySiteRow', () => {
    it('records the current declaration as the binding when the recomputation agrees', () => {
        const result = classifySiteRow(row(), { site: SITE, binding: recomputed([['HR-1-A', 30], ['HR-1-B', 2]]) }, { now: 'T' });
        expect(result.class).toBe('migratable');
        expect(result.site).toBe(SITE);
        expect(result.binding).toMatchObject({
            parcels: [{ parcelId: 'HR-1-A', overlapM2: 10, intrusionM: 30 }, { parcelId: 'HR-1-B', overlapM2: 10, intrusionM: 2 }],
            toleranceM: 0,
            coverage: 'complete',
            source: MIGRATION_SOURCE,
            subject: 'declared',
            computedAt: 'T',
            migration: MIGRATION_ID
        });
        expect(result.binding).not.toHaveProperty('recomputedDiffers');
        expect(result.missing).toEqual([]);
        expect(result.extra).toEqual([]);
    });

    it('reports, and does not rewrite, a declaration the new rule disagrees with', () => {
        // The site reaches 4 cm into C (undeclared) and only touches B (declared) below the floor.
        const result = classifySiteRow(row(), { site: SITE, binding: recomputed([['HR-1-A', 30], ['HR-1-C', 0.04]]) });
        expect(result.class).toBe('migratable');
        expect(result.missing).toEqual(['HR-1-C']);
        expect(result.extra).toEqual(['HR-1-B']);
        expect(result.missingIntrusionM).toEqual([0.04]);
        expect(result.binding.parcels.map(p => p.parcelId)).toEqual(['HR-1-A', 'HR-1-B']); // the declaration
        expect(result.binding.parcels[1]).toMatchObject({ intrusionM: 0.0005 }); // measured, though unbound
        expect(result.binding.recomputedDiffers).toEqual({ missing: ['HR-1-C'], extra: ['HR-1-B'] });
    });

    it('keeps a declaration it cannot verify (cadastre not held) without inventing a difference', () => {
        const result = classifySiteRow(row({ cadastre_parcel_ids: ['BG-1-2'] }), {
            site: SITE, binding: { parcels: [], touched: [], coverage: 'unknown', unsurveyedM2: 0, unknownM2: 9000, siteM2: 9000 }
        });
        expect(result.binding).toMatchObject({ coverage: 'unknown', subject: 'declared-unverified', parcels: [{ parcelId: 'BG-1-2', overlapM2: null }] });
        expect(result.missing).toEqual([]);
        expect(result.extra).toEqual([]);
    });

    it('skips rows that are already done, have no declaration, or could not be measured', () => {
        expect(classifySiteRow(row({ site: SITE, binding: { parcels: [] } }), null).class).toBe('done');
        expect(classifySiteRow(row({ cadastre_parcel_ids: null }), { site: SITE, binding: recomputed([]) })).toMatchObject({ class: 'skipped', reason: 'no-declaration' });
        expect(classifySiteRow(row(), { error: { code: 'too-many-parcels', message: 'x' } })).toMatchObject({ class: 'skipped', reason: 'too-many-parcels' });
        expect(classifySiteRow(row(), { site: null, binding: recomputed([]) })).toMatchObject({ class: 'skipped', reason: 'no-site' });
    });
});

describe('siteSourceOf', () => {
    it('uses the footprint when there is one, else the declared parcels', () => {
        expect(siteSourceOf(row()).kind).toBe('footprint');
        expect(siteSourceOf(row({ structure_proposal: null, proposal_data: { goal: 'ownership-transfer' } })).kind).toBe('declared-parcels');
        expect(siteSourceOf(row({ structure_proposal: { geometry: { type: 'Polygon', coordinates: 'x' } } })).kind).toBe('invalid-footprint');
    });
});

describe('report and CLI', () => {
    it('buckets intrusion widths', () => {
        expect([0.004, 0.05, 0.5, 3, null].map(intrusionBucket)).toEqual(['<1cm', '1-10cm', '10cm-1m', '>=1m', 'unmeasured']);
    });

    it('dry-runs by default and refuses conflicting modes', () => {
        expect(parseArgs([])).toMatchObject({ apply: false, restore: false, help: false });
        expect(parseArgs(['--apply', '--ids', '1,2'])).toMatchObject({ apply: true, ids: [1, 2] });
        expect(() => parseArgs(['--apply', '--restore'])).toThrow(/either/);
        expect(() => parseArgs(['--ids', 'x'])).toThrow(/numeric/);
        expect(parseArgs(['--help']).help).toBe(true);
    });
});
