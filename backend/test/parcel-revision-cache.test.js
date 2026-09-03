import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const parcelIdSource = readFileSync(
    new URL('../../frontend/js/proposals/parcel-id.js', import.meta.url),
    'utf8'
);
const drillUiSource = readFileSync(
    new URL('../../frontend/js/proposals/drill-ui.js', import.meta.url),
    'utf8'
);
const blockSource = readFileSync(
    new URL('../../frontend/js/parcel-blocks.js', import.meta.url),
    'utf8'
);

describe('fabric-revision-scoped parcel caches', () => {
    it('recomputes remembered parcel area after a city or fabric revision changes', () => {
        let city = 'sibenik';
        let revision = 1;
        let area = 10;
        const get = vi.fn(() => ({ properties: { parcelId: 'HR-A', calculatedArea: area } }));
        const context = {
            console,
            Map,
            Set,
            module: { exports: {} },
            CityConfigManager: { getCurrentCityId: () => city },
            LiveParcelFabric: { snapshot: () => ({ revision }), get },
            CadastralParcelRepository: { get: vi.fn(() => null) }
        };
        context.window = context;
        context.globalThis = context;
        vm.runInNewContext(parcelIdSource, context);
        const { getParcelAreaById } = context.module.exports;

        expect(getParcelAreaById('HR-A')).toBe(10);
        area = 20;
        expect(getParcelAreaById('HR-A')).toBe(10);
        revision = 2;
        expect(getParcelAreaById('HR-A')).toBe(20);
        area = 30;
        city = 'zagreb';
        expect(getParcelAreaById('HR-A')).toBe(30);
        expect(get).toHaveBeenCalledTimes(3);
    });

    it('recomputes a drill footprint after the fabric revision changes', () => {
        let revision = 1;
        let footprint = { type: 'Feature', properties: { version: 1 }, geometry: { type: 'Polygon', coordinates: [] } };
        const footprintOf = vi.fn(() => footprint);
        const proposal = { proposalId: 'proposal-1', updatedAt: 'unchanged' };
        const context = {
            console,
            Map,
            Set,
            document: { addEventListener: vi.fn() },
            CityConfigManager: { getCurrentCityId: () => 'sibenik' },
            LiveParcelFabric: {
                snapshot: () => ({ revision }),
                queryBounds: () => []
            },
            proposalStorage: { getAllProposals: () => [proposal] },
            isProposalApplied: () => true,
            getProposalKey: value => value.proposalId,
            __planOrder: { footprintOf },
            __drillStack: { buildDrillStack: (_point, input) => input.proposals },
            turf: {
                bbox: feature => [feature.properties.version, 0, feature.properties.version + 10, 10],
                booleanPointInPolygon: () => true
            }
        };
        context.window = context;
        context.globalThis = context;
        vm.runInNewContext(drillUiSource, context);

        expect(context.__drillUi.stackAt({ lng: 5, lat: 5 })[0].footprint.properties.version).toBe(1);
        footprint = { type: 'Feature', properties: { version: 2 }, geometry: { type: 'Polygon', coordinates: [] } };
        expect(context.__drillUi.stackAt({ lng: 5, lat: 5 })[0].footprint.properties.version).toBe(1);
        revision = 2;
        expect(context.__drillUi.stackAt({ lng: 5, lat: 5 })[0].footprint.properties.version).toBe(2);
        expect(footprintOf).toHaveBeenCalledTimes(2);
    });

    it('drops cached block polygons before projecting a new fabric revision', () => {
        const start = blockSource.indexOf('let blockPolygonCache = new Map()');
        const end = blockSource.indexOf('// Keep track of currently highlighted block parcel layers', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);

        let city = 'sibenik';
        let revision = 1;
        const load = vi.fn(() => true);
        const context = {
            Map,
            blockStorage: { load },
            LiveParcelFabric: { snapshot: () => ({ revision }) },
            CityConfigManager: { getCurrentCityId: () => city }
        };
        context.window = context;
        context.globalThis = context;
        vm.runInNewContext(`${blockSource.slice(start, end)}\n`
            + 'globalThis.__cache = {'
            + ' ensure: ensureBlockPolygonCacheScope,'
            + ' put: (key, value) => blockPolygonCache.set(key, value),'
            + ' get: key => blockPolygonCache.get(key),'
            + ' size: () => blockPolygonCache.size'
            + '};', context);

        context.__cache.ensure();
        context.__cache.put('block-a', { revision: 1 });
        context.__cache.ensure();
        expect(context.__cache.get('block-a')).toEqual({ revision: 1 });
        expect(load).toHaveBeenCalledTimes(1);

        revision = 2;
        context.__cache.ensure();
        expect(context.__cache.size()).toBe(0);
        expect(load).toHaveBeenCalledTimes(2);

        context.__cache.put('block-a', { revision: 2 });
        city = 'zagreb';
        context.__cache.ensure();
        expect(context.__cache.size()).toBe(0);
        expect(load).toHaveBeenCalledTimes(3);
    });
});
