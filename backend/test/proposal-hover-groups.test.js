// Behavioural test for the grouped hover painter in frontend/js/proposals/layer-render.js.
//
// Why it exists: hovering a proposal used to paint everything it touched in ONE colour, so a
// hovered building was indistinguishable from the parcel boundaries around it ("I am quite unsure
// which building this is about"). A proposal's own BODY and the PARCELS it stands on are now
// separate groups with separate styles — and the trap in that design is the clear: clearing per
// group would make the last group erase the ones before it, which looks exactly like the old bug.
// These tests lock both the styling and the single clear.
//
// layer-render.js is a classic browser script with no exports, so it is evaluated in THIS realm
// behind Leaflet/map stubs, the same way executed-buildings-hydration.test.js does it.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const featureAt = (lng, lat, id) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]] },
    properties: { id }
});

const bodyFeature = featureAt(16.015, 45.787, 'building-M1-11');
const parcelFeature = featureAt(16.014, 45.786, 'HR-335550-1791/25');

let cap;

const makeGroup = () => ({
    layers: [],
    clears: 0,
    clearLayers() { this.layers.length = 0; this.clears += 1; },
    addLayer(layer) { this.layers.push(layer); return this; },
    addTo() { return this; },
    bringToFront() { return this; }
});

const hoverGroup = () => global.window.proposalHoverGroup;
const drawn = () => hoverGroup().layers.map(layer => layer.__options.style);

beforeAll(() => {
    const noop = () => { };

    global.L = {
        featureGroup: () => makeGroup(),
        geoJSON: (feature, options) => ({
            __feature: feature,
            __options: options || {},
            addTo(group) { group.addLayer(this); return this; }
        }),
        marker: (latlng, options) => ({
            __latlng: latlng,
            __options: options || {},
            addTo(group) { group.addLayer(this); return this; }
        }),
        divIcon: options => options
    };
    // No panes: getPane/createPane are absent, so ensureProposalHighlightPanes bails and the
    // painter falls back to the default pane. That path must still draw.
    global.map = { addLayer: noop, removeLayer: noop, on: noop };
    global.window = {};
    global.getParcelDisplayNumberFromFeature = feature => feature?.properties?.id || null;
    global.getFeatureCentroid = () => ({ lat: 45.787, lng: 16.015 });
    global.resolveProposalGoalKey = () => 'park';

    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/proposals/layer-render.js');
    const src = readFileSync(scriptPath, 'utf8') + `
        globalThis.__cap = {
            highlightFeatureGroupsForHover,
            highlightFeaturesForHover,
            clearProposalHoverLayers,
            getParcelFeaturesForHighlight,
            collectProposalHighlightFeatures,
            highlightParcelHover
        };`;
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    cap = globalThis.__cap;
});

beforeEach(() => {
    // Fresh overlay groups per test, so clear counts start at zero.
    global.window = {};
});

describe('highlightFeatureGroupsForHover', () => {
    it('paints each group in its own style, in order, so the body lands on top of the parcels', () => {
        cap.highlightFeatureGroupsForHover([
            { features: [parcelFeature], color: '#FFEB3B', weight: 6, dashArray: '10 8' },
            { features: [bodyFeature], color: '#00E5FF', weight: 4, dashArray: null, fillOpacity: 0.25 }
        ]);

        const styles = drawn();
        expect(styles).toHaveLength(2);
        // Order is z-order: the body is drawn last and therefore reads above the parcels.
        expect(styles[0].color).toBe('#FFEB3B');
        expect(styles[1].color).toBe('#00E5FF');
        expect(styles[0].color).not.toBe(styles[1].color);
        // The parcels stay hollow outlines; the body is filled, which is what makes it read as
        // an object rather than one more boundary.
        expect(styles[0].fillOpacity).toBe(0);
        expect(styles[1].fillOpacity).toBe(0.25);
        expect(styles[1].fillColor).toBe('#00E5FF');
        expect(hoverGroup().layers[0].__feature).toBe(parcelFeature);
        expect(hoverGroup().layers[1].__feature).toBe(bodyFeature);
    });

    it('clears the hover layer exactly once, so a later group never erases an earlier one', () => {
        cap.highlightFeatureGroupsForHover([
            { features: [parcelFeature], color: '#FFEB3B' },
            { features: [bodyFeature], color: '#00E5FF' },
            { features: [bodyFeature], color: '#FF00FF' }
        ]);

        expect(hoverGroup().clears).toBe(1);
        expect(drawn()).toHaveLength(3);
    });

    it('drops an empty group without dropping the ones beside it', () => {
        // A proposal with no resolvable body (or no live parcels) must still show the half that
        // does resolve, instead of falling back to nothing.
        cap.highlightFeatureGroupsForHover([
            { features: [], color: '#FFEB3B' },
            { features: [bodyFeature], color: '#00E5FF' }
        ]);

        const styles = drawn();
        expect(styles).toHaveLength(1);
        expect(styles[0].color).toBe('#00E5FF');
    });

    it('replaces the previous hover paint on the next hover', () => {
        cap.highlightFeatureGroupsForHover([{ features: [parcelFeature], color: '#FFEB3B' }]);
        cap.highlightFeatureGroupsForHover([{ features: [bodyFeature], color: '#00E5FF' }]);

        const styles = drawn();
        expect(styles).toHaveLength(1);
        expect(styles[0].color).toBe('#00E5FF');
        expect(hoverGroup().clears).toBe(2);
    });

    it('labels only the group that asks for labels', () => {
        cap.highlightFeatureGroupsForHover([
            { features: [parcelFeature], color: '#FFEB3B', showLabels: true },
            { features: [bodyFeature], color: '#00E5FF', showLabels: false }
        ]);

        expect(global.window.proposalHoverLabelGroup.layers).toHaveLength(1);
    });
});

describe('highlightFeaturesForHover', () => {
    it('still paints a single set of features in one style', () => {
        cap.highlightFeaturesForHover([parcelFeature], { color: '#FFEB3B', weight: 6, dashArray: '10 8' });

        const styles = drawn();
        expect(styles).toHaveLength(1);
        expect(styles[0]).toMatchObject({ color: '#FFEB3B', weight: 6, dashArray: '10 8', fillOpacity: 0 });
    });

    it('clears the hover paint when handed nothing', () => {
        cap.highlightFeaturesForHover([parcelFeature], { color: '#FFEB3B' });
        cap.highlightFeaturesForHover([]);

        expect(drawn()).toHaveLength(0);
        expect(hoverGroup().clears).toBe(2);
    });
});

describe('live parcel geometry for interaction', () => {
    it('draws every current road-cut remnant instead of a cached full cadastral polygon', () => {
        const left = featureAt(15.0, 45.0, 'HR-A#left');
        const right = featureAt(15.002, 45.0, 'HR-A#right');
        const staleBase = featureAt(15.0, 45.0, 'HR-A');
        const cache = vi.fn(() => ({ parcelsById: new Map([['HR-A', staleBase]]) }));
        global.buildProposalFeatureCache = cache;
        const features = new Map([['HR-A#left', left], ['HR-A#right', right]]);
        global.window.LiveParcelFabric = {
            featureId: feature => feature?.properties?.id || null,
            get: id => features.get(String(id)) || null
        };
        global.window.ParcelPresenter = {
            resolveLiveLayers: vi.fn(() => [
                { feature: left },
                { feature: right }
            ])
        };

        const proposal = { proposalId: 'park', cadastreParcelIds: ['HR-A'] };
        expect(cap.getParcelFeaturesForHighlight('HR-A', proposal)).toEqual([left, right]);
        expect(cap.collectProposalHighlightFeatures(proposal)).toEqual([left, right]);
        expect(cache).not.toHaveBeenCalled();

        cap.highlightParcelHover('HR-A', { proposal });
        expect(hoverGroup().layers.map(entry => entry.__feature)).toEqual([left, right]);
    });

    it('does not resurrect a removed generated child from the proposal cache', () => {
        global.buildProposalFeatureCache = vi.fn(() => ({
            parcelsById: new Map([['HR-A#old-park-1', parcelFeature]])
        }));
        global.window.LiveParcelFabric = {
            featureId: feature => feature?.properties?.id || null,
            get: () => null
        };
        global.window.ParcelPresenter = { resolveLiveLayers: vi.fn(() => []) };

        expect(cap.getParcelFeaturesForHighlight('HR-A#old-park-1', { proposalId: 'park' })).toEqual([]);
        expect(global.buildProposalFeatureCache).not.toHaveBeenCalled();
    });
});
