// A small, dismissible arrival nudge — "N plans nearby, see the latest" — that opens the proposals
// list. Shows at most once per browser session, only when the server actually has plans, and never
// on a deep link (a shared proposal / ?latlng already has the user's attention). The show/skip
// decision is pure and unit-tested; the browser half does the fetch, banner and wiring.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.LatestPlansPrompt = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const SEEN_KEY = 'cb_latest_plans_seen';

    // Decide whether to show the prompt. Pure: total plans available, whether it was already seen
    // this session, and whether the current load is a deep link.
    function latestPlansPromptDecision({ total, seen, isDeepLink }) {
        const count = Number(total);
        if (seen || isDeepLink) return { show: false, count: 0 };
        if (!Number.isFinite(count) || count <= 0) return { show: false, count: 0 };
        return { show: true, count };
    }

    // ---- Browser wiring (inert under node) ----

    function isDeepLinkLoad() {
        if (typeof window === 'undefined' || !window.location) return false;
        try {
            const path = window.location.pathname || '';
            if (/^\/proposals\//i.test(path)) return true;
            const params = new URLSearchParams(window.location.search || '');
            return params.has('shared') || params.has('proposalShare') || params.has('latlng');
        } catch (_) {
            return false;
        }
    }

    function wasSeen() {
        try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch (_) { return false; }
    }
    function markSeen() {
        try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (_) { /* private mode */ }
    }

    function tr(key, fallback, params) {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const out = window.i18n.t(key, params || {});
            if (out && out !== key) return out;
        }
        return fallback;
    }

    async function fetchPlanTotal() {
        try {
            const base = (typeof window.resolveBackendBaseUrl === 'function') ? window.resolveBackendBaseUrl() : null;
            if (!base) return 0;
            const city = (typeof window.resolveCurrentCityCode === 'function') ? window.resolveCurrentCityCode() : '';
            const url = `${base}/proposals/summary?limit=1&offset=0&sort=created-desc`
                + (city ? `&city=${encodeURIComponent(city)}` : '');
            const res = await fetch(url);
            if (!res.ok) return 0;
            const payload = await res.json();
            // /proposals/summary reports the full total (COUNT(*) OVER()) as `count`, independent of limit.
            const total = Number(payload && (payload.count != null ? payload.count : payload.total));
            return Number.isFinite(total) ? total : (Array.isArray(payload && payload.proposals) ? payload.proposals.length : 0);
        } catch (_) {
            return 0;
        }
    }

    function openList() {
        markSeen();
        removeBanner();
        if (typeof window.showAllProposalsModal === 'function') window.showAllProposalsModal();
    }

    function removeBanner() {
        const el = document.getElementById('latest-plans-prompt');
        if (el) el.remove();
    }

    function showBanner(count) {
        if (document.getElementById('latest-plans-prompt')) return;
        const banner = document.createElement('div');
        banner.id = 'latest-plans-prompt';
        banner.className = 'latest-plans-prompt';
        banner.setAttribute('role', 'status');

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'latest-plans-prompt__cta';
        label.textContent = tr('latestPlans.cta', 'See the latest plans', { count });

        const countBadge = document.createElement('span');
        countBadge.className = 'latest-plans-prompt__count';
        countBadge.textContent = String(count);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'latest-plans-prompt__close';
        close.setAttribute('aria-label', tr('latestPlans.dismiss', 'Dismiss'));
        close.innerHTML = '&times;';

        label.prepend(countBadge);
        label.addEventListener('click', openList);
        close.addEventListener('click', () => { markSeen(); removeBanner(); });

        banner.appendChild(label);
        banner.appendChild(close);
        (document.getElementById('map-container') || document.body).appendChild(banner);
    }

    async function maybeShow() {
        if (typeof document === 'undefined') return;
        const decision = latestPlansPromptDecision({
            total: await fetchPlanTotal(),
            seen: wasSeen(),
            isDeepLink: isDeepLinkLoad()
        });
        if (decision.show) showBanner(decision.count);
    }

    function init() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        if (wasSeen() || isDeepLinkLoad()) return; // cheap early-out before any fetch
        // Wait for the welcome/guest bootstrap to settle so we don't stack over it.
        let started = false;
        const start = () => { if (started) return; started = true; maybeShow(); };
        window.addEventListener('welcomeModalComplete', start, { once: true });
        // Fallback if that event never fires (e.g. no welcome flow this load).
        setTimeout(start, 4000);
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return { latestPlansPromptDecision };
});
