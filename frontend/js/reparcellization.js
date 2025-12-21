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
        lengthModeSelect: null,
        parcelCountInput: null,
        totalParcelsEl: null,
        distributionSelect: null,
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
                                <label for="reparcel-length-mode">${lengthLabel}</label>
                                <select id="reparcel-length-mode" data-length-mode>
                                    <option value="full">${lengthFullLabel}</option>
                                    <option value="split">${lengthSplitLabel}</option>
                                </select>
                            </div>
                            <div class="single-owner-block">
                                <label for="reparcel-parcel-count">${parcelCountLabel}</label>
                                <input type="number" id="reparcel-parcel-count" data-parcel-count min="2" max="20" value="${state.singleConfig.parcelCount || 2}" />
                                <p class="single-owner-total" data-total-parcels data-i18n-key="reparcellization.modal.single.totalParcelsLabel" data-i18n-params='${JSON.stringify({ count: computeResultingParcelCount() })}'>${totalParcelsLabel}</p>
                            </div>
                            <div class="single-owner-block">
                                <label for="reparcel-distribution">${distributionLabel}</label>
                                <select id="reparcel-distribution" data-distribution-mode>
                                    <option value="equal">${distributionOptions.equal}</option>
                                    <option value="random">${distributionOptions.random}</option>
                                    <option value="manual">${distributionOptions.manual}</option>
                                </select>
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
        state.lengthModeSelect = overlay.querySelector('[data-length-mode]');
        state.parcelCountInput = overlay.querySelector('[data-parcel-count]');
        state.totalParcelsEl = overlay.querySelector('[data-total-parcels]');
        state.distributionSelect = overlay.querySelector('[data-distribution-mode]');
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
            const area = Number(props.calculatedArea) || computeFeatureArea(feature) || 0;
            const percent = totalArea > 0 ? ((area / totalArea) * 100).toFixed(1) : '0.0';
            return `<div class="single-parcel-row"><span>${parcelLabel} ${parcelId}</span><span>${Math.round(area).toLocaleString('hr-HR')} m² (${percent}%)</span></div>`;
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
        if (state.lengthModeSelect) {
            state.lengthModeSelect.value = state.singleConfig.lengthMode;
            state.lengthModeSelect.addEventListener('change', () => {
                state.singleConfig.lengthMode = state.lengthModeSelect.value || 'full';
                updateTotalParcelsLabel();
                refreshSingleOwnerPreview();
            });
        }

        if (state.parcelCountInput) {
            const clamped = clampParcelCount(state.singleConfig.parcelCount);
            state.singleConfig.parcelCount = clamped;
            state.parcelCountInput.value = clamped;
            state.parcelCountInput.addEventListener('input', () => {
                const next = clampParcelCount(state.parcelCountInput.value);
                state.singleConfig.parcelCount = next;
                state.parcelCountInput.value = next;
                rebuildManualShareInputs(next);
                updateSubtitleWithOwners(state.ownerShares.length);
                updateTotalParcelsLabel();
                refreshSingleOwnerPreview();
            });
        }

        if (state.distributionSelect) {
            state.distributionSelect.value = state.singleConfig.distributionMode;
            state.distributionSelect.addEventListener('change', () => {
                state.singleConfig.distributionMode = state.distributionSelect.value || 'equal';
                rebuildManualShareInputs();
                refreshSingleOwnerPreview();
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
            const [start, end] = [lineCoords[0], lineCoords[lineCoords.length - 1]];

            // Direction vector along the line
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const length = Math.hypot(dx, dy);
            if (length === 0) return null;

            // Perpendicular direction (normalized)
            const perpX = -dy / length;
            const perpY = dx / length;

            // Create a large offset to form half-plane polygons
            const bbox = turf.bbox(polygon);
            const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
            const offset = span * 10;

            // Half-plane 1: to the "left" of the line
            const halfPlane1 = turf.polygon([[
                [start[0], start[1]],
                [end[0], end[1]],
                [end[0] + perpX * offset, end[1] + perpY * offset],
                [start[0] + perpX * offset, start[1] + perpY * offset],
                [start[0], start[1]]
            ]]);

            // Half-plane 2: to the "right" of the line
            const halfPlane2 = turf.polygon([[
                [start[0], start[1]],
                [end[0], end[1]],
                [end[0] - perpX * offset, end[1] - perpY * offset],
                [start[0] - perpX * offset, start[1] - perpY * offset],
                [start[0], start[1]]
            ]]);

            let piece1 = null;
            let piece2 = null;
            try {
                piece1 = turf.intersect(polygon, halfPlane1);
            } catch (e1) {
                // intersect can fail on invalid geometries
            }
            try {
                piece2 = turf.intersect(polygon, halfPlane2);
            } catch (e2) {
                // intersect can fail on invalid geometries
            }

            const results = [];
            if (piece1 && computeFeatureArea(piece1) > 0) results.push(piece1);
            if (piece2 && computeFeatureArea(piece2) > 0) results.push(piece2);

            if (results.length < 2) return null;

            // Compute exact intersection points where the split line crosses the polygon boundary
            const ringCoords = getPolygonCoordinates(polygon);
            const splitLineIntersections = []; // Array of {x, y} points on the split line

            if (ringCoords) {
                for (let i = 0; i < ringCoords.length - 1; i++) {
                    const p1 = ringCoords[i];
                    const p2 = ringCoords[i + 1];

                    // Find intersection of edge p1-p2 with line start-end
                    // Using parametric line intersection
                    const x1 = p1[0], y1 = p1[1];
                    const x2 = p2[0], y2 = p2[1];
                    const x3 = start[0], y3 = start[1];
                    const x4 = end[0], y4 = end[1];

                    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
                    if (Math.abs(denom) < 1e-12) continue; // Parallel lines

                    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;

                    if (t >= 0 && t <= 1) {
                        const ix = x1 + t * (x2 - x1);
                        const iy = y1 + t * (y2 - y1);
                        splitLineIntersections.push({ x: ix, y: iy });
                    }
                }
            }

            // Dedupe intersection points
            const uniqueIntersections = [];
            for (const pt of splitLineIntersections) {
                const isDupe = uniqueIntersections.some(
                    u => Math.abs(u.x - pt.x) < 1e-12 && Math.abs(u.y - pt.y) < 1e-12
                );
                if (!isDupe) uniqueIntersections.push(pt);
            }

            // Snap boundary vertices in both pieces to exact intersection points
            const tolerance = span * 0.0001;

            for (const result of results) {
                const coords = getPolygonCoordinates(result);
                if (!coords) continue;

                for (const coord of coords) {
                    // Check if point is near the split line
                    const dist = Math.abs((end[1] - start[1]) * coord[0] - (end[0] - start[0]) * coord[1] + end[0] * start[1] - end[1] * start[0]) / length;
                    if (dist < tolerance) {
                        // Find closest intersection point
                        let closest = uniqueIntersections[0];
                        if (!closest) continue;
                        let closestDist = Math.hypot(coord[0] - closest.x, coord[1] - closest.y);
                        for (const pt of uniqueIntersections) {
                            const d = Math.hypot(coord[0] - pt.x, coord[1] - pt.y);
                            if (d < closestDist) {
                                closestDist = d;
                                closest = pt;
                            }
                        }
                        // Snap to exact intersection point
                        coord[0] = closest.x;
                        coord[1] = closest.y;
                    }
                }
            }

            return results;
        } catch (err) {
            console.warn('splitPolygonWithLine failed', err);
            return null;
        }
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
     * Slice a polygon into N adjacent pieces along the X axis.
     * Uses turf.intersect for slicing, then enforces that adjacent slices
     * share IDENTICAL boundary coordinates by copying vertices from one to the other.
     */
    function slicePolygonByXCoordinates(feature, cutXValues) {
        if (!feature || !feature.geometry) return [];
        if (!Array.isArray(cutXValues) || cutXValues.length === 0) {
            return [feature];
        }

        const bbox = turf.bbox(feature);
        const minX = bbox[0];
        const maxX = bbox[2];
        const minY = bbox[1];
        const maxY = bbox[3];
        const spanY = maxY - minY;
        const padY = Math.max(spanY * 0.1, 0.001);

        // Sort cuts and add boundaries
        const allCuts = [minX, ...cutXValues.filter(x => x > minX && x < maxX).sort((a, b) => a - b), maxX];

        // First, compute all intersection points where vertical cut lines cross the polygon boundary.
        // These will be the SHARED boundary vertices.
        const ringCoords = getPolygonCoordinates(feature);
        if (!ringCoords) return [feature];

        // For each cut X, find the exact intersection points with the polygon boundary
        const cutIntersections = {}; // cutX -> array of Y coordinates where the cut crosses the boundary

        for (const cutX of allCuts) {
            cutIntersections[cutX] = [];
            // Walk edges of the polygon and find intersections with vertical line at cutX
            for (let i = 0; i < ringCoords.length - 1; i++) {
                const p1 = ringCoords[i];
                const p2 = ringCoords[i + 1];
                const x1 = p1[0], y1 = p1[1];
                const x2 = p2[0], y2 = p2[1];

                // Check if edge crosses the vertical line at cutX
                if ((x1 <= cutX && cutX <= x2) || (x2 <= cutX && cutX <= x1)) {
                    if (Math.abs(x2 - x1) < 1e-12) {
                        // Vertical edge - add both endpoints if at cutX
                        if (Math.abs(x1 - cutX) < 1e-12) {
                            cutIntersections[cutX].push(y1);
                            cutIntersections[cutX].push(y2);
                        }
                    } else {
                        // Interpolate Y at cutX
                        const t = (cutX - x1) / (x2 - x1);
                        if (t >= 0 && t <= 1) {
                            const yAtCut = y1 + t * (y2 - y1);
                            cutIntersections[cutX].push(yAtCut);
                        }
                    }
                }
            }
            // Sort and dedupe
            cutIntersections[cutX].sort((a, b) => a - b);
            cutIntersections[cutX] = cutIntersections[cutX].filter((y, i, arr) =>
                i === 0 || Math.abs(y - arr[i - 1]) > 1e-12
            );
        }

        const slices = [];

        for (let i = 0; i < allCuts.length - 1; i++) {
            const leftX = allCuts[i];
            const rightX = allCuts[i + 1];
            if (rightX <= leftX) continue;

            // Build a vertical band polygon
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
                    slices.push({ feature: sliced, leftX, rightX });
                }
            } catch (err) {
                console.warn('slicePolygonByXCoordinates: intersect failed', err);
            }
        }

        // Now enforce exact shared boundaries by snapping boundary vertices to computed intersection points
        const tolerance = (maxX - minX) * 0.0001; // Very tight tolerance

        for (const slice of slices) {
            const coords = getPolygonCoordinates(slice.feature);
            if (!coords) continue;

            // Snap vertices near cut lines to the exact intersection points
            for (const coord of coords) {
                const x = coord[0];
                // Check if this vertex is near a cut line
                for (const cutX of allCuts) {
                    if (Math.abs(x - cutX) < tolerance) {
                        // Find the closest Y intersection point
                        const yIntersects = cutIntersections[cutX];
                        if (!yIntersects || yIntersects.length === 0) continue;

                        let closestY = yIntersects[0];
                        let closestDist = Math.abs(coord[1] - closestY);
                        for (const yInt of yIntersects) {
                            const dist = Math.abs(coord[1] - yInt);
                            if (dist < closestDist) {
                                closestDist = dist;
                                closestY = yInt;
                            }
                        }
                        // Snap to EXACT coordinates
                        coord[0] = cutX;  // Use exact cutX, not the slightly-off x from turf
                        coord[1] = closestY;
                        break; // Don't check other cut lines
                    }
                }
            }
        }

        return slices.map(s => s.feature);
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

        // Split mode: the solid line through the centroid divides the superparcel into two halves.
        // Each half gets N parcels (perpendicular to the solid line), so total = N × 2.
        const orientationLine = buildOrientationLineFeature();
        if (!orientationLine) {
            return sliceAlongAxis(rotatedParcel, activeShares).map(rotateBack).filter(s => s.geometry);
        }

        // Rotate the line into the same coordinate frame as the rotated parcel
        const rotatedLine = angleDeg
            ? turf.transformRotate(orientationLine, -angleDeg, { pivot: centroid })
            : orientationLine;

        // Split the rotated polygon with the rotated line
        const splitPieces = splitPolygonWithLine(rotatedParcel, rotatedLine);
        if (!splitPieces || splitPieces.length < 2) {
            // Fallback to single-pass slicing if split fails
            return sliceAlongAxis(rotatedParcel, activeShares).map(rotateBack).filter(s => s.geometry);
        }

        // Sort by area and take the two largest to avoid slivers
        splitPieces.sort((a, b) => computeFeatureArea(b) - computeFeatureArea(a));
        const primaryPieces = splitPieces.slice(0, 2);

        // Determine which piece is "top" vs "bottom" based on centroid Y relative to line
        const midY = rotatedLine.geometry.coordinates.reduce((sum, coord) => sum + coord[1], 0) / rotatedLine.geometry.coordinates.length;
        const labeledPieces = primaryPieces.map(feature => {
            const c = turf.centroid(feature).geometry.coordinates;
            return { feature, side: c[1] >= midY ? 'top' : 'bottom' };
        });

        // Each half gets its own copy of shares (each share is now half the area)
        const topShares = activeShares.map((share, idx) => ({
            ...share,
            ownerKey: `${share.ownerKey}-top-${idx}`,
            displayName: share.displayName,
            percent: share.percent,  // full percent within this half
            _side: 'top'
        }));
        const bottomShares = activeShares.map((share, idx) => ({
            ...share,
            ownerKey: `${share.ownerKey}-bottom-${idx}`,
            displayName: share.displayName,
            percent: share.percent,  // full percent within this half
            _side: 'bottom'
        }));

        const results = [];
        labeledPieces.forEach(piece => {
            const sharesForPiece = piece.side === 'top' ? topShares : bottomShares;
            results.push(...sliceAlongAxis(piece.feature, sharesForPiece));
        });

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
