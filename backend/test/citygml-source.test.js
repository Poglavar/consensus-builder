// The CityGML building reader and its sheet source: Vienna's LOD2.1 sheet 096076 (a real fixture)
// parses into roof, wall and ground surfaces, projects into Vienna at sea-level heights, and the
// source fetches each sheet once, treats an unpublished sheet as empty and fails on other errors.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import proj4 from 'proj4';
import { parseCityGml, buildingRecord } from '../buildings/citygml.js';
import { createCityGmlSource } from '../buildings/citygml-source.js';
import { WIEN_LOD2 } from '../buildings/wien-lod2.js';

const gml = readFileSync(new URL('./fixtures/wien-lod2-096076.gml', import.meta.url), 'utf8');
const toLngLat = proj4(WIEN_LOD2.crs, 'EPSG:4326');
const quiet = { log() {} };

function fakeFetch(sheets) {
    return vi.fn(async url => {
        const sheet = url.match(/\/(\d{6})_lod2_gml\.zip$/)[1];
        if (!(sheet in sheets)) return new Response('missing', { status: 404 });
        if (sheets[sheet] === 500) return new Response('down', { status: 500 });
        return new Response(zipSync({ [`${sheet}/${sheet}.gml`]: strToU8(sheets[sheet]) }));
    });
}

describe('parseCityGml', () => {
    it('reads each building with its semantic surfaces and attributes', () => {
        const buildings = parseCityGml(gml);
        expect(buildings.map(b => b.id)).toEqual(['UUID_LOD2_A01382-2b003520-7620-4798-8e1c', 'UUID_LOD2_A01382-db16ad03-a77e-4bee-a80a']);
        expect(buildings[0]).toMatchObject({ name: 'A01382', measuredHeightM: 3.78, roofType: 'SATTELDACH', attributes: { Blattnummer: '096076' } });
        expect(buildings[0].surfaces.map(s => s.kind).sort()).toEqual(['ground', 'roof', 'roof', 'wall', 'wall', 'wall', 'wall']);
        expect(buildings[0].surfaces.every(s => s.rings[0].length >= 4 && s.rings[0].every(p => p.length === 3))).toBe(true);
    });

    it('falls back to the geometry polygons of a building without semantic surfaces', () => {
        const lod1 = `<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:gml="http://www.opengis.net/gml">
            <core:cityObjectMember><bldg:Building gml:id="b1"><bldg:lod1Solid><gml:Solid><gml:exterior><gml:CompositeSurface>
            <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList srsDimension="3">0 0 0 10 0 0 10 10 0 0 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
            </gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod1Solid></bldg:Building></core:cityObjectMember></core:CityModel>`;
        expect(parseCityGml(lod1)).toEqual([expect.objectContaining({ id: 'b1', surfaces: [{ kind: 'surface', rings: [[[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 0, 0]]] }] })]);
    });

    it('refuses coordinates that are not 3D triples', () => {
        const flat = gml.replace(/(<gml:posList>[^<]*?) [\d.-]+(<\/gml:posList>)/, '$1$2');
        expect(() => parseCityGml(flat)).toThrow(/3D triples/);
    });
});

describe('buildingRecord', () => {
    it('places the building in Vienna, at heights above the Adriatic, with its ground surface as footprint', () => {
        const [first] = parseCityGml(gml);
        const { record, footprint, heightM } = buildingRecord(first, (x, y) => toLngLat.forward([x, y]),
            { heightOffsetM: WIEN_LOD2.heightOffsetM, idPrefix: 'wien-lod2:' });
        expect(record.object_id).toBe('wien-lod2:UUID_LOD2_A01382-2b003520-7620-4798-8e1c');
        const [lng, lat, z] = record.faces[0].coordinates[0][0];
        expect(lng).toBeGreaterThan(16.30); expect(lng).toBeLessThan(16.32);
        expect(lat).toBeGreaterThan(48.18); expect(lat).toBeLessThan(48.19);
        expect(z).toBeGreaterThan(190); expect(z).toBeLessThan(200);
        expect(record.z_max).toBeGreaterThan(record.z_min);
        expect(footprint.type).toBe('MultiPolygon');
        expect(footprint.coordinates[0][0][0]).toHaveLength(2);
        expect(heightM).toBe(3.78);
    });
});

describe('Vienna sheets', () => {
    it('numbers 500 m sheets by column from x = −50 km and row from y = 300 km', () => {
        expect(WIEN_LOD2.sheetsFor([4600, 341200, 4600, 341200])).toEqual(['109082']);
        expect(WIEN_LOD2.sheetsFor([1200, 340600, 1200, 340600])).toEqual(['102081']);
        expect(WIEN_LOD2.sheetsFor([-1660, 338280, -1660, 338280])).toEqual(['096076']);
        expect(WIEN_LOD2.sheetsFor([-10, 340990, 10, 341010])).toEqual(['099081', '099082', '100081', '100082']);
    });
});

describe('createCityGmlSource', () => {
    const point = { type: 'Point', coordinates: toLngLat.forward([-1660, 338285]) };

    it('answers near from the sheets under the box, fetching each sheet once', async () => {
        const fetchImpl = fakeFetch({ '096076': gml });
        const source = createCityGmlSource(WIEN_LOD2, { fetchImpl, log: quiet });
        const first = await source.near(point, 60);
        expect(first).toMatchObject({ source: 'wien-lod2', count: 2 });
        expect(first.buildings[0].faces.some(face => face.kind === 'roof')).toBe(true);
        await source.near(point, 60);
        const asked = fetchImpl.mock.calls.map(([url]) => url);
        expect(asked.filter(url => url.endsWith('/096076_lod2_gml.zip'))).toHaveLength(1);
        expect(new Set(asked).size).toBe(asked.length);
    });

    it('lists footprints with their measured height', async () => {
        const source = createCityGmlSource(WIEN_LOD2, { fetchImpl: fakeFetch({ '096076': gml }), log: quiet });
        const [lng, lat] = point.coordinates;
        const box = { type: 'Polygon', coordinates: [[[lng - .001, lat - .001], [lng + .001, lat - .001], [lng + .001, lat + .001], [lng - .001, lat + .001], [lng - .001, lat - .001]]] };
        const result = await source.footprints(box);
        expect(result.truncated).toBe(false);
        expect(result.footprints.map(f => f.height_m).sort()).toEqual([3.78, 4.6]);
    });

    it('fails when a sheet cannot be read, and marks a box with too many sheets partial', async () => {
        const broken = createCityGmlSource(WIEN_LOD2, { fetchImpl: fakeFetch({ '096076': 500 }), log: quiet });
        await expect(broken.near(point, 10)).rejects.toThrow(/HTTP 500/);
        const fetchImpl = fakeFetch({});
        const wide = createCityGmlSource(WIEN_LOD2, { fetchImpl, log: quiet });
        const [lng, lat] = point.coordinates;
        const result = await wide.near({ type: 'Polygon', coordinates: [[[lng, lat], [lng + .05, lat], [lng + .05, lat + .05], [lng, lat + .05], [lng, lat]]] }, 0);
        expect(result).toMatchObject({ count: 0, partial: true });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
