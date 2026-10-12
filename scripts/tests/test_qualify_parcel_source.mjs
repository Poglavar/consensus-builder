import test from 'node:test';
import assert from 'node:assert/strict';
import { addCanonicalFeature, assessForcedQueryEvidence, assessHmlrBrowserCompletenessEvidence,
    canonicalSafeFeature, cellsForPoint, exactReadCost, footprintBbox, makeSafeFetch, shouldShrinkCell } from '../qualify-parcel-source.mjs';

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

test('accepts HMLR immutable snapshot completeness only when release, date, IDs, absence and repeated cells bind', () => {
    const snapshotId = 'a'.repeat(64), sourceDate = '2026-10-04';
    const sampleIds = ['GB-HMLR-BROWSER-v1-12', 'GB-HMLR-BROWSER-v1-34'];
    const exact = Object.assign(new Map(sampleIds.map(id => [id, { id }])), { snapshotId, sourceDate });
    const absent = { complete:true, features:[], absentIds:['GB-HMLR-BROWSER-v1-99'], snapshotId, sourceDate };
    const cell = ids => ({ complete:true, ids, snapshotId, sourceDate });
    const firstPass = [cell(sampleIds), cell([])];
    const secondPass = [cell([...sampleIds].reverse()), cell([])];
    const evidence = assessHmlrBrowserCompletenessEvidence({ expectedSnapshotId:snapshotId, sampleIds,
        firstExact:exact, secondExact:exact, absenceResult:absent, firstPass, secondPass,
        absentId:'GB-HMLR-BROWSER-v1-99' });
    assert.equal(evidence.passed, true);
    assert.equal(evidence.snapshotBound, true);
    assert.equal(evidence.sourceDateBound, true);
    assert.equal(evidence.exactSampleIdsRepeated, true);
    assert.equal(evidence.completeSampleQueries, true);

    assert.equal(assessHmlrBrowserCompletenessEvidence({ expectedSnapshotId:'b'.repeat(64), sampleIds,
        firstExact:exact, secondExact:exact, absenceResult:absent, firstPass, secondPass,
        absentId:'GB-HMLR-BROWSER-v1-99' }).passed, false);
    assert.equal(assessHmlrBrowserCompletenessEvidence({ expectedSnapshotId:snapshotId, sampleIds,
        firstExact:exact, secondExact:Object.assign(new Map(exact), { snapshotId, sourceDate:'2026-10-05' }),
        absenceResult:absent, firstPass, secondPass, absentId:'GB-HMLR-BROWSER-v1-99' }).sourceDateBound, false);
    assert.equal(assessHmlrBrowserCompletenessEvidence({ expectedSnapshotId:snapshotId, sampleIds,
        firstExact:exact, secondExact:new Map([[sampleIds[0], exact.get(sampleIds[0])]]), absenceResult:absent,
        firstPass, secondPass, absentId:'GB-HMLR-BROWSER-v1-99' }).exactSampleIdsRepeated, false);
    assert.equal(assessHmlrBrowserCompletenessEvidence({ expectedSnapshotId:snapshotId, sampleIds,
        firstExact:exact, secondExact:exact, absenceResult:absent, firstPass:[cell(sampleIds), { ...cell([]), complete:false }],
        secondPass, absentId:'GB-HMLR-BROWSER-v1-99' }).completeSampleQueries, false);
});

test('single-equality exact reads are judged by their singleton objectIds geometry requests', () => {
    const requests = [
        { queryHash:'count-a' }, { queryHash:'ids-a' }, { queryHash:'oid-1', idListParam:'objectIds', idListCount:1 },
        { queryHash:'count-b' }, { queryHash:'ids-b' }, { queryHash:'oid-2', idListParam:'objectIds', idListCount:1 }
    ];
    const evidence = assessForcedQueryEvidence({ requests, expectedIds:['N-1','N-2'], returnedIds:['N-1','N-2'], complete:true, mode:'single-equality' });
    assert.equal(evidence.passed, true);
    assert.equal(evidence.kind, 'single-equality-manifest');
    assert.equal(assessForcedQueryEvidence({ requests, expectedIds:['N-1','N-2'], returnedIds:['N-1','N-2'], complete:true }).passed, false);
});

test('a cursor-paged request is a distinct query identity', async () => {
    const state = { requests: [] };
    globalThis.__qualificationOriginalFetch = async () => new Response('{}');
    const fetch = makeSafeFetch({ state, stage: 'forced-page-size-one' });
    await fetch('https://api.example/collections/parcels/items?f=json&limit=1');
    await fetch('https://api.example/collections/parcels/items?f=json&limit=1&cursor=abc');
    await fetch('https://api.example/collections/parcels/items?f=json&limit=1&cursor=def');
    delete globalThis.__qualificationOriginalFetch;
    assert.equal(new Set(state.requests.map(request => request.queryHash)).size, 3);
    const evidence = assessForcedQueryEvidence({ requests: state.requests, expectedIds:['A','B','C'], returnedIds:['A','B','C'], complete:true });
    assert.equal(evidence.passed, true);
});

test('dense cities shrink the cell only for sources that read one parcel per request or worse', () => {
    assert.equal(exactReadCost(3, 3), 1);
    assert.equal(exactReadCost(9, 3), 3);
    assert.equal(exactReadCost(1, 3), 0);
    // The probe box spans the 13 cells' 5x5-cell footprint.
    assert.deepEqual(footprintBbox([-1.2, 51.5], 0.001), [-1.202, 51.498, -1.197, 51.503]);
    // Palma: ~400 parcels in the 0.001° footprint, one request each, would re-read ~230.
    assert.equal(shouldShrinkCell({ footprintFeatures: 400, perIdCost: 1, step: 0.001 }), true);
    assert.equal(shouldShrinkCell({ footprintFeatures: 100, perIdCost: 1, step: 0.0005 }), false);
    // Wellington: a sparse centre cell, but ~150 parcels around it at three requests each.
    assert.equal(shouldShrinkCell({ footprintFeatures: 150, perIdCost: 3, step: 0.001 }), true);
    assert.equal(shouldShrinkCell({ footprintFeatures: 400, perIdCost: 0, step: 0.001 }), false);
    assert.equal(shouldShrinkCell({ footprintFeatures: 900, perIdCost: 3, step: 0.00025 }), false);
});
