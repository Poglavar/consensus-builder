// Headless interaction coverage for the applied-road node editor: every centerline edge exposes a
// midpoint add-node action, and clicking it routes through the immutable corridor edit transaction.
// Also the editor-honesty rules (road-editor.md decision 6 and P2/P3): a node drag is one undo step
// that restores every road the junction carried, ⌥-click never empties a stretch, a plain click on a
// mid-stretch node offers "Split the stretch here", and road and track handles carry each other.

import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roadNodeEditPath = require.resolve('../../frontend/js/road-node-edit.js');
const corridorGeometry = require('../../frontend/js/corridor-geometry.js');
const geometryEditHistory = require('../../frontend/js/geometry-edit/history.js');
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
        latLng(lat, lng) {
            return { lat, lng };
        },
        DomEvent: { stop() {} }
    };
}

// Pixels are lat/lng x 100, as in fakeMap; the snap search measures with distanceTo.
function pixel(x, y) {
    return { x, y, distanceTo: other => Math.hypot(other.x - x, other.y - y) };
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
            return pixel(point.lng * 100, point.lat * 100);
        },
        layerPointToLatLng(point) {
            return { lat: point.y / 100, lng: point.x / 100 };
        },
        distance(a, b) {
            return Math.hypot(a.lat - b.lat, a.lng - b.lng) * 111320;
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

// One applied corridor record. `segments` are [lat, lng] pairs per stretch.
function corridorRecord(key, segments, { ids = null, profiles = null, isTrack = false } = {}) {
    const points = segments.map(segment => segment.map(([lat, lng]) => ({ lat, lng })));
    const definition = { points, segments: points, segmentIds: ids || points.map((_, index) => `${key}-s${index}`) };
    if (profiles) definition.segmentProfiles = profiles;
    if (isTrack) definition.isTrack = true;
    return { proposalId: key, title: key, applied: true, roadProposal: { definition } };
}

// Boot the node editor on fakes, with `selected` as the selected road. Edits apply in place to the
// stored definitions; Cmd/Ctrl+Z is delivered through the window keydown listener the editor binds.
function bootNodeEditor(proposals, selected, { choice = null } = {}) {
    const map = fakeMap();
    const byKey = new Map(proposals.map(proposal => [proposal.proposalId, proposal]));
    const calls = { updates: [], statuses: [], prompts: [] };
    const keydown = [];

    installGlobal('window', globalThis);
    installGlobal('addEventListener', (type, handler) => { if (type === 'keydown') keydown.push(handler); });
    installGlobal('removeEventListener', () => {});
    installGlobal('map', map);
    installGlobal('L', fakeLeaflet());
    installGlobal('roadDrawingMode', false);
    installGlobal('ProposalSelection', { getKey: () => selected });
    installGlobal('proposalStorage', { getAllProposals: () => [...byKey.values()] });
    installGlobal('getProposalByIdOrHash', key => byKey.get(String(key)) || null);
    installGlobal('getProposalKey', item => item.proposalId);
    installGlobal('isApplied', item => item.applied === true);
    installGlobal('corridorCenterlineOf', value => value.points || value.segments || []);
    installGlobal('corridorIsTrack', value => value.isTrack === true);
    installGlobal('CorridorGeometry', corridorGeometry);
    installGlobal('GeometryEditHistory', geometryEditHistory);
    installGlobal('RoadEditingZoom', { enter() {}, exit() {} });
    installGlobal('updateStatus', message => { calls.statuses.push(message); });
    installGlobal('showStyledChoice', async (message, choices) => {
        calls.prompts.push({ message, choices });
        return choice;
    });
    installGlobal('updateLocalCorridorGeometry', async (key, mutator) => {
        calls.updates.push(key);
        const record = byKey.get(String(key));
        if (!record) return false;
        mutator(record.roadProposal.definition);
        return true;
    });

    delete require.cache[roadNodeEditPath];
    require(roadNodeEditPath);
    globalThis.refreshRoadNodeHandles();

    const handles = () => (map.layers.find(layer => layer.kind === 'group')?.layers || [])
        .filter(layer => layer.kind === 'marker' && layer.options.draggable);
    return {
        calls,
        handleAt: (lat, lng) => handles().find(layer => layer.latLng.lat === lat && layer.latLng.lng === lng),
        undo: () => keydown.forEach(handler => handler({
            key: 'z', metaKey: true, target: { tagName: 'DIV' }, preventDefault() {}
        })),
        pointsOf: key => byKey.get(key).roadProposal.definition.points
            .map(segment => segment.map(point => [point.lat, point.lng]))
    };
}

// The edits run on a promise chain (runExclusiveEdit); a macrotask lets every link of it settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('node editor honesty', () => {
    it('undoes a junction drag in one step, putting back every road the junction carried', async () => {
        const roads = [
            corridorRecord('road-1', [[[0, 0], [0, 5], [0, 10]]]),
            corridorRecord('road-2', [[[0, 5], [5, 5]]])
        ];
        const junctions = [
            [{ lat: 0, lng: 5, arms: [{ toward: { lat: 5, lng: 5 }, width: 8 }] }],
            [{ lat: 0, lng: 5, arms: [{ toward: { lat: 0, lng: 0 }, width: 12 }, { toward: { lat: 0, lng: 10 }, width: 12 }] }]
        ];
        roads.forEach((road, index) => { road.roadProposal.definition.junctions = structuredClone(junctions[index]); });
        const editor = bootNodeEditor(roads, 'road-1');
        const junction = editor.handleAt(0, 5);
        expect(junction.options.icon.className).toContain('road-node-handle--junction');

        junction.handlers.dragstart();
        junction.setLatLng({ lat: 1, lng: 5 });
        junction.handlers.dragend();
        await settle();
        expect(editor.pointsOf('road-1')).toEqual([[[0, 0], [1, 5], [0, 10]]]);
        expect(editor.pointsOf('road-2')).toEqual([[[1, 5], [5, 5]]]);
        roads.forEach((road, index) => {
            expect(road.roadProposal.definition.junctions).toEqual([{ ...junctions[index][0], lat: 1 }]);
        });

        editor.undo();
        await settle();
        expect(editor.pointsOf('road-1')).toEqual([[[0, 0], [0, 5], [0, 10]]]);
        expect(editor.pointsOf('road-2')).toEqual([[[0, 5], [5, 5]]]);
        roads.forEach((road, index) => {
            expect(road.roadProposal.definition.junctions).toEqual(junctions[index]);
        });
    });

    it('takes back the undo step of a drag that every record refused', async () => {
        const editor = bootNodeEditor([corridorRecord('road-1', [[[0, 0], [0, 5], [0, 10]]])], 'road-1');
        globalThis.updateLocalCorridorGeometry = async () => false;
        const node = editor.handleAt(0, 5);
        node.handlers.dragstart();
        node.setLatLng({ lat: 1, lng: 5 });
        node.handlers.dragend();
        await settle();

        let restored = 0;
        globalThis.updateLocalCorridorGeometry = async () => { restored += 1; return true; };
        editor.undo();
        await settle();
        expect(restored).toBe(0);
    });

    it('refuses an ⌥-click that would empty a two-point stretch, and says what to do instead', async () => {
        const editor = bootNodeEditor([corridorRecord('road-1', [[[0, 0], [0, 10]]])], 'road-1');
        editor.handleAt(0, 0).handlers.click({ originalEvent: { altKey: true } });
        await settle();

        expect(editor.calls.updates).toEqual([]);
        expect(editor.pointsOf('road-1')).toEqual([[[0, 0], [0, 10]]]);
        expect(editor.calls.statuses.at(-1)).toMatch(/Bulldoze the stretch instead/);
    });

    it('still disconnects the selected road from a junction when its stretch keeps two points', async () => {
        const editor = bootNodeEditor([
            corridorRecord('road-1', [[[0, 0], [0, 5], [0, 10]]]),
            corridorRecord('road-2', [[[0, 5], [5, 5]]])
        ], 'road-1');
        editor.handleAt(0, 5).handlers.click({ originalEvent: { altKey: true } });
        await settle();

        expect(editor.pointsOf('road-1')).toEqual([[[0, 0], [0, 10]]]);
        expect(editor.pointsOf('road-2')).toEqual([[[0, 5], [5, 5]]]);
    });

    it('offers "Split the stretch here" on a plain click mid-stretch, and the split is undoable', async () => {
        const profile = { strips: [{ type: 'driving', width: 6 }] };
        const editor = bootNodeEditor([
            corridorRecord('road-1', [[[0, 0], [0, 5], [0, 10]]], { ids: ['main'], profiles: { main: profile } })
        ], 'road-1', { choice: 'split' });
        const node = editor.handleAt(0, 5);
        expect(node.tooltip).toMatch(/split the stretch/);

        node.handlers.click({ originalEvent: {} });
        await settle();
        expect(editor.calls.prompts).toHaveLength(1);
        expect(editor.calls.prompts[0].choices.map(choice => choice.value)).toEqual(['split', 'remove', 'cancel']);
        expect(editor.calls.prompts[0].choices[0].label).toMatch(/different cross-sections/);
        const definition = globalThis.getProposalByIdOrHash('road-1').roadProposal.definition;
        expect(editor.pointsOf('road-1')).toEqual([[[0, 0], [0, 5]], [[0, 5], [0, 10]]]);
        expect(definition.segmentIds).toEqual(['main', 'main~2']);
        expect(definition.segmentProfiles['main~2']).toEqual(profile);
        expect(editor.calls.statuses.at(-1)).toMatch(/This segment/);

        // The split point is now a stretch boundary: a plain handle that says what it is.
        const boundary = editor.handleAt(0, 5);
        expect(boundary.options.icon.className).not.toContain('junction');
        expect(boundary.tooltip).toMatch(/Stretch boundary/);

        editor.undo();
        await settle();
        expect(editor.pointsOf('road-1')).toEqual([[[0, 0], [0, 5], [0, 10]]]);
        expect(definition.segmentIds).toEqual(['main']);
        expect(Object.keys(definition.segmentProfiles)).toEqual(['main']);
    });

    it('does not offer the choice on a junction or a loose end', async () => {
        const editor = bootNodeEditor([
            corridorRecord('road-1', [[[0, 0], [0, 5], [0, 10]]]),
            corridorRecord('road-2', [[[0, 5], [5, 5]]])
        ], 'road-1', { choice: 'split' });
        editor.handleAt(0, 5).handlers.click({ originalEvent: {} });
        editor.handleAt(0, 0).handlers.click({ originalEvent: {} });
        await settle();
        expect(editor.calls.prompts).toEqual([]);
        expect(editor.calls.updates).toEqual([]);
    });

    it('carries a track leg with a road junction handle, and snaps a dragged road node onto a track node', async () => {
        const editor = bootNodeEditor([
            corridorRecord('road-1', [[[0, 0], [0, 5], [0, 10]]]),
            corridorRecord('tram-1', [[[0, 5], [5, 5]], [[3, 0], [3, 0.5], [3, 1]]], { isTrack: true })
        ], 'road-1');
        const shared = editor.handleAt(0, 5);
        expect(shared.options.icon.className).toContain('road-node-handle--junction');
        expect(shared.tooltip).toMatch(/1 other road meets here/);

        shared.handlers.dragstart();
        shared.setLatLng({ lat: 1, lng: 5 });
        shared.handlers.dragend();
        await settle();
        expect(editor.pointsOf('tram-1')[0][0]).toEqual([1, 5]);

        // Dropped 4 px from a track VERTEX: it joins the track there.
        const end = editor.handleAt(0, 10);
        end.handlers.dragstart();
        end.setLatLng({ lat: 3.04, lng: 0.5 });
        end.handlers.dragend();
        await settle();
        expect(editor.pointsOf('road-1')[0].at(-1)).toEqual([3, 0.5]);
    });
});
