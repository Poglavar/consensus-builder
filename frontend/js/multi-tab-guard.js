// Multi-tab guard. All browser tabs share one IndexedDB store, but each tab loads its own in-memory
// copy once at startup with no cross-tab sync, and proposals persist as a single blob — so two tabs
// writing means last-writer-wins and can silently drop saved proposals. To warn about that, we detect
// OTHER ACTIVE tabs via a BroadcastChannel ping/pong: a fresh tab pings, and only established, active
// tabs answer. A truly-alone tab hears nothing, so it never warns. This deliberately avoids the Web
// Locks API — locks are still held by pages that are navigating away or frozen in the back/forward
// cache, which produced false "another tab is open" warnings on a single tab. Frozen/dead pages don't
// answer a ping, so this approach has no such false positive. Unsupported browsers → no-op.
(function () {
    const scope = typeof window !== 'undefined' ? window : self;
    if (typeof scope.BroadcastChannel !== 'function') return;

    const CHANNEL = 'consensus-builder-tabs';
    const DETECT_MS = 600; // probe window: how long to wait for another tab to answer our ping
    const channel = new scope.BroadcastChannel(CHANNEL);

    let established = false; // true once we've decided we're a live tab (and will answer others' pings)
    let secondary = false;

    // English fallback shown until the translation JSON finishes loading (it loads async, after this
    // guard runs). The data-i18n-key lets the app's applyTranslations swap in the localized string.
    const FALLBACK_TEXT = 'This app is already open in another tab. To avoid losing saved proposals, changes made here won’t be saved — close the other tabs and reload this one to edit.';

    function attachBanner() {
        if (typeof document === 'undefined') return;
        const attach = () => {
            if (document.getElementById('cb-multitab-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'cb-multitab-banner';
            banner.className = 'cb-multitab-banner';
            banner.setAttribute('role', 'alert');

            const message = document.createElement('span');
            message.setAttribute('data-i18n-key', 'multitab.warning');
            message.setAttribute('data-i18n-attr', 'text');
            message.textContent = FALLBACK_TEXT;

            const dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.className = 'cb-multitab-banner__close';
            dismiss.setAttribute('aria-label', 'Dismiss');
            dismiss.textContent = '×';
            // Dismissing hides the notice, not the read-only state — and the flag stays set, so the
            // banner used to be a one-time warning after which work silently stopped being saved.
            // Any later dropped write re-attaches it (see reportSecondaryWriteBlocked).
            dismiss.addEventListener('click', () => banner.remove());

            banner.appendChild(message);
            banner.appendChild(dismiss);
            (document.body || document.documentElement).appendChild(banner);

            try {
                if (scope.i18n && typeof scope.i18n.applyTranslations === 'function') {
                    scope.i18n.applyTranslations(banner);
                }
            } catch (_) { }
        };
        if (document.body) attach();
        else document.addEventListener('DOMContentLoaded', attach);
    }

    function removeBanner() {
        if (typeof document === 'undefined') return;
        const el = document.getElementById('cb-multitab-banner');
        if (el) el.remove();
    }

    function becomeSecondary() {
        if (secondary) return;
        secondary = true;
        scope.__cbSecondaryTab = true; // proposalStorage._persist checks this and skips writes
        attachBanner();
    }

    function clearSecondary() {
        secondary = false;
        scope.__cbSecondaryTab = false;
        removeBanner();
    }

    function probe() {
        try { channel.postMessage({ type: 'ping' }); } catch (_) { }
        // No completion signal exists for "nobody is out there", so absence must be inferred from a
        // short quiet window: if no active tab answered by now, we're alone and become primary.
        scope.setTimeout(() => {
            if (!secondary) established = true;
        }, DETECT_MS);
    }

    channel.onmessage = (event) => {
        const msg = event && event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') {
            // Only an established, active (primary) tab answers, so a departing/frozen page stays silent.
            if (established && !secondary) {
                try { channel.postMessage({ type: 'pong' }); } catch (_) { }
            }
        } else if (msg.type === 'pong') {
            becomeSecondary();
        } else if (msg.type === 'leaving') {
            // The primary is closing/navigating away — re-elect by probing again.
            if (secondary) { clearSecondary(); established = false; probe(); }
        }
    };

    // Announce departure so a secondary tab can promote itself instead of staying read-only forever,
    // and immediately stop answering pings — otherwise, during a same-tab navigation, this outgoing
    // page could still pong the incoming one and falsely mark it as a second tab.
    scope.addEventListener('pagehide', () => {
        if (established && !secondary) {
            try { channel.postMessage({ type: 'leaving' }); } catch (_) { }
        }
        established = false;
    });

    // Restored from the back/forward cache: another tab may now be active (or gone) — re-check.
    scope.addEventListener('pageshow', (event) => {
        if (event && event.persisted) {
            clearSecondary();
            established = false;
            probe();
        }
    });

    // Called by proposalStorage._persist when it drops a write because this tab is read-only. A
    // dropped write IS the harm the banner warns about, so it brings the banner back even if it was
    // dismissed — the warning cannot outlive its own dismissal while work is being lost.
    scope.__cbReportSecondaryWriteBlocked = function () {
        if (secondary) attachBanner();
    };

    scope.__cbSecondaryTab = false;
    probe();
})();
