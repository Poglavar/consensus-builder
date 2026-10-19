// One comparison control, source selection and viewport feed for the map and model views.
// Source results are read-only overlays: viewing them never applies a parcel/fabric mutation.
(function (root) {
    'use strict';
    const core = root.PlanningScene;
    const sharedLabels = { existing: 'threeMode.controls.built', proposed: 'threeMode.parcelPanel.proposed',
        solid: 'threeMode.controls.stateSolid', ghost: 'threeMode.controls.stateGhost', off: 'threeMode.controls.stateOff',
        surviving: 'threeMode.controls.stateSurviving', removed: 'threeMode.controls.stateRemoved',
        massing: 'threeMode.controls.representationMassing', buildout: 'threeMode.controls.representationBuildOut',
        both: 'threeMode.controls.representationBoth', all: 'activityFeed.all', reroll: 'threeMode.controls.reroll', retry: 'bets.retry' };
    const t = (key, params = {}) => root.i18n.t(sharedLabels[key] || `planningViews.${key}`, params);
    let store, items = [], payload = null, status = 'loading', layer, controller, request = 0, loadedKey = '';
    let panel, inspector, lastSettings = null, lastSelectedId = null, ready = false;
    let progress = null;
    const number = value => typeof value === 'number' && Number.isFinite(value)
        ? root.CbFormat.formatNumber(value, { maxFractionDigits: 0 }) : '—';
    const area = value => typeof value === 'number' && Number.isFinite(value)
        ? root.CbFormat.formatArea(value, { maxFractionDigits: 0 }) : '—';
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function color(role) {
        return getComputedStyle(document.documentElement).getPropertyValue(`--cb-planning-${role}`).trim();
    }
    function policy() { return core.displayPolicy(store?.get()); }
    function selected() { return items.find(item => item.id === store?.get().selectedId) || null; }
    function notifyGeometry() { root.dispatchEvent(new CustomEvent('planninggeometrychange')); }
    function select(id) {
        if (id && !items.some(item => item.id === id)) return;
        if (id) {
            root.ProposalSelection?.clear();
            root.Parcels?.uiParcelPanel?.hideParcelInfoPanel?.();
            root.hideProposalDetailsPanel?.();
            root.hideRoadInfoPanel?.();
        }
        store.select(id);
    }
    function drawMap() {
        if (!ready) return;
        layer.clearLayers();
        if (policy().permitted === 'off') return;
        for (const item of items) {
            let features;
            try { features = core.mapFeatures(item, store.get().permittedMap, root.turf); }
            catch (error) { console.error('[planning] Could not project massing', item.id, error); continue; }
            for (const feature of features) {
                const active = item.id === store.get().selectedId;
                const shape = root.L.geoJSON(feature, { pane: 'planningSources',
                    style: { color: color('permitted'), weight: active ? 3 : 1.5,
                        fillColor: color('permitted'), fillOpacity: policy().permitted === 'solid' ? 1 : 0.18,
                        opacity: 1 } });
                const height = feature.properties.topM;
                const label = item.source.parcel || item.title;
                const tooltip = item.assessment.meaning === 'existing-stock-estimate' ? `${label} · ${t('stockBadge')}`
                    : height ? `${label} · ${root.CbFormat.formatLength(height)}` : label;
                shape.bindTooltip(tooltip, { sticky: true, direction: 'top' });
                const inspect = () => { if (!root.__mapEditLock?.isHeld()) select(item.id); };
                shape.on('click', event => { root.L.DomEvent.stopPropagation(event); inspect(); });
                shape.addTo(layer);
                shape.eachLayer(part => {
                    const node = part.getElement?.();
                    if (!node) return;
                    node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
                    node.setAttribute('aria-label', t('inspectMassing', { parcel: label }));
                    node.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); inspect(); }
                    });
                });
            }
        }
    }
    function isPhoto() { return root.__mapModeState?.desired === 'photo'; }
    function stateText() {
        if (isPhoto()) return t('photoNote');
        if (policy().permitted === 'off') return t('permittedOff');
        if (status === 'loading' && progress?.total) return t('loadingProgress', progress);
        if (status !== 'ready') return t(status);
        if (!payload?.sources?.length) return t('unavailable');
        if (!items.length) return t('empty');
        if (payload.omitted) return t('partial', { count: items.length });
        return t('loaded', { count: items.length });
    }
    function renderInspector() {
        const item = selected();
        inspector.hidden = !item || policy().permitted === 'off' || isPhoto();
        inspector.replaceChildren();
        if (!item) return;
        const header = element('header', 'planning-inspector__header');
        const heading = element('div');
        heading.append(element('p', 'planning-eyebrow', t('sourceProposal')), element('h2', '', item.title));
        const close = element('button', 'close-circle-btn', '×');
        close.type = 'button'; close.setAttribute('aria-label', t('close'));
        close.addEventListener('click', () => { select(null); panel.querySelector('[data-planning-setting="permitted"]')?.focus(); });
        header.append(heading, close);
        inspector.append(header);
        const badges = element('div', 'planning-inspector__badges');
        badges.append(element('span', 'cb-badge', t('obligatory')), element('span', 'cb-badge cb-badge--warning',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockBadge' : 'approximate')));
        inspector.append(badges, element('p', 'planning-inspector__description',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockEstimate' : 'oneOption')));
        const metrics = element('dl', 'planning-metrics');
        const unitLimit = item.constraints?.find(constraint => constraint.quantity === 'dwellings')?.value;
        for (const [label, value] of [[t('floorArea'), area(item.metrics.floorAreaM2)],
            [t('height'), root.CbFormat.formatLength(item.metrics.heightM, { maxFractionDigits: 1 })],
            [t('dwellingLimit'), number(unitLimit)]]) {
            const entry = element('div'); entry.append(element('dt', '', label), element('dd', '', value)); metrics.append(entry);
        }
        inspector.append(metrics);
        const heights = [...new Set(item.volumes.map(volume => volume.topM))].sort((a, b) => a - b);
        if (heights.length > 1) inspector.append(element('p', 'planning-inspector__description', t('heightParts', { heights: heights.map(height => root.CbFormat.formatLength(height)).join(' · ') })));
        const assessment = element('div', 'planning-assessment');
        assessment.append(element('strong', '', t('conditionsTitle')), element('p', '', t('conditionsNote')));
        inspector.append(assessment);
        if (item.constraints?.length) {
            const limits = element('dl', 'planning-limits');
            for (const constraint of item.constraints) {
                const value = constraint.unit === 'm2' ? area(constraint.value)
                    : constraint.unit === 'percent' ? `${number(constraint.value)}%` : number(constraint.value);
                limits.append(element('dt', '', t(`constraint.${constraint.quantity}`)), element('dd', '', value));
            }
            inspector.append(limits);
        }
        const evidence = element('details', 'planning-evidence');
        evidence.append(element('summary', '', t('sourceDetails')));
        evidence.append(element('p', '', item.source.label));
        if (item.source.computedAt) evidence.append(element('p', '', t('computed', { date: root.CbFormat.formatDate(item.source.computedAt) })));
        if (item.source.solverVersion) evidence.append(element('p', '', t('solverVersion', { version: item.source.solverVersion })));
        if (item.source.parcel) evidence.append(element('p', '', item.source.parcel));
        // Source terms remain inspectable even when an adapter has no executable constraint mapping.
        if (item.sourceEvidence) {
            const terms = element('pre', 'planning-evidence__terms', JSON.stringify(item.sourceEvidence, null, 2));
            evidence.append(element('p', '', t('sourceTerms')), terms);
        }
        inspector.append(evidence);
        const footer = element('footer', 'planning-inspector__footer');
        const link = element('a', 'cb-link cb-link--external', t('readSource'));
        link.href = item.source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        footer.append(link);
        inspector.append(footer);
    }
    function render() {
        if (!ready) return;
        panel.querySelector('.planning-eyebrow').textContent = t('title');
        const reroll = panel.querySelector('.planning-reroll');
        reroll.title = t('reroll'); reroll.setAttribute('aria-label', t('reroll'));
        reroll.disabled = policy().proposed === 'off';
        for (const role of core.roles) {
            panel.querySelector(`[data-role-label="${role}"]`).textContent = t(role);
            const select = panel.querySelector(`[data-planning-setting="${role}"]`);
            select.setAttribute('aria-label', t('displayLabel', { role: t(role) }));
        }
        panel.querySelectorAll('[data-planning-setting]').forEach(select => {
            select.value = store.get()[select.dataset.planningSetting];
            for (const option of select.options) option.textContent = t(option.value);
        });
        for (const key of ['existingScope', 'proposedForm', 'permittedMap']) {
            panel.querySelector(`[data-planning-setting="${key}"]`).setAttribute('aria-label', t(key));
        }
        panel.querySelector('[data-planning-setting="permittedMap"]').hidden = root.__mapModeState?.desired === 'model' || isPhoto();
        panel.querySelector('.planning-view-status').textContent = stateText();
        panel.querySelector('.planning-view-status').setAttribute('aria-busy', String(status === 'loading' && policy().permitted !== 'off'));
        const retry = panel.querySelector('.planning-view-retry');
        retry.hidden = status !== 'error' || policy().permitted === 'off'; retry.textContent = t('retry');
        panel.querySelector('.planning-coverage summary').textContent = t('coverageTitle');
        panel.querySelector('.planning-coverage p').textContent = t('coverageNote');
        const summary = panel.querySelector('.planning-cache-summary');
        const summaries = payload?.summaries || [];
        summary.hidden = !summaries.length || policy().permitted === 'off';
        summary.textContent = t('cacheSummary', { count: summaries.reduce((sum, entry) => sum + entry.cachedResults, 0),
            shapes: summaries.reduce((sum, entry) => sum + entry.withGeometry, 0),
            missing: summaries.reduce((sum, entry) => sum + entry.withoutGeometry, 0) });
        const counts = panel.querySelector('.planning-result-counts');
        counts.replaceChildren();
        for (const entry of summaries) for (const [status, count] of Object.entries(entry.statuses)) {
            const key = `planningViews.resultStatus.${status}`;
            const label = root.i18n.t(key);
            counts.append(element('dt', '', label === key ? t('otherResult') : label), element('dd', '', number(count)));
        }
        panel.querySelector('.planning-inspect-hint').textContent = t('inspectHint');
        panel.querySelector('.planning-inspect-hint').hidden = policy().permitted === 'off' || !items.length || isPhoto();
        const model = panel.querySelector('.planning-open-model');
        model.hidden = !isPhoto(); model.textContent = t('openModel');
        renderInspector();
    }
    function syncView() {
        const state = store.get();
        const view = policy();
        document.body.dataset.planningProposed = view.proposed;
        document.body.dataset.planningExisting = view.existing;
        document.body.dataset.planningExistingScope = state.existingScope;
        const signature = JSON.stringify({ ...core.settings(state), variation: state.variation });
        const settingsChanged = lastSettings !== signature;
        if (settingsChanged) {
            const previous = lastSettings ? JSON.parse(lastSettings) : {};
            lastSettings = signature;
            try { root.PersistentStorage.setItem('cb_planning_display', JSON.stringify(core.settings(state))); } catch (_) { }
            const url = new URL(location.href); url.searchParams.delete('planning');
            for (const [key, value] of Object.entries(core.settings(state))) url.searchParams.set(key, value);
            history.replaceState(history.state, '', url);
            const proposed = document.getElementById('showProposedBuildings');
            if (proposed && !proposed.checked && view.proposed !== 'off') { proposed.checked = true; root.toggleLayer?.('proposedBuildings'); }
            const existing = document.getElementById('showBuildings');
            if (existing && !existing.checked && view.existing !== 'off') { existing.checked = true; root.toggleLayer?.('buildings'); }
            if (previous.existingScope !== state.existingScope) root.rebuildBuildingLayerFromPool?.();
            if (previous.proposedForm !== state.proposedForm || previous.variation !== state.variation) {
                root.updateProposedBuildingsLayer?.({ announce: false });
            }
            root.dispatchEvent(new CustomEvent('planningviewchange', { detail: { settings: core.settings(state), policy: view } }));
        }
        drawMap(); render();
        if (lastSelectedId !== state.selectedId) {
            lastSelectedId = state.selectedId;
            root.dispatchEvent(new CustomEvent('planningselectionchange', { detail: { id: state.selectedId } }));
        }
        if (settingsChanged && view.permitted !== 'off') refresh();
    }
    async function refresh({ force = false } = {}) {
        if (!ready || policy().permitted === 'off') return;
        if (root.map.getZoom() < 16) {
            controller?.abort(); request++; loadedKey = ''; items = []; status = 'zoom'; payload = null;
            store.select(null); drawMap(); render(); notifyGeometry(); return;
        }
        const city = root.CityConfigManager.getCurrentCityId();
        const bounds = root.map.getBounds();
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        const key = core.queryKey(city, bbox);
        if (!force && key === loadedKey) return;
        loadedKey = key;
        controller?.abort(); controller = new AbortController();
        const generation = ++request;
        status = 'loading'; progress = null; render();
        try {
            const url = new URL(`${root.getBackendBase()}/planning/representations`);
            url.searchParams.set('city', city); url.searchParams.set('bbox', bbox.join(','));
            const answer = await root.PlanningFeed.loadViewport(url, { city, signal: controller.signal,
                onProgress(value) { if (generation === request) { progress = value; render(); } } });
            if (generation !== request) return;
            payload = answer; items = answer.items; status = 'ready';
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
        } catch (error) {
            if (generation !== request || error.name === 'AbortError') return;
            if (error.status === 400) {
                items = []; payload = null; status = 'zoom';
                store.select(null); drawMap(); render(); notifyGeometry(); return;
            }
            console.error('[planning] Could not load source representations', error);
            loadedKey = ''; items = []; payload = null; status = 'error';
            store.select(null); drawMap(); render(); notifyGeometry();
        }
    }
    function init() {
        if (ready) return;
        let saved = {};
        try { saved = JSON.parse(root.PersistentStorage.getItem('cb_planning_display') || '{}'); } catch (_) { }
        const params = new URLSearchParams(location.search);
        for (const key of Object.keys(core.defaults)) if (params.has(key)) saved[key] = params.get(key);
        store = core.createStore(saved);
        panel = document.getElementById('planning-views');
        inspector = document.getElementById('planning-inspector');
        const controls = panel.querySelector('.planning-layer-controls');
        const details = { existing: 'existingScope', permitted: 'permittedMap', proposed: 'proposedForm' };
        function control(key) {
            const input = element('select', 'planning-layer-select'); input.dataset.planningSetting = key;
            for (const value of core.choices[key]) input.add(new Option(t(value), value));
            input.addEventListener('change', () => store.configure(key, input.value));
            return input;
        }
        for (const role of core.roles) {
            const row = element('div', 'planning-layer-row');
            const label = element('span', 'planning-layer-label'); label.dataset.roleLabel = role;
            const swatch = element('span', `planning-swatch planning-swatch--${role}`); swatch.setAttribute('aria-hidden', 'true');
            const name = element('div', 'planning-layer-name'); name.append(swatch, label);
            row.append(name, control(role), control(details[role])); controls.append(row);
        }
        panel.querySelector('.planning-reroll').addEventListener('click', () => store.reroll());
        panel.querySelector('.planning-open-model').addEventListener('click', () => root.requestMapMode('model'));
        panel.querySelector('.planning-view-retry').addEventListener('click', () => refresh({ force: true }));
        root.map.createPane('planningSources');
        root.map.getPane('planningSources').classList.add('planning-sources-pane');
        layer = root.L.featureGroup().addTo(root.map);
        ready = true; panel.hidden = false;
        // Keep the phone sheet below these controls even when coverage text expands or wraps.
        new ResizeObserver(() => document.documentElement.style.setProperty('--planning-panel-height', `${panel.offsetHeight}px`)).observe(panel);
        store.subscribe(syncView);
        root.map.on('moveend', () => refresh());
        root.map.on('click', () => select(null));
        root.addEventListener('cityChanged', () => {
            controller?.abort(); request++; loadedKey = ''; items = []; payload = null; status = 'loading';
            store.select(null); drawMap(); render(); notifyGeometry(); refresh();
        });
        root.addEventListener('proposedBuildingsUpdated', render);
        root.addEventListener('i18n:translationsLoaded', render);
        root.addEventListener('mapmodechange', render);
        root.addEventListener('keydown', event => {
            if (event.key === 'Escape' && selected() && !event.defaultPrevented) { select(null); event.preventDefault(); }
        });
        root.whenAppBooted().then(() => root.ProposalSelection?.subscribe(proposal => { if (proposal) select(null); }));
        syncView();
    }
    root.PlanningViews = { getState: () => store?.get() || { ...core.defaults, variation: '' }, getPolicy: policy, getItems: () => items,
        getSelected: selected, select, color, refresh, configure: (key, value) => store?.configure(key, value), reroll: () => store?.reroll() };
    root.whenMapCoreReady().then(init);
})(window);
