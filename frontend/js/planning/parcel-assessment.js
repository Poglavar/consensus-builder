// Bounded parcel studies: direct source values (feet or metres) constrain geometry; estimates and
// applicability stay unresolved. All derived limits are metres.
// This pure module is shared by the browser and API and never applies or publishes a proposal.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningParcelAssessment = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const FT = 0.3048, ACRE = 4046.8564224, R = 6371008.8, RAD = Math.PI / 180;
    // Source units a constraint may carry; a value is read only through its unit's metric factor.
    const LENGTH_M = { m: 1, ft: FT }, AREA_M2 = { m2: 1, acres: ACRE, sqft: 0.09290304 };
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const invalid = message => { throw new Error(message); };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const area = points => Math.abs(points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2);
    function ring(geometry) {
        if (geometry?.type !== 'Polygon' || geometry.coordinates.length !== 1) invalid('unsupported-parcel-shape');
        const points = geometry.coordinates[0];
        if (points.length < 4 || points.length > 501 || points.some(p => !Array.isArray(p) || p.length !== 2
            || !p.every(finite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) >= 85)
            || points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) invalid('unsupported-parcel-shape');
        return points.slice(0, -1);
    }
    function frame(geometry) {
        const coordinates = ring(geometry), origin = coordinates[0], cos = Math.cos(origin[1] * RAD);
        const project = p => [(p[0] - origin[0]) * RAD * R * cos, (p[1] - origin[1]) * RAD * R];
        const unproject = p => [origin[0] + p[0] / (RAD * R * cos), origin[1] + p[1] / (RAD * R)];
        const points = coordinates.map(project);
        if (points.some(p => Math.hypot(...p) > 1000) || area(points) < 1) invalid('unsupported-parcel-shape');
        const signed = points.reduce((sum, p, i) => {
            const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1];
        }, 0);
        const edges = points.map((p, i) => {
            const q = points[(i + 1) % points.length], dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
            // A sub-centimetre edge is a digitising duplicate: it keeps its index and takes no part.
            if (length < 0.01) return { index: i, normal: [0, 0], offset: 0, length, degenerate: true };
            const normal = signed > 0 ? [-dy / length, dx / length] : [dy / length, -dx / length];
            return { index: i, normal, offset: dot(normal, p), length, degenerate: false };
        });
        if (edges.filter(edge => !edge.degenerate).length < 3) invalid('unsupported-parcel-shape');
        // The retained source polygon is unchanged. A centimetre tolerance absorbs collinear digitization
        // noise; a lot with a real inward corner takes the yard-strip derivation instead of half-planes.
        const convex = !edges.some(edge => !edge.degenerate && points.some(p => dot(edge.normal, p) < edge.offset - 0.01));
        const geometryOf = value => ({ type: 'Polygon', coordinates: [[...value, value[0]].map(unproject)] });
        return { points, coordinates, edges, convex, project, geometryOf, areaM2: area(points) };
    }
    // The ground within each yard of its boundary segment: a rectangle of the yard's depth along the
    // edge, extended by the same depth past both ends so an inward corner keeps its pocket clear.
    // Built in the local metre frame, so no curve approximation or buffering library is involved.
    function yardStrips(local, edges, distanceOf) {
        return edges.flatMap(edge => {
            const distance = distanceOf(edge);
            if (distance === null || distance <= 0) return [];
            const p = local.points[edge.index], q = local.points[(edge.index + 1) % local.points.length];
            const t = [(q[0] - p[0]) / edge.length, (q[1] - p[1]) / edge.length], n = edge.normal;
            const a = [p[0] - t[0] * distance, p[1] - t[1] * distance], b = [q[0] + t[0] * distance, q[1] + t[1] * distance];
            return [{ key: `${edge.index}:${distance}`, distance, index: edge.index,
                geometry: local.geometryOf([a, b, [b[0] + n[0] * distance, b[1] + n[1] * distance], [a[0] + n[0] * distance, a[1] + n[1] * distance]]) }];
        });
    }
    // Strips leave one at a time (a clipping pass each), in a fixed order, and each partial
    // result is kept per lot: a height search re-derives the same lot with mostly the same yards,
    // and the shared prefix of the order costs nothing the second time.
    const yardWork = new WeakMap(), YARD_WORK_CAP = 4000;
    function groundBeyondYards(parcel, local, edges, distanceOf, geometryOps) {
        if (!geometryOps) invalid('missing-geometry-operations');
        const strips = yardStrips(local, edges, distanceOf).sort((a, b) => b.distance - a.distance || a.index - b.index);
        let work = yardWork.get(parcel);
        if (!work) yardWork.set(parcel, work = new Map());
        let remaining = geometryOps.feature(parcel), prefix = '';
        for (const strip of strips) {
            prefix += `${strip.key}|`;
            if (work.has(prefix)) { remaining = work.get(prefix); continue; }
            remaining = remaining ? geometryOps.difference(remaining, geometryOps.feature(strip.geometry)) : null;
            if (work.size >= YARD_WORK_CAP) work.clear();
            work.set(prefix, remaining);
        }
        return remaining && geometryOps.area(remaining) > 0.01 ? remaining.geometry : null;
    }
    // Signed clearance of a design from the lot boundary: its nearest vertex, negative when a vertex
    // or any of its ground lies outside the lot.
    function boundaryClearance(parcel, design, geometryOps) {
        const outline = geometryOps.lineString(parcel.coordinates[0]), lot = geometryOps.feature(parcel);
        const vertices = ring(design).map(p => (geometryOps.booleanPointInPolygon(geometryOps.point(p), lot) ? 1 : -1)
            * geometryOps.pointToLineDistance(geometryOps.point(p), outline, { units: 'meters' }));
        const outside = geometryOps.difference(geometryOps.feature(design), lot);
        return Math.min(...vertices, outside && geometryOps.area(outside) > 0.01 ? -0.01 : Infinity);
    }
    // A design's clearance from a role's yard strips, measured the way the strips are built: the
    // depth in front of each edge, over the edge's own span extended by the yard past both ends.
    // Ground behind an edge's line is another lobe of the lot or outside it, never that edge's yard;
    // past an end, only ground in front of the extension counts.
    function stripClearance(local, edges, designPoints, limit) {
        if (limit === null) return Infinity;
        let clearance = Infinity;
        for (const edge of edges) {
            const p0 = local.points[edge.index], q = local.points[(edge.index + 1) % local.points.length];
            const t = [(q[0] - p0[0]) / edge.length, (q[1] - p0[1]) / edge.length];
            for (const p of designPoints) {
                const v = [p[0] - p0[0], p[1] - p0[1]], along = dot(v, t), depth = dot(v, edge.normal);
                // A vertex on a strip's end edge is on the bound's own boundary: clear, like its depth edge.
                if (depth < -0.01 || along < -limit + 0.01 || along > edge.length + limit - 0.01) continue;
                if ((along < -0.01 || along > edge.length + 0.01) && depth <= 0.01) continue;
                clearance = Math.min(clearance, depth);
            }
        }
        return clearance;
    }
    // The outer ring of a bound's largest part, for seeding a design on a concave lot.
    function largestRing(geometry) {
        const rings = (geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]).map(polygon => polygon[0].slice(0, -1));
        return rings.reduce((best, candidate) => area(candidate) > area(best) ? candidate : best);
    }
    function clip(points, normal, offset) {
        const output = [];
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            const da = dot(normal, a) - offset, db = dot(normal, b) - offset;
            if (da >= 0) output.push(a);
            if ((da >= 0) !== (db >= 0)) {
                const t = da / (da - db); output.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
            }
        }
        return output;
    }
    function direct(source, quantity, units) {
        const value = source.constraints?.find(c => c.quantity === quantity && Object.hasOwn(units, c.unit));
        return ['direct', 'literal'].includes(value?.evidence) && finite(value.value) && value.value >= 0 ? value.value * units[value.unit] : null;
    }
    function derive(context, frontEdge = 0, geometryOps) {
        const local = frame(context.parcel.geometry);
        if (!Number.isInteger(frontEdge) || !local.edges[frontEdge]) invalid('invalid-front-edge');
        const front = local.edges[frontEdge];
        if (front.degenerate) invalid('unsupported-parcel-shape');
        // Edges within 25° of the front face the street; edges turned more than 60° away from it face
        // the back; the rest are sides. A lot needs at least one edge that is not a front.
        const edges = local.edges.map(edge => ({ ...edge, role: edge.degenerate ? 'none' : dot(edge.normal, front.normal) > 0.9 ? 'frontSetback'
            : dot(edge.normal, front.normal) < -0.5 ? 'rearSetback' : 'sideSetback' }));
        if (!edges.some(edge => edge.role === 'rearSetback' || edge.role === 'sideSetback')) invalid('unsupported-parcel-shape');
        const limits = Object.fromEntries(['frontSetback', 'sideSetback', 'rearSetback'].map(key => [key, direct(context.source, key, LENGTH_M)]));
        let points = [], geometry = null;
        if (local.convex) {
            points = local.points;
            for (const edge of edges) {
                if (edge.degenerate) continue;
                // An unknown setback contributes no additional clipping; it remains an explicit unknown check.
                const distance = limits[edge.role] === null ? 0 : limits[edge.role];
                points = clip(points, edge.normal, edge.offset + distance);
                if (points.length < 3) break;
            }
            if (points.length < 3 || area(points) <= 0.01) points = [];
            geometry = points.length ? local.geometryOf(points) : null;
        } else {
            // A concave lot keeps the ground farther than each role's yard from its own boundary segments.
            geometry = groundBeyondYards(context.parcel.geometry, local, edges, edge => edge.degenerate ? null : limits[edge.role], geometryOps);
        }
        if (geometry && context.coveredGeometry) {
            if (!geometryOps) invalid('missing-geometry-operations');
            geometry = geometryOps.intersect(geometryOps.feature(geometry), geometryOps.feature(context.coveredGeometry))?.geometry || null;
        }
        return { local, edges, limits, points, geometry,
            heightM: direct(context.source, 'height', LENGTH_M),
            areaM2: geometry ? geometryOps ? geometryOps.area(geometryOps.feature(geometry)) : area(points) : 0, frontEdge };
    }
    function designFromForm(context, form, geometryOps, basis) {
        if (!form || !finite(form.scale) || form.scale < 0.1 || form.scale > 2
            || !finite(form.eastM) || Math.abs(form.eastM) > 100 || !finite(form.northM) || Math.abs(form.northM) > 100
            || !finite(form.heightM) || form.heightM <= 0 || form.heightM > 100) invalid('invalid-study-design');
        const bound = derive(context, form.frontEdge, geometryOps);
        if (!bound.geometry) invalid('empty-supported-bound');
        const seed = basis ? ring(basis).map(bound.local.project) : bound.points.length ? bound.points
            : distinct(largestRing(bound.geometry).map(bound.local.project));
        const center = seed.reduce((sum, p) => [sum[0] + p[0] / seed.length, sum[1] + p[1] / seed.length], [0, 0]);
        const points = seed.map(p => [center[0] + (p[0] - center[0]) * form.scale + form.eastM,
            center[1] + (p[1] - center[1]) * form.scale + form.northM]);
        let geometry = bound.local.geometryOf(points);
        if (!bound.points.length) {
            // Scaling a concave bound about its centre can leave it; keep the sample inside the bound.
            const clipped = geometryOps.intersect(geometryOps.feature(geometry), geometryOps.feature(bound.geometry));
            if (!clipped) invalid('empty-supported-bound');
            geometry = bound.local.geometryOf(distinct(largestRing(clipped.geometry).map(bound.local.project)));
        }
        return { geometry, baseM: 0, topM: form.heightM };
    }
    // Buffer arcs and clips leave near-coincident vertices; a design ring needs distinct corners.
    function distinct(points) {
        const kept = points.filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) >= 0.02);
        if (kept.length > 1 && Math.hypot(kept[0][0] - kept.at(-1)[0], kept[0][1] - kept.at(-1)[1]) < 0.02) kept.pop();
        if (kept.length < 3) invalid('empty-supported-bound');
        return kept;
    }
    // Without street evidence, retain every supported front-edge interpretation. Their union
    // is an outer bound, not a claim that the whole solid can be built or that an edge is verified.
    function unorientedEnvelope(context, geometryOps) {
        let geometry = null, heightM = null;
        const edges = [];
        const local = frame(context.parcel.geometry);
        if (!local.convex) {
            // On a concave lot every edge takes each role in some interpretation, so the joined bound
            // keeps the ground beyond the smallest yard any role assigns; unknown yards clip nothing.
            const limits = Object.fromEntries(['frontSetback', 'sideSetback', 'rearSetback'].map(key => [key, direct(context.source, key, LENGTH_M)]));
            const smallest = Math.min(...Object.values(limits).map(value => value === null ? 0 : value));
            geometry = groundBeyondYards(context.parcel.geometry, local, local.edges, edge => edge.degenerate ? null : smallest, geometryOps);
            if (geometry && context.coveredGeometry) geometry = geometryOps.intersect(geometryOps.feature(geometry), geometryOps.feature(context.coveredGeometry))?.geometry || null;
            const all = local.edges.filter(edge => !edge.degenerate).map(edge => edge.index);
            return { geometry, heightM: direct(context.source, 'height', LENGTH_M), interpretations: all.length, edges: all,
                areaM2: geometry ? geometryOps.area(geometryOps.feature(geometry)) : 0 };
        }
        for (let edge = 0; edge < ring(context.parcel.geometry).length; edge++) {
            let bound;
            try { bound = derive(context, edge, geometryOps); }
            catch (error) { if (error.message === 'unsupported-parcel-shape') continue; throw error; }
            heightM = bound.heightM; edges.push(edge);
            if (bound.geometry) geometry = geometry ? geometryOps.union(geometryOps.feature(geometry),
                geometryOps.feature(bound.geometry)).geometry : bound.geometry;
        }
        if (!edges.length) invalid('unsupported-parcel-shape');
        // `edges` lists the front-edge interpretations the bound joins; a client can redraw any one of them.
        return { geometry, heightM, interpretations: edges.length, edges, areaM2: geometry ? geometryOps.area(geometryOps.feature(geometry)) : 0 };
    }
    function assess(context, design, frontEdge = 0, geometryOps) {
        const bound = derive(context, frontEdge, geometryOps), local = bound.local;
        const points = ring(design.geometry).map(local.project);
        // Validate the design itself before using vertex/half-plane containment.
        frame(design.geometry);
        if (!finite(design.baseM) || design.baseM < 0 || !finite(design.topM) || design.topM <= design.baseM) invalid('invalid-study-design');
        const source = context.source, checks = [];
        const add = (key, measured, limit, unit, comparison = 'minimum', evidence = 'direct', assumption = null) => {
            const status = limit === null ? 'unknown' : comparison === 'minimum' ? measured + 0.01 >= limit ? 'pass' : 'fail'
                : measured <= limit + 0.01 ? 'pass' : 'fail';
            checks.push({ key, status, measured, limit, unit, evidence, assumption });
        };
        add('parcelContainment', local.convex ? Math.min(...local.edges.filter(edge => !edge.degenerate).flatMap(edge => points.map(p => dot(edge.normal, p) - edge.offset)))
            : boundaryClearance(context.parcel.geometry, design.geometry, geometryOps), 0, 'm');
        if (context.coveredGeometry) {
            const outside = geometryOps.difference(geometryOps.feature(design.geometry), geometryOps.feature(context.coveredGeometry));
            const missingM2 = outside ? geometryOps.area(outside) : 0;
            checks.push({ key: 'zoningCoverage', status: missingM2 <= 0.01 ? 'pass' : 'unknown', measured: missingM2, limit: 0, unit: 'm2' });
        }
        for (const key of ['frontSetback', 'sideSetback', 'rearSetback']) {
            const roleEdges = bound.edges.filter(edge => edge.role === key);
            const measured = local.convex ? Math.min(...roleEdges.flatMap(edge => points.map(p => dot(edge.normal, p) - edge.offset)))
                : stripClearance(local, roleEdges, points, bound.limits[key]);
            const evidence = source.constraints?.find(c => c.quantity === key)?.evidence
                || source.sourceEvidence?.numericEvidence?.[`${source.source.scenario}_${key === 'frontSetback' ? 'front' : key === 'sideSetback' ? 'side' : 'rear'}setbackft`]?.status || 'absent';
            add(key, measured, bound.limits[key], 'm', 'minimum', evidence, 'edge-assumption');
        }
        add('height', design.topM, bound.heightM, 'm', 'maximum', source.constraints?.find(c => c.quantity === 'height')?.evidence || 'absent', 'vertical-reference');
        add('lotArea', local.areaM2, direct(source, 'lotArea', AREA_M2), 'm2');
        const coverage = source.sourceEvidence?.numericEvidence?.[`${source.source.scenario}_maxlotcoverage_building`];
        add('buildingCoverage', 100 * area(points) / local.areaM2,
            coverage?.status === 'direct' && finite(coverage.value) && coverage.value >= 0 && coverage.value <= 100 ? coverage.value : null,
            'percent', 'maximum', coverage?.status || 'absent', 'measurement-basis');
        checks.push({ key: 'use', status: source.assessment.status === 'prohibited' ? 'fail' : source.assessment.status === 'allowed' ? 'pass' : 'unknown',
            treatment: source.assessment.status || 'unknown', measured: null, limit: null });
        return { schemaVersion: 'planning-parcel-assessment.v1', status: checks.some(check => check.status === 'fail') ? 'breach' : 'unresolved',
            checks, unresolved: ['applicability', 'edge-assumption', 'vertical-reference', 'measurement-basis', 'other-rules',
                ...(context.sourceCoverage?.uncoveredM2 > 0.01 ? ['partial-source-coverage'] : [])],
            envelope: { geometry: bound.geometry, heightM: bound.heightM, areaM2: bound.areaM2, meaning: 'partial-envelope' },
            design: { ...design, footprintM2: area(points) }, parcelAreaM2: local.areaM2 };
    }
    function referenceState(saved, context) {
        if (!saved || ['proposalId', 'providerId', 'recordId', 'city', 'scenario'].some(key => saved.sourceReference?.[key] !== context.sourceReference?.[key])
            || saved.parcelReference?.sourceId !== context.parcelReference?.sourceId
            || saved.parcelReference?.parcelId !== context.parcelReference?.parcelId) return 'different';
        return saved.sourceReference.edition === context.sourceReference.edition
            && saved.sourceReference.revision === context.sourceReference.revision
            && saved.parcelReference.revision === context.parcelReference.revision ? 'same' : 'changed';
    }
    // Whether a lot outline is one the evaluator can frame, without deriving anything.
    function inspect(geometry) {
        const local = frame(geometry);
        return { convex: local.convex, edges: local.edges.filter(edge => !edge.degenerate).length, areaM2: local.areaM2 };
    }
    return { derive, unorientedEnvelope, assess, designFromForm, referenceState, inspect };
});
