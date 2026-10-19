// The HR candidate search in the binding SQL computes the site once and searches it piece by piece.
// Inlined, the site was rebuilt for every scanned parcel and one bbox over a long track met 33k
// parcels: proposal 486 counted in 53 s and its binding-drift read hit nginx's 60 s (2026-10-16).
// The SQL itself runs against PostGIS only; old and new were compared on 13 prod records (identical).
import { describe, expect, it } from 'vitest';
import { BINDING_COUNT_SQL, BINDING_SQL } from '../proposals/binding.js';

describe('binding candidate search SQL', () => {
    it.each([['count', BINDING_COUNT_SQL], ['binding', BINDING_SQL]])('%s: the site CTEs are materialized', (_name, sql) => {
        expect(sql).toMatch(/site AS MATERIALIZED \(/);
        expect(sql).toMatch(/site_ds AS MATERIALIZED \(/);
        expect(sql).toMatch(/candidate_parcels AS MATERIALIZED \(/);
    });

    it.each([['count', BINDING_COUNT_SQL], ['binding', BINDING_SQL]])('%s: parcels are searched per subdivided piece, once each', (_name, sql) => {
        expect(sql).toMatch(/ST_Subdivide\(g, \d+\) AS g FROM site_ds/);
        expect(sql).toMatch(/SELECT DISTINCT ON \(p\.ctid\)[\s\S]*FROM site_pieces s\s+JOIN parcel p ON/);
        expect(sql).not.toMatch(/FROM site_ds s\s+JOIN parcel/);
    });

    it('the count and the binding read the same candidate set', () => {
        expect(BINDING_COUNT_SQL).toMatch(/count\(\*\)::int AS parcels FROM candidate_parcels/);
        expect(BINDING_SQL).toMatch(/FROM candidate_parcels p\s+\), hits AS/);
    });
});
