// Verifies that a live park/square/lake/station update rebuilds both structure surfaces and the existing
// 3D buildings whose demolition state changed, without needing a browser or WebGL scene.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    refreshStructureScene3D,
    applyStructureDisplayMode
} = require('../../frontend/js/three-structure-refresh.js');

function sceneOptions(overrides = {}) {
    const events = [];
    const groups = ['planned', 'parks', 'squares', 'lakes', 'stations'];
    const options = {
        isActive: () => true,
        hasScene: () => true,
        initScene: vi.fn(() => events.push('init')),
        groups,
        clearGroup: vi.fn(group => events.push(`clear:${group}`)),
        buildParks: vi.fn(() => events.push('build:parks')),
        buildSquares: vi.fn(() => events.push('build:squares')),
        buildLakes: vi.fn(() => events.push('build:lakes')),
        buildStations: vi.fn(() => events.push('build:stations')),
        rebuildParcelGround: vi.fn(() => events.push('rebuild:parcelground')),
        reparcellizationGroup: 'reparcel',
        layers: {
            parks: { groups: ['park-flat', 'parks'], build: vi.fn(() => events.push('build:parks')) },
            squares: { groups: ['square-flat', 'squares'], build: vi.fn(() => events.push('build:squares')) },
            lakes: { groups: ['lake-flat', 'lakes'], rebuildParcelGround: true, build: vi.fn(() => events.push('build:lakes')) },
            stations: { groups: ['stations'], rebuildParcelGround: true, build: vi.fn(() => events.push('build:stations')) },
            buildingGrounds: { groups: ['building-grounds'], build: vi.fn(() => events.push('build:grounds')) }
        },
        buildReparcellization: vi.fn(() => events.push('build:reparcellization')),
        applyDisplay: vi.fn(() => events.push('apply:display')),
        rebuildBuildings: vi.fn(() => events.push('rebuild:buildings')),
        rebuildInteraction: vi.fn(() => events.push('rebuild:interaction')),
        onError: vi.fn(),
        ...overrides
    };
    return { events, groups, options };
}

describe('refreshStructureScene3D', () => {
    it('does nothing while abstract 3D is inactive', () => {
        const { options } = sceneOptions({ isActive: () => false });

        expect(refreshStructureScene3D(options)).toBe('inactive');
        expect(options.clearGroup).not.toHaveBeenCalled();
        expect(options.rebuildBuildings).not.toHaveBeenCalled();
    });

    it('initializes a missing scene instead of rebuilding stale groups', () => {
        const { options } = sceneOptions({ hasScene: () => false });

        expect(refreshStructureScene3D(options)).toBe('initialized');
        expect(options.initScene).toHaveBeenCalledOnce();
        expect(options.clearGroup).not.toHaveBeenCalled();
        expect(options.rebuildBuildings).not.toHaveBeenCalled();
    });

    it.each([
        ['parksUpdated', ['park-flat', 'parks'], 'build:parks', false],
        ['squaresUpdated', ['square-flat', 'squares'], 'build:squares', false],
        ['lakesUpdated', ['lake-flat', 'lakes'], 'build:lakes', true],
        ['stationsUpdated', ['stations'], 'build:stations', true],
        ['buildingGroundsUpdated', ['building-grounds'], 'build:grounds', false]
    ])('refreshes only the %s layer while preserving shared follow-up work', (eventName, selectedGroups, buildEvent, parcelGround) => {
        const { events, options } = sceneOptions();

        expect(refreshStructureScene3D(options, eventName)).toBe('rebuilt');
        expect(options.clearGroup.mock.calls.map(call => call[0])).toEqual([...selectedGroups, 'reparcel']);
        expect(events).toContain(buildEvent);
        expect(events).toContain('build:reparcellization');
        expect(events).toContain('apply:display');
        expect(events).toContain('rebuild:buildings');
        expect(events).toContain('rebuild:interaction');
        expect(options.rebuildParcelGround).toHaveBeenCalledTimes(parcelGround ? 1 : 0);
        const allBuilds = events.filter(event => event.startsWith('build:'));
        expect(allBuilds).toEqual([buildEvent, 'build:reparcellization']);
    });

    it('still rebuilds buildings when one decoration renderer fails', () => {
        const error = new Error('park decoration failed');
        const { options } = sceneOptions();
        options.layers.parks.build = vi.fn(() => { throw error; });

        expect(refreshStructureScene3D(options, 'parksUpdated')).toBe('rebuilt');
        expect(options.onError).toHaveBeenCalledWith('parks', error);
        expect(options.rebuildBuildings).toHaveBeenCalledOnce();
    });
});

function testMaterial(overrides = {}) {
    const material = {
        opacity: 1,
        transparent: false,
        depthWrite: true,
        needsUpdate: false,
        userData: {},
        ...overrides
    };
    material.clone = () => testMaterial({
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
        userData: { ...material.userData }
    });
    return material;
}

function testGroup(material) {
    const mesh = { material };
    return {
        visible: true,
        mesh,
        traverse(callback) {
            callback(this);
            callback(mesh);
        }
    };
}

describe('applyStructureDisplayMode', () => {
    it('makes planned structures visibly transparent without writing invisible depth', () => {
        const source = testMaterial();
        const group = testGroup(source);
        const markOwnedMaterials = vi.fn();

        expect(applyStructureDisplayMode([group], 'ghost', { markOwnedMaterials })).toEqual({
            mode: 'ghost', visible: true, materialCount: 1
        });
        expect(group.mesh.material).not.toBe(source);
        expect(markOwnedMaterials).toHaveBeenCalledWith(group.mesh, group.mesh.material);
        expect(group.mesh.material).toMatchObject({
            opacity: 0.38,
            transparent: true,
            depthWrite: false,
            needsUpdate: true
        });
        expect(source).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
    });

    it('restores each material intrinsic opacity in solid mode', () => {
        const group = testGroup(testMaterial({ opacity: 0.8, transparent: true, depthWrite: false }));
        applyStructureDisplayMode([group], 'ghost');
        expect(group.mesh.material.opacity).toBeCloseTo(0.304);

        applyStructureDisplayMode([group], 'solid');
        expect(group.mesh.material).toMatchObject({
            opacity: 0.8,
            transparent: true,
            depthWrite: false
        });
    });

    it('hides every planned structure group in off mode', () => {
        const groups = [testGroup(testMaterial()), testGroup(testMaterial())];
        const result = applyStructureDisplayMode(groups, 'off');

        expect(result).toEqual({ mode: 'off', visible: false, materialCount: 0 });
        expect(groups.every(group => group.visible === false)).toBe(true);
    });
});
