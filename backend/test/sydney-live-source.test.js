// Verifies Sydney's cadastral native identity, canonical reads and rejection of conflicting source geometry.
import { describe, expect, it, vi } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { parcelSourceForCity } from '../parcels/sources.js';

const square = west => ({ type: 'Polygon', coordinates: [[[west, -33.859], [west + .0001, -33.859],
    [west + .0001, -33.8589], [west, -33.8589], [west, -33.859]]] });
const feature = (oid, geometry = square(151.079)) => ({ type: 'Feature', id: oid, geometry,
    properties: { objectid: oid, cadid: 100098447, lotidstring: '9//DP11050',
        shapeuuid: 'b6e8fffb-01cc-3f67-af4d-9d821e2275c6', enddate: 32503680000000,
        processstate: null, changetype: 'M' } });
const response = features => ({ ok: true, status: 200,
    json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit: false }) });

describe('Sydney live cadastral source', () => {
    it('uses native cadid for bounds and exact lookup, leaving row and display identity separate', async () => {
        const { descriptor } = parcelSourceForCity('sydney');
        expect(descriptor).toMatchObject({ id: 'au-nsw-six-cadastre-lot', idField: 'cadid',
            objectIdField: 'objectid', parcelNumberField: 'lotidstring', metricSrid: 32756 });
        const fetchImpl = vi.fn(async () => response([feature(3537226)]));
        const adapter = createArcgisParcelSource(descriptor, { fetchImpl });
        const bounds = await adapter.queryBounds([151.078, -33.86, 151.081, -33.857]);
        expect(bounds.complete).toBe(true);
        expect(bounds.features[0]).toMatchObject({ id: 'AU-NSW-100098447',
            properties: { sourceParcelId: '100098447', parcelNumber: '9//DP11050' } });
        const exact = await adapter.queryIds(['AU-NSW-100098447']);
        expect(exact.absentIds).toEqual([]);
        expect(exact.features).toEqual(bounds.features);
        const query = new URL(fetchImpl.mock.calls.at(-1)[0]).searchParams;
        expect(query.get('where')).toContain('cadid IN (100098447)');
        expect(query.get('outFields')).not.toMatch(/owner|address|username/i);
    });
    it('fails closed when a native cadastral key describes different polygons', async () => {
        const { descriptor } = parcelSourceForCity('sydney');
        const adapter = createArcgisParcelSource(descriptor, {
            fetchImpl: async () => response([feature(1), feature(2, square(151.080))])
        });
        await expect(adapter.queryBounds([151.078, -33.86, 151.081, -33.857])).rejects.toThrow(/conflict/i);
    });
});
