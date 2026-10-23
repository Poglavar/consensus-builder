import { describe, expect, it, vi } from 'vitest';
import { computeBinding, parcelActBinding, publicationCityOf } from '../proposals/binding.js';
import { sourceServes } from '../proposals/publication-city.js';
import { nycDatabaseSource, nycParcelIds } from '../parcels/nyc-database-source.js';

const site = { type: 'Polygon', coordinates: [[[-74.0062,40.7127],[-74.0059,40.7127],[-74.0059,40.713],[-74.0062,40.713],[-74.0062,40.7127]]] };
const id = 'US-NY-6201001001220001';
const row = { geom_id: 1, geom: site, swis_sbl_ids: ['6201001001220001'] };
const pool = (rows = [row]) => ({ query: vi.fn(async () => ({ rows })) });

describe('imported NYC parcel binding', () => {
    it.each([null, 'parcel-nyc'])('binds the default map footprints with source %s, without HR cadastre queries', async parcelSourceId => {
        const db = pool();
        const result = await computeBinding(db, { site, city: 'new_york', parcelSourceId });
        expect(result.binding).toMatchObject({ source: 'server:parcel-nyc', coverage: 'complete', unknownM2: 0,
            parcelSource: { sourceId: 'parcel-nyc', snapshotId: null }, parcels: [{ parcelId: id }] });
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('FROM parcel_nyc_geom g');
        expect(sql).toContain('ST_Intersects');
        expect(sql).toContain('LIMIT 5001');
        expect(sql).not.toContain('cadastral_municipality');
        expect(JSON.parse(params[0])).toEqual({ type: 'MultiPolygon', coordinates: [site.coordinates] });
    });
    it('recognizes the imported source while preserving an explicit live DOF source choice', () => {
        expect(sourceServes('parcel-nyc', 'new_york')).toBe(true);
        expect(sourceServes('parcel-nyc', 'toronto')).toBe(false);
        expect(sourceServes(null, 'new_york')).toBe(false);
        expect(publicationCityOf({ site, city: 'new_york', parcelSourceId: 'parcel-nyc' }))
            .toEqual({ city: 'new_york', parcelSourceId: 'parcel-nyc' });
        expect(publicationCityOf({ site, city: 'new_york', parcelSourceId: 'us-nyc-dof-digital-tax-map' }))
            .toEqual({ city: 'new_york', parcelSourceId: 'us-nyc-dof-digital-tax-map' });
        expect(() => publicationCityOf({ site, city: 'new_york', parcelSourceId: 'not-a-source' })).toThrow();
    });
    it('uses the same sorted footprint identity for condo rows, independently of unit order', async () => {
        expect(nycParcelIds({ swis_sbl_ids: ['2', '1', '2', null] })).toEqual(['1', '2']);
        const result = await nycDatabaseSource(pool([{ ...row, swis_sbl_ids: ['2', '1'] }])).queryGeometry(site);
        expect(result.features[0].properties.parcelId).toBe('US-NY-1');
    });
    it('resolves declared imported parcel IDs and reports actual absences', async () => {
        const db = pool();
        const result = await parcelActBinding(db, [id, 'US-NY-absent']);
        expect(result.extra).toEqual(['US-NY-absent']);
        expect(result.binding).toMatchObject({ coverage: 'complete', source: 'server:parcel-nyc',
            subject: 'declared-parcels', parcels: [{ parcelId: id }] });
        expect(db.query.mock.calls[0][1]).toEqual([['6201001001220001', 'absent']]);
    });
    it('does not replace a declared condo unit with a different canonical footprint ID', async () => {
        const result = await parcelActBinding(pool([{ ...row, swis_sbl_ids: ['2', '1'] }]), ['US-NY-2']);
        expect(result.extra).toEqual(['US-NY-2']);
        expect(result.binding.parcels).toEqual([]);
    });
    it('refuses truncated queries and malformed parcels instead of certifying empty land', async () => {
        await expect(computeBinding(pool(Array(5001).fill(row)), { site, city: 'new_york' })).rejects.toThrow('complete');
        await expect(computeBinding(pool([{ ...row, swis_sbl_ids: [] }]), { site, city: 'new_york' })).rejects.toThrow('identity');
        await expect(computeBinding(pool([{ ...row, geom: null }]), { site, city: 'new_york' })).rejects.toThrow('geometry');
    });
    it('propagates database failures rather than falling back to the Croatian cadastre', async () => {
        const db = { query: vi.fn(async () => { throw new Error('NYC source offline'); }) };
        await expect(computeBinding(db, { site, city: 'new_york' })).rejects.toThrow('NYC source offline');
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});
