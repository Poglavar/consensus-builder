// One comparison control, source selection and viewport feed for the map and model views.
// Source proposals are read-only overlays: viewing them never applies a parcel/fabric mutation.
(function (root) {
    'use strict';
    const core = root.PlanningScene;
    const sharedLabels = { proposed: 'threeMode.parcelPanel.proposed', compare: 'parcelCompare.bar.compare', retry: 'bets.retry' };
    const t = (key, params = {}) => root.i18n.t(sharedLabels[key] || `planningViews.${key}`, params);
    let store, items = [], payload = null, status = 'loading', layer, controller, request = 0, loadedKey = '';
    let panel, inspector, lastMode = null, lastSelectedId = null, ready = false;
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
    function policy() { return core.displayPolicy(store?.get().mode); }
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
            for (const feature of core.volumeFeatures(item)) {
                const active = item.id === store.get().selectedId;
                const shape = root.L.geoJSON(feature, { pane: 'planningSources',
                    style: { color: color('permitted'), weight: active ? 3 : 1.5,
                        fillColor: color('permitted'), fillOpacity: active ? 0.36 : policy().permitted === 'solid' ? 0.23 : 0.1,
                        opacity: active ? 1 : 0.8, dashArray: active ? null : '5 3' } });
                shape.bindTooltip(item.title, { sticky: true, direction: 'top' });
                shape.on('click', event => {
                    if (root.__mapEditLock?.isHeld()) return;
                    root.L.DomEvent.stopPropagation(event);
                    select(item.id);
                });
                shape.addTo(layer);
            }
        }
    }
    function isPhoto() { return root.__mapModeState?.desired === 'photo'; }
    function stateText() {
        if (isPhoto()) return t('photoNote');
        if (store.get().mode === 'existing') return t('existingNote');
        if (store.get().mode === 'proposed') return t(root.proposedBuildings?.length ? 'proposedNote' : 'noProposals');
        if (status !== 'ready') return t(status);
        if (!payload?.sources?.length) return t('unavailable');
        if (!items.length) return t('empty');
        if (payload.truncated) return t('truncated', { count: items.length });
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
        close.addEventListener('click', () => { select(null); panel.querySelector('[aria-pressed="true"]')?.focus(); });
        header.append(heading, close);
        inspector.append(header);
        const badges = element('div', 'planning-inspector__badges');
        badges.append(element('span', 'cb-badge', t('obligatory')), element('span', 'cb-badge cb-badge--warning', t('approximate')));
        inspector.append(badges, element('p', 'planning-inspector__description', t('oneOption')));
        const metrics = element('dl', 'planning-metrics');
        const unitLimit = item.constraints?.find(constraint => constraint.quantity === 'dwellings')?.value;
        for (const [label, value] of [[t('floorArea'), area(item.metrics.floorAreaM2)],
            [t('height'), root.CbFormat.formatLength(item.metrics.heightM, { maxFractionDigits: 1 })],
            [t('dwellingLimit'), number(unitLimit)]]) {
            const entry = element('div'); entry.append(element('dt', '', label), element('dd', '', value)); metrics.append(entry);
        }
        inspector.append(metrics);
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
        if (item.source.parcel) evidence.append(element('p', '', item.source.parcel));
        // Source terms remain inspectable even when an adapter has no executable constraint mapping.
        if (item.sourceEvidence?.variables) {
            const terms = element('pre', 'planning-evidence__terms', JSON.stringify(item.sourceEvidence.variables, null, 2));
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
        panel.querySelectorAll('[data-planning-mode]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.planningMode === store.get().mode));
            button.querySelector('span:last-child').textContent = t(button.dataset.planningMode);
        });
        panel.querySelector('.planning-view-status').textContent = stateText();
        panel.querySelector('.planning-view-status').setAttribute('aria-busy', String(status === 'loading'));
        const retry = panel.querySelector('.planning-view-retry');
        retry.hidden = status !== 'error'; retry.textContent = t('retry');
        const picker = panel.querySelector('.planning-source-picker');
        picker.hidden = !items.length || policy().permitted === 'off' || isPhoto();
        picker.setAttribute('aria-label', t('inspect'));
        const options = [new Option(t('inspect'), '')];
        for (const item of items) options.push(new Option(`${item.title} · ${item.source.parcel || item.proposalId}`, item.id));
        picker.replaceChildren(...options);
        picker.value = store.get().selectedId || '';
        const model = panel.querySelector('.planning-open-model');
        model.hidden = !isPhoto(); model.textContent = t('openModel');
        renderInspector();
    }
    function syncView() {
        const state = store.get();
        const view = policy();
        document.body.dataset.planningView = state.mode;
        document.body.dataset.planningProposed = view.proposed;
        document.body.dataset.planningExisting = view.existing;
        const modeChanged = lastMode !== state.mode;
        if (modeChanged) {
            lastMode = state.mode;
            try { root.PersistentStorage.setItem('cb_planning_view', state.mode); } catch (_) { }
            const url = new URL(location.href); url.searchParams.set('planning', state.mode);
            history.replaceState(history.state, '', url);
            const proposed = document.getElementById('showProposedBuildings');
            if (proposed && !proposed.checked && view.proposed !== 'off') { proposed.checked = true; root.toggleLayer?.('proposedBuildings'); }
            const existing = document.getElementById('showBuildings');
            if (existing && !existing.checked) { existing.checked = true; root.toggleLayer?.('buildings'); }
            root.dispatchEvent(new CustomEvent('planningviewchange', { detail: { mode: state.mode, policy: view } }));
        }
        drawMap(); render();
        if (lastSelectedId !== state.selectedId) {
            lastSelectedId = state.selectedId;
            root.dispatchEvent(new CustomEvent('planningselectionchange', { detail: { id: state.selectedId } }));
        }
        if (modeChanged && view.permitted !== 'off') refresh();
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
        status = 'loading'; render();
        try {
            const url = new URL(`${root.getBackendBase()}/planning/representations`);
            url.searchParams.set('city', city); url.searchParams.set('bbox', bbox.join(','));
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            if (generation !== request) return;
            if (response.status === 400) {
                items = []; payload = null; status = 'zoom';
                store.select(null); drawMap(); render(); notifyGeometry(); return;
            }
            if (!response.ok) throw new Error(`Planning source HTTP ${response.status}`);
            const answer = await response.json();
            if (generation !== request) return;
            if (answer.schemaVersion !== 'planning-representations.v1' || answer.city !== city || !Array.isArray(answer.items)) {
                throw new Error('Invalid planning representation response');
            }
            payload = answer; items = answer.items; status = 'ready';
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
        } catch (error) {
            if (generation !== request || error.name === 'AbortError') return;
            console.error('[planning] Could not load source representations', error);
            loadedKey = ''; items = []; payload = null; status = 'error';
            store.select(null); drawMap(); render(); notifyGeometry();
        }
    }
    function init() {
        if (ready) return;
        const saved = root.PersistentStorage.getItem('cb_planning_view');
        store = core.createStore({ mode: new URLSearchParams(location.search).get('planning') || saved });
        panel = document.getElementById('planning-views');
        inspector = document.getElementById('planning-inspector');
        const controls = panel.querySelector('.cb-segmented');
        for (const mode of core.modes) {
            const button = element('button', 'cb-segmented__option');
            button.type = 'button'; button.dataset.planningMode = mode;
            const swatch = element('span', `planning-swatch planning-swatch--${mode}`); swatch.setAttribute('aria-hidden', 'true');
            button.append(swatch, element('span', '', t(mode)));
            button.addEventListener('click', () => store.setMode(mode)); controls.append(button);
        }
        panel.querySelector('.planning-source-picker').addEventListener('change', event => select(event.target.value || null));
        panel.querySelector('.planning-open-model').addEventListener('click', () => root.requestMapMode('model'));
        panel.querySelector('.planning-view-retry').addEventListener('click', () => refresh({ force: true }));
        root.map.createPane('planningSources');
        root.map.getPane('planningSources').classList.add('planning-sources-pane');
        layer = root.L.featureGroup().addTo(root.map);
        ready = true; panel.hidden = false;
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
    root.PlanningViews = { getState: () => store?.get(), getPolicy: policy, getItems: () => items,
        getSelected: selected, select, color, refresh, setMode: mode => store?.setMode(mode) };
    root.whenMapCoreReady().then(init);
})(window);
