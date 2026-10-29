// Ground treatment for building proposals: the site area left over AROUND the placed
// buildings, rendered either as sidewalk paving or as grass (like a park). One setting per
// proposal covers its authored ground boundary, whatever the building count. Pure turf read from
// the runtime global — plain GeoJSON in and out, no DOM and no map, so it is unit-testable
// headlessly. Rendering lives in structures.js (2D), three-mode.js (model) and photoreal-mode.js.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // New and edited building designs always specify their surrounding surface.
    const TREATMENTS = ['paved', 'green'];

    // Below this the leftover ring is a slither of rounding error, not a surface worth drawing.
    const MIN_SURFACE_AREA_M2 = 2;

    // The 2D fill of each treatment, matching the sidewalk paving and park grass in structures.js —
    // one definition for the map layer and for the building editors' live previews.
    const SURFACE_STYLE_2D = {
        paved: { color: '#8e8c87', fillColor: '#cdccc8', fillOpacity: 1 },
        green: { color: '#0d3b1f', fillColor: '#1b5e20', fillOpacity: 0.65 }
    };

    // A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
    function clipFailureOf(operation, error, site, operands) {
        const root = typeof window !== 'undefined' ? window : globalThis;
        const api = root.__parcelArrangement
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        return api ? api.clipFailure(operation, error, { site }, operands) : error;
    }

    function normalizeTreatment(value) {
        const key = String(value == null ? '' : value).trim().toLowerCase();
        return TREATMENTS.includes(key) ? key : 'paved';
    }

    function asFeature(input) {
        if (!input || typeof input !== 'object') return null;
        const geometry = input.type === 'Feature' ? input.geometry : input;
        if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return null;
        if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
        return { type: 'Feature', properties: {}, geometry: geometry };
    }

    function geometryArea(geometry) {
        const feature = asFeature(geometry);
        if (!feature || typeof turf === 'undefined' || typeof turf.area !== 'function') return 0;
        try { return Number(turf.area(feature)) || 0; } catch (_) { return 0; }
    }

    // The surround polygon: the authored ground boundary minus every building footprint on it.
    // Building drags leave this boundary and its authored furniture in place.
    function computeSurfacePolygon(blockFeature, buildingFeatures) {
        if (typeof turf === 'undefined' || typeof turf.difference !== 'function') return null;
        let surface = asFeature(blockFeature);
        if (!surface) return null;
        const buildings = Array.isArray(buildingFeatures) ? buildingFeatures : [];
        for (let i = 0; i < buildings.length && surface; i++) {
            const cutter = asFeature(buildings[i]);
            if (!cutter) continue;
            // Keeping the surface uncut by a building that threw would pave or green under that
            // building, and the surface is persisted with the proposal: refuse instead.
            try { surface = turf.difference(surface, cutter); } catch (error) {
                throw clipFailureOf('difference', error, 'building-ground.computeSurfacePolygon', [surface, cutter]);
            }
        }
        if (!surface || !surface.geometry) return null;
        if (geometryArea(surface.geometry) < MIN_SURFACE_AREA_M2) return null;
        try { return JSON.parse(JSON.stringify(surface.geometry)); } catch (_) { return surface.geometry; }
    }

    // Persist the surface polygon with the design; a footprint-only take may have no area left.
    function buildSurface(treatment, blockFeature, buildingFeatures, decorationDesign = null) {
        const normalized = normalizeTreatment(treatment);
        const polygon = computeSurfacePolygon(blockFeature, buildingFeatures);
        if (!polygon) return null;
        return { treatment: normalized, polygon, ...(decorationDesign ? { decorationDesign: JSON.parse(JSON.stringify(decorationDesign)) } : {}) };
    }

    // Surroundings consume land too. A footprint-only take leaves no surface to author.
    function clipSurfaceToLandTake(surface, take, turfApi) {
        if (!surface || !take) return null;
        const land = asFeature(take.geometry || take), ground = asFeature(surface.polygon);
        if (!land || !ground) return null;
        let clipped;
        try { clipped = turfApi.intersect(ground, land); } catch (error) {
            throw clipFailureOf('intersect', error, 'building-ground.clipSurfaceToLandTake', [ground, land]);
        }
        if (!clipped || turfApi.area(clipped) < MIN_SURFACE_AREA_M2) return null;
        return { ...surface, polygon: clipped.geometry };
    }

    function surfaceOf(proposal) {
        const raw = proposal && proposal.geometry ? proposal.geometry.groundSurface : null;
        if (!raw || typeof raw !== 'object') return null;
        if (!TREATMENTS.includes(raw.treatment)) return null;
        const treatment = raw.treatment;
        const feature = asFeature(raw.polygon);
        if (!feature) return null;
        return { treatment, polygon: feature.geometry, ...(raw.decorationDesign ? { decorationDesign: JSON.parse(JSON.stringify(raw.decorationDesign)) } : {}) };
    }

    function treatmentOf(proposal) {
        const surface = surfaceOf(proposal);
        return surface ? surface.treatment : 'paved';
    }

    // Whole-design movement keeps authored furniture tied to the moving ground in WGS84.
    function moveDecorationDesign(design, from, to, moveCoordinates) {
        if (!design) return null;
        const moved = JSON.parse(JSON.stringify(design));
        Object.keys(moved).forEach(key => {
            if (!Array.isArray(moved[key])) return;
            moved[key] = moved[key].map(item => item?.coordinate
                ? { ...item, coordinate: moveCoordinates(item.coordinate, from, to) }
                // A fenced area: its gates, and its ring unless it follows the ground's own outline.
                : key === 'enclosures' && item && typeof item === 'object' && !Array.isArray(item)
                    ? { ...item, gates: (item.gates || []).map(gate => moveCoordinates(gate, from, to)), ...(item.ring ? { ring: moveCoordinates(item.ring, from, to) } : {}) }
                    : moveCoordinates(item, from, to));
        });
        return moved;
    }

    // Visible ground excludes applied corridors in every renderer. The authored surround stays
    // intact, so removing a road restores it; treatments never pave or green over standing roads.
    function surfaceWithoutCorridors(geometry, corridors) {
        let feature = asFeature(geometry);
        for (const corridor of corridors) {
            try {
                if (!turf.booleanIntersects(feature, corridor)) continue;
                feature = turf.difference(feature, corridor);
                if (!feature) return null;
            } catch (error) {
                throw clipFailureOf('difference', error, 'building-ground.surfaceWithoutCorridors', [feature, corridor]);
            }
        }
        return feature.geometry;
    }

    // Every applied proposal that paves or greens its visible surroundings, as
    // { proposalId, treatment, buildings, geometry }. `isAppliedFn(proposal, sub)` is the caller's applied
    // predicate (each renderer already has one) so this module stays free of lifecycle knowledge.
    function appliedSurfaces(proposals, isAppliedFn) {
        const out = [];
        if (!Array.isArray(proposals) || typeof isAppliedFn !== 'function') return out;
        const corridors = proposals.filter(proposal => {
            if (!proposal?.roadProposal) return false;
            try { return !!isAppliedFn(proposal, proposal.roadProposal); } catch (_) { return false; }
        })
            .map(proposal => asFeature(proposal.roadProposal.definition?.polygon)).filter(Boolean);
        proposals.forEach(function (proposal) {
            if (!proposal || !proposal.buildingProposal) return;
            const surface = surfaceOf(proposal);
            if (!surface) return;
            let applied = false;
            try { applied = !!isAppliedFn(proposal, proposal.buildingProposal); } catch (_) { applied = false; }
            if (!applied) return;
            const geometry = surfaceWithoutCorridors(surface.polygon, corridors);
            if (!geometry) return;
            out.push({
                proposalId: proposal.proposalId != null ? String(proposal.proposalId) : null,
                treatment: surface.treatment,
                ...(surface.decorationDesign ? { decorationDesign: surface.decorationDesign } : {}),
                buildings: (proposal.geometry?.buildings || []).map(asFeature).filter(Boolean),
                geometry
            });
        });
        return out;
    }

    // A vacant plot is a current output of an applied layout with no standing building or
    // applied physical design on it. This is presentation, never authored land or ownership.
    function vacantPlots(features, proposals, isAppliedFn, turfApi, existingBuildings = []) {
        const applied = proposals.filter(proposal => isAppliedFn(proposal));
        const layouts = new Set(applied.filter(proposal => proposal.parcelLayout).map(proposal => String(proposal.proposalId)));
        const plots = features.filter(feature => feature.properties?.readjustmentPiece?.role === 'plot'
            && layouts.has(String(feature.properties?.producedByProposalId)));
        if (!plots.length) return [];
        const occupied = existingBuildings.map(asFeature).filter(Boolean);
        const add = value => { const feature = asFeature(value); if (feature) occupied.push(feature); };
        applied.filter(proposal => !proposal.parcelLayout).forEach(proposal => {
            (proposal.geometry?.buildings || []).forEach(add);
            add(proposal.geometry?.landTake);
            add(proposal.geometry?.groundSurface?.polygon);
            add(proposal.structureProposal?.geometry);
            add(proposal.roadProposal?.definition?.polygon);
        });
        const boxes = occupied.map(feature => ({ feature, box: turfApi.bbox(feature) }));
        return plots.filter(feature => {
            const box = turfApi.bbox(feature);
            return !boxes.some(entry => {
                if (box[0] >= entry.box[2] || box[2] <= entry.box[0] || box[1] >= entry.box[3] || box[3] <= entry.box[1]) return false;
                try {
                    const intersection = turfApi.intersect(feature, entry.feature);
                    return intersection && turfApi.area(intersection) > 0.1;
                } catch (error) {
                    throw clipFailureOf('intersect', error, 'building-ground.vacantPlots', [feature, entry.feature]);
                }
            });
        });
    }

    // Parcels are private ground. A design's open ground (paved or green alike) is fenced along every
    // parcel boundary that crosses it, the street edge included, but never along a building wall. A
    // courtyard is shared only when the parcel layout makes it a parcel of its own: then no boundary
    // crosses it, and its edges against private yards are fenced like any other. `ground` is the
    // visible surface, `parcels` the live parcels around it, `buildings` the design's footprints.
    // Returns line segments as [[lng, lat], ...] coordinate arrays. turfApi is turf 6.
    const FENCE_WALL_TOLERANCE_M = 0.3;
    const FENCE_MIN_LENGTH_M = 0.5;

    function fenceLines(ground, parcels, buildings, turfApi) {
        const surface = asFeature(ground);
        if (!surface) return [];
        const linesOf = feature => {
            const out = [];
            turfApi.flattenEach(turfApi.polygonToLine(feature), line => out.push(line));
            return out;
        };
        const near = (point, lines) => lines.some(line =>
            turfApi.pointToLineDistance(point, line, { units: 'meters' }) <= FENCE_WALL_TOLERANCE_M);
        const edgeOfGround = linesOf(surface);
        const walls = (Array.isArray(buildings) ? buildings : []).map(asFeature).filter(Boolean).flatMap(linesOf);
        const [west, south, east, north] = turfApi.bbox(surface);
        const key = point => `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
        const seen = new Set();
        const out = [];
        for (const parcel of Array.isArray(parcels) ? parcels : []) {
            const feature = asFeature(parcel);
            if (!feature) continue;
            const box = turfApi.bbox(feature);
            if (box[0] > east || box[2] < west || box[1] > north || box[3] < south) continue;
            const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
            for (const ring of polygons.flat()) {
                for (let i = 1; i < ring.length; i++) {
                    const a = ring[i - 1], b = ring[i];
                    // Neighbouring parcels share their boundary: one fence, not two.
                    const edgeKey = [key(a), key(b)].sort().join('|');
                    if (seen.has(edgeKey)) continue;
                    seen.add(edgeKey);
                    const edge = turfApi.lineString([a, b]);
                    if (turfApi.length(edge, { units: 'meters' }) < FENCE_MIN_LENGTH_M) continue;
                    let pieces;
                    try { pieces = turfApi.lineSplit(edge, surface).features; } catch (error) {
                        throw clipFailureOf('lineSplit', error, 'building-ground.fenceLines', [edge, surface]);
                    }
                    for (const piece of pieces.length ? pieces : [edge]) {
                        const length = turfApi.length(piece, { units: 'meters' });
                        if (length < FENCE_MIN_LENGTH_M) continue;
                        const middle = turfApi.along(piece, length / 2, { units: 'meters' });
                        if (!turfApi.booleanPointInPolygon(middle, surface) && !near(middle, edgeOfGround)) continue;
                        if (near(middle, walls)) continue;
                        out.push(piece.geometry.coordinates);
                    }
                }
            }
        }
        return out;
    }

    return {
        TREATMENTS: TREATMENTS,
        MIN_SURFACE_AREA_M2: MIN_SURFACE_AREA_M2,
        SURFACE_STYLE_2D: SURFACE_STYLE_2D,
        normalizeTreatment: normalizeTreatment,
        computeSurfacePolygon: computeSurfacePolygon,
        buildSurface: buildSurface,
        clipSurfaceToLandTake,
        surfaceOf: surfaceOf,
        treatmentOf: treatmentOf,
        moveDecorationDesign,
        vacantPlots,
        fenceLines,
        appliedSurfaces: appliedSurfaces
    };
});
