// Editing or cancelling a cross-section before placing an edge must leave the drawing usable.
// Drives the real road-drawing.js in the fake browser world (helpers/road-drawing-env.js), with the
// metric frame's frameFor watched; the cross-section editor's Cancel is lifted from
// corridor-editor.js and calls the loaded tool's own setRoadDrawingProfile.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const metricFrame = require('../../frontend/js/metric-frame.js');
const editorSource = readFileSync(fileURLToPath(new URL('../../frontend/js/corridor-editor.js', import.meta.url)), 'utf8');

function lift(source, name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}', start);
    expect(end, `${name} closing brace not found`).toBeGreaterThan(start);
    return source.slice(start, end + 2);
}

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// The tool open with `segments` already authored (and no frame made for them yet).
async function createHarness(segments = []) {
    const frameFor = vi.fn(points => metricFrame.frameFor(points));
    env = loadRoadDrawing({ globals: { __metricFrame: { ...metricFrame, frameFor } } });
    await env.api.requestCorridorDrawingTool('road');
    env.session.roadSegments = segments;
    env.session.roadSegmentIds = segments.map((_, index) => `s${index + 1}`);
    frameFor.mockClear();
    return { api: env.api, session: env.session, frameFor };
}

const PROFILE = { strips: [{ type: 'driving', width: 3 }] };
const POINT_A = at(0, 0);
const POINT_B = at(15, 10);

describe('road drawing profile edits without a drawable corridor', () => {
    it('accepts a profile with zero authored points without creating a metric frame', async () => {
        const harness = await createHarness();
        expect(harness.api.hasDrawableCorridor()).toBe(false);
        expect(() => harness.api.setRoadDrawingProfile(PROFILE)).not.toThrow();
        expect(harness.session.roadProfile).toEqual(PROFILE);
        expect(harness.session.roadDrawingFrame).toBeNull();
        expect(harness.session.cachedCommittedPolygon).toBeNull();
        expect(harness.frameFor).not.toHaveBeenCalled();
        expect(env.layersOfKind('polygon')).toHaveLength(0);
    });

    it('keeps a one-point centerline but creates no footprint or frame', async () => {
        const harness = await createHarness([[POINT_A]]);
        expect(harness.api.hasDrawableCorridor()).toBe(false);
        expect(() => harness.api.setRoadDrawingProfile(PROFILE)).not.toThrow();
        expect(harness.session.roadCenterline).not.toBeNull();
        expect(harness.session.roadDrawingFrame).toBeNull();
        expect(harness.frameFor).not.toHaveBeenCalled();
        expect(harness.session.cachedCommittedPolygon).toBeNull();
        expect(env.layersOfKind('polygon')).toHaveLength(0);
    });

    it('uses the metric frame and builds a footprint when the centerline is drawable', async () => {
        const harness = await createHarness([[POINT_A, POINT_B]]);
        expect(harness.api.hasDrawableCorridor()).toBe(true);
        expect(harness.api.setRoadDrawingProfile(PROFILE)).toBe(true);
        expect(harness.frameFor).toHaveBeenCalledWith([POINT_A, POINT_B]);
        expect(harness.session.roadDrawingFrame).toBe(harness.frameFor.mock.results[0].value);
        // 18 m at the profile's 3 m.
        const area = harness.api.calculatePolygonAreaMeters(harness.session.cachedCommittedPolygon);
        expect(area).toBeGreaterThan(0.9 * 3 * Math.hypot(15, 10));
        expect(area).toBeLessThan(1.1 * 3 * Math.hypot(15, 10));
        expect(harness.session.roadPolygon).toBe(harness.session.cachedCommittedPolygon);
        expect(harness.session.roadPolygonLayer.latlngs).toBe(harness.session.cachedCommittedPolygon);
    });

    it('clears the footprint and centerline when undo removes the last authored points', async () => {
        const harness = await createHarness([[POINT_A, POINT_B]]);
        harness.api.setRoadDrawingProfile(PROFILE);
        const land = harness.session.roadPolygonLayer;
        expect(land).not.toBeNull();
        harness.api.undoLastRoadSegment(); // one point remains: no footprint
        expect(harness.api.hasDrawableCorridor()).toBe(false);
        harness.api.undoLastRoadSegment(); // removes the last point and segment
        expect(harness.api.getAllRoadSegments(true)).toEqual([]);
        expect(harness.session.roadCenterline).toBeNull();
        expect(harness.session.cachedCommittedPolygon).toBeNull();
        expect(harness.session.roadPolygon).toBeNull();
        expect(harness.session.roadPolygonLayer).toBeNull();
        expect(env.map.hasLayer(land)).toBe(false);
        expect(env.map.layers.size).toBe(0);
    });

    it('lets Cancel restore the original profile and close an empty drawing editor', async () => {
        const harness = await createHarness();
        const closeEditor = vi.fn();
        // eslint-disable-next-line no-new-func
        const corridorEditorCancel = new Function('setRoadDrawingProfile', 'corridorEditorState', 'corridorEditorClose',
            `${lift(editorSource, 'corridorEditorCancel')}; return corridorEditorCancel;`
        )(harness.api.setRoadDrawingProfile, { mode: 'drawing', originalProfile: PROFILE }, closeEditor);
        expect(() => corridorEditorCancel()).not.toThrow();
        expect(harness.session.roadProfile).toEqual(PROFILE);
        expect(harness.session.roadWidth).toBe(3);
        expect(closeEditor).toHaveBeenCalledTimes(1);
    });
});
