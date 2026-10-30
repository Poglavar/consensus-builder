import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const readiness = require('../../frontend/js/three-scene-readiness.js');
const sceneWork = require('../../frontend/js/three-scene-work.js');
const buildingCells = require('../../frontend/js/building-cells.js');
const turf = require('@turf/turf');
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
const declarations = new Map();
function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    Object.keys(node).forEach(key => {
        if (key === 'loc' || key === 'start' || key === 'end') return;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect);
        else collect(value);
    });
}
collect(ast);

// `request` answers one building cell ({ kind, source, bbox }), as POST /buildings/cell does.
function harness({ request = vi.fn(async () => ({ items: [], complete: true })), build = vi.fn(async () => ({ failures: 0 })) } = {}) {
    const calls = { rebuild: vi.fn(), updates: vi.fn() };
    const window = {
        __threeSceneReadiness: readiness,
        SourceList: { inUse: () => ['city'] },
        BuildingCells: buildingCells,
        BuildingCellLoader: buildingCells.createCellLoader({ request: cell => request(cell) }),
        CityConfigManager: { getParcelGridSize: () => 0.0025, datasetToLatLng: (easting, northing) => [northing, easting], getBuildingSources: () => [] },
        wgs84ToDataset: (lat, lng) => [lng, lat],
        PlanningViews: { getState: () => ({}) },
        clearBuildingsUnavailable: vi.fn(),
        reportBuildingsUnavailable: vi.fn()
    };
    const context = {
        window, console, THREE, turf, sunLayer: null,
        isActive: true, isTransitioning3D: false, renderer: {}, scene: {}, camera: {},
        builtDisplay: 'ghost', realisticLayerActive: false,
        existingBuildingsGroup: new THREE.Group(), proposedBuildingsGroup: new THREE.Group(),
        ineligibleBuildingsGroup: new THREE.Group(), buildingGroup: new THREE.Group(), existingTransitAlignmentGroup: null,
        buildingBuildPending: false, buildingWorkIncomplete: false, buildingViewDirty: false,
        buildingDisplaySnapshot: null, renderedBuildingDisplaySnapshot: null,
        sceneVisualRevision: 0, renderedSceneVisualRevision: -1,
        nearbyBuildingsRevision: 0, nearbyProposalBuildings: [], nearbyProposalBuildingsFetching: false,
        nearbyProposalBuildingsKey: null, nearbyBuildingsOutcome: null, nearbyBuildingsProvenance: null,
        nearbyDataScope: 'scope-a', NEARBY_BUILDINGS_KEY_PRECISION: 0.0001,
        sceneLoadGeometry: { type: 'Point', coordinates: [2, 1] },
        sceneLoadGeometrySource: 'proposal', sceneAbort: null, buildingLoadRadiusM: 300,
        pendingModelLoads: 0, buildingsWorkGeneration: 0, buildingsRenderGeneration: 0,
        xrayEnabled: false, plannedDisplay: 'off', showIneligibleParcels: false,
        isolatedParcelId: null, isolatedProposalId: null,
        buildingMaterials: { solid: {}, ghost: {} },
        buildingDisplayPolicy: { resolveBuiltDisplayPolicy: () => ({ visible: true, material: 'ghost', showSurviving: true, showDemolished: true, showExistingRail: false }) },
        clearGroupChildren: group => { group.children = []; },
        retireGroupAfterFrame: group => { group.children = []; },
        restoreParcelEmphasis: vi.fn(), disposeFloorPlans: vi.fn(),
        buildNearbyProposalBuildings3D: build,
        buildProposedBuildings3D: vi.fn(async () => {}),
        appendSuggestedExistingFloorPlans: vi.fn(), buildIneligibleParcels3D: vi.fn(),
        ensureNearbyTrees: vi.fn(), ensureNearbyWater: vi.fn(), ensureNearbyGreen: vi.fn(), refreshClickStackFigures: vi.fn(),
        updateXrayControls: vi.fn(), updateBuildingsLoader: vi.fn(), updateBuildingsSourceNote: vi.fn(),
        refreshLifeSurface: vi.fn(), reportNearbyBuildingsUnavailable: vi.fn(),
        dedupeCoincidentBuildings: buildings => buildings,
        floorPlanRenderer: { renderCutaway: vi.fn() }, floorPlanGroup: null, updateLampGlow: vi.fn(), updateSkyAndWindows: vi.fn(), retierTreesIfMoved: vi.fn(), rebuildProposalGrounds3D: vi.fn(),
        document: { hidden: false }, loopRunning: true, renderInvalidated: false,
        frameTimer: null, frameId: null, hooksParked: false, lastInputAt: 0,
        requestAnimationFrame: vi.fn(() => 1), clearTimeout: vi.fn(), setTimeout: vi.fn(() => 1),
        frameHooks: [],
    };
    context.nearbyProposalBuildings = [];
    context.buildingGroup.add(context.existingBuildingsGroup, context.proposedBuildingsGroup);
    const names = [
        'ensureNearbyProposalBuildings', 'rebuild3DBuildingsOnly', 'build3DBuildingFamilies', 'renderScene',
        'getSceneReadiness', 'invalidateThreeView', 'queueThreeFrame', 'scheduleThreeFrame', 'threeBuildingKey'
    ];
    vm.createContext(context);
    vm.runInContext(`function renderFrame() {}\n${names.map(name => declarations.get(name)).join('\n')}\n${names.map(name => `this.${name}=${name};`).join('\n')}`, context);
    context.buildingRefreshQueue = sceneWork.createRefreshQueue(family => context.build3DBuildingFamilies(family));
    calls.context = context;
    return calls;
}

async function flushPromises() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('3D readiness wiring', () => {
    it('retains a backend rejection status through the nearby-building banner and keeps readiness failed', async () => {
        const request = vi.fn(async () => { throw Object.assign(new Error('HTTP 405'), { status: 405 }); });
        const h = harness({ request });
        h.context.console = { warn: vi.fn(), log: vi.fn() };
        vm.runInContext(declarations.get('reportNearbyBuildingsUnavailable'), h.context);
        h.context.ensureNearbyProposalBuildings();
        for (let i = 0; i < 20 && h.context.nearbyProposalBuildingsFetching; i++) await flushPromises();
        expect(h.context.window.reportBuildingsUnavailable).toHaveBeenCalledWith(null, expect.any(Function), 'city', 405);
        // Our server refusing the request fails the cell outright: no stand-in hides it.
        expect(request.mock.calls.every(([call]) => call.source === 'city')).toBe(true);
        expect(h.context.nearbyBuildingsOutcome).toBe('failed');
        expect(h.context.getSceneReadiness().ready).toBe(false);
    });

    it.each([
        [{ items: [{ object_id: 'b1', faces: [] }], complete: true }, 'loaded', true],
        [{ items: [], complete: true }, 'empty', true],
        [{ unavailable: true }, 'failed', false],
        [{ items: [{ object_id: 'b1', faces: [] }], complete: false }, 'partial', false],
        [{ supported: false }, 'unsupported', false]
    ])('connects nearby cell answers %s to readiness evidence', async (payload, outcome, shouldBeReady) => {
        // A building is filed under the cell holding its first vertex: put it in the cell asked for.
        const request = vi.fn(async ({ bbox }) => (payload.items
            ? { ...payload, items: payload.items.map(item => ({ ...item, faces: [{ coordinates: [[[bbox[0] + 1e-7, bbox[1] + 1e-7, 0], [bbox[0] + 2e-7, bbox[1] + 1e-7, 0], [bbox[0] + 1e-7, bbox[1] + 2e-7, 0], [bbox[0] + 1e-7, bbox[1] + 1e-7, 0]]] }] })) }
            : payload));
        const h = harness({ request });
        h.context.ensureNearbyProposalBuildings();
        expect(h.context.nearbyProposalBuildingsFetching).toBe(true);
        expect(h.context.getSceneReadiness().reasons).toContain('existing-loading');
        await flushPromises();
        // The cells around the anchor, nearest first, each from the city source.
        expect(request.mock.calls.length).toBeGreaterThan(1);
        expect(request.mock.calls[0][0]).toMatchObject({ kind: 'near', source: 'city' });
        const [w, s, e, n] = request.mock.calls[0][0].bbox;
        expect([w <= 2, e >= 2, s <= 1, n >= 1]).toEqual([true, true, true, true]);
        for (let i = 0; i < 8 && h.context.buildingRefreshQueue.pending; i++) await flushPromises();
        expect(h.context.nearbyBuildingsOutcome).toBe(outcome);
        expect(h.context.buildingDisplaySnapshot.existingDataRevision).toBe(h.context.nearbyBuildingsRevision);
        expect(h.context.buildNearbyProposalBuildings3D).toHaveBeenCalled();
        expect(h.context.getSceneReadiness().ready).toBe(false); // rebuild invalidated the frame
        h.context.renderScene();
        expect(h.context.getSceneReadiness().ready).toBe(shouldBeReady);
    });

    it('finishes the current build before refreshing only the arriving source family', async () => {
        let resolveOld;
        const build = vi.fn()
            .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce({ failures: 0 });
        const h = harness({ build });
        h.context.sceneLoadGeometry = null;
        h.context.plannedDisplay = 'solid';
        const first = h.context.rebuild3DBuildingsOnly();
        await Promise.resolve();
        const second = h.context.rebuild3DBuildingsOnly({ family: 'existing' });
        expect(build).toHaveBeenCalledOnce();
        resolveOld({ failures: 7 });
        await Promise.all([first, second]);
        expect(h.context.buildProposedBuildings3D).toHaveBeenCalledOnce();
        expect(h.context.buildingDisplaySnapshot.existingBuildFailures).toBe(0);
        expect(h.context.buildingsWorkGeneration).toBe(2);
    });

    it('waits for the existing mesh build and stamps the source revision it built', async () => {
        let finishBuild;
        const build = vi.fn(() => new Promise(resolve => { finishBuild = resolve; }));
        const h = harness({ build });
        h.context.sceneLoadGeometry = null;
        h.context.nearbyBuildingsRevision = 12;
        const pending = h.context.rebuild3DBuildingsOnly({ family: 'existing' });
        await Promise.resolve();

        expect(h.context.buildingDisplaySnapshot).toBeNull();
        expect(h.context.buildingBuildPending).toBe(true);
        finishBuild({ failures: 0 });
        await pending;
        expect(h.context.buildingDisplaySnapshot.existingDataRevision).toBe(12);
        expect(h.context.buildingDisplaySnapshot.existingReady).toBe(true);
        expect(h.context.buildingBuildPending).toBe(false);
    });

    it('keeps the displayed buildings until the entire replacement is ready', async () => {
        let finish;
        const replacement = new THREE.Object3D();
        const h = harness({ build: async target => {
            target.add(replacement);
            await new Promise(resolve => { finish = resolve; });
            return { failures: 0 };
        } });
        const c = h.context;
        c.sceneLoadGeometry = null;
        const original = c.existingBuildingsGroup;
        original.add(new THREE.Object3D());
        const refresh = c.rebuild3DBuildingsOnly({ family: 'existing' });
        await Promise.resolve();
        expect(c.buildingGroup.children).toContain(original);
        expect(original.children).toHaveLength(1);
        expect(replacement.parent.parent).toBeNull();
        finish();
        await refresh;
        expect(c.buildingGroup.children).not.toContain(original);
        expect(c.existingBuildingsGroup.children).toEqual([replacement]);
        expect(original.children).toHaveLength(0);
    });

    it('discards an aborted replacement without removing the displayed buildings', async () => {
        let finish;
        let staged;
        const h = harness({ build: async target => {
            staged = target;
            target.add(new THREE.Object3D());
            await new Promise(resolve => { finish = resolve; });
            return { failures: 0 };
        } });
        const c = h.context;
        c.sceneLoadGeometry = null;
        c.sceneAbort = new AbortController();
        const original = c.existingBuildingsGroup;
        original.add(new THREE.Object3D());
        const refresh = c.rebuild3DBuildingsOnly({ family: 'existing' });
        await Promise.resolve();
        c.sceneAbort.abort();
        c.buildingRefreshQueue.cancel();
        finish();
        await refresh;
        expect(c.existingBuildingsGroup).toBe(original);
        expect(original.children).toHaveLength(1);
        expect(staged.children).toHaveLength(0);
        expect(c.buildingDisplaySnapshot).toBeNull();
    });

    it('distinguishes queued frames from visual invalidation in readiness evidence', () => {
        const h = harness();
        const c = h.context;
        c.nearbyBuildingsOutcome = 'loaded';
        c.buildingDisplaySnapshot = { existingReady: true, existingDataRevision: 0, existingBuildFailures: 0 };
        c.renderedBuildingDisplaySnapshot = c.buildingDisplaySnapshot;
        c.renderedSceneVisualRevision = c.sceneVisualRevision;
        expect(c.getSceneReadiness().ready).toBe(true);
        c.queueThreeFrame();
        expect(c.getSceneReadiness().ready).toBe(true);
        c.invalidateThreeView();
        expect(c.getSceneReadiness().reasons).toContain('frame-pending');
        c.renderScene();
        expect(c.getSceneReadiness().ready).toBe(true);
    });

    it('applies sun lighting before the first entry frame and retains the life-only shadow optimization', () => {
        const h = harness();
        const order = [];
        h.context.sunLayer = { beforeRender: options => order.push(['sun', options.fullFrame]) };
        h.context.floorPlanRenderer.renderCutaway = () => order.push(['draw']);
        h.context.renderScene();
        h.context.renderScene(false);
        expect(order).toEqual([['sun', true], ['draw'], ['sun', false], ['draw']]);
    });
});
