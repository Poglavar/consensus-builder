import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/building-unit-links.js');
const mapShare = require('../../frontend/js/map-share.js');

const model = { suggested: true, registration: { corners: [[71, 51], [72, 51], [72, 52], [71, 52]] } };
const layout = { architecture: { apartmentRegions: [{ id: 'flat-a', polygons: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]] }] } };

describe('building unit addresses', () => {
    it('names the source building and escapes any embedded address separators', () => {
        expect(links.nativeBuilding('astana', 'kz-nsdi-buildings', 'KZ-NSDI-B-43399'))
            .toBe('astana::kz-nsdi-buildings::KZ-NSDI-B-43399');
        expect(links.nativeBuilding('astana', 'osm', 'x::y')).not.toBe(links.nativeBuilding('astana', 'osm::x', 'y'));
        expect(links.designBuilding('revision-a', 'building-1')).not.toBe(links.designBuilding('revision-b', 'building-1'));
    });

    it('numbers flats per storey and keeps the number when an estimated layout is redrawn', () => {
        const storey = level => ({ level, elevationM: level * 3, units: [{ id: 'stair', kind: 'office' }, { id: `flat-a-${level}`, kind: 'apartment', areaM2: 54, rooms: 2 }, { id: `flat-b-${level}`, kind: 'apartment' }] });
        const keys = (floor, plan = layout) => links.unitsForStorey(model, storey(floor), plan).map(unit => unit.key);
        expect(keys(1)).toEqual(['1::1', '1::2']);
        expect(keys(-1)).toEqual(['-1::1', '-1::2']);
        const revised = structuredClone(layout);
        revised.architecture.apartmentRegions[0].polygons[0][0][1][0] = .9;
        expect(keys(1, revised)).toEqual(keys(1));
        expect(links.unitsForStorey(model, storey(1), layout)[0]).toMatchObject({ areaM2: 54, rooms: 2, ordinal: 1, regionId: 'flat-a' });
    });

    it('gives every use of a flat one identity: building, storey and flat number', () => {
        const building = links.nativeBuilding('almaty', 'osm', 'w51214877');
        expect(links.flatKey(building, '12::3')).toBe(JSON.stringify(['flat/v1', building, 12, 3]));
        expect(links.flatHash(building, '12::3')).toMatch(/^[0-9a-f]{64}$/);
        expect(links.flatHash(building, '12::3')).not.toBe(links.flatHash(building, '12::4'));
        for (const unit of ['12::flat-a-12::7984e5b4a4760b077382e106', '12::0', '12', 'x::1']) expect(links.apartmentUnitLocator(unit)).toBeNull();
        expect(() => links.flatKey(building, '12::flat-a')).toThrow();
    });

    it('opens the same unit with the correct source, camera and layout settings', () => {
        expect(links.read('?xrayBuilding=local-layout-key&unit=1::a')).toBeNull();
        const selection = { building: links.nativeBuilding('astana', 'kz-nsdi-buildings', 'KZ-NSDI-B-43399'),
            unit: '1::1', suggested: true, access: 'corridor', center: [71.42, 51.12] };
        const url = new URL(links.link('http://localhost:8173/?draft=private', mapShare,
            { city: 'astana', backend: 'https://api.example.test', language: 'kk' }, selection));
        expect(links.read(url.search)).toEqual({ building: selection.building, unit: selection.unit, openFloor: true });
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ city: 'astana', backend: 'https://api.example.test', lang: 'kk',
            at: '51.12,71.42,19', camera: '51.12,71.42,0,-1.52,95', xray: 'built', access: 'corridor', existing: 'ghost' });
        expect(url.searchParams.has('draft')).toBe(false);
        const revision = 'bafkrei' + 'a'.repeat(52);
        const design = new URL(links.link(url, mapShare, { city: 'astana' }, {
            ...selection, building: links.designBuilding(revision, 'building-a'), suggested: false
        }));
        expect(design.pathname).toBe('/designs/' + revision);
        expect(design.searchParams.get('xray')).toBe('proposed');
        expect(design.searchParams.has('suggestedExisting')).toBe(false);
    });

    it('opens an apartment in its source city when the funding agreement is based elsewhere', () => {
        const apartment = { xrayBuilding: 'astana::kz-nsdi-buildings::KZ-NSDI-B-43399',
            unit: '7::2', at: '51.12,71.42,19', access: 'point' };
        const context = { city: 'alatau', backend: 'https://api.example.test' };
        const url = new URL(links.offerLink('https://app.example.test', mapShare, context, apartment));
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ city: 'astana', xrayBuilding: apartment.xrayBuilding,
            unit: apartment.unit, xray: 'built', access: 'point', backend: context.backend });
    });
});
