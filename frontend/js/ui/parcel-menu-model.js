// ui/parcel-menu-model.js — the pure half of the parcel menu (the popover a parcel click opens):
// which actions apply to a parcel given what is known about it, the one-line facts it shows, and
// where the popover goes relative to the click point. No DOM, no Leaflet; UMD so
// backend/test/frontend-parcel-menu.test.js loads it headlessly. The DOM half is ui/parcel-menu.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelMenuModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Menu order. Each id is also the suffix of its UiCommands command (`parcel.<id>`).
    const ACTIONS = Object.freeze(['propose', 'selectMore', 'details', 'history', 'tools', 'offer', 'view3d', 'detectBlock']);

    // The build palette (parcels/ui/proposal-actions.js renderParcelProposalActions) renders — and
    // with it the Ownership "Offer" tool — whenever there is a parcel context: a non-empty
    // multi-selection or a single parcel. One predicate for both the palette and the menu.
    function buildPaletteAvailable(state) {
        const s = state || {};
        const count = typeof s.selectionCount === 'number' && Number.isFinite(s.selectionCount) ? s.selectionCount : 0;
        if (s.multiSelectActive && count > 0) return true;
        return s.parcelContextId !== undefined && s.parcelContextId !== null && String(s.parcelContextId) !== '';
    }

    // facts: { parcelId, isRoad, multiSelectActive, selectionCount, historyIds: [], blocksEnabled,
    // can3d }. Missing facts count as "not available" — never as a guess that it is.
    function isActionAvailable(action, facts) {
        const f = facts || {};
        const hasParcel = typeof f.parcelId === 'string' ? f.parcelId !== '' : (typeof f.parcelId === 'number');
        if (!hasParcel) return false;
        switch (action) {
            case 'propose':
            case 'details':
            case 'tools':
                return true;
            case 'selectMore':
                return f.multiSelectActive !== true;
            case 'history':
                return Array.isArray(f.historyIds) && f.historyIds.some(id => typeof id === 'string' && id !== '');
            case 'offer':
                return buildPaletteAvailable({
                    multiSelectActive: f.multiSelectActive === true,
                    selectionCount: f.selectionCount,
                    parcelContextId: f.parcelId
                });
            case 'view3d':
                return f.can3d === true;
            case 'detectBlock':
                // A block is grown over non-corridor parcels; a road parcel cannot seed one.
                return f.blocksEnabled === true && f.isRoad !== true;
            default:
                return false;
        }
    }

    function availableActions(facts) {
        return ACTIONS.filter(action => isActionAvailable(action, facts));
    }

    const finitePositive = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

    // The area the parcel record states (the same fields the parcel panel reads), else the measured
    // geometry area, else null. A string "0" or "" is no area, not zero.
    function parcelArea(props, geometryArea) {
        const p = props || {};
        const candidates = [p.calculatedArea, p.area, p.parcelArea, p.informationTechnical && p.informationTechnical.superficie_total];
        for (const candidate of candidates) {
            if (candidate === null || candidate === undefined || candidate === '') continue;
            const value = finitePositive(typeof candidate === 'number' ? candidate : Number(candidate));
            if (value !== null) return value;
        }
        return finitePositive(geometryArea);
    }

    const OWNERSHIP_TYPES = ['government', 'institution', 'company', 'individual', 'mixed'];

    function normalizeOwnershipType(value) {
        if (typeof value !== 'string') return null;
        const type = value.trim().toLowerCase();
        if (type === 'private' || type === 'person') return 'individual';
        return OWNERSHIP_TYPES.includes(type) ? type : null;
    }

    // Owner type and count from what is already loaded (never fetched for the menu): the stated
    // type, else the backend summary flags, else the owners' labels classified by `classify`.
    // An unknown count stays null; it is not "1 owner".
    function ownershipFacts({ ownershipType, ownershipSummary, owners, classify } = {}) {
        const list = Array.isArray(owners) && owners.length > 0 ? owners : null;
        let type = normalizeOwnershipType(ownershipType);
        if (!type && ownershipSummary && typeof ownershipSummary === 'object') {
            const active = ['government', 'institution', 'company'].filter(key => ownershipSummary[key] === true);
            if (active.length === 1) type = active[0];
            else if (active.length > 1) type = 'mixed';
        }
        if (!type && list && typeof classify === 'function') {
            const types = Array.from(new Set(list.map(owner => {
                const label = owner && typeof owner === 'object' ? (owner.ownerLabel || owner.name || owner.possessorName || '') : owner;
                return normalizeOwnershipType(classify(label)) || 'individual';
            })));
            type = types.length === 1 ? types[0] : 'mixed';
        }
        return { ownershipType: type, ownerCount: list ? list.length : null };
    }

    // The id the parcel panel's title shows: HR-<cadastral municipality>-<parcel number> when the
    // record carries both, else the live parcel id.
    function displayParcelId(props, parcelId) {
        const p = props || {};
        const number = p.BROJ_CESTICE ?? p.broj_cestice;
        const municipality = p.MATICNI_BROJ_KO ?? p.maticni_broj_ko ?? (p.cadastralMunicipality && p.cadastralMunicipality.id);
        if (number !== undefined && number !== null && municipality !== undefined && municipality !== null) {
            const n = String(number).trim();
            const m = String(municipality).trim();
            if (n && m) return `HR-${m}-${n}`;
        }
        return parcelId === undefined || parcelId === null ? '' : String(parcelId);
    }

    // Where the popover goes for a click at `point` (container px): right of and below the point,
    // flipped to the left / above when it would leave the container, then clamped inside it.
    function placeMenuAtPoint(point, size, viewport, options = {}) {
        const gap = typeof options.gap === 'number' ? options.gap : 10;
        const margin = typeof options.margin === 'number' ? options.margin : 8;
        const width = Math.max(0, size.width);
        const height = Math.max(0, size.height);
        let left = point.x + gap;
        let top = point.y + gap;
        let flippedX = false;
        let flippedY = false;
        if (left + width > viewport.width - margin) {
            left = point.x - gap - width;
            flippedX = true;
        }
        if (top + height > viewport.height - margin) {
            top = point.y - gap - height;
            flippedY = true;
        }
        left = Math.min(Math.max(margin, left), Math.max(margin, viewport.width - margin - width));
        top = Math.min(Math.max(margin, top), Math.max(margin, viewport.height - margin - height));
        return { left: Math.round(left), top: Math.round(top), flippedX, flippedY };
    }

    return {
        ACTIONS,
        buildPaletteAvailable,
        isActionAvailable,
        availableActions,
        parcelArea,
        ownershipFacts,
        displayParcelId,
        placeMenuAtPoint
    };
});
