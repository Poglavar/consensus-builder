function showBlockifyModalEditor() {
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
        updateStatus(translateBuildingText('status.messages.no_block_selected', 'No block selected'));
        return false;
    }

    // Store the block globally for the modal
    blockifyBlock = block;
    let initialGeometryError = null;
    if (!blockifyGenerationSite) {
        try {
            blockifyGenerationSite = blockifyAuthoredSite || robustUnion(blockifyFeaturesForBlock(block));
        } catch (error) {
            // Keep the editor available for recovery, but never generate from a partial site.
            // Report the failure once its controls and error dialog are ready below.
            initialGeometryError = error;
        }
    }
    const blockLabel = getBlockifyDisplayName();

    console.log('[Blockify] showBlockifyModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

    // Build the specialized controls, then let the shared editor own the floating panel and map.
    if (!blockifyModal) {
        const container = document.createElement('div');
        container.id = 'blockify-container';

        const algorithmKeys = Object.keys(BLOCKIFY_ALGORITHMS);
        const defaultAlgo = algorithmKeys[0];
        const algorithmOptions = algorithmKeys.map(key => {
            const name = getBlockifyAlgorithmName(key);
            const entry = BLOCKIFY_ALGORITHMS[key];
            const i18nKey = `blockify.modal.algorithms.${entry.key}.name`;
            const selected = key === defaultAlgo ? 'selected' : '';
            return `<option value="${key}" ${selected} data-i18n-key="${i18nKey}">${name}</option>`;
        }).join('');

        const defaultDescKey = `blockify.modal.algorithms.${BLOCKIFY_ALGORITHMS[defaultAlgo].key}.description`;
        const defaultDesc = getBlockifyAlgorithmDescription(defaultAlgo);

        container.innerHTML = `
            <div id="blockify-sidebar">
                <div class="parameter-group blockify-freeform-only">
                    <label for="algorithm-select" data-i18n-key="blockify.modal.algorithmLabel">Algorithm:</label>
                    <select id="algorithm-select" disabled>
                        ${algorithmOptions}
                    </select>
                    <div id="algorithm-description" class="algorithm-description">
                        <span data-i18n-key="${defaultDescKey}">${defaultDesc}</span>
                    </div>
                </div>
                ${window.BuildingDensityStats.cardMarkup('blockify')}
                <div class="parameter-group">
                    <label class="blockify-existing-toggle" for="blockify-existing-toggle">
                        <input type="checkbox" id="blockify-existing-toggle">
                        <span data-i18n-key="blockify.modal.existing.toggle" data-i18n-attr="text">Based on existing buildings</span>
                    </label>
                </div>
                <div class="parameter-group blockify-existing-only" style="display:none">
                    <label class="blockify-rule-label" for="proposed-height-slider">
                        <input type="radio" id="blockify-rule-exact" name="blockify-existing-rule" value="exact" checked>
                        <span data-i18n-key="blockify.modal.existing.proposedHeight" data-i18n-attr="text">Proposed height (storeys):</span>
                        <span id="proposed-height-value">${DEFAULT_PROPOSED_HEIGHT_FLOORS} (${CbFormat.formatLength(DEFAULT_PROPOSED_HEIGHT_FLOORS * DEFAULT_FLOOR_HEIGHT_M)})</span>
                    </label>
                    <input type="range" id="proposed-height-slider" min="1" max="20" value="${DEFAULT_PROPOSED_HEIGHT_FLOORS}" step="1">
                </div>
                <div class="parameter-group blockify-existing-only" style="display:none">
                    <label class="blockify-rule-label" for="additional-floors-slider">
                        <input type="radio" id="blockify-rule-additional" name="blockify-existing-rule" value="additional">
                        <span data-i18n-key="blockify.modal.existing.additionalFloors" data-i18n-attr="text">Additional storeys:</span>
                        <span id="additional-floors-value">${DEFAULT_ADDITIONAL_FLOORS}</span>
                    </label>
                    <input type="range" id="additional-floors-slider" min="1" max="20" value="${DEFAULT_ADDITIONAL_FLOORS}" step="1" disabled>
                </div>
                <div class="parameter-group blockify-existing-only" style="display:none">
                    <label for="floor-height-slider">
                        <span data-i18n-key="blockify.modal.existing.floorHeight" data-i18n-attr="text">Storey height (m):</span>
                        <span id="floor-height-value">${CbFormat.formatNumber(DEFAULT_FLOOR_HEIGHT_M, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="floor-height-slider" min="2.5" max="5" value="${DEFAULT_FLOOR_HEIGHT_M}" step="0.1">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="setback-slider">
                        <span data-i18n-key="blockify.modal.labels.setback" data-i18n-attr="text">Setback (m):</span>
                        <span id="setback-value">${CbFormat.formatNumber(DEFAULT_SETBACK, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="setback-slider" min="0" max="50" value="${DEFAULT_SETBACK}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="chamfer-slider">
                        <span data-i18n-key="blockify.modal.labels.chamfer" data-i18n-attr="text">Chamfer (m):</span>
                        <span id="chamfer-value">${CbFormat.formatNumber(currentChamferM, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="chamfer-slider" min="0" max="10" value="${DEFAULT_CHAMFER_M}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="simplify-slider">
                        <span data-i18n-key="blockify.modal.labels.simplify" data-i18n-attr="text">Simplify (m):</span>
                        <span id="simplify-value">${CbFormat.formatNumber(currentSimplifyM, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="simplify-slider" min="0" max="20" value="${DEFAULT_SIMPLIFY_M}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="width-slider">
                        <span data-i18n-key="blockify.modal.labels.width" data-i18n-attr="text">Building Width (m):</span>
                        <span id="width-value">${CbFormat.formatNumber(DEFAULT_BUILDING_WIDTH, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="width-slider" min="1" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="height-slider">
                        <span data-i18n-key="common.maxFloors" data-i18n-attr="text">Max storeys:</span>
                        <span id="height-value">${blockFloorsLabel(DEFAULT_BUILDING_HEIGHT)}</span>
                    </label>
                    <input type="range" id="height-slider" min="1" max="${BLOCK_MAX_FLOORS}" value="${blockFloors(DEFAULT_BUILDING_HEIGHT)}" step="1">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="blockify-ruletype-select" data-i18n-key="blockify.modal.labels.ruleType" data-i18n-attr="text">What the rule compels:</label>
                    <select id="blockify-ruletype-select">
                        <option value="exact" data-i18n-key="blockify.modal.labels.ruleTypeExact" data-i18n-attr="text">Exactly this height</option>
                        <option value="max" data-i18n-key="blockify.modal.labels.ruleTypeMax" data-i18n-attr="text">At most this height</option>
                        <option value="range" data-i18n-key="blockify.modal.labels.ruleTypeRange" data-i18n-attr="text">Between a minimum and this</option>
                    </select>
                </div>
                <div class="parameter-group blockify-freeform-only" id="blockify-minheight-group" style="display: none;">
                    <label for="blockify-minheight-slider">
                        <span data-i18n-key="common.minFloors" data-i18n-attr="text">Min storeys:</span>
                        <span id="blockify-minheight-value">0</span>
                    </label>
                    <input type="range" id="blockify-minheight-slider" min="0" max="${BLOCK_MAX_FLOORS}" value="0" step="1">
                </div>
                <div class="parameter-group blockify-freeform-only" id="blockify-mindepth-group" style="display: none;">
                    <label for="blockify-mindepth-slider">
                        <span data-i18n-key="blockify.modal.labels.minDepth" data-i18n-attr="text">Must build from street (m):</span>
                        <span id="blockify-mindepth-value">0.0</span>
                    </label>
                    <input type="range" id="blockify-mindepth-slider" min="0" max="100" value="0" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="blockify-minplot-slider">
                        <span data-i18n-key="blockify.modal.labels.minPlotArea" data-i18n-attr="text">Min Plot Size (m²):</span>
                        <span id="blockify-minplot-value">${DEFAULT_BLOCK_MIN_PLOT_AREA_M2}</span>
                    </label>
                    <input type="range" id="blockify-minplot-slider" min="0" max="10000" value="${DEFAULT_BLOCK_MIN_PLOT_AREA_M2}" step="10">
                </div>
                <div class="blockify-freeform-only">${window.UrbanRuleVariation.extrasControlsMarkup('blockify', { automaticUse: true })}</div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="gaps-slider">
                        <span data-i18n-key="blockify.modal.labels.gaps" data-i18n-attr="text">Number of gaps:</span>
                        <span id="gaps-value">0</span>
                    </label>
                    <input type="range" id="gaps-slider" min="0" max="10" value="0" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="gap-width-slider">
                        <span data-i18n-key="blockify.modal.labels.gapWidth" data-i18n-attr="text">Gap width (m):</span>
                        <span id="gap-width-value">5</span>
                    </label>
                    <input type="range" id="gap-width-slider" min="1" max="20" value="5" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="wings-slider">
                        <span data-i18n-key="blockify.modal.labels.wings" data-i18n-attr="text">Number of wings:</span>
                        <span id="wings-value">0</span>
                    </label>
                    <input type="range" id="wings-slider" min="0" max="10" value="0" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="wing-length-slider">
                        <span data-i18n-key="blockify.modal.labels.wingLength" data-i18n-attr="text">Wing length (m):</span>
                        <span id="wing-length-value">10</span>
                    </label>
                    <input type="range" id="wing-length-slider" min="10" max="200" value="10" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <button type="button" id="blockify-manual-toggle" class="btn btn-block" aria-pressed="false" data-i18n-key="blockify.modal.manual.edit" data-i18n-attr="text">Edit shape manually</button>
                    <button type="button" id="blockify-geojson-upload" class="btn btn-block" title="${translateBuildingText('common.footprintFileFormats', 'GeoJSON, CityGML or CityJSON')}" data-i18n-key="blockify.modal.manual.uploadGeojson" data-i18n-attr="text">Import Freeform footprints</button>
                    <input type="file" id="blockify-geojson-input" accept=".geojson,.json,.gml,.xml,application/geo+json,application/json,application/gml+xml" hidden>
                </div>
                <div class="parameter-info">
                    <p class="blockify-existing-only" style="display:none" data-i18n-key="blockify.modal.existing.helper">Each existing building is raised by the additional floors, up to the maximum height. Buildings already at or above the maximum stay unchanged.</p>
                </div>
            </div>
        <div id="blockify-controls" class="cb-dialog__footer">
            <p id="blockify-fit-warning" class="cb-banner cb-banner--warning" role="status" hidden
                data-i18n-key="blockify.modal.messages.siteTooSmall">${translateBuildingText('blockify.modal.messages.siteTooSmall', 'This land is too small for the requested block settings. Detect the whole block or add parcels, or reduce the setback, building depth or minimum plot size.')}</p>
            <div id="blockify-info" data-i18n-attr="text" role="status" aria-live="polite"></div>
            <div id="blockify-buttons">
                <button type="button" class="btn" id="btn-blockify-regenerate" hidden data-i18n-key="blockify.modal.regenerate" data-i18n-attr="text">Illustrate</button>
                <button type="button" class="btn" id="btn-blockify-freeform" data-i18n-key="proposalDrafts.freeform.title" data-i18n-attr="text">Convert to freeform building</button>
                <button type="button" class="btn btn-primary" id="btn-blockify-done" data-i18n-key="blockify.modal.done" data-i18n-attr="text">Done</button>
            </div>
        </div>
        `;

        const content = container.querySelector('#blockify-sidebar');
        const footer = container.querySelector('#blockify-controls');
        footer.classList.remove('cb-dialog__footer');
        // Keep the central rule and dimensions visible. Disabled experimental controls, import
        // tools and their supporting notes remain available without competing for the first view.
        const moreOptions = document.createElement('details');
        moreOptions.className = 'on-map-editor__more-options';
        const moreSummary = document.createElement('summary');
        moreSummary.setAttribute('data-i18n-key', 'onMapEditor.moreOptions');
        moreSummary.textContent = translateBuildingText('onMapEditor.moreOptions', 'More options');
        moreOptions.appendChild(moreSummary);
        const secondaryGroups = new Set();
        for (const selector of [
            '#algorithm-select', '#chamfer-slider', '#simplify-slider', '#gaps-slider', '#gap-width-slider', '#wings-slider',
            '#wing-length-slider', '#blockify-manual-toggle', '.parameter-info'
        ]) {
            const node = content.querySelector(selector);
            const group = node?.closest('.parameter-group') || node;
            if (group) secondaryGroups.add(group);
        }
        secondaryGroups.forEach(group => moreOptions.appendChild(group));
        content.appendChild(moreOptions);

        // Geometry statistics close the panel, after the options that shape the geometry.
        const densityStats = content.querySelector('#blockify-density-stats')?.closest('details');
        if (densityStats) content.appendChild(densityStats);
        // The model view's height arrow drives the storeys slider of the rule in use: Max storeys, or
        // Proposed height when raising existing buildings to one height. Added storeys have no single top.
        function blockifyModelHandles() {
            const existing = blockifyMode === 'existing';
            if (existing && existingRule !== 'exact') return null;
            const input = document.getElementById(existing ? 'proposed-height-slider' : 'height-slider');
            const features = (existing ? generatedBuildingFeatures : [generatedBuildingFeature]) || [];
            const largest = features.filter(feature => feature?.geometry)
                .reduce((best, feature) => (!best || turf.area(feature) > turf.area(best) ? feature : best), null);
            if (!input || !largest) return null;
            const [lng, lat] = turf.pointOnFeature(largest).geometry.coordinates;
            return { height: { input, at: { lat, lng }, metresPerStep: existing ? currentFloorHeightM : DEFAULT_FLOOR_HEIGHT_M } };
        }
        blockifyModal = window.OnMapEditor?.open({
            owner: 'urban-rule',
            id: 'blockify-modal',
            title: translateBuildingText('blockify.modal.title', 'Urban rule'),
            content,
            footer,
            modes: ['2d', 'model'],
            hints: { model: translateBuildingText('blockify.modal.modelHint', 'Drag the arrow above the building up or down to change its storeys.') },
            modelHandles: blockifyModelHandles,
            onCancel: requestCloseBlockifyModal,
            onModeChange: mode => { if (mode === '2d' && blockifyMode === 'manual') renderManualPolygonEditor(); }
        });
        if (!blockifyModal) return false;
        blockifyMap = blockifyModal.map;
        blockifySurroundings = window.BuildingSurroundingsEditor.mount({
            session: blockifyModal, id: 'blockify-ground-treatment', initialTreatment: blockifyInitialGroundTreatment, initialDecorationDesign: blockifyInitialDecorationDesign,
            boundary: blockifyDesignBoundary,
            buildings: () => blockifyMode === 'existing' ? (generatedBuildingFeatures || []) : [generatedBuildingFeature].filter(Boolean),
            onChange: () => autosaveBlockifyDraft()
        });
        ensureBlockifyHistory();
        setBlockifyInfo('blockify.modal.generating', 'Generating building...');
        try {
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                window.i18n.applyTranslations(blockifyModal.root);
            }
        } catch (error) {
            console.warn('[building-block-editor] Could not translate the editor', error);
        }


        document.dispatchEvent(new CustomEvent('blockifyModalOpened'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalOpened'));

        // Add event listeners
        blockifyDesignChanges().start(document);
        const doneButton = document.getElementById('btn-blockify-done');
        if (doneButton) {
            doneButton.addEventListener('click', saveBlockifyDesignForProposal);
            doneButton.disabled = true;
        }

        // Add slider event listeners
        blockifyHistory.bindInput(document.getElementById('setback-slider'), function (e) {
            currentSetback = parseFloat(e.target.value);
            document.getElementById('setback-value').textContent = CbFormat.formatNumber(currentSetback, { maxFractionDigits: 1, minFractionDigits: 1 });
            generateBuildingInModal();
        });

        const chamferSlider = document.getElementById('chamfer-slider');
        if (chamferSlider) {
            blockifyHistory.bindInput(chamferSlider, function (e) {
                currentChamferM = parseFloat(e.target.value);
                document.getElementById('chamfer-value').textContent = CbFormat.formatNumber(currentChamferM, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateBuildingInModal();
            });
        }

        const simplifySlider = document.getElementById('simplify-slider');
        if (simplifySlider) {
            blockifyHistory.bindInput(simplifySlider, function (e) {
                currentSimplifyM = parseFloat(e.target.value);
                document.getElementById('simplify-value').textContent = CbFormat.formatNumber(currentSimplifyM, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateBuildingInModal();
            });
        }

        blockifyHistory.bindInput(document.getElementById('width-slider'), function (e) {
            if (blockifyMode === 'manual') return;
            currentBuildingWidth = parseFloat(e.target.value);
            document.getElementById('width-value').textContent = CbFormat.formatNumber(currentBuildingWidth, { maxFractionDigits: 1, minFractionDigits: 1 });
            generateBuildingInModal();
        });

        const heightSlider = document.getElementById('height-slider');
        if (heightSlider) {
            blockifyHistory.bindInput(heightSlider, function (e) {
                currentBuildingHeight = parseInt(e.target.value, 10) * DEFAULT_FLOOR_HEIGHT_M;
                document.getElementById('height-value').textContent = blockFloorsLabel(currentBuildingHeight);
                // Only affects 3D extrusion; regenerate 3D using the current geometry
                if (generatedBuildingFeature) {
                    // Keep the feature's own height in step with the slider. The footprint doesn't
                    // change, so nothing regenerates it — without this the saved building carries
                    // the height from the last full generate, and the 3D view (which reads
                    // properties.height) renders the proposal at the wrong height.
                    if (generatedBuildingFeature.properties) {
                        generatedBuildingFeature.properties.height = currentBuildingHeight;
                    }
                    refreshBlockPieceHeights();
                    syncBlockMinHeightSlider();
                    publishBlockifyPreview({
                        exampleBuildings: blockBuildOut,
                        envelopes: blockMassingPieces,
                        excluded: blockExcludedParcels.map(entry => entry?.feature).filter(feature => feature?.geometry)
                    });
                    // The draft carries its own copy of the feature and it is what gets published
                    // (serializeProposal reads editorPayload.context.buildings). Nothing regenerates
                    // the footprint here, so without this autosave a height-only edit was dropped.
                    autosaveBlockifyDraft();
                }
            });
        }

        const blockRuleTypeSelect = document.getElementById('blockify-ruletype-select');
        if (blockRuleTypeSelect) {
            blockRuleTypeSelect.value = blockRuleKind;
            blockRuleTypeSelect.addEventListener('change', function (e) {
                if (blockRuleKind === e.target.value) return;
                blockifyHistory?.record();
                blockRuleKind = e.target.value;
                syncBlockMinHeightSlider();
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockRegenerate = document.getElementById('btn-blockify-regenerate');
        if (blockRegenerate) {
            // Only the seed moves: the massing, and every number read off it, stay put.
            blockRegenerate.addEventListener('click', function () {
                blockifyHistory?.record();
                blockVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockMinHeightSlider = document.getElementById('blockify-minheight-slider');
        if (blockMinHeightSlider) {
            blockifyHistory.bindInput(blockMinHeightSlider, function (e) {
                blockMinHeightM = parseInt(e.target.value, 10) * DEFAULT_FLOOR_HEIGHT_M;
                document.getElementById('blockify-minheight-value').textContent = blockFloorsLabel(blockMinHeightM);
                refreshBlockPieceHeights();
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockMinDepthSlider = document.getElementById('blockify-mindepth-slider');
        if (blockMinDepthSlider) {
            blockifyHistory.bindInput(blockMinDepthSlider, function (e) {
                blockMinDepthM = parseFloat(e.target.value);
                document.getElementById('blockify-mindepth-value').textContent = CbFormat.formatNumber(blockMinDepthM, { maxFractionDigits: 1, minFractionDigits: 1 });
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockMinPlotSlider = document.getElementById('blockify-minplot-slider');
        if (blockMinPlotSlider) {
            blockifyHistory.bindInput(blockMinPlotSlider, function (e) {
                blockMinPlotAreaM2 = parseFloat(e.target.value);
                document.getElementById('blockify-minplot-value').textContent = blockMinPlotAreaM2.toString();
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        window.UrbanRuleVariation.bindExtrasControls(document, 'blockify', extras => {
            blockifyHistory?.record();
            blockRuleExtras = extras;
            refreshBlockPieceHeights();
            if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
        });

        // Enable gap sliders
        const gapsSlider = document.getElementById('gaps-slider');
        const gapWidthSlider = document.getElementById('gap-width-slider');
        if (gapsSlider) {
            gapsSlider.disabled = false;
            gapsSlider.value = 0;
            document.getElementById('gaps-value').textContent = '0';
            blockifyHistory.bindInput(gapsSlider, function (e) {
                document.getElementById('gaps-value').textContent = e.target.value;
                gapPositions = syncPositions(gapPositions, parseInt(e.target.value) || 0);
                generateBuildingInModal();
            });
        }
        if (gapWidthSlider) {
            gapWidthSlider.disabled = false;
            blockifyHistory.bindInput(gapWidthSlider, function (e) {
                currentGapWidth = parseFloat(e.target.value);
                document.getElementById('gap-width-value').textContent = e.target.value;
                generateBuildingInModal();
            });
        }

        // Enable wing sliders
        const wingsSlider = document.getElementById('wings-slider');
        const wingLengthSlider = document.getElementById('wing-length-slider');
        if (wingsSlider) {
            wingsSlider.disabled = false;
            wingsSlider.value = 0;
            document.getElementById('wings-value').textContent = '0';
            blockifyHistory.bindInput(wingsSlider, function (e) {
                document.getElementById('wings-value').textContent = e.target.value;
                wingPositions = syncPositions(wingPositions, parseInt(e.target.value) || 0);
                generateBuildingInModal();
            });
        }
        if (wingLengthSlider) {
            wingLengthSlider.disabled = false;
            blockifyHistory.bindInput(wingLengthSlider, function (e) {
                currentWingLength = parseFloat(e.target.value);
                document.getElementById('wing-length-value').textContent = e.target.value;
                generateBuildingInModal();
            });
        }

        const manualToggle = document.getElementById('blockify-manual-toggle');
        if (manualToggle) {
            manualToggle.addEventListener('click', function () {
                if (blockifyMode === 'manual') exitToParametricMode();
                else enterManualMode();
            });
        }
        // Leaving the rule: one Freeform building, kept where it stands (proposal-editor-shell.js).
        document.getElementById('btn-blockify-freeform')?.addEventListener('click', convertBlockifyToFreeform);

        const geojsonBtn = document.getElementById('blockify-geojson-upload');
        const geojsonInput = document.getElementById('blockify-geojson-input');
        if (geojsonBtn && geojsonInput) {
            geojsonBtn.addEventListener('click', () => geojsonInput.click());
            geojsonInput.addEventListener('change', function (e) {
                const file = e.target.files && e.target.files[0];
                if (file) loadGeojsonFootprint(file);
                e.target.value = ''; // allow re-selecting the same file
            });
        }

        const existingToggle = document.getElementById('blockify-existing-toggle');
        if (existingToggle) {
            existingToggle.addEventListener('change', function (e) {
                if (e.target.checked) enterExistingMode();
                else exitExistingMode();
            });
        }

        // The two rules are exclusive: the radios pick one, and moving a slider activates its rule.
        document.querySelectorAll('input[name="blockify-existing-rule"]').forEach(radio => {
            radio.addEventListener('change', function (e) {
                if (!e.target.checked) return;
                existingRule = e.target.value === 'additional' ? 'additional' : 'exact';
                generateExistingBuildingsInModal();
            });
        });

        const proposedHeightSlider = document.getElementById('proposed-height-slider');
        if (proposedHeightSlider) {
            proposedHeightSlider.addEventListener('input', function (e) {
                currentProposedHeightFloors = parseInt(e.target.value) || DEFAULT_PROPOSED_HEIGHT_FLOORS;
                setExistingRule('exact');
                updateExistingValueLabels();
                generateExistingBuildingsInModal();
            });
        }

        const additionalFloorsSlider = document.getElementById('additional-floors-slider');
        if (additionalFloorsSlider) {
            additionalFloorsSlider.addEventListener('input', function (e) {
                currentAdditionalFloors = parseInt(e.target.value) || DEFAULT_ADDITIONAL_FLOORS;
                setExistingRule('additional');
                updateExistingValueLabels();
                generateExistingBuildingsInModal();
            });
        }

        const floorHeightSlider = document.getElementById('floor-height-slider');
        if (floorHeightSlider) {
            floorHeightSlider.addEventListener('input', function (e) {
                currentFloorHeightM = parseFloat(e.target.value) || DEFAULT_FLOOR_HEIGHT_M;
                updateExistingValueLabels();
                generateExistingBuildingsInModal();
            });
        }

    }

    // Display the block on the map
    displayBlockOnMap(block);

    // Reset parameter values
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
    currentChamferM = DEFAULT_CHAMFER_M;
    currentSimplifyM = DEFAULT_SIMPLIFY_M;
    blockRuleKind = DEFAULT_BLOCK_RULE_KIND;
    blockMinHeightM = 0;
    blockMinDepthM = 0;
    blockMinPlotAreaM2 = DEFAULT_BLOCK_MIN_PLOT_AREA_M2;
    blockRuleExtras = {};
    blockVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
    blockMassingPieces = [];
    blockBuildOut = [];
    blockExcludedParcels = [];
    gapPositions = [];
    wingPositions = [];
    currentGapWidth = 5;
    currentWingLength = 10;
    blockifyMode = 'parametric';
    blockifyPendingVertexActionIndex = null;
    manualOuterRing = [];
    existingRule = 'exact';
    currentProposedHeightFloors = DEFAULT_PROPOSED_HEIGHT_FLOORS;
    currentAdditionalFloors = DEFAULT_ADDITIONAL_FLOORS;
    currentFloorHeightM = DEFAULT_FLOOR_HEIGHT_M;
    existingFootprints = null;
    existingFootprintsPromise = null;
    generatedBuildingFeatures = null;

    // Restore a saved design (e.g. a copied proposal) over the freshly-reset defaults, so the
    // editor opens on the original shape with every control still live.
    const seed = blockifySeedState;
    blockifySeedState = null;
    if (seed) applyBlockifySeedState(seed);

    syncBlockifyControlsFromState();

    // Generate building immediately
    setTimeout(() => {
        if (initialGeometryError) {
            reportBlockifyGenerationError(initialGeometryError);
            return;
        }
        if (seed && seed.mode === 'existing') {
            // Existing-buildings mode refetches footprints; entering the mode does the drawing.
            enterExistingMode();
            return;
        }
        if (seed && seed.mode === 'manual' && Array.isArray(manualOuterRing) && manualOuterRing.length >= 3) {
            // Manual outlines are not slider-derived, so restore the ring rather than regenerate.
            setFootprintSlidersEnabled(false);
            updateManualToggleLabel();
            generateManualBuilding();
            return;
        }
        generateBuildingInModal();
    }, 500); // Small delay to ensure the map is fully initialized
    return !!blockifyModal;
}
