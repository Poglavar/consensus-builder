// Editing or cancelling a cross-section before placing an edge must leave the drawing usable.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RoadStrokeState = require('../../frontend/js/road-stroke-state.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const roadSource = readFileSync(fileURLToPath(new URL('../../frontend/js/road-drawing.js', import.meta.url)), 'utf8');
const editorSource = readFileSync(fileURLToPath(new URL('../../frontend/js/corridor-editor.js', import.meta.url)), 'utf8');

function lift(source, name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}', start);
    expect(end, `${name} closing brace not found`).toBeGreaterThan(start);
    return source.slice(start, end + 2);
}

function createHarness(segments = [], { withCancel = false, originalProfile = null } = {}) {
    const points = segments;
    const makeLayer = () => ({
        setLatLngs: vi.fn(),
        setStyle: vi.fn(),
        addTo: vi.fn(function addTo() { return this; }),
        removeFrom: vi.fn()
    });
    const removedLayers = [];
    const frameFor = vi.fn(authoredPoints => ({ anchor: authoredPoints[0] }));
    const buildRoadUnionPolygonWithWidths = vi.fn(centerline =>
        centerline.some(segment => segment.length >= 2) ? ['footprint'] : null);
    const closeEditor = vi.fn();
    const deps = {
        L: { polyline: vi.fn(makeLayer), polygon: vi.fn(makeLayer) },
        map: { removeLayer: vi.fn(layer => removedLayers.push(layer)) },
        buildRoadUnionPolygonWithWidths,
        frameFor,
        closeEditor,
        removedLayers,
        roadSegments: points,
        originalProfile
    };

    const cancel = withCancel ? lift(editorSource, 'corridorEditorCancel') : '';
    const undo = lift(roadSource, 'undoLastRoadSegment');
    const code = `
        const { L, map, buildRoadUnionPolygonWithWidths, frameFor, closeEditor, removedLayers,
            roadSegments: initialSegments, originalProfile } = deps;
        let roadSegments = initialSegments;
        let roadSegmentIds = roadSegments.map((_, index) => 'segment-' + index);
        let roadHasStarted = false;
        let roadPoints = [];
        let roadStrokeBaseCount = 0;
        let roadDrawingFrame = null;
        let roadWidth = 2;
        let roadProfile = null;
        let roadSidewalkWidth = 0;
        let roadLastValidatedWidth = 2;
        let roadDrawingProfileValidationPending = false;
        let roadCenterline = null;
        let cachedCommittedPolygon = null;
        let roadPolygon = null;
        let roadPolygonLayer = null;
        let roadPreviewLine = null;
        let roadPreviewPolygonLayer = null;
        let roadPreviewPolygon = null;
        let roadBuildingTunnels = [];
        let roadGradeSeparations = [];
        const roadSegmentProfiles = {};
        const roadAffectedParcels = [];
        const lockedStats = { parcelCount: 0, totalArea: 0, ownershipCounts: {}, marketPrice: 0, individualOwners: 0 };
        const window = { RoadStrokeState, roadSidewalkWidth: 0 };
        const document = { getElementById: () => null };
        const PersistentStorage = { setItem: vi.fn() };
        const metricFrameModule = () => ({ frameFor });
        const normalizeCorridorProfile = CorridorProfile.normalizeCorridorProfile;
        const corridorProfileWidth = CorridorProfile.corridorProfileWidth;
        const corridorDrawingIsTrack = () => false;
        const roadDrawingWidthForSegmentIndex = () => roadWidth;
        const recomputeLockedParcelsFromPolygon = vi.fn();
        const updateRoadInfoPanel = vi.fn();
        const updateRoadCrossSectionButton = vi.fn();
        const redrawRoadStrips = vi.fn();
        const redrawRoadVertexMarkers = vi.fn();
        const refreshRoadBuildingTunnelLayer = vi.fn();
        const refreshRoadGradeSeparationLayer = vi.fn();
        const removeBuildingTunnelEdge = (records) => records;
        const retainLiveGradeSeparations = (_segments, records) => records;
        const setRoadParcelStats = vi.fn();
        const setRoadOwnershipCounts = vi.fn();
        const formatParcelArea = () => '—';
        const updateRoadAcquiringDifficulty = vi.fn();
        const updateUndoButtonState = vi.fn();
        const translateRoadText = (_key, fallback) => fallback;
        const roadDrawingMode = true;
        let corridorEditorState = withCancel
            ? { mode: 'drawing', originalProfile }
            : null;
        function corridorEditorClose() { closeEditor(); }
        ${lift(roadSource, 'getAllRoadSegments')}
        ${lift(roadSource, 'hasDrawableCorridor')}
        ${lift(roadSource, 'roadSessionFrame')}
        ${lift(roadSource, 'rebuildRoadGeometryFromSegments')}
        ${lift(roadSource, 'setRoadDrawingProfile')}
        ${undo}
        ${cancel}
        return {
            getAllRoadSegments,
            hasDrawableCorridor,
            roadSessionFrame,
            rebuildRoadGeometryFromSegments,
            setRoadDrawingProfile,
            undoLastRoadSegment,
            corridorEditorCancel: ${withCancel ? 'corridorEditorCancel' : 'null'},
            state: () => ({ roadSegments, roadProfile, roadWidth, roadDrawingFrame,
                roadCenterline, cachedCommittedPolygon, roadPolygon, roadPolygonLayer,
                roadLastValidatedWidth, roadDrawingProfileValidationPending }),
            deps,
            removedLayers
        };
    `;
    // eslint-disable-next-line no-new-func
    return new Function('deps', 'RoadStrokeState', 'CorridorProfile', 'withCancel', 'vi', code)(
        deps, RoadStrokeState, CorridorProfile, withCancel, vi
    );
}

const PROFILE = { strips: [{ type: 'driving', width: 3 }] };
const POINT_A = { lat: 45.8, lng: 15.97 };
const POINT_B = { lat: 45.8001, lng: 15.9701 };

describe('road drawing profile edits without a drawable corridor', () => {
    it('accepts a profile with zero authored points without creating a metric frame', () => {
        const harness = createHarness();
        expect(harness.hasDrawableCorridor()).toBe(false);
        expect(() => harness.setRoadDrawingProfile(PROFILE)).not.toThrow();
        expect(harness.state().roadProfile).toEqual(PROFILE);
        expect(harness.state().roadDrawingFrame).toBeNull();
        expect(harness.state().cachedCommittedPolygon).toBeNull();
        expect(harness.deps.frameFor).not.toHaveBeenCalled();
        expect(harness.deps.buildRoadUnionPolygonWithWidths).not.toHaveBeenCalled();
    });

    it('keeps a one-point centerline but creates no footprint or frame', () => {
        const harness = createHarness([[POINT_A]]);
        expect(harness.hasDrawableCorridor()).toBe(false);
        expect(() => harness.setRoadDrawingProfile(PROFILE)).not.toThrow();
        expect(harness.state().roadCenterline).not.toBeNull();
        expect(harness.state().roadDrawingFrame).toBeNull();
        expect(harness.deps.frameFor).not.toHaveBeenCalled();
        expect(harness.deps.buildRoadUnionPolygonWithWidths).not.toHaveBeenCalled();
    });

    it('uses the metric frame and builds a footprint when the centerline is drawable', () => {
        const harness = createHarness([[POINT_A, POINT_B]]);
        expect(harness.hasDrawableCorridor()).toBe(true);
        expect(harness.setRoadDrawingProfile(PROFILE)).toBe(true);
        expect(harness.deps.frameFor).toHaveBeenCalledWith([POINT_A, POINT_B]);
        expect(harness.deps.buildRoadUnionPolygonWithWidths).toHaveBeenCalledTimes(1);
        expect(harness.deps.buildRoadUnionPolygonWithWidths.mock.calls[0][4]).toEqual({ anchor: POINT_A });
        expect(harness.state().cachedCommittedPolygon).toEqual(['footprint']);
        expect(harness.state().roadPolygon).toEqual(['footprint']);
    });

    it('clears the footprint and centerline when undo removes the last authored points', () => {
        const harness = createHarness([[POINT_A, POINT_B]]);
        harness.setRoadDrawingProfile(PROFILE);
        expect(harness.state().roadPolygonLayer).not.toBeNull();
        harness.undoLastRoadSegment(); // one point remains: no footprint
        expect(harness.hasDrawableCorridor()).toBe(false);
        harness.undoLastRoadSegment(); // removes the last point and segment
        expect(harness.getAllRoadSegments(true)).toEqual([]);
        expect(harness.state().roadCenterline).toBeNull();
        expect(harness.state().cachedCommittedPolygon).toBeNull();
        expect(harness.state().roadPolygon).toBeNull();
        expect(harness.state().roadPolygonLayer).toBeNull();
        expect(harness.removedLayers.length).toBeGreaterThan(0);
        expect(harness.deps.buildRoadUnionPolygonWithWidths).toHaveBeenCalledTimes(1);
    });

    it('lets Cancel restore the original profile and close an empty drawing editor', () => {
        const harness = createHarness([], { withCancel: true, originalProfile: PROFILE });
        expect(() => harness.corridorEditorCancel()).not.toThrow();
        expect(harness.state().roadProfile).toEqual(PROFILE);
        expect(harness.deps.closeEditor).toHaveBeenCalledTimes(1);
    });
});
