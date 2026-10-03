// Exercises counted Socrata reads, stable ground identities, publication changes and failed-query isolation.
import { describe, expect, it, vi } from 'vitest';
import { createSocrataParcelSource } from '../parcels/socrata-source.js';
const descriptor = { id: 'sf-test', endpoint: 'https://provider.example/resource/acdm-wktn.json',
    idField: 'mapblklot', idType: 'string', idPattern: '^[0-9]{7}$', idPrefix: 'US-CA-SF-',
    objectIdField: 'blklot', geometryField: 'shape', versionField: 'data_loaded_at', outFields: ['mapblklot', 'blklot', 'active', 'pw_recorded_map', 'data_loaded_at'],
    attributeFilters: { active: true, pw_recorded_map: true }, pageSize: 2, maxFeatures: 6 };
const bounds = [-122.4075, 37.7905, -122.4055, 37.792];
const polygon = (x = -122.407, y = 37.791) => ({ type: 'Polygon', coordinates: [[[x, y], [x + .0001, y], [x + .0001, y + .0001], [x, y + .0001], [x, y]]] });
const row = (id = '0257001') => ({ mapblklot: id, blklot: id, active: true, pw_recorded_map: true, data_loaded_at: '2026-10-01T11:29:23.524', shape: polygon(), owner: 'excluded' });
const count = (matched = '3', revision = '2026-10-01T11:29:23.524') => [{ matched, revision }];
const responses = entries => vi.fn(async () => {
    const entry = entries.shift();
    if (entry?.status) return { ok: false, status: entry.status };
    return { ok: true, json: async () => entry };
});
describe('Socrata parcel adapter', () => {
    it('publishes only complete ordered geometry pages between matching count/revision checks', async () => {
        const fetchImpl = responses([count(), [row('0257001'), row('0257002')], [row('0257003')], count()]);
        const r = await createSocrataParcelSource(descriptor, { fetchImpl }).queryBounds(bounds);
        expect(r).toMatchObject({ complete: true, sourceId: 'sf-test', returnsWGS84: true });
        expect(r.features.map(f => f.id)).toEqual(['US-CA-SF-0257001', 'US-CA-SF-0257002', 'US-CA-SF-0257003']);
        expect(r.features[0].properties.sourceProperties).not.toHaveProperty('shape');
        expect(r.features[0].properties.sourceProperties).not.toHaveProperty('owner');
        const urls = fetchImpl.mock.calls.map(([u]) => new URL(u));
        expect(urls[2].searchParams.get('$offset')).toBe('2');
        expect(urls[1].searchParams.get('$order')).toBe('mapblklot,blklot');
        expect(urls[1].searchParams.get('$select')).toBe('shape,mapblklot,blklot,active,pw_recorded_map,data_loaded_at');
        for (const u of urls) {
            expect(u.origin + u.pathname).toBe(descriptor.endpoint);
            expect(u.searchParams.get('$where')).toContain('(active = true AND pw_recorded_map = true)');
            expect(u.searchParams.get('$where')).toContain("intersects(shape,'POLYGON((-122.4075 37.7905,");
        }
        expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    });
    it('preserves leading-zero IDs and reports explicit absence after stable exact-query counts', async () => {
        const fetchImpl = responses([count('1'), [row('0257001')], count('1')]);
        const r = await createSocrataParcelSource(descriptor, { fetchImpl }).queryIds(['US-CA-SF-0257001', 'US-CA-SF-0257002']);
        expect(r.features[0].properties.sourceParcelId).toBe('0257001');
        expect(r.absentIds).toEqual(['US-CA-SF-0257002']);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('$where')).toContain("mapblklot IN ('0257001','0257002')");
    });
    it('requires two matching zero counts before returning an empty complete result', async () => {
        const fetchImpl = responses([[{ matched: '0' }], [{ matched: '0' }]]);
        const r = await createSocrataParcelSource(descriptor, { fetchImpl }).queryIds(['US-CA-SF-0257001']);
        expect(r).toMatchObject({ features: [], complete: true, absentIds: ['US-CA-SF-0257001'] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['missing count', [[]]], ['numeric count', [count(1)]], ['unknown count', [count('unknown')]],
        ['missing revision', [[{ matched: '1' }]]], ['too many matches', [count('7')]],
        ['empty early page', [count(), []]], ['page overflow', [count('2'), [row('0257001'), row('0257002'), row('0257003')]]],
        ['repeated native ID', [count(), [row(), row()]]],
        ['retired parcel', [count('1'), [{ ...row(), active: false }]]],
        ['assessment-only parcel', [count('1'), [{ ...row(), pw_recorded_map: false }]]],
        ['missing mapped key', [count('1'), [{ ...row(), mapblklot: null }]]],
        ['invalid polygon', [count('1'), [{ ...row(), shape: { type: 'Point', coordinates: [-122.4, 37.7] } }]]],
        ['changed matches', [count('1'), [row()], count('2')]],
        ['changed publication', [count('1'), [row()], count('1', '2026-10-02T00:00:00.000')]],
        ['JSON error payload', [{ error: 'provider error' }]], ['HTTP throttle', [{ status: 429 }]]
    ])('fails closed for %s', async (_name, entries) => {
        await expect(createSocrataParcelSource(descriptor, { fetchImpl: responses(entries) }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
    });
    it('collapses coincident assessment rows using the documented ground key, including a missing lowest APN', async () => {
        const fetchImpl = responses([count('2'), [{ ...row('2630064'), blklot: '2630065' }, { ...row('2630064'), blklot: '2630066' }], count('2')]);
        const r = await createSocrataParcelSource(descriptor, { fetchImpl }).queryIds(['US-CA-SF-2630064']);
        expect(r.features).toHaveLength(1);
        expect(r.features[0].id).toBe('US-CA-SF-2630064');
        expect(r.absentIds).toEqual([]);
    });
    it('rejects distinct geometry under one mapped ground key', async () => {
        const second = { ...row(), blklot: '0257002', shape: polygon(-122.406, 37.791) };
        await expect(createSocrataParcelSource(descriptor, { fetchImpl: responses([count('2'), [row(), second]]) }).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
    });
    it('rejects malformed IDs, excessive IDs and invalid geometry before network requests', async () => {
        const fetchImpl = vi.fn(); const a = createSocrataParcelSource(descriptor, { fetchImpl });
        for (const ids of [[], ['XX-0257001'], ["US-CA-SF-1' OR true"], Array(81).fill('US-CA-SF-0257001')]) await expect(a.queryIds(ids)).rejects.toMatchObject({ status: 400 });
        expect(() => a.queryBounds([0, 0, 10, 10])).toThrow(/large/);
        await expect(a.queryGeometry({ type: 'MultiPolygon', coordinates: [null] })).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('refuses a provider that ignores the exact-ID predicate', async () => {
        await expect(createSocrataParcelSource(descriptor, { fetchImpl: responses([count('1'), [row('0257002')], count('1')]) })
            .queryIds(['US-CA-SF-0257001'])).rejects.toMatchObject({ status: 502 });
    });
    it('keeps only intersecting parcels from an envelope footprint query', async () => {
        const target = { type: 'Polygon', coordinates: [[[-122.407, 37.791], [-122.406, 37.791], [-122.407, 37.792], [-122.407, 37.791]]] };
        const inside = row(); inside.shape = polygon(-122.4069, 37.7911);
        const outside = row('0257002'); outside.shape = polygon(-122.4062, 37.7918);
        const r = await createSocrataParcelSource(descriptor, { fetchImpl: responses([count('2'), [inside, outside], count('2')]) }).queryGeometry(target);
        expect(r.features.map(f => f.id)).toEqual(['US-CA-SF-0257001']);
    });
});
