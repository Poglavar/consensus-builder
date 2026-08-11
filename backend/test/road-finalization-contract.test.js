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

    it('edits the road IN PLACE and derives only the ground it touched', () => {
        const edit = sourceSection(
            drawingSource,
            'async function runLocalCorridorGeometryUpdate',
            '// ---------------------------------------------------------------------------\n// Snapping'
        );
        // Nothing local is immutable. An edit used to clone the road into a NEW record with its
        // identity deleted so "the published source stays immutable" — which bought a new proposal
        // id per node drag and an editor that reasoned about provenance. The record keeps its id
        // and is written through; only its pointers to the copies held elsewhere are dropped.
        expect(edit).toContain('writeRoadDefinition(sourceProposal, componentDefinitions[0])');
        expect(edit).toContain('detachPublishedIdentity(sourceProposal)');
        expect(edit).not.toContain('makeFreshRoadSnapshot(sourceProposal, componentDefinitions[0]');
        expect(edit).toContain('setProposalApplied(sourceProposal, false');
        // An edit is a park plus a create: the old position releases its ground, each replacement
        // derives the parcels under its own footprint. It must NEVER reach for the whole plan —
        // that is what made editing a road cost the same as reloading the map.
        expect(edit).toContain('ProposalManager._undoProposalPayload?.(sourceProposal)');
        expect(edit).toContain('ProposalManager.deriveForNewProposal(stored, {');
        // The edited road re-derives under its own id, not under a replacement's.
        expect(edit).toContain('for (const id of [sourceKey, ...extraStretchIds])');
        expect(edit).not.toContain('rebuildAppliedFabric');
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

    it('serializes the record flip with replay and undoes a failed edit completely', () => {
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
        // A failed edit leaves nothing behind: every split-off stretch comes off the map and out of
        // storage, and the road itself goes back to the shape AND the identity it had.
        expect(edit).toContain('extraStretchIds.forEach(id => {');
        expect(edit).toContain('proposalStorage.removeProposal(id);');
        expect(edit).toContain('ProposalManager._releaseUnappliedRecord?.(stored)');
        expect(edit).toContain('writeRoadDefinition(sourceProposal, originalDefinition)');
        expect(edit).toContain('restorePublishedIdentity(sourceProposal, publishedIdentity)');
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
