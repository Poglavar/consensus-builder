import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ChatNavigation = require('../../frontend/js/chat/chat-navigation.js');
const parcelDisplay = require('../../frontend/js/proposals/parcel-id.js');

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
    it('loads the cadastral parent but selects only its exact live piece', async () => {
        const { nav, root, features, layers } = fixture({ ids: [] });
        root.LiveParcelFabric.cadastralPartOf = require('../../frontend/js/parcels/live-fabric.js').cadastralPartOf;
        root.CadastralParcelRepository.ensureIds.mockImplementation(async ids => {
            features.set('P#cadastre-2', feature('P#cadastre-2'));
            layers.set('P#cadastre-2', { setStyle: vi.fn() });
            return { foundIds: ids };
        });
        await nav.apply({ name: 'selection', selection: { parcelSourceId: 'source-a', parcelIds: ['P#cadastre-2'], focusParcelId: 'P#cadastre-2', active: false } });
        expect(root.CadastralParcelRepository.ensureIds).toHaveBeenCalledWith(['P'], { city: 'city-a' });
        expect(nav.capture().parcelIds).toEqual(['P#cadastre-2']);
        await expect(nav.apply({ name: 'selection', selection: { parcelSourceId: 'source-a', parcelIds: ['P#building-1'], focusParcelId: 'P#building-1', active: false } })).rejects.toThrow();
    });
    it('captures a single or multi-parcel selection and its independent cursor', () => {
        const { nav, root, multi } = fixture({ selected: ['a', 'b'], focus: 'b', active: true });
        expect(nav.capture()).toEqual({ focusParcelId: 'b', parcelIds: ['a', 'b'], active: true });
        root.selectedParcelId = 'single';
        expect(nav.capture()).toEqual({ focusParcelId: 'single', parcelIds: ['a', 'b'], active: true });
        multi.selectedParcels.clear();
        expect(nav.capture()).toEqual({ focusParcelId: 'single', parcelIds: ['single'], active: true });
    });

    it('captures viewport parcel labels from live features with exact IDs and keeps duplicate labels', () => {
        const { nav, root, features, layers } = fixture();
        features.get('a').properties.parcelNumber = '12/3';
        features.get('b').properties.parcelNumber = '12/3';
        const bounds = { getWest: () => 1, getSouth: () => 2, getEast: () => 3, getNorth: () => 4, contains: () => true };
        root.map.getBounds = () => bounds;
        root.document.getElementById = id => id === 'showParcelNumbers' ? { checked: false } : null;
        root.getParcelsInBounds = vi.fn(() => [layers.get('a'), layers.get('b')]);
        root.ParcelPresenter.getIdForLayer = layer => layer.id;
        root.ParcelLabelModel = {
            position: (_feature, _layer, id) => ({ lng: id === 'a' ? 1.5 : 2.5, lat: 3 }),
            isEligible: vi.fn(() => true)
        };
        root.getParcelDisplayNumberFromFeature = parcelDisplay.getParcelDisplayNumberFromFeature;

        expect(nav.mapContext()).toEqual({
            parcelSourceId: 'source-a',
            display: { parcelIds: false },
            visibleParcels: [
                { parcelId: 'a', label: '12/3', point: [1.5, 3] },
                { parcelId: 'b', label: '12/3', point: [2.5, 3] }
            ],
            visibleParcelsTruncated: false,
            viewBounds: [1, 2, 3, 4]
        });
        expect(root.getParcelsInBounds).toHaveBeenCalledWith(bounds);
        root.ParcelLabelModel.isEligible.mockImplementation(parcelId => parcelId !== 'b');
        expect(nav.mapContext().visibleParcels).toEqual([
            { parcelId: 'a', label: '12/3', point: [1.5, 3] }
        ]);
    });

    it('caps parcel-number hints at 500 and reports truncation', () => {
        const ids = Array.from({ length: 501 }, (_value, index) => `parcel-${index}`);
        const { nav, root } = fixture({ ids });
        const bounds = { getWest: () => 1, getSouth: () => 2, getEast: () => 3, getNorth: () => 4, contains: () => true };
        root.map.getBounds = () => bounds;
        root.document.getElementById = id => id === 'showParcelNumbers' ? { checked: true } : null;
        root.getParcelsInBounds = () => ids.map(id => ({ id }));
        root.ParcelPresenter.getIdForLayer = layer => layer.id;
        root.ParcelLabelModel = { position: () => ({ lng: 2, lat: 3 }), isEligible: () => true };
        root.getParcelDisplayNumberFromFeature = () => 'same number';

        const snapshot = nav.mapContext();
        expect(snapshot.visibleParcels).toHaveLength(500);
        expect(snapshot.visibleParcelsTruncated).toBe(true);
    });

    it('shows parcel IDs through the native controls and refuses to claim success below parcel zoom', async () => {
        const { nav, root, layers } = fixture({ ids: ['a'] });
        const numbers = { checked: false };
        const parcels = { checked: false };
        const toggleNumbers = vi.fn();
        const bounds = { getWest: () => -1, getSouth: () => -1, getEast: () => 1, getNorth: () => 1, contains: () => true };
        root.map.getBounds = () => bounds;
        root.document.getElementById = id => ({ showParcelNumbers: numbers, parcelsCheckbox: parcels })[id] || null;
        root.Parcels = { uiLabels: { toggleParcelNumbers: toggleNumbers } };
        root.parcelLayer = {};
        root.fetchParcelDataReported = vi.fn(async requested => ({ features: [feature('a')] }));
        root.isZoomWithinParcelRange = () => true;
        root.toggleAccordion = vi.fn();
        root.getParcelsInBounds = () => [layers.get('a')];
        root.ParcelPresenter.getIdForLayer = layer => layer.id;
        root.ParcelLabelModel = { position: () => ({ lng: 0, lat: 0 }), isEligible: () => true };
        root.getParcelDisplayNumberFromFeature = parcelDisplay.getParcelDisplayNumberFromFeature;
        await nav.apply({ name: 'view', view: { mode: '2d', at: '0,0,5' }, parcelIdsVisible: true });
        expect(root.fetchParcelDataReported).toHaveBeenCalledWith(bounds, 'chat parcel IDs');
        expect(parcels.checked).toBe(true);
        expect(root.toggleAccordion).toHaveBeenCalledWith(parcels);
        expect(numbers.checked).toBe(true);
        expect(toggleNumbers).toHaveBeenCalledTimes(1);

        root.fetchParcelDataReported.mockResolvedValue(null);
        numbers.checked = false;
        await expect(nav.apply({ name: 'view', view: { mode: '2d', at: '0,0,5' }, parcelIdsVisible: true }))
            .rejects.toThrow(/No parcels/);
        expect(numbers.checked).toBe(false);

        root.isZoomWithinParcelRange = () => false;
        await expect(nav.apply({ name: 'view', view: { mode: '2d', at: '0,0,5' }, parcelIdsVisible: true }))
            .rejects.toThrow(/Zoom in/);
        expect(numbers.checked).toBe(false);
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
