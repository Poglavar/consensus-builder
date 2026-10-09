// Read-only comparison dialog: select two proposal groups, render shared-scope results, and save or reopen pinned snapshots.
(function (global) {
    'use strict';

    const doc = global.document;
    const DIALOG_ID = 'proposal-comparison-dialog';
    const SIDES = ['a', 'b'];
    const METRICS = [
        ['proposalCount', 'metrics.proposalCount', 'Proposals', 'count'],
        ['siteAreaM2', 'metrics.siteAreaM2', 'Site area', 'area'],
        ['buildingCount', 'metrics.buildingCount', 'Buildings', 'count'],
        ['buildingFootprintM2', 'metrics.buildingFootprintM2', 'Building footprint', 'area'],
        ['grossFloorAreaM2', 'metrics.grossFloorAreaM2', 'Gross floor area', 'area'],
        ['floorAreaRatio', 'metrics.floorAreaRatio', 'Floor area ratio', 'ratio'],
        ['housingUnits', 'metrics.housingUnits', 'Homes', 'count'],
        ['people', 'metrics.people', 'People', 'count'],
        ['jobs', 'metrics.jobs', 'Jobs', 'count'],
        ['parkAreaM2', 'metrics.parkAreaM2', 'Green space', 'area'],
        ['squareAreaM2', 'metrics.squareAreaM2', 'Paved open space', 'area'],
        ['waterAreaM2', 'metrics.waterAreaM2', 'Water', 'area'],
        ['roadAreaM2', 'metrics.roadAreaM2', 'Road and rail area', 'area']
    ];
    const ASSUMPTIONS = [
        ['floorHeightM', 'assumptions.floorHeightM', 'Floor height (m)', 3, '0.1'],
        ['housingShare', 'assumptions.housingShare', 'Housing share (%)', 75, '1', true],
        ['efficiency', 'assumptions.efficiency', 'Net-to-gross efficiency (%)', 80, '1', true],
        ['avgApartmentM2', 'assumptions.avgApartmentM2', 'Average home size (m²)', 65, '1'],
        ['personsPerApartment', 'assumptions.personsPerApartment', 'People per home', 2.4, '0.1'],
        ['m2PerJob', 'assumptions.m2PerJob', 'Floor area per job (m²)', 30, '1']
    ];
    const state = {
        dialog: null, ui: null, proposals: [], selected: [new Set(), new Set()],
        options: {}, sequence: 0, busy: false, snapshot: null, pinnedInput: null,
        result: null, view: 'chooser', currentCards: [], routeAttached: false, inputDiagnostics: []
    };

    function t(key, fallback, params) {
        const api = global.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t('sidebar.proposals.comparison.' + key, params || {});
            if (typeof value === 'string' && value && value !== 'sidebar.proposals.comparison.' + key) return value;
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, function (match, name) {
            return params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
        });
    }

    function engine() { return global.__proposalComparison || null; }
    function codec() { return global.ComparisonSnapshot || null; }
    function storage() { return (global.Proposals && global.Proposals.storage) || global.proposalStorage || null; }
    function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
    function create(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function setAction(node, action) { node.setAttribute('data-action', action); return node; }
    function setSide(node, side) { node.setAttribute('data-side', side); return node; }
    function append(parent, child) { parent.appendChild(child); return child; }
    function addClass(node, value) {
        if (node.classList && node.classList.add) node.classList.add(value);
        else node.className = (node.className + ' ' + value).trim();
    }
    function formatNumber(value, digits) {
        if (!finite(value)) return '—';
        if (global.CbFormat && typeof global.CbFormat.formatNumber === 'function') {
            return global.CbFormat.formatNumber(value, { maxFractionDigits: digits, minFractionDigits: digits });
        }
        return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
    }
    function formatMetric(value, type) {
        if (!finite(value)) return '—';
        if (type === 'count') return formatNumber(value, 0);
        if (type === 'ratio') return formatNumber(value, 2);
        const area = global.CbFormat && typeof global.CbFormat.formatArea === 'function'
            ? global.CbFormat.formatArea(value) : formatNumber(value, 0) + ' m²';
        return area;
    }
    function proposalId(proposal) {
        if (!proposal || typeof proposal !== 'object') return '';
        const id = proposal.proposalId !== undefined && proposal.proposalId !== null ? proposal.proposalId : proposal.id;
        return id === undefined || id === null ? '' : String(id);
    }
    function proposalTitle(proposal) {
        const names = [proposal && proposal.title, proposal && proposal.name,
            proposal && proposal.metadata && proposal.metadata.title];
        for (const name of names) if (typeof name === 'string' && name.trim()) return name.trim();
        return proposalId(proposal) || t('proposal.fallback', 'Untitled proposal');
    }
    function allProposals() {
        const store = storage();
        if (!store) return [];
        try {
            const rows = typeof store.peekAllProposals === 'function' ? store.peekAllProposals()
                : (typeof store.getAllProposals === 'function' ? store.getAllProposals() : []);
            return Array.isArray(rows) ? rows.filter(row => row && proposalId(row)) : [];
        } catch (_) { return []; }
    }
    function defaultAssumptions() {
        const api = engine();
        const defaults = api && (api.DEFAULTS || api.ENGINE_DEFAULTS) || {};
        return {
            floorHeightM: finite(defaults.floorHeightM) ? defaults.floorHeightM : 3,
            housingShare: finite(defaults.housingShare) ? defaults.housingShare : 0.75,
            efficiency: finite(defaults.efficiency) ? defaults.efficiency : 0.8,
            avgApartmentM2: finite(defaults.avgApartmentM2) ? defaults.avgApartmentM2 : 65,
            personsPerApartment: finite(defaults.personsPerApartment) ? defaults.personsPerApartment : 2.4,
            m2PerJob: finite(defaults.m2PerJob) ? defaults.m2PerJob : 30
        };
    }

    function ensureDialog() {
        if (state.ui) return state.ui;
        const dialog = create('dialog', 'proposal-comparison');
        dialog.id = DIALOG_ID;
        dialog.setAttribute('aria-labelledby', 'proposal-comparison-title');
        dialog.setAttribute('aria-modal', 'true');
        const shell = append(dialog, create('div', 'proposal-comparison__shell'));
        const header = append(shell, create('header', 'proposal-comparison__header'));
        const title = append(header, create('h2', 'proposal-comparison__title', t('title', 'Compare proposals')));
        title.id = 'proposal-comparison-title';
        const close = setAction(append(header, create('button', 'comparison-close', '×')), 'close');
        close.type = 'button';
        close.setAttribute('aria-label', t('close', 'Close comparison'));
        const intro = append(shell, create('p', 'proposal-comparison__intro',
            t('intro', 'Compare authored design totals using the same study area and assumptions.')));
        intro.setAttribute('data-role', 'intro');
        const chooser = append(shell, create('section', 'proposal-comparison__chooser'));
        chooser.setAttribute('data-role', 'chooser');
        const sides = append(chooser, create('div', 'comparison-alternatives'));
        const cards = {};
        SIDES.forEach((side, index) => {
            const card = append(sides, create('section', 'comparison-card comparison-card--' + side));
            card.setAttribute('aria-labelledby', 'comparison-name-' + side);
            const nameLabel = append(card, create('label', 'comparison-card__name-label',
                t('alternative.name', 'Alternative {{side}}', { side: side.toUpperCase() })));
            const name = append(nameLabel, create('input', 'comparison-card__name'));
            name.id = 'comparison-name-' + side;
            name.type = 'text';
            name.value = t('alternative.defaultName', 'Alternative {{side}}', { side: side.toUpperCase() });
            name.maxLength = 120;
            name.setAttribute('aria-label', t('alternative.name', 'Alternative {{side}}', { side: side.toUpperCase() }));
            const top = append(card, create('div', 'comparison-card__toolbar'));
            const searchLabel = append(top, create('label', 'comparison-card__search-label', t('proposal.search', 'Filter proposals')));
            const search = append(searchLabel, create('input', 'comparison-card__search'));
            search.type = 'search';
            search.setAttribute('aria-label', t('proposal.search', 'Filter proposals'));
            const applied = setAction(append(top, create('button', 'comparison-use-applied',
                t('proposal.useApplied', 'Use current plan (all applied)'))), 'use-applied');
            applied.type = 'button';
            setSide(applied, side);
            const list = append(card, create('div', 'comparison-card__list'));
            list.setAttribute('role', 'group');
            list.setAttribute('aria-label', t('alternative.proposals', 'Proposals for alternative {{side}}', { side: side.toUpperCase() }));
            cards[side] = { root: card, name: name, search: search, list: list, index: index };
        });
        const assumptions = append(chooser, create('fieldset', 'comparison-assumptions'));
        append(assumptions, create('legend', 'comparison-assumptions__title', t('assumptions.title', 'Shared assumptions')));
        const assumptionInputs = {};
        ASSUMPTIONS.forEach(function (item) {
            const label = append(assumptions, create('label', 'comparison-assumption'));
            append(label, create('span', 'comparison-assumption__label', t(item[1], item[2])));
            const input = append(label, create('input', 'comparison-assumption__input'));
            input.type = 'number';
            input.min = item[0] === 'housingShare' || item[0] === 'efficiency' ? '0' : '0.01';
            if (item[0] === 'housingShare' || item[0] === 'efficiency') input.max = '100';
            input.step = item[4];
            input.value = String(item[3]);
            input.setAttribute('data-assumption', item[0]);
            assumptionInputs[item[0]] = input;
        });
        const controls = append(shell, create('div', 'proposal-comparison__controls'));
        const compareButton = setAction(append(controls, create('button', 'comparison-run',
            t('compare', 'Compare alternatives'))), 'compare');
        compareButton.type = 'button';
        const loadButton = setAction(append(controls, create('button', 'comparison-load',
            t('load', 'Load snapshot'))), 'load');
        loadButton.type = 'button';
        const fileInput = append(controls, create('input', 'comparison-file'));
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        fileInput.hidden = true;
        fileInput.setAttribute('aria-label', t('load', 'Load snapshot'));

        const saved = append(shell, create('section', 'proposal-comparison__saved'));
        saved.setAttribute('data-role', 'saved');
        saved.hidden = true;
        const result = append(shell, create('section', 'proposal-comparison__result'));
        result.setAttribute('data-role', 'result');
        const status = append(result, create('p', 'comparison-status', ''));
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const report = append(result, create('div', 'comparison-report'));
        const error = append(shell, create('p', 'comparison-error', ''));
        error.setAttribute('role', 'alert');
        const saveButton = setAction(append(controls, create('button', 'comparison-save',
            t('save', 'Save snapshot'))), 'save');
        saveButton.type = 'button';
        const linkButton = setAction(append(controls, create('button', 'comparison-link',
            t('copyLink', 'Copy comparison link'))), 'copy-link');
        linkButton.type = 'button';
        state.dialog = dialog;
        if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(dialog);
        state.ui = { dialog: dialog, shell: shell, chooser: chooser, cards: cards,
            assumptions: assumptionInputs, compareButton: compareButton, loadButton: loadButton,
            fileInput: fileInput, saveButton: saveButton, linkButton: linkButton,
            saved: saved, result: result, status: status, report: report, error: error };
        attachHandlers();
        return state.ui;
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }
    function renderProposalList(side) {
        const card = state.ui.cards[side];
        clear(card.list);
        const query = String(card.search.value || '').trim().toLocaleLowerCase();
        const selected = state.selected[card.index];
        const matches = state.proposals.filter(function (proposal) {
            return !query || (proposalTitle(proposal) + ' ' + proposalId(proposal)).toLocaleLowerCase().includes(query);
        });
        if (!matches.length) {
            append(card.list, create('p', 'comparison-empty', t('proposal.none', 'No matching proposals.')));
            return;
        }
        matches.forEach(function (proposal) {
            const id = proposalId(proposal);
            const label = append(card.list, create('label', 'comparison-proposal'));
            const input = append(label, create('input', 'comparison-proposal__check'));
            input.type = 'checkbox';
            input.checked = selected.has(id);
            input.value = id;
            input.setAttribute('data-proposal-id', id);
            input.setAttribute('aria-label', proposalTitle(proposal));
            input.addEventListener('change', function () {
                if (input.checked) selected.add(id); else selected.delete(id);
                invalidateResult();
            });
            const name = append(label, create('span', 'comparison-proposal__name', proposalTitle(proposal)));
            name.title = proposalTitle(proposal);
            const meta = append(label, create('small', 'comparison-proposal__id', id));
            if (proposal.applied === true) addClass(label, 'is-applied');
        });
    }
    function renderLists() { SIDES.forEach(renderProposalList); }

    function readAssumptions() {
        const output = {};
        const invalid = [];
        ASSUMPTIONS.forEach(function (item) {
            const key = item[0];
            const input = state.ui.assumptions[key];
            const raw = String(input.value || '').trim();
            const value = raw === '' ? NaN : Number(raw);
            const minimum = Number(input.min);
            const maximum = input.max !== undefined && input.max !== '' ? Number(input.max) : null;
            const isValid = Number.isFinite(value) && value >= minimum && (maximum === null || value <= maximum);
            if (!isValid) {
                input.setAttribute('aria-invalid', 'true');
                addClass(input, 'is-invalid');
                invalid.push(t(item[1], item[2]));
                return;
            }
            input.removeAttribute('aria-invalid');
            if (input.classList && input.classList.remove) input.classList.remove('is-invalid');
            else input.className = input.className.split(/\s+/).filter(name => name !== 'is-invalid').join(' ');
            output[key] = item[5] ? value / 100 : value;
        });
        if (invalid.length) throw new Error(t('error.invalidAssumptions', 'Correct the highlighted assumptions before comparing: {{fields}}', { fields: invalid.join(', ') }));
        return output;
    }
    function readNames() {
        return SIDES.map(function (side, index) {
            const name = String(state.ui.cards[side].name.value || '').trim();
            return name || t('alternative.defaultName', 'Alternative {{side}}', { side: side.toUpperCase() });
        });
    }
    function selectedProposals(index) {
        const ids = state.selected[index];
        return state.proposals.filter(function (proposal) { return ids.has(proposalId(proposal)); });
    }
    function parcelFeature(id) {
        const repository = global.CadastralParcelRepository;
        if (!repository || typeof repository.get !== 'function') return null;
        try {
            const value = repository.get(String(id));
            const feature = value && value.feature ? value.feature : value;
            return feature && feature.type === 'Feature' && feature.geometry ? feature : null;
        } catch (_) { return null; }
    }
    function currentContext(alternatives, options) {
        const ids = [];
        alternatives.forEach(function (alternative) {
            alternative.proposals.forEach(function (proposal) {
                (Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : []).forEach(function (id) {
                    if (id !== null && id !== undefined && String(id) && !ids.includes(String(id))) ids.push(String(id));
                });
            });
        });
        const parcels = ids.map(id => ({ id: id, feature: parcelFeature(id) })).filter(item => item.feature);
        const context = Object.assign({}, options && options.context || {});
        context.parcels = parcels;
        const requestedCity = options && options.city;
        const knownCity = global.CityConfigManager && typeof global.CityConfigManager.getCurrentCityId === 'function'
            ? global.CityConfigManager.getCurrentCityId() : global.currentCity;
        const cityValue = requestedCity || context.city || (typeof knownCity === 'string' ? knownCity : (knownCity && (knownCity.name || knownCity.city)));
        if (typeof cityValue === 'string' && cityValue.trim()) context.city = cityValue.trim();
        else delete context.city;
        // The engine establishes the union of both authored alternatives. Loaded parcels are
        // fallback evidence for parcel acts, never an implicit clip that drops open-ground designs.
        const scope = options && options.scope || null;
        const diagnostics = [];
        if (ids.length && parcels.length < ids.length) {
            diagnostics.push({
                code: 'missing-cadastral-parcels',
                message: t('scope.missingParcels', 'Could not load {{missing}} of {{total}} immutable cadastral parcels.', { missing: ids.length - parcels.length, total: ids.length })
            });
        }
        return { scope: scope, context: context, diagnostics: diagnostics };
    }
    function capture(input) {
        const api = engine();
        if (!api || typeof api.captureInput !== 'function') throw new Error(t('error.engineMissing', 'The comparison engine is unavailable.'));
        return api.captureInput(input);
    }
    function buildInput() {
        const names = readNames();
        const alternatives = [0, 1].map(function (index) {
            return { name: names[index], proposals: selectedProposals(index) };
        });
        const scopeContext = currentContext(alternatives, state.options);
        state.inputDiagnostics = scopeContext.diagnostics;
        return capture({
            alternatives: alternatives,
            scope: scopeContext.scope,
            assumptions: readAssumptions(),
            context: scopeContext.context
        });
    }

    function invalidateResult() {
        if (!state.result && !state.busy) return;
        state.sequence += 1;
        state.result = null;
        state.pinnedInput = null;
        state.snapshot = null;
        state.ui.result.hidden = true;
        state.ui.saved.hidden = true;
        setBusy(false);
        setError(t('selectionDirty', 'Selections changed. Compare again to update the results.'));
    }

    function setError(message) { state.ui.error.textContent = message || ''; }
    function setStatus(message) { state.ui.status.textContent = message || ''; }
    function setBusy(value) {
        state.busy = value;
        state.ui.compareButton.disabled = value;
        state.ui.compareButton.textContent = value ? t('calculating', 'Comparing…') : t('compare', 'Compare alternatives');
        state.ui.saveButton.disabled = value || !state.result;
        state.ui.linkButton.disabled = value || !state.result;
    }

    function renderIssues(parent, issues, className) {
        if (!Array.isArray(issues) || !issues.length) return;
        const list = append(parent, create('ul', className));
        issues.forEach(function (issue) {
            const item = append(list, create('li', 'comparison-issue'));
            item.textContent = issue && typeof issue.message === 'string' && issue.message
                ? issue.message : (issue && issue.code ? String(issue.code) : t('issue.unknown', 'Unspecified comparison issue'));
        });
    }
    function sideKind(feature) {
        const p = feature && feature.properties || {};
        const kind = String(p.kind || p.type || '').toLowerCase();
        if (kind === 'building' || p.building) return 'building';
        if (kind === 'park') return 'park';
        if (kind === 'square') return 'square';
        if (kind === 'lake' || kind === 'water') return 'water';
        if (kind === 'road' || kind === 'track') return 'road';
        return 'site';
    }
    function renderPreviewLegend(parent, kinds) {
        const labels = [
            ['building', 'preview.buildings', 'Building footprints'],
            ['park', 'metrics.parkAreaM2', 'Green space'],
            ['square', 'metrics.squareAreaM2', 'Paved open space'],
            ['water', 'metrics.waterAreaM2', 'Waterbody area'],
            ['road', 'metrics.roadAreaM2', 'Road and rail area'],
            ['site', 'preview.site', 'Proposal site'],
            ['boundary', 'preview.boundary', 'Study area boundary']
        ];
        const legend = append(parent, create('ul', 'comparison-legend'));
        labels.forEach(function (entry) {
            if (entry[0] !== 'boundary' && !kinds.has(entry[0])) return;
            const item = append(legend, create('li', 'comparison-legend__item'));
            const swatch = append(item, create('span', 'comparison-legend__swatch comparison-legend__swatch--' + entry[0]));
            swatch.setAttribute('aria-hidden', 'true');
            append(item, create('span', 'comparison-legend__label', t(entry[1], entry[2])));
        });
    }
    function renderPreview(parent, side, scope, alternative) {
        const figure = append(parent, create('figure', 'comparison-preview comparison-preview--' + side));
        append(figure, create('figcaption', 'comparison-preview__caption',
            t('preview.caption', 'Top-down view · same scale · heights not shown')));
        const box = append(figure, create('div', 'comparison-preview__image'));
        const collection = alternative.features && Array.isArray(alternative.features.features)
            ? alternative.features.features : [];
        const types = collection.map(sideKind);
        const hasNonSite = types.some(kind => kind !== 'site');
        const layers = [];
        const shownKinds = new Set();
        collection.forEach(function (feature, index) {
            const kind = types[index];
            if (kind === 'site' && hasNonSite) return;
            if (!feature || !feature.geometry) return;
            layers.push({ geometry: feature.geometry, className: 'comparison-preview__' + kind });
            shownKinds.add(kind);
        });
        const renderer = global.__parcelCompare;
        if (!scope || !scope.geometry || !renderer || typeof renderer.previewSvg !== 'function') {
            append(box, create('span', 'comparison-preview__empty', t('preview.unavailable', 'Preview unavailable')));
            return;
        }
        try {
            const svg = renderer.previewSvg(scope.geometry, layers, {
                size: 240,
                label: t('preview.label', 'Alternative {{side}} on shared study area', { side: side.toUpperCase() })
            });
            if (typeof svg !== 'string' || !svg.startsWith('<svg')) throw new Error('SVG preview unavailable');
            // Only our geometry-to-SVG renderer produces markup here. It escapes labels and uses
            // finite coordinates and the fixed kind classes above, so shared records supply no HTML.
            box.innerHTML = svg;
            renderPreviewLegend(figure, shownKinds);
        } catch (_) {
            append(box, create('span', 'comparison-preview__empty', t('preview.unavailable', 'Preview unavailable')));
        }
    }
    function renderAlternative(parent, side, alternative, scope) {
        const card = append(parent, create('article', 'comparison-result-card comparison-result-card--' + side));
        append(card, create('h3', 'comparison-result-card__title', alternative.name || side.toUpperCase()));
        renderPreview(card, side, scope, alternative);
        const members = append(card, create('details', 'comparison-members'));
        const ids = Array.isArray(alternative.proposalIds) ? alternative.proposalIds : [];
        append(members, create('summary', '', t('includedProposals', 'Included proposals ({{count}})', { count: ids.length })));
        const list = append(members, create('ul', ''));
        const pinned = state.pinnedInput && state.pinnedInput.alternatives[side === 'a' ? 0 : 1];
        ids.forEach(function (id) {
            const record = pinned && pinned.proposals.find(p => proposalId(p) === String(id));
            append(list, create('li', '', record ? proposalTitle(record) + ' · ' + id : String(id)));
        });
        renderIssues(card, alternative.issues, 'comparison-result-card__issues');
    }
    function renderTable(parent, result) {
        const wrap = append(parent, create('div', 'comparison-table-wrap'));
        wrap.tabIndex = 0;
        wrap.setAttribute('aria-label', t('title', 'Compare proposals'));
        const table = append(wrap, create('table', 'comparison-metrics'));
        const thead = append(table, create('thead', ''));
        const headRow = append(thead, create('tr', ''));
        ['', result.alternatives[0].name || 'A', result.alternatives[1].name || 'B', t('difference', 'Difference')].forEach((label, index) => {
            const th = append(headRow, create('th', '', label));
            th.scope = 'col';

        });
        const body = append(table, create('tbody', ''));
        METRICS.forEach(function (row) {
            const tr = append(body, create('tr', ''));
            append(tr, create('th', 'comparison-metric__label', t(row[1], row[2]))).scope = 'row';
            [0, 1].forEach(function (index) {
                const td = append(tr, create('td', 'comparison-metric__value'));
                td.textContent = formatMetric(result.alternatives[index].metrics && result.alternatives[index].metrics[row[0]], row[3]);
            });
            const delta = append(tr, create('td', 'comparison-metric__delta'));
            const value = result.deltas && result.deltas[row[0]];
            delta.textContent = (finite(value) && value > 0 ? '+' : '') + formatMetric(value, row[3]);
        });
    }
    function renderResult(result, { snapshot = false, saved = null } = {}) {
        const ui = state.ui;
        clear(ui.report);
        if (!result || !Array.isArray(result.alternatives) || result.alternatives.length !== 2) {
            setStatus(t('result.invalid', 'This comparison result is incomplete.'));
            return;
        }
        const scope = result.scope || (state.pinnedInput && state.pinnedInput.scope);
        const scopeInfo = append(ui.report, create('p', 'comparison-scope'));
        scopeInfo.textContent = scope && scope.source
            ? t('scope.source', 'Shared study area: {{source}}', { source: scope.source === 'union-of-alternatives'
                ? t('scope.union', 'Combined sites of both alternatives') : t('scope.fixed', 'Pinned study area') })
            : t('scope.missing', 'Shared study area could not be resolved from the available geometry.');
        if (scope) scopeInfo.textContent += ' · ' + formatMetric(scope.areaM2, 'area');
        const caveat = append(ui.report, create('p', 'comparison-caveat',
            t('caveat', 'Proposed design totals on a shared study area. Existing buildings and net demolition effects are not included.')));
        const cards = append(ui.report, create('div', 'comparison-result-cards'));
        renderAlternative(cards, 'a', result.alternatives[0], scope);
        renderAlternative(cards, 'b', result.alternatives[1], scope);
        renderTable(ui.report, result);
        const assumptions = append(ui.report, create('details', 'comparison-result-assumptions'));
        append(assumptions, create('summary', '', t('assumptions.title', 'Shared assumptions')));
        const values = append(assumptions, create('dl', 'comparison-assumptions-summary'));
        ASSUMPTIONS.forEach(function (item) {
            append(values, create('dt', '', t(item[1], item[2])));
            const value = result.assumptions && result.assumptions[item[0]];
            append(values, create('dd', '', formatNumber(finite(value) && item[5] ? value * 100 : value, 2)));
        });
        renderIssues(ui.report, (state.inputDiagnostics || []).concat(Array.isArray(result.issues) ? result.issues : []), 'comparison-global-issues');
        const meta = append(ui.report, create('p', 'comparison-metadata', ''));
        if (saved) {
            const date = saved.createdAt || t('saved.unknownDate', 'Unknown date');
            const version = saved.engineVersion || result.engineVersion || t('saved.unknownVersion', 'unknown');
            meta.textContent = t('saved.meta', 'Saved {{date}} · engine {{version}}', { date: date, version: version });
        } else if (result.engineVersion) {
            meta.textContent = t('engineVersion', 'Engine {{version}}', { version: result.engineVersion });
        }
        ui.saved.hidden = !snapshot;
        if (snapshot && saved) {
            clear(ui.saved);
            append(ui.saved, create('p', 'comparison-saved-meta', t('saved.readOnly', 'Saved comparison (read-only). Recalculate only when you choose to use the pinned inputs.')));
            append(ui.saved, create('p', 'comparison-saved-meta', t('saved.meta', 'Saved {{date}} · engine {{version}}', {
                date: saved.createdAt || t('saved.unknownDate', 'Unknown date'),
                version: saved.engineVersion || result.engineVersion || t('saved.unknownVersion', 'unknown')
            })));
            const recalc = setAction(append(ui.saved, create('button', 'comparison-recalculate',
                t('recalculate', 'Recalculate pinned inputs'))), 'recalculate');
            recalc.type = 'button';
            recalc.addEventListener('click', function () { recalculatePinned(); });
        }
        ui.result.hidden = false;
        ui.saveButton.disabled = !state.result;
        ui.linkButton.disabled = !state.result;
        setStatus(t('result.ready', 'Comparison ready.'));
    }

    function updatePinnedScope(input, result) {
        if (!input || !result || !result.scope) return input;
        const cloned = Object.assign({}, input, { scope: result.scope });
        return capture(cloned);
    }
    async function runComparison(input, isRecalculate) {
        const api = engine();
        if (!api || typeof api.compare !== 'function') throw new Error(t('error.engineMissing', 'The comparison engine is unavailable.'));
        const request = ++state.sequence;
        setError('');
        setBusy(true);
        setStatus(t('calculating', 'Comparing…'));
        try {
            const captured = capture(input);
            const result = await Promise.resolve(api.compare(captured, { turf: global.turf }));
            if (request !== state.sequence) return;
            const pinned = updatePinnedScope(captured, result);
            state.pinnedInput = pinned;
            state.result = result;
            state.snapshot = null;
            state.view = 'result';
            if (isRecalculate) state.ui.saved.hidden = true;
            renderResult(result);
        } catch (error) {
            if (request === state.sequence) {
                state.result = null;
                state.pinnedInput = null;
                setError(error && error.message ? error.message : t('error.compare', 'Comparison failed.'));
                setStatus('');
                state.ui.saveButton.disabled = true;
                state.ui.linkButton.disabled = true;
            }
        } finally {
            if (request === state.sequence) setBusy(false);
        }
    }
    function selectedValidation() {
        const missing = [];
        SIDES.forEach(function (side, index) {
            if (!state.selected[index].size) missing.push(side.toUpperCase());
        });
        return missing;
    }
    async function compareSelected() {
        const missing = selectedValidation();
        if (missing.length) {
            setError(t('error.needProposals', 'Choose at least one proposal for each alternative.'));
            return;
        }
        if (!engine() || typeof engine().captureInput !== 'function') {
            setError(t('error.engineMissing', 'The comparison engine is unavailable.'));
            return;
        }
        try {
            const input = buildInput();
            state.ui.result.hidden = true;
            await runComparison(input, false);
        } catch (error) {
            setError(error && error.message ? error.message : t('error.invalidAssumptions', 'Correct the highlighted assumptions before comparing.'));
        }
    }

    function snapshotForCurrentResult() {
        const api = codec();
        if (!api || typeof api.create !== 'function') throw new Error(t('error.snapshotMissing', 'Snapshot support is unavailable.'));
        if (!state.pinnedInput || !state.result) throw new Error(t('error.noResult', 'Run a comparison first.'));
        const input = capture(updatePinnedScope(state.pinnedInput, state.result));
        return api.create(input, state.result, { createdAt: new Date().toISOString() });
    }
    function downloadSnapshot() {
        setError('');
        try {
            const api = codec();
            if (!api || typeof api.stringify !== 'function') throw new Error(t('error.snapshotMissing', 'Snapshot support is unavailable.'));
            const snapshot = snapshotForCurrentResult();
            const text = api.stringify(snapshot);
            const blob = new Blob([text], { type: 'application/json' });
            const urlApi = global.URL;
            if (!urlApi || typeof urlApi.createObjectURL !== 'function') throw new Error(t('error.downloadUnavailable', 'Snapshot download is unavailable in this browser.'));
            const url = urlApi.createObjectURL(blob);
            const link = create('a', '', t('download.filename', 'proposal-comparison.json'));
            link.href = url;
            link.download = 'proposal-comparison.json';
            append(state.ui.shell, link);
            link.click();
            link.remove();
            urlApi.revokeObjectURL(url);
        } catch (error) { setError(error && error.message ? error.message : t('error.snapshot', 'Could not save this snapshot.')); }
    }
    function copyLink() {
        const operation = ++state.sequence;
        setError('');
        try {
            const api = codec();
            if (!api || typeof api.toHash !== 'function') throw new Error(t('error.snapshotMissing', 'Snapshot support is unavailable.'));
            const snapshot = snapshotForCurrentResult();
            const hash = api.toHash(snapshot);
            const location = global.location;
            const href = location && location.href ? location.href : 'http://localhost/';
            const url = new URL(href);
            const sourceParams = new URLSearchParams(location && location.search || '');
            const rootUrl = new URL('/', url.origin);
            ['city', 'lang'].forEach(function (key) {
                if (sourceParams.has(key)) rootUrl.searchParams.set(key, sourceParams.get(key));
            });
            rootUrl.hash = String(hash).startsWith('#') ? String(hash).slice(1) : String(hash);
            const text = rootUrl.toString();
            if (text.length > 70000) throw new Error(t('error.linkTooLarge', 'This comparison link is too large. Save and share the snapshot file instead.'));
            const clipboard = global.navigator && global.navigator.clipboard;
            if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error(t('error.clipboardUnavailable', 'Clipboard access is unavailable; save the snapshot file instead.'));
            Promise.resolve(clipboard.writeText(text)).then(function () {
                if (operation === state.sequence && state.ui) setStatus(t('link.copied', 'Comparison link copied.'));
            }).catch(function () {
                if (operation === state.sequence && state.ui) setError(t('error.clipboardUnavailable', 'Clipboard access is unavailable; save the snapshot file instead.'));
            });
        } catch (error) {
            const message = error && error.message ? error.message : '';
            if (/too large|exceeds.*(?:characters|bytes)/i.test(message)) {
                setError(t('error.linkTooLarge', 'This comparison link is too large. Save and share the snapshot file instead.'));
            } else {
                setError(message || t('error.link', 'Could not create a comparison link. Save the snapshot file instead.'));
            }
        }
    }

    function displaySnapshot(snapshot) {
        const api = codec();
        if (!api || typeof api.stringify !== 'function') throw new Error(t('error.snapshotMissing', 'Snapshot support is unavailable.'));
        api.stringify(snapshot);
        state.snapshot = snapshot;
        state.inputDiagnostics = [];
        state.pinnedInput = snapshot.input;
        state.result = snapshot.result;
        state.view = 'snapshot';
        state.ui.chooser.hidden = true;
        state.ui.compareButton.hidden = true;
        state.ui.loadButton.hidden = true;
        state.ui.fileInput.hidden = true;
        state.ui.saveButton.hidden = true;
        state.ui.linkButton.hidden = true;
        renderResult(snapshot.result, { snapshot: true, saved: snapshot });
        setError('');
    }
    function resetChooser() {
        state.ui.chooser.hidden = false;
        state.ui.compareButton.hidden = false;
        state.ui.loadButton.hidden = false;
        state.ui.fileInput.hidden = true;
        state.ui.saveButton.hidden = false;
        state.ui.linkButton.hidden = false;
        state.ui.saved.hidden = true;
        state.ui.result.hidden = true;
        state.ui.saveButton.disabled = true;
        state.ui.linkButton.disabled = true;
    }
    function open(options) {
        state.sequence += 1;
        const ui = ensureDialog();
        state.options = options || {};
        state.proposals = allProposals();
        state.selected = [new Set(), new Set()];
        const proposalIds = Array.isArray(state.options.proposalIds) ? state.options.proposalIds : [];
        proposalIds.slice(0, 2).forEach(function (id, index) { state.selected[index].add(String(id)); });
        state.result = null;
        state.snapshot = null;
        state.inputDiagnostics = [];
        state.pinnedInput = null;
        state.view = 'chooser';
        SIDES.forEach(function (side) {
            ui.cards[side].name.value = t('alternative.defaultName', 'Alternative {{side}}', { side: side.toUpperCase() });
            ui.cards[side].search.value = '';
        });
        resetChooser();
        setBusy(false);
        setError('');
        setStatus('');
        const defaults = defaultAssumptions();
        ASSUMPTIONS.forEach(function (item) {
            const input = ui.assumptions[item[0]];
            input.value = String(item[5] ? defaults[item[0]] * 100 : defaults[item[0]]);
        });
        renderLists();
        if (typeof ui.dialog.showModal === 'function' && !ui.dialog.open) ui.dialog.showModal();
        else ui.dialog.setAttribute('open', '');
        return ui.dialog;
    }
    function close() {
        state.sequence += 1;
        state.busy = false;
        if (!state.ui || !state.dialog) return;
        if (typeof state.dialog.close === 'function' && state.dialog.open) state.dialog.close();
        else state.dialog.removeAttribute('open');
    }
    function openSnapshot(snapshot) {
        state.sequence += 1;
        const ui = ensureDialog();
        resetChooser();
        state.result = null;
        state.pinnedInput = null;
        state.snapshot = null;
        try {
            displaySnapshot(snapshot);
            if (typeof ui.dialog.showModal === 'function' && !ui.dialog.open) ui.dialog.showModal();
            else ui.dialog.setAttribute('open', '');
        } catch (error) {
            setError(error && error.message ? error.message : t('error.snapshot', 'Could not open snapshot.'));
            if (typeof ui.dialog.showModal === 'function' && !ui.dialog.open) ui.dialog.showModal();
            else ui.dialog.setAttribute('open', '');
        }
        return ui.dialog;
    }
    function recalculatePinned() {
        if (!state.snapshot || !state.snapshot.input) return;
        const ui = state.ui;
        ui.saved.hidden = true;
        ui.chooser.hidden = true;
        ui.compareButton.hidden = true;
        ui.loadButton.hidden = true;
        ui.saveButton.hidden = false;
        ui.linkButton.hidden = false;
        ui.result.hidden = true;
        runComparison(state.snapshot.input, true);
    }

    function loadSnapshotFile(file) {
        if (!file || typeof file.text !== 'function') return;
        const operation = ++state.sequence;
        setError('');
        if (file.size > (codec() && codec().MAX_JSON_BYTES || 2 * 1024 * 1024)) {
            setError(t('error.linkTooLarge', 'This comparison is too large. Use a smaller snapshot file.'));
            return;
        }
        Promise.resolve(file.text()).then(function (text) {
            if (operation !== state.sequence) return;
            const api = codec();
            if (!api || typeof api.parse !== 'function') throw new Error(t('error.snapshotMissing', 'Snapshot support is unavailable.'));
            const snapshot = api.parse(text);
            openSnapshot(snapshot);
        }).catch(function (error) {
            if (operation === state.sequence) setError(error && error.message ? error.message : t('error.snapshot', 'Could not load this snapshot.'));
        });
    }
    function attachHandlers() {
        const ui = state.ui;
        ui.compareButton.addEventListener('click', compareSelected);
        ui.loadButton.addEventListener('click', function () { ui.fileInput.click(); });
        ui.fileInput.addEventListener('change', function () {
            const file = ui.fileInput.files && ui.fileInput.files[0];
            loadSnapshotFile(file);
            ui.fileInput.value = '';
        });
        ui.saveButton.addEventListener('click', downloadSnapshot);
        ui.linkButton.addEventListener('click', copyLink);
        ui.dialog.addEventListener('cancel', function (event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            close();
        });
        ui.dialog.addEventListener('click', function (event) {
            const target = event && event.target;
            const action = target && target.getAttribute ? target.getAttribute('data-action') : null;
            if (action === 'close') close();
            if (action === 'use-applied') {
                const index = target.getAttribute('data-side') === 'b' ? 1 : 0;
                state.selected[index] = new Set(state.proposals.filter(p => p.applied === true).map(proposalId));
                renderProposalList(SIDES[index]);
                invalidateResult();
            }
        });
        SIDES.forEach(function (side) {
            ui.cards[side].name.addEventListener('input', invalidateResult);
            ui.cards[side].search.addEventListener('input', function () { renderProposalList(side); });
        });
        Object.values(ui.assumptions).forEach(input => input.addEventListener('input', invalidateResult));
    }

    function loadHashRoute() {
        const location = global.location;
        const api = codec();
        if (!location || !location.hash || !location.hash.startsWith('#comparison=') ||
            !api || typeof api.fromHash !== 'function') return;
        try { openSnapshot(api.fromHash(location.hash)); }
        catch (error) {
            open({});
            setError(error && error.message ? error.message : t('error.hash', 'Could not read the saved comparison link.'));
        }
    }
    function attachRoute() {
        if (state.routeAttached || !doc) return;
        state.routeAttached = true;
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', loadHashRoute, { once: true });
        else loadHashRoute();
    }

    const api = { open: open, close: close, openSnapshot: openSnapshot };
    global.ProposalComparison = api;
    attachRoute();
})(typeof window !== 'undefined' ? window : globalThis);
