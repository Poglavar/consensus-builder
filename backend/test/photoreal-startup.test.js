// Generic elevation recovery and bounded startup, including the detached-terrain regression.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const ground = require('../../frontend/js/photoreal-ground.js');

function findFunction(node, name) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node;
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                const found = findFunction(child, name);
                if (found) return found;
            }
        } else if (value && typeof value === 'object') {
            const found = findFunction(value, name);
            if (found) return found;
        }
    }
    return null;
}

function bootstrapFixture({ hits = true, absoluteHeight = 120 } = {}) {
    const scene = { parent: null, updateMatrixWorld: vi.fn() };
    const seatNode = { position: { z: 0 } };
    const camera = { position: { x: 8, y: 9, z: 10 } };
    const worldUpdates = vi.fn();
    const raycasts = vi.fn();
    class Vector3 {
        constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    }
    class Raycaster {
        constructor() { this.ray = { applyMatrix4: vi.fn() }; }
        intersectObject() {
            raycasts();
            if (!hits) return [];
            const height = absoluteHeight + seatNode.position.z;
            return [{ point: { clone: () => ({ applyMatrix4: () => ({ z: height }) }) } }];
        }
    }
    const matrixWorld = { clone: () => ({ invert() { return this; } }) };
    const context = vm.createContext({
        bootstrapAttempts: 0,
        MAX_BOOTSTRAP_ATTEMPTS: 8,
        bootstrapRevision: -1,
        tileContentRevision: 1,
        seatNode,
        tiles: { group: { matrixWorld } },
        internals: { camera },
        loadedTileScenes: new Set([scene]),
        loadedTileDepths: new Map([[scene, 10]]),
        scaleNode: { updateMatrixWorld: worldUpdates },
        LOCK_PROBE_OFFSETS: [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]],
        window: { THREE: { Vector3, Raycaster }, __photorealGround: ground },
        console: { info: vi.fn() }
    });
    const source = readFileSync(new URL('../../frontend/js/photoreal-mode.js', import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script' });
    const declaration = findFunction(ast, 'bootstrapGround');
    if (!declaration) throw new Error('bootstrapGround function not found');
    const bootstrapGround = vm.runInContext(`(${source.slice(declaration.start, declaration.end)})`, context);
    return { context, bootstrapGround, seatNode, camera, scene, worldUpdates, raycasts,
        setAbsoluteHeight: value => { absoluteHeight = value; } };
}

function lockFixture({ progress = 1, quietMs = 2000, initialSamples = [] } = {}) {
    const seatNode = { position: { z: 0 } };
    const setStatus = vi.fn();
    const setRealisticLayerActive = vi.fn();
    const lockSamples = initialSamples.slice();
    let nowMs = quietMs;
    const tiles = { loadProgress: progress, group: { visible: false, children: [] } };
    class Vector3 {
        constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
        set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
    }
    class Raycaster {
        constructor() {}
        intersectObject() { return [{ point: { z: 42 } }]; }
    }
    const context = vm.createContext({
        lockWaitS: 0,
        lockAccumS: 0,
        LOCK_SAMPLE_INTERVAL_S: 0.25,
        LOCK_PROBE_OFFSETS: [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60],
            [120, 60], [-120, 60], [120, -60], [-120, -60], [180, 0], [-180, 0], [0, 180], [0, -180]],
        LOCK_MAX_WAIT_S: 12,
        FAR_EARTH_LIMIT_M: 1500,
        LOCK_STABLE_SAMPLES: 3,
        LOCK_STABLE_SPREAD_M: 1.5,
        GROUND_BELOW_CONTENT_M: 0.2,
        seatNode,
        tiles,
        profT: null,
        performance: { now: () => nowMs },
        window: { THREE: { Vector3, Raycaster }, __photorealGround: ground,
            setRealisticLayerActive },
        lastTileContentAt: 0,
        bootstrapGround: vi.fn(() => false),
        reportedProbeFamine: false,
        loadedTileScenes: new Set(),
        lockSamples,
        lastProbeSummary: null,
        lockedGroundZ: null,
        grounded: false,
        setStatus,
        cancelTerrainGridBuild: vi.fn(),
        terrainGrid: {},
        groundTexture: null,
        corridorUniforms: { uGroundTex: { value: {} } },
        resetTerrainRefreshTracking: vi.fn(),
        buildMaskShapes: vi.fn(),
        renderCarveMask: vi.fn(),
        scheduleSettledTerrainRefresh: vi.fn(),
        builtVisible: true,
        attributionDirty: false,
        console: { log: vi.fn(), warn: vi.fn() }
    });
    const source = readFileSync(new URL('../../frontend/js/photoreal-mode.js', import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script' });
    const declaration = findFunction(ast, 'tryLockGround');
    if (!declaration) throw new Error('tryLockGround function not found');
    const tryLockGround = vm.runInContext(`(${source.slice(declaration.start, declaration.end)})`, context);
    return { context, tryLockGround, seatNode, tiles, lockSamples, setStatus, setRealisticLayerActive,
        setProgress: value => { tiles.loadProgress = value; }, setNow: value => { nowMs = value; } };
}

describe('photoreal bootstrap height selection', () => {
    it.each([
        ['near sea level', [0.1, 0.3, 0.8], 0.1],
        ['around 1,250 m', [1249, 1250, 1251], 1249],
        ['around 2,850 m', [2849, 2850, 2851], 2849],
        ['around 3,650 m above the old cutoff', [3649, 3650, 3651], 3649],
        ['below sea level', [-45, -44, -43], -45]
    ])('accepts plausible absolute elevations %s', (_label, heights, expected) => {
        const probes = heights.map(height => [{ height, depth: 5 }]);
        expect(ground.selectBootstrapHeight(probes, 0)).toBe(expected);
    });

    it('prefers the finer tile hit over a coarser high surface at each probe', () => {
        const probes = Array.from({ length: 4 }, () => [
            { height: 3650, depth: 1 },
            { height: 2850, depth: 3 },
            { height: 1250, depth: 8 }
        ]);
        expect(ground.selectBootstrapHeight(probes, 0)).toBe(1250);
    });

    it('uses p25 to avoid one roof sample and requires at least three valid probes', () => {
        const probes = [[120], [121], [119], [3700]].map(([height]) => [{ height, depth: 2 }]);
        expect(ground.selectBootstrapHeight(probes, 0)).toBe(120);
        expect(ground.selectBootstrapHeight(probes.slice(0, 2), 0)).toBeNull();
        expect(ground.selectBootstrapHeight([[{ height: 120 }], [{ height: 121 }], [{ height: 119 }]], 0)).toBe(119);
    });

    it('rejects false-earth elevations outside the supported range and accepts its bounds', () => {
        expect(ground.selectBootstrapHeight([
            [{ height: -601 }], [{ height: 9001 }], [{ height: 20000 }]
        ], 0)).toBeNull();
        expect(ground.selectBootstrapHeight([
            [{ height: -600 }], [{ height: 9000 }], [{ height: 20 }]
        ], 0)).toBe(-600);
    });

    it('uses the existing seat offset to validate elevation while retaining the selected hit height', () => {
        const offset = 10000;
        const probes = [[11250], [11251], [11252]].map(([height]) => [{ height, depth: 5 }]);
        expect(ground.selectBootstrapHeight(probes, offset)).toBe(11250);
        expect(ground.selectBootstrapHeight(probes, 0)).toBeNull();
    });
});

describe('photoreal empty-content timeout timer', () => {
    it('stays finite through prolonged empty/partial tile progress and crosses the startup timeout', () => {
        let elapsed = -Infinity;
        for (let i = 0; i < 5; i++) {
            elapsed = ground.advanceEmptyContentTimer(elapsed, true, 5);
            expect(Number.isFinite(elapsed)).toBe(true);
        }
        expect(elapsed).toBeGreaterThan(20);
    });

    it('does not let an invalid time delta poison or spuriously advance the timer', () => {
        expect(ground.advanceEmptyContentTimer(7, true, NaN)).toBe(7);
        expect(ground.advanceEmptyContentTimer(7, true, Infinity)).toBe(7);
        expect(ground.advanceEmptyContentTimer(7, true, -3)).toBe(7);
        expect(ground.advanceEmptyContentTimer(7, false, NaN)).toBe(0);
        expect(ground.advanceEmptyContentTimer(NaN, true, 2)).toBe(2);
    });

    it('restarts a usable timeout after partial downloads rather than disabling it forever', () => {
        let elapsed = ground.advanceEmptyContentTimer(19, false, 0.25);
        expect(elapsed).toBe(0);
        for (let i = 0; i < 84; i++) elapsed = ground.advanceEmptyContentTimer(elapsed, true, 0.25);
        expect(elapsed).toBe(21);
    });
});

describe('photoreal final seating gate', () => {
    it.each([
        [0.5, 5000],
        [0.99, 5000],
        [0.995, 1399],
        [NaN, 5000],
        [0.995, NaN]
    ])('waits for nearly complete content and a quiet interval (%s, %s ms)', (progress, quietMs) => {
        expect(ground.canFinalizeSeating(progress, quietMs)).toBe(false);
    });

    it('allows final seating at 99.5% progress after 1.4 seconds without new content', () => {
        expect(ground.canFinalizeSeating(0.995, 1400)).toBe(true);
        expect(ground.canFinalizeSeating(1, 2500)).toBe(true);
    });
});

describe('bootstrapGround integration characterization', () => {
    it('moves the hidden world without moving the camera and enforces eight geometry-backed attempts', () => {
        const fixture = bootstrapFixture();
        const cameraBefore = { ...fixture.camera.position };
        for (let i = 0; i < 8; i++) {
            fixture.setAbsoluteHeight(120 * (i + 1));
            if (i > 0) fixture.context.tileContentRevision++;
            expect(fixture.bootstrapGround()).toBe(true);
        }
        expect(fixture.context.bootstrapAttempts).toBe(8);
        expect(fixture.seatNode.position.z).toBe(-960);
        expect(fixture.worldUpdates).toHaveBeenCalledTimes(16);
        expect(fixture.raycasts).toHaveBeenCalledTimes(40);
        expect(fixture.camera.position).toEqual(cameraBefore);
        expect(fixture.bootstrapGround()).toBe(false);
        expect(fixture.context.bootstrapAttempts).toBe(8);
        expect(fixture.seatNode.position.z).toBe(-960);
        expect(fixture.raycasts).toHaveBeenCalledTimes(40);
    });

    it('does not re-probe unchanged tile content or move the world when probes miss', () => {
        const fixture = bootstrapFixture({ hits: false });
        expect(fixture.bootstrapGround()).toBe(false);
        expect(fixture.context.bootstrapAttempts).toBe(0);
        expect(fixture.seatNode.position.z).toBe(0);
        expect(fixture.raycasts).toHaveBeenCalledTimes(5);
        expect(fixture.bootstrapGround()).toBe(false);
        expect(fixture.raycasts).toHaveBeenCalledTimes(5);
    });

    it('probes again only after tile content advances to a fresh revision', () => {
        const fixture = bootstrapFixture();
        expect(fixture.bootstrapGround()).toBe(true);
        expect(fixture.seatNode.position.z).toBe(-120);
        expect(fixture.raycasts).toHaveBeenCalledTimes(5);

        expect(fixture.bootstrapGround()).toBe(false);
        expect(fixture.raycasts).toHaveBeenCalledTimes(5);
        expect(fixture.seatNode.position.z).toBe(-120);

        fixture.setAbsoluteHeight(240);
        fixture.context.tileContentRevision++;
        expect(fixture.bootstrapGround()).toBe(true);
        expect(fixture.raycasts).toHaveBeenCalledTimes(10);
        expect(fixture.seatNode.position.z).toBe(-240);
    });
});

describe('tryLockGround final seating integration characterization', () => {
    it('reveals the seated group and dirties Google attribution after three stable, quiet probes', () => {
        const fixture = lockFixture();
        for (let i = 0; i < 3; i++) fixture.tryLockGround(0.25);

        expect(fixture.context.grounded).toBe(true);
        expect(fixture.seatNode.position.z).toBeCloseTo(-42.2, 8);
        expect(fixture.tiles.group.visible).toBe(true);
        expect(fixture.context.attributionDirty).toBe(true);
        expect(fixture.setStatus).toHaveBeenCalledWith('');
        expect(fixture.setRealisticLayerActive).toHaveBeenCalledWith(true);
    });

    it.each([
        ['still streaming', 0.99, 2000],
        ['recent content arrived', 1, 1000]
    ])('clears stability samples while seating is blocked by %s', (_reason, progress, quietMs) => {
        const fixture = lockFixture({ progress, quietMs, initialSamples: [41, 42] });
        fixture.tryLockGround(0.25);

        expect(fixture.context.lockSamples).toEqual([]);
        expect(fixture.context.grounded).toBe(false);
        expect(fixture.seatNode.position.z).toBe(0);
        expect(fixture.tiles.group.visible).toBe(false);
        expect(fixture.context.attributionDirty).toBe(false);
        expect(fixture.setRealisticLayerActive).not.toHaveBeenCalled();
    });
});
