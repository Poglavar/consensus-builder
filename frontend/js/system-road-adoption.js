// Turns a clicked system-loaded road parcel into an ordinary local corridor proposal, then opens the
// existing cross-section editor. Pure geometry/data helpers are exported for fast Node tests.
(function (global, factory) {
    'use strict';

    const api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) {
        global.SystemRoadAdoption = api;
        global.adoptSelectedSystemRoad = api.adoptSelectedSystemRoad;
    }
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const MAX_ADOPTED_ROAD_WIDTH = 80;
    const MIN_ADOPTED_ROAD_WIDTH = 2;
    const DEFAULT_ROAD_WIDTH = 7.5;
    // Metres of slack around the clicked parcel when pulling OSM centrelines. A junction just
    // outside the parcel still has to be SEEN, or the segment it ends would run on past it.
    const OSM_FETCH_MARGIN = 80;
    // Metres of tie window when picking the run under the pointer. Small on purpose: a wide window
    // hands back the street NEXT TO the one the pointer is on. See pickRunForClick.
    const SEGMENT_PICK_RADIUS = 2;
    // Metres: a run shorter than this inside the parcel is a crossing remnant, not a segment.
    const MIN_RUN_LENGTH = 20;
    let adoptionInFlight = false;

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function isRoadProposal(proposal) {
        if (!proposal) return false;
        const goal = String(proposal.goal || '').trim().toLowerCase();
        return goal === 'road-track' || !!proposal.roadProposal;
    }

    // A stable name for one segment, from where it starts and ends and how long it is. Two adoptions
    // of the same street produce the same key; the street next to it does not.
    function segmentKeyFor(centerline) {
        if (!Array.isArray(centerline) || centerline.length < 2) return null;
        const at = point => (Array.isArray(point)
            ? [Number(point[0]), Number(point[1])]
            : [Number(point.lng), Number(point.lat)]);
        const [ax, ay] = at(centerline[0]);
        const [bx, by] = at(centerline[centerline.length - 1]);
        if (![ax, ay, bx, by].every(Number.isFinite)) return null;
        const key = (x, y) => `${x.toFixed(5)},${y.toFixed(5)}`;
        const first = key(ax, ay);
        const last = key(bx, by);
        // Order-independent: the same run drawn either way is the same segment.
        return first < last ? `${first}|${last}` : `${last}|${first}`;
    }

    function roadProposalSegmentKey(proposal) {
        return proposal?.definition?.metadata?.segmentKey
            || proposal?.roadProposal?.definition?.metadata?.segmentKey
            || null;
    }

    // A cadastral road parcel carries a whole network, so ONE adopted street must not close the
    // parcel to the others: adopting Ulica A used to make every other street in the same polygon
    // unclickable. What blocks a second adoption is the same SEGMENT already being adopted, not the
    // same parcel — so the check needs the segment, and falls open when the caller has not resolved
    // one yet (the panel asks before the pointer has picked a street).
    function canOffer(feature, parcelId, proposals = [], options = {}) {
        const properties = feature?.properties || {};
        const roadByRegistry = !!(parcelId && typeof global.isRoadParcel === 'function'
            && global.isRoadParcel(String(parcelId)));
        const isSystemRoad = roadByRegistry || properties.isRoad === true || properties.isRoad === 'true';
        const polygonal = feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon';
        // Only the proposal's OWN output is off limits. `ancestorProposal`/`proposalId` merely say
        // this land was re-cut when some proposal applied — which is true of the REMAINDER too, and
        // the remainder is the rest of the road, still unclaimed and still adoptable. Excluding it
        // is what made the neighbouring streets unclickable the moment one street was adopted:
        // applying cuts the parcel into the corridor that was taken (isProposed) and the leftover
        // that was not, and only the first of those is finished with.
        const proposalDerived = properties.isProposed === true;
        const segmentKey = options.segmentKey || null;
        const alreadyAdopted = !!segmentKey && (proposals || [])
            .filter(isRoadProposal)
            .some(proposal => roadProposalSegmentKey(proposal) === segmentKey);
        return !!(isSystemRoad && polygonal && !proposalDerived && !alreadyAdopted);
    }

    function pointInRing(point, ring) {
        if (!Array.isArray(point) || !Array.isArray(ring) || ring.length < 3) return false;
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = Number(ring[i]?.[0]);
            const yi = Number(ring[i]?.[1]);
            const xj = Number(ring[j]?.[0]);
            const yj = Number(ring[j]?.[1]);
            if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
            const crosses = ((yi > y) !== (yj > y))
                && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    function ringArea(ring) {
        if (!Array.isArray(ring)) return 0;
        let twiceArea = 0;
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (!a || !b) continue;
            twiceArea += Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1]);
        }
        return Math.abs(twiceArea) / 2;
    }

    // A system feature can occasionally be a MultiPolygon. Adopt the part the user clicked; without
    // a click coordinate, choose the largest part instead of silently joining disconnected roads.
    function clickedRoadGeometry(feature, clickLngLat = null) {
        const geometry = feature?.geometry;
        if (!geometry) return null;
        if (geometry.type === 'Polygon') return clone(geometry);
        if (geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) return null;
        const polygons = geometry.coordinates.filter(poly => Array.isArray(poly?.[0]) && poly[0].length >= 4);
        if (!polygons.length) return null;
        const clicked = Array.isArray(clickLngLat)
            ? polygons.find(poly => pointInRing(clickLngLat, poly[0]))
            : null;
        const chosen = clicked || polygons.slice().sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
        return { type: 'Polygon', coordinates: clone(chosen) };
    }

    function pointSegmentDistanceSquared(point, a, b) {
        const px = Number(point?.[0]);
        const py = Number(point?.[1]);
        const ax = Number(a?.[0]);
        const ay = Number(a?.[1]);
        const bx = Number(b?.[0]);
        const by = Number(b?.[1]);
        if (![px, py, ax, ay, bx, by].every(Number.isFinite)) return Infinity;
        const dx = bx - ax;
        const dy = by - ay;
        const denom = dx * dx + dy * dy;
        const t = denom > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom)) : 0;
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        return (px - qx) ** 2 + (py - qy) ** 2;
    }

    function cleanLine(line) {
        const result = [];
        (line || []).forEach(pair => {
            const lng = Number(pair?.[0]);
            const lat = Number(pair?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            const previous = result[result.length - 1];
            if (previous && previous[0] === lng && previous[1] === lat) return;
            result.push([lng, lat]);
        });
        return result.length >= 2 ? result : null;
    }

    function centerlineCandidates(metrics) {
        const candidates = [];
        (metrics?.segments || []).forEach(segment => {
            const line = cleanLine(segment?.centerline);
            if (line) candidates.push(line);
        });
        const geometry = metrics?.centerline?.geometry;
        if (geometry?.type === 'LineString') {
            const line = cleanLine(geometry.coordinates);
            if (line) candidates.push(line);
        } else if (geometry?.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach(coords => {
                const line = cleanLine(coords);
                if (line) candidates.push(line);
            });
        }
        return candidates;
    }

    function centerlineFromMetrics(metrics, clickLngLat = null) {
        const candidates = centerlineCandidates(metrics);
        if (!candidates.length) return null;
        let selected = candidates[0];
        if (Array.isArray(clickLngLat) && candidates.length > 1) {
            selected = candidates.reduce((best, line) => {
                const distance = line.slice(1).reduce((minimum, point, index) => (
                    Math.min(minimum, pointSegmentDistanceSquared(clickLngLat, line[index], point))
                ), Infinity);
                return distance < best.distance ? { line, distance } : best;
            }, { line: selected, distance: Infinity }).line;
        }
        return selected.map(([lng, lat]) => ({ lat, lng }));
    }

    function clampRoadWidth(value) {
        return Math.max(MIN_ADOPTED_ROAD_WIDTH, Math.min(MAX_ADOPTED_ROAD_WIDTH, value));
    }

    function measuredRoadWidth(metrics, properties = {}) {
        const candidates = [
            metrics?.widths?.average,
            properties.roadWidth,
            properties.width
        ].map(Number);
        const measured = candidates.find(value => Number.isFinite(value) && value > 0) || DEFAULT_ROAD_WIDTH;
        return clampRoadWidth(measured);
    }

    // Every ring of a polygon or multipolygon, holes included — what a point-in-polygon test and a
    // clearance ray both need to see to respect a parcel with a hole in it.
    function geometryRings(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return (geometry.coordinates || []).filter(Array.isArray);
        if (geometry.type === 'MultiPolygon') {
            const rings = [];
            (geometry.coordinates || []).forEach(polygon => {
                (polygon || []).forEach(ring => { if (Array.isArray(ring)) rings.push(ring); });
            });
            return rings;
        }
        return [];
    }

    // Which piece of centreline a click adopts, and how wide that piece has room to be. Kept pure
    // and planar (metres) so the whole decision is testable without a map, a network or a browser:
    // the caller projects, fetches and renders.
    //
    // Order matters. The segment is chosen from the OSM centrelines FIRST (they carry the junction
    // topology that says where a segment ends), then bounded to the clicked parcel, and only then
    // measured — a width measured across a whole street is meaningless, a width measured across the
    // adopted run is the room that run actually has.
    function planSegmentAdoption(input = {}) {
        const segmentation = input.segmentation || global.RoadSegmentation;
        const parcelRingsXY = input.parcelRingsXY || [];
        const clickXY = Array.isArray(input.clickXY) ? input.clickXY : null;
        const options = input.options || {};
        const plan = { centerlineXY: null, width: null, segmentSource: null, widthSource: null, widthStats: null };
        if (!segmentation) return plan;

        const lines = (input.osmLinesXY || []).filter(line => Array.isArray(line) && line.length >= 2);
        // Both the segmenting and the clipping depend only on the centrelines and the parcel, never
        // on where the pointer is — so hover passes the runs it already has and only the pick reruns.
        const cachedRuns = Array.isArray(input.runsXY) && input.runsXY.length ? input.runsXY : null;
        const cachedSegments = Array.isArray(input.segmentsXY) ? input.segmentsXY : null;
        let runs = cachedRuns;
        if (!runs && (cachedSegments?.length || lines.length)) {
            const segments = cachedSegments?.length ? cachedSegments : segmentation.segmentRoadNetwork(lines, options);
            // Clip to the parcel BEFORE picking. Adoption must never reach into land the click did
            // not select, and picking first would hand back whichever long street merely crosses here.
            runs = parcelRingsXY.length
                ? segmentation.runsInsideRings(segments, parcelRingsXY)
                : segments;
        }
        if (runs?.length) {
            // Prefer the strip the click landed IN; distance to a centreline is only the fallback.
            const bands = Array.isArray(input.bandsXY) ? input.bandsXY : null;
            const chosen = clickXY
                ? (bands
                    ? segmentation.pickRunAtPoint(runs, bands, clickXY, options)
                    : segmentation.pickRunForClick(runs, clickXY, options))
                : null;
            plan.centerlineXY = chosen ? chosen.points : runs[0];
            plan.bandIndex = chosen && Number.isFinite(chosen.index) ? chosen.index : null;
            plan.segmentSource = 'osm-segment';
        }

        if (!plan.centerlineXY) {
            const fallback = input.fallbackCenterlineXY;
            if (Array.isArray(fallback) && fallback.length >= 2) {
                plan.centerlineXY = fallback;
                plan.segmentSource = 'parcel-axis';
            }
        }
        if (!plan.centerlineXY) return plan;

        // Measured against the parcel edges AND the buildings, so the road that gets built cannot be
        // wider than the gap it has to live in. The highlight still follows the parcel.
        const widthRings = (Array.isArray(input.widthRingsXY) && input.widthRingsXY.length)
            ? input.widthRingsXY
            : parcelRingsXY;
        // The other streets AROUND this one bound it, exactly as the parcel edge and the buildings do
        // — a carriageway of a dual boulevard must not adopt the whole boulevard, and a run reaching
        // a junction must not adopt the streets meeting there. Read from the unclipped network, since
        // the neighbours that matter are mostly in other parcels.
        const network = (Array.isArray(input.segmentsXY) && input.segmentsXY.length)
            ? input.segmentsXY
            : (runs || []);
        const neighbours = segmentation.neighbourSegments(plan.centerlineXY, network);
        const measured = segmentation.measureAvailableWidth(plan.centerlineXY, widthRings, { ...options, neighbours });
        // fitWidth is the one that fits along the WHOLE run; the quantile is only a fallback for a
        // run where no station saw both sides. An adopted road must not cut anything, and a road
        // built to a quantile cuts wherever the corridor is tighter than that.
        const chosen = Number.isFinite(measured?.fitWidth) && measured.fitWidth > 0
            ? measured.fitWidth
            : measured?.width;
        if (Number.isFinite(chosen) && chosen > 0) {
            plan.width = clampRoadWidth(chosen);
            plan.widthSource = input.widthRingsXY?.length ? 'clearance' : 'parcel-clearance';
            plan.widthStats = measured;
        }
        return plan;
    }

    function buildDefinition(feature, metrics, options = {}) {
        const clickLngLat = options.clickLngLat || null;
        const geometry = clickedRoadGeometry(feature, clickLngLat);
        const plan = options.plan || null;
        const planned = plan && Array.isArray(plan.centerline) && plan.centerline.length >= 2;
        const centerline = planned ? plan.centerline : centerlineFromMetrics(metrics, clickLngLat);
        if (!geometry || !centerline) return null;
        const width = (planned && Number.isFinite(plan.width) && plan.width > 0)
            ? clampRoadWidth(plan.width)
            : measuredRoadWidth(metrics, feature?.properties);
        // An adopted street's width is GIVEN by the corridor, so the section is composed to fit it
        // (footways, then parking, then the lanes that are left). corridorProfileFromLegacy is for a
        // width someone chose, and its no-preset path just halves it into two enormous lanes.
        const fitProfile = options.profileFactory
            || (typeof global.corridorProfileForAvailableWidth === 'function'
                ? width => global.corridorProfileForAvailableWidth(width)
                : null);
        const makeProfile = fitProfile
            || (typeof global.corridorProfileFromLegacy === 'function'
                ? global.corridorProfileFromLegacy
                : null);
        // What OSM says the street already has beats what would merely FIT in it — the geometric fit
        // knows how many metres there are, the reconstruction knows how many lanes, which side the
        // parking is on and whether there is a cycle lane. It is only used at the planned width, since
        // a section is only valid for the total it was fitted to.
        const reconstructed = (planned && plan.profile && Number.isFinite(plan.width) && clampRoadWidth(plan.width) === width)
            ? plan.profile
            : null;
        const profile = reconstructed || (makeProfile ? makeProfile(width, null, false) : null);
        if (!profile) return null;
        const sidewalks = (profile.strips || []).filter(strip => strip.type === 'sidewalk');
        const sidewalkWidth = sidewalks.length
            ? sidewalks.reduce((sum, strip) => sum + Number(strip.width || 0), 0) / sidewalks.length
            : 0;
        const sourceParcelId = options.parcelId != null ? String(options.parcelId) : null;
        // The adopted footprint is the corridor swept along the CHOSEN SEGMENT, not the whole road
        // polygon — clicking one street should not adopt every street the parcel happens to cover.
        // Without a resolved segment there is nothing better to fall back on than the parcel itself.
        const footprint = (planned && plan.polygon) ? clone(plan.polygon) : geometry;
        return {
            points: [centerline],
            segments: [centerline],
            segmentIds: ['system-1'],
            segmentProfiles: {},
            profile: clone(profile),
            width,
            sidewalkWidth,
            tunnels: [],
            gradeSeparations: [],
            demolishedBuildings: [],
            polygon: footprint,
            metadata: {
                mode: 'adopt-system-road',
                type: 'road',
                isRoad: true,
                isTrack: false,
                isCorridor: true,
                source: 'system-road',
                sourceParcelId,
                segmentSource: planned ? (plan.segmentSource || 'osm-segment') : 'parcel-axis',
                widthSource: (planned && plan.widthSource) ? plan.widthSource : 'measured',
                // Which street of the parcel this is, so the next adoption in the same parcel is
                // recognised as a different street rather than a duplicate.
                segmentKey: segmentKeyFor(centerline),
                // The OSM ways the cross-section was read off. Kept so the editor can offer to go and
                // fix the SOURCE: when a reconstructed section is wrong, the fault is almost always in
                // the tagging, and this is the only pointer back to it.
                osmIds: (planned && Array.isArray(plan.osmIds)) ? plan.osmIds.slice(0, 8) : [],
                osmName: (planned && plan.streetName) ? String(plan.streetName) : null
            }
        };
    }

    function buildProposal(feature, metrics, options = {}) {
        const definition = buildDefinition(feature, metrics, options);
        if (!definition) return null;
        const properties = feature?.properties || {};
        const parcelId = String(options.parcelId || '');
        const roadName = String(properties.roadName || properties.name || '').trim();
        const title = roadName && roadName !== 'Unnamed Road'
            ? roadName
            : (options.defaultName || 'Existing road');
        const author = options.author || 'User';
        const geometry = {
            roadPlan: clone(definition),
            roadGeometry: { polygon: clone(definition.polygon) }
        };
        return {
            author,
            title,
            name: title,
            proposalName: title,
            description: options.description || `Road proposal formed from system road segment ${parcelId}`,
            city: options.city || null,
            goal: 'road-track',
            primaryType: 'Road',
            isCorridor: true,
            applied: false,
            createdAt: new Date().toISOString(),
            parentParcelIds: [parcelId],
            definition: clone(definition),
            geometry,
            roadProposal: {
                definition: clone(definition),
                parentParcelIds: [parcelId],
                childParcelIds: [],
                mode: 'adopt-system-road',
                isCorridor: true
            }
        };
    }

    function projectRing(ring, project) {
        return (ring || [])
            .map(pair => {
                const lng = Number(pair?.[0]);
                const lat = Number(pair?.[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                const xy = project(lat, lng);
                return (Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) ? [xy[0], xy[1]] : null;
            })
            .filter(Boolean);
    }

    // The OSM highway types that make up the DRIVEABLE street network — the only ones whose
    // junctions a person would call a junction.
    //
    // This filter is the difference between a usable segmentation and an unusable one. Over the road
    // parcel HR-335649-5584/1, OSM holds 469 ways: 239 footways, 37 paths, 23 steps and 12 cycleways
    // against just 60 actual streets. Every pavement and marked crossing meets the carriageway, so
    // counting them as junctions chopped that parcel into 153 segments with a median length of 24 m
    // — one street arriving in three or four pieces. On the driveable network alone it is 43.
    //
    // An alley breaks a street, so `service=alley` counts. Bare `service` does NOT: in OSM it is
    // overwhelmingly the entrance to a car park or the access road into a block's courtyard, and
    // those arrive every few dozen metres. Over this same parcel there are 76 untagged service ways,
    // 13 driveways, 9 parking aisles and not one tagged alley — counting them broke the connector
    // along Strojarska cesta into 72 m + 16 m + 29 m + 65 m pieces of one obvious street.
    const SEGMENTING_HIGHWAY_TYPES = new Set([
        'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
        'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
        'unclassified', 'residential', 'living_street', 'pedestrian', 'service', 'road'
    ]);
    const SEGMENTING_SERVICE = new Set(['alley']);

    function definesRoadSegments(properties) {
        const type = String(properties?.highway_type || '').trim().toLowerCase();
        if (!SEGMENTING_HIGHWAY_TYPES.has(type)) return false;
        if (type !== 'service') return true;
        const service = String(properties?.tags?.service || '').trim().toLowerCase();
        return SEGMENTING_SERVICE.has(service);
    }

    // Every OSM way over the clicked parcel, as raw lng/lat lines with the properties they arrived
    // with. The driveable ones carry the junction topology the segmentation reads — the parcel
    // polygon alone cannot say where one segment ends and the next begins — and ALL of them, footways
    // included, carry the cross-section: in Zagreb a street's pavements are usually ways of their own,
    // so they are the only evidence that the `sidewalk=separate` on the street means anything.
    async function fetchOsmWays(geometry) {
        const project = global.wgs84ToHTRS96;
        if (typeof project !== 'function' || typeof global.fetch !== 'function') return [];
        const rings = geometryRings(geometry);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        rings.forEach(ring => projectRing(ring, project).forEach(([x, y]) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }));
        if (!Number.isFinite(minX) || !Number.isFinite(maxY)) return [];

        const bbox = [
            minX - OSM_FETCH_MARGIN,
            minY - OSM_FETCH_MARGIN,
            maxX + OSM_FETCH_MARGIN,
            maxY + OSM_FETCH_MARGIN
        ].join(',');
        const base = (typeof global.getBackendBase === 'function' && global.getBackendBase()) || '';
        const url = `${base}/osm-road?bbox=${encodeURIComponent(bbox)}`;
        const data = (typeof global.fetchJsonWithRetry === 'function')
            ? await global.fetchJsonWithRetry(url)
            : await global.fetch(url).then(response => (response.ok ? response.json() : null));

        const ways = [];
        (data?.features || []).forEach(feature => {
            const properties = feature?.properties || {};
            const geom = feature?.geometry;
            const parts = geom?.type === 'LineString'
                ? [geom.coordinates]
                : (geom?.type === 'MultiLineString' ? (geom.coordinates || []) : []);
            parts.forEach(coordinates => {
                if (Array.isArray(coordinates) && coordinates.length >= 2) ways.push({ coordinates, properties });
            });
        });
        return ways;
    }

    // What the highlight outlines: the road parcel's own strip along this run, edge to edge. This is
    // NOT the corridor at the derived width — that is a constant-width band about the centreline, and
    // a real road parcel neither keeps one width nor sits symmetrically about the OSM centreline, so
    // the corridor left the parcel showing beside it. The band follows the two kerb lines instead, so
    // what is highlighted is exactly the road you are pointing at.
    function segmentBandFootprint(runXY, parcelRingsXY, parcelGeometry, precomputedRing = null) {
        try {
            const segmentation = global.RoadSegmentation;
            const unproject = global.htrs96ToWGS84;
            const turf = global.turf;
            if (!segmentation || typeof unproject !== 'function' || !turf) return null;
            const ring = precomputedRing || segmentation.segmentBandRing(runXY, parcelRingsXY);
            if (!ring) return null;

            const coords = ring
                .map(([x, y]) => {
                    const latLng = unproject(x, y);
                    return (Array.isArray(latLng) && Number.isFinite(latLng[0]) && Number.isFinite(latLng[1]))
                        ? [latLng[1], latLng[0]]
                        : null;
                })
                .filter(Boolean);
            if (coords.length < 3) return null;
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first.slice());

            let band = null;
            try { band = turf.polygon([coords]); } catch (_) { return null; }
            if (typeof turf.intersect !== 'function' || typeof turf.featureCollection !== 'function') {
                return band.geometry || null;
            }
            const parcel = { type: 'Feature', properties: {}, geometry: parcelGeometry };
            const trimmed = turf.intersect(turf.featureCollection([band, parcel]));
            return (trimmed && trimmed.geometry) ? trimmed.geometry : (band.geometry || null);
        } catch (error) {
            console.warn('[system-road-adoption] could not build the segment band', error);
            return null;
        }
    }

    // The adopted road's own footprint: the corridor swept along the chosen segment at the derived
    // width, trimmed to the clicked parcel so it can never spill onto land the click did not select.
    function corridorFootprint(centerline, width, parcelGeometry) {
        try {
            const build = global.calculateRoadPolygon;
            const toFeature = global.corridorFeatureFromLatLngRing;
            const turf = global.turf;
            if (typeof build !== 'function' || typeof toFeature !== 'function' || !turf) return null;
            const ring = build(centerline, width);
            const corridor = ring ? toFeature(ring) : null;
            if (!corridor) return null;
            if (typeof turf.intersect !== 'function' || typeof turf.featureCollection !== 'function') {
                return corridor.geometry || null;
            }
            const parcel = { type: 'Feature', properties: {}, geometry: parcelGeometry };
            const trimmed = turf.intersect(turf.featureCollection([corridor, parcel]));
            return (trimmed && trimmed.geometry) ? trimmed.geometry : (corridor.geometry || null);
        } catch (error) {
            console.warn('[system-road-adoption] could not trim the corridor to the parcel', error);
            return null;
        }
    }

    // The projected parcel and its segmented street network, built once per parcel and kept. Hover
    // fires on every pointer move, so it can afford a nearest-segment lookup (pure, microseconds)
    // but never a fetch-and-segment. The click path shares the same index, so the segment the
    // pointer showed is exactly the one the click adopts.
    const segmentIndexes = new Map();
    const segmentIndexBuilds = new Map();

    // Make sure the buildings around this parcel are actually loaded before their footprints are
    // used to bound the road's width. Without this the width depends on whether the user happens to
    // have the Buildings layer switched on — and with it off, an adopted road is measured against
    // the parcel alone and drives through whatever stands inside it.
    async function ensureBuildingsLoadedFor(geometry) {
        try {
            if (typeof global.ensureBuildingFootprintsForBounds !== 'function' || !global.turf?.bbox) return;
            const [west, south, east, north] = global.turf.bbox({ type: 'Feature', properties: {}, geometry });
            await global.ensureBuildingFootprintsForBounds([[south, west], [north, east]]);
        } catch (error) {
            console.warn('[system-road-adoption] could not preload buildings for the width', error);
        }
    }

    // The loaded building footprints that lie near this parcel, as planar rings. Best-effort: if the
    // building layers are not loaded the road simply measures against the parcel alone.
    function buildingRingsNear(geometry, project) {
        try {
            if (typeof global.collectLoadedCorridorBuildings !== 'function' || !global.turf) return [];
            const parcel = { type: 'Feature', properties: {}, geometry };
            const box = global.turf.bbox(parcel);
            const rings = [];
            global.collectLoadedCorridorBuildings().forEach(feature => {
                const geom = feature?.geometry;
                if (!geom) return;
                try {
                    const b = global.turf.bbox(feature);
                    // A cheap bbox reject keeps this to the buildings that could touch the parcel.
                    if (b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) return;
                } catch (_) { return; }
                geometryRings(geom).forEach(ring => {
                    const planar = projectRing(ring, project);
                    if (planar.length >= 3) rings.push(planar);
                });
            });
            return rings;
        } catch (error) {
            console.warn('[system-road-adoption] could not read building footprints for the width', error);
            return [];
        }
    }

    async function buildSegmentIndex(geometry) {
        const project = global.wgs84ToHTRS96;
        if (typeof project !== 'function') return null;
        const parcelRingsXY = geometryRings(geometry)
            .map(ring => projectRing(ring, project))
            .filter(ring => ring.length >= 3);
        let waysXY = [];
        try {
            waysXY = (await fetchOsmWays(geometry))
                .map(way => ({ pointsXY: projectRing(way.coordinates, project), properties: way.properties }))
                .filter(way => way.pointsXY.length >= 2);
        } catch (error) {
            console.warn('[system-road-adoption] existing-road centrelines unavailable', error);
        }
        // Only the driveable ways segment; the rest are kept for the cross-section.
        const osmLinesXY = waysXY.filter(way => definesRoadSegments(way.properties)).map(way => way.pointsXY);
        const segmentation = global.RoadSegmentation;
        const segmentsXY = (segmentation && osmLinesXY.length)
            ? segmentation.segmentRoadNetwork(osmLinesXY)
            : [];
        // Clipping every segment to the parcel is the other half of the per-parcel work, and it is
        // just as pointer-independent — so it is done once here, not on every hover.
        const clipped = (segmentation && segmentsXY.length && parcelRingsXY.length)
            ? segmentation.runsInsideRings(segmentsXY, parcelRingsXY)
            : segmentsXY;
        // Drop the crossing remnants. Where a side street crosses this parcel it leaves a run only
        // as long as the carriageway is wide — a ~15 m stub lying across the road. It is a legitimate
        // piece of centreline but it is not a segment anyone would point at, and highlighting it
        // produces the little rectangle across the street instead of the street. Kept only if the
        // parcel has nothing longer to offer, so a genuinely short road parcel still works.
        const longRuns = clipped.filter(run => segmentation.polylineLength(run) >= MIN_RUN_LENGTH);
        const runsXY = longRuns.length ? longRuns : clipped;
        // Each run's strip of road parcel, also once: it is what the pointer is tested against and
        // what gets outlined, so hover neither measures nor clips anything.
        const bandsXY = (segmentation && runsXY.length && parcelRingsXY.length)
            ? segmentation.segmentBands(runsXY, parcelRingsXY)
            : [];
        // What the adopted road's WIDTH is measured against: the parcel edges AND the buildings.
        // The parcel alone is not enough — a cadastral road parcel frequently overlaps the building
        // footprints beside it, so a road built to the full parcel width drives straight through
        // them and marks them for demolition. Whichever comes first stops the ray.
        await ensureBuildingsLoadedFor(geometry);
        const widthRingsXY = parcelRingsXY.concat(buildingRingsNear(geometry, project));
        return { parcelRingsXY, widthRingsXY, segmentsXY, runsXY, bandsXY, waysXY, geometry };
    }

    function ensureSegmentIndex(parcelId, geometry) {
        const key = String(parcelId);
        if (segmentIndexes.has(key)) return Promise.resolve(segmentIndexes.get(key));
        if (!segmentIndexBuilds.has(key)) {
            const build = buildSegmentIndex(geometry)
                .then(index => {
                    if (index) segmentIndexes.set(key, index);
                    return index;
                })
                .catch(error => {
                    console.warn('[system-road-adoption] could not index this road parcel', error);
                    return null;
                })
                .finally(() => segmentIndexBuilds.delete(key));
            segmentIndexBuilds.set(key, build);
        }
        return segmentIndexBuilds.get(key);
    }

    function cachedSegmentIndex(parcelId) {
        return segmentIndexes.get(String(parcelId)) || null;
    }

    // Last guard on the width: build the actual corridor and check it against the actual buildings,
    // shrinking until it touches none. Ray sampling gets the width almost right, but a corner that
    // pokes in between two stations is invisible to it — and "almost never cuts a building" is not
    // what was asked for. A handful of bisection steps settles it; only the buildings whose bbox
    // meets the corridor are tested, which is a few, not the several hundred that may be loaded.
    function widthClearOfBuildings(centerline, width, parcelGeometry) {
        try {
            const turf = global.turf;
            const build = global.calculateRoadPolygon;
            const toFeature = global.corridorFeatureFromLatLngRing;
            if (!turf || typeof build !== 'function' || typeof toFeature !== 'function') return width;
            if (typeof global.collectLoadedCorridorBuildings !== 'function') return width;

            const corridorAt = w => {
                const ring = build(centerline, w);
                return ring ? toFeature(ring) : null;
            };
            const widest = corridorAt(width);
            if (!widest) return width;

            const box = turf.bbox(widest);
            const near = global.collectLoadedCorridorBuildings().filter(feature => {
                if (!feature?.geometry) return false;
                try {
                    const b = turf.bbox(feature);
                    return !(b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]);
                } catch (_) { return false; }
            });
            if (!near.length) return width;

            const clears = w => {
                const corridor = corridorAt(w);
                if (!corridor) return false;
                return !near.some(feature => {
                    try { return turf.booleanIntersects(corridor, feature); } catch (_) { return false; }
                });
            };
            if (clears(width)) return width;

            let low = MIN_ADOPTED_ROAD_WIDTH;
            let high = width;
            for (let i = 0; i < 7 && high - low > 0.25; i += 1) {
                const mid = (low + high) / 2;
                if (clears(mid)) low = mid; else high = mid;
            }
            return clears(low) ? low : width;
        } catch (error) {
            console.warn('[system-road-adoption] could not verify the width against buildings', error);
            return width;
        }
    }

    // The cross-section the chosen segment already has, read off the OSM ways covering it. Best-effort
    // by design: with no OSM coverage, no translator loaded or anything unexpected, the caller falls
    // back to the purely geometric fit, which knows the metres but not what is in them.
    function reconstructedProfile(runXY, waysXY, width) {
        try {
            const translator = global.OsmProfile;
            if (!translator || !Array.isArray(runXY) || runXY.length < 2 || !Array.isArray(waysXY) || !waysXY.length) return null;
            if (!Number.isFinite(width) || width <= 0) return null;
            return translator.osmProfileForSegment({ runXY, ways: waysXY, availableWidth: width });
        } catch (error) {
            console.warn('[system-road-adoption] could not read the existing cross-section from OSM', error);
            return null;
        }
    }

    // Browser glue around planSegmentAdoption: project the parcel, pull the OSM centrelines over it,
    // and hand back a plan in lat/lng. Never throws — anything unavailable here (no OSM coverage, no
    // network, no projection) only means the adopted road falls back to the parcel's own axis, which
    // is the whole point: clicking an existing road must not fail, however thin the data is.
    async function resolveAdoptionPlan(geometry, clickLngLat, metrics, options = {}) {
        try {
            const project = global.wgs84ToHTRS96;
            const unproject = global.htrs96ToWGS84;
            if (typeof project !== 'function' || typeof unproject !== 'function') return null;

            const index = options.index || await ensureSegmentIndex(options.parcelId ?? 'anonymous', geometry);
            const parcelRingsXY = index?.parcelRingsXY || geometryRings(geometry)
                .map(ring => projectRing(ring, project))
                .filter(ring => ring.length >= 3);
            const segmentsXY = index?.segmentsXY || [];
            const runsXY = index?.runsXY || [];
            const bandsXY = index?.bandsXY || [];
            const widthRingsXY = index?.widthRingsXY || parcelRingsXY;
            const clickXY = (Array.isArray(clickLngLat) && clickLngLat.length === 2)
                ? project(clickLngLat[1], clickLngLat[0])
                : null;

            const resolvedClickXY = (Array.isArray(clickXY) && Number.isFinite(clickXY[0])) ? clickXY : null;
            let plan = planSegmentAdoption({
                parcelRingsXY,
                widthRingsXY,
                segmentsXY,
                runsXY,
                bandsXY,
                clickXY: resolvedClickXY,
                options: { pickRadius: SEGMENT_PICK_RADIUS }
            });

            // Only now, with nothing found in the centrelines, is the parcel-axis analysis worth
            // running — it is slow (it re-skeletonises the whole polygon) and every road-parcel
            // click would otherwise pay for it just to throw the result away.
            if (!plan.centerlineXY) {
                const resolvedMetrics = (typeof metrics === 'function') ? metrics() : metrics;
                const fallback = centerlineFromMetrics(resolvedMetrics, clickLngLat);
                const fallbackCenterlineXY = fallback
                    ? fallback.map(point => project(point.lat, point.lng)).filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]))
                    : null;
                plan = planSegmentAdoption({
                    parcelRingsXY,
                    widthRingsXY,
                    segmentsXY,
                    runsXY,
                    bandsXY,
                    clickXY: resolvedClickXY,
                    fallbackCenterlineXY
                });
                metrics = resolvedMetrics;
            }
            if (!plan.centerlineXY || plan.centerlineXY.length < 2) return null;

            const centerline = plan.centerlineXY
                .map(([x, y]) => {
                    const latLng = unproject(x, y);
                    return (Array.isArray(latLng) && Number.isFinite(latLng[0]) && Number.isFinite(latLng[1]))
                        ? { lat: latLng[0], lng: latLng[1] }
                        : null;
                })
                .filter(Boolean);
            if (centerline.length < 2) return null;

            const measuredWidth = Number.isFinite(plan.width) && plan.width > 0
                ? plan.width
                : measuredRoadWidth((typeof metrics === 'function') ? metrics() : metrics, {});
            const width = clampRoadWidth(widthClearOfBuildings(centerline, measuredWidth, geometry));
            // What the street is already made of. Only now, with the final width known, because the
            // section has to sum to it exactly — and the width is not settled until the buildings
            // have had their say.
            const reconstructed = reconstructedProfile(plan.centerlineXY, index?.waysXY, width);
            return {
                centerline,
                width,
                profile: reconstructed ? reconstructed.profile : null,
                profileSource: reconstructed ? reconstructed.source : null,
                profileNotes: reconstructed ? reconstructed.notes : null,
                streetName: reconstructed ? reconstructed.name : null,
                osmIds: reconstructed ? reconstructed.osmIds : null,
                segmentSource: plan.segmentSource,
                widthSource: plan.widthSource,
                // What the selection outlines: the road parcel's strip along this run, edge to edge,
                // so the highlight covers the road rather than a narrower band inside it.
                band: plan.segmentSource === 'osm-segment'
                    ? segmentBandFootprint(plan.centerlineXY, parcelRingsXY, geometry,
                        Number.isFinite(plan.bandIndex) ? bandsXY[plan.bandIndex] : null)
                    : null,
                // Only a real OSM-derived segment earns a trimmed footprint; the parcel axis is a
                // straight bar through the centroid and its corridor would be a worse polygon than
                // the parcel itself.
                polygon: plan.segmentSource === 'osm-segment'
                    ? corridorFootprint(centerline, width, geometry)
                    : null
            };
        } catch (error) {
            console.warn('[system-road-adoption] falling back to the parcel axis', error);
            return null;
        }
    }

    // ---- segment preview ----------------------------------------------------
    // A cadastral road parcel is not a road: HR-335649-5584/1 is one 24 000 m2 polygon carrying a
    // hundred OSM ways. Selecting it whole says "this entire street network" when the click meant
    // one street. So the click resolves its segment and highlights THAT, and the parcel behind it
    // drops back to its ordinary road style — what you see highlighted is what the button adopts.

    const SEGMENT_PANE = 'systemRoadSegmentPane';
    const SEGMENT_STYLE = { color: '#ff8a1f', weight: 2, opacity: 0.95, fillColor: '#ff8a1f', fillOpacity: 0.35 };
    let segmentLayer = null;
    let cachedPlan = null;   // { parcelId, clickKey, plan } — so adopting re-uses what was shown

    function clickKeyOf(clickLngLat) {
        return Array.isArray(clickLngLat) ? clickLngLat.map(v => Number(v).toFixed(6)).join(',') : '';
    }

    function ensureSegmentPane() {
        const map = global.map;
        if (!map || typeof map.getPane !== 'function') return;
        if (!map.getPane(SEGMENT_PANE) && typeof map.createPane === 'function') {
            const pane = map.createPane(SEGMENT_PANE);
            // Above the parcel fill, below the corridor strips — it reads as a selection, not a road.
            pane.style.zIndex = 616;
        }
    }

    function restoreParcelStyle(parcelId, layer) {
        if (!layer || typeof layer.setStyle !== 'function') return;
        try {
            const styleFn = (typeof global.getParcelStyle === 'function')
                ? global.getParcelStyle
                : global.getParcelBaseStyle;
            if (styleFn) layer.setStyle(styleFn(parcelId, layer, { isRoad: true }));
            else if (global.roadStyle) layer.setStyle(global.roadStyle);
        } catch (_) { }
    }

    function clearSystemRoadSegmentHighlight() {
        const map = global.map;
        if (segmentLayer && map && typeof map.removeLayer === 'function') {
            try { map.removeLayer(segmentLayer); } catch (_) { }
        }
        segmentLayer = null;
        cachedPlan = null;
    }

    function drawSegmentHighlight(geometry) {
        const L = global.L;
        const map = global.map;
        if (!L || !map || !geometry) return false;
        ensureSegmentPane();
        try {
            segmentLayer = L.geoJSON({ type: 'Feature', properties: {}, geometry }, {
                pane: map.getPane && map.getPane(SEGMENT_PANE) ? SEGMENT_PANE : undefined,
                interactive: false,
                style: SEGMENT_STYLE
            }).addTo(map);
            return true;
        } catch (error) {
            console.warn('[system-road-adoption] could not draw the segment highlight', error);
            segmentLayer = null;
            return false;
        }
    }

    const HOVER_STYLE = { color: '#00e5ff', weight: 3, opacity: 0.95, fillColor: '#00e5ff', fillOpacity: 0.18 };
    let hoverLayer = null;
    let hoverKey = '';
    let pendingHover = null;   // where the pointer was when a parcel's index started building

    function removeHoverLayer() {
        const map = global.map;
        if (hoverLayer && map && typeof map.removeLayer === 'function') {
            try { map.removeLayer(hoverLayer); } catch (_) { }
        }
        hoverLayer = null;
        hoverKey = '';
    }

    // Leaving the parcel: drop the outline AND abandon any redraw a pending index build would do,
    // or the outline reappears under a pointer that has gone.
    function clearSystemRoadSegmentHover() {
        removeHoverLayer();
        pendingHover = null;
    }

    // Outline the segment under the pointer instead of the whole cadastral road polygon. Returns
    // true when it is showing one, which is the caller's signal to skip the whole-parcel hover
    // border.
    //
    // A highlight must never outlive the pointer that caused it. Every path that cannot produce a
    // fresh outline clears the old one, because the alternative is worse than showing nothing: the
    // previous street stays lit while the pointer is somewhere else entirely, which reads as the
    // pick being wrong. Moving from one road parcel to the next does exactly that — the new parcel
    // has no index yet, and its build takes a fetch.
    function hoverSystemRoadSegment(parcelId, layer, latlng) {
        const drew = drawHoverForPoint(parcelId, layer, latlng);
        // Only the outline goes; a build kicked off for this very pointer position must survive.
        if (!drew) removeHoverLayer();
        return drew;
    }

    function drawHoverForPoint(parcelId, layer, latlng) {
        const segmentation = global.RoadSegmentation;
        const feature = layer?.feature;
        if (!segmentation || !feature || !parcelId || !latlng) return false;
        if (!canOffer(feature, parcelId, [])) return false;

        const clickLngLat = [Number(latlng.lng), Number(latlng.lat)];
        if (!clickLngLat.every(Number.isFinite)) return false;
        const geometry = clickedRoadGeometry(feature, clickLngLat);
        if (!geometry) return false;

        const index = cachedSegmentIndex(parcelId);
        if (!index) {
            // First hover over this parcel: build the index, then draw for the pointer's position
            // as it stands THEN — without this the outline waits for the next pointer move, which
            // is what made the first hover over a parcel feel dead.
            pendingHover = { parcelId, layer, latlng };
            ensureSegmentIndex(parcelId, geometry).then(built => {
                if (!built || !pendingHover) return;
                if (pendingHover.parcelId !== parcelId) return;
                const { layer: pendingLayer, latlng: pendingLatLng } = pendingHover;
                pendingHover = null;
                hoverSystemRoadSegment(parcelId, pendingLayer, pendingLatLng);
            });
            return false;
        }
        pendingHover = null;
        if (!index.runsXY?.length) return false;

        const project = global.wgs84ToHTRS96;
        if (typeof project !== 'function') return false;
        const pointXY = project(clickLngLat[1], clickLngLat[0]);
        if (!Array.isArray(pointXY) || !Number.isFinite(pointXY[0])) return false;

        // Same pick the click uses, over the same pre-clipped runs — hover and click cannot disagree.
        const picked = segmentation.pickRunAtPoint(index.runsXY, index.bandsXY, pointXY, { pickRadius: SEGMENT_PICK_RADIUS });
        const run = picked ? picked.points : null;
        if (!run) return false;

        // Redrawing the same segment on every pointer move would flicker; the key makes it a no-op.
        const key = `${parcelId}|${run.length}|${run[0][0].toFixed(1)},${run[0][1].toFixed(1)}|${run[run.length - 1][0].toFixed(1)}`;
        if (key === hoverKey && hoverLayer) return true;

        // The band was built with the index; outline that rather than measuring it again.
        let footprint = segmentBandFootprint(run, index.parcelRingsXY, geometry, index.bandsXY?.[picked.index]);
        if (!footprint) {
            // The band could not be measured here; a slightly narrow outline still beats none.
            const unproject = global.htrs96ToWGS84;
            const measured = segmentation.measureAvailableWidth(run, index.parcelRingsXY);
            const centerline = (typeof unproject === 'function')
                ? run.map(([x, y]) => {
                    const latLng = unproject(x, y);
                    return (Array.isArray(latLng) && Number.isFinite(latLng[0])) ? { lat: latLng[0], lng: latLng[1] } : null;
                }).filter(Boolean)
                : [];
            footprint = centerline.length >= 2
                ? corridorFootprint(centerline, clampRoadWidth(measured?.width > 0 ? measured.width : DEFAULT_ROAD_WIDTH), geometry)
                : null;
        }
        if (!footprint) return false;

        clearSystemRoadSegmentHover();
        const L = global.L;
        const map = global.map;
        if (!L || !map) return false;
        ensureSegmentPane();
        try {
            hoverLayer = L.geoJSON({ type: 'Feature', properties: {}, geometry: footprint }, {
                pane: map.getPane && map.getPane(SEGMENT_PANE) ? SEGMENT_PANE : undefined,
                interactive: false,
                style: HOVER_STYLE
            }).addTo(map);
            hoverKey = key;
            // Drop the whole-parcel hover border, or BOTH end up drawn: the first hover over a
            // parcel cannot show a segment yet (its centrelines are still being fetched), so the
            // caller outlines the entire polygon — and when the index lands and this band appears,
            // nothing had been taking that border back down.
            restoreParcelStyle(parcelId, layer);
            return true;
        } catch (error) {
            console.warn('[system-road-adoption] could not draw the segment hover', error);
            hoverLayer = null;
            return false;
        }
    }

    // Resolve and show the segment under the current selection's click. Safe to call for every
    // parcel: it clears any previous highlight and returns immediately for anything that is not an
    // adoptable system road.
    async function previewSelectedSystemRoadSegment() {
        clearSystemRoadSegmentHighlight();
        const selection = global.currentParcel;
        const feature = selection?.layer?.feature;
        const parcelId = selection?.id != null ? String(selection.id) : null;
        if (!feature || !parcelId) return null;

        const proposals = global.proposalStorage?.getProposalsForParcel
            ? global.proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false })
            : [];
        if (!canOffer(feature, parcelId, proposals)) return null;

        const click = selection.clickedLatLng;
        const clickLngLat = click && Number.isFinite(click.lat) && Number.isFinite(click.lng)
            ? [click.lng, click.lat]
            : null;
        const geometry = clickedRoadGeometry(feature, clickLngLat);
        if (!geometry) return null;

        const plan = await resolveAdoptionPlan(geometry, clickLngLat, () => {
            if (typeof global.calculateRoadMetrics !== 'function') return null;
            try { return global.calculateRoadMetrics(geometry.coordinates); } catch (_) { return null; }
        }, { parcelId });

        // The selection may have moved on while the centrelines were being fetched.
        const stillSelected = global.currentParcel
            && String(global.currentParcel.id) === parcelId
            && clickKeyOf(clickLngLat) === clickKeyOf(
                global.currentParcel.clickedLatLng
                    ? [global.currentParcel.clickedLatLng.lng, global.currentParcel.clickedLatLng.lat]
                    : null
            );
        if (!stillSelected) return null;
        if (!plan || plan.segmentSource !== 'osm-segment') return null;
        // Outline the road itself (the parcel strip), falling back to the corridor if the band could
        // not be measured — a highlight that is slightly narrow still beats none at all.
        const outline = plan.band || plan.polygon;
        if (!outline) return null;

        cachedPlan = { parcelId, clickKey: clickKeyOf(clickLngLat), plan };
        if (drawSegmentHighlight(outline)) restoreParcelStyle(parcelId, selection.layer);
        return plan;
    }

    function t(key, fallback) {
        try {
            const translated = global.i18n?.t?.(key);
            if (translated && translated !== key) return translated;
        } catch (_) { }
        return fallback;
    }

    function setBusy(busy) {
        const button = global.document?.getElementById('adopt-system-road-button');
        if (!button) return;
        button.disabled = busy;
        button.textContent = busy
            ? t('panel.parcel.actions.formRoadProposalLoading', 'Forming road proposal…')
            : t('panel.parcel.actions.formRoadProposal', 'Form road proposal and edit profile');
    }

    function notify(message, kind = 'info') {
        if (typeof global.showEphemeralMessage === 'function') {
            global.showEphemeralMessage(message, 6000, kind);
        }
        if (typeof global.updateStatus === 'function') global.updateStatus(message);
    }

    async function adoptSelectedSystemRoad() {
        if (adoptionInFlight) return null;
        const selection = global.currentParcel;
        const feature = selection?.layer?.feature;
        const parcelId = selection?.id != null ? String(selection.id) : null;
        const storage = global.proposalStorage;
        const manager = global.ProposalManager;
        const proposals = parcelId && storage?.getProposalsForParcel
            ? storage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false })
            : [];
        if (!feature || !parcelId || !storage || !manager || !canOffer(feature, parcelId, proposals)) {
            notify(t('panel.parcel.actions.formRoadProposalUnavailable', 'This road segment cannot be formed into a proposal.'), 'error');
            return null;
        }

        adoptionInFlight = true;
        setBusy(true);
        let proposalId = null;
        try {
            const click = selection.clickedLatLng;
            const clickLngLat = click && Number.isFinite(click.lat) && Number.isFinite(click.lng)
                ? [click.lng, click.lat]
                : null;
            const selectedGeometry = clickedRoadGeometry(feature, clickLngLat);
            if (!selectedGeometry) throw new Error('The clicked road has no usable polygon');
            const analysisFeature = { ...feature, geometry: selectedGeometry };
            // The parcel-axis analysis is only the fallback now, and it is the fragile half of this
            // flow (it throws on degenerate rings, and re-skeletonises the whole polygon). Computed
            // on demand, so a failure cannot sink the click and the common path never pays for it.
            let metrics = null;
            const metricsOnce = () => {
                if (metrics !== null) return metrics;
                if (typeof global.calculateRoadMetrics !== 'function') return null;
                try {
                    metrics = global.calculateRoadMetrics(selectedGeometry.coordinates);
                } catch (error) {
                    console.warn('[system-road-adoption] parcel-axis analysis failed', error);
                }
                return metrics;
            };
            // Adopt exactly what the click highlighted, when the highlight is still the live one.
            const reusable = cachedPlan
                && cachedPlan.parcelId === parcelId
                && cachedPlan.clickKey === clickKeyOf(clickLngLat)
                ? cachedPlan.plan
                : null;
            // Pass the parcel id so this reuses the index the hover already built for it, instead of
            // fetching and segmenting the same centrelines again under an anonymous key.
            const plan = reusable || await resolveAdoptionPlan(selectedGeometry, clickLngLat, metricsOnce, { parcelId });
            const author = global.resolveProposalAuthorName?.()
                || global.getCurrentUsername?.()
                || global.getCurrentUserAgent?.()?.name
                || 'User';
            const defaultName = typeof global.generateDefaultProposalName === 'function'
                ? global.generateDefaultProposalName('Road')
                : 'Existing road';
            // Without a usable plan the definition falls back to the parcel axis, which needs the
            // analysis after all — resolve it now rather than handing buildProposal a null.
            const planned = !!(plan && Array.isArray(plan.centerline) && plan.centerline.length >= 2);
            const proposal = buildProposal(analysisFeature, planned ? metrics : metricsOnce(), {
                parcelId,
                clickLngLat,
                author,
                defaultName,
                plan,
                city: global.getProposalCityId?.() || global.getCurrentCityId?.() || null
                // No profileFactory: an adopted street composes its section to FIT the corridor
                // (see corridorProfileForAvailableWidth). Passing corridorProfileFromLegacy here
                // overrode that with the halve-the-width path, which is where the 5.3 m "lanes"
                // came from — a 10.6 m corridor became two lanes of 5.3 m and no footway at all.
            });
            if (!proposal) throw new Error('Could not derive a usable road centreline');

            proposalId = storage.addProposal(proposal);
            if (!proposalId) throw new Error('An equivalent road proposal already exists');
            try { manager._linkProposalToAncestors?.(proposalId, [parcelId]); } catch (_) { }
            const applied = await manager.applyProposal(proposalId, {
                applyAnyway: true,
                suppressMissingParentAlerts: true
            });
            if (!applied) throw new Error('The road proposal could not be applied');

            // The proposal now draws its own corridor; the preview highlight would just sit on top.
            clearSystemRoadSegmentHighlight();
            try { global.hideParcelInfo?.(); } catch (_) { }
            try { global.hideParcelInfoPanel?.(); } catch (_) { }
            if (typeof global.openCorridorProfileEditor === 'function') {
                global.openCorridorProfileEditor(proposalId);
            } else if (typeof global.focusProposalDetails === 'function') {
                await global.focusProposalDetails(proposalId, { centerOnProposal: false });
            }
            notify(t('panel.parcel.actions.formRoadProposalSuccess', 'Road proposal formed. Edit its profile, then apply the changes.'));
            return proposalId;
        } catch (error) {
            console.error('[system-road-adoption] Could not form road proposal', error);
            if (proposalId && typeof storage?.removeProposal === 'function') {
                // applyProposal is transaction-wrapped, but explicitly unapply before removing the
                // record as a belt-and-braces cleanup if a future apply path gains an external side effect.
                try {
                    await manager?.unapplyProposal?.(proposalId, {
                        skipConfirm: true,
                        skipRestoreSource: true
                    });
                } catch (_) { }
                try { storage.removeProposal(proposalId); } catch (_) { }
            }
            notify(t('panel.parcel.actions.formRoadProposalError', 'Could not form a road proposal from this segment.'), 'error');
            return null;
        } finally {
            adoptionInFlight = false;
            setBusy(false);
        }
    }

    return {
        canOffer,
        segmentKeyFor,
        roadProposalSegmentKey,
        clickedRoadGeometry,
        centerlineFromMetrics,
        measuredRoadWidth,
        clampRoadWidth,
        geometryRings,
        planSegmentAdoption,
        corridorFootprint,
        resolveAdoptionPlan,
        previewSelectedSystemRoadSegment,
        clearSystemRoadSegmentHighlight,
        hoverSystemRoadSegment,
        clearSystemRoadSegmentHover,
        definesRoadSegments,
        buildDefinition,
        buildProposal,
        adoptSelectedSystemRoad
    };
});
