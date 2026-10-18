// Coordinate evidence must be tied to the executable source contract and current native samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { alignmentContractHash, collectArcgisAlignment, createArcgisAlignmentObserver } from '../lib/parcel-alignment.mjs';
import { encodeArcgisCompositeId } from '../../backend/parcels/arcgis-source.js';

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

test('native proof maps a complete composite ArcGIS identity with the production delimiter codec', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-alignment-composite-'));
    try {
        const compositeDescriptor = { ...descriptor, idField: undefined, idFields: ['FIPS_CODE', 'PARCEL_APN'],
            idFieldTypes: { FIPS_CODE: 'string', PARCEL_APN: 'string' } };
        const values = ['06001', 'APN~7/2'];
        const compositeId = encodeArcgisCompositeId(values);
        assert.equal(compositeId, '06001~APN%7E7%2F2');
        const geometry = { type: 'Polygon', coordinates: [[[ -121, 37], [-120.999, 37], [-120.999, 36.999], [-121, 37]]] };
        const exactFeatures = new Map([[`SRC-${compositeId}`, {
            id: `SRC-${compositeId}`, geometry, properties: { sourceParcelId: compositeId }
        }]]);
        const reads = [{ params: new URLSearchParams('where=status%3D1'), features: [{ geometry,
            properties: { OBJECTID: 42, FIPS_CODE: values[0], PARCEL_APN: values[1] } }] }];
        const requests = [];
        const evidencePath = await collectArcgisAlignment({ descriptor: compositeDescriptor, cityCode: '123', exactFeatures,
            reads, outputDir: directory, fetchImpl: async input => {
                const request = new URL(input); requests.push(request);
                return new Response(JSON.stringify(request.pathname.endsWith('/query')
                    ? { spatialReference: { wkid: 3857 }, features: [{ attributes: { OBJECTID: 42 }, geometry: { rings: [[[1, 2], [3, 2], [3, 4], [1, 2]]] } }] }
                    : { spatialReference: { wkid: 3857 } }));
            } });
        assert.equal(requests[1].searchParams.get('objectIds'), '42');
        assert.equal(requests[1].searchParams.get('where'), 'status=1');
        const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
        assert.equal(JSON.parse(await fs.readFile(path.join(directory, evidence.nativeFile), 'utf8')).features[0].id,
            `SRC-${compositeId}`);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('native proof refuses absent or incomplete composite identities', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-alignment-composite-missing-'));
    try {
        const compositeDescriptor = { ...descriptor, idField: undefined, idFields: ['FIPS_CODE', 'PARCEL_APN'],
            idFieldTypes: { FIPS_CODE: 'string', PARCEL_APN: 'string' } };
        const compositeId = encodeArcgisCompositeId(['06001', 'APN-7']);
        const geometry = { type: 'Polygon', coordinates: [[[ -121, 37], [-120.999, 37], [-120.999, 36.999], [-121, 37]]] };
        const exactFeatures = new Map([[`SRC-${compositeId}`, {
            id: `SRC-${compositeId}`, geometry, properties: { sourceParcelId: compositeId }
        }]]);
        for (const properties of [{ OBJECTID: 42, FIPS_CODE: '06001' },
            { OBJECTID: 42, FIPS_CODE: '06001', PARCEL_APN: 'OTHER' }]) {
            await assert.rejects(collectArcgisAlignment({ descriptor: compositeDescriptor, cityCode: '123', exactFeatures,
                reads: [{ params: new URLSearchParams('where=status%3D1'), features: [{ geometry, properties }] }],
                outputDir: directory, fetchImpl: async () => new Response(JSON.stringify({ spatialReference: { wkid: 3857 } }))
            }), /source-specific identity\/geometry proof/);
        }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('multipart native geometry remains held without source-specific proof', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-alignment-parts-'));
    try {
        let requests = 0;
        await assert.rejects(collectArcgisAlignment({ descriptor: { ...descriptor, nativeGeometryMode: 'parts' },
            cityCode: '123', exactFeatures: new Map([['SRC-1', { id: 'SRC-1', properties: { sourceParcelId: '1' } }]]),
            reads: [], outputDir: directory, fetchImpl: async () => { requests++; return new Response('{}'); }
        }), /Multipart ArcGIS geometry needs a source-specific unchanged-native proof/);
        assert.equal(requests, 0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
