// A CityJSON or CityGML file at a public URL as a building source (buildings/city-model-url-source.js):
// discovery reads it whole and pins the hash of its bytes, the portable id decodes on the server and in the browser,
// the browser's adapter worker reads its buildings with their own heights, a changed file is refused,
// and a GeoJSON file goes on to the other adapters.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as turf from '@turf/turf';
import proj4 from 'proj4';
import { discoverCityModelSource, setupBuildingSourcesRoute } from '../routes/building-sources.js';
import { createBrowserBuildingCells } from '../buildings/browser-building-cells.js';
import { decodeBuildingSourceId } from '../buildings/building-cell-read.js';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';
import { createBuildingProviders } from '../buildings/index.js';
import { parseCityGml } from '../buildings/citygml.js';

const require = createRequire(import.meta.url);
const Reader = require('../../frontend/js/city-model-reader.js');
const PlanFile = require('../../frontend/js/plan-file.js');
const CityJsonExport = require('../../frontend/js/city-json-export.js');
const gml = readFileSync(new URL('./fixtures/wien-lod2-096076.gml', import.meta.url), 'utf8');
const url = 'https://data.example/city/district.gml';

// The buildings the editors' footprint import reads from the same text.
function footprints(text) {
    const model = Reader.readCityModel(text, { parseGml: parseCityGml });
    const transform = proj4(model.crs.definition, 'EPSG:4326');
    return Reader.footprintFeatures(model, { toLngLat: (x, y) => transform.forward([x, y]), turf }).features;
}
const expected = footprints(gml);
const bbox = turf.bbox({ type: 'FeatureCollection', features: expected });

// As a browser sees a cross-origin answer: no ETag unless the host exposes it, so none here.
function serve(text, { cors = '*' } = {}) {
    return vi.fn(async () => new Response(text, { status: 200, headers: cors ? { 'access-control-allow-origin': cors } : {} }));
}
const sha256 = text => createHash('sha256').update(text).digest('hex');

describe('a city model file as a building source', () => {
    it('is discovered with its format, extent and hash, and decodes the same on the server and in the browser', async () => {
        const found = await discoverCityModelSource({ url, city: 'vienna', bbox }, { fetchImpl: serve(gml) });
        expect(found).toMatchObject({ buildingCount: expected.length, fileBuildingCount: expected.length });
        expect(found.source).toMatchObject({ adapter: 'city-model', format: 'citygml', expectedSha256: sha256(gml), cityIds: ['vienna'], kind: 'building' });
        expect(found.source.bbox.map(v => +v.toFixed(6))).toEqual(bbox.map(v => +v.toFixed(6)));
        expect(decodeCustomBuildingSource(found.source.id)).toEqual(found.source);
        expect(decodeBuildingSourceId(found.source.id)).toMatchObject({ adapter: 'city-model', endpoint: url, idPrefix: found.source.idPrefix });
        expect(() => createBuildingProviders(null).resolveSource(found.source.id)).not.toThrow();
    });

    it('reads its buildings in the browser with their own heights, and refuses the file once it changed', async () => {
        const { source } = await discoverCityModelSource({ url, city: 'vienna', bbox }, { fetchImpl: serve(gml) });
        const cells = createBrowserBuildingCells({ fetchImpl: serve(gml) });
        const near = await cells.read(source.id, { kind: 'near', bbox });
        expect(near).toMatchObject({ complete: true, count: expected.length });
        const flat = await cells.read(source.id, { kind: 'footprints', bbox });
        expect(flat.items.map(item => item.height_m).sort()).toEqual(expected.map(feature => feature.properties.height).sort());
        expect(new Set(flat.items.map(item => item.id)).size).toBe(expected.length);
        expect(flat.items.every(item => item.id.startsWith(source.idPrefix))).toBe(true);
        const changed = await createBrowserBuildingCells({ fetchImpl: serve(gml.replace('</core:CityModel>', '<!-- edited --></core:CityModel>')) }).read(source.id, { kind: 'near', bbox });
        expect(changed).toMatchObject({ complete: false, items: [] });
    });

    it('reads a CityJSON file too, as the site downloads one', async () => {
        const box = { type: 'Polygon', coordinates: [[[15.98, 45.8], [15.9805, 45.8], [15.9805, 45.8004], [15.98, 45.8004], [15.98, 45.8]]] };
        const file = await PlanFile.create([{ proposalId: 'b', goal: 'single', title: 'Block', site: box, city: 'zagreb', author: 'A', createdAt: '2026-10-30T10:00:00.000Z',
            buildingProposal: { floors: 5 }, geometry: { buildings: [{ type: 'Feature', geometry: box, properties: { floors: 5, height: 16, use: 'residential' } }] } }],
            { title: 'Block', view: { at: '45.8,15.98,18', mode: '2d', city: 'zagreb', language: 'en' } });
        const text = JSON.stringify(CityJsonExport.fromPlanFile(file, { proj4 }));
        const found = await discoverCityModelSource({ url: 'https://data.example/block.city.json', city: 'zagreb', bbox: turf.bbox(box) }, { fetchImpl: serve(text) });
        expect(found).toMatchObject({ buildingCount: 1, source: { format: 'cityjson', expectedSha256: sha256(text) } });
        const flat = await createBrowserBuildingCells({ fetchImpl: serve(text) }).read(found.source.id, { kind: 'footprints', bbox: turf.bbox(box) });
        expect(flat.items).toMatchObject([{ height_m: 16, floors: 5 }]);
    });

    it('leaves a GeoJSON file to the other adapters, and takes a file whose buildings lie outside the test area', async () => {
        const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
        expect(await discoverCityModelSource({ url: 'https://data.example/b.geojson.json', bbox }, { fetchImpl: serve(geojson) })).toBeNull();
        expect(await discoverCityModelSource({ url, city: 'vienna', bbox: [16.3, 48.1, 16.301, 48.101] }, { fetchImpl: serve(gml) }))
            .toMatchObject({ buildingCount: 0, fileBuildingCount: expected.length, source: { adapter: 'city-model' } });
    });

    it('is offered by GET /building-sources/discover only when the browser may read the file', async () => {
        async function discover(cors) {
            const routes = {}, discoverAdapters = vi.fn();
            setupBuildingSourcesRoute({ get: (path, ...handlers) => { routes[path] = handlers.at(-1); } },
                { discover: discoverAdapters, publicFetch: serve(gml, { cors }), discoverOverpass: vi.fn() });
            let sent, status = 200;
            const res = { writableEnded: false, destroyed: false, once() {}, off() {}, set() { return this; },
                status(code) { status = code; return this; }, json(body) { sent = body; return this; } };
            await routes['/building-sources/discover']({ query: { url, city: 'vienna', bbox: bbox.join(',') }, get: () => undefined }, res);
            return { status, sent, adapters: discoverAdapters.mock.calls.length };
        }
        expect(await discover('*')).toMatchObject({ status: 200, adapters: 0, sent: { buildingCount: expected.length, source: { adapter: 'city-model' } } });
        expect(await discover(null)).toMatchObject({ status: 422, sent: { code: 'building-source-no-cors' } });
    });
});
