import test from 'node:test';
import assert from 'node:assert/strict';
import { addCanonicalFeature, assessForcedQueryEvidence, canonicalSafeFeature, cellsForPoint } from '../qualify-parcel-source.mjs';

const geometry = { type:'Polygon', coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
const feature = (id, extra = {}) => ({ type:'Feature', id, properties:{ parcelId:id, sourceId:'public-test', sourceParcelId:id.slice(5), owner:'omit', ...extra }, geometry });

test('builds thirteen bounded WGS84 cells around explicit lon/lat', () => {
    const cells = cellsForPoint([-1.2, 51.5], 0.001);
    assert.equal(cells.length, 13);
    assert.deepEqual(cells[4].bbox, [-1.2, 51.5, -1.199, 51.501]);
});

test('retains only canonical safe identity properties', () => {
    const clean = canonicalSafeFeature(feature('SRC-123'), 'public-test');
    assert.deepEqual(Object.keys(clean.properties).sort(), ['parcelId','sourceId','sourceParcelId']);
    assert.equal(clean.geometry, geometry);
});

test('collapses repeat IDs with the same geometry and rejects changed geometry', () => {
    const cache = new Map();
    addCanonicalFeature(cache, feature('SRC-123'), 'public-test');
    addCanonicalFeature(cache, feature('SRC-123'), 'public-test');
    assert.equal(cache.size, 1);
    assert.throws(() => addCanonicalFeature(cache, { ...feature('SRC-123'), geometry:{ type:'Polygon', coordinates:[[[0,0],[2,0],[2,2],[0,2],[0,0]]] } }, 'public-test'), /Conflicting geometry/);
});

test('preserves equal outlines under different canonical IDs for the independent metric pass', () => {
    const cache = new Map();
    addCanonicalFeature(cache, feature('SRC-123'), 'public-test');
    addCanonicalFeature(cache, feature('SRC-456'), 'public-test');
    assert.equal(cache.size, 2);
    assert.equal(cache.get('SRC-123').geometry, cache.get('SRC-456').geometry);
});

test('accepts page-size-one offset-zero requests when native predicates differ', () => {
    const evidence = assessForcedQueryEvidence({
        requests:[{ queryHash:'native-query-a', pageLimit:1, offset:0 }, { queryHash:'native-query-b', pageLimit:1, offset:0 }],
        expectedIds:['SRC-123','SRC-456'], returnedIds:['SRC-123','SRC-456'], complete:true
    });
    assert.equal(evidence.passed, true);
    assert.equal(evidence.distinctFeatureQueries, 2);
    assert.equal(evidence.duplicatePageRequests, 0);
});

test('rejects a repeated page-size-one predicate at the same offset', () => {
    const evidence = assessForcedQueryEvidence({
        requests:[{ queryHash:'same-native-query', pageLimit:1, offset:0 }, { queryHash:'same-native-query', pageLimit:1, offset:0 }],
        expectedIds:['SRC-123','SRC-456'], returnedIds:['SRC-123','SRC-456'], complete:true
    });
    assert.equal(evidence.passed, false);
    assert.equal(evidence.duplicatePageRequests, 1);
});

test('accepts ArcGIS singleton object-ID requests only with a complete manifest and exact returned IDs', () => {
    const requests = [
        { queryHash:'object-id-a', idListParam:'objectIds', idListCount:1 },
        { queryHash:'object-id-b', idListParam:'objectIds', idListCount:1 }
    ];
    const evidence = assessForcedQueryEvidence({ requests, expectedIds:['SRC-123','SRC-456'],
        returnedIds:['SRC-123','SRC-456'], complete:true, mode:'object-ids' });
    assert.equal(evidence.passed, true);
    assert.equal(evidence.distinctSingletonObjectIdQueries, 2);
    assert.equal(assessForcedQueryEvidence({ requests, expectedIds:['SRC-123','SRC-456'],
        returnedIds:['SRC-123','SRC-456'], complete:false, mode:'object-ids' }).passed, false);
});
