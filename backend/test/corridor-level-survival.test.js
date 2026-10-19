// The vertical level has to survive the funnel every consumer of a stored centreline goes through.
//
// This is the failure mode corridor-elevation.md warned about and it is completely silent:
// corridorCenterlineOf rebuilds each vertex, and if it rebuilds a bare {lat,lng} then the
// acquisition footprint sees a corridor that is level 0 everywhere, the underground exemption never
// fires, and a tunnel quietly starts taking the land it passes under again. Nothing errors — the
// proposal simply acquires more than it should, which is invisible unless someone counts parcels.
//
// So the chain is pinned end to end here, not just the rule in isolation: stored definition ->
// corridorCenterlineOf -> corridorSegmentEntries -> acquiringSpans.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import levels from '../../frontend/js/proposals/corridor-levels.js';

const require = createRequire(import.meta.url);
const { corridorCenterlineOf, corridorSegmentEntries } = require('../../frontend/js/corridor-profile.js');

const tunnelled = [
    { lat: 43.70, lng: 15.90, level: 0 },
    { lat: 43.71, lng: 15.90, level: 0 },
    { lat: 43.72, lng: 15.90, level: -1 },
    { lat: 43.73, lng: 15.90, level: -1 },
    { lat: 43.74, lng: 15.90, level: 0 }
];

describe('level survives the stored-centreline funnel', () => {
    it('carries the level through corridorCenterlineOf', () => {
        const segments = corridorCenterlineOf({ points: [tunnelled], width: 6 });
        expect(segments).toHaveLength(1);
        expect(segments[0].map(point => point.level)).toEqual([0, 0, -1, -1, 0]);
    });

    it('carries it through corridorSegmentEntries, which is what the footprint reads', () => {
        const entries = corridorSegmentEntries({ points: [tunnelled], width: 6 });
        expect(entries).toHaveLength(1);
        expect(entries[0].points.map(point => point.level)).toEqual([0, 0, -1, -1, 0]);
    });

    it('still splits into two acquiring spans after the round trip', () => {
        const entries = corridorSegmentEntries({ points: [tunnelled], width: 6 });
        const spans = levels.acquiringSpans(entries[0].points);
        expect(spans).toHaveLength(2);
        expect(spans[0]).toHaveLength(3);
        expect(spans[1]).toHaveLength(2);
    });

    it('reads a legacy flat point list the same way', () => {
        const entries = corridorSegmentEntries({ points: tunnelled, width: 6 });
        expect(levels.acquiringSpans(entries[0].points)).toHaveLength(2);
    });
});

describe('corridors without a level are untouched', () => {
    const plain = [
        { lat: 43.70, lng: 15.90 },
        { lat: 43.71, lng: 15.90 },
        { lat: 43.72, lng: 15.90 }
    ];

    it('yields bare {lat,lng} vertices, with no level key invented', () => {
        const segments = corridorCenterlineOf({ points: [plain], width: 7.5 });
        segments[0].forEach(point => expect(Object.keys(point).sort()).toEqual(['lat', 'lng']));
    });

    it('acquires along its whole length, as one span', () => {
        const entries = corridorSegmentEntries({ points: [plain], width: 7.5 });
        expect(levels.acquiringSpans(entries[0].points)).toEqual([entries[0].points]);
    });

    it('ignores a non-numeric level rather than trusting it', () => {
        const odd = [{ lat: 43.7, lng: 15.9, level: '-1' }, { lat: 43.71, lng: 15.9, level: '-1' }];
        const entries = corridorSegmentEntries({ points: [odd], width: 6 });
        entries[0].points.forEach(point => expect(point.level).toBeUndefined());
        expect(levels.acquiringSpans(entries[0].points)).toEqual([entries[0].points]);
    });
});
