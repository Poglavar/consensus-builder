// proposals/reparcel.js — extracted from proposals.js (behavior-preserving relocation).

function proposalAwareParcelClickHandler(e) {
    // Pass-through to the original click handler to ensure parcels are always selectable
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
        originalOnParcelClick.call(this, e);
    }
}

// The parcel-layout editor (js/parcel-layout.js) normally loads with the page; this loads it on
// demand when a design tool asks for it before it has arrived.
function ensureParcelLayoutModuleLoaded() {
    if (typeof openParcelLayoutEditor === 'function') {
        return Promise.resolve(true);
    }
    if (parcelLayoutModulePromise) {
        return parcelLayoutModulePromise;
    }
    parcelLayoutModulePromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = typeof appendBuildToken === 'function' ? appendBuildToken('js/parcel-layout.js') : 'js/parcel-layout.js';
        script.async = true;
        script.onload = () => resolve(typeof openParcelLayoutEditor === 'function');
        script.onerror = () => {
            parcelLayoutModulePromise = null;
            resolve(false);
        };
        document.head.appendChild(script);
    });
    return parcelLayoutModulePromise;
}

function areParcelsContiguous(parcels = [], options = {}) {
    const bufferMeters = typeof options.bufferMeters === 'number' ? Math.max(0, options.bufferMeters) : 0.5;
    const sourceFeatures = parcels
        .map(parcel => {
            if (typeof parcel === 'string' || typeof parcel === 'number') {
                return globalThis.LiveParcelFabric?.get?.(String(parcel)) || null;
            }
            return parcel?.type === 'Feature' ? parcel : null;
        })
        .filter(f => f && f.geometry && f.geometry.coordinates);
    // Connectivity is about pieces of ground, not array entries. A single GeoJSON MultiPolygon
    // can contain several islands, so treating "one feature" as automatically contiguous allowed
    // exactly the impossible case where one selected parcel appeared in two distant places.
    const features = sourceFeatures.flatMap(raw => {
        const feature = raw.type === 'Feature'
            ? raw
            : { type: 'Feature', properties: raw.properties || {}, geometry: raw.geometry || raw };
        const geometry = feature.geometry;
        if (geometry?.type !== 'MultiPolygon') return [feature];
        return (geometry.coordinates || []).map(coordinates => ({
            type: 'Feature',
            properties: { ...(feature.properties || {}) },
            geometry: { type: 'Polygon', coordinates }
        }));
    });
    if (features.length <= 1) {
        return { contiguous: features.length === 1, components: features.length };
    }
    if (typeof turf === 'undefined') {
        // More than one component cannot be proven connected without the geometry engine. Refuse
        // instead of weakening the one-parcel/one-place invariant during partial initialization.
        return { contiguous: false, components: features.length, connectedCount: 0 };
    }

    const buffered = features.map(raw => {
        const base = raw.type === 'Feature' ? raw : { type: 'Feature', geometry: raw.geometry || raw, properties: raw.properties || {} };
        try {
            return bufferMeters > 0 ? (turf.buffer(base, bufferMeters, { units: 'meters', steps: 12 }) || base) : base;
        } catch (_) {
            return base;
        }
    });

    const bboxes = buffered.map(f => {
        try { return turf.bbox(f); } catch (_) { return null; }
    });

    const intersects = (a, b, idxA, idxB) => {
        if (!a || !b) return false;
        const bboxA = bboxes[idxA];
        const bboxB = bboxes[idxB];
        if (bboxA && bboxB) {
            const disjoint = bboxA[2] < bboxB[0] || bboxB[2] < bboxA[0] || bboxA[3] < bboxB[1] || bboxB[3] < bboxA[1];
            if (disjoint) return false;
        }
        try { return turf.booleanIntersects(a, b); } catch (_) { }
        try { return !turf.booleanDisjoint(a, b); } catch (_) { }
        return false;
    };

    const visited = new Set([0]);
    const queue = [0];
    while (queue.length) {
        const i = queue.shift();
        for (let j = 0; j < buffered.length; j++) {
            if (visited.has(j)) continue;
            if (intersects(buffered[i], buffered[j], i, j)) {
                visited.add(j);
                queue.push(j);
            }
        }
    }

    return { contiguous: visited.size === buffered.length, components: buffered.length, connectedCount: visited.size };
}

function launchBlockifyToolForSelection() {
    return launchUrbanRuleToolForSelection();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { areParcelsContiguous };
}
