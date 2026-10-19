// Contract for what the drawing tool does to the map around it: entering it clears whatever was
// selected, and an edge whose placement is being decided stays drawn at its real width until the
// click resolves. Both are wiring, so they are driven through the real road-drawing.js loaded into
// the fake browser world (helpers/road-drawing-env.js): what reached the selection collaborators,
// and which layer is on the map while the click is still being placed.
import { describe, expect, it, afterEach } from 'vitest';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

function spy(impl) {
    const fn = (...args) => { fn.calls.push(args); return impl ? impl(...args) : undefined; };
    fn.calls = [];
    return fn;
}

// A map with something selected everywhere: a proposal, its painted parcels, the "At this spot"
// stack, a single parcel with its panel, and a multi-selection.
function loadWithSelections(globals = {}) {
    const selection = {
        clearProposalHighlights: spy(),
        __drillUi: { hidePanel: spy() },
        multiParcelSelection: { isActive: false, clearSelection: spy() },
        selectedParcelId: 'HR-9',
        currentParcel: { id: 'HR-9' },
        ...globals
    };
    env = loadRoadDrawing({ globals: selection });
    ['proposal-details-panel', 'parcel-info-panel', 'block-info-panel']
        .forEach(id => env.element(id).classList.add('visible'));
    return selection;
}

function expectSelectionsCleared(selection) {
    expect(globalThis.ProposalSelection.clear.calls.length).toBeGreaterThan(0);   // the proposal itself
    expect(selection.clearProposalHighlights.calls.length).toBeGreaterThan(0);    // and its painted parcels
    expect(selection.__drillUi.hidePanel.calls.length).toBeGreaterThan(0);        // "At this spot"
    expect(globalThis.selectedParcelId).toBeNull();                               // the single parcel
    expect(globalThis.currentParcel).toBeNull();
    expect(env.element('parcel-info-panel').classList.contains('visible')).toBe(false);
    expect(env.element('proposal-details-panel').classList.contains('visible')).toBe(false);
    expect(selection.multiParcelSelection.clearSelection.calls).toHaveLength(1);
}

describe('entering the drawing tool', () => {
    it('clears the map selections before drawing starts', async () => {
        const selection = loadWithSelections();
        await env.api.requestCorridorDrawingTool('road');
        expect(env.session.roadDrawingMode).toBe(true);
        expectSelectionsCleared(selection);
    });

    it('drops the proposal, the parcel, the stack panel and the multi-selection', () => {
        const selection = loadWithSelections();
        env.api.clearMapSelectionsForDrawing();
        expectSelectionsCleared(selection);
    });
});

describe('an edge under decision', () => {
    // A click whose footprints are still loading: the test releases them.
    function loadWithSlowFootprints(globals = {}) {
        const loads = [];
        env = loadRoadDrawing({
            globals: {
                ensureBuildingFootprintsForBounds: bounds => new Promise(resolve => {
                    loads.push({ bounds, pending: env.session.roadPendingSegmentLayer, release: resolve });
                }),
                ...globals
            }
        });
        return loads;
    }

    // Opening the tool loads the viewport's footprints too; the edge's own load is the one the
    // second click starts. Returns that load and the click still being placed.
    async function placeSecondPoint(loads) {
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        const before = loads.length;
        const placing = env.click(at(100, 0));
        while (loads.length <= before) await new Promise(resolve => setTimeout(resolve, 0));
        return { placing, edgeLoad: loads[before] };
    }
    const releaseAll = loads => loads.forEach(load => load.release());

    // This was "is drawn at its real width before any placement dialog opens": a click used to ask
    // about the buildings, plots, parks and crossings of its edge right there. Since road-editor.md
    // decision 5 a click only FINDS them (they are reviewed once at Finish), so the band now covers
    // the async part of the placement: it is up before the footprint preload starts.
    it('is drawn at its real width before its footprints load and its obstacles are found', async () => {
        const loads = loadWithSlowFootprints();
        const { placing, edgeLoad } = await placeSecondPoint(loads);
        const band = edgeLoad.pending;
        expect(band).not.toBeNull();
        expect(env.map.hasLayer(band)).toBe(true);
        // 100 m at the road's 7.5 m: 750 m² of band.
        const area = env.api.calculatePolygonAreaMeters(band.latlngs);
        expect(area).toBeGreaterThan(700);
        expect(area).toBeLessThan(800);
        releaseAll(loads);
        await placing;
    });

    it('opens no dialog: what the edge runs into is recorded for the Finish review', async () => {
        const building = { type: 'Feature', properties: { id: 'b1' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } };
        const dialogs = {
            resolvePedestrianRoadCrossings: spy(async () => true),
            resolvePlotCrossings: spy(async () => true),
            resolveBuildingObstacles: spy(async () => ({ action: 'surface' })),
            resolveStructureCrossings: spy(async () => true),
            showStyledChoice: spy(async () => 'keep'),
            clipCorridorEdgeThroughBuildings: spy(() => null)
        };
        env = loadRoadDrawing({
            globals: { detectLoadedBuildingTunnelIntersections: () => [{ id: 'b1', feature: building }], ...dialogs }
        });
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await env.click(at(100, 0));
        expect(env.session.roadEdgeConflicts.size).toBe(1);
        expect([...env.session.roadEdgeConflicts.values()][0].buildings.map(hit => hit.id)).toEqual(['b1']);
        Object.entries(dialogs).forEach(([name, dialog]) => expect(dialog.calls, name).toEqual([]));
    });

    it('is taken down however the click ends — committed, refused or thrown', async () => {
        // Committed: the edge became road, the band went.
        let loads = loadWithSlowFootprints();
        let { placing } = await placeSecondPoint(loads);
        releaseAll(loads);
        await placing;
        expect(env.session.roadSegments[0]).toHaveLength(2);
        expect(env.session.roadPendingSegmentLayer).toBeNull();
        expect(env.layersOfKind('polygon')).toHaveLength(1);   // the road's land, no band beside it
        env.dispose();

        // Refused: the pen was lifted while the footprints loaded, so the click is dropped.
        loads = loadWithSlowFootprints();
        ({ placing } = await placeSecondPoint(loads));
        env.session.roadHasStarted = false;
        releaseAll(loads);
        await placing;
        expect(env.session.roadSegments[0]).toHaveLength(1);
        expect(env.session.roadPendingSegmentLayer).toBeNull();
        expect(env.layersOfKind('polygon')).toHaveLength(0);
        env.dispose();

        // Thrown: finding the obstacles fails after the band went up.
        env = loadRoadDrawing({ globals: { detectPedestrianRoadCrossings: () => { throw new Error('detector down'); } } });
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await expect(env.click(at(100, 0))).rejects.toThrow('detector down');
        expect(env.session.roadPendingSegmentLayer).toBeNull();
        expect(env.layersOfKind('polygon')).toHaveLength(0);
        // The placement gate is released too, so the next click is taken.
        expect(env.session.roadSegmentPlacementInProgress).toBe(false);
        expect(env.session.roadSegmentPlacement).toBeNull();
    });

    it('cannot swallow a click meant for the map or the dialog', async () => {
        const loads = loadWithSlowFootprints();
        const { placing, edgeLoad } = await placeSecondPoint(loads);
        expect(edgeLoad.pending.options.interactive).toBe(false);
        releaseAll(loads);
        await placing;
    });
});
