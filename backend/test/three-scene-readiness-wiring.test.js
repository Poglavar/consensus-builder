import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const readiness = require('../../frontend/js/three-scene-readiness.js');
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

function harness({ request = vi.fn(async () => ({ buildings: [] })), build = vi.fn(async () => ({ failures: 0 })) } = {}) {
    const calls = { rebuild: vi.fn(), updates: vi.fn() };
    const window = {
        __threeSceneReadiness: readiness,
        BuildingSourceClient: { request },
        PlanningViews: { getState: () => ({}) },
        clearBuildingsUnavailable: vi.fn(),
        reportBuildingsUnavailable: vi.fn()
    };
    const context = {
        window, console,
        isActive: true, isTransitioning3D: false, renderer: {}, scene: {}, camera: {},
        builtDisplay: 'ghost', realisticLayerActive: false,
        existingBuildingsGroup: { visible: true, children: [] }, proposedBuildingsGroup: { visible: false, children: [] },
        ineligibleBuildingsGroup: { children: [] }, buildingGroup: {}, existingTransitAlignmentGroup: null,
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
        restoreParcelEmphasis: vi.fn(), disposeFloorPlans: vi.fn(),
        buildNearbyProposalBuildings3D: build,
        buildProposedBuildings3D: vi.fn(async () => {}),
        appendSuggestedExistingFloorPlans: vi.fn(), buildIneligibleParcels3D: vi.fn(),
        ensureNearbyTrees: vi.fn(), ensureNearbyWater: vi.fn(), refreshClickStackFigures: vi.fn(),
        updateXrayControls: vi.fn(), updateBuildingsLoader: vi.fn(), updateBuildingsSourceNote: vi.fn(),
        refreshLifeSurface: vi.fn(), reportNearbyBuildingsUnavailable: vi.fn(),
        dedupeCoincidentBuildings: buildings => buildings,
        floorPlanRenderer: { renderCutaway: vi.fn() }, floorPlanGroup: null,
        document: { hidden: false }, loopRunning: true, renderInvalidated: false,
        frameTimer: null, frameId: null,
        requestAnimationFrame: vi.fn(() => 1), clearTimeout: vi.fn(), setTimeout: vi.fn(() => 1),
        frameHooks: [],
    };
    context.nearbyProposalBuildings = [];
    const names = [
        'ensureNearbyProposalBuildings', 'rebuild3DBuildingsOnly', 'renderScene',
        'getSceneReadiness', 'invalidateThreeView', 'queueThreeFrame'
    ];
    vm.createContext(context);
    vm.runInContext(`function renderFrame() {}\n${names.map(name => declarations.get(name)).join('\n')}\n${names.map(name => `this.${name}=${name};`).join('\n')}`, context);
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
        await flushPromises();
        expect(h.context.window.reportBuildingsUnavailable).toHaveBeenCalledWith(null, expect.any(Function), false, 405);
        expect(h.context.nearbyBuildingsOutcome).toBe('failed');
        expect(h.context.getSceneReadiness().ready).toBe(false);
    });

    it.each([
        [{ buildings: [{ id: 'b1' }] }, 'loaded', true],
        [{ buildings: [] }, 'empty', true],
        [{ unavailable: true, buildings: [] }, 'failed', false],
        [{ buildings: [{ id: 'b1' }], partial: true }, 'partial', false],
        [{ supported: false }, 'unsupported', false],
        [{ buildings: [], truncated: true }, 'partial', false]
    ])('connects nearby source response to %s readiness evidence', async (payload, outcome, shouldBeReady) => {
        const request = vi.fn(async () => payload);
        const h = harness({ request });
        h.context.ensureNearbyProposalBuildings();
        expect(h.context.nearbyProposalBuildingsFetching).toBe(true);
        expect(h.context.getSceneReadiness().reasons).toContain('existing-loading');
        await flushPromises();
        expect(request).toHaveBeenCalledWith('/buildings/near', expect.objectContaining({ geometry: { type: 'Point', coordinates: [2, 1] } }), expect.anything());
        expect(h.context.nearbyBuildingsOutcome).toBe(outcome);
        expect(h.context.buildingDisplaySnapshot.existingDataRevision).toBe(h.context.nearbyBuildingsRevision);
        expect(h.context.buildNearbyProposalBuildings3D).toHaveBeenCalledOnce();
        expect(h.context.nearbyBuildingsRevision).toBe(1);
        expect(h.context.getSceneReadiness().ready).toBe(false); // rebuild invalidated the frame
        h.context.renderScene();
        expect(h.context.getSceneReadiness().ready).toBe(shouldBeReady);
    });

    it('does not publish a superseded generation snapshot after the old mesh build finishes', async () => {
        let resolveOld;
        const build = vi.fn()
            .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce({ failures: 0 });
        const h = harness({ build });
        h.context.sceneLoadGeometry = null;
        const first = h.context.rebuild3DBuildingsOnly({ family: 'existing' });
        const second = h.context.rebuild3DBuildingsOnly({ family: 'existing' });
        await second;
        const published = h.context.buildingDisplaySnapshot;
        resolveOld({ failures: 7 });
        await first;
        expect(h.context.buildingDisplaySnapshot).toBe(published);
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

        expect(h.context.buildingDisplaySnapshot).toBeNull();
        expect(h.context.buildingBuildPending).toBe(true);
        finishBuild({ failures: 0 });
        await pending;
        expect(h.context.buildingDisplaySnapshot.existingDataRevision).toBe(12);
        expect(h.context.buildingDisplaySnapshot.existingReady).toBe(true);
        expect(h.context.buildingBuildPending).toBe(false);
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
});
