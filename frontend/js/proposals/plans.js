// proposals/plans.js — named plans inside the app (plans.md): which plans a proposal is part of (the
// plan line on proposal rows), the plans touching a parcel or a city (the parcel panel's and the
// proposal list's Plans views), and their markup. A plan is a server record naming published
// proposal rows, so a proposal is matched to its plans by its published row id. Superseded versions
// are left out: a revision replaces its predecessor. The pure helpers are exported for headless
// tests; the fetches and the row decoration are the thin DOM layer. Opening a plan is PlanView's
// (proposals/plan-view.js).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalPlans = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    function plainT(key, fallback, params = {}) {
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function escapeText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ---- pure -------------------------------------------------------------------------------

    // The plans still current: a superseded version has a later one that replaces it.
    function current(plans) {
        return (Array.isArray(plans) ? plans : []).filter(plan => plan && plan.slug && plan.superseded !== true);
    }

    function planLabel(plan) {
        const title = plan && typeof plan.title === 'string' ? plan.title.trim() : '';
        return title || (plan && plan.slug) || '';
    }

    // Published proposal row id → the current plans naming it, in the order given.
    function plansByMember(plans) {
        const byMember = new Map();
        current(plans).forEach(plan => {
            (plan.proposalRowIds || []).forEach(raw => {
                const id = String(raw);
                const list = byMember.get(id) || [];
                if (!list.includes(plan)) list.push(plan);
                byMember.set(id, list);
            });
        });
        return byMember;
    }

    // The plan line under a proposal row: "Part of named plan <name>" when it is in one plan,
    // "In N named plans" when in several (the line then opens a list of them), nothing when in none.
    function planLineHtml(plans, { t = plainT } = {}) {
        const list = current(plans);
        if (!list.length) return '';
        const icon = '<i class="fas fa-diagram-project" aria-hidden="true"></i>';
        if (list.length === 1) {
            const label = t('plans.line.single', 'Part of named plan {{name}}', { name: planLabel(list[0]) });
            return `<div class="proposal-plan-line"><button type="button" class="cb-link proposal-plan-link" data-plan-slug="${escapeText(list[0].slug)}">${icon} ${escapeText(label)}</button></div>`;
        }
        const label = t('plans.line.many', 'In {{count}} named plans', { count: list.length });
        const options = list.map(plan => `<li><button type="button" class="cb-link proposal-plan-link" data-plan-slug="${escapeText(plan.slug)}">${escapeText(planLabel(plan))}</button></li>`).join('');
        return `<div class="proposal-plan-line"><button type="button" class="cb-link proposal-plan-toggle" aria-expanded="false">${icon} ${escapeText(label)}</button><ul class="proposal-plan-options" hidden>${options}</ul></div>`;
    }

    function formatDate(value) {
        if (!value) return '';
        const format = root && root.CbFormat && typeof root.CbFormat.formatDate === 'function' ? root.CbFormat.formatDate : null;
        if (format) return format(value) || '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
    }

    // Rows for a list of plans (the parcel panel's Plans tab, the proposal list's Plans source).
    function planRowsHtml(plans, { t = plainT, emptyText } = {}) {
        const list = current(plans);
        if (!list.length) {
            return `<p class="plan-list-empty">${escapeText(emptyText || t('plans.list.empty', 'No named plans here yet.'))}</p>`;
        }
        const rows = list.map(plan => {
            const count = Number.isFinite(plan.memberCount) ? plan.memberCount : (plan.proposalRowIds || []).length;
            const details = [plan.author, plan.place, formatDate(plan.createdAt)].filter(Boolean).map(escapeText).join(' · ');
            const pool = plan.proposalAccount
                ? `<span class="cb-badge cb-badge--minted">${escapeText(t('plans.list.pool', 'Betting pool'))}</span>`
                : '';
            return `
                <div class="proposal-item plan-item" data-plan-slug="${escapeText(plan.slug)}" role="button" tabindex="0">
                    <div class="proposal-item-body">
                        <div class="proposal-item-header">
                            <span class="proposal-item-title"><i class="fas fa-diagram-project" aria-hidden="true"></i> ${escapeText(planLabel(plan))}</span>
                            <div class="proposal-item-badges">
                                <span class="cb-badge cb-badge--neutral">${escapeText(t('agentDialog.proposalCount', '{{count}} proposals', { count }))}</span>
                                ${pool}
                            </div>
                        </div>
                        ${details ? `<div class="proposal-item-details">${details}</div>` : ''}
                        ${plan.description ? `<div class="proposal-item-details plan-item-description">${escapeText(plan.description)}</div>` : ''}
                    </div>
                </div>`;
        }).join('');
        return `<div class="parcel-proposals-list plan-list">${rows}</div>`;
    }

    // ---- DOM / fetch layer ------------------------------------------------------------------

    function t(key, fallback, params = {}) {
        const api = root && root.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t(key, params);
            if (value && value !== key) return value;
        }
        return plainT(key, fallback, params);
    }

    // GET /plans answers per query, kept for a minute so re-rendering a panel does not ask again;
    // a failure is kept as long so it is not retried in a loop.
    const TTL_MS = 60 * 1000;
    const cache = new Map();

    function cityCode() {
        try { return root.normalizeCityCodeForApi(root.resolveCurrentCityCode()) || null; } catch (_) { return null; }
    }

    function fetchPlans(query) {
        const params = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => { if (value) params.set(key, value); });
        const key = params.toString();
        const cached = cache.get(key);
        if (cached && (cached.promise || Date.now() - cached.at < TTL_MS)) return cached.promise || Promise.resolve(cached.result);
        const entry = { at: Date.now(), result: null, promise: null };
        entry.promise = fetch(`${root.resolveBackendBaseUrl()}/plans${key ? `?${key}` : ''}`)
            .then(response => (response.ok ? response.json() : response.text().then(text => { throw new Error(text || `HTTP ${response.status}`); })))
            .then(payload => ({ plans: Array.isArray(payload && payload.plans) ? payload.plans : [], error: null }))
            .catch(error => {
                console.warn(`[${new Date().toISOString()}] [ProposalPlans] plans unavailable (${key || 'all'})`, error);
                return { plans: [], error: error && error.message ? error.message : String(error) };
            })
            .then(result => { entry.result = result; entry.at = Date.now(); entry.promise = null; return result; });
        cache.set(key, entry);
        return entry.promise;
    }

    // Drops the cached answers, after this browser names a plan.
    function forget() {
        cache.clear();
    }

    function cityPlans(city = cityCode()) {
        return fetchPlans({ city });
    }

    function parcelPlans(cadastreIds, city = cityCode()) {
        const ids = Array.from(new Set((cadastreIds || []).map(String).filter(Boolean))).sort();
        if (!ids.length) return Promise.resolve({ plans: [], error: null });
        return fetchPlans({ city, parcel_ids: ids.join(',') });
    }

    function openPlan(slug) {
        if (!root.PlanView || typeof root.PlanView.open !== 'function') throw new Error('ProposalPlans: PlanView is not loaded');
        return root.PlanView.open(slug);
    }

    // The plan links in a container open their plan; "In N plans" unfolds its list. Bound once; the
    // clicks stop here so the proposal row under them does not open too.
    function bindPlanLinks(container) {
        if (!container || container.dataset.planLinksBound) return;
        container.dataset.planLinksBound = 'true';
        container.addEventListener('click', event => {
            const toggle = event.target.closest('.proposal-plan-toggle');
            const link = event.target.closest('.proposal-plan-link');
            if (!toggle && !link) return;
            event.stopPropagation();
            event.preventDefault();
            if (toggle) {
                const options = toggle.parentElement.querySelector('.proposal-plan-options');
                const open = toggle.getAttribute('aria-expanded') !== 'true';
                toggle.setAttribute('aria-expanded', String(open));
                if (options) options.hidden = !open;
                return;
            }
            openPlan(link.getAttribute('data-plan-slug'));
        }, true);
    }

    // Adds the plan line to proposal rows once the city's plans are known. serverIdOf(row) names the
    // row's published proposal id (null for a proposal held only here); place(row, html) puts the
    // line in the row. Rows already carrying a line are left alone.
    function decorateRows(container, { rowSelector, serverIdOf, place }) {
        if (!container) return Promise.resolve();
        bindPlanLinks(container);
        return cityPlans().then(({ plans }) => {
            if (!container.isConnected) return;
            const byMember = plansByMember(plans);
            if (!byMember.size) return;
            container.querySelectorAll(rowSelector).forEach(row => {
                if (row.querySelector('.proposal-plan-line')) return;
                const serverId = serverIdOf(row);
                const html = serverId ? planLineHtml(byMember.get(String(serverId)) || [], { t }) : '';
                if (html) place(row, html);
            });
        });
    }

    // A proposal record's published row id, or null for one held only in this browser.
    function serverIdOfRecord(record) {
        const rowIdOf = root?.getSerialProposalId || (typeof require === 'function' ? require('./sharing.js').getSerialProposalId : null);
        return rowIdOf ? rowIdOf(record) : null;
    }

    function appendToBody(row, html) {
        const body = row.querySelector('.proposal-item-body') || row;
        body.insertAdjacentHTML('beforeend', html);
    }

    // The parcel panel's proposal rows: its own (keyed by local id) and the published-only ones.
    function decorateParcelRows(container) {
        return decorateRows(container, {
            rowSelector: '.proposal-item[data-proposal-id], .parcel-set-proposal[data-parcel-set-proposal]',
            serverIdOf: row => {
                if (row.hasAttribute('data-server-id')) return row.getAttribute('data-server-id');
                const key = row.getAttribute('data-proposal-id') || row.getAttribute('data-parcel-set-proposal');
                return serverIdOfRecord(typeof root.getProposalByIdOrHash === 'function' ? root.getProposalByIdOrHash(key) : null);
            },
            place: appendToBody
        });
    }

    // Plan rows open their plan (click, Enter or Space). Bound once per container.
    function bindPlanRows(container) {
        if (!container || container.dataset.planRowsBound) return;
        container.dataset.planRowsBound = 'true';
        const openRow = row => openPlan(row.getAttribute('data-plan-slug'));
        container.addEventListener('click', event => {
            const row = event.target.closest('.plan-item[data-plan-slug]');
            if (row) openRow(row);
        });
        container.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const row = event.target.closest('.plan-item[data-plan-slug]');
            if (!row || row !== event.target) return;
            event.preventDefault();
            openRow(row);
        });
    }

    return {
        current, planLabel, plansByMember, planLineHtml, planRowsHtml,
        cityPlans, parcelPlans, forget, decorateRows, decorateParcelRows, serverIdOfRecord, bindPlanLinks, bindPlanRows, openPlan
    };
});
