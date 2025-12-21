(function () {
    const COLOR_PALETTE = [
        '#2E86AB', '#F18F01', '#C73E1D', '#137547', '#7A1CAC',
        '#CC3363', '#3D5A80', '#EE6C4D', '#5C946E', '#8A508F',
        '#FF7F11', '#1B998B', '#ED254E', '#3772FF', '#78290F'
    ];

    const state = {
        modal: null,
        map: null,
        baseLayer: null,
        previewLayer: null,
        boundaryLayer: null,
        legendListEl: null,
        statusEl: null,
        algorithm: 'sweep-line',
        selection: null,
        superParcel: null,
        totalArea: 0,
        ownerShares: [],
        slices: [],
        hasFitBounds: false,
        resizeHandler: null,
        escHandler: null,
        commitBtns: [],
        subtitleEl: null,
        subtitleData: null,
        ownershipMode: 'multiple',
        singleConfig: {
            lengthMode: 'full',
            parcelCount: 2,
            distributionMode: 'equal',
            manualShares: []
        },
        singleOwnerLabel: null,
        orientationHandles: [],
        orientationLine: null,
        orientationBorderLayer: null,
        parcelListEl: null,
        lengthModeRadios: [],
        parcelCountInput: null,
        parcelCountValueEl: null,
        totalParcelsEl: null,
        distributionRadios: [],
        manualSharesContainer: null
    };

    const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;

    function formatTemplate(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function t(key, fallback, params = {}) {
        if (i18nApi && typeof i18nApi.t === 'function') {
            return i18nApi.t(key, params);
        }
        return formatTemplate(fallback || '', params);
    }

    function applyTranslations(root) {
        try {
            if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
                i18nApi.applyTranslations(root);
            }
        } catch (_) { }
    }

    function hashToColorIndex(value) {
        if (!value) return 0;
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash) % COLOR_PALETTE.length;
    }

    function pickOwnerColor(ownerKey, index) {
        if (COLOR_PALETTE.length === 0) return '#888';
        const paletteIndex = ownerKey ? hashToColorIndex(ownerKey) : (index % COLOR_PALETTE.length);
        return COLOR_PALETTE[paletteIndex];
    }

    function formatPercent(value) {
        if (!isFinite(value) || value <= 0) {
            return '0%';
        }
        return `${(value * 100).toFixed(1)}%`;
    }

    function updateSubtitleWithOwners(ownerCount = 0) {
        if (!state.subtitleEl || !state.subtitleData) return;

        if (state.ownershipMode === 'single') {
            const targetParcels = state.singleConfig?.parcelCount || state.subtitleData.parcelCount || 0;
            const params = {
                count: targetParcels,
                suffix: targetParcels === 1 ? '' : 's'
            };
            const subtitleText = t(
                'reparcellization.modal.subtitleSingleOwner',
                '{{count}} parcel{{suffix}} · single owner',
                params
            );
            state.subtitleEl.textContent = subtitleText;
            try {
                state.subtitleEl.setAttribute('data-i18n-key', 'reparcellization.modal.subtitleSingleOwner');
                state.subtitleEl.setAttribute('data-i18n-params', JSON.stringify(params));
            } catch (_) {
                state.subtitleEl.removeAttribute('data-i18n-params');
            }
            return;
        }

        const parcelCount = state.subtitleData.parcelCount || 0;
        const algorithmLabel = state.subtitleData.algorithmLabel || '';
        const params = {
            algorithm: algorithmLabel,
            parcelCount,
            parcelSuffix: parcelCount === 1 ? '' : 's',
            ownerCount: ownerCount || 0,
            ownerSuffix: (ownerCount || 0) === 1 ? '' : 's'
        };
        const subtitleText = t(
            'reparcellization.modal.subtitleWithOwners',
            '{{algorithm}} · {{parcelCount}} parcel{{parcelSuffix}} · {{ownerCount}} owner{{ownerSuffix}}',
            params
        );
        state.subtitleEl.textContent = subtitleText;
        try {
            state.subtitleEl.setAttribute('data-i18n-key', 'reparcellization.modal.subtitleWithOwners');
            state.subtitleEl.setAttribute('data-i18n-params', JSON.stringify(params));
        } catch (_) {
            state.subtitleEl.removeAttribute('data-i18n-params');
        }
    }

    function computeResultingParcelCount() {
        if (Array.isArray(state.slices) && state.slices.length) {
            return state.slices.length;
        }
        const base = clampParcelCount(state.singleConfig?.parcelCount || 0);
        const hasOrientation = state.singleConfig?.lengthMode === 'split' && !!state.orientationLine;
        const multiplier = hasOrientation ? 2 : 1;
        return Math.max(0, base * multiplier);
    }

    function updateTotalParcelsLabel() {
        if (!state.totalParcelsEl) return;
        const total = computeResultingParcelCount();
        const text = t(
            'reparcellization.modal.single.totalParcelsLabel',
            'Total number of parcels: {{count}}',
            { count: total }
        );
        state.totalParcelsEl.textContent = text;
        state.totalParcelsEl.setAttribute('data-i18n-key', 'reparcellization.modal.single.totalParcelsLabel');
        try {
            state.totalParcelsEl.setAttribute('data-i18n-params', JSON.stringify({ count: total }));
        } catch (_) {
            state.totalParcelsEl.removeAttribute('data-i18n-params');
        }
    }

    function getAlgorithmOptions() {
        return [
            {
                key: 'sweep-line',
                label: t('reparcellization.modal.algorithms.sweepLine', 'Sweep line algorithm'),
                disabled: false
            },
            {
                key: 'centroidal-voronoi',
                label: t('reparcellization.modal.algorithms.centroidalVoronoi', 'Centroidal Voronoi'),
                disabled: true
            },
            {
                key: 'wasserstein',
                label: t('reparcellization.modal.algorithms.wasserstein', 'Wasserstein'),
                disabled: true
            },
            {
                key: 'manual',
                label: t('reparcellization.modal.algorithms.manual', 'Manual'),
                disabled: true
            }
        ];
    }

    function getAlgorithmOptionByKey(key) {
        return getAlgorithmOptions().find(option => option.key === key);
    }

    function buildAlgorithmRadios(selectedKey = 'sweep-line') {
        const options = getAlgorithmOptions();
        return options.map(option => {
            const checked = option.key === selectedKey ? 'checked' : '';
            const disabled = option.disabled ? 'disabled' : '';
            return `
                <label class="reparcel-alg-option">
                    <input type="radio" name="reparcel-algorithm" value="${option.key}" ${checked} ${disabled}>
                    <span>${option.label}</span>
                </label>`;
        }).join('');
    }

    function setStatus(message, type = 'info', i18nKey = null, params = null) {
        const hasInlineStatus = Boolean(state.statusEl);
        if (!hasInlineStatus) {
            if (message && (type === 'error' || type === 'warning')) {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(message, 4500, type === 'error' ? 'error' : 'warning');
                } else if (typeof updateStatus === 'function') {
                    updateStatus(message);
                }
            }
            return;
        }

        state.statusEl.textContent = message || '';
        state.statusEl.setAttribute('data-status-type', type);
        if (i18nKey) {
            state.statusEl.setAttribute('data-i18n-key', i18nKey);
            if (params && Object.keys(params).length) {
                try {
                    state.statusEl.setAttribute('data-i18n-params', JSON.stringify(params));
                } catch (_) {
                    state.statusEl.removeAttribute('data-i18n-params');
                }
            } else {
                state.statusEl.removeAttribute('data-i18n-params');
            }
        } else {
            state.statusEl.removeAttribute('data-i18n-key');
            state.statusEl.removeAttribute('data-i18n-params');
        }
    }

    function destroyMap() {
        if (state.orientationLine) {
            try { state.orientationLine.remove(); } catch (_) { }
            state.orientationLine = null;
        }
        if (Array.isArray(state.orientationHandles) && state.orientationHandles.length) {
            state.orientationHandles.forEach(marker => {
                try { marker.remove(); } catch (_) { }
            });
            state.orientationHandles = [];
        }
        if (state.previewLayer) {
            state.previewLayer.remove();
            state.previewLayer = null;
        }
        if (state.orientationBorderLayer) {
            state.orientationBorderLayer.remove();
            state.orientationBorderLayer = null;
        }
        if (state.boundaryLayer) {
            state.boundaryLayer.remove();
            state.boundaryLayer = null;
        }
        if (state.baseLayer) {
            state.baseLayer.remove();
            state.baseLayer = null;
        }
        if (state.map) {
            state.map.remove();
            state.map = null;
        }
        state.hasFitBounds = false;
    }

    function closeModal() {
        destroyMap();
        if (state.modal) {
            state.modal.remove();
            state.modal = null;
        }
        if (state.resizeHandler) {
            window.removeEventListener('resize', state.resizeHandler);
            state.resizeHandler = null;
        }
        if (state.escHandler) {
            window.removeEventListener('keydown', state.escHandler);
            state.escHandler = null;
        }
        if (typeof setProposalModalDimmed === 'function') {
            setProposalModalDimmed(false);
        }
        state.ownerShares = [];
        state.slices = [];
        state.selection = null;
        state.superParcel = null;
        state.totalArea = 0;
        state.singleOwnerLabel = null;
        state.commitBtns = [];
    }

    function buildModalStructure() {
        const overlay = document.createElement('div');
        overlay.className = 'reparcel-modal-overlay';
        const parcelCount = state.selection.ids.length;
        const algorithmOption = getAlgorithmOptionByKey(state.algorithm) || getAlgorithmOptionByKey('sweep-line');
        const algorithmLabel = algorithmOption ? algorithmOption.label : t('reparcellization.modal.algorithms.sweepLine', 'Sweep line algorithm');
        const subtitleParams = {
            algorithm: algorithmLabel,
            count: parcelCount,
            suffix: parcelCount === 1 ? '' : 's'
        };
        const titleText = t('reparcellization.modal.title', 'Reparcellization');
        const isSingleOwner = state.ownershipMode === 'single';
        const subtitleText = isSingleOwner
            ? t('reparcellization.modal.subtitleSingleOwner', '{{count}} parcel{{suffix}} · single owner', subtitleParams)
            : t('reparcellization.modal.subtitle', '{{algorithm}} · {{count}} parcel{{suffix}}', subtitleParams);
        const closeLabel = t('reparcellization.modal.closeAria', 'Close');
        const doneLabel = t('reparcellization.modal.done', 'Done');
        const legendLabel = t('reparcellization.modal.ownerLegend', 'Owner Legend');
        const algorithmTitle = t('reparcellization.modal.algorithmTitle', 'Reparcellization type');
        const parcelListTitle = t('reparcellization.modal.single.parcelListTitle', 'Selected parcels');
        const lengthLabel = t('reparcellization.modal.single.lengthLabel', 'Length');
        const lengthFullLabel = t('reparcellization.modal.single.length.full', 'Full');
        const lengthSplitLabel = t('reparcellization.modal.single.length.split', 'Split');
        const parcelCountLabel = t('reparcellization.modal.single.parcelCountLabel', 'Number of parcels');
        const totalParcelsLabel = t(
            'reparcellization.modal.single.totalParcelsLabel',
            'Total number of parcels: {{count}}',
            { count: computeResultingParcelCount() }
        );
        const distributionLabel = t('reparcellization.modal.single.distributionLabel', 'Distribution');
        const distributionOptions = {
            equal: t('reparcellization.modal.single.distribution.equal', 'Equal'),
            random: t('reparcellization.modal.single.distribution.random', 'Random'),
            manual: t('reparcellization.modal.single.distribution.manual', 'Manual')
        };
        const orientationHint = t('reparcellization.modal.single.orientationHint', 'Drag the line on the map to set the split direction.');

        const algorithmControls = isSingleOwner ? '' : `
                    <div class="reparcel-controls" data-reparcel-alg-group>
                        <p class="reparcel-controls__title" data-i18n-key="reparcellization.modal.algorithmTitle">${algorithmTitle}</p>
                        <div class="reparcel-alg-options">${buildAlgorithmRadios(state.algorithm)}</div>
                    </div>`;

        const sidePanel = isSingleOwner
            ? `<section class="reparcel-single-panel">
                            <div class="single-owner-block">
                                <h3 data-i18n-key="reparcellization.modal.single.parcelListTitle">${parcelListTitle}</h3>
                                <div class="single-owner-parcel-list" data-reparcel-parcel-list></div>
                            </div>
                            <div class="single-owner-block">
                                <p data-i18n-key="reparcellization.modal.single.lengthLabel">${lengthLabel}</p>
                                <div class="single-owner-radio-group" data-length-mode-group role="radiogroup" aria-label="${lengthLabel}">
                                    <label class="single-owner-radio">
                                        <input type="radio" name="reparcel-length-mode" value="full" ${state.singleConfig.lengthMode === 'split' ? '' : 'checked'} data-length-mode-option>
                                        <span data-i18n-key="reparcellization.modal.single.length.full">${lengthFullLabel}</span>
                                    </label>
                                    <label class="single-owner-radio">
                                        <input type="radio" name="reparcel-length-mode" value="split" ${state.singleConfig.lengthMode === 'split' ? 'checked' : ''} data-length-mode-option>
                                        <span data-i18n-key="reparcellization.modal.single.length.split">${lengthSplitLabel}</span>
                                    </label>
                                </div>
                            </div>
                            <div class="single-owner-block">
                                <label for="reparcel-parcel-count" data-i18n-key="reparcellization.modal.single.parcelCountLabel">${parcelCountLabel}</label>
                                <div class="single-owner-slider">
                                    <input type="range" id="reparcel-parcel-count" data-parcel-count min="2" max="20" step="1" value="${state.singleConfig.parcelCount || 2}" aria-valuemin="2" aria-valuemax="20" aria-valuenow="${state.singleConfig.parcelCount || 2}">
                                    <span class="single-owner-slider__value" data-parcel-count-value>${state.singleConfig.parcelCount || 2}</span>
                                </div>
                                <p class="single-owner-total" data-total-parcels data-i18n-key="reparcellization.modal.single.totalParcelsLabel" data-i18n-params='${JSON.stringify({ count: computeResultingParcelCount() })}'>${totalParcelsLabel}</p>
                            </div>
                            <div class="single-owner-block">
                                <p data-i18n-key="reparcellization.modal.single.distributionLabel">${distributionLabel}</p>
                                <div class="single-owner-radio-group" data-distribution-group role="radiogroup" aria-label="${distributionLabel}">
                                    <label class="single-owner-radio">
                                        <input type="radio" name="reparcel-distribution" value="equal" ${state.singleConfig.distributionMode === 'equal' ? 'checked' : ''} data-distribution-option>
                                        <span data-i18n-key="reparcellization.modal.single.distribution.equal">${distributionOptions.equal}</span>
                                    </label>
                                    <label class="single-owner-radio">
                                        <input type="radio" name="reparcel-distribution" value="random" ${state.singleConfig.distributionMode === 'random' ? 'checked' : ''} data-distribution-option>
                                        <span data-i18n-key="reparcellization.modal.single.distribution.random">${distributionOptions.random}</span>
                                    </label>
                                    <label class="single-owner-radio">
                                        <input type="radio" name="reparcel-distribution" value="manual" ${state.singleConfig.distributionMode === 'manual' ? 'checked' : ''} data-distribution-option>
                                        <span data-i18n-key="reparcellization.modal.single.distribution.manual">${distributionOptions.manual}</span>
                                    </label>
                                </div>
                                <div class="single-owner-manual" data-manual-share-container></div>
                            </div>
                            <p class="single-owner-hint" data-i18n-key="reparcellization.modal.single.orientationHint">${orientationHint}</p>
                            <div class="reparcel-status" data-reparcel-status></div>
                        </section>`
            : `<section class="reparcel-legend-panel">
                            <div class="reparcel-legend-header">
                                <h3 data-i18n-key="reparcellization.modal.ownerLegend">${legendLabel}</h3>
                            </div>
                            <div class="reparcel-legend-list"></div>
                        </section>`;
        overlay.innerHTML = `
            <div class="reparcel-modal" role="dialog" aria-modal="true">
                <div class="reparcel-header">
                    <div class="reparcel-header__text">
                        <h2 data-i18n-key="reparcellization.modal.title">${titleText}</h2>
                        <p class="reparcel-subtitle" data-i18n-key="${isSingleOwner ? 'reparcellization.modal.subtitleSingleOwner' : 'reparcellization.modal.subtitle'}" data-i18n-params='${JSON.stringify(subtitleParams)}'>${subtitleText}</p>
                    </div>
                    <button type="button" class="reparcel-close-btn close-circle-btn close-circle-btn--lg" data-i18n-key="reparcellization.modal.closeAria" data-i18n-attr="aria-label" aria-label="${closeLabel}">&times;</button>
                </div>
                <div class="reparcel-content">
                    ${algorithmControls}
                    <div class="reparcel-layout${isSingleOwner ? ' reparcel-layout--single' : ''}">
                        <section class="reparcel-map-panel">
                            <div id="reparcel-map" class="reparcel-map" aria-live="polite"></div>
                        </section>
                        ${sidePanel}
                        <div class="reparcel-actions">
                            <button type="button" class="btn btn-proposal" data-reparcel-commit disabled data-i18n-key="reparcellization.modal.done" data-i18n-attr="text">${doneLabel}</button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        state.modal = overlay;
        state.legendListEl = isSingleOwner ? null : overlay.querySelector('.reparcel-legend-list');
        state.parcelListEl = isSingleOwner ? overlay.querySelector('[data-reparcel-parcel-list]') : null;
        state.lengthModeRadios = isSingleOwner ? Array.from(overlay.querySelectorAll('input[name="reparcel-length-mode"]')) : [];
        state.parcelCountInput = overlay.querySelector('[data-parcel-count]');
        state.parcelCountValueEl = isSingleOwner ? overlay.querySelector('[data-parcel-count-value]') : null;
        state.totalParcelsEl = overlay.querySelector('[data-total-parcels]');
        state.distributionRadios = isSingleOwner ? Array.from(overlay.querySelectorAll('input[name="reparcel-distribution"]')) : [];
        state.manualSharesContainer = overlay.querySelector('[data-manual-share-container]');
        state.subtitleEl = overlay.querySelector('.reparcel-subtitle');
        state.subtitleData = isSingleOwner
            ? { parcelCount }
            : { algorithmLabel: subtitleParams.algorithm, parcelCount };
        state.statusEl = overlay.querySelector('[data-reparcel-status]');

        const closeBtn = overlay.querySelector('.reparcel-close-btn');
        const commitBtns = Array.from(overlay.querySelectorAll('[data-reparcel-commit]'));
        state.commitBtns = commitBtns;

        closeBtn.addEventListener('click', closeModal);
        commitBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                persistResult();
                ensureProposalDefaults();
                closeModal();
                if (typeof showEphemeralMessage === 'function') {
                    let savedMessage = t(
                        'status.messages.saved_reparcellization_layout_to_the_proposal',
                        'Saved reparcellization layout for this proposal.'
                    );
                    if (savedMessage === 'status.messages.saved_reparcellization_layout_to_the_proposal') {
                        savedMessage = 'Saved reparcellization layout for this proposal.';
                    }
                    showEphemeralMessage(savedMessage, 4000, 'success');
                }
            });
        });

        updateTotalParcelsLabel();

        state.resizeHandler = () => {
            if (state.map) {
                state.map.invalidateSize();
            }
        };
        window.addEventListener('resize', state.resizeHandler);

        state.escHandler = (event) => {
            if (event.key === 'Escape') {
                closeModal();
            }
        };
        window.addEventListener('keydown', state.escHandler);

        const algorithmGroupEl = overlay.querySelector('[data-reparcel-alg-group]');
        if (algorithmGroupEl) {
            algorithmGroupEl.addEventListener('change', (event) => {
                const target = event.target;
                if (!target || target.name !== 'reparcel-algorithm') return;
                const option = getAlgorithmOptionByKey(target.value);
                if (!option || option.disabled) return;
                state.algorithm = option.key;
                state.subtitleData.algorithmLabel = option.label;
                updateSubtitleWithOwners(state.ownerShares.length);
                refreshPreview();
            });
        }

        if (isSingleOwner) {
            initializeSingleOwnerControls();
            renderSingleOwnerParcelList();
        }

        if (typeof setProposalModalDimmed === 'function') {
            setProposalModalDimmed(true);
        }

        applyTranslations(overlay);

        return overlay;
    }

    function initMap() {
        const mapContainer = state.modal.querySelector('#reparcel-map');
        const map = L.map(mapContainer, {
            zoomControl: false,
            attributionControl: false
        });
        const baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 22,
            minZoom: 3
        });
        baseLayer.addTo(map);
        state.baseLayer = baseLayer;
        state.map = map;
        if (state.ownershipMode === 'single') {
            initOrientationGuides();
        }
        setTimeout(() => map.invalidateSize(), 150);
    }

    function updateLegend(ownerShares) {
        if (!state.legendListEl) return;
        state.legendListEl.innerHTML = '';
        ownerShares.forEach((entry, index) => {
            const color = entry.color || pickOwnerColor(entry.ownerKey, index);
            entry.color = color;
            const row = document.createElement('div');
            row.className = 'reparcel-legend-item';
            const parcelCount = entry.parcelIds.length;
            const metaParams = {
                percent: formatPercent(entry.percent),
                count: parcelCount,
                suffix: parcelCount === 1 ? '' : 's'
            };
            const metaText = t(
                'reparcellization.modal.legendMeta',
                '{{percent}} · {{count}} parcel{{suffix}}',
                metaParams
            );
            row.innerHTML = `
                <span class="legend-color" style="background:${color}"></span>
                <div class="legend-text">
                    <div class="legend-name">${entry.displayName}</div>
                    <div class="legend-meta" data-i18n-key="reparcellization.modal.legendMeta" data-i18n-params='${JSON.stringify(metaParams)}'>${metaText}</div>
                </div>`;
            state.legendListEl.appendChild(row);
        });
        applyTranslations(state.legendListEl);
    }

    function clampParcelCount(value) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return 2;
        return Math.min(20, Math.max(2, parsed));
    }

    function renderSingleOwnerParcelList() {
        if (!state.parcelListEl) return;
        const layers = (state.selection && Array.isArray(state.selection.layers)) ? state.selection.layers : [];
        const parcelLabel = t('reparcellization.modal.single.parcelLabel', 'Parcel');
        const totalArea = state.totalArea || computeFeatureArea(state.superParcel) || 0;
        const rows = layers.map((layer, index) => {
            const feature = layer?.feature;
            const props = feature?.properties || {};
            const parcelId = props.parcelId || props.parcel_id || props.id || index + 1;
            return `<div class="single-parcel-row"><span>${parcelLabel} ${parcelId}</span></div>`;
        });
        const summaryRow = `<div class="single-parcel-row total"><span>${t('reparcellization.modal.single.superParcelLabel', 'Superparcel area')}</span><span> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</span></div>`;
        state.parcelListEl.innerHTML = rows.length
            ? [summaryRow, ...rows].join('')
            : `<div class="single-parcel-row empty">${t('reparcellization.modal.single.noParcels', 'No parcels selected')}</div>`;
        applyTranslations(state.parcelListEl);
    }

    function rebuildManualShareInputs(countOverride = null) {
        if (!state.manualSharesContainer) return;
        const isManual = state.singleConfig.distributionMode === 'manual';
        state.manualSharesContainer.style.display = isManual ? '' : 'none';
        if (!isManual) return;

        const count = clampParcelCount(countOverride !== null ? countOverride : state.singleConfig.parcelCount || 2);
        if (!Array.isArray(state.singleConfig.manualShares) || state.singleConfig.manualShares.length !== count) {
            state.singleConfig.manualShares = Array(count).fill(Math.round(100 / count));
        }
        const shares = state.singleConfig.manualShares.slice(0, count);
        state.manualSharesContainer.innerHTML = shares.map((value, index) => `
            <div class="manual-share-row">
                <label>${t('reparcellization.modal.single.lotLabel', 'Parcel {{index}}', { index: index + 1 })}</label>
                <div class="manual-share-input">
                    <input type="number" min="0" max="100" step="1" data-manual-share-index="${index}" value="${value}" aria-label="${t('reparcellization.modal.single.lotShareAria', 'Share for parcel {{index}}', { index: index + 1 })}">
                    <span>%</span>
                </div>
            </div>`).join('');

        const inputs = state.manualSharesContainer.querySelectorAll('input[data-manual-share-index]');
        inputs.forEach(input => {
            input.addEventListener('input', () => {
                const idx = parseInt(input.getAttribute('data-manual-share-index'), 10);
                const val = Number(input.value);
                state.singleConfig.manualShares[idx] = Number.isFinite(val) ? Math.max(0, val) : 0;
                refreshSingleOwnerPreview();
            });
        });
    }

    function initializeSingleOwnerControls() {
        if (Array.isArray(state.lengthModeRadios) && state.lengthModeRadios.length) {
            state.lengthModeRadios.forEach(radio => {
                radio.checked = radio.value === state.singleConfig.lengthMode;
                radio.addEventListener('change', () => {
                    if (!radio.checked) return;
                    state.singleConfig.lengthMode = radio.value || 'full';
                    updateTotalParcelsLabel();
                    refreshSingleOwnerPreview();
                });
            });
        }

        if (state.parcelCountInput) {
            const setParcelCountValue = (value) => {
                if (state.parcelCountValueEl) {
                    state.parcelCountValueEl.textContent = value;
                }
                state.parcelCountInput.setAttribute('aria-valuenow', value);
            };

            const clamped = clampParcelCount(state.singleConfig.parcelCount);
            state.singleConfig.parcelCount = clamped;
            state.parcelCountInput.value = clamped;
            setParcelCountValue(clamped);
            state.parcelCountInput.addEventListener('input', () => {
                const next = clampParcelCount(state.parcelCountInput.value);
                state.singleConfig.parcelCount = next;
                state.parcelCountInput.value = next;
                setParcelCountValue(next);
                rebuildManualShareInputs(next);
                updateSubtitleWithOwners(state.ownerShares.length);
                updateTotalParcelsLabel();
                refreshSingleOwnerPreview();
            });
        }

        if (Array.isArray(state.distributionRadios) && state.distributionRadios.length) {
            state.distributionRadios.forEach(radio => {
                radio.checked = radio.value === state.singleConfig.distributionMode;
                radio.addEventListener('change', () => {
                    if (!radio.checked) return;
                    state.singleConfig.distributionMode = radio.value || 'equal';
                    rebuildManualShareInputs();
                    refreshSingleOwnerPreview();
                });
            });
        }

        rebuildManualShareInputs();
        updateTotalParcelsLabel();
    }

    function getOrientationLineLatLngs() {
        if (!Array.isArray(state.orientationHandles) || state.orientationHandles.length !== 2) return null;
        return state.orientationHandles.map(marker => marker.getLatLng());
    }

    function getOrientationAngleDeg() {
        const coords = getOrientationLineLatLngs();
        if (!coords) return 0;
        const [start, end] = coords;
        return Math.atan2(end.lat - start.lat, end.lng - start.lng) * (180 / Math.PI);
    }

    function computeRingCentroidAndAreaXY(ringXY) {
        if (!Array.isArray(ringXY) || ringXY.length < 3) {
            return { area: 0, centroid: null };
        }

        const pts = ringXY.slice();
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
            pts.push([first[0], first[1]]);
        }

        let twiceArea = 0;
        let cxTimes6A = 0;
        let cyTimes6A = 0;

        for (let i = 0; i < pts.length - 1; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[i + 1];
            const cross = x0 * y1 - x1 * y0;
            twiceArea += cross;
            cxTimes6A += (x0 + x1) * cross;
            cyTimes6A += (y0 + y1) * cross;
        }

        const areaSigned = twiceArea / 2;
        if (!areaSigned || !Number.isFinite(areaSigned)) {
            const sum = pts.reduce((acc, p) => ({ x: acc.x + p[0], y: acc.y + p[1] }), { x: 0, y: 0 });
            const denom = pts.length || 1;
            return { area: 0, centroid: [sum.x / denom, sum.y / denom] };
        }

        const cx = cxTimes6A / (6 * areaSigned);
        const cy = cyTimes6A / (6 * areaSigned);
        return { area: areaSigned, centroid: [cx, cy] };
    }

    function getSuperParcelCentroidLngLat(feature) {
        if (!feature || !feature.geometry) return null;

        // Prefer a centroid computed in Leaflet's projected space to match what the user sees.
        if (state.map && typeof state.map.project === 'function' && typeof state.map.unproject === 'function') {
            try {
                const zoom = state.map.getZoom();
                const geometry = feature.geometry;

                const accumulatePolygon = (ringsLngLat) => {
                    if (!Array.isArray(ringsLngLat) || !ringsLngLat.length) return { wArea: 0, wCx: 0, wCy: 0 };

                    // Outer ring contributes positively; holes subtract.
                    let wArea = 0;
                    let wCx = 0;
                    let wCy = 0;

                    for (let ringIndex = 0; ringIndex < ringsLngLat.length; ringIndex++) {
                        const ring = ringsLngLat[ringIndex];
                        if (!Array.isArray(ring) || ring.length < 3) continue;
                        const ringXY = ring.map(([lng, lat]) => {
                            const p = state.map.project(L.latLng(lat, lng), zoom);
                            return [p.x, p.y];
                        });
                        const { area, centroid } = computeRingCentroidAndAreaXY(ringXY);
                        if (!centroid) continue;

                        const areaAbs = Math.abs(area);
                        if (!areaAbs || !Number.isFinite(areaAbs)) continue;
                        const sign = ringIndex === 0 ? 1 : -1;
                        wArea += sign * areaAbs;
                        wCx += sign * areaAbs * centroid[0];
                        wCy += sign * areaAbs * centroid[1];
                    }

                    return { wArea, wCx, wCy };
                };

                let totalArea = 0;
                let totalCx = 0;
                let totalCy = 0;

                if (geometry.type === 'Polygon') {
                    const { wArea, wCx, wCy } = accumulatePolygon(geometry.coordinates);
                    totalArea += wArea;
                    totalCx += wCx;
                    totalCy += wCy;
                } else if (geometry.type === 'MultiPolygon') {
                    geometry.coordinates.forEach(poly => {
                        const { wArea, wCx, wCy } = accumulatePolygon(poly);
                        totalArea += wArea;
                        totalCx += wCx;
                        totalCy += wCy;
                    });
                }

                if (totalArea && Number.isFinite(totalArea) && totalArea !== 0) {
                    const cx = totalCx / totalArea;
                    const cy = totalCy / totalArea;
                    if (Number.isFinite(cx) && Number.isFinite(cy)) {
                        const latlng = state.map.unproject(L.point(cx, cy), zoom);
                        if (latlng && Number.isFinite(latlng.lng) && Number.isFinite(latlng.lat)) {
                            return [latlng.lng, latlng.lat];
                        }
                    }
                }
            } catch (err) {
                console.warn('Failed to compute projected centroid; falling back to turf', err);
            }
        }

        if (typeof turf !== 'undefined') {
            try {
                const centroidFeature = turf.centroid(feature);
                const centroid = centroidFeature?.geometry?.coordinates;
                if (centroid && Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])) return centroid;
            } catch (_) {
                // fall through
            }
        }
        return null;
    }

    function computeDefaultOrientationLine() {
        if (typeof turf === 'undefined' || !state.superParcel) {
            return [L.latLng(0, 0), L.latLng(0.0005, 0.001)];
        }
        try {
            // Use the same centroid implementation as the split line, so the line passes through
            // the exact screen-space center the user expects.
            const centroid = getSuperParcelCentroidLngLat(state.superParcel);
            if (!centroid || !Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) {
                return [L.latLng(0, 0), L.latLng(0.0005, 0.001)];
            }
            // centroid is [lng, lat] in GeoJSON order
            const centerLng = centroid[0];
            const centerLat = centroid[1];

            const bbox = turf.bbox(state.superParcel);
            const spanX = Math.max(bbox[2] - bbox[0], 0.0005);
            const handleOffset = spanX * 0.35; // distance from centroid to each handle

            // Horizontal line through the centroid
            const start = L.latLng(centerLat, centerLng - handleOffset);
            const end = L.latLng(centerLat, centerLng + handleOffset);
            return [start, end];
        } catch (error) {
            console.warn('Failed to compute default orientation line', error);
            return [L.latLng(0, 0), L.latLng(0.0005, 0.001)];
        }
    }

    function handleOrientationDrag() {
        const coords = getOrientationLineLatLngs();
        if (coords && state.orientationLine) {
            state.orientationLine.setLatLngs(coords);
        }
        refreshSingleOwnerPreview();
    }

    function initOrientationGuides() {
        if (!state.map || state.ownershipMode !== 'single') return;
        const coords = computeDefaultOrientationLine();
        const handles = coords.map(pt => L.marker(pt, {
            draggable: true,
            opacity: 0.9,
            riseOnHover: true,
            keyboard: false
        }));
        handles.forEach(marker => marker.on('drag', handleOrientationDrag));
        state.orientationHandles = handles;
        state.orientationLine = L.polyline(coords, { color: '#111', weight: 2, dashArray: '6 4' }).addTo(state.map);
        handles.forEach(marker => marker.addTo(state.map));
    }

    function buildOrientationLineFeature() {
        if (!state.superParcel) return null;

        // Always build a line through the centroid at the angle defined by the handles
        const centroid = getSuperParcelCentroidLngLat(state.superParcel);
        if (!centroid || !Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) {
            return null;
        }

        const angleDeg = getOrientationAngleDeg();
        const bbox = turf.bbox(state.superParcel);
        const spanX = bbox[2] - bbox[0];
        const spanY = bbox[3] - bbox[1];
        const span = Math.max(spanX, spanY);
        if (!span || !isFinite(span)) return null;

        const length = span * 4;
        const angleRad = angleDeg * (Math.PI / 180);
        const dx = Math.cos(angleRad) * length;
        const dy = Math.sin(angleRad) * length;
        try {
            return turf.lineString([
                [centroid[0] - dx, centroid[1] - dy],
                [centroid[0] + dx, centroid[1] + dy]
            ]);
        } catch (error) {
            console.warn('Failed to build orientation line feature', error);
            return null;
        }
    }

    /**
     * Split a polygon with a line into two halves.
     * turf.lineSplit splits LineStrings, not polygons, so we use half-plane intersection.
     */
    function splitPolygonWithLine(polygon, line) {
        if (!polygon || !line) return null;
        try {
            const lineCoords = line.geometry.coordinates;
            if (!lineCoords || lineCoords.length < 2) return null;
            const [lineStart, lineEnd] = [lineCoords[0], lineCoords[lineCoords.length - 1]];

            const ringCoords = getPolygonCoordinates(polygon);
            if (!ringCoords || ringCoords.length < 4) return null;

            // Build the two result polygons by walking the boundary and splitting at intersection points
            const ring = ringCoords.slice(0, -1); // Remove closing vertex (we'll close manually)
            const n = ring.length;

            // Find all intersection points with their edge indices
            const intersections = [];
            for (let i = 0; i < n; i++) {
                const p1 = ring[i];
                const p2 = ring[(i + 1) % n];

                const ix = lineSegmentIntersection(p1, p2, lineStart, lineEnd);
                if (ix) {
                    intersections.push({ point: ix, edgeIndex: i, t: ix.t });
                }
            }

            if (intersections.length < 2) {
                // Line doesn't properly split the polygon
                return null;
            }

            // Sort intersections by edge index, then by t parameter
            intersections.sort((a, b) => {
                if (a.edgeIndex !== b.edgeIndex) return a.edgeIndex - b.edgeIndex;
                return a.t - b.t;
            });

            // Take the first two intersection points (entry and exit)
            const int1 = intersections[0];
            const int2 = intersections[1];

            // EXACT shared boundary points - these will be used in BOTH polygons
            const sharedPoint1 = [int1.point.x, int1.point.y];
            const sharedPoint2 = [int2.point.x, int2.point.y];

            // Build two polygons by walking the ring
            const poly1Coords = [];
            const poly2Coords = [];

            // Walk from int1 to int2 (one direction)
            poly1Coords.push(sharedPoint1);
            let idx = (int1.edgeIndex + 1) % n;
            while (idx !== (int2.edgeIndex + 1) % n) {
                poly1Coords.push([ring[idx][0], ring[idx][1]]);
                idx = (idx + 1) % n;
            }
            poly1Coords.push(sharedPoint2);
            poly1Coords.push(sharedPoint1); // Close the ring

            // Walk from int2 to int1 (other direction)
            poly2Coords.push(sharedPoint2);
            idx = (int2.edgeIndex + 1) % n;
            while (idx !== (int1.edgeIndex + 1) % n) {
                poly2Coords.push([ring[idx][0], ring[idx][1]]);
                idx = (idx + 1) % n;
            }
            poly2Coords.push(sharedPoint1);
            poly2Coords.push(sharedPoint2); // Close the ring

            const results = [];
            if (poly1Coords.length >= 4) {
                const f1 = turf.polygon([poly1Coords]);
                if (computeFeatureArea(f1) > 0) results.push(f1);
            }
            if (poly2Coords.length >= 4) {
                const f2 = turf.polygon([poly2Coords]);
                if (computeFeatureArea(f2) > 0) results.push(f2);
            }

            return results.length >= 2 ? results : null;
        } catch (err) {
            console.warn('splitPolygonWithLine failed', err);
            return null;
        }
    }

    // Helper: find intersection point of two line segments
    function lineSegmentIntersection(p1, p2, p3, p4) {
        const x1 = p1[0], y1 = p1[1];
        const x2 = p2[0], y2 = p2[1];
        const x3 = p3[0], y3 = p3[1];
        const x4 = p4[0], y4 = p4[1];

        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-14) return null;

        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

        // t must be in [0,1] for segment p1-p2, u can be anywhere for an infinite line
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            return {
                x: x1 + t * (x2 - x1),
                y: y1 + t * (y2 - y1),
                t: t
            };
        }
        return null;
    }

    function ensureProposalDefaults() {
        if (typeof setProposalMainType === 'function') {
            setProposalMainType('Reparcellization', { skipReparcelLaunch: true });
        }
        if (typeof setProposalType === 'function') {
            setProposalType('Reparcellization');
        }
        if (typeof updateProposalDescription === 'function') {
            updateProposalDescription('Reparcellization', true);
        }
        const descriptionInput = document.getElementById('proposalDescription');
        if (descriptionInput) {
            const label = (typeof formatParcelSelectionLabel === 'function' && state.selection?.ids)
                ? formatParcelSelectionLabel(state.selection.ids)
                : t('reparcellization.modal.selectedParcelsLabel', 'selected parcels');
            descriptionInput.value = t('reparcellization.modal.defaultDescription', 'Reparcellization proposal for {{label}}', { label });
        }
    }

    function drawPreview() {
        if (!state.map) return;
        if (state.previewLayer) {
            state.previewLayer.remove();
            state.previewLayer = null;
        }
        if (state.boundaryLayer) {
            state.boundaryLayer.remove();
            state.boundaryLayer = null;
        }

        if (state.slices.length) {
            const collection = {
                type: 'FeatureCollection',
                features: state.slices.map(slice => ({
                    type: 'Feature',
                    properties: {
                        ownerKey: slice.ownerKey,
                        color: slice.color,
                        displayName: slice.displayName,
                        percent: slice.percent
                    },
                    geometry: slice.geometry
                }))
            };
            state.previewLayer = L.geoJSON(collection, {
                style: feature => ({
                    color: '#333',
                    weight: 1,
                    fillOpacity: 0.55,
                    fillColor: feature.properties?.color || '#888'
                })
            }).addTo(state.map);
        }

        state.boundaryLayer = L.geoJSON(state.superParcel, {
            style: {
                color: '#111',
                weight: 2,
                fillOpacity: 0
            }
        }).addTo(state.map);

        if (state.orientationBorderLayer) {
            state.orientationBorderLayer.remove();
            state.orientationBorderLayer = null;
        }
        if (state.ownershipMode === 'single' && state.singleConfig.lengthMode === 'split') {
            const orientationFeature = buildOrientationLineFeature();
            if (orientationFeature) {
                state.orientationBorderLayer = L.geoJSON(orientationFeature, {
                    style: {
                        color: '#111',
                        weight: 3,
                        opacity: 0.8
                    }
                }).addTo(state.map);
            }
        }

        if (!state.hasFitBounds && state.boundaryLayer) {
            try {
                state.map.fitBounds(state.boundaryLayer.getBounds(), { padding: [20, 20] });
                state.hasFitBounds = true;
            } catch (err) {
                console.warn('Failed to fit bounds for reparcellization preview', err);
            }
        }
    }

    function persistResult() {
        if (!state.slices.length) return;
        const payload = {
            algorithm: state.algorithm,
            generatedAt: new Date().toISOString(),
            parcelIds: state.selection.ids.slice(),
            totalArea: state.totalArea,
            isSingleOwner: state.ownershipMode === 'single',
            ownerShares: state.ownerShares.map(entry => ({
                ownerKey: entry.ownerKey,
                displayName: entry.displayName,
                percent: entry.percent,
                color: entry.color,
                parcelIds: entry.parcelIds.slice()
            })),
            polygons: state.slices.map(slice => ({
                ownerKey: slice.ownerKey,
                displayName: slice.displayName,
                percent: slice.percent,
                color: slice.color,
                geometry: slice.geometry
            }))
        };
        window.pendingReparcellizationPlan = payload;
        if (state.commitBtns && state.commitBtns.length) {
            state.commitBtns.forEach(btn => { btn.disabled = false; });
        }
    }

    function ensureCommitAvailability(canCommit) {
        if (state.commitBtns && state.commitBtns.length) {
            state.commitBtns.forEach(btn => { btn.disabled = !canCommit; });
        }
    }

    function computeFeatureArea(feature) {
        if (typeof turf === 'undefined' || !feature) return 0;
        try {
            return turf.area(feature);
        } catch (error) {
            console.warn('Failed to compute feature area', error);
            return 0;
        }
    }

    function parseShareValue(rawValue) {
        if (!rawValue && rawValue !== 0) return NaN;
        const value = String(rawValue).trim();
        if (!value) return NaN;
        const percentMatch = value.match(/^(\d+(?:\.\d+)?)\s*%$/);
        if (percentMatch) {
            const pct = parseFloat(percentMatch[1]);
            return Number.isFinite(pct) ? pct / 100 : NaN;
        }
        const fractionMatch = value.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (fractionMatch) {
            const numerator = parseFloat(fractionMatch[1]);
            const denominator = parseFloat(fractionMatch[2]);
            if (denominator === 0) return NaN;
            return numerator / denominator;
        }
        const asNumber = parseFloat(value);
        if (Number.isFinite(asNumber)) {
            if (asNumber > 1) {
                return asNumber;
            }
            if (asNumber >= 0 && asNumber <= 1) {
                return asNumber;
            }
        }
        return NaN;
    }

    function normalizeOwnerSlots(slots) {
        if (!Array.isArray(slots) || !slots.length) return [];
        const parsed = slots.map(slot => {
            const fromText = parseShareValue(slot.shareText);
            const fromDetail = parseShareValue(slot.shareDetail);
            let value = Number.isFinite(fromDetail) ? fromDetail : fromText;
            if (!Number.isFinite(value) || value <= 0) {
                value = 0;
            }
            return { slot, value };
        });
        let total = parsed.reduce((sum, entry) => sum + entry.value, 0);
        if (total <= 0) {
            const equalShare = 1 / parsed.length;
            return parsed.map(entry => ({ slot: entry.slot, fraction: equalShare }));
        }
        return parsed.map(entry => ({ slot: entry.slot, fraction: entry.value / total }));
    }

    async function resolveSingleOwnerLabel(selection) {
        if (!selection || !Array.isArray(selection.layers) || !selection.layers.length) {
            return null;
        }
        if (typeof ensureParcelOwnerSlots !== 'function') {
            return null;
        }

        const firstFeature = selection.layers[0]?.feature;
        const props = firstFeature?.properties || {};
        const parcelId = props.parcelId || props.parcel_id || props.id;
        if (!parcelId) return null;

        try {
            const slots = await ensureParcelOwnerSlots(parcelId);
            if (!Array.isArray(slots) || !slots.length) return null;
            const chosen = slots.find(slot => slot?.displayName) || slots[0];
            return chosen?.displayName || null;
        } catch (error) {
            console.warn('Failed to resolve single-owner label for parcel', parcelId, error);
            return null;
        }
    }

    async function buildOwnerShares(selection) {
        const result = new Map();
        const parcelLayers = selection.layers || [];
        let totalArea = 0;

        for (const layer of parcelLayers) {
            const feature = layer?.feature;
            if (!feature || !feature.properties) continue;
            const parcelId = feature.properties.parcelId;
            const area = Number(feature.properties.calculatedArea) || computeFeatureArea(feature);
            if (!area || !Number.isFinite(area)) continue;

            totalArea += area;

            let slots = [];
            if (typeof ensureParcelOwnerSlots === 'function') {
                try {
                    slots = await ensureParcelOwnerSlots(parcelId);
                } catch (error) {
                    console.warn('Failed to fetch owner slots for parcel', parcelId, error);
                }
            }
            if (!Array.isArray(slots) || !slots.length) {
                slots = [{
                    key: `parcel:${parcelId}:synthetic-owner`,
                    displayName: t(
                        'reparcellization.modal.syntheticOwner',
                        'Owner of {{parcel}}',
                        { parcel: feature.properties.BROJ_CESTICE || parcelId }
                    ),
                    shareText: '1/1'
                }];
            }

            const normalizedSlots = normalizeOwnerSlots(slots);
            normalizedSlots.forEach(({ slot, fraction }) => {
                const ownerKey = slot.key || `${parcelId}:${slot.displayName}`;
                const existing = result.get(ownerKey) || {
                    ownerKey,
                    displayName: slot.displayName || 'Owner',
                    parcelIds: new Set(),
                    totalArea: 0
                };
                existing.totalArea += area * fraction;
                if (parcelId) existing.parcelIds.add(parcelId);
                result.set(ownerKey, existing);
            });
        }

        if (!totalArea) {
            return [];
        }

        return Array.from(result.values()).map((entry, index) => ({
            ownerKey: entry.ownerKey,
            displayName: entry.displayName,
            parcelIds: Array.from(entry.parcelIds),
            area: entry.totalArea,
            percent: entry.totalArea / totalArea,
            color: pickOwnerColor(entry.ownerKey, index)
        })).filter(entry => entry.percent > 0).sort((a, b) => b.percent - a.percent);
    }

    function buildSlicePolygon(minLng, maxLng, minLat, maxLat, cutLng) {
        if (!isFinite(cutLng) || cutLng <= minLng) return null;
        const epsilon = 1e-6;
        const constrainedCut = Math.min(Math.max(cutLng, minLng + epsilon), maxLng - epsilon);
        const latMargin = Math.max((maxLat - minLat) * 0.05, 0.0005);
        const coords = [
            [minLng, minLat - latMargin],
            [constrainedCut, minLat - latMargin],
            [constrainedCut, maxLat + latMargin],
            [minLng, maxLat + latMargin],
            [minLng, minLat - latMargin]
        ];
        return turf.polygon([coords]);
    }

    function buildPerpendicularBand(startX, endX, nearY, farY) {
        if (!isFinite(startX) || !isFinite(endX) || !isFinite(nearY) || !isFinite(farY)) {
            return null;
        }
        if (endX <= startX) return null;
        const coords = [
            [startX, nearY],
            [endX, nearY],
            [endX, farY],
            [startX, farY],
            [startX, nearY]
        ];
        try {
            return turf.polygon([coords]);
        } catch (error) {
            console.warn('Failed to build perpendicular band', error);
            return null;
        }
    }

    function safeIntersect(featureA, featureB) {
        try {
            return turf.intersect(featureA, featureB);
        } catch (error) {
            console.warn('safeIntersect failed during reparcellization', error);
            return null;
        }
    }

    function safeDifference(featureA, featureB) {
        try {
            return turf.difference(featureA, featureB);
        } catch (error) {
            console.warn('safeDifference failed during reparcellization', error);
            return null;
        }
    }

    /**
     * Slice a polygon into N adjacent pieces along the X axis using vertical cut lines.
     * Uses turf.intersect then post-processes to ensure adjacent slices share IDENTICAL
     * boundary coordinates for floodfill neighbor detection to work.
     */
    function slicePolygonByXCoordinates(feature, cutXValues) {
        if (!feature || !feature.geometry) return [];
        if (!Array.isArray(cutXValues) || cutXValues.length === 0) {
            return [feature];
        }

        const ringCoords = getPolygonCoordinates(feature);
        if (!ringCoords || ringCoords.length < 4) return [feature];

        const bbox = turf.bbox(feature);
        const minX = bbox[0];
        const maxX = bbox[2];
        const minY = bbox[1];
        const maxY = bbox[3];
        const padY = Math.max((maxY - minY) * 0.1, 0.001);

        // Sort and filter cut X values
        const cuts = cutXValues.filter(x => x > minX && x < maxX).sort((a, b) => a - b);
        if (cuts.length === 0) return [feature];

        // Pre-compute EXACT intersection points for each cut X on the ORIGINAL polygon
        const ring = ringCoords.slice(0, -1);
        const cutPointsMap = new Map(); // cutX -> array of {x, y} sorted by y

        for (const cutX of cuts) {
            const points = [];
            for (let i = 0; i < ring.length; i++) {
                const p1 = ring[i];
                const p2 = ring[(i + 1) % ring.length];
                const x1 = p1[0], y1 = p1[1];
                const x2 = p2[0], y2 = p2[1];

                if ((x1 < cutX && cutX < x2) || (x2 < cutX && cutX < x1)) {
                    const t = (cutX - x1) / (x2 - x1);
                    const y = y1 + t * (y2 - y1);
                    points.push({ x: cutX, y: y });
                }
            }
            points.sort((a, b) => a.y - b.y);
            cutPointsMap.set(cutX, points);
        }

        // Boundaries for all slices
        const boundaries = [minX, ...cuts, maxX];

        // Create slices using turf.intersect with vertical bands
        const sliceSlots = new Array(boundaries.length - 1).fill(null);
        for (let s = 0; s < boundaries.length - 1; s++) {
            const leftX = boundaries[s];
            const rightX = boundaries[s + 1];

            const band = turf.polygon([[
                [leftX, minY - padY],
                [rightX, minY - padY],
                [rightX, maxY + padY],
                [leftX, maxY + padY],
                [leftX, minY - padY]
            ]]);

            try {
                const sliced = turf.intersect(feature, band);
                if (sliced && computeFeatureArea(sliced) > 0) {
                    sliceSlots[s] = { feature: sliced, leftX, rightX, index: s };
                }
            } catch (err) {
                console.warn('slicePolygonByXCoordinates: intersect failed', err);
            }
        }

        // POST-PROCESS: floodfill neighbor detection matches *edges* (pairs of consecutive vertices)
        // after WGS84->HTRS96 conversion and 1cm quantization.
        // So we must ensure adjacent slices share the SAME vertex segmentation along the cut line,
        // not just "close" coordinates.

        const xTolerance = Math.max((maxX - minX) * 1e-4, 1e-7);

        function closeRingInPlace(coords) {
            if (!Array.isArray(coords) || coords.length < 3) return;
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (!Array.isArray(first) || !Array.isArray(last)) return;
            if (first[0] === last[0] && first[1] === last[1]) return;
            coords.push([first[0], first[1]]);
        }

        function findBestCutRun(ringCoords, cutX) {
            // Work on the non-closed ring to avoid the duplicated last vertex
            const n = ringCoords.length - 1;
            if (n < 3) return null;

            const onCut = (pt) => Array.isArray(pt) && Math.abs(pt[0] - cutX) < xTolerance;

            const runs = [];
            let start = null;
            for (let i = 0; i < n; i++) {
                if (onCut(ringCoords[i])) {
                    if (start === null) start = i;
                } else if (start !== null) {
                    runs.push({ start, end: i - 1 });
                    start = null;
                }
            }
            if (start !== null) {
                runs.push({ start, end: n - 1 });
            }

            if (runs.length === 0) return null;

            // Pick the run with the biggest y-span (tie-break by length)
            let best = null;
            for (const r of runs) {
                let yMin = Infinity;
                let yMax = -Infinity;
                for (let i = r.start; i <= r.end; i++) {
                    const y = ringCoords[i][1];
                    if (y < yMin) yMin = y;
                    if (y > yMax) yMax = y;
                }
                const span = yMax - yMin;
                const len = r.end - r.start + 1;
                const score = span * 1e6 + len; // prioritize span
                if (!best || score > best.score) {
                    best = { ...r, yMin, yMax, len, score };
                }
            }

            if (!best || best.len < 2) return null; // need at least 2 vertices to form edges
            const yStart = ringCoords[best.start][1];
            const yEnd = ringCoords[best.end][1];
            best.direction = yEnd >= yStart ? 'asc' : 'desc';
            return best;
        }

        function replaceRunWithCanonical(ringCoords, run, cutX, canonicalYs, direction) {
            // Replace vertices in [start..end] with canonical points along x=cutX.
            const points = canonicalYs.map(y => [cutX, y]);
            if (direction === 'desc') points.reverse();

            // Ensure endpoints exist (avoid degenerate)
            if (points.length < 2) return;

            // Splice into the ring (excluding the closing vertex). We'll re-close after.
            const nonClosedLen = ringCoords.length - 1;
            const deleteCount = (run.end - run.start + 1);
            ringCoords.splice(run.start, deleteCount, ...points);

            // Fix closure: drop last if it was old closure and re-add exact closure
            // (After splice, ringCoords may have shifted; ensure last equals first.)
            if (ringCoords.length >= 2) {
                // Remove trailing closure if present but stale
                const last = ringCoords[ringCoords.length - 1];
                const first = ringCoords[0];
                if (Array.isArray(last) && Array.isArray(first) && last[0] === first[0] && last[1] === first[1]) {
                    // already closed
                    return;
                }
                closeRingInPlace(ringCoords);
            }
        }

        function dedupeSortedYs(ys) {
            const out = [];
            const eps = 1e-12;
            for (const y of ys) {
                if (!Number.isFinite(y)) continue;
                if (out.length === 0 || Math.abs(out[out.length - 1] - y) > eps) out.push(y);
            }
            return out;
        }

        for (let c = 0; c < cuts.length; c++) {
            const cutX = cuts[c];
            const leftSlice = sliceSlots[c];
            const rightSlice = sliceSlots[c + 1];
            if (!leftSlice || !rightSlice) continue;

            const leftRing = getPolygonCoordinates(leftSlice.feature);
            const rightRing = getPolygonCoordinates(rightSlice.feature);
            if (!leftRing || !rightRing) continue;

            // Ensure rings are closed (turf usually does this, but be defensive)
            closeRingInPlace(leftRing);
            closeRingInPlace(rightRing);

            const leftRun = findBestCutRun(leftRing, cutX);
            const rightRun = findBestCutRun(rightRing, cutX);
            if (!leftRun || !rightRun) continue;

            const yMin = Math.max(leftRun.yMin, rightRun.yMin);
            const yMax = Math.min(leftRun.yMax, rightRun.yMax);
            if (!(yMax > yMin)) continue;

            // Canonical segmentation: union of both rings' existing cut-vertices within overlap,
            // plus the original polygon intersection points for this cut.
            const ys = [];
            for (let i = leftRun.start; i <= leftRun.end; i++) {
                const y = leftRing[i][1];
                if (y >= yMin - 1e-12 && y <= yMax + 1e-12) ys.push(y);
            }
            for (let i = rightRun.start; i <= rightRun.end; i++) {
                const y = rightRing[i][1];
                if (y >= yMin - 1e-12 && y <= yMax + 1e-12) ys.push(y);
            }
            const precomputed = cutPointsMap.get(cutX) || [];
            for (const pt of precomputed) {
                if (!pt) continue;
                const y = pt.y;
                if (y >= yMin - 1e-12 && y <= yMax + 1e-12) ys.push(y);
            }
            ys.sort((a, b) => a - b);
            const canonicalYs = dedupeSortedYs(ys);
            if (canonicalYs.length < 2) continue;

            // Force both sides to have identical vertices along the cut boundary.
            replaceRunWithCanonical(leftRing, leftRun, cutX, canonicalYs, leftRun.direction);
            replaceRunWithCanonical(rightRing, rightRun, cutX, canonicalYs, rightRun.direction);
        }

        return sliceSlots.filter(Boolean).map(s => s.feature);
    }

    function getPolygonCoordinates(feature) {
        if (!feature?.geometry?.coordinates) return null;
        if (feature.geometry.type === 'Polygon') {
            return feature.geometry.coordinates[0];
        }
        if (feature.geometry.type === 'MultiPolygon') {
            return feature.geometry.coordinates[0][0];
        }
        return null;
    }

    function sliceWithSweepLine(superParcel, owners) {
        if (typeof turf === 'undefined') {
            console.warn('turf is required for reparcellization.');
            return [];
        }
        if (!owners.length) return [];

        const baseFeature = JSON.parse(JSON.stringify(superParcel));
        const totalArea = computeFeatureArea(baseFeature);
        if (!totalArea) return [];

        const bbox = turf.bbox(baseFeature);
        const minX = bbox[0];
        const maxX = bbox[2];

        // First pass: compute all cut X coordinates using binary search
        const cutXValues = [];
        let cumulativePercent = 0;

        for (let i = 0; i < owners.length - 1; i++) {
            const owner = owners[i];
            if (!owner.percent) continue;
            cumulativePercent += owner.percent;
            const targetCumulativeArea = totalArea * cumulativePercent;

            // Binary search for the X coordinate
            let lower = minX;
            let upper = maxX;
            let bestCut = (lower + upper) / 2;
            let bestDiff = Infinity;

            for (let iter = 0; iter < 30; iter++) {
                const cut = (lower + upper) / 2;
                const sliceRect = buildSlicePolygon(minX, maxX, bbox[1], bbox[3], cut);
                if (!sliceRect) break;

                let sliceFeature = null;
                try {
                    sliceFeature = turf.intersect(baseFeature, sliceRect);
                } catch (_) { /* ignore */ }

                const area = sliceFeature ? computeFeatureArea(sliceFeature) : 0;
                const diff = Math.abs(area - targetCumulativeArea);

                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestCut = cut;
                }

                if (area < targetCumulativeArea) {
                    lower = cut;
                } else {
                    upper = cut;
                }

                if (Math.abs(diff / targetCumulativeArea) <= 0.005) {
                    break;
                }
            }

            cutXValues.push(bestCut);
        }

        // Second pass: slice the polygon using exact cut coordinates with shared boundaries
        const slicedFeatures = slicePolygonByXCoordinates(baseFeature, cutXValues);

        // Map sliced features to owners
        const slices = [];
        for (let i = 0; i < owners.length && i < slicedFeatures.length; i++) {
            const owner = owners[i];
            const sliceFeature = slicedFeatures[i];
            if (sliceFeature && sliceFeature.geometry) {
                slices.push({
                    ownerKey: owner.ownerKey,
                    displayName: owner.displayName,
                    percent: owner.percent,
                    color: owner.color,
                    geometry: sliceFeature.geometry
                });
            }
        }

        return slices.filter(slice => slice.geometry);
    }

    function normalizeFractions(values, count) {
        const safeValues = Array.isArray(values) ? values : [];
        const cleaned = safeValues.map(val => {
            const num = Number(val);
            return Number.isFinite(num) && num > 0 ? num : 0;
        });
        const total = cleaned.reduce((sum, val) => sum + val, 0);
        if (!Number.isFinite(total) || total <= 0) {
            return Array(count).fill(1 / count);
        }
        return cleaned.map(val => val / total);
    }

    function buildSingleOwnerShares() {
        const baseCount = clampParcelCount(state.singleConfig.parcelCount);
        const mode = state.singleConfig.distributionMode || 'equal';
        let fractions = [];

        if (mode === 'random') {
            const randoms = Array.from({ length: baseCount }, () => Math.random() + 0.25);
            fractions = normalizeFractions(randoms, baseCount);
            state.singleConfig.manualShares = fractions.map(val => Math.round(val * 100));
        } else if (mode === 'manual') {
            const manual = Array.isArray(state.singleConfig.manualShares)
                ? state.singleConfig.manualShares.slice(0, baseCount)
                : [];
            while (manual.length < baseCount) {
                manual.push(Math.round(100 / baseCount));
            }
            fractions = normalizeFractions(manual, baseCount);
        } else {
            fractions = Array(baseCount).fill(1 / baseCount);
        }
        return fractions.map((percent, index) => {
            const lotIndex = index + 1;
            const ownerLabel = state.singleOwnerLabel;
            const ownerKey = `lot-${lotIndex}`;
            return {
                ownerKey,
                displayName: ownerLabel,
                percent,
                color: pickOwnerColor(ownerKey, index),
                parcelIds: state.selection?.ids || []
            };
        });
    }

    function sliceSingleOwner(superParcel, shares, options = {}) {
        if (typeof turf === 'undefined' || !shares || !shares.length) {
            return [];
        }
        const activeShares = shares.filter(entry => entry && entry.percent > 0);
        if (!activeShares.length) return [];

        const centroid = getSuperParcelCentroidLngLat(superParcel) || turf.centroid(superParcel).geometry.coordinates;
        const angleDeg = options.orientationAngle || 0;
        const rotatedParcel = angleDeg
            ? turf.transformRotate(superParcel, -angleDeg, { pivot: centroid })
            : superParcel;

        const sliceAlongAxis = (feature, featureShares) => {
            const bbox = turf.bbox(feature);
            const minX = bbox[0];
            const maxX = bbox[2];
            const totalArea = computeFeatureArea(feature);
            if (!totalArea) return [];

            // First pass: find the optimal cut X coordinates using binary search
            const cutXValues = [];
            let cumulativePercent = 0;

            for (let i = 0; i < featureShares.length - 1; i++) {
                const owner = featureShares[i];
                cumulativePercent += owner.percent;
                const targetCumulativeArea = totalArea * cumulativePercent;

                // Binary search for the X coordinate that gives us targetCumulativeArea
                let lower = minX;
                let upper = maxX;
                let bestCut = (lower + upper) / 2;
                let bestDiff = Infinity;

                for (let iter = 0; iter < 30; iter++) {
                    const cut = (lower + upper) / 2;
                    const spanY = bbox[3] - bbox[1];
                    const padY = Math.max(spanY * 0.1, 0.001);
                    const band = turf.polygon([[
                        [minX - padY, bbox[1] - padY],
                        [cut, bbox[1] - padY],
                        [cut, bbox[3] + padY],
                        [minX - padY, bbox[3] + padY],
                        [minX - padY, bbox[1] - padY]
                    ]]);

                    let sliceFeature = null;
                    try {
                        sliceFeature = turf.intersect(feature, band);
                    } catch (_) { /* ignore */ }

                    const area = sliceFeature ? computeFeatureArea(sliceFeature) : 0;
                    const diff = Math.abs(area - targetCumulativeArea);

                    if (diff < bestDiff) {
                        bestDiff = diff;
                        bestCut = cut;
                    }

                    if (area < targetCumulativeArea) {
                        lower = cut;
                    } else {
                        upper = cut;
                    }

                    if (Math.abs(diff / targetCumulativeArea) <= 0.005) {
                        break;
                    }
                }

                cutXValues.push(bestCut);
            }

            // Second pass: slice the polygon using exact cut coordinates
            const slicedFeatures = slicePolygonByXCoordinates(feature, cutXValues);

            // Map sliced features to owner shares
            const slices = [];
            for (let i = 0; i < featureShares.length && i < slicedFeatures.length; i++) {
                const owner = featureShares[i];
                const sliceFeature = slicedFeatures[i];
                if (sliceFeature && sliceFeature.geometry) {
                    slices.push({
                        ownerKey: owner.ownerKey,
                        displayName: owner.displayName,
                        percent: owner.percent,
                        color: owner.color,
                        geometry: sliceFeature.geometry
                    });
                }
            }

            return slices;
        };

        const angleBack = angleDeg;
        const rotateBack = (slice) => {
            if (!slice || !slice.geometry) return null;
            const feature = { type: 'Feature', geometry: slice.geometry };
            const rotatedSlice = angleBack ? turf.transformRotate(feature, angleBack, { pivot: centroid }) : feature;
            return rotatedSlice.geometry ? { ...slice, geometry: rotatedSlice.geometry } : null;
        };

        const isSplitMode = options.lengthMode === 'split';
        if (!isSplitMode) {
            return sliceAlongAxis(rotatedParcel, activeShares).map(rotateBack).filter(Boolean).filter(s => s.geometry);
        }

        // Split mode: the solid line divides the parcel into two halves, and we want N parcels
        // per half, BUT parcels must align across the split line so edge-based floodfill works.
        // That means: compute the X cut positions ONCE on the whole parcel, slice into vertical
        // stripes, then split each stripe by the split line.
        const orientationLine = buildOrientationLineFeature();
        if (!orientationLine) {
            return sliceAlongAxis(rotatedParcel, activeShares).map(rotateBack).filter(Boolean).filter(s => s.geometry);
        }

        const rotatedLine = angleDeg
            ? turf.transformRotate(orientationLine, -angleDeg, { pivot: centroid })
            : orientationLine;

        // Helper: compute cut X values for shares on a given feature
        const computeCutXValues = (feature, featureShares) => {
            const bbox = turf.bbox(feature);
            const minX = bbox[0];
            const maxX = bbox[2];
            const totalArea = computeFeatureArea(feature);
            if (!totalArea) return [];

            const cutXValues = [];
            let cumulativePercent = 0;

            for (let i = 0; i < featureShares.length - 1; i++) {
                const owner = featureShares[i];
                cumulativePercent += owner.percent;
                const targetCumulativeArea = totalArea * cumulativePercent;

                let lower = minX;
                let upper = maxX;
                let bestCut = (lower + upper) / 2;
                let bestDiff = Infinity;

                for (let iter = 0; iter < 30; iter++) {
                    const cut = (lower + upper) / 2;
                    const spanY = bbox[3] - bbox[1];
                    const padY = Math.max(spanY * 0.1, 0.001);
                    const band = turf.polygon([[
                        [minX - padY, bbox[1] - padY],
                        [cut, bbox[1] - padY],
                        [cut, bbox[3] + padY],
                        [minX - padY, bbox[3] + padY],
                        [minX - padY, bbox[1] - padY]
                    ]]);

                    let sliceFeature = null;
                    try {
                        sliceFeature = turf.intersect(feature, band);
                    } catch (_) { /* ignore */ }

                    const area = sliceFeature ? computeFeatureArea(sliceFeature) : 0;
                    const diff = Math.abs(area - targetCumulativeArea);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        bestCut = cut;
                    }

                    if (area < targetCumulativeArea) {
                        lower = cut;
                    } else {
                        upper = cut;
                    }

                    if (targetCumulativeArea > 0 && Math.abs(diff / targetCumulativeArea) <= 0.005) {
                        break;
                    }
                }

                cutXValues.push(bestCut);
            }

            return cutXValues;
        };

        const cutXValues = computeCutXValues(rotatedParcel, activeShares);
        const stripes = slicePolygonByXCoordinates(rotatedParcel, cutXValues);

        // Determine which side is "top" vs "bottom" in rotated frame
        const midY = rotatedLine.geometry.coordinates.reduce((sum, coord) => sum + coord[1], 0) / rotatedLine.geometry.coordinates.length;

        const results = [];
        for (let i = 0; i < activeShares.length && i < stripes.length; i++) {
            const share = activeShares[i];
            const stripe = stripes[i];
            if (!stripe) continue;

            const parts = splitPolygonWithLine(stripe, rotatedLine);
            if (!parts || parts.length < 2) {
                continue;
            }

            // Take the two largest parts to avoid slivers
            parts.sort((a, b) => computeFeatureArea(b) - computeFeatureArea(a));
            const two = parts.slice(0, 2);

            const labeled = two.map(f => {
                const c = turf.centroid(f).geometry.coordinates;
                return { feature: f, side: c[1] >= midY ? 'top' : 'bottom' };
            });

            const topPiece = labeled.find(p => p.side === 'top')?.feature;
            const bottomPiece = labeled.find(p => p.side === 'bottom')?.feature;
            if (topPiece && topPiece.geometry) {
                results.push({
                    ownerKey: `${share.ownerKey}-top-${i}`,
                    displayName: share.displayName,
                    percent: share.percent,
                    color: share.color,
                    geometry: topPiece.geometry
                });
            }
            if (bottomPiece && bottomPiece.geometry) {
                results.push({
                    ownerKey: `${share.ownerKey}-bottom-${i}`,
                    displayName: share.displayName,
                    percent: share.percent,
                    color: share.color,
                    geometry: bottomPiece.geometry
                });
            }
        }

        return results.map(rotateBack).filter(Boolean).filter(s => s.geometry);
    }

    async function refreshSingleOwnerPreview() {
        setStatus(
            t('reparcellization.modal.status.preparingPreview', 'Preparing repartition preview...'),
            'info',
            'reparcellization.modal.status.preparingPreview'
        );
        ensureCommitAvailability(false);
        state.ownerShares = buildSingleOwnerShares();
        updateSubtitleWithOwners(state.ownerShares.length || state.singleConfig.parcelCount);

        if (!state.totalArea) {
            state.totalArea = computeFeatureArea(state.superParcel);
        }

        state.slices = sliceSingleOwner(state.superParcel, state.ownerShares, {
            lengthMode: state.singleConfig.lengthMode,
            orientationAngle: getOrientationAngleDeg()
        });

        updateTotalParcelsLabel();

        if (!state.slices.length) {
            setStatus(
                t('reparcellization.modal.status.splitFailed', 'Failed to split the parcel geometry.'),
                'error',
                'reparcellization.modal.status.splitFailed'
            );
            drawPreview();
            return;
        }

        ensureCommitAvailability(true);
        setStatus('', 'info');
        drawPreview();
    }

    async function refreshPreview() {
        if (state.ownershipMode === 'single') {
            await refreshSingleOwnerPreview();
            return;
        }
        setStatus(
            t('reparcellization.modal.status.preparingPreview', 'Preparing repartition preview...'),
            'info',
            'reparcellization.modal.status.preparingPreview'
        );
        ensureCommitAvailability(false);
        state.ownerShares = await buildOwnerShares(state.selection);
        updateSubtitleWithOwners(state.ownerShares.length);
        if (!state.ownerShares.length) {
            setStatus(
                t('reparcellization.modal.status.missingOwners', 'Could not determine owners for reparcellization.'),
                'error',
                'reparcellization.modal.status.missingOwners'
            );
            state.slices = [];
            drawPreview();
            return;
        }
        updateLegend(state.ownerShares);

        if (!state.totalArea) {
            state.totalArea = computeFeatureArea(state.superParcel);
        }

        if (state.algorithm === 'sweep-line') {
            state.slices = sliceWithSweepLine(state.superParcel, state.ownerShares);
        } else {
            setStatus(
                t('reparcellization.modal.status.algorithmUnavailable', 'Selected algorithm is not available yet.'),
                'warning',
                'reparcellization.modal.status.algorithmUnavailable'
            );
            return;
        }
        if (!state.slices.length) {
            setStatus(
                t('reparcellization.modal.status.splitFailed', 'Failed to split the parcel geometry.'),
                'error',
                'reparcellization.modal.status.splitFailed'
            );
            ensureCommitAvailability(false);
            drawPreview();
            return;
        }
        if (state.slices.length !== state.ownerShares.length) {
            setStatus(
                t('reparcellization.modal.status.splitFailed', 'Failed to split the parcel geometry.'),
                'error',
                'reparcellization.modal.status.splitFailed'
            );
            ensureCommitAvailability(false);
            drawPreview();
            return;
        }
        ensureCommitAvailability(true);
        updateTotalParcelsLabel();
        drawPreview();
    }

    function validateSelection(selection) {
        if (!selection || !Array.isArray(selection.layers) || !selection.layers.length) {
            return false;
        }
        return true;
    }

    function buildSuperParcel(selection) {
        if (typeof buildGeometryFromParcels !== 'function') {
            return null;
        }
        const geometry = buildGeometryFromParcels(selection.layers);
        if (!geometry) return null;
        return {
            type: 'Feature',
            properties: {
                parcelIds: selection.ids.slice()
            },
            geometry
        };
    }

    async function openReparcellizationModal(options = {}) {
        const selection = (typeof getCurrentParcelSelectionContext === 'function')
            ? getCurrentParcelSelectionContext()
            : null;
        if (!validateSelection(selection)) {
            if (typeof updateStatus === 'function') {
                const message = t(
                    'status.messages.select_at_least_one_parcel_before_running_reparcellization',
                    'Select at least one parcel before running reparcellization.'
                );
                updateStatus(message);
            }
            return false;
        }
        const superParcel = buildSuperParcel(selection);
        if (!superParcel) {
            if (typeof updateStatus === 'function') {
                const message = t(
                    'status.messages.unable_to_build_geometry_for_reparcellization',
                    'Unable to build geometry for reparcellization.'
                );
                updateStatus(message);
            }
            return false;
        }
        state.selection = selection;
        state.superParcel = superParcel;
        state.ownershipMode = options.ownershipMode === 'single' ? 'single' : 'multiple';
        state.singleOwnerLabel = null;
        state.singleConfig = {
            lengthMode: 'full',
            parcelCount: clampParcelCount(2),
            distributionMode: 'equal',
            manualShares: []
        };
        state.algorithm = state.ownershipMode === 'single'
            ? 'sweep-line'
            : (options.algorithm || 'sweep-line');
        state.totalArea = computeFeatureArea(superParcel);
        if (state.ownershipMode === 'single') {
            const providedOwner = typeof options.singleOwnerLabel === 'string' ? options.singleOwnerLabel.trim() : '';
            if (!providedOwner) {
                if (typeof updateStatus === 'function') {
                    updateStatus('Cannot open single-owner reparcellization without an explicit owner.');
                }
                return false;
            }
            state.singleOwnerLabel = providedOwner;
        }
        buildModalStructure();
        initMap();
        await refreshPreview();
        return true;
    }

    if (typeof window.pendingReparcellizationPlan === 'undefined') {
        window.pendingReparcellizationPlan = null;
    }
    window.openReparcellizationModal = openReparcellizationModal;
})();
