import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { adapterCrsContract, buildProbeBounds, centerInventory, compareGeometryPassThrough,
    descriptorHash, parseWfsCapabilities, queryArcgisNativeSample, safeEsriNativeFeature, safeProviderObservation,
    sourceCrsSummary, runAudit } from '../../scripts/audit-parcel-alignment.mjs';
import { parseCityConfigs } from '../../scripts/build-world-coverage.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8');

describe('parcel alignment audit inventory and safe observations', () => {
    it('accounts for every catalog source, city binding and opt-in marker without network access', () => {
        const catalog = JSON.parse(read('backend/parcels/source-catalog.json'));
        const cities = parseCityConfigs(read('frontend/js/city-config.js'));
        const inventory = centerInventory(cities, catalog.sources);
        expect(catalog.sources).toHaveLength(253);
        expect(inventory).toHaveLength(649);
        expect(inventory.every(city => city.center && city.bindings.length > 0)).toBe(true);
        expect(inventory.flatMap(city => city.bindings)).toHaveLength(652);
        expect(inventory.flatMap(city => city.bindings).filter(binding => binding.optIn)).toHaveLength(10);
        expect(cities).toHaveLength(650);
    });

    it('hashes descriptors independent of object key order and records source CRS separately from metric CRS', () => {
        expect(descriptorHash({ id: 'x', metricSrid: 4326 })).toBe(descriptorHash({ metricSrid: 4326, id: 'x' }));
        expect(sourceCrsSummary({ sourceCrs: 'EPSG:27700', metricSrid: 32630 })).toEqual({ sourceCrs: 'EPSG:27700', metricSrid: 32630 });
        expect(adapterCrsContract({ adapter: 'wfs', responseSrid: 3857 })).toMatchObject({
            requestedOutput: 'EPSG:3857', queryBounds: 'CRS:84 longitude/latitude'
        });
        expect(adapterCrsContract({ adapter: 'dgu-wfs' }).conversion).toContain('CRS:84 pass-through');
        expect(adapterCrsContract({ adapter: 'arcgis', boundsSrid: 32631, boundsProjection: '+proj=utm +zone=31' }))
            .toMatchObject({ queryBounds: 'EPSG:32631', boundsProjection: '+proj=utm +zone=31' });
    });

    it('retains only safe CRS, native ID and a bounded polygon geometry from provider JSON', () => {
        const descriptor = { idField: 'PARCEL_ID' };
        const observation = safeProviderObservation({
            crs: { type: 'name', properties: { name: 'EPSG:4326' } },
            features: [{ id: 'transport-id', properties: { PARCEL_ID: 'A-17', owner_name: 'must not persist' },
                geometry: { type: 'Polygon', coordinates: [[[1, 2], [2, 2], [2, 3], [1, 2]]] } }]
        }, descriptor);
        expect(observation).toEqual({ responseCrs: 'EPSG:4326', featureSample: {
            nativeId: 'A-17', geometry: { type: 'Polygon', coordinates: [[[1, 2], [2, 2], [2, 3], [1, 2]]] }
        } });
        expect(JSON.stringify(observation)).not.toContain('must not persist');
    });

    it('accepts an ArcGIS native sample only when its returned CRS matches the requested CRS', () => {
        const payload = { spatialReference: { wkid: 102100, latestWkid: 3857 }, features: [{
            attributes: { PARCEL_ID: 'A-17' }, geometry: { rings: [[[1, 2], [3, 2], [3, 4], [1, 2]]] }
        }] };
        expect(safeEsriNativeFeature(payload, { idField: 'PARCEL_ID' }, 3857)).toMatchObject({
            responseCrs: 'EPSG:3857', responseSpatialReference: { wkid: 102100, latestWkid: 3857 }
        });
        expect(safeEsriNativeFeature(payload, { idField: 'PARCEL_ID' }, 26915)).toBeNull();
        expect(safeEsriNativeFeature({ features: payload.features }, { idField: 'PARCEL_ID' }, 3857)).toBeNull();
    });

    it('scopes WFS capability CRS to the selected feature type when available', () => {
        const xml = `<WFS_Capabilities xmlns="http://www.opengis.net/wfs/2.0"><FeatureTypeList>
            <FeatureType><Name>parcels:lots</Name><DefaultCRS>urn:ogc:def:crs:EPSG::25832</DefaultCRS></FeatureType>
            <FeatureType><Name>roads:lines</Name><DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS></FeatureType>
        </FeatureTypeList></WFS_Capabilities>`;
        expect(parseWfsCapabilities(xml, 'parcels:lots')).toMatchObject({
            scope: 'selected-feature-type', selectedFeatureTypeMatched: true, advertisedCrs: ['urn:ogc:def:crs:EPSG::25832']
        });
        expect(parseWfsCapabilities(xml, 'unknown:layer')).toMatchObject({ scope: 'service-wide', selectedFeatureTypeMatched: false });
    });

    it('preserves ArcGIS source filters, supports qualified ID columns and rejects an ID mismatch', async () => {
        const descriptor = { adapter: 'arcgis', endpoint: 'https://example.test/FeatureServer/0',
            idField: 'SDE.Lots.UPID', objectIdField: 'OBJECTID', idType: 'string', outFields: ['SDE.Lots.UPID', 'OBJECTID', 'STATUS'],
            idPrefix: 'SC-', attributeFilters: { STATUS: 'CURRENT' } };
        const metadata = { metadata: { arcgis: { spatialReference: { wkid: 32740 } } } };
        const feature = { properties: { sourceParcelId: 'V-1' } };
        let query = null;
        const observer = { count: 0, fetchImpl: async url => {
            query = new URL(url);
            return new Response(JSON.stringify({ spatialReference: { wkid: 32740 }, features: [{
                attributes: { 'SDE.Lots.UPID': 'V-2' }, geometry: { rings: [[[1, 2], [3, 2], [3, 4], [1, 2]]] }
            }] }), { headers: { 'content-type': 'application/json' } });
        } };
        const result = await queryArcgisNativeSample(descriptor, [feature], metadata, observer);
        expect(result.status).toBe('held');
        expect(decodeURIComponent(query.searchParams.get('where'))).toContain('SDE.Lots.UPID = \'V-1\'');
        expect(decodeURIComponent(query.searchParams.get('where'))).toContain("STATUS = 'CURRENT'");
    });

    it('recognizes exact passthrough only and keeps the probe footprint bounded', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(compareGeometryPassThrough([{ featureSample: { geometry } }], [{ geometry }])).toBe(true);
        expect(compareGeometryPassThrough([{ featureSample: { geometry } }], [{ geometry: { ...geometry, coordinates: [] } }])).toBe(false);
        const bounds = buildProbeBounds([15, 45], 0.001);
        expect(bounds[2] - bounds[0]).toBeLessThan(0.001);
        expect(bounds[3] - bounds[1]).toBeLessThan(0.001);
    });

    it('requires explicit --run output before doing any work', async () => {
        await expect(runAudit({})).rejects.toThrow('--run requires --output');
    });
});
