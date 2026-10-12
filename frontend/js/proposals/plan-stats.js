// proposals/plan-stats.js — the Plan Stats dialog: what the plan on this map amounts to.
//
// The arithmetic is NOT here. It is in proposals/plan-yield.js, which is pure and unit-tested, and
// which backend/scripts/plan-yield.js runs over the database — so a figure read off this dialog and
// a figure quoted from the command line come from the same code. This file is the thin part: pick
// the proposals that make up the plan, resolve the geometry of parcels the plan leaves standing,
// and draw the result.
//
// The old resulting-parcel count read Leaflet's current viewport, so a large plan could report four
// parcels. The current count reads the authoritative LiveParcelFabric over the plan's complete
// cadastral scope. Proposal records supply that scope; they never store generated parcel ids.
(function () {
    const DEFAULT_PRICE_PER_SQM = 5000;

    let latestStats = null;
    let epochView = 'added';

    function yieldApi() {
        return (typeof window !== 'undefined' && window.__planYield) ? window.__planYield : null;
    }

    // Site/binding figures (proposals/site-stats.js). Optional: without it the dialog still counts
    // parcels, it just cannot say how much of the plan stands on open ground.
    function siteStatsApi() {
        return (typeof window !== 'undefined' && window.__siteStats) ? window.__siteStats : null;
    }

    function finiteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function formatTemplate(template, values = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, k1, k2) => {
            const key = k1 || k2;
            return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
        });
    }

    function tPlanStats(key, fallback, params = {}) {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            // i18n.t interpolates {{x}} and {x} itself, so a translated string comes back finished.
            const translated = api.t(key, params);
            if (translated && translated !== key) return translated;
        }
        return formatTemplate(fallback, params);
    }

    // Numbers go through the shared formatter (js/format.js) in the UI language. The toLocaleString
    // path is for plan-stats-render.test.js, which runs this file without format.js.
    function formatNumber(value, fractionDigits = 0) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        if (typeof CbFormat !== 'undefined') {
            return CbFormat.formatNumber(num, { maxFractionDigits: fractionDigits, minFractionDigits: fractionDigits });
        }
        return num.toLocaleString(undefined, {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits
        });
    }

    function formatSquareMetres(value) {
        const num = Number(value);
        if (typeof CbFormat !== 'undefined' && Number.isFinite(num)) return CbFormat.formatArea(num);
        return `${formatNumber(num)} m²`;
    }

    // The sales price input is EUR per m² (salesSuffix), so the value is EUR: amount then code.
    function formatSalesValue(value) {
        const num = Number(value);
        if (typeof CbFormat !== 'undefined' && Number.isFinite(num)) return CbFormat.formatMoney(num, 'EUR');
        return `${formatNumber(num)} ${tPlanStats('sidebar.proposals.planStats.currency', 'EUR')}`;
    }

    // Current output comes from the live fabric; an untouched cadastral result comes from the
    // immutable repository. There is no third parcel store and Leaflet is never queried for data.
    function getParcelFeature(parcelId) {
        if (!parcelId) return null;
        const id = parcelId.toString();
        return window.LiveParcelFabric?.get?.(id)
            || window.CadastralParcelRepository?.get?.(id)
            || null;
    }

    function readAssumptionsFromModal(modal) {
        const api = yieldApi();
        const defaults = api ? api.DEFAULTS : {};
        const read = (id, fallback, scale = 1) => {
            const input = modal ? modal.querySelector(id) : null;
            const value = Number(input && input.value);
            const minimum = input && input.min !== '' && input.min !== undefined ? Number(input.min) : 0;
            return input && input.value.trim() !== '' && Number.isFinite(value) && value >= minimum
                ? value * scale : fallback;
        };
        return {
            appliedOnly: true,
            housingShare: Math.min(1, read('#plan-stats-housing-share', (defaults.housingShare ?? 0.75) * 100) / 100),
            efficiency: Math.min(1, read('#plan-stats-efficiency', (defaults.efficiency ?? 0.8) * 100) / 100),
            avgApartmentM2: read('#plan-stats-apartment-size', defaults.avgApartmentM2 ?? 65),
            personsPerApartment: read('#plan-stats-persons', defaults.personsPerApartment ?? 2.4),
            m2PerJob: defaults.m2PerJob ?? 30,
            floorHeightM: defaults.floorHeightM ?? 3
        };
    }

    function computePlanStatsSync(assumptions) {
        const api = yieldApi();
        const all = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function')
            ? proposalStorage.getAllProposals()
            : [];
        if (!api) {
            return { unavailable: true, proposalsTotal: all.length };
        }

        const applied = all.filter(p => p && p.applied === true);
        // Open space as it stands on the map: parks/squares/lakes carved by later roads.
        const appliedBodies = new Map();
        ['parks', 'squares', 'lakes'].forEach(name => {
            (Array.isArray(window[name]) ? window[name] : []).forEach(feature => {
                const id = feature && feature.properties && feature.properties.proposalId;
                if (id !== undefined && id !== null && feature.geometry) appliedBodies.set(String(id), feature);
            });
        });
        const openSpaceAreaOf = proposal => {
            const feature = appliedBodies.get(String(proposal && proposal.proposalId));
            if (!feature || !window.turf) return null;
            try { return window.turf.area(feature); } catch (_) { return null; }
        };
        const result = api.planYield(applied, { ...assumptions, openSpaceAreaOf });
        const cadastreIds = Array.from(new Set(applied.flatMap(proposal => (
            Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds.map(String) : []
        ))));
        const materializedFeatures = window.LiveParcelFabric?.entriesForCadastre
            ? window.LiveParcelFabric.entriesForCadastre(cadastreIds, { includeCorridors: false })
            : [];
        const parcels = api.resultingParcels(applied, { materializedFeatures });

        // Only the AREA needs the map. Count what we could measure so the average carries its own
        // confidence instead of pretending the parcels it could not reach do not exist.
        let measuredArea = 0;
        let measuredCount = 0;
        parcels.resulting.forEach(id => {
            const feature = getParcelFeature(id);
            const area = feature ? api.geometryAreaM2(feature) : 0;
            if (area > 0) {
                measuredArea += area;
                measuredCount += 1;
            }
        });

        // Parcel figures are binding metrics: a plan whose proposals bind no cadastral parcel (all
        // on open ground) has none, and says so with null rather than a count of 0.
        const noParcels = applied.length > 0 && parcels.bound === false;
        const ground = siteStatsApi() ? siteStatsApi().planGround(applied) : null;

        return {
            unavailable: false,
            proposalsTotal: all.length,
            proposalsCounted: applied.length,
            yield: result,
            parcelCount: noParcels ? null : parcels.resulting.length,
            parcelProduced: noParcels ? null : parcels.produced.length,
            parcelConsumed: noParcels ? null : parcels.consumed.length,
            parcelMeasuredCount: noParcels ? null : measuredCount,
            parcelMeasuredArea: noParcels ? null : measuredArea,
            openGroundM2: ground && finiteNumber(ground.openGroundM2) ? ground.openGroundM2 : null
        };
    }

    function computePlanStatsAsync(assumptions) {
        return new Promise(resolve => {
            requestAnimationFrame(() => resolve(computePlanStatsSync(assumptions)));
        });
    }

    // Looks live in css/modals.css (.plan-stats-*) and css/primitives.css, never inline.
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    const SUMMARY_ROWS = [
        { key: 'resulting-parcels', i18nKey: 'sidebar.proposals.planStats.resultingParcels', label: 'Resulting parcels (avg m²)' },
        { key: 'buildings', i18nKey: 'sidebar.proposals.planStats.buildings', label: 'Buildings (footprint m²)' },
        { key: 'floor-area', i18nKey: 'sidebar.proposals.planStats.floorArea', label: 'Gross floor area (m²)' },
        { key: 'open-space', i18nKey: 'sidebar.proposals.planStats.openSpace', label: 'Open space — parks, squares, water (m²)' },
        { key: 'apartments', i18nKey: 'sidebar.proposals.planStats.apartments', label: 'Apartments' },
        { key: 'people', i18nKey: 'sidebar.proposals.planStats.people', label: 'People' },
        { key: 'jobs', i18nKey: 'sidebar.proposals.planStats.jobs', label: 'Jobs' },
        { key: 'sales-value', i18nKey: 'sidebar.proposals.planStats.salesValue', label: 'Sales value of the floor area' }
    ];

    const ASSUMPTION_INPUTS = [
        { id: 'plan-stats-price', i18nKey: 'sidebar.proposals.planStats.salesSuffix', label: 'EUR per m²', min: 0, step: 100, value: () => DEFAULT_PRICE_PER_SQM },
        { id: 'plan-stats-housing-share', i18nKey: 'sidebar.proposals.planStats.housingShareSuffix', label: '% housing share', min: 0, max: 100, step: 5, value: d => Math.round((d.housingShare ?? 0.75) * 100) },
        { id: 'plan-stats-efficiency', i18nKey: 'sidebar.proposals.planStats.efficiencySuffix', label: '% net of gross', min: 1, max: 100, step: 5, value: d => Math.round((d.efficiency ?? 0.8) * 100) },
        { id: 'plan-stats-apartment-size', i18nKey: 'sidebar.proposals.planStats.apartmentSizeSuffix', label: 'm² per apartment', min: 1, step: 5, value: d => d.avgApartmentM2 ?? 65 },
        { id: 'plan-stats-persons', i18nKey: 'sidebar.proposals.planStats.personsSuffix', label: 'people per apartment', min: 0.1, step: 0.1, value: d => d.personsPerApartment ?? 2.4 }
    ];

    const EPOCH_COLUMNS = [
        { i18nKey: 'sidebar.proposals.planStats.colProposals', label: 'proposals', get: b => formatNumber(b.proposals) },
        { i18nKey: 'sidebar.proposals.planStats.colBuildings', label: 'buildings', get: b => formatNumber(b.buildings) },
        { i18nKey: 'sidebar.proposals.planStats.colFloorArea', label: 'GFA m²', get: b => formatNumber(b.grossFloorAreaM2) },
        { i18nKey: 'sidebar.proposals.planStats.colApartments', label: 'apartments', get: b => formatNumber(b.apartments) },
        { i18nKey: 'sidebar.proposals.planStats.colPeople', label: 'people', get: b => formatNumber(b.people) }
    ];

    // The dialog wears the dialog primitive (css/primitives.css): overlay, card, header with one
    // close button, body. It is kept between opens, so the assumptions typed into it survive, and
    // is shown and hidden with the `hidden` attribute.
    function ensureModal() {
        let overlay = document.getElementById('plan-stats-modal');
        if (overlay) return overlay;

        overlay = el('div', 'cb-dialog-overlay plan-stats-overlay');
        overlay.id = 'plan-stats-modal';
        overlay.hidden = true;

        const dialog = el('div', 'cb-dialog cb-dialog--lg plan-stats-card');
        // A modal over the Proposals sheet it opens from: the shell's Escape chain and shortcuts
        // recognise it by these (MapShell.isBlockingDialogOpen).
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'plan-stats-title');
        dialog.tabIndex = -1;

        const header = el('div', 'cb-dialog__header');
        const title = el('h2', 'cb-dialog__title', tPlanStats('sidebar.proposals.planStats.modalTitle', 'Plan Stats'));
        title.id = 'plan-stats-title';
        title.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.modalTitle');
        header.appendChild(title);

        const closeBtn = el('button', 'close-circle-btn', '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('data-plan-stats-close', '');
        closeBtn.setAttribute('aria-label', tPlanStats('sidebar.proposals.planStats.closeAria', 'Close plan stats'));
        closeBtn.addEventListener('click', () => hidePlanStatsModal());
        header.appendChild(closeBtn);

        const body = el('div', 'cb-dialog__body plan-stats-body');

        const scope = el('p', 'plan-stats-scope');
        scope.dataset.planStat = 'scope';

        const summaryList = el('div', 'plan-stats-grid');
        SUMMARY_ROWS.forEach(row => {
            const wrapper = el('div', 'plan-stats-figure');
            const label = el('div', 'plan-stats-figure__label', tPlanStats(row.i18nKey, row.label));
            label.setAttribute('data-i18n-key', row.i18nKey);
            const value = el('div', 'plan-stats-figure__value', '—');
            value.dataset.planStat = row.key;
            wrapper.appendChild(label);
            wrapper.appendChild(value);
            summaryList.appendChild(wrapper);
        });

        const assumptions = el('div', 'plan-stats-section');
        const assumptionsLabel = el('div', 'plan-stats-heading',
            tPlanStats('sidebar.proposals.planStats.assumptionsLabel', 'Assumptions'));
        assumptionsLabel.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.assumptionsLabel');
        assumptions.appendChild(assumptionsLabel);

        const grid = el('div', 'plan-stats-assumptions');
        const defaults = (yieldApi() || {}).DEFAULTS || {};
        ASSUMPTION_INPUTS.forEach(spec => {
            const input = el('input', 'plan-stats-input');
            input.type = 'number';
            input.id = spec.id;
            if (spec.min !== undefined) input.min = String(spec.min);
            if (spec.max !== undefined) input.max = String(spec.max);
            if (spec.step !== undefined) input.step = String(spec.step);
            input.value = String(typeof spec.value === 'function' ? spec.value(defaults) : spec.value);
            const suffix = el('label', 'plan-stats-suffix', tPlanStats(spec.i18nKey, spec.label));
            suffix.setAttribute('for', spec.id);
            suffix.setAttribute('data-i18n-key', spec.i18nKey);
            grid.appendChild(input);
            grid.appendChild(suffix);
        });
        assumptions.appendChild(grid);

        const epochSection = el('div', 'plan-stats-section');
        epochSection.hidden = true;
        epochSection.dataset.planStat = 'epoch-section';

        const epochHeader = el('div', 'plan-stats-epoch-head');
        const epochTitle = el('div', 'plan-stats-heading',
            tPlanStats('sidebar.proposals.planStats.byPeriod', 'By period'));
        epochTitle.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.byPeriod');
        epochHeader.appendChild(epochTitle);

        // Added · Standing: a segmented control; the chosen view carries aria-pressed.
        const toggle = el('div', 'cb-segmented');
        toggle.setAttribute('role', 'group');
        toggle.setAttribute('aria-label', tPlanStats('sidebar.proposals.planStats.byPeriod', 'By period'));
        [
            { mode: 'added', i18nKey: 'sidebar.proposals.planStats.viewAdded', label: 'Added' },
            { mode: 'cumulative', i18nKey: 'sidebar.proposals.planStats.viewCumulative', label: 'Standing' }
        ].forEach(option => {
            const button = el('button', 'cb-segmented__option', tPlanStats(option.i18nKey, option.label));
            button.type = 'button';
            button.setAttribute('data-i18n-key', option.i18nKey);
            button.setAttribute('aria-pressed', String(option.mode === epochView));
            button.dataset.epochView = option.mode;
            button.addEventListener('click', () => {
                epochView = option.mode;
                if (latestStats) renderEpochTable(document.getElementById('plan-stats-modal'), latestStats);
            });
            toggle.appendChild(button);
        });
        epochHeader.appendChild(toggle);
        epochSection.appendChild(epochHeader);

        const epochTable = el('div', 'plan-stats-epoch-table');
        epochTable.dataset.planStat = 'epoch-table';
        epochSection.appendChild(epochTable);

        const notes = el('div', 'plan-stats-notes');
        notes.dataset.planStat = 'notes';

        body.appendChild(scope);
        body.appendChild(summaryList);
        body.appendChild(assumptions);
        body.appendChild(epochSection);
        body.appendChild(notes);

        dialog.appendChild(header);
        dialog.appendChild(body);
        overlay.appendChild(dialog);
        overlay.addEventListener('click', event => { if (event.target === overlay) hidePlanStatsModal(); });
        document.body.appendChild(overlay);
        overlay.__unregisterEscape = window.ModalEscape?.register(overlay, hidePlanStatsModal);

        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
            try { window.i18n.applyTranslations(overlay); } catch (_) { /* ignore */ }
        }

        return overlay;
    }

    function renderEpochTable(modal, stats) {
        const section = modal.querySelector('[data-plan-stat="epoch-section"]');
        const host = modal.querySelector('[data-plan-stat="epoch-table"]');
        if (!section || !host) return;

        const result = stats.yield;
        const periods = epochView === 'cumulative' ? result.cumulative : result.byEpoch;
        if (!periods || !periods.length) {
            section.hidden = true;
            return;
        }
        section.hidden = false;

        modal.querySelectorAll('[data-epoch-view]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.epochView === epochView));
        });

        const rows = periods.slice();
        // "Added" is the only view where the undated proposals are a row of their own; in the
        // cumulative view they are already inside every year, and repeating them would double them.
        if (epochView === 'added' && result.unassigned.proposals > 0) rows.push(result.unassigned);

        const table = el('table', 'plan-stats-table');

        const head = document.createElement('tr');
        const periodTh = el('th', null, tPlanStats('sidebar.proposals.planStats.colPeriod', 'period'));
        periodTh.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.colPeriod');
        head.appendChild(periodTh);
        EPOCH_COLUMNS.forEach(column => {
            const th = el('th', 'plan-stats-table__number', tPlanStats(column.i18nKey, column.label));
            th.setAttribute('data-i18n-key', column.i18nKey);
            head.appendChild(th);
        });
        table.appendChild(head);

        rows.forEach(bucket => {
            const tr = document.createElement('tr');
            const td = el('td', null, bucket.year === null
                ? tPlanStats('sidebar.proposals.planStats.noEpoch', 'no period')
                : String(bucket.year));
            tr.appendChild(td);
            EPOCH_COLUMNS.forEach(column => {
                tr.appendChild(el('td', 'plan-stats-table__number', column.get(bucket)));
            });
            table.appendChild(tr);
        });

        host.innerHTML = '';
        host.appendChild(table);
    }

    function renderPlanStatsModal(stats) {
        const modal = ensureModal();
        if (!modal) return;
        latestStats = stats;

        const set = (key, text) => {
            const node = modal.querySelector(`[data-plan-stat="${key}"]`);
            if (node) node.textContent = text;
        };

        if (stats.unavailable) {
            set('scope', tPlanStats('sidebar.proposals.planStats.unavailable', 'Plan arithmetic is unavailable — plan-yield.js did not load.'));
            modal.hidden = false;
            return;
        }

        const total = stats.yield.total;
        const noParcels = !finiteNumber(stats.parcelCount);
        const avgParcel = !noParcels && stats.parcelMeasuredCount > 0 ? stats.parcelMeasuredArea / stats.parcelMeasuredCount : null;

        set('scope', tPlanStats(
            'sidebar.proposals.planStats.scope',
            '{{counted}} applied proposals counted of {{total}} on this map.',
            { counted: formatNumber(stats.proposalsCounted), total: formatNumber(stats.proposalsTotal) }
        ));

        if (noParcels) set('resulting-parcels', tPlanStats('groundStats.noParcels', 'No parcels here'));
        else set('resulting-parcels', avgParcel === null
            ? formatNumber(stats.parcelCount)
            : `${formatNumber(stats.parcelCount)} (${formatSquareMetres(avgParcel)})`);
        set('buildings', `${formatNumber(total.buildings)} (${formatSquareMetres(total.footprintM2)})`);
        set('floor-area', formatNumber(total.grossFloorAreaM2));
        set('open-space', formatNumber(total.openSpaceM2));
        set('apartments', formatNumber(total.apartments));
        set('people', formatNumber(total.people));
        set('jobs', formatNumber(total.jobs));

        const priceInput = modal.querySelector('#plan-stats-price');
        const price = Math.max(0, Number(priceInput && priceInput.value) || 0);
        set('sales-value', formatSalesValue(total.grossFloorAreaM2 * price));

        const notes = [];
        if (total.unmeasuredBuildings > 0) {
            notes.push(tPlanStats(
                'sidebar.proposals.planStats.noteUnmeasured',
                '{{n}} of {{total}} buildings state no height — their floor area is not counted.',
                { n: formatNumber(total.unmeasuredBuildings), total: formatNumber(total.buildings) }
            ));
        }
        const unmeasuredParcels = noParcels ? 0 : stats.parcelCount - stats.parcelMeasuredCount;
        if (unmeasuredParcels > 0) {
            notes.push(tPlanStats(
                'sidebar.proposals.planStats.noteParcelArea',
                'The average parcel size is over the {{measured}} parcels whose shape is loaded; {{missing}} are counted but not measured.',
                { measured: formatNumber(stats.parcelMeasuredCount), missing: formatNumber(unmeasuredParcels) }
            ));
        }
        if (finiteNumber(stats.openGroundM2) && stats.openGroundM2 > 0) {
            notes.push(tPlanStats(
                'groundStats.openGroundNote',
                'Open ground: {{area}} m² of the sites has no cadastral parcels; parcel figures cover the bound parcels only.',
                { area: formatNumber(stats.openGroundM2) }
            ));
        }
        set('notes', notes.join(' '));

        renderEpochTable(modal, stats);

        const wasHidden = modal.hidden;
        modal.hidden = false;
        // Focus moves into the dialog when it opens (not on every re-render while the reader
        // types), to its first control, as in every shared dialog.
        const firstControl = modal.querySelector('[data-plan-stats-close]');
        if (wasHidden && firstControl) firstControl.focus();
    }

    function hidePlanStatsModal() {
        const modal = document.getElementById('plan-stats-modal');
        if (modal) modal.hidden = true;
    }

    function setPlanStatsButtonBusy(busy) {
        const button = document.getElementById('planStatsButton');
        if (!button) return;
        const label = button.querySelector('.plan-stats-label');
        const spinner = button.querySelector('.plan-stats-spinner');
        button.disabled = !!busy;
        if (label) label.style.display = busy ? 'none' : '';
        if (spinner) spinner.style.display = busy ? 'inline-flex' : 'none';
    }

    // Changing an assumption re-derives EVERY figure, not just the one beside the input: apartments
    // feed people, and both appear per period as well as in total, so a partial update is how two
    // numbers on one screen come to disagree. Nothing is measured again — the geometry did not move
    // because the apartment size did — so this stays cheap enough to run on every keystroke.
    function handleAssumptionChange() {
        const modal = document.getElementById('plan-stats-modal');
        const api = yieldApi();
        if (!modal || !latestStats || latestStats.unavailable || !api) return;
        renderPlanStatsModal({
            ...latestStats,
            yield: api.rederive(latestStats.yield, readAssumptionsFromModal(modal))
        });
    }

    function bindAssumptionInputs(modal) {
        if (!modal) return;
        const ids = ['#plan-stats-price', ...ASSUMPTION_INPUTS.map(spec => `#${spec.id}`)];
        ids.forEach(selector => {
            const input = modal.querySelector(selector);
            if (!input || input.dataset.planStatsBound) return;
            input.dataset.planStatsBound = '1';
            input.addEventListener('input', handleAssumptionChange);
        });
    }

    async function openPlanStats() {
        setPlanStatsButtonBusy(true);
        try {
            const modal = ensureModal();
            bindAssumptionInputs(modal);
            const stats = await computePlanStatsAsync(readAssumptionsFromModal(modal));
            renderPlanStatsModal(stats);
        } catch (error) {
            console.warn('Failed to compute plan stats', error);
        } finally {
            setPlanStatsButtonBusy(false);
        }
    }

    // ?planStats=1 opens this dialog on load, so a document can CITE the figures with a
    // URL instead of telling the reader to find a button. Anything but 0/false counts as on.
    const PLAN_STATS_URL_KEYS = ['planStats', 'plan-stats'];
    const PLAN_STATS_WAIT_MS = 30000;      // how long to wait for the first applied proposal
    const PLAN_STATS_QUIET_MS = 20000;     // stop following once the plan has not moved for this long
    const PLAN_STATS_RERENDER_MS = 10000;  // floor between re-renders while the plan is still applying
    const PLAN_STATS_FOLLOW_MS = 300000;   // hard ceiling on following, whatever happens
    const PLAN_STATS_POLL_MS = 250;

    function planStatsRequestedByUrl() {
        let params;
        try {
            params = new URLSearchParams(window.location.search);
        } catch (_) {
            return false;
        }
        return PLAN_STATS_URL_KEYS.some(key => {
            const value = params.get(key);
            return value !== null && value !== '0' && value !== 'false';
        });
    }

    function planSnapshot() {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
            return { total: 0, applied: 0 };
        }
        const all = proposalStorage.getAllProposals() || [];
        return { total: all.length, applied: all.filter(p => p && p.applied === true).length };
    }

    function planStatsModalIsOpen() {
        const modal = document.getElementById('plan-stats-modal');
        return !!modal && modal.hidden === false;
    }

    // A plan does not arrive at once. The dialog counts only APPLIED proposals and computes
    // once, and on the real Šibenik plan the applied flags resolve over more than a minute
    // (measured: 138 → 149 across 35 s, long after all 299 proposals were in). Opening on the
    // first sighting therefore quotes a fraction of the plan, and opening on "nothing yet"
    // quotes a plan of zeros indistinguishable from a genuinely empty one.
    //
    // Waiting for the stream to "settle" cannot be made sound either — a quiet gap between two
    // polls looks exactly like the end of it. So: never open on nothing, then keep watching and
    // RE-RENDER whenever the plan moves under us, until it goes quiet or the reader closes the
    // dialog. The figures converge on the truth instead of freezing part-way. Re-rendering
    // preserves whatever assumptions the reader typed, because openPlanStats reads them back
    // out of the modal first.
    function openPlanStatsWhenPlanIsLoaded() {
        const waitUntil = Date.now() + PLAN_STATS_WAIT_MS;
        const followUntil = Date.now() + PLAN_STATS_FOLLOW_MS;
        let shown = null;        // what the dialog currently displays
        let previous = null;     // what the previous poll saw
        let lastChangeAt = Date.now();
        let lastRenderAt = 0;

        (function attempt() {
            const now = planSnapshot();

            // "Quiet" means the PLAN stopped moving, which is not the same as "nothing new to
            // draw". The store briefly empties and refills while proposals are applied, and
            // measuring quiet against the rendered snapshot let that lull count as the end of
            // loading: the follower gave up at 0 applied and never saw the 159 that followed.
            if (!previous || now.total !== previous.total || now.applied !== previous.applied) {
                lastChangeAt = Date.now();
            }
            previous = now;

            // Re-rendering is not free — it re-runs plan-yield and walks every resulting parcel's
            // geometry — and the plan is at its most expensive exactly while it is applying:
            // a 299-proposal plan applies one proposal at a time, ~3.6 s each, for about 18
            // minutes, on this same main thread. Following it change-for-change would put a full
            // recompute into every one of those gaps. The first render is immediate; after that
            // the figures refresh on a floor, and the final state is guaranteed by the quiet rule
            // below rather than by catching every intermediate value.
            const changed = !shown || now.total !== shown.total || now.applied !== shown.applied;
            const dueForRender = !shown || (Date.now() - lastRenderAt) >= PLAN_STATS_RERENDER_MS;
            if (now.applied > 0 && changed && dueForRender) {
                // Opened once already and the reader closed it — their call, stop following.
                if (shown && !planStatsModalIsOpen()) return;
                shown = now;
                lastRenderAt = Date.now();
                openPlanStats();
            } else if (!shown && Date.now() >= waitUntil) {
                console.warn(`[plan-stats] ?planStats: nothing applied after ${PLAN_STATS_WAIT_MS} ms `
                    + `(${now.applied} of ${now.total}) — opening with what is loaded`);
                openPlanStats();
                return;
            }

            const quiet = shown && (Date.now() - lastChangeAt) >= PLAN_STATS_QUIET_MS;
            const givingUp = quiet || Date.now() >= followUntil;
            if (givingUp) {
                // The throttle above means the LAST change is the one most likely to have been
                // skipped — and stopping here on a stale figure is precisely the quotable-but-wrong
                // number this whole path exists to avoid. Draw the final state before letting go.
                //
                // Unreachable while RERENDER_MS < QUIET_MS, because the render floor is then always
                // crossed before the quiet window expires and the normal path above has already
                // redrawn. It is the backstop for someone changing those constants: set the floor
                // above the quiet window and this becomes the only thing standing between the
                // reader and a stale number. Its test fails when both are gone.
                const stale = now.applied > 0
                    && (!shown || now.total !== shown.total || now.applied !== shown.applied);
                if (stale && planStatsModalIsOpen()) {
                    shown = now;
                    openPlanStats();
                }
                return;
            }
            setTimeout(attempt, PLAN_STATS_POLL_MS);
        })();
    }

    function initializePlanStatsUi() {
        const button = document.getElementById('planStatsButton');
        if (button && !button.dataset.planStatsBound) {
            button.dataset.planStatsBound = '1';
            button.addEventListener('click', event => {
                if (event) event.preventDefault();
                openPlanStats();
            });
        }
        if (planStatsRequestedByUrl()) openPlanStatsWhenPlanIsLoaded();
    }

    document.addEventListener('DOMContentLoaded', () => {
        initializePlanStatsUi();
    });

    window.showPlanStatsModal = openPlanStats;
})();
