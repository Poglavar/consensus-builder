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
            dismiss.addEventListener('click', () => { banner.remove(); positionEphemeralBelowBanner(); });

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
        positionEphemeralBelowBanner(); // banner gone: hand the toast back to its CSS position
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

    // The banner is fixed to the very top of the viewport and the ephemeral toast sits 20px down
    // inside #map-container, so the ribbon covers it. Push the toast clear of the banner's real
    // bottom edge (measured, because the banner wraps to two lines on narrow screens) for as long
    // as the banner is up; the CSS default applies again once it is gone.
    function positionEphemeralBelowBanner() {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('ephemeral-message-container');
        const banner = document.getElementById('cb-multitab-banner');
        if (!container) return;
        if (!banner) { container.style.removeProperty('top'); return; }
        const host = container.offsetParent || document.getElementById('map-container');
        const hostTop = host ? host.getBoundingClientRect().top : 0;
        const clearance = Math.round(banner.getBoundingClientRect().bottom - hostTop) + 12;
        container.style.top = Math.max(20, clearance) + 'px';
    }

    // A create or an edit in a read-only tab is silently thrown away, so say it where the user is
    // looking — one toast per burst, since a single user action triggers several saves.
    const WRITE_TOAST_THROTTLE_MS = 4000;
    // -Infinity, not 0: performance.now() starts near zero, so a 0 sentinel makes the very first
    // burst — the one right after load, which is exactly when this fires — skip the throttle.
    let lastWriteToastAt = -Infinity;

    function toastNotSaved() {
        if (typeof scope.showEphemeralMessage !== 'function') return;
        const now = (scope.performance && scope.performance.now) ? scope.performance.now() : 0;
        if ((now - lastWriteToastAt) < WRITE_TOAST_THROTTLE_MS) return;
        lastWriteToastAt = now;
        const KEY = 'multitab.notSaved';
        let text = 'Proposal was NOT saved and will be lost on browser reload.';
        try {
            if (scope.i18n && typeof scope.i18n.t === 'function') {
                // A missing key resolves to the key itself, which must never reach the user — the
                // translations load async, so an early toast legitimately has nothing to look up.
                const translated = scope.i18n.t(KEY, {});
                if (translated && translated !== KEY) text = translated;
            }
        } catch (_) { }
        // The container is created by the first call, so it can only be positioned after it exists.
        scope.showEphemeralMessage(text, 7000);
        positionEphemeralBelowBanner();
    }

    // Called by proposalStorage._persist when it drops a write because this tab is read-only. A
    // dropped write IS the harm the banner warns about, so it brings the banner back even if it was
    // dismissed — the warning cannot outlive its own dismissal while work is being lost.
    scope.__cbReportSecondaryWriteBlocked = function () {
        if (!secondary) return;
        attachBanner();
        toastNotSaved();
    };

    scope.__cbSecondaryTab = false;
    probe();
})();
