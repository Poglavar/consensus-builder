// New York's 3D model as tiles (buildings/nyc-3d.js, city-model-tiles.js, build-nyc-3d-tiles.mjs): a
// real tile (around the Flatiron Building) reads back into roofed buildings in metres, a building is
// filed in every tile it touches, the CityJSON writer keeps surfaces and kinds, and a box maps onto
// tile names.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import proj4 from 'proj4';
import { NYC_3D, NYC_TILE_FT, createNyc3dProvider } from '../buildings/nyc-3d.js';
import { cityJsonTile, tilesOf, buildingBox } from '../buildings/city-model-tiles.js';
import { parseCityJson } from '../buildings/cityjson.js';

// R2 stores the tile gzipped with Content-Encoding: gzip, so fetch hands over the plain JSON.
const tile = gunzipSync(readFileSync(new URL('./fixtures/nyc-3d-987_209.city.json.gz', import.meta.url))).toString('utf8');
const toFeet = proj4('EPSG:4326', NYC_3D.crs);
const quiet = { log() {} };

describe('nyc-3d', () => {
    it('names the 1,000 ft tiles under a box', () => {
        const [x, y] = toFeet.forward([-73.98966, 40.74106]); // the Flatiron Building
        expect(NYC_3D.sheetsFor([x, y, x, y])).toEqual(['987_209']);
        expect(tilesOf([999.5 * NYC_TILE_FT, 10, 1000.5 * NYC_TILE_FT, 20], NYC_TILE_FT)).toEqual(['999_0', '1000_0']);
        expect(NYC_3D.sheetUrl('987_209')).toMatch(/\/tiles\/987_209\.city\.json$/);
    });

    it('reads a tile into roofed buildings with their heights in metres, and a missing tile as empty', async () => {
        const fetchImpl = vi.fn(async url => url.endsWith('/987_209.city.json') ? new Response(tile) : new Response('', { status: 404 }));
        const provider = createNyc3dProvider({ fetchImpl, log: quiet });
        const near = await provider.near({ type: 'Point', coordinates: [-73.98966, 40.74106] }, 40);
        expect(near.count).toBeGreaterThan(0);
        const flatiron = near.buildings.find(record => record.z_max - record.z_min > 80);
        expect(flatiron, 'the 87 m Flatiron Building').toBeTruthy();
        expect(flatiron.z_max - flatiron.z_min).toBeLessThan(100);
        expect(near.buildings.every(record => record.object_id.startsWith('nyc-3d:') && record.faces.some(face => face.kind === 'roof'))).toBe(true);
        const footprints = await provider.footprints({ type: 'Polygon', coordinates: [[[-73.991, 40.740], [-73.988, 40.740], [-73.988, 40.742], [-73.991, 40.742], [-73.991, 40.740]]] });
        expect(footprints.footprints.length).toBeGreaterThan(0);
        expect(await createNyc3dProvider({ fetchImpl, log: quiet }).near({ type: 'Point', coordinates: [-74.1, 40.6] }, 20)).toMatchObject({ count: 0 });
    });

    it('writes tiles that read back to the same buildings', () => {
        const buildings = parseCityJson(JSON.parse(tile));
        const again = parseCityJson(JSON.parse(JSON.stringify(cityJsonTile(buildings, { referenceSystem: 'https://www.opengis.net/def/crs/EPSG/0/2263' }))));
        expect(again.map(b => b.id)).toEqual(buildings.map(b => b.id));
        again.forEach((building, i) => {
            expect(building.surfaces.map(s => s.kind)).toEqual(buildings[i].surfaces.map(s => s.kind));
            expect(building.attributes.BIN).toBe(buildings[i].attributes.BIN);
            const [a, b] = [buildingBox(building), buildingBox(buildings[i])];
            a.forEach((value, k) => expect(Math.abs(value - b[k])).toBeLessThan(0.01));
        });
    });
});
