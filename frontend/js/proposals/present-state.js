// A plan's land split into public and private, and the present state of that land as a plan of its
// own, so Compare plans can set every plan beside what stands there now. Public land is land in
// public use: roads and OpenStreetMap parks and squares (user decision 2026-10-28); private land is
// the rest of the parcels. Semi-private land is not defined yet. Each existing building counts as a
// freeform building clipped to the land, measured by the same plan-yield rules as a design; a plan
// keeps the existing buildings its designs do not clear (remaining) beside the ones they add (new).
// Pure functions take their geometry operations as arguments; browser(win) wires turf, the road
// classification, the building source and OpenStreetMap: our server's Overpass chain first
// (/osm-public-spaces), public Overpass from the browser when our server cannot answer.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.PresentState = api.browser(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Public Overpass instances, tried in order (the same list the 3D view's life layer uses).
    const OVERPASS_URLS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter'
    ];
    const OVERPASS_TIMEOUT_S = 60;
    // Design pieces that are public land: plan-yield's open-space kinds.
    const PUBLIC_STRUCTURES = new Set(['park', 'square', 'lake']);
    // The largest box asked of Overpass in one go (≈ 5 km); a plan wider than this is refused.
    const MAX_SPAN_DEG = 0.05;

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // A positive measured number; anything else (null, a string) is no measurement.
    const measuredNumber = value => (finite(value) && value > 0 ? value : null);

    // Parks and squares inside a WGS84 box [w, s, e, n], as Overpass QL. A square is mapped as
    // place=square or as a pedestrian area.
    function publicSpaceQuery([w, s, e, n]) {
        const box = `(${s},${w},${n},${e})`;
        return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];(`
            + `way["leisure"="park"]${box};relation["leisure"="park"]["type"="multipolygon"]${box};`
            + `way["place"="square"]${box};relation["place"="square"]["type"="multipolygon"]${box};`
            + `way["highway"="pedestrian"]["area"="yes"]${box};relation["highway"="pedestrian"]["type"="multipolygon"]${box};`
            + ');out geom;';
    }

    function closedRing(points) {
        if (!Array.isArray(points) || points.length < 4) return null;
        const ring = points.map(p => [p && p.lon, p && p.lat]);
        if (ring.some(([x, y]) => !finite(x) || !finite(y))) return null;
        const [a, b] = [ring[0], ring[ring.length - 1]];
        return a[0] === b[0] && a[1] === b[1] ? ring : null;
    }

    // Relation member ways stitched end to end into closed rings; null when one does not close.
    function joinRings(members) {
        const paths = members.map(member => (Array.isArray(member.geometry) ? member.geometry.slice() : []));
        const rings = [];
        const same = (a, b) => a.lon === b.lon && a.lat === b.lat;
        while (paths.length) {
            let path = paths.shift();
            let progressed = true;
            while (path.length && progressed && !same(path[0], path[path.length - 1])) {
                progressed = false;
                for (let i = 0; i < paths.length; i += 1) {
                    const next = paths[i];
                    if (!next.length) continue;
                    const first = path[0], last = path[path.length - 1];
                    if (same(last, next[0])) path = path.concat(next.slice(1));
                    else if (same(last, next[next.length - 1])) path = path.concat(next.slice(0, -1).reverse());
                    else if (same(first, next[next.length - 1])) path = next.slice(0, -1).concat(path);
                    else if (same(first, next[0])) path = next.slice(1).reverse().concat(path);
                    else continue;
                    paths.splice(i, 1); progressed = true; break;
                }
            }
            const ring = closedRing(path);
            if (!ring) return null;
            rings.push(ring);
        }
        return rings;
    }

    function inside(ring, [x, y]) {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    }

    // Overpass `out geom` elements → park and square polygons. A relation whose rings do not close
    // is left out and counted in `skipped`, so a caller can say the coverage is incomplete.
    function publicSpacesFromOverpass(elements) {
        const features = [];
        let skipped = 0;
        const members = new Set();
        (Array.isArray(elements) ? elements : []).forEach(el => {
            if (el && el.type === 'relation') (el.members || []).forEach(m => { if (m && m.type === 'way' && m.ref != null) members.add(String(m.ref)); });
        });
        (Array.isArray(elements) ? elements : []).forEach(el => {
            if (!el || !el.tags) return;
            const tags = el.tags;
            const kind = tags.leisure === 'park' ? 'park' : (tags.place === 'square' || tags.highway === 'pedestrian') ? 'square' : null;
            if (!kind) return;
            let geometry = null;
            if (el.type === 'way') {
                if (members.has(String(el.id)) && !tags.leisure && !tags.place) return;
                const ring = closedRing(el.geometry);
                if (ring) geometry = { type: 'Polygon', coordinates: [ring] };
            } else if (el.type === 'relation') {
                const outer = joinRings((el.members || []).filter(m => m && m.type === 'way' && m.role !== 'inner'));
                const holes = joinRings((el.members || []).filter(m => m && m.type === 'way' && m.role === 'inner'));
                if (outer && outer.length && holes) {
                    const polygons = outer.map(ring => [ring]);
                    holes.forEach(hole => {
                        const at = outer.findIndex(ring => inside(ring, hole[0]));
                        if (at >= 0) polygons[at].push(hole);
                    });
                    geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
                }
            }
            if (!geometry) { skipped += 1; return; }
            features.push({ type: 'Feature', id: `${el.type[0]}${el.id}`, geometry, properties: { kind, osmId: `${el.type[0]}${el.id}` } });
        });
        return { features, skipped };
    }

    // The part of `feature` covered by any of `spaces`, in m², never more than the feature itself.
    // ops: { areaOf, intersect } — intersect(a, b) → Feature or null.
    function coveredM2(feature, spaces, ops) {
        const total = ops.areaOf(feature);
        let covered = 0;
        for (const space of spaces) {
            const piece = ops.intersect(feature, space);
            if (piece) covered += ops.areaOf(piece);
        }
        return Math.min(total, covered);
    }

    /**
     * Public and private land of a plan's parcels, in m². pieces: the design pieces standing on them
     * (corridor pieces apart in `corridors`); cadastral: the parcels themselves. A corridor piece and
     * a park, square or lake piece are public; another design piece is private. A parcel no piece
     * covers is untouched and splits as it is today: a road parcel is public, the rest is public
     * where OpenStreetMap parks and squares cover it and private elsewhere.
     */
    function splitLand({ pieces = [], corridors = [], cadastral = [], isRoad = () => false, spaces = [], ops }) {
        const anchorsOf = feature => (feature && feature.properties && Array.isArray(feature.properties.cadastreParcelIds) ? feature.properties.cadastreParcelIds : []).map(String);
        const idOf = feature => String(feature && feature.properties && (feature.properties.parcelId ?? feature.properties.id));
        const covered = new Set();
        let publicM2 = 0, privateM2 = 0;
        corridors.forEach(piece => { anchorsOf(piece).forEach(id => covered.add(id)); publicM2 += ops.areaOf(piece); });
        pieces.forEach(piece => {
            const props = piece.properties || {};
            const original = !String(props.producedByProposalId || '').trim() && anchorsOf(piece).length === 1 && anchorsOf(piece)[0] === idOf(piece);
            if (original) return;
            anchorsOf(piece).forEach(id => covered.add(id));
            if (PUBLIC_STRUCTURES.has(props.structureType)) publicM2 += ops.areaOf(piece);
            else privateM2 += ops.areaOf(piece);
        });
        cadastral.forEach(parcel => {
            if (covered.has(idOf(parcel))) return;
            const area = ops.areaOf(parcel);
            const open = isRoad(idOf(parcel)) ? area : coveredM2(parcel, spaces, ops);
            publicM2 += open;
            privateM2 += area - open;
        });
        return { publicLandM2: publicM2, privateLandM2: privateM2 };
    }

    /**
     * Existing buildings as freeform building records: one per building, its footprint clipped to the
     * parcels it was found on. regions: Map parcelId → [{ id, geometry, height_m, floors }].
     * A building with neither height nor floors keeps no height, so plan-yield counts it unmeasured.
     */
    function builtRecords({ regions, parcelsById, ops, floorHeightM = 3 }) {
        const byBuilding = new Map();
        regions.forEach((buildings, parcelId) => {
            const parcel = parcelsById.get(String(parcelId));
            if (!parcel) return;
            (buildings || []).forEach(building => {
                if (!building || !building.geometry) return;
                const footprint = { type: 'Feature', properties: {}, geometry: building.geometry };
                const piece = ops.intersect(footprint, parcel);
                if (!piece || !piece.geometry) return;
                const key = String(building.id);
                const entry = byBuilding.get(key) || { building, polygons: [] };
                const g = piece.geometry;
                if (g.type === 'Polygon') entry.polygons.push(g.coordinates);
                else if (g.type === 'MultiPolygon') entry.polygons.push(...g.coordinates);
                byBuilding.set(key, entry);
            });
        });
        return [...byBuilding.entries()].map(([id, { building, polygons }]) => {
            const properties = { type: 'proposedBuilding', floorHeightM };
            const height = measuredNumber(building.height_m), floors = measuredNumber(building.floors);
            if (height !== null) properties.height = height;
            if (floors !== null) properties.floors = floors;
            return {
                proposalId: `built:${id}`, applied: true, lifecycleStatus: 'active',
                buildingProposal: { buildings: [{ type: 'Feature', properties,
                    geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons } }] }
            };
        });
    }

    /**
     * The existing buildings a plan leaves standing (builtRecords output, minus its demolition
     * ground). regions: Features a design clears (its parcels or footprints, a structure, a road
     * corridor). The thresholds are the demolition scan's (corridor-tunnel.js
     * splitDemolitionFootprint): under 2 m² of overlap the building is untouched; when what is left
     * is under 10 m² or 15% of the footprint it is gone; otherwise the rest stands.
     * ops: { areaOf, intersect, difference }.
     */
    function remainingBuildings({ built, regions, ops }) {
        return built.map(record => {
            const original = record.buildingProposal.buildings[0];
            const footprintM2 = ops.areaOf(original);
            let feature = original;
            for (const region of regions) {
                const clip = ops.intersect(feature, region);
                if (!clip || ops.areaOf(clip) < 2) continue;
                const rest = ops.difference(feature, region);
                const restM2 = rest ? ops.areaOf(rest) : 0;
                if (!rest || restM2 < Math.max(10, footprintM2 * 0.15)) return null;
                feature = { ...feature, geometry: rest.geometry };
            }
            return feature === original ? record : { ...record, buildingProposal: { buildings: [feature] } };
        }).filter(Boolean);
    }

    // A box around features, [w, s, e, n].
    function bboxOf(features) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        const walk = c => {
            if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
            else c.forEach(walk);
        };
        features.forEach(f => { if (f && f.geometry && f.geometry.coordinates) walk(f.geometry.coordinates); });
        return [w, s, e, n].every(finite) ? [w, s, e, n] : null;
    }

    function browser(win) {
        const log = message => console.log(`[${new Date().toISOString()}] [PresentState] ${message}`);
        const spaceCache = new Map();
        const ops = {
            areaOf: feature => win.__planYield.geometryAreaM2(feature),
            intersect: (a, b) => {
                try { return win.turf.intersect(a, b); }
                catch (error) {
                    win.__parcelArrangement.reportClipFailure('intersect', error, { site: 'present-state' }, [a, b]);
                    return null;
                }
            },
            // A failed difference keeps the building whole: it is reported, never silently removed.
            difference: (a, b) => {
                try { return win.turf.difference(a, b); }
                catch (error) {
                    win.__parcelArrangement.reportClipFailure('difference', error, { site: 'present-state' }, [a, b]);
                    return a;
                }
            }
        };
        const keyOf = feature => String(feature.properties && (feature.properties.parcelId ?? feature.id));

        // Existing buildings on parcels, clipped to them, as freeform building records.
        async function existingOn(parcels, floorHeightM) {
            const parcelsById = new Map(parcels.map(feature => [keyOf(feature), feature]));
            const regions = new Map();
            const list = [...parcelsById.entries()];
            for (let i = 0; i < list.length; i += 200) {
                const chunk = list.slice(i, i + 200).map(([key, feature]) => ({ key, geometry: feature.geometry }));
                const payload = await win.BuildingSourceClient.request('/buildings/under', { regions: chunk });
                if (!payload || payload.supported === false) throw new Error('No building data covers this land.');
                if (payload.truncated || payload.unavailable) throw new Error('The building data for this land is incomplete.');
                Object.entries(payload.regions || {}).forEach(([key, buildings]) => regions.set(key, buildings));
            }
            return builtRecords({ regions, parcelsById, ops, floorHeightM });
        }

        // What a plan's designs clear: each member's demolition region (the app's own rule,
        // demolition-prefetch.js) and its road corridor pieces.
        function demolitionGround(snapshot) {
            const pieces = snapshot.materializedFeatures || [];
            const regions = win.__demolitionPrefetch.collectDemolitionRegions(snapshot.records || [], {
                normalizeGoalKey: goal => win.__applyRoute.normalizeGoalKey(goal),
                parcelFeatures: proposal => {
                    const ids = new Set((proposal.cadastreParcelIds || []).map(String));
                    return pieces.filter(piece => ((piece.properties && piece.properties.cadastreParcelIds) || []).some(id => ids.has(String(id))));
                },
                structureGeometry: proposal => proposal.structureProposal && proposal.structureProposal.geometry
            });
            return [...regions.map(region => ({ type: 'Feature', properties: {}, geometry: region.geometry })), ...(snapshot.corridorFeatures || [])];
        }

        // Our server's Overpass chain (GET /osm-public-spaces) first; null when it cannot answer
        // completely, so the caller asks public Overpass instead (user decision 2026-10-28).
        async function fromServer(box) {
            const started = Date.now();
            try {
                const params = new URLSearchParams({ bbox: box.join(','), crs: 'EPSG:4326' });
                const response = await win.fetch(`${win.getBackendBase()}/osm-public-spaces?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(45000) });
                const payload = await response.json();
                if (!response.ok || !Array.isArray(payload.features)) throw new Error(payload.error || `HTTP ${response.status}`);
                log(`our server answered ${payload.features.length} parks and squares in ${Date.now() - started} ms`);
                return payload.features;
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [PresentState] our server could not read parks and squares (${error.message}); asking public Overpass`);
                return null;
            }
        }

        // OpenStreetMap parks and squares over a box, once per box: our server, else public Overpass.
        async function publicSpaces(box) {
            if (box[2] - box[0] > MAX_SPAN_DEG || box[3] - box[1] > MAX_SPAN_DEG) {
                throw new Error('The land is too wide to read its parks and squares in one go.');
            }
            const key = box.map(v => v.toFixed(5)).join(',');
            if (spaceCache.has(key)) return spaceCache.get(key);
            const query = publicSpaceQuery(box);
            const request = (async () => {
                const served = await fromServer(box);
                if (served) return served;
                let failure = null;
                for (const url of OVERPASS_URLS) {
                    const started = Date.now();
                    try {
                        const response = await win.fetch(`${url}?data=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout((OVERPASS_TIMEOUT_S + 10) * 1000) });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const payload = await response.json();
                        if (payload && payload.remark) throw new Error(`incomplete answer: ${payload.remark}`);
                        const result = publicSpacesFromOverpass(payload && payload.elements);
                        log(`${new URL(url).host} answered ${result.features.length} parks and squares in ${Date.now() - started} ms${result.skipped ? `, ${result.skipped} unreadable` : ''}`);
                        return result.features;
                    } catch (error) {
                        failure = error;
                        console.warn(`[${new Date().toISOString()}] [PresentState] ${new URL(url).host} failed: ${error.message}`);
                    }
                }
                throw new Error(`Parks and squares could not be read from OpenStreetMap: ${failure ? failure.message : 'no answer'}`);
            })();
            spaceCache.set(key, request);
            request.catch(() => spaceCache.delete(key));
            return request;
        }

        // Road parcels in a box: the road classification where the city has one, and the parcels
        // this browser has marked as roads.
        async function roadTest(box) {
            const ground = win.CadastralParcelRepository;
            const ids = new Set();
            if (win.__roadParcels && win.__roadParcels.curatedRoadsAvailable() && ground && ground.ensureRoadIds) {
                const result = await ground.ensureRoadIds(win.L.latLngBounds([[box[1], box[0]], [box[3], box[2]]]));
                (result.ids || []).forEach(id => ids.add(String(id)));
            }
            return id => ids.has(id) || (typeof win.isRoadParcel === 'function' && win.isRoadParcel(id));
        }

        // The ground of a prepared plan (PlanAnalysis.prepare): its public and private land, and the
        // existing buildings it leaves standing.
        async function groundOf(snapshot, { floorHeightM = 3 } = {}) {
            const box = bboxOf(snapshot.cadastralFeatures || []);
            if (!box) return { land: { publicLandM2: null, privateLandM2: null }, remaining: [] };
            const [spaces, isRoad, existing] = await Promise.all([publicSpaces(box), roadTest(box), existingOn(snapshot.cadastralFeatures, floorHeightM)]);
            const land = splitLand({ pieces: snapshot.materializedFeatures, corridors: snapshot.corridorFeatures || [],
                cadastral: snapshot.cadastralFeatures, isRoad, spaces, ops });
            const remaining = remainingBuildings({ built: existing, regions: demolitionGround(snapshot), ops });
            log(`${snapshot.plan?.content?.title || 'plan'}: ${remaining.length} of ${existing.length} existing buildings remain`);
            return { land, remaining };
        }

        /**
         * The present state over the parcels of prepared plans (the basis), as Plan stats figures.
         * planStats(records, extra) computes the figures the way Plan stats does for a design set.
         */
        async function measure({ title, basis, assumptions }) {
            const parcelsById = new Map();
            basis.forEach(snapshot => (snapshot.cadastralFeatures || []).forEach(feature => parcelsById.set(keyOf(feature), feature)));
            const parcels = [...parcelsById.values()];
            const box = bboxOf(parcels);
            if (!box) throw new Error('The chosen land has no cadastral parcels.');
            const [spaces, isRoad, records] = await Promise.all([publicSpaces(box), roadTest(box), existingOn(parcels, assumptions.floorHeightM)]);
            const land = splitLand({ cadastral: parcels, isRoad, spaces, ops });
            // Nothing is designed here: the designs' yield is empty but for today's parks and squares,
            // and every existing building is one that remains.
            const designs = win.__planYield.planYield([], assumptions);
            designs.total.openSpaceM2 = parcels.reduce((sum, parcel) => sum + (isRoad(keyOf(parcel)) ? 0 : coveredM2(parcel, spaces, ops)), 0);
            const parcelAreaM2 = parcels.reduce((sum, parcel) => sum + ops.areaOf(parcel), 0);
            log(`${title}: ${parcels.length} parcels, ${records.length} buildings, ${Math.round(land.publicLandM2)} m² public`);
            return { unavailable: false, planTitle: title, proposalsTotal: 0, proposalsCounted: 0, yield: designs,
                remainingYield: win.__planYield.planYield(records, assumptions),
                parcelCount: parcels.length, parcelProduced: 0, parcelConsumed: 0, parcelMeasuredCount: parcels.length,
                parcelMeasuredArea: parcelAreaM2, openGroundM2: null, planAreaM2: parcelAreaM2, ...land };
        }

        return Object.freeze({ groundOf, measure, publicSpaces });
    }

    return { OVERPASS_URLS, PUBLIC_STRUCTURES, publicSpaceQuery, publicSpacesFromOverpass, splitLand, builtRecords, remainingBuildings, coveredM2, bboxOf, browser };
});
