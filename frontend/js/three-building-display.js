// Defines the Built/Proposed display-state model independently from Three.js rendering and controls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeBuildingDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function resolveBuiltDisplayPolicy(state, selection = 'all') {
        const visible = state !== 'off';
        return { visible, material: state === 'ghost' ? 'ghost' : 'solid',
            showSurviving: visible && selection !== 'removed',
            showDemolished: visible && selection !== 'surviving',
            showExistingRail: visible && selection !== 'removed' };
    }

    function resolveBuildingRenderParts(carve, visibility = {}) {
        const showSurviving = visibility.showSurviving !== false;
        const showDemolished = visibility.showDemolished !== false;
        if (!carve) {
            return { detailed: showSurviving, remainder: false, demolished: false };
        }
        if (carve.remainder) {
            return { detailed: false, remainder: showSurviving, demolished: showDemolished };
        }
        return { detailed: showDemolished, remainder: false, demolished: false };
    }

    function retainedBaseMaterial(role, opacity, materials) {
        const ghost = Number(opacity) < 1;
        if (role === 'demolishedSolid' || role === 'demolishedGhost') {
            return materials?.[ghost ? 'demolishedGhost' : 'demolishedSolid'];
        }
        if (role === 'solid' || role === 'ghost') return materials?.[ghost ? 'ghost' : 'solid'];
        return null;
    }

    function collectDepthMeshes(mesh, depthFlag) {
        const result = [];
        const visit = object => {
            (object?.children || []).forEach(child => {
                if (child?.userData?.[depthFlag]) result.push(child);
                visit(child);
            });
        };
        visit(mesh);
        return result;
    }

    // Update display materials in place while retaining the existing geometry and object tree.
    // Shared singleton materials are swapped by role; only per-mesh clones receive configuration.
    function updateRetainedBuildingMaterials(group, options = {}) {
        if (!group || typeof group.traverse !== 'function') return 0;
        const materials = options.materials || {};
        const opacity = options.opacity == null ? 1 : options.opacity;
        const demolishedOpacity = options.demolishedOpacity == null ? opacity : options.demolishedOpacity;
        const singletonMaterials = new Set(Object.values(materials).filter(Boolean));
        const renderMeshes = [];
        group.traverse(object => {
            if (object?.isMesh && object.material && !object.userData?.[options.depthFlag]) renderMeshes.push(object);
        });

        let updated = 0;
        renderMeshes.forEach(mesh => {
            const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            let shouldShowDepth = false;
            let changed = false;
            const nextMaterials = sourceMaterials.map(material => {
                const role = material?.userData?.cbBuildingMaterialRole;
                if (!material || !role || role === 'massing' || role === 'flagged') return material;
                const targetOpacity = role === 'demolishedSolid' || role === 'demolishedGhost'
                    ? demolishedOpacity : opacity;
                const base = retainedBaseMaterial(role, targetOpacity, materials);
                if (!base) return material;
                if (Number(targetOpacity) < 1) shouldShowDepth = true;

                if (singletonMaterials.has(material)) {
                    if (material !== base) changed = true;
                    return base;
                }

                if (options.existing && material.color && base.color) {
                    if (typeof material.color.copy === 'function') material.color.copy(base.color);
                    else material.color = base.color;
                }
                if (typeof options.configureMaterial === 'function') {
                    options.configureMaterial(material, targetOpacity);
                }
                changed = true;
                return material;
            });

            if (Array.isArray(mesh.material)) mesh.material = nextMaterials;
            else mesh.material = nextMaterials[0];

            let depthMeshes = collectDepthMeshes(mesh, options.depthFlag);
            if (shouldShowDepth && depthMeshes.length === 0 && typeof options.attachDepthPrepass === 'function') {
                options.attachDepthPrepass(mesh);
                depthMeshes = collectDepthMeshes(mesh, options.depthFlag);
            }
            depthMeshes.forEach(depthMesh => { depthMesh.visible = shouldShowDepth; });
            if (changed || depthMeshes.length) updated++;
        });
        return updated;
    }

    return { resolveBuiltDisplayPolicy, resolveBuildingRenderParts, updateRetainedBuildingMaterials };
});
