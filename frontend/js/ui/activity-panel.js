// One persistent host for events, actors and watched areas. Data and state live in plain adapters.
(function (global) {
    'use strict';
    const model = global.ActivityPanelModel;
    const sheet = document.getElementById('activity-sheet');
    if (!sheet || !model) return;
    let state = model.createState();
    let events = [], failures = [], metadata = {}, simulationCount = 0;
    let requestToken = 0, loading = false, actors = null, ordinarySelection = null;
    const controls = document.getElementById('activity-panel-controls');
    const status = document.getElementById('activity-panel-status');
    const scope = document.getElementById('activity-panel-scope');
    const content = document.getElementById('game-log-content');
    const actorHost = document.getElementById('activity-actors-pane');
    const notices = document.createElement('div');
    notices.id = 'activity-panel-notices';
    scope.after(notices);
    const t = (key, fallback, params = {}) => {
        const translated = global.i18n?.t?.(key, params);
        return translated && translated !== key ? translated : fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => params[name] ?? '');
    };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const log = (key, fallback, params) => t(`gameDialogs.log.${key}`, fallback, params);
    const panel = (key, fallback, params) => t(`activityPanel.${key}`, fallback, params);
    const isOpen = () => !sheet.hidden;
    const currentCity = () => global.CityConfigManager?.getCurrentCityId?.();
    const normalizeCity = value => global.CityConfigManager?.resolveCityId?.(value) || value;
    const filterField = (name, label, options) => `<select data-activity-filter-field="${name}" aria-label="${escape(label)}">${options.map(([value, text]) => `<option value="${escape(value)}">${escape(text)}</option>`).join('')}</select>`;

    function buildControls() {
        const expanded = controls.querySelector('details')?.open;
        controls.innerHTML = `<div data-activity-primary-controls>
            <input type="search" data-activity-search data-activity-filter-field="query" aria-label="${escape(log('searchAria', 'Search activity'))}" placeholder="${escape(log('searchPlaceholder', 'Actor, agreement or transaction'))}">
            ${filterField('kind', log('kindAria', 'Actor type'), [['all', log('kindAll', 'Everyone')], ['human', log('kindHuman', 'People')], ['agent', log('kindAgent', 'Agents')], ['system', log('kindSystem', 'System')]])}
            <button type="button" class="btn btn-sm activity-refresh" data-activity-refresh>${escape(log('refresh', 'Refresh'))}</button>
            <details${expanded ? ' open' : ''}><summary>${escape(panel('filters', 'Filters'))} <span data-filter-count></span></summary><div data-activity-filter-grid>
            ${filterField('cityScope', panel('cityAria', 'Activity city'), [['all', panel('allCities', 'All cities')], ['current', panel('currentCity', 'Current city')]])}
            ${filterField('source', log('sourceAria', 'Activity source'), [['live', log('sourceLive', 'Live')], ['simulation', log('sourceSimulation', 'Simulation')], ['combined', log('sourceAll', 'All sources')]])}
            ${filterField('controller', log('controllerAria', 'Controller'), [['all', log('controllerAll', 'Any controller')], ['human', log('controllerHuman', 'Human')], ['algorithm', log('controllerAlgorithm', 'Algorithm')], ['llm', log('controllerLlm', 'LLM')]])}
            ${filterField('action', log('actionAria', 'Activity action'), [['all', log('actionAll', 'All actions')], ...global.ActorExplorer.actionOptions(t).map(option => [option.value, option.label])])}
            ${filterField('status', log('statusAria', 'Activity result'), [['all', log('statusAll', 'Any result')], ['success', log('statusSuccess', 'Succeeded')], ['failed', log('statusFailed', 'Failed')]])}
            </div></details><button type="button" class="btn btn-sm" data-activity-clear>${escape(log('clearFilters', 'Clear'))}</button></div>`;
        syncControls();
    }

    function capabilities() {
        const config = global.CityConfigManager?.getCurrentCityConfig?.();
        const hidden = config?.disabledSections?.includes('areaMonitor') === true;
        document.getElementById('activity-watched-tab').hidden = hidden;
        if (hidden && state.view === 'watched') state = model.setView(state, 'events');
        const cityOption = controls.querySelector('[data-activity-filter-field="cityScope"] option[value="current"]');
        if (cityOption) cityOption.disabled = !currentCity() || currentCity() === 'explore';
        if (cityOption?.disabled && state.filter.cityScope === 'current') state = model.setFilter(state, 'cityScope', 'all');
    }

    function syncControls() {
        controls.querySelectorAll('[data-activity-filter-field]').forEach(field => {
            const value = state.filter[field.dataset.activityFilterField] ?? '';
            if (field.value !== value) field.value = value;
        });
        const count = model.activeFilterCount(state.filter);
        const countNode = controls.querySelector('[data-filter-count]');
        if (countNode) countNode.textContent = count ? `(${count})` : '';
        controls.querySelector('[data-activity-clear]')?.toggleAttribute('hidden', count === 0);
        sheet.querySelectorAll('[data-activity-view]').forEach(button => {
            const active = button.dataset.activityView === state.view;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        });
        ['events', 'actors', 'watched'].forEach(view => { document.getElementById(`activity-${view}-pane`).hidden = state.view !== view; });
        controls.hidden = scope.hidden = notices.hidden = status.hidden = state.view === 'watched';
        const expand = document.getElementById('activity-panel-expand');
        const expanded = sheet.classList.contains('activity-panel--expanded');
        const label = panel(expanded ? 'collapse' : 'expand', expanded ? 'Reduce activity panel' : 'Expand activity panel');
        expand.setAttribute('aria-expanded', String(expanded));
        expand.setAttribute('aria-label', label);
        expand.title = label;
    }

    function mountActors() {
        if (actors) return actors;
        actors = global.ActorExplorer.mount(actorHost, {
            events: [], translate: t, showFilters: false,
            openEntity: entity => global.ActivityData.openEntity(entity),
            onSelectActor: actor => {
                if (actor) open({ filter: { actorId: actor.id || actor.wallet || actor.name }, actorSelection: true });
                else clearScope();
            },
            loadRun: async id => {
                const response = await fetch(`${global.ActivityData.apiBase()}/agent/runs/${encodeURIComponent(id)}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return (await response.json()).run;
            }
        });
        return actors;
    }

    function render() {
        syncControls();
        const visible = model.filter(events, state.filter, { matchesActivity: global.AgentActionEngine.matchesActivity, currentCity: currentCity(), normalizeCity });
        status.textContent = loading ? t('world.activity.loading', 'Loading activity…') : failures.length
            ? log('sourceFailed', 'Could not load: {{sources}}', { sources: failures.map(item => `${item.source || ''} (${item.error})`).join(', ') })
            : log('count', '{{count}} events', { count: visible.length });
        content.setAttribute('aria-busy', String(loading));
        content.setAttribute('data-rendered-count', String(visible.length));
        content.innerHTML = visible.length ? visible.map(event => global.ActorExplorer.activityRowHtml(event, { translate: t })).join('')
            : `<p class="no-logs">${escape(log('noMatch', 'No matching activity yet.'))}</p>`;
        global.ActivityData?.bindRowActions();
        if (state.view === 'actors' || actors) mountActors().setEvents(visible);
        scope.replaceChildren();
        const scopeField = ['actorId', 'agreementCid', 'runId'].find(field => state.filter[field]);
        if (scopeField) {
            const id = state.filter[scopeField];
            const key = { actorId: 'scopeActor', agreementCid: 'scopeAgreement', runId: 'scopeRun' }[scopeField];
            const label = scopeField === 'agreementCid' ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
            scope.innerHTML = `<div class="cb-badge cb-badge--primary activity-scope-chip" data-activity-scope-chip><span>${escape(log(key, '{{id}}', { id: label }))}</span><button type="button" class="btn btn-quiet btn-sm btn-icon" data-activity-clear-scope aria-label="${escape(log('clearScope', 'Clear scope'))}">×</button></div>`;
        }
        notices.replaceChildren();
        const notice = (text, action, label, caption = false) => {
            const row = document.createElement('p'); row.className = caption ? 'activity-panel-caption' : 'activity-panel-notice'; row.textContent = text;
            if (action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-quiet btn-sm'; button.textContent = label; button.addEventListener('click', action); row.append(' ', button); }
            notices.append(row);
        };
        if (state.filter.cityScope === 'current') notice(panel('unlocatedHint', 'Events without a location appear under All cities.'), () => changeFilter('cityScope', 'all'), panel('showAllCities', 'Show all cities'));
        if (simulationCount && state.filter.source === 'live') notice(panel('hiddenSimulation', '{{count}} simulated events hidden', { count: simulationCount }), () => changeFilter('source', 'combined'), panel('showSimulation', 'Show'));
        if (state.filter.source !== 'live') notice(panel('localSimulation', 'Simulation history is stored on this device for the current city.'), null, null, true);
        if (state.filter.source !== 'simulation' && metadata.scanWindow) notice(panel('scanWindow', 'Scoped results scan the most recent {{count}} records per source.', { count: metadata.scanWindow }), null, null, true);
        else if (state.filter.source !== 'simulation' && metadata.limit && metadata.loadedCount >= metadata.limit) notice(panel('recentLimit', 'Only the most recent {{count}} events are loaded.', { count: metadata.limit }), null, null, true);
    }

    async function load(refresh = false) {
        if (!isOpen() || state.view === 'watched') { render(); return; }
        const token = ++requestToken;
        loading = true; render();
        const filter = { ...state.filter, cityId: state.filter.cityScope === 'current' ? currentCity() : null };
        try {
            const result = await global.ActivityData.load({ filter, refresh });
            if (token !== requestToken) return;
            events = result.events || []; failures = result.failures || []; metadata = result.metadata || {}; simulationCount = result.simulationCount || 0;
        } catch (error) {
            if (token !== requestToken) return;
            failures = [{ source: log('sourceLive', 'Live'), error: error.message }];
        } finally { if (token === requestToken) { loading = false; render(); } }
    }

    // The Events and Actors rows are an object list (docs/design-language.md, "Object lists"): a row
    // about a design held on this device outlines the design (hover or focus), a click keeps the
    // outline (the row pressed) until it is clicked again, and only its Open design button opens it.
    // A row about anything else, or a design only on the server, has no shape to show.
    const rowDesign = row => {
        const link = row.querySelector('[data-entity-type="design"][data-entity-id]');
        return link ? global.DesignSync?.localCopyOf?.(link.dataset.entityId) || null : null;
    };
    const panes = sheet.querySelector('.activity-panel-panes');
    global.ParcelSetProposals.bindOutlines(panes, {
        item: '.activity-entry, .ae-event',
        keyOf: row => (rowDesign(row) ? row.querySelector('[data-entity-type="design"]').dataset.entityId : null),
        featuresOf: row => global.MapPick.outlineOf(rowDesign(row)),
        win: global
    });
    // Closing the panel lets go of a kept outline: a second click on its pressed row.
    const releaseOutline = () => panes.querySelector('[aria-pressed="true"]:is(.activity-entry, .ae-event)')?.click();

    function changeFilter(field, value) { state = model.setFilter(state, field, value); load(); }
    function clearScope() {
        state = model.clearScope(state);
        actors?.selectActor(ordinarySelection?.actorKey || null);
        if (ordinarySelection?.runId) actors?.openRun(ordinarySelection.runId);
        ordinarySelection = null;
        load();
    }
    function open(options = {}) {
        const hasScope = ['actorId', 'runId', 'agreementCid'].some(field => options.filter?.[field]);
        if (hasScope && !state.snapshot) ordinarySelection = options.actorSelection ? null : actors?.getSelection() || null;
        state = model.open(state, options);
        capabilities();
        if (state.view === 'actors') {
            const controller = mountActors();
            if (hasScope) controller.selectActor(state.filter.actorId || null);
            if (state.filter.runId) controller.openRun(state.filter.runId);
        }
        if (!isOpen()) global.MapShell.openSheet('activity-sheet');
        else load();
    }
    function close() { if (isOpen()) global.MapShell.closeSheet(); }
    controls.addEventListener('input', event => { if (event.target.dataset.activityFilterField === 'query') changeFilter('query', event.target.value); });
    controls.addEventListener('change', event => { const field = event.target.dataset.activityFilterField; if (field && field !== 'query') changeFilter(field, event.target.value); });
    sheet.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.activityView) { state = model.setView(state, button.dataset.activityView); load(); }
        else if (button.hasAttribute('data-activity-refresh')) load(true);
        else if (button.hasAttribute('data-activity-clear')) { state = model.clearFilters(state); load(); }
        else if (button.hasAttribute('data-activity-clear-scope')) clearScope();
        else if (button.id === 'activity-panel-expand') { sheet.classList.toggle('activity-panel--expanded'); syncControls(); global.MapShell.openSheet(sheet, { focus: false }); }
    });
    sheet.querySelector('[role="tablist"]').addEventListener('keydown', event => {
        const tabs = [...sheet.querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden);
        const index = tabs.indexOf(document.activeElement);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click(); tabs[next].focus();
    });
    document.addEventListener('mapshell:sheetopened', event => { if (event.detail?.id === 'activity-sheet') { capabilities(); load(); } });
    document.addEventListener('mapshell:sheetclosed', event => {
        if (event.detail?.id !== 'activity-sheet') return;
        releaseOutline();
        const url = new URL(global.location.href);
        if (url.searchParams.has('activity')) { url.searchParams.delete('activity'); global.history.replaceState(global.history.state, '', url); }
    });
    global.addEventListener('cityChanged', () => { capabilities(); load(); });
    global.addEventListener('activity:updated', () => load());
    const relabel = () => { global.i18n?.applyTranslations?.(sheet); buildControls(); actors?.relabel(); render(); };
    global.i18n?.onChange?.(relabel);
    global.addEventListener('i18n:translationsLoaded', relabel);
    global.ActivityPanel = { open, close, refresh: () => load(true), getState: () => state };
    global.openActivityPanel = open;
    global.closeActivityPanel = close;
    global.refreshActivityPanel = () => load(true);
    buildControls(); capabilities(); render();
})(window);
