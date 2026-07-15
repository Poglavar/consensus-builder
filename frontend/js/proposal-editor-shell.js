// Purpose: render the shared proposal editor (the "Create proposal" terms flow) and the
// design-session plumbing behind instant creation and geometry editing. There is no user-facing
// drafts list: what is on the map IS the draft, editable until proposed.
(function attachProposalEditorShell(global) {
    'use strict';

    const TAB_LABELS = {
        design: ['proposalDrafts.tabs.design', 'Design'],
        parcels: ['proposalDrafts.tabs.parcels', 'Parcels'],
        ownership: ['proposalDrafts.tabs.ownership', 'Ownership'],
        terms: ['proposalDrafts.tabs.terms', 'Terms'],
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
        return adapter?.label || String(goal || tDraft('proposalDrafts.proposal', 'Proposal')).replace(/-/g, ' ');
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
        shell.className = 'proposal-editor-shell';
        shell.setAttribute('aria-label', tDraft('proposalDrafts.editorAria', 'Proposal draft editor'));
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

    function formatInputDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        const pad = number => String(number).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function renderDetails(draft) {
        const typeSelector = !draft.sourceProposalId
            ? `<label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.type', 'Proposal type'))}</span>
                    <select data-draft-goal>${(global.proposalEditorAdapterRegistry?.list?.() || [])
                        .filter(entry => !entry.readOnly)
                        .map(entry => option(entry.key, entry.label, draft.adapterKey || draft.goal))
                        .join('')}</select>
                </label>`
            : '';
        return `
            <section class="proposal-editor-section" data-editor-section="details">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.detailsTitle', 'Proposal details'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft('proposalDrafts.sections.detailsCopy', 'Describe the replacement clearly. The source proposal stays immutable.'))}</p>
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
        const ids = Array.isArray(draft.fields?.parentParcelIds) ? draft.fields.parentParcelIds : [];
        const chips = ids.map(id => `<span class="proposal-editor-parcel-chip" title="${escapeHtml(id)}">${escapeHtml(id)}</span>`).join('');
        return `
            <section class="proposal-editor-section" data-editor-section="parcels">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.parcelsTitle', 'Affected parcels'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft('proposalDrafts.sections.parcelsCopy', 'Use the current map selection, or edit the parcel IDs directly.'))}</p>
                <div class="proposal-editor-parcels">${chips || escapeHtml(tDraft('proposalDrafts.noParcels', 'No parcels selected'))}</div>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.parcelIds', 'Parcel IDs'))}</span>
                    <textarea data-draft-path="fields.parentParcelIds" data-draft-array="true">${escapeHtml(ids.join('\n'))}</textarea>
                </label>
                <button type="button" class="proposal-editor-secondary" data-editor-action="use-map-selection">${escapeHtml(tDraft('proposalDrafts.actions.useMapSelection', 'Use map selection'))}</button>
            </section>`;
    }

    function option(value, label, selected) {
        return `<option value="${escapeHtml(value)}"${String(selected || '') === String(value) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }

    function renderOwnership(draft) {
        const fields = draft.fields || {};
        return `
            <section class="proposal-editor-section" data-editor-section="ownership">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.ownershipTitle', 'Ownership'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft('proposalDrafts.sections.ownershipCopy', 'Set who receives the land and any recipient constraint.'))}</p>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.ownership', 'Ownership change'))}</span>
                    <select data-draft-path="fields.ownership">
                        ${option('', tDraft('proposalDrafts.ownership.inherit', 'Keep source setting'), fields.ownership)}
                        ${option('no-change', tDraft('proposalDrafts.ownership.noChange', 'No change'), fields.ownership)}
                        ${option('to-me', tDraft('proposalDrafts.ownership.toMe', 'To me'), fields.ownership)}
                        ${option('to-city', tDraft('proposalDrafts.ownership.toCity', 'To city'), fields.ownership)}
                        ${option('third-party', tDraft('proposalDrafts.ownership.thirdParty', 'Third party'), fields.ownership)}
                        ${option('per-slice', tDraft('proposalDrafts.ownership.perSlice', 'Per replacement parcel'), fields.ownership)}
                    </select>
                </label>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.recipientScope', 'Recipient scope'))}</span>
                    <select data-draft-path="fields.recipientScope">
                        ${option('', tDraft('proposalDrafts.ownership.notApplicable', 'Not applicable'), fields.recipientScope)}
                        ${option('any', tDraft('proposalDrafts.ownership.anyone', 'Anyone'), fields.recipientScope)}
                        ${option('specific', tDraft('proposalDrafts.ownership.specific', 'Specific recipient'), fields.recipientScope)}
                    </select>
                </label>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.recipientAddress', 'Recipient address or name'))}</span>
                    <input type="text" data-draft-path="fields.recipientAddress" value="${escapeHtml(fields.recipientAddress || '')}" autocomplete="off">
                </label>
            </section>`;
    }

    function renderTerms(draft) {
        const fields = draft.fields || {};
        return `
            <section class="proposal-editor-section" data-editor-section="terms">
                <h3>${escapeHtml(tDraft('proposalDrafts.sections.termsTitle', 'Terms'))}</h3>
                <p class="proposal-editor-section-copy">${escapeHtml(tDraft('proposalDrafts.sections.termsCopy', 'Adjust financing, expiry, decay, and deposit terms.'))}</p>
                <div class="proposal-editor-grid">
                    <label class="proposal-editor-field">
                        <span>${escapeHtml(tDraft('proposalDrafts.fields.offer', 'Offer'))}</span>
                        <input type="number" min="0" step="any" data-draft-path="fields.offer" data-draft-number="true" value="${escapeHtml(fields.offer ?? 0)}">
                    </label>
                    <label class="proposal-editor-field">
                        <span>${escapeHtml(tDraft('proposalDrafts.fields.currency', 'Currency'))}</span>
                        <select data-draft-path="fields.offerCurrency">
                            ${['EUR', 'USD', 'ETH', 'ARS', 'USDC', 'USDT'].map(currency => option(currency, currency, fields.offerCurrency || 'USDT')).join('')}
                        </select>
                    </label>
                </div>
                <label class="proposal-editor-check"><input type="checkbox" data-draft-path="fields.isConditional"${fields.isConditional ? ' checked' : ''}>${escapeHtml(tDraft('proposalDrafts.fields.conditional', 'Conditional payout'))}</label>
                <label class="proposal-editor-field">
                    <span>${escapeHtml(tDraft('proposalDrafts.fields.expiry', 'Expires at'))}</span>
                    <input type="datetime-local" data-draft-path="fields.expiresAt" data-draft-date="true" value="${escapeHtml(formatInputDate(fields.expiresAt))}">
                </label>
                <div class="proposal-editor-card">
                    <label class="proposal-editor-check"><input type="checkbox" data-draft-path="fields.decayEnabled"${fields.decayEnabled ? ' checked' : ''}>${escapeHtml(tDraft('proposalDrafts.fields.decay', 'Offer decay'))}</label>
                    <div class="proposal-editor-grid">
                        <label class="proposal-editor-field"><span>${escapeHtml(tDraft('proposalDrafts.fields.percent', 'Percent'))}</span><input type="number" min="0" max="100" data-draft-path="fields.decayPercent" data-draft-number="true" value="${escapeHtml(fields.decayPercent ?? 0)}"></label>
                        <label class="proposal-editor-field"><span>${escapeHtml(tDraft('proposalDrafts.fields.durationMs', 'Duration (ms)'))}</span><input type="number" min="0" data-draft-path="fields.decayDurationMs" data-draft-number="true" value="${escapeHtml(fields.decayDurationMs ?? 0)}"></label>
                    </div>
                </div>
                <div class="proposal-editor-card">
                    <label class="proposal-editor-check"><input type="checkbox" data-draft-path="fields.depositEnabled"${fields.depositEnabled ? ' checked' : ''}>${escapeHtml(tDraft('proposalDrafts.fields.deposit', 'Deposit'))}</label>
                    <label class="proposal-editor-field"><span>${escapeHtml(tDraft('proposalDrafts.fields.percent', 'Percent'))}</span><input type="number" min="0" max="200" data-draft-path="fields.depositPercent" data-draft-number="true" value="${escapeHtml(fields.depositPercent ?? 0)}"></label>
                </div>
            </section>`;
    }

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
            return tDraft('proposalDrafts.design.buildingSummary', '{{count}} building(s) · {{typology}}', { count, typology: payload.typology || draft.goal });
        }
        if (draft.goal === 'reparcellization') {
            return tDraft('proposalDrafts.design.reparcelSummary', '{{count}} replacement parcel(s) · {{algorithm}}', {
                count: payload.plan?.polygons?.length || 0,
                algorithm: payload.plan?.algorithm || tDraft('proposalDrafts.design.manual', 'manual')
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
        return tDraft('proposalDrafts.design.parcelSummary', '{{count}} affected parcel(s)', { count: draft.fields?.parentParcelIds?.length || 0 });
    }

    function renderDesign(draft, adapter) {
        const canOpen = adapter && typeof adapter.openDesignEditor === 'function' && adapter.hasDesign !== false;
        const corridorKind = !draft.sourceProposalId && draft.goal === 'road-track'
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
                    ? `<button type="button" class="proposal-editor-primary" data-editor-action="open-design">${escapeHtml(tDraft('proposalDrafts.actions.openDesign', 'Edit design on map'))}</button>`
                    : `<div class="proposal-editor-card"><p>${escapeHtml(tDraft('proposalDrafts.design.parcelOnly', 'This proposal has no separate design geometry. Parcel highlighting remains live while you edit its other facets.'))}</p></div>`}
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
                <div class="proposal-editor-review-notice">${escapeHtml(tDraft('proposalDrafts.review.immutableNotice', 'Publishing creates a new immutable proposal. The source is not changed or removed.'))}</div>
                <div class="proposal-editor-card">
                    <strong>${escapeHtml(summary?.sourceName || draft.sourceProposalId || tDraft('proposalDrafts.review.newProposal', 'New proposal'))}</strong>
                    <p>${escapeHtml(draft.sourceProposalId || tDraft('proposalDrafts.review.noSource', 'No source proposal'))} → ${escapeHtml(draft.fields?.name || '')}</p>
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
                : tDraft('proposalDrafts.validation.warnings', '{{count}} warning(s)', { count: entries.length }))}</strong><ul>${entries.map((entry, index) => `<li class="is-${severity}"><button type="button" data-editor-action="focus-issue" data-issue-index="${offset + index}">${escapeHtml(issueMessage(entry))}</button></li>`).join('')}</ul>`
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
        const sections = [...new Set(adapter?.sections || ['parcels', 'ownership', 'terms', 'details'])];
        if (!editorState.tab || !sections.includes(editorState.tab)) editorState.tab = sections.includes('design') ? 'design' : sections[0];
        const reviewing = draft.state === 'review';
        let body = '';
        if (reviewing) body = renderReview(draft);
        else if (editorState.tab === 'design') body = renderDesign(draft, adapter);
        else if (editorState.tab === 'parcels') body = renderParcels(draft);
        else if (editorState.tab === 'ownership') body = renderOwnership(draft);
        else if (editorState.tab === 'terms') body = renderTerms(draft);
        else body = renderDetails(draft);

        const sourceText = draft.sourceProposalId
            ? tDraft('proposalDrafts.source', 'Source: {{id}}', { id: draft.sourceProposalId })
            : tDraft('proposalDrafts.newDraft', 'New proposal draft');
        shell.innerHTML = `
            <header class="proposal-editor-header">
                <div>
                    <p class="proposal-editor-eyebrow">${escapeHtml(proposalLabel(draft.adapterKey || draft.goal))}</p>
                    <h2 class="proposal-editor-title">${escapeHtml(draft.fields?.name || tDraft('proposalDrafts.untitled', 'Untitled draft'))}</h2>
                    <p class="proposal-editor-source">${escapeHtml(sourceText)} · ${escapeHtml(cityLabel(draft.cityId))}</p>
                </div>
                <button type="button" class="proposal-editor-close" data-editor-action="close" aria-label="${escapeHtml(tDraft('proposalDrafts.actions.close', 'Close editor'))}">&times;</button>
            </header>
            <div class="proposal-editor-save-row">
                <span class="proposal-editor-autosave">${escapeHtml(draft.state === 'error' ? tDraft('proposalDrafts.autosave.recoverableError', 'Saved · publishing failed') : tDraft('proposalDrafts.autosave.saved', 'Autosaved locally'))}</span>
                <div class="proposal-editor-toolbar">
                    <button type="button" data-editor-action="undo" aria-label="${escapeHtml(tDraft('proposalDrafts.actions.undo', 'Undo'))}"${draft.history?.past?.length ? '' : ' disabled'}>↶</button>
                    <button type="button" data-editor-action="redo" aria-label="${escapeHtml(tDraft('proposalDrafts.actions.redo', 'Redo'))}"${draft.history?.future?.length ? '' : ' disabled'}>↷</button>
                </div>
            </div>
            <div class="proposal-editor-comparison" aria-label="${escapeHtml(tDraft('proposalDrafts.comparison.label', 'Comparison mode'))}">
                ${comparisonButton('source-only', tDraft('proposalDrafts.comparison.source', 'Source only'))}
                ${comparisonButton('draft-only', tDraft('proposalDrafts.comparison.draft', 'Draft only'))}
                ${comparisonButton('overlay', tDraft('proposalDrafts.comparison.overlay', 'Overlay'))}
            </div>
            ${reviewing ? '' : `<nav class="proposal-editor-tabs">${sections.map(section => `<button type="button" data-editor-action="tab" data-editor-tab="${escapeHtml(section)}" class="${editorState.tab === section ? 'is-active' : ''}">${escapeHtml(tDraft(TAB_LABELS[section]?.[0] || '', TAB_LABELS[section]?.[1] || section))}</button>`).join('')}</nav>`}
            <div class="proposal-editor-body">${body}</div>
            ${renderValidation(draft)}
            <footer class="proposal-editor-footer">
                <button type="button" class="proposal-editor-danger" data-editor-action="discard">${escapeHtml(tDraft('proposalDrafts.actions.discard', 'Discard draft'))}</button>
                ${reviewing
                    ? `<div class="proposal-editor-grid"><button type="button" class="proposal-editor-secondary" data-editor-action="back-to-edit">${escapeHtml(tDraft('proposalDrafts.actions.back', 'Back'))}</button><button type="button" class="proposal-editor-primary" data-editor-action="publish"${draft.validation?.valid ? '' : ' disabled'}>${escapeHtml(draft.sourceProposalId ? tDraft('proposalDrafts.actions.createReplacement', 'Create replacement proposal') : tDraft('proposalDrafts.actions.createProposal', 'Create proposal'))}</button></div>`
                    : `<button type="button" class="proposal-editor-primary" data-editor-action="review">${escapeHtml(tDraft('proposalDrafts.actions.review', 'Review changes'))}</button>`}
            </footer>`;
        shell.classList.add('is-open');
        global.document.body.classList.add('proposal-editor-open');
        renderProposalDraftComparison(draft.id, editorState.comparison);
    }

    function comparisonButton(mode, label) {
        return `<button type="button" data-editor-action="comparison" data-comparison-mode="${mode}" class="${editorState.comparison === mode ? 'is-active' : ''}">${escapeHtml(label)}</button>`;
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
        if (input.type === 'checkbox') return input.checked;
        if (input.dataset.draftNumber === 'true') {
            const number = Number(input.value);
            return Number.isFinite(number) ? number : 0;
        }
        if (input.dataset.draftDate === 'true') {
            return input.value ? new Date(input.value).toISOString() : null;
        }
        return input.value;
    }

    function mutateFromInput(input, validate) {
        const path = input?.dataset?.draftPath;
        if (!path || !editorState.draftId || !global.proposalDraftStore) return;
        editorState.localMutation = true;
        const value = valueFromInput(input);
        global.proposalDraftStore.updateDraft(
            editorState.draftId,
            patchForPath(path, value),
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

    async function confirmDestructive(message, options = {}) {
        if (typeof global.showStyledConfirm === 'function') return global.showStyledConfirm(message, options);
        return global.confirm ? global.confirm(message) : false;
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
            const accepted = await confirmDestructive(tDraft('proposalDrafts.confirmDiscard', 'Discard this locally saved draft? This cannot be undone.'));
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
            store.updateDraft(draftId, { fields: { parentParcelIds: (context.ids || []).map(String) } });
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
            if (validationIssue.path === 'fields.parentParcelIds') {
                const draft = global.proposalDraftStore?.getDraft(editorState.draftId);
                const first = draft?.fields?.parentParcelIds?.[0];
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
        else if (path === 'fields.parentParcelIds') section = 'parcels';
        else if (path.startsWith('fields.ownership') || path.startsWith('fields.recipient')) section = 'ownership';
        else if (path.startsWith('fields.')) section = 'terms';
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

    function renderProposalDraftComparison(draftId, mode = 'overlay') {
        const draft = global.proposalDraftStore?.getDraft(draftId);
        if (!draft) return null;
        const adapter = global.proposalEditorAdapterRegistry?.get(draft.adapterKey || draft.goal);
        const descriptor = adapter && typeof adapter.renderPreview === 'function'
            ? adapter.renderPreview(draft, detectViewMode())
            : null;
        const detail = {
            draftId,
            mode,
            viewMode: detectViewMode(),
            sourceProposal: mode === 'draft-only' ? null : draft.sourceSnapshot,
            draftPreview: mode === 'source-only' ? null : descriptor,
            sourceStyle: { opacity: 0.28, color: '#64748b' },
            draftStyle: { opacity: 0.92, color: '#2563eb', dashArray: '7 5' }
        };
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
        global.activeProposalDraftComparison = null;
        try {
            global.document?.dispatchEvent(new global.CustomEvent('proposal-draft-preview-change', { detail: null }));
            if (typeof global.updateProposalDraftMapPreview === 'function') global.updateProposalDraftMapPreview(null);
        } catch (_) { }
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

    async function editProposal(proposalIdOrHash) {
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
        return openProposalEditorShell(draft.id);
    }

    // "Create proposal" on an existing map object: skip the editor entirely and go straight to
    // the create dialog, prefilled from the object. On submit the object is absorbed into the
    // proposal that replaces it (see createProposal), so one thing remains on the map.
    async function proposeExistingProposal(proposalIdOrHash) {
        if (typeof global.requirePersonalizedUser === 'function' && global.requirePersonalizedUser()) return null;
        const proposal = proposalById(proposalIdOrHash);
        if (!proposal) return null;
        const draft = global.proposalDraftStore.createDraftFromProposal(proposal, { activate: true });
        if (!draft) return null;
        try { if (typeof global.hideProposalDetailsPanel === 'function') global.hideProposalDetailsPanel(); } catch (_) { }
        closeProposalEditorShell();
        return stageProposalDraftForPublishing(draft.id);
    }

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
                parentParcelIds: (options.parentParcelIds || context.ids || []).map(String),
                offer: Number(options.offer) || 0,
                offerCurrency: options.offerCurrency || 'USDT'
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

    const GEOMETRY_EDITABLE_ADAPTERS = new Set(['buildings', 'row', 'parcelBased', 'single', 'reparcellization', 'park', 'square']);

    function canEditProposalGeometry(proposalOrId) {
        const proposal = typeof proposalOrId === 'object' ? proposalOrId : proposalById(proposalOrId);
        if (!proposal) return false;
        if (typeof global.isProposalMinted === 'function' && global.isProposalMinted(proposal)) return false;
        const adapter = global.proposalEditorAdapterRegistry?.get(proposal);
        if (!adapter || !GEOMETRY_EDITABLE_ADAPTERS.has(adapter.key)) return false;
        const capability = typeof adapter.canEdit === 'function' ? adapter.canEdit(proposal) : true;
        return capability === true || capability?.editable === true;
    }

    async function editProposalGeometry(proposalIdOrHash) {
        const proposal = proposalById(proposalIdOrHash);
        if (!proposal || !canEditProposalGeometry(proposal)) return null;
        const draft = global.proposalDraftStore.createDraftFromProposal(proposal, { activate: true });
        if (!draft) return null;
        geometryEditCommitDraftId = draft.id;
        try { if (typeof global.hideProposalDetailsPanel === 'function') global.hideProposalDetailsPanel(); } catch (_) { }
        let opened = false;
        try {
            opened = await global.openProposalDraftDesign?.(draft.id);
        } catch (error) {
            opened = false;
            console.warn('[ProposalEditor] Geometry editor failed to open', error);
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

    // Build-first creation from the parcel panel's Build palette: a fresh draft seeded with the
    // selection opens the type's design tool directly (no create dialog); closing the tool with a
    // design commits it as an applied object, exactly like a geometry edit does. Terms and minting
    // come later via "Create proposal" on the object.
    async function startInstantProposalDesign(adapterKey, parcelIds) {
        const ids = (parcelIds || []).map(String).filter(Boolean);
        if (!ids.length) return false;
        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: adapterKey,
            proposalType: proposalLabel(adapterKey),
            adapterKey,
            fields: { name: '', description: '', parentParcelIds: ids, offer: 0, offerCurrency: 'USDT' },
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

    const STRUCTURE_KIND_LABELS = { park: 'Park', square: 'Square', lake: 'Lake' };

    // One-click structures: a park/square/lake IS the selection's union — there is no design
    // tool, the object simply appears applied (auto-named). Terms come later via "Create proposal".
    async function instantCreateStructureFromSelection(kind, parcelIds) {
        if (!STRUCTURE_KIND_LABELS[kind]) return null;
        const ids = (parcelIds || []).map(String).filter(Boolean);
        if (!ids.length) return null;
        const selection = await global.prepareProposalDraftParcelSelection?.(ids);
        if (!selection?.layers?.length) {
            const message = tDraft('proposalDrafts.errors.parcelsUnavailable', 'The selected parcels are not available in this city view.');
            if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
            return null;
        }
        const geometry = typeof global.buildGeometryFromParcels === 'function'
            ? global.buildGeometryFromParcels(selection.layers)
            : null;
        if (!geometry || !geometry.type) {
            console.warn('[ProposalEditor] Could not build structure geometry from the selection', ids);
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
        // A park/square/lake clears its ground by DEFAULT, without prompting: buildings under
        // the footprint are demolished (rendered as condemned red ghosts in 3D, hidden in 2D,
        // restored on unapply); building PROPOSALS in the way are unapplied but kept in the list.
        let demolishedBuildings = [];
        try {
            // Building footprints load lazily (the road tool preloads them; one-click
            // structures must too, or the scan sees an empty city and demolishes nothing).
            if (typeof global.ensureCorridorBuildingFootprintsLoaded === 'function') {
                await global.ensureCorridorBuildingFootprintsLoaded();
            }
            if (typeof global.demolishBuildingsUnderFootprint === 'function') {
                demolishedBuildings = await global.demolishBuildingsUnderFootprint(structureGeometry);
            }
        } catch (error) {
            console.error('[ProposalEditor] structure demolition scan failed', error);
        }

        const draft = global.proposalDraftStore.createDraft({
            cityId: currentCityId(),
            goal: kind,
            proposalType: STRUCTURE_KIND_LABELS[kind],
            adapterKey: kind,
            fields: { name: '', description: '', parentParcelIds: ids, offer: 0, offerCurrency: 'USDT' },
            editorPayload: {
                structureProposal: {
                    kind,
                    status: 'unapplied',
                    geometry: structureGeometry,
                    parentParcelIds: ids.slice(),
                    blockName: null,
                    lakeGraphics: lakeGraphics || null,
                    demolishedBuildings
                }
            },
            previewGeometry: structureGeometry
        });
        if (!draft) return null;
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
        const draft = global.proposalDraftStore?.getDraft?.(activeId) || null;
        if (draft) {
            global.proposalDraftStore.validateDraft(activeId);
            global.proposalDraftStore.flush();
        }
        editorState.designDraftId = null;
        global.activeProposalDesignDraftId = null;
        // The design tool seeded multi-select for its parcel context; closing the tool must
        // disarm it, or the "Multiparcel selection" panel resurfaces on later clicks.
        try { global.releaseEditorSeededMultiSelection?.(); } catch (_) { }
        // A CONFIRMED design tool commits its session here: a changed draft becomes the object
        // (absorbing the source in instantCreate); an untouched one dissolves without residue.
        // An abandoned session (X/Esc) never reaches this point — discardProposalDraftDesignSession
        // clears the commit id first, so tearing the tool down publishes nothing.
        if (geometryEditCommitDraftId && String(geometryEditCommitDraftId) === String(activeId)) {
            const commitId = geometryEditCommitDraftId;
            geometryEditCommitDraftId = null;
            const current = global.proposalDraftStore.getDraft(commitId);
            if (current && current.dirty) {
                Promise.resolve(instantCreateProposalFromDraft(commitId)).catch(error => {
                    console.warn('[ProposalEditor] Geometry edit commit failed; draft kept', error);
                });
            } else if (current) {
                global.proposalDraftStore.deleteDraft(commitId);
            }
        }
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
                cancelText: tDraft('proposalDrafts.discardDesign.cancel', 'Keep editing')
            }
        );
    }

    function formatDuration(ms) {
        const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
        if (!seconds) return null;
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainder = seconds % 60;
        const pad = number => String(number).padStart(2, '0');
        return `${pad(hours)}h:${pad(minutes)}m:${pad(remainder)}s`;
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
                parentParcelIds: (draft.fields?.parentParcelIds || []).slice()
            };
            return true;
        }
        if (['buildings', 'row', 'parcelBased', 'single'].includes(draft.adapterKey || draft.goal)) {
            global.pendingBuildingProposalContext = JSON.parse(JSON.stringify(payload.context || {}));
            if (typeof global.setPendingBuildingProposalContext === 'function') global.setPendingBuildingProposalContext(global.pendingBuildingProposalContext, { fromDraft: true });
            return true;
        }
        if (draft.goal === 'reparcellization') {
            global.pendingReparcellizationPlan = JSON.parse(JSON.stringify(payload.plan || {}));
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
        if (name) name.value = fields.name || '';
        if (description) description.value = fields.description || '';
    }

    async function stageProposalDraftForPublishing(draftId) {
        const store = global.proposalDraftStore;
        let draft = store?.validateDraft(draftId);
        if (!draft?.validation?.valid) {
            if (draft) renderShell();
            return false;
        }
        const receipt = store.getPublishReceipt(draftId);
        if (receipt) {
            if (typeof global.showStyledAlert === 'function') {
                global.showStyledAlert(tDraft('proposalDrafts.publish.alreadyCreated', 'This draft already created proposal {{id}}.', { id: receipt.persistedProposalId || '' }));
            }
            return false;
        }
        const selection = await global.prepareProposalDraftParcelSelection?.(draft);
        if (!selection?.layers?.length) {
            const message = tDraft('proposalDrafts.errors.parcelsUnavailable', 'The draft parcels are not available in the current city.');
            store.markPublishFailed(draftId, new Error(message));
            // The editor shell is dormant UI — say it out loud instead of rendering into the void.
            if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
            else if (typeof global.updateStatus === 'function') global.updateStatus(message);
            return false;
        }
        if ((selection.usesSourceChildren || selection.substituted) && selection.ids?.length) {
            store.updateDraft(draftId, { fields: { parentParcelIds: selection.ids.map(String) } }, {
                coalesceKey: 'applied-source-descendants'
            });
            draft = store.validateDraft(draftId);
        }
        const seeded = seedDraftPendingState(draft);
        const fields = draft.fields || {};
        const expiryMs = fields.expiresAt ? new Date(fields.expiresAt).getTime() - Date.now() : 0;
        const prefill = {
            name: fields.name || '',
            description: fields.description || '',
            offer: Number(fields.offer) || 0,
            offerCurrency: fields.offerCurrency || 'USDT',
            isConditional: fields.isConditional === true,
            expiryTime: formatDuration(expiryMs),
            decayEnabled: fields.decayEnabled === true,
            decayPercent: Number(fields.decayPercent) || 0,
            decayTime: formatDuration(fields.decayDurationMs),
            depositEnabled: fields.depositEnabled === true,
            depositPercent: Number(fields.depositPercent) || 0
        };
        global.pendingProposalDraftId = draft.id;
        global.pendingProposalReplacementSource = {
            proposalId: draft.sourceProposalId || null,
            name: draft.sourceSnapshot?.title || draft.sourceSnapshot?.name || null,
            draftId: draft.id,
            revision: draft.revision
        };
        const overrides = {
            goal: dialogGoal(draft),
            acquisitionMode: fields.acquisitionMode || null,
            prefill,
            copySource: draft.sourceProposalId ? { proposalId: draft.sourceProposalId, name: global.pendingProposalReplacementSource.name } : null,
            geometryPreset: seeded ? {
                statusText: tDraft('proposalDrafts.publish.geometryReady', 'Geometry attached from the draft'),
                submitted: true,
                selectedAction: 'edit',
                disableButtons: false
            } : null
        };
        if (typeof global.showProposalDialog !== 'function') {
            store.markPublishFailed(draft.id, new Error('Proposal creation is unavailable.'));
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
            // Only a minted source truly gets a *replacement* (it is immutable and stays behind);
            // an unminted local object is absorbed, so the action is simply "Create proposal".
            const source = draft.sourceProposalId ? proposalById(draft.sourceProposalId) : null;
            const sourceIsMinted = !!(source && typeof global.isProposalMinted === 'function' && global.isProposalMinted(source));
            // A no-property-change proposal (ownership no-change + parcels as-is) is a non-binding
            // vote — that outcome wins over the create/replacement label, matching
            // updateCreateProposalSubmitState() so applying the facets doesn't clobber it.
            const facets = (typeof global !== 'undefined' && global.proposalFacets) || {};
            const isVote = facets.ownership === 'no-change' && facets.parcels === 'as-is';
            submit.textContent = isVote
                ? tDraft('panel.proposal.voting.submit', 'Submit for voting')
                : (sourceIsMinted
                    ? tDraft('proposalDrafts.actions.createReplacement', 'Create replacement proposal')
                    : tDraft('proposalDrafts.actions.createProposal', 'Create proposal'));
            submit.dataset.proposalDraftId = draft.id;
        }
        closeProposalEditorShell();
        return true;
    }

    // SimCity-style creation: turn a finished draft directly into an applied object on the map —
    // no dialog, no review step. Overlapping applied proposals are auto-parked by the apply gate.
    // Falls back to opening the editor when the draft cannot validate or persist.
    async function instantCreateProposalFromDraft(draftId) {
        const store = global.proposalDraftStore;
        let draft = store?.getDraft(draftId);
        if (!draft) return null;

        const currentName = String(draft.fields?.name || '').trim();
        const typeLabel = draft.proposalType || proposalLabel(draft.adapterKey || draft.goal);
        const autoFields = {};
        if (!currentName || /^New (road|track)$/i.test(currentName)) {
            autoFields.name = typeof global.generateDefaultProposalName === 'function'
                ? global.generateDefaultProposalName(typeLabel)
                : `${typeLabel} ${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`;
        }
        // Every object carries usable terms from birth: the standard description pattern and a
        // random placeholder offer — refined later in the Create proposal dialog if the user cares.
        const resolvedName = autoFields.name || currentName;
        if (!String(draft.fields?.description || '').trim() && typeof global.generateDefaultProposalDescription === 'function') {
            autoFields.description = global.generateDefaultProposalDescription(typeLabel, resolvedName);
        }
        if (!(Number(draft.fields?.offer) > 0) && typeof global.generateRandomRoadOffer === 'function') {
            autoFields.offer = global.generateRandomRoadOffer();
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
            Promise.resolve(global.openProposalDraftDesign?.(draftId)).then(opened => {
                if (!opened) {
                    console.error('[ProposalEditor] Could not reopen the failed drawing; discarding draft', draftId);
                    try { global.proposalDraftStore?.deleteDraft?.(draftId); } catch (_) { }
                }
            });
            return null;
        };

        draft = store.validateDraft(draftId);
        if (!draft?.validation?.valid) {
            return keepAsDraft(draft?.validation?.errors?.[0]?.message || '');
        }

        let proposal = null;
        try { proposal = store.buildProposalFromDraft(draftId); } catch (_) { proposal = null; }
        if (!proposal) return keepAsDraft();
        // An edit produces a fresh, not-yet-proposed object even when its source had terms.
        delete proposal.termsConfirmed;
        if (!proposal.author) {
            try { proposal.author = global.getCurrentUserAgent?.()?.name || undefined; } catch (_) { }
        }

        // Building typologies REDEVELOP their parcels: existing buildings on them are
        // demolished by default (partially, clipped at the parcel boundary, when a building
        // straddles it). Structures record theirs at creation; roads decide while drawing.
        if (proposal.buildingProposal && !Array.isArray(proposal.buildingProposal.demolishedBuildings)) {
            try {
                const parentIds = (proposal.parentParcelIds || []).map(String);
                const layers = parentIds
                    .map(id => (global.parcelLayerById instanceof Map) ? global.parcelLayerById.get(id) : null)
                    .filter(layer => layer && layer.feature);
                const region = (layers.length && typeof global.buildGeometryFromParcels === 'function')
                    ? global.buildGeometryFromParcels(layers)
                    : null;
                if (region && region.type && typeof global.demolishBuildingsUnderFootprint === 'function') {
                    if (typeof global.ensureCorridorBuildingFootprintsLoaded === 'function') {
                        await global.ensureCorridorBuildingFootprintsLoaded();
                    }
                    proposal.buildingProposal.demolishedBuildings = await global.demolishBuildingsUnderFootprint(region);
                } else {
                    proposal.buildingProposal.demolishedBuildings = [];
                }
            } catch (error) {
                console.error('[ProposalEditor] building-typology demolition scan failed', error);
                proposal.buildingProposal.demolishedBuildings = [];
            }
        }

        const proposalId = global.proposalStorage?.addProposal?.(proposal);
        if (!proposalId) {
            if (typeof global.showStyledAlert === 'function') {
                global.showStyledAlert(tDraft('proposalDrafts.errors.instantCreateFailed', 'Could not save the new object.'));
            }
            return keepAsDraft();
        }
        try { global.ProposalManager?._linkProposalToAncestors?.(proposalId, proposal.parentParcelIds || []); } catch (_) { }
        store.consumeAfterPublish(draftId, proposalId);
        // Drop any comparison overlay the drawing/sync path may have painted for this draft.
        clearProposalDraftComparison();
        // Roads never warn or park anything: touching roads merged before this point, and a road
        // sharing a parcel with another road (without touching it) simply coexists — corridors
        // take partial slices, so overlap with occupied parcels is tolerated silently.
        // The about-to-be-absorbed source still occupies the parcels; it must be unapplied
        // silently (it is replaced, not parked), so the conflict gate must know about it.
        const absorbingSourceId = proposal.sourceProposalId || proposal.replacementOfProposalId || null;
        const applyOptions = (proposal.goal === 'road-track')
            ? { applyAnyway: true, suppressMissingParentAlerts: true }
            : { autoParkConflicts: true, absorbSourceProposalId: absorbingSourceId };
        try {
            await global.ProposalManager?.applyProposal?.(proposalId, applyOptions);
            // Refresh the derived layers (corridor cross-sections, parcel styles, structure
            // layers) the same way the panel's apply button does — the manager alone doesn't.
            try { global.ProposalManager?._refreshUIAfterProposalChange?.(global.proposalStorage?.getProposal?.(proposalId)); } catch (_) { }
        } catch (error) {
            console.warn('[ProposalEditor] Auto-apply after instant create failed; object stays parked', error);
        }
        // Rebuilding from a LOCAL object absorbs it (same rule as the create dialog): exactly one
        // thing remains on the map and in the list. Minted sources are immutable and stay behind.
        let absorbedSource = false;
        try {
            const absorbedSourceId = absorbingSourceId;
            const sourceRecord = absorbedSourceId ? global.proposalStorage?.getProposal?.(absorbedSourceId) : null;
            if (sourceRecord && !(typeof global.isProposalMinted === 'function' && global.isProposalMinted(sourceRecord))) {
                absorbedSource = true;
                if (typeof global.isProposalApplied === 'function' && global.isProposalApplied(sourceRecord)) {
                    await global.ProposalManager.unapplyProposal(absorbedSourceId, { skipConfirm: true, skipRestoreSource: true });
                }
                global.proposalStorage.removeProposal(absorbedSourceId);
                const storedReplacement = global.proposalStorage.getProposal(proposalId);
                if (storedReplacement) {
                    delete storedReplacement.replacementLifecycle;
                    delete storedReplacement.supersedesProposalIds;
                    // One-jump undo: remember the ORIGINAL object this edit chain started from
                    // (an earlier snapshot is carried forward), so Delete can offer to restore it.
                    try {
                        const snapshot = JSON.parse(JSON.stringify(sourceRecord.revertSnapshot || sourceRecord));
                        ['revertSnapshot', 'childParcelIds', 'replacementLifecycle', 'supersedesProposalIds', 'proposalDraftId', 'acceptedParcelIds', 'ownerAcceptances'].forEach(key => delete snapshot[key]);
                        snapshot.status = 'unapplied';
                        ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal'].forEach(kind => {
                            if (snapshot[kind] && typeof snapshot[kind] === 'object') {
                                snapshot[kind].status = 'unapplied';
                                if (Array.isArray(snapshot[kind].childParcelIds)) snapshot[kind].childParcelIds = [];
                            }
                        });
                        storedReplacement.revertSnapshot = snapshot;
                    } catch (_) { }
                    if (typeof global.proposalStorage._indexProposal === 'function') global.proposalStorage._indexProposal(storedReplacement);
                    if (typeof global.proposalStorage.save === 'function') global.proposalStorage.save();
                }
                try { global.ProposalManager._refreshUIAfterProposalChange?.(storedReplacement); } catch (_) { }
            }
        } catch (absorbError) {
            console.warn('[ProposalEditor] Could not absorb the source object', absorbError);
        }
        // A rebuild of an existing local object reads as an edit to the user, so say exactly that.
        if (absorbedSource && typeof global.showEphemeralMessage === 'function') {
            global.showEphemeralMessage(tDraft('proposalDrafts.geometryUpdated', 'Geometry updated.'), 4000, 'success');
        }

        // A parked object renders nothing — without a word it just looks like the road vanished.
        try {
            const persisted = global.proposalStorage?.getProposal?.(proposalId);
            const landed = persisted && typeof global.isProposalApplied === 'function' && global.isProposalApplied(persisted);
            if (persisted && !landed && typeof global.showStyledAlert === 'function') {
                global.showStyledAlert(tDraft('proposalDrafts.builtButParked', 'The object was created but could not be placed on the map (a conflict blocked it). It is parked in your proposals list — select it there to see and apply it.'));
            }
        } catch (_) { }
        try { if (typeof global.updateShowProposalsButton === 'function') global.updateShowProposalsButton(); } catch (_) { }
        try { if (typeof global.enableShowProposalsMode === 'function') global.enableShowProposalsMode(); } catch (_) { }
        // The drawing seeded the multi-parcel selection, which pops the parcel info panel — hide
        // it; the object's own details panel opens collapsed instead.
        try { global.document?.getElementById('parcel-info-panel')?.classList.remove('visible'); } catch (_) { }
        global.__openProposalDetailsCollapsed = true;
        try { global.selectAndHighlightProposal?.(proposalId, (proposal.parentParcelIds || [])[0] || null, false, true); } catch (_) { }
        return proposalId;
    }

    // Undo an edit chain in one jump: delete the replacement and bring its remembered original
    // back onto the map (e.g. the proposal originally loaded from a shared URL).
    async function revertProposalToSnapshot(proposalIdOrKey) {
        const record = proposalById(proposalIdOrKey);
        const snapshot = record?.revertSnapshot;
        if (!record || !snapshot) return false;
        const replacementKey = record.proposalId || proposalIdOrKey;
        try { await global.ProposalManager?.unapplyProposal?.(replacementKey, { skipConfirm: true }); } catch (_) { }
        try { global.proposalStorage.removeProposal(replacementKey); } catch (_) { }
        const restored = JSON.parse(JSON.stringify(snapshot));
        const restoredId = global.proposalStorage.addProposal(restored);
        if (!restoredId) {
            if (typeof global.updateStatus === 'function') global.updateStatus(tDraft('proposalDrafts.revertFailed', 'Could not restore the previous version.'));
            return false;
        }
        try { global.ProposalManager?._linkProposalToAncestors?.(restoredId, restored.parentParcelIds || []); } catch (_) { }
        try {
            const isRoad = restored.goal === 'road-track' || !!restored.roadProposal;
            await global.ProposalManager?.applyProposal?.(restoredId, isRoad
                ? { applyAnyway: true, suppressMissingParentAlerts: true }
                : { autoParkConflicts: true });
            try { global.ProposalManager?._refreshUIAfterProposalChange?.(global.proposalStorage.getProposal(restoredId)); } catch (_) { }
        } catch (error) {
            console.warn('[ProposalEditor] Restored proposal could not be re-applied', error);
        }
        global.__openProposalDetailsCollapsed = true;
        try { global.selectAndHighlightProposal?.(restoredId, (restored.parentParcelIds || [])[0] || null, false, true); } catch (_) { }
        if (typeof global.showEphemeralMessage === 'function') {
            global.showEphemeralMessage(tDraft('proposalDrafts.reverted', 'Restored the previous version.'), 4000, 'success');
        }
        return restoredId;
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
            if (Array.isArray(options.parentParcelIds)) fields.parentParcelIds = options.parentParcelIds.map(String);
        } else if (kind === 'building') {
            if (!['buildings', 'row', 'parcelBased', 'single'].includes(draft.adapterKey || draft.goal)) return null;
            const typology = payload.parameters?.typology || draft.editorPayload?.typology || draft.adapterKey;
            patch = {
                editorPayload: { typology, context: JSON.parse(JSON.stringify(payload)) },
                previewGeometry: JSON.parse(JSON.stringify(payload.buildings?.length ? payload.buildings : [payload.buildingFeature].filter(Boolean)))
            };
            if (Array.isArray(payload.parcelIds)) fields.parentParcelIds = payload.parcelIds.map(String);
        } else if (kind === 'reparcellization') {
            if (draft.goal !== 'reparcellization') return null;
            patch = { editorPayload: { plan: JSON.parse(JSON.stringify(payload)) }, previewGeometry: JSON.parse(JSON.stringify(payload.polygons || [])) };
            if (Array.isArray(payload.parcelIds)) fields.parentParcelIds = payload.parcelIds.map(String);
        } else if (kind === 'structure') {
            if (!['park', 'square'].includes(draft.adapterKey || draft.goal)) return null;
            const structureProposal = JSON.parse(JSON.stringify(payload.structureProposal || payload));
            const geometry = structureProposal.geometry || draft.editorPayload?.geometry || null;
            patch = {
                editorPayload: { ...draft.editorPayload, geometry, structureProposal },
                previewGeometry: JSON.parse(JSON.stringify(geometry))
            };
            if (Array.isArray(structureProposal.parentParcelIds)) {
                fields.parentParcelIds = structureProposal.parentParcelIds.map(String);
            }
        } else {
            return null;
        }
        if (Object.keys(fields).length) patch.fields = fields;
        const updated = store.updateDraft(draft.id, patch, { coalesceKey: options.coalesceKey || `editor:${kind}` });
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
            || draft.editorPayload?.plan?.polygons
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
    global.proposeExistingProposal = proposeExistingProposal;
    global.editProposalGeometry = editProposalGeometry;
    global.canEditProposalGeometry = canEditProposalGeometry;
    global.startInstantProposalDesign = startInstantProposalDesign;
    global.revertProposalToSnapshot = revertProposalToSnapshot;
    global.instantCreateStructureFromSelection = instantCreateStructureFromSelection;
    global.getProposalEditCapability = getProposalEditCapability;
    global.createNewProposalDraft = createNewProposalDraft;
    global.beginProposalDraftDesignSession = beginProposalDraftDesignSession;
    global.getActiveProposalDesignDraft = getActiveProposalDesignDraft;
    global.finishProposalDraftDesignSession = finishProposalDraftDesignSession;
    global.isProposalDesignCommitSession = isProposalDesignCommitSession;
    global.discardProposalDraftDesignSession = discardProposalDraftDesignSession;
    global.confirmDiscardProposalDesignSession = confirmDiscardProposalDesignSession;
    global.stageProposalDraftForPublishing = stageProposalDraftForPublishing;
    global.instantCreateProposalFromDraft = instantCreateProposalFromDraft;
    global.syncActiveProposalDraftFromEditor = syncActiveProposalDraftFromEditor;
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
            formatDuration,
            patchForPath,
            displayValue
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
