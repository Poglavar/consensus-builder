// Recent activity for the Activity sheet; source loading and event rendering are shared with the explorer.
(function (global) {
    'use strict';
    const FILTERS = ['all', 'people', 'agents'];

    function mount(root) {
        const t = (key, fallback, params) => {
            const value = global.i18n?.t?.(key, params);
            return value && value !== key ? value : fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => params?.[name] ?? `{{${name}}}`);
        };
        let filter = 'all';
        let events = [];
        let failures = [];
        let loading = false;
        let requested = false;
        let mounted = true;

        const controls = document.createElement('div');
        controls.className = 'activity-feed__filters';
        controls.setAttribute('role', 'group');
        const status = document.createElement('p');
        status.className = 'activity-feed__status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const list = document.createElement('div');
        list.className = 'activity-feed__list';
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'activity-feed__refresh';
        refresh.addEventListener('click', () => load(true));

        const buttons = new Map();
        for (const name of FILTERS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(filter === name));
            button.addEventListener('click', () => {
                filter = name;
                buttons.forEach((item, key) => item.setAttribute('aria-pressed', String(key === filter)));
                render();
            });
            buttons.set(name, button);
            controls.append(button);
        }
        function relabel() {
            global.ActivityFeedModel.relabelControls({ controls, buttons, refresh }, t);
            render();
        }
        relabel();
        controls.append(refresh);
        root.replaceChildren(controls, status, list);

        function render() {
            if (!mounted) return;
            const visible = global.ActivityFeedModel.filter(events, filter);
            list.replaceChildren();
            const state = global.ActivityFeedModel.status({ loading, events, visible, failures });
            status.textContent = !requested ? t('activityFeed.prompt', 'Open Activity to load recent events.')
                : state === 'loading' ? t('activityFeed.loading', 'Loading recent activity…')
                : state === 'error' ? t('activityFeed.error', 'Activity could not load. Try again.')
                    : state === 'partial' ? t('activityFeed.partial', 'Some activity sources could not load.')
                        : state === 'empty' ? t('activityFeed.empty', 'No recent activity for this filter.') : '';

            for (const event of visible) {
                const wrapper = document.createElement('div');
                // ActorExplorer owns the shared row template and escapes all live fields.
                wrapper.innerHTML = global.ActorExplorer.activityRowHtml(event, {
                    translate: (key, fallback, params) => t(key, fallback, params)
                });
                const row = wrapper.firstElementChild;
                if (row) list.append(row);
            }
            global.CbActivityFeedAdapter?.bindRowActions?.();
        }

        async function load(force = false) {
            if (!mounted || loading || !isOpen()) return;
            requested = true;
            loading = true;
            failures = [];
            render();
            try {
                const result = await global.CbActivityFeedAdapter.load({ refresh: force });
                if (!mounted) return;
                events = result.events;
                failures = result.failures;
            } catch (error) {
                if (!mounted) return;
                failures = [{ error: error?.message || String(error) }];
            } finally {
                loading = false;
                render();
            }
        }
        function isOpen() {
            const sheet = document.getElementById('activity-sheet');
            return !!sheet && !sheet.hidden;
        }
        function onSheetOpened(event) { if (event.detail?.id === 'activity-sheet') load(); }
        function onCityChanged() { if (isOpen()) load(); }
        function onLocalActivity() { if (isOpen()) load(); }
        function onLanguageChanged() { relabel(); }
        document.addEventListener('mapshell:sheetopened', onSheetOpened);
        global.addEventListener('cityChanged', onCityChanged);
        global.addEventListener('activity:updated', onLocalActivity);
        const removeLanguageListener = global.i18n?.onChange?.(onLanguageChanged);
        if (isOpen()) load();

        return { refresh: () => load(true), relabel, destroy() {
            mounted = false;
            document.removeEventListener('mapshell:sheetopened', onSheetOpened);
            global.removeEventListener('cityChanged', onCityChanged);
            global.removeEventListener('activity:updated', onLocalActivity);
            if (typeof removeLanguageListener === 'function') removeLanguageListener();
            else global.i18n?.offChange?.(onLanguageChanged);
            root.replaceChildren();
        } };
    }

    function start() {
        const root = document.getElementById('activity-feed');
        if (root && !root.__activityFeed) root.__activityFeed = mount(root);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    global.ActivityFeed = { mount };
})(window);
