// Statistics for one exact saved plan, independently of the displayed map.
(function () {
    // The sales price is in the city's currency and starts at the city's default (city-money.js).
    const salesPrice = () => window.CityMoney.currentAssumptions();

    let latestStats = null;
    let periodView = 'added';
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

    // The sales price input is per m² in the city's currency (salesSuffix), so the value is in it
    // too: amount then code.
    function formatSalesValue(value) {
        return CbFormat.formatMoney(Number(value), salesPrice().currency, { missing: '—' });
    }

    function readAssumptionsFromModal(modal, { normalizeInput = null } = {}) {
        const api = yieldApi();
        const defaults = api ? api.DEFAULTS : {};
        const read = (id, fallback, scale = 1) => {
            const input = modal ? modal.querySelector(id) : null;
            const value = Number(input && input.value);
            const minimum = input && input.min !== '' && input.min !== undefined ? Number(input.min) : 0;
            const maximum = input && input.max !== '' && input.max !== undefined ? Number(input.max) : Infinity;
            const effective = input && input.value.trim() !== '' && Number.isFinite(value) && value >= minimum
                ? Math.min(value, maximum) : fallback;
            if (input && input === normalizeInput) input.value = String(effective);
            return effective * scale;
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

    function computePlanStatsSync(snapshot, assumptions) {
        const api = yieldApi();
        const { records, materializedFeatures, cadastralFeatures, plan } = snapshot;
        const openSpaceAreaOf = proposal => {
            const pieces = materializedFeatures.filter(f => f.properties?.producedByProposalId === proposal.proposalId
                && f.properties?.structureType === proposal.structureProposal?.kind);
            return pieces.length ? pieces.reduce((sum, f) => sum + api.geometryAreaM2(f), 0) : null;
        };
        // A member's period is the year its construction window ends (built by then). The prepared
        // records carry their design CID as proposalId; members without a window are unscheduled.
        const schedule = plan.content.schedule || {};
        const periodOf = record => {
            const end = schedule[record.proposalId]?.end;
            return end ? Number(end.slice(0, 4)) : null;
        };
        const result = api.planYield(records, { ...assumptions, openSpaceAreaOf, periodOf });
        const parcels = api.resultingParcels(records, { materializedFeatures });
        const byId = new Map([...cadastralFeatures, ...materializedFeatures].map(f => [String(f.properties?.parcelId ?? f.id), f]));
        let measuredArea = 0, measuredCount = 0;
        parcels.resulting.forEach(id => {
            const feature = byId.get(id);
            const area = feature ? api.geometryAreaM2(feature) : 0;
            if (area > 0) { measuredArea += area; measuredCount += 1; }
        });
        const noParcels = parcels.bound === false;
        const ground = siteStatsApi()?.planGround(records);
        // The land the plan covers: every parcel its designs stand on, once, plus open ground.
        const parcelAreas = cadastralFeatures.map(feature => api.geometryAreaM2(feature));
        const openGround = ground && finiteNumber(ground.openGroundM2) ? ground.openGroundM2 : 0;
        const planAreaM2 = parcelAreas.every(area => finiteNumber(area)) ? parcelAreas.reduce((sum, area) => sum + area, 0) + openGround : null;
        return { unavailable: false, planTitle: plan.content.title,
            proposalsTotal: records.length, proposalsCounted: records.length, yield: result,
            parcelCount: noParcels ? null : parcels.resulting.length,
            parcelProduced: noParcels ? null : parcels.produced.length,
            parcelConsumed: noParcels ? null : parcels.consumed.length,
            parcelMeasuredCount: noParcels ? null : measuredCount,
            parcelMeasuredArea: noParcels ? null : measuredArea,
            openGroundM2: ground && finiteNumber(ground.openGroundM2) ? ground.openGroundM2 : null, planAreaM2,
            // Filled by PresentState.groundOf when it has read the roads, parks, squares and existing
            // buildings (or why not): the land split, and the existing buildings the plan leaves standing.
            publicLandM2: snapshot.land ? snapshot.land.publicLandM2 : null,
            privateLandM2: snapshot.land ? snapshot.land.privateLandM2 : null,
            remainingYield: Array.isArray(snapshot.remaining) ? api.planYield(snapshot.remaining, assumptions) : null,
            groundError: snapshot.groundError || null };
    }

    // Looks live in css/modals.css (.plan-stats-*) and css/primitives.css, never inline.
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    const SUMMARY_ROWS = [
        { key: 'plan-area', i18nKey: 'sidebar.proposals.planStats.planArea', label: 'Plan area (m²)' },
        { key: 'resulting-parcels', i18nKey: 'sidebar.proposals.planStats.resultingParcels', label: 'Resulting parcels (avg m²)' },
        { key: 'buildings', i18nKey: 'sidebar.proposals.planStats.buildings', label: 'Buildings (footprint m²)' },
        { key: 'buildings-remaining', i18nKey: 'sidebar.proposals.planStats.buildingsRemaining', label: 'of which existing that remain (floor area m²)' },
        { key: 'buildings-new', i18nKey: 'sidebar.proposals.planStats.buildingsNew', label: 'of which new (floor area m²)' },
        { key: 'floor-area', i18nKey: 'sidebar.proposals.planStats.floorArea', label: 'Gross floor area (m²)' },
        { key: 'open-space', i18nKey: 'sidebar.proposals.planStats.openSpace', label: 'Open space — parks, squares, water (m²)' },
        { key: 'public-land', i18nKey: 'sidebar.proposals.planStats.publicLand', label: 'Public land — roads, parks, squares (m²)' },
        { key: 'private-land', i18nKey: 'sidebar.proposals.planStats.privateLand', label: 'Private land (m²)' },
        { key: 'apartments', i18nKey: 'sidebar.proposals.planStats.apartments', label: 'Apartments' },
        { key: 'people', i18nKey: 'sidebar.proposals.planStats.people', label: 'People' },
        { key: 'jobs', i18nKey: 'sidebar.proposals.planStats.jobs', label: 'Jobs' },
        { key: 'sales-value', i18nKey: 'sidebar.proposals.planStats.salesValue', label: 'Sales value of the floor area' }
    ];

    const ASSUMPTION_INPUTS = [
        { id: 'plan-stats-price', i18nKey: 'sidebar.proposals.planStats.salesSuffix', label: '{{currency}} per m²', min: 0, step: 100, value: () => salesPrice().salesPerSqm, params: () => ({ currency: salesPrice().currency }) },
        { id: 'plan-stats-housing-share', i18nKey: 'sidebar.proposals.planStats.housingShareSuffix', label: '% housing share', min: 0, max: 100, step: 5, value: d => Math.round((d.housingShare ?? 0.75) * 100) },
        { id: 'plan-stats-efficiency', i18nKey: 'sidebar.proposals.planStats.efficiencySuffix', label: '% net of gross', min: 1, max: 100, step: 5, value: d => Math.round((d.efficiency ?? 0.8) * 100) },
        { id: 'plan-stats-apartment-size', i18nKey: 'sidebar.proposals.planStats.apartmentSizeSuffix', label: 'm² per apartment', min: 1, step: 5, value: d => d.avgApartmentM2 ?? 65 },
        { id: 'plan-stats-persons', i18nKey: 'sidebar.proposals.planStats.personsSuffix', label: 'people per apartment', min: 0.1, step: 0.1, value: d => d.personsPerApartment ?? 2.4 }
    ];

    const PERIOD_COLUMNS = [
        { i18nKey: 'sidebar.proposals.planStats.colProposals', label: 'designs', get: b => formatNumber(b.proposals) },
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
        const title = el('h2', 'cb-dialog__title', tPlanStats('sidebar.proposals.planStats.modalTitle', 'Plan stats'));
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
            const params = typeof spec.params === 'function' ? spec.params() : {};
            const suffix = el('label', 'plan-stats-suffix', tPlanStats(spec.i18nKey, spec.label, params));
            suffix.setAttribute('for', spec.id);
            suffix.setAttribute('data-i18n-key', spec.i18nKey);
            suffix.setAttribute('data-i18n-params', JSON.stringify(params));
            grid.appendChild(input);
            grid.appendChild(suffix);
        });
        assumptions.appendChild(grid);

        const periodSection = el('div', 'plan-stats-section');
        periodSection.hidden = true;
        periodSection.dataset.planStat = 'period-section';

        const periodHeader = el('div', 'plan-stats-period-head');
        const periodTitle = el('div', 'plan-stats-heading',
            tPlanStats('sidebar.proposals.planStats.byPeriod', 'By period'));
        periodTitle.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.byPeriod');
        periodHeader.appendChild(periodTitle);

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
            button.setAttribute('aria-pressed', String(option.mode === periodView));
            button.dataset.periodView = option.mode;
            button.addEventListener('click', () => {
                periodView = option.mode;
                if (latestStats) renderPeriodTable(document.getElementById('plan-stats-modal'), latestStats);
            });
            toggle.appendChild(button);
        });
        periodHeader.appendChild(toggle);
        periodSection.appendChild(periodHeader);

        const periodTable = el('div', 'plan-stats-period-table');
        periodTable.dataset.planStat = 'period-table';
        periodSection.appendChild(periodTable);

        const notes = el('div', 'plan-stats-notes');
        notes.dataset.planStat = 'notes';

        body.appendChild(scope);
        body.appendChild(summaryList);
        body.appendChild(assumptions);
        body.appendChild(periodSection);
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

    // Periods are the years the plan's construction windows end in (computePlanStatsSync).
    function renderPeriodTable(modal, stats) {
        const section = modal.querySelector('[data-plan-stat="period-section"]');
        const host = modal.querySelector('[data-plan-stat="period-table"]');
        if (!section || !host) return;

        const result = stats.yield;
        const periods = periodView === 'cumulative' ? result.cumulative : result.byPeriod;
        if (!periods || !periods.length) {
            section.hidden = true;
            return;
        }
        section.hidden = false;

        modal.querySelectorAll('[data-period-view]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.periodView === periodView));
        });

        const rows = periods.slice();
        // "Added" is the only view where the unscheduled designs are a row of their own; in the
        // cumulative view they are already inside every year, and repeating them would double them.
        if (periodView === 'added' && result.unassigned.proposals > 0) rows.push(result.unassigned);

        const table = el('table', 'plan-stats-table');

        const head = document.createElement('tr');
        const periodTh = el('th', null, tPlanStats('sidebar.proposals.planStats.colPeriod', 'period'));
        periodTh.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.colPeriod');
        head.appendChild(periodTh);
        PERIOD_COLUMNS.forEach(column => {
            const th = el('th', 'plan-stats-table__number', tPlanStats(column.i18nKey, column.label));
            th.setAttribute('data-i18n-key', column.i18nKey);
            head.appendChild(th);
        });
        table.appendChild(head);

        rows.forEach(bucket => {
            const tr = document.createElement('tr');
            const td = el('td', null, bucket.year === null
                ? tPlanStats('sidebar.proposals.planStats.noPeriod', 'no period')
                : String(bucket.year));
            tr.appendChild(td);
            PERIOD_COLUMNS.forEach(column => {
                tr.appendChild(el('td', 'plan-stats-table__number', column.get(bucket)));
            });
            table.appendChild(tr);
        });

        host.innerHTML = '';
        host.appendChild(table);
    }

    // Everything standing after the plan: its new buildings and the existing ones it leaves, with
    // apartments, people and jobs derived once from their summed floor area (plan-yield).
    function standingTotal(stats) {
        return stats.remainingYield
            ? yieldApi().combinedTotal([stats.yield.total, stats.remainingYield.total], stats.yield.assumptions)
            : stats.yield.total;
    }

    // The summary figures of one plan's stats as text, by SUMMARY_ROWS key: the dialog and the plan
    // comparison show the same words. price: sales price per m² in the city's currency.
    function summaryTexts(stats, price) {
        // A figure that was not measured reads "—", never a 0 (formatNumber(null) would print 0).
        const measured = value => (finiteNumber(value) ? formatNumber(value) : '—');
        const total = standingTotal(stats);
        const built = (count, floorArea) => `${formatNumber(count)} (${formatSquareMetres(floorArea)})`;
        const remaining = stats.remainingYield ? stats.remainingYield.total : null;
        const noParcels = !finiteNumber(stats.parcelCount);
        const avgParcel = !noParcels && stats.parcelMeasuredCount > 0 ? stats.parcelMeasuredArea / stats.parcelMeasuredCount : null;
        return {
            'plan-area': measured(stats.planAreaM2),
            'resulting-parcels': noParcels ? tPlanStats('groundStats.noParcels', 'No parcels here')
                : avgParcel === null ? formatNumber(stats.parcelCount) : `${formatNumber(stats.parcelCount)} (${formatSquareMetres(avgParcel)})`,
            buildings: `${formatNumber(total.buildings)} (${formatSquareMetres(total.footprintM2)})`,
            'buildings-remaining': remaining ? built(remaining.buildings, remaining.grossFloorAreaM2) : '—',
            'buildings-new': built(stats.yield.total.buildings, stats.yield.total.grossFloorAreaM2),
            'floor-area': formatNumber(total.grossFloorAreaM2),
            'open-space': formatNumber(total.openSpaceM2),
            'public-land': measured(stats.publicLandM2),
            'private-land': measured(stats.privateLandM2),
            apartments: formatNumber(total.apartments),
            people: formatNumber(total.people),
            jobs: formatNumber(total.jobs),
            'sales-value': formatSalesValue(total.grossFloorAreaM2 * price)
        };
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
            set('scope', tPlanStats('sidebar.proposals.planStats.unavailable', 'Statistics are unavailable. Reload and try again.'));
            modal.hidden = false;
            return;
        }

        const total = standingTotal(stats);
        const noParcels = !finiteNumber(stats.parcelCount);
        const priceInput = modal.querySelector('#plan-stats-price');
        const price = Math.max(0, Number(priceInput && priceInput.value) || 0);
        const figures = summaryTexts(stats, price);

        set('scope', tPlanStats(
            'sidebar.proposals.planStats.scope',
            '{{title}} · Designs: {{counted}}',
            { title: stats.planTitle, counted: formatNumber(stats.proposalsCounted) }
        ));

        set('plan-area', figures['plan-area']);
        set('resulting-parcels', figures['resulting-parcels']);
        set('buildings', figures.buildings);
        set('buildings-remaining', figures['buildings-remaining']);
        set('buildings-new', figures['buildings-new']);
        set('floor-area', figures['floor-area']);
        set('open-space', figures['open-space']);
        set('public-land', figures['public-land']);
        set('private-land', figures['private-land']);
        set('apartments', figures.apartments);
        set('people', figures.people);
        set('jobs', figures.jobs);
        set('sales-value', figures['sales-value']);

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
        if (stats.groundError) {
            notes.push(tPlanStats('sidebar.proposals.planStats.groundFailed', 'Existing buildings and public land could not be read: {{reason}}', { reason: stats.groundError }));
        }
        set('notes', notes.join(' '));

        renderPeriodTable(modal, stats);

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

    // Changing an assumption re-derives EVERY figure, not just the one beside the input: apartments
    // feed people, and both appear per period as well as in total, so a partial update is how two
    // numbers on one screen come to disagree. Nothing is measured again — the geometry did not move
    // because the apartment size did — so this stays cheap enough to run on every keystroke.
    function handleAssumptionChange() {
        const modal = document.getElementById('plan-stats-modal');
        const api = yieldApi();
        if (!modal || !latestStats || latestStats.unavailable || !api) return;
        const assumptions = readAssumptionsFromModal(modal);
        renderPlanStatsModal({
            ...latestStats,
            yield: api.rederive(latestStats.yield, assumptions),
            remainingYield: latestStats.remainingYield ? api.rederive(latestStats.remainingYield, assumptions) : null
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
            input.addEventListener('change', () => {
                if (input.id === 'plan-stats-price') input.value = String(Math.max(0, Number(input.value) || 0));
                else readAssumptionsFromModal(modal, { normalizeInput: input });
                handleAssumptionChange();
            });
        });
    }

    // The plan's ground read with its roads, parks, squares and existing buildings:
    // { land, remaining } or { groundError }.
    async function withGround(snapshot, assumptions) {
        try { return { ...snapshot, ...(await window.PresentState.groundOf(snapshot, assumptions)) }; }
        catch (error) {
            console.error(`[${new Date().toISOString()}] [PlanStats] the land of ${snapshot.plan?.content?.title || 'a plan'} could not be split`, error);
            return { ...snapshot, groundError: error && error.message ? error.message : String(error) };
        }
    }

    let openedPlan = 0;
    async function openPlanStats(plan) {
        const snapshot = await window.PlanAnalysis.prepare(plan);
        const modal = ensureModal();
        bindAssumptionInputs(modal);
        const token = ++openedPlan;
        renderPlanStatsModal(computePlanStatsSync(snapshot, readAssumptionsFromModal(modal)));
        // Public and private land needs OpenStreetMap's parks and squares, which can take a while:
        // the other figures show first, these follow while the dialog still shows this plan.
        const land = await withGround(snapshot, readAssumptionsFromModal(modal));
        if (token === openedPlan && !modal.hidden) renderPlanStatsModal(computePlanStatsSync(land, readAssumptionsFromModal(modal)));
    }

    // ── Plan comparison (Lists → Plans → Compare plans) ─────────────────────────────────────────
    // Each chosen plan is measured as Plan stats measures one, without applying it, at the default
    // assumptions, and shown in one table. Swap turns it between plans as columns and plans as rows.
    // A plan that cannot be measured keeps its place and says why.
    let comparePlansAsColumns = true;

    // entries: [{ title, figures (summaryTexts) } | { title, error }] → the table element.
    function compareTable(entries, plansAsColumns) {
        const table = el('table', 'plan-stats-table plan-compare__table');
        table.dataset.planCompare = plansAsColumns ? 'plans-as-columns' : 'plans-as-rows';
        const metrics = SUMMARY_ROWS.map(row => ({ key: row.key, label: tPlanStats(row.i18nKey, row.label) }));
        const planHeader = (entry, scope) => {
            const th = el('th', 'plan-compare__plan', entry.title);
            th.setAttribute('scope', scope);
            if (entry.present) th.className += ' plan-compare__plan--present';
            if (entry.measuring) th.appendChild(el('span', 'plan-compare__status', tPlanStats('planCompare.measuring', 'Measuring…')));
            if (entry.error) th.appendChild(el('span', 'plan-compare__error',
                tPlanStats('planCompare.failed', 'Not measured: {{reason}}', { reason: entry.error })));
            else if (entry.groundError) th.appendChild(el('span', 'plan-compare__error',
                tPlanStats('sidebar.proposals.planStats.groundFailed', 'Existing buildings and public land could not be read: {{reason}}', { reason: entry.groundError })));
            return th;
        };
        const value = (entry, key) => el('td', 'plan-stats-table__number', entry.figures ? entry.figures[key] : '—');
        const head = document.createElement('tr');
        head.appendChild(el('th', null, plansAsColumns ? '' : tPlanStats('plan.label', 'Plan')));
        if (plansAsColumns) entries.forEach(entry => head.appendChild(planHeader(entry, 'col')));
        else metrics.forEach(metric => { const th = el('th', 'plan-stats-table__number', metric.label); th.setAttribute('scope', 'col'); head.appendChild(th); });
        table.appendChild(head);
        if (plansAsColumns) {
            metrics.forEach(metric => {
                const tr = document.createElement('tr');
                const th = el('th', null, metric.label); th.setAttribute('scope', 'row'); th.dataset.planCompareRow = metric.key; tr.appendChild(th);
                entries.forEach(entry => tr.appendChild(value(entry, metric.key)));
                table.appendChild(tr);
            });
        } else {
            entries.forEach(entry => {
                const tr = document.createElement('tr');
                tr.appendChild(planHeader(entry, 'row'));
                metrics.forEach(metric => tr.appendChild(value(entry, metric.key)));
                table.appendChild(tr);
            });
        }
        return table;
    }

    async function comparePlans(plans) {
        const assumptions = readAssumptionsFromModal(null);
        const price = salesPrice().salesPerSqm;
        const entries = [];
        const prepared = [];
        for (const plan of plans) {
            const title = plan?.content?.title || '';
            try {
                const snapshot = await withGround(await window.PlanAnalysis.prepare(plan), assumptions);
                const stats = computePlanStatsSync(snapshot, assumptions);
                prepared.push({ title: stats.planTitle || title, cid: plan?.cid || null, snapshot });
                entries.push({ title: stats.planTitle || title, figures: summaryTexts(stats, price), groundError: stats.groundError });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [PlanCompare] ${title || plan?.cid} could not be measured`, error);
                entries.push({ title, error: error && error.message ? error.message : String(error) });
            }
        }
        // The present state: what stands on a chosen plan's land today, as a column of its own.
        const present = { title: tPlanStats('planCompare.presentState', 'Present state'), present: true, measuring: false };
        const city = window.normalizeCityCodeForApi(window.resolveCurrentCityCode());
        const compared = new Set(prepared.map(row => row.cid));
        const saved = new Map(window.NamedPlans.list({ storedOnly: true })
            .filter(row => !compared.has(row.cid) && (!row.content.view.city || window.normalizeCityCodeForApi(row.content.view.city) === city))
            .map(row => [`saved:${row.cid}`, row]));

        const body = el('div', 'plan-compare');
        const basisField = el('label', 'proposal-editor-field plan-compare__basis');
        basisField.appendChild(el('span', null, tPlanStats('planCompare.basis', 'Present state over the land of')));
        const basis = el('select');
        basis.dataset.planCompareBasis = '';
        const option = (value, text) => { const node = el('option', null, text); node.value = value; basis.appendChild(node); };
        if (prepared.length > 1) option('compared', tPlanStats('planCompare.basisCompared', 'All compared plans'));
        prepared.forEach((row, index) => option(`plan:${index}`, row.title));
        saved.forEach((row, value) => option(value, row.content.title));
        basisField.appendChild(basis);
        const swap = el('button', 'btn btn-sm plan-compare__swap', tPlanStats('planCompare.swap', 'Swap rows and columns'));
        swap.type = 'button';
        swap.dataset.planCompareSwap = '';
        // The same plans under the map's divider (three-compare.js, no apply): the first two chosen
        // plans side by side, or one plan beside Built today.
        const measured = prepared.filter(row => row.cid);
        const sideBySide = el('button', 'btn btn-sm plan-compare__side-by-side', tPlanStats('planCompare.sideBySide', 'Side by side on the map'));
        sideBySide.type = 'button';
        sideBySide.dataset.planCompareSideBySide = '';
        sideBySide.disabled = !measured.length || !window.ThreeCompare?.show;
        sideBySide.addEventListener('click', () => {
            const [first, second] = measured;
            dialog?.close?.();
            window.ThreeCompare.show({ left: second ? `plan:${first.cid}` : 'built', right: `plan:${(second || first).cid}` });
        });
        const scroll = el('div', 'plan-compare__scroll');
        const draw = () => {
            scroll.innerHTML = '';
            scroll.appendChild(compareTable([present, ...entries], comparePlansAsColumns));
            swap.setAttribute('aria-pressed', String(!comparePlansAsColumns));
        };
        let measuring = 0;
        async function measurePresent(value) {
            const token = ++measuring;
            Object.assign(present, { measuring: true, error: null, figures: null });
            draw();
            try {
                const basisPlans = value === 'compared' ? prepared.map(row => row.snapshot)
                    : value.startsWith('plan:') ? [prepared[Number(value.slice(5))].snapshot]
                    : [await window.PlanAnalysis.prepare(saved.get(value))];
                const stats = await window.PresentState.measure({ title: present.title, basis: basisPlans, assumptions });
                if (token !== measuring) return;
                present.figures = summaryTexts(stats, price);
            } catch (error) {
                if (token !== measuring) return;
                console.error(`[${new Date().toISOString()}] [PlanCompare] the present state could not be measured`, error);
                present.error = error && error.message ? error.message : String(error);
            }
            present.measuring = false;
            draw();
        }
        basis.addEventListener('change', () => { void measurePresent(basis.value); });
        swap.addEventListener('click', () => { comparePlansAsColumns = !comparePlansAsColumns; draw(); });
        const note = el('p', 'sheet-note', tPlanStats('planCompare.assumptions',
            'At the default assumptions and {{price}} per m². Plan stats on one plan lets you change them.',
            { price: formatSalesValue(price) }));
        const definition = el('p', 'sheet-note', tPlanStats('planCompare.landDefinition',
            'Public land is roads and OpenStreetMap parks and squares; private land is the rest of the parcels. The present state counts every existing building on that land.'));
        body.appendChild(basisField);
        body.appendChild(swap);
        body.appendChild(sideBySide);
        body.appendChild(scroll);
        body.appendChild(note);
        body.appendChild(definition);
        draw();
        const dialog = window.CbDialog.open({ title: tPlanStats('planCompare.title', 'Compare plans'), size: 'lg', className: 'plan-compare-dialog', body });
        if (basis.children.length) {
            basis.value = basis.children[0].value;
            void measurePresent(basis.value);
        } else present.error = tPlanStats('planCompare.noBasis', 'No saved plan to take the land from.');
        draw();
        return dialog;
    }

    window.showPlanStatsModal = openPlanStats;
    window.comparePlanStats = comparePlans;
})();
