// Unit tests for simplifyRingToVertexTarget (frontend/js/building-blocks.js): the vertex-budget
// simplifier that makes urban-rule "Edit shape manually" usable on large blocks.
//
// Why it exists: manual mode drops a draggable Leaflet handle on every outer-ring vertex. A big
// block's parametric outline runs to ~100k vertices (a negative buffer rounds every corner into
// GEOM_BUFFER_STEPS segments over a many-thousand-point superparcel), so entering manual mode used
// to try to create ~100k markers and froze the tab for 30s+ — the bug reported on the Gredelj block.
// Capping the editable ring to MANUAL_MAX_VERTICES fixes that.
//
// building-blocks.js is a classic browser script with no exports and reads turf as a global. It is
// evaluated in THIS realm (not a vm context) because turf's internal instanceof checks silently
// return the input unchanged across a realm boundary — a vm would make every simplify a no-op and the
// test would pass for the wrong reason.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as turf from '@turf/turf';

let simplifyRingToVertexTarget;
let MANUAL_MAX_VERTICES;
let setFootprintSlidersEnabled;
let setBlockifyModeForTest;

beforeAll(() => {
    global.turf = turf;
    // Minimal DOM / Leaflet / cross-file stubs so the classic script evaluates without a browser.
    const noop = () => {};
    const stub = () => ({ addTo() { return this; }, on() { return this; }, bindTooltip() { return this; }, setLatLng: noop, getLatLng: () => ({ lat: 0, lng: 0 }) });
    global.L = { geoJSON: stub, polygon: stub, polyline: stub, marker: stub, layerGroup: stub, featureGroup: stub, divIcon: () => ({}), map: () => ({ removeLayer: noop, addLayer: noop, fitBounds: noop, on: noop }) };
    global.document = { getElementById: () => ({ classList: { add: noop, remove: noop }, style: {}, addEventListener: noop, setAttribute: noop }), createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
    global.window = { addEventListener: noop, removeEventListener: noop, confirm: () => true, document: global.document };
    global.THREE = undefined;
    global.highlightBlock = noop;
    global.showBuildingAlert = noop;
    global.translateBuildingText = (_k, fallback) => fallback;

    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/building-blocks.js');
    let src = readFileSync(scriptPath, 'utf8');
    // Capture the symbols under test — appended inside the same eval string so they resolve even under
    // ESM strict mode (a bare direct eval would not leak the declarations into this scope).
    src += '\nglobalThis.__cap = { simplifyRingToVertexTarget, MANUAL_MAX_VERTICES, setFootprintSlidersEnabled, setBlockifyModeForTest: value => { blockifyMode = value; } };';
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    ({ simplifyRingToVertexTarget, MANUAL_MAX_VERTICES, setFootprintSlidersEnabled, setBlockifyModeForTest } = globalThis.__cap);
});

// A closed-ish [lng,lat] ring approximating a circle with `n` points around a centre.
function circleRing(n, cx = 15.99, cy = 45.80, r = 0.001) {
    const ring = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return ring;
}

describe('simplifyRingToVertexTarget', () => {
    it('exposes a sane default budget', () => {
        expect(MANUAL_MAX_VERTICES).toBeGreaterThan(3);
        expect(MANUAL_MAX_VERTICES).toBeLessThanOrEqual(200);
    });

    it('returns a small ring unchanged (a simple parcel keeps its exact corners)', () => {
        const square = [[15.990, 45.800], [15.992, 45.800], [15.992, 45.802], [15.990, 45.802]];
        expect(simplifyRingToVertexTarget(square, MANUAL_MAX_VERTICES)).toBe(square);
    });

    it('reduces a many-vertex ring to within the vertex budget', () => {
        const dense = circleRing(2000);
        const out = simplifyRingToVertexTarget(dense, 60);
        expect(out.length).toBeLessThanOrEqual(60);
        // Not a no-op: this is the whole point — the tab-freezing 2000 handles are gone.
        expect(out.length).toBeLessThan(dense.length);
    });

    it('preserves the overall shape (area within a few percent) while shedding vertices', () => {
        const dense = circleRing(2000);
        const out = simplifyRingToVertexTarget(dense, 60);
        const areaOf = (ring) => {
            const closed = ring.slice();
            const f = closed[0], l = closed[closed.length - 1];
            if (f[0] !== l[0] || f[1] !== l[1]) closed.push([f[0], f[1]]);
            return turf.area(turf.polygon([closed]));
        };
        const ratio = areaOf(out) / areaOf(dense);
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
    });

    it('honours a tighter budget', () => {
        const out = simplifyRingToVertexTarget(circleRing(2000), 20);
        expect(out.length).toBeLessThanOrEqual(20);
        expect(out.length).toBeGreaterThanOrEqual(4);
    });

    it('never returns a closing-duplicate vertex (the ring stays open, as manual mode expects)', () => {
        const out = simplifyRingToVertexTarget(circleRing(2000), 60);
        const f = out[0], l = out[out.length - 1];
        expect(f[0] === l[0] && f[1] === l[1]).toBe(false);
    });
});

describe('manual footprint controls', () => {
    it('keeps width enabled while locking shape-producing sliders', () => {
        const originalGetElementById = global.document.getElementById;
        const controls = new Map();
        global.document.getElementById = id => {
            if (!controls.has(id)) controls.set(id, { disabled: false });
            return controls.get(id);
        };

        try {
            setBlockifyModeForTest('manual');
            setFootprintSlidersEnabled(false);
            expect(controls.get('width-slider').disabled).toBe(false);
            expect(controls.get('setback-slider').disabled).toBe(true);
            expect(controls.get('chamfer-slider').disabled).toBe(true);

            setBlockifyModeForTest('parametric');
            setFootprintSlidersEnabled(true);
            expect(controls.get('setback-slider').disabled).toBe(false);
            expect(controls.get('width-slider').disabled).toBe(false);
        } finally {
            setBlockifyModeForTest('parametric');
            global.document.getElementById = originalGetElementById;
        }
    });
});
