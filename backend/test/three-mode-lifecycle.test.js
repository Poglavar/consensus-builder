import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const { createController } = require('../../frontend/js/map-mode-transition.js');
const threeModeSource = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');

function threeModeDeclarations(names) {
    const ast = parse(threeModeSource, { sourceType: 'script' });
    const body = ast.program.body.find(node => node.type === 'ExpressionStatement')
        .expression.callee.body.body;
    const declarations = body.filter(node => node.type === 'FunctionDeclaration'
        && names.includes(node.id.name));
    expect(declarations.map(node => node.id.name).sort()).toEqual([...names].sort());
    return declarations;
}

function loadInContext(declarations, values) {
    const context = vm.createContext(values);
    declarations.forEach(node => {
        vm.runInContext(`${threeModeSource.slice(node.start, node.end)}\nthis.${node.id.name} = ${node.id.name};`, context);
    });
    return context;
}

it('resolves an obsolete mode request as false after a pending scene entry is cancelled', async () => {
    const calls = [];
    let finishSceneEntry;
    const controller = createController({
        loadModel: async () => true,
        enterModel: () => {
            calls.push('enter-model');
            return new Promise(resolve => { finishSceneEntry = resolve; });
        },
        loadPhoto: async () => { calls.push('load-photo'); return true; },
        enterPhoto: async () => { calls.push('enter-photo'); return true; },
        leavePhoto: options => calls.push(`leave-photo:${options.destination}`),
        leaveModel: () => calls.push('leave-model'),
        onChange() {}, onError(error) { throw error; }
    });

    const entering = controller.request('photo');
    await Promise.resolve();
    expect(calls).toContain('enter-model');
    const leaving = controller.request('2d');
    finishSceneEntry(true);

    await expect(entering).resolves.toBe(false);
    await expect(leaving).resolves.toBe(true);
    expect(calls).not.toContain('load-photo');
    expect(calls).not.toContain('enter-photo');
    expect(controller.getState()).toEqual({ desired: '2d', pending: false });
});

it('resolves a caller waiting on scene readiness as false when the pending scene is disposed', async () => {
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const context = loadInContext(threeModeDeclarations(['disposeScene', 'enter3D']), {
        isActive: true,
        sceneReady: false,
        sceneReadyPromise: ready,
        resolveSceneReady: resolveReady,
        warmSceneTimer: null,
        warmSceneKey: null,
        stopSceneWork() {},
        resizeObserver: null,
        handleResize() {},
        cancelLoop() {},
        disposeFloorPlans() {},
        scene: null,
        threeResources: { disposeSharedSubtree() {} },
        window: null,
        stopIntroAutoRotate() {},
        corridorTerrainSampler: null,
        corridorTerrainReferenceGeneration: 0,
        disposeTerrainCorridorGroup() {},
        hideRenderingOverlay() {},
        isTransitioning3D: true,
        controls: null,
        renderer: null,
        parcelClickHandler: null,
        parcelPointerDownHandler: null,
        proposalSelectionUnsubscribe: null,
        clickDownXY: null,
        isolatedParcelId: null,
        isolatedProposalId: null,
        isolationResetEl: null,
        isolationBannerEl: null,
        parcelInfoPanelEl: null,
        displayStateSelects: {},
        representationSelect: null,
        facadeCheckbox: null,
        facadeStyleSelect: null,
        facadeNote: null,
        xrayButton: null,
        xrayNote: null,
        floorCutawayControl: null,
        floorCutawaySelect: null,
        rerollBtn: null,
        rerollBusy: false,
        sceneLoadGeometry: null,
        sceneLoadGeometrySource: 'camera',
        sceneTreeLoadGeometry: null,
        sceneTreeLoadGeometrySource: 'camera',
        waterGroup: null,
        treesGroup: null,
        existingTransitAlignmentGroup: null,
        sceneParcelSnapshot: [],
        nearbyWaterKey: null,
        flatGroup: null,
        corridorGroup: null,
        terrainCorridorGroup: null,
        corridorTerrainProfiles: [],
        plannedFlatGroup: null,
        parkGroundGroup: null,
        squareGroundGroup: null,
        lakeGroundGroup: null,
        proposalGroundGroup: null,
        reparcellizationGroup: null,
        buildingGroup: null,
        floorPlanGroup: null,
        parkGroup: null,
        squareGroup: null,
        lakeGroup: null,
        stationGroup: null,
        proposalInteractionGroup: null,
        proposalDraftGroup: null,
        threeContainer: null,
        buildingModeControlsEl: null,
        buildingModeButtons: {},
        onShowExistingBuildingsChange: null,
        onShowProposedBuildingsChange: null,
        windowResizeRemoved: false,
        windowListeners: [],
        document: { getElementById: () => null },
        windowObject: null,
        console,
        clearTimeout
    });
    context.window = context;
    context.removeEventListener = () => {};

    const entering = context.enter3D();
    context.disposeScene();

    await expect(entering).resolves.toBe(false);
    expect(context.sceneReady).toBe(false);
    expect(context.sceneReadyPromise).toBeNull();
});

it('leaves photo and model synchronously on a photo-to-2D transition without re-entering the model', async () => {
    const calls = [];
    const controller = createController({
        loadModel: async () => true,
        enterModel: async () => { calls.push('enter-model'); return true; },
        loadPhoto: async () => true,
        enterPhoto: async () => { calls.push('enter-photo'); return true; },
        leavePhoto: options => calls.push(`leave-photo:${options.destination}`),
        leaveModel: () => calls.push('leave-model'),
        onChange() {}, onError(error) { throw error; }
    });

    await expect(controller.request('photo')).resolves.toBe(true);
    await expect(controller.request('2d')).resolves.toBe(true);

    expect(calls).toEqual([
        'enter-model', 'enter-photo', 'leave-photo:2d', 'leave-model'
    ]);
});

it('does not reschedule an inactive render frame', () => {
    const scheduled = [];
    const context = loadInContext(threeModeDeclarations(['invalidateThreeView', 'renderFrame']), {
        isActive: false,
        loopRunning: true,
        document: { hidden: false },
        frameId: 17,
        renderInvalidated: false,
        requestAnimationFrame(callback) { scheduled.push(callback); return scheduled.length; },
        cancelAnimationFrame() {}
    });

    context.renderFrame(16);
    context.invalidateThreeView();

    expect(context.frameId).toBeNull();
    expect(context.renderInvalidated).toBe(true);
    expect(scheduled).toHaveLength(0);
});

it('marks pending uploaded-model loads incomplete before the exit path clears their counter', () => {
    let aborted = false;
    const context = loadInContext(threeModeDeclarations(['stopSceneWork']), {
        sceneAbort: { abort() { aborted = true; } },
        buildingBuildPending: false,
        pendingModelLoads: 2,
        buildingWorkIncomplete: false,
        buildingsWorkGeneration: 3,
        buildingsRenderGeneration: 5,
        nearbyProposalBuildingsFetching: true,
        nearbyTreesFetching: true,
        nearbyWaterFetching: true
    });

    context.stopSceneWork();
    context.pendingModelLoads = 0;

    expect(aborted).toBe(true);
    expect(context.buildingWorkIncomplete).toBe(true);
    expect(context.buildingsWorkGeneration).toBe(4);
    expect(context.buildingsRenderGeneration).toBe(6);
    expect(context.nearbyProposalBuildingsFetching).toBe(false);
    expect(context.nearbyTreesFetching).toBe(false);
    expect(context.nearbyWaterFetching).toBe(false);
});

function warmEnterFixture() {
    const center = { lat: 45.8, lng: 15.9 };
    const calls = { init: 0, startLoop: 0, retained: 0, rebuild: 0 };
    const context = loadInContext(threeModeDeclarations(['currentSceneKey', 'enter3D']), {
        map: { getCenter: () => center, getZoom: () => 12 },
        window: null,
        CityConfigManager: null,
        sceneRevision: 4,
        sceneReady: true,
        sceneReadyPromise: null,
        sceneAbort: null,
        scene: {},
        warmSceneKey: null,
        warmSceneTimer: null,
        isActive: false,
        controls: { enabled: false },
        camera: { id: 'retained-camera' },
        renderer: { id: 'retained-renderer' },
        walkBtn: { hidden: false },
        threeContainer: { classList: { add() {} }, removeAttribute() {} },
        document: { body: { classList: { add() {} } } },
        windowMapShell: null,
        MapShell: { closeSheets() {}, setLockedFor3D() {} },
        scheduleViewAngleHint() {},
        updateModeButtonStates() {},
        getWalkUrlBase: () => null,
        showRenderingOverlay() {},
        disableLeafletInteractions() {},
        closeAllPanelsAndModalsFor3D() {},
        handleResize() {},
        startLoop() { calls.startLoop += 1; },
        ensureNearbyProposalBuildings() {},
        ensureNearbyTrees() {},
        ensureNearbyWater() {},
        initScene: async () => { calls.init += 1; return true; },
        buildingViewDirty: false,
        buildingWorkIncomplete: false,
        applyRetainedBuildingDisplay() { calls.retained += 1; return true; },
        rebuild3DBuildingsOnly: async () => { calls.rebuild += 1; },
        activeProposalDraftComparison: null,
        console,
        clearTimeout() {},
        AbortController
    });
    context.window = context;
    context.CityConfigManager = {
        getCurrentCityId: () => 'test-city',
        getBuildingSourceId: () => 'dgu'
    };
    context.MapShell = { closeSheets() {}, setLockedFor3D() {} };
    vm.runInContext('this.warmSceneKey = currentSceneKey();', context);
    return { context, center, calls };
}

it('reuses a warm renderer and camera only when the retained scene key still matches', async () => {
    const same = warmEnterFixture();
    const camera = same.context.camera;
    const renderer = same.context.renderer;
    await expect(same.context.enter3D()).resolves.toBe(true);
    expect(same.calls.init).toBe(0);
    expect(same.calls.startLoop).toBe(1);
    expect(same.context.camera).toBe(camera);
    expect(same.context.renderer).toBe(renderer);

    const changed = warmEnterFixture();
    changed.center.lng += 0.01;
    await expect(changed.context.enter3D()).resolves.toBe(true);
    expect(changed.calls.init).toBe(1);
    expect(changed.calls.startLoop).toBe(0);
});

it('rebuilds cancelled building work on warm resume while retaining material-only display changes', async () => {
    const materialOnly = warmEnterFixture();
    materialOnly.context.buildingViewDirty = true;
    await expect(materialOnly.context.enter3D()).resolves.toBe(true);
    expect(materialOnly.calls.retained).toBe(1);
    expect(materialOnly.calls.rebuild).toBe(0);

    const incomplete = warmEnterFixture();
    incomplete.context.buildingViewDirty = true;
    incomplete.context.buildingWorkIncomplete = true;
    await expect(incomplete.context.enter3D()).resolves.toBe(true);
    expect(incomplete.calls.retained).toBe(0);
    expect(incomplete.calls.rebuild).toBe(1);
    expect(incomplete.context.buildingWorkIncomplete).toBe(false);
});

it('does not let a cancelled warm rebuild restart the render loop after re-entry', async () => {
    const fixture = warmEnterFixture();
    const { context, calls } = fixture;
    context.buildingWorkIncomplete = true;
    let finishRebuild;
    context.rebuild3DBuildingsOnly = () => {
        calls.rebuild += 1;
        return new Promise(resolve => { finishRebuild = resolve; });
    };

    const obsoleteEntry = context.enter3D();
    const obsoleteController = context.sceneAbort;
    expect(calls.startLoop).toBe(0);
    context.isActive = false;
    obsoleteController.abort();
    context.warmSceneKey = context.currentSceneKey();

    await expect(context.enter3D()).resolves.toBe(true);
    expect(calls.startLoop).toBe(1);
    finishRebuild();
    await expect(obsoleteEntry).resolves.toBe(false);
    expect(calls.startLoop).toBe(1);
    expect(calls.rebuild).toBe(1);
});

it('does not apply parcel visibility or emphasis after an async ground rebuild is cancelled', async () => {
    const calls = [];
    let completeBuild;
    const group = { children: [] };
    const context = loadInContext(threeModeDeclarations(['rebuildParcelGround3D']), {
        isActive: true,
        flatGroup: group,
        sceneAbort: new AbortController(),
        parcelGroundGeneration: 0,
        restoreParcelEmphasis() { calls.push('restore'); },
        buildParcels3D() { return new Promise(resolve => { completeBuild = resolve; }); },
        threeResources: { disposeOwnedSubtree() {} },
        derivedParcelVisibilityMode: () => 'built',
        applyParcelVisibilityForMode() { calls.push('visibility'); },
        applyParcelEmphasis() { calls.push('emphasis'); }
    });

    const rebuilding = context.rebuildParcelGround3D();
    context.isActive = false;
    context.sceneAbort.abort();
    completeBuild();
    await rebuilding;

    expect(calls).toEqual(['restore']);
});
