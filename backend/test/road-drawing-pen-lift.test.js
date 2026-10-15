// The drawing tool's pen (road-editor.md decision 5): Escape lifts it and keeps what was placed,
// Escape with the pen up asks (build / discard / keep) and never builds silently, an empty tool just
// closes, a double-click builds, and anything that must not interleave with a click still being
// placed waits for it. Runs the real functions lifted from road-drawing.js with their collaborators
// injected; the array surgery is the real road-stroke-state.js reducer.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RoadStrokeState = require('../../frontend/js/road-stroke-state.js');
const roadSource = readFileSync(new URL('../../frontend/js/road-drawing.js', import.meta.url), 'utf8');

function lift(name) {
    let start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    if (roadSource.slice(start - 6, start) === 'async ') start -= 6;
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

const P = (lat, lng) => ({ lat, lng });
const a = P(45.8, 15.97), b = P(45.8, 15.971), c = P(45.801, 15.971), d = P(45.802, 15.972);

function loadPen(segments, activeIndex) {
    const calls = [];
    const state = { segments, ids: segments.map((_, index) => `s${index + 1}`), activeIndex };
    // eslint-disable-next-line no-new-func
    const api = new Function('state', 'calls', 'RoadStrokeState', `
        let roadSegments = state.segments;
        let roadSegmentIds = state.ids;
        let roadPoints = state.activeIndex >= 0 ? roadSegments[state.activeIndex] : [];
        let roadHasStarted = state.activeIndex >= 0;
        let roadStrokeBaseCount = 0;
        const window = { RoadStrokeState };
        const clearRoadRubberBand = () => calls.push('rubber-band');
        const clearPendingRoadSegment = () => calls.push('pending');
        const pruneRoadEdgeConflicts = () => calls.push('prune');
        const rebuildRoadGeometryFromSegments = () => calls.push('rebuild');
        const redrawRoadVertexMarkers = () => calls.push('markers');
        const updateRoadInfoPanel = () => {};
        const updateUndoButtonState = () => {};
        const updateStatus = message => calls.push('status: ' + message);
        const corridorDrawingIsTrack = () => false;
        const translateRoadText = (key, fallback) => fallback;
        ${lift('getAllRoadSegments')}
        ${lift('hasDrawableCorridor')}
        ${lift('roadPenUpStatusText')}
        ${lift('liftRoadPen')}
        return {
            liftRoadPen,
            state: () => ({ roadSegments, roadSegmentIds, roadHasStarted, roadPoints })
        };
    `)(state, calls, RoadStrokeState);
    return { ...api, calls };
}

describe('Escape lifts the pen', () => {
    it('keeps the three placed points and takes the rubber band away', () => {
        const pen = loadPen([[a, b, c]], 0);
        expect(pen.liftRoadPen()).toBe(true);
        const after = pen.state();
        expect(after.roadSegments).toEqual([[a, b, c]]);
        expect(after.roadSegmentIds).toEqual(['s1']);
        expect(after.roadHasStarted).toBe(false);
        expect(pen.calls).toContain('rubber-band');
        expect(pen.calls).toContain('pending');
        expect(pen.calls).not.toContain('rebuild');   // nothing was removed, nothing to rebuild
        expect(pen.calls.at(-1)).toBe('status: Pen lifted — click a node to continue from it, or anywhere to start a new stretch. Enter builds the road.');
    });

    it('drops a lone click — no line — with its id, and redraws without it', () => {
        const pen = loadPen([[a, b], [d]], 1);
        pen.liftRoadPen();
        expect(pen.state().roadSegments).toEqual([[a, b]]);
        expect(pen.state().roadSegmentIds).toEqual(['s1']);
        expect(pen.calls).toEqual(expect.arrayContaining(['prune', 'rebuild', 'markers']));
    });

    it('says how to start when nothing drawable is left', () => {
        const pen = loadPen([[d]], 0);
        pen.liftRoadPen();
        expect(pen.state().roadSegments).toEqual([]);
        expect(pen.calls.at(-1)).toBe('status: Click on the map to start drawing a road');
    });

    it('does nothing with the pen already up', () => {
        const pen = loadPen([[a, b]], -1);
        expect(pen.liftRoadPen()).toBe(false);
        expect(pen.calls).toEqual([]);
    });
});

describe('what Escape does is decided when it runs', () => {
    function escape({ hasStarted, drawable, running = false, drawing = true }) {
        const calls = [];
        // eslint-disable-next-line no-new-func
        new Function(
            'roadDrawingMode', 'roadFinalizationGate', 'roadHasStarted', 'hasDrawableCorridor',
            'liftRoadPen', 'promptCloseDrawnCorridor', 'exitRoadDrawingMode', 'finishRoadDrawing',
            `${lift('handleRoadEscape')}; return handleRoadEscape;`
        )(
            drawing, { isRunning: () => running }, hasStarted, () => drawable,
            () => calls.push('lift'), () => calls.push('ask'), () => calls.push('close'), () => calls.push('build')
        )();
        return calls;
    }

    it('lifts a pen that is down', () => {
        expect(escape({ hasStarted: true, drawable: true })).toEqual(['lift']);
    });

    it('asks about a drawing with the pen up — never a silent build', () => {
        expect(escape({ hasStarted: false, drawable: true })).toEqual(['ask']);
    });

    it('closes an empty tool', () => {
        expect(escape({ hasStarted: false, drawable: false })).toEqual(['close']);
    });

    it('does nothing while the road is being built or after the tool closed', () => {
        expect(escape({ hasStarted: true, drawable: true, running: true })).toEqual([]);
        expect(escape({ hasStarted: true, drawable: true, drawing: false })).toEqual([]);
    });
});

describe('waiting for a click still being placed', () => {
    const load = placement => new Function(
        'roadSegmentPlacement', `${lift('afterRoadPlacement')}; return afterRoadPlacement;`
    )(placement);

    it('runs at once when nothing is being placed', () => {
        expect(load(null)(() => 'done')).toBe('done');
    });

    it('waits for the placement to settle', async () => {
        let settle;
        const placement = new Promise(resolve => { settle = resolve; });
        const action = vi.fn(() => 'done');
        const result = load(placement)(action);
        await Promise.resolve();
        expect(action).not.toHaveBeenCalled();
        settle();
        await expect(result).resolves.toBe('done');
        expect(action).toHaveBeenCalledTimes(1);
    });
});

describe('a double-click builds the road', () => {
    function doubleClick({ drawable, running = false, placement = null }) {
        const calls = [];
        const handler = new Function(
            'L', 'roadSegmentPlacement', 'roadDrawingMode', 'roadFinalizationGate', 'hasDrawableCorridor', 'finishRoadDrawing',
            `${lift('afterRoadPlacement')}; ${lift('handleRoadDoubleClick')}; return handleRoadDoubleClick;`
        )(
            { DomEvent: { stopPropagation: () => calls.push('stopped') } },
            placement, true, { isRunning: () => running }, () => drawable,
            () => { calls.push('build'); return Promise.resolve(true); }
        );
        return { result: handler({ type: 'dblclick' }), calls };
    }

    it('finishes a drawable road, after the click still being placed', async () => {
        let settle;
        const placement = new Promise(resolve => { settle = resolve; });
        const { result, calls } = doubleClick({ drawable: true, placement });
        await Promise.resolve();
        expect(calls).toEqual(['stopped']);
        settle();
        await result;
        expect(calls).toEqual(['stopped', 'build']);
    });

    it('builds nothing from a lone click, or while a build is under way', async () => {
        expect(doubleClick({ drawable: false }).calls).toEqual(['stopped']);
        expect(doubleClick({ drawable: true, running: true }).calls).toEqual(['stopped']);
    });

    it('holds the map’s double-click zoom while drawing and gives back only what it took', () => {
        const make = enabled => ({
            doubleClickZoom: {
                on: enabled,
                enabled() { return this.on; },
                enable() { this.on = true; },
                disable() { this.on = false; }
            }
        });
        // eslint-disable-next-line no-new-func
        const load = map => new Function('map', `
            let roadDrawingHeldDoubleClickZoom = false;
            ${lift('holdRoadDoubleClickZoom')}
            ${lift('releaseRoadDoubleClickZoom')}
            return { hold: holdRoadDoubleClickZoom, release: releaseRoadDoubleClickZoom };
        `)(map);
        const on = make(true);
        const zoom = load(on);
        zoom.hold();
        expect(on.doubleClickZoom.on).toBe(false);
        zoom.release();
        expect(on.doubleClickZoom.on).toBe(true);
        const off = make(false);
        const untouched = load(off);
        untouched.hold();
        untouched.release();
        expect(off.doubleClickZoom.on).toBe(false);
    });

    it('is wired in and out with the tool, and the second click of the pair adds nothing', () => {
        const toggle = lift('toggleRoadDrawTool');
        expect(toggle).toContain("map.on('dblclick', handleRoadDoubleClick);");
        expect(toggle).toContain('holdRoadDoubleClickZoom();');
        expect(toggle).toContain("map.off('dblclick', handleRoadDoubleClick);");
        expect(toggle).toContain('releaseRoadDoubleClickZoom();');
        const suspend = lift('suspendRoadDrawingInteractivity');
        expect(suspend).toContain("map.off('dblclick', handleRoadDoubleClick);");
        expect(suspend).toContain('releaseRoadDoubleClickZoom();');
        const click = lift('handleRoadClick');
        expect(click.indexOf('isDoubleClickFollowUp(')).toBeGreaterThan(-1);
        expect(click.indexOf('isDoubleClickFollowUp(')).toBeLessThan(click.indexOf('roadSegmentPlacementInProgress = true;'));
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
