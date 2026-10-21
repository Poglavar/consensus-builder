// ui/parcel-menu-model.js — the pure half of the parcel menu (the popover a parcel click opens):
// which actions apply to a parcel given what is known about it, the one-line facts it shows, and
// where the popover goes relative to the parcel and click point. No DOM, no Leaflet; UMD so
// backend/test/frontend-parcel-menu.test.js loads it headlessly. The DOM half is ui/parcel-menu.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelMenuModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Menu order. Each id is also the suffix of its UiCommands command (`parcel.<id>`).
    const ACTIONS = Object.freeze(['propose', 'selectMore', 'details', 'proposals', 'history', 'compare', 'tools', 'detectBlock', 'useAsSite']);
    // What stays available on a piece of open ground (no cadastral parcel under it).
    const GROUND_ACTIONS = new Set(['details', 'useAsSite']);

    // The build palette (parcels/ui/proposal-actions.js renderParcelProposalActions) renders whenever
    // there is a parcel context: a non-empty multi-selection or a single parcel.
    function buildPaletteAvailable(state) {
        const s = state || {};
        const count = typeof s.selectionCount === 'number' && Number.isFinite(s.selectionCount) ? s.selectionCount : 0;
        if (s.multiSelectActive && count > 0) return true;
        return s.parcelContextId !== undefined && s.parcelContextId !== null && String(s.parcelContextId) !== '';
    }

    // The cadastral parcels whose history a live parcel shows (the menu's History and the parcel
    // panel's History section): its explicit cadastral sources, or its own id when the fabric names
    // none. A piece on open ground only (PARCEL-OPTIONAL.md phase 3) is no cadastral parcel: it has
    // no history and its id must never be sent to the backend as a parcel id.
    function parcelHistoryIds({ parcelId, cadastreIds = [], groundIds = [] } = {}) {
        const explicit = (cadastreIds || []).map(String).filter(Boolean);
        if (explicit.length) return { historyIds: explicit, isGround: false };
        if ((groundIds || []).length) return { historyIds: [], isGround: true };
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        return { historyIds: id ? [id] : [], isGround: false };
    }

    // facts: { parcelId, isRoad, multiSelectActive, historyIds: [], blocksEnabled,
    // compareCount }. Missing facts count as "not available" — never as a guess that it is.
    function isActionAvailable(action, facts) {
        const f = facts || {};
        const hasParcel = typeof f.parcelId === 'string' ? f.parcelId !== '' : (typeof f.parcelId === 'number');
        if (!hasParcel) return false;
        // A piece on open ground is not a cadastral parcel: nothing that acts on parcels (a parcel
        // history, a build palette over a parcel selection, a block seed) applies to it.
        if (f.isGround === true && !GROUND_ACTIONS.has(action)) return false;
        switch (action) {
            case 'propose':
            case 'details':
            case 'tools':
            // The parcel panel's Proposals tab, with the count the menu fetches (none yet is "0").
            case 'proposals':
                return true;
            case 'selectMore':
                return f.multiSelectActive !== true;
            case 'history':
                return Array.isArray(f.historyIds) && f.historyIds.some(id => typeof id === 'string' && id !== '');
            case 'compare':
                // Two proposals on this parcel to set side by side (proposals/parcel-compare-ui.js).
                return typeof f.compareCount === 'number' && f.compareCount >= 2;
            case 'useAsSite':
                // The parcel (or the selection) as an editable site; needs the site tool.
                return f.siteToolAvailable === true;
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

    // Presentation follows explicit provenance, never the spelling of a source or runtime id.
    // A readjustment's explicit output role distinguishes plot pieces from leftover ground.
    function parcelIdentityKind(props, parcelId) {
        const p = props || {};
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        if (p.producedByProposalId && p.readjustmentPiece?.role === 'plot') return 'plotPiece';
        if (p.producedByProposalId && p.readjustmentPiece?.role === 'remainder') return 'remainder';
        if (p.producedByProposalId || p.liveParcelDerivation || p.formedByProposalIds?.length) return 'formed';
        if (p.estimated === true) return 'estimated';
        if (p.cadastralPart === true) return 'sourcePart';
        const sources = Array.isArray(p.cadastreParcelIds) ? p.cadastreParcelIds.map(String) : [];
        if (sources.length) return sources.length === 1 && sources[0] === id ? 'source' : 'formed';
        return 'unknown';
    }

    function parcelIdentityTitle(kind) {
        const titles = {
            estimated: ['panel.parcel.identity.estimated', 'Estimated parcel {{number}}'],
            source: ['panel.parcel.identity.source', 'Source parcel {{number}}'],
            sourcePart: ['panel.parcel.identity.sourcePart', 'Source parcel part {{number}}'],
            plotPiece: ['panel.parcel.identity.plotPiece', 'Plot piece {{number}}'],
            remainder: ['panel.parcel.identity.remainder', 'Ground remainder {{number}}'],
            formed: ['panel.parcel.identity.formed', 'Formed ground piece {{number}}']
        };
        const [key, fallback] = titles[kind] || ['panel.parcel.multi.parcelLabel', 'Parcel {{number}}'];
        return { key, fallback };
    }

    // The normalized id wins over inherited cadastral-number metadata. Only an unchanged source
    // feature can use its short geometry reference; a formed piece must show its own runtime id.
    function displayParcelId(props, parcelId) {
        const p = props || {};
        const kind = parcelIdentityKind(p, parcelId);
        if ((kind === 'source' || kind === 'unknown' || kind === 'estimated')
            && p.parcelIdentityKind === 'geometry-sha256-v1' && String(p.geometryDisplayId || '').trim()) {
            return String(p.geometryDisplayId).trim();
        }
        if (parcelId !== undefined && parcelId !== null && String(parcelId)) return String(parcelId);
        const number = p.BROJ_CESTICE ?? p.broj_cestice;
        const municipality = p.MATICNI_BROJ_KO ?? p.maticni_broj_ko ?? (p.cadastralMunicipality && p.cadastralMunicipality.id);
        if (number !== undefined && number !== null && municipality !== undefined && municipality !== null) {
            const n = String(number).trim();
            const m = String(municipality).trim();
            if (n && m) return `HR-${m}-${n}`;
        }
        return parcelId === undefined || parcelId === null ? '' : String(parcelId);
    }

    // Prefer a clear side of the whole parcel, nearest the click, then space above or below it.
    // If the parcel fills the view, position from the click and allow overlap, clamped in view.
    function placeMenuAtPoint(point, size, viewport, options = {}) {
        const gap = typeof options.gap === 'number' ? options.gap : 10;
        const margin = typeof options.margin === 'number' ? options.margin : 8;
        const width = Math.max(0, size.width);
        const height = Math.max(0, size.height);
        const bounds = options.parcelBounds;
        if (bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
            && bounds.right >= bounds.left && bounds.bottom >= bounds.top) {
            const clampX = x => Math.max(margin, Math.min(x, viewport.width - margin - width));
            const clampY = y => Math.max(margin, Math.min(y, viewport.height - margin - height));
            const fits = candidate => candidate.left >= margin && candidate.top >= margin
                && candidate.left + width <= viewport.width - margin
                && candidate.top + height <= viewport.height - margin;
            const sides = [
                { left: bounds.right + gap, top: clampY(point.y - height / 2), distance: bounds.right - point.x, flippedX: false, flippedY: false },
                { left: bounds.left - gap - width, top: clampY(point.y - height / 2), distance: point.x - bounds.left, flippedX: true, flippedY: false }
            ];
            const ends = [
                { left: clampX(point.x - width / 2), top: bounds.bottom + gap, distance: bounds.bottom - point.y, flippedX: false, flippedY: false },
                { left: clampX(point.x - width / 2), top: bounds.top - gap - height, distance: point.y - bounds.top, flippedX: false, flippedY: true }
            ];
            const nearest = candidates => candidates.filter(fits).sort((a, b) => a.distance - b.distance)[0];
            const clear = nearest(sides) || nearest(ends);
            if (clear) return { left: Math.round(clear.left), top: Math.round(clear.top), flippedX: clear.flippedX, flippedY: clear.flippedY };
        }
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
        parcelHistoryIds,
        isActionAvailable,
        availableActions,
        parcelArea,
        ownershipFacts,
        parcelIdentityKind,
        parcelIdentityTitle,
        displayParcelId,
        placeMenuAtPoint
    };
});
