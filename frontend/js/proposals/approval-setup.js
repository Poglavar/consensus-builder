// The "Ownership and approval" form: parcel-rights import, the agreement rules and the lens. One form
// for the proposal editor's Approval tab and the create dialog, so a readjustment's owners can be set
// up while it is being created instead of through a replacement afterwards. It keeps no state: it
// renders a config and lens and turns the form's controls back into them. The rules are chosen as a
// scheme (approval-regimes.js: voluntary, owner support plus an authority, or authority-led), as
// "every owner must agree", or as custom tests; rules and counting live in approval.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.ProposalApprovalSetup = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const regimes = () => root.ProposalApprovalRegimes || (typeof require === 'function' ? require('./approval-regimes.js') : null);
    const words = () => root.ProposalApprovalText || (typeof require === 'function' ? require('./approval-text.js') : null);
    const DEFAULT_AUTHORITY = 'authority-1';
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

    // The rule in words, led by the scheme's name when it is a named one.
    function policyText(policy, regime = null) {
        const rule = words().rulesText(policy || { type: 'unanimous' }, t, regime);
        const name = regime ? words().regimeName(regime, t) : null;
        return name ? `${name}: ${rule}` : rule;
    }

    // "Owner A", "Leaseholder A", translated, for the parties a rights file declares.
    function partyLabel(id, state) {
        const party = approval().partyOf(id, state);
        if (!party) return String(id || '');
        const key = party.kind === 'leaseholder' ? 'proposalApproval.leaseholderLabel' : 'proposalApproval.ownerLabel';
        return t(key, party.kind === 'leaseholder' ? 'Leaseholder {{label}}' : 'Owner {{label}}', { label: party.letter });
    }

    // One line for a summary row: what the rights cover, the rule and the lens, or that none is set.
    function summaryText(config, lens) {
        const rights = config?.rights;
        if (!rights || !Array.isArray(rights.parcels)) {
            return t('proposalDrafts.approval.summaryNone', 'Not set up yet — owners cannot accept until it is.');
        }
        const owners = new Set(rights.parcels.flatMap(parcel => (parcel.owners || []).map(owner => owner.ownerId))).size;
        const leaseholders = new Set(rights.parcels.flatMap(parcel => (parcel.leases || []).flatMap(lease => lease.holders.map(holder => holder.ownerId)))).size;
        const keys = lensKeys(lens);
        return [
            t('proposalDrafts.approval.summaryRights', 'Rights for {{parcels}} parcel(s), {{owners}} owner(s)', { parcels: rights.parcels.length, owners })
                + (leaseholders ? t('proposalDrafts.approval.summaryLeaseholders', ', {{count}} leaseholder(s)', { count: leaseholders }) : ''),
            policyText(config.policy, config.regime),
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
        const leaseholderIds = [...new Set(sourceRows.flatMap(entry => (entry.leases || []).flatMap(lease => lease.holders.map(holder => holder.ownerId))))].sort();
        const parties = { ownerIds, leaseholderIds, authorityIds: [] };
        const publicBodies = new Set(rights.publicBodies || []);
        const holderText = holder => `${esc(partyLabel(holder.ownerId, parties))} · ${esc(holder.ownerId)} · ${esc(holder.share)}${publicBodies.has(holder.ownerId)
            ? ` · ${esc(t('proposalDrafts.approval.publicBody', 'public body'))}` : ''}`;
        const reasons = {
            'missing-rights': t('proposalDrafts.approval.reason.missingRights', 'No ownership rights dataset is loaded.'),
            'missing-parcels': t('proposalDrafts.approval.reason.missingParcels', 'Select parcels to check ownership data.'),
            'incomplete-rights': t('proposalDrafts.approval.reason.incompleteRights', 'Ownership data is incomplete for one or more selected parcels.'),
            'missing-owners': t('proposalDrafts.approval.reason.missingOwners', 'No owners are declared for the selected parcels.'),
            'authority-is-holder': t('proposalDrafts.approval.reason.authorityIsHolder', 'An authority id is also a rights holder; give the authority its own id.')
        };
        const rows = sourceRows.map(entry => {
            const ownerList = ((entry.owners || []).map(holderText).join('<br>') || esc(t('proposalDrafts.approval.noOwners', 'No owners listed')))
                + (entry.leases || []).map(lease => `<br>${esc(t('proposalDrafts.approval.leaseRow', 'Lease {{lease}} · {{area}}', {
                    lease: lease.leaseId, area: typeof lease.areaM2 === 'number' ? `${lease.areaM2} m²` : t('parcelCompare.extent.whole', 'Whole parcel') }))}: ${lease.holders.map(holderText).join(', ')}`).join('');
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
    function html({ config, lens, cadastreParcelIds, error, heading = true, schemeStatus = null, schemeCheck = null } = {}) {
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
        const message = error || configError;
        return `
            <section class="proposal-editor-section" data-editor-section="approval">
                ${heading ? `<h3>${esc(t('proposalDrafts.approval.title', 'Ownership and approval'))}</h3>` : ''}
                <p class="proposal-editor-section-copy">${esc(t('proposalDrafts.approval.explainer', 'Upload abstract parcel-owner rights and set who must approve. This data is separate from parcel geometry; missing rights do not block the design. Rights describe declared ownership and do not prove authorization.'))}</p>
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
                ${rulesCardHtml(normalized, schemeStatus, schemeCheck)}
                <label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.lensMembers', 'Lens member keys'))}</span><textarea data-approval-lens placeholder="${esc(t('proposalDrafts.approval.lensPlaceholder', 'One key per line'))}">${esc(lensKeys(lens).join('\n'))}</textarea></label>
            </section>`;
    }

    // ---- agreement rules ----------------------------------------------------------------------------

    // Which entry of the rules dropdown a config is: a scheme id, "unanimous" or "custom".
    function ruleChoice(config) {
        if (config?.regime?.id) return config.regime.id;
        return !config?.policy || config.policy.type === 'unanimous' ? 'unanimous' : 'custom';
    }

    // The newest version of each scheme, in catalogue order.
    const latestRegimes = () => {
        const seen = new Set();
        return regimes().list().slice().sort((a, b) => (a.version === b.version ? 0 : a.version < b.version ? 1 : -1))
            .filter(regime => !seen.has(regime.id) && seen.add(regime.id));
    };

    // `check`: the host's plan against this scheme's distribution rules, already worded
    // ({ ok, lines: [{ ok, text }] }, from AgreementRecord.schemeCheck and ProposalApprovalText.checkLines).
    function regimeDetailsHtml(template, regime, check = null) {
        const need = regimes().needs(template.tests);
        const lines = words().allocationLines(template, t);
        const sources = template.sources.map(source => `<a class="cb-link cb-link--external" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)}</a>`).join(', ');
        const checked = check && check.lines && check.lines.length
            ? `<p class="approval-setup__check-title">${esc(t('proposalDrafts.approval.schemeCheckTitle', 'This plan against the scheme'))}</p>
            <ul class="approval-setup__check" data-approval-scheme-check data-approval-scheme-ok="${check.ok ? 'true' : 'false'}">${check.lines.map(line =>
                `<li data-check-ok="${line.ok ? 'true' : 'false'}">${esc(line.text)}</li>`).join('')}</ul>` : '';
        return `<div class="approval-setup__regime" data-approval-regime-details="${esc(template.id)}">
            <p>${esc(words().familyText(template, t))} · ${esc(words().stageText(template, t))}</p>
            <p>${esc(t(`proposalApproval.schemes.${template.id}.note`, template.text.note))}</p>
            ${lines.length ? `<ul class="approval-setup__allocation">${lines.map(line => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
            ${checked}
            ${need.leases || need.publicBodies ? `<p data-approval-rights-needed>${esc(t('proposalDrafts.approval.rightsNeeded', 'The rights file must list {{what}} (parcel-rights/v2); the downloaded template includes them.', {
                what: [need.leases ? t('proposalDrafts.approval.needLeases', 'every lease and its holders') : null,
                    need.publicBodies ? t('proposalDrafts.approval.needPublicBodies', 'which holders are public bodies') : null].filter(Boolean).join(t('proposalApproval.rules.and', ' and '))
            }))}</p>` : ''}
            <p class="approval-setup__sources">${esc(t('proposalDrafts.approval.sources', 'Sources:'))} ${sources}</p>
            <p class="approval-setup__guide"><button type="button" class="cb-link" data-editor-action="approval-scheme-guide" data-scheme-id="${esc(template.id)}" data-scheme-version="${esc(template.version)}">${esc(t('proposalDrafts.approval.guide.open', 'How this scheme works…'))}</button></p>
        </div>`;
    }

    // ---- the scheme guide ----------------------------------------------------------------------------
    // "How this scheme works": built from the template's own data, so every scheme explains itself the
    // same way: who decides and what the support is for, how land is distributed (with a schematic
    // drawn from the scheme's cap and basis), this agreement against the scheme when the host has one
    // (with what would fix a broken rule), how to set it up with this editor's controls, and the sources.

    const percentOf = ratio => Math.round(ratio * 1000) / 10;
    const capOf = template => template?.allocation?.cap || null;
    const capRatio = cap => (cap ? cap.numerator / cap.denominator : 0);

    function areaText(m2) {
        const format = root.CbFormat;
        return format && typeof format.formatArea === 'function' ? format.formatArea(m2) : `${Math.round(m2)} m²`;
    }
    function moneyText(cents, currency) {
        const format = root.CbFormat;
        const digits = cents % 100 === 0 ? 0 : 2;
        return format && typeof format.formatMoney === 'function' ? format.formatMoney(cents / 100, currency, { maxFractionDigits: digits, minFractionDigits: digits }) : `${(cents / 100).toFixed(digits)} ${currency}`;
    }

    // The before/after bars: the land each party puts in, and what comes back after the public take
    // the scheme allows (per owner, per pool, or none). Real parties when the host has them (the
    // largest five), else three example owners. Colours and type come from the stylesheet.
    function schematicSvg(template, parties) {
        const cap = capOf(template);
        const shares = (parties && parties.length ? parties.slice(0, 5).map(party => ({ label: party.label, share: party.contributedM2 }))
            : [{ label: 'A', share: 40 }, { label: 'B', share: 35 }, { label: 'C', share: 25 }]);
        const total = shares.reduce((sum, row) => sum + row.share, 0) || 1;
        const width = 320, height = 112, barHeight = 24, top = 18, bottom = 72;
        const taken = cap ? capRatio(cap) : 0;
        // A label only where it fits (about 6.5 px per character at the label's size).
        const slice = (x, w, y, className, label) => `<rect class="${className}" x="${x.toFixed(1)}" y="${y}" width="${Math.max(0, w).toFixed(1)}" height="${barHeight}" rx="3"></rect>`
            + (label && w > String(label).length * 6.5 + 8 ? `<text class="scheme-guide__slice-label" x="${(x + w / 2).toFixed(1)}" y="${y + barHeight / 2 + 4}" text-anchor="middle">${esc(label)}</text>` : '');
        let before = '', after = '', x = 0, afterX = taken * width;
        shares.forEach((row, index) => {
            const w = width * row.share / total;
            before += slice(x, w, top, `scheme-guide__slice scheme-guide__slice--owner-${(index % 5) + 1}`, row.label);
            after += slice(afterX, w * (1 - taken), bottom, `scheme-guide__slice scheme-guide__slice--owner-${(index % 5) + 1}`, row.label);
            x += w; afterX += w * (1 - taken);
        });
        const publicSlice = taken > 0 ? slice(0, taken * width, bottom, 'scheme-guide__slice scheme-guide__slice--public', t('agreement.allocation.public', 'Public')) : '';
        return `<svg class="scheme-guide__svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(schematicCaption(template))}">
            <text class="scheme-guide__bar-label" x="0" y="12">${esc(t('proposalDrafts.approval.guide.before', 'Land put in'))}</text>${before}
            <text class="scheme-guide__bar-label" x="0" y="${bottom - 6}">${esc(t('proposalDrafts.approval.guide.after', 'Land after the readjustment'))}</text>${publicSlice}${after}
        </svg>`;
    }

    function schematicCaption(template) {
        const cap = capOf(template);
        const percent = percentOf(capRatio(cap));
        if (cap && cap.per === 'pool') return t('proposalDrafts.approval.guide.schematicPoolCap', 'Up to {{percent}}% of the pool goes to public facilities and costs without compensation; the parties share the rest, and differences are settled in money.', { percent });
        if (cap) return t('proposalDrafts.approval.guide.schematicOwnerCap', 'Each owner gives up at most {{percent}}% of their land for public use without compensation and gets a plot back; any further difference is settled in money.', { percent });
        if (template?.allocation?.basis === 'value') return t('proposalDrafts.approval.guide.schematicValue', 'Every owner gets back a share of the new land worth what they put in; public land reduces that share for everyone alike, and differences are settled in money.');
        return t('proposalDrafts.approval.guide.schematicNone', 'The parties agree what each gets back; the scheme sets no cap on public land, and differences are settled in money.');
    }

    // What would satisfy a rule the agreement breaks, in this editor's own controls.
    function fixText(rule, template, ledger) {
        const name = id => (ledger && ledger.parties.find(party => party.ownerKey === id)?.displayName) || id;
        if (rule.kind === 'basis') {
            return rule.required === 'value'
                ? t('proposalDrafts.approval.guide.fixBasisValue', 'In Rules, set Compensation to “Balance land value differences in money”, then give every input parcel and resulting piece a value per m².')
                : t('proposalDrafts.approval.guide.fixBasisArea', 'In Rules, set Compensation to “Balance land differences in money”.');
        }
        if (rule.kind === 'parties') return t('proposalDrafts.approval.guide.fixParties', '{{actual}} parties bring land in and this scheme needs {{required}}: choose a plan over more parcels, or another scheme.', { actual: rule.actual, required: rule.required });
        if (rule.kind === 'proposer') return t('proposalDrafts.approval.guide.fixProposer', 'In Output parcels, assign the proposer’s pieces to an owner or to Public land.');
        const limit = capRatio(rule.limit);
        if (rule.per === 'owner') {
            const party = ledger && ledger.parties.find(row => row.ownerKey === rule.worst.ownerKey);
            const area = party ? party.contributedM2 * (rule.worst.given - limit) : null;
            return area !== null
                ? t('proposalDrafts.approval.guide.fixCapOwner', 'In Output parcels, give {{owner}} at least {{area}} more land back, or lower the Land contribution; a scheme with a higher cap is another way.', { owner: name(rule.worst.ownerKey), area: areaText(area) })
                : t('proposalDrafts.approval.guide.fixCapOwnerPlain', 'In Output parcels, give {{owner}} more land back.', { owner: name(rule.worst.ownerKey) });
        }
        return t('proposalDrafts.approval.guide.fixCapPool', 'In Output parcels, return at least {{percent}}% of the pool to the owners.', { percent: percentOf(1 - limit) });
    }

    // How to set the scheme up in this editor, from what the template asks for.
    function setupSteps(template) {
        const steps = [];
        const basis = template.allocation?.basis;
        steps.push(basis === 'value' ? t('proposalDrafts.approval.guide.stepCompensationValue', 'Rules › Compensation: “Balance land value differences in money”, then a value per m² for every input parcel and resulting piece (prefilled with the city’s land price).')
            : basis === 'area' ? t('proposalDrafts.approval.guide.stepCompensationArea', 'Rules › Compensation: “Balance land differences in money”, with the rate per m².')
                : t('proposalDrafts.approval.guide.stepCompensationEither', 'Rules › Compensation: by area (a rate per m²) or by value (a value per m² for every parcel and piece); the scheme allows both.'));
        const cap = capOf(template);
        if (cap && cap.per === 'owner' && (!cap.basis || cap.basis === 'area')) steps.push(t('proposalDrafts.approval.guide.stepContribution', 'Rules › Land contribution: the slider stops at {{percent}}%, the land each owner gives up for public use without compensation; land given up beyond it is compensated, but still counts against the cap.', { percent: percentOf(capRatio(cap)) }));
        steps.push(template.family === 'authority-led'
            ? t('proposalDrafts.approval.guide.stepOutputsNoProposer', 'Output parcels: Public land for roads and public spaces, every other piece to the owner it returns to; Proposer is not available under this scheme.')
            : t('proposalDrafts.approval.guide.stepOutputs', 'Output parcels: Public land for roads and public spaces, the other pieces to the owners or to the Proposer.'));
        const need = regimes().needs(template.tests);
        if (need.leases || need.publicBodies) steps.push(t('proposalDrafts.approval.guide.stepRights', 'Parcel ownership rights: import a rights file (parcel-rights/v2) that lists {{what}}.', {
            what: [need.leases ? t('proposalDrafts.approval.needLeases', 'every lease and its holders') : null,
                need.publicBodies ? t('proposalDrafts.approval.needPublicBodies', 'which holders are public bodies') : null].filter(Boolean).join(t('proposalApproval.rules.and', ' and '))
        }));
        if (template.authorities) steps.push(t('proposalDrafts.approval.guide.stepAuthority', 'Rules › Authority: an id for {{authority}}; a lens member confirms who acts for it and records its decision beside the owners’.', { authority: t(`proposalApproval.schemes.${template.id}.authority`, template.text.authority || 'the authority') }));
        steps.push(t('proposalDrafts.approval.guide.stepPersons', 'Persons: what each person puts in and gets back, land and money; the scheme card in Rules shows this plan against the scheme as you go.'));
        return steps;
    }

    /**
     * The guide's body. `check`: { ok, lines: [{ ok, text }] } as rulesCardHtml takes it; `ledger`:
     * AgreementRecord.ledger of the host's draft (parties with contributedM2, assignedM2 and, by
     * value, the value fields); `rules`: the failing rules of AgreementRecord.schemeCheck, for the fixes.
     */
    function schemeGuideHtml({ template, regime = null, check = null, rules = [], ledger = null, currency = '' } = {}) {
        if (!template) return '';
        const pin = regime && regime.id === template.id ? regime : { id: template.id, version: template.version };
        const policy = regimes().policyOf(template, Array.from({ length: template.authorities }, () => 'authority'));
        const tests = words().orderTests(template.tests).map(test => `<li>${esc(words().testText(test, t))}</li>`).join('');
        const parties = ledger ? ledger.parties.filter(party => !party.areaUnknown && party.contributedM2 > 0).sort((a, b) => b.contributedM2 - a.contributedM2)
            .map(party => ({ ...party, label: party.displayName })) : null;
        const byValue = !!(ledger && ledger.valued);
        const partyRows = parties && parties.length ? `<div class="agreement-table-scroll"><table class="scheme-guide__table"><thead><tr>
            <th scope="col">${esc(t('agreement.workflow.person', 'Person'))}</th><th scope="col">${esc(t('agreement.workflow.putsIn', 'Puts in'))}</th>
            <th scope="col">${esc(t('proposalDrafts.approval.guide.getsBack', 'Gets back'))}</th><th scope="col">${esc(t('proposalDrafts.approval.guide.givesUp', 'Gives up'))}</th></tr></thead>
            <tbody>${parties.map(party => `<tr><th scope="row">${esc(party.displayName)}</th>
                <td>${esc(areaText(party.contributedM2))}${byValue ? `<br><small>${esc(moneyText(party.contributedValueCents, currency))}</small>` : ''}</td>
                <td>${esc(areaText(party.assignedM2))}${byValue ? `<br><small>${esc(moneyText(party.assignedValueCents, currency))}</small>` : ''}</td>
                <td>${esc(`${percentOf(Math.max(0, party.contributedM2 - party.assignedM2) / party.contributedM2)}%`)}</td></tr>`).join('')}</tbody></table></div>` : '';
        const fixes = rules.filter(rule => !rule.ok).map(rule => `<li>${esc(fixText(rule, template, ledger))}</li>`).join('');
        const against = check && check.lines && check.lines.length ? `<section class="scheme-guide__section">
            <h3>${esc(t('proposalDrafts.approval.guide.against', 'This agreement against the scheme'))}</h3>
            <ul class="approval-setup__check" data-scheme-guide-check>${check.lines.map(line => `<li data-check-ok="${line.ok ? 'true' : 'false'}">${esc(line.text)}</li>`).join('')}</ul>
            ${partyRows}${fixes ? `<p class="scheme-guide__fix-title">${esc(t('proposalDrafts.approval.guide.fixes', 'What would meet it'))}</p><ul class="scheme-guide__fixes" data-scheme-guide-fixes>${fixes}</ul>` : ''}
        </section>` : '';
        const sources = template.sources.map(source => `<li><a class="cb-link cb-link--external" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)}</a></li>`).join('');
        return `<div class="scheme-guide" data-scheme-guide="${esc(template.id)}">
            <p class="scheme-guide__meta">${esc(words().familyText(template, t))} · ${esc(words().stageText(template, t))} · ${esc(t('proposalDrafts.approval.guide.checked', 'Rules checked {{date}}', { date: template.version }))}</p>
            <section class="scheme-guide__section">
                <h3>${esc(t('agreement.rule.who', 'Who decides'))}</h3>
                <p>${esc(words().rulesText(policy, t, pin))}</p>
                ${tests ? `<ul>${tests}</ul>` : `<p>${esc(t('proposalApproval.rules.ownersHeard', 'Owners are heard; the authority decides.'))}</p>`}
            </section>
            <section class="scheme-guide__section">
                <h3>${esc(t('proposalDrafts.approval.guide.distribution', 'How land is distributed'))}</h3>
                <p>${esc(t(`proposalApproval.schemes.${template.id}.note`, template.text.note))}</p>
                <ul>${words().allocationLines(template, t).map(line => `<li>${esc(line)}</li>`).join('')}</ul>
                ${schematicSvg(template, parties)}
                <p class="scheme-guide__caption">${esc(schematicCaption(template))}${parties && parties.length ? '' : ' ' + esc(t('proposalDrafts.approval.guide.example', 'Three example owners; with a plan open, the bars show its parties.'))}</p>
            </section>
            ${against}
            <section class="scheme-guide__section">
                <h3>${esc(t('proposalDrafts.approval.guide.setup', 'Set it up here'))}</h3>
                <ol>${setupSteps(template).map(step => `<li>${esc(step)}</li>`).join('')}</ol>
            </section>
            <section class="scheme-guide__section">
                <h3>${esc(t('parcelReport.sources', 'Sources'))}</h3>
                <ul class="scheme-guide__sources">${sources}</ul>
            </section>
        </div>`;
    }

    // The guide as a dialog over the host (`parent`: the host's modal when it has one). Returns the
    // dialog handle, or null without a document.
    function openSchemeGuide({ parent = null, template, regime = null, check = null, rules = [], ledger = null, currency = '' } = {}) {
        const dialogs = root.CbDialog;
        if (!dialogs || !template || typeof root.document === 'undefined') return null;
        const container = root.document.createElement('div');
        container.innerHTML = schemeGuideHtml({ template, regime, check, rules, ledger, currency });
        return dialogs.open({ parent, size: 'lg', title: t(`proposalApproval.schemes.${template.id}.name`, template.text.name), body: container,
            actions: [{ label: t('common.close', 'Close') }] });
    }

    // Custom rules: one row per test, "[at least] [2/3] of the [number] of [owners] [all]".
    function testsEditorHtml(rules) {
        const select = (attribute, label, options, value) => `<select data-approval-rule ${attribute} aria-label="${esc(label)}">${options.map(([key, text]) => option(key, text, value)).join('')}</select>`;
        const rows = rules.tests.map((test, index) => `<div class="approval-setup__test" data-approval-test="${index}">
            ${select('data-approval-test-strict', t('proposalDrafts.approval.testComparison', 'Comparison'), [['false', t('proposalDrafts.approval.atLeast', 'At least')], ['true', t('proposalDrafts.approval.strictlyMore', 'Strictly more than')]], String(test.strict))}
            <input type="text" data-approval-rule data-approval-test-fraction value="${esc(fractionText(test))}" placeholder="1/2" aria-label="${esc(t('proposalDrafts.approval.testFraction', 'Fraction'))}">
            ${select('data-approval-test-measure', t('proposalDrafts.approval.testMeasure', 'What is counted'), [['headcount', t('proposalDrafts.approval.measureHeadcount', 'of the number of')], ['area', t('proposalDrafts.approval.measureArea', 'of the area of')]], test.measure)}
            ${select('data-approval-test-of', t('proposalDrafts.approval.testOf', 'Whose'), [['owners', t('proposalDrafts.approval.ofOwners', 'the owners')], ['leaseholders', t('proposalDrafts.approval.ofLeaseholders', 'the leaseholders')], ['owners+leaseholders', t('proposalDrafts.approval.ofBoth', 'the owners and leaseholders')]], test.of)}
            ${select('data-approval-test-scope', t('proposalDrafts.approval.testScope', 'Which holders'), [['all', t('proposalDrafts.approval.scopeAll', 'all holders')], ['private', t('proposalDrafts.approval.scopePrivate', 'private only')]], test.scope)}
            <button type="button" class="btn btn-sm" data-editor-action="approval-test-remove" data-test-index="${index}">${esc(t('proposalDrafts.approval.removeTest', 'Remove this test'))}</button>
        </div>`).join('');
        return `<div class="approval-setup__tests" data-approval-tests>${rows || `<p>${esc(t('proposalDrafts.approval.noTests', 'No owner test: only the authority decides.'))}</p>`}
            <button type="button" class="btn btn-sm" data-editor-action="approval-test-add"${rules.tests.length >= approval().MAX_TESTS ? ' disabled' : ''}>${esc(t('proposalDrafts.approval.addTest', 'Add a test'))}</button></div>`;
    }

    // `schemeStatus` ({ schemeId: boolean }): which schemes the host's plan meets, marked in the
    // dropdown so a scheme the plan breaks is visible before it is chosen; `schemeCheck`: the
    // chosen scheme's rules against the plan, listed in its card.
    function rulesCardHtml(normalized, schemeStatus = null, schemeCheck = null) {
        const policy = normalized?.policy || { type: 'unanimous' };
        const choice = ruleChoice(normalized);
        let rules = { tests: [], authorities: [] };
        try { rules = approval().policyRules(policy); } catch (_) { /* the config error is shown above */ }
        const template = choice !== 'unanimous' && choice !== 'custom'
            ? (normalized.regime ? regimes().get(normalized.regime.id, normalized.regime.version) : null) || regimes().latest(choice) : null;
        const notMet = t('proposalDrafts.approval.schemeNotMet', 'not met by this plan');
        const groups = regimes().FAMILIES.map(family => {
            const entries = latestRegimes().filter(regime => regime.family === family);
            return entries.length ? `<optgroup label="${esc(words().familyText({ family }, t))}">${entries.map(regime => {
                const met = schemeStatus && Object.hasOwn(schemeStatus, regime.id) ? schemeStatus[regime.id] !== false : null;
                const name = t(`proposalApproval.schemes.${regime.id}.name`, regime.text.name);
                return `<option value="${esc(regime.id)}"${regime.id === choice ? ' selected' : ''}${met === null ? '' : ` data-scheme-met="${met}"`}>${esc(met === false ? `${name} — ${notMet}` : name)}</option>`;
            }).join('')}</optgroup>` : '';
        }).join('');
        const authorityIds = rules.authorities.map(row => row.authorityId);
        const authorityField = (index, value) => `<label class="proposal-editor-field"><span>${esc(t('proposalDrafts.approval.authorityId', 'Authority (an abstract id; a lens member confirms who acts for it)'))}</span><input type="text" data-approval-rule data-approval-authority-id="${index}" value="${esc(value)}" autocomplete="off"></label>`;
        let authorityHtml = '';
        if (template?.authorities) {
            authorityHtml = Array.from({ length: template.authorities }, (_, index) => authorityField(index, authorityIds[index] || DEFAULT_AUTHORITY)).join('');
        } else if (choice === 'custom') {
            authorityHtml = `<label class="proposal-editor-check"><input type="checkbox" data-approval-rule data-approval-custom-authority${authorityIds.length ? ' checked' : ''}> ${esc(t('proposalDrafts.approval.customAuthority', 'An authority must also approve'))}</label>`
                + (authorityIds.length ? authorityField(0, authorityIds[0]) : '');
        }
        return `<div class="proposal-editor-card" data-approval-rules-card>
            <label class="proposal-editor-field"><span class="approval-setup__rules-label"><span>${esc(t('proposalDrafts.approval.policyType', 'Rules'))}</span><span class="cb-badge cb-badge--warning" data-approval-experimental>${esc(t('proposalDrafts.approval.experimental', 'Experimental'))}</span></span><select data-approval-rule data-approval-regime>
                ${option('unanimous', t('proposalDrafts.approval.unanimous', 'Every owner must agree'), choice)}${option('custom', t('proposalDrafts.approval.threshold', 'Custom rules'), choice)}${groups}
            </select></label>
            <p class="approval-setup__rule" data-approval-rule-text>${esc(policyText(policy, normalized?.regime))}</p>
            ${template ? regimeDetailsHtml(template, normalized?.regime, schemeCheck) : ''}
            ${choice === 'custom' ? testsEditorHtml(rules) : ''}
            ${authorityHtml}
        </div>`;
    }

    // The rules the form shows, as { policy, regime }. A control the form does not show yet (the test
    // rows right after switching to Custom, the authority id right after choosing a scheme) is taken
    // from the current config, so switching never loses what was there.
    function rulesFromForm(container, current) {
        const choice = container?.querySelector('[data-approval-regime]')?.value || ruleChoice(current);
        let currentRules = { tests: [], authorities: [] };
        try { currentRules = approval().policyRules(current?.policy); } catch (_) { /* replaced below */ }
        const typedIds = [...(container?.querySelectorAll?.('[data-approval-authority-id]') || [])].map(input => String(input.value || '').trim()).filter(Boolean);
        const authorityIds = typedIds.length ? typedIds : currentRules.authorities.map(row => row.authorityId);
        if (choice === 'unanimous') return { policy: { type: 'unanimous' }, regime: null };
        if (choice === 'custom') {
            const rows = [...(container?.querySelectorAll?.('[data-approval-test]') || [])];
            const editing = !!container?.querySelector?.('[data-approval-tests]');
            let tests = editing ? rows.map(row => ({
                measure: row.querySelector('[data-approval-test-measure]')?.value,
                of: row.querySelector('[data-approval-test-of]')?.value,
                scope: row.querySelector('[data-approval-test-scope]')?.value,
                strict: row.querySelector('[data-approval-test-strict]')?.value === 'true',
                ...parseFraction(row.querySelector('[data-approval-test-fraction]')?.value)
            })) : currentRules.tests;
            // "Every owner must agree" is itself a rule (all of the owners), and stored as such; custom
            // rules chosen from it start from the usual majority, so the dropdown does not snap back.
            const unanimousTest = tests.length === 1 && tests[0].measure === 'headcount' && tests[0].of === 'owners' && tests[0].scope === 'all'
                && tests[0].numerator === tests[0].denominator && !tests[0].strict;
            if (!editing && unanimousTest && !currentRules.authorities.length) {
                tests = [{ measure: 'headcount', of: 'owners', scope: 'all', numerator: 1, denominator: 2, strict: false },
                    { measure: 'area', of: 'owners', scope: 'all', numerator: 7, denominator: 10, strict: false }];
            }
            const box = container?.querySelector?.('[data-approval-custom-authority]');
            const wantsAuthority = box ? box.checked === true : currentRules.authorities.length > 0;
            return { policy: { type: 'rules', tests, authorities: wantsAuthority ? [{ authorityId: authorityIds[0] || DEFAULT_AUTHORITY }] : [] }, regime: null };
        }
        const template = current?.regime?.id === choice ? regimes().get(choice, current.regime.version) : regimes().latest(choice);
        if (!template) throw new Error(t('proposalDrafts.approval.unknownRegime', 'Unknown agreement rules.'));
        const ids = Array.from({ length: template.authorities }, (_, index) => authorityIds[index] || DEFAULT_AUTHORITY);
        return { policy: regimes().policyOf(template, ids), regime: { id: template.id, version: template.version } };
    }

    // Add or remove a custom test. The new test is the first kind the rules do not count yet.
    function withRuleAction(container, config, action, index) {
        const current = normalizedConfig(config);
        const { policy } = rulesFromForm(container, current);
        const tests = policy.type === 'rules' ? policy.tests.slice() : approval().policyRules(policy).tests;
        if (action === 'approval-test-remove') tests.splice(Number(index), 1);
        if (action === 'approval-test-add') {
            const used = new Set(tests.map(test => `${test.measure}:${test.of}:${test.scope}`));
            const kinds = [['area', 'owners'], ['headcount', 'owners'], ['headcount', 'leaseholders'], ['area', 'owners+leaseholders'], ['headcount', 'owners+leaseholders'], ['area', 'leaseholders']];
            const next = ['all', 'private'].flatMap(scope => kinds.map(([measure, of]) => ({ measure, of, scope })))
                .find(test => !used.has(`${test.measure}:${test.of}:${test.scope}`));
            if (next) tests.push({ ...next, numerator: 1, denominator: 2, strict: false });
        }
        const authorities = policy.type === 'rules' ? policy.authorities : [];
        return approval().normalizeConfig({ ...current, policy: { type: 'rules', tests, authorities }, regime: null });
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

    // The config with the rules the form now shows. Throws on a malformed fraction or rule, leaving
    // the caller's config untouched.
    function withPolicyFromForm(container, config) {
        const current = normalizedConfig(config);
        const { policy, regime } = rulesFromForm(container, current);
        const { regime: _old, ...rest } = current;
        return approval().normalizeConfig({ ...rest, policy, ...(regime ? { regime } : {}) });
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

    // A rights file to fill in; it has room for leases and public bodies when the rules count them.
    function downloadTemplate(parcelIds, config = null) {
        const api = approval();
        if (!api?.createTemplate || !root.Blob || !root.URL?.createObjectURL || !root.document) return;
        let need = { leases: false, publicBodies: false };
        try { need = regimes().needs(api.policyRules(normalizedConfig(config)?.policy).tests); } catch (_) { /* a plain template */ }
        const template = api.createTemplate(parcelIds || [], need);
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
            // Only switching the rules or the custom authority changes which fields exist. Re-rendering
            // on every other edit would replace the field the author has just moved into; those are
            // read on apply, and the rule sentence follows them.
            if (!event.target.closest('[data-approval-regime], [data-approval-custom-authority]')) {
                if (event.target.closest('[data-approval-rule]')) {
                    try {
                        const preview = withPolicyFromForm(dialog.body, state.approvalConfig);
                        const line = dialog.body.querySelector('[data-approval-rule-text]');
                        if (line) line.textContent = policyText(preview.policy, preview.regime);
                    } catch (_) { /* reported on apply */ }
                }
                return;
            }
            try { readForm(); state.error = null; } catch (error) { state.error = error?.message || String(error); }
            render();
        });
        dialog.body.addEventListener('click', async event => {
            const action = event.target.closest('[data-editor-action]')?.dataset.editorAction;
            if (!action) return;
            event.preventDefault();
            // Keep what was typed in the other fields across the re-render an import causes.
            try { readForm(); } catch (_) { /* the lens is kept; a bad fraction is reported on apply */ }
            if (action === 'approval-template') { downloadTemplate(cadastreParcelIds, state.approvalConfig); return; }
            if (action === 'approval-test-add' || action === 'approval-test-remove') {
                try { state.approvalConfig = withRuleAction(dialog.body, state.approvalConfig, action, event.target.closest('[data-test-index]')?.dataset.testIndex); state.error = null; }
                catch (error) { state.error = error?.message || String(error); }
                render();
                return;
            }
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

    return { schemeGuideHtml, openSchemeGuide, schematicCaption,
        openDialog,
        html, previewHtml, summaryText, policyText, fractionText, parseFraction, lensKeys, lensFromText,
        normalizedConfig, syncSourceControls, withPolicyFromForm, withRuleAction, ruleChoice, lensFromForm, importRights, withoutRights, downloadTemplate
    };
});
