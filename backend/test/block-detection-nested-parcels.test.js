import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { createMcpNavigation } from '../agents/mcp-navigation.js';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/urban-blocks-model.js');
const detection = require('../../frontend/js/parcels/block-detection.js');
const ring = (min, max) => [[min, min], [max, min], [max, max], [min, max], [min, min]];
const parcel = (id, rings) => ({ ...turf.polygon(rings, { parcelId: id }), id });
const boundary = (id, coordinates) => turf.lineString(coordinates, { highway: 'residential' }, { id });
const outerBoundary = boundary('outer-street', ring(0, 0.01));

function fixture({ holes = true, innerStreet = false } = {}) {
    const outer = parcel('outer', [ring(0.001, 0.009), ...(holes ? [ring(0.003, 0.007).reverse()] : [])]);
    const middle = parcel('middle', [ring(0.003, 0.007), ...(holes ? [ring(0.004, 0.006).reverse()] : [])]);
    const inner = parcel('inner', [ring(0.004, 0.006)]);
    const outside = parcel('outside', [ring(0.011, 0.012)]);
    return { features: [outer, middle, inner, outside], boundaries: { complete: true,
        features: [outerBoundary, ...(innerStreet ? [boundary('inner-street', ring(0.003, 0.007))] : [])] } };
}

async function shared(f, seed) {
    return detection.detect({ seed, turf, model, limit: 100,
        fetchBoundaries: async () => f.boundaries,
        loadParcels: async () => ({ complete: true, features: f.features }) });
}

describe('nested parcels in detected blocks', () => {
    it.each([true, false])('includes every nested identity from either seed (source holes: %s)', async holes => {
        const f = fixture({ holes });
        const before = JSON.stringify(f.features);
        for (const seed of f.features.slice(0, 3)) {
            const result = await shared(f, seed);
            expect(result.isValid).toBe(true);
            expect(result.ids.slice().sort()).toEqual(['inner', 'middle', 'outer']);
        }
        expect(JSON.stringify(f.features)).toBe(before);
    });

    it('keeps parcels behind an inner street loop in their own enclosure', async () => {
        const f = fixture({ innerStreet: true });
        expect((await shared(f, f.features[0])).ids).toEqual(['outer']);
        expect((await shared(f, f.features[2])).ids.slice().sort()).toEqual(['inner', 'middle']);
    });

    it('selects inner workshop parcels with their surrounding land in both detector and MCP', async () => {
        const f = fixture({ innerStreet: true });
        f.boundaries.features[1].properties = { railway: 'workshop', building: 'industrial' };
        expect((await shared(f, f.features[0])).ids.slice().sort()).toEqual(['inner', 'middle', 'outer']);
        const read = {
            parcels: async ({ parcelIds } = {}) => ({ complete: true,
                features: parcelIds ? f.features.filter(feature => parcelIds.includes(feature.id)) : f.features }),
            request: async () => f.boundaries
        };
        const result = await createMcpNavigation({ read }).selectParcels({
            city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'outer'
        });
        expect(result.selection.parcelIds.slice().sort()).toEqual(['inner', 'middle', 'outer']);
    });

    it.each([false, true])('loads complete browser ground before choosing members (inner street: %s)', async innerStreet => {
        const f = fixture({ innerStreet });
        let loaded = [f.features[0]];
        const ensureBounds = vi.fn(async () => { loaded = f.features; return { status: 'ready' }; });
        const win = {
            turf, UrbanBlocksModel: model, __parcelBlockTopology: { MAX_BLOCK_PARCELS: 100 },
            CityConfigManager: { getCurrentCityId: () => 'test' },
            LiveParcelFabric: { peekBounds: () => loaded, revision: () => 1 },
            CadastralParcelRepository: { ensureBounds, ensureRoadIds: async () => ({ status: 'unsupported', ids: [] }) },
            L: { latLngBounds: (sw, ne) => ({ sw, ne }) },
            getBackendBase: () => 'https://example.test', appendBuildToken: path => path,
            fetch: async () => ({ ok: true, json: async () => f.boundaries }),
            Worker: class {
                postMessage({ roads, bbox }) { this.onmessage({ data: { blocks: model.detectBlocks(roads, bbox, turf) } }); }
                terminate() {}
            }
        };
        const result = await detection.createBrowser(win).detect(f.features[0]);
        expect(result.ids.slice().sort()).toEqual(innerStreet ? ['outer'] : ['inner', 'middle', 'outer']);
        expect(ensureBounds).toHaveBeenCalledExactlyOnceWith({ sw: [0, 0], ne: [0.01, 0.01] },
            { signal: undefined, city: 'test' });
    });

    it.each([
        ['outer', false, ['inner', 'middle', 'outer']],
        ['inner', false, ['inner', 'middle', 'outer']],
        ['outer', true, ['outer']],
        ['inner', true, ['inner', 'middle']]
    ])('MCP agrees from the %s seed (inner street: %s)', async (seedId, innerStreet, expected) => {
        const f = fixture({ innerStreet });
        const read = {
            parcels: vi.fn(async ({ parcelIds } = {}) => ({ complete: true,
                features: parcelIds ? f.features.filter(feature => parcelIds.includes(feature.id)) : f.features })),
            request: vi.fn(async () => f.boundaries)
        };
        const result = await createMcpNavigation({ read }).selectParcels({
            city: 'test', parcelSourceId: 'source', action: 'block', parcelId: seedId
        });
        expect(result.selection.parcelIds.slice().sort()).toEqual(expected);
        const areaRead = read.parcels.mock.calls.find(([args]) => args.geometry)?.[0];
        expect(turf.bbox(turf.feature(areaRead.geometry))).toEqual(innerStreet && seedId === 'inner'
            ? [0.003, 0.003, 0.007, 0.007] : [0, 0, 0.01, 0.01]);
    });
});
