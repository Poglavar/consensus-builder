// Display, report and draw-time clip sites: a polygon clip that throws is never swallowed.
//
// turf 6.5 clips with polygon-clipping 0.15, which throws "Maximum call stack size exceeded" on
// long chains (measured on the real Šibenik plan in corridor-junction-paint's union). Each test
// here stubs turf so exactly the clip at one site throws, and asserts what the site does with it:
//   - display / report code degrades and REPORTS it: counted in clipHealth().bySite[site] and
//     marked degraded (parcel-arrangement.js reportClipFailure), with unknown figures as null;
//   - code whose result is stored, applied or decides a check REFUSES with a typed ClipFailure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const A = require('../../frontend/js/proposals/parcel-arrangement.js');

const STACK = 'Maximum call stack size exceeded';
const box = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
// Two overlapping ~77 m squares near 46°N.
const LEFT = box(16.0000, 46.0000, 16.0010, 46.0010);
const RIGHT = box(16.0005, 46.0000, 16.0015, 46.0010);
const FAR = box(16.0100, 46.0100, 16.0110, 46.0110);

// turf with `ops` throwing (when `when(op, ...args)` says so); everything else is real turf.
function failing(ops, when = () => true) {
    return new Proxy(turf, {
        get(target, prop) {
            if (!ops.includes(prop)) return target[prop];
            return (...args) => {
                if (when(prop, ...args)) throw new RangeError(STACK);
                return target[prop](...args);
            };
        }
    });
}

const count = site => A.clipHealth().bySite[site] || 0;
const degraded = () => A.clipHealth().degraded;

// Reported: counted at its site and marked degraded.
function expectReported(site, run) {
    const before = count(site);
    const degradedBefore = degraded();
    const result = run();
    expect(count(site), `${site} was not reported`).toBe(before + 1);
    expect(degraded()).toBe(degradedBefore + 1);
    return result;
}

const installed = new Map();
function install(name, value) {
    if (!installed.has(name)) installed.set(name, { had: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    for (const [name, previous] of installed) {
        if (previous.had) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    installed.clear();
    vi.restoreAllMocks();
});

// Functions declared inside a browser-only IIFE, evaluated on their own in a vm context with the
// collaborators they read stubbed (the pattern of photoreal-startup.test.js).
function findFunction(node, name) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node;
    for (const value of Object.values(node)) {
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) {
            if (child && typeof child === 'object') {
                const found = findFunction(child, name);
                if (found) return found;
            }
        }
    }
    return null;
}
function extract(relativePath, names, context) {
    const src = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
    const ast = parse(src, { sourceType: 'script', errorRecovery: true });
    const code = names.map(name => {
        const node = findFunction(ast.program, name);
        if (!node) throw new Error(`${name} not found in ${relativePath}`);
        return src.slice(node.start, node.end);
    }).join('\n');
    vm.createContext(context);
    return vm.runInContext(`${code}\n;({ ${names.join(', ')} })`, context);
}

describe('corridor-junction-paint (display)', () => {
    const paint = require('../../frontend/js/corridor-junction-paint.js');
    const ring = f => f.geometry.coordinates[0].slice(0, -1).map(([lng, lat]) => ({ lat, lng }));

    it('a junction piece that cannot be united is painted on its own, reported', () => {
        install('turf', failing(['union']));
        const geometry = expectReported('corridor-junction-paint.unionOfRings', () => paint.unionOfRings([ring(LEFT), ring(RIGHT)]));
        expect(geometry.type).toBe('Polygon');
    });

    it('a strip that cannot be clipped to its junction is painted whole, reported', () => {
        install('turf', failing(['difference']));
        const geometry = RIGHT.geometry;
        const out = expectReported('corridor-junction-paint.clipGeometry', () => paint.clipGeometry(geometry, [{ surfacePolygons: [ring(LEFT)] }]));
        expect(out).toBe(geometry);
    });
});

describe('corridor-edge-fill (3D display)', () => {
    const fill = require('../../frontend/js/corridor-edge-fill.js');
    const band = box(15.9990, 45.9990, 16.0020, 46.0020);

    it('a cut whose intersection with the band throws is dropped and reported', () => {
        const report = {};
        expectReported('corridor-edge-fill.cut', () => fill.corridorEdgeFillRegion(band, null, [LEFT], { turf: failing(['intersect']), report }));
        expect(report.intersectThrew).toBe(1);
    });

    it('a cut that cannot be merged into the region is dropped and reported', () => {
        const region = expectReported('corridor-edge-fill.merge', () => fill.corridorEdgeFillRegion(band, null, [LEFT, RIGHT], { turf: failing(['union']) }));
        expect(turf.area(region)).toBeCloseTo(turf.area(LEFT), -1);
    });
});

describe('corridor-editor take disclosure (dialog)', () => {
    it('a face whose overlap cannot be measured is counted as unmeasured and reported', () => {
        globalThis.CbFormat = require('../../frontend/js/format.js');
        Object.assign(globalThis, require('../../frontend/js/corridor-profile.js'));
        const editor = require('../../frontend/js/corridor-editor.js');
        const face = { ...RIGHT, properties: { parcelId: 'HR-1-7' } };
        install('window', {
            turf: failing(['intersect']),
            __parcelArrangement: A,
            LiveParcelFabric: { queryBounds: () => [face], explicitCadastreIds: () => ['HR-1-7'] }
        });
        const take = expectReported('corridor-editor.parcelTake', () => editor.corridorEditorParcelTake(LEFT.geometry));
        expect(take).toMatchObject({ available: true, faces: 1, parcels: [], unmeasured: 1 });
    });
});

describe('corridor-structures crossing check (refuses)', () => {
    it('throws a ClipFailure instead of answering "does not cross the park"', () => {
        require('../../frontend/js/corridor-structures.js');
        install('corridorFeatureFromLatLngRing', () => LEFT);
        install('parks', [{ ...RIGHT, properties: { proposalId: 'park-1' } }]);
        install('squares', []);
        install('lakes', []);
        install('turf', failing(['intersect']));
        let thrown = null;
        try { globalThis.detectStructureCrossings([]); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(A.ClipFailure);
        expect(thrown).toMatchObject({ site: 'corridor-structures.detectStructureCrossings', proposalId: 'park-1' });
    });
});

describe('corridor-tunnel demolition and cut records (refuse)', () => {
    const tunnel = require('../../frontend/js/corridor-tunnel.js');
    const refuses = (site, run) => {
        let thrown = null;
        try { run(); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(A.ClipFailure);
        expect(thrown.site).toBe(site);
        return thrown;
    };
    const building = { ...RIGHT, properties: { object_id: 'b-1' } };

    it('detection: a building whose overlap throws is not "uncrossed"', () => {
        refuses('corridor-tunnel.findBuildingTunnelIntersections',
            () => tunnel.findBuildingTunnelIntersections(LEFT, [building], failing(['intersect'])));
    });

    it('a partial demolition split refuses on its intersect and on its remainder', () => {
        refuses('corridor-tunnel.splitDemolitionFootprint', () => tunnel.splitDemolitionFootprint(RIGHT, LEFT, failing(['intersect'])));
        refuses('corridor-tunnel.splitDemolitionFootprint', () => tunnel.splitDemolitionFootprint(RIGHT, LEFT, failing(['difference'])));
    });

    it('a cut record refuses on its intersect, its accumulation and its remainder', () => {
        const hit = { id: 'b-1', feature: RIGHT };
        refuses('corridor-tunnel.upsertCutRecord', () => tunnel.upsertCutRecord([], hit, LEFT, failing(['intersect'])));
        refuses('corridor-tunnel.upsertCutRecord', () => tunnel.upsertCutRecord([], hit, LEFT, failing(['difference'])));
        const records = [];
        tunnel.upsertCutRecord(records, hit, box(16.0005, 46.0000, 16.0008, 46.0010), turf);
        expect(records[0].remainder).toBeTruthy();
        const failure = refuses('corridor-tunnel.upsertCutRecord', () => tunnel.upsertCutRecord(records, hit, box(16.0009, 46.0000, 16.0011, 46.0010), failing(['union'])));
        expect(failure.operation).toBe('union');
    });

    it('recombining two stored cuts for display keeps the first one and reports the failure', () => {
        const first = [];
        tunnel.upsertCutRecord(first, { id: 'b-1', feature: RIGHT }, box(16.0005, 46.0000, 16.0008, 46.0010), turf);
        const second = [];
        tunnel.upsertCutRecord(second, { id: 'b-1', feature: RIGHT }, box(16.0012, 46.0000, 16.0015, 46.0010), turf);
        const before = degraded();
        const out = tunnel.consolidateCorridorDemolitionRecords([first[0], second[0]], LEFT, failing(['intersect']));
        expect(out).toEqual([first[0]]);
        expect(degraded()).toBe(before + 1);
    });
});

describe('government-roads plan pieces (feed "Apply government plan": refuse)', () => {
    let gov;
    const bounds = {
        getSouthWest: () => ({ lat: 45.999, lng: 15.999 }),
        getNorthEast: () => ({ lat: 46.002, lng: 16.002 }),
        getNorthWest: () => ({ lat: 46.002, lng: 15.999 }),
        getSouthEast: () => ({ lat: 45.999, lng: 16.002 })
    };
    beforeEach(() => {
        install('window', globalThis);
        install('document', { addEventListener() {}, getElementById() { return null; } });
        gov = require('../../frontend/js/government-roads.js');
    });
    const refuses = async (site, run) => {
        let thrown = null;
        try { await run(); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(A.ClipFailure);
        expect(thrown.site).toBe(site);
    };

    it('safeUnion / unionFeatures no longer drop the addition', async () => {
        install('turf', failing(['union']));
        await refuses('government-roads.safeUnion', () => gov.safeUnion(LEFT, RIGHT));
        await refuses('government-roads.safeUnion', () => gov.unionFeatures([LEFT, RIGHT]));
    });

    it('subtracting applied roads from plan pieces refuses instead of keeping the piece whole', async () => {
        install('turf', failing(['difference']));
        await refuses('government-roads.subtractAppliedSegmentsFromPieces', () => gov.subtractAppliedSegmentsFromPieces([LEFT], RIGHT, {}));
    });

    it('the remaining-plan bookkeeping after an apply refuses instead of keeping applied roads', async () => {
        install('turf', failing(['difference']));
        gov._setPlanState({ remainingPlanGeometry: LEFT, cachedPlanCollection: { type: 'FeatureCollection', features: [LEFT] } });
        await refuses('government-roads.subtractFromRemainingPlan', () => gov.subtractFromRemainingPlan([RIGHT]));
        await refuses('government-roads.removeAppliedSegmentsFromCachedPlan', () => gov.removeAppliedSegmentsFromCachedPlan([RIGHT]));
    });

    it('clipping the plan to the view refuses instead of "nothing in view" or the unclipped plan', async () => {
        install('turf', failing(['intersect']));
        gov._setPlanState({ remainingPlanGeometry: LEFT, cachedPlanCollection: { type: 'FeatureCollection', features: [LEFT] } });
        await refuses('government-roads.getRemainingPlanForView', () => gov.getRemainingPlanForView(bounds));
        await refuses('government-roads.computePlanPiecesForView', () => gov.computePlanPiecesForView(bounds, {}));
    });

    it('subtracting road parcels in view refuses instead of keeping the piece whole', async () => {
        install('turf', failing(['difference']));
        install('LiveParcelFabric', { queryBounds: () => [{ ...RIGHT, properties: { isRoad: true } }] });
        gov._setPlanState({ remainingPlanGeometry: LEFT, cachedPlanCollection: { type: 'FeatureCollection', features: [LEFT] } });
        await refuses('government-roads.computePlanPiecesForView', () => gov.computePlanPiecesForView(bounds, { subtractRoads: true }));
        await refuses('government-roads.computeRemainingPlanPiecesForView', () => gov.computeRemainingPlanPiecesForView(bounds, { subtractRoads: true }));
    });

    it('building the proposal refuses on a parcel it cannot intersect or leave a remainder of', async () => {
        const candidateParcels = [{ feature: { ...LEFT, properties: { parcelId: 'HR-1-1', cadastreParcelIds: ['HR-1-1'] } } }];
        // Load the real classic-script helpers, and first prove the valid source fixture reaches
        // proposal construction. Otherwise an earlier missing dependency could mask the clip check.
        const geometry = vm.createContext({});
        vm.runInContext(readFileSync(new URL('../../frontend/js/proposal-road-geometry.js', import.meta.url), 'utf8'), geometry);
        install('_ensurePolygonIsClosed', geometry._ensurePolygonIsClosed);
        install('_geometryHash', geometry._geometryHash);
        install('LiveParcelFabric', { cadastreIdsForParcelIds: ids => ids });
        install('turf', turf);
        const built = await gov.buildGovernmentPlanProposalDataSync(RIGHT, { candidateParcels });
        expect(built.proposalData.cadastreParcelIds).toEqual(['HR-1-1']);
        expect(built.childFeatures).toHaveLength(2);
        install('turf', failing(['intersect']));
        await refuses('government-roads.buildGovernmentPlanProposalData', () => gov.buildGovernmentPlanProposalDataSync(RIGHT, { candidateParcels }));
        install('turf', failing(['difference']));
        await refuses('government-roads.buildGovernmentPlanProposalData', () => gov.buildGovernmentPlanProposalDataSync(RIGHT, { candidateParcels }));
    });

    it('ranking catalogue plans for the view reports an unmeasurable overlap and still picks a plan', async () => {
        install('turf', failing(['intersect']));
        gov._setPlanState({ planCatalog: [{ geometry: LEFT.geometry, planName: 'Plan' }] });
        const before = count('government-roads.selectPlanForBounds');
        const plan = await gov.selectPlanForBounds(bounds);
        expect(plan.planName).toBe('Plan');
        expect(count('government-roads.selectPlanForBounds')).toBe(before + 1);
    });
});

describe('government-plan-worker (refuses with a structured error)', () => {
    const run = ops => {
        const posted = [];
        const context = {
            self: { postMessage: message => posted.push(message) },
            importScripts: () => {},
            turf: failing(ops),
            console: { error: () => {}, warn: () => {}, log: () => {} }
        };
        vm.createContext(context);
        vm.runInContext(readFileSync(fileURLToPath(new URL('../../frontend/js/government-plan-worker.js', import.meta.url)), 'utf8'), context);
        context.self.onmessage({ data: { requestId: 1, type: 'process-plan', planPolygon: RIGHT, parcels: [{ id: 'HR-1-1', ...LEFT }] } });
        return posted;
    };

    it('an intersection or remainder that throws fails the request, naming the clip and the parcel', () => {
        for (const op of ['intersect', 'difference']) {
            const [message] = run([op]);
            expect(message.success).toBe(false);
            expect(message.error).toMatchObject({ code: 'clip-failed', operation: op, site: 'government-plan-worker.processPlanRequest', parcelId: 'HR-1-1' });
        }
    });
});

describe('dgu-live takes (stand in for the server binding: refuse)', () => {
    it('a parcel whose take cannot be computed refuses instead of taking nothing', async () => {
        const { createDguLive } = require('../../frontend/js/parcels/dgu-live.js');
        const live = createDguLive({
            requestJson: async () => ({ features: [{ properties: { MATICNI_BROJ_KO: '330264', BROJ_CESTICE: '1' }, geometry: LEFT.geometry }], numberMatched: 1 }),
            toWgs84: collection => collection,
            toDatasetBox: bbox => bbox,
            turf: failing(['intersect'])
        });
        let thrown = null;
        try { await live.fetchUnder(RIGHT.geometry); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(A.ClipFailure);
        expect(thrown).toMatchObject({ site: 'dgu-live.fetchUnder', parcelId: 'HR-330264-1' });
    });
});

describe('overture-tiles (context buildings, display)', () => {
    it('two tile copies that cannot be united: the larger stands in, reported', () => {
        const overture = require('../../frontend/js/overture-tiles.js');
        const small = { ...box(16.0000, 46.0000, 16.0005, 46.0010), id: 'w1' };
        const large = { ...LEFT, id: 'w1' };
        const out = expectReported('overture-tiles.mergeTileCopies', () => overture.mergeTileCopies([small, large], failing(['union'])));
        expect(out).toEqual([large]);
    });
});

describe('photoreal-protect (display)', () => {
    it('a protector that cannot be clipped is dropped, reported', () => {
        const protect = require('../../frontend/js/photoreal-protect.js');
        const out = expectReported('photoreal-protect.selectProtectedBuildingFootprints', () => protect.selectProtectedBuildingFootprints(
            [{ ...LEFT, properties: {} }],
            { turf: failing(['difference']), removals: [RIGHT.geometry], dilateM: 0, removalBufferM: 0 }
        ));
        expect(out).toEqual([]);
    });
});

describe('photoreal-mode (display)', () => {
    const file = '../../frontend/js/photoreal-mode.js';

    it('a razed footprint that cannot be cut by a structure carves whole, reported', () => {
        const fns = extract(file, ['reportPhotorealClip', 'razedFootprintOutsideStructures'], {
            turf: failing(['difference']),
            window: { __parcelArrangement: A },
            appliedStructureProposals: () => [{ structureProposal: { geometry: RIGHT.geometry } }]
        });
        const out = expectReported('photoreal-mode.razedFootprintOutsideStructures', () => fns.razedFootprintOutsideStructures(LEFT.geometry));
        expect(out).toBe(LEFT.geometry);
    });

    it('a foundation union that throws is reported once, and the curtain is omitted', () => {
        const fns = extract(file, ['reportPhotorealClip', 'ringSignedArea', 'unionRoadFoundationGeometry'], {
            turf: failing(['union']),
            window: { __parcelArrangement: A },
            Number, Math
        });
        const ringOf = f => f.geometry.coordinates[0];
        const out = expectReported('photoreal-mode.unionRoadFoundationGeometry', () => fns.unionRoadFoundationGeometry([
            { boundaryRings: [ringOf(LEFT)] }, { boundaryRings: [ringOf(RIGHT)] }
        ]));
        expect(out).toBeNull();
    });
});

describe('three-mode (3D display)', () => {
    const file = '../../frontend/js/three-mode.js';
    const base = ops => ({ turf: failing(ops), window: { __parcelArrangement: A }, Number, Math, JSON });

    it('transit lines: a mask that cannot be united leaves the lines unclipped, reported', () => {
        const fns = extract(file, ['reportThreeClip', 'clipTransitLinesOutsideProposals'], base(['union']));
        const lines = { type: 'FeatureCollection', features: [turf.lineString([[15.999, 46.0005], [16.002, 46.0005]])] };
        const out = expectReported('three-mode.clipTransitLinesOutsideProposals', () => fns.clipTransitLinesOutsideProposals(lines, [LEFT, RIGHT]));
        expect(out).toBe(lines);
    });

    it('ground openings: a parcel the opening cannot be cut from is drawn without it, reported', () => {
        const fns = extract(file, ['reportThreeClip', 'cutGroundOpeningsOutOfFeature'], base(['difference']));
        const out = expectReported('three-mode.cutGroundOpeningsOutOfFeature', () => fns.cutGroundOpeningsOutOfFeature(LEFT, [RIGHT]));
        expect(out).toBe(LEFT);
    });

    it('structure clearance: an intersect, union or remainder that throws is reported', () => {
        const regions = [RIGHT, box(16.0008, 46.0000, 16.0012, 46.0010)].map(region => ({ region, bbox: turf.bbox(region) }));
        for (const op of ['intersect', 'union', 'difference']) {
            const fns = extract(file, ['reportThreeClip', 'structureClearanceCarve'], { ...base([op]), buildingFootprintPolygon: () => LEFT });
            expectReported('three-mode.structureClearanceCarve', () => fns.structureClearanceCarve({}, op === 'union' ? regions : regions.slice(0, 1)));
        }
    });

    it('building slices: a parcel the building cannot be intersected with gets no slice, reported', () => {
        const added = [];
        class Color { constructor() {} }
        const fns = extract(file, ['reportThreeClip', 'createBuildingSlices'], {
            ...base(['intersect']),
            window: { __parcelArrangement: A, LiveParcelFabric: { queryBounds: () => [RIGHT] } },
            THREE: { Color },
            stringToColor: () => '#888888',
            polygonFeatureToMeshes: () => [],
            prepareProceduralFacadeMeshes: meshes => meshes
        });
        expectReported('three-mode.createBuildingSlices', () => {
            try { fns.createBuildingSlices(LEFT, 10, {}, { add: mesh => added.push(mesh) }); } catch (error) {
                // Past the reported clip the function needs more of the 3D scene than is stubbed.
                if (error instanceof A.ClipFailure) throw error;
            }
        });
    });

    it('suggested interiors: an overlap with a proposed building that throws is reported', () => {
        const fns = extract(file, ['reportThreeClip', 'appendSuggestedExistingFloorPlans'], {
            ...base(['intersect']),
            window: {
                __parcelArrangement: A,
                buildingFeaturePool: [{ ...LEFT, properties: { height_m: 9 } }],
                proposedBuildings: [RIGHT]
            },
            xrayEnabled: true, suggestedPlansEnabled: true, suggestedExistingEnabled: true,
            floorPlanGroup: {}, suggestedFloorPlans: {}, suggestedPlanTotals: {},
            suggestedPlanContext: { planBuilding: () => null, neighbourPool: () => [] },
            getGeoCameraView: () => ({ targetLng: 16.0005, targetLat: 46.0005 }),
            buildingLoadRadiusM: 1000, SUGGESTED_EXISTING_CAP: 10,
            suggestedRegion: () => null, suggestedRoadsFor: () => [], suggestedPlanCache: new Map()
        });
        expectReported('three-mode.appendSuggestedExistingFloorPlans', () => {
            try { fns.appendSuggestedExistingFloorPlans({}); } catch (error) {
                if (error instanceof A.ClipFailure) throw error;
            }
        });
    });
});

describe('dossier: an unmeasurable take is unknown, never smaller', () => {
    const dossier = require('../../frontend/js/proposals/dossier.js');
    beforeEach(() => {
        install('__planOrder', {
            footprintOf: () => LEFT,
            intersectionArea: (a, b) => { const hit = turf.intersect(a, b); return hit ? turf.area(hit) : 0; }
        });
        install('__ownershipFlow', { hasFormation: () => false });
    });
    const proposal = { proposalId: 'p-2', goal: 'single', createdAt: '2026-10-02T00:00:00.000Z' };
    const earlier = (id, footprint) => ({ id, createdAt: '2026-10-01T00:00:00.000Z', footprint });

    it('the take intersection that throws asks the owner, reported', () => {
        install('turf', failing(['intersect']));
        const channel = expectReported('dossier.deferredTake', () => dossier.channelFor(proposal, 'P-1', {
            flow: [{ parcelId: 'P-1', cededM2: 50 }], parcelFeature: RIGHT, cedingFlows: []
        }));
        expect(channel).toBe('acceptance');
    });

    it('earlier ground that cannot be united makes the deferral unknown (ask), reported', () => {
        install('turf', failing(['union']));
        const channel = expectReported('dossier.deferredTake', () => dossier.channelFor(proposal, 'P-1', {
            flow: [{ parcelId: 'P-1', cededM2: 50 }], parcelFeature: RIGHT,
            cedingFlows: [earlier('a', LEFT), earlier('b', RIGHT)]
        }));
        expect(channel).toBe('acceptance');
    });

    it('content on ceded ground whose overlap throws stays an offer, reported', () => {
        install('turf', failing(['intersect']));
        const channel = expectReported('dossier.channelFor', () => dossier.channelFor(proposal, 'P-1', {
            flow: [], parcelFeature: RIGHT, cedingFlows: [earlier('a', RIGHT)]
        }));
        expect(channel).toBe('offer');
    });

    it('a remainder that cannot be computed is no report rather than a wrong one', () => {
        for (const op of ['union', 'intersect', 'difference']) {
            install('turf', failing([op]));
            const out = expectReported('dossier.remainderReport', () => dossier.remainderReport(LEFT, [RIGHT, box(16.0008, 46.0000, 16.0012, 46.0010)]));
            expect(out).toBeNull();
        }
    });
});

describe('map-pick ground (display)', () => {
    // The ground a design stands on, as the share panel's hover and every pick highlight measure it
    // (js/map-pick.js groundReaches, MapPick.groundOf).
    it('an unknown overlap keeps the parcel, reported', () => {
        const MapPick = require('../../frontend/js/map-pick.js');
        install('turf', failing(['intersect']));
        const reaches = expectReported('map-pick.groundUnderBody', () => MapPick.groundReaches(LEFT, RIGHT));
        expect(reaches).toBe(true);
        // So every parcel whose overlap is unknown stays under the body rather than silently dropping
        // out of the highlight, each clip reported.
        install('__hoverGround', require('../../frontend/js/proposals/hover-ground.js'));
        // FAR's box misses the body, so no clip runs for it (geometry-tolerances.js reachesInto) and
        // it is not ground the body stands on.
        const before = count('map-pick.groundUnderBody');
        expect(MapPick.groundOf([LEFT, FAR], [RIGHT])).toEqual([LEFT]);
        expect(count('map-pick.groundUnderBody')).toBe(before + 1);
    });
});

describe('parcel-compare: an unmeasurable overlap is null ("—"), never 0', () => {
    const compare = require('../../frontend/js/proposals/parcel-compare.js');
    const LNG0 = 15.97;
    const LAT0 = 45.8;
    const M_LNG = turf.distance([LNG0, LAT0], [LNG0 + 0.01, LAT0], { units: 'meters' }) / 0.01;
    const M_LAT = turf.distance([LNG0, LAT0], [LNG0, LAT0 + 0.01], { units: 'meters' }) / 0.01;
    const P = (x, y) => [LNG0 + x / M_LNG, LAT0 + y / M_LAT];
    const rect = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)]] });
    const PARCEL_ID = 'HR-1-100';
    const PARCEL_GEOMETRY = rect(0, 0, 40, 25);
    const PARCEL = { id: PARCEL_ID, cadastreIds: [PARCEL_ID], feature: { type: 'Feature', properties: {}, geometry: PARCEL_GEOMETRY } };
    // Only clips against the parcel throw.
    const parcelClipsFail = () => failing(['intersect'], (_op, _a, b) => JSON.stringify(b && b.geometry) === JSON.stringify(PARCEL_GEOMETRY));

    it('a park: take and structure area unknown, reported', () => {
        const park = { proposalId: 'park', goal: 'park', cadastreParcelIds: [PARCEL_ID], structureProposal: { kind: 'park', geometry: rect(-5, -5, 45, 30) } };
        const before = [count('parcel-compare.relationOf'), count('parcel-compare.structureOn')];
        const effect = compare.parcelEffect(park, PARCEL, { turf: parcelClipsFail() });
        expect(effect.take.areaM2).toBeNull();
        expect(effect.take.extent).toBeNull();
        expect(effect.structure).toEqual({ kind: 'park', areaM2: null });
        expect([count('parcel-compare.relationOf'), count('parcel-compare.structureOn')]).toEqual([before[0] + 1, before[1] + 1]);
    });

    it('buildings: all figures unknown, reported', () => {
        const record = { proposalId: 'block', goal: 'buildings', cadastreParcelIds: [PARCEL_ID],
            geometry: { buildings: [{ type: 'Feature', properties: { height: 9 }, geometry: rect(5, 5, 15, 15) }] } };
        const before = count('parcel-compare.buildingsOn');
        const effect = compare.parcelEffect(record, PARCEL, { turf: parcelClipsFail() });
        expect(effect.buildings).toEqual({ count: null, footprintM2: null, floorAreaM2: null, heightM: null, floors: null });
        expect(count('parcel-compare.buildingsOn')).toBe(before + 1);
    });

    it('parcel-layout plots: listed with an unknown overlap, reported', () => {
        const plan = { proposalId: 'layout', goal: 'parcel-layout', cadastreParcelIds: [PARCEL_ID],
            parcelLayout: { plots: [{ geometry: rect(0, 0, 10, 25), area: 250, source: 'manual' }] } };
        const before = count('parcel-compare.plotsOn');
        const effect = compare.parcelEffect(plan, PARCEL, { turf: parcelClipsFail() });
        expect(effect.plots).toEqual([expect.objectContaining({ number: 1, overlapM2: null })]);
        expect(count('parcel-compare.plotsOn')).toBe(before + 1);
    });

    it('an undeclared site whose overlap throws is listed as reaching in, unmeasured', () => {
        const sliver = { proposalId: 'sliver', goal: 'park', cadastreParcelIds: ['HR-1-101'], site: rect(-20, 5, 0.3, 15) };
        const hit = compare.relationOf(sliver, PARCEL, { turf: parcelClipsFail() });
        expect(hit).toMatchObject({ relation: 'intrudes', overlapM2: null, unmeasured: true });
    });
});

describe('parcel-compare-ui parcel context (display)', () => {
    it('a parcel whose cadastral parts cannot be united is compared as the live piece, reported', () => {
        const live = { ...LEFT, properties: { parcelId: 'L-1' } };
        const context = {
            window: null,
            Number, Math, JSON, Set, Map, Array, Object, String, console: { warn() {}, error() {}, log() {} }
        };
        context.window = context;
        Object.assign(context, {
            turf: failing(['union']),
            __parcelArrangement: A,
            __parcelCompare: { proposalsTouchingParcel: () => [] },
            LiveParcelFabric: { get: () => live, explicitCadastreIds: () => ['C-1', 'C-2'] },
            CadastralParcelRepository: { get: id => ({ ...(id === 'C-1' ? LEFT : RIGHT), properties: { parcelId: id } }) },
            ParcelMenuModel: null,
            proposalStorage: { getAllProposals: () => [] }
        });
        vm.createContext(context);
        vm.runInContext(readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/parcel-compare-ui.js', import.meta.url)), 'utf8'), context);
        const before = count('parcel-compare-ui.parcelContext');
        try { context.ParcelCompare.countFor('L-1'); } catch (_) { /* past parcelContext, countFor needs more of the page */ }
        expect(count('parcel-compare-ui.parcelContext')).toBe(before + 1);
    });
});

describe('building-density-stats (editor figures)', () => {
    it('footprints that cannot be united leave footprint, overlap and coverage unknown, reported', () => {
        const stats = require('../../frontend/js/building-density-stats.js');
        const out = expectReported('building-density-stats.unionFootprints', () => stats.summarizeDensity({
            parcelFeature: box(15.999, 45.999, 16.002, 46.002), buildings: [LEFT, RIGHT], turf: failing(['union'])
        }));
        expect(out).toMatchObject({ footprintAreaM2: null, overlapAreaM2: null, siteCoveragePercent: null, buildingCount: 2 });
    });
});

describe('publish-gap-debug (console tool: refuses)', () => {
    const gap = require('../../frontend/js/publish-gap-debug.js');

    it('a difference that throws is not "the parcel\'s ground is a gap"', () => {
        const ops = {
            area: f => turf.area(f),
            intersectionArea: (a, b) => turf.area(turf.intersect(a, b)),
            difference: () => { throw new RangeError(STACK); }
        };
        expect(() => gap.computeCoverageGap(LEFT, [RIGHT], ops)).toThrow(STACK);
    });

    it('its turf ops throw a ClipFailure instead of returning the operand or 0', () => {
        const ops = gap.turfOps(failing(['difference', 'intersect']));
        expect(() => ops.difference(LEFT, RIGHT)).toThrow(A.ClipFailure);
        expect(() => ops.intersectionArea(LEFT, RIGHT)).toThrow(A.ClipFailure);
    });
});

describe('parcel-cut-debug (console tool)', () => {
    it('answers "why uncut" with the overlap failure, and counts the per-road measurement failure', () => {
        require('../../frontend/js/parcel-cut-debug.js');
        const parcel = { ...LEFT, properties: { parcelId: 'HR-1-1' } };
        install('__parcelArrangement', A);
        install('__cadastreAncestry', { loadedCadastreParcels: () => [{ id: 'HR-1-1', feature: parcel }] });
        install('__planOrder', { footprintOf: () => RIGHT });
        install('proposalStorage', { getAllProposals: () => [{ proposalId: 'road-1', title: 'Road', applied: true, roadProposal: {} }] });
        install('turf', failing(['intersect']));
        const before = count('parcel-cut-debug.overlapM2');
        const out = globalThis.whyIsParcelUncut('HR-1-1');
        expect(out.verdict).toMatch(/overlap test THROWS/);
        expect(out.overlapFailed).toMatchObject({ site: 'parcel-arrangement.takeHitsOn', take: 'road-1' });

        // With the arrangement's own overlap test passing, the per-road measurement is the one that fails.
        install('__parcelArrangement', { ...A, takesOverlapping: () => [] });
        const second = globalThis.whyIsParcelUncut('HR-1-1');
        expect(second.overlapM2[0].m2).toMatch(/^error: Maximum call stack/);
        expect(count('parcel-cut-debug.overlapM2')).toBe(before + 1);
    });
});
