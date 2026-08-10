// Integration contract for drawing completion: segment/profile edits own obstacle choices, while F
// is a single-flight pen-up action and cannot invoke cut/demolish/tunnel discovery of its own.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const drawingSource = readFileSync(new URL('../../frontend/js/road-drawing.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../../frontend/js/corridor-editor.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

function sourceSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('road drawing finalization contract', () => {
    it('loads the finalization gate before the drawing script', () => {
        expect(indexSource.indexOf("'js/road-finalization-state.js'")).toBeGreaterThanOrEqual(0);
        expect(indexSource.indexOf("'js/road-finalization-state.js'"))
            .toBeLessThan(indexSource.indexOf("'js/road-drawing-loader.js'"));
    });

    it('ignores key repeat and funnels every finish trigger through one gate', () => {
        expect(drawingSource).toContain('if (e.repeat || roadFinalizationGate.isRunning() || roadSegmentPlacementInProgress) return;');
        // The gate is claimed in exactly one place, and the finalization body is reachable only from
        // inside it. Asserted as the relationship rather than as one line of source, because the
        // wrapper around it grew a spinner and a busy pointer without weakening any of that.
        expect(drawingSource.match(/roadFinalizationGate\.run\(/g)).toHaveLength(1);
        const calls = drawingSource.match(/finishRoadDrawingOnce\(/g) || [];
        expect(calls).toHaveLength(2);  // the declaration and the single call
        const wrapper = sourceSection(drawingSource, 'function finishRoadDrawing()', '\n}');
        expect(wrapper).toContain('roadFinalizationGate.run(');
        expect(wrapper).toContain('finishRoadDrawingOnce()');
    });

    it('does not discover or prompt for building impacts while handling F', () => {
        const finish = sourceSection(
            drawingSource,
            'async function finishRoadDrawingOnce()',
            '// Closing the drawing tool'
        );
        expect(finish).not.toContain('ensureBuildingTunnelsForSegments(');
        expect(finish).not.toContain('resolveBuildingObstacles(');
        expect(finish).not.toContain('showStyledChoice(');
    });

    it('commits changed-width authored tunnels without running demolition scans', () => {
        const validation = sourceSection(
            drawingSource,
            'async function validateRoadDrawingProfileImpacts()',
            '// Locked parcels tracking'
        );
        expect(validation).toContain('ensureBuildingTunnelsForSegments(');
        expect(validation).not.toContain('resolveBuildingObstacles(');
        expect(validation).not.toContain('demolishedBuildings');
        expect(editorSource).toContain('await window.validateRoadDrawingProfileImpacts();');
    });

    it('does not allow F to race a segment whose placement check is still running', () => {
        expect(drawingSource).toContain('roadSegmentPlacementInProgress = true;');
        expect(drawingSource).toContain('roadSegmentPlacementInProgress = false;');
        expect(drawingSource).toContain("updateStatus('Wait for the current segment to finish validating.');");
    });

    it('turns a geometry edit into a fresh snapshot and one canonical replay', () => {
        const edit = sourceSection(
            drawingSource,
            'async function runLocalCorridorGeometryUpdate',
            '// ---------------------------------------------------------------------------\n// Snapping'
        );
        expect(edit).toContain('makeFreshRoadSnapshot(sourceProposal, definition');
        expect(edit).toContain('proposalStorage.addProposal(replacement)');
        expect(edit).toContain('setProposalApplied(sourceProposal, false');
        expect(edit).toContain('ProposalManager.rebuildAppliedFabric({ _fabricQueue: options._fabricQueue === true })');
        // Ruling 2026-08-07: an authored disconnect SPLITS into one proposal per connected
        // component — via the tested pure engine, with per-stretch metadata carried, still
        // inside the same single transaction and single replay.
        expect(edit).toContain('corridorComponents');
        expect(edit).toContain('componentDefinitions');
        expect(edit).not.toContain('unapplyProposal(');
        expect(edit).not.toContain('createRoadProposalFromComponent');
        expect(edit).not.toContain('corridorConnectedComponents');
        expect(edit).not.toContain('weldNearbyVertices');
        expect(edit).not.toContain('healNearMissJunctions');
        expect(edit).not.toContain('demolishedBuildings');
        expect(edit).not.toContain('resolveBuildingObstacles(');
    });

    it('serializes the record flip with replay and deletes a failed replacement record', () => {
        const wrapper = sourceSection(
            drawingSource,
            'async function updateLocalCorridorGeometry',
            'async function runLocalCorridorGeometryUpdate'
        );
        const edit = sourceSection(
            drawingSource,
            'async function runLocalCorridorGeometryUpdate',
            '// ---------------------------------------------------------------------------\n// Snapping'
        );

        expect(wrapper).toContain('ProposalManager._enqueueFabricChange');
        expect(wrapper).toContain('proposalStorage.beginBatch()');
        expect(wrapper).toContain('proposalStorage.endBatch()');
        // A failed replay deletes EVERY minted replacement (a split mints several).
        expect(edit).toContain('replacementIds.forEach(id => { try { proposalStorage.removeProposal(id); }');
        expect(edit).toContain('_fabricQueue: options._fabricQueue === true');
    });

    it('never strips click handlers from the live parcel tessellation while drawing', () => {
        const toggle = sourceSection(
            drawingSource,
            'function toggleRoadDrawTool()',
            'function handleRoadKeydown(e)'
        );

        expect(toggle).not.toContain("layer.off('click')");
        expect(drawingSource).not.toContain('restoreParcelClickInteractivity');
        expect(drawingSource).toContain('click-time drawing-mode guard');
    });
});
