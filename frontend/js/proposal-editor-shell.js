// Purpose: render the shared proposal editor (the "Create proposal" flow) and the
// design-session plumbing behind instant creation and geometry editing. There is no user-facing
// drafts list: what is on the map IS the draft, editable until proposed.
(function attachProposalEditorShell(global) {
    'use strict';

    const TAB_LABELS = {
        design: ['proposalDrafts.tabs.design', 'Design'],
        parcels: ['proposalDrafts.tabs.parcels', 'Parcels'],
        details: ['proposalDrafts.tabs.details', 'Details']
    };
    const editorState = {
        draftId: null,
        designDraftId: null,
        tab: null,
        comparison: 'overlay',
        localMutation: false,
        unsubscribe: null
    };
    const failedDraftReopenInFlight = new Set();
    const placementBindingInFlight = new Map();

    function tDraft(key, fallback, params = {}) {
        let value = null;
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                value = global.i18n.t(key, params);
                if (value === key) value = null;
            }
        } catch (_) { }
        let output = value || fallback;
        Object.keys(params).forEach(name => {
            output = String(output).replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), String(params[name]));
        });
        return output;
    }

    function currentCityId() {
        try {
            return global.CityConfigManager && typeof global.CityConfigManager.getCurrentCityId === 'function'
                ? global.CityConfigManager.getCurrentCityId()
                : null;
        } catch (_) { return null; }
    }

    // The binding the server gives a design on this site (POST /designs/binding: derived, nothing
    // stored), read with the city's parcel source. A refusal reads as the index's own message.
    async function fetchPlacementBinding({ site, toleranceM, city }) {
        const unavailable = () => tDraft('proposalDrafts.placement.bindingUnavailable', 'The authoritative site binding service is unavailable. Your moved draft is saved locally.');
        const backendBase = typeof global.resolveBackendBaseUrl === 'function'
            ? global.resolveBackendBaseUrl()
            : (typeof global.getBackendBase === 'function' ? global.getBackendBase() : '');
        if (!backendBase || typeof global.fetch !== 'function') throw new Error(unavailable());
        let response;
        try {
            response = await global.fetch(`${String(backendBase).replace(/\/$/, '')}/designs/binding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ site, toleranceM, ...global.CityConfigManager.getParcelContext(site, city) })
            });
        } catch (error) {
            throw Object.assign(new Error(unavailable()), { code: 'binding-unavailable', cause: error });
        }
        let payload = null;
        try { payload = await response.json(); } catch (_) { payload = null; }
        if (!response.ok) {
            throw Object.assign(new Error(global.DesignSync.refusalMessage(response.status, payload)),
                { code: (payload && payload.code) || `http-${response.status}` });
        }
        if (!payload || !payload.binding) throw Object.assign(new Error(unavailable()), { code: 'binding-unavailable' });
        return payload.binding;
    }

    async function rebindFreePlacementDraft(draftId) {
        const store = global.proposalDraftStore;
        let draft = store?.getDraft?.(draftId) || null;
        const placementApi = global.proposalDraftPlacement;
        if (!draft || !placementApi?.isFreePlacementDraft?.(draft)) return draft;
        const currentPlacementSite = placementApi.freePlacementPatch(draft, draft.editorPayload?.placement || {})?.site;
        if (draft.editorPayload?.placement?.bindingStatus === 'bound'
            && JSON.stringify(draft.fields?.site) === JSON.stringify(currentPlacementSite)
            && String(draft.fields?.binding?.source || '').startsWith('server:')
            && ['complete', 'partial', 'none'].includes(draft.fields?.binding?.coverage)) return draft;
        const currentFlight = placementBindingInFlight.get(String(draftId));
        if (currentFlight) return currentFlight;

        const operation = (async () => {
            const placement = draft.editorPayload?.placement || {};
            const site = placementApi.freePlacementPatch(draft, placement)?.site;
            if (!site) throw new Error(tDraft('proposalDrafts.placement.invalidSite', 'A free placement needs a valid polygon site.'));
            const binding = await fetchPlacementBinding({
                site,
                toleranceM: Number(draft.fields?.toleranceM) || 0,
                city: draft.cityId || draft.sourceSnapshot?.city || currentCityId() || null
            });
            const latest = store.getDraft?.(draftId) || null;
            if (!latest || !placementApi.isFreePlacementDraft(latest)
                || JSON.stringify(latest.editorPayload?.placement?.site) !== JSON.stringify(site)) {
                throw new Error(tDraft('proposalDrafts.placement.geometryChanged', 'The moved geometry changed while its site was being bound. Retry the save.'));
            }
            const patch = placementApi.markFreePlacementBound(latest, binding);
            const updated = store.updateDraft(draftId, patch, { recordHistory: false });
            return store.validateDraft(draftId) || updated;
        })();
        placementBindingInFlight.set(String(draftId), operation);
        try {
            return await operation;
        } finally {
            if (placementBindingInFlight.get(String(draftId)) === operation) {
                placementBindingInFlight.delete(String(draftId));
            }
        }
    }

    function cityLabel(cityId) {
        try {
            if (global.CityConfigManager && typeof global.CityConfigManager.getCityLabel === 'function') {
                return global.CityConfigManager.getCityLabel(cityId) || cityId;
            }
        } catch (_) { }
        return cityId || tDraft('proposalDrafts.unknownCity', 'Unknown city');
    }

    function proposalLabel(goal) {
        const adapter = global.proposalEditorAdapterRegistry?.get(goal);
        return adapter?.label || String(goal || tDraft('proposalDrafts.proposal', 'Design')).replace(/-/g, ' ');
    }

    function relativeTime(value) {
        const then = new Date(value || 0).getTime();
        if (!Number.isFinite(then)) return '';
        const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
        if (seconds < 60) return tDraft('proposalDrafts.time.justNow', 'just now');
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return tDraft('proposalDrafts.time.minutes', '{{count}} min ago', { count: minutes });
        const hours = Math.round(minutes / 60);
        if (hours < 24) return tDraft('proposalDrafts.time.hours', '{{count}} h ago', { count: hours });
        const days = Math.round(hours / 24);
        return tDraft('proposalDrafts.time.days', '{{count}} d ago', { count: days });
    }

    function ensureShell() {
        let shell = global.document?.getElementById('proposal-editor-shell');
        if (shell) return shell;
        if (!global.document?.body) return null;
        shell = global.document.createElement('aside');
        shell.id = 'proposal-editor-shell';
        shell.className = 'proposal-editor-shell right-screen-panel';
        shell.setAttribute('aria-label', tDraft('proposalDrafts.editorAria', 'Design draft editor'));
        global.document.body.appendChild(shell);
        shell.addEventListener('click', handleShellClick);
        shell.addEventListener('input', handleShellInput);
        shell.addEventListener('change', handleShellChange);
        return shell;
    }

    function fieldValue(draft, path) {
        return String(path || '').split('.').reduce((value, key) => value?.[key], draft);
    }

    function patchForPath(path, value) {
        const keys = String(path || '').split('.').filter(Boolean);
        if (!keys.length) return {};
        const root = {};
        let cursor = root;
        keys.forEach((key, index) => {
            if (index === keys.length - 1) cursor[key] = value;
            else {
                cursor[key] = {};
                cursor = cursor[key];
            }
        });
        return root;
    }

    // What saving this draft does to its source, for the editor's copy: 'new' (no source), 'edit' (one's
    // own local record, saved in place) or 'counterproposal' (a published or minted source, which stays
    // as it is). The same rule as the save itself (proposals/lineage.js editsInPlace).
    function draftSaveKind(draft) {
        if (!draft?.sourceLocalProposalId) return 'new';
        const source = proposalById(draft.sourceLocalProposalId) || draft.sourceSnapshot || null;
        return global.ProposalLineage?.editsInPlace?.(source) === true ? 'edit' : 'counterproposal';
    }

    const DETAILS_COPY = {
        new: ['proposalDrafts.sections.detailsCopyNew', 'Describe what this design does, so others can follow it.'],
        edit: ['proposalDrafts.sections.detailsCopyEdit', 'Describe what this design does. Saving updates it in place; it keeps its id.'],
        counterproposal: ['proposalDrafts.sections.detailsCopyCounterproposal', 'Describe how this alternative design differs. The published design stays as it is.']
    };
    const REVIEW_NOTICE = {
        edit: ['proposalDrafts.review.inPlaceNotice', 'Saving updates this design in place. It keeps its id.'],
        counterproposal: ['proposalDrafts.review.counterproposalNotice', 'Saving creates an alternative design. The published design is not changed or removed.']
    };

    function renderDetails(draft) {
        const typeSelector = !draft.sourceLocalProposalId
            ? `<label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.type', 'Design type'))}</span>
                    <select data-draft-goal>${(global.proposalEditorAdapterRegistry?.list?.() || [])
                        .map(entry => option(entry.key, entry.label, draft.adapterKey || draft.goal))
                        .join('')}</select>
                </label>`
            : '';
        return `
            <section class="proposal-editor-section" data-editor-section="details">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.detailsTitle', 'Design details'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft(...DETAILS_COPY[draftSaveKind(draft)]))}</p>
                ${typeSelector}
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.name', 'Name'))}</span>
                    <input type="text" data-draft-path="fields.name" value="${escapeHtml(draft.fields?.name || '')}" autocomplete="off">
                </label>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.description', 'Description'))}</span>
                    <textarea data-draft-path="fields.description">${escapeHtml(draft.fields?.description || '')}</textarea>
                </label>
            </section>`;
    }

    function renderParcels(draft) {
        const ids = Array.isArray(draft.fields?.selectedParcelIds) ? draft.fields.selectedParcelIds : [];
        const chips = ids.map(id => `<span class="cb-badge proposal-editor-parcel-chip" title="${escapeHtml(id)}">${escapeHtml(id)}</span>`).join('');
        return `
            <section class="proposal-editor-section" data-editor-section="parcels">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.parcelsTitle', 'Affected parcels'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft('proposalDrafts.sections.parcelsCopy', 'Use the current map selection, or edit the parcel IDs directly.'))}</p>
                <div class="proposal-editor-parcels">${chips || escapeHtml(tDraft('proposalDrafts.noParcels', 'No parcels selected'))}</div>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.parcelIds', 'Parcel IDs'))}</span>
                    <textarea data-draft-path="fields.selectedParcelIds" data-draft-array="true">${escapeHtml(ids.join('\n'))}</textarea>
                </label>
                <button type="button" class="btn" data-editor-action="use-map-selection">${escapeHtml(tDraft('proposalDrafts.actions.useMapSelection', 'Use map selection'))}</button>
            </section>`;
    }

    function option(value, label, selected) {
        return `<option value="${escapeHtml(value)}"${String(selected || '') === String(value) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }

    // The layouts the parcel-layout editor offers (plan-design-agreement.md, M1 (a)).
    const PARCEL_LAYOUT_ALGORITHM_LABELS = {
        equal: ['proposalDrafts.design.layouts.equal', 'Equal plots'],
        schelling: ['proposalDrafts.design.layouts.schelling', 'Schelling plots'],
        amend: ['proposalDrafts.design.layouts.amend', 'Keep existing borders'],
        manual: ['proposalDrafts.design.layouts.manual', 'Draw freely']
    };

    function designSummary(draft) {
        const payload = draft.editorPayload || {};
        if (draft.goal === 'road-track') {
            const definition = payload.definition || {};
            const points = definition.points || definition.segments || [];
            return tDraft('proposalDrafts.design.corridorSummary', '{{segments}} segment(s) · {{width}} m wide', {
                segments: Array.isArray(points?.[0]) ? points.length : (points.length ? 1 : 0),
                width: Number(definition.width) || 0
            });
        }
        if (['buildings', 'row', 'parcelBased', 'single'].includes(draft.goal) || ['buildings', 'row', 'parcelBased', 'single'].includes(draft.adapterKey)) {
            const context = payload.context || {};
            const count = context.buildings?.length || (context.buildingFeature ? 1 : 0);
            return tDraft('proposalDrafts.design.buildingSummary', 'Buildings: {{count}} · {{typology}}', { count, typology: payload.typology || draft.goal });
        }
        if (draft.goal === 'parcel-layout') {
            const algorithm = PARCEL_LAYOUT_ALGORITHM_LABELS[payload.plan?.algorithm] || PARCEL_LAYOUT_ALGORITHM_LABELS.manual;
            return tDraft('proposalDrafts.design.layoutSummary', '{{count}} plot(s) · {{layout}}', {
                count: payload.plan?.plots?.length || 0,
                layout: tDraft(...algorithm)
            });
        }
        if (['park', 'square'].includes(draft.adapterKey || draft.goal)) {
            const decorations = payload.structureProposal?.decorations || {};
            const counts = draft.goal === 'park'
                ? [decorations.trees?.length || 0, decorations.flowerbeds?.length || 0, decorations.ponds?.length || 0, decorations.paths?.length || 0]
                : [decorations.fountains?.length || (decorations.fountain ? 1 : 0), decorations.trees?.length || 0, decorations.benches?.length || 0];
            return draft.goal === 'park'
                ? `${counts[0]} tree(s) · ${counts[1]} flowerbed(s) · ${counts[2]} pond(s) · ${counts[3]} footpath(s)`
                : `${counts[0]} fountain(s) · ${counts[1]} tree(s) · ${counts[2]} bench(es)`;
        }
        if ((draft.adapterKey || draft.goal) === 'station') {
            const station = payload.structureProposal || {};
            const type = global.TransitStations?.specFor?.(station.stationType)?.label || station.stationType || 'Station';
            const bearing = Math.round(Number(station.bearing) || 0);
            const height = station.stationType === 'elevated' && Number.isFinite(Number(station.platformHeightM))
                ? ` · ${CbFormat.formatLength(Number(station.platformHeightM))} high`
                : '';
            return `${type} · ${bearing}°${height}`;
        }
        return tDraft('proposalDrafts.design.parcelSummary', '{{count}} affected parcel(s)', { count: draft.fields?.selectedParcelIds?.length || 0 });
    }

    function renderDesign(draft, adapter) {
        const canOpen = adapter && typeof adapter.openDesignEditor === 'function' && adapter.hasDesign !== false;
        const corridorKind = !draft.sourceLocalProposalId && draft.goal === 'road-track'
            ? `<label class="proposal-editor-field"><span>${escapeHtml(tDraft('proposalDrafts.fields.corridorKind', 'Corridor type'))}</span><select data-draft-corridor-kind>${option('road', tDraft('proposalDrafts.design.road', 'Road'), draft.editorPayload?.kind || 'road')}${option('track', tDraft('proposalDrafts.design.track', 'Track'), draft.editorPayload?.kind || 'road')}</select></label>`
            : '';
        return `
            <section class="proposal-editor-section" data-editor-section="design">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.designTitle', 'Design'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft('proposalDrafts.sections.designCopy', 'Edit canonical geometry and parameters in the existing map-aware design tool.'))}</p>
                ${corridorKind}
                <div class="proposal-editor-card"><strong>${escapeHtml(proposalLabel(draft.adapterKey || draft.goal))}</strong><p>${escapeHtml(designSummary(draft))}</p></div>
                ${draft.incompatibilityReason ? `<div class="proposal-editor-unsupported">${escapeHtml(draft.incompatibilityReason)}</div>` : ''}
                ${canOpen && !draft.incompatibilityReason
                    ? `<button type="button" class="btn btn-primary" data-editor-action="open-design">${escapeHtml(tDraft('proposalDrafts.actions.openDesign', 'Edit design on map'))}</button>`
                    : `<div class="proposal-editor-card"><p>${escapeHtml(tDraft('proposalDrafts.design.parcelOnly', 'This design has no separate geometry. Parcel highlighting remains live while you edit its other facets.'))}</p></div>`}
            </section>`;
    }

    function displayValue(value) {
        if (value === undefined || value === null || value === '') return '—';
        if (typeof value === 'boolean') return value ? tDraft('proposalDrafts.yes', 'Yes') : tDraft('proposalDrafts.no', 'No');
        if (typeof value === 'object') {
            try { return JSON.stringify(value); } catch (_) { return String(value); }
        }
        return String(value);
    }

    function renderReview(draft) {
        const summary = typeof global.summarizeProposalDraftChanges === 'function'
            ? global.summarizeProposalDraftChanges(draft)
            : null;
        const changed = summary?.changedFacets || [];
        const rows = changed.map(change => `
            <div class="proposal-editor-diff-row">
                <dt>${escapeHtml(change.label || change.key)}</dt>
                <dd><s>${escapeHtml(displayValue(change.before))}</s><br>${escapeHtml(displayValue(change.after))}</dd>
            </div>`).join('');
        const parcels = summary?.parcels || { added: [], removed: [] };
        const geometry = summary?.geometry || {};
        const geometryRows = Object.entries(geometry)
            .filter(([key, value]) => key !== 'changed' && value !== null && value !== undefined && value !== false)
            .map(([key, value]) => `<div class="proposal-editor-diff-row"><dt>${escapeHtml(key.replace(/([A-Z])/g, ' $1'))}</dt><dd>${escapeHtml(displayValue(value))}</dd></div>`)
            .join('');
        return `
            <section class="proposal-editor-review">
                <h3>${escapeHtml(tDraft('proposalDrafts.review.title', 'Review changes'))}</h3>
                ${REVIEW_NOTICE[draftSaveKind(draft)] ? `<div class="proposal-editor-review-notice">${escapeHtml(tDraft(...REVIEW_NOTICE[draftSaveKind(draft)]))}</div>` : ''}
                <div class="proposal-editor-card">
                    <strong>${escapeHtml(summary?.sourceName || draft.sourceLocalProposalId || tDraft('proposalDrafts.review.newProposal', 'New design'))}</strong>
                    <p>${escapeHtml(draft.sourceLocalProposalId || tDraft('proposalDrafts.review.noSource', 'No source design'))} → ${escapeHtml(draft.fields?.name || '')}</p>
                </div>
                <dl class="proposal-editor-diff-list">
                    ${rows || `<div class="proposal-editor-diff-row"><dt>${escapeHtml(tDraft('proposalDrafts.review.details', 'Details'))}</dt><dd>${escapeHtml(tDraft('proposalDrafts.review.noFacetChanges', 'No metadata changes'))}</dd></div>`}
                    <div class="proposal-editor-diff-row"><dt>${escapeHtml(tDraft('proposalDrafts.review.parcels', 'Parcels'))}</dt><dd>+${parcels.added.length} / −${parcels.removed.length}</dd></div>
                    <div class="proposal-editor-diff-row"><dt>${escapeHtml(tDraft('proposalDrafts.review.geometry', 'Geometry'))}</dt><dd>${escapeHtml(geometry.changed ? tDraft('proposalDrafts.review.changed', 'Changed') : tDraft('proposalDrafts.review.unchanged', 'Unchanged'))}</dd></div>
                    ${geometryRows}
                </dl>
            </section>`;
    }

    function renderValidation(draft) {
        const validation = draft.validation || { valid: true, errors: [], warnings: [] };
        const errors = validation.errors || [];
        const warnings = validation.warnings || [];
        const issues = [...errors, ...warnings];
        if (!issues.length) {
            return `<div class="proposal-editor-validation is-valid" role="status">${escapeHtml(tDraft('proposalDrafts.validation.valid', 'Ready to review'))}</div>`;
        }
        const className = errors.length ? 'has-errors' : 'has-warnings';
        const issueMessage = entry => tDraft(`proposalDrafts.validation.issues.${entry.code || 'validation'}`, entry.message || entry.code || 'Validation issue');
        const list = (entries, offset, severity) => entries.length
            ? `<strong class="proposal-editor-validation-heading is-${severity}">${escapeHtml(severity === 'error'
                ? tDraft('proposalDrafts.validation.errors', '{{count}} error(s)', { count: entries.length })
                : tDraft('proposalDrafts.validation.warnings', '{{count}} warning(s)', { count: entries.length }))}</strong><ul>${entries.map((entry, index) => `<li class="is-${severity}"><button type="button" class="cb-link cb-link--quiet" data-editor-action="focus-issue" data-issue-index="${offset + index}">${escapeHtml(issueMessage(entry))}</button></li>`).join('')}</ul>`
            : '';
        return `<div class="proposal-editor-validation ${className}" role="status">${list(errors, 0, 'error')}${list(warnings, errors.length, 'warning')}</div>`;
    }

    function renderShell() {
        const shell = ensureShell();
        const store = global.proposalDraftStore;
        if (!shell || !store || !editorState.draftId) return;
        const draft = store.getDraft(editorState.draftId);
        if (!draft) {
            closeProposalEditorShell();
            return;
        }
        const adapter = global.proposalEditorAdapterRegistry?.get(draft.adapterKey || draft.goal);
        // Who decides and on what terms is the agreement's (plan-design-agreement.md): a design's
        // editor has its design, its parcels and its details only.
        const sections = adapter?.sections || ['parcels', 'details'];
        if (!editorState.tab || !sections.includes(editorState.tab)) editorState.tab = sections.includes('design') ? 'design' : sections[0];
        const reviewing = draft.state === 'review';
        let body = '';
        if (reviewing) body = renderReview(draft);
        else if (editorState.tab === 'design') body = renderDesign(draft, adapter);
        else if (editorState.tab === 'parcels') body = renderParcels(draft);
        else body = renderDetails(draft);

        const sourceText = draft.sourceLocalProposalId
            ? tDraft('proposalDrafts.source', 'Source: {{id}}', { id: draft.sourceLocalProposalId })
            : tDraft('proposalDrafts.newDraft', 'New proposal draft');
        // The shell is built from the shared vocabulary (css/primitives.css): a close-circle-btn,
        // icon buttons for undo/redo, a .cb-segmented comparison, .cb-tabs for the facets and the
        // .btn roles in the footer; css/proposal-editor.css only lays them out.
        shell.innerHTML = `
            <header class="proposal-editor-header">
                <div>
                    <p class="cb-kicker proposal-editor-eyebrow">${escapeHtml(proposalLabel(draft.adapterKey || draft.goal))}</p>
                    <h2 class="proposal-editor-title">${escapeHtml(draft.fields?.name || tDraft('proposalDrafts.untitled', 'Untitled draft'))}</h2>
                    <p class="proposal-editor-source">${escapeHtml(sourceText)} · ${escapeHtml(cityLabel(draft.cityId))}</p>
                </div>
                <button type="button" class="close-circle-btn" data-editor-action="close" aria-label="${escapeHtml(tDraft('proposalDrafts.actions.close', 'Close editor'))}">&times;</button>
            </header>
            <div class="proposal-editor-save-row">
                <span class="proposal-editor-autosave">${escapeHtml(draft.state === 'error' ? tDraft('proposalDrafts.autosave.recoverableError', 'Saved · publishing failed') : tDraft('proposalDrafts.autosave.saved', 'Autosaved locally'))}</span>
                <div class="proposal-editor-toolbar">
                    <button type="button" class="btn btn-quiet btn-icon btn-sm" data-editor-action="undo" aria-label="${escapeHtml(tDraft('proposalDrafts.actions.undo', 'Undo'))}"${draft.history?.past?.length ? '' : ' disabled'}><i class="fa-solid fa-rotate-left" aria-hidden="true"></i></button>
                    <button type="button" class="btn btn-quiet btn-icon btn-sm" data-editor-action="redo" aria-label="${escapeHtml(tDraft('proposalDrafts.actions.redo', 'Redo'))}"${draft.history?.future?.length ? '' : ' disabled'}><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>
                </div>
            </div>
            <div class="cb-segmented proposal-editor-comparison" role="group" aria-label="${escapeHtml(tDraft('proposalDrafts.comparison.label', 'Comparison mode'))}">
                ${comparisonButton('source-only', tDraft('proposalDrafts.comparison.source', 'Source only'))}
                ${comparisonButton('draft-only', tDraft('proposalDrafts.comparison.draft', 'Draft only'))}
                ${comparisonButton('overlay', tDraft('proposalDrafts.comparison.overlay', 'Overlay'))}
            </div>
            ${reviewing ? '' : `<div class="cb-tabs proposal-editor-tabs" role="tablist">${sections.map(section => `<button type="button" class="cb-tab" role="tab" aria-selected="${editorState.tab === section ? 'true' : 'false'}" data-editor-action="tab" data-editor-tab="${escapeHtml(section)}">${escapeHtml(tDraft(TAB_LABELS[section]?.[0] || '', TAB_LABELS[section]?.[1] || section))}</button>`).join('')}</div>`}
            <div class="proposal-editor-body">${body}${renderValidation(draft)}</div>
            <footer class="proposal-editor-footer">
                <button type="button" class="btn btn-danger" data-editor-action="discard">${escapeHtml(tDraft('proposalDrafts.actions.discard', 'Discard draft'))}</button>
                ${reviewing
                    ? `<div class="proposal-editor-grid"><button type="button" class="btn" data-editor-action="back-to-edit">${escapeHtml(tDraft('proposalDrafts.actions.back', 'Back'))}</button><button type="button" class="btn btn-primary" data-editor-action="publish"${draft.validation?.valid ? '' : ' disabled'}>${escapeHtml(draft.sourceLocalProposalId ? global.ProposalLineage.forkSubmitLabel(draft.sourceLocalProposalId) : tDraft('proposalDrafts.actions.createProposal', 'Create proposal'))}</button></div>`
                    : `<button type="button" class="btn btn-primary" data-editor-action="review">${escapeHtml(tDraft('proposalDrafts.actions.review', 'Review changes'))}</button>`}
            </footer>`;
        shell.classList.add('is-open');
        global.document.body.classList.add('proposal-editor-open');
        renderProposalDraftComparison(draft.id, editorState.comparison);
    }

    function comparisonButton(mode, label) {
        return `<button type="button" class="cb-segmented__option" aria-pressed="${editorState.comparison === mode ? 'true' : 'false'}" data-editor-action="comparison" data-comparison-mode="${mode}">${escapeHtml(label)}</button>`;
    }

    function updateShellStatusOnly(draft) {
        const shell = ensureShell();
        if (!shell || !draft) return;
        const name = shell.querySelector('.proposal-editor-title');
        if (name) name.textContent = draft.fields?.name || tDraft('proposalDrafts.untitled', 'Untitled draft');
        const status = shell.querySelector('.proposal-editor-autosave');
        if (status) status.textContent = tDraft('proposalDrafts.autosave.saved', 'Autosaved locally');
        const undo = shell.querySelector('[data-editor-action="undo"]');
        const redo = shell.querySelector('[data-editor-action="redo"]');
        if (undo) undo.disabled = !draft.history?.past?.length;
        if (redo) redo.disabled = !draft.history?.future?.length;
        const existingValidation = shell.querySelector('.proposal-editor-validation');
        if (existingValidation) existingValidation.outerHTML = renderValidation(draft);
    }

    function valueFromInput(input) {
        if (input.dataset.draftArray === 'true') {
            return [...new Set(String(input.value || '').split(/[\n,]+/).map(value => value.trim()).filter(Boolean))];
        }
        return input.value;
    }

    function mutateFromInput(input, validate) {
        const path = input?.dataset?.draftPath;
        if (!path || !editorState.draftId || !global.proposalDraftStore) return;
        editorState.localMutation = true;
        const value = valueFromInput(input);
        const patch = patchForPath(path, value);
        if (path === 'fields.name') patch.fields.titleOrigin = 'user';
        global.proposalDraftStore.updateDraft(
            editorState.draftId,
            patch,
            { coalesceKey: `field:${path}`, validate: false }
        );
        let draft = validate
            ? global.proposalDraftStore.validateDraft(editorState.draftId)
            : global.proposalDraftStore.getDraft(editorState.draftId);
        editorState.localMutation = false;
        updateShellStatusOnly(draft);
        renderProposalDraftComparison(editorState.draftId, editorState.comparison);
    }

    function handleShellInput(event) {
        const input = event.target?.closest?.('[data-draft-path]');
        if (!input) return;
        mutateFromInput(input, false);
    }

    function handleShellChange(event) {
        const corridorKindInput = event.target?.closest?.('[data-draft-corridor-kind]');
        if (corridorKindInput && editorState.draftId) {
            const kind = corridorKindInput.value === 'track' ? 'track' : 'road';
            global.proposalDraftStore.updateDraft(editorState.draftId, {
                proposalType: kind === 'track' ? 'Track' : 'Road',
                editorPayload: {
                    kind,
                    definition: {
                        metadata: { isCorridor: true, isTrack: kind === 'track', isRoad: kind !== 'track' }
                    }
                }
            }, { coalesceKey: 'new-corridor-kind' });
            global.proposalDraftStore.validateDraft(editorState.draftId);
            renderShell();
            return;
        }
        const goalInput = event.target?.closest?.('[data-draft-goal]');
        if (goalInput && editorState.draftId) {
            const goal = global.proposalEditorAdapterRegistry?.normalizeGoal?.(goalInput.value) || goalInput.value;
            const adapter = global.proposalEditorAdapterRegistry?.get?.(goal);
            global.proposalDraftStore.updateDraft(editorState.draftId, {
                goal,
                adapterKey: adapter?.key || goal,
                proposalType: adapter?.label || proposalLabel(goal),
                editorPayload: {},
                previewGeometry: null
            }, { coalesceKey: 'new-draft-type' });
            global.proposalDraftStore.validateDraft(editorState.draftId);
            editorState.tab = null;
            renderShell();
            return;
        }
        const input = event.target?.closest?.('[data-draft-path]');
        if (!input) return;
        mutateFromInput(input, true);
    }

    // The app's confirm (js/ui/dialogs.js): every question here throws work away, so the safe answer
    // is the inviting one.
    async function confirmDestructive(message, options = {}) {
        return global.CbDialog.confirm(message, { ...options, destructive: true });
    }

    // An in-place edit that changes ground other proposals stand on names the ones that come off
    // the map and asks first (ProposalManager.findEditDependents). Keep editing is the safe answer.
    async function confirmEditDependents(dependents) {
        const names = dependents.map(record => `“${record.title || record.name || record.proposalId}”`).join(', ');
        return confirmDestructive(tDraft('proposalDrafts.dependents.message',
            'Saving this edit changes the ground {{count}} proposal(s) stand on: {{names}}. They will be taken off the map.',
            { count: dependents.length, names }), {
            title: tDraft('proposalDrafts.dependents.title', 'Proposals built on this one'),
            okText: tDraft('proposalDrafts.dependents.confirm', 'Save and take them off'),
            cancelText: tDraft('proposalDrafts.dependents.cancel', 'Keep editing')
        });
    }

    async function handleShellClick(event) {
        const button = event.target?.closest?.('[data-editor-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.editorAction;
        const store = global.proposalDraftStore;
        const draftId = editorState.draftId;
        if (!store || !draftId) return;
        if (action === 'close') closeProposalEditorShell();
        else if (action === 'undo') { store.undoDraft(draftId); renderShell(); }
        else if (action === 'redo') { store.redoDraft(draftId); renderShell(); }
        else if (action === 'tab') { editorState.tab = button.dataset.editorTab; renderShell(); }
        else if (action === 'comparison') {
            editorState.comparison = button.dataset.comparisonMode || 'overlay';
            renderShell();
        } else if (action === 'discard') {
            const accepted = await confirmDestructive(tDraft('proposalDrafts.confirmDiscard', 'Discard this locally saved draft? This cannot be undone.'),
                { okText: tDraft('proposalDrafts.actions.discardShort', 'Discard') });
            if (!accepted) return;
            store.deleteDraft(draftId);
            closeProposalEditorShell();
        } else if (action === 'review') {
            const validated = store.validateDraft(draftId);
            if (!validated?.validation?.valid) {
                renderShell();
                return;
            }
            store.setDraftState(draftId, 'review');
            renderShell();
        } else if (action === 'back-to-edit') {
            store.setDraftState(draftId, 'editing');
            renderShell();
        } else if (action === 'publish') {
            await stageProposalDraftForPublishing(draftId);
        } else if (action === 'open-design') {
            try {
                const opened = await global.openProposalDraftDesign?.(draftId);
                if (opened === false && typeof global.updateStatus === 'function') {
                    global.updateStatus(tDraft('proposalDrafts.design.unavailable', 'This design editor is unavailable.'));
                }
                // Corridor drawing is pure geometry work: hide the editor while drawing; the
                // post-draw chooser reopens it when the user decides to propose.
                const current = store.getDraft(draftId);
                if (opened && opened !== false && (current?.adapterKey || current?.goal) === 'road-track') {
                    closeProposalEditorShell();
                }
            } catch (error) {
                console.error('[ProposalEditor] Failed to open design editor', error);
                if (typeof global.showStyledAlert === 'function') global.showStyledAlert(error.message || String(error));
            }
        } else if (action === 'use-map-selection') {
            const context = typeof global.getCurrentParcelSelectionContext === 'function'
                ? global.getCurrentParcelSelectionContext()
                : { ids: [] };
            store.updateDraft(draftId, { fields: { selectedParcelIds: (context.ids || []).map(String) } });
            store.validateDraft(draftId);
            renderShell();
        } else if (action === 'focus-issue') {
            const draft = store.getDraft(draftId);
            const issues = [...(draft.validation?.errors || []), ...(draft.validation?.warnings || [])];
            focusDraftValidationIssue(issues[Number(button.dataset.issueIndex) || 0]);
        }
    }

    function focusDraftValidationIssue(validationIssue) {
        if (!validationIssue) return false;
        const target = validationIssue.mapTarget;
        try {
            if (target && global.map && global.L) {
                const layer = global.L.geoJSON(target.type === 'Feature' ? target : { type: 'Feature', properties: {}, geometry: target });
                const bounds = layer.getBounds();
                if (bounds?.isValid?.()) global.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 20 });
                return true;
            }
            if (validationIssue.path === 'fields.selectedParcelIds') {
                const draft = global.proposalDraftStore?.getDraft(editorState.draftId);
                const first = draft?.fields?.selectedParcelIds?.[0];
                if (first && typeof global.focusParcelInMap === 'function') return global.focusParcelInMap(first);
            }
        } catch (_) { }
        if (validationIssue.path === 'goal') {
            editorState.tab = 'details';
            renderShell();
            const goal = ensureShell()?.querySelector('[data-draft-goal]');
            if (goal) {
                goal.focus();
                return true;
            }
        }
        if (String(validationIssue.path || '').startsWith('editorPayload.')) {
            editorState.tab = 'design';
            renderShell();
            const design = ensureShell()?.querySelector('[data-editor-action="open-design"]');
            if (design) {
                design.focus();
                return true;
            }
        }
        const path = String(validationIssue.path || '');
        let section = null;
        if (path === 'fields.name' || path === 'fields.description') section = 'details';
        else if (path === 'fields.selectedParcelIds') section = 'parcels';
        if (section && editorState.tab !== section) {
            editorState.tab = section;
            renderShell();
        }
        const input = ensureShell()?.querySelector(`[data-draft-path="${String(validationIssue.path || '').replace(/"/g, '\\"')}"]`);
        if (input) {
            input.focus();
            input.scrollIntoView({ block: 'center' });
            return true;
        }
        return false;
    }

    function detectViewMode() {
        try {
            if (global.PhotorealMode?.isActive?.() || global.photorealMode?.isActive || global.document?.body?.classList.contains('photoreal-mode')) return 'real-world';
            if (global.threeMode?.isActive || global.isThreeModeActive?.() || global.document?.body?.classList.contains('three-mode')) return '3d';
        } catch (_) { }
        return '2d';
    }

    function renderProposalDraftComparison(draftId, mode = 'overlay', { saving = false } = {}) {
        const draft = global.proposalDraftStore?.getDraft(draftId);
        if (!draft) return null;
        const adapter = global.proposalEditorAdapterRegistry?.get(draft.adapterKey || draft.goal);
        const descriptor = adapter && typeof adapter.renderPreview === 'function'
            ? adapter.renderPreview(draft, detectViewMode())
            : null;
        const detail = {
            draftId,
            mode,
            saving,
            viewMode: detectViewMode(),
            sourceProposal: mode === 'draft-only' ? null : draft.sourceSnapshot,
            draftPreview: mode === 'source-only' ? null : descriptor,
            sourceStyle: { opacity: 0.28, color: '#64748b' },
            draftStyle: { opacity: 0.92, color: '#2563eb', dashArray: '7 5' }
        };
        return paintProposalDraftComparison(detail);
    }

    function paintProposalDraftComparison(detail) {
        global.activeProposalDraftComparison = detail;
        try {
            global.document?.dispatchEvent(new global.CustomEvent('proposal-draft-preview-change', { detail }));
        } catch (_) { }
        if (typeof global.updateProposalDraftMapPreview === 'function') {
            try { global.updateProposalDraftMapPreview(detail); } catch (error) { console.warn('[ProposalEditor] Preview render failed', error); }
        }
        return detail;
    }

    function clearProposalDraftComparison() {
        // Consuming the draft clears ordinary comparison layers before application. A saving
        // snapshot owns the handoff until that application settles, even after its draft is gone.
        if (global.activeProposalDraftComparison?.saving) return;
        paintProposalDraftComparison(null);
    }

    function openProposalEditorShell(draftId, options = {}) {
        const store = global.proposalDraftStore;
        if (!store) return null;
        const draft = store.getDraft(draftId);
        if (!draft) return null;
        store.resumeDraft(draft.id);
        editorState.draftId = draft.id;
        editorState.tab = options.tab || null;
        editorState.comparison = options.comparison || editorState.comparison || 'overlay';
        renderShell();
        const shell = ensureShell();
        const close = shell?.querySelector('[data-editor-action="close"]');
        if (options.focus !== false) close?.focus?.({ preventScroll: true });
        return store.getDraft(draft.id);
    }

    function closeProposalEditorShell() {
        const shell = ensureShell();
        if (shell) shell.classList.remove('is-open');
        global.document?.body?.classList.remove('proposal-editor-open');
        clearProposalDraftComparison();
        editorState.draftId = null;
        editorState.tab = null;
    }

    function proposalById(id) {
        try {
            if (typeof global.getProposalByIdOrHash === 'function') return global.getProposalByIdOrHash(id);
            if (global.proposalStorage && typeof global.proposalStorage.getProposal === 'function') return global.proposalStorage.getProposal(id);
        } catch (_) { }
        return null;
    }

    function getProposalEditCapability(proposalOrId) {
        const proposal = typeof proposalOrId === 'object' ? proposalOrId : proposalById(proposalOrId);
        if (!proposal) return { editable: false, reason: tDraft('proposalDrafts.errors.sourceMissing', 'Proposal source not found.'), adapter: null, draft: null };
        const registry = global.proposalEditorAdapterRegistry;
        const capability = registry?.canEdit(proposal) || { editable: false, reason: tDraft('proposalDrafts.errors.noAdapter', 'No editor is registered for this proposal type.') };
        const id = typeof global.getProposalKey === 'function' ? global.getProposalKey(proposal) : (proposal.proposalId || proposal.id);
        const draft = id ? global.proposalDraftStore?.findDraftForSource(String(id), proposal.city || undefined) : null;
        return { ...capability, draft, proposal };
    }

    async function editProposal(proposalIdOrHash, options = {}) {
        const proposal = proposalById(proposalIdOrHash);
        const capability = getProposalEditCapability(proposal);
        if (!capability.editable) {
            const message = capability.reason || tDraft('proposalDrafts.errors.readOnly', 'This proposal is view-only.');
            if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
            else if (typeof global.updateStatus === 'function') global.updateStatus(message);
            return null;
        }
        const draft = global.proposalDraftStore.createDraftFromProposal(proposal, { activate: true });
        try { if (typeof global.hideProposalDetailsPanel === 'function') global.hideProposalDetailsPanel(); } catch (_) { }
        return openProposalEditorShell(draft.id, { tab: options.tab || null });
    }

    // Explicit copying is pointer placement (design-duplication.js). There is no guest gate for
    // local creation. Geometry editing below preserves the immutable published-source boundary.

    function createNewProposalDraft(options = {}) {
        const context = typeof global.getCurrentParcelSelectionContext === 'function'
            ? global.getCurrentParcelSelectionContext()
            : { ids: [] };
        const goal = options.goal || 'as-is';
        const draft = global.proposalDraftStore.createDraft({
            cityId: options.cityId || currentCityId(),
            goal,
            proposalType: options.proposalType || proposalLabel(goal),
            adapterKey: goal,
            fields: {
                name: options.name || '',
                description: options.description || '',
                selectedParcelIds: (options.parcelIds || context.ids || []).map(String)
            },
            editorPayload: options.editorPayload || {},
            previewGeometry: options.previewGeometry || null
        });
        global.proposalDraftStore.validateDraft(draft.id);
        return openProposalEditorShell(draft.id, options);
    }

    // Geometry editing of an existing object (SimCity: click → edit): opens the type's design
    // tool seeded from the object via a draft; when the tool is CONFIRMED (its Done button), the
    // draft is committed as a new object and the old one is absorbed. Closing the tool with X or
    // Esc discards the draft instead — the source object is left exactly as it was.
    let geometryEditCommitDraftId = null;

    const GEOMETRY_EDITABLE_ADAPTERS = new Set(['buildings', 'row', 'parcelBased', 'single', 'parcel-layout', 'park', 'square', 'lake', 'station']);

    function canEditProposalGeometry(proposalOrId) {
        const proposal = typeof proposalOrId === 'object' ? proposalOrId : proposalById(proposalOrId);
        if (!proposal) return false;
        // A minted/published proposal is editable too: editing FORKS it into a local copy (a new
        // local proposal that keeps the minted original in the list, see the commit path below), and
        // the on-chain record is never touched. So minted no longer blocks the geometry editor.
        const adapter = global.proposalEditorAdapterRegistry?.get(proposal);
        if (!adapter || !GEOMETRY_EDITABLE_ADAPTERS.has(adapter.key)) return false;
        const capability = typeof adapter.canEdit === 'function' ? adapter.canEdit(proposal) : true;
        return capability === true || capability?.editable === true;
    }

    // Every exit here used to be silent — a bare `return null`, a console.warn, or a status line
    // that scrolls past. The button is wired as an inline onclick, so the promise is discarded too:
    // anything thrown inside (createDraftFromProposal rejects a proposal with no stable ID) became
    // an unhandled rejection and the click simply did nothing, with no way to tell which gate
    // refused. Report the reason instead — a dead button must always say why.
    function reportGeometryEditFailure(reason, detail) {
        console.warn('[ProposalEditor] Geometry editor did not open:', reason, detail || '');
        if (typeof global.showStyledAlert === 'function') global.showStyledAlert(reason);
        else if (typeof global.updateStatus === 'function') global.updateStatus(reason);
        return null;
    }

    async function editProposalGeometry(proposalIdOrHash) {
        if (global.OnMapEditor?.isActive?.()) return false;
        const proposal = proposalById(proposalIdOrHash);
        if (!proposal) {
            return reportGeometryEditFailure(
                tDraft('proposalDrafts.errors.sourceMissing', 'Design source not found.'),
                proposalIdOrHash
            );
        }
        if (!canEditProposalGeometry(proposal)) {
            return reportGeometryEditFailure(
                tDraft('proposalDrafts.errors.notReshapeable', 'This design type cannot be reshaped.'),
                global.ProposalDesignGoals?.keyOf(proposal) || 'unknown'
            );
        }
        let draft = null;
        try {
            draft = global.proposalDraftStore.createDraftFromProposal(proposal, { activate: true });
        } catch (error) {
            return reportGeometryEditFailure(
                tDraft('proposalDrafts.errors.draftFailed', 'Could not open this design for editing.'),
                error
            );
        }
        if (!draft) {
            return reportGeometryEditFailure(
                tDraft('proposalDrafts.errors.draftFailed', 'Could not open this design for editing.'),
                'createDraftFromProposal returned nothing'
            );
        }
        geometryEditCommitDraftId = draft.id;
        try { if (typeof global.hideProposalDetailsPanel === 'function') global.hideProposalDetailsPanel(); } catch (_) { }
        let opened = false;
        let failure = null;
        try {
            opened = await global.openProposalDraftDesign?.(draft.id);
        } catch (error) {
            opened = false;
            failure = error;
        }
        if (opened === false) {
            geometryEditCommitDraftId = null;
            global.proposalDraftStore.deleteDraft(draft.id);
            const reason = (failure && failure.message)
                || tDraft('proposalDrafts.design.unavailable', 'This design editor is unavailable.');
            return reportGeometryEditFailure(reason, failure);
        }
        return opened;
    }

    // ---- Leaving a rule's parcels: conversion to a Freeform building (proposals/freeform-conversion.js) ----

    // The rule names the Build palette uses.
    const RULE_LABELS = {
        block: ['panel.parcel.build.block', 'Block'],
        row: ['panel.parcel.build.row', 'Row houses'],
        parcelBased: ['panel.parcel.build.parcelBased', 'Detached']
    };

    function ruleLabel(typology) {
        const entry = RULE_LABELS[typology] || RULE_LABELS.block;
        return tDraft(entry[0], entry[1]);
    }

    // The one Freeform building a Block or Row becomes, or the reason it cannot become one.
    const MERGE_REFUSALS = {
        'not-contiguous': ['proposalDrafts.freeform.notContiguous', 'Its buildings do not touch each other, so they cannot become one Freeform building.'],
        'no-buildings': ['proposalDrafts.freeform.noBuildings', 'This design has no buildings to keep.']
    };

    function mergeRuleBuildings(features) {
        const conversion = global.__freeformConversion;
        const result = conversion.mergedBuilding(features || [], {
            union: (a, b) => global.turf.union(a, b)
        });
        if (result.ok) return result;
        const refusal = MERGE_REFUSALS[result.code] || MERGE_REFUSALS['no-buildings'];
        return { ...result, reason: tDraft(refusal[0], refusal[1]) };
    }

    // Where a converted record stands: its stored site, else the building's own footprint. Never
    // the live parcels: after a cadastre swap the old parcels are gone, and the stored massing the
    // building is frozen from does not need them. The server binds the site to today's parcels.
    function ruleRecordSite(proposal, building) {
        const siteApi = global.__siteDraft;
        if (siteApi?.isPolygonal?.(proposal.site)) return JSON.parse(JSON.stringify(proposal.site));
        return siteApi?.siteFromFeatures?.([building]) || null;
    }

    // The Freeform design REPLACES the rule's: a merge would keep the rule's parameters (setback,
    // gaps, rule kind …) inside the Freeform record, where they no longer mean anything. Its type
    // label is Freeform's too, so a house converted without a name is named as a Freeform building.
    function replaceWithFreeform(store, draft, patch) {
        return store.updateDraft(draft.id, current => ({
            ...current,
            proposalType: proposalLabel('single'),
            ...patch,
            fields: { ...(current.fields || {}), ...(patch.fields || {}) }
        }), { recordHistory: false, force: true });
    }

    // Says plainly what converting does: one building, frozen, and the rule's parameters gone. `record`
    // is the saved proposal (or the design's source) the edit rule is judged on.
    async function confirmFreeformConversion(record, typology, count = 1) {
        const inPlace = !record?.proposalId || global.ProposalLineage?.editsInPlace?.(record) === true;
        const params = { name: record?.title || record?.name || record?.proposalId || ruleLabel(typology), rule: ruleLabel(typology), count };
        if (count > 1) {
            return global.CbDialog.confirm(inPlace
                ? tDraft('proposalDrafts.freeform.confirmLocalMany', '“{{name}}” becomes {{count}} Freeform designs, one building per house: each parcel\'s massing at the greatest height its {{rule}} rule allows. The first replaces this design; the rule\'s parameters no longer apply afterwards.', params)
                : tDraft('proposalDrafts.freeform.confirmPublishedMany', '“{{name}}” is published, so {{count}} Freeform designs are created, one building per house: each parcel\'s massing at the greatest height its {{rule}} rule allows. The published design stays as it is.', params), {
                title: tDraft('proposalDrafts.freeform.titleMany', 'Convert to freeform buildings'),
                okText: tDraft('proposalDrafts.freeform.convert', 'Convert'),
                cancelText: tDraft('proposalDrafts.freeform.keepRule', 'Keep the rule')
            });
        }
        return global.CbDialog.confirm(inPlace
            ? tDraft('proposalDrafts.freeform.confirmLocal', '“{{name}}” becomes one Freeform building: its {{rule}} rule\'s massing at the greatest height the rule allows. The rule\'s parameters no longer apply afterwards: you edit the building, and lower it, directly.', params)
            : tDraft('proposalDrafts.freeform.confirmPublished', '“{{name}}” is published, so a Freeform design is created: one building, its {{rule}} rule\'s massing at the greatest height the rule allows. The rule\'s parameters do not apply to it: you edit the building directly. The published design stays as it is.', params), {
            title: tDraft('proposalDrafts.freeform.title', 'Convert to freeform building'),
            okText: tDraft('proposalDrafts.freeform.convert', 'Convert'),
            cancelText: tDraft('proposalDrafts.freeform.keepRule', 'Keep the rule')
        });
    }

    // "Convert to Freeform building" on a Block or Row proposal, or a Detached one on a single parcel:
    // the buildings its rule produces now merge into one Freeform building and the rule's parameters
    // stop applying. One's own local record is converted in place; a published or minted one gets a
    // Freeform counterproposal.
    async function convertProposalToFreeform(proposalIdOrHash) {
        const conversion = global.__freeformConversion;
        const proposal = proposalById(proposalIdOrHash);
        if (!proposal || !conversion?.convertsToFreeform(proposal)) return null;
        const typology = conversion.ruleTypologyOf(proposal);
        // A Block stores its buildings cut per parcel; the authored massing is the one shape to keep.
        const merged = mergeRuleBuildings(proposal.geometry?.ruleMassing ? [proposal.geometry.ruleMassing] : proposal.geometry?.buildings);
        if (!merged.ok) {
            reportGeometryEditFailure(merged.reason, proposal.proposalId);
            return null;
        }
        if (!(await confirmFreeformConversion(proposal, typology))) return null;
        const site = ruleRecordSite(proposal, merged.building);
        const store = global.proposalDraftStore;
        let draft = null;
        try {
            draft = store.createDraftFromProposal(proposal, { activate: false, forceNew: true });
            replaceWithFreeform(store, draft, conversion.freeformDraftPatch(draft, { building: merged.building, site }));
        } catch (error) {
            if (draft) store.deleteDraft(draft.id);
            return reportGeometryEditFailure(error?.message || String(error), proposal.proposalId);
        }
        return instantCreateProposalFromDraft(draft.id);
    }

    // A rule editor's conversion of the design it holds now (unmoved, or dropped off its parcels):
    // the active design draft becomes one Freeform building standing on `site`. Resolves { ok, reason }
    // ({ ok: false, cancelled: true } when the user keeps the rule). On success the editor closes as
    // Done does, which saves the draft by the ordinary edit rule. `confirm: false` when the user has
    // just chosen the conversion in the drop dialog, which already says what it means.
    async function convertActiveDesignToFreeform({ features, site, typology = 'block', confirm = true } = {}) {
        const conversion = global.__freeformConversion;
        const store = global.proposalDraftStore;
        const draft = getActiveProposalDesignDraft();
        if (!conversion || !store || !draft) {
            return { ok: false, reason: tDraft('proposalDrafts.design.unavailable', 'This design editor is unavailable.') };
        }
        const merged = mergeRuleBuildings(features);
        if (!merged.ok) return merged;
        const source = draft.sourceLocalProposalId ? proposalById(draft.sourceLocalProposalId) : null;
        if (confirm && !(await confirmFreeformConversion(source || { title: draft.fields?.name }, typology))) {
            return { ok: false, cancelled: true };
        }
        replaceWithFreeform(store, draft, conversion.freeformDraftPatch(draft, { building: merged.building, site }));
        return { ok: true };
    }

    // Freeform drafts that save after the design session's own draft: a Detached rule converts to
    // one Freeform building per house, and the active draft holds only the first. Keyed by the
    // active draft id, together with the complete pre-staging design. A failed first save restores
    // that design before reopening its editor; abandoning the session discards it explicitly.
    const freeformSiblingDrafts = new Map();

    // Stage independent, already-authored Freeform buildings on their own sites. The caller owns
    // confirmation and closing: the active draft is only prepared here, and the design session's
    // normal Done path saves it and then its siblings. Each feature is one Polygon building, so
    // holes and source metadata pass through unchanged; disconnected MultiPolygon components are
    // separate entries supplied by the importer.
    function stageActiveFreeformBuildings({ buildings } = {}) {
        const incoming = Array.isArray(buildings) ? buildings : [];
        const list = incoming.map(item => ({
            ...item,
            site: item?.site?.type === 'Feature' ? item.site.geometry : item?.site
        }));
        if (!list.length || list.some(item => item?.building?.type !== 'Feature'
            || item.building.geometry?.type !== 'Polygon'
            || !Array.isArray(item.building.geometry.coordinates?.[0])
            || item.building.geometry.coordinates[0].length < 4
            || !['Polygon', 'MultiPolygon'].includes(item.site?.type))) {
            return { ok: false, reason: 'Each Freeform building needs a Polygon footprint and polygonal site.' };
        }
        const conversion = global.__freeformConversion;
        const store = global.proposalDraftStore;
        const draft = getActiveProposalDesignDraft();
        if (!conversion || !store || !draft) {
            return { ok: false, reason: tDraft('proposalDrafts.design.unavailable', 'This design editor is unavailable.') };
        }
        const source = draft.sourceLocalProposalId ? proposalById(draft.sourceLocalProposalId) : null;
        const published = !!source && global.ProposalLineage?.editsInPlace?.(source) !== true;
        const previousStage = freeformSiblingDrafts.get(String(draft.id));
        const previousSiblings = previousStage?.siblings || [];
        const recoveryDraft = JSON.parse(JSON.stringify(draft));
        const siblings = [];
        try {
            list.slice(1).forEach((house, index) => {
                // A further house is its own proposal: it starts unnamed, so it is named from the
                // parcels it binds to like any new object.
                const sibling = published
                    ? store.createDraftFromProposal(source, { activate: false, forceNew: true })
                    : store.createDraft({
                        cityId: draft.cityId, goal: draft.goal, adapterKey: draft.adapterKey, proposalType: draft.proposalType,
                        fields: { ...(draft.fields || {}), name: '', titleOrigin: 'generated', description: '' },
                        editorPayload: draft.editorPayload, activate: false
                    });
                siblings.push(sibling.id);
                const patch = conversion.freeformDraftPatch(sibling, { building: house.building, site: house.site });
                replaceWithFreeform(store, sibling, { ...patch, fields: { ...(patch.fields || {}), name: '', titleOrigin: 'generated', description: '' } });
            });
            const firstPatch = conversion.freeformDraftPatch(draft, { building: list[0].building, site: list[0].site });
            if (list[0].surroundings) {
                const { groundSurface = null, groundBoundary = null, landTake = null } = list[0].surroundings;
                Object.assign(firstPatch.editorPayload.context, JSON.parse(JSON.stringify({ groundSurface, groundBoundary, landTake })));
            }
            replaceWithFreeform(store, draft, firstPatch);
        } catch (error) {
            siblings.forEach(id => { try { store.deleteDraft(id); } catch (_) { } });
            return { ok: false, reason: error?.message || String(error) };
        }
        freeformSiblingDrafts.set(String(draft.id), { siblings, draft: recoveryDraft });
        previousSiblings.forEach(id => { try { store.deleteDraft(id); } catch (_) { } });
        return { ok: true, count: list.length };
    }

    // A Detached rule's conversion: the maximum-height envelope on each parcel becomes one Freeform
    // building there. This wrapper retains its rule-specific confirmation and massing normalization,
    // then uses the same staging and sequential-save path as fixed-geometry imports.
    async function convertActiveDesignToFreeformBuildings({ houses, typology = 'parcelBased', confirm = true } = {}) {
        const list = (houses || []).filter(house => house?.feature?.geometry);
        if (!list.length) return { ok: false, code: 'no-buildings', reason: MERGE_REFUSALS['no-buildings'][1] };
        const merged = list.map(house => mergeRuleBuildings([house.feature]));
        const refused = merged.find(result => !result.ok);
        if (refused) return refused;
        const source = getActiveProposalDesignDraft()?.sourceLocalProposalId
            ? proposalById(getActiveProposalDesignDraft().sourceLocalProposalId) : null;
        if (confirm && !(await confirmFreeformConversion(source || { title: getActiveProposalDesignDraft()?.fields?.name }, typology, list.length))) {
            return { ok: false, cancelled: true };
        }
        return stageActiveFreeformBuildings({ buildings: list.map((house, index) => ({
            building: merged[index].building,
            site: house.site
        })) });
    }

    // The further houses save one after another once the first has saved: they are cut into the
    // ground after it, never alongside it. A failed first save has already restored the complete
    // drawing for repair, so none of the remaining houses may be saved independently.
    async function saveFreeformSiblings(firstResult, siblingIds) {
        if (!siblingIds?.length) return firstResult;
        const store = global.proposalDraftStore;
        if (!firstResult) {
            siblingIds.forEach(id => { try { store.deleteDraft(id); } catch (_) { } });
            return firstResult;
        }
        for (const id of siblingIds) {
            await instantCreateProposalFromDraft(id);
        }
        return firstResult;
    }

    function dropFreeformSiblings(draftId) {
        const siblings = freeformSiblingDrafts.get(String(draftId))?.siblings || [];
        freeformSiblingDrafts.delete(String(draftId));
        siblings.forEach(id => { try { global.proposalDraftStore?.deleteDraft?.(id); } catch (_) { } });
    }

    function restoreStagedFreeformDesign(draftId, store) {
        const staged = freeformSiblingDrafts.get(String(draftId));
        if (!staged || !store?.getDraft?.(draftId)) return;
        store.updateDraft(draftId, () => JSON.parse(JSON.stringify(staged.draft)), { recordHistory: false });
        dropFreeformSiblings(draftId);
    }

    // "Apply the same rule to the parcels here" moves the design's land: the rule now builds on
    // `parcelIds`, so the active draft declares those parcels and their site, for the edit of a
    // saved record too (syncActiveProposalDraftFromEditor keeps a saved record's parcels, since an
    // ordinary geometry edit does not change them). Without it Done saved the new buildings
    // against the old parcels and the save was refused as extending beyond them.
    function moveActiveDesignToParcels(parcelIds) {
        const store = global.proposalDraftStore;
        const draft = getActiveProposalDesignDraft();
        const ids = [...new Set((parcelIds || []).map(String).filter(Boolean))];
        if (!store || !draft || !ids.length) return null;
        const site = siteOfLiveSelection(ids);
        if (!site) return null;
        return store.updateDraft(draft.id, current => ({
            ...current,
            fields: { ...(current.fields || {}), selectedParcelIds: ids, cadastreParcelIds: [], site, binding: null }
        }), { coalesceKey: 'editor:building' });
    }

    // The choice a rule editor offers when its design is dropped off its parcels. Resolves 'convert',
    // 'rule' or 'cancel'. `tryConvert()` and `tryRule()` carry the choice out and resolve
    // { ok, reason }; a refusal is said in the same dialog, which stays open. Without `tryConvert`
    // (a Detached rule on several parcels) only the rule and Cancel are offered.
    async function chooseRuleDrop({ typology, tryConvert = null, tryRule, buildings = 1 } = {}) {
        const many = buildings > 1;
        let reason = '';
        for (;;) {
            const rule = ruleLabel(typology);
            const intro = tDraft('proposalDrafts.freeform.dropMessage', 'The {{rule}} rule builds on its own parcels, so the design cannot simply move. What should happen here?', { rule })
                + (typeof tryConvert === 'function'
                    ? `\n\n${many
                        ? tDraft('proposalDrafts.freeform.dropConvertMeaningMany', 'Converting makes each of the {{count}} houses one Freeform design: its parcel\'s massing at the greatest height the rule allows. The rule\'s parameters no longer apply to them.', { count: buildings })
                        : tDraft('proposalDrafts.freeform.dropConvertMeaning', 'Converting keeps the rule\'s massing at the greatest height it allows; the rule\'s parameters no longer apply to it.')}`
                    : '');
            const answer = await global.CbDialog.choice(reason ? `${reason}\n\n${intro}` : intro, [
                ...(typeof tryConvert === 'function'
                    ? [{ value: 'convert', label: many
                        ? tDraft('proposalDrafts.freeform.titleMany', 'Convert to freeform buildings')
                        : tDraft('proposalDrafts.freeform.dropConvert', 'Convert to Freeform and keep it here'), primary: true }]
                    : []),
                { value: 'rule', label: tDraft('proposalDrafts.freeform.dropRule', 'Apply the same rule to the parcels here'), primary: typeof tryConvert !== 'function' },
                { value: 'cancel', label: tDraft('proposalDrafts.freeform.dropCancel', 'Cancel') }
            ], { title: tDraft('proposalDrafts.freeform.dropTitle', 'Moved off its parcels') });
            if (answer !== 'rule' && answer !== 'convert') return 'cancel';
            let result = null;
            try { result = await (answer === 'rule' ? tryRule() : tryConvert()); } catch (error) { result = { ok: false, reason: error?.message || String(error) }; }
            if (result?.ok) return answer;
            reason = result?.reason || tDraft('proposalDrafts.freeform.ruleFailed', 'The rule cannot build on the parcels here.');
        }
    }

    // Build-first creation from the parcel panel's Build palette: a fresh draft seeded with the
    // selection opens the type's design tool directly (no create dialog); closing the tool with a
    // design commits it as an applied object, exactly like a geometry edit does. Who decides and on
    // what terms is set later, in an agreement over the object (plan-design-agreement.md).
    async function startInstantProposalDesign(adapterKey, parcelIds) {
        if (global.OnMapEditor?.isActive?.()) return false;
        const ids = (parcelIds || []).map(String).filter(Boolean);
        if (!ids.length) return false;
        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: adapterKey,
            proposalType: proposalLabel(adapterKey),
            adapterKey,
            // The selection's union is the design's site (a block's superparcel): the binding at
            // publish is computed from it, so parcels the rule left without a building stay bound.
            fields: { name: '', description: '', selectedParcelIds: ids, site: siteOfLiveSelection(ids) },
            editorPayload: {},
            previewGeometry: null
        });
        if (!draft) return false;
        geometryEditCommitDraftId = draft.id;
        try { global.document?.getElementById('parcel-info-panel')?.classList.remove('visible'); } catch (_) { }
        let opened = false;
        try {
            opened = await global.openProposalDraftDesign?.(draft.id);
        } catch (error) {
            opened = false;
            console.warn('[ProposalEditor] Build tool failed to open', error);
        }
        if (opened === false) {
            geometryEditCommitDraftId = null;
            global.proposalDraftStore.deleteDraft(draft.id);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tDraft('proposalDrafts.design.unavailable', 'This design editor is unavailable.'));
            }
        }
        return opened;
    }

    // ---- Site-first creation (js/site-drawing.js, PARCEL-OPTIONAL.md phase 2) ----
    // siteContext: { site (MultiPolygon), toleranceM, binding (preview or server), selectionIds? }. The draft carries the site; its declaration starts as the binding's parcels
    // and is replaced by the server binding at publish.
    function siteDraftFields(siteContext, selectedParcelIds) {
        return {
            name: '',
            description: '',
            selectedParcelIds: (selectedParcelIds || []).map(String),
            site: JSON.parse(JSON.stringify(siteContext.site)),
            toleranceM: Number(siteContext.toleranceM) || 0,
            binding: siteContext.binding ? JSON.parse(JSON.stringify(siteContext.binding)) : null
        };
    }

    function polygonOfSite(site) {
        const geometry = site && site.type === 'Feature' ? site.geometry : site;
        if (geometry && geometry.type === 'MultiPolygon' && geometry.coordinates.length === 1) {
            return { type: 'Polygon', coordinates: geometry.coordinates[0] };
        }
        return geometry;
    }

    // A park, square or lake IS its site: no design tool, the object appears, on cadastral
    // parcels and on open ground alike (PARCEL-OPTIONAL.md phase 3). options.structure adds
    // record fields (an uploaded model's) to the structure; its geometry stays the site's.
    async function instantCreateStructureFromSite(kind, siteContext, options = {}) {
        if (!STRUCTURE_KIND_LABELS[kind] || !siteContext || !siteContext.site) return null;
        const extraFields = options.structure ? JSON.parse(JSON.stringify(options.structure)) : {};
        delete extraFields.geometry;
        let structureGeometry = polygonOfSite(siteContext.site);
        if (!structureGeometryIsOneArea(structureGeometry)) {
            reportDisconnectedStructureSelection();
            return null;
        }
        let lakeGraphics = null;
        if (kind === 'lake' && typeof global.buildLakeGraphicsFromGeometry === 'function') {
            lakeGraphics = global.buildLakeGraphicsFromGeometry(structureGeometry);
            if (!lakeGraphics || !lakeGraphics.geometry) {
                const message = tDraft('proposalDrafts.errors.parcelsNotContiguous', 'A lake needs contiguous parcels.');
                if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
                return null;
            }
            structureGeometry = lakeGraphics.geometry;
        }
        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: kind,
            proposalType: STRUCTURE_KIND_LABELS[kind],
            adapterKey: kind,
            // No live selection: the site's binding is the declaration, even when the site
            // started as a selection's outline (it may have been reshaped since).
            fields: siteDraftFields(siteContext, []),
            editorPayload: {
                // A drawn site needs the same authoritative binding on first placement as on
                // later moves. A preview with unknown coverage must not become applied ground.
                placement: { free: true, site: JSON.parse(JSON.stringify(siteContext.site)), bindingStatus: 'pending' },
                structureProposal: {
                    ...extraFields,
                    kind, applied: false, geometry: structureGeometry, blockName: null, lakeGraphics: lakeGraphics || null
                }
            },
            previewGeometry: structureGeometry
        });
        if (!draft) {
            reportProposalDesignSaveFailure('proposalDrafts.design.draftCreateFailed');
            return null;
        }
        return instantCreateProposalFromDraft(draft.id);
    }

    // A park, square or lake from an uploaded model (the create dialog's Upload): the model's
    // projected outline, placed at a point on the anchor (the dialog's site or selection), is a
    // drawn site, so it binds like any site-first structure. Returns null at once when the model
    // cannot be placed, else the pending creation.
    function instantCreateStructureFromModel(kind, anchor, upload) {
        const api = global.ProposalApplyStructures;
        if (!STRUCTURE_KIND_LABELS[kind] || !api || !global.turf || !global.SingleBuildingGeometry) return null;
        const geometry = api.structureModelGeometry(upload?.footprint, anchor, {
            turf: global.turf,
            placeModelFootprint: global.SingleBuildingGeometry.placeModelFootprint
        });
        const structure = geometry ? api.structureFromModelUpload(kind, geometry, upload) : null;
        if (!structure) return null;
        const site = { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
        return instantCreateStructureFromSite(kind, { site, toleranceM: 0, binding: null }, { structure });
    }

    function reportSiteDesignStartIssue(key, fallback, params = {}) {
        let message;
        switch (key) {
            case 'editorBusy': message = tDraft('proposalDrafts.design.editorBusy', fallback, params); break;
            case 'siteUnavailable': message = tDraft('proposalDrafts.design.siteUnavailable', fallback, params); break;
            case 'parcelsUnavailable': message = tDraft('proposalDrafts.design.parcelsUnavailable', fallback, params); break;
            case 'draftCreateFailed': message = tDraft('proposalDrafts.design.draftCreateFailed', fallback, params); break;
            case 'handoffFailed': message = tDraft('proposalDrafts.design.handoffFailed', fallback, params); break;
            case 'handoffFailedReason': message = tDraft('proposalDrafts.design.handoffFailedReason', fallback, params); break;
            default: message = fallback;
        }
        try { global.showEphemeralMessage?.(message, 7000, 'error'); } catch (_) { }
        try { global.updateStatus?.(message); } catch (_) { }
        return false;
    }

    // Shared feedback for draft commits initiated by geometry editors. Include a localized reason
    // when one is available without guessing whether the record was created or retained.
    function reportProposalDesignSaveFailure(error = null) {
        let reason = String(error?.message || error || '');
        if (reason.startsWith('proposalDrafts.')) reason = tDraft(reason, '');
        reason = reason.replace(/[\s.!?]+$/, '');
        const message = reason
            ? tDraft('proposalDrafts.errors.designSaveFailedReason', 'Your changes could not be saved ({{reason}}). Try again.', { reason })
            : tDraft('proposalDrafts.errors.designSaveFailed', 'Your changes could not be saved. Try again.');
        try { global.showEphemeralMessage?.(message, 7000, 'error'); } catch (_) { }
        try { global.updateStatus?.(message); } catch (_) { }
        return message;
    }

    function reopenFailedProposalDraftOnce(draftId, store = global.proposalDraftStore, options = {}) {
        const id = String(draftId || '');
        if (!id || failedDraftReopenInFlight.has(id)) return false;
        restoreStagedFreeformDesign(draftId, store);
        let retained = null;
        try { retained = store?.getDraft?.(draftId) || null; } catch (_) { }
        if (!retained || typeof global.openProposalDraftDesign !== 'function') return false;
        const commitOnFinish = options.commitOnFinish === true
            || String(geometryEditCommitDraftId || '') === String(draftId);
        // openProposalDraftDesign calls finish on a false result or rejection. Clear the old
        // matching marker before the handoff so that path cannot recursively commit/reopen; put
        // it back only after a successful editor open.
        if (String(geometryEditCommitDraftId || '') === String(draftId)) geometryEditCommitDraftId = null;
        failedDraftReopenInFlight.add(id);
        const reportReopenFailure = () => {
            if (typeof options.onReopenFailure === 'function') options.onReopenFailure();
            else reportProposalDesignSaveFailure('proposalDrafts.errors.designEditorReopenFailed');
        };
        Promise.resolve().then(() => global.openProposalDraftDesign(draftId)).then(opened => {
            if (!opened) {
                reportReopenFailure();
                return;
            }
            const adapterKey = retained.adapterKey || retained.goal;
            if (commitOnFinish
                && String(editorState.designDraftId || '') === String(draftId)
                && GEOMETRY_EDITABLE_ADAPTERS.has(adapterKey)) {
                geometryEditCommitDraftId = String(draftId);
            }
        }).catch(() => {
            reportReopenFailure();
        }).finally(() => failedDraftReopenInFlight.delete(id));
        return true;
    }

    // A building typology on a site: the design tool opens on the site's design parcels (the live
    // selection it came from, the whole site as one synthetic superparcel, or synthetic plots cut
    // along a frontage), and Done commits the draft as for any Build-palette creation.
    async function startInstantSiteDesign(adapterKey, siteContext, designParcelIds) {
        if (global.OnMapEditor?.isActive?.()) {
            return reportSiteDesignStartIssue('editorBusy', 'Another geometry editor is already using the map. Close it before starting this site design.');
        }
        const ids = (designParcelIds || []).map(String).filter(Boolean);
        if (!ids.length) return reportSiteDesignStartIssue('parcelsUnavailable', 'No design parcels are available for this site. Select the site again and try once its parcels are loaded.');
        if (!siteContext || !siteContext.site) {
            return reportSiteDesignStartIssue('siteUnavailable', 'The selected site is unavailable. Select a valid site and try again.');
        }
        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: adapterKey,
            proposalType: proposalLabel(adapterKey),
            adapterKey,
            fields: siteDraftFields(siteContext, ids),
            editorPayload: {},
            previewGeometry: null
        });
        if (!draft) return reportSiteDesignStartIssue('draftCreateFailed', 'Could not save a local draft for this site design. The site remains unchanged.');
        geometryEditCommitDraftId = draft.id;
        let opened = false;
        try {
            opened = await global.openProposalDraftDesign?.(draft.id);
        } catch (error) {
            opened = false;
            console.warn('[ProposalEditor] Site design tool failed to open', error);
            geometryEditCommitDraftId = null;
            return reportSiteDesignStartIssue('handoffFailedReason', 'The design editor could not open: {{reason}}. Your site is unchanged, and the design draft was preserved locally.', {
                reason: String(error?.message || error || 'unknown error')
            });
        }
        if (!opened) {
            geometryEditCommitDraftId = null;
            return reportSiteDesignStartIssue('handoffFailed', 'The design editor could not open. Your site is unchanged, and the design draft was preserved locally.');
        }
        return opened;
    }

    // Subdivide a site (PARCEL-OPTIONAL.md phase 4): the parcel-layout editor opens with the site as
    // its pool, the bound parcels' part and the open ground alike. No live selection: the
    // declaration is the site's binding (replaced by the server's at publish).
    async function startSiteSubdivision(siteContext) {
        if (global.OnMapEditor?.isActive?.()) {
            return reportSiteDesignStartIssue('editorBusy', 'Another geometry editor is already using the map. Close it before starting this site design.');
        }
        if (!siteContext || !siteContext.site) {
            return reportSiteDesignStartIssue('siteUnavailable', 'The selected site is unavailable. Select a valid site and try again.');
        }
        const site = JSON.parse(JSON.stringify(siteContext.site));
        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: 'parcel-layout',
            proposalType: proposalLabel('parcel-layout'),
            adapterKey: 'parcel-layout',
            fields: siteDraftFields(siteContext, []),
            editorPayload: { plan: { poolSource: 'site', pool: site, algorithm: 'equal', plots: [] } },
            previewGeometry: null
        });
        if (!draft) return reportSiteDesignStartIssue('draftCreateFailed', 'Could not save a local draft for this site design. The site remains unchanged.');
        geometryEditCommitDraftId = draft.id;
        let opened = false;
        try {
            opened = await global.openProposalDraftDesign?.(draft.id);
        } catch (error) {
            opened = false;
            console.warn('[ProposalEditor] Subdivision editor failed to open', error);
            geometryEditCommitDraftId = null;
            return reportSiteDesignStartIssue('handoffFailedReason', 'The design editor could not open: {{reason}}. Your site is unchanged, and the design draft was preserved locally.', {
                reason: String(error?.message || error || 'unknown error')
            });
        }
        if (!opened) {
            geometryEditCommitDraftId = null;
            return reportSiteDesignStartIssue('handoffFailed', 'The design editor could not open. Your site is unchanged, and the design draft was preserved locally.');
        }
        return opened;
    }

    // The union of a live parcel selection, as the site of a design started from it.
    function siteOfLiveSelection(ids) {
        try {
            const features = (ids || []).map(id => global.LiveParcelFabric?.get?.(String(id))).filter(Boolean);
            return features.length && global.__siteDraft ? global.__siteDraft.siteFromFeatures(features) : null;
        } catch (error) {
            console.warn('[ProposalEditor] could not union the selection into a site', error);
            return null;
        }
    }

    const STRUCTURE_KIND_LABELS = { park: 'Park', square: 'Square', lake: 'Lake' };

    function structureGeometryIsOneArea(geometry) {
        const value = geometry?.type === 'Feature' ? geometry.geometry : geometry;
        try {
            if (global.__parcelContiguity?.isContiguous) {
                return global.__parcelContiguity.isContiguous(value);
            }
        } catch (_) { }
        if (value?.type === 'Polygon') return Array.isArray(value.coordinates) && value.coordinates.length > 0;
        return value?.type === 'MultiPolygon'
            && Array.isArray(value.coordinates)
            && value.coordinates.length === 1;
    }

    function reportDisconnectedStructureSelection() {
        const message = tDraft(
            'proposalDrafts.errors.parcelsNotContiguous',
            'The selected parcels must form one connected area.'
        );
        if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
        else if (typeof global.updateStatus === 'function') global.updateStatus(message);
    }

    // One-click structures: a park/square/lake IS the selection's union — there is no design
    // tool, the object simply appears applied (auto-named).
    async function instantCreateStructureFromSelection(kind, parcelIds) {
        if (!STRUCTURE_KIND_LABELS[kind]) return null;
        const ids = (parcelIds || []).map(String).filter(Boolean);
        if (!ids.length) return null;
        const selection = await global.prepareProposalDraftParcelSelection?.(ids);
        if (selection?.complete === false || !selection?.layers?.length) {
            const message = tDraft('proposalDrafts.errors.parcelsUnavailable', 'The selected parcels are not available in this city view.');
            if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
            return null;
        }
        const contiguity = typeof global.areParcelsContiguous === 'function'
            ? global.areParcelsContiguous(selection.ids)
            : { contiguous: true };
        if (!contiguity.contiguous) {
            reportDisconnectedStructureSelection();
            return null;
        }
        // Publish the exact live ids that were selected alongside their geometry. The adapter may
        // only substitute ids when reopening an authored record with its immutable footprint;
        // fresh creation never guesses from cadastral ancestry.
        const liveIds = Array.isArray(selection.ids) && selection.ids.length
            ? selection.ids.map(String)
            : ids;
        const geometry = typeof global.buildGeometryFromParcels === 'function'
            ? global.buildGeometryFromParcels(liveIds)
            : null;
        if (!geometry || !geometry.type) {
            reportProposalDesignSaveFailure('proposalDrafts.errors.structureGeometryFailed');
            return null;
        }
        if (!structureGeometryIsOneArea(geometry)) {
            reportDisconnectedStructureSelection();
            return null;
        }
        let lakeGraphics = null;
        let structureGeometry = geometry;
        if (kind === 'lake' && typeof global.buildLakeGraphicsFromGeometry === 'function') {
            lakeGraphics = global.buildLakeGraphicsFromGeometry(geometry);
            if (!lakeGraphics || !lakeGraphics.geometry) {
                const message = tDraft('proposalDrafts.errors.parcelsNotContiguous', 'A lake needs contiguous parcels.');
                if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
                return null;
            }
            structureGeometry = lakeGraphics.geometry;
        }
        if (!structureGeometryIsOneArea(structureGeometry)) {
            reportDisconnectedStructureSelection();
            return null;
        }
        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: kind,
            proposalType: STRUCTURE_KIND_LABELS[kind],
            adapterKey: kind,
            fields: { name: '', description: '', selectedParcelIds: liveIds, site: siteOfLiveSelection(liveIds) },
            editorPayload: {
                structureProposal: {
                    kind,
                    applied: false,
                    geometry: structureGeometry,
                    blockName: null,
                    lakeGraphics: lakeGraphics || null
                }
            },
            previewGeometry: structureGeometry
        });
        if (!draft) {
            reportProposalDesignSaveFailure('proposalDrafts.design.draftCreateFailed');
            return null;
        }
        try { global.document?.getElementById('parcel-info-panel')?.classList.remove('visible'); } catch (_) { }
        return instantCreateProposalFromDraft(draft.id);
    }

    function beginProposalDraftDesignSession(draftId) {
        const draft = global.proposalDraftStore?.getDraft?.(draftId);
        if (!draft) return null;
        editorState.designDraftId = draft.id;
        global.activeProposalDesignDraftId = draft.id;
        global.proposalDraftStore.resumeDraft(draft.id);
        return draft;
    }

    function getActiveProposalDesignDraft() {
        const draftId = editorState.designDraftId || global.activeProposalDesignDraftId || null;
        return draftId ? global.proposalDraftStore?.getDraft?.(draftId) || null : null;
    }

    function finishProposalDraftDesignSession(draftId = null) {
        const activeId = editorState.designDraftId || global.activeProposalDesignDraftId || null;
        if (!activeId || (draftId && String(activeId) !== String(draftId))) return null;
        let draft = null;
        try {
            draft = global.proposalDraftStore?.getDraft?.(activeId) || null;
            if (draft) {
                global.proposalDraftStore.validateDraft(activeId);
                global.proposalDraftStore.flush();
            }
        } catch (error) {
            reportProposalDesignSaveFailure(error);
            // This is called after most geometry tools have torn down. Make one bounded attempt
            // to restore the editor around the retained draft, while preserving the sync return
            // contract used by callers to detect that finishing failed.
            reopenFailedProposalDraftOnce(activeId, global.proposalDraftStore, {
                commitOnFinish: String(geometryEditCommitDraftId || '') === String(activeId)
            });
            return null;
        }
        editorState.designDraftId = null;
        global.activeProposalDesignDraftId = null;
        // The design tool seeded multi-select for its parcel context; closing the tool must
        // disarm it, or the "Multiparcel selection" panel resurfaces on later clicks.
        try { global.releaseEditorSeededMultiSelection?.(); } catch (_) { }
        // A confirmed design tool commits its session here: a changed draft saves (in place for
        // one's own local record, as a counterproposal of a published one); an untouched one
        // dissolves without residue.
        // An abandoned session (X/Esc) never reaches this point — discardProposalDraftDesignSession
        // clears the commit id first, so tearing the tool down publishes nothing.
        // A collection uploaded from the form's Design tab also produces ordinary local objects
        // on Done. Leaving its siblings tied to the closed session would delete their geometry.
        const stagedSiblings = freeformSiblingDrafts.get(String(activeId))?.siblings || [];
        let saving = false;
        if ((geometryEditCommitDraftId && String(geometryEditCommitDraftId) === String(activeId)) || stagedSiblings.length) {
            const commitId = activeId;
            geometryEditCommitDraftId = null;
            const current = global.proposalDraftStore.getDraft(commitId);
            const siblings = stagedSiblings;
            if (current && current.dirty) {
                saving = true;
                Promise.resolve(instantCreateProposalFromDraft(commitId, { commitOnFinish: true }))
                    .then(result => {
                        if (result) freeformSiblingDrafts.delete(String(commitId));
                        return saveFreeformSiblings(result, siblings);
                    }).catch(error => {
                    console.warn('[ProposalEditor] Geometry edit commit failed; draft kept', error);
                    reportProposalDesignSaveFailure(error);
                    reopenFailedProposalDraftOnce(commitId, global.proposalDraftStore, { commitOnFinish: true });
                });
            } else if (current) {
                siblings.forEach(id => { try { global.proposalDraftStore.deleteDraft(id); } catch (_) { } });
                global.proposalDraftStore.deleteDraft(commitId);
            }
        }
        if (!saving) dropFreeformSiblings(activeId);
        if (editorState.draftId === activeId && ensureShell()?.classList.contains('is-open')) renderShell();
        return draft;
    }

    // Does the open design tool own a commit-on-confirm session — a geometry edit of an existing
    // object, or a Build-palette creation? Those turn into an object ONLY when the tool is
    // confirmed, so their close (X/Esc) path has something to lose and must ask first.
    function isProposalDesignCommitSession() {
        const activeId = editorState.designDraftId || global.activeProposalDesignDraftId || null;
        if (!activeId || !geometryEditCommitDraftId) return false;
        return String(activeId) === String(geometryEditCommitDraftId);
    }

    // Abandon a design session instead of committing it: the seeding draft is deleted, so a
    // geometry edit leaves its source object untouched and a Build session leaves nothing behind.
    function discardProposalDraftDesignSession() {
        if (!isProposalDesignCommitSession()) return false;
        const commitId = geometryEditCommitDraftId;
        geometryEditCommitDraftId = null;
        editorState.designDraftId = null;
        global.activeProposalDesignDraftId = null;
        // The design tool seeded multi-select for its parcel context; abandoning it must disarm
        // that too, or the "Multiparcel selection" panel resurfaces on later clicks.
        try { global.releaseEditorSeededMultiSelection?.(); } catch (_) { }
        try { global.proposalDraftStore?.deleteDraft?.(commitId); } catch (_) { }
        dropFreeformSiblings(commitId);
        clearProposalDraftComparison();
        return true;
    }

    // Gate for the X/Esc path of every design tool: resolves false when the user chooses to stay in
    // the tool. Sessions that cannot commit on their own (the editor shell's "Edit design on map",
    // whose draft outlives the tool) close silently — there is nothing to lose there. The discard
    // itself happens in the tool's teardown, which calls discardProposalDraftDesignSession.
    async function confirmDiscardProposalDesignSession(options = {}) {
        if (!isProposalDesignCommitSession() || options.hasDesign === false) return true;
        return confirmDestructive(
            `${tDraft('proposalDrafts.discardDesign.title', 'Discard this design?')}\n${tDraft('proposalDrafts.discardDesign.body', 'Closing the editor throws away the changes you made here. Use Done to keep them.')}`,
            {
                okText: tDraft('proposalDrafts.discardDesign.confirm', 'Discard'),
                cancelText: tDraft('proposalDrafts.discardDesign.cancel', 'Keep editing'),
                destructive: true
            }
        );
    }

    function dialogGoal(draft) {
        if (['buildings', 'row', 'parcelBased'].includes(draft.adapterKey || draft.goal)) return 'urban-rule';
        return draft.goal;
    }

    function seedDraftPendingState(draft) {
        const payload = draft.editorPayload || {};
        if (draft.goal === 'road-track') {
            const definition = payload.definition || {};
            const points = definition.points || definition.segments || [];
            global.pendingRoadDrawingProposal = {
                centerline: JSON.parse(JSON.stringify(points)),
                segmentIds: JSON.parse(JSON.stringify(definition.segmentIds || [])),
                profile: JSON.parse(JSON.stringify(definition.profile || null)),
                width: definition.width,
                sidewalkWidth: definition.sidewalkWidth,
                tunnels: JSON.parse(JSON.stringify(definition.tunnels || [])),
                polygon: JSON.parse(JSON.stringify(definition.polygon || null)),
                metadata: JSON.parse(JSON.stringify(definition.metadata || {})),
                parcelIds: (draft.fields?.selectedParcelIds || []).slice()
            };
            return true;
        }
        if (['buildings', 'row', 'parcelBased', 'single'].includes(draft.adapterKey || draft.goal)) {
            global.pendingBuildingProposalContext = JSON.parse(JSON.stringify(payload.context || {}));
            if (typeof global.setPendingBuildingProposalContext === 'function') global.setPendingBuildingProposalContext(global.pendingBuildingProposalContext, { fromDraft: true });
            return true;
        }
        return !!payload.geometry;
    }

    function applyDraftFacetsToProposalDialog(draft) {
        const fields = draft.fields || {};
        if (fields.acquisitionMode && typeof global.setProposalAcquisitionMode === 'function') {
            global.setProposalAcquisitionMode(fields.acquisitionMode);
        }
        if (fields.boundaryAdjustment && typeof global.setProposalBoundaryMode === 'function') {
            global.setProposalBoundaryMode(fields.boundaryAdjustment, { unlock: true });
        }
        if (fields.ownership && typeof global.setProposalOwnershipMode === 'function') {
            global.setProposalOwnershipMode(fields.ownership, { unlock: true });
        }
        if (fields.recipientScope) {
            global.document?.querySelectorAll?.('input[name="proposalRecipientScope"]')?.forEach(input => {
                input.checked = input.value === fields.recipientScope;
            });
        }
        const recipient = global.document?.getElementById('proposalRecipientAddress');
        if (recipient && fields.recipientAddress !== undefined && fields.recipientAddress !== null) {
            recipient.value = fields.recipientAddress;
        }
        if (typeof global.onProposalOwnershipChange === 'function') global.onProposalOwnershipChange();
        const name = global.document?.getElementById('proposalName');
        const description = global.document?.getElementById('proposalDescription');
        if (name) {
            name.value = fields.name || '';
            name.dataset.titleOrigin = fields.titleOrigin === 'generated' ? 'generated' : fields.titleOrigin === 'user' ? 'user' : '';
        }
        if (description) description.value = fields.description || '';
    }

    async function stageProposalDraftForPublishing(draftId, options = {}) {
        const store = global.proposalDraftStore;
        let draft = store?.getDraft?.(draftId) || null;
        // A parcel layout is shared only with its agreement (ProposalPublishTerms.publishRefusal).
        const refusal = draft ? global.ProposalPublishTerms?.publishRefusal?.({ goal: draft.goal }) : null;
        if (refusal) {
            if (typeof global.showStyledAlert === 'function') global.showStyledAlert(refusal.message);
            else if (typeof global.updateStatus === 'function') global.updateStatus(refusal.message);
            return false;
        }
        if (draft && global.proposalDraftPlacement?.isFreePlacementDraft?.(draft)) {
            try {
                draft = await rebindFreePlacementDraft(draftId);
            } catch (error) {
                store.markPublishFailed(draftId, error);
                const message = error?.message || String(error);
                if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
                else if (typeof global.updateStatus === 'function') global.updateStatus(message);
                return false;
            }
        }
        draft = store?.validateDraft(draftId);
        if (!draft?.validation?.valid) {
            if (draft) renderShell();
            return false;
        }
        const receipt = store.getPublishReceipt(draftId);
        if (receipt) {
            if (typeof global.showStyledAlert === 'function') {
                global.showStyledAlert(tDraft('proposalDrafts.publish.alreadyCreated', 'This draft already created design {{id}}.', { id: receipt.persistedProposalId || '' }));
            }
            return false;
        }
        // A site-first draft (a drawn site, possibly on ground without parcels) needs no live
        // parcel selection: its ground is the site, its declaration the binding (publish computes
        // the server's). The dialog takes the site instead of the selection.
        const authoredSite = global.__siteDraft?.draftSite?.(draft) || null;
        const liveSelectionIds = (draft.fields?.selectedParcelIds || []).map(String)
            .filter(id => !/^site(-plot)?:/.test(id));
        // A material record with no parcels at all (a road drawn across bare ground) has its
        // footprint as its site.
        const footprintSite = !authoredSite && !liveSelectionIds.length && draft.sourceSnapshot
            && global.__siteBinding && !global.__siteBinding.requiresParcels(draft.sourceSnapshot)
            ? global.__siteBinding.siteOf(draft.sourceSnapshot) : null;
        const site = authoredSite || footprintSite;
        const siteContext = site && (draft.sourceSnapshot?.site || footprintSite || !liveSelectionIds.length) ? {
            site,
            authored: !!authoredSite,
            toleranceM: Number(draft.fields?.toleranceM) || 0,
            binding: draft.fields?.binding || null,
            cadastreParcelIds: (draft.fields?.cadastreParcelIds || []).map(String)
        } : null;
        const selection = siteContext
            ? { ids: [], layers: [], complete: true }
            : await global.prepareProposalDraftParcelSelection?.(draft);
        if (!siteContext && !selection?.layers?.length) {
            const message = tDraft('proposalDrafts.errors.parcelsUnavailable', 'The draft parcels are not available in the current city.');
            store.markPublishFailed(draftId, new Error(message));
            // The editor shell is dormant UI — say it out loud instead of rendering into the void.
            if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
            else if (typeof global.updateStatus === 'function') global.updateStatus(message);
            return false;
        }
        if ((selection?.usesSourceChildren || selection?.substituted) && selection.ids?.length) {
            store.updateDraft(draftId, { fields: { selectedParcelIds: selection.ids.map(String) } }, {
                coalesceKey: 'applied-source-descendants'
            });
            draft = store.validateDraft(draftId);
        }
        const seeded = seedDraftPendingState(draft);
        const fields = draft.fields || {};
        const prefill = {
            name: fields.name || '',
            description: fields.description || ''
        };
        global.pendingProposalDraftId = draft.id;
        global.pendingProposalReplacementSource = {
            proposalId: draft.sourceLocalProposalId || null,
            name: draft.sourceSnapshot?.title || draft.sourceSnapshot?.name || null,
            draftId: draft.id,
            revision: draft.revision,
            // The explicit Fork action makes a new record even from a local source (lineage.js).
            fork: options.fork === true
        };
        const overrides = {
            goal: dialogGoal(draft),
            acquisitionMode: fields.acquisitionMode || null,
            siteContext,
            prefill,
            copySource: draft.sourceLocalProposalId ? { proposalId: draft.sourceLocalProposalId, name: global.pendingProposalReplacementSource.name } : null,
            geometryPreset: seeded ? {
                statusText: tDraft('proposalDrafts.publish.geometryReady', 'Geometry attached from the draft'),
                submitted: true,
                selectedAction: 'edit',
                disableButtons: false
            } : null
        };
        if (typeof global.showProposalDialog !== 'function') {
                store.markPublishFailed(draft.id, new Error('Design creation is unavailable.'));
            renderShell();
            return false;
        }
        global.showProposalDialog(overrides);
        applyDraftFacetsToProposalDialog(draft);
        const typology = draft.adapterKey;
        if (['buildings', 'row', 'parcelBased'].includes(typology) && typeof global.handleUrbanRuleTypologyClick === 'function') {
            const key = typology === 'buildings' ? (payloadTypology(draft) || 'block') : typology;
            global.handleUrbanRuleTypologyClick(key, { skipLaunch: true });
            if (typeof global.setCurrentProposalToolFromDraft === 'function') {
                global.setCurrentProposalToolFromDraft(key === 'row' ? 'row' : (key === 'parcelBased' ? 'parcelBased' : 'buildings'));
            }
            const typeInput = global.document?.getElementById('proposalType');
            if (typeInput) typeInput.value = 'Residences';
        }
        if (draft.adapterKey === 'single' && typeof global.setCurrentProposalToolFromDraft === 'function') {
            global.setCurrentProposalToolFromDraft('single');
        }
        const submit = global.document?.getElementById('createProposalSubmitButton');
        if (submit) {
            const source = draft.sourceLocalProposalId ? proposalById(draft.sourceLocalProposalId) : null;
            submit.textContent = source
                ? global.ProposalLineage.forkSubmitLabel(draft.sourceLocalProposalId, { fork: options.fork === true })
                : tDraft('proposalDrafts.actions.createProposal', 'Create design');
            submit.dataset.proposalDraftId = draft.id;
        }
        closeProposalEditorShell();
        return true;
    }

    // SimCity-style creation: turn a finished draft directly into an applied object on the map —
    // no dialog, no review step. Overlapping applied proposals are auto-parked by the apply gate.
    // Falls back to opening the editor when the draft cannot validate or persist.
    // Where the seconds between "Done" and a finished object go. Clicking Done runs a validation, a
    // record build and a fabric derivation, and until this existed the whole thing happened with no
    // sign at all that anything was under way — the same complaint the drawing tool had.
    const createNow = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());

    function createPhaseReporter(label) {
        const started = createNow();
        const phases = [];
        let last = started;
        return {
            mark(name) {
                const at = createNow();
                phases.push(`${name} ${Math.round(at - last)}`);
                last = at;
            },
            report() {
                try {
                    console.info(`[instantCreate] ${label} — ${Math.round(createNow() - started)} ms: ${phases.join(' · ')}`);
                } catch (_) { }
            }
        };
    }

    async function instantCreateProposalFromDraft(draftId, options = {}) {
        const store = global.proposalDraftStore;
        let draft = null;
        try { draft = store?.getDraft?.(draftId) || null; }
        catch (error) {
            reportProposalDesignSaveFailure(error);
            reopenFailedProposalDraftOnce(draftId, store, { commitOnFinish: true });
            return null;
        }
        if (!draft) return null;

        // Clicking Done is not instant, and it used to look like nothing had happened. The spinner
        // is the same ref-counted one the drawing tool uses, so a corridor create that raises it
        // twice still shows one indicator.
        const profile = createPhaseReporter(draft.proposalType || draft.adapterKey || draft.goal || 'proposal');
        let savingPreview = null;
        try { global.beginApplyIndicator?.(); } catch (_) { }
        try {
            // The map editor has closed, but the applied layers may take seconds to appear.
            // Reuse the shared 2D outline / 3D preview with a snapshot taken before consumption.
            try { savingPreview = renderProposalDraftComparison(draftId, 'draft-only', { saving: true }); }
            catch (error) { console.warn('[ProposalEditor] Saving preview could not be drawn', error); }
            return await instantCreateProposalFromDraftInner(draftId, store, draft, profile, options);
        } catch (error) {
            console.warn('[ProposalEditor] Unexpected instant-create failure; checking for a retained draft', error);
            reportProposalDesignSaveFailure(error);
            reopenFailedProposalDraftOnce(draftId, store, { commitOnFinish: true });
            return null;
        } finally {
            // A new editor/comparison may have taken over while application was pending.
            if (savingPreview && global.activeProposalDraftComparison === savingPreview) paintProposalDraftComparison(null);
            try { global.endApplyIndicator?.(); } catch (_) { }
            profile.report();
        }
    }

    async function instantCreateProposalFromDraftInner(draftId, store, draft, profile, options = {}) {

        const currentName = String(draft.fields?.name || '').trim();
        const typeLabel = draft.goal === 'single' || draft.adapterKey === 'single'
            ? proposalLabel('single')
            : draft.proposalType || proposalLabel(draft.adapterKey || draft.goal);
        const autoFields = {};
        if (!currentName || /^New (road|track)$/i.test(currentName)) {
            autoFields.name = typeof global.generateDefaultProposalName === 'function'
                ? global.generateDefaultProposalName(typeLabel, { parcelIds: draft.fields?.selectedParcelIds || [] })
                : `${typeLabel} ${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`;
            autoFields.titleOrigin = 'generated';
        }
        // Every object carries the standard description pattern from birth.
        const resolvedName = autoFields.name || currentName;
        if (!String(draft.fields?.description || '').trim() && typeof global.generateDefaultProposalDescription === 'function') {
            autoFields.description = global.generateDefaultProposalDescription(typeLabel, resolvedName);
        }
        if (Object.keys(autoFields).length) {
            store.updateDraft(draftId, { fields: autoFields }, { recordHistory: false });
        }
        const keepAsDraft = (reason = '') => {
            // There are no drafts: a drawing that cannot become an object is reopened in the
            // drawing tool so the user can fix it, with a loud message saying WHY it failed.
            const base = tDraft('proposalDrafts.keptAsDraft', 'Could not create the object — the drawing has been reopened so you can fix it.');
            const message = reason ? `${base} (${reason})` : base;
            console.error('[ProposalEditor] instantCreate failed:', reason || '(no reason)');
            if (typeof global.showEphemeralMessage === 'function') global.showEphemeralMessage(message, 7000, 'error');
            if (typeof global.updateStatus === 'function') global.updateStatus(message);
            reopenFailedProposalDraftOnce(draftId, store, {
                commitOnFinish: true,
                onReopenFailure: () => {
                    // Refusing to reopen is not a reason to destroy the retained drawing. Say so
                    // and leave the draft available from the proposal editor.
                    console.error('[ProposalEditor] Could not reopen the failed drawing; the draft is kept', draftId);
                    const stranded = tDraft('proposalDrafts.keptUnopened',
                        'The design tool could not reopen this. Your work is kept as a draft — fix what it complained about and open it again.');
                    try { if (typeof global.showEphemeralMessage === 'function') global.showEphemeralMessage(stranded, 9000, 'error'); } catch (_) { }
                    try { if (typeof global.updateStatus === 'function') global.updateStatus(stranded); } catch (_) { }
                }
            });
            return null;
        };

        draft = store.validateDraft(draftId);
        if (global.proposalDraftPlacement?.isFreePlacementDraft?.(draft)) {
            try {
                draft = await rebindFreePlacementDraft(draftId);
            } catch (error) {
                return keepAsDraft(error?.message || String(error));
            }
            draft = store.validateDraft(draftId);
        }
        if (!draft?.validation?.valid) {
            return keepAsDraft(draft?.validation?.errors?.[0]?.message || '');
        }
        // A free building can move off the parcels it started on. A generated name and description
        // were written from that starting selection, so write them again from the final binding.
        const boundIds = draft.fields?.cadastreParcelIds || [];
        if (draft.fields?.titleOrigin === 'generated' && boundIds.length && global.proposalDraftPlacement?.isFreePlacementDraft?.(draft)
            && typeof global.generateDefaultProposalName === 'function') {
            const renamed = { name: global.generateDefaultProposalName(typeLabel, { parcelIds: boundIds }), titleOrigin: 'generated' };
            if (autoFields.description && typeof global.generateDefaultProposalDescription === 'function') {
                renamed.description = global.generateDefaultProposalDescription(typeLabel, renamed.name);
            }
            store.updateDraft(draftId, { fields: renamed }, { recordHistory: false });
            draft = store.getDraft(draftId);
        }

        let proposal = null;
        try { proposal = store.buildProposalFromDraft(draftId); }
        catch (error) { return keepAsDraft(error?.message || String(error)); }
        if (!proposal) return keepAsDraft();
        if (!proposal.author) {
            try { proposal.author = global.getCurrentUserAgent?.()?.name || undefined; } catch (_) { }
        }

        // An edit of one's own local, unpublished record saves in place; a published or minted
        // source is immutable and gets a counterproposal (proposals/lineage.js editsInPlace).
        // Corridors are edited in place by their own editors (road-drawing.js
        // updateLocalCorridorGeometry), so a corridor draft here is always a new road.
        const editSource = draft.sourceLocalProposalId ? (global.proposalStorage?.getProposal?.(draft.sourceLocalProposalId) || null) : null;
        const inPlaceSource = !proposal.roadProposal?.definition
            && global.ProposalLineage?.editsInPlace?.(editSource) === true ? editSource : null;
        const keepEditing = message => {
            if (typeof global.updateStatus === 'function') global.updateStatus(message);
            reopenFailedProposalDraftOnce(draftId, store, { commitOnFinish: true });
            return null;
        };

        // Every corridor draft uses the same atomic authoring boundary, whichever UI committed it.
        // The drawing tool passes atomicCorridorAuthoring explicitly as a source-level contract;
        // callers cannot accidentally opt a road into the generic store-then-derive path. That
        // includes a corridor across ground without parcels: its ribbon simply has no cadastral
        // arrangement there (PARCEL-OPTIONAL.md phase 3).
        const atomicCorridorAuthoring = !!proposal.roadProposal?.definition;
        let proposalId = null;
        let deriveFailure = null;
        if (atomicCorridorAuthoring) {
            // Finish owns the complete road mutation. The manager first plans every junction edit,
            // then commits the new record, touched existing records, parcel fabric, and persistence
            // under one rollback boundary. A failed derivation leaves no parked half-road behind.
            profile.mark('build');
            let created = null;
            try {
                created = await global.ProposalManager?.createCorridorProposalAtomically?.(proposal);
            } catch (error) {
                return keepAsDraft(String(error && error.message || error || 'Could not finish the corridor.'));
            }
            if (!created?.ok || !created.proposalId) {
                return keepAsDraft(created?.reason || 'Could not finish the corridor transaction.');
            }
            proposalId = String(created.proposalId);
            // Topology, records and local fabric committed inside one manager transaction; marking
            // them as separate zero-length phases here falsely suggested a second derivation.
            profile.mark('transaction');
            store.consumeAfterPublish(draftId, proposalId);
            clearProposalDraftComparison();
            try { global.ProposalManager?._refreshUIAfterProposalChange?.(global.proposalStorage?.getProposal?.(proposalId)); } catch (_) { }
            profile.mark('ui');
        } else if (inPlaceSource) {
            // One's own local record is edited in place (proposals/lineage.js editsInPlace): same
            // id, no new record. What stands on ground the edit changes comes off the map, but only
            // once the user has seen it named and agreed.
            const sourceId = String(inPlaceSource.proposalId);
            const dependents = global.ProposalManager?.findEditDependents?.(sourceId, proposal) || [];
            if (dependents.length && !(await confirmEditDependents(dependents))) {
                return keepEditing(tDraft('proposalDrafts.dependents.notSaved', 'The edit was not saved. The design has been reopened.'));
            }
            profile.mark('record');
            let updated = null;
            try {
                updated = await global.ProposalManager?.updateProposalInPlace?.(sourceId, proposal, {
                    unapplyIds: dependents.map(record => String(record.proposalId))
                });
            } catch (error) {
                deriveFailure = error;
                console.warn('[ProposalEditor] In-place save failed; the record is unchanged', error);
            }
            profile.mark('derive');
            if (!updated) {
                let failureInfo = null;
                try { failureInfo = global.ProposalManager?.getLastApplyFailureInfo?.(sourceId) || null; } catch (_) { }
                return keepAsDraft(failureInfo?.message || deriveFailure?.message || '');
            }
            proposalId = sourceId;
            store.consumeAfterPublish(draftId, proposalId);
            clearProposalDraftComparison();
            try { global.ProposalManager?._refreshUIAfterProposalChange?.(global.proposalStorage?.getProposal?.(proposalId)); } catch (_) { }
            dependents.forEach(record => {
                try { global.ProposalManager?._refreshUIAfterProposalChange?.(global.proposalStorage?.getProposal?.(record.proposalId)); } catch (_) { }
            });
            profile.mark('ui');
        } else {
            proposalId = global.proposalStorage?.addProposal?.(proposal);
            if (!proposalId) {
                if (typeof global.showStyledAlert === 'function') {
                    global.showStyledAlert(tDraft('proposalDrafts.errors.instantCreateFailed', 'Could not save the new object.'));
                }
                return keepAsDraft();
            }
            profile.mark('build');
            store.consumeAfterPublish(draftId, proposalId);
            // Drop any comparison overlay the drawing/sync path may have painted for this draft.
            clearProposalDraftComparison();
            // Non-corridor objects keep the ordinary create/apply lifecycle. Corridors take the
            // atomic path above because their junction can also mutate existing authored records.
            try {
                // A new record, or a counterproposal of a published source: the source stays
                // standing, and only the new proposal's own ground is materialised.
                const stored = global.proposalStorage?.getProposal?.(proposalId) || proposal;
                profile.mark('record');

                // NOTHING re-applies the whole plan. Only the ground whose take set actually changed is
                // re-derived — the parcels under a corridor, the parcels a parcel layout takes. Anything
                // that merely stands on the fabric changes no parcel at all, so only it is applied.
                // It is applied by the one apply every proposal gets (ProposalManager.applyProposal):
                // the applied records on its ground come off the map, as for an explicit Apply. A
                // design session's new object, a conversion's or a counterproposal, takes no
                // shortcut around that (it used to derive directly and stood on top of them).
                const derived = await global.ProposalManager?.applyProposal?.(proposalId);
                profile.mark('derive');
                if (!derived) {
                    // The derivation refused. The record stays unapplied rather than being forced onto
                    // the map; the caller sees a parked object and the reason on _lastApplyFailure.
                    console.warn('[ProposalEditor] the new object could not be derived; it stays parked', proposalId);
                }
                try { global.ProposalManager?._refreshUIAfterProposalChange?.(global.proposalStorage?.getProposal?.(proposalId)); } catch (_) { }
                profile.mark('ui');
            } catch (error) {
                deriveFailure = error;
                console.warn('[ProposalEditor] Replay after instant create failed; object stays parked', error);
            }
        }

        // A parked object renders nothing — without a word it just looks like the road vanished.
        //
        // And "a conflict blocked it" is not a word: the apply that refused recorded exactly WHY,
        // and this used to throw that away, leaving the one person who could act on it guessing.
        // Say the reason when there is one.
        let landed = false;
        try {
            const persisted = global.proposalStorage?.getProposal?.(proposalId);
            landed = !!(persisted && typeof global.isProposalApplied === 'function' && global.isProposalApplied(persisted));
            if (!landed && proposalId && typeof global.showStyledAlert === 'function') {
                let failureInfo = null;
                try { failureInfo = global.ProposalManager?.getLastApplyFailureInfo?.(proposalId) || null; } catch (_) { }
                let lastFailure = '';
                try { lastFailure = global.ProposalManager?.getLastApplyFailure?.(proposalId) || ''; } catch (_) { }
                const reason = failureInfo?.message || lastFailure || deriveFailure?.message || '';
                global.showStyledAlert(reason
                    ? tDraft('proposalDrafts.builtButParkedBecause',
                        'The design was created but could not be placed on the map: {{reason}} It is in your designs list — select it there to see and apply it.',
                        { reason })
                    : tDraft('proposalDrafts.builtButParked', 'The design was created but could not be placed on the map (a conflict blocked it). It is in your designs list — select it there to see and apply it.'));
            }
        } catch (_) { }
        if (landed && (inPlaceSource || proposal.proposalOrigin)
            && typeof global.showEphemeralMessage === 'function') {
            global.showEphemeralMessage(tDraft('proposalDrafts.geometryUpdated', 'Geometry updated.'), 4000, 'success');
        }
        try { if (typeof global.updateShowProposalsButton === 'function') global.updateShowProposalsButton(); } catch (_) { }
        // The drawing seeded the multi-parcel selection, which pops the parcel info panel — hide
        // it; the click stack opens on the placed object instead.
        try { global.document?.getElementById('parcel-info-panel')?.classList.remove('visible'); } catch (_) { }
        // A refused object is parked in the list, but it is not the thing the user selected on the
        // map. Focusing it collapses a carefully built multi-parcel/block selection to its first
        // declared parent; pressing Park again then takes only that fragment. Preserve the source
        // selection on refusal so retrying is genuinely the same operation. A landed object keeps
        // the normal focus/details behaviour.
        if (landed) {
            // One-click structures (park/square/lake) seed multi-select without a design session,
            // so finishProposalDraftDesignSession never disarms it; the selection is consumed
            // now, like a confirmed design tool's. Without this the selection tray stayed on
            // ("Click parcels to select them") and the next parcel click joined a selection.
            try { global.releaseEditorSeededMultiSelection?.(); } catch (_) { }
            // The placed object opens in the click stack, its Design section expanded (click-stack.md).
            try { global.ClickStack.showDesign(proposalId); } catch (error) {
                console.error(`[${new Date().toISOString()}] [proposalEditorShell] the placed proposal ${proposalId} could not open in the click stack`, error);
            }
        }
        return proposalId;
    }

    function payloadTypology(draft) {
        const typology = draft.editorPayload?.typology || draft.editorPayload?.context?.parameters?.typology;
        return ['block', 'row', 'parcelBased'].includes(typology) ? typology : null;
    }

    function syncActiveProposalDraftFromEditor(kind, payload, options = {}) {
        const store = global.proposalDraftStore;
        const draft = getActiveProposalDesignDraft();
        if (!draft || !payload) return null;
        let patch = null;
        const fields = {};
        if (kind === 'corridor') {
            if (draft.goal !== 'road-track') return null;
            const adapter = global.proposalEditorAdapterRegistry?.get('road-track');
            const converted = adapter?.payloadFromDrawingSeed
                ? adapter.payloadFromDrawingSeed(payload, draft.editorPayload?.definition)
                : { kind: payload.kind || draft.editorPayload?.kind, definition: payload.definition || payload };
            patch = { editorPayload: converted, previewGeometry: converted.definition?.polygon || null };
            if (converted.definition?.polygon) {
                fields.site = global.__siteDraft.toMultiPolygon(converted.definition.polygon);
                fields.binding = null;
            }
            if (Array.isArray(options.parcelIds)) fields.selectedParcelIds = options.parcelIds.map(String);
        } else if (kind === 'building') {
            if (!['buildings', 'row', 'parcelBased', 'single'].includes(draft.adapterKey || draft.goal)) return null;
            const rawTypology = payload.parameters?.typology || draft.editorPayload?.typology || draft.adapterKey;
            // `buildings` is the editor adapter key; its persisted design typology is `block`.
            // Keeping the domain value here prevents a save/reload from reopening as a generic
            // building payload without the block-specific massing context.
            const typology = rawTypology === 'buildings' ? 'block' : rawTypology;
            const buildingContext = JSON.parse(JSON.stringify(payload));
            patch = {
                editorPayload: { typology, context: buildingContext },
                previewGeometry: JSON.parse(JSON.stringify(payload.buildings?.length ? payload.buildings : [payload.buildingFeature].filter(Boolean)))
            };
            const savedBuildingGeometryEdit = Boolean(draft.sourceLocalProposalId);
            if (!savedBuildingGeometryEdit && Array.isArray(payload.parcelIds)) fields.selectedParcelIds = payload.parcelIds.map(String);
        } else if (kind === 'parcel-layout') {
            if (draft.goal !== 'parcel-layout') return null;
            // The editor's result (window.pendingParcelLayout) is the layout record whole.
            const plan = JSON.parse(JSON.stringify(payload));
            patch = { editorPayload: { plan }, previewGeometry: JSON.parse(JSON.stringify(plan.plots || [])) };
            if (Array.isArray(plan.parcelIds)) fields.selectedParcelIds = plan.parcelIds.map(String);
        } else if (kind === 'structure') {
            if (!['park', 'square', 'lake'].includes(draft.adapterKey || draft.goal)) return null;
            const structureProposal = JSON.parse(JSON.stringify(payload.structureProposal || payload));
            const geometry = structureProposal.geometry || draft.editorPayload?.geometry || null;
            patch = {
                editorPayload: { ...draft.editorPayload, geometry, structureProposal },
                previewGeometry: JSON.parse(JSON.stringify(geometry))
            };
        } else if (kind === 'station') {
            if ((draft.adapterKey || draft.goal) !== 'station') return null;
            const structureProposal = JSON.parse(JSON.stringify(payload.structureProposal || payload));
            const geometry = structureProposal.geometry || draft.editorPayload?.geometry || null;
            patch = {
                editorPayload: { ...draft.editorPayload, geometry, structureProposal },
                previewGeometry: JSON.parse(JSON.stringify(geometry))
            };
            if (Array.isArray(structureProposal.selectedParcelIds)) {
                fields.selectedParcelIds = structureProposal.selectedParcelIds.map(String);
            }
        } else {
            return null;
        }
        const placementInput = options.placement || payload.placement || null;
        if (placementInput?.free === true) {
            try {
                const nextDraft = { ...draft, editorPayload: { ...(draft.editorPayload || {}), ...(patch.editorPayload || {}) } };
                const placement = global.proposalDraftPlacement?.freePlacementPatch?.(nextDraft, placementInput);
                if (!placement) return null;
                patch.editorPayload = { ...(patch.editorPayload || {}), placement: placement.placement };
                fields.site = placement.fields.site;
                fields.selectedParcelIds = placement.fields.selectedParcelIds;
                fields.cadastreParcelIds = placement.fields.cadastreParcelIds;
                fields.binding = null;
            } catch (error) {
                console.warn('[ProposalEditor] Refused unsafe free placement', error);
                if (typeof global.showStyledAlert === 'function') global.showStyledAlert(error?.message || String(error));
                return null;
            }
        }
        if (kind === 'building' && placementInput?.free === false) {
            patch.editorPayload.placement = null;
            if (draft.editorPayload?.placement?.free === true) {
                // Existing-building mode returns to the source-aware site. A preceding generated
                // preview must not leave its moved footprint or pending binding on this snapshot.
                fields.site = global.__siteDraft.toMultiPolygon(placementInput.site);
                fields.cadastreParcelIds = [];
                fields.binding = null;
            }
        }
        if (Object.keys(fields).length) patch.fields = fields;
        const updateOptions = { coalesceKey: options.coalesceKey || `editor:${kind}` };
        const updated = kind === 'building'
            // Editor payloads are complete snapshots. Replacing their context atomically prevents
            // recursive draft merging from retaining removed feature flags (for example a stale
            // `manual: true` on a block footprint after the user returns to parametric mode).
            ? store.updateDraft(draft.id, current => ({
                ...current,
                ...patch,
                fields: patch.fields ? { ...(current.fields || {}), ...patch.fields } : current.fields,
                editorPayload: { ...(current.editorPayload || {}), ...(patch.editorPayload || {}) }
            }), updateOptions)
            : store.updateDraft(draft.id, patch, updateOptions);
        store.validateDraft(draft.id);
        // The source/draft comparison overlay belongs to the (retired) editor dialog. Rendering
        // it without the dialog open left ghost outlines on the map with nothing to clear them.
        if (ensureShell()?.classList.contains('is-open')) {
            renderProposalDraftComparison(draft.id, editorState.comparison);
        }
        return updated;
    }

    // Center the map on a draft's geometry; the dashed draft overlay is its map presence.
    function centerOnDraft(draft) {
        if (!draft) return false;
        const raw = draft.previewGeometry
            || draft.editorPayload?.definition?.polygon
            || draft.editorPayload?.plan?.plots
            || draft.editorPayload?.geometry
            || null;
        if (!raw || !global.map || !global.L) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tDraft('proposalDrafts.noGeometryYet', 'This draft has no geometry yet — start drawing to give it one.'));
            }
            return false;
        }
        try {
            const features = (Array.isArray(raw) ? raw : [raw]).map(entry => {
                const geometry = entry?.type === 'Feature' ? entry.geometry : (entry?.geometry || entry);
                return { type: 'Feature', properties: {}, geometry };
            });
            const layer = global.L.geoJSON({ type: 'FeatureCollection', features });
            const bounds = layer.getBounds();
            if (bounds?.isValid?.()) {
                global.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 18 });
                return true;
            }
        } catch (_) { }
        return false;
    }

    function handleEditorKeyboard(event) {
        const shell = ensureShell();
        if (!shell?.classList.contains('is-open')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeProposalEditorShell();
            return;
        }
        const editableTarget = event.target?.matches?.('input, textarea, select, [contenteditable="true"]');
        if (editableTarget) return;
        const modifier = event.ctrlKey || event.metaKey;
        if (!modifier) return;
        if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
            event.preventDefault();
            global.proposalDraftStore?.undoDraft(editorState.draftId);
            renderShell();
        } else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
            event.preventDefault();
            global.proposalDraftStore?.redoDraft(editorState.draftId);
            renderShell();
        }
    }

    function initializeProposalDraftUI() {
        ensureShell();
        if (!editorState.unsubscribe && global.proposalDraftStore?.subscribe) {
            editorState.unsubscribe = global.proposalDraftStore.subscribe(event => {
                if (editorState.localMutation) return;
                if (editorState.draftId && (!event.draftId || event.draftId === editorState.draftId)) {
                    if (event.type === 'delete' || event.type === 'consume') closeProposalEditorShell();
                    else renderShell();
                }
            });
        }
    }

    global.openProposalEditorShell = openProposalEditorShell;
    global.closeProposalEditorShell = closeProposalEditorShell;
    global.editProposal = editProposal;
    global.editProposalAsReplacement = editProposal;
    global.confirmProposalEditDependents = confirmEditDependents;
    global.editProposalGeometry = editProposalGeometry;
    global.convertProposalToFreeform = convertProposalToFreeform;
    global.convertActiveDesignToFreeform = convertActiveDesignToFreeform;
    global.convertActiveDesignToFreeformBuildings = convertActiveDesignToFreeformBuildings;
    global.stageActiveFreeformBuildings = stageActiveFreeformBuildings;
    global.chooseRuleDrop = chooseRuleDrop;
    global.moveActiveDesignToParcels = moveActiveDesignToParcels;
    global.ruleDropLabel = ruleLabel;
    global.canEditProposalGeometry = canEditProposalGeometry;
    global.startInstantProposalDesign = startInstantProposalDesign;
    global.instantCreateStructureFromSelection = instantCreateStructureFromSelection;
    global.getProposalEditCapability = getProposalEditCapability;
    global.createNewProposalDraft = createNewProposalDraft;
    global.beginProposalDraftDesignSession = beginProposalDraftDesignSession;
    global.getActiveProposalDesignDraft = getActiveProposalDesignDraft;
    global.finishProposalDraftDesignSession = finishProposalDraftDesignSession;
    global.reportProposalDesignSaveFailure = reportProposalDesignSaveFailure;
    global.isProposalDesignCommitSession = isProposalDesignCommitSession;
    global.discardProposalDraftDesignSession = discardProposalDraftDesignSession;
    global.confirmDiscardProposalDesignSession = confirmDiscardProposalDesignSession;
    global.stageProposalDraftForPublishing = stageProposalDraftForPublishing;
    global.instantCreateProposalFromDraft = instantCreateProposalFromDraft;
    global.instantCreateStructureFromSite = instantCreateStructureFromSite;
    global.instantCreateStructureFromModel = instantCreateStructureFromModel;
    global.startInstantSiteDesign = startInstantSiteDesign;
    global.startSiteSubdivision = startSiteSubdivision;
    global.syncActiveProposalDraftFromEditor = syncActiveProposalDraftFromEditor;
    global.rebindFreePlacementDraft = rebindFreePlacementDraft;
    global.renderProposalDraftComparison = renderProposalDraftComparison;
    global.clearProposalDraftComparison = clearProposalDraftComparison;
    global.focusDraftValidationIssue = focusDraftValidationIssue;
    global.initializeProposalDraftUI = initializeProposalDraftUI;

    if (global.document) {
        global.document.addEventListener('keydown', handleEditorKeyboard);
        if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', initializeProposalDraftUI);
        else initializeProposalDraftUI();
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            patchForPath,
            displayValue
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
