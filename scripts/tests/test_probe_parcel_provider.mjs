// Regression coverage for canonical, safely normalized WGS84 provider samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDescriptor, safeRequestUrl, safeSample, searchLocations } from '../probe-parcel-provider.mjs';
import { geometryParcelFeature } from '../../backend/parcels/geometry-identity.js';

test('logs the HMLR archive resource without its presigned S3 credentials', () => {
    assert.equal(safeRequestUrl('https://datapub-prd-s3-bucket.s3.amazonaws.com/inspire/oxford.zip?X-Amz-Credential=private&X-Amz-Signature=secret'),
        'https://datapub-prd-s3-bucket.s3.amazonaws.com/inspire/oxford.zip');
    assert.equal(safeRequestUrl('https://provider.example/query?where=ID%3D42&returnGeometry=true'),
        'https://provider.example/query?where=ID%3D42&returnGeometry=true');
});

const coordinates = [[[-86.2588,39.8166],[-86.2583,39.8166],[-86.2583,39.8171],[-86.2588,39.8171],[-86.2588,39.8166]]];
const feature = (geometry = { type:'Polygon', coordinates, crs:null }) => ({
    type:'Feature',
    properties:{ sourceId:'us-in-marion-indianapolis-parcels', sourceParcelId:'1254426', parcelId:'US-IN-MARION-1254426' },
    geometry
});

test('canonicalizes a WGS84 sample and removes only legacy null geometry CRS metadata', () => {
    const sample = safeSample(feature(), 'us-in-marion-indianapolis-parcels', { returnsWGS84:true });
    assert.deepEqual(sample, {
        type:'Feature',
        properties:{ id:'1254426' },
        geometry:{ type:'Polygon', coordinates }
    });
});

test('drops a recognized WGS84 geometry CRS only after the adapter confirms normalized coordinates', () => {
    const geometry = { type:'Polygon', coordinates, crs:{ type:'name', properties:{ name:'EPSG:4326' } } };
    assert.deepEqual(safeSample(feature(geometry), 'us-in-marion-indianapolis-parcels', { returnsWGS84:true }).geometry,
        { type:'Polygon', coordinates });
    assert.throws(() => safeSample(feature(), 'us-in-marion-indianapolis-parcels'), /invalid native parcel identity or geometry/);
});

test('rejects unknown CRS metadata instead of stripping it', () => {
    const geometry = { type:'Polygon', coordinates, crs:{ type:'name', properties:{ name:'EPSG:3857' } } };
    assert.throws(() => safeSample(feature(geometry), 'us-in-marion-indianapolis-parcels', { returnsWGS84:true }),
        /outside the canonical WGS84 polygon contract/);
});

test('rejects coordinates outside geographic longitude and latitude bounds', () => {
    const projectedCoordinates = [[[500000,4400000],[500010,4400000],[500010,4400010],[500000,4400010],[500000,4400000]]];
    assert.throws(() => safeSample(feature({ type:'Polygon', coordinates:projectedCoordinates, crs:null }),
        'us-in-marion-indianapolis-parcels', { returnsWGS84:true }), /outside the canonical WGS84 polygon contract/);
});

test('searches the 3x3 core grid first, then each provider ring at eight bearings', () => {
    const locations = searchLocations([45, 15], [400, 1200]);
    assert.equal(locations.length, 9 + 16);
    assert.deepEqual(locations.slice(0, 9).map(l => l.ringM), Array(9).fill(0));
    const north = locations.find(l => l.ringM === 400);
    assert.ok(Math.abs((north.point[1] - 45) * 111_320 - 400) < 1e-6 && north.point[0] === 15);
    const east = locations.filter(l => l.ringM === 1200)[2];
    assert.ok(Math.abs((east.point[0] - 15) * 111_320 * Math.cos(45 * Math.PI / 180) - 1200) < 1e-6);
    assert.equal(searchLocations([45, 15], []).length, 9);
    assert.throws(() => searchLocations([45, 15], undefined), /Search rings/);
    assert.throws(() => searchLocations([45, 15], [-5]), /Search rings/);
});

test('keeps published fields only for a provider whose own profile declares them, never unsafe ones', () => {
    const tkgm = { id:'tr', adapter:'tkgm-point', idField:'nativeId', parcelNumberField:'parselNo', outFields:['mahalleId','adaNo','parselNo'] };
    assert.deepEqual(safeDescriptor(tkgm).outFields, ['nativeId']);
    assert.equal(safeDescriptor(tkgm).parcelNumberField, undefined);
    const declared = safeDescriptor({ ...tkgm, discovery:{ keepPublishedFields:true } });
    assert.deepEqual(declared.outFields, ['mahalleId','adaNo','parselNo']);
    assert.equal(declared.parcelNumberField, 'parselNo');
    assert.throws(() => safeDescriptor({ ...tkgm, outFields:['mahalleId','ownerName'], discovery:{ keepPublishedFields:true } }), /safe field allowlist/);
});

test('retains validated geometry references without inventing a native cadastral ID', () => {
    const descriptor = { id:'tile-snapshot', idPrefix:'TILE-', identityKind:'geometry-sha256-v1' };
    const derived = geometryParcelFeature(descriptor, feature());
    const options = { returnsWGS84:true, descriptor };
    const sample = safeSample(derived, descriptor.id, options);
    assert.deepEqual(sample.properties, { id:derived.id.slice(descriptor.idPrefix.length) });
    assert.deepEqual(sample.geometry, derived.geometry);
    assert.equal(derived.properties.sourceParcelId, null);
    assert.throws(() => safeSample(derived, descriptor.id, { returnsWGS84:true }), /invalid native parcel identity/);
    const wrongHash = structuredClone(derived);
    wrongHash.properties.sourceGeometryHash = '0'.repeat(64);
    assert.throws(() => safeSample(wrongHash, descriptor.id, options), /invalid geometry-derived parcel reference/);
    const wrongNamespace = { ...options, descriptor:{ ...descriptor,id:'another-source' } };
    assert.throws(() => safeSample(derived, descriptor.id, wrongNamespace), /invalid geometry-derived parcel reference/);
});

test('keeps vector tile grouping keys when narrowing the candidate fields', () => {
    const descriptor = { adapter:'vector-tiles', groupFields:['survey_key'],
        outFields:['survey_key','display_name'], parcelNumberField:'display_name' };
    const safe = safeDescriptor(descriptor);
    assert.deepEqual(safe.outFields, ['survey_key']);
    assert.equal(safe.parcelNumberField, undefined);
    assert.throws(() => safeDescriptor({ ...descriptor,groupFields:['ownerName'] }), /safe field allowlist/);
});
