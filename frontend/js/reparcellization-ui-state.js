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

    const api = { resolveDrawShortcut, resolveOwnerDisplayName };
    if (typeof window !== 'undefined') window.__reparcellizationUiState = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
