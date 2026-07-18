// The move-to-fit write-back: baking a shifted centerline into whatever raw shape the stored
// definition uses (one flat point list, a list of segments under `points`, or under `segments`).
// The editor state is null under node, so these tests exercise the whole-road path — the write
// must land only when the target segment is unambiguous (exactly one valid segment).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corridorEditorWriteScopedSegmentPoints } = require('../../frontend/js/corridor-editor.js');

const MOVED = [{ lat: 45.8001, lng: 15.97 }, { lat: 45.8002, lng: 15.98 }];

describe('corridorEditorWriteScopedSegmentPoints', () => {
    it('replaces a flat single-segment point list', () => {
        const definition = { points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.98 }] };
        corridorEditorWriteScopedSegmentPoints(definition, MOVED);
        expect(definition.points).toEqual(MOVED);
        expect(definition.points[0]).not.toBe(MOVED[0]); // clones, not shared references
    });

    it('replaces the single valid segment of a nested points list', () => {
        const other = [{ lat: 45.9, lng: 16.0 }]; // one point: not a valid segment
        const definition = { points: [other, [{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.98 }]] };
        corridorEditorWriteScopedSegmentPoints(definition, MOVED);
        expect(definition.points[0]).toBe(other); // untouched
        expect(definition.points[1]).toEqual(MOVED);
    });

    it('writes under `segments` when the definition has no points', () => {
        const definition = { segments: [[{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.98 }]] };
        corridorEditorWriteScopedSegmentPoints(definition, MOVED);
        expect(definition.segments[0]).toEqual(MOVED);
    });

    it('refuses an ambiguous write (several valid segments, no scoped segment id)', () => {
        const a = [{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.98 }];
        const b = [{ lat: 45.9, lng: 15.97 }, { lat: 45.9, lng: 15.98 }];
        const definition = { points: [a, b] };
        corridorEditorWriteScopedSegmentPoints(definition, MOVED);
        expect(definition.points[0]).toBe(a);
        expect(definition.points[1]).toBe(b);
    });
});
