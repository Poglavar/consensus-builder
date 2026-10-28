// Integration contract for drawing completion: each placed edge FINDS its obstacles and F reviews
// them once (road-editor.md decision 5); F is a single-flight action that cannot invoke
// cut/demolish/tunnel discovery of its own. Drives the real road-drawing.js in the fake browser
// world (helpers/road-drawing-env.js) with the detectors and dialogs as recording stand-ins; the
// load order (index.html) and the cross-section editor's call (corridor-editor.js) stay source checks.
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadRoadDrawing, at, boxRing } from './helpers/road-drawing-env.js';

const editorSource = readFileSync(new URL('../../frontend/js/corridor-editor.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// Every call to a recorded stand-in, in order, with what the tool looked like at the time.
let log;
function recorder(name, impl = () => undefined) {
    return (...args) => {
        log.push({
            name,
            busy: env.document.body.classList.contains('corridor-busy'),
            indicator: env.session.corridorApplyIndicatorCount,
            built: globalThis.instantCreateProposalFromDraft.calls.length
        });
        return impl(...args);
    };
}
const named = prefix => log.filter(entry => entry.name.startsWith(prefix)).map(entry => entry.name);

const BUILDING = { type: 'Feature', properties: { id: 'b1' }, geometry: { type: 'Polygon', coordinates: [boxRing(40, -10, 60, 10)] } };
const PARK = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [boxRing(70, -20, 90, 20)] } };

// Detectors that find one of everything on every edge, and dialogs that answer so the road builds.
function obstacles(answers = {}) {
    return {
        detectLoadedBuildingTunnelIntersections: recorder('detect:buildings', () => [{ id: 'b1', feature: BUILDING }]),
        detectPlotCrossings: recorder('detect:plots', () => ({ plots: [{ proposalId: 'sub-1', count: 1, areaM2: 50 }], blocked: [] })),
        detectStructureCrossings: recorder('detect:structures', () => [{ id: 'park-1', kind: 'park', feature: PARK }]),
        detectPedestrianRoadCrossings: recorder('detect:crossings', () => [{ proposalId: 'walk-1', point: at(80, 0) }]),
        ensureBuildingFootprintsForBounds: recorder('detect:footprints', async () => {}),
        resolvePlotCrossings: recorder('ask:plots', async () => answers.plots ?? true),
        resolveBuildingObstacles: recorder('ask:buildings', async () => ({ action: answers.buildings ?? 'surface' })),
        resolveStructureCrossings: recorder('ask:structures', async () => answers.structures ?? true),
        buildPedestrianCrossingPrompt: crossings => ({ message: `${crossings.length} crossing`, choices: [] }),
        showStyledChoice: recorder('ask:crossings', async () => answers.crossings ?? 'at-grade'),
        resolvePedestrianRoadCrossings: recorder('ask:per-edge-crossings', async () => true)
    };
}

async function drawRoad(globals = {}) {
    log = [];
    env = loadRoadDrawing({ globals });
    await env.api.requestCorridorDrawingTool('road');
    await env.click(at(0, 0));
    await env.click(at(100, 0));
    expect(env.session.roadSegments[0]).toHaveLength(2);
}

const built = () => globalThis.instantCreateProposalFromDraft.calls.length;

describe('road drawing finalization contract', () => {
    it('loads the finalization gate before the drawing script', () => {
        expect(indexSource.indexOf("'js/road-finalization-state.js'")).toBeGreaterThanOrEqual(0);
        expect(indexSource.indexOf("'js/road-finalization-state.js'"))
            .toBeLessThan(indexSource.indexOf("'js/road-drawing-loader.js'"));
    });

    it('ignores key repeat and funnels every finish trigger through one gate', async () => {
        await drawRoad();
        // A held F repeats: the repeat builds nothing.
        env.key('f', { repeat: true });
        await env.idle();
        expect(built()).toBe(0);
        // Every trigger at once — F, Enter, the map's double-click, the Finish button, the API —
        // is one run of the one gate, and one build.
        const first = env.api.finishRoadDrawing();
        expect(env.api.finishRoadDrawing()).toBe(first);
        env.key('f');
        env.key('Enter');
        env.map.fire('dblclick', {});
        env.api.finishRoadOrTrackDrawing();
        expect(env.session.roadFinalizationGate.isRunning()).toBe(true);
        await env.idle();
        expect(built()).toBe(1);
        expect(env.session.roadDrawingMode).toBe(false);
    });

    // This was "does not discover or prompt for building impacts while handling F": every edge asked
    // at its click. Since road-editor.md decision 5 the clicks only record, and F asks ONCE for the
    // whole drawing — so F prompts now, but still discovers nothing of its own.
    it('reviews the recorded obstacles once, before building, and discovers nothing at F', async () => {
        await drawRoad(obstacles());
        // The click found everything and asked nothing.
        expect(named('ask:')).toEqual([]);
        expect(named('detect:').length).toBeGreaterThan(0);
        log.length = 0;

        env.key('f');
        await env.idle();
        // The fixed order: plots, buildings (one answer for all), parks/squares/lakes, crossings —
        // one dialog for the crossings, not per edge.
        expect(named('ask:')).toEqual(['ask:plots', 'ask:buildings', 'ask:structures', 'ask:crossings']);
        // Before the build, and before the busy indicator (no "Building the road…" under a question).
        log.forEach(entry => {
            expect(entry.busy, entry.name).toBe(false);
            expect(entry.indicator, entry.name).toBe(0);
            expect(entry.built, entry.name).toBe(0);
        });
        // F discovered nothing of its own: no detector ran and no footprints were fetched.
        expect(named('detect:')).toEqual([]);
        expect(built()).toBe(1);
        // The building kept at surface is remembered; nothing was demolished or tunnelled.
        expect(globalThis.pendingRoadDrawingProposal.tunnels).toEqual([]);
    });

    it('builds without a question when nothing was in the way, and asks nothing after the review', async () => {
        log = [];
        const quiet = obstacles();
        ['detectLoadedBuildingTunnelIntersections', 'detectStructureCrossings', 'detectPedestrianRoadCrossings']
            .forEach(name => { quiet[name] = recorder(`detect:${name}`, () => []); });
        quiet.detectPlotCrossings = recorder('detect:plots', () => ({ plots: [], blocked: [] }));
        await drawRoad(quiet);
        log.length = 0;
        env.key('f');
        await env.idle();
        expect(named('ask:')).toEqual([]);
        expect(named('detect:')).toEqual([]);
        expect(built()).toBe(1);
    });

    it('a refused review builds nothing and leaves the drawing open', async () => {
        await drawRoad(obstacles({ structures: false }));
        env.key('f');
        await env.idle();
        expect(named('ask:')).toEqual(['ask:plots', 'ask:buildings', 'ask:structures']);
        expect(built()).toBe(0);
        expect(env.session.roadDrawingMode).toBe(true);
        expect(env.lastStatus()).toBe('Not built — 1 park in the way. Undo or reroute around the red rings, then finish again.');
    });

    // Was "commits cross-record junction topology inside the Finish transaction" (atomicCorridorAuthoring:
    // true in the source): road-drawing.characterization.test.js 'F builds: one draft in the store, one
    // atomic create, …' asserts the create's options are exactly { atomicCorridorAuthoring: true }.

    it('commits changed-width authored tunnels without running demolition scans', async () => {
        log = [];
        const tunnel = { buildingIds: ['b1'], from: at(40, 0), to: at(60, 0) };
        await drawRoad({
            ...obstacles(),
            retainLiveCorridorTunnelRecords: recorder('retain:tunnels', (_segments, records) => records)
        });
        env.session.roadBuildingTunnels = [tunnel];
        globalThis.setRoadDrawingProfile(globalThis.corridorProfileFromLegacy(12, 2, false));
        expect(env.session.roadDrawingProfileValidationPending).toBe(true);
        log.length = 0;

        await expect(globalThis.validateRoadDrawingProfileImpacts()).resolves.toBe(true);
        // The authored tunnel survives (its edge still exists), no question is asked, nothing is scanned.
        expect(named('retain:')).toEqual(['retain:tunnels']);
        expect(env.session.roadBuildingTunnels).toEqual([tunnel]);
        expect(named('ask:')).toEqual([]);
        expect(named('detect:')).toEqual([]);
        expect(env.session.roadDrawingProfileValidationPending).toBe(false);
        expect(editorSource).toContain('await window.validateRoadDrawingProfileImpacts();');
    });

    it('does not allow F to race a segment whose placement check is still running', async () => {
        const loads = [];
        let hold = false;
        await drawRoad({ ensureBuildingFootprintsForBounds: () => (hold ? new Promise(resolve => loads.push(resolve)) : Promise.resolve()) });
        hold = true;
        const before = loads.length;
        const placing = env.click(at(200, 0));
        while (loads.length <= before) await new Promise(resolve => setTimeout(resolve, 0));
        expect(env.session.roadSegmentPlacementInProgress).toBe(true);
        // F waits for the placement, as the Finish button and a double-click do; a finish reaching
        // the gate directly meanwhile is refused with a reason.
        env.key('f');
        expect(env.session.roadFinalizationGate.isRunning()).toBe(false);
        await expect(env.api.finishRoadDrawing()).resolves.toBe(false);
        expect(env.lastStatus()).toBe('Wait for the current segment to finish validating.');
        expect(built()).toBe(0);
        loads.forEach(resolve => resolve());
        await placing;
        await env.idle();
        // The queued F built the road once, with the point that was being placed.
        expect(built()).toBe(1);
        expect(globalThis.pendingRoadDrawingProposal.centerline[0]).toHaveLength(3);
    });
});

describe('editing a saved road: one parcel mutation, its corridor scope only', () => {
    const PARCEL = { id: 'HR-1', ring: boxRing(20, -15, 60, 15) };

    // The ProposalManager methods the edit reached, and every global the old edit paths used.
    function loadWithRecordedManager(record) {
        const reached = [];
        const retired = {};
        ['unapplyProposal', 'createRoadProposalFromComponent', 'corridorConnectedComponents', 'weldNearbyVertices',
            'healNearMissJunctions', 'resolveBuildingObstacles', 'detachPublishedIdentity']
            .forEach(name => { retired[name] = (...args) => { reached.push(name); return args[0]; }; });
        env = loadRoadDrawing({ parcels: [PARCEL], globals: retired });
        const real = globalThis.ProposalManager;
        let thrown = null;
        let mutation = null;
        const calls = [];
        real.runParcelMutation = Object.assign(async (kind, id, run) => {
            calls.push([kind, id]);
            mutation = { proposals: env.store, afterCommit: callback => callback() };
            try { return await run({ _parcelMutation: mutation }); } catch (error) { thrown = error; throw error; }
        }, { calls });
        globalThis.ProposalManager = new Proxy(real, {
            get(target, name) {
                if (typeof target[name] === 'function') reached.push(String(name));
                return target[name];
            }
        });
        Object.assign(env.store, {
            beginBatch: () => reached.push('beginBatch'),
            endBatch: () => reached.push('endBatch')
        });
        env.store.addProposal(record);
        return { reached, manager: real, thrown: () => thrown, mutation: () => mutation };
    }

    const localRoad = (points = [[at(0, 0), at(100, 0)]], segmentIds = ['s1']) => ({
        proposalId: 'road-1', applied: true, title: 'Road', cadastreParcelIds: ['HR-1'],
        createdAt: '2026-01-01T00:00:00.000Z',
        roadProposal: { definition: { points, segmentIds, width: 7.5, profile: null } }
    });

    it('edits the road in place and rematerialises only its corridor scope', async () => {
        const record = localRoad([[at(0, 0), at(100, 0)], [at(100, 0), at(100, 100)]], ['s1', 's2']);
        const { reached, manager } = loadWithRecordedManager(record);
        record.roadProposal.definition.profile = globalThis.corridorProfileFromLegacy(7.5, 1, false);
        // One stretch moves away: the road is split, in the same mutation and the same derivation.
        const result = await globalThis.updateLocalCorridorGeometry('road-1', definition => {
            definition.points[1] = [at(300, 0), at(300, 100)];
        });
        expect(result).toBe('road-1');
        expect(env.store.getProposal('road-1')).toBe(record);
        expect(env.store.addProposal.calls).toHaveLength(2);   // the fixture, and the split-off stretch
        expect(manager.rematerializeCorridorScope.calls).toHaveLength(1);
        // Only the parcel mutation, the corridor derivation and the UI refresh were reached — no flat
        // resolver, fabric rebuild, unapply or old healing/merging pass.
        expect([...new Set(reached)].sort()).toEqual(['_refreshUIAfterProposalChange', 'rematerializeCorridorScope', 'runParcelMutation']);
        expect(record.roadProposal.definition.demolishedBuildings).toBeUndefined();
    });

    it('serializes the record flip and rematerialization in one parcel mutation', async () => {
        const record = localRoad();
        const { reached, manager, thrown, mutation } = loadWithRecordedManager(record);
        record.roadProposal.definition.profile = globalThis.corridorProfileFromLegacy(7.5, 1, false);
        // A node drag painted through the record; the edit starts from the snapshot taken before it.
        const snapshot = JSON.parse(JSON.stringify(record.roadProposal.definition));
        record.roadProposal.definition.points[0][1] = at(120, 0);
        globalThis.getProposalByIdOrHash = id => env.store.getProposal(id);
        let definitionWhenMutationStarted = null;
        const run = manager.runParcelMutation;
        manager.runParcelMutation = Object.assign(async (...args) => {
            definitionWhenMutationStarted = JSON.parse(JSON.stringify(env.store.getProposal('road-1').roadProposal.definition));
            return run(...args);
        }, { calls: run.calls });

        expect(await globalThis.updateLocalCorridorGeometry('road-1', definition => {
            definition.points[0][1] = at(150, 0);
        }, { preEditSnapshot: snapshot })).toBe('road-1');
        expect(definitionWhenMutationStarted.points).toEqual(snapshot.points);
        expect(run.calls).toEqual([['corridor-edit', 'road-1']]);
        // The derivation runs inside that mutation, on the record as it was before and as it is now.
        const [[scope, options]] = manager.rematerializeCorridorScope.calls;
        expect(options._parcelMutation).toBe(mutation());
        expect(scope[0]).not.toBe(record);
        expect(scope[0].roadProposal.definition.points).toEqual(snapshot.points);
        expect(scope[1]).toBe(record);
        expect(reached).not.toContain('beginBatch');
        expect(reached).not.toContain('endBatch');

        // A derivation that fails throws through the mutation, which discards the drafts together.
        manager.rematerializeCorridorScope = Object.assign(async () => ({ ok: false }), { calls: [] });
        const failures = [];
        expect(await globalThis.updateLocalCorridorGeometry('road-1', definition => {
            definition.points[0][1] = at(170, 0);
        }, { onFailure: reason => failures.push(reason) })).toBe(false);
        expect(thrown().message).toBe('The edited road scope could not be rematerialised from the cadastre.');
        expect(failures).toEqual(['Could not complete that road change — reverted.']);
    });
});

describe('the live parcel tessellation while drawing', () => {
    it('never strips click handlers from the live parcel tessellation while drawing', async () => {
        env = loadRoadDrawing({ parcels: [{ id: 'HR-1', ring: boxRing(20, -15, 60, 15) }] });
        // The parcel's layer is on the map with its click handler, reachable by every iteration path.
        const layer = globalThis.ParcelPresenter.getLayer('HR-1');
        const offs = [];
        layer.off = (...args) => { offs.push(args); return layer; };
        env.map.addLayer(layer);
        env.map.eachLayer = callback => [...env.map.layers].forEach(callback);
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await env.click(at(100, 0));
        globalThis.showStyledChoice = async () => 'discard';
        await env.api.cancelRoadDrawing();
        expect(offs).toEqual([]);
        expect(globalThis.restoreParcelClickInteractivity).toBeUndefined();
    });
});
