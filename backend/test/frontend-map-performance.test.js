import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const mapCoreSource = readFileSync(new URL('../../frontend/js/map-core.js', import.meta.url), 'utf8');
const labelsSource = readFileSync(new URL('../../frontend/js/parcels/ui/labels.js', import.meta.url), 'utf8');
const ownerCountsSource = readFileSync(new URL('../../frontend/js/parcels/ui/owner-counts.js', import.meta.url), 'utf8');
const visibilitySource = readFileSync(new URL('../../frontend/js/parcels/ui/visibility.js', import.meta.url), 'utf8');

function loadMapCoreHelpers(names) {
    const ast = parse(mapCoreSource, { sourceType: 'script' });
    const declarations = ast.program.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name));
    expect(declarations.map(node => node.id.name).sort()).toEqual([...names].sort());
    const context = vm.createContext({});
    declarations.forEach(node => {
        const declaration = mapCoreSource.slice(node.start, node.end);
        vm.runInContext(`${declaration}\nthis.${node.id.name} = ${node.id.name};`, context);
    });
    return context;
}

function loadBuildingLayerRuntime() {
    const names = [
        'buildingPoolFeatureKey', 'currentBuildingOutcomeState', 'buildingOutcomeSignatures', 'buildingFeatureWithOutcome',
        'reconcileBuildingFeatureEntries', 'stableBuildingFeatureSignature', 'buildingStyleForFeature',
        'applyBuildingFeatureLayerChanges', 'buildingLayerOptions', 'rebuildBuildingLayerFromPool'
    ];
    const ast = parse(mapCoreSource, { sourceType: 'script' });
    const declarations = ast.program.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name));
    expect(declarations.map(node => node.id.name).sort()).toEqual([...names].sort());

    const fixture = { state: { demolishedById: new Map(), tunnelledIds: new Set(), affectedIds: new Set() } };
    const layersById = new Map();
    const allLayers = new Set();
    const mapLayers = new Set();
    const optionsByFeature = new Map();
    const map = {
        hasLayer(layer) { return mapLayers.has(layer); },
        addLayer(layer) { mapLayers.add(layer); return this; },
        removeLayer(layer) { mapLayers.delete(layer); return this; }
    };
    const L = {
        geoJSON(_data, options) {
            const group = {
                options,
                addData(feature) {
                    const layer = { feature, style: options.style(feature) };
                    allLayers.add(layer);
                    options.onEachFeature(feature, layer);
                },
                removeLayer(layer) {
                    allLayers.delete(layer);
                },
                addTo(target) { target.addLayer(this); return this; }
            };
            optionsByFeature.set(group, options);
            return group;
        }
    };
    const checkbox = { checked: false };
    const context = vm.createContext({
        console, map, L, document: { getElementById: id => id === 'showBuildings' ? checkbox : null },
        window: null,
        buildingFeaturePool: [],
        collectDemolishedBuildingRecords: () => Array.from(fixture.state.demolishedById.values())
    });
    context.window = context;
    context.collectTunnelledBuildingIds = () => fixture.state.tunnelledIds;
    context.buildingOutcomeStyle = outcome => ({ color: outcome || 'normal' });
    vm.runInContext('let buildingLayer = null; let buildingFeatureById = new Map(); let buildingRenderedLayersById = new Map(); let renderedBuildingOutcomeSignatures = new Map(); let renderedBuildingFeatureSignatures = new Map();', context);
    declarations.forEach(node => vm.runInContext(`${mapCoreSource.slice(node.start, node.end)}\nthis.${node.id.name} = ${node.id.name};`, context));
    vm.runInContext('this.getBuildingLayer = () => buildingLayer; this.getRenderedLayers = () => buildingRenderedLayersById; this.getRenderedLayerIds = () => Array.from(buildingRenderedLayersById.keys());', context);
    return { context, fixture, layersById, allLayers, mapLayers, checkbox };
}

function makeMapContext(features) {
    const markerLayers = new Set();
    const eventListeners = new Map();
    const fixture = {
        city: 'test-city',
        revision: 1,
        features: new Map(features.map(feature => [String(feature.properties.parcelId), feature])),
        layers: features.map(feature => ({ id: String(feature.properties.parcelId) })),
        markerLayers,
        centerOfMassCalls: 0,
        boundsQueries: 0,
        eventListeners
    };
    const bounds = { contains: () => true, intersects: () => true };
    const map = {
        listeners: {},
        getBounds: () => bounds,
        on(event, listener) { (this.listeners[event] ||= []).push(listener); },
        hasLayer(layer) { return markerLayers.has(layer); },
        addLayer(layer) { markerLayers.add(layer); return this; },
        removeLayer(layer) { markerLayers.delete(layer); return this; }
    };
    const document = {
        readyState: 'complete',
        addEventListener() {},
        getElementById(id) { return id === 'showParcelNumbers' || id === 'showOwnerCounts' ? { checked: true } : null; },
        createElement(tagName) {
            return { tagName, className: '', textContent: '', style: {} };
        }
    };
    const L = {
        latLng(lat, lng) { return { lat, lng }; },
        divIcon(options) { return { options }; },
        marker(position, options) {
            return {
                position: { ...position }, icon: options.icon,
                getLatLng() { return this.position; },
                setLatLng(next) { this.position = { ...next }; return this; },
                setIcon(next) { this.icon = next; return this; }
            };
        }
    };
    const fabric = {
        get(id) { return fixture.features.get(String(id)) || null; },
        snapshot() { return { revision: fixture.revision }; }
    };
    const context = vm.createContext({
        console, document, L, map, parcelLayer: { eachLayer() { throw new Error('full-layer scan'); } },
        LiveParcelFabric: fabric,
        addEventListener(type, listener) {
            const listeners = eventListeners.get(type) || [];
            listeners.push(listener);
            eventListeners.set(type, listeners);
        },
        dispatchEvent(event) { (eventListeners.get(event.type) || []).forEach(listener => listener(event)); },
        ParcelPresenter: { getIdForLayer: layer => layer.id },
        turf: {
            centerOfMass(geometry) {
                fixture.centerOfMassCalls += 1;
                return { geometry: { coordinates: geometry.coordinates } };
            }
        },
        getCurrentCityId: () => fixture.city,
        getParcelsInBounds() { fixture.boundsQueries += 1; return fixture.layers; },
        ensureParcelId: feature => feature.properties.parcelId,
        ParcelsOwnershipUi: { parcelOwnerDataCache: new Map() }
    });
    context.window = context;
    context.globalThis = context;
    vm.runInContext(labelsSource, context);
    vm.runInContext(ownerCountsSource, context);
    vm.runInContext(visibilitySource, context);
    return { context, fixture, map, markerLayers, bounds };
}

const parcel = (id, number = 'A/1', lng = 15.98, lat = 45.81, ownershipList = [{ name: 'Owner' }]) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { parcelId: String(id), BROJ_CESTICE: number, ownershipList }
});

describe('incremental building presentation model', () => {
    it('retains unchanged layers and replaces changed, new, and evicted ids only', () => {
        const context = loadMapCoreHelpers(['stableBuildingFeatureSignature', 'reconcileBuildingFeatureEntries', 'applyBuildingFeatureLayerChanges']);
        const previous = new Map([
            ['keep', context.stableBuildingFeatureSignature({ properties: { id: 'keep', b: 2, a: 1 }, geometry: { coordinates: [1, 2] } })],
            ['change', 'stale'],
            ['evict', 'old']
        ]);
        const firstLayer = { id: 'keep', generation: 1 };
        const staleLayer = { id: 'change', generation: 1 };
        const evictedLayer = { id: 'evict', generation: 1 };
        const live = new Set([firstLayer, staleLayer, evictedLayer]);
        const layersById = new Map([['keep', [firstLayer]], ['change', [staleLayer]], ['evict', [evictedLayer]]]);
        const group = {
            removeLayer(layer) { live.delete(layer); },
            addData(feature) {
                const id = feature.properties.id;
                const layer = { id, generation: 2 };
                live.add(layer);
                const children = layersById.get(id) || [];
                children.push(layer);
                layersById.set(id, children);
            }
        };
        const features = [
            { properties: { id: 'keep', b: 2, a: 1 }, geometry: { coordinates: [1, 2] } },
            { properties: { id: 'change', value: 'new' }, geometry: { coordinates: [3, 4] } },
            { properties: { id: 'new', value: 'added' }, geometry: { coordinates: [5, 6] } }
        ];
        const changes = context.reconcileBuildingFeatureEntries(
            previous,
            features,
            feature => feature.properties.id,
            feature => feature,
            context.stableBuildingFeatureSignature
        );

        expect(changes.changed.map(entry => entry.id)).toEqual(['change', 'new']);
        expect(changes.removed).toEqual(['evict']);
        context.applyBuildingFeatureLayerChanges(group, layersById, changes);
        expect(layersById.get('keep')).toEqual([firstLayer]);
        expect(live.has(firstLayer)).toBe(true);
        expect(live.has(staleLayer)).toBe(false);
        expect(live.has(evictedLayer)).toBe(false);
        expect(layersById.get('change')[0].generation).toBe(2);
        expect(layersById.get('new')[0].generation).toBe(2);
        expect(layersById.has('evict')).toBe(false);
    });

    it('keeps one group, honors checkbox visibility, updates changed outcomes, and removes evicted features', () => {
        const { context, fixture, layersById, allLayers, mapLayers, checkbox } = loadBuildingLayerRuntime();
        const a = { type: 'Feature', properties: { object_id: 'a', name: 'unchanged' }, geometry: { coordinates: [1, 2] } };
        const b = { type: 'Feature', properties: { object_id: 'b', name: 'cut later' }, geometry: { coordinates: [3, 4] } };
        context.buildingFeaturePool = [a, b];
        context.rebuildBuildingLayerFromPool();
        const group = context.getBuildingLayer();
        const aLayer = context.getRenderedLayers().get('a')[0];
        const bLayer = context.getRenderedLayers().get('b')[0];
        expect(mapLayers.has(group)).toBe(false);
        expect(allLayers.size).toBe(2);

        checkbox.checked = true;
        context.rebuildBuildingLayerFromPool();
        expect(context.getBuildingLayer()).toBe(group);
        expect(mapLayers.has(group)).toBe(true);
        expect(context.getRenderedLayers().get('a')[0]).toBe(aLayer);

        fixture.state.demolishedById.set('b', { id: 'b', remainder: { type: 'Polygon', coordinates: [[3, 4]] } });
        fixture.state.affectedIds = new Set(['b']);
        context.rebuildBuildingLayerFromPool();
        expect(context.getBuildingLayer()).toBe(group);
        expect(context.getRenderedLayers().get('a')[0]).toBe(aLayer);
        expect(context.getRenderedLayers().get('b')).toHaveLength(1);
        expect(context.getRenderedLayers().get('b')[0]).not.toBe(bLayer);
        expect(context.getRenderedLayers().get('b')[0].feature.geometry).toEqual(fixture.state.demolishedById.get('b').remainder);
        expect(context.getRenderedLayers().get('b')[0].style).toEqual({ color: 'cut' });

        context.buildingFeaturePool = [a];
        context.rebuildBuildingLayerFromPool();
        expect(context.getRenderedLayers().has('b')).toBe(false);
        expect(context.getRenderedLayerIds()).toEqual(['a']);
    });
});

describe('viewport label reconciliation', () => {
    it('reuses parcel number markers and recomputes an in-place-mutated feature centroid on revision change', () => {
        const { context, fixture, markerLayers } = makeMapContext([parcel('p1')]);
        context.drawParcelNumberLabels();
        const marker = [...markerLayers][0];
        context.drawParcelNumberLabels();
        expect([...markerLayers]).toEqual([marker]);
        expect(fixture.centerOfMassCalls).toBe(1);
        expect(fixture.boundsQueries).toBe(2);

        const iconContent = marker.icon.options.html;
        expect(iconContent.textContent).toBe('A/1');
        fixture.features.get('p1').geometry.coordinates[0] = 15.99;
        fixture.features.get('p1').properties.BROJ_CESTICE = '<img>';
        fixture.revision += 1;
        context.dispatchEvent({ type: 'parcelFabricCommitted', detail: { updatedIds: ['p1'] } });
        context.drawParcelNumberLabels();
        expect([...markerLayers]).toEqual([marker]);
        expect(marker.position.lng).toBe(15.99);
        expect(fixture.centerOfMassCalls).toBe(2);
        expect(marker.icon.options.html.textContent).toBe('<img>');
    });

    it('drops removed parcel markers and resets retained markers when the city changes', () => {
        const { context, fixture, markerLayers } = makeMapContext([parcel('p1')]);
        context.drawParcelNumberLabels();
        const oldMarker = [...markerLayers][0];
        fixture.features.delete('p1');
        context.drawParcelNumberLabels();
        expect(markerLayers.has(oldMarker)).toBe(false);

        const newFeature = parcel('p2', 'B/2', 16.1, 46.0);
        fixture.features.set('p2', newFeature);
        fixture.layers = [{ id: 'p2' }];
        fixture.city = 'buenos_aires';
        newFeature.properties.smp = 'B/2';
        context.drawParcelNumberLabels();
        const newMarker = [...markerLayers][0];
        expect(newMarker).not.toBe(oldMarker);
        expect(newMarker.icon.options.html.textContent).toBe('B/2');
    });

    it('retains owner-count markers across redraws and updates their content without a full layer scan', () => {
        const { context, fixture, markerLayers } = makeMapContext([parcel('p1')]);
        context.drawOwnerCountLabels();
        const marker = [...markerLayers][0];
        context.drawOwnerCountLabels();
        expect([...markerLayers]).toEqual([marker]);
        expect(fixture.centerOfMassCalls).toBe(1);

        fixture.features.get('p1').properties.ownershipList.push({ name: 'Second owner' });
        fixture.revision += 1;
        context.dispatchEvent({ type: 'parcelFabricCommitted', detail: { updatedIds: ['p1'] } });
        context.drawOwnerCountLabels();
        expect([...markerLayers]).toEqual([marker]);
        expect(marker.icon.options.html).toBe('2');
        expect(fixture.centerOfMassCalls).toBe(2);
    });

    it('detaches and forgets both label markers as soon as a parcel is removed', () => {
        const { context, fixture, markerLayers } = makeMapContext([parcel('p1')]);
        context.drawParcelNumberLabels();
        context.drawOwnerCountLabels();
        const markers = [...markerLayers];
        expect(markers).toHaveLength(2);

        fixture.features.delete('p1');
        context.dispatchEvent({ type: 'parcelFabricCommitted', detail: { removedIds: ['p1'] } });

        expect(markerLayers.size).toBe(0);
        fixture.layers = [];
        context.drawParcelNumberLabels();
        context.drawOwnerCountLabels();
        expect(markerLayers.size).toBe(0);
    });

    it('evicts both marker caches when parcels leave the viewport and creates fresh markers when they return', () => {
        const { context, fixture, markerLayers } = makeMapContext([parcel('p1')]);
        context.drawParcelNumberLabels();
        context.drawOwnerCountLabels();
        const firstViewportMarkers = [...markerLayers];
        expect(firstViewportMarkers).toHaveLength(2);

        fixture.layers = [];
        context.drawParcelNumberLabels();
        context.drawOwnerCountLabels();
        expect(markerLayers.size).toBe(0);

        fixture.layers = [{ id: 'p1' }];
        context.drawParcelNumberLabels();
        context.drawOwnerCountLabels();
        const returnedViewportMarkers = [...markerLayers];
        expect(returnedViewportMarkers).toHaveLength(2);
        expect(returnedViewportMarkers.every(marker => !firstViewportMarkers.includes(marker))).toBe(true);
    });

    it('uses presenter viewport selection and cached layer bounds for the visible parcel count', () => {
        const { context, fixture } = makeMapContext([parcel('p1')]);
        const total = { id: 'parcels-in-view', textContent: '', attrs: {},
            setAttribute(name, value) { this.attrs[name] = value; },
            removeAttribute(name) { delete this.attrs[name]; } };
        context.document.getElementById = id => id === 'parcels-in-view' ? total : null;
        context.i18n = null;
        context.parcelLayer = { getLayers: () => [{}, {}, {}] };
        context.getParcelsInBounds = () => { fixture.boundsQueries += 1; return [{}, {}]; };
        context.updateVisibleParcelsCount();
        expect(fixture.boundsQueries).toBe(1);
        expect(total.textContent).toContain('2 / 3');
    });
});
