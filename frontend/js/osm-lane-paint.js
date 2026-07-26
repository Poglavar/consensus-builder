// Paints the streets that ALREADY exist: for every road parcel in the viewport, the cross-section
// osm-profile.js reconstructs from OSM, drawn as the lanes it describes — pavement, cycle lane,
// parking bay, carriageway — with the lane dashes, bay outlines and direction arrows on top, all
// through corridor-render.js's own renderers. Nothing here is a proposal and nothing is editable; it
// is the city as it stands, drawn by the engine that draws the city as it could be.
//
// A STREET IS PAINTED ONCE. Its lanes do not change when the map moves, so panning back must not
// recompute them: each road parcel's Leaflet groups are kept and simply added to or removed from the
// map as it comes into and out of view, and the OSM fetch only happens when something in view has
// never been painted. Panning over painted ground costs a set membership test per parcel.
//
// AND IT STOPS WHERE A PROPOSAL BEGINS. An adopted street is drawn from its OWN profile by
// corridor-render.js; painting the OSM reconstruction under it would show the street as it was after
// its cross-section had been edited, which is worse than showing nothing. So a run already covered by
// an applied road proposal is skipped, and the paint is dropped and rebuilt whenever proposals change.
//
// THE ONE INDEX, NOT ONE PER PARCEL. system-road-adoption builds its segment index per clicked
// parcel, refetching and re-segmenting that parcel's own bbox each time — fine for one click, hopeless
// for a viewport: over Donji Grad the per-parcel fetches for 60 road parcels came to 5.8 MB where the
// viewport is 1.4 MB for all 135. So this fetches once, segments the whole network once (6 ms for a
// viewport's worth) and only clips per parcel.
(function (global) {
    'use strict';

    const PANE = 'osmLanePaintPane';
    // Below this a lane is thinner than a pixel and the whole viewport would have to be profiled.
    const MIN_ZOOM = 17;
    const REFRESH_DEBOUNCE_MS = 450;
    const FETCH_MARGIN = 80;        // m — the same margin the click path uses, so runs reach past the parcel
    const MIN_RUN_LENGTH = 20;      // m — a crossing remnant is not a street
    // Wider than any street's corridor: past this the ray found a plaza, a car park or a junction
    // mouth, not two kerb lines, and there is nothing honest to draw.
    const PAINT_MAX_WIDTH = 32;
    // Stations that saw both kerbs. Fewer than this and the width is one or two rays' opinion.
    const MIN_MEASURED_STATIONS = 6;
    // How far the drawn centreline may be moved off the OSM one to sit in the middle of its corridor.
    const MAX_CENTRELINE_SHIFT = 8;
    // Narrower than the narrowest thing anyone would call a street. A corridor measuring less than
    // this is a centreline hugging a parcel edge, not a 2 m road, and a 2 m road drawn at map scale
    // is a hairline — which is exactly what "this segment did not render" looks like.
    const MIN_PAINT_WIDTH = 3;
    const SLICE_BUDGET_MS = 12;     // per idle slice, so a frame is never held
    // How many painted parcels to keep. Each is a handful of polygons and polylines held out of the
    // DOM while off screen, so this is JS memory only; ~600 covers a long session of panning around
    // one district without ever repainting.
    const CACHE_LIMIT = 600;
    // How many times a parcel that painted nothing is looked at again. Its inputs (the road-parcel
    // flag, the loaded buildings, a wide enough OSM fetch) arrive late and out of order, so the first
    // answer is not always the true one — but a parcel that is genuinely not a street must stop being
    // asked, or every pan pays for the whole viewport again.
    const EMPTY_RETRIES = 3;

    // The lanes are reference, not proposals: no outline, and translucent enough that the parcel and
    // basemap stay readable underneath. A proposed road is drawn opaque, which is what keeps the two
    // apart at a glance.
    const STRIP_STYLE = { weight: 0, stroke: false, fillOpacity: 0.6 };

    // The paint ON the tarmac — centre lines, lane separators, bay markings, direction arrows — drawn
    // by the same renderers a proposed road uses, so an existing street and a proposed one are marked
    // out identically. Two things are deliberately left out:
    //
    //   * DECORATIONS (street trees, cycle and pedestrian pictograms) are Leaflet divIcons, one DOM
    //     node each, and trees are placed every 6 m. A viewport of streets is thousands of them —
    //     affordable for one road being edited, not for every road in sight.
    //   * BAYS AND ARROWS below MARKING_DETAIL_ZOOM. On one 221 m street they are 76 and 28 separate
    //     paths; over a viewport that is thousands, and at z17 a 5 m parking bay is a few pixels
    //     wide, so the cost buys nothing that can be seen. They live in their own group so the zoom
    //     can add and remove them without the lanes being rebuilt.
    const MARKING_DETAIL_ZOOM = 18;

    let root = null;               // the group actually on the map
    const painted = new Map();     // parcel key -> { base, detail, seen }
    let enabled = false;
    let refreshTimer = null;
    let fetchedKey = '';           // the viewport whose ways have been pulled
    let run = 0;                   // bumped to abandon a paint in flight
    let seenCounter = 0;

    function map() { return global.map; }

    function ensurePane() {
        const m = map();
        if (!m || typeof m.getPane !== 'function') return null;
        let pane = m.getPane(PANE);
        if (!pane && typeof m.createPane === 'function') {
            pane = m.createPane(PANE);
            // Above the parcel fill, below the centreline reference layer (615) and the corridor
            // strips of actual proposals (630) — existing streets sit behind anything proposed.
            pane.style.zIndex = 610;
        }
        return pane;
    }

    function ensureRoot() {
        const m = map();
        if (!m || !global.L) return null;
        ensurePane();
        if (!root) root = global.L.layerGroup();
        if (typeof m.hasLayer === 'function' && !m.hasLayer(root)) root.addTo(m);
        return root;
    }

    // Throw the whole paint away: the streets themselves have not changed, but what may be drawn over
    // them has. Cheaper to repaint a viewport (~90 ms) than to work out which parcels a proposal touched.
    function dropCache() {
        painted.forEach(entry => {
            if (root && typeof root.removeLayer === 'function') {
                root.removeLayer(entry.base);
                if (entry.detail) root.removeLayer(entry.detail);
            }
        });
        painted.clear();
        fetchedKey = '';
    }

    function clearLayer() {
        const m = map();
        dropCache();
        if (root && m && typeof m.hasLayer === 'function' && m.hasLayer(root)) m.removeLayer(root);
        root = null;
    }

    function bboxKey() {
        const m = map();
        if (!m || typeof m.getBounds !== 'function') return '';
        return (typeof global.getBboxFromBounds === 'function') ? global.getBboxFromBounds(m.getBounds()) : '';
    }

    // Every OSM way over the viewport, with its properties: the driveable ones carry the topology the
    // segmentation reads, the footways carry the evidence for Zagreb's separately mapped pavements.
    async function fetchWays(bboxHTRS) {
        const base = (typeof global.getBackendBase === 'function' && global.getBackendBase()) || '';
        const url = `${base}/osm-road${bboxHTRS ? `?bbox=${encodeURIComponent(bboxHTRS)}` : ''}`;
        const data = (typeof global.fetchJsonWithRetry === 'function')
            ? await global.fetchJsonWithRetry(url)
            : await global.fetch(url).then(response => (response.ok ? response.json() : null));

        const project = global.wgs84ToHTRS96;
        const ways = [];
        (data?.features || []).forEach(feature => {
            const properties = feature?.properties || {};
            const geom = feature?.geometry;
            const parts = geom?.type === 'LineString'
                ? [geom.coordinates]
                : (geom?.type === 'MultiLineString' ? (geom.coordinates || []) : []);
            parts.forEach(coordinates => {
                const pointsXY = (coordinates || [])
                    .map(([lng, lat]) => project(lat, lng))
                    .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
                if (pointsXY.length >= 2) ways.push({ pointsXY, properties });
            });
        });
        return ways;
    }

    function ringsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return (geometry.coordinates || []).slice(0, 1);
        if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).map(poly => poly[0]).filter(Boolean);
        return [];
    }

    // The road parcels currently drawn, as planar rings. They are already in memory — the map drew
    // them — so this costs a walk of the layer group and a projection, never a fetch.
    function roadParcelsInView() {
        const parcels = [];
        const project = global.wgs84ToHTRS96;
        const bounds = map()?.getBounds?.();
        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function' || typeof project !== 'function') {
            return parcels;
        }
        global.parcelLayer.eachLayer(layerEntry => {
            try {
                const feature = layerEntry?.feature;
                if (!feature?.geometry) return;
                const properties = feature.properties || {};
                const parcelId = properties.parcelId || properties.id || properties.parcel_id;
                const isRoad = properties.isRoad === true || properties.isRoad === 'true'
                    || (parcelId && typeof global.isRoadParcel === 'function' && global.isRoadParcel(parcelId));
                if (!isRoad) return;
                if (bounds && typeof layerEntry.getBounds === 'function' && !bounds.intersects(layerEntry.getBounds())) return;
                const rings = ringsOf(feature.geometry).map(ring => ring
                    .map(([lng, lat]) => project(lat, lng))
                    .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]))).filter(ring => ring.length >= 3);
                if (!rings.length) return;
                // A parcel with no id still has to be cacheable, or it repaints on every pan; its
                // bounding box is stable and unique enough to key it by.
                const key = String(parcelId || `box:${boxOf(rings).map(n => n.toFixed(1)).join(',')}`);
                parcels.push({ id: key, rings, geometry: feature.geometry });
            } catch (_) { /* one unreadable parcel must not stop the paint */ }
        });
        return parcels;
    }

    // The buildings already loaded, as planar rings — a street's width is bounded by them as well as
    // by its parcel, exactly as it is when the road is adopted, so the painted lanes and the adopted
    // ones agree.
    function buildingRings(project) {
        const rings = [];
        try {
            if (typeof global.collectLoadedCorridorBuildings !== 'function') return rings;
            global.collectLoadedCorridorBuildings({ surveys: { gdi: true } }).forEach(feature => {
                ringsOf(feature?.geometry).forEach(ring => {
                    const planar = ring
                        .map(([lng, lat]) => project(lat, lng))
                        .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]));
                    if (planar.length >= 3) rings.push(planar);
                });
            });
        } catch (_) { }
        return rings;
    }

    // Every applied road proposal's centreline, planar, with the half-width it is drawn at. This is
    // what the paint must not duplicate: those stretches are already on the map, from their own
    // (possibly edited) cross-section.
    function proposedCorridors(project) {
        const corridors = [];
        try {
            if (typeof global.proposalStorage?.getAllProposals !== 'function') return corridors;
            if (typeof global.isAppliedCorridorProposal !== 'function') return corridors;
            global.proposalStorage.getAllProposals()
                .filter(proposal => global.isAppliedCorridorProposal(proposal))
                .forEach(proposal => {
                    const definition = (typeof global.corridorProposalDefinition === 'function')
                        ? global.corridorProposalDefinition(proposal)
                        : null;
                    if (!definition) return;
                    const entries = (typeof global.corridorRenderEntries === 'function')
                        ? global.corridorRenderEntries(proposal, definition)
                        : [{ points: (typeof global.corridorCenterlineOf === 'function') ? global.corridorCenterlineOf(definition) : [] }];
                    entries.forEach(entry => {
                        const points = (entry?.points || [])
                            .map(point => project(point.lat, point.lng))
                            .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]));
                        if (points.length < 2) return;
                        const width = (entry?.profile && typeof global.corridorProfileWidth === 'function')
                            ? global.corridorProfileWidth(entry.profile)
                            : Number(definition.width);
                        corridors.push({ points, half: (Number(width) > 0 ? Number(width) : 10) / 2 });
                    });
                });
        } catch (error) {
            console.warn('[osmLanePaint] could not read the proposed corridors', error);
        }
        return corridors;
    }

    // ---------------------------------------------------------------------------
    // Pure geometry
    // ---------------------------------------------------------------------------

    function boxOf(rings) {
        let box = [Infinity, Infinity, -Infinity, -Infinity];
        rings.forEach(ring => ring.forEach(([x, y]) => {
            box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
        }));
        return box;
    }

    // Pure: which of `rings` could touch `box`, by bounding box. Without this every parcel is measured
    // against every building in the viewport, which is what turned a 90 ms paint into 770 ms.
    function ringsNear(rings, boxes, box, pad = 5) {
        const near = [];
        for (let i = 0; i < rings.length; i += 1) {
            const b = boxes[i];
            if (box[0] > b[2] + pad || box[2] < b[0] - pad || box[1] > b[3] + pad || box[3] < b[1] - pad) continue;
            near.push(rings[i]);
        }
        return near;
    }

    function distanceToPolyline(px, py, line) {
        let best = Infinity;
        for (let i = 1; i < line.length; i += 1) {
            const [ax, ay] = line[i - 1];
            const [bx, by] = line[i];
            const dx = bx - ax;
            const dy = by - ay;
            const lengthSq = dx * dx + dy * dy;
            let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
            t = Math.max(0, Math.min(1, t));
            best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
        }
        return best;
    }

    // Pure: is this run already drawn as a road proposal? Tested by PROXIMITY rather than by matching
    // segment keys, because a re-segmented run's endpoints move with the fetched bbox while the ground
    // it covers does not — a key match would miss the very case this exists for. A run counts as
    // covered when most of it lies inside some proposal's own corridor.
    function runIsUnderProposal(runXY, corridors, options = {}) {
        if (!Array.isArray(runXY) || runXY.length < 2 || !Array.isArray(corridors) || !corridors.length) return false;
        const pad = Number.isFinite(options.pad) ? Number(options.pad) : 2;
        const share = Number.isFinite(options.share) ? Number(options.share) : 0.7;
        let inside = 0;
        runXY.forEach(([x, y]) => {
            if (corridors.some(corridor => distanceToPolyline(x, y, corridor.points) <= corridor.half + pad)) inside += 1;
        });
        return inside / runXY.length >= share;
    }

    // Pure: the corridor a measurement describes — how wide it is, and how far the centreline has to
    // move to sit in the middle of it. A cadastral road parcel is frequently one side of the street
    // rather than the whole of it, so the two sides are taken separately and the difference becomes a
    // shift rather than being thrown away by a symmetric width.
    //
    // Falls back to the symmetric fit when a side could not be measured — better a narrow street than
    // one placed on a guess.
    function corridorFromSides(measured) {
        const left = Number(measured?.leftWidth);
        const right = Number(measured?.rightWidth);
        if (Number.isFinite(left) && left > 0 && Number.isFinite(right) && right > 0) {
            // Clamped: past this the measurement is not telling us where the street is, it is telling
            // us there is a lot of open ground on one side, and moving the street that far off the
            // line OSM drew would be a guess dressed as a measurement.
            const shift = Math.max(-MAX_CENTRELINE_SHIFT, Math.min(MAX_CENTRELINE_SHIFT, (left - right) / 2));
            return { width: left + right, shift };
        }
        const fit = Number.isFinite(measured?.fitWidth) && measured.fitWidth > 0
            ? measured.fitWidth
            : Number(measured?.width);
        return { width: Number.isFinite(fit) ? fit : 0, shift: 0 };
    }

    // Move a planar centreline sideways. Positive is left of travel, matching corridorStripSpans,
    // which seeds its cursor at +total/2 for the left edge.
    function shiftCenterline(pointsXY, metres) {
        if (!(Math.abs(metres) > 0.05) || typeof global.offsetPolylinePlanar !== 'function') return pointsXY;
        try {
            const moved = global.offsetPolylinePlanar(pointsXY, metres);
            return (Array.isArray(moved) && moved.length >= 2) ? moved : pointsXY;
        } catch (_) {
            return pointsXY;
        }
    }

    // ---------------------------------------------------------------------------
    // Painting
    // ---------------------------------------------------------------------------

    // One road parcel's painted lanes: its runs, each measured against the parcel and the buildings,
    // profiled from OSM, and turned into strip polygons. Returns [] rather than throwing — a parcel
    // that cannot be read is simply not painted.
    //
    // `markings` collects (centreline, profile) for every run that produced strips, so the caller can
    // hand them to the marking renderers without re-deriving anything.
    function lanesForParcel(parcel, context, markings = []) {
        const out = [];
        try {
            const segmentation = global.RoadSegmentation;
            const translator = global.OsmProfile;
            const unproject = global.htrs96ToWGS84;
            if (!segmentation || !translator || typeof unproject !== 'function') return out;

            const runs = segmentation.runsInsideRings(context.segments, parcel.rings)
                .filter(piece => segmentation.polylineLength(piece) >= MIN_RUN_LENGTH);
            if (!runs.length) return out;

            const box = boxOf(parcel.rings);
            const widthRings = parcel.rings.concat(ringsNear(context.buildings, context.buildingBoxes, box));
            runs.forEach(originalPiece => {
                let piece = originalPiece;
                // Already a proposal: its own cross-section is drawn over this ground by
                // corridor-render.js, and that one is the truth after an edit.
                if (runIsUnderProposal(originalPiece, context.corridors)) return;
                // Every other street NEAR this one bounds it — taken from the whole network, not from
                // this parcel's own runs: a street's neighbours are usually in other parcels, and at
                // a junction they always are.
                const neighbours = segmentation.neighbourSegments(originalPiece, context.segments);
                const measured = segmentation.measureAvailableWidth(piece, widthRings, { neighbours });
                // The corridor as it really lies, not as a band centred on the OSM line. A centreline
                // is very often off-centre in its cadastral parcel — 21 m of room one side and 4 m the
                // other along Strojarska cesta — and a symmetric width collapses to twice the narrow
                // side, drawing a hairline that reads as "this segment did not render". So the two
                // sides are taken separately and the LINE is moved to the middle of what was measured;
                // everything after this (strips, dashes, bays, arrows) then follows for free.
                const corridor = corridorFromSides(measured);
                const width = corridor.width;
                if (!(width > 0)) return;
                piece = corridor.shift ? shiftCenterline(piece, corridor.shift) : piece;
                // A measurement worth drawing. Painting is not adoption: adopting is a deliberate act
                // on one street the user is pointing at, and it may fall back on a rough number, but
                // a reference layer that guesses is worse than one that leaves a gap. So a run that
                // could not be measured over enough of its length, or that comes out wider than any
                // street is — the 26 m junction stub across Vukovarska measured 52 m — is left alone.
                if (!(measured.sampleCount >= MIN_MEASURED_STATIONS)) return;
                // preferNominal: the street is as wide as OSM says it is, and the corridor is only a
                // ceiling. Painting an existing street is not adopting one — nothing here has to sum
                // to a footprint — so the ground beside it stays the ground beside it.
                const reconstructed = translator.osmProfileForSegment({
                    runXY: piece, ways: context.ways, availableWidth: width, options: { preferNominal: true }
                });
                if (!reconstructed?.profile) return;
                // Checked on the STREET, not on the corridor: a street drawn at the width OSM gives
                // it may sit in a very wide corridor quite legitimately (a boulevard's carriageway
                // beside its tram median), and rejecting that would leave half a street unpainted.
                // What must never be drawn is a street wider than streets are.
                if (reconstructed.width > PAINT_MAX_WIDTH || reconstructed.width < MIN_PAINT_WIDTH) return;
                const centerline = piece
                    .map(([x, y]) => {
                        const latLng = unproject(x, y);
                        return (Array.isArray(latLng) && Number.isFinite(latLng[0])) ? { lat: latLng[0], lng: latLng[1] } : null;
                    })
                    .filter(Boolean);
                if (centerline.length < 2) return;
                const strips = global.buildCorridorStrips([centerline], reconstructed.profile) || [];
                strips.forEach(strip => strip.polygons.forEach(polygon => out.push({
                    polygon,
                    type: strip.type,
                    surface: global.corridorStripSurface(strip),
                    name: reconstructed.name
                })));
                if (strips.length) markings.push({ centerline, profile: reconstructed.profile });
            });
        } catch (error) {
            console.warn('[osmLanePaint] could not paint a parcel', error);
        }
        return out;
    }

    // Build (never add) the two groups for one parcel: the lanes and their dashes, and separately the
    // detail that only appears zoomed in. Split so a zoom change adds or removes a group instead of
    // repainting the street.
    function buildParcelGroups(parcel, context) {
        const marks = [];
        const lanes = lanesForParcel(parcel, context, marks);
        if (!lanes.length) return null;

        const base = global.L.layerGroup();
        lanes.forEach(lane => global.L.polygon(lane.polygon, {
            ...STRIP_STYLE, pane: PANE, fillColor: lane.surface, interactive: false
        }).addTo(base));

        const detail = global.L.layerGroup();
        marks.forEach(({ centerline, profile }) => {
            try {
                if (typeof global.renderCorridorLaneMarkings === 'function'
                    && typeof global.buildCorridorLaneMarkings === 'function') {
                    global.renderCorridorLaneMarkings(global.buildCorridorLaneMarkings([centerline], profile), base, PANE);
                }
                if (typeof global.renderCorridorParkingBays === 'function'
                    && typeof global.buildCorridorParkingBays === 'function') {
                    global.renderCorridorParkingBays(global.buildCorridorParkingBays([centerline], profile), detail, PANE);
                }
                if (typeof global.renderCorridorDirectionArrows === 'function'
                    && typeof global.buildCorridorDirectionArrows === 'function') {
                    global.renderCorridorDirectionArrows(global.buildCorridorDirectionArrows([centerline], profile), detail, PANE);
                }
            } catch (error) {
                console.warn('[osmLanePaint] could not mark out a street', error);
            }
        });
        return { base, detail, seen: 0 };
    }

    // Add what is in view, take away what is not. Cheap enough to run on every pan — it is a Map
    // lookup and at most an addLayer per parcel, with nothing recomputed.
    function showInView(parcels) {
        if (!ensureRoot()) return;
        const detailed = (map()?.getZoom?.() ?? 0) >= MARKING_DETAIL_ZOOM;
        const visible = new Set(parcels.map(parcel => parcel.id));
        painted.forEach((entry, key) => {
            const wanted = visible.has(key);
            if (wanted) entry.seen = ++seenCounter;
            const hasBase = root.hasLayer(entry.base);
            if (wanted && !hasBase) root.addLayer(entry.base);
            if (!wanted && hasBase) root.removeLayer(entry.base);
            const wantDetail = wanted && detailed && entry.detail;
            const hasDetail = entry.detail && root.hasLayer(entry.detail);
            if (wantDetail && !hasDetail) root.addLayer(entry.detail);
            if (!wantDetail && hasDetail) root.removeLayer(entry.detail);
        });
        evict();
    }

    // Least-recently-in-view first; only entries currently off the map are eligible, so nothing that
    // is being looked at is ever dropped.
    function evict() {
        if (painted.size <= CACHE_LIMIT) return;
        [...painted.entries()]
            .filter(([, entry]) => !root.hasLayer(entry.base))
            .sort((a, b) => a[1].seen - b[1].seen)
            .slice(0, painted.size - CACHE_LIMIT)
            .forEach(([key]) => painted.delete(key));
    }

    // Paint in idle slices, checking the run token between parcels: a pan mid-paint abandons the rest
    // rather than finishing a picture of somewhere the user has already left.
    function paintParcels(pending, context, token) {
        const slice = (deadline) => {
            if (token !== run || !enabled) return;
            const started = (global.performance && performance.now()) || Date.now();
            const remaining = () => (deadline && typeof deadline.timeRemaining === 'function')
                ? deadline.timeRemaining()
                : SLICE_BUDGET_MS - (((global.performance && performance.now()) || Date.now()) - started);
            const done = [];
            while (pending.length && remaining() > 1) {
                const parcel = pending.shift();
                const groups = buildParcelGroups(parcel, context);
                if (groups) {
                    painted.set(parcel.id, groups);
                } else {
                    // Nothing painted. Cached so it is not re-examined on every pan, but NOT for
                    // good: the inputs it failed on arrive late and out of order — the parcel may
                    // have been read before road detection flagged it, before its buildings loaded,
                    // or from a viewport whose fetch did not reach far enough to segment it. A
                    // permanent negative is how a street ends up never painted while clicking it
                    // works perfectly, since the click path builds its own index from scratch.
                    const misses = (painted.get(parcel.id)?.misses || 0) + 1;
                    painted.set(parcel.id, {
                        base: global.L.layerGroup(), detail: null, seen: 0, misses, empty: true
                    });
                }
                done.push(parcel);
            }
            if (done.length) showInView(roadParcelsInView());
            if (pending.length) schedule(slice);
        };
        schedule(slice);
    }

    function schedule(fn) {
        if (typeof global.requestIdleCallback === 'function') global.requestIdleCallback(fn, { timeout: 500 });
        else setTimeout(() => fn(null), 0);
    }

    async function refresh(force = false) {
        if (!enabled) return;
        const m = map();
        if (!m) return;
        if (typeof m.getZoom === 'function' && m.getZoom() < MIN_ZOOM) {
            // Out of range: hide what is drawn, but KEEP it — zooming back in must not repaint.
            if (root && typeof root.clearLayers === 'function') {
                painted.forEach(entry => {
                    root.removeLayer(entry.base);
                    if (entry.detail) root.removeLayer(entry.detail);
                });
            }
            return;
        }
        if (force) dropCache();

        const token = ++run;
        try {
            const project = global.wgs84ToHTRS96;
            const segmentation = global.RoadSegmentation;
            if (typeof project !== 'function' || !segmentation) return;

            const parcels = roadParcelsInView();
            if (!parcels.length) return;   // parcels still loading; the next move tries again

            // Everything in view has been looked at already: show it and stop. No fetch, no
            // segmentation, no measurement — this is the whole point of the cache and the common case
            // when panning.
            //
            // A parcel that produced nothing is retried, but ONLY when something never seen before is
            // being painted anyway. Its inputs arrive late, so the first answer is not always the true
            // one; but retrying on every pan would spend a fetch on ground the user is only crossing.
            // Panning into new streets is exactly when the retry is free.
            const fresh = parcels.filter(parcel => !painted.has(parcel.id));
            showInView(parcels);
            if (!fresh.length) return;
            const retry = parcels.filter(parcel => {
                const entry = painted.get(parcel.id);
                return entry && entry.empty && entry.misses < EMPTY_RETRIES;
            });
            const pending = fresh.concat(retry);

            // Reach past the viewport so a run is segmented against the junctions just off-screen.
            const key = bboxKey();
            const grown = growBbox(key, FETCH_MARGIN);
            const ways = await fetchWays(grown || key);
            if (token !== run || !enabled) return;
            fetchedKey = key;

            // ONE segmentation for the whole viewport. Only the driveable network defines where a
            // segment ends; the rest of the ways are kept because the cross-section reads them.
            const defines = global.SystemRoadAdoption?.definesRoadSegments;
            const lines = ways
                .filter(way => (typeof defines === 'function' ? defines(way.properties) : true))
                .map(way => way.pointsXY);
            const segments = segmentation.segmentRoadNetwork(lines);

            const buildings = buildingRings(project);
            const context = {
                ways, segments, buildings,
                buildingBoxes: buildings.map(ring => boxOf([ring])),
                corridors: proposedCorridors(project)
            };
            paintParcels(pending, context, token);
        } catch (error) {
            console.warn('[osmLanePaint] could not paint the viewport', error);
        }
    }

    // Pure: grow a "minX,minY,maxX,maxY" planar bbox string by `margin` metres. Returns null when the
    // string is not one, so the caller falls back to the ungrown key rather than fetching nonsense.
    function growBbox(bbox, margin) {
        const parts = String(bbox || '').split(',').map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;
        return [parts[0] - margin, parts[1] - margin, parts[2] + margin, parts[3] + margin].join(',');
    }

    function scheduleRefresh() {
        if (!enabled) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, REFRESH_DEBOUNCE_MS);
    }

    function enable() {
        if (enabled) return;
        enabled = true;
        const m = map();
        if (m && typeof m.on === 'function') m.on('moveend zoomend', scheduleRefresh);
        refresh(true);
    }

    function disable() {
        enabled = false;
        run += 1;
        const m = map();
        if (m && typeof m.off === 'function') m.off('moveend zoomend', scheduleRefresh);
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        clearLayer();
    }

    // Wired to the sidebar checkbox (#showOsmLanePaint); flips state when called without one.
    function toggleOsmLanePaint() {
        const box = (typeof document !== 'undefined') ? document.getElementById('showOsmLanePaint') : null;
        const on = box ? box.checked : !enabled;
        if (on) enable(); else disable();
    }

    // Called from ProposalManager._refreshUIAfterProposalChange: a road has been applied, edited or
    // unapplied, so which stretches belong to a proposal has changed. Repaint from scratch — the
    // streets are the same, but where the paint must stop is not.
    function refreshOsmLanePaintForProposals() {
        if (!enabled) return;
        refresh(true);
    }

    global.toggleOsmLanePaint = toggleOsmLanePaint;
    global.refreshOsmLanePaint = () => refresh(true);
    global.refreshOsmLanePaintForProposals = refreshOsmLanePaintForProposals;

    // `lanesForParcel` is exported alongside the pure helpers because it IS the layer: everything
    // above it is scheduling and everything below is rendering. Given stubbed collaborators it runs
    // in node, so what the layer paints can be checked without a map.
    const api = {
        growBbox, ringsNear, boxOf, ringsOf, runIsUnderProposal, corridorFromSides, lanesForParcel,
        MIN_ZOOM, MARKING_DETAIL_ZOOM, CACHE_LIMIT, PAINT_MAX_WIDTH, MIN_PAINT_WIDTH
    };
    global.OsmLanePaint = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
