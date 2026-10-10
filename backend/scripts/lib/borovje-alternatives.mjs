// Pure geometry for the Borovje alternative plans: building plots in, building footprints out.
// The plots are the UPU Borovje building plots (kazete M1-1…M1-11) as drawn by the official plan's
// parcel layout, so every alternative builds on the same land the official plan builds on and they
// compete for exactly the same parcels. No I/O and no network here; the importer does that.

import * as turf from '@turf/turf';

// Same storey height the official reconstruction uses (floors × 3.5 m), so heights compare directly.
export const STOREY_M = 3.5;

// Largest polygon of a (Multi)Polygon result; buffers of thin plots can split into pieces.
function largestPolygon(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'Polygon') return geometry;
    if (geometry.type !== 'MultiPolygon') return null;
    let best = null;
    let bestArea = 0;
    for (const coordinates of geometry.coordinates) {
        const area = turf.area(turf.polygon(coordinates));
        if (area > bestArea) { bestArea = area; best = { type: 'Polygon', coordinates }; }
    }
    return best;
}

// Inset a polygon by `metres` (negative buffer). Returns null when nothing usable is left.
export function inset(geometry, metres, minAreaM2 = 1) {
    let grown = null;
    try { grown = turf.buffer(turf.feature(geometry), -metres, { units: 'meters', steps: 1 }); } catch (_) { grown = null; }
    const polygon = largestPolygon(grown && grown.geometry);
    if (!polygon || turf.area(turf.feature(polygon)) < minAreaM2) return null;
    return polygon;
}

// Drop near-collinear vertices so a negative buffer's corner fans do not survive as noise.
export function simplifyFootprint(geometry, toleranceM = 0.4) {
    const degrees = toleranceM / 111320;
    const simplified = turf.simplify(turf.feature(geometry), { tolerance: degrees, highQuality: true });
    return simplified.geometry;
}

// Local planar frame (metres) around a reference point: equirectangular, exact enough at plot scale.
export function localFrame(origin) {
    const [lng0, lat0] = origin;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    const ky = 110540;
    return {
        toXY: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky],
        toLngLat: ([x, y]) => [lng0 + x / kx, lat0 + y / ky]
    };
}

// The plot's principal axis: the orientation of its minimum-area bounding rectangle (rotating
// calipers over the convex hull). Returns { frame, angle, u: [min,max], v: [min,max] } where u runs
// along the plot and v across it, both in metres in the frame rotated by `angle`.
export function orientedBox(polygon) {
    const centre = turf.centerOfMass(turf.feature(polygon)).geometry.coordinates;
    const frame = localFrame(centre);
    const hull = turf.convex(turf.feature(polygon)).geometry.coordinates[0].map(frame.toXY);
    let best = null;
    for (let i = 1; i < hull.length; i += 1) {
        const angle = Math.atan2(hull[i][1] - hull[i - 1][1], hull[i][0] - hull[i - 1][0]);
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
        for (const [x, y] of hull) {
            const u = x * c + y * s;
            const v = -x * s + y * c;
            u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
        }
        const area = (u1 - u0) * (v1 - v0);
        if (!best || area < best.area) best = { area, angle, u: [u0, u1], v: [v0, v1] };
    }
    if (best.u[1] - best.u[0] < best.v[1] - best.v[0]) {
        // Keep u as the long axis.
        best = { ...best, angle: best.angle + Math.PI / 2, u: [best.v[0], best.v[1]], v: [-best.u[1], -best.u[0]] };
    }
    return { ...best, frame };
}

// A rectangle given in the box's (u, v) metres, as a lon/lat Polygon.
function boxRect(box, u0, u1, v0, v1) {
    const [c, s] = [Math.cos(box.angle), Math.sin(box.angle)];
    const corner = (u, v) => box.frame.toLngLat([u * c - v * s, u * s + v * c]);
    const ring = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
    return turf.polygon([[...ring, ring[0]]]);
}

// An open urban block (half-perimeter block) on one plot: a ring of constant `depthM` along the plot's
// edges (set back by `setbackM`), with the park-facing middle of the ring left out, so the building
// holds the street line and both short ends and its yard opens onto the green behind it.
// `streetSide` is 'low' or 'high', the v-side of the plot's box facing the street. A plot too short
// for end wings (< `minLengthForWingsM`) keeps only the street half of the ring.
export function openBlock(plot, { streetSide = 'low', setbackM = 2, depthM = 12, minLengthForWingsM = 50 } = {}) {
    const outer = inset(plot, setbackM, 200);
    if (!outer) return null;
    const outerSimple = simplifyFootprint(outer, 1.5);
    const yard = inset(outerSimple, depthM, 1);
    if (!yard) return { geometry: outerSimple, kind: 'solid' };
    const ring = turf.difference(turf.feature(outerSimple), turf.feature(yard));
    if (!ring) return null;
    const box = orientedBox(outerSimple);
    const [u0, u1] = box.u;
    const [v0, v1] = box.v;
    const vMid = (v0 + v1) / 2;
    const withWings = u1 - u0 >= minLengthForWingsM;
    const endU0 = withWings ? u0 + depthM : u0 - 1;
    const endU1 = withWings ? u1 - depthM : u1 + 1;
    // The park side of the ring between the end wings is dropped.
    const parkSide = streetSide === 'high' ? boxRect(box, endU0, endU1, v0 - 1, vMid) : boxRect(box, endU0, endU1, vMid, v1 + 1);
    const kept = turf.difference(ring, parkSide);
    const geometry = kept && largestPolygon(kept.geometry);
    if (!geometry) return null;
    return { geometry: simplifyFootprint(geometry, 0.3), kind: withWings ? 'open-block' : 'street-wing' };
}

// Which long side of the plot's box is the street side: the one facing AWAY from the green (parks and
// recreation, a Polygon/MultiPolygon), so the open side of the block looks onto the park.
export function streetSideOf(plot, green, { setbackM = 2 } = {}) {
    const outer = inset(plot, setbackM, 200) || plot;
    const box = orientedBox(outer);
    const mid = (box.u[0] + box.u[1]) / 2;
    const [c, s] = [Math.cos(box.angle), Math.sin(box.angle)];
    const at = v => turf.point(box.frame.toLngLat([mid * c - v * s, mid * s + v * c]));
    const lines = turf.polygonToLine(turf.feature(green));
    const list = lines.type === 'FeatureCollection' ? lines.features : [lines];
    const distance = point => Math.min(...list.map(line => turf.pointToLineDistance(point, line, { units: 'meters' })));
    return distance(at(box.v[0])) >= distance(at(box.v[1])) ? 'low' : 'high';
}

export function buildingFeature(id, geometry, floors, extra = {}) {
    return {
        type: 'Feature',
        properties: { id, floors, height: Math.round(floors * STOREY_M * 10) / 10, ...extra },
        geometry
    };
}

export function summarize(features) {
    let footprintM2 = 0;
    let floorAreaM2 = 0;
    for (const feature of features) {
        const area = turf.area(feature);
        footprintM2 += area;
        floorAreaM2 += area * (feature.properties.floors || 0);
    }
    return { buildings: features.length, footprintM2: Math.round(footprintM2), floorAreaM2: Math.round(floorAreaM2) };
}
