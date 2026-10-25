// Shared Block and Row generators extracted from their editors. Geometry and explicit settings in; no UI state.
(function(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.BuildingRuleGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
    'use strict';
function blockRingOutline(superparcel, clipTo, params = {}, hooks = {}) {
    const setback = Number(params.setback) || 0;
    const requestedWidth = Number(params.width) || 0;
    const simplifyM = Number(params.simplifyM) || 0;
    if (!superparcel || !superparcel.geometry) return null;

    let outer = root.FootprintGeometry.robustNegativeBuffer(superparcel, setback);
    outer = root.FootprintGeometry.toSingleLargestPolygon(outer) || outer;
    if (!outer || !outer.geometry) return null;

    // Reduce the OUTLINE's vertex count, then clip it inside the parcel:
    //  - the negative buffer rounds every corner into up to GEOM_BUFFER_STEPS segments, and curved
    //    parcel edges are densely digitised, so the raw outline can carry hundreds of vertices —
    //    unusable for manual editing. root.turf.simplify (Douglas–Peucker) collapses those to a handful;
    //    higher "Simplify (m)" = fewer vertices. (Applied here, AFTER the buffer, is why it now
    //    actually reduces the visible outline — simplifying the parcel earlier was undone by the
    //    buffer re-rounding the corners.)
    //  - a simplification chord can bow slightly past the boundary, so clip to the parcel after.
    const clippingBoundary = clipTo === false ? null : (clipTo || superparcel);
    outer = simplifyAndClipOutline(outer, simplifyM, clippingBoundary);
    if (!outer || !outer.geometry) return null;

    // Incrementally inset the inner ring; keep the last valid geometry even if a step fails.
    let inner = null;
    let widthAchieved = requestedWidth;
    let minSideLength = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    while (widthAchieved > 0 && attempts < MAX_ATTEMPTS) {
        const inc = root.FootprintGeometry.incrementalInsetPolygon(outer, widthAchieved, 0);
        if (inc && inc.feature) {
            inner = inc.feature;
            if (inc.reason === 'ok' && Math.abs(inc.achievedInset - widthAchieved) < 1e-3) break;
            if (isFinite(inc.minEdgeValue)) minSideLength = inc.minEdgeValue;
            if (typeof hooks.onNarrowEdge === 'function') {
                try { hooks.onNarrowEdge(inc); } catch (_) { }
            }
        }
        if (inc && inc.reason === 'ok') break;
        widthAchieved *= 0.9;
        attempts += 1;
    }

    return { outer, inner, widthAchieved, minSideLength };
}


function simplifyAndClipOutline(feature, simplifyM, parcel) {
    let outline = feature;
    if (simplifyM > 0 && outline && outline.geometry) {
        try {
            const tolDeg = simplifyM / 111320; // ~metres → degrees of latitude
            const s = root.turf.simplify(outline, { tolerance: tolDeg, highQuality: true, mutate: false });
            const cleaned = root.FootprintGeometry.toSingleLargestPolygon(root.FootprintGeometry.sanitizePolygonFeature(s) || s) || s;
            if (cleaned && cleaned.geometry && root.turf.area(cleaned) > 0) outline = cleaned;
        } catch (err) {
            console.warn('Outline simplification failed', err);
        }
    }
    // Always clip. root.turf.booleanWithin only tests vertices, so a simplification chord across an
    // outward bend of the parcel edge (every vertex inside, the edge 2 cm outside) read as "inside"
    // and was published reaching into the neighbour. Intersecting an outline that IS inside returns
    // it unchanged; site-clip also strips the zero-width spikes clipping leaves on shared edges.
    if (parcel && parcel.geometry && outline && outline.geometry) {
        try {
            const clipped = (typeof root.__siteClip !== 'undefined' && root.__siteClip)
                ? root.__siteClip.clipToSite(outline, parcel, { turf: root.turf })
                : root.turf.intersect(outline, parcel);
            if (clipped && clipped.geometry && root.turf.area(clipped) > 0) {
                outline = root.FootprintGeometry.toSingleLargestPolygon(clipped) || outline;
            }
        } catch (err) {
            // Unclipped, the outline can reach into the neighbour (the reason this clip exists):
            // refuse. The generators' own catch says so in the modal.
            const api = root.__parcelArrangement || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
            throw api ? api.clipFailure('intersect', err, { site: 'building-blocks.clipOutlineToParcel' }, [outline, parcel]) : err;
        }
    }
    return outline;
}
    function rowFootprint(block, settings, deps = {}) {
        const { lengthM: length, depthM: width, chamferM: chamfer = 0, offsetEastM: offsetX = 0, offsetNorthM: offsetY = 0, rotationRadians: rotation = 0, height = 17.5 } = settings;
        const turf = deps.turf || root.turf;
        const helpers = deps.footprints || root.FootprintGeometry;
        let cachedSuperparcel, cachedCentroid, cachedMetersPerDegLng, cachedMetersPerDegLat, cachedSuperparcelMeters, baseRotation;
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return null;
        }

        // An authored site can extend beyond the currently selected child parcels. Keep it as
        // the geometry boundary while parcel features still define ownership and row splitting.
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = (block.site?.geometry ? turf.cleanCoords(JSON.parse(JSON.stringify(block.site))) : null) || helpers.robustUnion(parcelFeatures);

        if (!superparcel) {
            throw new Error('Failed to create superparcel');
        }

        // Sanitize polygon
        if (typeof helpers.sanitizePolygonFeature === 'function') {
            superparcel = helpers.sanitizePolygonFeature(superparcel) || superparcel;
        }

        if (!superparcel || !superparcel.geometry) {
            throw new Error('Failed to process superparcel');
        }

        // Get the exterior ring of the superparcel
        const geom = superparcel.geometry;
        let ring;
        if (geom.type === 'Polygon') {
            ring = geom.coordinates[0];
        } else if (geom.type === 'MultiPolygon') {
            // Use the largest polygon
            let maxArea = 0;
            for (const poly of geom.coordinates) {
                const area = Math.abs(turf.area(turf.polygon([poly[0]])));
                if (area > maxArea) {
                    maxArea = area;
                    ring = poly[0];
                }
            }
        }

        if (!ring || ring.length < 4) {
            throw new Error('Invalid superparcel geometry');
        }

        // Convert to meters using centroid as origin for accurate distance calculations
        const centroid = turf.centroid(superparcel);
        const [cLng, cLat] = centroid.geometry.coordinates;
        // The affine local frame with the ellipsoid's true scales at the centroid (local-frame.js)
        const localFrame = root.LocalFrame.makeLocalFrame(cLng, cLat);
        const metersPerDegLng = localFrame.metersPerDegLng;
        const metersPerDegLat = localFrame.metersPerDegLat;

        // Cache for boundary checking
        cachedSuperparcel = superparcel;
        cachedCentroid = [cLng, cLat];
        cachedMetersPerDegLng = metersPerDegLng;
        cachedMetersPerDegLat = metersPerDegLat;

        const toMeters = ([lng, lat]) => [
            (lng - cLng) * metersPerDegLng,
            (lat - cLat) * metersPerDegLat
        ];
        const toDegrees = ([x, y]) => [
            x / metersPerDegLng + cLng,
            y / metersPerDegLat + cLat
        ];

        // Convert ring to meters (excluding closing point)
        const meterRing = ring.slice(0, -1).map(toMeters);
        cachedSuperparcelMeters = meterRing;
        const n = meterRing.length;

        // Step 1: Find the longest straight side of the superparcel to determine orientation
        let longestSideLength = 0;
        let longestSideStart = null;
        let longestSideEnd = null;

        for (let i = 0; i < n; i++) {
            const p1 = meterRing[i];
            const p2 = meterRing[(i + 1) % n];
            const dx = p2[0] - p1[0];
            const dy = p2[1] - p1[1];
            const sideLen = Math.sqrt(dx * dx + dy * dy);

            if (sideLen > longestSideLength) {
                longestSideLength = sideLen;
                longestSideStart = p1;
                longestSideEnd = p2;
            }
        }

        if (!longestSideStart || !longestSideEnd || longestSideLength < 0.1) {
            throw new Error('Could not find valid longest side');
        }

        // Step 2: Calculate the base direction vector of the longest side
        const dx = longestSideEnd[0] - longestSideStart[0];
        const dy = longestSideEnd[1] - longestSideStart[1];
        const sideLength = longestSideLength;

        // Base angle from longest side
        baseRotation = Math.atan2(dy, dx);

        // Total rotation = base + user rotation
        const totalRotation = baseRotation + rotation;

        // Unit vector along the rotated length direction
        const ux = Math.cos(totalRotation);
        const uy = Math.sin(totalRotation);

        // Perpendicular unit vector (width direction)
        const perpX = -uy;
        const perpY = ux;

        // Step 3: Create rectangle centered at offset position
        const halfLength = length / 2;
        const halfWidth = width / 2;

        // Rectangle corners centered at offset position
        const corner1 = [offsetX - halfLength * ux - halfWidth * perpX, offsetY - halfLength * uy - halfWidth * perpY];
        const corner2 = [offsetX + halfLength * ux - halfWidth * perpX, offsetY + halfLength * uy - halfWidth * perpY];
        const corner3 = [offsetX + halfLength * ux + halfWidth * perpX, offsetY + halfLength * uy + halfWidth * perpY];
        const corner4 = [offsetX - halfLength * ux + halfWidth * perpX, offsetY - halfLength * uy + halfWidth * perpY];

        // Rectangle vertices in order (closed ring)
        const rectMeters = [corner1, corner2, corner3, corner4, corner1];

        // Convert back to degrees
        const rectDegrees = rectMeters.map(toDegrees);

        // Create the base rectangle feature
        let buildingPolygon = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [rectDegrees]
            }
        };

        // Apply the chamfer to the base rectangle
        if (chamfer > 0) {
            buildingPolygon = applyChamferToPolygon(buildingPolygon, chamfer);
        }

        // Set properties
        buildingPolygon.properties.type = 'proposedRowHouse';
        buildingPolygon.properties.length = length;
        buildingPolygon.properties.width = width;
        buildingPolygon.properties.chamfer = chamfer;
        buildingPolygon.properties.height = Math.round(height);
        buildingPolygon.properties.block = settings.blockName || '';
        buildingPolygon.properties.longestSideLength = longestSideLength;
        buildingPolygon.properties.offsetX = offsetX;
        buildingPolygon.properties.offsetY = offsetY;
        buildingPolygon.properties.rotation = rotation;

        // Store the pre-chamfer corners for reference
        const cornersInDegrees = [
            toDegrees(corner1),
            toDegrees(corner2),
            toDegrees(corner3),
            toDegrees(corner4)
        ];
        buildingPolygon.properties._corners = cornersInDegrees;

        // Store midpoints of rectangle sides for rotation handles (avoiding chamfered corners)
        buildingPolygon.properties._sideMidpoints = [
            // Midpoint of side 1-2 (bottom in length direction)
            [(cornersInDegrees[0][0] + cornersInDegrees[1][0]) / 2, (cornersInDegrees[0][1] + cornersInDegrees[1][1]) / 2],
            // Midpoint of side 2-3 (right in width direction)
            [(cornersInDegrees[1][0] + cornersInDegrees[2][0]) / 2, (cornersInDegrees[1][1] + cornersInDegrees[2][1]) / 2],
            // Midpoint of side 3-4 (top in length direction)
            [(cornersInDegrees[2][0] + cornersInDegrees[3][0]) / 2, (cornersInDegrees[2][1] + cornersInDegrees[3][1]) / 2],
            // Midpoint of side 4-1 (left in width direction)
            [(cornersInDegrees[3][0] + cornersInDegrees[0][0]) / 2, (cornersInDegrees[3][1] + cornersInDegrees[0][1]) / 2]
        ];

        return { feature: buildingPolygon, cache: { cachedSuperparcel, cachedCentroid, cachedMetersPerDegLng, cachedMetersPerDegLat, cachedSuperparcelMeters, baseRotation } };
    }

    function applyChamferToPolygon(feature, chamferLength) {
        if (!feature || !feature.geometry || chamferLength <= 0) return feature;

        const geom = feature.geometry;
        if (geom.type !== 'Polygon') return feature;

        const ring = geom.coordinates[0];
        if (!Array.isArray(ring) || ring.length < 4) return feature;

        // Work in meters using centroid as origin
        const centroid = root.turf.centroid(feature);
        const [cLng, cLat] = centroid.geometry.coordinates;
        // The affine local frame with the ellipsoid's true scales at the centroid (local-frame.js)
        const localFrame = root.LocalFrame.makeLocalFrame(cLng, cLat);
        const metersPerDegLng = localFrame.metersPerDegLng;
        const metersPerDegLat = localFrame.metersPerDegLat;

        // Convert to local meters
        const toMeters = ([lng, lat]) => [
            (lng - cLng) * metersPerDegLng,
            (lat - cLat) * metersPerDegLat
        ];
        const toDegrees = ([x, y]) => [
            x / metersPerDegLng + cLng,
            y / metersPerDegLat + cLat
        ];

        // Convert ring to meters (excluding closing point)
        const meterRing = ring.slice(0, -1).map(toMeters);
        const n = meterRing.length;

        // Calculate chamfered ring
        // Chamfer is defined as an isosceles triangle cut from each corner.
        // chamferLength = the length of each equal leg of the triangle,
        // measured from the corner vertex along each adjacent edge.
        const chamferedRing = [];

        for (let i = 0; i < n; i++) {
            const prev = meterRing[(i - 1 + n) % n];
            const curr = meterRing[i];
            const next = meterRing[(i + 1) % n];

            // Vector from current to previous
            const toPrev = [prev[0] - curr[0], prev[1] - curr[1]];
            const lenToPrev = Math.sqrt(toPrev[0] * toPrev[0] + toPrev[1] * toPrev[1]);

            // Vector from current to next
            const toNext = [next[0] - curr[0], next[1] - curr[1]];
            const lenToNext = Math.sqrt(toNext[0] * toNext[0] + toNext[1] * toNext[1]);

            if (lenToPrev < 0.001 || lenToNext < 0.001) {
                chamferedRing.push(curr);
                continue;
            }

            // Limit chamfer to not exceed 40% of either adjacent edge length
            const effectiveChamfer = Math.min(chamferLength, lenToPrev * 0.4, lenToNext * 0.4);

            if (effectiveChamfer < 0.001) {
                chamferedRing.push(curr);
                continue;
            }

            // Normalize vectors
            const normPrev = [toPrev[0] / lenToPrev, toPrev[1] / lenToPrev];
            const normNext = [toNext[0] / lenToNext, toNext[1] / lenToNext];

            // Point along edge toward previous, at chamferLength distance from corner
            const p1 = [
                curr[0] + normPrev[0] * effectiveChamfer,
                curr[1] + normPrev[1] * effectiveChamfer
            ];

            // Point along edge toward next, at chamferLength distance from corner
            const p2 = [
                curr[0] + normNext[0] * effectiveChamfer,
                curr[1] + normNext[1] * effectiveChamfer
            ];

            // Replace the corner vertex with two points (the chamfer cut)
            chamferedRing.push(p1);
            chamferedRing.push(p2);
        }

        // Convert back to degrees and close the ring
        const degreesRing = chamferedRing.map(toDegrees);
        if (degreesRing.length > 0) {
            degreesRing.push([...degreesRing[0]]);
        }

        return {
            type: 'Feature',
            properties: { ...feature.properties },
            geometry: {
                type: 'Polygon',
                coordinates: [degreesRing]
            }
        };
    }


// The editor's bounded search lives in one per-call runtime with explicit settings and cache.
function createRowPlacement(settings = {}, initialCache = {}) {
    const turf = root.turf, helpers = root.FootprintGeometry;
    const DEFAULT_BUILDING_LENGTH = 40, DEFAULT_BUILDING_WIDTH = 10;
    let currentBuildingLength = settings.lengthM ?? 40, currentBuildingWidth = settings.depthM ?? 10;
    const currentChamfer = settings.chamferM ?? 0;
    let {cachedSuperparcel,cachedCentroid,cachedMetersPerDegLng,cachedMetersPerDegLat,cachedSuperparcelMeters,baseRotation} = initialCache;
    const cache = () => ({cachedSuperparcel,cachedCentroid,cachedMetersPerDegLng,cachedMetersPerDegLat,cachedSuperparcelMeters,baseRotation});
    const sanitizePolygonFeature = helpers.sanitizePolygonFeature;
    const robustUnionLocal = features => helpers.robustUnion(features);
    const rowHouseGeneratorSite = block => block?.site?.geometry ? turf.cleanCoords(JSON.parse(JSON.stringify(block.site))) : robustUnionLocal((block?.parcels || []).map(p=>p.feature).filter(Boolean));
    const rowHouseFitsSite = (feature, boundary = cachedSuperparcel) => root.SingleBuildingGeometry.footprintWithinBoundary(feature,boundary,turf) === true;
    function generateRowHousePolygon(block,length,width,chamfer,offsetX=0,offsetY=0,rotation=0) {
        const result = rowFootprint(block,{lengthM:length,depthM:width,chamferM:chamfer,offsetEastM:offsetX,offsetNorthM:offsetY,rotationRadians:rotation,height:settings.height ?? 12});
        if(!result)return null;
        ({cachedSuperparcel,cachedCentroid,cachedMetersPerDegLng,cachedMetersPerDegLat,cachedSuperparcelMeters,baseRotation}=result.cache);
        return result.feature;
    }
function calculateMaxBuildingDimensions(block) {
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Use the authored site as the fit boundary when one was supplied; parcel features remain
        // the ownership inputs for the generated row.
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = rowHouseGeneratorSite(block) || robustUnionLocal(parcelFeatures);

        if (!superparcel) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Sanitize polygon
        if (typeof sanitizePolygonFeature === 'function') {
            superparcel = sanitizePolygonFeature(superparcel) || superparcel;
        }

        if (!superparcel || !superparcel.geometry) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Get the exterior ring of the superparcel
        const geom = superparcel.geometry;
        let ring;
        if (geom.type === 'Polygon') {
            ring = geom.coordinates[0];
        } else if (geom.type === 'MultiPolygon') {
            let maxArea = 0;
            for (const poly of geom.coordinates) {
                const area = Math.abs(turf.area(turf.polygon([poly[0]])));
                if (area > maxArea) {
                    maxArea = area;
                    ring = poly[0];
                }
            }
        }

        if (!ring || ring.length < 4) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Convert to meters using centroid as origin
        const centroid = turf.centroid(superparcel);
        const [cLng, cLat] = centroid.geometry.coordinates;
        // The affine local frame with the ellipsoid's true scales at the centroid (local-frame.js)
        const localFrame = root.LocalFrame.makeLocalFrame(cLng, cLat);
        const metersPerDegLng = localFrame.metersPerDegLng;
        const metersPerDegLat = localFrame.metersPerDegLat;

        const toMeters = ([lng, lat]) => [
            (lng - cLng) * metersPerDegLng,
            (lat - cLat) * metersPerDegLat
        ];

        const meterRing = ring.slice(0, -1).map(toMeters);
        const n = meterRing.length;

        // Set up cached values for consistent boundary checking
        cachedSuperparcel = superparcel;
        cachedCentroid = [cLng, cLat];
        cachedMetersPerDegLng = metersPerDegLng;
        cachedMetersPerDegLat = metersPerDegLat;
        cachedSuperparcelMeters = meterRing;

        // Find the longest side to determine orientation
        let longestSideLength = 0;
        let longestSideStart = null;
        let longestSideEnd = null;

        for (let i = 0; i < n; i++) {
            const p1 = meterRing[i];
            const p2 = meterRing[(i + 1) % n];
            const dx = p2[0] - p1[0];
            const dy = p2[1] - p1[1];
            const sideLen = Math.sqrt(dx * dx + dy * dy);

            if (sideLen > longestSideLength) {
                longestSideLength = sideLen;
                longestSideStart = p1;
                longestSideEnd = p2;
            }
        }

        if (!longestSideStart || !longestSideEnd) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Direction vectors
        const dx = longestSideEnd[0] - longestSideStart[0];
        const dy = longestSideEnd[1] - longestSideStart[1];

        // Use the same base orientation as the bar generator.
        baseRotation = Math.atan2(dy, dx);

        const ux = dx / longestSideLength;
        const uy = dy / longestSideLength;
        const perpX = -uy;
        const perpY = ux;

        // Binary search to find maximum dimensions with 2:1 aspect ratio
        // that keep all edges at least 1m from the superparcel border
        const MIN_MARGIN = 1.0; // 1 meter margin
        let minScale = 0;
        let maxScale = 500; // Start with a large scale

        // Helper to check if a rectangle at given scale fits (inside polygon and margin from boundary)
        const rectFitsWithMargin = (scale) => {
            const halfLength = scale;
            const halfWidth = scale / 2; // 2:1 aspect ratio

            // Rectangle corners centered at origin
            const corners = [
                [-halfLength * ux - halfWidth * perpX, -halfLength * uy - halfWidth * perpY],
                [halfLength * ux - halfWidth * perpX, halfLength * uy - halfWidth * perpY],
                [halfLength * ux + halfWidth * perpX, halfLength * uy + halfWidth * perpY],
                [-halfLength * ux + halfWidth * perpX, -halfLength * uy + halfWidth * perpY]
            ];

            // Check center and each corner and edge midpoint
            const testPoints = [
                [0, 0], // center
                ...corners,
                // Edge midpoints
                [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
                [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
                [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
                [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2]
            ];

            for (const pt of testPoints) {
                // First check if point is inside the superparcel
                if (!pointInPolygon(pt, meterRing)) {
                    return false;
                }
                // Then check minimum distance to boundary
                let minDist = Infinity;
                for (let i = 0; i < n; i++) {
                    const e1 = meterRing[i];
                    const e2 = meterRing[(i + 1) % n];
                    const dist = pointToSegmentDistance(pt, e1, e2);
                    if (dist < minDist) {
                        minDist = dist;
                    }
                }
                if (minDist < MIN_MARGIN) {
                    return false;
                }
            }
            return true;
        };

        // Binary search for maximum scale
        for (let iter = 0; iter < 50; iter++) {
            const midScale = (minScale + maxScale) / 2;
            if (rectFitsWithMargin(midScale)) {
                minScale = midScale;
            } else {
                maxScale = midScale;
            }
        }

        // A centred search has no useful result when the centroid falls in a concavity or hole.
        // Size a 2:1 bar at interior candidates instead, checking the complete polygon each time.
        const centredRing = [[-minScale, -minScale / 2], [minScale, -minScale / 2], [minScale, minScale / 2], [-minScale, minScale / 2]]
            .map(([x, y]) => [cLng + (x * ux + y * perpX) / metersPerDegLng,
                cLat + (x * uy + y * perpY) / metersPerDegLat]);
        if (!rowHouseFitsSite(turf.polygon([[...centredRing, centredRing[0]]]), superparcel)) minScale = 0;
        if (minScale < 2) {
            for (const offset of rowHouseInteriorOffsets(superparcel)) {
                let low = 0, high = 500;
                for (let iteration = 0; iteration < 14; iteration++) {
                    const scale = (low + high) / 2;
                    const corners = [[-scale, -scale / 2], [scale, -scale / 2], [scale, scale / 2], [-scale, scale / 2]];
                    const ring = corners.map(([x, y]) => [
                        cLng + (offset.offsetX + x * ux + y * perpX) / metersPerDegLng,
                        cLat + (offset.offsetY + x * uy + y * perpY) / metersPerDegLat
                    ]);
                    const feature = turf.polygon([[...ring, ring[0]]]);
                    if (rowHouseFitsSite(feature, superparcel)) low = scale; else high = scale;
                }
                minScale = Math.max(minScale, low);
            }
        }

        // minScale now holds the maximum half-length that fits
        const maxLength = Math.max(4, minScale * 2); // Full length (minimum 4m)
        const maxWidth = Math.max(2, minScale); // Full width (minimum 2m, which is half of length due to 2:1 ratio)

        // Calculate polygon diameter (longest line that fits inside)
        // This is the maximum distance between any two vertices
        let polygonDiameter = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const dx = meterRing[j][0] - meterRing[i][0];
                const dy = meterRing[j][1] - meterRing[i][1];
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > polygonDiameter) {
                    polygonDiameter = dist;
                }
            }
        }
        // Apply 1m margin to the diameter
        const maxSliderValue = Math.max(4, Math.round(polygonDiameter - 2)); // -2m for 1m margin on each side

        return { maxLength, maxWidth, maxSliderValue };
    }
function placeRowHouseBar(block, { offsetX = 0, offsetY = 0, rotation = 0 } = {}) {
        if (!generateRowHousePolygon(block, currentBuildingLength, currentBuildingWidth, currentChamfer, 0, 0, rotation)) return null;
        const site = cachedSuperparcel;
        const candidates = [{ offsetX, offsetY, rotation }, { offsetX: 0, offsetY: 0, rotation }, { offsetX: 0, offsetY: 0, rotation: 0 },
            ...rowHouseInteriorOffsets(site).flatMap(offset => [{ ...offset, rotation }, { ...offset, rotation: 0 }])];
        for (const candidate of candidates) {
            const feature = generateRowHousePolygon(block, currentBuildingLength, currentBuildingWidth, currentChamfer,
                candidate.offsetX, candidate.offsetY, candidate.rotation);
            if (feature && rowHouseFitsSite(feature, site)) return { feature, ...candidate };
        }
        return null;
    }
function rowHouseInteriorOffsets(site) {
        if (!site?.geometry || !cachedCentroid) return [];
        const polygons = site.geometry.type === 'MultiPolygon' ? site.geometry.coordinates : [site.geometry.coordinates];
        const offsets = [];
        const seen = new Set();
        // Bound clipping work independently of cadastral vertex density. The global cap also
        // bounds unusually fragmented selections; a missed placement is reported as unplaced.
        const maxCandidates = 256;
        const perComponentLimit = Math.min(96, Math.max(1, Math.floor(maxCandidates / polygons.length)));
        for (const coordinates of polygons) {
            if (offsets.length >= maxCandidates) break;
            const componentStart = offsets.length;
            const polygon = turf.polygon(coordinates);
            const [west, south, east, north] = turf.bbox(polygon);
            const points = [turf.centroid(polygon).geometry.coordinates, turf.pointOnFeature(polygon).geometry.coordinates];
            for (let x = 1; x < 8; x++) for (let y = 1; y < 8; y++) {
                points.push([west + (east - west) * x / 8, south + (north - south) * y / 8]);
            }
            const exterior = coordinates[0];
            const edgeCount = exterior.length - 1;
            const sampledEdges = Math.min(24, edgeCount);
            for (let sample = 0; sample < sampledEdges; sample++) {
                const index = Math.floor(sample * edgeCount / sampledEdges);
                const a = exterior[index], b = exterior[index + 1];
                const dx = (b[0] - a[0]) * cachedMetersPerDegLng;
                const dy = (b[1] - a[1]) * cachedMetersPerDegLat;
                const length = Math.hypot(dx, dy);
                if (!length) continue;
                for (const depth of [1, 3, 6, 12, currentBuildingWidth / 2 + 0.5]) {
                    for (const sign of [-1, 1]) points.push([
                        (a[0] + b[0]) / 2 - sign * dy / length * depth / cachedMetersPerDegLng,
                        (a[1] + b[1]) / 2 + sign * dx / length * depth / cachedMetersPerDegLat
                    ]);
                }
            }
            for (const point of points) {
                if (offsets.length - componentStart >= perComponentLimit || offsets.length >= maxCandidates) break;
                const offsetX = (point[0] - cachedCentroid[0]) * cachedMetersPerDegLng;
                const offsetY = (point[1] - cachedCentroid[1]) * cachedMetersPerDegLat;
                const key = `${Math.round(offsetX * 100)},${Math.round(offsetY * 100)}`;
                if (seen.has(key) || !turf.booleanPointInPolygon(point, polygon)) continue;
                seen.add(key);
                offsets.push({ offsetX, offsetY });
            }
        }
        return offsets;
    }
    return { calculate: calculateMaxBuildingDimensions, place: placeRowHouseBar, interiorOffsets: rowHouseInteriorOffsets, cache };
}
function pointToSegmentDistance(pt, e1, e2) {
        const dx = e2[0] - e1[0];
        const dy = e2[1] - e1[1];
        const lenSq = dx * dx + dy * dy;

        if (lenSq < 0.0001) {
            // Segment is essentially a point
            return Math.sqrt((pt[0] - e1[0]) ** 2 + (pt[1] - e1[1]) ** 2);
        }

        // Project point onto line, clamped to segment
        let t = ((pt[0] - e1[0]) * dx + (pt[1] - e1[1]) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projX = e1[0] + t * dx;
        const projY = e1[1] + t * dy;

        return Math.sqrt((pt[0] - projX) ** 2 + (pt[1] - projY) ** 2);
    }
function pointInPolygon(pt, polygon) {
        const x = pt[0], y = pt[1];
        let inside = false;
        const n = polygon.length;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];

            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }


function buildingBlocksClipFailure(operation,error,site,operands) {
    const api=root.__parcelArrangement || (typeof require==='function' ? require('./proposals/parcel-arrangement.js') : null);
    return api ? api.clipFailure(operation,error,{site},operands) : error;
}
function addWingsToBuilding(buildingFeature, { outerCoords, superparcel, wingWidth, buildingWidth, numWings, wingLength, positions }) {
    if (!buildingFeature || !Array.isArray(outerCoords) || outerCoords.length < 2) return buildingFeature;

    const ringLength = (coords) => {
        let len = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            len += root.turf.distance(root.turf.point(coords[i]), root.turf.point(coords[i + 1]), { units: 'meters' });
        }
        return len;
    };
    const pointAtDistance = (coords, targetDist) => {
        let accum = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const segLen = root.turf.distance(root.turf.point(coords[i]), root.turf.point(coords[i + 1]), { units: 'meters' });
            if (accum + segLen >= targetDist) {
                const t = (targetDist - accum) / segLen;
                return {
                    point: [
                        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                        coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
                    ],
                    segmentIndex: i
                };
            }
            accum += segLen;
        }
        return { point: coords[coords.length - 1], segmentIndex: coords.length - 2 };
    };
    const getTangentAt = (coords, segIndex) => {
        const p1 = coords[segIndex];
        const p2 = coords[segIndex + 1] || coords[0];
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const mag = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        return { tx: dx / mag, ty: dy / mag };
    };

    const perimeter = ringLength(outerCoords);
    if (!Number.isFinite(perimeter) || perimeter <= 0) return buildingFeature;

    const centroid = root.turf.centroid(buildingFeature);
    const [cx, cy] = centroid.geometry.coordinates;

    // Ray-cast inward to find how far the parcel border is on the opposite side; caps wing length
    const polygonBoundary = (superparcel && root.turf.polygonToLine) ? root.turf.polygonToLine(superparcel) : null;
    const distanceToOppositeBorder = (startPoint, bearingDeg) => {
        if (!polygonBoundary) return wingLength;
        const rayEnd = root.turf.destination(root.turf.point(startPoint), 5000, bearingDeg, { units: 'meters' });
        const ray = root.turf.lineString([startPoint, rayEnd.geometry.coordinates]);
        const intersections = root.turf.lineIntersect(ray, polygonBoundary);
        let closestPositive = Infinity;
        if (intersections && intersections.features) {
            for (const feat of intersections.features) {
                const pt = feat.geometry && feat.geometry.coordinates;
                if (!pt) continue;
                const dist = root.turf.distance(root.turf.point(startPoint), root.turf.point(pt), { units: 'meters' });
                if (dist > 0.5 && dist < closestPositive) closestPositive = dist;
            }
        }
        return Number.isFinite(closestPositive) ? closestPositive : wingLength;
    };

    // Wing bases come from the draggable position array (fractions along the ring); fall back to even
    // spacing if positions weren't supplied.
    const fracs = (Array.isArray(positions) && positions.length === numWings)
        ? positions.map(f => (((f % 1) + 1) % 1))
        : Array.from({ length: numWings }, (_, w) => (numWings ? w / numWings : 0));
    const halfWidth = Math.max(wingWidth, 1) / 2;
    const borderMargin = 1; // keep the wing tip just short of the opposite parcel border

    let result = buildingFeature;
    for (let w = 0; w < numWings; w++) {
        const centerDist = fracs[w] * perimeter;
        const info = pointAtDistance(outerCoords, centerDist);
        const base = info.point;
        const tan = getTangentAt(outerCoords, info.segmentIndex);

        // Inward normal (toward the block centroid)
        let nx = -tan.ty, ny = tan.tx;
        if (nx * (cx - base[0]) + ny * (cy - base[1]) < 0) { nx = -nx; ny = -ny; }

        const inwardBearingDeg = (Math.atan2(nx, ny) * 180) / Math.PI;
        const tangentBearingDeg = (Math.atan2(tan.tx, tan.ty) * 180) / Math.PI;

        // The rectangle starts on the outer ring, so the first `buildingWidth` metres overlap the
        // building wall (watertight union) and `wingLength` is the protrusion past the inner edge
        // into the courtyard. Cap the total so the wing never crosses the opposite parcel border.
        const wallBridge = Math.max(buildingWidth, 0);
        const maxLen = distanceToOppositeBorder(base, inwardBearingDeg) - borderMargin;
        const len = Math.min(wallBridge + wingLength, maxLen);
        if (len <= 0) continue;

        // Rectangle spanning the wing width (along the ring tangent) and its length (inward).
        const baseLeft = root.turf.destination(root.turf.point(base), halfWidth, tangentBearingDeg, { units: 'meters' }).geometry.coordinates;
        const baseRight = root.turf.destination(root.turf.point(base), halfWidth, (tangentBearingDeg + 180) % 360, { units: 'meters' }).geometry.coordinates;
        const tipLeft = root.turf.destination(root.turf.point(baseLeft), len, inwardBearingDeg, { units: 'meters' }).geometry.coordinates;
        const tipRight = root.turf.destination(root.turf.point(baseRight), len, inwardBearingDeg, { units: 'meters' }).geometry.coordinates;

        let wingPoly;
        try { wingPoly = root.turf.polygon([[baseLeft, baseRight, tipRight, tipLeft, baseLeft]]); } catch (_) { continue; }
        if (!wingPoly || !wingPoly.geometry) continue;

        // A wing the clipper could not add is a building other than the one asked for: refuse.
        let unioned = null;
        try { unioned = root.turf.union(result, wingPoly); } catch (e) {
            throw buildingBlocksClipFailure('union', e, 'building-blocks.addWing', [result, wingPoly]);
        }
        if (!unioned || !unioned.geometry) {
            throw buildingBlocksClipFailure('union', new Error('union came back empty'), 'building-blocks.addWing', [result, wingPoly]);
        }
        result = unioned;
    }

    // root.turf.union drops properties; restore the building's and record the wing params
    result.properties = Object.assign({}, buildingFeature.properties, { numWings, wingLength });
    return result;
}
function cutBuildingGap(buildingGeom, cutterPoly) {
    let diff = null;
    try { diff = root.turf.difference(buildingGeom, cutterPoly); } catch (e) {
        throw buildingBlocksClipFailure('difference', e, 'building-blocks.cutGap', [buildingGeom, cutterPoly]);
    }
    return (diff && diff.geometry) ? diff : buildingGeom;
}
function syncPositions(positions, count) {
    const out = Array.isArray(positions) ? positions.map(v => ((v % 1) + 1) % 1) : [];
    while (out.length > count) out.pop();
    while (out.length < count) {
        if (out.length === 0) { out.push(0); continue; }
        const sorted = out.slice().sort((a, b) => a - b);
        let bestGap = -1, bestMid = 0;
        for (let i = 0; i < sorted.length; i++) {
            const a = sorted[i];
            const b = (i + 1 < sorted.length) ? sorted[i + 1] : sorted[0] + 1; // wrap past 1
            const gap = b - a;
            if (gap > bestGap) { bestGap = gap; bestMid = ((a + b) / 2) % 1; }
        }
        out.push(bestMid);
    }
    return out;
}
// Same ring shaping path used by the Block editor, with explicit controls instead of sliders.
function blockMassingFromRing(ring, superparcel, settings = {}) {
    const turf=root.turf;
    const outerCoords=ring.outer.geometry.coordinates[0], innerCoords=ring.inner?.geometry.coordinates[0];
    const currentWidth=settings.width ?? ring.widthAchieved, SETBACK=settings.setback || 0;
    const currentChamferM=settings.chamferM || 0, currentSimplifyM=settings.simplifyM || 0;
    const currentBuildingHeight=settings.height || 17.5, DEFAULT_BUILDING_HEIGHT=17.5;
    const getBlockifyDisplayName=()=>settings.blockName || '';
    const minSideLength=ring.minSideLength;
    let gapPositions=[...(settings.gapPositions || [])], wingPositions=[...(settings.wingPositions || [])];
    const numGaps=gapPositions.length, gapWidth=settings.gapWidthM || 0;
    const closedRingFeature={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:innerCoords ? [outerCoords,[...innerCoords].reverse()] : [outerCoords]}};
    let buildingFeature;
    if(!innerCoords) return root.FootprintGeometry.applySelectiveChamferToFeature({...closedRingFeature,properties:{type:'proposedBuilding',height:currentBuildingHeight,width:0,setback:SETBACK}},currentChamferM,165);
        if (numGaps === 0 || gapWidth <= 0) {
            // Default: closed polygon with hole
            buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: currentWidth,
                    setback: SETBACK,
                    chamfer: Number(currentChamferM) || 0,
                    simplify: currentSimplifyM,
                    block: getBlockifyDisplayName(),
                    minSideLength: minSideLength,
                    height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT),
                    numGaps,
                    gapWidth
                },
                geometry: closedRingFeature.geometry
            };
        } else {
            // Cut N gaps from the ring using perpendicular cuts along the outer circumference
            // Helper: compute total ring length
            const ringLength = (coords) => {
                let len = 0;
                for (let i = 0; i < coords.length - 1; i++) {
                    len += turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' });
                }
                return len;
            };
            // Helper: interpolate a point along the ring at a given distance, also return segment index
            const pointAtDistance = (coords, targetDist) => {
                let accum = 0;
                for (let i = 0; i < coords.length - 1; i++) {
                    const segLen = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' });
                    if (accum + segLen >= targetDist) {
                        const t = (targetDist - accum) / segLen;
                        return {
                            point: [
                                coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                                coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
                            ],
                            segmentIndex: i,
                            t: t
                        };
                    }
                    accum += segLen;
                }
                return { point: coords[coords.length - 1], segmentIndex: coords.length - 2, t: 1 };
            };
            // Helper: get tangent direction at a point on the ring (direction along the circumference)
            const getTangentAt = (coords, segIndex) => {
                const p1 = coords[segIndex];
                const p2 = coords[segIndex + 1] || coords[0];
                const dx = p2[0] - p1[0];
                const dy = p2[1] - p1[1];
                const mag = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                return { tx: dx / mag, ty: dy / mag };
            };

            // Helper: find half the distance from a start point to the opposite superparcel edge along a bearing
            const polygonBoundary = turf.polygonToLine ? turf.polygonToLine(superparcel) : null;
            const halfDistanceToOppositeBorder = (startPoint, bearingDeg) => {
                if (!polygonBoundary) return Math.max(currentWidth, 1);

                const rayEnd = turf.destination(turf.point(startPoint), 5000, bearingDeg, { units: 'meters' });
                const ray = turf.lineString([startPoint, rayEnd.geometry.coordinates]);
                const intersections = turf.lineIntersect(ray, polygonBoundary);

                let closestPositive = Infinity;
                if (intersections && intersections.features) {
                    for (const feat of intersections.features) {
                        const pt = feat.geometry && feat.geometry.coordinates;
                        if (!pt) continue;
                        const dist = turf.distance(turf.point(startPoint), turf.point(pt), { units: 'meters' });
                        // Ignore the start point (or near-zero) and keep the nearest forward hit
                        if (dist > 0.5 && dist < closestPositive) {
                            closestPositive = dist;
                        }
                    }
                }

                if (!Number.isFinite(closestPositive) || closestPositive === Infinity) {
                    return Math.max(currentWidth, 1);
                }

                return Math.max(closestPositive / 2, 1);
            };

            const outerPerimeter = ringLength(outerCoords);
            if (!Number.isFinite(outerPerimeter) || outerPerimeter <= 0) {
                throw new Error('Failed to measure outer ring perimeter');
            }

            const stride = outerPerimeter / numGaps;
            let effectiveGapWidth = Math.min(gapWidth, stride * 0.9);
            if (!Number.isFinite(effectiveGapWidth) || effectiveGapWidth < 1) effectiveGapWidth = 1;

            // Step 1: Gap centres come from the draggable position array (fractions along the ring).
            // Self-heal if it drifted out of sync with the count (e.g. generation triggered by another
            // slider, or a freshly loaded modal).
            if (gapPositions.length !== numGaps) gapPositions = syncPositions(gapPositions, numGaps);
            const gapCenterDistances = gapPositions.map(f => (((f % 1) + 1) % 1) * outerPerimeter);

            // Step 2: For each gap, create perpendicular cuts
            let resultGeom = closedRingFeature;
            for (let g = 0; g < numGaps; g++) {
                const gapCenterDist = gapCenterDistances[g];

                // Find the two edge points: gapWidth/2 in each direction along the circumference
                const halfGap = effectiveGapWidth / 2;
                const dist1 = (gapCenterDist - halfGap + outerPerimeter) % outerPerimeter;
                const dist2 = (gapCenterDist + halfGap) % outerPerimeter;

                const edge1Info = pointAtDistance(outerCoords, dist1);
                const edge2Info = pointAtDistance(outerCoords, dist2);
                const edge1 = edge1Info.point;
                const edge2 = edge2Info.point;

                // Get tangent at each edge point to compute perpendicular
                const tan1 = getTangentAt(outerCoords, edge1Info.segmentIndex);
                const tan2 = getTangentAt(outerCoords, edge2Info.segmentIndex);

                // Perpendicular to tangent (pointing inward, roughly)
                // Perpendicular is (-ty, tx) or (ty, -tx); we want inward
                // Use centroid to determine which direction is inward
                const centroid = turf.centroid(closedRingFeature);
                const [cx, cy] = centroid.geometry.coordinates;

                // For edge1: perpendicular candidates
                let perp1x = -tan1.ty, perp1y = tan1.tx;
                // Check if this points toward centroid
                const toCentroid1x = cx - edge1[0];
                const toCentroid1y = cy - edge1[1];
                if (perp1x * toCentroid1x + perp1y * toCentroid1y < 0) {
                    perp1x = -perp1x;
                    perp1y = -perp1y;
                }

                let perp2x = -tan2.ty, perp2y = tan2.tx;
                const toCentroid2x = cx - edge2[0];
                const toCentroid2y = cy - edge2[1];
                if (perp2x * toCentroid2x + perp2y * toCentroid2y < 0) {
                    perp2x = -perp2x;
                    perp2y = -perp2y;
                }

                // Check if the two perpendicular directions would cause intersecting lines
                // and adjust them to be parallel if needed
                // Compute angle of each perpendicular direction
                const angle1 = Math.atan2(perp1y, perp1x);
                const angle2 = Math.atan2(perp2y, perp2x);

                // Normalize angle difference to [-PI, PI]
                let angleDiff = angle2 - angle1;
                while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

                // If angles differ, the lines are not parallel
                // Average the angles to make them parallel, each rotating by half the difference
                const avgAngle = angle1 + angleDiff / 2;

                // Use the averaged (parallel) direction for both lines
                const finalPerpX = Math.cos(avgAngle);
                const finalPerpY = Math.sin(avgAngle);

                // Use a ray from the gap center to the opposite superparcel edge; cut to its midpoint
                const gapCenterInfo = pointAtDistance(outerCoords, gapCenterDist);
                const gapBearingDeg = (Math.atan2(finalPerpX, finalPerpY) * 180) / Math.PI;
                const outwardBearingDeg = (gapBearingDeg + 180) % 360;
                const marginOuterM = 5; // small outward margin to avoid precision artefacts
                const innerDepthM = halfDistanceToOppositeBorder(gapCenterInfo.point, gapBearingDeg);

                // Line 1: from slightly outside edge1 to midpoint toward opposite border
                const line1outer = turf.destination(turf.point(edge1), marginOuterM, outwardBearingDeg, { units: 'meters' }).geometry.coordinates;
                const line1inner = turf.destination(turf.point(edge1), innerDepthM, gapBearingDeg, { units: 'meters' }).geometry.coordinates;

                // Line 2: from slightly outside edge2 to midpoint toward opposite border
                const line2outer = turf.destination(turf.point(edge2), marginOuterM, outwardBearingDeg, { units: 'meters' }).geometry.coordinates;
                const line2inner = turf.destination(turf.point(edge2), innerDepthM, gapBearingDeg, { units: 'meters' }).geometry.coordinates;

                // Build a quadrilateral cutter: outer1 -> outer2 -> inner2 -> inner1 -> outer1
                const cutterCoords = [line1outer, line2outer, line2inner, line1inner, line1outer];
                const cutterPoly = turf.polygon([cutterCoords]);

                if (cutterPoly && cutterPoly.geometry) {
                    resultGeom = cutBuildingGap(resultGeom, cutterPoly);
                }
            }

            // Normalize result geometry
            let finalGeom = resultGeom.geometry;
            if (!finalGeom || (finalGeom.type !== 'Polygon' && finalGeom.type !== 'MultiPolygon')) {
                // Fallback to closed ring
                finalGeom = closedRingFeature.geometry;
            }

            buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: currentWidth,
                    setback: SETBACK,
                    chamfer: Number(currentChamferM) || 0,
                    simplify: currentSimplifyM,
                    block: getBlockifyDisplayName(),
                    minSideLength: minSideLength,
                    height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT),
                    numGaps,
                    gapWidth: effectiveGapWidth
                },
                geometry: finalGeom
            };
        }


        // Add wings (protrusions toward the courtyard), unioned onto the building
        const numWings = wingPositions.length, wingLength = settings.wingLengthM || 0;
        if (wingPositions.length !== numWings) wingPositions = syncPositions(wingPositions, numWings);
        if (numWings > 0 && wingLength > 0) {
            buildingFeature = addWingsToBuilding(buildingFeature, {
                outerCoords,
                superparcel,
                wingWidth: currentWidth,
                buildingWidth: currentWidth,
                numWings,
                wingLength,
                positions: wingPositions
            });
        }

    return root.FootprintGeometry.applySelectiveChamferToFeature(buildingFeature,currentChamferM,165);
}

return { blockMassingFromRing, addWingsToBuilding, cutBuildingGap, syncPositions, createRowPlacement, pointToSegmentDistance, pointInPolygon, blockRingOutline, simplifyAndClipOutline, rowFootprint, rowChamfer: applyChamferToPolygon };
});
