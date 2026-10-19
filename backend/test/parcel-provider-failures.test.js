import { describe, expect, it } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { createSocrataParcelSource } from '../parcels/socrata-source.js';
import { createOgcApiParcelSource } from '../parcels/ogc-api-source.js';
import { createGeojsonSnapshotParcelSource } from '../parcels/geojson-snapshot-source.js';
import { createShenzhenLandCertainSource } from '../parcels/shenzhen-source.js';
import { providerHttpError, upstreamError } from '../parcels/source-contract.js';

const BOUNDS = [-73.99, 40.73, -73.989, 40.731];
const upstreamResponse = (status, retryAfter) => ({
    ok: false,
    status,
    statusText: 'provider response includes https://private.example/?token=secret',
    url: 'https://user:secret@private.example/parcel?token=secret',
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null },
    json: async () => ({})
});
const failingFetch = (status, retryAfter) => async () => upstreamResponse(status, retryAfter);
const boundedSource = (factory, descriptor, fetchImpl) => factory(descriptor, { fetchImpl }).queryBounds(BOUNDS);

const descriptors = {
    arcgis: {
        id: 'test-arcgis', endpoint: 'https://provider.example/arcgis/MapServer/0',
        idField: 'PARCEL', objectIdField: 'OBJECTID', idPrefix: 'A-', outFields: ['OBJECTID', 'PARCEL'],
        pageSize: 20, maxFeatures: 100, idType: 'string'
    },
    wfs: {
        id: 'test-wfs', endpoint: 'https://provider.example/geoserver/wfs', featureType: 'cadastre:parcel',
        idField: 'parcel_id', idPrefix: 'W-', outFields: ['parcel_id'], idType: 'string', version: '2.0.0'
    },
    socrata: {
        id: 'test-socrata', endpoint: 'https://data.example/resource/abc.json', idField: 'parcel_id',
        idPrefix: 'S-', outFields: ['parcel_id', ':id', ':updated_at'], geometryField: 'the_geom',
        objectIdField: ':id', versionField: ':updated_at', idType: 'string'
    },
    ogc: {
        id: 'test-ogc', endpoint: 'https://data.example/collections/parcels/items', idField: 'parcel_id',
        idPrefix: 'O-', outFields: ['parcel_id'], idType: 'string'
    },
    snapshot: {
        id: 'test-snapshot', endpoint: 'https://data.example/parcels.geojson', idPrefix: 'G-',
        idFields: ['parcel_id'], outFields: ['parcel_id'], maxSnapshotFeatures: 100
    }
};

describe('parcel provider failure metadata', () => {
    it('maps access and rate-limit responses to stable gateway errors without copying provider details', () => {
        const blocked = providerHttpError(upstreamResponse(403));
        expect(blocked).toMatchObject({ status: 502, code: 'parcel-source-blocked', upstreamStatus: 403 });
        const limited = providerHttpError(upstreamResponse(429, '999999'));
        expect(limited).toMatchObject({ status: 502, code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 3600 });
        for (const error of [blocked, limited]) {
            expect(error.message).not.toContain('private.example');
            expect(error.message).not.toContain('secret');
        }
    });

    it('keeps other provider failures unavailable and bounds or omits malformed Retry-After', () => {
        expect(providerHttpError(503)).toMatchObject({ status: 502, code: 'parcel-source-unavailable', upstreamStatus: 503 });
        expect(providerHttpError(429, 'nonsense')).not.toHaveProperty('retryAfterSeconds');
        expect(providerHttpError(429, '-3')).not.toHaveProperty('retryAfterSeconds');
        expect(providerHttpError(429, '3')).toMatchObject({ retryAfterSeconds: 3 });
        expect(upstreamError('timeout', 504)).toMatchObject({ status: 504, code: 'parcel-source-unavailable' });
    });

    it.each([
        ['ArcGIS', createArcgisParcelSource, descriptors.arcgis],
        ['WFS', createWfsParcelSource, descriptors.wfs],
        ['Socrata', createSocrataParcelSource, descriptors.socrata],
        ['OGC API', createOgcApiParcelSource, descriptors.ogc],
        ['GeoJSON snapshot', createGeojsonSnapshotParcelSource, descriptors.snapshot]
    ])('maps HTTP 403 and 429 from %s', async (_name, factory, descriptor) => {
        await expect(boundedSource(factory, descriptor, failingFetch(403))).rejects.toMatchObject({
            status: 502, code: 'parcel-source-blocked', upstreamStatus: 403
        });
        await expect(boundedSource(factory, descriptor, failingFetch(429, '17'))).rejects.toMatchObject({
            status: 502, code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 17
        });
    });

    it('maps ArcGIS JSON error payloads including access denial and token-required codes', async () => {
        for (const upstreamStatus of [403, 499]) {
            const fetchImpl = async () => ({ ok: true, status: 200,
                json: async () => ({ error: { code: upstreamStatus, message: 'leaks https://user:secret@example.invalid' } }) });
            await expect(boundedSource(createArcgisParcelSource, descriptors.arcgis, fetchImpl)).rejects.toMatchObject({
                status: 502, code: 'parcel-source-blocked', upstreamStatus
            });
        }
    });

    it.each([[403, 'parcel-source-blocked'], [429, 'parcel-source-rate-limited']])(
        'maps Shenzhen layer HTTP %i without exposing the viewer key or endpoint', async (status, code) => {
            const fakePublishedKey = 'ab'.repeat(16);
            const script = `function _0xarr(){var _0xvalues=['unused','${fakePublishedKey}'];_0xarr=function(){return _0xvalues};return _0xarr()}
function _0xdecode(a,b){var _0xtable=_0xarr();return _0xdecode=function(i,j){i=i-0x100;var _0xvalue=_0xtable[i];return _0xvalue},_0xdecode(a,b)}
function findFeature(){var _0xalias=_0xdecode;var opts={'X-OPENAPI-SubscriptionToken':_0xalias(0x101)}}`;
            const fetchImpl = async input => new URL(input).pathname.endsWith('/js/main.js')
                ? { ok: true, status: 200, text: async () => script }
                : upstreamResponse(status, status === 429 ? '12' : undefined);
            const source = createShenzhenLandCertainSource({ fetchImpl });
            await expect(source.queryBounds([114.1, 22.54, 114.101, 22.541])).rejects.toMatchObject({
                status: 502, code, upstreamStatus: status,
                ...(status === 429 ? { retryAfterSeconds: 12 } : {})
            });
        }
    );

    it('hides network exception details and preserves 504 for timeouts', async () => {
        const offline = async () => { throw new Error('fetch failed for https://user:secret@example.invalid/?token=secret'); };
        let error;
        try { await boundedSource(createArcgisParcelSource, descriptors.arcgis, offline); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(error.message).not.toContain('example.invalid');
        expect(error.message).not.toContain('secret');

        const timeout = async (_url, { signal }) => {
            signal.dispatchEvent(new Event('abort'));
            const failure = new Error('timed out at https://secret.example');
            failure.name = 'AbortError';
            throw failure;
        };
        await expect(boundedSource(createArcgisParcelSource, descriptors.arcgis, timeout)).rejects.toMatchObject({
            status: 504, code: 'parcel-source-unavailable'
        });
    });
});
