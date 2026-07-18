// Coordinates a live park/square/lake/station refresh in abstract 3D so structure surfaces and the
// existing-building carve are rebuilt from the same committed proposal state.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeStructureRefresh = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const scopedMaterialBySource = new WeakMap();
    const baseStateByScopedMaterial = new WeakMap();

    function clampOpacity(value, fallback = 1) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
    }

    // Structure materials sometimes reuse a global material (notably parcel-slice borders). Clone
    // each source material once for the planned-structure groups so changing their opacity cannot
    // accidentally ghost an unrelated built object elsewhere in the scene.
    function scopedStructureMaterial(source) {
        if (!source || typeof source !== 'object') return source;
        if (baseStateByScopedMaterial.has(source)) return source;
        let scoped = scopedMaterialBySource.get(source);
        if (!scoped) {
            scoped = typeof source.clone === 'function'
                ? source.clone()
                : { ...source, userData: { ...(source.userData || {}) } };
            scopedMaterialBySource.set(source, scoped);
            baseStateByScopedMaterial.set(scoped, {
                opacity: clampOpacity(scoped.opacity, 1),
                transparent: scoped.transparent === true,
                depthWrite: scoped.depthWrite !== false
            });
        }
        return scoped;
    }

    function visitGroup(group, callback) {
        if (!group || typeof callback !== 'function') return;
        if (typeof group.traverse === 'function') {
            group.traverse(callback);
            return;
        }
        callback(group);
        (Array.isArray(group.children) ? group.children : []).forEach(child => visitGroup(child, callback));
    }

    function applyStructureDisplayMode(groups, mode, options = {}) {
        const normalizedMode = mode === 'ghost' || mode === 'off' ? mode : 'solid';
        const visible = normalizedMode !== 'off';
        const ghostOpacity = clampOpacity(options.ghostOpacity, 0.38);
        const seenMaterials = new Set();

        (Array.isArray(groups) ? groups : []).forEach(group => {
            if (!group) return;
            group.visible = visible;
            if (!visible) return;
            visitGroup(group, object => {
                if (!object || !object.material) return;
                const sources = Array.isArray(object.material) ? object.material : [object.material];
                const scoped = sources.map(scopedStructureMaterial);
                object.material = Array.isArray(object.material) ? scoped : scoped[0];
                scoped.forEach(material => {
                    if (!material || seenMaterials.has(material)) return;
                    seenMaterials.add(material);
                    const base = baseStateByScopedMaterial.get(material);
                    if (!base) return;
                    if (normalizedMode === 'ghost') {
                        material.opacity = base.opacity * ghostOpacity;
                        material.transparent = true;
                        material.depthWrite = false;
                    } else {
                        material.opacity = base.opacity;
                        material.transparent = base.transparent;
                        material.depthWrite = base.depthWrite;
                    }
                    material.needsUpdate = true;
                });
            });
        });

        return { mode: normalizedMode, visible, materialCount: seenMaterials.size };
    }

    function callSafely(label, callback, onError) {
        if (typeof callback !== 'function') return;
        try {
            callback();
        } catch (error) {
            if (typeof onError === 'function') onError(label, error);
        }
    }

    function refreshStructureScene3D(options = {}) {
        if (typeof options.isActive !== 'function' || !options.isActive()) return 'inactive';
        if (typeof options.hasScene !== 'function' || !options.hasScene()) {
            if (typeof options.initScene === 'function') options.initScene();
            return 'initialized';
        }

        const clearGroup = options.clearGroup;
        if (typeof clearGroup !== 'function') {
            throw new TypeError('A clearGroup function is required for a live 3D structure refresh.');
        }
        (Array.isArray(options.groups) ? options.groups : []).forEach(group => clearGroup(group));

        callSafely('parks', options.buildParks, options.onError);
        callSafely('squares', options.buildSquares, options.onError);
        callSafely('lakes', options.buildLakes, options.onError);
        callSafely('stations', options.buildStations, options.onError);
        callSafely('reparcellization', options.buildReparcellization, options.onError);
        callSafely('display', options.applyDisplay, options.onError);

        // This is the critical half of a structure refresh: demolition records change which
        // existing city-model meshes survive, not only which park/square/lake surface is drawn.
        if (typeof options.rebuildBuildings !== 'function') {
            throw new TypeError('A rebuildBuildings function is required for a live 3D structure refresh.');
        }
        options.rebuildBuildings();
        if (typeof options.rebuildInteraction === 'function') options.rebuildInteraction();
        return 'rebuilt';
    }

    return { refreshStructureScene3D, applyStructureDisplayMode };
});
