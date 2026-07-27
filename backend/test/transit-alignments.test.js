// Tests the immutable OSM alignment registry independently of map, DOM, and Three.js rendering.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const alignments = require('../../frontend/js/transit-alignments.js');

afterEach(() => alignments.reset());

describe('transit reference alignment normalization', () => {
    it('loads the registry before station placement and the rail builder before the 3D consumer', () => {
        const index = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
        expect(index.indexOf("'js/transit-alignments.js'")).toBeLessThan(index.indexOf("'js/transit-stations.js'"));
        expect(index.indexOf("'js/elevated-rail-3d.js'")).toBeLessThan(index.indexOf("'js/three-mode.js'"));
    });

    it('turns LineString and MultiLineString features into stable station-alignment records', () => {
        const source = {
            id: 'zagreb-tram', url: 'tram.geojson', mode: 'tram',
            stationTypes: ['tram'], elevationM: 0, render3d: 'surface'
        };
        const records = alignments.buildAlignmentRecords(source, {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature', properties: { osmId: 123 },
                geometry: { type: 'MultiLineString', coordinates: [
                    [[15.97, 45.8], [15.98, 45.8]],
                    [[15.98, 45.8], [15.99, 45.81]]
                ] }
            }]
        });

        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            sourceKind: 'reference', sourceId: 'zagreb-tram', featureId: '123',
            recordId: 'zagreb-tram:123:0', mode: 'tram', stationTypes: ['tram'], render3d: 'surface'
        });
        expect(records[0].bounds).toEqual([15.97, 45.8, 15.98, 45.8]);
        expect(records[1].recordId).toBe('zagreb-tram:123:1');
    });

    it('queries only alignment records whose bounds reach the station snap radius', () => {
        const records = alignments.buildAlignmentRecords({
            id: 'tram', url: 'tram.geojson', mode: 'tram', stationTypes: ['tram']
        }, {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature', properties: { osmId: 1 },
                geometry: { type: 'LineString', coordinates: [[15.979, 45.81], [15.981, 45.81]] }
            }, {
                type: 'Feature', properties: { osmId: 2 },
                geometry: { type: 'LineString', coordinates: [[16.1, 45.9], [16.11, 45.9]] }
            }]
        });
        const index = alignments.buildSpatialIndex(records);

        expect(alignments.querySpatialIndex(index, [15.98, 45.81005], 24).map(record => record.featureId)).toEqual(['1']);
    });

    it('loads each configured asset once and exposes both flattened and source-preserving views', async () => {
        const config = { sources: [{
            id: 'rail', url: 'rail.geojson', mode: 'heavy-rail',
            stationTypes: ['elevated'], elevationM: 7.5, render3d: 'elevated'
        }] };
        let fetchCount = 0;
        const fetchAsset = async () => {
            fetchCount++;
            return {
                ok: true,
                json: async () => ({
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature', properties: { osmId: 55 },
                        geometry: { type: 'LineString', coordinates: [[15.97, 45.8], [15.98, 45.8]] }
                    }]
                })
            };
        };

        const first = await alignments.ensureLoaded(config, fetchAsset);
        const second = await alignments.ensureLoaded(config, fetchAsset);

        expect(fetchCount).toBe(1);
        expect(second).toBe(first);
        expect(alignments.getStatus().status).toBe('ready');
        expect(alignments.getRecords()).toHaveLength(1);
        expect(alignments.getLoadedSources()[0]).toMatchObject({ id: 'rail', elevationM: 7.5 });
        expect(alignments.getLoadedSources()[0].featureCollection.features).toHaveLength(1);
    });
});
