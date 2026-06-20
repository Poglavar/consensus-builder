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
            lengthMode: 'split',
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
        manualSharesContainer: null,
        uploadedGeometry: null,
        selectedSliceIndex: null,
        ownerAssignmentPopup: null,
        newPlotsListEl: null,
        // Land-readjustment accounting: contribution is measured by land value
        // (estimatedMarketPrice, area fallback) so owners are entitled to plots
        // of proportional value. contributionRatio reserves land for public uses
        // (roads/parks); it stays 1 in P1 until the public-carve step lands.
        contributionBasis: 'value',
        totalValue: 0,
        poolUnitValue: 0,
        contributionRatio: 1,
        coverageEl: null,
        // Manual plot drawing state. mode 'polygon' draws/carves a new plot;
        // mode 'line' splits the plots it crosses into separate plots.
        drawing: { active: false, points: [], tempLayer: null, tempMarkers: [], mode: 'polygon' },
        drawBtn: null,
        lineBtn: null,
        // Sweep-line orientation: a draggable point the cut lines point toward.
        sweepHandle: null,
        sweepDirLayer: null,
        cashTotalEl: null,
        // Per-owner cash-offer overrides (ownerKey -> number) when the user edits
        // the prefilled cash offer; unset owners use the computed default.
        cashOfferOverrides: {},
        // Before/after swipe comparison (a second "before" map clipped by a slider).
        compareBtn: null,
        compare: { active: false, map2: null, beforeEl: null, handleEl: null, labels: null, x: 0, cleanupDrag: null }
    };

    // Pseudo-owner for land assigned to public use (roads, parks, etc.). Rendered
    // white so it reads as "not an owner"; excluded from owner cash accounting.
    const PUBLIC_LAND_KEY = 'public-land';
    function getPublicLandOwner() {
        return {
            ownerKey: PUBLIC_LAND_KEY,
            displayName: t('reparcellization.modal.publicLand', 'Public land'),
            color: '#ffffff'
        };
    }

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
                key: 'manual',
                label: t('reparcellization.modal.algorithms.manual', 'Manual'),
                disabled: false
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
        exitCompare();
        destroySweepOrientation();
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
        cancelDraw();
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
        state.uploadedGeometry = null;
        state.selectedSliceIndex = null;
        dismissOwnerPopup();
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
                        <div class="reparcel-edit-tools">
                            <div class="reparcel-legend-actions">
                                <button type="button" class="btn-icon" data-reparcel-draw aria-pressed="false" title="${t('reparcellization.modal.drawPlot', 'Draw plot')}">&#x270F;&#xFE0F;</button>
                                <button type="button" class="btn-icon" data-reparcel-line aria-pressed="false" title="${t('reparcellization.modal.drawLine', 'Split with line')}">&#x2702;&#xFE0F;</button>
                                <button type="button" class="btn-icon" data-reparcel-shuffle title="${t('reparcellization.modal.shuffle', 'Shuffle ownership')}">&#x1f500;</button>
                                <label class="btn-icon btn-upload-label" title="${t('reparcellization.modal.uploadGeojson', 'Upload GeoJSON')}">
                                    &#x1F4C2;
                                    <input type="file" accept=".geojson,.json,application/geo+json,application/json" data-reparcel-upload hidden>
                                </label>
                            </div>
                            <div class="reparcel-draw-toolbar" data-reparcel-draw-toolbar hidden>
                                <button type="button" class="btn-draw-tool" data-reparcel-undo>&#x21B6; ${t('reparcellization.modal.drawUndo', 'Undo point')}</button>
                                <button type="button" class="btn-draw-tool btn-draw-finish" data-reparcel-finish>&#x2713; ${t('reparcellization.modal.drawFinish', 'Finish plot')}</button>
                                <button type="button" class="btn-draw-tool" data-reparcel-cancel-draw>&#x2715; ${t('reparcellization.modal.drawCancel', 'Cancel')}</button>
                            </div>
                        </div>
                    </div>`;

        const sidePanel = isSingleOwner
            ? `<section class="reparcel-single-panel">
                            <div class="single-owner-block">
                                <h3 data-i18n-key="reparcellization.modal.single.parcelListTitle">${parcelListTitle}</h3>
                                <div class="single-owner-parcel-list" data-reparcel-parcel-list></div>
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
                            <div class="reparcel-newplots-header">
                                <h3>${t('reparcellization.modal.newPlots', 'New plots')}</h3>
                            </div>
                            <div class="reparcel-newplots-list" data-reparcel-newplots-table></div>
                            <div class="reparcel-legend-header">
                                <h3>${t('reparcellization.modal.owners', 'Owners')}</h3>
                            </div>
                            <div class="reparcel-legend-list" data-reparcel-owners-table></div>
                            <div class="reparcel-cashtotal" data-reparcel-cashtotal></div>
                            <div class="reparcel-coverage" data-reparcel-coverage></div>
                            <div class="reparcel-status" data-reparcel-status></div>
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
                            <button type="button" class="reparcel-compare-btn" data-reparcel-compare hidden>${t('reparcellization.modal.beforeAfter', 'Before / After')}</button>
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
        state.legendListEl = isSingleOwner ? null : overlay.querySelector('[data-reparcel-owners-table]');
        state.newPlotsListEl = isSingleOwner ? null : overlay.querySelector('[data-reparcel-newplots-table]');
        state.coverageEl = isSingleOwner ? null : overlay.querySelector('[data-reparcel-coverage]');
        state.cashTotalEl = isSingleOwner ? null : overlay.querySelector('[data-reparcel-cashtotal]');
        state.drawBtn = isSingleOwner ? null : overlay.querySelector('[data-reparcel-draw]');
        state.lineBtn = isSingleOwner ? null : overlay.querySelector('[data-reparcel-line]');
        state.compareBtn = isSingleOwner ? null : overlay.querySelector('[data-reparcel-compare]');
        if (state.compareBtn) state.compareBtn.hidden = false;
        state.drawToolbar = isSingleOwner ? null : overlay.querySelector('[data-reparcel-draw-toolbar]');
        state.finishBtn = isSingleOwner ? null : overlay.querySelector('[data-reparcel-finish]');
        state.undoBtn = isSingleOwner ? null : overlay.querySelector('[data-reparcel-undo]');
        state.parcelListEl = isSingleOwner ? overlay.querySelector('[data-reparcel-parcel-list]') : null;
        state.lengthModeRadios = [];
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
            if (state.compare.active && state.compare.map2) {
                try {
                    state.compare.map2.invalidateSize();
                    state.compare.map2.setView(state.map.getCenter(), state.map.getZoom(), { animate: false });
                } catch (_) { }
                updateCompareClip();
            }
        };
        window.addEventListener('resize', state.resizeHandler);

        state.escHandler = (event) => {
            if (event.key === 'Escape') {
                if (state.drawing.active) {
                    cancelDraw();
                    setStatus('', 'info');
                    return;
                }
                closeModal();
                return;
            }
            // Drawing shortcuts (ignore when typing in a field).
            if (!state.drawing.active) return;
            const tag = (event.target && event.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (event.key === 'Enter') {
                event.preventDefault();
                onDrawFinish();
            } else if (event.key === 'Backspace') {
                event.preventDefault();
                undoLastPoint();
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
                // The sweep orientation point only belongs to sweep-line mode.
                if (option.key !== 'sweep-line') {
                    destroySweepOrientation();
                }
                // Drawing only applies to manual; cancel any active draw when leaving it.
                if (option.key !== 'manual') {
                    cancelDraw();
                }
                updateDrawToolButtons();
                refreshPreview();
            });
        }

        if (isSingleOwner) {
            initializeSingleOwnerControls();
            renderSingleOwnerParcelList();
        }

        const shuffleBtn = overlay.querySelector('[data-reparcel-shuffle]');
        if (shuffleBtn) {
            shuffleBtn.addEventListener('click', shuffleOwnership);
        }

        if (state.drawBtn) {
            state.drawBtn.addEventListener('click', () => toggleDrawMode('polygon'));
        }
        if (state.lineBtn) {
            state.lineBtn.addEventListener('click', () => toggleDrawMode('line'));
        }
        updateDrawToolButtons();
        if (state.finishBtn) {
            state.finishBtn.addEventListener('click', () => onDrawFinish());
        }
        if (state.undoBtn) {
            state.undoBtn.addEventListener('click', undoLastPoint);
        }
        const cancelDrawBtn = overlay.querySelector('[data-reparcel-cancel-draw]');
        if (cancelDrawBtn) {
            cancelDrawBtn.addEventListener('click', () => { cancelDraw(); setStatus('', 'info'); });
        }

        if (state.compareBtn) {
            state.compareBtn.addEventListener('click', toggleCompare);
        }

        const uploadInput = overlay.querySelector('[data-reparcel-upload]');
        if (uploadInput) {
            uploadInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) handleGeojsonUpload(file);
                uploadInput.value = '';
            });
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
            maxZoom: 19,
            maxNativeZoom: 19,
            minZoom: 3
        });
        baseLayer.addTo(map);
        state.baseLayer = baseLayer;
        state.map = map;
        map.whenReady(() => {
            if (state.ownershipMode === 'single') {
                initOrientationGuides();
            } else if (state.algorithm === 'sweep-line') {
                initSweepOrientation();
                updateSweepDirLine();
            }
        });
        setTimeout(() => map.invalidateSize(), 150);
    }

    function formatArea(area) {
        if (!area || !Number.isFinite(area)) return '0 m\u00b2';
        return Math.round(area).toLocaleString('hr-HR') + ' m\u00b2';
    }

    function formatMoney(value) {
        if (!value || !Number.isFinite(value)) return '0 €';
        return Math.round(value).toLocaleString('hr-HR') + ' €';
    }

    // True when we have meaningful land value to redistribute by; otherwise the
    // ledger falls back to area (m²) as the contribution metric.
    function ledgerUsesMoney() {
        return Number.isFinite(state.poolUnitValue) && state.poolUnitValue > 0;
    }

    function formatLedgerMetric(value) {
        return ledgerUsesMoney() ? formatMoney(value) : formatArea(value);
    }

    // Per-owner readjustment ledger: what they pooled, what they're entitled to
    // after the public-land contribution ratio, what they've been assigned, and
    // the cash balance (+ owner pays for surplus land, − owner is compensated).
    function computeOwnerLedger(entry) {
        const useMoney = ledgerUsesMoney();
        const unit = useMoney ? state.poolUnitValue : 1;
        const contributed = useMoney
            ? (Number.isFinite(entry.value) ? entry.value : (entry.area || 0) * unit)
            : (entry.area || 0);
        const entitled = contributed * (state.contributionRatio || 1);
        let assignedArea = 0;
        for (const slice of state.slices) {
            if (!Array.isArray(slice.owners) || !slice.owners.length) continue;
            const match = slice.owners.find(o => o.ownerKey === entry.ownerKey);
            if (!match) continue;
            assignedArea += computeFeatureArea(sliceToFeature(slice)) * (match.share || 0);
        }
        const assigned = assignedArea * unit;
        return {
            contributed,
            entitled,
            assigned,
            assignedArea,
            cashBalance: assigned - entitled
        };
    }

    // Default cash offer for an owner: the shortfall to compensate when they were
    // assigned less than their entitlement (negative balance), otherwise nothing.
    function defaultCashOffer(ledger) {
        return ledger.cashBalance < 0 ? -ledger.cashBalance : 0;
    }

    // Cash offer for an owner: the user's edited override if any, else the default.
    function getCashOffer(ownerKey, ledger) {
        if (Object.prototype.hasOwnProperty.call(state.cashOfferOverrides, ownerKey)) {
            return state.cashOfferOverrides[ownerKey];
        }
        return defaultCashOffer(ledger);
    }

    function computeTotalCashOffer() {
        let total = 0;
        for (const entry of state.ownerShares) {
            total += getCashOffer(entry.ownerKey, computeOwnerLedger(entry));
        }
        return total;
    }

    function updateCashTotalDisplay() {
        if (!state.cashTotalEl) return;
        const total = computeTotalCashOffer();
        state.cashTotalEl.textContent = t(
            'reparcellization.modal.totalCashOffer',
            'Total cash offers: {{amount}}',
            { amount: formatLedgerMetric(total) }
        );
    }

    // Coverage of the pooled land by assigned plots — the completeness invariant
    // for committing a readjustment (every piece of land in exactly one assigned
    // plot, none left unassigned).
    function evaluatePlanCompleteness() {
        const totalArea = state.totalArea || computeFeatureArea(state.superParcel) || 0;
        let assignedArea = 0;
        let unassignedArea = 0;
        let unassignedCount = 0;
        for (const slice of state.slices) {
            const area = computeFeatureArea(sliceToFeature(slice));
            const hasOwner = Array.isArray(slice.owners) && slice.owners.length > 0;
            if (hasOwner) {
                assignedArea += area;
            } else {
                unassignedArea += area;
                unassignedCount++;
            }
        }
        const coverage = totalArea > 0 ? assignedArea / totalArea : 0;
        // Completeness = every plot has an owner. Leftover/undrawn land is always
        // itself a plot, so it's caught here; tiny line-cut gaps aren't plots and
        // must not block commit, so we don't gate on the coverage fraction.
        const ok = state.slices.length > 0 && unassignedCount === 0;
        return { totalArea, assignedArea, unassignedArea, unassignedCount, coverage, ok };
    }

    function updateCommitState() {
        if (state.ownershipMode === 'single') {
            ensureCommitAvailability(Array.isArray(state.slices) && state.slices.length > 0);
            return;
        }
        const c = evaluatePlanCompleteness();
        ensureCommitAvailability(c.ok);
        if (!state.coverageEl) return;
        if (!state.slices.length) {
            state.coverageEl.textContent = '';
            state.coverageEl.removeAttribute('data-state');
            return;
        }
        if (c.ok) {
            state.coverageEl.setAttribute('data-state', 'ok');
            state.coverageEl.textContent = t(
                'reparcellization.modal.coverageComplete',
                'All pooled land assigned ({{pct}}%).',
                { pct: (c.coverage * 100).toFixed(1) }
            );
        } else {
            state.coverageEl.setAttribute('data-state', 'warn');
            state.coverageEl.textContent = t(
                'reparcellization.modal.coverageIncomplete',
                '{{count}} plot(s) unassigned · {{area}} not yet assigned ({{pct}}% covered).',
                {
                    count: c.unassignedCount,
                    area: formatArea(c.unassignedArea),
                    pct: (c.coverage * 100).toFixed(1)
                }
            );
        }
    }

    function updateLegend(ownerShares) {
        // ── Original Owners table ──
        if (state.legendListEl) {
            state.legendListEl.innerHTML = '';
            const table = document.createElement('table');
            table.className = 'reparcel-owners-table reparcel-ledger-table';
            const thead = document.createElement('thead');
            thead.innerHTML = `<tr>
                <th>${t('reparcellization.modal.colOwner', 'Owner')}</th>
                <th>${t('reparcellization.modal.colContributed', 'Pooled')}</th>
                <th>${t('reparcellization.modal.colAssigned', 'Assigned')}</th>
                <th>${t('reparcellization.modal.colBalance', 'Balance')}</th>
                <th>${t('reparcellization.modal.colCashOffer', 'Cash offer')}</th>
            </tr>`;
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            ownerShares.forEach((entry, index) => {
                const color = entry.color || pickOwnerColor(entry.ownerKey, index);
                entry.color = color;
                const ledger = computeOwnerLedger(entry);
                // Balance sign: + owner receives surplus land and pays, − owner is compensated.
                const balClass = Math.abs(ledger.cashBalance) < Math.max(1, ledger.entitled * 0.005)
                    ? 'bal-even'
                    : (ledger.cashBalance > 0 ? 'bal-pays' : 'bal-due');
                const balSign = ledger.cashBalance > 0 ? '+' : '';
                const cashOffer = getCashOffer(entry.ownerKey, ledger);
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><span class="legend-color" style="background:${color}"></span> ${entry.displayName}</td>
                    <td class="area-cell">${formatLedgerMetric(ledger.contributed)}</td>
                    <td class="area-cell">${formatLedgerMetric(ledger.assigned)}</td>
                    <td class="area-cell ${balClass}">${balSign}${formatLedgerMetric(ledger.cashBalance)}</td>
                    <td class="cash-offer-cell"><input type="number" class="cash-offer-input" min="0" step="1" data-owner-key="${entry.ownerKey}" value="${Math.round(cashOffer)}"></td>`;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            state.legendListEl.appendChild(table);

            // Wire cash-offer inputs (prefilled to the shortfall for compensated owners).
            state.legendListEl.querySelectorAll('.cash-offer-input').forEach(input => {
                input.addEventListener('input', () => {
                    const key = input.getAttribute('data-owner-key');
                    const val = Number(input.value);
                    state.cashOfferOverrides[key] = Number.isFinite(val) && val >= 0 ? val : 0;
                    updateCashTotalDisplay();
                });
            });
            updateCashTotalDisplay();
        }

        // ── New Plots table ──
        if (state.newPlotsListEl) {
            state.newPlotsListEl.innerHTML = '';
            if (!state.slices.length) { updateCommitState(); return; }
            const table = document.createElement('table');
            table.className = 'reparcel-newplots-table';
            const thead = document.createElement('thead');
            thead.innerHTML = `<tr>
                <th>${t('reparcellization.modal.colPlot', 'Plot')}</th>
                <th>${t('reparcellization.modal.colOwners', 'Owners')}</th>
            </tr>`;
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            state.slices.forEach((slice, idx) => {
                const area = computeFeatureArea({ type: 'Feature', geometry: slice.geometry });
                const owners = Array.isArray(slice.owners) && slice.owners.length
                    ? slice.owners
                    : [{ displayName: slice.displayName, color: slice.color }];
                const ownerHtml = owners.map(o => {
                    const needsBorder = o.ownerKey === PUBLIC_LAND_KEY || (o.color || '').toLowerCase() === '#ffffff';
                    const swatchStyle = `background:${o.color || '#ccc'}` + (needsBorder ? ';border:1px solid #9ca3af' : '');
                    return `<span class="newplot-owner"><span class="legend-color" style="${swatchStyle}"></span>${o.displayName || t('reparcellization.modal.unassigned', 'Unassigned')}</span>`;
                }).join('');
                const tr = document.createElement('tr');
                tr.className = 'reparcel-newplot-row';
                tr.innerHTML = `
                    <td class="plot-cell"><strong>${idx + 1}</strong> <span class="area-cell">${formatArea(area)}</span></td>
                    <td>${ownerHtml}</td>`;
                // Hovering a row highlights that plot on the map — makes it clear that
                // one plot can render as several disjoint pieces (carved MultiPolygon).
                tr.addEventListener('mouseenter', () => highlightSlice(idx, true));
                tr.addEventListener('mouseleave', () => highlightSlice(idx, false));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            state.newPlotsListEl.appendChild(table);
        }

        updateCommitState();
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
        // We want the angle such that when we rotate the parcel by -angle, 
        // the orientation line becomes horizontal (pointing east).
        // Then vertical cuts (perpendicular to east) will be correct.
        // After rotating back, those cuts will be perpendicular to the original orientation.
        //
        // turf.bearing gives azimuth: 0=north, 90=east, 180=south, -90=west
        // turf.transformRotate uses: positive = counter-clockwise
        // 
        // If bearing=90 (east), we want angle=0 (no rotation needed, cuts are already perpendicular)
        // If bearing=0 (north), we want angle=90 (rotate parcel 90° CW so north becomes east)
        // If bearing=45 (northeast), we want angle=45 (rotate 45° CW so NE becomes east)
        // 
        // Formula: angle = 90 - bearing
        // But wait - transformRotate with -angle rotates clockwise.
        // For bearing=0 (north): angle=90, -angle=-90, rotate 90° clockwise, north→east ✓
        // For bearing=45 (NE): angle=45, -angle=-45, rotate 45° clockwise, NE→east ✓
        // For bearing=90 (east): angle=0, no rotation, east stays east ✓

        if (typeof turf !== 'undefined' && turf.bearing) {
            try {
                const p1 = turf.point([start.lng, start.lat]);
                const p2 = turf.point([end.lng, end.lat]);
                const bearing = turf.bearing(p1, p2);
                const angle = 90 - bearing;
                return angle;
            } catch (e) {
                console.warn('[reparcellization] turf.bearing failed', e);
            }
        }
        // Fallback: account for latitude compression on longitude
        const midLat = (start.lat + end.lat) / 2;
        const cosLat = Math.cos(midLat * Math.PI / 180);
        const dx = (end.lng - start.lng) * cosLat;
        const dy = end.lat - start.lat;
        const fallbackAngle = Math.atan2(dy, dx) * (180 / Math.PI);
        return fallbackAngle;
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

    function extendLineAcrossView(latLngA, latLngB) {
        if (!state.map) return [latLngA, latLngB];
        const zoom = state.map.getZoom ? state.map.getZoom() : undefined;
        const a = state.map.project(latLngA, zoom);
        const b = state.map.project(latLngB, zoom);
        if (!state.map || !state.map._loaded) return [latLngA, latLngB];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return [latLngA, latLngB];

        const bounds = state.map.getPixelBounds();
        const corners = [
            { x: bounds.min.x, y: bounds.min.y },
            { x: bounds.max.x, y: bounds.min.y },
            { x: bounds.max.x, y: bounds.max.y },
            { x: bounds.min.x, y: bounds.max.y }
        ];
        const edges = [
            [corners[0], corners[1]],
            [corners[1], corners[2]],
            [corners[2], corners[3]],
            [corners[3], corners[0]]
        ];

        const intersects = [];
        edges.forEach(([p, q]) => {
            const ex = q.x - p.x;
            const ey = q.y - p.y;
            const det = dx * (-ey) - dy * (-ex);
            if (Math.abs(det) < 1e-9) return; // parallel
            const t = ((p.x - a.x) * (-ey) - (p.y - a.y) * (-ex)) / det;
            const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / det;
            if (u < -1e-6 || u > 1 + 1e-6) return; // outside segment
            intersects.push({
                t,
                point: { x: a.x + dx * t, y: a.y + dy * t }
            });
        });

        if (intersects.length < 2) {
            return [latLngA, latLngB];
        }

        intersects.sort((p1, p2) => p1.t - p2.t);
        const first = intersects[0].point;
        const last = intersects[intersects.length - 1].point;

        try {
            return [
                state.map.unproject(L.point(first.x, first.y), zoom),
                state.map.unproject(L.point(last.x, last.y), zoom)
            ];
        } catch (_) {
            return [latLngA, latLngB];
        }
    }

    function updateOrientationLineFromHandles() {
        const coords = getOrientationLineLatLngs();
        if (!coords || coords.length !== 2 || !state.orientationLine) return;
        const extended = extendLineAcrossView(coords[0], coords[1]);
        state.orientationLine.setLatLngs(extended);
    }

    function handleOrientationDrag() {
        updateOrientationLineFromHandles();
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
        handles.forEach(marker => marker.addTo(state.map));

        state.orientationLine = L.polyline(extendLineAcrossView(coords[0], coords[1]), {
            color: '#111',
            weight: 4,
            dashArray: '6 4',
            interactive: false
        }).addTo(state.map);

        // Keep line spanning current view on map moves
        state.map.on('moveend zoomend', updateOrientationLineFromHandles);
        // Initial draw
        updateOrientationLineFromHandles();
    }

    function buildOrientationLineFeature() {
        if (!state.superParcel) return null;

        // Build a line through the centroid, parallel to the handles line
        const centroid = getSuperParcelCentroidLngLat(state.superParcel);
        if (!centroid || !Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) {
            return null;
        }

        const orientationCoords = getOrientationLineLatLngs();
        if (!orientationCoords || orientationCoords.length < 2) {
            return null;
        }

        const [startHandle, endHandle] = orientationCoords;
        // Direction vector from handles (in lng/lat)
        const dirLng = endHandle.lng - startHandle.lng;
        const dirLat = endHandle.lat - startHandle.lat;
        const dirLen = Math.sqrt(dirLng * dirLng + dirLat * dirLat);
        if (dirLen < 1e-10) return null;

        // Normalize and scale to span the parcel
        const bbox = turf.bbox(state.superParcel);
        const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 4;
        const scale = span / dirLen;

        try {
            return turf.lineString([
                [centroid[0] - dirLng * scale, centroid[1] - dirLat * scale],
                [centroid[0] + dirLng * scale, centroid[1] + dirLat * scale]
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

        // The total cash compensation owed to short-changed owners IS the proposal's
        // offer. Prefill the offer field (in EUR) from the readjustment ledger so the
        // settlement is carried as the proposal's financial term.
        const totalCash = (typeof window !== 'undefined' && window.pendingReparcellizationPlan)
            ? Number(window.pendingReparcellizationPlan.totalCashOffer)
            : 0;
        if (Number.isFinite(totalCash) && totalCash > 0) {
            const currencySelect = document.getElementById('proposalCurrency');
            if (currencySelect && Array.from(currencySelect.options).some(o => o.value === 'EUR')) {
                currencySelect.value = 'EUR';
            }
            const offerInput = document.getElementById('proposalOffer');
            if (offerInput) {
                offerInput.value = String(Math.round(totalCash));
                // Run the app's offer formatter/handler if present so it stays consistent.
                if (typeof handleProposalOfferInput === 'function') {
                    try { handleProposalOfferInput(offerInput); } catch (_) { }
                }
            }
        }
    }

    // ── Plot partition helpers (non-overlap invariant) ───────────────────
    // Every piece of pooled land belongs to exactly one resultant plot. New
    // plots (drawn or imported) are clipped to the pool and subtracted from any
    // plot they overlap, so the plot set always stays a clean partition.

    function sliceToFeature(slice) {
        return { type: 'Feature', properties: {}, geometry: slice.geometry };
    }

    // Explode a geometry into one Polygon Feature per disjoint piece, so a split
    // that leaves several separate parts becomes several separate plots.
    function geometryToPolygonFeatures(geometry) {
        if (!geometry) return [];
        try {
            if (geometry.type === 'Polygon') return [turf.polygon(geometry.coordinates)];
            if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(c => turf.polygon(c));
        } catch (_) { /* ignore malformed */ }
        return [];
    }

    function cloneOwners(owners) {
        return (Array.isArray(owners) ? owners : []).map(o => ({
            ownerKey: o.ownerKey, displayName: o.displayName, color: o.color, share: o.share
        }));
    }

    // Replace a slice with its disjoint parts as independent plots (each keeps the
    // slice's owners). Pieces under 1 m² are dropped as slivers.
    function pushSliceParts(target, geometry, owners, source) {
        geometryToPolygonFeatures(geometry).forEach(part => {
            if (computeFeatureArea(part) < 1) return;
            target.push(makePlotFromOwners(part.geometry, cloneOwners(owners), source));
        });
    }

    function makePlotFromOwners(geometry, owners, source) {
        const safeOwners = (Array.isArray(owners) ? owners : []).map(o => ({
            ownerKey: o.ownerKey,
            displayName: o.displayName,
            color: o.color,
            share: o.share || 0
        }));
        if (safeOwners.length) {
            const equalShare = 1 / safeOwners.length;
            safeOwners.forEach(o => { if (!o.share) o.share = equalShare; });
        }
        const primary = safeOwners[0] || null;
        return {
            ownerKey: primary ? primary.ownerKey : '',
            displayName: primary
                ? (safeOwners.length > 1 ? safeOwners.map(o => o.displayName).join(' + ') : primary.displayName)
                : t('reparcellization.modal.unassigned', 'Unassigned'),
            percent: 0,
            color: safeOwners.length ? blendOwnerColors(safeOwners) : '#cccccc',
            geometry,
            owners: safeOwners,
            source: source || 'manual'
        };
    }

    function createUnassignedPlot(geometry, source) {
        return makePlotFromOwners(geometry, [], source || 'base');
    }

    // Carve a polygon into the current plan: clip to the pool, subtract it from
    // every overlapping plot, then add it as a new plot. Returns true on success.
    function carvePlotIntoPlan(polygonFeature, ownersForNew, source) {
        if (typeof turf === 'undefined' || !state.superParcel) return false;
        let clipped = null;
        try { clipped = turf.intersect(state.superParcel, polygonFeature); } catch (_) { clipped = null; }
        if (!clipped || !clipped.geometry) return false;
        const newArea = computeFeatureArea(clipped);
        if (!newArea || newArea < 1) return false; // ignore slivers < 1 m²

        const remaining = [];
        for (const slice of state.slices) {
            let diff = null;
            try { diff = turf.difference(sliceToFeature(slice), clipped); } catch (_) { diff = sliceToFeature(slice); }
            if (!diff || !diff.geometry) continue;            // fully consumed by the new plot
            // A subtraction can split a plot into disjoint parts → separate plots.
            pushSliceParts(remaining, diff.geometry, slice.owners, slice.source);
        }
        // The new plot itself may be disjoint (drawn across a gap) → separate plots.
        pushSliceParts(remaining, clipped.geometry, ownersForNew, source);
        state.slices = remaining;
        return true;
    }

    // Exact split of one polygon by a line, sharing the boundary (no gap): node the
    // polygon boundary and the inside portion of the cut against each other, then
    // polygonize the result into faces. Returns the face Features, or null if the
    // line doesn't divide the polygon.
    function splitPolygonByLineExact(polygon, line) {
        if (typeof turf.polygonize !== 'function' || typeof turf.lineSplit !== 'function') return null;
        try {
            // Boundary as one or more LineStrings (a plot may be a donut with holes).
            const boundary = turf.polygonToLine(polygon);
            const boundaryLines = [];
            if (boundary.geometry.type === 'LineString') {
                boundaryLines.push(boundary);
            } else if (boundary.geometry.type === 'MultiLineString') {
                boundary.geometry.coordinates.forEach(c => boundaryLines.push(turf.lineString(c)));
            } else if (boundary.type === 'FeatureCollection') {
                boundary.features.forEach(f => boundaryLines.push(f));
            }

            const edges = [];
            // Boundary arcs, noded where the cut crosses them.
            boundaryLines.forEach(bl => {
                let sp = null;
                try { sp = turf.lineSplit(bl, line); } catch (_) { sp = null; }
                if (sp && sp.features.length) edges.push(...sp.features);
                else edges.push(bl);
            });
            // Only the portion(s) of the cut line that lie inside the polygon.
            let cutPieces = null;
            try { cutPieces = turf.lineSplit(line, polygon); } catch (_) { cutPieces = null; }
            const innerCut = (cutPieces ? cutPieces.features : []).filter(seg => {
                const coords = seg.geometry.coordinates;
                if (!coords || coords.length < 2) return false;
                const mid = turf.midpoint(turf.point(coords[0]), turf.point(coords[coords.length - 1]));
                return turf.booleanPointInPolygon(mid, polygon);
            });
            if (!innerCut.length) return null; // line never enters the polygon
            edges.push(...innerCut);

            const faces = turf.polygonize(turf.featureCollection(edges));
            if (!faces || !faces.features || faces.features.length < 2) return null;
            // Keep faces that actually lie inside the original polygon.
            const inside = faces.features.filter(f => {
                try {
                    const p = turf.pointOnFeature(f);
                    return turf.booleanPointInPolygon(p, polygon);
                } catch (_) { return false; }
            });
            return inside.length >= 2 ? inside : null;
        } catch (err) {
            console.warn('[reparcellization] exact line split failed', err);
            return null;
        }
    }

    // Split the plots a line crosses into separate plots, sharing exact edges.
    // Falls back to a hair-thin buffer cut if the exact split can't be computed.
    function splitPlanWithLine(lineFeature) {
        if (typeof turf === 'undefined' || !lineFeature) return false;
        const remaining = [];
        let didSplit = false;
        for (const slice of state.slices) {
            const components = geometryToPolygonFeatures(slice.geometry);
            let splitThis = false;
            const facesForSlice = [];
            components.forEach(comp => {
                const faces = splitPolygonByLineExact(comp, lineFeature);
                if (faces && faces.length >= 2) {
                    splitThis = true;
                    faces.forEach(f => facesForSlice.push(f));
                } else {
                    facesForSlice.push(comp); // not crossed → unchanged
                }
            });
            if (splitThis) {
                didSplit = true;
                facesForSlice.forEach(f => {
                    if (computeFeatureArea(f) < 1) return;
                    remaining.push(makePlotFromOwners(f.geometry, cloneOwners(slice.owners), slice.source));
                });
            } else {
                remaining.push(slice); // keep original plot untouched
            }
        }
        if (didSplit) {
            state.slices = remaining;
            return true;
        }
        return splitPlanWithLineBuffer(lineFeature);
    }

    // Fallback splitter: subtract a hair-thin buffer of the line so crossed plots
    // divide; disjoint results become separate plots. Loses a negligible sliver.
    const CUT_HALF_WIDTH_M = 0.05; // 10 cm cut
    function splitPlanWithLineBuffer(lineFeature) {
        let cut = null;
        try { cut = turf.buffer(lineFeature, CUT_HALF_WIDTH_M, { units: 'meters', steps: 1 }); } catch (_) { cut = null; }
        if (!cut || !cut.geometry) return false;

        const remaining = [];
        let didSplit = false;
        for (const slice of state.slices) {
            let diff = null;
            try { diff = turf.difference(sliceToFeature(slice), cut); } catch (_) { diff = sliceToFeature(slice); }
            if (!diff || !diff.geometry) { didSplit = true; continue; } // entire slice inside the cut
            const before = remaining.length;
            pushSliceParts(remaining, diff.geometry, slice.owners, slice.source);
            if (remaining.length - before > 1) didSplit = true;
        }
        if (!didSplit) return false; // line crossed nothing → no-op
        state.slices = remaining;
        return true;
    }

    // Extend a polyline's two ends outward so a line drawn roughly across a plot
    // fully crosses it (a cut that stops inside won't separate the plot).
    function extendPolylineEnds(points, extendDeg) {
        if (!Array.isArray(points) || points.length < 2) return points;
        const out = points.map(p => p.slice());
        const ext = (a, b) => {
            const dx = a[0] - b[0];
            const dy = a[1] - b[1];
            const len = Math.hypot(dx, dy) || 1;
            return [a[0] + (dx / len) * extendDeg, a[1] + (dy / len) * extendDeg];
        };
        out[0] = ext(points[0], points[1]);
        out[out.length - 1] = ext(points[points.length - 1], points[points.length - 2]);
        return out;
    }

    // ── Manual plot drawing ──────────────────────────────────────────────

    // Drawing/splitting only applies to the Manual (blank-slate) layout, so the
    // pencil/scissors icons are disabled (greyed out) for other algorithms.
    function updateDrawToolButtons() {
        const enabled = state.ownershipMode === 'multiple' && state.algorithm === 'manual';
        [state.drawBtn, state.lineBtn].forEach(btn => { if (btn) btn.disabled = !enabled; });
    }

    function setDrawButtonsActive() {
        const active = state.drawing.active;
        const polyOn = active && state.drawing.mode === 'polygon';
        const lineOn = active && state.drawing.mode === 'line';
        if (state.drawBtn) {
            state.drawBtn.classList.toggle('active', polyOn);
            state.drawBtn.setAttribute('aria-pressed', polyOn ? 'true' : 'false');
        }
        if (state.lineBtn) {
            state.lineBtn.classList.toggle('active', lineOn);
            state.lineBtn.setAttribute('aria-pressed', lineOn ? 'true' : 'false');
        }
    }

    function clearDrawTemp() {
        if (state.drawing.tempLayer) {
            try { state.drawing.tempLayer.remove(); } catch (_) { }
            state.drawing.tempLayer = null;
        }
        if (Array.isArray(state.drawing.tempMarkers)) {
            state.drawing.tempMarkers.forEach(m => { try { m.remove(); } catch (_) { } });
        }
        state.drawing.tempMarkers = [];
    }

    function getVertexIcon() {
        return L.divIcon({ className: 'reparcel-vertex-handle', iconSize: [14, 14], iconAnchor: [7, 7] });
    }

    // Redraw only the in-progress shape from the current points. Polygon mode shows
    // a filled polygon at ≥3 points; line mode always shows a polyline. Used live
    // during vertex drags without rebuilding markers.
    function updateDrawShape() {
        if (state.drawing.tempLayer) {
            try { state.drawing.tempLayer.remove(); } catch (_) { }
            state.drawing.tempLayer = null;
        }
        if (!state.map) return;
        const latlngs = state.drawing.points.map(([lng, lat]) => L.latLng(lat, lng));
        if (latlngs.length < 2) return;
        if (state.drawing.mode === 'line') {
            state.drawing.tempLayer = L.polyline(latlngs, {
                color: '#C73E1D', weight: 3, dashArray: '6 4', interactive: false
            }).addTo(state.map);
        } else if (latlngs.length >= 3) {
            state.drawing.tempLayer = L.polygon(latlngs, {
                color: '#1B998B', weight: 2, dashArray: '5 4', fillColor: '#1B998B', fillOpacity: 0.25, interactive: false
            }).addTo(state.map);
        } else {
            state.drawing.tempLayer = L.polyline(latlngs, {
                color: '#1B998B', weight: 2, dashArray: '5 4', interactive: false
            }).addTo(state.map);
        }
    }

    function renderDrawTemp() {
        clearDrawTemp();
        if (!state.map) return;
        updateDrawShape();
        // Draggable vertex handles so the user can fine-tune the shape before finishing.
        state.drawing.points.forEach((pt, i) => {
            const marker = L.marker(L.latLng(pt[1], pt[0]), {
                draggable: true,
                keyboard: false,
                icon: getVertexIcon()
            });
            marker.on('drag', () => {
                const ll = marker.getLatLng();
                state.drawing.points[i] = [ll.lng, ll.lat];
                updateDrawShape();
            });
            marker.addTo(state.map);
            state.drawing.tempMarkers.push(marker);
        });
    }

    function onDrawClick(e) {
        if (!state.drawing.active) return;
        state.drawing.points.push([e.latlng.lng, e.latlng.lat]);
        renderDrawTemp();
        updateDrawToolbar();
    }

    function undoLastPoint() {
        if (!state.drawing.active || !state.drawing.points.length) return;
        state.drawing.points.pop();
        renderDrawTemp();
        updateDrawToolbar();
    }

    // Show the Finish/Undo/Cancel toolbar while drawing. Finish needs ≥3 points for
    // a polygon plot, ≥2 for a split line; the Finish label reflects the mode.
    function updateDrawToolbar() {
        const isLine = state.drawing.mode === 'line';
        const minPoints = isLine ? 2 : 3;
        if (state.drawToolbar) state.drawToolbar.hidden = !state.drawing.active;
        if (state.finishBtn) {
            state.finishBtn.disabled = state.drawing.points.length < minPoints;
            const checkPrefix = '✓ ';
            state.finishBtn.textContent = checkPrefix + (isLine
                ? t('reparcellization.modal.drawFinishLine', 'Finish line')
                : t('reparcellization.modal.drawFinish', 'Finish plot'));
        }
        if (state.undoBtn) state.undoBtn.disabled = state.drawing.points.length === 0;
    }

    // Drop consecutive near-duplicate vertices (e.g. an accidental double map click
    // placing the same point twice) before building the polygon.
    function dedupeDrawPoints(points) {
        const out = [];
        for (const p of points) {
            const prev = out[out.length - 1];
            if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
            out.push(p);
        }
        return out;
    }

    function onDrawFinish() {
        if (!state.drawing.active) return;
        const pts = dedupeDrawPoints(state.drawing.points.slice());

        if (state.drawing.mode === 'line') {
            if (pts.length < 2) {
                setStatus(t('reparcellization.modal.status.lineTooFew', 'Add at least 2 points to make a split line.'), 'warning');
                return;
            }
            // Extend the ends so a line drawn roughly across a plot fully crosses it.
            const span = state.superParcel ? Math.max.apply(null, (() => {
                const b = turf.bbox(state.superParcel);
                return [b[2] - b[0], b[3] - b[1]];
            })()) : 0.001;
            const extended = extendPolylineEnds(pts, span * 0.25);
            let line = null;
            try { line = turf.lineString(extended); } catch (_) { line = null; }
            if (!line) {
                setStatus(t('reparcellization.modal.status.drawInvalid', 'Could not build a valid plot from those points.'), 'error');
                cancelDraw();
                return;
            }
            const ok = splitPlanWithLine(line);
            cancelDraw();
            if (!ok) {
                setStatus(t('reparcellization.modal.status.lineNoSplit', 'The line did not cross any plot to split.'), 'error');
                return;
            }
            setStatus(t('reparcellization.modal.status.lineSuccess', 'Plot split. Click each part to assign owners.'), 'info');
            updateLegend(state.ownerShares);
            drawPreview();
            updateCommitState();
            return;
        }

        if (pts.length < 3) {
            setStatus(t('reparcellization.modal.status.drawTooFew', 'Add at least 3 points to make a plot.'), 'warning');
            return;
        }
        const ring = pts.concat([pts[0]]);
        let polygon = null;
        try { polygon = turf.polygon([ring]); } catch (_) { polygon = null; }
        // Self-intersecting / degenerate rings → bail rather than produce bad geometry.
        if (!polygon || computeFeatureArea(polygon) < 1) {
            setStatus(t('reparcellization.modal.status.drawInvalid', 'Could not build a valid plot from those points.'), 'error');
            cancelDraw();
            return;
        }
        const ok = carvePlotIntoPlan(polygon, [], 'manual');
        cancelDraw();
        if (!ok) {
            setStatus(t('reparcellization.modal.status.drawNoOverlap', 'The drawn plot is outside the pooled land.'), 'error');
            return;
        }
        setStatus(t('reparcellization.modal.status.drawSuccess', 'Plot added. Click it to assign owners.'), 'info');
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
    }

    function startDraw(mode) {
        if (!state.map) return;
        exitCompare(); // editing and before/after are mutually exclusive
        dismissOwnerPopup();
        state.drawing.active = true;
        state.drawing.mode = mode === 'line' ? 'line' : 'polygon';
        state.drawing.points = [];
        clearDrawTemp();
        try { state.map.getContainer().style.cursor = 'crosshair'; } catch (_) { }
        state.map.on('click', onDrawClick);
        setDrawButtonsActive();
        updateDrawToolbar();
        setStatus(state.drawing.mode === 'line'
            ? t('reparcellization.modal.status.lineHint', 'Click to add points, drag to adjust, then press Finish to split.')
            : t('reparcellization.modal.status.drawHint', 'Click to add points, drag to adjust, then press Finish.'), 'info');
    }

    function cancelDraw() {
        clearDrawTemp();
        state.drawing.active = false;
        state.drawing.points = [];
        if (state.map) {
            state.map.off('click', onDrawClick);
            try { state.map.getContainer().style.cursor = ''; } catch (_) { }
        }
        setDrawButtonsActive();
        updateDrawToolbar();
    }

    // Toggle a draw mode: clicking the active mode's button cancels; clicking the
    // other button switches mode without leaving drawing.
    function toggleDrawMode(mode) {
        const target = mode === 'line' ? 'line' : 'polygon';
        if (state.drawing.active && state.drawing.mode === target) {
            cancelDraw();
            setStatus('', 'info');
        } else {
            cancelDraw();
            startDraw(target);
        }
    }

    // ── GeoJSON Upload ──────────────────────────────────────────────────

    function handleGeojsonUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (evt) {
            try {
                const geojson = JSON.parse(evt.target.result);
                const features = geojson.type === 'FeatureCollection'
                    ? geojson.features
                    : geojson.type === 'Feature'
                        ? [geojson]
                        : (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon')
                            ? [{ type: 'Feature', properties: {}, geometry: geojson }]
                            : [];
                if (!features.length) {
                    setStatus(
                        t('reparcellization.modal.status.uploadEmpty', 'Uploaded file contains no polygon features.'),
                        'error'
                    );
                    return;
                }
                applyUploadedGeometry(features);
            } catch (err) {
                console.warn('[reparcellization] GeoJSON parse error', err);
                setStatus(
                    t('reparcellization.modal.status.uploadParseError', 'Failed to parse GeoJSON file.'),
                    'error'
                );
            }
        };
        reader.readAsText(file);
    }

    function applyUploadedGeometry(features) {
        if (typeof turf === 'undefined') {
            setStatus('turf.js is required for GeoJSON upload.', 'error');
            return;
        }
        exitCompare(); // editing exits before/after
        // Treat the file as a full layout: reset to one pool-wide base plot, then
        // carve each imported polygon into it in order. carvePlotIntoPlan clips
        // to the pool and subtracts overlaps, so the result is always a clean
        // partition even if the file's polygons overlap each other. Any land the
        // import doesn't cover stays as a single (unassigned) leftover plot.
        state.slices = [createUnassignedPlot(state.superParcel.geometry, 'base')];
        let added = 0;
        features.forEach((feature, index) => {
            if (!feature || !feature.geometry) return;
            const geomType = feature.geometry.type;
            if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') return;
            const owner = state.ownerShares.length ? state.ownerShares[index % state.ownerShares.length] : null;
            const owners = owner
                ? [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }]
                : [];
            if (carvePlotIntoPlan(feature, owners, 'geojson')) added++;
        });
        if (!added) {
            state.slices = [];
            setStatus(
                t('reparcellization.modal.status.uploadNoOverlap', 'Uploaded polygons do not overlap with selected parcels.'),
                'error'
            );
            updateLegend(state.ownerShares);
            drawPreview();
            updateCommitState();
            return;
        }
        state.uploadedGeometry = features;
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
        setStatus(
            t('reparcellization.modal.status.uploadSuccess', 'Loaded {{count}} polygons from file.', { count: added }),
            'info'
        );
    }

    // ── Shuffle Ownership ────────────────────────────────────────────────

    function shuffleOwnership() {
        if (!state.slices.length || !state.ownerShares.length) return;
        exitCompare(); // editing exits before/after
        // Fisher-Yates shuffle of owner assignments
        const ownerPool = state.ownerShares.slice();
        const assignments = [];
        for (let i = 0; i < state.slices.length; i++) {
            assignments.push(ownerPool[i % ownerPool.length]);
        }
        for (let i = assignments.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
        }
        state.slices.forEach((slice, index) => {
            const owner = assignments[index];
            slice.ownerKey = owner.ownerKey;
            slice.displayName = owner.displayName;
            slice.color = owner.color;
            slice.owners = [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }];
        });
        updateLegend(state.ownerShares);
        drawPreview();
    }

    // ── Click-to-assign Owner ────────────────────────────────────────────

    function dismissOwnerPopup() {
        if (state.ownerAssignmentPopup) {
            try { state.map.closePopup(state.ownerAssignmentPopup); } catch (_) { }
            state.ownerAssignmentPopup = null;
        }
        if (state.selectedSliceIndex !== null) {
            // Deferred full redraw after popup closes so layers reflect final state
            state.selectedSliceIndex = null;
            updateLegend(state.ownerShares);
            drawPreview();
        }
    }

    function onSliceClick(sliceIndex, latlng) {
        if (state.drawing.active || state.compare.active) return; // not while drawing/comparing
        // If a popup is already open, close it (triggers redraw via dismissOwnerPopup)
        if (state.ownerAssignmentPopup) {
            try { state.map.closePopup(state.ownerAssignmentPopup); } catch (_) { }
            state.ownerAssignmentPopup = null;
            // If clicking the same slice, just toggle off
            if (state.selectedSliceIndex === sliceIndex) {
                state.selectedSliceIndex = null;
                updateLegend(state.ownerShares);
                drawPreview();
                return;
            }
            state.selectedSliceIndex = null;
        }
        if (!state.ownerShares.length || sliceIndex < 0 || sliceIndex >= state.slices.length) return;
        state.selectedSliceIndex = sliceIndex;
        const slice = state.slices[sliceIndex];
        if (!slice.owners) {
            slice.owners = [{ ownerKey: slice.ownerKey, displayName: slice.displayName, color: slice.color, share: 1 }];
        }

        const container = document.createElement('div');
        container.className = 'reparcel-owner-popup';

        const title = document.createElement('div');
        title.className = 'reparcel-owner-popup__title';
        title.textContent = t('reparcellization.modal.assignOwners', 'Assign owners');
        container.appendChild(title);

        const ownerList = document.createElement('div');
        ownerList.className = 'reparcel-owner-popup__list';

        // Real owners plus the "Public land" option (land set aside for public use).
        const assignableOwners = state.ownerShares.concat([getPublicLandOwner()]);
        assignableOwners.forEach((owner) => {
            const isAssigned = slice.owners.some(o => o.ownerKey === owner.ownerKey);
            const row = document.createElement('label');
            row.className = 'reparcel-owner-popup__row' + (isAssigned ? ' assigned' : '');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = isAssigned;
            checkbox.addEventListener('change', (evt) => {
                evt.stopPropagation();
                toggleOwnerOnSlice(sliceIndex, owner, checkbox.checked);
                row.classList.toggle('assigned', checkbox.checked);
                syncSlicePrimaryOwner(sliceIndex);
            });

            const swatch = document.createElement('span');
            swatch.className = 'legend-color';
            swatch.style.background = owner.color;
            if (owner.ownerKey === PUBLIC_LAND_KEY) swatch.style.border = '1px solid #9ca3af';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = owner.displayName;

            row.appendChild(checkbox);
            row.appendChild(swatch);
            row.appendChild(nameSpan);
            ownerList.appendChild(row);
        });
        container.appendChild(ownerList);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'reparcel-owner-popup__close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            dismissOwnerPopup();
        });
        container.appendChild(closeBtn);

        const popup = L.popup({
            closeButton: false,
            className: 'reparcel-owner-leaflet-popup',
            maxWidth: 280,
            autoPan: true,
            closeOnClick: false
        })
            .setLatLng(latlng)
            .setContent(container);

        popup.on('remove', () => {
            if (state.ownerAssignmentPopup === popup) {
                state.ownerAssignmentPopup = null;
                if (state.selectedSliceIndex !== null) {
                    state.selectedSliceIndex = null;
                    updateLegend(state.ownerShares);
                    drawPreview();
                }
            }
        });

        popup.openOn(state.map);
        state.ownerAssignmentPopup = popup;
    }

    function toggleOwnerOnSlice(sliceIndex, owner, add) {
        const slice = state.slices[sliceIndex];
        if (!slice.owners) {
            slice.owners = [{ ownerKey: slice.ownerKey, displayName: slice.displayName, color: slice.color, share: 1 }];
        }
        if (add) {
            if (!slice.owners.some(o => o.ownerKey === owner.ownerKey)) {
                slice.owners.push({ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 0 });
                const equalShare = 1 / slice.owners.length;
                slice.owners.forEach(o => { o.share = equalShare; });
            }
        } else {
            slice.owners = slice.owners.filter(o => o.ownerKey !== owner.ownerKey);
            if (slice.owners.length) {
                const equalShare = 1 / slice.owners.length;
                slice.owners.forEach(o => { o.share = equalShare; });
            }
        }
    }

    function parseHexColor(hex) {
        const h = hex.replace('#', '');
        return [
            parseInt(h.substring(0, 2), 16),
            parseInt(h.substring(2, 4), 16),
            parseInt(h.substring(4, 6), 16)
        ];
    }

    function blendOwnerColors(owners) {
        if (!owners || !owners.length) return '#888';
        if (owners.length === 1) return owners[0].color || '#888';
        let r = 0, g = 0, b = 0;
        for (const o of owners) {
            const [cr, cg, cb] = parseHexColor(o.color || '#888888');
            r += cr;
            g += cg;
            b += cb;
        }
        const n = owners.length;
        const toHex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    function syncSlicePrimaryOwner(sliceIndex) {
        const slice = state.slices[sliceIndex];
        if (!slice.owners || !slice.owners.length) {
            slice.ownerKey = '';
            slice.displayName = t('reparcellization.modal.unassigned', 'Unassigned');
            slice.color = '#cccccc';
        } else {
            const primary = slice.owners[0];
            slice.ownerKey = primary.ownerKey;
            slice.displayName = slice.owners.length > 1
                ? slice.owners.map(o => o.displayName).join(' + ')
                : primary.displayName;
            slice.color = blendOwnerColors(slice.owners);
        }

        // Live-update the map layer for this slice without destroying the popup
        if (state.previewLayer) {
            let layerIndex = 0;
            state.previewLayer.eachLayer((layer) => {
                if (layerIndex === sliceIndex) {
                    const isMulti = Array.isArray(slice.owners) && slice.owners.length > 1;
                    layer.setStyle({
                        fillColor: slice.color,
                        color: isMulti ? '#000' : '#333',
                        weight: isMulti ? 2 : 1,
                        dashArray: isMulti ? '6 3' : null
                    });
                    // Update tooltip
                    layer.unbindTooltip();
                    const ownerNames = Array.isArray(slice.owners) && slice.owners.length
                        ? slice.owners.map(o => o.displayName).join(', ')
                        : slice.displayName;
                    layer.bindTooltip(ownerNames, { sticky: true, className: 'reparcel-slice-tooltip' });
                    // Update feature properties for consistency
                    if (layer.feature && layer.feature.properties) {
                        layer.feature.properties.color = slice.color;
                        layer.feature.properties.displayName = slice.displayName;
                        layer.feature.properties.ownerNames = ownerNames;
                        layer.feature.properties.isMultiOwner = isMulti;
                    }
                }
                layerIndex++;
            });
        }

        // Live-update the legend tables
        updateLegend(state.ownerShares);
    }

    // ── Sweep-line orientation ───────────────────────────────────────────
    // A draggable point on the map sets the direction the strip cut-lines point
    // toward. Bearing 0 (point due north of centroid) == the default vertical cuts.

    function getSweepBearing() {
        if (!state.sweepHandle || !state.superParcel) return 0;
        const c = getSuperParcelCentroidLngLat(state.superParcel);
        if (!c) return 0;
        const ll = state.sweepHandle.getLatLng();
        try {
            return turf.bearing(turf.point(c), turf.point([ll.lng, ll.lat]));
        } catch (_) {
            return 0;
        }
    }

    // Slice value-proportional strips oriented toward the sweep point: rotate the
    // pool so that direction becomes vertical, run the standard vertical sweep,
    // then rotate the resulting slices back.
    function computeSweepSlices() {
        if (!state.superParcel || !state.ownerShares.length) return [];
        const bearing = getSweepBearing();
        if (!bearing || typeof turf.transformRotate !== 'function') {
            return sliceWithSweepLine(state.superParcel, state.ownerShares);
        }
        const pivot = getSuperParcelCentroidLngLat(state.superParcel);
        if (!pivot) return sliceWithSweepLine(state.superParcel, state.ownerShares);
        const pivotPt = turf.point(pivot);
        let rotated = null;
        try {
            rotated = turf.transformRotate(JSON.parse(JSON.stringify(state.superParcel)), -bearing, { pivot: pivotPt });
        } catch (_) {
            return sliceWithSweepLine(state.superParcel, state.ownerShares);
        }
        const slices = sliceWithSweepLine(rotated, state.ownerShares);
        return slices.map(s => {
            let geom = s.geometry;
            try {
                geom = turf.transformRotate(turf.feature(s.geometry), bearing, { pivot: pivotPt }).geometry;
            } catch (_) { /* keep rotated-frame geometry as fallback */ }
            return Object.assign({}, s, { geometry: geom });
        });
    }

    function getSweepIcon() {
        return L.divIcon({ className: 'reparcel-sweep-handle', iconSize: [22, 22], iconAnchor: [11, 11] });
    }

    function updateSweepDirLine() {
        if (!state.sweepHandle || !state.superParcel || !state.map) return;
        const c = getSuperParcelCentroidLngLat(state.superParcel);
        if (!c) return;
        const latlngs = [L.latLng(c[1], c[0]), state.sweepHandle.getLatLng()];
        if (state.sweepDirLayer) {
            state.sweepDirLayer.setLatLngs(latlngs);
        } else {
            state.sweepDirLayer = L.polyline(latlngs, {
                color: '#7A1CAC', weight: 2, dashArray: '4 4', interactive: false
            }).addTo(state.map);
        }
        // bringToFront throws if the path isn't attached to the DOM yet (map not laid
        // out at init time); it's only needed to stay above slices, so ignore failures.
        try { if (state.sweepDirLayer.bringToFront) state.sweepDirLayer.bringToFront(); } catch (_) { }
    }

    function onSweepDrag() {
        if (state.compare.active) exitCompare(); // editing exits before/after
        updateSweepDirLine();
        state.slices = computeSweepSlices();
        updateLegend(state.ownerShares);
        drawPreview();
    }

    function initSweepOrientation() {
        if (!state.map || state.ownershipMode !== 'multiple' || state.algorithm !== 'sweep-line') return;
        if (state.sweepHandle) return;
        const c = getSuperParcelCentroidLngLat(state.superParcel);
        if (!c) return;
        const bbox = turf.bbox(state.superParcel);
        const offset = Math.max(bbox[3] - bbox[1], bbox[2] - bbox[0]) * 0.35;
        // Default due north of the centroid → bearing 0 → unchanged vertical cuts.
        state.sweepHandle = L.marker(L.latLng(c[1] + offset, c[0]), {
            draggable: true, keyboard: false, icon: getSweepIcon(), riseOnHover: true,
            title: t('reparcellization.modal.sweepHandleHint', 'Drag to rotate the parcel lines')
        });
        state.sweepHandle.on('drag', onSweepDrag);
        state.sweepHandle.addTo(state.map);
        updateSweepDirLine();
    }

    function destroySweepOrientation() {
        if (state.sweepHandle) { try { state.sweepHandle.remove(); } catch (_) { } state.sweepHandle = null; }
        if (state.sweepDirLayer) { try { state.sweepDirLayer.remove(); } catch (_) { } state.sweepDirLayer = null; }
    }

    // ── Before/After swipe comparison ────────────────────────────────────
    // The main map shows the "after" plots (by owner). A second map showing the
    // "before" original parcels (by owner) is stacked on top and clipped by a
    // draggable divider. The main map is frozen while comparing so the two views
    // stay aligned; exiting restores normal pan/zoom and editing.

    function parcelColorForBefore(parcelId) {
        const matches = state.ownerShares.filter(o => Array.isArray(o.parcelIds) && o.parcelIds.includes(parcelId));
        if (!matches.length) return '#cccccc';
        return blendOwnerColors(matches.map(o => ({ color: o.color })));
    }

    function buildBeforeFeatureCollection() {
        const layers = (state.selection && state.selection.layers) || [];
        const features = [];
        layers.forEach(layer => {
            const f = layer && layer.feature;
            if (!f || !f.geometry) return;
            const props = f.properties || {};
            const pid = props.parcelId || props.parcel_id || props.id;
            features.push({ type: 'Feature', properties: { color: parcelColorForBefore(pid) }, geometry: f.geometry });
        });
        return { type: 'FeatureCollection', features };
    }

    const COMPARE_FREEZE = ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'touchZoom', 'boxZoom', 'keyboard'];

    function updateCompareClip() {
        if (!state.compare.active || !state.map) return;
        const W = state.map.getContainer().clientWidth;
        const x = Math.max(0, Math.min(W, state.compare.x));
        if (state.compare.beforeEl) state.compare.beforeEl.style.clipPath = `inset(0 ${Math.max(0, W - x)}px 0 0)`;
        if (state.compare.handleEl) state.compare.handleEl.style.left = x + 'px';
    }

    function enterCompare() {
        if (!state.map || state.compare.active || !state.slices.length) return;
        cancelDraw();
        dismissOwnerPopup();
        const container = state.map.getContainer();
        COMPARE_FREEZE.forEach(h => { try { state.map[h] && state.map[h].disable(); } catch (_) { } });

        const beforeEl = document.createElement('div');
        beforeEl.className = 'reparcel-before-map';
        container.appendChild(beforeEl);

        const handleEl = document.createElement('div');
        handleEl.className = 'reparcel-compare-handle';
        handleEl.innerHTML = '<span class="reparcel-compare-grip">↔</span>';
        container.appendChild(handleEl);

        const beforeLabel = document.createElement('div');
        beforeLabel.className = 'reparcel-compare-label reparcel-compare-label--before';
        beforeLabel.textContent = t('reparcellization.modal.labelBefore', 'Before');
        const afterLabel = document.createElement('div');
        afterLabel.className = 'reparcel-compare-label reparcel-compare-label--after';
        afterLabel.textContent = t('reparcellization.modal.labelAfter', 'After');
        container.appendChild(beforeLabel);
        container.appendChild(afterLabel);

        state.compare.active = true;
        state.compare.beforeEl = beforeEl;
        state.compare.handleEl = handleEl;
        state.compare.labels = [beforeLabel, afterLabel];
        state.compare.x = container.clientWidth / 2;

        const map2 = L.map(beforeEl, { zoomControl: false, attributionControl: false, fadeAnimation: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 19, minZoom: 3 }).addTo(map2);
        map2.setView(state.map.getCenter(), state.map.getZoom(), { animate: false });
        L.geoJSON(buildBeforeFeatureCollection(), {
            style: f => ({ color: '#333', weight: 1, fillOpacity: 0.55, fillColor: (f.properties && f.properties.color) || '#888' })
        }).addTo(map2);
        L.geoJSON(state.superParcel, { style: { color: '#111', weight: 2, fillOpacity: 0 }, interactive: false }).addTo(map2);
        state.compare.map2 = map2;
        setTimeout(() => {
            try { map2.invalidateSize(); map2.setView(state.map.getCenter(), state.map.getZoom(), { animate: false }); updateCompareClip(); } catch (_) { }
        }, 60);

        const onMove = (clientX) => {
            const rect = container.getBoundingClientRect();
            state.compare.x = Math.max(0, Math.min(rect.width, clientX - rect.left));
            updateCompareClip();
        };
        const ptrMove = (e) => { onMove(e.touches ? e.touches[0].clientX : e.clientX); if (e.cancelable) e.preventDefault(); };
        const ptrUp = () => {
            document.removeEventListener('mousemove', ptrMove);
            document.removeEventListener('mouseup', ptrUp);
            document.removeEventListener('touchmove', ptrMove);
            document.removeEventListener('touchend', ptrUp);
        };
        const ptrDown = (e) => {
            e.preventDefault();
            document.addEventListener('mousemove', ptrMove);
            document.addEventListener('mouseup', ptrUp);
            document.addEventListener('touchmove', ptrMove, { passive: false });
            document.addEventListener('touchend', ptrUp);
        };
        handleEl.addEventListener('mousedown', ptrDown);
        handleEl.addEventListener('touchstart', ptrDown, { passive: false });
        state.compare.cleanupDrag = ptrUp;

        updateCompareClip();
        if (state.compareBtn) state.compareBtn.classList.add('active');
    }

    function exitCompare() {
        if (!state.compare.active) return;
        if (state.compare.cleanupDrag) { try { state.compare.cleanupDrag(); } catch (_) { } state.compare.cleanupDrag = null; }
        if (state.compare.map2) { try { state.compare.map2.remove(); } catch (_) { } state.compare.map2 = null; }
        ['beforeEl', 'handleEl'].forEach(k => { if (state.compare[k]) { try { state.compare[k].remove(); } catch (_) { } state.compare[k] = null; } });
        if (state.compare.labels) { state.compare.labels.forEach(l => { try { l.remove(); } catch (_) { } }); state.compare.labels = null; }
        state.compare.active = false;
        if (state.map) COMPARE_FREEZE.forEach(h => { try { state.map[h] && state.map[h].enable(); } catch (_) { } });
        if (state.compareBtn) state.compareBtn.classList.remove('active');
    }

    function toggleCompare() {
        if (state.compare.active) {
            exitCompare();
        } else if (state.slices.length) {
            enterCompare();
        }
    }

    // Base (un-highlighted) Leaflet style for a plot, matching drawPreview's style fn.
    function sliceBaseStyle(slice) {
        const isMulti = Array.isArray(slice.owners) && slice.owners.length > 1;
        return {
            color: isMulti ? '#000' : '#333',
            weight: isMulti ? 2 : 1,
            fillOpacity: 0.55,
            fillColor: slice.color || '#888',
            dashArray: isMulti ? '6 3' : null
        };
    }

    // Highlight (or restore) every visual piece of a plot when its legend row is
    // hovered. One slice == one Leaflet layer (a MultiPolygon renders as a single
    // layer), so highlighting that layer lights up all its disjoint pieces.
    function highlightSlice(sliceIndex, on) {
        if (!state.previewLayer || state.drawing.active) return;
        let layerIndex = 0;
        state.previewLayer.eachLayer((layer) => {
            if (layerIndex === sliceIndex) {
                if (on) {
                    layer.setStyle({ color: '#111', weight: 4, fillOpacity: 0.8, dashArray: null });
                    if (typeof layer.bringToFront === 'function') layer.bringToFront();
                } else {
                    layer.setStyle(sliceBaseStyle(state.slices[sliceIndex] || {}));
                }
            }
            layerIndex++;
        });
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
                features: state.slices.map((slice, idx) => ({
                    type: 'Feature',
                    properties: {
                        ownerKey: slice.ownerKey,
                        color: slice.color,
                        displayName: slice.displayName,
                        percent: slice.percent,
                        sliceIndex: idx,
                        isMultiOwner: Array.isArray(slice.owners) && slice.owners.length > 1,
                        ownerNames: (Array.isArray(slice.owners) && slice.owners.length)
                            ? slice.owners.map(o => o.displayName).join(', ')
                            : slice.displayName
                    },
                    geometry: slice.geometry
                }))
            };
            state.previewLayer = L.geoJSON(collection, {
                style: feature => {
                    const props = feature.properties || {};
                    return {
                        color: props.isMultiOwner ? '#000' : '#333',
                        weight: props.isMultiOwner ? 2 : 1,
                        fillOpacity: 0.55,
                        fillColor: props.color || '#888',
                        dashArray: props.isMultiOwner ? '6 3' : null
                    };
                },
                onEachFeature: (feature, layer) => {
                    const idx = feature.properties?.sliceIndex;
                    if (typeof idx === 'number') {
                        const owners = feature.properties.ownerNames || feature.properties.displayName;
                        layer.bindTooltip(owners, { sticky: true, className: 'reparcel-slice-tooltip' });
                        layer.on('click', (e) => {
                            // While drawing, let the click reach the map so vertices can be
                            // placed over existing plots; don't swallow it for assignment.
                            if (state.drawing.active) return;
                            L.DomEvent.stopPropagation(e);
                            layer.closeTooltip();
                            onSliceClick(idx, e.latlng);
                        });
                        layer.on('mouseover', () => {
                            if (state.ownerAssignmentPopup) layer.closeTooltip();
                        });
                    }
                }
            }).addTo(state.map);
        }

        state.boundaryLayer = L.geoJSON(state.superParcel, {
            style: {
                color: '#111',
                weight: 2,
                fillOpacity: 0
            },
            interactive: false
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

        // Keep the sweep direction line visible above the freshly re-added slices.
        if (state.sweepHandle) updateSweepDirLine();
    }

    function persistResult() {
        if (!state.slices.length) return;
        const payload = {
            algorithm: state.algorithm,
            generatedAt: new Date().toISOString(),
            parcelIds: state.selection.ids.slice(),
            totalArea: state.totalArea,
            // Land-readjustment accounting metadata so downstream views/audits can
            // reconstruct entitlements and cash balances without re-deriving them.
            contributionBasis: state.contributionBasis,
            totalValue: state.totalValue,
            poolUnitValue: state.poolUnitValue,
            contributionRatio: state.contributionRatio,
            isSingleOwner: state.ownershipMode === 'single',
            // Cash offers (the compensation part of the proposal) and their total.
            totalCashOffer: computeTotalCashOffer(),
            ownerShares: state.ownerShares.map(entry => {
                const ledger = computeOwnerLedger(entry);
                return {
                    ownerKey: entry.ownerKey,
                    displayName: entry.displayName,
                    percent: entry.percent,
                    color: entry.color,
                    parcelIds: entry.parcelIds.slice(),
                    contributedArea: entry.area,
                    contributedValue: entry.value,
                    entitledValue: ledger.entitled,
                    assignedArea: ledger.assignedArea,
                    assignedValue: ledger.assigned,
                    cashBalance: ledger.cashBalance,
                    cashOffer: getCashOffer(entry.ownerKey, ledger)
                };
            }),
            polygons: state.slices.map(slice => ({
                ownerKey: slice.ownerKey,
                displayName: slice.displayName,
                percent: slice.percent,
                color: slice.color,
                source: slice.source || 'manual',
                area: computeFeatureArea(sliceToFeature(slice)),
                geometry: slice.geometry,
                owners: Array.isArray(slice.owners) && slice.owners.length
                    ? slice.owners.map(o => ({ ownerKey: o.ownerKey, displayName: o.displayName, color: o.color, share: o.share }))
                    : []
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

    // Land value for a parcel: explicit estimatedMarketPrice when present,
    // otherwise area × average €/m². This is the contribution basis for
    // value-based readjustment (falls back to pure area when no price exists).
    function getParcelLandValue(feature, area) {
        const props = (feature && feature.properties) || {};
        const explicit = Number(props.estimatedMarketPrice);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const avg = (typeof window !== 'undefined' && Number.isFinite(window.SQM_AVG_PRICE))
            ? window.SQM_AVG_PRICE
            : (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);
        return (Number(area) || 0) * avg;
    }

    async function buildOwnerShares(selection) {
        const result = new Map();
        const parcelLayers = selection.layers || [];
        let totalArea = 0;
        let totalValue = 0;

        for (const layer of parcelLayers) {
            const feature = layer?.feature;
            if (!feature || !feature.properties) continue;
            const parcelId = feature.properties.parcelId;
            const area = Number(feature.properties.calculatedArea) || computeFeatureArea(feature);
            if (!area || !Number.isFinite(area)) continue;

            const value = getParcelLandValue(feature, area);
            totalArea += area;
            totalValue += value;

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
                    totalArea: 0,
                    totalValue: 0
                };
                existing.totalArea += area * fraction;
                existing.totalValue += value * fraction;
                if (parcelId) existing.parcelIds.add(parcelId);
                result.set(ownerKey, existing);
            });
        }

        if (!totalArea) {
            return [];
        }

        // Contribution percent is by value when value data is meaningful,
        // otherwise by area. poolUnitValue (€/m²) lets us value redrawn plots
        // at the pool average, so owners who pooled pricier land get more area.
        const useValue = totalValue > 0;
        state.totalValue = totalValue;
        state.poolUnitValue = useValue && totalArea > 0 ? totalValue / totalArea : 0;
        state.contributionBasis = useValue ? 'value' : 'area';

        return Array.from(result.values()).map((entry, index) => {
            const percent = useValue
                ? entry.totalValue / totalValue
                : entry.totalArea / totalArea;
            return {
                ownerKey: entry.ownerKey,
                displayName: entry.displayName,
                parcelIds: Array.from(entry.parcelIds),
                area: entry.totalArea,
                value: entry.totalValue,
                percent,
                color: pickOwnerColor(entry.ownerKey, index)
            };
        }).filter(entry => entry.percent > 0).sort((a, b) => b.percent - a.percent);
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
            if (run.start === 0 && ringCoords.length >= 2) {
                ringCoords.pop();
            }
            closeRingInPlace(ringCoords);
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
                    geometry: sliceFeature.geometry,
                    owners: [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }],
                    source: 'sweep'
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

        // Get the orientation line direction from the handles
        const orientationCoords = getOrientationLineLatLngs();
        if (!orientationCoords || orientationCoords.length < 2) {
            console.warn('[reparcellization] No orientation line available');
            return [];
        }

        const [startHandle, endHandle] = orientationCoords;

        // To compute a true perpendicular, we need to account for the fact that
        // 1° longitude ≠ 1° latitude. At latitude φ, 1° lng ≈ cos(φ) × 1° lat in distance.
        // We work in a local "equirectangular" coordinate system where we scale lng by cos(lat).
        const midLat = (startHandle.lat + endHandle.lat) / 2;
        const cosLat = Math.cos(midLat * Math.PI / 180);

        // Direction in scaled coordinates (x = lng * cosLat, y = lat)
        const dx = (endHandle.lng - startHandle.lng) * cosLat;
        const dy = endHandle.lat - startHandle.lat;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-10) {
            console.warn('[reparcellization] Orientation line too short');
            return [];
        }

        // Normalized direction in scaled space
        const dirX = dx / len;
        const dirY = dy / len;
        // Perpendicular in scaled space (rotate 90°): (dx, dy) → (-dy, dx)
        const perpX = -dirY;
        const perpY = dirX;

        // Convert back to lng/lat deltas:
        // dLng = dirX / cosLat, dLat = dirY (for direction along orientation)
        // perpLng = perpX / cosLat, perpLat = perpY (for perpendicular)
        const dLng = dirX / cosLat;
        const dLat = dirY;
        const perpLng = perpX / cosLat;
        const perpLat = perpY;

        // Project all parcel vertices onto the orientation axis to find extent
        const bbox = turf.bbox(superParcel);
        const bboxSpan = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
        const cutLineHalfLength = bboxSpan * 2; // Long enough to cross the parcel

        // Get all ring coordinates
        const ringCoords = getPolygonCoordinates(superParcel);
        if (!ringCoords || ringCoords.length < 3) return [];

        // Project each vertex onto the orientation axis in scaled space
        const centroid = getSuperParcelCentroidLngLat(superParcel) || turf.centroid(superParcel).geometry.coordinates;
        const projections = ringCoords.map(coord => {
            // Convert to scaled space relative to centroid
            const relX = (coord[0] - centroid[0]) * cosLat;
            const relY = coord[1] - centroid[1];
            // Dot product with direction in scaled space
            return relX * dirX + relY * dirY;
        });
        const minProj = Math.min(...projections);
        const maxProj = Math.max(...projections);

        // Helper: create a cut line perpendicular to orientation at a given position along the axis
        const createCutLine = (projPos) => {
            // Point on the orientation axis at projPos distance from centroid (in scaled space)
            // Convert back: lng = centroid[0] + (dirX * projPos) / cosLat
            const pointLng = centroid[0] + (dirX * projPos) / cosLat;
            const pointLat = centroid[1] + dirY * projPos;
            // Line perpendicular to orientation, passing through this point
            return turf.lineString([
                [pointLng - perpLng * cutLineHalfLength, pointLat - perpLat * cutLineHalfLength],
                [pointLng + perpLng * cutLineHalfLength, pointLat + perpLat * cutLineHalfLength]
            ]);
        };

        // Find cut positions using binary search for equal area distribution
        const totalArea = computeFeatureArea(superParcel);
        if (!totalArea) return [];

        const cutPositions = [];
        let cumulativePercent = 0;

        for (let i = 0; i < activeShares.length - 1; i++) {
            cumulativePercent += activeShares[i].percent;
            const targetArea = totalArea * cumulativePercent;

            // Binary search for the projection position that gives targetArea
            let lower = minProj;
            let upper = maxProj;
            let bestPos = (lower + upper) / 2;
            let bestDiff = Infinity;

            for (let iter = 0; iter < 30; iter++) {
                const pos = (lower + upper) / 2;
                const cutLine = createCutLine(pos);

                // Create a half-plane polygon from minProj to pos
                const halfPlane = createHalfPlane(centroid, dirX, dirY, perpX, perpY, cosLat, minProj, pos, cutLineHalfLength);

                let sliceArea = 0;
                try {
                    const slice = turf.intersect(superParcel, halfPlane);
                    if (slice) sliceArea = computeFeatureArea(slice);
                } catch (_) { /* ignore */ }

                const diff = Math.abs(sliceArea - targetArea);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestPos = pos;
                }

                if (sliceArea < targetArea) {
                    lower = pos;
                } else {
                    upper = pos;
                }

                if (targetArea > 0 && diff / targetArea < 0.005) break;
            }

            cutPositions.push(bestPos);
        }

        // Now slice the parcel using these cut lines
        const slices = [];
        let remaining = superParcel;

        for (let i = 0; i < activeShares.length; i++) {
            const owner = activeShares[i];

            if (i < cutPositions.length) {
                const cutLine = createCutLine(cutPositions[i]);
                const parts = splitPolygonWithLine(remaining, cutLine);

                if (parts && parts.length >= 2) {
                    // Sort parts by their projection onto the orientation axis
                    parts.sort((a, b) => {
                        const centA = turf.centroid(a).geometry.coordinates;
                        const centB = turf.centroid(b).geometry.coordinates;
                        const projA = (centA[0] - centroid[0]) * dLng + (centA[1] - centroid[1]) * dLat;
                        const projB = (centB[0] - centroid[0]) * dLng + (centB[1] - centroid[1]) * dLat;
                        return projA - projB;
                    });

                    // First part is the slice, rest becomes remaining
                    const slicePart = parts[0];
                    remaining = parts.length > 2
                        ? turf.union(...parts.slice(1))
                        : parts[1];

                    if (slicePart && slicePart.geometry) {
                        slices.push({
                            ownerKey: owner.ownerKey,
                            displayName: owner.displayName,
                            percent: owner.percent,
                            color: owner.color,
                            geometry: slicePart.geometry,
                            owners: [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }]
                        });
                    }
                } else {
                    // Cut failed, give remaining to this owner
                    if (remaining && remaining.geometry) {
                        slices.push({
                            ownerKey: owner.ownerKey,
                            displayName: owner.displayName,
                            percent: owner.percent,
                            color: owner.color,
                            geometry: remaining.geometry,
                            owners: [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }]
                        });
                    }
                    remaining = null;
                }
            } else {
                // Last slice gets whatever remains
                if (remaining && remaining.geometry) {
                    slices.push({
                        ownerKey: owner.ownerKey,
                        displayName: owner.displayName,
                        percent: owner.percent,
                        color: owner.color,
                        geometry: remaining.geometry,
                        owners: [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }]
                    });
                }
            }
        }

        return slices.filter(s => s && s.geometry);
    }

    // Helper: create a half-plane polygon for area calculation
    // dirX, dirY are in scaled space; cosLat is used to convert back to lng
    function createHalfPlane(centroid, dirX, dirY, perpX, perpY, cosLat, fromProj, toProj, halfLen) {
        // Four corners of the half-plane band
        // Convert from scaled space to lng/lat: lng = x / cosLat, lat = y
        const p1Lng = centroid[0] + (dirX * fromProj - perpX * halfLen) / cosLat;
        const p1Lat = centroid[1] + (dirY * fromProj - perpY * halfLen);
        const p2Lng = centroid[0] + (dirX * fromProj + perpX * halfLen) / cosLat;
        const p2Lat = centroid[1] + (dirY * fromProj + perpY * halfLen);
        const p3Lng = centroid[0] + (dirX * toProj + perpX * halfLen) / cosLat;
        const p3Lat = centroid[1] + (dirY * toProj + perpY * halfLen);
        const p4Lng = centroid[0] + (dirX * toProj - perpX * halfLen) / cosLat;
        const p4Lat = centroid[1] + (dirY * toProj - perpY * halfLen);

        return turf.polygon([[
            [p1Lng, p1Lat],
            [p2Lng, p2Lat],
            [p3Lng, p3Lat],
            [p4Lng, p4Lat],
            [p1Lng, p1Lat]
        ]]);
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
            lengthMode: state.singleConfig.lengthMode
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
        if (!state.totalArea) {
            state.totalArea = computeFeatureArea(state.superParcel);
        }

        if (state.algorithm === 'sweep-line') {
            initSweepOrientation();
            state.slices = computeSweepSlices();
            if (!state.slices.length) {
                setStatus(
                    t('reparcellization.modal.status.splitFailed', 'Failed to split the parcel geometry.'),
                    'error',
                    'reparcellization.modal.status.splitFailed'
                );
                updateLegend(state.ownerShares);
                drawPreview();
                updateCommitState();
                return;
            }
            setStatus('', 'info');
        } else if (state.algorithm === 'manual') {
            // Manual: blank slate. Discard any sweep-line result and start from the
            // undivided superparcel as a single unassigned plot to draw/split on.
            state.slices = [createUnassignedPlot(state.superParcel.geometry, 'base')];
            setStatus(
                t('reparcellization.modal.status.manualHint', 'Draw plots on the map, then assign each to an owner.'),
                'info',
                'reparcellization.modal.status.manualHint'
            );
        } else {
            setStatus(
                t('reparcellization.modal.status.algorithmUnavailable', 'Selected algorithm is not available yet.'),
                'warning',
                'reparcellization.modal.status.algorithmUnavailable'
            );
            return;
        }
        updateTotalParcelsLabel();
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
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
        state.cashOfferOverrides = {};
        state.singleConfig = {
            lengthMode: 'split',
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
