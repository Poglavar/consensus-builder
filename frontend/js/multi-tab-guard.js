// Multi-tab guard. All browser tabs share one IndexedDB store, but each tab loads its own in-memory
// copy once at startup with no cross-tab sync, and proposals persist as a single blob — so two tabs
// writing means last-writer-wins and can silently drop saved proposals. We take an exclusive Web Lock
// held for the tab's lifetime; if another tab already holds it, this tab becomes "secondary": it stops
// persisting (guarded in proposalStorage._persist via window.__cbSecondaryTab) and shows a warning
// banner. Web Locks unavailable → no-op (never block the app).
(function () {
    const scope = typeof window !== 'undefined' ? window : self;
    const locks = scope.navigator && scope.navigator.locks;
    if (!locks || typeof locks.request !== 'function') return;

    const LOCK_NAME = 'consensus-builder-single-tab';

    function bannerText() {
        try {
            if (scope.i18n && typeof scope.i18n.t === 'function') return scope.i18n.t('multitab.warning');
        } catch (_) { }
        return 'This app is already open in another tab. To avoid losing saved proposals, changes made here won’t be saved — close the other tabs and reload this one to edit.';
    }

    function showSecondaryTabBanner() {
        scope.__cbSecondaryTab = true;
        if (typeof document === 'undefined') return;

        const attach = () => {
            if (document.getElementById('cb-multitab-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'cb-multitab-banner';
            banner.className = 'cb-multitab-banner';
            banner.setAttribute('role', 'alert');

            const message = document.createElement('span');
            message.textContent = bannerText();

            const dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.className = 'cb-multitab-banner__close';
            dismiss.setAttribute('aria-label', 'Dismiss');
            dismiss.textContent = '×';
            dismiss.addEventListener('click', () => banner.remove());

            banner.appendChild(message);
            banner.appendChild(dismiss);
            (document.body || document.documentElement).appendChild(banner);
        };

        if (document.body) attach();
        else document.addEventListener('DOMContentLoaded', attach);
    }

    // ifAvailable → the callback runs immediately with null (instead of waiting) when another tab
    // already holds the lock; that null is our "a primary tab exists" signal.
    locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (lock === null) {
            showSecondaryTabBanner();
            return; // release the (non-)lock right away
        }
        // Primary tab: hold the lock for this tab's whole lifetime so later tabs see it as taken.
        scope.__cbSecondaryTab = false;
        return new Promise(() => { /* never resolves; lock auto-releases when the tab closes */ });
    }).catch(err => {
        console.warn('[multi-tab-guard] Web Lock request failed; multi-tab protection disabled', err);
    });
})();
