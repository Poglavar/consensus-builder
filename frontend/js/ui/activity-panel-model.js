// Pure, page-session state and filtering for the Activity panel.
(function attachActivityPanelModel(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ActivityPanelModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function activityPanelModelFactory() {
    'use strict';

    const DEFAULT_FILTER = Object.freeze({
        source: 'live', cityScope: 'all', kind: 'all', controller: 'all', action: 'all', status: 'all', actorId: '', agreementCid: '', runId: '', query: ''
    });
    const VIEWS = new Set(['events', 'actors', 'watched']);
    const SOURCES = new Set(['live', 'simulation', 'combined']);
    const KINDS = new Set(['all', 'human', 'agent', 'system']);

    const cloneFilter = filter => ({ ...DEFAULT_FILTER, ...(filter || {}) });
    const freezeFilter = filter => Object.freeze(cloneFilter(filter));
    const freezeSnapshot = snapshot => snapshot ? Object.freeze({
        view: snapshot.view,
        filter: freezeFilter(snapshot.filter)
    }) : null;
    const freezeState = (view, filter, snapshot) => Object.freeze({
        view: VIEWS.has(view) ? view : 'events',
        filter: freezeFilter(filter),
        snapshot: freezeSnapshot(snapshot)
    });

    function createState() {
        return freezeState('events', DEFAULT_FILTER, null);
    }

    function scopeOptions(options = {}) {
        return options.filter && typeof options.filter === 'object' ? options.filter : {};
    }

    function hasExplicitScope(options = {}) {
        const scope = scopeOptions(options);
        return ['actorId', 'agreementCid', 'runId'].some(key => scope[key] !== undefined && scope[key] !== null && String(scope[key]) !== '');
    }

    function open(state = createState(), options = {}) {
        const current = state && typeof state === 'object' ? state : createState();
        if (!hasExplicitScope(options)) {
            let next = freezeState(options.view || current.view, current.filter, current.snapshot);
            for (const [field, value] of Object.entries(scopeOptions(options))) next = setFilter(next, field, value);
            return next;
        }
        const scope = scopeOptions(options);

        const ordinary = current.snapshot || { view: current.view, filter: current.filter };
        const scopeField = ['runId', 'agreementCid', 'actorId'].find(field => scope[field]);
        const filter = {
            ...DEFAULT_FILTER,
            source: 'combined',
            cityScope: 'all',
            [scopeField]: String(scope[scopeField])
        };
        const view = filter.agreementCid ? 'events' : 'actors';
        return freezeState(view, filter, ordinary);
    }

    function setFilter(state, field, value) {
        const current = state || createState();
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_FILTER, field)) return freezeState(current.view, current.filter, current.snapshot);
        let nextValue = value;
        if (field === 'source' && !SOURCES.has(value)) nextValue = DEFAULT_FILTER.source;
        if (field === 'kind' && !KINDS.has(value)) nextValue = DEFAULT_FILTER.kind;
        if (field === 'controller' && !['all', 'human', 'algorithm', 'llm'].includes(value)) nextValue = DEFAULT_FILTER.controller;
        if (field === 'action' && value == null) nextValue = DEFAULT_FILTER.action;
        if (field === 'status' && !['all', 'success', 'failed'].includes(value)) nextValue = DEFAULT_FILTER.status;
        if (field === 'cityScope' && !['all', 'current'].includes(value)) nextValue = DEFAULT_FILTER.cityScope;
        if (field === 'query' || field === 'actorId' || field === 'agreementCid' || field === 'runId') nextValue = String(value ?? '');
        return freezeState(current.view, { ...current.filter, [field]: nextValue }, current.snapshot);
    }

    function setView(state, view) {
        const current = state || createState();
        return freezeState(VIEWS.has(view) ? view : current.view, current.filter, current.snapshot);
    }

    function clearScope(state) {
        const current = state || createState();
        if (!current.snapshot) return freezeState(current.view, current.filter, null);
        return freezeState(current.snapshot.view, current.snapshot.filter, null);
    }

    function clearFilters(state) {
        const current = state || createState();
        const next = { ...DEFAULT_FILTER };
        // A contextual scope owns source and scope ids; clearing user filters must preserve them.
        if (current.snapshot) {
            next.source = 'combined';
            next.cityScope = 'all';
            next.actorId = current.filter.actorId;
            next.agreementCid = current.filter.agreementCid;
            next.runId = current.filter.runId;
        }
        return freezeState(current.view, next, current.snapshot);
    }

    function eventCityId(event) {
        return event?.cityId ?? event?.location?.cityId ?? null;
    }

    function filter(events, selectedFilter = DEFAULT_FILTER, options = {}) {
        const selected = cloneFilter(selectedFilter);
        const rows = Array.isArray(events) ? events : [];
        const matchesActivity = typeof options.matchesActivity === 'function' ? options.matchesActivity : (() => true);
        const normalizeCity = typeof options.normalizeCity === 'function' ? options.normalizeCity : (value => String(value ?? '').trim().toLowerCase());
        const currentCity = options.currentCity ?? null;
        const query = String(selected.query || '').trim().toLowerCase();
        return rows.filter(event => {
            if (options.matchesActivity) {
                if (!matchesActivity(event, selected)) return false;
            } else {
                if (selected.source !== 'combined' && event?.source !== selected.source) return false;
                if (selected.kind !== 'all' && event?.actor?.kind !== selected.kind) return false;
                if (selected.controller !== 'all' && event?.actor?.controller !== selected.controller) return false;
                if (selected.action !== 'all' && event?.action?.type !== selected.action) return false;
                if (selected.status === 'success' && event?.ok === false) return false;
                if (selected.status === 'failed' && event?.ok !== false) return false;
                if (selected.actorId && ![event?.actor?.id, event?.actor?.wallet, event?.actor?.name].map(value => String(value ?? '')).includes(String(selected.actorId))) return false;
                if (selected.agreementCid && String(event?.action?.agreementCid ?? event?.entity?.id ?? '') !== String(selected.agreementCid)) return false;
                if (selected.runId && String(event?.runId ?? '') !== String(selected.runId)) return false;
            }
            if (selected.cityScope === 'current') {
                const cityId = eventCityId(event);
                if (cityId == null || currentCity == null || normalizeCity(cityId) !== normalizeCity(currentCity)) return false;
            }
            if (query && !options.matchesActivity) {
                const text = JSON.stringify(event ?? '').toLowerCase();
                if (!text.includes(query)) return false;
            }
            return true;
        }).sort((a, b) => (Date.parse(b?.recordedAt || b?.occurredAt || 0) || 0)
            - (Date.parse(a?.recordedAt || a?.occurredAt || 0) || 0));
    }

    function activeFilterCount(filterValue = DEFAULT_FILTER) {
        const value = cloneFilter(filterValue);
        return Number(value.source !== DEFAULT_FILTER.source)
            + Number(value.cityScope !== DEFAULT_FILTER.cityScope)
            + Number(value.kind !== DEFAULT_FILTER.kind)
            + Number(value.controller !== DEFAULT_FILTER.controller)
            + Number(value.action !== DEFAULT_FILTER.action)
            + Number(value.status !== DEFAULT_FILTER.status)
            + Number(Boolean(String(value.query || '').trim()));
    }

    return { createState, open, setFilter, setView, clearScope, clearFilters, filter, activeFilterCount };
});
