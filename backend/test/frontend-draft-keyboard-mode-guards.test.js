// Draft keyboard handlers must not consume Escape, Enter, or undo/draw keys after a transition
// into 3D. These handlers are private closures in browser modules, so exercise their source bodies
// with the same body-class state MapShell owns and assert their user-visible side effects stay idle.
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const sources = {
    site: read('../../frontend/js/site-drawing.js'),
    transit: read('../../frontend/js/transit-stations.js'),
    areaDraw: read('../../frontend/js/area-monitor/draw.js'),
    areaPaint: read('../../frontend/js/area-monitor/paint.js'),
    road: read('../../frontend/js/road-drawing.js')
};

function between(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end).trim();
}

function inThreeMode() {
    return { body: { classList: { contains: name => name === 'three-mode-active' } } };
}

function key(keyName) {
    return { key: keyName, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), target: { tagName: 'BODY' } };
}

describe('draft keyboard handlers in 3D', () => {
    it('does not cancel an active site draft on Escape', () => {
        const cancel = vi.fn();
        const leavePlots = vi.fn();
        const state = { phase: 'drawing', ring: [[1, 2]] };
        const handler = new Function(
            'doc', 'isActive', 'win', 'state', 'leavePlots', 'cancel', 'finishDrawing', 'renderLayers', 'renderPanel',
            `${between(sources.site, 'function onKeyDown(event)', '\n    function wireMap')}; return onKeyDown;`
        )({ body: { classList: { contains: () => true } } }, () => true, {}, state,
            leavePlots, cancel, vi.fn(), vi.fn(), vi.fn());
        const event = key('Escape');

        handler(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(leavePlots).not.toHaveBeenCalled();
        expect(state.ring).toHaveLength(1);
    });

    it('does not cancel station placement on Escape', () => {
        const cancel = vi.fn();
        const assignment = between(sources.transit, 'placement.onKey = event => {', '\n        };');
        const arrow = `${assignment.slice(assignment.indexOf('=') + 1)} }`.replaceAll('global.document', 'globalObject.document');
        const handler = new Function('globalObject', 'placement', 'cancelTransitStationPlacement', 'commitPlacement',
            `return (${arrow});`)(
            { document: inThreeMode() }, {}, cancel, vi.fn());
        const event = key('Escape');

        handler(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
    });

    it('does not cancel either freehand or plan-based area drawing on Escape', () => {
        for (const [source, endMarker] of [[sources.areaDraw, '\n    function addVertexMarker'], [sources.areaPaint, '\n    // --- Map move ---']]) {
            const deactivate = vi.fn();
            const handler = new Function('document', 'active', 'deactivate',
                `${between(source, 'function onKeyDown(e)', endMarker)}; return onKeyDown;`
            )({ body: { classList: { contains: () => true } } }, true, deactivate);
            const event = key('Escape');

            handler(event);

            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(deactivate).not.toHaveBeenCalled();
        }
    });

    it('does not consume road-drawing undo or finish keys in 3D', () => {
        const undo = vi.fn();
        const finish = vi.fn();
        const handleRoadKeydown = new Function(
            'document', 'undoLastRoadSegment', 'finishRoadDrawing', 'exitRoadDrawingMode', 'cancelActiveRoadStroke',
            'updateStatus', 'translateRoadText', 'hasDrawableCorridor', 'roadFinalizationGate',
            'roadSegmentPlacementInProgress', 'roadHasStarted',
            `${between(sources.road, 'function handleRoadKeydown(e)', '\nfunction handleRoadDrawHotkey')}; return handleRoadKeydown;`
        )(inThreeMode(), undo, finish, vi.fn(), vi.fn(), vi.fn(), (_key, fallback) => fallback,
            () => true, { isRunning: () => false }, false, false);
        const event = key('u');

        handleRoadKeydown(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(undo).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
    });

    it('does not start the road-drawing shortcut in 3D', () => {
        const requestRoadDrawTool = vi.fn();
        const handler = new Function(
            'document', 'isEditableTarget', 'isAnyModalOpen', 'toggleBuildingReferenceLayers',
            'toggleRoadDrawTool', 'requestRoadDrawTool',
            `${between(sources.road, 'function handleRoadDrawHotkey(event)', '\nfunction attachRoadDrawHotkey')}; return handleRoadDrawHotkey;`
        )(inThreeMode(), () => false, () => false, vi.fn(), vi.fn(), requestRoadDrawTool);
        const event = key('r');

        handler(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(requestRoadDrawTool).not.toHaveBeenCalled();
    });
});
