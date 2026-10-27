// Plan-first agreement editor: rules, input parcels, single-recipient output parcels and a
// read-only persons tally. Ground comes from one exact saved plan; compensation comes from its
// agreement rules. Ownership rights and lens settings open separate shared dialogs. Pure helpers
// are exercised by the targeted agreement accounting/store tests; open() connects them to the dock.
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
        return (record && (record.title || record.name)) || t('modal.roadWidth.proposalList.untitled', 'Untitled design');
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

    // One recipient per resulting piece, including acquisition by a proposer with no input land.
    function allocationOptions(inputs) {
        return [
            { value: '', label: t('agreement.workflow.chooseRecipient', 'Choose recipient') },
            { value: 'proposer', label: t('agreement.allocation.proposer', 'Proposer') },
            ...partiesOf(inputs).map(party => ({ value: `party:${party.ownerKey}`, label: party.displayName })),
            { value: 'public', label: t('agreement.allocation.public', 'Public') }
        ];
    }

    // An allocation line's `to` as a select value, and back. Missing lines require a recipient.
    function allocationValue(to) {
        if (!to || typeof to !== 'object') return 'holders';
        if (to.kind === 'public' || to.kind === 'proposer') return to.kind;
        if (to.kind === 'party' && idOf(to.ownerKey)) return `party:${idOf(to.ownerKey)}`;
        return 'holders';
    }

    function allocationTo(value) {
        const text = idOf(value);
        if (text === 'public' || text === 'proposer') return { kind: text };
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
        const owners = values.electorate !== 'community';
        const title = String(values.title ?? '').trim();
        const plan = state.plan || null;
        const recordApi = root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);
        const raw = {
            schema: SCHEMA,
            id: idOf(state.id),
            title: title || null,
            // The designs' city (the city id a published design carries), so an agreement and its
            // designs name the city the same way; the view's short code only when there is no design.
            city: (records[0] && records[0].city) || state.city || null,
            createdAt: state.createdAt || null,
            updatedAt: state.updatedAt || null,
            plan,
            designs: records.map(record => ({
                proposalId: idOf(record.proposalId),
                title: designTitle(record),
                goal: typeof record.goal === 'string' ? record.goal : null,
                cid: fingerprints.get(idOf(record.proposalId)) || null
            })),
            inputs: { parcels: Array.isArray(inputs.parcels) ? inputs.parcels : [], openGroundM2: isNumber(inputs.openGroundM2) ? inputs.openGroundM2 : 0 },
            outputs,
            allocations: owners ? outputs.map(output => ({ output: output.hash, to: allocationTo(chosen[output.hash]) })).filter(line => line.to) : [],
            money: { currency: state.currency || null, lines: [] },
            rule: owners
                ? { electorate: 'owners', binding: values.binding === true, approvalConfig: state.approvalConfig || null, lens: Array.isArray(state.lens) ? state.lens.slice() : [], settlement: values.settlement || { ...recordApi.DEFAULT_SETTLEMENT } }
                : { electorate: 'community', binding: false, approvalConfig: null, lens: [] },
            consultation: owners ? null : { organiser: values.organiser || null, participationUrl: values.participationUrl || null,
                ...(values.voting ? { voting: values.voting } : {}) },
            deadline: deadlineFromDate(values.deadline)
        };
        return recordApi.settle(raw);
    }

    // ---- errors and warnings ---------------------------------------------------------------------

    // One literal key per code (agreement.errors.<camelCaseCode>, agreement.warnings.<camelCaseCode>),
    // so the locale coverage test sees every one of them.
    const ISSUE_TEXT = {
        'plan-required': () => t('agreement.errors.planRequired', 'Create a plan first, then select it.'),
        'plan-membership': () => t('agreement.errors.planMembership', 'Save a plan revision before changing its designs.'),
        'land-unbalanced': () => t('agreement.errors.landUnbalanced', 'The input and output land areas must balance.'),
        'input-shares': () => t('agreement.errors.inputShares', 'Input owners must hold 100% of each parcel.'),
        'allocation-required': () => t('agreement.errors.allocationRequired', 'Choose one recipient for every output parcel.'),
        'settlement-invalid': () => t('agreement.errors.settlementInvalid', 'Set compensation within the scheme’s limits.'),
        'money-unbalanced': () => t('agreement.errors.moneyUnbalanced', 'Cash must match the compensation calculated from the rules.'),
        'no-designs': () => t('agreement.errors.noDesigns', 'Choose at least one design.'),
        'design-not-applied': () => t('agreement.errors.designNotApplied', 'Every design must be applied to the map.'),
        'no-inputs': () => t('agreement.errors.noInputs', 'The designs take no cadastral land.'),
        'allocation-unknown-output': () => t('agreement.errors.allocationUnknownOutput', 'An allocation names a piece that no longer exists.'),
        'allocation-unknown-party': () => t('agreement.errors.allocationUnknownParty', 'An allocation names a party that holds no input land.'),
        'allocation-shares-invalid': () => t('agreement.errors.allocationSharesInvalid', 'Joint shares must sum to 100 %.'),
        'money-currency': () => t('agreement.errors.moneyCurrency', 'Money must be in the currency of the agreement\'s city.'),
        'money-party-unknown': () => t('agreement.errors.moneyPartyUnknown', 'A cash line names a party that holds no input land.'),
        'money-amount-invalid': () => t('agreement.errors.moneyAmountInvalid', 'A cash amount is not a valid amount.'),
        'community-allocations': () => t('agreement.errors.communityAllocations', 'A nonbinding agreement cannot allocate land.'),
        'community-money': () => t('agreement.errors.communityMoney', 'A nonbinding agreement cannot include cash payments.'),
        'consultation-organiser': () => t('agreement.errors.consultationOrganiser', 'Enter an organiser website or a valid did:web identifier.'),
        'consultation-participation-url': () => t('agreement.errors.consultationParticipationUrl', 'Enter an HTTPS participation URL without credentials.'),
        'rule-invalid': reason => t('agreement.errors.ruleInvalid', 'The decision rule is incomplete: {{reason}}', { reason }),
        'rule-community-binding': () => t('agreement.errors.ruleCommunityBinding', 'A community vote cannot be binding.'),
        'deadline-invalid': () => t('agreement.errors.deadlineInvalid', 'The deadline must be a date in the future.'),
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

    // Parcels and designs share one inspectable row: title and supporting facts, never membership controls.
    function inspectionListHtml(items, kind, hook) {
        return `<ul class="agreement-object-list" ${hook}>${items.map(item => `<li data-agreement-${kind === 'parcel' ? 'input' : 'plan-design'}="${esc(item.id)}"><button type="button" class="cb-option agreement-object-row" data-agreement-inspect="${kind}" data-agreement-object-id="${esc(item.id)}" aria-pressed="false"><span class="agreement-object-row__title">${esc(item.title)}</span><span class="agreement-object-row__facts">${esc(item.facts)}</span></button></li>`).join('')}</ul>`;
    }
    function inputsTableHtml(parcels) {
        return `<h4 class="agreement-object-heading">${esc(t('agreement.land.inputsHeading', 'Input parcels'))}</h4>`
            + inspectionListHtml(parcels.map(parcel => ({ id: parcel.parcelId, title: parcel.parcelId,
                facts: `${areaText(parcel.areaM2)} · ${holdersText(parcel.holders)}` })), 'parcel', 'data-agreement-inputs');
    }
    function inputDesignsHtml(designs) {
        return `<h4 class="agreement-object-heading">${esc(t('sidebar.proposals.title', 'Designs'))}</h4>`
            + inspectionListHtml(designs.map(design => ({ id: idOf(design.proposalId), title: designTitle(design),
                facts: typeLabelOf(design) })), 'design', 'data-agreement-input-designs');
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
    function allocationMode(allocations = {}) {
        const values = Object.values(allocations);
        return values.length && ['proposer', 'public'].includes(values[0]) && values.every(value => value === values[0]) ? values[0] : 'individual';
    }
    function allocationHtml(land, allocations = {}, mode = 'individual') {
        const outputs = land && Array.isArray(land.outputs) ? land.outputs : [];
        if (!outputs.length) return '';
        const options = allocationOptions(land.inputs);
        const known = new Set(options.map(option => option.value));
        const rows = outputs.map((output, index) => {
            const value = known.has(allocations[output.hash]) ? allocations[output.hash] : '';
            return `<li><label class="agreement-allocation-row"><span class="agreement-allocation-row__piece">${esc(`${t('agreement.land.piece', 'Piece')} ${index + 1} · ${areaText(output.areaM2)}`)}</span>`
                + `<select data-agreement-allocation="${esc(output.hash)}"${mode !== 'individual' ? ' disabled' : ''}>${options.map(option => `<option value="${esc(option.value)}"${option.value === value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label></li>`;
        }).join('');
        const modes = [
            ['individual', t('agreement.allocation.individual', 'Set individually')],
            ['proposer', t('agreement.allocation.proposer', 'Proposer')],
            ['public', t('agreement.allocation.publicLand', 'Public land')]
        ];
        return `<label class="proposal-editor-field"><span>${esc(t('agreement.allocation.allOutputs', 'Allocate output parcels'))}</span><select data-agreement-allocation-mode>${modes.map(([value, label]) => `<option value="${value}"${mode === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label><ul class="agreement-allocation-list">${rows}</ul>`;
    }

    // Who decides, whether it binds, and the owners' rules (filled by the browser layer).
    function ruleHtml({ electorate = 'owners', binding = true } = {}) {
        const owners = electorate !== 'community';
        const radio = (value, label) => `<label class="proposal-editor-check"><input type="radio" name="agreement-electorate" value="${value}" data-agreement-electorate${(value === 'owners') === owners ? ' checked' : ''}> ${esc(label)}</label>`;
        return `<fieldset class="agreement-fieldset"><legend>${esc(t('agreement.rule.who', 'Who decides'))}</legend>`
            + radio('owners', t('agreement.rule.owners', 'Seek owners’ decisions'))
            + radio('community', t('agreement.rule.community', 'Ask the community'))
            + '</fieldset>'
            + `<label class="proposal-editor-check" data-agreement-binding-control${owners ? '' : ' hidden'}><input type="checkbox" data-agreement-binding${owners && binding ? ' checked' : ''}${owners ? '' : ' disabled'}> ${esc(t('agreement.rule.binding', 'Binding: owner approvals can authorize on-chain settlement'))}</label>`
            + `<div class="agreement-rule-form" data-agreement-rule-form${owners ? '' : ' hidden'}></div>`;
    }

    function detailsHtml({ title = '', deadline = '', today = '' } = {}) {
        return `<label class="proposal-editor-field"><span>${esc(t('agreement.details.title', 'Title (optional)'))}</span><input type="text" data-agreement-title value="${esc(title)}" autocomplete="off"></label>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.details.deadline', 'Deadline (optional)'))}</span><input type="date" data-agreement-deadline value="${esc(deadline)}"${today ? ` min="${esc(today)}"` : ''}></label>`;
    }

    function consultationHtml({ organiser = '', participationUrl = '' } = {}) {
        return `<p class="agreement-hint">${esc(t('agreement.consultation.hint', 'Optional organiser identity and participation information. A nonbinding agreement records opinions and does not settle land or money.'))}</p>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.consultation.organiser', 'Organiser website or did:web (optional)'))}</span><input type="text" data-agreement-organiser value="${esc(organiser)}" autocomplete="off"></label>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.consultation.participationUrl', 'Participation URL (HTTPS, optional)'))}</span><input type="url" data-agreement-participation-url value="${esc(participationUrl)}" autocomplete="off"></label>`
            + '<section data-voting-roster></section>';
    }

    // The whole body. `view`: { designs, selected, missing, land, loading, landError, values, today }.
    const TABS = ['rules', 'inputs', 'outputs', 'persons'];
    function tabLabel(tab) {
        const labels = { rules: ['agreement.workflow.rules', 'Rules'], inputs: ['agreement.workflow.inputs', 'Input parcels'], outputs: ['agreement.workflow.outputs', 'Output parcels'], persons: ['agreement.workflow.persons', 'Persons'] };
        return t(...labels[tab]);
    }
    function planSelectorHtml(plans, selected) {
        return `<label class="proposal-editor-field"><span>${esc(t('plan.label', 'Plan'))}</span><select data-agreement-plan><option value="">${esc(t('agreement.workflow.choosePlan', 'Choose a saved plan'))}</option>${plans.map(plan => `<option value="${esc(plan.cid)}"${plan.cid === selected?.cid ? ' selected' : ''}>${esc(plan.content.title)}</option>`).join('')}</select></label>`
            + (!plans.length ? `<p class="agreement-notice">${esc(t('agreement.workflow.noPlans', 'Create a plan first. Open Plans and choose Create plan.'))}</p>` : '');
    }
    function personsHtml(record) {
        const api = root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);
        const ledger = api.ledger(record);
        const terms = record.rule.settlement;
        const cell = (land, cash) => esc(areaText(land)) + (cash > 0 ? `<br><span class="agreement-persons-cash">${esc(moneyText(cash, ledger.currency))}</span>` : '');
        const rows = ledger.parties.map(party => `<tr><th scope="row">${esc(party.displayName)}</th><td>${cell(party.areaUnknown ? null : party.contributedM2, Math.max(0, -party.cashCents))}</td><td>${cell(party.assignedM2, Math.max(0, party.cashCents))}</td></tr>`).join('');
        const publicRow = ledger.publicM2 > 0 ? `<tr><th scope="row">${esc(t('agreement.allocation.public', 'Public'))}</th><td>${cell(0, 0)}</td><td>${cell(ledger.publicM2, 0)}</td></tr>` : '';
        const sponsor = ledger.money.sponsorCents;
        const sponsorRow = sponsor || ledger.proposerM2 > 0 ? `<tr><th scope="row">${esc(ledger.proposerM2 > 0 ? t('agreement.allocation.proposer', 'Proposer') : t('agreement.workflow.sponsor', 'Sponsor'))}</th><td>${cell(0, Math.max(0, -sponsor))}</td><td>${cell(ledger.proposerM2, Math.max(0, sponsor))}</td></tr>` : '';
        const balance = api.landBalance(record);
        return (terms?.method === 'area' ? `<p class="agreement-hint">${esc(t('agreement.workflow.rateReadOnly', 'Compensation: {{rate}} per m². Change it in Rules.', { rate: moneyText(terms.rateCentsPerM2, ledger.currency) }))}</p>` : '')
            + `<table class="agreement-persons-table"><thead><tr><th scope="col">${esc(t('agreement.workflow.person', 'Person'))}</th><th scope="col">${esc(t('agreement.workflow.putsIn', 'Puts in'))}</th><th scope="col">${esc(t('agreement.workflow.receives', 'Receives'))}</th></tr></thead><tbody>${rows}${publicRow}${sponsorRow}</tbody></table>`
            + `<p class="agreement-hint" data-agreement-balance>${esc(t('agreement.workflow.landTotals', 'Land in: {{input}} · Land out: {{output}}', { input: areaText(balance.inputM2), output: areaText(balance.outputM2) }))}</p>`;
    }
    function bodyHtml(view) {
        const values = view.values || {};
        const panels = {
            rules: ruleHtml(values) + '<div data-agreement-settlement></div><section class="agreement-lens" aria-labelledby="agreement-lens-title"><h4 id="agreement-lens-title" class="agreement-object-heading">' + esc(t('agreement.chain.facts.lens', 'Lens')) + '</h4><div class="agreement-lens__row"><button type="button" class="btn btn-icon btn-sm lens-pattern-button" data-lens-pattern data-agreement-action="lens" title="' + esc(t('modal.lens.triggerDescription', 'Lens for viewing the world')) + '" aria-label="' + esc(t('modal.lens.triggerDescription', 'Lens for viewing the world')) + '"><i class="fa-solid fa-glasses" aria-hidden="true"></i></button></div></section>'
                + sectionHtml('consultation', t('agreement.sections.consultation', 'Nonbinding agreement'), consultationHtml(values), values.electorate !== 'community')
                + detailsHtml({ title: values.title, deadline: values.deadline, today: view.today }),
            inputs: planSelectorHtml(view.plans || [], view.plan) + '<div class="cb-actions"><button type="button" class="btn" data-agreement-action="rights">' + esc(t('agreement.workflow.rights', 'Parcel ownership rights')) + '</button></div><div data-agreement-land></div><div data-agreement-plan-designs></div>',
            outputs: '<div data-agreement-allocations></div>',
            persons: '<div data-agreement-persons></div>'
        };
        return '<ul class="agreement-issues agreement-issues--error" data-agreement-errors aria-live="assertive"></ul><ul class="agreement-issues agreement-issues--warning" data-agreement-warnings aria-live="polite"></ul>'
            + `<div class="cb-tabs agreement-editor__tabs" role="tablist" aria-label="${esc(t('agreement.panel.title', 'Agreement'))}">${TABS.map(tab => `<button type="button" class="cb-tab" role="tab" id="agreement-tab-${tab}" aria-controls="agreement-tabpanel-${tab}" aria-selected="${tab === 'inputs'}" tabindex="${tab === 'inputs' ? 0 : -1}" data-agreement-tab="${tab}">${esc(tabLabel(tab))}</button>`).join('')}</div>`
            + TABS.map(tab => `<section role="tabpanel" id="agreement-tabpanel-${tab}" aria-labelledby="agreement-tab-${tab}" data-agreement-tabpanel="${tab}"${tab === 'inputs' ? '' : ' hidden'}>${panels[tab]}</section>`).join('');
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
        panel.className = 'info-panel right-dock-panel right-screen-panel agreement-editor';
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

    // A plan is selected before ground is read. Designs are a read-only projection of that exact
    // revision; changing a plan's membership is a separate plan-authoring operation.
    async function open({ agreementId = null, electorate = 'owners', plan = null, preserveContext = false } = {}) {
        const doc = root.document, api = root.AgreementRecord;
        const existing = agreementId ? root.AgreementStore.get(agreementId) : null;
        if (agreementId && !existing) throw new Error(`Agreement ${agreementId} is not on this device.`);
        if (existing?.published) throw publishedError();
        if (session) session.cancel();
        const plans = root.NamedPlans.list();
        const requestedPlan = existing?.plan || plan || null;
        const initialPlan = plans.find(row => row.cid === requestedPlan?.cid) || requestedPlan;
        if (initialPlan && !plans.some(row => row.cid === initialPlan.cid)) plans.push(initialPlan);
        const state = {
            id: existing?.id || api.newId(), createdAt: existing?.createdAt || null,
            updatedAt: existing?.updatedAt || null, city: existing?.city || root.resolveCurrentCityCode?.() || null,
            plans, plan: initialPlan, designs: [], fingerprints: new Map(), land: emptyLand(),
            allocationMode: allocationMode(termsOf(existing).allocations),
            currency: existing?.money.currency || root.CityMoney.currentCurrency(),
            approvalConfig: existing?.rule.approvalConfig || null,
            lens: existing ? [...existing.rule.lens] : setup().lensKeys(root.getLensEntries()),
            values: { ...termsOf(existing), electorate: existing?.rule.electorate || electorate,
                binding: existing?.rule.binding === true, title: existing?.title || '',
                settlement: { ...(existing?.rule.settlement || api.DEFAULT_SETTLEMENT) },
                deadline: dateFromDeadline(existing?.deadline), organiser: existing?.consultation?.organiser || '',
                participationUrl: existing?.consultation?.participationUrl || '', voting: existing?.consultation?.voting || null },
            loading: false, closed: false, sequence: 0, attempted: false, landError: null
        };
        const panels = root.AgreementPanel;
        const replaced = panels?.isOpen?.() ? panels.current() : null;
        if (replaced && !preserveContext) panels.close();
        if (!preserveContext) makeWay(doc);
        const panel = ensurePanel(doc), body = panel.querySelector('[data-agreement-editor-body]');
        const form = panel.querySelector('form'), saveButton = panel.querySelector('[data-agreement-action="save"]');
        // Native modality makes the background inert without changing map handlers or control state.
        // Auxiliary dialogs belong inside this top layer so they stay interactive too.
        const parent = panel.parentElement;
        const modal = doc.createElement('dialog');
        modal.className = 'cb-dialog-overlay agreement-editor-modal';
        modal.setAttribute('aria-labelledby', 'agreement-editor-title');
        modal.appendChild(panel); doc.body.appendChild(modal);
        panel.querySelector('#agreement-editor-title').textContent = t(existing ? 'agreement.dialog.titleEdit' : 'agreement.dialog.titleCreate', existing ? 'Edit agreement' : 'Create agreement');
        panel.querySelectorAll('[data-agreement-action="cancel"]').forEach(button => {
            button.setAttribute('aria-label', t('common.cancel', 'Cancel'));
            if (button.closest('.panel-footer')) button.textContent = t('common.cancel', 'Cancel');
        });
        saveButton.textContent = t(existing ? 'agreement.dialog.save' : 'agreement.dialog.titleCreate', existing ? 'Save agreement' : 'Create agreement');
        body.innerHTML = bodyHtml({ ...state, today: dateFromDeadline(new Date().toISOString()) });
        const part = selector => body.querySelector(selector);
        const listeners = new AbortController(), { signal } = listeners;
        let resolveClosed, auxiliary = null, unregisterEscape = null;
        const closed = new Promise(resolve => { resolveClosed = resolve; });
        const current = { cancel: () => finish(null) };
        session = current;
        const draft = () => recordFromForm(state, state.values);
        let rosterPending = false;
        const roster = root.CommunityVotingRoster?.mount(part('[data-voting-roster]'), {
            value: state.values.voting,
            changed: (value, pending) => { state.values.voting = value; rosterPending = pending; issues(); }
        });
        function finish(result) {
            if (state.closed) return;
            state.closed = true; roster?.destroy(); clearInspection(); listeners.abort(); auxiliary?.close(); unregisterEscape?.();
            if (session === current) session = null;
            panel.classList.remove('visible'); body.replaceChildren(); doc.body.classList.remove('agreement-editor-open');
            if (modal.open) modal.close();
            parent.appendChild(panel); modal.remove();
            const reopen = preserveContext ? null : result?.id || replaced;
            if (reopen) Promise.resolve(panels.open(reopen)).catch(report);
            resolveClosed(result || null);
        }
        function report(error) {
            console.error(`[${new Date().toISOString()}] [AgreementEditor]`, error);
            root.showEphemeralMessage?.(error.message || String(error), 7000, 'error');
        }
        function activate(tab, focus = false) {
            clearInspection();
            body.querySelectorAll('[data-agreement-tab]').forEach(button => {
                const selected = button.dataset.agreementTab === tab;
                button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
                if (focus && selected) button.focus();
            });
            body.querySelectorAll('[data-agreement-tabpanel]').forEach(section => { section.hidden = section.dataset.agreementTabpanel !== tab; });
        }
        function issues() {
            if (state.closed || state.loading) return;
            try {
                const checked = api.validate(draft(), { designOf: id => root.proposalStorage.getProposal(id), isApplied: root.isApplied });
                part('[data-agreement-errors]').innerHTML = issuesHtml(state.attempted ? checked.errors : []);
                // Advanced ownership/lens readiness lives behind its own controls.
                part('[data-agreement-warnings]').innerHTML = issuesHtml(checked.warnings.filter(row => row.section === 'land'));
                saveButton.disabled = !state.plan || !!state.landError || !checked.valid || (state.values.electorate === 'community' && rosterPending);
            } catch (error) { saveButton.disabled = true; part('[data-agreement-errors]').textContent = error.message; }
        }
        function renderPersons() {
            try { part('[data-agreement-persons]').innerHTML = personsHtml(draft()); }
            catch (error) { part('[data-agreement-persons]').textContent = error.message; }
        }
        function settlementHtml() {
            const terms = state.values.settlement, limit = api.contributionLimit({ approvalConfig: state.approvalConfig });
            terms.contributionBasisPoints = Math.min(terms.contributionBasisPoints, limit);
            const enabled = terms.method === 'area';
            return `<label class="proposal-editor-field"><span>${esc(t('agreement.workflow.compensation', 'Compensation'))}</span><select data-agreement-compensation><option value="area"${enabled ? ' selected' : ''}>${esc(t('agreement.workflow.byArea', 'Balance land differences in money'))}</option><option value="none"${!enabled ? ' selected' : ''}>${esc(t('agreement.workflow.noCash', 'No cash compensation'))}</option></select></label>`
                + `<label class="proposal-editor-field"${enabled ? '' : ' hidden'}><span>${esc(t('agreement.workflow.rate', 'Compensation per m² ({{currency}})', { currency: state.currency }))}</span><input type="range" min="0" max="${Math.max(100000, terms.rateCentsPerM2)}" step="100" value="${terms.rateCentsPerM2}" data-agreement-rate-slider><input type="number" min="0" max="100000000" step="0.01" value="${terms.rateCentsPerM2 / 100}" data-agreement-rate aria-label="${esc(t('agreement.workflow.rate', 'Compensation per m² ({{currency}})', { currency: state.currency }))}"></label>`
                + (enabled && limit ? `<label class="proposal-editor-field"><span>${esc(t('agreement.workflow.contribution', 'Land contribution (%)'))}</span><input type="range" min="0" max="${limit}" step="1" value="${terms.contributionBasisPoints}" data-agreement-contribution><output data-agreement-contribution-value>${terms.contributionBasisPoints / 100}%</output></label><p class="agreement-hint">${esc(t('agreement.workflow.contributionHint', 'Compensation covers differences from the remaining land entitlement after this contribution.'))}</p>` : '');
        }
        function readRule() {
            const container = part('[data-agreement-rule-form]');
            if (state.values.electorate === 'owners' && container.firstElementChild) state.approvalConfig = setup().withPolicyFromForm(container, state.approvalConfig);
        }
        function renderLens() {
            part('[data-agreement-action="lens"]').dataset.lensEntries = JSON.stringify(state.lens.map(address => ({ address })));
            root.refreshLensPatternPreviews();
        }
        function renderRule() {
            const owners = state.values.electorate === 'owners';
            const source = doc.createElement('div');
            source.innerHTML = setup().html({ config: state.approvalConfig, lens: state.lens, cadastreParcelIds: state.land.inputs.parcels.map(p => p.parcelId), heading: false });
            const container = part('[data-agreement-rule-form]'); container.replaceChildren(); container.hidden = !owners;
            const rules = source.querySelector('[data-approval-rules-card]'); if (owners && rules) container.appendChild(rules);
            part('[data-agreement-settlement]').innerHTML = owners ? settlementHtml() : '';
            renderLens();
            part('[data-agreement-binding-control]').hidden = !owners;
            part('[data-agreement-binding]').disabled = !owners;
            part('[data-agreement-section="consultation"]').hidden = owners;
        }
        function renderLand() {
            clearInspection();
            const target = part('[data-agreement-land]');
            if (state.loading) target.innerHTML = landHtml({ loading: true });
            else if (state.landError) target.innerHTML = `<p class="agreement-alert">${esc(state.landError)}</p><button type="button" class="btn" data-agreement-action="apply-plan">${esc(t('agreement.workflow.applyPlan', 'Apply plan designs'))}</button>`;
            else target.innerHTML = inputsTableHtml(state.land.inputs.parcels);
            part('[data-agreement-plan-designs]').innerHTML = inputDesignsHtml(state.designs);
            part('[data-agreement-allocations]').innerHTML = allocationHtml(state.land, state.values.allocations, state.allocationMode);
            if (state.values.electorate === 'community') part('[data-agreement-allocations]').querySelectorAll('select').forEach(select => { select.disabled = true; });
            renderPersons(); issues();
        }
        function applyRights() {
            const rights = state.approvalConfig?.rights;
            if (!rights || rights.source?.provider === LOCAL_RIGHTS_PROVIDER) return;
            state.land.inputs.parcels = state.land.inputs.parcels.map(parcel => {
                const row = rights.parcels.find(row => row.parcelId === parcel.parcelId);
                if (!row?.owners?.length) return parcel;
                return { ...parcel, holders: row.owners.map(owner => {
                    const [n, d] = owner.share.split('/').map(Number);
                    return { ownerKey: owner.ownerId, displayName: owner.displayName || owner.ownerId, share: n / d };
                }) };
            });
        }
        function reconcileAllocations() {
            const kept = keptTerms(state.values, state.land).allocations;
            const defaults = Object.fromEntries(api.defaultAllocations(state.land.inputs, state.land.outputs).map(row => [row.output, allocationValue(row.to)]));
            state.values.allocations = state.allocationMode === 'individual' ? { ...defaults, ...kept }
                : Object.fromEntries(state.land.outputs.map(output => [output.hash, state.allocationMode]));
        }
        async function deriveLand() {
            const sequence = ++state.sequence;
            state.loading = true; state.landError = null; saveButton.disabled = true; renderLand();
            try {
                state.designs = []; state.land = emptyLand(); state.fingerprints = new Map();
                if (state.plan) {
                    const records = root.proposalStorage.getAllProposals();
                    const byCid = new Map(records.map(record => [root.DesignRecord.cidOf(record), record]));
                    const selected = state.plan.content.designCids.map(cid => byCid.get(cid));
                    if (selected.some(record => !record || !root.isApplied(record))) throw new Error(t('agreement.workflow.planNotApplied', 'Apply every design of this saved plan before reading its land.'));
                    state.designs = selected;
                    state.fingerprints = new Map(selected.map(record => [idOf(record.proposalId), root.DesignRecord.cidOf(record)]));
                    const repository = root.CadastralParcelRepository;
                    const loaded = await repository.ensureIds(inputParcelIds(selected, root.LiveParcelFabric), { retainOnly: true });
                    if (state.closed || sequence !== state.sequence) return;
                    state.land = root.AgreementGround.derive({ designs: selected, fabric: root.LiveParcelFabric,
                        originals: originalsById(loaded.features, root.LiveParcelFabric.featureId),
                        ownerOf: root.AgreementGround.localHolders({ storage: root.PersistentStorage, agents: root.agentStorage }) });
                    applyRights(); reconcileAllocations();
                    state.approvalConfig = ruleConfigAfterDerive(state.approvalConfig, state.land.inputs, api.rightsFromInputs);
                }
            } catch (error) {
                if (state.closed || sequence !== state.sequence) return;
                state.landError = error.message; report(error);
            } finally {
                if (!state.closed && sequence === state.sequence) { state.loading = false; renderRule(); renderLand(); }
            }
        }
        function openAuxiliary(kind) {
            readRule();
            const container = doc.createElement('div');
            if (kind === 'lens') {
                const names = new Map(root.getLensEntries().map(entry => [entry.address, entry.name]));
                auxiliary = root.showLensModal({ parent: modal,
                    entries: state.lens.map(address => ({ address, name: names.get(address) || '' })),
                    onChange: entries => { state.lens = setup().lensKeys(entries); renderLens(); issues(); }
                });
                return;
            }
            const render = error => {
                container.innerHTML = setup().html({ config: state.approvalConfig, lens: [], cadastreParcelIds: state.land.inputs.parcels.map(p => p.parcelId), heading: false, error });
                container.querySelector('[data-approval-rules-card]')?.remove(); container.querySelector('[data-approval-lens]')?.closest('label')?.remove();
            };
            render();
            auxiliary = root.CbDialog.open({ parent: modal, title: t('agreement.workflow.rights', 'Parcel ownership rights'), body: container, actions: [{ label: t('common.close', 'Close') }] });
            container.addEventListener('change', event => { if (event.target.matches('[data-approval-source]')) setup().syncSourceControls(container); });
            container.addEventListener('click', async event => {
                const button = event.target.closest('[data-editor-action]'); if (!button || root.BusyControl.isBusy(button)) return;
                const action = button.dataset.editorAction;
                if (action === 'approval-template') { setup().downloadTemplate(state.land.inputs.parcels.map(p => p.parcelId), state.approvalConfig); return; }
                try {
                    await root.BusyControl.track(button, async () => {
                        if (action === 'approval-import') state.approvalConfig = await setup().importRights(container, state.approvalConfig, { parcelIds: state.land.inputs.parcels.map(p => p.parcelId) });
                        else if (action === 'approval-remove') { state.approvalConfig = setup().withoutRights(state.approvalConfig); await deriveLand(); }
                        if (state.closed) return;
                        applyRights(); reconcileAllocations(); render(); renderRule(); renderLand();
                    });
                } catch (error) { render(error.message); report(error); }
            });
        }
        // Inspect original input geometry even after a layout has replaced its live parcel. These
        // overlays never select a design, open another panel or alter the plan's membership.
        function inspectionFeatures(button) {
            const id = button.dataset.agreementObjectId;
            if (button.dataset.agreementInspect === 'parcel') {
                const original = root.CadastralParcelRepository.get(id);
                return original?.geometry ? [original] : [];
            }
            const design = state.designs.find(record => idOf(record.proposalId) === id);
            return design ? root.MapPick.outlineOf(design) : [];
        }
        function clearInspection() {
            root.clearProposalHoverLayers();
            root.highlightFeaturesForInspection([]);
            body.querySelectorAll('[data-agreement-inspect]').forEach(button => button.setAttribute('aria-pressed', 'false'));
        }
        function hoverInspection(event, entering) {
            const button = event.target.closest('[data-agreement-inspect]');
            if (!button || button.contains(event.relatedTarget)) return;
            if (!entering) { root.clearProposalHoverLayers(); return; }
            root.highlightFeatureGroupsForHover([{ features: inspectionFeatures(button), className: 'agreement-map-hover' }]);
        }
        body.addEventListener('pointerover', event => hoverInspection(event, true), { signal });
        body.addEventListener('pointerout', event => hoverInspection(event, false), { signal });
        body.addEventListener('focusin', event => hoverInspection(event, true), { signal });
        body.addEventListener('focusout', event => hoverInspection(event, false), { signal });
        form.addEventListener('submit', event => {
            event.preventDefault(); if (state.loading || (state.values.electorate === 'community' && rosterPending)) return;
            state.attempted = true;
            try {
                readRule(); const record = draft(); const checked = api.validate(record, { designOf: id => root.proposalStorage.getProposal(id), isApplied: root.isApplied });
                if (!checked.valid) { issues(); return; }
                finish(root.AgreementStore.save(record));
            } catch (error) { part('[data-agreement-errors]').textContent = error.message; report(error); }
        }, { signal });
        panel.addEventListener('click', event => {
            const button = event.target.closest('button'); if (!button) return;
            if (button.dataset.agreementInspect) {
                root.clearProposalHoverLayers();
                root.highlightFeaturesForInspection(inspectionFeatures(button), { className: 'agreement-map-focus' });
                body.querySelectorAll('[data-agreement-inspect]').forEach(row => row.setAttribute('aria-pressed', String(row === button)));
            }
            if (button.dataset.agreementAction === 'cancel') finish(null);
            if (button.dataset.agreementTab) activate(button.dataset.agreementTab);
            if (['rights', 'lens'].includes(button.dataset.agreementAction)) openAuxiliary(button.dataset.agreementAction);
            if (button.dataset.agreementAction === 'apply-plan' && !root.BusyControl.isBusy(button)) {
                root.BusyControl.track(button, async () => {
                    // A private saved plan carries its exact revisions. Applying it must not try
                    // to download unpublished members from the public design index.
                    const draftRows = new Map();
                    for (const member of state.plan.designs || []) {
                        const content = member.content;
                        const parcelSourceId = root.DesignSync.parcelSourceIdOf(content.city, content.site);
                        const response = await root.fetch(root.resolveBackendBaseUrl().replace(/\/$/, '') + '/designs/binding', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                                city: content.city, site: root.__siteBinding.siteOf(content, { turf: root.turf }),
                                toleranceM: content.toleranceM, parcelSourceId })
                        });
                        const answer = await response.json();
                        if (!response.ok) throw new Error(answer.error || 'The plan ground could not be read.');
                        draftRows.set(member.cid, { cid: member.cid, content, city: content.city, parcelSourceId, binding: answer.binding });
                    }
                    const result = await root.handleSharedDesignRoute(state.plan.content.designCids, {
                        ...(draftRows.size ? { draftRows } : {}), openDetails: false, enter3D: false, summary: false });
                    if (result.blocked || result.failed.length || result.omitted?.length) throw new Error(t('agreement.workflow.planNotApplied', 'Apply every design of this saved plan before reading its land.'));
                    if (!state.closed) await deriveLand();
                }).catch(report);
            }
            const action = button.dataset.editorAction;
            if (action && button.closest('[data-agreement-rule-form]')) {
                try { state.approvalConfig = setup().withRuleAction(part('[data-agreement-rule-form]'), state.approvalConfig, action, button.dataset.testIndex); renderRule(); issues(); }
                catch (error) { report(error); }
            }
        }, { signal });
        body.addEventListener('keydown', event => {
            const tab = event.target.closest('[data-agreement-tab]'); if (!tab) return;
            const index = TABS.indexOf(tab.dataset.agreementTab);
            const next = { ArrowRight: (index + 1) % 4, ArrowLeft: (index + 3) % 4, Home: 0, End: 3 }[event.key];
            if (next !== undefined) { event.preventDefault(); activate(TABS[next], true); }
        }, { signal });
        body.addEventListener('change', event => {
            const target = event.target;
            try {
                if (target.matches('[data-agreement-plan]')) {
                    readRule(); state.plan = state.plans.find(plan => plan.cid === target.value) || null;
                    state.values.allocations = {}; deriveLand(); return;
                }
                if (target.closest('[data-agreement-rule-form]')) { readRule(); renderRule(); renderPersons(); issues(); return; }
                if (target.matches('[data-agreement-allocation-mode]')) {
                    state.allocationMode = target.value; reconcileAllocations(); renderLand(); return;
                }
                if (target.matches('[data-agreement-allocation]')) state.values.allocations[target.dataset.agreementAllocation] = target.value;
                if (target.matches('[data-agreement-binding]')) state.values.binding = target.checked;
                if (target.matches('[data-agreement-electorate]')) {
                    readRule(); state.values.electorate = target.value; state.values.binding = false; renderRule(); renderLand();
                }
                if (target.matches('[data-agreement-compensation]')) {
                    state.values.settlement.method = target.value;
                    if (target.value === 'none') state.values.settlement.contributionBasisPoints = 0;
                    renderRule();
                }
                renderPersons(); issues();
            } catch (error) { report(error); }
        }, { signal });
        body.addEventListener('input', event => {
            const target = event.target, terms = state.values.settlement;
            if (target.matches('[data-agreement-rate-slider]')) {
                terms.rateCentsPerM2 = Number(target.value); part('[data-agreement-rate]').value = terms.rateCentsPerM2 / 100;
            } else if (target.matches('[data-agreement-rate]')) {
                const rate = Number(target.value); terms.rateCentsPerM2 = target.value.trim() && Number.isFinite(rate) ? Math.round(rate * 100) : NaN;
                part('[data-agreement-rate-slider]').value = terms.rateCentsPerM2;
            } else if (target.matches('[data-agreement-contribution]')) {
                terms.contributionBasisPoints = Number(target.value); part('[data-agreement-contribution-value]').value = `${terms.contributionBasisPoints / 100}%`;
            } else if (target.matches('[data-agreement-title]')) state.values.title = target.value;
            else if (target.matches('[data-agreement-deadline]')) state.values.deadline = target.value;
            else if (target.matches('[data-agreement-organiser]')) state.values.organiser = target.value;
            else if (target.matches('[data-agreement-participation-url]')) state.values.participationUrl = target.value;
            renderPersons(); issues();
        }, { signal });
        unregisterEscape = root.ModalEscape?.register(panel, event => { if (typingIn(event.target)) return false; finish(null); return true; });
        modal.addEventListener('cancel', event => event.preventDefault(), { signal });
        // Local controls receive their keys; page-level drawing and navigation shortcuts do not.
        modal.addEventListener('keydown', event => event.stopPropagation(), { signal });
        panel.classList.add('visible'); doc.body.classList.add('agreement-editor-open');
        modal.showModal(); panel.querySelector('#agreement-editor-title').focus({ preventScroll: true });
        try { renderRule(); await deriveLand(); }
        catch (error) { finish(null); throw error; }
        log(`opened ${state.id} for plan ${state.plan?.cid || '(choose plan)'}`);
        return closed;
    }
    return {
        open, SCHEMA, LOCAL_RIGHTS_PROVIDER, appliedDesigns, designTitle, inputParcelIds, originalsById,
        partiesOf, allocationOptions, allocationValue, allocationTo, allocationMode, cashCents, cashInputText, termsOf,
        keptTerms, sponsorLine, ruleConfigAfterDerive, deadlineFromDate, dateFromDeadline, recordFromForm,
        issueText, holdersText, landHtml, allocationHtml, ruleHtml, detailsHtml,
        consultationHtml, bodyHtml, personsHtml, planSelectorHtml, inputDesignsHtml
    };
});
