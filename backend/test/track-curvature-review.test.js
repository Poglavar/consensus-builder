import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';
const require = createRequire(import.meta.url);
const { measureCorridorCurvature } = require('../../frontend/js/corridor-geometry.js');
let env;
afterEach(() => { env?.dispose(); env = null; });

describe('track curvature drawing review', () => {
    it('measures a right-angle polyline and ignores straight or disconnected two-point strokes', () => {
        const bend = [at(0, 0), at(100, 0), at(100, 100)];
        const violations = measureCorridorCurvature([bend, [at(0, 0), at(100, 0), at(200, 0)], [at(0, 0), at(0, 100)]], 5000);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ segmentIndex: 0, vertexIndex: 1 });
        expect(violations[0].radiusM).toBeCloseTo(71, 0);
        expect(measureCorridorCurvature([bend], 50)).toEqual([]);
        expect(measureCorridorCurvature([bend], null)).toEqual([]);
    });

    it.each([false, true])('reviews an authored right angle at Finish (snapped=%s), without displacing clicks', async snapped => {
        const confirm = vi.fn(async () => false);
        const points = [at(80, 100), at(120, 100)];
        env = loadRoadDrawing({ globals: { CbDialog: { confirm },
            LegacyRoadCenterlines: { snapLines: () => snapped ? [{ points, name: 'Reference rail', wayId: 'rail-1', bbox: [points[0].lng, points[0].lat, points[1].lng, points[1].lat] }] : [], ensureLoaded() {}, scheduleLoad() {} } } });
        await env.api.requestCorridorDrawingTool('road');
        env.session.trackSpeed = 250;
        env.session.trackMinCurvatureRadius = 5000;
        env.api.setRoadDrawingProfile({ strips: [{ type: 'rail', gauge: 1435, width: 3.5 }] });
        await env.click(at(0, 0), { altKey: true });
        await env.click(at(100, 0), { altKey: true });
        const click = at(100, snapped ? 98 : 100);
        if (snapped) expect(env.api.findRoadSnapTarget(click)).toMatchObject({ source: 'street' });
        await env.click(click, { altKey: !snapped });
        const last = env.api.getAllRoadSegments(true)[0].at(-1);
        expect(last.lng).toBeCloseTo(at(100, 100).lng, 8);
        expect(last.lat).toBeCloseTo(at(100, 100).lat, 8);
        env.api.setRoadDrawingProfile({ strips: [{ type: 'rail', gauge: 1000, width: 2.75 }] });
        expect(env.session.trackSpeed).toBe(250);
        expect(env.session.trackMinCurvatureRadius).toBe(5000);
        env.session.roadDrawingProfileValidationPending = false;
        expect(await env.api.finishRoadDrawingOnce()).toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
        expect(confirm.mock.calls[0][0]).toContain('5,000 m target for 250 km/h');
        expect(confirm.mock.calls[0][0]).toContain('not an engineering assessment');
        expect(confirm.mock.calls[0][1]).toEqual({ title: 'Track radius target', okText: 'Continue', cancelText: 'Keep editing' });
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
        expect(env.session.roadDrawingMode).toBe(true);
        expect(env.api.getAllRoadSegments(true)[0]).toHaveLength(3);
        confirm.mockResolvedValue(true);
        await env.api.finishRoadDrawingOnce();
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(1);
        const draft = env.draftStore.listDrafts()[0];
        expect(draft.editorPayload.definition.metadata.trackSpeed).toBe(250);
        expect(draft.editorPayload.definition.metadata.trackMinRadius).toBe(5000);
    });
});
