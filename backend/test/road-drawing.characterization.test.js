// Characterization of the corridor drawing tool (frontend/js/road-drawing.js) end to end: the real
// file is required into a fake browser world (helpers/road-drawing-env.js) and driven the way a user
// drives it — open the tool, click points, undo, lift the pen, snap, finish, edit a saved road — with
// the observable effects asserted: session state, layers on the map, panel text, status lines, and
// what reached the collaborators (draft store, proposal store, parcel mutation).
import { describe, it, expect, afterEach } from 'vitest';
import { loadRoadDrawing, at, boxRing } from './helpers/road-drawing-env.js';

let env = null;
function open(options) {
    env = loadRoadDrawing(options);
    return env;
}
afterEach(() => {
    env?.dispose();
    env = null;
});

const near = (a, b, eps = 1e-9) => Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps;

// One parcel straddling the x axis from 20 m to 60 m east, so an eastward road along y = 0 crosses it.
const PARCEL_ON_ROUTE = { id: 'HR-1', ring: boxRing(20, -15, 60, 15), properties: { BROJ_CESTICE: '1', calculatedArea: 1200, ownershipType: 'company', estimatedMarketPrice: 5000, estimatedMarketPriceCurrency: 'EUR' } };
const PARCEL_OFF_ROUTE = { id: 'HR-2', ring: boxRing(20, 200, 60, 240), properties: { calculatedArea: 1600 } };

async function openTool(world) {
    await world.api.requestCorridorDrawingTool('road');
    expect(world.session.roadDrawingMode).toBe(true);
}

describe('loading', () => {
    it('loads in node and keeps the globals other scripts and inline handlers call', () => {
        const world = open();
        [
            'requestRoadDrawTool', 'requestTrackDrawTool', 'seedRoadDrawing', 'setRoadDrawingProfile',
            'getRoadDrawingProfile', 'validateRoadDrawingProfileImpacts', 'updateLocalCorridorGeometry',
            'isCorridorApplyInFlight', 'startSeededCorridorDrawing', 'isParcelLockedForRoadDrawing',
            'buildCorridorAcquisitionPolygon', 'corridorSurfaceFootprintForDefinition', 'beginApplyIndicator',
            'endApplyIndicator', 'toggleBuildingReferenceLayers', 'setBuildingReferenceLayers',
            'toggleRoadInfoPanelMinimized', 'showAcquiringDifficultyDialog'
        ].forEach(name => expect(typeof globalThis[name], name).toBe('function'));
        expect(globalThis.__roadDrawing).toBe(world.api);
        // The session is a live view: setting it is setting the tool's own variable.
        world.session.roadWidth = 11;
        expect(world.api.roadDrawingWidthForSegmentIndex(0)).toBe(11);
    });

    it('attaches the R hotkey at load: R opens the tool, typing in a field or an open modal does not', async () => {
        const world = open();
        world.key('r', { tagName: 'INPUT' });
        world.document.body.classList.add('modal-open');
        world.key('r');
        await world.idle();
        expect(world.session.roadDrawingMode).toBe(false);
        world.document.body.classList.remove('modal-open');
        const event = world.key('R');
        expect(event.defaultPrevented).toBe(true);
        await world.idle();
        expect(world.session.roadDrawingMode).toBe(true);
    });
});

describe('start and stop guards', () => {
    it('refuses to start in 3D, under another editor, under an edit lock or a pending 3D switch', () => {
        const world = open();
        const can = () => world.api.canStartRoadDrawingInCurrentMode();
        expect(can()).toBe(true);
        globalThis.__mapModeState = { desired: '3d' };
        expect(can()).toBe(false);
        globalThis.__mapModeState = { desired: '2d' };
        globalThis.OnMapEditor = { isActive: () => true };
        expect(can()).toBe(false);
        delete globalThis.OnMapEditor;
        globalThis.__mapEditLock = { isHeld: () => true };
        expect(can()).toBe(false);
        delete globalThis.__mapEditLock;
        globalThis.__pending3DMode = true;
        expect(can()).toBe(false);
        delete globalThis.__pending3DMode;
        world.document.body.classList.add('three-mode-active');
        expect(can()).toBe(false);
        world.document.body.classList.remove('three-mode-active');
        expect(can()).toBe(true);
    });

    it('opening the tool takes the map: mode flag, announcement, handlers, held dblclick zoom, panel', async () => {
        const world = open();
        globalThis.PersistentStorage.setItem('lastRoadWidth', '12');
        await openTool(world);

        expect(globalThis.roadDrawingMode).toBe(true);
        const announced = world.document.events.filter(event => event.type === 'corridor-drawing-mode-changed');
        expect(announced.at(-1).detail).toEqual({ road: true, kind: 'road' });
        ['click', 'dblclick', 'mousemove', 'mouseout', 'moveend'].forEach(type => expect(world.map.listens(type), type).toBe(true));
        expect(world.map.doubleClickZoom.enabled()).toBe(false);
        expect(world.element('road-info-panel').classList.contains('visible')).toBe(true);
        expect(world.element('road-drawing-controls').hidden).toBe(false);
        expect(world.element('roadDrawButton').getAttribute('aria-pressed')).toBe('true');
        expect(world.map.getContainer().classList.contains('crosshairs-cursor')).toBe(true);
        // The last-used road width seeds the cross-section.
        expect(world.session.roadWidth).toBe(12);
        expect(globalThis.corridorProfileWidth(world.session.roadProfile)).toBe(12);
        expect(world.lastStatus()).toBe('Click on the map to start drawing a road');

        // Closing an empty tool gives everything back as it was.
        await world.api.cancelRoadDrawing();
        expect(world.session.roadDrawingMode).toBe(false);
        expect(globalThis.roadDrawingMode).toBe(false);
        ['click', 'dblclick', 'mousemove', 'mouseout', 'moveend'].forEach(type => expect(world.map.listens(type), type).toBe(false));
        expect(world.map.doubleClickZoom.enabled()).toBe(true);
        expect(world.element('road-info-panel').classList.contains('visible')).toBe(false);
        expect(world.element('roadDrawButton').getAttribute('aria-pressed')).toBe('false');
        expect(world.document.listeners('keydown')).toEqual([world.api.handleRoadDrawHotkey]);
    });

    it('does not open in 3D: nothing is attached', async () => {
        const world = open();
        globalThis.__mapModeState = { desired: '3d' };
        expect(await world.api.requestCorridorDrawingTool('road')).toBe(false);
        expect(world.session.roadDrawingMode).toBe(false);
        expect(world.map.listens('click')).toBe(false);
    });

    it('a track opens on one standard-gauge rail lane and its speed limits', async () => {
        const world = open();
        await world.api.requestCorridorDrawingTool('track');
        await world.idle();
        expect(world.session.roadDrawingMode).toBe(true);
        expect(world.api.corridorDrawingIsTrack()).toBe(true);
        expect(world.session.roadSidewalkWidth).toBe(0);
        // No speed modal in this DOM: the picker falls back to 50 km/h / 300 m.
        expect(world.session.trackSpeed).toBe(50);
        expect(world.session.trackMinCurvatureRadius).toBe(300);
        expect(world.element('trackDrawButton').getAttribute('aria-pressed')).toBe('true');
    });
});

describe('click, undo, lift the pen', () => {
    it('two clicks make one segment: centre line, land, locked parcels and panel figures', async () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE, PARCEL_OFF_ROUTE] });
        await openTool(world);
        await world.click(at(0, 0));
        expect(world.session.roadHasStarted).toBe(true);
        expect(world.session.roadSegments).toHaveLength(1);
        expect(world.lastStatus()).toMatch(/^Click to add road points/);
        await world.click(at(100, 0));

        const { roadSegments, roadSegmentIds, roadPoints } = world.session;
        expect(roadSegments).toHaveLength(1);
        expect(roadSegments[0]).toHaveLength(2);
        expect(roadPoints).toBe(roadSegments[0]);
        expect(roadSegmentIds).toEqual(['s1']);
        expect(world.layersOfKind('polyline')).toHaveLength(1);
        const land = world.layersOfKind('polygon');
        expect(land).toHaveLength(1);
        expect(world.session.roadPolygon).toBe(land[0].latlngs);
        expect(world.layersOfKind('circleMarker')).toHaveLength(2);

        // The parcel under the road is locked and counted; the one 200 m north is not.
        expect(globalThis.isParcelLockedForRoadDrawing('HR-1')).toBe(true);
        expect(globalThis.isParcelLockedForRoadDrawing('HR-2')).toBe(false);
        expect(world.presenterLayers.get('HR-1').options.fillColor).toBe('green');
        expect(world.element('road-parcels-count').textContent).toBe('1');
        expect(world.element('road-owned-companies').textContent).toBe('1');
        expect(world.element('road-length').textContent).toBe(globalThis.CbFormat.formatLength(world.api.polylineLengthMeters(roadSegments[0])));
        // 100 m at 7.5 m is 750 m² of land (the ends are square).
        expect(world.session.committedRoadMetrics.area).toBeGreaterThan(700);
        expect(world.session.committedRoadMetrics.area).toBeLessThan(800);
        expect(world.element('undoRoadButton').disabled).toBe(false);
    });

    it('U and Ctrl+Z undo one point each; Shift+Ctrl+Z does nothing; the last undo drops the segment', async () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE] });
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        await world.click(at(100, 100));
        expect(world.session.roadPoints).toHaveLength(3);

        world.key('u');
        await world.idle();
        expect(world.session.roadPoints).toHaveLength(2);
        expect(world.session.roadHasStarted).toBe(true);

        const redo = world.key('z', { ctrlKey: true, shiftKey: true });
        expect(redo.defaultPrevented).toBe(true);
        await world.idle();
        expect(world.session.roadPoints).toHaveLength(2);

        world.key('z', { metaKey: true });
        await world.idle();
        expect(world.session.roadPoints).toHaveLength(1);
        // One point is no land: the polygon and the locked parcel go with the edge.
        expect(world.layersOfKind('polygon')).toHaveLength(0);
        expect(globalThis.isParcelLockedForRoadDrawing('HR-1')).toBe(false);

        world.key('U');
        await world.idle();
        expect(world.session.roadSegments).toEqual([]);
        expect(world.session.roadSegmentIds).toEqual([]);
        expect(world.session.roadHasStarted).toBe(false);
        expect(world.element('undoRoadButton').disabled).toBe(true);
        expect(world.lastStatus()).toBe('Click on the map to start drawing a road');
    });

    it('Escape lifts the pen and keeps the points; a click elsewhere starts a second segment', async () => {
        const world = open();
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        world.key('Escape');
        await world.idle();
        expect(world.session.roadHasStarted).toBe(false);
        expect(world.session.roadSegments[0]).toHaveLength(2);
        expect(world.lastStatus()).toMatch(/^Pen lifted/);

        await world.click(at(0, 100));
        await world.click(at(100, 100));
        expect(world.session.roadSegments).toHaveLength(2);
        expect(world.session.roadSegmentIds).toEqual(['s1', 's2']);
        expect(world.api.getAllRoadSegments(true)).toHaveLength(2);
    });

    it('Escape with the pen up asks: Keep drawing keeps everything, Discard closes the tool and resets it', async () => {
        const world = open();
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        world.key('Escape');
        await world.idle();

        world.key('Escape');
        await world.idle();
        expect(globalThis.showStyledChoice.calls).toHaveLength(1);
        expect(globalThis.showStyledChoice.calls[0][0]).toBe('This road has not been built yet. Build it, or discard the drawing?');
        expect(world.session.roadDrawingMode).toBe(true);
        expect(world.session.roadSegments[0]).toHaveLength(2);

        globalThis.showStyledChoice = async () => 'discard';
        world.key('Escape');
        await world.idle();
        await world.idle();
        expect(world.session.roadDrawingMode).toBe(false);
        expect(world.session.roadSegments).toEqual([]);
        expect(world.map.layers.size).toBe(0);
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
    });

    it('Escape on a lone click drops it; Escape on an empty tool closes it', async () => {
        const world = open();
        await openTool(world);
        await world.click(at(0, 0));
        world.key('Escape');
        await world.idle();
        expect(world.session.roadSegments).toEqual([]);
        expect(world.session.roadDrawingMode).toBe(true);
        world.key('Escape');
        await world.idle();
        expect(world.session.roadDrawingMode).toBe(false);
    });

    it('the second tap of a double-click adds nothing', async () => {
        const world = open();
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(50, 0), { detail: 2 });
        expect(world.session.roadPoints).toHaveLength(1);
    });

    it('a click while the previous one is still being placed is dropped, and Escape waits for the placement', async () => {
        let releaseFootprints;
        const world = open({
            globals: {
                ensureBuildingFootprintsForBounds: () => new Promise(resolve => { releaseFootprints = resolve; })
            }
        });
        await openTool(world);
        await world.click(at(0, 0));
        const placing = world.click(at(100, 0));
        expect(world.session.roadSegmentPlacementInProgress).toBe(true);
        // The edge under decision is shown at its width while its footprints load.
        expect(world.session.roadPendingSegmentLayer).not.toBeNull();
        await world.click(at(200, 0));
        world.key('Escape');
        expect(world.session.roadHasStarted).toBe(true);   // Escape has not run yet

        releaseFootprints();
        await placing;
        await world.idle();
        expect(world.session.roadSegments[0]).toHaveLength(2);   // the dropped click added nothing
        expect(world.session.roadHasStarted).toBe(false);        // Escape ran after the placement
        expect(world.session.roadPendingSegmentLayer).toBeNull();
    });

    it('a cross-section change waiting to be applied blocks the next click', async () => {
        const world = open();
        await openTool(world);
        await world.click(at(0, 0));
        world.session.roadDrawingProfileValidationPending = true;
        await world.click(at(100, 0));
        expect(world.session.roadPoints).toHaveLength(1);
        expect(world.lastStatus()).toBe('Apply or cancel the cross-section change before drawing another segment.');
    });
});

describe('snapping', () => {
    async function drawEastward(world) {
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        world.key('Escape');
        await world.idle();
    }

    it('a click on a segment end with the pen up continues that segment, not a new one', async () => {
        const world = open();
        await drawEastward(world);
        await world.click(at(103, 4));   // 5 m from the end: inside the 12 px snap ring
        expect(world.session.roadHasStarted).toBe(true);
        expect(world.session.roadPoints).toBe(world.session.roadSegments[0]);
        expect(world.lastStatus()).toMatch(/^Continuing this segment/);
        await world.click(at(100, 100));
        expect(world.session.roadSegments).toHaveLength(1);
        expect(world.session.roadSegments[0]).toHaveLength(3);
        expect(world.session.roadSegmentIds).toEqual(['s1']);
    });

    it('continuing from the first vertex reverses the segment so drawing appends to it', async () => {
        const world = open();
        await drawEastward(world);
        await world.click(at(-3, 2));
        await world.click(at(-100, 0));
        const [segment] = world.session.roadSegments;
        expect(segment).toHaveLength(3);
        expect(near(segment[0], at(100, 0))).toBe(true);
        expect(near(segment[1], at(0, 0))).toBe(true);
    });

    it('a click near the middle of an edge inserts a shared node there and starts a branch from it (a T)', async () => {
        const world = open();
        await drawEastward(world);
        await world.click(at(50, 5));
        await world.click(at(50, 100));
        const [main, branch] = world.session.roadSegments;
        expect(main).toHaveLength(3);
        expect(main[1].lat).toBeCloseTo(at(0, 0).lat, 12);   // the node lies ON the edge
        expect(main[1].lng).toBeCloseTo(at(50, 0).lng, 6);
        expect(near(branch[0], main[1])).toBe(true);
        expect(world.session.roadSegmentIds).toEqual(['s1', 's2']);
    });

    it('Alt places the point exactly where the pointer is', async () => {
        const world = open();
        await drawEastward(world);
        await world.click(at(103, 4), { altKey: true });
        expect(world.session.roadSegments).toHaveLength(2);
        expect(near(world.session.roadPoints[0], at(103, 4))).toBe(true);
    });

    it('a click near an applied road lands exactly on its centre line', async () => {
        const applied = {
            proposalId: 'road-applied', applied: true,
            roadProposal: { definition: { points: [[at(-50, 30), at(150, 30)]], segmentIds: ['s1'], width: 7.5 } }
        };
        const world = open({ proposals: [applied] });
        await openTool(world);
        await world.click(at(40, 26));
        expect(world.session.roadPoints[0].lat).toBeCloseTo(at(0, 30).lat, 12);
        expect(world.session.roadPoints[0].lng).toBeCloseTo(at(40, 30).lng, 6);
    });

    it('mousemove shows where the click would snap and, with the pen down, the rubber band', async () => {
        const applied = {
            proposalId: 'road-applied', applied: true,
            roadProposal: { definition: { points: [[at(-50, 30), at(150, 30)]], segmentIds: ['s1'], width: 7.5 } }
        };
        const world = open({ proposals: [applied] });
        await openTool(world);
        await world.move(at(10, 27));
        const ring = world.session.roadSnapMarker;
        expect(ring.options.pane).toBe('road-snap');
        expect(ring.options.color).toBe('#2563eb');   // an applied road: the junction ring
        expect(world.map.getPane('road-snap').style.pointerEvents).toBe('none');
        await world.move(at(10, -60));
        expect(world.session.roadSnapMarker).toBeNull();

        await world.click(at(0, -60));
        await world.move(at(80, -60));
        expect(world.session.roadPreviewLine.options.color).toBe('#ff6600');
        expect(world.session.roadPreviewPolygonLayer).not.toBeNull();
        await world.map.fire('mouseout', {});
        expect(world.session.roadPreviewLine).toBeNull();
        expect(world.session.roadPreviewPolygonLayer).toBeNull();
    });
});

describe('land and parcels', () => {
    it('buildRoadUnionPolygonWithWidths needs a frame, skips stubs and gives each segment its own width', () => {
        const world = open();
        const { api } = world;
        const segments = [[at(0, 0), at(100, 0)], [at(0, 200), at(100, 200)], [at(0, 400)]];
        expect(() => api.buildRoadUnionPolygonWithWidths(segments, [10, 20], 10, ['a', 'b'], null)).toThrow(/metric frame/);
        const frame = globalThis.__metricFrame.frameFor(segments.flat());
        const land = api.buildRoadUnionPolygonWithWidths(segments, [10, 20], 10, ['a', 'b', 'c'], frame);
        const area = api.calculatePolygonAreaMeters(land);
        expect(area).toBeGreaterThan(0.97 * 3000);
        expect(area).toBeLessThan(1.03 * 3000);
        // Without per-segment widths the fallback width serves every segment.
        const even = api.calculatePolygonAreaMeters(api.buildRoadUnionPolygonWithWidths(segments, [], 10, [], frame));
        expect(even).toBeGreaterThan(0.97 * 2000);
        expect(even).toBeLessThan(1.03 * 2000);
    });

    it('collectParcelsIntersectingFootprint returns the ids of the fabric parcels the land touches', () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE, PARCEL_OFF_ROUTE] });
        const footprint = { type: 'Polygon', coordinates: [boxRing(0, -4, 100, 4)] };
        expect(world.api.collectParcelsIntersectingFootprint(footprint)).toEqual(['HR-1']);
        // A bare ring list is taken as a polygon's coordinates.
        expect(world.api.collectParcelsIntersectingFootprint([boxRing(0, 190, 100, 250)])).toEqual(['HR-2']);
        expect(world.api.collectParcelsIntersectingFootprint(null)).toEqual([]);
    });
});

describe('finish', () => {
    async function drawAndFinish(world, finish = () => world.key('f')) {
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        finish();
        await world.idle();
    }

    it('F builds: one draft in the store, one atomic create, the tool closes and the drawing leaves the map', async () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE, PARCEL_OFF_ROUTE] });
        let mapLayersAtCreate = null;
        globalThis.instantCreateProposalFromDraft = Object.assign(async (...args) => {
            globalThis.instantCreateProposalFromDraft.calls.push(args);
            mapLayersAtCreate = world.layersOfKind('polygon').length;
            return 'p-built';
        }, { calls: [] });
        await drawAndFinish(world);

        const creates = globalThis.instantCreateProposalFromDraft.calls;
        expect(creates).toHaveLength(1);
        const [draftId, createOptions] = creates[0];
        expect(createOptions).toEqual({ atomicCorridorAuthoring: true });
        const draft = world.draftStore.getDraft(draftId);
        expect(draft.goal).toBe('road-track');
        expect(draft.editorPayload.definition.segmentIds).toEqual(['s1']);
        expect(draft.editorPayload.definition.points[0]).toHaveLength(2);

        const context = globalThis.pendingRoadDrawingProposal;
        expect(context.parcelIds).toEqual(['HR-1']);
        expect(context.segmentIds).toEqual(['s1']);
        expect(context.width).toBe(7.5);
        expect(context.metadata).toMatchObject({ type: 'road', isTrack: false, isRoad: true, isCorridor: true, source: 'road-drawing' });
        expect(context.polygon.type).toMatch(/Polygon/);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls[0][0]).toBe('corridor');

        // The drawn land stayed on the map while the object was being created (the ghost), then went.
        expect(mapLayersAtCreate).toBe(1);
        expect(world.map.layers.size).toBe(0);
        expect(world.session.roadDrawingMode).toBe(false);
        expect(world.session.corridorApplyIndicatorCount).toBe(0);
        expect(world.document.body.classList.contains('corridor-busy')).toBe(false);
        expect(world.lastStatus()).toBe('Local road draft created — only on this device until you share it. Click it to edit or propose.');
    });

    it('is single-flight: F twice, a double-click and the button share one run and one create', async () => {
        const world = open();
        await drawAndFinish(world, () => {
            const first = world.api.finishRoadDrawing();
            expect(world.api.finishRoadDrawing()).toBe(first);
            world.key('f');
            world.key('Enter');
            world.map.fire('dblclick', {});
            world.api.finishRoadOrTrackDrawing();
            expect(world.session.roadFinalizationGate.isRunning()).toBe(true);
        });
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(1);
        expect(world.session.roadFinalizationGate.isRunning()).toBe(false);
    });

    it('a click during the build is ignored', async () => {
        const world = open();
        let releaseCreate;
        globalThis.instantCreateProposalFromDraft = () => new Promise(resolve => { releaseCreate = resolve; });
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        const finishing = world.api.finishRoadDrawing();
        await world.api.handleRoadClick({ latlng: at(200, 0), originalEvent: { detail: 1, pointerType: 'mouse' } });
        expect(world.session.roadSegments[0] ?? []).not.toContainEqual(expect.objectContaining(at(200, 0)));
        while (!releaseCreate) await new Promise(resolve => setTimeout(resolve, 0));
        releaseCreate('p-1');
        await finishing;
    });

    it('nothing drawable, nothing finished; a pending cross-section change refuses with a reason', async () => {
        const world = open();
        await openTool(world);
        expect(await world.api.finishRoadDrawing()).toBe(false);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        world.session.roadDrawingProfileValidationPending = true;
        expect(await world.api.finishRoadDrawing()).toBe(false);
        expect(world.lastStatus()).toBe('Apply or cancel the cross-section change before finishing the road.');
        expect(world.session.roadDrawingMode).toBe(true);
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
    });

    it('a building in the way is recorded on the click, reviewed once at Finish, and Cancel keeps drawing', async () => {
        const building = { type: 'Feature', properties: { id: 'b1' }, geometry: { type: 'Polygon', coordinates: [boxRing(40, -10, 60, 10)] } };
        const reviews = [];
        const world = open({
            globals: {
                detectLoadedBuildingTunnelIntersections: () => [{ id: 'b1', feature: building }],
                resolveBuildingObstacles: async (hits) => { reviews.push(hits.map(hit => hit.id)); return { action: 'cancel' }; }
            }
        });
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        expect(world.lastStatus()).toBe('1 building in the way — you decide at Finish.');
        const rings = world.session.roadConflictMarkerLayer;
        expect([...rings.children].map(ring => ring.options.className)).toEqual(['road-conflict-marker']);

        world.key('f');
        await world.idle();
        expect(reviews).toEqual([['b1']]);
        expect(world.lastStatus()).toBe('Not built — 1 building in the way. Undo or reroute around the red rings, then finish again.');
        expect(world.session.roadDrawingMode).toBe(true);
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);

        // Undoing the edge takes its obstacle and its ring with it.
        world.key('u');
        await world.idle();
        expect(world.session.roadEdgeConflicts.size).toBe(0);
        expect(world.session.roadConflictMarkerLayer).toBeNull();
    });

    it('answering "tunnel" at Finish builds the road with a tunnel record and portal vertices', async () => {
        const building = { type: 'Feature', properties: { id: 'b1' }, geometry: { type: 'Polygon', coordinates: [boxRing(40, -10, 60, 10)] } };
        const world = open({
            globals: {
                detectLoadedBuildingTunnelIntersections: () => [{ id: 'b1', feature: building }],
                resolveBuildingObstacles: async () => ({ action: 'tunnel' })
            }
        });
        await openTool(world);
        await world.click(at(0, 0));
        await world.click(at(100, 0));
        world.key('f');
        await world.idle();
        const context = globalThis.pendingRoadDrawingProposal;
        expect(context.tunnels).toHaveLength(1);
        expect(context.tunnels[0].buildingIds).toEqual(['b1']);
        expect(context.centerline[0].length).toBeGreaterThan(2);   // portals became vertices
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(1);
    });
});

describe('reopening a saved corridor (seed)', () => {
    it('startSeededCorridorDrawing opens the tool on the corridor: its segments, ids, profile and parcels', async () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE] });
        const profile = globalThis.corridorProfileFromLegacy(10, 2, false);
        const seed = {
            centerline: [[at(0, 0), at(100, 0)], [at(100, 0), at(100, 100)]],
            segmentIds: ['s4', 's7'],
            profile,
            segmentProfiles: { s7: globalThis.corridorProfileFromLegacy(14, 2, false) }
        };
        expect(await world.api.startSeededCorridorDrawing('road', seed, null)).toBe(true);
        expect(world.session.roadDrawingMode).toBe(true);
        expect(world.session.roadSegmentIds).toEqual(['s4', 's7']);
        expect(world.session.roadHasStarted).toBe(false);
        expect(world.session.roadWidth).toBe(10);
        expect(world.api.roadDrawingWidthForSegmentIndex(1)).toBe(14);
        expect(globalThis.isParcelLockedForRoadDrawing('HR-1')).toBe(true);
        expect(world.lastStatus()).toBe('Click a segment end to continue it, or click the map to draw a new one');
        // A new branch gets an id clear of the seeded ones.
        await world.click(at(0, 200));
        expect(world.session.roadSegmentIds).toEqual(['s4', 's7', 's8']);
    });
});

describe('editing a saved road (updateLocalCorridorGeometry)', () => {
    function localRoad(overrides = {}) {
        return {
            proposalId: 'road-1', applied: true, title: 'Road', cadastreParcelIds: ['HR-1'],
            createdAt: '2026-01-01T00:00:00.000Z',
            roadProposal: {
                definition: {
                    points: [[at(0, 0), at(100, 0)]], segmentIds: ['s1'], width: 7.5,
                    profile: globalThis.corridorProfileFromLegacy?.(7.5, 1, false) ?? null
                }
            },
            ...overrides
        };
    }
    const PARCEL_AT_NEW_END = { id: 'HR-3', ring: boxRing(140, -10, 160, 10) };

    function withProfile(record) {
        record.roadProposal.definition.profile = globalThis.corridorProfileFromLegacy(7.5, 1, false);
        return record;
    }

    it('edits one\'s own local road in place: same id, new land, newly reached parcels declared, scope re-derived', async () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE, PARCEL_AT_NEW_END] });
        const record = withProfile(localRoad());
        world.store.addProposal(record);
        const result = await globalThis.updateLocalCorridorGeometry('road-1', definition => {
            definition.points[0][1] = at(150, 0);
        });
        expect(result).toBe('road-1');
        const stored = world.store.getProposal('road-1');
        expect(stored).toBe(record);
        expect(near(stored.roadProposal.definition.points[0][1], at(150, 0))).toBe(true);
        expect(stored.roadProposal.definition.polygon.type).toMatch(/Polygon/);
        expect(stored.cadastreParcelIds).toEqual(['HR-1', 'HR-3']);
        expect(world.store.save.calls.length).toBeGreaterThan(0);
        const [scope] = globalThis.ProposalManager.rematerializeCorridorScope.calls[0];
        expect(near(scope[0].roadProposal.definition.points[0][1], at(100, 0))).toBe(true);   // before
        expect(scope[1]).toBe(record);                                                          // after
        expect(globalThis.ProposalManager._refreshUIAfterProposalChange.calls.at(-1)[0]).toBe(record);
        expect(world.store.addProposal.calls).toHaveLength(1);   // only the fixture: no new record
        expect(world.session.corridorApplyIndicatorCount).toBe(0);
    });

    it('an unchanged definition saves nothing', async () => {
        const world = open();
        world.store.addProposal(withProfile(localRoad()));
        expect(await globalThis.updateLocalCorridorGeometry('road-1', () => {})).toBe(true);
        expect(world.store.save.calls).toHaveLength(0);
        expect(globalThis.ProposalManager.rematerializeCorridorScope.calls).toHaveLength(0);
    });

    it('a published road keeps its land; the edit becomes a counterproposal that is selected', async () => {
        const world = open({ parcels: [PARCEL_ON_ROUTE, PARCEL_AT_NEW_END] });
        const record = withProfile(localRoad({ published: true, serverProposalId: '71', publicationApiBase: 'https://api.example.test' }));
        world.store.addProposal(record);
        globalThis.ProposalSelection.is = key => key === 'road-1';
        const result = await globalThis.updateLocalCorridorGeometry('road-1', definition => {
            definition.points[0][1] = at(150, 0);
        });
        expect(result).toBe('fork-1');
        expect(near(record.roadProposal.definition.points[0][1], at(100, 0))).toBe(true);
        const [fork] = globalThis.ProposalManager.createCorridorProposalAtomically.calls[0];
        expect(fork.proposalId).toBeUndefined();
        expect(fork.proposalOrigin).toMatchObject({ relation: 'revision', source: { kind: 'publication', apiBase: 'https://api.example.test' } });
        expect(fork.applied).toBe(false);
        expect(fork.createdAt).toBe(record.createdAt);
        expect(fork.cadastreParcelIds).toEqual(['HR-1', 'HR-3']);
        expect(globalThis.selectAndHighlightProposal.calls[0][0]).toBe('fork-1');
        expect(world.lastStatus()).toBe('The published road stays as it is; your edit was saved as a counterproposal.');
    });

    it('an edit that disconnects the road splits it into one record per stretch', async () => {
        const world = open();
        const record = withProfile(localRoad());
        record.roadProposal.definition.points = [[at(0, 0), at(100, 0)], [at(100, 0), at(100, 100)]];
        record.roadProposal.definition.segmentIds = ['s1', 's2'];
        world.store.addProposal(record);
        const result = await globalThis.updateLocalCorridorGeometry('road-1', definition => {
            definition.points[1] = [at(300, 0), at(300, 100)];
        });
        expect(result).toBe('road-1');
        expect(record.roadProposal.definition.segmentIds).toEqual(['s1']);
        expect(world.store.addProposal.calls).toHaveLength(2);
        const stretch = world.store.addProposal.calls[1][0];
        expect(stretch.title).toBe('Road (2)');
        expect(stretch.roadProposal.definition.segmentIds).toEqual(['s2']);
        expect(stretch.applied).toBe(true);
        expect(world.lastStatus()).toBe('The edit disconnected the road — it was split into 2 separate road proposals.');
    });

    it('erasing every stretch takes the road off the map', async () => {
        const world = open();
        const record = withProfile(localRoad());
        world.store.addProposal(record);
        const result = await globalThis.updateLocalCorridorGeometry('road-1', definition => { definition.points = []; });
        expect(result).toBe(true);
        expect(record.applied).toBe(false);
        expect(globalThis.ProposalManager.rematerializeCorridorScope.calls).toHaveLength(1);
        expect(globalThis.ProposalSelection.clear.calls).toHaveLength(1);
    });

    it('a road not in this city is refused, rolled back and explained', async () => {
        const world = open();
        const failures = [];
        expect(await globalThis.updateLocalCorridorGeometry('nowhere', () => {}, { onFailure: reason => failures.push(reason) })).toBe(false);
        expect(failures).toEqual(['This road is not among the proposals of the city on the map. Switch to the city it was created in, then try again.']);
        expect(world.lastStatus()).toBe('Could not complete that road change — reverted.');
        expect(world.session.corridorApplyIndicatorCount).toBe(0);
    });
});
