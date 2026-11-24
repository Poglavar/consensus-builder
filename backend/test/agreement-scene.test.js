import { describe, expect, it, vi } from 'vitest';
import buildAgreementScene from '../thumbnails/agreement-scene.js';

const square = (x, y, d = 0.001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const providerFor = (buildings, extra = {}) => ({
    footprintsUnder: vi.fn(async regions => ({ regions: new Map(regions.map(region => [region.key, buildings])), source: 'fixture', ...extra }))
});

describe('agreement scene source contract', () => {
    it('uses footprintsUnder view regions and preserves untouched, removed, and partial source facts', async () => {
        const site = square(10, 10, 0.004), untouched = square(10.0001, 10.0001, 0.0004), removed = square(10.001, 10.001, 0.0004), partial = square(10.0012, 10.0008, 0.0008);
        const building = feature(square(10.001, 10.001, 0.0004), { height: 8, floors: 2 });
        const source = providerFor([
            { id: 'untouched', geometry: untouched, height_m: 5, floors: 2 },
            { id: 'removed', geometry: removed, height_m: 11, floors: 4 },
            { id: 'partial', geometry: partial, height_m: 7, floors: 2 }
        ]);
        const scene = await buildAgreementScene(null, { city: 'fixture', designs: [{ content: { goal: 'single', site, geometry: { buildings: [building] }, buildingProposal: { buildings: [building] } } }] }, { buildingProvider: source });
        expect(source.footprintsUnder).toHaveBeenCalledOnce();
        expect(source.footprintsUnder.mock.calls[0][0][0]).toMatchObject({ key: 'view', geometry: expect.any(Object) });
        expect(scene.baselineComplete).toBe(true);
        expect(scene.before).toEqual(expect.arrayContaining([
            expect.objectContaining({ geometry: untouched, height: 5, floors: 2 }), expect.objectContaining({ geometry: removed, height: 11, floors: 4 }), expect.objectContaining({ geometry: partial, height: 7, floors: 2 })
        ]));
        expect(scene.before).toHaveLength(3);
        expect(scene.retained).toEqual(expect.arrayContaining([expect.objectContaining({ geometry: untouched, height: 5, floors: 2 }), expect.objectContaining({ height: 7, floors: 2 })]));
        expect(scene.retained).not.toEqual(expect.arrayContaining([expect.objectContaining({ geometry: removed })]));
        expect(scene.retained.find(b => b.height === 7).geometry).not.toEqual(partial);
    });

    it('distinguishes a true empty complete source from failed or truncated source', async () => {
        const building = feature(square(10, 10), { height: 6, floors: 2 });
        const content = { goal: 'single', geometry: { buildings: [building] }, buildingProposal: { buildings: [building] } };
        const empty = await buildAgreementScene(null, { designs: [{ content }] }, { buildingProvider: providerFor([]) });
        expect(empty.baselineComplete).toBe(true); expect(empty.before).toEqual([]);
        for (const result of [{ unavailable: true, regions: [] }, { truncated: true, regions: [] }]) {
            const scene = await buildAgreementScene(null, { designs: [{ content }] }, { buildingProvider: { footprintsUnder: vi.fn(async () => result) } });
            expect(scene.baselineComplete).toBe(false); expect(scene.before).toEqual([]);
        }
    });

    it('keeps ground-only changes and excludes ownership-only agreements with parcel context', async () => {
        const parcel = square(10, 10), parcelResolver = vi.fn(async ids => { expect(ids).toEqual(['p1']); return [{ type: 'Polygon', coordinates: parcel.coordinates }]; });
        const park = await buildAgreementScene(null, { designs: [{ content: { goal: 'park', site: parcel, structureProposal: { kind: 'park', geometry: parcel } } }], inputParcelIds: ['p1'] }, { parcelResolver, buildingProvider: providerFor([]) });
        expect(park.surfaces).toEqual([{ geometry: parcel, kind: 'park' }]);
        const ownership = await buildAgreementScene(null, { designs: [{ content: { goal: 'ownership-transfer', site: parcel } }], inputParcelIds: ['p1'] }, { parcelResolver, buildingProvider: providerFor([]) });
        expect(ownership).toBeNull();
    });

    it('keeps two multi-design buildings separate without inventing height or floors', async () => {
        const first = feature(square(10, 10), { floors: 1 }), second = feature(square(10, 10), {});
        const scene = await buildAgreementScene(null, { designs: [{ content: { goal: 'single', geometry: { buildings: [first] }, buildingProposal: { buildings: [first] } } }, { content: { goal: 'single', geometry: { buildings: [second] }, buildingProposal: { buildings: [second] } } }] }, { buildingProvider: providerFor([]) });
        expect(scene.proposed).toHaveLength(2); expect(scene.proposed[0]).toMatchObject({ height: 3, floors: 1 }); expect(scene.proposed[1]).toMatchObject({ height: null, floors: null });
    });
});
