// The agreement editor (plan-design-agreement.md, M1 (b); docked on the right of the map since the UI
// decision of 2026-10-22, "M3 notes"): Create / Edit agreement as a panel on the right dock (a bottom
// sheet on a phone) in place of the agreement panel, so the map stays in view. One scrolling column
// over the designs applied to the map — which designs, the land they take and the pieces they leave,
// who receives each piece, the cash per party with the sponsor's line, the decision rule, a title and
// a deadline — with Cancel and Save at the bottom. The map is the main picker (js/map-pick.js): the
// chosen designs are highlighted, and a click on an applied design adds or removes it. Save validates
// and stores the agreement on this device (agreement-store.js) and opens its panel; Cancel discards
// and brings back the panel the editor replaced. addDesign() is the details panel's "Add to agreement":
// a new agreement, or one not proposed yet.
//
// The branching lives in the pure helpers exported below (the record built from the form, the
// allocation options, the terms kept across a new derivation, the sponsor line, the HTML of each
// section), tested headlessly in backend/test/agreement-store.test.js; open() is the thin browser layer.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.AgreementDialog = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SCHEMA = 'agreement/v1';
    const APPROVAL_SCHEMA = 'proposal-approval/v1';
    // The provider of the default rights snapshot, built from the local owner records of the inputs.
    const LOCAL_RIGHTS_PROVIDER = 'local-owners';

    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());
    const isNumber = value => typeof value === 'number' && Number.isFinite(value);
    const setup = () => root.ProposalApprovalSetup;
    const emptyLand = () => ({ inputs: { parcels: [], openGroundM2: 0 }, outputs: [] });

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

    // ---- formatting (js/format.js in the browser) ------------------------------------------------

    function areaText(m2) {
        if (!isNumber(m2)) return '—';
        const format = root.CbFormat;
        return format && typeof format.formatArea === 'function' ? format.formatArea(m2) : `${Math.round(m2)} m²`;
    }

    function shareText(share) {
        if (!isNumber(share)) return '';
        const format = root.CbFormat;
        return format && typeof format.formatPercent === 'function' ? format.formatPercent(share) : `${Math.round(share * 100)}%`;
    }

    function moneyText(cents, currency) {
        const fraction = cents % 100 !== 0;
        const format = root.CbFormat;
        return format && typeof format.formatMoney === 'function'
            ? format.formatMoney(cents / 100, currency, { maxFractionDigits: 2, minFractionDigits: fraction ? 2 : 0 })
            : `${(cents / 100).toFixed(fraction ? 2 : 0)} ${currency}`;
    }

    // "Ana 50%, Ben 50%", or that nobody is recorded.
    function holdersText(holders) {
        const list = Array.isArray(holders) ? holders.filter(holder => holder && idOf(holder.ownerKey)) : [];
        if (!list.length) return t('agreement.land.unowned', 'No recorded owner');
        return list.map(holder => `${holder.displayName || holder.ownerKey} ${shareText(holder.share)}`.trim()).join(', ');
    }

    // ---- designs ---------------------------------------------------------------------------------

    // The designs an agreement can take: the applied ones, in authored order (the order they apply in).
    function appliedDesigns(records, { isApplied, orderFormations } = {}) {
        if (typeof isApplied !== 'function') throw new TypeError('appliedDesigns needs isApplied.');
        const applied = (Array.isArray(records) ? records : []).filter(record => record && idOf(record.proposalId) && isApplied(record));
        return typeof orderFormations === 'function' ? orderFormations(applied) : applied;
    }

    function designTitle(record) {
        return (record && (record.title || record.name)) || t('modal.roadWidth.proposalList.untitled', 'Untitled proposal');
    }

    function typeLabelOf(record) {
        const goals = root.ProposalDesignGoals;
        const key = goals && typeof goals.keyOf === 'function' ? goals.keyOf(record) : null;
        return key && typeof root.formatProposalTypeLabel === 'function' ? root.formatProposalTypeLabel(key) : '';
    }

    // The cadastral ids the designs take: what each declares plus the cadastral ids of the pieces the
    // fabric says it produced, read as AgreementGround.derive reads them. Sorted, so the same designs
    // always ask for the same ground.
    function inputParcelIds(designs, fabric) {
        const ids = new Set();
        const addAll = list => (Array.isArray(list) ? list : []).forEach(id => { if (idOf(id)) ids.add(idOf(id)); });
        (Array.isArray(designs) ? designs : []).forEach(design => {
            if (!design) return;
            addAll(design.cadastreParcelIds);
            const pieces = fabric && typeof fabric.producedBy === 'function' ? fabric.producedBy(design.proposalId) : [];
            (pieces || []).forEach(piece => addAll(piece && piece.properties && piece.properties.cadastreParcelIds));
        });
        return Array.from(ids).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    // The original cadastral features (CadastralParcelRepository.ensureIds(...).features) by id, as
    // AgreementGround.derive looks them up. `featureIdOf` is the fabric's id rule when there is one.
    function originalsById(features, featureIdOf) {
        const identify = typeof featureIdOf === 'function' ? featureIdOf : feature => {
            const props = (feature && feature.properties) || {};
            return props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id;
        };
        const byId = new Map();
        (Array.isArray(features) ? features : []).forEach(feature => {
            const id = idOf(identify(feature));
            if (id && !byId.has(id)) byId.set(id, feature);
        });
        return byId;
    }

    // ---- land, allocation, money -----------------------------------------------------------------

    // The parties: every holder of an input parcel, once, in the order they first appear.
    function partiesOf(inputs) {
        const parties = new Map();
        (inputs && Array.isArray(inputs.parcels) ? inputs.parcels : []).forEach(parcel => {
            (parcel && Array.isArray(parcel.holders) ? parcel.holders : []).forEach(holder => {
                const ownerKey = idOf(holder && holder.ownerKey);
                if (ownerKey && !parties.has(ownerKey)) parties.set(ownerKey, { ownerKey, displayName: (holder.displayName && String(holder.displayName)) || ownerKey });
            });
        });
        return Array.from(parties.values());
    }

    // What one resulting piece can go to: its current holders (the default), one input party, or the public.
    function allocationOptions(inputs) {
        return [
            { value: 'holders', label: t('agreement.allocation.holders', 'Current holders') },
            ...partiesOf(inputs).map(party => ({ value: `party:${party.ownerKey}`, label: party.displayName })),
            { value: 'public', label: t('agreement.allocation.public', 'Public') }
        ];
    }

    // An allocation line's `to` as a select value, and back. "holders" is no line at all: an output
    // without a line keeps its carried-over holding.
    function allocationValue(to) {
        if (!to || typeof to !== 'object') return 'holders';
        if (to.kind === 'public') return 'public';
        if (to.kind === 'party' && idOf(to.ownerKey)) return `party:${idOf(to.ownerKey)}`;
        return 'holders';
    }

    function allocationTo(value) {
        const text = idOf(value);
        if (text === 'public') return { kind: 'public' };
        if (text.startsWith('party:') && text.length > 'party:'.length) return { kind: 'party', ownerKey: text.slice('party:'.length) };
        return null;
    }

    // Typed amounts → cents: empty is no line (null); anything that is not an amount is NaN, so the
    // validation names it instead of the line vanishing.
    function cashCents(text) {
        const value = String(text ?? '').trim();
        if (!value) return null;
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value)) return NaN;
        return Math.round(Number(value) * 100);
    }

    const centsText = cents => (isNumber(cents) ? String(cents / 100) : '');

    // A number field the browser cannot read reports an empty value; it is kept as unreadable instead.
    const cashInputText = input => (input && input.validity && input.validity.badInput ? 'invalid' : String(input && input.value || ''));

    // A stored agreement's allocations and cash as the form's values.
    function termsOf(agreement) {
        const allocations = {};
        (agreement && Array.isArray(agreement.allocations) ? agreement.allocations : []).forEach(line => {
            const value = allocationValue(line && line.to);
            if (line && idOf(line.output) && value !== 'holders') allocations[idOf(line.output)] = value;
        });
        const cash = {};
        (agreement && agreement.money && Array.isArray(agreement.money.lines) ? agreement.money.lines : []).forEach(line => {
            if (line && idOf(line.ownerKey) && isNumber(line.amountCents)) cash[idOf(line.ownerKey)] = centsText(line.amountCents);
        });
        return { allocations, cash };
    }

    // What survives a new derivation of the land: allocations of pieces that still exist, to parties
    // that still hold input land, and the readable cash of those parties. The rest is dropped.
    function keptTerms({ allocations = {}, cash = {} } = {}, land) {
        const hashes = new Set((land && Array.isArray(land.outputs) ? land.outputs : []).map(output => output && output.hash));
        const parties = new Set(partiesOf(land && land.inputs).map(party => party.ownerKey));
        const keptAllocations = {};
        Object.keys(allocations || {}).forEach(hash => {
            const to = allocationTo(allocations[hash]);
            if (!to || !hashes.has(hash)) return;
            if (to.kind === 'party' && !parties.has(to.ownerKey)) return;
            keptAllocations[hash] = allocations[hash];
        });
        const keptCash = {};
        Object.keys(cash || {}).forEach(ownerKey => {
            const cents = cashCents(cash[ownerKey]);
            if (parties.has(ownerKey) && cents !== null && !Number.isNaN(cents)) keptCash[ownerKey] = cash[ownerKey];
        });
        return { allocations: keptAllocations, cash: keptCash };
    }

    // The sponsor's line of a money schedule (AgreementRecord.ledger(...).money, the schedule of
    // ReparcellizationDeal): + receives, − pays, like the parties. null when it cannot be read.
    function sponsorLine(money, currency) {
        if (!money || !isNumber(money.sponsorCents)) return null;
        const lines = Array.isArray(money.lines) ? money.lines : [];
        const moving = lines.some(line => line && line.party !== 'sponsor' && isNumber(line.amountCents) && line.amountCents !== 0);
        const cents = money.sponsorCents;
        if (cents < 0) return { kind: 'funds', cents: -cents, text: t('agreement.money.sponsorFunds', 'Sponsor funds {{amount}}', { amount: moneyText(-cents, currency) }) };
        if (cents > 0) return { kind: 'receives', cents, text: t('agreement.money.sponsorReceives', 'Sponsor receives {{amount}}', { amount: moneyText(cents, currency) }) };
        if (!moving) return { kind: 'balanced', cents: 0, text: t('agreement.money.balanced', 'No money moves.') };
        return { kind: 'covered', cents: 0, text: t('agreement.money.sponsorNothing', 'The parties’ payments balance; the sponsor pays nothing.') };
    }

    // ---- decision rule ---------------------------------------------------------------------------

    // The rule's rights after the land is derived again: the default snapshot of the local owners
    // follows the land; rights imported from a file or a source are the author's and stay.
    function ruleConfigAfterDerive(config, inputs, rightsFromInputs) {
        if (typeof rightsFromInputs !== 'function') throw new TypeError('ruleConfigAfterDerive needs rightsFromInputs.');
        if (!config) return { schema: APPROVAL_SCHEMA, rights: rightsFromInputs(inputs), policy: { type: 'unanimous' } };
        const provider = config.rights && config.rights.source ? config.rights.source.provider : null;
        if (config.rights && provider !== LOCAL_RIGHTS_PROVIDER) return config;
        return { ...config, rights: rightsFromInputs(inputs) };
    }

    // ---- details ---------------------------------------------------------------------------------

    // A date field's day → the end of that day in local time, as ISO; a day that is not one stays as
    // typed so the validation names it. An ISO deadline → its local day for the field.
    function deadlineFromDate(text) {
        const value = String(text ?? '').trim();
        if (!value) return null;
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) return value;
        const [year, month, day] = match.slice(1).map(Number);
        const date = new Date(year, month - 1, day, 23, 59, 59, 999);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return value;
        return date.toISOString();
    }

    function dateFromDeadline(deadline) {
        if (!deadline) return '';
        const date = new Date(deadline);
        if (Number.isNaN(date.getTime())) return '';
        const pad = number => String(number).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    // ---- the record ------------------------------------------------------------------------------

    /**
     * The agreement the form describes (plan-design-agreement.md, M1 (b) record).
     * state: { id, createdAt?, updatedAt?, city?, designs (the chosen records, authored order),
     *   fingerprints (Map proposalId → design CID), land ({ inputs, outputs } from AgreementGround.derive),
     *   approvalConfig, lens, currency (the agreement's city's money) }
     * values: { allocations ({ outputHash: select value }), cash ({ ownerKey: typed amounts }),
     *   electorate ('owners' | 'community'), binding, title, deadline (the date field's day),
     *   organiser (website or did:web), participationUrl (HTTPS) }
     */
    function recordFromForm(state = {}, values = {}) {
        const land = state.land || emptyLand();
        const inputs = land.inputs || emptyLand().inputs;
        const outputs = Array.isArray(land.outputs) ? land.outputs : [];
        const fingerprints = state.fingerprints instanceof Map ? state.fingerprints : new Map(Object.entries(state.fingerprints || {}));
        const records = Array.isArray(state.designs) ? state.designs.filter(Boolean) : [];
        const chosen = values.allocations || {};
        const cash = values.cash || {};
        const owners = values.electorate !== 'community';
        const title = String(values.title ?? '').trim();
        return {
            schema: SCHEMA,
            id: idOf(state.id),
            title: title || null,
            // The designs' city (the city id a published design carries), so an agreement and its
            // designs name the city the same way; the view's short code only when there is no design.
            city: (records[0] && records[0].city) || state.city || null,
            createdAt: state.createdAt || null,
            updatedAt: state.updatedAt || null,
            designs: records.map(record => ({
                proposalId: idOf(record.proposalId),
                title: designTitle(record),
                goal: typeof record.goal === 'string' ? record.goal : null,
                cid: fingerprints.get(idOf(record.proposalId)) || null
            })),
            inputs: { parcels: Array.isArray(inputs.parcels) ? inputs.parcels : [], openGroundM2: isNumber(inputs.openGroundM2) ? inputs.openGroundM2 : 0 },
            outputs,
            allocations: owners ? outputs.map(output => ({ output: output.hash, to: allocationTo(chosen[output.hash]) })).filter(line => line.to) : [],
            money: {
                currency: state.currency || null,
                lines: (owners ? partiesOf(inputs) : []).map(party => ({ ownerKey: party.ownerKey, amountCents: cashCents(cash[party.ownerKey]) }))
                    .filter(line => line.amountCents !== null && line.amountCents !== 0)
            },
            rule: owners
                ? { electorate: 'owners', binding: values.binding === true, approvalConfig: state.approvalConfig || null, lens: Array.isArray(state.lens) ? state.lens.slice() : [] }
                : { electorate: 'community', binding: false, approvalConfig: null, lens: [] },
            consultation: owners ? null : { organiser: values.organiser || null, participationUrl: values.participationUrl || null },
            deadline: deadlineFromDate(values.deadline)
        };
    }

    // ---- errors and warnings ---------------------------------------------------------------------

    // One literal key per code (agreement.errors.<camelCaseCode>, agreement.warnings.<camelCaseCode>),
    // so the locale coverage test sees every one of them.
    const ISSUE_TEXT = {
        'no-designs': () => t('agreement.errors.noDesigns', 'Choose at least one design.'),
        'design-not-applied': () => t('agreement.errors.designNotApplied', 'Every design must be applied to the map.'),
        'no-inputs': () => t('agreement.errors.noInputs', 'The designs take no cadastral land.'),
        'allocation-unknown-output': () => t('agreement.errors.allocationUnknownOutput', 'An allocation names a piece that no longer exists.'),
        'allocation-unknown-party': () => t('agreement.errors.allocationUnknownParty', 'An allocation names a party that holds no input land.'),
        'allocation-shares-invalid': () => t('agreement.errors.allocationSharesInvalid', 'Joint shares must sum to 100 %.'),
        'money-currency': () => t('agreement.errors.moneyCurrency', 'Money must be in the currency of the agreement\'s city.'),
        'money-party-unknown': () => t('agreement.errors.moneyPartyUnknown', 'A cash line names a party that holds no input land.'),
        'money-amount-invalid': () => t('agreement.errors.moneyAmountInvalid', 'A cash amount is not a valid amount.'),
        'community-allocations': () => t('agreement.errors.communityAllocations', 'A community consultation cannot allocate land.'),
        'community-money': () => t('agreement.errors.communityMoney', 'A community consultation cannot include cash payments.'),
        'consultation-organiser': () => t('agreement.errors.consultationOrganiser', 'Enter an organiser website or a valid did:web identifier.'),
        'consultation-participation-url': () => t('agreement.errors.consultationParticipationUrl', 'Enter an HTTPS participation URL without credentials.'),
        'rule-invalid': reason => t('agreement.errors.ruleInvalid', 'The decision rule is incomplete: {{reason}}', { reason }),
        'rule-community-binding': () => t('agreement.errors.ruleCommunityBinding', 'A community vote cannot be binding.'),
        'deadline-invalid': () => t('agreement.errors.deadlineInvalid', 'The deadline must be a date in the future.'),
        'secondary-tab': () => t('agreement.errors.secondaryTab', 'Another tab holds this city’s data; agreements can be edited there only.'),
        'rule-not-ready': reason => t('agreement.warnings.ruleNotReady', 'The rule cannot be evaluated yet: {{reason}}', { reason }),
        'rule-lens-missing': () => t('agreement.warnings.ruleLensMissing', 'No lens member is named, so no owner decision can be verified.'),
        'open-ground': () => t('agreement.warnings.openGround', 'Part of the land is open ground with no recorded owner.')
    };
    const NEEDS_REASON = new Set(['rule-invalid', 'rule-not-ready']);

    // The approval engine's readiness reasons (ProposalApproval.inspect), worded as the approval form words them.
    const REASON_TEXT = {
        'missing-rights': () => t('proposalDrafts.approval.reason.missingRights', 'No ownership rights dataset is loaded.'),
        'missing-parcels': () => t('proposalDrafts.approval.reason.missingParcels', 'Select parcels to check ownership data.'),
        'incomplete-rights': () => t('proposalDrafts.approval.reason.incompleteRights', 'Ownership data is incomplete for one or more selected parcels.'),
        'missing-owners': () => t('proposalDrafts.approval.reason.missingOwners', 'No owners are declared for the selected parcels.'),
        'authority-is-holder': () => t('proposalDrafts.approval.reason.authorityIsHolder', 'An authority id is also a rights holder; give the authority its own id.')
    };

    // An error or warning of AgreementRecord.validate ({ code, message, reason? }) in the UI language.
    // A code this dialog does not know shows the validator's own message.
    function issueText(issue) {
        const code = idOf(issue && issue.code);
        const word = ISSUE_TEXT[code];
        if (!word) return idOf(issue && issue.message) || code;
        if (!NEEDS_REASON.has(code)) return word();
        // The engine's readiness code when there is one (rule-not-ready), else the validator's own
        // words (an invalid rule says what is wrong with it).
        const reason = idOf(issue.reason ?? (issue.params && issue.params.reason) ?? issue.message);
        if (!reason) return word('').replace(/[:\s]+$/, '');
        return word(REASON_TEXT[reason] ? REASON_TEXT[reason]() : reason);
    }

    function issuesHtml(issues) {
        return (Array.isArray(issues) ? issues : []).filter(Boolean)
            .map(issue => `<li data-agreement-issue="${esc(idOf(issue.code))}">${esc(issueText(issue))}</li>`).join('');
    }

    // ---- the sections ----------------------------------------------------------------------------

    function sectionHtml(name, title, content, hidden = false) {
        return `<section class="agreement-section" data-agreement-section="${esc(name)}"${hidden ? ' hidden' : ''}><h3 class="agreement-section__title">${esc(title)}</h3>${content}</section>`;
    }

    // The checklist of applied designs. `missing` are designs the agreement names that are no longer applied.
    function designsHtml({ designs = [], selected = [], missing = [] } = {}) {
        const chosen = new Set(Array.from(selected || [], idOf));
        const hint = `<p class="agreement-hint">${esc(t('agreement.designs.hint', 'Only designs applied to the map can be part of an agreement.'))}</p>`;
        const gone = missing && missing.length
            ? `<p class="agreement-notice" data-agreement-designs-missing>${esc(t('agreement.errors.designNotApplied', 'Every design must be applied to the map.'))}</p>`
            : '';
        if (!designs.length) return `${hint}${gone}<p class="agreement-hint" data-agreement-empty>${esc(t('agreement.designs.empty', 'No applied designs. Apply a design first.'))}</p>`;
        // The map is the main picker (js/map-pick.js); the line under the hint says what a click did.
        const mapHint = `<p class="agreement-hint" data-agreement-map-hint>${esc(t('agreement.designs.mapHint', 'Click a design on the map to add or remove it'))}</p>`
            + '<p class="agreement-hint agreement-pick-status" data-agreement-pick-status role="status" aria-live="polite"></p>';
        const rows = designs.map(record => {
            const id = idOf(record.proposalId);
            const type = typeLabelOf(record);
            return `<li><label class="agreement-design-row"><input type="checkbox" data-agreement-design="${esc(id)}"${chosen.has(id) ? ' checked' : ''}> `
                + `<span class="agreement-design-row__title">${esc(designTitle(record))}</span>`
                + (type ? ` <span class="cb-badge cb-badge--neutral agreement-design-row__type">${esc(type)}</span>` : '')
                + '</label></li>';
        }).join('');
        return `${hint}${gone}<ul class="agreement-design-list">${rows}</ul>${mapHint}`;
    }

    function inputsTableHtml(parcels) {
        const rows = parcels.map(parcel => `<tr data-agreement-input="${esc(parcel.parcelId)}"><th scope="row">${esc(parcel.parcelId)}</th>`
            + `<td class="agreement-table__number">${esc(areaText(parcel.areaM2))}</td><td class="agreement-table__holders">${esc(holdersText(parcel.holders))}</td></tr>`).join('');
        return `<div class="agreement-table-scroll"><table class="agreement-table" data-agreement-inputs>`
            + `<caption>${esc(t('agreement.land.inputsHeading', 'Input parcels'))}</caption>`
            + `<thead><tr><th scope="col">${esc(t('agreement.land.parcel', 'Parcel'))}</th><th scope="col" class="agreement-table__number">${esc(t('agreement.land.area', 'Area'))}</th>`
            + `<th scope="col">${esc(t('agreement.land.holders', 'Holders'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function outputsTableHtml(outputs) {
        const from = t('agreement.land.from', 'From');
        const rows = outputs.map((output, index) => `<tr data-agreement-output="${esc(output.hash)}"><th scope="row">${esc(`${t('agreement.land.piece', 'Piece')} ${index + 1}`)}</th>`
            + `<td class="agreement-table__from" data-label="${esc(from)}">${esc((Array.isArray(output.fromParcelIds) ? output.fromParcelIds : []).join(', '))}</td>`
            + `<td class="agreement-table__number">${esc(areaText(output.areaM2))}</td><td class="agreement-table__holders">${esc(holdersText(output.holders))}</td></tr>`).join('');
        return `<div class="agreement-table-scroll"><table class="agreement-table" data-agreement-outputs>`
            + `<caption>${esc(t('agreement.land.outputsHeading', 'Resulting pieces'))}</caption>`
            + `<thead><tr><th scope="col">${esc(t('agreement.land.piece', 'Piece'))}</th><th scope="col">${esc(t('agreement.land.from', 'From'))}</th>`
            + `<th scope="col" class="agreement-table__number">${esc(t('agreement.land.area', 'Area'))}</th><th scope="col">${esc(t('agreement.land.holders', 'Holders'))}</th></tr></thead>`
            + `<tbody>${rows}</tbody></table></div>`;
    }

    // The land: the input parcels and what stands on them after the designs, or why there is none yet.
    function landHtml({ land, loading = false, error = null, selectedCount = 0 } = {}) {
        if (loading) return `<p class="agreement-hint" role="status" data-agreement-land-loading>${esc(t('agreement.land.loading', 'Reading the land under the designs…'))}</p>`;
        if (error) return `<p class="agreement-alert" role="alert" data-agreement-land-error>${esc(t('agreement.land.failed', 'The land under the designs could not be read: {{reason}}', { reason: error }))}</p>`;
        if (!selectedCount) return `<p class="agreement-hint">${esc(t('agreement.errors.noDesigns', 'Choose at least one design.'))}</p>`;
        const view = land || emptyLand();
        const parcels = view.inputs && Array.isArray(view.inputs.parcels) ? view.inputs.parcels : [];
        const openGround = view.inputs ? view.inputs.openGroundM2 : 0;
        const outputs = Array.isArray(view.outputs) ? view.outputs : [];
        return (parcels.length ? inputsTableHtml(parcels) : `<p class="agreement-hint" data-agreement-land-empty>${esc(t('agreement.land.empty', 'The selected designs take no cadastral land.'))}</p>`)
            + (isNumber(openGround) && openGround > 0
                ? `<p class="agreement-hint" data-agreement-open-ground>${esc(t('agreement.land.openGround', 'Open ground: {{area}}', { area: areaText(openGround) }))}</p>` : '')
            + (outputs.length ? outputsTableHtml(outputs) : '');
    }

    // One select per resulting piece, each under the piece it names (a list, so it stays usable at
    // the dock's width and on a phone).
    function allocationHtml(land, allocations = {}) {
        const outputs = land && Array.isArray(land.outputs) ? land.outputs : [];
        if (!outputs.length) return '';
        const options = allocationOptions(land.inputs);
        const known = new Set(options.map(option => option.value));
        const rows = outputs.map((output, index) => {
            const value = known.has(allocations[output.hash]) ? allocations[output.hash] : 'holders';
            return `<li><label class="agreement-allocation-row"><span class="agreement-allocation-row__piece">${esc(`${t('agreement.land.piece', 'Piece')} ${index + 1} · ${areaText(output.areaM2)}`)}</span>`
                + `<select data-agreement-allocation="${esc(output.hash)}">${options.map(option => `<option value="${esc(option.value)}"${option.value === value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label></li>`;
        }).join('');
        return `<ul class="agreement-allocation-list">${rows}</ul>`;
    }

    // One cash field per party, in the agreement's currency.
    function moneyHtml(land, cash = {}, currency = '') {
        const parties = partiesOf(land && land.inputs);
        if (!parties.length) return '';
        const shown = text => (Number.isNaN(cashCents(text)) ? '' : String(text ?? ''));
        return `<div class="agreement-column-head"><span>${esc(t('agreement.money.party', 'Party'))}</span><span>${esc(t('agreement.money.amount', 'Amount ({{currency}})', { currency }))}</span></div>`
            + parties.map(party => `<label class="agreement-money-row"><span class="agreement-money-row__name">${esc(party.displayName)}</span>`
                + `<input type="number" step="0.01" data-agreement-cash="${esc(party.ownerKey)}" value="${esc(shown(cash[party.ownerKey]))}"></label>`).join('');
    }

    // Who decides, whether it binds, and the owners' rules (filled by the browser layer).
    function ruleHtml({ electorate = 'owners', binding = true } = {}) {
        const owners = electorate !== 'community';
        const radio = (value, label) => `<label class="proposal-editor-check"><input type="radio" name="agreement-electorate" value="${value}" data-agreement-electorate${(value === 'owners') === owners ? ' checked' : ''}> ${esc(label)}</label>`;
        return `<fieldset class="agreement-fieldset"><legend>${esc(t('agreement.rule.who', 'Who decides'))}</legend>`
            + radio('owners', t('agreement.rule.owners', 'Seek owners’ decisions'))
            + radio('community', t('agreement.rule.community', 'Ask the community'))
            + '</fieldset>'
            + `<label class="proposal-editor-check" data-agreement-binding-control${owners ? '' : ' hidden'}><input type="checkbox" data-agreement-binding${owners && binding ? ' checked' : ''}${owners ? '' : ' disabled'}> ${esc(t('agreement.rule.binding', 'Binding: when the rule is met, land and money move at execution'))}</label>`
            + `<div class="agreement-rule-form" data-agreement-rule-form${owners ? '' : ' hidden'}></div>`;
    }

    function detailsHtml({ title = '', deadline = '', today = '' } = {}) {
        return `<label class="proposal-editor-field"><span>${esc(t('agreement.details.title', 'Title (optional)'))}</span><input type="text" data-agreement-title value="${esc(title)}" autocomplete="off"></label>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.details.deadline', 'Deadline (optional)'))}</span><input type="date" data-agreement-deadline value="${esc(deadline)}"${today ? ` min="${esc(today)}"` : ''}></label>`;
    }

    function consultationHtml({ organiser = '', participationUrl = '' } = {}) {
        return `<p class="agreement-hint">${esc(t('agreement.consultation.hint', 'Optional organiser identity and participation information. A community consultation records opinions and does not settle land or money.'))}</p>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.consultation.organiser', 'Organiser website or did:web (optional)'))}</span><input type="text" data-agreement-organiser value="${esc(organiser)}" autocomplete="off"></label>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.consultation.participationUrl', 'Participation URL (HTTPS, optional)'))}</span><input type="url" data-agreement-participation-url value="${esc(participationUrl)}" autocomplete="off"></label>`;
    }

    // The whole body. `view`: { designs, selected, missing, land, loading, landError, values, today }.
    function bodyHtml(view) {
        const values = view.values || {};
        const owners = values.electorate !== 'community';
        return `<p class="agreement-intro">${esc(owners
            ? t('agreement.dialog.intro', 'An agreement bundles designs on the map with who decides, who gets which land and what money moves. Nothing leaves this device yet.')
            : t('community.intro', 'This consultation asks for non-binding community support. It gives no owner consent and moves no land or money.'))}</p>`
            + '<ul class="agreement-issues agreement-issues--error" data-agreement-errors aria-live="assertive"></ul>'
            + '<ul class="agreement-issues agreement-issues--warning" data-agreement-warnings aria-live="polite"></ul>'
            + sectionHtml('rule', t('agreement.sections.rule', 'Decision rule'), ruleHtml(values))
            + sectionHtml('consultation', t('agreement.sections.consultation', 'Community consultation'), consultationHtml(values), owners)
            + sectionHtml('designs', t('agreement.sections.designs', 'Designs'), designsHtml(view))
            + sectionHtml('land', t('agreement.sections.land', 'Land'),
                `<div class="agreement-land" data-agreement-land>${landHtml({ land: view.land, loading: view.loading, error: view.landError, selectedCount: Array.from(view.selected || []).length })}</div>`)
            + sectionHtml('allocation', t('agreement.sections.allocation', 'Allocation'),
                `<p class="agreement-hint">${esc(t('agreement.allocation.hint', 'Who receives each resulting piece. The current holders are what the designs carried over.'))}</p>`
                + `<div class="agreement-allocations" data-agreement-allocations>${allocationHtml(view.land, values.allocations)}</div>`, !owners)
            + sectionHtml('money', t('agreement.sections.money', 'Money'),
                `<p class="agreement-hint">${esc(t('agreement.money.hint', 'Cash per party, in {{currency}}: positive receives, negative pays. The sponsor covers the difference.', { currency: view.currency || '' }))}</p>`
                + `<div class="agreement-money" data-agreement-money>${moneyHtml(view.land, values.cash, view.currency)}</div>`
                + '<p class="agreement-sponsor" data-agreement-sponsor></p>', !owners)
            + sectionHtml('details', t('agreement.sections.details', 'Details'), detailsHtml({ title: values.title, deadline: values.deadline, today: view.today }));
    }

    // ---- the editor: a panel on the right dock ---------------------------------------------------

    const log = message => console.log(`[${new Date().toISOString()}] [AgreementEditor] ${message}`);

    // The open editor, at most one: { cancel() }.
    let session = null;

    // A proposed agreement is immutable (M2): a change is a new agreement, proposed in its turn.
    function publishedError() {
        const error = new Error(t('agreement.errors.published', 'A proposed agreement cannot be edited; propose a new one.'));
        error.code = 'agreement-published';
        return error;
    }

    // Escape cancels the editor, except while typing in a field: the key is the field's there, and
    // a slip must not cost what was typed.
    function typingIn(target) {
        if (!target || !target.tagName) return false;
        if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
        return target.tagName === 'INPUT'
            && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(String(target.type || '').toLowerCase());
    }

    // The editor takes the right dock, as the agreement panel does: the sheets, the parcel menu, a
    // parcel's panel and a design's panel make way.
    function makeWay(doc) {
        if (root.MapShell && typeof root.MapShell.closeSheets === 'function') root.MapShell.closeSheets();
        root.ClickStack?.close();
        if (doc.getElementById('parcel-info-panel')?.classList.contains('visible') && typeof root.hideParcelInfoPanel === 'function') root.hideParcelInfoPanel();
        if (doc.getElementById('proposal-details-panel')?.classList.contains('visible') && typeof root.hideProposalDetailsPanel === 'function') root.hideProposalDetailsPanel(true);
    }

    // The docked section, built once and refilled per open: a header with the title and a close
    // button, then a form whose body scrolls and whose footer (Cancel, Save) stays at the bottom. On a
    // phone the right dock is a bottom sheet (css/panels.css, css/utilities.css), and
    // js/mobile-dock-sheet.js puts its resize handle in front of the header.
    function ensurePanel(doc) {
        const existing = doc.getElementById('agreement-editor');
        if (existing) return existing;
        const panel = doc.createElement('section');
        panel.id = 'agreement-editor';
        panel.className = 'info-panel right-dock-panel agreement-editor';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'agreement-editor-title');
        panel.innerHTML = '<div class="panel-header">'
            + '<h3 id="agreement-editor-title" tabindex="-1"></h3>'
            + '<button type="button" class="close-circle-btn close-circle-btn--lg close-button" data-agreement-action="cancel">&times;</button>'
            + '</div>'
            + '<form class="agreement-editor__form" novalidate>'
            + '<div class="panel-body agreement-editor__body" data-agreement-editor-body></div>'
            + '<div class="panel-footer agreement-editor__footer">'
            + '<button type="button" class="btn" data-agreement-action="cancel"></button>'
            + '<button type="submit" class="btn btn-primary" data-agreement-action="save"></button>'
            + '</div>'
            + '</form>';
        (doc.getElementById('map-container') || doc.body).appendChild(panel);
        return panel;
    }

    /**
     * Opens the editor on the right dock over the applied designs, in place of the agreement panel
     * while it is open: a new agreement (preselecting `designIds`), or the stored agreement
     * `electorate` selects the decision flow for a new record; an existing agreement retains its rule.
     * `agreementId` with `designIds` added to its designs. A proposed agreement is refused (an error
     * with code 'agreement-published'). Resolves with the saved record, or null when cancelled.
     */
    async function open({ agreementId = null, designIds = null, electorate = 'owners' } = {}) {
        const doc = root.document;
        const existing = agreementId ? root.AgreementStore.get(agreementId) : null;
        if (agreementId && !existing) throw new Error(`Agreement ${agreementId} is not on this device.`);
        if (existing && existing.published) throw publishedError();
        if (!root.MapPick) throw new Error('MapPick (js/map-pick.js) is not loaded.');
        // One editor at a time: an open one is cancelled first.
        if (session) session.cancel();
        const order = root.__planOrder && typeof root.__planOrder.orderFormations === 'function' ? root.__planOrder.orderFormations : null;
        const available = appliedDesigns(root.proposalStorage.getAllProposals(), { isApplied: root.isApplied, orderFormations: order });
        const availableIds = new Set(available.map(record => idOf(record.proposalId)));
        const wanted = Array.from(new Set((existing ? existing.designs.map(design => design.proposalId) : [])
            .concat(Array.isArray(designIds) ? designIds : []).map(idOf).filter(Boolean)));
        const rule = existing && existing.rule ? existing.rule : null;
        const terms = termsOf(existing);
        const state = {
            id: existing ? existing.id : root.AgreementRecord.newId(),
            createdAt: existing ? existing.createdAt : null,
            updatedAt: existing ? existing.updatedAt : null,
            city: (existing && existing.city) || (typeof root.resolveCurrentCityCode === 'function' ? root.resolveCurrentCityCode() || null : null),
            // The money of the agreement's place: what it was saved in, else the city on screen's.
            currency: (existing && existing.money && existing.money.currency) || root.CityMoney.currentCurrency(),
            available,
            selected: new Set(wanted.filter(id => availableIds.has(id))),
            missing: wanted.filter(id => !availableIds.has(id)),
            land: emptyLand(), loading: false, landError: null, sequence: 0,
            fingerprints: new Map(),
            approvalConfig: (rule && rule.approvalConfig) || null,
            lens: rule && Array.isArray(rule.lens) ? rule.lens.slice() : [],
            ruleError: null, ruleSequence: 0,
            values: {
                allocations: terms.allocations,
                cash: terms.cash,
                electorate: (rule ? rule.electorate : electorate) === 'community' ? 'community' : 'owners',
                organiser: existing && existing.consultation && existing.consultation.organiser || '',
                participationUrl: existing && existing.consultation && existing.consultation.participationUrl || '',
                // An owners' agreement binds unless it was saved as a vote.
                binding: rule ? rule.binding === true : true,
                title: (existing && existing.title) || '',
                deadline: dateFromDeadline(existing && existing.deadline)
            },
            attempted: false, saveIssue: null, closed: false
        };
        const selectedDesigns = () => state.available.filter(record => state.selected.has(idOf(record.proposalId)));
        const formState = () => ({
            id: state.id, createdAt: state.createdAt, updatedAt: state.updatedAt, city: state.city,
            designs: selectedDesigns(), fingerprints: state.fingerprints, land: state.land,
            approvalConfig: state.approvalConfig, lens: state.lens, currency: state.currency
        });
        const draft = () => recordFromForm(formState(), state.values);
        const inputIds = () => state.land.inputs.parcels.map(parcel => parcel.parcelId);
        const designOf = id => root.proposalStorage.getProposal(id) || null;

        // The agreement panel steps aside while an agreement is edited; Cancel brings it back.
        const panels = root.AgreementPanel;
        const replaced = panels && typeof panels.isOpen === 'function' && panels.isOpen() ? panels.current() : null;
        if (replaced) panels.close();
        makeWay(doc);

        const panel = ensurePanel(doc);
        const heading = panel.querySelector('#agreement-editor-title');
        heading.textContent = existing ? t('agreement.dialog.titleEdit', 'Edit agreement') : t('agreement.dialog.titleCreate', 'Create agreement');
        const cancelLabel = t('common.cancel', 'Cancel');
        const closeButton = panel.querySelector('.panel-header [data-agreement-action="cancel"]');
        closeButton.setAttribute('aria-label', cancelLabel);
        closeButton.title = cancelLabel;
        panel.querySelector('.agreement-editor__footer [data-agreement-action="cancel"]').textContent = cancelLabel;
        const saveButton = panel.querySelector('[data-agreement-action="save"]');
        saveButton.textContent = t('agreement.dialog.save', 'Save agreement');
        const form = panel.querySelector('.agreement-editor__form');
        const body = panel.querySelector('[data-agreement-editor-body]');
        body.innerHTML = bodyHtml({ ...state, designs: state.available, loading: state.selected.size > 0, today: dateFromDeadline(new Date().toISOString()) });
        body.scrollTop = 0;
        const part = selector => body.querySelector(selector);

        // Every listener of this session goes with it; the next open wires its own.
        const listeners = new AbortController();
        const { signal } = listeners;
        let unregisterEscape = null;
        let resolveClosed = null;
        const closed = new Promise(resolve => { resolveClosed = resolve; });
        const current = { cancel: () => finish(null) };
        session = current;

        // Saved: the agreement's panel opens on it. Cancelled: the panel the editor replaced returns.
        function finish(result) {
            if (state.closed) return;
            state.closed = true;
            listeners.abort();
            if (typeof unregisterEscape === 'function') unregisterEscape();
            if (session === current) session = null;
            root.MapPick.end('agreement');
            panel.classList.remove('visible');
            body.innerHTML = '';
            doc.body.classList.remove('agreement-editor-open');
            log(result ? `saved ${result.id}` : `cancelled ${state.id}`);
            const reopen = result ? result.id : replaced;
            if (reopen && panels && typeof panels.open === 'function') {
                Promise.resolve(panels.open(reopen)).catch(error => console.error(`[${new Date().toISOString()}] [AgreementEditor] the agreement panel of ${reopen} could not be opened`, error));
            }
            resolveClosed(result || null);
        }

        function setSaveEnabled(enabled) {
            saveButton.disabled = !enabled;
        }

        function validation(record) {
            return root.AgreementRecord.validate(record, { designOf, isApplied: root.isApplied });
        }

        function renderIssues(errors, warnings) {
            part('[data-agreement-errors]').innerHTML = issuesHtml(errors);
            part('[data-agreement-warnings]').innerHTML = issuesHtml(warnings);
        }

        // Warnings follow the form once a design is chosen; errors show once Save has been tried, and
        // then follow the form too.
        function refreshIssues() {
            if (state.loading || state.closed) return;
            const result = validation(draft());
            const errors = (state.attempted ? result.errors || [] : []).concat(state.saveIssue ? [state.saveIssue] : []);
            renderIssues(errors, state.selected.size ? result.warnings || [] : []);
        }

        // Blank while an amount cannot be read (a lone "-" or a trailing "." mid-typing): the
        // schedule needs whole cents, and the validation names the amount on save.
        function renderSponsor() {
            const line = part('[data-agreement-sponsor]');
            const record = draft();
            let sponsor = null;
            if (record.money.lines.every(entry => Number.isSafeInteger(entry.amountCents))) {
                try { sponsor = sponsorLine(root.AgreementRecord.ledger(record).money, record.money.currency); } catch (error) {
                    console.warn('[agreement-dialog] The money schedule could not be computed', error);
                }
            }
            line.textContent = sponsor ? sponsor.text : '';
            line.setAttribute('data-agreement-sponsor', sponsor ? sponsor.kind : '');
        }

        // ---- the decision rule: ProposalApprovalSetup's form, wired as its openDialog wires it ----

        const ruleForm = () => part('[data-agreement-rule-form]');

        // The lens first: a malformed fraction must not cost the author the keys they typed.
        function readRule() {
            const container = ruleForm();
            if (state.values.electorate !== 'owners' || !container.firstElementChild) return;
            state.lens = setup().lensFromForm(container);
            state.approvalConfig = setup().withPolicyFromForm(container, state.approvalConfig);
        }

        function keepRule() {
            try { readRule(); } catch (_) { /* the lens is kept; a bad fraction is reported on save */ }
        }

        function renderRule() {
            const owners = state.values.electorate === 'owners';
            body.querySelectorAll('[data-agreement-electorate]').forEach(input => { input.checked = input.value === state.values.electorate; });
            const binding = part('[data-agreement-binding]');
            binding.disabled = !owners;
            part('[data-agreement-binding-control]').hidden = !owners;
            part('[data-agreement-section="consultation"]').hidden = owners;
            part('[data-agreement-section="allocation"]').hidden = !owners;
            part('[data-agreement-section="money"]').hidden = !owners;
            binding.checked = owners && state.values.binding === true;
            const container = ruleForm();
            container.hidden = !owners;
            container.innerHTML = owners
                ? setup().html({ config: state.approvalConfig, lens: state.lens, cadastreParcelIds: inputIds(), error: state.ruleError, heading: false })
                : '';
        }

        function onRuleChange(target) {
            const container = ruleForm();
            if (target.closest('[data-approval-source]')) { setup().syncSourceControls(container); return; }
            // Only the rules choice and the custom authority change which fields exist; any other edit
            // is read on save, and the rule sentence follows it.
            if (!target.closest('[data-approval-regime], [data-approval-custom-authority]')) {
                if (target.closest('[data-approval-rule]')) {
                    try {
                        const preview = setup().withPolicyFromForm(container, state.approvalConfig);
                        const line = container.querySelector('[data-approval-rule-text]');
                        if (line) line.textContent = setup().policyText(preview.policy, preview.regime);
                    } catch (_) { /* reported on save */ }
                }
                return;
            }
            try { readRule(); state.ruleError = null; } catch (error) { state.ruleError = error && error.message || String(error); }
            renderRule();
            refreshIssues();
        }

        async function onRuleClick(event) {
            const button = event.target.closest('[data-editor-action]');
            const action = button && button.dataset.editorAction;
            if (!action || button.disabled) return;
            event.preventDefault();
            keepRule();
            const container = ruleForm();
            if (action === 'approval-template') { setup().downloadTemplate(inputIds(), state.approvalConfig); return; }
            if (action === 'approval-test-add' || action === 'approval-test-remove') {
                try {
                    const index = event.target.closest('[data-test-index]');
                    state.approvalConfig = setup().withRuleAction(container, state.approvalConfig, action, index && index.dataset.testIndex);
                    state.ruleError = null;
                } catch (error) { state.ruleError = error && error.message || String(error); }
                renderRule();
                refreshIssues();
                return;
            }
            if (action === 'approval-remove') {
                state.ruleSequence += 1;
                state.approvalConfig = setup().withoutRights(state.approvalConfig);
                state.ruleError = null;
                renderRule();
                refreshIssues();
                return;
            }
            if (action !== 'approval-import') return;
            const sequence = ++state.ruleSequence;
            try {
                const imported = await setup().importRights(container, state.approvalConfig, { parcelIds: inputIds() });
                if (sequence !== state.ruleSequence || state.closed) return;
                state.approvalConfig = imported;
                state.ruleError = null;
            } catch (error) {
                // A failed file or source leaves the previous rights in place.
                if (sequence !== state.ruleSequence || state.closed) return;
                state.ruleError = error && error.message || String(error);
            }
            renderRule();
            refreshIssues();
        }

        // ---- the land ------------------------------------------------------------------------

        // The original cadastral features of the input ids (as before-after.js reads them); the
        // agreement still derives without them, its areas then unknown.
        async function originalParcels(ids) {
            const repository = root.CadastralParcelRepository;
            if (!ids.length || !repository || typeof repository.ensureIds !== 'function') return [];
            try {
                const result = await repository.ensureIds(ids, { retainOnly: true });
                return Array.isArray(result && result.features) ? result.features : [];
            } catch (error) {
                console.warn('[agreement-dialog] Original parcels unavailable', error);
                return [];
            }
        }

        async function computeLand(designs) {
            const fabric = root.LiveParcelFabric;
            const ground = root.AgreementGround;
            const originals = originalsById(await originalParcels(inputParcelIds(designs, fabric)), fabric && fabric.featureId);
            return ground.derive({
                designs, fabric, originals,
                ownerOf: ground.localHolders({ storage: root.PersistentStorage, agents: root.agentStorage }),
                area: ground.areaOf
            });
        }

        // A design's identity is its content CID (M2, js/design-record.js), the same the index knows it by.
        function fingerprintOf(record) {
            if (!root.DesignRecord || typeof root.DesignRecord.cidOf !== 'function') throw new Error('DesignRecord (js/design-record.js) is not loaded.');
            return root.DesignRecord.cidOf(record);
        }

        async function deriveLand() {
            const sequence = ++state.sequence;
            const designs = selectedDesigns();
            state.loading = designs.length > 0;
            state.landError = null;
            setSaveEnabled(!state.loading);
            part('[data-agreement-land]').innerHTML = landHtml({ loading: state.loading, selectedCount: designs.length, land: emptyLand() });
            let land = emptyLand();
            let fingerprints = new Map();
            let failure = null;
            if (designs.length) {
                try {
                    fingerprints = new Map(designs.map(record => [idOf(record.proposalId), fingerprintOf(record)]));
                    land = await computeLand(designs);
                } catch (error) {
                    failure = error;
                    console.error('[agreement-dialog] Could not derive the land under the designs', error);
                }
            }
            if (state.closed || sequence !== state.sequence) return;
            state.loading = false;
            state.land = failure ? emptyLand() : land;
            state.landError = failure ? (failure.message || String(failure)) : null;
            state.fingerprints = fingerprints;
            if (!failure) {
                // Terms whose piece or party still exists are kept; so are imported rights. With no
                // design selected there is no land to prune against, so what was typed waits for
                // the next selection instead of vanishing on an untick.
                const hasLand = state.land.outputs.length > 0 || state.land.inputs.parcels.length > 0;
                if (hasLand) state.values = { ...state.values, ...keptTerms(state.values, state.land) };
                keepRule();
                try {
                    state.approvalConfig = ruleConfigAfterDerive(state.approvalConfig, state.land.inputs, root.AgreementRecord.rightsFromInputs);
                } catch (error) {
                    state.ruleError = error && error.message || String(error);
                }
            }
            part('[data-agreement-land]').innerHTML = landHtml({ land: state.land, error: state.landError, selectedCount: designs.length });
            part('[data-agreement-allocations]').innerHTML = allocationHtml(state.land, state.values.allocations);
            part('[data-agreement-money]').innerHTML = moneyHtml(state.land, state.values.cash, state.currency);
            renderSponsor();
            renderRule();
            refreshIssues();
            setSaveEnabled(true);
        }

        // ---- the designs: the checklist and the map pick the same selection ---------------------

        // The chosen designs are the map's highlight (js/map-pick.js); a change repaints that one.
        function repaint(id) {
            root.MapPick.refresh(id ? [id] : null)
                .catch(error => console.error(`[${new Date().toISOString()}] [AgreementEditor] the map highlight failed`, error));
        }

        function setChosen(id, chosen) {
            if (chosen) state.selected.add(id); else state.selected.delete(id);
            body.querySelectorAll('[data-agreement-design]').forEach(input => {
                if (input.getAttribute('data-agreement-design') === id) input.checked = chosen;
            });
            repaint(id);
            deriveLand();
        }

        // A click on an applied design on the map adds it, or takes it out when it is already in;
        // the line under the list says which, since on a phone the list may be out of view.
        function onMapPick(id, record) {
            if (state.closed) return;
            if (!availableIds.has(id)) {
                log(`${id} was not among the applied designs when the editor opened; not picked`);
                return;
            }
            const chosen = !state.selected.has(id);
            setChosen(id, chosen);
            const line = part('[data-agreement-pick-status]');
            if (line) {
                line.textContent = chosen
                    ? t('agreement.designs.added', 'Added “{{title}}”.', { title: designTitle(record) })
                    : t('agreement.designs.removed', 'Removed “{{title}}”.', { title: designTitle(record) });
            }
            log(`${chosen ? 'added' : 'removed'} ${id} from the map`);
        }

        // ---- save ------------------------------------------------------------------------------

        function save() {
            if (state.loading || state.closed) return;
            state.attempted = true;
            state.saveIssue = null;
            const ruleIssues = [];
            try { readRule(); state.ruleError = null; } catch (error) {
                ruleIssues.push({ code: 'rule-invalid', reason: error && error.message || String(error), section: 'rule' });
            }
            const record = draft();
            const result = validation(record);
            const errors = ruleIssues.concat(result.errors || []);
            if (errors.length) {
                renderIssues(errors, result.warnings || []);
                body.scrollTop = 0;
                return;
            }
            let saved;
            try {
                saved = root.AgreementStore.save(record);
            } catch (error) {
                const secondary = !!(error && error.code === 'secondary-tab');
                state.saveIssue = secondary ? { code: 'secondary-tab' } : { code: idOf(error && error.code), message: error && error.message || String(error) };
                renderIssues([state.saveIssue], result.warnings || []);
                body.scrollTop = 0;
                if (!secondary) throw error;
                return;
            }
            finish(saved);
        }

        // ---- events ----------------------------------------------------------------------------

        form.addEventListener('submit', event => {
            event.preventDefault();
            save();
        }, { signal });
        panel.addEventListener('click', event => {
            if (event.target && typeof event.target.closest === 'function' && event.target.closest('[data-agreement-action="cancel"]')) finish(null);
        }, { signal });
        body.addEventListener('change', event => {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;
            if (target.closest('[data-agreement-rule-form]')) { onRuleChange(target); return; }
            if (target.matches('[data-agreement-design]')) {
                setChosen(target.getAttribute('data-agreement-design'), target.checked);
                // The line under the list speaks of the last map click only.
                const line = part('[data-agreement-pick-status]');
                if (line) line.textContent = '';
                return;
            }
            if (target.matches('[data-agreement-allocation]')) {
                state.values = { ...state.values, allocations: { ...state.values.allocations, [target.getAttribute('data-agreement-allocation')]: target.value } };
                refreshIssues();
                return;
            }
            if (target.matches('[data-agreement-electorate]')) {
                keepRule();
                // Owners decide bindingly unless the author unticks it; a community vote never binds.
                const electorate = target.value === 'community' ? 'community' : 'owners';
                state.values = { ...state.values, electorate, binding: electorate === 'owners', ...(electorate === 'community' ? { allocations: {}, cash: {} } : {}) };
                part('[data-agreement-allocations]').innerHTML = allocationHtml(state.land, state.values.allocations);
                part('[data-agreement-money]').innerHTML = moneyHtml(state.land, state.values.cash, state.currency);
                renderSponsor();
                renderRule();
                refreshIssues();
                return;
            }
            if (target.matches('[data-agreement-binding]')) {
                state.values = { ...state.values, binding: target.checked === true };
                refreshIssues();
                return;
            }
            if (target.matches('[data-agreement-deadline]')) {
                state.values = { ...state.values, deadline: target.value };
                refreshIssues();
            }
        }, { signal });
        body.addEventListener('input', event => {
            const target = event.target;
            if (!target || typeof target.matches !== 'function') return;
            if (target.matches('[data-agreement-organiser], [data-agreement-participation-url]')) {
                const key = target.matches('[data-agreement-organiser]') ? 'organiser' : 'participationUrl';
                state.values = { ...state.values, [key]: target.value };
                refreshIssues();
            } else if (target.matches('[data-agreement-cash]')) {
                state.values = { ...state.values, cash: { ...state.values.cash, [target.getAttribute('data-agreement-cash')]: cashInputText(target) } };
                renderSponsor();
                refreshIssues();
            } else if (target.matches('[data-agreement-title]')) {
                state.values = { ...state.values, title: target.value };
            } else if (target.matches('[data-agreement-deadline]')) {
                state.values = { ...state.values, deadline: target.value };
                refreshIssues();
            }
        }, { signal });
        body.addEventListener('click', event => {
            if (event.target && typeof event.target.closest === 'function' && event.target.closest('[data-agreement-rule-form]')) onRuleClick(event);
        }, { signal });
        if (root.ModalEscape && typeof root.ModalEscape.register === 'function') {
            unregisterEscape = root.ModalEscape.register(panel, event => {
                if (typingIn(event && event.target)) return false;
                finish(null);
                return true;
            });
        }

        panel.classList.add('visible');
        doc.body.classList.add('agreement-editor-open');
        setSaveEnabled(state.selected.size === 0);
        renderSponsor();
        renderRule();
        // The map picks the designs as the checklist does; only applied designs stand on it.
        root.MapPick.begin({
            name: 'agreement',
            pick: onMapPick,
            highlight: () => Array.from(state.selected),
            close: () => finish(null)
        }).catch(error => console.error(`[${new Date().toISOString()}] [AgreementEditor] the map highlight failed`, error));
        log(`${existing ? 'editing' : 'creating'} ${state.id} over ${state.selected.size} of ${available.length} applied design(s)${replaced ? `, in place of the panel of ${replaced}` : ''}`);
        if (state.selected.size) deriveLand();
        else refreshIssues();
        const firstDesign = part('[data-agreement-design]');
        try { (firstDesign || heading).focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ }
        return closed;
    }

    /**
     * The details panel's "Add to agreement": a design joins a new agreement, or one this device
     * holds that is not proposed yet (newest first), then the editor opens on it. A design already in
     * the chosen agreement is said so, and the editor opens as it is. Resolves as open() does, or with
     * null when the choice is dismissed.
     */
    async function addDesign(proposalId) {
        const id = idOf(proposalId);
        if (!id) throw new TypeError('addDesign needs a design id.');
        const drafts = root.AgreementStore.list().filter(agreement => agreement && !agreement.published);
        if (!drafts.length) return open({ designIds: [id] });
        const design = root.proposalStorage.getProposal(id);
        const panels = root.AgreementPanel;
        const titleOf = agreement => (panels && typeof panels.titleOf === 'function' ? panels.titleOf(agreement) : (agreement.title || t('agreement.panel.title', 'Agreement')));
        const NEW = '__new__';
        const choice = await root.CbDialog.choice(
            t('agreement.addTo.message', 'Add “{{title}}” to a new agreement, or to one not proposed yet.', { title: designTitle(design) }),
            [{ value: NEW, label: t('agreement.addTo.new', 'New agreement'), primary: true }].concat(drafts.map(agreement => {
                const count = Array.isArray(agreement.designs) ? agreement.designs.length : 0;
                const designs = t('agreement.list.designs', count === 1 ? '{{count}} design' : '{{count}} designs', { count });
                return { value: agreement.id, label: `${titleOf(agreement)} · ${designs}` };
            })),
            { title: t('agreement.addTo.title', 'Add to agreement'), className: 'agreement-add-to' }
        );
        if (!choice) return null;
        if (choice === NEW) return open({ designIds: [id] });
        const agreement = drafts.find(entry => entry.id === choice);
        if (!agreement) throw new Error(`Agreement ${choice} is not on this device.`);
        if ((agreement.designs || []).some(entry => idOf(entry.proposalId) === id)) {
            if (typeof root.showEphemeralMessage === 'function') {
                root.showEphemeralMessage(t('agreement.addTo.alreadyIn', '“{{title}}” is already in this agreement.', { title: designTitle(design) }), 4000, 'info');
            }
            return open({ agreementId: agreement.id });
        }
        return open({ agreementId: agreement.id, designIds: [id] });
    }

    return {
        open, addDesign,
        SCHEMA, LOCAL_RIGHTS_PROVIDER,
        appliedDesigns, designTitle, inputParcelIds, originalsById, partiesOf, allocationOptions, allocationValue, allocationTo,
        cashCents, cashInputText, termsOf, keptTerms, sponsorLine, ruleConfigAfterDerive, deadlineFromDate, dateFromDeadline,
        recordFromForm, issueText, holdersText,
        designsHtml, landHtml, allocationHtml, moneyHtml, ruleHtml, detailsHtml, consultationHtml, bodyHtml
    };
});
