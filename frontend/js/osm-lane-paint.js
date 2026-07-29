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
// THE WAYS OUTLIVE THE PAINT. The paint is thrown away whenever a proposal changes, because where it
// has to stop has moved — but the OSM ways it was built from cannot have changed, so they are cached
// per fetched area and survive it. A repaint of ground already fetched costs nothing on the wire.
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
    // How far a measuring ray travels — measureAvailableWidth's own cap. Anything within this of a
    // segment can stop one, so it is also how far the obstacle search has to look.
    const MEASURE_REACH = 60;
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
    // How many fetched areas to remember. Panning back into any of them needs no fetch at all; past
    // this the oldest is forgotten and its ground would be fetched again (the streets themselves stay
    // painted either way, since they are keyed by run).
    const PROCESSED_MEMORY = 40;
    // How many viewports' worth of OSM ways to keep. Small — this is megabytes, and its job is to make
    // a REPAINT of ground already fetched (which is what every proposal change causes) free, not to be
    // a second cache of the city.
    const WAY_CACHE_LIMIT = 6;
    // How many segment verdicts to keep. A verdict is a cheap record and it is what the readout reads,
    // but a SKIPPED segment has no layers of its own, so it is not covered by the layer cache below:
    // without its own ceiling the register of everything ever looked at grows for as long as the map
    // is panned.
    const EXPLAINED_LIMIT = 3000;
    // A segment's endpoints depend on which junctions happened to be included in the fetched
    // viewport, but its OSM edges do not. Keep paint ownership at that stable, smaller unit so a
    // 287 m chain from one viewport and the 111 m child chain from the next cannot both paint the
    // same stretch. A decimetre absorbs projection noise without conflating parallel centrelines.
    const SEGMENT_EDGE_PRECISION = 0.1;

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
    //   * ARROWS AND SLEEPERS below MARKING_DETAIL_ZOOM. Both are repeated symbols — an arrow every
    //     few metres, a sleeper every 0.6 m — that say nothing a closer look does not, and 28 arrows
    //     on one 221 m street is thousands over a viewport. They live in their own group so the zoom
    //     can add and remove them without the lanes being rebuilt.
    //
    // BAY MARKINGS AND RAILS are not detail and are drawn with the lanes. They are the only thing
    // distinguishing a parking lane from the carriageway and a tram track from a wide pavement, so
    // holding them back to a closer zoom hid exactly the distinction they exist to make. Both are a
    // handful of batched canvas paths per street (see renderCorridorParkingBays), not one per symbol.
    const MARKING_DETAIL_ZOOM = 18;

    let root = null;               // the group actually on the map
    const painted = new Map();     // run key -> { base, detail, seen, box, name, width }
    const paintedEdgeOwners = new Map(); // stable source-edge key -> the one painted run that owns it
    // What was decided about every street looked at, painted or not — the map's own explanation of
    // itself, read by the hover readout. Runs are cheap records; the drawn layers live in `painted`.
    const explained = new Map();   // run key -> { name, reason, box, points, width, length }
    // What `explained` holds, as a list — rebuilt only when it changes, because the readout asks for it
    // on every pointer move and rebuilding it there allocated the whole register per mouse event.
    let explainedList = null;
    let enabled = false;
    let refreshTimer = null;
    const processed = [];          // planar boxes whose streets have all been looked at
    const wayCache = new Map();    // fetched bbox -> { ways, truncated }; outlives the paint
    const parkingCache = new Map();// fetched bbox -> separately mapped street-side parking polygons
    let run = 0;                   // bumped to abandon a paint in flight
    let seenCounter = 0;

    // The one place `explained` is written, so the list beside it cannot go stale.
    function remember(key, record) {
        explained.set(key, record);
        explainedList = null;
    }

    function forget(key) {
        explained.delete(key);
        explainedList = null;
    }

    function explainedRecords() {
        if (!explainedList) explainedList = [...explained.values()];
        return explainedList;
    }

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
        paintedEdgeOwners.clear();
        explained.clear();
        explainedList = null;
        processed.length = 0;
    }

    function clearLayer() {
        const m = map();
        dropCache();
        wayCache.clear();
        parkingCache.clear();
        if (root && m && typeof m.hasLayer === 'function' && m.hasLayer(root)) m.removeLayer(root);
        root = null;
    }

    function bboxKey() {
        const m = map();
        if (!m || typeof m.getBounds !== 'function') return '';
        return (typeof global.getBboxFromBounds === 'function') ? global.getBboxFromBounds(m.getBounds()) : '';
    }

    // Every OSM way over the viewport, with its properties: the driveable ones carry the topology the
    // segmentation reads, the footways carry the evidence for Zagreb's separately mapped pavements, and
    // `rail=1` adds the tramways, which have no highway class and would otherwise be missing from every
    // boulevard that has one.
    //
    // Kept per area, and NOT thrown away with the paint. The paint is dropped whenever a proposal
    // changes, because where it must stop has moved; the ways it was built from cannot have changed at
    // all, and refetching a megabyte and a half of them to redraw the same streets is pure waste.
    async function fetchWays(bboxHTRS) {
        const cached = wayCache.get(bboxHTRS || '');
        if (cached) return cached;

        const base = (typeof global.getBackendBase === 'function' && global.getBackendBase()) || '';
        const url = `${base}/osm-road?rail=1${bboxHTRS ? `&bbox=${encodeURIComponent(bboxHTRS)}` : ''}`;
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
        // The endpoint answers with at most 8000 ways and says so when it had more. Carried through,
        // because a way that fell off the end is indistinguishable from a way OSM does not have: the
        // streets it described would be reported as having no OSM way at all, which is a lie about
        // the map data rather than about our own limit.
        const answer = { ways, truncated: !!data?.truncated, limit: Number(data?.limit) || null };
        if (answer.truncated) {
            console.warn(`[osmLanePaint] /osm-road returned its maximum of ${answer.limit || 'N'} ways;`
                + ' some streets here will be missing their section');
        }
        // A failed request is not an answer, and caching one would make the failure permanent: the
        // cache outlives the forced refresh that used to be the way to retry.
        if (data) {
            wayCache.set(bboxHTRS || '', answer);
            if (wayCache.size > WAY_CACHE_LIMIT) wayCache.delete(wayCache.keys().next().value);
        }
        return answer;
    }

    // The road table is queried in planar HTRS96; the separately maintained parking table is indexed
    // in WGS84. Convert all four corners rather than assuming the projection is axis-aligned.
    function wgsBboxForHtrs(bboxHTRS, unproject = global.htrs96ToWGS84) {
        const parts = String(bboxHTRS || '').split(',').map(Number);
        if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))
            || typeof unproject !== 'function') return null;
        const [minX, minY, maxX, maxY] = parts;
        const corners = [
            unproject(minX, minY), unproject(minX, maxY),
            unproject(maxX, minY), unproject(maxX, maxY)
        ].filter(value => Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1]));
        if (corners.length !== 4) return null;
        const lats = corners.map(value => value[0]);
        const lngs = corners.map(value => value[1]);
        return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)].join(',');
    }

    // The road network is deliberately fetched beyond the screen so junctions just outside it can
    // terminate a segment. Width measurement needs the SAME ground: otherwise a complete 69 m road
    // can arrive from /osm-road while only the two stations inside the visible parcel cells have
    // cadastral boundaries to measure against.
    function leafletBoundsForHtrs(bboxHTRS, unproject = global.htrs96ToWGS84, leaflet = global.L) {
        const bbox = wgsBboxForHtrs(bboxHTRS, unproject);
        const [west, south, east, north] = String(bbox || '').split(',').map(Number);
        if (![west, south, east, north].every(Number.isFinite)
            || typeof leaflet?.latLngBounds !== 'function') return null;
        try {
            return leaflet.latLngBounds([[south, west], [north, east]]);
        } catch (_) {
            return null;
        }
    }

    // Project separately mapped parking AREAS once. The painter below turns each outer ring into a
    // longitudinal interval and lateral bounds in the frame of the nearest road.
    function parkingPolygonsFromGeoJSON(collection, project = global.wgs84ToHTRS96) {
        if (typeof project !== 'function') return [];
        const polygons = [];
        (collection?.features || []).forEach((feature, featureIndex) => {
            const geometry = feature?.geometry;
            const outerRings = geometry?.type === 'Polygon'
                ? [geometry.coordinates?.[0]]
                : (geometry?.type === 'MultiPolygon'
                    ? (geometry.coordinates || []).map(part => part?.[0])
                    : []);
            outerRings.forEach((coordinates, partIndex) => {
                const ring = (coordinates || [])
                    .map(point => {
                        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
                        return project(point[1], point[0]);
                    })
                    .filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
                if (ring.length < 3) return;
                const properties = feature.properties || {};
                polygons.push({
                    id: String(feature.id || properties.osm_id || `parking-${featureIndex}`) + `:${partIndex}`,
                    ring,
                    box: boxOf([ring]),
                    orientation: properties.orientation || null,
                    properties
                });
            });
        });
        return polygons;
    }

    async function fetchParkingPolygons(bboxHTRS) {
        const key = bboxHTRS || '';
        if (parkingCache.has(key)) return parkingCache.get(key);
        const bbox = wgsBboxForHtrs(bboxHTRS);
        if (!bbox) return [];
        const base = (typeof global.getBackendBase === 'function' && global.getBackendBase()) || '';
        const url = `${base}/osm-parking?bbox=${encodeURIComponent(bbox)}`;
        try {
            const data = (typeof global.fetchJsonWithRetry === 'function')
                ? await global.fetchJsonWithRetry(url)
                : await global.fetch(url).then(response => (response.ok ? response.json() : null));
            if (!data) return [];
            const polygons = parkingPolygonsFromGeoJSON(data);
            parkingCache.set(key, polygons);
            if (parkingCache.size > WAY_CACHE_LIMIT) parkingCache.delete(parkingCache.keys().next().value);
            return polygons;
        } catch (error) {
            // Parking is enrichment of the road profile. A failed DB request must not make the
            // existing lanes disappear, and a failed answer is deliberately not cached.
            console.warn('[osmLanePaint] could not fetch locally stored parking', error);
            return [];
        }
    }

    // Whether a way is one of the driveable classes a segment can belong to — the same question
    // system-road-adoption asks when deciding what defines a segment at all.
    function isDriveable(way) {
        const defines = global.SystemRoadAdoption?.definesRoadSegments;
        return typeof defines === 'function' ? !!defines(way.properties) : true;
    }

    // The segments already taken by a road proposal, by the key both this layer and the adoption path
    // use. Exact where the geometry survived unchanged; runIsUnderProposal still covers the rest.
    function adoptedSegmentKeys() {
        const keys = new Set();
        try {
            if (typeof global.proposalStorage?.getAllProposals !== 'function') return keys;
            global.proposalStorage.getAllProposals().forEach(proposal => {
                const key = global.SystemRoadAdoption?.roadProposalSegmentKey?.(proposal);
                if (key) keys.add(key);
            });
        } catch (_) { }
        return keys;
    }

    function ringsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return (geometry.coordinates || []).slice(0, 1);
        if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).map(poly => poly[0]).filter(Boolean);
        return [];
    }

    // Every parcel currently drawn, split into road land and everything else, as planar rings. They
    // are already in memory — the map drew them — so this costs a walk of the layer group and a
    // projection, never a fetch.
    //
    // The non-road ones matter as much as the road ones: they are the OTHER SIDE of the kerb. A
    // street's corridor ends where somebody's plot begins, and that boundary is drawn in the cadastre
    // whether or not a building was ever surveyed on it — so it is a far more dependable edge than a
    // building footprint, which may be set back from the line, missing, or not yet loaded.
    function parcelsInView(boundsOverride = null) {
        const road = [];
        const other = [];
        const project = global.wgs84ToHTRS96;
        const bounds = boundsOverride || map()?.getBounds?.();
        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function' || typeof project !== 'function') {
            return { road, other };
        }
        global.parcelLayer.eachLayer(layerEntry => {
            try {
                const feature = layerEntry?.feature;
                if (!feature?.geometry) return;
                const properties = feature.properties || {};
                const parcelId = properties.parcelId || properties.id || properties.parcel_id;
                const isRoad = properties.isRoad === true || properties.isRoad === 'true'
                    || (parcelId && typeof global.isRoadParcel === 'function' && global.isRoadParcel(parcelId));
                if (bounds && typeof layerEntry.getBounds === 'function' && !bounds.intersects(layerEntry.getBounds())) return;
                const rings = ringsOf(feature.geometry).map(ring => ring
                    .map(([lng, lat]) => project(lat, lng))
                    .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]))).filter(ring => ring.length >= 3);
                if (!rings.length) return;
                // A parcel with no id still has to be cacheable, or it repaints on every pan; its
                // bounding box is stable and unique enough to key it by.
                const key = String(parcelId || `box:${boxOf(rings).map(n => n.toFixed(1)).join(',')}`);
                (isRoad ? road : other).push({ id: key, rings, geometry: feature.geometry });
            } catch (_) { /* one unreadable parcel must not stop the paint */ }
        });
        return { road, other };
    }

    // ROAD LAND, dissolved. Every road parcel in view merged into one surface, so the seams BETWEEN
    // adjacent road parcels stop being walls.
    //
    // A segment crosses as many parcels as the land register happens to have drawn, and its rays stop
    // at the nearest boundary — so measuring against the parcels separately made every internal seam
    // a kerb: a 290 m stretch of Ulica grada Vukovara measured 5 m wide. A street's corridor ends
    // where ROAD LAND ends, not where one parcel becomes the next. Holes are kept: a traffic island
    // inside the road surface really does stop a ray.
    //
    // Falls back to the undissolved rings when turf is unavailable or refuses the geometry — narrower
    // measurements, but never a crash.
    function dissolveRoadLand(parcels) {
        const rings = parcels.flatMap(parcel => parcel.rings);
        const turf = global.turf;
        if (!turf?.union || !turf?.featureCollection || !turf?.polygon || rings.length < 2) return rings;
        try {
            const closed = ring => {
                const out = ring.map(([x, y]) => [x, y]);
                const [ax, ay] = out[0];
                const [bx, by] = out[out.length - 1];
                if (ax !== bx || ay !== by) out.push([ax, ay]);
                return out;
            };
            const polygons = [];
            rings.forEach(ring => {
                try { polygons.push(turf.polygon([closed(ring)])); } catch (_) { }
            });
            if (polygons.length < 2) return rings;
            const merged = turf.union(turf.featureCollection(polygons));
            const geometry = merged?.geometry;
            if (!geometry) return rings;
            const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const dissolved = parts.flatMap(part => part).filter(ring => Array.isArray(ring) && ring.length >= 3);
            return dissolved.length ? dissolved : rings;
        } catch (error) {
            console.warn('[osmLanePaint] could not dissolve the road parcels', error);
            return rings;
        }
    }

    // Make sure the buildings around this viewport are actually loaded before their footprints are
    // used to bound a street's width — the same thing system-road-adoption does before it measures.
    //
    // It matters more here than it looks. Once the road parcels are dissolved into one surface, the
    // internal boundaries that used to stop a ray are gone by design, so on a street whose road land
    // opens into a square the nearest road-land edge can be past the 60 m ray cap. The buildings are
    // then the only thing left to measure against, and a layer that merely used whatever the map
    // happened to have fetched would drop those streets with "no kerb line found on both sides" —
    // which is to say, it would paint differently depending on whether the Buildings layer was on.
    async function ensureBuildingsLoaded(boundsOverride = null) {
        try {
            const m = map();
            if (typeof global.ensureBuildingFootprintsForBounds !== 'function'
                || (!boundsOverride && !m?.getBounds)) return;
            const bounds = boundsOverride || m.getBounds();
            await global.ensureBuildingFootprintsForBounds(bounds);
        } catch (error) {
            console.warn('[osmLanePaint] could not preload the buildings', error);
        }
    }

    // The buildings already loaded, as planar rings — a street's width is bounded by them as well as
    // by the road land, exactly as it is when the road is adopted, so the painted lanes and the
    // adopted ones agree.
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
        if (!Array.isArray(rings) || !Array.isArray(boxes)) return near;
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

    // Stable ownership below a segment. A viewport can see a through road without the side street
    // that splits it, then see that junction after a pan; the first segmentation contains one long
    // chain and the second contains two shorter ones. Endpoint keys call those different segments,
    // even though they contain the same source edges.
    function segmentEdgeKeys(points, precision = SEGMENT_EDGE_PRECISION) {
        if (!Array.isArray(points) || points.length < 2) return [];
        const scale = 1 / (Number(precision) > 0 ? Number(precision) : SEGMENT_EDGE_PRECISION);
        const pointKey = point => {
            if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
            return `${Math.round(point[0] * scale)},${Math.round(point[1] * scale)}`;
        };
        const keys = [];
        for (let i = 1; i < points.length; i += 1) {
            const a = pointKey(points[i - 1]);
            const b = pointKey(points[i]);
            if (!a || !b || a === b) continue;
            keys.push(a < b ? `${a}|${b}` : `${b}|${a}`);
        }
        return [...new Set(keys)];
    }

    // Return only the contiguous parts whose source edges do not already have a paint owner. This is
    // deliberately a split, not an all-or-nothing reject: if a newly fetched 287 m chain contains an
    // already-painted 111 m child, the other 176 m still has to appear as the map pans into it.
    function unownedSegmentRuns(segment, owners, unproject) {
        const points = segment?.points;
        if (!Array.isArray(points) || points.length < 2) return [];
        const has = key => !!owners && typeof owners.has === 'function' && owners.has(key);
        const scale = 1 / SEGMENT_EDGE_PRECISION;
        const pointKey = point => `${Math.round(point[0] * scale)},${Math.round(point[1] * scale)}`;
        const edgeKeyAt = index => {
            const a = pointKey(points[index]);
            const b = pointKey(points[index + 1]);
            return a < b ? `${a}|${b}` : `${b}|${a}`;
        };
        const runs = [];
        let runPoints = [];
        let edgeKeys = [];
        const flush = () => {
            if (runPoints.length >= 2 && edgeKeys.length) {
                const key = segmentKey(runPoints, unproject);
                if (key) {
                    runs.push({
                        ...segment,
                        key,
                        points: runPoints,
                        box: boxOf([runPoints]),
                        edgeKeys: [...new Set(edgeKeys)]
                    });
                }
            }
            runPoints = [];
            edgeKeys = [];
        };

        for (let i = 0; i < points.length - 1; i += 1) {
            const key = edgeKeyAt(i);
            if (has(key)) {
                flush();
                continue;
            }
            if (!runPoints.length) runPoints.push(points[i]);
            runPoints.push(points[i + 1]);
            edgeKeys.push(key);
        }
        flush();
        return runs;
    }

    // A fetch is authoritative for a cached segment only when its grown bbox contains that whole
    // segment: every way meeting any node inside that box necessarily intersects the query too. If
    // the current graph groups those source edges differently, the cached grouping came from an
    // earlier incomplete viewport and must give way. Equal edge sets are the same segment regardless
    // of direction or endpoint rounding; parallel roads share no keys and remain independent.
    function supersededSegmentKeys(currentSegments, records, authoritativeBox) {
        if (!Array.isArray(currentSegments) || !Array.isArray(records)
            || !Array.isArray(authoritativeBox) || authoritativeBox.length !== 4) return [];
        const current = currentSegments.map(segment => {
            const keys = segment.edgeKeys || segmentEdgeKeys(segment.points);
            return { keys, set: new Set(keys) };
        }).filter(segment => segment.keys.length);
        if (!current.length) return [];
        const sameEdges = (a, b) => a.size === b.size && [...a].every(key => b.has(key));
        const old = records.map(record => {
            const oldKeys = record.edgeKeys || segmentEdgeKeys(record.points);
            return { record, keys: oldKeys, set: new Set(oldKeys) };
        }).filter(entry => entry.record?.key && entry.keys.length);
        const stale = new Set();

        current.forEach(segment => {
            const overlapping = old.filter(entry => entry.keys.some(key => segment.set.has(key)));
            if (!overlapping.length) return;
            // Replacing only half of an old grouping recreates the same seam: the new combined run is
            // immediately split around the still-owned half. Wait until the fetch contains every old
            // owner participating in this current segment, then replace the group atomically.
            if (overlapping.some(entry => !Array.isArray(entry.record.box)
                || !contains(authoritativeBox, entry.record.box))) return;
            overlapping.forEach(entry => {
                if (!sameEdges(entry.set, segment.set)) stale.add(entry.record.key);
            });
        });
        return [...stale];
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
            // The two sides are kept as well as their sum: the translator sizes anything mapped beside
            // the street against the room on THAT side.
            return { width: left + right, shift, left, right };
        }
        const fit = Number.isFinite(measured?.fitWidth) && measured.fitWidth > 0
            ? measured.fitWidth
            : Number(measured?.width);
        const width = Number.isFinite(fit) ? fit : 0;
        return { width, shift: 0, left: width / 2, right: width / 2 };
    }

    // The ring between a segment's two kerb lines, from the room measured on each side — the segment
    // as an AREA rather than a line. Null when there is no offsetter to hand or the measurement gave
    // no sides, in which case the translator falls back to its fixed reach.
    function segmentPolygon(pointsXY, measured) {
        const left = Number(measured?.leftWidth);
        const right = Number(measured?.rightWidth);
        if (!(left > 0) || !(right > 0) || typeof global.corridorStripRingPlanar !== 'function') return null;
        try {
            const ring = global.corridorStripRingPlanar(pointsXY, left, -right);
            return (Array.isArray(ring) && ring.length >= 3) ? ring : null;
        } catch (_) {
            return null;
        }
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
    // 1. STREETS, 2. SEGMENTS, 3. PAINTING
    //
    // The bookkeeping is per SEGMENT, and a segment belongs to a street. Neither of those is a parcel:
    // a cadastral road parcel is an accident of the land register — Ulica grada Vukovara's is 3.8 km
    // long and holds a dozen streets, while an ordinary street crosses several parcels — so organising
    // the work by parcel meant the register could answer "done" for a boulevard after one screenful of
    // it had been drawn. The parcel is now only ONE INPUT: the thing a segment's width is measured
    // against. What is remembered, shown and explained is the segment.
    // ---------------------------------------------------------------------------

    // 1. STREETS. One entry per named road over this viewport, so every segment can say which street
    // it is part of. A street mapped as a dozen ways is one street; an unnamed way is its own.
    function streetOf(segmentXY, ways, settings = {}) {
        const reach = Number(settings.reach) > 0 ? Number(settings.reach) : 6;
        const box = boxOf([segmentXY]);
        let best = null;
        ways.forEach(way => {
            if (!way.driveable || !Array.isArray(way.pointsXY) || way.pointsXY.length < 2) return;
            if (!boxesOverlap(box, way.box, reach)) return;
            let on = 0;
            segmentXY.forEach(point => {
                if (distanceToPolyline(point[0], point[1], way.pointsXY) <= reach) on += 1;
            });
            const covered = on / segmentXY.length;
            if (covered < 0.5) return;
            if (!best || covered > best.covered) {
                best = { covered, name: way.properties?.name || null, osmId: way.properties?.osm_id };
            }
        });
        if (!best) return { id: null, name: null };
        return { id: best.name ? `name:${best.name}` : `way:${best.osmId}`, name: best.name };
    }

    // 2. SEGMENTS. The network cut at its junctions and corners — the unit of every decision this
    // layer makes. Each carries the street it belongs to, the road parcel it lies in (whose kerb lines
    // are what its width is measured against), and its identity, which is the SAME key a road proposal
    // records when it adopts one. A segment therefore has one name across painting and editing alike.
    function segmentsInView(context, parcels) {
        const segmentation = global.RoadSegmentation;
        if (!segmentation) return [];
        const boxed = parcels.map(parcel => ({ parcel, box: boxOf(parcel.rings) }));
        // Tolerate raw ways: the refresh precomputes these, a caller reaching in directly may not.
        const ways = (context.ways || []).map(way => (way.box && 'driveable' in way)
            ? way
            : { ...way, box: boxOf([way.pointsXY || []]), driveable: isDriveable(way) });
        return (context.segments || [])
            .filter(points => Array.isArray(points) && points.length >= 2
                && segmentation.polylineLength(points) >= MIN_RUN_LENGTH)
            .map(points => {
                const box = boxOf([points]);
                // ALL the road parcels this segment runs through, not one. A street routinely crosses
                // several — cadastral boundaries fall wherever the land register put them, not where
                // a street begins or ends — and measuring one segment against a single parcel stops
                // its rays at an internal boundary as if the street ended there.
                const parcels = boxed
                    .filter(entry => boxesOverlap(box, entry.box)
                        && points.some(point => segmentation.pointInRings(point, entry.parcel.rings)))
                    .map(entry => entry.parcel);
                return {
                    key: segmentKey(points, context.unproject),
                    points, box, parcels,
                    street: streetOf(points, ways),
                    // A segment lying in no road parcel at all is not this layer's business.
                    parcel: parcels[0] || null
                };
            })
            .filter(segment => segment.key && segment.parcels.length);
    }

    // A segment's identity, shared with system-road-adoption: the two ends in lng/lat, so the segment
    // this layer paints and the segment a proposal adopts are the same named thing. Falls back to the
    // planar ends when there is no projection to hand, which only happens in tests.
    function segmentKey(pointsXY, unproject) {
        const ends = [pointsXY[0], pointsXY[pointsXY.length - 1]];
        const at = ([x, y]) => {
            if (typeof unproject === 'function') {
                const latLng = unproject(x, y);
                if (Array.isArray(latLng) && Number.isFinite(latLng[0])) {
                    return `${latLng[1].toFixed(5)},${latLng[0].toFixed(5)}`;
                }
            }
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        };
        const first = at(ends[0]);
        const last = at(ends[1]);
        if (!first || !last) return null;
        return first < last ? `${first}|${last}` : `${last}|${first}`;
    }

    let edgeGeometryModule = null;
    function edgeGeometryFunction(name, supplied) {
        if (typeof supplied === 'function') return supplied;
        if (typeof global[name] === 'function') return global[name];
        if (typeof require === 'function') {
            try {
                if (!edgeGeometryModule) edgeGeometryModule = require('./corridor-edge-fill.js');
                if (typeof edgeGeometryModule?.[name] === 'function') return edgeGeometryModule[name];
            } catch (_) { }
        }
        return null;
    }

    function polylineLength(pointsXY) {
        let length = 0;
        for (let i = 1; i < (pointsXY || []).length; i += 1) {
            length += Math.hypot(
                pointsXY[i][0] - pointsXY[i - 1][0],
                pointsXY[i][1] - pointsXY[i - 1][1]
            );
        }
        return length;
    }

    function parkingTypeForOrientation(value) {
        const orientation = String(value || '').toLowerCase();
        if (orientation === 'perpendicular') return 'parking_perpendicular';
        if (orientation === 'diagonal' || orientation === 'angled') return 'parking_angled';
        return 'parking';
    }

    // Normalize one mapped parking polygon into the road topology's frame:
    //
    //   polygon -> nearest road -> left/right side -> [start, end] chainage + lateral bounds
    //
    // This does NOT split the road segment. It gives one lane/use an interval along that segment,
    // which is the representation needed later for loading zones, bus bays and turn pockets too.
    function parkingSpansForSegment(runXY, parkingPolygons, roadSegments = [], options = {}) {
        if (!Array.isArray(runXY) || runXY.length < 2 || !Array.isArray(parkingPolygons)) return [];
        const projectPoint = edgeGeometryFunction('projectPointOntoPolyline', options.projectPointOntoPolyline);
        if (typeof projectPoint !== 'function') return [];
        const maxDistance = Number.isFinite(options.maxDistance) ? Number(options.maxDistance) : 20;
        const nearestTolerance = Number.isFinite(options.nearestTolerance)
            ? Number(options.nearestTolerance) : 0.35;
        const minLength = Number.isFinite(options.minLength) ? Number(options.minLength) : 3;
        const minWidth = Number.isFinite(options.minWidth) ? Number(options.minWidth) : 0.8;
        const maxWidth = Number.isFinite(options.maxWidth) ? Number(options.maxWidth) : 8;
        const total = polylineLength(runXY);
        const candidates = (roadSegments || [])
            .filter(line => Array.isArray(line) && line.length >= 2);
        if (!candidates.length) candidates.push(runXY);

        return parkingPolygons.flatMap(area => {
            const ring = area?.ring;
            if (!Array.isArray(ring) || ring.length < 3) return [];
            // Do not count a repeated closing vertex twice.
            const vertices = ring.length > 3
                && ring[0][0] === ring[ring.length - 1][0]
                && ring[0][1] === ring[ring.length - 1][1]
                ? ring.slice(0, -1)
                : ring;
            const centroid = vertices.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
                .map(value => value / vertices.length);
            const onRun = projectPoint(runXY, centroid);
            if (!onRun || onRun.distance > maxDistance || Math.abs(onRun.signed) < 0.25) return [];

            // A polygon near a junction is seen by more than one segment. Exactly the nearest one
            // owns it; tolerance only absorbs the tiny numeric difference between a cached sub-run
            // and the same source geometry in the current viewport.
            const nearestDistance = Math.min(...candidates.map(line => {
                const projected = projectPoint(line, centroid);
                return projected ? projected.distance : Infinity;
            }));
            if (onRun.distance > nearestDistance + nearestTolerance) return [];

            const projections = vertices.map(point => projectPoint(runXY, point)).filter(Boolean);
            if (projections.length < 3) return [];
            const sign = onRun.signed > 0 ? 1 : -1;
            const sameSide = projections.map(value => value.signed)
                .filter(offset => offset * sign > 0.25);
            if (sameSide.length < 2) return [];
            const sMin = Math.max(0, Math.min(...projections.map(value => value.chainage)));
            const sMax = Math.min(total, Math.max(...projections.map(value => value.chainage)));
            const left = Math.max(...sameSide);
            const right = Math.min(...sameSide);
            const width = left - right;
            if (sMax - sMin < minLength || width < minWidth || width > maxWidth) return [];

            const type = parkingTypeForOrientation(area.orientation || area.properties?.orientation);
            return [{
                id: area.id,
                side: sign > 0 ? 'left' : 'right',
                sMin, sMax, left, right, width, type,
                orientation: type === 'parking_perpendicular'
                    ? 'perpendicular' : (type === 'parking_angled' ? 'angled' : 'parallel')
            }];
        });
    }

    // ---------------------------------------------------------------------------
    // 3. Painting
    // ---------------------------------------------------------------------------

    // 3. PAINTING. What this layer decided about ONE segment: its lanes, its centreline and section
    // (for the markings), and — painted or not — WHY, so a segment missing from the map can say so.
    // Never throws: a segment that cannot be read is simply not painted.
    function paintSegment(segment, context) {
        const record = fields => ({
            key: segment.key, points: segment.points, box: segment.box,
            edgeKeys: segment.edgeKeys || segmentEdgeKeys(segment.points),
            streetId: segment.street?.id || null,
            name: segment.street?.name || null,
            parcelId: segment.parcel?.id || null,
            length: (global.RoadSegmentation?.polylineLength(segment.points)) || 0,
            state: 'skipped', reason: null, width: null, lanes: [], markings: null,
            partialParking: [],
            ...fields
        });
        try {
            const segmentation = global.RoadSegmentation;
            const translator = global.OsmProfile;
            const unproject = global.htrs96ToWGS84;
            if (!segmentation || !translator || typeof unproject !== 'function') {
                return record({ reason: 'the map is not ready' });
            }

            // Already adopted: its own cross-section is drawn over this ground by corridor-render.js,
            // and after an edit that one is the truth.
            if (context.adopted?.has(segment.key) || runIsUnderProposal(segment.points, context.corridors)) {
                return record({ state: 'adopted', reason: 'adopted as a road proposal' });
            }

            // What a street's corridor actually ends at, in order of how dependable it is:
            //   * the far side of the kerb — the neighbouring parcels that are NOT road land;
            //   * road land's own outer edge, dissolved so its internal seams are not kerbs;
            //   * the buildings, for where the cadastre leaves a gap.
            //
            // The reach is the RAY'S reach. These bounding-box rejects exist only to keep the work
            // linear, so anything a ray could possibly hit has to survive them — and a ray goes
            // MEASURE_REACH metres. Rejecting at the segment's own box plus a couple of metres threw
            // away every kerb line beside a straight street, whose box is a sliver: 212 m of Ulica
            // grada Vukovara came back "measured at only 1 stations", because at all but one of its
            // ~53 stations there was nothing left on one side to stop the ray.
            const land = context.roadLandRings
                ? ringsNear(context.roadLandRings, context.roadLandBoxes, segment.box, MEASURE_REACH)
                : segment.parcels.flatMap(parcel => parcel.rings);
            const widthRings = ringsNear(context.otherRings, context.otherBoxes, segment.box, MEASURE_REACH)
                .concat(land)
                .concat(ringsNear(context.buildings, context.buildingBoxes, segment.box, MEASURE_REACH));
            if (!widthRings.length) return record({ reason: 'nothing around it to measure against' });
            // Every other street NEAR this one bounds it — from the whole network, not from one
            // parcel's share of it: a street's neighbours are usually in other parcels, and at a
            // junction they always are.
            const neighbours = segmentation.neighbourSegments(segment.points, context.segments);
            const measured = segmentation.measureAvailableWidth(segment.points, widthRings, { neighbours });
            // The corridor as it really lies, not as a band centred on the OSM line: a centreline is
            // often off-centre in its parcel, and a symmetric width then collapses to twice the narrow
            // side — hairlines that read as "this segment did not render".
            const corridor = corridorFromSides(measured);
            if (!(corridor.width > 0)) return record({ reason: 'no kerb line found on both sides' });
            if (!(measured.sampleCount >= MIN_MEASURED_STATIONS)) {
                return record({ reason: `measured at only ${measured.sampleCount} stations` });
            }

            // Read the tags off the line OSM DREW, and draw on the line the corridor puts it on. The
            // shift can be metres, and the ways are matched within 4 m of the run — so reading the
            // shifted line loses the very way the section is meant to come from, and a well-mapped
            // 285 m stretch of boulevard reports "no OSM way describes this segment".
            //
            // preferNominal: the street is as wide as OSM says it is and the corridor is only a
            // ceiling. Painting is not adopting — nothing here has to sum to a footprint — so the
            // ground beside a street stays the ground beside it.
            // The segment's own polygon: the corridor between the kerb lines just measured. Every OSM
            // way inside it describes this segment — which is the right question, and one a fixed
            // reach cannot answer, since the right reach IS this width.
            const polygonXY = segmentPolygon(segment.points, measured);
            const reconstructed = translator.osmProfileForSegment({
                runXY: segment.points, ways: context.ways, availableWidth: corridor.width,
                options: {
                    preferNominal: true,
                    polygonXY,
                    // The room on each side, separately. A pavement mapped as its own way is measured
                    // against the kerb on ITS side; against half the total it comes out the same width
                    // on both sides of a corridor that is 6 m one way and 14 m the other.
                    leftHalf: corridor.left,
                    rightHalf: corridor.right,
                    // Where the section will actually be drawn, so a tram track is placed against
                    // the line it will be drawn on rather than the line it was measured from.
                    sectionShift: corridor.shift
                }
            });
            if (!reconstructed?.profile) {
                // Only ONE of these two is about the street. Reporting the other as "OSM has nothing
                // here" would send somebody to fix tagging that is perfectly fine.
                return record({
                    reason: context.truncated
                        ? 'no OSM way describes this segment — but the way fetch was truncated here, so one may be missing'
                        : 'no OSM way describes this segment'
                });
            }
            // The cap is on the ROAD. It exists to throw out a corridor that is not a street at all —
            // a plaza, a car park, a junction mouth — and a tram reservation is none of those: it was
            // read off OSM's own geometry rather than guessed from a ray, and it is genuinely part of
            // the street. So the rails buy their own width, and Savska keeps its lanes instead of
            // being dropped for being 33 m wide with a tramway down it.
            const railWidth = reconstructed.profile.strips
                .filter(strip => strip.type === 'rail')
                .reduce((total, strip) => total + (Number(strip.width) || 0), 0);
            if (reconstructed.width > PAINT_MAX_WIDTH + railWidth || reconstructed.width < MIN_PAINT_WIDTH) {
                return record({ reason: `${reconstructed.width.toFixed(1)} m is not a street's width` });
            }

            const points = corridor.shift ? shiftCenterline(segment.points, corridor.shift) : segment.points;
            const centerline = points
                .map(([x, y]) => {
                    const latLng = unproject(x, y);
                    return (Array.isArray(latLng) && Number.isFinite(latLng[0])) ? { lat: latLng[0], lng: latLng[1] } : null;
                })
                .filter(Boolean);
            if (centerline.length < 2) return record({ reason: 'could not be projected' });
            const strips = global.buildCorridorStrips([centerline], reconstructed.profile) || [];
            if (!strips.length) return record({ reason: 'no strips could be built' });

            // `parking:*=separate` is intentionally absent from the segment-wide profile: the OSM
            // polygons carry the missing longitudinal truth. Clip those areas into road-frame spans,
            // then build their surface on the shifted centerline that the rest of this street uses.
            const profileParkingSides = new Set(
                (typeof global.corridorStripSpans === 'function'
                    ? global.corridorStripSpans(reconstructed.profile) : [])
                    .filter(span => typeof global.corridorParkingOrientation === 'function'
                        && global.corridorParkingOrientation(span.type))
                    .map(span => ((span.left + span.right) / 2 >= 0 ? 'left' : 'right'))
            );
            const slicePolyline = edgeGeometryFunction('corridorEdgeFillSlicePolyline');
            const partialParking = (typeof slicePolyline === 'function'
                && typeof global.corridorStripRingPlanar === 'function')
                ? parkingSpansForSegment(segment.points, context.parkingPolygons || [], context.segments || [])
                    .filter(span => !profileParkingSides.has(span.side))
                    .flatMap(span => {
                        // The span offsets were measured from the OSM line. Everything is rendered
                        // from the measured corridor's shifted line, so express them in that frame
                        // and keep them inside the measured road surface.
                        const left = Math.min(corridor.width / 2, span.left - corridor.shift);
                        const right = Math.max(-corridor.width / 2, span.right - corridor.shift);
                        if (left - right < 0.8) return [];
                        const slicedXY = slicePolyline(points, span.sMin, span.sMax);
                        if (!slicedXY) return [];
                        const ring = global.corridorStripRingPlanar(slicedXY, left, right);
                        if (!Array.isArray(ring) || ring.length < 3) return [];
                        const asLatLng = point => {
                            const value = unproject(point[0], point[1]);
                            return Array.isArray(value) && Number.isFinite(value[0])
                                ? { lat: value[0], lng: value[1] } : null;
                        };
                        const polygon = ring.map(asLatLng).filter(Boolean);
                        const slicedCenterline = slicedXY.map(asLatLng).filter(Boolean);
                        if (polygon.length < 3 || slicedCenterline.length < 2) return [];
                        const direction = typeof global.corridorParkingFlowDirection === 'function'
                            ? global.corridorParkingFlowDirection(reconstructed.profile, { left, right })
                            : ((left + right) / 2 >= 0 ? 'backward' : 'forward');
                        return [{
                            ...span, left, right, width: left - right,
                            polygon, centerline: slicedCenterline, direction,
                            surface: global.corridorStripSurface({ type: span.type })
                        }];
                    })
                : [];

            return record({
                state: 'painted',
                parcelIds: segment.parcels.map(parcel => parcel.id),
                name: segment.street?.name || reconstructed.name || null,
                width: reconstructed.width,
                markings: { centerline, profile: reconstructed.profile },
                partialParking,
                lanes: strips.flatMap(strip => strip.polygons.map(polygon => ({
                    polygon, type: strip.type, surface: global.corridorStripSurface(strip)
                })))
            });
        } catch (error) {
            console.warn('[osmLanePaint] could not paint a segment', error);
            return record({ reason: 'threw while being read' });
        }
    }

    // Every segment of one parcel, painted — the parcel-shaped view of the three steps above, kept
    // because a parcel is still how the width of a segment gets measured and how the tests reach in.
    function segmentsInParcel(parcel, context) {
        return segmentsInView(context, [parcel]).map(segment => paintSegment(segment, context));
    }

    // ...and the flat list of lane polygons, for callers that only want the shapes.
    function lanesForParcel(parcel, context, markings = []) {
        const painted = segmentsInParcel(parcel, context);
        painted.forEach(segment => { if (segment.markings) markings.push(segment.markings); });
        return painted.flatMap(segment => segment.lanes.map(lane => ({ ...lane, name: segment.name })));
    }

    // Build (never add) the two groups for ONE street: the lanes and their dashes, and separately the
    // detail that only appears zoomed in. Split so a zoom change adds or removes a group instead of
    // repainting the street.
    function buildSegmentGroups(street) {
        if (!street.lanes.length) return null;

        const base = global.L.layerGroup();
        street.lanes.forEach(lane => global.L.polygon(lane.polygon, {
            ...STRIP_STYLE, pane: PANE, fillColor: lane.surface, interactive: false
        }).addTo(base));
        (street.partialParking || []).forEach(span => global.L.polygon(span.polygon, {
            ...STRIP_STYLE, pane: PANE, fillColor: span.surface, interactive: false,
            className: 'corridor-strip corridor-strip--parking corridor-strip--partial'
        }).addTo(base));

        const detail = global.L.layerGroup();
        // Each layer of paint is tried on its own. They used to share one try/catch, which made the
        // first one to throw silently swallow every layer after it — so a street could lose its bay
        // markings because its rails failed, and look merely plain rather than broken.
        const mark = (what, draw) => {
            try { draw(); } catch (error) {
                console.warn(`[osmLanePaint] could not draw the ${what} of a street`, error);
            }
        };
        [street.markings].filter(Boolean).forEach(({ centerline, profile }) => {
            const has = (...names) => names.every(name => typeof global[name] === 'function');
            if (has('renderCorridorLaneMarkings', 'buildCorridorLaneMarkings')) {
                mark('lane lines', () => global.renderCorridorLaneMarkings(
                    global.buildCorridorLaneMarkings([centerline], profile), base, PANE));
            }
            if (has('renderCorridorParkingBays', 'buildCorridorParkingBays')) {
                mark('parking bays', () => global.renderCorridorParkingBays(
                    global.buildCorridorParkingBays([centerline], profile), base, PANE));
            }
            // The rails go with the lanes; their sleepers wait for the closer zoom. Without this an
            // OSM tramway was a bare band of ballast — the one lane type whose whole identity is
            // the thing drawn ON it, and the layer was drawing everything on a street except that.
            if (has('renderCorridorRails')) {
                mark('rails', () => global.renderCorridorRails(
                    [centerline], profile, base, { pane: PANE, sleeperGroup: detail }));
            }
            if (has('renderCorridorDirectionArrows', 'buildCorridorDirectionArrows')) {
                mark('direction arrows', () => global.renderCorridorDirectionArrows(
                    global.buildCorridorDirectionArrows([centerline], profile), detail, PANE));
            }
        });
        if ((street.partialParking || []).length
            && typeof global.renderCorridorParkingBays === 'function'
            && typeof global.buildCorridorParkingBaysForSpans === 'function') {
            mark('partial parking bays', () => global.renderCorridorParkingBays(
                global.buildCorridorParkingBaysForSpans(street.partialParking), base, PANE));
        }
        return {
            base, detail, seen: 0,
            box: street.box, name: street.name, width: street.width, length: street.length,
            edgeKeys: street.edgeKeys || segmentEdgeKeys(street.points)
        };
    }

    // Add what is in view, take away what is not. Cheap enough to run on every pan — a bounding-box
    // test and at most an addLayer per street, with nothing recomputed.
    function showInView() {
        if (!ensureRoot()) return;
        const detailed = (map()?.getZoom?.() ?? 0) >= MARKING_DETAIL_ZOOM;
        const view = viewportBox();
        painted.forEach(entry => {
            const wanted = !view || !entry.box || boxesOverlap(view, entry.box, 20);
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
        if (painted.size > CACHE_LIMIT) {
            [...painted.entries()]
                .filter(([, entry]) => !root || !root.hasLayer(entry.base))
                .sort((a, b) => a[1].seen - b[1].seen)
                .slice(0, painted.size - CACHE_LIMIT)
                .forEach(([key]) => discardPaintedSegment(key));
        }
        // The verdicts of segments that were never painted are held by nothing else, so they need
        // their own ceiling.
        keysToForget([...explained.keys()], painted, EXPLAINED_LIMIT).forEach(forget);
    }

    function discardPaintedSegment(key) {
        const entry = painted.get(key);
        if (entry) {
            if (root && typeof root.removeLayer === 'function') {
                root.removeLayer(entry.base);
                if (entry.detail) root.removeLayer(entry.detail);
            }
            (entry.edgeKeys || []).forEach(edgeKey => {
                if (paintedEdgeOwners.get(edgeKey) === key) paintedEdgeOwners.delete(edgeKey);
            });
            painted.delete(key);
        }
        forget(key);
    }

    // Replace stale segment groupings only after a complete-enough fetch proves the grouping changed.
    // This is the other half of edge ownership: ownership prevents double paint, while reconciliation
    // lets a newly discovered continuation merge two cached OSM-way fragments (and lets a newly
    // discovered junction split an old through-chain).
    function reconcileSegmentTopology(currentSegments, authoritativeBox) {
        const records = [...explained.entries()].map(([key, record]) => ({ ...record, key }));
        const staleKeys = supersededSegmentKeys(currentSegments, records, authoritativeBox);
        if (!staleKeys.length) return [];
        const staleBoxes = staleKeys
            .map(key => explained.get(key)?.box || painted.get(key)?.box)
            .filter(box => Array.isArray(box));
        staleKeys.forEach(discardPaintedSegment);
        // Ground remembered as processed while it held the old grouping must be eligible for another
        // cached fetch if a removed sibling lay just outside this viewport.
        for (let i = processed.length - 1; i >= 0; i -= 1) {
            if (staleBoxes.some(box => boxesOverlap(processed[i], box))) processed.splice(i, 1);
        }
        return staleKeys;
    }

    // Pure: which verdicts to drop so a register of this size comes down to `limit` — oldest first
    // (Map keeps insertion order), and never one whose street still has layers to be dropped with it.
    // A register that is all still-painted streets is left alone rather than trimmed to a lie.
    function keysToForget(keys, keep, limit) {
        const over = keys.length - limit;
        if (over <= 0) return [];
        const out = [];
        for (const key of keys) {
            if (out.length >= over) break;
            if (keep && typeof keep.has === 'function' && keep.has(key)) continue;
            out.push(key);
        }
        return out;
    }

    // Pure: does `outer` wholly contain `inner`?
    function contains(outer, inner) {
        return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
    }

    // Pure: do two planar boxes touch, allowing `pad` metres of slack?
    function boxesOverlap(a, b, pad = 0) {
        return !(a[0] > b[2] + pad || a[2] < b[0] - pad || a[1] > b[3] + pad || a[3] < b[1] - pad);
    }

    // The viewport as a planar box, from the same bbox string the fetch uses.
    function viewportBox() {
        const parts = String(bboxKey() || '').split(',').map(Number);
        return (parts.length === 4 && parts.every(Number.isFinite)) ? parts : null;
    }

    // Paint in idle slices, checking the run token between segments: a pan mid-paint abandons the
    // rest rather than finishing a picture of somewhere the user has already left.
    function paintSegments(pending, context, token) {
        const slice = (deadline) => {
            if (token !== run || !enabled) return;
            const started = (global.performance && performance.now()) || Date.now();
            const remaining = () => (deadline && typeof deadline.timeRemaining === 'function')
                ? deadline.timeRemaining()
                : SLICE_BUDGET_MS - (((global.performance && performance.now()) || Date.now()) - started);
            let drew = false;
            while (pending.length && remaining() > 1) {
                const segment = pending.shift();
                // Exact segment keys avoid recomputing the ordinary case. Edge ownership handles the
                // harder one: another viewport can split the same source edges at different junctions,
                // giving the overlapping runs different endpoint keys.
                if (painted.has(segment.key) || explained.has(segment.key)) continue;
                const candidates = unownedSegmentRuns(segment, paintedEdgeOwners, context.unproject);
                candidates.forEach(candidate => {
                    if (painted.has(candidate.key) || explained.has(candidate.key)) return;
                    const result = paintSegment(candidate, context);
                    remember(candidate.key, result);
                    const groups = buildSegmentGroups(result);
                    if (!groups) return;
                    painted.set(candidate.key, groups);
                    (groups.edgeKeys || []).forEach(edgeKey => paintedEdgeOwners.set(edgeKey, candidate.key));
                    drew = true;
                });
            }
            // Always, not only when something was drawn: a slice of segments that all turned out
            // unpaintable still adds a verdict apiece, and those are the ones with no layer to be
            // evicted along with.
            evict();
            if (drew) showInView();
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
            // ...and SAY so. A lane is thinner than a pixel down here, so the layer draws nothing —
            // which from the outside is indistinguishable from a toggle that does not work.
            showHint(i18nText('sidebar.roads.lanePaint.zoomIn',
                'Zoom in to see the lanes of the existing streets'));
            return;
        }
        clearHint();
        if (force) dropCache();

        const token = ++run;
        try {
            const project = global.wgs84ToHTRS96;
            const segmentation = global.RoadSegmentation;
            if (typeof project !== 'function' || !segmentation) return;

            // Show what is already painted, then decide whether anything here is new.
            //
            // The test is on the AREA, not on the parcels: which streets a parcel holds cannot be
            // known without the network, and a parcel can be far bigger than the screen (Ulica grada
            // Vukovara's road parcel is 3.8 km across). Asking "is this parcel painted?" therefore
            // answered yes for the whole boulevard after one viewport of it had been drawn, and the
            // rest was never painted. So: if this viewport lies inside ground already processed there
            // is nothing new to find — otherwise fetch, and let the per-run keys skip what is drawn.
            showInView();
            const view = viewportBox();
            if (!force && view && processed.some(box => contains(box, view))) return;

            // Reach past the viewport so a run is segmented against the junctions just off-screen.
            const key = bboxKey();
            const grown = growBbox(key, FETCH_MARGIN);
            const fetchKey = grown || key;
            const measurementBounds = leafletBoundsForHtrs(fetchKey);
            // The roads and parking are indexed local database reads. The parcel/building preload
            // covers the same buffered area, so every station of a segment has the boundary evidence
            // that the segment itself had when it was formed.
            const [{ ways, truncated }, parkingPolygons] = await Promise.all([
                fetchWays(fetchKey),
                fetchParkingPolygons(fetchKey),
                (measurementBounds && typeof global.fetchParcelData === 'function')
                    ? global.fetchParcelData(measurementBounds) : null,
                ensureBuildingsLoaded(measurementBounds)
            ]);
            if (token !== run || !enabled) return;
            const { road: parcels, other } = parcelsInView(measurementBounds);
            if (!parcels.length) return;   // parcels still loading; the next move tries again
            // Remember the ground this fetch covered, so panning back over it costs nothing.
            const grownBox = String(grown || key).split(',').map(Number);
            if (grownBox.length === 4 && grownBox.every(Number.isFinite)) {
                processed.push(grownBox);
                if (processed.length > PROCESSED_MEMORY) processed.shift();
            }

            // ONE segmentation for the whole viewport. Only the driveable network defines where a
            // segment ends; the rest of the ways are kept because the cross-section reads them.
            const defines = global.SystemRoadAdoption?.definesRoadSegments;
            const lines = ways
                .filter(way => (typeof defines === 'function' ? defines(way.properties) : true))
                .map(way => way.pointsXY);
            const segments = segmentation.segmentRoadNetwork(lines);

            const buildings = buildingRings(project);
            const roadLand = dissolveRoadLand(parcels);
            const otherRings = other.flatMap(parcel => parcel.rings);
            const context = {
                ways: ways.map(way => ({ ...way, box: boxOf([way.pointsXY]), driveable: isDriveable(way) })),
                segments, buildings,
                buildingBoxes: buildings.map(ring => boxOf([ring])),
                corridors: proposedCorridors(project),
                roadLandRings: roadLand,
                roadLandBoxes: roadLand.map(ring => boxOf([ring])),
                otherRings,
                otherBoxes: otherRings.map(ring => boxOf([ring])),
                // The segments a proposal has already taken, by the SAME key this layer uses — one
                // name for a segment across painting and editing.
                adopted: adoptedSegmentKeys(),
                // Whether the ways above are all of them, or all the endpoint would give.
                truncated,
                parkingPolygons,
                unproject: global.htrs96ToWGS84
            };
            // STREETS, then SEGMENTS, then painting. The parcels only say where a segment's kerb
            // lines are; what gets remembered and drawn is the segment.
            const pending = segmentsInView(context, parcels);
            reconcileSegmentTopology(pending, grownBox);
            paintSegments(pending, context, token);
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
        if (m && typeof m.on === 'function') {
            m.on('moveend zoomend', scheduleRefresh);
            m.on('mousemove', onPointerMove);
            m.on('click', onPointerClick);
        }
        refresh(true);
    }

    function disable() {
        enabled = false;
        run += 1;
        const m = map();
        if (m && typeof m.off === 'function') {
            m.off('moveend zoomend', scheduleRefresh);
            m.off('mousemove', onPointerMove);
            m.off('click', onPointerClick);
        }
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        // The readout belongs to the layer, so it goes with it rather than lingering hidden in the
        // document for the rest of the session.
        hinting = false;
        if (readout) { readout.remove(); readout = null; }
        clearLayer();
    }

    // ---------------------------------------------------------------------------
    // Saying what it did
    //
    // A layer that silently declines to draw a street is very hard to argue with: "some of Vukovarska
    // is painted and some is not" is a bug report nobody can act on. So every street looked at leaves
    // a record — its name, its width, and if it was not painted, why — and pointing at it says so.
    // ---------------------------------------------------------------------------

    // Pure: the nearest street examined within `reach` metres of a planar point, with what was decided
    // about it. Null when the pointer is not near anything this layer has looked at.
    function explainAt(pointXY, records, reach = 30) {
        if (!Array.isArray(pointXY) || !Number.isFinite(pointXY[0])) return null;
        let best = null;
        (records || []).forEach(record => {
            if (!record || !Array.isArray(record.points) || record.points.length < 2) return;
            if (record.box && !boxesOverlap([pointXY[0], pointXY[1], pointXY[0], pointXY[1]], record.box, reach)) return;
            const distance = distanceToPolyline(pointXY[0], pointXY[1], record.points);
            if (distance > reach) return;
            if (!best || distance < best.distance) best = { ...record, distance };
        });
        return best;
    }

    // The app's translator, with the English as the fallback — the same shape every other module here
    // uses, so a string is translated where a translation exists and readable where one does not.
    function i18nText(key, fallback, params = {}) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, params);
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match
        ));
    }

    // The one-line answer, ready to show: which street, which of its segments, and what became of it.
    //
    // The FRAME is translated; the reason a segment was not painted is not. A reason names what the
    // measurement did — "measured at only 3 stations", "no kerb line found on both sides" — and it is
    // read by whoever is fixing this layer, in the one language this layer is written in. Translating
    // it would give four wordings of a diagnostic and make a bug report harder to act on, not easier.
    function describeSegment(record, translate = i18nText) {
        if (!record) return '';
        const name = record.name || translate('sidebar.roads.lanePaint.unnamed', 'unnamed street');
        const length = Number.isFinite(record.length) ? Math.round(record.length) : null;
        const params = {
            name,
            length: length === null
                ? translate('sidebar.roads.lanePaint.segment', 'segment')
                : translate('sidebar.roads.lanePaint.segmentOf', '{{length}} m segment', { length })
        };
        if (record.state === 'adopted') {
            return translate('sidebar.roads.lanePaint.adopted',
                '{{name}} · {{length}} · adopted as a road proposal', params);
        }
        if (record.state === 'painted') {
            return translate('sidebar.roads.lanePaint.painted', '{{name}} · {{length}} · {{width}}', {
                ...params,
                width: Number.isFinite(record.width)
                    ? translate('sidebar.roads.lanePaint.wide', '{{width}} m wide', { width: record.width.toFixed(1) })
                    : translate('sidebar.roads.lanePaint.paintedPlain', 'painted')
            });
        }
        return translate('sidebar.roads.lanePaint.skipped', '{{name}} · {{length}} · NOT painted: {{reason}}', {
            ...params,
            reason: record.reason || 'no reason recorded'
        });
    }

    let readout = null;
    let hinting = false;
    function ensureReadout() {
        if (typeof document === 'undefined') return null;
        if (!readout) {
            readout = document.createElement('div');
            readout.className = 'osm-lane-paint-readout';
            readout.hidden = true;
            document.body.appendChild(readout);
        }
        return readout;
    }

    // A message that stays put until it is taken down, as opposed to the hover readout, which follows
    // the pointer. Used to answer the one question the layer could not previously answer: why ticking
    // the box at a city-wide zoom appears to do nothing at all.
    function showHint(text) {
        const box = ensureReadout();
        if (!box) return;
        hinting = !!text;
        box.hidden = !text;
        if (text) box.textContent = text;
    }

    function clearHint() {
        if (!hinting) return;
        hinting = false;
        if (readout) readout.hidden = true;
    }

    function belowMinZoom() {
        const zoom = map()?.getZoom?.();
        return Number.isFinite(zoom) && zoom < MIN_ZOOM;
    }

    // One readout update per frame. The pointer fires far faster than that, and each update walks
    // every verdict on the register.
    let pointerFrame = null;
    let pointerAt = null;
    function onPointerMove(event) {
        if (!enabled || !event?.latlng || typeof global.wgs84ToHTRS96 !== 'function') return;
        if (hinting || belowMinZoom()) return;   // nothing is drawn, so there is nothing to point at
        pointerAt = event.latlng;
        if (pointerFrame !== null) return;
        const draw = () => {
            pointerFrame = null;
            // The layer may have been switched off between the move and this frame, and ensureReadout
            // would happily build the readout the switch-off had just taken away.
            if (!enabled) return;
            const box = ensureReadout();
            if (!box || !pointerAt || hinting) return;
            const xy = global.wgs84ToHTRS96(pointerAt.lat, pointerAt.lng);
            const found = explainAt(xy, explainedRecords());
            box.hidden = !found;
            if (found) box.textContent = describeSegment(found);
        };
        pointerFrame = (typeof global.requestAnimationFrame === 'function')
            ? global.requestAnimationFrame(draw)
            : setTimeout(draw, 16);
    }

    // SHIFT-clicking copies the whole record to the console — the fastest way to hand one over. Behind
    // a modifier because an ordinary click on the map is how a parcel is selected, and a layer that
    // logs a paragraph every time somebody does that makes the console useless for anything else.
    function onPointerClick(event) {
        if (!enabled || !event?.latlng || typeof global.wgs84ToHTRS96 !== 'function') return;
        if (!event.originalEvent?.shiftKey) return;
        const xy = global.wgs84ToHTRS96(event.latlng.lat, event.latlng.lng);
        const found = explainAt(xy, explainedRecords());
        if (!found) return;
        console.log('[osmLanePaint]', describeSegment(found), {
            street: found.streetId, name: found.name, state: found.state,
            reason: found.reason || null, width: found.width, length: found.length,
            parcelId: found.parcelId, segmentKey: found.key
        });
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
        growBbox, ringsNear, boxOf, ringsOf, boxesOverlap, contains, runIsUnderProposal,
        corridorFromSides, segmentsInView, segmentsInParcel, paintSegment, lanesForParcel,
        segmentKey, streetOf, segmentPolygon, dissolveRoadLand, explainAt, describeSegment,
        keysToForget, segmentEdgeKeys, unownedSegmentRuns, supersededSegmentKeys,
        wgsBboxForHtrs, leafletBoundsForHtrs, parkingPolygonsFromGeoJSON, parkingSpansForSegment,
        // Exported for the same reason as `lanesForParcel`: WHICH group a mark goes into decides the
        // zoom it appears at, and that is a decision worth a test rather than a look at the map.
        buildSegmentGroups,
        // What the layer is holding on to, so a leak shows up as a number rather than as a slow map.
        sizes: () => ({
            painted: painted.size, explained: explained.size,
            ways: wayCache.size, parkingAreas: parkingCache.size
        }),
        // What the layer decided about every segment it has looked at, and the same grouped by
        // street — both for the console.
        segments: () => [...explained.values()],
        streets: () => {
            const byStreet = new Map();
            explained.forEach(record => {
                const id = record.streetId || 'unknown';
                if (!byStreet.has(id)) byStreet.set(id, { id, name: record.name, segments: [] });
                byStreet.get(id).segments.push(record);
            });
            return [...byStreet.values()].map(street => ({
                ...street,
                painted: street.segments.filter(s => s.state === 'painted').length,
                adopted: street.segments.filter(s => s.state === 'adopted').length,
                skipped: street.segments.filter(s => s.state === 'skipped').length
            }));
        },
        MIN_ZOOM, MARKING_DETAIL_ZOOM, CACHE_LIMIT, EXPLAINED_LIMIT, WAY_CACHE_LIMIT,
        PAINT_MAX_WIDTH, MIN_PAINT_WIDTH, SEGMENT_EDGE_PRECISION
    };
    global.OsmLanePaint = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
