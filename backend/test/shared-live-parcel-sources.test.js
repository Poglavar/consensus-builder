// Verifies shared provider selection, stable IDs and metric binding for additional city entries.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parcelSourceCatalog, parcelSourceForCity } from '../parcels/sources.js';
import { computeBinding } from '../proposals/binding.js';

const samples = ['lyon', 'rotterdam', 'cologne'].map(city => JSON.parse(readFileSync(
    new URL(`../../world-parcels/research/${city}-live-response.json`, import.meta.url), 'utf8')));
afterEach(() => vi.unstubAllGlobals());
describe.each(samples)('$city shared-provider city', sample => {
    it('selects the original provider with its original canonical namespace', () => {
        const source = parcelSourceForCity(sample.city);
        expect(source.descriptor.id).toBe(sample.sourceId);
        expect(source.descriptor.cityIds).toContain(sample.city);
        expect(sample.result.complete).toBe(true);
        expect(sample.exact.absentIds).toEqual([]);
        expect(sample.exact.features.map(f => f.id).sort()).toEqual(sample.result.features.map(f => f.id).sort());
    });
    it('binds a site through the shared provider without querying imported parcel tables', async () => {
        const { descriptor } = parcelSourceForCity(sample.city);
        const canonical = sample.result.features[0];
        const raw = { type: 'Feature', id: descriptor.idFromFeatureId ? canonical.properties.sourceParcelId : 'fixture.1',
            properties: { ...canonical.properties.sourceProperties, [descriptor.idField]: canonical.properties.sourceParcelId },
            geometry: canonical.geometry };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
            type: 'FeatureCollection', features: [raw], numberMatched: 1, numberReturned: 1, links: []
        }) })));
        const db = { query: vi.fn(async () => { throw new Error('unexpected imported parcel SQL'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: canonical.geometry });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(p => p.parcelId)).toContain(canonical.id);
    });
});

it('assigns each configured city to exactly one provider without duplicating providers or prefixes', () => {
    const cities = parcelSourceCatalog.sources.flatMap(s => s.cityIds);
    expect(new Set(cities).size).toBe(cities.length);
    for (const field of ['id', 'idPrefix']) {
        const values = parcelSourceCatalog.sources.map(s => s[field]);
        expect(new Set(values).size).toBe(values.length);
    }
    expect(parcelSourceCatalog.sources.every(s => !('cityId' in s))).toBe(true);
});
