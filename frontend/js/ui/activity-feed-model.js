// Bounded model for the inline Activity sheet. The explorer remains the full-history surface.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ActivityFeedModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const LIMIT = 12;

    function filter(events, kind = 'all', limit = LIMIT) {
        const rows = Array.isArray(events) ? events : [];
        const selected = kind === 'people' ? rows.filter(event => event?.actor?.kind === 'human')
            : kind === 'agents' ? rows.filter(event => event?.actor?.kind === 'agent') : rows;
        return [...selected].sort((a, b) => (Date.parse(b?.recordedAt || b?.occurredAt || 0) || 0)
            - (Date.parse(a?.recordedAt || a?.occurredAt || 0) || 0))
            .slice(0, Math.max(0, Math.min(LIMIT, Number.isFinite(limit) ? limit : LIMIT)));
    }

    function status({ loading = false, events = [], visible = [], failures = [] } = {}) {
        if (loading) return 'loading';
        if (failures.length) return events.length ? 'partial' : 'error';
        if (!visible.length) return 'empty';
        return 'ready';
    }

    function relabelControls({ controls, buttons, refresh }, translate) {
        const t = typeof translate === 'function' ? translate : (_key, fallback) => fallback;
        controls?.setAttribute('aria-label', t('activityFeed.filters', 'Filter activity'));
        const labels = { all: 'All', people: 'People', agents: 'Agents' };
        buttons?.forEach((button, name) => {
            button.textContent = t(`activityFeed.${name}`, labels[name]);
        });
        if (refresh) refresh.textContent = t('activityFeed.refresh', 'Refresh');
    }

    return { LIMIT, filter, status, relabelControls };
});
