// Interactive, read-only preview for candidate urban-block subdivision layouts.
(function (win) {
    'use strict';
    if (!win?.document) return;

    const doc = win.document;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const PIECE_PALETTE_SIZE = 8;
    const AREA_MIN_M2 = 1000;
    const AREA_MAX_M2 = 50000;
    const AREA_STEP_M2 = 125;
    const AREA_DEFAULT_M2 = 10000;
    const state = { dialog: null, previewWorker: null, planWorker: null, previewRequest: 0, planRequest: 0,
        block: null, roads: null, parcels: null, focusReturn: null, shareBaseUrl: null, layouts: [], result: null,
        candidates: null, previewStats: null, selectedLayout: 0, generatedOptions: null, stale: false,
        showTJunctions: true, showDeadEnds: true, showPerimeter: true, inspectedCandidateId: null, shareRequest: 0 };
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
    const svg = (name, attrs = {}, text) => {
        const node = doc.createElementNS(SVG_NS, name);
        Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
        if (text !== undefined) node.textContent = text;
        return node;
    };

    function buildDialog() {
        if (state.dialog) return state.dialog;
        const dialog = el('dialog', 'cb-dialog cb-dialog--xl urban-block-playground');
        dialog.setAttribute('aria-labelledby', 'urban-block-playground-title');
        dialog.innerHTML = `
            <header class="cb-dialog__header urban-block-playground__header">
                <h2 class="cb-dialog__title" id="urban-block-playground-title"></h2>
                <button type="button" class="close-circle-btn" data-action="close" aria-label=""></button>
            </header>
            <div class="cb-dialog__body urban-block-playground__body">
                <section class="urban-block-playground__chart" aria-label="">
                    <div class="urban-block-playground__chart-head"><h3 data-slot="diagram-title"></h3><span data-slot="layout-score"></span></div>
                    <p class="urban-block-playground__status" data-slot="status" role="status" aria-live="polite"></p>
                    <svg class="urban-block-playground__svg" viewBox="0 0 1000 700" role="group" preserveAspectRatio="xMidYMid meet"></svg>
                    <p class="urban-block-playground__candidate-info" data-slot="candidate-info" role="status" aria-live="polite"></p>
                    <div class="urban-block-playground__legend" data-slot="legend"></div>
                    <p class="urban-block-playground__note" data-slot="note"></p>
                </section>
                <aside class="urban-block-playground__side">
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
                </aside>
            </div>
            <footer class="cb-dialog__footer urban-block-playground__footer">
                <span data-slot="disclaimer"></span>
                <label class="urban-block-playground__share-link" data-slot="share-link" hidden>
                    <span class="urban-block-playground__share-label" data-slot="share-label"></span>
                    <input data-slot="share-url" type="url" readonly>
                </label>
                <span class="urban-block-playground__share-status" data-slot="share-status" role="status" aria-live="polite"></span>
                <button type="button" class="btn" data-action="share"></button>
            </footer>`;
        doc.body.append(dialog);
        state.dialog = dialog;
        dialog.querySelectorAll('[data-action="close"]').forEach(button => button.addEventListener('click', close));
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('close', () => {
            stopWorkers();
            state.shareRequest++;
            const focusReturn = state.focusReturn;
            state.focusReturn = null;
            focusReturn?.focus?.({ preventScroll: true });
        });
        dialog.querySelector('[data-action="generate"]').addEventListener('click', generate);
        dialog.querySelector('[data-action="share"]').addEventListener('click', share);
        dialog.querySelector('[data-slot="share-url"]').addEventListener('click', event => event.target.select());
        dialog.querySelector('svg').addEventListener('click', clearCandidateTrace);
        dialog.querySelectorAll('[data-setting="targetAreaM2"], [data-setting="maxSideM"], [data-setting="perimeterStepM"]').forEach(input => input.addEventListener('input', () => {
            updateRangeOutput(input.dataset.setting);
            if (input.dataset.setting === 'targetAreaM2') updateTargetArea();
            settingsChanged(input.dataset.setting === 'perimeterStepM');
        }));
        dialog.querySelectorAll('[data-visibility]').forEach(input => input.addEventListener('change', () => {
            state[input.dataset.visibility] = input.checked;
            draw();
        }));
        dialog.querySelector('[data-slot="layout-select"]').addEventListener('change', event => {
            state.selectedLayout = Number(event.target.value) || 0;
            resetShare();
            renderResult();
        });
        localize(dialog);
        return dialog;
    }

    function localize(dialog) {
        const set = (selector, key, fallback) => { dialog.querySelector(selector).textContent = t(key, fallback); };
        set('#urban-block-playground-title', 'title', 'Block subdivision playground');
        dialog.querySelector('.urban-block-playground__chart').setAttribute('aria-label', t('diagramLabel', 'Subdivision preview'));
        set('[data-slot="diagram-title"]', 'diagramTitle', 'Layout preview');
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
        set('[data-slot="share-label"]', 'shareLink', 'Layout link');
        set('[data-slot="layout-label"]', 'alternativeLayout', 'Alternative layout');
        set('[data-slot="pieces-title"]', 'piecesTitle', 'Blocks in this layout');
        set('[data-slot="note"]', 'sideNote', 'The longest side is measured from a fitted bounding rectangle.');
        set('[data-slot="candidate-info"]', 'candidateTraceHint', 'Hover or tap a junction or fallback point to inspect its source.');
        set('[data-slot="disclaimer"]', 'disclaimer', 'Concept geometry; street width, buildings and ownership are not checked.');
        dialog.querySelectorAll('[data-action="close"]').forEach(button => {
            button.textContent = button.classList.contains('close-circle-btn') ? '×' : t('close', 'Close');
            button.setAttribute('aria-label', t('close', 'Close'));
            button.title = t('close', 'Close');
        });
        updateRangeOutput('targetAreaM2');
        updateTargetArea();
        updateRangeOutput('maxSideM');
        updateRangeOutput('perimeterStepM');
        const svgNode = dialog.querySelector('svg');
        svgNode.setAttribute('aria-label', t('diagramLabel', 'Subdivision preview'));
    }

    function close() {
        if (state.dialog?.open) state.dialog.close();
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
        const dialog = state.dialog;
        const value = name => dialog.querySelector(`[data-setting="${name}"]`);
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
        if (!state.dialog) return;
        const value = Number(state.dialog.querySelector(`[data-setting="${name}"]`).value);
        state.dialog.querySelector(`[data-output="${name}"]`).textContent = name === 'targetAreaM2' ? area(value) : length(value);
    }

    function normalizeTargetArea(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return AREA_DEFAULT_M2;
        const clamped = Math.min(AREA_MAX_M2, Math.max(AREA_MIN_M2, numeric));
        return AREA_MIN_M2 + Math.round((clamped - AREA_MIN_M2) / AREA_STEP_M2) * AREA_STEP_M2;
    }

    function updateTargetArea() {
        if (!state.dialog) return;
        const targetArea = Number(state.dialog.querySelector('[data-setting="targetAreaM2"]').value);
        state.dialog.querySelector('[data-slot="target-area"]').textContent = t('targetAreaReadout', 'Each block must be no larger than {{area}}.', { area: area(targetArea) });
    }

    function clearResultView() {
        state.dialog.querySelector('[data-slot="layout-select"]').replaceChildren();
        state.dialog.querySelector('[data-slot="layout-select"]').disabled = true;
        state.dialog.querySelector('[data-slot="layout-score"]').textContent = '';
        state.dialog.querySelector('[data-slot="metrics"]').replaceChildren();
        state.dialog.querySelector('[data-slot="pieces"]').replaceChildren();
        renderLegend();
    }

    function setStatus(key, fallback) {
        const layout = state.layouts[state.selectedLayout];
        if (state.stale && layout) state.dialog.querySelector('[data-slot="status"]').textContent = t('stale', 'Settings changed. Displayed splits use the previous settings. Generate splits to update them.');
        else state.dialog.querySelector('[data-slot="status"]').textContent = t(key, fallback);
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
                    if (data?.action !== 'preview' || data.request !== state.previewRequest || !state.dialog.open) return;
                    if (data.error) {
                        showPreviewError(data.error);
                        return;
                    }
                    state.candidates = data.result?.candidates || { type: 'FeatureCollection', features: [] };
                    state.previewStats = data.result?.stats || {};
                    state.dialog.querySelector('[data-slot="preview-status"]').textContent = t('previewSummary', '{{t}} T-junctions · {{dead}} dead ends · {{projected}} alley projections · {{perimeter}} perimeter points', {
                        t: number(state.previewStats.tCount || 0), dead: number(state.previewStats.deadEndCount || 0),
                        projected: number(state.previewStats.deadEndProjectionCount || 0), perimeter: number(state.previewStats.fallbackCount || 0)
                    });
                    if (!state.previewStats.tCount && !state.previewStats.deadEndCount) {
                        state.dialog.querySelector('[data-slot="preview-status"]').textContent += ' ' + t('noPerimeterAnchor', 'No junction or connected alley entrance was found to start the perimeter walk.');
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
            state.dialog.querySelector('[data-slot="preview-status"]').textContent = t('previewLoading', 'Loading candidate points…');
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
        state.dialog.querySelector('[data-slot="preview-status"]').textContent = t('previewFailure', 'Could not load candidate points: {{reason}}', { reason: message });
    }

    function runLayoutAction(action, options, subdivision = null) {
        state.planWorker?.terminate();
        const request = ++state.planRequest;
        try {
            const worker = new win.Worker(win.appendBuildToken('js/urban-blocks-subdivision-worker.js'));
            state.planWorker = worker;
            worker.onmessage = ({ data }) => {
                if (request !== state.planRequest || data?.request !== request || data.action !== action || !state.dialog.open) return;
                state.planWorker?.terminate(); state.planWorker = null;
                if (data.error) {
                    if (action === 'restore') {
                        state.dialog.querySelector('[data-slot="share-status"]').textContent = t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: String(data.error) });
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
                if (action === 'restore') state.dialog.querySelector('[data-slot="share-status"]').textContent = t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: message });
                else showError(message);
            };
            worker.postMessage({ action, request, block: state.block, roads: state.roads, options, ...(subdivision ? { subdivision } : {}) });
        } catch (error) {
            if (request === state.planRequest) {
                if (action === 'restore') state.dialog.querySelector('[data-slot="share-status"]').textContent = t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: String(error.message || error) });
                else showError(error.message || error);
            }
        }
    }

    function generate() {
        const options = settings();
        resetShare();
        state.dialog.querySelector('[data-slot="status"]').textContent = t('generating', 'Generating splits…');
        runLayoutAction('plan', options);
    }

    function resetShare() {
        state.shareRequest++;
        state.dialog.querySelector('[data-slot="share-link"]').hidden = true;
        state.dialog.querySelector('[data-slot="share-url"]').value = '';
        state.dialog.querySelector('[data-slot="share-status"]').textContent = '';
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
            win.history.replaceState(win.history.state, '', url);
            // Reveal the usable artifact before asking the clipboard. A permission prompt can
            // remain pending, and mobile/insecure contexts may not expose clipboard access.
            const field = state.dialog.querySelector('[data-slot="share-url"]');
            field.value = url;
            state.dialog.querySelector('[data-slot="share-link"]').hidden = false;
            state.dialog.querySelector('[data-slot="share-status"]').textContent = t('shareReady', 'Link ready. You can copy it from the field above.');
            field.focus({ preventScroll: true });
            field.select();
            try {
                await win.navigator.clipboard.writeText(url);
                if (request === state.shareRequest) state.dialog.querySelector('[data-slot="share-status"]').textContent = t('shareCopied', 'Layout link copied.');
            } catch (error) {
                if (request === state.shareRequest) state.dialog.querySelector('[data-slot="share-status"]').textContent = t('shareCopyFailed', 'Automatic copying is unavailable. Copy the selected link above.');
                console.warn(`[${new Date().toISOString()}] [urban-block-playground] Clipboard copy failed: ${String(error?.message || error)}`);
            }
        } catch (error) {
            const message = String(error?.message || error || t('shareUnavailable', 'This block layout cannot be shared.'));
            state.dialog.querySelector('[data-slot="share-status"]').textContent = t('shareFailed', 'Could not share this layout: {{reason}}', { reason: message });
            console.warn(`[${new Date().toISOString()}] [urban-block-playground] Share failed: ${message}`);
        }
    }

    function showError(error) {
        const message = String(error || t('workerFailure', 'Could not generate layouts. Please try again.'));
        console.warn(`[${new Date().toISOString()}] [urban-block-playground] ${message}`);
        state.dialog.querySelector('[data-slot="status"]').textContent = t('workerFailureDetail', 'Could not generate layouts: {{reason}}', { reason: message });
    }

    function coordinatePairs(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return geometry.coordinates.flat();
        if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
        return [];
    }

    function projector() {
        const coords = coordinatePairs(state.block?.geometry);
        for (const candidate of state.candidates?.features || []) {
            if (candidate.properties?.junctionPoint) coords.push(candidate.properties.junctionPoint);
            for (const source of candidate.properties?.projectionSources || []) coords.push(source.sourcePoint);
        }
        if (!coords.length) return null;
        const latitude = coords.reduce((sum, point) => sum + point[1], 0) / coords.length;
        const cosine = Math.max(0.01, Math.cos(latitude * Math.PI / 180));
        const points = coords.map(([lon, lat]) => [lon * cosine, lat]);
        const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = maxX - minX || 1, h = maxY - minY || 1;
        const scale = Math.min(920 / w, 620 / h);
        const offsetX = (1000 - w * scale) / 2, offsetY = (700 - h * scale) / 2;
        return ([lon, lat]) => [offsetX + (lon * cosine - minX) * scale, 700 - offsetY - (lat - minY) * scale];
    }

    function pathForGeometry(geometry, project) {
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        return polygons.flatMap(polygon => polygon.map(ring => {
            const coords = ring.map(project);
            return coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ') + ' Z';
        })).join(' ');
    }

    function pathForLine(coordinates, project) {
        return coordinates.map((point, index) => {
            const [x, y] = project(point);
            return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(' ');
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
        state.dialog?.querySelector('.urban-block-playground__trace')?.remove();
        state.dialog?.querySelectorAll('.urban-block-playground__candidate.is-inspected').forEach(circle => circle.classList.remove('is-inspected'));
        if (state.dialog) {
            const info = state.dialog.querySelector('[data-slot="candidate-info"]');
            info.hidden = !state.showPerimeter && !state.showTJunctions && !state.showDeadEnds;
            info.textContent = t('candidateTraceHint', 'Hover or tap a junction, alley projection or fallback point to inspect its source.');
        }
    }

    function showCandidateTrace(feature, circle) {
        const p = feature.properties.provenance;
        const junction = feature.properties.junctionPoint;
        const sources = feature.properties.projectionSources;
        if (!p && !junction && !sources?.length) return;
        clearCandidateTrace();
        state.inspectedCandidateId = feature.properties.id;
        circle.classList.add('is-inspected');
        const root = state.dialog.querySelector('svg'), project = projector();
        const trace = svg('g', { class: `urban-block-playground__trace${sources ? ' is-dead-end-projection' : ''}`, 'aria-hidden': 'true' });
        const traces = sources ? sources.map(source => ({ path: [source.sourcePoint, feature.geometry.coordinates],
            source: source.sourcePoint, measured: source.lengthM })) : [{
            path: p?.perimeterPath || [junction, feature.geometry.coordinates],
            source: p?.sourcePoint || junction, measured: p ? p.perimeterLengthM : feature.properties.projectionDistanceM
        }];
        for (const item of traces) {
            if (item.measured > 0.02) trace.append(svg('path', { d: pathForLine(item.path, project), class: p ? 'urban-block-playground__trace-perimeter' : 'urban-block-playground__trace-projection' }));
            const source = project(item.source), target = project(feature.geometry.coordinates);
            trace.append(svg('circle', { cx: source[0], cy: source[1], r: 13, class: 'urban-block-playground__trace-source' }));
            const [x, y] = sources ? source.map((value, i) => (value + target[i]) / 2) : target;
            trace.append(svg('text', { x: Math.max(28, Math.min(900, x + 20)), y: y < 75 ? y + 36 : y - 20,
                class: 'urban-block-playground__trace-label' }, length(item.measured)));
        }
        root.insertBefore(trace, root.querySelector('.urban-block-playground__candidates'));
        state.dialog.querySelector('[data-slot="candidate-info"]').textContent = p ? candidateDescription(p)
            : sources ? deadEndProjectionDescription(sources) : junctionDescription(feature.properties);
    }

    function draw() {
        const root = state.dialog?.querySelector('svg');
        if (!root) return;
        clearCandidateTrace();
        root.replaceChildren();
        const project = projector();
        if (!project) return;
        const blockPath = pathForGeometry(state.block.geometry, project);
        const defs = svg('defs');
        const clip = svg('clipPath', { id: 'urban-block-playground-block-clip', clipPathUnits: 'userSpaceOnUse' });
        clip.append(svg('path', { d: blockPath, 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' }));
        defs.append(clip);
        root.append(defs);
        const outline = svg('path', { d: blockPath, class: 'urban-block-playground__outline' });
        root.append(outline);
        const layout = state.layouts[state.selectedLayout];
        if (layout) {
            const pieces = svg('g', { class: 'urban-block-playground__piece-layer' });
            const features = layout.pieces?.features || [];
            for (const [index, feature] of features.entries()) {
                const id = String(feature.id ?? feature.properties?.id ?? index);
                const palette = index % PIECE_PALETTE_SIZE;
                const properties = feature.properties || {};
                const pieceArea = area(properties.areaM2);
                const withinLimits = !!properties.acceptable;
                const title = t('pieceTitle', 'Block {{number}} · {{area}} · {{status}}', {
                    number: number(index + 1), area: pieceArea,
                    status: withinLimits ? t('fits', 'Within limits') : t('over', 'Over a limit')
                });
                const path = svg('path', { d: pathForGeometry(feature.geometry, project),
                    class: `urban-block-playground__piece palette-${palette} ${withinLimits ? 'is-acceptable' : 'is-oversized'}`,
                    'data-piece-id': id, role: 'img', 'aria-label': title, style: `--piece-tint: ${pieceTint(index, features.length)}%` });
                path.append(svg('title', {}, title));
                pieces.append(path);
            }
            root.append(pieces);
        }
        const parcelLayer = svg('g', { class: 'urban-block-playground__parcels', 'clip-path': 'url(#urban-block-playground-block-clip)', 'pointer-events': 'none' });
        for (const feature of state.parcels?.features || []) {
            if (!['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) continue;
            parcelLayer.append(svg('path', { d: pathForGeometry(feature.geometry, project), class: 'urban-block-playground__parcel-border' }));
        }
        root.append(parcelLayer);
        const roads = (state.roads?.features || []).filter(road => win.UrbanBlocksModel.isGroundRoad(road.properties));
        const roadPath = roads.flatMap(road => road.geometry?.type === 'LineString' ? [road.geometry.coordinates]
            : road.geometry?.type === 'MultiLineString' ? road.geometry.coordinates : []).map(line => pathForLine(line, project)).join(' ');
        root.append(svg('path', { d: roadPath, class: 'urban-block-playground__roads' }));
        const labels = svg('g', { class: 'urban-block-playground__piece-labels', 'aria-hidden': 'true', 'pointer-events': 'none' });
        for (const [index, feature] of (layout?.pieces?.features || []).entries()) {
            const point = feature.properties?.labelPoint;
            if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(value => typeof value === 'number' && Number.isFinite(value))) continue;
            const [x, y] = project(point);
            labels.append(svg('text', { x, y, class: `urban-block-playground__piece-area palette-${index % PIECE_PALETTE_SIZE}` }, area(feature.properties?.areaM2)));
        }
        root.append(labels);
        const cutGroup = svg('g', { class: 'urban-block-playground__cuts' });
        for (const feature of layout?.cuts?.features || []) {
            if (feature.geometry?.type !== 'LineString') continue;
            const d = pathForLine(feature.geometry.coordinates, project);
            const path = svg('path', { d, class: `urban-block-playground__cut is-${feature.properties?.kind || 'perimeter'}` });
            path.append(svg('title', {}, t('cutTitle', '{{kind}} street · {{length}}', { kind: kindName(feature.properties?.kind), length: length(feature.properties?.lengthM) })));
            cutGroup.append(path);
        }
        root.append(cutGroup);
        const candidates = svg('g', { class: 'urban-block-playground__candidates' });
        for (const feature of state.candidates?.features || []) {
            if (feature.geometry?.type !== 'Point') continue;
            const kind = feature.properties?.kind || 'perimeter';
            const visible = kind === 't' ? state.showTJunctions : ['dead-end', 'dead-end-projection'].includes(kind) ? state.showDeadEnds : state.showPerimeter;
            if (!visible) continue;
            const [x, y] = project(feature.geometry.coordinates);
            const circle = svg('circle', { cx: x, cy: y, r: kind === 'dead-end-projection' ? 11 : 8,
                class: `urban-block-playground__candidate is-${kind}`, 'data-candidate-id': feature.properties.id });
            const provenance = feature.properties.provenance;
            const junction = feature.properties.junctionPoint;
            const sources = feature.properties.projectionSources;
            const description = provenance ? candidateDescription(provenance) : junction ? junctionDescription(feature.properties)
                : sources ? deadEndProjectionDescription(sources) : t('candidateTitle', '{{kind}} candidate point', { kind: kindName(kind) });
            circle.append(svg('title', {}, description));
            if (provenance || junction || sources) {
                circle.setAttribute('tabindex', '0');
                circle.setAttribute('role', 'button');
                circle.setAttribute('aria-label', description);
                circle.setAttribute('data-method', provenance?.method || (sources ? 'dead-end-projection' : 'junction-projection'));
                const inspect = () => showCandidateTrace(feature, circle);
                circle.addEventListener('pointerenter', inspect);
                circle.addEventListener('focus', inspect);
                circle.addEventListener('pointerleave', () => {
                    if (doc.activeElement !== circle && state.inspectedCandidateId === feature.properties.id) clearCandidateTrace();
                });
                circle.addEventListener('blur', () => {
                    if (state.inspectedCandidateId === feature.properties.id) clearCandidateTrace();
                });
                circle.addEventListener('click', event => { event.stopPropagation(); circle.focus({ preventScroll: true }); inspect(); });
                circle.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(); }
                });
            }
            candidates.append(circle);
        }
        root.append(candidates);
        const selectedId = state.dialog.querySelector('[data-slot="pieces"] [aria-pressed="true"]')?.dataset.pieceId;
        if (selectedId) highlightPiece(selectedId);
    }

    function kindName(kind) {
        if (kind === 'dead-end-projection') return t('deadEndProjectionShort', 'Dead-end projection');
        return t(kind === 't' ? 'tJunctionShort' : kind === 'dead-end' ? 'deadEndShort' : 'perimeterShort',
            kind === 't' ? 'T-junction' : kind === 'dead-end' ? 'Dead end' : 'Perimeter');
    }

    function highlightPiece(id) {
        state.dialog.querySelectorAll('.urban-block-playground__piece').forEach(path => path.classList.toggle('is-highlighted', path.dataset.pieceId === id));
        state.dialog.querySelectorAll('[data-slot="pieces"] [data-piece-id]').forEach(row => row.setAttribute('aria-pressed', String(row.dataset.pieceId === id)));
    }

    function renderResult() {
        const dialog = state.dialog;
        const layout = state.layouts[state.selectedLayout];
        const select = dialog.querySelector('[data-slot="layout-select"]');
        select.replaceChildren(...state.layouts.map((_, index) => {
            const option = el('option', '', t('layoutOption', 'Layout {{number}}', { number: number(index + 1) }));
            option.value = index; return option;
        }));
        select.disabled = state.layouts.length < 2;
        select.value = String(state.selectedLayout);
        if (!layout) {
            dialog.querySelector('[data-slot="status"]').textContent = t('noLayout', 'No layout result was returned. Adjust settings and try again.');
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
        dialog.querySelector('[data-slot="layout-score"]').textContent = t('score', '{{acceptable}} of {{total}} blocks fit', { acceptable: number(acceptableCount), total: number(pieces.length) });
        dialog.querySelector('[data-slot="status"]').textContent = state.stale
            ? t('stale', 'Settings changed. Displayed splits use the previous settings. Generate splits to update them.')
            : stats.restored ? t('restored', 'Shared splits restored for this block.')
                : limited ? t('limited', 'Best layout found so far. Search stopped at the candidate limit.')
                    : acceptableCount < pieces.length ? t('partial', 'Best layout found so far. Some blocks remain above one or both limits.')
                        : t('complete', 'Layout search complete.');
        const metrics = dialog.querySelector('[data-slot="metrics"]');
        const metric = (label, value) => { const item = el('div', 'urban-block-playground__metric'); item.append(el('span', '', label), el('strong', '', value)); return item; };
        const metricRows = [
            metric(t('acceptablePlots', 'Blocks within both limits'), `${number(acceptableCount)} / ${number(pieces.length)}`),
            metric(t('cutsCount', 'New street cuts'), number(layoutStats.cutsCount ?? cuts.length)),
            metric(t('addedLength', 'Added street length'), length(layoutStats.addedLengthM ?? cuts.reduce((sum, cut) => sum + (cut.properties?.lengthM || 0), 0)))
        ];
        if (Number.isFinite(testedPairs)) metricRows.splice(3, 0, metric(t('testedPairs', 'Candidate pairs tested'), number(testedPairs)));
        metrics.replaceChildren(...metricRows);
        dialog.querySelector('[data-slot="pieces"]').replaceChildren(...pieces.map((feature, index) => {
            const id = String(feature.id ?? feature.properties?.id ?? index);
            const row = el('button', 'urban-block-playground__piece-row');
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
        if (state.parcels?.features?.length) entries.push(['is-parcel', t('parcelBoundaries', 'Cadastral parcel boundaries')]);
        entries.push(
            ['is-road', t('legendRoad', 'Existing street')],
            ['is-t', t('tJunctionShort', 'T-junction')],
            ['is-dead-end', t('deadEndShort', 'Dead end')],
            ['is-dead-end-projection', t('deadEndProjectionShort', 'Dead-end projection')],
            ['is-perimeter', t('perimeterShort', 'Perimeter fallback point')]
        );
        state.dialog.querySelector('[data-slot="legend"]').replaceChildren(...entries.map(([klass, label]) => {
            const item = el('span', 'urban-block-playground__legend-item');
            item.append(el('i', `urban-block-playground__swatch ${klass}`, ''), el('span', '', label));
            return item;
        }));
    }

    function setParcels(parcels) {
        state.parcels = parcels?.type === 'FeatureCollection' && Array.isArray(parcels.features)
            ? parcels : { type: 'FeatureCollection', features: [] };
        if (state.dialog?.open) {
            renderLegend();
            draw();
        }
    }

    function open({ block, roads, parcels, targetAreaM2, targetSideM, subdivision, shareBaseUrl, shareError } = {}) {
        if (!block || !roads) return false;
        const dialog = buildDialog();
        stopWorkers();
        state.block = block;
        state.roads = roads;
        state.parcels = parcels?.type === 'FeatureCollection' && Array.isArray(parcels.features)
            ? parcels : { type: 'FeatureCollection', features: [] };
        state.shareBaseUrl = shareBaseUrl || null;
        state.layouts = []; state.result = null; state.selectedLayout = 0; state.stale = false;
        state.candidates = null; state.previewStats = null; state.generatedOptions = null;
        state.showTJunctions = true; state.showDeadEnds = true; state.showPerimeter = true;
        clearResultView();
        resetShare();
        state.dialog.querySelector('[data-slot="share-status"]').textContent = shareError
            ? (typeof shareError === 'boolean' ? t('invalidSharedLink', 'This shared link is invalid or incomplete.') : t('restoreError', 'Could not restore shared splits: {{reason}}', { reason: String(shareError) }))
            : '';
        const restoredOptions = subdivision?.options;
        const inspectorArea = Number(targetSideM ?? 100) ** 2;
        const initialArea = restoredOptions?.targetAreaM2 ?? targetAreaM2 ?? inspectorArea;
        dialog.querySelector('[data-setting="targetAreaM2"]').value = String(normalizeTargetArea(initialArea));
        dialog.querySelector('[data-setting="maxSideM"]').value = String(restoredOptions?.maxSideM ?? 150);
        dialog.querySelector('[data-setting="perimeterStepM"]').value = String(restoredOptions?.perimeterStepM ?? 150);
        dialog.querySelector('[data-visibility="showTJunctions"]').checked = true;
        dialog.querySelector('[data-visibility="showDeadEnds"]').checked = true;
        dialog.querySelector('[data-visibility="showPerimeter"]').checked = true;
        localize(dialog);
        dialog.querySelector('[data-slot="status"]').textContent = t('initial', 'Showing candidate points. Generate splits to preview how they divide the block.');
        dialog.querySelector('[data-slot="preview-status"]').textContent = t('previewLoading', 'Loading candidate points…');
        if (!dialog.open) {
            state.focusReturn = doc.activeElement;
            dialog.showModal();
        }
        dialog.querySelector('.urban-block-playground__body').scrollTop = 0;
        dialog.querySelector('.urban-block-playground__side').scrollTop = 0;
        updateTargetArea();
        updateRangeOutput('maxSideM'); updateRangeOutput('perimeterStepM');
        draw();
        postPreview(settings(), true);
        if (subdivision) {
            dialog.querySelector('[data-slot="status"]').textContent = t('restoring', 'Restoring shared splits…');
            runLayoutAction('restore', subdivision.options || settings(), subdivision);
        }
        dialog.querySelector('[data-action="generate"]').focus({ preventScroll: true });
        return true;
    }

    win.UrbanBlocksPlayground = Object.freeze({ open, close, updateParcels: setParcels });
})(typeof window !== 'undefined' ? window : null);
