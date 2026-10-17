// Interactive, read-only on-map preview for candidate urban-block subdivision layouts.
(function (win) {
    'use strict';
    if (!win?.document) return;

    const doc = win.document;
    const PIECE_PALETTE_SIZE = 8;
    const AREA_MIN_M2 = 1000;
    const AREA_MAX_M2 = 50000;
    const AREA_STEP_M2 = 125;
    const AREA_DEFAULT_M2 = 10000;
    const state = { session: null, root: null, layers: null, renderer: null, trace: null, pieceLayers: new Map(),
        previewWorker: null, planWorker: null, previewRequest: 0, planRequest: 0,
        block: null, roads: null, shareBaseUrl: null, layouts: [], result: null,
        candidates: null, previewStats: null, selectedLayout: 0, generatedOptions: null, stale: false,
        showTJunctions: true, showDeadEnds: true, showPerimeter: true, inspectedCandidateId: null, shareRequest: 0, proposing: false };
    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const t = (key, fallback, params) => {
        const value = win.i18n?.t?.(`urbanBlocks.playground.${key}`, params);
        if (value && value !== `urbanBlocks.playground.${key}`) return value;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? ''));
    };
    const number = value => win.CbFormat?.formatNumber(value, { maxFractionDigits: 0 }) ?? new Intl.NumberFormat(doc.documentElement.lang || 'en', { maximumFractionDigits: 0 }).format(value);
    const area = value => win.CbFormat?.formatArea(value, { maxFractionDigits: 0 }) ?? `${number(value)} m²`;
    const length = value => win.CbFormat?.formatLength(value, { maxFractionDigits: 0 }) ?? `${number(value)} m`;
    const pieceTint = (index, count) => count < 2 ? 25 : Math.round(20 + index * 15 / (count - 1));

    // The playground is an on-map tool (OnMapEditor): settings, layouts and actions in its panel,
    // the block, its candidate points and the generated pieces and streets drawn on the live map.
    function buildPanel() {
        const content = el('div', 'urban-block-playground__content');
        content.innerHTML = `
            <p class="urban-block-playground__status" data-slot="status" role="status" aria-live="polite"></p>
            <p class="urban-block-playground__score" data-slot="layout-score"></p>
            <section class="urban-block-playground__controls">
                <h3 data-slot="controls-title"></h3>
                <h4 data-slot="split-limits-title"></h4>
                <div class="urban-block-playground__slider"><label for="urban-block-playground-target-area" data-slot="target-area-label"></label><output data-output="targetAreaM2"></output>
                    <input id="urban-block-playground-target-area" data-setting="targetAreaM2" type="range" min="1000" max="50000" step="125" value="10000">
                </div>
                <p class="urban-block-playground__target-area" data-slot="target-area" aria-live="polite"></p>
                <div class="urban-block-playground__slider"><label for="urban-block-playground-max-side" data-slot="max-side-label"></label><output data-output="maxSideM"></output>
                    <input id="urban-block-playground-max-side" data-setting="maxSideM" type="range" min="50" max="300" step="25" value="150">
                </div>
                <p class="urban-block-playground__max-side-help" data-slot="max-side-help"></p>
                <fieldset class="urban-block-playground__checks">
                    <legend data-slot="road-points-title"></legend>
                    <label class="urban-block-playground__switch"><input data-visibility="showTJunctions" type="checkbox" role="switch" checked><span class="urban-block-playground__switch-track" aria-hidden="true"></span><span data-slot="t-junctions"></span></label>
                    <label class="urban-block-playground__switch"><input data-visibility="showDeadEnds" type="checkbox" role="switch" checked><span class="urban-block-playground__switch-track" aria-hidden="true"></span><span data-slot="dead-ends"></span></label>
                </fieldset>
                <fieldset class="urban-block-playground__perimeter">
                    <legend><label class="urban-block-playground__switch"><input data-visibility="showPerimeter" type="checkbox" role="switch" checked><span class="urban-block-playground__switch-track" aria-hidden="true"></span><span data-slot="perimeterFallback"></span></label></legend>
                    <div class="urban-block-playground__slider"><label for="urban-block-playground-perimeter-step" data-slot="perimeter-step-label"></label><output data-output="perimeterStepM"></output>
                        <input id="urban-block-playground-perimeter-step" data-setting="perimeterStepM" type="range" min="50" max="300" step="25" value="150">
                    </div>
                </fieldset>
                <p class="urban-block-playground__method-note" data-slot="method-note"></p>
                <p class="urban-block-playground__preview-status" data-slot="preview-status" role="status" aria-live="polite"></p>
                <button type="button" class="btn btn-primary" data-action="generate"></button>
            </section>
            <section class="urban-block-playground__alternatives">
                <label for="urban-block-playground-layout" data-slot="layout-label"></label>
                <select id="urban-block-playground-layout" data-slot="layout-select" disabled></select>
            </section>
            <div class="urban-block-playground__metrics" data-slot="metrics"></div>
            <section class="urban-block-playground__pieces">
                <h3 data-slot="pieces-title"></h3>
                <div data-slot="pieces"></div>
            </section>
            <p class="urban-block-playground__candidate-info" data-slot="candidate-info" role="status" aria-live="polite"></p>
            <div class="urban-block-playground__legend" data-slot="legend"></div>
            <p class="urban-block-playground__note" data-slot="note"></p>`;
        const footer = el('div', 'urban-block-playground__footer');
        footer.innerHTML = `
            <p class="urban-block-playground__disclaimer" data-slot="disclaimer"></p>
            <div class="urban-block-playground__share-status" data-slot="share-status" role="status" aria-live="polite"></div>
            <div class="urban-block-playground__actions">
                <button type="button" class="btn" data-action="share"></button>
                <button type="button" class="btn btn-primary" data-action="propose" disabled></button>
            </div>`;
        return { content, footer };
    }

    function wirePanel(root) {
        root.querySelector('[data-action="generate"]').addEventListener('click', generate);
        root.querySelector('[data-action="share"]').addEventListener('click', share);
        root.querySelector('[data-action="propose"]').addEventListener('click', event => win.BusyControl.track(event.currentTarget, propose));
        root.querySelectorAll('[data-setting="targetAreaM2"], [data-setting="maxSideM"], [data-setting="perimeterStepM"]').forEach(input => input.addEventListener('input', () => {
            updateRangeOutput(input.dataset.setting);
            if (input.dataset.setting === 'targetAreaM2') updateTargetArea();
            settingsChanged(input.dataset.setting === 'perimeterStepM');
        }));
        root.querySelectorAll('[data-visibility]').forEach(input => input.addEventListener('change', () => {
            state[input.dataset.visibility] = input.checked;
            draw();
        }));
        root.querySelector('[data-slot="layout-select"]').addEventListener('change', event => {
            state.selectedLayout = Number(event.target.value) || 0;
            resetShare();
            renderResult();
        });
    }

    function localize(root) {
        const set = (selector, key, fallback) => { root.querySelector(selector).textContent = t(key, fallback); };
        set('[data-slot="controls-title"]', 'controlsTitle', 'Layout settings');
        set('[data-slot="target-area-label"]', 'targetAreaLabel', 'Maximum block area (m²)');
        set('[data-slot="max-side-label"]', 'maxSide', 'Maximum block side (m)');
        set('[data-slot="max-side-help"]', 'maxSideHelp', 'This is a ceiling, not a preferred length.');
        set('[data-slot="perimeter-step-label"]', 'perimeterStep', 'Perimeter candidate interval (m)');
        set('[data-slot="split-limits-title"]', 'splitLimitsTitle', 'Split limits');
        set('[data-slot="road-points-title"]', 'roadPointsTitle', 'Road candidate points');
        set('[data-slot="t-junctions"]', 'showTJunctions', 'Show T-junction points');
        set('[data-slot="dead-ends"]', 'showDeadEnds', 'Show dead ends and projections');
        set('[data-slot="perimeterFallback"]', 'showPerimeter', 'Show perimeter fallback points');
        set('[data-slot="method-note"]', 'methodNote', 'The perimeter walk starts at one junction or alley entrance. It advances to the next existing point within the interval, otherwise places a point at that distance, and continues around the block.');
        set('[data-action="generate"]', 'generate', 'Generate splits');
        set('[data-action="share"]', 'share', 'Share layout');
        set('[data-action="propose"]', 'propose', 'Propose streets');
        set('[data-slot="layout-label"]', 'alternativeLayout', 'Alternative layout');
        set('[data-slot="pieces-title"]', 'piecesTitle', 'Blocks in this layout');
        set('[data-slot="note"]', 'sideNote', 'The longest side is measured from a fitted bounding rectangle.');
        set('[data-slot="candidate-info"]', 'candidateTraceHint', 'Hover or tap a junction or fallback point to inspect its source.');
        set('[data-slot="disclaimer"]', 'disclaimer', 'Concept geometry; street width, buildings and ownership are not checked.');
        updateRangeOutput('targetAreaM2');
        updateTargetArea();
        updateRangeOutput('maxSideM');
        updateRangeOutput('perimeterStepM');
    }

    function close() {
        const session = state.session;
        if (!session) return;
        state.session = null;
        stopWorkers();
        state.shareRequest++;
        session.map.off('click', clearCandidateTrace);
        state.layers?.remove();
        state.layers = null; state.trace = null; state.pieceLayers = new Map();
        session.close();
        state.root = null;
    }

    function stopWorkers() {
        state.previewRequest += 1;
        state.planRequest += 1;
        state.previewWorker?.terminate();
        state.planWorker?.terminate();
        state.previewWorker = null;
        state.planWorker = null;
    }

    function settings() {
        const root = state.root;
        const value = name => root.querySelector(`[data-setting="${name}"]`);
        return {
            targetAreaM2: Number(value('targetAreaM2').value),
            maxSideM: Number(value('maxSideM').value),
            perimeterStepM: Number(value('perimeterStepM').value)
        };
    }

    function sameSettings(first, second) {
        return ['targetAreaM2', 'maxSideM', 'perimeterStepM'].every(key => Number(first?.[key]) === Number(second?.[key]));
    }

    function updateRangeOutput(name) {
        if (!state.root) return;
        const value = Number(state.root.querySelector(`[data-setting="${name}"]`).value);
        state.root.querySelector(`[data-output="${name}"]`).textContent = name === 'targetAreaM2' ? area(value) : length(value);
    }

    function normalizeTargetArea(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return AREA_DEFAULT_M2;
        const clamped = Math.min(AREA_MAX_M2, Math.max(AREA_MIN_M2, numeric));
        return AREA_MIN_M2 + Math.round((clamped - AREA_MIN_M2) / AREA_STEP_M2) * AREA_STEP_M2;
    }

    function updateTargetArea() {
        if (!state.root) return;
        const targetArea = Number(state.root.querySelector('[data-setting="targetAreaM2"]').value);
        state.root.querySelector('[data-slot="target-area"]').textContent = t('targetAreaReadout', 'Each block must be no larger than {{area}}.', { area: area(targetArea) });
    }

    function clearResultView() {
        state.root.querySelector('[data-slot="layout-select"]').replaceChildren();
        state.root.querySelector('[data-slot="layout-select"]').disabled = true;
        state.root.querySelector('[data-action="propose"]').disabled = true;
        state.root.querySelector('[data-slot="layout-score"]').textContent = '';
        state.root.querySelector('[data-slot="metrics"]').replaceChildren();
        state.root.querySelector('[data-slot="pieces"]').replaceChildren();
        renderLegend();
    }

    function setStatus(key, fallback) {
        const layout = state.layouts[state.selectedLayout];
        if (state.stale && layout) state.root.querySelector('[data-slot="status"]').textContent = t('stale', 'Settings changed. Displayed splits use the previous settings. Generate splits to update them.');
        else state.root.querySelector('[data-slot="status"]').textContent = t(key, fallback);
    }

    function settingsChanged(updateCandidates = false) {
        resetShare();
        const hasGenerated = !!state.generatedOptions && state.layouts.length > 0;
        state.stale = hasGenerated && !sameSettings(settings(), state.generatedOptions);
        if (state.stale) setStatus('initial', 'Showing candidate points. Generate splits to preview how they divide the block.');
        else if (hasGenerated) renderResult();
        else setStatus('initial', 'Showing candidate points. Generate splits to preview how they divide the block.');
        if (updateCandidates) postPreview(settings());
    }

    function postPreview(options, includeSource = false) {
        try {
            if (!state.previewWorker) {
                const worker = new win.Worker(win.appendBuildToken('js/urban-blocks-subdivision-worker.js'));
                state.previewWorker = worker;
                worker.onmessage = ({ data }) => {
                    if (data?.action !== 'preview' || data.request !== state.previewRequest || !state.session) return;
                    if (data.error) {
                        showPreviewError(data.error);
                        return;
                    }
                    state.candidates = data.result?.candidates || { type: 'FeatureCollection', features: [] };
                    state.previewStats = data.result?.stats || {};
                    state.root.querySelector('[data-slot="preview-status"]').textContent = t('previewSummary', '{{t}} T-junctions · {{dead}} dead ends · {{projected}} alley projections · {{perimeter}} perimeter points', {
                        t: number(state.previewStats.tCount || 0), dead: number(state.previewStats.deadEndCount || 0),
                        projected: number(state.previewStats.deadEndProjectionCount || 0), perimeter: number(state.previewStats.fallbackCount || 0)
                    });
                    if (!state.previewStats.tCount && !state.previewStats.deadEndCount) {
                        state.root.querySelector('[data-slot="preview-status"]').textContent += ' ' + t('noPerimeterAnchor', 'No junction or connected alley entrance was found to start the perimeter walk.');
                    }
                    draw();
                };
                worker.onerror = event => {
                    if (state.previewWorker !== worker) return;
                    state.previewWorker = null;
                    worker.terminate();
                    showPreviewError(event.message || 'Preview worker failed.');
                };
                includeSource = true;
            }
            const request = ++state.previewRequest;
            state.root.querySelector('[data-slot="preview-status"]').textContent = t('previewLoading', 'Loading candidate points…');
            const message = { action: 'preview', request, options };
            if (includeSource) Object.assign(message, { block: state.block, roads: state.roads });
            state.previewWorker.postMessage(message);
        } catch (error) {
            showPreviewError(error.message || error);
        }
    }

    function showPreviewError(error) {
        const message = String(error || 'Preview worker failed.');
        console.warn(`[${new Date().toISOString()}] [urban-block-playground] ${message}`);
        state.root.querySelector('[data-slot="preview-status"]').textContent = t('previewFailure', 'Could not load candidate points: {{reason}}', { reason: message });
    }

    function runLayoutAction(action, options, subdivision = null) {
        state.planWorker?.terminate();
        const request = ++state.planRequest;
        try {
            const worker = new win.Worker(win.appendBuildToken('js/urban-blocks-subdivision-worker.js'));
            state.planWorker = worker;
            worker.onmessage = ({ data }) => {
                if (request !== state.planRequest || data?.request !== request || data.action !== action || !state.session) return;
                state.planWorker?.terminate(); state.planWorker = null;
                if (data.error) {
                    if (action === 'restore') {
                        state.root.querySelector('[data-slot="share-status"]').textContent = t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: String(data.error) });
                    } else showError(data.error);
                    return;
                }
                state.result = data.result;
                state.layouts = Array.isArray(data.result?.layouts) ? data.result.layouts.slice(0, 5) : [];
                state.selectedLayout = 0;
                state.generatedOptions = options;
                state.stale = !sameSettings(settings(), options);
                resetShare();
                renderResult();
            };
            worker.onerror = event => {
                if (request !== state.planRequest) return;
                state.planWorker?.terminate(); state.planWorker = null;
                const message = event.message || t('workerFailure', 'Could not generate splits. Please try again.');
                if (action === 'restore') state.root.querySelector('[data-slot="share-status"]').textContent = t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: message });
                else showError(message);
            };
            worker.postMessage({ action, request, block: state.block, roads: state.roads, options, ...(subdivision ? { subdivision } : {}) });
        } catch (error) {
            if (request === state.planRequest) {
                if (action === 'restore') state.root.querySelector('[data-slot="share-status"]').textContent = t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: String(error.message || error) });
                else showError(error.message || error);
            }
        }
    }

    function generate() {
        const options = settings();
        resetShare();
        state.root.querySelector('[data-slot="status"]').textContent = t('generating', 'Generating splits…');
        runLayoutAction('plan', options);
    }

    function resetShare() {
        state.shareRequest++;
        state.root.querySelector('[data-slot="share-status"]').textContent = '';
    }

    async function share() {
        const request = ++state.shareRequest;
        const layout = state.layouts[state.selectedLayout] || { cuts: { type: 'FeatureCollection', features: [] } };
        const options = state.generatedOptions || settings();
        try {
            const url = win.UrbanBlocksLinks?.build?.({
                baseUrl: state.shareBaseUrl || win.location.href,
                city: win.CityConfigManager?.getCurrentCityId?.() || 'explore',
                blockId: state.block.id,
                bbox: win.turf.bbox(state.block),
                subdivision: { options, layout }
            });
            if (!url) throw new Error(t('shareUnavailable', 'This block layout cannot be shared.'));
            // The address bar carries the link before the clipboard is asked: a permission prompt
            // can remain pending, and mobile/insecure contexts may not expose clipboard access.
            win.history.replaceState(win.history.state, '', url);
            try {
                await win.navigator.clipboard.writeText(url);
                if (request === state.shareRequest) state.root.querySelector('[data-slot="share-status"]').textContent = t('shareCopied', 'Layout link copied.');
            } catch (error) {
                if (request === state.shareRequest) state.root.querySelector('[data-slot="share-status"]').textContent = t('shareCopyFailed', 'Automatic copying is unavailable. Copy the link from the address bar.');
                console.warn(`[${new Date().toISOString()}] [urban-block-playground] Clipboard copy failed: ${String(error?.message || error)}`);
            }
        } catch (error) {
            const message = String(error?.message || error || t('shareUnavailable', 'This block layout cannot be shared.'));
            state.root.querySelector('[data-slot="share-status"]').textContent = t('shareFailed', 'Could not share this layout: {{reason}}', { reason: message });
            console.warn(`[${new Date().toISOString()}] [urban-block-playground] Share failed: ${message}`);
        }
    }

    // The selected layout's new streets become road proposals, built and junctioned exactly as an
    // imported road is: one record per connected network, as a 10 m local street (two 3.5 m lanes,
    // 1.5 m pavements). They land applied on the map, ready to share and name as one plan.
    async function propose() {
        const cuts = state.layouts[state.selectedLayout]?.cuts?.features || [];
        const status = state.root.querySelector('[data-slot="share-status"]');
        const button = state.root.querySelector('[data-action="propose"]');
        if (!cuts.length || state.proposing) return;
        // A second click must not create the streets twice.
        state.proposing = true;
        button.disabled = true;
        try {
            await proposeStreets(cuts, status, button);
        } finally {
            state.proposing = false;
        }
    }

    async function proposeStreets(cuts, status, button) {
        const profile = { strips: win.CORRIDOR_PROFILE_PRESETS[10].map(strip => ({ ...strip })) };
        const parsed = win.UrbanBlocksPropose.importForm(cuts, { tags: { highway: 'residential', ...win.corridorProfileToOsmTags(profile) } });
        const records = win.__corridorImport.recordsFromImport(parsed, {
            author: win.getProposalAuthorValue?.() || 'block-breakup',
            source: 'block-breakup',
            fallbackTitle: t('newStreet', 'New street'),
            description: t('proposeDescription', 'New street from a breakup of block {{block}}.', { block: state.block.id })
        });
        // The steps a drawn road's Finish takes (corridor-import.js createRoadRecords).
        const { created, failed } = await win.__corridorImport.createRoadRecords(records);
        if (failed.length) console.warn(`[${new Date().toISOString()}] [urban-block-playground] Propose failed for ${failed.length} of ${records.length} streets:`, failed);
        if (!created.length) {
            button.disabled = false;
            status.textContent = t('proposeFailed', 'Could not propose these streets: {{reason}}', { reason: failed.filter(Boolean).join(' ') || '?' });
            return;
        }
        close();
        win.updateStatus?.(t('proposeDone', 'Proposed {{count}} of {{total}} new streets. Share them as a plan to publish them together.',
            { count: number(created.length), total: number(records.length) }));
    }

    function showError(error) {
        const message = String(error || t('workerFailure', 'Could not generate layouts. Please try again.'));
        console.warn(`[${new Date().toISOString()}] [urban-block-playground] ${message}`);
        state.root.querySelector('[data-slot="status"]').textContent = t('workerFailureDetail', 'Could not generate layouts: {{reason}}', { reason: message });
    }

    function candidateDescription(provenance) {
        const source = provenance.sourceKind === 't' ? t('traceSourceTJunction', 'a T-junction')
            : provenance.sourceKind === 'dead-end-root' ? t('traceSourceAlley', 'a street entrance')
                : t('traceSourceFallback', 'another fallback point');
        const params = { source, length: length(provenance.perimeterLengthM) };
        return t('traceSpacing', '{{length}} along the perimeter from {{source}}.', params);
    }

    function junctionDescription(properties) {
        return properties.projectionDistanceM < 0.02
            ? t('traceJunctionOnBoundary', 'Road junction on the block perimeter.')
            : t('traceJunctionProjection', 'Road junction projected {{length}} to the closest point on the block perimeter.', { length: length(properties.projectionDistanceM) });
    }

    function deadEndProjectionDescription(sources) {
        return sources.length === 1
            ? t('traceDeadEndProjection', '{{length}} straight ahead from the dead end to the first block boundary.', { length: length(sources[0].lengthM) })
            : t('traceDeadEndProjections', '{{count}} dead ends project here: {{lengths}}.', {
                count: number(sources.length), lengths: sources.map(source => length(source.lengthM)).join(', ')
            });
    }

    function clearCandidateTrace() {
        state.inspectedCandidateId = null;
        state.trace?.remove();
        state.trace = null;
        state.layers?.eachLayer(layer => layer.getElement?.()?.classList.remove('is-inspected'));
        if (state.root) {
            const info = state.root.querySelector('[data-slot="candidate-info"]');
            info.hidden = !state.showPerimeter && !state.showTJunctions && !state.showDeadEnds;
            info.textContent = t('candidateTraceHint', 'Hover or tap a junction, alley projection or fallback point to inspect its source.');
        }
    }

    const latLng = ([lng, lat]) => [lat, lng];
    const vector = className => ({ pane: state.session.pane, renderer: state.renderer, className });

    function showCandidateTrace(feature, marker) {
        const p = feature.properties.provenance;
        const junction = feature.properties.junctionPoint;
        const sources = feature.properties.projectionSources;
        if (!p && !junction && !sources?.length) return;
        clearCandidateTrace();
        state.inspectedCandidateId = feature.properties.id;
        marker.getElement?.()?.classList.add('is-inspected');
        const L = win.L, modifier = sources ? ' is-dead-end-projection' : '';
        const trace = L.layerGroup();
        const traces = sources ? sources.map(source => ({ path: [source.sourcePoint, feature.geometry.coordinates],
            source: source.sourcePoint, measured: source.lengthM })) : [{
            path: p?.perimeterPath || [junction, feature.geometry.coordinates],
            source: p?.sourcePoint || junction, measured: p ? p.perimeterLengthM : feature.properties.projectionDistanceM
        }];
        for (const item of traces) {
            if (item.measured > 0.02) {
                trace.addLayer(L.polyline(item.path.map(latLng), { ...vector(`urban-block-playground__trace-${p ? 'perimeter' : 'projection'}${modifier}`), interactive: false }));
            }
            trace.addLayer(L.circleMarker(latLng(item.source), { ...vector(`urban-block-playground__trace-source${modifier}`), radius: 9, interactive: false }));
            const at = sources ? item.source.map((value, i) => (value + feature.geometry.coordinates[i]) / 2) : feature.geometry.coordinates;
            trace.addLayer(L.tooltip({ permanent: true, direction: 'top', className: `urban-block-playground__trace-label${modifier}` })
                .setLatLng(latLng(at)).setContent(length(item.measured)));
        }
        state.trace = trace.addTo(state.layers);
        state.root.querySelector('[data-slot="candidate-info"]').textContent = p ? candidateDescription(p)
            : sources ? deadEndProjectionDescription(sources) : junctionDescription(feature.properties);
    }

    function draw() {
        if (!state.session) return;
        const L = win.L;
        clearCandidateTrace();
        if (!state.layers) {
            state.renderer = L.svg({ pane: state.session.pane });
            state.layers = L.layerGroup().addTo(state.session.map);
        }
        state.layers.clearLayers();
        state.pieceLayers = new Map();
        state.layers.addLayer(L.geoJSON(state.block, { ...vector('urban-block-playground__outline'), interactive: false }));
        const layout = state.layouts[state.selectedLayout];
        const features = layout?.pieces?.features || [];
        for (const [index, feature] of features.entries()) {
            const id = String(feature.id ?? feature.properties?.id ?? index);
            const properties = feature.properties || {};
            const withinLimits = !!properties.acceptable;
            const title = t('pieceTitle', 'Block {{number}} · {{area}} · {{status}}', {
                number: number(index + 1), area: area(properties.areaM2),
                status: withinLimits ? t('fits', 'Within limits') : t('over', 'Over a limit')
            });
            const piece = L.geoJSON(feature, vector(`urban-block-playground__piece palette-${index % PIECE_PALETTE_SIZE} ${withinLimits ? 'is-acceptable' : 'is-oversized'}`))
                .bindTooltip(title, { sticky: true });
            piece.on('click', () => highlightPiece(id));
            state.pieceLayers.set(id, piece);
            state.layers.addLayer(piece);
            // The shade step is data, so it reaches the stylesheet as a custom property.
            const opacity = (0.15 + pieceTint(index, features.length) / 100).toFixed(2);
            piece.eachLayer(layer => layer.getElement?.()?.style.setProperty('--piece-opacity', opacity));
            const point = properties.labelPoint;
            if (Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(value => typeof value === 'number' && Number.isFinite(value))) {
                const label = el('span', `urban-block-playground__piece-area palette-${index % PIECE_PALETTE_SIZE}`, area(properties.areaM2));
                state.layers.addLayer(L.marker(latLng(point), { pane: state.session.pane, interactive: false, keyboard: false,
                    icon: L.divIcon({ className: 'urban-block-playground__piece-label', html: label, iconSize: null }) }));
            }
        }
        for (const feature of layout?.cuts?.features || []) {
            if (feature.geometry?.type !== 'LineString') continue;
            state.layers.addLayer(L.polyline(feature.geometry.coordinates.map(latLng), vector(`urban-block-playground__cut is-${feature.properties?.kind || 'perimeter'}`))
                .bindTooltip(t('cutTitle', '{{kind}} street · {{length}}', { kind: kindName(feature.properties?.kind), length: length(feature.properties?.lengthM) }), { sticky: true }));
        }
        for (const feature of state.candidates?.features || []) {
            if (feature.geometry?.type !== 'Point') continue;
            const kind = feature.properties?.kind || 'perimeter';
            const visible = kind === 't' ? state.showTJunctions : ['dead-end', 'dead-end-projection'].includes(kind) ? state.showDeadEnds : state.showPerimeter;
            if (!visible) continue;
            const provenance = feature.properties.provenance;
            const junction = feature.properties.junctionPoint;
            const sources = feature.properties.projectionSources;
            const description = provenance ? candidateDescription(provenance) : junction ? junctionDescription(feature.properties)
                : sources ? deadEndProjectionDescription(sources) : t('candidateTitle', '{{kind}} candidate point', { kind: kindName(kind) });
            const marker = L.circleMarker(latLng(feature.geometry.coordinates), { ...vector(`urban-block-playground__candidate is-${kind}`),
                radius: kind === 'dead-end-projection' ? 8 : 6 }).bindTooltip(description);
            if (provenance || junction || sources) {
                const inspect = () => showCandidateTrace(feature, marker);
                marker.on('mouseover', inspect);
                marker.on('click', event => { L.DomEvent.stopPropagation(event); inspect(); });
            }
            state.layers.addLayer(marker);
        }
        const selectedId = state.root.querySelector('[data-slot="pieces"] [aria-pressed="true"]')?.dataset.pieceId;
        if (selectedId) highlightPiece(selectedId);
    }

    function kindName(kind) {
        if (kind === 'dead-end-projection') return t('deadEndProjectionShort', 'Dead-end projection');
        return t(kind === 't' ? 'tJunctionShort' : kind === 'dead-end' ? 'deadEndShort' : 'perimeterShort',
            kind === 't' ? 'T-junction' : kind === 'dead-end' ? 'Dead end' : 'Perimeter');
    }

    function highlightPiece(id) {
        state.pieceLayers.forEach((piece, pieceId) => piece.eachLayer(layer => {
            layer.getElement?.()?.classList.toggle('is-highlighted', pieceId === id);
            if (pieceId === id) layer.bringToFront?.();
        }));
        state.root.querySelectorAll('[data-slot="pieces"] [data-piece-id]').forEach(row => row.setAttribute('aria-pressed', String(row.dataset.pieceId === id)));
    }

    function renderResult() {
        const root = state.root;
        const layout = state.layouts[state.selectedLayout];
        const select = root.querySelector('[data-slot="layout-select"]');
        select.replaceChildren(...state.layouts.map((_, index) => {
            const option = el('option', '', t('layoutOption', 'Layout {{number}}', { number: number(index + 1) }));
            option.value = index; return option;
        }));
        select.disabled = state.layouts.length < 2;
        select.value = String(state.selectedLayout);
        root.querySelector('[data-action="propose"]').disabled = state.proposing || !layout?.cuts?.features?.length;
        if (!layout) {
            root.querySelector('[data-slot="status"]').textContent = t('noLayout', 'No layout result was returned. Adjust settings and try again.');
            renderLegend();
            return;
        }
        const stats = state.result?.stats || {};
        const layoutStats = layout.stats || {};
        const pieces = layout.pieces?.features || [];
        const cuts = layout.cuts?.features || [];
        const acceptableCount = layoutStats.acceptableCount ?? pieces.filter(piece => piece.properties?.acceptable).length;
        const testedPairs = stats.testedPairs;
        const limited = !!(stats.limited || stats.partial);
        root.querySelector('[data-slot="layout-score"]').textContent = t('score', '{{acceptable}} of {{total}} blocks fit', { acceptable: number(acceptableCount), total: number(pieces.length) });
        root.querySelector('[data-slot="status"]').textContent = state.stale
            ? t('stale', 'Settings changed. Displayed splits use the previous settings. Generate splits to update them.')
            : stats.restored ? t('restored', 'Shared splits restored for this block.')
                : limited ? t('limited', 'Best layout found so far. Search stopped at the candidate limit.')
                    : acceptableCount < pieces.length ? t('partial', 'Best layout found so far. Some blocks remain above one or both limits.')
                        : t('complete', 'Layout search complete.');
        const metrics = root.querySelector('[data-slot="metrics"]');
        const metric = (label, value) => { const item = el('div', 'urban-block-playground__metric'); item.append(el('span', '', label), el('strong', '', value)); return item; };
        const metricRows = [
            metric(t('acceptablePlots', 'Blocks within both limits'), `${number(acceptableCount)} / ${number(pieces.length)}`),
            metric(t('cutsCount', 'New street cuts'), number(layoutStats.cutsCount ?? cuts.length)),
            metric(t('addedLength', 'Added street length'), length(layoutStats.addedLengthM ?? cuts.reduce((sum, cut) => sum + (cut.properties?.lengthM || 0), 0)))
        ];
        if (Number.isFinite(testedPairs)) metricRows.splice(3, 0, metric(t('testedPairs', 'Candidate pairs tested'), number(testedPairs)));
        metrics.replaceChildren(...metricRows);
        root.querySelector('[data-slot="pieces"]').replaceChildren(...pieces.map((feature, index) => {
            const id = String(feature.id ?? feature.properties?.id ?? index);
            const row = el('button', 'cb-option urban-block-playground__piece-row');
            row.type = 'button'; row.dataset.pieceId = id; row.setAttribute('aria-pressed', 'false');
            const palette = index % PIECE_PALETTE_SIZE;
            const chip = el('span', `urban-block-playground__piece-chip palette-${palette}`, '');
            chip.setAttribute('style', `--piece-tint: ${pieceTint(index, pieces.length)}%`);
            row.append(chip,
                el('strong', '', t('pieceRow', 'Block {{number}}', { number: number(index + 1) })),
                el('span', 'urban-block-playground__piece-area-value', area(feature.properties?.areaM2)),
                el('span', 'urban-block-playground__piece-sides', t('pieceSides', 'Longest side {{length}}', { length: length(feature.properties?.longestSideM) })),
                el('span', feature.properties?.acceptable ? 'urban-block-playground__piece-status is-acceptable' : 'urban-block-playground__piece-status is-oversized', feature.properties?.acceptable ? t('fits', 'Within limits') : t('over', 'Over a limit')));
            row.addEventListener('click', () => highlightPiece(id));
            row.addEventListener('focus', () => highlightPiece(id));
            return row;
        }));
        renderLegend();
        draw();
    }

    function renderLegend() {
        const entries = [];
        if (state.layouts.length) entries.push(
            ['is-piece-shades', t('pieceShades', 'Each shade identifies a block')],
            ['is-acceptable', t('legendAcceptable', 'Within hard limits (outline)')],
            ['is-oversized', t('legendOversized', 'Exceeds a hard limit (dashed outline)')],
            ['is-cut', t('legendCut', 'New street')]
        );
        entries.push(
            ['is-t', t('tJunctionShort', 'T-junction')],
            ['is-dead-end', t('deadEndShort', 'Dead end')],
            ['is-dead-end-projection', t('deadEndProjectionShort', 'Dead-end projection')],
            ['is-perimeter', t('perimeterShort', 'Perimeter fallback point')]
        );
        state.root.querySelector('[data-slot="legend"]').replaceChildren(...entries.map(([klass, label]) => {
            const item = el('span', 'urban-block-playground__legend-item');
            item.append(el('i', `urban-block-playground__swatch ${klass}`, ''), el('span', '', label));
            return item;
        }));
    }

    function open({ block, roads, targetAreaM2, targetSideM, subdivision, shareBaseUrl, shareError } = {}) {
        if (!block || !roads) return false;
        close();
        const { content, footer } = buildPanel();
        const session = win.OnMapEditor?.open({
            owner: 'urban-block-playground', id: 'urban-block-playground', modes: ['2d'],
            title: t('title', 'Block subdivision playground'), content, footer, onCancel: close
        });
        // Another map tool holds the map; it says so itself.
        if (!session) return false;
        session.root.classList.add('urban-block-playground');
        state.session = session;
        state.root = session.root;
        wirePanel(state.root);
        session.map.on('click', clearCandidateTrace);
        stopWorkers();
        state.block = block;
        state.roads = roads;
        state.shareBaseUrl = shareBaseUrl || null;
        state.layouts = []; state.result = null; state.selectedLayout = 0; state.stale = false;
        state.candidates = null; state.previewStats = null; state.generatedOptions = null;
        state.showTJunctions = true; state.showDeadEnds = true; state.showPerimeter = true;
        const root = state.root;
        const restoredOptions = subdivision?.options;
        const inspectorArea = Number(targetSideM ?? 100) ** 2;
        const initialArea = restoredOptions?.targetAreaM2 ?? targetAreaM2 ?? inspectorArea;
        root.querySelector('[data-setting="targetAreaM2"]').value = String(normalizeTargetArea(initialArea));
        root.querySelector('[data-setting="maxSideM"]').value = String(restoredOptions?.maxSideM ?? 150);
        root.querySelector('[data-setting="perimeterStepM"]').value = String(restoredOptions?.perimeterStepM ?? 150);
        localize(root);
        clearResultView();
        resetShare();
        root.querySelector('[data-slot="share-status"]').textContent = shareError
            ? (typeof shareError === 'boolean' ? t('invalidSharedLink', 'This shared link is invalid or incomplete.') : t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: String(shareError) }))
            : '';
        root.querySelector('[data-slot="status"]').textContent = t('initial', 'Showing candidate points. Generate splits to preview how they divide the block.');
        root.querySelector('[data-slot="preview-status"]').textContent = t('previewLoading', 'Loading candidate points…');
        session.fitFeature(block);
        draw();
        postPreview(settings(), true);
        if (subdivision) {
            root.querySelector('[data-slot="status"]').textContent = t('restoring', 'Restoring shared splits…');
            runLayoutAction('restore', subdivision.options || settings(), subdivision);
        }
        root.querySelector('[data-action="generate"]').focus({ preventScroll: true });
        return true;
    }

    win.UrbanBlocksPlayground = Object.freeze({ open, close });
})(typeof window !== 'undefined' ? window : null);
