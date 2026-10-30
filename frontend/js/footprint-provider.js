// The provider core for any building source that answers "footprints in this box": it extrudes
// them for the 3D view (near), lists those mostly inside a polygon (footprints) and finds those
// touching each of many regions (footprintsUnder, the demolition scan). The backend's OpenStreetMap
// provider (backend/buildings/osm-3d.js) runs it over Overpass, and the browser runs it over
// Overture's public tiles (overture-tiles.js, building-source-client.js), so both answer with the
// same shapes and the same rules. turf is passed in: node cannot resolve it from frontend/js.
(function () {
    const extrusion = (typeof window !== 'undefined' && window.BuildingExtrusion)
        || require('./building-extrusion.js');

    const DEFAULT_MAX_BUILDINGS = 4000;
    // Overpass refuses a bbox wider than 0.06° (osm-reference.js); a query is clamped to it around
    // its centre rather than refused.
    const MAX_SPAN_DEG = 0.06;

    // A WGS84 bbox [w,s,e,n] grown by `meters` on every side, clamped to `maxSpanDeg` around its centre.
    function expandBbox([w, s, e, n], meters = 0, maxSpanDeg = MAX_SPAN_DEG) {
        const midLat = (s + n) / 2;
        const dLat = meters / 110540;
        const dLon = meters / (111320 * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
        const box = [w - dLon, s - dLat, e + dLon, n + dLat];
        const clamp = (lo, hi) => {
            if (hi - lo <= maxSpanDeg) return [lo, hi];
            const mid = (lo + hi) / 2;
            return [mid - maxSpanDeg / 2 + 1e-9, mid + maxSpanDeg / 2 - 1e-9];
        };
        const [x0, x1] = clamp(box[0], box[2]);
        const [y0, y1] = clamp(box[1], box[3]);
        return [x0, y0, x1, y1];
    }

    // One footprint feature ({ id, geometry, properties: { measured_height_m, levels, building } }) → the
    // 3D block record, or null when degenerate. Shared with user-chosen building sources.
    function footprintFeatureToBuilding(feature) {
        const props = feature.properties || {};
        const id = String(feature.id || props.osm_id);
        const height = extrusion.resolveBuildingHeight({
            id,
            heightM: props.measured_height_m,
            levels: props.levels,
            building: props.building,
            areaM2: extrusion.footprintAreaM2(feature.geometry)
        });
        const record = extrusion.extrudeFootprint(id, feature.geometry, height.heightM);
        if (!record) return null;
        record.height_source = height.source;
        return record;
    }

    // What a provider answers instead of buildings when its upstream failed outright: the browser says
    // so (and when to try again) rather than drawing an empty city as if it had no buildings.
    function unavailableFrom(error) {
        const seconds = Number(error && (error.retryAfter ?? error.retryAfterSeconds));
        return { unavailable: true, retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null };
    }

    // Measured height and storeys only, null when the source has none: the same contract the other
    // providers keep for the footprint pool and the urban rule. Estimates are a 3D concern. A source
    // that states the building's use (a city model's function code, building-use.js) adds `use`.
    function footprintEntry(feature) {
        const props = feature.properties || {};
        return {
            id: String(feature.id || props.osm_id),
            geometry: feature.geometry,
            height_m: props.measured_height_m ?? null,
            floors: props.levels ?? null,
            ...(props.use ? { use: props.use } : {})
        };
    }

    // featuresIn(bbox) → { features, truncated?, partial? } or throws when the upstream failed.
    // `sources` names the answer: { near: 'osm-3d', footprints: 'osm-footprints' }.
    function createFootprintProvider({ turf, featuresIn, sources, label = 'buildings', log = () => {},
        maxBuildings = DEFAULT_MAX_BUILDINGS, maxSpanDeg = MAX_SPAN_DEG }) {
        async function near(geometry, bufferMeters) {
            const box = expandBbox(turf.bbox(geometry), bufferMeters, maxSpanDeg);
            let fc;
            try {
                fc = await featuresIn(box);
            } catch (error) {
                // Throttling or an outage: the scene renders without context buildings and says so,
                // rather than failing the whole 3D request.
                log(`no buildings for ${label} (${error.status || 'error'}): ${error.message}`);
                return { buildings: [], count: 0, source: sources.near, partial: true, heights: null, ...unavailableFrom(error) };
            }
            const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
            const distance = feature => {
                const [x, y] = turf.bbox(feature);
                return (x - cx) ** 2 + (y - cy) ** 2;
            };
            // Nearest first before the cap, as Overture does, so a growing radius only adds rings.
            const features = fc.features.slice().sort((a, b) => distance(a) - distance(b)).slice(0, maxBuildings);
            const buildings = [];
            const heights = { measured: 0, levels: 0, estimated: 0 };
            for (const feature of features) {
                const record = footprintFeatureToBuilding(feature);
                if (!record) continue;
                heights[record.height_source] += 1;
                buildings.push(record);
            }
            return {
                buildings,
                count: buildings.length,
                source: sources.near,
                partial: fc.partial === true,
                truncated: fc.truncated === true || fc.features.length > maxBuildings,
                heights
            };
        }

        // Buildings mostly inside the polygon; the centroid test stands in for Overture's ≥50% area rule.
        // A polygon wider than one query is read around its centre and answers truncated, so the
        // caller does not record the whole area as covered.
        async function footprints(geometry) {
            const wanted = turf.bbox(geometry);
            const box = expandBbox(wanted, 0, maxSpanDeg);
            const clamped = box.some((value, i) => Math.abs(value - wanted[i]) > 1e-8);
            let fc;
            try {
                fc = await featuresIn(box);
            } catch (error) {
                log(`no footprints for ${label}: ${error.message}`);
                return { footprints: [], count: 0, truncated: true, source: sources.footprints, ...unavailableFrom(error) };
            }
            const area = turf.feature(geometry);
            const list = fc.features
                .filter(feature => turf.booleanPointInPolygon(turf.centroid(feature), area))
                .slice(0, maxBuildings)
                .map(footprintEntry);
            return {
                footprints: list,
                count: list.length,
                // Partial or capped data does not cover the area; the caller must not believe it does.
                truncated: clamped || fc.truncated === true || fc.partial === true || list.length >= maxBuildings,
                source: sources.footprints
            };
        }

        // Every building touching a building cell (POST /buildings/cell): the cell loader files each one
        // under the cell holding its first vertex (building-cells.js), so nothing is filtered here — a
        // centroid test would drop a building whose first vertex lies in this cell and centroid in the next.
        async function mapFootprints(geometry) {
            const wanted = turf.bbox(geometry);
            const box = expandBbox(wanted, 0, maxSpanDeg);
            const clamped = box.some((value, i) => Math.abs(value - wanted[i]) > 1e-8);
            let fc;
            try {
                fc = await featuresIn(box);
            } catch (error) {
                log(`no footprints for ${label}: ${error.message}`);
                return { footprints: [], count: 0, truncated: true, source: sources.footprints, ...unavailableFrom(error) };
            }
            const list = fc.features.slice(0, maxBuildings).map(footprintEntry);
            return {
                footprints: list,
                count: list.length,
                truncated: clamped || fc.truncated === true || fc.partial === true || fc.features.length >= maxBuildings,
                ...(fc.partial === true ? { partial: true } : {}),
                source: sources.footprints
            };
        }

        // Buildings TOUCHING each region (the demolition scan). Regions spread wider than one query
        // answer truncated, which tells the caller to fall back to per-proposal requests.
        async function footprintsUnder(regions) {
            const byKey = new Map(regions.map(region => [String(region.key), []]));
            const all = turf.featureCollection(regions.map(region => turf.feature(region.geometry)));
            const [w, s, e, n] = turf.bbox(all);
            if ((e - w) > maxSpanDeg || (n - s) > maxSpanDeg) {
                return { regions: byKey, truncated: true, source: sources.footprints };
            }
            let fc;
            try {
                fc = await featuresIn([w, s, e, n]);
            } catch (error) {
                log(`no footprints under regions for ${label}: ${error.message}`);
                return { regions: byKey, truncated: true, source: sources.footprints, ...unavailableFrom(error) };
            }
            const prepared = regions.map(region => ({
                key: String(region.key),
                feature: turf.feature(region.geometry),
                box: turf.bbox(region.geometry)
            }));
            for (const building of fc.features) {
                const [bw, bs, be, bn] = turf.bbox(building);
                for (const region of prepared) {
                    const [rw, rs, re, rn] = region.box;
                    if (be < rw || bw > re || bn < rs || bs > rn) continue;
                    if (turf.booleanIntersects(building, region.feature)) byKey.get(region.key).push(footprintEntry(building));
                }
            }
            return { regions: byKey, truncated: fc.truncated === true || fc.partial === true, source: sources.footprints };
        }

        return { near, footprints, mapFootprints, footprintsUnder };
    }

    const api = { MAX_SPAN_DEG, expandBbox, footprintFeatureToBuilding, unavailableFrom, footprintEntry, createFootprintProvider };
    if (typeof window !== 'undefined') window.FootprintProvider = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
