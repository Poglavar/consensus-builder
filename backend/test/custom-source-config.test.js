import { describe, expect, it, vi } from 'vitest';
import { encodeCustomSource, decodeCustomSource } from '../parcels/custom-source-config.js';
import { createParcelSource, parcelSourceForCity, resolveParcelSourceDescriptor } from '../parcels/sources.js';

const input = { adapter: 'arcgis', endpoint: 'https://public.example/FeatureServer/0', cityIds: ['test_city'],
    metricSrid: 32633, idField: 'parcelid', objectIdField: 'OBJECTID', idType: 'string', outFields: ['parcelid', 'OBJECTID'] };
const payload = id => JSON.parse(Buffer.from(id.slice(7), 'base64url').toString('utf8'));
const pack = data => 'custom.' + Buffer.from(JSON.stringify(data)).toString('base64url');
const polygon = { type: 'Polygon', coordinates: [[[15,45],[15.0001,45],[15.0001,45.0001],[15,45.0001],[15,45]]] };

describe('portable custom source configurations', () => {
    it('reconstructs a source without stored configuration and preserves native IDs under a deterministic namespace', async () => {
        const id = encodeCustomSource(input), decoded = decodeCustomSource(id);
        expect(decoded).toMatchObject({ ...input, id, defaultForCity: false, name: 'public.example (arcgis)',
            pageSize: 250, maxFeatures: 5000, maxBboxKm2: 1, maxSnapshotBytes: 8388608, maxSnapshotFeatures: 5000 });
        expect(decoded.idPrefix).toMatch(/^CUSTOM-[0-9a-f]{20}-$/);
        expect(resolveParcelSourceDescriptor(id)).toEqual(decoded);
        expect(decodeCustomSource(id)).toEqual(decoded);
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false,
            features: [{ type: 'Feature', properties: { parcelid: '00042-A', OBJECTID: 1 }, geometry: polygon }] })));
        const adapter = createParcelSource({ id, endpoint: 'https://127.0.0.1', idPrefix: 'TAMPERED-', idField: 'wrong', maxBboxKm2: 99999, pageSize: 99999 }, { fetchImpl });
        const result = await adapter.queryIds([decoded.idPrefix + '00042-A']);
        expect(result.features[0]).toMatchObject({ id: decoded.idPrefix + '00042-A', properties: { sourceParcelId: '00042-A' } });
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe(input.endpoint + '/query');
        expect(url.searchParams.get('where')).toBe("parcelid IN ('00042-A')");
        expect(url.searchParams.get('resultRecordCount')).toBe('250');
        await expect(adapter.queryBounds([15,45,15.1,45.1])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it('canonicalizes field order and HTTPS host/default port before hashing, while distinguishing real configuration changes', () => {
        const reversed = Object.fromEntries(Object.entries(input).reverse());
        expect(encodeCustomSource({ ...reversed, endpoint: 'https://PUBLIC.EXAMPLE:443/FeatureServer/0' })).toBe(encodeCustomSource(input));
        for (const change of [{ cityIds: ['other_city'] }, { idField: 'OBJECTID' }, { metricSrid: 32733 },
            { endpoint: input.endpoint + '/different' }]) {
            expect(decodeCustomSource(encodeCustomSource({ ...input, ...change })).idPrefix)
                .not.toBe(decodeCustomSource(encodeCustomSource(input)).idPrefix);
        }
    });
    it('whitelists encoded configuration, strips caller limits/auth, and refuses tampered encoded extras or forged namespaces', () => {
        const id = encodeCustomSource({ ...input, name: 'forged', idPrefix: 'AR-', pageSize: 1000000, maxFeatures: Infinity,
            maxBboxKm2: 99999, headers: { Authorization: 'private' }, cookie: 'secret', accessToken: 'secret', caCertificate: '/private/file' });
        expect(id).toBe(encodeCustomSource(input));
        expect(payload(id)).not.toHaveProperty('headers');
        for (const change of [{ headers: { Authorization: 'secret' } }, { maxFeatures: 99999 }, { idPrefix: 'AR-' },
            { cityIds: ['other_city'] }, { endpoint: 'https://127.0.0.1' }, { name: 'forged' }]) {
            expect(() => decodeCustomSource(pack({ ...payload(id), ...change }))).toThrow(/Invalid custom/);
        }
        expect(() => decodeCustomSource(pack(Object.fromEntries(Object.entries(payload(id)).reverse())))).toThrow();
    });
    it('restricts explicit selection to its declared city without changing the city default', () => {
        const id = encodeCustomSource(input), selected = parcelSourceForCity('test_city', id);
        expect(selected.descriptor.id).toBe(id); expect(selected.descriptor.cityIds).toEqual(['test_city']);
        expect(parcelSourceForCity('test_city')).toBeNull();
        expect(() => parcelSourceForCity('other_city', id)).toThrow(expect.objectContaining({ status: 400, code: 'invalid-parcel-source' }));
        expect(() => createParcelSource({ id: pack({ ...payload(id), cityIds: ['other_city'] }) })).toThrow();
    });
    it.each(['http://public.example/0', 'https://public.example:8443/0', 'https://user:secret@public.example/0',
        'https://127.0.0.1/0', 'https://[::ffff:127.0.0.1]/0', 'https://169.254.169.254/0',
        'https://public.example/0?token=secret', 'https://public.example/0?api_key=secret',
        'https://public.example/0?access_token=secret', 'https://public.example/0?signature=secret'])('rejects unsafe endpoint %s', endpoint => {
        expect(() => encodeCustomSource({ ...input, endpoint })).toThrow(expect.objectContaining({ status: 400 }));
    });
    it.each([{ outFields: ['*'] }, { outFields: ['parcelid; DROP TABLE x'] }, { outFields: ['parcelid', '\nOBJECTID'] },
        { outFields: [] }, { outFields: ['OBJECTID'] }, { objectIdField: 'missing' }, { parcelNumberField: 'missing' },
        { geometryField: 'geom;bad' }, { idFields: ['missing'] }, { outFields: Array(41).fill('parcelid') },
        { metricSrid: 0 }, { metricSrid: 1999 }, { metricSrid: 100000 }, { metricSrid: 32633.5 }, { metricSrid: '32633' },
        { cityIds: ['test-city'] }, { cityIds: ['test_city', 'other_city'] }, { idType: 'float' }, { adapter: 'shell' },
        { boundsQueryMode: 'unbounded' }, { bbox: [0,0,0,1] }, { bbox: [-181,0,1,1] },
        { expectedSnapshotFeatures: 5001 }, { expectedSnapshotFeatures: -1 }, { expectedEtag: 'unquoted' }])('rejects invalid metadata %#', change => {
        expect(() => encodeCustomSource({ ...input, ...change })).toThrow(expect.objectContaining({ status: 400 }));
    });
    it.each(['custom.', 'custom.not_json', 'other.e30', 'custom.' + 'a'.repeat(3401), null, 42])('rejects malformed portable ID %#', id => {
        expect(() => decodeCustomSource(id)).toThrow(expect.objectContaining({ status: 400 }));
    });
});
