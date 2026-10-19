import { describe, expect, it } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const sources = [
    {
        label: 'NYS Tax Parcels Public with the legacy SWIS_SBL_ID key',
        descriptor: {
            id: 'us-ny-its-tax-parcels',
            endpoint: 'https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/MapServer/1',
            idField: 'SWIS_SBL_ID', idType: 'string', idPattern: '^[0-9]{1,50}$',
            objectIdField: 'OBJECTID', idPrefix: 'US-NY-', parcelNumberField: 'SWIS_SBL_ID',
            outFields: ['OBJECTID', 'SWIS_SBL_ID', 'COUNTY_NAME'],
            attributeFilters: { COUNTY_NAME: ['Bronx', 'Kings', 'NewYork', 'Queens', 'Richmond'] },
            pageSize: 500, maxFeatures: 10000, maxBboxKm2: 25, countryCode: 'US', metricSrid: 32618
        },
        nativeId: '6201001005527502', objectId: 1241991,
        geometry: polygon(-74.006, 40.7128),
        properties: { OBJECTID: 1241991, SWIS_SBL_ID: '6201001005527502', COUNTY_NAME: 'NewYork' }
    },
    {
        label: 'NYC Digital Tax Map BBL',
        descriptor: {
            id: 'us-nyc-dof-digital-tax-map',
            endpoint: 'https://services6.arcgis.com/yG5s3afENB5iO9fj/ArcGIS/rest/services/DTM_ETL_DAILY_view/FeatureServer/0',
            idField: 'BBL', idType: 'string', idPattern: '^[0-9]{10}$', objectIdField: 'OBJECTID',
            idPrefix: 'US-NYC-BBL-', parcelNumberField: 'BBL', outFields: ['OBJECTID', 'BBL'],
            pageSize: 500, maxFeatures: 10000, maxBboxKm2: 25, countryCode: 'US', metricSrid: 32618
        },
        nativeId: '1000010001', objectId: 1,
        geometry: polygon(-74.006, 40.7128),
        properties: { OBJECTID: 1, BBL: '1000010001' }
    },
    {
        label: 'Denver county-filtered Colorado composite',
        descriptor: {
            id: 'us-co-oit-public-parcels-denver',
            endpoint: 'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0',
            idField: 'parcel_id', idType: 'string', idPattern: '^[A-Za-z0-9][A-Za-z0-9-]*$',
            objectIdField: 'OBJECTID', idPrefix: 'US-CO-', parcelNumberField: 'parcel_id',
            outFields: ['OBJECTID', 'parcel_id', 'countyName'], attributeFilters: { countyName: 'Denver' },
            pageSize: 500, maxFeatures: 10000, maxBboxKm2: 25, countryCode: 'US', metricSrid: 32613
        },
        nativeId: '0503407043000', objectId: 650662,
        geometry: polygon(-104.9903, 39.7392),
        properties: { OBJECTID: 650662, parcel_id: '0503407043000', countyName: 'Denver' }
    }
];

function polygon(x, y) {
    return {
        type: 'Polygon',
        coordinates: [[[x, y], [x + 0.0002, y], [x + 0.0002, y + 0.0002],
            [x, y + 0.0002], [x, y]]]
    };
}

function fixture(source, recorded) {
    const feature = { type: 'Feature', id: source.objectId, properties: source.properties, geometry: source.geometry };
    return async (input, options = {}) => {
        const url = new URL(input);
        const params = new URLSearchParams(options.body || url.search);
        recorded.push({ where: params.get('where'), outFields: params.get('outFields') });
        return {
            ok: true, status: 200,
            json: async () => ({ type: 'FeatureCollection', features: [feature] })
        };
    };
}

describe('bounded US city ArcGIS sources', () => {
    it.each(sources)('canonicalizes, resolves exact IDs, and intersects footprints for $label', async source => {
        const calls = [];
        const adapter = createArcgisParcelSource(source.descriptor, { fetchImpl: fixture(source, calls) });
        const [x, y] = source.geometry.coordinates[0][0];
        const bounds = await adapter.queryBounds([x - 0.0001, y - 0.0001, x + 0.001, y + 0.001]);
        const canonicalId = `${source.descriptor.idPrefix}${source.nativeId}`;

        expect(bounds.complete).toBe(true);
        expect(bounds.features.map(feature => feature.id)).toEqual([canonicalId]);
        expect(bounds.features[0].properties).toMatchObject({
            parcelId: canonicalId, sourceId: source.descriptor.id,
            sourceParcelId: source.nativeId, parcelNumber: source.nativeId
        });

        const exact = await adapter.queryIds([canonicalId]);
        expect(exact.features.map(feature => feature.id)).toEqual([canonicalId]);
        expect(exact.absentIds).toEqual([]);

        const underFootprint = await adapter.queryGeometry(source.geometry);
        expect(underFootprint.complete).toBe(true);
        expect(underFootprint.features.map(feature => feature.id)).toEqual([canonicalId]);
        if (source.descriptor.attributeFilters) {
            const field = Object.keys(source.descriptor.attributeFilters)[0];
            if (Array.isArray(source.descriptor.attributeFilters[field])) {
                expect(calls.every(call => call.where.includes(`${field} IN (`))).toBe(true);
            } else {
                expect(calls.every(call => call.where.includes(`${field} = '${source.descriptor.attributeFilters[field]}'`))).toBe(true);
            }
            if (Array.isArray(source.descriptor.attributeFilters[field])) {
                expect(source.descriptor.attributeFilters[field].includes(source.properties[field])).toBe(true);
            } else {
                expect(source.properties[field]).toBe(source.descriptor.attributeFilters[field]);
            }
        }
    });
});
