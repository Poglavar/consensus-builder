// Pure UI-state decisions shared by the parcel-layout editor and the ownership panel: drawing
// shortcut routing, a layout's input parcels, and owner labels (known generic source labels
// translated, real names verbatim, "Unassigned" never taken for a name).
(function attachReparcellizationUiState(global) {
    'use strict';

    function resolveDrawShortcut(input = {}) {
        if (input.active !== true || input.editable || input.repeat) return null;
        if (input.ctrlKey || input.metaKey || input.altKey) return null;
        const key = String(input.key || '').toLowerCase();
        if (key === 'f' || key === 'enter') return 'finish';
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

    const GENERIC_OWNER_LABELS = {
        private: new Set([
            'private owner', 'private individual', 'propietario privado', 'propietario particular', 'titular privado',
            'privatni vlasnik', 'privatni posjednik', 'privatna osoba', 'приватни власник', 'приватни поседник', 'приватна особа'
        ]),
        public: new Set([
            'public land', 'public property', 'suelo publico', 'dominio publico', 'javno zemljiste', 'javna zemlja',
            'javno dobro', 'javna svojina', 'јавно земљиште', 'јавна својина'
        ])
    };

    function genericOwnerKind(rawName) {
        const normalized = String(rawName || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase().replace(/[.!,:;]+$/g, '').replace(/\s+/g, ' ');
        if (GENERIC_OWNER_LABELS.private.has(normalized)) return 'private';
        if (GENERIC_OWNER_LABELS.public.has(normalized)) return 'public';
        return null;
    }

    // Translate known source-level generic labels for display, while returning a locale-independent
    // name for identity derivation. Actual names remain verbatim.
    function resolveOwnerLabel(rawName, fallbackName, translate, reservedLabels = []) {
        const kind = genericOwnerKind(rawName);
        if (kind) {
            const key = kind === 'public' ? 'reparcellization.modal.publicLand' : 'common.privateOwner';
            const fallback = kind === 'public' ? 'Public land' : 'Private owner';
            return {
                displayName: typeof translate === 'function' ? translate(key, fallback) : fallback,
                identityName: String(rawName || '').trim()
            };
        }
        const name = resolveOwnerDisplayName(rawName, fallbackName, reservedLabels);
        const sourceName = String(rawName || '').trim();
        const reserved = new Set(['unassigned', ...(Array.isArray(reservedLabels) ? reservedLabels : [reservedLabels])]
            .map(value => String(value || '').trim().toLocaleLowerCase())
            .filter(Boolean));
        return { displayName: name, identityName: sourceName && !reserved.has(sourceName.toLocaleLowerCase()) ? sourceName : name };
    }

    // Saved layouts declare immutable cadastral inputs; a new selection declares current live pieces.
    // Never substitute one for the other: an applied layout has consumed its original live IDs.
    function readjustmentInputFeatures(selection, sources) {
        const ids = Array.isArray(selection?.ids) ? selection.ids.map(String).filter(Boolean) : [];
        const source = selection?.source === 'cadastre' ? sources.cadastre : sources.live;
        const features = ids.map(id => source?.get?.(id) || null);
        const missing = ids.filter((id, index) => !features[index]);
        return { features: features.filter(Boolean), missing };
    }

    const api = {
        resolveDrawShortcut, resolveOwnerDisplayName, resolveOwnerLabel, genericOwnerKind,
        readjustmentInputFeatures
    };
    if (typeof window !== 'undefined') window.__reparcellizationUiState = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
