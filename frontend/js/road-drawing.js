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
// The edge whose placement is being decided right now (buildings, crossings, structures). It is
// drawn at its real width for as long as those dialogs are open — see showPendingRoadSegment.
let roadPendingSegmentLayer = null;
let roadCenterlineLayer = null;
let roadPolygonLayer = null;
let roadMarkers = [];
let roadBuildingTunnels = [];
let roadGradeSeparations = [];
// Per-segment cross-section overrides for the segments of THIS drawing session that came in
// with their own profile (seeded edits). Keyed by segment id; drawing-new
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
let roadSurfaceBuildingIds = new Set();
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
        // Same as the applied renderer: a strip of the road's real width, not a fat polyline.
        // `weight` is pixels and record.width is metres, so the old form drew a 19 m deck 19 px
        // wide and never rescaled on zoom. A polygon is geographic, so it scales for free.
        const width = Number(record.width);
        const deck = (typeof calculateRoadPolygon === 'function' && Number.isFinite(width) && width > 0)
            ? calculateRoadPolygon([record.from, record.crossing, record.to], width)
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
    for (const edge of corridorEdgeFetchSegments(from, to)) {
        const polygon = calculateRoadPolygon(edge, width);
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
function buildRoadUnionPolygonWithWidths(segments, widths, fallbackWidth, segmentIds = null) {
    let combined = null;
    const arms = [];
    (segments || []).forEach((segment, index) => {
        if (!Array.isArray(segment) || segment.length < 2) return;
        const width = (Array.isArray(widths) && Number(widths[index]) > 0) ? Number(widths[index]) : fallbackWidth;
        const poly = calculateRoadPolygon(segment, width);
        if (poly) combined = combineRoadPolygons(combined, poly);
        const id = (Array.isArray(segmentIds) && segmentIds[index] !== undefined && segmentIds[index] !== null)
            ? String(segmentIds[index])
            : null;
        arms.push({ points: segment, width, stretchId: baseStretchId(id) });
    });
    return addSharedNodeJointWedges(combined, arms);
}

// Which ORIGINAL stretch an arm is a piece of. splitCorridorSelfJunctions derives a split piece's id
// as `${sourceId}~2`, `~3`… so everything before the first `~` names the stretch the pieces came
// from — the thing that used to be one polyline.
function baseStretchId(segmentId) {
    if (segmentId === null || segmentId === undefined) return null;
    const text = String(segmentId);
    const cut = text.indexOf('~');
    return cut === -1 ? text : text.slice(0, cut);
}

// The outer gap at a bend is filled by a joint wedge, and calculateRoadPolygonRectangular only adds
// one at a vertex INTERIOR to a polyline. The moment topology splits a road at a junction, a bend
// that was interior becomes the shared END of two arms — and the wedge silently disappears, taking a
// sliver of the footprint with it. That is not cosmetic: the corridor's take is its footprint, so a
// lost sliver re-cuts the parcels underneath, and anything standing on ground that stops being whole
// is swept off the map. (It bit a row-house proposal several junctions away from an edited node.)
//
// A joint belongs to the NODE, not to whichever polyline happens to contain it, so it is rebuilt
// here from the arms that meet — but ONLY between two pieces of the same original stretch. That
// pair is precisely what used to be one polyline bending through an interior vertex, so restoring
// its wedge restores the exact pre-split footprint and nothing else.
//
// Wedging every pair of arms at a node instead is wrong, and visibly so: at a T it fills the outer
// corners between the branch and each half of the through road, which together pave a patch on the
// FAR side of the through road — a phantom fourth arm, showing up as an extra strip of footway
// sticking out of the junction. A junction's corners are the junction treatment's business; the
// footprint only owes the road its own continuity.
function addSharedNodeJointWedges(combined, arms) {
    if (!combined || !Array.isArray(arms) || arms.length < 2) return combined;
    if (typeof createJointWedgePolygon !== 'function') return combined;

    const EPS = 1e-7;
    const nodeKey = point => `${Math.round(point.lat / EPS)},${Math.round(point.lng / EPS)}`;
    // Each arm END, with the point one step along the arm — the direction the road leaves the node.
    const endsByNode = new Map();
    const noteEnd = (node, neighbour, arm) => {
        if (!node || !neighbour) return;
        const key = nodeKey(node);
        if (!endsByNode.has(key)) endsByNode.set(key, { node, ends: [] });
        endsByNode.get(key).ends.push({ neighbour, width: arm.width, stretchId: arm.stretchId });
    };
    arms.forEach(arm => {
        const points = arm.points;
        noteEnd(points[0], points[1], arm);
        noteEnd(points[points.length - 1], points[points.length - 2], arm);
    });

    endsByNode.forEach(({ node, ends }) => {
        if (ends.length < 2) return;
        for (let a = 0; a < ends.length - 1; a += 1) {
            for (let b = a + 1; b < ends.length; b += 1) {
                // Two pieces of the same stretch, or nothing. An unidentified piece cannot be shown
                // to continue anything, so it gets no wedge either.
                if (!ends[a].stretchId || ends[a].stretchId !== ends[b].stretchId) continue;
                try {
                    // prev → joint → next, exactly as the interior-vertex call reads it. The wider
                    // arm sets the wedge, so it always reaches the outer corner that needs covering.
                    const wedge = createJointWedgePolygon(
                        ends[a].neighbour, node, ends[b].neighbour,
                        Math.max(Number(ends[a].width) || 0, Number(ends[b].width) || 0)
                    );
                    if (!wedge) continue;
                    const merged = combineRoadPolygons(combined, wedge);
                    if (merged) combined = merged;
                } catch (_) { /* a wedge is a repair, never a reason to lose the footprint */ }
            }
        }
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
        Number(definition?.width) || 10,
        // Segment ids travel too: they are how the union builder tells two pieces of one stretch
        // (whose bend still owes a joint wedge) from two different roads meeting at a junction.
        entries.map(entry => entry.segmentId)
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

// The taking geometry and cutting geometry are the same full corridor. Tunnels and grade
// separations are authored road content, but they still take the cadastral surface.
//
// The one exception is a stretch that is fully underground by LEVEL (corridor-elevation.md,
// 2026-07-12): it takes nothing, because nothing on the surface changes. Levels only exist on
// imported corridors so far, and a corridor without them yields one span per segment — byte for
// byte the previous footprint. Edge-keyed `tunnels` metadata is a different concept and still
// acquires; only an explicit -1 level is exempt.
function buildCorridorAcquisitionPolygon(definition) {
    const levels = (typeof window !== 'undefined' && window.__corridorLevels)
        || (typeof globalThis !== 'undefined' && globalThis.__corridorLevels)
        || null;
    if (!levels || typeof corridorSegmentEntries !== 'function') {
        return buildRoadUnionPolygonForDefinition(definition);
    }

    const entries = corridorSegmentEntries(definition);
    const pointLists = [];
    const widths = [];
    const stretchIds = [];
    entries.forEach(entry => {
        // Splitting happens here rather than on the definition on purpose: the union builder takes
        // plain point lists, so a segment can be cut into several without disturbing segmentIds or
        // the id-keyed profiles that carry its width.
        levels.acquiringSpans(entry.points).forEach(span => {
            pointLists.push(span);
            widths.push(entry.width);
            stretchIds.push(entry.segmentId);
        });
    });
    if (!pointLists.length) return null;
    return buildRoadUnionPolygonWithWidths(pointLists, widths, Number(definition?.width) || 10, stretchIds);
}

// Same footprint as GeoJSON — parent collection and drafts store this shape.
function corridorSurfaceFootprintForDefinition(definition) {
    const combined = buildCorridorAcquisitionPolygon(definition);
    if (!combined) return null;
    const geo = convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(combined));
    return (geo && geo.type) ? geo : null;
}

if (typeof window !== 'undefined') {
    window.buildRoadUnionPolygonForDefinition = buildRoadUnionPolygonForDefinition;
    window.buildCorridorAcquisitionPolygon = buildCorridorAcquisitionPolygon;
    window.corridorSurfaceFootprintForDefinition = corridorSurfaceFootprintForDefinition;
}

// Every geometry change re-derives the parcels the corridor now touches from the committed
// fabric. Leaflet is only a projection and never participates in the intersection decision.
function collectParcelsIntersectingFootprint(footprintGeometry) {
    if (!footprintGeometry || typeof turf === 'undefined') return [];
    const geometry = footprintGeometry.type ? footprintGeometry : { type: 'Polygon', coordinates: footprintGeometry };
    const roadFeature = { type: 'Feature', properties: {}, geometry };
    return liveRoadDrawingParcelsIntersecting(roadFeature)
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
let corridorApplyIndicatorEl = null;
function beginApplyIndicator(labelText) {
    corridorApplyIndicatorCount += 1;
    if (corridorApplyIndicatorEl || typeof document === 'undefined') return;
    const host = (typeof map !== 'undefined' && map && typeof map.getContainer === 'function') ? map.getContainer() : document.body;
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'corridor-apply-indicator';
    const spinner = document.createElement('div');
    spinner.className = 'corridor-apply-indicator__spinner';
    const label = document.createElement('span');
    label.textContent = labelText || ((typeof translateRoadText === 'function')
        ? translateRoadText('panel.road.applyingEdit', 'Applying…')
        : 'Applying…');
    el.appendChild(spinner);
    el.appendChild(label);
    host.appendChild(el);
    corridorApplyIndicatorEl = el;
    // The pointer is where the user is looking, so it carries the same news: the whole document goes
    // busy, which survives exitRoadDrawingMode() clearing the map container's inline cursor.
    try { document.body?.classList.add('corridor-busy'); } catch (_) { }
}
function endApplyIndicator() {
    corridorApplyIndicatorCount = Math.max(0, corridorApplyIndicatorCount - 1);
    if (corridorApplyIndicatorCount > 0) return;
    if (corridorApplyIndicatorEl && corridorApplyIndicatorEl.parentNode) {
        corridorApplyIndicatorEl.parentNode.removeChild(corridorApplyIndicatorEl);
    }
    corridorApplyIndicatorEl = null;
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

// What ties a local record to a copy someone else holds. The server and the chain are where a
// proposal is genuinely immutable, so once an edit changes this record's shape it has stopped being
// the thing published under those ids and must stop saying it is. The enclosing record snapshot
// restores these fields if the edit transaction fails.
function detachPublishedIdentity(record) {
    return window.CorridorAuthoring.detachPublishedIdentity(record);
}

function makeFreshRoadSnapshot(sourceProposal, definition, options = {}) {
    const clone = cloneRoadValue(sourceProposal);
    [
        'proposalId', 'proposal_id', 'id', 'hash', 'serverProposalId',
        'chainProposalId', 'tokenId', 'onchain', 'nft', 'isMinted',
        'createdAt', 'updatedAt', 'proposalDraftId', 'lens',
        'copiedFromProposalId', 'supersedesProposalIds'
    ].forEach(key => delete clone[key]);

    const sourceId = options.sourceProposalId == null ? null : String(options.sourceProposalId);
    if (sourceId) {
        clone.sourceProposalId = sourceId;
        clone.replacementOfProposalId = sourceId;
    } else {
        delete clone.sourceProposalId;
        delete clone.replacementOfProposalId;
    }

    const cleanDefinition = cloneRoadValue(definition);
    delete cleanDefinition.demolishedBuildings;
    delete cleanDefinition.demolitionScanned;
    const geometricHints = cleanDefinition.polygon
        ? collectParcelsIntersectingFootprint(cleanDefinition.polygon)
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
    const unionPolygon = buildRoadUnionPolygonForDefinition(definition);
    const latLngPairs = unionPolygon ? convertRoadPolygonToLatLngPairs(unionPolygon) : null;
    const polygon = latLngPairs ? convertLatLngPairsToGeoJSON(latLngPairs) : null;
    definition.polygon = polygon?.type ? polygon : null;
    definition.latLngPairs = polygon?.type ? latLngPairs : null;
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;
    return definition.polygon;
}

// Wrapper: every corridor geometry edit (node drag, bulldoze, delete, profile change) funnels through
// the same immutable-snapshot transaction.
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
        if (typeof updateStatus === 'function') {
            updateStatus(translateRoadText(
                'panel.road.editRevertedStatus',
                'Could not complete that road change — reverted.'
            ));
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
    if (!sourceProposal?.roadProposal?.definition || !store) return false;

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

    // The edited road is edited IN PLACE. It used to be cloned into a brand-new record with its
    // identity deleted — proposalId, hash, serverProposalId, chainProposalId, tokenId, onchain —
    // so that "the published source stays immutable". Nothing local is immutable: the server and
    // the chain hold their own copies and those are the immutable ones, so there was never a local
    // record needing protection. What the fork actually bought was a new proposal id on every node
    // drag, a supersession chain per drag, and an editor that reasoned about provenance at all.
    //
    // The published POINTERS do go, on the first edit that changes the geometry: once this record's
    // shape differs from what was uploaded or minted under that id, it is no longer that thing, and
    // keeping the pointer would have it claim an identity it no longer has.
    detachPublishedIdentity(sourceProposal);
    const wasSelected = typeof window.ProposalSelection?.is === 'function'
        && window.ProposalSelection.is(sourceKey);
    writeRoadDefinition(sourceProposal, componentDefinitions[0]);
    store._indexProposal?.(sourceProposal);

    // A disconnected remainder is a different road, not a different version of this one, so it
    // is the one thing here that really does become a new record.
    componentDefinitions.slice(1).forEach((definition, index) => {
        const stretch = makeFreshRoadSnapshot(sourceProposal, definition, {
            sourceProposalId: sourceKey
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
    store.save?.();

    // Old and new footprints provide the exact local corridor scope. Only the edited road's
    // output is discarded; corridor arrangement is recomputed there and nowhere else.
    if (sourceWasApplied) {
        const editedRecords = [sourceKey, ...extraStretchIds]
            .map(id => store.getProposal(id))
            .filter(Boolean);
        const derived = await ProposalManager.rematerializeCorridorScope?.(
            [sourceBefore, ...editedRecords],
            { _parcelMutation: mutation }
        );
        if (!derived || derived.ok !== true) {
            throw new Error('The edited road scope could not be rematerialised from the cadastre.');
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
                'The edit disconnected the road — it was split into {{count}} separate road proposals.',
                { count: componentDefinitions.length }
            ));
        }
        ProposalManager._refreshUIAfterProposalChange?.(storedReplacement);
        if (wasSelected && typeof selectAndHighlightProposal === 'function') {
            try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
            window.__openProposalDetailsCollapsed = true;
            selectAndHighlightProposal(primaryId, null, false, true);
        }
    });
    return String(primaryId);
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
// Applied corridors of the same kind are snap targets too. The click records the exact shared
// coordinate; Finish atomically inserts that node into the touched existing record as well.
function appliedCorridorSnapSegments() {
    const entries = [];
    const isTrack = corridorDrawingIsTrack();
    try {
        (proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            if (typeof corridorIsTrack === 'function' && corridorIsTrack(definition) !== isTrack) return;
            const proposalId = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
            (corridorCenterlineOf(definition) || []).forEach(segment => {
                if (Array.isArray(segment) && segment.length >= 2) entries.push({ segment, proposalId });
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
            return { distance: raw.distance, latlng, segmentIndex: raw.segmentIndex, insertAfter: raw.insertAfter, type: 'edge' };
        }
        const vertex = roadSegments[raw.segmentIndex][raw.vertexIndex];
        return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), segmentIndex: raw.segmentIndex, vertexIndex: raw.vertexIndex, type: raw.kind, atStart: raw.atStart };
    }

    const entry = externalEntries[raw.externalIndex];
    if (raw.kind === 'external-edge') {
        const from = entry.segment[raw.insertAfter];
        const to = entry.segment[raw.insertAfter + 1];
        const latlng = (from && to) ? exactPointOnEdge(from, to, raw.pixel) : pixelToLatLng(raw.pixel);
        return { distance: raw.distance, latlng, type: 'external-edge', proposalId: entry.proposalId };
    }
    const vertex = entry.segment[raw.vertexIndex];
    return { distance: raw.distance, latlng: L.latLng(vertex.lat, vertex.lng), type: raw.kind, proposalId: entry.proposalId };
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
    // Snapping onto a placed road reads differently from snapping onto this drawing's own segments:
    // a bigger blue ring says "click to form an exact junction".
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

    // Seeded segments keep their cross-section; only segments without an override use the tool profile.
    const entries = getAllRoadSegments(true)
        .map((segment, index) => ({
            points: segment,
            profile: roadDrawingSegmentOverride(index) || roadProfile,
            corridorId: 'active-drawing'
        }))
        .filter(entry => Array.isArray(entry.points) && entry.points.length >= 2);
    if (!entries.length) return restoreCorridorFill();

    // Same renderer as applied corridors — see js/corridor-render.js.
    const group = L.layerGroup();
    let drewAny = false;
    const markingsByEntry = (typeof buildCorridorLaneMarkingsForEntries === 'function')
        ? buildCorridorLaneMarkingsForEntries(entries)
        : entries.map(entry => buildCorridorLaneMarkings([entry.points], entry.profile));
    const markings = [];
    entries.forEach((entry, entryIndex) => {
        const strips = buildCorridorStrips([entry.points], entry.profile);
        if (!strips.length) {
            // A drawn segment with no strips renders as a bare dashed centerline — never
            // acceptable silently. Say WHY so field reports become diagnosable.
            console.error('[road-drawing] no strips for a drawn segment', { points: entry.points.length, profile: entry.profile });
            return;
        }
        // Trees only — bike/pedestrian lane explainers stay out of the map (cross-section
        // editor is the reference for lane meaning).
        const decorations = ((typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations([entry.points], entry.profile) : [])
            .filter(decoration => decoration.kind === 'tree');
        const segmentLayer = renderCorridorStrips(strips, {
            markings: [], decorations, junctions: [],
            // Rails come with the cross-section: a rail lane in the profile being drawn lays its track
            // right there on the map, so a track is drawn as a track from the first click.
            centerlines: [entry.points], profile: entry.profile
        });
        if (segmentLayer) {
            segmentLayer.addTo(group);
            markings.push(...(markingsByEntry[entryIndex] || []));
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
    if (typeof renderCorridorLaneMarkings === 'function') {
        renderCorridorLaneMarkings(markings, group, undefined);
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
        roadWidth,
        roadSegmentIds
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
    return candidates.filter(feature => {
        try { return turf.booleanIntersects(queryFeature, feature); }
        catch (_) { return false; }
    });
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
        feature,
        layer: getRoadDrawingPresenterLayer(id)
    };
}

function getParcelIdFromAny(parcel) {
    if (!parcel) return null;
    const fromFeature = parcel.feature ? getRoadDrawingParcelIdFromFeature(parcel.feature) : null;
    const fromProps = parcel.properties ? ensureParcelId(parcel.properties) : null;
    const raw = parcel.id ?? parcel.parcelId;
    const candidate = fromFeature || fromProps || getParcelId(raw);
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
            parcel.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            return estimatedPrice;
        }
    }

    const liveFeature = getRoadDrawingLiveFeature(targetId);
    if (liveFeature) {
        const estimatedPrice = liveFeature.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) return estimatedPrice;
        const area = Number(liveFeature.properties?.calculatedArea) || 0;
        return area * 100;
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
            parcel?.feature?.properties?.estimatedMarketPrice;
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
            parcel?.feature?.properties?.estimatedMarketPrice;
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
        const featureProps = parcel.feature?.properties || parcel.properties || {};
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
        const featureProps = parcel.feature?.properties || parcel.properties || {};
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

// Entering the drawing tool clears the map of whatever you were looking at: an open proposal, a
// selected parcel, the "At this spot" stack, a multi-selection. None of that is neutral once the
// tool is up — a selected proposal's highlighted parcels read as ground the road already claims —
// and their panels compete with the drawing panel for the same corner. Runs whether or not the
// panels happen to be open: the highlight outlives the panel that produced it.
function clearMapSelectionsForDrawing() {
    try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(true); } catch (_) { }
    try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }
    try { window.ProposalSelection?.clear?.(); } catch (_) { }
    try { window.__drillUi?.hidePanel?.(); } catch (_) { }

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
        clearMapSelectionsForDrawing();
        // Show what the corridor will actually collide with (see autoShowBuildingsForRoadDrawing).
        try { autoShowBuildingsForRoadDrawing(); } catch (_) { }

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
        return 'build';
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
        undoLastRoadSegment();
        return;
    }

    // F (or Enter) finishes the road: the drawing instantly becomes an applied object (SimCity
    // lifecycle). Enter is the natural "I'm done" key, so it mirrors the F shortcut / (F) button.
    if ((e.key === 'f' || e.key === 'F' || e.key === 'Enter') && hasDrawableCorridor()) {
        e.preventDefault();
        if (e.repeat || roadFinalizationGate.isRunning() || roadSegmentPlacementInProgress) return;
        finishRoadDrawing();
    }

    // U undoes the last segment. Both undo paths call the same function, which is itself a no-op
    // when there is nothing to undo — so neither can drift from the other, or from the (U) button.
    if (e.key === 'u' || e.key === 'U') {
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
        } else if (hasDrawableCorridor()) {
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
    // growExistingCorridorWithDrawing — never on a click.
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
        // Every decision below is about THIS edge, so it stays visible at its real width until one
        // of them commits it or refuses it.
        showPendingRoadSegment(segmentPolygon);
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
        let tunnelSubEdges = null;
        if (segmentPolygon && typeof detectLoadedBuildingTunnelIntersections === 'function') {
            // A building this drawing already tunnels keeps that decision. Continuing/extending a
            // corridor reloads its tunnels into roadBuildingTunnels (seedRoadDrawing), so a new segment
            // that grazes a building already tunnelled must NOT re-ask — same building-keyed reuse the
            // two edit paths use, so a road's relation to a building is decided once, everywhere.
            const alreadyTunnelledIds = new Set((roadBuildingTunnels || []).flatMap(record => (record?.buildingIds || []).map(String)));
            const detected = detectLoadedBuildingTunnelIntersections(segmentPolygon)
                .filter(hit => !roadSurfaceBuildingIds.has(String(hit.id)));
            const hits = detected.filter(hit => !alreadyTunnelledIds.has(String(hit.id)));
            if (hits.length) {
                const resolution = typeof resolveBuildingObstacles === 'function'
                    ? await resolveBuildingObstacles(hits, 'road')
                    : { action: 'cancel', surfaceHits: [], tunnelHits: [] };
                if (resolution.action === 'cancel') return;
                (resolution.surfaceHits || []).forEach(hit => roadSurfaceBuildingIds.add(String(hit.id)));
                {
                    const standingHits = resolution.tunnelHits || [];
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
            // Parks/squares/lakes in the way get a build-through / reroute decision only.
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
        // Whatever became of this click — committed, refused, or thrown — the edge is no longer
        // under decision. A commit has already drawn it as road; anything else undrew it.
        clearPendingRoadSegment();
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
    // The reference layer R turned on goes back the way it was.
    try { restoreBuildingsAfterRoadDrawing(); } catch (_) { }

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

// Get parcel outer ring(s) in [lng, lat] arrays from an authoritative GeoJSON feature.
function getParcelOuterRingsLngLat(feature) {
    const rings = [];
    try {
        const geom = feature?.geometry || null;
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
        const feature = parcel.feature || getRoadDrawingLiveFeature(getParcelIdFromAny(parcel));
        const rings = getParcelOuterRingsLngLat(feature);
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

    liveRoadDrawingParcelsIntersecting(turfPolygon).forEach(feature => {
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
function findNewAffectedParcelsForSegment(segmentPolygon) {
    if (!segmentPolygon || !getRoadDrawingFabric()) return [];

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
    liveRoadDrawingParcelsIntersecting(turfPolygon).forEach(feature => {
        const entry = roadDrawingParcelEntry(feature);
        if (!entry || lockedParcelIds.has(entry.id)) return;
        newParcels.push(entry);
        if (entry.layer && typeof entry.layer.setStyle === 'function') entry.layer.setStyle(committedRoadStyle);
        if (entry.layer && typeof entry.layer.bringToFront === 'function') entry.layer.bringToFront();
    });

    return newParcels;
}

// Get ownership type from parcel's feature properties
function getOwnershipTypeFromParcel(parcel) {
    const featureProps = parcel.feature?.properties || parcel.properties || {};
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
            const featureProps = parcel.feature?.properties || {};
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
        roadWidth,
        roadSegmentIds
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

// F is an idempotent "pen up" action. The gate is acquired before any asynchronous work begins, so
// key repeat, a double-click on Finish, Escape and panel close all share one finalization run.
//
// Finishing runs graph normalization, one cached-ground lookup and a local fabric derivation
// between the keypress and the finished object — and it used to happen with no sign at all that
// anything was under way. The same ref-counted spinner an applied-corridor edit uses covers the
// whole run, and the pointer goes busy with it.
function finishRoadDrawing() {
    // Nothing drawable, nothing to finish. The check belongs here rather than at each call site: the
    // F key and Escape tested it, the Finish (F) button did not, so pressing that button on an empty
    // drawing entered finalization and left again — silently before, and with a spinner flash once
    // one existed, which reads as the tool trying to build a road that was never drawn.
    if (!hasDrawableCorridor()) return Promise.resolve(false);
    return roadFinalizationGate.run(async () => {
        beginApplyIndicator(corridorFinalizationLabel());
        corridorFinishProfile = { started: nowMs(), phases: [] };
        try {
            // One yield so the indicator is painted BEFORE the synchronous geometry work, which
            // holds the main thread and would otherwise keep it from ever appearing.
            await new Promise(resolve => setTimeout(resolve, 0));
            return await finishRoadDrawingOnce();
        } finally {
            endApplyIndicator();
            reportCorridorFinishProfile();
        }
    });
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
        segmentIds
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

    markCorridorFinishPhase('corridor');

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

    markCorridorFinishPhase('parcels');

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
        }, { parentParcelIds, coalesceKey: 'corridor-finalize' });
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
                const builtFallback = isTrack ? 'Track built — click it to edit or propose.' : 'Road built — click it to edit or propose.';
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
// while the drawing still exists.
async function cancelRoadDrawing() {
    if (hasDrawableCorridor()) {
        return (await promptCloseDrawnCorridor()) !== 'keep';
    }
    if (roadHasStarted) cancelActiveRoadStroke();
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
    roadWidth = 2;
    roadProfile = null;
    roadLastValidatedWidth = roadWidth;
    roadDrawingProfileValidationPending = false;
    roadHasStarted = false;
    clearRoadSnapMarker();
    clearPendingRoadSegment();
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
                    const selectedParcelIds = affectedParcels.map(getParcelIdFromAny).filter(Boolean);

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
                        parentParcelIds: selectedParcelIds,
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
        return null;
    }
}

if (typeof window !== 'undefined') {
    window.combineRoadPolygons = combineRoadPolygons;
}

// Check if a parcel number exists
function parcelNumberExists(number) {
    const fabric = getRoadDrawingFabric();
    if (!fabric || typeof fabric.list !== 'function') return false;
    return fabric.list({ includeCorridors: true }).some(feature => (
        feature?.properties?.BROJ_CESTICE === number
    ));
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

    liveRoadDrawingParcelsIntersecting(turfPolygon).forEach(feature => {
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
        const featureProps = parcel.feature?.properties || {};
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
