// Region outline extraction (scripts/extract-world-regions.mjs) on small Natural Earth-shaped
// fixtures: which admin-1 and map-unit features become globe regions, under which ISO 3166-2 id,
// and what the compact checked-in world-parcels/regions.geojson keeps.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION_SCHEMES, extractRegions } from '../../scripts/extract-world-regions.mjs';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const box = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const polygon = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: box(x0, y0, x1, y1) });

// One admin-1 feature per scheme country so the extractor's completeness check passes, plus cases.
function admin1Fixture(extra = []) {
    const base = Object.entries(REGION_SCHEMES).filter(([, layer]) => layer === 'admin1').map(([cc], i) => ({
        type: 'Feature',
        properties: { iso_a2: cc, iso_3166_2: `${cc}-X${i}`, name: `Local ${cc}`, name_en: `Region ${cc}`, latitude: 1, longitude: 1, adm0_a3: cc + 'X', gu_a3: 'XXX' },
        geometry: polygon(i * 2, 0, i * 2 + 1, 1)
    }));
    return { type: 'FeatureCollection', features: [...base, ...extra] };
}
const admin1 = (cc, code, props, geometry) => ({ type: 'Feature', properties: { iso_a2: cc, iso_3166_2: code, latitude: 5, longitude: 5, ...props }, geometry });
const mapUnit = (adm0, gu, geounit, geometry) => ({ type: 'Feature', properties: { ADM0_A3: adm0, GU_A3: gu, GEOUNIT: geounit, LABEL_Y: 2, LABEL_X: 2 }, geometry });
const mapUnits = { type: 'FeatureCollection', features: [
    mapUnit('GBR', 'ENG', 'England', polygon(40, 50, 42, 52)),
    mapUnit('GBR', 'WLS', 'Wales', polygon(38, 50, 40, 52)),
    mapUnit('BEL', 'BFR', 'Flemish Region', polygon(44, 50, 46, 52)),
    mapUnit('FRA', 'FRA', 'France', polygon(0, 40, 5, 45))
] };

describe('extractRegions', () => {
    it('keys admin-1 regions by ISO 3166-2, renaming, merging and splitting where Natural Earth is out of date', () => {
        const result = extractRegions({ mapUnits, admin1: admin1Fixture([
            admin1('MX', 'MX-DIF', { name: 'Distrito Federal', name_en: 'Mexico' }, polygon(60, 0, 61, 1)),
            admin1('AU', 'AU-NSW', { name_en: 'New South Wales', latitude: -32 }, polygon(70, -40, 80, -30)),
            admin1('AU', 'AU-NSW', { name_en: 'Lord Howe Island', latitude: -31.5 }, polygon(90, -32, 90.1, -31.9)),
            admin1('AU', 'AU-X02~', { name_en: 'Jervis Bay Territory' }, polygon(85, -36, 86, -35)),
            admin1('ID', 'ID-PA', { name_en: 'Papua' }, polygon(130, -5, 140, 0)),
            admin1('IT', 'IT-PA', { name_en: 'Palermo' }, polygon(13, 37, 14, 38)),
            admin1('GB', 'GB-LND', { name_en: 'City of London', adm0_a3: 'GBR', gu_a3: 'ENG' }, polygon(40, 51, 41, 52)),
            admin1('BE', 'BE-VAN', { name_en: 'Antwerp', adm0_a3: 'BEL', gu_a3: 'BFR' }, polygon(44, 51, 45, 52))
        ]) });
        const byId = Object.fromEntries(result.features.map(feature => [feature.properties.id, feature]));

        expect(byId['MX-CMX'].properties).toMatchObject({ cc: 'MX', name: 'Mexico City' });
        expect(byId['MX-DIF']).toBeUndefined();
        // Lord Howe joins NSW (sub-threshold islands drop out), and the mainland keeps the label.
        expect(byId['AU-NSW'].properties).toMatchObject({ name: 'New South Wales', labelLat: -32 });
        expect(byId['AU-NSW'].geometry.type).toBe('Polygon');
        expect(byId['AU-X02~']).toBeUndefined();
        expect(byId['ID-PA'].properties).toMatchObject({ codes: ['ID-PA', 'ID-PP', 'ID-PS', 'ID-PT'] });
        // Italy is not in a region scheme; GB and BE admin-1 units are members, not regions.
        expect(byId['IT-PA']).toBeUndefined();
        expect(byId['GB-LND']).toBeUndefined();
        expect(byId['GB-ENG'].properties).toMatchObject({ cc: 'GB', name: 'England', members: ['GB-LND'], labelLat: 2 });
        expect(byId['GB-WLS'].properties).toMatchObject({ name: 'Wales', members: [] });
        expect(byId['BE-VLG'].properties).toMatchObject({ cc: 'BE', name: 'Flemish Region', members: ['BE-VAN'] });
        expect(byId['FR-FRA']).toBeUndefined();
        const ids = result.features.map(feature => feature.properties.id);
        expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    });

    it('fails when a scheme country has no outline at all', () => {
        const withoutCanada = admin1Fixture();
        withoutCanada.features = withoutCanada.features.filter(feature => feature.properties.iso_a2 !== 'CA');
        expect(() => extractRegions({ admin1: withoutCanada, mapUnits })).toThrow(/CA/);
    });

    it('keeps the checked-in outlines in step with the build: every scheme country, ISO ids, no stray countries', () => {
        const outlines = JSON.parse(readFileSync(path.join(REPO, 'world-parcels/regions.geojson'), 'utf8'));
        expect(outlines.metadata).toMatchObject({ generatedBy: 'scripts/extract-world-regions.mjs', naturalEarthVersion: 'v5.1.2' });
        const countries = new Set(outlines.features.map(feature => feature.properties.cc));
        expect([...countries].sort()).toEqual(Object.keys(REGION_SCHEMES).sort());
        for (const { properties } of outlines.features) {
            expect(properties.id).toMatch(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
            expect(properties.id.slice(0, 2)).toBe(properties.cc);
        }
        expect(outlines.features.filter(feature => feature.properties.cc === 'GB').map(feature => feature.properties.id))
            .toEqual(['GB-ENG', 'GB-NIR', 'GB-SCT', 'GB-WLS']);
    });
});
