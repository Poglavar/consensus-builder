// Statistics for one exact saved plan, independently of the displayed map.
(function () {
    // The sales price is in the city's currency and starts at the city's default (city-money.js), for
    // the place the plan's land is: planLocation, [lng, lat] (EconomicSources.locationOf of that land),
    // null until a plan is measured. Rates published per area (an English authority's land value, a
    // London value band) are that place's.
    let planLocation = null;
    const salesPrice = (at = planLocation) => window.CityMoney.currentAssumptions(at);

    let latestStats = null;
    let planStatsTrigger = null;
    let periodView = 'added';
    function yieldApi() {
        return (typeof window !== 'undefined' && window.__planYield) ? window.__planYield : null;
    }

    // Site/binding figures (proposals/site-stats.js). Optional: without it the dialog still counts
    // parcels, it just cannot say how much of the plan stands on open ground.
    function siteStatsApi() {
        return (typeof window !== 'undefined' && window.__siteStats) ? window.__siteStats : null;
    }

    // A resulting parcel smaller than this on the plan's land is a sliver along its edge, not a parcel.
    const MIN_RESULTING_PARCEL_M2 = 1;

    // The area of a feature on the plan's land (the shared clip, parcel-arrangement.js clipWith).
    function landAreaOf(feature, land) {
        if (!land) return 0;
        const piece = window.__parcelArrangement.clipWith(window.turf, 'intersect', feature, land, { site: 'plan-stats' });
        return piece ? yieldApi().geometryAreaM2(piece) : 0;
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

    // The price inputs are per m² in the city's currency (salesSuffix, constructionSuffix), so the
    // amounts are in it too: amount then code. An amount not known reads "—", never 0.
    function formatSalesValue(value) {
        return finiteNumber(value) ? CbFormat.formatMoney(value, salesPrice().currency, { missing: '—', maxFractionDigits: 0 }) : '—';
    }

    // The floor area of the existing buildings a plan clears, by the same plan-yield rules as the
    // floor area it adds: each cleared building's floor area as it stands, less what is left of it
    // (PresentState.groundOf cleared). { floorAreaM2, unmeasured }: floorAreaM2 is null until the
    // ground is read, and when a cleared building states no height (unmeasured counts those).
    function clearedFloorArea(cleared, assumptions) {
        if (!Array.isArray(cleared)) return { floorAreaM2: null, unmeasured: 0 };
        const api = yieldApi();
        let floorAreaM2 = 0, unmeasured = 0;
        cleared.forEach(({ before, after }) => {
            const was = api.planYield([before], assumptions).total;
            if (was.unmeasuredBuildings > 0) { unmeasured += 1; return; }
            floorAreaM2 += was.grossFloorAreaM2 - (after ? api.planYield([after], assumptions).total.grossFloorAreaM2 : 0);
        });
        return { floorAreaM2: unmeasured ? null : floorAreaM2, unmeasured };
    }

    // The assumption inputs of Plan stats (ids plan-stats-*) or Compare plans (prefix plan-compare).
    function readAssumptionsFromModal(modal, { normalizeInput = null, prefix = 'plan-stats' } = {}) {
        const api = yieldApi();
        const defaults = api ? api.DEFAULTS : {};
        const read = (id, fallback, scale = 1) => {
            const input = modal ? modal.querySelector(id.replace('#plan-stats-', `#${prefix}-`)) : null;
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

    // These measurements depend only on the replayed ground and the chosen scope. Keep them
    // through the land and apartment updates and through changes to financial assumptions.
    const geometryByRecords = new WeakMap();
    async function measureGeometry(snapshot, signal) {
        signal.throwIfAborted();
        const { records, materializedFeatures, cadastralFeatures, landFeature } = snapshot;
        const previous = geometryByRecords.get(records);
        if (previous && previous.materializedFeatures === materializedFeatures
            && previous.cadastralFeatures === cadastralFeatures && previous.landFeature === landFeature) {
            return { ...snapshot, ...previous.measurements };
        }
        const api = yieldApi();
        const areas = new Map();
        for (const feature of materializedFeatures) {
            const { producedByProposalId: id, structureType: kind } = feature.properties || {};
            if (!id || !kind) continue;
            if (!areas.has(id)) areas.set(id, new Map());
            const kinds = areas.get(id);
            kinds.set(kind, (kinds.get(kind) || 0) + api.geometryAreaM2(feature));
        }
        const parcels = api.resultingParcels(records, { materializedFeatures });
        const byId = new Map([...cadastralFeatures, ...materializedFeatures].map(f => [String(f.properties?.parcelId ?? f.id), f]));
        // The resulting parcels on the plan's land, each measured by its part there: the rest of a
        // large parcel a design cut is the owner's land the plan does not touch, and is not one of
        // them. A resulting parcel this browser holds no shape for counts, unmeasured.
        let measuredArea = 0, measuredCount = 0, resultingCount = 0;
        let slice = Date.now();
        for (const id of parcels.resulting) {
            signal.throwIfAborted();
            if (window.requestAnimationFrame && Date.now() - slice >= 8) {
                await new Promise(resolve => setTimeout(resolve, 0));
                signal.throwIfAborted();
                slice = Date.now();
            }
            const feature = byId.get(id);
            if (!feature) { resultingCount += 1; continue; }
            const area = landAreaOf(feature, landFeature);
            if (area < MIN_RESULTING_PARCEL_M2) continue;
            resultingCount += 1;
            measuredArea += area;
            measuredCount += 1;
        }
        const noParcels = parcels.bound === false;
        const ground = siteStatsApi()?.planGround(records);
        // The land the plan covers: the ground its designs take (PlanAnalysis.prepare landFeature),
        // open ground included, never the untouched rest of the parcels they stand on.
        const landM2 = landFeature ? api.geometryAreaM2(landFeature) : null;
        const planAreaM2 = finiteNumber(landM2) ? landM2 : null;
        const parcelFigures = {
            parcelCount: noParcels ? null : resultingCount,
            parcelProduced: noParcels ? null : parcels.produced.length,
            parcelConsumed: noParcels ? null : parcels.consumed.length,
            parcelMeasuredCount: noParcels ? null : measuredCount,
            parcelMeasuredArea: noParcels ? null : measuredArea,
            openGroundM2: ground && finiteNumber(ground.openGroundM2) ? ground.openGroundM2 : null, planAreaM2
        };
        const measurements = { parcelFigures, openSpaceAreaOf: proposal =>
            areas.get(proposal.proposalId)?.get(proposal.structureProposal?.kind) ?? null };
        geometryByRecords.set(records, { materializedFeatures, cadastralFeatures, landFeature, measurements });
        return { ...snapshot, ...measurements };
    }

    function computePlanStatsSync(snapshot, assumptions) {
        const api = yieldApi();
        const { records, plan, openSpaceAreaOf } = snapshot;
        // A member's period is the year its construction window ends (built by then). The prepared
        // records carry their design CID as proposalId; members without a window are unscheduled.
        const schedule = plan.content.schedule || {};
        const periodOf = record => {
            const end = schedule[record.proposalId]?.end;
            return end ? Number(end.slice(0, 4)) : null;
        };
        // Apartments counted from each building's generated layout once plan-units.js has laid them
        // out (snapshot.units); until then, and for a building it cannot lay out, the per-m² rule.
        const units = snapshot.units || null;
        const result = api.planYield(records, { ...assumptions, openSpaceAreaOf, periodOf, unitsOf: units?.designs?.unitsOf });
        return { unavailable: false, planTitle: plan.content.title,
            proposalsTotal: records.length, proposalsCounted: records.length, yield: result,
            ...snapshot.parcelFigures,
            // Filled by PresentState.groundOf when it has read the roads, parks, squares and existing
            // buildings (or why not): the land split, and the existing buildings the plan leaves standing.
            publicLandM2: snapshot.land ? snapshot.land.publicLandM2 : null,
            privateLandM2: snapshot.land ? snapshot.land.privateLandM2 : null,
            remainingYield: Array.isArray(snapshot.remaining) ? api.planYield(snapshot.remaining, { ...assumptions, unitsOf: units?.standing?.unitsOf }) : null,
            unitsCounting: snapshot.unitsCounting === true, unitsError: units?.error || null,
            groundError: snapshot.groundError || null,
            // The existing floor area the plan clears, for the profit on what it builds.
            cleared: clearedFloorArea(snapshot.cleared, assumptions) };
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
        { key: 'sales-value', i18nKey: 'sidebar.proposals.planStats.salesValue', label: 'Sales value of the floor area' },
        { key: 'total-cost', i18nKey: 'sidebar.proposals.planStats.allInCost', label: 'All-in cost of the new floor area' },
        { key: 'profit', i18nKey: 'sidebar.proposals.planStats.profit', label: 'Profit on the new floor area' },
        { key: 'annual-rent', i18nKey: 'sidebar.proposals.planStats.annualRent', label: 'Annual rent of the new floor area' },
        { key: 'rent-yield', i18nKey: 'sidebar.proposals.planStats.rentYield', label: 'Rent yield on cost (annual rent ÷ construction, land and cleared value)' }
    ];

    // The parts of the all-in cost (CityMoney.newBuildMoney), listed under Cost details.
    const COST_PARTS = [
        { key: 'cost-construction', i18nKey: 'sidebar.proposals.planStats.costConstruction', label: 'Construction' },
        { key: 'cost-land', i18nKey: 'sidebar.proposals.planStats.costLand', label: 'Land (the plan\'s land × the land price)' },
        { key: 'cost-tax', i18nKey: 'sidebar.proposals.planStats.costTax', label: 'Sale tax inside the sales value of the new floor area' },
        // Listed only where the construction cost includes the tax on its inputs (the rate's taxIncluded).
        { key: 'cost-reclaimed', i18nKey: 'sidebar.proposals.planStats.costReclaimed', label: 'Less the tax reclaimed on construction', taxIncludedOnly: true },
        { key: 'cost-replaced', i18nKey: 'sidebar.proposals.planStats.costReplaced', label: 'Existing buildings cleared, at the sale price' }
    ];

    const ASSUMPTION_INPUTS = [
        // The prices, each with a slider over the city's range (CityMoney.currentFloorAreaPrices, slider)
        // as well as the exact number; the sale tax is typed as a percentage of the sale price.
        { id: 'plan-stats-price', slider: 'sale', i18nKey: 'sidebar.proposals.planStats.salesSuffix', label: '{{currency}} per m² sale price', min: 0, step: 100, value: (d, price = salesPrice()) => price.salesPerSqm, params: () => ({ currency: salesPrice().currency }) },
        { id: 'plan-stats-construction', slider: 'construction', i18nKey: 'sidebar.proposals.planStats.constructionSuffix', label: '{{currency}} per m² construction cost', min: 0, step: 100, value: (d, price = salesPrice()) => price.constructionPerSqm, params: () => ({ currency: salesPrice().currency }) },
        { id: 'plan-stats-land', slider: 'land', i18nKey: 'sidebar.proposals.planStats.landSuffix', label: '{{currency}} per m² of land', min: 0, step: 10, value: (d, price = salesPrice()) => price.landPerSqm, params: () => ({ currency: salesPrice().currency }) },
        { id: 'plan-stats-sale-tax', slider: 'saleTax', percent: true, i18nKey: 'sidebar.proposals.planStats.saleTaxSuffix', label: '% sale tax in the price', min: 0, max: 99, step: 0.5, value: (d, price = salesPrice()) => (finiteNumber(price.saleTaxShare) ? Math.round(price.saleTaxShare * 1000) / 10 : null) },
        { id: 'plan-stats-rent', slider: 'rent', i18nKey: 'sidebar.proposals.planStats.rentSuffix', label: '{{currency}} per m² rent a month', min: 0, step: 1, value: (d, price = salesPrice()) => price.rentPerSqmMonth, params: () => ({ currency: salesPrice().currency }) },
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

    // What the reader typed into either dialog's assumptions, by input key (price, housing-share, ...):
    // Plan stats and Compare plans start from it and write to it, so one change holds in both.
    const typedAssumptions = {};
    const inputKey = spec => spec.id.replace(/^plan-stats-/, '');
    // The assumption inputs and their labels for one dialog; ids are `${prefix}-${key}`. The prices
    // come first, each a label, a slider and the exact number, kept in step; moving a slider calls
    // onSlide with its number input. A price without a starting value (no land price) is empty until set.
    // The prices the reader set (by input key), which a plan's place does not reset.
    const typedPrices = new Set();
    function assumptionGrid(prefix, onSlide = () => {}) {
        const groups = el('div', 'plan-stats-assumption-groups');
        const prices = el('div', 'plan-stats-prices');
        const grid = el('div', 'plan-stats-assumptions');
        const defaults = (yieldApi() || {}).DEFAULTS || {};
        const ranges = window.CityMoney && typeof window.CityMoney.currentFloorAreaPrices === 'function'
            ? window.CityMoney.currentFloorAreaPrices() : null;
        ASSUMPTION_INPUTS.forEach(spec => {
            const input = el('input', 'plan-stats-input');
            input.type = 'number';
            input.id = `${prefix}-${inputKey(spec)}`;
            input.dataset.assumption = inputKey(spec);
            if (spec.min !== undefined) input.min = String(spec.min);
            if (spec.max !== undefined) input.max = String(spec.max);
            if (spec.step !== undefined) input.step = String(spec.step);
            const start = typeof spec.value === 'function' ? spec.value(defaults) : spec.value;
            input.value = typedAssumptions[inputKey(spec)] ?? (start === null || start === undefined ? '' : String(start));
            const params = typeof spec.params === 'function' ? spec.params() : {};
            const labelText = tPlanStats(spec.i18nKey, spec.label, params);
            const suffix = el('label', 'plan-stats-suffix', labelText);
            suffix.setAttribute('for', input.id);
            suffix.setAttribute('data-i18n-key', spec.i18nKey);
            suffix.setAttribute('data-i18n-params', JSON.stringify(params));
            const range = spec.slider && ranges ? ranges[spec.slider] : null;
            if (!range) {
                grid.appendChild(input);
                grid.appendChild(suffix);
                return;
            }
            const scale = spec.percent ? 100 : 1;
            const slider = el('input', 'plan-stats-slider');
            slider.type = 'range';
            slider.id = `${input.id}-slider`;
            slider.dataset.priceSlider = inputKey(spec);
            slider.min = String(range.min * scale);
            slider.max = String(range.max * scale);
            slider.step = range.step === 'any' ? 'any' : String(range.step * scale);
            slider.value = input.value === '' ? slider.min : input.value;
            slider.setAttribute('aria-label', labelText);
            slider.addEventListener('input', () => { typedPrices.add(inputKey(spec)); input.value = slider.value; onSlide(input); });
            input.addEventListener('input', () => { typedPrices.add(inputKey(spec)); if (input.value.trim() !== '') slider.value = input.value; });
            prices.appendChild(suffix);
            prices.appendChild(slider);
            prices.appendChild(input);
        });
        groups.appendChild(prices);
        groups.appendChild(grid);
        return groups;
    }
    function rememberAssumptions(container) {
        container.querySelectorAll('[data-assumption]').forEach(input => {
            const key = input.dataset.assumption;
            if (!PRICE_KEYS.has(key) || typedPrices.has(key)) typedAssumptions[key] = input.value;
        });
    }
    // The prices the reader has not set, and their sliders' ranges, at the rates of the place `at`.
    function placePrices(container, prefix, at) {
        const ranges = window.CityMoney.currentFloorAreaPrices(at);
        const price = salesPrice(at);
        ASSUMPTION_INPUTS.forEach(spec => {
            const key = inputKey(spec);
            const input = container.querySelector(`#${prefix}-${key}`);
            const slider = container.querySelector(`#${prefix}-${key}-slider`);
            if (!spec.slider || !input || typedPrices.has(key)) return;
            const start = spec.value({}, price);
            input.value = start === null || start === undefined ? '' : String(start);
            if (!slider) return;
            const scale = spec.percent ? 100 : 1, range = ranges[spec.slider];
            slider.min = String(range.min * scale);
            slider.max = String(range.max * scale);
            slider.step = range.step === 'any' ? 'any' : String(range.step * scale);
            slider.value = input.value === '' ? slider.min : input.value;
        });
    }
    function restoreAssumptions(container) {
        container.querySelectorAll('[data-assumption]').forEach(input => {
            if (typedAssumptions[input.dataset.assumption] !== undefined) input.value = typedAssumptions[input.dataset.assumption];
        });
    }
    // The sale, construction and monthly rent prices per m² typed into a dialog, { sale, construction,
    // rent }, never below zero; an empty input is no price (null), so what depends on it reads "—"
    // rather than 0.
    function priceIn(container, prefix) {
        const read = key => {
            const input = container.querySelector(`#${prefix}-${key}`);
            const text = input && typeof input.value === 'string' ? input.value.trim() : '';
            return text === '' ? null : Math.max(0, Number(text) || 0);
        };
        const tax = read('sale-tax');
        return { sale: read('price'), construction: read('construction'), land: read('land'),
            saleTax: tax === null ? null : tax / 100, rent: read('rent') };
    }
    // The price inputs, by input key; leaving one keeps it at zero or above, and an empty one empty.
    const PRICE_KEYS = new Set(['price', 'construction', 'land', 'sale-tax', 'rent']);
    function normalizePrice(input) {
        if (input.value.trim() !== '') input.value = String(Math.max(0, Number(input.value) || 0));
    }
    // Apartments re-derived from the measured floor area at other assumptions; nothing is measured again.
    function rederiveStats(stats, assumptions) {
        const api = yieldApi();
        return { ...stats, yield: api.rederive(stats.yield, assumptions),
            remainingYield: stats.remainingYield ? api.rederive(stats.remainingYield, assumptions) : null };
    }

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
        scope.setAttribute('role', 'status');

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

        // The all-in cost's parts, behind a disclosure under the figures.
        const costDetails = el('details', 'plan-stats-cost-details');
        const costSummary = el('summary', null, tPlanStats('sidebar.proposals.planStats.costDetails', 'Cost details'));
        costSummary.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.costDetails');
        costDetails.appendChild(costSummary);
        const costList = el('dl', 'plan-stats-cost-list');
        COST_PARTS.forEach(part => {
            const term = el('dt', null, tPlanStats(part.i18nKey, part.label));
            term.setAttribute('data-i18n-key', part.i18nKey);
            const amount = el('dd', null, '—');
            amount.dataset.planStat = part.key;
            if (part.taxIncludedOnly) [term, amount].forEach(node => { node.dataset.costPart = part.key; });
            costList.appendChild(term);
            costList.appendChild(amount);
        });
        costDetails.appendChild(costList);

        const assumptions = el('div', 'plan-stats-section');
        const assumptionsLabel = el('div', 'plan-stats-heading',
            tPlanStats('sidebar.proposals.planStats.assumptionsLabel', 'Assumptions'));
        assumptionsLabel.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.assumptionsLabel');
        assumptions.appendChild(assumptionsLabel);

        assumptions.appendChild(assumptionGrid('plan-stats', () => handleAssumptionChange()));

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
        body.appendChild(costDetails);
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
    // comparison show the same words. price: { sale, construction, land, saleTax, rent } in the city's
    // currency (priceIn), each null when not given.
    function summaryTexts(stats, price) {
        // The new floor area at these prices, by the 3D panel's rule (CityMoney.newBuildMoney): its
        // all-in cost (construction, land, sale tax, the existing floor area it clears), profit and rent.
        // The land is the plan's land (planAreaM2): the ground its designs take, streets and parks too.
        // Whether the construction cost includes the tax on its inputs is the city's rate's, not typed.
        const money = window.CityMoney.newBuildMoney({ floorAreaM2: stats.yield.total.grossFloorAreaM2,
            replacedFloorAreaM2: stats.cleared ? stats.cleared.floorAreaM2 : null, landAreaM2: stats.planAreaM2,
            salePerM2: price.sale, constructionPerM2: price.construction, landPerM2: price.land,
            saleTaxShare: price.saleTax, constructionTaxIncluded: salesPrice().constructionTaxIncluded === true,
            rentPerM2Month: price.rent });
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
            apartments: stats.unitsCounting ? tPlanStats('sidebar.proposals.planStats.countingUnits', 'Counting…')
                : total.laidOutBuildings > 0 ? tPlanStats('sidebar.proposals.planStats.apartmentsLaidOut', '{{apartments}} ({{laidOut}} of {{buildings}} buildings laid out)',
                    { apartments: formatNumber(total.apartments), laidOut: formatNumber(total.laidOutBuildings), buildings: formatNumber(total.buildings - total.unmeasuredBuildings) })
                : formatNumber(total.apartments),
            people: stats.unitsCounting ? tPlanStats('sidebar.proposals.planStats.countingUnits', 'Counting…') : formatNumber(total.people),
            jobs: formatNumber(total.jobs),
            'sales-value': formatSalesValue(finiteNumber(price.sale) ? total.grossFloorAreaM2 * price.sale : null),
            'total-cost': formatSalesValue(money.totalCost),
            // The all-in cost's parts (Cost details in Plan stats).
            'cost-construction': formatSalesValue(money.constructionCost),
            'cost-land': formatSalesValue(money.landCost),
            'cost-tax': formatSalesValue(money.saleTax),
            // Taken off the all-in cost, so written as a deduction.
            'cost-reclaimed': (money.taxReclaimed > 0 ? '−' : '') + formatSalesValue(money.taxReclaimed),
            'cost-replaced': formatSalesValue(money.replacedValue),
            profit: formatSalesValue(money.profit),
            'annual-rent': formatSalesValue(money.annualRent),
            'rent-yield': CbFormat.formatPercent(money.rentYieldOnCost, { maxFractionDigits: 1, missing: '—' })
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
        const price = priceIn(modal, 'plan-stats');
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
        ['apartments', 'people'].forEach(key => modal.querySelector(`[data-plan-stat="${key}"]`)?.classList?.toggle('plan-stats-counting', stats.unitsCounting === true));
        set('jobs', figures.jobs);
        set('sales-value', figures['sales-value']);
        set('total-cost', figures['total-cost']);
        set('cost-construction', figures['cost-construction']);
        set('cost-land', figures['cost-land']);
        set('cost-tax', figures['cost-tax']);
        set('cost-reclaimed', figures['cost-reclaimed']);
        const taxIncluded = salesPrice().constructionTaxIncluded === true;
        modal.querySelectorAll('[data-cost-part="cost-reclaimed"]').forEach(node => { node.hidden = !taxIncluded; });
        set('cost-replaced', figures['cost-replaced']);
        set('profit', figures.profit);
        set('annual-rent', figures['annual-rent']);
        set('rent-yield', figures['rent-yield']);

        const notes = [];
        if (price.land === null) {
            notes.push(tPlanStats('sidebar.proposals.planStats.noteNoLandPrice',
                'No land price for this place: set one to see the all-in cost and the profit.'));
        }
        if (stats.cleared && stats.cleared.unmeasured > 0) {
            notes.push(tPlanStats('sidebar.proposals.planStats.noteProfitUnmeasured',
                'The profit is not known: {{n}} of the existing buildings the plan clears state no height.',
                { n: formatNumber(stats.cleared.unmeasured) }));
        }
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
        if (stats.unitsError) {
            notes.push(tPlanStats('sidebar.proposals.planStats.unitsFailed', 'Apartments follow the per-m² rule: the buildings could not be laid out ({{reason}}).', { reason: stats.unitsError }));
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
        if (!modal || modal.hidden) return;
        statsController?.abort();
        modal.hidden = true;
        const trigger = planStatsTrigger;
        planStatsTrigger = null;
        // The modal's visibility observer releases background inertness after this event.
        if (trigger) window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }

    // Changing an assumption re-derives EVERY figure, not just the one beside the input: apartments
    // feed people, and both appear per period as well as in total, so a partial update is how two
    // numbers on one screen come to disagree. Nothing is measured again — the geometry did not move
    // because the apartment size did — so this stays cheap enough to run on every keystroke.
    function handleAssumptionChange() {
        const modal = document.getElementById('plan-stats-modal');
        const api = yieldApi();
        if (!modal || !latestStats || latestStats.unavailable || !api) return;
        rememberAssumptions(modal);
        renderPlanStatsModal(rederiveStats(latestStats, readAssumptionsFromModal(modal)));
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
                if (PRICE_KEYS.has(input.dataset.assumption)) normalizePrice(input);
                else readAssumptionsFromModal(modal, { normalizeInput: input });
                handleAssumptionChange();
            });
        });
    }

    // The plan's ground read with its roads, parks, squares and existing buildings:
    // { land, remaining } or { groundError }.
    async function withGround(snapshot, assumptions, signal) {
        try { return { ...snapshot, ...(await window.PresentState.groundOf(snapshot, { ...assumptions, signal })) }; }
        catch (error) {
            if (signal?.aborted) throw error;
            console.error(`[${new Date().toISOString()}] [PlanStats] the land of ${snapshot.plan?.content?.title || 'a plan'} could not be split`, error);
            return { ...snapshot, groundError: error && error.message ? error.message : String(error) };
        }
    }

    // Every building laid out and its apartments counted (plan-units.js): the designs' and the
    // existing ones that remain. { units: { designs, standing } } or { units: { error } }.
    async function countUnits(records, remaining, parcels, signal) {
        try {
            const standingFeatures = (remaining || []).flatMap(record => yieldApi().buildingFeaturesOf(record));
            const designs = await window.PlanUnits.forSnapshot(records || [], { parcels: parcels || [], standing: standingFeatures, signal });
            const standing = await window.PlanUnits.forSnapshot(remaining || [], { existing: true, signal });
            return { designs, standing };
        } catch (error) {
            if (signal?.aborted) return {};
            console.error(`[${new Date().toISOString()}] [PlanStats] apartments could not be counted from layouts`, error);
            return { error: error && error.message ? error.message : String(error) };
        }
    }
    async function withUnits(snapshot, signal) {
        return { ...snapshot, unitsCounting: false, units: await countUnits(snapshot.records, snapshot.remaining, snapshot.materializedFeatures, signal) };
    }

    let statsController = null;
    async function openPlanStats(summary, { readPlan = () => summary, returnFocus = null } = {}) {
        statsController?.abort();
        const { signal } = statsController = new AbortController();
        const modal = ensureModal();
        restoreAssumptions(modal);
        bindAssumptionInputs(modal);
        planStatsTrigger = returnFocus;
        latestStats = null;
        const status = modal.querySelector('[data-plan-stat="scope"]');
        const waiting = tPlanStats('planCompare.measuring', 'Measuring…');
        const count = summary?.content?.designCids?.length ?? summary?.designCount;
        const title = summary?.content?.title || summary?.title || '';
        const label = Number.isInteger(count)
            ? tPlanStats('sidebar.proposals.planStats.scope', '{{title}} · Designs: {{counted}}', { title, counted: formatNumber(count) }) : title;
        status.textContent = [label, waiting].filter(Boolean).join(' · ');
        modal.querySelector('[data-plan-stat="period-section"]').hidden = true;
        modal.querySelector('[data-plan-stat="notes"]').textContent = '';
        for (const { key } of [...SUMMARY_ROWS, ...COST_PARTS]) {
            const slot = modal.querySelector(`[data-plan-stat="${key}"]`);
            if (slot) slot.textContent = '—';
        }
        modal.hidden = false;
        modal.querySelector('[data-plan-stats-close]')?.focus();
        try {
            // Give the browser a paint opportunity before hashing, clipping or laying out a plan.
            if (window.requestAnimationFrame) await new Promise(resolve => window.requestAnimationFrame(() => setTimeout(resolve, 0)));
            if (signal.aborted) return;
            const plan = await readPlan();
            if (signal.aborted) return;
            const snapshot = await measureGeometry(await window.PlanAnalysis.prepare(plan, { signal }), signal);
            if (signal.aborted) return;
            planLocation = window.EconomicSources.locationOf(snapshot.landFeature);
            placePrices(modal, 'plan-stats', planLocation);
            const show = data => renderPlanStatsModal(computePlanStatsSync(data, readAssumptionsFromModal(modal)));
            show({ ...snapshot, unitsCounting: true });
            for (const key of ['public-land', 'private-land', 'buildings-remaining']) modal.querySelector(`[data-plan-stat="${key}"]`).textContent = waiting;
            const land = await withGround(snapshot, readAssumptionsFromModal(modal), signal);
            if (signal.aborted) return;
            show({ ...land, unitsCounting: true });
            const counted = await withUnits(land, signal);
            if (!signal.aborted) show(counted);
        } catch (error) {
            if (!signal.aborted) status.textContent = [label, tPlanStats('planCompare.failed', 'Not measured: {{reason}}', { reason: error.message })].filter(Boolean).join(' · ');
        }
    }

    // ── Plan comparison (Lists → Plans → Compare plans, Lists → Designs → Compare designs) ──────
    // Each chosen plan is measured as Plan stats measures one, without applying it, and shown in one
    // table under the same assumptions as Plan stats, which re-derive every column when one changes.
    // Compare designs passes each design as its one-member plan (PlanComposition.ofDesign).
    // Swap turns it between plans as columns and plans as rows.
    // A plan that cannot be measured keeps its place and says why.
    let comparePlansAsColumns = true;
    let activeCompare = null;

    // entries: [{ title, figures (summaryTexts) } | { title, error }] → the table element.
    function compareTable(entries, plansAsColumns, rowLabel) {
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
        const counting = (entry, key) => entry.stats?.unitsCounting && (key === 'apartments' || key === 'people');
        const value = (entry, key) => el('td', `plan-stats-table__number${counting(entry, key) ? ' plan-stats-counting' : ''}`, entry.figures ? entry.figures[key] : '—');
        const head = document.createElement('tr');
        head.appendChild(el('th', null, plansAsColumns ? '' : rowLabel));
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

    // What the dialog names the compared things by: its title, the basis covering them all, and the
    // table's heading for them.
    const COMPARE_SUBJECTS = {
        plans: [['planCompare.title', 'Compare plans'], ['planCompare.basisCompared', 'All compared plans'], ['plan.label', 'Plan']],
        designs: [['planCompare.titleDesigns', 'Compare designs'], ['planCompare.basisComparedDesigns', 'All compared designs'], ['planCompare.design', 'Design']],
        agreements: [['planCompare.titleAgreements', 'Compare agreements'], ['planCompare.basisComparedAgreements', 'All compared agreements'], ['planCompare.agreement', 'Agreement']]
    };

    // Compare agreements' terms: one column per agreement, one row per term (AgreementPanel.compareTerms),
    // the rows the agreements differ in marked, and a switch to show only those.
    function termsSection(agreements, titles) {
        const rows = window.AgreementPanel.compareTerms(agreements, undefined, { summaryText: window.ProposalApprovalSetup?.summaryText || null });
        const section = el('div', 'plan-stats-section plan-compare__terms');
        section.dataset.planCompareTerms = '';
        section.appendChild(el('div', 'plan-stats-heading', tPlanStats('planCompare.terms', 'Terms of the agreements')));
        const toggle = el('label', 'plan-compare__differing');
        const only = el('input');
        only.type = 'checkbox';
        only.dataset.planCompareDiffering = '';
        toggle.appendChild(only);
        toggle.appendChild(el('span', null, tPlanStats('planCompare.onlyDiffering', 'Only what differs')));
        const table = el('table', 'plan-stats-table plan-compare__table plan-compare__terms-table');
        const head = document.createElement('tr');
        head.appendChild(el('th'));
        titles.forEach(title => { const th = el('th', 'plan-compare__plan', title); th.setAttribute('scope', 'col'); head.appendChild(th); });
        table.appendChild(head);
        const lines = rows.map(row => {
            const tr = document.createElement('tr');
            tr.dataset.planCompareTerm = row.key;
            if (row.differs) { tr.className = 'plan-compare__term--differs'; tr.dataset.planCompareDiffers = ''; }
            const th = el('th', null, row.label);
            th.setAttribute('scope', 'row');
            if (row.differs) th.appendChild(el('span', 'cb-badge cb-badge--warning plan-compare__differs', tPlanStats('planCompare.differs', 'Differs')));
            tr.appendChild(th);
            row.values.forEach(value => tr.appendChild(el('td', null, value)));
            table.appendChild(tr);
            return { tr, differs: row.differs };
        });
        const same = el('p', 'sheet-note', tPlanStats('planCompare.termsSame', 'The agreements’ terms are the same.'));
        same.hidden = true;
        only.addEventListener('change', () => {
            lines.forEach(({ tr, differs }) => { tr.hidden = only.checked && !differs; });
            same.hidden = !only.checked || rows.some(row => row.differs);
        });
        const scroll = el('div', 'plan-compare__scroll');
        scroll.appendChild(table);
        section.appendChild(toggle);
        section.appendChild(scroll);
        section.appendChild(same);
        return section;
    }

    // subject: 'plans', 'designs' or 'agreements' (names the dialog); sides: the map Compare side of
    // each plan (three-compare.js values, null where it has none), by default the plan itself;
    // titles: each plan's column title (an agreement's own), by default the plan's; terms: with
    // agreements, the agreements themselves, whose terms are compared above what their plans build.
    async function comparePlans(plans, { subject = 'plans', sides = null, titles = null, terms = null } = {}) {
        const [titleText, basisText, headingText] = COMPARE_SUBJECTS[subject].map(([key, fallback]) => tPlanStats(key, fallback));
        const grid = assumptionGrid('plan-compare', () => refigure());
        const assumptions = readAssumptionsFromModal(grid, { prefix: 'plan-compare' });
        let price = priceIn(grid, 'plan-compare');
        const entries = plans.map((plan, index) => ({ title: titles?.[index] || plan?.content?.title || '', measuring: true }));
        const prepared = [];
        const preparedByIndex = new Array(plans.length);
        const controller = new AbortController();
        const { signal } = controller;
        activeCompare?.close();
        // The present state: what stands on a chosen plan's land today, as a column of its own.
        const present = { title: tPlanStats('planCompare.presentState', 'Present state'), present: true, measuring: false };
        const city = window.normalizeCityCodeForApi(window.resolveCurrentCityCode());
        const compared = new Set(plans.map(row => row?.cid));
        const saved = new Map(window.NamedPlans.list({ storedOnly: true })
            .filter(row => !compared.has(row.cid) && (!row.content.view.city || window.normalizeCityCodeForApi(row.content.view.city) === city))
            .map(row => [`saved:${row.cid}`, row]));

        // Measure on: all the plans' land, or one parcel they stand on (plan-scope.js), for every
        // column, the present state's too. null is all their land.
        const scopeApi = window.__planScope;
        const scopeOps = window.PresentState.ops;
        let scope = null;
        const scopeOf = snapshot => (scope ? scopeApi.toParcel(snapshot, scope.feature, scopeOps) : snapshot);
        let scopeParcels = [];

        const body = el('div', 'plan-compare');
        const scopeField = el('label', 'proposal-editor-field plan-compare__scope');
        scopeField.appendChild(el('span', null, tPlanStats('planCompare.scope', 'Measure on')));
        const scopeSelect = el('select');
        scopeSelect.dataset.planCompareScope = '';
        const scopeOption = (value, text) => { const node = el('option', null, text); node.value = value; scopeSelect.appendChild(node); };
        scopeOption('all', tPlanStats('planCompare.scopeAll', 'All their land'));

        scopeField.appendChild(scopeSelect);
        scopeField.hidden = !scopeParcels.length;
        const basisField = el('label', 'proposal-editor-field plan-compare__basis');
        basisField.appendChild(el('span', null, tPlanStats('planCompare.basis', 'Present state over the land of')));
        const basis = el('select');
        basis.disabled = true;
        basis.dataset.planCompareBasis = '';
        const option = (value, text) => { const node = el('option', null, text); node.value = value; basis.appendChild(node); };

        basisField.appendChild(basis);
        const swap = el('button', 'btn btn-sm plan-compare__swap', tPlanStats('planCompare.swap', 'Swap rows and columns'));
        swap.type = 'button';
        swap.dataset.planCompareSwap = '';
        // The same plans under the map's divider (three-compare.js, no apply): the first two chosen
        // plans side by side, or one plan beside Built today. A design fetched only for this has no side.
        const sideBySide = el('button', 'btn btn-sm plan-compare__side-by-side', tPlanStats('planCompare.sideBySide', 'Side by side on the map'));
        sideBySide.type = 'button';
        sideBySide.dataset.planCompareSideBySide = '';
        sideBySide.disabled = true;
        sideBySide.addEventListener('click', () => {
            const [first, second] = prepared.filter(row => row.side);
            dialog?.close?.();
            window.ThreeCompare.show({ left: second ? first.side : 'built', right: (second || first).side });
        });
        const scroll = el('div', 'plan-compare__scroll');
        const draw = () => {
            if (signal.aborted) return;
            scroll.innerHTML = '';
            scroll.appendChild(compareTable([present, ...entries], comparePlansAsColumns, headingText));
            swap.setAttribute('aria-pressed', String(!comparePlansAsColumns));
        };
        let measuring = 0;
        async function measurePresent(value) {
            const token = ++measuring;
            Object.assign(present, { measuring: true, error: null, figures: null, stats: null });
            draw();
            try {
                const basisPlans = (value === 'compared' ? prepared.map(row => row.base)
                    : value.startsWith('plan:') ? [prepared[Number(value.slice(5))].base]
                    : [await window.PlanAnalysis.prepare(saved.get(value), { signal })]).map(scopeOf);
                if (signal.aborted || token !== measuring) return;
                const stats = await window.PresentState.measure({ title: present.title, basis: basisPlans, assumptions });
                if (token !== measuring) return;
                present.stats = { ...stats, unitsCounting: true };
                present.measuring = false;
                present.figures = summaryTexts(rederiveStats(present.stats, readAssumptionsFromModal(grid, { prefix: 'plan-compare' })), price);
                draw();
                // Today's buildings laid out as the plans' are, so the columns count alike.
                const units = await countUnits([], stats.remainingRecords, [], signal);
                if (token !== measuring) return;
                present.stats = { ...stats, unitsCounting: false, unitsError: units.error || null,
                    remainingYield: yieldApi().planYield(stats.remainingRecords, { ...assumptions, unitsOf: units.standing?.unitsOf }) };
                present.figures = summaryTexts(rederiveStats(present.stats, readAssumptionsFromModal(grid, { prefix: 'plan-compare' })), price);
            } catch (error) {
                if (token !== measuring) return;
                console.error(`[${new Date().toISOString()}] [PlanCompare] the present state could not be measured`, error);
                present.error = error && error.message ? error.message : String(error);
            }
            present.measuring = false;
            draw();
        }
        basis.addEventListener('change', () => { void measurePresent(basis.value); });

        // Each plan's apartments, counted from its buildings' layouts one plan after another; its
        // Apartments and People cells spin until then. A newer scope stops an older count.
        let scoping = 0;
        async function countPlans(token) {
            for (const row of prepared) {
                if (signal.aborted || token !== scoping) return;
                const counted = await withUnits(row.snapshot, signal);
                if (token !== scoping) return;
                row.entry.stats = computePlanStatsSync(counted, readAssumptionsFromModal(grid, { prefix: 'plan-compare' }));
                row.entry.figures = summaryTexts(row.entry.stats, price);
                draw();
            }
        }
        // Every column measured again over the chosen scope: its ground first, then its apartments.
        async function rescope(value) {
            const token = ++scoping;
            scope = value === 'all' ? null : scopeParcels[Number(value.slice('parcel:'.length))];
            scopeNote.hidden = !scope;
            prepared.forEach(row => Object.assign(row.entry, { measuring: true, error: null, groundError: null, figures: null, stats: null }));
            void measurePresent(basis.value);
            for (const row of prepared) {
                const current = readAssumptionsFromModal(grid, { prefix: 'plan-compare' });
                try {
                    const scoped = await measureGeometry(scopeOf(row.base), signal);
                    const snapshot = await withGround(scoped, current, signal);
                    if (token !== scoping) return;
                    row.snapshot = snapshot;
                    row.entry.stats = computePlanStatsSync({ ...snapshot, unitsCounting: true }, readAssumptionsFromModal(grid, { prefix: 'plan-compare' }));
                    row.entry.figures = summaryTexts(row.entry.stats, price);
                    row.entry.groundError = row.entry.stats.groundError;
                } catch (error) {
                    if (token !== scoping) return;
                    console.error(`[${new Date().toISOString()}] [PlanCompare] ${row.title} could not be measured on ${scope ? `parcel ${scope.id}` : 'all its land'}`, error);
                    row.entry.error = error && error.message ? error.message : String(error);
                }
                row.entry.measuring = false;
                draw();
            }
            await countPlans(token);
        }
        scopeSelect.addEventListener('change', () => { void rescope(scopeSelect.value); });
        swap.addEventListener('click', () => { comparePlansAsColumns = !comparePlansAsColumns; draw(); });
        // How the apartments are counted, with the numbers in the inputs above.
        const rule = el('p', 'sheet-note plan-compare__rule');
        rule.dataset.planCompareRule = '';
        const describeRule = current => {
            rule.textContent = tPlanStats('planCompare.apartmentRule',
                'Count apartments directly when there is an estimated layout. Otherwise: gross floor area × {{efficiency}} % net × {{housing}} % housing ÷ {{size}} m² per apartment. People = apartments × {{persons}}.',
                { efficiency: formatNumber(current.efficiency * 100), housing: formatNumber(current.housingShare * 100),
                    size: formatNumber(current.avgApartmentM2), persons: formatNumber(current.personsPerApartment, 1) });
        };
        describeRule(assumptions);
        // An assumption changed: every column re-derives from what was measured, in both dialogs.
        const refigure = ({ normalizeInput = null } = {}) => {
            const current = readAssumptionsFromModal(grid, { prefix: 'plan-compare', normalizeInput });
            price = priceIn(grid, 'plan-compare');
            rememberAssumptions(grid);
            [...entries, present].forEach(entry => { if (entry.stats) entry.figures = summaryTexts(rederiveStats(entry.stats, current), price); });
            describeRule(current);
            draw();
        };
        grid.querySelectorAll('[data-assumption]').forEach(input => {
            input.addEventListener('input', () => refigure());
            input.addEventListener('change', () => {
                if (PRICE_KEYS.has(input.dataset.assumption)) normalizePrice(input);
                refigure({ normalizeInput: input });
            });
        });
        const assumptionsSection = el('div', 'plan-stats-section plan-compare__assumptions');
        assumptionsSection.appendChild(el('div', 'plan-stats-heading', tPlanStats('sidebar.proposals.planStats.assumptionsLabel', 'Assumptions')));
        assumptionsSection.appendChild(grid);
        assumptionsSection.appendChild(rule);
        const definition = el('p', 'sheet-note', tPlanStats('planCompare.landDefinition',
            'Public land is roads and OpenStreetMap parks and squares; private land is the rest of the parcels. The present state counts every existing building on that land.'));
        const scopeNote = el('p', 'sheet-note plan-compare__scope-note', tPlanStats('planCompare.scopeNote',
            'On one parcel, every column counts only what stands on that parcel: a building across its edge counts its part there.'));
        scopeNote.hidden = true;
        if (terms) {
            body.appendChild(termsSection(terms, terms.map((agreement, index) => titles?.[index] || agreement?.title || '')));
            body.appendChild(el('div', 'plan-stats-heading', tPlanStats('planCompare.figures', 'What the plans build')));
        }
        body.appendChild(scopeField);
        body.appendChild(basisField);
        body.appendChild(swap);
        body.appendChild(sideBySide);
        body.appendChild(scroll);
        body.appendChild(assumptionsSection);
        body.appendChild(definition);
        body.appendChild(scopeNote);
        draw();
        const dialog = window.CbDialog.open({ title: titleText, size: 'lg', className: 'plan-compare-dialog', body,
            onClose: () => { controller.abort(); measuring++; scoping++; if (activeCompare === handle) activeCompare = null; } });
        const handle = { close() { controller.abort(); dialog.close?.(); } };
        activeCompare = handle;
        let next = 0, placed = false;
        async function prepareColumn() {
            while (!signal.aborted && next < plans.length) {
                const index = next++, plan = plans[index], entry = entries[index];
                const show = snapshot => {
                    // One set of prices for every column: those of the first plan's place.
                    if (index === 0 && !placed) {
                        placed = true;
                        placePrices(grid, 'plan-compare', window.EconomicSources.locationOf(snapshot.landFeature));
                        price = priceIn(grid, 'plan-compare');
                        [...entries, present].forEach(other => { if (other.stats) other.figures = summaryTexts(other.stats, price); });
                    }
                    entry.stats = computePlanStatsSync({ ...snapshot, unitsCounting: true }, readAssumptionsFromModal(grid, { prefix: 'plan-compare' }));
                    entry.figures = summaryTexts(entry.stats, price);
                    entry.groundError = entry.stats.groundError;
                    draw();
                };
                try {
                    const base = await measureGeometry(await window.PlanAnalysis.prepare(plan, { signal }), signal);
                    if (signal.aborted) return;
                    show(base);
                    const snapshot = await withGround(base, readAssumptionsFromModal(grid, { prefix: 'plan-compare' }), signal);
                    if (signal.aborted) return;
                    entry.measuring = false;
                    show(snapshot);
                    preparedByIndex[index] = { title: entry.title, cid: plan?.cid, side: sides ? sides[index] : plan?.cid && `plan:${plan.cid}`, base, snapshot, entry };
                } catch (error) {
                    if (signal.aborted) return;
                    Object.assign(entry, { measuring: false, error: error.message || String(error) });
                    draw();
                }
            }
        }
        if (window.requestAnimationFrame) await new Promise(resolve => window.requestAnimationFrame(() => setTimeout(resolve, 0)));
        await Promise.all([prepareColumn(), prepareColumn()]);
        if (signal.aborted) return dialog;
        prepared.push(...preparedByIndex.filter(Boolean));
        scopeParcels = scopeApi.parcelsOf(prepared.map(row => row.base), scopeOps);
        scopeParcels.forEach((parcel, index) => scopeOption(`parcel:${index}`, parcel.plans === prepared.length
            ? tPlanStats('planCompare.scopeParcel', 'Parcel {{number}} ({{area}} m²)', { number: parcel.number, area: formatNumber(parcel.areaM2) })
            : tPlanStats('planCompare.scopeParcelSome', 'Parcel {{number}} ({{area}} m², in {{count}} of {{total}})',
                { number: parcel.number, area: formatNumber(parcel.areaM2), count: formatNumber(parcel.plans), total: formatNumber(prepared.length) })));
        scopeField.hidden = !scopeParcels.length;
        if (prepared.length > 1) option('compared', basisText);
        prepared.forEach((row, index) => option(`plan:${index}`, row.title));
        saved.forEach((row, value) => option(value, row.content.title));
        basis.disabled = false;
        sideBySide.disabled = !prepared.some(row => row.side) || !window.ThreeCompare?.show;
        if (basis.children.length) {
            basis.value = basis.children[0].value;
            void measurePresent(basis.value);
        } else present.error = tPlanStats('planCompare.noBasis', 'No saved plan to take the land from.');
        draw();
        void countPlans(scoping);
        return dialog;
    }

    window.showPlanStatsModal = openPlanStats;
    window.comparePlanStats = comparePlans;
})();
