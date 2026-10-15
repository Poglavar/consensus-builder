// Coordinate evidence must be tied to the executable source contract and current native samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { alignmentContractHash, collectArcgisAlignment, createArcgisAlignmentObserver } from '../lib/parcel-alignment.mjs';

const descriptor = { id: 'public-source', adapter: 'arcgis', endpoint: 'https://example.gov/MapServer/0',
    idPrefix: 'SRC-', idField: 'UPID', objectIdField: 'OBJECTID', outFields: ['UPID', 'OBJECTID'] };

test('coordinate contract changes with CRS, axis-related parameters or source identity, not a city metric', () => {
    const original = alignmentContractHash(descriptor);
    assert.equal(alignmentContractHash({ metricSrid: 32735, cityIds: ['elsewhere'], ...descriptor }), original);
    for (const change of [{ responseSrid: 3857 }, { boundsProjection: 'EPSG:3857' }, { endpoint: 'https://other.gov/MapServer/0' },
        { responseCoordinatePrecision: 4 }, { attributeFilters: { status: 'current' } }]) {
        assert.notEqual(alignmentContractHash({ ...descriptor, ...change }), original);
    }
});

test('native proof preserves production predicates, safe IDs, source CRS and original rings', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-alignment-'));
    try {
        const geometry = { type: 'Polygon', coordinates: [[[25.85, -17.84], [25.851, -17.84], [25.851, -17.841], [25.85, -17.84]]] };
        const reads = [];
        const url = new URL('https://example.gov/MapServer/0/query?where=UPID%3D%27LIV%2F7%27%20AND%20status%3D1&returnGeometry=true&outSR=4326&f=geojson');
        await createArcgisAlignmentObserver(descriptor, reads)({ url, init: {}, response: new Response(JSON.stringify({ features: [{
            geometry, properties: { UPID: 'LIV/7', OBJECTID: 7, owner: 'must not survive' } }] })) });
        assert.deepEqual(reads[0].features[0].properties, { UPID: 'LIV/7', OBJECTID: 7 });
        const exactFeatures = new Map([['SRC-LIV/7', { id: 'SRC-LIV/7', geometry, properties: { sourceParcelId: 'LIV/7' } }]]);
        const rings = [[[590000, 8027000], [590010, 8027000], [590010, 8027010], [590000, 8027000]]];
        const requests = [];
        const evidencePath = await collectArcgisAlignment({ descriptor, cityCode: '580', exactFeatures, reads,
            outputDir: directory, fetchImpl: async input => {
                const request = new URL(input); requests.push(request);
                return new Response(JSON.stringify(request.pathname.endsWith('/query')
                    ? { spatialReference: { wkid: 32735 }, features: [{ attributes: { OBJECTID: 7 }, geometry: { rings } }] }
                    : { sourceSpatialReference: { wkid: 32735 }, extent: { spatialReference: { wkid: 3857 } } }));
            } });
        const request = requests[1];
        assert.equal(request.searchParams.get('where'), "UPID='LIV/7' AND status=1");
        assert.equal(request.searchParams.get('outSR'), '32735');
        assert.equal(request.searchParams.get('objectIds'), '7');
        const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
        assert.equal(evidence.nativeCrs, 'EPSG:32735');
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, evidence.nativeFile), 'utf8')).features[0],
            { id: 'SRC-LIV/7', geometry: { rings } });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
