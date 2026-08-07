// Pure formation stamping rules. Real turf drives the injected geometry context.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const fe = require('../../frontend/js/proposals/formation-edit.js');

const ctx = {
    area: f => turf.area(f),
    intersectionArea: (a, b) => {
        const hit = turf.intersect(a, b);
        return hit ? turf.area(hit) : 0;
    },
    difference: (a, b) => turf.difference(a, b)
};

// Axis-aligned lon/lat rectangle around Zagreb (~45.8N): 0.00001° lon ≈ 0.78 m, lat ≈ 1.11 m.
function rect(lonMin, latMin, lonMax, latMax) {
    return {
        type: 'Feature', properties: {}, geometry: {
            type: 'Polygon',
            coordinates: [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]]
        }
    };
}

const LON = 15.96, LAT = 45.80;
// ~78 m × ~111 m block
const block = (dx0, dy0, dx1, dy1) => rect(LON + dx0 * 1e-3, LAT + dy0 * 1e-3, LON + dx1 * 1e-3, LAT + dy1 * 1e-3);

describe('baseIdOf', () => {
    it('strips derivation suffixes to the cadastral root, however deep', () => {
        expect(fe.baseIdOf('HR-339270-823/1')).toBe('HR-339270-823/1');
        expect(fe.baseIdOf('HR-339270-823/1#c-road-2')).toBe('HR-339270-823/1');
        expect(fe.baseIdOf('HR-339270-823/1#a-1#b-2')).toBe('HR-339270-823/1');
        expect(fe.baseIdOf(null)).toBe('');
    });
});

describe('applyCarriedIdentity', () => {
    it('writes id, number and parsed synthetic fields, once per id', () => {
        const used = new Set();
        const props = {};
        const carried = { parcelId: 'HR-339270-823/1#c-abc-7', parcelNumber: '823/1#c-abc-7' };
        expect(fe.applyCarriedIdentity(props, carried, used)).toBe(true);
        expect(props.parcelId).toBe('HR-339270-823/1#c-abc-7');
        expect(props.BROJ_CESTICE).toBe('823/1#c-abc-7');
        expect(props.syntheticToken).toBe('c-abc');
        expect(props.syntheticIndex).toBe(7);
        // A contiguity split cloned the stamp onto a second part — it must not get the same id.
        expect(fe.applyCarriedIdentity({}, carried, used)).toBe(false);
    });

    it('rejects empty identities', () => {
        expect(fe.applyCarriedIdentity({}, null, new Set())).toBe(false);
        expect(fe.applyCarriedIdentity({}, {}, new Set())).toBe(false);
    });
});

describe('baseIdsOfFeatures', () => {
    it('collects unique base ids from rootParcelId or the id itself, skipping placeholders', () => {
        const ids = fe.baseIdsOfFeatures([
            { properties: { rootParcelId: 'HR-1' } },
            { properties: { parcelId: 'HR-2#c-road-3' } },
            { properties: { rootParcelId: 'HR-1' } },
            { properties: { rootParcelId: 'parcel' } },
            null
        ]);
        expect(ids).toEqual(['HR-1', 'HR-2']);
    });
});

describe('overlappingBaseIds', () => {
    it('anchors a plot to every base parcel actually under it, in parent order', () => {
        // Parents side by side; the plot spans the boundary.
        const parents = [
            { baseId: 'HR-A', feature: block(0, 0, 2, 2) },
            { baseId: 'HR-B', feature: block(2, 0, 4, 2) },
            { baseId: 'HR-C', feature: block(4, 0, 6, 2) }
        ];
        const plot = block(1, 0, 3, 2);
        expect(fe.overlappingBaseIds(plot, parents, ctx)).toEqual(['HR-A', 'HR-B']);
    });

    it('ignores parents that only share a boundary line', () => {
        const parents = [
            { baseId: 'HR-A', feature: block(0, 0, 2, 2) },
            { baseId: 'HR-B', feature: block(2, 0, 4, 2) }
        ];
        const plot = block(0, 0, 2, 2); // exactly HR-A; touches HR-B only along the edge
        expect(fe.overlappingBaseIds(plot, parents, ctx)).toEqual(['HR-A']);
    });
});

describe('wholeParcelTakePlan', () => {
    const parcels = [
        { id: 'HR-A', feature: block(0, 0, 2, 2) },
        { id: 'HR-B', feature: block(2, 0, 4, 2) },
        { id: 'HR-C', feature: block(4, 0, 6, 2) }
    ];

    it('adopts the one parcel matching the footprint', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 2, 2), parcels, ctx);
        expect(plan.mode).toBe('adopt');
        expect(plan.parcelIds).toEqual(['HR-A']);
    });

    it('merge-takes a union of whole parcels', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 4, 2), parcels, ctx);
        expect(plan.mode).toBe('merge');
        expect(plan.parcelIds).toEqual(['HR-A', 'HR-B']);
    });

    it('refuses when the footprint takes only part of some parcel, naming it', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 3, 2), parcels, ctx);
        expect(plan.mode).toBe('refuse');
        expect(plan.reason).toBe('partial-parcels');
        expect(plan.parcelIds).toEqual(['HR-A']);          // whole
        expect(plan.partials.map(p => p.id)).toEqual(['HR-B']); // half-covered
        expect(plan.partials[0].coveredShare).toBeCloseTo(0.5, 1);
    });

    it('refuses when part of the footprint lies on no live parcel', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 2, 3), [parcels[0]], ctx);
        expect(plan.mode).toBe('refuse');
        expect(plan.reason).toBe('uncovered-ground');
    });

    it('ignores parcels that only share a boundary line', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 2, 2), parcels, ctx);
        expect(plan.parcelIds).toEqual(['HR-A']); // HR-B touches only along x=2
    });

    it('tolerates vertex noise on an exact fill (the Borovje case)', () => {
        const noisyFootprint = block(0.000005, 0, 2.000005, 2); // ~0.4 m shift
        const plan = fe.wholeParcelTakePlan(noisyFootprint, parcels, ctx);
        expect(plan.mode).toBe('adopt');
        expect(plan.parcelIds).toEqual(['HR-A']);
    });
});

describe('clipPiecesByTaking / amendReparcellizationPlanByTaking (§15b: the taker amends the taken)', () => {
    // ~78 m × 111 m block; a ~16 m-wide "road" strip crosses its middle horizontally.
    const plot = (lonMin, latMin, lonMax, latMax, owner) =>
        ({ geometry: rect(lonMin, latMin, lonMax, latMax).geometry, ownerKey: owner, displayName: owner });
    const strip = rect(15.9599, 45.80045, 15.9611, 45.80059); // spans full width, middle

    it('splits a crossed plot into two pieces that keep their carry fields', () => {
        const res = fe.clipPiecesByTaking([plot(15.9600, 45.8000, 15.9610, 45.8010, 'ana')], strip, ctx);
        expect(res.changed).toBe(true);
        expect(res.pieces.length).toBe(2);
        expect(res.splitCount).toBe(1);
        res.pieces.forEach(p => expect(p.ownerKey).toBe('ana'));
        const total = res.pieces.reduce((s2, p) => s2 + turf.area({ type: 'Feature', properties: {}, geometry: p.geometry }), 0);
        const before = turf.area(rect(15.9600, 45.8000, 15.9610, 45.8010));
        expect(total).toBeLessThan(before);
        expect(Math.abs(before - total - res.takenAreaM2)).toBeLessThan(2);
    });

    it('removes a fully-taken plot from the plan', () => {
        const inside = plot(15.96005, 45.80047, 15.96015, 45.80057, 'ivo'); // fully inside the strip
        const res = fe.clipPiecesByTaking([inside], strip, ctx);
        expect(res.changed).toBe(true);
        expect(res.pieces.length).toBe(0);
        expect(res.removedCount).toBe(1);
    });

    it('returns untouched pieces by reference (no churn)', () => {
        const far = plot(15.9700, 45.8000, 15.9710, 45.8010, 'far');
        const res = fe.clipPiecesByTaking([far], strip, ctx);
        expect(res.changed).toBe(false);
        expect(res.pieces[0]).toBe(far);
        expect(res.takenAreaM2).toBe(0);
    });

    it('treats a sub-floor graze as rounding, not a taking', () => {
        // Overlaps the strip by a hair along one edge (< 0.5 m²).
        const grazing = plot(15.9600, 45.800590037, 15.9610, 45.8010, 'g');
        const res = fe.clipPiecesByTaking([grazing], strip, ctx);
        expect(res.changed).toBe(false);
        expect(res.pieces[0]).toBe(grazing);
    });

    it('amends a whole readjustment plan: one plot split, one removed, one untouched', () => {
        const plan = { polygons: [
            plot(15.9600, 45.8000, 15.9610, 45.8010, 'split-me'),
            plot(15.96005, 45.80047, 15.96015, 45.80057, 'take-me'),
            plot(15.9700, 45.8000, 15.9710, 45.8010, 'leave-me')
        ] };
        const res = fe.amendReparcellizationPlanByTaking(plan, strip, ctx);
        expect(res.changed).toBe(true);
        expect(res.removedCount).toBe(1);
        expect(res.splitCount).toBe(1);
        expect(res.polygons.length).toBe(3); // 2 halves + the untouched one
        expect(res.polygons.filter(p => p.ownerKey === 'split-me').length).toBe(2);
        expect(res.polygons.filter(p => p.ownerKey === 'leave-me').length).toBe(1);
        // The input plan object is untouched (pure).
        expect(plan.polygons.length).toBe(3);
        expect(plan.polygons[0].geometry.coordinates[0].length).toBe(5);
    });
});

describe('trimCenterlineByTaking (§15b: roads as victims)', () => {
    const trimCtx = {
        lineSplit: (line, poly) => turf.lineSplit(line, poly),
        pointInPolygon: (pt, poly) => turf.booleanPointInPolygon(pt, poly),
        lengthM: line => turf.length(line, { units: 'kilometers' }) * 1000
    };
    // A ~780 m west-east centerline; a block sits over its middle third.
    const seg = [{ lat: 45.8005, lng: 15.9600 }, { lat: 45.8005, lng: 15.9700 }];
    const block = rect(15.9635, 45.8000, 15.9665, 45.8010);

    it('splits a crossing segment into two outside pieces mapped to their source', () => {
        const res = fe.trimCenterlineByTaking([seg], block, trimCtx);
        expect(res.changed).toBe(true);
        expect(res.segments.length).toBe(2);
        expect(res.splitCount).toBe(1);
        res.segments.forEach(piece => {
            expect(piece.sourceIndex).toBe(0);
            expect(piece.points.length).toBeGreaterThanOrEqual(2);
            // Every kept piece's BETWEEN-vertices midpoint is outside the taken block (a piece
            // boundary VERTEX legitimately sits on the block edge — the split point).
            const i = Math.floor((piece.points.length - 1) / 2);
            const a3 = piece.points[i], b3 = piece.points[i + 1] || a3;
            expect(turf.booleanPointInPolygon([(a3.lng + b3.lng) / 2, (a3.lat + b3.lat) / 2], block)).toBe(false);
        });
    });

    it('removes a segment fully inside the taken ground', () => {
        const inside = [{ lat: 45.8005, lng: 15.9640 }, { lat: 45.8005, lng: 15.9660 }];
        const res = fe.trimCenterlineByTaking([inside], block, trimCtx);
        expect(res.changed).toBe(true);
        expect(res.segments.length).toBe(0);
        expect(res.removedCount).toBe(1);
    });

    it('leaves a segment that never enters the ground untouched', () => {
        const far = [{ lat: 45.8050, lng: 15.9600 }, { lat: 45.8050, lng: 15.9700 }];
        const res = fe.trimCenterlineByTaking([far], block, trimCtx);
        expect(res.changed).toBe(false);
        expect(res.segments.length).toBe(1);
        expect(res.segments[0].points).toBe(far);
    });

    it('drops endpoint slivers below the metre floor', () => {
        // The block covers all but the last ~40 cm of the segment.
        const sliver = [{ lat: 45.8005, lng: 15.9640 }, { lat: 45.8005, lng: 15.96650005 }];
        const res = fe.trimCenterlineByTaking([sliver], block, trimCtx);
        expect(res.changed).toBe(true);
        expect(res.segments.length).toBe(0);
    });

    it('clears a road half-width once so replay does not walk its endpoints backwards', () => {
        const definition = {
            width: 8,
            segmentProfiles: {
                wide: { strips: [{ width: 4 }, { width: 8 }] }
            }
        };
        expect(fe.corridorWidthMeters(definition)).toBe(12);
        const expanded = fe.roadCenterlineTaking(definition, block, {
            buffer: (feature, meters) => turf.buffer(feature, meters, { units: 'meters' })
        });
        const first = fe.trimCenterlineByTaking([seg], expanded, trimCtx);
        expect(first.changed).toBe(true);
        expect(first.segments).toHaveLength(2);

        const second = fe.trimCenterlineByTaking(first.segments.map(piece => piece.points), expanded, trimCtx);
        expect(second.changed).toBe(false);
        expect(second.segments).toHaveLength(2);
    });
});

describe('derivedIdParts', () => {
    it('parses a derived id into base, token and index', () => {
        expect(fe.derivedIdParts('HR-339270-824#c-942ac24kurky-1'))
            .toEqual({ base: 'HR-339270-824', token: 'c-942ac24kurky', index: 1 });
    });

    it('returns null for base ids and empty input', () => {
        expect(fe.derivedIdParts('HR-339270-824')).toBeNull();
        expect(fe.derivedIdParts('823/1')).toBeNull();
        expect(fe.derivedIdParts(null)).toBeNull();
        expect(fe.derivedIdParts('')).toBeNull();
    });

    it('keeps deeper derivation in the base (flatten separately via baseIdOf)', () => {
        expect(fe.derivedIdParts('x#c-a-1#c-b-2')).toEqual({ base: 'x#c-a-1', token: 'c-b', index: 2 });
        expect(fe.baseIdOf('x#c-a-1#c-b-2')).toBe('x');
    });
});

describe('severanceVerdict (§15c)', () => {
    // ctx with real turf, as the amend pass wires it.
    const svCtx = {
        area: f => turf.area(f),
        intersectionArea: (a, b) => { const hit = turf.intersect(a, b); return hit ? turf.area(hit) : 0; },
        difference: (a, b) => turf.difference(a, b)
    };
    // Pool: 100 m × 40 m block; three plots side by side inside it.
    const pool = rect(16.0, 45.0, 16.0012, 45.00036).geometry;
    const plots = { polygons: [
        { geometry: rect(16.0, 45.0, 16.0004, 45.00036).geometry },
        { geometry: rect(16.0004, 45.0, 16.0008, 45.00036).geometry },
        { geometry: rect(16.0008, 45.0, 16.0012, 45.00036).geometry }
    ] };

    it('a taking that misses is unaffected', () => {
        const taking = rect(16.002, 45.0, 16.003, 45.00036);
        expect(fe.severanceVerdict(plots, pool, taking, svCtx).verdict).toBe('unaffected');
    });

    it('a strip across the middle severs (the POOL fragments)', () => {
        // Vertical strip through the middle plot, full height — pool splits into two.
        const taking = rect(16.00055, 44.9999, 16.00065, 45.0004);
        const res = fe.severanceVerdict(plots, pool, taking, svCtx);
        expect(res.verdict).toBe('severed');
    });

    it('a plot split with the pool still connected is a legal cut, not severance', () => {
        // Pool extends a band north of the plots. A strip through the middle plot's FULL
        // height splits that plot into two output parcels, while the pool stays one
        // connected part (its northern band bridges the strip). Rule 3: reduced, one split.
        const tallPool = rect(16.0, 45.0, 16.0012, 45.0005).geometry;
        const taking = rect(16.00055, 44.9999, 16.00065, 45.00038);
        const res = fe.severanceVerdict(plots, tallPool, taking, svCtx);
        expect(res.verdict).toBe('reduced');
        expect(res.splitPlots).toBe(1);
    });

    it('an edge trim only reduces', () => {
        // Shave the northern 10 m off the whole block: every plot shrinks, nothing fragments.
        const taking = rect(15.9999, 45.00027, 16.0013, 45.0005);
        const res = fe.severanceVerdict(plots, pool, taking, svCtx);
        expect(res.verdict).toBe('reduced');
        expect(res.touchedPlots).toBe(3);
        expect(res.destroyedPlots).toBe(0);
    });

    it('a whole-plot take that disconnects the pool severs (footprints stay contiguous)', () => {
        // Swallow the whole middle plot: the pool comes apart into west and east islands.
        // Ruling 2026-08-07: a readjustment never survives with a disconnected footprint —
        // severed even though no individual output parcel fragments.
        const taking = rect(16.00039, 44.9999, 16.00081, 45.0004);
        const res = fe.severanceVerdict(plots, pool, taking, svCtx);
        expect(res.verdict).toBe('severed');
        expect(res.destroyedPlots).toBe(1);
    });

    it('a plot fully consumed while the pool stays connected is reduced, with the plot destroyed', () => {
        // Swallow the WHOLE first plot (and nothing else meaningful): pool keeps one part
        // (the remaining two plots' span), plot 1 is destroyed individually.
        const taking = rect(15.9999, 44.9999, 16.0004, 45.0004);
        const res = fe.severanceVerdict(plots, pool, taking, svCtx);
        expect(res.verdict).toBe('reduced');
        expect(res.destroyedPlots).toBe(1);
    });

    it('corridorComponents: a chain is one component, a gap makes two', () => {
        const a = [{ lat: 45.0, lng: 16.0 }, { lat: 45.0, lng: 16.001 }];
        const b = [{ lat: 45.0, lng: 16.001 }, { lat: 45.0, lng: 16.002 }];
        const far = [{ lat: 45.01, lng: 16.0 }, { lat: 45.01, lng: 16.001 }];
        expect(fe.corridorComponents([a, b]).length).toBe(1);
        const split = fe.corridorComponents([a, b, far]);
        expect(split.length).toBe(2);
        expect(split[0].length).toBe(2); // largest component first
    });

    it('corridorComponents: a T-branch landing mid-polyline connects', () => {
        // The through segment keeps its polyline; the branch endpoint sits on its middle vertex.
        const through = [{ lat: 45.0, lng: 16.0 }, { lat: 45.0, lng: 16.001 }, { lat: 45.0, lng: 16.002 }];
        const branch = [{ lat: 45.0, lng: 16.001 }, { lat: 45.0005, lng: 16.001 }];
        expect(fe.corridorComponents([through, branch]).length).toBe(1);
    });

    it('a disconnected crumb below the part floor does not count as severance', () => {
        // Strip across the middle stopping ~10 cm from the northern edge: the band left
        // north of it is ~0.8 m² — under the 1 m² part floor, so pool and middle plot
        // still count one meaningful part each. Reduced, not severed.
        const taking = rect(16.00055, 44.9999, 16.00065, 45.0003591);
        const res = fe.severanceVerdict(plots, pool, taking, svCtx);
        expect(res.verdict).toBe('reduced');
    });
});
