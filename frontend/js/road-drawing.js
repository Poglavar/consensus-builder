// Hide road info panel
function hideRoadInfoPanel() {
    document.getElementById('road-info-panel').classList.remove('visible');
}

// ---------------------------------------------------------------------------
// The corridor drawing tool
//
// ONE tool draws every corridor. A road and a track are the same object — a centerline plus a
// cross-section — so there is one drawing mode, one click handler, one set of segments, one finish.
//
// The two buttons ("Draw road", "Draw track") are not two tools: they are two SEEDS. They open the
// same tool with a different starting cross-section — a road profile, or one rail lane at the standard
// gauge — and everything the road tool can do (snapping, junctions, branching and resuming) a track
// can do, because it IS the road tool. `corridorDrawKind` remembers which
// button opened the session, and is used only for what the user sees: which button lights up, what the
// panel is called, and whether the rail speed/curvature limit applies.
// ---------------------------------------------------------------------------
let roadDrawingMode = false;
let corridorDrawKind = 'road';

function canStartRoadDrawingInCurrentMode() {
    const state = typeof window !== 'undefined' ? window.__mapModeState : null;
    if (typeof window !== 'undefined' && window.OnMapEditor?.isActive?.()) return false;
    if (typeof window !== 'undefined' && window.__mapEditLock?.isHeld?.()) return false;
    if (state?.desired && state.desired !== '2d') return false;
    if (typeof window !== 'undefined' && window.__pending3DMode) return false;
    if (typeof window !== 'undefined' && typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()) return false;
    return !document.body?.classList?.contains('three-mode-active');
}

// The kind of the corridor CURRENTLY on the tool: a rail lane in the cross-section makes it a track,
// whichever button opened the session. A tram lane dropped into a street makes it a track, but the
// curve radius target only holds rails without traffic lanes (corridorProfileHoldsRadiusTarget).
function corridorDrawingIsTrack() {
    return typeof corridorProfileHasRail === 'function' && corridorProfileHasRail(roadProfile);
}

function corridorDrawingKind() {
    return corridorDrawingIsTrack() ? 'track' : 'road';
}

// Other modules (node-edit mode, draft overlay) react to drawing mode starting/stopping.
function announceCorridorDrawingModeChange() {
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('corridor-drawing-mode-changed', {
                detail: { road: roadDrawingMode, kind: corridorDrawKind }
            }));
        }
    } catch (_) { }
}
// Make roadDrawingMode globally accessible so other modules can check it
function updateGlobalRoadDrawingMode(value) {
    roadDrawingMode = value;
    // Drawing a road is a road operation: the buildings it could hit appear immediately.
    if (value) { try { ensureRoadOperationBuildings(); } catch (_) { } }
    if (typeof window !== 'undefined') {
        window.roadDrawingMode = value;
    }
    announceCorridorDrawingModeChange();
}

// Each road can be composed of multiple disjoint centerline segments.
// `roadSegments` keeps all committed segments; `roadPoints` points to the currently active segment (if any).
//
// A segment is an ordered list of vertices with no branching — the same model as an OpenStreetMap
// "way" (an ordered node list). Two segments are connected iff they share a vertex, exactly as two
// OSM ways are connected iff they share a node; a branch or a crossroads is therefore not a special
// object, just several segments meeting at a shared vertex. Clicks snap to existing vertices and
// edges so those shared vertices actually coincide.
let roadSegments = [];
let roadPoints = [];
// Stable per-segment ids, aligned with `roadSegments` by index (an OSM way id, in effect). They let a
// segment keep its identity when it is continued in a later session, rather than becoming a new one.
let roadSegmentIds = [];
let nextRoadSegmentId = 1;

function newRoadSegmentId() {
    return `s${nextRoadSegmentId++}`;
}

// Register a freshly created segment array so ids stay index-aligned with `roadSegments`.
function pushRoadSegment(points, segmentId) {
    roadSegments.push(points);
    roadSegmentIds.push(segmentId || newRoadSegmentId());
    return points;
}
// Default width in meters; overridden by picker. The mapping uses representative carriageway widths.
let roadWidth = 7.5;
let roadSidewalkWidth = 1;
// The corridor's cross-section. `roadWidth` is the sum of its strips — the profile is the truth, the
// width a cache the rest of the pipeline still reads. See js/corridor-profile.js.
let roadProfile = null;
// The side of the road the corridor's traffic keeps to: the city's for a new road, the corridor's
// own when one is reopened. It becomes the record's `driving_side` (js/corridor-osm-form.js).
let roadDrivingSide = 'right';
if (typeof window !== 'undefined') {
    window.roadSidewalkWidth = roadSidewalkWidth;
}
let roadCenterline = null;
let roadPolygon = null;
let roadPreviewLine = null;
let roadAffectedParcels = [];
let roadMouseMarker = null;
let roadHasStarted = false;
let roadPreviewPolygonLayer = null;
// The edge whose placement is being decided right now (buildings, crossings, structures). It is
// drawn at its real width for as long as those dialogs are open — see showPendingRoadSegment.
let roadPendingSegmentLayer = null;
let roadCenterlineLayer = null;
let roadPolygonLayer = null;
let roadMarkers = [];
let roadBuildingTunnels = [];
let roadGradeSeparations = [];
// What each edge drawn this session runs into — buildings, plots, parks/squares/lakes, crossings of
// roads — recorded per edge (edgeKey → entry, road-stroke-state.js) instead of asked on the click.
// Finish reviews them once for the whole drawing (road-editor.md decision 5).
let roadEdgeConflicts = new Map();
let roadConflictMarkerLayer = null;
// Existing streets (the /osm-road centre lines) this drawing snapped onto: [{ lat, lng, wayId, name }].
// They are not records, so nothing is noded into them at Finish; the stored definition remembers them.
let roadStreetConnections = [];
// Per-segment cross-section overrides for the segments of THIS drawing session that came in
// with their own profile (seeded edits). Keyed by segment id; drawing-new
// segments use the session's active roadProfile. See corridorSegmentProfile().
let roadSegmentProfiles = {};
// Segments continued from their first vertex while they followed the session profile: their override
// is that profile mirrored (resumeRoadSegment), and it is mirrored again whenever the profile changes,
// so they keep following it.
let roadMirroredSegmentIds = new Set();
// Finishing is a single user action even though proposal creation crosses several async boundaries.
// Segment placement has its own lock because its footprint fetch and obstacle decision must complete
// before either another click or F is allowed to consume the drawing state.
// The browser loads road-finalization-state.js first (a global); a node test require()s this file.
const roadFinalizationGate = (typeof RoadFinalizationState !== 'undefined'
    ? RoadFinalizationState
    : require('./road-finalization-state.js')).createSingleFlightGate();
let roadSegmentPlacementInProgress = false;
// The placement under way, as a promise that settles when it is done: Escape, Undo and a double-
// click's finish wait on it (afterRoadPlacement) rather than interleave with its async preload.
let roadSegmentPlacement = null;
// When the previous map click arrived (ms), so the second tap of a touch double-tap adds nothing.
let roadLastClickAt = -Infinity;
let roadDrawingProfileValidationPending = false;
let roadLastValidatedWidth = roadWidth;

function roadDrawingSegmentOverride(index) {
    const id = roadSegmentIds[index];
    const raw = (id !== undefined && id !== null) ? roadSegmentProfiles[String(id)] : null;
    if (!raw) return null;
    const normalized = (typeof normalizeCorridorProfile === 'function') ? normalizeCorridorProfile(raw) : null;
    if (!normalized) {
        console.error('[road-drawing] segment profile override is invalid — falling back to the tool profile', id, raw);
        return null;
    }
    return normalized;
}

function roadDrawingWidthForSegmentIndex(index) {
    const override = roadDrawingSegmentOverride(index);
    if (override && typeof corridorProfileWidth === 'function') {
        const width = corridorProfileWidth(override);
        if (width > 0) return width;
    }
    return roadWidth;
}
let roadSurfaceBuildingIds = new Set();
let roadBuildingTunnelLayer = null;
let roadGradeSeparationLayer = null;
let roadPreviewAffectedParcels = []; // Stores parcels affected by the preview segment

function buildDrawingTunnelLayer(records, color) {
    if (typeof L === 'undefined' || !Array.isArray(records) || !records.length) return null;
    const tunnelPane = (typeof ensureCorridorStripsPane === 'function' && ensureCorridorStripsPane())
        ? 'corridorStripsPane' : undefined;
    const group = L.layerGroup();
    records.forEach(record => {
        if (!record?.from || !record?.to) return;
        const points = [record.from, record.to];
        L.polyline(points, {
            color, weight: 8, opacity: 0.8, dashArray: '8 7',
            pane: tunnelPane, interactive: false
        }).addTo(group);
        points.forEach(point => L.circleMarker(point, {
            radius: 5, color, weight: 2, fillColor: '#15121f', fillOpacity: 1,
            pane: tunnelPane, interactive: false
        }).addTo(group));
    });
    return group;
}

function refreshRoadBuildingTunnelLayer() {
    if (roadBuildingTunnelLayer && map.hasLayer(roadBuildingTunnelLayer)) map.removeLayer(roadBuildingTunnelLayer);
    roadBuildingTunnelLayer = buildDrawingTunnelLayer(roadBuildingTunnels, '#7c3aed');
    if (roadBuildingTunnelLayer) roadBuildingTunnelLayer.addTo(map);
}

function refreshRoadGradeSeparationLayer() {
    if (roadGradeSeparationLayer && map.hasLayer(roadGradeSeparationLayer)) map.removeLayer(roadGradeSeparationLayer);
    if (typeof L === 'undefined' || !Array.isArray(roadGradeSeparations) || !roadGradeSeparations.length) {
        roadGradeSeparationLayer = null;
        return;
    }
    const pane = (typeof ensureCorridorStripsPane === 'function' && ensureCorridorStripsPane())
        ? 'corridorStripsPane' : undefined;
    roadGradeSeparationLayer = L.layerGroup();
    roadGradeSeparations.forEach(record => {
        if (!record?.from || !record?.to || !record?.crossing) return;
        const over = record.mode === 'overpass';
        // Same as the applied renderer: a strip of the road's real width, not a fat polyline.
        // `weight` is pixels and record.width is metres, so the old form drew a 19 m deck 19 px
        // wide and never rescaled on zoom. A polygon is geographic, so it scales for free.
        const width = Number(record.width);
        const deck = (typeof calculateRoadPolygon === 'function' && Number.isFinite(width) && width > 0)
            ? calculateRoadPolygon([record.from, record.crossing, record.to], width, roadSessionFrame([record.from, record.crossing, record.to]))
            : null;
        if (!deck) {
            console.warn('[road-drawing] grade separation has no usable width; skipping deck', record.mode, record.width);
        } else {
            L.polygon(deck, {
                color: over ? '#f59e0b' : '#2563eb',
                weight: 1.5,
                opacity: 0.9,
                fillColor: over ? '#f59e0b' : '#2563eb',
                fillOpacity: 0.35,
                dashArray: over ? null : '7 6',
                pane,
                interactive: false
            }).addTo(roadGradeSeparationLayer);
        }
        [record.from, record.to].forEach(point => L.circleMarker(point, {
            radius: 4,
            color: over ? '#b45309' : '#1d4ed8',
            weight: 2,
            fillColor: '#ffffff',
            fillOpacity: 1,
            pane,
            interactive: false
        }).addTo(roadGradeSeparationLayer));
    });
    roadGradeSeparationLayer.addTo(map);
}

// Load only a narrow chain around one edge. Passing a kilometre-long diagonal's single bounding box
// to /buildings asks for the entire square around it and can truncate before the road's buildings are
// returned; bounded sub-edges keep the fetch complete and the obstacle decision deterministic.
async function ensureBuildingFootprintsForRoadEdge(from, to, width) {
    if (typeof window === 'undefined' || typeof window.ensureBuildingFootprintsForBounds !== 'function') return;
    if (typeof corridorEdgeFetchSegments !== 'function') {
        throw new Error('Corridor edge fetch segmentation is unavailable.');
    }
    // Fetch bounds only: a frame on the edge itself serves (projections.md §2).
    const frame = metricFrameModule().frameFor([from, to]);
    for (const edge of corridorEdgeFetchSegments(from, to)) {
        const polygon = calculateRoadPolygon(edge, width, frame);
        if (polygon) await window.ensureBuildingFootprintsForBounds(polygon);
    }
}

// The authored tunnel list belongs to the road core. Width/profile edits retain those records;
// demolition and parcel effects are derived later by the canonical replay.
function ensureBuildingTunnelsForSegments(segments, records) {
    const live = (typeof retainLiveCorridorTunnelRecords === 'function')
        ? retainLiveCorridorTunnelRecords(segments || [], records || [])
        : (Array.isArray(records) ? records.slice() : []);
    return { accepted: true, records: live };
}

// Commit the cross-section editor's live width preview. Existing authored tunnel spans survive only
// while their exact edges survive; parcel and demolition effects wait for canonical replay.
async function validateRoadDrawingProfileImpacts() {
    const drawnSegments = getAllRoadSegments(true)
        .map((segment, index) => ({ segment, id: roadSegmentIds[index] || null }))
        .filter(entry => Array.isArray(entry.segment) && entry.segment.length >= 2);
    if (!drawnSegments.length) {
        roadLastValidatedWidth = roadWidth;
        roadDrawingProfileValidationPending = false;
        return true;
    }

    const segments = drawnSegments.map(entry => entry.segment);
    const result = ensureBuildingTunnelsForSegments(segments, roadBuildingTunnels);
    if (!result.accepted) return false;

    roadBuildingTunnels = result.records;
    roadLastValidatedWidth = roadWidth;
    roadDrawingProfileValidationPending = false;
    refreshRoadBuildingTunnelLayer();

    // A tunnel choice may insert facade portals into the centerline. Rebuild every dependent piece
    // immediately so the edit the user just accepted is exactly what remains visible and finishable.
    const polygon = rebuildRoadGeometryFromSegments();
    redrawRoadVertexMarkers();
    recomputeLockedParcelsFromPolygon(polygon);
    updateRoadInfoPanel();
    updateUndoButtonState();
    return true;
}

// Locked parcels tracking - these are parcels confirmed by clicking (not just preview)
let lockedParcelIds = new Set(); // Set of parcel IDs that are locked (confirmed)
let lockedStats = {
    parcelCount: 0,
    totalArea: 0,
    ownershipCounts: { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 },
    marketPrice: 0,
    individualOwners: 0  // Count of individual person owners across all locked parcels
};

// Pieces formed on open ground that the corridor crosses (piece id → m²): subdivision plots, parks,
// building plots with no cadastral parcel. Their ownership is unknown; in this drawing model they are
// never counted as parcels; the panel shows them as open ground. `locked` follows the committed
// corridor, `preview` the segment under the cursor.
const roadOpenGroundCrossed = { locked: new Map(), preview: new Map() };

// Helper to get locked individual owners count
function getLockedIndividualOwnersCount() {
    return roadOwnershipSummary(roadAffectedParcels).totalOwnerEntryCount;
}

// Cached committed road geometry metrics - updated once per segment commit, not per mousemove
// This allows fast preview updates by adding preview segment metrics to these cached values
let committedRoadMetrics = {
    length: 0,      // Total length of committed segments in meters
    area: 0         // Total area of committed road polygon in square meters
};

// Cached committed road polygon - incrementally updated on each click instead of rebuilding
// This avoids expensive full-road union calculations
let cachedCommittedPolygon = null;
// The metric frame of the drawing session (projections.md §2): anchored on the road's authored points
// the first time anything is built or measured in metres, then frozen until the session resets, so
// every piece built while drawing — the committed land, previews, crossing decks — shares one frame.
let roadDrawingFrame = null;

function corridorFootprintModule() {
    const api = (typeof window !== 'undefined' && window.__corridorFootprint) || null;
    if (!api) throw new Error('road-drawing: corridor-footprint.js is not loaded');
    return api;
}

function metricFrameModule() {
    const api = (typeof window !== 'undefined' && window.__metricFrame) || null;
    if (!api) throw new Error('road-drawing: metric-frame.js is not loaded');
    return api;
}

// The session frame, created on first use from the road's authored points plus `extraPoints` (the
// click or cursor position the piece being built starts from). Throws outside the supported domain.
function roadSessionFrame(extraPoints = []) {
    if (roadDrawingFrame) return roadDrawingFrame;
    const points = [];
    getAllRoadSegments(true).forEach(segment => (Array.isArray(segment) ? segment : []).forEach(point => points.push(point)));
    (Array.isArray(extraPoints) ? extraPoints : []).forEach(point => points.push(point));
    if (!points.length) throw new Error('road-drawing: no authored point to anchor the drawing frame on');
    roadDrawingFrame = metricFrameModule().frameFor(points);
    return roadDrawingFrame;
}

// Leaflet nesting of a GeoJSON footprint, as every caller of the road builders expects it: LatLng[]
// for one ring, LatLng[][] for a polygon with holes, LatLng[][][] for several parts (rings closed).
function roadPolygonFromGeoJSON(geometry) {
    if (!geometry) return null;
    const toRing = coordinates => coordinates.map(([lng, lat]) => L.latLng(lat, lng));
    if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates.map(toRing);
        return rings.length === 1 ? rings[0] : rings;
    }
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(rings => rings.map(toRing));
    throw new Error(`road-drawing: unexpected footprint type ${geometry.type}`);
}

// Length of a polyline on the ellipsoid, in metres: measuring needs no projection (projections.md §2).
function polylineLengthMeters(points) {
    const geodesic = metricFrameModule().geodesicDistance;
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
        length += geodesic([points[i].lng, points[i].lat], [points[i + 1].lng, points[i + 1].lat]);
    }
    return length;
}

// Global function to check if a parcel is locked for corridor drawing — a road's or a track's, which
// are the same drawing. This allows other modules (like parcels/styles.js) to preserve the highlight.
function isParcelLockedForRoadDrawing(parcelId) {
    if (!parcelId) return false;
    return lockedParcelIds.has(parcelId.toString());
}
// Expose globally
if (typeof window !== 'undefined') {
    window.isParcelLockedForRoadDrawing = isParcelLockedForRoadDrawing;
}

// Define style for preview-affected parcels
const previewAffectedStyle = {
    fillColor: '#ff6600', // Orange
    fillOpacity: 0.4,
    color: '#ff6600',
    weight: 2
};

function getAllRoadSegments(includeActive = true) {
    const segments = Array.isArray(roadSegments) ? [...roadSegments] : [];
    if (includeActive && roadHasStarted && Array.isArray(roadPoints) && roadPoints.length > 0) {
        // The active segment is normally already in `roadSegments` (it was pushed when it started),
        // and after resuming an earlier segment it need not be the last one — so test membership,
        // not just the tail, or a resumed segment would be counted twice.
        if (!segments.includes(roadPoints)) {
            segments.push(roadPoints);
        }
    }
    return segments.filter(segment => Array.isArray(segment));
}

function calculateSegmentLengthMeters(segment) {
    if (!Array.isArray(segment) || segment.length < 2) return 0;
    return polylineLengthMeters(segment);
}

function calculatePolygonAreaMeters(polygon) {
    try {
        const turfPoly = polygonLatLngsToTurfFeature(polygon);
        if (turfPoly && typeof turf !== 'undefined' && turf && typeof turf.area === 'function') {
            return turf.area(turfPoly) || 0;
        }
    } catch (_) { /* ignore */ }
    return 0;
}

// Footprint when widths differ per segment: widths[i] pairs with segments[i]. Segment ids travel too:
// they are how the construction tells two pieces of one stretch (whose bend still owes a joint wedge)
// from two different roads meeting at a junction. Built by the shared construction
// (corridor-footprint.js footprintOfArms) in `frame`, so the land drawn here is the land the server
// stores; throws when it cannot be built.
function buildRoadUnionPolygonWithWidths(segments, widths, fallbackWidth, segmentIds, frame) {
    if (!frame) throw new Error('buildRoadUnionPolygonWithWidths: a metric frame is required (projections.md §2)');
    const footprint = corridorFootprintModule();
    const arms = [];
    (segments || []).forEach((segment, index) => {
        if (!Array.isArray(segment) || segment.length < 2) return;
        const width = (Array.isArray(widths) && Number(widths[index]) > 0) ? Number(widths[index]) : fallbackWidth;
        const id = (Array.isArray(segmentIds) && segmentIds[index] !== undefined && segmentIds[index] !== null)
            ? String(segmentIds[index])
            : null;
        arms.push({ points: segment, width, stretchId: footprint.baseStretchId(id) });
    });
    return roadPolygonFromGeoJSON(footprint.footprintOfArms(arms, frame));
}

function corridorProtectedSpanRecordsForDefinition(definition) {
    const records = Array.isArray(definition?.tunnels) ? definition.tunnels.filter(Boolean) : [];
    const gradeRecords = (typeof gradeSeparationSpanRecords === 'function')
        ? gradeSeparationSpanRecords(definition?.gradeSeparations || [])
        : [];
    return records.concat(gradeRecords);
}

function corridorProtectedEdgeKeySet(tunnels, gradeSeparations) {
    const keys = (Array.isArray(tunnels) ? tunnels : []).map(record => record?.edgeKey).filter(Boolean);
    if (typeof gradeSeparationEdgeKeys === 'function') {
        keys.push(...gradeSeparationEdgeKeys(gradeSeparations || []));
    }
    return new Set(keys);
}

// The taking geometry and cutting geometry are the same full corridor. Tunnels and grade
// separations are authored road content, but they still take the cadastral surface.
//
// The one exception is a stretch that is fully underground by LEVEL (corridor-elevation.md,
// 2026-07-12): it takes nothing, because nothing on the surface changes. Levels only exist on
// imported corridors so far, and a corridor without them yields one span per segment — byte for
// byte the previous footprint. Edge-keyed `tunnels` metadata is a different concept and still
// acquires; only an explicit -1 level is exempt.
//
// Built by the shared construction in the corridor's own frame (corridor-footprint.js, projections.md
// §3): exactly the land the server prepares and stores. Throws when it cannot be built.
function corridorSurfaceFootprintForDefinition(definition) {
    const footprint = corridorFootprintModule();
    return footprint.footprintIn(definition, footprint.frameForDefinition(definition));
}

// The same land in Leaflet nesting.
function buildCorridorAcquisitionPolygon(definition) {
    return roadPolygonFromGeoJSON(corridorSurfaceFootprintForDefinition(definition));
}

if (typeof window !== 'undefined') {
    window.buildCorridorAcquisitionPolygon = buildCorridorAcquisitionPolygon;
    window.corridorSurfaceFootprintForDefinition = corridorSurfaceFootprintForDefinition;
}

// Every geometry change re-derives the parcels the corridor now touches from the committed
// fabric. Leaflet is only a projection and never participates in the intersection decision.
// `options.minOverlapM2`: a parcel counts only when the land covers at least this much of it (a
// road placed into a parcel shares whole borders with its neighbours, which touch it but give it
// nothing; roadLandOverlapFloor).
function collectParcelsIntersectingFootprint(footprintGeometry, options = {}) {
    if (!footprintGeometry || typeof turf === 'undefined') return [];
    const geometry = footprintGeometry.type ? footprintGeometry : { type: 'Polygon', coordinates: footprintGeometry };
    const roadFeature = { type: 'Feature', properties: {}, geometry };
    return liveRoadDrawingParcelsIntersecting(roadFeature, { minOverlapM2: options.minOverlapM2 })
        .map(getRoadDrawingParcelIdFromFeature)
        .filter(Boolean)
        .map(String);
}

// A non-blocking "working…" spinner, shown while anything slow enough to look like a hang is under
// way — a corridor edit re-applying, a road being built, a proposal being created. Ref-counted so
// overlapping claims keep it up until the last one settles. It never blocks input (pointer-events:none in
// CSS) — road-node-edit suspends its handles until the transaction settles. The CSS animation-delay means a fast
// edit removes it before it ever becomes visible, so only genuinely slow applies flash the spinner.
let corridorApplyIndicatorCount = 0;
let corridorApplyIndicatorTimer = null;
let corridorApplyIndicatorRelease = null;
function beginApplyIndicator(labelText) {
    corridorApplyIndicatorCount += 1;
    if (corridorApplyIndicatorTimer || corridorApplyIndicatorRelease || typeof document === 'undefined') return;
    const label = labelText || ((typeof translateRoadText === 'function')
        ? translateRoadText('panel.road.applyingEdit', 'Applying…')
        : 'Applying…');
    // Only a genuinely slow apply reaches the status line (design-language.md, Messages): a quick edit ends
    // before the delay runs out.
    corridorApplyIndicatorTimer = setTimeout(() => {
        corridorApplyIndicatorTimer = null;
        if (corridorApplyIndicatorCount <= 0) return;
        const scope = (typeof window !== 'undefined') ? window : {};
        if (typeof scope.updateStatus === 'function') scope.updateStatus(label, { transient: true });
        corridorApplyIndicatorRelease = (typeof scope.beginStatusActivity === 'function') ? scope.beginStatusActivity() : () => {};
    }, 150);
    // The pointer is where the user is looking, so it carries the same news: the whole document goes
    // busy, which survives exitRoadDrawingMode() clearing the map container's inline cursor.
    try { document.body?.classList.add('corridor-busy'); } catch (_) { }
}
function endApplyIndicator() {
    corridorApplyIndicatorCount = Math.max(0, corridorApplyIndicatorCount - 1);
    if (corridorApplyIndicatorCount > 0) return;
    if (corridorApplyIndicatorTimer) { clearTimeout(corridorApplyIndicatorTimer); corridorApplyIndicatorTimer = null; }
    if (corridorApplyIndicatorRelease) { corridorApplyIndicatorRelease(); corridorApplyIndicatorRelease = null; }
    try { document.body?.classList.remove('corridor-busy'); } catch (_) { }
}
if (typeof window !== 'undefined') {
    window.beginApplyIndicator = beginApplyIndicator;
    window.endApplyIndicator = endApplyIndicator;
}

// True while any corridor re-apply is in flight — the exit/deselect paths wait on this.
function isCorridorApplyInFlight() {
    return corridorApplyIndicatorCount > 0;
}

// Geometry edits change the authored road record, then rematerialise the affected flat cadastral
// component. Generated parcels are cache, never a predecessor chain that the editor has to undo.
// The spinner is presentation-only.
function cloneRoadValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function baseRoadParentHints(ids) {
    const fabric = window.LiveParcelFabric;
    if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
        throw new Error('Live parcel fabric provenance is unavailable while saving the corridor.');
    }
    return fabric.cadastreIdsForParcelIds(Array.isArray(ids) ? ids : []);
}

function writeRoadDefinition(record, definition) {
    if (!record || !definition) return;
    const copy = cloneRoadValue(definition);
    record.roadProposal = { ...(record.roadProposal || {}), definition: copy };
    if (copy.polygon) {
        record.site = cloneRoadValue(copy.polygon);
        delete record.binding;
    }
}

function stripRoadDerivedFields(record) {
    if (!record) return record;
    delete record.childParcelIds;
    delete record.descendantParcelIds;
    delete record.parentFeatures;
    delete record.appliedAt;
    delete record.executedAt;
    delete record.localEditAt;
    delete record.editSeq;
    delete record.revertSnapshot;
    delete record.childFeatures;
    const road = record.roadProposal;
    if (road) {
        delete road.childParcelIds;
        delete road.parentFeatures;
        delete road.parentsToRemove;
        delete road.formation;
        delete road.demolishedBuildings;
        delete road.demolitionScanned;
        delete road.childFeatures;
        if (road.definition) {
            delete road.definition.demolishedBuildings;
            delete road.definition.demolitionScanned;
        }
    }
    return record;
}

function makeFreshRoadSnapshot(sourceProposal, definition, options = {}) {
    const clone = cloneRoadValue(sourceProposal);
    // The source's identity stays with the source: its local key, its publication mark (a design's
    // only published identity; designs are not minted, M3), its times and its lineage.
    [
        'proposalId', 'id', 'published',
        'createdAt', 'updatedAt', 'proposalDraftId', 'lens', 'proposalOrigin'
    ].forEach(key => delete clone[key]);

    if (options.sourceLocalProposalId) {
        clone.proposalOrigin = window.ProposalOrigin.fromRecord(sourceProposal, {
            relation: 'revision', localProposalId: String(options.sourceLocalProposalId)
        });
    }
    // A fork of a published design links the design it came from by its CID (plan-design-agreement.md,
    // M2: "Fork design" records origin.cid); the publication mark itself stays with the source.
    const sourcePublication = sourceProposal && sourceProposal.published;
    if (sourcePublication && window.Cid.isCid(sourcePublication.cid)) clone.origin = { cid: sourcePublication.cid };

    const cleanDefinition = cloneRoadValue(definition);
    delete cleanDefinition.demolishedBuildings;
    delete cleanDefinition.demolitionScanned;
    const geometricHints = cleanDefinition.polygon
        ? collectParcelsIntersectingFootprint(cleanDefinition.polygon, { minOverlapM2: roadLandOverlapFloor(cleanDefinition) })
        : [];
    const fallbackHints = sourceProposal?.cadastreParcelIds || [];
    const cadastreParcelIds = baseRoadParentHints(geometricHints.length ? geometricHints : fallbackHints);

    // The replacement keeps the SOURCE's place in the constraint order: the §15c replay
    // applies formations oldest-first, and stamping now() sent every edited road to the END
    // of the queue — structures authored after it then replayed before it, whole-took the
    // bases along its route, and the re-derive refused at 56% coverage ("could not be
    // derived from the cadastre"). An edit changes the record, not when the formation
    // entered the partition.
    clone.createdAt = (sourceProposal && sourceProposal.createdAt)
        ? sourceProposal.createdAt
        : new Date().toISOString();
    clone.cadastreParcelIds = cadastreParcelIds.slice();
    // The stretch reaches less land than its source: claims copied from the source on parcels
    // outside the new anchors would fail the load boundary ("contains live parcel id").
    window.ProposalAuthoredRecord.restrictLandClaimsToAnchors(clone);
    clone.roadProposal = {
        ...(clone.roadProposal || {}),
        definition: cloneRoadValue(cleanDefinition)
    };
    writeRoadDefinition(clone, cleanDefinition);
    stripRoadDerivedFields(clone);
    if (typeof setProposalApplied === 'function') setProposalApplied(clone, false, { stamp: false });
    else clone.applied = false;
    return clone;
}

// The least area a road's land must cover of a parcel to declare it. A road placed into a parcel
// (definition.bound) has the parcel's own boundary as its land, so every neighbour touches it: only
// parcels it covers at least as much of as the arrangement keeps a piece for (parcel-arrangement.js
// MIN_PIECE_M2) are declared. Other roads keep declaring every parcel their land reaches.
const BOUNDED_ROAD_MIN_OVERLAP_M2 = 0.25;
function roadLandOverlapFloor(definition) {
    return definition && definition.bound && definition.bound.site ? BOUNDED_ROAD_MIN_OVERLAP_M2 : 0;
}

// Add every loaded parcel under `polygon` to the record's declared cadastre parcels (as base
// parcel ids, like a fresh snapshot). Returns the ids that were newly declared.
function declareParcelsUnderRoadLand(record, polygon) {
    if (!record || !polygon) return [];
    const floor = roadLandOverlapFloor(record.roadProposal && record.roadProposal.definition);
    const reached = baseRoadParentHints(collectParcelsIntersectingFootprint(polygon, { minOverlapM2: floor }));
    const declared = new Set((Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : []).map(String).filter(Boolean));
    const added = reached.map(String).filter(id => id && !declared.has(id));
    if (!added.length) return [];
    record.cadastreParcelIds = [...declared, ...added];
    return added;
}

// A junction is authored into every road that meets there (proposals/corridor-authoring.js). A
// connected road that is still one's own unpublished design takes the change in place. A published
// one is immutable (proposals/lineage.js), exactly as when it is edited directly: the junction is
// saved as its new version, a revision that names the published design by its CID, and the revision
// takes its place on the map while the published record stays as it was. `definition` has its land
// built. Returns the record that now carries it.
function reviseRoadForJunction(store, source, definition) {
    const sourceKey = String(
        (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId
    );
    const revision = makeFreshRoadSnapshot(source, definition, { sourceLocalProposalId: sourceKey });
    declareParcelsUnderRoadLand(revision, definition.polygon);
    const id = store.addProposal(revision, { emitEvent: false });
    const stored = id ? store.getProposal(id) : null;
    if (!stored) throw new Error(`Could not save the new version of “${source.title || source.name || sourceKey}”.`);
    setProposalApplied(stored, true);
    store._indexProposal?.(stored);
    setProposalApplied(source, false, { stamp: false });
    store._indexProposal?.(source);
    return stored;
}

function rekeyMovedTunnelRecords(beforeDefinition, afterSegments, records) {
    const list = cloneRoadValue(Array.isArray(records) ? records : []);
    const beforeSegments = (typeof corridorCenterlineOf === 'function')
        ? corridorCenterlineOf(beforeDefinition || {})
        : [];
    if (!beforeSegments.length || beforeSegments.length !== afterSegments.length) return list;
    if (beforeSegments.some((segment, index) => segment.length !== afterSegments[index]?.length)) return list;

    const eps = 1e-9;
    const near = (a, b) => a && b
        && Math.abs(Number(a.lat) - Number(b.lat)) < eps
        && Math.abs(Number(a.lng) - Number(b.lng)) < eps;
    const locate = point => {
        for (let segmentIndex = 0; segmentIndex < beforeSegments.length; segmentIndex += 1) {
            const pointIndex = beforeSegments[segmentIndex].findIndex(candidate => near(candidate, point));
            if (pointIndex >= 0) return [segmentIndex, pointIndex];
        }
        return null;
    };

    return list.map(record => {
        if (!record?.from || !record?.to) return record;
        const from = locate(record.from);
        const to = locate(record.to);
        if (!from || !to || from[0] !== to[0] || Math.abs(from[1] - to[1]) !== 1) return record;
        const segment = afterSegments[from[0]];
        const moved = {
            ...record,
            from: cloneRoadValue(segment[from[1]]),
            to: cloneRoadValue(segment[to[1]])
        };
        if (typeof corridorTunnelEdgeKey === 'function') {
            moved.edgeKey = corridorTunnelEdgeKey(moved.from, moved.to);
        }
        return moved;
    });
}

function rebuildRoadDefinitionFootprint(definition) {
    // An edited definition is no longer the one its provenance describes: its land is rebuilt in the
    // edited centre line's own frame, and publishing prepares it anew.
    delete definition.constructionFrame;
    const polygon = corridorSurfaceFootprintForDefinition(definition);
    definition.polygon = polygon;
    definition.latLngPairs = convertRoadPolygonToLatLngPairs(roadPolygonFromGeoJSON(polygon));
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;
    return definition.polygon;
}

// Wrapper: every corridor geometry edit (node drag, bulldoze, delete, profile change) funnels through
// one parcel-mutation transaction. One's own local road is edited in place; a published or minted one
// gets a counterproposal (runLocalCorridorGeometryUpdate). Resolves to the id of the road that now
// holds the edit, or false when the edit was refused and rolled back; `options.onFailure(reason)`
// hears why, in words for the person who made the edit.
async function updateLocalCorridorGeometry(proposalIdOrHash, mutateDefinition, options = {}) {
    beginApplyIndicator();
    try {
        // Node dragging may paint through the committed record for immediate feedback. Restore the
        // captured pre-drag definition before ParcelMutation snapshots global state; the desired
        // geometry is rebuilt by mutateDefinition inside its private proposal draft.
        if (options.preEditSnapshot) {
            const live = (typeof getProposalByIdOrHash === 'function')
                ? getProposalByIdOrHash(proposalIdOrHash)
                : null;
            if (live?.roadProposal?.definition) {
                writeRoadDefinition(live, cloneRoadValue(options.preEditSnapshot));
                proposalStorage?._indexProposal?.(live);
            }
        }
        return await ProposalManager.runParcelMutation(
            'corridor-edit',
            proposalIdOrHash,
            transactionOptions => runLocalCorridorGeometryUpdate(
                proposalIdOrHash,
                mutateDefinition,
                { ...options, ...transactionOptions }
            )
        );
    } catch (error) {
        console.warn('[updateLocalCorridorGeometry] road edit failed', error);
        // Say why: the refusal in the author's words when the edit has one, else what went wrong, so
        // the message (a click copies it) is enough for a report.
        const reason = String(error?.userMessage || error?.message || '').trim();
        const reverted = reason
            ? translateRoadText('panel.road.editRevertedReason', 'Could not complete that road change — reverted: {{reason}}', { reason })
            : translateRoadText('panel.road.editRevertedStatus', 'Could not complete that road change — reverted.');
        if (typeof updateStatus === 'function') updateStatus(reverted);
        if (typeof options.onFailure === 'function') {
            try { options.onFailure(error?.userMessage || reverted); } catch (_) { }
        }
        return false;
    } finally {
        endApplyIndicator();
    }
}

async function runLocalCorridorGeometryUpdate(proposalIdOrHash, mutateDefinition, options = {}) {
    const mutation = options._parcelMutation;
    const store = mutation?.proposals;
    const sourceProposal = store?.findProposalByIdOrHash?.(proposalIdOrHash)
        || store?.getProposal?.(String(proposalIdOrHash));
    if (!sourceProposal?.roadProposal?.definition || !store) {
        throw Object.assign(new Error(`Road ${proposalIdOrHash} is not in this city's proposals`), {
            userMessage: translateRoadText('panel.road.editNotFound',
                'This road is not among the designs of the city on the map. Switch to the city it was created in, then try again.')
        });
    }

    const sourceKey = String(
        (typeof getProposalKey === 'function' ? getProposalKey(sourceProposal) : null)
        || sourceProposal.proposalId
        || proposalIdOrHash
    );
    const originalDefinition = cloneRoadValue(sourceProposal.roadProposal.definition);
    const workingDefinition = cloneRoadValue(sourceProposal.roadProposal.definition);
    if (typeof mutateDefinition === 'function') mutateDefinition(workingDefinition);
    const sourceBefore = cloneRoadValue(sourceProposal);
    const extraStretchIds = [];

    try {
        if (JSON.stringify(workingDefinition) === JSON.stringify(originalDefinition)) {
            mutation.afterCommit(() => ProposalManager._refreshUIAfterProposalChange?.(
                typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal?.(sourceKey) : null
            ));
            return true;
        }
    } catch (_) { }

    const sourceWasApplied = (typeof isProposalApplied === 'function')
        ? isProposalApplied(sourceProposal)
        : sourceProposal.applied === true;
    const candidateSegments = ((typeof corridorCenterlineOf === 'function')
        ? corridorCenterlineOf(workingDefinition)
        : [])
        .map(segment => segment.map(point => ({ ...point, lat: point.lat, lng: point.lng })));
    const candidateIds = Array.isArray(workingDefinition.segmentIds)
        ? workingDefinition.segmentIds
        : [];
    // Filter geometry and identity as PAIRS. Filtering the segments first and then slicing the id
    // array reassigned every later id/profile when an empty middle stretch was removed.
    const normalizedEntries = candidateSegments
        .map((segment, index) => ({ segment, id: candidateIds[index] ?? null }))
        .filter(entry => entry.segment.length >= 2);
    let normalizedSegments = normalizedEntries.map(entry => entry.segment);
    let normalizedIds = normalizedEntries.map(entry => entry.id);

    if (!normalizedSegments.length) {
        if (typeof setProposalApplied === 'function') {
            setProposalApplied(sourceProposal, false, { stamp: false });
        } else {
            sourceProposal.applied = false;
        }
        store._indexProposal?.(sourceProposal);
        store.save?.();
        if (sourceWasApplied) {
            const derived = await ProposalManager.rematerializeCorridorScope?.(
                [sourceBefore, sourceProposal],
                { _parcelMutation: mutation }
            );
            if (!derived || derived.ok !== true) throw new Error('The erased road scope could not be rematerialised.');
        }
        mutation.afterCommit(() => {
            try { window.ProposalSelection?.clear?.(); } catch (_) { }
            try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }
            ProposalManager._refreshUIAfterProposalChange?.(null);
        });
        return true;
    }

    workingDefinition.tunnels = rekeyMovedTunnelRecords(
        originalDefinition,
        normalizedSegments,
        workingDefinition.tunnels
    );
    if (typeof retainLiveCorridorTunnelRecords === 'function') {
        workingDefinition.tunnels = retainLiveCorridorTunnelRecords(
            normalizedSegments,
            workingDefinition.tunnels || []
        );
    }
    if (typeof retainLiveGradeSeparations === 'function') {
        workingDefinition.gradeSeparations = retainLiveGradeSeparations(
            normalizedSegments,
            workingDefinition.gradeSeparations || []
        );
    }

    // Stored geometry is authoritative. Crossings are split into graph nodes, but an edit never
    // moves unrelated near-miss vertices or fuses nearby stretches as a live "healing" pass.
    normalizeCorridorGraph(
        normalizedSegments,
        normalizedIds,
        corridorProtectedEdgeKeySet(
            workingDefinition.tunnels,
            workingDefinition.gradeSeparations
        ),
        workingDefinition.segmentProfiles || null
    );

    if (!normalizedSegments.length) return false;
    workingDefinition.points = normalizedSegments;
    workingDefinition.segments = normalizedSegments;
    workingDefinition.segmentIds = normalizedIds;
    if (workingDefinition.segmentProfiles) {
        const liveIds = new Set(normalizedIds.filter(Boolean).map(String));
        Object.keys(workingDefinition.segmentProfiles).forEach(id => {
            if (!liveIds.has(String(id))) delete workingDefinition.segmentProfiles[id];
        });
    }
    // A road placed into a parcel keeps the parcel as its land (docs/road-in-parcel.md): its
    // pavements and verges re-fill the room the edit leaves, and an edit that moves it off the
    // parcel or leaves its lanes too little room is refused and rolled back.
    const siteFit = (typeof window !== 'undefined') ? window.__corridorSiteFit : null;
    if (siteFit && siteFit.isBounded(workingDefinition)) {
        Object.assign(workingDefinition, siteFit.refitBounded(workingDefinition));
        const issue = siteFit.boundedRoadIssues(workingDefinition)[0];
        if (issue) throw Object.assign(new Error(`bounded road refused: ${issue.code}`), { userMessage: boundedRoadRefusal(issue) });
    }
    rebuildRoadDefinitionFootprint(workingDefinition);
    if (!workingDefinition.polygon) return false;

    // Ruling 2026-08-07: a road proposal is ONE contiguous stretch. An authored edit that
    // disconnects the graph SPLITS into one proposal per connected component — self-crossings
    // and branches node into a single component and stay one road. (An earlier split attempt
    // was reverted for losing per-stretch metadata; here everything rides with its component:
    // the full source record is cloned per stretch, id-keyed profiles filter to the stretch's
    // segment ids, edge-keyed tunnels/grade-separations retain against its points.)
    const componentIndexSets = (typeof window.__formationEdit?.corridorComponents === 'function')
        ? window.__formationEdit.corridorComponents(normalizedSegments)
        : [normalizedSegments.map((_, index) => index)];
    // A road in a parcel holds the whole parcel; two pieces of it cannot both hold it.
    if (componentIndexSets.length > 1 && siteFit && siteFit.isBounded(workingDefinition)) {
        throw Object.assign(new Error('bounded road refused: split'), {
            userMessage: translateRoadText('panel.road.boundedSplit',
                'A road in a parcel stays one connected network: it holds the whole parcel. Undo, or delete the road and place it again.')
        });
    }
    const componentDefinitions = componentIndexSets.length > 1
        ? componentIndexSets.map(indices => {
            const definition = cloneRoadValue(workingDefinition);
            definition.points = indices.map(i => normalizedSegments[i]);
            definition.segments = definition.points;
            definition.segmentIds = indices.map(i => normalizedIds[i] ?? null);
            if (definition.segmentProfiles) {
                const liveIds = new Set(definition.segmentIds.filter(Boolean).map(String));
                Object.keys(definition.segmentProfiles).forEach(id => {
                    if (!liveIds.has(String(id))) delete definition.segmentProfiles[id];
                });
            }
            if (typeof retainLiveCorridorTunnelRecords === 'function') {
                definition.tunnels = retainLiveCorridorTunnelRecords(definition.points, definition.tunnels || []);
            }
            if (typeof retainLiveGradeSeparations === 'function') {
                definition.gradeSeparations = retainLiveGradeSeparations(definition.points, definition.gradeSeparations || []);
            }
            rebuildRoadDefinitionFootprint(definition);
            return definition;
        }).filter(definition => definition.polygon)
        : [workingDefinition];
    if (!componentDefinitions.length) return false;

    const wasSelected = typeof window.ProposalSelection?.is === 'function'
        && window.ProposalSelection.is(sourceKey);

    // A published or minted road is immutable (proposals/lineage.js editsInPlace): the edit is saved
    // as a counterproposal carrying the edited land, through the same atomic transaction as a newly
    // drawn road, and the published road stays as it is. The counterproposal is selected, so the
    // next edit lands on it, in place.
    if (window.ProposalLineage?.isPublished?.(sourceProposal)) {
        const forkIds = [];
        const revisedIds = [];
        for (const [index, definition] of componentDefinitions.entries()) {
            const fork = makeFreshRoadSnapshot(sourceProposal, definition, { sourceLocalProposalId: sourceKey });
            if (index > 0) {
                fork.title = `${fork.title || fork.name || 'Road'} (${index + 1})`;
                if (fork.name) fork.name = fork.title;
            }
            const created = await ProposalManager.createCorridorProposalAtomically(fork, { _parcelMutation: mutation });
            if (!created?.ok || !created.proposalId) {
                throw Object.assign(new Error(created?.reason || 'Could not save the counterproposal.'), {
                    userMessage: created?.reason || null
                });
            }
            forkIds.push(String(created.proposalId));
            revisedIds.push(...(created.topology?.revisedProposalIds || []));
        }
        mutation.afterCommit(() => {
            const storedRecord = id => (typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal?.(id) : null);
            [...forkIds, ...revisedIds].forEach(id => ProposalManager._refreshUIAfterProposalChange?.(storedRecord(id)));
            ProposalManager._reportJunctionRevisions?.(revisedIds.map(storedRecord));
            if (typeof updateStatus === 'function') {
                updateStatus(translateRoadText('panel.road.savedAsCounterproposal',
                    'The published road stays as it is; your edit was saved as a counterproposal.'));
            }
            if (wasSelected && typeof selectAndHighlightProposal === 'function') {
                try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
                selectAndHighlightProposal(forkIds[0], null, false, true);
            }
        });
        return forkIds[0];
    }

    // One's own local road is edited IN PLACE: the same record, the same id. Nothing local needs
    // protecting from its own author; an edit that minted a new id on every node drag also made a
    // chain of replaced records per drag and an editor that reasoned about provenance at all.
    writeRoadDefinition(sourceProposal, componentDefinitions[0]);
    // The land may now reach parcels it did not when the road was drawn — a widening, a
    // transition zone, the corner land of a new junction. The rebuild cuts only the parcels the
    // record DECLARES, so they are declared here, or the take the editor just announced never
    // happens (found 2026-10-15: a 67 m² widening onto a neighbour left the neighbour whole).
    // Never dropped: the live fabric holds only the loaded viewport, so a declared parcel that is
    // not under the new land here may simply be out of view.
    declareParcelsUnderRoadLand(sourceProposal, componentDefinitions[0].polygon);
    store._indexProposal?.(sourceProposal);

    // A disconnected remainder is a different road, not a different version of this one, so it
    // is the one thing here that really does become a new record.
    componentDefinitions.slice(1).forEach((definition, index) => {
        const stretch = makeFreshRoadSnapshot(sourceProposal, definition, {
            sourceLocalProposalId: sourceKey
        });
        const baseTitle = stretch.title || stretch.name || 'Road';
        stretch.title = `${baseTitle} (${index + 2})`;
        if (stretch.name) stretch.name = stretch.title;
        const id = store.addProposal(stretch);
        if (!id) throw new Error('Could not persist the split-off road stretch.');
        extraStretchIds.push(String(id));
        const stored = store.getProposal(id) || stretch;
        if (typeof setProposalApplied === 'function') {
            setProposalApplied(stored, sourceWasApplied, { stamp: sourceWasApplied });
        } else {
            stored.applied = sourceWasApplied;
        }
        store._indexProposal?.(stored);
    });
    // An applied edit authors the connected junctions too. Their peer profiles are snapshots used
    // by land and taper construction, so merely rebuilding the edited ribbon leaves stale ends in
    // its neighbours. Plan and publish these changes inside this same parcel mutation.
    const junctionPeersBefore = new Map();
    const junctionPeersAfter = new Map();
    // Published peers that got a new version: the published record, now off the map, and its revision.
    const revisedPeers = [];
    const stoodDownRevisions = sourceWasApplied && typeof ProposalManager._standDownAppliedRivals === 'function'
        ? ProposalManager._standDownAppliedRivals(sourceProposal, { _parcelMutation: mutation, replaceOccupiedGround: true })
        : [];
    // Shared-node drags and undo restore several roads in sequence. Their stored junctions move
    // with the vertices; discovering crossings before every leg lands would author transient nodes.
    if (sourceWasApplied && !window.CorridorNetworkNodes?.isDeferred?.()) {
        const authoring = window.CorridorAuthoring
            || (typeof require === 'function' ? require('./proposals/corridor-authoring.js') : null);
        if (!authoring?.planCorridorEdit) throw new Error('Corridor junction authoring is unavailable.');
        const editedIds = new Set([sourceKey, ...extraStretchIds]);
        for (const id of editedIds) {
            const edited = store.getProposal(id);
            const records = store.peekAllProposals?.() || store.getAllProposals();
            const planned = authoring.planCorridorEdit(id === sourceKey ? sourceBefore : edited, edited, records, {
                geometry: window.CorridorGeometry,
                centerlineOf: corridorCenterlineOf,
                isTrack: corridorIsTrack,
                isApplied: record => isApplied(record, record?.roadProposal),
                protectedEdgeKeysOf: definition => corridorProtectedEdgeKeySet(definition?.tunnels, definition?.gradeSeparations)
            });
            for (const change of [{ proposalId: id, definition: planned.proposal.roadProposal.definition }, ...planned.existingChanges]) {
                const target = store.getProposal(change.proposalId);
                if (!target?.roadProposal?.definition) throw new Error('A connected road disappeared during junction editing.');
                const peer = !editedIds.has(String(change.proposalId));
                if (peer && !junctionPeersBefore.has(String(change.proposalId))) {
                    junctionPeersBefore.set(String(change.proposalId), cloneRoadValue(target));
                }
                const definition = cloneRoadValue(change.definition);
                rebuildRoadDefinitionFootprint(definition);
                if (!definition.polygon) throw new Error('A connected road has no land after junction editing.');
                if (peer && window.ProposalLineage?.isPublished?.(target)) {
                    const revision = reviseRoadForJunction(store, target, definition);
                    junctionPeersAfter.set(String(change.proposalId), target);
                    junctionPeersAfter.set(String(revision.proposalId), revision);
                    revisedPeers.push(revision);
                    continue;
                }
                writeRoadDefinition(target, definition);
                declareParcelsUnderRoadLand(target, definition.polygon);
                if (peer) junctionPeersAfter.set(String(change.proposalId), target);
                target.updatedAt = new Date().toISOString();
                store._indexProposal?.(target);
            }
        }
    }
    store.save?.();

    // Old and new footprints provide the exact local corridor scope. Only the edited road's
    // output is discarded; corridor arrangement is recomputed there and nowhere else.
    if (sourceWasApplied) {
        const editedRecords = [sourceKey, ...extraStretchIds]
            .map(id => store.getProposal(id))
            .filter(Boolean);
        const derived = await ProposalManager.rematerializeCorridorScope?.(
            [sourceBefore, ...stoodDownRevisions, ...junctionPeersBefore.values(), ...editedRecords, ...junctionPeersAfter.values()],
            { _parcelMutation: mutation }
        );
        if (!derived || derived.ok !== true) {
            // The arrangement names what it could not place; that is the reason the author reads.
            const reasons = [...new Set((derived?.failed || []).map(failure => failure?.message || failure?.code).filter(Boolean))];
            throw Object.assign(new Error('The edited road scope could not be rematerialised from the cadastre.'
                + (reasons.length ? ` ${reasons.join(' ')}` : '')), { userMessage: reasons.join(' ') || null });
        }
    }

    const primaryId = sourceKey;
    mutation.afterCommit(() => {
        const storedReplacement = typeof proposalStorage !== 'undefined'
            ? (proposalStorage.getProposal(primaryId) || sourceProposal)
            : sourceProposal;
        if (componentDefinitions.length > 1 && typeof updateStatus === 'function') {
            updateStatus(translateRoadText(
                'panel.road.splitIntoStretches',
                'The edit disconnected the road — it was split into {{count}} separate road designs.',
                { count: componentDefinitions.length }
            ));
        }
        ProposalManager._refreshUIAfterProposalChange?.(storedReplacement);
        revisedPeers.forEach(record => ProposalManager._refreshUIAfterProposalChange?.(record));
        ProposalManager._reportJunctionRevisions?.(revisedPeers);
        if (wasSelected && typeof selectAndHighlightProposal === 'function') {
            try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
            selectAndHighlightProposal(primaryId, null, false, true);
        }
    });
    return String(primaryId);
}

// ---------------------------------------------------------------------------
// Snapping — how road segments get connected to one another, and to what already exists.
//
// Clicking within ROAD_SNAP_PIXELS of an existing vertex reuses that exact vertex, so the two
// segments share a node (OSM's only notion of connectivity). Clicking near the *middle* of an
// existing segment inserts a node there first, turning it into a shared node — an OSM T-join.
// Clicking near a segment's *endpoint* while the pen is up resumes that segment instead of starting
// a new one, which is how a road drawn in an earlier session — or before Escape lifted the pen —
// gets continued. Applied roads and tracks (either kind: a tram crossing a road shares the node)
// and the city's existing streets (the /osm-road centre lines) are snap targets too; the nearest
// target wins, a node by a margin (CorridorGeometry.pickSnapTarget). Alt held snaps to nothing.
// ---------------------------------------------------------------------------
// Touch fingers land ~2× less precisely than a cursor — with the mouse-calibrated 12 px,
// mobile users constantly missed node snaps and built near-miss disconnected junctions.
const ROAD_SNAP_PIXELS = (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) ? 26 : 12;
let roadSnapMarker = null;
const ROAD_DRAWING_MARKER_PANE = 'road-snap';

function ensureRoadDrawingMarkerPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(ROAD_DRAWING_MARKER_PANE);
    if (!pane && typeof map.createPane === 'function') pane = map.createPane(ROAD_DRAWING_MARKER_PANE);
    if (pane && pane.style) {
        pane.style.zIndex = '675';
        // Vertex and snap rings are guides, not controls. Clicks must reach the map so clicking the
        // first vertex can close a loop and so this high pane can never block parcel interaction.
        pane.style.pointerEvents = 'none';
    }
    return pane ? ROAD_DRAWING_MARKER_PANE : null;
}

// Closest point to `p` on the pixel segment ab, clamped to the segment.
// projectPointOnPixelSegment + the snap priority ladder (pickSnapTarget) moved to
// frontend/js/corridor-geometry.js (loaded first) — pure pixel-space geometry, now unit-tested.

// Nearest snap candidate to `latlng`, or null. A vertex wins over an edge it is not much farther
// than: a click near a corner should join that corner rather than plant a second node a few
// centimetres along one of its edges. Applied corridors of EITHER kind are snap targets — a road
// meets a tram line at a level crossing that shares the node, as in OSM. The click records the
// exact shared coordinate; Finish atomically inserts that node into the touched existing record.
//
// Like the streets below, only segments whose box reaches the cursor's snap box (`box`, from
// roadSnapBoxNear) are returned; without one, every applied segment is.
function appliedCorridorSnapSegments(box = null) {
    const entries = [];
    try {
        (proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            const proposalId = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
            corridorSnapSegmentsOf(definition).forEach(({ segment, bbox }) => {
                if (!box || bboxReachesRoadSnapBox(bbox, box)) entries.push({ segment, proposalId });
            });
        });
    } catch (_) { }
    return entries;
}

// A definition's centre line with each segment's [west, south, east, north] box, cached per definition
// so a mousemove neither rebuilds every applied road's points nor scans them. An edit makes a new
// definition object (records are not mutated); the stored source array and its length are checked
// as well, so an entry is never reused for geometry it was not built from.
const corridorSnapSegmentCache = new WeakMap();
function corridorSnapSegmentsOf(definition) {
    const source = (Array.isArray(definition.points) && definition.points.length && definition.points)
        || definition.segments || null;
    const cached = corridorSnapSegmentCache.get(definition);
    if (cached && cached.source === source && cached.length === (source ? source.length : 0)) return cached.segments;
    const segments = (corridorCenterlineOf(definition) || [])
        .filter(segment => Array.isArray(segment) && segment.length >= 2)
        .map(segment => {
            const bbox = [Infinity, Infinity, -Infinity, -Infinity];
            segment.forEach(point => {
                if (point.lng < bbox[0]) bbox[0] = point.lng;
                if (point.lat < bbox[1]) bbox[1] = point.lat;
                if (point.lng > bbox[2]) bbox[2] = point.lng;
                if (point.lat > bbox[3]) bbox[3] = point.lat;
            });
            return { segment, bbox };
        });
    corridorSnapSegmentCache.set(definition, { source, length: source ? source.length : 0, segments });
    return segments;
}

// The geographic box `radiusPx` around a cursor in layer pixels: what a snap candidate must reach.
function roadSnapBoxNear(cursor, radiusPx) {
    const sw = map.layerPointToLatLng(L.point(cursor.x - radiusPx, cursor.y + radiusPx));
    const ne = map.layerPointToLatLng(L.point(cursor.x + radiusPx, cursor.y - radiusPx));
    return { sw, ne };
}

function bboxReachesRoadSnapBox(bbox, box) {
    return bbox[0] <= box.ne.lng && bbox[2] >= box.sw.lng && bbox[1] <= box.ne.lat && bbox[3] >= box.sw.lat;
}

// The existing streets near the cursor, as snap candidates: the /osm-road centre lines the
// legacy-road-centerlines.js loader keeps for the viewport whether or not that layer is shown.
// Only lines whose box reaches the cursor's snap box are projected, so a viewport of thousands of
// streets costs a handful of projections per mousemove.
function streetSnapLinesNear(cursor, radiusPx) {
    const loader = (typeof window !== 'undefined') ? window.LegacyRoadCenterlines : null;
    const lines = loader && typeof loader.snapLines === 'function' ? loader.snapLines() : [];
    if (!lines.length) return [];
    const box = roadSnapBoxNear(cursor, radiusPx);
    return lines.filter(line => bboxReachesRoadSnapBox(line.bbox, box));
}

// Alt held places the point exactly where the pointer is (site-drawing.js does the same).
function roadSnapSuppressed(event) {
    return !!(event && event.originalEvent && event.originalEvent.altKey);
}

function findRoadSnapTarget(latlng) {
    if (typeof map === 'undefined' || !map || !latlng) return null;
    const cursor = map.latLngToLayerPoint(latlng);
    const cursorPx = { x: cursor.x, y: cursor.y };
    const activeIndex = roadHasStarted ? roadSegments.indexOf(roadPoints) : -1;

    // Project every candidate vertex to screen pixels; the pure ladder decides the winner.
    const toPx = (v) => { const pt = map.latLngToLayerPoint(v); return { x: pt.x, y: pt.y }; };
    const localSegments = roadSegments.map(seg => (Array.isArray(seg) ? seg : []).map(toPx));
    const externalEntries = appliedCorridorSnapSegments(roadSnapBoxNear(cursorPx, ROAD_SNAP_PIXELS));
    const externalSegments = externalEntries.map(e => ({ points: e.segment.map(toPx) }));
    const streetLines = streetSnapLinesNear(cursorPx, ROAD_SNAP_PIXELS);
    const streetSegments = streetLines.map(line => ({ points: line.points.map(toPx), name: line.name, wayId: line.wayId }));

    const raw = window.CorridorGeometry.pickSnapTarget(
        cursorPx, localSegments, externalSegments, activeIndex, ROAD_SNAP_PIXELS, streetSegments
    );
    if (!raw) return null;

    // Resolve the pixel result back to a latlng and the original return shape. Vertex snaps reuse
    // the exact original vertex latlng.
    //
    // Edge snaps must land ON the edge, not near it. Unprojecting the projected pixel point (what
    // this used to do) is only pixel-accurate — a decimetre or two of real ground at a working zoom
    // — so the new road ENDED BESIDE the one it snapped to rather than on it. Nothing crosses, so
    // no shared node is inserted and the T is a T only on screen. Pixels still choose where along
    // the edge the point goes; the point itself is interpolated on the geographic edge.
    const pixelToLatLng = (px) => map.layerPointToLatLng(L.point(px.x, px.y));
    const exactPointOnEdge = (from, to, px) => {
        const a = map.latLngToLayerPoint(from);
        const b = map.latLngToLayerPoint(to);
        const abX = b.x - a.x;
        const abY = b.y - a.y;
        const lengthSq = abX * abX + abY * abY;
        if (lengthSq < 1e-9) return L.latLng(from.lat, from.lng);
        let t = ((px.x - a.x) * abX + (px.y - a.y) * abY) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return L.latLng(from.lat + t * (to.lat - from.lat), from.lng + t * (to.lng - from.lng));
    };

    if (raw.source === 'local') {
        if (raw.kind === 'edge') {
            const segment = roadSegments[raw.segmentIndex] || [];
            const from = segment[raw.insertAfter];
            const to = segment[raw.insertAfter + 1];
            const latlng = (from && to) ? exactPointOnEdge(from, to, raw.pixel) : pixelToLatLng(raw.pixel);
            return { distance: raw.distance, latlng, segmentIndex: raw.segmentIndex, insertAfter: raw.insertAfter, type: 'edge', source: 'local' };
        }
        const vertex = roadSegments[raw.segmentIndex][raw.vertexIndex];
        return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), segmentIndex: raw.segmentIndex, vertexIndex: raw.vertexIndex, type: raw.kind, atStart: raw.atStart, source: 'local' };
    }

    // An existing street: its exact vertex, or the point ON its centre line (same metre-accurate
    // interpolation as an applied corridor's edge). Nothing is noded into it — it is not a record —
    // but the click remembers which street it joined (roadStreetConnections).
    if (raw.source === 'street') {
        const line = streetLines[raw.streetIndex];
        if (raw.kind === 'street-edge') {
            const from = line.points[raw.insertAfter];
            const to = line.points[raw.insertAfter + 1];
            const latlng = (from && to) ? exactPointOnEdge(from, to, raw.pixel) : pixelToLatLng(raw.pixel);
            return { distance: raw.distance, latlng, type: 'street-edge', source: 'street', wayId: line.wayId, name: line.name };
        }
        const vertex = line.points[raw.vertexIndex];
        return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), type: 'street-node', source: 'street', wayId: line.wayId, name: line.name };
    }

    const entry = externalEntries[raw.externalIndex];
    if (raw.kind === 'external-edge') {
        const from = entry.segment[raw.insertAfter];
        const to = entry.segment[raw.insertAfter + 1];
        const latlng = (from && to) ? exactPointOnEdge(from, to, raw.pixel) : pixelToLatLng(raw.pixel);
        return { distance: raw.distance, latlng, type: 'external-edge', source: 'external', proposalId: entry.proposalId };
    }
    const vertex = entry.segment[raw.vertexIndex];
    return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), type: raw.kind, source: 'external', proposalId: entry.proposalId };
}

function clearRoadSnapMarker() {
    if (roadSnapMarker && typeof map !== 'undefined' && map && map.hasLayer(roadSnapMarker)) {
        map.removeLayer(roadSnapMarker);
    }
    roadSnapMarker = null;
}

// "Snaps to Ulica X" — which existing street the click would land on.
function roadStreetSnapLabel(snap) {
    const name = snap && typeof snap.name === 'string' ? snap.name.trim() : '';
    return name
        ? translateRoadText('panel.road.snapsToStreet', 'Snaps to {{name}}', { name })
        : translateRoadText('panel.road.snapsToUnnamedStreet', 'Snaps to an existing street');
}

function showRoadSnapMarker(snap) {
    const latlng = snap && snap.latlng ? snap.latlng : null;
    if (!latlng) {
        clearRoadSnapMarker();
        return;
    }
    // Snapping onto a placed road reads differently from snapping onto this drawing's own segments:
    // a bigger blue ring says "click to form an exact junction". An existing street gets the purple
    // of its reference layer, and its name beside the ring.
    const street = snap.source === 'street';
    const external = snap.type === 'external-endpoint' || snap.type === 'external-node' || snap.type === 'external-edge';
    const style = street
        ? { radius: 11, color: '#8a63d2', weight: 3, fillColor: '#ffffff', fillOpacity: 0.9 }
        : external
            ? { radius: 11, color: '#2563eb', weight: 3, fillColor: '#ffffff', fillOpacity: 0.9 }
            : { radius: 8, color: '#006400', weight: 2, fillColor: '#ffffff', fillOpacity: 0.9 };
    if (roadSnapMarker) {
        roadSnapMarker.setLatLng(latlng);
        try {
            roadSnapMarker.setStyle(style);
            roadSnapMarker.setRadius(style.radius);
        } catch (_) { }
    } else {
        // Its own pane above the corridor strips and hit targets — a snap ring under the asphalt
        // is invisible exactly when it matters (snapping onto a road).
        const pane = ensureRoadDrawingMarkerPane();
        roadSnapMarker = L.circleMarker(latlng, {
            ...style,
            interactive: false,
            ...(pane ? { pane } : {})
        }).addTo(map);
    }
    const label = street ? roadStreetSnapLabel(snap) : null;
    if (label) {
        if (roadSnapMarker.getTooltip()) roadSnapMarker.setTooltipContent(label);
        else roadSnapMarker.bindTooltip(label, { permanent: true, direction: 'right', offset: [12, 0], className: 'road-snap-label' });
    } else if (roadSnapMarker.getTooltip()) {
        roadSnapMarker.unbindTooltip();
    }
}

function createRoadVertexMarker(latlng) {
    const pane = ensureRoadDrawingMarkerPane();
    const marker = L.circleMarker(latlng, {
        radius: 5,
        color: 'green',
        fillColor: '#00ff00',
        fillOpacity: 1,
        interactive: false,
        ...(pane ? { pane } : {})
    }).addTo(map);
    return marker;
}

// Markers are cosmetic, so rather than tracking which marker belongs to which vertex (which resuming
// and mid-segment insertion would both invalidate) just rebuild them from the segments.
function redrawRoadVertexMarkers() {
    roadMarkers.forEach(marker => {
        if (marker && map.hasLayer(marker)) map.removeLayer(marker);
    });
    roadMarkers = [];
    getAllRoadSegments(true).forEach(segment => {
        segment.forEach(vertex => roadMarkers.push(createRoadVertexMarker(vertex)));
    });
}

// The corridor's cross-section, drawn inside the corridor outline while the road is being drawn.
// Rebuilt on commit only — never on mousemove, where the rubber-band preview stays a plain outline.
let roadStripLayer = null;

function clearRoadStripLayer(preserveJunctionPreview = false) {
    if (roadStripLayer && map.hasLayer(roadStripLayer)) map.removeLayer(roadStripLayer);
    roadStripLayer = null;
    if (!preserveJunctionPreview && typeof setCorridorDrawingJunctionPreview === 'function') {
        setCorridorDrawingJunctionPreview([]);
    }
}

// The arms of applied corridors at the nodes the drawing shares with them, for the junction preview.
// A drawing vertex meets an applied centre line either AT one of its vertices (1e-7°, the precision
// of the edge keys) or part-way along one of its edges — a T snapped onto the middle of a road, whose
// node Finish inserts into that record (corridor-authoring.js). Each meeting yields a short arm
// piece around the drawing's exact vertex: [previous, shared, next] of the applied centre line, so
// the junction builder sees the applied road's real arm directions and profile there and nothing of
// its other junctions. Pure: drawingSegments [[{lat,lng}]], appliedEntries [{points, profile,
// corridorId}] → [{points, profile, corridorId}].
function appliedArmsMeetingDrawing(drawingSegments, appliedEntries) {
    const NODE_DEG = 1e-7;
    const ON_EDGE_M = 0.01;
    const levelOf = point => typeof point?.level === 'number' && Number.isFinite(point.level) ? point.level : 0;
    const vertices = [];
    const seen = new Set();
    (drawingSegments || []).forEach(segment => (Array.isArray(segment) ? segment : []).forEach(point => {
        const lat = Number(point && point.lat);
        const lng = Number(point && point.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const key = `${lat.toFixed(7)},${lng.toFixed(7)}#${levelOf(point)}`;
        if (seen.has(key)) return;
        seen.add(key);
        vertices.push(typeof point.level === 'number' && Number.isFinite(point.level) ? { lat, lng, level: point.level } : { lat, lng });
    }));
    const arms = [];
    (appliedEntries || []).forEach(entry => {
        const points = Array.isArray(entry && entry.points) ? entry.points : [];
        if (points.length < 2) return;
        vertices.forEach(vertex => {
            const metresPerDegLng = 111320 * Math.cos(vertex.lat * Math.PI / 180);
            for (let i = 0; i < points.length; i += 1) {
                const point = points[i];
                if (levelOf(point) === levelOf(vertex)
                    && Math.abs(point.lat - vertex.lat) < NODE_DEG && Math.abs(point.lng - vertex.lng) < NODE_DEG) {
                    const piece = [];
                    if (i > 0) piece.push(points[i - 1]);
                    piece.push(vertex);
                    if (i < points.length - 1) piece.push(points[i + 1]);
                    arms.push({ points: piece, profile: entry.profile, corridorId: entry.corridorId });
                    return;
                }
            }
            for (let i = 0; i < points.length - 1; i += 1) {
                // In metres on a plane through the edge's start: the edge is a→b, the vertex p.
                const a = points[i];
                const b = points[i + 1];
                if (levelOf(a) !== levelOf(vertex) || levelOf(b) !== levelOf(vertex)) continue;
                const bx = (b.lng - a.lng) * metresPerDegLng;
                const by = (b.lat - a.lat) * 111320;
                const px = (vertex.lng - a.lng) * metresPerDegLng;
                const py = (vertex.lat - a.lat) * 111320;
                const lengthSq = bx * bx + by * by;
                if (!(lengthSq > 0)) continue;
                const t = (px * bx + py * by) / lengthSq;
                if (t <= 1e-6 || t >= 1 - 1e-6) continue;
                if (Math.hypot(px - t * bx, py - t * by) > ON_EDGE_M) continue;
                arms.push({ points: [a, vertex, b], profile: entry.profile, corridorId: entry.corridorId });
                return;
            }
        });
    });
    return arms;
}

// The applied corridors (roads and tracks alike) whose centre lines reach the drawing, as junction
// arms (appliedArmsMeetingDrawing). Only corridors whose box touches the drawing's box are looked at.
function appliedJunctionArmsForDrawing(entries) {
    const drawing = (entries || []).map(entry => entry.points);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    drawing.forEach(points => points.forEach(point => {
        box[0] = Math.min(box[0], point.lng); box[1] = Math.min(box[1], point.lat);
        box[2] = Math.max(box[2], point.lng); box[3] = Math.max(box[3], point.lat);
    }));
    if (!(box[0] <= box[2])) return [];
    const pad = 1e-6;
    const applied = [];
    try {
        (proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition || !isApplied(proposal, proposal.roadProposal)) return;
            const segmentEntries = typeof corridorJunctionEntriesFor === 'function'
                ? corridorJunctionEntriesFor(proposal, definition)
                : corridorSegmentEntries(definition);
            const own = [Infinity, Infinity, -Infinity, -Infinity];
            segmentEntries.forEach(entry => (entry.points || []).forEach(point => {
                own[0] = Math.min(own[0], point.lng); own[1] = Math.min(own[1], point.lat);
                own[2] = Math.max(own[2], point.lng); own[3] = Math.max(own[3], point.lat);
            }));
            if (own[0] > box[2] + pad || own[2] < box[0] - pad || own[1] > box[3] + pad || own[3] < box[1] - pad) return;
            const corridorId = String((typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId);
            segmentEntries.forEach(entry => {
                if (entry.profile) applied.push({ points: entry.points, profile: entry.profile, corridorId });
            });
        });
    } catch (error) {
        console.warn('[road-drawing] applied corridors could not join the junction preview', error);
        return [];
    }
    return appliedArmsMeetingDrawing(drawing, applied);
}

function redrawRoadStrips() {
    clearRoadStripLayer(true);
    // Without a cross-section the corridor keeps its plain green fill; with one, the fill would hide
    // the strips, so the corridor becomes an outline around them.
    const restoreCorridorFill = () => {
        if (roadPolygonLayer) roadPolygonLayer.setStyle({ fillOpacity: 0.3 });
    };
    if (!roadProfile || typeof buildCorridorStrips !== 'function') {
        if (typeof setCorridorDrawingJunctionPreview === 'function') setCorridorDrawingJunctionPreview([]);
        return restoreCorridorFill();
    }

    // Drawing and applied corridors share the same non-interactive render panes. These calls used
    // to omit `pane`, creating a second canvas in Leaflet's default overlayPane. Once the drawing
    // finished all of its paths were removed, but Leaflet kept that empty canvas above the parcel
    // canvas and it caught every map click. corridorCanvasFor() now also refuses a missing pane.
    ensureCorridorStripsPane();
    ensureCorridorJunctionsPane();
    ensureCorridorMarkingsPane();

    // Seeded segments keep their cross-section; only segments without an override use the tool profile.
    const entries = getAllRoadSegments(true)
        .map((segment, index) => ({
            segmentId: roadSegmentIds[index] ?? null,
            points: segment,
            profile: roadDrawingSegmentOverride(index) || roadProfile,
            corridorId: 'active-drawing'
        }))
        .filter(entry => Array.isArray(entry.points) && entry.points.length >= 2);
    if (!entries.length) {
        if (typeof setCorridorDrawingJunctionPreview === 'function') setCorridorDrawingJunctionPreview([]);
        return restoreCorridorFill();
    }

    // Same renderer as applied corridors — see js/corridor-render.js — in the session's frame. The
    // drawing iterates PIECES like they do: each stretch's body plus the transition zones where its
    // cross-section tapers to a neighbour's (corridorRenderPieces), so a width change previews
    // exactly as it will look once built.
    const frame = roadSessionFrame();
    const group = L.layerGroup();
    let drewAny = false;
    const pieces = (typeof corridorRenderPieces === 'function')
        ? corridorRenderPieces(entries, frame)
        : entries.map(entry => ({ ...entry, taper: null }));
    // The junction with the road being snapped onto is drawn while drawing, not only once the road
    // is built: applied corridors that share a node with the drawing join the JUNCTION pass (never
    // the strips or markings, which they draw themselves) as short arms around each shared node,
    // and only junctions the drawing takes part in are kept, so none of theirs is drawn twice.
    const appliedArms = appliedJunctionArmsForDrawing(entries);
    const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
        ? buildCorridorJunctionTreatmentsForEntries(pieces.concat(appliedArms), frame)
            .filter(junction => !Array.isArray(junction.corridorIds) || junction.corridorIds.includes('active-drawing'))
        : [];
    if (typeof setCorridorDrawingJunctionPreview === 'function') setCorridorDrawingJunctionPreview(junctions);
    // Lane lines stop at the stop lines of those same junctions, the shared ones included.
    const markingsByPiece = (typeof buildCorridorLaneMarkingsForEntries === 'function')
        ? buildCorridorLaneMarkingsForEntries(pieces, frame, { junctions })
        : pieces.map(piece => buildCorridorLaneMarkings([piece.points], piece.profile, frame));
    const markings = [];
    pieces.forEach((piece, pieceIndex) => {
        const strips = (piece.taper && typeof buildCorridorPieceStrips === 'function')
            ? buildCorridorPieceStrips(piece, frame)
            : buildCorridorStrips([piece.points], piece.profile, frame);
        if (!strips.length) {
            // A drawn segment with no strips renders as a bare dashed centerline — never
            // acceptable silently. Say WHY so field reports become diagnosable.
            console.error('[road-drawing] no strips for a drawn segment', { points: piece.points.length, profile: piece.profile, taper: !!piece.taper });
            return;
        }
        // Trees only — bike/pedestrian lane explainers stay out of the map (cross-section
        // editor is the reference for lane meaning). A transition zone plants none.
        const decorations = (!piece.taper && typeof buildCorridorDecorations === 'function')
            ? buildCorridorDecorations([piece.points], piece.profile, frame).filter(decoration => decoration.kind === 'tree')
            : [];
        const junctionTrims = (typeof corridorEntryJunctionTrims === 'function' && junctions.length)
            ? corridorEntryJunctionTrims(piece.points.map(point => frame.latLngToMetric(point.lat, point.lng)), junctions, frame)
            : null;
        // Match the applied corridor paint partition: the junction pass paints its carriageway
        // and corners once, so draft strips must stop at that same coverage before they render.
        const junctionPaint = (typeof window !== 'undefined' && window.__corridorJunctionPaint) || null;
        const paintedStrips = (junctionPaint && junctions.length)
            ? junctionPaint.clipStrips(strips, junctions)
            : strips;
        const segmentLayer = renderCorridorStrips(paintedStrips, {
            pane: CORRIDOR_STRIPS_PANE,
            markings: [], decorations, junctions: [], junctionTrims,
            // Rails come with the cross-section: a rail lane in the profile being drawn lays its track
            // right there on the map, so a track is drawn as a track from the first click. A zone's
            // profile is not constant, so it lays none.
            centerlines: piece.taper ? null : [piece.points], profile: piece.profile, frame
        });
        if (segmentLayer) {
            segmentLayer.addTo(group);
            markings.push(...(markingsByPiece[pieceIndex] || []));
            drewAny = true;
        }
    });
    if (!drewAny) {
        if (typeof setCorridorDrawingJunctionPreview === 'function') setCorridorDrawingJunctionPreview([]);
        return restoreCorridorFill();
    }
    if (junctions.length && typeof renderCorridorJunctions === 'function') {
        renderCorridorJunctions(junctions, group, CORRIDOR_JUNCTIONS_PANE);
    }
    if (typeof renderCorridorLaneMarkings === 'function') {
        renderCorridorLaneMarkings(markings, group, CORRIDOR_MARKINGS_PANE);
    }
    roadStripLayer = group;
    if (roadPolygonLayer) roadPolygonLayer.setStyle({ fillOpacity: 0 });
    roadStripLayer.addTo(map);
}

// The cross-section of the corridor being drawn — a road's or a track's, which are the same thing.
function getRoadDrawingProfile() {
    const normalized = normalizeCorridorProfile(roadProfile);
    return normalized ? { strips: normalized.strips.map(strip => ({ ...strip })) } : null;
}

function currentCorridorDraftCityId() {
    try {
        return window.CityConfigManager && typeof window.CityConfigManager.getCurrentCityId === 'function'
            ? window.CityConfigManager.getCurrentCityId()
            : null;
    } catch (_) { return null; }
}

function draftLatLng(point) {
    if (!point) return null;
    const lat = Number(point.lat !== undefined ? point.lat : point[1]);
    const lng = Number(point.lng !== undefined ? point.lng : point[0]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// Geometry tools own their live mutable state; this is the single snapshot boundary that turns it
// into a small, reload-safe draft. Preview cursor geometry is deliberately excluded.
function saveCurrentCorridorDrawingDraft(kind = corridorDrawingKind()) {
    if (typeof saveActiveCorridorDraft !== 'function') return null;
    const entries = getAllRoadSegments(true)
        .map((segment, index) => ({
            points: (segment || []).map(draftLatLng).filter(Boolean),
            id: roadSegmentIds[index] || null
        }))
        .filter(entry => entry.points.length >= 2);
    if (!entries.length) return null;

    const seed = {
        centerline: entries.map(entry => entry.points),
        segmentIds: entries.map(entry => entry.id),
        profile: getRoadDrawingProfile(),
        width: roadWidth,
        sidewalkWidth: roadSidewalkWidth,
        drivingSide: roadDrivingSide,
        // The selected design targets ride along with any corridor that carries a track.
        trackSpeed,
        trackMinRadius: trackMinCurvatureRadius,
        tunnels: JSON.parse(JSON.stringify(roadBuildingTunnels || [])),
        gradeSeparations: JSON.parse(JSON.stringify(roadGradeSeparations || [])),
        segmentProfiles: JSON.parse(JSON.stringify(roadSegmentProfiles || {}))
    };

    try {
        const latLngPairs = convertRoadPolygonToLatLngPairs(roadPolygon);
        const polygon = convertLatLngPairsToGeoJSON(latLngPairs);
        if (polygon?.type && Array.isArray(polygon.coordinates)) {
            seed.polygon = polygon;
            seed.latLngPairs = latLngPairs;
        }
    } catch (_) { }

    const copySource = window.pendingRoadCopySource || null;
    const selectedParcelIds = (Array.isArray(roadAffectedParcels) ? roadAffectedParcels : [])
        .map(parcel => getParcelIdFromAny(parcel))
        .filter(Boolean)
        .map(String);
    const saved = saveActiveCorridorDraft({
        draftId: (copySource && copySource.draftId) || window.activeProposalDesignDraftId || null,
        kind,
        cityId: currentCorridorDraftCityId(),
        seed,
        copySource,
        parcelIds: selectedParcelIds,
        sourceLocalProposalId: copySource && copySource.proposalId ? String(copySource.proposalId) : null
    });
    // A fresh drawing creates its draft at finish time — adopt it into the design session so
    // instantCreate consumes exactly this draft.
    if (saved && !window.activeProposalDesignDraftId && typeof window.beginProposalDraftDesignSession === 'function') {
        const savedId = saved.draftId || saved.id;
        if (savedId) window.beginProposalDraftDesignSession(savedId);
    }
    return saved;
}

// Apply a live editor profile to the drawing. A total-width change rebuilds the footprint and derives
// affected parcels/stats again; a profile-only change follows the same path but leaves the footprint.
// One path for every corridor: adding a rail lane to what began as a road is an ordinary lane edit.
function setRoadDrawingProfile(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return false;
    roadProfile = { strips: normalized.strips.map(strip => ({ ...strip })) };
    roadWidth = corridorProfileWidth(roadProfile);
    roadMirroredSegmentIds.forEach(key => { roadSegmentProfiles[key] = reversedCorridorProfile(roadProfile); });
    syncRoadSidewalkWidthFromProfile();
    // The next R-press starts with this cross-section (there is no width picker any more). The lanes are
    // remembered, not a width: a width alone rebuilds as two traffic lanes, which a narrow footpath or
    // cycle track cannot be. Only a ROAD's profile is remembered: a track is seeded from its gauge.
    if (!corridorDrawingIsTrack()) {
        try {
            PersistentStorage.setItem('lastRoadProfile', JSON.stringify({ ...roadProfile, drivingSide: roadDrivingSide }));
        } catch (_) { }
    }
    const polygon = rebuildRoadGeometryFromSegments();
    recomputeLockedParcelsFromPolygon(polygon);
    const hasPlacedSegments = getAllRoadSegments(true)
        .some(segment => Array.isArray(segment) && segment.length >= 2);
    if (!hasPlacedSegments) {
        // With no geometry there is nothing to collide with; the first placed edge validates this
        // width before it is committed.
        roadLastValidatedWidth = roadWidth;
        roadDrawingProfileValidationPending = false;
    } else {
        roadDrawingProfileValidationPending = Math.abs(roadWidth - roadLastValidatedWidth) > 1e-6;
    }
    updateRoadInfoPanel();
    updateRoadCrossSectionButton();
    return true;
}

// The sidewalk width the legacy width-based paths still read, as the profile's average footway.
function syncRoadSidewalkWidthFromProfile() {
    const sidewalks = roadProfile ? roadProfile.strips.filter(strip => strip.type === 'sidewalk') : [];
    roadSidewalkWidth = sidewalks.length
        ? sidewalks.reduce((sum, strip) => sum + strip.width, 0) / sidewalks.length
        : 0;
    if (typeof window !== 'undefined') window.roadSidewalkWidth = roadSidewalkWidth;
}

// The last cross-section drawn, for the side of the road `drivingSide` keeps to: one remembered
// from a city that keeps the other side is mirrored (its directed lanes swap forward and backward).
function rememberedRoadProfile(drivingSide) {
    let stored = null;
    try { stored = JSON.parse(PersistentStorage.getItem('lastRoadProfile') || 'null'); } catch (_) { }
    const profile = normalizeCorridorProfile(stored);
    if (!profile || corridorProfileHasRail(profile)) return null;
    const storedSide = stored.drivingSide === 'left' ? 'left' : 'right';
    return storedSide === drivingSide ? profile : corridorProfileForDrivingSide(profile, 'left');
}

function updateRoadCrossSectionButton() {
    const button = document.getElementById('editRoadCrossSectionButton');
    if (!button) return;
    const width = button.querySelector('.road-cross-section-width');
    if (width) width.textContent = roadProfile ? ` · ${CbFormat.formatLength(corridorProfileWidth(roadProfile))}` : '';
}

// Rebuild centerline + committed polygon from `roadSegments` (the source of truth) and refresh the
// cache the per-click incremental union relies on. Used whenever segments change wholesale: undo,
// mid-segment node insertion, and seeding an existing road for editing.
function rebuildRoadGeometryFromSegments() {
    const centerlinePoints = getAllRoadSegments(true);

    if (roadCenterline) {
        if (centerlinePoints.length > 0) {
            roadCenterline.setLatLngs(centerlinePoints);
        } else {
            map.removeLayer(roadCenterline);
            roadCenterline = null;
        }
    } else if (centerlinePoints.length > 0) {
        roadCenterline = L.polyline(centerlinePoints, {
            color: 'green',
            weight: 3,
            dashArray: '5, 5',
            opacity: 0.7
        }).addTo(map);
    }

    // Before the second point (or after undoing back to it), there is no footprint or metric frame
    // to build. Profile edits still update the tool and clear any old polygon below.
    const updatedPolygon = hasDrawableCorridor() ? buildRoadUnionPolygonWithWidths(
        centerlinePoints,
        centerlinePoints.map((_, index) => roadDrawingWidthForSegmentIndex(index)),
        roadWidth,
        roadSegmentIds,
        roadSessionFrame()
    ) : null;
    cachedCommittedPolygon = updatedPolygon;
    if (updatedPolygon) {
        roadPolygon = updatedPolygon;
        if (roadPolygonLayer) {
            roadPolygonLayer.setLatLngs(updatedPolygon);
        } else {
            roadPolygonLayer = L.polygon(updatedPolygon, {
                color: 'green',
                weight: 2,
                fillColor: 'green',
                fillOpacity: 0.3
            }).addTo(map);
        }
    } else {
        if (roadPolygonLayer) {
            map.removeLayer(roadPolygonLayer);
            roadPolygonLayer = null;
        }
        roadPolygon = null;
    }
    redrawRoadStrips();
    return updatedPolygon;
}

// Normalize a seed centerline into segments of Leaflet LatLngs. Accepts the two shapes a stored road
// definition can have: a flat list of points (older single-segment roads) or a list of segments.
function normalizeSeedSegments(input) {
    if (!Array.isArray(input) || !input.length) return [];
    const toLatLng = (pt) => {
        if (!pt) return null;
        const lat = Number(pt.lat !== undefined ? pt.lat : (Array.isArray(pt) ? pt[1] : NaN));
        const lng = Number(pt.lng !== undefined ? pt.lng : (Array.isArray(pt) ? pt[0] : NaN));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return L.latLng(lat, lng);
    };
    const isNested = Array.isArray(input[0]);
    const rawSegments = isNested ? input : [input];
    return rawSegments
        .map(segment => (Array.isArray(segment) ? segment.map(toLatLng).filter(Boolean) : []))
        .filter(segment => segment.length >= 2);
}

// Reopen an existing corridor for editing: the drawing tool starts from its geometry instead of a blank
// canvas, so it can be continued across a reload, an upload/download round-trip, or a copy. The locked
// parcels and their stats are then derived from the corridor, exactly as they are after an undo.
// A track seeds the same way a road does — it is the same tool and the same state.
function seedRoadDrawing(seed) {
    if (!seed) return false;
    const segments = normalizeSeedSegments(seed.centerline || seed.segments || seed.points);
    if (!segments.length) return false;

    if (Number.isFinite(Number(seed.width))) roadWidth = Number(seed.width);
    roadDrivingSide = seed.drivingSide === 'left' ? 'left' : 'right';
    if (Number.isFinite(Number(seed.sidewalkWidth))) {
        roadSidewalkWidth = Number(seed.sidewalkWidth);
        if (typeof window !== 'undefined') window.roadSidewalkWidth = roadSidewalkWidth;
    }
    trackSpeed = trackTargetOf(seed.trackSpeed);
    trackMinCurvatureRadius = trackTargetOf(seed.trackMinRadius);

    // A corridor drawn before profiles existed gets one synthesised from its width, so reopening it never
    // silently changes its footprint: the profile always sums back to the width it was drawn with. That
    // includes an old track — one rail lane as wide as the track was drawn.
    roadProfile = normalizeCorridorProfile(seed.profile)
        || corridorProfileFromLegacy(roadWidth, roadSidewalkWidth, corridorDrawKind === 'track', roadDrivingSide);
    if (roadProfile) roadWidth = corridorProfileWidth(roadProfile);

    roadSegments = [];
    roadSegmentIds = [];
    roadPoints = [];
    roadHasStarted = false;
    roadBuildingTunnels = Array.isArray(seed.tunnels) ? JSON.parse(JSON.stringify(seed.tunnels)) : [];
    roadGradeSeparations = Array.isArray(seed.gradeSeparations) ? JSON.parse(JSON.stringify(seed.gradeSeparations)) : [];
    roadSegmentProfiles = (seed.segmentProfiles && typeof seed.segmentProfiles === 'object')
        ? JSON.parse(JSON.stringify(seed.segmentProfiles))
        : {};
    roadMirroredSegmentIds = new Set();
    // A seeded corridor's obstacles were decided when it was built; only edges drawn from here on
    // record new ones.
    roadEdgeConflicts = new Map();
    roadStreetConnections = [];
    redrawRoadConflictMarkers();
    cachedCommittedPolygon = null;
    roadDrawingFrame = null;

    const seededIds = Array.isArray(seed.segmentIds) ? seed.segmentIds : [];
    segments.forEach((points, index) => pushRoadSegment(points, seededIds[index]));

    // Keep generated ids clear of the seeded ones so a continued road never collides with a new branch.
    seededIds.forEach(id => {
        const match = /^s(\d+)$/.exec(String(id || ''));
        if (match) nextRoadSegmentId = Math.max(nextRoadSegmentId, Number(match[1]) + 1);
    });

    const polygon = rebuildRoadGeometryFromSegments();
    redrawRoadVertexMarkers();
    refreshRoadBuildingTunnelLayer();
    refreshRoadGradeSeparationLayer();
    recomputeLockedParcelsFromPolygon(polygon);
    roadSurfaceBuildingIds = seededSurfaceBuildingIds();
    roadLastValidatedWidth = roadWidth;
    roadDrawingProfileValidationPending = false;
    updateRoadInfoPanel();
    updateUndoButtonState();
    return true;
}

if (typeof window !== 'undefined') {
    window.seedRoadDrawing = seedRoadDrawing;
    window.getRoadDrawingProfile = getRoadDrawingProfile;
    window.setRoadDrawingProfile = setRoadDrawingProfile;
    window.validateRoadDrawingProfileImpacts = validateRoadDrawingProfileImpacts;
}

// The buildings a continued corridor already crosses outside its tunnels. Each was kept at surface
// when the corridor was built (that answer is not stored on its own), so an edge drawn from here on
// that touches one again is not asked about it. One query over every seeded edge's footprint.
function seededSurfaceBuildingIds() {
    const ids = new Set();
    if (typeof findBuildingTunnelIntersections !== 'function' || typeof collectLoadedCorridorBuildings !== 'function'
        || typeof turf === 'undefined') return ids;
    const tunnelled = new Set(roadBuildingTunnels.flatMap(record => (record?.buildingIds || []).map(String)));
    try {
        const polygons = [];
        roadSegments.forEach((segment, segmentIndex) => {
            const width = roadDrawingWidthForSegmentIndex(segmentIndex);
            for (let index = 0; index < segment.length - 1; index += 1) {
                const edge = [segment[index], segment[index + 1]];
                const feature = corridorFeatureFromLatLngRing(calculateRoadPolygon(edge, width, roadSessionFrame(edge)));
                if (feature) polygons.push(feature.geometry.coordinates);
            }
        });
        if (!polygons.length) return ids;
        findBuildingTunnelIntersections(turf.multiPolygon(polygons), collectLoadedCorridorBuildings(), turf)
            .forEach(hit => { if (!tunnelled.has(String(hit.id))) ids.add(String(hit.id)); });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [road-drawing] could not find the buildings a continued corridor already crosses`, error);
    }
    return ids;
}

// Continue an existing segment from one of its two ends. Drawing always appends to the end of the
// active array, so when the user grabs the *first* vertex we reverse the segment in place; the array
// is the same object `roadSegments` holds. Its cross-section is reversed with it: lanes and their
// directions are read along the points, so a one-way street would otherwise flip.
function resumeRoadSegment(segmentIndex, atStart) {
    const segment = roadSegments[segmentIndex];
    if (!Array.isArray(segment) || !segment.length) return false;
    if (atStart && segment.length > 1) {
        segment.reverse();
        mirrorRoadSegmentProfile(segmentIndex);
    }
    roadPoints = segment;
    roadHasStarted = true;
    return true;
}

function mirrorRoadSegmentProfile(segmentIndex) {
    const id = roadSegmentIds[segmentIndex];
    if (id === undefined || id === null) return;
    const key = String(id);
    // Reversed back: it is the session profile again.
    if (roadMirroredSegmentIds.delete(key)) {
        delete roadSegmentProfiles[key];
        return;
    }
    const override = roadDrawingSegmentOverride(segmentIndex);
    const mirrored = reversedCorridorProfile(override || roadProfile);
    if (!mirrored) return;
    if (override) {
        roadSegmentProfiles[key] = mirrored;
        return;
    }
    // A symmetric profile reads the same both ways and needs no override.
    if (JSON.stringify(mirrored) === JSON.stringify(normalizeCorridorProfile(roadProfile))) return;
    roadSegmentProfiles[key] = mirrored;
    roadMirroredSegmentIds.add(key);
}

// Insert a node into an existing segment at a point along one of its edges, so a new segment can
// start there and the two share a node (an OSM T-join). The inserted node is collinear, so the road
// polygon and the locked parcels are unchanged — only the node list grows.
function insertRoadNodeOnEdge(segmentIndex, insertAfter, latlng) {
    const segment = roadSegments[segmentIndex];
    if (!Array.isArray(segment) || insertAfter < 0 || insertAfter >= segment.length - 1) return false;
    const from = segment[insertAfter];
    const to = segment[insertAfter + 1];
    const edgeKey = typeof corridorTunnelEdgeKey === 'function' ? corridorTunnelEdgeKey(from, to) : '';
    const tunnel = edgeKey ? roadBuildingTunnels.find(record => record?.edgeKey === edgeKey) : null;
    const conflict = edgeKey ? roadEdgeConflicts.get(edgeKey) : null;
    const node = L.latLng(latlng.lat, latlng.lng);
    segment.splice(insertAfter + 1, 0, node);
    // A ramp span over this edge is keyed by its edges, so it is re-keyed across the new node; left
    // alone it would no longer match a live edge and the next edit would drop the grade separation.
    if (edgeKey && typeof refreshGradeSeparationEdgeKeys === 'function') {
        roadGradeSeparations
            .filter(record => (record?.edgeKeys || []).includes(edgeKey))
            .forEach(record => refreshGradeSeparationEdgeKeys(record, segment));
    }
    if (tunnel && typeof removeBuildingTunnelEdge === 'function' && typeof makeBuildingTunnelRecord === 'function') {
        roadBuildingTunnels = removeBuildingTunnelEdge(roadBuildingTunnels, from, to);
        const hits = (tunnel.buildingIds || []).map(id => ({ id }));
        const segmentId = roadSegmentIds[segmentIndex] || tunnel.segmentId || null;
        addBuildingTunnelRecord(roadBuildingTunnels, makeBuildingTunnelRecord(from, latlng, hits, { segmentId }));
        addBuildingTunnelRecord(roadBuildingTunnels, makeBuildingTunnelRecord(latlng, to, hits, { segmentId }));
        refreshRoadBuildingTunnelLayer();
    }
    // An undecided edge's obstacles follow it into its two halves. They are found again rather than
    // copied: each half meets only its own share of the buildings and crossings, and the footprints
    // along it were loaded when the edge was placed.
    if (conflict) {
        roadEdgeConflicts.delete(edgeKey);
        const width = roadDrawingWidthForSegmentIndex(segmentIndex);
        const profile = roadDrawingSegmentOverride(segmentIndex) || roadProfile;
        [[from, node], [node, to]].forEach(([a, b]) => {
            const polygon = calculateRoadPolygon([a, b], width, roadSessionFrame([a, b]));
            recordRoadEdgeConflicts(detectRoadEdgeConflicts(a, b, polygon, profile));
        });
        redrawRoadConflictMarkers();
    }
    return true;
}

const ROAD_OWNERSHIP_TYPE_IDS = {
    individual: 'road-owned-individuals',
    company: 'road-owned-companies',
    government: 'road-owned-government',
    institution: 'road-owned-institution',
    mixed: 'road-owned-mixed'
};
let roadOwnershipStatsRequestId = 0;
const roadOwnershipTypeCache = new Map();

function getRoadDrawingParcelIdFromFeature(feature) {
    return feature ? ensureParcelId(feature) : null;
}

function getRoadDrawingFabric() {
    return (typeof window !== 'undefined' && window.LiveParcelFabric)
        ? window.LiveParcelFabric
        : null;
}

function getRoadDrawingPresenterLayer(parcelId) {
    const id = parcelId !== undefined && parcelId !== null ? String(parcelId) : '';
    if (!id || typeof window === 'undefined' || !window.ParcelPresenter
        || typeof window.ParcelPresenter.getLayer !== 'function') return null;
    return window.ParcelPresenter.getLayer(id);
}

function getRoadDrawingLiveFeature(parcelId) {
    const id = parcelId !== undefined && parcelId !== null ? String(parcelId) : '';
    const fabric = getRoadDrawingFabric();
    return id && fabric && typeof fabric.get === 'function' ? fabric.get(id) : null;
}

function liveRoadDrawingParcelsIntersecting(queryFeature, options = {}) {
    const fabric = getRoadDrawingFabric();
    if (!queryFeature || !queryFeature.geometry || !fabric || typeof fabric.queryBounds !== 'function'
        || typeof turf === 'undefined' || typeof turf.bbox !== 'function'
        || typeof turf.booleanIntersects !== 'function') return [];
    let candidates = [];
    try {
        candidates = fabric.queryBounds(turf.bbox(queryFeature), {
            includeCorridors: options.includeCorridors === true
        });
    } catch (_) {
        return [];
    }
    const minOverlap = Number(options.minOverlapM2) > 0 ? Number(options.minOverlapM2) : 0;
    const hits = candidates.filter(feature => {
        try {
            if (!turf.booleanIntersects(queryFeature, feature)) return false;
            if (!minOverlap) return true;
            const shared = turf.intersect(queryFeature, feature);
            return !!shared && turf.area(shared) >= minOverlap;
        } catch (_) { return false; }
    });
    // Only cadastral parcels are returned: a piece formed on open ground joins no count, owner
    // tally or declaration. `options.groundInto` (a Map) collects those pieces for the open-ground stat.
    const ground = (typeof window !== 'undefined') ? window.__openGround : null;
    if (!ground || typeof ground.splitCrossedPieces !== 'function') return hits;
    const split = ground.splitCrossedPieces(hits, { idOf: getRoadDrawingParcelIdFromFeature });
    if (options.groundInto instanceof Map) {
        split.ground.pieces.forEach(piece => options.groundInto.set(piece.id, piece.areaM2));
    }
    return split.parcels;
}

function roadDrawingParcelEntry(feature) {
    const id = getRoadDrawingParcelIdFromFeature(feature);
    if (!id) return null;
    const properties = feature.properties || {};
    return {
        id: String(id),
        number: properties.BROJ_CESTICE,
        area: Number(properties.calculatedArea) || 0,
        estimatedMarketPrice: properties.estimatedMarketPrice,
        layer: getRoadDrawingPresenterLayer(id)
    };
}

function getParcelIdFromAny(parcel) {
    if (!parcel) return null;
    const fromFeature = parcel.type === 'Feature' ? getRoadDrawingParcelIdFromFeature(parcel) : null;
    const fromProps = parcel.properties ? ensureParcelId(parcel.properties) : null;
    const raw = parcel.id ?? parcel.parcelId;
    const candidate = fromFeature || fromProps || getParcelId(raw);
    return candidate ? candidate.toString() : null;
}

function getRoadDrawingParcelProperties(parcel) {
    const id = getParcelIdFromAny(parcel);
    return id ? getRoadDrawingLiveFeature(id)?.properties || {} : {};
}

function setRoadParcelStats(countValue, areaText = '—') {
    const countEl = document.getElementById('road-parcels-count');
    const areaEl = document.getElementById('road-parcels-area');
    if (countEl) countEl.textContent = typeof countValue === 'number' ? countValue.toString() : (countValue || '—');
    if (areaEl) areaEl.textContent = areaText || '—';
    renderRoadOpenGroundStat();
}

// The open ground the corridor crosses (committed + preview), shown only when there is some.
function renderRoadOpenGroundStat() {
    const el = document.getElementById('road-open-ground');
    if (!el) return;
    const crossed = new Map([...roadOpenGroundCrossed.locked, ...roadOpenGroundCrossed.preview]);
    const group = el.closest('.metric-group');
    if (group) group.hidden = crossed.size === 0;
    if (!crossed.size) {
        el.textContent = '—';
        return;
    }
    const area = Array.from(crossed.values()).reduce((sum, value) => sum + (Number(value) || 0), 0);
    el.textContent = translateRoadText('panel.road.openGroundValue', '{{count}} · {{area}}', {
        count: crossed.size,
        area: formatParcelArea(area)
    });
}

function formatParcelArea(area) {
    if (!Number.isFinite(area) || area <= 0) return '—';
    return CbFormat.formatArea(area);
}

function resetRoadMetricPlaceholders() {
    // Length and area too: without them the next drawing opens on the previous road's figures.
    const lengthEl = document.getElementById('road-length');
    if (lengthEl) lengthEl.textContent = CbFormat.formatLength(0);
    const areaEl = document.getElementById('road-area');
    if (areaEl) areaEl.textContent = CbFormat.formatArea(0);
    roadOpenGroundCrossed.locked.clear();
    roadOpenGroundCrossed.preview.clear();
    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) ownerCountEl.textContent = '—';
    setRoadParcelStats(0, '—');
    Object.values(ROAD_OWNERSHIP_TYPE_IDS).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '—';
    });
    const marketEl = document.getElementById('road-market-price');
    if (marketEl) marketEl.textContent = '—';
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (difficultyEl) difficultyEl.textContent = '—';
    // Reset acquiring difficulty calculation
    updateRoadAcquiringDifficulty([]);
}

function formatRoadText(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

// Why an edit of a road placed into a parcel was refused, in words for its author.
function boundedRoadRefusal(issue) {
    if (issue && issue.code === 'core-too-wide') {
        return translateRoadText('panel.road.boundedTooWide',
            'These lanes need {{required}} m, and the parcel leaves {{available}} m here. Choose fewer or narrower lanes.',
            { required: Number(issue.requiredM).toFixed(1), available: Number(issue.availableM).toFixed(1) });
    }
    return translateRoadText('panel.road.boundedOutside',
        'A road in a parcel stays inside that parcel. Move the point back onto it.');
}

function translateRoadText(key, fallback, params = {}) {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    const translated = api && typeof api.t === 'function' ? api.t(key, params) : null;
    if (!translated || translated === key) {
        return formatRoadText(fallback, params);
    }
    return formatRoadText(translated, params);
}

function showRoadAlert(key, fallback, params = {}) {
    const message = translateRoadText(`alerts.messages.${key}`, fallback, params);
    const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
        ? window.showStyledAlert
        : window.alert;
    if (typeof alertFn === 'function') {
        alertFn(message);
    }
    return message;
}

function setRoadOwnershipCounts(counts) {
    Object.entries(ROAD_OWNERSHIP_TYPE_IDS).forEach(([type, elementId]) => {
        const el = document.getElementById(elementId);
        if (!el) return;
        if (!counts) {
            el.textContent = '—';
            return;
        }
        const value = Number.isFinite(counts[type]) ? counts[type] : 0;
        el.textContent = value.toString();
    });
}

// Ownership evidence and price estimates retain separate counts, currencies and model bases.
function roadOwnershipSummary(parcels) {
    return window.RoadOwnershipModel.summarize((parcels || []).map(getRoadDrawingParcelProperties),
        typeof getOwnershipType === 'function' ? getOwnershipType : undefined);
}

// The city's road-land rate (city-money.js); a city without one has no modeled price, only source ones.
function roadPriceEstimate(parcel) {
    return window.ParcelPriceModel.buildEstimate(getRoadDrawingParcelProperties(parcel), Number(parcel?.area),
        window.CityMoney.currentLandPriceOptions('road'));
}

function getMarketPrice(parcelId, currency) {
    const parcel = [...roadAffectedParcels, ...roadPreviewAffectedParcels]
        .find(entry => getParcelIdFromAny(entry) === getParcelId(parcelId));
    const estimate = parcel ? roadPriceEstimate(parcel) : null;
    return estimate && (!currency || estimate.currency === currency) ? estimate.amount : null;
}

function roadAcquisitionModel(parcels) {
    const list = Array.isArray(parcels) ? parcels : [];
    const ownership = roadOwnershipSummary(list);
    const estimates = list.map(roadPriceEstimate);
    const total = window.ParcelPriceModel.aggregate(estimates, list.length);
    const fallback = window.CityMoney.currentLandPriceOptions('road');
    const coefficients = { government: 0, institution: 0, company: 1, individual: 2, mixed: 2 };
    const score = total.amount !== null && !ownership.unknownParcelCount
        ? list.reduce((sum, parcel, index) => sum + estimates[index].amount * coefficients[getOwnershipTypeFromParcel(parcel)], 0)
        : null;
    return {
        ownerEntryCount: ownership.totalOwnerEntryCount,
        knownOwnerEntryCount: ownership.knownOwnerEntryCount,
        missingOwnerEvidenceParcelCount: ownership.missingOwnerEvidenceParcelCount,
        unknownOwnershipParcelCount: ownership.unknownParcelCount,
        ownershipCounts: ownership.categoryCounts,
        totalMarketPrice: total.amount,
        totalAcquiringDifficulty: score,
        currency: total.currency,
        priceBasis: { kind: total.basis, fallbackRatePerM2: fallback.areaPricePerSqm ?? null, fallbackCurrency: fallback.currency,
            economicSource: fallback.economicSource },
        difficultyBasis: 'category-weighted value model',
        source: 'browser-model'
    };
}

function updateRoadMarketPrice(parcels) {
    const marketEl = document.getElementById('road-market-price');
    if (!marketEl) return;
    const stats = roadAcquisitionModel(parcels);
    marketEl.textContent = stats.totalMarketPrice !== null && stats.currency
        ? CbFormat.formatMoney(stats.totalMarketPrice, stats.currency, { maxFractionDigits: 0 }) : '—';
    marketEl.title = stats.priceBasis.kind === 'area-model'
        ? window.EconomicSourceSettings?.describe(stats.priceBasis.economicSource, window) || '' : '';
}

async function updateRoadAcquiringDifficulty(parcels) {
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (!difficultyEl) return;
    const stats = roadAcquisitionModel(parcels);
    difficultyEl.textContent = stats.totalAcquiringDifficulty !== null
        ? `${CbFormat.formatNumber(stats.totalAcquiringDifficulty, { maxFractionDigits: 0 })} (${stats.currency} basis)` : '—';
}

// Persist the computed data, never numbers parsed back out of translated display text.
function collectOwnershipAndAcquisitionStats() {
    return roadAffectedParcels.length ? roadAcquisitionModel(roadAffectedParcels) : null;
}

async function updateRoadOwnershipCounts(parcels) {
    const list = Array.isArray(parcels) ? parcels : [];
    const summary = roadOwnershipSummary(list);
    setRoadOwnershipCounts(list.length ? summary.categoryCounts : null);
    const unknownEl = document.getElementById('road-ownership-unknown');
    if (unknownEl) unknownEl.textContent = list.length ? String(summary.unknownParcelCount) : '—';
    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) ownerCountEl.textContent = list.length && summary.totalOwnerEntryCount !== null
        ? String(summary.totalOwnerEntryCount) : '—';
}

// Entering the drawing tool clears the map of whatever you were looking at: an open proposal, a
// selected parcel, the "At this spot" stack, a multi-selection. None of that is neutral once the
// tool is up — a selected proposal's highlighted parcels read as ground the road already claims —
// and their panels compete with the drawing panel for the same corner. Runs whether or not the
// panels happen to be open: the highlight outlives the panel that produced it.
function clearMapSelectionsForDrawing() {
    try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(true); } catch (_) { }
    try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
    try { window.ProposalSelection?.clear?.(); } catch (_) { }
    try { window.ClickStack?.close(); } catch (_) { }

    // The single-parcel selection: its style, the state the rest of the app reads, its panel.
    try {
        const selectedLayer = (window.currentParcel && window.currentParcel.layer)
            || (window.selectedParcelId
                ? (window.ParcelPresenter?.getLayer?.(String(window.selectedParcelId)) || null)
                : null);
        if (selectedLayer && typeof restoreParcelLayerStyle === 'function') restoreParcelLayerStyle(selectedLayer);
    } catch (_) { }
    window.selectedParcelId = null;
    window.currentParcel = null;
    try { if (typeof clearParcelHover === 'function') clearParcelHover(); } catch (_) { }

    ['proposal-details-panel', 'parcel-info-panel', 'block-info-panel'].forEach(id => {
        try { document.getElementById(id)?.classList.remove('visible'); } catch (_) { }
    });

    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.clearSelection === 'function') {
            multiParcelSelection.clearSelection();
        }
    } catch (_) { }
}

// Ensure multi-parcel selection is turned off when starting road/track drawing
function disableMultiSelectForDrawing() {
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection?.isActive) return;
    multiParcelSelection.finish();
}

// One panel serves both road and track drawing, so switching mode swaps the i18n KEY on each label —
// not just its text. Writing text alone left the road-mode key in place, so the next applyTranslations()
// (a language switch) would put the road wording back on a track panel, and any literal written here
// would survive untranslated in every language.
function setRoadPanelLabelsForMode(mode = 'road') {
    const isTrack = mode === 'track';
    const modeLabels = [
        ['road-panel-title', isTrack ? 'panel.road.titleTrack' : 'panel.road.title', isTrack ? 'Draw track' : 'Draw road'],
        ['finishRoadButton', 'common.done', 'Done'],
        ['road-length-label', isTrack ? 'panel.road.lengthLabelTrack' : 'panel.road.lengthLabel', isTrack ? 'Track length:' : 'Road length:'],
        ['road-area-label', isTrack ? 'panel.road.areaLabelTrack' : 'panel.road.areaLabel', isTrack ? 'Track area:' : 'Road area:']
    ];

    modeLabels.forEach(([id, key, fallback]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('data-i18n-key', key);
        el.textContent = translateRoadText(key, fallback);
    });

    // The cross-section editor serves both: a track is a corridor whose lanes happen to include a track.
    const crossSectionButton = document.getElementById('editRoadCrossSectionButton');
    if (crossSectionButton) crossSectionButton.style.display = '';
    updateRoadCrossSectionButton();
}

// The two buttons enter the SAME tool. `kind` chooses the seed cross-section — a road profile, or one
// standard-gauge track — and nothing else about the session. Pressing the button that is already active
// closes the tool (which, in this SimCity lifecycle, means finishing what has been drawn).
async function requestCorridorDrawingTool(kind) {
    if (!roadDrawingMode && !canStartRoadDrawingInCurrentMode()) return false;
    if (roadDrawingMode) {
        // The other button while drawing: end this corridor, then open the tool on the other seed.
        const closed = await cancelRoadDrawing();
        // "Keep drawing" means exactly that — not "close this one and open the other".
        if (!closed) return false;
        if (kind === corridorDrawKind) return true;
    }

    // The draft store is only the finish-time hand-off to instantCreate — clear any stale active
    // draft so finishing this drawing cannot hijack an unrelated one.
    try { window.proposalDraftStore?.clearActiveDraft?.(); } catch (_) { }
    // A drawing session owns the map: any open proposal selection (blue highlights, details
    // panel, amber segment ants) closes now — none of it may ride along a drawing.
    try {
        if (window.ProposalSelection?.has?.()) {
            if (typeof clearProposalHighlights === 'function') clearProposalHighlights();
            window.ProposalSelection.clear();
            if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel();
        }
        window.corridorLastClickedSegment = null;
        window.refreshSelectedCorridorSegmentHighlight?.();
    } catch (_) { }
    // Build-through approvals for parks/squares/lakes and plots last one drawing session only.
    if (typeof resetApprovedStructureCrossings === 'function') resetApprovedStructureCrossings();
    if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
        await ensureCorridorBuildingFootprintsLoaded();
    }
    if (!roadDrawingMode && !canStartRoadDrawingInCurrentMode()) return false;
    corridorDrawKind = kind === 'track' ? 'track' : 'road';
    toggleRoadDrawTool();
    return true;
}

async function startSeededCorridorDrawing(kind, seed, copySource) {
    if (!seed || !canStartRoadDrawingInCurrentMode()) return false;
    if (roadDrawingMode) {
        // A live drawing is asked about (build, discard or keep drawing), never dropped silently.
        if (!(await cancelRoadDrawing())) return false;
        // Building it failed and reopened it: that drawing is the one on the tool now.
        if (roadDrawingMode) return false;
    }
    if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
        await ensureCorridorBuildingFootprintsLoaded();
    }
    if (!canStartRoadDrawingInCurrentMode()) return false;
    if (copySource?.draftId && window.proposalDraftStore?.getDraft(copySource.draftId)) {
        window.beginProposalDraftDesignSession?.(copySource.draftId);
    }
    window.pendingRoadCopySource = copySource || null;
    corridorDrawKind = kind === 'track' ? 'track' : 'road';
    window.pendingRoadDrawingSeed = seed;
    toggleRoadDrawTool();
    return true;
}

if (typeof window !== 'undefined') {
    window.requestRoadDrawTool = () => requestCorridorDrawingTool('road');
    window.updateLocalCorridorGeometry = updateLocalCorridorGeometry;
    window.isCorridorApplyInFlight = isCorridorApplyInFlight;
    window.requestTrackDrawTool = () => requestCorridorDrawingTool('track');
    window.startSeededCorridorDrawing = startSeededCorridorDrawing;
}

// The corridor drawing tool's low-level activator. User-facing entry points go through
// requestCorridorDrawingTool(), which sets `corridorDrawKind` and guards the active draft.
function corridorDrawButton() {
    return document.getElementById(corridorDrawKind === 'track' ? 'trackDrawButton' : 'roadDrawButton');
}

function toggleRoadDrawTool() {
    const entering = !roadDrawingMode;
    if (entering && !canStartRoadDrawingInCurrentMode()) return false;
    updateGlobalRoadDrawingMode(entering);
    const roadDrawButton = corridorDrawButton();

    if (roadDrawingMode) {
        disableMultiSelectForDrawing();
        setRoadPanelLabelsForMode(corridorDrawKind);
        clearMapSelectionsForDrawing();
        // Show what the corridor will actually collide with (see autoShowBuildingsForRoadDrawing).
        try { autoShowBuildingsForRoadDrawing(); } catch (_) { }

        // Activate corridor drawing mode — the button the user pressed is the one that lights up
        // (aria-pressed: the one selected look, css/primitives.css).
        if (roadDrawButton) roadDrawButton.setAttribute('aria-pressed', 'true');

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.hidden = false;
        map.getContainer().style.cursor = 'crosshair';
        map.getContainer().classList.add('crosshairs-cursor');

        // Disable other tools and interactivity
        if (typeof measureMode !== 'undefined' && measureMode) toggleMeasureTool(); // Add check for measureMode existence

        // Parcel handlers stay attached. Their click-time drawing-mode guard returns without
        // stopping propagation, so the map receives the drawing click. Detaching every handler
        // here left any layer created/restored along an exceptional exit permanently inert.

        // Hide block info and parcel info panels
        const blockInfoPanel = document.getElementById('block-info-panel');
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (blockInfoPanel) blockInfoPanel.classList.remove('visible');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');

        // Open the panel and start listening for clicks. Shared by the fresh-draw path and the seeded
        // path (which takes its cross-section from the corridor being continued).
        const activateRoadDrawing = (statusText) => {
            const roadInfoPanel = document.getElementById('road-info-panel');
            if (roadInfoPanel) {
                roadInfoPanel.style.removeProperty('display');
                roadInfoPanel.classList.add('visible');
            }
            const statusElement = document.getElementById('status');
            if (statusElement) updateStatus(statusText);
            const roadDrawingControls = document.getElementById('road-drawing-controls');
            if (roadDrawingControls) roadDrawingControls.hidden = false;
            updateRoadCrossSectionButton();
            updateUndoButtonState();
            attachRoadDrawingInteractivity();
            window.LegacyRoadCenterlines?.ensureLoaded?.();
        };

        // Continuing an existing corridor: its geometry and cross-section are already decided, so the
        // tool reopens on it rather than on a seed. The seed is consumed once.
        const seed = (typeof window !== 'undefined') ? window.pendingRoadDrawingSeed : null;
        if (seed) {
            window.pendingRoadDrawingSeed = null;
            if (seedRoadDrawing(seed)) {
                activateRoadDrawing(translateRoadText('panel.road.seededHint', 'Click a segment end to continue it, or click the map to draw a new one'));
                return;
            }
        }

        // Fold away an open sheet so the map has room (the retired width picker used to do this).
        if (window.MapShell) window.MapShell.closeSheets();

        // A NEW TRACK starts as one standard-gauge track (3.5 m) and nothing else. Its width is the sum
        // of its lanes from here on: the cross-section editor adds a second track, a platform, a verge —
        // exactly as it adds a bus lane to a road. The rail speed limit picker comes first, because the
        // minimum curve radius it records is reviewed when the drawing is finished.
        if (corridorDrawKind === 'track') {
            roadSidewalkWidth = 0;
            if (typeof window !== 'undefined') window.roadSidewalkWidth = 0;
            roadProfile = corridorDefaultTrackProfile();
            roadWidth = corridorProfileWidth(roadProfile);
            roadLastValidatedWidth = roadWidth;
            roadDrawingProfileValidationPending = false;
            showTrackSpeedPicker().then(({ speed, minRadius }) => {
                trackSpeed = speed;
                trackMinCurvatureRadius = minRadius;
                activateRoadDrawing(translateRoadText('panel.road.startHintTrack', 'Click on the map to start drawing a track'));
            }).catch(() => {
                // Picker cancelled: the tool never opened.
                if (roadDrawingMode) toggleRoadDrawTool();
            });
            return;
        }

        // No width modal for a road: drawing starts immediately with the last-used cross-section (the
        // narrowest preset, 7.5 m, on first use). It is edited any time — before or during the drawing —
        // via the Cross-section button in this panel's header.
        roadDrivingSide = window.CityConfigManager.getDrivingSide();
        roadProfile = rememberedRoadProfile(roadDrivingSide) || corridorProfileFromLegacy(7.5, 1, false, roadDrivingSide);
        roadWidth = corridorProfileWidth(roadProfile);
        syncRoadSidewalkWidthFromProfile();
        roadLastValidatedWidth = roadWidth;
        roadDrawingProfileValidationPending = false;
        activateRoadDrawing(translateRoadText('status.messages.click_on_the_map_to_start_drawing_a_road', 'Click on the map to start drawing a road'));

    } else {
        // Deactivate corridor drawing mode
        setRoadPanelLabelsForMode('road');
        console.log("Deactivating corridor drawing mode");
        if (roadDrawButton) roadDrawButton.setAttribute('aria-pressed', 'false');
        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.hidden = true;
        map.getContainer().style.cursor = '';
        map.getContainer().classList.remove('crosshairs-cursor');

        // Remove road drawing event handlers from the map
        map.off('click', handleRoadClick);
        map.off('dblclick', handleRoadDoubleClick);
        map.off('mousemove', handleRoadMouseMove);
        map.off('mouseout', handleRoadMouseOut);
        map.off('moveend', handleRoadDrawingMoveEnd);
        document.removeEventListener('keydown', handleRoadKeydown);
        releaseRoadDoubleClickZoom();

        // Reset road drawing variables
        resetRoadDrawing(false);

        // Hide the road info panel
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) roadInfoPanel.classList.remove('visible');

        // Clear status
        const statusElement = document.getElementById('status');
        if (statusElement) updateStatus('');

        // The reference layer R turned on goes back the way it was.
        try { restoreBuildingsAfterRoadDrawing(); } catch (_) { }
    }
}

// Closing the tool on a road that has been drawn: build it, throw it away, or neither. There is no
// safe default here — finishing puts an object on the map the user may not have wanted, discarding
// destroys work with no undo — so it is asked rather than guessed, and Escape keeps drawing.
async function promptCloseDrawnCorridor() {
    const isTrack = (typeof corridorDrawingIsTrack === 'function') ? corridorDrawingIsTrack() : false;
    const message = translateRoadText(
        isTrack ? 'panel.road.closeDrawnTrackPrompt' : 'panel.road.closeDrawnRoadPrompt',
        isTrack ? 'This track has not been built yet. Build it, or discard the drawing?'
            : 'This road has not been built yet. Build it, or discard the drawing?'
    );
    const choices = [
        { label: translateRoadText('panel.road.closeDrawnBuild', 'Build it'), value: 'build', primary: true },
        { label: translateRoadText('panel.road.closeDrawnDiscard', 'Discard the drawing'), value: 'discard' },
        { label: translateRoadText('panel.road.closeDrawnKeep', 'Keep drawing'), value: 'keep' }
    ];

    let answer = 'keep';
    try {
        answer = (typeof showStyledChoice === 'function')
            ? await showStyledChoice(message, choices)
            // No dialog available is not a licence to destroy the drawing: build it, which is the
            // one outcome that loses nothing.
            : 'build';
    } catch (_) {
        answer = 'build';
    }

    if (answer === 'build') {
        await finishRoadDrawing();
        // A build the Finish review sent back ("Choose another route"), or one that failed and
        // reopened the drawing, leaves the tool open: report "keep", so a caller that would open
        // another tool next (requestCorridorDrawingTool) does not reset the live drawing.
        return roadDrawingMode ? 'keep' : 'build';
    }
    if (answer === 'discard') {
        discardRoadDrawing();
        return 'discard';
    }
    return 'keep';   // including Escape / dismissal
}

// Throw the drawing away and close the tool. The only path that deliberately loses work, and it is
// reachable only from the prompt above.
function discardRoadDrawing() {
    updateGlobalRoadDrawingMode(false);
    exitRoadDrawingMode();
}

// Handle keyboard events during road drawing
function handleRoadKeydown(e) {
    // The shared editor owns keyboard controls while it is open. This listener is registered
    // first, so it must leave Escape and editor shortcuts untouched for the shell.
    if (e.defaultPrevented || (typeof window !== 'undefined' && window.OnMapEditor?.isActive?.())) return;
    if (document.body.classList.contains('three-mode-active')) return;
    // Prevent handling if we're typing
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }
    if (e.target.isContentEditable) return;

    // Ctrl/Cmd+Z undoes the last segment, exactly as U does. U is this tool's own shortcut, but
    // every other geometry editor in the app undoes with Ctrl/Cmd+Z (geometry-edit/history.js) —
    // including the node editor for an ALREADY APPLIED road — so someone who has just been dragging
    // road nodes should not have to remember that the drawing tool is the odd one out.
    //
    // Same conventions as the shared history so the two cannot feel different: Alt excluded, the
    // browser's own undo always suppressed while the tool is open, and Shift+Z swallowed because
    // nothing here has a redo to offer.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) return;
        afterRoadPlacement(undoLastRoadSegment);
        return;
    }

    // F (or Enter) finishes the road: the drawing instantly becomes an applied object (SimCity
    // lifecycle). Enter is the natural "I'm done" key, so it mirrors the F shortcut / (F) button.
    // Pressed while a click is still being placed, it finishes once that point is in, as the button
    // and a double-click do (finishRoadDrawing itself declines a drawing with nothing to build).
    if ((e.key === 'f' || e.key === 'F' || e.key === 'Enter')
        && (hasDrawableCorridor() || roadSegmentPlacementInProgress)) {
        e.preventDefault();
        if (e.repeat || roadFinalizationGate.isRunning()) return;
        afterRoadPlacement(() => { if (roadDrawingMode) finishRoadDrawing(); });
    }

    // U undoes the last segment. Both undo paths call the same function, which is itself a no-op
    // when there is nothing to undo — so neither can drift from the other, or from the (U) button.
    if (e.key === 'u' || e.key === 'U') {
        e.preventDefault(); // Prevent browser default behavior
        afterRoadPlacement(undoLastRoadSegment);
    }

    // Escape lifts the pen and keeps what was placed; with the pen already up it asks what to do
    // with the drawing — build it, discard it, keep drawing — and never builds silently; with
    // nothing drawn it closes the tool (handleRoadEscape). A held key lifts once.
    if (e.key === 'Escape') {
        e.preventDefault(); // Prevent browser default behavior
        if (e.repeat) return;
        afterRoadPlacement(handleRoadEscape);
    }
}

// Escape, decided when it runs (after any click still being placed): lift a pen that is down, ask
// about a drawing that exists, close an empty tool.
function handleRoadEscape() {
    if (!roadDrawingMode || roadFinalizationGate.isRunning()) return;
    if (roadHasStarted) {
        liftRoadPen();
    } else if (hasDrawableCorridor()) {
        promptCloseDrawnCorridor();
    } else {
        exitRoadDrawingMode();
    }
}

// Run `action` once the click being placed has settled. Placement awaits the footprints along its
// edge, and an Escape or Undo in the middle of that would pull the stroke out from under the point
// it is about to add; they wait on the placement's own promise instead of guessing with a delay.
function afterRoadPlacement(action) {
    const pending = roadSegmentPlacement;
    if (!pending) return action();
    return pending.then(() => action());
}

// Double-click finishes the road; the map's own double-click zoom is off while the tool is open.
// The pair's first click placed its point and the second added nothing (isDoubleClickFollowUp),
// but the first may still be placing — its footprint preload is async — so the finish waits for it.
function handleRoadDoubleClick(e) {
    if (e) L.DomEvent.stopPropagation(e);
    return afterRoadPlacement(() => {
        if (!roadDrawingMode || !hasDrawableCorridor() || roadFinalizationGate.isRunning()) return false;
        return finishRoadDrawing();
    });
}

// The map zooms on a double-click; while the tool is open a double-click builds the road instead.
// Given back on exit only if it was on when the tool took it.
let roadDrawingHeldDoubleClickZoom = false;

function holdRoadDoubleClickZoom() {
    const handler = (typeof map !== 'undefined' && map) ? map.doubleClickZoom : null;
    if (!handler || typeof handler.enabled !== 'function' || !handler.enabled()) return;
    handler.disable();
    roadDrawingHeldDoubleClickZoom = true;
}

function releaseRoadDoubleClickZoom() {
    if (!roadDrawingHeldDoubleClickZoom) return;
    roadDrawingHeldDoubleClickZoom = false;
    try { map.doubleClickZoom.enable(); } catch (_) { }
}

// Existing streets are snap targets whether or not their reference layer is shown: their centre
// lines are loaded for the viewport when the tool opens and again (debounced) after every move.
function handleRoadDrawingMoveEnd() {
    window.LegacyRoadCenterlines?.scheduleLoad?.();
}

// Toggle manual road drawing with the "R" keyboard shortcut (same as clicking the "Draw Road" button).
// Mirrors the project's hotkey patterns (e.g. proposals "C", owner counts "O") and avoids triggering while typing or while modals are open.
let roadDrawHotkeyAttached = false;

function isEditableTarget(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return target.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || tagName === 'OPTION';
}

function isElementVisiblyRendered(el) {
    if (!el) return false;
    const style = (typeof window !== 'undefined' && window.getComputedStyle)
        ? window.getComputedStyle(el)
        : (el.style || {});
    const display = style.display;
    const visibility = style.visibility;
    const hidden = el.getAttribute && el.getAttribute('aria-hidden') === 'true';
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const hasArea = rect && rect.width > 0 && rect.height > 0;
    return !hidden && display !== 'none' && visibility !== 'hidden' && hasArea;
}

function isAnyModalOpen() {
    if (typeof document === 'undefined') return false;
    if (document.body && document.body.classList && document.body.classList.contains('modal-open')) return true;

    // If any modal overlay is visible, don't hijack keys.
    const modalSelectors = [
        '.create-proposal-modal',
        '.welcome-modal',
        '.parcel-coverage-modal',
        '.proposal-info-modal',
        '.parcel-list-modal',
        '.parcel-selection-modal',
        '.agent-dialog-modal',
        '.lens-modal',
        '.login-modal',
        '.logout-modal',
        '[role="dialog"]',
        '[aria-modal="true"]',
        'dialog[open]'
    ];
    try {
        const nodes = document.querySelectorAll(modalSelectors.join(','));
        for (const el of nodes) {
            // The cross-section editor matches [role="dialog"] but is NOT blocking: it docks beside
            // a live map, and B (which survey am I looking at) is exactly the key you reach for
            // while profiling a road. Its own dialogs still match and still block.
            if (el.closest && el.closest('.corridor-editor-overlay')) continue;
            if (isElementVisiblyRendered(el)) return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

// Entering road drawing SHOWS the buildings the cutter collides with. Detection intersects the
// corridor with the GDI survey pool — footprints the default map never draws — so a segment could
// LOOK clear of a building the click then reports as hit (the raster basemap draws a different,
// smaller outline). WYSIWYG: R turns the GDI reference layer on silently (no B dialog, the other
// surveys untouched); leaving the tool restores the map as it was, unless the user flipped the
// layer themselves in between.
let roadDrawingAutoShowedBuildings = false;
function autoShowBuildingsForRoadDrawing() {
    const gdiBox = document.getElementById('showBuildings');
    if (!gdiBox || gdiBox.checked) { roadDrawingAutoShowedBuildings = false; return; }
    const dguBox = document.getElementById('showBuildingsDgu');
    const osmBox = document.getElementById('showBuildingsOsm');
    setBuildingReferenceLayers(true, !!(dguBox && dguBox.checked), !!(osmBox && osmBox.checked));
    roadDrawingAutoShowedBuildings = true;
}
function restoreBuildingsAfterRoadDrawing() {
    if (!roadDrawingAutoShowedBuildings) return;
    roadDrawingAutoShowedBuildings = false;
    const gdiBox = document.getElementById('showBuildings');
    if (!gdiBox || !gdiBox.checked) return; // the user turned it off themselves — nothing to undo
    const dguBox = document.getElementById('showBuildingsDgu');
    const osmBox = document.getElementById('showBuildingsOsm');
    setBuildingReferenceLayers(false, !!(dguBox && dguBox.checked), !!(osmBox && osmBox.checked));
}

// Any road operation needs the buildings on the map IMMEDIATELY — a corridor decision is a
// decision about buildings. GDI (the survey detection and cutting run on) switches on
// automatically, no dialog; a survey combination the user already chose is left alone.
function ensureRoadOperationBuildings(bounds) {
    // This prepares the Leaflet editing viewport, never the model/photo scene. A 3D selection
    // must not reload 2D footprints and trigger another 3D rebuild/selection notification.
    if ((window.__mapModeState?.desired && window.__mapModeState.desired !== '2d')
        || window.__pending3DMode || window.isThreeModeActive?.()) return Promise.resolve();
    try {
        const dialog = window.BuildingLayersDialog;
        const current = (dialog && typeof dialog.currentBuildingLayerState === 'function')
            ? dialog.currentBuildingLayerState()
            : null;
        if (!current || (!current.gdi && !current.dgu && !current.osm)) {
            if (dialog && typeof dialog.remember === 'function') {
                try { dialog.remember({ gdi: true, dgu: false, osm: false }); } catch (_) { }
            }
            setBuildingReferenceLayers(true, false, false);
        }
        if (typeof window.rebuildBuildingLayerFromPool === 'function') {
            try { window.rebuildBuildingLayerFromPool(); } catch (_) { }
        }
        const area = bounds || ((typeof map !== 'undefined' && map && typeof map.getBounds === 'function') ? map.getBounds() : null);
        if (area && typeof window.ensureBuildingFootprintsForBounds === 'function') {
            return window.ensureBuildingFootprintsForBounds(area).catch(() => { });
        }
    } catch (error) {
        console.warn('[ensureRoadOperationBuildings] could not prepare buildings', error);
    }
    return Promise.resolve();
}

function setBuildingReferenceLayers(gdi, dgu, osm) {
    const gdiBox = document.getElementById('showBuildings');
    const dguBox = document.getElementById('showBuildingsDgu');
    const osmBox = document.getElementById('showBuildingsOsm');
    if (gdiBox && gdiBox.checked !== gdi) {
        gdiBox.checked = gdi;
        if (typeof toggleLayer === 'function') toggleLayer('buildings');
    }
    if (dguBox && dguBox.checked !== dgu) {
        dguBox.checked = dgu;
        if (typeof toggleLayer === 'function') toggleLayer('buildingsDgu');
    }
    if (osmBox && osmBox.checked !== osm) {
        osmBox.checked = osm;
        if (typeof toggleLayer === 'function') toggleLayer('buildingsOsm');
    }
    // The road profiler measures against whatever survey is on the map, so it has to hear about it.
    try {
        document.dispatchEvent(new CustomEvent('building-layers-changed', { detail: { gdi, dgu, osm } }));
    } catch (_) { }
}

// B opens the building-layers picker — EVERY time, prefilled with what is currently on. The three
// surveys are independent references (any combination is legal), so it is a set of checkboxes with
// Show focused: Enter takes the answer, Escape leaves the map alone. It never changes what a
// corridor cuts — that reads the feature pool — but it does decide what the profiler measures.
async function toggleBuildingReferenceLayers() {
    if (!window.BuildingLayersDialog) return;
    const picked = await window.BuildingLayersDialog.open();
    if (!picked) return;
    setBuildingReferenceLayers(picked.gdi, picked.dgu, picked.osm);
}

function handleRoadDrawHotkey(event) {
    if (document.body.classList.contains('three-mode-active')) return;
    if (!event) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (isAnyModalOpen()) return;
    if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        toggleBuildingReferenceLayers();
        return;
    }
    if (event.key !== 'r' && event.key !== 'R') return;

    if (typeof toggleRoadDrawTool !== 'function') return;
    event.preventDefault();
    requestRoadDrawTool();
}

function attachRoadDrawHotkey() {
    if (roadDrawHotkeyAttached) return;
    document.addEventListener('keydown', handleRoadDrawHotkey);
    roadDrawHotkeyAttached = true;
}

if (typeof window !== 'undefined') {
    window.toggleBuildingReferenceLayers = toggleBuildingReferenceLayers;
    window.setBuildingReferenceLayers = setBuildingReferenceLayers;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachRoadDrawHotkey, { once: true });
    } else {
        attachRoadDrawHotkey();
    }
}

// Update undo button enabled/disabled state
function updateUndoButtonState() {
    const undoButton = document.getElementById('undoRoadButton');
    if (undoButton) {
        if (roadDrawingMode) {
            const currentSegment = roadHasStarted
                ? roadPoints
                : (roadSegments[roadSegments.length - 1] || []);
            // Mirrors RoadStrokeState.applyRoadUndo: any point, the stroke's first one included, undoes.
            undoButton.disabled = !currentSegment || currentSegment.length < 1;
        } else {
            undoButton.disabled = true;
        }
    }
}

// The rubber band from the pen to the pointer, its outline and the parcels it lights up.
function clearRoadRubberBand() {
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
        roadPreviewLine = null;
    }
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }
    clearPreviewAffectedParcels();
}

// What the status line says while the pen is down: how to add, build, lift and place freely.
function roadPenDownStatusText() {
    return corridorDrawingIsTrack()
        ? translateRoadText('panel.road.addPointsHintTrack', 'Click to add track points. Double-click or Enter builds the track, Esc lifts the pen, Alt places without snapping.')
        : translateRoadText('panel.road.addPointsHint', 'Click to add road points. Double-click or Enter builds the road, Esc lifts the pen, Alt places without snapping.');
}

// What the status line says while the pen is up: how to go on, or — with nothing drawable yet —
// how to start.
function roadPenUpStatusText() {
    const isTrack = corridorDrawingIsTrack();
    if (!hasDrawableCorridor()) {
        return isTrack
            ? translateRoadText('panel.road.startHintTrack', 'Click on the map to start drawing a track')
            : translateRoadText('status.messages.click_on_the_map_to_start_drawing_a_road', 'Click on the map to start drawing a road');
    }
    return isTrack
        ? translateRoadText('panel.road.penLiftedStatusTrack', 'Pen lifted — click a node to continue from it, or anywhere to start a new stretch. Enter builds the track.')
        : translateRoadText('panel.road.penLiftedStatus', 'Pen lifted — click a node to continue from it, or anywhere to start a new stretch. Enter builds the road.');
}

// Escape with the pen down LIFTS it: every point the stroke placed stays (road-stroke-state.js
// applyPenLift) and only a lone click — no line — is dropped. Escape used to cancel the stroke,
// which removed what it had placed with no undo, while the status claimed the opposite. The rubber
// band goes with the pen; a click on a node then continues from it (resumeRoadSegment, or a branch
// from a vertex or an edge) and a click anywhere else starts a new stretch.
function liftRoadPen() {
    if (!roadHasStarted || !Array.isArray(roadPoints)) return false;
    const result = window.RoadStrokeState.applyPenLift({
        segments: roadSegments,
        segmentIds: roadSegmentIds,
        activeIndex: roadSegments.indexOf(roadPoints),
        hasStarted: roadHasStarted
    });
    roadHasStarted = result.hasStarted;
    roadPoints = result.activeIndex >= 0 ? roadSegments[result.activeIndex] : [];
    clearRoadRubberBand();
    clearPendingRoadSegment();
    if (result.dropped) {
        // A lone click has no edge and no land: only its marker and centre-line vertex go.
        pruneRoadEdgeConflicts();
        rebuildRoadGeometryFromSegments();
        redrawRoadVertexMarkers();
    }
    updateRoadInfoPanel();
    updateUndoButtonState();
    updateStatus(roadPenUpStatusText());
    return true;
}

// ---------------------------------------------------------------------------
// Obstacles: recorded while drawing, reviewed once at Finish (road-editor.md decision 5)
//
// A click used to stop and ask, edge by edge, about every building, plot, park and crossed road its
// new edge met — up to four modals, then the same again for the next edge. Now a click only FINDS
// them and records them against its edge (roadEdgeConflicts), a red ring marks each one and the
// status line keeps count. Finish asks once for the whole drawing, in a fixed order and through the
// same dialogs, and applies the answers as the click used to (applyRoadConflictAnswers).
// ---------------------------------------------------------------------------

// What one edge runs into. The footprints along it must already be loaded
// (ensureBuildingFootprintsForRoadEdge): the pool only covers fetched viewports.
function detectRoadEdgeConflicts(from, to, segmentPolygon, profile) {
    const entry = {
        key: corridorTunnelEdgeKey(from, to),
        from: { lat: Number(from.lat), lng: Number(from.lng) },
        to: { lat: Number(to.lat), lng: Number(to.lng) },
        buildings: [],
        plots: { plots: [], blocked: [] },
        structures: [],
        crossings: [],
        markers: []
    };
    // A pedestrian route over a road: at grade, under or over.
    if (typeof detectPedestrianRoadCrossings === 'function') {
        entry.crossings = detectPedestrianRoadCrossings(from, to, profile);
    }
    if (segmentPolygon && typeof detectLoadedBuildingTunnelIntersections === 'function') {
        // A building this drawing already tunnels or keeps at surface keeps that decision. Continuing
        // a corridor reloads its tunnels into roadBuildingTunnels (seedRoadDrawing), so an edge that
        // grazes a building already tunnelled is not asked about again — the same building-keyed
        // reuse the two edit paths use, so a road's relation to a building is decided once.
        const alreadyTunnelledIds = new Set((roadBuildingTunnels || []).flatMap(record => (record?.buildingIds || []).map(String)));
        entry.buildings = detectLoadedBuildingTunnelIntersections(segmentPolygon)
            .filter(hit => !roadSurfaceBuildingIds.has(String(hit.id)) && !alreadyTunnelledIds.has(String(hit.id)));
        // Subdivision/readjustment plots in the way, and the proposal buildings standing in the way
        // (corridor-structures.js, proposals/plot-crossings.js).
        if (typeof detectPlotCrossings === 'function') {
            entry.plots = detectPlotCrossings(segmentPolygon, entry.buildings);
        }
        // Parks/squares/lakes in the way.
        if (typeof detectStructureCrossings === 'function') {
            entry.structures = detectStructureCrossings(segmentPolygon);
        }
    }
    entry.markers = roadConflictMarkerPoints(entry, segmentPolygon);
    return entry;
}

// Where the red rings go: each building's middle, the middle of the part of a park the edge
// crosses (a park's own middle can be far off), each crossing's point, and — for plots, which come
// without geometry — the middle of the edge.
function roadConflictMarkerPoints(entry, segmentPolygon) {
    const points = [];
    const middle = feature => {
        try {
            const [lng, lat] = turf.centroid(feature).geometry.coordinates;
            return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        } catch (_) {
            return null;
        }
    };
    const push = point => { if (point) points.push(point); };
    entry.buildings.forEach(hit => push(hit.feature ? middle(hit.feature) : null));
    let corridor = null;
    try { corridor = entry.structures.length ? corridorFeatureFromLatLngRing(segmentPolygon) : null; } catch (_) { corridor = null; }
    entry.structures.forEach(hit => {
        let crossed = null;
        try { crossed = corridor ? turf.intersect(corridor, hit.feature) : null; } catch (error) {
            // Marker placement only: the ring goes to the structure's own middle, reported.
            const api = window.__parcelArrangement || null;
            if (api) api.reportClipFailure('intersect', error, { site: 'road-drawing.conflictMarker' }, [corridor, hit.feature]);
            else console.error(`[${new Date().toISOString()}] [clip] intersect failed at road-drawing.conflictMarker`, error);
            crossed = null;
        }
        push(middle(crossed || hit.feature));
    });
    entry.crossings.forEach(hit => push(hit.point ? { lat: hit.point.lat, lng: hit.point.lng } : null));
    if ((entry.plots.plots || []).length || (entry.plots.blocked || []).length) {
        push({ lat: (entry.from.lat + entry.to.lat) / 2, lng: (entry.from.lng + entry.to.lng) / 2 });
    }
    return points;
}

// File one edge's obstacles; an edge that meets nothing has no entry.
function recordRoadEdgeConflicts(entry) {
    if (!entry || !entry.key) return false;
    if (window.RoadStrokeState.edgeConflictCount(entry) > 0) {
        roadEdgeConflicts.set(entry.key, entry);
        return true;
    }
    roadEdgeConflicts.delete(entry.key);
    return false;
}

// Only the obstacles of edges the drawing still has: an undo or a dropped stub takes its edges'
// obstacles, and their rings, with it.
function pruneRoadEdgeConflicts() {
    if (!roadEdgeConflicts.size) return;
    roadEdgeConflicts = window.RoadStrokeState.retainLiveEdgeConflicts(
        getAllRoadSegments(true), roadEdgeConflicts, corridorTunnelEdgeKey
    );
    redrawRoadConflictMarkers();
}

function redrawRoadConflictMarkers() {
    if (roadConflictMarkerLayer && typeof map !== 'undefined' && map && map.hasLayer(roadConflictMarkerLayer)) {
        map.removeLayer(roadConflictMarkerLayer);
    }
    roadConflictMarkerLayer = null;
    if (!roadEdgeConflicts.size || typeof L === 'undefined') return;
    const pane = ensureRoadDrawingMarkerPane();
    const group = L.layerGroup();
    const seen = new Set();
    roadEdgeConflicts.forEach(entry => (entry.markers || []).forEach(point => {
        const key = `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
        if (seen.has(key)) return;
        seen.add(key);
        L.circleMarker([point.lat, point.lng], {
            radius: 7, color: '#dc2626', weight: 2.5, opacity: 0.95, fill: false,
            className: 'road-conflict-marker', interactive: false,
            ...(pane ? { pane } : {})
        }).addTo(group);
    }));
    roadConflictMarkerLayer = group.addTo(map);
}

// "2 buildings and 1 park": counts by kind ({ buildings, plots, parks, squares, lakes, crossings })
// as one list in the interface language.
function roadConflictListText(counts) {
    const parts = [];
    const part = (count, key, one, other) => {
        if (count > 0) parts.push(translateRoadText(key, count === 1 ? one : other, { count }));
    };
    part(counts.buildings, 'blockify.modal.messages.buildingCount', '{{count}} building', '{{count}} buildings');
    part(counts.plots, 'panel.road.conflictPlots', 'plots of {{count}} design', 'plots of {{count}} designs');
    part(counts.parks, 'panel.road.conflictParks', '{{count}} park', '{{count}} parks');
    part(counts.squares, 'panel.road.conflictSquares', '{{count}} square', '{{count}} squares');
    part(counts.lakes, 'panel.road.conflictLakes', '{{count}} lake', '{{count}} lakes');
    part(counts.crossings, 'panel.road.conflictCrossings', '{{count}} road crossing', '{{count}} road crossings');
    if (parts.length <= 1) return parts[0] || '';
    const language = (typeof window !== 'undefined' && window.i18n?.getLanguage?.()) || 'en';
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(parts);
}

// "2 buildings and 1 park in the way — you decide at Finish", or null when nothing is.
function roadConflictsStatusText() {
    const summary = window.RoadStrokeState.summarizeEdgeConflicts(roadEdgeConflicts);
    if (!summary.total) return null;
    return translateRoadText('panel.road.conflictsRecordedStatus', '{{list}} in the way — you decide at Finish.', {
        list: roadConflictListText(summary)
    });
}

// The one review of everything the drawing ran into, in a fixed order: plots, buildings, parks/
// squares/lakes, then a pedestrian route's crossings of roads. "Choose another route" (or closing a
// dialog) returns to the drawing with nothing changed and the status naming what is in the way;
// answering everything applies the answers before the graph is normalized and the road built.
// Returns false when the drawing stays open.
async function reviewRoadConflictsAtFinish() {
    // A finish that is refused anyway (a click still placing, an unapplied width change) asks
    // nothing: finishRoadDrawingOnce says why.
    if (roadSegmentPlacementInProgress || roadDrawingProfileValidationPending) return true;
    pruneRoadEdgeConflicts();
    if (!roadEdgeConflicts.size) return true;
    const merged = window.RoadStrokeState.mergeEdgeConflicts(roadEdgeConflicts);
    const kind = corridorDrawingKind();
    const refuse = counts => {
        updateStatus(translateRoadText(
            'panel.road.finishBlockedStatus',
            'Not built — {{list}} in the way. Undo or reroute around the red rings, then finish again.',
            { list: roadConflictListText({ buildings: 0, plots: 0, parks: 0, squares: 0, lakes: 0, crossings: 0, ...counts }) }
        ));
        return false;
    };

    if (merged.plots.plots.length || merged.plots.blocked.length) {
        if (!(await resolvePlotCrossings(merged.plots, kind))) {
            return refuse({ plots: merged.plots.plots.length, buildings: merged.plots.blocked.length });
        }
    }
    // One answer for every building in the way: at surface, or tunnels through all of them.
    let buildings = null;
    if (merged.buildings.length) {
        const resolution = await resolveBuildingObstacles(merged.buildings, kind);
        if (resolution.action === 'cancel') return refuse({ buildings: merged.buildings.length });
        buildings = resolution.action;
    }
    if (merged.structures.length) {
        if (!(await resolveStructureCrossings(merged.structures, kind))) {
            const ofKind = structureKind => merged.structures.filter(hit => hit.kind === structureKind).length;
            return refuse({ parks: ofKind('park'), squares: ofKind('square'), lakes: ofKind('lake') });
        }
    }
    // One question for all the crossings, not the per-edge resolvePedestrianRoadCrossings.
    let crossings = null;
    if (merged.crossings.length) {
        const prompt = buildPedestrianCrossingPrompt(merged.crossings);
        const answer = (await showStyledChoice(prompt.message, prompt.choices)) || 'cancel';
        if (answer === 'cancel') return refuse({ crossings: merged.crossings.length });
        crossings = answer;
    }
    applyRoadConflictReview({ buildings, crossings });
    return true;
}

// The review's answers on the drawing (road-stroke-state.js applyRoadConflictAnswers): portals and
// ramp ends become vertices, tunnels and grade separations become records, buildings kept at
// surface are remembered so no later edge asks about them again. Decided obstacles lose their rings.
function applyRoadConflictReview(answers) {
    const result = window.RoadStrokeState.applyRoadConflictAnswers(
        { segments: roadSegments, segmentIds: roadSegmentIds, conflicts: roadEdgeConflicts },
        answers,
        roadConflictAnswerDeps()
    );
    result.tunnels.forEach(record => { roadBuildingTunnels = addBuildingTunnelRecord(roadBuildingTunnels, record); });
    result.gradeSeparations.forEach(record => roadGradeSeparations.push(record));
    result.surfaceBuildingIds.forEach(id => roadSurfaceBuildingIds.add(String(id)));
    roadEdgeConflicts = new Map();
    redrawRoadConflictMarkers();
    if (result.insertedPoints || result.tunnels.length || result.gradeSeparations.length) {
        rebuildRoadGeometryFromSegments();
        redrawRoadVertexMarkers();
        refreshRoadBuildingTunnelLayer();
        refreshRoadGradeSeparationLayer();
    }
    return result;
}

function roadConflictAnswerDeps() {
    return {
        edgeKeyOf: corridorTunnelEdgeKey,
        widthOf: roadDrawingWidthForSegmentIndex,
        clipEdgeThroughBuildings: (from, to, hits, width) => clipCorridorEdgeThroughBuildings(from, to, hits, width),
        makeTunnelRecord: makeBuildingTunnelRecord,
        buildGradeSeparationRecords,
        refreshGradeSeparationEdgeKeys,
        // The deck or trough a crossing's ramps carry, stored as the click used to store it.
        gradeSeparationFootprint: (record, width) => {
            try {
                const ring = calculateRoadPolygon([record.from, record.crossing, record.to], width, roadSessionFrame());
                const feature = ring && typeof corridorFeatureFromLatLngRing === 'function'
                    ? corridorFeatureFromLatLngRing(ring)
                    : null;
                return feature?.geometry || null;
            } catch (_) {
                return null;
            }
        }
    };
}

// Undo last road segment
function undoLastRoadSegment() {
    // The resume/pop/drop-empty logic (and keeping roadSegmentIds aligned) is the pure reducer in
    // road-stroke-state.js. It mutates segments/segmentIds in place and returns the removed edge(s)
    // and the new pen state; here we apply the tunnel cleanup and re-alias roadPoints.
    const result = window.RoadStrokeState.applyRoadUndo({
        segments: roadSegments,
        segmentIds: roadSegmentIds,
        activeIndex: roadHasStarted ? roadSegments.indexOf(roadPoints) : -1,
        hasStarted: roadHasStarted
    });
    if (!result.undone) {
        return; // Nothing to undo
    }
    if (typeof removeBuildingTunnelEdge === 'function') {
        result.removedEdges.forEach(([from, to]) => {
            roadBuildingTunnels = removeBuildingTunnelEdge(roadBuildingTunnels, from, to);
        });
    }
    if (typeof retainLiveGradeSeparations === 'function') {
        roadGradeSeparations = retainLiveGradeSeparations(roadSegments, roadGradeSeparations);
    }
    roadHasStarted = result.hasStarted;
    roadPoints = result.activeIndex >= 0 ? roadSegments[result.activeIndex] : [];
    // Undoing a stroke's only point puts the pen up: the rubber band from that point is gone too
    // (the mousemove handler draws none while the pen is up, so nothing would remove it).
    if (!roadHasStarted) clearRoadRubberBand();
    // The undone edge's obstacles are no longer in the way.
    pruneRoadEdgeConflicts();

    // Markers are rebuilt from the segments below, so nothing to pop here.

    // Rebuild centerline, polygon and vertex markers from the segments, then re-derive the locked
    // parcels from the resulting corridor.
    const updatedPolygon = rebuildRoadGeometryFromSegments();
    redrawRoadVertexMarkers();
    refreshRoadBuildingTunnelLayer();
    refreshRoadGradeSeparationLayer();
    recomputeLockedParcelsFromPolygon(updatedPolygon);

    setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
    updateRoadOwnershipCounts(roadAffectedParcels);
    updateRoadMarketPrice(roadAffectedParcels);
    updateRoadAcquiringDifficulty(roadAffectedParcels);
    updateRoadInfoPanel();
    // Undo with the pen up resumes the last segment, so the pen may be down again: say which.
    updateStatus(roadHasStarted ? roadPenDownStatusText() : roadPenUpStatusText());

    // Update undo button state
    updateUndoButtonState();
}


// Handle corridor drawing clicks — a road's and a track's, which are one and the same.
async function handleRoadClick(e) {
    // Stop event propagation to prevent parcel selection or other click handlers
    L.DomEvent.stopPropagation(e);

    // The second click of a double-click adds nothing: the first placed the point, and the pair
    // builds the road (handleRoadDoubleClick).
    const clickedAt = Date.now();
    const previousClickAt = roadLastClickAt;
    roadLastClickAt = clickedAt;
    if (window.RoadStrokeState.isDoubleClickFollowUp(e && e.originalEvent, previousClickAt, clickedAt)) return;

    if (roadFinalizationGate.isRunning() || roadSegmentPlacementInProgress) return;
    if (roadDrawingProfileValidationPending) {
        updateStatus('Apply or cancel the cross-section change before drawing another segment.');
        return;
    }
    // The cross-section editor docks beside a live, pannable map — a click on it must not
    // place a drawing point behind the editor's back.
    if (typeof isCorridorEditorOpen === 'function' && isCorridorEditorOpen()) return;
    roadSegmentPlacementInProgress = true;
    let settlePlacement = () => {};
    roadSegmentPlacement = new Promise(resolve => { settlePlacement = resolve; });
    try {

    // Snap to an existing vertex or edge so segments that look connected really do share a node.
    // Drawing NEVER mutates or removes a placed road: a snap onto an existing corridor only donates
    // the exact position for this new segment's vertex, attaching it to that vertex/centerline. The
    // junction is formed ONCE, at finish: planCorridorAuthoring (proposals/corridor-authoring.js)
    // inserts the shared node into every touched applied corridor, atomically with the new record.
    // Corridors are never merged on connect (merge-on-connect was removed 2026-08-07). Alt held
    // places the point exactly where the pointer is.
    let snap = roadSnapSuppressed(e) ? null : findRoadSnapTarget(e.latlng);
    let clickPoint = snap ? snap.latlng : e.latlng;
    clearRoadSnapMarker();

    // Preserve the authored position, including exact snap connections. Finish reviews the
    // actual track curvature against the selected target instead of extending a click far away.

    // Clicking an existing segment's end while the pen is up — before drawing has started, or after
    // Escape lifted it — continues that segment instead of beginning a new one: the same segment,
    // extended, not a second one that happens to touch.
    if (!roadHasStarted && snap && snap.type === 'endpoint') {
        if (resumeRoadSegment(snap.segmentIndex, snap.atStart)) {
            redrawRoadVertexMarkers();
            rebuildRoadGeometryFromSegments();
            updateStatus(corridorDrawingIsTrack()
                ? translateRoadText('panel.road.continueHintTrack', 'Continuing this segment — click to add points. Double-click or Enter builds the track, Esc lifts the pen.')
                : translateRoadText('panel.road.continueHint', 'Continuing this segment — click to add points. Double-click or Enter builds the road, Esc lifts the pen.'));
            updateRoadInfoPanel();
            updateUndoButtonState();
            return;
        }
    }

    // Meeting a segment part-way along splits no geometry, it just gives the two segments a node to
    // share. Insert it now so both the existing segment and the one starting here reference it.
    if (snap && snap.type === 'edge' && insertRoadNodeOnEdge(snap.segmentIndex, snap.insertAfter, clickPoint)) {
        redrawRoadVertexMarkers();
    }

    if (!roadHasStarted) {
        // First click - start the road
        roadPoints = [clickPoint];
        pushRoadSegment(roadPoints);
        roadHasStarted = true;
        rememberRoadStreetConnection(snap, clickPoint);

        // Add marker for the starting point
        const startMarker = createRoadVertexMarker(clickPoint);
        roadMarkers.push(startMarker); // Store the marker

        // Initialize road centerline
        const centerlinePoints = getAllRoadSegments(true);
        if (roadCenterline) {
            roadCenterline.setLatLngs(centerlinePoints);
        } else {
            roadCenterline = L.polyline(centerlinePoints, {
                color: 'green',
                weight: 3,
                dashArray: '5, 5',
                opacity: 0.7
            }).addTo(map);
        }

        // Show status for next point
        updateStatus(roadPenDownStatusText());
    } else {
        // Clicking the stroke's own last vertex again adds no edge (road-stroke-state.js).
        if (window.RoadStrokeState.isRepeatedStrokeVertex(roadPoints[roadPoints.length - 1], clickPoint)) return;
        const stroke = roadPoints;
        const segmentPoints = [stroke[stroke.length - 1], clickPoint];
        // Detect with the width THIS segment will actually be drawn at (per-segment override
        // included); validating at plain roadWidth can accept a wider rendered edge unchecked.
        const activeSegmentIndex = roadSegments.indexOf(stroke);
        const activeSegmentWidth = activeSegmentIndex >= 0 ? roadDrawingWidthForSegmentIndex(activeSegmentIndex) : roadWidth;
        const segmentPolygon = calculateRoadPolygon(segmentPoints, activeSegmentWidth, roadSessionFrame(segmentPoints));
        // The new edge stays visible at its real width while the footprints along it load and what
        // it runs into is found.
        showPendingRoadSegment(segmentPolygon);
        // Load footprints along THIS edge — the pool only covers fetched viewports, so an
        // unloaded building would silently pass detection and stay standing under the road.
        if (segmentPolygon && typeof window.ensureBuildingFootprintsForBounds === 'function') {
            try {
                await ensureBuildingFootprintsForRoadEdge(segmentPoints[0], segmentPoints[1], activeSegmentWidth);
            } catch (error) {
                console.error('[road-drawing] footprint preload for edge failed', error);
            }
        }
        // The tool closed, or the stroke went, while the footprints loaded: nothing to add it to.
        if (!roadDrawingMode || !roadHasStarted || roadPoints !== stroke || roadSegments.indexOf(stroke) < 0) {
            console.warn(`[${new Date().toISOString()}] [road-drawing] the stroke changed while its edge was being placed; the click is dropped`);
            return;
        }
        // What the edge runs into — buildings, plots, parks/squares/lakes, roads a pedestrian route
        // crosses — is RECORDED, not asked: it is reviewed once for the whole drawing at Finish
        // (reviewRoadConflictsAtFinish), which also inserts any tunnel portals and ramp ends.
        const activeProfile = roadDrawingSegmentOverride(activeSegmentIndex) || roadProfile;
        const conflict = detectRoadEdgeConflicts(segmentPoints[0], segmentPoints[1], segmentPolygon, activeProfile);

        // Add another point to the road (the polygon for the new edge is built below, once).
        stroke.push(clickPoint);
        recordRoadEdgeConflicts(conflict);
        rememberRoadStreetConnection(snap, clickPoint);
        // Laying rail sounds like laying rail.
        if (corridorDrawingIsTrack()) playTrackSegmentSound();

        // Add marker for this point
        const pointMarker = createRoadVertexMarker(clickPoint);
        roadMarkers.push(pointMarker); // Store the marker

        // Update the centerline
        const centerlinePoints = getAllRoadSegments(true);
        if (roadCenterline) {
            roadCenterline.setLatLngs(centerlinePoints);
        } else {
            roadCenterline = L.polyline(centerlinePoints, {
                color: 'green',
                weight: 3,
                dashArray: '5, 5',
                opacity: 0.7
            }).addTo(map);
        }

        // Wrap the entire segment processing in try...catch for robustness
        try {
            // Clear any existing *preview* highlighting and polygon layers
            // Do this *before* calculating the new committed polygon
            clearPreviewAffectedParcels();
            if (roadPreviewPolygonLayer) {
                roadPreviewPolygonLayer.removeFrom(map);
                roadPreviewPolygonLayer = null;
            }
            if (roadPreviewLine) {
                roadPreviewLine.removeFrom(map);
                roadPreviewLine = null;
            }

            // The committed land is rebuilt from the whole centre line by the shared construction in
            // the session frame: one construction path, so the land seen while drawing is the land
            // that is stored (an incremental union of per-click pieces kept whichever operand
            // survived a failed union).
            const newCommittedPolygon = buildRoadUnionPolygonWithWidths(
                centerlinePoints,
                centerlinePoints.map((_, index) => roadDrawingWidthForSegmentIndex(index)),
                roadWidth,
                roadSegmentIds,
                roadSessionFrame()
            );
            cachedCommittedPolygon = newCommittedPolygon;

            // Update the global roadPolygon variable
            roadPolygon = newCommittedPolygon;

            // Remove the *previous* committed polygon layer before adding the new one
            if (roadPolygonLayer) {
                map.removeLayer(roadPolygonLayer);
                roadPolygonLayer = null; // Ensure it's cleared
            }

            if (roadPolygon) {
                // Draw the new committed road polygon
                roadPolygonLayer = L.polygon(roadPolygon, {
                    color: 'green',
                    weight: 2,
                    fillColor: 'green',
                    fillOpacity: 0.3
                }).addTo(map);

                // INCREMENTAL: only the land around the NEW edge is matched against parcels. That is the
                // committed land near it, not the edge's own rectangle, which leaves out the wedge at a
                // bend and the corner where the edge joins another stretch.
                if (segmentPolygon) {
                    lockParcelsFromSegment(roadLandNearEdge(roadPolygon, segmentPoints, activeSegmentWidth) || segmentPolygon);
                }

                // Redraw the cross-section over the committed corridor (commit only, never on preview).
                redrawRoadStrips();
            } else {
                console.warn("Failed to calculate committed road polygon after click.");
            }

        } catch (error) {
            console.error('Error processing road segment after click:', error);
        }
        // A red ring on everything in the way, and the count on the status line.
        redrawRoadConflictMarkers();
        const conflictsStatus = roadConflictsStatusText();
        if (conflictsStatus) updateStatus(conflictsStatus);
        roadLastValidatedWidth = roadWidth;
        roadDrawingProfileValidationPending = false;
    }

    // Always update the info panel
    updateRoadInfoPanel();

    // Update undo button state
    updateUndoButtonState();
    } finally {
        roadSegmentPlacementInProgress = false;
        roadSegmentPlacement = null;
        settlePlacement();
        // Whatever became of this click — committed, dropped, or thrown — the edge is no longer
        // being placed. A commit has already drawn it as road; anything else undrew it.
        clearPendingRoadSegment();
    }
}

// The click landed on an existing street: remember which one, so the stored corridor says what it
// joined even though a street is no record to insert a node into.
function rememberRoadStreetConnection(snap, point) {
    if (!snap || snap.source !== 'street' || !point) return;
    roadStreetConnections.push({
        lat: Number(point.lat),
        lng: Number(point.lng),
        wayId: snap.wayId ?? null,
        name: snap.name ?? null
    });
}

// The street connections still on the corridor: a connection whose vertex was undone, or never
// made it into a line, is gone. One per street and point.
function liveRoadStreetConnections(connections, segments) {
    const vertexKeys = new Set();
    (segments || []).forEach(segment => (segment || []).forEach(point => {
        vertexKeys.add(`${Number(point.lat).toFixed(7)},${Number(point.lng).toFixed(7)}`);
    }));
    const seen = new Set();
    return (connections || []).filter(connection => {
        const at = `${Number(connection.lat).toFixed(7)},${Number(connection.lng).toFixed(7)}`;
        const key = `${connection.wayId}@${at}`;
        if (!vertexKeys.has(at) || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(connection => ({ ...connection }));
}

// The finish hand-off copies a fixed list of corridor fields (corridor-draft.js and the road-track
// editor adapter), and both keep whatever the draft's definition already holds. So the street
// connections are written into the draft's definition itself, together with those a reopened
// corridor already had that are still on its centre line.
function writeStreetConnectionsToDraft(draftId, connections, centerline) {
    const store = (typeof window !== 'undefined') ? window.proposalDraftStore : null;
    const definition = store?.getDraft?.(draftId)?.editorPayload?.definition;
    if (!definition) return;
    const previous = Array.isArray(definition.connections) ? definition.connections : [];
    const kept = liveRoadStreetConnections(previous.concat(connections || []), centerline);
    if (!kept.length && !previous.length) return;
    store.updateDraft(draftId, next => {
        next.editorPayload = {
            ...next.editorPayload,
            definition: { ...next.editorPayload.definition, connections: kept }
        };
        return next;
    }, { coalesceKey: 'corridor-finalize' });
}

// Handle road mouse movement for preview
function handleRoadMouseMove(e) {
    // Show where the click would snap, whether or not a segment is under way: before the first click
    // the highlight tells the user which segment end they are about to continue. Alt held: no snap.
    const snap = roadSnapSuppressed(e) ? null : findRoadSnapTarget(e.latlng);
    showRoadSnapMarker(snap);

    if (!roadHasStarted || !roadPoints || roadPoints.length === 0) return;

    // Get current mouse position (snapped, so the preview lands where the click will)
    const mouseLatLng = snap ? snap.latlng : e.latlng;

    // Display temporary line from last point to current mouse position
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
    }

    // PERFORMANCE: Only calculate polygon for the preview segment (last point to mouse),
    // NOT the entire road. This keeps preview snappy regardless of total segment count.
    const lastPoint = roadPoints[roadPoints.length - 1];
    const previewSegmentPoints = [lastPoint, mouseLatLng];

    try {
        // Calculate polygon only for the preview segment
        // At the width the click will place: a continued segment with its own cross-section keeps it.
        const activeSegmentIndex = roadSegments.indexOf(roadPoints);
        const previewWidth = activeSegmentIndex >= 0 ? roadDrawingWidthForSegmentIndex(activeSegmentIndex) : roadWidth;
        const previewSegmentPolygon = calculateRoadPolygon(previewSegmentPoints, previewWidth, roadSessionFrame(previewSegmentPoints));

        // Only continue if we have a valid polygon
        if (previewSegmentPolygon && previewSegmentPolygon.length >= 3) {
            // Draw the new preview line
            roadPreviewLine = L.polyline(previewSegmentPoints, {
                color: '#ff6600',
                dashArray: '5, 10',
                weight: 2
            }).addTo(map);

            // Draw the new preview polygon (just the preview segment)
            if (roadPreviewPolygonLayer) {
                roadPreviewPolygonLayer.removeFrom(map);
            }
            roadPreviewPolygonLayer = L.polygon(previewSegmentPolygon, {
                color: '#ff6600',
                weight: 1,
                fillColor: '#ff6600',
                fillOpacity: 0.2
            }).addTo(map);

            // Find and highlight parcels affected *only* by the preview segment
            findPreviewAffectedParcels(previewSegmentPolygon);

            // PERFORMANCE: Fast update of road info with cumulative metrics (committed + preview)
            // Avoids recalculating entire road polygon - just add preview segment metrics to cached committed values
            updatePreviewRoadInfo(previewSegmentPoints, previewSegmentPolygon);
        } else {
            // Clear only preview highlighting if polygon becomes invalid
            clearPreviewAffectedParcels();

            // Still show a simple preview line
            roadPreviewLine = L.polyline(previewSegmentPoints, {
                color: '#ff6600',
                dashArray: '5, 10',
                weight: 2
            }).addTo(map);
        }
    } catch (error) {
        console.error('Error in road preview calculation:', error);
        // Clear only preview highlighting on error
        clearPreviewAffectedParcels();

        // Still show a simple preview line
        roadPreviewLine = L.polyline(previewSegmentPoints, {
            color: '#ff6600',
            dashArray: '5, 10',
            weight: 2
        }).addTo(map);
    }
}

// Keep the edge under decision on the map, at the width it will actually be built at, while the
// cut/demolish/tunnel tour (or a crossing/structure prompt) is open. Opening a dialog moves the
// cursor off the map, and mouse-out takes the ordinary preview band with it — which left the
// question "how much of this building does the road cover?" answerable only from a hairline
// centreline. Non-interactive, so it cannot swallow a click meant for the map or the dialog.
function showPendingRoadSegment(polygonLatLngs) {
    clearPendingRoadSegment();
    if (!Array.isArray(polygonLatLngs) || polygonLatLngs.length < 3) return;
    try {
        roadPendingSegmentLayer = L.polygon(polygonLatLngs, {
            color: '#ff6600',
            weight: 2,
            fillColor: '#ff6600',
            fillOpacity: 0.25,
            interactive: false
        }).addTo(map);
    } catch (error) {
        console.error('[road-drawing] Could not draw the pending segment outline', error);
        roadPendingSegmentLayer = null;
    }
}

function clearPendingRoadSegment() {
    if (!roadPendingSegmentLayer) return;
    try { roadPendingSegmentLayer.removeFrom(map); } catch (_) { }
    roadPendingSegmentLayer = null;
}

// Handle road mouse movement out
function handleRoadMouseOut(e) {
    if (!roadDrawingMode) return; // Only act if in drawing mode

    clearRoadSnapMarker();

    // Clear preview line
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
        roadPreviewLine = null;
    }

    // Clear preview polygon
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    // Clear only the preview highlighting
    clearPreviewAffectedParcels();
}

// Stop following the cursor with a preview line/polygon (used when finishing)
function stopRoadPreviewTracking() {
    try {
        map.off('mousemove', handleRoadMouseMove);
        map.off('mouseout', handleRoadMouseOut);
    } catch (_) { }

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }
    clearPreviewAffectedParcels();
}

// The map and keyboard handlers a live drawing listens on; suspendRoadDrawingInteractivity is the inverse.
function attachRoadDrawingInteractivity() {
    map.on('click', handleRoadClick);
    // A double-click builds the road, so the map's double-click zoom is held while drawing.
    map.on('dblclick', handleRoadDoubleClick);
    holdRoadDoubleClickZoom();
    map.on('mousemove', handleRoadMouseMove);
    map.on('mouseout', handleRoadMouseOut);
    // Existing streets are snap targets from the first click, shown or not.
    map.on('moveend', handleRoadDrawingMoveEnd);
    document.addEventListener('keydown', handleRoadKeydown);
}

// Remove interactive handlers while finishing/cancelling
function suspendRoadDrawingInteractivity() {
    try { map.off('click', handleRoadClick); } catch (_) { }
    try { map.off('dblclick', handleRoadDoubleClick); } catch (_) { }
    try { map.off('mousemove', handleRoadMouseMove); } catch (_) { }
    try { map.off('mouseout', handleRoadMouseOut); } catch (_) { }
    try { map.off('moveend', handleRoadDrawingMoveEnd); } catch (_) { }
    document.removeEventListener('keydown', handleRoadKeydown);
    releaseRoadDoubleClickZoom();
}

// Fully exit road drawing mode and clean up UI/handlers
function exitRoadDrawingMode() {
    suspendRoadDrawingInteractivity();
    stopRoadPreviewTracking();

    // Reset state and UI
    resetRoadDrawing();
    updateGlobalRoadDrawingMode(false);
    // The reference layer R turned on goes back the way it was.
    try { restoreBuildingsAfterRoadDrawing(); } catch (_) { }

    // Whichever button opened the session is the one that goes dark.
    const roadDrawButton = corridorDrawButton();
    if (roadDrawButton) {
        roadDrawButton.setAttribute('aria-pressed', 'false');
        roadDrawButton.blur();
    }
    setRoadPanelLabelsForMode('road');

    const roadDrawingControls = document.getElementById('road-drawing-controls');
    if (roadDrawingControls) roadDrawingControls.hidden = true;

    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        roadInfoPanel.classList.remove('visible');
        roadInfoPanel.style.removeProperty('display');
    }

    if (map && map.getContainer) {
        try {
            map.getContainer().style.cursor = '';
            map.getContainer().classList.remove('crosshairs-cursor');
        } catch (_) { }
    }

    const statusElement = document.getElementById('status');
    if (statusElement) updateStatus('');
    window.finishProposalDraftDesignSession?.();
}

// The land of one or more polylines at one width, built by the shared construction
// (corridor-footprint.js footprintOfArms: rectangles, bevels at bends) in `frame` — the drawing
// session's, or the frame of the corridor being edited or rendered. Leaflet nesting (LatLng[] for one
// ring); null for an empty input. Throws when the land cannot be built.
function calculateRoadPolygon(points, width, frame) {
    if (!frame) throw new Error('calculateRoadPolygon: a metric frame is required (projections.md §2)');
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

    // Normalize to an array of centerline segments to support disjoint multi-segment roads
    const segments = [];
    if (Array.isArray(points)) {
        if (points.length && isLatLng(points[0])) {
            segments.push(points);
        } else if (points.length && Array.isArray(points[0])) {
            points.forEach(seg => {
                if (Array.isArray(seg) && seg.length >= 2 && isLatLng(seg[0])) {
                    segments.push(seg);
                }
            });
        }
    }

    if (!segments.length || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: Array.isArray(points) ? points.length : undefined, width });
        return null;
    }
    const arms = segments.map(segment => ({ points: segment, width: Number(width) }));
    return roadPolygonFromGeoJSON(corridorFootprintModule().footprintOfArms(arms, frame));
}


// --- Geometry helpers: detect centerline self-intersections (planar) ---
// polylineHasSelfIntersection and segmentsIntersect moved to frontend/js/corridor-geometry.js
// (loaded first) — planar self-crossing test, now unit-tested. Callers use the globals.

function isLatLngLike(value) {
    return value && typeof value.lat === 'number' && typeof value.lng === 'number';
}

// Accepts Leaflet polygon latLngs in any of these shapes:
// - LatLng[]                 (single ring)
// - LatLng[][]               (polygon with holes: [outer, hole1, hole2...])
// - LatLng[][][]             (multipolygon: [ [rings...], [rings...] ... ])
function isValidPolygonLatLngs(latLngs) {
    if (!Array.isArray(latLngs) || latLngs.length === 0) return false;

    // LatLng[]
    if (isLatLngLike(latLngs[0])) {
        return latLngs.length >= 3;
    }

    // LatLng[][]
    if (Array.isArray(latLngs[0]) && latLngs[0].length && isLatLngLike(latLngs[0][0])) {
        return latLngs[0].length >= 3;
    }

    // LatLng[][][]
    if (Array.isArray(latLngs[0]) && Array.isArray(latLngs[0][0]) && latLngs[0][0].length && isLatLngLike(latLngs[0][0][0])) {
        for (const poly of latLngs) {
            if (Array.isArray(poly) && poly.length > 0 && Array.isArray(poly[0]) && poly[0].length >= 3) {
                return true;
            }
        }
    }

    return false;
}

function polygonLatLngsToTurfFeature(latLngs) {
    if (!isValidPolygonLatLngs(latLngs)) return null;
    if (typeof turf === 'undefined' || !turf) return null;
    if (typeof turf.polygon !== 'function' || typeof turf.multiPolygon !== 'function') return null;

    const toClosedLngLatRing = (ring) => {
        const coords = (Array.isArray(ring) ? ring : [])
            .filter(isLatLngLike)
            .map(p => [p.lng, p.lat]);
        const closed = ensurePolygonIsClosed(coords);
        return Array.isArray(closed) && closed.length >= 4 ? closed : null;
    };

    // LatLng[]
    if (isLatLngLike(latLngs[0])) {
        const ring = toClosedLngLatRing(latLngs);
        return ring ? turf.polygon([ring]) : null;
    }

    // LatLng[][]
    if (Array.isArray(latLngs[0]) && latLngs[0].length && isLatLngLike(latLngs[0][0])) {
        const rings = latLngs.map(toClosedLngLatRing).filter(Boolean);
        return rings.length ? turf.polygon(rings) : null;
    }

    // LatLng[][][]
    if (Array.isArray(latLngs[0]) && Array.isArray(latLngs[0][0]) && latLngs[0][0].length && isLatLngLike(latLngs[0][0][0])) {
        const polys = latLngs
            .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(toClosedLngLatRing).filter(Boolean))
            .filter(rings => rings.length > 0);
        return polys.length ? turf.multiPolygon(polys) : null;
    }

    return null;
}


// The road footprint is built by the shared construction (corridor-footprint.js footprintOfArms,
// see calculateRoadPolygon above), never by a local polygon builder.

// Helper function to ensure a polygon is closed (first and last points match)
function ensurePolygonIsClosed(coords) {
    if (!coords || coords.length < 3) return coords; // Can't close with fewer than 3 points

    const first = coords[0];
    const last = coords[coords.length - 1];

    // Check if first and last points are the same
    if (first[0] !== last[0] || first[1] !== last[1]) {
        // Make a deep copy to avoid modifying the original
        const newCoords = [...coords];
        // Add a copy of the first point at the end
        newCoords.push([...first]);
        return newCoords;
    }

    return coords; // Already closed
}

// convertRoadPolygonToLatLngPairs, convertLatLngPairsToGeoJSON and isValidPolygonLatLngPairs moved
// to frontend/js/corridor-geometry.js (loaded first) — the footprint-shape funnel, now unit-tested
// (incl. the MultiPolygon-vs-holes discrimination). Callers below use the globals unchanged.

// Shared function to find and highlight affected parcels
// Parameters:
//   polygon: Array of {lng, lat} objects
//   previousAffectedParcels: Array of previously affected parcels (to clear highlighting)
//   highlightStyle: Style object to apply to affected parcels
//   excludeParcelIds: Optional array/set of parcel IDs to exclude (e.g., already committed parcels)
//   options: Optional object with { groundInto } — where open ground the polygon crosses is reported
// Returns: Array of affected parcel objects
function findAndHighlightAffectedParcels(polygon, previousAffectedParcels, highlightStyle, excludeParcelIds = null, options = {}) {
    if (!polygon || !getRoadDrawingFabric()) return [];

    const turfPolygon = polygonLatLngsToTurfFeature(polygon);
    if (!turfPolygon) return [];

    // Clear previously affected parcels only after we have a valid polygon
    if (previousAffectedParcels && previousAffectedParcels.length > 0) {
        previousAffectedParcels.forEach(parcel => {
            const pid = getParcelIdFromAny(parcel);
            const layer = getRoadDrawingPresenterLayer(pid);
            if (!pid || !layer || typeof layer.setStyle !== 'function') return;
            const isRoad = typeof window.isRoadParcel === 'function' ? window.isRoadParcel(pid) : false;
            layer.setStyle(isRoad ? roadStyle : normalStyle);
        });
    }

    const affectedParcels = [];
    const excludeSet = excludeParcelIds
        ? new Set(Array.from(excludeParcelIds).map(String))
        : null;

    // A piece another proposal formed on open ground is no parcel to acquire: the query leaves it
    // out of the corridor's parcels (counts, owners, declaration) and reports it as open ground.
    liveRoadDrawingParcelsIntersecting(turfPolygon, { groundInto: options.groundInto }).forEach(feature => {
        const entry = roadDrawingParcelEntry(feature);
        if (!entry || (excludeSet && excludeSet.has(entry.id))) return;
        affectedParcels.push(entry);
        const layer = entry.layer;
        if (layer && typeof layer.setStyle === 'function') layer.setStyle(highlightStyle);
        if (layer && typeof layer.bringToFront === 'function') layer.bringToFront();
    });

    return affectedParcels;
}

// Find NEW parcels affected by a segment polygon (incremental - only adds parcels not already locked)
// This is called on click to add parcels from the newly confirmed segment
// `segmentPolygon` is Leaflet lat/lng rings or a turf Polygon/MultiPolygon feature.
function findNewAffectedParcelsForSegment(segmentPolygon) {
    if (!segmentPolygon || !getRoadDrawingFabric()) return [];

    // Define the green highlight style for committed road parcels
    const committedRoadStyle = {
        fillColor: 'green',
        fillOpacity: 0.6,
        color: 'green',
        weight: 3
    };

    let turfPolygon = null;
    try {
        turfPolygon = segmentPolygon.type === 'Feature' ? segmentPolygon : polygonLatLngsToTurfFeature(segmentPolygon);
    } catch (_) {
        return [];
    }
    if (!turfPolygon) {
        return [];
    }

    const newParcels = [];
    liveRoadDrawingParcelsIntersecting(turfPolygon, { groundInto: roadOpenGroundCrossed.locked }).forEach(feature => {
        const entry = roadDrawingParcelEntry(feature);
        if (!entry || lockedParcelIds.has(entry.id)) return;
        newParcels.push(entry);
        if (entry.layer && typeof entry.layer.setStyle === 'function') entry.layer.setStyle(committedRoadStyle);
        if (entry.layer && typeof entry.layer.bringToFront === 'function') entry.layer.bringToFront();
    });

    return newParcels;
}

// The committed land within a width of the edge from..to, as a turf feature: the edge's own land plus
// the bend wedge and junction corners at its ends. Null when it cannot be cut (the caller falls back
// to the edge's rectangle).
function roadLandNearEdge(landLatLngs, edge, width) {
    if (typeof turf === 'undefined' || typeof turf.bboxClip !== 'function') return null;
    const land = polygonLatLngsToTurfFeature(landLatLngs);
    if (!land || !Array.isArray(edge) || edge.length < 2) return null;
    const reachM = Math.max(Number(width) || 0, 1);
    const midLat = (edge[0].lat + edge[1].lat) / 2;
    const dLat = reachM / 111320;
    const dLng = reachM / (111320 * Math.max(Math.cos(midLat * Math.PI / 180), 1e-6));
    const box = [
        Math.min(edge[0].lng, edge[1].lng) - dLng, Math.min(edge[0].lat, edge[1].lat) - dLat,
        Math.max(edge[0].lng, edge[1].lng) + dLng, Math.max(edge[0].lat, edge[1].lat) + dLat
    ];
    try {
        const clipped = turf.bboxClip(land, box);
        const coordinates = clipped?.geometry?.coordinates;
        return Array.isArray(coordinates) && coordinates.length ? clipped : null;
    } catch (_) {
        return null;
    }
}

// Get ownership type from parcel's feature properties
function getOwnershipTypeFromParcel(parcel) {
    return window.RoadOwnershipModel.classifyParcel(getRoadDrawingParcelProperties(parcel),
        typeof getOwnershipType === 'function' ? getOwnershipType : undefined).category;
}

// Locked parcels and their stats are derived state: they are exactly "the parcels the corridor covers".
// Recomputing them from the corridor polygon keeps them correct no matter what order the vertices were
// drawn in — which the per-edge undo history could not, once a segment can be resumed, reversed, or
// seeded from an existing road. One polygon-vs-parcels pass, the same work a single click already does.
function recomputeLockedParcelsFromPolygon(polygon) {
    clearAffectedParcels();
    lockedParcelIds.clear();
    roadOpenGroundCrossed.locked.clear();
    lockedStats = {
        parcelCount: 0,
        totalArea: 0,
        ownershipCounts: { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 },
        marketPrice: 0,
        individualOwners: 0
    };
    if (Array.isArray(polygon) && polygon.length >= 3) {
        lockParcelsFromSegment(polygon);
    }
}

// Lock parcels from a segment - adds them to the locked set and updates cached stats
function lockParcelsFromSegment(segmentPolygon) {
    const newParcels = findNewAffectedParcelsForSegment(segmentPolygon);

    // Add new parcels to the locked set and the affected parcels array. Undo does not unwind these
    // one edge at a time: it re-derives the whole set (recomputeLockedParcelsFromPolygon).
    for (const parcel of newParcels) {
        if (!lockedParcelIds.has(parcel.id)) {
            lockedParcelIds.add(parcel.id);
            roadAffectedParcels.push(parcel);

            // Update cached stats incrementally
            lockedStats.parcelCount++;
            lockedStats.totalArea += (Number(parcel.area) || 0);

        }
    }
    const stats = roadAcquisitionModel(roadAffectedParcels);
    lockedStats.ownershipCounts = stats.ownershipCounts;
    lockedStats.marketPrice = stats.totalMarketPrice;
    lockedStats.individualOwners = stats.ownerEntryCount;
    setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
    updateRoadOwnershipCounts(roadAffectedParcels);
    updateRoadMarketPrice(roadAffectedParcels);
    updateRoadAcquiringDifficulty(roadAffectedParcels);
}

// The city's currency (city-money.js), EUR when it declares none.
function roadDrawingCurrencyCode() {
    return window.CityMoney.currentCurrency();
}

// Helper to format currency: amount then code ("431,000 EUR"), in whole units, because
// collectOwnershipAndAcquisitionStats reads the total back by stripping every non-digit.
function formatCurrency(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    return CbFormat.formatMoney(value, roadDrawingCurrencyCode(), { maxFractionDigits: 0 });
}

// Find parcels affected by the road.
function findAffectedParcels(roadPolygon) {
    if (!roadPolygon || !getRoadDrawingFabric()) return;

    // Define the green highlight style for committed road parcels
    const committedRoadStyle = {
        fillColor: 'green',
        fillOpacity: 0.6,
        color: 'green',
        weight: 3
    };

    // Use the shared fabric query to find and highlight affected parcels.
    roadOpenGroundCrossed.locked.clear();
    roadAffectedParcels = findAndHighlightAffectedParcels(
        roadPolygon,
        roadAffectedParcels,
        committedRoadStyle,
        null,
        { groundInto: roadOpenGroundCrossed.locked }
    );

    // Rebuild locked state from roadAffectedParcels
    lockedParcelIds.clear();
    roadAffectedParcels.forEach(p => lockedParcelIds.add(p.id));

    // Always update UI with the parcels count/area
    const totalArea = roadAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
    lockedStats.parcelCount = roadAffectedParcels.length;
    lockedStats.totalArea = totalArea;

    if (roadAffectedParcels.length > 0) {
        setRoadParcelStats(roadAffectedParcels.length, formatParcelArea(totalArea));
    } else {
        setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
    }
    try {
        updateRoadOwnershipCounts(roadAffectedParcels);
        updateRoadMarketPrice(roadAffectedParcels);
    } catch (err) {
        console.warn('road ownership: failed to update stats', err);
    }
}

// Update the corridor info panel with current metrics.
// Collapse the drawing panel to a slim strip (title + Cross-section + Undo/Finish) so the map
// stays visible while drawing — essential on phones, where the full panel covers half the screen.
function toggleRoadInfoPanelMinimized() {
    const panel = document.getElementById('road-info-panel');
    if (!panel) return;
    const minimized = panel.classList.toggle('is-minimized');
    const btn = document.getElementById('road-panel-minimize');
    if (btn) {
        const label = minimized
            ? translateRoadText('sidebar.areaMonitor.expand', 'Expand')
            : translateRoadText('sidebar.areaMonitor.minimize', 'Minimize');
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        btn.setAttribute('aria-expanded', minimized ? 'false' : 'true');
        btn.innerHTML = minimized ? '+' : '&#8722;';
    }
}
if (typeof window !== 'undefined') {
    window.toggleRoadInfoPanelMinimized = toggleRoadInfoPanelMinimized;
}

function updateRoadInfoPanel() {
    const hasRoadSegments = getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length > 0);
    if (!hasRoadSegments) return;

    // Make sure the corridor info panel exists
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (!roadInfoPanel) {
        console.error('Road info panel element not found');
        return; // Exit early if the panel doesn't exist
    }
    if (!roadInfoPanel.classList.contains('visible')) {
        roadInfoPanel.style.removeProperty('display');
        roadInfoPanel.classList.add('visible');
    }

    const roadSegmentsForMetrics = getAllRoadSegments(true);
    const hasUsableSegments = roadSegmentsForMetrics.some(seg => Array.isArray(seg) && seg.length >= 2);
    if (hasUsableSegments) {
        // PERFORMANCE: Use cached polygon and calculate only length/area
        // Avoid expensive full union recalculation - we already maintain cachedCommittedPolygon incrementally
        const length = roadSegmentsForMetrics.reduce((sum, seg) => sum + calculateSegmentLengthMeters(seg), 0);
        const area = cachedCommittedPolygon ? calculatePolygonAreaMeters(cachedCommittedPolygon) : 0;

        committedRoadMetrics.length = length;
        committedRoadMetrics.area = area;

        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');
        if (roadLengthElement) {
            roadLengthElement.textContent = CbFormat.formatLength(length);
        }
        if (roadAreaElement) {
            roadAreaElement.textContent = CbFormat.formatArea(area);
        }

        // Use cached polygon instead of recalculating
        if (cachedCommittedPolygon) {
            roadPolygon = cachedCommittedPolygon;
            if (roadPolygonLayer) {
                roadPolygonLayer.setLatLngs(cachedCommittedPolygon);
            } else {
                roadPolygonLayer = L.polygon(cachedCommittedPolygon, {
                    color: 'green',
                    weight: 2,
                    fillColor: 'green',
                    fillOpacity: 0.3
                }).addTo(map);
            }
        }

        setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
        updateRoadOwnershipCounts(roadAffectedParcels);
        updateRoadMarketPrice(roadAffectedParcels);
        updateRoadAcquiringDifficulty(roadAffectedParcels);
    } else {
        resetRoadMetricPlaceholders();
        committedRoadMetrics.length = 0;
        committedRoadMetrics.area = 0;
    }
}

// PERFORMANCE: Fast update of road info during preview
// Only calculates preview segment metrics and adds to cached committed values
// This avoids recalculating the entire road polygon on every mouse move
function updatePreviewRoadInfo(previewSegmentPoints, previewSegmentPolygon) {
    try {
        // Calculate preview segment length
        let previewLength = 0;
        if (previewSegmentPoints && previewSegmentPoints.length >= 2) {
            const p1 = previewSegmentPoints[0];
            const p2 = previewSegmentPoints[1];
            if (p1 && p2 && isFinite(p1.lat) && isFinite(p1.lng) && isFinite(p2.lat) && isFinite(p2.lng)) {
                previewLength = polylineLengthMeters([p1, p2]);
            }
        }

        // Calculate preview segment area
        let previewArea = 0;
        try {
            const turfPoly = polygonLatLngsToTurfFeature(previewSegmentPolygon);
            if (turfPoly && typeof turf !== 'undefined' && turf && typeof turf.area === 'function') {
                previewArea = turf.area(turfPoly) || 0;
            }
        } catch (_) {
            // Ignore area calculation errors during preview
        }

        // Add preview segment metrics to cached committed metrics
        const totalLength = committedRoadMetrics.length + previewLength;
        const totalArea = committedRoadMetrics.area + previewArea;

        // Update UI elements directly (fast path)
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        if (roadLengthElement) {
            roadLengthElement.textContent = CbFormat.formatLength(totalLength);
        }
        if (roadAreaElement) {
            roadAreaElement.textContent = CbFormat.formatArea(totalArea);
        }
    } catch (error) {
        // Silently ignore errors during preview - non-critical
    }
}

// The panel's three buttons. One corridor tool, so there is nothing to dispatch on: a track finishes,
// undoes and closes through the same functions a road does. Finishing IS the creation: the drawing
// instantly becomes an applied object (SimCity lifecycle). Like the keys, the buttons wait for a
// click that is still being placed rather than racing it.
function finishRoadOrTrackDrawing() {
    if (roadDrawingMode) afterRoadPlacement(() => finishRoadDrawing());
}

function undoLastRoadOrTrackSegment() {
    if (roadDrawingMode) afterRoadPlacement(() => undoLastRoadSegment());
}

async function cancelRoadOrTrackDrawing() {
    if (roadDrawingMode) return cancelRoadDrawing();
    return false;
}

// F is an idempotent "pen up" action. The gate is acquired before any asynchronous work begins, so
// key repeat, a double-click on the map or on Finish, and the close prompt all share one
// finalization run.
//
// Finishing first reviews the obstacles recorded while drawing — one pass of dialogs for the whole
// drawing (reviewRoadConflictsAtFinish) — and only then builds. The review comes before the busy
// indicator: a "Building the road…" status and a busy pointer under a question would say the road
// was already being built. Building runs graph normalization, one cached-ground lookup and a local
// fabric derivation between the answer and the finished object — and it used to happen with no sign
// at all that anything was under way. The same ref-counted spinner an applied-corridor edit uses
// covers the whole build, and the pointer goes busy with it.
function finishRoadDrawing() {
    // Nothing drawable, nothing to finish. The check belongs here rather than at each call site: the
    // F key and Escape tested it, the Finish (F) button did not, so pressing that button on an empty
    // drawing entered finalization and left again — silently before, and with a spinner flash once
    // one existed, which reads as the tool trying to build a road that was never drawn.
    if (!hasDrawableCorridor()) return Promise.resolve(false);
    return roadFinalizationGate.run(async () => {
        if (!(await reviewRoadConflictsAtFinish())) return false;
        beginApplyIndicator(corridorFinalizationLabel());
        corridorFinishProfile = { started: nowMs(), phases: [] };
        try {
            // Finish itself spins for the build too (not during the review: that is a question).
            return await window.BusyControl.track(document.getElementById('finishRoadButton'), async () => {
                // One yield so the indicator is painted BEFORE the synchronous geometry work, which
                // holds the main thread and would otherwise keep it from ever appearing.
                await new Promise(resolve => setTimeout(resolve, 0));
                const drawing = roadSegments;
                const restoreDrawing = snapshotRoadDrawingGeometry();
                try {
                    return await finishRoadDrawingOnce();
                } catch (error) {
                    // Once the drawing has been handed to proposal creation (the session was reset, and
                    // perhaps reopened on the draft), that path owns the failure.
                    if (!roadDrawingMode || roadSegments !== drawing) throw error;
                    restoreDrawing();
                    resumeRoadDrawingAfterFailedFinish(error);
                    return false;
                }
            });
        } finally {
            endApplyIndicator();
            reportCorridorFinishProfile();
        }
    });
}

// Finish rewrites the drawing's segment arrays and their points in place (graph normalization) before
// it builds the land, and building can throw (a union that fails, a footprint outside the metric
// frame). The drawing is snapshotted first so a failed Finish hands it back exactly as it was drawn.
function snapshotRoadDrawingGeometry() {
    const arrays = roadSegments.map(segment => (Array.isArray(segment) ? segment.slice() : null));
    const coordinates = arrays.map(segment => (segment ? segment.map(point => [point.lat, point.lng]) : null));
    const profiles = JSON.parse(JSON.stringify(roadSegmentProfiles));
    return () => {
        roadSegments.forEach((segment, index) => {
            if (!Array.isArray(segment) || !arrays[index]) return;
            segment.splice(0, segment.length, ...arrays[index]);
            segment.forEach((point, pointIndex) => {
                point.lat = coordinates[index][pointIndex][0];
                point.lng = coordinates[index][pointIndex][1];
            });
        });
        roadSegmentProfiles = profiles;
    };
}

// A Finish that threw before the drawing was handed off: the tool stays open and listening, and says why.
function resumeRoadDrawingAfterFailedFinish(error) {
    console.error(`[${new Date().toISOString()}] [road-drawing] Finish failed; the drawing stays open`, error);
    // Detach first so a Finish that failed before suspending never leaves the handlers attached twice.
    suspendRoadDrawingInteractivity();
    attachRoadDrawingInteractivity();
    try {
        recomputeLockedParcelsFromPolygon(rebuildRoadGeometryFromSegments());
        redrawRoadVertexMarkers();
        refreshRoadBuildingTunnelLayer();
        refreshRoadGradeSeparationLayer();
    } catch (redrawError) {
        console.error(`[${new Date().toISOString()}] [road-drawing] could not redraw the drawing after a failed Finish`, redrawError);
    }
    updateRoadInfoPanel();
    updateUndoButtonState();
    const reason = (error && error.message) ? error.message : String(error);
    const message = translateRoadText('panel.road.finishFailed',
        'Could not build this road ({{reason}}). The drawing is still open: change it and finish again.', { reason });
    updateStatus(message);
    showRoadAlert('road_finish_failed', message);
}

// Where the seconds between F and a finished road go. Kept in the code rather than reached for with
// a profiler after the fact: the transaction reports topology, record and local-fabric time, while
// this outer profile separates those from the geometry and draft work in front of it.
const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
let corridorFinishProfile = null;

function markCorridorFinishPhase(name) {
    if (!corridorFinishProfile) return;
    const at = nowMs();
    const previous = corridorFinishProfile.phases.length
        ? corridorFinishProfile.phases[corridorFinishProfile.phases.length - 1].at
        : corridorFinishProfile.started;
    corridorFinishProfile.phases.push({ name, at, ms: at - previous });
}

function reportCorridorFinishProfile() {
    const profile = corridorFinishProfile;
    corridorFinishProfile = null;
    if (!profile || !profile.phases.length) return;
    try {
        const total = nowMs() - profile.started;
        const parts = profile.phases.map(phase => `${phase.name} ${Math.round(phase.ms)}`).join(' · ');
        console.info(`[finishRoad] ${Math.round(total)} ms — ${parts}`);
    } catch (_) { }
}

// Is there anything a corridor could be built from? A stroke of one click is not a line, so it does
// not count — the same test the F key, Escape and the Finish button all have to agree on.
function hasDrawableCorridor() {
    return getAllRoadSegments(true).some(segment => Array.isArray(segment) && segment.length >= 2);
}

// What the drawing is called while it is being built — the lanes decide, exactly as they do for the
// finished object.
function corridorFinalizationLabel() {
    const isTrack = (typeof corridorDrawingIsTrack === 'function') ? corridorDrawingIsTrack() : false;
    return translateRoadText(
        isTrack ? 'panel.road.buildingTrack' : 'panel.road.buildingRoad',
        isTrack ? 'Building the track…' : 'Building the road…'
    );
}

// The drawn corridor is DETACHED, not deleted: tearing the drawing down before the object exists
// left the map blank for the whole replay, so the very layers the user drew stay exactly where they
// are — hidden from resetRoadDrawing by nulling the references it would remove them through — until
// the finished object is on the map to replace them.
function detachDrawnCorridorAsGhost() {
    const held = [roadPolygonLayer, roadStripLayer].filter(Boolean);
    roadPolygonLayer = null;
    roadStripLayer = null;
    return corridorGhostDisposer(map, held);
}

// Removes the held layers once, whichever way finalization ends.
function corridorGhostDisposer(mapRef, layers) {
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        (Array.isArray(layers) ? layers : []).forEach(layer => {
            try { if (mapRef && layer && mapRef.hasLayer(layer)) mapRef.removeLayer(layer); } catch (_) { }
        });
    };
}

// Rails that share a street with traffic lanes take the street's curves: a tram turns across the
// lanes, which is not modelled, so its place in the cross-section simply follows the street. Only
// rails without traffic lanes beside them are held to the radius target.
function corridorProfileHoldsRadiusTarget(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return false;
    return normalized.strips.some(strip => strip.type === 'rail')
        && !normalized.strips.some(strip => strip.type === 'driving' || strip.type === 'bus');
}

async function reviewTrackCurvatureAtFinish(segments, segmentIds) {
    // No target was picked (a road session) or carried in (a seeded corridor): nothing to review against.
    if (!trackMinCurvatureRadius) return true;
    const trackSegments = segments.filter((_segment, index) => {
        const id = segmentIds[index];
        return corridorProfileHoldsRadiusTarget(roadSegmentProfiles[String(id)] || roadProfile);
    });
    if (!trackSegments.length) return true;
    const bends = window.CorridorGeometry.measureCorridorCurvature(trackSegments, trackMinCurvatureRadius);
    if (!bends.length) return true;
    const tightest = Math.min(...bends.map(bend => bend.radiusM));
    return window.CbDialog.confirm(translateRoadText(
        'modal.track.curvature.warning',
        'This track has {{count}} bends with an estimated polyline radius below your {{minimum}} m target for {{speed}} km/h. The tightest is about {{actual}} m. This is a drawing check, not an engineering assessment. Continue with this geometry or keep editing?',
        {
            count: CbFormat.formatNumber(bends.length),
            minimum: CbFormat.formatNumber(trackMinCurvatureRadius),
            speed: CbFormat.formatNumber(trackSpeed),
            actual: CbFormat.formatNumber(tightest, { maxFractionDigits: 0 })
        }
    ), {
        title: translateRoadText('modal.track.curvature.title', 'Track radius target'),
        okText: translateRoadText('modal.track.curvature.continue', 'Continue'),
        cancelText: translateRoadText('modal.track.curvature.keepEditing', 'Keep editing')
    });
}

async function finishRoadDrawingOnce() {
    if (roadSegmentPlacementInProgress) {
        updateStatus('Wait for the current segment to finish validating.');
        return false;
    }
    if (roadDrawingProfileValidationPending) {
        updateStatus('Apply or cancel the cross-section change before finishing the road.');
        return false;
    }

    // Keep each segment paired with its id while dropping the ones too short to be a line.
    const allSegments = getAllRoadSegments(true);
    const drawnSegments = allSegments
        .map((segment, index) => ({ segment, id: roadSegmentIds[index] || null }))
        .filter(entry => Array.isArray(entry.segment) && entry.segment.length >= 2);
    const segments = drawnSegments.map(entry => entry.segment);
    const segmentIds = drawnSegments.map(entry => entry.id);
    if (!segments.length) return;
    if (!(await reviewTrackCurvatureAtFinish(segments, segmentIds))) return false;

    // No collision detection or choice dialog belongs here. Each edge recorded what it ran into when
    // it was placed, finishRoadDrawing reviewed all of it just before this (and inserted any tunnel
    // portals and ramp ends), and a later width/geometry edit owns its own check before changing the
    // map. Every genuine crossing becomes a shared graph node here. This includes two edges of the SAME
    // stroke: a closed star must be stored as simple stretches meeting at junctions, never as one
    // self-crossing strip. Near-miss snapping remains edit-only; tunnelled edges stay protected.
    normalizeCorridorGraph(
        segments,
        segmentIds,
        corridorProtectedEdgeKeySet(roadBuildingTunnels, roadGradeSeparations),
        roadSegmentProfiles
    );
    markCorridorFinishPhase('graph');

    // Immediately stop interactions and preview while finishing
    suspendRoadDrawingInteractivity();
    stopRoadPreviewTracking();

    let finalRoadPolygon = buildRoadUnionPolygonWithWidths(
        segments,
        segments.map((_, index) => {
            const id = segmentIds[index];
            const override = (id !== undefined && id !== null) ? roadSegmentProfiles[String(id)] : null;
            const width = override && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(override) : 0;
            return width > 0 ? width : roadWidth;
        }),
        roadWidth,
        segmentIds,
        // The stored land is built in the final centre line's canonical frame — the frame the
        // server materialises it in — not the session's, so preparing reproduces it exactly.
        metricFrameModule().frameFor(segments.flat())
    );
    if (!finalRoadPolygon) {
        showRoadAlert('invalid_road_shape_please_try_drawing_the_road_again', 'Invalid road shape. Please try drawing the road again.');
        exitRoadDrawingMode();
        return;
    }

    // The shared construction unions every piece (a crossing is part of the land, never an even-odd
    // hole) and splits every edge into pieces of at most 50 m. Nothing may "clean" it afterwards:
    // turf.cleanCoords drops those collinear vertices and lets long edges bow again in lon/lat
    // (projections.md §3).
    markCorridorFinishPhase('corridor');

    // Update the displayed polygon and recompute affected parcels based on the final geometry.
    // This avoids missing parcels that might fall entirely inside a (previously) hollow crossing region.
    try {
        if (finalRoadPolygon && roadPolygonLayer && typeof roadPolygonLayer.setLatLngs === 'function') {
            roadPolygonLayer.setLatLngs(finalRoadPolygon);
        }
    } catch (_) { /* ignore */ }
    try {
        if (finalRoadPolygon) {
            roadPolygon = finalRoadPolygon; // update the global geometry reference
            findAffectedParcels(finalRoadPolygon);
        }
    } catch (_) { /* ignore */ }

    markCorridorFinishPhase('parcels');

    // A corridor is a material proposal: one drawn across ground without parcels (unsurveyed
    // land, an explore city) has an empty binding and is still a proposal (PARCEL-OPTIONAL.md).
    const affectedParcels = roadAffectedParcels;
    if (affectedParcels.length === 0) {
        console.info(`[${new Date().toISOString()}] [road-drawing] the corridor crosses no loaded parcel; it is created with an empty binding`);
    }

    // What was drawn is a track iff its cross-section carries rails — a "road" the user gave a tram
    // lane is a track, and a "track" whose rails were all removed is a road. The lanes decide, not the
    // button that opened the tool.
    const isTrack = corridorDrawingIsTrack();
    const corridorKind = isTrack ? 'track' : 'road';

    const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

    const selectedParcelIds = affectedParcels
        .map(p => getParcelIdFromAny(p))
        .filter(Boolean)
        .map(id => id.toString());

    // Keep the ids paired with the geometry through the coordinate cleaning, so a road reopened later
    // continues its segments under the same ids rather than as anonymous new ones.
    const centerlineWithIds = segments
        .map((segment, index) => ({
            points: segment.map(pt => {
                const lat = Number(pt?.lat ?? (Array.isArray(pt) ? pt[1] : null));
                const lng = Number(pt?.lng ?? (Array.isArray(pt) ? pt[0] : null));
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return { lat, lng };
            }).filter(Boolean),
            id: segmentIds[index] || null
        }))
        .filter(entry => entry.points.length >= 2);

    const centerlineSegments = centerlineWithIds.map(entry => entry.points);
    const centerlineSegmentIds = centerlineWithIds.map(entry => entry.id);

    const latLngPairs = convertRoadPolygonToLatLngPairs(finalRoadPolygon);
    const geoPolygon = convertLatLngPairsToGeoJSON(latLngPairs);

    // Log polygon creation for debugging
    if (!geoPolygon || !geoPolygon.type || !Array.isArray(geoPolygon.coordinates)) {
        console.error('[finishRoadDrawing] Failed to create GeoJSON polygon from road geometry:', {
            hasFinalRoadPolygon: !!finalRoadPolygon,
            finalRoadPolygonLength: Array.isArray(finalRoadPolygon) ? finalRoadPolygon.length : 'not array',
            hasLatLngPairs: !!latLngPairs,
            latLngPairsLength: Array.isArray(latLngPairs) ? latLngPairs.length : 'not array',
            geoPolygon
        });
    } else if (window?.__DEBUG_ROAD_DRAWING__) {
        console.debug('[finishRoadDrawing] Created GeoJSON polygon', {
            type: geoPolygon.type,
            coordsLength: geoPolygon.coordinates?.[0]?.length || 0
        });
    }

    const roadDrawingContext = {
        parcelIds: selectedParcelIds.slice(),
        centerline: centerlineSegments,
        segmentIds: centerlineSegmentIds,
        profile: roadProfile ? { strips: roadProfile.strips.map(strip => ({ ...strip })) } : null,
        drivingSide: roadDrivingSide,
        polygon: geoPolygon,
        polygonOrder: 'lnglat', // Explicit: geoPolygon is GeoJSON format [lng, lat]
        latLngPairs,
        width: roadWidth,
        sidewalkWidth: roadSidewalkWidth,
        tunnels: JSON.parse(JSON.stringify(roadBuildingTunnels || [])),
        gradeSeparations: JSON.parse(JSON.stringify(roadGradeSeparations || [])),
        segmentProfiles: (() => {
            const trimmed = {};
            centerlineSegmentIds.forEach(id => {
                if (id !== null && id !== undefined && roadSegmentProfiles[String(id)]) {
                    trimmed[String(id)] = JSON.parse(JSON.stringify(roadSegmentProfiles[String(id)]));
                }
            });
            return trimmed;
        })(),
        // The existing streets this corridor joins ({ lat, lng, wayId, name }). They are not records,
        // so Finish nodes nothing into them; the definition remembers the connection instead.
        connections: liveRoadStreetConnections(roadStreetConnections, centerlineSegments),
        stats: ownershipAndAcquisitionStats,
        metadata: {
            mode: 'draw',
            type: corridorKind,
            // Written, not read: `isTrack` is DERIVED from the profile everywhere the app asks the
            // question (corridorIsTrack), but proposal creation, parcel styling and the draft store
            // still key on the stored flag, and corridors saved before rail lanes existed have only
            // this flag to say what they are. So it is recorded, and it always agrees with the lanes.
            isTrack,
            isRoad: !isTrack,
            isCorridor: true,
            source: 'road-drawing',
            // Selected track design targets; not an operating-speed certification.
            ...(isTrack && trackMinCurvatureRadius ? { trackSpeed, trackMinRadius: trackMinCurvatureRadius } : {})
        }
    };

    if (typeof pendingRoadDrawingProposal !== 'undefined') {
        pendingRoadDrawingProposal = roadDrawingContext;
    }
    if (typeof window !== 'undefined') {
        window.pendingRoadDrawingProposal = roadDrawingContext;
    }

    // SimCity lifecycle: finishing the drawing IS the creation. The draft becomes an applied
    // object immediately (auto-named, overlaps auto-parked); click the object to edit it or add
    // proposal terms later. Drafts are created lazily on autosave — force one now if missing.
    if (!window.activeProposalDesignDraftId) saveCurrentCorridorDrawingDraft(corridorKind);
    const designDraftId = window.activeProposalDesignDraftId;
    if (designDraftId && window.proposalDraftStore?.getDraft?.(designDraftId)) {
        // saveCurrentCorridorDrawingDraft copied this into the draft; the live drawing session no
        // longer owns the source pointer once its final snapshot exists.
        window.pendingRoadCopySource = null;
        window.syncActiveProposalDraftFromEditor?.('corridor', {
            ...roadDrawingContext,
            kind: corridorKind
        }, { parcelIds: selectedParcelIds, coalesceKey: 'corridor-finalize' });
        writeStreetConnectionsToDraft(designDraftId, roadDrawingContext.connections, centerlineSegments);
        // Hold the drawing on the map across teardown and local fabric derivation; the object that replaces
        // it only exists once instantCreateProposalFromDraft resolves.
        markCorridorFinishPhase('draft');
        const dismissGhost = detachDrawnCorridorAsGhost();
        exitRoadDrawingMode();
        try {
            // One drawing session, one new proposal; proposal identity and terms remain separate.
            // Finish nevertheless owns the WHOLE junction mutation: it inserts the shared node into
            // every touched existing road and commits those edits atomically with this new record.
            const createdId = await window.instantCreateProposalFromDraft?.(designDraftId, {
                atomicCorridorAuthoring: true
            });
            markCorridorFinishPhase('atomic-create');
            if (createdId && typeof updateStatus === 'function') {
                const builtKey = isTrack ? 'panel.road.builtStatusTrack' : 'panel.road.builtStatus';
                const builtFallback = isTrack ? 'Local track draft created — only on this device until you share it. Click it to edit or propose.' : 'Local road draft created — only on this device until you share it. Click it to edit or propose.';
                updateStatus(translateRoadText(builtKey, builtFallback));
            }
        } finally {
            // A failure reopens the drawing tool, which draws its own layers — the ghost goes either way.
            dismissGhost();
        }
        return;
    }

    // There is deliberately no second, non-atomic creation path. If the draft hand-off is
    // unavailable, keep the drawing live; opening the old dialog would store one record first and
    // leave the other half of every junction for a later repair pass.
    const draftError = 'Could not prepare the corridor transaction. The drawing is still open.';
    if (typeof showRoadAlert === 'function') showRoadAlert('corridor_transaction_unavailable', draftError);
    if (typeof updateStatus === 'function') updateStatus(draftError);
    return false;
}

// Closing the drawing tool — the X button, or R again. Anything drawable is ASKED about; an empty
// drawing just closes. Returns true when the tool is now closed, false when the user chose to keep
// drawing, so a caller cannot go on to open another tool over a session that is still live.
//
// The order here is the whole fix. This used to cancel the active stroke FIRST and only then ask
// whether there was anything to finish — and a stroke stays "started" until Escape or F, so for a
// road drawn in one continuous run of clicks the cancel took all of it, `hasDrawableCorridor()` then
// answered no, and the tool closed having silently destroyed the road. The question has to be asked
// while the drawing still exists. Nothing drawable (at most one lone click) just closes:
// exitRoadDrawingMode resets every piece of drawing state, a half-placed stroke included.
async function cancelRoadDrawing() {
    if (hasDrawableCorridor()) {
        return (await promptCloseDrawnCorridor()) !== 'keep';
    }
    exitRoadDrawingMode();
    return true;
}

// Reset road drawing variables and state
function resetRoadDrawing(hidePanel = true) {
    roadSegments = [];
    roadSegmentIds = [];
    roadPoints = [];
    roadBuildingTunnels = [];
    roadGradeSeparations = [];
    roadSurfaceBuildingIds = new Set();
    roadSegmentProfiles = {};
    roadMirroredSegmentIds = new Set();
    trackSpeed = null;
    trackMinCurvatureRadius = null;
    roadEdgeConflicts = new Map();
    roadStreetConnections = [];
    roadProfile = null;
    roadLastValidatedWidth = roadWidth;
    roadDrawingProfileValidationPending = false;
    roadHasStarted = false;
    clearRoadSnapMarker();
    clearPendingRoadSegment();
    clearRoadStripLayer();
    redrawRoadConflictMarkers();
    if (roadGradeSeparationLayer && map.hasLayer(roadGradeSeparationLayer)) map.removeLayer(roadGradeSeparationLayer);
    roadGradeSeparationLayer = null;
    // Clear affected parcels highlighting BEFORE clearing the array
    clearAffectedParcels();
    roadOwnershipTypeCache.clear();
    roadOwnershipStatsRequestId++;

    // Reset cached committed road metrics
    committedRoadMetrics.length = 0;
    committedRoadMetrics.area = 0;

    // Reset cached committed road polygon and the session's frame
    cachedCommittedPolygon = null;
    roadDrawingFrame = null;

    // Clear any existing road layers
    if (roadCenterline) {
        map.removeLayer(roadCenterline);
        roadCenterline = null;
    }

    // Correctly remove the committed road preview layer (roadPolygonLayer)
    // The global 'roadPolygon' variable stores geometry, not the layer itself.
    if (roadPolygonLayer && map.hasLayer(roadPolygonLayer)) {
        map.removeLayer(roadPolygonLayer);
        roadPolygonLayer = null;
    }
    roadPolygon = null; // Also clear the geometry variable

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }

    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    // Remove any road markers
    for (const marker of roadMarkers) {
        if (marker && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    }
    roadMarkers = [];
    if (roadBuildingTunnelLayer && map.hasLayer(roadBuildingTunnelLayer)) {
        map.removeLayer(roadBuildingTunnelLayer);
    }
    roadBuildingTunnelLayer = null;

    // Hide road info panel if requested
    if (hidePanel) {
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) {
            roadInfoPanel.classList.remove('visible');
            roadInfoPanel.style.removeProperty('display');
        }
    }

    // Affected parcels highlighting already cleared at the start of this function
    resetRoadMetricPlaceholders();
}

// Add a helper function to clear affected parcels
function clearAffectedParcels() {
    if (roadAffectedParcels.length > 0) {
        roadAffectedParcels.forEach(parcel => {
            const parcelId = getParcelIdFromAny(parcel);
            const layer = getRoadDrawingPresenterLayer(parcelId);
            if (!parcelId || !layer || typeof layer.setStyle !== 'function') return;
            const isRoad = typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
            layer.setStyle(isRoad ? roadStyle : normalStyle);
        });
    }
    roadAffectedParcels = [];
    // Also reset locked state
    lockedParcelIds.clear();
    lockedStats = {
        parcelCount: 0,
        totalArea: 0,
        ownershipCounts: { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 },
        marketPrice: 0,
        individualOwners: 0
    };
}

// Helper function to clear highlighting for preview-affected parcels
function clearPreviewAffectedParcels() {
    roadOpenGroundCrossed.preview.clear();
    // Only iterate through the preview parcels list, not all parcels (performance)
    if (roadPreviewAffectedParcels.length > 0) {
        for (const previewParcel of roadPreviewAffectedParcels) {
            const layer = previewParcel.layer;
            const parcelId = previewParcel.id;
            if (!layer) continue;

            // Check if it's also part of the *locked* affected parcels
            if (lockedParcelIds.has(parcelId)) {
                // It's locked/committed, revert to committed style (green)
                layer.setStyle({
                    fillColor: 'green',
                    fillOpacity: 0.6,
                    color: 'green',
                    weight: 3
                });
            } else {
                // Not committed, revert to its base style
                const isMarkedAsRoad = typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
                layer.setStyle(isMarkedAsRoad ? roadStyle : normalStyle);
            }
        }
    }
    roadPreviewAffectedParcels = []; // Clear the preview list
}

// Find parcels affected by the PREVIEW SEGMENT ONLY (not the entire road)
// Uses cached locked stats + adds preview-only parcels for combined display
// PERFORMANCE: Uses mapBounds filter and avoids expensive async calls
function findPreviewAffectedParcels(previewPolygon) {
    if (!previewPolygon || !getRoadDrawingFabric()) return;

    // Clear previous preview highlights (reverts to locked style or base style)
    clearPreviewAffectedParcels();

    // Create a turf polygon from the preview polygon
    const latLngs = previewPolygon.map(p => [p.lng, p.lat]);

    if (latLngs.length < 4) {
        // Not enough points, just show locked stats
        return;
    }

    // Ensure the polygon is closed
    const closedLatLngs = ensurePolygonIsClosed(latLngs);
    if (closedLatLngs.length !== latLngs.length) {
        latLngs.length = 0;
        latLngs.push(...closedLatLngs);
    }

    let turfPolygon;
    try {
        turfPolygon = turf.polygon([latLngs]);
    } catch (error) {
        return;
    }

    if (!turfPolygon) {
        return;
    }

    const newPreviewParcels = [];

    roadOpenGroundCrossed.preview.clear();
    liveRoadDrawingParcelsIntersecting(turfPolygon, { groundInto: roadOpenGroundCrossed.preview }).forEach(feature => {
        const entry = roadDrawingParcelEntry(feature);
        if (!entry || lockedParcelIds.has(entry.id)) return;
        newPreviewParcels.push(entry);
        if (entry.layer && typeof entry.layer.setStyle === 'function') entry.layer.setStyle(previewAffectedStyle);
        if (entry.layer && typeof entry.layer.bringToFront === 'function') entry.layer.bringToFront();
    });

    roadPreviewAffectedParcels = newPreviewParcels;

    // Calculate combined stats: locked stats + preview-only parcels
    const previewArea = newPreviewParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
    const combinedCount = lockedStats.parcelCount + newPreviewParcels.length;
    const combinedArea = lockedStats.totalArea + previewArea;

    setRoadParcelStats(combinedCount, combinedCount > 0
        ? formatParcelArea(combinedArea) : translateRoadText('panel.road.parcelsNone', 'None'));
    const combinedParcels = [...roadAffectedParcels, ...newPreviewParcels];
    updateRoadOwnershipCounts(combinedParcels);
    updateRoadMarketPrice(combinedParcels);
    updateRoadAcquiringDifficulty(combinedParcels);
}

// ============================================================================
// RAIL
//
// What is left of the old, separate track tool: the things that are true of RAILS and of nothing else.
// A train cannot take a corner as tight as a car can, so a corridor of rails is drawn under a minimum
// curve radius, fixed by the speed the line is designed for; rails in a street follow the street's
// curves instead (corridorProfileHoldsRadiusTarget). Everything else about a
// track — its geometry, its cross-section, its footprint, how it is drawn and rendered — is the same
// code that draws a road, above.
// ============================================================================

// Selected design speed and radius target; Finish warns about tighter drawn bends. Null until the
// Track button's speed picker sets them or a seeded corridor carries them in; reset with the session.
let trackSpeed = null;
let trackMinCurvatureRadius = null;

function trackTargetOf(value) {
    return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : null;
}
let trackSegmentSound = null; // Loaded lazily on first use
let trackSegmentSoundStopTimer = null;


// Play the track placement sound; initialized lazily on first call
function playTrackSegmentSound() {
    try {
        if (!trackSegmentSound) {
            trackSegmentSound = new Audio('sounds/place_track.mp3');
            trackSegmentSound.preload = 'auto';
        }

        // Reset any pending stop timers
        if (trackSegmentSoundStopTimer) {
            clearTimeout(trackSegmentSoundStopTimer);
            trackSegmentSoundStopTimer = null;
        }

        // Restart and play
        trackSegmentSound.currentTime = 0;
        const playPromise = trackSegmentSound.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => { /* ignore autoplay/gesture blocks */ });
        }

        // Stop halfway (fallback to 350ms if duration unknown)
        const duration = Number(trackSegmentSound.duration);
        const cutoffMs = Number.isFinite(duration) && duration > 0 ? (duration * 400) : 350;
        trackSegmentSoundStopTimer = setTimeout(() => {
            try {
                trackSegmentSound.pause();
                trackSegmentSound.currentTime = 0;
            } catch (_) { /* ignore audio errors */ }
        }, cutoffMs);
    } catch (_) { /* ignore audio errors */ }
}


// Track Speed Picker modal implementation.
//
// Speed only: the track's WIDTH is no longer picked here. A track's width is the sum of its lanes, and a
// new track starts as one standard-gauge track (3.5 m) that the cross-section editor then shapes — the
// same move the road tool made when its width picker became a cross-section.
//
// #track-speed-modal is the shared dialog's overlay (index.html), shown through [hidden]. The speeds
// are cb-option rows (the last one used is aria-pressed and focused); picking one starts drawing at
// once, Start drawing (or Enter) takes the pressed one, Cancel / × / Escape reject. Every handler is
// let go of when the promise settles, so a second open does not answer for the first.
function showTrackSpeedPicker() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('track-speed-modal');
        const grid = document.getElementById('track-speed-grid');
        const btnConfirm = document.getElementById('track-speed-confirm-btn');
        const btnCancel = document.getElementById('track-speed-cancel-btn');
        if (!modal || !grid || !btnConfirm || !btnCancel) {
            console.warn('Track speed modal elements missing');
            resolve({ speed: 50, minRadius: 300 }); // fallback to default values
            return;
        }
        const btnClose = modal.querySelector('[data-track-speed-close]');

        // Options: speed (km/h) -> min radius (m)
        const options = [
            { id: 'trackspeed1', speed: 50, label: '50 km/h', minRadius: 300 },
            { id: 'trackspeed2', speed: 80, label: '80 km/h', minRadius: 500 },
            { id: 'trackspeed3', speed: 120, label: '120 km/h', minRadius: 1000 },
            { id: 'trackspeed4', speed: 160, label: '160 km/h', minRadius: 2000 },
            { id: 'trackspeed5', speed: 200, label: '200 km/h', minRadius: 3500 },
            { id: 'trackspeed6', speed: 250, label: '250 km/h', minRadius: 5000 },
        ];

        // Prefill the list; a stored id that is no longer an option falls back to the first speed.
        grid.innerHTML = '';
        const storedId = PersistentStorage.getItem('lastTrackSpeedId');
        const selectedId = options.some(opt => opt.id === storedId) ? storedId : options[0].id;

        let settled = false;
        const handleKeydown = (ev) => {
            // Enter on a focused button is that button's own click (a speed picks itself, Cancel
            // cancels); anywhere else in the dialog it takes the pressed speed.
            if (ev.key !== 'Enter' || ev.target.matches('input, textarea, select, button')) return;
            ev.preventDefault();
            confirmSelection();
        };
        const finish = () => {
            settled = true;
            modal.hidden = true;
            modal.__unregisterEscape?.();
            modal.__unregisterEscape = null;
            modal.removeEventListener('keydown', handleKeydown);
            btnConfirm.onclick = null;
            btnCancel.onclick = null;
            if (btnClose) btnClose.onclick = null;
        };
        const confirmSelection = () => {
            if (settled) return;
            const selected = grid.querySelector('.track-speed-option[aria-pressed="true"]');
            const speed = parseFloat(selected.dataset.speed);
            const minRadius = parseFloat(selected.dataset.minRadius);
            PersistentStorage.setItem('lastTrackSpeedId', selected.dataset.id);
            finish();
            // Fold away an open sheet so the map has room
            if (window.MapShell) window.MapShell.closeSheets();
            resolve({ speed, minRadius });
        };
        const cancel = () => {
            if (settled) return;
            finish();
            reject(new Error('Cancelled'));
        };

        options.forEach(opt => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'cb-option track-speed-option';
            option.setAttribute('aria-pressed', opt.id === selectedId ? 'true' : 'false');
            option.dataset.id = opt.id;
            option.dataset.speed = String(opt.speed);
            option.dataset.minRadius = String(opt.minRadius);
            option.innerHTML = '<i class="cb-option__icon fa-solid fa-gauge-high" aria-hidden="true"></i>'
                + '<span class="cb-option__text"><span class="cb-option__title"></span><span class="cb-option__desc"></span></span>';
            option.querySelector('.cb-option__title').textContent = opt.label;
            option.querySelector('.cb-option__desc').textContent = translateRoadText(
                'modal.track.minRadius',
                'Minimum curvature radius {{radius}} m',
                { radius: CbFormat.formatNumber(opt.minRadius) }
            );
            option.addEventListener('click', () => {
                grid.querySelectorAll('.track-speed-option').forEach(el => el.setAttribute('aria-pressed', el === option ? 'true' : 'false'));
                // Confirm immediately on click
                confirmSelection();
            });
            grid.appendChild(option);
        });

        btnConfirm.onclick = confirmSelection;
        btnCancel.onclick = cancel;
        if (btnClose) btnClose.onclick = cancel;
        modal.addEventListener('keydown', handleKeydown);

        modal.hidden = false;
        modal.__unregisterEscape?.();
        modal.__unregisterEscape = window.ModalEscape?.register(modal, cancel);
        grid.querySelector('.track-speed-option[aria-pressed="true"]')?.focus();
    });
}

// Show dialog with acquiring difficulty explanation
function showAcquiringDifficultyDialog() {
    if (typeof document === 'undefined') return;

    const t = translateRoadText;
    const title = t('panel.road.acquiringDifficultyTitle', 'Modeled acquisition score');
    // The area-model sentence names the city's road-land rate; a city without one has none to name.
    const roadRate = window.CityMoney.currentLandPriceOptions('road');
    const explanation = t('panel.road.acquiringDifficultyTooltip', 'An illustrative score: each parcel value is multiplied by a category weight. It does not estimate legal rights, acquisition cost or consent.\nGovernment: 0\nInstitution: 0\nCompany: 1\nIndividual or mixed: 2\nMissing ownership categories, unusable prices or mixed currencies leave the score unknown.')
        + (typeof roadRate.areaPricePerSqm === 'number'
            ? '\n' + t('panel.road.acquiringDifficultyAreaModel', 'Area estimates use a {{rate}}/m² model.', { rate: CbFormat.formatMoney(roadRate.areaPricePerSqm, roadRate.currency) })
            : '');
    const closeLabel = t('modal.common.close', 'Close');
    const okLabel = t('panel.road.acquiringDifficultyDialogOk', 'OK');

    // Format explanation: split by newlines and format as paragraphs/list
    const parts = explanation.split('\n');
    const intro = parts[0] || '';
    const coefficients = parts.slice(1).filter(line => line.trim());

    let formattedExplanation = `<p>${intro}</p>`;
    if (coefficients.length > 0) {
        formattedExplanation += '<ul>';
        coefficients.forEach(coeff => {
            formattedExplanation += `<li>${coeff}</li>`;
        });
        formattedExplanation += '</ul>';
    }

    // The app's dialog (js/ui/dialogs.js): its header and close, Escape and the backdrop close it.
    window.CbDialog.open({
        title,
        size: 'sm',
        className: 'road-acquiring-difficulty-dialog',
        body: formattedExplanation,
        closeLabel,
        actions: [{ id: 'ok', label: okLabel, role: 'primary' }]
    });
}

// Expose function globally
if (typeof window !== 'undefined') {
    window.showAcquiringDifficultyDialog = showAcquiringDifficultyDialog;
}

// One namespace for the whole tool: `session` is a live view of the drawing session's state and every
// function above is listed by name. The state itself stays in this script's top-level bindings, which
// the functions read by name; each binding is a read/write property of `session`, so a caller sees and
// sets the same variable the tool does. The browser gets it as window.__roadDrawing (the console, e2e
// specs); node tests require() this file and drive the real functions through it
// (backend/test/helpers/road-drawing-env.js).
(function exportRoadDrawing(root) {
    const session = {};
    const bind = (name, get, set) => Object.defineProperty(session, name, { get, set, enumerable: true });
    bind('roadDrawingMode', () => roadDrawingMode, value => { roadDrawingMode = value; });
    bind('corridorDrawKind', () => corridorDrawKind, value => { corridorDrawKind = value; });
    bind('roadSegments', () => roadSegments, value => { roadSegments = value; });
    bind('roadPoints', () => roadPoints, value => { roadPoints = value; });
    bind('roadSegmentIds', () => roadSegmentIds, value => { roadSegmentIds = value; });
    bind('nextRoadSegmentId', () => nextRoadSegmentId, value => { nextRoadSegmentId = value; });
    bind('roadWidth', () => roadWidth, value => { roadWidth = value; });
    bind('roadSidewalkWidth', () => roadSidewalkWidth, value => { roadSidewalkWidth = value; });
    bind('roadProfile', () => roadProfile, value => { roadProfile = value; });
    bind('roadCenterline', () => roadCenterline, value => { roadCenterline = value; });
    bind('roadPolygon', () => roadPolygon, value => { roadPolygon = value; });
    bind('roadPreviewLine', () => roadPreviewLine, value => { roadPreviewLine = value; });
    bind('roadAffectedParcels', () => roadAffectedParcels, value => { roadAffectedParcels = value; });
    bind('roadMouseMarker', () => roadMouseMarker, value => { roadMouseMarker = value; });
    bind('roadHasStarted', () => roadHasStarted, value => { roadHasStarted = value; });
    bind('roadPreviewPolygonLayer', () => roadPreviewPolygonLayer, value => { roadPreviewPolygonLayer = value; });
    bind('roadPendingSegmentLayer', () => roadPendingSegmentLayer, value => { roadPendingSegmentLayer = value; });
    bind('roadCenterlineLayer', () => roadCenterlineLayer, value => { roadCenterlineLayer = value; });
    bind('roadPolygonLayer', () => roadPolygonLayer, value => { roadPolygonLayer = value; });
    bind('roadMarkers', () => roadMarkers, value => { roadMarkers = value; });
    bind('roadBuildingTunnels', () => roadBuildingTunnels, value => { roadBuildingTunnels = value; });
    bind('roadGradeSeparations', () => roadGradeSeparations, value => { roadGradeSeparations = value; });
    bind('roadEdgeConflicts', () => roadEdgeConflicts, value => { roadEdgeConflicts = value; });
    bind('roadConflictMarkerLayer', () => roadConflictMarkerLayer, value => { roadConflictMarkerLayer = value; });
    bind('roadStreetConnections', () => roadStreetConnections, value => { roadStreetConnections = value; });
    bind('roadSegmentProfiles', () => roadSegmentProfiles, value => { roadSegmentProfiles = value; });
    bind('roadMirroredSegmentIds', () => roadMirroredSegmentIds, value => { roadMirroredSegmentIds = value; });
    bind('roadSegmentPlacementInProgress', () => roadSegmentPlacementInProgress, value => { roadSegmentPlacementInProgress = value; });
    bind('roadSegmentPlacement', () => roadSegmentPlacement, value => { roadSegmentPlacement = value; });
    bind('roadLastClickAt', () => roadLastClickAt, value => { roadLastClickAt = value; });
    bind('roadDrawingProfileValidationPending', () => roadDrawingProfileValidationPending, value => { roadDrawingProfileValidationPending = value; });
    bind('roadLastValidatedWidth', () => roadLastValidatedWidth, value => { roadLastValidatedWidth = value; });
    bind('roadSurfaceBuildingIds', () => roadSurfaceBuildingIds, value => { roadSurfaceBuildingIds = value; });
    bind('roadBuildingTunnelLayer', () => roadBuildingTunnelLayer, value => { roadBuildingTunnelLayer = value; });
    bind('roadGradeSeparationLayer', () => roadGradeSeparationLayer, value => { roadGradeSeparationLayer = value; });
    bind('roadPreviewAffectedParcels', () => roadPreviewAffectedParcels, value => { roadPreviewAffectedParcels = value; });
    bind('lockedParcelIds', () => lockedParcelIds, value => { lockedParcelIds = value; });
    bind('lockedStats', () => lockedStats, value => { lockedStats = value; });
    bind('committedRoadMetrics', () => committedRoadMetrics, value => { committedRoadMetrics = value; });
    bind('cachedCommittedPolygon', () => cachedCommittedPolygon, value => { cachedCommittedPolygon = value; });
    bind('roadDrawingFrame', () => roadDrawingFrame, value => { roadDrawingFrame = value; });
    bind('corridorApplyIndicatorCount', () => corridorApplyIndicatorCount, value => { corridorApplyIndicatorCount = value; });
    bind('corridorApplyIndicatorTimer', () => corridorApplyIndicatorTimer, value => { corridorApplyIndicatorTimer = value; });
    bind('corridorApplyIndicatorRelease', () => corridorApplyIndicatorRelease, value => { corridorApplyIndicatorRelease = value; });
    bind('roadSnapMarker', () => roadSnapMarker, value => { roadSnapMarker = value; });
    bind('roadStripLayer', () => roadStripLayer, value => { roadStripLayer = value; });
    bind('roadOwnershipStatsRequestId', () => roadOwnershipStatsRequestId, value => { roadOwnershipStatsRequestId = value; });
    bind('roadDrawingHeldDoubleClickZoom', () => roadDrawingHeldDoubleClickZoom, value => { roadDrawingHeldDoubleClickZoom = value; });
    bind('roadDrawHotkeyAttached', () => roadDrawHotkeyAttached, value => { roadDrawHotkeyAttached = value; });
    bind('roadDrawingAutoShowedBuildings', () => roadDrawingAutoShowedBuildings, value => { roadDrawingAutoShowedBuildings = value; });
    bind('corridorFinishProfile', () => corridorFinishProfile, value => { corridorFinishProfile = value; });
    bind('trackSpeed', () => trackSpeed, value => { trackSpeed = value; });
    bind('trackMinCurvatureRadius', () => trackMinCurvatureRadius, value => { trackMinCurvatureRadius = value; });
    bind('trackSegmentSound', () => trackSegmentSound, value => { trackSegmentSound = value; });
    bind('trackSegmentSoundStopTimer', () => trackSegmentSoundStopTimer, value => { trackSegmentSoundStopTimer = value; });
    bind('roadFinalizationGate', () => roadFinalizationGate);
    bind('roadOpenGroundCrossed', () => roadOpenGroundCrossed);
    bind('previewAffectedStyle', () => previewAffectedStyle);
    bind('ROAD_SNAP_PIXELS', () => ROAD_SNAP_PIXELS);
    bind('ROAD_DRAWING_MARKER_PANE', () => ROAD_DRAWING_MARKER_PANE);
    bind('ROAD_OWNERSHIP_TYPE_IDS', () => ROAD_OWNERSHIP_TYPE_IDS);
    bind('roadOwnershipTypeCache', () => roadOwnershipTypeCache);
    const api = {
        session,
        hideRoadInfoPanel, canStartRoadDrawingInCurrentMode,
        corridorDrawingIsTrack, corridorDrawingKind, announceCorridorDrawingModeChange,
        updateGlobalRoadDrawingMode, newRoadSegmentId, pushRoadSegment, roadDrawingSegmentOverride,
        roadDrawingWidthForSegmentIndex, buildDrawingTunnelLayer, refreshRoadBuildingTunnelLayer,
        refreshRoadGradeSeparationLayer, ensureBuildingFootprintsForRoadEdge,
        ensureBuildingTunnelsForSegments, validateRoadDrawingProfileImpacts,
        getLockedIndividualOwnersCount, corridorFootprintModule, metricFrameModule, roadSessionFrame,
        roadPolygonFromGeoJSON, polylineLengthMeters, isParcelLockedForRoadDrawing, getAllRoadSegments,
        calculateSegmentLengthMeters, calculatePolygonAreaMeters, buildRoadUnionPolygonWithWidths,
        corridorProtectedSpanRecordsForDefinition, corridorProtectedEdgeKeySet,
        corridorSurfaceFootprintForDefinition, buildCorridorAcquisitionPolygon,
        collectParcelsIntersectingFootprint, beginApplyIndicator, endApplyIndicator,
        isCorridorApplyInFlight, cloneRoadValue, baseRoadParentHints, writeRoadDefinition,
        stripRoadDerivedFields, makeFreshRoadSnapshot, declareParcelsUnderRoadLand,
        reviseRoadForJunction, rekeyMovedTunnelRecords, rebuildRoadDefinitionFootprint, updateLocalCorridorGeometry,
        runLocalCorridorGeometryUpdate, ensureRoadDrawingMarkerPane, appliedCorridorSnapSegments,
        streetSnapLinesNear, roadSnapSuppressed, findRoadSnapTarget, clearRoadSnapMarker,
        roadStreetSnapLabel, showRoadSnapMarker, createRoadVertexMarker, redrawRoadVertexMarkers,
        clearRoadStripLayer, appliedArmsMeetingDrawing, appliedJunctionArmsForDrawing, redrawRoadStrips,
        getRoadDrawingProfile, currentCorridorDraftCityId, draftLatLng, saveCurrentCorridorDrawingDraft,
        setRoadDrawingProfile, updateRoadCrossSectionButton, rebuildRoadGeometryFromSegments,
        normalizeSeedSegments, seedRoadDrawing, seededSurfaceBuildingIds, resumeRoadSegment,
        mirrorRoadSegmentProfile, insertRoadNodeOnEdge, corridorSnapSegmentsOf, roadSnapBoxNear,
        bboxReachesRoadSnapBox, syncRoadSidewalkWidthFromProfile, rememberedRoadProfile,
        getRoadDrawingParcelIdFromFeature, getRoadDrawingFabric, getRoadDrawingPresenterLayer,
        getRoadDrawingLiveFeature, liveRoadDrawingParcelsIntersecting, roadDrawingParcelEntry,
        getParcelIdFromAny, getRoadDrawingParcelProperties, setRoadParcelStats,
        renderRoadOpenGroundStat, formatParcelArea, resetRoadMetricPlaceholders, formatRoadText,
        translateRoadText, showRoadAlert, setRoadOwnershipCounts,
        getMarketPrice, updateRoadMarketPrice, updateRoadAcquiringDifficulty,
        collectOwnershipAndAcquisitionStats, updateRoadOwnershipCounts, clearMapSelectionsForDrawing,
        disableMultiSelectForDrawing, setRoadPanelLabelsForMode, requestCorridorDrawingTool,
        startSeededCorridorDrawing, corridorDrawButton, toggleRoadDrawTool, promptCloseDrawnCorridor,
        discardRoadDrawing, handleRoadKeydown, handleRoadEscape, afterRoadPlacement,
        handleRoadDoubleClick, holdRoadDoubleClickZoom, releaseRoadDoubleClickZoom,
        handleRoadDrawingMoveEnd, isEditableTarget, isElementVisiblyRendered, isAnyModalOpen,
        autoShowBuildingsForRoadDrawing, restoreBuildingsAfterRoadDrawing, ensureRoadOperationBuildings,
        setBuildingReferenceLayers, toggleBuildingReferenceLayers, handleRoadDrawHotkey,
        attachRoadDrawHotkey, updateUndoButtonState, clearRoadRubberBand, roadPenDownStatusText,
        roadPenUpStatusText, liftRoadPen, detectRoadEdgeConflicts, roadConflictMarkerPoints,
        recordRoadEdgeConflicts, pruneRoadEdgeConflicts, redrawRoadConflictMarkers,
        roadConflictListText, roadConflictsStatusText, reviewRoadConflictsAtFinish,
        applyRoadConflictReview, roadConflictAnswerDeps, undoLastRoadSegment, handleRoadClick,
        rememberRoadStreetConnection, liveRoadStreetConnections, writeStreetConnectionsToDraft,
        handleRoadMouseMove, showPendingRoadSegment, clearPendingRoadSegment, handleRoadMouseOut,
        stopRoadPreviewTracking, attachRoadDrawingInteractivity, suspendRoadDrawingInteractivity, exitRoadDrawingMode,
        calculateRoadPolygon, isLatLngLike, isValidPolygonLatLngs, polygonLatLngsToTurfFeature,
        ensurePolygonIsClosed, findAndHighlightAffectedParcels, findNewAffectedParcelsForSegment,
        roadLandNearEdge, getOwnershipTypeFromParcel, recomputeLockedParcelsFromPolygon, lockParcelsFromSegment,
        roadDrawingCurrencyCode, formatCurrency, findAffectedParcels, toggleRoadInfoPanelMinimized,
        updateRoadInfoPanel, updatePreviewRoadInfo, finishRoadOrTrackDrawing,
        undoLastRoadOrTrackSegment, cancelRoadOrTrackDrawing, finishRoadDrawing,
        markCorridorFinishPhase, reportCorridorFinishProfile, hasDrawableCorridor,
        corridorFinalizationLabel, detachDrawnCorridorAsGhost, corridorGhostDisposer,
        snapshotRoadDrawingGeometry, resumeRoadDrawingAfterFailedFinish, corridorProfileHoldsRadiusTarget,
        reviewTrackCurvatureAtFinish, finishRoadDrawingOnce, cancelRoadDrawing, resetRoadDrawing, clearAffectedParcels,
        clearPreviewAffectedParcels, findPreviewAffectedParcels, playTrackSegmentSound,
        showTrackSpeedPicker, trackTargetOf, showAcquiringDifficultyDialog, nowMs
    };
    if (root) root.__roadDrawing = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
