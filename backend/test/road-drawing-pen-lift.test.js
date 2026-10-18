// The drawing tool's pen (road-editor.md decision 5): Escape lifts it and keeps what was placed,
// Escape with the pen up asks (build / discard / keep) and never builds silently, an empty tool just
// closes, a double-click builds, and anything that must not interleave with a click still being
// placed waits for it. Drives the real road-drawing.js in the fake browser world
// (helpers/road-drawing-env.js); the array surgery is the real road-stroke-state.js reducer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

const PEN_LIFTED = 'Pen lifted — click a node to continue from it, or anywhere to start a new stretch. Enter builds the road.';
const START_HINT = 'Click on the map to start drawing a road';

async function openTool(options) {
    env = loadRoadDrawing(options);
    await env.api.requestCorridorDrawingTool('road');
    expect(env.session.roadDrawingMode).toBe(true);
    return env;
}

async function clickAll(points) {
    for (const point of points) await env.click(point);
}

// Holds the tool's own finalization gate, as a build under way does, until release() is called.
function holdFinalizationGate() {
    let release;
    const run = env.session.roadFinalizationGate.run(() => new Promise(resolve => { release = resolve; }));
    return async () => {
        while (!release) await Promise.resolve();
        release();
        await run;
    };
}

describe('Escape lifts the pen', () => {
    it('keeps the three placed points and takes the rubber band away', async () => {
        await openTool();
        await clickAll([at(0, 0), at(100, 0), at(100, 100)]);
        await env.move(at(150, 150));
        expect(env.session.roadPreviewLine).not.toBeNull();
        const land = env.session.cachedCommittedPolygon;

        expect(env.api.liftRoadPen()).toBe(true);
        expect(env.session.roadSegments).toHaveLength(1);
        expect(env.session.roadSegments[0]).toHaveLength(3);
        expect(env.session.roadSegmentIds).toEqual(['s1']);
        expect(env.session.roadHasStarted).toBe(false);
        expect(env.session.roadPreviewLine).toBeNull();
        expect(env.session.roadPreviewPolygonLayer).toBeNull();
        expect(env.session.roadPendingSegmentLayer).toBeNull();
        // Nothing was removed, nothing to rebuild: the land is the very one the clicks built.
        expect(env.session.cachedCommittedPolygon).toBe(land);
        expect(env.lastStatus()).toBe(PEN_LIFTED);
    });

    it('drops a lone click — no line — with its id, and redraws without it', async () => {
        await openTool();
        await clickAll([at(0, 0), at(100, 0)]);
        env.api.liftRoadPen();
        await env.click(at(0, 300));
        expect(env.session.roadSegmentIds).toEqual(['s1', 's2']);
        expect(env.layersOfKind('circleMarker')).toHaveLength(3);

        env.api.liftRoadPen();
        expect(env.session.roadSegments).toHaveLength(1);
        expect(env.session.roadSegments[0]).toHaveLength(2);
        expect(env.session.roadSegmentIds).toEqual(['s1']);
        // Its vertex marker and its piece of centre line went with it.
        expect(env.layersOfKind('circleMarker')).toHaveLength(2);
        expect(env.session.roadCenterline.latlngs).toHaveLength(1);
    });

    it('says how to start when nothing drawable is left', async () => {
        await openTool();
        await env.click(at(0, 0));
        env.api.liftRoadPen();
        expect(env.session.roadSegments).toEqual([]);
        expect(env.lastStatus()).toBe(START_HINT);
    });

    it('does nothing with the pen already up', async () => {
        await openTool();
        await clickAll([at(0, 0), at(100, 0)]);
        env.api.liftRoadPen();
        const statusCount = env.statuses.length;
        expect(env.api.liftRoadPen()).toBe(false);
        expect(env.statuses).toHaveLength(statusCount);
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });
});

describe('what Escape does is decided when it runs', () => {
    it('lifts a pen that is down', async () => {
        await openTool();
        await clickAll([at(0, 0), at(100, 0)]);
        env.api.handleRoadEscape();
        expect(env.session.roadHasStarted).toBe(false);
        expect(env.session.roadSegments[0]).toHaveLength(2);
        expect(globalThis.showStyledChoice.calls).toHaveLength(0);
    });

    it('asks about a drawing with the pen up — never a silent build', async () => {
        await openTool();
        await clickAll([at(0, 0), at(100, 0)]);
        env.api.liftRoadPen();
        env.api.handleRoadEscape();
        await env.idle();
        expect(globalThis.showStyledChoice.calls).toHaveLength(1);
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
        expect(env.session.roadDrawingMode).toBe(true);
    });

    it('closes an empty tool', async () => {
        await openTool();
        env.api.handleRoadEscape();
        expect(env.session.roadDrawingMode).toBe(false);
        expect(globalThis.showStyledChoice.calls).toHaveLength(0);
    });

    it('does nothing while the road is being built or after the tool closed', async () => {
        await openTool();
        await clickAll([at(0, 0), at(100, 0)]);
        const release = holdFinalizationGate();
        env.api.handleRoadEscape();
        expect(env.session.roadHasStarted).toBe(true);
        await release();

        env.session.roadDrawingMode = false;
        env.api.handleRoadEscape();
        expect(env.session.roadHasStarted).toBe(true);
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });
});

describe('waiting for a click still being placed', () => {
    it('runs at once when nothing is being placed', () => {
        env = loadRoadDrawing();
        expect(env.session.roadSegmentPlacement).toBeNull();
        expect(env.api.afterRoadPlacement(() => 'done')).toBe('done');
    });

    it('waits for the placement to settle', async () => {
        env = loadRoadDrawing();
        let settle;
        env.session.roadSegmentPlacement = new Promise(resolve => { settle = resolve; });
        const action = vi.fn(() => 'done');
        const result = env.api.afterRoadPlacement(action);
        await Promise.resolve();
        expect(action).not.toHaveBeenCalled();
        settle();
        await expect(result).resolves.toBe('done');
        expect(action).toHaveBeenCalledTimes(1);
    });
});

describe('a double-click builds the road', () => {
    it('finishes a drawable road, after the click still being placed', async () => {
        const loads = [];
        await openTool({
            globals: { ensureBuildingFootprintsForBounds: () => new Promise(resolve => loads.push(resolve)) }
        });
        await env.click(at(0, 0));
        const before = loads.length;
        const placing = env.click(at(100, 0));
        while (loads.length <= before) await new Promise(resolve => setTimeout(resolve, 0));
        const building = env.map.fire('dblclick', { type: 'dblclick' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(globalThis.L.DomEvent.stopPropagation.calls.at(-1)[0]).toEqual({ type: 'dblclick' });
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);

        loads.forEach(resolve => resolve());
        await placing;
        await building;
        await env.idle();
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(1);
        // The build waited for the second point: it is part of the road.
        expect(globalThis.pendingRoadDrawingProposal.centerline[0]).toHaveLength(2);
    });

    it('builds nothing from a lone click, or while a build is under way', async () => {
        await openTool();
        await env.click(at(0, 0));
        await env.map.fire('dblclick', { type: 'dblclick' });
        expect(env.session.roadFinalizationGate.isRunning()).toBe(false);
        expect(env.session.roadDrawingMode).toBe(true);

        await env.click(at(100, 0));
        const release = holdFinalizationGate();
        await env.map.fire('dblclick', { type: 'dblclick' });
        await release();
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
        expect(env.session.roadDrawingMode).toBe(true);
    });

    it('holds the map’s double-click zoom while drawing and gives back only what it took', async () => {
        await openTool();
        expect(env.map.doubleClickZoom.enabled()).toBe(false);
        await env.api.cancelRoadDrawing();
        expect(env.map.doubleClickZoom.enabled()).toBe(true);

        // Off before the tool opened: the tool leaves it off.
        env.map.doubleClickZoom.disable();
        await env.api.requestCorridorDrawingTool('road');
        expect(env.session.roadDrawingHeldDoubleClickZoom).toBe(false);
        await env.api.cancelRoadDrawing();
        expect(env.map.doubleClickZoom.enabled()).toBe(false);
    });

    it('is wired in and out with the tool, and the second click of the pair adds nothing', async () => {
        await openTool();
        expect(env.map.listens('dblclick')).toBe(true);
        // Finishing suspends the tool's handlers: the double-click and its zoom hold go with them.
        env.api.suspendRoadDrawingInteractivity();
        expect(env.map.listens('dblclick')).toBe(false);
        expect(env.map.doubleClickZoom.enabled()).toBe(true);
        await env.api.cancelRoadDrawing();

        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        // The pair's second tap returns before it would take the placement lock.
        const secondTap = env.api.handleRoadClick({ latlng: at(50, 0), originalEvent: { detail: 2, pointerType: 'mouse' } });
        expect(env.session.roadSegmentPlacementInProgress).toBe(false);
        await secondTap;
        expect(env.session.roadPoints).toHaveLength(1);
    });
});

describe('the hints say what the keys now do', () => {
    const dict = locale => JSON.parse(readFileSync(new URL(`../../frontend/i18n/${locale}.json`, import.meta.url), 'utf8')).panel.road;

    it.each(['en', 'hr', 'es', 'sr'])('%s has the pen-lift status and no "segment cancelled" one', locale => {
        const road = dict(locale);
        ['penLiftedStatus', 'penLiftedStatusTrack', 'conflictsRecordedStatus', 'finishBlockedStatus', 'snapsToStreet',
            'snapsToUnnamedStreet', 'startHintTrack', 'seededHint'].forEach(key => {
            expect(typeof road[key], `${locale} panel.road.${key}`).toBe('string');
        });
        expect(road.segmentCancelledStatus).toBeUndefined();
    });

    it('mentions Esc lifting the pen and the double-click in the English drawing hints', () => {
        const road = dict('en');
        ['addPointsHint', 'addPointsHintTrack', 'continueHint', 'continueHintTrack'].forEach(key => {
            expect(road[key]).toMatch(/Double-click or Enter builds/);
            expect(road[key]).toMatch(/Esc lifts the pen/);
        });
    });
});
