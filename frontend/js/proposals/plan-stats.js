(function () {
    const DEFAULT_PRICE_PER_SQM = 5000;
    const DEFAULT_HOUSING_SHARE = 50;
    const DEFAULT_SQM_PER_INHABITANT = 10;

    let latestStats = null;

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
            const translated = api.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return formatTemplate(fallback, params);
    }

    function formatNumber(value, fractionDigits = 0) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '0';
        return num.toLocaleString(undefined, {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits
        });
    }

    function safeArea(feature) {
        if (!feature || !feature.geometry || typeof turf === 'undefined') return 0;
        try {
            const area = turf.area(feature);
            return Number.isFinite(area) ? area : 0;
        } catch (_) {
            return 0;
        }
    }

    function featureFromPersisted(parcelId) {
        if (typeof readPersistedParcelRecord !== 'function') return null;
        try {
            const record = readPersistedParcelRecord(parcelId);
            if (!record || !record.geometry || !record.properties) return null;
            return {
                type: 'Feature',
                geometry: record.geometry,
                properties: Object.assign({}, record.properties, { parcelId })
            };
        } catch (_) {
            return null;
        }
    }

    function getParcelFeature(parcelId) {
        if (!parcelId) return null;
        const id = parcelId.toString();

        try {
            const cached = (typeof getCachedParcelFeature === 'function') ? getCachedParcelFeature(id) : null;
            if (cached && cached.geometry) return cached;
        } catch (_) { /* ignore */ }

        try {
            if (typeof resolveParcelLayerById === 'function') {
                const layer = resolveParcelLayerById(id);
                if (layer && typeof layer.toGeoJSON === 'function') {
                    return layer.toGeoJSON();
                }
            }
        } catch (_) { /* ignore */ }

        try {
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
                const layer = multiParcelSelection.findParcelById(id);
                if (layer && typeof layer.toGeoJSON === 'function') {
                    return layer.toGeoJSON();
                }
            }
        } catch (_) { /* ignore */ }

        const persisted = featureFromPersisted(id);
        if (persisted) return persisted;
        return null;
    }

    function collectDescendantParcelIds(proposal) {
        const ids = new Set();
        if (!proposal) return [];

        try {
            if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getChildIdsForProposal === 'function') {
                ProposalManager._getChildIdsForProposal(proposal).forEach(id => {
                    if (id !== undefined && id !== null) ids.add(id.toString());
                });
            }
        } catch (_) { /* best-effort */ }

        const candidates = [
            proposal.childParcelIds,
            proposal.descendantParcelIds,
            proposal.childIds,
            proposal.roadProposal && proposal.roadProposal.childParcelIds,
            proposal.reparcellization && proposal.reparcellization.childParcelIds,
            proposal.decideLaterProposal && proposal.decideLaterProposal.childParcelIds,
            proposal.buildingProposal && proposal.buildingProposal.childParcelIds
        ];

        candidates.forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(id => {
                if (id === undefined || id === null) return;
                ids.add(id.toString());
            });
        });

        return Array.from(ids);
    }

    function extractHeightMeters(props) {
        if (!props) return null;
        const numericFields = ['height', 'HEIGHT', 'visina', 'Visina'];
        for (let i = 0; i < numericFields.length; i++) {
            const value = Number(props[numericFields[i]]);
            if (Number.isFinite(value) && value > 0) return value;
        }
        const floorFields = ['floors', 'FLOORS', 'kat', 'KAT', 'katova', 'KATOVA', 'storeys', 'STOREYS'];
        for (let i = 0; i < floorFields.length; i++) {
            const floors = Number(props[floorFields[i]]);
            if (Number.isFinite(floors) && floors > 0) return floors * 3;
        }
        return null;
    }

    function computePlanStatsSync() {
        const proposals = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function')
            ? proposalStorage.getAllProposals()
            : [];

        const totals = {
            totalDescendantArea: 0,
            totalFootprintArea: 0,
            totalBuildableFloorArea: 0
        };

        proposals.forEach(proposal => {
            const childIds = collectDescendantParcelIds(proposal);
            childIds.forEach(id => {
                const feature = getParcelFeature(id);
                totals.totalDescendantArea += safeArea(feature);
            });

            const buildingFeatures = (typeof collectProposalBuildingFeatures === 'function')
                ? collectProposalBuildingFeatures(proposal)
                : [];

            buildingFeatures.forEach(feature => {
                if (!feature || !feature.geometry) return;
                const footprint = safeArea(feature);
                totals.totalFootprintArea += footprint;
                const height = extractHeightMeters(feature.properties) ?? 10;
                const floors = Math.max(1, Math.floor(height / 3));
                totals.totalBuildableFloorArea += footprint * floors;
            });
        });

        return totals;
    }

    function computePlanStatsAsync() {
        return new Promise(resolve => {
            requestAnimationFrame(() => resolve(computePlanStatsSync()));
        });
    }

    function ensureModal() {
        let overlay = document.getElementById('plan-stats-modal');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'plan-stats-modal';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0,0,0,0.45)';
        overlay.style.display = 'none';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '12000';

        const dialog = document.createElement('div');
        dialog.className = 'plan-stats-card';
        dialog.style.background = '#fff';
        dialog.style.borderRadius = '12px';
        dialog.style.padding = '20px';
        dialog.style.width = 'min(720px, 92vw)';
        dialog.style.maxHeight = '90vh';
        dialog.style.overflow = 'auto';
        dialog.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
        dialog.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '12px';

        const title = document.createElement('h3');
        title.textContent = tPlanStats('sidebar.proposals.planStats.modalTitle', 'Plan Stats');
        title.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.modalTitle');
        title.style.margin = '0';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.style.border = 'none';
        closeBtn.style.background = 'transparent';
        closeBtn.style.fontSize = '22px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.lineHeight = '1';
        closeBtn.setAttribute('aria-label', tPlanStats('sidebar.proposals.planStats.closeAria', 'Close plan stats'));
        closeBtn.addEventListener('click', () => hidePlanStatsModal());
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'plan-stats-body';
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '12px';

        const summaryList = document.createElement('div');
        summaryList.className = 'plan-stats-grid';
        summaryList.style.display = 'grid';
        summaryList.style.gridTemplateColumns = '1fr 1fr';
        summaryList.style.gap = '10px 16px';

        const rows = [
            {
                label: tPlanStats('sidebar.proposals.planStats.descendantArea', 'Total area of descendant parcels (m²)'),
                key: 'descendant-area',
                i18nKey: 'sidebar.proposals.planStats.descendantArea'
            },
            {
                label: tPlanStats('sidebar.proposals.planStats.footprintArea', 'Total built footprint area (m²)'),
                key: 'footprint-area',
                i18nKey: 'sidebar.proposals.planStats.footprintArea'
            },
            {
                label: tPlanStats('sidebar.proposals.planStats.floorArea', 'Total buildable floor area (m²)'),
                key: 'floor-area',
                i18nKey: 'sidebar.proposals.planStats.floorArea'
            }
        ];

        rows.forEach(row => {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.gap = '4px';

            const label = document.createElement('div');
            label.textContent = row.label;
            if (row.i18nKey) {
                label.setAttribute('data-i18n-key', row.i18nKey);
            }
            label.style.fontSize = '14px';
            label.style.color = '#444';

            const value = document.createElement('div');
            value.dataset.planStat = row.key;
            value.style.fontWeight = '600';
            value.style.fontSize = '18px';
            value.textContent = '—';

            wrapper.appendChild(label);
            wrapper.appendChild(value);
            summaryList.appendChild(wrapper);
        });

        const priceRow = document.createElement('div');
        priceRow.className = 'plan-stats-input-row';
        priceRow.style.display = 'grid';
        priceRow.style.gridTemplateColumns = 'auto 100px auto auto 1fr';
        priceRow.style.alignItems = 'center';
        priceRow.style.gap = '8px';

        const priceLabel = document.createElement('label');
        priceLabel.textContent = tPlanStats('sidebar.proposals.planStats.salesLabel', 'Total sales value at price of');
        priceLabel.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.salesLabel');
        priceLabel.style.fontSize = '14px';
        priceLabel.style.color = '#444';

        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.id = 'plan-stats-price';
        priceInput.min = '0';
        priceInput.step = '100';
        priceInput.value = DEFAULT_PRICE_PER_SQM;
        priceInput.style.width = '100px';
        priceInput.style.padding = '6px 8px';
        priceInput.style.border = '1px solid #ccc';
        priceInput.style.borderRadius = '6px';
        priceInput.style.boxSizing = 'border-box';

        const priceSuffix = document.createElement('span');
        priceSuffix.textContent = tPlanStats('sidebar.proposals.planStats.salesSuffix', 'EUR per m²');
        priceSuffix.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.salesSuffix');
        priceSuffix.style.whiteSpace = 'nowrap';

        const priceArrow = document.createElement('span');
        priceArrow.textContent = '→';
        priceArrow.style.fontWeight = '600';

        const priceValue = document.createElement('div');
        priceValue.dataset.planStat = 'sales-value';
        priceValue.style.fontWeight = '600';
        priceValue.style.textAlign = 'left';
        priceValue.textContent = '—';

        priceRow.appendChild(priceLabel);
        priceRow.appendChild(priceInput);
        priceRow.appendChild(priceSuffix);
        priceRow.appendChild(priceArrow);
        priceRow.appendChild(priceValue);

        const inhabitantRow = document.createElement('div');
        inhabitantRow.className = 'plan-stats-input-row';
        inhabitantRow.style.display = 'flex';
        inhabitantRow.style.flexDirection = 'column';
        inhabitantRow.style.gap = '6px';

        const inhabitantLabel = document.createElement('label');
        inhabitantLabel.textContent = tPlanStats('sidebar.proposals.planStats.housingLabel', 'Number of inhabitants at housing/work split and m² per inhabitant');
        inhabitantLabel.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.housingLabel');
        inhabitantLabel.style.fontSize = '14px';
        inhabitantLabel.style.color = '#444';

        const inhabitantControls = document.createElement('div');
        inhabitantControls.style.display = 'grid';
        inhabitantControls.style.gridTemplateColumns = '100px auto 100px auto 1fr';
        inhabitantControls.style.alignItems = 'center';
        inhabitantControls.style.gap = '8px';

        const splitInput = document.createElement('input');
        splitInput.type = 'number';
        splitInput.id = 'plan-stats-housing-share';
        splitInput.min = '0';
        splitInput.max = '100';
        splitInput.step = '5';
        splitInput.value = DEFAULT_HOUSING_SHARE;
        splitInput.style.width = '100px';
        splitInput.style.padding = '6px 8px';
        splitInput.style.border = '1px solid #ccc';
        splitInput.style.borderRadius = '6px';
        splitInput.style.boxSizing = 'border-box';

        const splitSuffix = document.createElement('span');
        splitSuffix.textContent = tPlanStats('sidebar.proposals.planStats.housingShareSuffix', '% housing share');
        splitSuffix.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.housingShareSuffix');
        splitSuffix.style.fontSize = '14px';
        splitSuffix.style.color = '#555';
        splitSuffix.style.whiteSpace = 'nowrap';

        const densityInput = document.createElement('input');
        densityInput.type = 'number';
        densityInput.id = 'plan-stats-area-per-inhabitant';
        densityInput.min = '1';
        densityInput.step = '1';
        densityInput.value = DEFAULT_SQM_PER_INHABITANT;
        densityInput.style.width = '100px';
        densityInput.style.padding = '6px 8px';
        densityInput.style.border = '1px solid #ccc';
        densityInput.style.borderRadius = '6px';
        densityInput.style.boxSizing = 'border-box';

        const densitySuffix = document.createElement('span');
        densitySuffix.textContent = tPlanStats('sidebar.proposals.planStats.areaPerInhabitantSuffix', 'm² per inhabitant');
        densitySuffix.setAttribute('data-i18n-key', 'sidebar.proposals.planStats.areaPerInhabitantSuffix');
        densitySuffix.style.fontSize = '14px';
        densitySuffix.style.color = '#555';
        densitySuffix.style.whiteSpace = 'nowrap';

        const inhabitantsValue = document.createElement('div');
        inhabitantsValue.dataset.planStat = 'inhabitants';
        inhabitantsValue.style.fontWeight = '600';
        inhabitantsValue.style.textAlign = 'left';
        inhabitantsValue.textContent = '—';

        inhabitantControls.appendChild(splitInput);
        inhabitantControls.appendChild(splitSuffix);
        inhabitantControls.appendChild(densityInput);
        inhabitantControls.appendChild(densitySuffix);
        inhabitantControls.appendChild(inhabitantsValue);

        inhabitantRow.appendChild(inhabitantLabel);
        inhabitantRow.appendChild(inhabitantControls);

        body.appendChild(summaryList);
        body.appendChild(priceRow);
        body.appendChild(inhabitantRow);

        dialog.appendChild(header);
        dialog.appendChild(body);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
            try { window.i18n.applyTranslations(overlay); } catch (_) { /* ignore */ }
        }

        return overlay;
    }

    function updateDerivedFields(modal, stats) {
        if (!modal || !stats) return;
        const priceInput = modal.querySelector('#plan-stats-price');
        const splitInput = modal.querySelector('#plan-stats-housing-share');
        const densityInput = modal.querySelector('#plan-stats-area-per-inhabitant');
        const salesValueEl = modal.querySelector('[data-plan-stat="sales-value"]');
        const inhabitantsEl = modal.querySelector('[data-plan-stat="inhabitants"]');

        const price = Math.max(0, Number(priceInput?.value) || 0);
        const housingShare = Math.min(100, Math.max(0, Number(splitInput?.value) || 0));
        const sqmPerPerson = Math.max(1, Number(densityInput?.value) || 1);
        const currencyLabel = tPlanStats('sidebar.proposals.planStats.currency', 'EUR');

        const salesValue = stats.totalBuildableFloorArea * price;
        const inhabitants = (stats.totalBuildableFloorArea * (housingShare / 100)) / sqmPerPerson;

        if (salesValueEl) salesValueEl.textContent = formatNumber(salesValue, 0) + ' ' + currencyLabel;
        if (inhabitantsEl) inhabitantsEl.textContent = formatNumber(Math.floor(inhabitants), 0);
    }

    function renderPlanStatsModal(stats) {
        const modal = ensureModal();
        if (!modal) return;

        const descendantEl = modal.querySelector('[data-plan-stat="descendant-area"]');
        const footprintEl = modal.querySelector('[data-plan-stat="footprint-area"]');
        const floorEl = modal.querySelector('[data-plan-stat="floor-area"]');

        if (descendantEl) descendantEl.textContent = formatNumber(stats.totalDescendantArea, 0);
        if (footprintEl) footprintEl.textContent = formatNumber(stats.totalFootprintArea, 0);
        if (floorEl) floorEl.textContent = formatNumber(stats.totalBuildableFloorArea, 0);

        const priceInput = modal.querySelector('#plan-stats-price');
        if (priceInput && !priceInput.value) priceInput.value = DEFAULT_PRICE_PER_SQM;
        const splitInput = modal.querySelector('#plan-stats-housing-share');
        if (splitInput && !splitInput.value) splitInput.value = DEFAULT_HOUSING_SHARE;
        const densityInput = modal.querySelector('#plan-stats-area-per-inhabitant');
        if (densityInput && !densityInput.value) densityInput.value = DEFAULT_SQM_PER_INHABITANT;

        modal.style.display = 'flex';
        modal.focus();

        updateDerivedFields(modal, stats);
    }

    function hidePlanStatsModal() {
        const modal = document.getElementById('plan-stats-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    function setPlanStatsButtonBusy(busy) {
        const button = document.getElementById('planStatsButton');
        if (!button) return;
        const label = button.querySelector('.plan-stats-label');
        const spinner = button.querySelector('.plan-stats-spinner');
        if (busy) {
            button.disabled = true;
            if (label) label.style.display = 'none';
            if (spinner) spinner.style.display = 'inline-flex';
        } else {
            button.disabled = false;
            if (label) label.style.display = '';
            if (spinner) spinner.style.display = 'none';
        }
    }

    async function handlePlanStatsClick(event) {
        event?.preventDefault();
        setPlanStatsButtonBusy(true);
        try {
            const stats = await computePlanStatsAsync();
            latestStats = stats;
            renderPlanStatsModal(stats);
            const modal = document.getElementById('plan-stats-modal');
            if (modal) {
                const priceInput = modal.querySelector('#plan-stats-price');
                const splitInput = modal.querySelector('#plan-stats-housing-share');
                const densityInput = modal.querySelector('#plan-stats-area-per-inhabitant');
                [priceInput, splitInput, densityInput].forEach(input => {
                    if (!input) return;
                    input.removeEventListener('input', handleInputChange);
                    input.addEventListener('input', handleInputChange);
                });
            }
        } catch (err) {
            console.warn('Failed to compute plan stats', err);
        } finally {
            setPlanStatsButtonBusy(false);
        }
    }

    function handleInputChange() {
        const modal = document.getElementById('plan-stats-modal');
        if (modal && latestStats) {
            updateDerivedFields(modal, latestStats);
        }
    }

    function initializePlanStatsUi() {
        const button = document.getElementById('planStatsButton');
        if (button && !button.dataset.planStatsBound) {
            button.dataset.planStatsBound = '1';
            button.addEventListener('click', handlePlanStatsClick);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        initializePlanStatsUi();
        document.addEventListener('keydown', (evt) => {
            if (evt.key === 'Escape') {
                const modal = document.getElementById('plan-stats-modal');
                if (modal && modal.style.display === 'flex') {
                    hidePlanStatsModal();
                }
            }
        });
    });

    window.showPlanStatsModal = async function showPlanStatsModal() {
        setPlanStatsButtonBusy(true);
        try {
            const stats = latestStats || await computePlanStatsAsync();
            latestStats = stats;
            renderPlanStatsModal(stats);
        } finally {
            setPlanStatsButtonBusy(false);
        }
    };
})();
