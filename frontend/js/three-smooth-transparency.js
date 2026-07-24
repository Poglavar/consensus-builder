// Builds a depth-prepass plus one smooth alpha pass for stable translucent building surfaces.

(function (global) {
    'use strict';

    const OPACITY_KEY = 'cbSmoothGhostOpacity';
    const DEPTH_PREPASS_FLAG = 'cbSmoothGhostDepthPrepass';
    const HAS_DEPTH_PREPASS_FLAG = 'cbSmoothGhostHasDepthPrepass';
    const DEFAULT_DEPTH_PREPASS_RENDER_ORDER = 1000000;

    function normalizeOpacity(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 1;
        return Math.min(1, Math.max(0, numeric));
    }

    function opacityOf(material) {
        if (!material || !material.userData) return 1;
        return normalizeOpacity(material.userData[OPACITY_KEY]);
    }

    function configureColorMaterial(material, options = {}) {
        if (!material) throw new TypeError('A material is required for smooth transparency.');
        const opacity = normalizeOpacity(options.opacity);
        material.userData = material.userData || {};
        material.userData[OPACITY_KEY] = opacity;
        material.transparent = opacity < 1;
        material.opacity = opacity;
        material.colorWrite = true;
        material.depthTest = true;
        material.depthWrite = opacity >= 1;
        if (opacity < 1 && options.equalDepth !== undefined) material.depthFunc = options.equalDepth;
        if (opacity >= 1 && options.lessDepth !== undefined) material.depthFunc = options.lessDepth;
        if ('alphaToCoverage' in material) material.alphaToCoverage = false;

        if (opacity < 1) {
            // Every translucent mesh has already contributed to the invisible depth pass. Only
            // fragments exactly on that nearest depth may blend. Stencil then permits one such
            // blend per pixel, even if the source contains a residual coincident triangle.
            material.stencilWrite = true;
            material.stencilRef = Number.isInteger(options.stencilRef) ? options.stencilRef : 1;
            material.stencilFuncMask = 0xff;
            material.stencilWriteMask = 0xff;
            if (options.notEqualStencilFunc !== undefined) material.stencilFunc = options.notEqualStencilFunc;
            if (options.keepStencilOp !== undefined) {
                material.stencilFail = options.keepStencilOp;
                material.stencilZFail = options.keepStencilOp;
            }
            if (options.replaceStencilOp !== undefined) material.stencilZPass = options.replaceStencilOp;
        } else {
            material.stencilWrite = false;
        }

        material.needsUpdate = true;
        return material;
    }

    function createDepthMaterial(sourceMaterial, options = {}) {
        if (!sourceMaterial || typeof sourceMaterial.clone !== 'function') {
            throw new TypeError('A cloneable source material is required for the depth prepass.');
        }
        const depthMaterial = sourceMaterial.clone();
        depthMaterial.userData = depthMaterial.userData || {};
        delete depthMaterial.userData[OPACITY_KEY];
        depthMaterial.userData[DEPTH_PREPASS_FLAG] = true;
        depthMaterial.transparent = false;
        depthMaterial.opacity = 1;
        depthMaterial.colorWrite = false;
        depthMaterial.depthTest = true;
        depthMaterial.depthWrite = true;
        if (options.lessDepth !== undefined) depthMaterial.depthFunc = options.lessDepth;
        depthMaterial.stencilWrite = false;
        if ('alphaToCoverage' in depthMaterial) depthMaterial.alphaToCoverage = false;
        depthMaterial.needsUpdate = true;
        return depthMaterial;
    }

    function attachDepthPrepass(mesh, options = {}) {
        if (!mesh || !mesh.geometry || !mesh.material || typeof mesh.add !== 'function') return null;
        mesh.userData = mesh.userData || {};
        if (mesh.userData[DEPTH_PREPASS_FLAG] || mesh.userData[HAS_DEPTH_PREPASS_FLAG]) return null;

        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!sourceMaterials.some(material => opacityOf(material) < 1)) return null;
        if (typeof options.createMesh !== 'function') {
            throw new TypeError('attachDepthPrepass requires a createMesh function.');
        }

        const depthMaterials = sourceMaterials.map(material => createDepthMaterial(material, options));
        const depthMaterial = Array.isArray(mesh.material) ? depthMaterials : depthMaterials[0];
        const depthMesh = options.createMesh(mesh.geometry, depthMaterial);
        if (!depthMesh) throw new Error('createMesh did not return a depth-prepass mesh.');
        depthMesh.userData = depthMesh.userData || {};
        depthMesh.userData[DEPTH_PREPASS_FLAG] = true;
        depthMesh.name = `${mesh.name || 'building'}-depth-prepass`;
        // Opaque objects are normally sorted front-to-back. If an invisible near facade ran
        // early, it could prevent a solid proposal behind it from ever writing COLOR. Schedule
        // every depth-only facade after ordinary opaque color; the transparent pass still runs
        // later because Three.js maintains a separate render list for it.
        const requestedRenderOrder = Number(options.depthRenderOrder);
        depthMesh.renderOrder = Number.isFinite(requestedRenderOrder)
            ? requestedRenderOrder
            : DEFAULT_DEPTH_PREPASS_RENDER_ORDER;
        depthMesh.frustumCulled = mesh.frustumCulled;
        depthMesh.castShadow = false;
        depthMesh.receiveShadow = false;
        if (depthMesh.layers && mesh.layers) depthMesh.layers.mask = mesh.layers.mask;
        if (mesh.morphTargetInfluences) depthMesh.morphTargetInfluences = mesh.morphTargetInfluences;
        if (mesh.morphTargetDictionary) depthMesh.morphTargetDictionary = mesh.morphTargetDictionary;
        depthMesh.raycast = function () { };

        mesh.userData[HAS_DEPTH_PREPASS_FLAG] = true;
        mesh.add(depthMesh);
        return depthMesh;
    }

    const api = {
        OPACITY_KEY,
        DEPTH_PREPASS_FLAG,
        HAS_DEPTH_PREPASS_FLAG,
        DEFAULT_DEPTH_PREPASS_RENDER_ORDER,
        normalizeOpacity,
        opacityOf,
        configureColorMaterial,
        createDepthMaterial,
        attachDepthPrepass
    };

    if (global) global.__threeSmoothTransparency = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
