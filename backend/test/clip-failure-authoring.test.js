// Authoring tools never swallow a polygon clip that throws (turf 6.5 / polygon-clipping 0.15:
// "Maximum call stack size exceeded" and sweep-line failures). Where the result becomes part of a
// proposal — a site, a footprint, a surface, plots, an envelope — the clip refuses with a typed
// ClipFailure (parcel-arrangement.js) instead of a substitute (the operand unchanged, a piece
// skipped, null read as "no overlap"). Where only a preview, a decoration or a heuristic degrades,
// the failure is reported: logged and counted in clipHealth().bySite.
//
// Every test stubs turf so exactly the clip under test throws, and asserts what happens to it.
// Browser-bound code (classic scripts, IIFE internals) runs its own functions, cut out of the
// source with @babel/parser, in a vm context with stubbed collaborators.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const A = require('../../frontend/js/proposals/parcel-arrangement.js');

const STACK = 'Maximum call stack size exceeded';
const box = (w, s, e, n, properties = {}) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]], properties);
// ~80 m x 110 m boxes near Zagreb.
const WEST = box(15.970, 45.810, 15.971, 45.811, { parcelId: 'P1' });
const EAST = box(15.971, 45.810, 15.972, 45.811, { parcelId: 'P2' });

// Real turf with the named operations replaced; `fails(a, b, n)` decides which call throws.
function failingTurf(operations, fails = () => true) {
    const ops = Array.isArray(operations) ? operations : [operations];
    let n = 0;
    return new Proxy(turf, {
        get(target, prop) {
            if (!ops.includes(prop)) return target[prop];
            return (a, b, ...rest) => {
                n += 1;
                if (fails(a, b, n, prop)) throw new RangeError(STACK);
                return target[prop](a, b, ...rest);
            };
        }
    });
}

const health = () => A.clipHealth();
const siteCount = site => health().bySite[site] || 0;
// Asserts `run` refuses with a ClipFailure from `site`.
function expectRefusal(run, site) {
    let thrown = null;
    try { run(); } catch (error) { thrown = error; }
    expect(thrown, `expected a ClipFailure from ${site}`).toBeTruthy();
    expect(thrown.code).toBe('clip-failed');
    expect(thrown.site).toBe(site);
    expect(thrown.originalMessage).toBe(STACK);
    return thrown;
}
// Asserts `run` degrades (returns) and the failure at `site` is counted as degraded.
function expectReported(run, site) {
    const before = siteCount(site);
    const degraded = health().degraded;
    const result = run();
    expect(siteCount(site)).toBe(before + 1);
    expect(health().degraded).toBeGreaterThan(degraded);
    return result;
}

// Function declarations of a classic script by name, so IIFE internals can run in a vm.
const sourceCache = new Map();
function functionsOf(path) {
    if (sourceCache.has(path)) return sourceCache.get(path);
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script', errorRecovery: true });
    const map = new Map();
    (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id && !map.has(node.id.name)) {
            map.set(node.id.name, source.slice(node.start, node.end));
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk); else walk(value);
        }
    })(ast.program);
    sourceCache.set(path, map);
    return map;
}
function runFunctions(path, names, bindings) {
    const map = functionsOf(path);
    const code = names.map(name => {
        if (!map.has(name)) throw new Error(`${name} not found in ${path}`);
        return map.get(name);
    }).join('\n');
    const context = vm.createContext({ console, Error, RangeError, JSON, Math, Number, Array, Object, Promise, setTimeout, ...bindings });
    if (path.endsWith('/building-blocks.js') && names.includes('simplifyAndClipOutline')) {
        Object.assign(context.window, { turf: bindings.turf, FootprintGeometry: { sanitizePolygonFeature: bindings.sanitizePolygonFeature, toSingleLargestPolygon: bindings.toSingleLargestPolygon } });
        vm.runInContext(readFileSync(new URL('../../frontend/js/building-rule-geometry.js', import.meta.url), 'utf8'), context);
    }
    vm.runInContext(code, context);
    return context;
}
// A whole UMD/IIFE module run in a vm whose global is the context (no `require`, no `module`).
function runModule(path, bindings) {
    const context = vm.createContext({ console, Error, RangeError, JSON, Math, Number, Array, Object, ...bindings });
    context.window = context;
    vm.runInContext(readFileSync(new URL(path, import.meta.url), 'utf8'), context);
    return context;
}

beforeAll(() => { globalThis.turf = turf; });
afterEach(() => {
    globalThis.turf = turf;
    vi.restoreAllMocks();
});
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('footprint-geometry', () => {
    const load = t => runModule('../../frontend/js/footprint-geometry.js', { turf: t, __parcelArrangement: A }).FootprintGeometry;

    it('robustUnion refuses instead of skipping the parcel whose union threw', () => {
        const geometry = load(failingTurf('union'));
        expectRefusal(() => geometry.robustUnion([WEST, EAST]), 'footprint-geometry.robustUnion');
    });

    it('sanitizePolygonFeature refuses instead of returning the polygon still kinked', () => {
        const bowTie = turf.polygon([[[15.970, 45.810], [15.971, 45.811], [15.971, 45.810], [15.970, 45.811], [15.970, 45.810]]]);
        const geometry = load(failingTurf('union'));
        expectRefusal(() => geometry.sanitizePolygonFeature(bowTie), 'footprint-geometry.sanitizePolygonFeature');
    });
});

describe('building-ground', () => {
    it('refuses an uncut visible surround when a road subtraction fails', () => {
        const ground = require('../../frontend/js/building-ground.js');
        globalThis.turf = failingTurf('difference');
        const proposals = [
            { buildingProposal: {}, geometry: { groundSurface: { treatment: 'green', polygon: WEST.geometry } } },
            { roadProposal: { definition: { polygon: WEST.geometry } } }
        ];
        expectRefusal(() => ground.appliedSurfaces(proposals, () => true), 'building-ground.surfaceWithoutCorridors');
    });

    it('computeSurfacePolygon refuses instead of paving under the building it could not cut', () => {
        const ground = require('../../frontend/js/building-ground.js');
        globalThis.turf = failingTurf('difference');
        const building = box(15.9702, 45.8102, 15.9704, 45.8104);
        expectRefusal(() => ground.computeSurfacePolygon(WEST, [building]), 'building-ground.computeSurfacePolygon');
    });
});

describe('single-building-geometry', () => {
    it('footprintWithinBoundary answers "not inside" and reports when the difference throws', () => {
        quiet();
        const geometry = require('../../frontend/js/single-building-geometry.js');
        const inside = box(15.9702, 45.8102, 15.9704, 45.8104);
        const result = expectReported(() => geometry.footprintWithinBoundary(inside, WEST, failingTurf('difference')),
            'single-building-geometry.footprintWithinBoundary');
        expect(result).toBe(false);
    });
});

describe('urban-rule-variation', () => {
    const variation = require('../../frontend/js/urban-rule-variation.js');
    const rule = variation.normalizeBlockRule({ typology: 'block', kind: 'range', maxHeightM: 17.5, minHeightM: 7, minDepthM: 8, floorHeightM: 3.5 });
    // A ring building across both parcels.
    const massing = turf.polygon([
        [[15.9702, 45.8102], [15.9718, 45.8102], [15.9718, 45.8108], [15.9702, 45.8108], [15.9702, 45.8102]],
        [[15.9705, 45.8104], [15.9715, 45.8104], [15.9715, 45.8106], [15.9705, 45.8106], [15.9705, 45.8104]]
    ]);
    const parcels = [{ feature: WEST, parcelId: 'P1' }, { feature: EAST, parcelId: 'P2' }];
    // The shared clip hands turf grid-snapped copies, so operands are matched by shape, not identity.
    const same = (x, y) => JSON.stringify(x && x.geometry) === JSON.stringify(y && y.geometry);

    it('splitMassingByParcels refuses instead of reading the parcel as "no massing here"', () => {
        const t = failingTurf('intersect', (a, b) => same(a, massing) && (same(b, WEST) || same(b, EAST)));
        const failure = expectRefusal(() => variation.splitMassingByParcels(massing, parcels, rule, 'seed', { turf: t }),
            'urban-rule-variation.splitMassingByParcels');
        expect(failure.parcelId).toBe('P1');
    });

    it('buildToMinimum refuses instead of compelling the whole massing', () => {
        expectRefusal(() => variation.buildToMinimum(massing, 8, { turf: failingTurf('difference') }), 'urban-rule-variation.buildToMinimum');
    });

    it('the per-parcel compelled part refuses instead of compelling nothing', () => {
        const t = failingTurf('intersect', (a, b) => !same(a, massing) && !same(b, massing));
        expectRefusal(() => variation.splitMassingByParcels(massing, parcels, rule, 'seed', { turf: t }),
            'urban-rule-variation.compelledPerParcel');
    });
});

describe('reparcellization-slice', () => {
    const slice = require('../../frontend/js/reparcellization-slice.js');
    const area = feature => turf.area(feature);
    const owners = [{ ownerKey: 'a', percent: 50 }, { ownerKey: 'b', percent: 50 }];

    it('slicePolygonByXCoordinates refuses instead of handing an owner an empty slot', () => {
        const parcel = box(0, 0, 0.001, 0.001);
        expectRefusal(() => slice.slicePolygonByXCoordinates(failingTurf('intersect'), area, parcel, [0.0005]),
            'reparcellization-slice.slicePolygonByXCoordinates');
    });

    it('the cut search refuses instead of reading a failed clip as zero area', () => {
        const parcel = box(15.970, 45.810, 15.972, 45.811);
        expectRefusal(() => slice.sliceWithSweepLine(parcel, owners, { turf: failingTurf('intersect'), computeFeatureArea: area }),
            'reparcellization-slice.cutSearch');
    });
});

describe('reparcellization-validation', () => {
    it('reports the invalid pool with the clip named, and counts it', () => {
        const validation = require('../../frontend/js/reparcellization-validation.js');
        globalThis.turf = failingTurf('union');
        const before = siteCount('reparcellization-validation.pool');
        const result = validation.validate({
            proposalId: 'rp-1',
            goal: 'reparcellization',
            reparcellization: { polygons: [WEST, EAST], ownerShares: [] }
        }, { turf: globalThis.turf });
        const issues = [...(result.errors || []), ...(result.issues || [])];
        const pool = issues.find(issue => issue.code === 'invalid-pool');
        expect(pool, JSON.stringify(issues)).toBeTruthy();
        expect(pool.message).toMatch(/Polygon union failed at reparcellization-validation\.pool \(proposal rp-1\): Maximum call stack/);
        expect(siteCount('reparcellization-validation.pool')).toBe(before + 1);
    });
});

describe('polygon-geometry-editor', () => {
    it('constrainRingToBoundary refuses the gesture (null) and reports when the clip throws', () => {
        quiet();
        const editor = require('../../frontend/js/polygon-geometry-editor.js');
        // A ring reaching outside the boundary, so the clip is needed.
        const ring = [[15.9702, 45.8102], [15.9712, 45.8102], [15.9712, 45.8108], [15.9702, 45.8108]];
        const result = expectReported(() => editor.constrainRingToBoundary(ring, WEST, failingTurf('intersect')),
            'polygon-geometry-editor.constrainRingToBoundary');
        expect(result).toBeNull();
    });
});

describe('site-drawing reshape', () => {
    it('says the clip failed instead of "it would split the site", and leaves the site unchanged', () => {
        quiet();
        const notices = [];
        const state = { site: WEST.geometry, ring: [[1, 1], [2, 2], [3, 1]], previewParcels: new Map([['P2', EAST.geometry]]), editor: null };
        const siteChanged = vi.fn();
        const context = runFunctions('../../frontend/js/site-drawing.js', ['reshapeWith', 'outerRingOf'], {
            state,
            win: { turf: failingTurf('union'), __parcelArrangement: A },
            t: (key, fallback, params) => String(fallback).replace('{{reason}}', params ? params.reason : ''),
            notify: (message, kind) => notices.push({ message, kind }),
            log: () => {},
            draftApi: () => ({ openRing: ring => ring }),
            siteChanged
        });
        const before = siteCount('site-drawing.reshape');
        context.reshapeWith('P2', 'include');
        expect(notices).toEqual([{ kind: 'error', message: expect.stringMatching(/^The site could not be reshaped: Polygon union failed at site-drawing\.reshape \(parcel P2\): Maximum call stack/) }]);
        expect(state.ring).toEqual([[1, 1], [2, 2], [3, 1]]);
        expect(siteChanged).not.toHaveBeenCalled();
        expect(siteCount('site-drawing.reshape')).toBe(before + 1);
    });
});

describe('default floor plans (a suggestion; degrades, reported)', () => {
    const plans = require('../../frontend/js/default-floor-plans.js');
    const rooms = require('../../frontend/js/default-floor-plan-rooms.js');
    const context = require('../../frontend/js/default-floor-plan-context.js');
    const a = box(0, 0, 10, 10);
    const b = box(5, 0, 15, 10);

    it('default-floor-plans unionAll keeps the pieces it has and reports the one it could not add', () => {
        quiet();
        const result = expectReported(() => plans._clip.unionAll(failingTurf('union'), [a, b]), 'default-floor-plans.unionAll');
        expect(result).toBe(a);
    });
    it('default-floor-plans difference reports', () => {
        quiet();
        expect(expectReported(() => plans._clip.differenceOrNull(failingTurf('difference'), a, b), 'default-floor-plans.difference')).toBeNull();
    });
    it('default-floor-plans intersect reports', () => {
        quiet();
        expect(expectReported(() => plans._clip.intersectOrNull(failingTurf('intersect'), a, b), 'default-floor-plans.intersect')).toBeNull();
    });
    it('default-floor-plan-rooms intersect / difference / unionAll report', () => {
        quiet();
        expect(expectReported(() => rooms._clip.intersect(failingTurf('intersect'), a, b), 'default-floor-plan-rooms.intersect')).toBeNull();
        expect(expectReported(() => rooms._clip.difference(failingTurf('difference'), a, b), 'default-floor-plan-rooms.difference')).toBeNull();
        expect(expectReported(() => rooms._clip.unionAll(failingTurf('union'), [a, b]), 'default-floor-plan-rooms.unionAll')).toBe(a);
    });
    it('default-floor-plan-context slicing reports the parcel it could not cut', () => {
        quiet();
        const building = box(15.9705, 45.8102, 15.9715, 45.8104);
        const slices = expectReported(() => context.sliceBuildingByParcels(building, [WEST], failingTurf('intersect')),
            'default-floor-plan-context.sliceBuildingByParcels');
        expect(slices).toMatchObject([{ unsliced: true }]);
    });
    it('default-floor-plan-context wings report the cut they could not make', () => {
        quiet();
        // An L-shaped footprint is compound, so it is cut into wings.
        const lShape = turf.polygon([[[15.9700, 45.8100], [15.9706, 45.8100], [15.9706, 45.8101], [15.9701, 45.8101], [15.9701, 45.8106], [15.9700, 45.8106], [15.9700, 45.8100]]]);
        expectReported(() => context.decomposeIntoWings(lShape, failingTurf('difference')), 'default-floor-plan-context.decomposeIntoWings');
    });
    it('default-floor-plan-context neighbour pool reports the overlap it could not measure', () => {
        quiet();
        const owner = box(15.9702, 45.8102, 15.9704, 45.8104);
        const existing = box(15.97035, 45.8102, 15.9706, 45.8104);
        const pool = expectReported(() => context.neighbourPool(owner, [], [existing], failingTurf('intersect')),
            'default-floor-plan-context.neighbourPool');
        expect(pool).toContain(existing);
    });
});

describe('structures.js 2D graphics (degrade, reported)', () => {
    const path = '../../frontend/js/structures.js';
    const load = t => runFunctions(path, ['structuresReportClip', 'subtractCorridorsFromGeometry', 'computeLakeZones', 'ensureLakeGraphics', 'featureBbox'], {
        turf: t,
        window: { __parcelArrangement: A },
        LAKE_SHORE_TARGET_RATIO: 0.2,
        LAKE_GRAPHICS_VERSION: 1
    });
    const lake = box(15.9700, 45.8100, 15.9710, 45.8107);

    it('subtractCorridorsFromGeometry does not draw the structure, and reports', () => {
        quiet();
        const cutter = box(15.9705, 45.8095, 15.9706, 45.8110);
        const fns = load(failingTurf('difference'));
        expect(expectReported(() => fns.subtractCorridorsFromGeometry(lake.geometry, [cutter]), 'structures.subtractCorridors')).toBeNull();
    });
    it('computeLakeZones reports a shore it could not cut', () => {
        quiet();
        const fns = load(failingTurf('difference', a => a === lake));
        expect(expectReported(() => fns.computeLakeZones(lake), 'structures.lakeShore')).toBeNull();
    });
    it('computeLakeZones reports a transition ring it could not cut', () => {
        quiet();
        const fns = load(failingTurf('difference', a => a !== lake));
        const zones = expectReported(() => fns.computeLakeZones(lake), 'structures.lakeTransition');
        expect(zones.transition).toBeNull();
    });
    it('ensureLakeGraphics reports the lake parts it could not merge', () => {
        quiet();
        const twoParts = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [WEST.geometry.coordinates, EAST.geometry.coordinates] } };
        const fns = load(failingTurf('union'));
        expect(expectReported(() => fns.ensureLakeGraphics(twoParts), 'structures.lakeGraphicsUnion')).toBe(false);
    });
});

describe('editor sites (refuse)', () => {
    it('row-house robustUnionLocal refuses instead of skipping a parcel', () => {
        const fns = runFunctions('../../frontend/js/row-house.js', ['robustUnionLocal', 'rowHouseClipFailure'], {
            turf: failingTurf('union'), window: { __parcelArrangement: A }
        });
        expectRefusal(() => fns.robustUnionLocal([WEST, EAST]), 'row-house.robustUnionLocal');
    });

    it('parcel-based site refuses instead of stacking the parcels into a MultiPolygon, and says so', () => {
        quiet();
        const updateStatus = vi.fn();
        const fns = runFunctions('../../frontend/js/parcel-based.js', ['parcelBasedSiteFeature', 'parcelBasedClipFailure', 'displayParcelsOnMap'], {
            turf: failingTurf('union'),
            window: { __parcelArrangement: A },
            parcelBasedParcelLayer: null,
            parcelBasedMap: { removeLayer() {} },
            updateStatus,
            translateParcelBasedText: (key, fallback, params) => `${key}|${String(fallback).replace('{{reason}}', params.reason)}`
        });
        expectRefusal(() => fns.parcelBasedSiteFeature([WEST, EAST]), 'parcel-based.siteFeature');
        expectRefusal(() => fns.displayParcelsOnMap({ parcels: [{ feature: WEST }, { feature: EAST }], site: null }), 'parcel-based.siteFeature');
        expect(updateStatus).toHaveBeenCalledWith(expect.stringMatching(/^status\.messages\.parcels_could_not_be_merged\|Could not merge the selected parcels into one site: Polygon union failed at parcel-based\.siteFeature/));
    });

    it('single-building selected site refuses instead of a site with a parcel missing, and says so', () => {
        quiet();
        const setSingleBuildingStatus = vi.fn();
        const fns = runFunctions('../../frontend/js/single-building.js', ['getSelectedBlockFeature', 'singleBuildingClipFailure'], {
            turf: failingTurf('union'),
            window: { __parcelArrangement: A },
            getSingleBuildingContext: () => ({ parcels: [{ feature: WEST }, { feature: EAST }] }),
            cloneSingleFeature: value => JSON.parse(JSON.stringify(value)),
            robustUnion: () => null,
            toSingleLargestPolygon: feature => feature,
            setSingleBuildingStatus
        });
        expectRefusal(() => fns.getSelectedBlockFeature(), 'single-building.selectedBlock');
        expect(setSingleBuildingStatus).toHaveBeenCalledWith('parcels_could_not_be_merged', expect.any(String), { reason: expect.stringMatching(/single-building\.selectedBlock/) });
    });

    it('single-building selected site does not swallow a robustUnion refusal', () => {
        quiet();
        const refusal = A.clipFailure('union', new Error(STACK), { site: 'footprint-geometry.robustUnion' }, []);
        const fns = runFunctions('../../frontend/js/single-building.js', ['getSelectedBlockFeature', 'singleBuildingClipFailure'], {
            turf, window: { __parcelArrangement: A },
            getSingleBuildingContext: () => ({ parcels: [{ feature: WEST }, { feature: EAST }] }),
            cloneSingleFeature: value => value,
            robustUnion: () => { throw refusal; },
            toSingleLargestPolygon: feature => feature,
            setSingleBuildingStatus: () => {}
        });
        expect(() => fns.getSelectedBlockFeature()).toThrow(refusal);
    });

    it('single-building ground preview degrades (no paint) and reports; saving still refuses on the same failure', () => {
        quiet();
        const refusal = A.clipFailure('difference', new Error(STACK), { site: 'building-ground.computeSurfacePolygon' }, []);
        const fns = runFunctions('../../frontend/js/single-building.js', ['updateGroundPreview'], {
            window: { __parcelArrangement: A },
            singleMap: { removeLayer() {} },
            singleGroundPreviewLayer: null,
            singleGroundPreviewSuspended: false,
            currentGroundSurface: () => { throw refusal; },
            buildingGroundApi: () => null
        });
        const degraded = health().degraded;
        expect(() => fns.updateGroundPreview()).not.toThrow();
        expect(health().degraded).toBe(degraded + 1);
        expect(refusal.degraded).toBe(true);
    });
});

describe('building-blocks generator (refuse; the modal shows the error)', () => {
    const path = '../../frontend/js/building-blocks.js';
    const load = t => runFunctions(path, ['buildingBlocksClipFailure', 'simplifyAndClipOutline', 'addWingsToBuilding', 'cutBuildingGap'], {
        turf: t,
        window: { __parcelArrangement: A },
        sanitizePolygonFeature: feature => feature,
        toSingleLargestPolygon: feature => feature
    });

    it('simplifyAndClipOutline refuses instead of publishing an outline reaching into the neighbour', () => {
        const outline = box(15.9705, 45.8102, 15.9712, 45.8108);
        expectRefusal(() => load(failingTurf('intersect')).simplifyAndClipOutline(outline, 0, WEST), 'building-blocks.clipOutlineToParcel');
    });

    it('addWingsToBuilding refuses instead of leaving a wing out', () => {
        const building = box(15.9702, 45.8102, 15.9708, 45.8108);
        const outerCoords = building.geometry.coordinates[0];
        expectRefusal(() => load(failingTurf('union')).addWingsToBuilding(building, {
            outerCoords, superparcel: WEST, wingWidth: 8, buildingWidth: 10, numWings: 1, wingLength: 10, positions: [0.1]
        }), 'building-blocks.addWing');
    });

    it('a gap refuses instead of being left uncut', () => {
        const building = box(15.9702, 45.8102, 15.9708, 45.8108);
        const cutter = box(15.9704, 45.8100, 15.9705, 45.8110);
        expectRefusal(() => load(failingTurf('difference')).cutBuildingGap(building, cutter), 'building-blocks.cutGap');
    });
});

describe('road detection (a heuristic; skips the pair, reported)', () => {
    const path = '../../frontend/js/road-detection.js';
    const common = ['roadDetectionReportClip', 'resolveParcelId', 'roadDetectionFeatureBounds', 'roadDetectionBoundsIntersect'];

    it('computeIoU counts an unmeasurable pair as no match, reported', () => {
        quiet();
        const fns = runFunctions(path, [...common, 'computeIoU'], { turf: failingTurf('intersect'), window: { __parcelArrangement: A } });
        expect(expectReported(() => fns.computeIoU(WEST, WEST), 'road-detection.computeIoU')).toBe(0);
    });

    it('the DGU land-use overlap reports the pair it could not measure', async () => {
        quiet();
        const usage = box(15.970, 45.810, 15.971, 45.811, { SIFRA_VRSTE_UPORABE: '520' });
        const fns = runFunctions(path, [...common, 'detectRoadsFromWFS'], {
            turf: failingTurf('intersect'),
            window: { __parcelArrangement: A },
            ROAD_USAGE_CODES: new Set(['520']),
            roadDetectionServices: () => ({}),
            document: { getElementById: () => null, querySelector: () => null },
            fetchWFSUsageInBbox: async () => ({ features: [usage] }),
            roadDetectionFeaturesInView: () => [WEST],
            markRoadFeature: () => true,
            updateStatus: () => {},
            updateParcelStyles: () => {}
        });
        const before = siteCount('road-detection.landUseOverlap');
        await fns.detectRoadsFromWFS();
        expect(siteCount('road-detection.landUseOverlap')).toBe(before + 1);
    });

    it('a parcel × OSM road overlap reports the road it skipped', async () => {
        quiet();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const road = turf.lineString([[15.9695, 45.8105], [15.9715, 45.8105]]);
        const fns = runFunctions(path, [...common, 'detectIfParcelIsRoad'], { turf: failingTurf('intersect'), window: { __parcelArrangement: A } });
        const before = siteCount('road-detection.parcelRoadOverlap');
        await fns.detectIfParcelIsRoad(WEST, { features: [road] });
        expect(siteCount('road-detection.parcelRoadOverlap')).toBe(before + 1);
        expect(health().recent.at(-1)).toMatchObject({ site: 'road-detection.parcelRoadOverlap', parcelId: 'P1' });
    });

    it('the OSM-lines-first pass reports the parcel it could not check', async () => {
        quiet();
        const road = turf.lineString([[15.9695, 45.8105], [15.9715, 45.8105]]);
        const fns = runFunctions(path, [...common, 'detectRoadsByOSMLinesFirst'], {
            turf: failingTurf('intersect'),
            window: { __parcelArrangement: A },
            document: { getElementById: () => null },
            markRoadFeature: () => true
        });
        const before = siteCount('road-detection.osmRoadOverlap');
        await fns.detectRoadsByOSMLinesFirst([WEST], { features: [road] });
        expect(siteCount('road-detection.osmRoadOverlap')).toBe(before + 1);
    });
});

describe('road-drawing conflict markers (display; degrade, reported)', () => {
    it('places the ring on the structure itself and reports the clip', () => {
        quiet();
        const park = box(15.9702, 45.8102, 15.9708, 45.8108);
        const fns = runFunctions('../../frontend/js/road-drawing.js', ['roadConflictMarkerPoints'], {
            turf: failingTurf('intersect'),
            window: { __parcelArrangement: A },
            corridorFeatureFromLatLngRing: () => box(15.9700, 45.8104, 15.9710, 45.8105)
        });
        const entry = { buildings: [], structures: [{ feature: park }], crossings: [], plots: {}, from: { lat: 0, lng: 0 }, to: { lat: 0, lng: 0 } };
        const points = expectReported(() => fns.roadConflictMarkerPoints(entry, []), 'road-drawing.conflictMarker');
        expect(points).toHaveLength(1);
    });
});

describe('parcel-layout editor (refuse)', () => {
    const path = '../../frontend/js/parcel-layout.js';
    const load = t => runFunctions(path, ['layoutArrangement', 'layoutClipFailure', 'layoutClip', 'buildPoolFromPlots'], {
        turf: t, window: { __parcelArrangement: A }
    });

    it('buildPoolFromPlots refuses instead of a pool with a plot left out', () => {
        expectRefusal(() => load(failingTurf('union')).buildPoolFromPlots([WEST, EAST], ['P1', 'P2']), 'parcel-layout.buildPoolFromPlots');
    });
});
