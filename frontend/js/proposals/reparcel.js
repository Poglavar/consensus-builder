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

function ensureReparcellizationModuleLoaded() {
    if (typeof openReparcellizationModal === 'function') {
        return Promise.resolve(true);
    }
    if (reparcellizationModulePromise) {
        return reparcellizationModulePromise;
    }
    reparcellizationModulePromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'js/reparcellization.js';
        script.async = true;
        script.onload = () => resolve(typeof openReparcellizationModal === 'function');
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
    return reparcellizationModulePromise;
}

async function handleReparcellizationAlgorithmClick(algorithmKey = 'sweep-line') {
    const normalizedKey = algorithmKey || 'sweep-line';
    const ownershipModeInput = document.getElementById('proposalBoundaryMode');
    const ownershipMode = ownershipModeInput && ownershipModeInput.value ? ownershipModeInput.value : (currentOwnershipMode || 'multiple');

    currentProposalTool = 'reparcellization';
    const typeInput = document.getElementById('proposalType');
    if (typeInput) {
        typeInput.value = 'Reparcellization';
    }

    // Reopen on an existing plan (a copied proposal, or your own in-progress edits) when the
    // pending plan matches this selection, rather than re-running the algorithm over it.
    const buildOpenOptions = () => {
        const selection = (typeof getCurrentParcelSelectionContext === 'function')
            ? getCurrentParcelSelectionContext()
            : { ids: [] };
        const plan = (typeof getPendingReparcellizationSeedFor === 'function')
            ? getPendingReparcellizationSeedFor(selection.ids)
            : null;
        return plan
            ? { algorithm: plan.algorithm || normalizedKey, ownershipMode, initialPolygons: plan.polygons }
            : { algorithm: normalizedKey, ownershipMode };
    };

    // One unified land-readjustment method for both single- and multiple-owner
    // selections (ownershipMode is kept only as informational metadata).
    const openModal = async () => {
        if (typeof openReparcellizationModal === 'function') {
            openReparcellizationModal(buildOpenOptions());
            return true;
        }
        if (typeof updateStatus === 'function') {
            updateStatus('Loading reparcellization tools...');
        }
        const loaded = await ensureReparcellizationModuleLoaded();
        if (loaded && typeof openReparcellizationModal === 'function') {
            openReparcellizationModal(buildOpenOptions());
            return true;
        }
        console.warn('Reparcellization modal is not yet available.');
        if (typeof showEphemeralMessage === 'function') {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const message = t
                ? t('ephemeral.messages.reparcellization_tools_failed_to_load', 'Reparcellization tools failed to load.')
                : 'Reparcellization tools failed to load.';
            showEphemeralMessage(message, 5000, 'error');
        }
        return false;
    };

    return openModal();
}

function areParcelsContiguous(parcels = [], options = {}) {
    const bufferMeters = typeof options.bufferMeters === 'number' ? Math.max(0, options.bufferMeters) : 0.5;
    const features = parcels
        .map(p => (p && p.feature) ? p.feature : p)
        .filter(f => f && f.geometry && f.geometry.coordinates);
    if (features.length <= 1) {
        return { contiguous: features.length === 1, components: features.length };
    }
    if (typeof turf === 'undefined') {
        return { contiguous: true, components: features.length };
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
