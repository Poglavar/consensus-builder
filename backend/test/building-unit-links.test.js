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

    it('keeps a generated occurrence stable and distinguishes storeys and changed boundaries', () => {
        const storey = level => ({ level, elevationM: level * 3, units: [{ id: `flat-a-${level}`, kind: 'apartment' }] });
        const key = (floor, plan = layout) => links.unitsForStorey(model, storey(floor), plan)[0].key;
        expect(key(1)).toMatch(/^1::flat-a-1::[0-9a-f]{24}$/);
        expect(key(1)).toBe(key(1, structuredClone(layout)));
        expect(key(1)).not.toBe(key(2));
        const revised = structuredClone(layout);
        revised.architecture.apartmentRegions[0].polygons[0][0][1][0] = .9;
        expect(key(1)).not.toBe(key(1, revised));
        revised.architecture.apartmentRegions = [];
        expect(key(1, revised)).toBeNull();
    });

    it('uses the published unit ID and ignores non-apartment units', () => {
        const storey = { level: 1, units: [{ id: 'stair', kind: 'office' }, { id: 'A1-1', kind: 'apartment', areaM2: 54 }] };
        const result = links.unitsForStorey({ ...model, suggested: false }, storey, { architecture: {} });
        expect(result).toEqual([{ id: 'A1-1', ordinal: 1, key: '1::A1-1', regionId: null, areaM2: 54 }]);
    });

    it('opens the same unit with the correct source, camera and layout settings', () => {
        expect(links.read('?xrayBuilding=local-layout-key&unit=1::a')).toBeNull();
        const selection = { building: links.nativeBuilding('astana', 'kz-nsdi-buildings', 'KZ-NSDI-B-43399'),
            unit: '1::flat-a-1::proof', suggested: true, access: 'corridor', center: [71.42, 51.12] };
        const url = new URL(links.link('http://localhost:8173/?draft=private', mapShare,
            { city: 'astana', backend: 'https://api.example.test', language: 'kk' }, selection));
        expect(links.read(url.search)).toEqual({ building: selection.building, unit: selection.unit, openFloor: true });
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ city: 'astana', backend: 'https://api.example.test', lang: 'kk',
            at: '51.12,71.42,19', camera: '51.12,71.42,0,-1.52,95', xray: '1', suggested: '1', suggestedExisting: '1', access: 'corridor', existing: 'ghost' });
        expect(url.searchParams.has('draft')).toBe(false);
        const design = new URL(links.link(url, mapShare, { city: 'astana' }, { ...selection, designCid: 'revision-a', suggested: false }));
        expect(design.pathname).toBe('/designs/revision-a');
        expect(design.searchParams.has('suggestedExisting')).toBe(false);
    });

    it('opens an apartment in its source city when the funding agreement is based elsewhere', () => {
        const apartment = { xrayBuilding: 'astana::kz-nsdi-buildings::KZ-NSDI-B-43399',
            unit: '7::core-2-whole-7::7984e5b4a4760b077382e106', at: '51.12,71.42,19', access: 'point' };
        const context = { city: 'alatau', backend: 'https://api.example.test' };
        const url = new URL(links.offerLink('https://app.example.test', mapShare, context, apartment));
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ city: 'astana', xrayBuilding: apartment.xrayBuilding,
            unit: apartment.unit, suggestedExisting: '1', access: 'point', backend: context.backend });
    });
});
