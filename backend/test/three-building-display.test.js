// Verifies the abstract-3D Built state model, especially the complementary Surviving/Removed views.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    displayStatesForKind,
    resolveBuiltDisplayPolicy,
    resolveBuildingRenderParts,
    updateRetainedBuildingMaterials
} = require('../../frontend/js/three-building-display.js');
import { mapModeModelScripts, readFrontendIndex } from './helpers/map-mode-loader.mjs';

const frontendIndex = readFrontendIndex();
const modelScripts = mapModeModelScripts();

describe('3D building display policy', () => {
    it('offers Removed only for existing Built fabric', () => {
        expect(displayStatesForKind('built')).toEqual(['solid', 'ghost', 'surviving', 'removed', 'off']);
        expect(displayStatesForKind('planned')).toEqual(['solid', 'ghost', 'off']);
    });

    it('loads the policy through the model loader before the 3D view that consumes it', () => {
        expect(frontendIndex).toContain("'js/map-mode-loader.js'");
        expect(modelScripts.indexOf('js/three-building-display.js')).toBeGreaterThan(-1);
        expect(modelScripts.indexOf('js/three-building-display.js'))
            .toBeLessThan(modelScripts.indexOf('js/three-mode.js'));
    });

    it('shows only demolished buildings and cut portions in Removed mode', () => {
        expect(resolveBuiltDisplayPolicy('removed')).toEqual({
            visible: true,
            material: 'solid',
            showSurviving: false,
            showDemolished: true,
            showExistingRail: false
        });
    });

    it('keeps Surviving as the exact complement of Removed', () => {
        expect(resolveBuiltDisplayPolicy('surviving')).toEqual({
            visible: true,
            material: 'solid',
            showSurviving: true,
            showDemolished: false,
            showExistingRail: true
        });
    });

    it('keeps Solid and Transparent inclusive, while Off renders no Built fabric', () => {
        expect(resolveBuiltDisplayPolicy('solid')).toMatchObject({
            visible: true, material: 'solid', showSurviving: true, showDemolished: true
        });
        expect(resolveBuiltDisplayPolicy('ghost')).toMatchObject({
            visible: true, material: 'ghost', showSurviving: true, showDemolished: true
        });
        expect(resolveBuiltDisplayPolicy('off')).toMatchObject({
            visible: false, showSurviving: false, showDemolished: false, showExistingRail: false
        });
    });

    it('selects the exact carve halves for Surviving and Removed views', () => {
        const cut = { remainder: { type: 'Polygon' }, demolished: { type: 'Polygon' } };
        const full = { remainder: null, demolished: { type: 'Polygon' } };
        const surviving = resolveBuiltDisplayPolicy('surviving');
        const removed = resolveBuiltDisplayPolicy('removed');

        expect(resolveBuildingRenderParts(null, surviving)).toEqual({
            detailed: true, remainder: false, demolished: false
        });
        expect(resolveBuildingRenderParts(cut, surviving)).toEqual({
            detailed: false, remainder: true, demolished: false
        });
        expect(resolveBuildingRenderParts(full, surviving)).toEqual({
            detailed: false, remainder: false, demolished: false
        });

        expect(resolveBuildingRenderParts(null, removed)).toEqual({
            detailed: false, remainder: false, demolished: false
        });
        expect(resolveBuildingRenderParts(cut, removed)).toEqual({
            detailed: false, remainder: false, demolished: true
        });
        expect(resolveBuildingRenderParts(full, removed)).toEqual({
            detailed: true, remainder: false, demolished: false
        });
    });
});

function displayMaterial(role, color) {
    return {
        userData: { cbBuildingMaterialRole: role },
        color: {
            value: color,
            copy(source) { this.value = source.value; return this; }
        },
        opacity: role.endsWith('Ghost') || role === 'ghost' ? 0.5 : 1,
        transparent: false,
        onBeforeCompile: function preservedCompileHook() {},
        clone() {
            const clone = displayMaterial(role, this.color.value);
            clone.onBeforeCompile = this.onBeforeCompile;
            return clone;
        }
    };
}

function renderGroup(meshes) {
    return {
        traverse(callback) {
            callback(this);
            meshes.forEach(mesh => callback(mesh));
            meshes.forEach(mesh => (mesh.children || []).forEach(callback));
        }
    };
}

function materialSet() {
    return {
        solid: displayMaterial('solid', 'gray'),
        ghost: displayMaterial('ghost', 'bluegray'),
        demolishedSolid: displayMaterial('demolishedSolid', 'red'),
        demolishedGhost: displayMaterial('demolishedGhost', 'red'),
        massing: displayMaterial('massing', 'envelope'),
        flagged: displayMaterial('flagged', 'warning')
    };
}

describe('updateRetainedBuildingMaterials', () => {
    const makeOptions = (materials, extra = {}) => ({
        opacity: 0.5,
        demolishedOpacity: 0.3,
        existing: true,
        materials,
        depthFlag: 'cbBuildingDepthPrepass',
        configureMaterial: vi.fn((material, opacity) => { material.opacity = opacity; }),
        attachDepthPrepass: vi.fn(mesh => {
            const depthMesh = {
                isMesh: true, geometry: mesh.geometry, material: mesh.material,
                userData: { cbBuildingDepthPrepass: true }, visible: true
            };
            mesh.children = [...(mesh.children || []), depthMesh];
        }),
        ...extra
    });

    it('retains geometry and cloned material identity across ghost-solid-ghost, reusing its prepass', () => {
        const materials = materialSet();
        const geometry = { marker: 'same geometry' };
        const material = materials.solid.clone();
        const mesh = { isMesh: true, geometry, material, children: [], userData: {} };
        const group = renderGroup([mesh]);
        const options = makeOptions(materials);

        updateRetainedBuildingMaterials(group, options);
        const prepass = mesh.children[0];
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.material).toBe(material);
        expect(mesh.material.color.value).toBe('bluegray');
        expect(prepass.visible).toBe(true);

        updateRetainedBuildingMaterials(group, { ...options, opacity: 1, demolishedOpacity: 1 });
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.material).toBe(material);
        expect(mesh.material.color.value).toBe('gray');
        expect(prepass.visible).toBe(false);

        updateRetainedBuildingMaterials(group, options);
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.children[0]).toBe(prepass);
        expect(mesh.material.color.value).toBe('bluegray');
        expect(prepass.visible).toBe(true);
        expect(options.attachDepthPrepass).toHaveBeenCalledOnce();
        expect(options.configureMaterial).toHaveBeenCalledTimes(3);
        expect(materials.solid.opacity).toBe(1);
        expect(materials.ghost.opacity).toBe(0.5);
    });

    it('swaps a shared singleton to the chosen variant without mutating either singleton', () => {
        const materials = materialSet();
        const mesh = { isMesh: true, geometry: {}, material: materials.solid, children: [], userData: {} };
        updateRetainedBuildingMaterials(renderGroup([mesh]), makeOptions(materials));

        expect(mesh.material).toBe(materials.ghost);
        expect(materials.solid.opacity).toBe(1);
        expect(materials.ghost.opacity).toBe(0.5);
    });

    it('preserves proposed clone colors and compile hooks while configuring only the clone', () => {
        const materials = materialSet();
        const proposalMaterial = materials.solid.clone();
        proposalMaterial.color.value = 'proposal facade';
        const compileHook = proposalMaterial.onBeforeCompile;
        const mesh = { isMesh: true, geometry: {}, material: proposalMaterial, children: [], userData: {} };
        const options = makeOptions(materials, { existing: false });
        updateRetainedBuildingMaterials(renderGroup([mesh]), options);

        expect(mesh.material).toBe(proposalMaterial);
        expect(proposalMaterial.color.value).toBe('proposal facade');
        expect(proposalMaterial.onBeforeCompile).toBe(compileHook);
        expect(options.configureMaterial).toHaveBeenCalledWith(proposalMaterial, 0.5);
    });

    it('keeps massing and flagged roles untouched', () => {
        const materials = materialSet();
        const massing = materials.massing.clone();
        const flagged = materials.flagged.clone();
        const meshes = [massing, flagged].map(material => ({ isMesh: true, geometry: {}, material, children: [], userData: {} }));
        const options = makeOptions(materials);
        updateRetainedBuildingMaterials(renderGroup(meshes), options);

        expect(options.configureMaterial).not.toHaveBeenCalled();
        expect(options.attachDepthPrepass).not.toHaveBeenCalled();
        expect(meshes.map(mesh => mesh.material)).toEqual([massing, flagged]);
    });
});
