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
// gauge — and everything the road tool can do (snapping, junctions, branching, resuming, absorbing a
// placed corridor) a track can do, because it IS the road tool. `corridorDrawKind` remembers which
// button opened the session, and is used only for what the user sees: which button lights up, what the
// panel is called, and whether the rail speed/curvature limit applies.
// ---------------------------------------------------------------------------
let roadDrawingMode = false;
let corridorDrawKind = 'road';

// The kind of the corridor CURRENTLY on the tool: a rail lane in the cross-section makes it a track,
// whichever button opened the session (drop a tram lane into a street and the rail limits apply).
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
    if (typeof window !== 'undefined') {
        window.roadDrawingMode = value;
    }
    announceCorridorDrawingModeChange();
}

function shouldRestoreParcelClickInteractivity() {
    if (typeof window !== 'undefined' && typeof window.isParcelDrawingModeActive === 'function') {
        return !window.isParcelDrawingModeActive();
    }
    return !roadDrawingMode;
}

function restoreParcelClickInteractivity() {
    if (!parcelLayer || !shouldRestoreParcelClickInteractivity()) return;

    try {
        parcelLayer.eachLayer(layer => {
            layer.off('click');
            if (typeof getCorrectClickHandler === 'function') {
                layer.on('click', getCorrectClickHandler());
            }
        });
    } catch (_) { }
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
if (typeof window !== 'undefined') {
    window.roadSidewalkWidth = roadSidewalkWidth;
}
let roadCenterline = null;
let roadPolygon = null;
let roadPreviewLine = null;
// How many points the active polyline had when the pen went down — Esc trims back to this.
let roadStrokeBaseCount = 0;
let roadPreviewPolygon = null;
let roadAffectedParcels = [];
let roadMouseMarker = null;
let roadHasStarted = false;
let roadPreviewPolygonLayer = null;
let roadCenterlineLayer = null;
let roadPolygonLayer = null;
let roadMarkers = [];
let roadBuildingTunnels = [];
let roadGradeSeparations = [];
// Per-segment cross-section overrides for the segments of THIS drawing session that came in
// with their own profile (absorbed roads, seeded edits). Keyed by segment id; drawing-new
// segments use the session's active roadProfile. See corridorSegmentProfile().
let roadSegmentProfiles = {};
// Finishing is a single user action even though proposal creation crosses several async boundaries.
// Segment placement has its own lock because its footprint fetch and obstacle decision must complete
// before either another click or F is allowed to consume the drawing state.
const roadFinalizationGate = RoadFinalizationState.createSingleFlightGate();
let roadSegmentPlacementInProgress = false;
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
let roadDemolishedBuildings = []; // {id, geometry} records accepted via the Demolish choice
let roadBuildingTunnelLayer = null;
let roadGradeSeparationLayer = null;
let lastRoadMoveUpdate = 0;
let throttleDelay = 150; // milliseconds between updates
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
        L.polyline([record.from, record.crossing, record.to], {
            color: over ? '#f59e0b' : '#2563eb',
            weight: Math.max(6, Number(record.width) || 2),
            opacity: 0.9,
            dashArray: over ? null : '7 6',
            pane,
            interactive: false
        }).addTo(roadGradeSeparationLayer);
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
    for (const edge of corridorEdgeFetchSegments(from, to)) {
        const polygon = calculateRoadPolygon(edge, width);
        if (polygon) await window.ensureBuildingFootprintsForBounds(polygon);
    }
}

// A hit's per-building action from an obstacle resolution: the tour's per-building override if it set
// one, else the global default. resolveBuildingObstacles carries the map; the fallback keeps the old
// single-action shape working (every hit gets resolution.action).
function resolvedActionForHit(resolution, hit) {
    const id = String(hit && hit.id != null ? hit.id : '');
    const map = resolution && resolution.effectiveActionById;
    if (map && typeof map.get === 'function' && map.has(id)) return map.get(id);
    return (resolution && resolution.action) || 'cancel';
}

// Width/profile edits can make a previously clear edge touch a building. This check belongs to the
// edit's Apply action, never to F: segment placement and geometry edits own every impact decision.
async function ensureBuildingTunnelsForSegments(segments, width, kind, records, segmentIds = [], demolishedRecords = [], segmentProfiles = null, options = {}) {
    const promptForMissing = options.promptForMissing === true;
    const list = Array.isArray(records) ? records.slice() : [];
    const demolished = Array.isArray(demolishedRecords) ? demolishedRecords.slice() : [];
    const fullyDemolishedIds = new Set(demolished.filter(record => !record.remainder).map(record => String(record.id)));
    const cutRecordIds = new Set(demolished.filter(record => record.remainder).map(record => String(record.id)));
    const widthForSegment = index => {
        const id = segmentIds[index];
        const override = (segmentProfiles && id !== undefined && id !== null) ? segmentProfiles[String(id)] : null;
        const overrideWidth = override && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(override) : 0;
        return overrideWidth > 0 ? overrideWidth : width;
    };
    if (typeof detectLoadedBuildingTunnelIntersections !== 'function'
        || typeof corridorTunnelEdgeKey !== 'function') {
        // Hard dependency (corridor-tunnel.js). Proceeding would silently pave through buildings.
        console.error('[road-drawing] building obstacle detection unavailable — refusing to finish the corridor');
        return { accepted: false, records: list, demolished };
    }
    // Cover the WHOLE edited corridor before resolving the changed footprint. Merges/absorbs can
    // contribute geometry loaded elsewhere, so validating only the last active edge is insufficient.
    if (typeof window !== 'undefined' && typeof window.ensureBuildingFootprintsForBounds === 'function') {
        for (let segmentIndex = 0; segmentIndex < (segments || []).length; segmentIndex++) {
            const segment = segments[segmentIndex];
            if (!Array.isArray(segment) || segment.length < 2) continue;
            for (let pointIndex = 0; pointIndex < segment.length - 1; pointIndex++) {
                try {
                    await ensureBuildingFootprintsForRoadEdge(
                        segment[pointIndex], segment[pointIndex + 1], widthForSegment(segmentIndex)
                    );
                } catch (error) {
                    console.error('[road-drawing] footprint preload before finish check failed', error);
                }
            }
        }
    }
    const missing = [];
    const combinedHits = new Map();
    // A building this road already tunnels ANYWHERE keeps that decision: a wider profile (or any edit)
    // that newly grazes it must reuse the tunnel, never re-ask. Built once from the road's live tunnel
    // records — the same whole-road, building-keyed rule the geometry-edit path uses, so a road's
    // relation to a building is decided once and identically across every edit path.
    const alreadyTunnelledIds = new Set();
    list.forEach(record => (record?.buildingIds || []).forEach(id => { if (id) alreadyTunnelledIds.add(String(id)); }));
    (segments || []).forEach((segment, segmentIndex) => {
        for (let pointIndex = 0; pointIndex < segment.length - 1; pointIndex++) {
            const from = segment[pointIndex];
            const to = segment[pointIndex + 1];
            const edgeKey = corridorTunnelEdgeKey(from, to);
            if (!edgeKey) continue;
            const polygon = calculateRoadPolygon([from, to], widthForSegment(segmentIndex));
            const detected = (polygon ? detectLoadedBuildingTunnelIntersections(polygon) : [])
                .filter(hit => !fullyDemolishedIds.has(String(hit.id)));
            // Buildings already CUT this session extend their cut silently on every edge that
            // crosses them — the per-building decision stands.
            if (polygon && typeof corridorFeatureFromLatLngRing === 'function' && typeof upsertCutRecord === 'function') {
                const edgeRegion = corridorFeatureFromLatLngRing(polygon);
                if (edgeRegion) {
                    detected.filter(hit => cutRecordIds.has(String(hit.id)))
                        .forEach(hit => upsertCutRecord(demolished, hit, edgeRegion));
                }
            }
            const hits = detected.filter(hit => !cutRecordIds.has(String(hit.id)));
            // Reuse across the WHOLE road, not just this edge: a building tunnelled on any edge is
            // exempt here too, so a wider profile that newly grazes it never re-asks (parity with the
            // geometry-edit path — a road's decision about a building is made once, everywhere).
            const newHits = hits.filter(hit => !alreadyTunnelledIds.has(String(hit.id)));
            if (!newHits.length) continue;
            newHits.forEach(hit => combinedHits.set(hit.id, hit));
            missing.push({
                from, to, hits, segmentIndex, pointIndex,
                edgeWidth: widthForSegment(segmentIndex),
                segmentId: segmentIds[segmentIndex] || (kind === 'track' ? 'track' : null)
            });
        }
    });
    if (!missing.length) return { accepted: true, records: list, demolished };
    if (!promptForMissing) {
        return {
            accepted: false,
            records: list,
            demolished,
            unresolvedHits: Array.from(combinedHits.values())
        };
    }
    const resolution = typeof resolveBuildingObstacles === 'function'
        ? await resolveBuildingObstacles(Array.from(combinedHits.values()), kind)
        : { action: 'cancel', removedProposalIds: [], demolishedBuildings: [] };
    if (resolution.action === 'cancel') return { accepted: false, records: list, demolished };
    // Per-building outcomes: destroy, cut and tunnel can all apply within the same set now (the tour
    // lets the user override individual buildings), so run each independently, not as one blanket branch.
    (resolution.demolishedBuildings || []).forEach(record => {
        if (!fullyDemolishedIds.has(String(record.id))) {
            fullyDemolishedIds.add(String(record.id));
            demolished.push(record);
        }
    });
    // Cut each real cut-hit with every edge whose polygon crosses it (upsert accumulates).
    if ((resolution.cutHits || []).length
        && typeof corridorFeatureFromLatLngRing === 'function' && typeof upsertCutRecord === 'function') {
        const cutIds = new Set(resolution.cutHits.map(hit => String(hit.id)));
        missing.forEach(edge => {
            const polygon = calculateRoadPolygon([edge.from, edge.to], edge.edgeWidth || width);
            const edgeRegion = polygon ? corridorFeatureFromLatLngRing(polygon) : null;
            if (!edgeRegion) return;
            edge.hits.filter(hit => hit.feature && cutIds.has(String(hit.id)))
                .forEach(hit => upsertCutRecord(demolished, hit, edgeRegion));
        });
    }
    // Tunnel only the hits whose per-building action is 'tunnel' and whose proposal (if any) still
    // stands. Process edges from the END backwards so splicing portal vertices into the live segment
    // array never shifts the indices of edges still waiting their turn.
    const removedOwners = new Set(resolution.removedProposalIds || []);
    const hitTunnels = hit => {
        if (resolvedActionForHit(resolution, hit) !== 'tunnel') return false;
        const owner = typeof corridorTunnelHitProposalId === 'function' ? corridorTunnelHitProposalId(hit) : null;
        return !owner || !removedOwners.has(owner);
    };
    missing.sort((a, b) => (a.segmentIndex - b.segmentIndex) || (b.pointIndex - a.pointIndex));
    missing.forEach(edge => {
        const standingHits = edge.hits.filter(hitTunnels);
        if (!standingHits.length) return;
        const clippableHits = standingHits.filter(hit => hit.feature);
        const plan = (clippableHits.length && typeof clipCorridorEdgeThroughBuildings === 'function')
            ? clipCorridorEdgeThroughBuildings(edge.from, edge.to, clippableHits, edge.edgeWidth || width)
            : null;
        if (!plan) {
            const record = makeBuildingTunnelRecord(edge.from, edge.to, standingHits, { segmentId: edge.segmentId });
            if (record) addBuildingTunnelRecord(list, record);
            return;
        }
        const segment = segments[edge.segmentIndex];
        const interior = plan.slice(0, -1).map(sub => ({ lat: sub.to.lat, lng: sub.to.lng }));
        segment.splice(edge.pointIndex + 1, 0, ...interior);
        plan.forEach(sub => {
            if (!sub.inside) return;
            const record = makeBuildingTunnelRecord(sub.from, sub.to, sub.hits, { segmentId: edge.segmentId });
            if (record) addBuildingTunnelRecord(list, record);
        });
    });
    return { accepted: true, records: list, demolished };
}

// Commit the cross-section editor's live width preview. A changed footprint is an EDIT, so it owns
// the cut/demolish/tunnel decision before the editor closes. F only serializes this validated state.
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
    const segmentIds = drawnSegments.map(entry => entry.id);
    const result = await ensureBuildingTunnelsForSegments(
        segments,
        roadWidth,
        corridorDrawingKind(),
        roadBuildingTunnels,
        segmentIds,
        roadDemolishedBuildings,
        roadSegmentProfiles,
        { promptForMissing: true }
    );
    if (!result.accepted) return false;

    roadBuildingTunnels = result.records;
    roadDemolishedBuildings = result.demolished;
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

// Per-segment history for undo functionality
// Each entry stores the parcels that were locked by that segment
let roadSegmentHistory = []; // Array of { parcelIds: Set, stats: {...} }

// Helper to get locked individual owners count
function getLockedIndividualOwnersCount() {
    return lockedStats.individualOwners || 0;
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
    let length = 0;
    const coords = segment
        .map(p => (p && isFinite(p.lat) && isFinite(p.lng) ? wgs84ToHTRS96(p.lat, p.lng) : null))
        .filter(isValidPoint);
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        length += Math.sqrt(dx * dx + dy * dy);
    }
    return length;
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

function buildRoadUnionPolygonFromSegments(segments, width) {
    let combined = null;
    (segments || []).forEach(segment => {
        if (!Array.isArray(segment) || segment.length < 2) return;
        const poly = calculateRoadPolygon(segment, width);
        if (poly) {
            combined = combineRoadPolygons(combined, poly);
        }
    });
    return combined;
}

// Footprint when widths differ per segment: widths[i] pairs with segments[i].
function buildRoadUnionPolygonWithWidths(segments, widths, fallbackWidth) {
    let combined = null;
    (segments || []).forEach((segment, index) => {
        if (!Array.isArray(segment) || segment.length < 2) return;
        const width = (Array.isArray(widths) && Number(widths[index]) > 0) ? Number(widths[index]) : fallbackWidth;
        const poly = calculateRoadPolygon(segment, width);
        if (poly) combined = combineRoadPolygons(combined, poly);
    });
    return combined;
}

// THE footprint builder for a placed corridor: honors per-segment cross-sections.
function buildRoadUnionPolygonForDefinition(definition) {
    if (typeof corridorSegmentEntries !== 'function') {
        console.error('[road-drawing] corridorSegmentEntries unavailable — footprint uses the uniform width');
        return buildRoadUnionPolygonFromSegments(corridorCenterlineOf(definition), Number(definition?.width) || 10);
    }
    const entries = corridorSegmentEntries(definition);
    return buildRoadUnionPolygonWithWidths(
        entries.map(entry => entry.points),
        entries.map(entry => entry.width),
        Number(definition?.width) || 10
    );
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

// Surface-only acquisition footprint (tunnelled edges acquire nothing) at per-segment widths,
// as raw latlng polygon — what parcel cutting consumes.
function buildCorridorAcquisitionPolygon(definition) {
    if (typeof corridorSegmentEntries !== 'function' || typeof corridorSurfaceRuns !== 'function') {
        console.error('[road-drawing] per-segment helpers unavailable — acquisition footprint uses the uniform width');
        return buildRoadUnionPolygonFromSegments(corridorCenterlineOf(definition), Number(definition?.width) || 10);
    }
    let combined = null;
    corridorSegmentEntries(definition).forEach(entry => {
        if (!Array.isArray(entry.points) || entry.points.length < 2) return;
        corridorSurfaceRuns([entry.points], corridorProtectedSpanRecordsForDefinition(definition)).forEach(run => {
            const poly = calculateRoadPolygon(run, entry.width);
            if (poly) combined = combineRoadPolygons(combined, poly);
        });
    });
    return combined;
}

// Same footprint as GeoJSON — parent collection and drafts store this shape.
function corridorSurfaceFootprintForDefinition(definition) {
    const combined = buildCorridorAcquisitionPolygon(definition);
    if (!combined) return null;
    const geo = convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(combined));
    return (geo && geo.type) ? geo : null;
}

// Persist the surface footprint on the definition, next to the `polygon` cache it already carries:
// the corridor's extent MINUS its tunnelled spans, i.e. the ground it actually clears and actually
// buys. Written only when tunnels exist; with no tunnels the full polygon already is it.
//
// Both are DERIVED through the city's metric projection (proj4 via CityConfigManager), which only
// the browser has — so a consumer that is not the browser cannot re-derive it and has to be handed it.
//
// NOTE: the building carve no longer reads this. It used to be load-bearing there — the server had
// to know which ground a tunnelled corridor did NOT clear, or it would demolish the building the
// road passes under. Now a tunnel simply writes no demolition record, and no record means no carve,
// so tunnelled buildings are safe by construction. What still depends on this footprint is PARCEL
// ACQUISITION: a tunnelled stretch acquires no parcels (see collectParcelsIntersectingFootprint).
function attachCorridorSurfaceFootprint(definition) {
    if (!definition) return definition;
    const tunnels = Array.isArray(definition.tunnels) ? definition.tunnels.filter(Boolean) : [];
    const gradeSeparations = Array.isArray(definition.gradeSeparations) ? definition.gradeSeparations.filter(Boolean) : [];
    definition.surfaceFootprint = (tunnels.length || gradeSeparations.length)
        ? corridorSurfaceFootprintForDefinition(definition)
        : null;
    return definition;
}

if (typeof window !== 'undefined') {
    window.buildRoadUnionPolygonForDefinition = buildRoadUnionPolygonForDefinition;
    window.buildCorridorAcquisitionPolygon = buildCorridorAcquisitionPolygon;
    window.corridorSurfaceFootprintForDefinition = corridorSurfaceFootprintForDefinition;
    window.attachCorridorSurfaceFootprint = attachCorridorSurfaceFootprint;
}

// Every geometry change re-derives the parcels the corridor now touches. Runs against the
// currently loaded parcel fabric (same reach as drawing-time detection).
function collectParcelsIntersectingFootprint(footprintGeometry) {
    if (!footprintGeometry || typeof parcelLayer === 'undefined' || !parcelLayer || typeof turf === 'undefined') return [];
    const geometry = footprintGeometry.type ? footprintGeometry : { type: 'Polygon', coordinates: footprintGeometry };
    let roadFeature = null;
    let footprintBounds = null;
    try {
        roadFeature = { type: 'Feature', properties: {}, geometry };
        footprintBounds = L.geoJSON(roadFeature).getBounds();
    } catch (_) {
        return [];
    }
    const ids = [];
    parcelLayer.eachLayer(layer => {
        const parcelId = getRoadDrawingParcelIdFromFeature(layer.feature);
        if (!parcelId) return;
        try {
            if (footprintBounds && !footprintBounds.intersects(layer.getBounds())) return;
        } catch (_) { }
        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || !outerRings.length) return;
        try {
            for (let r = 0; r < outerRings.length; r += 1) {
                if (turf.booleanIntersects(roadFeature, turf.polygon([outerRings[r]]))) {
                    ids.push(String(parcelId));
                    break;
                }
            }
        } catch (_) { }
    });
    return ids;
}

// SimCity object editing: mutate a LOCAL, unminted corridor proposal in place (node drag or
// profile change), rebuild its footprint from the centerline, and re-apply it so the parcel
// cuts follow. Minted proposals are immutable and are refused here — they go through the
// draft/replacement flow instead.
// planarSegmentIntersection, insertCorridorCrossingNodes, corridorConnectedComponents and
// centerlinesTouch moved to frontend/js/corridor-geometry.js (loaded first) — pure centerline
// graph geometry, now unit-tested. Callers below use the globals unchanged.

// Applied LOCAL corridors of the given kind whose geometry genuinely connects to the given
// centerline — the merge candidates. Minted corridors are immutable and never merge.
function findTouchingLocalCorridors(kind, footprintGeometry, excludeKeys = [], centerlineSegments = null, allowNearMiss = false) {
    if (!footprintGeometry || typeof turf === 'undefined' || typeof turf.booleanIntersects !== 'function') return [];
    if (typeof proposalStorage === 'undefined') return [];
    const excluded = new Set((excludeKeys || []).map(String));
    const geometry = footprintGeometry.type ? footprintGeometry : { type: 'Polygon', coordinates: footprintGeometry };
    const feature = { type: 'Feature', properties: {}, geometry };
    return (proposalStorage.getAllProposals?.() || []).filter(proposal => {
        const definition = proposal?.roadProposal?.definition;
        if (!definition || !definition.polygon) return false;
        // Like merges with like: a track absorbs a track, a road a road. Track-ness comes from the
        // cross-section (corridorIsTrack), so a street that has been given a tram lane counts as one.
        if ((kind === 'track') !== corridorIsTrack(definition)) return false;
        const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
        if (excluded.has(String(key))) return false;
        if (!isApplied(proposal, proposal.roadProposal)) return false;
        if (typeof isProposalMinted === 'function' && isProposalMinted(proposal)) return false;
        try {
            const target = definition.polygon.type ? definition.polygon : { type: 'Polygon', coordinates: definition.polygon };
            if (!turf.booleanIntersects(feature, { type: 'Feature', properties: {}, geometry: target })) return false;
        } catch (_) { return false; }
        if (Array.isArray(centerlineSegments) && centerlineSegments.length) {
            const targetSegments = (typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(definition) : [];
            return centerlinesTouch(centerlineSegments, targetSegments, allowNearMiss);
        }
        return true;
    });
}

// Footprint of the corridor's surface-only runs (centerline minus tunnelled edges) as GeoJSON.
// Tunnel spans are covered structures that acquire nothing, so parent collection and parcel
// cuts must use this instead of the full polygon. Returns null when nothing is at the surface.
function corridorSurfaceFootprintGeoJSON(segments, width, tunnels) {
    if (typeof corridorSurfaceRuns !== 'function') return null;
    const runs = corridorSurfaceRuns(segments, tunnels);
    if (!runs.length) return null;
    const union = buildRoadUnionPolygonFromSegments(runs, Number(width) || 10);
    const geo = convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(union));
    return (geo && geo.type) ? geo : null;
}

// A component that disconnects from a road becomes its own proposal: same cross-section and
// facets, fresh auto-name, applied immediately. Tunnels stay with the main body — their edge
// pairing does not survive a split.
async function createRoadProposalFromComponent(baseProposal, component) {
    const baseDefinition = baseProposal.roadProposal.definition;
    const width = Number(baseDefinition.width) || 10;
    const componentIds = new Set((component.segmentIds || []).filter(Boolean).map(String));
    const componentProfiles = {};
    Object.entries(baseDefinition.segmentProfiles || {}).forEach(([id, profile]) => {
        if (componentIds.has(String(id)) && profile) componentProfiles[String(id)] = JSON.parse(JSON.stringify(profile));
    });
    const unionPolygon = buildRoadUnionPolygonWithWidths(
        component.segments,
        component.segments.map((_, index) => {
            const id = component.segmentIds ? component.segmentIds[index] : null;
            const override = (id !== null && id !== undefined) ? componentProfiles[String(id)] : null;
            const overrideWidth = override && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(override) : 0;
            return overrideWidth > 0 ? overrideWidth : width;
        }),
        width
    );
    const latLngPairs = convertRoadPolygonToLatLngPairs(unionPolygon);
    const polygon = convertLatLngPairsToGeoJSON(latLngPairs);
    const definition = {
        ...JSON.parse(JSON.stringify(baseDefinition)),
        points: component.segments,
        segments: component.segments,
        segmentIds: component.segmentIds,
        segmentProfiles: componentProfiles,
        tunnels: [],
        // Each split piece keeps only the demolitions its own footprint covers.
        demolishedBuildings: (Array.isArray(baseDefinition.demolishedBuildings) && polygon?.type)
            ? baseDefinition.demolishedBuildings.filter(record => {
                try {
                    return record?.geometry && turf.booleanPointInPolygon(
                        turf.centroid({ type: 'Feature', properties: {}, geometry: record.geometry }),
                        { type: 'Feature', properties: {}, geometry: polygon }
                    );
                } catch (error) {
                    console.error('[createRoadProposalFromComponent] demolition footprint check failed', record?.id, error);
                    return false;
                }
            })
            : [],
        polygon: (polygon && polygon.type) ? polygon : null,
        latLngPairs
    };
    // The spread above carried the base corridor's surface footprint in; this piece has no tunnels
    // of its own, so clear it rather than let a footprint from another geometry linger.
    attachCorridorSurfaceFootprint(definition);

    const clone = JSON.parse(JSON.stringify(baseProposal));
    ['proposalId', 'proposal_id', 'id', 'hash', 'chainProposalId', 'tokenId', 'onchain', 'nft',
        'createdAt', 'updatedAt', 'childParcelIds', 'acceptedParcelIds', 'ownerAcceptances',
        'executedAt', 'appliedAt', 'replacementLifecycle', 'supersedesProposalIds',
        'sourceProposalId', 'replacementOfProposalId', 'proposalDraftId', 'lens'
    ].forEach(key => delete clone[key]);
    const name = (typeof generateDefaultProposalName === 'function')
        ? generateDefaultProposalName(corridorIsTrack(definition) ? 'Track' : 'Road')
        : `Road ${latLngPairs?.length || ''}`;
    clone.title = name;
    clone.name = name;
    clone.proposalName = name;
    clone.applied = false;
    clone.definition = JSON.parse(JSON.stringify(definition));
    clone.geometry = { ...(clone.geometry || {}), roadPlan: JSON.parse(JSON.stringify(definition)) };
    if (definition.polygon) clone.geometry.roadGeometry = { polygon: JSON.parse(JSON.stringify(definition.polygon)) };
    const parents = definition.polygon ? collectParcelsIntersectingFootprint(definition.polygon) : [];
    clone.parentParcelIds = parents.slice();
    clone.roadProposal = {
        ...JSON.parse(JSON.stringify(clone.roadProposal || {})),
        definition: JSON.parse(JSON.stringify(definition)),
        parentParcelIds: parents.slice(),
        childParcelIds: []
    };

    const newId = (typeof proposalStorage !== 'undefined') ? proposalStorage.addProposal(clone) : null;
    if (!newId) return null;
    try { ProposalManager._linkProposalToAncestors?.(newId, parents); } catch (_) { }
    try {
        await ProposalManager.applyProposal(newId, { applyAnyway: true, suppressMissingParentAlerts: true });
    } catch (error) {
        console.warn('[createRoadProposalFromComponent] Apply of split-off road failed', error);
    }
    return newId;
}

// A non-blocking "Applying…" spinner shown while any applied-corridor edit re-applies. Ref-counted so
// overlapping edits keep it up until the last one settles. It never blocks input (pointer-events:none in
// CSS) — road-node-edit coalesces edits made mid-apply instead. The CSS animation-delay means a fast
// edit removes it before it ever becomes visible, so only genuinely slow applies flash the spinner.
let corridorApplyIndicatorCount = 0;
let corridorApplyIndicatorEl = null;
function beginCorridorApplyIndicator() {
    corridorApplyIndicatorCount += 1;
    if (corridorApplyIndicatorEl || typeof document === 'undefined') return;
    const host = (typeof map !== 'undefined' && map && typeof map.getContainer === 'function') ? map.getContainer() : document.body;
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'corridor-apply-indicator';
    const spinner = document.createElement('div');
    spinner.className = 'corridor-apply-indicator__spinner';
    const label = document.createElement('span');
    label.textContent = (typeof translateRoadText === 'function')
        ? translateRoadText('panel.road.applyingEdit', 'Applying…')
        : 'Applying…';
    el.appendChild(spinner);
    el.appendChild(label);
    host.appendChild(el);
    corridorApplyIndicatorEl = el;
}
function endCorridorApplyIndicator() {
    corridorApplyIndicatorCount = Math.max(0, corridorApplyIndicatorCount - 1);
    if (corridorApplyIndicatorCount > 0) return;
    if (corridorApplyIndicatorEl && corridorApplyIndicatorEl.parentNode) {
        corridorApplyIndicatorEl.parentNode.removeChild(corridorApplyIndicatorEl);
    }
    corridorApplyIndicatorEl = null;
}
// True while any corridor re-apply is in flight — the exit/deselect paths wait on this.
function isCorridorApplyInFlight() {
    return corridorApplyIndicatorCount > 0;
}

// Wrapper: every corridor geometry edit (node drag, bulldoze, delete, profile change) funnels through
// here, so the "Applying…" spinner brackets all of them uniformly. The heavy work is in the impl below.
async function updateLocalCorridorGeometry(proposalIdOrHash, mutateDefinition, options = {}) {
    beginCorridorApplyIndicator();
    try {
        return await runLocalCorridorGeometryUpdate(proposalIdOrHash, mutateDefinition, options);
    } finally {
        endCorridorApplyIndicator();
    }
}

async function runLocalCorridorGeometryUpdate(proposalIdOrHash, mutateDefinition, options = {}) {
    const proposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalIdOrHash) : null;
    if (!proposal || !proposal.roadProposal || !proposal.roadProposal.definition) return false;
    if (typeof isProposalMinted === 'function' && isProposalMinted(proposal)) return false;

    const definition = proposal.roadProposal.definition;
    // The TRUE pre-edit shape. A node DRAG streams its live positions straight into this same
    // `definition` (road-node-edit's liveMoveNode) before we ever get here, so snapshotting `definition`
    // now would capture the DRAGGED geometry, not the original — which quietly poisoned the reroute
    // rollback (reverted to the wrong spot) and the changed-edge detection below (an edge "looked
    // unchanged" so a new building collision went unprompted). The drag hands us its dragstart snapshot
    // via options.preEditSnapshot; every other caller mutates inside mutateDefinition, so `definition`
    // is still pristine here and snapshotting it is correct.
    const definitionSnapshot = options.preEditSnapshot
        ? JSON.parse(JSON.stringify(options.preEditSnapshot))
        : JSON.parse(JSON.stringify(definition));
    // Every building this road demolished before the edit — partial cuts (records carry a `remainder`)
    // AND full demolitions (a cut that ate >85% of a building is stored as a whole-building record with
    // no remainder). On a move ALL of them must be undone and re-carved at the new footprint: the road
    // is the sole cause of the demolitions it owns, so they follow it. Restricting this to `remainder`
    // records froze the heavily-cut buildings near a junction (several converging legs tip a building
    // into the no-remainder branch) — they stayed as ghost slices at the old position. `geometry` is
    // each record's own original footprint. priorDemolitionIds covers EVERY prior record (even ones
    // whose footprint capture failed and stored geometry:null) so the drop below restores them all;
    // only the geometry-bearing ones can be re-carved.
    const priorDemolitionIds = new Set((definitionSnapshot.demolishedBuildings || [])
        .filter(record => record && record.id !== undefined && record.id !== null)
        .map(record => String(record.id)));
    const priorRoadDemolitions = (definitionSnapshot.demolishedBuildings || [])
        .filter(record => record && record.geometry)
        .map(record => ({ id: String(record.id), geometry: record.geometry }));
    if (typeof mutateDefinition === 'function') mutateDefinition(definition);

    // Normalize the (possibly mutated) centerline, make crossings real nodes, then check
    // whether the edit disconnected the body.
    const normalizedSegments = ((typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(definition) : [])
        .map(segment => segment.map(point => ({ lat: point.lat, lng: point.lng })))
        .filter(segment => segment.length >= 2);
    const normalizedIds = Array.isArray(definition.segmentIds) ? definition.segmentIds.slice(0, normalizedSegments.length) : [];
    // Tunnel records are edge-addressed. A node move changes those keys, so discard records whose
    // exact edge no longer exists BEFORE building detection derives its already-tunnelled ids. The
    // dropped records are re-keyed onto the moved endpoints just below (a pure move preserves the
    // portal vertices), so the tunnel follows the drag instead of being re-litigated.
    if (typeof retainLiveCorridorTunnelRecords === 'function') {
        definition.tunnels = retainLiveCorridorTunnelRecords(normalizedSegments, definition.tunnels || []);
    }
    // A node DRAG relocates a tunnel-span endpoint, so retention just dropped that record — but the
    // portal is still a vertex at the SAME centerline index (moveNodeTargets edits in place). Re-key
    // each dropped record onto the moved endpoints so the tunnel FOLLOWS the drag: no re-clip, no new
    // portal vertex, and — because the re-keyed edge lands in tunnelEdgeKeys below — no re-detection or
    // re-prompt. Records whose endpoints no longer form one adjacent edge (a structural edit, not a
    // pure move) are left dropped; alreadyTunnelledIds still exempts their buildings from re-asking.
    if ((definitionSnapshot.tunnels || []).length && typeof makeBuildingTunnelRecord === 'function'
        && typeof addBuildingTunnelRecord === 'function' && typeof corridorCenterlineOf === 'function') {
        const snapSegs = corridorCenterlineOf(definitionSnapshot) || [];
        const EPS = 1e-9;
        const near = (p, q) => p && q && Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
        const locate = (pt) => {
            for (let si = 0; si < snapSegs.length; si += 1) {
                const vi = (snapSegs[si] || []).findIndex(v => near(v, pt));
                if (vi >= 0) return [si, vi];
            }
            return null;
        };
        definition.tunnels = definition.tunnels || [];
        const liveKeys = new Set(definition.tunnels.map(r => r?.edgeKey).filter(Boolean));
        (definitionSnapshot.tunnels || []).forEach(record => {
            if (!record || !record.from || !record.to) return;
            if (record.edgeKey && liveKeys.has(record.edgeKey)) return; // retention kept it — nothing to re-key
            const a = locate(record.from), b = locate(record.to);
            if (!a || !b || a[0] !== b[0] || Math.abs(a[1] - b[1]) !== 1) return; // not one live adjacent edge
            const seg = normalizedSegments[a[0]];
            const nf = seg && seg[a[1]], nt = seg && seg[b[1]];
            if (!nf || !nt) return;
            const rekeyed = makeBuildingTunnelRecord(nf, nt, (record.buildingIds || []).map(id => ({ id })), { segmentId: record.segmentId });
            if (rekeyed && !liveKeys.has(rekeyed.edgeKey)) {
                addBuildingTunnelRecord(definition.tunnels, rekeyed);
                liveKeys.add(rekeyed.edgeKey);
            }
        });
    }
    if (typeof retainLiveGradeSeparations === 'function') {
        definition.gradeSeparations = retainLiveGradeSeparations(normalizedSegments, definition.gradeSeparations || []);
    }
    const key0 = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;

    // Bulldozed to nothing: the object simply ceases to exist. skipRestoreSource — bulldozing must
    // leave empty ground, not resurrect whatever road this one replaced when it was merged.
    if (!normalizedSegments.length) {
        try { await ProposalManager.unapplyProposal(key0, { skipConfirm: true, skipRestoreSource: true }); } catch (_) { }
        try { proposalStorage.removeProposal(key0); } catch (_) { }
        try { window.ProposalSelection?.clear?.(); } catch (_) { }
        try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }
        try { ProposalManager._refreshUIAfterProposalChange?.(null); } catch (_) { }
        if (typeof updateStatus === 'function') {
            updateStatus(translateRoadText('panel.road.bulldozedAllStatus', 'Road bulldozed.'));
        }
        return true;
    }

    // Dragging a road into a building gets the same three-way decision as drawing into one:
    // unapply the occupying proposal / tunnel through / reroute (the edit is reverted).
    const editKind = corridorIsTrack(definition) ? 'track' : 'road';
    const editWidth = Number(definition.width) || 10;
    const editWidthForSegment = segIndex => {
        const id = normalizedIds[segIndex];
        const override = (definition.segmentProfiles && id !== null && id !== undefined) ? definition.segmentProfiles[String(id)] : null;
        const overrideWidth = override && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(override) : 0;
        return overrideWidth > 0 ? overrideWidth : editWidth;
    };

    // Calculate road-to-road absorption in the SAME preflight as building impacts. This used to be
    // discovered only after the cutting/tunnelling dialog, so an edit could name the buildings and
    // then silently delete a touching road's separate proposal record during merge-on-connect.
    const prelimUnion = buildRoadUnionPolygonWithWidths(
        normalizedSegments,
        normalizedSegments.map((_, index) => editWidthForSegment(index)),
        editWidth
    );
    const prelimPolygon = convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(prelimUnion));
    // allowNearMiss: this is the drag/edit path, where the user deliberately drops a node onto (or a
    // hair short of) another road — a willing join, so a near-miss merge is honoured here. The finish
    // (absorb) path now honours it too: the user drew the stroke onto an existing road, the same
    // willing join. Only geometry that never came near the drawn/edited footprint is left untouched.
    // Never re-absorb a road this corridor deliberately grade-separates OVER/UNDER: the finish-path
    // merge excludes those ids and the edit path must too, or a drag that brings the footprints into
    // contact would swallow a road you intentionally bridged.
    const editGradeSeparatedIds = (definition.gradeSeparations || [])
        .map(record => record?.otherProposalId).filter(Boolean).map(String);
    const touchingRoads = (prelimPolygon && prelimPolygon.type)
        ? findTouchingLocalCorridors(editKind, prelimPolygon, [key0, ...editGradeSeparatedIds], normalizedSegments, true)
        : [];
    const mergeProposalImpacts = touchingRoads.map(target => {
        const proposalId = (typeof getProposalKey === 'function' ? getProposalKey(target) : null)
            || target.proposalId
            || target.id;
        let title = '';
        try {
            title = typeof getProposalDisplayTitle === 'function' ? getProposalDisplayTitle(target) : '';
        } catch (_) { }
        title = String(title || target.title || target.name || target.proposalName || `Proposal ${proposalId}`)
            .replace(/\s+/g, ' ')
            .trim();
        return { proposalId: String(proposalId), title };
    });

    if (typeof detectLoadedBuildingTunnelIntersections === 'function'
        && typeof resolveBuildingObstacles === 'function') {
        // A building this road already CUT or DEMOLISHED is exempt by id (below): it is gone from the
        // detection pool, so an edit never re-asks. Tunnels were the asymmetry — decided per EDGE
        // (`tunnelEdgeKeys`), so a moved or extended edge re-prompted (and re-spliced portals, growing
        // the centerline) for a building already tunnelled. `alreadyTunnelledIds` restores parity.
        // CRUCIAL: read it from the PRE-EDIT snapshot, not the live `definition.tunnels`. Dragging a
        // node that touches the tunnel span changes that edge's key, so retainLiveCorridorTunnelRecords
        // has ALREADY dropped the record above — the live list is empty exactly when the building is
        // still, obviously, tunnelled. The snapshot (frozen before the edit) still names every
        // tunnelled building, so the reuse holds and the drag no longer re-asks nor re-portals.
        const fullyDemolishedIds = new Set();
        const tunnelEdgeKeys = new Set();
        (definition.tunnels || []).forEach(record => {
            if (record?.edgeKey) tunnelEdgeKeys.add(record.edgeKey);
        });
        const alreadyTunnelledIds = new Set();
        (definitionSnapshot.tunnels || []).forEach(record => {
            (record?.buildingIds || []).forEach(id => { if (id) alreadyTunnelledIds.add(String(id)); });
        });
        (definition.demolishedBuildings || []).forEach(record => {
            if (!record.remainder) fullyDemolishedIds.add(String(record.id));
        });
        const dragCutIds = new Set((definition.demolishedBuildings || []).filter(record => record.remainder).map(record => String(record.id)));
        // Only edges the edit INTRODUCED can newly collide with a building. Everything that was
        // already part of the road before this edit was accepted when it was drawn — bulldozing
        // a stretch or tweaking the profile must never re-litigate the remaining geometry.
        const preEditEdgeKeys = new Set();
        if (typeof corridorTunnelEdgeKey === 'function') {
            ((typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(definitionSnapshot) : [])
                .forEach(segment => {
                    for (let i = 0; i < segment.length - 1; i++) {
                        const key = corridorTunnelEdgeKey(segment[i], segment[i + 1]);
                        if (key) preEditEdgeKeys.add(key);
                    }
                });
        }
        // Footprint coverage for the edit-introduced edges (same rule as drawing: detection
        // only sees loaded buildings).
        if (typeof window.ensureBuildingFootprintsForBounds === 'function') {
            for (let segIndex = 0; segIndex < normalizedSegments.length; segIndex++) {
                const segment = normalizedSegments[segIndex];
                for (let i = 0; i < segment.length - 1; i++) {
                    if (typeof corridorTunnelEdgeKey === 'function') {
                        const key = corridorTunnelEdgeKey(segment[i], segment[i + 1]);
                        if (preEditEdgeKeys.has(key) || tunnelEdgeKeys.has(key)) continue;
                    }
                    try {
                        await ensureBuildingFootprintsForRoadEdge(segment[i], segment[i + 1], editWidthForSegment(segIndex));
                    } catch (error) {
                        console.error('[road-drawing] footprint preload for edited edge failed', error);
                    }
                }
            }
        }
        const edgeHits = [];
        normalizedSegments.forEach((segment, segIndex) => {
            for (let i = 0; i < segment.length - 1; i++) {
                if (typeof corridorTunnelEdgeKey === 'function') {
                    const key = corridorTunnelEdgeKey(segment[i], segment[i + 1]);
                    // Pre-existing edges were accepted when drawn; tunnel edges are underground.
                    if (preEditEdgeKeys.has(key) || tunnelEdgeKeys.has(key)) continue;
                }
                const polygon = calculateRoadPolygon([segment[i], segment[i + 1]], editWidthForSegment(segIndex));
                if (!polygon) continue;
                const detected = detectLoadedBuildingTunnelIntersections(polygon)
                    .filter(hit => !fullyDemolishedIds.has(String(hit.id)));
                // Already-cut buildings extend their cut silently under the moved geometry.
                if (dragCutIds.size && typeof corridorFeatureFromLatLngRing === 'function' && typeof upsertCutRecord === 'function') {
                    const edgeRegion = corridorFeatureFromLatLngRing(polygon);
                    if (edgeRegion) {
                        detected.filter(hit => dragCutIds.has(String(hit.id)))
                            .forEach(hit => upsertCutRecord(definition.demolishedBuildings, hit, edgeRegion));
                    }
                }
                // Only genuinely new buildings reach the dialog: an already-cut (dragCutIds) or
                // already-tunnelled (alreadyTunnelledIds) building keeps its prior decision silently —
                // no re-ask, and for a tunnel no re-spliced portals, so a plain drag or extend stops
                // growing the centerline with fresh vertices.
                const hits = detected.filter(hit => !dragCutIds.has(String(hit.id)) && !alreadyTunnelledIds.has(String(hit.id)));
                if (hits.length) {
                    edgeHits.push({
                        from: segment[i],
                        to: segment[i + 1],
                        hits,
                        segmentIndex: segIndex,
                        pointIndex: i,
                        segmentId: Array.isArray(normalizedIds) ? (normalizedIds[segIndex] || null) : null
                    });
                }
            }
        });
        if (edgeHits.length || mergeProposalImpacts.length) {
            const combined = new Map();
            edgeHits.forEach(edge => edge.hits.forEach(hit => combined.set(String(hit.id), hit)));
            const resolution = await resolveBuildingObstacles(Array.from(combined.values()), editKind, {
                mergeProposalImpacts
            });
            if (resolution.action === 'cancel') {
                // Reroute: put the definition back exactly as it was and drop the edit. A node drag
                // has already streamed its live positions into `definition` and repainted the strips
                // there, so reverting the data is not enough — repaint from the restored geometry, or
                // the road (and its node handles) stay stuck at the abandoned drop position.
                Object.keys(definition).forEach(field => { delete definition[field]; });
                Object.assign(definition, definitionSnapshot);
                try {
                    proposal.definition = JSON.parse(JSON.stringify(definition));
                    proposal.geometry = { ...(proposal.geometry || {}), roadPlan: JSON.parse(JSON.stringify(definition)) };
                    if (definition.polygon) proposal.geometry.roadGeometry = { polygon: JSON.parse(JSON.stringify(definition.polygon)) };
                    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposal);
                } catch (_) { }
                try { ProposalManager._refreshUIAfterProposalChange?.(proposal); } catch (_) { }
                try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
                try { if (typeof refreshRoadNodeHandles === 'function') refreshRoadNodeHandles(); } catch (_) { }
                return false;
            }
            // Per-building outcomes (the tour can mix destroy/cut/tunnel across the affected set).
            if ((resolution.demolishedBuildings || []).length) {
                definition.demolishedBuildings = definition.demolishedBuildings || [];
                definition.demolishedBuildings.push(...resolution.demolishedBuildings);
            }
            if ((resolution.cutHits || []).length
                && typeof corridorFeatureFromLatLngRing === 'function' && typeof upsertCutRecord === 'function') {
                definition.demolishedBuildings = definition.demolishedBuildings || [];
                const cutIds = new Set(resolution.cutHits.map(hit => String(hit.id)));
                edgeHits.forEach(edge => {
                    const polygon = calculateRoadPolygon([edge.from, edge.to], editWidthForSegment(edge.segmentIndex));
                    const edgeRegion = polygon ? corridorFeatureFromLatLngRing(polygon) : null;
                    if (!edgeRegion) return;
                    edge.hits.filter(hit => hit.feature && cutIds.has(String(hit.id)))
                        .forEach(hit => upsertCutRecord(definition.demolishedBuildings, hit, edgeRegion));
                });
            }
            {
                const removedOwners = new Set(resolution.removedProposalIds || []);
                // End-backwards per segment so splicing portals never shifts pending edge indices.
                edgeHits.sort((a, b) => (a.segmentIndex - b.segmentIndex) || (b.pointIndex - a.pointIndex));
                edgeHits.forEach(edge => {
                    const standing = edge.hits.filter(hit => {
                        if (resolvedActionForHit(resolution, hit) !== 'tunnel') return false;
                        const owner = typeof corridorTunnelHitProposalId === 'function' ? corridorTunnelHitProposalId(hit) : null;
                        return !owner || !removedOwners.has(owner);
                    });
                    if (!standing.length) return;
                    definition.tunnels = definition.tunnels || [];
                    // Tunnel only while inside the buildings: portals become centerline vertices.
                    const plan = (typeof clipCorridorEdgeThroughBuildings === 'function')
                        ? clipCorridorEdgeThroughBuildings(edge.from, edge.to, standing, editWidthForSegment(edge.segmentIndex))
                        : null;
                    if (!plan) {
                        const record = (typeof makeBuildingTunnelRecord === 'function')
                            ? makeBuildingTunnelRecord(edge.from, edge.to, standing, { segmentId: edge.segmentId })
                            : null;
                        if (record && typeof addBuildingTunnelRecord === 'function') addBuildingTunnelRecord(definition.tunnels, record);
                        return;
                    }
                    const segment = normalizedSegments[edge.segmentIndex];
                    const interior = plan.slice(0, -1).map(sub => ({ lat: sub.to.lat, lng: sub.to.lng }));
                    segment.splice(edge.pointIndex + 1, 0, ...interior);
                    plan.forEach(sub => {
                        if (!sub.inside) return;
                        const record = (typeof makeBuildingTunnelRecord === 'function')
                            ? makeBuildingTunnelRecord(sub.from, sub.to, sub.hits, { segmentId: edge.segmentId })
                            : null;
                        if (record && typeof addBuildingTunnelRecord === 'function') addBuildingTunnelRecord(definition.tunnels, record);
                    });
                });
            }
            // 'merge' (no building hits) and a building choice with road merge impacts both proceed;
            // the already-disclosed road absorption is executed below.
        }
    }

    // Merge-on-connect works on drags too: if the moved geometry now touches other local
    // corridors of the same kind, they are absorbed into this road before crossings and
    // connectivity are worked out. The oldest body donates only its NAME — every absorbed
    // segment keeps its own cross-section (a collector stays wide, its side street narrow).
    let mergedName = null;
    if (touchingRoads.length) {
        const bodies = [proposal, ...touchingRoads];
        bodies.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const oldest = bodies[0];
        if (oldest !== proposal) {
            mergedName = oldest.title || oldest.name || null;
        }
        let mintedMergeId = 1;
        for (const target of touchingRoads) {
            const targetDefinition = target.roadProposal.definition;
            const targetEntries = (typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(targetDefinition) : [];
            (corridorCenterlineOf(targetDefinition) || []).forEach((segment, index) => {
                if (segment.length < 2) return;
                normalizedSegments.push(segment.map(point => ({ lat: point.lat, lng: point.lng })));
                // Segment ids collide across roads: mint a fresh id on clash so the absorbed
                // segment's profile override follows ITS geometry, not someone else's.
                const requested = Array.isArray(targetDefinition.segmentIds) ? (targetDefinition.segmentIds[index] || null) : null;
                let finalId = requested;
                while (!finalId || normalizedIds.includes(finalId)) {
                    finalId = `m${mintedMergeId++}`;
                    if (normalizedIds.includes(finalId)) finalId = null;
                }
                normalizedIds.push(finalId);
                const entryProfile = targetEntries[index]?.profile;
                if (entryProfile) {
                    definition.segmentProfiles = definition.segmentProfiles || {};
                    definition.segmentProfiles[String(finalId)] = JSON.parse(JSON.stringify(entryProfile));
                }
            });
            (targetDefinition.tunnels || []).forEach(tunnel => {
                definition.tunnels = definition.tunnels || [];
                definition.tunnels.push(JSON.parse(JSON.stringify(tunnel)));
            });
            // Carry the absorbed road's grade-separation and demolition decisions too, exactly as the
            // finish-path merge does (absorbConnectedLocalCorridors). A drag-time merge was dropping
            // them, silently losing the other road's bridged crossings and razed buildings.
            (targetDefinition.gradeSeparations || []).forEach(record => {
                definition.gradeSeparations = definition.gradeSeparations || [];
                definition.gradeSeparations.push(JSON.parse(JSON.stringify(record)));
            });
            (targetDefinition.demolishedBuildings || []).forEach(record => {
                definition.demolishedBuildings = definition.demolishedBuildings || [];
                definition.demolishedBuildings.push(JSON.parse(JSON.stringify(record)));
            });
            const targetKey = (typeof getProposalKey === 'function' ? getProposalKey(target) : null) || target.proposalId;
            clearSelectionVisualsForRemovedProposal(target);
            try { await ProposalManager.unapplyProposal(targetKey, { skipConfirm: true, skipRestoreSource: true }); } catch (_) { }
            try { proposalStorage.removeProposal(targetKey); } catch (_) { }
        }
        if (mergedName) {
            proposal.title = mergedName;
            proposal.name = mergedName;
            proposal.proposalName = mergedName;
        }
        const rewelded = weldCorridorSegments(normalizedSegments, normalizedIds, definition.segmentProfiles || null);
        normalizedSegments.length = 0;
        normalizedSegments.push(...rewelded.segments);
        normalizedIds.length = 0;
        normalizedIds.push(...rewelded.segmentIds);
        if (typeof updateStatus === 'function') {
            const firstName = touchingRoads[0].title || touchingRoads[0].name || 'road';
            updateStatus(translateRoadText('panel.road.mergedStatus', 'Connected to “{{name}}” — now one road.', { name: mergedName || firstName }));
        }
    }

    // A dragged node dropped near another vertex is welded onto it (they become one shared node), and
    // an endpoint that came to rest just short of another stretch's centerline is snapped onto it — so
    // a move can FORM a junction (not only preserve existing ones) before crossings are noded and
    // connectivity is judged. Welding also erases any near-duplicate a drag/weld may have left behind.
    if (typeof weldNearbyVertices === 'function') weldNearbyVertices(normalizedSegments);
    if (typeof healNearMissJunctions === 'function') healNearMissJunctions(normalizedSegments);
    normalizeCorridorGraph(
        normalizedSegments,
        normalizedIds,
        corridorProtectedEdgeKeySet(definition.tunnels, definition.gradeSeparations),
        definition.segmentProfiles || null
    );

    // Re-carve this road's own demolitions at the MOVED geometry: drop the stale records (restoring
    // those buildings) and re-carve whichever the new footprint still crosses. A demolished building
    // is filtered out of the global detection pool the moment it has a record, so this can't go
    // through detectLoadedBuildingTunnelIntersections — it re-carves directly from each record's own
    // stored footprint against the road's WHOLE new footprint in one pass. Doing it whole (not
    // edge-by-edge) means a building crossed by several converging legs gets one correct combined cut,
    // and upsertCutRecord derives cut-vs-full-demolition afresh at the new position. Runs on the full
    // welded network (before the component split) so a cut migrating onto a split-off piece is
    // redistributed to it by the split below.
    if (priorDemolitionIds.size && typeof upsertCutRecord === 'function') {
        const recutWidths = normalizedSegments.map((_, segIndex) => {
            const id = Array.isArray(normalizedIds) ? normalizedIds[segIndex] : null;
            const override = (definition.segmentProfiles && id !== null && id !== undefined)
                ? definition.segmentProfiles[String(id)] : null;
            const overrideWidth = override && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(override) : 0;
            return overrideWidth > 0 ? overrideWidth : (Number(definition.width) || 10);
        });
        // Tunnelled spans acquire nothing at the surface, so a building under a tunnel must not be
        // re-carved — cut only against the surface runs when this road tunnels anywhere.
        const cutSegments = (Array.isArray(definition.tunnels) && definition.tunnels.length && typeof corridorSurfaceRuns === 'function')
            ? corridorSurfaceRuns(normalizedSegments, definition.tunnels)
            : normalizedSegments;
        const cutWidths = cutSegments === normalizedSegments
            ? recutWidths
            : cutSegments.map(() => Number(definition.width) || 10);
        const unionPolygon = buildRoadUnionPolygonWithWidths(cutSegments, cutWidths, Number(definition.width) || 10);
        const roadGeo = unionPolygon ? convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(unionPolygon)) : null;
        // Only touch the records if we have a valid new footprint to re-carve against: dropping them
        // first and then failing to build the region would silently un-cut every building (over-heal).
        if (roadGeo && roadGeo.type) {
            definition.demolishedBuildings = (definition.demolishedBuildings || [])
                .filter(record => !(record && priorDemolitionIds.has(String(record.id))));
            const regionFeature = { type: 'Feature', properties: {}, geometry: roadGeo };
            priorRoadDemolitions.forEach(prior => {
                const footprintFeature = { type: 'Feature', properties: {}, geometry: prior.geometry };
                try {
                    if (typeof turf !== 'undefined' && typeof turf.booleanIntersects === 'function'
                        && !turf.booleanIntersects(footprintFeature, regionFeature)) return;
                } catch (_) { }
                upsertCutRecord(definition.demolishedBuildings, { id: prior.id, feature: footprintFeature }, regionFeature);
            });
        } else {
            console.warn('[updateLocalCorridorGeometry] Could not rebuild the road footprint — leaving building cuts at their previous position.');
        }
    }

    const components = corridorConnectedComponents(normalizedSegments, normalizedIds);
    const splitOff = components.slice(1);
    definition.points = components[0].segments;
    definition.segments = components[0].segments;
    definition.segmentIds = components[0].segmentIds;
    if (definition.segmentProfiles) {
        const liveIds = new Set((definition.segmentIds || []).filter(Boolean).map(String));
        Object.keys(definition.segmentProfiles).forEach(id => {
            if (!liveIds.has(id)) delete definition.segmentProfiles[id];
        });
    }

    // Rebuild the footprint from the (possibly moved) centerline at per-segment widths.
    const segments = definition.points;
    if (segments.length) {
        const unionPolygon = buildRoadUnionPolygonForDefinition(definition);
        const latLngPairs = convertRoadPolygonToLatLngPairs(unionPolygon);
        const geoPolygon = convertLatLngPairsToGeoJSON(latLngPairs);
        if (geoPolygon && geoPolygon.type && Array.isArray(geoPolygon.coordinates)) {
            definition.polygon = geoPolygon;
            definition.latLngPairs = latLngPairs;
        }
        attachCorridorSurfaceFootprint(definition);
    }

    // Mirror the definition everywhere the proposal stores it.
    try {
        const copy = JSON.parse(JSON.stringify(definition));
        proposal.definition = copy;
        proposal.geometry = { ...(proposal.geometry || {}), roadPlan: JSON.parse(JSON.stringify(definition)) };
        if (definition.polygon) proposal.geometry.roadGeometry = { polygon: JSON.parse(JSON.stringify(definition.polygon)) };
    } catch (_) { }
    try {
        if (typeof proposalStorage !== 'undefined') {
            if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposal);
            if (typeof proposalStorage.save === 'function') proposalStorage.save();
        }
    } catch (_) { }

    // Re-place the object so its parcel cuts and cross-section follow the new geometry.
    const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
    const wasSelected = typeof window.ProposalSelection?.is === 'function' && window.ProposalSelection.is(key);
    try {
        const wasApplied = (typeof isProposalApplied === 'function') ? isProposalApplied(proposal) : true;
        if (wasApplied) {
            // skipRestoreSource: this unapply is half of an unapply→re-apply of the SAME proposal;
            // restoring its replaced ancestor here would leave that ancestor applied underneath.
            await ProposalManager.unapplyProposal(key, { skipConfirm: true, skipRestoreSource: true });
            // With the old cuts undone, the original parcel fabric is back — re-derive which
            // parcels the moved/widened corridor actually touches now, so the re-apply cuts
            // every parcel under the new footprint (not just the ones declared at draw time).
            // The intersection test only sees LOADED parcels, so a declared parent is dropped
            // only when its layer is loaded and provably no longer touched; parents outside
            // the current view stay declared — otherwise their slices ghost forever.
            const acquisitionPolygon = (Array.isArray(definition.tunnels) && definition.tunnels.length)
                ? corridorSurfaceFootprintForDefinition(definition)
                : definition.polygon;
            if (acquisitionPolygon) {
                const touched = new Set(collectParcelsIntersectingFootprint(acquisitionPolygon));
                const keptUnloaded = (proposal.roadProposal.parentParcelIds || proposal.parentParcelIds || [])
                    .map(String)
                    .filter(id => !touched.has(id)
                        && !(window.parcelLayerById instanceof Map && window.parcelLayerById.has(id)));
                const touchedIds = [...touched, ...keptUnloaded];
                if (touchedIds.length) {
                    proposal.parentParcelIds = touchedIds.slice();
                    proposal.roadProposal.parentParcelIds = touchedIds.slice();
                    try {
                        if (typeof proposalStorage !== 'undefined') {
                            if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposal);
                            if (typeof proposalStorage.save === 'function') proposalStorage.save();
                        }
                    } catch (_) { }
                }
            }
            await ProposalManager.applyProposal(key, { applyAnyway: true, suppressMissingParentAlerts: true });
        }

        // Split-on-disconnect (the inverse of merge-on-connect): components the edit severed
        // become their own proposals, each applied in place.
        for (const component of splitOff) {
            await createRoadProposalFromComponent(proposal, component);
        }
        if (splitOff.length && typeof updateStatus === 'function') {
            updateStatus(translateRoadText('panel.road.splitStatus', 'The road came apart — now {{count}} separate roads.', {
                count: splitOff.length + 1
            }));
        }

        ProposalManager._refreshUIAfterProposalChange?.(proposal);
        // The selection overlay (blue outline + parcel highlight) was drawn from the OLD
        // geometry — rebuild it, or the previous footprint lingers on the map.
        if (wasSelected) {
            try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
            try {
                if (typeof selectAndHighlightProposal === 'function') {
                    window.__openProposalDetailsCollapsed = true;
                    selectAndHighlightProposal(key, null, false, true);
                }
            } catch (_) { }
        }
    } catch (error) {
        console.warn('[updateLocalCorridorGeometry] Re-apply after geometry change failed', error);
        // Roll the definition back: without this the strips redraw from the mutated centerline
        // while the parcel fabric stays untouched — the segment LOOKS bulldozed/moved but the
        // underlying parcels never come back.
        try {
            Object.keys(definition).forEach(field => { delete definition[field]; });
            Object.assign(definition, JSON.parse(JSON.stringify(definitionSnapshot)));
            proposal.definition = JSON.parse(JSON.stringify(definition));
            proposal.geometry = { ...(proposal.geometry || {}), roadPlan: JSON.parse(JSON.stringify(definition)) };
            if (definition.polygon) proposal.geometry.roadGeometry = { polygon: JSON.parse(JSON.stringify(definition.polygon)) };
            if (typeof proposalStorage !== 'undefined') {
                if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposal);
                if (typeof proposalStorage.save === 'function') proposalStorage.save();
            }
            ProposalManager._refreshUIAfterProposalChange?.(proposal);
        } catch (_) { }
        if (typeof updateStatus === 'function') {
            updateStatus(translateRoadText('panel.road.editRevertedStatus', 'Could not complete that road change — reverted.'));
        }
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Snapping — how road segments get connected to one another.
//
// Clicking within ROAD_SNAP_PIXELS of an existing vertex reuses that exact vertex, so the two
// segments share a node (OSM's only notion of connectivity). Clicking near the *middle* of an
// existing segment inserts a node there first, turning it into a shared node — an OSM T-join.
// Clicking near a segment's *endpoint* before drawing has started resumes that segment instead of
// starting a new one, which is how a road drawn in an earlier session gets continued.
// ---------------------------------------------------------------------------
// Touch fingers land ~2× less precisely than a cursor — with the mouse-calibrated 12 px,
// mobile users constantly missed node snaps and built near-miss disconnected junctions.
const ROAD_SNAP_PIXELS = (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) ? 26 : 12;
let roadSnapMarker = null;

// Closest point to `p` on the pixel segment ab, clamped to the segment.
// projectPointOnPixelSegment + the snap priority ladder (pickSnapTarget) moved to
// frontend/js/corridor-geometry.js (loaded first) — pure pixel-space geometry, now unit-tested.

// Nearest snap candidate to `latlng`, or null. Vertices win over edges: a click near a corner should
// join that corner rather than plant a second node a few centimetres along one of its edges.
// Applied corridors are snap targets too: connecting a new stroke to a placed road needs the
// click to land exactly on its centerline, so the footprints truly touch and finishing merges
// the bodies (or forms a junction with a minted one).
function appliedCorridorSnapSegments() {
    const entries = [];
    try {
        (proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            const proposalId = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
            const minted = typeof isProposalMinted === 'function' && isProposalMinted(proposal);
            (corridorCenterlineOf(definition) || []).forEach(segment => {
                if (Array.isArray(segment) && segment.length >= 2) entries.push({ segment, proposalId, minted });
            });
        });
    } catch (_) { }
    return entries;
}

function findRoadSnapTarget(latlng) {
    if (typeof map === 'undefined' || !map || !latlng) return null;
    const cursor = map.latLngToLayerPoint(latlng);
    const cursorPx = { x: cursor.x, y: cursor.y };
    const activeIndex = roadHasStarted ? roadSegments.indexOf(roadPoints) : -1;

    // Project every candidate vertex to screen pixels; the pure ladder decides the winner.
    const toPx = (v) => { const pt = map.latLngToLayerPoint(v); return { x: pt.x, y: pt.y }; };
    const localSegments = roadSegments.map(seg => (Array.isArray(seg) ? seg : []).map(toPx));
    const externalEntries = appliedCorridorSnapSegments();
    const externalSegments = externalEntries.map(e => ({ points: e.segment.map(toPx) }));

    const raw = window.CorridorGeometry.pickSnapTarget(
        cursorPx, localSegments, externalSegments, activeIndex, ROAD_SNAP_PIXELS
    );
    if (!raw) return null;

    // Resolve the pixel result back to a latlng and the original return shape. Vertex snaps reuse
    // the exact original vertex latlng; edge snaps unproject the projected pixel point.
    const pixelToLatLng = (px) => map.layerPointToLatLng(L.point(px.x, px.y));

    if (raw.source === 'local') {
        if (raw.kind === 'edge') {
            return { distance: raw.distance, latlng: pixelToLatLng(raw.pixel), segmentIndex: raw.segmentIndex, insertAfter: raw.insertAfter, type: 'edge' };
        }
        const vertex = roadSegments[raw.segmentIndex][raw.vertexIndex];
        return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), segmentIndex: raw.segmentIndex, vertexIndex: raw.vertexIndex, type: raw.kind, atStart: raw.atStart };
    }

    const entry = externalEntries[raw.externalIndex];
    if (raw.kind === 'external-edge') {
        return { distance: raw.distance, latlng: pixelToLatLng(raw.pixel), type: 'external-edge', proposalId: entry.proposalId, minted: entry.minted };
    }
    const vertex = entry.segment[raw.vertexIndex];
    return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), type: raw.kind, proposalId: entry.proposalId, minted: entry.minted };
}

// When a proposal is removed by an absorb/merge while it is the SELECTED one, its selection
// visuals must go with it — otherwise the blue parcel highlights and the details panel stay
// orphaned on screen (the proposal no longer exists). Key-based, like the delete path.
function clearSelectionVisualsForRemovedProposal(proposalOrKey) {
    const selection = (typeof window !== 'undefined') ? window.ProposalSelection : null;
    // The selection API normalizes ids/hashes/objects itself — string comparison alone
    // missed on key-format differences and left the blue highlight alive after an absorb.
    let matches = !!(selection && typeof selection.is === 'function' && selection.is(proposalOrKey));
    if (!matches) {
        const key = (typeof proposalOrKey === 'object' && proposalOrKey !== null)
            ? (((typeof getProposalKey === 'function') ? getProposalKey(proposalOrKey) : null) || proposalOrKey.proposalId)
            : proposalOrKey;
        const selectedKey = selection?.getKey?.() || window.currentlyHighlightedProposal?.proposalId || null;
        matches = !!(selectedKey && key && String(selectedKey) === String(key));
    }
    if (!matches) return;
    try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
    try { window.ProposalSelection?.clear?.(); } catch (_) { }
    try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }
    // The amber marching-ants segment highlight belongs to that selection — drop it too.
    try {
        window.corridorLastClickedSegment = null;
        window.refreshSelectedCorridorSegmentHighlight?.();
    } catch (_) { }
}

function clearRoadSnapMarker() {
    if (roadSnapMarker && typeof map !== 'undefined' && map && map.hasLayer(roadSnapMarker)) {
        map.removeLayer(roadSnapMarker);
    }
    roadSnapMarker = null;
}

function showRoadSnapMarker(snap) {
    const latlng = snap && snap.latlng ? snap.latlng : null;
    if (!latlng) {
        clearRoadSnapMarker();
        return;
    }
    // Snapping onto a PLACED road (connect + merge) reads differently from snapping onto the
    // drawing's own segments: a bigger blue ring says "click to attach to this road".
    const external = snap.type === 'external-endpoint' || snap.type === 'external-node' || snap.type === 'external-edge';
    const style = external
        ? { radius: 11, color: '#2563eb', weight: 3, fillColor: '#ffffff', fillOpacity: 0.9 }
        : { radius: 8, color: '#006400', weight: 2, fillColor: '#ffffff', fillOpacity: 0.9 };
    if (roadSnapMarker) {
        roadSnapMarker.setLatLng(latlng);
        try {
            roadSnapMarker.setStyle(style);
            roadSnapMarker.setRadius(style.radius);
        } catch (_) { }
        return;
    }
    // Its own pane above the corridor strips and hit targets — a snap ring under the asphalt
    // is invisible exactly when it matters (snapping onto a road).
    if (!map.getPane('road-snap')) {
        map.createPane('road-snap').style.zIndex = 675;
    }
    roadSnapMarker = L.circleMarker(latlng, { ...style, interactive: false, pane: 'road-snap' }).addTo(map);
}

function createRoadVertexMarker(latlng) {
    const marker = L.circleMarker(latlng, {
        radius: 5,
        color: 'green',
        fillColor: '#00ff00',
        fillOpacity: 1
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

function clearRoadStripLayer() {
    if (roadStripLayer && map.hasLayer(roadStripLayer)) map.removeLayer(roadStripLayer);
    roadStripLayer = null;
}

function redrawRoadStrips() {
    clearRoadStripLayer();
    // Without a cross-section the corridor keeps its plain green fill; with one, the fill would hide
    // the strips, so the corridor becomes an outline around them.
    const restoreCorridorFill = () => {
        if (roadPolygonLayer) roadPolygonLayer.setStyle({ fillOpacity: 0.3 });
    };
    if (!roadProfile || typeof buildCorridorStrips !== 'function') return restoreCorridorFill();

    // Per-segment: an absorbed road keeps ITS cross-section while being part of the drawing;
    // only segments without an override use the tool profile.
    const entries = getAllRoadSegments(true)
        .map((segment, index) => ({ points: segment, profile: roadDrawingSegmentOverride(index) || roadProfile }))
        .filter(entry => Array.isArray(entry.points) && entry.points.length >= 2);
    if (!entries.length) return restoreCorridorFill();

    // Same renderer as applied corridors — see js/corridor-render.js.
    const group = L.layerGroup();
    let drewAny = false;
    entries.forEach(entry => {
        const strips = buildCorridorStrips([entry.points], entry.profile);
        if (!strips.length) {
            // A drawn segment with no strips renders as a bare dashed centerline — never
            // acceptable silently. Say WHY so field reports become diagnosable.
            console.error('[road-drawing] no strips for a drawn segment', { points: entry.points.length, profile: entry.profile });
            return;
        }
        const markings = (typeof buildCorridorLaneMarkings === 'function') ? buildCorridorLaneMarkings([entry.points], entry.profile) : [];
        // Trees only — bike/pedestrian lane explainers stay out of the map (cross-section
        // editor is the reference for lane meaning).
        const decorations = ((typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations([entry.points], entry.profile) : [])
            .filter(decoration => decoration.kind === 'tree');
        const segmentLayer = renderCorridorStrips(strips, {
            markings, decorations, junctions: [],
            // Rails come with the cross-section: a rail lane in the profile being drawn lays its track
            // right there on the map, so a track is drawn as a track from the first click.
            centerlines: [entry.points], profile: entry.profile
        });
        if (segmentLayer) {
            segmentLayer.addTo(group);
            drewAny = true;
        }
    });
    if (!drewAny) return restoreCorridorFill();
    const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
        ? buildCorridorJunctionTreatmentsForEntries(entries)
        : [];
    if (junctions.length && typeof renderCorridorJunctions === 'function') {
        renderCorridorJunctions(junctions, group, undefined);
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
        // The rail engineering limits ride along with any corridor that carries a track.
        trackSpeed,
        trackMinRadius: trackMinCurvatureRadius,
        tunnels: JSON.parse(JSON.stringify(roadBuildingTunnels || [])),
        gradeSeparations: JSON.parse(JSON.stringify(roadGradeSeparations || [])),
        demolishedBuildings: JSON.parse(JSON.stringify(roadDemolishedBuildings || [])),
        // Structures (parks/lakes/squares) the user approved building through — persisted so continuing
        // this road never re-asks about a structure it already runs through (seeded back on continue).
        approvedStructures: (typeof getApprovedStructureIds === 'function') ? getApprovedStructureIds() : [],
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
    const parentParcelIds = (Array.isArray(roadAffectedParcels) ? roadAffectedParcels : [])
        .map(parcel => getParcelIdFromAny(parcel))
        .filter(Boolean)
        .map(String);
    const saved = saveActiveCorridorDraft({
        draftId: (copySource && copySource.draftId) || window.activeProposalDesignDraftId || null,
        kind,
        cityId: currentCorridorDraftCityId(),
        seed,
        copySource,
        parentParcelIds,
        sourceProposalId: copySource && copySource.proposalId ? String(copySource.proposalId) : null
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
    const sidewalks = roadProfile.strips.filter(strip => strip.type === 'sidewalk');
    roadSidewalkWidth = sidewalks.length
        ? sidewalks.reduce((sum, strip) => sum + strip.width, 0) / sidewalks.length
        : 0;
    window.roadSidewalkWidth = roadSidewalkWidth;
    // The next R-press starts at this width (there is no width picker any more). Only a ROAD's width is
    // remembered: a track is seeded from its gauge, so letting a 3.5 m tram line become the next road's
    // width would be remembering the wrong thing.
    if (!corridorDrawingIsTrack()) {
        try {
            PersistentStorage.setItem('lastRoadWidth', String(roadWidth));
            PersistentStorage.setItem('lastSidewalkWidth', String(roadSidewalkWidth));
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

function updateRoadCrossSectionButton() {
    const button = document.getElementById('editRoadCrossSectionButton');
    if (!button) return;
    const width = button.querySelector('.road-cross-section-width');
    if (width) width.textContent = roadProfile ? ` · ${Number(corridorProfileWidth(roadProfile).toFixed(1))} m` : '';
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

    const updatedPolygon = buildRoadUnionPolygonWithWidths(
        centerlinePoints,
        centerlinePoints.map((_, index) => roadDrawingWidthForSegmentIndex(index)),
        roadWidth
    );
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
    if (Number.isFinite(Number(seed.sidewalkWidth))) {
        roadSidewalkWidth = Number(seed.sidewalkWidth);
        if (typeof window !== 'undefined') window.roadSidewalkWidth = roadSidewalkWidth;
    }
    if (Number.isFinite(Number(seed.trackSpeed))) trackSpeed = Number(seed.trackSpeed);
    if (Number.isFinite(Number(seed.trackMinRadius))) trackMinCurvatureRadius = Number(seed.trackMinRadius);

    // A corridor drawn before profiles existed gets one synthesised from its width, so reopening it never
    // silently changes its footprint: the profile always sums back to the width it was drawn with. That
    // includes an old track — one rail lane as wide as the track was drawn.
    roadProfile = normalizeCorridorProfile(seed.profile)
        || corridorProfileFromLegacy(roadWidth, roadSidewalkWidth, corridorDrawKind === 'track');
    if (roadProfile) roadWidth = corridorProfileWidth(roadProfile);

    roadSegments = [];
    roadSegmentIds = [];
    roadPoints = [];
    roadHasStarted = false;
    roadBuildingTunnels = Array.isArray(seed.tunnels) ? JSON.parse(JSON.stringify(seed.tunnels)) : [];
    roadGradeSeparations = Array.isArray(seed.gradeSeparations) ? JSON.parse(JSON.stringify(seed.gradeSeparations)) : [];
    roadDemolishedBuildings = Array.isArray(seed.demolishedBuildings) ? JSON.parse(JSON.stringify(seed.demolishedBuildings)) : [];
    // Re-approve the structures this road already builds through (reset cleared the session set just
    // before this seed) — so continuing the road never re-prompts about a park/lake/square it crosses.
    if (typeof seedApprovedStructureCrossings === 'function') seedApprovedStructureCrossings(seed.approvedStructures);
    roadSegmentProfiles = (seed.segmentProfiles && typeof seed.segmentProfiles === 'object')
        ? JSON.parse(JSON.stringify(seed.segmentProfiles))
        : {};
    cachedCommittedPolygon = null;

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

// Continue an existing segment from one of its two ends. Drawing always appends to the end of the
// active array, so when the user grabs the *first* vertex we reverse the segment in place; a segment
// has no direction of its own, and the array is the same object `roadSegments` holds.
function resumeRoadSegment(segmentIndex, atStart) {
    const segment = roadSegments[segmentIndex];
    if (!Array.isArray(segment) || !segment.length) return false;
    if (atStart && segment.length > 1) segment.reverse();
    roadPoints = segment;
    roadHasStarted = true;
    roadStrokeBaseCount = roadPoints.length; // Esc cancels only what this stroke adds
    return true;
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
    segment.splice(insertAfter + 1, 0, L.latLng(latlng.lat, latlng.lng));
    if (tunnel && typeof removeBuildingTunnelEdge === 'function' && typeof makeBuildingTunnelRecord === 'function') {
        roadBuildingTunnels = removeBuildingTunnelEdge(roadBuildingTunnels, from, to);
        const hits = (tunnel.buildingIds || []).map(id => ({ id }));
        const segmentId = roadSegmentIds[segmentIndex] || tunnel.segmentId || null;
        addBuildingTunnelRecord(roadBuildingTunnels, makeBuildingTunnelRecord(from, latlng, hits, { segmentId }));
        addBuildingTunnelRecord(roadBuildingTunnels, makeBuildingTunnelRecord(latlng, to, hits, { segmentId }));
        refreshRoadBuildingTunnelLayer();
    }
    return true;
}

function computeRoadMetricsFromSegments(segments, width) {
    const validSegments = (segments || []).filter(seg => Array.isArray(seg) && seg.length >= 2);
    if (!validSegments.length) {
        return { polygon: null, length: 0, area: 0 };
    }

    const length = validSegments.reduce((sum, seg) => sum + calculateSegmentLengthMeters(seg), 0);
    const polygon = buildRoadUnionPolygonFromSegments(validSegments, width);
    const area = polygon ? calculatePolygonAreaMeters(polygon) : 0;
    return { polygon, length, area };
}

function isRoadWalletConnected() {
    const wm = window.walletManager;
    if (!wm || typeof wm.getState !== 'function') {
        return false;
    }
    const state = wm.getState();
    return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length > 0;
}

async function ensureRoadWalletReady() {
    if (isRoadWalletConnected()) {
        return { connected: true, proceedInMemory: false };
    }

    const wm = window.walletManager;
    if (wm && typeof wm.tryAutoConnect === 'function') {
        try {
            await wm.tryAutoConnect();
        } catch (_) {
            // Silent auto-connect attempt failure is fine; fall back to in-memory creation.
        }
        if (isRoadWalletConnected()) {
            return { connected: true, proceedInMemory: false };
        }
    }

    return { connected: false, proceedInMemory: true };
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

function getParcelIdFromAny(parcel) {
    if (!parcel) return null;
    const fromFeature = parcel.feature ? getRoadDrawingParcelIdFromFeature(parcel.feature) : null;
    const fromLayerFeature = parcel.layer?.feature ? getRoadDrawingParcelIdFromFeature(parcel.layer.feature) : null;
    const fromProps = parcel.properties ? ensureParcelId(parcel.properties) : null;
    const raw = parcel.id ?? parcel.parcelId;
    const candidate = fromFeature || fromLayerFeature || fromProps || getParcelId(raw);
    return candidate ? candidate.toString() : null;
}

function setRoadParcelStats(countValue, areaText = '—') {
    const countEl = document.getElementById('road-parcels-count');
    const areaEl = document.getElementById('road-parcels-area');
    if (countEl) countEl.textContent = typeof countValue === 'number' ? countValue.toString() : (countValue || '—');
    if (areaEl) areaEl.textContent = areaText || '—';
}

function formatParcelArea(area) {
    if (!Number.isFinite(area) || area <= 0) return '—';
    return `${Math.round(area).toLocaleString('hr-HR')} m²`;
}

function resetRoadMetricPlaceholders() {
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

function normalizeParcelOwnershipType(type) {
    const value = (type || '').toString().toLowerCase();
    if (value === 'mixed') return 'mixed';
    if (value.includes('gov') || value.includes('state') || value.includes('city') || value.includes('municip')) return 'government';
    if (value.includes('institution') || value.includes('university') || value.includes('school') || value.includes('hospital') || value.includes('church')) return 'institution';
    if (value.includes('company') || value.includes('business') || value.includes('corp') || value.includes('llc') || value.includes('gmbh') || value.includes('d.o.o') || value.includes('d.o.o.') || value.includes('d.d') || value.includes('d.d.') || value.includes('inc') || value.includes('sa') || value.includes('spa')) {
        return 'company';
    }
    return 'individual';
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

function getMarketPrice(parcelId, currency) {
    // For now, ignore currency parameter
    // Find the parcel in roadAffectedParcels or roadPreviewAffectedParcels
    const targetId = getParcelId(parcelId);
    if (!targetId) return 0;

    let parcel = roadAffectedParcels.find(p => getParcelIdFromAny(p) === targetId);
    if (!parcel) {
        parcel = roadPreviewAffectedParcels.find(p => getParcelIdFromAny(p) === targetId);
    }

    // Check for precalculated estimatedMarketPrice first
    if (parcel) {
        const estimatedPrice = parcel.estimatedMarketPrice ||
            parcel.properties?.estimatedMarketPrice ||
            parcel.layer?.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            return estimatedPrice;
        }
    }

    // Fallback: try to get from layer
    if (parcelLayer) {
        let foundLayer = null;
        parcelLayer.eachLayer(layer => {
            const layerId = getRoadDrawingParcelIdFromFeature(layer.feature);
            if (layerId && layerId.toString() === targetId.toString()) {
                foundLayer = layer;
            }
        });

        if (foundLayer) {
            // Check for precalculated estimatedMarketPrice in layer properties
            const estimatedPrice = foundLayer.feature.properties.estimatedMarketPrice;
            if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
                return estimatedPrice;
            }

            // Fallback to area calculation
            const area = Number(foundLayer.feature.properties.calculatedArea) || 0;
            return area * 100;
        }
    }

    // If found in arrays but no estimatedMarketPrice, use stored area
    if (parcel && Number.isFinite(parcel.area)) {
        return parcel.area * 100;
    }

    return 0;
}

function updateRoadMarketPrice(parcels) {
    const parcelsList = Array.isArray(parcels) ? parcels : [];
    const marketEl = document.getElementById('road-market-price');
    if (!marketEl) return;

    if (parcelsList.length === 0) {
        marketEl.textContent = '—';
        return;
    }

    const totalPrice = parcelsList.reduce((sum, parcel) => {
        // Check for precalculated estimatedMarketPrice first
        const estimatedPrice = parcel?.estimatedMarketPrice ||
            parcel?.properties?.estimatedMarketPrice ||
            parcel?.layer?.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            return sum + estimatedPrice;
        }

        // Fallback: get parcel ID and use getMarketPrice
        const parcelId = getParcelIdFromAny(parcel);
        if (!parcelId) return sum;
        const price = getMarketPrice(parcelId);
        return sum + (Number.isFinite(price) ? price : 0);
    }, 0);

    marketEl.textContent = totalPrice > 0 ? Math.round(totalPrice).toLocaleString('hr-HR') : '—';
}

async function updateRoadAcquiringDifficulty(parcels) {
    const parcelsList = Array.isArray(parcels) ? parcels : [];
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (!difficultyEl) return;

    if (parcelsList.length === 0) {
        difficultyEl.textContent = '—';
        return;
    }

    // Ownership type coefficients
    const OWNERSHIP_COEFFICIENTS = {
        government: 0,
        institution: 0,
        company: 1,
        individual: 2,
        mixed: 2 // Mixed ownership defaults to individual difficulty (highest)
    };

    const hasOwnershipFn = typeof getOwnershipType === 'function';

    let totalDifficulty = 0;

    // Process parcels
    const parcelDifficulties = parcelsList.map((parcel) => {
        const parcelId = getParcelIdFromAny(parcel);
        if (!parcelId) return 0;

        // Get market price - check for precalculated estimatedMarketPrice first
        let marketPrice = 0;
        const estimatedPrice = parcel?.estimatedMarketPrice ||
            parcel?.properties?.estimatedMarketPrice ||
            parcel?.layer?.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            marketPrice = estimatedPrice;
        } else if (parcel && Number.isFinite(parcel.area)) {
            marketPrice = parcel.area * 100;
        } else {
            marketPrice = getMarketPrice(parcelId);
        }
        if (!Number.isFinite(marketPrice) || marketPrice <= 0) return 0;

        // Get ownership type from parcel feature properties (from GET /parcels/)
        let ownershipType = 'individual'; // default
        const featureProps = parcel.layer?.feature?.properties || parcel.properties || {};
        const ownershipList = featureProps.ownershipList || [];
        const ownershipTypeFromProps = featureProps.ownershipType;

        if (ownershipTypeFromProps) {
            ownershipType = normalizeParcelOwnershipType(ownershipTypeFromProps);
        } else if (Array.isArray(ownershipList) && ownershipList.length > 0 && hasOwnershipFn) {
            // Determine type from ownershipList if ownershipType not available
            const ownerTypes = ownershipList.map(owner => {
                const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                return normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
            }).filter(Boolean);
            const uniqueTypes = Array.from(new Set(ownerTypes.length ? ownerTypes : ['individual']));
            ownershipType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
        } else {
            // Check cache as fallback
            const cachedType = roadOwnershipTypeCache.get(parcelId);
            if (cachedType) {
                ownershipType = normalizeParcelOwnershipType(cachedType);
            }
        }

        // Calculate difficulty: market_price * coefficient
        const coefficient = OWNERSHIP_COEFFICIENTS[ownershipType] || OWNERSHIP_COEFFICIENTS.individual;
        return marketPrice * coefficient;
    });

    totalDifficulty = parcelDifficulties.reduce((sum, diff) => sum + diff, 0);

    difficultyEl.textContent = totalDifficulty > 0 ? Math.round(totalDifficulty).toLocaleString('hr-HR') : '—';
}

// Collect ownership and acquisition stats from the road info panel
function collectOwnershipAndAcquisitionStats() {
    const stats = {
        individualOwners: null,
        ownershipCounts: {
            individual: null,
            company: null,
            government: null,
            institution: null,
            mixed: null
        },
        totalMarketPrice: null,
        totalAcquiringDifficulty: null
    };

    // Get individual owners count
    const individualOwnersEl = document.getElementById('road-individual-owners');
    if (individualOwnersEl && individualOwnersEl.textContent !== '—') {
        const value = parseInt(individualOwnersEl.textContent, 10);
        if (Number.isFinite(value)) {
            stats.individualOwners = value;
        }
    }

    // Get ownership type counts
    Object.entries(ROAD_OWNERSHIP_TYPE_IDS).forEach(([type, elementId]) => {
        const el = document.getElementById(elementId);
        if (el && el.textContent !== '—') {
            const value = parseInt(el.textContent, 10);
            if (Number.isFinite(value)) {
                stats.ownershipCounts[type] = value;
            }
        }
    });

    // Get total market price
    const marketPriceEl = document.getElementById('road-market-price');
    if (marketPriceEl && marketPriceEl.textContent !== '—') {
        // Remove all non-digit characters (handles Croatian locale: spaces, dots, commas as thousand separators)
        // Since these are rounded integers from Math.round(), we don't need to preserve decimals
        const cleaned = marketPriceEl.textContent.replace(/\D/g, '');
        if (cleaned.length > 0) {
            const value = parseInt(cleaned, 10);
            if (Number.isFinite(value) && value >= 0) {
                stats.totalMarketPrice = value;
            }
        }
    }

    // Get total acquiring difficulty
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (difficultyEl && difficultyEl.textContent !== '—') {
        // Remove all non-digit characters (handles Croatian locale: spaces, dots, commas as thousand separators)
        const cleaned = difficultyEl.textContent.replace(/\D/g, '');
        if (cleaned.length > 0) {
            const value = parseInt(cleaned, 10);
            if (Number.isFinite(value) && value >= 0) {
                stats.totalAcquiringDifficulty = value;
            }
        }
    }

    // Return null if no stats were collected (all null)
    const hasAnyStats = stats.individualOwners !== null ||
        Object.values(stats.ownershipCounts).some(v => v !== null) ||
        stats.totalMarketPrice !== null ||
        stats.totalAcquiringDifficulty !== null;

    return hasAnyStats ? stats : null;
}

async function updateRoadOwnershipCounts(parcels) {
    const parcelsList = Array.isArray(parcels) ? parcels : [];
    const requestId = ++roadOwnershipStatsRequestId;

    if (parcelsList.length === 0) {
        setRoadOwnershipCounts(null);
        const ownerCountEl = document.getElementById('road-individual-owners');
        if (ownerCountEl) ownerCountEl.textContent = '—';
        return;
    }

    const hasOwnershipFn = typeof getOwnershipType === 'function';
    const typeCounts = { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 };
    let totalIndividualOwners = 0;

    const parcelData = parcelsList.map((parcel) => {
        const parcelId = getParcelIdFromAny(parcel);
        if (!parcelId) return { type: null, individualOwnerCount: 0 };

        // Get ownership data from parcel feature properties (from GET /parcels/)
        const featureProps = parcel.layer?.feature?.properties || parcel.properties || {};
        const ownershipList = featureProps.ownershipList || [];
        const ownershipType = featureProps.ownershipType;

        let parcelType = null;
        let individualOwnerCount = 0;

        // Use ownershipType from feature properties if available
        if (ownershipType) {
            parcelType = normalizeParcelOwnershipType(ownershipType);
        }

        // Count individual owners from ownershipList
        if (Array.isArray(ownershipList) && ownershipList.length > 0) {
            if (hasOwnershipFn) {
                // Use getOwnershipType function to determine owner types
                ownershipList.forEach(owner => {
                    const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                    const ownerType = normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
                    if (ownerType === 'individual') {
                        individualOwnerCount++;
                    }
                });
            } else {
                // Fallback: if no getOwnershipType function, count all as individuals
                individualOwnerCount = ownershipList.length;
            }

            // If we don't have ownershipType but have ownershipList, determine type
            if (!parcelType && hasOwnershipFn) {
                const ownerTypes = ownershipList.map(owner => {
                    const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                    return normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
                }).filter(Boolean);
                const uniqueTypes = Array.from(new Set(ownerTypes.length ? ownerTypes : ['individual']));
                parcelType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
            } else if (!parcelType) {
                // Default to individual if we can't determine
                parcelType = 'individual';
            }
        } else {
            // No ownership data available, use default
            if (!parcelType) {
                parcelType = 'individual';
            }
            individualOwnerCount = 1; // Assume single owner
        }

        // Cache the type for future use
        if (parcelType) {
            roadOwnershipTypeCache.set(parcelId, parcelType);
        }

        return { type: parcelType, individualOwnerCount };
    });

    if (requestId !== roadOwnershipStatsRequestId) {
        return;
    }

    parcelData.forEach(({ type, individualOwnerCount }) => {
        if (type) {
            const normalized = normalizeParcelOwnershipType(type);
            if (!typeCounts[normalized]) {
                typeCounts[normalized] = 0;
            }
            typeCounts[normalized] += 1;
        }
        totalIndividualOwners += individualOwnerCount;
    });

    setRoadOwnershipCounts(typeCounts);

    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = totalIndividualOwners > 0 ? totalIndividualOwners.toString() : '—';
    }
}

function closeProposalDetailsForDrawing() {
    const proposalPanel = document.getElementById('proposal-details-panel');
    if (proposalPanel && proposalPanel.classList.contains('visible')) {
        if (typeof hideProposalDetailsPanel === 'function') {
            hideProposalDetailsPanel(true);
        } else {
            proposalPanel.classList.remove('visible');
            if (typeof clearProposalHighlights === 'function') clearProposalHighlights();
        }
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.clearSelection === 'function') {
            try { multiParcelSelection.clearSelection(); } catch (_) { }
        }
    }
}

// Ensure multi-parcel selection is turned off when starting road/track drawing
function disableMultiSelectForDrawing() {
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection || !multiParcelSelection.isActive) {
        return;
    }
    try {
        if (typeof multiParcelSelection.toggle === 'function') {
            multiParcelSelection.toggle({ preserveSelectedParcel: false, restoreSingleSelection: false });
        } else {
            if (multiParcelSelection.selectedParcels?.clear) multiParcelSelection.selectedParcels.clear();
            multiParcelSelection.isActive = false;
            if (typeof multiParcelSelection.updateUI === 'function') multiParcelSelection.updateUI();
            if (typeof syncMultiSelectCheckboxes === 'function') syncMultiSelectCheckboxes(false);
        }
    } catch (_) { /* ignore */ }
}

// One panel serves both road and track drawing, so switching mode swaps the i18n KEY on each label —
// not just its text. Writing text alone left the road-mode key in place, so the next applyTranslations()
// (a language switch) would put the road wording back on a track panel, and any literal written here
// would survive untranslated in every language.
function setRoadPanelLabelsForMode(mode = 'road') {
    const isTrack = mode === 'track';
    const modeLabels = [
        ['road-panel-title', isTrack ? 'panel.road.titleTrack' : 'panel.road.title', isTrack ? 'Draw track' : 'Draw road'],
        ['finishRoadButton', isTrack ? 'panel.road.finishButtonShortTrack' : 'panel.road.finishButtonShort', isTrack ? 'Finish track (F)' : 'Finish road (F)'],
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
    if (roadDrawingMode) {
        // The other button while drawing: end this corridor, then open the tool on the other seed.
        const finished = await cancelRoadDrawing();
        if (kind === corridorDrawKind) return finished;
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
    // Build-through approvals for parks/squares/lakes last one drawing session only.
    if (typeof resetApprovedStructureCrossings === 'function') resetApprovedStructureCrossings();
    if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
        await ensureCorridorBuildingFootprintsLoaded();
    }
    corridorDrawKind = kind === 'track' ? 'track' : 'road';
    toggleRoadDrawTool();
    return true;
}

async function startSeededCorridorDrawing(kind, seed, copySource) {
    if (!seed) return false;
    if (roadDrawingMode) exitRoadDrawingMode();
    if (copySource?.draftId && window.proposalDraftStore?.getDraft(copySource.draftId)) {
        window.beginProposalDraftDesignSession?.(copySource.draftId);
    }
    if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
        await ensureCorridorBuildingFootprintsLoaded();
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
    // Gate: require personalized profile to draw corridors (which create proposals)

    updateGlobalRoadDrawingMode(!roadDrawingMode);
    const roadDrawButton = corridorDrawButton();

    if (roadDrawingMode) {
        disableMultiSelectForDrawing();
        setRoadPanelLabelsForMode(corridorDrawKind);
        closeProposalDetailsForDrawing();

        // Activate corridor drawing mode — the button the user pressed is the one that lights up.
        if (roadDrawButton) {
            roadDrawButton.classList.add('active');
            roadDrawButton.classList.add('active-black-border');
        }

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
        map.getContainer().style.cursor = 'crosshair';
        map.getContainer().classList.add('crosshairs-cursor');

        // Disable other tools and interactivity
        if (typeof measureMode !== 'undefined' && measureMode) toggleMeasureTool(); // Add check for measureMode existence

        // --- Robustly disable parcel interaction --- 
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.off('click'); // Remove all click listeners
            });
        }
        // --- End robust disable --- 

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
            if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
            updateRoadCrossSectionButton();
            updateUndoButtonState();
            map.on('click', handleRoadClick);
            map.on('mousemove', handleRoadMouseMove);
            map.on('mouseout', handleRoadMouseOut);
            document.addEventListener('keydown', handleRoadKeydown);
        };

        // Continuing an existing corridor: its geometry and cross-section are already decided, so the
        // tool reopens on it rather than on a seed. The seed is consumed once.
        const seed = (typeof window !== 'undefined') ? window.pendingRoadDrawingSeed : null;
        if (seed) {
            window.pendingRoadDrawingSeed = null;
            if (seedRoadDrawing(seed)) {
                activateRoadDrawing('Click a segment end to continue it, or click the map to draw a new one');
                return;
            }
        }

        // Collapse the sidebar so the map has room (the retired width picker used to do this).
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
            try { toggleSidebar(); } catch (_) { }
        }

        // A NEW TRACK starts as one standard-gauge track (3.5 m) and nothing else. Its width is the sum
        // of its lanes from here on: the cross-section editor adds a second track, a platform, a verge —
        // exactly as it adds a bus lane to a road. The rail speed limit picker comes first, because the
        // minimum curve radius it fixes constrains the very first click.
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
                activateRoadDrawing('Click on the map to start drawing a track');
            }).catch(() => {
                // Picker cancelled: the tool never opened.
                if (roadDrawingMode) toggleRoadDrawTool();
            });
            return;
        }

        // No width modal for a road: drawing starts immediately at the last-used width (the narrowest
        // preset, 7.5 m, on first use). The width is edited any time — before or during the drawing —
        // via the Cross-section button in this panel's header.
        const storedWidth = parseFloat(PersistentStorage.getItem('lastRoadWidth'));
        roadWidth = (Number.isFinite(storedWidth) && storedWidth >= 5 && storedWidth <= 80) ? storedWidth : 7.5;
        const storedSidewalkWidth = parseFloat(PersistentStorage.getItem('lastSidewalkWidth'));
        roadSidewalkWidth = Number.isFinite(storedSidewalkWidth)
            ? storedSidewalkWidth
            : (Number.isFinite(roadSidewalkWidth) ? roadSidewalkWidth : 1);
        if (typeof window !== 'undefined') {
            window.roadSidewalkWidth = roadSidewalkWidth;
        }
        roadProfile = corridorProfileFromLegacy(roadWidth, roadSidewalkWidth, false);
        roadLastValidatedWidth = roadWidth;
        roadDrawingProfileValidationPending = false;
        activateRoadDrawing('Click on the map to start drawing a road');

    } else {
        // Deactivate corridor drawing mode
        setRoadPanelLabelsForMode('road');
        console.log("Deactivating corridor drawing mode");
        if (roadDrawButton) {
            roadDrawButton.classList.remove('active');
            roadDrawButton.classList.remove('active-black-border');
        }
        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'none';
        map.getContainer().style.cursor = '';
        map.getContainer().classList.remove('crosshairs-cursor');

        // Remove road drawing event handlers from the map
        map.off('click', handleRoadClick);
        map.off('mousemove', handleRoadMouseMove);
        map.off('mouseout', handleRoadMouseOut);
        document.removeEventListener('keydown', handleRoadKeydown);

        // --- Robustly re-enable parcel interaction --- 
        console.log("Re-enabling parcel click listeners");
        restoreParcelClickInteractivity();
        // --- End robust re-enable ---

        // Reset road drawing variables
        resetRoadDrawing(false);

        // Hide the road info panel
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) roadInfoPanel.classList.remove('visible');

        // Clear status
        const statusElement = document.getElementById('status');
        if (statusElement) updateStatus('');
    }
}

// Handle keyboard events during road drawing
function handleRoadKeydown(e) {
    // Prevent handling if we're in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    // F finishes the road: the drawing instantly becomes an applied object (SimCity lifecycle).
    if ((e.key === 'f' || e.key === 'F') && getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length >= 2)) {
        e.preventDefault();
        if (e.repeat || roadFinalizationGate.isRunning() || roadSegmentPlacementInProgress) return;
        finishRoadDrawing();
    }

    // Check for U key (undo last segment)
    if ((e.key === 'u' || e.key === 'U') && getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length > 1)) {
        e.preventDefault(); // Prevent browser default behavior
        undoLastRoadSegment();
    }

    // Escape cancels only the segment being drawn; placed segments always remain. With no
    // active segment it applies the road (nothing drawn is ever lost — there are no drafts),
    // and with nothing drawn at all it closes the tool.
    if (e.key === 'Escape') {
        e.preventDefault(); // Prevent browser default behavior
        if (roadHasStarted) {
            cancelActiveRoadStroke();
            updateStatus(translateRoadText('panel.road.segmentCancelledStatus', 'Segment cancelled — placed segments stay. Esc again builds the road.'));
        } else if (getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length >= 2)) {
            finishRoadDrawing();
        } else {
            exitRoadDrawingMode();
        }
    }
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
        '.proposal-boost-modal',
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
            if (isElementVisiblyRendered(el)) return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

// The reference layers B last had ON, so pressing B again brings back the SAME choice instead of
// re-asking. null until the user has picked once.
let lastBuildingLayerChoice = null;

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
}

// B with NOTHING on and no remembered choice: describe the layers once and let the user pick.
// This is the only path that opens a dialog — see handleRoadDrawHotkey.
async function promptBuildingLayerChoice() {
    const message = `${translateRoadText('modal.buildingLayers.title', 'Which buildings to show?')}\n\n`
        + `${translateRoadText('modal.buildingLayers.gdi', 'GDI buildings (3D model)')} — `
        + `${translateRoadText('modal.buildingLayers.gdiHint', 'Photogrammetry: what is actually there. The 3D model uses this, and so does every cut and demolition.')}\n\n`
        + `${translateRoadText('modal.buildingLayers.dguHint', 'DGU cadastre: what is officially registered.')}\n\n`
        + `${translateRoadText('modal.buildingLayers.osmHint', 'OSM buildings: the community map — the outlines drawn on the basemap.')}`;

    const choices = [
        { value: 'gdi', label: translateRoadText('modal.buildingLayers.gdi', 'GDI buildings (3D model)') },
        { value: 'dgu', label: translateRoadText('modal.buildingLayers.dgu', 'DGU cadastre (legal reference)') },
        { value: 'osm', label: translateRoadText('modal.buildingLayers.osm', 'OSM buildings (matches the map)') },
        { value: 'all', label: translateRoadText('modal.buildingLayers.all', 'All') },
        { value: 'cancel', label: translateRoadText('modal.buildingLayers.cancel', 'Cancel') }
    ];

    const answer = (typeof window.showStyledChoice === 'function')
        ? await window.showStyledChoice(message, choices)
        : 'gdi';
    if (!answer || answer === 'cancel') return;

    const gdi = answer === 'gdi' || answer === 'all';
    const dgu = answer === 'dgu' || answer === 'all';
    const osm = answer === 'osm' || answer === 'all';
    lastBuildingLayerChoice = { gdi, dgu, osm };
    setBuildingReferenceLayers(gdi, dgu, osm);
}

// B toggles the building REFERENCE layers — flipped constantly while drawing roads through fabric,
// so it must stay instant. It never changes what a corridor cuts: detection reads the feature pool,
// not these layers.
//
//   something on  → remember it, turn everything off. INSTANT, no dialog.
//   nothing on    → restore the remembered choice. INSTANT, no dialog.
//   nothing on and nothing ever chosen → the one and only dialog: GDI / DGU / OSM / all.
function toggleBuildingReferenceLayers() {
    const gdiOn = !!document.getElementById('showBuildings')?.checked;
    const dguOn = !!document.getElementById('showBuildingsDgu')?.checked;
    const osmOn = !!document.getElementById('showBuildingsOsm')?.checked;

    if (gdiOn || dguOn || osmOn) {
        lastBuildingLayerChoice = { gdi: gdiOn, dgu: dguOn, osm: osmOn };
        setBuildingReferenceLayers(false, false, false);
        return;
    }
    if (lastBuildingLayerChoice) {
        // `osm` may be absent in a choice remembered before OSM existed — default it off.
        setBuildingReferenceLayers(lastBuildingLayerChoice.gdi, lastBuildingLayerChoice.dgu, !!lastBuildingLayerChoice.osm);
        return;
    }
    promptBuildingLayerChoice();
}

function handleRoadDrawHotkey(event) {
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
            undoButton.disabled = !currentSegment || currentSegment.length <= 1;
        } else {
            undoButton.disabled = true;
        }
    }
}

// Esc cancels ONLY the stroke in progress: points added since the pen went down are removed,
// everything placed earlier stays. A stub left with fewer than 2 points is dropped entirely.
function cancelActiveRoadStroke() {
    if (!roadHasStarted || !Array.isArray(roadPoints)) return false;
    // The array surgery (pop to base, drop the stub, keep segmentIds aligned) is the pure reducer in
    // road-stroke-state.js; here we apply its removed edges to the tunnel records and re-alias
    // roadPoints. segments/segmentIds are mutated in place, so their identity is preserved.
    const result = window.RoadStrokeState.applyStrokeCancel({
        segments: roadSegments,
        segmentIds: roadSegmentIds,
        activeIndex: roadSegments.indexOf(roadPoints),
        hasStarted: roadHasStarted,
        strokeBaseCount: roadStrokeBaseCount
    });
    if (typeof removeBuildingTunnelEdge === 'function') {
        result.removedEdges.forEach(([from, to]) => {
            roadBuildingTunnels = removeBuildingTunnelEdge(roadBuildingTunnels, from, to);
        });
    }
    if (typeof retainLiveGradeSeparations === 'function') {
        roadGradeSeparations = retainLiveGradeSeparations(roadSegments, roadGradeSeparations);
    }
    roadHasStarted = result.hasStarted;
    roadStrokeBaseCount = result.strokeBaseCount;
    roadPoints = result.activeIndex >= 0 ? roadSegments[result.activeIndex] : [];
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
        roadPreviewLine = null;
    }
    // The rubber-band edge preview (outline polygon) belongs to the cancelled stroke too.
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }
    roadPreviewPolygon = null;
    const updatedPolygon = rebuildRoadGeometryFromSegments();
    redrawRoadVertexMarkers();
    refreshRoadBuildingTunnelLayer();
    refreshRoadGradeSeparationLayer();
    recomputeLockedParcelsFromPolygon(updatedPolygon);
    updateRoadInfoPanel();
    updateUndoButtonState();
    return true;
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
        hasStarted: roadHasStarted,
        strokeBaseCount: roadStrokeBaseCount
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
    roadStrokeBaseCount = result.strokeBaseCount;
    roadPoints = result.activeIndex >= 0 ? roadSegments[result.activeIndex] : [];

    // Markers are rebuilt from the segments below, so nothing to pop here.

    // Rebuild centerline, polygon and vertex markers from the segments, then re-derive the locked
    // parcels from the resulting corridor.
    const updatedPolygon = rebuildRoadGeometryFromSegments();
    redrawRoadVertexMarkers();
    refreshRoadBuildingTunnelLayer();
    refreshRoadGradeSeparationLayer();
    recomputeLockedParcelsFromPolygon(updatedPolygon);

    // Update UI
    setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
    setRoadOwnershipCounts(lockedStats.ownershipCounts);

    const marketEl = document.getElementById('road-market-price');
    if (marketEl) {
        if (lockedStats.marketPrice > 0) {
            marketEl.textContent = formatCurrency(lockedStats.marketPrice);
        } else {
            marketEl.textContent = '—';
        }
    }

    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = lockedStats.individualOwners > 0 ? lockedStats.individualOwners.toString() : '—';
    }

    updateRoadAcquiringDifficulty(roadAffectedParcels);
    updateRoadInfoPanel();

    // Update undo button state
    updateUndoButtonState();
}


// Handle corridor drawing clicks — a road's and a track's, which are one and the same.
async function handleRoadClick(e) {
    // Stop event propagation to prevent parcel selection or other click handlers
    L.DomEvent.stopPropagation(e);

    if (roadFinalizationGate.isRunning() || roadSegmentPlacementInProgress) return;
    if (roadDrawingProfileValidationPending) {
        updateStatus('Apply or cancel the cross-section change before drawing another segment.');
        return;
    }
    // The cross-section editor docks beside a live, pannable map — a click on it must not
    // place a drawing point behind the editor's back.
    if (typeof isCorridorEditorOpen === 'function' && isCorridorEditorOpen()) return;
    roadSegmentPlacementInProgress = true;
    try {

    // Snap to an existing vertex or edge so segments that look connected really do share a node.
    // Drawing NEVER mutates or removes a placed road: a snap onto an existing corridor only donates
    // the exact position for this new segment's vertex, attaching it to that vertex/centerline. All
    // merging and joining of touching corridors happens ONCE, at finish (F), in
    // absorbConnectedLocalCorridors — never on a click.
    let snap = findRoadSnapTarget(e.latlng);
    let clickPoint = snap ? snap.latlng : e.latlng;
    clearRoadSnapMarker();

    // A rail lane in the cross-section brings the rail curve limit with it: a train cannot take the
    // corner a car can, so the click is nudged out to the minimum radius its design speed allows.
    // A SNAPPED click is exempt — landing exactly on an existing node is the whole point of snapping,
    // and moving it would break the connection the user asked for.
    if (!snap && roadHasStarted && corridorDrawingIsTrack() && typeof checkCurvatureConstraint === 'function') {
        const constraint = checkCurvatureConstraint(roadPoints, clickPoint, trackMinCurvatureRadius);
        if (constraint.adjustedPoint) clickPoint = constraint.adjustedPoint;
        if (constraint.wasAdjusted) {
            updateStatus(`Curve eased to the ${trackMinCurvatureRadius} m minimum radius for ${trackSpeed} km/h`);
        }
    }

    // Clicking an existing segment's end before drawing has started continues that segment instead
    // of beginning a new one — the same segment, extended, not a second one that happens to touch.
    if (!roadHasStarted && snap && snap.type === 'endpoint') {
        if (resumeRoadSegment(snap.segmentIndex, snap.atStart)) {
            redrawRoadVertexMarkers();
            rebuildRoadGeometryFromSegments();
            updateStatus('Continuing this segment — click to add points, press F to finish the road');
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
        roadStrokeBaseCount = 0;

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
        updateStatus('Click to add road points, press F to finish the road');
    } else {
        const segmentPoints = [roadPoints[roadPoints.length - 1], clickPoint];
        // Detect with the width THIS segment will actually be drawn at (per-segment override
        // included); validating at plain roadWidth can accept a wider rendered edge unchecked.
        const activeSegmentIndex = roadSegments.indexOf(roadPoints);
        const activeSegmentWidth = activeSegmentIndex >= 0 ? roadDrawingWidthForSegmentIndex(activeSegmentIndex) : roadWidth;
        const segmentPolygon = calculateRoadPolygon(segmentPoints, activeSegmentWidth);
        let pendingGradeSeparations = [];
        if (typeof resolvePedestrianRoadCrossings === 'function') {
            const activeProfile = roadDrawingSegmentOverride(activeSegmentIndex) || roadProfile;
            const crossingResolution = await resolvePedestrianRoadCrossings(
                segmentPoints[0], segmentPoints[1], activeProfile, activeSegmentWidth
            );
            if (crossingResolution.action === 'cancel') return;
            pendingGradeSeparations = Array.isArray(crossingResolution.records)
                ? crossingResolution.records
                : [];
        }
        // Load footprints along THIS edge — the pool only covers fetched viewports, so an
        // unloaded building would silently pass detection and stay standing under the road.
        if (segmentPolygon && typeof window.ensureBuildingFootprintsForBounds === 'function') {
            try {
                await ensureBuildingFootprintsForRoadEdge(segmentPoints[0], segmentPoints[1], activeSegmentWidth);
            } catch (error) {
                console.error('[road-drawing] footprint preload for edge failed', error);
            }
        }
        const edgeRegion = (segmentPolygon && typeof corridorFeatureFromLatLngRing === 'function')
            ? corridorFeatureFromLatLngRing(segmentPolygon)
            : null;
        let tunnelSubEdges = null;
        if (segmentPolygon && typeof detectLoadedBuildingTunnelIntersections === 'function') {
            const fullyDemolishedIds = new Set(roadDemolishedBuildings.filter(record => !record.remainder).map(record => String(record.id)));
            const cutIds = new Set(roadDemolishedBuildings.filter(record => record.remainder).map(record => String(record.id)));
            // A building this drawing already tunnels keeps that decision. Continuing/extending a
            // corridor reloads its tunnels into roadBuildingTunnels (seedRoadDrawing), so a new segment
            // that grazes a building already tunnelled must NOT re-ask — same building-keyed reuse the
            // two edit paths use, so a road's relation to a building is decided once, everywhere.
            const alreadyTunnelledIds = new Set((roadBuildingTunnels || []).flatMap(record => (record?.buildingIds || []).map(String)));
            const detected = detectLoadedBuildingTunnelIntersections(segmentPolygon)
                .filter(hit => !fullyDemolishedIds.has(String(hit.id)));
            // A building already CUT this session extends its cut silently — the decision for
            // that building was made; only genuinely new buildings prompt.
            if (edgeRegion && typeof upsertCutRecord === 'function') {
                detected.filter(hit => cutIds.has(String(hit.id)))
                    .forEach(hit => upsertCutRecord(roadDemolishedBuildings, hit, edgeRegion));
            }
            const hits = detected.filter(hit => !cutIds.has(String(hit.id)) && !alreadyTunnelledIds.has(String(hit.id)));
            if (hits.length) {
                const resolution = typeof resolveBuildingObstacles === 'function'
                    ? await resolveBuildingObstacles(hits, 'road')
                    : { action: 'cancel', removedProposalIds: [], demolishedBuildings: [], cutHits: [] };
                if (resolution.action === 'cancel') return;
                // Per-building outcomes: destroy, cut and tunnel can all apply within this edge's set.
                if ((resolution.demolishedBuildings || []).length) {
                    roadDemolishedBuildings.push(...resolution.demolishedBuildings);
                }
                if ((resolution.cutHits || []).length && edgeRegion && typeof upsertCutRecord === 'function') {
                    resolution.cutHits.forEach(hit => upsertCutRecord(roadDemolishedBuildings, hit, edgeRegion));
                }
                {
                    const removedOwners = new Set(resolution.removedProposalIds || []);
                    const standingHits = hits.filter(hit => {
                        if (resolvedActionForHit(resolution, hit) !== 'tunnel') return false;
                        const owner = typeof corridorTunnelHitProposalId === 'function' ? corridorTunnelHitProposalId(hit) : null;
                        return !owner || !removedOwners.has(owner);
                    });
                    if (standingHits.length) {
                        // Tunnel ONLY while inside the buildings: clip the edge at the facades and
                        // insert the portals as real vertices; outside portions stay surface road.
                        tunnelSubEdges = (typeof clipCorridorEdgeThroughBuildings === 'function')
                            ? clipCorridorEdgeThroughBuildings(segmentPoints[0], segmentPoints[1], standingHits, activeSegmentWidth)
                            : null;
                        if (!tunnelSubEdges) {
                            // Degenerate geometry (clip found no interior crossing): whole edge.
                            tunnelSubEdges = [{ from: segmentPoints[0], to: segmentPoints[1], inside: true, hits: standingHits }];
                        }
                    }
                }
            }
            // Parks/squares/lakes in the way get their own decision: unapply / build through / reroute.
            if (typeof detectStructureCrossings === 'function' && typeof resolveStructureCrossings === 'function') {
                const structureHits = detectStructureCrossings(segmentPolygon);
                if (structureHits.length && !(await resolveStructureCrossings(structureHits, 'road'))) return;
            }
        }

        // Add another point to the road (the polygon for the new edge is built below, once).
        // Building-tunnel portals and grade-separation ramp ends are all collinear interior points
        // on this edge. Insert them in geometric order once so neither feature can invalidate the
        // other's stable protected-edge metadata.
        const interiorPoints = [];
        const edgeParameter = point => {
            const a = segmentPoints[0], b = segmentPoints[1];
            const dx = b.lng - a.lng, dy = b.lat - a.lat;
            const lengthSq = dx * dx + dy * dy;
            return lengthSq > 0 ? (((point.lng - a.lng) * dx + (point.lat - a.lat) * dy) / lengthSq) : 0;
        };
        if (tunnelSubEdges) {
            const segmentIndex = roadSegments.indexOf(roadPoints);
            const segmentId = roadSegmentIds[segmentIndex] || null;
            tunnelSubEdges.forEach((sub, index) => {
                if (index < tunnelSubEdges.length - 1) {
                    interiorPoints.push(sub.to);
                }
                if (sub.inside && typeof makeBuildingTunnelRecord === 'function') {
                    const record = makeBuildingTunnelRecord(sub.from, sub.to, sub.hits, { segmentId });
                    if (record && typeof addBuildingTunnelRecord === 'function') {
                        roadBuildingTunnels = addBuildingTunnelRecord(roadBuildingTunnels, record);
                    }
                }
            });
        }

        const segmentId = roadSegmentIds[activeSegmentIndex] || null;
        pendingGradeSeparations.forEach(record => {
            record.segmentId = segmentId;
            interiorPoints.push(record.from, record.to);
            try {
                const ring = calculateRoadPolygon([record.from, record.crossing, record.to], activeSegmentWidth);
                const feature = ring && typeof corridorFeatureFromLatLngRing === 'function'
                    ? corridorFeatureFromLatLngRing(ring)
                    : null;
                record.footprint = feature?.geometry || null;
            } catch (_) { record.footprint = null; }
        });

        interiorPoints
            .filter(point => point && edgeParameter(point) > 1e-9 && edgeParameter(point) < 1 - 1e-9)
            .sort((a, b) => edgeParameter(a) - edgeParameter(b))
            .filter((point, index, list) => index === 0
                || Math.abs(point.lat - list[index - 1].lat) > 1e-9
                || Math.abs(point.lng - list[index - 1].lng) > 1e-9)
            .forEach(point => {
                roadPoints.push(point);
                roadMarkers.push(createRoadVertexMarker(point));
            });
        roadPoints.push(clickPoint);
        pendingGradeSeparations.forEach(record => {
            if (typeof refreshGradeSeparationEdgeKeys === 'function') {
                refreshGradeSeparationEdgeKeys(record, roadPoints);
            }
            roadGradeSeparations.push(record);
        });
        if (tunnelSubEdges) refreshRoadBuildingTunnelLayer();
        if (pendingGradeSeparations.length) refreshRoadGradeSeparationLayer();
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

            // Calculate the segment polygon for just the NEW segment (last two points)
            // PERFORMANCE: Incrementally union the new segment polygon with cached polygon
            // instead of rebuilding the entire road polygon from scratch
            let newCommittedPolygon;
            if (segmentPolygon) {
                if (cachedCommittedPolygon) {
                    // Union new segment with existing cached polygon
                    newCommittedPolygon = combineRoadPolygons(cachedCommittedPolygon, segmentPolygon);
                } else {
                    // First segment - just use segment polygon
                    newCommittedPolygon = segmentPolygon;
                }
                // Update cache
                cachedCommittedPolygon = newCommittedPolygon;
            } else {
                // Segment polygon calculation failed - keep existing
                newCommittedPolygon = cachedCommittedPolygon;
            }

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

                // INCREMENTAL: Only find and lock parcels from the NEW segment
                // This avoids recalculating all parcels and losing parcels outside the view
                if (segmentPolygon) {
                    lockParcelsFromSegment(segmentPolygon);
                }

                // Redraw the cross-section over the committed corridor (commit only, never on preview).
                redrawRoadStrips();
            } else {
                console.warn("Failed to calculate committed road polygon after click.");
            }

        } catch (error) {
            console.error('Error processing road segment after click:', error);
        }
        roadLastValidatedWidth = roadWidth;
        roadDrawingProfileValidationPending = false;
    }

    // Always update the info panel
    updateRoadInfoPanel();

    // Update undo button state
    updateUndoButtonState();
    } finally {
        roadSegmentPlacementInProgress = false;
    }
}

// Handle road mouse movement for preview
function handleRoadMouseMove(e) {
    // Show where the click would snap, whether or not a segment is under way: before the first click
    // the highlight tells the user which segment end they are about to continue.
    const snap = findRoadSnapTarget(e.latlng);
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
        const previewSegmentPolygon = calculateRoadPolygon(previewSegmentPoints, roadWidth);

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

            lastRoadMoveUpdate = Date.now(); // Keep for potential throttling later

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

// Remove interactive handlers while finishing/cancelling
function suspendRoadDrawingInteractivity() {
    try { map.off('click', handleRoadClick); } catch (_) { }
    try { map.off('mousemove', handleRoadMouseMove); } catch (_) { }
    try { map.off('mouseout', handleRoadMouseOut); } catch (_) { }
    document.removeEventListener('keydown', handleRoadKeydown);
}

// Fully exit road drawing mode and clean up UI/handlers
function exitRoadDrawingMode() {
    suspendRoadDrawingInteractivity();
    stopRoadPreviewTracking();

    // Reset state and UI
    resetRoadDrawing();
    updateGlobalRoadDrawingMode(false);

    // Whichever button opened the session is the one that goes dark.
    const roadDrawButton = corridorDrawButton();
    if (roadDrawButton) {
        roadDrawButton.classList.remove('active');
        roadDrawButton.classList.remove('active-black-border');
        roadDrawButton.removeAttribute('aria-pressed');
        roadDrawButton.blur();
    }
    setRoadPanelLabelsForMode('road');

    const roadDrawingControls = document.getElementById('road-drawing-controls');
    if (roadDrawingControls) roadDrawingControls.style.display = 'none';

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

    // Re-enable parcel interaction
    restoreParcelClickInteractivity();

    const statusElement = document.getElementById('status');
    if (statusElement) updateStatus('');
    window.finishProposalDraftDesignSession?.();
}

// Legacy road polygon builder using per-segment rectangles and wedges
function calculateRoadPolygonRectangular(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: points?.length, width });
        return null;
    }

    // If we only have two points, just return a single rectangle
    if (points.length === 2) {
        return createRectangularRoadSegment(points[0], points[1], width);
    }

    // Create individual rectangular segments for each pair of points
    let combinedPolygon = null;

    for (let i = 0; i < points.length - 1; i++) {
        const segment = createRectangularRoadSegment(points[i], points[i + 1], width);

        if (!segment) {
            console.warn(`Failed to create segment ${i}`);
            continue;
        }

        // For the first segment, initialize the combined polygon
        if (combinedPolygon === null) {
            combinedPolygon = segment;
        } else {
            // Combine with existing polygon
            combinedPolygon = combineRoadPolygons(combinedPolygon, segment);
        }

        // If combining failed, use just this segment
        if (!combinedPolygon) {
            console.error(`Failed to combine segment ${i}, reverting to single segment`);
            combinedPolygon = segment;
        }

        // At each interior joint, add a wedge to fill the outer gap between segments
        if (i >= 1 && i < points.length - 1) {
            try {
                const wedge = createJointWedgePolygon(points[i - 1], points[i], points[i + 1], width);
                if (wedge) {
                    const combinedWithWedge = combineRoadPolygons(combinedPolygon, wedge);
                    if (combinedWithWedge) {
                        combinedPolygon = combinedWithWedge;
                    }
                }
            } catch (e) {
                // Silent failure for wedge calculation to avoid interrupting drawing
            }
        }
    }

    return combinedPolygon;
}

// Calculate road polygon from centerline.
// We always use the segment-by-segment corridor union builder with bevel joins.
// This keeps behavior consistent (no mode switch after first self-crossing) and avoids filling enclosed loops.
function calculateRoadPolygon(points, width) {
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

    let combined = null;
    for (const segment of segments) {
        if (!Array.isArray(segment) || segment.length < 2) continue;
        const poly = calculateRoadPolygonRectangular(segment, width);
        if (!poly) continue;
        combined = combined ? (combineRoadPolygons(combined, poly) || combined) : poly;
    }

    return combined;
}

// Calculate road polygon by buffering the centerline - this naturally fills all crossings
function calculateRoadPolygonFromBuffer(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        return null;
    }

    try {
        // Convert points to GeoJSON LineString coordinates [lng, lat]
        const lineCoords = points.map(p => [p.lng, p.lat]);

        // Create a Turf LineString from the centerline
        const centerline = turf.lineString(lineCoords);

        // Buffer the line by half the road width on each side
        // turf.buffer applies the distance on both sides, so halfWidth gives total width
        const halfWidth = width / 2;
        const buffered = turf.buffer(centerline, halfWidth, {
            units: 'meters',
            steps: 16  // Number of steps for smoother curves
        });

        if (!buffered || !buffered.geometry) {
            return null;
        }

        // Extract coordinates from the buffered polygon
        let coords;
        if (buffered.geometry.type === 'Polygon') {
            coords = buffered.geometry.coordinates[0];
        } else if (buffered.geometry.type === 'MultiPolygon') {
            // Use the largest polygon
            let maxArea = 0;
            let largestCoords = null;
            for (const poly of buffered.geometry.coordinates) {
                try {
                    const polyFeature = turf.polygon([poly[0]]);
                    const area = turf.area(polyFeature);
                    if (area > maxArea) {
                        maxArea = area;
                        largestCoords = poly[0];
                    }
                } catch (_) {
                    // Skip invalid polygons
                }
            }
            coords = largestCoords;
        } else {
            return null;
        }

        if (!coords || coords.length < 4) {
            return null;
        }

        // Convert back to Leaflet latLng format
        return coords.map(coord => L.latLng(coord[1], coord[0]));
    } catch (error) {
        console.warn('Failed to calculate road polygon from buffer:', error);
        return null;
    }
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

function polygonHasSelfIntersection(latLngPolygon) {
    if (!Array.isArray(latLngPolygon) || latLngPolygon.length < 4) return false;

    // Detect self-intersections in the polygon *ring* using planar segment intersection.
    // This is more reliable than depending on Turf validity for kink detection.
    const pts = [];
    const EPS = 1e-6;

    for (const p of latLngPolygon) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lng)) continue;
        try {
            const xy = wgs84ToHTRS96(p.lat, p.lng);
            if (!Array.isArray(xy) || xy.length < 2 || !isFinite(xy[0]) || !isFinite(xy[1])) continue;
            const next = { x: xy[0], y: xy[1] };
            if (pts.length > 0) {
                const prev = pts[pts.length - 1];
                if (Math.hypot(next.x - prev.x, next.y - prev.y) < EPS) {
                    continue; // skip consecutive duplicates
                }
            }
            pts.push(next);
        } catch (_) {
            // If projection fails, don't treat it as intersecting
            return false;
        }
    }

    if (pts.length < 4) return false;

    // Ensure the ring is closed in planar space
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > EPS) {
        pts.push({ x: first.x, y: first.y });
    }

    const segCount = pts.length - 1;
    if (segCount < 3) return false;

    for (let i = 0; i < segCount; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        for (let j = i + 1; j < segCount; j++) {
            // Skip adjacent segments (they share endpoints)
            if (j === i + 1) continue;
            // Skip first/last segment adjacency in a closed ring
            if (i === 0 && j === segCount - 1) continue;

            const c = pts[j];
            const d = pts[j + 1];
            if (segmentsIntersect(a, b, c, d)) {
                return true;
            }
        }
    }

    return false;
}

// buildOffsetRoadPolygon was dead (no callers) and removed. The road footprint is built from
// createRectangularRoadSegment + union (see corridor-geometry.js).
// Helper function to check if a point is valid
function isValidPoint(point) {
    return point &&
        Array.isArray(point) &&
        point.length === 2 &&
        isFinite(point[0]) &&
        isFinite(point[1]);
}

// Sanitize a road polygon (Leaflet latLngs) by cleaning duplicate/invalid coordinates.
// IMPORTANT: This must NOT "fill" enclosed spaces. For self-crossing/loops we build a union-correct
// corridor polygon elsewhere (segment-by-segment union), so sanitization should stay non-invasive.
// Returns the sanitized polygon in the same latLng structure (ring / holes / multipolygon).
function sanitizeRoadPolygon(polygon) {
    if (!polygon) return polygon;

    if (typeof turf === 'undefined' || !turf || typeof turf.cleanCoords !== 'function') {
        return polygon;
    }

    try {
        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

        const toClosedLngLatRing = (ring) => {
            const coords = (Array.isArray(ring) ? ring : [])
                .filter(isLatLng)
                .map(p => [p.lng, p.lat]);
            const closed = ensurePolygonIsClosed(coords);
            return Array.isArray(closed) && closed.length >= 4 ? closed : null;
        };

        const toTurfFeature = (poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;

            if (isLatLng(poly[0])) {
                const ring = toClosedLngLatRing(poly);
                return ring ? turf.polygon([ring]) : null;
            }

            if (Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                const rings = poly.map(toClosedLngLatRing).filter(Boolean);
                return rings.length ? turf.polygon(rings) : null;
            }

            if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                const polys = poly
                    .map(polygonRings => (Array.isArray(polygonRings) ? polygonRings : []).map(toClosedLngLatRing).filter(Boolean))
                    .filter(rings => rings.length > 0);
                return polys.length ? turf.multiPolygon(polys) : null;
            }

            return null;
        };

        const feature = toTurfFeature(polygon);
        if (!feature || !feature.geometry) {
            return polygon;
        }

        let cleaned = feature;
        try {
            cleaned = turf.cleanCoords(feature, { mutate: false }) || feature;
        } catch (_) { /* ignore */ }
        try {
            // Standardize winding (outer CCW, inner CW) for consistent rendering if fillRule changes.
            if (typeof turf.rewind === 'function') {
                cleaned = turf.rewind(cleaned, { reverse: false }) || cleaned;
            }
        } catch (_) { /* ignore */ }

        const geom = cleaned.geometry;
        const toLatLngRing = (ring) => (Array.isArray(ring) ? ring : [])
            .map(coord => Array.isArray(coord) && coord.length >= 2 ? L.latLng(coord[1], coord[0]) : null)
            .filter(Boolean);

        if (geom.type === 'Polygon') {
            const rings = (geom.coordinates || []).map(toLatLngRing).filter(r => r.length >= 4);
            if (!rings.length) return polygon;
            return rings.length === 1 ? rings[0] : rings;
        }

        if (geom.type === 'MultiPolygon') {
            const polys = (geom.coordinates || [])
                .map(polyRings => (Array.isArray(polyRings) ? polyRings : [])
                    .map(toLatLngRing)
                    .filter(r => r.length >= 4))
                .filter(rings => rings.length > 0);
            return polys.length ? polys : polygon;
        }

        return polygon;
    } catch (error) {
        console.warn('Error sanitizing road polygon:', error);
        return polygon;
    }
}

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

// Get parcel outer ring(s) in [lng, lat] arrays; handles Polygon and MultiPolygon, with fallback to layer.getLatLngs()
function getParcelOuterRingsLngLat(layer) {
    const rings = [];
    try {
        const geom = layer && layer.feature ? layer.feature.geometry : null;
        if (geom && geom.type) {
            if (geom.type === 'Polygon') {
                if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    const ring = ensurePolygonIsClosed(geom.coordinates[0]);
                    if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                }
            } else if (geom.type === 'MultiPolygon') {
                if (Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(poly => {
                        if (Array.isArray(poly) && poly.length > 0) {
                            const ring = ensurePolygonIsClosed(poly[0]);
                            if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                        }
                    });
                }
            }
        } else if (typeof layer.getLatLngs === 'function') {
            const latlngs = layer.getLatLngs();
            // MultiPolygon form: [ [ [LatLng...] (outer), [LatLng...] (holes) ], ... ]
            if (Array.isArray(latlngs) && Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0])) {
                latlngs.forEach(polyRings => {
                    if (Array.isArray(polyRings) && Array.isArray(polyRings[0])) {
                        const ring = polyRings[0].map(ll => [ll.lng, ll.lat]);
                        const closed = ensurePolygonIsClosed(ring);
                        if (Array.isArray(closed) && closed.length >= 4) rings.push(closed);
                    }
                });
            } else if (Array.isArray(latlngs) && Array.isArray(latlngs[0])) {
                // Polygon form: [ [LatLng...] (outer), [LatLng...] (hole1), ... ]
                const ring = latlngs[0].map(ll => [ll.lng, ll.lat]);
                const closed = ensurePolygonIsClosed(ring);
                if (Array.isArray(closed) && closed.length >= 4) rings.push(closed);
            }
        }
    } catch (_) { }
    return rings;
}

// convertRoadPolygonToLatLngPairs, convertLatLngPairsToGeoJSON and isValidPolygonLatLngPairs moved
// to frontend/js/corridor-geometry.js (loaded first) — the footprint-shape funnel, now unit-tested
// (incl. the MultiPolygon-vs-holes discrimination). Callers below use the globals unchanged.

function buildBoundsFromLatLngPairs(polygon) {
    if (!isValidPolygonLatLngPairs(polygon) || typeof L === 'undefined') return null;

    const flatCoords = [];
    const collect = (node) => {
        if (!Array.isArray(node)) return;
        if (node.length && Array.isArray(node[0]) && node[0].length >= 2 && Number.isFinite(Number(node[0][0])) && Number.isFinite(Number(node[0][1]))) {
            node.forEach(pair => {
                if (Array.isArray(pair) && pair.length >= 2 && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1]))) {
                    flatCoords.push([Number(pair[0]), Number(pair[1])]);
                }
            });
            return;
        }
        node.forEach(collect);
    };

    collect(polygon);
    if (!flatCoords.length) return null;

    try {
        const latLngs = flatCoords.map(coord => L.latLng(coord[0], coord[1]));
        return latLngs.length ? L.latLngBounds(latLngs) : null;
    } catch (error) {
        console.warn('Failed to calculate bounds from polygon:', error);
        return null;
    }
}

function buildParcelPolygonLatLngs(parcels) {
    const results = [];
    if (!Array.isArray(parcels)) return results;
    parcels.forEach(parcel => {
        const rings = getParcelOuterRingsLngLat(parcel.layer);
        if (Array.isArray(rings) && rings.length > 0) {
            rings.forEach(ring => {
                if (Array.isArray(ring) && ring.length >= 4) {
                    const latLngRing = ring
                        .map(([lng, lat]) => {
                            const latNum = Number(lat);
                            const lngNum = Number(lng);
                            if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
                                return null;
                            }
                            return [latNum, lngNum];
                        })
                        .filter(Boolean);
                    if (latLngRing.length >= 4) {
                        const closed = convertRoadPolygonToLatLngPairs(latLngRing);
                        if (closed && closed.length >= 4) {
                            results.push(closed);
                        }
                    }
                }
            });
        }
    });
    return results;
}

// Shared function to find and highlight affected parcels
// Parameters:
//   polygon: Array of {lng, lat} objects
//   previousAffectedParcels: Array of previously affected parcels (to clear highlighting)
//   highlightStyle: Style object to apply to affected parcels
//   excludeParcelIds: Optional array/set of parcel IDs to exclude (e.g., already committed parcels)
//   options: Optional object with { skipBoundsFilter: boolean } to disable map bounds filtering
// Returns: Array of affected parcel objects
function findAndHighlightAffectedParcels(polygon, previousAffectedParcels, highlightStyle, excludeParcelIds = null, options = {}) {
    if (!polygon || !parcelLayer) return [];

    const turfPolygon = polygonLatLngsToTurfFeature(polygon);
    if (!turfPolygon) return [];

    // Clear previously affected parcels only after we have a valid polygon
    if (previousAffectedParcels && previousAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            const pid = getRoadDrawingParcelIdFromFeature(layer.feature);
            if (!pid) return;
            // Reset style for previously affected parcels
            if (previousAffectedParcels.some(p => getParcelIdFromAny(p) === pid.toString())) {
                const isRoad = typeof window.isRoadParcel === 'function' ? window.isRoadParcel(pid) : false;
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }

    const affectedParcels = [];
    const excludeSet = excludeParcelIds ? (excludeParcelIds instanceof Set ? excludeParcelIds : new Set(excludeParcelIds)) : null;
    const skipBoundsFilter = options && options.skipBoundsFilter === true;

    // Get current map bounds for filtering (unless skipped)
    let mapBounds = null;
    if (!skipBoundsFilter) {
        try {
            mapBounds = map.getBounds();
        } catch (e) {
            // Continue without bounds filtering if unavailable
        }
    }

    // Check each parcel for intersection
    parcelLayer.eachLayer(layer => {
        // Skip parcels outside the current map view for performance (if bounds available and not skipped)
        if (mapBounds) {
            try {
                const layerBounds = layer.getBounds();
                if (!mapBounds.intersects(layerBounds)) {
                    return; // Skip parcels outside view
                }
            } catch (e) {
                // Some layers might not have bounds, continue anyway
            }
        }

        const parcelId = getRoadDrawingParcelIdFromFeature(layer.feature);

        // Skip if in exclusion list
        if (excludeSet && excludeSet.has(parcelId)) {
            return;
        }

        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            // Check intersects against any outer ring; stop at first match
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfPolygon, turfParcelPolygon)) {
                    const parcelArea = Number(layer.feature.properties.calculatedArea) || 0;

                    affectedParcels.push({
                        id: parcelId,
                        number: layer.feature.properties.BROJ_CESTICE,
                        area: parcelArea,
                        estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice,
                        layer: layer
                    });

                    layer.setStyle(highlightStyle);

                    if (typeof layer.bringToFront === 'function') {
                        layer.bringToFront();
                    }
                    break;
                }
            }
        } catch (error) { }
    });

    return affectedParcels;
}

// Find NEW parcels affected by a segment polygon (incremental - only adds parcels not already locked)
// This is called on click to add parcels from the newly confirmed segment
function findNewAffectedParcelsForSegment(segmentPolygon) {
    if (!segmentPolygon || !parcelLayer) return [];

    // Define the green highlight style for committed road parcels
    const committedRoadStyle = {
        fillColor: 'green',
        fillOpacity: 0.6,
        color: 'green',
        weight: 3
    };

    // Create a turf polygon from the segment polygon
    const latLngs = segmentPolygon.map(p => [p.lng, p.lat]);

    // Check if we have enough points to form a valid polygon
    if (latLngs.length < 4) {
        return [];
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
        return [];
    }

    if (!turfPolygon) {
        return [];
    }

    const newParcels = [];
    // Check each parcel for intersection - NO mapBounds filter for long roads

    // Get bounds of the segment polygon for fast filtering
    // This is NOT about map view bounds - it's about segment geometry bounds
    // A segment is always small (2 points), so this is a tight filter
    let segmentBounds;
    try {
        segmentBounds = L.latLngBounds(segmentPolygon);
    } catch (_) {
        // Fall back to no bounds filtering if bounds calculation fails
    }

    // Check each parcel for intersection with the segment
    parcelLayer.eachLayer(layer => {
        const parcelId = getRoadDrawingParcelIdFromFeature(layer.feature);
        if (!parcelId) return;

        // Skip if already locked (already in our committed set)
        if (lockedParcelIds.has(parcelId)) {
            return;
        }

        // Fast bounds check: skip parcels that don't overlap the segment bounds
        if (segmentBounds) {
            try {
                const layerBounds = layer.getBounds();
                if (!segmentBounds.intersects(layerBounds)) {
                    return; // Parcel doesn't overlap segment - skip expensive intersection test
                }
            } catch (_) {
                // Continue with full intersection check if bounds unavailable
            }
        }

        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            // Check intersects against any outer ring; stop at first match
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfPolygon, turfParcelPolygon)) {
                    const parcelArea = Number(layer.feature.properties.calculatedArea) || 0;

                    newParcels.push({
                        id: parcelId,
                        number: layer.feature.properties.BROJ_CESTICE,
                        area: parcelArea,
                        estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice,
                        layer: layer
                    });

                    // Apply committed style
                    layer.setStyle(committedRoadStyle);

                    if (typeof layer.bringToFront === 'function') {
                        layer.bringToFront();
                    }
                    break;
                }
            }
        } catch (error) { }
    });

    return newParcels;
}

// Get ownership type from parcel's feature properties
function getOwnershipTypeFromParcel(parcel) {
    const featureProps = parcel.layer?.feature?.properties || parcel.properties || {};
    const ownershipTypeFromProps = featureProps.ownershipType;

    if (ownershipTypeFromProps) {
        return normalizeParcelOwnershipType(ownershipTypeFromProps);
    }

    // Try to derive from ownership list
    const ownershipList = featureProps.ownershipList || [];
    if (Array.isArray(ownershipList) && ownershipList.length > 0) {
        const hasOwnershipFn = typeof getOwnershipType === 'function';
        const ownerTypes = ownershipList.map(owner => {
            const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
            if (hasOwnershipFn) {
                return normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
            }
            return normalizeParcelOwnershipType(ownerLabel);
        }).filter(Boolean);
        const uniqueTypes = Array.from(new Set(ownerTypes.length ? ownerTypes : ['individual']));
        return uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
    }

    // Check cache as fallback
    const parcelId = parcel.id || getParcelIdFromAny(parcel);
    if (parcelId) {
        const cachedType = roadOwnershipTypeCache.get(parcelId);
        if (cachedType) {
            return normalizeParcelOwnershipType(cachedType);
        }
    }

    return 'individual'; // Default
}

// Locked parcels and their stats are derived state: they are exactly "the parcels the corridor covers".
// Recomputing them from the corridor polygon keeps them correct no matter what order the vertices were
// drawn in — which the per-edge undo history could not, once a segment can be resumed, reversed, or
// seeded from an existing road. One polygon-vs-parcels pass, the same work a single click already does.
function recomputeLockedParcelsFromPolygon(polygon) {
    clearAffectedParcels();
    roadSegmentHistory = [];
    lockedParcelIds.clear();
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

    // An edge that locks no new parcels (it stayed inside parcels an earlier edge already took) still
    // gets a history entry. Undo pops one entry per vertex, so skipping the push here would make undo
    // pop some *earlier* edge's entry and unlock parcels the road still runs through.

    // Store segment stats for undo
    const segmentParcelIds = new Set();
    const segmentStats = {
        parcelCount: 0,
        totalArea: 0,
        ownershipCounts: { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 },
        marketPrice: 0,
        individualOwners: 0
    };

    // Add new parcels to the locked set and the affected parcels array
    for (const parcel of newParcels) {
        if (!lockedParcelIds.has(parcel.id)) {
            lockedParcelIds.add(parcel.id);
            segmentParcelIds.add(parcel.id);
            roadAffectedParcels.push(parcel);

            // Update cached stats incrementally
            lockedStats.parcelCount++;
            lockedStats.totalArea += (Number(parcel.area) || 0);
            segmentStats.parcelCount++;
            segmentStats.totalArea += (Number(parcel.area) || 0);

            // Get ownership type for this parcel (sync, from feature properties)
            const ownershipType = getOwnershipTypeFromParcel(parcel);
            if (lockedStats.ownershipCounts[ownershipType] !== undefined) {
                lockedStats.ownershipCounts[ownershipType]++;
                segmentStats.ownershipCounts[ownershipType]++;
            } else {
                lockedStats.ownershipCounts.individual++;
                segmentStats.ownershipCounts.individual++;
            }

            // Add market price
            const price = Number(parcel.estimatedMarketPrice) || 0;
            lockedStats.marketPrice += price;
            segmentStats.marketPrice += price;

            // Count individual owners from ownership list
            const featureProps = parcel.layer?.feature?.properties || {};
            const ownershipList = featureProps.ownershipList || [];
            if (Array.isArray(ownershipList) && ownershipList.length > 0) {
                for (const owner of ownershipList) {
                    const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                    if (typeof getOwnershipType === 'function') {
                        const ownerType = getOwnershipType(ownerLabel);
                        // getOwnershipType returns 'private individual' for individuals
                        if (ownerType === 'individual' || ownerType === 'private individual' || ownerType === 'Fizička osoba') {
                            lockedStats.individualOwners++;
                            segmentStats.individualOwners++;
                        }
                    } else {
                        // If getOwnershipType isn't available, count all owners as individuals
                        lockedStats.individualOwners++;
                        segmentStats.individualOwners++;
                    }
                }
            } else {
                // No ownership list - assume 1 individual owner
                lockedStats.individualOwners++;
                segmentStats.individualOwners++;
            }
        }
    }

    // Store segment history for undo
    roadSegmentHistory.push({ parcelIds: segmentParcelIds, stats: segmentStats });

    // Update UI with locked stats
    setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
    setRoadOwnershipCounts(lockedStats.ownershipCounts);

    // Update market price display
    const marketEl = document.getElementById('road-market-price');
    if (marketEl) {
        if (lockedStats.marketPrice > 0) {
            marketEl.textContent = formatCurrency(lockedStats.marketPrice);
        } else {
            marketEl.textContent = '—';
        }
    }

    // Update individual owners count display
    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = lockedStats.individualOwners > 0 ? lockedStats.individualOwners.toString() : '—';
    }

    updateRoadAcquiringDifficulty(roadAffectedParcels);
}

// Helper to format currency (reuse existing logic or simple format)
function formatCurrency(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    const cityConfigManager = (typeof window !== 'undefined' && window.CityConfigManager) ? window.CityConfigManager : null;
    if (cityConfigManager && typeof cityConfigManager.formatCurrency === 'function') {
        return cityConfigManager.formatCurrency(value);
    }
    return new Intl.NumberFormat('hr-HR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
}

// Find parcels affected by the road (LEGACY - still used for full recalculation if needed)
function findAffectedParcels(roadPolygon) {
    if (!roadPolygon || !parcelLayer) return;

    // Define the green highlight style for committed road parcels
    const committedRoadStyle = {
        fillColor: 'green',
        fillOpacity: 0.6,
        color: 'green',
        weight: 3
    };

    // Use shared function to find and highlight affected parcels
    // Skip bounds filter to include all parcels in the parcel layer
    roadAffectedParcels = findAndHighlightAffectedParcels(
        roadPolygon,
        roadAffectedParcels,
        committedRoadStyle,
        null,
        { skipBoundsFilter: true }
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
window.toggleRoadInfoPanelMinimized = toggleRoadInfoPanelMinimized;

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
            roadLengthElement.textContent = `${length.toFixed(1)} m`;
        }
        if (roadAreaElement) {
            roadAreaElement.textContent = `${area.toFixed(1)} m²`;
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
        setRoadOwnershipCounts(lockedStats.ownershipCounts);
        const marketEl = document.getElementById('road-market-price');
        if (marketEl) {
            marketEl.textContent = lockedStats.marketPrice > 0 ? formatCurrency(lockedStats.marketPrice) : '—';
        }
        updateRoadAcquiringDifficulty(roadAffectedParcels);
    } else {
        resetRoadMetricPlaceholders();
        committedRoadMetrics.length = 0;
        committedRoadMetrics.area = 0;
    }
}

// Calculate and display road/track length and area only (no parcel stats)
// Returns { length, area } for caching purposes
function updateRoadLengthAndArea(points, polygon) {
    if (!points || points.length < 2) {
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');
        if (roadLengthElement) roadLengthElement.textContent = '0 m';
        if (roadAreaElement) roadAreaElement.textContent = '0 m²';
        return { length: 0, area: 0 };
    }

    try {
        // Calculate road length in meters
        let length = 0;
        const htrsPoints = [];

        for (const p of points) {
            if (!p || !isFinite(p.lat) || !isFinite(p.lng)) continue;
            try {
                const htrsPoint = wgs84ToHTRS96(p.lat, p.lng);
                if (isValidPoint(htrsPoint)) {
                    htrsPoints.push(htrsPoint);
                }
            } catch (error) { }
        }

        if (htrsPoints.length >= 2) {
            for (let i = 0; i < htrsPoints.length - 1; i++) {
                const p1 = htrsPoints[i];
                const p2 = htrsPoints[i + 1];
                const dx = p2[0] - p1[0];
                const dy = p2[1] - p1[1];
                length += Math.sqrt(dx * dx + dy * dy);
            }
        }

        // Calculate road area
        let area = 0;
        try {
            const turfPoly = polygonLatLngsToTurfFeature(polygon);
            if (turfPoly && typeof turf !== 'undefined' && turf && typeof turf.area === 'function') {
                area = turf.area(turfPoly) || 0;
            }
        } catch (_) {
            area = 0;
        }

        // Update UI elements
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        if (roadLengthElement) {
            roadLengthElement.textContent = `${length.toFixed(1)} m`;
        }
        if (roadAreaElement) {
            roadAreaElement.textContent = `${area.toFixed(1)} m²`;
        }

        return { length, area };
    } catch (error) {
        console.error('Error in updateRoadLengthAndArea:', error);
        return { length: 0, area: 0 };
    }
}

// Update the corridor info panel with preview metrics.
// Returns { length, area } for caching purposes
function updateRoadInfoWithPreview(points, polygon, affectedParcelsToUse = null) {
    if (!points || points.length < 2) {
        // Basic initialization of the road info panel when not enough points
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        if (roadLengthElement) roadLengthElement.textContent = '0 m';
        if (roadAreaElement) roadAreaElement.textContent = '0 m²';
        return { length: 0, area: 0 };
    }

    try {
        // Calculate road length in meters
        let length = 0;
        const htrsPoints = [];

        // Convert and validate each point
        for (const p of points) {
            if (!p || !isFinite(p.lat) || !isFinite(p.lng)) {
                console.warn('Invalid point in updateRoadInfoWithPreview:', p);
                continue;
            }
            try {
                const htrsPoint = wgs84ToHTRS96(p.lat, p.lng);
                if (isValidPoint(htrsPoint)) {
                    htrsPoints.push(htrsPoint);
                }
            } catch (error) {
                console.error('Error converting point in updateRoadInfoWithPreview:', error);
            }
        }

        // Calculate length only if we have enough valid points
        if (htrsPoints.length >= 2) {
            for (let i = 0; i < htrsPoints.length - 1; i++) {
                const p1 = htrsPoints[i];
                const p2 = htrsPoints[i + 1];
                const dx = p2[0] - p1[0];
                const dy = p2[1] - p1[1];
                length += Math.sqrt(dx * dx + dy * dy);
            }
        } else {
            console.warn('Not enough valid points to calculate length');
            length = 0;
        }

        // Calculate road area
        let area = 0;
        try {
            const turfPoly = polygonLatLngsToTurfFeature(polygon);
            if (turfPoly && typeof turf !== 'undefined' && turf && typeof turf.area === 'function') {
                area = turf.area(turfPoly) || 0;
            }
        } catch (error) {
            console.error('Error calculating area in updateRoadInfoWithPreview:', error);
            area = 0;
        }

        // Update info panel - safely access each element
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        // Only update elements if they exist
        if (roadLengthElement) {
            roadLengthElement.textContent = `${length.toFixed(1)} m`;
        }

        if (roadAreaElement) {
            roadAreaElement.textContent = `${area.toFixed(1)} m²`;
        }

        // Update parcel stats if affected parcels are provided
        if (affectedParcelsToUse && Array.isArray(affectedParcelsToUse)) {
            const totalArea = affectedParcelsToUse.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
            if (affectedParcelsToUse.length > 0) {
                setRoadParcelStats(affectedParcelsToUse.length, formatParcelArea(totalArea));
            } else {
                setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
            }
            try {
                updateRoadOwnershipCounts(affectedParcelsToUse);
                updateRoadMarketPrice(affectedParcelsToUse);
                updateRoadAcquiringDifficulty(affectedParcelsToUse);
            } catch (err) {
                console.warn('road/track stats: failed to update ownership/market price', err);
            }
        }

        // Return computed metrics for caching
        return { length, area };
    } catch (error) {
        console.error('Error in updateRoadInfoWithPreview:', error);
        return { length: 0, area: 0 };
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
                const htrs1 = wgs84ToHTRS96(p1.lat, p1.lng);
                const htrs2 = wgs84ToHTRS96(p2.lat, p2.lng);
                if (isValidPoint(htrs1) && isValidPoint(htrs2)) {
                    const dx = htrs2[0] - htrs1[0];
                    const dy = htrs2[1] - htrs1[1];
                    previewLength = Math.sqrt(dx * dx + dy * dy);
                }
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
            roadLengthElement.textContent = `${totalLength.toFixed(1)} m`;
        }
        if (roadAreaElement) {
            roadAreaElement.textContent = `${totalArea.toFixed(1)} m²`;
        }
    } catch (error) {
        // Silently ignore errors during preview - non-critical
    }
}

// Function to show polygon error details in a modal
function showPolygonErrorModal(error, polygon) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('polygon-error-modal');

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'polygon-error-modal';
        modal.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                `;

        document.body.appendChild(modal);
    }

    // Format polygon points for display
    const pointsTable = polygon.map((p, i) =>
        `<tr>
                    <td>${i}</td>
                    <td>${p.lat.toFixed(6)}</td>
                    <td>${p.lng.toFixed(6)}</td>
                </tr>`
    ).join('');

    // Diagnose common polygon issues
    let diagnosticMessages = [];

    // Check if polygon is closed
    if (polygon.length > 1) {
        const firstPoint = polygon[0];
        const lastPoint = polygon[polygon.length - 1];

        if (firstPoint.lat !== lastPoint.lat || firstPoint.lng !== lastPoint.lng) {
            diagnosticMessages.push(`Polygon is not closed: first point [${firstPoint.lat.toFixed(6)}, ${firstPoint.lng.toFixed(6)}] 
                        is different from last point [${lastPoint.lat.toFixed(6)}, ${lastPoint.lng.toFixed(6)}]`);
        }
    }

    // Check for minimum points
    if (polygon.length < 4) {
        diagnosticMessages.push(`Polygon has only ${polygon.length} points, minimum 4 required.`);
    }

    // Look for duplicate consecutive points
    for (let i = 0; i < polygon.length - 1; i++) {
        const p1 = polygon[i];
        const p2 = polygon[i + 1];

        if (p1.lat === p2.lat && p1.lng === p2.lng) {
            diagnosticMessages.push(`Duplicate consecutive points found at index ${i} and ${i + 1}`);
        }
    }

    // Create content
    modal.innerHTML = `
                <div style="
                    background-color: white;
                    padding: 20px;
                    border-radius: 5px;
                    max-width: 80%;
                    max-height: 80%;
                    overflow: auto;
                ">
                    <h2 style="color: #d9534f;">Polygon Error</h2>
                    <p><strong>Error:</strong> ${error.message}</p>
                    <p><strong>Polygon Information:</strong></p>
                    <p>Number of points: ${polygon.length}</p>
                    
                    ${diagnosticMessages.length > 0 ? `
                        <div style="margin: 15px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                            <h4 style="margin-top: 0; color: #856404;">Diagnostic Information</h4>
                            <ul style="margin-bottom: 0;">
                                ${diagnosticMessages.map(msg => `<li>${msg}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    <div style="max-height: 300px; overflow-y: auto; margin-top: 15px;">
                        <table style="border-collapse: collapse; width: 100%;">
                            <thead>
                                <tr style="background-color: #f8f9fa;">
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Point #</th>
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Latitude</th>
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Longitude</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${pointsTable}
                            </tbody>
                        </table>
                    </div>
                    
                    <div style="margin-top: 20px; display: flex; justify-content: space-between;">
                        <button onclick="showPolygonOnMap(${JSON.stringify(polygon).replace(/"/g, '&quot;')});"
                                style="padding: 8px 16px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            Show on Map
                        </button>
                        <button onclick="document.getElementById('polygon-error-modal').remove();"
                                style="padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            Close
                        </button>
                    </div>
                </div>
            `;
}

// Function to visualize the problematic polygon on the map
function showPolygonOnMap(points) {
    // Clear any existing highlighted polygon
    if (window.errorPolygonLayer) {
        map.removeLayer(window.errorPolygonLayer);
    }

    if (window.errorPointsLayer) {
        map.removeLayer(window.errorPointsLayer);
    }

    // Create a polygon from the points
    window.errorPolygonLayer = L.polygon(points, {
        color: 'red',
        weight: 2,
        fillColor: 'red',
        fillOpacity: 0.2
    }).addTo(map);

    // Add markers for each point
    window.errorPointsLayer = L.featureGroup();

    points.forEach((point, index) => {
        const marker = L.circleMarker([point.lat, point.lng], {
            radius: 5,
            color: 'black',
            fillColor: index === 0 ? 'green' : (index === points.length - 1 ? 'red' : 'blue'),
            fillOpacity: 1,
            weight: 2
        }).bindTooltip(`Point ${index}: [${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}]`);

        window.errorPointsLayer.addLayer(marker);
    });

    window.errorPointsLayer.addTo(map);

    // Fit bounds to the polygon
    map.fitBounds(window.errorPolygonLayer.getBounds(), {
        padding: [50, 50]
    });

    // Close the modal
    document.getElementById('polygon-error-modal').remove();
}

// Update the road preview
function updateRoadPreview() {
    // Remove any existing preview
    if (roadPreviewPolygon) {
        map.removeLayer(roadPreviewPolygon);
        roadPreviewPolygon = null;
    }

    const segments = getAllRoadSegments(true);
    if (!segments.some(seg => Array.isArray(seg) && seg.length >= 2)) return;

    // Calculate and draw road polygon (absorbed segments keep their own widths)
    const roadPolygonPoints = buildRoadUnionPolygonWithWidths(
        segments,
        segments.map((_, index) => roadDrawingWidthForSegmentIndex(index)),
        roadWidth
    );
    if (roadPolygonPoints) {
        roadPreviewPolygon = L.polygon(roadPolygonPoints, {
            color: 'green',
            weight: 2,
            fillColor: 'green',
            fillOpacity: 0.3
        }).addTo(map);

        // Find affected parcels
        findAffectedParcels(roadPolygonPoints);
    }
}

// The panel's three buttons. One corridor tool, so there is nothing to dispatch on: a track finishes,
// undoes and closes through the same functions a road does. Finishing IS the creation: the drawing
// instantly becomes an applied object (SimCity lifecycle).
function finishRoadOrTrackDrawing() {
    if (roadDrawingMode) finishRoadDrawing();
}

function undoLastRoadOrTrackSegment() {
    if (roadDrawingMode) undoLastRoadSegment();
}

async function cancelRoadOrTrackDrawing() {
    if (roadDrawingMode) return cancelRoadDrawing();
    return false;
}

// weldCorridorSegments moved to frontend/js/corridor-geometry.js (loaded first) — merges polylines
// sharing an endpoint into one segment, keeping ids and per-segment profile overrides aligned. Now
// unit-tested. Callers below use the global unchanged.

// One connected piece = one road: finishing a drawing that touches existing LOCAL (unminted)
// corridors of the same kind absorbs them — their segments join the new definition, the oldest
// donates its name and cross-section, and the absorbed records are removed. Minted corridors
// are immutable and are never absorbed.
async function absorbConnectedLocalCorridors(kind, newGeoPolygon, draftId) {
    if (!newGeoPolygon || typeof turf === 'undefined' || typeof turf.booleanIntersects !== 'function') return null;
    const store = window.proposalDraftStore;
    const draft = store?.getDraft?.(draftId);
    if (!draft || typeof proposalStorage === 'undefined') return null;

    const drawnSegments = (typeof corridorCenterlineOf === 'function')
        ? corridorCenterlineOf(draft.editorPayload?.definition || {})
        : [];
    const draftDefinition = draft.editorPayload?.definition || {};
    // A grade-separated crossing is deliberately NOT a network connection. Keep the crossed road
    // as its own proposal instead of letting the ordinary touch/absorb pass merge it back in.
    const gradeSeparatedProposalIds = (draftDefinition.gradeSeparations || [])
        .map(record => record?.otherProposalId)
        .filter(Boolean)
        .map(String);
    // allowNearMiss: the finish path is now the deliberate-join path. The user drew this stroke to
    // START on / END on an existing road (clicking its centerline), so a road the stroke lands on — or
    // stops a hair short of — is a willing junction. Drawing no longer absorbs a road on click, so this
    // merge is the ONLY place a drawn connection becomes a real shared node; a strict exact-touch test
    // silently dropped the road the stroke started from whenever the click landed mid-span (pixel snap
    // is only pixel-precise, never within the exact-intersection tolerance).
    const targets = findTouchingLocalCorridors(kind, newGeoPolygon, gradeSeparatedProposalIds, drawnSegments, true);
    if (!targets.length) return null;
    targets.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const oldest = targets[0];

    const mergedSegments = [];
    const mergedSegmentIds = [];
    const mergedTunnels = [];
    const mergedGradeSeparations = [];
    const mergedDemolished = [];
    const mergedProfiles = {};
    const mergedParents = new Set();
    let mintedMergeId = 1;
    const collectDefinition = (definition, parents) => {
        const entries = (typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(definition) : [];
        (corridorCenterlineOf(definition) || []).forEach((segment, index) => {
            mergedSegments.push(segment.map(point => ({ lat: point.lat, lng: point.lng })));
            // Ids collide across bodies (every drawing counts s1, s2, ...): mint fresh on clash
            // so each segment's own cross-section follows ITS geometry into the merged network.
            const requested = Array.isArray(definition.segmentIds) ? (definition.segmentIds[index] || null) : null;
            let finalId = (requested && !mergedSegmentIds.includes(requested)) ? requested : null;
            while (!finalId || mergedSegmentIds.includes(finalId)) finalId = `m${mintedMergeId++}`;
            mergedSegmentIds.push(finalId);
            const entryProfile = entries[index]?.profile;
            if (entryProfile) mergedProfiles[String(finalId)] = JSON.parse(JSON.stringify(entryProfile));
        });
        (definition.tunnels || []).forEach(tunnel => mergedTunnels.push(JSON.parse(JSON.stringify(tunnel))));
        (definition.gradeSeparations || []).forEach(record => mergedGradeSeparations.push(JSON.parse(JSON.stringify(record))));
        (definition.demolishedBuildings || []).forEach(record => mergedDemolished.push(JSON.parse(JSON.stringify(record))));
        (parents || []).forEach(id => { if (id) mergedParents.add(String(id)); });
    };
    targets.forEach(proposal => collectDefinition(
        proposal.roadProposal.definition,
        proposal.roadProposal.parentParcelIds || proposal.parentParcelIds
    ));
    collectDefinition(draftDefinition, draft.fields?.parentParcelIds);

    // Weld end-to-end connections into continuous polylines (proper corners, no gaps), then
    // normalize every crossing into a shared graph node so junctions stay draggable and
    // bulldozable — including crossings made by one self-crossing source stroke.
    const welded = weldCorridorSegments(mergedSegments, mergedSegmentIds, mergedProfiles);
    mergedSegments.length = 0;
    mergedSegments.push(...welded.segments);
    mergedSegmentIds.length = 0;
    mergedSegmentIds.push(...welded.segmentIds);
    // A drawn endpoint that came to rest ON (pixel-snapped, so a hair off) or just short of a target
    // road's centerline is snapped exactly onto it and given a shared vertex, and a near-duplicate
    // vertex is welded onto its neighbour — so the connecting stroke FORMS a real junction at BOTH the
    // road it started from and the road it ended on, not only where it happened to hit an exact vertex.
    // Runs BEFORE crossing-node insertion so the healed coincidence is what normalization sees. This
    // mirrors the drag/edit path: a stroke drawn onto a road is the same willing join as a dragged node.
    if (typeof weldNearbyVertices === 'function') weldNearbyVertices(mergedSegments);
    if (typeof healNearMissJunctions === 'function') healNearMissJunctions(mergedSegments);
    normalizeCorridorGraph(
        mergedSegments,
        mergedSegmentIds,
        corridorProtectedEdgeKeySet(mergedTunnels, mergedGradeSeparations),
        mergedProfiles
    );

    // The established road donates only its NAME. Every body's segments keep their own
    // cross-section: EVERY surviving segment gets an explicit override (deliberately no
    // "same as default, skip it" pruning — rendering must never depend on the default, or a
    // single dropped override silently repaints an absorbed road with the newest profile).
    const profile = draftDefinition.profile ? JSON.parse(JSON.stringify(draftDefinition.profile)) : null;
    const width = Number(draftDefinition.width) || 10;
    const sidewalkWidth = draftDefinition.sidewalkWidth;
    const mergedDefaults = { profile, width };
    const weldedIds = new Set(mergedSegmentIds.filter(Boolean).map(String));
    Object.keys(mergedProfiles).forEach(id => { if (!weldedIds.has(id)) delete mergedProfiles[id]; });

    const mergedWidthFor = index => {
        const id = mergedSegmentIds[index];
        const override = (id !== null && id !== undefined) ? mergedProfiles[String(id)] : null;
        const overrideWidth = override && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(override) : 0;
        return overrideWidth > 0 ? overrideWidth : width;
    };
    const unionPolygon = buildRoadUnionPolygonWithWidths(
        mergedSegments,
        mergedSegments.map((_, index) => mergedWidthFor(index)),
        width
    );
    const latLngPairs = convertRoadPolygonToLatLngPairs(unionPolygon);
    const mergedPolygon = convertLatLngPairsToGeoJSON(latLngPairs);

    const mergedDefinition = attachCorridorSurfaceFootprint({
        ...JSON.parse(JSON.stringify(draftDefinition)),
        points: mergedSegments,
        segments: mergedSegments,
        segmentIds: mergedSegmentIds,
        tunnels: mergedTunnels,
        gradeSeparations: mergedGradeSeparations,
        demolishedBuildings: mergedDemolished,
        profile: mergedDefaults.profile,
        width: mergedDefaults.width,
        sidewalkWidth,
        segmentProfiles: mergedProfiles,
        polygon: (mergedPolygon && mergedPolygon.type) ? mergedPolygon : draftDefinition.polygon || null,
        latLngPairs
    });
    const mergedSurface = mergedDefinition.surfaceFootprint || mergedDefinition.polygon;
    if (mergedSurface && typeof consolidateCorridorDemolitionRecords === 'function') {
        mergedDefinition.demolishedBuildings = consolidateCorridorDemolitionRecords(
            mergedDemolished,
            { type: 'Feature', properties: {}, geometry: mergedSurface }
        );
    }

    // Absorb first: unapplying the targets restores the original parcel fabric, so the merged
    // footprint (rebuilt at the merged width) can be tested against real parcels. The declared
    // parent lists are POISON here — the connector's drawing-time detection saw the absorbed
    // roads' slice parcels, and those ids stop existing the moment the targets are removed.
    // Parents therefore come exclusively from the footprint test; the declared union is only a
    // fallback when turf is unavailable.
    for (const proposal of targets) {
        const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
        clearSelectionVisualsForRemovedProposal(proposal);
        try { await ProposalManager.unapplyProposal(key, { skipConfirm: true, skipRestoreSource: true }); } catch (_) { }
        try { proposalStorage.removeProposal(key); } catch (_) { }
    }
    let mergedParentIds = [...mergedParents];
    if (mergedPolygon && mergedPolygon.type) {
        const acquisitionPolygon = mergedSurface;
        const touchedIds = acquisitionPolygon ? collectParcelsIntersectingFootprint(acquisitionPolygon) : [];
        if (touchedIds.length) mergedParentIds = touchedIds;
    }

    store.updateDraft(draftId, {
        fields: {
            name: oldest.title || oldest.name || draft.fields?.name || '',
            parentParcelIds: mergedParentIds
        },
        editorPayload: {
            kind,
            // Built above once so parcel acquisition and building carving consume the same merged
            // surface geometry, including inherited tunnels.
            definition: mergedDefinition
        }
    }, { recordHistory: false });

    return { absorbed: targets.length, name: oldest.title || oldest.name || '' };
}

// F is an idempotent "pen up" action. The gate is acquired before any asynchronous work begins, so
// key repeat, a double-click on Finish, Escape and panel close all share one finalization run.
function finishRoadDrawing() {
    return roadFinalizationGate.run(finishRoadDrawingOnce);
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

    // No collision detection or choice dialog belongs here. Each edge was accepted only after its
    // placement check, and a later width/geometry edit owns its own check before changing the map.
    // Every genuine crossing becomes a shared graph node here. This includes two edges of the SAME
    // stroke: a closed star must be stored as simple stretches meeting at junctions, never as one
    // self-crossing strip. Near-miss snapping remains edit-only; tunnelled edges stay protected.
    normalizeCorridorGraph(
        segments,
        segmentIds,
        corridorProtectedEdgeKeySet(roadBuildingTunnels, roadGradeSeparations),
        roadSegmentProfiles
    );

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
        roadWidth
    );
    if (!finalRoadPolygon) {
        showRoadAlert('invalid_road_shape_please_try_drawing_the_road_again', 'Invalid road shape. Please try drawing the road again.');
        exitRoadDrawingMode();
        return;
    }

    // If the generated polygon self-intersects (bowtie/overlaps), rebuild using a union-correct corridor.
    // This ensures the crossing area becomes part of the final polygon (union), not a hole (evenodd).
    if (Array.isArray(finalRoadPolygon) && polygonHasSelfIntersection(finalRoadPolygon)) {
        const unionCorridor = calculateRoadPolygonRectangular(segments.flat(), roadWidth);
        if (isValidPolygonLatLngs(unionCorridor)) {
            finalRoadPolygon = unionCorridor;
        }
    }

    // Sanitize the road polygon to fix any remaining self-intersections / coordinate issues
    const sanitizedPolygon = sanitizeRoadPolygon(finalRoadPolygon);
    if (isValidPolygonLatLngs(sanitizedPolygon)) {
        finalRoadPolygon = sanitizedPolygon;
    } else {
        // If sanitization fails or produces invalid result, warn user but continue with original
        console.warn('Road polygon sanitization failed or produced invalid result, using original polygon');
    }

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

    const affectedParcels = roadAffectedParcels;
    if (affectedParcels.length === 0) {
        showRoadAlert('no_parcels_affected_by_this_road_please_try_drawing_the_road_again', 'No parcels affected by this road. Please try drawing the road again.');
        exitRoadDrawingMode();
        return;
    }

    // What was drawn is a track iff its cross-section carries rails — a "road" the user gave a tram
    // lane is a track, and a "track" whose rails were all removed is a road. The lanes decide, not the
    // button that opened the tool.
    const isTrack = corridorDrawingIsTrack();
    const corridorKind = isTrack ? 'track' : 'road';

    const defaultAuthor = (typeof getCurrentUsername === 'function' && getCurrentUsername()) || '';
    const defaultName = isTrack ? generateRandomTrackName() : generateRandomRoadName();
    const defaultOffer = isTrack ? generateRandomRoadOffer(5000, 200000) : generateRandomRoadOffer();
    const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

    const parentParcelIds = affectedParcels
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

    // Tunnelled stretches acquire nothing: parcels only under tunnel edges must not be parents.
    if (Array.isArray(roadBuildingTunnels) && roadBuildingTunnels.length) {
        const surfaceFootprint = corridorSurfaceFootprintForDefinition({
            points: centerlineSegments,
            segmentIds: centerlineSegmentIds,
            profile: roadProfile,
            width: roadWidth,
            segmentProfiles: roadSegmentProfiles,
            tunnels: roadBuildingTunnels
        });
        // A FULLY tunnelled corridor has no surface footprint: keep the declared parents (it
        // then applies and splits like a normal corridor, matching calculateChildFeatures'
        // fallback). Emptying the list failed validation and stranded the drawing as a draft.
        if (surfaceFootprint) {
            const surfaceIds = new Set(collectParcelsIntersectingFootprint(surfaceFootprint));
            for (let i = parentParcelIds.length - 1; i >= 0; i--) {
                if (!surfaceIds.has(parentParcelIds[i])) parentParcelIds.splice(i, 1);
            }
        }
    }

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
        parentParcelIds: parentParcelIds.slice(),
        centerline: centerlineSegments,
        segmentIds: centerlineSegmentIds,
        profile: roadProfile ? { strips: roadProfile.strips.map(strip => ({ ...strip })) } : null,
        polygon: geoPolygon,
        polygonOrder: 'lnglat', // Explicit: geoPolygon is GeoJSON format [lng, lat]
        latLngPairs,
        width: roadWidth,
        sidewalkWidth: roadSidewalkWidth,
        tunnels: JSON.parse(JSON.stringify(roadBuildingTunnels || [])),
        gradeSeparations: JSON.parse(JSON.stringify(roadGradeSeparations || [])),
        demolishedBuildings: JSON.parse(JSON.stringify(roadDemolishedBuildings || [])),
        segmentProfiles: (() => {
            const trimmed = {};
            centerlineSegmentIds.forEach(id => {
                if (id !== null && id !== undefined && roadSegmentProfiles[String(id)]) {
                    trimmed[String(id)] = JSON.parse(JSON.stringify(roadSegmentProfiles[String(id)]));
                }
            });
            return trimmed;
        })(),
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
            // The rail engineering limits the track was designed to; meaningless on a road.
            ...(isTrack ? { trackSpeed, trackMinRadius: trackMinCurvatureRadius } : {})
        }
    };

    if (typeof pendingRoadDrawingProposal !== 'undefined') {
        pendingRoadDrawingProposal = roadDrawingContext;
    }
    if (typeof window !== 'undefined') {
        window.pendingRoadDrawingProposal = roadDrawingContext;
    }

    // When this drawing began as a copy of an existing road, the new proposal has to record where it
    // came from. The drawing tool is the long way round to the create dialog, but the lineage travels
    // the same route as it does for every other copied goal.
    const copySource = (typeof window !== 'undefined') ? window.pendingRoadCopySource : null;
    if (typeof window !== 'undefined') window.pendingRoadCopySource = null;
    const copyPrefill = (copySource && copySource.prefill) ? copySource.prefill : {};

    // SimCity lifecycle: finishing the drawing IS the creation. The draft becomes an applied
    // object immediately (auto-named, overlaps auto-parked); click the object to edit it or add
    // proposal terms later. Drafts are created lazily on autosave — force one now if missing.
    if (!window.activeProposalDesignDraftId) saveCurrentCorridorDrawingDraft(corridorKind);
    const designDraftId = window.activeProposalDesignDraftId;
    // A finished road that touches an existing one keeps the established road's name — but that
    // naming now happens in absorbConnectedLocalCorridors (from the oldest touching road) at finish,
    // since drawing no longer absorbs a road on click.
    if (designDraftId && window.proposalDraftStore?.getDraft?.(designDraftId)) {
        window.syncActiveProposalDraftFromEditor?.('corridor', {
            ...roadDrawingContext,
            kind: corridorKind
        }, { parentParcelIds, coalesceKey: 'corridor-finalize' });
        exitRoadDrawingMode();
        const merged = await absorbConnectedLocalCorridors(corridorKind, geoPolygon, designDraftId);
        const createdId = await window.instantCreateProposalFromDraft?.(designDraftId);
        if (createdId && typeof updateStatus === 'function') {
            const mergedKey = isTrack ? 'panel.road.mergedStatusTrack' : 'panel.road.mergedStatus';
            const mergedFallback = isTrack ? 'Connected to “{{name}}” — now one track.' : 'Connected to “{{name}}” — now one road.';
            const builtKey = isTrack ? 'panel.road.builtStatusTrack' : 'panel.road.builtStatus';
            const builtFallback = isTrack ? 'Track built — click it to edit or propose.' : 'Road built — click it to edit or propose.';
            updateStatus(merged
                ? translateRoadText(mergedKey, mergedFallback, { name: merged.name })
                : translateRoadText(builtKey, builtFallback));
        }
        return;
    }

    // Legacy path (drawing started without a design draft): the classic create dialog.
    // Seed multi-parcel selection with the affected parcels so the generalized modal can open.
    // ONLY the legacy dialog reads it; the instant-create path above never opened a modal, so
    // seeding there just left multi-select stuck ON — the next map clicks then entered add-mode.
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (!multiParcelSelection.isActive && typeof multiParcelSelection.toggle === 'function') {
                multiParcelSelection.toggle({ preserveSelectedParcel: false, restoreSingleSelection: false });
            }
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            parentParcelIds.forEach(id => {
                if (!id) return;
                const layer = affectedParcels.find(p => getParcelIdFromAny(p) === id)?.layer
                    || (typeof multiParcelSelection.findParcelById === 'function' ? multiParcelSelection.findParcelById(id) : null);
                multiParcelSelection.selectedParcels.add(id);
                if (layer && typeof multiParcelSelection.addParcelHighlight === 'function') {
                    multiParcelSelection.addParcelHighlight(layer);
                }
            });
            if (typeof multiParcelSelection.updateUI === 'function') {
                multiParcelSelection.updateUI();
            }
        }
    } catch (selectionError) {
        console.warn('Failed to seed multi-parcel selection for road proposal', selectionError);
    }

    showProposalDialog({
        goal: 'road-track',
        lockGoal: true,
        acquisitionMode: 'partial-preferred',
        lockAcquisition: true,
        geometryPreset: {
            statusText: copySource
                ? `Geometry copied from "${copySource.name}" and edited by drawing`
                : 'Geometry created by drawing',
            submitted: true,
            selectedAction: 'upload',
            disableButtons: true
        },
        prefill: {
            ...copyPrefill,
            author: defaultAuthor,
            name: copyPrefill.name || defaultName,
            description: copyPrefill.description || defaultName,
            offer: Number.isFinite(copyPrefill.offer) ? copyPrefill.offer : defaultOffer
        },
        summaryStats: ownershipAndAcquisitionStats,
        copySource: copySource ? { proposalId: copySource.proposalId, name: copySource.name } : null
    });
    exitRoadDrawingMode();
    if (typeof updateStatus === 'function') {
        updateStatus('Road geometry captured.');
    }
}

// Closing the drawing tool (X button, or R again) applies what was drawn — there are no drafts,
// so anything drawable instantly becomes the object. An empty drawing just closes.
async function cancelRoadDrawing() {
    if (roadHasStarted) cancelActiveRoadStroke();
    if (getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length >= 2)) {
        await finishRoadDrawing();
        return true;
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
    roadDemolishedBuildings = [];
    roadSegmentProfiles = {};
    roadWidth = 2;
    roadProfile = null;
    roadLastValidatedWidth = roadWidth;
    roadDrawingProfileValidationPending = false;
    roadHasStarted = false;
    clearRoadSnapMarker();
    clearRoadStripLayer();
    if (roadGradeSeparationLayer && map.hasLayer(roadGradeSeparationLayer)) map.removeLayer(roadGradeSeparationLayer);
    roadGradeSeparationLayer = null;
    // Clear affected parcels highlighting BEFORE clearing the array
    clearAffectedParcels();
    roadOwnershipTypeCache.clear();
    roadOwnershipStatsRequestId++;

    // Clear segment history for undo
    roadSegmentHistory = [];

    // Reset cached committed road metrics
    committedRoadMetrics.length = 0;
    committedRoadMetrics.area = 0;

    // Reset cached committed road polygon
    cachedCommittedPolygon = null;

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
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            const layerParcelId = getRoadDrawingParcelIdFromFeature(layer.feature);
            if (layerParcelId && roadAffectedParcels.some(p => getParcelIdFromAny(p) === layerParcelId)) {
                const isRoad = typeof window.isRoadParcel === 'function' ? window.isRoadParcel(layerParcelId) : false;
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
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

function generateRandomRoadName() {
    const prefixes = [
        'Liberty', 'Oak', 'Maple', 'Harbor', 'Sunset', 'Riverside', 'Heritage', 'Unity', 'Cedar', 'Willow',
        'Silver', 'Golden', 'Evergreen', 'Aurora', 'Lakeside', 'Summit', 'Horizon', 'Meadow', 'Brook', 'Pioneer'
    ];
    const suffixes = [
        'Avenue', 'Boulevard', 'Road', 'Way', 'Street', 'Drive', 'Lane', 'Terrace', 'Parkway', 'Trail',
        'Route', 'Crescent', 'Place', 'Court', 'Loop', 'Esplanade', 'Promenade', 'Crossing', 'Rise', 'View'
    ];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] || 'New';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)] || 'Road';
    return `${prefix} ${suffix}`;
}

function generateRandomTrackName() {
    const prefixes = [
        'Main', 'Central', 'Northern', 'Southern', 'Eastern', 'Western', 'Coastal', 'Mountain', 'Valley', 'Highland',
        'Express', 'Regional', 'Local', 'Industrial', 'Freight', 'Summit', 'Frontier', 'Harbor', 'Prairie', 'Metro'
    ];
    const suffixes = [
        'Railway', 'Rail Line', 'Track', 'Railroad', 'Rail Corridor', 'Train Line', 'Rail Route', 'Branch', 'Spur', 'Connector',
        'Express Line', 'Local Line', 'Expressway', 'Corridor', 'Line', 'Loop', 'Shuttle', 'Tramway', 'Rapid', 'Metro Line'
    ];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] || 'Main';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)] || 'Railway';
    return `${prefix} ${suffix}`;
}

function generateRandomRoadOffer(min = 10000, max = 500000) {
    if (!isFinite(min) || !isFinite(max) || max <= min) {
        min = 10000;
        max = 500000;
    }
    const random = Math.random();
    const value = min + random * (max - min);
    // Round to nearest 1,000 for cleaner numbers
    return Math.round(value / 1000) * 1000;
}

function showRoadProposalModal({ defaultAuthor = '', defaultName = 'New Road', defaultOffer = 10000, affectedParcels = [], roadPolygon = null, roadPoints = null, roadWidth = null } = {}) {
    return new Promise((resolve, reject) => {
        // Gate: require personalized profile to create proposals
        if (typeof requirePersonalizedUser === 'function' && requirePersonalizedUser()) {
            resolve(null);
            return;
        }

        try {
            if (typeof closeProposalDialog === 'function') {
                closeProposalDialog();
            }
        } catch (_) { }

        const existingModal = document.querySelector('.create-proposal-modal');
        if (existingModal) {
            try { existingModal.remove(); } catch (_) { }
        }

        const totalArea = affectedParcels.reduce((sum, parcel) => sum + (parcel?.area || 0), 0);

        const modal = document.createElement('div');
        modal.className = 'create-proposal-modal road-proposal-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const parcelItems = affectedParcels.map(parcel => {
            const parcelNumber = parcel?.number || parcel?.id || 'Unknown';
            const area = parcel?.area || 0;
            return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${parcelNumber}</span><span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span></div>`;
        }).join('');

        let screenshotPolygon = convertRoadPolygonToLatLngPairs(roadPolygon);

        // Fallback to the Leaflet polygon layer if needed (supports holes / multipolygons).
        if (!isValidPolygonLatLngPairs(screenshotPolygon) && roadPolygonLayer && typeof roadPolygonLayer.getLatLngs === 'function') {
            try {
                const latLngs = roadPolygonLayer.getLatLngs();
                const converted = convertRoadPolygonToLatLngPairs(latLngs);
                if (isValidPolygonLatLngPairs(converted)) {
                    screenshotPolygon = converted;
                }
            } catch (_) { }
        }

        // Derive bounds primarily for logging/fallback contexts
        let screenshotBounds = null;
        if (roadPolygonLayer && typeof roadPolygonLayer.getBounds === 'function') {
            screenshotBounds = roadPolygonLayer.getBounds();
        } else if (isValidPolygonLatLngPairs(screenshotPolygon)) {
            screenshotBounds = buildBoundsFromLatLngPairs(screenshotPolygon);
        }

        const computedParcelPolygons = buildParcelPolygonLatLngs(affectedParcels);

        // Collect ownership and acquisition stats
        const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

        // Get lens tooltip text
        const lensTooltip = translateRoadText('modal.createProposal.lensTooltip', 'Open lens modal');

        // Build stats HTML if stats exist
        let statsHtml = '';
        if (ownershipAndAcquisitionStats) {
            const stats = ownershipAndAcquisitionStats;
            const statsItems = [];

            if (stats.individualOwners !== null) {
                statsItems.push(`<p><strong>Individual Owners:</strong> ${stats.individualOwners}</p>`);
            }
            if (stats.ownershipCounts.individual !== null) {
                statsItems.push(`<p><strong>Owned by Individuals:</strong> ${stats.ownershipCounts.individual}</p>`);
            }
            if (stats.ownershipCounts.company !== null) {
                statsItems.push(`<p><strong>Owned by Companies:</strong> ${stats.ownershipCounts.company}</p>`);
            }
            if (stats.ownershipCounts.government !== null) {
                statsItems.push(`<p><strong>Owned by Government:</strong> ${stats.ownershipCounts.government}</p>`);
            }
            if (stats.ownershipCounts.institution !== null) {
                statsItems.push(`<p><strong>Owned by Institution:</strong> ${stats.ownershipCounts.institution}</p>`);
            }
            if (stats.ownershipCounts.mixed !== null) {
                statsItems.push(`<p><strong>Ownership Mixed:</strong> ${stats.ownershipCounts.mixed}</p>`);
            }
            if (stats.totalMarketPrice !== null) {
                statsItems.push(`<p><strong>Total Market Price:</strong> ${Math.round(stats.totalMarketPrice).toLocaleString('hr-HR')} EUR</p>`);
            }
            if (stats.totalAcquiringDifficulty !== null) {
                statsItems.push(`<p><strong>Total Acquiring Difficulty:</strong> ${Math.round(stats.totalAcquiringDifficulty).toLocaleString('hr-HR')}</p>`);
            }

            if (statsItems.length > 0) {
                statsHtml = `
                    <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
                    <div class="proposal-stats-section">
                        <h4 style="margin-bottom: 10px;">Ownership & Acquisition Stats</h4>
                        <div class="summary-stats">
                            ${statsItems.join('')}
                        </div>
                    </div>
                `;
            }
        }

        modal.innerHTML = `
            <div class="proposal-modal-content">
                <div class="proposal-modal-header">
                    <h2 data-i18n-key="modal.roadWidth.roadProposal.title">Create Road Proposal</h2>
                    <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close" data-i18n-key="modal.common.close" data-i18n-attr="aria-label">&times;</button>
                </div>
                <div class="proposal-modal-body">
                    ${(isValidPolygonLatLngPairs(screenshotPolygon)) ? '<div class="form-group" id="roadProposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                    <div class="form-group">
                        <label for="roadProposalAuthor" data-i18n-key="modal.roadWidth.roadProposal.authorLabel">Author:</label>
                        <input type="text" id="roadProposalAuthor" placeholder="" data-i18n-key="modal.roadWidth.roadProposal.authorPlaceholder" data-i18n-attr="placeholder">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalName" data-i18n-key="modal.roadWidth.roadProposal.nameLabel">Road Name:</label>
                        <input type="text" id="roadProposalName" placeholder="" data-i18n-key="modal.roadWidth.roadProposal.namePlaceholder" data-i18n-attr="placeholder">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalOffer" data-i18n-key="modal.roadWidth.roadProposal.offerLabel">Offer (EUR):</label>
                        <input type="number" id="roadProposalOffer" min="0" step="1000" placeholder="" data-i18n-key="modal.roadWidth.roadProposal.offerPlaceholder" data-i18n-attr="placeholder">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalDescription" data-i18n-key="modal.roadWidth.roadProposal.descriptionLabel">Description:</label>
                        <textarea id="roadProposalDescription" rows="3" placeholder="" data-i18n-key="modal.roadWidth.roadProposal.descriptionPlaceholder" data-i18n-attr="placeholder"></textarea>
                    </div>
                    <div class="proposal-summary">
                        <div class="summary-stats">
                            <p><strong data-i18n-key="modal.roadWidth.roadProposal.summary.parcels">Parcels Affected:</strong> ${affectedParcels.length}</p>
                            <p><strong data-i18n-key="modal.roadWidth.roadProposal.summary.area">Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                        </div>
                        <div class="parcel-list">
                            <h4 data-i18n-key="modal.roadWidth.roadProposal.summary.heading">Affected Parcels:</h4>
                            ${parcelItems || `<div class="proposal-parcel-item" data-i18n-key="modal.roadWidth.roadProposal.summary.empty">No parcels detected.</div>`}
                        </div>
                    </div>
                    ${statsHtml}
                </div>
                <div class="proposal-modal-footer">
                    <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}" aria-label="${lensTooltip}">👓</button>
                    <button type="button" class="btn btn-proposal" id="roadProposalConfirmBtn" data-i18n-key="modal.roadWidth.roadProposal.submit">Create Proposal</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        // Apply translations to the modal
        if (typeof window.i18n !== 'undefined' && typeof window.i18n.applyTranslations === 'function') {
            window.i18n.applyTranslations(modal);
        } else if (typeof applyTranslations === 'function') {
            applyTranslations(modal);
        }
        if (typeof refreshLensPatternPreviews === 'function') {
            refreshLensPatternPreviews();
        }

        const authorInput = modal.querySelector('#roadProposalAuthor');
        const nameInput = modal.querySelector('#roadProposalName');
        const offerInput = modal.querySelector('#roadProposalOffer');
        const descriptionInput = modal.querySelector('#roadProposalDescription');
        const confirmButton = modal.querySelector('#roadProposalConfirmBtn');
        const closeButton = modal.querySelector('.proposal-modal-close');

        if (authorInput) authorInput.value = defaultAuthor || '';
        if (nameInput) nameInput.value = defaultName;
        if (offerInput) offerInput.value = Number.isFinite(defaultOffer) ? defaultOffer : '';

        const cleanup = () => {
            modal.removeEventListener('keydown', handleKeyDown, true);
            if (confirmButton) confirmButton.removeEventListener('click', handleSubmit);
            if (closeButton) closeButton.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleOverlayClick);
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        };

        const handleCancel = () => {
            cleanup();
            reject(new Error('cancelled'));
        };

        const handleSubmit = async () => {
            const nameValue = (nameInput?.value || '').trim() || defaultName;
            const authorValue = (authorInput?.value || '').trim() || defaultAuthor || 'User';
            const descriptionValue = (descriptionInput?.value || '').trim();
            const offerValueRaw = offerInput ? parseFloat(offerInput.value) : NaN;
            const offerValue = Number.isFinite(offerValueRaw) && offerValueRaw > 0 ? offerValueRaw : defaultOffer;

            const walletGate = await ensureRoadWalletReady();
            if (!walletGate.connected && !walletGate.proceedInMemory) {
                return; // User cancelled or did not connect
            }

            // Capture lens entries from the modal
            let lensEntries = [];
            if (typeof getLensEntries === 'function') {
                const rawLens = getLensEntries();
                if (typeof normalizeLensEntries === 'function') {
                    lensEntries = normalizeLensEntries(rawLens);
                } else if (Array.isArray(rawLens)) {
                    lensEntries = rawLens;
                }
            }

            if (offerInput) offerInput.value = offerValue;
            if (nameInput) nameInput.value = nameValue;

            // Update button to show loading state
            let originalButtonContent = null;
            if (confirmButton) {
                originalButtonContent = confirmButton.innerHTML;
                const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
                const creatingText = t
                    ? t('modal.createProposal.creating', 'Creating...')
                    : 'Creating...';
                confirmButton.disabled = true;
                confirmButton.innerHTML = `<span class="metric-spinner" aria-hidden="true"></span> ${creatingText}`;
                confirmButton.style.opacity = '0.7';
                confirmButton.style.cursor = 'wait';
            }

            // Allow UI to update
            await new Promise(resolve => setTimeout(resolve, 0));

            try {
                // Create the proposal if we have the necessary context
                const centerlineSegments = Array.isArray(roadPoints?.[0]) ? roadPoints : (roadPoints ? [roadPoints] : []);
                const hasCenterline = centerlineSegments.some(seg => Array.isArray(seg) && seg.length >= 2);
                if (hasCenterline && roadWidth && affectedParcels.length > 0) {
                    // Get the full GeoJSON features of parent parcels
                    const parentFeatures = affectedParcels.map(p => {
                        // We need a deep copy so the original features in parcelLayer are not mutated
                        return JSON.parse(JSON.stringify(p.layer.feature));
                    });

                    // Create the proposal
                    const proposalApi = (typeof Proposals !== 'undefined' && Proposals.manager) ? Proposals.manager : ProposalManager;
                    const proposalMetadata = {
                        author: authorValue,
                        offer: offerValue,
                        description: descriptionValue
                    };
                    if (ownershipAndAcquisitionStats) {
                        proposalMetadata.ownershipAndAcquisitionStats = ownershipAndAcquisitionStats;
                    }
                    const proposal = proposalApi.createProposal({
                        name: nameValue,
                        type: 'road',
                        definition: {
                            points: centerlineSegments,
                            segments: centerlineSegments,
                            width: roadWidth,
                            sidewalkWidth: roadSidewalkWidth,
                            metadata: proposalMetadata
                        },
                        parentFeatures: parentFeatures,
                        author: authorValue,
                        description: descriptionValue,
                        offer: offerValue,
                        budget: offerValue,
                        lens: lensEntries && lensEntries.length > 0 ? lensEntries : undefined
                    });

                    // Ensure lens is in the stored proposal (fallback in case it wasn't included initially)
                    if (lensEntries && lensEntries.length > 0 && proposal.proposalId && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                        try {
                            const stored = proposalStorage.getProposal(proposal.proposalId);
                            if (stored) {
                                const normalizedLens = typeof normalizeLensEntries === 'function'
                                    ? normalizeLensEntries(lensEntries)
                                    : lensEntries;
                                // Only update if stored proposal doesn't have lens or has empty lens
                                if (!stored.lens || (Array.isArray(stored.lens) && stored.lens.length === 0)) {
                                    if (normalizedLens && Array.isArray(normalizedLens) && normalizedLens.length > 0) {
                                        stored.lens = normalizedLens;
                                        // Re-index the proposal to ensure it's updated in the Map
                                        if (typeof proposalStorage._indexProposal === 'function') {
                                            proposalStorage._indexProposal(stored);
                                        }
                                        // Save to persistent storage
                                        if (typeof proposalStorage.save === 'function') {
                                            proposalStorage.save();
                                        }
                                        console.log('[showRoadProposalModal] Updated stored proposal with lens:', normalizedLens.length, 'entries');
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('Failed to update stored proposal with lens', err);
                        }
                    }

                    if (proposal && proposal.onchain) {
                        parentFeatures.forEach(feature => {
                            if (!feature || !feature.properties) return;
                            feature.properties.onchainProposal = { ...proposal.onchain };
                        });
                    }

                    // Check if proposal was created successfully
                    if (!proposal || !proposal.proposalId) {
                        // Restore button on failure
                        if (confirmButton && originalButtonContent) {
                            confirmButton.innerHTML = originalButtonContent;
                            confirmButton.disabled = false;
                            confirmButton.style.opacity = '';
                            confirmButton.style.cursor = '';
                        }
                        if (typeof showEphemeralMessage === 'function') {
                            const message = translateRoadText(
                                'ephemeral.messages.road_proposal_already_exists_or_could_not_be_saved_review_proposals_for_details',
                                'Road proposal already exists or could not be saved. Review proposals for details.'
                            );
                            showEphemeralMessage(message, 6000, 'error');
                        }
                        return;
                    }

                    // Resolve with proposal data
                    cleanup();
                    resolve({
                        roadName: nameValue,
                        author: authorValue,
                        description: descriptionValue,
                        offer: offerValue,
                        ownershipAndAcquisitionStats: ownershipAndAcquisitionStats,
                        lens: lensEntries,
                        form: {
                            ethAmount: offerValue,
                            isConditional: true
                        },
                        proposal: proposal
                    });
                } else {
                    // Fallback: resolve without creating proposal (for backward compatibility)
                    cleanup();
                    resolve({
                        roadName: nameValue,
                        author: authorValue,
                        description: descriptionValue,
                        offer: offerValue,
                        ownershipAndAcquisitionStats: ownershipAndAcquisitionStats,
                        lens: lensEntries,
                        form: {
                            ethAmount: offerValue,
                            isConditional: true
                        }
                    });
                }
            } catch (error) {
                console.error('Error creating road proposal:', error);
                // Restore button on error
                if (confirmButton && originalButtonContent) {
                    confirmButton.innerHTML = originalButtonContent;
                    confirmButton.disabled = false;
                    confirmButton.style.opacity = '';
                    confirmButton.style.cursor = '';
                }
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Failed to create road proposal. Please try again.', 5000, 'error');
                }
            }
        };

        const handleOverlayClick = (event) => {
            if (event.target === modal) {
                handleCancel();
            }
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                handleSubmit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                handleCancel();
            }
        };

        modal.addEventListener('keydown', handleKeyDown, true);
        modal.addEventListener('click', handleOverlayClick);

        if (confirmButton) confirmButton.addEventListener('click', handleSubmit);
        if (closeButton) closeButton.addEventListener('click', handleCancel);

        // Capture and display screenshot if bounds are available
        if (isValidPolygonLatLngPairs(screenshotPolygon) && window.MapScreenshot) {
            const screenshotContainer = modal.querySelector('#roadProposalScreenshotContainer');
            if (screenshotContainer) {
                (async () => {
                    try {
                        const previewWrapper = document.createElement('div');
                        previewWrapper.className = 'map-screenshot-container';
                        previewWrapper.style.margin = '0 auto';
                        screenshotContainer.appendChild(previewWrapper);

                        window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                            polygon: screenshotPolygon,
                            bounds: screenshotBounds,
                            padding: 0.05,
                            parcelPolygons: computedParcelPolygons
                        });
                    } catch (error) {
                        console.warn('Failed to capture map screenshot:', error);
                        screenshotContainer.innerHTML = '';
                        const fallbackDiv = document.createElement('div');
                        fallbackDiv.className = 'map-screenshot-container';
                        fallbackDiv.style.color = '#999';
                        fallbackDiv.textContent = 'Preview unavailable';
                        screenshotContainer.appendChild(fallbackDiv);
                    }
                })();
            }
        }

        requestAnimationFrame(() => {
            if (nameInput) {
                nameInput.focus();
                nameInput.select();
            }
        });
    });
}

// Create a rectangular segment between two road points
// createRectangularRoadSegment now lives in frontend/js/corridor-geometry.js (loaded first) so it
// is unit-tested and shared with proposal-manager.js — the two copies had diverged (this one nudged
// coincident points in a RANDOM direction; proposal-manager's returned null). The shared copy nudges
// a fixed 10 cm east, so a footprint is reproducible. Callers below use the global unchanged.

// Create a join polygon at a joint to smooth the outer connection between two segment rectangles.
// We intentionally use a *bevel* join (triangle between the joint and the two outer rectangle corners),
// instead of a miter (extending outer edges until they cross). This avoids aggressive spikes and,
// crucially for self-crossing roads, avoids producing a triangular "hole" between rectangles + join.
function createJointWedgePolygon(prevPoint, jointPoint, nextPoint, width) {
    // Validate inputs
    if (!prevPoint || !jointPoint || !nextPoint || !isFinite(width) || width <= 0) {
        return null;
    }

    if (!isFinite(prevPoint.lat) || !isFinite(prevPoint.lng) ||
        !isFinite(jointPoint.lat) || !isFinite(jointPoint.lng) ||
        !isFinite(nextPoint.lat) || !isFinite(nextPoint.lng)) {
        return null;
    }

    // Convert to HTRS96/TM meters
    const p0 = wgs84ToHTRS96(prevPoint.lat, prevPoint.lng);
    const pj = wgs84ToHTRS96(jointPoint.lat, jointPoint.lng);
    const p1 = wgs84ToHTRS96(nextPoint.lat, nextPoint.lng);

    if (!isValidPoint(p0) || !isValidPoint(pj) || !isValidPoint(p1)) {
        return null;
    }

    const v1 = [pj[0] - p0[0], pj[1] - p0[1]]; // incoming dir
    const v2 = [p1[0] - pj[0], p1[1] - pj[1]]; // outgoing dir

    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) {
        return null;
    }

    const u1 = [v1[0] / len1, v1[1] / len1];
    const u2 = [v2[0] / len2, v2[1] / len2];

    // Left normals for each segment
    const n1L = [-u1[1], u1[0]];
    const n2L = [-u2[1], u2[0]];
    // Right normals are negatives
    const n1R = [u1[1], -u1[0]];
    const n2R = [u2[1], -u2[0]];

    // Determine turn direction: positive => left turn
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const outerIsRight = cross > 0; // inner on left when turning left

    const halfWidth = width / 2;

    // Pick outer normals
    const n1 = outerIsRight ? n1R : n1L;
    const n2 = outerIsRight ? n2R : n2L;

    // Offset points at the joint on the outer side
    const pA = [pj[0] + n1[0] * halfWidth, pj[1] + n1[1] * halfWidth];
    const pB = [pj[0] + n2[0] * halfWidth, pj[1] + n2[1] * halfWidth];

    // Bevel join patch:
    // We want the only *new* visible boundary to be the bevel cut edge pA -> pB.
    // Using the centerline joint point (pj) as a vertex can leave an interior "spike" edge because pj
    // lies on the segment end-cap boundary. Instead, anchor the triangle at a point *inside* the overlap.
    const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
    const bisLen = Math.hypot(bisector[0], bisector[1]);
    if (bisLen < 1e-8) {
        // Nearly straight/degenerate outer normals: no outer gap to fill.
        return null;
    }
    const inward = [-bisector[0] / bisLen, -bisector[1] / bisLen];
    const innerAnchor = [pj[0] + inward[0] * (halfWidth * 0.25), pj[1] + inward[1] * (halfWidth * 0.25)];

    // Triangle with bevel edge [pA -> pB]. The other two edges should be interior after union.
    const wedgeHTRS = [pA, pB, innerAnchor, pA];

    // Convert back to WGS84 lat/lngs and return as Leaflet LatLng[]
    const result = [];
    for (const pt of wedgeHTRS) {
        const [lat, lng] = htrs96ToWGS84(pt[0], pt[1]);
        if (isFinite(lat) && isFinite(lng)) {
            result.push(L.latLng(lat, lng));
        }
    }

    return result.length >= 3 ? result : null;
}

// Combine two road polygons using Turf's union operation
function combineRoadPolygons(polygon1, polygon2) {
    // Validate inputs
    if (!polygon1 && polygon2) return polygon2;
    if (polygon1 && !polygon2) return polygon1;
    if (!polygon1 && !polygon2) return null;

    try {
        if (typeof turf === 'undefined' || !turf || typeof turf.union !== 'function') {
            return polygon2 || polygon1;
        }

        // Clean up polygons before attempting the union to avoid topology errors.
        const polyA = typeof sanitizeRoadPolygon === 'function' ? (sanitizeRoadPolygon(polygon1) || polygon1) : polygon1;
        const polyB = typeof sanitizeRoadPolygon === 'function' ? (sanitizeRoadPolygon(polygon2) || polygon2) : polygon2;

        // Union in local planar meters (HTRS) for robustness.
        // The corridor rectangles + bevel joins are constructed in meters and then converted to WGS84.
        // Unioning in WGS84 degrees can introduce tiny gaps that leave bevel wedges as separate triangles.
        const toHTRS = (p) => {
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
            if (typeof wgs84ToHTRS96 !== 'function') return null;
            try {
                const xy = wgs84ToHTRS96(p.lat, p.lng);
                return (Array.isArray(xy) && xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1])) ? xy : null;
            } catch (_) {
                return null;
            }
        };

        const fromHTRS = (coord) => {
            if (!Array.isArray(coord) || coord.length < 2) return null;
            const x = Number(coord[0]);
            const y = Number(coord[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            if (typeof htrs96ToWGS84 !== 'function') return null;
            try {
                const out = htrs96ToWGS84(x, y);
                if (!Array.isArray(out) || out.length < 2) return null;
                const lat = Number(out[0]);
                const lng = Number(out[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return L.latLng(lat, lng);
            } catch (_) {
                return null;
            }
        };

        if (typeof wgs84ToHTRS96 !== 'function' || typeof htrs96ToWGS84 !== 'function') {
            // Without projection helpers we cannot safely union; keep existing geometry.
            return polygon2 || polygon1;
        }

        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

        const normalizeToTurfFeature = (poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;

            // poly can be:
            // - LatLng[] (single ring)
            // - LatLng[][] (polygon with holes)
            // - LatLng[][][] (multi polygon)

            if (isLatLng(poly[0])) {
                const ring = ensurePolygonIsClosed(poly.map(toHTRS).filter(Boolean));
                if (!ring || ring.length < 4) return null;
                return turf.polygon([ring]);
            }

            if (Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                const rings = poly
                    .map(r => ensurePolygonIsClosed((Array.isArray(r) ? r : []).filter(isLatLng).map(toHTRS).filter(Boolean)))
                    .filter(r => Array.isArray(r) && r.length >= 4);
                if (!rings.length) return null;
                return turf.polygon(rings);
            }

            if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                const polys = poly
                    .map(polygonRings => (Array.isArray(polygonRings) ? polygonRings : [])
                        .map(r => ensurePolygonIsClosed((Array.isArray(r) ? r : []).filter(isLatLng).map(toHTRS).filter(Boolean)))
                        .filter(r => Array.isArray(r) && r.length >= 4))
                    .filter(rings => Array.isArray(rings) && rings.length > 0);
                if (!polys.length) return null;
                return turf.multiPolygon(polys);
            }

            return null;
        };

        const feature1 = normalizeToTurfFeature(polyA);
        const feature2 = normalizeToTurfFeature(polyB);
        if (!feature1 && feature2) return polygon2;
        if (feature1 && !feature2) return polygon1;
        if (!feature1 || !feature2) return null;

        let lastError = null;
        const tryUnion = (a, b) => turf.union(a, b);

        const combined = (() => {
            const attempts = [
                () => tryUnion(feature1, feature2),
                () => {
                    if (typeof turf.cleanCoords !== 'function') return null;
                    const f1 = turf.cleanCoords(feature1, { mutate: false }) || feature1;
                    const f2 = turf.cleanCoords(feature2, { mutate: false }) || feature2;
                    return tryUnion(f1, f2);
                },
                () => {
                    // We cannot use turf.buffer on HTRS96 coordinates as Turf projects them assuming WGS84,
                    // which completely corrupts the geometry and yields out-of-bounds coordinates (like 3M, 9.8M).
                    // Instead, we use turf.truncate to snap coordinates to a grid (e.g., 2 decimal places = cm precision),
                    // which often heals JSTS topology side location conflicts.
                    if (typeof turf.truncate !== 'function') return null;
                    const f1 = turf.truncate(feature1, { precision: 2, coordinates: 2, mutate: false }) || feature1;
                    const f2 = turf.truncate(feature2, { precision: 2, coordinates: 2, mutate: false }) || feature2;
                    return tryUnion(f1, f2);
                }
            ];

            for (const attempt of attempts) {
                try {
                    const result = attempt();
                    if (result && result.geometry) {
                        return result;
                    }
                } catch (err) {
                    lastError = err;
                }
            }

            if (lastError) throw lastError;
            return null;
        })();

        if (!combined || !combined.geometry) return polygon2 || polygon1;

        const geom = combined.geometry;
        const toLatLngRing = (ring) => (Array.isArray(ring) ? ring : []).map(fromHTRS).filter(Boolean);

        if (geom.type === 'Polygon') {
            const rings = (geom.coordinates || []).map(toLatLngRing).filter(r => r.length >= 4);
            if (!rings.length) return null;
            return rings.length === 1 ? rings[0] : rings;
        }

        if (geom.type === 'MultiPolygon') {
            const polys = (geom.coordinates || [])
                .map(polyRings => (Array.isArray(polyRings) ? polyRings : [])
                    .map(toLatLngRing)
                    .filter(r => r.length >= 4))
                .filter(rings => rings.length > 0);
            return polys.length ? polys : null;
        }

        console.error('Unexpected geometry type from union:', geom.type);
        return null;
    } catch (error) {
        console.error('Error combining road polygons:', error);
        // Fall back to the most recent polygon if there's an error
        return polygon2 || polygon1;
    }
}

if (typeof window !== 'undefined') {
    window.combineRoadPolygons = combineRoadPolygons;
}

// Check if a parcel number exists
function parcelNumberExists(number) {
    // Check parcelLayer
    if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
        let exists = false;
        window.parcelLayer.eachLayer(layer => {
            if (layer && layer.feature && layer.feature.properties &&
                layer.feature.properties.BROJ_CESTICE === number) {
                exists = true;
            }
        });
        if (exists) return true;
    }

    // Check PersistentStorage
    for (let i = 0; i < PersistentStorage.length; i++) {
        const key = PersistentStorage.key(i);
        if (key.startsWith('parcel_') && key.endsWith('_properties')) {
            try {
                const properties = JSON.parse(PersistentStorage.getItem(key));
                if (properties && properties.BROJ_CESTICE === number) {
                    return true;
                }
            } catch (e) {
                console.warn('Error parsing properties from PersistentStorage:', e);
            }
        }
    }
    return false;
}

// Find next available number
function findNextAvailableSubNumber(baseNumber, usedNumbers = new Set()) {
    let counter = 1;
    while (parcelNumberExists(`${baseNumber}/${counter}`) || usedNumbers.has(`${baseNumber}/${counter}`)) {
        counter++;
    }
    return counter;
}

// Helper function to hash geometry coordinates (rounded for robustness)
function geometryHash(coords) {
    return JSON.stringify(coords.map(ring => ring.map(
        pt => [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]
    )));
}

// Function to update parcel numbers and split parcels
// MOVED to proposal-manager.js

// Helper function to calculate area from a Leaflet polygon
function calculateAreaFromLatLngPolygon(latLngPolygon) {
    // Convert to HTRS96/TM coordinates
    const htrsCoords = latLngPolygon.map(point => wgs84ToHTRS96(point.lat, point.lng));

    // Create closed polygon
    const closedCoords = [...htrsCoords];
    if (htrsCoords.length > 0 &&
        (htrsCoords[0][0] !== htrsCoords[htrsCoords.length - 1][0] ||
            htrsCoords[0][1] !== htrsCoords[htrsCoords.length - 1][1])) {
        closedCoords.push(htrsCoords[0]);
    }

    // Calculate area
    let area = 0;
    for (let i = 0; i < closedCoords.length - 1; i++) {
        area += closedCoords[i][0] * closedCoords[i + 1][1] - closedCoords[i + 1][0] * closedCoords[i][1];
    }

    return Math.abs(area / 2);
}

// Find parcels affected by the PREVIEW SEGMENT ONLY (not the entire road)
// Uses cached locked stats + adds preview-only parcels for combined display
// PERFORMANCE: Uses mapBounds filter and avoids expensive async calls
function findPreviewAffectedParcels(previewPolygon) {
    if (!previewPolygon || !parcelLayer) return;

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

    // Get map bounds for filtering - preview only needs visible parcels for responsiveness
    let mapBounds = null;
    try {
        mapBounds = map.getBounds();
    } catch (e) {
        // Continue without bounds filtering if unavailable
    }

    const newPreviewParcels = [];

    // Find parcels that intersect with the preview polygon but aren't already locked
    // Use mapBounds filter for performance during preview
    parcelLayer.eachLayer(layer => {
        // Skip parcels outside current view for performance
        if (mapBounds) {
            try {
                const layerBounds = layer.getBounds();
                if (!mapBounds.intersects(layerBounds)) {
                    return;
                }
            } catch (e) { }
        }

        const parcelId = getRoadDrawingParcelIdFromFeature(layer.feature);
        if (!parcelId) return;

        // Skip if already locked
        if (lockedParcelIds.has(parcelId)) {
            return;
        }

        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfPolygon, turfParcelPolygon)) {
                    const parcelArea = Number(layer.feature.properties.calculatedArea) || 0;

                    newPreviewParcels.push({
                        id: parcelId,
                        number: layer.feature.properties.BROJ_CESTICE,
                        area: parcelArea,
                        estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice,
                        layer: layer
                    });

                    // Apply preview style (orange)
                    layer.setStyle(previewAffectedStyle);

                    if (typeof layer.bringToFront === 'function') {
                        layer.bringToFront();
                    }
                    break;
                }
            }
        } catch (error) { }
    });

    roadPreviewAffectedParcels = newPreviewParcels;

    // Calculate combined stats: locked stats + preview-only parcels
    const previewArea = newPreviewParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
    const combinedCount = lockedStats.parcelCount + newPreviewParcels.length;
    const combinedArea = lockedStats.totalArea + previewArea;

    // Calculate combined ownership counts and market price for live preview
    const combinedOwnershipCounts = { ...lockedStats.ownershipCounts };
    let combinedMarketPrice = lockedStats.marketPrice;
    let previewIndividualOwners = 0;

    for (const parcel of newPreviewParcels) {
        // Add market price
        combinedMarketPrice += Number(parcel.estimatedMarketPrice) || 0;

        // Get ownership type and count
        const ownershipType = getOwnershipTypeFromParcel(parcel);
        if (combinedOwnershipCounts[ownershipType] !== undefined) {
            combinedOwnershipCounts[ownershipType]++;
        } else {
            combinedOwnershipCounts.individual++;
        }

        // Count individual owners from parcel properties
        const featureProps = parcel.layer?.feature?.properties || {};
        const ownershipList = featureProps.ownershipList || [];
        if (Array.isArray(ownershipList)) {
            for (const owner of ownershipList) {
                const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                if (typeof getOwnershipType === 'function') {
                    const ownerType = getOwnershipType(ownerLabel);
                    // getOwnershipType returns 'private individual' for individuals
                    if (ownerType === 'individual' || ownerType === 'private individual' || ownerType === 'Fizička osoba') {
                        previewIndividualOwners++;
                    }
                } else {
                    // If getOwnershipType isn't available, count all owners as individuals
                    previewIndividualOwners++;
                }
            }
        } else if (!ownershipList || ownershipList.length === 0) {
            // No ownership list - assume 1 individual owner
            previewIndividualOwners++;
        }
    }

    // Update UI with combined stats
    if (combinedCount > 0) {
        setRoadParcelStats(combinedCount, formatParcelArea(combinedArea));
    } else {
        setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
    }

    // Update ownership counts
    setRoadOwnershipCounts(combinedOwnershipCounts);

    // Update market price
    const marketEl = document.getElementById('road-market-price');
    if (marketEl) {
        marketEl.textContent = combinedMarketPrice > 0 ? formatCurrency(combinedMarketPrice) : '—';
    }

    // Update individual owners count (locked + preview)
    const lockedIndividualOwners = getLockedIndividualOwnersCount();
    const totalIndividualOwners = lockedIndividualOwners + previewIndividualOwners;
    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = totalIndividualOwners > 0 ? totalIndividualOwners.toString() : '—';
    }

    // Update acquiring difficulty with combined parcels
    const combinedParcels = [...roadAffectedParcels, ...newPreviewParcels];
    updateRoadAcquiringDifficulty(combinedParcels);
}

// ============================================================================
// RAIL
//
// What is left of the old, separate track tool: the things that are true of RAILS and of nothing else.
// A train cannot take a corner as tight as a car can, so a corridor that carries a rail lane is drawn
// under a minimum curve radius, fixed by the speed the line is designed for. Everything else about a
// track — its geometry, its cross-section, its footprint, how it is drawn and rendered — is the same
// code that draws a road, above.
// ============================================================================

// Design speed in km/h, which fixes the minimum curvature radius the drawing is held to.
let trackSpeed = 120; // Default speed
let trackMinCurvatureRadius = 1000; // Default minimum radius in meters
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

        // Options: speed (km/h) -> min radius (m)
        const options = [
            { id: 'trackspeed1', speed: 50, label: '50 km/h', minRadius: 300 },
            { id: 'trackspeed2', speed: 80, label: '80 km/h', minRadius: 500 },
            { id: 'trackspeed3', speed: 120, label: '120 km/h', minRadius: 1000 },
            { id: 'trackspeed4', speed: 160, label: '160 km/h', minRadius: 2000 },
            { id: 'trackspeed5', speed: 200, label: '200 km/h', minRadius: 3500 },
            { id: 'trackspeed6', speed: 250, label: '250 km/h', minRadius: 5000 },
        ];

        // Prefill grid
        grid.innerHTML = '';
        let selectedId = (PersistentStorage.getItem('lastTrackSpeedId')) || 'trackspeed1';

        const confirmSelection = () => {
            const selected = grid.querySelector('.roadwidth-card.selected');
            if (!selected) {
                reject(new Error('No selection'));
                return;
            }
            const speed = parseFloat(selected.dataset.speed);
            const minRadius = parseFloat(selected.dataset.minRadius);
            PersistentStorage.setItem('lastTrackSpeedId', selected.dataset.id);
            modal.style.display = 'none';
            // Collapse sidebar if open
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                try { toggleSidebar(); } catch (_) { }
            }
            resolve({ speed, minRadius });
        };

        options.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.speed = String(opt.speed);
            card.dataset.minRadius = String(opt.minRadius);

            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = `${opt.label} (min radius: ${opt.minRadius}m)`;
            card.appendChild(lbl);

            card.addEventListener('click', () => {
                selectedId = opt.id;
                grid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                // Confirm immediately on click
                confirmSelection();
            });
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    card.click();
                }
            });
            grid.appendChild(card);
        });

        btnConfirm.addEventListener('click', confirmSelection);
        btnCancel.addEventListener('click', () => {
            modal.style.display = 'none';
            reject(new Error('Cancelled'));
        });

        // Handle Enter key on modal
        const handleKeydown = (ev) => {
            if (ev.key === 'Enter' && !ev.target.matches('input, textarea, select')) {
                ev.preventDefault();
                confirmSelection();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                btnCancel.click();
            }
        };
        modal.addEventListener('keydown', handleKeydown);

        modal.style.display = 'flex';
        grid.querySelector('.roadwidth-card.selected')?.focus();
    });
}

// Show dialog with acquiring difficulty explanation
function showAcquiringDifficultyDialog() {
    if (typeof document === 'undefined') return;

    const t = translateRoadText;
    const title = t('panel.road.acquiringDifficultyTitle', 'Total Estimated Acquiring Difficulty');
    const explanation = t('panel.road.acquiringDifficultyTooltip', 'Smaller is better. The acquiring difficulty is calculated based on ownership type of properties involved, with these coefficients:\nGovernment: 0\nInstitution: 0\nCompany: 1\nIndividual: 2\nThe market value of each parcel is multiplied by its ownership type and all these are summed.');
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

    const overlay = document.createElement('div');
    overlay.className = 'share-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'share-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'share-modal-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'share-modal-title';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'share-modal-close close-circle-btn close-circle-btn--lg';
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'share-modal-body';
    bodyContainer.innerHTML = formattedExplanation;
    modal.appendChild(bodyContainer);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'share-modal-actions';

    const okButton = document.createElement('button');
    okButton.type = 'button';
    okButton.className = 'btn share-modal-primary';
    okButton.textContent = okLabel;
    okButton.addEventListener('click', closeModal);
    actionsContainer.appendChild(okButton);

    modal.appendChild(actionsContainer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function onOverlayClick(event) {
        if (event.target === overlay) {
            closeModal();
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            closeModal();
        }
    }

    function closeModal() {
        try { overlay.removeEventListener('click', onOverlayClick); } catch (_) { }
        try { document.removeEventListener('keydown', onKeyDown); } catch (_) { }
        try { overlay.remove(); } catch (_) { }
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);
}

// Expose function globally
if (typeof window !== 'undefined') {
    window.showAcquiringDifficultyDialog = showAcquiringDifficultyDialog;
}
