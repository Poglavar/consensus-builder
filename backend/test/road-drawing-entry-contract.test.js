// Contract for what the drawing tool does to the map around it: entering it clears whatever was
// selected, and an edge whose placement is being decided stays drawn at its real width until the
// click resolves. Both are invisible in unit terms — they are wiring — so they are asserted at the
// source, where deleting the wiring is what makes them fail.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const drawingSource = readFileSync(new URL('../../frontend/js/road-drawing.js', import.meta.url), 'utf8');

function sourceSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('entering the drawing tool', () => {
    it('clears the map selections before drawing starts', () => {
        const enter = sourceSection(drawingSource, 'function toggleRoadDrawTool()', 'function isAnyModalOpen');
        expect(enter).toContain('clearMapSelectionsForDrawing();');
    });

    it('drops the proposal, the parcel, the stack panel and the multi-selection', () => {
        const clearer = sourceSection(
            drawingSource,
            'function clearMapSelectionsForDrawing()',
            'function disableMultiSelectForDrawing'
        );
        expect(clearer).toContain('ProposalSelection?.clear?.()');       // the proposal itself
        expect(clearer).toContain('clearProposalHighlights');            // and its painted parcels
        expect(clearer).toContain('__drillUi?.hidePanel?.()');           // "At this spot"
        expect(clearer).toContain('window.selectedParcelId = null;');    // the single parcel
        expect(clearer).toContain("'parcel-info-panel'");
        expect(clearer).toContain('multiParcelSelection.clearSelection()');
    });
});

describe('an edge under decision', () => {
    // Between computing the edge's footprint and the first dialog, nothing else may happen: the
    // whole point is that the band is up BEFORE the user is asked about it.
    it('is drawn at its real width before any placement dialog opens', () => {
        const decision = sourceSection(
            drawingSource,
            'const segmentPolygon = calculateRoadPolygon(segmentPoints, activeSegmentWidth);',
            'await resolvePedestrianRoadCrossings('
        );
        expect(decision).toContain('showPendingRoadSegment(segmentPolygon);');
    });

    it('is taken down however the click ends — committed, refused or thrown', () => {
        const click = sourceSection(
            drawingSource,
            'async function handleRoadClick(e)',
            '// Handle road mouse movement for preview'
        );
        // In the placement gate's own finally, so no early return can leave the band behind.
        const released = click.indexOf('roadSegmentPlacementInProgress = false;');
        const cleared = click.indexOf('clearPendingRoadSegment();');
        expect(released).toBeGreaterThan(0);
        expect(cleared).toBeGreaterThan(released);
    });

    it('cannot swallow a click meant for the map or the dialog', () => {
        const layer = sourceSection(drawingSource, 'function showPendingRoadSegment(', 'function clearPendingRoadSegment(');
        expect(layer).toContain('interactive: false');
    });
});
