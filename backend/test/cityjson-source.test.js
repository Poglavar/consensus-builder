// The CityJSON building reader and the 3D BAG source: a real 3DBAG API page (two buildings) parses
// into one building per BAG id with its part's most detailed solid, places in Amsterdam at NAP heights,
// and the source follows the API's next links, joins buildings by id and fails on HTTP errors.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { parseCityJson } from '../buildings/cityjson.js';
import { buildingRecord } from '../buildings/citygml.js';
import { createCityGmlSource } from '../buildings/citygml-source.js';
import { NL_3DBAG } from '../buildings/nl-3dbag.js';

const page = JSON.parse(readFileSync(new URL('./fixtures/nl-3dbag-page.json', import.meta.url), 'utf8'));
const toLngLat = proj4(NL_3DBAG.crs, 'EPSG:4326');
const quiet = { log() {} };
const grounds = building => building.surfaces.filter(surface => surface.kind === 'ground').length;

describe('parseCityJson', () => {
    it('reads one building per BAG id from its part, at the most detailed LoD allowed', () => {
        const detailed = parseCityJson(page, { maxLod: 2.2 });
        const coarse = parseCityJson(page, { maxLod: 1.2 });
        expect(detailed.map(b => b.id)).toEqual(['NL.IMBAG.Pand.0363100012165126', 'NL.IMBAG.Pand.0363100012165128']);
        expect(detailed[0].surfaces.length).toBeGreaterThan(coarse[0].surfaces.length);
        expect(new Set(detailed[0].surfaces.map(s => s.kind))).toEqual(new Set(['ground', 'wall', 'roof']));
        // The building's own LoD 0 footprint does not join the part's solid: one ground, not two.
        expect(grounds(coarse[0])).toBe(grounds(parseCityJson({ ...page, features: page.features.map(feature => ({
            ...feature, CityObjects: Object.fromEntries(Object.entries(feature.CityObjects).map(([id, o]) =>
                [id, o.type === 'Building' ? { ...o, geometry: [] } : o])) })) }, { maxLod: 1.2 })[0]));
    });

    it('falls back to a LoD 0 footprint as the ground when nothing else is there', () => {
        const [only] = parseCityJson(page, { maxLod: 0 });
        expect(only.surfaces.map(s => s.kind)).toEqual(['ground']);
    });

    it('applies the page transform to the integer vertices', () => {
        const [building] = parseCityJson(page);
        const [x, y] = building.surfaces[0].rings[0][0];
        expect(x).toBeGreaterThan(121000); expect(x).toBeLessThan(121500);
        expect(y).toBeGreaterThan(487000); expect(y).toBeLessThan(487500);
    });

    it('refuses an index into a missing vertex', () => {
        const broken = structuredClone(page);
        broken.features[0].vertices = broken.features[0].vertices.slice(0, 3);
        expect(() => parseCityJson(broken)).toThrow(/vertex/);
    });
});

describe('the 3D BAG source', () => {
    it('places a building in Amsterdam at NAP heights', () => {
        const [building] = parseCityJson(page);
        const { record } = buildingRecord(building, (x, y) => toLngLat.forward([x, y]), { heightOffsetM: 0 });
        const [lng, lat, z] = record.faces[0].coordinates[0][0];
        expect(lng).toBeGreaterThan(4.88); expect(lng).toBeLessThan(4.90);
        expect(lat).toBeGreaterThan(52.36); expect(lat).toBeLessThan(52.38);
        expect(z).toBeGreaterThan(-5); expect(z).toBeLessThan(40);
    });

    it('follows next links, joins buildings by id and takes heights from 3D BAG attributes', async () => {
        const second = { ...page, features: page.features.slice(1), links: [] };
        const first = { ...page, links: [{ rel: 'next', href: 'https://api.3dbag.nl/collections/pand/items?page=2' }] };
        const fetchImpl = vi.fn(async url => Response.json(url.endsWith('page=2') ? second : first));
        const buildings = await NL_3DBAG.readSheet('485_1949', { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][0]).toBe('https://api.3dbag.nl/collections/pand/items?bbox=121250,487250,121500,487500&limit=100');
        expect(buildings).toHaveLength(2);
        const roof = buildings[0].attributes.b3_h_dak_max, ground = buildings[0].attributes.b3_h_maaiveld;
        expect(buildings[0].measuredHeightM).toBeCloseTo(roof - ground, 2);
    });

    it('fails on an HTTP error rather than answering an empty sheet', async () => {
        const source = createCityGmlSource(NL_3DBAG, { fetchImpl: async () => new Response('down', { status: 503 }), log: quiet });
        await expect(source.near({ type: 'Point', coordinates: [4.893, 52.3731] }, 20)).rejects.toThrow(/HTTP 503/);
    });

    it('numbers 250 m sheets of RD New', () => {
        expect(NL_3DBAG.sheetsFor([121300, 487300, 121300, 487300])).toEqual(['485_1949']);
        expect(NL_3DBAG.sheetsFor([121240, 487240, 121260, 487260])).toEqual(['484_1948', '484_1949', '485_1948', '485_1949']);
    });
});
