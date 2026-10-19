import { describe, expect, it, vi } from 'vitest';
import { createShenzhenLandCertainSource, shenzhenLandCertainDescriptor } from '../parcels/shenzhen-source.js';

const CLIENT_KEY_FIXTURE = '00000000000000000000000000000000';
const nativeId = 'H101-0014';
const square = west => ({ type: 'Polygon', coordinates: [[[west, 22.54], [west + .0001, 22.54],
    [west + .0001, 22.5401], [west, 22.5401], [west, 22.54]]] });
const geoFeature = (oid = 7, id = nativeId, geometry = square(114.1)) => ({
    type: 'Feature', id: oid, properties: { OBJECTID: oid, PARCEL_NO: id, LOT_NO: '2000000067' }, geometry
});
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function publicScript({ rotate = false } = {}) {
    if (!rotate) return `function _0xarr(){var _0xvalues=['unused','${CLIENT_KEY_FIXTURE}'];_0xarr=function(){return _0xvalues};return _0xarr()}
function _0xdecode(a,b){var _0xtable=_0xarr();return _0xdecode=function(i,j){i=i-0x100;var _0xvalue=_0xtable[i];return _0xvalue},_0xdecode(a,b)}
function findFeature(){var _0xalias=_0xdecode;var opts={'X-OPENAPI-SubscriptionToken':_0xalias(0x101)}}`;
    return `(function(_0xtable,_0xtarget){var _0xcheck=_0xdecode;while(!![]){try{var _0xsum=parseInt(_0xcheck(0x100))/0x1;if(_0xsum===_0xtarget)break;else _0xtable.push(_0xtable.shift())}catch(_e){_0xtable.push(_0xtable.shift())}}}(_0xarr,0x1));
function _0xarr(){var _0xvalues=['${CLIENT_KEY_FIXTURE}','1','unused'];_0xarr=function(){return _0xvalues};return _0xarr()}
function _0xdecode(a,b){var _0xtable=_0xarr();return _0xdecode=function(i,j){i=i-0x100;var _0xvalue=_0xtable[i];return _0xvalue},_0xdecode(a,b)}
function findFeature(){var _0xalias=_0xdecode;var opts={'X-OPENAPI-SubscriptionToken':_0xalias(0x102)}}`;
}

function makeFetch({ features = [geoFeature()], count = features.length, objectIds = features.map(feature => feature.properties.OBJECTID) } = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        calls.push({ url, init });
        if (url.pathname.endsWith('/js/main.js')) return { ok: true, status: 200, text: async () => publicScript() };
        const params = new URLSearchParams(url.search);
        if (init.body) for (const [key, value] of new URLSearchParams(init.body)) params.set(key, value);
        if (params.has('returnCountOnly')) return response({ count });
        if (params.has('returnIdsOnly')) return response({ objectIdFieldName: 'OBJECTID', objectIds });
        return response({ type: 'FeatureCollection', features, exceededTransferLimit: false });
    });
    return { fetchImpl, calls };
}

describe('Shenzhen public land-right parcel source', () => {
    it('keeps a fixed endpoint and requests only native identifiers', () => {
        expect(shenzhenLandCertainDescriptor).toMatchObject({
            id: 'cn-shenzhen-land-certain', idField: 'PARCEL_NO', objectIdField: 'OBJECTID',
            boundsQueryMode: 'object-ids', metricSrid: 4547, outFields: ['OBJECTID', 'PARCEL_NO', 'LOT_NO']
        });
        expect(shenzhenLandCertainDescriptor.endpoint).toBe(
            'https://pnr.sz.gov.cn:8001/d-suplicmap/dynamap_1/rest/services/LAND_CERTAIN/MapServer/0'
        );
        expect(JSON.stringify(shenzhenLandCertainDescriptor)).not.toMatch(/token|subscription/i);
    });

    it('resolves the page-published key transiently and uses ID-first complete GeoJSON reads', async () => {
        const { fetchImpl, calls } = makeFetch();
        const source = createShenzhenLandCertainSource({ fetchImpl });
        const result = await source.queryBounds([114.1, 22.54, 114.101, 22.541]);

        expect(result).toMatchObject({ complete: true, returnsWGS84: true, sourceId: 'cn-shenzhen-land-certain' });
        expect(result.features).toHaveLength(1);
        expect(result.features[0]).toMatchObject({ id: 'CN-SZ-LANDCERTAIN-H101-0014',
            properties: { sourceParcelId: 'H101-0014', parcelNumber: 'H101-0014' } });
        expect(calls[0].url.href).toBe('https://pnr.sz.gov.cn/d-djtcx/djtcx/js/main.js');
        expect(calls[0].init.credentials).toBe('omit');
        const apiCalls = calls.slice(1);
        expect(apiCalls).toHaveLength(3); // count, ID manifest, exact object-ID geometry read
        expect(apiCalls.every(call => call.url.origin === 'https://pnr.sz.gov.cn:8001')).toBe(true);
        expect(apiCalls.every(call => call.init.headers['X-OPENAPI-SubscriptionToken'] === CLIENT_KEY_FIXTURE)).toBe(true);
        expect(apiCalls[0].url.searchParams.get('returnCountOnly')).toBe('true');
        expect(apiCalls[1].url.searchParams.get('returnIdsOnly')).toBe('true');
        expect(apiCalls[2].url.searchParams.get('objectIds')).toBe('7');
        expect(apiCalls[2].url.searchParams.get('f')).toBe('geojson');
        expect(apiCalls[2].url.searchParams.get('outFields')).toBe('OBJECTID,PARCEL_NO,LOT_NO');
        expect(apiCalls.some(call => call.url.searchParams.has('resultOffset'))).toBe(false);
    });

    it('resolves exact native PARCEL_NO requests through count, ID manifest, and exact OID reads', async () => {
        const { fetchImpl, calls } = makeFetch();
        const source = createShenzhenLandCertainSource({ fetchImpl });
        const result = await source.queryIds(['CN-SZ-LANDCERTAIN-H101-0014', 'CN-SZ-LANDCERTAIN-DOES-NOT-EXIST']);

        expect(result.absentIds).toEqual(['CN-SZ-LANDCERTAIN-DOES-NOT-EXIST']);
        expect(result.features.map(feature => feature.id)).toEqual(['CN-SZ-LANDCERTAIN-H101-0014']);
        const apiCalls = calls.slice(1);
        expect(apiCalls).toHaveLength(3);
        expect(apiCalls[0].url.searchParams.get('returnCountOnly')).toBe('true');
        expect(apiCalls[1].url.searchParams.get('returnIdsOnly')).toBe('true');
        expect(apiCalls[2].url.searchParams.get('objectIds')).toBe('7');
        expect(apiCalls[2].url.searchParams.has('resultRecordCount')).toBe(false);
    });

    it('rejects duplicate native keys instead of silently collapsing same or conflicting features', async () => {
        const duplicate = [geoFeature(7, nativeId), geoFeature(8, nativeId, square(114.1002))];
        const { fetchImpl } = makeFetch({ features: duplicate, count: 2, objectIds: [7, 8] });
        const source = createShenzhenLandCertainSource({ fetchImpl });
        await expect(source.queryIds([`CN-SZ-LANDCERTAIN-${nativeId}`])).rejects.toThrow(/duplicate native key/i);
    });

    it('rejects mismatched counts, duplicate or truncated manifests, and incomplete exact reads', async () => {
        const cases = [
            { count: 2, objectIds: [7], message: /manifest/i },
            { count: 1, objectIds: [7, 7], message: /manifest/i },
            { count: 1, objectIds: [7], features: [], message: /omitted object IDs/i }
        ];
        for (const scenario of cases) {
            const { fetchImpl } = makeFetch(scenario);
            const source = createShenzhenLandCertainSource({ fetchImpl });
            await expect(source.queryBounds([114.1, 22.54, 114.101, 22.541])).rejects.toThrow();
        }
    });

    it('treats a null object-ID manifest as a complete empty result only when the count is zero', async () => {
        const { fetchImpl } = makeFetch({ count: 0, objectIds: null, features: [] });
        const source = createShenzhenLandCertainSource({ fetchImpl });
        const result = await source.queryBounds([114.1, 22.54, 114.101, 22.541]);
        expect(result).toMatchObject({ complete: true, features: [] });
    });

    it('rejects invalid or conflicting geometry and tracks stable identity across overlapping reads', async () => {
        const invalid = geoFeature(7, nativeId, { type: 'Polygon', coordinates: [[[114.1, 22.54], [114.101, 22.54], [114.101, 22.541]]] });
        const invalidSource = createShenzhenLandCertainSource({ fetchImpl: makeFetch({ features: [invalid] }).fetchImpl });
        await expect(invalidSource.queryBounds([114.1, 22.54, 114.101, 22.541])).rejects.toThrow(/geometry/i);

        const second = geoFeature(7, nativeId, square(114.1002));
        let count = 0;
        const conflictingFetch = vi.fn(async (input, init = {}) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            if (url.pathname.endsWith('/js/main.js')) return { ok: true, status: 200, text: async () => publicScript() };
            const params = new URLSearchParams(url.search);
            if (params.has('returnCountOnly')) return response({ count: 1 });
            if (params.has('returnIdsOnly')) return response({ objectIdFieldName: 'OBJECTID', objectIds: [7] });
            count += 1;
            return response({ type: 'FeatureCollection', features: [count === 1 ? geoFeature() : second], exceededTransferLimit: false });
        });
        const conflictSource = createShenzhenLandCertainSource({ fetchImpl: conflictingFetch });
        await conflictSource.queryBounds([114.1, 22.54, 114.101, 22.541]);
        await expect(conflictSource.queryBounds([114.1, 22.54, 114.101, 22.541])).rejects.toThrow(/conflicting geometry/i);
    });

    it('uses the public source JS only on its fixed URL and refuses malformed IDs before provider calls', async () => {
        const { fetchImpl, calls } = makeFetch();
        const source = createShenzhenLandCertainSource({ fetchImpl });
        await expect(source.queryIds(['CN-SZ-LANDCERTAIN-x\' OR 1=1'])).rejects.toThrow(/invalid parcel ID/i);
        expect(calls).toHaveLength(0);
    });

    it('decodes a rotated published string table without evaluating provider code', async () => {
        const { fetchImpl } = makeFetch();
        fetchImpl.mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => publicScript({ rotate: true }) }));
        const source = createShenzhenLandCertainSource({ fetchImpl });
        await source.queryBounds([114.1, 22.54, 114.101, 22.541]);
        expect(fetchImpl.mock.calls[1][1].headers['X-OPENAPI-SubscriptionToken']).toBe(CLIENT_KEY_FIXTURE);
    });
});
