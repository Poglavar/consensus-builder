// Pure UI-state decisions for land readjustment: drawing shortcut routing and owner labels that
// keep the plot state “Unassigned” distinct from an unnamed contributing owner.
(function attachReparcellizationUiState(global) {
    'use strict';

    function resolveDrawShortcut(input = {}) {
        if (input.active !== true || input.editable || input.repeat) return null;
        if (input.ctrlKey || input.metaKey || input.altKey) return null;
        const key = String(input.key || '').toLowerCase();
        if (key === 'f') return 'finish';
        if (key === 'c') return 'cancel';
        if (key === 'u') return 'undo';
        return null;
    }

    function resolveOwnerDisplayName(rawName, fallbackName, reservedLabels = []) {
        const name = String(rawName || '').trim();
        const reserved = new Set(['unassigned', ...(Array.isArray(reservedLabels) ? reservedLabels : [reservedLabels])]
            .map(value => String(value || '').trim().toLocaleLowerCase())
            .filter(Boolean));
        return !name || reserved.has(name.toLocaleLowerCase()) ? String(fallbackName || 'Owner') : name;
    }

    // A plot carries its owner two ways: the singular ownerKey/displayName (exactly one owner) and
    // owners[] (shares split between several). Both are written on save, and the editor keeps them
    // in lockstep — but a plan authored anywhere else (an imported UPU, an older save) may carry
    // only the singular pair. Reading just owners[] then makes every plot look ownerless, which
    // fails the completeness gate and disables Done with no way back. Normalise once, here.
    function normalizePlotOwners(plot = {}) {
        const listed = (Array.isArray(plot.owners) ? plot.owners : [])
            .filter(owner => owner && owner.ownerKey)
            .map(owner => ({
                ownerKey: owner.ownerKey,
                displayName: owner.displayName,
                color: owner.color,
                share: Number(owner.share) > 0 ? Number(owner.share) : 0
            }));
        if (listed.length) {
            const missing = listed.filter(owner => !owner.share);
            if (missing.length === listed.length) {
                const equal = 1 / listed.length;
                listed.forEach(owner => { owner.share = equal; });
            }
            return listed;
        }
        if (!plot.ownerKey) return [];
        return [{
            ownerKey: plot.ownerKey,
            displayName: plot.displayName,
            color: plot.color,
            share: 1
        }];
    }

    // The completeness invariant: a plot counts as assigned when it names a REAL owner. Public land
    // counts (it has its own owner key); the "Unassigned" placeholder does not.
    function plotIsAssigned(plot) {
        return normalizePlotOwners(plot).length > 0;
    }

    // Saved plans declare immutable cadastral inputs; a new selection declares current live pieces.
    // Never substitute one for the other: an applied plan has consumed its original live IDs.
    function readjustmentInputFeatures(selection, sources) {
        const ids = Array.isArray(selection?.ids) ? selection.ids.map(String).filter(Boolean) : [];
        const source = selection?.source === 'cadastre' ? sources.cadastre : sources.live;
        const features = ids.map(id => source?.get?.(id) || null);
        const missing = ids.filter((id, index) => !features[index]);
        return { features: features.filter(Boolean), missing };
    }

    const api = { resolveDrawShortcut, resolveOwnerDisplayName, normalizePlotOwners, plotIsAssigned, readjustmentInputFeatures };
    if (typeof window !== 'undefined') window.__reparcellizationUiState = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
