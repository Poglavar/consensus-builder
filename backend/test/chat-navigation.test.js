import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ChatNavigation = require('../../frontend/js/chat/chat-navigation.js');

const feature = id => ({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] }, properties: { parcelId: id } });

function fixture({ ids = ['a', 'b'], active = false, selected = [], focus = null } = {}) {
    const features = new Map(ids.map(id => [id, feature(id)]));
    const layers = new Map(ids.map(id => [id, { id, setStyle: vi.fn(), bringToFront: vi.fn() }]));
    const listeners = new Map();
    const multi = {
        isActive: active,
        selectedParcels: new Set(selected),
        lastSelectedParcelId: focus,
        addParcelHighlight: vi.fn(),
        removeParcelHighlight: vi.fn(),
        clearInfoListHighlight: vi.fn(),
        clearSingleParcelSelection: vi.fn(() => { root.selectedParcelId = null; root.currentParcel = null; }),
        updateUI: vi.fn()
    };
    const root = {
        currentCityId: 'city-a',
        __reducedMotion: true,
        CityConfigManager: { getCurrentCityId: () => 'city-a', getDataContext: () => ({ parcelSourceId: 'source-a' }) },
        DesignSync: { parcelSourceIdOf: () => 'source-a' },
        LiveParcelFabric: { get: id => features.get(String(id)) || null },
        ParcelPresenter: { getLayer: id => layers.get(String(id)) || null },
        CadastralParcelRepository: { ensureIds: vi.fn(async requested => ({ foundIds: requested })) },
        multiParcelSelection: multi,
        document: { addEventListener: vi.fn((name, callback) => listeners.set(name, callback)) },
        addEventListener: vi.fn((name, callback) => listeners.set(name, callback)),
        highlightFeaturesForInspection: vi.fn(),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        map: {
            getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 5,
            setView: vi.fn(), flyTo: vi.fn(), once: vi.fn()
        }
    };
    return { root, multi, features, layers, listeners, nav: ChatNavigation.create(root) };
}

describe('chat navigation adapter', () => {
    it('captures a single or multi-parcel selection and its independent cursor', () => {
        const { nav, root, multi } = fixture({ selected: ['a', 'b'], focus: 'b', active: true });
        expect(nav.capture()).toEqual({ focusParcelId: 'b', parcelIds: ['a', 'b'], active: true });
        root.selectedParcelId = 'single';
        expect(nav.capture()).toEqual({ focusParcelId: 'single', parcelIds: ['a', 'b'], active: true });
        multi.selectedParcels.clear();
        expect(nav.capture()).toEqual({ focusParcelId: 'single', parcelIds: ['single'], active: true });
    });

    it('replaces selection exactly while keeping a focus candidate outside the selected set', async () => {
        const { nav, multi, root } = fixture();
        const event = { name: 'selection', selection: { parcelSourceId: 'source-a', focusParcelId: 'b', parcelIds: ['a'], active: true } };
        expect(await nav.apply(event)).toBe(true);
        expect([...multi.selectedParcels]).toEqual(['a']);
        expect(multi.isActive).toBe(true);
        expect(multi.lastSelectedParcelId).toBe('a');
        expect(root.CadastralParcelRepository.ensureIds).not.toHaveBeenCalled();
        expect(root.highlightFeaturesForInspection).toHaveBeenCalledWith([root.LiveParcelFabric.get('b')], { className: 'chat-map-focus' });
        expect(nav.capture()).toEqual({ focusParcelId: 'b', parcelIds: ['a'], active: true });
        expect(await nav.apply(event)).toBe(false);
        expect(multi.updateUI).toHaveBeenCalledTimes(1);
    });

    it('clears its independent focus cursor when the city changes', async () => {
        const { nav, root, listeners } = fixture({ ids: [] });
        root.CadastralParcelRepository.ensureIds = vi.fn(async requested => {
            const id = requested[0];
            return { foundIds: [id] };
        });
        const focus = feature('cursor');
        root.LiveParcelFabric.get = id => id === 'cursor' ? focus : null;
        root.ParcelPresenter.getLayer = id => id === 'cursor' ? { id } : null;
        await nav.apply({ name: 'selection', selection: { parcelSourceId: 'source-a', focusParcelId: 'cursor', parcelIds: [], active: false } });
        expect(nav.capture().focusParcelId).toBe('cursor');
        listeners.get('cityChanged')();
        expect(nav.capture().focusParcelId).toBeNull();
        expect(root.highlightFeaturesForInspection).toHaveBeenLastCalledWith([]);
    });

    it('loads missing exact IDs through the repository before selecting their live presentation', async () => {
        const { nav, root, multi, features, layers } = fixture({ ids: [] });
        root.CadastralParcelRepository.ensureIds = vi.fn(async requested => {
            requested.forEach(id => { features.set(id, feature(id)); layers.set(id, { id }); });
            return { foundIds: [...requested] };
        });
        await nav.apply({ name: 'selection', selection: { parcelSourceId: 'source-a', focusParcelId: 'new-id', parcelIds: ['new-id'], active: false } });
        expect(root.CadastralParcelRepository.ensureIds).toHaveBeenCalledWith(['new-id'], { city: 'city-a' });
        expect([...multi.selectedParcels]).toEqual(['new-id']);
    });

    it('rejects source and missing-ID mismatches without changing the previous selection', async () => {
        const { nav, root, multi } = fixture({ selected: ['a'], focus: 'a', active: true });
        await expect(nav.apply({ name: 'selection', selection: { parcelSourceId: 'wrong', focusParcelId: null, parcelIds: ['b'], active: false } }))
            .rejects.toThrow(/does not match/);
        root.CadastralParcelRepository.ensureIds = vi.fn(async () => ({ foundIds: [] }));
        await expect(nav.apply({ name: 'selection', selection: { parcelSourceId: 'source-a', focusParcelId: null, parcelIds: ['missing'], active: false } }))
            .rejects.toThrow(/unavailable/);
        expect([...multi.selectedParcels]).toEqual(['a']);
        expect(multi.isActive).toBe(true);
    });

    it('applies 2D views directly when reduced motion is enabled', async () => {
        const { nav, root } = fixture();
        await nav.apply({ name: 'view', view: { mode: '2d', at: '45.5,16.2,12' } });
        expect(root.map.setView).toHaveBeenCalledWith([45.5, 16.2], 12, { animate: false });
        expect(root.map.flyTo).not.toHaveBeenCalled();
    });

    it('uses a short map flight when reduced motion is off', async () => {
        const { nav, root } = fixture();
        root.__reducedMotion = false;
        root.map.once.mockImplementation((_event, done) => done());
        await nav.apply({ name: 'view', view: { mode: '2d', at: '45.5,16.2,12' } });
        expect(root.map.flyTo).toHaveBeenCalledWith([45.5, 16.2], 12, { animate: true, duration: 0.65, easeLinearity: 0.25 });
        expect(root.map.setView).not.toHaveBeenCalled();
    });

    it('applies the captured 3D camera view without changing map mode', async () => {
        const { nav, root } = fixture();
        root.isThreeModeActive = () => true;
        root.getThree3DGeoView = () => ({ targetLat: 45, targetLng: 15, headingDeg: 0, pitchRad: -0.6, range: 1000 });
        root.applyThree3DGeoView = vi.fn(() => true);
        await nav.apply({ name: 'view', view: { mode: 'model', at: '46,16,17', camera: { targetLat: 46, targetLng: 16, headingDeg: 45, pitchRad: -0.5, range: 800 } } });
        expect(root.applyThree3DGeoView).toHaveBeenCalledWith({ targetLat: 46, targetLng: 16, headingDeg: 45, pitchRad: -0.5, range: 800 });
        expect(root.map.setView).not.toHaveBeenCalled();
    });
});
