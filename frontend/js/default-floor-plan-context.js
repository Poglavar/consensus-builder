// Context for suggested default floor plans in the 3D view: cuts a proposed building into its parcel
// slices (one parcel, one building) and compound slices into wings, collects the footprints it shares
// walls with, picks the entrance side (the longer side, the one nearer a road), finds the facades that
// must stay blind near the parcel boundary, derives storeys from the drawn height, chooses rule presets
// by region and era, and runs default-floor-plans.js once per wing behind a key cache. Pure: turf, the
// generator, parcels, roads and existing footprints are all injected, so node tests drive it without a
// browser, and every data source is optional.
(function (global) {
    'use strict';

    const STREET_CELL_DEG = 0.005;        // about 550 × 390 m at Zagreb: one /streets/near call per cell
    const STREET_CELL_MARGIN_DEG = 0.001; // about 100 m past the cell, so a street beside its edge answers too
    const COVERAGE_MIN = 0.95;            // slices covering less than this do not describe the building (createBuildingSlices rule)
    const NEIGHBOUR_PAD_DEG = 0.00002;    // about 2 m: a touching footprint's bbox overlaps within this
    const WING_FILL_MAX = 0.8;            // a footprint filling less of its bounding rectangle is compound (L, U, ring)
    const WING_MIN_M2 = 25;               // a cut piece smaller than this is a sliver, not a wing
    const WING_CORNER_MIN_EDGE_M = 4;     // both edges at a reflex corner must be real walls, not a stair bump-out
    const CACHE_MAX = 2000;

    // FNV-1a, as urban-rule-variation.js uses for seeds: stable across reloads and node.
    function hashText(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16);
    }
    const geometryHash = feature => hashText(JSON.stringify(feature && feature.geometry ? feature.geometry.coordinates : null));
    function bboxOf(feature, turf) { try { return turf.bbox(feature); } catch (_) { return null; } }
    function areaOf(feature, turf) { try { return turf.area(feature); } catch (_) { return 0; } }
    const bboxesOverlap = (a, b, pad = 0) => !(b[2] < a[0] - pad || b[0] > a[2] + pad || b[3] < a[1] - pad || b[1] > a[3] + pad);
    const asFeature = geometry => ({ type: 'Feature', properties: {}, geometry });
    const polygonsOf = feature => { const g = feature && feature.type === 'Feature' ? feature.geometry : feature; if (!g) return []; return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; };

    // Ground metres about an anchor, affine in lng/lat: the frame the generator itself uses.
    const M_PER_DEG = Math.PI * 6378137 / 180;
    function makeFrame(anchorLng, anchorLat) {
        const mx = M_PER_DEG * Math.cos(anchorLat * Math.PI / 180);
        return {
            toMeters: ([lng, lat]) => [(lng - anchorLng) * mx, (lat - anchorLat) * M_PER_DEG],
            toDegrees: ([x, y]) => [anchorLng + x / mx, anchorLat + y / M_PER_DEG]
        };
    }
    const vec = (a, b) => [b[0] - a[0], b[1] - a[1]];
    const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
    const len = d => Math.hypot(d[0], d[1]);
    const unit = d => { const l = len(d); return [d[0] / l, d[1] / l]; };
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    function ringArea(ring) {
        let twice = 0;
        for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; twice += p[0] * q[1] - q[0] * p[1]; }
        return twice / 2;
    }
    function cleanRing(ring, eps) {
        const out = [];
        for (const p of ring) { const prev = out[out.length - 1]; if (prev && len(vec(prev, p)) < eps) continue; out.push([p[0], p[1]]); }
        while (out.length > 1 && len(vec(out[0], out[out.length - 1])) < eps) out.pop();
        return out;
    }

    function parcelIdOf(parcel) {
        const p = (parcel && parcel.properties) || {};
        const id = p.parcelId ?? p.parcel_id ?? p.id ?? parcel.id;
        return id === undefined || id === null || id === '' ? null : String(id);
    }

    // The exterior ring of the largest polygon, the ring entrances and party walls are decided on.
    function outerRing(feature, turf) {
        const g = feature && feature.geometry;
        if (!g) return null;
        let best = null, bestArea = -Infinity;
        for (const rings of polygonsOf(g)) {
            const area = areaOf(turf.polygon([rings[0]]), turf);
            if (area > bestArea) { bestArea = area; best = rings[0]; }
        }
        return best;
    }

    /**
     * Cut one building into its parcel slices. Mirrors createBuildingSlices in three-mode.js: a slice is
     * the intersection with a parcel; when the slices do not cover the building it stays one piece.
     */
    function sliceBuildingByParcels(building, parcels, turf) {
        const bbox = bboxOf(building, turf);
        if (!bbox) return [];
        const whole = [{ footprint: asFeature(building.geometry), parcelFeature: null, parcelId: null, unsliced: true }];
        const total = areaOf(building, turf);
        const slices = [];
        let covered = 0;
        for (const parcel of parcels || []) {
            if (!parcel || !parcel.geometry) continue;
            const parcelBbox = bboxOf(parcel, turf);
            if (!parcelBbox || !bboxesOverlap(bbox, parcelBbox)) continue;
            let piece = null;
            try { piece = turf.intersect(building, parcel); } catch (_) { piece = null; }
            if (!piece || !piece.geometry) continue;
            const area = areaOf(piece, turf);
            if (area < 1) continue;
            covered += area;
            let centre = [0, 0];
            try { centre = turf.centroid(piece).geometry.coordinates; } catch (_) { }
            slices.push({ footprint: asFeature(piece.geometry), parcelFeature: parcel, parcelId: parcelIdOf(parcel), centre });
        }
        if (!slices.length || !(total > 0) || covered / total < COVERAGE_MIN) return whole;
        slices.sort((a, b) => (a.centre[0] - b.centre[0]) || (a.centre[1] - b.centre[1]));
        return slices.map(({ centre, ...slice }) => slice);
    }

    // The smallest bounding rectangle aligned with one of the ring's edges: its long axis is the
    // building's direction, its aspect says whether the building has a longer side at all.
    function longAxisOf(points) {
        let best = null;
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            const length = len(vec(a, b));
            if (length < 1e-6) continue;
            const d = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            for (const p of points) {
                const u = p[0] * d[0] + p[1] * d[1], v = -p[0] * d[1] + p[1] * d[0];
                u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
            }
            const w = u1 - u0, h = v1 - v0;
            if (!best || w * h < best.area - 1e-9) best = { area: w * h, axis: w >= h ? d : [-d[1], d[0]], aspect: Math.max(w, h) / Math.max(1e-9, Math.min(w, h)) };
        }
        return best;
    }

    /**
     * Split a compound footprint (L, U, ring) into bar-like wings along the bisectors of its inside
     * corners and of its courtyard corners, so each wing gets its own entrance side and cores. A
     * footprint that fills most of its bounding rectangle is one wing. Wings are WGS84 features;
     * pieces under WING_MIN_M2 are dropped and reported.
     * @returns {{ wings: Feature[], dropped: number }}
     */
    function decomposeIntoWings(footprint, turf) {
        const polygons = polygonsOf(footprint);
        if (polygons.length !== 1) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
        const ringLngLat = polygons[0][0];
        const frame = makeFrame(ringLngLat[0][0], ringLngLat[0][1]);
        let outer = cleanRing(ringLngLat.map(frame.toMeters), 0.02);
        if (outer.length < 4) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
        if (ringArea(outer) < 0) outer = outer.slice().reverse();
        const holes = polygons[0].slice(1).map(ring => cleanRing(ring.map(frame.toMeters), 0.02)).filter(ring => ring.length >= 3);
        const area = Math.abs(ringArea(outer)) - holes.reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
        const box = longAxisOf(outer);
        // A courtyard always makes wings; a solid footprint only when it fills little of its rectangle.
        if (!box || (!holes.length && area / box.area >= WING_FILL_MAX)) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
        const metricPolygon = turf.polygon([[...outer, outer[0]], ...holes.map(ring => [...ring, ring[0]])]);
        const reach = 2 * Math.sqrt(box.area);
        const cuts = [];
        const cutFrom = (p, direction) => {
            // Walk the bisector from just inside the corner until the solid ends.
            const ray = turf.lineString([add(p, direction, 0.05), add(p, direction, reach)]);
            let nearest = null;
            try {
                for (const hit of turf.lineIntersect(ray, metricPolygon).features) {
                    const distance = len(vec(p, hit.geometry.coordinates));
                    if (distance > 0.1 && (!nearest || distance < nearest.distance)) nearest = { distance, point: hit.geometry.coordinates };
                }
            } catch (_) { nearest = null; }
            if (!nearest) return;
            const q = nearest.point, d = unit(vec(p, q)), n = [-d[1], d[0]];
            const a = add(p, d, -0.05), b = add(q, d, 0.05);
            cuts.push(turf.polygon([[add(a, n, 0.02), add(b, n, 0.02), add(b, n, -0.02), add(a, n, -0.02), add(a, n, 0.02)]]));
        };
        for (let i = 0; i < outer.length; i++) {
            const prev = outer[(i + outer.length - 1) % outer.length], p = outer[i], next = outer[(i + 1) % outer.length];
            const d1 = unit(vec(prev, p)), d2 = unit(vec(p, next));
            if (cross(d1, d2) >= -1e-9) continue; // a left turn on a counter-clockwise ring is a convex corner
            if (len(vec(prev, p)) < WING_CORNER_MIN_EDGE_M || len(vec(p, next)) < WING_CORNER_MIN_EDGE_M) continue;
            const bisector = unit([-(-d1[0] + d2[0]), -(-d1[1] + d2[1])]); // the inside-angle bisector of a reflex corner
            cutFrom(p, bisector);
        }
        for (const ring of holes) {
            const centroid = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
            for (let i = 0; i < ring.length; i++) {
                const prev = ring[(i + ring.length - 1) % ring.length], p = ring[i], next = ring[(i + 1) % ring.length];
                if (len(vec(prev, p)) < 2 || len(vec(p, next)) < 2) continue;
                const d1 = unit(vec(prev, p)), d2 = unit(vec(p, next));
                let bisector = [-d1[0] + d2[0], -d1[1] + d2[1]];
                if (len(bisector) < 1e-6) continue;
                bisector = unit(bisector);
                // Away from the courtyard, into the solid.
                if ((p[0] - centroid[0]) * bisector[0] + (p[1] - centroid[1]) * bisector[1] < 0) bisector = [-bisector[0], -bisector[1]];
                cutFrom(p, bisector);
            }
        }
        if (!cuts.length) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
        let remainder = metricPolygon;
        for (const cut of cuts) { try { const next = turf.difference(remainder, cut); if (next && next.geometry) remainder = next; } catch (_) { } }
        const pieces = polygonsOf(remainder).map(rings => turf.polygon(rings));
        const wings = [], sizes = pieces.map(piece => Math.abs(ringArea(piece.geometry.coordinates[0])));
        let dropped = 0;
        pieces.forEach((piece, index) => {
            if (sizes[index] < WING_MIN_M2) { dropped++; return; }
            wings.push(asFeature({ type: 'Polygon', coordinates: piece.geometry.coordinates.map(ring => ring.map(frame.toDegrees)) }));
        });
        return wings.length ? { wings, dropped } : { wings: [asFeature(footprint.geometry)], dropped: 0 };
    }

    /**
     * Storeys and storey height of a drawn building. Declared storeys win; otherwise the height is
     * divided by the rule's storey height (or the shared default), and the floors then share the
     * exact drawn height so the modelled floors end where the volume ends.
     */
    function storeysOf(featureOrProps, heightM, fallbackStoreyM) {
        const p = featureOrProps && featureOrProps.properties ? featureOrProps.properties : (featureOrProps || {});
        const declared = [p.storeys, p.floors, p.levels, p.stories, p['building:levels']].map(Number).find(n => Number.isFinite(n) && n > 0);
        const ruleStorey = Number(p.urbanRule && p.urbanRule.floorHeightM);
        const unitM = Number.isFinite(ruleStorey) && ruleStorey > 0 ? ruleStorey : (Number.isFinite(fallbackStoreyM) && fallbackStoreyM > 0 ? fallbackStoreyM : 3.3);
        const height = Number.isFinite(heightM) && heightM > 0 ? heightM : null;
        const floors = declared ? Math.max(1, Math.round(declared)) : height ? Math.max(1, Math.round(height / unitM)) : null;
        if (!floors) return { floors: null, storeyHeightM: unitM };
        return { floors, storeyHeightM: height ? height / floors : unitM };
    }

    // Road geometry as runs of metric points: centrelines as they are, road areas by their outlines.
    function roadRunsOf(feature, frame) {
        const g = feature && feature.type === 'Feature' ? feature.geometry : feature;
        if (!g) return [];
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates
            : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
        return lines.filter(Array.isArray).map(line => line.map(p => frame.toMeters(p)));
    }
    function nearestRoadPoint(point, roads, frame) {
        let nearest = null;
        for (const road of roads) {
            for (const run of roadRunsOf(road, frame)) {
                for (let i = 0; i < run.length - 1; i++) {
                    const p = run[i], q = run[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], len2 = dx * dx + dy * dy;
                    if (!(len2 > 0)) continue;
                    const k = Math.max(0, Math.min(1, ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / len2));
                    const c = [p[0] + k * dx, p[1] + k * dy];
                    const distance = Math.hypot(c[0] - point[0], c[1] - point[1]);
                    if (!nearest || distance < nearest.distance) nearest = { distance, point: c, road };
                }
            }
        }
        return nearest;
    }

    // The ring's edges in metres, with outward normals and party-wall flags against the neighbours.
    function edgesOf(ring, frame, neighbours, turf) {
        const points = ring.slice(0, -1).map(frame.toMeters);
        const signedArea = ringArea(points);
        const outwardSign = signedArea >= 0 ? 1 : -1; // counter-clockwise: interior on the left, outward on the right
        return points.map((a, i) => {
            const b = points[(i + 1) % points.length];
            const lengthM = len(vec(a, b));
            if (lengthM < 0.5) return null;
            const d = unit(vec(a, b));
            const outward = [d[1] * outwardSign, -d[0] * outwardSign];
            const mid = add(a, vec(a, b), 0.5);
            const probe = turf.point(frame.toDegrees(add(mid, outward, 0.35)));
            const party = (neighbours || []).some(neighbour => { try { return turf.booleanPointInPolygon(probe, neighbour); } catch (_) { return false; } });
            return { index: i, a: ring[i].slice(0, 2), b: ring[i + 1].slice(0, 2), aM: a, bM: b, d, outward, mid, lengthM, party };
        }).filter(Boolean);
    }

    /**
     * The entrance side of a slice, as the endpoints of one of its edges. Entrances belong on the
     * building's LONGER side: of the exterior edges running along the long axis, the one facing the
     * nearer road wins, at any distance. A road only breaks that tie, because many entrances open
     * onto service drives rather than the street; a road behind a facade never makes it a front. A
     * near-square footprint takes whichever exterior edge faces the nearest road. Party walls never
     * host an entrance. Without road data the longest eligible edge is the front. Roads may be street
     * centrelines, applied corridors or road parcels: anything with LineString or Polygon geometry.
     */
    function resolveFront(slice, roads, deps) {
        const turf = deps && deps.turf, neighbours = (deps && deps.neighbours) || [];
        if (!turf) return null;
        const ring = outerRing(slice, turf);
        if (!ring || ring.length < 4) return null;
        const frame = makeFrame(ring[0][0], ring[0][1]);
        const edges = edgesOf(ring, frame, neighbours, turf);
        const exterior = edges.filter(edge => !edge.party && edge.lengthM >= 2);
        if (!exterior.length) return null;
        const box = longAxisOf(edges.map(edge => edge.aM));
        const alongAxis = box && box.aspect >= 1.15
            ? exterior.filter(edge => Math.abs(edge.d[0] * box.axis[0] + edge.d[1] * box.axis[1]) >= Math.cos(30 * Math.PI / 180)) : [];
        const candidates = alongAxis.length ? alongAxis : exterior;
        const longest = candidates.reduce((best, edge) => (edge.lengthM > best.lengthM ? edge : best), candidates[0]);
        const fallback = { a: longest.a, b: longest.b, basis: 'longest', street: null, distanceM: null };
        const roadList = Array.isArray(roads) ? roads.filter(Boolean) : [];
        if (!roadList.length) return fallback;
        let best = null;
        for (const edge of candidates) {
            const nearest = nearestRoadPoint(edge.mid, roadList, frame);
            if (!nearest) continue;
            const facing = (nearest.point[0] - edge.mid[0]) * edge.outward[0] + (nearest.point[1] - edge.mid[1]) * edge.outward[1] > 0;
            // Only a road in front of the facade counts; among equals the longer facade wins.
            const score = (facing ? nearest.distance : 1e4 + nearest.distance) - edge.lengthM * 1e-3;
            if (!best || score < best.score) best = { edge, score, nearest, facing };
        }
        if (!best || !best.facing) return fallback;
        const props = (best.nearest.road && best.nearest.road.properties) || {};
        return { a: best.edge.a, b: best.edge.b, basis: 'street', distanceM: Math.round(best.nearest.distance * 10) / 10,
            street: { name: props.name || props.street_name || props.title || null, highway: props.highway_type || props.highway || null, id: props.osm_id ?? props.street_id ?? props.proposalId ?? null } };
    }

    /**
     * Facades that must stay blind: those whose outside, at the regulation setback, already lies
     * beyond the parcel boundary and not on a road. The entrance facade is never blind. Without a
     * parcel nothing is blind.
     * @returns {[{a, b}]}
     */
    function blindEdgesFor(slice, parcel, roads, front, deps) {
        const turf = deps && deps.turf, setbackM = (deps && deps.setbackM) || 3;
        if (!turf || !parcel || !parcel.geometry) return [];
        const ring = outerRing(slice, turf);
        if (!ring || ring.length < 4) return [];
        const frame = makeFrame(ring[0][0], ring[0][1]);
        const frontMid = front ? add(frame.toMeters(front.a), vec(frame.toMeters(front.a), frame.toMeters(front.b)), 0.5) : null;
        const roadList = Array.isArray(roads) ? roads.filter(Boolean) : [];
        return edgesOf(ring, frame, [], turf).filter(edge => {
            if (frontMid && len(vec(edge.mid, frontMid)) < 0.5) return false;
            const outside = add(edge.mid, edge.outward, setbackM);
            let insideParcel = false;
            try { insideParcel = turf.booleanPointInPolygon(turf.point(frame.toDegrees(outside)), parcel); } catch (_) { insideParcel = true; }
            if (insideParcel) return false;
            // Across the boundary lies a road: that is a street facade, not a neighbour's wall.
            const nearRoad = nearestRoadPoint(add(edge.mid, edge.outward, 1.0), roadList, frame);
            if (nearRoad && nearRoad.distance <= setbackM) return false;
            for (const road of roadList) {
                if (polygonsOf(road).length) { try { if (turf.booleanPointInPolygon(turf.point(frame.toDegrees(outside)), road)) return false; } catch (_) { } }
            }
            return true;
        }).map(edge => ({ a: edge.a, b: edge.b }));
    }

    const sameBuilding = (a, b) => {
        const pa = (a && a.properties) || {}, pb = (b && b.properties) || {};
        return pa.proposalId !== undefined && pa.proposalId !== null && String(pa.proposalId) === String(pb.proposalId)
            && pa.buildingIndex !== undefined && pa.buildingIndex === pb.buildingIndex;
    };

    /**
     * Footprints a building may share a wall with: the other proposed buildings around it and the
     * existing footprints that touch it without overlapping it (an overlapped one is being replaced).
     */
    function neighbourPool(owner, proposed, existing, turf) {
        const bbox = bboxOf(owner, turf);
        if (!bbox) return [];
        const out = [];
        for (const feature of Array.isArray(proposed) ? proposed : []) {
            if (!feature || feature === owner || !feature.geometry || sameBuilding(feature, owner)) continue;
            const b = bboxOf(feature, turf);
            if (b && bboxesOverlap(bbox, b, NEIGHBOUR_PAD_DEG)) out.push(feature);
        }
        for (const feature of Array.isArray(existing) ? existing : []) {
            if (!feature || feature === owner || !feature.geometry) continue;
            const b = bboxOf(feature, turf);
            if (!b || !bboxesOverlap(bbox, b, NEIGHBOUR_PAD_DEG)) continue;
            let overlap = null;
            try { overlap = turf.intersect(owner, feature); } catch (_) { overlap = null; }
            if (overlap && areaOf(overlap, turf) > 1) continue;
            out.push(feature);
        }
        return out;
    }

    function streetCellKey(feature, turf) {
        const b = bboxOf(feature, turf);
        if (!b) return null;
        return `${Math.floor((b[0] + b[2]) / 2 / STREET_CELL_DEG)}:${Math.floor((b[1] + b[3]) / 2 / STREET_CELL_DEG)}`;
    }
    function streetCellBbox(key) {
        const [i, j] = String(key).split(':').map(Number);
        const r = value => Math.round(value * 1e6) / 1e6;
        return [r(i * STREET_CELL_DEG - STREET_CELL_MARGIN_DEG), r(j * STREET_CELL_DEG - STREET_CELL_MARGIN_DEG),
            r((i + 1) * STREET_CELL_DEG + STREET_CELL_MARGIN_DEG), r((j + 1) * STREET_CELL_DEG + STREET_CELL_MARGIN_DEG)];
    }

    // The regulation region of a city, from the locale its configuration already carries ('hr-HR').
    function regionOf(cityConfig) {
        const locale = cityConfig && cityConfig.currency && cityConfig.currency.locale;
        const match = typeof locale === 'string' && locale.match(/[-_]([A-Za-z]{2})$/);
        return match ? match[1].toUpperCase() : null;
    }

    /**
     * Rule overrides for an existing building by era, from whatever its properties say (a year, or
     * the storey height as a proxy): a pre-war block has no lift and larger flats, a post-war slab
     * keeps the default point-access scheme without a lift up to five storeys, anything newer uses
     * the defaults. Nothing here needs more than the footprint and a height.
     */
    function eraRulesFor(featureOrProps, storeyHeightM, floors) {
        const p = featureOrProps && featureOrProps.properties ? featureOrProps.properties : (featureOrProps || {});
        const year = [p.year, p.yearBuilt, p.year_built, p.start_date, p.built, p.construction_year].map(value => parseInt(String(value || '').slice(0, 4), 10)).find(n => Number.isFinite(n) && n > 1500);
        const era = year ? (year < 1945 ? 'prewar' : year < 1990 ? 'postwar' : 'contemporary')
            : storeyHeightM >= 3.4 ? 'prewar' : storeyHeightM <= 3.05 && floors >= 4 ? 'postwar' : 'contemporary';
        const byEra = {
            prewar: { era, liftPolicy: 'never', maxApartmentM2: 160, balconies: false, garage: 'never', groundFloorUse: floors >= 3 ? 'commercial' : 'residential' },
            postwar: { era, liftFromFloors: 6, garage: 'never', groundFloorUse: 'residential' },
            contemporary: { era }
        };
        return byEra[era];
    }

    /**
     * Plan every parcel slice and wing of one drawn building.
     * @param subject the feature being drawn (the realized build-out, or the massing)
     * @param context { turf, generator, parcels, neighbours, roads|null, heightM, storeyFallbackM, region?, cache?, rules?, owner?, existing? }
     * @returns {{ floors, storeyHeightM, slices: [{ footprint, parcelFeature, parcelId, wing, key, result }], droppedWings }}
     */
    function planBuilding(subject, context) {
        const { turf, generator, parcels, neighbours, roads, heightM, storeyFallbackM, cache, owner } = context;
        if (!turf || !generator) throw new Error('default-floor-plan-context: turf and the generator are required');
        const slices = context.existing ? [{ footprint: asFeature(subject.geometry), parcelFeature: null, parcelId: null, unsliced: true }]
            : sliceBuildingByParcels(subject, parcels, turf);
        const { floors, storeyHeightM } = storeysOf(subject, heightM, storeyFallbackM);
        const ownerProps = ((owner || subject).properties) || {};
        const baseId = context.existing ? `existing/${ownerProps.object_id ?? ownerProps.id ?? ownerProps.osm_id ?? geometryHash(subject)}`
            : `${ownerProps.proposalId ?? 'local'}/${ownerProps.buildingIndex ?? 0}`;
        const typology = ownerProps.urbanRule && ownerProps.urbanRule.typology ? String(ownerProps.urbanRule.typology) : (ownerProps.typology || undefined);
        const around = Array.isArray(neighbours) ? neighbours : [];
        const aroundHash = hashText(around.map(geometryHash).join(','));
        const rules = { ...(context.region ? { region: context.region } : {}), ...(context.existing && floors ? eraRulesFor(subject, storeyHeightM, floors) : {}), ...(context.rules || {}) };
        const rulesHash = hashText(JSON.stringify(rules));
        // Wings of every slice are planned as separate buildings; the other wings are their party neighbours.
        const units = [];
        let droppedWings = 0;
        slices.forEach((slice, index) => {
            const { wings, dropped } = decomposeIntoWings(slice.footprint, turf);
            droppedWings += dropped;
            wings.forEach((wing, wingIndex) => units.push({ ...slice, footprint: wing, sliceIndex: index, wing: wings.length > 1 ? wingIndex : null }));
        });
        const footprints = units.map(unit => unit.footprint);
        const results = units.map((unit, index) => {
            const siblings = footprints.filter((_, i) => i !== index);
            const nearby = [...siblings, ...around];
            const front = roads ? resolveFront(unit.footprint, roads, { turf, neighbours: nearby }) : null;
            const setbackM = (rules.blindFacadeSetbackM) || (generator.DEFAULT_RULES && generator.DEFAULT_RULES.blindFacadeSetbackM) || 3;
            const blindEdges = blindEdgesFor(unit.footprint, unit.parcelFeature, roads, front, { turf, setbackM });
            const key = [baseId, unit.sliceIndex, unit.wing ?? '-', geometryHash(unit.footprint), floors, Math.round(storeyHeightM * 1000),
                front ? `${front.basis}:${front.a.join(',')}:${front.b.join(',')}` : 'nofront', blindEdges.length, aroundHash, rulesHash, typology || ''].join('|');
            let result = cache ? cache.get(key) : null;
            if (!result) {
                result = generator.planDefaultFloorPlans({ footprint: unit.footprint, floors, storeyHeightM, neighbours: nearby, front, blindEdges, typology,
                    buildingId: `${baseId}/${unit.sliceIndex}${unit.wing !== null && unit.wing !== undefined ? `/w${unit.wing}` : ''}` }, { turf, rules });
                if (cache) {
                    if (cache.size >= CACHE_MAX) cache.clear();
                    cache.set(key, result);
                }
            }
            return { ...unit, key, result };
        });
        return { floors, storeyHeightM, slices: results, droppedWings };
    }

    const api = { STREET_CELL_DEG, hashText, sliceBuildingByParcels, decomposeIntoWings, storeysOf, resolveFront, blindEdgesFor, neighbourPool,
        streetCellKey, streetCellBbox, regionOf, eraRulesFor, planBuilding };
    global.__defaultFloorPlanContext = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
