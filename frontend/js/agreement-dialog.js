// Plan-first agreement editor: rules, input parcels, single-recipient output parcels and a
// read-only persons tally: one abstract party per input parcel, and the people behind those parties
// derived from the ownership rights when they are loaded. Ground comes from one exact saved plan; compensation comes from its
// agreement rules: by area (a rate per m²) or by value (a value per m² typed for every input parcel
// and resulting piece). A scheme chosen in Rules is checked live against the plan: the dropdown
// marks schemes the plan breaks, the scheme card lists the check, and a broken rule blocks saving.
// Ownership rights and lens settings open separate shared dialogs. Pure helpers are exercised by
// the targeted agreement accounting/store tests; open() connects them to the dock.
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
    const recordLabel = () => root.RecordLabel || (typeof require === 'function' ? require('./ui/record-label.js') : null);
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

    const recordApi = () => root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);
    const personsApi = () => root.AgreementPersons || (typeof require === 'function' ? require('./agreement-persons.js') : null);

    // The abstract party standing for an input parcel's owner(s) (AgreementRecord.partyKey).
    function partyLabel(parcelId) {
        return t('agreement.party.parcelOwners', 'Owner(s) of parcel {{parcelId}}', { parcelId });
    }

    // Who owns an input parcel: "Ana 50%, Ben 50%" from complete ownership rights, otherwise its
    // abstract party. `names` maps owner ids to names (local owner records) where known.
    function ownersText(parcelId, rights, names = new Map()) {
        const row = rights && Array.isArray(rights.parcels) ? rights.parcels.find(entry => entry && idOf(entry.parcelId) === idOf(parcelId)) : null;
        const owners = row && row.complete === true && Array.isArray(row.owners) ? row.owners : [];
        const prefix = recordApi().PARTY_PREFIX;
        if (!owners.length || owners.some(owner => idOf(owner.ownerId).startsWith(prefix))) return partyLabel(parcelId);
        return owners.map(owner => {
            const [n, d] = String(owner.share).split('/').map(Number);
            return `${names.get(owner.ownerId) || owner.ownerId} ${shareText(n / d)}`.trim();
        }).join(', ');
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

    // The parties: one abstract party per input parcel, its owner(s), in the parcels' order.
    function partiesOf(inputs) {
        return (inputs && Array.isArray(inputs.parcels) ? inputs.parcels : []).filter(parcel => parcel && idOf(parcel.parcelId))
            .map(parcel => ({ ownerKey: recordApi().partyKey(idOf(parcel.parcelId)), displayName: partyLabel(idOf(parcel.parcelId)) }));
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
        if (!to || typeof to !== 'object') return '';
        if (to.kind === 'public' || to.kind === 'proposer') return to.kind;
        if (to.kind === 'party' && idOf(to.ownerKey)) return `party:${idOf(to.ownerKey)}`;
        return '';
    }

    function allocationTo(value) {
        const text = idOf(value);
        if (text === 'public' || text === 'proposer') return { kind: text };
        if (text.startsWith('party:') && text.length > 'party:'.length) return { kind: 'party', ownerKey: text.slice('party:'.length) };
        return null;
    }

    // Randomize (Allocate output parcels): the persons in a random order, each piece in turn to the
    // next one, so every person receives a piece before anyone receives a second, and then the order
    // starts again. `random` returns [0, 1) like Math.random. No persons: no allocations.
    function randomAllocations(inputs, outputs, random = Math.random) {
        const parties = partiesOf(inputs).map(party => `party:${party.ownerKey}`);
        for (let i = parties.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [parties[i], parties[j]] = [parties[j], parties[i]];
        }
        if (!parties.length) return {};
        return Object.fromEntries((Array.isArray(outputs) ? outputs : []).map((output, index) => [output.hash, parties[index % parties.length]]));
    }

    // How the pieces fall to the persons: how many receive none and how many more than one.
    function allocationSpread(inputs, allocations = {}) {
        const counts = new Map(partiesOf(inputs).map(party => [`party:${party.ownerKey}`, 0]));
        Object.values(allocations || {}).forEach(value => { if (counts.has(value)) counts.set(value, counts.get(value) + 1); });
        const values = [...counts.values()];
        return { persons: values.length, without: values.filter(count => count === 0).length, several: values.filter(count => count > 1).length };
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
            if (line && idOf(line.output) && value) allocations[idOf(line.output)] = value;
        });
        const cash = {};
        (agreement && agreement.money && Array.isArray(agreement.money.lines) ? agreement.money.lines : []).forEach(line => {
            if (line && idOf(line.ownerKey) && isNumber(line.amountCents)) cash[idOf(line.ownerKey)] = centsText(line.amountCents);
        });
        const valuation = { inputs: {}, outputs: {} };
        const stored = agreement && agreement.valuation;
        (stored && Array.isArray(stored.inputs) ? stored.inputs : []).forEach(row => {
            if (row && idOf(row.parcelId) && isNumber(row.unitValueCents)) valuation.inputs[idOf(row.parcelId)] = row.unitValueCents;
        });
        (stored && Array.isArray(stored.outputs) ? stored.outputs : []).forEach(row => {
            if (row && idOf(row.output) && isNumber(row.unitValueCents)) valuation.outputs[idOf(row.output)] = row.unitValueCents;
        });
        return { allocations, cash, valuation };
    }

    // The typed land values as the record's valuation: one row per input parcel and resulting piece
    // that has a value (a missing one is reported by the validation, never invented).
    function valuationRows(valuation = {}, parcels = [], outputs = []) {
        const inputs = valuation.inputs || {}, pieces = valuation.outputs || {};
        return {
            inputs: parcels.filter(parcel => isNumber(inputs[idOf(parcel.parcelId)])).map(parcel => ({ parcelId: idOf(parcel.parcelId), unitValueCents: inputs[idOf(parcel.parcelId)] })),
            outputs: outputs.filter(output => isNumber(pieces[output.hash])).map(output => ({ output: output.hash, unitValueCents: pieces[output.hash] }))
        };
    }

    // What survives a new derivation of the land: allocations of pieces that still exist, to parties
    // that still hold input land, and the readable cash of those parties. The rest is dropped.
    function keptTerms({ allocations = {}, cash = {}, valuation = {} } = {}, land) {
        const hashes = new Set((land && Array.isArray(land.outputs) ? land.outputs : []).map(output => output && output.hash));
        const parties = new Set(partiesOf(land && land.inputs).map(party => party.ownerKey));
        const parcelIds = new Set((land && land.inputs && Array.isArray(land.inputs.parcels) ? land.inputs.parcels : []).map(parcel => parcel && idOf(parcel.parcelId)));
        const keptValuation = { inputs: {}, outputs: {} };
        Object.keys((valuation && valuation.inputs) || {}).forEach(id => { if (parcelIds.has(id) && isNumber(valuation.inputs[id])) keptValuation.inputs[id] = valuation.inputs[id]; });
        Object.keys((valuation && valuation.outputs) || {}).forEach(hash => { if (hashes.has(hash) && isNumber(valuation.outputs[hash])) keptValuation.outputs[hash] = valuation.outputs[hash]; });
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
        return { allocations: keptAllocations, cash: keptCash, valuation: keptValuation };
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

    // ---- affected neighbours ---------------------------------------------------------------------

    // Literal keys, so the locale coverage test sees each one. The closed lists are the record's
    // (AgreementRecord.AFFECTED_RIGHTS, AFFECTED_EFFECTS, LOSS_STATERS).
    const RIGHT_TEXT = {
        daylight: () => t('agreement.neighbours.right.daylight', 'Daylight'),
        sunlight: () => t('agreement.neighbours.right.sunlight', 'Sunlight'),
        outlook: () => t('agreement.neighbours.right.outlook', 'Outlook and sky'),
        garden: () => t('agreement.neighbours.right.garden', 'Garden limit'),
        privacy: () => t('agreement.neighbours.right.privacy', 'Privacy and overlooking'),
        other: () => t('agreement.neighbours.right.other', 'Another right (say which in the note)')
    };
    const EFFECT_TEXT = {
        waiver: () => t('agreement.neighbours.effect.waiver', 'Waiver: they give the right and must approve'),
        compensation: () => t('agreement.neighbours.effect.compensation', 'Compensation: owed without their consent')
    };
    const STATER_TEXT = {
        sponsor: () => t('agreement.neighbours.stater.sponsor', 'Sponsor’s estimate'),
        valuer: () => t('agreement.neighbours.stater.valuer', 'Valuer')
    };
    const GRADE_TEXT = {
        fail: () => t('agreement.neighbours.grade.fail', 'beyond a guide'),
        below: () => t('agreement.neighbours.grade.below', 'under a guide’s level, within its allowance'),
        minor: () => t('agreement.neighbours.grade.minor', 'a minor loss'),
        screen: () => t('agreement.neighbours.grade.screen', 'a first check crossed')
    };
    // The Effects on neighbours reading names, as that section words them.
    const KIND_TEXT = {
        garden: () => t('neighbourEffects.kind.garden', 'Garden sunlight'), sunlight: () => t('neighbourEffects.kind.sunlight', 'Sunlight to windows'),
        sky: () => t('neighbourEffects.kind.sky', 'Sky'), noSky: () => t('neighbourEffects.kind.noSky', 'Room daylight'),
        angle: () => t('neighbourEffects.kind.angle', 'Angle'), splay: () => t('neighbourEffects.kind.splay', 'Splay'),
        distance: () => t('neighbourEffects.kind.distance', 'Facing distance')
    };
    const PRESET_TEXT = {
        'gb-strong-suburbs': () => t('agreement.neighbours.multiple.strongSuburbs', 'Strong Suburbs: 150% of the stated loss (figure not yet verified)')
    };

    const numberText = (value, digits = 1) => {
        const format = root.CbFormat;
        return format && typeof format.formatNumber === 'function' ? format.formatNumber(value, { maxFractionDigits: digits }) : String(Math.round(value * 10 ** digits) / 10 ** digits);
    };
    // A multiple in basis points as "1.5×".
    const multipleText = basisPoints => `${numberText(basisPoints / 10000, 2)}×`;

    // A snapshot reading in words, in its kind's unit: shares as percentages, the sky and sunlight in
    // percent, angles in degrees, depths and distances in metres. Its guide is the place's.
    function readingText(reading) {
        const kind = reading && reading.kind;
        const value = number => {
            if (!isNumber(number)) return '—';
            if (kind === 'garden' || kind === 'noSky') return shareText(number);
            if (kind === 'sky' || kind === 'sunlight') return `${numberText(number)}%`;
            if (kind === 'angle') return `${numberText(number, 0)}°`;
            return `${numberText(number)} m`;
        };
        const guide = !isNumber(reading.guide) ? '—' : kind === 'noSky' ? `${numberText(reading.guide, 2)}×`
            : kind === 'splay' ? `${numberText(reading.guide, 0)}°` : value(reading.guide);
        return t('agreement.neighbours.reading', '{{kind}}: {{before}} → {{after}} (guide {{guide}}), {{grade}}', {
            kind: KIND_TEXT[kind] ? KIND_TEXT[kind]() : String(kind), before: value(reading.before), after: value(reading.after), guide,
            grade: GRADE_TEXT[reading.grade] ? GRADE_TEXT[reading.grade]() : String(reading.grade)
        });
    }

    // A plot of the Effects on neighbours result (NeighbourEffects.snapshot) as a new affected parcel:
    // a waiver with no payment yet, to be set by the sponsor.
    function affectedEntry(snapshot) {
        return { parcelId: idOf(snapshot.parcelId), effect: 'waiver', rights: Array.isArray(snapshot.rights) ? snapshot.rights.slice() : [],
            note: null, readings: Array.isArray(snapshot.readings) ? snapshot.readings.slice() : [], loss: null, considerationCents: 0 };
    }

    // After measuring: a tick box per affected plot (those beyond a guide ticked), the plots already
    // added or among the inputs disabled, and the action that adds the ticked ones.
    function candidatesHtml(result, { ticked = new Set(), addedIds = new Set(), inputIds = new Set() } = {}) {
        const lots = result && Array.isArray(result.lots) ? result.lots : [];
        if (!lots.length) return '';
        const rows = lots.map(lot => {
            const id = idOf(lot.id);
            const taken = addedIds.has(id) || inputIds.has(id);
            const grade = GRADE_TEXT[lot.status] ? GRADE_TEXT[lot.status]() : '';
            const label = t('agreement.neighbours.candidate', 'Parcel {{parcelId}}, {{grade}}', { parcelId: id, grade })
                + (addedIds.has(id) ? ` · ${t('agreement.neighbours.added', 'already in this agreement')}` : inputIds.has(id) ? ` · ${t('agreement.neighbours.isInput', 'an input parcel')}` : '');
            return `<li><label class="proposal-editor-check"><input type="checkbox" data-agreement-neighbour-candidate="${esc(id)}"${ticked.has(id) && !taken ? ' checked' : ''}${taken ? ' disabled' : ''}> ${esc(label)}</label></li>`;
        }).join('');
        const count = lots.filter(lot => ticked.has(idOf(lot.id)) && !addedIds.has(idOf(lot.id)) && !inputIds.has(idOf(lot.id))).length;
        return `<fieldset class="agreement-fieldset agreement-neighbour-candidates" data-agreement-neighbour-candidates-list><legend>${esc(t('agreement.neighbours.candidates', 'Add affected plots to this agreement'))}</legend>`
            + `<p class="agreement-hint">${esc(t('agreement.neighbours.candidatesHint', 'Plots beyond a guide are ticked. Each is added as a waiver with its readings; set its terms below.'))}</p>`
            + `<ul class="agreement-neighbour-candidates__list">${rows}</ul>`
            + `<button type="button" class="btn btn-primary" data-agreement-action="neighbours-add-ticked"${count ? '' : ' disabled'}>${esc(t('agreement.neighbours.addTicked', 'Add ticked plots ({{count}})', { count }))}</button></fieldset>`;
    }

    // One affected parcel's terms: its case, the rights it gives, a note, its readings, a stated loss
    // and who stated it, and the payment (derived from the loss for compensation with a stated loss).
    function affectedRowHtml(entry, { currency = '', multiple = 10000, rights = null, names = new Map() } = {}) {
        const id = idOf(entry.parcelId);
        const key = `affected-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        const field = (name, label, control) => `<label class="proposal-editor-field"><span>${esc(label)}</span>${control}</label>`;
        const select = (name, value, options) => `<select data-affected-field="${name}">${options.map(([option, text]) => `<option value="${esc(option)}"${option === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
        const given = new Set(Array.isArray(entry.rights) ? entry.rights : []);
        const loss = entry.loss || null;
        const derived = entry.effect === 'compensation' && loss && Number.isSafeInteger(loss.amountCents);
        const readings = Array.isArray(entry.readings) && entry.readings.length
            ? `<ul class="agreement-affected__readings" aria-label="${esc(t('agreement.neighbours.readings', 'Readings when added'))}">${entry.readings.map(reading => `<li>${esc(readingText(reading))}</li>`).join('')}</ul>`
            : `<p class="agreement-hint">${esc(t('agreement.neighbours.noReadings', 'No readings: added by its parcel id.'))}</p>`;
        return `<li class="agreement-affected" data-agreement-affected="${esc(id)}"><fieldset class="agreement-fieldset" aria-labelledby="${key}-legend">`
            + `<legend id="${key}-legend">${esc(ownersText(id, rights, names) === partyLabel(id) ? partyLabel(id) : `${partyLabel(id)}: ${ownersText(id, rights, names)}`)}</legend>`
            + field('effect', t('agreement.neighbours.effectLabel', 'Case'), select('effect', entry.effect, [['waiver', EFFECT_TEXT.waiver()], ['compensation', EFFECT_TEXT.compensation()]]))
            + `<fieldset class="agreement-affected__rights"><legend>${esc(t('agreement.neighbours.rights', 'Rights given'))}</legend>`
            + recordApi().AFFECTED_RIGHTS.map(right => `<label class="proposal-editor-check"><input type="checkbox" data-affected-right="${right}"${given.has(right) ? ' checked' : ''}> ${esc(RIGHT_TEXT[right]())}</label>`).join('')
            + '</fieldset>'
            + field('note', t('agreement.neighbours.note', 'Note (which right, if another)'), `<input type="text" data-affected-field="note" value="${esc(entry.note || '')}" autocomplete="off">`)
            + readings
            + field('loss', t('agreement.neighbours.loss', 'Stated loss in market value ({{currency}})', { currency }),
                `<input type="number" min="0" step="0.01" data-affected-field="loss" value="${esc(loss ? centsText(loss.amountCents) : '')}">`)
            + field('statedBy', t('agreement.neighbours.statedBy', 'Loss stated by'), select('statedBy', loss ? loss.statedBy : 'sponsor', [['sponsor', STATER_TEXT.sponsor()], ['valuer', STATER_TEXT.valuer()]]))
            + field('valuerRef', t('agreement.neighbours.valuerRef', 'Valuer reference (optional)'), `<input type="text" data-affected-field="valuerRef" value="${esc(loss && loss.valuerRef || '')}" autocomplete="off">`)
            + field('consideration', t('agreement.neighbours.payment', 'Payment to them ({{currency}})', { currency }),
                `<input type="number" min="0" step="0.01" data-affected-field="consideration" value="${esc(centsText(entry.considerationCents))}"${derived ? ' readonly aria-readonly="true"' : ''}>`)
            + (derived ? `<p class="agreement-hint" data-affected-derived>${esc(t('agreement.neighbours.derived', '{{multiple}} the stated loss, as Rules set it.', { multiple: multipleText(multiple) }))}</p>` : '')
            + `<button type="button" class="btn btn-sm" data-affected-remove="${esc(id)}">${esc(t('agreement.neighbours.remove', 'Remove {{parcelId}} from the agreement', { parcelId: id }))}</button>`
            + '</fieldset></li>';
    }

    // The Neighbours tab's list and its add-by-id control; owners' agreements only.
    function neighboursHtml({ entries = [], electorate = 'owners', currency = '', multiple = 10000, rights = null, names = new Map() } = {}) {
        if (electorate !== 'owners') return `<p class="agreement-notice">${esc(t('agreement.neighbours.ownersOnly', 'Affected neighbours are parties to an owners’ agreement only.'))}</p>`;
        const list = entries.length
            ? `<ul class="agreement-affected-list" data-agreement-affected-list>${entries.map(entry => affectedRowHtml(entry, { currency, multiple, rights, names })).join('')}</ul>`
            : `<p class="agreement-hint" data-agreement-affected-empty>${esc(t('agreement.neighbours.none', 'No affected neighbours yet.'))}</p>`;
        return list + `<div class="agreement-neighbour-add"><label class="proposal-editor-field"><span>${esc(t('agreement.neighbours.byId', 'Add a neighbouring parcel by its id'))}</span>`
            + '<input type="text" data-agreement-neighbour-id autocomplete="off"></label>'
            + `<button type="button" class="btn" data-agreement-action="neighbour-add">${esc(t('agreement.neighbours.add', 'Add neighbour'))}</button></div>`;
    }

    // Rules: the multiple of a neighbour's stated loss that compensation pays, a preset or another.
    function neighbourCompensationHtml(terms) {
        const api = recordApi();
        const preset = terms && terms.preset ? `${terms.preset.id}@${terms.preset.version}` : '';
        const value = !terms ? '' : preset || 'custom';
        const options = [['', t('agreement.neighbours.multiple.none', '1× the stated loss (none set)')],
            ...api.NEIGHBOUR_PRESETS.map(row => [`${row.id}@${row.version}`, PRESET_TEXT[row.id] ? PRESET_TEXT[row.id]() : row.id]),
            ['custom', t('agreement.neighbours.multiple.custom', 'Another multiple')]];
        const chosen = preset ? api.neighbourPreset(terms.preset.id, terms.preset.version) : null;
        return `<label class="proposal-editor-field"><span>${esc(t('agreement.neighbours.multiple.label', 'Compensation to neighbours'))}</span><select data-agreement-neighbour-preset>`
            + options.map(([option, text]) => `<option value="${esc(option)}"${option === value ? ' selected' : ''}>${esc(text)}</option>`).join('') + '</select></label>'
            + `<label class="proposal-editor-field"${value === 'custom' ? '' : ' hidden'}><span>${esc(t('agreement.neighbours.multiple.value', 'Multiple of the stated loss'))}</span>`
            + `<input type="number" min="0.01" step="0.01" data-agreement-neighbour-multiple value="${esc(terms ? String(terms.multipleBasisPoints / 10000) : '')}"></label>`
            + (chosen ? `<p class="agreement-hint" data-agreement-neighbour-source><a class="cb-link cb-link--external" href="${esc(chosen.source.url)}" target="_blank" rel="noopener">${esc(chosen.source.name)}</a></p>` : '');
    }

    // An agreement's affected parcels in words, for read-only views (agreement panel, record, signing).
    function affectedRows(agreement, currency) {
        const rule = (agreement && agreement.rule) || {};
        return (agreement && Array.isArray(agreement.affected) ? agreement.affected : []).map(entry => ({
            parcelId: idOf(entry.parcelId),
            party: ownersText(entry.parcelId, rule.approvalConfig && rule.approvalConfig.rights),
            effect: EFFECT_TEXT[entry.effect] ? EFFECT_TEXT[entry.effect]() : String(entry.effect),
            rights: (entry.rights || []).map(right => (RIGHT_TEXT[right] ? RIGHT_TEXT[right]() : String(right))).join(', ') + (entry.note ? ` (${entry.note})` : ''),
            loss: entry.loss && isNumber(entry.loss.amountCents) ? `${moneyText(entry.loss.amountCents, currency)} · ${STATER_TEXT[entry.loss.statedBy] ? STATER_TEXT[entry.loss.statedBy]() : entry.loss.statedBy}${entry.loss.valuerRef ? ` (${entry.loss.valuerRef})` : ''}` : '—',
            payment: isNumber(entry.considerationCents) ? moneyText(entry.considerationCents, currency) : '—',
            readings: (entry.readings || []).map(readingText)
        }));
    }

    // ---- details ---------------------------------------------------------------------------------

    // A date field's day → the end of that day in local time, as ISO; a day that is not one stays as
    // typed so the validation names it. An ISO deadline → its local day for the field.
    function deadlineFromDate(text, milliseconds = 999) {
        const value = String(text ?? '').trim();
        if (!value) return null;
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) return value;
        const [year, month, day] = match.slice(1).map(Number);
        const fraction = Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 999 ? milliseconds : 999;
        const date = new Date(year, month - 1, day, 23, 59, 59, fraction);
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
     *   approvalConfig, lens (member keys), lensThreshold (how many must confirm; 1 when absent),
     *   currency (the agreement's city's money) }
     * values: { allocations ({ outputHash: select value }), cash ({ ownerKey: typed amounts }),
     *   valuation ({ inputs: { parcelId: cents per m² }, outputs: { outputHash: cents per m² } }),
     *   affected (the record's affected parcels), neighbourCompensation (the rule's multiple, or null),
     *   settlement, electorate ('owners' | 'community'), binding, title, deadline (the date field's day),
     *   organiser (website or did:web), participationUrl (HTTPS) }
     */
    // The rule's lens: the member keys and, only when more than one must confirm, lensThreshold.
    function lensRule(state) {
        const lens = Array.isArray(state.lens) ? state.lens.slice() : [];
        const threshold = Number(state.lensThreshold);
        return { lens, ...(lens.length > 1 && Number.isInteger(threshold) && threshold > 1 ? { lensThreshold: Math.min(threshold, lens.length) } : {}) };
    }

    function recordFromForm(state = {}, values = {}) {
        if (values.electorate === 'investors') {
            const funding = values.funding || {};
            const records = Array.isArray(state.designs) ? state.designs.filter(Boolean) : [];
            const rawFunding = { schema: SCHEMA, id: idOf(state.id), title: String(values.title || '').trim() || null,
                city: state.city || null, createdAt: state.createdAt || null, updatedAt: state.updatedAt || null,
                plan: state.plan || null, designs: records.map(record => ({
                    proposalId: idOf(record.proposalId), title: designTitle(record),
                    goal: typeof record.goal === 'string' ? record.goal : null,
                    cid: idOf(record.published?.cid || record.cid || state.fingerprints?.get?.(idOf(record.proposalId))) || null
                })), inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [],
                money: { currency: state.currency || null, lines: [] }, valuation: null,
                rule: { electorate: 'investors', binding: true, approvalConfig: null, settlement: null, ...lensRule(state) }, consultation: null,
                deadline: values.fundingDeadlineDirty ? deadlineFromDate(values.deadline, 0)
                    : (values.fundingDeadline || deadlineFromDate(values.deadline, 0)),
                funding: { targetUsdcAtomic: funding.targetUsdcAtomic || '', contract: funding.contract || null,
                    ...(funding.apartments ? { apartments: { projectId: funding.apartments.projectId, units: (funding.apartments.units || []).map(unit => ({
                        unitId: unit.unitId, label: unit.label, xrayBuilding: unit.xrayBuilding, unit: unit.unit, at: unit.at,
                        priceUsdcAtomic: unit.priceUsdcAtomic, depositUsdcAtomic: unit.depositUsdcAtomic, drawing: unit.drawing,
                        ...(unit.access ? { access: unit.access } : {}) })) } } : {}) } };
            return rawFunding;
        }
        const land = state.land || emptyLand();
        const inputs = land.inputs || emptyLand().inputs;
        const outputs = Array.isArray(land.outputs) ? land.outputs : [];
        const fingerprints = state.fingerprints instanceof Map ? state.fingerprints : new Map(Object.entries(state.fingerprints || {}));
        const records = Array.isArray(state.designs) ? state.designs.filter(Boolean) : [];
        const chosen = values.allocations || {};
        const owners = values.electorate !== 'community' && values.electorate !== 'investors';
        const title = String(values.title ?? '').trim();
        const plan = state.plan || null;
        const recordApi = root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);
        const settlement = values.settlement || { ...recordApi.DEFAULT_SETTLEMENT };
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
            valuation: owners && settlement.method === 'value' ? valuationRows(values.valuation, inputs.parcels || [], outputs) : null,
            // Neighbours who give a right and no land; their cash lines are derived by settle.
            affected: owners && Array.isArray(values.affected) ? values.affected : [],
            rule: owners
                ? { electorate: 'owners', binding: values.binding === true, approvalConfig: state.approvalConfig || null, ...lensRule(state), settlement,
                    ...(values.neighbourCompensation ? { neighbourCompensation: values.neighbourCompensation } : {}) }
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
        'allocation-required': () => t('agreement.errors.allocationRequired', 'Choose one recipient for every output parcel.'),
        'settlement-invalid': () => t('agreement.errors.settlementInvalid', 'Set compensation within the scheme’s limits.'),
        'valuation-missing': () => t('agreement.errors.valuationMissing', 'Settlement by value needs a value per m² for every input parcel and every resulting piece.'),
        'valuation-invalid': () => t('agreement.errors.valuationInvalid', 'A value per m² must be an amount of at least 0.'),
        'valuation-unknown': () => t('agreement.errors.valuationUnknown', 'A value per m² names a parcel or piece that is not in this agreement.'),
        'valuation-zero': () => t('agreement.errors.valuationZero', 'The input land needs a value above zero to settle by value.'),
        'valuation-unused': () => t('agreement.errors.valuationUnused', 'Land values apply to settlement by value only.'),
        'scheme-basis': reason => t('agreement.errors.schemeRule', '{{reason}}', { reason }),
        'scheme-cap': reason => t('agreement.errors.schemeRule', '{{reason}}', { reason }),
        'scheme-parties': reason => t('agreement.errors.schemeRule', '{{reason}}', { reason }),
        'scheme-proposer': reason => t('agreement.errors.schemeRule', '{{reason}}', { reason }),
        'money-unbalanced': () => t('agreement.errors.moneyUnbalanced', 'Cash must match the compensation calculated from the rules.'),
        'affected-input': () => t('agreement.errors.affectedInput', 'An input parcel’s owners are already parties: remove it from Neighbours.'),
        'affected-effect': () => t('agreement.errors.affectedEffect', 'Choose waiver or compensation for every neighbour.'),
        'affected-rights': () => t('agreement.errors.affectedRights', 'Tick at least one right each neighbour gives.'),
        'affected-note': () => t('agreement.errors.affectedNote', 'Say in the note which other right a neighbour gives.'),
        'affected-reading': () => t('agreement.errors.affectedReading', 'A neighbour’s readings name a kind or grade the app does not measure.'),
        'affected-amount': () => t('agreement.errors.affectedAmount', 'A neighbour’s payment and stated loss must be amounts of at least 0, with who stated the loss.'),
        'affected-loss-required': () => t('agreement.errors.affectedLossRequired', 'Compensation is a multiple of a stated loss: state each compensated neighbour’s loss.'),
        'affected-consideration': () => t('agreement.errors.affectedConsideration', 'A compensated neighbour’s payment must be the set multiple of their stated loss.'),
        'affected-electorate': () => t('agreement.errors.affectedElectorate', 'Only an owners’ agreement can carry affected neighbours.'),
        'neighbour-multiple': () => t('agreement.errors.neighbourMultiple', 'Set a positive multiple of the stated loss for compensating neighbours.'),
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
        'voting-eligibility-no-houses': () => t('agreement.errors.eligibilityNoHouses', 'The plan raises no existing building with a mansard, so this street vote has nothing to cover.'),
        'voting-eligibility-missing': () => t('agreement.errors.eligibilityMissing', 'Check the covered houses’ eligibility before creating this street vote.'),
        'voting-eligibility-stale': () => t('agreement.errors.eligibilityStale', 'The plan covers other houses than the last eligibility check: check again.'),
        'voting-eligibility-failed': () => t('agreement.errors.eligibilityFailed', 'Not every covered house is known to be eligible yet: see Covered houses.'),
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

    // A distribution rule of the chosen scheme the plan breaks (AgreementRecord.settlementIssues
    // 'scheme-*'): the scheme's name and the rule's own line (ProposalApprovalText.checkLines), the
    // owner by display name. The validator's English message when those modules are not loaded.
    function schemeIssueText(issue) {
        const regimes = root.ProposalApprovalRegimes || (typeof require === 'function' ? require('./proposals/approval-regimes.js') : null);
        const words = root.ProposalApprovalText || (typeof require === 'function' ? require('./proposals/approval-text.js') : null);
        const template = regimes && issue.scheme ? regimes.get(issue.scheme, issue.version) : null;
        const line = words && issue.rule ? words.checkLines({ rules: [issue.rule] }, t, () => issue.ownerName || issue.ownerKey || '')[0] : null;
        if (!template || !line) return idOf(issue.message) || idOf(issue.code);
        return `${t(`proposalApproval.schemes.${template.id}.name`, template.text.name)}: ${line}`;
    }

    // An error or warning of AgreementRecord.validate ({ code, message, reason? }) in the UI language.
    // A code this dialog does not know shows the validator's own message.
    function issueText(issue) {
        const code = idOf(issue && issue.code);
        const word = ISSUE_TEXT[code];
        if (code.startsWith('scheme-')) return word(schemeIssueText(issue));
        if (!word) return idOf(issue && issue.message) || code;
        if (!NEEDS_REASON.has(code)) return word();
        // The engine's readiness code when there is one (rule-not-ready), else the validator's own
        // words (an invalid rule says what is wrong with it).
        const reason = idOf(issue.reason ?? (issue.params && issue.params.reason) ?? issue.message);
        if (!reason) return word('').replace(/[:\s]+$/, '');
        return word(REASON_TEXT[reason] ? REASON_TEXT[reason]() : reason);
    }

    // What a disabled save is waiting on, for the small print above the buttons: the first thing
    // the person still has to do, or '' when nothing blocks saving.
    function waitingText({ plan = null, loading = false, landError = null, errors = [], rosterPending = false } = {}) {
        if (loading) return t('agreement.dialog.waitingLand', 'Reading the plan’s land…');
        if (!plan) return t('agreement.dialog.waitingPlan', 'Choose a plan first.');
        if (landError) return landError;
        if (errors.length) {
            const more = errors.length - 1;
            return issueText(errors[0]) + (more ? ' ' + t('agreement.dialog.waitingMore', '(and {{count}} more)', { count: more }) : '');
        }
        if (rosterPending) return t('agreement.dialog.waitingRoster', 'Save the voter list first.');
        return '';
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
        return `<ul class="agreement-object-list" ${hook}>${items.map(item => `<li data-agreement-${kind === 'parcel' ? 'input' : 'plan-design'}="${esc(item.id)}"><button type="button" class="cb-option agreement-object-row" data-agreement-inspect="${kind}" data-agreement-object-id="${esc(item.id)}" aria-pressed="false"><span class="agreement-object-row__title"${item.labelId ? ` title="${esc(item.labelId)}"` : ''}>${esc(item.title)}</span><span class="agreement-object-row__facts">${esc(item.facts)}</span></button></li>`).join('')}</ul>`;
    }
    function inputsTableHtml(parcels, rights = null, names = new Map()) {
        return `<h4 class="agreement-object-heading">${esc(t('agreement.land.inputsHeading', 'Input parcels'))}</h4>`
            + inspectionListHtml(parcels.map(parcel => ({ id: parcel.parcelId, title: parcel.parcelId,
                facts: `${areaText(parcel.areaM2)} · ${ownersText(parcel.parcelId, rights, names)}` })), 'parcel', 'data-agreement-inputs');
    }
    function inputDesignsHtml(designs) {
        const labelIds = designs.map(design => idOf(design.published?.cid || design.cid || design.proposalId));
        return `<h4 class="agreement-object-heading">${esc(t('sidebar.proposals.title', 'Designs'))}</h4>`
            + inspectionListHtml(designs.map(design => ({ id: idOf(design.proposalId), labelId: idOf(design.published?.cid || design.cid || design.proposalId), title: recordLabel().label(designTitle(design), idOf(design.published?.cid || design.cid || design.proposalId), labelIds),
                facts: typeLabelOf(design) })), 'design', 'data-agreement-input-designs');
    }

    function outputsTableHtml(outputs) {
        const from = t('agreement.land.from', 'From');
        const rows = outputs.map((output, index) => `<tr data-agreement-output="${esc(output.hash)}"><th scope="row">${esc(`${t('agreement.land.piece', 'Piece')} ${index + 1}`)}</th>`
            + `<td class="agreement-table__from" data-label="${esc(from)}">${esc((Array.isArray(output.fromParcelIds) ? output.fromParcelIds : []).join(', '))}</td>`
            + `<td class="agreement-table__number">${esc(areaText(output.areaM2))}</td></tr>`).join('');
        return `<div class="agreement-table-scroll"><table class="agreement-table" data-agreement-outputs>`
            + `<caption>${esc(t('agreement.land.outputsHeading', 'Resulting pieces'))}</caption>`
            + `<thead><tr><th scope="col">${esc(t('agreement.land.piece', 'Piece'))}</th><th scope="col">${esc(t('agreement.land.from', 'From'))}</th>`
            + `<th scope="col" class="agreement-table__number">${esc(t('agreement.land.area', 'Area'))}</th></tr></thead>`
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
        // Randomize is an action, not a lasting mode: it fills the pieces' selects, which stay
        // editable (the dialog shows Set individually after it). It needs persons to hand pieces to.
        const persons = partiesOf(land.inputs).length;
        const modes = [
            ['individual', t('agreement.allocation.individual', 'Set individually')],
            ['random', t('agreement.allocation.random', 'Randomize'), !persons],
            ['proposer', t('agreement.allocation.proposer', 'Proposer')],
            ['public', t('agreement.allocation.publicLand', 'Public land')]
        ];
        return `<label class="proposal-editor-field"><span>${esc(t('agreement.allocation.allOutputs', 'Allocate output parcels'))}</span><select data-agreement-allocation-mode>${modes.map(([value, label, disabled]) => `<option value="${value}"${mode === value ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(label)}</option>`).join('')}</select></label>`
            + allocationSummaryHtml(land, allocations) + `<ul class="agreement-allocation-list">${rows}</ul>`;
    }

    // Above the pieces: how many persons receive no piece and how many more than one, when any do.
    function allocationSummaryHtml(land, allocations = {}) {
        const spread = allocationSpread(land && land.inputs, allocations);
        const parts = [];
        if (spread.without) parts.push(t('agreement.allocation.withoutParcel', 'Persons without a parcel: {{count}}', { count: spread.without }));
        if (spread.several) parts.push(t('agreement.allocation.severalParcels', 'Persons with more than one parcel: {{count}}', { count: spread.several }));
        return `<p class="agreement-hint" data-agreement-allocation-summary${parts.length ? '' : ' hidden'}>${esc(parts.join(' · '))}</p>`;
    }

    // Land values per m² for settlement by value: one number field per input parcel ('inputs') or
    // resulting piece ('outputs'), and one that sets them all. rows: [{ id, title, facts }].
    function valuationHtml(kind, rows, values = {}, currency = '') {
        if (!rows.length) return '';
        const unit = t('agreement.workflow.unitValue', 'Value per m² ({{currency}})', { currency });
        const all = kind === 'inputs'
            ? t('agreement.workflow.unitValueAllInputs', 'Value per m² for all input parcels ({{currency}})', { currency })
            : t('agreement.workflow.unitValueAllOutputs', 'Value per m² for all resulting pieces ({{currency}})', { currency });
        const heading = kind === 'inputs' ? t('agreement.workflow.valuationInputs', 'Land values of the input parcels') : t('agreement.workflow.valuationOutputs', 'Land values of the resulting pieces');
        const items = rows.map(row => `<li class="agreement-valuation-row"><span class="agreement-valuation-row__title">${esc(row.title)}</span><span class="agreement-valuation-row__facts">${esc(row.facts)}</span>`
            + `<input type="number" min="0" step="0.01" value="${esc(centsText(values[row.id]))}" data-agreement-value-kind="${kind}" data-agreement-value-id="${esc(row.id)}" aria-label="${esc(`${row.title}: ${unit}`)}"></li>`).join('');
        return `<section class="agreement-valuation" data-agreement-valuation="${kind}"><h4 class="agreement-object-heading">${esc(heading)}</h4>`
            + `<label class="proposal-editor-field"><span>${esc(all)}</span><input type="number" min="0" step="0.01" data-agreement-value-all="${kind}"></label>`
            + `<ul class="agreement-valuation-list">${items}</ul></section>`;
    }

    // Who decides, whether it binds, and the owners' rules (filled by the browser layer).
    function ruleHtml({ electorate = 'owners', binding = true } = {}) {
        const owners = electorate !== 'community' && electorate !== 'investors';
        const radio = (value, label) => `<label class="proposal-editor-check"><input type="radio" name="agreement-electorate" value="${value}" data-agreement-electorate${value === electorate ? ' checked' : ''}> ${esc(label)}</label>`;
        return `<fieldset class="agreement-fieldset"><legend>${esc(t('agreement.rule.who', 'Who decides'))}</legend>`
            + radio('owners', t('agreement.rule.owners', 'Seek owners’ decisions'))
            + radio('community', t('agreement.rule.community', 'Ask the community'))
            + radio('investors', t('agreement.funding.title', 'Developer crowdfunding'))
            + '</fieldset>'
            + `<label class="proposal-editor-check" data-agreement-binding-control${owners ? '' : ' hidden'}><input type="checkbox" data-agreement-binding${owners && binding ? ' checked' : ''}${owners ? '' : ' disabled'}> ${esc(t('agreement.rule.binding', 'Binding: owner approvals can authorize on-chain settlement'))}</label>`
            + `<div class="agreement-rule-form" data-agreement-rule-form${owners ? '' : ' hidden'}></div>`;
    }

    function detailsHtml({ title = '', deadline = '', today = '', deadlineRequired = false } = {}) {
        return `<label class="proposal-editor-field"><span>${esc(t('agreement.details.title', 'Title (optional)'))}</span><input type="text" data-agreement-title value="${esc(title)}" autocomplete="off"></label>`
            + `<label class="proposal-editor-field"><span>${esc(deadlineRequired ? t('agreement.chain.facts.deadline', 'Deadline') : t('agreement.details.deadline', 'Deadline (optional)'))}</span><input type="date" data-agreement-deadline value="${esc(deadline)}"${deadlineRequired ? ' required' : ''}${today ? ` min="${esc(today)}"` : ''}></label>`;
    }

    function consultationHtml({ organiser = '', participationUrl = '' } = {}) {
        return `<p class="agreement-hint">${esc(t('agreement.consultation.hint', 'Optional organiser identity and participation information. A nonbinding agreement records opinions and does not settle land or money.'))}</p>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.consultation.organiser', 'Organiser website or did:web (optional)'))}</span><input type="text" data-agreement-organiser value="${esc(organiser)}" autocomplete="off"></label>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.consultation.participationUrl', 'Participation URL (HTTPS, optional)'))}</span><input type="url" data-agreement-participation-url value="${esc(participationUrl)}" autocomplete="off"></label>`
            + '<section data-voting-roster></section>';
    }

    // The whole body. `view`: { designs, selected, missing, land, loading, landError, values, today }.
    const TABS = ['rules', 'inputs', 'outputs', 'persons', 'neighbours'];
    // counts: { inputs, outputs, persons, neighbours } shown in brackets, since inputs and outputs differ in number.
    function tabLabel(tab, counts = {}) {
        const labels = { rules: ['proposalDrafts.approval.policyType', 'Rules'], inputs: ['agreement.workflow.inputs', 'Input parcels'], outputs: ['agreement.workflow.outputs', 'Output parcels'], persons: ['agreement.workflow.persons', 'Persons'],
            neighbours: ['agreement.neighbours.tab', 'Neighbours'] };
        return t(...labels[tab]) + (Number.isInteger(counts[tab]) ? ` (${counts[tab]})` : '');
    }
    function tabCounts(land, affected = []) {
        const inputs = land && land.inputs ? land.inputs : { parcels: [] };
        return { inputs: (inputs.parcels || []).length, outputs: (land && Array.isArray(land.outputs) ? land.outputs : []).length, persons: partiesOf(inputs).length,
            neighbours: Array.isArray(affected) ? affected.length : 0 };
    }
    function planSelectorHtml(plans, selected) {
        const planIds = plans.map(plan => idOf(plan.cid));
        return `<label class="proposal-editor-field"><span>${esc(t('plan.label', 'Plan'))}</span><select data-agreement-plan><option value="">${esc(t('agreement.workflow.choosePlan', 'Choose a saved plan'))}</option>${plans.map(plan => `<option value="${esc(plan.cid)}" title="${esc(plan.cid)}"${plan.cid === selected?.cid ? ' selected' : ''}>${esc(recordLabel().label(plan.content.title, plan.cid, planIds))}</option>`).join('')}</select></label>`
            + (!plans.length ? `<p class="agreement-notice">${esc(t('agreement.workflow.noPlans', 'Create a plan first. Open Plans and choose Create plan.'))}</p>` : '');
    }
    // The persons tally: each abstract party (one per input parcel), the proposer or sponsor and the
    // public; then, when the rule's ownership rights name people, what each person holds of those
    // parties (AgreementPersons.personPositions). `names` maps owner ids to names where known.
    function personsHtml(record, names = new Map()) {
        const api = recordApi();
        const ledger = api.ledger(record);
        const terms = record.rule.settlement;
        const byValue = terms?.method === 'value' && ledger.valued;
        const money = cents => moneyText(cents, ledger.currency);
        const cell = (land, cash, value = null, entitled = null) => esc(areaText(land))
            + (byValue && isNumber(value) ? `<br><span class="agreement-persons-value">${esc(money(value))}</span>` : '')
            + (byValue && isNumber(entitled) ? `<br><span class="agreement-persons-entitled">${esc(t('agreement.workflow.entitled', 'entitled to {{value}}', { value: money(entitled) }))}</span>` : '')
            + (cash > 0 ? `<br><span class="agreement-persons-cash">${esc(money(cash))}</span>` : '');
        const rows = ledger.parties.map(party => `<tr><th scope="row">${esc(party.parcelId === null ? party.displayName : partyLabel(party.parcelId))}`
            + `${party.affected ? ` <span class="cb-badge" data-agreement-neighbour-party>${esc(t('agreement.neighbours.party', 'Neighbour'))}</span>` : ''}</th><td>${cell(party.areaUnknown ? null : party.contributedM2, Math.max(0, -party.cashCents), party.contributedValueCents)}</td><td>${cell(party.assignedM2, Math.max(0, party.cashCents), party.assignedValueCents, party.entitlementValueCents)}</td></tr>`).join('');
        const publicRow = ledger.publicM2 > 0 ? `<tr><th scope="row">${esc(t('agreement.allocation.public', 'Public'))}</th><td>${cell(0, 0)}</td><td>${cell(ledger.publicM2, 0, ledger.publicValueCents)}</td></tr>` : '';
        const sponsor = ledger.money.sponsorCents;
        const sponsorRow = sponsor || ledger.proposerM2 > 0 ? `<tr><th scope="row">${esc(ledger.proposerM2 > 0 ? t('agreement.allocation.proposer', 'Proposer') : t('agreement.workflow.sponsor', 'Sponsor'))}</th><td>${cell(0, Math.max(0, -sponsor))}</td><td>${cell(ledger.proposerM2, Math.max(0, sponsor), ledger.proposerValueCents)}</td></tr>` : '';
        const balance = api.landBalance(record);
        const hint = terms?.method === 'area' ? t('agreement.workflow.rateReadOnly', 'Compensation: {{rate}} per m². Change it in Rules.', { rate: money(terms.rateCentsPerM2) })
            : terms?.method === 'value' ? t('agreement.workflow.valueReadOnly', 'Compensation by land value: each person is entitled to the share of the resulting land’s value that matches the value they put in. Change it in Rules.') : '';
        const totals = byValue ? ' · ' + t('agreement.workflow.valueTotals', 'Value in: {{input}} · Value out: {{output}}', {
            input: money(ledger.contributedValueCents), output: money(ledger.distributableValueCents + ledger.publicValueCents) }) : '';
        const head = `<thead><tr><th scope="col">${esc(t('agreement.workflow.person', 'Person'))}</th><th scope="col">${esc(t('agreement.workflow.putsIn', 'Puts in'))}</th><th scope="col">${esc(t('agreement.workflow.receives', 'Receives'))}</th></tr></thead>`;
        return (hint ? `<p class="agreement-hint">${esc(hint)}</p>` : '')
            + `<table class="agreement-persons-table">${head}<tbody>${rows}${publicRow}${sponsorRow}</tbody></table>`
            + `<p class="agreement-hint" data-agreement-balance>${esc(t('agreement.workflow.landTotals', 'Land in: {{input}} · Land out: {{output}}', { input: areaText(balance.inputM2), output: areaText(balance.outputM2) }) + totals)}</p>`
            + derivedPersonsHtml(record, head, money, names);
    }
    // People are never stored in an agreement; with ownership rights they are derived from the parties.
    function derivedPersonsHtml(record, head, money, names) {
        const rights = record.rule && record.rule.approvalConfig ? record.rule.approvalConfig.rights : null;
        if (!rights) return '';
        const derived = personsApi().personPositions(record, rights);
        if (!derived.persons.length) return '';
        const cell = (land, cash) => esc(areaText(land)) + (cash > 0 ? `<br><span class="agreement-persons-cash">${esc(money(cash))}</span>` : '');
        const rows = derived.persons.map(person => `<tr data-agreement-person="${esc(person.personId)}"><th scope="row">${esc(names.get(person.personId) || person.personId)}</th>`
            + `<td>${cell(person.contributedM2, Math.max(0, -person.cashCents))}</td><td>${cell(person.landM2, Math.max(0, person.cashCents))}</td></tr>`).join('');
        const unresolved = derived.unresolved.length
            ? `<p class="agreement-hint" data-agreement-persons-unresolved>${esc(t('agreement.workflow.personsUnresolved', 'Without complete ownership rights, the owners of {{count}} parcel(s) stay one party.', { count: derived.unresolved.length }))}</p>` : '';
        return `<h4 class="agreement-object-heading">${esc(t('agreement.workflow.personsByRights', 'Persons by ownership rights'))}</h4>`
            + `<table class="agreement-persons-table" data-agreement-derived-persons>${head}<tbody>${rows}</tbody></table>` + unresolved;
    }
    // The lens in plain words (editor, panel, mint dialog): how many members must confirm, every
    // member key (marked once its confirmation is recorded on chain) and whether the sponsor (the
    // developer of a crowdfunding round) is one of them. `members` base58 keys; `threshold` as
    // AgreementRecord.lensThresholdOf; `confirmed` the members whose confirmation the account records.
    const shortKey = key => (String(key).length > 12 ? `${String(key).slice(0, 4)}…${String(key).slice(-4)}` : String(key));
    function lensSummaryHtml({ members = [], threshold = null, sponsor = null, confirmed = [], crowdfunding = false } = {}, tr = t) {
        const count = members.length;
        const needed = count ? Math.min(count, Math.max(1, threshold || 1)) : 0;
        const rule = !count
            ? (crowdfunding ? tr('agreement.lens.noneCrowdfunding', 'No lens: the round settles on its funding target alone.') : tr('agreement.lens.none', 'No lens member is named.'))
            : count === 1 ? tr('agreement.lens.single', 'The lens member must confirm.')
                : needed === 1 ? tr('agreement.lens.any', 'Any 1 of {{count}} must confirm.', { count })
                    : tr('agreement.lens.of', '{{needed}} of {{count}} must confirm.', { needed, count });
        const done = new Set(confirmed || []);
        const sponsorLabel = crowdfunding ? tr('agreement.lens.developerBadge', 'Developer') : tr('agreement.workflow.sponsor', 'Sponsor');
        const items = members.map(key => `<li class="agreement-lens-summary__member" data-agreement-lens-member="${esc(key)}"><code dir="ltr" title="${esc(key)}">${esc(shortKey(key))}</code>`
            + (done.has(key) ? `<span class="cb-badge cb-badge--success" data-agreement-lens-confirmed>${esc(tr('agreement.lens.confirmed', 'Confirmed'))}</span>` : '')
            + (sponsor && key === sponsor ? `<span class="cb-badge cb-badge--warning">${esc(sponsorLabel)}</span>` : '') + '</li>').join('');
        const sponsorIsMember = !!sponsor && members.includes(sponsor);
        return '<div class="agreement-lens-summary" data-agreement-lens-summary-view>'
            + (crowdfunding ? `<p class="agreement-lens-summary__rule">${esc(tr('agreement.lens.crowdfunding', 'The program checks the funding target. The lens checks investor eligibility and any other conditions.'))}</p>` : '')
            + `<p class="agreement-lens-summary__rule" data-agreement-lens-rule>${esc(rule)}</p>`
            + (items ? `<ul class="agreement-lens-summary__members" aria-label="${esc(tr('agreement.lens.members', 'Lens members'))}">${items}</ul>` : '')
            + (sponsorIsMember ? `<p class="agreement-panel-note agreement-panel-note--warning" data-agreement-lens-developer>${esc(crowdfunding
                ? tr('agreement.lens.developerMember', 'The developer is one of the verifiers.')
                : tr('agreement.lens.sponsorMember', 'The sponsor is one of the verifiers.'))}</p>` : '')
            + '</div>';
    }

    // The threshold choice for 2+ members: "Any 1 of N", then "k of N".
    function lensThresholdOptionsHtml(count, threshold, tr = t) {
        return Array.from({ length: count }, (_, index) => index + 1).map(needed => `<option value="${needed}"${needed === threshold ? ' selected' : ''}>`
            + esc(needed === 1 ? tr('agreement.lens.anyOption', 'Any 1 of {{count}}', { count }) : tr('agreement.lens.ofOption', '{{needed}} of {{count}}', { needed, count })) + '</option>').join('');
    }

    // The editor's lens section: the member picker, the members in words and, with 2+ members, how
    // many must confirm (filled by renderLens).
    function lensSectionHtml(id) {
        const choose = t('agreement.lens.choose', 'Choose lens members');
        return `<section class="agreement-lens" data-agreement-lens-section aria-labelledby="${id}"><h4 id="${id}" class="agreement-object-heading">${esc(t('agreement.chain.facts.lens', 'Lens'))}</h4>`
            + `<div class="agreement-lens__row"><button type="button" class="btn btn-icon btn-sm lens-pattern-button" data-lens-pattern data-agreement-action="lens" title="${esc(choose)}" aria-label="${esc(choose)}"><i class="fa-solid fa-glasses" aria-hidden="true"></i></button></div>`
            + '<div data-agreement-lens-summary></div>'
            + `<label class="proposal-editor-field" data-agreement-lens-threshold-field hidden><span>${esc(t('agreement.lens.thresholdLabel', 'Confirmations needed'))}</span><select data-agreement-lens-threshold></select></label></section>`;
    }

    function bodyHtml(view) {
        const values = view.values || {};
        const funding = values.funding || {};
        const fundingHtml = '<section class="agreement-funding-form" data-agreement-funding-form' + (values.electorate === 'investors' ? '' : ' hidden') + ' aria-labelledby="agreement-funding-title">'
            + `<h4 id="agreement-funding-title">${esc(t('agreement.funding.title', 'Developer crowdfunding'))}</h4>`
            + planSelectorHtml(view.plans || [], view.plan)
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.funding.target', 'Funding target (devnet USDC)'))}</span><input type="text" inputmode="decimal" data-agreement-funding-target value="${esc(funding.targetInput || '')}"></label>`
            + `<label class="proposal-editor-field"><span>${esc(t('agreement.funding.contract', 'Investor contract (PDF or UTF-8 text, up to 256 KiB)'))}</span><input type="file" accept="application/pdf,text/plain,.txt" data-agreement-funding-file></label>`
            + `<p class="agreement-hint" data-agreement-funding-file-name>${esc(funding.contract?.name || '')}</p>`
            + apartmentEditorHtml(funding)
            + detailsHtml({ title: values.title, deadline: values.deadline, today: view.today, deadlineRequired: values.electorate === 'investors' })
            + lensSectionHtml('agreement-funding-lens-title') + '</section>';
        if (values.electorate === 'investors') {
            return '<ul class="agreement-issues agreement-issues--error" data-agreement-errors aria-live="assertive"></ul>'
                + ruleHtml(values) + fundingHtml;
        }
        const panels = {
            rules: ruleHtml(values) + '<div data-agreement-settlement></div>' + lensSectionHtml('agreement-lens-title')
                + sectionHtml('consultation', t('agreement.sections.consultation', 'Nonbinding agreement'), consultationHtml(values), values.electorate !== 'community')
                + detailsHtml({ title: values.title, deadline: values.deadline, today: view.today }),
            inputs: planSelectorHtml(view.plans || [], view.plan) + '<div class="cb-actions"><button type="button" class="btn" data-agreement-action="rights">' + esc(t('agreement.workflow.rights', 'Parcel ownership rights')) + '</button></div><div data-agreement-land></div><div data-agreement-plan-designs></div>',
            outputs: '<div data-agreement-allocations></div>',
            persons: '<div data-agreement-persons></div>',
            // Affected neighbours: measured from the plan (Effects on neighbours) or added by parcel id.
            neighbours: `<p class="agreement-hint">${esc(t('agreement.neighbours.hint', 'A neighbour who gives up a right the plan affects, such as daylight or a garden limit, can be a party without giving land. A waiver needs their owners’ approval; compensation is paid without it. The sponsor pays each neighbour.'))}</p>`
                + `<div class="cb-actions"><button type="button" class="btn" data-agreement-action="neighbours-measure">${esc(t('agreement.neighbours.measure', 'Find affected neighbours'))}</button></div>`
                + '<section class="neighbour-effects" data-agreement-neighbour-effects role="status" aria-live="polite" hidden></section>'
                + '<div data-agreement-neighbour-candidates aria-live="polite"></div><div data-agreement-neighbours></div>'
        };
        return '<ul class="agreement-issues agreement-issues--error" data-agreement-errors aria-live="assertive"></ul><ul class="agreement-issues agreement-issues--warning" data-agreement-warnings aria-live="polite"></ul>'
            + `<div class="cb-tabs agreement-editor__tabs" role="tablist" aria-label="${esc(t('agreement.panel.title', 'Agreement'))}">${TABS.map(tab => `<button type="button" class="cb-tab" role="tab" id="agreement-tab-${tab}" aria-controls="agreement-tabpanel-${tab}" aria-selected="${tab === 'inputs'}" tabindex="${tab === 'inputs' ? 0 : -1}" data-agreement-tab="${tab}">${esc(tabLabel(tab, view.counts))}</button>`).join('')}</div>`
            + TABS.map(tab => `<section role="tabpanel" id="agreement-tabpanel-${tab}" aria-labelledby="agreement-tab-${tab}" data-agreement-tabpanel="${tab}"${tab === 'inputs' ? '' : ' hidden'}>${panels[tab]}</section>`).join('');
    }

    function apartmentRowHtml(unit = {}) {
        return `<fieldset class="agreement-apartment-unit" data-apartment-unit><legend>${esc(t('agreement.funding.apartments.unitTitle', 'Apartment'))}</legend>`
            + `<label><span>${esc(t('agreement.funding.apartments.unitId', 'Unit ID'))}</span><input data-apartment="unitId" value="${esc(unit.unitId || '')}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.label', 'Label'))}</span><input data-apartment="label" value="${esc(unit.label || '')}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.source', 'X-ray building or apartment link'))}</span><input data-apartment="xrayBuilding" value="${esc(unit.xrayBuilding || '')}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.unit', 'Building unit'))}</span><input data-apartment="unit" value="${esc(unit.unit || '')}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.at', 'Location (latitude, longitude, zoom)'))}</span><input data-apartment="at" placeholder="45.80,15.97,18" value="${esc(unit.at || '')}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.price', 'Price (USDC)'))}</span><input inputmode="decimal" data-apartment="priceInput" value="${esc(unit.priceInput || (unit.priceUsdcAtomic ? recordApi().formatUsdc(unit.priceUsdcAtomic) : ''))}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.deposit', 'Deposit (USDC)'))}</span><input inputmode="decimal" data-apartment="depositInput" value="${esc(unit.depositInput || (unit.depositUsdcAtomic ? recordApi().formatUsdc(unit.depositUsdcAtomic) : ''))}"></label>`
            + `<label><span>${esc(t('agreement.funding.apartments.drawing', 'Drawing (PDF)'))}</span><input type="file" accept="application/pdf,.pdf" data-apartment-drawing></label><p data-apartment-drawing-name>${esc(unit.drawing?.name || '')}</p>`
            + `<label><span>${esc(t('agreement.funding.apartments.access', 'Access'))}</span><input data-apartment="access" value="${esc(unit.access || '')}"></label>`
            + `<button type="button" class="btn btn-sm" data-apartment-remove>${esc(t('agreement.funding.apartments.remove', 'Remove apartment'))}</button></fieldset>`;
    }

    function apartmentEditorHtml(funding) {
        const apartments = funding.apartments || { projectId: '', units: [] };
        return `<section class="agreement-apartments" aria-labelledby="agreement-apartments-title"><h4 id="agreement-apartments-title">${esc(t('agreement.funding.apartments.title', 'Apartment inventory'))}</h4>`
            + `<label><span>${esc(t('agreement.funding.apartments.projectId', 'Project ID'))}</span><input data-apartments-project value="${esc(apartments.projectId)}"></label>`
            + `<div data-apartment-list>${apartments.units.map(apartmentRowHtml).join('')}</div><button type="button" class="btn btn-sm" data-apartment-add>${esc(t('agreement.funding.apartments.add', 'Add apartment'))}</button></section>`;
    }

    function syncApartmentInputs(state, body) {
        if (state.values.electorate !== 'investors') return;
        const projectId = body.querySelector('[data-apartments-project]')?.value.trim() || '';
        const units = [...body.querySelectorAll('[data-apartment-unit]')].map((row, index) => {
            const value = key => row.querySelector(`[data-apartment="${key}"]`)?.value.trim() || '';
            const previous = state.values.funding?.apartments?.units[index] || {};
            const price = recordApi().parseUsdc(value('priceInput')), deposit = recordApi().parseUsdc(value('depositInput'));
            return { unitId: value('unitId'), label: value('label'), xrayBuilding: value('xrayBuilding'), unit: value('unit'), at: value('at'),
                priceInput: value('priceInput'), depositInput: value('depositInput'), priceUsdcAtomic: price === null ? '' : String(price), depositUsdcAtomic: deposit === null ? '' : String(deposit),
                drawing: previous.drawing || null, access: value('access') || undefined };
        });
        if (projectId || units.length) state.values.funding.apartments = { projectId, units };
        else delete state.values.funding.apartments;
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
            + '<p class="agreement-editor__waiting" data-agreement-waiting role="status"></p>'
            + '<button type="button" class="btn" data-agreement-action="cancel"></button>'
            + '<button type="submit" class="btn btn-primary" data-agreement-action="save"></button>'
            + '</div>'
            + '</form>';
        (doc.getElementById('map-container') || doc.body).appendChild(panel);
        return panel;
    }

    // A plan is selected before ground is read. Designs are a read-only projection of that exact
    // revision; changing a plan's membership is a separate plan-authoring operation.
    // `from` (a stored id or an agreement record, published or not) starts a counter-agreement: a new
    // draft with the same plan and terms; `scheme` (a catalogue template) then replaces its rule.
    async function open({ agreementId = null, electorate = 'owners', plan = null, preserveContext = false, from = null, scheme = null } = {}) {
        const doc = root.document, api = root.AgreementRecord;
        const existing = agreementId ? root.AgreementStore.get(agreementId) : null;
        if (agreementId && !existing) throw new Error(`Agreement ${agreementId} is not on this device.`);
        if (existing?.published) throw publishedError();
        const source = from ? (typeof from === 'string' ? root.AgreementStore.get(from) : from) : null;
        if (from && !source) throw new Error(`Agreement ${from} is not on this device.`);
        const base = existing || source;
        if (session) session.cancel();
        const plans = root.NamedPlans.list();
        const requestedPlan = base?.plan || plan || null;
        let initialPlan = plans.find(row => row.cid === requestedPlan?.cid) || requestedPlan;
        const crowdfunding = base?.rule?.electorate === 'investors' || electorate === 'investors';
        // A plan opened from a copied address is a preview: its land exists once it is applied.
        if (initialPlan && !crowdfunding && !await root.PlanWorkspace.ensureApplied(initialPlan)) return null;
        // Crowdfunding commits the saved plan revision, rather than the map application of it. Bind
        // its carried members without applying or deriving cadastral land.
        if (initialPlan && crowdfunding && !Array.isArray(initialPlan.designs)) initialPlan = await root.PlanWorkspace.resolve(initialPlan);
        if (initialPlan && !plans.some(row => row.cid === initialPlan.cid)) plans.push(initialPlan);
        const baseConfig = base?.rule.approvalConfig || null;
        const state = {
            id: existing?.id || api.newId(), createdAt: existing?.createdAt || null,
            updatedAt: existing?.updatedAt || null, city: base?.city || root.resolveCurrentCityCode?.() || null,
            plans, plan: initialPlan, designs: [], fingerprints: new Map(), land: emptyLand(),
            allocationMode: allocationMode(termsOf(base).allocations),
            currency: base?.money.currency || root.CityMoney.currentCurrency(),
            approvalConfig: scheme ? setup().withScheme(baseConfig, scheme) : baseConfig,
            // A new crowdfunding round starts with no lens: the program checks its funding target, and
            // the developer adds members only for eligibility or other conditions.
            lens: base ? [...base.rule.lens] : crowdfunding ? [] : setup().lensKeys(root.getLensEntries()),
            lensThreshold: base ? api.lensThresholdOf(base.rule) : 1,
            // A new agreement is a non-binding vote: binding the owners takes the author's explicit tick.
            values: { ...termsOf(base), electorate: base?.rule.electorate || electorate,
                binding: base?.rule.binding === true,
                title: existing?.title || (source ? t('agreement.dialog.counterTitle', 'Counter to {{title}}', { title: source.title || t('agreement.panel.title', 'Agreement') }) : ''),
                settlement: { ...(base?.rule.settlement || api.DEFAULT_SETTLEMENT) },
                affected: JSON.parse(JSON.stringify(base?.affected || [])),
                neighbourCompensation: base?.rule.neighbourCompensation ? { ...base.rule.neighbourCompensation } : null,
                deadline: dateFromDeadline(base?.deadline), organiser: base?.consultation?.organiser || '',
                participationUrl: base?.consultation?.participationUrl || '', voting: base?.consultation?.voting || null,
                fundingDeadline: base?.rule?.electorate === 'investors' ? base.deadline || null : null,
                fundingDeadlineDirty: false },
            loading: false, closed: false, sequence: 0, attempted: false, landError: null,
            // The last Effects on neighbours measurement of the plan and the plots ticked in it.
            neighbours: { result: null, ticked: new Set() }
        };
        state.values.funding = base?.funding ? { ...base.funding, targetInput: api.formatUsdc(base.funding.targetUsdcAtomic) } : { targetInput: '', targetUsdcAtomic: '', contract: null };
        state.contractSequence = 0;
        state.contractReading = false;
        function setFundingPlanDesigns() {
            if (!state.plan) { state.designs = []; state.fingerprints = new Map(); return; }
            const records = root.PlanComposition.localRecords(state.plan, { apiBase: root.DesignSync.apiBase() });
            state.designs = records;
            state.fingerprints = new Map(records.map(record => [idOf(record.proposalId), root.DesignRecord.cidOf(record)]));
        }
        if (state.values.electorate === 'investors') setFundingPlanDesigns();
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
        panel.querySelector('#agreement-editor-title').textContent = existing ? t('agreement.dialog.titleEdit', 'Edit agreement')
            : source ? t('agreement.dialog.titleCounter', 'Counter-agreement') : t('agreement.dialog.titleCreate', 'Create agreement');
        panel.querySelectorAll('[data-agreement-action="cancel"]').forEach(button => {
            button.setAttribute('aria-label', t('common.cancel', 'Cancel'));
            if (button.closest('.panel-footer')) button.textContent = t('common.cancel', 'Cancel');
        });
        saveButton.textContent = t(existing ? 'agreement.dialog.save' : 'agreement.dialog.titleCreate', existing ? 'Save agreement' : 'Create agreement');
        body.innerHTML = bodyHtml({ ...state, today: dateFromDeadline(new Date().toISOString()) });
        const part = selector => body.querySelector(selector);
        // The wallet that will sponsor the agreement: the record's, else the connected one it is proposed with.
        const sponsorKey = () => existing?.sponsor || root.AgreementBridge?.connectedWallet?.() || null;
        const listeners = new AbortController(), { signal } = listeners;
        let resolveClosed, auxiliary = null, unregisterEscape = null;
        const closed = new Promise(resolve => { resolveClosed = resolve; });
        const current = { cancel: () => finish(null) };
        session = current;
        const draft = () => { syncApartmentInputs(state, body); return recordFromForm(state, state.values); };
        let rosterPending = false;
        // A ballot rule that covers only eligible buildings (planning/eligibility.js): the covered
        // houses' check runs when the rule is chosen and on Check again, and its result is kept in
        // the voting record, which the roster rebuilds on each change.
        const eligibilityNode = doc.createElement('section');
        eligibilityNode.className = 'voting-eligibility';
        eligibilityNode.hidden = true;
        part('[data-voting-roster]')?.after(eligibilityNode);
        const eligibility = { key: null, evidence: null, judged: null, busy: false, error: null };
        const requiredSet = value => {
            const rule = value?.rule ? root.CommunityBallotRules?.get(value.rule.id, value.rule.version) : null;
            const required = rule?.requires?.eligibility;
            return required ? root.BuildingEligibility.get(required.id, required.version) : null;
        };
        const withEligibility = value => (value && requiredSet(value) && eligibility.evidence ? { ...value, eligibility: eligibility.evidence } : value);
        const roster = root.CommunityVotingRoster?.mount(part('[data-voting-roster]'), {
            value: state.values.voting,
            changed: (value, pending) => {
                state.values.voting = withEligibility(value); rosterPending = pending;
                const set = requiredSet(value), key = set ? `${set.id}@${set.version}` : null;
                if (key !== eligibility.key) { eligibility.key = key; eligibility.evidence = null; eligibility.judged = null; if (set) checkEligibility(); }
                renderEligibility(); issues();
            }
        });
        if (state.values.voting?.eligibility) { eligibility.evidence = state.values.voting.eligibility; const set = requiredSet(state.values.voting); eligibility.key = set ? `${set.id}@${set.version}` : null; }
        async function checkEligibility(control = null) {
            const set = requiredSet(state.values.voting);
            if (!set || eligibility.busy) return;
            eligibility.busy = true; eligibility.error = null; renderEligibility();
            const work = async () => {
                const designs = draft().designs.map(design => root.proposalStorage.getProposal(design.proposalId)).filter(Boolean);
                const houses = root.BuildingEligibility.coveredHouses(set, designs);
                eligibility.judged = await root.BuildingEligibility.check(set, houses, ids => root.BuildingFacts.readMany(ids, { fresh: Boolean(control) }));
                eligibility.evidence = houses.length ? root.BuildingEligibility.evidence(set, eligibility.judged, new Date().toISOString()) : null;
                state.values.voting = { ...state.values.voting };
                delete state.values.voting.eligibility;
                state.values.voting = withEligibility(state.values.voting);
            };
            try { await (control ? root.BusyControl.track(control, work) : work()); } catch (error) {
                eligibility.error = error.message;
                console.error(`[${new Date().toISOString()}] [AgreementEditor] eligibility check failed`, error);
            } finally { eligibility.busy = false; if (!state.closed) { renderEligibility(); issues(); } }
        }
        // Literal keys, so the locale coverage test sees each one.
        const VERDICT_TEXT = { eligible: () => t('voting.eligibility.verdict.eligible', 'Eligible'),
            ineligible: () => t('voting.eligibility.verdict.ineligible', 'Not eligible'), unknown: () => t('voting.eligibility.verdict.unknown', 'Unknown') };
        function renderEligibility() {
            const set = requiredSet(state.values.voting);
            eligibilityNode.hidden = !set;
            if (!set) { eligibilityNode.replaceChildren(); return; }
            const judged = eligibility.judged || [];
            const eligibleCount = judged.filter(house => house.id && house.result.verdict === 'eligible').length;
            eligibilityNode.innerHTML = `<h4>${esc(t('voting.eligibility.title', 'Covered houses'))}</h4>`
                + `<p class="agreement-hint">${esc(t('voting.eligibility.hint', 'This street vote may cover only houses that meet the rule’s eligibility conditions. Their facts are read from OpenStreetMap and their listing from the heritage register: add missing facts in OpenStreetMap, then check again.'))}</p>`
                + (eligibility.busy ? `<p role="status">${esc(t('voting.eligibility.checking', 'Checking the covered houses…'))}</p>`
                    : eligibility.error ? `<p role="alert">${esc(t('voting.eligibility.failed', 'The check could not be completed: {{error}}', { error: eligibility.error }))}</p>`
                        : judged.length ? `<p role="status">${esc(t('voting.eligibility.summary', '{{eligible}} of {{total}} covered houses eligible', { eligible: eligibleCount, total: judged.length }))}</p>`
                            : eligibility.judged ? `<p role="status">${esc(t('voting.eligibility.none', 'The plan raises no existing building with a mansard.'))}</p>` : '')
                + (judged.length ? `<ul class="voting-eligibility__houses">${judged.map(house => {
                    const verdict = house.id ? house.result.verdict : 'unknown';
                    const failing = house.result.tests.filter(test => test.status === 'fail').map(test => test.cite);
                    const unknown = house.result.tests.filter(test => test.status === 'unknown').map(test => test.cite);
                    const detail = [failing.length ? t('voting.eligibility.fails', 'fails {{tests}}', { tests: failing.join(', ') }) : '',
                        unknown.length ? t('voting.eligibility.missingFacts', 'unknown {{tests}}', { tests: unknown.join(', ') }) : ''].filter(Boolean).join(' · ');
                    const edit = house.building?.edit?.url;
                    return `<li data-verdict="${esc(verdict)}"><span>${esc(house.id ? t('voting.eligibility.house', 'Building {{id}}', { id: house.id.replace(/^osm:/, '') }) : t('voting.eligibility.unanswered', 'A building with no facts source ({{id}})', { id: house.sourceBuildingId ?? '?' }))}</span>`
                        + ` <strong>${esc(VERDICT_TEXT[verdict]())}</strong>${detail ? ` <span class="agreement-hint">${esc(detail)}</span>` : ''}`
                        + (edit && verdict !== 'eligible' ? ` <a class="cb-link cb-link--external" href="${esc(edit)}" target="_blank" rel="noopener">${esc(t('voting.eligibility.edit', 'Edit in {{source}}', { source: house.building.edit.source }))}</a>` : '') + '</li>';
                }).join('')}</ul>` : '')
                + `<button type="button" class="btn btn-secondary" data-voting-eligibility-check${eligibility.busy ? ' disabled' : ''}>${esc(eligibility.judged ? t('voting.eligibility.again', 'Check again') : t('voting.eligibility.check', 'Check eligibility'))}</button>`;
            eligibilityNode.querySelector('[data-voting-eligibility-check]').addEventListener('click', event => checkEligibility(event.currentTarget));
        }
        renderEligibility();
        // A reopened draft under such a rule is checked again: its houses' facts may have changed.
        if (requiredSet(state.values.voting)) { eligibility.key = `${requiredSet(state.values.voting).id}@${requiredSet(state.values.voting).version}`; checkEligibility(); }
        function finish(result) {
            if (state.closed) return;
            state.closed = true; roster?.destroy(); clearInspection(); listeners.abort(); auxiliary?.close(); unregisterEscape?.();
            // The plots this editor's measurement coloured on the map go with it.
            if (state.neighbours.result) root.NeighbourEffectsAdvisor?.clear?.();
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
            if (state.closed) return;
            const waiting = panel.querySelector('[data-agreement-waiting]');
            if (state.loading) { waiting.textContent = waitingText({ loading: true }); return; }
            try {
                const checked = api.validate(draft(), { designOf: id => root.proposalStorage.getProposal(id), isApplied: root.isApplied, translate: t });
                if (state.values.electorate === 'investors') {
                    part('[data-agreement-errors]').innerHTML = issuesHtml(checked.errors);
                    waiting.textContent = state.contractReading ? t('agreement.funding.fileReading', 'Reading the investor contract…') : '';
                    saveButton.disabled = state.contractReading || !!body.querySelector('[data-drawing-loading]') || !checked.valid;
                    return;
                }
                // A scheme rule the plan breaks or a land value that is missing follows a choice the
                // person made, so it is shown at once; the rest waits for a save attempt.
                part('[data-agreement-errors]').innerHTML = issuesHtml(checked.errors.filter(row => state.attempted || /^(scheme|valuation|affected|neighbour)-/.test(row.code)));
                // Advanced ownership/lens readiness lives behind its own controls.
                part('[data-agreement-warnings]').innerHTML = issuesHtml(checked.warnings.filter(row => row.section === 'land'));
                const pending = state.values.electorate === 'community' && rosterPending;
                saveButton.disabled = !state.plan || !!state.landError || !checked.valid || pending;
                waiting.textContent = waitingText({ plan: state.plan, landError: state.landError, errors: checked.errors, rosterPending: pending });
            } catch (error) { saveButton.disabled = true; part('[data-agreement-errors]').textContent = error.message; waiting.textContent = error.message; }
        }
        // The local owner records (agents and joint pools), the people behind the default rights.
        const localOwners = () => root.AgreementGround.localHolders({ storage: root.PersistentStorage, agents: root.agentStorage });
        function ownerNames() {
            const ownerOf = localOwners();
            return new Map(state.land.inputs.parcels.flatMap(parcel => ownerOf(parcel.parcelId)).map(holder => [String(holder.ownerKey), String(holder.displayName || holder.ownerKey)]));
        }
        function renderPersons() {
            try { part('[data-agreement-persons]').innerHTML = personsHtml(draft(), ownerNames()); }
            catch (error) { part('[data-agreement-persons]').textContent = error.message; }
        }
        function renderTabLabels() {
            const counts = state.loading || state.landError ? { neighbours: state.values.affected.length } : tabCounts(state.land, state.values.affected);
            body.querySelectorAll('[data-agreement-tab]').forEach(button => { button.textContent = tabLabel(button.dataset.agreementTab, counts); });
        }
        // Which control inside `container` has focus, to find it again after a redraw.
        function focusKey(container) {
            const active = doc.activeElement;
            if (!active || !container || !container.contains(active)) return null;
            return { row: active.closest('[data-agreement-affected]')?.dataset.agreementAffected ?? null,
                selector: ['data-affected-field', 'data-affected-right', 'data-agreement-neighbour-candidate'].map(name => (active.hasAttribute(name) ? `[${name}="${root.CSS.escape(active.getAttribute(name))}"]` : null)).find(Boolean)
                    || (active.matches('[data-agreement-neighbour-id]') ? '[data-agreement-neighbour-id]' : active.matches('[data-agreement-action]') ? `[data-agreement-action="${active.dataset.agreementAction}"]` : null) };
        }
        function refocus(container, key) {
            if (!key || !key.selector) return;
            const scope = key.row !== null ? container.querySelector(`[data-agreement-affected="${root.CSS.escape(key.row)}"]`) : container;
            (scope?.querySelector(key.selector) || container.querySelector('[data-agreement-neighbour-id]'))?.focus({ preventScroll: true });
        }
        // The Neighbours tab: each affected parcel's terms (payments as the record derives them), the
        // plots of the last measurement and the tab's count.
        function renderNeighbours() {
            const target = part('[data-agreement-neighbours]');
            if (!target) return;
            const key = focusKey(target);
            let entries = state.values.affected;
            try { entries = draft().affected; } catch (_) { /* the validation names the problem */ }
            target.innerHTML = neighboursHtml({ entries, electorate: state.values.electorate, currency: state.currency,
                multiple: api.lossMultipleOf({ neighbourCompensation: state.values.neighbourCompensation }), rights: state.approvalConfig?.rights, names: ownerNames() });
            part('[data-agreement-action="neighbours-measure"]').disabled = state.values.electorate !== 'owners' || !state.plan || state.loading || !!state.landError;
            refocus(target, key);
            renderCandidates();
            renderTabLabels();
        }
        function renderCandidates() {
            const target = part('[data-agreement-neighbour-candidates]');
            if (!target) return;
            const key = focusKey(target);
            const result = state.neighbours.result;
            target.innerHTML = state.values.electorate !== 'owners' || !result ? ''
                : result.status === 'notApplicable' ? `<p class="agreement-hint">${esc(t('agreement.neighbours.noGuides', 'This place states no neighbour guides, so nothing is measured: add a neighbouring parcel by its id.'))}</p>`
                    : candidatesHtml(result, { ticked: state.neighbours.ticked, addedIds: new Set(state.values.affected.map(entry => idOf(entry.parcelId))),
                        inputIds: new Set(state.land.inputs.parcels.map(parcel => idOf(parcel.parcelId))) });
            refocus(target, key);
        }
        // The default rights snapshot (local owners) follows the neighbours as it follows the land.
        function neighboursChanged() {
            readRule();
            const ownerOf = localOwners();
            if (state.values.electorate === 'owners') state.approvalConfig = ruleConfigAfterDerive(state.approvalConfig, state.land.inputs, inputs => api.rightsFromInputs(inputs, ownerOf, state.values.affected));
            renderRule(); renderNeighbours(); renderPersons(); issues();
        }
        function addAffected(entries) {
            const have = new Set(state.values.affected.map(entry => idOf(entry.parcelId)));
            const added = entries.filter(entry => entry.parcelId && !have.has(entry.parcelId));
            state.values.affected.push(...added);
            log(`added ${added.length} affected parcel(s): ${added.map(entry => entry.parcelId).join(', ')}`);
            neighboursChanged();
            return added;
        }
        // Effects on neighbours of the agreement's plan, as the plan panel measures them; the plots
        // beyond a guide come back ticked.
        async function measureNeighbours() {
            const section = part('[data-agreement-neighbour-effects]');
            section.hidden = false;
            const result = await root.PlanAnalysisControls.runEffects(root, async () => state.plan, section);
            if (state.closed || !result) return;
            state.neighbours.result = result;
            state.neighbours.ticked = new Set((result.lots || []).filter(lot => lot.status === 'fail').map(lot => idOf(lot.id)));
            log(`measured ${(result.lots || []).length} affected plot(s) for plan ${state.plan?.cid}`);
            renderCandidates();
        }
        // A typed change to one affected parcel's terms, read from its row.
        function updateAffected(target) {
            const row = target.closest('[data-agreement-affected]');
            const entry = state.values.affected.find(item => idOf(item.parcelId) === row?.dataset.agreementAffected);
            if (!entry) return;
            const value = name => row.querySelector(`[data-affected-field="${name}"]`)?.value ?? '';
            if (target.matches('[data-affected-right]')) {
                const rights = new Set(entry.rights);
                if (target.checked) rights.add(target.dataset.affectedRight); else rights.delete(target.dataset.affectedRight);
                entry.rights = [...rights].sort();
            }
            entry.effect = value('effect');
            entry.note = value('note').trim() || null;
            // An amount being typed that is not one yet stays unreadable, so the validation names it.
            const loss = cashCents(value('loss'));
            entry.loss = loss === null ? null : { amountCents: loss, statedBy: value('statedBy'), valuerRef: value('valuerRef').trim() || null };
            const consideration = cashCents(value('consideration'));
            entry.considerationCents = consideration === null ? 0 : consideration;
        }
        function settlementHtml() {
            const terms = state.values.settlement, limit = api.contributionLimit({ approvalConfig: state.approvalConfig });
            terms.contributionBasisPoints = Math.min(terms.contributionBasisPoints, limit);
            const enabled = terms.method === 'area';
            const methods = [['area', t('agreement.workflow.byArea', 'Balance land differences in money')], ['value', t('agreement.workflow.byValue', 'Balance land value differences in money')], ['none', t('agreement.workflow.noCash', 'No cash compensation')]];
            const scheme = api.schemeOf({ approvalConfig: state.approvalConfig }), gain = api.valueGainOf({ approvalConfig: state.approvalConfig });
            const valueHint = terms.method !== 'value' ? '' : `<p class="agreement-hint" data-agreement-value-hint>${esc(t('agreement.workflow.valueHint', 'Each person is entitled to the share of the resulting land’s value that matches the value they put in; differences are settled in money. Enter a value per m² for every input parcel and resulting piece.'))
                + (scheme && gain > 0 ? ' ' + t('agreement.workflow.valueGainHint', '{{scheme}} settles {{percent}}% of each person’s value gain in money.', { scheme: t(`proposalApproval.schemes.${scheme.id}.name`, scheme.text.name), percent: Math.round(gain * 1000) / 10 }) : '')}</p>`;
            return `<label class="proposal-editor-field"><span>${esc(t('agreement.workflow.compensation', 'Compensation'))}</span><select data-agreement-compensation>${methods.map(([value, label]) => `<option value="${value}"${terms.method === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`
                + valueHint
                + `<label class="proposal-editor-field"${enabled ? '' : ' hidden'}><span>${esc(t('agreement.workflow.rate', 'Compensation per m² ({{currency}})', { currency: state.currency }))}</span><input type="range" min="0" max="${Math.max(100000, terms.rateCentsPerM2)}" step="100" value="${terms.rateCentsPerM2}" data-agreement-rate-slider><input type="number" min="0" max="100000000" step="0.01" value="${terms.rateCentsPerM2 / 100}" data-agreement-rate aria-label="${esc(t('agreement.workflow.rate', 'Compensation per m² ({{currency}})', { currency: state.currency }))}"></label>`
                + (enabled && limit ? `<label class="proposal-editor-field"><span>${esc(t('agreement.workflow.contribution', 'Land contribution (%)'))}</span><input type="range" min="0" max="${limit}" step="1" value="${terms.contributionBasisPoints}" data-agreement-contribution><output data-agreement-contribution-value>${terms.contributionBasisPoints / 100}%</output></label><p class="agreement-hint">${esc(t('agreement.workflow.contributionHint', 'Compensation covers differences from the remaining land entitlement after this contribution.'))}</p>` : '')
                + `<div data-agreement-neighbour-compensation>${neighbourCompensationHtml(state.values.neighbourCompensation)}</div>`;
        }
        function readRule() {
            const container = part('[data-agreement-rule-form]');
            if (state.values.electorate === 'owners' && container.firstElementChild) state.approvalConfig = setup().withPolicyFromForm(container, state.approvalConfig);
        }
        // The members in words and the threshold choice; a community vote names no lens of its own.
        function renderLens() {
            const button = part('[data-agreement-action="lens"]');
            if (button) button.dataset.lensEntries = JSON.stringify(state.lens.map(address => ({ address })));
            root.refreshLensPatternPreviews();
            const community = state.values.electorate === 'community';
            const count = state.lens.length;
            state.lensThreshold = Math.min(Math.max(1, Number(state.lensThreshold) || 1), Math.max(1, count));
            const summary = part('[data-agreement-lens-summary]');
            if (summary) summary.innerHTML = community ? '' : lensSummaryHtml({ members: state.lens, threshold: state.lensThreshold,
                sponsor: sponsorKey(), crowdfunding: state.values.electorate === 'investors' });
            const field = part('[data-agreement-lens-threshold-field]');
            if (field) {
                field.hidden = community || count < 2;
                field.querySelector('[data-agreement-lens-threshold]').innerHTML = count < 2 ? '' : lensThresholdOptionsHtml(count, state.lensThreshold);
            }
        }
        // Which schemes the plan meets (every scheme, for the dropdown) and how the chosen one reads
        // against it (the card), from the record's own check; nothing when the draft cannot be built.
        function schemeView() {
            const regimes = root.ProposalApprovalRegimes, words = root.ProposalApprovalText;
            if (state.values.electorate !== 'owners' || !regimes || !words) return {};
            let record;
            try { record = draft(); } catch (_) { return {}; }
            const names = new Map(partiesOf(state.land.inputs).map(party => [party.ownerKey, party.displayName]));
            const label = key => names.get(key) || key;
            const schemeStatus = {};
            regimes.list().forEach(regime => {
                try { schemeStatus[regime.id] = api.schemeCheck(record, regime).check.ok; } catch (_) { /* unmarked: the validation names the problem */ }
            });
            let schemeCheck = null;
            try {
                const result = api.schemeCheck(record);
                if (result) schemeCheck = { ok: result.check.ok, lines: result.check.rules.map(rule => ({ ok: rule.ok, text: words.checkLines({ rules: [rule] }, t, label)[0] })) };
            } catch (_) { /* as above */ }
            return { schemeStatus, schemeCheck };
        }
        function renderRule() {
            const owners = state.values.electorate === 'owners';
            const source = doc.createElement('div');
            source.innerHTML = setup().html({ config: state.approvalConfig, lens: state.lens, cadastreParcelIds: state.land.inputs.parcels.map(p => p.parcelId), heading: false, ...schemeView() });
            const container = part('[data-agreement-rule-form]'); container.replaceChildren(); container.hidden = !owners;
            const rules = source.querySelector('[data-approval-rules-card]'); if (owners && rules) container.appendChild(rules);
            part('[data-agreement-settlement]').innerHTML = owners ? settlementHtml() : '';
            renderLens();
            part('[data-agreement-binding-control]').hidden = !owners;
            part('[data-agreement-binding]').disabled = !owners;
            part('[data-agreement-binding]').checked = owners && state.values.binding === true;
            part('[data-agreement-section="consultation"]').hidden = owners || state.values.electorate === 'investors';
        }
        const byValue = () => state.values.electorate === 'owners' && state.values.settlement.method === 'value';
        function valuationSection(kind) {
            if (!byValue()) return '';
            const rows = kind === 'inputs'
                ? state.land.inputs.parcels.map(parcel => ({ id: parcel.parcelId, title: parcel.parcelId, facts: areaText(parcel.areaM2) }))
                : state.land.outputs.map((output, index) => ({ id: output.hash, title: `${t('agreement.land.piece', 'Piece')} ${index + 1}`, facts: areaText(output.areaM2) }));
            return valuationHtml(kind, rows, state.values.valuation[kind], state.currency);
        }
        function renderLand() {
            if (state.values.electorate === 'investors') return;
            clearInspection();
            const target = part('[data-agreement-land]');
            if (state.loading) target.innerHTML = landHtml({ loading: true });
            else if (state.landError) target.innerHTML = `<p class="agreement-alert">${esc(state.landError)}</p><button type="button" class="btn" data-agreement-action="apply-plan">${esc(t('agreement.workflow.applyPlan', 'Apply plan designs'))}</button>`;
            else target.innerHTML = inputsTableHtml(state.land.inputs.parcels, state.approvalConfig?.rights, ownerNames()) + valuationSection('inputs');
            part('[data-agreement-plan-designs]').innerHTML = inputDesignsHtml(state.designs);
            part('[data-agreement-allocations]').innerHTML = allocationHtml(state.land, state.values.allocations, state.allocationMode) + valuationSection('outputs');
            if (state.values.electorate === 'community') part('[data-agreement-allocations]').querySelectorAll('select').forEach(select => { select.disabled = true; });
            renderNeighbours(); renderPersons(); issues();
        }
        function reconcileAllocations() {
            const kept = keptTerms(state.values, state.land);
            const defaults = Object.fromEntries(api.defaultAllocations(state.land.inputs, state.land.outputs).map(row => [row.output, allocationValue(row.to)]));
            state.values.allocations = state.allocationMode === 'individual' ? { ...defaults, ...kept.allocations }
                : Object.fromEntries(state.land.outputs.map(output => [output.hash, state.allocationMode]));
            // A parcel or piece without a land value takes the land price per m² (CityMoney) where the
            // agreement's input parcels are, so a plan can be valued at once and corrected row by row.
            const fallback = defaultUnitValueCents();
            const inputs = { ...kept.valuation.inputs }, outputs = { ...kept.valuation.outputs };
            if (fallback !== null) {
                state.land.inputs.parcels.forEach(parcel => { if (!isNumber(inputs[parcel.parcelId])) inputs[parcel.parcelId] = fallback; });
                state.land.outputs.forEach(output => { if (!isNumber(outputs[output.hash])) outputs[output.hash] = fallback; });
            }
            state.values.valuation = { inputs, outputs };
        }
        function defaultUnitValueCents() {
            try {
                const parcels = state.land.inputs.parcels.map(parcel => root.CadastralParcelRepository?.get?.(idOf(parcel.parcelId))).filter(Boolean);
                const price = root.CityMoney?.currentLandPriceOptions?.('land', root.EconomicSources.locationOf(parcels))?.areaPricePerSqm;
                return isNumber(price) && price >= 0 ? Math.round(price * 100) : null;
            } catch (_) { return null; }
        }
        async function deriveLand() {
            const sequence = ++state.sequence;
            state.loading = true; state.landError = null; saveButton.disabled = true; renderLand();
            try {
                state.designs = []; state.land = emptyLand(); state.fingerprints = new Map();
                if (state.plan) {
                    const selected = root.PlanWorkspace.appliedMembers(state.plan);
                    if (!selected) throw new Error(t('agreement.workflow.planNotApplied', 'Apply every design of this saved plan before reading its land.'));
                    state.designs = selected;
                    state.fingerprints = new Map(selected.map(record => [idOf(record.proposalId), root.DesignRecord.cidOf(record)]));
                    const repository = root.CadastralParcelRepository;
                    const loaded = await repository.ensureIds(inputParcelIds(selected, root.LiveParcelFabric), { retainOnly: true });
                    if (state.closed || sequence !== state.sequence) return;
                    state.land = root.AgreementGround.derive({ designs: selected, fabric: root.LiveParcelFabric,
                        originals: originalsById(loaded.features, root.LiveParcelFabric.featureId) });
                    reconcileAllocations();
                    const ownerOf = localOwners();
                    state.approvalConfig = ruleConfigAfterDerive(state.approvalConfig, state.land.inputs, inputs => api.rightsFromInputs(inputs, ownerOf, state.values.affected));
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
                    ...(state.values.electorate === 'investors' ? { chain: 'solana' } : {}),
                    entries: state.lens.map(address => ({ address, name: names.get(address) || '' })),
                    onChange: entries => {
                        // Up to AgreementRecord.MAX_LENSES members; more are reported by the record's check.
                        state.lens = setup().lensKeys(entries);
                        renderLens(); issues();
                    }
                });
                return;
            }
            const render = error => {
                container.innerHTML = setup().html({ config: state.approvalConfig, lens: [], cadastreParcelIds: state.land.inputs.parcels.map(p => p.parcelId), heading: false, error });
                container.querySelector('[data-approval-rules-card]')?.remove(); container.querySelector('[data-approval-lens]')?.closest('label')?.remove();
            };
            render();
            auxiliary = root.CbDialog.open({ parent: modal, title: t('agreement.workflow.rights', 'Parcel ownership rights'), body: container, actions: [{ label: t('common.close', 'Close') }] });
            container.addEventListener('change', event => { if (event.target.matches('[data-approval-source], [data-approval-file]')) setup().syncSourceControls(container); });
            container.addEventListener('click', async event => {
                const button = event.target.closest('[data-editor-action]'); if (!button || root.BusyControl.isBusy(button)) return;
                const action = button.dataset.editorAction;
                if (action === 'approval-template') { setup().downloadTemplate(state.land.inputs.parcels.map(p => p.parcelId), state.approvalConfig); return; }
                try {
                    await root.BusyControl.track(button, async () => {
                        if (action === 'approval-import') state.approvalConfig = await setup().importRights(container, state.approvalConfig, { parcelIds: state.land.inputs.parcels.map(p => p.parcelId) });
                        else if (action === 'approval-remove') { state.approvalConfig = setup().withoutRights(state.approvalConfig); await deriveLand(); }
                        if (state.closed) return;
                        reconcileAllocations(); render(); renderRule(); renderLand();
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
                readRule(); const record = draft();
                const checked = api.validate(record, { designOf: id => root.proposalStorage.getProposal(id), isApplied: root.isApplied, translate: t });
                if (!checked.valid || state.contractReading || body.querySelector('[data-drawing-loading]')) { issues(); return; }
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
            if (button.dataset.agreementAction === 'neighbours-measure' && !root.BusyControl.isBusy(button)) {
                root.BusyControl.track(button, measureNeighbours).catch(report);
            }
            if (button.dataset.agreementAction === 'neighbours-add-ticked' && state.neighbours.result) {
                const ticked = state.neighbours.result.lots.filter(lot => state.neighbours.ticked.has(idOf(lot.id)));
                const inputs = new Set(state.land.inputs.parcels.map(parcel => idOf(parcel.parcelId)));
                const added = addAffected(ticked.filter(lot => !inputs.has(idOf(lot.id)))
                    .map(lot => affectedEntry(root.NeighbourEffects.snapshot(lot, state.neighbours.result.guides))));
                // Said in the candidates' live region; focus goes to the first added parcel's terms.
                part('[data-agreement-neighbour-candidates]').insertAdjacentHTML('afterbegin', `<p class="agreement-hint" role="status" data-agreement-neighbours-added>${esc(t('agreement.neighbours.addedCount', 'Added {{count}} neighbouring parcel(s): set each one’s terms below.', { count: added.length }))}</p>`);
                (added.length ? part(`[data-agreement-affected="${root.CSS.escape(added[0].parcelId)}"] [data-affected-field="effect"]`) : null)?.focus();
            }
            if (button.dataset.agreementAction === 'neighbour-add') {
                const input = part('[data-agreement-neighbour-id]');
                const id = idOf(input.value);
                if (id) { addAffected([affectedEntry({ parcelId: id })]); part('[data-agreement-neighbour-id]')?.focus(); }
            }
            if (button.dataset.affectedRemove !== undefined) {
                const id = button.dataset.affectedRemove;
                const rows = [...body.querySelectorAll('[data-agreement-affected]')].map(row => row.dataset.agreementAffected);
                const next = rows[rows.indexOf(id) + 1] ?? rows[rows.indexOf(id) - 1] ?? null;
                state.values.affected = state.values.affected.filter(entry => idOf(entry.parcelId) !== id);
                neighboursChanged();
                (next !== null ? part(`[data-affected-remove="${root.CSS.escape(next)}"]`) : part('[data-agreement-neighbour-id]'))?.focus();
            }
            if (['rights', 'lens'].includes(button.dataset.agreementAction)) openAuxiliary(button.dataset.agreementAction);
            if (button.dataset.agreementAction === 'apply-plan' && !root.BusyControl.isBusy(button)) {
                root.BusyControl.track(button, async () => {
                    if ((await root.PlanWorkspace.applyFromUi(state.plan, { returnFocus: button })).blocked) return;
                    if (!state.closed) await deriveLand();
                }).catch(report);
            }
            const action = button.dataset.editorAction;
            if (action === 'approval-scheme-guide') {
                const regimes = root.ProposalApprovalRegimes, words = root.ProposalApprovalText;
                const template = regimes?.get(button.dataset.schemeId, button.dataset.schemeVersion) || regimes?.latest(button.dataset.schemeId);
                // The draft against any scheme the guide's picker lands on; without a tally the guide still reads.
                const guideFor = chosen => {
                    try {
                        const record = draft(), ledger = api.ledger(record), result = api.schemeCheck(record, chosen);
                        const names = new Map(partiesOf(state.land.inputs).map(party => [party.ownerKey, party.displayName]));
                        const label = key => names.get(key) || key;
                        const rights = state.approvalConfig?.rights;
                        return { ledger, persons: rights ? personsApi().personPositions(record, rights) : null, names: ownerNames(),
                            rules: result?.check.rules || [], check: result ? { ok: result.check.ok, lines: result.check.rules.map(rule => ({ ok: rule.ok, text: words.checkLines({ rules: [rule] }, t, label)[0] })) } : null };
                    } catch (_) { return { ledger: null, rules: [], check: null }; }
                };
                auxiliary = setup().openSchemeGuide({ parent: modal, template, ...guideFor(template), currency: state.currency,
                    schemeStatus: schemeView().schemeStatus || null, guideFor,
                    action: { label: t('proposalDrafts.approval.guide.use', 'Use this scheme'), run: chosen => {
                        try { state.approvalConfig = setup().withScheme(state.approvalConfig, chosen); renderRule(); issues(); } catch (error) { report(error); }
                    } } });
                return;
            }
            if (action && button.closest('[data-agreement-rule-form]')) {
                try { state.approvalConfig = setup().withRuleAction(part('[data-agreement-rule-form]'), state.approvalConfig, action, button.dataset.testIndex); renderRule(); issues(); }
                catch (error) { report(error); }
            }
        }, { signal });
        body.addEventListener('keydown', event => {
            // Enter in the parcel id field adds the parcel; it must not save the agreement.
            if (event.key === 'Enter' && event.target.matches('[data-agreement-neighbour-id]')) {
                event.preventDefault(); part('[data-agreement-action="neighbour-add"]').click(); return;
            }
            const tab = event.target.closest('[data-agreement-tab]'); if (!tab) return;
            const index = TABS.indexOf(tab.dataset.agreementTab);
            const next = { ArrowRight: (index + 1) % TABS.length, ArrowLeft: (index + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key];
            if (next !== undefined) { event.preventDefault(); activate(TABS[next], true); }
        }, { signal });
        body.addEventListener('click', event => {
            const button = event.target.closest('[data-apartment-add],[data-apartment-remove]');
            if (!button) return;
            const list = body.querySelector('[data-apartment-list]');
            if (button.hasAttribute('data-apartment-add')) {
                if (list.children.length >= 8) return;
                list.insertAdjacentHTML('beforeend', apartmentRowHtml());
                list.lastElementChild.querySelector('input').focus();
            } else {
                const row = button.closest('[data-apartment-unit]');
                const index = [...list.children].indexOf(row);
                state.values.funding.apartments.units.splice(index, 1);
                row.remove();
                (list.children[index]?.querySelector('input') || body.querySelector('[data-apartment-add]')).focus();
            }
            body.querySelector('[data-apartment-add]').disabled = list.children.length >= 8;
            issues();
        }, { signal });
        body.addEventListener('change', async event => {
            const target = event.target;
            try {
                if (target.matches('[data-agreement-neighbour-candidate]')) {
                    if (target.checked) state.neighbours.ticked.add(target.dataset.agreementNeighbourCandidate);
                    else state.neighbours.ticked.delete(target.dataset.agreementNeighbourCandidate);
                    renderCandidates(); return;
                }
                if (target.matches('[data-affected-right], [data-affected-field]')) {
                    updateAffected(target);
                    // Selects, tick boxes and a committed loss change what the row shows (the derived
                    // payment and its note); other typed fields were taken as typed (input below).
                    if (target.matches('select, [type="checkbox"], [data-affected-field="loss"]')) renderNeighbours();
                    renderPersons(); issues(); return;
                }
                if (target.matches('[data-agreement-neighbour-preset]')) {
                    const chosen = recordApi().NEIGHBOUR_PRESETS.find(row => `${row.id}@${row.version}` === target.value);
                    state.values.neighbourCompensation = chosen ? { multipleBasisPoints: chosen.multipleBasisPoints, preset: { id: chosen.id, version: chosen.version } }
                        : target.value === 'custom' ? { multipleBasisPoints: state.values.neighbourCompensation?.multipleBasisPoints || 10000 } : null;
                    part('[data-agreement-neighbour-compensation]').innerHTML = neighbourCompensationHtml(state.values.neighbourCompensation);
                    part('[data-agreement-neighbour-preset]').focus();
                    renderNeighbours(); renderPersons(); issues(); return;
                }
                if (target.matches('[data-apartment-drawing]')) {
                    const file = target.files[0];
                    if (!file) return;
                    const row = target.closest('[data-apartment-unit]');
                    const fileName = row.querySelector('[data-apartment-drawing-name]');
                    const currentUnit = () => state.values.funding.apartments.units[[...body.querySelectorAll('[data-apartment-unit]')].indexOf(row)];
                    row.dataset.drawingLoading = '';
                    currentUnit().drawing = null;
                    fileName.textContent = '';
                    issues();
                    try {
                        if (file.size > api.MAX_CONTRACT_BYTES || !/\.pdf$/i.test(file.name)) throw new Error(t('agreement.funding.apartments.pdfOnly', 'Choose a PDF drawing no larger than 256 KiB.'));
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        if (!row.isConnected || target.files[0] !== file) return;
                        let binary = '';
                        for (const byte of bytes) binary += String.fromCharCode(byte);
                        currentUnit().drawing = { name: file.name, mediaType: 'application/pdf', data: btoa(binary) };
                        fileName.textContent = file.name;
                    } finally {
                        if (target.files[0] === file) delete row.dataset.drawingLoading;
                        issues();
                    }
                    return;
                }
                if (target.matches('[data-agreement-funding-file]')) {
                    const file = target.files && target.files[0];
                    if (!file) return;
                    const mediaType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : file.name.toLowerCase().endsWith('.txt') ? 'text/plain' : '');
                    if (!file.size || file.size > api.MAX_CONTRACT_BYTES || !['application/pdf', 'text/plain'].includes(mediaType)) { target.value = ''; throw new Error(t('agreement.funding.fileInvalid', 'Choose one PDF or UTF-8 text file no larger than 256 KiB.')); }
                    const sequence = ++state.contractSequence;
                    state.contractReading = true; issues();
                    const reader = new FileReader();
                    const failed = () => {
                        if (state.closed || sequence !== state.contractSequence) return;
                        state.contractReading = false;
                        report(new Error(t('agreement.funding.fileReadFailed', 'Could not read the attached terms.'))); issues();
                    };
                    reader.onerror = failed;
                    reader.onabort = failed;
                    reader.onload = () => {
                        if (state.closed || sequence !== state.contractSequence) return;
                        try {
                            const bytes = new Uint8Array(reader.result);
                            let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte); });
                            const contract = { name: file.name, mediaType, data: btoa(binary) };
                            const error = api.fundingError({ targetUsdcAtomic: '1', contract }, t);
                            if (error) throw new Error(error);
                            state.values.funding = { ...state.values.funding, contract };
                            part('[data-agreement-funding-file-name]').textContent = file.name;
                        } catch (error) { report(error); }
                        finally { state.contractReading = false; issues(); }
                    };
                    reader.readAsArrayBuffer(file); return;
                }
                if (target.matches('[data-agreement-plan]')) {
                    readRule(); state.plan = state.plans.find(plan => plan.cid === target.value) || null;
                    state.values.allocations = {};
                    if (state.values.electorate === 'investors') {
                        setFundingPlanDesigns(); renderLand(); issues(); return;
                    }
                    deriveLand(); return;
                }
                if (target.closest('[data-agreement-rule-form]')) { readRule(); renderRule(); renderPersons(); issues(); return; }
                if (target.matches('[data-agreement-allocation-mode]') && target.value === 'random') {
                    readRule(); state.allocationMode = 'individual'; reconcileAllocations();
                    Object.assign(state.values.allocations, randomAllocations(state.land.inputs, state.land.outputs));
                    log(`randomized ${state.land.outputs.length} pieces over ${partiesOf(state.land.inputs).length} persons`);
                    renderRule(); renderLand(); return;
                }
                if (target.matches('[data-agreement-allocation-mode]')) {
                    state.allocationMode = target.value; reconcileAllocations(); renderLand(); return;
                }
                if (target.matches('[data-agreement-allocation]')) {
                    state.values.allocations[target.dataset.agreementAllocation] = target.value; readRule(); renderRule();
                    part('[data-agreement-allocation-summary]').outerHTML = allocationSummaryHtml(state.land, state.values.allocations);
                }
                if (target.matches('[data-agreement-binding]')) state.values.binding = target.checked;
                if (target.matches('[data-agreement-lens-threshold]')) { state.lensThreshold = Number(target.value); renderLens(); issues(); return; }
                if (target.matches('[data-agreement-electorate]')) {
                    const previous = state.values.electorate;
                    readRule(); state.values.electorate = target.value; state.values.binding = target.value === 'investors';
                    if (target.value === 'investors') setFundingPlanDesigns();
                    // Switching a new agreement to crowdfunding drops the default lens (see the state above).
                    if (target.value === 'investors' && !base) state.lens = [];
                    if (previous === 'investors' || target.value === 'investors') {
                        body.innerHTML = bodyHtml({ ...state, today: dateFromDeadline(new Date().toISOString()) });
                        if (target.value === 'investors') renderLens(); else { renderRule(); deriveLand(); }
                        body.querySelector(`[data-agreement-electorate][value="${target.value}"]`)?.focus();
                    } else {
                        body.querySelectorAll('[data-agreement-electorate]').forEach(input => { input.checked = input.value === target.value; });
                        renderRule(); renderLand();
                    }
                    issues(); return;
                }
                if (target.matches('[data-agreement-compensation]')) {
                    const terms = state.values.settlement;
                    terms.method = target.value;
                    if (terms.method !== 'area') terms.contributionBasisPoints = 0;
                    if (terms.method === 'value') terms.rateCentsPerM2 = 0;
                    else if (terms.method === 'area' && !(terms.rateCentsPerM2 > 0)) terms.rateCentsPerM2 = api.DEFAULT_SETTLEMENT.rateCentsPerM2;
                    renderRule(); renderLand(); return;
                }
                renderPersons(); issues();
            } catch (error) { report(error); }
        }, { signal });
        body.addEventListener('input', event => {
            const target = event.target, terms = state.values.settlement;
            if (target.matches('[data-affected-field]:not(select)')) {
                updateAffected(target);
                // A compensation's payment follows its stated loss as it is typed (read-only while it does).
                const row = target.closest('[data-agreement-affected]');
                try {
                    const settled = draft().affected.find(entry => idOf(entry.parcelId) === row.dataset.agreementAffected);
                    const payment = row.querySelector('[data-affected-field="consideration"]');
                    const derived = !!settled && settled.effect === 'compensation' && !!settled.loss && Number.isSafeInteger(settled.loss.amountCents);
                    if (payment !== target) {
                        payment.readOnly = derived;
                        if (derived) { payment.setAttribute('aria-readonly', 'true'); payment.value = centsText(settled.considerationCents); }
                        else payment.removeAttribute('aria-readonly');
                    }
                } catch (_) { /* the validation names the problem */ }
                renderPersons(); issues(); return;
            }
            if (target.matches('[data-agreement-neighbour-multiple]')) {
                const multiple = Number(target.value);
                state.values.neighbourCompensation = { multipleBasisPoints: target.value.trim() && Number.isFinite(multiple) ? Math.round(multiple * 10000) : NaN };
                renderNeighbours(); renderPersons(); issues(); return;
            }
            if (target.matches('[data-agreement-funding-target]')) { state.values.funding.targetInput = target.value; const amount = api.parseUsdc(target.value); state.values.funding.targetUsdcAtomic = amount === null ? '' : String(amount); issues(); return; }
            if (target.matches('[data-agreement-rate-slider]')) {
                terms.rateCentsPerM2 = Number(target.value); part('[data-agreement-rate]').value = terms.rateCentsPerM2 / 100;
            } else if (target.matches('[data-agreement-rate]')) {
                const rate = Number(target.value); terms.rateCentsPerM2 = target.value.trim() && Number.isFinite(rate) ? Math.round(rate * 100) : NaN;
                part('[data-agreement-rate-slider]').value = terms.rateCentsPerM2;
            } else if (target.matches('[data-agreement-contribution]')) {
                terms.contributionBasisPoints = Number(target.value); part('[data-agreement-contribution-value]').value = `${terms.contributionBasisPoints / 100}%`;
            } else if (target.matches('[data-agreement-value-all]')) {
                // One amount for every parcel or piece of the tab; each row can still be changed after.
                const cents = cashCents(target.value);
                if (cents !== null && !Number.isNaN(cents) && cents >= 0) {
                    const kind = target.dataset.agreementValueAll;
                    const rows = kind === 'inputs' ? state.land.inputs.parcels.map(parcel => parcel.parcelId) : state.land.outputs.map(output => output.hash);
                    rows.forEach(id => { state.values.valuation[kind][id] = cents; });
                    body.querySelectorAll(`[data-agreement-value-kind="${kind}"]`).forEach(input => { input.value = centsText(cents); });
                }
            } else if (target.matches('[data-agreement-value-kind]')) {
                // An amount being typed that is not one yet is kept out, so the validation names it.
                const cents = cashCents(target.value);
                const kind = target.dataset.agreementValueKind, id = target.dataset.agreementValueId;
                if (cents === null || Number.isNaN(cents) || cents < 0) delete state.values.valuation[kind][id];
                else state.values.valuation[kind][id] = cents;
            } else if (target.matches('[data-agreement-title]')) state.values.title = target.value;
            else if (target.matches('[data-agreement-deadline]')) {
                state.values.deadline = target.value;
                if (state.values.electorate === 'investors') state.values.fundingDeadlineDirty = true;
            }
            else if (target.matches('[data-agreement-organiser]')) state.values.organiser = target.value;
            else if (target.matches('[data-agreement-participation-url]')) state.values.participationUrl = target.value;
            if (state.values.electorate === 'investors') { issues(); return; }
            renderPersons(); issues();
        }, { signal });
        body.addEventListener('paste', event => {
            const target = event.target;
            if (!target.matches('[data-apartment="xrayBuilding"]')) return;
            let url;
            try { url = new URL(event.clipboardData.getData('text').trim()); } catch (_) { return; }
            if (!['http:', 'https:'].includes(url.protocol)) return;
            const params = url.searchParams, building = params.get('xrayBuilding'), unit = params.get('unit');
            if (!api.apartmentLocator(building) || !api.apartmentUnitLocator(unit)) return;
            event.preventDefault();
            target.value = building;
            const row = target.closest('[data-apartment-unit]');
            row.querySelector('[data-apartment="unit"]').value = unit;
            row.querySelector('[data-apartment="at"]').value = params.get('at') || '';
            row.querySelector('[data-apartment="access"]').value = params.get('access') || '';
            issues();
        }, { signal });
        unregisterEscape = root.ModalEscape?.register(panel, event => { if (typingIn(event.target)) return false; finish(null); return true; });
        modal.addEventListener('cancel', event => event.preventDefault(), { signal });
        // Local controls receive their keys; page-level drawing and navigation shortcuts do not.
        modal.addEventListener('keydown', event => event.stopPropagation(), { signal });
        panel.classList.add('visible'); doc.body.classList.add('agreement-editor-open');
        modal.showModal(); panel.querySelector('#agreement-editor-title').focus({ preventScroll: true });
        try { if (state.values.electorate === 'investors') { renderLens(); issues(); } else { renderRule(); await deriveLand(); } }
        catch (error) { finish(null); throw error; }
        log(`opened ${state.id} for plan ${state.plan?.cid || '(choose plan)'}`);
        return closed;
    }
    return {
        open, SCHEMA, LOCAL_RIGHTS_PROVIDER, appliedDesigns, designTitle, inputParcelIds, originalsById,
        partiesOf, allocationOptions, allocationValue, allocationTo, allocationMode, randomAllocations, allocationSpread,
        allocationSummaryHtml, tabLabel, tabCounts, cashCents, cashInputText, termsOf, lensSummaryHtml, lensThresholdOptionsHtml, lensRule,
        keptTerms, sponsorLine, ruleConfigAfterDerive, deadlineFromDate, dateFromDeadline, recordFromForm,
        issueText, waitingText, ownersText, partyLabel, landHtml, allocationHtml, valuationHtml, valuationRows, ruleHtml, detailsHtml,
        consultationHtml, bodyHtml, personsHtml, planSelectorHtml, inputDesignsHtml,
        readingText, affectedEntry, candidatesHtml, affectedRowHtml, neighboursHtml, neighbourCompensationHtml, affectedRows
    };
});
