// Regression coverage for canonical, safely normalized WGS84 provider samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRequestUrl, safeSample } from '../probe-parcel-provider.mjs';

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
