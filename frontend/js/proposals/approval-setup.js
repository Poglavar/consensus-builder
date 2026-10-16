// The "Ownership and approval" form: parcel-rights import, the approval rule and the lens. One form
// for the proposal editor's Approval tab and the create dialog, so a readjustment's owners can be set
// up while it is being created instead of through a replacement afterwards. It keeps no state: it
// renders a config and lens and turns the form's controls back into them. Rules live in approval.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.ProposalApprovalSetup = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const MAX_FILE_BYTES = 1024 * 1024;

    function t(key, fallback, params = {}) {
        let value = null;
        try {
            if (root.i18n && typeof root.i18n.t === 'function') {
                value = root.i18n.t(key, params);
                if (value === key) value = null;
            }
        } catch (_) { }
        let output = value || fallback;
        Object.keys(params).forEach(name => {
            output = String(output).replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), String(params[name]));
        });
        return output;
    }

    function esc(value) {
        if (typeof root.escapeHtml === 'function') return root.escapeHtml(value);
        return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    }

    function option(value, label, selected) {
        return `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
    }

    function fractionText(value) {
        if (!value || typeof value !== 'object') return '';
        return `${value.numerator}/${value.denominator}`;
    }

    // An approval config in canonical form; an absent one is "no rights, every owner must approve".
    function normalizedConfig(config) {
        const api = approval();
        if (!api || typeof api.normalizeConfig !== 'function') return null;
        return api.normalizeConfig(config || {
            schema: api.CONFIG_SCHEMA || 'proposal-approval/v1',
            rights: null,
            policy: { type: 'unanimous' }
        });
    }

    function lensKeys(lens) {
        return (Array.isArray(lens) ? lens : [])
            .map(entry => (typeof entry === 'string' ? entry : (entry?.address || entry?.key || '')))
            .filter(Boolean);
    }

    function lensFromText(text) {
        return [...new Set(String(text || '').split(/[\n,]+/).map(value => value.trim()).filter(Boolean))];
    }

    function parseFraction(text, fallback) {
        if (text === undefined || text === null) return fallback;
        const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(text || ''));
        if (!match) throw new Error(t('proposalDrafts.approval.invalidFraction', 'Enter a fraction such as 1/2.'));
        return { numerator: Number(match[1]), denominator: Number(match[2]) };
    }

    function policyText(policy) {
        return policy?.type === 'threshold'
            ? t('proposalDrafts.approval.policyContextThreshold', 'Approval uses owner-count {{owners}} and area {{area}} thresholds.', {
                owners: fractionText(policy.owners), area: fractionText(policy.area)
            })
            : t('proposalDrafts.approval.policyContextUnanimous', 'Every declared owner must approve.');
    }

    function ownerLabel(ownerId, ownerIds) {
        const raw = approval()?.ownerLabel?.(ownerId, ownerIds) || String(ownerId || '');
        return t('proposalApproval.ownerLabel', 'Owner {{label}}', { label: raw.replace(/^Owner\s*/, '') });
    }

    // One line for a summary row: what the rights cover, the rule and the lens, or that none is set.
    function summaryText(config, lens) {
        const rights = config?.rights;
        if (!rights || !Array.isArray(rights.parcels)) {
            return t('proposalDrafts.approval.summaryNone', 'Not set up yet — owners cannot accept until it is.');
        }
        const owners = new Set(rights.parcels.flatMap(parcel => (parcel.owners || []).map(owner => owner.ownerId))).size;
        const keys = lensKeys(lens);
        return [
            t('proposalDrafts.approval.summaryRights', 'Rights for {{parcels}} parcel(s), {{owners}} owner(s)', { parcels: rights.parcels.length, owners }),
            policyText(config.policy),
            keys.length
                ? t('proposalDrafts.approval.summaryLens', '{{count}} lens member(s).', { count: keys.length })
                : t('proposalDrafts.approval.summaryNoLens', 'No lens member yet.')
        ].join(' · ');
    }

    function previewHtml(config, cadastreParcelIds) {
        const rights = config?.rights;
        if (!rights) return `<div class="proposal-editor-card"><p>${esc(t('proposalDrafts.approval.noRights', 'No uploaded ownership dataset. Geometry and proposal review remain available.'))}</p></div>`;
        const proposal = { approvalConfig: config, cadastreParcelIds: Array.isArray(cadastreParcelIds) ? cadastreParcelIds : [] };
        let inspection = { ready: false, reason: '', ownerIds: [], missingParcelIds: [] };
        try { inspection = approval()?.inspect?.(proposal) || inspection; } catch (error) {
            inspection = { ...inspection, reason: error?.message || String(error) };
        }
        const sourceRows = Array.isArray(rights.parcels) ? rights.parcels : [];
        const ownerIds = [...new Set(sourceRows.flatMap(entry => (entry.owners || []).map(owner => owner.ownerId)))].sort();
        const reasons = {
            'missing-rights': t('proposalDrafts.approval.reason.missingRights', 'No ownership rights dataset is loaded.'),
            'missing-parcels': t('proposalDrafts.approval.reason.missingParcels', 'Select parcels to check ownership data.'),
            'incomplete-rights': t('proposalDrafts.approval.reason.incompleteRights', 'Ownership data is incomplete for one or more selected parcels.'),
            'missing-owners': t('proposalDrafts.approval.reason.missingOwners', 'No owners are declared for the selected parcels.')
        };
        const rows = sourceRows.map(entry => {
            const ownerList = (entry.owners || []).map(owner =>
                `${esc(ownerLabel(owner.ownerId, ownerIds))} · ${esc(owner.ownerId)} · ${esc(owner.share)}`
            ).join('<br>') || esc(t('proposalDrafts.approval.noOwners', 'No owners listed'));
            const area = typeof entry.areaM2 === 'number' ? `${entry.areaM2} m²` : '—';
            const completeness = entry.complete
                ? t('proposalDrafts.approval.complete', 'Complete')
                : t('proposalDrafts.approval.incomplete', 'Incomplete');
            return `<div class="proposal-editor-approval-row"><strong>${esc(entry.parcelId)}</strong><span>${esc(area)} · ${esc(completeness)}</span><div>${ownerList}</div></div>`;
        }).join('');
        const status = inspection.ready
            ? t('proposalDrafts.approval.ready', 'Ownership data is complete for the selected parcels.')
            : t('proposalDrafts.approval.notReady', 'Approval readiness: {{reason}}', { reason: reasons[inspection.reason] || t('proposalDrafts.approval.incomplete', 'incomplete ownership data') });
        const missing = (inspection.missingParcelIds || []).length
            ? `<p>${esc(t('proposalDrafts.approval.missingParcels', 'Missing selected parcels: {{parcels}}', { parcels: inspection.missingParcelIds.join(', ') }))}</p>`
            : '';
        return `<div class="proposal-editor-approval-status ${inspection.ready ? 'is-ready' : 'is-incomplete'}">${esc(status)}</div>${missing}<div class="proposal-editor-approval-list">${rows || `<p>${esc(t('proposalDrafts.approval.emptyRights', 'The dataset has no parcel rows yet.'))}</p>`}</div>`;
    }

    // The form. `config` is a raw or canonical approval config, `lens` the lens member keys,
    // `cadastreParcelIds` the parcels the proposal declares (readiness is checked against them),
    // `error` a message to show above the preview, `heading` false where the host already titles it.
    function html({ config, lens, cadastreParcelIds, error, heading = true } = {}) {
        let normalized = null;
        let configError = null;
        try { normalized = normalizedConfig(config); } catch (problem) { configError = problem?.message || String(problem); }
        const providers = root.ProposalApprovalSources;
        let sourceList = [];
        try { sourceList = providers?.list?.() || []; } catch (_) { }
        const selectedSource = sourceList.some(source => source.id === normalized?.rights?.source?.provider)
            ? normalized.rights.source.provider : 'upload';
        const sourceOptions = sourceList.map(source => option(source.id,
            source.id === 'upload' ? t('proposalDrafts.approval.upload', 'Upload JSON') : (source.label || source.id), selectedSource)).join('');
        const policy = normalized?.policy || { type: 'unanimous' };
        const threshold = policy.type === 'threshold' ? policy : {};
        const message = error || configError;
        const strictValue = rule => (String(rule?.strict) === 'true' ? 'true' : 'false');
        return `
            <section class="proposal-editor-section" data-editor-section="approval">
                ${heading ? `<h3>${esc(t('proposalDrafts.approval.title', 'Ownership and approval'))}</h3>` : ''}
                <p class="proposal-editor-section-copy">${esc(t('proposalDrafts.approval.explainer', 'Upload abstract parcel-owner rights and set who must approve. This data is separate from parcel geometry; missing rights do not block the geometric proposal. Rights describe declared ownership and do not prove authorization.'))}</p>
                <div class="proposal-editor-card">
                    <h4>${esc(t('proposalDrafts.approval.rightsTitle', 'Parcel-owner rights'))}</h4>
                    <p>${esc(t('proposalDrafts.approval.importHelp', 'Import a parcel-rights JSON file, or load it from a registered source. The previous dataset stays in place if import fails.'))}</p>
                    <div class="proposal-editor-grid">
                        <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.source', 'Rights source'))}</span><select data-approval-source>${sourceOptions || option('upload', t('proposalDrafts.approval.upload', 'Upload JSON'), 'upload')}</select></label>
                        <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.reference', 'Source reference or query'))}</span><input type="text" data-approval-reference value="${esc(normalized?.rights?.source?.reference || '')}" autocomplete="off"${selectedSource === 'upload' ? ' disabled' : ''}></label>
                    </div>
                    <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.file', 'Rights JSON file (up to 1 MB)'))}</span><input type="file" accept="application/json,.json" data-approval-file${selectedSource !== 'upload' ? ' disabled' : ''}></label>
                    <div class="cb-actions">
                        <button type="button" class="btn btn-sm" data-editor-action="approval-import">${esc(t('proposalDrafts.approval.import', 'Import and preview'))}</button>
                        <button type="button" class="btn btn-sm" data-editor-action="approval-template">${esc(t('proposalDrafts.approval.template', 'Download template'))}</button>
                        <button type="button" class="btn btn-danger btn-sm" data-editor-action="approval-remove"${normalized?.rights ? '' : ' disabled'}>${esc(t('proposalDrafts.approval.remove', 'Remove rights'))}</button>
                    </div>
                    ${message ? `<div class="proposal-editor-approval-error" role="alert">${esc(message)}</div>` : ''}
                    ${normalized ? previewHtml(normalized, cadastreParcelIds) : `<div class="proposal-editor-approval-error">${esc(t('proposalDrafts.approval.apiMissing', 'Ownership rights support is unavailable.'))}</div>`}
                </div>
                <div class="proposal-editor-card">
                    <h4>${esc(t('proposalDrafts.approval.policyTitle', 'Approval policy'))}</h4>
                    <p>${esc(policyText(policy))}</p>
                    <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.policyType', 'Policy'))}</span><select data-approval-policy-type>${option('unanimous', t('proposalDrafts.approval.unanimous', 'Unanimous'), policy.type)}${option('threshold', t('proposalDrafts.approval.threshold', 'Custom threshold'), policy.type)}</select></label>
                    ${policy.type === 'threshold' ? `<div class="proposal-editor-approval-thresholds">
                        <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.ownerThreshold', 'Owner-count threshold (fraction)'))}</span><input type="text" data-approval-fraction="owners" value="${esc(fractionText(threshold.owners))}" placeholder="1/2"></label>
                        <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.areaThreshold', 'Area threshold (fraction)'))}</span><input type="text" data-approval-fraction="area" value="${esc(fractionText(threshold.area))}" placeholder="7/10"></label>
                        <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.ownerRule', 'Owner-count rule'))}</span><select data-approval-strict="owners">${option('false', t('proposalDrafts.approval.atLeast', 'At least'), strictValue(threshold.owners))}${option('true', t('proposalDrafts.approval.strictlyMore', 'Strictly more than'), strictValue(threshold.owners))}</select></label>
                        <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.areaRule', 'Area rule'))}</span><select data-approval-strict="area">${option('false', t('proposalDrafts.approval.atLeast', 'At least'), strictValue(threshold.area))}${option('true', t('proposalDrafts.approval.strictlyMore', 'Strictly more than'), strictValue(threshold.area))}</select></label>
                    </div>` : ''}
                </div>
                <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.lensMembers', 'Lens member keys'))}</span><textarea data-approval-lens placeholder="${esc(t('proposalDrafts.approval.lensPlaceholder', 'One key per line'))}">${esc(lensKeys(lens).join('\n'))}</textarea></label>
            </section>`;
    }

    // ---- reading the form back ------------------------------------------------------------------

    // The rights source select enables the reference field or the file field, never both.
    function syncSourceControls(container) {
        const source = container?.querySelector('[data-approval-source]');
        if (!source) return;
        const reference = container.querySelector('[data-approval-reference]');
        const file = container.querySelector('[data-approval-file]');
        if (reference) reference.disabled = source.value === 'upload';
        if (file) file.disabled = source.value !== 'upload';
    }

    // The config with the policy the form now shows. Throws on a malformed fraction, leaving the
    // caller's config untouched.
    function withPolicyFromForm(container, config) {
        const current = normalizedConfig(config);
        const type = container?.querySelector('[data-approval-policy-type]')?.value || 'unanimous';
        let policy = { type: 'unanimous' };
        if (type === 'threshold') {
            const old = current.policy?.type === 'threshold' ? current.policy : {};
            const owners = parseFraction(container.querySelector('[data-approval-fraction="owners"]')?.value, old.owners || { numerator: 1, denominator: 2 });
            const area = parseFraction(container.querySelector('[data-approval-fraction="area"]')?.value, old.area || { numerator: 7, denominator: 10 });
            const strict = kind => container.querySelector(`[data-approval-strict="${kind}"]`)?.value === 'true';
            policy = { type: 'threshold', owners: { ...owners, strict: strict('owners') }, area: { ...area, strict: strict('area') } };
        }
        return approval().normalizeConfig({ ...current, policy });
    }

    function lensFromForm(container) {
        return lensFromText(container?.querySelector('[data-approval-lens]')?.value);
    }

    // Load rights from the chosen source (an uploaded file or a registered provider) and return the
    // config carrying them. Throws with a readable message; the caller keeps its previous config.
    async function importRights(container, config, { parcelIds = [] } = {}) {
        const api = approval();
        if (!api?.normalizeRights || !api?.normalizeConfig) throw new Error(t('proposalDrafts.approval.apiMissing', 'Ownership rights support is unavailable.'));
        const providers = root.ProposalApprovalSources;
        const sourceId = container?.querySelector('[data-approval-source]')?.value || 'upload';
        const reference = container?.querySelector('[data-approval-reference]')?.value || '';
        let raw;
        if (sourceId === 'upload') {
            const file = container?.querySelector('[data-approval-file]')?.files?.[0];
            if (!file) throw new Error(t('proposalDrafts.approval.chooseFile', 'Choose a JSON file to import.'));
            if (file.size > MAX_FILE_BYTES) throw new Error(t('proposalDrafts.approval.fileTooLarge', 'The JSON file must be 1 MB or smaller.'));
            const text = await file.text();
            if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error(t('proposalDrafts.approval.fileTooLarge', 'The JSON file must be 1 MB or smaller.'));
            raw = providers?.load ? await providers.load(sourceId, text, { parcelIds }) : JSON.parse(text);
        } else {
            if (!providers?.load) throw new Error(t('proposalDrafts.approval.providerUnavailable', 'This ownership source is unavailable.'));
            raw = await providers.load(sourceId, reference, { parcelIds });
        }
        const rights = api.normalizeRights(raw);
        return api.normalizeConfig({ ...normalizedConfig(config), rights });
    }

    function withoutRights(config) {
        return approval().normalizeConfig({ ...normalizedConfig(config), rights: null });
    }

    function downloadTemplate(parcelIds) {
        const api = approval();
        if (!api?.createTemplate || !root.Blob || !root.URL?.createObjectURL || !root.document) return;
        const template = api.createTemplate(parcelIds || []);
        const url = root.URL.createObjectURL(new root.Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }));
        const link = root.document.createElement('a');
        link.href = url;
        link.download = 'parcel-rights-template.json';
        root.document.body.appendChild(link);
        link.click();
        link.remove();
        // The browser reads the URL after this tick; revoke it once the download has started.
        root.setTimeout(() => root.URL.revokeObjectURL(url), 0);
    }

    // The form in its own dialog, for a proposal being created (the create dialog's row and the land
    // readjustment designer). Edits stay local until "Use this setup", which hands
    // { approvalConfig, lens } to onApply; Cancel changes nothing.
    function openDialog({ approvalConfig = null, lens = [], cadastreParcelIds = [], onApply } = {}) {
        if (!root.CbDialog) return null;
        const state = { approvalConfig, lens: lensKeys(lens), error: null, sequence: 0 };
        let dialog = null;
        const render = () => {
            dialog.body.innerHTML = html({ config: state.approvalConfig, lens: state.lens, cadastreParcelIds, error: state.error, heading: false });
        };
        // The lens first: a malformed fraction must not cost the author the keys they typed.
        const readForm = () => {
            state.lens = lensFromForm(dialog.body);
            state.approvalConfig = withPolicyFromForm(dialog.body, state.approvalConfig);
        };
        dialog = root.CbDialog.open({
            title: t('proposalDrafts.approval.title', 'Ownership and approval'),
            size: 'lg',
            className: 'approval-setup-dialog',
            actions: [
                { id: 'cancel', label: t('common.cancel', 'Cancel'), role: 'secondary' },
                {
                    id: 'apply', label: t('proposalDrafts.approval.apply', 'Use this setup'), role: 'primary', keepOpen: true,
                    onClick: api => {
                        try { readForm(); } catch (error) {
                            // Say what is wrong without re-rendering, so the typed values stay to fix.
                            let note = dialog.body.querySelector('[data-approval-apply-error]');
                            if (!note) {
                                note = root.document.createElement('div');
                                note.className = 'proposal-editor-approval-error';
                                note.setAttribute('role', 'alert');
                                note.dataset.approvalApplyError = '';
                                dialog.body.prepend(note);
                            }
                            note.textContent = error?.message || String(error);
                            return;
                        }
                        api.close('apply');
                        if (typeof onApply === 'function') onApply({ approvalConfig: normalizedConfig(state.approvalConfig), lens: state.lens });
                    }
                }
            ]
        });
        render();
        dialog.body.addEventListener('change', event => {
            if (event.target.closest('[data-approval-source]')) { syncSourceControls(dialog.body); return; }
            // Only switching the policy type changes which fields exist. Re-rendering on every other
            // edit would replace the field the author has just moved into; those are read on apply.
            if (!event.target.closest('[data-approval-policy-type]')) return;
            try { readForm(); state.error = null; } catch (error) { state.error = error?.message || String(error); }
            render();
        });
        dialog.body.addEventListener('click', async event => {
            const action = event.target.closest('[data-editor-action]')?.dataset.editorAction;
            if (!action) return;
            event.preventDefault();
            // Keep what was typed in the other fields across the re-render an import causes.
            try { readForm(); } catch (_) { /* the lens is kept; a bad fraction is reported on apply */ }
            if (action === 'approval-template') { downloadTemplate(cadastreParcelIds); return; }
            if (action === 'approval-remove') {
                state.sequence += 1;
                state.approvalConfig = withoutRights(state.approvalConfig);
                state.error = null;
                render();
                return;
            }
            if (action !== 'approval-import') return;
            const sequence = ++state.sequence;
            try {
                const imported = await importRights(dialog.body, state.approvalConfig, { parcelIds: cadastreParcelIds });
                if (sequence !== state.sequence) return;
                state.approvalConfig = imported;
                state.error = null;
            } catch (error) {
                // A failed file or provider leaves the previous rights in place.
                if (sequence !== state.sequence) return;
                state.error = error?.message || String(error);
            }
            render();
        });
        return dialog;
    }

    return {
        openDialog,
        html, previewHtml, summaryText, policyText, fractionText, parseFraction, lensKeys, lensFromText,
        normalizedConfig, syncSourceControls, withPolicyFromForm, lensFromForm, importRights, withoutRights, downloadTemplate
    };
});
