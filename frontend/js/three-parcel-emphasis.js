// Per-object parcel selection styling for the 3D city. Materials are often shared between
// thousands of meshes, so every changed object receives its own clone and can be restored safely.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ThreeParcelEmphasis = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function styleFor(userData, selectedParcelId) {
        if (selectedParcelId == null) return 'normal';
        if (userData && userData.isParcel && userData.parcelId != null
            && String(userData.parcelId) === String(selectedParcelId)) return 'selected';
        return 'dimmed';
    }

    function cloneAndStyle(material, style) {
        if (!material || typeof material.clone !== 'function') return material;
        const copy = material.clone();
        // Material.clone() drops these callbacks in Three.js. Building ghost materials depend
        // on them to keep their depth/stencil treatment when an object gets a private clone.
        copy.onBeforeCompile = material.onBeforeCompile;
        copy.customProgramCacheKey = material.customProgramCacheKey;
        if (style === 'selected') {
            if (copy.color && typeof copy.color.set === 'function') copy.color.set(0x29c8ff);
            if (copy.emissive && typeof copy.emissive.set === 'function') copy.emissive.set(0x07364a);
            if ('needsUpdate' in copy) copy.needsUpdate = true;
        } else if (style === 'dimmed') {
            if (copy.color && typeof copy.color.multiplyScalar === 'function') copy.color.multiplyScalar(0.24);
            if (copy.emissive && typeof copy.emissive.multiplyScalar === 'function') copy.emissive.multiplyScalar(0.12);
            if ('needsUpdate' in copy) copy.needsUpdate = true;
        }
        return copy;
    }

    function disposeOverride(material) {
        if (!material) return;
        if (Array.isArray(material)) {
            material.forEach(disposeOverride);
            return;
        }
        try { material.dispose?.(); } catch (_) { }
    }

    function apply(rootObject, selectedParcelId, originals = new WeakMap()) {
        if (!rootObject || typeof rootObject.traverse !== 'function') return originals;
        rootObject.traverse((object) => {
            if (!object || !object.material) return;
            const previous = originals.get(object);
            if (previous) {
                disposeOverride(object.material);
                object.material = previous;
                originals.delete(object);
            }
            const style = styleFor(object.userData, selectedParcelId);
            if (style === 'normal') return;
            originals.set(object, object.material);
            object.material = Array.isArray(object.material)
                ? object.material.map(material => cloneAndStyle(material, style))
                : cloneAndStyle(object.material, style);
        });
        return originals;
    }

    return { styleFor, apply };
});
