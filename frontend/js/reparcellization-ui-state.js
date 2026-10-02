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

    // ── HTML for the legend tables ──
    // Owner names, colours and keys come from saved plans that anyone can share, so every value
    // interpolated into markup is escaped and every colour must be a plain hex literal: a colour is
    // written into a style attribute, where escaping alone would still allow arbitrary CSS.
    const esc = (typeof escapeHtml === 'function') ? escapeHtml : require('./shared-utils.js').escapeHtml;
    const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

    function safePlanColor(value, fallback = '#cccccc') {
        return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : fallback;
    }

    // Owners row of the Owners table: swatch + name.
    function ownerLegendCellHtml(entry = {}, color) {
        return `<span class="legend-color" style="background:${safePlanColor(color)}"></span> ${esc(entry.displayName)}`;
    }

    function cashOfferInputHtml(ownerKey, value) {
        const amount = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
        return `<input type="number" class="cash-offer-input" min="0" step="1" data-owner-key="${esc(ownerKey)}" value="${amount}">`;
    }

    // One owner chip in the New plots table. White/public swatches get a border to stay visible.
    function newPlotOwnerHtml(owner = {}, { publicKey, unassignedLabel } = {}) {
        const color = safePlanColor(owner.color, '#cccccc');
        const needsBorder = owner.ownerKey === publicKey || color.toLowerCase() === '#ffffff';
        const swatchStyle = `background:${color}` + (needsBorder ? ';border:1px solid #9ca3af' : '');
        return `<span class="newplot-owner"><span class="legend-color" style="${swatchStyle}"></span>${esc(owner.displayName || unassignedLabel || 'Unassigned')}</span>`;
    }

    const api = {
        resolveDrawShortcut, resolveOwnerDisplayName, resolveOwnerLabel, genericOwnerKind,
        normalizePlotOwners, plotIsAssigned, readjustmentInputFeatures,
        safePlanColor, ownerLegendCellHtml, cashOfferInputHtml, newPlotOwnerHtml
    };
    if (typeof window !== 'undefined') window.__reparcellizationUiState = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
