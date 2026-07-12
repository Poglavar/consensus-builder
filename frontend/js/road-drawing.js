// Hide road info panel
function hideRoadInfoPanel() {
    document.getElementById('road-info-panel').classList.remove('visible');
}

// Road drawing tool variables
let roadDrawingMode = false;
// Other modules (node-edit mode, draft overlay) react to drawing mode starting/stopping.
function announceCorridorDrawingModeChange() {
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('corridor-drawing-mode-changed', {
                detail: { road: roadDrawingMode, track: typeof trackDrawingMode !== 'undefined' ? trackDrawingMode : false }
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
// Make trackDrawingMode globally accessible so other modules can check it
function updateGlobalTrackDrawingMode(value) {
    trackDrawingMode = value;
    if (typeof window !== 'undefined') {
        window.trackDrawingMode = value;
    }
    announceCorridorDrawingModeChange();
}

function shouldRestoreParcelClickInteractivity() {
    if (typeof window !== 'undefined' && typeof window.isParcelDrawingModeActive === 'function') {
        return !window.isParcelDrawingModeActive();
    }
    return !roadDrawingMode && !trackDrawingMode;
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
let roadPreviewPolygon = null;
let roadAffectedParcels = [];
let roadMouseMarker = null;
let roadHasStarted = false;
let roadPreviewPolygonLayer = null;
let roadCenterlineLayer = null;
let roadPolygonLayer = null;
let roadMarkers = [];
let roadBuildingTunnels = [];
let roadBuildingTunnelLayer = null;
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

function refreshTrackBuildingTunnelLayer() {
    if (trackBuildingTunnelLayer && map.hasLayer(trackBuildingTunnelLayer)) map.removeLayer(trackBuildingTunnelLayer);
    trackBuildingTunnelLayer = buildDrawingTunnelLayer(trackBuildingTunnels, '#4c1d95');
    if (trackBuildingTunnelLayer) trackBuildingTunnelLayer.addTo(map);
}

// Width/profile edits can make a previously clear edge touch a building. Recheck every committed edge
// before proposal creation and offer one combined decision for all newly discovered passages.
async function ensureBuildingTunnelsForSegments(segments, width, kind, records, segmentIds = []) {
    const list = Array.isArray(records) ? records.slice() : [];
    if (typeof detectLoadedBuildingTunnelIntersections !== 'function'
        || typeof corridorTunnelEdgeKey !== 'function') return { accepted: true, records: list };
    const missing = [];
    const combinedHits = new Map();
    (segments || []).forEach((segment, segmentIndex) => {
        for (let pointIndex = 0; pointIndex < segment.length - 1; pointIndex++) {
            const from = segment[pointIndex];
            const to = segment[pointIndex + 1];
            const edgeKey = corridorTunnelEdgeKey(from, to);
            if (!edgeKey) continue;
            const existing = list.find(record => record?.edgeKey === edgeKey) || null;
            const polygon = calculateRoadPolygon([from, to], width);
            const hits = polygon ? detectLoadedBuildingTunnelIntersections(polygon) : [];
            const existingIds = new Set((existing?.buildingIds || []).map(String));
            const newHits = hits.filter(hit => !existingIds.has(String(hit.id)));
            if (!newHits.length) continue;
            newHits.forEach(hit => combinedHits.set(hit.id, hit));
            const mergedHits = [
                ...(existing?.buildingIds || []).map(id => ({ id })),
                ...hits
            ];
            missing.push({ from, to, hits: mergedHits, segmentId: segmentIds[segmentIndex] || (kind === 'track' ? 'track' : null) });
        }
    });
    if (!missing.length) return { accepted: true, records: list };
    const resolution = typeof resolveBuildingObstacles === 'function'
        ? await resolveBuildingObstacles(Array.from(combinedHits.values()), kind)
        : { action: 'cancel', removedProposalIds: [] };
    if (resolution.action === 'cancel') return { accepted: false, records: list };
    if (resolution.action === 'clear') return { accepted: true, records: list };
    const removedOwners = new Set(resolution.removedProposalIds || []);
    const hitStillStands = hit => {
        const owner = typeof corridorTunnelHitProposalId === 'function' ? corridorTunnelHitProposalId(hit) : null;
        return !owner || !removedOwners.has(owner);
    };
    missing.forEach(edge => {
        const standingHits = edge.hits.filter(hitStillStands);
        if (!standingHits.length) return;
        const record = makeBuildingTunnelRecord(edge.from, edge.to, standingHits, { segmentId: edge.segmentId });
        if (record) addBuildingTunnelRecord(list, record);
    });
    return { accepted: true, records: list };
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

// Track segment history for undo functionality
// Each entry stores the parcels that were locked by that segment
let roadSegmentHistory = []; // Array of { parcelIds: Set, stats: {...} }
let trackSegmentHistory = []; // Array of { parcelIds: Set, stats: {...} }

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

// Global function to check if a parcel is locked for road drawing
// This allows other modules (like parcels/styles.js) to preserve road highlighting
function isParcelLockedForRoadDrawing(parcelId) {
    if (!parcelId) return false;
    return lockedParcelIds.has(parcelId.toString());
}
// Expose globally
if (typeof window !== 'undefined') {
    window.isParcelLockedForRoadDrawing = isParcelLockedForRoadDrawing;
}

// Global function to check if a parcel is committed for track drawing
// This allows other modules (like parcels/selection.js) to preserve track highlighting
function isParcelCommittedForTrackDrawing(parcelId) {
    if (!parcelId) return false;
    return lockedTrackParcelIds.has(parcelId.toString());
}
// Expose globally
if (typeof window !== 'undefined') {
    window.isParcelCommittedForTrackDrawing = isParcelCommittedForTrackDrawing;
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
        const parcelId = getParcelIdFromFeature(layer.feature);
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
// Straight-line segment intersection in lat/lng space (fine at parcel scale). Returns the
// crossing point when the two edges genuinely cross, null for parallel/disjoint edges.
function planarSegmentIntersection(a1, a2, b1, b2) {
    const d1x = a2.lng - a1.lng;
    const d1y = a2.lat - a1.lat;
    const d2x = b2.lng - b1.lng;
    const d2y = b2.lat - b1.lat;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-18) return null;
    const t = ((b1.lng - a1.lng) * d2y - (b1.lat - a1.lat) * d2x) / denom;
    const u = ((b1.lng - a1.lng) * d1y - (b1.lat - a1.lat) * d1x) / denom;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { lat: a1.lat + t * d1y, lng: a1.lng + t * d1x };
}

// Wherever two centerline segments cross, both get a vertex at the crossing point. That makes
// junctions real graph nodes: draggable, bulldozable, and honest for connectivity checks.
function insertCorridorCrossingNodes(segments, segmentIds) {
    const EPS = 1e-7;
    const near = (p, q) => p && q && Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 200) {
        changed = false;
        outer:
        for (let i = 0; i < segments.length; i += 1) {
            for (let j = i + 1; j < segments.length; j += 1) {
                const A = segments[i];
                const B = segments[j];
                for (let ai = 0; ai < A.length - 1; ai += 1) {
                    for (let bi = 0; bi < B.length - 1; bi += 1) {
                        const x = planarSegmentIntersection(A[ai], A[ai + 1], B[bi], B[bi + 1]);
                        if (!x) continue;
                        let inserted = false;
                        if (!near(x, A[ai]) && !near(x, A[ai + 1])) {
                            A.splice(ai + 1, 0, { lat: x.lat, lng: x.lng });
                            if (Array.isArray(segmentIds)) segmentIds[i] = null;
                            inserted = true;
                        }
                        if (!near(x, B[bi]) && !near(x, B[bi + 1])) {
                            B.splice(bi + 1, 0, { lat: x.lat, lng: x.lng });
                            if (Array.isArray(segmentIds)) segmentIds[j] = null;
                            inserted = true;
                        }
                        if (inserted) {
                            changed = true;
                            break outer;
                        }
                    }
                }
            }
        }
    }
}

// Connected components of a segment set: segments sharing any coincident vertex belong to one
// body. Used to split a road proposal when an edit disconnects it.
function corridorConnectedComponents(segments, segmentIds) {
    const EPS = 1e-7;
    const near = (p, q) => Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
    const parent = segments.map((_, index) => index);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (i, j) => { parent[find(j)] = find(i); };
    for (let i = 0; i < segments.length; i += 1) {
        for (let j = i + 1; j < segments.length; j += 1) {
            if (find(i) === find(j)) continue;
            const touches = segments[i].some(p => segments[j].some(q => near(p, q)));
            if (touches) union(i, j);
        }
    }
    const groups = new Map();
    segments.forEach((segment, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, { segments: [], segmentIds: [], length: 0 });
        const group = groups.get(root);
        group.segments.push(segment);
        group.segmentIds.push(Array.isArray(segmentIds) ? (segmentIds[index] || null) : null);
        group.length += (typeof calculateSegmentLengthMeters === 'function') ? calculateSegmentLengthMeters(segment) : segment.length;
    });
    return [...groups.values()].sort((a, b) => b.length - a.length);
}

// Do two centerline sets genuinely connect — sharing a vertex or crossing? Footprint overlap
// alone (two parallel roads grazing each other's width) is not a connection: merging those
// would create a disconnected body that immediately splits back apart.
function centerlinesTouch(segmentsA, segmentsB) {
    const EPS = 1e-7;
    const near = (p, q) => Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
    for (const a of segmentsA) {
        for (const b of segmentsB) {
            if (a.some(p => b.some(q => near(p, q)))) return true;
            for (let i = 0; i < a.length - 1; i += 1) {
                for (let j = 0; j < b.length - 1; j += 1) {
                    if (planarSegmentIntersection(a[i], a[i + 1], b[j], b[j + 1])) return true;
                }
            }
        }
    }
    return false;
}

// Applied LOCAL corridors of the given kind whose geometry genuinely connects to the given
// centerline — the merge candidates. Minted corridors are immutable and never merge.
function findTouchingLocalCorridors(kind, footprintGeometry, excludeKeys = [], centerlineSegments = null) {
    if (!footprintGeometry || typeof turf === 'undefined' || typeof turf.booleanIntersects !== 'function') return [];
    if (typeof proposalStorage === 'undefined') return [];
    const excluded = new Set((excludeKeys || []).map(String));
    const geometry = footprintGeometry.type ? footprintGeometry : { type: 'Polygon', coordinates: footprintGeometry };
    const feature = { type: 'Feature', properties: {}, geometry };
    return (proposalStorage.getAllProposals?.() || []).filter(proposal => {
        const definition = proposal?.roadProposal?.definition;
        if (!definition || !definition.polygon) return false;
        if ((kind === 'track') !== (definition.metadata?.isTrack === true)) return false;
        const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
        if (excluded.has(String(key))) return false;
        const applied = ['applied', 'executed'].includes(String(proposal.roadProposal.status || '').toLowerCase())
            || ['applied', 'executed'].includes(String(proposal.status || '').toLowerCase());
        if (!applied) return false;
        if (typeof isProposalMinted === 'function' && isProposalMinted(proposal)) return false;
        try {
            const target = definition.polygon.type ? definition.polygon : { type: 'Polygon', coordinates: definition.polygon };
            if (!turf.booleanIntersects(feature, { type: 'Feature', properties: {}, geometry: target })) return false;
        } catch (_) { return false; }
        if (Array.isArray(centerlineSegments) && centerlineSegments.length) {
            const targetSegments = (typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(definition) : [];
            return centerlinesTouch(centerlineSegments, targetSegments);
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
    const unionPolygon = buildRoadUnionPolygonFromSegments(component.segments, width);
    const latLngPairs = convertRoadPolygonToLatLngPairs(unionPolygon);
    const polygon = convertLatLngPairsToGeoJSON(latLngPairs);
    const definition = {
        ...JSON.parse(JSON.stringify(baseDefinition)),
        points: component.segments,
        segments: component.segments,
        segmentIds: component.segmentIds,
        tunnels: [],
        polygon: (polygon && polygon.type) ? polygon : null,
        latLngPairs
    };

    const clone = JSON.parse(JSON.stringify(baseProposal));
    ['proposalId', 'proposal_id', 'id', 'hash', 'chainProposalId', 'tokenId', 'onchain', 'nft',
        'createdAt', 'updatedAt', 'childParcelIds', 'acceptedParcelIds', 'ownerAcceptances',
        'executedAt', 'appliedAt', 'replacementLifecycle', 'supersedesProposalIds',
        'sourceProposalId', 'replacementOfProposalId', 'proposalDraftId', 'lens'
    ].forEach(key => delete clone[key]);
    const name = (typeof generateDefaultProposalName === 'function')
        ? generateDefaultProposalName(definition.metadata?.isTrack ? 'Track' : 'Road')
        : `Road ${latLngPairs?.length || ''}`;
    clone.title = name;
    clone.name = name;
    clone.proposalName = name;
    clone.status = 'unapplied';
    clone.definition = JSON.parse(JSON.stringify(definition));
    clone.geometry = { ...(clone.geometry || {}), roadPlan: JSON.parse(JSON.stringify(definition)) };
    if (definition.polygon) clone.geometry.roadGeometry = { polygon: JSON.parse(JSON.stringify(definition.polygon)) };
    const parents = definition.polygon ? collectParcelsIntersectingFootprint(definition.polygon) : [];
    clone.parentParcelIds = parents.slice();
    clone.roadProposal = {
        ...JSON.parse(JSON.stringify(clone.roadProposal || {})),
        definition: JSON.parse(JSON.stringify(definition)),
        parentParcelIds: parents.slice(),
        childParcelIds: [],
        status: 'unapplied'
    };

    const newId = (typeof proposalStorage !== 'undefined') ? proposalStorage.addProposal(clone) : null;
    if (!newId) return null;
    try { ProposalManager._linkProposalToAncestors?.(newId, parents); } catch (_) { }
    try {
        await ProposalManager.applyProposal(newId, { applyAnyway: true, suppressMissingParentAlerts: true });
    } catch (error) {
        console.warn('[createRoadProposalFromComponent] Apply of split-off road failed', error);
    }
    try { window.scheduleProposalScreenshotRefresh?.(newId); } catch (_) { }
    return newId;
}

async function updateLocalCorridorGeometry(proposalIdOrHash, mutateDefinition) {
    const proposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalIdOrHash) : null;
    if (!proposal || !proposal.roadProposal || !proposal.roadProposal.definition) return false;
    if (typeof isProposalMinted === 'function' && isProposalMinted(proposal)) return false;

    const definition = proposal.roadProposal.definition;
    if (typeof mutateDefinition === 'function') mutateDefinition(definition);

    // Normalize the (possibly mutated) centerline, make crossings real nodes, then check
    // whether the edit disconnected the body.
    const normalizedSegments = ((typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(definition) : [])
        .map(segment => segment.map(point => ({ lat: point.lat, lng: point.lng })))
        .filter(segment => segment.length >= 2);
    const normalizedIds = Array.isArray(definition.segmentIds) ? definition.segmentIds.slice(0, normalizedSegments.length) : [];
    const key0 = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;

    // Bulldozed to nothing: the object simply ceases to exist.
    if (!normalizedSegments.length) {
        try { await ProposalManager.unapplyProposal(key0, { skipConfirm: true }); } catch (_) { }
        try { proposalStorage.removeProposal(key0); } catch (_) { }
        try { window.ProposalSelection?.clear?.(); } catch (_) { }
        try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }
        try { ProposalManager._refreshUIAfterProposalChange?.(null); } catch (_) { }
        if (typeof updateStatus === 'function') {
            updateStatus(translateRoadText('panel.road.bulldozedAllStatus', 'Road bulldozed.'));
        }
        return true;
    }

    // Merge-on-connect works on drags too: if the moved geometry now touches other local
    // corridors of the same kind, they are absorbed into this road (the oldest body still
    // donates name and cross-section) before crossings and connectivity are worked out.
    const kind = definition.metadata?.isTrack === true ? 'track' : 'road';
    const prelimWidth = Number(definition.width) || 10;
    const prelimUnion = buildRoadUnionPolygonFromSegments(normalizedSegments, prelimWidth);
    const prelimPolygon = convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(prelimUnion));
    const touchingRoads = (prelimPolygon && prelimPolygon.type)
        ? findTouchingLocalCorridors(kind, prelimPolygon, [key0], normalizedSegments)
        : [];
    let mergedName = null;
    if (touchingRoads.length) {
        const bodies = [proposal, ...touchingRoads];
        bodies.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const oldest = bodies[0];
        const oldestDefinition = oldest.roadProposal.definition;
        if (oldest !== proposal) {
            mergedName = oldest.title || oldest.name || null;
            if (oldestDefinition.profile) definition.profile = JSON.parse(JSON.stringify(oldestDefinition.profile));
            if (Number(oldestDefinition.width)) definition.width = Number(oldestDefinition.width);
            if (oldestDefinition.sidewalkWidth !== undefined) definition.sidewalkWidth = oldestDefinition.sidewalkWidth;
        }
        for (const target of touchingRoads) {
            const targetDefinition = target.roadProposal.definition;
            (corridorCenterlineOf(targetDefinition) || []).forEach((segment, index) => {
                if (segment.length < 2) return;
                normalizedSegments.push(segment.map(point => ({ lat: point.lat, lng: point.lng })));
                normalizedIds.push(Array.isArray(targetDefinition.segmentIds) ? (targetDefinition.segmentIds[index] || null) : null);
            });
            (targetDefinition.tunnels || []).forEach(tunnel => {
                definition.tunnels = definition.tunnels || [];
                definition.tunnels.push(JSON.parse(JSON.stringify(tunnel)));
            });
            const targetKey = (typeof getProposalKey === 'function' ? getProposalKey(target) : null) || target.proposalId;
            try { await ProposalManager.unapplyProposal(targetKey, { skipConfirm: true }); } catch (_) { }
            try { proposalStorage.removeProposal(targetKey); } catch (_) { }
        }
        if (mergedName) {
            proposal.title = mergedName;
            proposal.name = mergedName;
            proposal.proposalName = mergedName;
        }
        const rewelded = weldCorridorSegments(normalizedSegments, normalizedIds);
        normalizedSegments.length = 0;
        normalizedSegments.push(...rewelded.segments);
        normalizedIds.length = 0;
        normalizedIds.push(...rewelded.segmentIds);
        if (typeof updateStatus === 'function') {
            const firstName = touchingRoads[0].title || touchingRoads[0].name || 'road';
            updateStatus(translateRoadText('panel.road.mergedStatus', 'Connected to “{{name}}” — now one road.', { name: mergedName || firstName }));
        }
    }

    insertCorridorCrossingNodes(normalizedSegments, normalizedIds);
    const components = corridorConnectedComponents(normalizedSegments, normalizedIds);
    const splitOff = components.slice(1);
    definition.points = components[0].segments;
    definition.segments = components[0].segments;
    definition.segmentIds = components[0].segmentIds;

    // Rebuild the footprint from the (possibly moved) centerline and current width.
    const segments = definition.points;
    const profile = (typeof corridorProfileOf === 'function') ? corridorProfileOf(definition) : null;
    const width = Number(definition.width)
        || (profile && typeof corridorProfileWidth === 'function' ? corridorProfileWidth(profile) : 0)
        || 10;
    if (segments.length) {
        const unionPolygon = buildRoadUnionPolygonFromSegments(segments, width);
        const latLngPairs = convertRoadPolygonToLatLngPairs(unionPolygon);
        const geoPolygon = convertLatLngPairsToGeoJSON(latLngPairs);
        if (geoPolygon && geoPolygon.type && Array.isArray(geoPolygon.coordinates)) {
            definition.polygon = geoPolygon;
            definition.latLngPairs = latLngPairs;
        }
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
            await ProposalManager.unapplyProposal(key, { skipConfirm: true });
            // With the old cuts undone, the original parcel fabric is back — re-derive which
            // parcels the moved/widened corridor actually touches now, so the re-apply cuts
            // every parcel under the new footprint (not just the ones declared at draw time).
            // The intersection test only sees LOADED parcels, so a declared parent is dropped
            // only when its layer is loaded and provably no longer touched; parents outside
            // the current view stay declared — otherwise their slices ghost forever.
            const acquisitionPolygon = (Array.isArray(definition.tunnels) && definition.tunnels.length)
                ? corridorSurfaceFootprintGeoJSON(definition.points, width, definition.tunnels)
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
        // The stored thumbnail shows the OLD footprint now — regenerate it quietly.
        try { window.scheduleProposalScreenshotRefresh?.(key); } catch (_) { }
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
const ROAD_SNAP_PIXELS = 12;
let roadSnapMarker = null;

// Closest point to `p` on the pixel segment ab, clamped to the segment.
function projectPointOnPixelSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return L.point(a.x, a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return L.point(a.x + t * dx, a.y + t * dy);
}

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
            const applied = ['applied', 'executed'].includes(String(proposal.roadProposal.status || '').toLowerCase())
                || ['applied', 'executed'].includes(String(proposal.status || '').toLowerCase());
            if (!applied) return;
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
    const p = map.latLngToLayerPoint(latlng);
    const activeIndex = roadHasStarted ? roadSegments.indexOf(roadPoints) : -1;
    let best = null;

    roadSegments.forEach((segment, segmentIndex) => {
        if (!Array.isArray(segment) || !segment.length) return;
        segment.forEach((vertex, vertexIndex) => {
            // The vertex we are drawing from is not a snap target — it would add a zero-length edge.
            if (segmentIndex === activeIndex && vertexIndex === segment.length - 1) return;
            const distance = p.distanceTo(map.latLngToLayerPoint(vertex));
            if (distance > ROAD_SNAP_PIXELS) return;
            if (best && distance >= best.distance) return;
            const isEndpoint = vertexIndex === 0 || vertexIndex === segment.length - 1;
            best = {
                distance,
                latlng: L.latLng(vertex.lat, vertex.lng),
                segmentIndex,
                vertexIndex,
                type: isEndpoint ? 'endpoint' : 'vertex',
                atStart: vertexIndex === 0
            };
        });
    });
    if (best) return best;

    roadSegments.forEach((segment, segmentIndex) => {
        if (!Array.isArray(segment) || segment.length < 2) return;
        // Never insert a node into the segment being drawn: it is about to grow anyway, and a
        // self-insertion would renumber the vertices under the active pointer.
        if (segmentIndex === activeIndex) return;
        for (let i = 0; i < segment.length - 1; i++) {
            const a = map.latLngToLayerPoint(segment[i]);
            const b = map.latLngToLayerPoint(segment[i + 1]);
            const projected = projectPointOnPixelSegment(p, a, b);
            const distance = p.distanceTo(projected);
            if (distance > ROAD_SNAP_PIXELS) continue;
            if (best && distance >= best.distance) continue;
            best = {
                distance,
                latlng: map.layerPointToLatLng(projected),
                segmentIndex,
                insertAfter: i,
                type: 'edge'
            };
        }
    });
    if (best) return best;

    // Placed roads on the map: snap onto their centerlines so a connector attaches exactly.
    // External snaps carry the touched proposal — clicking one absorbs a local road into the
    // drawing session on the spot (minted roads only donate the snap position).
    appliedCorridorSnapSegments().forEach(({ segment, proposalId, minted }) => {
        segment.forEach((vertex, vertexIndex) => {
            const isEndpoint = vertexIndex === 0 || vertexIndex === segment.length - 1;
            if (!isEndpoint) return;
            const distance = p.distanceTo(map.latLngToLayerPoint(vertex));
            if (distance > ROAD_SNAP_PIXELS) return;
            if (best && distance >= best.distance) return;
            best = { distance, latlng: L.latLng(vertex.lat, vertex.lng), type: 'external-endpoint', proposalId, minted };
        });
        for (let i = 0; i < segment.length - 1; i++) {
            const a = map.latLngToLayerPoint(segment[i]);
            const b = map.latLngToLayerPoint(segment[i + 1]);
            const projected = projectPointOnPixelSegment(p, a, b);
            const distance = p.distanceTo(projected);
            if (distance > ROAD_SNAP_PIXELS) continue;
            if (best && distance >= best.distance) continue;
            best = { distance, latlng: map.layerPointToLatLng(projected), type: 'external-edge', proposalId, minted };
        }
    });
    return best;
}

// Clicking a snap on a LOCAL applied road while drawing pulls that road into the drawing
// session immediately: its segments join the live preview (mitered corners, junction fills
// render right away instead of at finish), its cross-section and name carry over, and the old
// record disappears — finishing simply creates the combined road.
let absorbedRoadIdentity = null;

async function absorbAppliedRoadIntoDrawing(snap) {
    if (!snap || !snap.proposalId || snap.minted) return false;
    const proposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(snap.proposalId) : null;
    const definition = proposal?.roadProposal?.definition;
    if (!proposal || !definition) return false;
    if (definition.metadata?.isTrack === true) return false; // road session absorbs roads only

    if (!absorbedRoadIdentity) {
        absorbedRoadIdentity = { name: proposal.title || proposal.name || '' };
    }
    const profile = (typeof corridorProfileOf === 'function') ? corridorProfileOf(definition) : null;
    if (profile && Array.isArray(profile.strips)) {
        roadProfile = { strips: profile.strips.map(strip => ({ ...strip })) };
    }
    if (Number(definition.width)) roadWidth = Number(definition.width);
    if (definition.sidewalkWidth !== undefined && definition.sidewalkWidth !== null) {
        roadSidewalkWidth = definition.sidewalkWidth;
        if (typeof window !== 'undefined') window.roadSidewalkWidth = roadSidewalkWidth;
    }

    const segments = (typeof corridorCenterlineOf === 'function' ? corridorCenterlineOf(definition) : [])
        .map(segment => segment.map(point => L.latLng(point.lat, point.lng)));
    const ids = Array.isArray(definition.segmentIds) ? definition.segmentIds.slice() : [];

    const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
    try { await ProposalManager.unapplyProposal(key, { skipConfirm: true }); } catch (_) { }
    try { proposalStorage.removeProposal(key); } catch (_) { }

    segments.forEach((segment, index) => {
        if (segment.length >= 2) pushRoadSegment(segment, ids[index] || null);
    });
    const rebuilt = rebuildRoadGeometryFromSegments();
    recomputeLockedParcelsFromPolygon(rebuilt, false);
    redrawRoadVertexMarkers();
    updateRoadInfoPanel();
    if (typeof updateRoadCrossSectionButton === 'function') updateRoadCrossSectionButton();
    saveCurrentCorridorDrawingDraft('road');
    const draftId = window.activeProposalDesignDraftId;
    if (draftId && absorbedRoadIdentity.name && window.proposalDraftStore?.getDraft?.(draftId)) {
        window.proposalDraftStore.updateDraft(draftId, { fields: { name: absorbedRoadIdentity.name } }, { recordHistory: false });
    }
    if (typeof updateStatus === 'function') {
        updateStatus(translateRoadText('panel.road.absorbedStatus', 'Continuing “{{name}}” — finishing keeps it one road.', {
            name: absorbedRoadIdentity.name || 'road'
        }));
    }
    return true;
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
    const external = snap.type === 'external-endpoint' || snap.type === 'external-edge';
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

    const segments = getAllRoadSegments(true).filter(segment => segment.length >= 2);
    if (!segments.length) return restoreCorridorFill();

    const strips = buildCorridorStrips(segments, roadProfile);
    if (!strips.length) return restoreCorridorFill();

    // Same renderer as applied corridors and OSM streets — see js/corridor-render.js.
    const markings = (typeof buildCorridorLaneMarkings === 'function') ? buildCorridorLaneMarkings(segments, roadProfile) : [];
    const decorations = (typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations(segments, roadProfile) : [];
    const junctions = (typeof buildCorridorJunctionTreatments === 'function') ? buildCorridorJunctionTreatments(segments, roadProfile) : [];
    roadStripLayer = renderCorridorStrips(strips, { markings, decorations, junctions });
    if (!roadStripLayer) return restoreCorridorFill();
    if (roadPolygonLayer) roadPolygonLayer.setStyle({ fillOpacity: 0 });
    roadStripLayer.addTo(map);
}

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

function updateRoadDraftStatus(saved) {
    const status = document.getElementById('roadDraftStatus');
    if (status) status.hidden = saved !== true;
}

function draftLatLng(point) {
    if (!point) return null;
    const lat = Number(point.lat !== undefined ? point.lat : point[1]);
    const lng = Number(point.lng !== undefined ? point.lng : point[0]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// Geometry tools own their live mutable state; this is the single snapshot boundary that turns it
// into a small, reload-safe draft. Preview cursor geometry is deliberately excluded.
function saveCurrentCorridorDrawingDraft(kind) {
    if (typeof saveActiveCorridorDraft !== 'function') return null;
    let seed = null;
    if (kind === 'track') {
        const centerline = (trackPoints || []).map(draftLatLng).filter(Boolean);
        if (centerline.length < 2) return null;
        seed = {
            centerline,
            width: trackWidth,
            trackSpeed,
            trackMinRadius: trackMinCurvatureRadius,
            tunnels: JSON.parse(JSON.stringify(trackBuildingTunnels || []))
        };
    } else {
        const entries = getAllRoadSegments(true)
            .map((segment, index) => ({
                points: (segment || []).map(draftLatLng).filter(Boolean),
                id: roadSegmentIds[index] || null
            }))
            .filter(entry => entry.points.length >= 2);
        if (!entries.length) return null;
        seed = {
            centerline: entries.map(entry => entry.points),
            segmentIds: entries.map(entry => entry.id),
            profile: getRoadDrawingProfile(),
            width: roadWidth,
            sidewalkWidth: roadSidewalkWidth,
            tunnels: JSON.parse(JSON.stringify(roadBuildingTunnels || []))
        };
    }

    const livePolygon = kind === 'track' ? trackPolygon : roadPolygon;
    try {
        const latLngPairs = convertRoadPolygonToLatLngPairs(livePolygon);
        const polygon = convertLatLngPairsToGeoJSON(latLngPairs);
        if (polygon?.type && Array.isArray(polygon.coordinates)) {
            seed.polygon = polygon;
            seed.latLngPairs = latLngPairs;
        }
    } catch (_) { }

    const copySource = window.pendingRoadCopySource || null;
    const affected = kind === 'track' ? trackAffectedParcels : roadAffectedParcels;
    const parentParcelIds = (Array.isArray(affected) ? affected : [])
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
    updateRoadDraftStatus(!!saved);
    // A fresh drawing creates its draft on the first autosave — adopt it into the design
    // session so later autosaves, the finish path, and the draft overlay all target it.
    if (saved && !window.activeProposalDesignDraftId && typeof window.beginProposalDraftDesignSession === 'function') {
        const savedId = saved.draftId || saved.id;
        if (savedId) window.beginProposalDraftDesignSession(savedId);
    }
    return saved;
}

function restoreCorridorDraftIntoPending(draft) {
    if (!draft || !draft.seed) return false;
    if (draft.kind === 'track') window.pendingTrackDrawingSeed = draft.seed;
    else window.pendingRoadDrawingSeed = draft.seed;
    window.pendingRoadCopySource = draft.copySource || null;
    return true;
}

// Apply a live editor profile to the drawing. A total-width change rebuilds the footprint and derives
// affected parcels/stats again; a profile-only change follows the same path but leaves the footprint.
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
    // The next R-press starts at this width (there is no width picker any more).
    try {
        PersistentStorage.setItem('lastRoadWidth', String(roadWidth));
        PersistentStorage.setItem('lastSidewalkWidth', String(roadSidewalkWidth));
    } catch (_) { }
    const polygon = rebuildRoadGeometryFromSegments();
    recomputeLockedParcelsFromPolygon(polygon, false);
    updateRoadInfoPanel();
    updateRoadCrossSectionButton();
    saveCurrentCorridorDrawingDraft('road');
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

    const updatedPolygon = buildRoadUnionPolygonFromSegments(centerlinePoints, roadWidth);
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

// Reopen an existing road for editing: the drawing tool starts from its geometry instead of a blank
// canvas, so a road can be continued across a reload, an upload/download round-trip, or a copy. The
// locked parcels and their stats are then derived from the corridor, exactly as they are after an undo.
function seedRoadDrawing(seed) {
    if (!seed) return false;
    const segments = normalizeSeedSegments(seed.centerline || seed.segments || seed.points);
    if (!segments.length) return false;

    if (Number.isFinite(Number(seed.width))) roadWidth = Number(seed.width);
    if (Number.isFinite(Number(seed.sidewalkWidth))) {
        roadSidewalkWidth = Number(seed.sidewalkWidth);
        if (typeof window !== 'undefined') window.roadSidewalkWidth = roadSidewalkWidth;
    }
    // A road drawn before profiles existed gets one synthesised from its width, so reopening it never
    // silently changes its footprint: the profile always sums back to the width it was drawn with.
    roadProfile = normalizeCorridorProfile(seed.profile) || corridorProfileFromLegacy(roadWidth, roadSidewalkWidth, false);
    if (roadProfile) roadWidth = corridorProfileWidth(roadProfile);

    roadSegments = [];
    roadSegmentIds = [];
    roadPoints = [];
    roadHasStarted = false;
    roadBuildingTunnels = Array.isArray(seed.tunnels) ? JSON.parse(JSON.stringify(seed.tunnels)) : [];
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
    recomputeLockedParcelsFromPolygon(polygon, false);
    updateRoadInfoPanel();
    updateUndoButtonState();
    saveCurrentCorridorDrawingDraft('road');
    return true;
}

// The track counterpart. A track is a single un-branched polyline, so there are no segments to keep
// apart — seeding restores the one centerline, its rails, and the parcels it covers.
function seedTrackDrawing(seed) {
    if (!seed) return false;
    const segments = normalizeSeedSegments(seed.centerline || seed.points);
    if (!segments.length) return false;
    if (segments.length > 1) {
        console.warn('[seedTrackDrawing] track has multiple centerline segments; continuing the first only', segments.length);
    }

    if (Number.isFinite(Number(seed.width))) trackWidth = Number(seed.width);
    if (Number.isFinite(Number(seed.trackSpeed))) trackSpeed = Number(seed.trackSpeed);
    if (Number.isFinite(Number(seed.trackMinRadius))) trackMinCurvatureRadius = Number(seed.trackMinRadius);

    trackPoints = segments[0].slice();
    trackHasStarted = true; // lockParcelsFromSegment routes to the track bookkeeping only once this is set
    trackBuildingTunnels = Array.isArray(seed.tunnels) ? JSON.parse(JSON.stringify(seed.tunnels)) : [];

    if (trackCenterline) map.removeLayer(trackCenterline);
    trackCenterline = L.polyline(trackPoints, { color: 'transparent', weight: 0, opacity: 0 }).addTo(map);

    trackMarkers.forEach(marker => { if (marker && map.hasLayer(marker)) map.removeLayer(marker); });
    trackMarkers = trackPoints.map(point => L.circleMarker(point, {
        radius: 5, color: '#0066cc', fillColor: '#0066cc', fillOpacity: 1
    }).addTo(map));

    trackPolygon = calculateRoadPolygon(trackPoints, trackWidth);
    if (trackPolygonLayer) map.removeLayer(trackPolygonLayer);
    trackPolygonLayer = trackPolygon
        ? L.polygon(trackPolygon, { color: '#0066cc', weight: 1, fillColor: '#e6f2ff', fillOpacity: 0.2 }).addTo(map)
        : null;

    if (trackRailsLayer) map.removeLayer(trackRailsLayer);
    trackRailsLayer = renderTrackWithRails(trackPoints, false, { trackWidth });
    if (trackRailsLayer) trackRailsLayer.addTo(map);
    refreshTrackBuildingTunnelLayer();

    recomputeLockedParcelsFromPolygon(trackPolygon, true);
    updateRoadInfoPanel();
    updateUndoButtonState();
    saveCurrentCorridorDrawingDraft('track');
    return true;
}

if (typeof window !== 'undefined') {
    window.seedRoadDrawing = seedRoadDrawing;
    window.seedTrackDrawing = seedTrackDrawing;
    window.getRoadDrawingProfile = getRoadDrawingProfile;
    window.setRoadDrawingProfile = setRoadDrawingProfile;
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

function getParcelIdFromFeature(feature) {
    return feature ? ensureParcelId(feature) : null;
}

function getParcelIdFromAny(parcel) {
    if (!parcel) return null;
    const fromFeature = parcel.feature ? getParcelIdFromFeature(parcel.feature) : null;
    const fromLayerFeature = parcel.layer?.feature ? getParcelIdFromFeature(parcel.layer.feature) : null;
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
            const layerId = getParcelIdFromFeature(layer.feature);
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

function setRoadPanelLabelsForMode(mode = 'road') {
    const titleEl = document.querySelector('#road-info-panel h3[data-i18n-key="panel.road.title"]');
    const finishBtn = document.getElementById('finishRoadButton');
    const lengthLabel = document.querySelector('#road-info-panel .metric-label[data-i18n-key="panel.road.lengthLabel"]');
    const areaLabel = document.querySelector('#road-info-panel .metric-label[data-i18n-key="panel.road.areaLabel"]');
    const crossSectionButton = document.getElementById('editRoadCrossSectionButton');
    const isTrack = mode === 'track';

    if (titleEl) {
        titleEl.textContent = isTrack
            ? translateRoadText('panel.road.titleTrack', 'Draw track')
            : translateRoadText('panel.road.title', 'Draw road');
    }
    if (finishBtn) {
        finishBtn.textContent = isTrack ? 'Finish track (F)' : 'Finish road (F)';
    }
    if (lengthLabel) {
        lengthLabel.textContent = isTrack ? 'Track length:' : 'Road length:';
    }
    if (areaLabel) {
        areaLabel.textContent = isTrack ? 'Track area:' : 'Road area:';
    }
    if (crossSectionButton) crossSectionButton.style.display = isTrack ? 'none' : '';
}

async function requestCorridorDrawingTool(kind) {
    if (kind === 'road' && roadDrawingMode) return cancelRoadDrawing();
    if (kind === 'track' && trackDrawingMode) return cancelTrackDrawing();

    const draft = typeof getActiveCorridorDraft === 'function' ? getActiveCorridorDraft() : null;
    const sameCity = draft && String(draft.cityId || '') === String(currentCorridorDraftCityId() || '');
    if (draft && sameCity && draft.kind === kind) {
        if (roadDrawingMode) exitRoadDrawingMode();
        if (trackDrawingMode) exitTrackDrawingMode();
        window.beginProposalDraftDesignSession?.(draft.draftId);
        restoreCorridorDraftIntoPending(draft);
        if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
            await ensureCorridorBuildingFootprintsLoaded();
        }
        if (kind === 'track') toggleTrackDrawTool();
        else toggleRoadDrawTool();
        return true;
    }

    // A different draft remains autosaved. Starting another drawing simply activates a new draft;
    // it never replaces or discards the previous one.
    if (roadDrawingMode) exitRoadDrawingMode();
    if (trackDrawingMode) exitTrackDrawingMode();
    // No draft is created for an empty drawing — pressing R and walking away leaves nothing
    // behind. The first autosave (two points drawn) creates the draft, and
    // saveCurrentCorridorDrawingDraft adopts it into the design session then. Clearing the
    // active draft prevents that first autosave from hijacking an unrelated corridor draft.
    try { window.proposalDraftStore?.clearActiveDraft?.(); } catch (_) { }
    // Build-through approvals for parks/squares/lakes last one drawing session only.
    if (typeof resetApprovedStructureCrossings === 'function') resetApprovedStructureCrossings();
    if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
        await ensureCorridorBuildingFootprintsLoaded();
    }
    if (kind === 'track') toggleTrackDrawTool();
    else toggleRoadDrawTool();
    return true;
}

async function startSeededCorridorDrawing(kind, seed, copySource) {
    if (!seed) return false;
    if (roadDrawingMode) exitRoadDrawingMode();
    if (trackDrawingMode) exitTrackDrawingMode();
    if (copySource?.draftId && window.proposalDraftStore?.getDraft(copySource.draftId)) {
        window.beginProposalDraftDesignSession?.(copySource.draftId);
    }
    if (typeof ensureCorridorBuildingFootprintsLoaded === 'function') {
        await ensureCorridorBuildingFootprintsLoaded();
    }
    window.pendingRoadCopySource = copySource || null;
    if (kind === 'track') {
        window.pendingTrackDrawingSeed = seed;
        toggleTrackDrawTool();
    } else {
        window.pendingRoadDrawingSeed = seed;
        toggleRoadDrawTool();
    }
    return true;
}

if (typeof window !== 'undefined') {
    window.requestRoadDrawTool = () => requestCorridorDrawingTool('road');
    window.updateLocalCorridorGeometry = updateLocalCorridorGeometry;
    window.requestTrackDrawTool = () => requestCorridorDrawingTool('track');
    window.startSeededCorridorDrawing = startSeededCorridorDrawing;
}

// Toggle road drawing tool. User-facing entry points go through requestRoadDrawTool(), which restores
// or guards the active draft; this function remains the synchronous low-level activator.
function toggleRoadDrawTool() {
    // Gate: require personalized profile to draw roads (which create proposals)
    if (typeof requirePersonalizedUser === 'function' && requirePersonalizedUser()) {
        return;
    }

    updateGlobalRoadDrawingMode(!roadDrawingMode);
    const roadDrawButton = document.getElementById('roadDrawButton');
    const finishRoadButton = document.getElementById('finishRoadButton');

    if (roadDrawingMode) {
        disableMultiSelectForDrawing();
        setRoadPanelLabelsForMode('road');
        closeProposalDetailsForDrawing();

        // Activate road drawing mode
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

        // Open the road panel and start listening for clicks. Shared by the fresh-draw path (after the
        // width picker resolves) and the seeded path (width comes from the road being continued).
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

        // Continuing an existing road: its geometry and width are already decided, so skip the picker
        // and reopen the tool on that road. The seed is consumed once.
        const seed = (typeof window !== 'undefined') ? window.pendingRoadDrawingSeed : null;
        if (seed) {
            window.pendingRoadDrawingSeed = null;
            if (seedRoadDrawing(seed)) {
                activateRoadDrawing('Click a segment end to continue it, or click the map to draw a new one');
                return;
            }
        }

        // No width modal: drawing starts immediately at the last-used width (the narrowest
        // preset, 7.5 m, on first use). The width is edited any time — before or during the
        // drawing — via the Cross-section button in this panel's header.
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
        // Collapse the sidebar so the map has room (the retired width picker used to do this).
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
            try { toggleSidebar(); } catch (_) { }
        }
        activateRoadDrawing('Click on the map to start drawing a road');

    } else {
        // Deactivate road drawing mode
        if (!trackDrawingMode) {
            setRoadPanelLabelsForMode('road');
        }
        console.log("Deactivating road drawing mode");
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
        finishRoadDrawing();
    }

    // Check for U key (undo last segment)
    if ((e.key === 'u' || e.key === 'U') && getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length > 1)) {
        e.preventDefault(); // Prevent browser default behavior
        undoLastRoadSegment();
    }

    // Check for Escape key (cancel road)
    if (e.key === 'Escape') {
        e.preventDefault(); // Prevent browser default behavior
        cancelRoadDrawing();
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

function handleRoadDrawHotkey(event) {
    if (!event) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (isAnyModalOpen()) return;
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
        if (trackDrawingMode && trackHasStarted) {
            undoButton.disabled = trackPoints.length <= 1;
        } else if (roadDrawingMode) {
            const currentSegment = roadHasStarted
                ? roadPoints
                : (roadSegments[roadSegments.length - 1] || []);
            undoButton.disabled = !currentSegment || currentSegment.length <= 1;
        } else {
            undoButton.disabled = true;
        }
    }
}

// Undo last road segment
function undoLastRoadSegment() {
    const existingSegments = getAllRoadSegments(true);
    if (!roadHasStarted && (!existingSegments.length || (existingSegments[existingSegments.length - 1]?.length || 0) <= 1)) {
        return; // Nothing to undo
    }

    if (!roadHasStarted && existingSegments.length) {
        // Resume editing the last committed segment
        roadPoints = existingSegments[existingSegments.length - 1];
        roadHasStarted = true;
    }

    if (!roadHasStarted || roadPoints.length <= 1) {
        return; // Can't undo if there's only one point or none
    }

    // Remove tunnel metadata paired with this edge before its endpoint disappears.
    const removedPoint = roadPoints[roadPoints.length - 1];
    const previousPoint = roadPoints[roadPoints.length - 2];
    if (typeof removeBuildingTunnelEdge === 'function') {
        roadBuildingTunnels = removeBuildingTunnelEdge(roadBuildingTunnels, previousPoint, removedPoint);
    }
    roadPoints.pop();

    if (roadPoints.length === 0) {
        // Drop the now-empty segment by index so `roadSegmentIds` stays aligned, and put the pen up:
        // the next click starts a new segment (or resumes an old one by snapping to its end).
        const emptyIndex = roadSegments.indexOf(roadPoints);
        if (emptyIndex !== -1) {
            roadSegments.splice(emptyIndex, 1);
            roadSegmentIds.splice(emptyIndex, 1);
        }
        roadPoints = [];
        roadHasStarted = false;
    }

    // Markers are rebuilt from the segments below, so nothing to pop here.

    // Rebuild centerline, polygon and vertex markers from the segments, then re-derive the locked
    // parcels from the resulting corridor.
    const updatedPolygon = rebuildRoadGeometryFromSegments();
    redrawRoadVertexMarkers();
    refreshRoadBuildingTunnelLayer();
    recomputeLockedParcelsFromPolygon(updatedPolygon, false);

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
    saveCurrentCorridorDrawingDraft('road');
}


// Handle road drawing clicks
async function handleRoadClick(e) {
    // Stop event propagation to prevent parcel selection or other click handlers
    L.DomEvent.stopPropagation(e);

    // Snap to an existing vertex or edge so segments that look connected really do share a node.
    let snap = findRoadSnapTarget(e.latlng);
    // A snap on a placed LOCAL road absorbs it into this drawing right now; the re-snap below
    // then resolves onto the (now own) segment, so the ordinary resume/branch logic continues
    // it with proper corners. Minted roads stay put — the snap just donates the exact position.
    if (snap && (snap.type === 'external-endpoint' || snap.type === 'external-edge') && !snap.minted) {
        const absorbed = await absorbAppliedRoadIntoDrawing(snap);
        if (absorbed) snap = findRoadSnapTarget(e.latlng);
    }
    const clickPoint = snap ? snap.latlng : e.latlng;
    clearRoadSnapMarker();

    // Clicking an existing segment's end before drawing has started continues that segment instead
    // of beginning a new one — the same segment, extended, not a second one that happens to touch.
    if (!roadHasStarted && snap && snap.type === 'endpoint') {
        if (resumeRoadSegment(snap.segmentIndex, snap.atStart)) {
            redrawRoadVertexMarkers();
            rebuildRoadGeometryFromSegments();
            updateStatus('Continuing this segment — click to add points, press F to finish the road');
            updateRoadInfoPanel();
            updateUndoButtonState();
            saveCurrentCorridorDrawingDraft('road');
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
        const segmentPolygon = calculateRoadPolygon(segmentPoints, roadWidth);
        let buildingTunnel = null;
        if (segmentPolygon && typeof detectLoadedBuildingTunnelIntersections === 'function') {
            const hits = detectLoadedBuildingTunnelIntersections(segmentPolygon);
            if (hits.length) {
                const resolution = typeof resolveBuildingObstacles === 'function'
                    ? await resolveBuildingObstacles(hits, 'road')
                    : { action: 'cancel', removedProposalIds: [] };
                if (resolution.action === 'cancel') return;
                if (resolution.action === 'tunnel') {
                    const removedOwners = new Set(resolution.removedProposalIds || []);
                    const standingHits = hits.filter(hit => {
                        const owner = typeof corridorTunnelHitProposalId === 'function' ? corridorTunnelHitProposalId(hit) : null;
                        return !owner || !removedOwners.has(owner);
                    });
                    const segmentIndex = roadSegments.indexOf(roadPoints);
                    buildingTunnel = (standingHits.length && typeof makeBuildingTunnelRecord === 'function')
                        ? makeBuildingTunnelRecord(segmentPoints[0], segmentPoints[1], standingHits, {
                            segmentId: roadSegmentIds[segmentIndex] || null
                        }) : null;
                }
            }
            // Parks/squares/lakes in the way get their own decision: unapply / build through / reroute.
            if (typeof detectStructureCrossings === 'function' && typeof resolveStructureCrossings === 'function') {
                const structureHits = detectStructureCrossings(segmentPolygon);
                if (structureHits.length && !(await resolveStructureCrossings(structureHits, 'road'))) return;
            }
        }

        // Add another point to the road (the polygon for the new edge is built below, once)
        roadPoints.push(clickPoint);
        if (buildingTunnel && typeof addBuildingTunnelRecord === 'function') {
            roadBuildingTunnels = addBuildingTunnelRecord(roadBuildingTunnels, buildingTunnel);
            refreshRoadBuildingTunnelLayer();
        }

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
    }

    // Always update the info panel
    updateRoadInfoPanel();

    // Update undo button state
    updateUndoButtonState();
    saveCurrentCorridorDrawingDraft('road');
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

    const roadDrawButton = document.getElementById('roadDrawButton');
    if (roadDrawButton) {
        roadDrawButton.classList.remove('active');
        roadDrawButton.classList.remove('active-black-border');
        roadDrawButton.removeAttribute('aria-pressed');
        roadDrawButton.blur();
    }

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
    updateRoadDraftStatus(false);
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
function polylineHasSelfIntersection(latLngPoints) {
    if (!Array.isArray(latLngPoints) || latLngPoints.length < 4) return false;

    // Convert to planar meters to avoid geodesic edge cases.
    const pts = [];
    for (const p of latLngPoints) {
        try {
            const xy = wgs84ToHTRS96(p.lat, p.lng);
            if (Array.isArray(xy) && xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1])) {
                pts.push({ x: xy[0], y: xy[1] });
            } else {
                return false;
            }
        } catch (_) {
            return false;
        }
    }

    // Segment i is pts[i] -> pts[i+1]
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) continue;

        for (let j = i + 2; j < pts.length - 1; j++) {
            // Skip segments that share a vertex (adjacent in the polyline).
            // Note: j starts at i+2 so immediate adjacency is already avoided; keep this for clarity/safety.
            if (j === i + 1) continue;

            const c = pts[j];
            const d = pts[j + 1];
            if (!c || !d) continue;

            if (segmentsIntersect(a, b, c, d)) {
                return true;
            }
        }
    }
    return false;
}

function segmentsIntersect(p1, q1, p2, q2) {
    const EPS = 1e-9;

    const orient = (a, b, c) => {
        const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(val) < EPS) return 0;
        return val > 0 ? 1 : 2;
    };

    const onSegment = (a, b, c) => {
        return b.x <= Math.max(a.x, c.x) + EPS && b.x + EPS >= Math.min(a.x, c.x)
            && b.y <= Math.max(a.y, c.y) + EPS && b.y + EPS >= Math.min(a.y, c.y);
    };

    const o1 = orient(p1, q1, p2);
    const o2 = orient(p1, q1, q2);
    const o3 = orient(p2, q2, p1);
    const o4 = orient(p2, q2, q1);

    if (o1 !== o2 && o3 !== o4) return true;

    // Colinear cases
    if (o1 === 0 && onSegment(p1, p2, q1)) return true;
    if (o2 === 0 && onSegment(p1, q2, q1)) return true;
    if (o3 === 0 && onSegment(p2, p1, q2)) return true;
    if (o4 === 0 && onSegment(p2, q1, q2)) return true;

    return false;
}

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

function buildOffsetRoadPolygon(points, width) {
    try {
        const halfWidth = width / 2;
        if (!isFinite(halfWidth) || halfWidth <= 0) {
            return null;
        }

        // Convert to metric coordinates and remove consecutive duplicates
        const rawHTRS = points
            .map(p => wgs84ToHTRS96(p.lat, p.lng))
            .filter(isValidPoint);

        if (rawHTRS.length < 2) return null;

        const cleanedHTRS = [];
        const minDistance = 0.05; // meters
        for (const pt of rawHTRS) {
            if (cleanedHTRS.length === 0) {
                cleanedHTRS.push(pt);
                continue;
            }
            const prev = cleanedHTRS[cleanedHTRS.length - 1];
            const dx = pt[0] - prev[0];
            const dy = pt[1] - prev[1];
            if (Math.hypot(dx, dy) >= minDistance) {
                cleanedHTRS.push(pt);
            }
        }

        if (cleanedHTRS.length < 2) return null;

        const directions = [];
        for (let i = 0; i < cleanedHTRS.length - 1; i++) {
            const dx = cleanedHTRS[i + 1][0] - cleanedHTRS[i][0];
            const dy = cleanedHTRS[i + 1][1] - cleanedHTRS[i][1];
            const len = Math.hypot(dx, dy);
            directions.push(len < 1e-6 ? null : [dx / len, dy / len]);
        }

        const resolvePrevDirection = (idx) => {
            for (let i = idx - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            for (let i = 0; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const resolveNextDirection = (idx) => {
            for (let i = idx; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            for (let i = directions.length - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const addVec = (a, b) => [a[0] + b[0], a[1] + b[1]];
        const scaleVec = (v, scalar) => [v[0] * scalar, v[1] * scalar];
        const vecLength = (v) => Math.hypot(v[0], v[1]);
        const leftNormal = (dir) => [-dir[1], dir[0]];
        const rightNormal = (dir) => [dir[1], -dir[0]];

        const computeOffsetPoint = (point, dirPrev, dirNext, side) => {
            const normalFromDir = side === 1 ? leftNormal : rightNormal;

            if (!dirPrev && dirNext) {
                const normal = normalFromDir(dirNext);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (dirPrev && !dirNext) {
                const normal = normalFromDir(dirPrev);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (!dirPrev && !dirNext) {
                return [point[0], point[1]];
            }

            const normalPrev = normalFromDir(dirPrev);
            const normalNext = normalFromDir(dirNext);
            const summed = addVec(normalPrev, normalNext);
            const sumLen = vecLength(summed);

            if (sumLen < 1e-6) {
                return addVec(point, scaleVec(normalNext, halfWidth));
            }

            const miter = [summed[0] / sumLen, summed[1] / sumLen];
            let dot = miter[0] * normalNext[0] + miter[1] * normalNext[1];
            if (Math.abs(dot) < 1e-6) {
                dot = 1e-6 * Math.sign(dot || 1);
            }

            let scaleFactor = halfWidth / dot;
            const miterLimit = 6;
            const maxScale = miterLimit * halfWidth;
            if (Math.abs(scaleFactor) > maxScale) {
                const fallbackNormal = dot > 0 ? normalNext : normalPrev;
                return addVec(point, scaleVec(fallbackNormal, halfWidth));
            }

            return addVec(point, scaleVec(miter, scaleFactor));
        };

        const leftPts = [];
        const rightPts = [];
        for (let i = 0; i < cleanedHTRS.length; i++) {
            const dirPrev = i > 0 ? resolvePrevDirection(i) : null;
            const dirNext = i < cleanedHTRS.length - 1 ? resolveNextDirection(i) : null;

            const leftPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, 1);
            const rightPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, -1);

            leftPts.push(leftPt);
            rightPts.push(rightPt);
        }

        const polygonHTRS = [...leftPts, ...rightPts.reverse()];
        if (polygonHTRS.length < 4) return null;

        const first = polygonHTRS[0];
        const last = polygonHTRS[polygonHTRS.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
            polygonHTRS.push([...first]);
        }

        return polygonHTRS.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return L.latLng(lat, lng);
        });
    } catch (error) {
        console.warn('Failed to build offset road polygon', error);
        return null;
    }
}

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

function convertRoadPolygonToLatLngPairs(polygon) {
    if (!Array.isArray(polygon) || !polygon.length) return null;

    const isLatLngObj = (p) => {
        if (!p) return false;
        if (typeof p.lat === 'number' && typeof p.lng === 'number') return true;
        if (typeof L !== 'undefined' && L.LatLng && p instanceof L.LatLng) return true;
        const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
        const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
        return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
    };

    const extractLatLng = (p) => {
        if (!p) return null;
        if (typeof L !== 'undefined' && L.LatLng && p instanceof L.LatLng) return [p.lat, p.lng];
        if (typeof p.lat === 'function' && typeof p.lng === 'function') return [p.lat(), p.lng()];
        if (typeof p.lat === 'number' && typeof p.lng === 'number') return [p.lat, p.lng];
        return null;
    };

    const toRingPairs = (ring) => {
        if (!Array.isArray(ring) || !ring.length) return null;
        const pairs = [];
        for (const entry of ring) {
            const extracted = extractLatLng(entry);
            if (extracted) {
                pairs.push(extracted);
                continue;
            }
            if (Array.isArray(entry) && entry.length >= 2) {
                const a = Number(entry[0]);
                const b = Number(entry[1]);
                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                // Assume [lat, lng] but swap if first looks like lng
                if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                    pairs.push([b, a]);
                } else {
                    pairs.push([a, b]);
                }
            }
        }
        if (pairs.length < 3) return null;
        const first = pairs[0];
        const last = pairs[pairs.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            pairs.push([first[0], first[1]]);
        }
        return pairs.length >= 4 ? pairs : null;
    };

    // Polygon with holes: [ring, hole1, ...]
    if (Array.isArray(polygon[0]) && polygon[0].length) {
        const firstRing = polygon[0];
        if (isLatLngObj(firstRing[0]) || (Array.isArray(firstRing[0]) && firstRing[0].length >= 2)) {
            const rings = polygon.map(toRingPairs).filter(Boolean);
            return rings.length ? rings : null;
        }
    }

    // Single ring
    if (isLatLngObj(polygon[0]) || (Array.isArray(polygon[0]) && polygon[0].length >= 2)) {
        return toRingPairs(polygon);
    }

    // MultiPolygon: [ [rings...], [rings...] ... ]
    if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) && Array.isArray(polygon[0][0][0])) {
        const polys = polygon
            .map(poly => Array.isArray(poly) ? poly.map(toRingPairs).filter(Boolean) : [])
            .filter(rings => rings.length);
        return polys.length ? polys : null;
    }

    return null;
}

function convertLatLngPairsToGeoJSON(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    const toLngLatRing = (ring) => {
        if (!Array.isArray(ring)) return null;
        const coords = ring
            .map(entry => {
                if (!entry || !Array.isArray(entry) || entry.length < 2) return null;
                const lat = Number(entry[0]);
                const lng = Number(entry[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return [lng, lat];
            })
            .filter(Boolean);
        return coords.length >= 4 ? coords : null;
    };

    // MultiPolygon
    if (Array.isArray(pairs[0]) && Array.isArray(pairs[0][0]) && Array.isArray(pairs[0][0][0])) {
        const polygons = pairs
            .map(poly => Array.isArray(poly) ? poly.map(toLngLatRing).filter(Boolean) : [])
            .filter(rings => rings.length);
        return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
    }

    // Polygon with holes
    if (Array.isArray(pairs[0]) && Array.isArray(pairs[0][0]) && typeof pairs[0][0][0] === 'number') {
        const rings = pairs.map(toLngLatRing).filter(Boolean);
        return rings.length ? { type: 'Polygon', coordinates: rings } : null;
    }

    // Ring only
    if (Array.isArray(pairs[0]) && typeof pairs[0][0] === 'number') {
        const ring = toLngLatRing(pairs);
        return ring ? { type: 'Polygon', coordinates: [ring] } : null;
    }

    return null;
}

function isValidPolygonLatLngPairs(polygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;

    // Ring: [ [lat,lng], ... ]
    if (Array.isArray(polygon[0]) && polygon[0].length >= 2 && Number.isFinite(Number(polygon[0][0])) && Number.isFinite(Number(polygon[0][1]))) {
        return polygon.length >= 3;
    }

    // Polygon with holes: [ ring, hole... ]
    if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0])) {
        const ring = polygon[0];
        if (Array.isArray(ring[0]) && ring[0].length >= 2 && Number.isFinite(Number(ring[0][0])) && Number.isFinite(Number(ring[0][1]))) {
            return ring.length >= 3;
        }
    }

    // MultiPolygon: [ [rings...], [rings...] ... ]
    if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) && Array.isArray(polygon[0][0][0])) {
        for (const poly of polygon) {
            if (!Array.isArray(poly) || poly.length === 0) continue;
            const outer = poly[0];
            if (Array.isArray(outer) && outer.length >= 3) return true;
        }
    }

    return false;
}

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
            const pid = getParcelIdFromFeature(layer.feature);
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

        const parcelId = getParcelIdFromFeature(layer.feature);

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
        const parcelId = getParcelIdFromFeature(layer.feature);
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
function recomputeLockedParcelsFromPolygon(polygon, isTrack = false) {
    if (isTrack) {
        clearTrackAffectedParcels();
        trackSegmentHistory = [];
    } else {
        clearAffectedParcels();
        roadSegmentHistory = [];
    }
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

    // Determine if we're in track mode
    const isTrackMode = trackHasStarted && trackDrawingMode;

    // Store segment stats for undo
    const segmentParcelIds = new Set();
    const segmentStats = {
        parcelCount: 0,
        totalArea: 0,
        ownershipCounts: { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 },
        marketPrice: 0,
        individualOwners: 0
    };

    // Add new parcels to the locked set and appropriate affected parcels array
    for (const parcel of newParcels) {
        if (!lockedParcelIds.has(parcel.id)) {
            lockedParcelIds.add(parcel.id);
            segmentParcelIds.add(parcel.id);

            if (isTrackMode) {
                trackAffectedParcels.push(parcel);
                // Keep a dedicated track set so track highlighting mirrors road behaviour
                lockedTrackParcelIds.add(parcel.id.toString());
            } else {
                roadAffectedParcels.push(parcel);
            }

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
    if (isTrackMode) {
        trackSegmentHistory.push({ parcelIds: segmentParcelIds, stats: segmentStats });
    } else {
        roadSegmentHistory.push({ parcelIds: segmentParcelIds, stats: segmentStats });
    }

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

    // Update acquiring difficulty (use appropriate array based on mode)
    const affectedParcels = isTrackMode ? trackAffectedParcels : roadAffectedParcels;
    updateRoadAcquiringDifficulty(affectedParcels);
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

// Update road info panel with current metrics (works for both roads and tracks)
function updateRoadInfoPanel() {
    // Check if road or track has started
    const hasRoadSegments = getAllRoadSegments(true).some(seg => Array.isArray(seg) && seg.length > 0);
    const isRoadMode = !trackDrawingMode && hasRoadSegments;
    const isTrackMode = trackHasStarted && trackDrawingMode;

    if (!isRoadMode && !isTrackMode) return;

    // Make sure the road info panel exists
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (!roadInfoPanel) {
        console.error('Road info panel element not found');
        return; // Exit early if the panel doesn't exist
    }
    if (!roadInfoPanel.classList.contains('visible')) {
        roadInfoPanel.style.removeProperty('display');
        roadInfoPanel.classList.add('visible');
    }

    if (isTrackMode) {
        const points = trackPoints;
        const width = trackWidth;
        if (points.length >= 2) {
            // PERFORMANCE: Use trackPolygon (already calculated in handleTrackClick) instead of recalculating
            // Only calculate length from points, use existing polygon for area
            const length = calculateSegmentLengthMeters(points);
            const area = trackPolygon ? calculatePolygonAreaMeters(trackPolygon) : 0;

            committedTrackMetrics.length = length;
            committedTrackMetrics.area = area;

            // Update UI elements directly
            const roadLengthElement = document.getElementById('road-length');
            const roadAreaElement = document.getElementById('road-area');
            if (roadLengthElement) {
                roadLengthElement.textContent = `${length.toFixed(1)} m`;
            }
            if (roadAreaElement) {
                roadAreaElement.textContent = `${area.toFixed(1)} m²`;
            }

            setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
            setRoadOwnershipCounts(lockedStats.ownershipCounts);
            const marketEl = document.getElementById('road-market-price');
            if (marketEl) {
                marketEl.textContent = lockedStats.marketPrice > 0 ? formatCurrency(lockedStats.marketPrice) : '—';
            }
            const ownerCountEl = document.getElementById('road-individual-owners');
            if (ownerCountEl) {
                ownerCountEl.textContent = lockedStats.individualOwners > 0 ? lockedStats.individualOwners.toString() : '—';
            }
            updateRoadAcquiringDifficulty(trackAffectedParcels);
        } else {
            resetRoadMetricPlaceholders();
            committedTrackMetrics.length = 0;
            committedTrackMetrics.area = 0;
        }
        return;
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

// Tracks now use the same lockedStats as roads - this function is no longer needed
// Kept for backward compatibility but should not be used
function getTrackLockedStats() {
    // Return stats from lockedStats (shared with roads)
    return {
        parcelCount: lockedStats.parcelCount,
        totalArea: lockedStats.totalArea,
        ownershipCounts: { ...lockedStats.ownershipCounts },
        marketPrice: lockedStats.marketPrice
    };
}

// Update road info with preview metrics (works for both roads and tracks)
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

// PERFORMANCE: Fast update of track info during preview (same as road version but uses track metrics)
function updatePreviewTrackInfo(previewSegmentPoints, previewSegmentPolygon) {
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

        // Add preview segment metrics to cached committed track metrics
        const totalLength = committedTrackMetrics.length + previewLength;
        const totalArea = committedTrackMetrics.area + previewArea;

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

    // Calculate and draw road polygon
    const roadPolygonPoints = buildRoadUnionPolygonFromSegments(segments, roadWidth);
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

// Unified finish function for road or track drawing. Finishing IS the creation: the drawing
// instantly becomes an applied object (SimCity lifecycle).
function finishRoadOrTrackDrawing() {
    if (trackDrawingMode) {
        finishTrackDrawing();
    } else if (roadDrawingMode) {
        finishRoadDrawing();
    }
}

// Unified undo function for road or track drawing
function undoLastRoadOrTrackSegment() {
    if (trackDrawingMode && trackHasStarted) {
        undoLastTrackSegment();
    } else if (roadDrawingMode && roadHasStarted) {
        undoLastRoadSegment();
    }
}

// Unified cancel function for road or track drawing
async function cancelRoadOrTrackDrawing() {
    if (trackDrawingMode) {
        return cancelTrackDrawing();
    } else if (roadDrawingMode) {
        return cancelRoadDrawing();
    }
    return false;
}

// Segments whose endpoints coincide (a stroke drawn from a snap on another segment's end) weld
// into ONE polyline, so the corner is mitered like any mid-segment vertex instead of two
// rectangles meeting with a triangular gap. Mid-segment T-joints stay separate segments — the
// junction renderer fills those.
function weldCorridorSegments(segments, segmentIds) {
    const EPS = 1e-7; // ~1 cm — snap targets copy exact vertex coordinates
    const same = (a, b) => a && b && Math.abs(a.lat - b.lat) < EPS && Math.abs(a.lng - b.lng) < EPS;
    const segs = segments.map(segment => segment.slice());
    const ids = segmentIds.slice();
    let joined = true;
    while (joined) {
        joined = false;
        outer:
        for (let i = 0; i < segs.length; i += 1) {
            for (let j = 0; j < segs.length; j += 1) {
                if (i === j) continue;
                const a = segs[i];
                const b = segs[j];
                if (same(a[a.length - 1], b[0])) segs[i] = a.concat(b.slice(1));
                else if (same(a[a.length - 1], b[b.length - 1])) segs[i] = a.concat(b.slice(0, -1).reverse());
                else if (same(a[0], b[b.length - 1])) segs[i] = b.concat(a.slice(1));
                else if (same(a[0], b[0])) segs[i] = b.slice(1).reverse().concat(a);
                else continue;
                ids[i] = null; // a concatenated polyline no longer matches any source segment id
                segs.splice(j, 1);
                ids.splice(j, 1);
                joined = true;
                break outer;
            }
        }
    }
    return { segments: segs, segmentIds: ids };
}

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
    const targets = findTouchingLocalCorridors(kind, newGeoPolygon, [], drawnSegments);
    if (!targets.length) return null;
    targets.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const oldest = targets[0];

    const mergedSegments = [];
    const mergedSegmentIds = [];
    const mergedTunnels = [];
    const mergedParents = new Set();
    const collectDefinition = (definition, parents) => {
        (corridorCenterlineOf(definition) || []).forEach((segment, index) => {
            mergedSegments.push(segment.map(point => ({ lat: point.lat, lng: point.lng })));
            mergedSegmentIds.push(Array.isArray(definition.segmentIds) ? (definition.segmentIds[index] || null) : null);
        });
        (definition.tunnels || []).forEach(tunnel => mergedTunnels.push(JSON.parse(JSON.stringify(tunnel))));
        (parents || []).forEach(id => { if (id) mergedParents.add(String(id)); });
    };
    targets.forEach(proposal => collectDefinition(
        proposal.roadProposal.definition,
        proposal.roadProposal.parentParcelIds || proposal.parentParcelIds
    ));
    const draftDefinition = draft.editorPayload?.definition || {};
    collectDefinition(draftDefinition, draft.fields?.parentParcelIds);

    // Weld end-to-end connections into continuous polylines (proper corners, no gaps), then
    // make every crossing a shared graph node so junctions stay draggable and bulldozable.
    const welded = weldCorridorSegments(mergedSegments, mergedSegmentIds);
    mergedSegments.length = 0;
    mergedSegments.push(...welded.segments);
    mergedSegmentIds.length = 0;
    mergedSegmentIds.push(...welded.segmentIds);
    insertCorridorCrossingNodes(mergedSegments, mergedSegmentIds);

    // The established road keeps its identity: the oldest body donates name and cross-section.
    const oldestDefinition = oldest.roadProposal.definition;
    const profile = oldestDefinition.profile
        ? JSON.parse(JSON.stringify(oldestDefinition.profile))
        : (draftDefinition.profile ? JSON.parse(JSON.stringify(draftDefinition.profile)) : null);
    const width = Number(oldestDefinition.width) || Number(draftDefinition.width) || 10;
    const sidewalkWidth = oldestDefinition.sidewalkWidth !== undefined
        ? oldestDefinition.sidewalkWidth
        : draftDefinition.sidewalkWidth;

    const unionPolygon = buildRoadUnionPolygonFromSegments(mergedSegments, width);
    const latLngPairs = convertRoadPolygonToLatLngPairs(unionPolygon);
    const mergedPolygon = convertLatLngPairsToGeoJSON(latLngPairs);

    // Absorb first: unapplying the targets restores the original parcel fabric, so the merged
    // footprint (rebuilt at the merged width) can be tested against real parcels. The declared
    // parent lists are POISON here — the connector's drawing-time detection saw the absorbed
    // roads' slice parcels, and those ids stop existing the moment the targets are removed.
    // Parents therefore come exclusively from the footprint test; the declared union is only a
    // fallback when turf is unavailable.
    for (const proposal of targets) {
        const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
        try { await ProposalManager.unapplyProposal(key, { skipConfirm: true }); } catch (_) { }
        try { proposalStorage.removeProposal(key); } catch (_) { }
    }
    let mergedParentIds = [...mergedParents];
    if (mergedPolygon && mergedPolygon.type) {
        const acquisitionPolygon = mergedTunnels.length
            ? corridorSurfaceFootprintGeoJSON(mergedSegments, width, mergedTunnels)
            : mergedPolygon;
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
            definition: {
                ...JSON.parse(JSON.stringify(draftDefinition)),
                points: mergedSegments,
                segments: mergedSegments,
                segmentIds: mergedSegmentIds,
                tunnels: mergedTunnels,
                profile,
                width,
                sidewalkWidth,
                polygon: (mergedPolygon && mergedPolygon.type) ? mergedPolygon : draftDefinition.polygon || null,
                latLngPairs
            }
        }
    }, { recordHistory: false });

    return { absorbed: targets.length, name: oldest.title || oldest.name || '' };
}

// Function to finish road drawing
async function finishRoadDrawing() {
    // Keep each segment paired with its id while dropping the ones too short to be a line.
    const allSegments = getAllRoadSegments(true);
    const drawnSegments = allSegments
        .map((segment, index) => ({ segment, id: roadSegmentIds[index] || null }))
        .filter(entry => Array.isArray(entry.segment) && entry.segment.length >= 2);
    const segments = drawnSegments.map(entry => entry.segment);
    const segmentIds = drawnSegments.map(entry => entry.id);
    if (!segments.length) return;

    const tunnelCheck = await ensureBuildingTunnelsForSegments(
        segments, roadWidth, 'road', roadBuildingTunnels, segmentIds
    );
    if (!tunnelCheck.accepted) return;
    roadBuildingTunnels = tunnelCheck.records;
    refreshRoadBuildingTunnelLayer();

    // Immediately stop interactions and preview while finishing
    suspendRoadDrawingInteractivity();
    stopRoadPreviewTracking();

    let finalRoadPolygon = buildRoadUnionPolygonFromSegments(segments, roadWidth);
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

    const defaultAuthor = (typeof getCurrentUsername === 'function' && getCurrentUsername()) || '';
    const defaultName = generateRandomRoadName();
    const defaultOffer = generateRandomRoadOffer();
    const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

    const parentParcelIds = affectedParcels
        .map(p => getParcelIdFromAny(p))
        .filter(Boolean)
        .map(id => id.toString());

    // Seed multi-parcel selection with the affected parcels so the generalized modal can open
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
        const surfaceFootprint = corridorSurfaceFootprintGeoJSON(centerlineSegments, roadWidth, roadBuildingTunnels);
        const surfaceIds = new Set(surfaceFootprint ? collectParcelsIntersectingFootprint(surfaceFootprint) : []);
        for (let i = parentParcelIds.length - 1; i >= 0; i--) {
            if (!surfaceIds.has(parentParcelIds[i])) parentParcelIds.splice(i, 1);
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
        stats: ownershipAndAcquisitionStats,
        metadata: {
            mode: 'draw',
            type: 'road',
            isTrack: false,
            isRoad: true,
            isCorridor: true,
            source: 'road-drawing'
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
    if (!window.activeProposalDesignDraftId) saveCurrentCorridorDrawingDraft('road');
    const designDraftId = window.activeProposalDesignDraftId;
    if (designDraftId && window.proposalDraftStore?.getDraft?.(designDraftId)) {
        window.syncActiveProposalDraftFromEditor?.('corridor', {
            ...roadDrawingContext,
            kind: 'road'
        }, { parentParcelIds, coalesceKey: 'corridor-finalize' });
        exitRoadDrawingMode();
        const merged = await absorbConnectedLocalCorridors('road', geoPolygon, designDraftId);
        const createdId = await window.instantCreateProposalFromDraft?.(designDraftId);
        if (createdId && typeof updateStatus === 'function') {
            updateStatus(merged
                ? translateRoadText('panel.road.mergedStatus', 'Connected to “{{name}}” — now one road.', { name: merged.name })
                : translateRoadText('panel.road.builtStatus', 'Road built — click it to edit or propose.'));
        }
        return;
    }

    // Legacy path (drawing started without a design draft): the classic create dialog.
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

// Closing the drawing tool (X button or Escape) never discards work — the geometry autosaves as
// a draft. Say so visibly, so the close doesn't read as a destructive cancel.
function showCorridorDraftSavedToast(kind) {
    document.getElementById('corridor-draft-saved-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'corridor-draft-saved-toast';
    toast.className = 'corridor-draft-saved-toast';
    toast.setAttribute('role', 'status');
    const message = kind === 'track'
        ? translateRoadText('panel.road.draftSavedTrackToast', 'Unfinished track kept — click its dashed outline to continue.')
        : translateRoadText('panel.road.draftSavedRoadToast', 'Unfinished road kept — click its dashed outline or press R to continue.');
    toast.innerHTML = `<p>💾 ${message}</p>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
}

// Cancel road drawing
async function cancelRoadDrawing() {
    const saved = saveCurrentCorridorDrawingDraft('road');
    exitRoadDrawingMode();
    if (saved) showCorridorDraftSavedToast('road');
    return true;
}

// Reset road drawing variables and state
function resetRoadDrawing(hidePanel = true) {
    roadSegments = [];
    roadSegmentIds = [];
    roadPoints = [];
    roadBuildingTunnels = [];
    absorbedRoadIdentity = null; // the absorbed name already lives on the drawing's draft
    roadWidth = 2;
    roadProfile = null;
    roadHasStarted = false;
    clearRoadSnapMarker();
    clearRoadStripLayer();
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
            const layerParcelId = getParcelIdFromFeature(layer.feature);
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

function showTrackProposalModal({ defaultAuthor = '', defaultName = 'New Track', defaultOffer = 10000, affectedParcels = [], trackPolygon = null, trackSpeed = 120, trackMinRadius = 1000, trackWidth = 3.0, trackPoints = null, trackMinCurvatureRadius = null } = {}) {
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
        modal.className = 'create-proposal-modal track-proposal-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const parcelItems = affectedParcels.map(parcel => {
            const parcelNumber = parcel?.number || parcel?.id || 'Unknown';
            const area = parcel?.area || 0;
            return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${parcelNumber}</span><span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span></div>`;
        }).join('');

        const screenshotPolygon = convertRoadPolygonToLatLngPairs(trackPolygon);

        // Fallback to the Leaflet polygon layer if needed
        let screenshotBounds = null;
        if (trackPolygonLayer && typeof trackPolygonLayer.getBounds === 'function') {
            screenshotBounds = trackPolygonLayer.getBounds();
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
                    <h2 data-i18n-key="modal.roadWidth.trackProposal.title">Create Track Proposal</h2>
                    <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close" data-i18n-key="modal.common.close" data-i18n-attr="aria-label">&times;</button>
                </div>
                <div class="proposal-modal-body">
                    ${(isValidPolygonLatLngPairs(screenshotPolygon)) ? '<div class="form-group" id="trackProposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                    <div class="form-group">
                        <label for="trackProposalAuthor" data-i18n-key="modal.roadWidth.trackProposal.authorLabel">Author:</label>
                        <input type="text" id="trackProposalAuthor" placeholder="" data-i18n-key="modal.roadWidth.trackProposal.authorPlaceholder" data-i18n-attr="placeholder">
                    </div>
                    <div class="form-group">
                        <label for="trackProposalName" data-i18n-key="modal.roadWidth.trackProposal.nameLabel">Track Name:</label>
                        <input type="text" id="trackProposalName" placeholder="" data-i18n-key="modal.roadWidth.trackProposal.namePlaceholder" data-i18n-attr="placeholder">
                    </div>
                    <div class="form-group">
                        <label for="trackProposalOffer" data-i18n-key="modal.roadWidth.trackProposal.offerLabel">Offer (EUR):</label>
                        <input type="number" id="trackProposalOffer" min="0" step="1000" placeholder="" data-i18n-key="modal.roadWidth.trackProposal.offerPlaceholder" data-i18n-attr="placeholder">
                    </div>
                    <div class="form-group">
                        <label for="trackProposalDescription" data-i18n-key="modal.roadWidth.trackProposal.descriptionLabel">Description:</label>
                        <textarea id="trackProposalDescription" rows="3" placeholder="" data-i18n-key="modal.roadWidth.trackProposal.descriptionPlaceholder" data-i18n-attr="placeholder"></textarea>
                    </div>
                    <div class="proposal-summary">
                        <div class="summary-stats">
                            <p><strong data-i18n-key="modal.roadWidth.trackProposal.summary.parcels">Parcels Affected:</strong> ${affectedParcels.length}</p>
                            <p><strong data-i18n-key="modal.roadWidth.trackProposal.summary.area">Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                            <p><strong data-i18n-key="modal.roadWidth.trackProposal.summary.speed">Track Speed:</strong> ${trackSpeed} km/h</p>
                            <p><strong data-i18n-key="modal.roadWidth.trackProposal.summary.width">Track Width:</strong> ${trackWidth.toFixed(1)} m</p>
                            <p><strong data-i18n-key="modal.roadWidth.trackProposal.summary.curvature">Min. Curvature Radius:</strong> ${trackMinRadius} m</p>
                        </div>
                        <div class="parcel-list">
                            <h4 data-i18n-key="modal.roadWidth.trackProposal.summary.heading">Affected Parcels:</h4>
                            ${parcelItems || `<div class="proposal-parcel-item" data-i18n-key="modal.roadWidth.trackProposal.summary.empty">No parcels detected.</div>`}
                        </div>
                    </div>
                    ${statsHtml}
                </div>
                <div class="proposal-modal-footer">
                    <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}" aria-label="${lensTooltip}">👓</button>
                    <button type="button" class="btn btn-proposal" id="trackProposalConfirmBtn" data-i18n-key="modal.roadWidth.trackProposal.submit">Create Proposal</button>
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

        const authorInput = modal.querySelector('#trackProposalAuthor');
        const nameInput = modal.querySelector('#trackProposalName');
        const offerInput = modal.querySelector('#trackProposalOffer');
        const descriptionInput = modal.querySelector('#trackProposalDescription');
        const confirmButton = modal.querySelector('#trackProposalConfirmBtn');
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
                if (trackPoints && trackWidth && affectedParcels.length > 0) {
                    // Get the full GeoJSON features of parent parcels
                    const parentFeatures = affectedParcels.map(p => {
                        // We need a deep copy so the original features in parcelLayer are not mutated
                        // Use safe cloning to avoid circular reference errors
                        const feature = p.layer.feature;
                        if (!feature) {
                            console.warn(`[DEBUG finishTrackDrawing] Parcel ${p.id} has no feature in layer`);
                            return null;
                        }

                        // Clone the feature safely by extracting only GeoJSON properties
                        try {
                            const cloned = {
                                type: feature.type || 'Feature',
                                properties: feature.properties ? { ...feature.properties } : {},
                                geometry: feature.geometry ? {
                                    type: feature.geometry.type,
                                    coordinates: JSON.parse(JSON.stringify(feature.geometry.coordinates))
                                } : null
                            };
                            if (typeof window !== 'undefined' && typeof window.ensureParcelId === 'function') {
                                window.ensureParcelId(cloned);
                            } else if (typeof ensureParcelId === 'function') {
                                ensureParcelId(cloned);
                            }
                            return cloned;
                        } catch (error) {
                            console.warn('finishTrackDrawing: failed to clone feature', error, p);
                            return null;
                        }
                    }).filter(f => f !== null);

                    // Create the proposal
                    const proposalApi = (typeof Proposals !== 'undefined' && Proposals.manager) ? Proposals.manager : ProposalManager;
                    const proposalMetadata = {
                        author: authorValue,
                        offer: offerValue,
                        description: descriptionValue,
                        isTrack: true,
                        trackSpeed: trackSpeed,
                        trackMinRadius: trackMinCurvatureRadius || trackMinRadius
                    };
                    if (ownershipAndAcquisitionStats) {
                        proposalMetadata.ownershipAndAcquisitionStats = ownershipAndAcquisitionStats;
                    }
                    const proposal = proposalApi.createProposal({
                        name: nameValue,
                        type: 'road', // Using road type for now
                        definition: {
                            points: trackPoints,
                            width: trackWidth,
                            metadata: proposalMetadata
                        },
                        parentFeatures: parentFeatures,
                        author: authorValue,
                        description: descriptionValue,
                        offer: offerValue,
                        budget: offerValue,
                        lens: lensEntries && lensEntries.length > 0 ? lensEntries : undefined
                    });

                    // Check if proposal creation failed
                    if (!proposal) {
                        console.error('[showTrackProposalModal] createProposal returned null - duplicate proposal or invalid data');
                        // Restore button on failure
                        if (confirmButton && originalButtonContent) {
                            confirmButton.innerHTML = originalButtonContent;
                            confirmButton.disabled = false;
                            confirmButton.style.opacity = '';
                            confirmButton.style.cursor = '';
                        }
                        if (typeof showEphemeralMessage === 'function') {
                            showEphemeralMessage('Failed to create track proposal. An identical proposal may already exist.', 5000, 'error');
                        }
                        return;
                    }

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
                    if (!proposal.proposalId) {
                        console.error('[showTrackProposalModal] Proposal created but proposalId is missing', { proposal });
                        // Restore button on failure
                        if (confirmButton && originalButtonContent) {
                            confirmButton.innerHTML = originalButtonContent;
                            confirmButton.disabled = false;
                            confirmButton.style.opacity = '';
                            confirmButton.style.cursor = '';
                        }
                        if (typeof showEphemeralMessage === 'function') {
                            showEphemeralMessage('Failed to create track proposal. Please try again.', 5000, 'error');
                        }
                        return;
                    }

                    // Ensure proposal is saved to storage
                    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.save === 'function') {
                        try {
                            proposalStorage.save();
                        } catch (err) {
                            console.warn('Failed to save track proposal to storage', err);
                        }
                    }

                    // Resolve with proposal data
                    cleanup();
                    resolve({
                        trackName: nameValue,
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
                        trackName: nameValue,
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
                console.error('Error creating track proposal:', error);
                // Restore button on error
                if (confirmButton && originalButtonContent) {
                    confirmButton.innerHTML = originalButtonContent;
                    confirmButton.disabled = false;
                    confirmButton.style.opacity = '';
                    confirmButton.style.cursor = '';
                }
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Failed to create track proposal. Please try again.', 5000, 'error');
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
            const screenshotContainer = modal.querySelector('#trackProposalScreenshotContainer');
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
function createRectangularRoadSegment(point1, point2, width) {
    // Validate input
    if (!point1 || !point2 || !isFinite(width) || width <= 0) {
        console.warn('Invalid inputs to createRectangularRoadSegment');
        return null;
    }

    if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
        !isFinite(point2.lat) || !isFinite(point2.lng)) {
        console.warn('Invalid coordinates in createRectangularRoadSegment');
        return null;
    }

    // Convert to HTRS96/TM for accurate distance calculations
    const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
    const htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);

    // Validate converted points
    if (!isValidPoint(htrsPoint1) || !isValidPoint(htrsPoint2)) {
        console.warn('Invalid HTRS points in createRectangularRoadSegment');
        return null;
    }

    // Calculate segment direction
    const dx = htrsPoint2[0] - htrsPoint1[0];
    const dy = htrsPoint2[1] - htrsPoint1[1];
    const length = Math.sqrt(dx * dx + dy * dy);

    // Skip if segment has near-zero length
    if (length < 0.001) {
        // Use a minimum segment length to avoid zero-length segments
        // Instead of just returning null, create a small circle around the point
        const minLength = 0.1; // 10cm minimum
        // Create a point offset in a random direction if points are too close
        const angle = Math.random() * Math.PI * 2; // Random angle
        const offsetX = Math.cos(angle) * minLength;
        const offsetY = Math.sin(angle) * minLength;

        // Create new point2 with the offset
        const newHtrsPoint2 = [htrsPoint1[0] + offsetX, htrsPoint1[1] + offsetY];

        // Recalculate direction with the new point
        const newDx = newHtrsPoint2[0] - htrsPoint1[0];
        const newDy = newHtrsPoint2[1] - htrsPoint1[1];
        const newLength = Math.sqrt(newDx * newDx + newDy * newDy);

        // Calculate normalized perpendicular vector
        const perpX = -newDy / newLength;
        const perpY = newDx / newLength;

        // Rest of the function is the same, just using the new values
        const halfWidth = width / 2;

        // Calculate the 4 corners of the rectangle
        const corners = [
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth], // top-left
            [newHtrsPoint2[0] + perpX * halfWidth, newHtrsPoint2[1] + perpY * halfWidth], // top-right
            [newHtrsPoint2[0] - perpX * halfWidth, newHtrsPoint2[1] - perpY * halfWidth], // bottom-right
            [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth], // bottom-left
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]  // close polygon - back to top-left
        ];

        // Convert back to WGS84
        const wgsCorners = [];
        for (const corner of corners) {
            const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
            if (isFinite(lat) && isFinite(lng)) {
                wgsCorners.push(L.latLng(lat, lng));
            }
        }

        // Check if we have enough points for a valid polygon
        if (wgsCorners.length < 4) {
            console.warn('Not enough valid corners for rectangle');
            return null;
        }

        return wgsCorners;
    }

    // Calculate perpendicular vector (normalized)
    const perpX = -dy / length;
    const perpY = dx / length;

    // Calculate half-width
    const halfWidth = width / 2;

    // Calculate the 4 corners of the rectangle
    const corners = [
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth], // top-left
        [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth], // top-right
        [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth], // bottom-right
        [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth], // bottom-left
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]  // close polygon - back to top-left
    ];

    // Convert back to WGS84
    const wgsCorners = [];
    for (const corner of corners) {
        const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
        if (isFinite(lat) && isFinite(lng)) {
            wgsCorners.push(L.latLng(lat, lng));
        } else {
            console.warn('Invalid conversion result:', lat, lng);
        }
    }

    // Check if we have enough points for a valid polygon
    if (wgsCorners.length < 4) {
        console.warn('Not enough valid corners for rectangle');
        return null;
    }

    return wgsCorners;
}

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

        const parcelId = getParcelIdFromFeature(layer.feature);
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
// TRACK DRAWING FUNCTIONALITY
// ============================================================================

// Canvas renderer for track visualization - renders to a single canvas element
// instead of creating hundreds of SVG DOM elements for sleepers
let trackCanvasRenderer = null;
function getTrackCanvasRenderer() {
    if (!trackCanvasRenderer && typeof L !== 'undefined' && L.canvas) {
        trackCanvasRenderer = L.canvas({ padding: 0.5 });
    }
    return trackCanvasRenderer;
}
// Initialize on load if map exists
if (typeof map !== 'undefined' && map) {
    trackCanvasRenderer = getTrackCanvasRenderer();
}

// Track drawing tool variables
let trackDrawingMode = false;
let trackPoints = [];
// Standard track width: 1.453m track + embankments = 3m total (default, can be changed via UI)
let trackWidth = 3.0;
const TRACK_WIDTH_DEFAULT = 3.0;
// Track speed in km/h, determines minimum curvature radius
let trackSpeed = 120; // Default speed
let trackMinCurvatureRadius = 1000; // Default minimum radius in meters
let trackCenterline = null;
let trackPolygon = null;
let trackPreviewLine = null;
let trackPreviewPolygon = null;
let trackAffectedParcels = [];
let lockedTrackParcelIds = new Set(); // Set of parcel IDs that are locked (confirmed) for track drawing
let trackMouseMarker = null;
let trackHasStarted = false;
let trackPreviewPolygonLayer = null;
let trackCenterlineLayer = null;
let trackPolygonLayer = null;

// Cached committed track geometry metrics - updated once per segment commit, not per mousemove
let committedTrackMetrics = {
    length: 0,
    area: 0
};
let trackMarkers = [];
let trackBuildingTunnels = [];
let trackBuildingTunnelLayer = null;
let trackPreviewAffectedParcels = [];
let trackRailsLayer = null; // Layer group for track rails and sleepers
let trackPreviewRailsLayer = null; // Preview rails and sleepers
let lastTrackMoveUpdate = 0;
const trackThrottleDelay = 150; // milliseconds between updates (same as road)
let trackSegmentSound = null; // Loaded lazily on first use
let trackSegmentSoundStopTimer = null;

// Track speed to minimum curvature radius mapping (in meters)
// Based on railway engineering standards
const TRACK_SPEED_TO_MIN_RADIUS = {
    50: 300,   // Low speed, yards/sidings
    80: 500,   // Local/regional
    120: 1000, // Regional/mainline
    160: 2000, // High-speed regional
    200: 3500, // High-speed
    250: 5000  // Very high-speed
};

// Calculate minimum curvature radius from speed
function getMinCurvatureRadius(speed) {
    return TRACK_SPEED_TO_MIN_RADIUS[speed] || 1000;
}

// Render a single track at a given offset from centerline
// Helper function for rendering tracks
function renderSingleTrack(htrsPoints, centerlineOffset, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup, paneName = null) {
    const railOffset = 0.725; // Half of track gauge (1.453m / 2) in meters

    // Pre-compute segment directions
    const segmentDirs = [];
    for (let i = 0; i < htrsPoints.length - 1; i++) {
        const curr = htrsPoints[i];
        const next = htrsPoints[i + 1];
        const dx = next[0] - curr[0];
        const dy = next[1] - curr[1];
        const len = Math.hypot(dx, dy);
        if (len > 0.01) {
            segmentDirs.push([dx / len, dy / len]);
        } else {
            segmentDirs.push(null);
        }
    }

    // Create left and right rail paths
    const leftRailPoints = [];
    const rightRailPoints = [];

    for (let i = 0; i < htrsPoints.length; i++) {
        const point = htrsPoints[i];
        let dir = null;

        // Average incoming and outgoing directions for smooth corners
        const prevDir = i > 0 ? segmentDirs[i - 1] : null;
        const nextDir = i < segmentDirs.length ? segmentDirs[i] : null;

        if (prevDir && nextDir) {
            // Average the two directions for a smooth joint
            const avgDx = prevDir[0] + nextDir[0];
            const avgDy = prevDir[1] + nextDir[1];
            const avgLen = Math.hypot(avgDx, avgDy);
            if (avgLen > 0.01) {
                dir = [avgDx / avgLen, avgDy / avgLen];
            } else {
                // 180-degree turn (shouldn't happen often) - use incoming direction
                dir = prevDir;
            }
        } else if (nextDir) {
            dir = nextDir;
        } else if (prevDir) {
            dir = prevDir;
        }

        if (dir) {
            // Perpendicular direction (rotate 90 degrees)
            const perp = [-dir[1], dir[0]];
            // Offset track centerline from original centerline
            const trackCenter = [
                point[0] + perp[0] * centerlineOffset,
                point[1] + perp[1] * centerlineOffset
            ];
            // Then offset rails from track centerline
            const leftPt = [trackCenter[0] + perp[0] * railOffset, trackCenter[1] + perp[1] * railOffset];
            const rightPt = [trackCenter[0] - perp[0] * railOffset, trackCenter[1] - perp[1] * railOffset];

            const [leftLat, leftLng] = htrs96ToWGS84(leftPt[0], leftPt[1]);
            const [rightLat, rightLng] = htrs96ToWGS84(rightPt[0], rightPt[1]);

            leftRailPoints.push(L.latLng(leftLat, leftLng));
            rightRailPoints.push(L.latLng(rightLat, rightLng));
        } else {
            // Fallback: use point directly if no direction (shouldn't happen often)
            const [lat, lng] = htrs96ToWGS84(point[0], point[1]);
            leftRailPoints.push(L.latLng(lat, lng));
            rightRailPoints.push(L.latLng(lat, lng));
        }
    }

    // Draw left rail
    const leftRail = L.polyline(leftRailPoints, {
        pane: paneName || undefined,
        renderer: trackCanvasRenderer,
        color: railColor,
        weight: 2,
        opacity: 0.9
    });
    layerGroup.addLayer(leftRail);

    // Draw right rail
    const rightRail = L.polyline(rightRailPoints, {
        pane: paneName || undefined,
        renderer: trackCanvasRenderer,
        color: railColor,
        weight: 2,
        opacity: 0.9
    });
    layerGroup.addLayer(rightRail);

    // Collect all sleeper coordinates into a single array for batch rendering
    const allSleeperCoords = [];

    // Draw sleepers (ties) at regular intervals along the track
    for (let i = 0; i < htrsPoints.length - 1; i++) {
        const start = htrsPoints[i];
        const end = htrsPoints[i + 1];
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const segmentLength = Math.hypot(dx, dy);
        const segmentDir = segmentLength > 0.01 ? [dx / segmentLength, dy / segmentLength] : [1, 0];
        const perp = [-segmentDir[1], segmentDir[0]];

        // Calculate number of sleepers for this segment
        const numSleepers = Math.floor(segmentLength / sleeperSpacing);

        for (let j = 0; j <= numSleepers; j++) {
            const t = j / Math.max(numSleepers, 1);
            const sleeperCenterOnCenterline = [
                start[0] + dx * t,
                start[1] + dy * t
            ];
            // Offset sleeper center to track centerline
            const sleeperCenter = [
                sleeperCenterOnCenterline[0] + perp[0] * centerlineOffset,
                sleeperCenterOnCenterline[1] + perp[1] * centerlineOffset
            ];

            // Sleeper endpoints (perpendicular to track)
            const sleeperStart = [
                sleeperCenter[0] + perp[0] * sleeperLength / 2,
                sleeperCenter[1] + perp[1] * sleeperLength / 2
            ];
            const sleeperEnd = [
                sleeperCenter[0] - perp[0] * sleeperLength / 2,
                sleeperCenter[1] - perp[1] * sleeperLength / 2
            ];

            const [startLat, startLng] = htrs96ToWGS84(sleeperStart[0], sleeperStart[1]);
            const [endLat, endLng] = htrs96ToWGS84(sleeperEnd[0], sleeperEnd[1]);

            // Add sleeper as a pair of coordinates for MultiPolyline
            allSleeperCoords.push([
                L.latLng(startLat, startLng),
                L.latLng(endLat, endLng)
            ]);
        }
    }

    // Render ALL sleepers as a single MultiPolyline using Canvas renderer
    // This creates ONE DOM element instead of hundreds
    if (allSleeperCoords.length > 0) {
        const sleepersLayer = L.polyline(allSleeperCoords, {
            pane: paneName || undefined,
            renderer: trackCanvasRenderer,
            color: sleeperColor,
            weight: 1,
            opacity: 0.7
        });
        layerGroup.addLayer(sleepersLayer);
    }
}

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

// Render track with rails and sleepers
// Returns a Leaflet layer group containing the track visualization
// Options: { isPreview, railColor, sleeperColor, trackWidth }
function renderTrackWithRails(points, isPreview = false, options = {}) {
    if (!points || points.length < 2) return null;

    // Ensure canvas renderer is initialized (lazy init for when map loads)
    if (!trackCanvasRenderer) {
        trackCanvasRenderer = getTrackCanvasRenderer();
    }

    const layerGroup = L.layerGroup();
    const paneName = options.pane || null;
    const sleeperSpacing = 0.6; // Sleepers every 0.6 meters
    const sleeperLength = 2.5; // Sleeper length in meters

    // Determine colors: use provided colors, or fall back to defaults
    const railColor = options.railColor !== undefined
        ? options.railColor
        : (isPreview ? '#ff6600' : '#333333');
    const sleeperColor = options.sleeperColor !== undefined
        ? options.sleeperColor
        : (isPreview ? '#cc6600' : '#8B4513');

    // Get track width from options, or use module-level trackWidth if available
    // trackWidth is declared at module level (line 2899)
    const trackWidthValue = options.trackWidth !== undefined
        ? parseFloat(options.trackWidth)
        : trackWidth; // Reference module-level variable

    // Convert points to HTRS96 for calculations
    const htrsPoints = points.map(p => wgs84ToHTRS96(p.lat, p.lng));

    // Check if we should draw two parallel tracks (when width is 10m or close)
    const isDoubleTrack = trackWidthValue >= 9.5; // Allow some tolerance for floating point

    if (isDoubleTrack) {
        // Draw two parallel tracks
        // Position them symmetrically within the width
        // Track 1: offset -2.5m from centerline
        // Track 2: offset +2.5m from centerline
        const trackOffset = 2.5; // Distance from centerline to each track center

        renderSingleTrack(htrsPoints, -trackOffset, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup, paneName);
        renderSingleTrack(htrsPoints, trackOffset, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup, paneName);
    } else {
        // Draw single track at centerline
        renderSingleTrack(htrsPoints, 0, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup, paneName);
    }
    return layerGroup;
}

// Calculate the radius of a circle through three points
function calculateCurvatureRadius(p1, p2, p3) {
    // Convert lat/lng to meters for calculation
    const toMeters = (latLng) => {
        const [x, y] = wgs84ToHTRS96(latLng.lat, latLng.lng);
        return [x, y];
    };

    const a = toMeters(p1);
    const b = toMeters(p2);
    const c = toMeters(p3);

    // Calculate vectors
    const ab = [b[0] - a[0], b[1] - a[1]];
    const bc = [c[0] - b[0], c[1] - b[1]];
    const ac = [c[0] - a[0], c[1] - a[1]];

    // Calculate lengths
    const abLen = Math.hypot(ab[0], ab[1]);
    const bcLen = Math.hypot(bc[0], bc[1]);
    const acLen = Math.hypot(ac[0], ac[1]);

    if (abLen < 0.1 || bcLen < 0.1 || acLen < 0.1) {
        return Infinity; // Points too close, treat as straight
    }

    // Calculate area of triangle using cross product
    const area = Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) / 2;

    if (area < 0.1) {
        return Infinity; // Points are collinear, treat as straight
    }

    // Calculate radius using formula: R = (abc) / (4 * area)
    const radius = (abLen * bcLen * acLen) / (4 * area);

    return radius;
}

// Check if adding a new point would violate curvature constraints
// Returns: { valid: boolean, adjustedPoint: LatLng, violatesConstraint: boolean, wasAdjusted: boolean }
function checkCurvatureConstraint(points, newPoint, minRadius) {
    if (points.length < 2) {
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    const lastPoint = points[points.length - 1];
    const secondLastPoint = points.length >= 2 ? points[points.length - 2] : null;

    if (!secondLastPoint) {
        // Only one point, no curvature to check
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Convert to meters for calculation
    const [prevX, prevY] = wgs84ToHTRS96(secondLastPoint.lat, secondLastPoint.lng);
    const [lastX, lastY] = wgs84ToHTRS96(lastPoint.lat, lastPoint.lng);
    const [newX, newY] = wgs84ToHTRS96(newPoint.lat, newPoint.lng);

    // Calculate vectors
    const prevDx = lastX - prevX;
    const prevDy = lastY - prevY;
    const prevDist = Math.hypot(prevDx, prevDy);

    const dx = newX - lastX;
    const dy = newY - lastY;
    const dist = Math.hypot(dx, dy);

    // Check minimum distances
    if (prevDist < 0.1 || dist < 0.1) {
        // Points too close, can't check curvature meaningfully
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Calculate the turn angle
    const prevAngle = Math.atan2(prevDy, prevDx);
    const newAngle = Math.atan2(dy, dx);

    // Calculate the angle difference (turn angle)
    let angleDiff = newAngle - prevAngle;
    // Normalize to [-π, π]
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    const absAngleDiff = Math.abs(angleDiff);

    // For very small angles (nearly straight), accept immediately
    if (absAngleDiff < 0.01) {
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Calculate the actual radius of curvature from three points
    const radius = calculateCurvatureRadius(secondLastPoint, lastPoint, newPoint);

    // Primary check: if radius meets minimum, accept
    if (radius >= minRadius) {
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Radius is too small - calculate what's needed to fix it
    // For a circular arc: L = 2 * R * sin(θ/2), where L is chord length, R is radius, θ is turn angle
    // We need R >= minRadius, so: L >= 2 * minRadius * sin(θ/2)

    // The chord length is the straight-line distance from secondLastPoint to newPoint
    const chordDx = newX - prevX;
    const chordDy = newY - prevY;
    const chordLength = Math.hypot(chordDx, chordDy);

    // Calculate minimum required chord length for this turn angle
    const minRequiredChordLength = 2 * minRadius * Math.sin(absAngleDiff / 2);

    // If chord is already long enough but radius is still too small, 
    // this might be due to the geometry of the three points (not forming a proper arc)
    // In this case, we should still reject/adjust
    if (chordLength < minRequiredChordLength) {
        // Chord is too short - need to extend the new point to increase chord length
        // We'll extend along the current direction from lastPoint to newPoint

        // Calculate required distance from lastPoint to achieve minimum chord length
        // Using law of cosines: chordLength^2 = prevDist^2 + dist^2 - 2*prevDist*dist*cos(angleDiff)
        // Solving for dist: dist^2 - 2*prevDist*cos(angleDiff)*dist + (prevDist^2 - minRequiredChordLength^2) = 0
        const cosAngleDiff = Math.cos(absAngleDiff);
        const a = 1;
        const b = -2 * prevDist * cosAngleDiff;
        const c = prevDist * prevDist - minRequiredChordLength * minRequiredChordLength;
        const discriminant = b * b - 4 * a * c;

        if (discriminant < 0) {
            // No real solution - turn is too sharp even with infinite extension
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
        }

        const requiredDist = (-b + Math.sqrt(discriminant)) / (2 * a);

        // Only adjust if it's reasonable (not more than 2x the current distance)
        if (requiredDist > dist * 2 || requiredDist < dist * 0.5) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
        }

        // Extend the point along the current direction
        const scale = requiredDist / dist;
        const adjustedX = lastX + dx * scale;
        const adjustedY = lastY + dy * scale;

        const [adjustedLat, adjustedLng] = htrs96ToWGS84(adjustedX, adjustedY);
        const adjustedPoint = L.latLng(adjustedLat, adjustedLng);

        // Verify the adjusted point meets the constraint
        const adjustedRadius = calculateCurvatureRadius(secondLastPoint, lastPoint, adjustedPoint);
        if (adjustedRadius >= minRadius * 0.98) { // Allow 2% tolerance
            return { valid: true, adjustedPoint: adjustedPoint, violatesConstraint: false, wasAdjusted: true };
        }
    }

    // If we get here, the constraint is violated and we can't reasonably adjust
    return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
}

// Track Speed Picker modal implementation
function showTrackSpeedPicker() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('track-speed-modal');
        const grid = document.getElementById('track-speed-grid');
        const btnConfirm = document.getElementById('track-speed-confirm-btn');
        const btnCancel = document.getElementById('track-speed-cancel-btn');
        const widthSlider = document.getElementById('track-width-slider');
        const widthValue = document.getElementById('track-width-value');
        if (!modal || !grid || !btnConfirm || !btnCancel) {
            console.warn('Track speed modal elements missing');
            resolve({ speed: 50, minRadius: 300, width: 3.0 }); // fallback to default values
            return;
        }

        // Initialize track width slider
        let currentWidth = parseFloat(PersistentStorage.getItem('lastTrackWidth')) || 3.0;
        if (widthSlider && widthValue) {
            widthSlider.value = currentWidth;
            widthValue.textContent = currentWidth.toFixed(1);
            widthSlider.addEventListener('input', (e) => {
                currentWidth = parseFloat(e.target.value);
                widthValue.textContent = currentWidth.toFixed(1);
            });
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
            const width = widthSlider ? parseFloat(widthSlider.value) : currentWidth;
            PersistentStorage.setItem('lastTrackSpeedId', selected.dataset.id);
            if (widthSlider) {
                PersistentStorage.setItem('lastTrackWidth', String(width));
            }
            modal.style.display = 'none';
            // Collapse sidebar if open
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                try { toggleSidebar(); } catch (_) { }
            }
            resolve({ speed, minRadius, width });
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

// Toggle track drawing tool
function toggleTrackDrawTool() {
    // Gate: require personalized profile to draw tracks (which create proposals)
    if (typeof requirePersonalizedUser === 'function' && requirePersonalizedUser()) {
        return;
    }

    trackDrawingMode = !trackDrawingMode;
    updateGlobalTrackDrawingMode(trackDrawingMode);
    const trackDrawButton = document.getElementById('trackDrawButton');

    if (trackDrawingMode) {
        disableMultiSelectForDrawing();
        setRoadPanelLabelsForMode('track');
        // Deactivate road drawing if active
        if (roadDrawingMode) {
            exitRoadDrawingMode();
        }

        closeProposalDetailsForDrawing();

        // Close sidebar on mobile when activating track drawing
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                try { toggleSidebar(); } catch (_) { }
            }
        }

        // Activate track drawing mode
        console.log("Activating track drawing mode");
        if (trackDrawButton) {
            trackDrawButton.classList.add('active');
            trackDrawButton.classList.add('active-black-border');
        }

        map.getContainer().style.cursor = 'crosshair';
        map.getContainer().classList.add('crosshairs-cursor');

        // Disable other tools
        if (typeof measureMode !== 'undefined' && measureMode) toggleMeasureTool();

        // Disable parcel interaction
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
            });
        }

        // Hide other panels
        const blockInfoPanel = document.getElementById('block-info-panel');
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (blockInfoPanel) blockInfoPanel.classList.remove('visible');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');

        // Open the track panel and start listening for clicks. Shared by the fresh-draw path (after the
        // speed picker resolves) and the seeded path (speed and width come from the track being continued).
        const activateTrackDrawing = (statusText) => {
            const roadInfoPanel = document.getElementById('road-info-panel');
            if (roadInfoPanel) {
                roadInfoPanel.style.removeProperty('display');
                roadInfoPanel.classList.add('visible');
            }
            setRoadPanelLabelsForMode('track');
            const statusElement = document.getElementById('status');
            if (statusElement) updateStatus(statusText);
            const roadDrawingControls = document.getElementById('road-drawing-controls');
            if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
            updateUndoButtonState();
            map.on('click', handleTrackClick);
            map.on('mousemove', handleTrackMouseMove);
            map.on('mouseout', handleTrackMouseOut);
            document.addEventListener('keydown', handleTrackKeydown);
            if (typeof window !== 'undefined') {
                window.trackPreviewAffectedParcelIds = new Set();
            }
        };

        // Continuing an existing track: its geometry, width and speed are already decided, so skip the
        // picker and reopen the tool on that track. The seed is consumed once.
        const trackSeed = (typeof window !== 'undefined') ? window.pendingTrackDrawingSeed : null;
        if (trackSeed) {
            window.pendingTrackDrawingSeed = null;
            if (seedTrackDrawing(trackSeed)) {
                activateTrackDrawing('Click to continue the track, or click its first point to draw from the other end');
                return;
            }
        }

        // Initialize track speed via picker modal
        try {
            showTrackSpeedPicker().then(({ speed, minRadius, width }) => {
                trackSpeed = speed;
                trackMinCurvatureRadius = minRadius;
                if (width !== undefined) {
                    trackWidth = width;
                }

                activateTrackDrawing('Click on the map to start drawing a track');
            }).catch(() => {
                // If picker was cancelled, turn off drawing mode
                trackDrawingMode = false;
                updateGlobalTrackDrawingMode(false);
                if (trackDrawButton) {
                    trackDrawButton.classList.remove('active');
                    trackDrawButton.classList.remove('active-black-border');
                }
                map.getContainer().style.cursor = '';
                map.getContainer().classList.remove('crosshairs-cursor');
                map.off('click', handleTrackClick);
                map.off('mousemove', handleTrackMouseMove);
                map.off('mouseout', handleTrackMouseOut);
                document.removeEventListener('keydown', handleTrackKeydown);
                restoreParcelClickInteractivity();
                setRoadPanelLabelsForMode('road');
            });
        } catch (e) {
            console.warn('Track speed picker unavailable', e);
            trackSpeed = 120;
            trackMinCurvatureRadius = 1000;
            const roadInfoPanel = document.getElementById('road-info-panel');
            if (roadInfoPanel) {
                roadInfoPanel.style.removeProperty('display');
                roadInfoPanel.classList.add('visible');
            }
            setRoadPanelLabelsForMode('track');
            const statusElement = document.getElementById('status');
            if (statusElement) updateStatus('Click on the map to start drawing a track');
        }
    } else {
        // Deactivate track drawing mode
        console.log("Deactivating track drawing mode");
        setRoadPanelLabelsForMode('road');
        if (trackDrawButton) {
            trackDrawButton.classList.remove('active');
            trackDrawButton.classList.remove('active-black-border');
        }

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'none';
        map.getContainer().style.cursor = '';
        map.getContainer().classList.remove('crosshairs-cursor');

        // Remove track drawing event handlers
        map.off('click', handleTrackClick);
        map.off('mousemove', handleTrackMouseMove);
        map.off('mouseout', handleTrackMouseOut);
        document.removeEventListener('keydown', handleTrackKeydown);

        // Re-enable parcel interaction
        restoreParcelClickInteractivity();

        // Reset track drawing variables
        resetTrackDrawing(false);

        // Hide the road info panel
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) roadInfoPanel.classList.remove('visible');

        // Clear status
        const statusElement = document.getElementById('status');
        if (statusElement) updateStatus('');
    }
}

// Handle keyboard events during track drawing
function handleTrackKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    // F finishes the track: the drawing instantly becomes an applied object (SimCity lifecycle).
    if ((e.key === 'f' || e.key === 'F') && trackHasStarted && trackPoints.length >= 2) {
        e.preventDefault();
        finishTrackDrawing();
    }

    // Check for U key (undo last segment)
    if ((e.key === 'u' || e.key === 'U') && trackHasStarted && trackPoints.length > 1) {
        e.preventDefault();
        undoLastTrackSegment();
    }

    if (e.key === 'Escape') {
        e.preventDefault();
        cancelTrackDrawing();
    }
}

// Undo last track segment
function undoLastTrackSegment() {
    if (!trackHasStarted || trackPoints.length <= 1) {
        return; // Can't undo if there's only one point or none
    }

    // Remove tunnel metadata paired with this edge before its endpoint disappears.
    const removedPoint = trackPoints[trackPoints.length - 1];
    const previousPoint = trackPoints[trackPoints.length - 2];
    if (typeof removeBuildingTunnelEdge === 'function') {
        trackBuildingTunnels = removeBuildingTunnelEdge(trackBuildingTunnels, previousPoint, removedPoint);
    }
    trackPoints.pop();
    refreshTrackBuildingTunnelLayer();
    const lastMarker = trackMarkers.pop();
    if (lastMarker && map.hasLayer(lastMarker)) {
        map.removeLayer(lastMarker);
    }

    // Rebuild the centerline
    if (trackCenterline) {
        map.removeLayer(trackCenterline);
        trackCenterline = null;
    }
    if (trackPoints.length > 0) {
        trackCenterline = L.polyline(trackPoints, {
            color: 'transparent',
            weight: 0,
            opacity: 0
        }).addTo(map);
    } else {
        trackHasStarted = false;
    }

    // Rebuild rails and the corridor polygon
    if (trackRailsLayer) {
        map.removeLayer(trackRailsLayer);
        trackRailsLayer = null;
    }
    if (trackPolygonLayer) {
        map.removeLayer(trackPolygonLayer);
        trackPolygonLayer = null;
    }
    if (trackPoints.length >= 2) {
        trackRailsLayer = renderTrackWithRails(trackPoints, false, { trackWidth: trackWidth });
        if (trackRailsLayer) trackRailsLayer.addTo(map);
        trackPolygon = calculateRoadPolygon(trackPoints, trackWidth);
        if (trackPolygon) {
            trackPolygonLayer = L.polygon(trackPolygon, {
                color: '#0066cc',
                weight: 2,
                fillColor: '#0066cc',
                fillOpacity: 0.3
            }).addTo(map);
        }
    } else {
        trackPolygon = null;
    }

    // Re-derive the locked parcels from the corridor rather than reversing a per-edge history entry:
    // once a track can be seeded or reversed, "the last entry" no longer describes the last vertex.
    recomputeLockedParcelsFromPolygon(trackPolygon, true);

    setRoadParcelStats(lockedStats.parcelCount, formatParcelArea(lockedStats.totalArea));
    setRoadOwnershipCounts(lockedStats.ownershipCounts);

    const marketEl = document.getElementById('road-market-price');
    if (marketEl) {
        marketEl.textContent = lockedStats.marketPrice > 0 ? formatCurrency(lockedStats.marketPrice) : '—';
    }

    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = lockedStats.individualOwners > 0 ? lockedStats.individualOwners.toString() : '—';
    }

    updateRoadAcquiringDifficulty(trackAffectedParcels);
    updateRoadInfoPanel();
    updateUndoButtonState();
    saveCurrentCorridorDrawingDraft('track');
}

// Handle track drawing clicks
// A track is a single un-branched polyline, so it has exactly two ends. Drawing always appends to the
// last vertex; clicking the *first* vertex flips the polyline so the track grows from its other end
// instead. This is what lets a seeded track (copied, or reloaded) be continued in either direction.
function reverseTrackDirection() {
    trackPoints.reverse();
    trackMarkers.reverse();
    if (trackCenterline) trackCenterline.setLatLngs(trackPoints);
    updateStatus('Continuing the track from its other end');
    saveCurrentCorridorDrawingDraft('track');
}

async function handleTrackClick(e) {
    L.DomEvent.stopPropagation(e);

    const clickPoint = e.latlng;

    if (trackHasStarted && trackPoints.length > 1) {
        const start = map.latLngToLayerPoint(trackPoints[0]);
        if (map.latLngToLayerPoint(clickPoint).distanceTo(start) <= ROAD_SNAP_PIXELS) {
            reverseTrackDirection();
            updateUndoButtonState();
            return;
        }
    }

    if (!trackHasStarted) {
        // First click - start the track
        trackPoints = [clickPoint];
        trackHasStarted = true;

        // Add marker for the starting point
        const startMarker = L.circleMarker(clickPoint, {
            radius: 5,
            color: '#0066cc',
            fillColor: '#0066cc',
            fillOpacity: 1
        }).addTo(map);
        trackMarkers.push(startMarker);

        // Initialize track centerline - will be replaced with rails rendering
        trackCenterline = L.polyline([clickPoint], {
            color: 'transparent',
            weight: 0,
            opacity: 0
        }).addTo(map);

        // Create rails layer for committed track
        trackRailsLayer = L.layerGroup().addTo(map);

        updateStatus('Click to add track points, "Finish" when done');
    } else {
        // Check curvature constraint - only adjust if violation is severe and adjustment is reasonable
        const constraintCheck = checkCurvatureConstraint(trackPoints, clickPoint, trackMinCurvatureRadius);

        // Only use adjusted point if it was actually adjusted AND the adjustment is reasonable
        // Otherwise use the clicked point to avoid overshoot
        let pointToAdd = clickPoint;

        // Only show warnings if the constraint is actually violated (consistent with preview)
        if (constraintCheck.violatesConstraint) {
            // Constraint is violated - show warning
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Warning: Curvature exceeds minimum radius for selected speed.', 3000, 'warning');
            }
        } else if (constraintCheck.wasAdjusted) {
            // Constraint was met by adjusting - check if adjustment is reasonable
            const [clickX, clickY] = wgs84ToHTRS96(clickPoint.lat, clickPoint.lng);
            const [adjX, adjY] = wgs84ToHTRS96(constraintCheck.adjustedPoint.lat, constraintCheck.adjustedPoint.lng);
            const [lastX, lastY] = wgs84ToHTRS96(trackPoints[trackPoints.length - 1].lat, trackPoints[trackPoints.length - 1].lng);
            const clickDist = Math.hypot(clickX - lastX, clickY - lastY);
            const adjDist = Math.hypot(adjX - lastX, adjY - lastY);
            const adjustmentRatio = Math.abs(adjDist - clickDist) / Math.max(clickDist, 0.1);

            // Only use adjusted point if adjustment is less than 20% of the segment length
            if (adjustmentRatio < 0.2) {
                pointToAdd = constraintCheck.adjustedPoint;
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Point adjusted to meet minimum curvature radius.', 2000, 'info');
                }
            }
            // If adjustment is too large, just use clicked point (no warning since constraint is met)
        }

        // Build the segment polygon for this click
        const segmentPoints = [trackPoints[trackPoints.length - 1], pointToAdd];
        const segmentPolygon = calculateRoadPolygon(segmentPoints, trackWidth);
        let buildingTunnel = null;
        if (segmentPolygon && typeof detectLoadedBuildingTunnelIntersections === 'function') {
            const hits = detectLoadedBuildingTunnelIntersections(segmentPolygon);
            if (hits.length) {
                const resolution = typeof resolveBuildingObstacles === 'function'
                    ? await resolveBuildingObstacles(hits, 'track')
                    : { action: 'cancel', removedProposalIds: [] };
                if (resolution.action === 'cancel') return;
                if (resolution.action === 'tunnel') {
                    const removedOwners = new Set(resolution.removedProposalIds || []);
                    const standingHits = hits.filter(hit => {
                        const owner = typeof corridorTunnelHitProposalId === 'function' ? corridorTunnelHitProposalId(hit) : null;
                        return !owner || !removedOwners.has(owner);
                    });
                    buildingTunnel = (standingHits.length && typeof makeBuildingTunnelRecord === 'function')
                        ? makeBuildingTunnelRecord(segmentPoints[0], segmentPoints[1], standingHits, { segmentId: 'track' })
                        : null;
                }
            }
            // Parks/squares/lakes in the way get their own decision: unapply / build through / reroute.
            if (typeof detectStructureCrossings === 'function' && typeof resolveStructureCrossings === 'function') {
                const structureHits = detectStructureCrossings(segmentPolygon);
                if (structureHits.length && !(await resolveStructureCrossings(structureHits, 'track'))) return;
            }
        }

        // Add point to track
        trackPoints.push(pointToAdd);
        if (buildingTunnel && typeof addBuildingTunnelRecord === 'function') {
            trackBuildingTunnels = addBuildingTunnelRecord(trackBuildingTunnels, buildingTunnel);
            refreshTrackBuildingTunnelLayer();
        }

        // Play feedback sound for the committed segment
        playTrackSegmentSound();

        // Add marker for this point
        const pointMarker = L.circleMarker(pointToAdd, {
            radius: 5,
            color: '#0066cc',
            fillColor: '#0066cc',
            fillOpacity: 1
        }).addTo(map);
        trackMarkers.push(pointMarker);

        // Update the centerline
        trackCenterline.addLatLng(pointToAdd);

        // Clear preview layers first (rails will be rendered once after polygon calculation)
        if (trackPreviewPolygonLayer) {
            trackPreviewPolygonLayer.removeFrom(map);
            trackPreviewPolygonLayer = null;
        }
        if (trackPreviewRailsLayer) {
            map.removeLayer(trackPreviewRailsLayer);
            trackPreviewRailsLayer = null;
        }
        if (trackPreviewLine) {
            trackPreviewLine.removeFrom(map);
            trackPreviewLine = null;
        }

        // PERFORMANCE: Incrementally union the new segment polygon with existing track polygon
        // instead of recalculating the entire track polygon from scratch
        let newCommittedPolygon;
        if (segmentPolygon) {
            if (trackPolygon) {
                // Union new segment with existing track polygon
                newCommittedPolygon = combineRoadPolygons(trackPolygon, segmentPolygon);
            } else {
                // First segment - just use segment polygon
                newCommittedPolygon = segmentPolygon;
            }
        } else {
            // Segment polygon calculation failed - keep existing
            newCommittedPolygon = trackPolygon;
        }
        trackPolygon = newCommittedPolygon;

        // Remove previous committed polygon layer
        if (trackPolygonLayer) {
            map.removeLayer(trackPolygonLayer);
            trackPolygonLayer = null;
        }

        if (trackPolygon) {
            // Draw the committed track polygon with track styling (light background)
            trackPolygonLayer = L.polygon(trackPolygon, {
                color: '#0066cc',
                weight: 1,
                fillColor: '#e6f2ff',
                fillOpacity: 0.2
            }).addTo(map);

            // Render rails for the committed track ONCE (removed duplicate call)
            if (trackRailsLayer) {
                map.removeLayer(trackRailsLayer);
            }
            trackRailsLayer = renderTrackWithRails(trackPoints, false, { trackWidth: trackWidth });
            if (trackRailsLayer) {
                trackRailsLayer.addTo(map);
            }

            // Lock parcels from the new segment (same as roads - incremental, not reset)
            // This ensures stats accumulate correctly as segments are added
            // Use the segment polygon (from last point to new point), not the full track polygon
            if (segmentPolygon && segmentPolygon.length >= 3) {
                lockParcelsFromSegment(segmentPolygon);
            }
        } else {
            // If no polygon, still update the info panel to show current state
            updateRoadInfoPanel();
        }
    }

    // For first click (when trackPoints.length < 2), update the info panel to show initial state
    if (trackPoints.length < 2) {
        updateRoadInfoPanel();
    }

    // Enable undo once we have at least one segment
    updateUndoButtonState();
    saveCurrentCorridorDrawingDraft('track');
}

// Handle track mouse movement for preview
function handleTrackMouseMove(e) {
    if (!trackHasStarted || !trackPoints || trackPoints.length === 0) return;

    const mouseLatLng = e.latlng;

    // Check curvature constraint - use actual mouse position for preview, but check constraint for color
    const constraintCheck = checkCurvatureConstraint(trackPoints, mouseLatLng, trackMinCurvatureRadius);
    const isConstraintViolated = constraintCheck.violatesConstraint || false;

    // Always use actual mouse position for preview (no overshoot)
    const previewPoint = mouseLatLng;

    // Remove old preview elements
    if (trackPreviewLine) {
        trackPreviewLine.removeFrom(map);
        trackPreviewLine = null;
    }
    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }
    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }

    // PERFORMANCE: Only calculate polygon for the preview segment (last point to mouse),
    // NOT the entire track. This keeps preview snappy regardless of total segment count.
    const lastPoint = trackPoints[trackPoints.length - 1];
    const previewSegmentPoints = [lastPoint, previewPoint];

    // Pick colors based on curvature constraint
    const previewColor = isConstraintViolated ? '#ff0000' : '#ff6600';

    try {
        // Calculate polygon only for the preview segment
        const previewSegmentPolygon = calculateRoadPolygon(previewSegmentPoints, trackWidth);

        if (previewSegmentPolygon && previewSegmentPolygon.length >= 3) {
            // PERFORMANCE: Use simple polyline + polygon like roads do (not rails)
            // Rails are rendered only when track is finalized
            trackPreviewLine = L.polyline(previewSegmentPoints, {
                color: previewColor,
                dashArray: '5, 10',
                weight: 2
            }).addTo(map);

            trackPreviewPolygonLayer = L.polygon(previewSegmentPolygon, {
                color: previewColor,
                weight: 1,
                fillColor: previewColor,
                fillOpacity: 0.2
            }).addTo(map);

            // Find and highlight parcels affected by preview segment only
            findTrackPreviewAffectedParcels(previewSegmentPolygon);

            lastTrackMoveUpdate = Date.now();

            // PERFORMANCE: Fast update of track info with cumulative metrics (committed + preview)
            updatePreviewTrackInfo(previewSegmentPoints, previewSegmentPolygon);
        } else {
            clearTrackPreviewAffectedParcels();

            // Still show a simple preview line
            trackPreviewLine = L.polyline(previewSegmentPoints, {
                color: previewColor,
                dashArray: '5, 10',
                weight: 2
            }).addTo(map);
        }
    } catch (error) {
        console.error('Error in track preview calculation:', error);
        clearTrackPreviewAffectedParcels();

        // Still show a simple preview line
        trackPreviewLine = L.polyline(previewSegmentPoints, {
            color: previewColor,
            dashArray: '5, 10',
            weight: 2
        }).addTo(map);
    }
}

// Handle track mouse movement out
function handleTrackMouseOut(e) {
    if (!trackDrawingMode) return;

    if (trackPreviewLine) {
        trackPreviewLine.removeFrom(map);
        trackPreviewLine = null;
    }

    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }

    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    clearTrackPreviewAffectedParcels();
}

// Check if parcels are loaded for a given polygon
// Returns true if at least one parcel intersects with the polygon, false otherwise
function areParcelsLoadedForPolygon(polygon) {
    if (!polygon || !parcelLayer) return false;
    const turfPolygon = polygonLatLngsToTurfFeature(polygon);
    if (!turfPolygon) return false;

    // Check if any parcel intersects with the polygon
    let foundParcel = false;

    // Ensure getParcelOuterRingsLngLat is available
    if (typeof getParcelOuterRingsLngLat !== 'function') {
        return false;
    }

    try {
        parcelLayer.eachLayer(layer => {
            if (foundParcel) return; // Early exit if already found

            try {
                const outerRings = getParcelOuterRingsLngLat(layer);
                if (!outerRings || outerRings.length === 0) return;

                for (let r = 0; r < outerRings.length; r++) {
                    const ring = outerRings[r];
                    const turfParcelPolygon = turf.polygon([ring]);
                    if (turf.booleanIntersects(turfPolygon, turfParcelPolygon)) {
                        foundParcel = true;
                        return; // Break out of eachLayer
                    }
                }
            } catch (error) {
                // Continue checking other parcels
            }
        });
    } catch (error) {
        // If parcelLayer.eachLayer fails, assume parcels are not loaded
        return false;
    }

    return foundParcel;
}

// Find parcels affected by track
function findTrackAffectedParcels(trackPolygon) {
    if (!trackPolygon || !parcelLayer) return;

    // Define the green highlight style for committed track parcels (same as road)
    const committedTrackStyle = {
        fillColor: 'green',
        fillOpacity: 0.6,
        color: 'green',
        weight: 3
    };

    // Use shared function to find and highlight affected parcels
    trackAffectedParcels = findAndHighlightAffectedParcels(
        trackPolygon,
        trackAffectedParcels,
        committedTrackStyle,
        null,
        { skipBoundsFilter: true }
    );

    // Rebuild locked state from trackAffectedParcels (same as road)
    lockedTrackParcelIds.clear();
    trackAffectedParcels.forEach(p => {
        const id = getParcelIdFromAny(p);
        if (id) lockedTrackParcelIds.add(id.toString());
    });

    // Don't reset stats here - they're already correctly maintained by lockParcelsFromSegment()
    // Just update the info panel which will use the shared lockedStats
    updateRoadInfoPanel();
}

// Find parcels affected by track preview
// Uses the same approach as road preview: skip committed parcels entirely, only highlight new preview parcels
function findTrackPreviewAffectedParcels(trackPolygon) {
    if (!trackPolygon || !parcelLayer) return;

    // Clear previous preview highlights (reverts to locked style or base style)
    clearTrackPreviewAffectedParcels();

    // Create a turf polygon from the preview polygon
    const latLngs = trackPolygon.map(p => [p.lng, p.lat]);

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
    // Use mapBounds filter for performance during preview (same as road preview)
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

        const parcelId = getParcelIdFromFeature(layer.feature);
        if (!parcelId) return;

        // Skip if already locked (same as road preview)
        if (lockedTrackParcelIds.has(parcelId)) {
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

                    // Apply preview style (orange) - same as road preview
                    layer.setStyle(previewAffectedStyle);

                    if (typeof layer.bringToFront === 'function') {
                        layer.bringToFront();
                    }
                    break;
                }
            }
        } catch (error) { }
    });

    trackPreviewAffectedParcels = newPreviewParcels;

    // Update the Set for fast O(1) lookups in resetHighlight
    if (typeof window !== 'undefined') {
        window.trackPreviewAffectedParcelIds = new Set(
            newPreviewParcels
                .map(p => p.id)
                .filter(Boolean)
                .map(id => id.toString())
        );
    }

    // Calculate combined stats: locked stats + preview-only parcels (same as road preview)
    const previewArea = newPreviewParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
    const combinedCount = trackAffectedParcels.length + newPreviewParcels.length;
    const combinedArea = trackAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0) + previewArea;

    // Calculate combined ownership counts and market price for live preview (same as road preview)
    const combinedOwnershipCounts = {};
    let combinedMarketPrice = 0;
    let previewIndividualOwners = 0;

    // Add committed parcel stats
    for (const parcel of trackAffectedParcels) {
        combinedMarketPrice += Number(parcel.estimatedMarketPrice) || 0;
        const ownershipType = getOwnershipTypeFromParcel(parcel);
        if (combinedOwnershipCounts[ownershipType] !== undefined) {
            combinedOwnershipCounts[ownershipType]++;
        } else {
            combinedOwnershipCounts[ownershipType] = 1;
        }
    }

    // Add preview parcel stats
    for (const parcel of newPreviewParcels) {
        // Add market price
        combinedMarketPrice += Number(parcel.estimatedMarketPrice) || 0;

        // Get ownership type and count
        const ownershipType = getOwnershipTypeFromParcel(parcel);
        if (combinedOwnershipCounts[ownershipType] !== undefined) {
            combinedOwnershipCounts[ownershipType]++;
        } else {
            combinedOwnershipCounts[ownershipType] = 1;
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

    // Update UI with combined stats (same as road preview)
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

    // Update individual owners count (committed + preview)
    const lockedIndividualOwners = typeof getLockedIndividualOwnersCount === 'function'
        ? getLockedIndividualOwnersCount()
        : (lockedStats?.individualOwners || 0);
    const totalIndividualOwners = lockedIndividualOwners + previewIndividualOwners;
    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = totalIndividualOwners > 0 ? totalIndividualOwners.toString() : '—';
    }

    // Update acquiring difficulty with combined parcels
    const combinedParcels = [...trackAffectedParcels, ...newPreviewParcels];
    updateRoadAcquiringDifficulty(combinedParcels);
}

// Clear track affected parcels highlighting
function clearTrackAffectedParcels() {
    const trackIds = new Set(trackAffectedParcels.map(p => getParcelIdFromAny(p)).filter(Boolean));
    if (trackAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            const parcelId = getParcelIdFromFeature(layer.feature);
            if (parcelId && trackAffectedParcels.some(p => getParcelIdFromAny(p) === parcelId)) {
                const isRoad = typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }
    trackAffectedParcels = [];
    // Remove track-locked parcels from both track-specific and shared locks
    trackIds.forEach(id => {
        lockedParcelIds.delete(id);
        lockedTrackParcelIds.delete(id);
    });
}

// Clear track preview affected parcels highlighting
function clearTrackPreviewAffectedParcels() {
    // Only iterate through the preview parcels list, not all parcels (performance) - same as road version
    if (trackPreviewAffectedParcels.length > 0) {
        for (const previewParcel of trackPreviewAffectedParcels) {
            const layer = previewParcel.layer;
            const parcelId = previewParcel.id;
            if (!layer) continue;

            // Check if it's also part of the *locked* affected parcels (same as road version)
            if (lockedTrackParcelIds.has(parcelId) || lockedParcelIds.has(parcelId)) {
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
    trackPreviewAffectedParcels = []; // Clear the preview list
    // Clear the Set for fast lookups
    if (typeof window !== 'undefined') {
        window.trackPreviewAffectedParcelIds = new Set();
    }
}

// Finish track drawing
async function finishTrackDrawing() {
    if (!trackHasStarted || trackPoints.length < 2) return;

    const tunnelCheck = await ensureBuildingTunnelsForSegments(
        [trackPoints], trackWidth, 'track', trackBuildingTunnels, ['track']
    );
    if (!tunnelCheck.accepted) return;
    trackBuildingTunnels = tunnelCheck.records;
    refreshTrackBuildingTunnelLayer();

    // Immediately stop interactions and preview while finishing
    map.off('click', handleTrackClick);
    map.off('mousemove', handleTrackMouseMove);
    map.off('mouseout', handleTrackMouseOut);
    document.removeEventListener('keydown', handleTrackKeydown);

    if (trackPreviewLine) {
        map.removeLayer(trackPreviewLine);
        trackPreviewLine = null;
    }
    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }
    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    const trackPolygon = calculateRoadPolygon(trackPoints, trackWidth);
    if (!isValidPolygonLatLngs(trackPolygon)) {
        console.warn('finishTrackDrawing: invalid track polygon', { trackPolygon, trackPoints, trackWidth });
        showRoadAlert('invalid_track_shape_please_try_drawing_the_track_again', 'Invalid track shape. Please try drawing the track again.');
        exitTrackDrawingMode();
        return;
    }

    // Use the accumulated committed parcels collected during drawing (proposal draft), do not rescan map now
    const affectedParcels = Array.isArray(trackAffectedParcels) ? trackAffectedParcels.slice() : [];
    console.log('finishTrackDrawing: affected parcels count', affectedParcels.length);
    if (affectedParcels.length === 0) {
        console.warn('finishTrackDrawing: no affected parcels found', { trackPolygon, trackPoints });
        showRoadAlert('no_parcels_affected_by_this_track_please_try_drawing_the_track_again', 'No parcels affected by this track. Please try drawing the track again.');
        exitTrackDrawingMode();
        return;
    }

    const defaultAuthor = (typeof getCurrentUsername === 'function' && getCurrentUsername()) || '';
    const defaultName = generateRandomTrackName();
    const defaultOffer = generateRandomRoadOffer(5000, 200000); // Tracks might have different price range

    // Seed multi-parcel selection with the affected parcels so the generalized modal can open
    const parentParcelIds = affectedParcels
        .map(p => getParcelIdFromAny(p))
        .filter(Boolean)
        .map(id => id.toString());

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
        console.warn('Failed to seed multi-parcel selection for track proposal', selectionError);
    }

    const centerlineSegments = Array.isArray(trackPoints)
        ? trackPoints
            .map(pt => {
                const lat = Number(pt?.lat ?? (Array.isArray(pt) ? pt[1] : null));
                const lng = Number(pt?.lng ?? (Array.isArray(pt) ? pt[0] : null));
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return { lat, lng };
            })
            .filter(Boolean)
        : [];

    // Tunnelled stretches acquire nothing: parcels only under tunnel edges must not be parents.
    if (Array.isArray(trackBuildingTunnels) && trackBuildingTunnels.length) {
        const surfaceFootprint = corridorSurfaceFootprintGeoJSON([centerlineSegments], trackWidth, trackBuildingTunnels);
        const surfaceIds = new Set(surfaceFootprint ? collectParcelsIntersectingFootprint(surfaceFootprint) : []);
        for (let i = parentParcelIds.length - 1; i >= 0; i--) {
            if (!surfaceIds.has(parentParcelIds[i])) parentParcelIds.splice(i, 1);
        }
    }

    const latLngPairs = convertRoadPolygonToLatLngPairs(trackPolygon);
    const geoPolygon = convertLatLngPairsToGeoJSON(latLngPairs);

    if (!geoPolygon || !geoPolygon.type || !Array.isArray(geoPolygon.coordinates)) {
        console.error('[finishTrackDrawing] Failed to create GeoJSON polygon from track geometry:', {
            hasTrackPolygon: !!trackPolygon,
            trackPolygonLength: Array.isArray(trackPolygon) ? trackPolygon.length : 'not array',
            hasLatLngPairs: !!latLngPairs,
            latLngPairsLength: Array.isArray(latLngPairs) ? latLngPairs.length : 'not array',
            geoPolygon
        });
    }

    const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

    const trackDrawingContext = {
        parentParcelIds: parentParcelIds.slice(),
        centerline: [centerlineSegments],
        polygon: geoPolygon,
        latLngPairs,
        width: trackWidth,
        sidewalkWidth: null,
        tunnels: JSON.parse(JSON.stringify(trackBuildingTunnels || [])),
        stats: ownershipAndAcquisitionStats,
        metadata: {
            mode: 'draw',
            type: 'track',
            isTrack: true,
            isRoad: false, // tracks are NOT roads
            isCorridor: true,
            source: 'road-drawing',
            trackSpeed: trackSpeed,
            trackMinRadius: trackMinCurvatureRadius
        }
    };

    if (typeof pendingRoadDrawingProposal !== 'undefined') {
        pendingRoadDrawingProposal = trackDrawingContext;
    }
    if (typeof window !== 'undefined') {
        window.pendingRoadDrawingProposal = trackDrawingContext;
    }

    if (typeof showProposalDialog !== 'function') {
        console.error('[finishTrackDrawing] showProposalDialog is not defined');
        exitTrackDrawingMode();
        return;
    }

    // Same lineage hand-off as roads: a track that began life as a copy carries its source to the dialog.
    const copySource = (typeof window !== 'undefined') ? window.pendingRoadCopySource : null;
    if (typeof window !== 'undefined') window.pendingRoadCopySource = null;
    const copyPrefill = (copySource && copySource.prefill) ? copySource.prefill : {};

    // SimCity lifecycle: finishing the drawing IS the creation (see finishRoadDrawing).
    // Drafts are created lazily on autosave — force one now if missing.
    if (!window.activeProposalDesignDraftId) saveCurrentCorridorDrawingDraft('track');
    const designDraftId = window.activeProposalDesignDraftId;
    if (designDraftId && window.proposalDraftStore?.getDraft?.(designDraftId)) {
        window.syncActiveProposalDraftFromEditor?.('corridor', {
            ...trackDrawingContext,
            kind: 'track'
        }, { parentParcelIds, coalesceKey: 'corridor-finalize' });
        exitTrackDrawingMode();
        const merged = await absorbConnectedLocalCorridors('track', geoPolygon, designDraftId);
        const createdId = await window.instantCreateProposalFromDraft?.(designDraftId);
        if (createdId && typeof updateStatus === 'function') {
            updateStatus(merged
                ? translateRoadText('panel.road.mergedStatusTrack', 'Connected to “{{name}}” — now one track.', { name: merged.name })
                : translateRoadText('panel.road.builtStatusTrack', 'Track built — click it to edit or propose.'));
        }
        return;
    }

    // Legacy path (drawing started without a design draft): the classic create dialog.
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
    exitTrackDrawingMode();
    if (typeof updateStatus === 'function') {
        updateStatus('Track geometry captured.');
    }
}

// Cancel track drawing
async function cancelTrackDrawing() {
    const saved = saveCurrentCorridorDrawingDraft('track');
    exitTrackDrawingMode();
    if (saved) showCorridorDraftSavedToast('track');
    return true;
}

// Exit track drawing mode
function exitTrackDrawingMode() {
    map.off('click', handleTrackClick);
    map.off('mousemove', handleTrackMouseMove);
    map.off('mouseout', handleTrackMouseOut);
    document.removeEventListener('keydown', handleTrackKeydown);

    if (trackPreviewLine) {
        map.removeLayer(trackPreviewLine);
        trackPreviewLine = null;
    }
    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }
    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    resetTrackDrawing();
    trackDrawingMode = false;
    updateGlobalTrackDrawingMode(false);

    const trackDrawButton = document.getElementById('trackDrawButton');
    if (trackDrawButton) {
        trackDrawButton.classList.remove('active');
        trackDrawButton.classList.remove('active-black-border');
    }

    const roadDrawingControls = document.getElementById('road-drawing-controls');
    if (roadDrawingControls) roadDrawingControls.style.display = 'none';

    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        roadInfoPanel.classList.remove('visible');
    }
    setRoadPanelLabelsForMode('road');

    map.getContainer().style.cursor = '';
    map.getContainer().classList.remove('crosshairs-cursor');

    restoreParcelClickInteractivity();

    const statusElement = document.getElementById('status');
    if (statusElement) updateStatus('');
    updateRoadDraftStatus(false);
    window.finishProposalDraftDesignSession?.();
}

// Reset track drawing variables
function resetTrackDrawing(hidePanel = true) {
    // Capture the current committed track parcel IDs before clearing highlights
    const trackIds = new Set(trackAffectedParcels.map(p => getParcelIdFromAny(p)).filter(Boolean));

    // Clear affected parcels highlighting BEFORE clearing the arrays
    clearTrackAffectedParcels();
    clearTrackPreviewAffectedParcels();

    trackPoints = [];
    trackBuildingTunnels = [];
    trackHasStarted = false;
    trackAffectedParcels = [];
    trackIds.forEach(id => {
        lockedParcelIds.delete(id);
        lockedTrackParcelIds.delete(id);
    });

    // Clear segment history for undo
    trackSegmentHistory = [];

    // Reset cached committed track metrics
    committedTrackMetrics.length = 0;
    committedTrackMetrics.area = 0;

    // Reset shared lockedStats when exiting track mode (same as roads)
    lockedStats.parcelCount = 0;
    lockedStats.totalArea = 0;
    lockedStats.ownershipCounts = { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 };
    lockedStats.marketPrice = 0;
    lockedStats.individualOwners = 0;

    if (trackCenterline) {
        map.removeLayer(trackCenterline);
        trackCenterline = null;
    }

    if (trackRailsLayer) {
        map.removeLayer(trackRailsLayer);
        trackRailsLayer = null;
    }

    if (trackPolygonLayer && map.hasLayer(trackPolygonLayer)) {
        map.removeLayer(trackPolygonLayer);
        trackPolygonLayer = null;
    }
    trackPolygon = null;

    if (trackPreviewLine) {
        map.removeLayer(trackPreviewLine);
        trackPreviewLine = null;
    }

    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }

    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    for (const marker of trackMarkers) {
        if (marker && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    }
    trackMarkers = [];
    if (trackBuildingTunnelLayer && map.hasLayer(trackBuildingTunnelLayer)) {
        map.removeLayer(trackBuildingTunnelLayer);
    }
    trackBuildingTunnelLayer = null;

    if (hidePanel) {
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) {
            roadInfoPanel.classList.remove('visible');
        }
    }

    // Initialize Set for fast lookups
    if (typeof window !== 'undefined') {
        window.trackPreviewAffectedParcelIds = new Set();
    }
}

// Expose renderTrackWithRails globally for use in other modules
if (typeof window !== 'undefined') {
    window.renderTrackWithRails = renderTrackWithRails;
    // Expose trackPreviewAffectedParcels so other modules can check if a parcel is in track preview
    Object.defineProperty(window, 'trackPreviewAffectedParcels', {
        get: function () { return trackPreviewAffectedParcels; }
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
