// Exercise the real globe city rendering/picking functions through AST extraction and small VM stubs.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const CityDisplay = require('../../frontend/js/world/globe-city-display.js');
const source = readFileSync(new URL('../../frontend/js/world/globe.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script' });

function extractFunction(name) {
    const found = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    if (found.length !== 1) throw new Error(`Expected one ${name} declaration, found ${found.length}`);
    return source.slice(found[0].start, found[0].end);
}

function fixedGeometryHarness() {
    const context = { CityDisplay, dynamicUsage: 'dynamic-draw' };
    vm.createContext(context);
    vm.runInContext(`
        class BufferAttribute {
            constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
            setUsage(usage) { this.usage = usage; return this; }
        }
        class BufferGeometry {
            constructor() { this.attributes = {}; }
            setAttribute(name, value) { this.attributes[name] = value; }
            setDrawRange(start, count) { this.drawRange = { start, count }; }
        }
        const THREE = { BufferAttribute, BufferGeometry, DynamicDrawUsage: dynamicUsage };
        ${extractFunction('buildCityPoints')}
        this.build = () => buildCityPoints(THREE);
    `, context);
    return context;
}

function nodeStub() {
    const classes = new Set();
    return {
        textContent: '',
        style: { values: {}, setProperty(key, value) { this.values[key] = value; } },
        classList: {
            add(name) { classes.add(name); },
            toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }
        },
        classes
    };
}

function displayHarness(catalog, { altitudeKm = 1, width = 1200, height = 900, blocked = [] } = {}) {
    const projectCounter = { count: 0 };
    const labels = Array.from({ length: CityDisplay.MAX_LABELS }, () => ({
        node: nodeStub(), city: null, entry: null, placement: null
    }));
    const attributes = {
        position: { array: new Float32Array(CityDisplay.MAX_MARKERS * 3) },
        color: { array: new Float32Array(CityDisplay.MAX_MARKERS * 3) },
        size: { array: new Float32Array(CityDisplay.MAX_MARKERS) },
        pulse: { array: new Float32Array(CityDisplay.MAX_MARKERS) },
        opacity: { array: new Float32Array(CityDisplay.MAX_MARKERS) }
    };
    const state = {
        catalog,
        labels,
        attributes,
        blocked,
        markerDrawRange: null,
        selections: [],
        document: { activeElement: null },
        projectCounter,
        width,
        height,
        altitudeKm
    };
    const instrumentedCityDisplay = {
        ...CityDisplay,
        layout(candidates, viewport, options) {
            const result = CityDisplay.layout(candidates, viewport, options);
            state.layoutResult = result;
            return result;
        }
    };
    const context = { CityDisplay: instrumentedCityDisplay, state };
    vm.createContext(context);
    vm.runInContext(`
        const FOV = 40;
        const cityEntries = state.catalog;
        const liveLabels = state.labels;
        const cityGeo = {
            attributes: state.attributes,
            setDrawRange(start, count) { state.markerDrawRange = { start, count }; }
        };
        const cam = { lat: 0, lon: 0, altitudeKm: state.altitudeKm };
        const viewport = { w: state.width, h: state.height };
        const document = state.document;
        const selected = null;
        let cityLayoutDirty = true;
        let lastCityLayout = -Infinity;
        let cityLayoutSignature = '';
        let visibleMarkers = [];
        let blockedCityAreas = [];
        const coverage = { tierAt: (lat, lon) => ({ kind: 'live-city', lat, lon }) };
        const renderer = { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: viewport.w, height: viewport.h }) } };
        const obstacles = state.blocked;
        function cityObstacles() { return obstacles; }
        function screenOf(vec) { state.projectCounter.count += 1; return vec.screen; }
        function select(place) { state.selections.push(place); }
        const THREE = { Vector3: class {
            constructor() { this.value = [0, 0, 0]; }
            unproject() { return this; }
            sub() { return this; }
            toArray() { return this.value; }
        } };
        const GM = { raySphere: () => null, vectorToLatLon: () => ({ lat: 0, lon: 0 }) };
        ${extractFunction('updateCityDisplay')}
        ${extractFunction('positionCityLabels')}
        ${extractFunction('pickAt')}
        this.api = {
            updateCityDisplay,
            positionCityLabels,
            pickAt,
            forceLayout() { cityLayoutDirty = true; },
            setAltitude(value) { cam.altitudeKm = value; cityLayoutDirty = true; },
            state() { return { cityLayoutDirty, lastCityLayout, visibleMarkers, blockedCityAreas, drawRange: state.markerDrawRange }; }
        };
    `, context);
    return { context, api: context.api, state, labels, attributes, projectCounter };
}

function catalogOf({ live = 0, research = 0, position = (_, index) => [40 + (index % 15) * 75, 30 + Math.floor(index / 15) * 40], livePopulation = 9_000_000 } = {}) {
    const coverage = {
        liveCities: Array.from({ length: live }, (_, index) => ({
            id: `live-${String(index).padStart(4, '0')}`, name: `Live ${index}`, lat: index, lon: index,
            population2025: index === live - 1 ? null : livePopulation - index
        })),
        cities: Array.from({ length: research }, (_, index) => ({
            id: `research-${String(index).padStart(4, '0')}`, name: `Research ${index}`, lat: index, lon: index,
            tier: 'source', population2025: 20_000_000 - index
        }))
    };
    return CityDisplay.rankCities(coverage).map((entry, index) => {
        const [x, y] = position(entry, index);
        const vec = [index / 1000, index / 2000, 1];
        vec.screen = { x, y };
        return { ...entry, vec, color: [0.2, 0.5, 0.8], labelWidth: 54, labelHeight: 16 };
    });
}

describe('globe city renderer orchestration', () => {
    it('allocates fixed dynamic GPU attributes and starts with an empty draw range', () => {
        const geometry = fixedGeometryHarness().build();
        const components = { position: 3, color: 3, size: 1, pulse: 1, opacity: 1 };

        expect(Object.keys(geometry.attributes).sort()).toEqual(Object.keys(components).sort());
        for (const [name, count] of Object.entries(components)) {
            const attribute = geometry.attributes[name];
            expect(attribute.array.constructor.name).toBe('Float32Array');
            expect(attribute.array.length).toBe(CityDisplay.MAX_MARKERS * count);
            expect(attribute.usage).toBe('dynamic-draw');
        }
        expect(geometry.drawRange).toEqual({ start: 0, count: 0 });
    });

    it('projects 2,000 catalog entries into a bounded GPU draw range and reuses the fixed label pool', () => {
        const catalog = catalogOf({ live: 2_000 });
        const h = displayHarness(catalog);
        const originalNodes = h.labels.map(item => item.node);
        h.api.updateCityDisplay(1000);
        h.api.positionCityLabels();

        const first = h.api.state();
        expect(h.state.layoutResult.labels.length).toBeGreaterThan(0);
        expect(first.visibleMarkers.length).toBeLessThanOrEqual(CityDisplay.MAX_MARKERS);
        expect(first.drawRange).toEqual({ start: 0, count: first.visibleMarkers.length });
        expect(h.labels).toHaveLength(CityDisplay.MAX_LABELS);
        expect(h.labels.filter(item => item.entry).length).toBeLessThanOrEqual(CityDisplay.MAX_LABELS);
        expect(h.labels.some(item => item.entry && !item.node.classList.contains('world-city-label--hidden'))).toBe(true);
        for (const item of h.labels.filter(label => label.entry)) {
            expect(item.placement.entry).toBe(item.entry);
            expect(item.node.textContent).toBe(item.entry.city.name);
        }
        expect(h.labels.map(item => item.node)).toEqual(originalNodes);
        expect(Object.values(h.attributes).every(attribute => attribute.needsUpdate === true)).toBe(true);
        expect(h.attributes.size.array.length).toBeLessThanOrEqual(CityDisplay.MAX_MARKERS);
        const activeSizes = Array.from(h.attributes.size.array.slice(0, first.drawRange.count));
        const activeGlowCount = Array.from(h.attributes.pulse.array.slice(0, first.drawRange.count)).filter(value => value > 0.5).length;
        expect(activeSizes.every(value => Number.isFinite(value) && value > 0 && value <= 11)).toBe(true);
        expect(activeGlowCount).toBeLessThanOrEqual(CityDisplay.MAX_LABELS);

        // A new obstacle must change placement even inside the normal 100ms camera throttle.
        const oldLabelKeys = h.labels.filter(item => item.entry).map(item => item.entry.key);
        h.state.blocked.push({ x: 48, y: 18, w: 80, h: 30 });
        h.api.forceLayout();
        h.api.updateCityDisplay(1050);
        h.api.positionCityLabels();
        const updatedLabelKeys = h.labels.filter(item => item.entry).map(item => item.entry.key);
        expect(oldLabelKeys).toContain('live:live-0000');
        expect(updatedLabelKeys).not.toContain('live:live-0000');

        h.api.setAltitude(5_000);
        h.api.updateCityDisplay(1100);
        h.api.positionCityLabels();
        expect(h.labels.map(item => item.node)).toEqual(originalNodes);
        expect(h.api.state().visibleMarkers.length).toBeLessThanOrEqual(CityDisplay.MAX_MARKERS);
    });

    it('throttles ordinary projection to 100ms but lets forced layout changes through immediately', () => {
        const h = displayHarness(catalogOf({ live: 120 }));
        h.api.updateCityDisplay(1000);
        const firstProjectionCount = h.projectCounter.count;
        const previousRange = h.api.state().drawRange;

        h.api.updateCityDisplay(1050);
        expect(h.projectCounter.count).toBe(firstProjectionCount);
        expect(h.api.state().drawRange).toEqual(previousRange);

        h.api.forceLayout();
        h.api.setAltitude(7_000);
        h.api.updateCityDisplay(1051);
        expect(h.projectCounter.count).toBeGreaterThan(firstProjectionCount);
        expect(h.api.state().lastCityLayout).toBe(1051);
    });

    it('picks a drawn live marker when a higher-priority hidden research city is closer to the tap', () => {
        const catalog = catalogOf({
            live: 1,
            research: 1,
            position: entry => entry.live ? [600, 450] : [603, 450]
        });
        catalog.find(entry => entry.live).city.lat = 41;
        catalog.find(entry => entry.live).city.lon = 29;
        catalog.find(entry => !entry.live).city.lat = 10;
        catalog.find(entry => !entry.live).city.lon = 15;
        const h = displayHarness(catalog, { altitudeKm: 20_000 });
        h.api.updateCityDisplay(1000);
        const state = h.api.state();
        const visible = state.visibleMarkers;
        expect(visible.map(marker => marker.entry.key)).toEqual(['live:live-0000']);

        h.api.pickAt(603, 450);
        expect(h.state.selections).toEqual([{ kind: 'live-city', lat: 41, lon: 29 }]);
    });
});
