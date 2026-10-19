// Verifies the next OGC API and Socrata sources through the configured factories,
// the read-only parcel HTTP gateway, exact native identity and metric binding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createParcelSource, parcelSourceCatalog } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding, bindingFrame, FOOTPRINT_SITE_SQL } from '../proposals/binding.js';

const SQUARE = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});

const cases = [
    {
        city: 'essen',
        sourceId: 'de-nrw-lika-flurstueck',
        nativeId: '05344102100105______',
        metricSrid: 32632,
        descriptorContract: {
            adapter: 'ogc-api', idField: 'flstkennz', idFromFeatureId: true,
            idPrefix: 'DE-NRW-', pagination: 'offset', metricSrid: 32632
        },
        geometry: SQUARE(7.012, 51.455, 7.0122, 51.4552)
    },
    {
        city: 'dortmund',
        sourceId: 'de-nrw-lika-flurstueck',
        nativeId: '05913000000012345678',
        metricSrid: 32632,
        descriptorContract: {
            adapter: 'ogc-api', idField: 'flstkennz', idFromFeatureId: true,
            idPrefix: 'DE-NRW-', pagination: 'offset', metricSrid: 32632
        },
        geometry: SQUARE(7.465, 51.514, 7.4652, 51.5142)
    },
    {
        city: 'san_francisco',
        sourceId: 'us-ca-sf-datasf-active-parcels',
        nativeId: '0256005',
        metricSrid: 32610,
        descriptorContract: {
            adapter: 'socrata', idField: 'mapblklot', objectIdField: 'blklot',
            geometryField: 'shape', versionField: 'data_loaded_at', idPrefix: 'US-CA-SF-',
            metricSrid: 32610, attributeFilters: { active: true, pw_recorded_map: true }
        },
        geometry: SQUARE(-122.4107, 37.7876, -122.4100, 37.7880)
    }
];

function ogcFeature(descriptor, nativeId, geometry) {
    return {
        type: 'Feature',
        id: nativeId,
        properties: Object.fromEntries(descriptor.outFields
            .filter(field => field !== descriptor.idField)
            .map(field => [field, field === 'objid' ? 'fixture-object' : null])),
        geometry
    };
}

function sfRow(descriptor, nativeId, geometry) {
    return {
        [descriptor.idField]: nativeId,
        [descriptor.objectIdField]: nativeId,
        [descriptor.geometryField]: geometry,
        active: true,
        pw_recorded_map: true,
        data_as_of: '2026-10-02T04:00:00.000',
        data_loaded_at: '2026-10-02T10:23:46.776',
        date_map_alt: null
    };
}

function ogcResponse(features) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            type: 'FeatureCollection',
            features,
            numberMatched: features.length,
            numberReturned: features.length,
            links: []
        })
    };
}

function socrataFetch(descriptor, row) {
    return vi.fn(async url => {
        const params = new URL(url).searchParams;
        if (params.get('$select') === `count(*) as matched,max(${descriptor.versionField}) as revision`) {
            return { ok: true, status: 200, json: async () => [{ matched: '1', revision: row[descriptor.versionField] }] };
        }
        return { ok: true, status: 200, json: async () => [row] };
    });
}

afterEach(() => vi.unstubAllGlobals());

describe.each(cases)('$city live parcel source', sample => {
    const descriptor = parcelSourceCatalog.sources.find(source => source.id === sample.sourceId);

    it('builds through the configured factory and returns the exact native ID through the HTTP gateway', async () => {
        expect(descriptor).toBeDefined();
        expect(descriptor).toMatchObject(sample.descriptorContract);
        const fetchImpl = descriptor.adapter === 'ogc-api'
            ? vi.fn(async () => ogcResponse([ogcFeature(descriptor, sample.nativeId, sample.geometry)]))
            : socrataFetch(descriptor, sfRow(descriptor, sample.nativeId, sample.geometry));
        const source = createParcelSource(descriptor, { fetchImpl });
        expect(source).toHaveProperty('queryIds');

        const app = express();
        setupParcelSourcesRoute(app, { sources: [descriptor], fetchImpl });
        const id = `${descriptor.idPrefix}${sample.nativeId}`;
        const response = await request(app).get(`/parcel-sources/${descriptor.id}`).query({ ids: id });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ complete: true, absentIds: [], returnsWGS84: true });
        expect(response.body.features).toHaveLength(1);
        expect(response.body.features[0]).toMatchObject({
            type: 'Feature',
            id,
            geometry: sample.geometry,
            properties: { parcelId: id, sourceParcelId: sample.nativeId, sourceId: descriptor.id }
        });

        if (descriptor.adapter === 'ogc-api') {
            const params = new URL(fetchImpl.mock.calls[0][0]).searchParams;
            expect(params.get('filter')).toContain(`flstkennz IN ('${sample.nativeId}')`);
            expect(params.get('filter-lang')).toBe('cql2-text');
            expect(params.get('crs')).toBe('http://www.opengis.net/def/crs/OGC/1.3/CRS84');
            // The durable cadastral key arrives as GeoJSON feature.id, not an object/version ID.
            expect(response.body.features[0].properties.sourceParcelId).toBe(sample.nativeId);
        } else {
            const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
            const signature = urls[0].searchParams;
            expect(signature.get('$select')).toBe('count(*) as matched,max(data_loaded_at) as revision');
            expect(urls).toHaveLength(3); // signature, ordered row page, unchanged revision signature
            const rowQuery = urls[1].searchParams;
            expect(rowQuery.get('$where')).toContain(`mapblklot IN ('${sample.nativeId}')`);
            expect(rowQuery.get('$where')).toContain('active = true');
            expect(rowQuery.get('$where')).toContain('pw_recorded_map = true');
            expect(rowQuery.get('$select')).toContain('shape,mapblklot,blklot');
            expect(rowQuery.get('$order')).toBe('mapblklot,blklot');
            expect(rowQuery.get('$offset')).toBe('0');
            expect(response.body.features[0].properties.sourceProperties.blklot).toBe(sample.nativeId);
        }
    });

    it('derives the footprint in its own operation frame while binding without imported parcel tables', async () => {
        const feature = descriptor.adapter === 'ogc-api'
            ? ogcFeature(descriptor, sample.nativeId, sample.geometry)
            : sfRow(descriptor, sample.nativeId, sample.geometry);
        const fetchImpl = descriptor.adapter === 'ogc-api'
            ? vi.fn(async () => ogcResponse([feature]))
            : socrataFetch(descriptor, feature);
        vi.stubGlobal('fetch', fetchImpl);
        const db = { query: vi.fn(async () => ({ rows: [{ geometry: JSON.stringify(sample.geometry) }] })) };
        const parts = { polygons: [sample.geometry], centerline: null };

        const { binding } = await computeBinding(db, { city: sample.city, parts });

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toBe(FOOTPRINT_SITE_SQL);
        expect(sql).not.toContain(String(sample.metricSrid));
        expect(params.at(-1)).toBe(bindingFrame({ parts }).proj);
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toEqual([`${descriptor.idPrefix}${sample.nativeId}`]);
    });
});
