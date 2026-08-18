// Headless interaction coverage for the applied-road node editor: every centerline edge exposes a
// midpoint add-node action, and clicking it routes through the immutable corridor edit transaction.

import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roadNodeEditPath = require.resolve('../../frontend/js/road-node-edit.js');
const corridorGeometry = require('../../frontend/js/corridor-geometry.js');
const originalGlobals = new Map();

function installGlobal(name, value) {
    if (!originalGlobals.has(name)) {
        originalGlobals.set(name, Object.prototype.hasOwnProperty.call(globalThis, name)
            ? { present: true, value: globalThis[name] }
            : { present: false });
    }
    globalThis[name] = value;
}

function fakeLeaflet() {
    const layer = (kind, latLng = null, options = {}) => ({
        kind,
        latLng: Array.isArray(latLng) ? { lat: latLng[0], lng: latLng[1] } : latLng,
        options,
        handlers: {},
        bindTooltip(text) {
            this.tooltip = text;
            return this;
        },
        on(name, handler) {
            this.handlers[name] = handler;
            return this;
        },
        getLatLng() {
            return this.latLng;
        },
        setLatLng(next) {
            this.latLng = Array.isArray(next) ? { lat: next[0], lng: next[1] } : next;
            return this;
        }
    });

    return {
        layerGroup() {
            const group = layer('group');
            group.layers = [];
            group.addLayer = item => {
                group.layers.push(item);
                return group;
            };
            group.addTo = map => {
                map.layers.push(group);
                return group;
            };
            return group;
        },
        marker(latLng, options) {
            return layer('marker', latLng, options);
        },
        divIcon(options) {
            return options;
        },
        point(x, y) {
            return { x, y };
        },
        DomEvent: { stop() {} }
    };
}

function fakeMap() {
    return {
        layers: [],
        panes: {},
        handlers: {},
        getPane(name) {
            return this.panes[name] || null;
        },
        createPane(name) {
            this.panes[name] = { style: {} };
            return this.panes[name];
        },
        removeLayer(target) {
            this.layers = this.layers.filter(layer => layer !== target);
        },
        on(name, handler) {
            this.handlers[name] = handler;
        },
        latLngToLayerPoint(point) {
            return { x: point.lng * 100, y: point.lat * 100 };
        },
        layerPointToLatLng(point) {
            return { lat: point.y / 100, lng: point.x / 100 };
        }
    };
}

afterEach(() => {
    delete require.cache[roadNodeEditPath];
    originalGlobals.forEach((original, name) => {
        if (original.present) globalThis[name] = original.value;
        else delete globalThis[name];
    });
    originalGlobals.clear();
});

describe('applied-road midpoint node insertion', () => {
    it('renders the add action and inserts a node through the shared geometry edit path', async () => {
        const definition = {
            points: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }]],
            segmentIds: ['main'],
            segmentProfiles: { main: { strips: [{ type: 'driving', width: 6 }] } }
        };
        definition.segments = definition.points;
        const proposal = { proposalId: 'road-1', applied: true, roadProposal: { definition } };
        const map = fakeMap();

        installGlobal('map', map);
        installGlobal('L', fakeLeaflet());
        installGlobal('roadDrawingMode', false);
        installGlobal('ProposalSelection', { getKey: () => 'road-1' });
        installGlobal('proposalStorage', { getAllProposals: () => [proposal] });
        installGlobal('getProposalByIdOrHash', key => key === 'road-1' ? proposal : null);
        installGlobal('getProposalKey', item => item.proposalId);
        installGlobal('isApplied', item => item.applied === true);
        installGlobal('corridorCenterlineOf', value => value.points || value.segments || []);
        installGlobal('corridorIsTrack', () => false);
        installGlobal('CorridorGeometry', corridorGeometry);
        installGlobal('RoadEditingZoom', { enter() {}, exit() {} });
        installGlobal('updateLocalCorridorGeometry', async (_key, mutator) => {
            mutator(definition);
            return true;
        });

        delete require.cache[roadNodeEditPath];
        require(roadNodeEditPath);
        globalThis.refreshRoadNodeHandles();

        const group = map.layers.find(layer => layer.kind === 'group');
        const actions = group.layers.find(layer => layer.options.icon?.className === 'road-edge-actions');
        expect(actions.options.icon.html).toContain('data-road-edge-action="add"');

        actions.handlers.click({
            originalEvent: {
                target: { dataset: { roadEdgeAction: 'add' } }
            }
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(definition.points[0]).toEqual([
            { lat: 0, lng: 0 },
            { lat: 0, lng: 5 },
            { lat: 0, lng: 10 }
        ]);
        expect(definition.segmentIds).toEqual(['main']);
        expect(definition.segmentProfiles.main.strips[0].width).toBe(6);
    });
});
