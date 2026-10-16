// Overture buildings read in the browser from the public PMTiles (frontend/js/overture-tiles.js):
// the vector-tile decoder against @mapbox/vector-tile, the id and height rules, joining a building
// split across tiles, the catalogue lookup and the tile cache.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { PbfReader, PbfWriter } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const tiles = require('../../frontend/js/overture-tiles.js');

const EXTENT = 4096;
const zz = n => (n << 1) ^ (n >> 31);

// Rings in tile coordinates (closed or not) → MVT polygon commands.
function polygonCommands(rings) {
    const out = [];
    let x = 0, y = 0;
    for (const ring of rings) {
        const pts = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
        out.push(1 | (1 << 3), zz(pts[0][0] - x), zz(pts[0][1] - y));
        [x, y] = pts[0];
        out.push(2 | ((pts.length - 1) << 3));
        for (const [px, py] of pts.slice(1)) { out.push(zz(px - x), zz(py - y)); x = px; y = py; }
        out.push(7 | (1 << 3));
    }
    return out;
}

// [{ properties, rings }] → bytes of a one-layer ('building') vector tile.
function encodeTile(features, name = 'building') {
    const keys = [], values = [];
    const index = (list, value) => { let i = list.indexOf(value); if (i < 0) { list.push(value); i = list.length - 1; } return i; };
    const encoded = features.map(f => ({
        tags: Object.entries(f.properties).flatMap(([k, v]) => [index(keys, k), index(values, v)]),
        geometry: polygonCommands(f.rings)
    }));
    const pbf = new PbfWriter();
    pbf.writeMessage(3, (_, p) => {
        p.writeVarintField(15, 2);
        p.writeStringField(1, name);
        for (const f of encoded) {
            p.writeMessage(2, (__, q) => {
                q.writePackedVarint(2, f.tags);
                q.writeVarintField(3, 3);
                q.writePackedVarint(4, f.geometry);
            });
        }
        for (const k of keys) p.writeStringField(3, k);
        for (const v of values) {
            p.writeMessage(4, (__, q) => {
                if (typeof v === 'string') q.writeStringField(1, v);
                else if (typeof v === 'boolean') q.writeBooleanField(7, v);
                else if (Number.isInteger(v)) q.writeVarintField(5, v);
                else q.writeDoubleField(3, v);
            });
        }
        p.writeVarintField(5, EXTENT);
    });
    return pbf.finish();
}

const osmSources = id => JSON.stringify([{ dataset: 'OpenStreetMap', property: '', record_id: `${id}@4` }]);
const googleSources = JSON.stringify([{ dataset: 'Google Open Buildings', property: '', record_id: '67P7JW8F+CHRG' }]);
// Exterior rings run clockwise on screen (positive area in tile coordinates, y down); holes the other way.
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const hole = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];

describe('Overture tiles: decoding', () => {
    const z = 14, x = 4820, y = 7981;
    const bytes = encodeTile([
        { properties: { id: 'gers-osm', sources: osmSources('w24518461'), '@geometry_source': 'OpenStreetMap', height: 21.5, class: 'apartments', is_underground: false },
          rings: [square(100, 100, 400, 400), hole(200, 200, 300, 300)] },
        { properties: { id: 'gers-google', sources: googleSources, '@geometry_source': 'Google Open Buildings', num_floors: 4, subtype: 'residential', is_underground: false },
          rings: [square(1000, 1000, 1200, 1300)] },
        { properties: { id: 'gers-below', sources: googleSources, is_underground: true }, rings: [square(2000, 2000, 2100, 2100)] },
        { properties: { id: 'gers-two', sources: googleSources, is_underground: false },
          rings: [square(3000, 3000, 3100, 3100), square(3200, 3000, 3300, 3100)] }
    ]);

    it('decodes the same geometry as @mapbox/vector-tile', () => {
        const reference = new VectorTile(new PbfReader(bytes)).layers.building;
        const ours = tiles.buildingFeaturesFromTile(bytes, z, x, y);
        const expected = [0, 1, 3].map(i => reference.feature(i).toGeoJSON(x, y, z).geometry);
        expect(ours.map(f => f.geometry.type)).toEqual(expected.map(g => g.type));
        ours.forEach((feature, i) => {
            const flat = g => JSON.stringify(g.coordinates).match(/-?\d+\.\d+|-?\d+/g).map(Number);
            const a = flat(feature.geometry), b = flat(expected[i]);
            expect(a.length).toBe(b.length);
            a.forEach((value, k) => expect(value).toBeCloseTo(b[k], 10));
        });
    });

    it('keeps OpenStreetMap ids for OSM outlines, Overture ids otherwise, and leaves out underground buildings', () => {
        const ours = tiles.buildingFeaturesFromTile(bytes, z, x, y);
        expect(ours.map(f => f.id)).toEqual(['w24518461', 'gers-google', 'gers-two']);
        const [osm, google, two] = ours;
        expect(osm.geometry.coordinates).toHaveLength(2); // outer ring + hole
        expect(osm.properties).toMatchObject({ measured_height_m: 21.5, levels: null, building: 'apartments', dataset: 'OpenStreetMap' });
        expect(google.properties).toMatchObject({ measured_height_m: null, levels: 4, building: 'residential' });
        expect(two.geometry.type).toBe('MultiPolygon');
    });

    it('lists the z14 tiles a box touches', () => {
        // Central Bogotá: the test block straddles two tiles (its south edge, 4.6068°, is in the next row).
        expect(tiles.tileRange([-74.0846, 4.6068, -74.0798, 4.6143], 14)).toEqual([[14, 4820, 7981], [14, 4820, 7982]]);
        expect(tiles.tileRange([-74.10, 4.60, -74.07, 4.62], 14)).toHaveLength(4);
    });

    it('joins the copies of a building split at a tile edge into one outline', () => {
        const whole = turf.polygon([[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]].map(r => r.map(([a, b]) => [a * 1e-4, b * 1e-4])));
        const left = turf.bboxClip(whole, [0, 0, 1.1e-4, 1e-4]);
        const right = turf.bboxClip(whole, [0.9e-4, 0, 2e-4, 1e-4]);
        const merged = tiles.mergeTileCopies([{ ...left, id: 'b' }, { ...right, id: 'b' }, { ...right, id: 'c' }], turf);
        expect(merged.map(f => f.id)).toEqual(['b', 'c']);
        expect(turf.area(merged[0])).toBeCloseTo(turf.area(whole), 0);
    });
});

describe('Overture tiles: live source', () => {
    const catalogue = {
        'https://stac.overturemaps.org/catalog.json': { latest: '2026-09-23.1' },
        'https://stac.overturemaps.org/2026-09-23.1/buildings/catalog.json': {
            links: [{ rel: 'pmtiles', href: 'https://tiles.overturemaps.org/2026-09-23.1/buildings.pmtiles' }]
        }
    };
    const fetchImpl = async url => (catalogue[url]
        ? { ok: true, status: 200, json: async () => catalogue[url] }
        : { ok: false, status: 404, json: async () => ({}) });

    it('finds the newest release in the STAC catalogue', async () => {
        expect(await tiles.latestBuildingsUrl(fetchImpl)).toEqual({
            release: '2026-09-23.1', url: 'https://tiles.overturemaps.org/2026-09-23.1/buildings.pmtiles'
        });
    });

    it('reads each tile once, joins a building across two tiles and keeps only what touches the box', async () => {
        const z = 14, n = 2 ** z;
        // Two horizontally adjacent tiles; building 'edge' spans their shared edge (clipped with a buffer).
        const x0 = 4820, y0 = 7981;
        const tileBytes = {
            [`${x0}/${y0}`]: encodeTile([
                { properties: { id: 'edge', sources: googleSources }, rings: [square(4000, 100, 4096 + 64, 200)] },
                { properties: { id: 'far', sources: googleSources }, rings: [square(10, 4000, 20, 4010)] }
            ]),
            [`${x0 + 1}/${y0}`]: encodeTile([
                { properties: { id: 'edge', sources: googleSources }, rings: [square(-64, 100, 100, 200)] }
            ])
        };
        const reads = [];
        let opened = null;
        const source = tiles.createOvertureTilesSource({
            turf,
            fetchImpl,
            openArchive: url => {
                opened = url;
                return { getZxy: async (tz, tx, ty) => { reads.push(`${tz}/${tx}/${ty}`); const data = tileBytes[`${tx}/${ty}`]; return data ? { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } : undefined; } };
            }
        });
        const lng = t => t / n * 360 - 180;
        const lat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
        // A box over the top strip of both tiles, around the shared edge.
        const box = [lng(x0 + 0.9), lat(y0 + 0.1), lng(x0 + 1.1), lat(y0 + 0.02)];
        const first = await source.featuresIn(box);
        expect(opened).toBe('https://tiles.overturemaps.org/2026-09-23.1/buildings.pmtiles');
        expect(first.features.map(f => f.id)).toEqual(['edge']);
        const [w, , e] = turf.bbox(first.features[0]);
        expect(w).toBeCloseTo(lng(x0 + 4000 / 4096), 9);
        expect(e).toBeCloseTo(lng(x0 + 1 + 100 / 4096), 9);
        await source.featuresIn(box);
        expect(reads.sort()).toEqual([`14/${x0}/${y0}`, `14/${x0 + 1}/${y0}`]);
    });

    it('reads only the tiles nearest the centre of a box wider than its budget, and says so', async () => {
        const reads = [];
        const source = tiles.createOvertureTilesSource({ turf, fetchImpl, openArchive: () => ({ getZxy: async (z, x, y) => { reads.push([x, y]); } }) });
        const result = await source.featuresIn([-74.2, 4.5, -74.0, 4.7]);
        expect(result.truncated).toBe(true);
        expect(reads).toHaveLength(9);
        const centre = tiles.tileRange([-74.1, 4.6, -74.1, 4.6], 14)[0];
        expect(reads).toContainEqual([centre[1], centre[2]]);
    });

    it('asks the catalogue again after it failed', async () => {
        let up = false;
        const flaky = async url => (up ? fetchImpl(url) : { ok: false, status: 503, json: async () => ({}) });
        const source = tiles.createOvertureTilesSource({ turf, fetchImpl: flaky, openArchive: () => ({ getZxy: async () => undefined }) });
        const box = [-74.0846, 4.6068, -74.0798, 4.6143];
        await expect(source.featuresIn(box)).rejects.toThrow(/503/);
        up = true;
        await expect(source.featuresIn(box)).resolves.toMatchObject({ features: [] });
    });
});
