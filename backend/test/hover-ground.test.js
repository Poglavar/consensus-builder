// The ground a proposal STANDS ON, out of every parcel it minted.
//
// Why it exists: a formation mints its plot AND the remainder it hands back to the host parcel.
// UPU Borovje's M1-11 cuts a 2,310 m² building plot out of the 58,226 m² parcel 1791/69 and mints
// the other ~55,900 m² back — so a highlight that painted "every child" drew a boundary around
// half the plan. These tests pin the rule that keeps the plot and drops the remainder, and the two
// fallbacks that keep it from ever going silent.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { groundUnderBody, MIN_TOUCH_M2 } from '../../frontend/js/proposals/hover-ground.js';

const ctx = {
    intersectionArea: (a, b) => {
        try { const hit = turf.intersect(a, b); return hit ? (turf.area(hit) || 0) : 0; } catch (_) { return 0; }
    }
};

// A box in metres-ish degrees around Borovje, big enough that turf areas are realistic.
const box = (west, south, width, height, id) => ({
    type: 'Feature',
    properties: { id },
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [west, south], [west + width, south], [west + width, south + height], [west, south + height], [west, south]
        ]]
    }
});

const HOST = box(16.010, 45.785, 0.004, 0.003, 'host');            // ~ the big cadastral parcel
const PLOT = box(16.0132, 45.7873, 0.0018, 0.0003, 'plot');        // the building's own plot
const REMAINDER = box(16.010, 45.788, 0.004, 0.0005, 'remainder'); // handed back, no body on it
const BODY = box(16.01325, 45.78735, 0.0017, 0.0002, 'building');  // the footprint, inside PLOT

describe('groundUnderBody', () => {
    it('keeps the plot the body stands on and drops the remainder handed back', () => {
        const kept = groundUnderBody([PLOT, REMAINDER], [BODY], ctx);

        expect(kept.map(f => f.properties.id)).toEqual(['plot']);
    });

    it('keeps every parcel that a multi-part body reaches', () => {
        const secondPlot = box(16.0155, 45.7873, 0.0010, 0.0003, 'plot-2');
        const secondBody = box(16.01555, 45.78735, 0.0009, 0.0002, 'building-2');

        const kept = groundUnderBody([PLOT, REMAINDER, secondPlot], [BODY, secondBody], ctx);

        expect(kept.map(f => f.properties.id).sort()).toEqual(['plot', 'plot-2']);
    });

    it('returns every parcel when the proposal has no body to stand on', () => {
        // A decide-later formation authors no geometry; its parcels ARE the proposal.
        const kept = groundUnderBody([PLOT, REMAINDER], [], ctx);

        expect(kept.map(f => f.properties.id)).toEqual(['plot', 'remainder']);
    });

    it('falls back to every parcel when the body touches none of them', () => {
        // Stale children or a moved footprint: showing too much beats going silent on a real
        // relationship, and silence is what a plain filter would produce.
        const elsewhere = box(16.030, 45.800, 0.001, 0.001, 'far-body');

        const kept = groundUnderBody([PLOT, REMAINDER], [elsewhere], ctx);

        expect(kept.map(f => f.properties.id)).toEqual(['plot', 'remainder']);
    });

    it('does not count a shared border as standing on a parcel', () => {
        // The neighbour touches PLOT along one edge only — zero area, so it is not this
        // proposal's ground even though the geometries meet.
        const neighbour = box(16.0150, 45.7873, 0.0010, 0.0003, 'neighbour');
        const plotEdgeBody = box(16.0132, 45.7873, 0.0018, 0.0003, 'body-fills-plot');

        const kept = groundUnderBody([PLOT, neighbour], [plotEdgeBody], ctx);

        expect(kept.map(f => f.properties.id)).toEqual(['plot']);
    });

    it('ignores an overlap below the contact floor', () => {
        const overlapping = box(16.010, 45.785, 0.004, 0.003, 'host-copy');
        const tiny = { intersectionArea: () => MIN_TOUCH_M2 / 2 };

        // Every candidate falls under the floor, so the fallback returns them all rather than none.
        expect(groundUnderBody([PLOT, overlapping], [BODY], tiny).length).toBe(2);
        // With one candidate above the floor, the sub-floor one is dropped.
        const mixed = { intersectionArea: (parcel) => (parcel.properties.id === 'plot' ? 500 : MIN_TOUCH_M2 / 2) };
        expect(groundUnderBody([PLOT, overlapping], [BODY], mixed).map(f => f.properties.id)).toEqual(['plot']);
    });

    it('survives a geometry the maths cannot handle', () => {
        const throwing = { intersectionArea: () => { throw new Error('degenerate ring'); } };

        // Unmeasurable is not "not there" — the fallback keeps the parcels visible.
        expect(groundUnderBody([PLOT, REMAINDER], [BODY], throwing).length).toBe(2);
    });

    it('passes parcels through untouched with no maths available', () => {
        expect(groundUnderBody([PLOT, REMAINDER], [BODY], null).length).toBe(2);
        expect(groundUnderBody([], [BODY], ctx)).toEqual([]);
        expect(groundUnderBody(null, null, ctx)).toEqual([]);
    });

    it('drops malformed features rather than passing them to the map', () => {
        const kept = groundUnderBody([PLOT, { type: 'Feature' }, null], [BODY], ctx);

        expect(kept.map(f => f.properties.id)).toEqual(['plot']);
    });
});
