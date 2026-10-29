// Hidden Leaflet viewport events must not fetch or change layers while model/photo is active.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';

const mapCoreSource = readFileSync(new URL('../../frontend/js/map-core.js', import.meta.url), 'utf8');
const mapCoreAst = parse(mapCoreSource, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
function functionSource(ast, name, source) {
    if (!ast || typeof ast !== 'object') return null;
    if (ast.type === 'FunctionDeclaration' && ast.id?.name === name) return source.slice(ast.start, ast.end);
    for (const value of Object.values(ast)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                const found = functionSource(child, name, source);
                if (found) return found;
            }
        } else if (value && typeof value === 'object') {
            const found = functionSource(value, name, source);
            if (found) return found;
        }
    }
    return null;
}

function mapCoreHarness() {
    const handlers = new Map();
    const listeners = new Map();
    const timers = new Map();
    let timerId = 0;
    const calls = { parcelController: vi.fn(), buildings: vi.fn(), counts: vi.fn(), checkbox: vi.fn() };
    const window = {
        __mapModeState: { desired: 'model', pending: false },
        addEventListener: (name, listener) => listeners.set(name, listener),
        isThreeModeActive: () => false,
        buildingLayer: null
    };
    const map = {
        on: (name, listener) => handlers.set(name, listener),
        hasLayer: () => false,
        removeLayer: vi.fn()
    };
    const context = {
        window, map, isMapMoving: false, buildingFollowTimer: null,
        ParcelFetchController: { handleMoveEnd: calls.parcelController },
        parcelFetchConfig: { getDebounce: () => 10 },
        resolveParcelLayer: () => null, isZoomWithinParcelRange: () => true,
        MapCityConfigManager: { hasParcelData: () => true },
        updateParcelsCheckboxByZoom: calls.checkbox, updateVisibleParcelsCount: calls.counts,
        document: { getElementById: id => id === 'showBuildings' ? { checked: true } : null },
        fetchBuildings: calls.buildings, fetchOutlineBuildings: () => {},
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        isProposalApplied: () => true
    };
    vm.createContext(context);
    vm.runInContext(`${functionSource(mapCoreAst, 'isTwoDimensionalViewportActive', mapCoreSource)}\n${functionSource(mapCoreAst, 'setupMapEventHandlers', mapCoreSource)}\nthis.setupMapEventHandlers = setupMapEventHandlers;`, context);
    context.setupMapEventHandlers();
    return { context, handlers, listeners, timers, calls };
}

describe('automatic parcel and road viewport work follows the active 2D map', () => {
    it('suppresses Leaflet move and zoom work in model mode, then refreshes on return to 2D', () => {
        const h = mapCoreHarness();
        h.handlers.get('movestart')();
        h.handlers.get('moveend')();
        h.handlers.get('zoomend')();
        expect(h.calls.parcelController).not.toHaveBeenCalled();
        expect(h.calls.checkbox).not.toHaveBeenCalled();

        h.context.window.__mapModeState = { desired: '2d', pending: false };
        h.listeners.get('mapmodechange')({ detail: h.context.window.__mapModeState });
        expect(h.calls.checkbox).toHaveBeenCalledWith(true);
        expect(h.calls.counts).toHaveBeenCalled();
        expect(h.calls.parcelController).toHaveBeenCalledTimes(1);
        [...h.timers.values()].forEach(callback => callback());
        expect(h.calls.buildings).toHaveBeenCalledTimes(1);
    });

    it('rechecks delayed parcel and building fetches after a mode switch', () => {
        const timers = new Map();
        let timerId = 0;
        const calls = { buildings: vi.fn(), parcels: vi.fn(), counts: vi.fn() };
        const global = {
            __mapModeState: { desired: '2d', pending: false },
            isThreeModeActive: () => false,
            skipParcelFetchUntilProposalLoaded: false,
            suppressCameraMoves: false,
            fetchBuildings: calls.buildings,
            fetchParcelData: vi.fn(() => { calls.parcels(); return Promise.resolve(); }),
            updateVisibleParcelsCount: calls.counts,
            CityConfigManager: { hasParcelData: () => true },
            document: { getElementById: () => ({ checked: true }) },
            setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
            clearTimeout: id => timers.delete(id)
        };
        const context = { window: global, global, document: global.document, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/parcels/controller.js', import.meta.url), 'utf8'), context);
        global.ParcelFetchController.handleMoveEnd({
            _loaded: true, getBounds: () => ({ bounds: true }), hasLayer: () => false, removeLayer() {}
        }, { parcelFetchConfig: { getDebounce: () => 5 }, isZoomWithinParcelRange: () => true });
        expect(global.updateVisibleParcelsCount).toHaveBeenCalled();
        global.__mapModeState = { desired: 'photo', pending: true };
        [...timers.values()].forEach(callback => callback());
        expect(calls.buildings).not.toHaveBeenCalled();
        expect(calls.parcels).not.toHaveBeenCalled();
    });

    it('gates only automatic road refreshes and keeps explicit road classification available', async () => {
        const timers = new Map();
        const listeners = new Map();
        let timerId = 0;
        const ensureRoadIds = vi.fn(async () => ({ ids: [] }));
        const context = {
            __mapModeState: { desired: 'model', pending: false },
            isThreeModeActive: () => false,
            addEventListener: (name, listener) => listeners.set(name, listener),
            dispatchEvent() {}, CustomEvent,
            console: { log() {}, error() {} },
            PersistentStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            CadastralParcelRepository: { roadClassificationAvailable: () => true, ensureRoadIds },
            map: { getBounds: () => ({ viewport: true }) },
            setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
            clearTimeout: id => timers.delete(id)
        };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/road-parcels.js', import.meta.url), 'utf8'), context);

        listeners.get('parcelDataLoaded')();
        expect(timers.size).toBe(0);
        await context.fetchCuratedRoadParcels({ explicit: true });
        expect(ensureRoadIds).toHaveBeenCalledWith({ explicit: true });

        context.__mapModeState = { desired: '2d', pending: false };
        listeners.get('mapmodechange')({ detail: context.__mapModeState });
        expect(timers.size).toBe(1);
        const callback = [...timers.values()][0];
        context.__mapModeState = { desired: 'photo', pending: true };
        callback();
        expect(ensureRoadIds).toHaveBeenCalledTimes(1);
    });
});
