// Unit tests for building collision detection and stable tunnel-edge metadata.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    corridorTunnelEdgeKey,
    findBuildingTunnelIntersections,
    makeBuildingTunnelRecord,
    addBuildingTunnelRecord,
    removeBuildingTunnelEdge,
    corridorSurfaceRuns
} = require('../../frontend/js/corridor-tunnel.js');

function fakeTurf(intersections = new Map()) {
    return {
        intersect: (_corridor, building) => intersections.get(building.properties.id) || null,
        area: feature => feature.properties.area
    };
}

describe('corridor building tunnels', () => {
    const from = { lat: 45.8, lng: 15.9 };
    const to = { lat: 45.81, lng: 15.91 };

    it('uses the same edge key in either drawing direction', () => {
        expect(corridorTunnelEdgeKey(from, to)).toBe(corridorTunnelEdgeKey(to, from));
    });

    it('keeps only building intersections with meaningful overlap', () => {
        const buildings = [
            { type: 'Feature', properties: { id: 'a' }, geometry: { type: 'Polygon', coordinates: [] } },
            { type: 'Feature', properties: { id: 'b' }, geometry: { type: 'Polygon', coordinates: [] } }
        ];
        const overlaps = new Map([
            ['a', { type: 'Feature', properties: { area: 12 }, geometry: { type: 'Polygon', coordinates: [] } }],
            ['b', { type: 'Feature', properties: { area: 0.1 }, geometry: { type: 'Polygon', coordinates: [] } }]
        ]);
        const hits = findBuildingTunnelIntersections(
            { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
            buildings,
            fakeTurf(overlaps)
        );
        expect(hits.map(hit => hit.id)).toEqual(['a']);
    });

    it('adds, replaces and removes records by edge rather than direction', () => {
        const first = makeBuildingTunnelRecord(from, to, [{ id: 'building-a' }], { segmentId: 's1' });
        const replacement = makeBuildingTunnelRecord(to, from, [{ id: 'building-b' }], { segmentId: 's1' });
        const records = addBuildingTunnelRecord([], first);
        addBuildingTunnelRecord(records, replacement);
        expect(records).toHaveLength(1);
        expect(records[0].buildingIds).toEqual(['building-b']);
        expect(removeBuildingTunnelEdge(records, from, to)).toEqual([]);
    });
});

// Tunnel spans are covered structures that acquire nothing: surface runs are the centerline
// minus tunnelled edges, and they drive parent collection and parcel splitting.
describe('corridorSurfaceRuns', () => {
    const p = (lng) => ({ lat: 0, lng });
    const seg = [p(0), p(1), p(2), p(3)];
    const tunnelOn = (a, b) => [{ edgeKey: corridorTunnelEdgeKey(a, b) }];

    it('passes the whole segment through when there are no tunnels', () => {
        expect(corridorSurfaceRuns([seg], [])).toEqual([seg]);
    });

    it('splits a segment into runs around a tunnelled edge', () => {
        const runs = corridorSurfaceRuns([seg], tunnelOn(p(1), p(2)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)]]);
    });

    it('is direction-agnostic about the tunnel edge key', () => {
        const runs = corridorSurfaceRuns([seg], tunnelOn(p(2), p(1)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)]]);
    });

    it('returns nothing for a fully tunnelled segment', () => {
        const short = [p(0), p(1)];
        expect(corridorSurfaceRuns([short], tunnelOn(p(0), p(1)))).toEqual([]);
    });

    it('drops runs shorter than one edge (tunnels on both sides of a vertex)', () => {
        const records = [...tunnelOn(p(0), p(1)), ...tunnelOn(p(1), p(2))];
        expect(corridorSurfaceRuns([seg], records)).toEqual([[p(2), p(3)]]);
    });

    it('accepts a single flat polyline as well as a segment list', () => {
        const runs = corridorSurfaceRuns(seg, tunnelOn(p(1), p(2)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)]]);
    });

    it('handles multiple segments independently', () => {
        const other = [p(10), p(11)];
        const runs = corridorSurfaceRuns([seg, other], tunnelOn(p(1), p(2)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)], [p(10), p(11)]]);
    });
});

// Tunnels exist only while inside buildings: the clip splits an edge at facade crossings and
// flags only the inside sub-edges. The fake turf below does the same planar math the real one
// does, with degrees scaled to metres so the function's minimum-length guards behave.
describe('clipCorridorEdgeThroughBuildings', () => {
    const { clipCorridorEdgeThroughBuildings } = require('../../frontend/js/corridor-tunnel.js');
    const SCALE = 100000; // 1 degree == 100 km in the fake planar world

    function planarTurf() {
        const coordsOf = feature => feature.geometry.coordinates;
        return {
            lineString: coords => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }),
            point: coords => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords } }),
            length: line => {
                const [a, b] = coordsOf(line);
                return Math.hypot(b[0] - a[0], b[1] - a[1]) * SCALE;
            },
            along: (line, distance) => {
                const [a, b] = coordsOf(line);
                const t = distance / (Math.hypot(b[0] - a[0], b[1] - a[1]) * SCALE);
                return { type: 'Feature', geometry: { type: 'Point', coordinates: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] } };
            },
            buffer: feature => feature, // facade buffering is a browser concern; identity here
            lineIntersect: (line, zone) => {
                const [a, b] = coordsOf(line);
                const ring = zone.geometry.coordinates[0];
                const features = [];
                for (let i = 0; i < ring.length - 1; i++) {
                    const c = ring[i];
                    const d = ring[i + 1];
                    const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
                    if (Math.abs(den) < 1e-18) continue;
                    const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
                    const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
                    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] } });
                    }
                }
                return { type: 'FeatureCollection', features };
            },
            nearestPointOnLine: (line, pt) => {
                const [a, b] = coordsOf(line);
                const p = pt.geometry.coordinates;
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
                return { type: 'Feature', properties: { location: t * Math.hypot(dx, dy) * SCALE }, geometry: { type: 'Point', coordinates: [a[0] + t * dx, a[1] + t * dy] } };
            },
            booleanPointInPolygon: (pt, zone) => {
                const p = pt.geometry.coordinates;
                const ring = zone.geometry.coordinates[0];
                let inside = false;
                for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
                    const xi = ring[i][0];
                    const yi = ring[i][1];
                    const xj = ring[j][0];
                    const yj = ring[j][1];
                    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
                }
                return inside;
            }
        };
    }

    function squareBuilding(id, lngMin, lngMax, latMin = -0.0001, latMax = 0.0001) {
        return {
            id,
            feature: {
                type: 'Feature',
                properties: { id },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[lngMin, latMin], [lngMax, latMin], [lngMax, latMax], [lngMin, latMax], [lngMin, latMin]]]
                }
            }
        };
    }

    const edgeFrom = { lat: 0, lng: 0 };
    const edgeTo = { lat: 0, lng: 0.001 }; // 100 m in the fake world

    it('splits the edge at the facades and tunnels only the inside part', () => {
        const hit = squareBuilding('b1', 0.0004, 0.0006);
        const plan = clipCorridorEdgeThroughBuildings(edgeFrom, edgeTo, [hit], 0, planarTurf());
        expect(plan).toHaveLength(3);
        expect(plan.map(sub => sub.inside)).toEqual([false, true, false]);
        expect(plan[0].from).toEqual(edgeFrom); // endpoints preserved exactly
        expect(plan[2].to).toEqual(edgeTo);
        expect(plan[1].from.lng).toBeCloseTo(0.0004, 6);
        expect(plan[1].to.lng).toBeCloseTo(0.0006, 6);
        expect(plan[1].hits).toEqual([hit]);
    });

    it('handles several buildings on one edge as separate tunnels', () => {
        const first = squareBuilding('b1', 0.0002, 0.0003);
        const second = squareBuilding('b2', 0.0006, 0.0008);
        const plan = clipCorridorEdgeThroughBuildings(edgeFrom, edgeTo, [first, second], 0, planarTurf());
        expect(plan.map(sub => sub.inside)).toEqual([false, true, false, true, false]);
        expect(plan[1].hits).toEqual([first]);
        expect(plan[3].hits).toEqual([second]);
    });

    it('returns null when the centerline never enters a footprint', () => {
        const grazing = squareBuilding('b1', 0.0004, 0.0006, 0.0002, 0.0004); // beside the line
        expect(clipCorridorEdgeThroughBuildings(edgeFrom, edgeTo, [grazing], 0, planarTurf())).toBeNull();
    });
});

// Partial demolition: a building straddling the demolition region loses only the inside part.
describe('splitDemolitionFootprint', () => {
    const { splitDemolitionFootprint } = require('../../frontend/js/corridor-tunnel.js');

    // Planar fake turf: degrees ARE metres here, so areas come out in "square metres".
    function planarAreaTurf() {
        const ringArea = ring => {
            let sum = 0;
            for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            return Math.abs(sum / 2);
        };
        return {
            intersect: (a, b) => {
                // Axis-aligned rectangle intersection is enough for these fixtures.
                const bbox = f => {
                    const ring = f.geometry.coordinates[0];
                    const xs = ring.map(c => c[0]);
                    const ys = ring.map(c => c[1]);
                    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
                };
                const [ax1, ay1, ax2, ay2] = bbox(a);
                const [bx1, by1, bx2, by2] = bbox(b);
                const x1 = Math.max(ax1, bx1), y1 = Math.max(ay1, by1);
                const x2 = Math.min(ax2, bx2), y2 = Math.min(ay2, by2);
                if (x2 <= x1 || y2 <= y1) return null;
                return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]] } };
            },
            difference: (a, b) => {
                // Fixtures cut a rectangle by a half-plane rectangle: remainder is the leftover box.
                const inter = planarAreaTurf().intersect(a, b);
                if (!inter) return a;
                const ringA = a.geometry.coordinates[0];
                const ringI = inter.geometry.coordinates[0];
                const [ax1, ay1, ax2, ay2] = [Math.min(...ringA.map(c => c[0])), Math.min(...ringA.map(c => c[1])), Math.max(...ringA.map(c => c[0])), Math.max(...ringA.map(c => c[1]))];
                const [ix1, , ix2] = [Math.min(...ringI.map(c => c[0])), 0, Math.max(...ringI.map(c => c[0]))];
                if (ix1 <= ax1 && ix2 >= ax2) return null; // fully consumed
                const [rx1, rx2] = ix1 > ax1 ? [ax1, ix1] : [ix2, ax2];
                return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[rx1, ay1], [rx2, ay1], [rx2, ay2], [rx1, ay2], [rx1, ay1]]] } };
            },
            area: f => ringArea(f.geometry.coordinates[0])
        };
    }

    const box = (x1, y1, x2, y2) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]] } });

    it('splits a straddling building into demolished part and remainder', () => {
        const building = box(0, 0, 20, 10);   // 200 m²
        const region = box(10, -5, 40, 15);   // covers the right half (100 m²)
        const split = splitDemolitionFootprint(building, region, planarAreaTurf());
        expect(split.full).toBe(false);
        expect(split.demolishedPart).toBeTruthy();
        expect(split.remainder).toBeTruthy();
    });

    it('demolishes fully when the remainder is a sliver', () => {
        const building = box(0, 0, 20, 10);
        const region = box(1, -5, 40, 15);    // leaves a 1 m strip (10 m² < max(10, 15%*200)=30)
        const split = splitDemolitionFootprint(building, region, planarAreaTurf());
        expect(split.full).toBe(true);
    });

    it('ignores a barely-touched building', () => {
        const building = box(0, 0, 20, 10);
        const region = box(19.9, 9.8, 40, 15); // clip ~0.02 m² < 2 m²
        expect(splitDemolitionFootprint(building, region, planarAreaTurf())).toBeNull();
    });
});
