import { describe, expect, it, vi } from 'vitest';
import { createPulsePublicFetch } from '../parcels/pulse-public-source.js';
import { createParcelSource } from '../parcels/sources.js';

const endpoint = 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/25';
const query = `${endpoint}/query?f=json`;
const epoch = Date.parse('2026-10-09T00:00:00Z');
const response = body => ({ ok: true, status: 200, json: async () => body });
const access = token => response({ success: true, token, expiresAt: new Date(epoch + 3600000).toISOString() });

describe('PULSE anonymous public reader', () => {
    it('shares one bootstrap across simultaneous reads and refreshes before expiry', async () => {
        let time = epoch, count = 0;
        const calls = [];
        const fetchImpl = vi.fn(async (url, options) => {
            calls.push({ url: new URL(url), options });
            return url.endsWith('/api/gis/token') ? access(`public-reader-${++count}`) : response({});
        });
        const fetch = createPulsePublicFetch(endpoint, { fetchImpl, now: () => time });
        await Promise.all([fetch(query), fetch(query)]);
        expect(count).toBe(1);
        expect(calls.slice(1).map(c => c.url.searchParams.get('token'))).toEqual(['public-reader-1', 'public-reader-1']);
        expect(calls.slice(1).every(c => c.options.headers.get('Referer') === 'https://lis.pulse.gop.pk/')).toBe(true);
        time += 3571000;
        await fetch(query);
        expect(count).toBe(2);
        expect(calls.at(-1).url.searchParams.get('token')).toBe('public-reader-2');
    });

    it('rejects invalid, expired and blocked bootstrap responses without a parcel request', async () => {
        for (const body of [{ success: false, token: 'private-value' },
            { success: true, token: 'private-value', expiresAt: new Date(epoch).toISOString() },
            { success: true, token: 'private-value', expiresAt: 'invalid' }]) {
            const fetchImpl = vi.fn(async () => response(body));
            await expect(createPulsePublicFetch(endpoint, { fetchImpl, now: () => epoch })(query))
                .rejects.toMatchObject({ code: 'parcel-source-unavailable' });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }));
        await expect(createPulsePublicFetch(endpoint, { fetchImpl })(query))
            .rejects.toMatchObject({ code: 'parcel-source-blocked', upstreamStatus: 403 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('renews timezone-free publisher expiries without assuming the server timezone', async () => {
        let time = epoch, count = 0;
        const fetchImpl = vi.fn(async url => url.endsWith('/api/gis/token')
            ? response({ success: true, token: `reader-${++count}`, expiresAt: '2026-10-09T12:00:00' })
            : response({}));
        const fetch = createPulsePublicFetch(endpoint, { fetchImpl, now: () => time });
        await fetch(query);
        time += 29000;
        await fetch(query);
        expect(count).toBe(1);
        time += 1001;
        await fetch(query);
        expect(count).toBe(2);
    });

    it('returns unchanged complete native-ID geometry through the configured adapter', async () => {
        const geometry = { type: 'Polygon', coordinates: [[[73.45, 30.8], [73.451, 30.8],
            [73.451, 30.801], [73.45, 30.8]]] };
        const fetchImpl = vi.fn(async url => url.endsWith('/api/gis/token')
            ? response({ success: true, token: 'reader-value', expiresAt: new Date(Date.now() + 3600000).toISOString() })
            : response({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 17,
                properties: { OBJECTID: 17 }, geometry }], exceededTransferLimit: false }));
        const source = createParcelSource({ id: 'test-pulse', adapter: 'pulse-public', endpoint,
            idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer', idPrefix: 'PK-PULSE-', outFields: ['OBJECTID'] }, { fetchImpl });
        const result = await source.queryIds(['PK-PULSE-17']);
        expect(result.complete).toBe(true);
        expect(result.features[0].id).toBe('PK-PULSE-17');
        expect(result.features[0].geometry).toEqual(geometry);
        expect(JSON.stringify(result)).not.toContain('reader-value');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never sends the reader token to another layer or origin', async () => {
        const fetchImpl = vi.fn();
        const fetch = createPulsePublicFetch(endpoint, { fetchImpl });
        for (const url of ['https://example.test/query', query.replace('/25/', '/30/'), `${query}&token=caller-token`]) {
            await expect(fetch(url)).rejects.toThrow('configured layer');
        }
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(() => createPulsePublicFetch('https://example.test/MapServer/25')).toThrow('endpoint');
    });

    it('removes token-bearing network errors and does not retry blocked parcel responses', async () => {
        const fetchImpl = vi.fn(async url => {
            if (url.endsWith('/api/gis/token')) return access('private-value');
            throw Error(`connection failed: ${url}`);
        });
        const fetch = createPulsePublicFetch(endpoint, { fetchImpl, now: () => epoch });
        const error = await fetch(query).catch(error => error);
        expect(error.message).toBe('Public parcel provider is unavailable.');
        expect(error.cause).toBeUndefined();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const blocked = vi.fn(async url => url.endsWith('/api/gis/token')
            ? response({ success: true, token: 'private-value', expiresAt: new Date(Date.now() + 3600000).toISOString() })
            : { ok: false, status: 403 });
        const source = createParcelSource({ id: 'test-pulse', adapter: 'pulse-public', endpoint,
            idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer', idPrefix: 'PK-PULSE-', outFields: ['OBJECTID'] }, { fetchImpl: blocked });
        await expect(source.queryIds(['PK-PULSE-1'])).rejects.toMatchObject({ code: 'parcel-source-blocked' });
        expect(blocked).toHaveBeenCalledTimes(2);
    });
});
