// The filled footway of a WHOLE corridor, for anything that draws one: the cross-section editor's
// preview, the 2D map, the 3D model and the photorealistic view. One derivation, so the pavement is
// the same shape wherever it appears.
//
// Derived on demand rather than stored. The fill is VISUAL — it does not move the footprint or the
// takings — so a viewer computing it from their own loaded parcels and buildings is acceptable, and
// it means a node drag or a cross-section change needs no invalidation ritual: the next render just
// asks again. What IS stored on the proposal is the CHOICE (`definition.edgeFill.limit`), because
// which limit the author worked to is not something a viewer should re-decide.
//
// Browser-only: it reads the map's parcel layer and the building pool. The geometry underneath it
// (corridor-edge-fill.js) is pure and unit-tested; this file is the wiring.
(function (global) {
    'use strict';

    const DEFAULT_LIMIT = 'buildings';

    function turfApi() { return global.turf; }

    // Which building surveys to measure against — the ones on the map, falling back to the working
    // set so a fill is never silently empty. Mirrors the editor's own rule.
    function sceneSurveys(preferred) {
        if (preferred && (preferred.gdi || preferred.dgu || preferred.osm)) return preferred;
        const read = id => !!(global.document && document.getElementById(id)?.checked);
        const surveys = { gdi: read('showBuildings'), dgu: read('showBuildingsDgu'), osm: read('showBuildingsOsm') };
        if (!surveys.gdi && !surveys.dgu && !surveys.osm) return { gdi: true, dgu: false, osm: false };
        return surveys;
    }

    function geometryToPlanarRings(geometry) {
        if (!geometry || typeof global.wgs84ToHTRS96 !== 'function') return [];
        const rings = geometry.type === 'Polygon'
            ? geometry.coordinates
            : (geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : []);
        return (rings || [])
            .filter(ring => Array.isArray(ring) && ring.length >= 3)
            .map(ring => ring
                .map(pair => (Array.isArray(pair) ? global.wgs84ToHTRS96(pair[1], pair[0]) : null))
                .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])))
            .filter(ring => ring.length >= 3);
    }

    // Every parcel near the corridor, marked with whether it is road land and which building stands
    // on it. Road land is what the centerlines RUN THROUGH, asked of the geometry: the curated
    // road-parcel registry is incomplete, and a street missing from it broke both limits at once.
    function sceneParcels(centrelines, surveys) {
        const turf = turfApi();
        const parcels = [];
        const layer = global.parcelLayer;
        if (!turf || !layer || typeof layer.eachLayer !== 'function' || !centrelines.length) return parcels;

        const bounds = global.L.latLngBounds([]);
        centrelines.forEach(line => line.forEach(point => bounds.extend(point)));
        if (!bounds.isValid()) return parcels;
        const padded = bounds.pad(0.4);
        const withinReach = feature => {
            try {
                const box = turf.bbox(feature);
                return !(box[0] > padded.getEast() || box[2] < padded.getWest()
                    || box[1] > padded.getNorth() || box[3] < padded.getSouth());
            } catch (_) { return false; }
        };

        layer.eachLayer(child => {
            const feature = child && child.feature;
            if (!feature || !feature.geometry || !withinReach(feature)) return;
            const props = feature.properties || {};
            const parcelId = (props.parcelId !== undefined && props.parcelId !== null) ? String(props.parcelId)
                : (props.id !== undefined && props.id !== null ? String(props.id) : null);
            const isRoad = props.isRoad === true || props.isRoad === 'true'
                || (parcelId && typeof global.isRoadParcel === 'function' && global.isRoadParcel(parcelId));
            parcels.push({ id: parcelId, isRoad, feature, mainBuilding: null, mainArea: 0 });
        });
        if (!parcels.length) return parcels;

        const lines = centrelines.map(line => turf.lineString(line.map(point => [point.lng, point.lat])));
        parcels.forEach(parcel => {
            parcel.isRoadLand = parcel.isRoad || lines.some(line => {
                try { return turf.booleanIntersects(line, parcel.feature); } catch (_) { return false; }
            });
        });

        // Which building stands on which parcel, by centroid — a building overlapping two parcels
        // belongs to the one it mostly sits in, which is what a centroid answers cheaply.
        if (typeof global.collectLoadedCorridorBuildings === 'function') {
            global.collectLoadedCorridorBuildings({ surveys }).forEach(building => {
                if (!building || !building.geometry || !withinReach(building)) return;
                let centroid = null;
                let area = 0;
                try { centroid = turf.centroid(building); area = turf.area(building); } catch (_) { return; }
                if (!centroid || !(area > 0)) return;
                const host = parcels.find(parcel => {
                    if (parcel.isRoadLand) return false;
                    try { return turf.booleanPointInPolygon(centroid, parcel.feature); } catch (_) { return false; }
                });
                if (!host || area <= host.mainArea) return;
                host.mainBuilding = building;
                host.mainArea = area;
            });
        }
        return parcels;
    }

    // The cuts one side of one segment may take. Road land is the FLOOR of both limits: the pavement
    // always takes the road parcel, and the buildings limit then reaches further, parcel by parcel.
    function sceneCuts(limit, segment, planar, config, maxOffset, side, parcels) {
        const turf = turfApi();
        if (!turf) return [];
        const roadLand = parcels.filter(parcel => parcel.isRoadLand).map(parcel => parcel.feature);
        if (limit === 'parcels') return roadLand;

        const fronting = parcels
            .filter(parcel => !parcel.isRoadLand && parcel.mainBuilding)
            .map(parcel => ({
                parcelRings: geometryToPlanarRings(parcel.feature.geometry),
                rings: geometryToPlanarRings(parcel.mainBuilding.geometry)
            }));
        return roadLand.concat(global.corridorEdgeFillParcelCuts(planar, fronting, side, {
            minOffset: config.minOffset,
            maxOffset
        }, (lineOffset, sMin, sMax) => {
            const slice = global.corridorEdgeFillSlicePolyline(planar, sMin, sMax);
            if (!slice) return null;
            const ring = global.corridorEdgeFillBandRing(slice, config.innerOffset, {
                side, minOffset: lineOffset, maxOffset: lineOffset
            });
            if (!ring) return null;
            return global.corridorFeatureFromLatLngRing(ring.map(([x, y]) => {
                const [lat, lng] = global.htrs96ToWGS84(x, y);
                return { lat, lng };
            }));
        }));
    }

    // The filled footway of a corridor: `[{ type, paving, geojson }]`, one entry per fillable side
    // of each centerline segment. `options.segments` narrows it to a scope (the editor's), otherwise
    // the whole corridor is filled. Returns [] when nothing can be derived — no projection, no turf,
    // no parcels loaded.
    function regionsFor(definition, options = {}) {
        const out = [];
        const turf = turfApi();
        if (!definition || !turf) return out;
        if (typeof global.wgs84ToHTRS96 !== 'function' || typeof global.htrs96ToWGS84 !== 'function') return out;
        if (typeof global.corridorEdgeFillSides !== 'function' || typeof global.corridorEdgeFillRegion !== 'function') return out;
        if (typeof global.corridorFeatureFromLatLngRing !== 'function' || typeof global.buildCorridorStripPolygon !== 'function') return out;

        const stored = definition.edgeFill || {};
        const limit = options.limit || stored.limit || DEFAULT_LIMIT;
        const surveys = sceneSurveys(options.surveys);
        const entries = Array.isArray(options.segments) && options.segments.length
            ? options.segments.map(segment => ({ segment, profile: options.profile || global.corridorProfileOf(definition) }))
            : (global.corridorSegmentEntries ? global.corridorSegmentEntries(definition) : [])
                .map(entry => ({ segment: entry.points || entry.segment, profile: entry.profile }));
        const usable = entries
            .filter(entry => Array.isArray(entry.segment) && entry.segment.length >= 2 && entry.profile)
            .map((entry, index) => ({ ...entry, index }));
        if (!usable.length) return out;

        const parcels = sceneParcels(usable.map(entry => entry.segment), surveys);
        if (!parcels.length) return out;

        // Without an explicit list, a corridor's own segments are what its ends weld to.
        if (!Array.isArray(options.heldEndpoints) && usable.length > 1
            && typeof global.corridorHeldEndpoints === 'function') {
            const planarOf = segment => segment
                .map(point => global.wgs84ToHTRS96(point.lat, point.lng))
                .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
            const planars = usable.map(entry => planarOf(entry.segment));
            usable.forEach((entry, index) => {
                const others = planars.filter((_, other) => other !== index && planars[other].length >= 2);
                if (planars[index].length >= 2) entry.held = global.corridorHeldEndpoints(planars[index], others, 1);
            });
        }

        usable.forEach(entry => {
            const sides = global.corridorEdgeFillSides(entry.profile);
            if (!sides.left && !sides.right) return;
            const planar = entry.segment
                .map(point => global.wgs84ToHTRS96(point.lat, point.lng))
                .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
            if (planar.length < 2) return;
            const taper = Math.max(10, global.corridorProfileWidth(entry.profile));

            ['left', 'right'].forEach(side => {
                const config = sides[side];
                if (!config) return;
                const maxOffset = config.minOffset + global.EDGE_FILL_MAX_REACH;
                const held = (Array.isArray(options.heldEndpoints) && options.heldEndpoints[entry.index])
                    || entry.held || { start: false, end: false };
                const ring = global.corridorEdgeFillBandRing(planar, config.innerOffset, {
                    side,
                    minOffset: config.minOffset,
                    maxOffset,
                    taperStart: !!held.start,
                    taperEnd: !!held.end,
                    taperMeters: taper
                });
                if (!ring) return;
                const band = global.corridorFeatureFromLatLngRing(ring.map(([x, y]) => {
                    const [lat, lng] = global.htrs96ToWGS84(x, y);
                    return { lat, lng };
                }));
                const nominalOuter = side === 'right' ? -config.minOffset : config.minOffset;
                const nominal = global.corridorFeatureFromLatLngRing(
                    global.buildCorridorStripPolygon(entry.segment, nominalOuter, config.innerOffset)
                );
                const cuts = sceneCuts(limit, entry.segment, planar, config, maxOffset, side, parcels);
                const region = global.corridorEdgeFillRegion(band, nominal, cuts);
                if (!region || !region.geometry) return;
                const lane = (entry.profile.strips || [])[config.index] || {};
                out.push({
                    type: config.type,
                    paving: (typeof global.corridorPavingOf === 'function') ? global.corridorPavingOf(lane) : null,
                    side,
                    geojson: region
                });
            });
        });
        return out;
    }

    global.CorridorEdgeFill = { regionsFor, sceneParcels, sceneSurveys };
})(typeof window !== 'undefined' ? window : globalThis);
