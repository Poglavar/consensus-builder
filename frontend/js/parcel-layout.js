// The parcel-layout editor ("Lay out parcels"; over a drawn site, "Subdivide"): it redraws the parcel
// borders of a pool of ground and nothing else. Who receives which plot, and on what terms, is decided
// by the agreement that includes the layout (plan-design-agreement.md, "M1 (a) build contract").
// createParcelLayoutEditor() builds one editor with its own state; its collaborators are the page's
// globals, read when they are used. The page makes one and exposes it as window.openParcelLayoutEditor;
// node tests require() the factory and make a fresh editor per test (backend/test/helpers/parcel-layout-env.js).
(function attachParcelLayoutEditor(root, createParcelLayoutEditor) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { createParcelLayoutEditor };
        return;
    }
    const editor = createParcelLayoutEditor();
    if (!editor) return;
    if (typeof root.pendingParcelLayout === 'undefined') {
        root.pendingParcelLayout = null;
    }
    root.openParcelLayoutEditor = editor.openParcelLayoutEditor;
})(typeof window !== 'undefined' ? window : globalThis, function createParcelLayoutEditor() {
    const uiState = window.__reparcellizationUiState;
    if (!uiState
        || typeof uiState.resolveDrawShortcut !== 'function'
        || typeof uiState.readjustmentInputFeatures !== 'function') {
        console.error(`[${new Date().toISOString()}] [parcel-layout] UI state helpers are unavailable.`);
        return;
    }
    const { resolveDrawShortcut, readjustmentInputFeatures } = uiState;

    // Every console line of this editor: timestamped and tagged.
    function log(level, message, ...details) {
        console[level](`[${new Date().toISOString()}] [parcel-layout] ${message}`, ...details);
    }

    function liveSelectionFeatures(selection) {
        const { features, missing } = readjustmentInputFeatures(selection, {
            live: window.LiveParcelFabric,
            cadastre: window.CadastralParcelRepository
        });
        return missing.length ? [] : features;
    }

    // Plots are told apart by colour and number only: plot n takes colour n, so the pieces of one cut,
    // which sit next to each other in the list, always differ. Nothing here says who receives a plot.
    const COLOR_PALETTE = [
        '#2E86AB', '#F18F01', '#C73E1D', '#137547', '#7A1CAC',
        '#CC3363', '#3D5A80', '#EE6C4D', '#5C946E', '#8A508F',
        '#FF7F11', '#1B998B', '#ED254E', '#3772FF', '#78290F'
    ];

    function plotColor(index) {
        return COLOR_PALETTE[Math.abs(index) % COLOR_PALETTE.length];
    }

    // The layouts that are regenerated from their settings (the count and the sweep handle, the
    // Schelling plan): the first hand edit turns either into a drawn layout (adoptLayoutForEditing).
    const AUTOMATIC_ALGORITHMS = ['equal', 'schelling'];
    // How a plot was made, as the record names it (plan-design-agreement.md, "M1 (a) build contract").
    const PLOT_SOURCES = new Set(['equal', 'schelling', 'schelling-remainder', 'amend', 'manual', 'base', 'geojson', 'form']);
    // Equal plots: how many the count field allows.
    const PLOT_COUNT = Object.freeze({ min: 2, max: 64 });

    function clampPlotCount(value) {
        const count = Math.round(Number(value));
        if (!Number.isFinite(count)) return PLOT_COUNT.min;
        return Math.min(PLOT_COUNT.max, Math.max(PLOT_COUNT.min, count));
    }

    const state = {
        modal: null,
        session: null,
        map: null,
        previewLayer: null,
        boundaryLayer: null,
        statusEl: null,
        algorithm: 'equal',
        // Equal plots: how many (PLOT_COUNT); the sweep handle sets the direction they run in.
        plotCount: PLOT_COUNT.min,
        countEl: null,
        // Schelling plots: the code of the Schelling plan they were taken from (schelling-grid.js).
        schellingCode: null,
        selection: null,
        superParcel: null,
        totalArea: 0,
        // Keep existing borders: the input parcels, kept on the record so a reopened layout still
        // knows the borders it started from.
        amendInputs: [],
        slices: [],
        hasFitBounds: false,
        escHandler: null,
        commitBtns: [],
        subtitleEl: null,
        subtitleData: null,
        // A saved layout's plots[] to restore instead of re-running its layout. Set by
        // openParcelLayoutEditor({ initialPlots }), used when a design draft is reopened. Consumed once
        // by refreshPreview().
        initialPlots: null,
        // Draw freely continues from the plots on the map (see the layout switch).
        carrySlices: null,
        // The building-block chooser of the courtyard tool, while it is open.
        choicePopup: null,
        newPlotsListEl: null,
        // The New and Old plots tables are object lists (ObjectList handles), and the plot their
        // hovered or pressed row lights up on the map (an index into slices, or null).
        newPlotsList: null,
        oldPlotsList: null,
        shownSlice: null,
        // Inputs vs outputs. 'new' edits the layout over a faint underlay of the parcels it replaces;
        // 'old' shows those parcels alone and read-only — the cadastre is a given here.
        oldPlotsListEl: null,
        plotsTabBtns: [],
        plotsTab: 'new',
        inputLayer: null,
        inputHighlightLayer: null,
        nodeEditWasActive: false,
        // True when the input parcels could not all be resolved and the pool outline had to be
        // derived from the layout's own plots — a weaker guarantee, disclosed rather than hidden.
        poolFromOutputs: false,
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
            statusText: null, keyHandler: null, zoomHandler: null
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
        // Before/after swipe comparison (a second "before" map clipped by a slider).
        compareBtn: null,
        compare: { active: false, session: null, map2: null },
        // Footprints of applied building proposals overlapping the pool, shown as a
        // guide layer so the layout can be aligned to planned buildings.
        buildingFootprintLayer: null,
        // Node/edge editing of the plot boundaries (plot-topology.js). `nodes` holds the current
        // topology so a drag knows which plots a handle belongs to.
        nodeEdit: { active: false, topology: null, layer: null, boundaryIndex: null, focusRemove: null },
        // Undo stack for layout edits (Cmd/Ctrl+Z). Each entry is a snapshot of the plots taken
        // BEFORE a mutating action, so undo restores the state the user last saw rather than an
        // intermediate drag frame.
        historyCtl: null,
        // Set for the duration of an open, so a second click cannot start a second editor.
        opening: false,
        // A subdivision (PARCEL-OPTIONAL.md phase 4): the pool is a drawn site, partly or wholly
        // open ground. { site, boundParcelIds, pool } — pool is proposals/subdivision.js sitePool():
        // the bound parcels' parts and the open ground.
        sitePool: null
    };

    function subdivisionApi() {
        return window.__subdivision || null;
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

    // The subtitle names the layout and the ground it redraws ("Equal plots · 3 parcels"). The
    // parcel count is a nested translation reference, so it picks its own plural form.
    function updateSubtitle() {
        if (!state.subtitleEl || !state.subtitleData) return;
        const params = {
            algorithm: state.subtitleData.algorithmLabel || '',
            parcels: { key: 'reparcellization.modal.parcelCount', count: state.subtitleData.parcelCount || 0 }
        };
        state.subtitleEl.textContent = t('reparcellization.modal.subtitle', '{{algorithm}} · {{parcels}}', params);
        try {
            state.subtitleEl.setAttribute('data-i18n-params', JSON.stringify(params));
        } catch (_) {
            state.subtitleEl.removeAttribute('data-i18n-params');
        }
    }

    // The layouts a parcel layout can start from. Each one can be edited by hand afterwards.
    function getAlgorithmOptions() {
        const schellingReady = !!(window.SchellingGrid && window.SchellingSettings);
        return [
            {
                key: 'equal',
                label: t('parcelLayout.editor.algorithms.equal', 'Equal plots'),
                disabled: false
            },
            {
                key: 'schelling',
                label: t('parcelLayout.editor.algorithms.schelling', 'Schelling plots'),
                disabled: !schellingReady,
                title: schellingReady ? '' : t('parcelLayout.editor.schellingUnavailable', 'The Schelling plan has not loaded.')
            },
            {
                key: 'amend',
                label: t('parcelLayout.editor.algorithms.amend', 'Keep existing borders'),
                // Open ground has no borders to keep.
                disabled: !!state.sitePool
            },
            {
                key: 'manual',
                label: t('reparcellization.modal.algorithms.manual', 'Draw freely'),
                disabled: false
            }
        ];
    }

    function getAlgorithmOptionByKey(key) {
        return getAlgorithmOptions().find(option => option.key === key);
    }

    function buildAlgorithmRadios(selectedKey = 'equal') {
        const options = getAlgorithmOptions();
        return options.map(option => {
            const checked = option.key === selectedKey ? 'checked' : '';
            const disabled = option.disabled ? 'disabled' : '';
            const title = option.title ? ` title="${escapeHtml(option.title)}"` : '';
            // A segmented control around native radios (css/primitives.css); reparcel-alg-option is
            // the hook the tests click.
            return `
                <label class="cb-segmented__option reparcel-alg-option"${title}>
                    <input type="radio" name="reparcel-algorithm" value="${option.key}" ${checked} ${disabled}>
                    <span>${option.label}</span>
                </label>`;
        }).join('');
    }

    // The number of equal plots, beside the layouts. It belongs to Equal plots and is shown only
    // while that is the layout (updateCountField).
    function plotCountFieldHtml() {
        return `
                        <label class="reparcel-count-field" data-parcel-layout-count-field>
                            <span>${t('parcelLayout.editor.plotCount', 'Number of plots')}</span>
                            <input type="number" class="reparcel-count-input" data-parcel-layout-count min="${PLOT_COUNT.min}" max="${PLOT_COUNT.max}" step="1" inputmode="numeric" value="${state.plotCount}">
                        </label>`;
    }

    function updateCountField() {
        const field = state.modal && state.modal.querySelector('[data-parcel-layout-count-field]');
        if (field) field.hidden = state.algorithm !== 'equal';
        if (state.countEl) state.countEl.value = String(state.plotCount);
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
            ? (state.drawing.mode === 'line'
                ? t('reparcellization.modal.drawLine', 'Draw a line')
                : t('reparcellization.modal.drawPlot', 'Draw plot'))
            : state.erase.active
                ? t('reparcellization.modal.eraseEdge', 'Erase a boundary')
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

    function closeChoicePopup() {
        if (!state.choicePopup) return;
        const popup = state.choicePopup;
        state.choicePopup = null;
        try { state.map?.closePopup(popup); } catch (_) { }
    }

    function destroyMap() {
        exitCompare();
        closeChoicePopup();
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
    // what "has anything changed?" is measured against. Geometry only: that is all this editor
    // edits. Taken after the initial layout is generated, so merely opening is never "dirty".
    function layoutSignature() {
        try {
            return JSON.stringify({
                algorithm: state.algorithm,
                slices: (state.slices || []).map(s => ({
                    g: s?.geometry || null,
                    s: s?.source || null,
                    d: s?.derivation || null
                }))
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
        const message = t('parcelLayout.editor.discardMessage',
            'The edits you made here have not been saved to the design. Closing now discards them.');
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
            && window.getActiveProposalDesignDraft?.()?.goal === 'parcel-layout') {
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
        if (state.escHandler) {
            window.removeEventListener('keydown', state.escHandler);
            state.escHandler = null;
        }
        state.amendInputs = [];
        state.slices = [];
        state.carrySlices = null;
        state.selection = null;
        state.superParcel = null;
        state.totalArea = 0;
        state.commitBtns = [];
        state.countEl = null;
        state.schellingCode = null;
        state.openSignature = null;
        clearNodeHandles();
        clearInputHighlight();
        if (state.inputLayer) { try { state.inputLayer.remove(); } catch (_) { } state.inputLayer = null; }
        state.plotsTab = 'new';
        state.plotsTabBtns = [];
        state.oldPlotsListEl = null;
        state.newPlotsList?.unbind(); state.oldPlotsList?.unbind();
        state.newPlotsList = state.oldPlotsList = state.shownSlice = null;
        state.nodeEditWasActive = false;
        state.poolFromOutputs = false;
        state.sitePool = null;
        state.nodeEdit.active = false;
        state.nodeEdit.topology = null;
        state.nodeEdit.boundaryIndex = null;
        if (state.historyCtl) { state.historyCtl.destroy(); state.historyCtl = null; }
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
        const algorithmOption = getAlgorithmOptionByKey(state.algorithm) || getAlgorithmOptionByKey('equal');
        const subtitleParams = {
            algorithm: algorithmOption.label,
            parcels: { key: 'reparcellization.modal.parcelCount', count: parcelCount }
        };
        // A subdivision is titled with the site tool's own word for it.
        const titleText = state.sitePool
            ? t('siteTool.palette.subdivide', 'Subdivide')
            : t('parcelLayout.editor.title', 'Lay out parcels');
        const subtitleText = t('reparcellization.modal.subtitle', '{{algorithm}} · {{parcels}}', subtitleParams);
        const doneLabel = t('reparcellization.modal.done', 'Done');
        const cancelLabel = t('reparcellization.modal.cancel', 'Cancel');
        // The drawing tools are icon buttons: the label is the accessible name and the tooltip.
        const tool = (attrs, key, fallback, icon) => {
            const label = t(key, fallback);
            return `<button type="button" class="btn btn-icon" ${attrs} title="${label}" aria-label="${label}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
        };
        const uploadLabel = t('reparcellization.modal.uploadGeojson', 'Upload GeoJSON');
        const downloadLabel = t('reparcellization.modal.downloadGeojson', 'Download plots as GeoJSON');

        const algorithmControls = `
                    <fieldset class="reparcel-controls" data-reparcel-alg-group aria-label="${t('reparcellization.modal.layoutTitle', 'Starting layout')}" aria-disabled="false">
                      <div class="reparcel-secondary-controls" data-reparcel-secondary-controls>
                        <div class="cb-segmented reparcel-alg-options" role="radiogroup" aria-label="${t('reparcellization.modal.layoutTitle', 'Starting layout')}">${buildAlgorithmRadios(state.algorithm)}</div>
                        ${plotCountFieldHtml()}
                        <div class="reparcel-courtyard-tools" data-reparcel-courtyard-tools hidden>
                            <span class="reparcel-courtyard-label">${t('parcelLayout.editor.courtyard', 'Courtyard')}</span>
                            <button type="button" class="btn" data-reparcel-courtyard-building>${t('reparcellization.modal.courtyardFromBuilding', 'From a building block')}</button>
                            <p class="reparcel-courtyard-hint">${t('parcelLayout.editor.courtyardHint', 'Carves the inner courtyard of a planned building block out as a plot of its own.')}</p>
                        </div>
                        <div class="reparcel-edit-tools">
                            <div class="reparcel-legend-actions">
                                ${tool('data-reparcel-draw aria-pressed="false"', 'reparcellization.modal.drawPlot', 'Draw plot', 'fa-draw-polygon')}
                                ${tool('data-reparcel-line aria-pressed="false"', 'reparcellization.modal.drawLine', 'Draw a line', 'fa-slash')}
                                ${tool('data-reparcel-erase aria-pressed="false"', 'reparcellization.modal.eraseEdge', 'Erase a boundary', 'fa-eraser')}
                                ${tool('data-reparcel-nodes aria-pressed="false"', 'reparcellization.modal.editNodes', 'Edit boundaries (nodes)', 'fa-bezier-curve')}
                                <label class="btn btn-icon" title="${uploadLabel}">
                                    <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
                                    <input type="file" accept=".geojson,.json,application/geo+json,application/json" data-reparcel-upload aria-label="${uploadLabel}" hidden>
                                </label>
                                <button type="button" class="btn btn-icon" data-reparcel-download title="${downloadLabel}" aria-label="${downloadLabel}"><i class="fa-solid fa-download" aria-hidden="true"></i></button>
                            </div>
                        </div>
                      </div>
                      <div class="reparcel-persistent-controls">
                          ${tool('data-reparcel-undo-edit disabled', 'reparcellization.modal.undoEdit', 'Undo (Cmd/Ctrl+Z)', 'fa-rotate-left')}
                          ${tool('data-reparcel-redo-edit disabled', 'reparcellization.modal.redoEdit', 'Redo', 'fa-rotate-right')}
                      </div>
                      <div class="reparcel-draw-toolbar" data-reparcel-draw-toolbar hidden>
                          <button type="button" class="btn btn-sm" data-reparcel-undo>${t('reparcellization.modal.drawUndo', 'Undo point')} (U)</button>
                          <button type="button" class="btn btn-sm btn-success" data-reparcel-finish>${t('reparcellization.modal.drawFinish', 'Finish plot')} (F)</button>
                          <button type="button" class="btn btn-sm" data-reparcel-cancel-draw>${t('reparcellization.modal.drawCancel', 'Cancel')} (C)</button>
                      </div>
                    </fieldset>`;

        // The layout's output and its input: the plots it draws, and the parcels it redraws. Old plots
        // is a READ-ONLY view — the cadastre is the given, not something this editor edits.
        const sidePanel = `<section class="reparcel-legend-panel">
                            <div class="cb-tabs reparcel-plots-tabs" role="tablist">
                                <button type="button" role="tab" class="cb-tab" data-reparcel-plots-tab="new" aria-selected="true">${t('reparcellization.modal.newPlots', 'New plots')}</button>
                                <button type="button" role="tab" class="cb-tab" data-reparcel-plots-tab="old" aria-selected="false">${t('reparcellization.modal.oldPlots', 'Old plots')}</button>
                            </div>
                            <div class="reparcel-newplots-list" data-reparcel-newplots-table></div>
                            <div class="reparcel-oldplots-list" data-reparcel-oldplots-table hidden></div>
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
            owner: 'parcel-layout',
            reserveToolsSpace: true,
            id: window.getActiveProposalDesignDraft?.()?.id || 'parcel-layout',
            title: titleText,
            content,
            footer,
            tools,
            modes: ['2d'],
            hints: { '2d': t('parcelLayout.editor.mapHint', 'Draw the plots here. Who receives which plot is decided later, in the agreement.') },
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
        state.newPlotsListEl = root.querySelector('[data-reparcel-newplots-table]');
        state.oldPlotsListEl = root.querySelector('[data-reparcel-oldplots-table]');
        bindPlotLists();
        state.plotsTabBtns = Array.from(root.querySelectorAll('[data-reparcel-plots-tab]'));
        state.plotsTabBtns.forEach(btn => {
            btn.addEventListener('click', () => setPlotsTab(btn.getAttribute('data-reparcel-plots-tab')));
        });
        state.coverageEl = root.querySelector('[data-reparcel-coverage]');
        state.nodesBtn = root.querySelector('[data-reparcel-nodes]');
        state.undoEditBtn = root.querySelector('[data-reparcel-undo-edit]');
        state.redoEditBtn = root.querySelector('[data-reparcel-redo-edit]');
        state.drawBtn = root.querySelector('[data-reparcel-draw]');
        state.courtyardToolsEl = root.querySelector('[data-reparcel-courtyard-tools]');
        root.querySelector('[data-reparcel-courtyard-building]').addEventListener('click', openBuiltFormPicker);
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
        state.countEl = root.querySelector('[data-parcel-layout-count]');
        // A typed count takes effect when it is committed (Enter, leaving the field, the arrows),
        // not on every keystroke: "12" must not lay out one plot first.
        state.countEl.addEventListener('change', () => setPlotCount(state.countEl.value));
        updateCountField();

        const commitBtns = Array.from(root.querySelectorAll('[data-reparcel-commit]'));
        state.commitBtns = commitBtns;

        // X and Cancel are the same act: discard and leave (with a warning when there is work).
        const cancelBtn = root.querySelector('[data-reparcel-cancel]');
        if (cancelBtn) cancelBtn.addEventListener('click', () => { cancelModal(); });
        commitBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                if (!persistResult()) return;
                closeModal({ skipPersist: true });
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(t('parcelLayout.editor.saved', 'Saved the parcel layout to this design.'), 4000, 'success');
                }
            });
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
                // Draw freely starts from what is on the map: switching used to wipe the layout down
                // to one plot, so the first step of hand editing was redoing the automatic split by
                // hand. Erase boundaries to start over.
                state.carrySlices = option.key === 'manual' && state.slices.length
                    ? JSON.parse(JSON.stringify(state.slices))
                    : null;
                state.algorithm = option.key;
                state.subtitleData.algorithmLabel = option.label;
                updateSubtitle();
                updateCountField();
                // The sweep orientation point only belongs to equal plots.
                if (option.key !== 'equal') {
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
                    toggleNodeEditing(true);
                }).catch(error => log('error', `switching to the ${option.key} layout failed`, error));
            });
        }

        if (state.nodesBtn) {
            state.nodesBtn.addEventListener('click', () => toggleNodeEditing());
        }
        const history = ensureHistory();
        if (history) {
            // One shortcut and one button, both owned by the shared module.
            history.bindKeyboard(window, { enabled: () => state.plotsTab !== 'old' });
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

        // The plots as they stand, in the shape Upload GeoJSON reads back.
        root.querySelector('[data-reparcel-download]')?.addEventListener('click', () => {
            const plots = window.DesignFileExports.plotsGeoJson(state.slices.map(slice => slice.geometry));
            window.FileDownload.save(window, JSON.stringify(plots, null, 2) + '\n', 'parcel-layout-plots.geojson', 'application/geo+json');
        });
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

    // A new number of equal plots. With Equal plots as the layout it re-slices the pool, as one undo
    // step; otherwise it is remembered for when Equal plots is chosen.
    function setPlotCount(value) {
        const count = clampPlotCount(value);
        if (state.countEl) state.countEl.value = String(count);
        if (count === state.plotCount) return false;
        if (state.algorithm !== 'equal') {
            state.plotCount = count;
            return false;
        }
        exitCompare(); // editing exits before/after
        cancelDraw();
        const next = computeEqualSlices(count);
        if (!next.length) {
            if (state.countEl) state.countEl.value = String(state.plotCount);
            setStatus(t('reparcellization.modal.status.splitFailed', 'Failed to split the parcel geometry.'), 'error',
                'reparcellization.modal.status.splitFailed');
            return false;
        }
        pushHistory();   // the layout and the count before the change
        state.plotCount = count;
        state.slices = next;
        updateLegend();
        try {
            drawPreview();
        } finally {
            renderNodeHandles();
        }
        if (state.erase.active) renderEraseLayer();
        return true;
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
            if (state.algorithm === 'equal') {
                initSweepOrientation();
                updateSweepDirLine();
            }
        });
        return true;
    }

    function formatArea(area) {
        return CbFormat.formatArea(Number.isFinite(area) ? area : 0);
    }

    // The cadastral parcel a live parcel came from, when the fabric knows it (several joined by '+'
    // for a parcel formed from more than one); null for ground without cadastral provenance.
    function cadastreIdOf(parcelId, selection) {
        if (selection?.source === 'cadastre') return String(parcelId);
        const fabric = window.LiveParcelFabric;
        if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') return null;
        const ids = fabric.cadastreIdsForParcelIds([parcelId]).map(String).filter(Boolean).sort();
        return ids.length ? ids.join('+') : null;
    }

    // Keep existing borders: every input parcel is a plot.
    function buildAmendSlices() {
        if (!state.amendInputs.length) {
            state.amendInputs = liveSelectionFeatures(state.selection).map(feature => {
                const parcelId = String(feature.properties.parcelId);
                const cadastreParcelId = cadastreIdOf(parcelId, state.selection);
                return {
                    parcelId,
                    ...(cadastreParcelId ? { cadastreParcelId } : {}),
                    geometry: JSON.parse(JSON.stringify(feature.geometry)),
                    label: String(feature.properties.BROJ_CESTICE || parcelId),
                    area: computeFeatureArea(feature)
                };
            });
        }
        return state.amendInputs.map(input => makePlot(JSON.parse(JSON.stringify(input.geometry)), 'amend'));
    }

    // A building block's inner courtyard, carved out of the layout as a plot of its own. The plot
    // keeps a `derivation` naming the block it came from; who shares it is the agreement's business.
    function applyCourtyard(courtyard, derivation) {
        cancelDraw();
        toggleEraseMode(false);
        pushHistory();
        // Clip the building's courtyard to this pool; a building may span a larger block.
        const carved = carvePlotIntoPlan(courtyard, 'form', { derivation });
        if (carved !== 'carved') {
            discardLastHistory();
            if (carved === 'outside') {
                setStatus(t('reparcellization.modal.status.courtyardError', 'Could not carve the courtyard. The layout has been kept.'), 'error');
            }
            return;
        }
        // Carving subtracts the courtyard from its neighbours; give them the corners it introduced.
        conformLayout();
        updateLegend();
        drawPreview();
        renderNodeHandles();
        setStatus(t('parcelLayout.editor.status.courtyardCarved', 'Courtyard carved out as a plot of its own.'), 'info');
    }

    function openBuiltFormPicker() {
        if (state.algorithm !== 'amend') return;
        let candidates;
        try {
            const proposals = typeof proposalStorage !== 'undefined' ? proposalStorage.getAllProposals() : [];
            candidates = window.ReparcellizationPlanUtils.buildingCourtyardCandidates(proposals, state.superParcel, turf);
        } catch (error) {
            log('error', 'building courtyard lookup failed', error);
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
        closeChoicePopup();
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
                closeChoicePopup();
                applyCourtyard(entry.courtyard, entry.derivation);
            });
            container.appendChild(button);
        }
        const popup = L.popup({ maxWidth: 320 })
            .setLatLng(state.map.getCenter()).setContent(container);
        popup.on('remove', () => { if (state.choicePopup === popup) state.choicePopup = null; });
        state.choicePopup = popup.openOn(state.map);
    }

    // The layout against the geometry rules (parcel-layout-validation.js), the same ones the design
    // draft checks: the plots tile the pool. A subdivision tiles its site.
    function validateLayout(plan = currentPlan()) {
        return window.ParcelLayoutValidation.validate(plan, {
            turf, ...(state.sitePool ? { site: state.sitePool.site } : {})
        });
    }

    // One validation error in the viewer's language; the module's English message is the fallback.
    function validationText(error) {
        return t(`parcelLayout.editor.validation.${error.code}`, error.message, {
            plot: Number.isInteger(error.plotIndex) ? error.plotIndex + 1 : '',
            area: Number.isFinite(error.areaM2) ? formatArea(error.areaM2) : '',
            min: formatArea(window.ParcelLayoutValidation.MIN_PLOT_AREA_M2),
            max: window.ParcelLayoutValidation.MAX_PLOTS
        });
    }

    // Done follows the geometry rules alone, and the coverage line says why when it is held back.
    function updateCommitState() {
        const validation = validateLayout();
        ensureCommitAvailability(validation.valid);
        // NO auto-persist here. This used to write the layout to the draft on every state change —
        // every drawn plot, every edit — which made the editor a live writer rather than a
        // workspace: Cancel had nothing left to discard, because the edits were already saved.
        // Only the Done button persists now.
        if (!state.coverageEl) return validation;
        if (!state.slices.length) {
            state.coverageEl.textContent = '';
            state.coverageEl.removeAttribute('data-state');
            return validation;
        }
        if (validation.valid) {
            state.coverageEl.setAttribute('data-state', 'ok');
            state.coverageEl.textContent = t('parcelLayout.editor.coverageComplete',
                'The plots cover the whole pool ({{area}}).', { area: formatArea(validation.metrics.poolAreaM2) });
        } else {
            state.coverageEl.setAttribute('data-state', 'warn');
            state.coverageEl.textContent = [...new Set(validation.errors.map(validationText))].join(' ');
        }
        return validation;
    }

    // The New and Old plots tables are object lists (docs/design-language.md, "Object lists"):
    // hovering or focusing a row lights its plot or parcel up on the map, which shows that one plot
    // can be several disjoint pieces; a click keeps it lit (the row's number pressed) until it is
    // clicked again. Both lie in the pool the editor frames, and nothing opens from them.
    function bindPlotLists() {
        const ObjectList = window.ObjectList;
        const pick = row => row.querySelector('.reparcel-plot-pick');
        if (state.newPlotsListEl) {
            state.newPlotsList = ObjectList.bind(state.newPlotsListEl, {
                item: 'tr.reparcel-newplot-row', keyOf: row => row.dataset.plotIndex ?? null, pressed: pick,
                show: key => showSlice(Number(key)), restore: () => showSlice(null)
            });
        }
        if (state.oldPlotsListEl) {
            state.oldPlotsList = ObjectList.bind(state.oldPlotsListEl, {
                item: 'tr.reparcel-oldplot-row', keyOf: row => row.dataset.parcelIndex ?? null, pressed: pick,
                show: key => highlightInputParcel(inputParcelFeatures()[Number(key)], true),
                restore: clearInputHighlight
            });
        }
    }

    // Lights one plot up (an index into slices) and puts the one lit before back; null lets go.
    function showSlice(index) {
        if (state.shownSlice !== null) highlightSlice(state.shownSlice, false);
        state.shownSlice = Number.isInteger(index) && index >= 0 && index < state.slices.length ? index : null;
        if (state.shownSlice !== null) highlightSlice(state.shownSlice, true);
    }

    // The table's number of a row: the button that presses it.
    function plotPickHtml(label) {
        return `<button type="button" class="btn btn-quiet btn-sm reparcel-plot-pick" aria-pressed="false"><strong>${label}</strong></button>`;
    }

    // The New plots list: each plot's number (the one drawn on it) and its area.
    function updateLegend() {
        if (state.newPlotsListEl) {
            state.newPlotsListEl.innerHTML = '';
            if (state.slices.length) {
                const table = document.createElement('table');
                table.className = 'reparcel-newplots-table';
                const thead = document.createElement('thead');
                thead.innerHTML = `<tr>
                    <th class="reparcel-col--plot">${t('reparcellization.modal.colPlot', 'Plot')}</th>
                    <th class="reparcel-col--figure">${t('reparcellization.modal.colArea', 'Area')}</th>
                </tr>`;
                table.appendChild(thead);
                const tbody = document.createElement('tbody');
                state.slices.forEach((slice, idx) => {
                    const tr = document.createElement('tr');
                    tr.className = 'reparcel-newplot-row';
                    tr.dataset.plotIndex = String(idx);
                    tr.innerHTML = `
                        <td class="plot-cell">${plotPickHtml(idx + 1)}</td>
                        <td class="area-cell">${formatArea(computeGeometryArea(slice.geometry))}</td>`;
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                state.newPlotsListEl.appendChild(table);
            }
            // The rows are new: the pressed plot (if it still exists) stays pressed and lit, a
            // hovered one is let go.
            const pinned = state.newPlotsList?.pinnedKey();
            showSlice(pinned === null || pinned === undefined ? null : Number(pinned));
        }
        updateOldPlotsList();
        updateCommitState();
    }

    // ── Inputs (old plots) ───────────────────────────────────────────────────────────────────────
    // The cadastral parcels that were pooled. Read-only: this editor divides the pool, it does not
    // edit the cadastre. Switching to this view drops the plots back to a faint underlay so the
    // parcels being replaced are what you actually see.

    function inputParcelFeatures() {
        return liveSelectionFeatures(state.selection);
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
            state.nodeEditWasActive = state.nodeEdit.active || state.erase.nodeEditWasActive;
            if (state.erase.active) toggleEraseMode(false);
            if (state.nodeEdit.active) toggleNodeEditing(false);
            if (state.drawing.active) cancelDraw();
        } else if (state.nodeEditWasActive) {
            state.nodeEditWasActive = false;
            toggleNodeEditing(true);
        }
        // Native fieldset disabling removes every edit control from keyboard interaction while
        // retaining each child's own validity/history disabled state for the new-plots view.
        const editControls = state.modal?.querySelector('[data-reparcel-alg-group]');
        if (editControls) {
            editControls.disabled = next === 'old';
            editControls.setAttribute('aria-disabled', String(next === 'old'));
        }
        (state.modal ? [state.modal] : []).forEach(el => el.classList.toggle('reparcel-old-plots-view', next === 'old'));
        // A row pressed in the table being left lets go: the other view shows other shapes.
        state.newPlotsList?.reset(); state.oldPlotsList?.reset();
        state.shownSlice = null;
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
            empty.textContent = t('parcelLayout.editor.oldPlotsMissing',
                'The input parcels could not be loaded, so the pool outline is taken from the layout itself.');
            state.oldPlotsListEl.appendChild(empty);
            return;
        }
        const table = document.createElement('table');
        table.className = 'reparcel-newplots-table reparcel-oldplots-table';
        const thead = document.createElement('thead');
        thead.innerHTML = `<tr>
            <th>${t('reparcellization.modal.colParcel', 'Parcel')}</th>
            <th class="reparcel-col--figure">${t('reparcellization.modal.colArea', 'Area')}</th>
        </tr>`;
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        features.forEach((feature, index) => {
            const tr = document.createElement('tr');
            tr.className = 'reparcel-oldplot-row';
            tr.dataset.parcelIndex = String(index);
            const area = computeFeatureArea(feature);
            tr.innerHTML = `
                <td class="plot-cell">${plotPickHtml(escapeHtml(inputParcelLabel(feature)))}</td>
                <td class="area-cell">${formatArea(area)}</td>`;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        state.oldPlotsListEl.appendChild(table);
        const pinned = state.oldPlotsList?.pinnedKey();
        if (pinned === null || pinned === undefined) clearInputHighlight();
        else highlightInputParcel(features[Number(pinned)], true);
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
                log('warn', 'failed to compute the projected centroid; falling back to turf', err);
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

    // ── Plot partition helpers (non-overlap invariant) ───────────────────
    // Every piece of pooled land belongs to exactly one resultant plot. New
    // plots (drawn or imported) are clipped to the pool and subtracted from any
    // plot they overlap, so the plot set always stays a clean partition.

    // A plot of the layout: its geometry, how it was made (`source`, one of PLOT_SOURCES) and, for a
    // carved courtyard, what it was derived from. Nothing about who receives it.
    function makePlot(geometry, source, derivation) {
        return {
            geometry,
            source: PLOT_SOURCES.has(source) ? source : 'manual',
            ...(derivation ? { derivation: JSON.parse(JSON.stringify(derivation)) } : {})
        };
    }

    // Rebuild the editor's plots from a saved layout's plots[] — the inverse of currentPlan(). A
    // shared layout is untrusted input: only the geometry, a known source and the derivation are read.
    function hydratePlots(plots) {
        if (!Array.isArray(plots)) return [];
        return plots
            .filter(plot => plot && plot.geometry)
            .map(plot => makePlot(JSON.parse(JSON.stringify(plot.geometry)), plot.source, plot.derivation));
    }

    // Carve a polygon into the current layout: clip to the pool, subtract it from every overlapping
    // plot, then add it as a new plot. Returns 'carved', 'outside' (it does not reach the pool) or
    // 'refused' (the result would not tile the pool; the status says why). The layout is only
    // replaced on 'carved'.
    // flags.checkTiling false: the caller checks the finished result once (an import of many
    // polygons, which checked the whole layout after every one and stalled at 1,000).
    function carvePlotIntoPlan(polygonFeature, source, flags = {}) {
        if (typeof turf === 'undefined' || !state.superParcel) return 'refused';
        const next = window.ReparcellizationPlanUtils.carveLayout({
            pool: state.superParcel, slices: state.slices, polygon: polygonFeature,
            source, derivation: flags.derivation
        }, turf);
        if (!next) return 'outside';
        const problem = flags.checkTiling === false ? null : tilingProblem(null, next.map(slice => slice.geometry), { pool: state.superParcel });
        if (problem) {
            setStatus(refusalText(problem), 'error');
            return 'refused';
        }
        state.slices = next.map(slice => makePlot(slice.geometry, slice.source, slice.derivation));
        return 'carved';
    }

    // Every edit owns its result: it leaves the plots tiling the land they held, or it is not made.
    // Nothing repairs a layout after an edit; plot-edit.js says whether an edit broke it. Returns
    // null when the edit is sound, else the check, which the caller turns into a refusal.
    function tilingProblem(previous, next, options) {
        const edit = window.__plotEdit;
        if (!edit || typeof turf === 'undefined') throw new Error('plot-edit.js and turf are required to check a plot edit');
        const check = edit.checkTiling(previous, next, { turf }, options);
        if (check.ok) return null;
        log('error', 'edit refused: the plots would not tile their land', {
            folded: check.folded, overlaps: check.overlaps, gapM2: Math.round(check.gap),
            outsideM2: Math.round(check.outside), overlapM2: Math.round(check.overlap)
        });
        return check;
    }

    function refusalText(check) {
        return check.folded.length
            ? t('reparcellization.modal.status.editFolds', 'Not changed: that would fold a plot over itself or over a neighbour.')
            : t('reparcellization.modal.status.editBreaksTiling', 'Not changed: that would leave land with no plot, or in two plots.');
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
        log('debug', 'layout conformed', { verticesAdded: added, plots: state.slices.length });
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

    // Commit a cut. Pieces inherit the source (and derivation) of the plot they were cut from; a plot
    // the cut only NODED (a neighbour across a T-junction) keeps its identity and just gains the vertex.
    function applyCutResult(result) {
        const groups = new Map();
        (result.results || []).forEach(entry => {
            if (!entry || !entry.geometry) return;
            if (!groups.has(entry.sourceIndex)) groups.set(entry.sourceIndex, []);
            groups.get(entry.sourceIndex).push(entry.geometry);
        });
        // `previous` lines up with the NEW plot list, so the check covers only the plots the cut
        // reached: the first piece of a split inherits its parent, the rest held nothing before,
        // and the parent is counted once against pieces that must add back up to it.
        const next = [];
        const previous = [];
        state.slices.forEach((slice, index) => {
            const pieces = groups.get(index);
            if (!pieces || !pieces.length) { next.push({ slice, geometry: slice.geometry }); previous.push(slice.geometry); return; }
            if (pieces.length === 1) {
                next.push({ slice, geometry: pieces[0] });
                previous.push(slice.geometry);
                return;
            }
            pieces.forEach((geometry, position) => {
                next.push({ parent: slice, geometry });
                previous.push(position === 0 ? slice.geometry : null);
            });
        });
        const problem = tilingProblem(previous, next.map(entry => entry.geometry));
        if (problem) {
            setStatus(refusalText(problem), 'error');
            return false;
        }
        state.slices = next.map(entry => {
            if (entry.slice) { entry.slice.geometry = entry.geometry; return entry.slice; }
            return makePlot(entry.geometry, entry.parent.source, entry.parent.derivation);
        });
        updateLegend();
        try {
            drawPreview();
        } finally {
            renderNodeHandles();
        }
        return true;
    }


    // ── Manual plot drawing ──────────────────────────────────────────────

    // Every layout shares the same drawing and boundary tools.
    // Point the starting-layout control (and the subtitle) at `key` without recomputing the
    // layout. Used when an edit or an undo changes which kind of layout is on the map.
    function setAlgorithmKey(key) {
        const option = getAlgorithmOptionByKey(key);
        if (!option) return;
        state.algorithm = option.key;
        if (option.key === 'equal') initSweepOrientation();
        else destroySweepOrientation();
        const radio = state.modal && state.modal.querySelector(`input[name="reparcel-algorithm"][value="${option.key}"]`);
        if (radio) radio.checked = true;
        if (state.subtitleData) state.subtitleData.algorithmLabel = option.label;
        updateSubtitle();
        updateCountField();
        updateDrawToolButtons();
        updateActiveModeHint();
    }

    // An automatic layout is regenerated from its settings (the count and the sweep handle, the
    // Schelling plan), so a hand edit cannot live inside it. Instead of refusing the edit, the first
    // one turns the automatic layout into a drawn one ("Draw freely") with the same plots; undo
    // turns it back.
    function adoptLayoutForEditing() {
        if (!AUTOMATIC_ALGORITHMS.includes(state.algorithm)) return false;
        setAlgorithmKey('manual');
        log('debug', 'automatic layout adopted for hand editing', { plots: state.slices.length });
        return true;
    }

    // Every layout can be edited by hand (the first edit of an automatic one adopts it), so the
    // tools are always available; only the courtyard tool belongs to Keep existing borders.
    function updateDrawToolButtons() {
        if (state.courtyardToolsEl) state.courtyardToolsEl.hidden = state.algorithm !== 'amend' || state.plotsTab === 'old';
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
            if (!applyCutResult(result)) {
                discardLastHistory();
                return;
            }
            log('debug', 'cut', {
                ends: (result.ends || []).map(end => end.kind),
                crossings: (result.crossings || []).length,
                nodesAdded: result.nodesAdded,
                plotsAdded: result.added,
                plotsNow: state.slices.length
            });
            setStatus(t('parcelLayout.editor.status.cutSuccess',
                'Line drawn — {{plots}} new plot(s), {{nodes}} new node(s).',
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
        const carved = carvePlotIntoPlan(polygon, 'manual');
        cancelDraw();
        if (carved !== 'carved') {
            if (carved === 'outside') {
                setStatus(t('reparcellization.modal.status.drawNoOverlap', 'The drawn plot is outside the pooled land.'), 'error');
            }
            discardLastHistory();
            return;
        }
        adoptLayoutForEditing();
        // Carving subtracts the new plot from whatever it overlapped, which leaves the neighbours
        // without the corners it just introduced — the same non-conforming borders the line tool
        // is careful not to make. Node them; no land moves.
        conformLayout();
        setStatus(t('parcelLayout.editor.status.drawSuccess', 'Plot added.'), 'info');
        updateLegend();
        drawPreview();
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

    function startDraw(mode) {
        if (!state.map) return;
        exitCompare(); // editing and before/after are mutually exclusive
        closeChoicePopup();
        toggleEraseMode(false);
        state.drawing.active = true;
        state.drawing.mode = mode === 'line' ? 'line' : 'polygon';
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
        setStatus(state.drawing.mode === 'line'
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
        return !!(window.__plotTopology && window.__plotCut && state.map && state.slices.length);
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
            closeChoicePopup();
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
        log('debug', 'boundary erased', { plots: group.plots, plotsNow: state.slices.length });
        // The graph has changed under the layer, so it is rebuilt rather than patched — which also
        // shows the merged plot's remaining boundaries immediately.
        renderEraseLayer();
    }

    // ── GeoJSON Upload ──────────────────────────────────────────────────

    function handleGeojsonUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (evt) {
            let geojson = null;
            try {
                geojson = JSON.parse(evt.target.result);
            } catch (err) {
                log('warn', 'GeoJSON parse error', err);
                setStatus(
                    t('reparcellization.modal.status.uploadParseError', 'Failed to parse GeoJSON file.'),
                    'error'
                );
                return;
            }
            const features = geojson?.type === 'FeatureCollection' && Array.isArray(geojson.features)
                ? geojson.features
                : geojson?.type === 'Feature'
                    ? [geojson]
                    : (geojson?.type === 'Polygon' || geojson?.type === 'MultiPolygon')
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
        };
        reader.readAsText(file);
    }

    // The file is a whole layout: the pool goes back to one base plot and each imported polygon is
    // carved into it in order. carvePlotIntoPlan clips to the pool and subtracts overlaps, so the
    // result is a clean partition even if the file's polygons overlap each other; land the import
    // does not cover stays as one leftover plot. It is one undo step, and a file that misses the
    // pool entirely leaves the layout as it was.
    function applyUploadedGeometry(features) {
        const maxPlots = window.ParcelLayoutValidation.MAX_PLOTS;
        if (features.filter(feature => /^(Polygon|MultiPolygon)$/.test(feature?.geometry?.type || '')).length > maxPlots) {
            setStatus(t('parcelLayout.editor.status.uploadTooMany', 'Use at most {{count}} polygons in one layout.', { count: maxPlots }), 'error');
            return;
        }
        if (typeof turf === 'undefined') {
            setStatus(t('parcelLayout.editor.status.uploadUnavailable', 'GeoJSON upload needs the geometry engine, which has not loaded.'), 'error');
            return;
        }
        exitCompare(); // editing exits before/after
        cancelDraw();
        toggleEraseMode(false);
        pushHistory();
        const previous = state.slices;
        state.slices = [makePlot(state.superParcel.geometry, 'base')];
        let added = 0;
        const started = Date.now();
        features.forEach(feature => {
            const geomType = feature && feature.geometry && feature.geometry.type;
            if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') return;
            if (carvePlotIntoPlan(feature, 'geojson', { checkTiling: false }) === 'carved') added++;
        });
        // The whole import is one edit: it tiles the pool, or the layout stays as it was.
        const problem = added ? tilingProblem(null, state.slices.map(slice => slice.geometry), { pool: state.superParcel }) : null;
        log('debug', 'import carved', { polygons: added, plots: state.slices.length, ms: Date.now() - started });
        if (problem) {
            state.slices = previous;
            discardLastHistory();
            setStatus(refusalText(problem), 'error');
            return;
        }
        if (!added) {
            state.slices = previous;
            discardLastHistory();
            setStatus(
                t('reparcellization.modal.status.uploadNoOverlap', 'Uploaded polygons do not overlap with selected parcels.'),
                'error'
            );
            return;
        }
        // An imported layout is drawn, not generated: the sweep handle or the plan would replace it.
        if (state.algorithm !== 'manual') setAlgorithmKey('manual');
        conformLayout();
        updateLegend();
        try {
            drawPreview();
        } finally {
            renderNodeHandles();
        }
        setStatus(
            t('reparcellization.modal.status.uploadSuccess', 'Loaded {{count}} polygons from file.', { count: added }),
            'info'
        );
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
    // courtyard, upload, a new number of equal plots. Snapshots are taken BEFORE the action, so Cmd/Ctrl+Z restores what
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
                // The first hand edit of an automatic layout turns it into a drawn one; undoing
                // that edit has to give the automatic layout (its count, its sweep handle, its
                // Schelling plan) back.
                algorithm: state.algorithm,
                plotCount: state.plotCount,
                schellingCode: state.schellingCode,
                sweep: state.sweepHandle ? [state.sweepHandle.getLatLng().lat, state.sweepHandle.getLatLng().lng] : null
            }),
            restore: (snapshot, direction) => {
                state.slices = snapshot.slices;
                state.plotCount = snapshot.plotCount;
                state.schellingCode = snapshot.schellingCode;
                if (snapshot.algorithm && snapshot.algorithm !== state.algorithm) setAlgorithmKey(snapshot.algorithm);
                updateCountField();
                if (snapshot.sweep && state.sweepHandle) {
                    state.sweepHandle.setLatLng(snapshot.sweep);
                    updateSweepDirLine();
                }
                closeChoicePopup();
                updateLegend();
                drawPreview();
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
        // thousands of square metres between plots; it used to do that with nothing on screen to
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
            hint.textContent = t('parcelLayout.editor.edgeHint',
                'Drag it to move this segment. Erasing it joins the two plots into one.');
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

    // What removing this node would do, in the layout's own terms. Runs the removal on a COPY and
    // measures it, so the popup cannot describe one thing while the button does another: both go
    // through classifyNodeRemoval, and the numbers come from the edit itself rather than an
    // estimate of it.
    function describeNodeRemoval(node, topology) {
        const topo = window.__plotTopology;
        const edit = window.__plotEdit;
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
        // Measured on the removal itself, which is exactly what the button commits: dropping a
        // vertex hands one plot's triangle to the other.
        const shift = (edit && typeof edit.areaShift === 'function')
            ? edit.areaShift(before, result.geometries, { turf }) : { moved: 0, perPlot: [] };
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
        // every plot in that plan belonged to the same body, so the owner name identified nothing.
        const nameOf = index => plotLabel(index);
        if (description.kind === 'merge') {
            return t('parcelLayout.editor.nodeRemoveMerges',
                'Removing it merges {{joining}} into {{keeper}}, which gains {{moved}} m².',
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
            const text = t('parcelLayout.editor.status.nodeOnPool',
                'That node sits on the pool outline: it belongs to the neighbours, not to this layout.');
            setStatus(text, 'warning', 'parcelLayout.editor.status.nodeOnPool');
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
    // same bend and stay in step, and the plots still tile the pool.
    function removeNodePerRing(node, topology) {
        const topo = window.__plotTopology;
        const result = topo.removeNode(state.slices, topology, node.id, { dissolveDegenerate: true });
        log('debug', 'straighten', {
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
            // still the right gesture; the land stays with the plots on either side of the line.
            return removeNodePerRing(node, topology);
        }

        const merged = mergePlots(Array.from(members));
        if (!merged) return false;
        log('debug', 'boundary dissolved', {
            node: node.coord, mergedPlots: members.size, plotsNow: state.slices.length
        });
        return true;
    }

    // Merge several plots into one. Union rather than re-derive: the surviving outline is made of
    // the plots' own coordinates, so no vertex moves and none is invented. The union is the shared
    // clip (parcel-arrangement.js clipWith), on the grid the plots are saved on; a union it cannot do
    // merges nothing rather than dropping a plot. Shared by node removal (dissolve the boundary a
    // node anchored) and by the eraser (dissolve the boundary itself).
    function mergePlots(plotIndices) {
        if (typeof turf === 'undefined') return false;
        const indices = Array.from(new Set(plotIndices || []))
            .filter(index => state.slices[index] && state.slices[index].geometry)
            .sort((a, b) => a - b);
        if (indices.length < 2) return false;

        const wrap = geometry => ({ type: 'Feature', properties: {}, geometry });
        let merged = null;
        try {
            indices.forEach(index => {
                const geometry = state.slices[index].geometry;
                merged = merged ? layoutClip(turf, 'union', wrap(merged), wrap(geometry), 'parcel-layout.mergePlots')?.geometry || null : geometry;
                if (!merged) throw new Error('the union of the plots is empty');
            });
        } catch (error) {
            log('warn', 'plots could not be merged', { plots: indices, error: error && error.message });
            return false;
        }

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
        updateLegend();
        try {
            drawPreview();
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
        // The edit owns its result. Moving, inserting or removing a shared node keeps the plots
        // tiling by itself; a drag across a neighbour's boundary folds a plot, and that is refused
        // here — the handles go back where they were — rather than repaired.
        const problem = tilingProblem(state.slices.map(slice => slice.geometry), geometries);
        if (problem) {
            setStatus(refusalText(problem), 'warning');
            try {
                drawPreview();
            } finally {
                renderNodeHandles();
            }
            return false;
        }
        pushHistory();   // the pre-edit layout, captured before the assignment below
        adoptLayoutForEditing();
        const dissolved = [];
        state.slices.forEach((slice, idx) => {
            const geometry = geometries[idx];
            if (geometry === undefined) return;
            if (!geometry) { dissolved.push(idx); return; }
            slice.geometry = geometry;
            slice.source = 'manual';
        });
        // A plot whose land has all gone to its neighbours is no longer a plot. Dropping it keeps
        // the list honest — a 0 m² row that cannot be seen on the map is not a parcel.
        if (dissolved.length) {
            for (let i = dissolved.length - 1; i >= 0; i--) state.slices.splice(dissolved[i], 1);
        }
        updateLegend();
        // The handles describe the plots. If a redraw throws halfway, the handles must not be left
        // floating over shapes that are no longer there — that is the "stars orphaned on the map,
        // node and warning left behind, lines gone" state. Rebuild them whatever happens.
        try {
            drawPreview();
        } finally {
            renderNodeHandles();
        }
        return true;
    }

    function computeGeometryArea(geometry) {
        if (!geometry) return 0;
        try {
            return turf.area({ type: 'Feature', properties: {}, geometry });
        } catch (_) { return 0; }
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

    // Equal plots: the pool cut into `count` strips of equal area, oriented toward the sweep point
    // (parcel-layout-layouts.js equalPlots; the slicing itself is reparcellization-slice.js).
    function computeEqualSlices(count = state.plotCount) {
        if (!state.superParcel) return [];
        const pivot = getSuperParcelCentroidLngLat(state.superParcel);
        return window.ParcelLayoutLayouts.equalPlots(state.superParcel, count, getSweepBearing(), pivot, {
            turf, computeFeatureArea, ReparcellizationSlice: window.ReparcellizationSlice
        }).map(plot => makePlot(plot.geometry, plot.source));
    }

    // The Schelling plan at the pool, with the plan layer's current settings: schelling-layer.js keeps
    // them, remembered per viewer, whether the layer is shown or not.
    function schellingPlanForPool() {
        const settingsApi = window.SchellingSettings;
        const current = window.SchellingLayer?.settings?.();
        const settings = settingsApi.normalize(current && Object.keys(current).length ? current : settingsApi.DEFAULTS);
        const centre = getSuperParcelCentroidLngLat(state.superParcel);
        if (!centre) throw new RangeError('The pool has no centre to take the Schelling plan at.');
        return { plan: window.SchellingGrid.planFor({ ...settings, lat: centre[1] }), level: settings.plotLevel };
    }

    // Schelling plots: the plan's plots clipped to the pool, and the pool ground they leave (the
    // street strips) as plots too, so the layout tiles the pool (parcel-layout-layouts.js).
    function computeSchellingSlices() {
        const { plan, level } = schellingPlanForPool();
        const result = window.ParcelLayoutLayouts.schellingPlots(state.superParcel, plan, level, {
            turf, computeFeatureArea, SchellingGrid: window.SchellingGrid
        });
        state.schellingCode = result.code;
        log('debug', 'Schelling plots laid out', {
            code: result.code, plots: result.plots.length,
            remainders: result.plots.filter(plot => plot.source === 'schelling-remainder').length
        });
        return result.plots.map(plot => makePlot(plot.geometry, plot.source));
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
        state.slices = computeEqualSlices();
        updateLegend();
        drawPreview();
    }

    function initSweepOrientation() {
        if (!state.map || state.algorithm !== 'equal') return;
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
    // The main map shows the "after" plots. A second map showing the "before"
    // original parcels is stacked on top and clipped by a draggable divider.
    // The main map is frozen while comparing so the two views stay aligned;
    // exiting restores normal pan/zoom and editing.

    // The input parcels, each in its own colour, for the before map.
    function buildBeforeFeatureCollection() {
        const features = liveSelectionFeatures(state.selection).map((feature, index) => ({
            type: 'Feature', properties: { color: plotColor(index) }, geometry: feature.geometry
        }));
        return { type: 'FeatureCollection', features };
    }

    // The before map (ui/map-before-after.js) shows the input parcels inside the pool outline; the
    // live map, with its plots, is "after".
    function enterCompare() {
        if (!state.map || state.compare.active || !state.slices.length) return;
        cancelDraw();
        closeChoicePopup();
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
        if (state.compareBtn) state.compareBtn.setAttribute('aria-pressed', 'true');
    }

    function exitCompare() {
        if (!state.compare.active) return;
        state.compare.session?.dispose();
        state.compare.session = null;
        state.compare.map2 = null;
        state.compare.active = false;
        if (state.compareBtn) state.compareBtn.setAttribute('aria-pressed', 'false');
    }

    function toggleCompare() {
        if (state.compare.active) {
            exitCompare();
        } else if (state.slices.length) {
            enterCompare();
        }
    }

    // A plot's Leaflet style: its own colour (plotColor), with the boundary carrying hover and the
    // highlight of its row in the New plots list. A plot is a shape, not a box: the browser's focus
    // ring is drawn around the path's bounding box and reads as a stray rectangle.
    function plotStyle(index, mode = 'idle') {
        const hovered = mode === 'hover';
        const highlighted = mode === 'highlight';
        return {
            color: highlighted ? '#111' : (hovered ? '#2563EB' : '#333'),
            weight: highlighted ? 4 : (hovered ? 3 : 1),
            fillOpacity: highlighted ? 0.8 : (hovered ? 0.65 : 0.55),
            fillColor: plotColor(index),
            dashArray: null
        };
    }

    // The label's radius in metres at the current zoom: the 22 px badge plus a little air.
    function plotLabelRadiusM() {
        const zoom = state.map?.getZoom?.();
        const lat = state.map?.getCenter?.()?.lat;
        if (!(typeof zoom === 'number' && Number.isFinite(zoom) && typeof lat === 'number' && Number.isFinite(lat))) return 1;
        return 14 * 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    }

    function clearPlotNumbers() {
        if (state.plotNumberLayer) {
            try { state.plotNumberLayer.remove(); } catch (_) { }
            state.plotNumberLayer = null;
        }
        if (state.plotNumberZoomHandler && state.map) state.map.off('zoomend', state.plotNumberZoomHandler);
        state.plotNumberZoomHandler = null;
    }

    // The New plots list numbers its rows; the same numbers on the map say which row is which plot.
    // Each number sits in the clearest spot of its plot (reparcel-label-point.js): away from the
    // edges and nodes, then off the faint old-parcel and building outlines. How much room the badge
    // needs depends on the zoom, so the numbers move again after a zoom.
    function drawPlotNumbers() {
        clearPlotNumbers();
        if (!state.map || !state.slices.length || state.plotsTab === 'old') return;
        const guides = inputParcelFeatures().concat(collectAppliedBuildingFootprints()).map(feature => feature.geometry).filter(Boolean);
        const radiusM = plotLabelRadiusM();
        const markers = state.slices.map((slice, idx) => {
            const point = window.ReparcelLabelPoint.labelPoint(slice.geometry, { guides, radiusM });
            if (!point) return null;
            return L.marker([point[1], point[0]], {
                pane: 'reparcelPlots',
                interactive: false,
                keyboard: false,
                icon: L.divIcon({ className: 'reparcel-plot-number', html: String(idx + 1), iconSize: [22, 22] })
            });
        }).filter(Boolean);
        state.plotNumberLayer = L.layerGroup(markers).addTo(state.map);
        state.plotNumberZoomHandler = () => drawPlotNumbers();
        state.map.on('zoomend', state.plotNumberZoomHandler);
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
                    layer.setStyle(plotStyle(sliceIndex, 'highlight'));
                    if (typeof layer.bringToFront === 'function') layer.bringToFront();
                } else {
                    layer.setStyle(plotStyle(sliceIndex));
                }
            }
            layerIndex++;
        });
    }

    // Footprints of applied building proposals that overlap the pool. window.proposedBuildings
    // holds GeoJSON footprint Features (lng/lat) for applied/executed building proposals;
    // they are shown over the pool so they can guide the layout.
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
        // reference — you are editing the layout, not them — and in the old-plots view they are the
        // subject, so they carry the labels and the weight.
        drawInputParcels();

        if (state.slices.length && state.plotsTab === 'old') {
            // Old-plots view: the layout is context only. Faint, non-interactive, no hover — nothing
            // here is editable, and offering the affordance would lie.
            state.previewLayer = L.geoJSON(
                { type: 'FeatureCollection', features: state.slices.map(slice => ({ type: 'Feature', properties: {}, geometry: slice.geometry })) },
                { style: { color: '#6b7280', weight: 1, opacity: 0.5, fillOpacity: 0.05, fillColor: '#6b7280' }, interactive: false, pane: 'reparcelPlots' }
            ).addTo(state.map);
        } else if (state.slices.length) {
            const collection = {
                type: 'FeatureCollection',
                features: state.slices.map((slice, idx) => ({
                    type: 'Feature',
                    properties: { sliceIndex: idx },
                    geometry: slice.geometry
                }))
            };
            state.previewLayer = L.geoJSON(collection, {
                pane: 'reparcelPlots',
                style: feature => plotStyle(feature.properties.sliceIndex),
                onEachFeature: (feature, layer) => {
                    const idx = feature.properties.sliceIndex;
                    layer.__reparcelSliceIndex = idx;
                    layer.bindTooltip(escapeHtml(t('parcelLayout.editor.plotTooltip', 'Plot {{n}} · {{area}}', {
                        n: idx + 1, area: formatArea(computeGeometryArea(feature.geometry))
                    })), { sticky: true, className: 'reparcel-slice-tooltip' });
                    // A click on a plot belongs to this editor, not to the app's map below it (which
                    // would select a parcel); while drawing it must reach the map, where vertices go.
                    layer.on('click', (e) => {
                        if (state.drawing.active || state.erase.active) return;
                        L.DomEvent.stopPropagation(e);
                    });
                    layer.on('mouseover', () => {
                        // No plot tooltip or hover while drawing, splitting, erasing or comparing:
                        // the plot is not what is being pointed at.
                        if (state.drawing.active || state.compare.active || state.erase.active) {
                            layer.closeTooltip();
                            return;
                        }
                        layer.setStyle(plotStyle(idx, 'hover'));
                        if (typeof layer.bringToFront === 'function') layer.bringToFront();
                    });
                    layer.on('mouseout', () => layer.setStyle(plotStyle(idx)));
                }
            }).addTo(state.map);
            // The plot a New plots row lights up stays lit across the redraw.
            if (state.shownSlice !== null) highlightSlice(state.shownSlice, true);
        }

        // The pool outline, in red and heavy: it is the one line in this editor that cannot be
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
                catch (err) { log('warn', 'failed to fit the map to the pool', err); }
            }
            state.hasFitBounds = true;
        }

        drawPlotNumbers();

        // Building-footprint guide on top of the plots (outlines guide the layout).
        drawBuildingFootprints();

        // Keep the sweep direction line visible above the freshly re-added slices.
        if (state.sweepHandle) updateSweepDirLine();
    }

    // The parcel-layout record (plan-design-agreement.md, "M1 (a) build contract"): the pool and its
    // plots, geometry only. Owners, shares, money and approval belong to the agreement.
    function currentPlan() {
        return {
            algorithm: state.algorithm,
            generatedAt: new Date().toISOString(),
            // The exact ground this layout redraws. Parent cadastral parcels can be only partially
            // involved (a road may already own the rest), so their whole union is not always the
            // boundary. Persisting the pool prevents a later edit from resurrecting those outside
            // remainders as thick-red-outline slivers.
            pool: state.superParcel ? JSON.parse(JSON.stringify(state.superParcel.geometry)) : null,
            // A subdivision's pool is its site (bound parcels' part + open ground): the editor and
            // the coverage checks reopen it from the site, never from a parcel selection.
            ...(state.sitePool ? {
                poolSource: 'site',
                openGroundM2: Math.round(state.sitePool.pool.openGroundM2 * 100) / 100
            } : {}),
            totalArea: state.totalArea,
            ...(state.algorithm === 'equal' ? { plotCount: state.plotCount } : {}),
            ...(state.algorithm === 'schelling' && state.schellingCode ? { schelling: { code: state.schellingCode } } : {}),
            // The borders this layout keeps, so a reopened layout starts from the same ones after the
            // layout has replaced them on the map.
            ...(state.algorithm === 'amend' ? { inputParcels: JSON.parse(JSON.stringify(state.amendInputs)) } : {}),
            plots: state.slices.map(slice => ({
                geometry: JSON.parse(JSON.stringify(slice.geometry)),
                area: computeGeometryArea(slice.geometry),
                source: slice.source || 'manual',
                ...(slice.derivation ? { derivation: JSON.parse(JSON.stringify(slice.derivation)) } : {})
            }))
        };
    }

    // Done: the record goes to window.pendingParcelLayout and to the active design draft
    // (editorPayload.plan). The hand-off also carries the input parcels as `parcelIds`, the draft's
    // selection; that is draft state, never part of the record (the adapter drops it on serialize).
    function persistResult() {
        const plan = currentPlan();
        const validation = validateLayout(plan);
        if (!state.slices.length || !validation.valid) {
            updateCommitState();
            return false;
        }
        const payload = { ...plan, parcelIds: (state.selection?.ids || []).map(String) };
        window.pendingParcelLayout = payload;
        if (typeof window.syncActiveProposalDraftFromEditor === 'function') {
            window.syncActiveProposalDraftFromEditor('parcel-layout', payload, {
                coalesceKey: 'parcel-layout-design'
            });
        }
        ensureCommitAvailability(true);
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
            log('warn', 'failed to compute a feature area', error);
            return 0;
        }
    }

    // A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
    function layoutArrangement() {
        return (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
    }

    function layoutClipFailure(operation, error, site, operands) {
        const api = layoutArrangement();
        return api ? api.clipFailure(operation, error, { site }, operands) : error;
    }

    // The shared parcel clip (parcel-arrangement.js clipWith): the same grid as every other stage;
    // a clip it cannot do throws a ClipFailure naming `site`.
    function layoutClip(t, operation, a, b, site) {
        return layoutArrangement().clipWith(t, operation, a, b, { site });
    }

    async function refreshPreview() {
        setStatus(
            t('parcelLayout.editor.status.preparing', 'Preparing the layout…'),
            'info',
            'parcelLayout.editor.status.preparing'
        );
        ensureCommitAvailability(false);
        if (!state.totalArea) {
            state.totalArea = computeFeatureArea(state.superParcel);
        }

        // Restore a saved layout instead of re-running it, which would throw away its hand-drawn
        // plots. Consumed once: switching the layout inside the editor still recomputes, as it should.
        const seededPlots = state.initialPlots;
        state.initialPlots = null;
        if (seededPlots && seededPlots.length) {
            // The sweep handle drives the orientation UI, so it still has to exist for an equal
            // layout the user may want to re-cut.
            if (state.algorithm === 'equal') initSweepOrientation();
            state.slices = hydratePlots(seededPlots);
            if (state.slices.length) {
                setStatus('', 'info');
                updateLegend();
                drawPreview();
                return;
            }
        }

        if (state.algorithm === 'equal') {
            initSweepOrientation();
            state.slices = computeEqualSlices();
            if (state.slices.length) {
                setStatus('', 'info');
            } else {
                setStatus(
                    t('reparcellization.modal.status.splitFailed', 'Failed to split the parcel geometry.'),
                    'error',
                    'reparcellization.modal.status.splitFailed'
                );
            }
        } else if (state.algorithm === 'schelling') {
            try {
                state.slices = computeSchellingSlices();
                setStatus(t('parcelLayout.editor.status.schellingLaidOut',
                    'Plots of Schelling plan {{code}}. The street strips between them are plots too.',
                    { code: state.schellingCode }), 'info');
            } catch (error) {
                // The plan refuses ground it cannot lay out (too large a pool, streets wider than a
                // block, beyond its latitudes): say so and leave Done off.
                if (!(error instanceof RangeError)) throw error;
                log('warn', 'Schelling plots could not be laid out', error.message);
                state.slices = [];
                setStatus(t('parcelLayout.editor.status.schellingFailed',
                    'Schelling plots could not be laid out here: {{reason}}', { reason: error.message }), 'error');
            }
        } else if (state.algorithm === 'amend') {
            state.slices = buildAmendSlices();
            setStatus(t('parcelLayout.editor.status.amendHint',
                'The existing parcels are the plots. Carve a courtyard or edit the boundaries.'), 'info');
        } else {
            const carried = state.carrySlices;
            state.carrySlices = null;
            if (Array.isArray(carried) && carried.length) {
                // Continue from the layout that was on the map (see the layout switch).
                state.slices = carried;
                setStatus(
                    t('reparcellization.modal.status.manualFromLayout',
                        'Drawing freely from the current layout. Drag nodes or whole boundary segments, cut with the line tool, or click a boundary to erase it.'),
                    'info',
                    'reparcellization.modal.status.manualFromLayout'
                );
            } else {
                // Nothing to continue from: the undivided pool as one plot.
                state.slices = [makePlot(state.superParcel.geometry, 'base')];
                setStatus(
                    t('parcelLayout.editor.status.manualHint', 'Draw plots on the map, or cut the pool with the line tool.'),
                    'info',
                    'parcelLayout.editor.status.manualHint'
                );
            }
        }
        updateLegend();
        drawPreview();
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

    // A parcel layout is a GEOMETRICAL FACT: the ground it covers is the union of its own plots, and
    // its cadastral parents follow from that geometry. So a saved layout can always be reopened,
    // whatever the map is currently showing — its source parcels are routinely consumed and hidden
    // under the applied layout, and requiring live layers made "Edit geometry" impossible on exactly
    // the layouts most worth editing.
    function buildPoolFromPlots(plots, parcelIds) {
        const t = (typeof turf !== 'undefined') ? turf : null;
        if (!t || !Array.isArray(plots) || !plots.length) return null;
        const features = plots
            .map(p => (p && p.geometry) ? { type: 'Feature', properties: {}, geometry: p.geometry } : null)
            .filter(Boolean);
        if (!features.length) return null;
        // A pool with a plot silently left out of it is not the layout's ground: refuse instead.
        let union = features[0];
        for (let i = 1; i < features.length; i++) {
            const merged = layoutClip(t, 'union', union, features[i], 'parcel-layout.buildPoolFromPlots');
            if (!merged) throw layoutClipFailure('union', new Error('union came back empty'), 'parcel-layout.buildPoolFromPlots', [union, features[i]]);
            union = merged;
        }
        if (!union || !union.geometry) return null;
        return {
            type: 'Feature',
            properties: { parcelIds: (Array.isArray(parcelIds) ? parcelIds.slice() : []) },
            geometry: union.geometry
        };
    }

    // The parcels a saved layout was made from: the ids its opener declares with the seed
    // (window.pendingParcelLayout.parcelIds, the design draft's selection). The current map
    // selection is consulted only when nothing is declared — "what happens to be selected" is not
    // an input.
    function declaredLayoutParcelIds(fallbackSelection) {
        const seed = window.pendingParcelLayout;
        if (seed && Array.isArray(seed.parcelIds) && seed.parcelIds.length) {
            return seed.parcelIds.map(String);
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
                log('warn', 'loading the layout\'s cadastral ground failed', error);
            }
        }
        return readjustmentInputFeatures({ ids, source: 'cadastre' }, {
            cadastre: window.CadastralParcelRepository
        });
    }

    // `options` = { algorithm?, initialPlots?, pool?, sitePool?, plotCount? }: initialPlots reopens
    // the editor on a saved layout's plots instead of re-running its layout. One editor at a time.
    //
    // A second editor opens directly over the first, and because the module keeps ONE state object
    // the older editor's buttons stay wired to a torn-down editor: visible, enabled, and doing
    // nothing when clicked. That is indistinguishable from a broken tool — a symptom this editor
    // has already been debugged for twice.
    //
    // The latch has to be set SYNCHRONOUSLY. Checking `state.modal` alone does not work: opening
    // awaits the input parcels before it builds anything, so two clicks in the same tick both sail
    // past a guard that only looks at what has been built.
    async function openParcelLayoutEditor(options = {}) {
        if (state.opening || (state.modal && document.contains(state.modal))) {
            log('warn', 'the editor is already open; ignoring a second request');
            return false;
        }
        state.opening = true;
        try {
            return await buildEditor(options);
        } finally {
            state.opening = false;
        }
    }

    // A pending layout pooled from a site (poolSource 'site'): its site is the saved pool, its bound
    // parcels the seed's own list or else the design draft's binding/declaration. The layout's saved
    // open-ground area guards the fallback (buildSitePool).
    function sitePoolOfPendingLayout() {
        const seed = window.pendingParcelLayout;
        if (!seed || seed.poolSource !== 'site' || !seed.pool) return null;
        let ids = Array.isArray(seed.parcelIds) ? seed.parcelIds.map(String) : null;
        if (!ids || !ids.length) {
            const draft = typeof window.getActiveProposalDesignDraft === 'function' ? window.getActiveProposalDesignDraft() : null;
            const fields = (draft && draft.fields) || {};
            const bound = fields.binding && Array.isArray(fields.binding.parcels)
                ? fields.binding.parcels.map(hit => String(hit && hit.parcelId || '')).filter(Boolean) : [];
            ids = bound.length ? bound : (Array.isArray(fields.cadastreParcelIds) ? fields.cadastreParcelIds.map(String) : []);
        }
        return {
            site: seed.pool,
            boundParcelIds: Array.from(new Set(ids)),
            expectedOpenGroundM2: Number.isFinite(Number(seed.openGroundM2)) ? Number(seed.openGroundM2) : null
        };
    }

    // A subdivision's pool (PARCEL-OPTIONAL.md phase 4): the drawn site, split into the bound
    // parcels' parts (cadastral geometry from the repository — the same source the open-ground
    // host is derived from at apply) and the open ground. Every bound parcel must resolve: a
    // missing one would be counted as open ground, hiding a declared parcel.
    async function buildSitePool(sitePool) {
        const api = subdivisionApi();
        const site = sitePool && sitePool.site;
        if (!api || !site || !/Polygon/.test(String(site.type || ''))) return null;
        const boundIds = (sitePool.boundParcelIds || []).map(String);
        const resolved = boundIds.length ? await resolveInputParcelFeatures(boundIds) : { features: [], missing: [] };
        if (resolved.missing.length) {
            log('warn', 'subdivision: bound parcels not available', resolved.missing);
            return { error: 'missing', missing: resolved.missing };
        }
        const parcels = resolved.features.map(feature => ({
            id: String(feature.properties && (feature.properties.parcelId || feature.properties.id) || ''),
            geometry: feature.geometry
        }));
        // Authoring mirrors apply (apply/parcels.js): ground another design formed on open ground
        // is spoken for, so a subdivision over it would never apply.
        const fabric = window.LiveParcelFabric;
        const ground = window.__openGround;
        const sourceId = window.getActiveProposalDesignDraft?.()?.sourceLocalProposalId;
        if (fabric && typeof fabric.queryBounds === 'function' && ground) {
            const siteFeature = { type: 'Feature', properties: {}, geometry: site };
            const holders = new Set();
            // The site reaches into the piece: the shared rule the apply uses (geometry-tolerances.js).
            fabric.queryBounds(ground.bboxOf(site))
                .filter(feature => ground.groundIdsOf(feature).length && feature.properties && feature.properties.producedByProposalId
                    && String(feature.properties.producedByProposalId) !== String(sourceId || ''))
                .filter(feature => window.GeometryTolerances.reachesInto(turf, siteFeature, feature, 0, { site: 'parcel-layout.openGroundHolders' }))
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
        // The layout saved its open ground. Finding MORE now means bound parcels are missing from
        // the inputs: their ground would be counted as open ground, so refuse rather than open on it.
        const expected = sitePool.expectedOpenGroundM2;
        if (typeof expected === 'number' && Number.isFinite(expected)
            && pool.openGroundM2 > expected + Math.max(1, expected * 0.01)) {
            log('warn', 'subdivision: more open ground than the layout saved — bound parcels missing',
                { saved: expected, now: Math.round(pool.openGroundM2), boundParcelIds: boundIds });
            return { error: 'unavailable' };
        }
        log('debug', 'subdivision pool', {
            siteM2: Math.round(pool.totalAreaM2), boundParcels: pool.parts.length, openGroundM2: Math.round(pool.openGroundM2)
        });
        return {
            site: JSON.parse(JSON.stringify(site)),
            boundParcelIds: boundIds,
            pool
        };
    }

    // The editor will not open, and why: thrown as an 'editor-refused' error whose message the
    // design shell shows instead of its generic "editor is unavailable" (proposal-editor-shell.js).
    function refuseOpen(message) {
        throw Object.assign(new Error(message), { code: 'editor-refused' });
    }

    async function buildEditor(options = {}) {
        let selection = (typeof getCurrentParcelSelectionContext === 'function')
            ? getCurrentParcelSelectionContext()
            : null;
        let planPool = null;
        state.sitePool = null;
        // The opener's seed: a saved layout (pool, plots, inputParcels, poolSource, openGroundM2,
        // plotCount, schelling) and the input parcels it declares (parcelIds).
        const seed = window.pendingParcelLayout || {};

        // Every opener of a subdivision lands here: the draft adapter passes `sitePool`; a seed
        // without one still carries its pool, which IS the site.
        const sitePoolRequest = options.sitePool || sitePoolOfPendingLayout();
        if (sitePoolRequest) {
            const built = await buildSitePool(sitePoolRequest);
            if (!built || built.error) {
                return refuseOpen(built && built.error === 'missing'
                    ? t('reparcellization.modal.siteParcelsMissing', 'The parcels under this site could not be loaded: {{ids}}.', { ids: built.missing.join(', ') })
                    : (built && built.error === 'taken'
                        ? t('reparcellization.modal.siteGroundTaken', 'This site covers ground already formed by another design: {{names}}. Draw the site off it, or unapply that design first.', { names: built.names.map(name => `"${name}"`).join(', ') })
                        : t('reparcellization.modal.siteUnavailable', 'This site cannot be subdivided here.')));
            }
            state.sitePool = built;
            selection = { ids: built.boundParcelIds.slice(), source: 'cadastre' };
            planPool = { type: 'Feature', properties: { parcelIds: built.boundParcelIds.slice() }, geometry: built.pool.pool };
        }

        // Reopening a SAVED layout: the inputs are the parcels the seed DECLARES, full stop.
        //
        // Two things used to go wrong here. A live map selection won, so opening the editor with
        // anything selected pooled *that* instead of the layout's own parents — the subtitle would
        // read "23 parcels" for a 29-parcel layout and coverage would climb past 100%. And when no
        // selection existed the pool was unioned from the layout's OUTPUT plots, which is circular:
        // the boundary became whatever the outputs currently are, so a plot dragged out into empty
        // space silently redefined the pool it was supposed to be constrained by.
        //
        // The pool is the saved pool, else the union of the INPUT parcels. They are only hidden
        // under an applied layout, never gone, so they can be fetched back.
        const savedPlots = (Array.isArray(options.initialPlots) && options.initialPlots.length)
            ? options.initialPlots
            : (Array.isArray(seed.plots) ? seed.plots : null);
        state.amendInputs = savedPlots?.length && Array.isArray(seed.inputParcels)
            ? JSON.parse(JSON.stringify(seed.inputParcels)) : [];
        if (!state.sitePool && savedPlots && savedPlots.length) {
            const planIds = declaredLayoutParcelIds(selection);
            const resolved = planIds.length ? await resolveInputParcelFeatures(planIds) : { features: [], missing: [] };
            const savedPool = options.pool || seed.pool || null;
            const explicitPool = savedPool && /Polygon/.test(String(savedPool.type || ''))
                ? { type: 'Feature', properties: { parcelIds: planIds.slice() }, geometry: JSON.parse(JSON.stringify(savedPool)) }
                : null;
            // The pool of a saved layout that cannot be computed refuses the editor, saying why.
            const poolOrRefuse = (plots) => {
                try { return buildPoolFromPlots(plots, planIds); } catch (error) {
                    if (!error || error.code !== 'clip-failed') throw error;
                    log('error', 'the layout\'s pool could not be computed', error);
                    return refuseOpen(t('reparcellization.modal.poolClipFailed', 'The ground of this plan could not be computed: {{reason}}', { reason: error.message }));
                }
            };
            const inputPool = resolved.features.length && !resolved.missing.length
                ? poolOrRefuse(resolved.features)
                : null;
            if (explicitPool) {
                log('debug', 'pooled from the layout\'s saved pool', { inputs: planIds.length, plots: savedPlots.length });
                planPool = explicitPool;
            } else if (inputPool) {
                log('debug', 'pooled from the layout\'s declared inputs', { inputs: planIds.length, plots: savedPlots.length });
                planPool = inputPool;
            } else if (planIds.length) {
                // Not every input could be resolved. Falling back to the outputs' own outline keeps
                // the layout editable, but the pool is then only as trustworthy as the outputs — say
                // so rather than presenting a derived boundary as if it were the cadastre.
                log('warn', 'could not resolve every input parcel — pooling from the layout geometry instead',
                    { declared: planIds.length, resolved: resolved.features.length, missing: resolved.missing });
                planPool = poolOrRefuse(savedPlots);
                state.poolFromOutputs = true;
            }
            if (planPool) selection = { ids: planIds.slice(), source: 'cadastre' };
        }

        // A layout may be drawn on any ground that is not already taken — the remainders a road
        // left included, which is the whole point of forming blocks with roads and then redividing
        // them (ruling 2026-08-10, replacing the whole-parcel rule of 2026-08-07).
        //
        // Being DERIVED is not the test; being SPOKEN FOR is. A corridor piece belongs to the road
        // that took it, and plots drawn over one make a layout that can never apply. This mirrors
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
                log('warn', 'ground already taken in the selection', takenInputs);
                return refuseOpen(t('parcelLayout.editor.takenGroundBlocked',
                    'A parcel layout cannot redraw ground another design already holds. Deselect it, or unapply that design first.'));
            }
        }

        if (!planPool && !validateSelection(selection)) {
            if (typeof updateStatus === 'function') {
                updateStatus(t('parcelLayout.editor.selectParcels', 'Select at least one parcel to lay out.'));
            }
            return false;
        }
        // The saved or site pool built above wins; otherwise union the live selection.
        const superParcel = planPool || buildSuperParcel(selection);
        if (!superParcel) {
            if (typeof updateStatus === 'function') {
                updateStatus(t('parcelLayout.editor.poolUnavailable', 'The outline of these parcels could not be built.'));
            }
            return false;
        }
        state.selection = selection;
        state.superParcel = superParcel;
        state.algorithm = options.algorithm || 'equal';
        state.initialPlots = (Array.isArray(options.initialPlots) && options.initialPlots.length)
            ? JSON.parse(JSON.stringify(options.initialPlots))
            : null;
        // A subdivision reopened without explicit plots restores the seed's own plots and layout
        // instead of re-running one over the site.
        if (state.sitePool && !state.initialPlots && Array.isArray(seed.plots) && seed.plots.length) {
            state.initialPlots = JSON.parse(JSON.stringify(seed.plots));
            if (seed.algorithm) state.algorithm = seed.algorithm;
        }
        // A saved layout whose algorithm this editor does not know is hand-authored ground, not an
        // algorithm's output (an imported plan carries its own provenance), and an unknown key left
        // the chooser with NOTHING selected and no editable mode. Draw freely is what such a layout
        // actually is. A layout that is not available here (Schelling plots without the plan, Keep
        // existing borders on a site) starts as equal plots instead.
        const option = getAlgorithmOptionByKey(state.algorithm);
        if (!option || (option.disabled && !state.initialPlots)) {
            const fallback = state.initialPlots ? 'manual' : 'equal';
            log('debug', `unknown or unavailable layout — opening as ${fallback}`, { requested: state.algorithm });
            state.algorithm = fallback;
        }
        const inputCount = Array.isArray(selection?.ids) ? selection.ids.length : 0;
        state.plotCount = clampPlotCount(options.plotCount ?? seed.plotCount ?? Math.max(PLOT_COUNT.min, inputCount));
        state.schellingCode = state.initialPlots && seed.schelling?.code ? String(seed.schelling.code) : null;
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
        // Manual IS the node/edge system — there are not two manual modes, one with handles and
        // one without. Draw-plot and split-with-line are tools used inside it.
        // The handles are the editor: they are on from the start in every layout, so a boundary
        // can be grabbed without first finding the right tool.
        toggleNodeEditing(true);
        // Baseline for "did anything change?" — taken AFTER the opening layout is generated, so
        // simply opening and closing is never treated as unsaved work.
        state.session?.fitFeature?.(state.superParcel, { maxZoom: 21 });
        state.hasFitBounds = true;
        state.openSignature = layoutSignature();
        if (state.historyCtl) state.historyCtl.clear();
        updateUndoAffordance();
        // Opened from a block's "Courtyard as a parcel" action (proposal-editor-shell.js): the
        // request is consumed once, whether or not the carve succeeds.
        const courtyardRequest = window.pendingCourtyardLayout;
        window.pendingCourtyardLayout = null;
        if (courtyardRequest) await carveCourtyardOfDesign(courtyardRequest.proposalId);
        return true;
    }

    // Keep the existing borders and carve one building design's courtyard out as a plot of its
    // own. Switching the starting layout is part of opening, not an edit; the carve is (undoable).
    async function carveCourtyardOfDesign(proposalId) {
        const proposal = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(String(proposalId)) : null;
        if (state.algorithm !== 'amend') {
            const option = getAlgorithmOptionByKey('amend');
            if (!option || option.disabled) {
                setStatus(t('parcelLayout.editor.status.courtyardNeedsBorders',
                    'A courtyard can be carved only while keeping the existing borders.'), 'warning');
                return false;
            }
            setAlgorithmKey('amend');
            await refreshPreview();
            state.openSignature = layoutSignature();
        }
        let candidate = null;
        try {
            [candidate] = proposal ? window.ReparcellizationPlanUtils.buildingCourtyardCandidates([proposal], state.superParcel, turf) : [];
        } catch (error) {
            log('error', 'building courtyard lookup failed', error);
        }
        if (!candidate) {
            setStatus(t('reparcellization.modal.status.noBlockProposals',
                'No building block with an enclosed courtyard overlaps these parcels.'), 'warning');
            return false;
        }
        applyCourtyard(candidate.courtyard, candidate.derivation);
        return true;
    }

    // The editor: openParcelLayoutEditor is what the page calls; `state` and every function above
    // are listed so a test can drive this editor's own session and see what it did.
    return {
        state,
        log, liveSelectionFeatures, plotColor, clampPlotCount, subdivisionApi, formatTemplate, t,
        applyTranslations, updateSubtitle, getAlgorithmOptions, getAlgorithmOptionByKey, buildAlgorithmRadios,
        plotCountFieldHtml, updateCountField, setStatus, updateActiveModeHint, closeChoicePopup, destroyMap,
        layoutSignature, isDirty, cancelModal, confirmDiscard, closeModal, buildModalStructure, setPlotCount,
        initMap, formatArea, cadastreIdOf, buildAmendSlices, applyCourtyard, carveCourtyardOfDesign, openBuiltFormPicker,
        validateLayout, validationText, updateCommitState, updateLegend, inputParcelFeatures,
        inputParcelLabel, setPlotsTab, clearInputHighlight, highlightInputParcel, updateOldPlotsList,
        computeRingCentroidAndAreaXY, getSuperParcelCentroidLngLat, makePlot, hydratePlots,
        carvePlotIntoPlan, tilingProblem, refusalText, conformLayout, cutContext, mapScale, applyCutResult,
        setAlgorithmKey, adoptLayoutForEditing, updateDrawToolButtons, setDrawButtonsActive, clearDrawTemp,
        getVertexIcon, updateDrawShape, renderDrawTemp, snapFor, renderDrawGhosts, clearDrawGhosts,
        renderSnapFeedback, snapStatusText, previewLine, updateDrawCursor, onDrawClick, onDrawDblClick,
        onDrawMouseMove, undoLastPoint, updateDrawToolbar, dedupeDrawPoints, onDrawFinish, cutFailureText,
        startDraw, cancelDraw, toggleDrawMode, eraseAvailable, toggleEraseMode, clearEraseLayer,
        eraseTooltipFor, renderEraseLayer, eraseBoundary, handleGeojsonUpload, applyUploadedGeometry,
        ensureHistory, pushHistory, discardLastHistory, updateUndoAffordance, nodeEditingAvailable,
        toggleNodeEditing, clearNodeHandles, anchorsACut, poolBoundaryIndex, renderNodeHandles,
        showNodeMessagePopup, openNodePopup, openEdgePopup, previewGeometries, describeNodeRemoval, plotLabel,
        removalConsequenceText, removeNodeFromLayout, removeNodePerRing, dissolveBoundariesAt, mergePlots,
        applyGeometries, computeGeometryArea, getSweepBearing, computeEqualSlices, schellingPlanForPool,
        computeSchellingSlices, getSweepIcon, updateSweepDirLine, onSweepDrag, initSweepOrientation,
        destroySweepOrientation, buildBeforeFeatureCollection, enterCompare, exitCompare, toggleCompare,
        plotStyle, plotLabelRadiusM, clearPlotNumbers, drawPlotNumbers, highlightSlice,
        collectAppliedBuildingFootprints, drawBuildingFootprints, drawInputParcels, drawPreview, currentPlan,
        persistResult, ensureCommitAvailability, computeFeatureArea, layoutClipFailure, refreshPreview,
        validateSelection, buildSuperParcel, buildPoolFromPlots, declaredLayoutParcelIds,
        resolveInputParcelFeatures, openParcelLayoutEditor, sitePoolOfPendingLayout, buildSitePool,
        refuseOpen, buildEditor
    };
});
