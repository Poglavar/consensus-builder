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
        expect(drawingSource).toContain('return roadFinalizationGate.run(finishRoadDrawingOnce);');
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

    it('resolves changed-width impacts when the cross-section edit is applied', () => {
        const validation = sourceSection(
            drawingSource,
            'async function validateRoadDrawingProfileImpacts()',
            '// Locked parcels tracking'
        );
        expect(validation).toContain('ensureBuildingTunnelsForSegments(');
        expect(validation).toContain('{ promptForMissing: true }');
        expect(editorSource).toContain('await window.validateRoadDrawingProfileImpacts();');
    });

    it('does not allow F to race a segment whose placement check is still running', () => {
        expect(drawingSource).toContain('roadSegmentPlacementInProgress = true;');
        expect(drawingSource).toContain('roadSegmentPlacementInProgress = false;');
        expect(drawingSource).toContain("updateStatus('Wait for the current segment to finish validating.');");
    });

    it('drops stale tunnel edges before a moved road derives already-tunnelled buildings', () => {
        const edit = sourceSection(
            drawingSource,
            'async function runLocalCorridorGeometryUpdate',
            '// Merge-on-connect works on drags too'
        );
        const reconcile = edit.indexOf('definition.tunnels = retainLiveCorridorTunnelRecords(');
        const deriveTunnelEdgeKeys = edit.indexOf('const tunnelEdgeKeys = new Set();');
        expect(reconcile).toBeGreaterThanOrEqual(0);
        expect(deriveTunnelEdgeKeys).toBeGreaterThan(reconcile);
        // The tunnelled-building set must come from the PRE-EDIT snapshot. retainLiveCorridorTunnelRecords
        // has already dropped the record whose edge key the drag changed, so `definition.tunnels` is empty
        // exactly when the building is still tunnelled — deriving from it re-prompts and re-splices portals.
        // (This used to be a blanket ban on the `(record?.buildingIds || []).forEach` idiom, which the
        // correct snapshot-based derivation also uses, so it failed on the very fix it was guarding.)
        const alreadyTunnelled = sourceSection(
            edit,
            'const alreadyTunnelledIds = new Set();',
            '(definition.demolishedBuildings || []).forEach'
        );
        expect(alreadyTunnelled).toContain('(definitionSnapshot.tunnels || []).forEach');
        expect(alreadyTunnelled).not.toContain('(definition.tunnels');
        expect(edit).toContain('.filter(hit => !fullyDemolishedIds.has(String(hit.id)))');
    });
});
