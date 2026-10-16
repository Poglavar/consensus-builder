(function () {
    const reparcellizationUiState = window.__reparcellizationUiState;
    if (!reparcellizationUiState
        || typeof reparcellizationUiState.resolveDrawShortcut !== 'function'
        || typeof reparcellizationUiState.resolveOwnerLabel !== 'function'
        || typeof reparcellizationUiState.normalizePlotOwners !== 'function'
        || typeof reparcellizationUiState.plotIsAssigned !== 'function'
        || typeof reparcellizationUiState.readjustmentInputFeatures !== 'function'
        || typeof reparcellizationUiState.newPlotOwnerHtml !== 'function') {
        console.error('[reparcellization] UI state helpers are unavailable.');
        return;
    }
    const {
        resolveDrawShortcut,
        resolveOwnerLabel,
        normalizePlotOwners,
        plotIsAssigned,
        readjustmentInputFeatures,
        safePlanColor,
        ownerLegendCellHtml,
        cashOfferInputHtml,
        newPlotOwnerHtml
    } = reparcellizationUiState;

    function liveReparcellizationFeature(parcelOrId) {
        let id = null;
        if (typeof parcelOrId === 'string' || typeof parcelOrId === 'number') {
            id = String(parcelOrId);
        } else if (parcelOrId) {
            id = window.ParcelPresenter?.getIdForLayer?.(parcelOrId) || null;
        }
        return id ? window.LiveParcelFabric?.get?.(String(id)) || null : null;
    }

    function ownerDisplayName(rawName, fallbackName) {
        const fallback = fallbackName || t('reparcellization.modal.unassigned', 'Unassigned');
        return resolveOwnerLabel(rawName, fallback, (key, value) => t(key, value)).displayName;
    }

    function liveSelectionFeatures(selection) {
        const { features, missing } = readjustmentInputFeatures(selection, {
            live: window.LiveParcelFabric,
            cadastre: window.CadastralParcelRepository
        });
        return missing.length ? [] : features;
    }

    const COLOR_PALETTE = [
        '#2E86AB', '#F18F01', '#C73E1D', '#137547', '#7A1CAC',
        '#CC3363', '#3D5A80', '#EE6C4D', '#5C946E', '#8A508F',
        '#FF7F11', '#1B998B', '#ED254E', '#3772FF', '#78290F'
    ];

    const state = {
        modal: null,
        session: null,
        map: null,
        previewLayer: null,
        boundaryLayer: null,
        legendListEl: null,
        ownerReviewEl: null,
        reviewOwnerKey: '',
        ownerReviewLayers: [],
        shareDraftPending: false,
        statusEl: null,
        algorithm: 'sweep-line',
        selection: null,
        superParcel: null,
        totalArea: 0,
        ownerShares: [],
        approvalConfig: null,
        approvalLens: [],
        savedOwnerShares: [],
        savedLedgerMetadata: null,
        parcelOwnerIndex: new Map(),
        cadastreIdsByLiveParcel: new Map(),
        amendInputs: [],
        slices: [],
        hasFitBounds: false,
        resizeHandler: null,
        resizeTimer: null,
        escHandler: null,
        commitBtns: [],
        subtitleEl: null,
        subtitleData: null,
        ownershipMode: 'multiple',
        uploadedGeometry: null,
        // A saved plan's polygons[] to restore instead of re-running the algorithm. Set by
        // openReparcellizationModal({ initialPolygons }) — used by "Copy into new proposal" and by
        // reopening the editor mid-draft. Consumed once by refreshPreview().
        initialPolygons: null,
        selectedSliceIndex: null,
        ownerAssignmentPopup: null,
        ownerPopupView: null,
        newPlotsListEl: null,
        // Inputs vs outputs. 'new' edits the plan over a faint underlay of the parcels it replaces;
        // 'old' shows those parcels alone and read-only — the cadastre is a given here.
        oldPlotsListEl: null,
        plotsTabBtns: [],
        plotsTab: 'new',
        // Assigning and editing are different jobs on the same map, and they were
        // fighting: a click meant "give this plot an owner" AND "select this plot to
        // reshape", so the owner popup interrupted every editing gesture. One mode at a
        // time — editing by default, assigning when asked for.
        assignMode: false,
        inputLayer: null,
        inputHighlightLayer: null,
        nodeEditWasActive: false,
        // True when the input parcels could not all be resolved and the pooled outline had to be
        // derived from the plan's own plots — a weaker guarantee, disclosed rather than hidden.
        poolFromOutputs: false,
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
        // `frozen[i]` marks a point placed with Shift held — taken exactly where it was clicked,
        // snapping and all. `context` is the boundary graph the cut is measured against, built once
        // per draw so a mousemove does not rebuild the topology; `ghostLayer` shows the nodes that
        // are there to snap to, since the editing handles have to stand down while drawing.
        drawing: {
            active: false, points: [], frozen: [], tempLayer: null, tempMarkers: [],
            mode: 'polygon', cursor: null, rawCursor: null, shift: false,
            context: null, ghostLayer: null, snapLayer: null, snap: null,
            statusText: null, keyHandler: null, zoomHandler: null, joint: false
        },
        drawBtn: null,
        lineBtn: null,
        eraseBtn: null,
        // Erase mode: the boundaries between plots drawn as clickable lines, so a boundary can be
        // deleted and the two plots it separated merged. The inverse of cutting.
        erase: { active: false, layer: null, topology: null, nodeEditWasActive: false },
        // Sweep-line orientation: a draggable point the cut lines point toward.
        sweepHandle: null,
        sweepDirLayer: null,
        cashTotalEl: null,
        // Per-owner cash-offer overrides (ownerKey -> number) when the user edits
        // the prefilled cash offer; unset owners use the computed default.
        cashOfferOverrides: {},
        // Before/after swipe comparison (a second "before" map clipped by a slider).
        compareBtn: null,
        compare: { active: false, session: null, map2: null },
        // Footprints of applied building proposals overlapping the pool, shown as a
        // guide layer so the readjustment can be aligned to planned buildings.
        buildingFootprintLayer: null,
        // Node/edge editing of the plot boundaries (plot-topology.js). `nodes` holds the current
        // topology so a drag knows which plots a handle belongs to.
        nodeEdit: { active: false, topology: null, layer: null, boundaryIndex: null, focusRemove: null },
        // Undo stack for layout edits (Cmd/Ctrl+Z). Each entry is a snapshot of the plots and
        // their ownership taken BEFORE a mutating action, so undo restores the state the user
        // last saw rather than an intermediate drag frame.
        historyCtl: null,
        // Set for the duration of an open, so a second click cannot start a second editor.
        opening: false,
        // A subdivision (PARCEL-OPTIONAL.md phase 4): the pool is a drawn site, partly or wholly
        // open ground. { site, boundParcelIds, pool } — pool is proposals/subdivision.js sitePool():
        // the bound parcels' parts (their owners contribute) and the open ground (no owner).
        sitePool: null
    };

    function subdivisionApi() {
        return window.__subdivision || null;
    }

    function isNoOwnerEntry(entry) {
        const api = subdivisionApi();
        return !!(entry && (entry.noOwner || (api && api.isOpenGroundOwnerKey(entry.ownerKey))));
    }

    // Pseudo-owner for land assigned to public use (roads, parks, etc.). Rendered
    // white so it reads as "not an owner"; excluded from owner cash accounting.
    const PUBLIC_LAND_KEY = 'public-land';
    // Open ground (no owner) in a subdivision: a pale sand, distinct from public land's white.
    const OPEN_GROUND_COLOR = '#e8dcc0';
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
            { const translated = i18nApi.t(key, params); if (translated !== key) return translated; }
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

        const parcelCount = state.subtitleData.parcelCount || 0;
        const algorithmLabel = state.subtitleData.algorithmLabel || '';
        // The counted nouns are nested translation references so each one picks its own plural form
        // (Croatian/Serbian need 1 / 2-4 / 5+); the i18n runtime resolves them before interpolating.
        const params = {
            algorithm: algorithmLabel,
            parcels: { key: 'reparcellization.modal.parcelCount', count: parcelCount },
            owners: { key: 'reparcellization.modal.ownerCount', count: ownerCount || 0 }
        };
        const subtitleText = t(
            'reparcellization.modal.subtitleWithOwners',
            '{{algorithm}} · {{parcels}} · {{owners}}',
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

    function getAlgorithmOptions() {
        return [
            {
                key: 'sweep-line',
                label: t('reparcellization.modal.algorithms.sweepLine', 'Automatic'),
                disabled: false
            },
            {
                key: 'manual',
                label: t('reparcellization.modal.algorithms.manual', 'Draw freely'),
                disabled: false
            },
            {
                key: 'amend',
                label: t('reparcellization.modal.algorithms.amend', 'Keep existing parcels'),
                disabled: !!state.sitePool
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
            // A segmented control around native radios (css/primitives.css); reparcel-alg-option is
            // the hook the tests click.
            return `
                <label class="cb-segmented__option reparcel-alg-option">
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

    // Keep the selected map mode visible when the settings group is collapsed.
    function updateActiveModeHint() {
        const mode = state.drawing.active
            ? (state.drawing.joint ? t('reparcellization.modal.sharedCourtyard', 'Shared courtyard')
                : state.drawing.mode === 'line'
                    ? t('reparcellization.modal.drawLine', 'Draw a line')
                    : t('reparcellization.modal.drawPlot', 'Draw plot'))
            : state.erase.active
                ? t('reparcellization.modal.eraseEdge', 'Erase a boundary')
                : state.assignMode
                    ? t('reparcellization.modal.assignOwners', 'Assign owners')
                    : state.nodeEdit.active
                        ? t('reparcellization.modal.editNodes', 'Edit boundaries (nodes)')
                        : '';
        const active = mode
            ? t('reparcellization.modal.activeMode', '{{mode}} active', { mode })
            : '';
        if (state.activeModeEl) {
            state.activeModeEl.textContent = active;
            state.activeModeEl.hidden = !active;
        }
        state.session?.setHint?.(active || null);
    }

    function destroyMap() {
        clearTimeout(state.resizeTimer);
        state.resizeTimer = null;
        exitCompare();
        clearOwnerReviewHighlights();
        state.ownerPopupView = null;
        destroySweepOrientation();
        if (state.previewLayer) {
            state.previewLayer.remove();
            state.previewLayer = null;
        }
        clearPlotNumbers();
        if (state.buildingFootprintLayer) {
            state.buildingFootprintLayer.remove();
            state.buildingFootprintLayer = null;
        }
        if (state.boundaryLayer) {
            state.boundaryLayer.remove();
            state.boundaryLayer = null;
        }
        // The map belongs to the app. The editor owns only the overlays it added above it.
        state.hasFitBounds = false;
    }

    // What the layout looked like when the editor opened — the baseline "cancel" restores to, and
    // what "has anything changed?" is measured against. Geometry + ownership, since both are edited
    // here. Taken after the initial layout is generated, so merely opening is never "dirty".
    function layoutSignature() {
        try {
            return JSON.stringify({
                algorithm: state.algorithm,
                cash: state.cashOfferOverrides,
                slices: (state.slices || []).map(s => ({
                    g: s?.geometry || null,
                    o: s ? (s.ownerKey ?? null) : null,
                    j: s?.jointPool === true,
                    jm: s?.jointShareMode || null,
                    d: s?.derivation || null,
                    w: s && Array.isArray(s.owners) ? s.owners.map(o => `${o.ownerKey}:${o.share || 0}`).join('|') : ''
                })),
                shares: (state.ownerShares || []).map(o => ({ k: o.ownerKey, v: o.share ?? null }))
            });
        } catch (_) { return null; }
    }

    function isDirty() {
        if (state.openSignature === null || state.openSignature === undefined) return false;
        const now = layoutSignature();
        return now !== null && now !== state.openSignature;
    }

    // Leaving without committing DISCARDS: the editor is a workspace, and closing it used to
    // persist silently, so an X after experimenting wrote the experiment onto the map. Only Done
    // saves. When there is work to lose the user is told before it goes.
    async function cancelModal() {
        if (isDirty()) {
            const confirmed = await confirmDiscard();
            if (!confirmed) return false;
        }
        closeModal({ skipPersist: true, discard: true });
        return true;
    }

    async function confirmDiscard() {
        const title = t('reparcellization.modal.discardTitle', 'Discard these changes?');
        const message = t('reparcellization.modal.discardMessage',
            'The edits you made here have not been saved to the proposal. Closing now discards them.');
        const discardLabel = t('reparcellization.modal.discardConfirm', 'Discard changes');
        const keepLabel = t('reparcellization.modal.discardCancel', 'Keep editing');
        // The app's confirm (js/ui/dialogs.js) on its top rung, over this editor; discarding is the
        // destructive answer, so keeping the edits is the inviting one.
        return window.CbDialog.confirm(message, {
            title, okText: discardLabel, cancelText: keepLabel, destructive: true
        });
    }

    function closeModal(options = {}) {
        if (options.skipPersist !== true && state.slices.length
            && window.getActiveProposalDesignDraft?.()?.goal === 'reparcellization') {
            // Only the Done path reaches this now; every dismissal passes skipPersist.
            persistResult();
        }
        cancelDraw();
        clearEraseLayer();
        state.erase.active = false;
        state.erase.nodeEditWasActive = false;
        state.eraseBtn = null;
        destroyMap();
        if (state.modal) {
            state.session?.close?.();
            state.modal = null;
        }
        state.session = null;
        state.map = null;
        if (state.resizeHandler) {
            window.removeEventListener('resize', state.resizeHandler);
            state.resizeHandler = null;
        }
        if (state.escHandler) {
            window.removeEventListener('keydown', state.escHandler);
            state.escHandler = null;
        }
        state.ownerShares = [];
        state.ownerReviewEl = null;
        state.reviewOwnerKey = '';
        state.shareDraftPending = false;
        state.approvalConfig = null;
        state.approvalLens = [];
        state.approvalRowEl = null;
        state.savedOwnerShares = [];
        state.savedLedgerMetadata = null;
        state.parcelOwnerIndex = new Map();
        state.cadastreIdsByLiveParcel = new Map();
        state.amendInputs = [];
        state.slices = [];
        state.selection = null;
        state.superParcel = null;
        state.totalArea = 0;
        state.commitBtns = [];
        state.uploadedGeometry = null;
        state.selectedSliceIndex = null;
        state.openSignature = null;
        clearNodeHandles();
        clearInputHighlight();
        if (state.inputLayer) { try { state.inputLayer.remove(); } catch (_) { } state.inputLayer = null; }
        state.plotsTab = 'new';
        state.assignMode = false;
        state.assignBtn = null;
        state.plotsTabBtns = [];
        state.oldPlotsListEl = null;
        state.nodeEditWasActive = false;
        state.poolFromOutputs = false;
        state.sitePool = null;
        state.nodeEdit.active = false;
        state.nodeEdit.topology = null;
        state.nodeEdit.boundaryIndex = null;
        if (state.historyCtl) { state.historyCtl.destroy(); state.historyCtl = null; }
        dismissOwnerPopup();
        // Discard must DISCARD. finishProposalDraftDesignSession is the COMMIT path — it turns the
        // seeding draft into the object — so calling it alone meant closing the editor with Cancel
        // ran the create flow anyway, which then failed validation and reopened the drawing the
        // user had just thrown away. Abandoning first clears the commit id, exactly as every other
        // design tool does, leaving the finish call to do the ordinary session teardown.
        //
        // Keyed on `discard`, NOT on skipPersist: Done passes skipPersist too, because it has
        // already persisted by the time it gets here.
        if (options.discard === true) window.discardProposalDraftDesignSession?.();
        window.finishProposalDraftDesignSession?.();
    }

    function buildModalStructure() {
        const parcelCount = state.selection.ids.length;
        const algorithmOption = getAlgorithmOptionByKey(state.algorithm) || getAlgorithmOptionByKey('sweep-line');
        const algorithmLabel = algorithmOption ? algorithmOption.label : t('reparcellization.modal.algorithms.sweepLine', 'Sweep line algorithm');
        const subtitleParams = {
            algorithm: algorithmLabel,
            parcels: { key: 'reparcellization.modal.parcelCount', count: parcelCount }
        };
        const titleText = state.sitePool
            ? t('reparcellization.modal.subdivisionTitle', 'Subdivision')
            : t('reparcellization.modal.title', 'Reparcellization');
        const subtitleText = t('reparcellization.modal.subtitle', '{{algorithm}} · {{parcels}}', subtitleParams);
        const doneLabel = t('reparcellization.modal.done', 'Done');
        const cancelLabel = t('reparcellization.modal.cancel', 'Cancel');
        const allPublicLabel = t('reparcellization.modal.allPublic', 'All public');
        const assignOwnersLabel = t('reparcellization.modal.assignOwners', 'Assign owners');
        // The drawing tools are icon buttons: the label is the accessible name and the tooltip.
        const tool = (attrs, key, fallback, icon) => {
            const label = t(key, fallback);
            return `<button type="button" class="btn btn-icon" ${attrs} title="${label}" aria-label="${label}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
        };
        const uploadLabel = t('reparcellization.modal.uploadGeojson', 'Upload GeoJSON');

        const algorithmControls = `
                    <div class="reparcel-controls" data-reparcel-alg-group>
                      <div class="reparcel-secondary-controls" data-reparcel-secondary-controls>
                        <div class="cb-segmented reparcel-alg-options" role="radiogroup" aria-label="${t('reparcellization.modal.layoutTitle', 'Starting layout')}">${buildAlgorithmRadios(state.algorithm)}</div>
                        <div class="reparcel-courtyard-tools" data-reparcel-courtyard-tools hidden>
                            <span class="reparcel-courtyard-label">${t('reparcellization.modal.sharedCourtyard', 'Shared courtyard')}</span>
                            <button type="button" class="btn" data-reparcel-courtyard-building>${t('reparcellization.modal.courtyardFromBuilding', 'From a building block')}</button>
                            <button type="button" class="btn" data-reparcel-courtyard-draw>${t('reparcellization.modal.courtyardDraw', 'Draw on map')}</button>
                            <p class="reparcel-courtyard-hint">${t('reparcellization.modal.jointShareHint', 'Courtyard shares start from each owner’s remaining private land. Use Edit shares to set fixed percentages.')}</p>
                        </div>
                        <div class="reparcel-edit-tools">
                            <div class="reparcel-legend-actions">
                                ${tool('data-reparcel-draw aria-pressed="false"', 'reparcellization.modal.drawPlot', 'Draw plot', 'fa-draw-polygon')}
                                ${tool('data-reparcel-line aria-pressed="false"', 'reparcellization.modal.drawLine', 'Draw a line', 'fa-slash')}
                                ${tool('data-reparcel-erase aria-pressed="false"', 'reparcellization.modal.eraseEdge', 'Erase a boundary', 'fa-eraser')}
                                ${tool('data-reparcel-nodes aria-pressed="false"', 'reparcellization.modal.editNodes', 'Edit boundaries (nodes)', 'fa-bezier-curve')}
                                ${tool('data-reparcel-shuffle', 'reparcellization.modal.shuffle', 'Shuffle ownership', 'fa-shuffle')}
                                <label class="btn btn-icon" title="${uploadLabel}">
                                    <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
                                    <input type="file" accept=".geojson,.json,application/geo+json,application/json" data-reparcel-upload aria-label="${uploadLabel}" hidden>
                                </label>
                                <button type="button" class="btn btn-icon reparcel-assign-btn" data-reparcel-assign aria-pressed="false" data-i18n-key="reparcellization.modal.assignOwners" data-i18n-attr="title,aria-label" title="${assignOwnersLabel}" aria-label="${assignOwnersLabel}"><i class="fa-solid fa-user-tag" aria-hidden="true"></i></button>
                                <span class="reparcel-tools-spacer"></span>
                            </div>
                        </div>
                      </div>
                      <div class="reparcel-persistent-controls">
                          ${tool('data-reparcel-undo-edit disabled', 'reparcellization.modal.undoEdit', 'Undo (Cmd/Ctrl+Z)', 'fa-rotate-left')}
                          ${tool('data-reparcel-redo-edit disabled', 'reparcellization.modal.redoEdit', 'Redo', 'fa-rotate-right')}
                          <button type="button" class="btn btn-sm reparcel-allpublic-btn" data-reparcel-all-public hidden data-i18n-key="reparcellization.modal.allPublic" data-i18n-attr="text" title="${allPublicLabel}">${allPublicLabel}</button>
                      </div>
                      <div class="reparcel-draw-toolbar" data-reparcel-draw-toolbar hidden>
                          <button type="button" class="btn btn-sm" data-reparcel-undo>${t('reparcellization.modal.drawUndo', 'Undo point')} (U)</button>
                          <button type="button" class="btn btn-sm btn-success" data-reparcel-finish>${t('reparcellization.modal.drawFinish', 'Finish plot')} (F)</button>
                          <button type="button" class="btn btn-sm" data-reparcel-cancel-draw>${t('reparcellization.modal.drawCancel', 'Cancel')} (C)</button>
                      </div>
                    </div>`;

        // Inputs and outputs are the two halves of a readjustment, so the panel shows both: what
        // went into the pool, and what the plan makes of it. Old plots is a READ-ONLY view — the
        // cadastre is the given, not something this editor edits.
        const sidePanel = `<section class="reparcel-legend-panel">
                            <div class="cb-tabs reparcel-plots-tabs" role="tablist">
                                <button type="button" role="tab" class="cb-tab" data-reparcel-plots-tab="new" aria-selected="true">${t('reparcellization.modal.newPlots', 'New plots')}</button>
                                <button type="button" role="tab" class="cb-tab" data-reparcel-plots-tab="old" aria-selected="false">${t('reparcellization.modal.oldPlots', 'Old plots')}</button>
                            </div>
                            <div class="reparcel-newplots-list" data-reparcel-newplots-table></div>
                            <div class="reparcel-oldplots-list" data-reparcel-oldplots-table hidden></div>
                            <div class="reparcel-owner-review" data-reparcel-owner-review></div>
                            <div class="reparcel-legend-header">
                                <h3 class="cb-kicker">${t('reparcellization.modal.owners', 'Owners')}</h3>
                            </div>
                            <div class="reparcel-legend-list" data-reparcel-owners-table></div>
                            <div class="reparcel-cashtotal" data-reparcel-cashtotal></div>
                            <div class="reparcel-approval-setup" data-reparcel-approval>
                                <h3 class="cb-kicker">${t('proposalDrafts.approval.title', 'Ownership and approval')}</h3>
                                <p class="reparcel-approval-setup__summary" data-reparcel-approval-summary></p>
                                <ul class="reparcel-approval-setup__checks" data-reparcel-regime-check hidden></ul>
                                <button type="button" class="btn btn-sm" data-reparcel-approval-setup>${t('proposalDrafts.approval.setUp', 'Set up…')}</button>
                            </div>
                            <div class="reparcel-coverage" data-reparcel-coverage></div>
                            <div class="reparcel-status" data-reparcel-status></div>
                        </section>`;
        const tools = document.createElement('div');
        tools.className = 'reparcel-tools';
        tools.innerHTML = `
            <div class="reparcel-tools-header"><div class="reparcel-tools-heading"><p class="reparcel-subtitle" data-i18n-key="reparcellization.modal.subtitle" data-i18n-params='${JSON.stringify(subtitleParams)}'>${subtitleText}</p><span class="reparcel-active-mode" data-reparcel-active-mode hidden></span></div>
            <button type="button" class="btn btn-sm reparcel-compare-btn" data-reparcel-compare aria-pressed="false" hidden>${t('mapCompare.toggle', 'Before / After')}</button></div>
            ${algorithmControls}`;
        const content = document.createElement('div');
        content.className = 'reparcel-content';
        content.innerHTML = sidePanel;
        const footer = document.createElement('div');
        footer.className = 'reparcel-actions reparcel-actions--commit';
        footer.innerHTML = `
            <button type="button" class="btn" data-reparcel-cancel data-i18n-key="reparcellization.modal.cancel" data-i18n-attr="text">${cancelLabel}</button>
            <button type="button" class="btn btn-primary" data-reparcel-commit disabled data-i18n-key="reparcellization.modal.done" data-i18n-attr="text">${doneLabel}</button>`;
        const session = window.OnMapEditor?.open?.({
            owner: 'reparcellization',
            reserveToolsSpace: true,
            id: window.getActiveProposalDesignDraft?.()?.id || 'reparcellization',
            title: titleText,
            content,
            footer,
            tools,
            modes: ['2d'],
            wide: true,
            hints: { '2d': t('reparcellization.modal.mapHint', 'Edit plots and boundaries on the map; use the panel to review ownership and shares.') },
            handleEscape: false,
            onCancel: cancelModal
        });
        if (!session) return null;
        session.root.classList.add('on-map-reparcellization');
        session.tools?.classList?.add('reparcel-tools-map');
        if (session.tools) session.tools.hidden = false;
        state.session = session;
        state.modal = session.root;
        state.map = session.map;
        const root = session.root;
        state.legendListEl = root.querySelector('[data-reparcel-owners-table]');
        state.ownerReviewEl = root.querySelector('[data-reparcel-owner-review]');
        state.newPlotsListEl = root.querySelector('[data-reparcel-newplots-table]');
        state.oldPlotsListEl = root.querySelector('[data-reparcel-oldplots-table]');
        state.assignBtn = root.querySelector('[data-reparcel-assign]');
        if (state.assignBtn) state.assignBtn.addEventListener('click', () => toggleAssignMode());
        state.plotsTabBtns = Array.from(root.querySelectorAll('[data-reparcel-plots-tab]'));
        state.plotsTabBtns.forEach(btn => {
            btn.addEventListener('click', () => setPlotsTab(btn.getAttribute('data-reparcel-plots-tab')));
        });
        state.coverageEl = root.querySelector('[data-reparcel-coverage]');
        state.approvalRowEl = root.querySelector('[data-reparcel-approval]');
        state.approvalRowEl?.querySelector('[data-reparcel-approval-setup]')?.addEventListener('click', openApprovalSetup);
        state.cashTotalEl = root.querySelector('[data-reparcel-cashtotal]');
        state.nodesBtn = root.querySelector('[data-reparcel-nodes]');
        state.undoEditBtn = root.querySelector('[data-reparcel-undo-edit]');
        state.redoEditBtn = root.querySelector('[data-reparcel-redo-edit]');
        state.drawBtn = root.querySelector('[data-reparcel-draw]');
        state.courtyardToolsEl = root.querySelector('[data-reparcel-courtyard-tools]');
        root.querySelector('[data-reparcel-courtyard-building]').addEventListener('click', openBuiltFormPicker);
        root.querySelector('[data-reparcel-courtyard-draw]').addEventListener('click', () => {
            cancelDraw();
            clearNodeHandles();
            startDraw('polygon', { joint: true });
        });
        state.lineBtn = root.querySelector('[data-reparcel-line]');
        state.eraseBtn = root.querySelector('[data-reparcel-erase]');
        state.compareBtn = root.querySelector('[data-reparcel-compare]');
        if (state.compareBtn) state.compareBtn.hidden = false;
        state.drawToolbar = root.querySelector('[data-reparcel-draw-toolbar]');
        state.finishBtn = root.querySelector('[data-reparcel-finish]');
        state.undoBtn = root.querySelector('[data-reparcel-undo]');
        state.subtitleEl = root.querySelector('.reparcel-subtitle');
        state.subtitleData = { algorithmLabel: subtitleParams.algorithm, parcelCount };
        state.statusEl = root.querySelector('[data-reparcel-status]');
        state.activeModeEl = root.querySelector('[data-reparcel-active-mode]');

        const commitBtns = Array.from(root.querySelectorAll('[data-reparcel-commit]'));
        state.commitBtns = commitBtns;

        // X and Cancel are the same act: discard and leave (with a warning when there is work).
        const cancelBtn = root.querySelector('[data-reparcel-cancel]');
        if (cancelBtn) cancelBtn.addEventListener('click', () => { cancelModal(); });
        commitBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                if (!persistResult()) return;
                ensureProposalDefaults();
                closeModal({ skipPersist: true });
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

        Array.from(root.querySelectorAll('[data-reparcel-all-public]')).forEach((btn) => {
            btn.addEventListener('click', assignPublicToAllSlices);
        });

        state.escHandler = (event) => {
            if (event.defaultPrevented) return;
            const targetTag = (event.target && event.target.tagName) || '';
            const typing = targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT' || event.target?.isContentEditable;
            if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && !state.drawing.active
                && typeof state.nodeEdit.focusRemove === 'function') {
                event.preventDefault();
                const remove = state.nodeEdit.focusRemove;
                state.nodeEdit.focusRemove = null;
                try { state.map.closePopup(); } catch (_) { }
                remove();
                return;
            }
            if (event.key === 'Escape') {
                // A node or boundary popup is the innermost thing open: close it, not the editor.
                const popupOpen = !!(state.map && state.map._popup && state.map.hasLayer && state.map.hasLayer(state.map._popup));
                if (popupOpen && !state.drawing.active) {
                    try { state.map.closePopup(); } catch (_) { }
                    return;
                }
                if (state.drawing.active) {
                    cancelDraw();
                    setStatus('', 'info');
                    return;
                }
                if (state.erase.active) {
                    toggleEraseMode(false);
                    return;
                }
                cancelModal();
                return;
            }
            const tag = (event.target && event.target.tagName) || '';
            const action = resolveDrawShortcut({
                active: state.drawing.active,
                editable: tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable,
                key: event.key,
                repeat: event.repeat,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey
            });
            if (!action) return;
            event.preventDefault();
            if (action === 'finish') onDrawFinish();
            else if (action === 'undo') undoLastPoint();
            else if (action === 'cancel') {
                cancelDraw();
                setStatus('', 'info');
            }
        };
        window.addEventListener('keydown', state.escHandler);

        const algorithmGroupEl = root.querySelector('[data-reparcel-alg-group]');
        if (algorithmGroupEl) {
            algorithmGroupEl.addEventListener('change', (event) => {
                const target = event.target;
                if (!target || target.name !== 'reparcel-algorithm') return;
                const option = getAlgorithmOptionByKey(target.value);
                if (!option || option.disabled) return;
                // Draw freely starts from what is on the map, owners included: switching used to
                // wipe the layout down to one unassigned plot, so the first step of hand editing
                // was redoing the automatic split by hand. Erase boundaries to start over.
                state.carrySlices = option.key === 'manual' && state.slices.length
                    ? JSON.parse(JSON.stringify(state.slices))
                    : null;
                state.algorithm = option.key;
                state.subtitleData.algorithmLabel = option.label;
                updateSubtitleWithOwners(state.ownerShares.filter(entry => !isNoOwnerEntry(entry)).length);
                // The sweep orientation point only belongs to sweep-line mode.
                if (option.key !== 'sweep-line') {
                    destroySweepOrientation();
                }
                // Changing the starting layout replaces the canvas; abandon any unfinished stroke.
                cancelDraw();
                updateDrawToolButtons();
                // Manual means the NODE/EDGE system, not the polygon tool. It used to arm
                // drawing on entry, which made "draw a plot" look like the only manual way to
                // work and left boundary editing unreachable. Draw-plot and split-with-line are
                // tools inside this mode; the handles are the mode.
                if (state.historyCtl) state.historyCtl.clear();
                refreshPreview().then(() => {
                    toggleNodeEditing(EDITABLE_ALGORITHMS.includes(option.key));
                }).catch(() => { });
            });
        }

        const shuffleBtn = root.querySelector('[data-reparcel-shuffle]');
        if (shuffleBtn) {
            shuffleBtn.addEventListener('click', shuffleOwnership);
        }

        if (state.nodesBtn) {
            state.nodesBtn.addEventListener('click', () => toggleNodeEditing());
        }
        const history = ensureHistory();
        if (history) {
            // One shortcut and one button, both owned by the shared module.
            history.bindKeyboard(window);
            if (state.undoEditBtn) history.bindButton(state.undoEditBtn);
            if (state.redoEditBtn) history.bindRedoButton(state.redoEditBtn);
        }
        if (state.drawBtn) {
            state.drawBtn.addEventListener('click', () => toggleDrawMode('polygon'));
        }
        if (state.lineBtn) {
            state.lineBtn.addEventListener('click', () => toggleDrawMode('line'));
        }
        if (state.eraseBtn) {
            state.eraseBtn.addEventListener('click', () => toggleEraseMode());
        }
        updateDrawToolButtons();
        if (state.finishBtn) {
            state.finishBtn.addEventListener('click', () => onDrawFinish());
        }
        if (state.undoBtn) {
            state.undoBtn.addEventListener('click', undoLastPoint);
        }
        const cancelDrawBtn = root.querySelector('[data-reparcel-cancel-draw]');
        if (cancelDrawBtn) {
            cancelDrawBtn.addEventListener('click', () => { cancelDraw(); setStatus('', 'info'); });
        }

        if (state.compareBtn) {
            state.compareBtn.addEventListener('click', toggleCompare);
        }

        const uploadInput = root.querySelector('[data-reparcel-upload]');
        if (uploadInput) {
            uploadInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) handleGeojsonUpload(file);
                uploadInput.value = '';
            });
        }

        applyTranslations(root);

        return session;
    }

    function initMap() {
        const map = state.session?.map || window.map;
        if (!map) return false;
        // A pane above the plots for the editing tools. Insertion order is not enough to keep them
        // there: the preview layer calls bringToFront() on hover, so the moment the cursor crossed
        // a plot that plot jumped over the erase lines and swallowed their clicks — the eraser then
        // read as a tool for selecting parcels. A pane cannot be jumped over.
        const ensurePane = (name, zIndex) => {
            let pane = map.getPane(name);
            if (!pane && typeof map.createPane === 'function') pane = map.createPane(name);
            if (pane?.style) pane.style.zIndex = String(zIndex);
            return pane;
        };
        ensurePane('reparcelPlots', 655);
        ensurePane('reparcelTools', 675);
        state.map = map;
        map.whenReady(() => {
            if (state.algorithm === 'sweep-line') {
                initSweepOrientation();
                updateSweepDirLine();
            }
        });
        return true;
    }

    function formatArea(area) {
        return CbFormat.formatArea(Number.isFinite(area) ? area : 0);
    }

    // Ledger values are EUR: estimatedMarketPrice, else area × SQM_AVG_PRICE (EUR), and this editor
    // sets the proposal currency to EUR.
    function formatMoney(value) {
        return CbFormat.formatMoney(Number.isFinite(value) ? value : 0, 'EUR');
    }

    // True when we have meaningful land value to redistribute by; otherwise the
    // ledger falls back to area (m²) as the contribution metric.
    function ledgerUsesMoney() {
        return Number.isFinite(state.poolUnitValue) && state.poolUnitValue > 0;
    }

    function formatLedgerMetric(value) {
        if (!Number.isFinite(value)) return '—';
        return ledgerUsesMoney() ? formatMoney(value) : formatArea(value);
    }

    // Per-owner readjustment ledger: what they pooled, what they're entitled to
    // after the public-land contribution ratio, what they've been assigned, and
    // the cash balance (+ owner pays for surplus land, − owner is compensated).
    function computeOwnerLedger(entry) {
        // Open ground has no owner: nothing is owed or paid (subdivision.js ledgerOf, balance null).
        if (isNoOwnerEntry(entry) && subdivisionApi()) {
            return subdivisionApi().ledgerOf(entry, {
                basis: ledgerUsesMoney() ? 'value' : 'area',
                poolUnitValue: state.poolUnitValue,
                contributionRatio: state.contributionRatio,
                assignedArea: assignedAreaOf(entry.ownerKey)
            });
        }
        const useMoney = ledgerUsesMoney();
        const unit = useMoney ? state.poolUnitValue : 1;
        const contributed = entry.unresolvedContribution ? null : useMoney
            ? (Number.isFinite(entry.value) ? entry.value : (Number.isFinite(entry.area) ? entry.area * unit : null))
            : (Number.isFinite(entry.area) ? entry.area : null);
        const entitled = contributed === null ? null : contributed * (state.contributionRatio ?? 1);
        const assignedArea = assignedAreaOf(entry.ownerKey);
        const assigned = assignedArea * unit;
        return {
            contributed,
            entitled,
            assigned,
            assignedArea,
            cashBalance: entitled === null ? null : assigned - entitled
        };
    }

    function assignedAreaOf(ownerKey) {
        let assignedArea = 0;
        for (const slice of state.slices) {
            if (!Array.isArray(slice.owners) || !slice.owners.length) continue;
            const match = slice.owners.find(o => o.ownerKey === ownerKey);
            if (!match) continue;
            assignedArea += computeFeatureArea(sliceToFeature(slice)) * (match.share || 0);
        }
        return assignedArea;
    }

    function computeProRataJointOwners() {
        return window.ReparcellizationPlanUtils.jointOwnersForLayout(
            state.ownerShares.filter(owner => owner.ownerKey !== PUBLIC_LAND_KEY && !isNoOwnerEntry(owner)),
            state.slices, turf, ledgerUsesMoney() ? state.poolUnitValue : 1
        );
    }

    function applyJointOwnersToSlice(slice, owners) {
        slice.owners = cloneOwners(owners);
        slice.jointPool = true;
        slice.jointShareMode = 'pro-rata';
        slice.ownerKey = slice.owners[0]?.ownerKey || '';
        slice.displayName = t('reparcellization.modal.jointOwnership', 'Joint ownership');
        slice.color = blendOwnerColors(slice.owners);
    }

    function resyncJointSliceShares() {
        if (!state.slices.some(slice => slice.jointPool && slice.jointShareMode !== 'manual')) return;
        const owners = computeProRataJointOwners();
        state.slices.filter(slice => slice.jointPool && slice.jointShareMode !== 'manual')
            .forEach(slice => applyJointOwnersToSlice(slice, owners));
    }

    function buildAmendSlices() {
        if (!state.amendInputs.length) {
            const features = liveSelectionFeatures(state.selection);
            const plots = window.ReparcellizationPlanUtils.existingParcelPlots(features, state.parcelOwnerIndex);
            state.amendInputs = plots.map((plot, index) => ({
                geometry: plot.geometry,
                owners: cloneOwners(plot.owners),
                label: features[index].properties.BROJ_CESTICE || features[index].properties.parcelId,
                area: computeFeatureArea(features[index]),
                parcelId: String(features[index].properties.parcelId),
                ...(state.cadastreIdsByLiveParcel.has(String(features[index].properties.parcelId))
                    ? { cadastreParcelId: state.cadastreIdsByLiveParcel.get(String(features[index].properties.parcelId)) } : {})
            }));
        }
        return state.amendInputs.map(input => makePlotFromOwners(
            JSON.parse(JSON.stringify(input.geometry)), input.owners, 'amend'
        ));
    }

    function applyCourtyard(courtyard, derivation) {
        cancelDraw();
        toggleEraseMode(false);
        pushHistory();
        // Clip the building's courtyard to this selection; a building may span a larger block.
        if (!carvePlotIntoPlan(courtyard, computeProRataJointOwners(), 'form', { jointPool: true, derivation })) {
            discardLastHistory();
            setStatus(t('reparcellization.modal.status.courtyardError', 'Could not carve the courtyard. The layout has been kept.'), 'error');
            return;
        }
        conformLayout();
        settleSlices();
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
        renderNodeHandles();
        setStatus(t('reparcellization.modal.status.courtyardCarved', 'Courtyard carved and assigned jointly.'), 'info');
    }

    function openBuiltFormPicker() {
        if (state.algorithm !== 'amend') return;
        let candidates;
        try {
            const proposals = typeof proposalStorage !== 'undefined' ? proposalStorage.getAllProposals() : [];
            candidates = window.ReparcellizationPlanUtils.buildingCourtyardCandidates(proposals, state.superParcel, turf);
        } catch (error) {
            console.error('[reparcellization] Building courtyard lookup failed', error);
            setStatus(t('reparcellization.modal.status.courtyardError', 'Could not carve the courtyard. The layout has been kept.'), 'error');
            return;
        }
        if (!candidates.length) {
            setStatus(t('reparcellization.modal.status.noBlockProposals',
                'No building block with an enclosed courtyard overlaps these parcels.'), 'warning');
            return;
        }
        if (candidates.length === 1) {
            applyCourtyard(candidates[0].courtyard, candidates[0].derivation);
            return;
        }
        dismissOwnerPopup();
        const container = document.createElement('div');
        container.className = 'reparcel-owner-popup';
        const title = document.createElement('div');
        title.className = 'reparcel-owner-popup__title';
        title.textContent = t('reparcellization.modal.choosePlanTitle', 'Choose a building block');
        container.appendChild(title);
        for (const entry of candidates) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn reparcel-owner-popup__joint';
            button.textContent = entry.proposal.title || entry.proposal.name || String(entry.proposal.proposalId);
            button.addEventListener('click', () => {
                dismissOwnerPopup();
                applyCourtyard(entry.courtyard, entry.derivation);
            });
            container.appendChild(button);
        }
        state.ownerAssignmentPopup = L.popup({ maxWidth: 320 })
            .setLatLng(state.map.getCenter()).setContent(container).openOn(state.map);
    }

    // Default cash for an owner (+ receives, − pays): with a unit value the balance is money, so
    // a shortfall is compensated and a surplus is paid for. Without one the balance is in m² and
    // says nothing about money, so the default is none.
    function defaultCashOffer(ledger) {
        if (ledger.noOwner) return null;
        if (!ledgerUsesMoney() || !Number.isFinite(ledger.cashBalance)) return 0;
        return -ledger.cashBalance;
    }

    // Signed cash for an owner (+ receives, − pays): the user's edited override if any, else the default.
    function getCashOffer(ownerKey, ledger) {
        if (ledger && ledger.noOwner) return null;
        if (Object.prototype.hasOwnProperty.call(state.cashOfferOverrides, ownerKey)) {
            return Math.round(state.cashOfferOverrides[ownerKey] * 100) / 100;
        }
        const value = defaultCashOffer(ledger);
        return value === null ? null : Math.round(value * 100) / 100;
    }

    // Ledger fields for a signed amount. An amount being typed (empty, too many decimals) is kept
    // as an invalid offer, so validation names it instead of the editor throwing.
    function storedCash(amount) {
        if (amount === null) return { cashOffer: null };
        return Number.isFinite(amount) ? window.ReparcellizationDeal.cashFields(amount) : { cashOffer: amount };
    }

    // Payouts to owners (the proposal's offer) and owner payments, or NaN when an amount is invalid.
    function computeCashTotals() {
        let payOut = 0, payIn = 0;
        for (const entry of state.ownerShares) {
            if (isNoOwnerEntry(entry)) continue;
            const amount = getCashOffer(entry.ownerKey, computeOwnerLedger(entry));
            if (!Number.isFinite(amount)) return { payOut: NaN, payIn: NaN };
            if (amount > 0) payOut += amount; else payIn -= amount;
        }
        return { payOut: Math.round(payOut * 100) / 100, payIn: Math.round(payIn * 100) / 100 };
    }

    function computeTotalCashOffer() {
        return computeCashTotals().payOut;
    }

    function updateCashTotalDisplay() {
        if (!state.cashTotalEl) return;
        // A pool with no owner (a subdivision of bare ground) has nobody to pay or compensate.
        if (!state.ownerShares.some(entry => !isNoOwnerEntry(entry))) {
            state.cashTotalEl.textContent = '';
            return;
        }
        const { payOut, payIn } = computeCashTotals();
        if (!Number.isFinite(payOut)) {
            state.cashTotalEl.textContent = t('reparcellization.validation.invalid-readjustment-deal', 'Review the owner cash offers and proposal total.');
            return;
        }
        // The balanced schedule: owners' payouts and payments, and the sponsor line that zeroes it.
        const eur = amount => CbFormat.formatMoney(amount, 'EUR', { minFractionDigits: 2, maxFractionDigits: 2 });
        const sponsor = Math.round((payIn - payOut) * 100) / 100;
        state.cashTotalEl.textContent = [
            t('proposalApproval.money.summary', 'Owners receive {{out}} and pay {{in}} in total.', { out: eur(payOut), in: eur(payIn) }),
            sponsor < 0 ? t('proposalApproval.money.sponsorPays', 'The sponsor pays {{amount}}.', { amount: eur(-sponsor) })
                : sponsor > 0 ? t('proposalApproval.money.sponsorReceives', 'The sponsor receives {{amount}}.', { amount: eur(sponsor) })
                    : t('proposalApproval.money.sponsorNothing', 'Owner payments cover every payout; the sponsor pays nothing.')
        ].join(' ');
    }

    // The editor, publication and apply paths validate the same authored plan. Source rights
    // readiness is reported separately: an abstract allocation can be designed before it is known.
    function evaluatePlanCompleteness() {
        const totalArea = state.totalArea || computeFeatureArea(state.superParcel) || 0;
        let assignedArea = 0;
        let unassignedArea = 0;
        let unassignedCount = 0;
        for (const slice of state.slices) {
            const area = computeFeatureArea(sliceToFeature(slice));
            // A REAL owner is required — an owner slot with an empty ownerKey (the "Unassigned"
            // placeholder) does not count, so a plan with any unowned plot cannot be committed. Public
            // land counts (its ownerKey is PUBLIC_LAND_KEY). Use "All public" for a quick break-up.
            // Both owner shapes count: see normalizePlotOwners.
            if (plotIsAssigned(slice)) {
                assignedArea += area;
            } else {
                unassignedArea += area;
                unassignedCount++;
            }
        }
        const coverage = totalArea > 0 ? assignedArea / totalArea : 0;
        const fields = window.getActiveProposalDesignDraft?.()?.fields || {};
        const validation = window.ReparcellizationValidation.validatePlan(currentPlan(), {
            ...fields, approvalConfig: state.approvalConfig
        }, { turf });
        const ok = validation.valid && !state.shareDraftPending;
        return { totalArea, assignedArea, unassignedArea, unassignedCount, coverage, ok, validation };
    }

    function updateCommitState() {
        resyncJointSliceShares();
        const c = evaluatePlanCompleteness();
        ensureCommitAvailability(c.ok);
        renderRegimeCheck(c.validation.regimeCheck);
        // NO auto-persist here. This used to write the plan to the draft on every state change —
        // every drawn plot, every owner assignment — which made the editor a live writer rather
        // than a workspace: Cancel had nothing left to discard, because the edits were already
        // saved. Only the Done button persists now.
        if (!state.coverageEl) return;
        if (!state.slices.length) {
            state.coverageEl.textContent = '';
            state.coverageEl.removeAttribute('data-state');
            return;
        }
        if (state.shareDraftPending) {
            state.coverageEl.setAttribute('data-state', 'warn');
            state.coverageEl.textContent = t('reparcellization.modal.applySharesFirst', 'Apply the edited shares, or close the share editor to discard them.');
        } else if (c.ok) {
            state.coverageEl.setAttribute('data-state', 'ok');
            state.coverageEl.textContent = t(
                'reparcellization.modal.coverageComplete',
                'All pooled land assigned ({{pct}}%).',
                { pct: CbFormat.formatNumber(c.coverage * 100, { maxFractionDigits: 1, minFractionDigits: 1 }) }
            );
            if (!c.validation.rightsReady) state.coverageEl.textContent += ' ' + t('reparcellization.modal.sourceRightsNeeded',
                'Design ready. Approval needs complete source ownership and any required parcel areas.');
        } else if (c.unassignedCount) {
            state.coverageEl.setAttribute('data-state', 'warn');
            state.coverageEl.textContent = t(
                'reparcellization.modal.coverageIncomplete',
                '{{count}} plot(s) unassigned · {{area}} not yet assigned ({{pct}}% covered).',
                {
                    count: c.unassignedCount,
                    area: formatArea(c.unassignedArea),
                    pct: CbFormat.formatNumber(c.coverage * 100, { maxFractionDigits: 1, minFractionDigits: 1 })
                }
            );
        } else {
            state.coverageEl.setAttribute('data-state', 'warn');
            state.coverageEl.textContent = [...new Set(c.validation.errors.map(error => (error.code === 'regime-allocation' && window.ProposalApprovalText
                ? window.ProposalApprovalText.checkLines({ rules: [error.rule] }, t, key => state.ownerShares.find(owner => owner.ownerKey === key)?.displayName || key)[0]
                : t(`reparcellization.validation.${error.code}`, error.message))))].join(' ');
        }
    }

    function updateLegend(ownerShares) {
        resyncJointSliceShares();
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
                <th>${t('reparcellization.modal.colCash', 'Cash (+ receives, − pays)')}</th>
            </tr>`;
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            ownerShares.forEach((entry, index) => {
                const color = safePlanColor(entry.color, pickOwnerColor(entry.ownerKey, index));
                entry.color = color;
                const ledger = computeOwnerLedger(entry);
                if (ledger.noOwner) {
                    // Open ground: pooled and assigned area, no balance and no cash (nobody to pay).
                    const tr = document.createElement('tr');
                    tr.className = 'reparcel-ledger-row--no-owner';
                    tr.innerHTML = `
                    <td>${ownerLegendCellHtml({ ...entry, displayName: ownerDisplayName(entry.displayName) }, color)}</td>
                    <td class="area-cell">${formatArea(ledger.contributed)}</td>
                    <td class="area-cell">${formatArea(ledger.assignedArea)}</td>
                    <td class="area-cell bal-even" title="${escapeHtml(t('reparcellization.modal.noOwnerBalance', 'Open ground has no owner: nothing is owed or paid.'))}">—</td>
                    <td class="cash-offer-cell">—</td>`;
                    tbody.appendChild(tr);
                    return;
                }
                // Balance sign: + owner receives surplus land and pays, − owner is compensated.
                const balClass = Math.abs(ledger.cashBalance) < Math.max(1, ledger.entitled * 0.005)
                    ? 'bal-even'
                    : (ledger.cashBalance > 0 ? 'bal-pays' : 'bal-due');
                const balSign = ledger.cashBalance > 0 ? '+' : '';
                const cashOffer = getCashOffer(entry.ownerKey, ledger);
                const tr = document.createElement('tr');
                if (entry.unresolvedContribution) tr.className = 'reparcel-ledger-row--unresolved';
                const unresolvedNote = entry.unresolvedContribution
                    ? `<small class="reparcel-ledger-unresolved-note">${escapeHtml(t('reparcellization.modal.savedRecipientUnresolved', 'Saved output recipient has no matching current input contribution.'))}</small>`
                    : '';
                tr.innerHTML = `
                    <td>${ownerLegendCellHtml({ ...entry, displayName: ownerDisplayName(entry.displayName) }, color)}${unresolvedNote}</td>
                    <td class="area-cell">${formatLedgerMetric(ledger.contributed)}</td>
                    <td class="area-cell">${formatLedgerMetric(ledger.assigned)}</td>
                    <td class="area-cell ${balClass}">${balSign}${formatLedgerMetric(ledger.cashBalance)}</td>
                    <td class="cash-offer-cell">${cashOfferInputHtml(entry.ownerKey, cashOffer)}</td>`;
                tbody.appendChild(tr);
            });
            const labels = Array.from(thead.querySelectorAll('th'), th => th.textContent);
            tbody.querySelectorAll('tr').forEach(row => {
                Array.from(row.cells).forEach((cell, index) => { cell.dataset.label = labels[index]; });
                const input = row.querySelector('.cash-offer-input');
                if (input) input.setAttribute('aria-label', `${labels[4]} — ${row.cells[0].textContent.trim()}`);
            });
            table.appendChild(tbody);
            state.legendListEl.appendChild(table);

            // Wire cash-offer inputs (prefilled to the shortfall for compensated owners).
            state.legendListEl.querySelectorAll('.cash-offer-input').forEach(input => {
                input.addEventListener('input', () => {
                    const key = input.getAttribute('data-owner-key');
                    state.cashOfferOverrides[key] = input.validity.valid ? input.valueAsNumber : NaN;
                    updateCashTotalDisplay();
                    updateOwnerReview();
                    updateCommitState();
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
                const unassignedLabel = t('reparcellization.modal.unassigned', 'Unassigned');
                const ownerHtml = owners
                    .map(o => newPlotOwnerHtml({ ...o, displayName: ownerDisplayName(o.displayName, unassignedLabel) + (owners.length > 1 ? ` (${formatPercent(o.share)})` : '') }, { publicKey: PUBLIC_LAND_KEY, unassignedLabel }))
                    .join('');
                const tr = document.createElement('tr');
                tr.className = 'reparcel-newplot-row';
                tr.innerHTML = `
                    <td class="plot-cell"><strong>${idx + 1}</strong> <span class="area-cell">${formatArea(area)}</span></td>
                    <td>${ownerHtml}<button type="button" class="btn btn-sm reparcel-edit-shares">${escapeHtml(t('reparcellization.modal.editShares', 'Edit shares'))}</button></td>`;
                tr.querySelector('.reparcel-edit-shares').addEventListener('click', () => {
                    exitCompare();
                    setPlotsTab('new');
                    toggleAssignMode(true);
                    const center = L.geoJSON(sliceToFeature(slice)).getBounds().getCenter();
                    onSliceClick(idx, center);
                });
                // Hovering a row highlights that plot on the map — makes it clear that
                // one plot can render as several disjoint pieces (carved MultiPolygon).
                tr.addEventListener('mouseenter', () => highlightSlice(idx, true));
                tr.addEventListener('mouseleave', () => highlightSlice(idx, false));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            state.newPlotsListEl.appendChild(table);
        }

        updateOldPlotsList();
        updateOwnerReview();
        updateCommitState();
    }

    // ── Inputs (old plots) ───────────────────────────────────────────────────────────────────────
    // The cadastral parcels that were pooled. Read-only: this editor divides the pool, it does not
    // edit the cadastre. Switching to this view drops the plots back to a faint underlay so the
    // parcels being replaced are what you actually see.

    function inputParcelFeatures() {
        return liveSelectionFeatures(state.selection);
    }

    function reviewInputs(ownerKey) {
        if (state.amendInputs.length) return state.amendInputs
            .filter(input => input.owners?.some(owner => owner.ownerKey === ownerKey))
            .map(input => ({ type: 'Feature', geometry: input.geometry, properties: { label: input.label || input.parcelId } }));
        return inputParcelFeatures().filter(feature => {
            const id = String(feature.properties?.parcelId || feature.properties?.parcel_id || feature.properties?.id || '');
            return state.parcelOwnerIndex.get(id)?.some(owner => owner.ownerKey === ownerKey);
        });
    }

    function clearOwnerReviewHighlights() {
        state.ownerReviewLayers.forEach(layer => { try { layer.remove(); } catch (_) { } });
        state.ownerReviewLayers = [];
    }

    function drawOwnerReviewHighlights() {
        clearOwnerReviewHighlights();
        if (!state.map || !state.reviewOwnerKey) return;
        const inputs = reviewInputs(state.reviewOwnerKey);
        const outputs = state.slices.filter(slice => slice.owners?.some(owner => owner.ownerKey === state.reviewOwnerKey)).map(sliceToFeature);
        const add = (map, features, before) => {
            if (!map || !features.length) return;
            state.ownerReviewLayers.push(L.geoJSON({ type: 'FeatureCollection', features }, {
                interactive: false,
                style: { color: before ? '#b45309' : '#0369a1', weight: 4, fillOpacity: before ? 0.08 : 0.18,
                    dashArray: before ? '7 5' : null, className: before ? 'reparcel-owner-input' : 'reparcel-owner-output' }
            }).addTo(map));
        };
        if (state.compare.active) add(state.compare.map2, inputs, true);
        else add(state.map, inputs, true);
        if (state.plotsTab === 'new') add(state.map, outputs, false);
    }

    function updateOwnerReview() {
        const host = state.ownerReviewEl;
        if (!host) return;
        const owners = state.ownerShares.filter(owner => !isNoOwnerEntry(owner));
        if (!owners.some(owner => owner.ownerKey === state.reviewOwnerKey)) state.reviewOwnerKey = '';
        host.replaceChildren();
        const label = document.createElement('label');
        label.textContent = t('reparcellization.modal.ownerReview', 'Review one owner');
        const select = document.createElement('select');
        select.setAttribute('data-reparcel-review-owner', '');
        select.append(new Option(t('reparcellization.modal.allOwners', 'All owners'), ''));
        owners.forEach(owner => select.append(new Option(ownerDisplayName(owner.displayName), owner.ownerKey)));
        select.value = state.reviewOwnerKey;
        label.append(select);
        host.append(label);
        select.addEventListener('change', () => {
            state.reviewOwnerKey = select.value;
            updateOwnerReview();
        });
        const owner = owners.find(entry => entry.ownerKey === state.reviewOwnerKey);
        if (owner) {
            try {
                const impact = window.ReparcellizationAllocation.ownerImpact({ ...owner,
                    ...storedCash(getCashOffer(owner.ownerKey, computeOwnerLedger(owner))) }, state.slices, turf);
                const unknown = t('reparcellization.modal.unknownContribution', 'Unknown');
                const entries = [
                    ['contributed', t('reparcellization.modal.contributedLand', 'Contributed land'), impact.contributedAreaM2 === null ? unknown : formatArea(impact.contributedAreaM2)],
                    ['assigned', t('reparcellization.modal.assignedLand', 'Assigned land (by share)'), formatArea(impact.assignedAreaM2)],
                    ['change', t('reparcellization.modal.landChange', 'Land change'), impact.areaChangeM2 === null ? unknown : `${impact.areaChangeM2 > 0 ? '+' : ''}${formatArea(impact.areaChangeM2)}`],
                    impact.cashPaymentCents > 0
                        ? ['cash', t('reparcellization.modal.ownerPays', 'Cash the owner pays'), CbFormat.formatMoney(impact.cashPaymentCents / 100, 'EUR', { minFractionDigits: 2, maxFractionDigits: 2 })]
                        : ['cash', t('reparcellization.modal.colCashOffer', 'Cash offer'), CbFormat.formatMoney(impact.cashOfferCents / 100, 'EUR', { minFractionDigits: 2, maxFractionDigits: 2 })]
                ];
                const details = document.createElement('dl');
                entries.forEach(([key, title, value]) => {
                    const dt = document.createElement('dt'); dt.textContent = title;
                    const dd = document.createElement('dd'); dd.textContent = value; dd.dataset.impact = key;
                    details.append(dt, dd);
                });
                host.append(details);
                const source = document.createElement('p');
                const inputs = reviewInputs(owner.ownerKey);
                source.textContent = t('reparcellization.modal.ownerInputParcels', 'Input parcels: {{parcels}}', {
                    parcels: inputs.length ? inputs.map(inputParcelLabel).join(', ') : unknown
                });
                host.append(source);
                const list = document.createElement('ul');
                impact.plots.forEach(plot => {
                    const li = document.createElement('li');
                    li.textContent = t('reparcellization.modal.ownerOutputShare', 'Plot {{plot}} · {{share}} · {{area}}', {
                        plot: plot.index + 1, share: formatPercent(plot.share), area: formatArea(plot.assignedAreaM2)
                    });
                    list.append(li);
                });
                host.append(list);
                const hint = document.createElement('p');
                hint.className = 'reparcel-owner-review__hint';
                hint.textContent = t('reparcellization.modal.ownerHighlightHint', 'Dashed amber: input parcels. Solid blue: assigned plots. Use Before / After to compare.');
                host.append(hint);
            } catch (_) {
                const error = document.createElement('p');
                error.textContent = t('reparcellization.modal.ownerReviewInvalid', 'Complete the plot geometry, shares and cash offers to review this owner.');
                host.append(error);
            }
        }
        drawOwnerReviewHighlights();
    }

    function inputParcelLabel(feature) {
        const props = feature.properties || {};
        return props.broj_cesti || props.parcelNumber || props.label
            || String(props.parcel_id || props.id || '').split('-').slice(2).join('-')
            || t('reparcellization.modal.unknownParcel', 'Parcel');
    }

    function setPlotsTab(tab) {
        const next = tab === 'old' ? 'old' : 'new';
        if (state.plotsTab === next) return;
        state.plotsTab = next;
        (state.plotsTabBtns || []).forEach(btn => {
            const active = btn.getAttribute('data-reparcel-plots-tab') === next;
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        if (state.newPlotsListEl) state.newPlotsListEl.hidden = next !== 'new';
        if (state.oldPlotsListEl) state.oldPlotsListEl.hidden = next !== 'old';
        // Editing belongs to the new-plots view only — there is nothing here to edit in the
        // cadastre, and leaving handles up over a read-only view invites a drag that means nothing.
        if (next === 'old') {
            state.nodeEditWasActive = state.nodeEdit.active;
            if (state.nodeEdit.active) toggleNodeEditing(false);
            if (state.drawing.active) cancelDraw();
        } else if (state.nodeEditWasActive) {
            state.nodeEditWasActive = false;
            toggleNodeEditing(true);
        }
        (state.modal ? [state.modal] : []).forEach(el => el.classList.toggle('reparcel-old-plots-view', next === 'old'));
        clearInputHighlight();
        drawPreview();
    }

    function clearInputHighlight() {
        if (state.inputHighlightLayer) {
            try { state.inputHighlightLayer.remove(); } catch (_) { }
            state.inputHighlightLayer = null;
        }
    }

    function highlightInputParcel(feature, on) {
        clearInputHighlight();
        if (!on || !state.map || !feature) return;
        state.inputHighlightLayer = L.geoJSON(feature, {
            style: { color: '#b45309', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.35 },
            interactive: false,
            pane: 'reparcelTools'
        }).addTo(state.map);
    }

    function updateOldPlotsList() {
        if (!state.oldPlotsListEl) return;
        state.oldPlotsListEl.innerHTML = '';
        const features = inputParcelFeatures();
        const declared = (state.selection && Array.isArray(state.selection.ids)) ? state.selection.ids.length : 0;
        if (!features.length) {
            const empty = document.createElement('p');
            empty.className = 'reparcel-oldplots-empty';
            empty.textContent = t('reparcellization.modal.oldPlotsMissing',
                'The input parcels could not be loaded, so the pooled outline is derived from the plan itself.');
            state.oldPlotsListEl.appendChild(empty);
            return;
        }
        const table = document.createElement('table');
        table.className = 'reparcel-newplots-table reparcel-oldplots-table';
        const thead = document.createElement('thead');
        thead.innerHTML = `<tr>
            <th>${t('reparcellization.modal.colParcel', 'Parcel')}</th>
            <th>${t('reparcellization.modal.colArea', 'Area')}</th>
        </tr>`;
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        features.forEach(feature => {
            const tr = document.createElement('tr');
            tr.className = 'reparcel-oldplot-row';
            const area = computeFeatureArea(feature);
            tr.innerHTML = `
                <td class="plot-cell"><strong>${escapeHtml(inputParcelLabel(feature))}</strong></td>
                <td class="area-cell">${formatArea(area)}</td>`;
            tr.addEventListener('mouseenter', () => highlightInputParcel(feature, true));
            tr.addEventListener('mouseleave', () => highlightInputParcel(feature, false));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        state.oldPlotsListEl.appendChild(table);
        if (features.length !== declared && declared) {
            const note = document.createElement('p');
            note.className = 'reparcel-oldplots-empty';
            note.textContent = t('reparcellization.modal.oldPlotsPartial',
                '{{shown}} of {{declared}} input parcels could be loaded.',
                { shown: features.length, declared });
            state.oldPlotsListEl.appendChild(note);
        }
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

        if (typeof refreshReparcellizationCashTerms === 'function') {
            refreshReparcellizationCashTerms(document.querySelector('.create-proposal-modal'));
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

    function makePlotFromOwners(geometry, owners, source, flags = {}) {
        const safeOwners = normalizePlotOwners({ owners });
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
            source: source || 'manual',
            jointPool: flags.jointPool === true,
            ...(flags.jointPool ? { jointShareMode: flags.jointShareMode === 'manual' ? 'manual' : 'pro-rata' } : {}),
            ...(flags.derivation ? { derivation: JSON.parse(JSON.stringify(flags.derivation)) } : {})
        };
    }

    function createUnassignedPlot(geometry, source) {
        return makePlotFromOwners(geometry, [], source || 'base');
    }

    // Rebuild plan slices from a saved plan's polygons[] — the exact inverse of persistResult().
    // Fields are restored verbatim rather than re-derived, so owner assignments, blended colours
    // and hand-drawn plots survive a copy untouched.
    //
    // A plot's owner is carried BOTH ways: the singular ownerKey/displayName (one owner) and the
    // owners[] array (shares between several). Everywhere else in this module the two are kept in
    // lockstep; hydration used to read only the array, so a single-owner plan — every plan an
    // importer writes, and the Borovje UPU in particular — came back with all its plots reading
    // "unassigned". That silently failed the completeness gate, and Done could never enable again.
    function hydrateSlicesFromPolygons(polygons) {
        if (!Array.isArray(polygons)) return [];
        return polygons
            .filter(polygon => polygon && polygon.geometry)
            .map(polygon => {
                // A shared plan is untrusted input: keys/names are coerced to strings (escaped at
                // every render) and colours must be hex literals, since they land in style="".
                const ownerKey = polygon.ownerKey ? String(polygon.ownerKey) : '';
                const displayName = polygon.displayName ? String(polygon.displayName) : t('reparcellization.modal.unassigned', 'Unassigned');
                const color = safePlanColor(polygon.color, '#cccccc');
                return {
                    ownerKey,
                    displayName,
                    percent: Number.isFinite(Number(polygon.percent)) ? Number(polygon.percent) : 0,
                    color,
                    geometry: JSON.parse(JSON.stringify(polygon.geometry)),
                    owners: normalizePlotOwners({ ...polygon, ownerKey, displayName, color })
                        .map(owner => ({ ...owner, color: safePlanColor(owner.color, color) })),
                    source: polygon.source || 'manual',
                    jointPool: polygon.jointPool === true,
                    ...(polygon.jointPool ? { jointShareMode: polygon.jointShareMode === 'manual' ? 'manual' : 'pro-rata' } : {}),
                    ...(polygon.derivation ? { derivation: JSON.parse(JSON.stringify(polygon.derivation)) } : {})
                };
            });
    }

    // Carve a polygon into the current plan: clip to the pool, subtract it from
    // every overlapping plot, then add it as a new plot. Returns true on success.
    function carvePlotIntoPlan(polygonFeature, ownersForNew, source, flags = {}) {
        if (typeof turf === 'undefined' || !state.superParcel) return false;
        try {
            const next = window.ReparcellizationPlanUtils.carveLayout({
                pool: state.superParcel, slices: state.slices, polygon: polygonFeature,
                owners: ownersForNew, source, jointPool: flags.jointPool === true, derivation: flags.derivation
            }, turf);
            if (!next) return false;
            state.slices = next.map(slice => makePlotFromOwners(slice.geometry, slice.owners, slice.source, slice));
            return true;
        } catch (error) {
            console.error('[reparcellization] Carve failed; layout retained', error);
            setStatus(t('reparcellization.modal.status.courtyardError', 'Could not carve the courtyard. The layout has been kept.'), 'error');
            return false;
        }
    }

    // Settle the current plot list back onto the pool and drop whatever no longer has land.
    //
    // This is what lets the cutting tools stop deleting slivers. They used to discard any piece
    // under 1 m², which quietly took that land OUT of the plan — and the apply gate wants the
    // outputs to cover the inputs to within 5 m², so a few cuts near a corner could fail a plan for
    // a reason invisible in the editor. Healing hands the scrap to the plot it borders most
    // instead, so nothing is ever dropped on the floor.
    function settleSlices(previous) {
        const settled = healLayout(state.slices.map(slice => slice.geometry), previous);
        if (!Array.isArray(settled)) { recomputeSliceAreas(); return; }
        const kept = [];
        state.slices.forEach((slice, index) => {
            const geometry = settled[index];
            if (geometry === undefined) { kept.push(slice); return; }
            if (!geometry) return; // all of its land went to its neighbours
            slice.geometry = geometry;
            kept.push(slice);
        });
        if (kept.length !== state.slices.length) state.selectedSliceIndex = null;
        state.slices = kept;
        recomputeSliceAreas();
    }

    // Give every plot the vertices its neighbours already have on the same lines. The reasoning
    // lives in plot-cut.js; this is the part that touches state.
    function conformLayout() {
        const cutApi = window.__plotCut;
        if (!cutApi || !state.slices.length) return 0;
        const conformed = cutApi.conformGeometries(state.slices.map(slice => slice.geometry));
        const added = conformed.inserted || 0;
        if (!added) return 0;
        state.slices.forEach((slice, index) => {
            if (conformed[index]) slice.geometry = conformed[index];
        });
        console.debug('[reparcellization] layout conformed', { verticesAdded: added, plots: state.slices.length });
        return added;
    }

    // What a cut is measured against: the current boundary graph, the pool, and the map's current
    // scale (snap radii are in pixels, so they mean the same thing at every zoom).
    function cutContext() {
        const topo = window.__plotTopology;
        if (!topo || !state.superParcel || !state.slices.length) return null;
        return {
            topology: topo.annotateBoundary(topo.buildTopology(state.slices), poolBoundaryIndex()),
            pool: state.superParcel,
            scale: mapScale()
        };
    }

    // Degrees per pixel on each axis. Longitude and latitude degrees are different lengths on the
    // ground, so a snap radius expressed in raw degrees is an ellipse on screen — this is what lets
    // plot-cut.js measure in the units the user's eye is using.
    function mapScale() {
        if (!state.map) return { x: 1, y: 1 };
        try {
            const center = state.map.getCenter();
            const origin = state.map.latLngToContainerPoint(center);
            const east = state.map.containerPointToLatLng(L.point(origin.x + 1, origin.y));
            const south = state.map.containerPointToLatLng(L.point(origin.x, origin.y + 1));
            return {
                x: Math.abs(east.lng - center.lng) || 1e-9,
                y: Math.abs(south.lat - center.lat) || 1e-9
            };
        } catch (_) { return { x: 1, y: 1 }; }
    }

    // Commit a cut. Pieces inherit the owners of the plot they were cut from; a plot the cut only
    // NODED (a neighbour across a T-junction) keeps its identity and just gains the vertex.
    function applyCutResult(result) {
        const groups = new Map();
        (result.results || []).forEach(entry => {
            if (!entry || !entry.geometry) return;
            if (!groups.has(entry.sourceIndex)) groups.set(entry.sourceIndex, []);
            groups.get(entry.sourceIndex).push(entry.geometry);
        });
        // Captured before anything is reassigned. `previous` lines up with the NEW plot list so the
        // settle afterwards can be scoped: without it the whole plan is settled, and drawing one
        // line across one plot clipped thirty unrelated ones. An edit should touch what it names.
        const wasGeometry = state.slices.map(slice => slice.geometry);
        const next = [];
        const previous = [];
        state.slices.forEach((slice, index) => {
            const pieces = groups.get(index);
            if (!pieces || !pieces.length) { next.push(slice); previous.push(wasGeometry[index]); return; }
            if (pieces.length === 1) {
                slice.geometry = pieces[0];
                next.push(slice);
                previous.push(wasGeometry[index]);
                return;
            }
            pieces.forEach((geometry, position) => {
                next.push(makePlotFromOwners(geometry, cloneOwners(slice.owners), slice.source || 'manual', slice));
                // The first piece inherits the parent it was cut from; the rest are new, which the
                // scoped settle reads as "changed, and holding nothing before". The arithmetic
                // balances — the parent is counted once and the pieces add back up to it.
                previous.push(position === 0 ? wasGeometry[index] : null);
            });
        });
        state.slices = next;
        state.selectedSliceIndex = null;
        settleSlices(previous);
        updateLegend(state.ownerShares);
        try {
            drawPreview();
            updateCommitState();
        } finally {
            renderNodeHandles();
        }
    }


    // ── Manual plot drawing ──────────────────────────────────────────────

    // The two hand-edited starting layouts share the same drawing and boundary tools.
    // Point the starting-layout control (and the subtitle) at `key` without recomputing the
    // layout. Used when an edit or an undo changes which kind of layout is on the map.
    function setAlgorithmKey(key) {
        const option = getAlgorithmOptionByKey(key);
        if (!option) return;
        state.algorithm = option.key;
        if (option.key === 'sweep-line') initSweepOrientation();
        else destroySweepOrientation();
        const radio = state.modal && state.modal.querySelector(`input[name="reparcel-algorithm"][value="${option.key}"]`);
        if (radio) radio.checked = true;
        if (state.subtitleData) state.subtitleData.algorithmLabel = option.label;
        updateSubtitleWithOwners(state.ownerShares.filter(entry => !isNoOwnerEntry(entry)).length);
        updateDrawToolButtons();
        updateActiveModeHint();
    }

    // The automatic split is regenerated whenever the sweep handle moves, so a hand edit cannot
    // live inside it. Instead of refusing the edit, the first one turns the automatic layout into
    // a drawn one ("Draw freely") with the same plots and owners; undo turns it back.
    function adoptLayoutForEditing() {
        if (state.algorithm !== 'sweep-line') return false;
        setAlgorithmKey('manual');
        console.debug('[reparcellization] automatic layout adopted for hand editing', { plots: state.slices.length });
        return true;
    }

    // Automatic layouts can be edited too: the first edit adopts the layout as a drawn one
    // (adoptLayoutForEditing), so every tool is usable whatever the starting layout.
    const EDITABLE_ALGORITHMS = ['manual', 'amend', 'sweep-line'];

    function updateDrawToolButtons() {
        const enabled = state.ownershipMode === 'multiple' && EDITABLE_ALGORITHMS.includes(state.algorithm);
        [state.drawBtn, state.lineBtn, state.eraseBtn].forEach(btn => { if (btn) btn.disabled = !enabled; });
        if (state.courtyardToolsEl) state.courtyardToolsEl.hidden = state.algorithm !== 'amend' || state.plotsTab === 'old';
        if (!enabled && state.erase.active) toggleEraseMode(false);
    }

    function setDrawButtonsActive() {
        const active = state.drawing.active;
        const polyOn = active && state.drawing.mode === 'polygon';
        const lineOn = active && state.drawing.mode === 'line';
        if (state.drawBtn) state.drawBtn.setAttribute('aria-pressed', polyOn ? 'true' : 'false');
        if (state.lineBtn) state.lineBtn.setAttribute('aria-pressed', lineOn ? 'true' : 'false');
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
        // Rubber-band: while drawing, the shape follows the cursor so every segment is
        // visible as it is being placed, not only after the click.
        if (state.drawing.active && Array.isArray(state.drawing.cursor)) {
            latlngs.push(L.latLng(state.drawing.cursor[1], state.drawing.cursor[0]));
        }
        if (latlngs.length < 2) return;
        if (state.drawing.mode === 'line') {
            state.drawing.tempLayer = L.polyline(latlngs, {
                color: '#C73E1D', weight: 3, dashArray: '6 4', interactive: false, pane: 'reparcelTools'
            }).addTo(state.map);
        } else if (latlngs.length >= 3) {
            state.drawing.tempLayer = L.polygon(latlngs, {
                color: '#1B998B', weight: 2, dashArray: '5 4', fillColor: '#1B998B', fillOpacity: 0.25,
                interactive: false, pane: 'reparcelTools'
            }).addTo(state.map);
        } else {
            state.drawing.tempLayer = L.polyline(latlngs, {
                color: '#1B998B', weight: 2, dashArray: '5 4', interactive: false, pane: 'reparcelTools'
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
                icon: getVertexIcon(),
                pane: 'onMapEditorHandles'
            });
            marker.on('drag', () => {
                const ll = marker.getLatLng();
                const snap = snapFor([ll.lng, ll.lat]);
                state.drawing.points[i] = snap ? snap.coord.slice() : [ll.lng, ll.lat];
                state.drawing.frozen[i] = state.drawing.shift;
                updateDrawShape();
                renderSnapFeedback(snap, previewLine(state.drawing.cursor).anchors);
            });
            marker.addTo(state.map);
            state.drawing.tempMarkers.push(marker);
        });
    }

    // ── Snapping ─────────────────────────────────────────────────────────
    //
    // A cut that is meant to start at an existing corner has to actually start there, to the last
    // decimal: a hair's gap is a different node, and the boundary it makes never joins the one it
    // was drawn onto. Snapping is what makes that reachable by hand — and Shift turns it off for
    // the times when the nearest node is not what was meant.

    function snapFor(coord) {
        const cutApi = window.__plotCut;
        const context = state.drawing.context;
        if (!cutApi || !context || state.drawing.shift || !Array.isArray(coord)) return null;
        const snap = cutApi.snapPoint(coord, context, { scale: context.scale });
        return (snap && snap.kind !== 'free') ? snap : null;
    }

    // The nodes already in the fabric, drawn as plain dots. The editing handles are Leaflet markers
    // and would swallow the clicks that place vertices, so they come down while drawing — which
    // used to leave the user drawing blind, aiming at corners they could not see.
    function renderDrawGhosts() {
        clearDrawGhosts();
        const context = state.drawing.context;
        if (!context || !state.map) return;
        const layer = L.layerGroup();
        (context.topology.nodes || []).forEach(node => {
            L.circleMarker([node.coord[1], node.coord[0]], {
                radius: 3, weight: 1, color: '#1B998B', fillColor: '#ffffff', fillOpacity: 1,
                interactive: false, pane: 'reparcelTools', className: 'reparcel-snap-ghost'
            }).addTo(layer);
        });
        layer.addTo(state.map);
        state.drawing.ghostLayer = layer;
    }

    function clearDrawGhosts() {
        if (state.drawing.ghostLayer) {
            try { state.drawing.ghostLayer.remove(); } catch (_) { }
            state.drawing.ghostLayer = null;
        }
    }

    // What the cut is about to do, drawn before it is committed: where this point will attach, and
    // every crossing that is about to become a node.
    function renderSnapFeedback(snap, anchors) {
        if (!state.map || !state.drawing.active) return;
        // One layer group, refilled: this runs on every mousemove, and adding/removing a group
        // from the map sixty times a second is churn the pointer can feel.
        let layer = state.drawing.snapLayer;
        if (layer) layer.clearLayers();
        else layer = L.layerGroup().addTo(state.map);
        const list = anchors || [];
        // The outermost two are where the new boundary will END; the ones between are nodes it
        // will create in passing. Drawing them differently says which is which before committing.
        list.slice(0, 80).forEach((anchor, index) => {
            const terminal = list.length >= 2 && (index === 0 || index === list.length - 1);
            L.circleMarker([anchor.coord[1], anchor.coord[0]], {
                radius: terminal ? 6 : 4, weight: 2, color: '#C73E1D',
                fillColor: terminal ? '#C73E1D' : '#ffffff', fillOpacity: terminal ? 0.8 : 1,
                interactive: false, pane: 'reparcelTools', className: 'reparcel-cut-crossing'
            }).addTo(layer);
        });
        if (snap) {
            L.circleMarker([snap.coord[1], snap.coord[0]], {
                radius: snap.kind === 'node' ? 8 : 6, weight: 2,
                color: '#F18F01', fillColor: '#F18F01', fillOpacity: 0.35,
                interactive: false, pane: 'reparcelTools', className: 'reparcel-snap-target'
            }).addTo(layer);
        }
        state.drawing.snapLayer = layer;
    }

    // What this line will do, said before the click rather than after. The anchor count is the
    // part that matters: fewer than two and the line implies no boundary, so nothing happens.
    function snapStatusText(snap, anchors) {
        const count = (anchors || []).length;
        if (state.drawing.mode !== 'line') {
            return t('reparcellization.modal.status.drawHint',
                'Click to add points, drag to adjust, then press Finish.');
        }
        if (count >= 2) {
            return t('reparcellization.modal.status.lineAnchored',
                'Anchored in {{count}} places — the line will be drawn between the outermost two, and nowhere else.',
                { count });
        }
        if (count === 1) {
            return t('reparcellization.modal.status.lineOneAnchor',
                'One anchor so far. Cross another boundary, or finish on an existing corner.');
        }
        if (state.drawing.shift) {
            return t('reparcellization.modal.status.cutFree',
                'Snapping off while Shift is held — the point lands exactly where you click.');
        }
        if (snap && snap.kind === 'node') {
            return t('reparcellization.modal.status.cutOnNode',
                'Starts on an existing corner — that is one of the two anchors it needs.');
        }
        return t('reparcellization.modal.status.lineNoAnchor',
            'No anchors yet. A line has to cross a boundary or meet an existing corner in two places to make one.');
    }

    // What the line as it currently stands would anchor on. The anchors ARE the answer to "will
    // this do anything": a new boundary needs a node at each end, so two is the minimum, and
    // showing the count as it is drawn means the user is never guessing.
    function previewLine(cursor) {
        const empty = { crossings: [], anchors: [] };
        const cutApi = window.__plotCut;
        const context = state.drawing.context;
        if (!cutApi || !context || state.drawing.mode !== 'line') return empty;
        const points = state.drawing.points.concat(Array.isArray(cursor) ? [cursor] : []);
        if (points.length < 2) return empty;
        try {
            const crossings = cutApi.crossingsOf(points, context, { scale: context.scale });
            const snaps = points.map((point, index) => {
                const frozen = (index < state.drawing.points.length)
                    ? state.drawing.frozen[index] : state.drawing.shift;
                return frozen
                    ? { kind: 'free', coord: point }
                    : cutApi.snapPoint(point, context, { scale: context.scale });
            });
            return { crossings, anchors: cutApi.anchorsFor(points, snaps, crossings) };
        } catch (_) { return empty; }
    }

    // Recompute everything that depends on where the cursor is and whether Shift is down. Called
    // from mousemove AND from the Shift key handler, because pressing Shift without moving the
    // mouse must not leave the preview showing a snap that is no longer going to happen.
    function updateDrawCursor() {
        if (!state.drawing.active) return;
        const raw = state.drawing.rawCursor;
        if (!Array.isArray(raw)) return;
        const snap = snapFor(raw);
        const coord = snap ? snap.coord.slice() : raw.slice();
        state.drawing.cursor = coord;
        state.drawing.snap = snap;
        updateDrawShape();
        const preview = previewLine(coord);
        renderSnapFeedback(snap, preview.anchors);
        // Only when it actually changes — this runs on every mousemove.
        const text = snapStatusText(snap, preview.anchors);
        if (text !== state.drawing.statusText) {
            state.drawing.statusText = text;
            setStatus(text, 'info');
        }
    }

    function onDrawClick(e) {
        if (!state.drawing.active) return;
        const raw = [e.latlng.lng, e.latlng.lat];
        const shift = !!(e.originalEvent && e.originalEvent.shiftKey);
        state.drawing.shift = shift;
        const snap = snapFor(raw);
        state.drawing.points.push(snap ? snap.coord.slice() : raw);
        state.drawing.frozen.push(shift);
        renderDrawTemp();
        updateDrawToolbar();
    }

    // Double-click finishes the shape where the last click landed, as in every drawing tool. The
    // two clicks that make up the double-click have already placed that point (twice — both the
    // plot and the cut paths drop consecutive duplicates).
    function onDrawDblClick(e) {
        if (!state.drawing.active) return;
        if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
        onDrawFinish();
    }

    function onDrawMouseMove(e) {
        if (!state.drawing.active || !e?.latlng) return;
        state.drawing.rawCursor = [e.latlng.lng, e.latlng.lat];
        if (e.originalEvent) state.drawing.shift = !!e.originalEvent.shiftKey;
        updateDrawCursor();
    }

    function undoLastPoint() {
        if (!state.drawing.active || !state.drawing.points.length) return;
        state.drawing.points.pop();
        state.drawing.frozen.pop();
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
            state.finishBtn.textContent = (isLine
                ? t('reparcellization.modal.drawFinishLine', 'Finish line')
                : t('reparcellization.modal.drawFinish', 'Finish plot')) + ' (F)';
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
        // Drawing a plot and splitting with a line are TOOLS inside manual editing, not separate
        // modes: they mutate the same plot list the node handles describe, so they take the same
        // undo snapshot and the handles come back over the result (see cancelDraw).
        pushHistory();

        if (state.drawing.mode === 'line') {
            // The raw points, not the deduped ones: the Shift flags are indexed against them, and
            // resolveCut dedupes in lockstep with those flags anyway.
            const drawn = state.drawing.points.slice();
            const frozen = state.drawing.frozen.slice();
            const context = state.drawing.context || cutContext();
            const cutApi = window.__plotCut;
            if (drawn.length < 2) {
                setStatus(t('reparcellization.modal.status.lineTooFew', 'Add at least 2 points to make a split line.'), 'warning');
                discardLastHistory();
                return;
            }
            if (!context || !cutApi || typeof turf === 'undefined') {
                setStatus(t('reparcellization.modal.status.drawInvalid', 'Could not build a valid plot from those points.'), 'error');
                discardLastHistory();
                cancelDraw();
                return;
            }
            const result = cutApi.cutPlots(state.slices, drawn, context, { turf }, { scale: context.scale, frozen });
            cancelDraw();
            if (!result.ok) {
                discardLastHistory();
                setStatus(cutFailureText(result.reason), 'error');
                return;
            }
            adoptLayoutForEditing();
            applyCutResult(result);
            console.debug('[reparcellization] cut', {
                ends: (result.ends || []).map(end => end.kind),
                crossings: (result.crossings || []).length,
                nodesAdded: result.nodesAdded,
                plotsAdded: result.added,
                plotsNow: state.slices.length
            });
            setStatus(t('reparcellization.modal.status.cutSuccess',
                'Cut made — {{plots}} new plot(s), {{nodes}} new node(s). Click each part to assign owners.',
                { plots: Math.max(result.added, 0), nodes: result.nodesAdded || 0 }), 'info');
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
            discardLastHistory();
            cancelDraw();
            return;
        }
        const joint = state.drawing.joint;
        const ok = carvePlotIntoPlan(polygon, joint ? computeProRataJointOwners() : [], 'manual', { jointPool: joint });
        cancelDraw();
        if (!ok) {
            setStatus(t('reparcellization.modal.status.drawNoOverlap', 'The drawn plot is outside the pooled land.'), 'error');
            discardLastHistory();
            return;
        }
        adoptLayoutForEditing();
        // Carving subtracts the new plot from whatever it overlapped, which leaves the neighbours
        // without the corners it just introduced — the same non-conforming borders the line tool
        // is careful not to make. Node them, then settle: carving drops the sub-1 m² scraps it
        // makes, and healing puts that land back into a neighbour instead of letting it leave.
        conformLayout();
        settleSlices();
        setStatus(joint
            ? t('reparcellization.modal.status.courtyardCarved', 'Courtyard carved and assigned jointly.')
            : t('reparcellization.modal.status.drawSuccess', 'Plot added. Click it to assign owners.'), 'info');
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
        renderNodeHandles();
    }

    // Why a cut did nothing. Each reason is a different mistake, and saying which one saves the
    // user from re-drawing the same line to find out.
    function cutFailureText(reason) {
        if (reason === 'too-few') {
            return t('reparcellization.modal.status.lineTooFew', 'Add at least 2 points to make a split line.');
        }
        if (reason === 'no-anchors') {
            return t('reparcellization.modal.status.lineNoAnchors',
                'That line met the existing boundaries in fewer than two places, so there is nothing to draw between. Cross two boundaries, or start on a corner and cross one.');
        }
        if (reason === 'no-split') {
            return t('reparcellization.modal.status.cutNoSplit',
                'That line ran between its anchors without dividing a plot — nothing changed.');
        }
        return t('reparcellization.modal.status.drawInvalid', 'Could not build a valid plot from those points.');
    }

    function startDraw(mode, options = {}) {
        if (!state.map) return;
        exitCompare(); // editing and before/after are mutually exclusive
        dismissOwnerPopup();
        toggleEraseMode(false);
        state.drawing.active = true;
        state.drawing.mode = mode === 'line' ? 'line' : 'polygon';
        state.drawing.joint = options.joint === true;
        state.drawing.points = [];
        state.drawing.frozen = [];
        state.drawing.shift = false;
        state.drawing.rawCursor = null;
        state.drawing.snap = null;
        clearDrawTemp();
        // The graph the cut is measured against, built once: a mousemove asks it where the nearest
        // node is dozens of times a second, and rebuilding the topology each time would make the
        // cursor lag on a plan this size.
        conformLayout();
        state.drawing.context = cutContext();
        renderDrawGhosts();
        // Zoom changes how many degrees a pixel is worth, and the snap radii are in pixels.
        state.drawing.zoomHandler = () => {
            if (state.drawing.context) state.drawing.context.scale = mapScale();
        };
        state.map.on('zoomend', state.drawing.zoomHandler);
        // Shift pressed or released without moving the mouse still changes what the next click
        // will do, so the preview has to follow the key, not only the pointer.
        state.drawing.keyHandler = (event) => {
            if (event.key !== 'Shift') return;
            const down = event.type === 'keydown';
            if (down === state.drawing.shift) return;
            state.drawing.shift = down;
            updateDrawCursor();
        };
        window.addEventListener('keydown', state.drawing.keyHandler);
        window.addEventListener('keyup', state.drawing.keyHandler);
        // Close any plot tooltip that's open under the cursor as we enter draw mode.
        if (state.previewLayer) {
            try { state.previewLayer.eachLayer(l => l.closeTooltip && l.closeTooltip()); } catch (_) { }
        }
        try { state.map.getContainer().style.cursor = 'crosshair'; } catch (_) { }
        state.drawing.cursor = null;
        state.map.on('click', onDrawClick);
        state.map.on('dblclick', onDrawDblClick);
        state.map.on('mousemove', onDrawMouseMove);
        // A double-click finishes the shape here, so it must not also zoom the map.
        state.drawing.dblZoomWasOn = !!(state.map.doubleClickZoom && state.map.doubleClickZoom.enabled());
        if (state.drawing.dblZoomWasOn) state.map.doubleClickZoom.disable();
        setDrawButtonsActive();
        updateDrawToolbar();
        updateActiveModeHint();
        setStatus(state.drawing.joint
            ? t('reparcellization.modal.status.courtyardDrawHint', 'Draw the shared courtyard. Its ownership shares follow the private land assigned to each recipient.')
            : state.drawing.mode === 'line'
            ? t('reparcellization.modal.status.lineHint', 'Click to place the line. It is drawn only between the places it meets an existing boundary or corner — at least two of them.')
            : t('reparcellization.modal.status.drawHint', 'Click to add points, drag to adjust, then press Finish.'), 'info');
    }

    function cancelDraw() {
        clearDrawTemp();
        clearDrawGhosts();
        if (state.drawing.snapLayer) {
            try { state.drawing.snapLayer.remove(); } catch (_) { }
            state.drawing.snapLayer = null;
        }
        state.drawing.active = false;
        state.drawing.joint = false;
        state.drawing.points = [];
        state.drawing.frozen = [];
        state.drawing.cursor = null;
        state.drawing.rawCursor = null;
        state.drawing.snap = null;
        state.drawing.shift = false;
        state.drawing.statusText = null;
        state.drawing.context = null;
        if (state.drawing.keyHandler) {
            window.removeEventListener('keydown', state.drawing.keyHandler);
            window.removeEventListener('keyup', state.drawing.keyHandler);
            state.drawing.keyHandler = null;
        }
        if (state.map) {
            if (state.drawing.zoomHandler) {
                state.map.off('zoomend', state.drawing.zoomHandler);
                state.drawing.zoomHandler = null;
            }
            state.map.off('click', onDrawClick);
            state.map.off('dblclick', onDrawDblClick);
            state.map.off('mousemove', onDrawMouseMove);
            if (state.drawing.dblZoomWasOn && state.map.doubleClickZoom) state.map.doubleClickZoom.enable();
            state.drawing.dblZoomWasOn = false;
            try { state.map.getContainer().style.cursor = ''; } catch (_) { }
        }
        setDrawButtonsActive();
        updateDrawToolbar();
        updateActiveModeHint();
        // Back to the one manual system: the handles describe whatever the plots now are.
        if (state.nodeEdit.active) renderNodeHandles();
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
            // Handles would swallow the clicks that place vertices, so they step aside while a
            // shape is being drawn and come back the moment it is finished or cancelled.
            clearNodeHandles();
            startDraw(target);
        }
    }

    // ── Erasing a boundary ───────────────────────────────────────────────
    //
    // The inverse of cutting, and the reason the tool is phrased as a BOUNDARY rather than as one
    // edge: two plots that share a chain of edges are separated by the whole chain, and deleting
    // one link of it would leave a polygon with a slit rather than two plots merged. So the unit of
    // erasure is "every edge these two plots share" — which is the line the user is pointing at.
    //
    // Entering the mode draws that network, so what can be erased is visible before anything is
    // clicked; hovering one lights the whole boundary, so what will go matches what is shown.

    function eraseAvailable() {
        return !!(window.__plotTopology && window.__plotCut && state.map && state.slices.length
            && state.ownershipMode === 'multiple' && EDITABLE_ALGORITHMS.includes(state.algorithm));
    }

    function toggleEraseMode(force) {
        const next = typeof force === 'boolean' ? force : !state.erase.active;
        if (next === state.erase.active) return;
        if (next && !eraseAvailable()) return;
        state.erase.active = next;
        updateActiveModeHint();
        if (state.eraseBtn) state.eraseBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        if (next) {
            exitCompare();
            dismissOwnerPopup();
            if (state.drawing.active) cancelDraw();
            state.erase.nodeEditWasActive = state.nodeEdit.active;
            if (state.nodeEdit.active) toggleNodeEditing(false);
            try { state.map.getContainer().style.cursor = 'pointer'; } catch (_) { }
            renderEraseLayer();
        } else {
            try { if (state.map) state.map.getContainer().style.cursor = ''; } catch (_) { }
            clearEraseLayer();
            const restore = state.erase.nodeEditWasActive;
            state.erase.nodeEditWasActive = false;
            if (restore) toggleNodeEditing(true);
            else setStatus('', 'info');
        }
    }

    function clearEraseLayer() {
        if (state.erase.layer) {
            try { state.erase.layer.remove(); } catch (_) { }
            state.erase.layer = null;
        }
        state.erase.topology = null;
    }

    function eraseTooltipFor(group) {
        const nameOf = index => plotLabel(index);
        return escapeHtml(t('reparcellization.modal.eraseTooltip',
            'Erase this boundary — {{a}} and {{b}} become one plot',
            { a: nameOf(group.plots[0]), b: nameOf(group.plots[1]) }));
    }

    function renderEraseLayer() {
        clearEraseLayer();
        const topo = window.__plotTopology;
        const cutApi = window.__plotCut;
        if (!topo || !cutApi || !state.map) return;
        conformLayout();
        const topology = topo.annotateBoundary(topo.buildTopology(state.slices), poolBoundaryIndex());
        const groups = cutApi.boundaryGroups(topology);
        const layer = L.layerGroup().addTo(state.map);
        groups.forEach(group => {
            const paths = cutApi.boundaryPaths(group, topology)
                .map(pair => pair.map(coord => L.latLng(coord[1], coord[0])));
            if (!paths.length) return;
            const line = L.polyline(paths, {
                color: '#C73E1D', weight: 4, opacity: 0.9,
                pane: 'reparcelTools', className: 'reparcel-erase-line'
            });
            // A 4 px line is a 4 px target. The halo is invisible and fat, so the boundary can be
            // hit by aiming at it rather than by landing on it.
            const halo = L.polyline(paths, {
                color: '#C73E1D', weight: 16, opacity: 0,
                pane: 'reparcelTools', className: 'reparcel-erase-line'
            });
            const hover = on => {
                line.setStyle({ weight: on ? 9 : 4, opacity: on ? 1 : 0.9 });
            };
            [line, halo].forEach(target => {
                target.on('mouseover', () => hover(true));
                target.on('mouseout', () => hover(false));
                target.on('click', (event) => {
                    if (L.DomEvent && L.DomEvent.stop) L.DomEvent.stop(event);
                    eraseBoundary(group);
                });
            });
            halo.bindTooltip(eraseTooltipFor(group), { sticky: true, direction: 'top' });
            line.addTo(layer);
            halo.addTo(layer);
        });
        state.erase.layer = layer;
        state.erase.topology = topology;
        setStatus(groups.length
            ? t('reparcellization.modal.status.eraseHint',
                'Click a boundary to erase it — the two plots it separates become one. {{count}} boundaries can be erased.',
                { count: groups.length })
            : t('reparcellization.modal.status.eraseNone',
                'There are no boundaries between plots here — only the pooled outline, which belongs to the neighbours.'),
            groups.length ? 'info' : 'warning');
    }

    function eraseBoundary(group) {
        if (!group || !Array.isArray(group.plots) || group.plots.length !== 2) return;
        const merged = mergePlots(group.plots);
        if (!merged) return;
        console.debug('[reparcellization] boundary erased', { plots: group.plots, plotsNow: state.slices.length });
        // The graph has changed under the layer, so it is rebuilt rather than patched — which also
        // shows the merged plot's remaining boundaries immediately.
        renderEraseLayer();
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
        pushHistory();
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

    // ── Node / edge editing ──────────────────────────────────────────────
    //
    // The plots form a planar subdivision: neighbours SHARE their boundary. plot-topology.js reads
    // the plot list as nodes and edges, so dragging a shared node moves it in every plot that
    // touches it and no gap opens between them. Drawing whole plots on top of each other could
    // never express "move this boundary two metres east".

    // ── Undo ────────────────────────────────────────────────────────────
    //
    // One stack for every layout edit — node drag, insert, remove, drawn plot, line split,
    // ownership assignment. Snapshots are taken BEFORE the action, so Cmd/Ctrl+Z restores what
    // the user last saw. Deliberately not per-tool: "undo" means the last thing I did, whichever
    // tool did it.
    // The stack itself is GeometryEditHistory — the same module the building, road and structure
    // editors use. This only says how to capture and restore a layout.
    function ensureHistory() {
        if (state.historyCtl) return state.historyCtl;
        const factory = window.GeometryEditHistory;
        if (!factory) return null;
        state.historyCtl = factory.create({
            // Undo has an inverse here: every snapshot is the whole layout, so replaying one that
            // was undone puts back exactly what was there.
            redo: true,
            capture: () => ({
                slices: JSON.parse(JSON.stringify(state.slices || [])),
                ownerShares: JSON.parse(JSON.stringify(state.ownerShares || [])),
                selectedSliceIndex: state.selectedSliceIndex,
                // The first hand edit of an automatic layout turns it into a drawn one; undoing
                // that edit has to give the automatic layout (and its sweep handle) back.
                algorithm: state.algorithm,
                sweep: state.sweepHandle ? [state.sweepHandle.getLatLng().lat, state.sweepHandle.getLatLng().lng] : null
            }),
            restore: (snapshot, direction) => {
                state.slices = snapshot.slices;
                state.ownerShares = snapshot.ownerShares;
                state.selectedSliceIndex = snapshot.selectedSliceIndex;
                if (snapshot.algorithm && snapshot.algorithm !== state.algorithm) setAlgorithmKey(snapshot.algorithm);
                if (snapshot.sweep && state.sweepHandle) {
                    state.sweepHandle.setLatLng(snapshot.sweep);
                    updateSweepDirLine();
                }
                dismissOwnerPopup();
                updateLegend(state.ownerShares);
                drawPreview();
                updateCommitState();
                if (state.nodeEdit.active) renderNodeHandles();
                // The erasable network describes the plots too, so it has to follow them back.
                if (state.erase.active) renderEraseLayer();
                if (direction === 'redo') {
                    setStatus(t('reparcellization.modal.status.redone', 'Redid the change.'),
                        'info', 'reparcellization.modal.status.redone');
                } else {
                    setStatus(t('reparcellization.modal.status.undone', 'Undid the last change.'),
                        'info', 'reparcellization.modal.status.undone');
                }
            },
            onChange: (canUndo, canRedo) => {
                if (state.undoEditBtn) {
                    state.undoEditBtn.disabled = !canUndo;
                    state.undoEditBtn.title = canUndo
                        ? t('reparcellization.modal.undoEdit', 'Undo (Cmd/Ctrl+Z)')
                        : t('reparcellization.modal.undoNothing', 'Nothing to undo');
                }
                if (state.redoEditBtn) {
                    state.redoEditBtn.disabled = !canRedo;
                    state.redoEditBtn.title = canRedo
                        ? t('reparcellization.modal.redoEdit', 'Redo')
                        : t('reparcellization.modal.redoNothing', 'Nothing to redo');
                }
            }
        });
        return state.historyCtl;
    }

    function pushHistory() {
        const h = ensureHistory();
        if (h) h.record();
    }

    // Drop the newest snapshot — for actions that take one up-front and then fail.
    function discardLastHistory() {
        const h = ensureHistory();
        if (h) h.discardLast();
    }

    function undoLastEdit() {
        const h = ensureHistory();
        return h ? h.undo() : false;
    }

    function updateUndoAffordance() {
        const h = ensureHistory();
        if (state.undoEditBtn && h) state.undoEditBtn.disabled = !h.canUndo();
    }

    function nodeEditingAvailable() {
        return !!(window.__plotTopology && window.GeometryEditHandles && state.map && state.slices.length);
    }

    function toggleNodeEditing(force) {
        const next = typeof force === 'boolean' ? force : !state.nodeEdit.active;
        if (next && !nodeEditingAvailable()) return;
        if (next && state.drawing.active) cancelDraw();
        // Before any handle is drawn. Conforming used to run only when the line or erase tool
        // opened, so going straight to the handles meant dragging a node on a layout where 46
        // boundaries were not actually shared — and a drag there opens a gap in silence.
        if (next) conformLayout();
        if (next && state.erase.active) {
            // Clear the restore flag first, or turning erase off would turn node editing back on
            // and land straight back here.
            state.erase.nodeEditWasActive = false;
            toggleEraseMode(false);
        }
        const wasActive = state.nodeEdit.active;
        state.nodeEdit.active = next;
        updateActiveModeHint();
        if (state.nodesBtn) state.nodesBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        if (next) {
            // Re-arming handles that are already up (a layout switch does) must not talk over the
            // status the switch just set.
            if (!wasActive) {
                setStatus(t('reparcellization.modal.status.nodeHint',
                    'Drag a node, or grab a boundary segment and drag it. Pull a midpoint to bend a boundary. Click a node to remove it, or a boundary to erase it. The pooled outline is fixed.'),
                    'info', 'reparcellization.modal.status.nodeHint');
            }
            renderNodeHandles();
        } else {
            clearNodeHandles();
            setStatus('', 'info');
        }
    }

    // Assign-owners mode: the map is for choosing who gets which plot, and nothing else.
    // Node handles come down, the drawing tools stand down, and a click on a plot opens the owner
    // picker. Leaving it puts the editor back exactly as it was.
    function toggleAssignMode(force) {
        const next = typeof force === 'boolean' ? force : !state.assignMode;
        if (next === state.assignMode) return;
        state.assignMode = next;
        updateActiveModeHint();
        if (state.assignBtn) state.assignBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        if (state.modal) state.modal.classList.toggle('reparcel-assign-mode', next);
        const allPublicBtn = state.modal && state.modal.querySelector('[data-reparcel-all-public]');
        if (allPublicBtn) allPublicBtn.hidden = !next;
        if (next) {
            state.nodeEditWasActive = state.nodeEdit.active;
            if (state.nodeEdit.active) toggleNodeEditing(false);
            if (state.drawing.active) cancelDraw();
            state.erase.nodeEditWasActive = false;
            toggleEraseMode(false);
            setStatus(t('reparcellization.modal.status.assignHint',
                'Click a plot to choose its owners. Editing is paused while you assign.'),
                'info', 'reparcellization.modal.status.assignHint');
        } else {
            dismissOwnerPopup();
            state.selectedSliceIndex = null;
            if (state.nodeEditWasActive) { state.nodeEditWasActive = false; toggleNodeEditing(true); }
            else setStatus('', 'info');
            drawPreview();
        }
    }

    function clearNodeHandles() {
        if (state.nodeEdit.layer) {
            try { state.nodeEdit.layer.destroy(); } catch (_) { }
            state.nodeEdit.layer = null;
        }
        state.nodeEdit.topology = null;
    }

    // Does a cut of OURS end at this node? Outline geometry is a given; a cut is a decision, and a
    // node exists in this editor to let you act on decisions.
    function anchorsACut(node, topology) {
        if (!node || !topology || !Array.isArray(topology.edges)) return false;
        return topology.edges.some(edge => (edge.a === node.id || edge.b === node.id) && !edge.onBoundary);
    }

    // The pooled outline, indexed for classification. It is fixed for the life of the modal — the
    // pool changes only by choosing different input parcels — so it is built once and reused.
    function poolBoundaryIndex() {
        const topo = window.__plotTopology;
        if (!topo || !state.superParcel) return null;
        if (!state.nodeEdit.boundaryIndex) {
            state.nodeEdit.boundaryIndex = topo.boundaryIndexOf(state.superParcel);
        }
        return state.nodeEdit.boundaryIndex;
    }

    // Rebuild the handle layer from the current slices. Called on every geometry change, so the
    // handles always describe the CURRENT topology rather than a stale snapshot.
    function renderNodeHandles() {
        clearNodeHandles();
        if (!state.nodeEdit.active || !nodeEditingAvailable()) return;
        const factory = window.GeometryEditHandles;
        if (!factory) return;

        // The handle layer is shared with the building and road editors; this only supplies the
        // geometry and says what a move/insert/remove means for a plot layout.
        const topo = window.__plotTopology;
        // What may move: the cuts, not the pool. Classifying against the pooled outline turns the
        // invariant into something the UI simply cannot express — a corner of the outline has no
        // drag at all, and a cut endpoint that landed on it slides along its own segment.
        const boundaryIndex = poolBoundaryIndex();
        state.nodeEdit.layer = factory.create({
            map: state.map,
            leaflet: L,
            pane: 'onMapEditorHandles',
            getShapes: () => state.slices,
            topologyOf: list => topo.annotateBoundary(topo.buildTopology(list), boundaryIndex),
            classes: {
                nodeClass: 'geom-handle geom-handle--vertex reparcel-node-handle',
                sharedClass: 'geom-handle--shared shared',
                midClass: 'geom-handle geom-handle--mid reparcel-edge-handle'
            },
            nodePolicy: (node, topology) => {
                const kind = node.boundary && node.boundary.kind;
                if (kind === 'boundary-corner') {
                    // A corner of the pooled outline that no cut touches is not part of the design:
                    // it is the shape of the parcels that were pooled. It cannot be dragged (that
                    // would move the outline) and it cannot be removed (there is no boundary of
                    // OURS there to dissolve), so showing a handle for it only offers gestures that
                    // must then be refused. Every node you can see is a node you can act on.
                    if (!anchorsACut(node, topology)) return { hidden: true };
                    return { draggable: false, className: 'geom-handle--locked' };
                }
                if (kind === 'boundary-edge') {
                    return {
                        className: 'geom-handle--slide',
                        constrain: coord => topo.constrainNodeDrop(node, coord)
                    };
                }
                return {};
            },
            // No insertion on the outline: a new node there could only ever slide along a line
            // that is not ours to reshape. The same goes for dragging an outline segment.
            edgePolicy: edge => ({ insertable: !edge.onBoundary, draggable: !edge.onBoundary }),
            // Pull a midpoint to bend a boundary; grab a segment to move it whole.
            dragMidpoints: true,
            dragEdges: true,
            onPreviewInsert: (edgeId, coord, topology) => {
                previewGeometries(topo.insertNodeOnEdge(state.slices, topology, edgeId, coord));
            },
            onPreviewMany: (moves, topology) => {
                previewGeometries(topo.moveNodes(state.slices, topology, moves));
            },
            onMoveMany: (moves, topology) => {
                applyGeometries(topo.moveNodes(state.slices, topology, moves));
            },
            onEdgeClick: (edge, coord, latlng) => openEdgePopup(edge, latlng),
            onPreview: (nodeId, coord, topology) => {
                previewGeometries(topo.moveNode(state.slices, topology, nodeId, coord));
            },
            onMove: (nodeId, coord, topology) => {
                applyGeometries(topo.moveNode(state.slices, topology, nodeId, coord));
            },
            onInsert: (edgeId, coord, topology) => {
                applyGeometries(topo.insertNodeOnEdge(state.slices, topology, edgeId, coord));
            },
            onRemove: (nodeId, topology) => {
                const node = (topology.nodes || []).find(n => n.id === nodeId);
                if (node) removeNodeFromLayout(node, topology);
            },
            onNodeClick: (node, marker, remove, topology) => openNodePopup(node, marker, remove, topology)
        });
        state.nodeEdit.topology = state.nodeEdit.layer ? state.nodeEdit.layer.render() : null;
    }

    // A bare message anchored at a node, for a refusal that arrives without a popup already open
    // (the Alt-click shortcut).
    function showNodeMessagePopup(node, message) {
        if (!state.map || !node || !Array.isArray(node.coord)) return;
        try {
            L.popup({ className: 'reparcel-node-popup-wrap', closeButton: true, autoPan: true })
                .setLatLng([node.coord[1], node.coord[0]])
                .setContent(`<div class="reparcel-node-popup"><div class="reparcel-node-popup__hint">${escapeHtml(message)}</div></div>`)
                .openOn(state.map);
        } catch (_) { /* a popup that will not open must not break the handle */ }
    }

    // Small popup on a node: what it is, and what it is allowed to do. A node on the pooled
    // outline says so and offers nothing — the popup is where "why can't I drag this?" is answered.
    function openNodePopup(node, marker, onRemove, topology) {
        const shared = node.plots.length > 1;
        const kind = node.boundary && node.boundary.kind;
        const locked = kind === 'boundary-corner';
        const sliding = kind === 'boundary-edge';
        const container = document.createElement('div');
        container.className = 'reparcel-node-popup';

        const title = document.createElement('div');
        title.className = 'reparcel-node-popup__title';
        if (locked) title.textContent = t('reparcellization.modal.nodePoolCorner', 'Corner of the pooled outline');
        else if (sliding) title.textContent = t('reparcellization.modal.nodePoolEdge', 'Where a cut meets the outline');
        else if (shared) title.textContent = t('reparcellization.modal.nodeShared', 'Shared node · {{count}} plots', { count: node.plots.length });
        else title.textContent = t('reparcellization.modal.nodeOwn', 'Node of one plot');
        container.appendChild(title);

        const hint = document.createElement('div');
        hint.className = 'reparcel-node-popup__hint';
        if (locked) {
            hint.textContent = t('reparcellization.modal.nodePoolCornerHint',
                'The outline belongs to the neighbours. To change it, change which parcels are pooled.');
        } else if (sliding) {
            hint.textContent = t('reparcellization.modal.nodePoolEdgeHint',
                'Slides along the outline to change where the cut divides — it cannot leave it.');
        } else if (shared) {
            hint.textContent = t('reparcellization.modal.nodeSharedHint', 'Dragging it moves every plot that touches it.');
        } else {
            hint.textContent = t('reparcellization.modal.nodeOwnHint', 'Drag to move it.');
        }
        container.appendChild(hint);

        // What the button will actually do, before it is pressed. Removing a junction node moves
        // thousands of square metres between owners; it used to do that with nothing on screen to
        // say so, and the only evidence was a number in the plot list that had quietly changed.
        const consequence = removalConsequenceText(describeNodeRemoval(node, topology));
        if (consequence) {
            const warning = document.createElement('div');
            warning.className = 'reparcel-node-popup__consequence';
            warning.textContent = consequence;
            container.appendChild(warning);
        }

        // Removal is offered on EVERY node, outline included. Removing one dissolves the cut it
        // anchored and the plots on either side become one — remove the last cut and the pool is a
        // single parcel. That is a design decision about the cuts, not a change to the outline,
        // which is why it can sit beside a hint saying the outline is fixed.
        {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-danger btn-sm';
            remove.textContent = t('reparcellization.modal.nodeRemove', 'Remove node');
            remove.addEventListener('click', () => {
                try { state.map.closePopup(); } catch (_) { }
                onRemove();
            });
            container.appendChild(remove);
        }

        try {
            marker.unbindPopup();
            marker.bindPopup(container, { className: 'reparcel-node-popup-wrap', closeButton: true, autoPan: true });
            // While the popup is open, Delete/Backspace removes this node (see the key handler).
            state.nodeEdit.focusRemove = onRemove;
            marker.once('popupclose', () => {
                if (state.nodeEdit.focusRemove === onRemove) state.nodeEdit.focusRemove = null;
            });
            marker.openPopup();
        } catch (_) { /* a popup that will not open must not break the drag handle */ }
    }

    // A click on a boundary segment (not a drag): say what it separates, and offer to erase it —
    // the same act as the eraser tool, without having to find the tool first.
    function openEdgePopup(edge, latlng) {
        if (!state.map || !latlng || !edge) return;
        const plots = Array.isArray(edge.plots) ? edge.plots.filter(i => state.slices[i]) : [];
        const container = document.createElement('div');
        container.className = 'reparcel-node-popup';
        const title = document.createElement('div');
        title.className = 'reparcel-node-popup__title';
        const hint = document.createElement('div');
        hint.className = 'reparcel-node-popup__hint';
        if (plots.length === 2) {
            title.textContent = t('reparcellization.modal.edgeBetween', 'Boundary between {{a}} and {{b}}',
                { a: plotLabel(plots[0]), b: plotLabel(plots[1]) });
            hint.textContent = t('reparcellization.modal.edgeHint',
                'Drag it to move this segment. Erasing it joins the two plots; the joined plot keeps the owners of the larger one.');
        } else {
            title.textContent = t('reparcellization.modal.edgeOwn', 'Boundary segment');
            hint.textContent = t('reparcellization.modal.edgeOwnHint', 'Drag it to move this segment.');
        }
        container.appendChild(title);
        container.appendChild(hint);
        if (plots.length === 2) {
            const erase = document.createElement('button');
            erase.type = 'button';
            erase.className = 'btn btn-danger btn-sm';
            erase.textContent = t('reparcellization.modal.edgeErase', 'Erase this boundary');
            erase.addEventListener('click', () => {
                try { state.map.closePopup(); } catch (_) { }
                if (mergePlots(plots)) {
                    setStatus(t('reparcellization.modal.status.edgeErased', 'Boundary erased — the two plots are now one.'), 'info');
                }
            });
            container.appendChild(erase);
        }
        try {
            L.popup({ className: 'reparcel-node-popup-wrap', closeButton: true, autoPan: true })
                .setLatLng(latlng)
                .setContent(container)
                .openOn(state.map);
        } catch (_) { /* a popup that will not open must not break the editor */ }
    }

    // Paint a candidate geometry set without committing it (drag preview).
    function previewGeometries(geometries) {
        if (!Array.isArray(geometries) || !state.previewLayer) return;
        const layers = state.previewLayer.getLayers ? state.previewLayer.getLayers() : [];
        layers.forEach(layer => {
            const idx = layer.__reparcelSliceIndex;
            const geometry = (typeof idx === 'number') ? geometries[idx] : null;
            if (!geometry || typeof layer.setLatLngs !== 'function') return;
            try {
                const latlngs = L.GeoJSON.coordsToLatLngs(
                    geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates[0], 1);
                layer.setLatLngs(latlngs);
            } catch (_) { /* a bad intermediate shape just does not preview */ }
        });
    }

    // Settle a candidate layout back onto the pool: clip anything outside it, resolve overlaps, and
    // hand every unclaimed scrap to the plot it borders most. This is what lets an edit be allowed
    // unconditionally — the land always ends up belonging to something.
    // `previous` is the layout as it was before the edit, when the caller has it. With it, only the
    // plots the edit could have disturbed are settled — the global pass is quadratic in the plot
    // count and ran in full on every drag release. Without it (a cut, which rebuilds the list and
    // has no index-for-index predecessor), the global pass is still the right answer.
    function healLayout(geometries, previous) {
        const heal = window.__plotHeal;
        if (!heal || typeof heal.healTiling !== 'function' || !state.superParcel || typeof turf === 'undefined') {
            return geometries;
        }
        try {
            if (Array.isArray(previous) && typeof heal.healLocally === 'function') {
                const local = heal.healLocally(previous, geometries, state.superParcel, { turf });
                if (local && !local.fellBack) {
                    if (local.changed) {
                        console.debug('[reparcellization] layout healed (scoped)', {
                            plots: local.scope, of: geometries.length, clipped: local.clipped,
                            overlaps: local.overlaps, gapsFilled: local.gapsFilled, gapArea: Math.round(local.gapArea)
                        });
                    }
                    return local.geometries;
                }
            }
            const result = heal.healTiling(geometries, state.superParcel, { turf });
            if (result.changed) {
                console.debug('[reparcellization] layout healed', {
                    clipped: result.clipped, overlaps: result.overlaps,
                    gapsFilled: result.gapsFilled, gapArea: Math.round(result.gapArea)
                });
            }
            return result.geometries;
        } catch (error) {
            console.warn('[reparcellization] could not heal the layout; keeping the edit as drawn', error);
            return geometries;
        }
    }

    // What removing this node would do, in the plan's own terms. Runs the removal on a COPY and
    // measures it, so the popup cannot describe one thing while the button does another: both go
    // through classifyNodeRemoval, and the numbers come from the edit itself rather than an
    // estimate of it.
    function describeNodeRemoval(node, topology) {
        const topo = window.__plotTopology;
        const heal = window.__plotHeal;
        if (!topo || !node) return null;
        const verdict = topo.classifyNodeRemoval(node, topology);
        const before = state.slices.map(slice => slice.geometry);
        if (verdict.kind === 'merge') {
            // The merge keeps the biggest contributor and the others give up their land to it.
            const areas = verdict.plots.map(index => ({
                index, area: computeGeometryArea(state.slices[index] && state.slices[index].geometry) || 0
            }));
            const keeper = areas.reduce((best, entry) => (entry.area > best.area ? entry : best), areas[0]);
            const joining = areas.filter(entry => entry.index !== keeper.index);
            return {
                kind: 'merge',
                keeper,
                joining,
                moved: joining.reduce((sum, entry) => sum + entry.area, 0)
            };
        }
        if (verdict.kind === 'outline') return { kind: 'outline', moved: 0 };
        const result = topo.removeNode(state.slices, topology, node.id, { dissolveDegenerate: true });
        if (!result.removed) return { kind: 'straighten', moved: 0, refused: true };
        // Measured on the removal itself, NOT on a healed copy. Healing an 82-plot layout takes
        // 1.1 s, which is a frozen popup rather than a description — and it would not change the
        // headline anyway: dropping a vertex hands one plot's triangle to the other, and the heal
        // only redistributes the slivers that frees.
        const shift = (heal && typeof heal.areaShift === 'function')
            ? heal.areaShift(before, result.geometries, { turf }) : { moved: 0, perPlot: [] };
        return { kind: 'straighten', moved: shift.moved, perPlot: shift.perPlot };
    }

    // How a plot is named when an edit talks about it: by its number in the list and its size.
    // Owners do not identify plots here — a whole plan can belong to one body — and "plot 7
    // (4,941 m²)" is also what the user is looking at in the panel.
    function plotLabel(index) {
        const slice = state.slices[index];
        const area = CbFormat.formatNumber(computeGeometryArea(slice && slice.geometry) || 0, { maxFractionDigits: 0 });
        return t('reparcellization.modal.plotLabel', 'plot {{n}} ({{area}} m²)', { n: index + 1, area });
    }

    // One sentence naming the land an edit moves, or nothing when it moves none worth saying.
    function removalConsequenceText(description) {
        if (!description) return '';
        const m2 = value => CbFormat.formatNumber(value, { maxFractionDigits: 0 });
        // By NUMBER and area, the way the plot list reads. Naming them by owner produced
        // "merges Prometna površina IS-1, Prometna površina IS-1 into Prometna površina IS-1" —
        // every plot in this plan belongs to the same body, so the owner name identifies nothing.
        const nameOf = index => plotLabel(index);
        if (description.kind === 'merge') {
            return t('reparcellization.modal.nodeRemoveMerges',
                'Removing it merges {{joining}} into {{keeper}} — {{moved}} m² changes hands.',
                {
                    joining: description.joining.map(entry => nameOf(entry.index)).join(', '),
                    keeper: nameOf(description.keeper.index),
                    moved: m2(description.moved)
                });
        }
        if (description.kind === 'straighten' && description.moved >= 1) {
            return t('reparcellization.modal.nodeRemoveStraightens',
                'Removing it straightens the boundary — about {{moved}} m² moves across it.',
                { moved: m2(description.moved) });
        }
        return '';
    }

    // Removing a node.
    //
    //   A node in the MIDDLE of a boundary is a bend: take it away and the boundary straightens but
    //   stays. A line with several nodes keeps its line when you remove one of them.
    //
    //   A node at the END of a boundary is what holds the boundary up. Take it away and the
    //   boundary stops existing, so the plots it separated become ONE plot — which is what joins an
    //   appendix back to the land it was cut from.
    //
    // Both are done on the plots themselves. Re-deriving every face from the line network instead
    // was correct in principle and wrong in practice: clipping the derived faces back to the pool
    // re-nodes the whole plan, so a removal churned vertices everywhere and could land a NEW node
    // within centimetres of the one just deleted — measured at 318 handles before a removal and 319
    // after. An edit should touch what it names and nothing else.
    function removeNodeFromLayout(node, topology) {
        const topo = window.__plotTopology;
        if (!topo || !node) return false;
        // Same verdict the popup described — one classifier, so the two cannot drift apart.
        const verdict = topo.classifyNodeRemoval(node, topology);
        const description = describeNodeRemoval(node, topology);

        if (verdict.kind === 'outline') {
            const text = t('reparcellization.modal.status.nodeOnPool',
                'That node sits on the pooled outline — it belongs to the neighbours, not to this plan.');
            setStatus(text, 'warning', 'reparcellization.modal.status.nodeOnPool');
            showNodeMessagePopup(node, text);
            return false;
        }
        const done = verdict.kind === 'straighten'
            ? removeNodePerRing(node, topology)
            : dissolveBoundariesAt(node, topology, verdict.cuts);
        // And say what it did, since the plot list is where the change would otherwise show up
        // unannounced.
        if (done) {
            const consequence = removalConsequenceText(description);
            if (consequence) setStatus(consequence, 'info');
        }
        return done;
    }

    // Straighten a boundary: drop the vertex from every plot that uses it, so both sides lose the
    // same bend and stay in step. Healing settles anything that frees.
    function removeNodePerRing(node, topology) {
        const topo = window.__plotTopology;
        const result = topo.removeNode(state.slices, topology, node.id, { dissolveDegenerate: true });
        console.debug('[reparcellization] straighten', {
            node: node.coord, removed: result.removed, reason: result.reason, slices: state.slices.length
        });
        if (!result.removed) {
            const text = t('reparcellization.modal.status.nodeKept',
                'That node cannot be removed — a plot would stop being a polygon.');
            setStatus(text, 'warning', 'reparcellization.modal.status.nodeKept');
            showNodeMessagePopup(node, text);
            return false;
        }
        return applyGeometries(result.geometries);
    }

    // Merge the plots a boundary separated. Union rather than re-derive: the surviving outline is
    // made of the plots' own coordinates, so no vertex moves and none is invented.
    function dissolveBoundariesAt(node, topology, cuts) {
        if (typeof turf === 'undefined') return false;
        const members = new Set();
        cuts.forEach(edge => (edge.plots || []).forEach(index => members.add(index)));
        if (members.size < 2) {
            // The boundary has only one plot on it — nothing to merge into. Removing the vertex is
            // still the right gesture; healing settles whatever it frees.
            return removeNodePerRing(node, topology);
        }

        const merged = mergePlots(Array.from(members));
        if (!merged) return false;
        console.debug('[reparcellization] boundary dissolved', {
            node: node.coord, mergedPlots: members.size, plotsNow: state.slices.length
        });
        return true;
    }

    // Merge several plots into one. Union rather than re-derive: the surviving outline is made of
    // the plots' own coordinates, so no vertex moves and none is invented. Shared by node removal
    // (dissolve the boundary a node anchored) and by the eraser (dissolve the boundary itself).
    function mergePlots(plotIndices) {
        if (typeof turf === 'undefined') return false;
        const indices = Array.from(new Set(plotIndices || []))
            .filter(index => state.slices[index] && state.slices[index].geometry)
            .sort((a, b) => a - b);
        if (indices.length < 2) return false;

        const wrap = geometry => ({ type: 'Feature', properties: {}, geometry });
        let merged = null;
        indices.forEach(index => {
            const geometry = state.slices[index].geometry;
            merged = merged ? (turf.union(wrap(merged), wrap(geometry)) || {}).geometry || merged : geometry;
        });
        if (!merged) return false;

        // The merged plot keeps the identity of the biggest contributor — the small side joins the
        // large one, not the other way round.
        let keeper = indices[0];
        let keeperArea = 0;
        indices.forEach(index => {
            const area = computeGeometryArea(state.slices[index].geometry) || 0;
            if (area > keeperArea) { keeperArea = area; keeper = index; }
        });

        pushHistory();
        adoptLayoutForEditing();
        state.slices[keeper].geometry = merged;
        state.slices[keeper].source = 'manual';
        indices.filter(index => index !== keeper)
            .sort((a, b) => b - a)
            .forEach(index => state.slices.splice(index, 1));
        state.selectedSliceIndex = null;
        recomputeSliceAreas();
        updateLegend(state.ownerShares);
        try {
            drawPreview();
            updateCommitState();
        } finally {
            renderNodeHandles();
        }
        return true;
    }

    // Commit a geometry set to the slices and redraw everything that depends on them.
    function applyGeometries(geometries) {
        if (!Array.isArray(geometries)) return false;
        // Decide FIRST whether anything actually moved: an action that changes nothing (an insert
        // whose edge did not match, a drag that returned to the same spot) must not leave an undo
        // step that appears to do nothing when used.
        const changed = state.slices.some((slice, idx) => {
            const geometry = geometries[idx];
            if (geometry === undefined) return false;
            return JSON.stringify(slice.geometry || null) !== JSON.stringify(geometry || null);
        });
        if (!changed) return false;
        // Repair, do not refuse. Any edit can leave the layout momentarily untidy — a removed node
        // drops a boundary, a drag pushes one plot over another — and the fix is to settle the
        // land, not to forbid the gesture. Whatever is left unclaimed joins the plot it borders
        // most; whatever is claimed twice goes to one of them.
        const settled = healLayout(geometries, state.slices.map(slice => slice.geometry));
        pushHistory();   // the pre-edit layout, captured before the assignment below
        adoptLayoutForEditing();
        const dissolved = [];
        state.slices.forEach((slice, idx) => {
            const geometry = settled[idx];
            if (geometry === undefined) return;
            if (!geometry) { dissolved.push(idx); return; }
            slice.geometry = geometry;
            slice.source = 'manual';
        });
        // A plot whose land has all gone to its neighbours is no longer a plot. Dropping it keeps
        // the list honest — a 0 m² row that cannot be seen on the map is not a parcel.
        if (dissolved.length) {
            for (let i = dissolved.length - 1; i >= 0; i--) state.slices.splice(dissolved[i], 1);
            if (state.selectedSliceIndex !== null) state.selectedSliceIndex = null;
        }
        recomputeSliceAreas();
        updateLegend(state.ownerShares);
        // The handles describe the plots. If a redraw throws halfway, the handles must not be left
        // floating over shapes that are no longer there — that is the "stars orphaned on the map,
        // node and warning left behind, lines gone" state. Rebuild them whatever happens.
        try {
            drawPreview();
            updateCommitState();
        } finally {
            renderNodeHandles();
        }
        return true;
    }

    // Plot areas and percentages follow their geometry — without this the legend keeps the
    // pre-drag numbers and the coverage check reads a layout that no longer exists.
    function recomputeSliceAreas() {
        const total = state.slices.reduce((sum, slice) => sum + (computeGeometryArea(slice.geometry) || 0), 0);
        state.slices.forEach(slice => {
            const area = computeGeometryArea(slice.geometry) || 0;
            slice.area = area;
            slice.percent = total > 0 ? (area / total) * 100 : 0;
        });
    }

    function computeGeometryArea(geometry) {
        if (!geometry) return 0;
        try {
            return turf.area({ type: 'Feature', properties: {}, geometry });
        } catch (_) { return 0; }
    }

    // ── Click-to-assign Owner ────────────────────────────────────────────

    function dismissOwnerPopup() {
        state.shareDraftPending = false;
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

    function restoreOwnerPopupView() {
        if (!state.ownerPopupView || !state.map) return;
        const view = state.ownerPopupView;
        state.ownerPopupView = null;
        state.map.setView(view.center, view.zoom, { animate: false });
    }

    function onSliceClick(sliceIndex, latlng) {
        if (state.drawing.active || state.compare.active) return; // not while drawing/comparing
        // Only in assign mode. Otherwise a click on a plot while you are reshaping it popped the
        // owner picker over the geometry you were working on.
        if (!state.assignMode) return;
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
        state.shareDraftPending = false;
        state.ownerPopupView = { center: state.map.getCenter(), zoom: state.map.getZoom() };
        const slice = state.slices[sliceIndex];
        if (!slice.owners) {
            slice.owners = [{ ownerKey: slice.ownerKey, displayName: slice.displayName, color: slice.color, share: 1 }];
        }

        const container = document.createElement('div');
        container.className = 'reparcel-owner-popup';
        container.style.setProperty('--reparcel-owner-editor-height', `${Math.max(100, state.map.getSize().y - 64)}px`);

        const title = document.createElement('div');
        title.className = 'reparcel-owner-popup__title';
        title.textContent = t('reparcellization.modal.assignOwners', 'Assign owners');
        container.appendChild(title);

        const jointBtn = document.createElement('button');
        jointBtn.type = 'button';
        jointBtn.className = 'btn reparcel-owner-popup__joint';
        jointBtn.textContent = t('reparcellization.modal.useProRataShares', 'Use private-land proportions');
        jointBtn.addEventListener('click', () => {
            pushHistory();
            applyJointOwnersToSlice(slice, computeProRataJointOwners());
            updateCommitState();
            dismissOwnerPopup();
        });
        container.appendChild(jointBtn);

        const ownerList = document.createElement('div');
        ownerList.className = 'reparcel-owner-popup__list';

        // Real owners plus the "Public land" option (land set aside for public use).
        const assignableOwners = reparcellizationUiState.assignableOwnerChoices(state.ownerShares, getPublicLandOwner());
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
                renderShareInputs();
            });

            const swatch = document.createElement('span');
            swatch.className = owner.ownerKey === PUBLIC_LAND_KEY ? 'legend-color legend-color--public' : 'legend-color';
            swatch.style.background = owner.color;

            const nameSpan = document.createElement('span');
            nameSpan.textContent = ownerDisplayName(owner.displayName);

            row.appendChild(checkbox);
            row.appendChild(swatch);
            row.appendChild(nameSpan);
            ownerList.appendChild(row);
        });
        container.appendChild(ownerList);

        const shareEditor = document.createElement('div');
        shareEditor.className = 'reparcel-share-editor';
        container.appendChild(shareEditor);
        function renderShareInputs() {
            state.shareDraftPending = false;
            shareEditor.replaceChildren();
            const mode = document.createElement('p');
            mode.className = 'reparcel-share-mode';
            mode.textContent = slice.jointPool && slice.jointShareMode !== 'manual'
                ? t('reparcellization.modal.proRataShares', 'Shares follow private-land proportions.')
                : t('reparcellization.modal.customShares', 'Custom shares stay fixed when boundaries change.');
            shareEditor.append(mode);
            const inputs = slice.owners.map(owner => {
                const row = document.createElement('label');
                row.className = 'reparcel-share-row';
                const name = document.createElement('span');
                name.textContent = ownerDisplayName(owner.displayName);
                const input = document.createElement('input');
                input.type = 'number'; input.min = '0'; input.max = '100'; input.step = 'any';
                input.value = String(Number((owner.share * 100).toFixed(12)));
                input.setAttribute('aria-label', t('reparcellization.modal.ownerSharePercent', '{{owner}} share (%)', { owner: name.textContent }));
                input.dataset.ownerKey = owner.ownerKey;
                const percent = document.createElement('span'); percent.textContent = '%';
                row.append(name, input, percent); shareEditor.append(row);
                return { owner, input };
            });
            const status = document.createElement('p');
            status.className = 'reparcel-share-total'; status.setAttribute('role', 'status');
            const apply = document.createElement('button');
            apply.type = 'button'; apply.className = 'btn reparcel-apply-shares';
            apply.textContent = t('reparcellization.modal.applyShares', 'Apply shares');
            const parse = () => window.ReparcellizationAllocation.parsePercentShares(inputs.map(({ owner, input }) => ({ ...owner, percent: input.value })));
            const refresh = () => {
                const total = inputs.reduce((sum, { input }) => sum + (input.value === '' ? NaN : Number(input.value)), 0);
                try {
                    parse(); apply.disabled = false;
                    status.textContent = t('reparcellization.modal.sharesTotal', 'Total: {{total}}%', { total: CbFormat.formatNumber(total, { maxFractionDigits: 8 }) });
                    status.dataset.state = 'ok';
                } catch (_) {
                    apply.disabled = true;
                    status.textContent = t('reparcellization.modal.sharesInvalid', 'Each share must be positive and the total must be 100%.');
                    status.dataset.state = 'warn';
                }
            };
            inputs.forEach(({ input }) => input.addEventListener('input', () => {
                state.shareDraftPending = true;
                refresh(); updateCommitState();
            }));
            apply.addEventListener('click', () => {
                if (apply.disabled) return;
                const owners = parse();
                pushHistory();
                slice.owners = owners;
                if (slice.jointPool) slice.jointShareMode = 'manual';
                state.shareDraftPending = false;
                syncSlicePrimaryOwner(sliceIndex);
                dismissOwnerPopup();
            });
            shareEditor.append(status, apply);
            refresh();
            updateCommitState();
        }
        renderShareInputs();

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn reparcel-owner-popup__close';
        closeBtn.setAttribute('aria-label', t('reparcellization.modal.closeAria', 'Close'));
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
                state.shareDraftPending = false;
                state.ownerAssignmentPopup = null;
                restoreOwnerPopupView();
                if (state.selectedSliceIndex !== null) {
                    state.selectedSliceIndex = null;
                    updateLegend(state.ownerShares);
                    drawPreview();
                }
            }
        });

        popup.openOn(state.map);
        state.ownerAssignmentPopup = popup;
        state.map.getContainer().scrollIntoView({ block: 'center', behavior: 'instant' });
    }

    // "All public": assign every plot to public ownership in one click, so a plain break-up → Done
    // flow is possible without hand-assigning each plot. Public land is a valid owner (it commits to
    // the City), which satisfies the completeness gate.
    function assignPublicToAllSlices() {
        pushHistory();
        if (!Array.isArray(state.slices) || !state.slices.length) return;
        const publicOwner = getPublicLandOwner();
        state.slices.forEach((slice, i) => {
            slice.jointPool = false;
            delete slice.jointShareMode;
            slice.owners = [{ ownerKey: publicOwner.ownerKey, displayName: publicOwner.displayName, color: publicOwner.color, share: 1 }];
            syncSlicePrimaryOwner(i);
        });
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
    }

    function toggleOwnerOnSlice(sliceIndex, owner, add) {
        const slice = state.slices[sliceIndex];
        pushHistory();
        if (slice.jointPool) slice.jointShareMode = 'manual';
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
                ? slice.owners.map(o => ownerDisplayName(o.displayName)).join(' + ')
                : ownerDisplayName(primary.displayName);
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
                        ? slice.owners.map(o => ownerDisplayName(o.displayName)).join(', ')
                        : ownerDisplayName(slice.displayName);
                    layer.bindTooltip(escapeHtml(ownerNames), { sticky: true, className: 'reparcel-slice-tooltip' });
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
    // then rotate the resulting slices back. The rotation is affine in the local
    // metre frame (reparcellization-slice.js sliceAlongBearing), so the slices'
    // outer edges land back on the pool's own edges instead of millimetres outside.
    function computeSweepSlices() {
        if (!state.superParcel || !state.ownerShares.length) return [];
        const bearing = getSweepBearing();
        const pivot = getSuperParcelCentroidLngLat(state.superParcel);
        if (!bearing || !pivot) return sliceWithSweepLine(state.superParcel, state.ownerShares);
        return window.ReparcellizationSlice.sliceAlongBearing(state.superParcel, state.ownerShares, bearing, {
            turf: (typeof turf !== 'undefined' ? turf : undefined),
            computeFeatureArea,
            pivot
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
                color: '#7A1CAC', weight: 2, dashArray: '4 4', interactive: false, pane: 'reparcelTools'
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
            title: t('reparcellization.modal.sweepHandleHint', 'Drag to rotate the parcel lines'),
            pane: 'onMapEditorHandles'
        });
        state.sweepHandle.on('drag', onSweepDrag);
        // The node handles describe the plots; while the sweep regenerates them every frame they
        // would point at shapes that no longer exist, so they step aside until the drop.
        state.sweepHandle.on('dragstart', () => clearNodeHandles());
        state.sweepHandle.on('dragend', () => { if (state.nodeEdit.active) renderNodeHandles(); });
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
        const features = liveSelectionFeatures(state.selection).map(f => {
            const props = f.properties || {};
            const pid = props.parcelId || props.parcel_id || props.id;
            return { type: 'Feature', properties: { color: parcelColorForBefore(pid) }, geometry: f.geometry };
        });
        return { type: 'FeatureCollection', features };
    }

    // The before map (ui/map-before-after.js) shows the input parcels coloured by owner inside the
    // super-parcel outline; the live modal map, with its plots, is "after".
    function enterCompare() {
        if (!state.map || state.compare.active || !state.slices.length) return;
        cancelDraw();
        dismissOwnerPopup();
        const session = window.__MapBeforeAfter.attach(state.map, {
            percent: 50,
            labels: { before: t('mapCompare.before', 'Before'), after: t('mapCompare.after', 'After') },
            sliderLabel: t('mapCompare.sliderLabel', 'Before and after comparison'),
            drawBefore(beforeMap) {
                L.geoJSON(buildBeforeFeatureCollection(), {
                    style: f => ({ color: '#333', weight: 1, fillOpacity: 0.55, fillColor: (f.properties && f.properties.color) || '#888' })
                }).addTo(beforeMap);
                L.geoJSON(state.superParcel, { style: { color: '#111', weight: 2, fillOpacity: 0 }, interactive: false }).addTo(beforeMap);
            }
        });
        state.compare.active = true;
        state.compare.session = session;
        state.compare.map2 = session.beforeMap;
        drawOwnerReviewHighlights();
        if (state.compareBtn) state.compareBtn.setAttribute('aria-pressed', 'true');
    }

    function exitCompare() {
        if (!state.compare.active) return;
        state.compare.session?.dispose();
        state.compare.session = null;
        state.compare.map2 = null;
        state.compare.active = false;
        drawOwnerReviewHighlights();
        if (state.compareBtn) state.compareBtn.setAttribute('aria-pressed', 'false');
    }

    function toggleCompare() {
        if (state.compare.active) {
            exitCompare();
        } else if (state.slices.length) {
            enterCompare();
        }
    }

    function sliceIsUnassigned(slice) {
        return !!slice && !(Array.isArray(slice.owners) && slice.owners.length) && !slice.ownerKey;
    }

    // Plots nobody owns yet were all one grey, so a fresh cut looked like nothing happened. They
    // cycle through a few neutral tints from the stylesheet (on-map-reparcellization.css); pieces
    // of one cut sit next to each other in the list, so they always differ.
    function unassignedFill(index) {
        const n = (Math.abs(index) % 4) + 1;
        try {
            const value = getComputedStyle(document.documentElement)
                .getPropertyValue(`--reparcel-unassigned-fill-${n}`).trim();
            if (value) return value;
        } catch (_) { }
        return '#cccccc';
    }

    function sliceFillColor(slice, index) {
        if (sliceIsUnassigned(slice)) return unassignedFill(index);
        return slice.color || '#888';
    }

    // Base (un-highlighted) Leaflet style for a plot, matching drawPreview's style fn.
    function sliceBaseStyle(slice, index) {
        const isMulti = Array.isArray(slice.owners) && slice.owners.length > 1;
        return {
            color: isMulti ? '#000' : '#333',
            weight: isMulti ? 2 : 1,
            fillOpacity: 0.55,
            fillColor: sliceFillColor(slice, index),
            dashArray: isMulti ? '6 3' : null
        };
    }

    // A point inside the plot for its number: the centroid when it falls inside (most plots), else
    // a point guaranteed to be on the shape (an L or a thin strip).
    function plotLabelPoint(geometry) {
        if (!geometry || typeof turf === 'undefined') return null;
        try {
            const feature = { type: 'Feature', properties: {}, geometry };
            const centre = turf.centerOfMass(feature);
            if (turf.booleanPointInPolygon(centre, feature)) return centre.geometry.coordinates;
            return turf.pointOnFeature(feature).geometry.coordinates;
        } catch (_) { return null; }
    }

    function clearPlotNumbers() {
        if (state.plotNumberLayer) {
            try { state.plotNumberLayer.remove(); } catch (_) { }
            state.plotNumberLayer = null;
        }
    }

    // The New plots list numbers its rows; the same numbers on the map say which row is which plot.
    function drawPlotNumbers() {
        clearPlotNumbers();
        if (!state.map || !state.slices.length || state.plotsTab === 'old') return;
        const markers = state.slices.map((slice, idx) => {
            const point = plotLabelPoint(slice.geometry);
            if (!point) return null;
            return L.marker([point[1], point[0]], {
                pane: 'reparcelPlots',
                interactive: false,
                keyboard: false,
                icon: L.divIcon({ className: 'reparcel-plot-number', html: String(idx + 1), iconSize: [22, 22] })
            });
        }).filter(Boolean);
        state.plotNumberLayer = L.layerGroup(markers).addTo(state.map);
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
                    layer.setStyle(sliceBaseStyle(state.slices[sliceIndex] || {}, sliceIndex));
                }
            }
            layerIndex++;
        });
    }

    // Footprints of applied building proposals that overlap the pool. window.proposedBuildings
    // holds GeoJSON footprint Features (lng/lat) for applied/executed building proposals;
    // we clip them to the super parcel so they can guide the readjustment layout.
    function collectAppliedBuildingFootprints() {
        if (typeof turf === 'undefined' || !state.superParcel) return [];
        const all = (typeof window !== 'undefined' && Array.isArray(window.proposedBuildings))
            ? window.proposedBuildings
            : [];
        const out = [];
        for (const feature of all) {
            if (!feature || !feature.geometry) continue;
            const gt = feature.geometry.type;
            if (gt !== 'Polygon' && gt !== 'MultiPolygon') continue;
            let intersects = false;
            try { intersects = turf.booleanIntersects(state.superParcel, feature); } catch (_) { intersects = false; }
            if (intersects) out.push(feature);
        }
        return out;
    }

    function drawBuildingFootprints() {
        if (!state.map) return;
        if (state.buildingFootprintLayer) {
            state.buildingFootprintLayer.remove();
            state.buildingFootprintLayer = null;
        }
        const footprints = collectAppliedBuildingFootprints();
        if (!footprints.length) return;
        state.buildingFootprintLayer = L.geoJSON(
            { type: 'FeatureCollection', features: footprints },
            {
                interactive: false,
                pane: 'reparcelTools',
                style: {
                    color: '#b91c1c',
                    weight: 2,
                    fill: false,
                    fillOpacity: 0,
                    dashArray: '3 3'
                }
            }
        ).addTo(state.map);
        // Non-interactive, kept on top so the outlines read as a guide over the plots
        // (clicks pass through to the plot layers below).
        if (state.buildingFootprintLayer.bringToFront) {
            try { state.buildingFootprintLayer.bringToFront(); } catch (_) { }
        }
    }

    function drawInputParcels() {
        if (state.inputLayer) {
            try { state.inputLayer.remove(); } catch (_) { }
            state.inputLayer = null;
        }
        if (!state.map) return;
        const features = inputParcelFeatures();
        if (!features.length) return;
        const showing = state.plotsTab === 'old';
        state.inputLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            pane: 'reparcelPlots',
            style: showing
                ? { color: '#92400e', weight: 2, fillColor: '#fde68a', fillOpacity: 0.45 }
                : { color: '#9ca3af', weight: 1, dashArray: '4,4', fillOpacity: 0.06, fillColor: '#6b7280' },
            interactive: showing,
            onEachFeature: showing
                ? (feature, layer) => {
                    layer.bindTooltip(escapeHtml(inputParcelLabel(feature)), { direction: 'center', className: 'reparcel-oldplot-tip' });
                    layer.on('mouseover', () => layer.setStyle({ weight: 3, fillOpacity: 0.6 }));
                    layer.on('mouseout', () => layer.setStyle({ weight: 2, fillOpacity: 0.45 }));
                }
                : undefined
        }).addTo(state.map);
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

        // The parcels being replaced, under everything. In the new-plots view they are a faint
        // reference — you are editing the plan, not them — and in the old-plots view they are the
        // subject, so they carry the labels and the weight.
        drawInputParcels();

        if (state.slices.length && state.plotsTab === 'old') {
            // Old-plots view: the plan is context only. Faint, non-interactive, no hover, no
            // selection — nothing here is editable, and offering the affordance would lie.
            state.previewLayer = L.geoJSON(
                { type: 'FeatureCollection', features: state.slices.map(slice => ({ type: 'Feature', properties: {}, geometry: slice.geometry })) },
                { style: { color: '#6b7280', weight: 1, opacity: 0.5, fillOpacity: 0.05, fillColor: '#6b7280' }, interactive: false, pane: 'reparcelPlots' }
            ).addTo(state.map);
        } else if (state.slices.length) {
            const collection = {
                type: 'FeatureCollection',
                features: state.slices.map((slice, idx) => ({
                    type: 'Feature',
                    properties: {
                        ownerKey: slice.ownerKey,
                        color: sliceFillColor(slice, idx),
                        displayName: ownerDisplayName(slice.displayName),
                        percent: slice.percent,
                        sliceIndex: idx,
                        isMultiOwner: Array.isArray(slice.owners) && slice.owners.length > 1,
                        ownerNames: (Array.isArray(slice.owners) && slice.owners.length)
                            ? slice.owners.map(o => ownerDisplayName(o.displayName)).join(', ')
                            : ownerDisplayName(slice.displayName)
                    },
                    geometry: slice.geometry
                }))
            };
            const plotStyle = (props, mode) => {
                const selected = mode === 'selected';
                const hovered = mode === 'hover';
                return {
                    // The boundary itself carries hover/selection — a plot is a shape, not a box,
                    // and the only feedback before this was the browser's focus ring, which is
                    // drawn around the path's bounding box and reads as a stray rectangle.
                    color: selected ? '#1d4ed8' : (hovered ? '#2563EB' : (props.isMultiOwner ? '#000' : '#333')),
                    weight: selected ? 4 : (hovered ? 3 : (props.isMultiOwner ? 2 : 1)),
                    fillOpacity: selected ? 0.7 : (hovered ? 0.65 : 0.55),
                    fillColor: props.color || '#888',
                    dashArray: props.isMultiOwner ? '6 3' : null
                };
            };
            state.previewLayer = L.geoJSON(collection, {
                pane: 'reparcelPlots',
                style: feature => {
                    const props = feature.properties || {};
                    const selected = state.selectedSliceIndex === props.sliceIndex;
                    return plotStyle(props, selected ? 'selected' : 'idle');
                },
                onEachFeature: (feature, layer) => {
                    const idx = feature.properties?.sliceIndex;
                    if (typeof idx === 'number') {
                        layer.__reparcelSliceIndex = idx;
                        const owners = feature.properties.ownerNames || feature.properties.displayName;
                        layer.bindTooltip(escapeHtml(owners), { sticky: true, className: 'reparcel-slice-tooltip' });
                        layer.on('click', (e) => {
                            // While drawing, let the click reach the map so vertices can be
                            // placed over existing plots; don't swallow it for assignment. While
                            // erasing, a plot is not the thing being clicked at all.
                            if (state.drawing.active || state.erase.active) return;
                            L.DomEvent.stopPropagation(e);
                            layer.closeTooltip();
                            onSliceClick(idx, e.latlng);
                        });
                        layer.on('mouseover', () => {
                            // Don't show the plot tooltip while drawing/splitting or comparing.
                            if (state.ownerAssignmentPopup || state.drawing.active || state.compare.active
                                || state.erase.active) {
                                layer.closeTooltip();
                            }
                            if (state.drawing.active || state.compare.active || state.erase.active) return;
                            if (state.selectedSliceIndex === idx) return;
                            layer.setStyle(plotStyle(feature.properties || {}, 'hover'));
                            if (typeof layer.bringToFront === 'function') layer.bringToFront();
                        });
                        layer.on('mouseout', () => {
                            if (state.selectedSliceIndex === idx) return;
                            layer.setStyle(plotStyle(feature.properties || {}, 'idle'));
                        });
                    }
                }
            }).addTo(state.map);
        }

        // The pooled outline, in red and heavy: it is the one line in this editor that cannot be
        // moved, so it must not look like the plot boundaries that can. Drawn after the plots so it
        // is never buried under a fill.
        state.boundaryLayer = L.geoJSON(state.superParcel, {
            pane: 'reparcelTools',
            style: {
                color: '#dc2626',
                weight: 4,
                opacity: 0.95,
                fillOpacity: 0
            },
            interactive: false
        }).addTo(state.map);

        if (!state.hasFitBounds && state.superParcel) {
            if (state.session?.fitFeature) state.session.fitFeature(state.superParcel, { maxZoom: 21 });
            else if (state.boundaryLayer) {
                try { state.map.fitBounds(state.boundaryLayer.getBounds(), { padding: [20, 20] }); }
                catch (err) { console.warn('Failed to fit bounds for reparcellization preview', err); }
            }
            state.hasFitBounds = true;
        }

        drawPlotNumbers();

        // Building-footprint guide on top of the plots (outlines guide the layout).
        drawBuildingFootprints();
        drawOwnerReviewHighlights();

        // Keep the sweep direction line visible above the freshly re-added slices.
        if (state.sweepHandle) updateSweepDirLine();
    }

    function currentPlan() {
        return {
            algorithm: state.algorithm,
            generatedAt: new Date().toISOString(),
            parcelIds: state.selection?.ids?.slice() || [],
            // The exact connected ground this readjustment subdivides. Parent cadastral parcels can
            // be only partially involved (a road may already own the rest), so their whole union is
            // not always the boundary. Persisting the pool prevents a later edit from resurrecting
            // those outside remainders as thick-red-outline slivers.
            poolGeometry: state.superParcel ? JSON.parse(JSON.stringify(state.superParcel.geometry)) : null,
            // A subdivision's pool is its site (bound parcels' part + open ground): the editor and
            // the coverage checks reopen it from the site, never from a parcel selection.
            ...(state.sitePool ? {
                poolSource: 'site',
                openGroundM2: Math.round(state.sitePool.pool.openGroundM2 * 100) / 100
            } : {}),
            totalArea: state.totalArea,
            // Land-readjustment accounting metadata so downstream views/audits can
            // reconstruct entitlements and cash balances without re-deriving them.
            contributionBasis: state.contributionBasis,
            totalValue: state.totalValue,
            poolUnitValue: state.poolUnitValue,
            contributionRatio: state.contributionRatio,
            isSingleOwner: false,
            // Authored source shapes and ownership are needed later, after this layout has already
            // replaced its inputs on the map, to create independent courtyard contributions.
            inputParcels: state.algorithm === 'amend' ? JSON.parse(JSON.stringify(state.amendInputs)) : [],
            // Cash offers (the compensation part of the proposal) and their total.
            totalCashOffer: computeTotalCashOffer(),
            ownerShares: state.ownerShares.map(entry => {
                const ledger = computeOwnerLedger(entry);
                return {
                    ownerKey: entry.ownerKey,
                    displayName: entry.displayName,
                    ...(ledger.noOwner ? { noOwner: true } : {}),
                    percent: entry.percent,
                    color: entry.color,
                    contributedArea: entry.area,
                    contributedValue: entry.value,
                    entitledValue: ledger.entitled,
                    assignedArea: ledger.assignedArea,
                    assignedValue: ledger.assigned,
                    cashBalance: ledger.cashBalance,
                    // Open ground keeps a null cash offer; owners store payouts and payments separately.
                    ...storedCash(ledger.noOwner ? null : getCashOffer(entry.ownerKey, ledger))
                };
            }),
            polygons: state.slices.map(slice => ({
                ownerKey: slice.ownerKey,
                displayName: slice.displayName,
                percent: slice.percent,
                color: slice.color,
                source: slice.source || 'manual',
                jointPool: slice.jointPool === true,
                ...(slice.jointPool ? { jointShareMode: slice.jointShareMode === 'manual' ? 'manual' : 'pro-rata' } : {}),
                ...(slice.derivation ? { derivation: JSON.parse(JSON.stringify(slice.derivation)) } : {}),
                area: computeFeatureArea(sliceToFeature(slice)),
                geometry: slice.geometry,
                owners: Array.isArray(slice.owners) && slice.owners.length
                    ? slice.owners.map(o => ({ ownerKey: o.ownerKey, displayName: o.displayName, color: o.color, share: o.share }))
                    : []
            }))
        };
    }

    // ── Ownership and approval ───────────────────────────────────────────
    // Who owns which parcel (an uploaded rights file), the rule that passes the proposal and the lens
    // that attests owners. Set here while designing, so a readjustment is created ready for owners to
    // accept. The form is the editor's Approval tab (proposals/approval-setup.js).

    // The plan against its scheme's distribution rules, one line each, under the approval row.
    function renderRegimeCheck(check) {
        const list = state.approvalRowEl?.querySelector('[data-reparcel-regime-check]');
        if (!list) return;
        const lines = check && window.ProposalApprovalText
            ? window.ProposalApprovalText.checkLines(check, t, key => state.ownerShares.find(owner => owner.ownerKey === key)?.displayName || key) : [];
        list.hidden = !lines.length;
        list.innerHTML = check ? check.rules.map((rule, index) => `<li data-regime-rule="${rule.kind}${rule.per ? `-${rule.per}` : ''}" data-state="${rule.ok ? 'ok' : 'warn'}">${escapeHtml(lines[index])}</li>`).join('') : '';
    }

    function updateApprovalRow() {
        const row = state.approvalRowEl;
        const setup = window.ProposalApprovalSetup;
        if (!row || !setup) return;
        row.hidden = !!state.sitePool;
        row.querySelector('[data-reparcel-approval-summary]').textContent = setup.summaryText(state.approvalConfig, state.approvalLens);
        row.querySelector('[data-reparcel-approval-setup]').textContent = state.approvalConfig?.rights
            ? t('proposalDrafts.approval.change', 'Change…')
            : t('proposalDrafts.approval.setUp', 'Set up…');
    }

    function createDialogBehind() {
        return !!document.querySelector('.create-proposal-modal');
    }

    function approvalCadastreIds() {
        const ids = (state.selection?.ids || []).map(String);
        return [...new Set(ids.map(id => state.cadastreIdsByLiveParcel.get(id) || cadastralIdentityForLiveParcel(id, state.selection)).filter(Boolean).map(String))];
    }

    function openApprovalSetup() {
        window.ProposalApprovalSetup?.openDialog({
            approvalConfig: state.approvalConfig,
            lens: state.approvalLens,
            cadastreParcelIds: approvalCadastreIds(),
            onApply: setup => { applyApprovalSetup(setup).catch(error => console.error('[reparcellization] approval setup failed', error)); }
        });
    }

    // The rights file says who the owners are, so applying it re-derives them. An automatic layout
    // is re-split for the new owners; hand-drawn plots keep their shape, and a plot whose owner is
    // no longer one of them goes back to unassigned for the author to reassign.
    async function applyApprovalSetup(setup) {
        state.approvalConfig = setup.approvalConfig;
        state.approvalLens = setup.lens;
        // The create dialog (when one is behind this editor) and the design draft carry the same
        // setup (dialog-create.js, create.js). Without a dialog nothing is left pending for the next.
        if (createDialogBehind()) {
            window.pendingProposalApprovalSetup = { approvalConfig: setup.approvalConfig, lens: setup.lens };
            if (typeof mountReparcellizationApprovalRow === 'function') mountReparcellizationApprovalRow(document.querySelector('.create-proposal-modal'));
        }
        const draft = window.getActiveProposalDesignDraft?.();
        if (draft && window.proposalDraftStore?.getDraft?.(draft.id)) {
            window.proposalDraftStore.updateDraft(draft.id, { fields: { approvalConfig: setup.approvalConfig, lens: setup.lens } }, { coalesceKey: 'reparcel-approval' });
        }
        const keysOf = shares => shares.filter(entry => !isNoOwnerEntry(entry)).map(entry => entry.ownerKey).sort().join('|');
        const before = keysOf(state.ownerShares);
        state.ownerShares = await buildOwnerShares(state.selection);
        const changed = keysOf(state.ownerShares) !== before;
        if (changed) {
            if (state.algorithm === 'sweep-line') {
                state.slices = computeSweepSlices();
            } else {
                const known = new Set(state.ownerShares.map(entry => entry.ownerKey));
                state.slices = state.slices.map(slice => {
                    const owners = Array.isArray(slice.owners) ? slice.owners : [];
                    if (!owners.length || owners.every(owner => known.has(owner.ownerKey))) return slice;
                    return createUnassignedPlot(slice.geometry, slice.source);
                });
            }
            // The undo history describes owners that no longer exist.
            if (state.historyCtl) state.historyCtl.clear();
        }
        updateSubtitleWithOwners(state.ownerShares.filter(entry => !isNoOwnerEntry(entry)).length);
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
        if (state.nodeEdit.active) renderNodeHandles();
        updateApprovalRow();
        setStatus(changed
            ? t('reparcellization.modal.status.ownersFromRights', 'The owners now come from the rights file: {{count}} owner(s). Check each plot\'s owners.', {
                count: state.ownerShares.filter(entry => !isNoOwnerEntry(entry)).length })
            : t('reparcellization.modal.status.approvalSaved', 'Ownership and approval saved.'), 'info');
    }

    function persistResult() {
        if (!state.slices.length || !evaluatePlanCompleteness().ok) { updateCommitState(); return false; }
        const payload = currentPlan();
        window.pendingReparcellizationPlan = payload;
        if (typeof window.syncActiveProposalDraftFromEditor === 'function') {
            window.syncActiveProposalDraftFromEditor('reparcellization', payload, {
                coalesceKey: 'reparcellization-design'
            });
        }
        if (state.commitBtns && state.commitBtns.length) {
            state.commitBtns.forEach(btn => { btn.disabled = false; });
        }
        return true;
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

    // Share parsing / normalization lives in frontend/js/reparcellization-shares.js (loaded first)
    // so it is unit-tested headless. It fixed the bare-"50" bug (see that file).
    const { parseShareValue, normalizeOwnerSlots } = window.ReparcellizationShares;

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

    // Explicit owner IDs alone join contributions across parcels. Without one, a slot stays a
    // parcel-scoped draft participant; names and addresses never imply identity.
    function ownerIdentityForSlot(slot, parcelId, fallbackName) {
        return { ownerKey: slot?.ownerId || `draft-owner:${parcelId}:${slot?.draftOwnerIndex ?? 0}`,
            displayName: t('proposalApproval.ownerLabel', 'Owner {{label}}', { label: 'A' }) };
    }

    function savedOutputRecipientIds() {
        const ids = new Set();
        for (const plot of state.initialPolygons || []) {
            for (const owner of [plot, ...(Array.isArray(plot.owners) ? plot.owners : [])]) {
                const id = owner?.ownerKey;
                if (id && id !== PUBLIC_LAND_KEY && !owner.noOwner) ids.add(String(id));
            }
        }
        return [...ids].sort();
    }

    function appendSavedOutputRecipients(entries) {
        const known = new Set(entries.map(entry => String(entry.ownerKey || '')));
        for (const ownerKey of savedOutputRecipientIds()) {
            if (known.has(ownerKey)) continue;
            entries.push({ ownerKey, displayName: '', parcelIds: [], area: 0, value: 0,
                percent: 0, color: pickOwnerColor(ownerKey, entries.length), unresolvedContribution: true });
            known.add(ownerKey);
        }
        return entries;
    }

    function restoreSavedLedgerMetadata(entries) {
        const saved = state.savedLedgerMetadata || {};
        const areas = entries.map(entry => Number(entry.contributedArea ?? entry.area)).filter(Number.isFinite);
        const totalArea = areas.reduce((sum, area) => sum + area, 0);
        const values = entries.map(entry => entry.contributedValue ?? entry.value);
        const totalValue = values.length && values.every(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
            ? values.reduce((sum, value) => sum + Number(value), 0) : null;
        state.totalValue = Object.prototype.hasOwnProperty.call(saved, 'totalValue')
            ? saved.totalValue : totalValue;
        state.poolUnitValue = Object.prototype.hasOwnProperty.call(saved, 'poolUnitValue')
            ? saved.poolUnitValue
            : (Number.isFinite(state.totalValue) && totalArea > 0 ? state.totalValue / totalArea : null);
        state.contributionBasis = saved.contributionBasis || (state.totalValue > 0 ? 'value' : 'area');
    }

    function replaceSavedInputOwnersFromRights(inputs, liveToCadastreIds = new Map()) {
        const records = new Map((state.approvalConfig?.rights?.parcels || []).map(parcel => [String(parcel.parcelId), parcel]));
        for (const input of Array.isArray(inputs) ? inputs : []) {
            const liveId = String(input.parcelId || input.id || '');
            const candidate = liveToCadastreIds.has(liveId)
                ? liveToCadastreIds.get(liveId)
                : String(input.cadastreParcelId || input.parcelId || input.id || '');
            // Composite provenance identifies more than one cadastral parcel. It cannot authorize
            // replacing this saved input's owner vector with any one member's ownership.
            if (!candidate || candidate.includes('+')) continue;
            const record = records.get(candidate);
            if (!record?.complete) continue;
            input.cadastreParcelId = candidate;
            input.owners = normalizeOwnerSlots(record.owners.map(owner => ({
                ownerId: owner.ownerId, key: owner.ownerId, shareText: owner.share
            }))).map(({ slot, fraction }, index) => ({
                ownerKey: slot.ownerId,
                displayName: '',
                color: pickOwnerColor(slot.ownerId, index),
                share: fraction
            }));
        }
        return inputs;
    }

    function declaredOwnerSlots(parcelId) {
        const record = state.approvalConfig?.rights?.parcels.find(parcel => parcel.parcelId === String(parcelId));
        if (!record?.complete) return null;
        return record.owners.map(owner => ({ key: owner.ownerId, ownerId: owner.ownerId, shareText: owner.share,
            type: 'abstract', placeholder: false }));
    }

    function labelAbstractOwners(entries) {
        const ids = [...new Set([
            ...entries.filter(entry => !entry.noOwner && entry.ownerKey && entry.ownerKey !== PUBLIC_LAND_KEY).map(entry => entry.ownerKey),
            ...savedOutputRecipientIds(),
            ...(state.amendInputs || []).flatMap(input => (input.owners || []).map(owner => owner.ownerKey).filter(Boolean))
        ])].sort();
        const label = id => {
            const english = window.ProposalApproval.ownerLabel(id, ids);
            return t('proposalApproval.ownerLabel', 'Owner {{label}}', { label: english.replace(/^Owner\s*/, '') });
        };
        for (const entry of entries) if (ids.includes(entry.ownerKey)) entry.displayName = label(entry.ownerKey);
        for (const owners of state.parcelOwnerIndex.values()) {
            for (const owner of owners) if (ids.includes(owner.ownerKey)) owner.displayName = label(owner.ownerKey);
        }
        for (const plot of [...(state.initialPolygons || []), ...(state.amendInputs || [])]) {
            if (ids.includes(plot.ownerKey)) plot.displayName = label(plot.ownerKey);
            for (const owner of plot.owners || []) if (ids.includes(owner.ownerKey)) owner.displayName = label(owner.ownerKey);
        }
        return entries;
    }

    function cadastralIdentityForLiveParcel(parcelId, selection) {
        if (selection?.source === 'cadastre') {
            if (!window.CadastralParcelRepository?.get?.(parcelId)) {
                throw new Error(`Saved readjustment input ${parcelId} is missing from the cadastre.`);
            }
            return String(parcelId);
        }
        const fabric = (typeof window !== 'undefined') ? window.LiveParcelFabric : null;
        if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
            throw new Error('Live parcel fabric provenance is unavailable while assigning readjustment owners.');
        }
        const ids = fabric.cadastreIdsForParcelIds([parcelId])
            .map(String)
            .filter(Boolean)
            .sort();
        if (!ids.length) {
            throw new Error(`Live parcel ${parcelId} has no cadastral provenance.`);
        }
        return ids.join('+');
    }

    // Owner shares of a subdivision's site pool: each bound parcel's owners contribute the part of
    // the parcel INSIDE the site (not the whole parcel), the open ground contributes its area with
    // no owner. Measured by area (subdivision.js poolShares: open ground has no known value).
    async function buildSitePoolShares() {
        const api = subdivisionApi();
        const pool = state.sitePool && state.sitePool.pool;
        if (!api || !pool) return [];
        const byOwner = new Map();
        for (const part of pool.parts) {
            let slots = [];
            const declared = declaredOwnerSlots(part.parcelId);
            if (declared) slots = declared;
            else if (typeof ensureParcelOwnerSlots === 'function') {
                try { slots = await ensureParcelOwnerSlots(part.parcelId); } catch (error) {
                    console.warn('[reparcellization] owner slots unavailable for', part.parcelId, error);
                }
            }
            if (!Array.isArray(slots) || !slots.length) {
                slots = [{ key: `parcel:${part.parcelId}:synthetic-owner`, displayName: t('reparcellization.modal.syntheticOwner', 'Owner of {{parcel}}', { parcel: part.parcelId }), shareText: '1/1' }];
            }
            normalizeOwnerSlots(slots).forEach(({ slot, fraction }, index) => {
                slot = { ...slot, draftOwnerIndex: index };
                const fallbackOwnerName = t('reparcellization.modal.syntheticOwner', 'Owner of {{parcel}}', { parcel: part.parcelId });
                const { ownerKey, displayName } = ownerIdentityForSlot(slot, part.parcelId, fallbackOwnerName);
                const entry = byOwner.get(ownerKey) || { ownerKey, displayName, area: 0, value: null, parcelIds: [] };
                entry.area += part.areaM2 * fraction;
                if (!entry.parcelIds.includes(part.parcelId)) entry.parcelIds.push(part.parcelId);
                byOwner.set(ownerKey, entry);
            });
        }
        const result = api.poolShares(Array.from(byOwner.values()), {
            openGroundM2: pool.openGroundM2,
            openGroundLabel: t('reparcellization.modal.openGroundOwner', 'Open ground (no owner)')
        });
        state.contributionBasis = result.basis;
        state.totalValue = result.totalValue;
        state.poolUnitValue = result.poolUnitValue;
        return labelAbstractOwners(result.shares.map((entry, index) => ({
            ...entry,
            color: entry.noOwner ? OPEN_GROUND_COLOR : pickOwnerColor(entry.ownerKey, index)
        })));
    }

    async function buildOwnerShares(selection) {
        state.parcelOwnerIndex = new Map();
        state.cadastreIdsByLiveParcel = new Map();
        if (!state.approvalConfig?.rights && state.savedOwnerShares.length) {
            const entries = appendSavedOutputRecipients(state.savedOwnerShares.map(entry => ({ ...entry,
                area: entry.contributedArea ?? entry.area ?? 0,
                value: entry.contributedValue ?? entry.value ?? 0,
                parcelIds: entry.parcelIds || []
            })));
            restoreSavedLedgerMetadata(state.savedOwnerShares);
            return labelAbstractOwners(entries);
        }
        if (state.sitePool) return buildSitePoolShares();
        const result = new Map();
        const parcelFeatures = liveSelectionFeatures(selection);
        let totalArea = 0;
        let totalValue = 0;

        for (const feature of parcelFeatures) {
            if (!feature || !feature.properties) continue;
            const parcelId = feature.properties.parcelId;
            const cadastralIdentity = cadastralIdentityForLiveParcel(parcelId, selection);
            state.cadastreIdsByLiveParcel.set(String(parcelId), String(cadastralIdentity));
            const area = Number(feature.properties.calculatedArea) || computeFeatureArea(feature);
            if (!area || !Number.isFinite(area)) continue;

            const value = getParcelLandValue(feature, area);
            totalArea += area;
            totalValue += value;

            let slots = [];
            const declared = declaredOwnerSlots(cadastralIdentity);
            if (declared) slots = declared;
            else if (typeof ensureParcelOwnerSlots === 'function') {
                try {
                    slots = await ensureParcelOwnerSlots(parcelId);
                } catch (error) {
                    console.warn('Failed to fetch owner slots for parcel', parcelId, error);
                }
            }
            if (!Array.isArray(slots) || !slots.length) {
                slots = [{
                    key: `parcel:${cadastralIdentity}:synthetic-owner`,
                    displayName: t(
                        'reparcellization.modal.syntheticOwner',
                        'Owner of {{parcel}}',
                        { parcel: feature.properties.BROJ_CESTICE || cadastralIdentity }
                    ),
                    shareText: '1/1'
                }];
            }

            const normalizedSlots = normalizeOwnerSlots(slots);
            const parcelOwners = [];
            normalizedSlots.forEach(({ slot, fraction }, index) => {
                slot = { ...slot, draftOwnerIndex: index };
                const parcelLabel = feature.properties.BROJ_CESTICE || cadastralIdentity;
                // “Unassigned” describes a PLOT with no owner. If an ownership source uses that
                // same placeholder for a contributor, give the contributor a stable parcel-based
                // name so a complete plan cannot still show an unassigned state.
                const fallbackOwnerName = t(
                    'reparcellization.modal.syntheticOwner',
                    'Owner of {{parcel}}',
                    { parcel: parcelLabel }
                );
                const { ownerKey, displayName } = ownerIdentityForSlot(slot, cadastralIdentity, fallbackOwnerName);
                parcelOwners.push({ ownerKey, displayName, color: pickOwnerColor(ownerKey, 0), share: fraction });
                const existing = result.get(ownerKey) || {
                    ownerKey,
                    displayName,
                    parcelIds: new Set(),
                    totalArea: 0,
                    totalValue: 0
                };
                existing.totalArea += area * fraction;
                existing.totalValue += value * fraction;
                if (parcelId) existing.parcelIds.add(parcelId);
                result.set(ownerKey, existing);
            });
            state.parcelOwnerIndex.set(String(parcelId), parcelOwners);
        }

        if (!totalArea) {
            state.totalValue = 0;
            state.poolUnitValue = 0;
            state.contributionBasis = 'area';
            return labelAbstractOwners(appendSavedOutputRecipients([]));
        }

        if (state.algorithm === 'amend' && state.approvalConfig?.rights) {
            replaceSavedInputOwnersFromRights(state.amendInputs, state.cadastreIdsByLiveParcel);
        }

        // Contribution percent is by value when value data is meaningful,
        // otherwise by area. poolUnitValue (€/m²) lets us value redrawn plots
        // at the pool average, so owners who pooled pricier land get more area.
        // A scheme that distributes by area (approval-regimes.js) keeps it by area. Looked up here,
        // not through a helper: readjustment-owner-identity.test.js runs this function on its own.
        const scheme = state.approvalConfig?.regime;
        const schemeBasis = scheme ? window.ProposalApprovalRegimes?.get(scheme.id, scheme.version)?.allocation?.basis : null;
        const useValue = totalValue > 0 && schemeBasis !== 'area';
        state.totalValue = totalValue;
        state.poolUnitValue = useValue && totalArea > 0 ? totalValue / totalArea : 0;
        state.contributionBasis = useValue ? 'value' : 'area';

        const entries = Array.from(result.values()).map((entry, index) => {
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
        appendSavedOutputRecipients(entries);
        return labelAbstractOwners(entries);
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

    // Sweep-line subdivision lives in frontend/js/reparcellization-slice.js (loaded first) so it is
    // unit-tested, and its 0%-owner land bug is fixed there. Inject this file's turf + area helper.
    function sliceWithSweepLine(superParcel, owners) {
        return window.ReparcellizationSlice.sliceWithSweepLine(superParcel, owners, {
            turf: (typeof turf !== 'undefined' ? turf : undefined),
            computeFeatureArea
        });
    }

    async function refreshPreview() {
        setStatus(
            t('reparcellization.modal.status.preparingPreview', 'Preparing repartition preview...'),
            'info',
            'reparcellization.modal.status.preparingPreview'
        );
        ensureCommitAvailability(false);
        state.ownerShares = await buildOwnerShares(state.selection);
        const realOwnerCount = state.ownerShares.filter(entry => !isNoOwnerEntry(entry)).length;
        // A single owner can still readjust: the implicit second party is PUBLIC LAND (the land
        // the proposal cedes to public use, or plots the city would sell on later). Open with a
        // half/half split — the sweep handle and plot editing take it from there. Contribution
        // accounting is untouched: the owner contributed everything, public land nothing, so the
        // balance column shows exactly what the ceded half is worth.
        // A subdivision already has its second party (open ground; public land is assignable).
        if (!state.sitePool && state.ownerShares.length === 1) {
            state.ownerShares[0].percent = 0.5;
            state.ownerShares.push({
                ...getPublicLandOwner(),
                parcelIds: [],
                area: 0,
                value: 0,
                percent: 0.5
            });
        }
        updateSubtitleWithOwners(realOwnerCount);
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

        // Restore a saved plan instead of re-running the algorithm, which would throw away its
        // hand-drawn plots and owner assignments. Consumed once: switching algorithm inside the
        // modal still recomputes from scratch, as it should.
        const seededPolygons = state.initialPolygons;
        state.initialPolygons = null;
        if (seededPolygons && seededPolygons.length) {
            // The sweep handle drives the orientation UI, so it still has to exist for a
            // sweep-line plan the user may want to re-cut.
            if (state.algorithm === 'sweep-line') initSweepOrientation();
            state.slices = hydrateSlicesFromPolygons(seededPolygons);
            if (state.slices.length) {
                setStatus('', 'info');
                updateLegend(state.ownerShares);
                drawPreview();
                updateCommitState();
                return;
            }
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
        } else if (state.algorithm === 'amend') {
            state.slices = buildAmendSlices();
            setStatus(t('reparcellization.modal.status.amendHint',
                'Keep the existing plots and owners. Carve a shared courtyard or edit the boundaries.'), 'info');
        } else if (state.algorithm === 'manual') {
            const carried = state.carrySlices;
            state.carrySlices = null;
            if (Array.isArray(carried) && carried.length) {
                // Continue from the layout that was on the map (see the algorithm switch).
                state.slices = carried;
                setStatus(
                    t('reparcellization.modal.status.manualFromLayout',
                        'Drawing freely from the current layout. Drag nodes or whole boundary segments, cut with the line tool, or click a boundary to erase it.'),
                    'info',
                    'reparcellization.modal.status.manualFromLayout'
                );
            } else {
                // Nothing to continue from: the undivided pool as one unassigned plot.
                state.slices = [createUnassignedPlot(state.superParcel.geometry, 'base')];
                setStatus(
                    t('reparcellization.modal.status.manualHint', 'Draw plots on the map, then assign each to an owner.'),
                    'info',
                    'reparcellization.modal.status.manualHint'
                );
            }
        } else {
            setStatus(
                t('reparcellization.modal.status.algorithmUnavailable', 'Selected algorithm is not available yet.'),
                'warning',
                'reparcellization.modal.status.algorithmUnavailable'
            );
            return;
        }
        updateLegend(state.ownerShares);
        drawPreview();
        updateCommitState();
    }

    function validateSelection(selection) {
        if (!selection || !Array.isArray(selection.ids) || !selection.ids.length
            || liveSelectionFeatures(selection).length !== selection.ids.length) {
            return false;
        }
        return true;
    }

    function buildSuperParcel(selection) {
        if (typeof buildGeometryFromParcels !== 'function') {
            return null;
        }
        const geometry = buildGeometryFromParcels(selection.ids);
        if (!geometry) return null;
        return {
            type: 'Feature',
            properties: {
                parcelIds: selection.ids.slice()
            },
            geometry
        };
    }

    // A reparcellization is a GEOMETRICAL FACT: the ground it covers is the union of its own
    // plots, and its cadastral parents follow from that geometry. So a saved plan can always be
    // reopened, whatever the map is currently showing — its source parcels are routinely consumed
    // and hidden under the applied plan, and requiring live layers made "Edit geometry" impossible
    // on exactly the plans most worth editing.
    function buildSuperParcelFromPlan(polygons, parcelIds) {
        const t = (typeof turf !== 'undefined') ? turf : null;
        if (!t || !Array.isArray(polygons) || !polygons.length) return null;
        const features = polygons
            .map(p => (p && p.geometry) ? { type: 'Feature', properties: {}, geometry: p.geometry } : null)
            .filter(Boolean);
        if (!features.length) return null;
        let union = features[0];
        for (let i = 1; i < features.length; i++) {
            try { union = t.union(union, features[i]) || union; } catch (_) { /* keep what unioned */ }
        }
        if (!union || !union.geometry) return null;
        return {
            type: 'Feature',
            properties: { parcelIds: (Array.isArray(parcelIds) ? parcelIds.slice() : []) },
            geometry: union.geometry
        };
    }

    // The parcels a saved plan says it was made from. The plan's own list is authoritative; the
    // current map selection is not consulted, because "what happens to be selected" is not an input.
    function declaredPlanParcelIds(fallbackSelection) {
        const plan = window.pendingReparcellizationPlan;
        if (plan && Array.isArray(plan.parcelIds) && plan.parcelIds.length) {
            return plan.parcelIds.map(String);
        }
        return (fallbackSelection && Array.isArray(fallbackSelection.ids))
            ? fallbackSelection.ids.map(String)
            : [];
    }

    // Declare the complete input set to the ground service before resolving facts. The service
    // alone decides which are already present, in flight, absent, or need transport.
    async function resolveInputParcelFeatures(parcelIds) {
        const ids = (parcelIds || []).map(String);
        if (ids.length && window.CadastralParcelRepository
            && typeof window.CadastralParcelRepository.ensureIds === 'function') {
            try {
                await window.CadastralParcelRepository.ensureIds(ids);
            } catch (error) {
                console.warn('[reparcellization] loading the plan\'s cadastral ground failed', error);
            }
        }
        return readjustmentInputFeatures({ ids, source: 'cadastre' }, {
            cadastre: window.CadastralParcelRepository
        });
    }

    // `initialPolygons` (optional) reopens the editor on a saved plan's polygons[] instead of
    // re-running the algorithm — used by "Copy into new proposal" and by reopening a draft.
    // One editor at a time.
    //
    // A second modal opens directly over the first, and because the module keeps ONE state object
    // the older modal's buttons stay wired to a torn-down editor: visible, enabled, and doing
    // nothing when clicked. That is indistinguishable from a broken tool — a symptom this editor
    // has already been debugged for twice.
    //
    // The latch has to be set SYNCHRONOUSLY. Checking `state.modal` alone does not work: opening
    // awaits the input parcels before it builds anything, so two clicks in the same tick both sail
    // past a guard that only looks at what has been built.
    async function openReparcellizationModal(options = {}) {
        if (state.opening || (state.modal && document.contains(state.modal))) {
            console.warn('[reparcellization] the editor is already open; ignoring a second request');
            return false;
        }
        state.opening = true;
        try {
            return await buildReparcellizationModal(options);
        } finally {
            state.opening = false;
        }
    }

    // A pending plan pooled from a site (plan.poolSource 'site'): its site is the saved pool, its
    // bound parcels the plan's own list or else the design draft's binding/declaration. The plan's
    // saved open-ground area guards the fallback (buildSitePool).
    function sitePoolOfPendingPlan() {
        const plan = window.pendingReparcellizationPlan;
        if (!plan || plan.poolSource !== 'site' || !plan.poolGeometry) return null;
        let ids = Array.isArray(plan.parcelIds) ? plan.parcelIds.map(String) : null;
        if (!ids || !ids.length) {
            const draft = typeof window.getActiveProposalDesignDraft === 'function' ? window.getActiveProposalDesignDraft() : null;
            const fields = (draft && draft.fields) || {};
            const bound = fields.binding && Array.isArray(fields.binding.parcels)
                ? fields.binding.parcels.map(hit => String(hit && hit.parcelId || '')).filter(Boolean) : [];
            ids = bound.length ? bound : (Array.isArray(fields.cadastreParcelIds) ? fields.cadastreParcelIds.map(String) : []);
        }
        return {
            site: plan.poolGeometry,
            boundParcelIds: Array.from(new Set(ids)),
            expectedOpenGroundM2: Number.isFinite(Number(plan.openGroundM2)) ? Number(plan.openGroundM2) : null
        };
    }

    // A subdivision's pool (PARCEL-OPTIONAL.md phase 4): the drawn site, split into the bound
    // parcels' parts (cadastral geometry from the repository — the same source the open-ground
    // host is derived from at apply) and the open ground. Every bound parcel must resolve: a
    // missing one would be counted as open ground, i.e. land with no owner, which it is not.
    async function buildSitePool(sitePool) {
        const api = subdivisionApi();
        const site = sitePool && sitePool.site;
        if (!api || !site || !/Polygon/.test(String(site.type || ''))) return null;
        const boundIds = (sitePool.boundParcelIds || []).map(String);
        const resolved = boundIds.length ? await resolveInputParcelFeatures(boundIds) : { features: [], missing: [] };
        if (resolved.missing.length) {
            console.warn('[reparcellization] subdivision: bound parcels not available', resolved.missing);
            return { error: 'missing', missing: resolved.missing };
        }
        const parcels = resolved.features.map(feature => ({
            id: String(feature.properties && (feature.properties.parcelId || feature.properties.id) || ''),
            geometry: feature.geometry
        }));
        // Authoring mirrors apply (apply/parcels.js): ground another proposal formed on open ground
        // is spoken for, so a subdivision over it would never apply.
        const fabric = window.LiveParcelFabric;
        const ground = window.__openGround;
        const order = window.__planOrder;
        if (fabric && typeof fabric.queryBounds === 'function' && ground && order && typeof order.intersectionArea === 'function') {
            const siteFeature = { type: 'Feature', properties: {}, geometry: site };
            const holders = new Set();
            fabric.queryBounds(ground.bboxOf(site))
                .filter(feature => ground.groundIdsOf(feature).length && feature.properties && feature.properties.producedByProposalId)
                .filter(feature => Number(order.intersectionArea(siteFeature, feature)) >= (Number(order.MIN_INTERSECTION_M2) || 0.25))
                .forEach(feature => holders.add(String(feature.properties.producedByProposalId)));
            if (holders.size) {
                const names = Array.from(holders).map(id => {
                    const record = window.proposalStorage && typeof window.proposalStorage.getProposal === 'function'
                        ? window.proposalStorage.getProposal(id) : null;
                    return (record && (record.title || record.name)) || id;
                });
                return { error: 'taken', names };
            }
        }
        const pool = api.sitePool(site, parcels);
        // The plan saved its open ground. Finding MORE now means bound parcels are missing from the
        // inputs: their ground would be counted as ownerless, so refuse rather than open on it.
        const expected = sitePool.expectedOpenGroundM2;
        if (typeof expected === 'number' && Number.isFinite(expected)
            && pool.openGroundM2 > expected + Math.max(1, expected * 0.01)) {
            console.warn('[reparcellization] subdivision: more open ground than the plan saved — bound parcels missing',
                { saved: expected, now: Math.round(pool.openGroundM2), boundParcelIds: boundIds });
            return { error: 'unavailable' };
        }
        console.debug(`[${new Date().toISOString()}] [reparcellization] subdivision pool`, {
            siteM2: Math.round(pool.totalAreaM2), boundParcels: pool.parts.length, openGroundM2: Math.round(pool.openGroundM2)
        });
        return {
            site: JSON.parse(JSON.stringify(site)),
            boundParcelIds: boundIds,
            pool
        };
    }

    async function buildReparcellizationModal(options = {}) {
        let selection = (typeof getCurrentParcelSelectionContext === 'function')
            ? getCurrentParcelSelectionContext()
            : null;
        let planPool = null;
        state.sitePool = null;
        const pendingSetup = createDialogBehind() ? window.pendingProposalApprovalSetup : null;
        state.approvalConfig = options.approvalConfig || pendingSetup?.approvalConfig
            || window.getActiveProposalDesignDraft?.()?.fields?.approvalConfig || null;
        state.approvalLens = options.lens || pendingSetup?.lens
            || window.getActiveProposalDesignDraft?.()?.fields?.lens || [];
        const pendingPlan = window.pendingReparcellizationPlan || {};
        state.savedOwnerShares = JSON.parse(JSON.stringify(pendingPlan.ownerShares || []));
        state.savedLedgerMetadata = Object.fromEntries(['contributionBasis', 'totalValue', 'poolUnitValue']
            .filter(key => Object.prototype.hasOwnProperty.call(pendingPlan, key))
            .map(key => [key, pendingPlan[key]]));

        // Every opener of a subdivision lands here: the draft adapter passes `sitePool`; the create
        // dialog's Edit only has the pending plan, whose pool IS the site.
        const sitePoolRequest = options.sitePool || sitePoolOfPendingPlan();
        if (sitePoolRequest) {
            const built = await buildSitePool(sitePoolRequest);
            if (!built || built.error) {
                const message = built && built.error === 'missing'
                    ? t('reparcellization.modal.siteParcelsMissing', 'The parcels under this site could not be loaded: {{ids}}.', { ids: built.missing.join(', ') })
                    : (built && built.error === 'taken'
                        ? t('reparcellization.modal.siteGroundTaken', 'This site covers ground another proposal already formed: {{names}}. Draw the site off it, or unapply that proposal first.', { names: built.names.map(name => `"${name}"`).join(', ') })
                        : t('reparcellization.modal.siteUnavailable', 'This site cannot be subdivided here.'));
                if (typeof updateStatus === 'function') updateStatus(message);
                try { if (typeof window.showEphemeralMessage === 'function') window.showEphemeralMessage(message, 8000, 'warning'); } catch (_) { }
                return false;
            }
            state.sitePool = built;
            selection = { ids: built.boundParcelIds.slice(), source: 'cadastre' };
            planPool = { type: 'Feature', properties: { parcelIds: built.boundParcelIds.slice() }, geometry: built.pool.pool };
        }

        // Reopening a SAVED plan: the inputs are the parcels the plan DECLARES, full stop.
        //
        // Two things used to go wrong here. A live map selection won, so opening the editor with
        // anything selected pooled *that* instead of the plan's own parents — the subtitle would
        // read "23 parcels" for a 29-parcel plan and coverage would climb past 100%. And when no
        // selection existed the pool was unioned from the plan's OUTPUT polygons, which is circular:
        // the boundary became whatever the outputs currently are, so a plot dragged out into empty
        // space silently redefined the pool it was supposed to be constrained by.
        //
        // The pool is the union of the INPUT parcels. They are only hidden under an applied plan,
        // never gone, so they can be fetched back.
        const savedPolygons = (Array.isArray(options.initialPolygons) && options.initialPolygons.length)
            ? options.initialPolygons
            : ((window.pendingReparcellizationPlan && Array.isArray(window.pendingReparcellizationPlan.polygons))
                ? window.pendingReparcellizationPlan.polygons
                : null);
        state.amendInputs = savedPolygons?.length && Array.isArray(window.pendingReparcellizationPlan?.inputParcels)
            ? JSON.parse(JSON.stringify(window.pendingReparcellizationPlan.inputParcels)) : [];
        if (!state.sitePool && savedPolygons && savedPolygons.length) {
            const planIds = declaredPlanParcelIds(selection);
            const resolved = planIds.length ? await resolveInputParcelFeatures(planIds) : { features: [], missing: [] };
            const savedPool = options.poolGeometry
                || (window.pendingReparcellizationPlan && window.pendingReparcellizationPlan.poolGeometry)
                || null;
            const explicitPool = savedPool && /Polygon/.test(String(savedPool.type || ''))
                ? { type: 'Feature', properties: { parcelIds: planIds.slice() }, geometry: JSON.parse(JSON.stringify(savedPool)) }
                : null;
            const inputPool = resolved.features.length && !resolved.missing.length
                ? buildSuperParcelFromPlan(resolved.features, planIds)
                : null;
            if (explicitPool) {
                console.debug('[reparcellization] pooled from the plan\'s saved connected extent',
                    { inputs: planIds.length, plots: savedPolygons.length });
                planPool = explicitPool;
            } else if (inputPool) {
                console.debug('[reparcellization] pooled from the plan\'s declared inputs',
                    { inputs: planIds.length, plots: savedPolygons.length });
                planPool = inputPool;
            } else if (planIds.length) {
                // Not every input could be resolved. Falling back to the outputs' own outline keeps
                // the plan editable, but the pool is then only as trustworthy as the outputs — say
                // so rather than presenting a derived boundary as if it were the cadastre.
                console.warn('[reparcellization] could not resolve every input parcel — pooling from the plan geometry instead',
                    { declared: planIds.length, resolved: resolved.features.length, missing: resolved.missing });
                planPool = buildSuperParcelFromPlan(savedPolygons, planIds);
                state.poolFromOutputs = true;
            }
            if (planPool) selection = { ids: planIds.slice(), source: 'cadastre' };
        }

        // A readjustment may be designed on any ground that is not already taken — the remainders a
        // road left included, which is the whole point of forming blocks with roads and then
        // redividing them (ruling 2026-08-10, replacing the whole-parcel rule of 2026-08-07).
        //
        // Being DERIVED is not the test; being SPOKEN FOR is. A corridor piece belongs to the road
        // that took it, and plots designed over one mint a plan that can never apply. This mirrors
        // the apply gate exactly — authoring must refuse what apply would refuse, and nothing more,
        // or the tool blocks work the model allows.
        if (!planPool) {
            const takenInputs = liveSelectionFeatures(selection)
                .map(feature => {
                    const props = feature.properties || {};
                    const takers = Array.isArray(props.formedByProposalIds) ? props.formedByProposalIds : [];
                    if (!(props.isCorridor === true || props.isTrack === true || takers.length > 0)) return null;
                    const id = props.parcelId || props.PARCEL_ID || props.id;
                    return id === undefined || id === null ? '' : String(id);
                })
                .filter(id => id !== null);
            if (takenInputs.length) {
                const message = t('reparcellization.modal.takenGroundBlocked',
                    'A land readjustment cannot take ground another proposal already holds. Deselect it, or unapply that proposal first.');
                if (typeof updateStatus === 'function') updateStatus(message);
                try {
                    if (typeof window.showEphemeralMessage === 'function') {
                        window.showEphemeralMessage(message, 8000, 'warning');
                    }
                } catch (_) { }
                console.warn('[reparcellization] ground already taken in the selection —', takenInputs);
                return false;
            }
        }

        if (!planPool && !validateSelection(selection)) {
            if (typeof updateStatus === 'function') {
                const message = t(
                    'status.messages.select_at_least_one_parcel_before_running_reparcellization',
                    'Select at least one parcel before running reparcellization.'
                );
                updateStatus(message);
            }
            return false;
        }
        // The plan-geometry pool built above wins; otherwise union the live selection.
        const superParcel = planPool || buildSuperParcel(selection);
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
        // One unified land-readjustment method for both single- and multiple-owner
        // selections. ownershipMode is kept only as metadata on the saved plan.
        state.ownershipMode = 'multiple';
        state.cashOfferOverrides = Object.fromEntries((savedPolygons?.length
            ? window.pendingReparcellizationPlan?.ownerShares || [] : [])
            .filter(owner => !owner.noOwner && Number.isFinite(owner.cashOffer) && owner.cashOffer >= 0)
            .map(owner => [owner.ownerKey, window.ReparcellizationDeal.netCash(owner)]));
        state.algorithm = options.algorithm || 'sweep-line';
        state.initialPolygons = (Array.isArray(options.initialPolygons) && options.initialPolygons.length)
            ? JSON.parse(JSON.stringify(options.initialPolygons))
            : null;
        // A subdivision reopened without explicit polygons (the create dialog's Edit) restores the
        // pending plan's own plots and algorithm instead of re-running one over the site.
        const pendingSitePlan = state.sitePool && !state.initialPolygons ? window.pendingReparcellizationPlan : null;
        if (pendingSitePlan && Array.isArray(pendingSitePlan.polygons) && pendingSitePlan.polygons.length) {
            state.initialPolygons = JSON.parse(JSON.stringify(pendingSitePlan.polygons));
            if (pendingSitePlan.algorithm) state.algorithm = pendingSitePlan.algorithm;
        }
        // A saved plan whose algorithm this editor does not know is hand-authored ground, not an
        // algorithm's output — an imported UPU carries its own provenance ('upu-plan'), and an
        // unknown key left the chooser with NOTHING selected and no editable mode. Manual is what
        // such a plan actually is: plots you edit by hand. Known algorithms keep their mode, so a
        // sweep-line plan can still be re-cut from its handle.
        if (state.initialPolygons && !getAlgorithmOptionByKey(state.algorithm)) {
            console.debug('[reparcellization] unknown saved algorithm — opening the plan in manual',
                { savedAlgorithm: state.algorithm, plots: state.initialPolygons.length });
            state.algorithm = 'manual';
        }
        state.totalArea = computeFeatureArea(superParcel);
        const session = buildModalStructure();
        if (!session || !initMap()) {
            session?.close?.();
            state.session = null;
            state.modal = null;
            state.map = null;
            return false;
        }
        await refreshPreview();
        updateApprovalRow();
        // Manual IS the node/edge system — there are not two manual modes, one with handles and
        // one without. Draw-plot and split-with-line are tools used inside it.
        // The handles are the editor: they are on from the start in every layout, so a boundary
        // can be grabbed without first finding the right tool.
        if (EDITABLE_ALGORITHMS.includes(state.algorithm)) toggleNodeEditing(true);
        // Baseline for "did anything change?" — taken AFTER the opening layout is generated, so
        // simply opening and closing is never treated as unsaved work.
        state.session?.fitFeature?.(state.superParcel, { maxZoom: 21 });
        state.hasFitBounds = true;
        state.openSignature = layoutSignature();
        if (state.historyCtl) state.historyCtl.clear();
        updateUndoAffordance();
        return true;
    }

    if (typeof window.pendingReparcellizationPlan === 'undefined') {
        window.pendingReparcellizationPlan = null;
    }
    window.openReparcellizationModal = openReparcellizationModal;
})();
