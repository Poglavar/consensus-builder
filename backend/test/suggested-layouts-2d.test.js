// The 2D suggested-layouts layer (frontend/js/suggested-layouts-2d.js): which proposed buildings get a
// layout, the per-slice entries and their warnings, the path styles, the per-style grouping, the
// flagged-slice hit test, and the Leaflet wiring driven with fakes, so none of it needs a browser.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const floorPlans = require('../../frontend/js/building-floor-plans.js'); // also the generator's validator
const generator = require('../../frontend/js/default-floor-plans.js');
const context = require('../../frontend/js/default-floor-plan-context.js');
const layer = require('../../frontend/js/suggested-layouts-2d.js');

const M_PER_DEG = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M_PER_DEG * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M_PER_DEG];
const rectangle = (cx, cy, w, h, properties = {}) => turf.polygon([[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]].map(lngLat)], properties);

// Two 12 m parcels side by side with one 24 × 12 m building across both, and a 6 × 5 m building alone on a third.
const parcels = [rectangle(-6, 0, 12, 30, { parcelId: 'A' }), rectangle(6, 0, 12, 30, { parcelId: 'B' }), rectangle(60, 0, 20, 20, { parcelId: 'C' })];
const row = rectangle(0, 0, 24, 12, { proposalId: 'p1', buildingIndex: 0, height: 13.2 });
const tiny = rectangle(60, 0, 6, 5, { proposalId: 'p2', buildingIndex: 0, height: 6.6 });
const withEvidence = rectangle(120, 0, 20, 12, { proposalId: 'p3', buildingIndex: 0, floorPlans: { schema: 'evidence' } });
const withModel = rectangle(160, 0, 20, 12, { proposalId: 'p4', buildingIndex: 0, modelUrl: 'https://example.org/building.glb' });
const parcelsFor = feature => parcels.filter(parcel => turf.booleanIntersects(parcel, feature));

function collect(proposedBuildings, extra = {}) {
    return layer.collectLayouts({
        proposedBuildings, context, generator, turf, parcelsFor, storeyFallbackM: 3.3,
        neighbourPool: feature => context.neighbourPool(feature, proposedBuildings, [], turf),
        heightOf: feature => layer.heightOfBuilding(feature),
        ...extra
    });
}

describe('collectLayouts', () => {
    it('plans one layout per parcel slice and skips buildings that bring their own interior', () => {
        const entries = collect([row, withEvidence, withModel, { type: 'Feature', properties: { proposalId: 'p5' }, geometry: null }]);
        expect(entries.map(entry => entry.parcelId)).toEqual(['A', 'B']);
        for (const entry of entries) {
            expect(entry.building).toBe(row);
            expect(entry.floorPlans).toMatchObject({ suggested: true });
            expect(entry.floorPlans.floors.some(floor => floor.level === 0)).toBe(true);
            expect(Math.round(turf.area(entry.footprint))).toBe(144);
            // No roads are passed in 2D: the entrance faces the longest facade, and says so.
            expect(entry.warnings.map(warning => warning.code)).toContain('front-assumed-longest');
        }
    });

    it('returns a slice too small for a minimum core flagged, with the generator\'s reasons', () => {
        const [entry, ...rest] = collect([tiny]);
        expect(rest).toEqual([]);
        expect(entry).toMatchObject({ building: tiny, parcelId: 'C', floorPlans: null });
        expect(entry.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'core-does-not-fit', severity: 'error' })]));
        const lines = layer.tooltipLines(entry.warnings);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/Too small to fit a minimum/);
    });

    it('plans each slice once: a second pass over the same buildings is served from the cache', () => {
        const counted = { ...generator, planDefaultFloorPlans: vi.fn(generator.planDefaultFloorPlans) };
        const cache = new Map();
        const first = collect([row, tiny], { generator: counted, cache });
        expect(counted.planDefaultFloorPlans).toHaveBeenCalledTimes(3);
        const second = collect([row, tiny], { generator: counted, cache });
        expect(counted.planDefaultFloorPlans).toHaveBeenCalledTimes(3);
        expect(second.map(entry => entry.floorPlans)).toEqual(first.map(entry => entry.floorPlans));
        expect(second[0].floorPlans).toBe(first[0].floorPlans);
    });

    it('hands the planner the drawn height, the storey fallback, no roads, the region and its collaborators', () => {
        const calls = [];
        const fakeContext = { planBuilding: (subject, options) => { calls.push({ subject, options }); return { slices: [] }; } };
        const neighbours = [tiny];
        layer.collectLayouts({ proposedBuildings: [row], context: fakeContext, generator, turf, cache: new Map(), region: 'HR', storeyFallbackM: 3.1,
            parcelsFor: () => parcels, neighbourPool: () => neighbours, heightOf: () => 21 });
        expect(calls).toHaveLength(1);
        expect(calls[0].subject).toBe(row);
        expect(calls[0].options).toMatchObject({ owner: row, roads: null, region: 'HR', heightM: 21, storeyFallbackM: 3.1, generator, turf });
        expect(calls[0].options.parcels).toBe(parcels);
        expect(calls[0].options.neighbours).toBe(neighbours);
    });

    it('flags a building whose planning throws, with the error, and still plans the others', () => {
        const broken = rectangle(200, 0, 20, 12, { proposalId: 'p6', buildingIndex: 0 });
        const fakeContext = {
            planBuilding: (subject, options) => {
                if (subject === broken) throw new Error('generator bug');
                return context.planBuilding(subject, options);
            }
        };
        const entries = collect([broken, row], { context: fakeContext });
        expect(entries.map(entry => entry.parcelId)).toEqual([null, 'A', 'B']);
        expect(entries[0]).toMatchObject({ building: broken, floorPlans: null,
            warnings: [{ code: 'layout-failed', severity: 'error', message: 'generator bug' }] });
        expect(entries[0].error).toBeInstanceOf(Error);
        expect(entries[0].footprint.geometry).toBe(broken.geometry);
        expect(entries[1].floorPlans).not.toBeNull();
    });

    it('refuses to run without its collaborators', () => {
        expect(() => layer.collectLayouts({ proposedBuildings: [row], generator, turf })).toThrow(/context, generator and turf/);
    });
});

describe('heightOfBuilding', () => {
    it('uses the shared estimator when the 3D stack has loaded it', () => {
        const estimator = vi.fn(() => 17.5);
        expect(layer.heightOfBuilding(row, estimator)).toBe(17.5);
        expect(estimator).toHaveBeenCalledWith(row);
    });

    it('otherwise takes the building\'s own height in metres, else 10 m, never a missing height as zero', () => {
        expect(layer.heightOfBuilding({ properties: { height: 13.2 } })).toBe(13.2);
        expect(layer.heightOfBuilding({ properties: { height: '12' } })).toBe(12);
        for (const height of [null, undefined, 0, -3, 'tall']) {
            expect(layer.heightOfBuilding({ properties: { height } })).toBe(10);
        }
        expect(layer.heightOfBuilding({})).toBe(10);
    });
});

describe('withinBbox', () => {
    it('keeps the features that reach the box', () => {
        const box = turf.bbox(rectangle(0, 0, 40, 40));
        expect(layer.withinBbox([row, tiny, withModel, { type: 'Feature', geometry: null }], box, turf)).toEqual([row]);
        expect(layer.withinBbox(null, box, turf)).toEqual([]);
    });
});

describe('styleFor', () => {
    const style = (properties, palette) => layer.styleFor({ type: 'Feature', properties, geometry: null }, palette);

    it('names a class per kind and opening type, which the stylesheet colours from tokens', () => {
        const cases = [
            [{ kind: 'slab' }, 'slab'], [{ kind: 'wall' }, 'wall'], [{ kind: 'landing' }, 'landing'], [{ kind: 'stair' }, 'stair'],
            [{ kind: 'railing' }, 'railing'], [{ kind: 'opening', opening: 'window' }, 'window'], [{ kind: 'opening', opening: 'door' }, 'door'],
            [{ kind: 'opening', opening: 'glazedDoor' }, 'glazed-door'], [{ kind: 'opening', opening: 'slidingDoor' }, 'sliding-door'],
            [{ kind: 'flagged' }, 'flagged'], [{ kind: 'something-new' }, 'slab'], [{ kind: 'opening', opening: 'hatch' }, 'door']
        ];
        for (const [properties, key] of cases) {
            expect(style(properties).className, JSON.stringify(properties)).toBe(`cb-suggested-layout cb-suggested-layout--${key}`);
        }
    });

    it('fills walls solid and slabs light, keeps landings unstroked, and draws stairs and openings as lines', () => {
        expect(style({ kind: 'wall' })).toMatchObject({ fillOpacity: 1, weight: 1 });
        expect(style({ kind: 'wall' }).fill).not.toBe(false);
        expect(style({ kind: 'slab' })).toMatchObject({ fillOpacity: 0.85, weight: 0.5 });
        expect(style({ kind: 'landing' })).toMatchObject({ stroke: false });
        for (const properties of [{ kind: 'stair' }, { kind: 'railing' }, { kind: 'opening', opening: 'window' }, { kind: 'opening', opening: 'glazedDoor' }]) {
            expect(style(properties).fill, JSON.stringify(properties)).toBe(false);
        }
        expect(style({ kind: 'opening', opening: 'glazedDoor' }).weight).toBeGreaterThan(style({ kind: 'opening', opening: 'window' }).weight);
    });

    it('outlines a flagged footprint dashed over a faint fill', () => {
        expect(style({ kind: 'flagged' })).toMatchObject({ dashArray: '6 4', weight: 2, fillOpacity: 0.15 });
        expect(style({ kind: 'flagged' }).fill).not.toBe(false);
    });

    it('repeats the palette roles inline when given, and leaves colour to the stylesheet otherwise', () => {
        const palette = { slab: 'role-slab', line: 'role-line', wall: 'role-wall', core: 'role-core', window: 'role-window',
            door: 'role-door', entrance: 'role-entrance', lift: 'role-lift', flagged: 'role-flagged' };
        expect(style({ kind: 'wall' }, palette)).toMatchObject({ color: 'role-wall', fillColor: 'role-wall' });
        expect(style({ kind: 'slab' }, palette)).toMatchObject({ color: 'role-line', fillColor: 'role-slab' });
        expect(style({ kind: 'landing' }, palette)).toMatchObject({ fillColor: 'role-core' });
        expect(style({ kind: 'stair' }, palette)).toMatchObject({ color: 'role-core' });
        expect(style({ kind: 'opening', opening: 'window' }, palette)).toMatchObject({ color: 'role-window' });
        expect(style({ kind: 'opening', opening: 'door' }, palette)).toMatchObject({ color: 'role-door' });
        expect(style({ kind: 'opening', opening: 'glazedDoor' }, palette)).toMatchObject({ color: 'role-entrance' });
        expect(style({ kind: 'opening', opening: 'slidingDoor' }, palette)).toMatchObject({ color: 'role-lift' });
        expect(style({ kind: 'flagged' }, palette)).toMatchObject({ color: 'role-flagged', fillColor: 'role-flagged' });
        const plain = style({ kind: 'wall' });
        expect(plain).not.toHaveProperty('color');
        expect(plain).not.toHaveProperty('fillColor');
    });

    it('reads the palette roles from the stylesheet\'s custom properties', () => {
        const read = name => ({ '--suggested-layout-wall': '  role-wall ', '--suggested-layout-flagged': 'role-flagged' })[name] || '';
        expect(layer.paletteFrom(read)).toEqual({ wall: 'role-wall', flagged: 'role-flagged' });
    });
});

describe('groupByStyle', () => {
    it('draws a slice as one feature per style, slab first and openings last, keeping every part', () => {
        const [entry] = collect([row]);
        const raw = floorPlans.floorPlanToGeoJSON(entry.floorPlans, 0);
        const grouped = layer.groupByStyle(raw);
        const keyOf = feature => layer.styleFor(feature).className.split('--')[1];
        const keys = grouped.features.map(keyOf);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys[0]).toBe('slab');
        expect(keys.indexOf('wall')).toBeLessThan(keys.indexOf('window'));
        expect(keys).toContain('glazed-door'); // the ground floor carries the building entrance
        for (const feature of grouped.features) {
            const parts = raw.features.filter(part => keyOf(part) === keyOf(feature));
            expect(feature.geometry.type).toBe(parts[0].geometry.type === 'Polygon' ? 'MultiPolygon' : 'MultiLineString');
            expect(feature.geometry.coordinates).toEqual(parts.map(part => part.geometry.coordinates));
        }
        expect(raw.features.filter(part => part.properties.kind === 'wall').length).toBeGreaterThan(1);
    });

    it('refuses a style that mixes polygons and lines', () => {
        const square = rectangle(0, 0, 2, 2).geometry;
        const mixed = { type: 'FeatureCollection', features: [
            { type: 'Feature', properties: { kind: 'wall' }, geometry: square },
            { type: 'Feature', properties: { kind: 'wall' }, geometry: { type: 'LineString', coordinates: square.coordinates[0].slice(0, 2) } }
        ] };
        expect(() => layer.groupByStyle(mixed)).toThrow(/mixes MultiPolygon and LineString/);
    });
});

describe('flaggedAt and tooltipLines', () => {
    it('finds the flagged slice under a point, ignoring slices that have a layout', () => {
        const entries = collect([row, tiny]);
        const flagged = entries.find(entry => !entry.floorPlans);
        expect(layer.flaggedAt(entries, lngLat([60, 0]), turf)).toBe(flagged);
        expect(layer.flaggedAt(entries, lngLat([-6, 0]), turf)).toBeNull(); // inside the planned row
        expect(layer.flaggedAt(entries, lngLat([60, 40]), turf)).toBeNull();
    });

    it('says why there is no layout: the errors, else every message, once each', () => {
        expect(layer.tooltipLines([
            { severity: 'notice', message: 'No street data.' }, { severity: 'error', message: 'Too small.' }, { severity: 'error', message: 'Too small.' }
        ])).toEqual(['Too small.']);
        expect(layer.tooltipLines([{ severity: 'notice', message: 'One apartment per floor.' }, { severity: 'notice' }])).toEqual(['One apartment per floor.']);
        expect(layer.tooltipLines(null)).toEqual([]);
    });
});

describe('requestedByUrl', () => {
    it('turns the layer on for ?suggested2d=1 only', () => {
        expect(layer.requestedByUrl('?suggested2d=1')).toBe(true);
        expect(layer.requestedByUrl('?lang=hr&suggested2d=1')).toBe(true);
        expect(layer.requestedByUrl('?suggested2d=0')).toBe(false);
        expect(layer.requestedByUrl('?suggested=1')).toBe(false); // the 3D view's flag
        expect(layer.requestedByUrl('')).toBe(false);
    });
});

// The page wiring against a fake map and a fake Leaflet: the pane, what is drawn at and below building
// zoom, the pointer-following reasons of a flagged slice, and switching off.
describe('Leaflet wiring', () => {
    const globals = ['map', 'L', 'turf', 'document', 'getComputedStyle', 'proposedBuildings', 'buildingFeaturePool', 'LiveParcelFabric'];
    let map, L;

    beforeAll(() => {
        const handlers = {};
        const view = turf.bbox(rectangle(30, 0, 120, 60));
        map = {
            zoom: 18, handlers, layers: new Set(), panes: {},
            getZoom() { return this.zoom; },
            getBounds: () => ({ pad: () => ({ getWest: () => view[0], getSouth: () => view[1], getEast: () => view[2], getNorth: () => view[3] }) }),
            getPane(name) { return this.panes[name]; },
            createPane(name) { this.panes[name] = { style: {} }; return this.panes[name]; },
            on(type, fn) { (handlers[type] = handlers[type] || new Set()).add(fn); return this; },
            off(type, fn) { if (handlers[type]) handlers[type].delete(fn); return this; },
            whenReady(fn) { fn.call(this); return this; },
            hasLayer(item) { return this.layers.has(item); },
            addLayer(item) { this.layers.add(item); return this; },
            removeLayer(item) { this.layers.delete(item); return this; }
        };
        L = {
            svg: options => ({ renderer: 'svg', options }),
            layerGroup: () => {
                const group = { children: [], addTo(target) { target.addLayer(group); return group; }, clearLayers() { group.children = []; return group; } };
                return group;
            },
            geoJSON: (data, options) => {
                const drawn = { data, options, addTo(group) { group.children.push(drawn); return drawn; } };
                return drawn;
            },
            tooltip: options => {
                const tip = { options, content: null, latlng: null, setContent(content) { tip.content = content; return tip; },
                    setLatLng(latlng) { tip.latlng = latlng; return tip; }, addTo(target) { target.addLayer(tip); return tip; } };
                return tip;
            }
        };
        const element = () => ({ children: [], textContent: '', appendChild(child) { this.children.push(child); } });
        Object.assign(globalThis, {
            map, L, turf,
            document: { createElement: element, getElementById: () => null },
            getComputedStyle: () => ({ getPropertyValue: name => (name === '--suggested-layout-flagged' ? 'role-flagged' : '') }),
            proposedBuildings: [row, tiny, withModel],
            buildingFeaturePool: [],
            LiveParcelFabric: { queryBounds: (box, query) => (query && query.includeCorridors ? parcels.filter(parcel => turf.booleanIntersects(parcel, turf.bboxPolygon(box))) : []) }
        });
    });

    afterAll(() => {
        if (layer.isEnabled()) layer.setEnabled(false);
        globals.forEach(name => { delete globalThis[name]; });
    });

    const group = () => [...map.layers].find(item => Array.isArray(item.children));
    const tooltip = () => [...map.layers].find(item => item.options && item.options.className === 'cb-suggested-layout-tooltip');

    it('draws every slice on its own non-interactive pane above the proposed buildings', () => {
        layer.setEnabled(true);
        expect(map.panes.suggestedLayoutsPane.style).toEqual({ zIndex: '646', pointerEvents: 'none' });
        expect(['moveend', 'mousemove', 'mouseout'].every(type => map.handlers[type] && map.handlers[type].size === 1)).toBe(true);
        expect(layer.snapshot()).toMatchObject({ enabled: true, drawn: 3, flagged: 1 });
        const drawn = group().children;
        expect(drawn.every(item => item.options.pane === 'suggestedLayoutsPane' && item.options.interactive === false)).toBe(true);
        const [planA, planB, flagged] = drawn;
        expect(planA.data.type).toBe('FeatureCollection');
        expect(planA.data.features.map(feature => feature.properties.kind)).toEqual(expect.arrayContaining(['slab', 'wall', 'opening']));
        expect(planB.data.features.length).toBeGreaterThan(3);
        expect(flagged.data).toMatchObject({ type: 'Feature', properties: { kind: 'flagged' }, geometry: tiny.geometry });
        // Colour comes from the stylesheet's role, read back for the inline style.
        expect(flagged.options.style(flagged.data)).toMatchObject({ className: 'cb-suggested-layout cb-suggested-layout--flagged', color: 'role-flagged' });
    });

    it('shows a flagged slice\'s reasons where the pointer is, and hides them off it', () => {
        const move = [...map.handlers.mousemove][0];
        const [lng, lat] = lngLat([60, 0]);
        move({ latlng: { lng, lat } });
        const tip = tooltip();
        expect(tip.latlng).toEqual({ lng, lat });
        expect(tip.content.children.map(line => line.textContent)).toEqual([expect.stringMatching(/Too small to fit a minimum/)]);
        const [awayLng, awayLat] = lngLat([0, 0]); // over a planned slice: nothing to explain
        move({ latlng: { lng: awayLng, lat: awayLat } });
        expect(tooltip()).toBeUndefined();
    });

    it('draws nothing below building zoom', () => {
        map.zoom = 16;
        layer.rebuild();
        expect(group().children).toEqual([]);
        expect(layer.snapshot()).toMatchObject({ drawn: 0, flagged: 0 });
        map.zoom = 18;
        layer.rebuild();
        expect(layer.snapshot()).toMatchObject({ drawn: 3, flagged: 1 });
    });

    it('switches off cleanly: the group leaves the map and the map handlers are dropped', () => {
        const drawnGroup = group();
        layer.setEnabled(false);
        expect(map.layers.has(drawnGroup)).toBe(false);
        expect(drawnGroup.children).toEqual([]);
        expect(['moveend', 'mousemove', 'mouseout'].every(type => map.handlers[type].size === 0)).toBe(true);
        expect(layer.snapshot()).toMatchObject({ enabled: false, drawn: 0, flagged: 0 });
    });
});

// The Layers row and the URL flag: a fresh copy of the module loaded into a fake window whose document
// has the "Show proposed buildings" row, as index.html does.
describe('the Layers toggle', () => {
    function fakeDocument() {
        const byId = new Map();
        const element = tag => {
            let id = '';
            const node = {
                tagName: tag.toUpperCase(), attributes: {}, children: [], parentNode: null, listeners: {}, textContent: '', title: '', type: '', checked: false,
                get id() { return id; },
                set id(value) { id = value; byId.set(value, node); },
                setAttribute(name, value) { node.attributes[name] = String(value); },
                append(...items) { items.forEach(item => { if (typeof item === 'object') item.parentNode = node; node.children.push(item); }); },
                insertBefore(item, before) {
                    item.parentNode = node;
                    const at = node.children.indexOf(before);
                    if (at < 0) node.children.push(item); else node.children.splice(at, 0, item);
                    return item;
                },
                get nextSibling() { return node.parentNode ? node.parentNode.children[node.parentNode.children.indexOf(node) + 1] || null : null; },
                closest(name) { let at = node; while (at && at.tagName !== name.toUpperCase()) at = at.parentNode; return at || null; },
                addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); }
            };
            return node;
        };
        const group = element('div');
        const proposedRow = element('label');
        const proposedBox = element('input');
        proposedBox.id = 'showProposedBuildings';
        proposedRow.append(proposedBox);
        const nextRow = element('label');
        group.append(proposedRow, nextRow);
        return { group, proposedRow, nextRow, document: { readyState: 'complete', getElementById: name => byId.get(name) || null, createElement: element, addEventListener() {} } };
    }

    function loadInto(fakeWindow) {
        const path = require.resolve('../../frontend/js/suggested-layouts-2d.js');
        const cached = require.cache[path];
        delete require.cache[path];
        globalThis.window = fakeWindow;
        try { return require(path); } finally {
            delete globalThis.window;
            delete require.cache[path];
            if (cached) require.cache[path] = cached;
        }
    }

    function fakeWindow(search) {
        const dom = fakeDocument();
        const win = {
            document: dom.document, location: { search }, listeners: {}, toggled: [],
            addEventListener(type, fn) { (win.listeners[type] = win.listeners[type] || []).push(fn); },
            toggleLayer(type) { win.toggled.push(type); },
            i18n: { t: key => `translated ${key}` }
        };
        return { win, dom };
    }

    it('adds a translatable row right after "Show proposed buildings", off by default, routed through toggleLayer', () => {
        const { win, dom } = fakeWindow('');
        const api = loadInto(win);
        expect(win.__suggestedLayouts2D).toBe(api);
        const [, row, after] = dom.group.children;
        expect(dom.group.children[0]).toBe(dom.proposedRow);
        expect(after).toBe(dom.nextRow);
        expect(row.attributes).toEqual({ 'data-i18n-key': 'sidebar.buildings.showSuggestedLayoutsTooltip', 'data-i18n-attr': 'title' });
        expect(row.title).toBe('translated sidebar.buildings.showSuggestedLayoutsTooltip');
        const box = row.children[0], text = row.children[2];
        expect(box).toMatchObject({ tagName: 'INPUT', type: 'checkbox', id: 'showSuggestedLayouts', checked: false });
        expect(text.attributes['data-i18n-key']).toBe('sidebar.buildings.showSuggestedLayouts');
        expect(text.textContent).toBe('translated sidebar.buildings.showSuggestedLayouts');
        expect(win.toggled).toEqual([]);
        box.checked = true;
        box.listeners.change.forEach(fn => fn());
        expect(win.toggled).toEqual(['suggestedLayouts']);
        expect(Object.keys(win.listeners).sort()).toEqual(['parcelFabricCommitted', 'proposedBuildingsUpdated']);
    });

    it('turns on at load for ?suggested2d=1', () => {
        const { win, dom } = fakeWindow('?suggested2d=1');
        loadInto(win);
        expect(dom.group.children[1].children[0].checked).toBe(true);
        expect(win.toggled).toEqual(['suggestedLayouts']);
    });
});
