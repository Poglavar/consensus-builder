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

    function formatNumber(value, fractionDigits = 0) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        return num.toLocaleString(undefined, {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits
        });
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
            return Number.isFinite(value) && value > 0 ? value * scale : fallback;
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
        const result = api.planYield(applied, assumptions);
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

        return {
            unavailable: false,
            proposalsTotal: all.length,
            proposalsCounted: applied.length,
            yield: result,
            parcelCount: parcels.resulting.length,
            parcelProduced: parcels.produced.length,
            parcelConsumed: parcels.consumed.length,
            parcelMeasuredCount: measuredCount,
            parcelMeasuredArea: measuredArea
        };
    }

    function computePlanStatsAsync(assumptions) {
        return new Promise(resolve => {
            requestAnimationFrame(() => resolve(computePlanStatsSync(assumptions)));
        });
    }

    function el(tag, style, text) {
        const node = document.createElement(tag);
        if (style) Object.assign(node.style, style);
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

    function ensureModal() {
        let overlay = document.getElementById('plan-stats-modal');
        if (overlay) return overlay;

        overlay = el('div', {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)', display: 'none',
            alignItems: 'center', justifyContent: 'center', zIndex: '12000'
        });
        overlay.id = 'plan-stats-modal';

        const dialog = el('div', {
            background: '#fff', borderRadius: '12px', padding: '20px', width: 'min(760px, 94vw)',
            maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        });
        dialog.className = 'plan-stats-card';

        const header = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' });
        const title = el('h3', { margin: '0' }, tPlanStats('sidebar.proposals.planStats.modalTitle', 'Plan Stats'));
        title.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.modalTitle');
        header.appendChild(title);

        const closeBtn = el('button', {
            border: 'none', background: 'transparent', fontSize: '22px', cursor: 'pointer', lineHeight: '1'
        }, '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', tPlanStats('sidebar.proposals.planStats.closeAria', 'Close plan stats'));
        closeBtn.addEventListener('click', () => hidePlanStatsModal());
        header.appendChild(closeBtn);

        const scope = el('div', { fontSize: '12px', color: '#64748b', marginBottom: '14px' });
        scope.dataset.planStat = 'scope';

        const body = el('div', { display: 'flex', flexDirection: 'column', gap: '16px' });

        const summaryList = el('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' });
        summaryList.className = 'plan-stats-grid';
        SUMMARY_ROWS.forEach(row => {
            const wrapper = el('div', { display: 'flex', flexDirection: 'column', gap: '2px' });
            const label = el('div', { fontSize: '13px', color: '#444' }, tPlanStats(row.i18nKey, row.label));
            label.setAttribute('data-i18n-key', row.i18nKey);
            const value = el('div', { fontWeight: '600', fontSize: '18px' }, '—');
            value.dataset.planStat = row.key;
            wrapper.appendChild(label);
            wrapper.appendChild(value);
            summaryList.appendChild(wrapper);
        });

        const assumptions = el('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
        const assumptionsLabel = el('div', { fontSize: '13px', fontWeight: '600', color: '#334155' },
            tPlanStats('sidebar.proposals.planStats.assumptionsLabel', 'Assumptions'));
        assumptionsLabel.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.assumptionsLabel');
        assumptions.appendChild(assumptionsLabel);

        const grid = el('div', { display: 'grid', gridTemplateColumns: '90px 1fr 90px 1fr', alignItems: 'center', gap: '8px 10px' });
        const defaults = (yieldApi() || {}).DEFAULTS || {};
        ASSUMPTION_INPUTS.forEach(spec => {
            const input = el('input', {
                width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: '6px', boxSizing: 'border-box'
            });
            input.type = 'number';
            input.id = spec.id;
            if (spec.min !== undefined) input.min = String(spec.min);
            if (spec.max !== undefined) input.max = String(spec.max);
            if (spec.step !== undefined) input.step = String(spec.step);
            input.value = String(typeof spec.value === 'function' ? spec.value(defaults) : spec.value);
            const suffix = el('span', { fontSize: '13px', color: '#555' }, tPlanStats(spec.i18nKey, spec.label));
            suffix.setAttribute('data-i18n-key', spec.i18nKey);
            grid.appendChild(input);
            grid.appendChild(suffix);
        });
        assumptions.appendChild(grid);

        const epochSection = el('div', { display: 'none', flexDirection: 'column', gap: '8px' });
        epochSection.dataset.planStat = 'epoch-section';

        const epochHeader = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });
        const epochTitle = el('div', { fontSize: '13px', fontWeight: '600', color: '#334155' },
            tPlanStats('sidebar.proposals.planStats.byPeriod', 'By period'));
        epochTitle.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.byPeriod');
        epochHeader.appendChild(epochTitle);

        const toggle = el('div', { display: 'flex', gap: '4px' });
        [
            { mode: 'added', i18nKey: 'sidebar.proposals.planStats.viewAdded', label: 'Added' },
            { mode: 'cumulative', i18nKey: 'sidebar.proposals.planStats.viewCumulative', label: 'Standing' }
        ].forEach(option => {
            const button = el('button', {
                padding: '4px 10px', fontSize: '12px', borderRadius: '6px', cursor: 'pointer',
                border: '1px solid #cbd5e1', background: '#fff'
            }, tPlanStats(option.i18nKey, option.label));
            button.type = 'button';
            button.setAttribute('data-i18n-key', option.i18nKey);
            button.dataset.epochView = option.mode;
            button.addEventListener('click', () => {
                epochView = option.mode;
                if (latestStats) renderEpochTable(document.getElementById('plan-stats-modal'), latestStats);
            });
            toggle.appendChild(button);
        });
        epochHeader.appendChild(toggle);
        epochSection.appendChild(epochHeader);

        const epochTable = el('div', { overflowX: 'auto' });
        epochTable.dataset.planStat = 'epoch-table';
        epochSection.appendChild(epochTable);

        const notes = el('div', { fontSize: '12px', color: '#b45309' });
        notes.dataset.planStat = 'notes';

        body.appendChild(summaryList);
        body.appendChild(assumptions);
        body.appendChild(epochSection);
        body.appendChild(notes);

        dialog.appendChild(header);
        dialog.appendChild(scope);
        dialog.appendChild(body);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

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
            section.style.display = 'none';
            return;
        }
        section.style.display = 'flex';

        modal.querySelectorAll('[data-epoch-view]').forEach(button => {
            const active = button.dataset.epochView === epochView;
            button.style.background = active ? '#1e293b' : '#fff';
            button.style.color = active ? '#fff' : '#334155';
            button.style.borderColor = active ? '#1e293b' : '#cbd5e1';
        });

        const rows = periods.slice();
        // "Added" is the only view where the undated proposals are a row of their own; in the
        // cumulative view they are already inside every year, and repeating them would double them.
        if (epochView === 'added' && result.unassigned.proposals > 0) rows.push(result.unassigned);

        const table = document.createElement('table');
        Object.assign(table.style, { width: '100%', borderCollapse: 'collapse', fontSize: '13px' });

        const head = document.createElement('tr');
        const periodTh = document.createElement('th');
        periodTh.textContent = tPlanStats('sidebar.proposals.planStats.colPeriod', 'period');
        periodTh.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.colPeriod');
        Object.assign(periodTh.style, { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontWeight: '600' });
        head.appendChild(periodTh);
        EPOCH_COLUMNS.forEach(column => {
            const th = document.createElement('th');
            th.textContent = tPlanStats(column.i18nKey, column.label);
            th.setAttribute('data-i18n-key', column.i18nKey);
            Object.assign(th.style, { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontWeight: '600' });
            head.appendChild(th);
        });
        table.appendChild(head);

        rows.forEach(bucket => {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.textContent = bucket.year === null
                ? tPlanStats('sidebar.proposals.planStats.noEpoch', 'no period')
                : String(bucket.year);
            Object.assign(td.style, { padding: '4px 8px', borderBottom: '1px solid #f1f5f9' });
            tr.appendChild(td);
            EPOCH_COLUMNS.forEach(column => {
                const cell = document.createElement('td');
                cell.textContent = column.get(bucket);
                Object.assign(cell.style, { padding: '4px 8px', borderBottom: '1px solid #f1f5f9', textAlign: 'right', fontVariantNumeric: 'tabular-nums' });
                tr.appendChild(cell);
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
            modal.style.display = 'flex';
            return;
        }

        const total = stats.yield.total;
        const avgParcel = stats.parcelMeasuredCount > 0 ? stats.parcelMeasuredArea / stats.parcelMeasuredCount : null;

        set('scope', tPlanStats(
            'sidebar.proposals.planStats.scope',
            '{{counted}} applied proposals counted of {{total}} on this map.',
            { counted: formatNumber(stats.proposalsCounted), total: formatNumber(stats.proposalsTotal) }
        ));

        set('resulting-parcels', avgParcel === null
            ? formatNumber(stats.parcelCount)
            : `${formatNumber(stats.parcelCount)} (${formatNumber(avgParcel)} m²)`);
        set('buildings', `${formatNumber(total.buildings)} (${formatNumber(total.footprintM2)} m²)`);
        set('floor-area', formatNumber(total.grossFloorAreaM2));
        set('open-space', formatNumber(total.openSpaceM2));
        set('apartments', formatNumber(total.apartments));
        set('people', formatNumber(total.people));
        set('jobs', formatNumber(total.jobs));

        const priceInput = modal.querySelector('#plan-stats-price');
        const price = Math.max(0, Number(priceInput && priceInput.value) || 0);
        set('sales-value', `${formatNumber(total.grossFloorAreaM2 * price)} ${tPlanStats('sidebar.proposals.planStats.currency', 'EUR')}`);

        const notes = [];
        if (total.unmeasuredBuildings > 0) {
            notes.push(tPlanStats(
                'sidebar.proposals.planStats.noteUnmeasured',
                '{{n}} of {{total}} buildings state no height — their floor area is not counted.',
                { n: formatNumber(total.unmeasuredBuildings), total: formatNumber(total.buildings) }
            ));
        }
        const unmeasuredParcels = stats.parcelCount - stats.parcelMeasuredCount;
        if (unmeasuredParcels > 0) {
            notes.push(tPlanStats(
                'sidebar.proposals.planStats.noteParcelArea',
                'The average parcel size is over the {{measured}} parcels whose shape is loaded; {{missing}} are counted but not measured.',
                { measured: formatNumber(stats.parcelMeasuredCount), missing: formatNumber(unmeasuredParcels) }
            ));
        }
        set('notes', notes.join(' '));

        renderEpochTable(modal, stats);

        modal.style.display = 'flex';
        modal.focus();
    }

    function hidePlanStatsModal() {
        const modal = document.getElementById('plan-stats-modal');
        if (modal) modal.style.display = 'none';
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
        return !!modal && modal.style.display === 'flex';
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
        document.addEventListener('keydown', (evt) => {
            if (evt.key === 'Escape') {
                const modal = document.getElementById('plan-stats-modal');
                if (modal && modal.style.display === 'flex') hidePlanStatsModal();
            }
        });
    });

    window.showPlanStatsModal = openPlanStats;
})();
